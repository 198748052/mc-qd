# -*- coding: utf-8 -*-
r"""
本地状态存储 —— 多账号 + 定时签到配置（与 node/src/store.js 对齐）。

沿用项目根目录的 config.json，在其上扩展：
    {
      "cookie": "monkeycode_ai_session=...",   # 兼容字段：始终同步为当前启用账号
      "accounts": [ { id, name, cookie, user, created_at, last_checkin_at, last_checked_in } ],
      "active_id": "xxxx",
      "schedule": { "enabled": true, "time": "08:00" }
    }

旧的单 Cookie 配置（只有 cookie 字段）会在首次读取时自动迁移成一个账号，
因此升级后原有登录态不丢失。

环境变量（可选）：
    MONKEYCODE_CONFIG   config.json 路径，默认项目根目录
"""

import json
import os
import secrets
import time

from monkeycode_checkin import SESSION_COOKIE_NAME

CONFIG_PATH = os.environ.get(
    "MONKEYCODE_CONFIG",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json"),
)

DEFAULT_TIME = "08:00"


def normalize_cookie(cookie: str) -> str:
    """若传入的是裸 session 值（不含 "="），自动补上 Cookie 名。"""
    cookie = (cookie or "").strip()
    if cookie and "=" not in cookie:
        cookie = f"{SESSION_COOKIE_NAME}={cookie}"
    return cookie


def _new_id() -> str:
    return secrets.token_hex(8)


def _now_sec() -> int:
    return int(time.time())


def _make_account(name: str, cookie: str) -> dict:
    return {
        "id": _new_id(),
        "name": (name or "").strip() or "未命名账号",
        "cookie": normalize_cookie(cookie),
        "user": None,
        "created_at": _now_sec(),
        "last_checkin_at": None,
        "last_checked_in": None,
    }


def normalize_schedule(schedule) -> dict:
    """规范化 schedule；缺省时默认启用 08:00（保持旧版每日签到行为）。"""
    if not isinstance(schedule, dict):
        return {"enabled": True, "time": DEFAULT_TIME}
    t = schedule.get("time")
    t = t.strip() if isinstance(t, str) else ""
    parts = t.split(":") if t else []
    valid = (
        len(parts) == 2
        and parts[0].isdigit()
        and parts[1].isdigit()
        and 0 <= int(parts[0]) <= 23
        and 0 <= int(parts[1]) <= 59
        and len(parts[0]) == 2
        and len(parts[1]) == 2
    )
    if not valid:
        t = DEFAULT_TIME
    return {"enabled": bool(schedule.get("enabled")), "time": t}


def _read_raw() -> dict:
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f) or {}
    except (json.JSONDecodeError, OSError):
        return {}


def write_state(state: dict) -> dict:
    """写入完整状态；同步 legacy 的 cookie 字段为当前启用账号。"""
    accounts = state.get("accounts", [])
    active = next((a for a in accounts if a.get("id") == state.get("active_id")), None)
    out = {
        "cookie": active.get("cookie", "") if active else "",
        "accounts": accounts,
        "active_id": state.get("active_id", ""),
        "schedule": normalize_schedule(state.get("schedule")),
    }
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    try:
        os.chmod(CONFIG_PATH, 0o600)
    except OSError:
        pass
    return out


def read_state() -> dict:
    """读取并规范化状态（含旧数据迁移）。"""
    raw = _read_raw()
    changed = False

    raw_accounts = raw.get("accounts")
    accounts = [a for a in raw_accounts if a] if isinstance(raw_accounts, list) else []
    if not isinstance(raw_accounts, list):
        changed = True

    if not accounts and raw.get("cookie"):
        accounts = [_make_account("默认账号", raw["cookie"])]
        changed = True

    for acc in accounts:
        if not acc.get("id"):
            acc["id"] = _new_id()
            changed = True
        if not isinstance(acc.get("name"), str) or not acc["name"].strip():
            acc["name"] = "未命名账号"
            changed = True
        if acc.get("last_checkin_at") is None and "last_checkin_at" not in acc:
            acc["last_checkin_at"] = None
        if acc.get("last_checked_in") is None and "last_checked_in" not in acc:
            acc["last_checked_in"] = None

    active_id = raw.get("active_id")
    if not active_id or not any(a.get("id") == active_id for a in accounts):
        active_id = accounts[0]["id"] if accounts else ""
        changed = True

    schedule = normalize_schedule(raw.get("schedule"))
    if schedule != normalize_schedule(raw.get("schedule") or {}):
        changed = True

    state = {"accounts": accounts, "active_id": active_id, "schedule": schedule}
    if changed:
        try:
            write_state(state)
        except OSError:
            pass
    return state


# --------------------------------------------------------------------------- #
# 账号操作
# --------------------------------------------------------------------------- #
def mask(cookie: str) -> str:
    """打码显示 Cookie，仅保留首尾片段。"""
    v = cookie or ""
    if len(v) <= 16:
        return "****" if v else ""
    return f"{v[:12]}******{v[-6:]}"


def list_accounts() -> list:
    state = read_state()
    out = []
    for a in state["accounts"]:
        out.append(
            {
                "id": a.get("id"),
                "name": a.get("name"),
                "masked": mask(a.get("cookie", "")) if a.get("cookie") else "",
                "user": a.get("user") or None,
                "active": a.get("id") == state["active_id"],
                "created_at": a.get("created_at"),
                "last_checkin_at": a.get("last_checkin_at"),
                "last_checked_in": a.get("last_checked_in")
                if a.get("last_checked_in") in (True, False)
                else None,
            }
        )
    return out


def add_account(name: str, cookie: str) -> dict:
    state = read_state()
    acc = _make_account(name, cookie)
    state["accounts"].append(acc)
    if not state["active_id"]:
        state["active_id"] = acc["id"]
    write_state(state)
    return {"id": acc["id"], "name": acc["name"]}


def update_account(account_id: str, patch: dict) -> dict:
    state = read_state()
    acc = next((a for a in state["accounts"] if a.get("id") == account_id), None)
    if not acc:
        return {"ok": False, "message": "账号不存在"}
    name = patch.get("name")
    if isinstance(name, str) and name.strip():
        acc["name"] = name.strip()
    cookie = patch.get("cookie")
    if isinstance(cookie, str) and cookie.strip():
        acc["cookie"] = normalize_cookie(cookie)
        acc["user"] = None
    write_state(state)
    return {"ok": True}


def delete_account(account_id: str) -> dict:
    state = read_state()
    before = len(state["accounts"])
    state["accounts"] = [a for a in state["accounts"] if a.get("id") != account_id]
    if len(state["accounts"]) == before:
        return {"ok": False, "message": "账号不存在"}
    if state["active_id"] == account_id:
        state["active_id"] = state["accounts"][0]["id"] if state["accounts"] else ""
    write_state(state)
    return {"ok": True}


def set_active(account_id: str) -> dict:
    state = read_state()
    if not any(a.get("id") == account_id for a in state["accounts"]):
        return {"ok": False, "message": "账号不存在"}
    state["active_id"] = account_id
    write_state(state)
    return {"ok": True}


def get_account(account_id: str = "") -> dict:
    state = read_state()
    if account_id:
        return next((a for a in state["accounts"] if a.get("id") == account_id), None)
    return next((a for a in state["accounts"] if a.get("id") == state["active_id"]), None)


def get_cookie(account_id: str = "") -> str:
    acc = get_account(account_id)
    return acc.get("cookie", "") if acc else ""


def mark_checked_in(account_id: str, user=None, checked_in=None) -> None:
    state = read_state()
    acc = next((a for a in state["accounts"] if a.get("id") == account_id), None)
    if not acc:
        return
    if user is not None:
        acc["user"] = user
    if checked_in is not None:
        acc["last_checked_in"] = checked_in
    acc["last_checkin_at"] = _now_sec()
    write_state(state)


def set_user(account_id: str, user) -> None:
    if not user:
        return
    state = read_state()
    acc = next((a for a in state["accounts"] if a.get("id") == account_id), None)
    if not acc:
        return
    acc["user"] = user
    write_state(state)


# --------------------------------------------------------------------------- #
# 定时签到配置
# --------------------------------------------------------------------------- #
def get_schedule() -> dict:
    return read_state()["schedule"]


def set_schedule(enabled, time_str: str) -> dict:
    state = read_state()
    state["schedule"] = normalize_schedule({"enabled": enabled, "time": time_str})
    write_state(state)
    return state["schedule"]
