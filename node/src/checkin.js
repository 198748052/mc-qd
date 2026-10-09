#!/usr/bin/env node
'use strict';

/**
 * 命令行签到入口 —— 供服务器计划任务（cron / 宝塔计划任务）调用。
 *
 * 用法：
 *   node src/checkin.js                      # 读取 config.json 里的 Cookie
 *   node src/checkin.js --cookie <值>         # 临时指定（裸 session 值或完整 Cookie 串）
 *   MONKEYCODE_COOKIE=<值> node src/checkin.js
 *
 * 退出码：0 成功（含今日已签到），1 失败。便于计划任务判断执行结果。
 */

const { MonkeyCodeClient, normalizeCookie } = require('./client.js');
const { readCookie, CONFIG_PATH } = require('./config.js');

const USAGE = `MonkeyCode 自动签到

用法：
  node src/checkin.js [--cookie <值>]

Cookie 取值优先级：
  1. --cookie 参数
  2. 环境变量 MONKEYCODE_COOKIE
  3. 配置文件 ${CONFIG_PATH}

退出码：0 成功 / 1 失败`;

/** 解析 --cookie / --help */
function parseArgs(argv) {
  const args = { cookie: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cookie') args.cookie = argv[++i] || '';
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  // 与 Python 版一致的优先级：参数 > 环境变量 > 配置文件
  const raw = args.cookie || process.env.MONKEYCODE_COOKIE || readCookie();
  if (!raw) {
    log('未找到 Cookie。请先扫码登录，或用 --cookie 指定', 'error');
    return 1;
  }
  const cookie = normalizeCookie(raw);

  try {
    const client = new MonkeyCodeClient(cookie);
    const result = await client.checkin(log);
    return result.ok ? 0 : 1;
  } catch (e) {
    log(e.message, 'error');
    return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    log(`未预期的错误：${e.stack || e.message}`, 'error');
    process.exit(1);
  }
);