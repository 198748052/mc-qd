'use strict';

/**
 * MonkeyCode 自动签到 —— HTTP 服务（Node.js，零运行时依赖）。
 *
 * 接口一览：
 *   GET  /                   前端页面（复用 Python 版的 templates/index.html）
 *   GET  /api/cookie         读取已保存的 Cookie（打码显示）
 *   POST /api/save_cookie    保存 Cookie 到 config.json
 *   POST /api/qr_login/start 开启微信扫码登录，返回 sid 与二维码
 *   GET  /api/qr_login/poll  轮询扫码状态，成功后自动保存 Cookie
 *   POST /api/status         只做登录态 + 今日签到状态检查（不签到）
 *   POST /api/checkin        执行完整签到流程，返回逐步日志
 *   GET  /api/update/check   检查是否有新版本（git fetch + 比较提交）
 *   POST /api/update/apply   拉取最新代码并重启服务（保留本地 config.json）
 *
 * 部署注意：扫码登录会话存在进程内存中，请以单进程方式运行。
 * 与 Python 版不同，这里无需 worker 数约束——事件循环天然并发，
 * 长轮询与 PoW 求解都是异步的，不会互相阻塞。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { MonkeyCodeClient, normalizeCookie } = require('./client.js');
const { startLogin } = require('./wechat-login.js');
const { readCookie, writeCookie, maskCookie, CONFIG_PATH } = require('./config.js');
const updater = require('./update.js');

/** 前端页面：直接复用 Python 版的模板，避免两份拷贝 */
const INDEX_HTML = path.join(__dirname, '..', '..', 'templates', 'index.html');

/** 扫码登录会话表：sid -> QrLoginSession（仅存内存，故需单进程） */
const LOGIN_SESSIONS = new Map();

// --------------------------------------------------------------------------- //
// 工具函数
// --------------------------------------------------------------------------- //

/** 当前时间 HH:MM:SS，用于日志行 */
function now() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

/** 构造一行日志 {t, level, msg} */
function line(level, msg) {
  return { t: now(), level, msg };
}

/** 发送 JSON 响应 */
function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** 读取请求体并解析为 JSON（无 body 时返回 {}） */
function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/**
 * 确定本次操作使用的 Cookie：优先用请求里传入的，否则回退到 config.json。
 * @param {string} fromBody
 */
function resolveCookie(fromBody) {
  const v = (fromBody || '').trim();
  return v ? normalizeCookie(v) : readCookie();
}

/** 统一的登录态异常包装 */
function ensureCookie(cookie) {
  if (!cookie) throw new Error('未提供 Cookie，请先扫码登录或手动填写');
  return cookie;
}

// --------------------------------------------------------------------------- //
// 路由处理
// --------------------------------------------------------------------------- //

/** GET /api/cookie —— 仅回显打码值，不返回明文 */
function apiCookie(res) {
  const cookie = readCookie();
  sendJson(res, 200, {
    saved: Boolean(cookie),
    masked: maskCookie(cookie),
  });
}

/** POST /api/save_cookie */
async function apiSaveCookie(req, res) {
  const body = await readJsonBody(req);
  const raw = (body.cookie || '').trim();
  if (!raw) return sendJson(res, 400, { ok: false, message: 'Cookie 不能为空' });
  const cookie = writeCookie(raw);
  sendJson(res, 200, { ok: true, message: '已保存', masked: maskCookie(cookie) });
}

/** POST /api/qr_login/start —— 开启扫码登录，等二维码就绪后返回 */
async function apiQrStart(res) {
  const sess = await startLogin();
  LOGIN_SESSIONS.set(sess.sid, sess);

  // 清理过期会话，避免内存无限增长
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [sid, s] of LOGIN_SESSIONS) {
    if (s.created < cutoff) LOGIN_SESSIONS.delete(sid);
  }

  sendJson(res, 200, sess.snapshot());
}

/** GET /api/qr_login/poll —— 轮询扫码状态，成功后落盘 Cookie */
function apiQrPoll(url, res) {
  const sid = url.searchParams.get('sid') || '';
  const sess = LOGIN_SESSIONS.get(sid);
  if (!sess) return sendJson(res, 404, { status: 'error', message: '登录会话不存在或已过期' });

  const data = sess.snapshot();

  // 登录成功：持久化 Cookie（只处理一次）
  if (sess.status === 'confirmed' && sess.cookie) {
    const cookie = writeCookie(sess.cookie);
    sess.cookie = ''; // 防止重复写盘
    data.masked = maskCookie(cookie);
    data.user = sess.user;
    data.saved = true;
    LOGIN_SESSIONS.delete(sid);
  }

  sendJson(res, 200, data);
}

/** POST /api/status —— 只检查，不签到 */
async function apiStatus(req, res) {
  const body = await readJsonBody(req);
  const logs = [];
  const result = { ok: false };

  try {
    const cookie = ensureCookie(resolveCookie(body.cookie));
    const client = new MonkeyCodeClient(cookie);

    // 1) 登录态
    logs.push(line('info', 'GET /api/v1/users/status  校验登录态 ...'));
    const user = await client.getUserStatus();
    result.user = user;
    logs.push(line('ok', `登录态有效，用户：${user.name || user.email || user.id || '未知'}`));

    // 2) 今日签到状态
    logs.push(line('info', 'GET /api/v1/users/wallet/checkin  查询签到状态 ...'));
    const status = await client.getCheckinStatus();
    result.checked_in = Boolean(status.checked_in);
    logs.push(
      line(result.checked_in ? 'ok' : 'warn', result.checked_in ? '今日已签到' : '今日尚未签到')
    );

    // 3) 余额
    logs.push(line('info', 'GET /api/v1/users/wallet  查询余额 ...'));
    const wallet = await client.getWallet();
    result.balance = wallet.balance;
    logs.push(line('ok', `当前余额：${wallet.balance}`));

    result.ok = true;
  } catch (e) {
    logs.push(line('error', e.message));
  }

  sendJson(res, 200, { ...result, logs });
}

/** POST /api/checkin —— 执行完整签到流程 */
async function apiCheckin(req, res) {
  const body = await readJsonBody(req);
  const logs = [];
  const result = { ok: false };

  try {
    const cookie = ensureCookie(resolveCookie(body.cookie));
    const client = new MonkeyCodeClient(cookie);

    // 1) 登录态
    logs.push(line('info', 'GET /api/v1/users/status  校验登录态 ...'));
    const user = await client.getUserStatus();
    result.user = user;
    logs.push(line('ok', `登录态有效，用户：${user.name || user.email || user.id || '未知'}`));

    // 2) 是否已签到
    logs.push(line('info', 'GET /api/v1/users/wallet/checkin  查询签到状态 ...'));
    const status = await client.getCheckinStatus();
    if (status.checked_in) {
      result.checked_in = true;
      result.ok = true;
      logs.push(line('ok', '今日已签到，无需重复操作'));
      try {
        result.balance = (await client.getWallet()).balance;
      } catch {
        /* 忽略 */
      }
      return sendJson(res, 200, { ...result, logs });
    }
    logs.push(line('warn', '今日尚未签到，开始执行签到流程'));

    // 3) 取人机验证挑战
    logs.push(line('info', 'POST /api/v1/public/captcha/challenge  获取验证挑战 ...'));
    const challenge = await client.createCaptchaChallenge();
    const { c, s, d } = challenge.challenge;
    logs.push(line('info', `挑战内容：${c} 个子任务 / salt ${s} 位 / 难度 ${d} 位十六进制`));

    // 4) 本地求解 PoW
    logs.push(line('info', `开始在本地求解 ${c} 个工作量证明 ...`));
    const t0 = Date.now();
    const { solveChallenges } = require('./pow.js');
    const solutions = await solveChallenges(challenge.token, c, s, d);
    const cost = Date.now() - t0;
    logs.push(line('ok', `验证已破解（${c} 个解，耗时 ${cost} ms）`));

    // 5) 换取 captcha_token
    logs.push(line('info', 'POST /api/v1/public/captcha/redeem  提交解答 ...'));
    const captchaToken = await client.redeemCaptcha(challenge.token, solutions);
    logs.push(line('ok', `验证通过，captcha_token=${captchaToken}`));

    // 6) 提交签到
    logs.push(line('info', 'POST /api/v1/users/wallet/checkin  提交签到 ...'));
    const checkedIn = await client.doCheckin(captchaToken);
    result.checked_in = checkedIn;
    if (!checkedIn) {
      logs.push(line('error', '签到未成功（服务端返回 checked_in=false）'));
      return sendJson(res, 200, { ...result, logs });
    }

    // 7) 余额
    result.ok = true;
    result.captcha_token = captchaToken;
    try {
      result.balance = (await client.getWallet()).balance;
    } catch {
      /* 忽略 */
    }
    logs.push(line('ok', `签到成功！当前余额：${result.balance}`));
  } catch (e) {
    logs.push(line('error', e.message));
  }

  sendJson(res, 200, { ...result, logs });
}

// --------------------------------------------------------------------------- //
// 在线更新
// --------------------------------------------------------------------------- //

/** GET /api/update/check —— 检查是否有新版本 */
async function apiUpdateCheck(res) {
  const info = await updater.getUpdateStatus();
  sendJson(res, 200, info);
}

/** POST /api/update/apply —— 拉取最新代码，成功后重启服务 */
async function apiUpdateApply(req, res) {
  const body = await readJsonBody(req);
  const logs = [];
  const result = { ok: false };

  try {
    const r = await updater.applyUpdate(Boolean(body.force));
    result.ok = true;
    result.changed = r.changed;
    result.before = r.before;
    result.after = r.after;
    result.restarting = Boolean(r.changed);
    for (const l of r.logs) logs.push(line(l.level, l.msg));
    if (r.changed) {
      logs.push(line('warn', '代码已更新，即将重启服务以加载新版本 ...'));
      updater.scheduleRestart();
    }
  } catch (e) {
    logs.push(line('error', e.message));
  }

  sendJson(res, 200, { ...result, logs });
}

/** 返回前端页面。开发时实时读盘，避免改完页面还要重启服务 */
function serveIndex(res) {
  fs.readFile(INDEX_HTML, (err, buf) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`读取页面失败：${err.message}`);
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

// --------------------------------------------------------------------------- //
// 服务器
// --------------------------------------------------------------------------- //

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const { pathname } = url;

  try {
    if (req.method === 'GET' && pathname === '/') return serveIndex(res);
    if (req.method === 'GET' && pathname === '/api/cookie') return apiCookie(res);
    if (req.method === 'POST' && pathname === '/api/save_cookie') return await apiSaveCookie(req, res);
    if (req.method === 'POST' && pathname === '/api/qr_login/start') return await apiQrStart(res);
    if (req.method === 'GET' && pathname === '/api/qr_login/poll') return apiQrPoll(url, res);
    if (req.method === 'POST' && pathname === '/api/status') return await apiStatus(req, res);
    if (req.method === 'POST' && pathname === '/api/checkin') return await apiCheckin(req, res);
    if (req.method === 'GET' && pathname === '/api/update/check') return await apiUpdateCheck(res);
    if (req.method === 'POST' && pathname === '/api/update/apply') return await apiUpdateApply(req, res);

    sendJson(res, 404, { ok: false, message: `未知接口：${pathname}` });
  } catch (e) {
    sendJson(res, 500, { ok: false, message: e.message });
  }
});

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 27183);

server.listen(PORT, HOST, () => {
  console.log(`MonkeyCode 签到服务已启动：http://${HOST}:${PORT}`);
  console.log(`配置文件：${CONFIG_PATH}`);
});

// 优雅退出，便于 systemd / 宝塔管理进程
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`收到 ${sig}，正在关闭 ...`);
    server.close(() => process.exit(0));
  });
}