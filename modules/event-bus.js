// ========================================
// 文件：modules/event-bus.js
// 功能：事件总线——模块解耦的发布订阅中心，带通配符、失败隔离、环形历史与 GUI 转发槽
// 依赖：./logger（可选，缺失时静默）；无第三方库
// 导出：on / once / off / emit / emitAsync / names / listenerCount / history / stats / clear / setSink / reset
// 作者：MineBots
// ========================================
//
// 设计要点 / design notes
//   1. 纯 JS 实现，不依赖 EventEmitter，加载永不失败。
//   2. 单个订阅者抛错只记日志，绝不影响其它订阅者，也绝不冒到调用方。
//   3. 事件名支持一级通配符："trace.*" 能收到 "trace.span"。
//   4. history 是环形缓冲，供 GUI 与 test-runner 查询，不会无限增长。
// CommonJS，ES5 风格，无中文变量名

// 可选依赖：日志核心，缺失时所有日志静默丢弃，绝不抛错。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：单事件最多订阅者 / 历史缓冲上限 / 单次 emit 最多派发次数。
var MAX_LISTENERS = 50;
var MAX_HISTORY = 120;
var MAX_DISPATCH = 500;

// 状态：事件名到订阅者数组的映射；history 为环形快照；sink 为 GUI 转发槽。
var channels = {};
var historyBuf = [];
var sink = null;
var seq = 0;

// 写信息日志：只落文件不推 GUI（事件总线属于高频链路，禁止刷屏）。
function logInfo(message) {
  try { if (logger && typeof logger.info === "function") logger.info("[event-bus] " + message); } catch (e) { /* ignore */ }
}

// 写警告日志：订阅者异常属重要信息，推 GUI 让用户看得见。
function logWarn(message) {
  try {
    if (logger && typeof logger.warn === "function") { logger.warn("[event-bus] " + message); return; }
  } catch (e) { /* 退回 console */ }
  try { console.warn("[event-bus] " + message); } catch (e2) { /* ignore */ }
}

// 把异常拍成一行文本，避免在 catch 里再次抛错。
function errText(err) {
  try {
    if (!err) return "unknown error";
    if (err.message) return String(err.message);
    return String(err);
  } catch (e) { return "unknown error"; }
}

// 洗事件名：去空白、截断，非法返回空串。
function cleanName(name) {
  try {
    var text = String(name === null || name === undefined ? "" : name).replace(/^\s+|\s+$/g, "");
    if (text.length === 0) return "";
    if (text.length > 80) text = text.slice(0, 80);
    return text;
  } catch (e) { return ""; }
}

// 判断订阅规则是否命中事件名：完全相等，或以 "prefix.*" 形式命中一级前缀。
function matches(rule, name) {
  try {
    if (rule === name) return true;
    if (rule.charAt(rule.length - 2) === "." && rule.charAt(rule.length - 1) === "*") {
      var prefix = rule.slice(0, rule.length - 1);
      return name.indexOf(prefix) === 0;
    }
    return false;
  } catch (e) { return false; }
}

// 把一条事件写进环形历史，超过上限丢最旧的；返回记录条数。
function record(name, payload) {
  seq = seq + 1;
  try {
    historyBuf.push({ seq: seq, name: name, at: Date.now(), payload: payload });
    while (historyBuf.length > MAX_HISTORY) historyBuf.shift();
  } catch (e) { /* 历史写不进不影响派发 */ }
  return historyBuf.length;
}

// 把事件转给 GUI 槽：槽函数异常只记日志，绝不回流到业务链路。
function forward(entry) {
  if (!sink) return false;
  try { sink({ seq: entry.seq, name: entry.name, at: entry.at, payload: entry.payload }); return true; }
  catch (e) { logWarn("GUI 转发失败 / sink failed: " + errText(e)); return false; }
}

// 功能：订阅事件，返回取消订阅函数；参数非法返回 null。
function on(name, handler) {
  var key = cleanName(name);
  if (key.length === 0 || typeof handler !== "function") return null;
  try {
    if (!channels[key]) channels[key] = [];
    if (channels[key].length >= MAX_LISTENERS) {
      logWarn("订阅数达上限 / listener limit: " + key);
      return null;
    }
    var item = { fn: handler, once: false, id: seq + 1 };
    channels[key].push(item);
    return function unsubscribe() {
      off(key, handler);
      return true;
    };
  } catch (e) { return null; }
}

// 功能：只订阅一次，触发后自动摘除；参数非法返回 null。
function once(name, handler) {
  var key = cleanName(name);
  if (key.length === 0 || typeof handler !== "function") return null;
  try {
    if (!channels[key]) channels[key] = [];
    if (channels[key].length >= MAX_LISTENERS) return null;
    channels[key].push({ fn: handler, once: true, id: seq + 1 });
    return function unsubscribe() { off(key, handler); return true; };
  } catch (e) { return null; }
}

// 功能：退订；不传 handler 时清掉整个频道，返回 { ok, removed, message }。
function off(name, handler) {
  var key = cleanName(name);
  if (key.length === 0) return { ok: false, removed: 0, message: "event name required / 事件名不能为空" };
  try {
    var list = channels[key];
    if (!list || list.length === 0) return { ok: true, removed: 0, message: "empty / 频道为空" };
    if (typeof handler !== "function") {
      var all = list.length;
      delete channels[key];
      return { ok: true, removed: all, message: "channel cleared / 频道已清空" };
    }
    var kept = [];
    var removed = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].fn === handler) removed = removed + 1;
      else kept.push(list[i]);
    }
    if (kept.length === 0) delete channels[key];
    else channels[key] = kept;
    return { ok: true, removed: removed, message: "unsubscribed / 已退订" };
  } catch (e) { return { ok: false, removed: 0, message: errText(e) }; }
}

// 内部：收集命中某事件名的订阅者快照，并摘掉 once 订阅者；返回订阅者数组。
function collect(name) {
  var out = [];
  try {
    for (var key in channels) {
      if (!Object.prototype.hasOwnProperty.call(channels, key)) continue;
      if (!matches(key, name)) continue;
      var list = channels[key];
      var kept = [];
      for (var i = 0; i < list.length; i++) {
        out.push(list[i]);
        if (!list[i].once) kept.push(list[i]);
      }
      if (kept.length === 0) delete channels[key];
      else channels[key] = kept;
      if (out.length >= MAX_DISPATCH) break;
    }
  } catch (e) { /* 返回已收集到的部分 */ }
  return out;
}

// 功能：同步派发事件，返回 { ok, delivered, failed, message }；单个订阅者报错被隔离。
function emit(name, payload) {
  var key = cleanName(name);
  if (key.length === 0) return { ok: false, delivered: 0, failed: 0, message: "event name required / 事件名不能为空" };
  var entry = { seq: seq + 1, name: key, at: Date.now(), payload: payload };
  try {
    record(key, payload);
    var list = collect(key);
    var delivered = 0;
    var failed = 0;
    for (var i = 0; i < list.length; i++) {
      try { list[i].fn(payload, key, entry); delivered = delivered + 1; }
      catch (e) { failed = failed + 1; logWarn("订阅者异常 / handler failed [" + key + "]: " + errText(e)); }
    }
    forward({ seq: seq, name: key, at: entry.at, payload: payload });
    logInfo("emit " + key + " delivered=" + delivered + " failed=" + failed);
    return { ok: true, delivered: delivered, failed: failed, message: "emitted / 已派发" };
  } catch (e) {
    return { ok: false, delivered: 0, failed: 1, message: errText(e) };
  }
}

// 功能：异步串行派发（链路追踪用），返回 { ok, delivered, failed, message }。
async function emitAsync(name, payload) {
  var key = cleanName(name);
  if (key.length === 0) return { ok: false, delivered: 0, failed: 0, message: "event name required / 事件名不能为空" };
  var delivered = 0;
  var failed = 0;
  try {
    record(key, payload);
    var list = collect(key);
    for (var i = 0; i < list.length; i++) {
      try { await list[i].fn(payload, key); delivered = delivered + 1; }
      catch (e) { failed = failed + 1; logWarn("异步订阅者异常 / async handler failed [" + key + "]: " + errText(e)); }
    }
    forward({ seq: seq, name: key, at: Date.now(), payload: payload });
    return { ok: true, delivered: delivered, failed: failed, message: "async emitted / 异步派发完成" };
  } catch (e) {
    return { ok: false, delivered: delivered, failed: failed + 1, message: errText(e) };
  }
}

// 功能：列出当前有订阅者的频道名副本。
function names() {
  var out = [];
  try { for (var key in channels) { if (Object.prototype.hasOwnProperty.call(channels, key)) out.push(key); } }
  catch (e) { out = []; }
  return out;
}

// 功能：查某事件名的订阅者数量，异常返回 0。
function listenerCount(name) {
  var key = cleanName(name);
  try {
    var n = 0;
    for (var rule in channels) {
      if (!Object.prototype.hasOwnProperty.call(channels, rule)) continue;
      if (matches(rule, key)) n = n + channels[rule].length;
    }
    return n;
  } catch (e) { return 0; }
}

// 功能：取事件历史快照副本，limit 缺省返回全部；异常返回空数组。
function history(limit) {
  var out = [];
  try {
    var n = Number(limit);
    var start = 0;
    if (!isNaN(n) && n > 0 && n < historyBuf.length) start = historyBuf.length - Math.floor(n);
    for (var i = start; i < historyBuf.length; i++) out.push(historyBuf[i]);
  } catch (e) { out = []; }
  return out;
}

// 功能：读总线统计 { channels, listeners, historySize, emitted, sink }。
function stats() {
  var total = 0;
  try {
    for (var key in channels) { if (Object.prototype.hasOwnProperty.call(channels, key)) total = total + channels[key].length; }
  } catch (e) { total = 0; }
  return { channels: names().length, listeners: total, historySize: historyBuf.length, emitted: seq, sink: !!sink };
}

// 功能：清空频道或全部；不传名字清全部（含历史），返回 { ok, count }。
function clear(name) {
  var count = names().length;
  try {
    if (name === undefined || name === null) { channels = {}; historyBuf = []; return { ok: true, count: count }; }
    var res = off(name);
    return { ok: res.ok, count: res.removed };
  } catch (e) { return { ok: false, count: 0 }; }
}

// 功能：设置 GUI 转发槽（传 null 取消），返回 { ok, message }。
function setSink(fn) {
  if (fn !== null && typeof fn !== "function") return { ok: false, message: "sink must be a function / 转发槽必须是函数" };
  sink = fn;
  return { ok: true, message: "sink updated / 转发槽已更新" };
}

// 功能：完全重置（自测隔离用），返回 true。
function reset() {
  try { channels = {}; historyBuf = []; sink = null; seq = 0; return true; }
  catch (e) { return false; }
}

// 对外导出：订阅 / 派发 / 查询 / 转发 / 重置。
module.exports = {
  on: on,
  once: once,
  off: off,
  emit: emit,
  emitAsync: emitAsync,
  names: names,
  listenerCount: listenerCount,
  history: history,
  stats: stats,
  clear: clear,
  setSink: setSink,
  reset: reset,
  MAX_LISTENERS: MAX_LISTENERS,
  MAX_HISTORY: MAX_HISTORY
};
