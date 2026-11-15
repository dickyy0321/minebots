// ========================================
// 文件：modules/context-stack.js
// 功能：上下文栈——按 bot 冻结与恢复任务进度；受击打断压栈、战斗结束出栈自动续跑，支持多级打断
// 依赖：./event-bus（可选）、./logger（可选）
// 导出：push / freeze / pop / peek / depth / status / clear / clearAll / snapshot / MAX_DEPTH
// 作者：MineBots
// ========================================
//
// 三层状态流转 / three-layer state flow
//   战略层 strategic：只给宏观目标（去砍树 / get wood），由主状态机拆解
//   战术层 tactical ：行为树 sequence / selector / parallel 执行具体动作
//   反射层 reflex   ：受击时高优先级打断，把当前战术上下文整帧冻结压栈
// 栈帧 / frame：{ goal, task, progress, blackboard, done, lastPath, frozenAt, reason, seq }
// ES5 风格，CommonJS，无中文变量名；所有对外函数一律返回带 ok 的对象。
var bus = null;
try { bus = require("./event-bus"); } catch (e) { bus = null; }

var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：单 bot 最大栈深（超过丢弃最底层旧帧，防止无限打断吃内存）。
var MAX_DEPTH = 8;

// 状态：botId → 栈帧数组；计数用于自测与蜂群监控。
var stacks = {};
var counters = { pushes: 0, pops: 0, freezes: 0, restores: 0 };

// 写文件日志：栈操作属高频信息，只落文件，绝不刷 GUI。
function logInfo(msg) {
  try { if (logger && typeof logger.info === "function") logger.info("[context-stack] " + msg); } catch (e) { /* ignore */ }
}

// 写系统日志：打断与恢复是低频事件，推 GUI 让用户看得到。
function logSystem(msg) {
  try {
    if (logger && typeof logger.system === "function") { logger.system("[context-stack] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[context-stack] " + msg); } catch (e2) { /* ignore */ }
}

// 广播栈事件：总线缺失或回调报错都不影响主流程。
function emit(name, payload) {
  try { if (bus && typeof bus.emit === "function") bus.emit(name, payload); } catch (e) { /* ignore */ }
}

// 规范化 botId，坏值退回 default。
function idOf(botId) {
  try {
    var text = String(botId === null || botId === undefined ? "" : botId).replace(/^\s+|\s+$/g, "");
    return text.length === 0 ? "default" : text.slice(0, 80);
  } catch (e) { return "default"; }
}

// 深拷贝纯数据；循环引用之类坏值返回空对象，绝不抛错。
function clone(value) {
  try {
    var out = JSON.parse(JSON.stringify(value === undefined ? null : value));
    return out && typeof out === "object" ? out : {};
  } catch (e) { return {}; }
}

// 功能：压入一帧上下文；返回 { ok, botId, depth, frame }，坏入参也压一条空帧保证链路不崩。
function push(botId, frame, reason) {
  var id = idOf(botId);
  try {
    if (!stacks[id]) stacks[id] = [];
    var copy = clone(frame);
    counters.pushes = counters.pushes + 1;
    copy.seq = counters.pushes;
    copy.frozenAt = Date.now();
    copy.reason = String(reason === null || reason === undefined ? "interrupt / 外部打断" : reason);
    stacks[id].push(copy);
    while (stacks[id].length > MAX_DEPTH) stacks[id].shift();
    emit("stack.push", { botId: id, depth: stacks[id].length, reason: copy.reason });
    logSystem("上下文已冻结 / context frozen: " + id + " depth=" + stacks[id].length + " reason=" + copy.reason);
    return { ok: true, botId: id, depth: stacks[id].length, frame: clone(copy), message: "context frozen / 上下文已冻结" };
  } catch (e) {
    return { ok: false, botId: id, depth: 0, frame: null, message: String(e && e.message ? e.message : e) };
  }
}

// 功能：冻结一次任务进度（push 的语义封装）；返回与 push 相同结构。
function freeze(botId, task, progress, reason) {
  counters.freezes = counters.freezes + 1;
  var body = task && typeof task === "object" ? clone(task) : { task: String(task || "") };
  body.progress = clone(progress);
  logInfo("冻结进度 / freezing progress: " + idOf(botId));
  return push(botId, body, reason);
}

// 功能：出栈并交还上一帧上下文；空栈返回 ok:false 且 frame 为 null。
function pop(botId) {
  var id = idOf(botId);
  try {
    var list = stacks[id] || [];
    if (list.length === 0) {
      return { ok: false, botId: id, frame: null, depth: 0, restored: false, message: "stack empty / 栈为空" };
    }
    var frame = list.pop();
    counters.pops = counters.pops + 1;
    counters.restores = counters.restores + 1;
    emit("stack.pop", { botId: id, depth: list.length, seq: frame.seq });
    logSystem("上下文已出栈 / context restored: " + id + " depth=" + list.length);
    return { ok: true, botId: id, frame: clone(frame), depth: list.length, restored: true, message: "context restored / 上下文已恢复" };
  } catch (e) {
    return { ok: false, botId: id, frame: null, depth: 0, restored: false, message: String(e && e.message ? e.message : e) };
  }
}

// 功能：只看栈顶不弹出；空栈返回 null。
function peek(botId) {
  var id = idOf(botId);
  try {
    var list = stacks[id] || [];
    return list.length === 0 ? null : clone(list[list.length - 1]);
  } catch (e) { return null; }
}

// 功能：读某个 bot 的栈深；异常返回 0。
function depth(botId) {
  try { return (stacks[idOf(botId)] || []).length; } catch (e) { return 0; }
}

// 功能：读某个 bot 的栈状态快照，供状态机与蜂群面板展示。
function status(botId) {
  var id = idOf(botId);
  var out = { ok: true, botId: id, depth: 0, top: null, pushes: counters.pushes, pops: counters.pops, freezes: counters.freezes, restores: counters.restores };
  try {
    out.depth = depth(id);
    out.top = peek(id);
  } catch (e) { /* 返回已填好的部分 */ }
  return out;
}

// 功能：清空某个 bot 的栈，返回被丢弃的帧数。
function clear(botId) {
  var id = idOf(botId);
  var n = depth(id);
  try { stacks[id] = []; } catch (e) { /* ignore */ }
  return { ok: true, botId: id, cleared: n, message: "stack cleared / 上下文栈已清空" };
}

// 功能：清空所有 bot 的栈与计数（自测隔离用）。
function clearAll() {
  try {
    stacks = {};
    counters = { pushes: 0, pops: 0, freezes: 0, restores: 0 };
  } catch (e) { /* ignore */ }
  return { ok: true, message: "all stacks cleared / 全部上下文已清空" };
}

// 功能：全量快照（botId → 帧数组副本），异常返回空对象。
function snapshot() {
  var out = {};
  try {
    for (var key in stacks) {
      if (!Object.prototype.hasOwnProperty.call(stacks, key)) continue;
      out[key] = clone(stacks[key]);
    }
  } catch (e) { return {}; }
  return out;
}

// 对外导出：压栈 / 冻结 / 出栈 / 查询 / 清理。
module.exports = {
  push: push,
  freeze: freeze,
  pop: pop,
  peek: peek,
  depth: depth,
  status: status,
  clear: clear,
  clearAll: clearAll,
  snapshot: snapshot,
  MAX_DEPTH: MAX_DEPTH
};
