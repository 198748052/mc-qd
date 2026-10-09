#!/usr/bin/env node
'use strict';

/**
 * 命令行签到入口 —— 供服务器计划任务（cron / 宝塔计划任务）调用。
 *
 * 用法：
 *   node src/checkin.js                      # 对所有已保存账号签到
 *   node src/checkin.js --id <账号id>         # 只签到指定账号
 *   node src/checkin.js --cookie <值>         # 临时指定 Cookie（裸 session 值或完整串）
 *   MONKEYCODE_COOKIE=<值> node src/checkin.js
 *   node src/checkin.js --scheduled          # 定时模式：仅当到达配置的签到时间才执行
 *
 * 退出码：0 成功（含今日已签到 / 定时未到），1 失败。便于计划任务判断执行结果。
 */

const { MonkeyCodeClient, normalizeCookie } = require('./client.js');
const { CONFIG_PATH } = require('./config.js');
const store = require('./store.js');

const USAGE = `MonkeyCode 自动签到

用法：
  node src/checkin.js [--cookie <值>] [--id <账号id>] [--all] [--scheduled]

Cookie 取值优先级：
  1. --cookie 参数
  2. 环境变量 MONKEYCODE_COOKIE
  3. config.json 中保存的账号

选项：
  --id <id>    只签到指定账号
  --all        签到所有账号（默认行为）
  --scheduled  定时模式：仅在配置的签到时间窗口内执行（供 cron 调用）

退出码：0 成功 / 1 失败`;

/** 解析命令行参数 */
function parseArgs(argv) {
  const args = { cookie: '', id: '', all: false, scheduled: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cookie') args.cookie = argv[++i] || '';
    else if (argv[i] === '--id') args.id = argv[++i] || '';
    else if (argv[i] === '--all') args.all = true;
    else if (argv[i] === '--scheduled') args.scheduled = true;
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
  }
  return args;
}

/** 打印一行带时间戳的日志 */
function log(msg, level = 'info') {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const tag = { info: 'INFO', ok: ' OK ', warn: 'WARN', error: 'FAIL' }[level] || 'INFO';
  console.log(`[${t}] [${tag}] ${msg}`);
}

/** 当前分钟数（0~1439） */
function minutesOfDay(d = new Date()) {
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * 定时模式是否应执行。
 * 窗口：从配置时间起 15 分钟内（cron 每 10 分钟触发一次，足够覆盖）。
 */
function inScheduledWindow(schedule) {
  if (!schedule.enabled) return false;
  const [h, m] = schedule.time.split(':').map(Number);
  const sched = h * 60 + m;
  const diff = (minutesOfDay() - sched + 1440) % 1440;
  return diff < 15;
}

/** 对单个 Cookie 执行签到 */
async function checkinOne(cookie, label) {
  const client = new MonkeyCodeClient(cookie);
  const result = await client.checkin((msg, level) => log(label ? `[${label}] ${msg}` : msg, level));
  return result.ok;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  // 定时模式：未到时间窗口则直接退出（供 cron 每 10 分钟调用）
  if (args.scheduled) {
    const schedule = store.getSchedule();
    if (!inScheduledWindow(schedule)) {
      log(`未到签到时间（配置 ${schedule.time}，当前 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}），跳过`, 'info');
      return 0;
    }
    log(`到达签到时间窗口（配置 ${schedule.time}），开始执行`, 'info');
  }

  // 临时指定 Cookie（参数或环境变量）：只签一次
  const raw = args.cookie || process.env.MONKEYCODE_COOKIE || '';
  if (raw) {
    const ok = await checkinOne(normalizeCookie(raw), '');
    return ok ? 0 : 1;
  }

  // 指定账号
  if (args.id) {
    const cookie = store.getCookie(args.id);
    if (!cookie) {
      log(`账号 ${args.id} 不存在或未配置 Cookie`, 'error');
      return 1;
    }
    const acc = store.getAccount(args.id);
    const ok = await checkinOne(cookie, acc ? acc.name : args.id);
    return ok ? 0 : 1;
  }

  // 默认：所有账号
  const accounts = store.listAccounts();
  if (!accounts.length) {
    log('未找到已保存账号。请先在面板扫码登录，或用 --cookie 指定', 'error');
    return 1;
  }

  let allOk = true;
  for (const a of accounts) {
    const cookie = store.getCookie(a.id);
    if (!cookie) {
      log(`账号「${a.name}」未配置 Cookie，跳过`, 'warn');
      continue;
    }
    try {
      const ok = await checkinOne(cookie, a.name);
      if (!ok) allOk = false;
    } catch (e) {
      log(`账号「${a.name}」签到失败：${e.message}`, 'error');
      allOk = false;
    }
  }
  return allOk ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    log(`未预期的错误：${e.stack || e.message}`, 'error');
    process.exit(1);
  }
);
