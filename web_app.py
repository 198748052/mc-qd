# -*- coding: utf-8 -*-
r"""
MonkeyCode 自动签到 —— 本地 Web 测试页面（Flask 后端）
=====================================================

这是一个仅用于本地调试的轻量 Web 服务，把 `monkeycode_checkin.py` 里的
签到逻辑包装成 HTTP 接口，并配一个前端页面，方便在浏览器里点一下就能测试签到。

启动：
    .venv\Scripts\python.exe web_app.py
然后浏览器打开 http://127.0.0.1:27183

接口一览：
    GET  /                    前端页面（需登录）
    GET  /login               登录页（用户名 + 密码）
    POST /api/login           校验用户名/密码并建立会话
    POST /api/logout          退出登录
    GET  /api/panel           读取当前面板用户名
    POST /api/panel/update    修改面板用户名 / 密码
    GET  /api/cookie          读取当前启用账号的 Cookie（打码显示）
    POST /api/save_cookie     更新当前启用账号的 Cookie
    GET  /api/accounts        列出已保存账号
    POST /api/accounts/add    新增账号
    POST /api/accounts/update 修改账号（重命名 / 更新 Cookie）
    POST /api/accounts/delete 删除账号
    POST /api/accounts/active 切换当前启用账号
    POST /api/qr_login/start  开启微信扫码登录，返回 sid 与二维码
    GET  /api/qr_login/poll   轮询扫码状态，成功后保存为新账号
    POST /api/status          检查指定账号登录态 + 今日签到状态（不签到）
    POST /api/checkin         对指定账号执行完整签到流程
    POST /api/checkin_all     对所有账号执行签到
    GET  /api/schedule        读取定时签到配置
    POST /api/schedule        设置定时签到（启用开关 + HH:MM）

访问账号来源（优先级从高到低）：
    1) 环境变量 PANEL_USERNAME / PANEL_PASSWORD
    2) 项目根目录 auth.json 的 username / password 字段
    3) 首次启动自动生成随机密码（用户名默认 admin）并写入 auth.json

注意：Cookie 是敏感凭证，本服务默认只监听 127.0.0.1，
      对外使用请配合 Nginx 反代与面板访问密码，勿裸奔到公网。
"""

import hmac
import json
import os
import secrets
import threading
import time
from datetime import datetime, timedelta

from flask import Flask, jsonify, redirect, render_template, request, session

# 复用已有的签到客户端与 PoW 求解算法
from monkeycode_checkin import MonkeyCodeClient, solve_challenges
# 多账号 + 定时签到配置的本地存储（与 node/src/store.js 对齐）
import monkeycode_store as store
# 微信扫码登录（服务端实现），用于自动获取 monkeycode_ai_session
import monkeycode_login

app = Flask(__name__)

# auth.json 与脚本同目录，用于持久化面板访问账号与会话签名密钥
AUTH_PATH = os.environ.get(
    "MONKEYCODE_AUTH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "auth.json"),
)

# 扫码登录会话表：sid -> QRLoginSession。
# 注意：状态存在进程内存里，因此本服务应以单进程方式部署
# （Flask 自带服务器即为单进程多线程，gunicorn 请使用 workers=1）。
LOGIN_SESSIONS = {}


# --------------------------------------------------------------------------- #
# 面板访问鉴权
# --------------------------------------------------------------------------- #
def _load_auth_store() -> dict:
    """读取 auth.json，损坏或不存在时返回空字典。"""
    try:
        with open(AUTH_PATH, "r", encoding="utf-8") as f:
            return json.load(f) or {}
    except (json.JSONDecodeError, OSError):
        return {}


def _save_auth_store(data: dict) -> None:
    """以 600 权限写入 auth.json。"""
    with open(AUTH_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.chmod(AUTH_PATH, 0o600)


_AUTH = _load_auth_store()
_ENV_USERNAME = (os.environ.get("PANEL_USERNAME") or "").strip()
_ENV_PASSWORD = (os.environ.get("PANEL_PASSWORD") or "").strip()
_DEFAULT_USERNAME = "admin"

_dirty = False
# 会话签名密钥必须稳定，否则重启后所有登录态失效
if not _AUTH.get("secret"):
    _AUTH["secret"] = secrets.token_hex(32)
    _dirty = True
if not _AUTH.get("username"):
    _AUTH["username"] = _ENV_USERNAME or _DEFAULT_USERNAME
    _dirty = True

GENERATED_PASSWORD = ""
# 未通过环境变量与 auth.json 提供密码时，自动生成一个便于首次登录
if not _ENV_PASSWORD and not _AUTH.get("password"):
    _AUTH["password"] = secrets.token_hex(4)  # 8 位十六进制
    GENERATED_PASSWORD = _AUTH["password"]
    _dirty = True
if _dirty:
    try:
        _save_auth_store(_AUTH)
    except OSError:
        # 无写权限时忽略：账号仍可在本次进程内使用
        pass

# 生效账号：环境变量优先（可在运行时被 update_credentials 覆盖）
PANEL_USERNAME = _ENV_USERNAME or _AUTH.get("username") or _DEFAULT_USERNAME
PANEL_PASSWORD = _ENV_PASSWORD or _AUTH.get("password") or ""
SECRET_KEY = _AUTH["secret"]

app.secret_key = SECRET_KEY
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(days=7),
)

# 无需登录即可访问的路径
_PUBLIC_PATHS = {"/login", "/api/login", "/api/logout"}

# 暴力破解限速：IP -> [失败次数, 首次失败时间]
_LOGIN_FAILS = {}
_LOGIN_MAX_FAILS = 8
_LOGIN_WINDOW = 300  # 秒


def _safe_equal(a, b) -> bool:
    """常量时间比较两个字符串，避免时序侧信道。"""
    ba = str("" if a is None else a).encode("utf-8")
    bb = str("" if b is None else b).encode("utf-8")
    if len(ba) != len(bb):
        return False
    return hmac.compare_digest(ba, bb)


def _check_credentials(username, password) -> bool:
    """校验用户名 + 密码。"""
    return _safe_equal(username, PANEL_USERNAME) and _safe_equal(password, PANEL_PASSWORD)


def update_credentials(current_password, username=None, new_password=None) -> dict:
    """
    修改面板用户名 / 密码。

    密码变更会轮换 Flask 会话签名密钥，使其它已登录会话立即失效；
    当前请求在返回前重新写入 session，因此当前用户不会被踢下线。
    """
    global PANEL_USERNAME, PANEL_PASSWORD, SECRET_KEY
    if not _safe_equal(current_password, PANEL_PASSWORD):
        return {"ok": False, "message": "当前密码错误"}

    next_username = (username or "").strip()
    next_password = new_password or ""

    if next_username and next_username != PANEL_USERNAME:
        PANEL_USERNAME = next_username
        _AUTH["username"] = next_username
    if next_password:
        if len(next_password) < 4:
            return {"ok": False, "message": "新密码至少 4 位"}
        PANEL_PASSWORD = next_password
        _AUTH["password"] = next_password
        SECRET_KEY = secrets.token_hex(32)
        _AUTH["secret"] = SECRET_KEY
        app.secret_key = SECRET_KEY

    try:
        _save_auth_store(_AUTH)
    except OSError:
        return {"ok": False, "message": "写入 auth.json 失败（检查目录权限）"}
    return {"ok": True, "rotated": bool(next_password), "username": PANEL_USERNAME}


def _login_rate_limited(ip: str) -> bool:
    """同一 IP 在窗口期内失败次数过多则短暂拒绝。"""
    rec = _LOGIN_FAILS.get(ip)
    if not rec:
        return False
    count, first = rec
    if time.time() - first > _LOGIN_WINDOW:
        _LOGIN_FAILS.pop(ip, None)
        return False
    return count >= _LOGIN_MAX_FAILS


def _record_login_fail(ip: str) -> None:
    now = time.time()
    rec = _LOGIN_FAILS.get(ip)
    if not rec or now - rec[1] > _LOGIN_WINDOW:
        _LOGIN_FAILS[ip] = [1, now]
    else:
        rec[0] += 1


@app.before_request
def _require_login():
    """统一鉴权：未登录时页面重定向到 /login，接口返回 401。"""
    path = request.path
    if path in _PUBLIC_PATHS or path.startswith("/static/"):
        return None
    if session.get("auth"):
        return None
    if path.startswith("/api/"):
        return jsonify({"ok": False, "message": "未登录或会话已过期",
                        "need_login": True}), 401
    return redirect("/login")


# --------------------------------------------------------------------------- #
# 工具函数
# --------------------------------------------------------------------------- #
def _now() -> str:
    """返回当前时间的 HH:MM:SS，用于日志时间戳。"""
    return datetime.now().strftime("%H:%M:%S")


def _log(logs: list, level: str, msg: str) -> None:
    """
    追加一条日志。

    :param logs: 日志列表（会被就地修改）
    :param level: 级别，取值 info / ok / warn / error，前端据此上色
    :param msg: 日志文本
    """
    logs.append({"t": _now(), "level": level, "msg": msg})


def _resolve_account_id(data) -> str:
    """解析目标账号 id：请求体指定 > 当前启用账号。"""
    aid = (data.get("account_id") or "").strip() if isinstance(data, dict) else ""
    if aid:
        return aid
    return store.read_state()["active_id"]


# --------------------------------------------------------------------------- #
# 接口：面板登录
# --------------------------------------------------------------------------- #
@app.get("/login")
def login_page():
    """登录页；已登录则直接回到首页。"""
    if session.get("auth"):
        return redirect("/")
    return render_template("login.html")


@app.post("/api/login")
def api_login():
    """校验用户名/密码，成功后写入签名会话。"""
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip() if isinstance(data, dict) else ""
    password = (data.get("password") or "").strip() if isinstance(data, dict) else ""

    ip = request.headers.get("X-Forwarded-For", request.remote_addr or "").split(",")[0].strip()
    if _login_rate_limited(ip):
        return jsonify({"ok": False, "message": "尝试过于频繁，请稍后再试"}), 429

    if not _check_credentials(username, password):
        _record_login_fail(ip)
        # 稍作延迟，抬高暴力破解成本
        time.sleep(0.4)
        return jsonify({"ok": False, "message": "用户名或密码错误"}), 401

    _LOGIN_FAILS.pop(ip, None)
    session.permanent = True
    session["auth"] = True
    return jsonify({"ok": True})


@app.post("/api/logout")
def api_logout():
    """退出登录，清除会话。"""
    session.clear()
    return jsonify({"ok": True})


@app.get("/api/panel")
def api_panel_info():
    """读取当前面板用户名。"""
    return jsonify({"ok": True, "username": PANEL_USERNAME})


@app.post("/api/panel/update")
def api_panel_update():
    """修改面板用户名 / 密码。"""
    data = request.get_json(silent=True) or {}
    result = update_credentials(
        current_password=data.get("current_password"),
        username=data.get("username"),
        new_password=data.get("new_password"),
    )
    if not result.get("ok"):
        return jsonify(result), 400
    # 密码变更后密钥已轮换，为当前用户重新写入会话，避免被自己踢下线
    session.permanent = True
    session["auth"] = True
    return jsonify(result)


# --------------------------------------------------------------------------- #
# 接口：账号管理
# --------------------------------------------------------------------------- #
@app.get("/api/cookie")
def api_get_cookie():
    """读取当前启用账号的 Cookie（打码返回，供前端展示）。"""
    acc = store.get_account()
    cookie = acc.get("cookie", "") if acc else ""
    return jsonify({"saved": bool(cookie), "masked": store.mask(cookie) if cookie else ""})


@app.post("/api/save_cookie")
def api_save_cookie():
    """把前端传来的 Cookie 保存到当前启用账号（无账号时新建）。"""
    cookie = (request.get_json(silent=True) or {}).get("cookie", "").strip()
    if not cookie:
        return jsonify({"ok": False, "message": "Cookie 不能为空"}), 400

    state = store.read_state()
    if state["active_id"]:
        store.update_account(state["active_id"], {"cookie": cookie})
        acc = store.get_account(state["active_id"])
    else:
        added = store.add_account("默认账号", cookie)
        store.set_active(added["id"])
        acc = store.get_account(added["id"])
    return jsonify({"ok": True, "message": "已保存", "masked": store.mask(acc.get("cookie", ""))})


@app.get("/api/accounts")
def api_accounts_list():
    """列出已保存账号。"""
    state = store.read_state()
    return jsonify({"ok": True, "accounts": store.list_accounts(), "active_id": state["active_id"]})


@app.post("/api/accounts/add")
def api_account_add():
    """新增账号。"""
    data = request.get_json(silent=True) or {}
    cookie = (data.get("cookie") or "").strip()
    if not cookie:
        return jsonify({"ok": False, "message": "Cookie 不能为空"}), 400
    added = store.add_account(data.get("name"), cookie)
    acc = store.get_account(added["id"])
    return jsonify(
        {"ok": True, "id": added["id"], "name": added["name"], "masked": store.mask(acc.get("cookie", ""))}
    )


@app.post("/api/accounts/update")
def api_account_update():
    """修改账号（重命名 / 更新 Cookie）。"""
    data = request.get_json(silent=True) or {}
    result = store.update_account((data.get("id") or "").strip(), {
        "name": data.get("name"),
        "cookie": data.get("cookie"),
    })
    return jsonify(result), (200 if result.get("ok") else 400)


@app.post("/api/accounts/delete")
def api_account_delete():
    """删除账号。"""
    data = request.get_json(silent=True) or {}
    result = store.delete_account((data.get("id") or "").strip())
    return jsonify(result), (200 if result.get("ok") else 400)


@app.post("/api/accounts/active")
def api_account_active():
    """切换当前启用账号。"""
    data = request.get_json(silent=True) or {}
    result = store.set_active((data.get("id") or "").strip())
    return jsonify(result), (200 if result.get("ok") else 400)


# --------------------------------------------------------------------------- #
# 接口：微信扫码登录（自动获取 monkeycode_ai_session）
# --------------------------------------------------------------------------- #
@app.post("/api/qr_login/start")
def api_qr_login_start():
    """
    开启一次扫码登录，返回会话 id 与二维码图片（base64 data URL）。
    真正的扫码等待在后台线程中进行，前端拿到 sid 后轮询 /api/qr_login/poll。
    """
    sess = monkeycode_login.start_login()
    LOGIN_SESSIONS[sess.sid] = sess

    # 顺手清理过期的登录会话，避免内存无限增长
    now = time.time()
    for sid in [k for k, v in LOGIN_SESSIONS.items() if now - v.created > 1800]:
        LOGIN_SESSIONS.pop(sid, None)

    return jsonify(sess.snapshot())


@app.get("/api/qr_login/poll")
def api_qr_login_poll():
    """
    轮询扫码登录状态。
    一旦状态变为 confirmed，就把拿到的 Cookie 落到 config.json 并返回打码值。
    """
    sid = request.args.get("sid", "")
    sess = LOGIN_SESSIONS.get(sid)
    if sess is None:
        return jsonify({"status": "error", "message": "登录会话不存在或已过期"}), 404

    data = sess.snapshot()

    # 登录成功：保存为新账号并设为启用（只处理一次）
    if sess.status == "confirmed" and sess.cookie:
        name = (sess.user or {}).get("name") or (sess.user or {}).get("email") or "微信登录账号"
        added = store.add_account(name, sess.cookie)
        store.set_active(added["id"])
        acc = store.get_account(added["id"])
        sess.cookie = ""  # 防止重复写盘
        data["masked"] = store.mask(acc.get("cookie", ""))
        data["user"] = sess.user
        data["account_id"] = added["id"]
        data["saved"] = True
        LOGIN_SESSIONS.pop(sid, None)

    return jsonify(data)


# --------------------------------------------------------------------------- #
# 接口：状态查询
# --------------------------------------------------------------------------- #
@app.post("/api/status")
def api_status():
    """只检查指定账号的登录态与今日签到状态，不执行签到。"""
    data = request.get_json(silent=True) or {}
    account_id = _resolve_account_id(data)
    cookie = store.get_cookie(account_id)
    if not cookie:
        return jsonify({"ok": False, "logs": [
            {"t": _now(), "level": "error", "msg": "该账号尚未配置 Cookie，请先扫码登录或手动填写"}
        ]})

    logs = []
    client = MonkeyCodeClient(cookie)
    result = {"ok": False, "user": None, "checked_in": None, "balance": None,
              "account_id": account_id}

    # 1) 校验登录态
    _log(logs, "info", "GET /api/v1/users/status  校验登录态 ...")
    try:
        status = client.get_user_status()
    except Exception as e:  # noqa: BLE001 —— 网络/HTTP 异常统一提示
        _log(logs, "error", f"登录态校验失败：{e}")
        return jsonify({"ok": False, "logs": logs, **result})

    user = status.get("data", {}).get("user", {})
    result["user"] = user
    store.set_user(account_id, user)
    _log(logs, "ok", f"登录成功：{user.get('name', '(未知)')}  (id={user.get('id', '')})")

    # 2) 今日签到状态
    _log(logs, "info", "GET /api/v1/users/wallet/checkin  查询今日签到状态 ...")
    try:
        checked = client.get_checkin_status()
        result["checked_in"] = checked
        _log(logs, "ok" if checked else "warn",
             "今天已签到" if checked else "今天尚未签到")
    except Exception as e:  # noqa: BLE001
        _log(logs, "error", f"查询签到状态失败：{e}")
        return jsonify({"ok": False, "logs": logs, **result})

    # 3) 余额
    try:
        wallet = client.get_wallet()
        result["balance"] = wallet.get("balance")
        _log(logs, "info", f"当前余额：{wallet.get('balance', '?')}")
    except Exception as e:  # noqa: BLE001
        _log(logs, "warn", f"查询余额失败：{e}")

    result["ok"] = True
    return jsonify({"ok": True, "logs": logs, **result})


# --------------------------------------------------------------------------- #
# 接口：执行签到
# --------------------------------------------------------------------------- #
def _do_checkin(cookie: str, logs: list, account_id: str = "") -> dict:
    """
    对单个 Cookie 执行完整签到流程，返回结果字典（不含 logs）。

    抽成独立函数，供 /api/checkin 与定时任务 /api/checkin_all 复用。
    """
    result = {"ok": False, "checked_in": None, "balance": None, "user": None}
    if account_id:
        result["account_id"] = account_id
    client = MonkeyCodeClient(cookie)

    # 1) 校验登录态
    _log(logs, "info", "GET /api/v1/users/status  校验登录态 ...")
    try:
        status = client.get_user_status()
    except Exception as e:  # noqa: BLE001
        _log(logs, "error", f"登录态校验失败（Cookie 可能已失效）：{e}")
        return result

    user = status.get("data", {}).get("user", {})
    result["user"] = user
    if account_id:
        store.set_user(account_id, user)
    _log(logs, "ok", f"登录成功：{user.get('name', '(未知)')}  (id={user.get('id', '')})")

    # 2) 是否已签到
    try:
        if client.get_checkin_status():
            result["checked_in"] = True
            result["ok"] = True
            if account_id:
                store.mark_checked_in(account_id, user=user, checked_in=True)
            _log(logs, "warn", "今天已经签到过了，无需重复签到")
            try:
                result["balance"] = client.get_wallet().get("balance")
            except Exception:  # noqa: BLE001
                pass
            return result
        _log(logs, "info", "今天尚未签到，开始签到流程 ...")
    except Exception as e:  # noqa: BLE001
        _log(logs, "error", f"查询签到状态失败：{e}")
        return result

    # 3) 获取人机验证挑战
    _log(logs, "info", "POST /api/v1/public/captcha/challenge  获取挑战 ...")
    try:
        challenge_data = client.create_captcha_challenge()
    except Exception as e:  # noqa: BLE001
        _log(logs, "error", f"获取挑战失败：{e}")
        return result

    challenge = challenge_data["challenge"]
    token = challenge_data["token"]
    c, s, d = challenge["c"], challenge["s"], challenge["d"]
    _log(logs, "ok", f"挑战配置：数量 c={c}, salt 长度 s={s}, 难度 d={d}")

    # 4) 本地求解 PoW（纯 CPU 计算，通常 < 1 秒）
    _log(logs, "info", f"本地求解 {c} 个 SHA-256 工作量证明 ...")
    start = time.time()
    solutions = solve_challenges(token, c, s, d)
    cost = time.time() - start
    _log(logs, "ok", f"求解完成，共 {len(solutions)} 个解，耗时 {cost:.2f}s")

    # 5) 兑换 captcha_token
    _log(logs, "info", "POST /api/v1/public/captcha/redeem  提交解答 ...")
    try:
        captcha_token = client.redeem_captcha(token, solutions)
        _log(logs, "ok", f"验证通过，captcha_token={captcha_token}")
    except Exception as e:  # noqa: BLE001
        _log(logs, "error", f"人机验证失败：{e}")
        return result

    # 6) 提交签到
    _log(logs, "info", "POST /api/v1/users/wallet/checkin  提交签到 ...")
    try:
        ok = client.do_checkin(captcha_token)
    except Exception as e:  # noqa: BLE001
        _log(logs, "error", f"签到请求失败：{e}")
        return result

    result["checked_in"] = ok
    if account_id:
        store.mark_checked_in(account_id, user=user, checked_in=ok)
    if ok:
        result["ok"] = True
        try:
            result["balance"] = client.get_wallet().get("balance")
        except Exception:  # noqa: BLE001
            pass
        _log(logs, "ok", f"签到成功！当前余额：{result['balance']}")
    else:
        _log(logs, "error", "签到未成功（服务端返回 checked_in=false）")

    return result


@app.post("/api/checkin")
def api_checkin():
    """对指定账号执行完整签到流程。"""
    data = request.get_json(silent=True) or {}
    account_id = _resolve_account_id(data)
    cookie = store.get_cookie(account_id)
    if not cookie:
        return jsonify({"ok": False, "logs": [
            {"t": _now(), "level": "error", "msg": "该账号尚未配置 Cookie，请先扫码登录或手动填写"}
        ]})

    logs = []
    result = _do_checkin(cookie, logs, account_id)
    return jsonify({"ok": result["ok"], "logs": logs, **result})


def _run_all_checkins(logger=None) -> list:
    """对所有已保存账号执行签到，返回每个账号的结果。"""
    results = []
    for acc in store.list_accounts():
        logs = []
        cookie = store.get_cookie(acc["id"])
        if not cookie:
            results.append({"id": acc["id"], "name": acc["name"], "ok": False,
                            "message": "未配置 Cookie"})
            continue
        result = _do_checkin(cookie, logs, acc["id"])
        if logger:
            for entry in logs:
                logger(f"[{acc['name']}] {entry['msg']}", entry["level"])
        results.append({
            "id": acc["id"], "name": acc["name"], "ok": result["ok"],
            "checked_in": result.get("checked_in"), "balance": result.get("balance"),
        })
    return results


@app.post("/api/checkin_all")
def api_checkin_all():
    """对所有账号执行签到。"""
    logs = []
    try:
        results = _run_all_checkins(
            lambda msg, level: logs.append({"t": _now(), "level": level, "msg": msg})
        )
        return jsonify({"ok": True, "results": results, "logs": logs})
    except Exception as e:  # noqa: BLE001
        _log(logs, "error", str(e))
        return jsonify({"ok": False, "results": [], "logs": logs})


# --------------------------------------------------------------------------- #
# 接口：定时签到配置
# --------------------------------------------------------------------------- #
@app.get("/api/schedule")
def api_schedule_get():
    """读取定时签到配置。"""
    s = store.get_schedule()
    return jsonify({"ok": True, "enabled": s["enabled"], "time": s["time"],
                    "next_run": _scheduler_next_run()})


@app.post("/api/schedule")
def api_schedule_set():
    """设置定时签到（启用开关 + HH:MM）。"""
    data = request.get_json(silent=True) or {}
    s = store.set_schedule(bool(data.get("enabled")), data.get("time"))
    _scheduler_reload()
    return jsonify({"ok": True, "enabled": s["enabled"], "time": s["time"],
                    "next_run": _scheduler_next_run()})


# --------------------------------------------------------------------------- #
# 进程内定时签到调度器
# --------------------------------------------------------------------------- #
# 读取 store 中的 schedule（{enabled, time: "HH:MM"}），到点后对所有账号执行签到。
# 与 Node 版保持一致：服务在跑定时就生效；cron 作为兜底。
_SCHED_LOCK = threading.Lock()
_SCHED_STATE = {"last_date": None, "next_run": None}


def _scheduler_compute_next(time_str: str):
    """计算下一次 HH:MM 触发时间（今天或明天）。"""
    try:
        hh, mm = (int(x) for x in str(time_str).split(":"))
    except (ValueError, TypeError):
        return None
    now = datetime.now()
    nxt = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if nxt <= now:
        nxt += timedelta(days=1)
    return nxt


def _scheduler_refresh():
    """依据当前配置刷新 next_run 记录。"""
    s = store.get_schedule()
    with _SCHED_LOCK:
        _SCHED_STATE["next_run"] = _scheduler_compute_next(s["time"]) if s["enabled"] else None


def _scheduler_reload():
    """配置变更后调用，立即刷新下次触发时间。"""
    _scheduler_refresh()


def _scheduler_next_run():
    """下一次触发时间（ISO 字符串），未启用时为 None。"""
    with _SCHED_LOCK:
        nxt = _SCHED_STATE["next_run"]
    return nxt.isoformat() if nxt else None


def _scheduler_loop():
    """后台线程：每 30 秒检查一次是否到达签到时间。"""
    _scheduler_refresh()
    while True:
        try:
            s = store.get_schedule()
            if s["enabled"]:
                target = _scheduler_compute_next(s["time"])
                today = datetime.now().strftime("%Y-%m-%d")
                with _SCHED_LOCK:
                    due = _SCHED_STATE["next_run"]
                    # 到点且今天未执行过
                    if due and datetime.now() >= due and _SCHED_STATE["last_date"] != today:
                        _SCHED_STATE["last_date"] = today
                        run = True
                    else:
                        run = False
                if run:
                    print(f"[scheduler] {_now()} 触发定时签到")
                    _run_all_checkins(
                        lambda msg, level: print(f"[scheduler] [{level}] {msg}")
                    )
                _scheduler_refresh()
        except Exception as e:  # noqa: BLE001
            print(f"[scheduler] 执行异常：{e}")
        time.sleep(30)


def _start_scheduler():
    """启动后台调度线程（守护线程，随主进程退出）。"""
    t = threading.Thread(target=_scheduler_loop, name="scheduler", daemon=True)
    t.start()


# --------------------------------------------------------------------------- #
# 前端页面
# --------------------------------------------------------------------------- #
@app.get("/")
def index():
    """渲染测试页面。"""
    return render_template("index.html")


# 服务以单进程运行时启动调度器（多进程部署请改用 cron 兜底，避免重复签到）
_start_scheduler()


if __name__ == "__main__":
    # 监听地址与端口可通过环境变量覆盖。
    # 默认只监听回环地址，部署时由 Nginx 反向代理对外提供访问，
    # 避免暴露到公网（本服务持有登录凭证）。
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "27183"))
    if GENERATED_PASSWORD:
        print("────────────────────────────────────────────")
        print(f"已生成面板登录账号：{PANEL_USERNAME} / {GENERATED_PASSWORD}")
        print(f"（已保存到 {AUTH_PATH}，可用 PANEL_USERNAME / PANEL_PASSWORD 环境变量覆盖）")
        print("────────────────────────────────────────────")
    app.run(host=host, port=port, debug=False, threaded=True)
