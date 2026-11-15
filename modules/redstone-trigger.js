// ========================================
// 文件：modules/redstone-trigger.js
// 功能：零延迟高频红石触发器——漂移补偿的 setTimeout 循环、触发前 blockAt 状态预检、
//       bot.activateBlock 真实触发、共享黑板挂起多个触发器实现多 bot 协同
// 依赖：./engine-control（可选）、./exact-placement（可选）、./shared-board（可选）、
//       ./event-bus（可选）、./logger（可选）、./actions（可选）
// 导出：registerBot / startTriggerLoop / stopTriggerLoop / stopAll / tick / list / stats / reset
// 作者：MineBots
// ========================================
//
// 设计 / design
//   1. startTriggerLoop(botId, pos, action, intervalMs)：intervalMs 省略时读 redstoneTickRate（默认 50ms）。
//   2. 不用裸 setInterval：每次按「起始时间 + 已触发次数 × 间隔」算下一拍，补偿事件循环抖动，
//      保证长时间运行不累积漂移；定时器一律 unref()，绝不拖住进程退出。
//   3. 每次触发前 bot.blockAt(pos) 预检（服务器卡顿导致方块未复位 / 消失就跳过本拍并计数），
//      再走 exact-placement.activateBlock（内部再对准中心 + 预检 + activateBlock）。
//   4. 每个 loop 在共享黑板挂一条 trigger 任务与一个快照键，多 bot 可各自维持信号互不干扰。
// CommonJS，ES5 风格，无中文变量名；所有外部调用包 try/catch，日志与报错双语。
var engineControl = null;
try { engineControl = require("./engine-control"); } catch (e) { engineControl = null; }
var exactPlacement = null;
try { exactPlacement = require("./exact-placement"); } catch (e) { exactPlacement = null; }
var sharedBoard = null;
try { sharedBoard = require("./shared-board"); } catch (e) { sharedBoard = null; }
var bus = null;
try { bus = require("./event-bus"); } catch (e) { bus = null; }
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
var actions = null;
try { actions = require("./actions"); } catch (e) { actions = null; }

// 常量：合法间隔范围 / 单 bot 触发器上限 / 状态连续未变化判为漏包的阈值 / 内存表。
var MIN_INTERVAL_MS = 10;
var MAX_INTERVAL_MS = 10000;
var MAX_LOOPS = 64;
var STALE_TICKS = 3;
var loops = {};
var registry = {};
var seq = 0;
var counters = { started: 0, fired: 0, blocked: 0, stopped: 0, failed: 0 };

// 写文件日志：触发属高频动作，只落文件不刷 GUI。
function logInfo(msg) {
  try { if (logger && typeof logger.info === "function") logger.info("[trigger] " + msg); } catch (e) { /* ignore */ }
}
// 写系统日志：启停属低频事件，推 GUI。
function logSystem(msg) {
  try { if (logger && typeof logger.system === "function") { logger.system("[trigger] " + msg); return; } }
  catch (e) { /* 退回 console */ }
  try { console.log("[trigger] " + msg); } catch (e2) { /* ignore */ }
}
// 广播触发器事件：总线缺失时静默跳过。
function emit(name, payload) {
  try { if (bus && typeof bus.emit === "function") bus.emit(name, payload); } catch (e) { /* ignore */ }
}
// 安全取错误文本：catch 里绝不会二次抛错。
function errText(err) {
  try { if (err && err.message) return String(err.message); return String(err); }
  catch (e) { return "unknown error / 未知错误"; }
}
// 安全转字符串：null / undefined 统一成空串。
function toText(value) {
  try { return value === null || value === undefined ? "" : String(value); } catch (e) { return ""; }
}
// 安全转整数：坏值回 fallback。
function toInt(value, fallback) {
  try { var n = Number(value); if (isNaN(n) || !isFinite(n)) return fallback; return Math.floor(n); }
  catch (e) { return fallback; }
}
// 归一化坐标：支持 {x,y,z} / [x,y,z] / "x,y,z"，坏值返回 null。
function pointOf(value) {
  try {
    if (Array.isArray(value) && value.length >= 3) return { x: toInt(value[0], NaN), y: toInt(value[1], NaN), z: toInt(value[2], NaN) };
    if (typeof value === "string") {
      var parts = value.replace(/[\[\]（）()]/g, "").split(/[,，\s]+/);
      if (parts.length >= 3) return { x: toInt(parts[0], NaN), y: toInt(parts[1], NaN), z: toInt(parts[2], NaN) };
    }
    if (value && typeof value === "object") return { x: toInt(value.x, NaN), y: toInt(value.y, NaN), z: toInt(value.z, NaN) };
  } catch (e) { return null; }
  return null;
}
// 构造 bot.blockAt 需要的向量；缺少 vec3 时用普通对象（假 bot 兼容）。
function vecOf(bot, point) {
  try {
    var vecLib = require("vec3");
    if (vecLib && typeof vecLib.Vec3 === "function") return new vecLib.Vec3(point.x, point.y, point.z);
  } catch (e) { /* 退回普通对象 */ }
  return { x: point.x, y: point.y, z: point.z };
}
// 默认触发频率：优先 redstoneTickRate，坏值回 50ms。
function defaultInterval() {
  try { if (engineControl && typeof engineControl.tickRate === "function") return engineControl.tickRate(); }
  catch (e) { /* 读失败回默认 */ }
  return 50;
}
// 清洗间隔：夹在 10~10000ms，坏值回默认。
function intervalOf(value) {
  var ms = toInt(value, 0);
  if (ms <= 0) return defaultInterval();
  if (ms < MIN_INTERVAL_MS) ms = MIN_INTERVAL_MS;
  if (ms > MAX_INTERVAL_MS) ms = MAX_INTERVAL_MS;
  return ms;
}
// 注册 bot 实例：主进程 / 自测都可调；坏值返回 ok:false。
function registerBot(botId, bot) {
  var id = toText(botId);
  if (!id || !bot) return { ok: false, message: "botId and bot required / 缺少机器人" };
  try { registry[id] = bot; } catch (e) { return { ok: false, message: errText(e) }; }
  return { ok: true, botId: id, count: Object.keys(registry).length };
}
// 解析本次使用的 bot：options.bot > 注册表 > 直接传进来的 botId 本身是对象。
function botOf(botId, options) {
  var opts = options && typeof options === "object" ? options : {};
  if (opts.bot) return opts.bot;
  if (botId && typeof botId === "object") return botId;
  var id = toText(botId);
  return registry[id] || null;
}
// 解析本次使用的黑板：options.board > shared-board；都没有返回 null。
function boardOf(options) {
  var opts = options && typeof options === "object" ? options : {};
  return opts.board || sharedBoard || null;
}
// 读方块状态指纹：stateId + name + powered，用来判断服务器是否把上一拍的状态包吞了。
function stateFingerprint(bot, pos) {
  try {
    if (!bot || typeof bot.blockAt !== "function") return { ok: false, block: null, text: "" };
    var block = bot.blockAt(vecOf(bot, pos));
    if (!block) return { ok: false, block: null, text: "" };
    var name = block.name ? String(block.name) : "";
    if (name === "" || name.indexOf("air") === 0) return { ok: false, block: block, text: "air" };
    var powered = "";
    try { if (typeof block.getProperties === "function") powered = toText(block.getProperties().powered); }
    catch (eProps) { powered = ""; }
    if (!powered && block.powered !== undefined) powered = toText(block.powered);
    return { ok: true, block: block, text: name + ":" + toText(block.stateId) + ":" + powered };
  } catch (e) { return { ok: false, block: null, text: "" }; }
}
// 真正执行一次触发：预检状态 → 防漏包判定 → activateBlock → 累计统计；绝不抛异常。
async function fire(rec, options) {
  var out = { ok: false, fired: false, blocked: false, reason: "", at: Date.now() };
  try {
    var bot = rec.bot;
    if (!bot) { out.reason = "bot not ready / 机器人未就绪"; return out; }
    // 触发前强制状态预检：方块不存在 / 空气一律不发网络包。
    var pre = stateFingerprint(bot, rec.pos);
    if (!pre.ok) {
      rec.blocked = rec.blocked + 1;
      counters.blocked = counters.blocked + 1;
      out.blocked = true;
      out.reason = "block missing / 目标方块不存在或为空气";
      return out;
    }
    // 漏斗：连续多拍状态完全一致说明上一拍网络包可能被服务器吞掉，补发一次并计数。
    if (pre.text === rec.lastState && rec.stale + 1 >= STALE_TICKS && options.force !== true) {
      rec.stale = 0;
      rec.resends = rec.resends + 1;
    } else if (pre.text === rec.lastState) {
      rec.stale = rec.stale + 1;
    } else {
      rec.stale = 0;
    }
    rec.lastState = pre.text;
    var hit = null;
    if (rec.actionFn) {
      try { hit = await rec.actionFn(bot, rec.pos, pre.block, options); }
      catch (eFn) { hit = { ok: false, message: errText(eFn) }; }
    } else if (exactPlacement && typeof exactPlacement.activateBlock === "function") {
      hit = await exactPlacement.activateBlock(bot, rec.pos, options);
    } else if (actions && typeof actions.activateBlock === "function") {
      hit = await actions.activateBlock(bot, rec.pos.x, rec.pos.y, rec.pos.z, options);
    } else if (bot && typeof bot.activateBlock === "function") {
      try { await bot.activateBlock(pre.block); hit = { ok: true }; }
      catch (eAct) { hit = { ok: false, message: errText(eAct) }; }
    } else {
      hit = { ok: false, message: "activateBlock unavailable / 触发接口不可用" };
    }
    if (!hit || (hit.ok === false && hit.activated !== true)) {
      out.reason = (hit && hit.message) ? toText(hit.message) : "activation failed / 触发失败";
      rec.blocked = rec.blocked + 1;
      counters.blocked = counters.blocked + 1;
      return out;
    }
    out.ok = true;
    out.fired = true;
    rec.fired = rec.fired + 1;
    rec.lastFireAt = out.at;
    counters.fired = counters.fired + 1;
    return out;
  } catch (e) {
    counters.failed = counters.failed + 1;
    out.reason = errText(e);
    logInfo("触发异常 / fire failed: " + out.reason);
    return out;
  }
}
// 漂移补偿排下一拍：下一拍目标时间 = 起始时间 + 已排次数 × 间隔，永远不累积抖动。
function schedule(rec) {
  try {
    if (!rec.active) return false;
    rec.scheduled = rec.scheduled + 1;
    var due = rec.startedAt + rec.scheduled * rec.intervalMs;
    var delay = due - Date.now();
    if (delay < 1) delay = 1;
    rec.timer = setTimeout(function () {
      try {
        rec.ticks = rec.ticks + 1;
        fire(rec, {}).then(function () { return null; }, function () { return null; });
      } catch (eTick) { logInfo("触发拍异常 / tick failed: " + errText(eTick)); }
      schedule(rec);
    }, delay);
    try { if (rec.timer && rec.timer.unref) rec.timer.unref(); } catch (eUnref) { /* ignore */ }
    return true;
  } catch (e) { return false; }
}
// 把触发器状态写进共享黑板：postTask 供修理 / 物流机器人可见，快照键供多 bot 同步。
function publish(rec, options) {
  var board = boardOf(options);
  if (!board) return { ok: false, taskId: "", snapshot: "" };
  var out = { ok: false, taskId: "", snapshot: "" };
  try {
    if (typeof board.postTask === "function") {
      var posted = board.postTask({ title: "trigger_loop", priority: 4,
        payload: { action: "redstone_trigger", taskId: rec.taskId, botId: rec.botId,
          pos: rec.pos, intervalMs: rec.intervalMs, actionName: rec.actionName, at: Date.now() } });
      if (posted && posted.ok) out.taskId = posted.taskId;
    }
    if (typeof board.post === "function") {
      out.snapshot = "trigger:" + rec.taskId;
      board.post(out.snapshot, { taskId: rec.taskId, botId: rec.botId, pos: rec.pos,
        intervalMs: rec.intervalMs, actionName: rec.actionName, active: true, at: Date.now() });
    }
    out.ok = out.taskId.length > 0 || out.snapshot.length > 0;
  } catch (e) { out.message = errText(e); }
  return out;
}
// 从黑板撤下触发器快照（停止时调用）；黑板缺失静默跳过。
function unpublish(rec, options) {
  var board = boardOf(options);
  if (!board) return false;
  try {
    if (rec.boardKey && typeof board.post === "function") {
      board.post(rec.boardKey, { taskId: rec.taskId, botId: rec.botId, active: false,
        fired: rec.fired, stoppedAt: Date.now() });
    }
    if (rec.boardTaskId && typeof board.completeTask === "function") board.completeTask(rec.boardTaskId);
    return true;
  } catch (e) { return false; }
}
// 启动一条高频触发循环；返回 { ok, taskId, intervalMs, botId, pos, message }。
function startTriggerLoop(botId, pos, action, intervalMs, options) {
  var opts = options && typeof options === "object" ? options : {};
  var out = { ok: false, taskId: "", intervalMs: 0, botId: toText(botId) || "default",
    pos: null, actionName: "", message: "bot not ready / 机器人未就绪" };
  try {
    var p = pointOf(pos);
    if (!p || isNaN(p.x) || isNaN(p.y) || isNaN(p.z)) { out.message = "bad target / 目标坐标非法"; return out; }
    out.pos = p;
    var bot = botOf(botId, opts);
    if (!bot) return out;
    if (Object.keys(loops).length >= MAX_LOOPS) { out.message = "too many loops / 触发器数量已达上限"; return out; }
    var ms = intervalOf(intervalMs);
    var name = typeof action === "function" ? "custom" : (toText(action) || "activate");
    seq = seq + 1;
    var taskId = "rt-" + Date.now().toString(36) + "-" + seq;
    var rec = {
      taskId: taskId, botId: out.botId, bot: bot, pos: p, actionName: name,
      actionFn: typeof action === "function" ? action : null, intervalMs: ms,
      startedAt: Date.now(), lastFireAt: 0, timer: null, active: true,
      ticks: 0, scheduled: 0, fired: 0, blocked: 0, resends: 0, stale: 0,
      lastState: "", boardKey: "", boardTaskId: "", board: boardOf(opts)
    };
    var pub = publish(rec, opts);
    rec.boardKey = pub.snapshot;
    rec.boardTaskId = pub.taskId;
    loops[taskId] = rec;
    if (opts.manual !== true) schedule(rec);
    counters.started = counters.started + 1;
    out.ok = true;
    out.taskId = taskId;
    out.intervalMs = ms;
    out.actionName = name;
    out.message = "trigger loop started / 高频触发已启动";
    logSystem("触发器启动 / trigger started: " + taskId + " interval=" + ms + "ms bot=" + out.botId);
    emit("redstone.trigger.started", { taskId: taskId, botId: out.botId, pos: p, intervalMs: ms, at: Date.now() });
    return out;
  } catch (e) {
    counters.failed = counters.failed + 1;
    out.message = errText(e);
    return out;
  }
}
// 停止一条触发循环：清定时器 + 撤黑板 + 返回累计统计。
function stopTriggerLoop(taskId, options) {
  var out = { ok: false, taskId: toText(taskId), fired: 0, ticks: 0, elapsed: 0, message: "not found / 触发器不存在" };
  try {
    var rec = loops[out.taskId];
    if (!rec) return out;
    rec.active = false;
    if (rec.timer) { try { clearTimeout(rec.timer); } catch (eClear) { /* ignore */ } }
    rec.timer = null;
    unpublish(rec, options || {});
    out.ok = true;
    out.fired = rec.fired;
    out.ticks = rec.ticks;
    out.elapsed = Date.now() - rec.startedAt;
    out.blocked = rec.blocked;
    out.message = "trigger loop stopped / 高频触发已停止";
    counters.stopped = counters.stopped + 1;
    emit("redstone.trigger.stopped", { taskId: out.taskId, fired: rec.fired, at: Date.now() });
    return out;
  } catch (e) { out.message = errText(e); return out; }
}
// 运行中调整触发频率（安全限流 / 恢复用）：只重排定时器，不重建 loop、不丢累计计数。
function setIntervalMs(taskId, ms, options) {
  var out = { ok: false, taskId: toText(taskId), previousMs: 0, intervalMs: 0,
    message: "not found / 触发器不存在" };
  try {
    var rec = loops[out.taskId];
    if (!rec || !rec.active) return out;
    var opts = options && typeof options === "object" ? options : {};
    var next = intervalOf(ms);
    out.previousMs = rec.intervalMs;
    rec.intervalMs = next;
    // 漂移基准与已排次数一起归零，避免新间隔叠加旧 scheduled 造成连拍或长时间空窗。
    rec.startedAt = Date.now();
    rec.scheduled = 0;
    if (rec.timer) { try { clearTimeout(rec.timer); } catch (eClear) { /* ignore */ } }
    rec.timer = null;
    if (opts.manual !== true) schedule(rec);
    // 同步黑板快照，让多 bot 协同看到降频后的真实间隔。
    try {
      var board = boardOf({ board: rec.board });
      if (board && rec.boardKey && typeof board.post === "function") {
        board.post(rec.boardKey, { taskId: rec.taskId, botId: rec.botId, pos: rec.pos,
          intervalMs: next, actionName: rec.actionName, active: true, at: Date.now() });
      }
    } catch (eBoard) { /* 黑板缺失不影响限流 */ }
    out.ok = true;
    out.intervalMs = next;
    out.message = "interval retuned / 触发频率已调整";
    logSystem("触发频率调整 / trigger retuned: " + out.taskId + " " + out.previousMs + "ms -> " + next + "ms");
    emit("redstone.trigger.retuned", { taskId: out.taskId, previousMs: out.previousMs,
      intervalMs: next, at: Date.now() });
  } catch (e) { out.message = errText(e); }
  return out;
}
// 手动打一拍（自测 / 命令用）：不依赖定时器，走与自动循环完全相同的 fire 链路。
async function tick(taskId, options) {
  try {
    var rec = loops[toText(taskId)];
    if (!rec) return { ok: false, fired: false, message: "not found / 触发器不存在" };
    return await fire(rec, options || {});
  } catch (e) { return { ok: false, fired: false, message: errText(e) }; }
}
// 停掉全部循环（进程收尾 / 自测隔离）；返回停止数量。
function stopAll(options) {
  var n = 0;
  try {
    var ids = Object.keys(loops);
    for (var i = 0; i < ids.length; i++) if (stopTriggerLoop(ids[i], options).ok) n = n + 1;
  } catch (e) { /* ignore */ }
  return { ok: true, stopped: n, message: "all trigger loops stopped / 全部触发循环已停止" };
}
// 列出全部触发器（副本，不含 bot 与 timer 引用）；供控制台与自测核对。
function list() {
  var out = [];
  try {
    var ids = Object.keys(loops);
    for (var i = 0; i < ids.length; i++) {
      var r = loops[ids[i]];
      out.push({ taskId: r.taskId, botId: r.botId, pos: r.pos, intervalMs: r.intervalMs,
        actionName: r.actionName, active: r.active, ticks: r.ticks, fired: r.fired,
        blocked: r.blocked, resends: r.resends, startedAt: r.startedAt, lastFireAt: r.lastFireAt,
        boardKey: r.boardKey, boardTaskId: r.boardTaskId });
    }
  } catch (e) { return []; }
  return out;
}
// 统计快照：累计启停 / 触发 / 阻止 / 失败与当前活跃数量。
function stats() {
  var active = 0;
  try { var ids = Object.keys(loops); for (var i = 0; i < ids.length; i++) if (loops[ids[i]].active) active = active + 1; }
  catch (e) { active = 0; }
  return { ok: true, active: active, started: counters.started, fired: counters.fired,
    blocked: counters.blocked, stopped: counters.stopped, failed: counters.failed,
    bots: Object.keys(registry).length, defaultIntervalMs: defaultInterval() };
}
// 清空全部内存状态（先停循环，不触碰黑板已有数据）；供自测隔离。
function reset() {
  try {
    stopAll({});
    loops = {};
    registry = {};
    seq = 0;
    counters = { started: 0, fired: 0, blocked: 0, stopped: 0, failed: 0 };
  } catch (e) { /* ignore */ }
  return { ok: true, message: "redstone trigger reset / 红石触发器已重置" };
}

// 对外导出：注册 / 启停 / 手动打拍 / 列表 / 诊断。
module.exports = {
  registerBot: registerBot,
  startTriggerLoop: startTriggerLoop,
  stopTriggerLoop: stopTriggerLoop,
  setIntervalMs: setIntervalMs,
  stopAll: stopAll,
  tick: tick,
  list: list,
  stats: stats,
  reset: reset,
  MIN_INTERVAL_MS: MIN_INTERVAL_MS,
  MAX_INTERVAL_MS: MAX_INTERVAL_MS
};
