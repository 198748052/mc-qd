'use strict';

/**
 * MonkeyCode 自动签到 —— HTTP 服务（Node.js，零运行时依赖）。
 *
 * 接口一览：
 *   GET  /login               登录页（用户名 + 密码，未登录时其它页面会重定向到此）
 *   POST /api/login           校验用户名/密码并下发会话 Cookie
 *   POST /api/logout          退出登录，清除会话 Cookie
 *   GET  /api/panel           读取当前面板用户名
 *   POST /api/panel/update    修改面板用户名 / 密码
 *   GET  /                    前端页面（复用 Python 版的 templates/index.html）
 *   GET  /api/cookie          读取当前启用账号的 Cookie（打码显示，兼容旧接口）
 *   POST /api/save_cookie     更新当前启用账号的 Cookie（兼容旧接口）
 *   GET  /api/accounts        列出已保存账号
 *   POST /api/accounts/add    新增账号
 *   POST /api/accounts/update 修改账号（重命名 / 更新 Cookie）
 *   POST /api/accounts/delete 删除账号
 *   POST /api/accounts/active 切换当前启用账号
 *   POST /api/qr_login/start  开启微信扫码登录，返回 sid 与二维码
 *   GET  /api/qr_login/poll   轮询扫码状态，成功后保存为新账号
 *   POST /api/status          检查指定账号登录态 + 今日签到状态（不签到）
 *   POST /api/checkin         对指定账号执行完整签到
 *   POST /api/checkin_all     对所有账号执行签到
 *   GET  /api/schedule        读取定时签到配置
 *   POST /api/schedule        设置定时签到（启用开关 + HH:MM）
 *   GET  /api/update/check    检查是否有新版本（git fetch + 比较提交）
 *   POST /api/update/apply    拉取最新代码并重启服务（保留本地 config.json）
 *
 * 部署注意：扫码登录会话存在进程内存中，请以单进程方式运行。
 * 与 Python 版不同，这里无需 worker 数约束——事件循环天然并发，
 * 长轮询与 PoW 求解都是异步的，不会互相阻塞。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { MonkeyCodeClient } = require('./client.js');
const { startLogin } = require('./wechat-login.js');
const { CONFIG_PATH } = require('./config.js');
const updater = require('./update.js');
const auth = require('./auth.js');
const store = require('./store.js');
const scheduler = require('./scheduler.js');

/** 前端页面：直接复用 Python 版的模板，避免两份拷贝 */
const INDEX_HTML = path.join(__dirname, '..', '..', 'templates', 'index.html');
/** 登录页模板 */
const LOGIN_HTML = path.join(__dirname, '..', '..', 'templates', 'login.html');

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

/** 解析目标账号 id：请求体指定 > 当前启用账号 */
function resolveAccountId(fromBody) {
  const id = (fromBody || '').trim();
  if (id) return id;
  return store.readState().active_id;
}

// --------------------------------------------------------------------------- //
// 访问鉴权
// --------------------------------------------------------------------------- //

/** POST /api/login —— 校验用户名/密码，成功后下发签名会话 Cookie */
async function apiLogin(req, res) {
  const body = await readJsonBody(req);
  if (!auth.checkCredentials(body.username, body.password)) {
    // 稍作延迟，抬高暴力破解成本
    await new Promise((r) => setTimeout(r, 400));
    return sendJson(res, 401, { ok: false, message: '用户名或密码错误' });
  }
  const token = auth.issueToken();
  res.setHeader('Set-Cookie', auth.buildSetCookie(token, Math.floor(auth.SESSION_TTL / 1000)));
  sendJson(res, 200, { ok: true });
}

/** POST /api/logout —— 清除会话 Cookie */
function apiLogout(res) {
  res.setHeader('Set-Cookie', auth.buildSetCookie('', 0));
  sendJson(res, 200, { ok: true });
}

/** GET /api/panel —— 当前面板用户名 */
function apiPanelInfo(res) {
  sendJson(res, 200, { ok: true, username: auth.getUsername() });
}

/** POST /api/panel/update —— 修改用户名 / 密码 */
async function apiPanelUpdate(req, res) {
  const body = await readJsonBody(req);
  const r = auth.updateCredentials({
    currentPassword: body.current_password,
    username: body.username,
    newPassword: body.new_password,
  });
  if (!r.ok) return sendJson(res, 400, { ok: false, message: r.message });

  // 密码变更会轮换签名密钥，为当前用户补发一个新会话，避免被自己踢下线
  if (r.rotated) {
    const token = auth.issueToken();
    res.setHeader('Set-Cookie', auth.buildSetCookie(token, Math.floor(auth.SESSION_TTL / 1000)));
  }
  sendJson(res, 200, { ok: true, username: r.username, rotated: Boolean(r.rotated) });
}

// --------------------------------------------------------------------------- //
// 账号管理
// --------------------------------------------------------------------------- //

/** GET /api/cookie —— 当前启用账号的打码 Cookie（兼容旧接口） */
function apiCookie(res) {
  const state = store.readState();
  const acc = state.accounts.find((a) => a.id === state.active_id);
  sendJson(res, 200, {
    saved: Boolean(acc && acc.cookie),
    masked: acc ? store.mask(acc.cookie) : '',
  });
}

/** POST /api/save_cookie —— 更新当前启用账号的 Cookie（兼容旧接口） */
async function apiSaveCookie(req, res) {
  const body = await readJsonBody(req);
  const raw = (body.cookie || '').trim();
  if (!raw) return sendJson(res, 400, { ok: false, message: 'Cookie 不能为空' });

  const state = store.readState();
  if (state.active_id) {
    store.updateAccount(state.active_id, { cookie: raw });
  } else {
    const acc = store.addAccount('默认账号', raw);
    store.setActive(acc.id);
  }
  const acc = store.getAccount(state.active_id || store.readState().active_id);
  sendJson(res, 200, { ok: true, message: '已保存', masked: acc ? store.mask(acc.cookie) : '' });
}

/** GET /api/accounts —— 列出已保存账号 */
function apiAccountsList(res) {
  const state = store.readState();
  sendJson(res, 200, { ok: true, accounts: store.listAccounts(), active_id: state.active_id });
}

/** POST /api/accounts/add */
async function apiAccountAdd(req, res) {
  const body = await readJsonBody(req);
  const cookie = (body.cookie || '').trim();
  if (!cookie) return sendJson(res, 400, { ok: false, message: 'Cookie 不能为空' });
  const added = store.addAccount(body.name, cookie);
  const acc = store.getAccount(added.id);
  sendJson(res, 200, { ok: true, id: added.id, name: added.name, masked: store.mask(acc.cookie) });
}

/** POST /api/accounts/update */
async function apiAccountUpdate(req, res) {
  const body = await readJsonBody(req);
  const r = store.updateAccount((body.id || '').trim(), {
    name: body.name,
    cookie: body.cookie,
  });
  sendJson(res, r.ok ? 200 : 400, r.ok ? { ok: true } : { ok: false, message: r.message });
}

/** POST /api/accounts/delete */
async function apiAccountDelete(req, res) {
  const body = await readJsonBody(req);
  const r = store.deleteAccount((body.id || '').trim());
  sendJson(res, r.ok ? 200 : 400, r.ok ? { ok: true } : { ok: false, message: r.message });
}

/** POST /api/accounts/active */
async function apiAccountActive(req, res) {
  const body = await readJsonBody(req);
  const r = store.setActive((body.id || '').trim());
  sendJson(res, r.ok ? 200 : 400, r.ok ? { ok: true } : { ok: false, message: r.message });
}

// --------------------------------------------------------------------------- //
// 微信扫码登录
// --------------------------------------------------------------------------- //

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

/** GET /api/qr_login/poll —— 轮询扫码状态，成功后保存为新账号 */
function apiQrPoll(url, res) {
  const sid = url.searchParams.get('sid') || '';
  const sess = LOGIN_SESSIONS.get(sid);
  if (!sess) return sendJson(res, 404, { status: 'error', message: '登录会话不存在或已过期' });

  const data = sess.snapshot();

  // 登录成功：保存为新账号并设为启用（只处理一次）
  if (sess.status === 'confirmed' && sess.cookie) {
    const name =
      (sess.user && (sess.user.name || sess.user.email)) || '微信登录账号';
    const added = store.addAccount(name, sess.cookie);
    store.setActive(added.id);
    const acc = store.getAccount(added.id);
    sess.cookie = ''; // 防止重复写盘
    data.masked = store.mask(acc.cookie);
    data.user = sess.user;
    data.account_id = added.id;
    data.saved = true;
    LOGIN_SESSIONS.delete(sid);
  }

  sendJson(res, 200, data);
}

// --------------------------------------------------------------------------- //
// 状态查询 / 签到
// --------------------------------------------------------------------------- //

/** POST /api/status —— 只检查，不签到 */
async function apiStatus(req, res) {
  const body = await readJsonBody(req);
  const logs = [];
  const result = { ok: false };

  try {
    const id = resolveAccountId(body.account_id);
    const cookie = store.getCookie(id);
    if (!cookie) throw new Error('该账号尚未配置 Cookie，请先扫码登录或手动填写');

    const client = new MonkeyCodeClient(cookie);

    // 1) 登录态
    logs.push(line('info', 'GET /api/v1/users/status  校验登录态 ...'));
    const user = await client.getUserStatus();
    result.user = user;
    result.account_id = id;
    store.setUser(id, user);
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
    const id = resolveAccountId(body.account_id);
    const cookie = store.getCookie(id);
    if (!cookie) throw new Error('该账号尚未配置 Cookie，请先扫码登录或手动填写');

    const client = new MonkeyCodeClient(cookie);
    result.account_id = id;

    // 1) 登录态
    logs.push(line('info', 'GET /api/v1/users/status  校验登录态 ...'));
    const user = await client.getUserStatus();
    result.user = user;
    store.setUser(id, user);
    logs.push(line('ok', `登录态有效，用户：${user.name || user.email || user.id || '未知'}`));

    // 2) 是否已签到
    logs.push(line('info', 'GET /api/v1/users/wallet/checkin  查询签到状态 ...'));
    const status = await client.getCheckinStatus();
    if (status.checked_in) {
      result.checked_in = true;
      result.ok = true;
      store.markCheckedIn(id, { user, checkedIn: true });
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
    store.markCheckedIn(id, { user, checkedIn });
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

/**
 * 对所有已保存账号执行签到。
 * @param {(msg:string, level?:string)=>void} [log]
 * @returns {Promise<object[]>} 每个账号的结果
 */
async function runAllCheckins(log = () => {}) {
  const accounts = store.listAccounts();
  const results = [];
  for (const a of accounts) {
    const cookie = store.getCookie(a.id);
    if (!cookie) {
      results.push({ id: a.id, name: a.name, ok: false, message: '未配置 Cookie' });
      continue;
    }
    try {
      const client = new MonkeyCodeClient(cookie);
      const r = await client.checkin((msg, level) => log(`[${a.name}] ${msg}`, level));
      store.markCheckedIn(a.id, { user: r.user, checkedIn: r.checkedIn });
      results.push({
        id: a.id,
        name: a.name,
        ok: r.ok,
        checked_in: r.checkedIn,
        balance: r.balance,
      });
    } catch (e) {
      store.markCheckedIn(a.id, { checkedIn: false });
      log(`[${a.name}] 签到失败：${e.message}`, 'error');
      results.push({ id: a.id, name: a.name, ok: false, message: e.message });
    }
  }
  return results;
}

/** POST /api/checkin_all —— 所有账号签到 */
async function apiCheckinAll(req, res) {
  const logs = [];
  try {
    const results = await runAllCheckins((msg, level) => logs.push(line(level || 'info', msg)));
    sendJson(res, 200, { ok: true, results, logs });
  } catch (e) {
    logs.push(line('error', e.message));
    sendJson(res, 200, { ok: false, results: [], logs });
  }
}

// --------------------------------------------------------------------------- //
// 定时签到配置
// --------------------------------------------------------------------------- //

/** GET /api/schedule */
function apiScheduleGet(res) {
  const s = store.getSchedule();
  sendJson(res, 200, {
    ok: true,
    enabled: s.enabled,
    time: s.time,
    next_run: scheduler.getNextRun(),
  });
}

/** POST /api/schedule */
async function apiScheduleSet(req, res) {
  const body = await readJsonBody(req);
  const s = store.setSchedule(Boolean(body.enabled), body.time);
  scheduler.reload();
  sendJson(res, 200, {
    ok: true,
    enabled: s.enabled,
    time: s.time,
    next_run: scheduler.getNextRun(),
  });
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

// --------------------------------------------------------------------------- //
// 静态页面
// --------------------------------------------------------------------------- //

/** 返回前端页面。开发时实时读盘，避免改完页面还要重启服务 */
function serveIndex(res) {
  serveFile(res, INDEX_HTML);
}

/** 返回登录页 */
function serveLogin(res) {
  serveFile(res, LOGIN_HTML);
}

/** 读取静态 HTML 文件并返回 */
function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
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
    // 公开路由：登录页与登录/登出接口不鉴权
    if (req.method === 'GET' && pathname === '/login') return serveLogin(res);
    if (req.method === 'POST' && pathname === '/api/login') return await apiLogin(req, res);
    if (req.method === 'POST' && pathname === '/api/logout') return apiLogout(res);

    // 其余页面与接口均需登录
    if (!auth.isAuthed(req)) {
      if (req.method === 'GET' && !pathname.startsWith('/api/')) {
        res.writeHead(302, { Location: '/login' });
        return res.end();
      }
      return sendJson(res, 401, { ok: false, message: '未登录或会话已过期', need_login: true });
    }

    if (req.method === 'GET' && pathname === '/') return serveIndex(res);
    if (req.method === 'GET' && pathname === '/api/panel') return apiPanelInfo(res);
    if (req.method === 'POST' && pathname === '/api/panel/update') return await apiPanelUpdate(req, res);
    if (req.method === 'GET' && pathname === '/api/cookie') return apiCookie(res);
    if (req.method === 'POST' && pathname === '/api/save_cookie') return await apiSaveCookie(req, res);
    if (req.method === 'GET' && pathname === '/api/accounts') return apiAccountsList(res);
    if (req.method === 'POST' && pathname === '/api/accounts/add') return await apiAccountAdd(req, res);
    if (req.method === 'POST' && pathname === '/api/accounts/update') return await apiAccountUpdate(req, res);
    if (req.method === 'POST' && pathname === '/api/accounts/delete') return await apiAccountDelete(req, res);
    if (req.method === 'POST' && pathname === '/api/accounts/active') return await apiAccountActive(req, res);
    if (req.method === 'POST' && pathname === '/api/qr_login/start') return await apiQrStart(res);
    if (req.method === 'GET' && pathname === '/api/qr_login/poll') return apiQrPoll(url, res);
    if (req.method === 'POST' && pathname === '/api/status') return await apiStatus(req, res);
    if (req.method === 'POST' && pathname === '/api/checkin') return await apiCheckin(req, res);
    if (req.method === 'POST' && pathname === '/api/checkin_all') return await apiCheckinAll(req, res);
    if (req.method === 'GET' && pathname === '/api/schedule') return apiScheduleGet(res);
    if (req.method === 'POST' && pathname === '/api/schedule') return await apiScheduleSet(req, res);
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
  if (auth.generatedPassword) {
    console.log('────────────────────────────────────────────');
    console.log(`已生成面板登录账号：${auth.getUsername()} / ${auth.generatedPassword}`);
    console.log(`（已保存到 ${auth.AUTH_PATH}，可用 PANEL_USERNAME / PANEL_PASSWORD 环境变量覆盖）`);
    console.log('────────────────────────────────────────────');
  }
});

// 启动进程内定时签到调度器
scheduler.init(async () => {
  console.log(`[scheduler] ${now()} 触发定时签到`);
  const results = await runAllCheckins((msg, level) => {
    const tag = { info: 'INFO', ok: ' OK ', warn: 'WARN', error: 'FAIL' }[level] || 'INFO';
    console.log(`[scheduler] [${tag}] ${msg}`);
  });
  console.log(`[scheduler] 完成，共 ${results.length} 个账号`);
});

// 优雅退出，便于 systemd / 宝塔管理进程
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`收到 ${sig}，正在关闭 ...`);
    server.close(() => process.exit(0));
  });
}
