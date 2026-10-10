'use strict';

/**
 * MonkeyCode 签到客户端 —— Python 版 monkeycode_checkin.py 的 JS 移植。
 *
 * 签到流程（逆向自浏览器录制文件）：
 *   1. GET  /api/v1/users/status            校验登录态
 *   2. GET  /api/v1/users/wallet/checkin    查询今日是否已签到
 *   3. POST /api/v1/public/captcha/challenge 获取人机验证挑战
 *   4. 本地求解 50 个 SHA-256 PoW
 *   5. POST /api/v1/public/captcha/redeem   用解换 captcha_token
 *   6. POST /api/v1/users/wallet/checkin    携带 captcha_token 完成签到
 *   7. GET  /api/v1/users/wallet            查询余额
 */

const { HttpClient } = require('./http.js');
const { solveChallenges } = require('./pow.js');

const BASE_URL = 'https://monkeycode-ai.com';
const SESSION_COOKIE_NAME = 'monkeycode_ai_session';

/**
 * 规范化 Cookie：若传入的是裸 session 值（不含 "="），自动补上 Cookie 名。
 * @param {string} value
 * @returns {string}
 */
function normalizeCookie(value) {
  const v = (value || '').trim();
  if (!v) return '';
  return v.includes('=') ? v : `${SESSION_COOKIE_NAME}=${v}`;
}

class MonkeyCodeClient {
  /**
   * @param {string} cookie 完整 Cookie 串或裸 session 值
   */
  constructor(cookie) {
    this.cookie = normalizeCookie(cookie);
    this.http = new HttpClient();
  }

  /** 统一的请求头（含 Cookie 与防盗链信息） */
  _headers(extra = {}) {
    return {
      Accept: 'application/json, text/plain, */*',
      Origin: BASE_URL,
      Referer: `${BASE_URL}/`,
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Cookie: this.cookie,
      ...extra,
    };
  }

  /** 1) 校验登录态，返回用户信息 */
  async getUserStatus() {
    const res = await this.http.request(`${BASE_URL}/api/v1/users/status`, {
      headers: this._headers(),
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`登录态无效（HTTP ${res.status}），Cookie 可能已失效`);
    }
    const body = await res.json();
    if (body.code !== 0) {
      throw new Error(`获取用户信息失败：${body.message || JSON.stringify(body)}`);
    }
    return body.data?.user ?? {};
  }

  /** 2) 查询今日签到状态，返回 { checked_in } */
  async getCheckinStatus() {
    const body = await this.http.getJson(`${BASE_URL}/api/v1/users/wallet/checkin`, {
      headers: this._headers(),
    });
    if (body.code !== 0) {
      throw new Error(`查询签到状态失败：${body.message || JSON.stringify(body)}`);
    }
    return body.data ?? {};
  }

  /** 3) 获取人机验证挑战，返回 { challenge: {c,s,d}, token, expires } */
  async createCaptchaChallenge() {
    const body = await this.http.postJson(
      `${BASE_URL}/api/v1/public/captcha/challenge`,
      {},
      { headers: this._headers() }
    );
    if (!body.token || !body.challenge) {
      throw new Error(`获取验证挑战失败：${JSON.stringify(body)}`);
    }
    return body;
  }

  /** 5) 提交解答换取 captcha_token */
  async redeemCaptcha(token, solutions) {
    const body = await this.http.postJson(
      `${BASE_URL}/api/v1/public/captcha/redeem`,
      { token, solutions },
      { headers: this._headers() }
    );
    if (!body.success || !body.token) {
      throw new Error(`验证挑战失败：${JSON.stringify(body)}`);
    }
    return body.token;
  }

  /** 6) 提交签到 */
  async doCheckin(captchaToken) {
    const body = await this.http.postJson(
      `${BASE_URL}/api/v1/users/wallet/checkin`,
      { captcha_token: captchaToken },
      { headers: this._headers() }
    );
    if (body.code !== 0) {
      throw new Error(`签到失败：${body.message || JSON.stringify(body)}`);
    }
    return Boolean(body.data?.checked_in);
  }

  /** 7) 查询钱包余额 */
  async getWallet() {
    const body = await this.http.getJson(`${BASE_URL}/api/v1/users/wallet`, {
      headers: this._headers(),
    });
    if (body.code !== 0) {
      throw new Error(`查询余额失败：${body.message || JSON.stringify(body)}`);
    }
    return body.data ?? {};
  }

  /**
   * 完整签到流程，返回
   * { ok, already, checkedIn, balance, balanceBefore, balanceAfter, earned, captchaToken, user }。
   *
   * @param {(msg: string, level?: string) => void} [log] 日志回调
   */
  async checkin(log = () => {}) {
    // 1) 校验登录态
    const user = await this.getUserStatus();
    log(`登录态有效，用户：${user.name || user.email || user.id || '未知'}`, 'ok');

    // 2) 是否已签到
    const status = await this.getCheckinStatus();
    if (status.checked_in) {
      log('今日已签到，无需重复操作', 'ok');
      const wallet = await this.getWallet();
      return {
        ok: true,
        already: true,
        checkedIn: true,
        balance: wallet.balance,
        balanceBefore: wallet.balance,
        balanceAfter: wallet.balance,
        earned: 0,
        user,
      };
    }

    // 3) 记录打卡前积分
    let balanceBefore;
    try {
      balanceBefore = (await this.getWallet()).balance;
      log(`打卡前余额：${balanceBefore}`, 'info');
    } catch {
      /* 余额查询失败不影响签到结果 */
    }

    // 4) 取验证挑战
    const challenge = await this.createCaptchaChallenge();
    const { c, s, d } = challenge.challenge;
    log(`已获取验证挑战：${c} 个子任务 / salt ${s} 位 / 难度 ${d}`, 'info');

    // 5) 本地求解 PoW
    const t0 = Date.now();
    const solutions = await solveChallenges(challenge.token, c, s, d);
    log(`人机验证已破解（${c} 个解，耗时 ${Date.now() - t0} ms）`, 'ok');

    // 6) 换取 captcha_token
    const captchaToken = await this.redeemCaptcha(challenge.token, solutions);
    log(`验证通过，captcha_token=${captchaToken}`, 'ok');

    // 7) 签到
    const checkedIn = await this.doCheckin(captchaToken);
    if (!checkedIn) {
      log('签到未成功（服务端返回 checked_in=false）', 'error');
      return { ok: false, already: false, checkedIn: false, balanceBefore };
    }

    // 8) 记录打卡后积分
    let balanceAfter;
    try {
      balanceAfter = (await this.getWallet()).balance;
    } catch {
      /* 余额查询失败不影响签到结果 */
    }
    const earned =
      typeof balanceBefore === 'number' && typeof balanceAfter === 'number'
        ? balanceAfter - balanceBefore
        : undefined;
    const extra = typeof earned === 'number' ? `（本次获得 ${earned} 积分）` : '';
    log(`签到成功！当前余额：${balanceAfter}${extra}`, 'ok');
    return {
      ok: true,
      already: false,
      checkedIn: true,
      balance: balanceAfter,
      balanceBefore,
      balanceAfter,
      earned,
      captchaToken,
      user,
    };
  }
}

module.exports = { MonkeyCodeClient, normalizeCookie, SESSION_COOKIE_NAME, BASE_URL };