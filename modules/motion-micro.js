// ========================================
// 文件：modules/motion-micro.js
// 功能：动作拟真微操——走路时视线自然游移、偶尔轻跳、挖完方块环视一圈；精确建筑模式下自动归零。
// 依赖：./logger（可选）、./exact-placement（可选）、./prefs（可选）
// 导出：attach / detach / walkTick / onDigDone / simulate / configure / stats / reset / WANDER_EVERY / JUMP_EVERY
// 作者：MineBots
// ========================================
//
// 设计：物理帧高频信息只写文件日志，绝不推 GUI；所有拟真幅度都很小，
//   不干扰寻路与视线锁定；engExactBuild（3D 打印模式）开启时全部抖动归零。
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

// 可选依赖：日志（只写文件）。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
// 可选依赖：精确建筑门面；开启时禁用一切拟真。
var exact = null;
try { exact = require("./exact-placement"); } catch (e) { exact = null; }
// 可选依赖：偏好中心。
var prefs = null;
try { prefs = require("./prefs"); } catch (e) { prefs = null; }
// 常量：每多少帧游移一次视线 / 平均每多少帧轻跳一次 / 挖完环视几段。
var WANDER_EVERY = 8;
var JUMP_EVERY = 40;
var LOOK_AROUND_STEPS = 4;
var JUMP_HOLD_MS = 110;
// 常量：视线游移幅度（弧度）。
var YAW_JITTER = 0.09;
var PITCH_JITTER = 0.05;
// 运行时：每个 bot 的微操状态与全局统计。
var sessions = {};
var totals = { ticks: 0, wanders: 0, jumps: 0, lookArounds: 0, suppressed: 0 };
// 配置：默认全开（与全引擎默认开启一致）。
var config = { enabled: true, wander: true, jump: true, lookAround: true };

// 写普通日志：只落文件，不推 GUI。
function logInfo(text) {
  try { if (logger && typeof logger.info === "function") logger.info(text); } catch (e) { /* ignore */ }
}
// 取错误文本，catch 里绝不再次抛错。
function errText(err) {
  try { if (!err) return "unknown error"; if (err.message) return String(err.message); return String(err); } catch (e) { return "unknown error"; }
}
// 取（或新建）会话状态。
function sessionOf(botId) {
  var id = String(botId || "default");
  if (!sessions[id]) sessions[id] = { ticks: 0, wanders: 0, jumps: 0, lookArounds: 0, attached: false };
  return sessions[id];
}
// 判断精确建筑模式是否开启：开启时任何拟真都必须归零。
function isExact() {
  try {
    if (exact && typeof exact.isExact === "function" && exact.isExact() === true) return true;
    if (prefs && typeof prefs.load === "function" && prefs.load().engExactBuild === true) return true;
  } catch (e) { /* 读不到按非精确处理 */ }
  return false;
}
// 安全调用 bot 上的一个方法：不存在或抛错都返回 null。
function call(bot, name, args) {
  try {
    if (!bot || typeof bot[name] !== "function") return null;
    return bot[name].apply(bot, args || []);
  } catch (e) { logInfo("[motion-micro] " + name + " failed / 调用失败: " + errText(e)); return null; }
}
// 功能：读配置 / 改配置，返回当前配置快照。
function configure(options) {
  try {
    var opts = options && typeof options === "object" ? options : {};
    if (typeof opts.enabled === "boolean") config.enabled = opts.enabled;
    if (typeof opts.wander === "boolean") config.wander = opts.wander;
    if (typeof opts.jump === "boolean") config.jump = opts.jump;
    if (typeof opts.lookAround === "boolean") config.lookAround = opts.lookAround;
  } catch (e) { /* 坏配置沿用旧值 */ }
  return { ok: true, enabled: config.enabled, wander: config.wander, jump: config.jump, lookAround: config.lookAround, exact: isExact() };
}
// 功能：走一帧——每 8 帧小幅游移视线，每 40 帧左右轻跳一次；返回本帧动作。
function walkTick(bot, botId) {
  var out = { ok: true, action: "none", wandered: false, jumped: false, suppressed: false };
  try {
    var st = sessionOf(botId);
    st.ticks = st.ticks + 1;
    totals.ticks = totals.ticks + 1;
    if (!config.enabled || isExact()) { totals.suppressed = totals.suppressed + 1; out.suppressed = true; out.action = "exact_build"; return out; }
    if (config.wander && st.ticks % WANDER_EVERY === 0) {
      var yaw = (typeof bot.yaw === "number" ? bot.yaw : 0) + (Math.random() * 2 - 1) * YAW_JITTER;
      var pitch = (typeof bot.pitch === "number" ? bot.pitch : 0) + (Math.random() * 2 - 1) * PITCH_JITTER;
      call(bot, "look", [yaw, pitch, true]);
      st.wanders = st.wanders + 1; totals.wanders = totals.wanders + 1;
      out.wandered = true; out.action = "wander";
    }
    if (config.jump && st.ticks % JUMP_EVERY === 0) {
      doJump(bot);
      st.jumps = st.jumps + 1; totals.jumps = totals.jumps + 1;
      out.jumped = true; out.action = out.wandered ? "wander+jump" : "jump";
    }
    return out;
  } catch (e) { return { ok: false, action: "error", message: errText(e) }; }
}
// 内部：短促起跳后释放控制状态；定时器 unref，绝不拖住进程。
function doJump(bot) {
  try {
    call(bot, "setControlState", ["jump", true]);
    var timer = setTimeout(function () { call(bot, "setControlState", ["jump", false]); }, JUMP_HOLD_MS);
    if (timer && typeof timer.unref === "function") timer.unref();
  } catch (e) { /* 跳不起来不影响走路 */ }
}
// 功能：挖完方块环视一圈——按四个方向缓慢转头，返回 { ok, steps }。
function onDigDone(bot, botId) {
  try {
    var st = sessionOf(botId);
    if (!config.enabled || !config.lookAround || isExact()) return { ok: true, steps: 0, suppressed: true };
    st.lookArounds = st.lookArounds + 1;
    totals.lookArounds = totals.lookArounds + 1;
    for (var i = 1; i <= LOOK_AROUND_STEPS; i++) {
      scheduleLook(bot, i, LOOK_AROUND_STEPS, i * 90);
    }
    logInfo("[motion-micro] look around / 挖完环视一圈: " + String(botId));
    return { ok: true, steps: LOOK_AROUND_STEPS, action: "look_around" };
  } catch (e) { return { ok: false, steps: 0, message: errText(e) }; }
}
// 内部：延迟执行某一角度的环视；定时器 unref。
function scheduleLook(bot, step, total, ms) {
  try {
    var timer = setTimeout(function () {
      var yaw = (typeof bot.yaw === "number" ? bot.yaw : 0) + Math.PI / 2;
      call(bot, "look", [yaw, 0, true]);
      logInfo("[motion-micro] look step " + step + "/" + total + " / 环视第 " + step + " 段");
    }, ms);
    if (timer && typeof timer.unref === "function") timer.unref();
  } catch (e) { /* ignore */ }
}
// 功能：真实挂载——move 帧走微操，diggingCompleted 触发环视；幂等，返回监听数。
function attach(bot, botId, options) {
  var out = { ok: false, events: 0, message: "" };
  try {
    if (!bot || typeof bot.on !== "function") { out.message = "no bot / 机器人不可用"; return out; }
    var st = sessionOf(botId);
    if (st.attached) { out.ok = true; out.message = "already attached / 已挂载"; return out; }
    var self = function () { walkTick(bot, botId); };
    var dig = function () { onDigDone(bot, botId); };
    bot.on("move", self); out.events = out.events + 1;
    bot.on("diggingCompleted", dig); out.events = out.events + 1;
    st.attached = true;
    st.handlers = [{ event: "move", fn: self }, { event: "diggingCompleted", fn: dig }];
    out.ok = true;
    out.message = "motion micro attached / 动作微操已挂载";
    return out;
  } catch (e) { return { ok: false, events: 0, message: errText(e) }; }
}
// 功能：卸载监听，返回摘掉的监听数。
function detach(bot, botId) {
  try {
    var st = sessionOf(botId);
    var list = st.handlers || [];
    for (var i = 0; i < list.length; i++) {
      try { if (bot && typeof bot.removeListener === "function") bot.removeListener(list[i].event, list[i].fn); } catch (eOne) { /* 单个失败继续 */ }
    }
    st.handlers = []; st.attached = false;
    return { ok: true, removed: list.length };
  } catch (e) { return { ok: false, removed: 0, message: errText(e) }; }
}
// 功能：同步模拟若干帧（自测 / 离线推演用），返回累计动作统计。
function simulate(bot, botId, steps) {
  var count = Number(steps) > 0 ? Math.floor(Number(steps)) : 0;
  var out = { ok: true, steps: count, wanders: 0, jumps: 0 };
  try {
    for (var i = 0; i < count; i++) {
      var r = walkTick(bot, botId);
      if (r.wandered) out.wanders = out.wanders + 1;
      if (r.jumped) out.jumps = out.jumps + 1;
    }
  } catch (e) { out.ok = false; out.message = errText(e); }
  return out;
}
// 功能：读统计快照。
function stats(botId) {
  var st = sessionOf(botId);
  return { ok: true, botId: String(botId || "default"), ticks: st.ticks, wanders: st.wanders,
    jumps: st.jumps, lookArounds: st.lookArounds, attached: st.attached,
    totals: { ticks: totals.ticks, wanders: totals.wanders, jumps: totals.jumps,
      lookArounds: totals.lookArounds, suppressed: totals.suppressed }, exact: isExact() };
}
// 功能：复位全部会话与统计。
function reset() {
  sessions = {};
  totals = { ticks: 0, wanders: 0, jumps: 0, lookArounds: 0, suppressed: 0 };
  config = { enabled: true, wander: true, jump: true, lookAround: true };
  return { ok: true, message: "motion micro reset / 动作微操已复位" };
}
// 对外导出。
module.exports = {
  attach: attach, detach: detach, walkTick: walkTick, onDigDone: onDigDone,
  simulate: simulate, configure: configure, stats: stats, reset: reset,
  WANDER_EVERY: WANDER_EVERY, JUMP_EVERY: JUMP_EVERY
};
