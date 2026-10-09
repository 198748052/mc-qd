'use strict';

/**
 * 极简 HTTP 层：Cookie 容器 + 可读 Location 的请求封装。
 *
 * Node 原生 fetch 不会自动保存 / 回传 Cookie，而微信扫码登录与 OAuth 回调
 * 全靠 Cookie 把各个步骤串起来，因此这里实现一个按域名隔离的 cookie jar。
 * 全部基于内置能力（fetch / AbortSignal），无需任何第三方依赖。
 */

/** 与浏览器一致的默认请求头 */
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/134.0.6998.205 Safari/537.36';

/**
 * 按域名隔离的 Cookie 容器。
 */
class CookieJar {
  constructor() {
    /** @type {Map<string, Map<string, string>>} 域名 -> (Cookie 名 -> 值) */
    this.store = new Map();
  }

  /**
   * 从响应中吸收 Set-Cookie。
   * @param {string} url 本次请求地址
   * @param {Response} res
   */
  absorb(url, res) {
    if (typeof res.headers.getSetCookie !== 'function') return;
    const host = new URL(url).hostname;
    for (const raw of res.headers.getSetCookie()) {
      const pair = raw.split(';')[0];
      const idx = pair.indexOf('=');
      if (idx < 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (!name) continue;

      if (!this.store.has(host)) this.store.set(host, new Map());
      const jar = this.store.get(host);
      // 值为空或 Max-Age=0 视为删除
      if (value === '' || /max-age=0/i.test(raw)) jar.delete(name);
      else jar.set(name, value);
    }
  }

  /**
   * 生成应发给该地址的 Cookie 请求头（含父域匹配）。
   * @param {string} url
   * @returns {string}
   */
  header(url) {
    const host = new URL(url).hostname;
    const parts = [];
    for (const [domain, jar] of this.store) {
      // 域名完全相同，或当前域名是 cookie 域名的子域
      if (host === domain || host.endsWith('.' + domain)) {
        for (const [name, value] of jar) parts.push(`${name}=${value}`);
      }
    }
    return parts.join('; ');
  }

  /**
   * 跨域查找某个 Cookie 的值（用于最后取 monkeycode_ai_session）。
   * @param {string} name
   * @returns {string}
   */
  get(name) {
    for (const jar of this.store.values()) {
      if (jar.has(name)) return jar.get(name);
    }
    return '';
  }
}

/**
 * 带 Cookie 容器与默认请求头的 HTTP 客户端。
 */
class HttpClient {
  constructor() {
    this.jar = new CookieJar();
  }

  /**
   * 发起请求。默认不自动跟随重定向，以便读取 Location 头。
   *
   * @param {string} url
   * @param {object} [opts]
   * @param {string} [opts.method]
   * @param {object} [opts.headers]
   * @param {string} [opts.body]
   * @param {number} [opts.timeout] 毫秒
   * @returns {Promise<Response>}
   */
  async request(url, opts = {}) {
    const { method = 'GET', headers = {}, body, timeout = 20000 } = opts;

    const finalHeaders = {
      'User-Agent': DEFAULT_UA,
      Accept: '*/*',
      'sec-ch-ua': '"Not:A-Brand";v="24", "Chromium";v="134"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      ...headers,
    };

    // 调用方未显式指定 Cookie 时，从容器里取
    if (!finalHeaders.Cookie) {
      const cookie = this.jar.header(url);
      if (cookie) finalHeaders.Cookie = cookie;
    }

    const res = await fetch(url, {
      method,
      headers: finalHeaders,
      body,
      redirect: 'manual', // 手动处理重定向，方便读取 Location
      signal: AbortSignal.timeout(timeout),
    });

    this.jar.absorb(url, res);
    return res;
  }

  /** GET，自动解析 JSON */
  async getJson(url, opts) {
    const res = await this.request(url, { ...opts, method: 'GET' });
    return res.json();
  }

  /** POST JSON */
  async postJson(url, payload, opts) {
    const res = await this.request(url, {
      ...opts,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(opts?.headers || {}) },
      body: JSON.stringify(payload ?? {}),
    });
    return res.json();
  }
}

module.exports = { HttpClient, CookieJar, DEFAULT_UA };