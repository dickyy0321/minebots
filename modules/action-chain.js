// ========================================
// 文件：modules/action-chain.js
// 功能：动作串行链——默认一个接一个跑，新指令最多等 QUEUE_ESCAPE_MS 就强行插队（挂死的老任务不许饿死新指令）
// 依赖：无（纯 Promise + 定时器，定时器一律 unref）
// 导出：enqueue / waitOrEscape / QUEUE_ESCAPE_MS / reset
// 作者：MineBots
// ========================================
//
// 为什么要有「插队」：
//   bot.dig / bot.placeBlock 这类 Promise 在方块挖不动、区块丢了时会永远不 resolve。
//   老实现是「严格串行」，于是一条挂死的任务就能让 stop / 砍树 / 跟随全部排队饿死，
//   玩家看到的现象就是「让它跟随，然后盯着地面死锁，之后任何指令都没反应」。
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

// 常量：新指令最多等旧任务多少毫秒——等不到就直接插队开跑（旧任务变孤儿，但绝不拖住新指令）。
var QUEUE_ESCAPE_MS = 250;

// 全局串行链：下一个任务挂在它后面。
var queueChain = null;

// 等 prev 最多 ms 毫秒：先结束就立即返回 "settled"，超时也返回 "escaped"（调用方只看「有没有等太久」）。
function waitOrEscape(prev, ms) {
  return new Promise(function (resolve) {
    var done = false, timer = null;
    var close = function (reason) {
      if (done) return;
      done = true;
      try { if (timer) clearTimeout(timer); } catch (e1) { /* ignore */ }
      resolve(reason);
    };
    try {
      timer = setTimeout(function () { close("escaped"); }, Math.max(0, Math.round(Number(ms) || 0)));
      if (timer && timer.unref) timer.unref();
    } catch (e2) { timer = null; }
    try { Promise.resolve(prev).then(function () { close("settled"); }, function () { close("settled"); }); }
    catch (e3) { close("settled"); }
  });
}

// 把任务排进串行链：escapeMs 是数字时最多等这么久，等不到就强行插队；否则严格排队。
function enqueue(task, escapeMs) {
  var run = function () { return Promise.resolve().then(task); };
  var escape = Number(escapeMs);
  var next = null;
  if (!queueChain) next = run();
  else if (!isNaN(escape)) next = waitOrEscape(queueChain, escape).then(run, run);
  else next = queueChain.then(run, run);
  // 链本身永不断：无论成功失败都换成 null 继续。
  queueChain = next.then(function () { return null; }, function () { return null; });
  return next;
}

// 清空串行链（重连 / 自测隔离用）：只是把指针置空，已经跑起来的任务不受影响。
function reset() {
  queueChain = null;
  return true;
}

// 对外导出：入队 / 等待器 / 插队阈值 / 重置。
module.exports = {
  enqueue: enqueue,
  waitOrEscape: waitOrEscape,
  reset: reset,
  QUEUE_ESCAPE_MS: QUEUE_ESCAPE_MS
};
