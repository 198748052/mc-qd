'use strict';

/**
 * 面板访问鉴权 —— 用户名 + 密码 + 签名会话 Cookie（零依赖）。
 *
 * 背景：签到面板能读写登录凭证、触发签到，一旦被公网访问即等同于泄露账号。
 * 这里给面板加一层访问鉴权，未登录只能看到登录页。
 *
 * 账号来源（优先级从高到低）：
 *   1. 环境变量 PANEL_USERNAME / PANEL_PASSWORD
 *   2. auth.json 中的 username / password 字段
 *   3. 首次启动自动生成随机密码（用户名默认 admin）并写入 auth.json
 *
 * 会话实现：签发 `<过期时间戳>.<HMAC-SHA256 签名>` 的无状态 token，
 * 签名密钥持久化在 auth.json，因此服务重启（含在线更新）后会话仍然有效。
 * 修改密码时会轮换密钥，使其它已登录会话全部失效。
 *
 * 环境变量（可选）：
 *   PANEL_USERNAME    面板用户名
 *   PANEL_PASSWORD    面板密码
 *   MONKEYCODE_AUTH   auth.json 路径，默认项目根目录
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const AUTH_PATH = process.env.MONKEYCODE_AUTH || path.join(REPO_ROOT, 'auth.json');

/** 会话 Cookie 名 */
const COOKIE_NAME = 'panel_session';
/** 会话有效期：7 天 */
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
/** 默认用户名 */
const DEFAULT_USERNAME = 'admin';

/** 生成随机十六进制串 */
function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** 读取 auth.json，损坏或不存在时返回 {} */
function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8')) || {};
  } catch {
    return {};
  }
}

/** 以 600 权限写入 auth.json */
function saveStore(store) {
  fs.writeFileSync(AUTH_PATH, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
}

// --------------------------------------------------------------------------- //
// 初始化：解析用户名、密码与签名密钥
// --------------------------------------------------------------------------- //
const store = loadStore();
const envUsername = (process.env.PANEL_USERNAME || '').trim();
const envPassword = (process.env.PANEL_PASSWORD || '').trim();
let dirty = false;
let generatedPassword = '';

if (!store.secret) {
  store.secret = randomHex(32);
  dirty = true;
}
if (!store.username) {
  store.username = envUsername || DEFAULT_USERNAME;
  dirty = true;
}
// 未通过环境变量与 auth.json 提供密码时，自动生成一个便于首次登录
if (!envPassword && !store.password) {
  store.password = randomHex(4); // 8 位十六进制
  generatedPassword = store.password;
  dirty = true;
}
if (dirty) {
  try {
    saveStore(store);
  } catch {
    /* 无写权限时忽略：密码仍可在本次进程内使用 */
  }
}

/** 生效用户名/密码：环境变量优先（可在运行时被 updateCredentials 覆盖） */
let USERNAME = envUsername || store.username || DEFAULT_USERNAME;
let PASSWORD = envPassword || store.password || '';
let SECRET = store.secret;

// --------------------------------------------------------------------------- //
// 对外方法
// --------------------------------------------------------------------------- //

/** 常量时间比较两个字符串 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a == null ? '' : a), 'utf8');
  const bb = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** 校验用户名 + 密码 */
function checkCredentials(username, password) {
  return safeEqual(username, USERNAME) && safeEqual(password, PASSWORD);
}

/** 仅校验密码（保留给旧调用） */
function checkPassword(password) {
  return safeEqual(password, PASSWORD);
}

/** 当前面板用户名 */
function getUsername() {
  return USERNAME;
}

/**
 * 修改用户名 / 密码。
 * @param {{currentPassword:string, username?:string, newPassword?:string}} opts
 * @returns {{ok:boolean, message?:string, rotated?:boolean, username?:string}}
 */
function updateCredentials(opts = {}) {
  const current = String(opts.currentPassword == null ? '' : opts.currentPassword);
  if (!safeEqual(current, PASSWORD)) {
    return { ok: false, message: '当前密码错误' };
  }

  const nextUsername = typeof opts.username === 'string' ? opts.username.trim() : '';
  const nextPassword = typeof opts.newPassword === 'string' ? opts.newPassword : '';

  if (nextUsername && nextUsername !== USERNAME) {
    USERNAME = nextUsername;
    store.username = nextUsername;
  }
  if (nextPassword) {
    if (nextPassword.length < 4) {
      return { ok: false, message: '新密码至少 4 位' };
    }
    PASSWORD = nextPassword;
    store.password = nextPassword;
    // 轮换签名密钥：其它已登录会话立即失效
    SECRET = randomHex(32);
    store.secret = SECRET;
  }

  try {
    saveStore(store);
  } catch {
    return { ok: false, message: '写入 auth.json 失败（检查目录权限）' };
  }
  return { ok: true, rotated: Boolean(nextPassword), username: USERNAME };
}

/** 计算过期时间的 HMAC 签名 */
function sign(exp) {
  return crypto.createHmac('sha256', SECRET).update(String(exp)).digest('hex');
}

/** 签发一个新的会话 token */
function issueToken() {
  const exp = Date.now() + SESSION_TTL;
  return `${exp}.${sign(exp)}`;
}

/** 校验会话 token 是否未过期且签名正确 */
function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const idx = token.indexOf('.');
  if (idx <= 0) return false;

  const expStr = token.slice(0, idx);
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;

  const actual = Buffer.from(token.slice(idx + 1), 'utf8');
  const expected = Buffer.from(sign(expStr), 'utf8');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

/** 解析 Cookie 请求头为对象 */
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      out[key] = part.slice(idx + 1).trim();
    }
  }
  return out;
}

/** 从请求中取出会话 token 并校验 */
function isAuthed(req) {
  const cookies = parseCookies(req.headers.cookie);
  return verifyToken(cookies[COOKIE_NAME]);
}

/** 生成的会话 Cookie 属性 */
function buildSetCookie(token, maxAgeSec) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

module.exports = {
  AUTH_PATH,
  COOKIE_NAME,
  SESSION_TTL,
  generatedPassword,
  passwordFromEnv: Boolean(envPassword),
  usernameFromEnv: Boolean(envUsername),
  checkCredentials,
  checkPassword,
  getUsername,
  updateCredentials,
  issueToken,
  verifyToken,
  parseCookies,
  isAuthed,
  buildSetCookie,
};
