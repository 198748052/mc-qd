# -*- coding: utf-8 -*-
r"""
MonkeyCode 自动签到脚本
=================================

逆向自浏览器请求录制文件 `mokeycode-2026-10-08.json`，完整还原了 MonkeyCode
（https://monkeycode-ai.com）的登录态校验 + 每日签到流程。

签到的完整流程：
    1. GET  /api/v1/users/status                 校验登录态（可选，用于确认 cookie 有效）
    2. GET  /api/v1/users/wallet/checkin         查询今天是否已签到
    3. POST /api/v1/public/captcha/challenge     获取人机验证挑战（Cap CAPTCHA 的 PoW）
    4. （本地计算）求解 50 个 SHA-256 工作量证明
    5. POST /api/v1/public/captcha/redeem        用解答换取 captcha_token
    6. POST /api/v1/users/wallet/checkin         携带 captcha_token 完成签到

关于人机验证（Cap CAPTCHA, https://trycap.dev）：
    - 服务端返回挑战配置 {c, s, d} 和一个种子 token：
        c = 50  -> 需要求解的子挑战数量
        s = 32  -> salt 的十六进制字符长度
        d = 3   -> 目标前缀的十六进制字符长度（难度）
    - 客户端对第 b 个（b 从 1 开始）子挑战：
        salt   = cap_hash(token + str(b),       s)
        target = cap_hash(token + str(b) + "d", d)
      其中 cap_hash 是 Cap 前端里那个 `i(o,c)` 函数：先做 32 位 FNV-1a 哈希，
      再把结果当作 xorshift32 伪随机数种子，反复输出 8 位十六进制拼接后截断。
    - 然后暴力枚举 nonce（十进制字符串），直到：
        sha256(salt + str(nonce)) 的十六进制结果以 target 为前缀
      该 nonce 即为第 b 个子挑战的答案。
    - 把全部答案按顺序放进 solutions 数组提交给 redeem。

认证方式：
    仅依赖会话 Cookie `monkeycode_ai_session`，可从浏览器开发者工具复制
    （Application -> Cookies -> https://monkeycode-ai.com -> monkeycode_ai_session）。

用法：
    # 方式一：环境变量（推荐，避免明文写进文件）
    set MONKEYCODE_COOKIE=你的cookie字符串或session值
    .venv\Scripts\python.exe monkeycode_checkin.py

    # 方式二：命令行参数
    .venv\Scripts\python.exe monkeycode_checkin.py --cookie "monkeycode_ai_session=xxxx"

    # 方式三：同目录下 config.json
    { "cookie": "monkeycode_ai_session=xxxx" }
"""

import argparse
import hashlib
import json
import os
import sys

import requests

# 目标站点
BASE_URL = "https://monkeycode-ai.com"

# 与浏览器一致的默认请求头，避免被风控识别
DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/134.0.6998.205 Safari/537.36"
)

# 会话 Cookie 名称
SESSION_COOKIE_NAME = "monkeycode_ai_session"


# --------------------------------------------------------------------------- #
# 一、Cap CAPTCHA PoW 算法（纯 Python 复刻，与浏览器 WASM/JS 结果一致）
# --------------------------------------------------------------------------- #
def _to_int32(x: int) -> int:
    """模拟 JavaScript 的 ToInt32：取低 32 位并按有符号整数解释。"""
    x &= 0xFFFFFFFF
    return x - 0x100000000 if x >= 0x80000000 else x


def _to_uint32(x: int) -> int:
    """模拟 JavaScript 的 ToUint32 / `>>> 0`：取低 32 位无符号整数。"""
    return x & 0xFFFFFFFF


def cap_hash(s: str, length: int) -> str:
    """
    复刻 Cap widget 前端中的哈希函数 `i(o, c)`。

    步骤：
      1) 对字符串做 32 位 FNV-1a 哈希（异或后乘以 FNV 质数 16777619）；
      2) 以该哈希为种子，反复执行 xorshift32，每次输出 8 位十六进制；
      3) 拼接后截取前 `length` 个字符。

    :param s: 输入字符串（token + 子挑战序号）
    :param length: 需要输出的十六进制字符数
    """
    # --- FNV-1a 32 位 ---
    h = 2166136261  # FNV offset basis
    for ch in s:
        # JS: h ^= charCodeAt(i)
        h = _to_int32(_to_int32(h) ^ ord(ch))
        # JS: h += (h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24)  —— 等价于乘以 FNV 质数
        h = (
            h
            + _to_int32(h << 1)
            + _to_int32(h << 4)
            + _to_int32(h << 7)
            + _to_int32(h << 8)
            + _to_int32(h << 24)
        )

    # --- 以 FNV 结果为种子执行 xorshift32 ---
    u = _to_uint32(h)
    out = ""
    while len(out) < length:
        u = _to_int32(u ^ _to_int32(u << 13))
        u = _to_int32(u ^ (_to_uint32(u) >> 17))
        u = _to_int32(u ^ _to_int32(u << 5))
        u = _to_uint32(u)
        # 每个随机数输出 8 位十六进制（不足补零）
        out += format(u, "x").rjust(8, "0")
    return out[:length]


def solve_pow(salt: str, target_hex: str) -> int:
    """
    求解单个工作量证明：暴力枚举 nonce，使得
        sha256(salt + str(nonce)) 的十六进制结果以 target_hex 为前缀。

    :param salt: 由 cap_hash 派生的 salt
    :param target_hex: 目标前缀（十六进制字符串）
    :return: 满足条件的 nonce（整数）
    """
    nonce = 0
    while True:
        digest = hashlib.sha256((salt + str(nonce)).encode("utf-8")).hexdigest()
        if digest.startswith(target_hex):
            return nonce
        nonce += 1


def solve_challenges(token: str, count: int, size: int, difficulty: int) -> list:
    """
    根据挑战配置求解全部子挑战。

    :param token: 服务端下发的挑战种子 token
    :param count: 子挑战数量 c
    :param size: salt 十六进制长度 s
    :param difficulty: 目标前缀十六进制长度 d
    :return: solutions 列表（与子挑战顺序一一对应）
    """
    solutions = []
    for b in range(1, count + 1):
        # 派生第 b 个子挑战的 salt 与 target
        salt = cap_hash(f"{token}{b}", size)
        target = cap_hash(f"{token}{b}d", difficulty)
        solutions.append(solve_pow(salt, target))
    return solutions


# --------------------------------------------------------------------------- #
# 二、HTTP 客户端
# --------------------------------------------------------------------------- #
class MonkeyCodeClient:
    """封装与 MonkeyCode 交互所需的 HTTP 请求。"""

    def __init__(self, cookie: str):
        # 若传入的是裸 session 值（不含 "="），补上 Cookie 名
        if "=" not in cookie:
            cookie = f"{SESSION_COOKIE_NAME}={cookie}"
        self.cookie = cookie
        self.session = requests.Session()
        self.session.headers.update(
            {
                "User-Agent": DEFAULT_UA,
                "Accept": "*/*",
                "Origin": BASE_URL,
                "Referer": f"{BASE_URL}/",
                "Cookie": cookie,
                "sec-ch-ua": '"Not:A-Brand";v="24", "Chromium";v="134"',
                "sec-ch-ua-mobile": "?0",
                "sec-ch-ua-platform": '"Windows"',
            }
        )

    def get_user_status(self) -> dict:
        """GET /api/v1/users/status —— 校验登录态是否有效。"""
        resp = self.session.get(f"{BASE_URL}/api/v1/users/status", timeout=30)
        resp.raise_for_status()
        return resp.json()

    def get_checkin_status(self) -> bool:
        """
        GET /api/v1/users/wallet/checkin —— 查询今天是否已签到。
        返回 True 表示今天已签到。
        """
        resp = self.session.get(
            f"{BASE_URL}/api/v1/users/wallet/checkin", timeout=30
        )
        resp.raise_for_status()
        return bool(resp.json().get("data", {}).get("checked_in", False))

    def create_captcha_challenge(self) -> dict:
        """
        POST /api/v1/public/captcha/challenge —— 获取 PoW 挑战。
        返回 {"challenge": {"c","s","d"}, "expires": ..., "token": ...}
        """
        resp = self.session.post(
            f"{BASE_URL}/api/v1/public/captcha/challenge", timeout=30
        )
        resp.raise_for_status()
        return resp.json()

    def redeem_captcha(self, token: str, solutions: list) -> str:
        """
        POST /api/v1/public/captcha/redeem —— 提交解答换取 captcha_token。
        :return: 可用于签到的 captcha_token
        """
        resp = self.session.post(
            f"{BASE_URL}/api/v1/public/captcha/redeem",
            json={"token": token, "solutions": solutions},
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        if not data.get("success"):
            raise RuntimeError(f"人机验证失败：{data}")
        return data["token"]

    def do_checkin(self, captcha_token: str) -> bool:
        """
        POST /api/v1/users/wallet/checkin —— 携带 captcha_token 完成签到。
        :return: 是否签到成功
        """
        resp = self.session.post(
            f"{BASE_URL}/api/v1/users/wallet/checkin",
            json={"captcha_token": captcha_token},
            timeout=30,
        )
        resp.raise_for_status()
        return bool(resp.json().get("data", {}).get("checked_in", False))

    def get_wallet(self) -> dict:
        """GET /api/v1/users/wallet —— 查询钱包余额（用于展示签到结果）。"""
        resp = self.session.get(f"{BASE_URL}/api/v1/users/wallet", timeout=30)
        resp.raise_for_status()
        return resp.json().get("data", {})


# --------------------------------------------------------------------------- #
# 三、Cookie 读取与主流程
# --------------------------------------------------------------------------- #
def load_cookie(cli_cookie: str) -> str:
    """
    按优先级读取 Cookie：
        1) 命令行参数 --cookie
        2) 环境变量 MONKEYCODE_COOKIE
        3) 脚本同目录下的 config.json 中 {"cookie": "..."}
    """
    if cli_cookie:
        return cli_cookie.strip()

    env_cookie = os.environ.get("MONKEYCODE_COOKIE")
    if env_cookie:
        return env_cookie.strip()

    config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
    if os.path.exists(config_path):
        with open(config_path, "r", encoding="utf-8") as f:
            cookie = (json.load(f) or {}).get("cookie", "")
            if cookie:
                return cookie.strip()

    raise SystemExit(
        "未找到 Cookie。请通过以下任一方式提供：\n"
        "  1) 命令行参数：--cookie \"monkeycode_ai_session=xxxx\"\n"
        "  2) 环境变量：set MONKEYCODE_COOKIE=xxxx\n"
        "  3) config.json：{ \"cookie\": \"monkeycode_ai_session=xxxx\" }"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="MonkeyCode 自动签到")
    parser.add_argument("--cookie", default="", help="会话 Cookie 或 monkeycode_ai_session 的值")
    args = parser.parse_args()

    cookie = load_cookie(args.cookie)
    client = MonkeyCodeClient(cookie)

    # 1) 校验登录态
    try:
        status = client.get_user_status()
    except requests.HTTPError as e:
        print(f"[错误] 登录态校验失败（Cookie 可能已失效）：{e}")
        return 1
    user = status.get("data", {}).get("user", {})
    print(f"[信息] 当前用户：{user.get('name', '(未知)')} ({user.get('id', '')})")

    # 2) 查询今天是否已签到
    if client.get_checkin_status():
        print("[信息] 今天已经签到过了，无需重复签到。")
        return 0

    # 3) 获取人机验证挑战
    print("[信息] 获取人机验证挑战 ...")
    challenge_data = client.create_captcha_challenge()
    challenge = challenge_data["challenge"]
    token = challenge_data["token"]
    c, s, d = challenge["c"], challenge["s"], challenge["d"]
    print(f"[信息] 挑战配置：数量={c}, salt长度={s}, 难度={d}")

    # 4) 本地求解 PoW
    print("[信息] 正在求解工作量证明 ...")
    solutions = solve_challenges(token, c, s, d)
    print(f"[信息] 求解完成，共 {len(solutions)} 个子挑战。")

    # 5) 兑换 captcha_token
    print("[信息] 提交解答以换取 captcha_token ...")
    captcha_token = client.redeem_captcha(token, solutions)

    # 6) 执行签到
    print("[信息] 提交签到 ...")
    if client.do_checkin(captcha_token):
        wallet = client.get_wallet()
        print(f"[成功] 签到完成！当前余额：{wallet.get('balance', '?')}")
        return 0
    else:
        print("[失败] 签到未成功（服务端返回 checked_in=false）。")
        return 1


if __name__ == "__main__":
    sys.exit(main())
