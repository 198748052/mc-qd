'use strict';

/**
 * MonkeyCode 微信扫码登录 —— Python 版 monkeycode_login.py 的 JS 移植。
 *
 * 把原本需要浏览器参与的微信扫码登录链路完整搬到服务端，用于在没有浏览器的
 * 服务器上自动获取 monkeycode_ai_session。
 *
 * 完整链路（全部为 HTTP 请求，扫码动作由用户手机完成）：
 *   1. GET  monkeycode-ai.com/api/v1/users/login         -> 302，拿到 OAuth 授权地址
 *   2. GET  baizhi.cloud/api/v1/wechat/login             -> 微信登录参数
 *   3. GET  open.weixin.qq.com/connect/qrconnect         -> 页面里已渲染出 uuid
 *   4. GET  open.weixin.qq.com/connect/qrcode/<uuid>     -> 二维码图片
 *   5. 循环 GET lp.open.weixin.qq.com/connect/l/qrconnect -> 轮询扫码状态
 *   6. GET  baizhi.cloud/api/v1/oauth/wechat/callback    -> 百智云登录态
 *   7. GET  baizhi.cloud/api/v1/oauth/authorize          -> 换取 code=tmp_xxx
 *   8. GET  monkeycode-ai.com/api/v1/users/baizhi/callback -> 下发 session
 *
 * 上述请求共用同一个 HttpClient（同一 Cookie 容器）才能把各步骤串起来。
 *
 * errcode 语义取自微信 qrconnect 页面内联 JS 的 switch 分支，非猜测。
 */

const { HttpClient } = require('./http.js');
const { MonkeyCodeClient, SESSION_COOKIE_NAME } = require('./client.js');

const MONKEYCODE_BASE = 'https://monkeycode-ai.com';
const BAIZHI_BASE = 'https://baizhi.cloud';
const WECHAT_LOGIN_API = `${BAIZHI_BASE}/api/v1/wechat/login`;
const WECHAT_CALLBACK_API = `${BAIZHI_BASE}/api/v1/oauth/wechat/callback`;
const BAIZHI_AUTHORIZE_API = `${BAIZHI_BASE}/api/v1/oauth/authorize`;
const QRCONNECT_PAGE = 'https://open.weixin.qq.com/connect/qrconnect';
const QRCODE_IMAGE = 'https://open.weixin.qq.com/connect/qrcode';
const LONG_POLL_API = 'https://lp.open.weixin.qq.com/connect/l/qrconnect';

// 长轮询返回码语义（来自微信页面内联 JS 的 switch 分支）
const CODE_WAITING = 408; // 尚未扫码
const CODE_SCANNED = 404; // 已扫码，等待手机端确认
const CODE_CANCELLED = 403; // 用户在手机上取消
const CODE_EXPIRED = 402; // 二维码已失效，需重新生成
const CODE_SUCCESS = 405; // 确认成功，wx_code 有效

const QR_LIFETIME = 300 * 1000; // 单个二维码最长等待时间
const LOGIN_TIMEOUT = 600 * 1000; // 一次登录会话最长存活时间
const QR_READY_WAIT = 15 * 1000; // startLogin 等待二维码就绪的最长时间

/** 第 1 步：拿到百智云 OAuth 授权地址（其中含 MonkeyCode 生成的 state） */
async function beginAuthorize(http) {
  const res = await http.request(`${MONKEYCODE_BASE}/api/v1/users/login?redirect=&inviter_id=`, {
    headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
  });
  const location = res.headers.get('location');
  if (!location) throw new Error(`未获取到 OAuth 授权地址（HTTP ${res.status}）`);
  return location;
}

/** 第 2 步：用授权地址换取微信登录参数 */
async function getWechatParams(http, authorizeUrl) {
  const url = `${WECHAT_LOGIN_API}?${new URLSearchParams({
    type: 'web',
    redirect_url: authorizeUrl,
  })}`;
  const res = await http.request(url);
  const body = await res.json();
  if (body.code !== 0) throw new Error(`获取微信登录参数失败：${JSON.stringify(body)}`);
  return body.data; // { app_id, state, redirect_uri, scope }
}

/** 第 3、4 步：加载 qrconnect 页面取出 uuid，并下载二维码图片 */
async function fetchQr(http, params) {
  const url = `${QRCONNECT_PAGE}?${new URLSearchParams({
    appid: params.app_id,
    redirect_uri: params.redirect_uri,
    response_type: 'code',
    scope: params.scope,
    state: params.state,
    style: 'black',
  })}`;
  const res = await http.request(url, {
    headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
  });
  const html = await res.text();

  // uuid 在页面里形如：var U=...,G="091yrJo039Ohml28",
  const match =
    html.match(/,G="([A-Za-z0-9_-]{8,})"/) || html.match(/\/connect\/qrcode\/([A-Za-z0-9_-]{8,})/);
  if (!match) throw new Error('未能从微信登录页解析出 uuid');
  const qrUuid = match[1];

  const imgRes = await http.request(`${QRCODE_IMAGE}/${qrUuid}`);
  if (!imgRes.ok) throw new Error(`下载二维码失败（HTTP ${imgRes.status}）`);
  const image = Buffer.from(await imgRes.arrayBuffer());
  return { qrUuid, image };
}

/**
 * 第 5 步：长轮询一次扫码状态。
 * @param {string} last 上一次的 errcode，微信要求带上
 */
async function longPollOnce(http, qrUuid, last) {
  const query = { uuid: qrUuid };
  if (last) query.last = last;
  let text = '';
  try {
    const res = await http.request(`${LONG_POLL_API}?${new URLSearchParams(query)}`, {
      timeout: 40000,
      headers: { Accept: '*/*' },
    });
    text = await res.text();
  } catch (e) {
    // 长轮询超时属正常现象，按“仍在等待”处理
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return { errcode: CODE_WAITING, wxCode: '' };
    throw e;
  }
  const mCode = text.match(/wx_errcode\s*=\s*(\d+)/);
  const mValue = text.match(/wx_code\s*=\s*'([^']*)'/);
  return {
    errcode: mCode ? Number(mCode[1]) : CODE_WAITING,
    wxCode: mValue ? mValue[1] : '',
  };
}

/** 第 6~8 步：把微信 code 一路换成 monkeycode_ai_session */
async function exchangeCode(http, wxCode, wxState) {
  // 6) 微信回调：百智云在此写入自身登录态
  await http.request(
    `${WECHAT_CALLBACK_API}?${new URLSearchParams({ code: wxCode, state: wxState })}`
  );

  // 7) 调用授权接口换取 MonkeyCode 的临时 code
  const res = await http.request(
    `${BAIZHI_AUTHORIZE_API}?${new URLSearchParams({
      client_id: 'monkeycode-ai',
      redirect_uri: `${MONKEYCODE_BASE}/api/v1/users/baizhi/callback`,
      response_type: 'code',
      scope: 'user phone',
      state: wxState,
    })}`
  );
  const callbackUrl = res.headers.get('location');
  if (!callbackUrl || !callbackUrl.includes('code=')) {
    throw new Error(`未获取到授权 code（HTTP ${res.status}）`);
  }

  // 8) 回调 MonkeyCode：此处下发 monkeycode_ai_session
  await http.request(callbackUrl);

  const session = http.jar.get(SESSION_COOKIE_NAME);
  if (!session) throw new Error('回调完成但未拿到 monkeycode_ai_session');
  return session;
}

/** 用拿到的 Cookie 请求一次 users/status，确认登录态真实有效 */
async function verifySession(cookie) {
  return new MonkeyCodeClient(cookie).getUserStatus();
}

/**
 * 一次扫码登录的会话状态，供前端轮询。
 *
 * status 取值：
 *   starting  正在初始化
 *   waiting   二维码已就绪，等待扫码
 *   scanned   已扫码，等待手机确认
 *   cancelled 用户取消（仍在等待重新扫码）
 *   refreshed 二维码已过期并自动刷新
 *   confirmed 登录成功，cookie 已就绪
 *   error     出错，message 为原因
 */
class QrLoginSession {
  constructor(sid) {
    this.sid = sid;
    this.status = 'starting';
    this.message = '正在初始化 ...';
    this.qr = ''; // 二维码图片（data:image/jpeg;base64,...）
    this.cookie = ''; // 登录成功后的 session 值
    this.user = null;
    this.created = Date.now();
  }

  /** 返回给前端的状态快照（不含敏感字段） */
  snapshot() {
    return {
      sid: this.sid,
      status: this.status,
      message: this.message,
      qr: this.qr,
      done: this.status === 'confirmed',
    };
  }
}

/** 后台跑完整个扫码登录流程，并实时更新会话状态 */
async function runLogin(sess) {
  const http = new HttpClient();
  try {
    // 1~2) 拿到 OAuth 授权地址与微信登录参数
    const authorizeUrl = await beginAuthorize(http);
    const params = await getWechatParams(http, authorizeUrl);

    const deadline = sess.created + LOGIN_TIMEOUT;
    while (Date.now() < deadline) {
      // 3~4) 生成（或重新生成）二维码
      const { qrUuid, image } = await fetchQr(http, params);
      sess.qr = `data:image/jpeg;base64,${image.toString('base64')}`;
      sess.status = 'waiting';
      sess.message = '请用微信扫描二维码';

      // 5) 循环长轮询扫码状态
      let last = '';
      const qrDeadline = Date.now() + QR_LIFETIME;
      while (Date.now() < qrDeadline && Date.now() < deadline) {
        const { errcode, wxCode } = await longPollOnce(http, qrUuid, last);
        last = errcode ? String(errcode) : '';

        if (errcode === CODE_SUCCESS && wxCode) {
          // 6~8) 确认成功，换 session
          sess.message = '扫码成功，正在获取登录凭证 ...';
          sess.cookie = await exchangeCode(http, wxCode, params.state);
          try {
            sess.user = await verifySession(sess.cookie);
          } catch {
            sess.user = null; // 校验失败不影响已拿到的 cookie
          }
          sess.status = 'confirmed';
          sess.message = '登录成功';
          return;
        }

        if (errcode === CODE_SCANNED) {
          sess.status = 'scanned';
          sess.message = '已扫码，请在手机上点击确认';
        } else if (errcode === CODE_CANCELLED) {
          sess.status = 'cancelled';
          sess.message = '已取消，请重新扫码';
        } else if (errcode === CODE_EXPIRED) {
          // 二维码失效：跳出内层循环重新生成
          sess.status = 'refreshed';
          sess.message = '二维码已过期，正在刷新 ...';
          break;
        } else if (errcode === CODE_WAITING && !['scanned', 'cancelled'].includes(sess.status)) {
          sess.status = 'waiting';
          sess.message = '请用微信扫描二维码';
        }
        // 其余返回码（500 等）当作瞬时故障，继续轮询
      }

      if (sess.status !== 'refreshed') {
        // 内层循环超时结束，同样刷新二维码
        sess.status = 'refreshed';
        sess.message = '二维码已过期，正在刷新 ...';
      }
    }

    sess.status = 'error';
    sess.message = '登录超时，请重试';
  } catch (e) {
    sess.status = 'error';
    sess.message = `登录失败：${e.message}`;
  }
}

/**
 * 开启一次扫码登录。
 * 阻塞等待二维码就绪（最多 QR_READY_WAIT），让调用方拿到的会话直接带上二维码。
 * @returns {Promise<QrLoginSession>}
 */
async function startLogin() {
  const sid = require('node:crypto').randomUUID().replace(/-/g, '');
  const sess = new QrLoginSession(sid);

  runLogin(sess); // 后台执行，不阻塞

  const deadline = Date.now() + QR_READY_WAIT;
  while (Date.now() < deadline) {
    if (sess.qr || sess.status === 'error') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return sess;
}

module.exports = { QrLoginSession, startLogin, verifySession };