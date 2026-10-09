'use strict';

/**
 * 本地状态存储 —— 多账号 + 定时签到配置（零依赖）。
 *
 * 沿用项目根目录的 config.json（与 Python 版共用），在其上扩展：
 *   {
 *     "cookie": "monkeycode_ai_session=...",   // 兼容字段：始终同步为当前启用账号
 *     "accounts": [ { id, name, cookie, user, created_at, last_checkin_at, last_checked_in } ],
 *     "active_id": "xxxx",
 *     "schedule": { "enabled": true, "time": "08:00" }
 *   }
 *
 * 旧的单 Cookie 配置（只有 cookie 字段）会在首次读取时自动迁移成一个账号，
 * 因此升级后原有登录态不丢失。
 *
 * 环境变量（可选）：
 *   MONKEYCODE_CONFIG   config.json 路径，默认项目根目录
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { normalizeCookie } = require('./client.js');

const CONFIG_PATH =
  process.env.MONKEYCODE_CONFIG || path.join(__dirname, '..', '..', 'config.json');

const DEFAULT_TIME = '08:00';

/** 生成账号 id */
function newId() {
  return crypto.randomBytes(8).toString('hex');
}

/** 当前 Unix 时间戳（秒） */
function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/** 构造一个账号对象 */
function makeAccount(name, cookie) {
  return {
    id: newId(),
    name: (name || '').trim() || '未命名账号',
    cookie: normalizeCookie(cookie),
    user: null,
    created_at: nowSec(),
    last_checkin_at: null,
    last_checked_in: null,
  };
}

/** 规范化 schedule 对象；缺省时默认启用 08:00（保持旧版每日签到行为） */
function normalizeSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') {
    return { enabled: true, time: DEFAULT_TIME };
  }
  let time = typeof schedule.time === 'string' ? schedule.time.trim() : '';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) time = DEFAULT_TIME;
  return { enabled: Boolean(schedule.enabled), time };
}

/** 读取原始 JSON，失败返回 {} */
function readRaw() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
  } catch {
    return {};
  }
}

/**
 * 写入完整状态。会同步 legacy 的 cookie 字段为当前启用账号，
 * 保证 checkin.js / Python 版的旧读取逻辑仍然可用。
 * @param {{accounts:object[], active_id:string, schedule:object}} state
 */
function writeState(state) {
  const active = state.accounts.find((a) => a.id === state.active_id);
  const out = {
    cookie: active ? active.cookie : '',
    accounts: state.accounts,
    active_id: state.active_id,
    schedule: normalizeSchedule(state.schedule),
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(out, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  return out;
}

/**
 * 读取并规范化状态（含旧数据迁移）。
 * @returns {{accounts:object[], active_id:string, schedule:object}}
 */
function readState() {
  const raw = readRaw();
  let changed = false;

  let accounts = Array.isArray(raw.accounts) ? raw.accounts.filter(Boolean) : [];
  if (!Array.isArray(raw.accounts)) changed = true;

  // 旧版单 Cookie 迁移
  if (!accounts.length && raw.cookie) {
    accounts = [makeAccount('默认账号', raw.cookie)];
    changed = true;
  }

  // 补齐账号字段，兼容手工编辑过的配置
  for (const acc of accounts) {
    if (!acc.id) {
      acc.id = newId();
      changed = true;
    }
    if (typeof acc.name !== 'string' || !acc.name.trim()) {
      acc.name = '未命名账号';
      changed = true;
    }
    if (acc.last_checkin_at === undefined) acc.last_checkin_at = null;
    if (acc.last_checked_in === undefined) acc.last_checked_in = null;
  }

  let activeId = raw.active_id;
  if (!activeId || !accounts.some((a) => a.id === activeId)) {
    activeId = accounts.length ? accounts[0].id : '';
    changed = true;
  }

  const schedule = normalizeSchedule(raw.schedule);
  if (JSON.stringify(schedule) !== JSON.stringify(raw.schedule || {})) changed = true;

  const state = { accounts, active_id: activeId, schedule };
  if (changed) {
    try {
      writeState(state);
    } catch {
      /* 无写权限时忽略，仅本次内存态可用 */
    }
  }
  return state;
}

// --------------------------------------------------------------------------- //
// 账号操作
// --------------------------------------------------------------------------- //

/** 列出账号（含打码 Cookie，不含明文），并标记当前启用项 */
function listAccounts() {
  const state = readState();
  return state.accounts.map((a) => ({
    id: a.id,
    name: a.name,
    masked: a.cookie ? mask(a.cookie) : '',
    user: a.user || null,
    active: a.id === state.active_id,
    created_at: a.created_at || null,
    last_checkin_at: a.last_checkin_at || null,
    last_checked_in: a.last_checked_in === true ? true : a.last_checked_in === false ? false : null,
  }));
}

/** 打码显示 Cookie，仅保留首尾片段 */
function mask(cookie) {
  const v = cookie || '';
  if (v.length <= 16) return v ? '****' : '';
  return `${v.slice(0, 12)}******${v.slice(-6)}`;
}

/** 新增账号，返回 {ok, id} */
function addAccount(name, cookie) {
  const state = readState();
  const acc = makeAccount(name, cookie);
  state.accounts.push(acc);
  // 首个账号自动设为启用
  if (!state.active_id) state.active_id = acc.id;
  writeState(state);
  return { id: acc.id, name: acc.name };
}

/** 修改账号（重命名 / 更新 Cookie） */
function updateAccount(id, patch = {}) {
  const state = readState();
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc) return { ok: false, message: '账号不存在' };
  if (typeof patch.name === 'string' && patch.name.trim()) acc.name = patch.name.trim();
  if (typeof patch.cookie === 'string' && patch.cookie.trim()) {
    acc.cookie = normalizeCookie(patch.cookie);
    acc.user = null; // Cookie 变了，用户缓存作废
  }
  writeState(state);
  return { ok: true };
}

/** 删除账号 */
function deleteAccount(id) {
  const state = readState();
  const before = state.accounts.length;
  state.accounts = state.accounts.filter((a) => a.id !== id);
  if (state.accounts.length === before) return { ok: false, message: '账号不存在' };
  if (state.active_id === id) {
    state.active_id = state.accounts.length ? state.accounts[0].id : '';
  }
  writeState(state);
  return { ok: true };
}

/** 设置启用账号 */
function setActive(id) {
  const state = readState();
  if (!state.accounts.some((a) => a.id === id)) return { ok: false, message: '账号不存在' };
  state.active_id = id;
  writeState(state);
  return { ok: true };
}

/** 取指定账号（id 省略时取当前启用账号） */
function getAccount(id) {
  const state = readState();
  if (id) return state.accounts.find((a) => a.id === id) || null;
  return state.accounts.find((a) => a.id === state.active_id) || null;
}

/** 取账号 Cookie（id 省略时取当前启用账号） */
function getCookie(id) {
  const acc = getAccount(id);
  return acc ? acc.cookie : '';
}

/** 记录一次签到结果 */
function markCheckedIn(id, { user = undefined, checkedIn = undefined } = {}) {
  const state = readState();
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc) return;
  if (user !== undefined && user !== null) acc.user = user;
  if (checkedIn !== undefined) acc.last_checked_in = checkedIn;
  acc.last_checkin_at = nowSec();
  writeState(state);
}

/** 仅缓存用户信息（用于状态检测） */
function setUser(id, user) {
  const state = readState();
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc || !user) return;
  acc.user = user;
  writeState(state);
}

// --------------------------------------------------------------------------- //
// 定时签到配置
// --------------------------------------------------------------------------- //

/** 读取定时配置 */
function getSchedule() {
  return readState().schedule;
}

/** 更新定时配置 */
function setSchedule(enabled, time) {
  const state = readState();
  state.schedule = normalizeSchedule({ enabled, time });
  writeState(state);
  return state.schedule;
}

module.exports = {
  CONFIG_PATH,
  readState,
  writeState,
  listAccounts,
  addAccount,
  updateAccount,
  deleteAccount,
  setActive,
  getAccount,
  getCookie,
  markCheckedIn,
  setUser,
  getSchedule,
  setSchedule,
  mask,
};
