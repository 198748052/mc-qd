# -*- coding: utf-8 -*-
r"""
MonkeyCode 微信扫码登录（纯服务端实现）
=====================================

逆向自浏览器录制文件 `mokeycode-2026-10-08.json`，把原本需要浏览器参与的
微信扫码登录链路完整搬到服务端，用于在没有浏览器的服务器上自动获取
`monkeycode_ai_session`。

完整链路（全部为 HTTP 请求，扫码动作由用户手机完成）：
    1. GET  monkeycode-ai.com/api/v1/users/login
             -> 302，Location 是百智云的 OAuth 授权地址（含 state）
    2. GET  baizhi.cloud/api/v1/wechat/login?type=web&redirect_url=<授权地址>
             -> 返回微信登录参数 {app_id, state, redirect_uri, scope}
    3. GET  open.weixin.qq.com/connect/qrconnect?appid=...&state=...
             -> 页面里服务端已渲染出 uuid（形如 G="091yrJo039Ohml28"）
    4. GET  open.weixin.qq.com/connect/qrcode/<uuid>     -> 二维码图片
    5. 循环 GET lp.open.weixin.qq.com/connect/l/qrconnect?uuid=<uuid>&last=<上次errcode>
             -> 返回 window.wx_errcode=NNN;window.wx_code='...'
                408 未扫码 / 404 已扫码待确认 / 403 用户取消 / 402 二维码失效
                405 确认成功，此时 wx_code 有效
    6. GET  baizhi.cloud/api/v1/oauth/wechat/callback?code=<wx_code>&state=<state>
             -> 302，拿到百智云的登录态
    7. GET  baizhi.cloud/api/v1/oauth/authorize?...      -> 302，Location 带 code=tmp_xxx
    8. GET  monkeycode-ai.com/api/v1/users/baizhi/callback?code=tmp_xxx&state=...
             -> 302 回首页，并下发 monkeycode_ai_session Cookie

上述所有请求共用同一个 requests.Session，才能把各步骤下发的 Cookie 串起来。

说明：errcode 语义直接取自微信 qrconnect 页面内联 JS 的 switch 分支，
非猜测。二维码有效期约 5 分钟，失效（402）时自动重新生成。
"""

import base64
import re
import threading
import time
import urllib.parse
import uuid as uuid_lib

import requests

# ---- 各步骤涉及的端点 ----
MONKEYCODE_BASE = "https://monkeycode-ai.com"
BAIZHI_BASE = "https://baizhi.cloud"
WECHAT_LOGIN_API = f"{BAIZHI_BASE}/api/v1/wechat/login"
WECHAT_CALLBACK_API = f"{BAIZHI_BASE}/api/v1/oauth/wechat/callback"
BAIZHI_AUTHORIZE_API = f"{BAIZHI_BASE}/api/v1/oauth/authorize"
QRCONNECT_PAGE = "https://open.weixin.qq.com/connect/qrconnect"
QRCODE_IMAGE = "https://open.weixin.qq.com/connect/qrcode"
LONG_POLL_API = "https://lp.open.weixin.qq.com/connect/l/qrconnect"

# 会话 Cookie 名称
SESSION_COOKIE_NAME = "monkeycode_ai_session"

# 与浏览器一致的请求头
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/134.0.6998.205 Safari/537.36"
)

# 长轮询返回码语义（来自微信页面内联 JS 的 switch 分支）
CODE_WAITING = 408      # 尚未扫码
CODE_SCANNED = 404      # 已扫码，等待手机端确认
CODE_CANCELLED = 403    # 用户在手机上取消
CODE_EXPIRED = 402      # 二维码已失效，需重新生成
CODE_SUCCESS = 405      # 确认成功，wx_code 有效

# 单个二维码的最长等待时间（秒），超时后自动换一张
QR_LIFETIME = 300
# 一次登录会话的最长存活时间（秒）
LOGIN_TIMEOUT = 600
# start_login 等待二维码就绪的最长时间（秒）
QR_READY_WAIT = 15


class LoginError(RuntimeError):
    """扫码登录过程中的可预期错误。"""


def _new_session() -> requests.Session:
    """创建一个带浏览器默认请求头的会话。"""
    s = requests.Session()
    s.headers.update(
        {
            "User-Agent": UA,
            "Accept": "*/*",
            "sec-ch-ua": '"Not:A-Brand";v="24", "Chromium";v="134"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
        }
    )
    return s


def _begin_authorize(s: requests.Session) -> str:
    """
    第 1 步：请求 MonkeyCode 的登录接口，拿到百智云 OAuth 授权地址。
    该地址里带着 MonkeyCode 生成的 state，后续回调要靠它校验。
    """
    resp = s.get(
        f"{MONKEYCODE_BASE}/api/v1/users/login",
        params={"redirect": "", "inviter_id": ""},
        allow_redirects=False,
        timeout=20,
    )
    location = resp.headers.get("location")
    if not location:
        raise LoginError(f"未获取到 OAuth 授权地址（HTTP {resp.status_code}）")
    return location


def _get_wechat_params(s: requests.Session, authorize_url: str) -> dict:
    """
    第 2 步：用授权地址换取微信登录参数。
    返回 {app_id, state, redirect_uri, scope}。
    """
    resp = s.get(
        WECHAT_LOGIN_API,
        params={"type": "web", "redirect_url": authorize_url},
        timeout=20,
    )
    payload = resp.json()
    if payload.get("code") != 0:
        raise LoginError(f"获取微信登录参数失败：{payload}")
    return payload["data"]


def _fetch_qr(s: requests.Session, params: dict) -> tuple:
    """
    第 3、4 步：加载微信 qrconnect 页面，取出 uuid 并下载二维码图片。

    :return: (uuid, 图片字节)
    """
    qr_page = QRCONNECT_PAGE + "?" + urllib.parse.urlencode(
        {
            "appid": params["app_id"],
            "redirect_uri": params["redirect_uri"],
            "response_type": "code",
            "scope": params["scope"],
            "state": params["state"],
            "style": "black",
        }
    )
    resp = s.get(qr_page, timeout=20)
    # uuid 在页面里形如： var U=...,N=t("self_redirect"),G="091yrJo039Ohml28",
    match = re.search(r',G="([A-Za-z0-9_\-]{8,})"', resp.text)
    if not match:
        match = re.search(r"/connect/qrcode/([A-Za-z0-9_\-]{8,})", resp.text)
    if not match:
        raise LoginError("未能从微信登录页解析出 uuid")
    qr_uuid = match.group(1)

    img = s.get(f"{QRCODE_IMAGE}/{qr_uuid}", timeout=20)
    img.raise_for_status()
    return qr_uuid, img.content


def _long_poll_once(s: requests.Session, qr_uuid: str, last: str) -> tuple:
    """
    第 5 步：长轮询一次扫码状态。

    :param last: 上一次的 errcode，微信要求带上（对应页面的 &last= 参数）
    :return: (errcode, wx_code)
    """
    query = {"uuid": qr_uuid}
    if last:
        query["last"] = last
    try:
        resp = s.get(LONG_POLL_API, params=query, timeout=40)
    except requests.Timeout:
        # 长轮询超时属于正常现象，按“仍在等待”处理
        return CODE_WAITING, ""
    m_code = re.search(r"wx_errcode\s*=\s*(\d+)", resp.text)
    m_code_val = re.search(r"wx_code\s*=\s*'([^']*)'", resp.text)
    errcode = int(m_code.group(1)) if m_code else CODE_WAITING
    wx_code = m_code_val.group(1) if m_code_val else ""
    return errcode, wx_code


def _exchange_code(s: requests.Session, wx_code: str, wx_state: str) -> str:
    """
    第 6~8 步：把微信 code 一路换成 monkeycode_ai_session。

    :return: monkeycode_ai_session 的值
    """
    # 6) 微信回调：百智云在此步骤写入自身登录态
    s.get(
        WECHAT_CALLBACK_API,
        params={"code": wx_code, "state": wx_state},
        allow_redirects=False,
        timeout=20,
    )

    # 7) 调用授权接口换取 MonkeyCode 的临时 code
    resp = s.get(
        BAIZHI_AUTHORIZE_API,
        params={
            "client_id": "monkeycode-ai",
            "redirect_uri": f"{MONKEYCODE_BASE}/api/v1/users/baizhi/callback",
            "response_type": "code",
            "scope": "user phone",
            "state": wx_state,
        },
        allow_redirects=False,
        timeout=20,
    )
    callback_url = resp.headers.get("location")
    if not callback_url or "code=" not in callback_url:
        raise LoginError(f"未获取到授权 code（HTTP {resp.status_code}）")

    # 8) 回调 MonkeyCode：此处下发 monkeycode_ai_session
    s.get(callback_url, allow_redirects=False, timeout=20)

    session_value = s.cookies.get(SESSION_COOKIE_NAME, domain="monkeycode-ai.com")
    if not session_value:
        # 兜底：不限域名再找一次
        session_value = s.cookies.get(SESSION_COOKIE_NAME)
    if not session_value:
        raise LoginError("回调完成但未拿到 monkeycode_ai_session")
    return session_value


def verify_session(cookie: str) -> dict:
    """
    用拿到的 Cookie 请求一次 users/status，确认登录态真实有效。

    :return: 用户信息 dict
    """
    s = _new_session()
    s.headers.update({"Cookie": f"{SESSION_COOKIE_NAME}={cookie}"})
    resp = s.get(f"{MONKEYCODE_BASE}/api/v1/users/status", timeout=20)
    resp.raise_for_status()
    return resp.json().get("data", {}).get("user", {})


class QRLoginSession:
    """
    一次扫码登录的会话状态，供前端轮询。

    status 取值：
        starting  正在初始化
        waiting   二维码已就绪，等待扫码
        scanned   已扫码，等待手机确认
        cancelled 用户取消（仍在等待重新扫码）
        refreshed 二维码已过期并自动刷新
        confirmed 登录成功，cookie 已就绪
        error     出错，message 为原因
    """

    def __init__(self, sid: str):
        self.sid = sid
        self.status = "starting"
        self.message = "正在初始化 ..."
        self.qr_data_url = ""      # 二维码图片（data:image/jpeg;base64,...）
        self.cookie = ""           # 登录成功后的 session 值
        self.user = None           # 登录成功后的用户信息
        self.created = time.time()

    def snapshot(self) -> dict:
        """返回给前端的当前状态。"""
        return {
            "sid": self.sid,
            "status": self.status,
            "message": self.message,
            "qr": self.qr_data_url,
            "done": self.status == "confirmed",
        }


def _run_login(sess: QRLoginSession) -> None:
    """在后台线程里跑完整个扫码登录流程，并实时更新会话状态。"""
    s = _new_session()
    try:
        # 1~2) 拿到 OAuth 授权地址与微信登录参数
        authorize_url = _begin_authorize(s)
        params = _get_wechat_params(s, authorize_url)

        deadline = sess.created + LOGIN_TIMEOUT
        while time.time() < deadline:
            # 3~4) 生成（或重新生成）二维码
            qr_uuid, img_bytes = _fetch_qr(s, params)
            sess.qr_data_url = "data:image/jpeg;base64," + base64.b64encode(img_bytes).decode()
            sess.status = "waiting"
            sess.message = "请用微信扫描二维码"

            # 5) 循环长轮询扫码状态
            last = ""
            qr_deadline = time.time() + QR_LIFETIME
            while time.time() < qr_deadline and time.time() < deadline:
                errcode, wx_code = _long_poll_once(s, qr_uuid, last)
                last = str(errcode) if errcode else ""

                if errcode == CODE_SUCCESS and wx_code:
                    # 6~8) 确认成功，换 session
                    sess.message = "扫码成功，正在获取登录凭证 ..."
                    sess.cookie = _exchange_code(s, wx_code, params["state"])
                    try:
                        sess.user = verify_session(sess.cookie)
                    except Exception:  # noqa: BLE001 —— 校验失败不影响已拿到的 cookie
                        sess.user = None
                    sess.status = "confirmed"
                    sess.message = "登录成功"
                    return

                if errcode == CODE_SCANNED:
                    sess.status = "scanned"
                    sess.message = "已扫码，请在手机上点击确认"
                elif errcode == CODE_CANCELLED:
                    sess.status = "cancelled"
                    sess.message = "已取消，请重新扫码"
                elif errcode == CODE_EXPIRED:
                    # 二维码失效，跳出内层循环重新生成
                    sess.status = "refreshed"
                    sess.message = "二维码已过期，正在刷新 ..."
                    break
                elif errcode == CODE_WAITING:
                    if sess.status not in ("scanned", "cancelled"):
                        sess.status = "waiting"
                        sess.message = "请用微信扫描二维码"
                # 其余返回码（500 等）当作瞬时故障，继续轮询

            if sess.status != "refreshed":
                # 内层循环正常结束（超时）也刷新二维码
                sess.status = "refreshed"
                sess.message = "二维码已过期，正在刷新 ..."

        sess.status = "error"
        sess.message = "登录超时，请重试"
    except Exception as e:  # noqa: BLE001 —— 后台线程内统一兜底
        sess.status = "error"
        sess.message = f"登录失败：{e}"


def start_login() -> QRLoginSession:
    """
    开启一次扫码登录：创建会话并启动后台线程。
    阻塞等待二维码就绪（最多 QR_READY_WAIT 秒），让调用方拿到的会话
    直接带上二维码，前端点一次按钮即可看到图。
    """
    sid = uuid_lib.uuid4().hex
    sess = QRLoginSession(sid)
    threading.Thread(target=_run_login, args=(sess,), daemon=True).start()

    # 等待后台线程把二维码取回来（正常 1~2 秒）
    deadline = time.time() + QR_READY_WAIT
    while time.time() < deadline:
        if sess.qr_data_url or sess.status == "error":
            break
        time.sleep(0.1)
    return sess