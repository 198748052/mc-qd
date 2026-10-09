'use strict';

/**
 * config.json 读写：用于持久化 monkeycode_ai_session。
 *
 * 默认与 Python 版共用项目根目录下的 config.json，这样从 Python 切到 Node
 * 时已保存的凭证可以直接复用。可用环境变量 MONKEYCODE_CONFIG 覆盖路径。
 */

const fs = require('node:fs');
const path = require('node:path');
const { SESSION_COOKIE_NAME } = require('./client.js');

/** 配置文件路径：默认指向项目根目录，与 Python 版共用 */
const CONFIG_PATH =
  process.env.MONKEYCODE_CONFIG || path.join(__dirname, '..', '..', 'config.json');

/**
 * 读取已保存的 Cookie，无则返回空串。
 * @returns {string}
 */
function readCookie() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw)?.cookie || '';
  } catch {
    return '';
  }
}

/**
 * 写入 Cookie，返回规范化后的完整 Cookie 串。
 * @param {string} cookie
 * @returns {string}
 */
function writeCookie(cookie) {
  const v = (cookie || '').trim();
  if (!v) throw new Error('Cookie 不能为空');
  const normalized = v.includes('=') ? v : `${SESSION_COOKIE_NAME}=${v}`;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ cookie: normalized }, null, 2), {
    encoding: 'utf8',
    mode: 0o600, // 内含登录凭证，收紧权限
  });
  return normalized;
}

/**
 * 打码显示 Cookie，仅保留首尾片段。
 * @param {string} cookie
 * @returns {string}
 */
function maskCookie(cookie) {
  const v = cookie || '';
  if (v.length <= 16) return v ? '****' : '';
  return `${v.slice(0, 12)}******${v.slice(-6)}`;
}

module.exports = { CONFIG_PATH, readCookie, writeCookie, maskCookie };