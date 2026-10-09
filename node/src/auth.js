'use strict';

/**
 * 面板访问鉴权 —— 密码 + 签名会话 Cookie（零依赖）。
 *
 * 背景：签到面板能读写登录凭证、触发签到，一旦被公网访问即等同于泄露账号。
 * 这里给面板加一层访问密码，未登录只能看到登录页。
 *
 * 密码来源（优先级从高到低）：
 *   1. 环境变量 PANEL_PASSWORD
 *   2. auth.json 中的 password 字段
 *   3. 首次启动自动生成随机密码并写入 auth.json（同时打印到日志）
 *
 * 会话实现：签发 `<过期时间戳>.<HMAC-SHA256 签名>` 的无状态 token，
 * 签名密钥持久化在 auth.json，因此服务重启（含在线更新）后会话仍然有效。
 *
 * 环境变量（可选）：
 *   PANEL_PASSWORD    面板访问密码
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
// 初始化：解析密码与签名密钥
// --------------------------------------------------------------------------- //
const store = loadStore();
const envPassword = (process.env.PANEL_PASSWORD || '').trim();
let dirty = false;
let generatedPassword = '';

// 签名密钥必须稳定，否则重启后所有会话失效
if (!store.secret) {
  store.secret = randomHex(32);
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

/** 生效密码：环境变量优先 */
const PASSWORD = envPassword || store.password || '';
const SECRET = store.secret;

// --------------------------------------------------------------------------- //
// 对外方法
// --------------------------------------------------------------------------- //

/** 常量时间比较密码，避免时序侧信道 */
function checkPassword(input) {
  const a = Buffer.from(String(input == null ? '' : input), 'utf8');
  const b = Buffer.from(PASSWORD, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
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
  checkPassword,
  issueToken,
  verifyToken,
  parseCookies,
  isAuthed,
  buildSetCookie,
};
