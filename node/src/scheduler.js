'use strict';

/**
 * 进程内定时签到调度器（零依赖）。
 *
 * 读取 store 中的 schedule（{ enabled, time: "HH:MM" }），
 * 计算下一次触发时间并 setTimeout；触发后执行注册的 runner（对所有账号签到），
 * 再自动排下一天。修改配置后调用 reload() 立即重排。
 *
 * 说明：进程退出（重启）后定时器会丢失，但服务启动时会重新 init()，
 * 因此只要服务在跑，定时就会生效。install.sh 写入的 cron 作为兜底。
 */

const store = require('./store.js');

let timer = null;
let nextRun = null; // Date
let runner = null;

/** 计算下一次 HH:MM 触发时间（今天或明天） */
function computeNext(time) {
  const [h, m] = String(time).split(':').map(Number);
  const next = new Date();
  next.setHours(h, m, 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
  return next;
}

/** 清除现有定时器 */
function clearTimer() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/** 依据当前配置重新排期 */
function schedule() {
  clearTimer();
  nextRun = null;
  const s = store.getSchedule();
  if (!s.enabled || !runner) return;

  nextRun = computeNext(s.time);
  // setTimeout 上限约 24.8 天，这里最长 24 小时，安全
  const delay = Math.max(0, nextRun.getTime() - Date.now());
  timer = setTimeout(async () => {
    try {
      await runner();
    } catch (e) {
      console.error(`[scheduler] 定时签到执行失败：${e.message}`);
    }
    schedule(); // 排下一天
  }, delay);
  // 允许进程在仅剩定时器时也能退出（便于测试/优雅关闭）
  if (timer.unref) timer.unref();
}

/** 注册执行函数并启动调度 */
function init(fn) {
  runner = fn;
  schedule();
}

/** 配置变更后重排 */
function reload() {
  schedule();
}

/** 下一次触发时间（ISO 字符串），未启用时为 null */
function getNextRun() {
  return nextRun ? nextRun.toISOString() : null;
}

module.exports = { init, reload, getNextRun, computeNext };
