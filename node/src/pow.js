'use strict';

/**
 * Cap CAPTCHA 工作量证明（PoW）算法 —— Python 版 monkeycode_checkin.py 的 JS 移植。
 *
 * 逆向来源：
 *   - cap 前端包内的哈希函数 i(o,c)
 *   - WASM 导出的 solve_pow(salt, target)
 *
 * 该文件已用浏览器录制数据验证：对 token "056c284a3436fce2d4f212279"
 * 与配置 {c:50, s:32, d:3}，本实现算出的 50 个解与录制中的 solutions 完全一致。
 */

const crypto = require('node:crypto');

/**
 * Cap 的哈希函数：先做 32 位 FNV-1a，再以结果为种子跑 xorshift32，
 * 每轮输出 8 位十六进制并拼接，最后截断到指定长度。
 *
 * @param {string} input  待哈希字符串
 * @param {number} length 输出长度（十六进制字符数）
 * @returns {string}
 */
function capHash(input, length) {
  // ---- 1) 32 位 FNV-1a ----
  // 起始偏移量 2166136261；乘法 p *= 16777619 用移位加法实现：
  //   p += (p<<1)+(p<<4)+(p<<7)+(p<<8)+(p<<24)
  // 每项都是 int32，5 项相加最大约 1.3e10，未超出 2^53，故不会丢精度；
  // 结尾用 |0 截断为 int32，与 Python 版每轮开头的 to_int32 等价。
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h = (h ^ input.charCodeAt(i)) | 0;
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) | 0;
  }

  // ---- 2) 以 FNV 结果为种子的 xorshift32 ----
  let u = h >>> 0;
  let out = '';
  while (out.length < length) {
    u = (u ^ (u << 13)) | 0;
    u = (u ^ (u >>> 17)) | 0; // 第 2 步是无符号右移
    u = (u ^ (u << 5)) | 0;
    u = u >>> 0; // 转回无符号，保证 toString(16) 输出 8 位
    out += u.toString(16).padStart(8, '0');
  }
  return out.slice(0, length);
}

/** 每求解多少次让出一次事件循环，避免阻塞 HTTP 服务 */
const YIELD_EVERY = 2048;

/**
 * 暴力枚举 nonce，使 sha256(salt + nonce) 的十六进制以 target 为前缀。
 *
 * @param {string} salt       由 capHash 派生的盐
 * @param {string} targetHex  目标十六进制前缀
 * @returns {Promise<number>} 命中的 nonce
 */
async function solvePow(salt, targetHex) {
  for (let nonce = 0; ; nonce++) {
    const digest = crypto.createHash('sha256').update(salt + nonce).digest('hex');
    if (digest.startsWith(targetHex)) return nonce;
    // 用 setImmediate 周期性让出事件循环：单个挑战通常几百次内命中，
    // 让出频率极低，但可避免极端情况下卡住扫码长轮询。
    if ((nonce & (YIELD_EVERY - 1)) === YIELD_EVERY - 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
}

/**
 * 求解一整组挑战。
 *
 * 第 b 个（b 从 1 开始）子挑战：
 *   salt   = capHash(token + b,   size)
 *   target = capHash(token + b + 'd', difficulty)
 *
 * @param {string} token      captcha challenge 返回的 token
 * @param {number} count      子挑战数量（c）
 * @param {number} size       salt 长度（s）
 * @param {number} difficulty target 长度（d）
 * @returns {Promise<number[]>}
 */
async function solveChallenges(token, count, size, difficulty) {
  const solutions = [];
  for (let b = 1; b <= count; b++) {
    const salt = capHash(`${token}${b}`, size);
    const target = capHash(`${token}${b}d`, difficulty);
    solutions.push(await solvePow(salt, target));
  }
  return solutions;
}

module.exports = { capHash, solvePow, solveChallenges };