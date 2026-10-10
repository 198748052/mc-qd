'use strict';

/**
 * 打卡日志存储 —— 记录每次打卡的时间、打卡前后积分与本次获得的积分。
 *
 * 独立于 config.json，默认写入项目根目录的 checkin_logs.json，
 * 可用环境变量 MONKEYCODE_LOG 覆盖路径。日志按时间倒序保留最近 MAX_LOGS 条。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LOG_PATH =
  process.env.MONKEYCODE_LOG || path.join(__dirname, '..', '..', 'checkin_logs.json');

const MAX_LOGS = 1000;

/** 当前 Unix 时间戳（秒） */
function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/** 转成数字，非数字返回 null（用于积分字段） */
function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 读取日志数组，损坏或不存在时返回 [] */
function readRaw() {
  try {
    const data = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** 写入日志数组，自动截断到 MAX_LOGS 条 */
function writeRaw(list) {
  fs.writeFileSync(LOG_PATH, JSON.stringify(list.slice(0, MAX_LOGS), null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

/**
 * 追加一条打卡记录。
 * @param {object} entry
 *   { account_id, account_name, checked_in, checkin_at,
 *     balance_before, balance_after, source }
 * @returns {object} 实际写入的记录
 */
function appendLog(entry = {}) {
  const balanceBefore = toNum(entry.balance_before);
  const balanceAfter = toNum(entry.balance_after);
  const record = {
    id: crypto.randomBytes(6).toString('hex'),
    account_id: entry.account_id || '',
    account_name: entry.account_name || '',
    checked_in: entry.checked_in !== false,
    checkin_at: entry.checkin_at || nowSec(),
    balance_before: balanceBefore,
    balance_after: balanceAfter,
    points:
      balanceBefore !== null && balanceAfter !== null
        ? balanceAfter - balanceBefore
        : null,
    source: entry.source || 'manual',
  };
  const list = readRaw();
  list.unshift(record);
  writeRaw(list);
  return record;
}

/**
 * 根据一次签到结果写入打卡记录（仅记录真正新完成的打卡）。
 * @param {object} result MonkeyCodeClient.checkin() 的返回值
 * @param {object} meta { account_id, account_name, source }
 * @returns {object|null} 写入的记录；非新打卡时返回 null
 */
function recordCheckin(result, meta = {}) {
  if (!result || !result.ok || !result.checkedIn || result.already) return null;
  return appendLog({
    account_id: meta.account_id,
    account_name: meta.account_name,
    checked_in: true,
    balance_before: result.balanceBefore,
    balance_after: result.balanceAfter,
    source: meta.source,
  });
}

/**
 * 列出打卡记录（时间倒序）。
 * @param {object} [opts]
 *   account_id 仅返回该账号的记录（留空返回全部）
 *   limit      最多返回条数
 * @returns {object[]}
 */
function listLogs({ account_id = '', limit = 200 } = {}) {
  let list = readRaw();
  if (account_id) list = list.filter((x) => x.account_id === account_id);
  const n = Number(limit);
  if (Number.isFinite(n) && n > 0) list = list.slice(0, n);
  return list;
}

/**
 * 清空打卡记录（可按账号）。
 * @param {object} [opts] account_id 留空清空全部
 * @returns {{ok: boolean, removed: number}}
 */
function clearLogs({ account_id = '' } = {}) {
  const list = readRaw();
  if (!account_id) {
    writeRaw([]);
    return { ok: true, removed: list.length };
  }
  const kept = list.filter((x) => x.account_id !== account_id);
  writeRaw(kept);
  return { ok: true, removed: list.length - kept.length };
}

module.exports = { LOG_PATH, appendLog, recordCheckin, listLogs, clearLogs };
