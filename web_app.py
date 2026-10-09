# -*- coding: utf-8 -*-
r"""
MonkeyCode 自动签到 —— 本地 Web 测试页面（Flask 后端）
=====================================================

这是一个仅用于本地调试的轻量 Web 服务，把 `monkeycode_checkin.py` 里的
签到逻辑包装成 HTTP 接口，并配一个前端页面，方便在浏览器里点一下就能测试签到。

启动：
    .venv\Scripts\python.exe web_app.py
然后浏览器打开 http://127.0.0.1:5000

接口一览：
    GET  /                  前端页面
    GET  /api/cookie        读取已保存的 Cookie（打码显示）
    POST /api/save_cookie   保存 Cookie 到 config.json
    POST /api/qr_login/start 开启微信扫码登录，返回 sid 与二维码
    GET  /api/qr_login/poll  轮询扫码状态，成功后自动保存 Cookie
    POST /api/status        只做登录态 + 今日签到状态检查（不签到）
    POST /api/checkin       执行完整签到流程，返回逐步日志

注意：Cookie 是敏感凭证，本服务只监听 127.0.0.1，请勿暴露到公网。
"""

import json
import os
import time
from datetime import datetime

from flask import Flask, jsonify, render_template, request

# 复用已有的签到客户端与 PoW 求解算法
from monkeycode_checkin import MonkeyCodeClient, SESSION_COOKIE_NAME, solve_challenges
# 微信扫码登录（服务端实现），用于自动获取 monkeycode_ai_session
import monkeycode_login

app = Flask(__name__)

# config.json 与脚本同目录，用于持久化 Cookie
CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")

# 扫码登录会话表：sid -> QRLoginSession。
# 注意：状态存在进程内存里，因此本服务应以单进程方式部署
# （Flask 自带服务器即为单进程多线程，gunicorn 请使用 workers=1）。
LOGIN_SESSIONS = {}


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


def _mask_cookie(cookie: str) -> str:
    """把 Cookie 中间部分打码，避免完整凭证出现在页面上。"""
    if not cookie:
        return ""
    # 取出 session 值（去掉 "name=" 前缀）后只保留首尾
    value = cookie.split("=", 1)[1] if "=" in cookie else cookie
    if len(value) <= 12:
        return cookie
    masked = f"{value[:6]}...{value[-4:]}"
    return f"{SESSION_COOKIE_NAME}={masked}"


def _read_config_cookie() -> str:
    """从 config.json 读取已保存的 Cookie，没有则返回空串。"""
    if not os.path.exists(CONFIG_PATH):
        return ""
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return (json.load(f) or {}).get("cookie", "") or ""
    except (json.JSONDecodeError, OSError):
        return ""


def _write_config_cookie(cookie: str) -> str:
    """
    把 Cookie 写入 config.json，返回规范化后的 Cookie 字符串。
    若传入的是裸 session 值（不含 "="），自动补上 Cookie 名。
    """
    if "=" not in cookie:
        cookie = f"{SESSION_COOKIE_NAME}={cookie}"
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump({"cookie": cookie}, f, ensure_ascii=False, indent=2)
    return cookie


def _resolve_cookie(req) -> str:
    """
    确定本次请求使用的 Cookie，优先级：
        1) 请求体/表单里的 cookie 字段
        2) config.json 中保存的 Cookie
    """
    cookie = ""
    if req.is_json:
        cookie = (req.get_json(silent=True) or {}).get("cookie", "") or ""
    else:
        cookie = req.form.get("cookie", "") or ""
    cookie = cookie.strip()
    return cookie or _read_config_cookie()


# --------------------------------------------------------------------------- #
# 接口：Cookie 管理
# --------------------------------------------------------------------------- #
@app.get("/api/cookie")
def api_get_cookie():
    """读取已保存的 Cookie（打码返回，供前端展示）。"""
    cookie = _read_config_cookie()
    return jsonify({"saved": bool(cookie), "masked": _mask_cookie(cookie)})


@app.post("/api/save_cookie")
def api_save_cookie():
    """把前端传来的 Cookie 保存到 config.json。"""
    cookie = (request.get_json(silent=True) or {}).get("cookie", "").strip()
    if not cookie:
        return jsonify({"ok": False, "message": "Cookie 不能为空"}), 400
    cookie = _write_config_cookie(cookie)
    return jsonify({"ok": True, "message": "已保存", "masked": _mask_cookie(cookie)})


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

    # 登录成功：持久化 Cookie（只需处理一次）
    if sess.status == "confirmed" and sess.cookie:
        cookie = _write_config_cookie(sess.cookie)
        sess.cookie = ""  # 防止重复写盘
        data["masked"] = _mask_cookie(cookie)
        data["user"] = sess.user
        data["saved"] = True
        LOGIN_SESSIONS.pop(sid, None)

    return jsonify(data)


# --------------------------------------------------------------------------- #
# 接口：状态查询
# --------------------------------------------------------------------------- #
@app.post("/api/status")
def api_status():
    """只检查登录态与今日签到状态，不执行签到。"""
    cookie = _resolve_cookie(request)
    if not cookie:
        return jsonify({"ok": False, "logs": [
            {"t": _now(), "level": "error", "msg": "未提供 Cookie，请先填写并保存"}
        ]})

    logs = []
    client = MonkeyCodeClient(cookie)
    result = {"ok": False, "user": None, "checked_in": None, "balance": None}

    # 1) 校验登录态
    _log(logs, "info", "GET /api/v1/users/status  校验登录态 ...")
    try:
        status = client.get_user_status()
    except Exception as e:  # noqa: BLE001 —— 网络/HTTP 异常统一提示
        _log(logs, "error", f"登录态校验失败：{e}")
        return jsonify({"ok": False, "logs": logs, **result})

    user = status.get("data", {}).get("user", {})
    result["user"] = user
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
@app.post("/api/checkin")
def api_checkin():
    """执行完整签到流程：查询状态 -> 取挑战 -> 本地求解 -> redeem -> 签到。"""
    cookie = _resolve_cookie(request)
    if not cookie:
        return jsonify({"ok": False, "logs": [
            {"t": _now(), "level": "error", "msg": "未提供 Cookie，请先填写并保存"}
        ]})

    logs = []
    result = {"ok": False, "checked_in": None, "balance": None, "user": None}
    client = MonkeyCodeClient(cookie)

    # 1) 校验登录态
    _log(logs, "info", "GET /api/v1/users/status  校验登录态 ...")
    try:
        status = client.get_user_status()
    except Exception as e:  # noqa: BLE001
        _log(logs, "error", f"登录态校验失败（Cookie 可能已失效）：{e}")
        return jsonify({"ok": False, "logs": logs, **result})

    user = status.get("data", {}).get("user", {})
    result["user"] = user
    _log(logs, "ok", f"登录成功：{user.get('name', '(未知)')}  (id={user.get('id', '')})")

    # 2) 是否已签到
    try:
        if client.get_checkin_status():
            result["checked_in"] = True
            result["ok"] = True
            _log(logs, "warn", "今天已经签到过了，无需重复签到")
            try:
                result["balance"] = client.get_wallet().get("balance")
            except Exception:  # noqa: BLE001
                pass
            return jsonify({"ok": True, "logs": logs, **result})
        _log(logs, "info", "今天尚未签到，开始签到流程 ...")
    except Exception as e:  # noqa: BLE001
        _log(logs, "error", f"查询签到状态失败：{e}")
        return jsonify({"ok": False, "logs": logs, **result})

    # 3) 获取人机验证挑战
    _log(logs, "info", "POST /api/v1/public/captcha/challenge  获取挑战 ...")
    try:
        challenge_data = client.create_captcha_challenge()
    except Exception as e:  # noqa: BLE001
        _log(logs, "error", f"获取挑战失败：{e}")
        return jsonify({"ok": False, "logs": logs, **result})

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
        return jsonify({"ok": False, "logs": logs, **result})

    # 6) 提交签到
    _log(logs, "info", "POST /api/v1/users/wallet/checkin  提交签到 ...")
    try:
        ok = client.do_checkin(captcha_token)
    except Exception as e:  # noqa: BLE001
        _log(logs, "error", f"签到请求失败：{e}")
        return jsonify({"ok": False, "logs": logs, **result})

    result["checked_in"] = ok
    if ok:
        result["ok"] = True
        try:
            result["balance"] = client.get_wallet().get("balance")
        except Exception:  # noqa: BLE001
            pass
        _log(logs, "ok", f"签到成功！当前余额：{result['balance']}")
    else:
        _log(logs, "error", "签到未成功（服务端返回 checked_in=false）")

    return jsonify({"ok": ok, "logs": logs, **result})


# --------------------------------------------------------------------------- #
# 前端页面
# --------------------------------------------------------------------------- #
@app.get("/")
def index():
    """渲染测试页面。"""
    return render_template("index.html")


if __name__ == "__main__":
    # 监听地址与端口可通过环境变量覆盖。
    # 默认只监听回环地址，部署时由 Nginx 反向代理对外提供访问，
    # 避免暴露到公网（本服务持有登录凭证）。
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "5000"))
    app.run(host=host, port=port, debug=False, threaded=True)
