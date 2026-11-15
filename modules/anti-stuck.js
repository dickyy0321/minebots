// ========================================
// 文件：modules/anti-stuck.js
// 功能：防卡死自救——3 秒不动就跳 / 挖，连续 3 次不动就放弃并通知 AI
// 依赖：./logger（可选）、./context-manager（可选）、vec3（可选），全部失败不崩
// 导出：attach / stop / isActive / setWatchdog / isEngineEnabled / WATCHDOG_MS / MAX_RESCUES / STUCK_EPSILON
// 作者：MineBots
// ========================================
//
// 用法：actions.moveTo 里 attach(bot, 目标, goTo 的 Promise)，寻路一结束或 stop() 就自动摘表，
//       定时器全部 unref，绝不拖住进程。

// 可选依赖：日志核心，缺失时退回 console。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
// 可选依赖：AI 上下文，用来把「卡死放弃」写进去，让 AI 换条路继续。
var contextManager = null;
try { contextManager = require("./context-manager"); } catch (e) { contextManager = null; }
// 可选依赖：vec3，给 blockAt / dig 构造坐标对象；缺失时退回实体坐标派生。
var vecLib = null;
try { vecLib = require("vec3"); } catch (e) { vecLib = null; }
// 可选依赖：引擎控制中心（专家模式可关防卡死 / 调看门狗间隔与自救上限）。
var engineControl = null;
try { engineControl = require("./engine-control"); } catch (e) { engineControl = null; }

// 常量：看门狗间隔——3 秒坐标没变就判定卡死。
var WATCHDOG_MS = 3000;
// 常量：位移小于它就算「没动」（0.4 格，足够滤掉原地抖动）。
var STUCK_EPSILON = 0.4;
// 常量：自救次数上限——超了就放弃这个任务并通知 AI。
var MAX_RESCUES = 3;
// 常量：原地跳一次要按多久（毫秒）。
var JUMP_MS = 420;
// 常量：单个任务的看门狗最长活多久（毫秒），到点强制摘表，防止遗留定时器。
var MAX_WATCH_MS = 120000;
// 状态：自测代码显式调过 setWatchdog 时优先用它，避免面板参数覆盖测试节拍。
var watchdogOverridden = false;

// 写普通信息日志：只落文件，缺 logger 时静默。
function logInfo(message) {
  try { if (logger && typeof logger.info === "function") logger.info(message); } catch (e) { /* ignore */ }
}

// 写警告日志：优先 logger.warn（推 GUI），缺 logger 时退回 console。
function logWarn(message) {
  try {
    if (logger && typeof logger.warn === "function") { logger.warn(message); return; }
    console.warn(message);
  } catch (e) { /* ignore */ }
}

// 安全提取错误文本，catch 里绝不二次抛错。
function errText(err) {
  try {
    if (!err) return "unknown error / 未知错误";
    if (typeof err === "string") return err;
    if (err.message) return String(err.message);
    return String(err);
  } catch (e) { return "unknown error / 未知错误"; }
}

// 读引擎开关：控制中心缺失或读失败时按开启处理。
function isEngineEnabled() {
  try {
    if (engineControl && typeof engineControl.isEnabled === "function") return engineControl.isEnabled("antiStuck") === true;
  } catch (e) { /* 读失败按开启 */ }
  return true;
}

// 读面板配置的看门狗间隔；读不到退回内置 3000ms。
function engineWatchdogMs() {
  try {
    if (engineControl && typeof engineControl.param === "function") {
      var ms = engineControl.param("antiStuck", "antiStuckWatchdogMs");
      if (ms >= 20) return ms;
    }
  } catch (e) { /* 读失败用默认值 */ }
  return 3000;
}

// 读面板配置的自救次数上限；读不到退回内置 3 次。
function engineMaxRescues() {
  try {
    if (engineControl && typeof engineControl.param === "function") {
      var n = engineControl.param("antiStuck", "antiStuckMaxRescues");
      if (n >= 1) return n;
    }
  } catch (e) { /* 读失败用默认值 */ }
  return MAX_RESCUES;
}

// 转数字，非法值返回兜底值。
function toNum(value, fallback) {
  try {
    var n = Number(value);
    return isNaN(n) ? fallback : n;
  } catch (e) { return fallback; }
}

// 读 bot 坐标并拍平成 { x, y, z }；世界没加载 / 坐标缺失返回 null。
function posOf(bot) {
  try {
    var p = bot && bot.entity && bot.entity.position ? bot.entity.position : null;
    if (!p) return null;
    var x = toNum(p.x, NaN);
    var y = toNum(p.y, NaN);
    var z = toNum(p.z, NaN);
    if (isNaN(x) || isNaN(y) || isNaN(z)) return null;
    return { x: x, y: y, z: z };
  } catch (e) { return null; }
}

// 三点距离平方；坐标非法返回 -1 表示「无法判断」。
function distSq(a, b) {
  try {
    if (!a || !b) return -1;
    var dx = toNum(a.x, 0) - toNum(b.x, 0);
    var dy = toNum(a.y, 0) - toNum(b.y, 0);
    var dz = toNum(a.z, 0) - toNum(b.z, 0);
    return dx * dx + dy * dy + dz * dz;
  } catch (e) { return -1; }
}

// 构造坐标对象：优先 vec3，其次用实体坐标 offset 派生，最后退化成普通对象。
function makeVec(bot, x, y, z) {
  try {
    var vx = toNum(x, NaN);
    var vy = toNum(y, NaN);
    var vz = toNum(z, NaN);
    if (isNaN(vx) || isNaN(vy) || isNaN(vz)) return null;
    if (vecLib && typeof vecLib.Vec3 === "function") return new vecLib.Vec3(vx, vy, vz);
    var p = bot && bot.entity ? bot.entity.position : null;
    if (p && typeof p.offset === "function") return p.offset(vx - p.x, vy - p.y, vz - p.z);
    return { x: vx, y: vy, z: vz };
  } catch (e) { return null; }
}

// 自救动作 1：原地跳一下（并按一会儿前进），400ms 后松开；失败返回 false。
function tryJump(bot) {
  try {
    if (!bot || typeof bot.setControlState !== "function") return false;
    bot.setControlState("jump", true);
    bot.setControlState("forward", true);
    var timer = setTimeout(function () {
      try { bot.setControlState("jump", false); } catch (e1) { /* ignore */ }
      try { bot.setControlState("forward", false); } catch (e2) { /* ignore */ }
    }, JUMP_MS);
    if (timer && timer.unref) timer.unref();
    logInfo("[anti-stuck] 卡住了，先原地跳 / stuck, jump first");
    return true;
  } catch (e) { return false; }
}

// 自救动作 2：挖指定坐标的方块（空气 / 不可挖就跳过）；返回是否真的开挖。
function digAt(bot, x, y, z) {
  try {
    if (!bot || typeof bot.dig !== "function" || typeof bot.blockAt !== "function") return false;
    var vec = makeVec(bot, Math.floor(x), Math.floor(y), Math.floor(z));
    if (!vec) return false;
    var block = bot.blockAt(vec);
    if (!block) return false;
    var name = block.name ? String(block.name) : "";
    if (name.length === 0 || name.indexOf("air") === 0 || name.indexOf("water") === 0 || name.indexOf("lava") === 0) return false;
    if (typeof bot.canDigBlock === "function" && bot.canDigBlock(block) === false) return false;
    var digging = bot.dig(block);
    if (digging && typeof digging.catch === "function") digging.catch(function () { return null; });
    logInfo("[anti-stuck] 挖穿障碍 / digging through: " + name + " @ " + Math.floor(x) + "," + Math.floor(y) + "," + Math.floor(z));
    return true;
  } catch (e) { return false; }
}

// 自救动作 3：挖正前方（朝目标方向）→ 脚下 → 头顶，第一个挖得动的就挖；返回是否挖了。
function tryDig(bot, goal) {
  try {
    var me = posOf(bot);
    if (!me || !goal) return false;
    var dx = goal.x - me.x;
    var dz = goal.z - me.z;
    var fx = me.x;
    var fz = me.z;
    if (Math.abs(dx) >= Math.abs(dz)) fx = me.x + (dx >= 0 ? 1 : -1);
    else fz = me.z + (dz >= 0 ? 1 : -1);
    // 顺序：正前方 → 正前方下半格（矮台阶）→ 脚下 → 头顶。
    if (digAt(bot, fx, me.y, fz)) return true;
    if (digAt(bot, fx, me.y - 1, fz)) return true;
    if (digAt(bot, me.x, me.y - 1, me.z)) return true;
    if (digAt(bot, me.x, me.y + 1, me.z)) return true;
    return false;
  } catch (e) { return false; }
}

// 通知 AI：把「卡死放弃」写进临时上下文并写日志；失败只是这次没通知到。
function notifyAi(bot, state, message) {
  var id = "?";
  try { id = bot && bot._mbBotId ? String(bot._mbBotId) : (bot && bot.username ? String(bot.username) : "?"); } catch (e) { id = "?"; }
  var text = "[" + id + "] 卡死自救失败，已放弃该目标 / anti-stuck gave up: " + toNum(state ? state.rescues : 0, 0) + " 次自救无效; " + message;
  logWarn(text);
  try { if (contextManager && typeof contextManager.addContext === "function") contextManager.addContext(text, "temporary"); }
  catch (e1) { /* 通知不到 AI 也不影响机器人继续跑 */ }
  return text;
}

// 停表：清定时器、把状态从 bot 上摘掉；重复调用安全，返回是否真的停掉了一个。
function stop(bot, state) {
  try {
    var current = state ? state : (bot ? bot._mbAntiStuck : null);
    if (!current) return false;
    current.stopped = true;
    try { if (current.timer) clearInterval(current.timer); } catch (e1) { /* ignore */ }
    current.timer = null;
    // 只摘自己那一个：新动作已经挂了新表就别误杀。
    if (bot && bot._mbAntiStuck === current) bot._mbAntiStuck = null;
    return true;
  } catch (e) { return false; }
}

// 放弃：停表 + 记日志 + 通知 AI，并把放弃信息挂到 bot 上供上层读取。
function giveUp(bot, state, reason) {
  try {
    var text = notifyAi(bot, state, reason || "still not moving / 依然不动");
    try { if (bot) bot._mbStuckGiveUp = { at: Date.now(), rescues: toNum(state ? state.rescues : 0, 0), message: text }; } catch (e1) { /* ignore */ }
    stop(bot, state);
    return { ok: false, action: "antiStuck", code: "GAVE_UP", message: text };
  } catch (e) {
    stop(bot, state);
    return { ok: false, action: "antiStuck", code: "GAVE_UP", message: errText(e) };
  }
}

// 自救一步：第 1 次跳、第 2 次挖正前方、第 3 次再跳一次给最后机会；返回做了什么。
function rescue(bot, state) {
  try {
    if (!state) return "none";
    if (state.rescues === 1) return tryJump(bot) ? "jump" : "none";
    if (state.rescues === 2) return tryDig(bot, state.goal) ? "dig" : "none";
    if (tryJump(bot)) return "jump";
    return tryDig(bot, state.goal) ? "dig" : "none";
  } catch (e) { return "none"; }
}

// 看门狗一拍：3 秒内坐标没动且离目标还远 → 判卡死 → 自救；自救满 3 次仍不动就放弃。
function tick(bot, state) {
  try {
    if (!state || state.stopped) return null;
    if (!bot || bot._mbAntiStuck !== state) { stop(bot, state); return null; }
    var now = Date.now();
    if (now - toNum(state.startedAt, now) > MAX_WATCH_MS) { stop(bot, state); return null; }
    var cur = posOf(bot);
    if (!cur) return null;
    var moved = distSq(cur, state.last);
    state.last = cur;
    // 已经站在目标附近：说明只是到位了，不算卡死。
    var left = distSq(cur, state.goal);
    if (left >= 0 && left <= 2.56) { state.rescues = 0; return null; }
    if (moved < 0 || moved > STUCK_EPSILON * STUCK_EPSILON) { state.rescues = 0; return null; }
    state.rescues = toNum(state.rescues, 0) + 1;
    state.stuckCount = toNum(state.stuckCount, 0) + 1;
    if (state.rescues > engineMaxRescues()) return giveUp(bot, state, "坐标 3 秒没变化 / no movement in " + Math.round(WATCHDOG_MS / 1000) + "s");
    var what = rescue(bot, state);
    logInfo("[anti-stuck] 第 " + state.rescues + " 次自救 / rescue #" + state.rescues + ": " + what);
    return what;
  } catch (e) {
    logInfo("[anti-stuck] 看门狗异常 / watchdog error: " + errText(e));
    return null;
  }
}

// 挂看门狗：给一次寻路挂 3 秒一拍的检查；返回 { stop } 句柄（重复 stop 安全，永不抛错）。
function attach(bot, target, walking) {
  var handle = { state: null, stop: function () { return false; } };
  try {
    // 专家面板关掉防卡死：不挂定时器、不改 bot 状态，等同模块停止运作。
    if (!isEngineEnabled()) return handle;
    if (!bot || typeof bot.setControlState !== "function") return handle;
    var goal = null;
    try { goal = target ? { x: toNum(target.x, NaN), y: toNum(target.y, 0), z: toNum(target.z, NaN) } : null; } catch (e0) { goal = null; }
    if (!goal || isNaN(goal.x) || isNaN(goal.z)) return handle;
    var start = posOf(bot);
    var state = {
      bot: bot, goal: goal, rescues: 0, stuckCount: 0,
      startedAt: Date.now(), last: start, timer: null, stopped: false
    };
    var intervalMs = watchdogOverridden ? WATCHDOG_MS : engineWatchdogMs();
    state.timer = setInterval(function () { tick(bot, state); }, intervalMs);
    if (state.timer && state.timer.unref) state.timer.unref();
    bot._mbAntiStuck = state;
    handle.state = state;
    handle.stop = function () { return stop(bot, state); };
    // 寻路一结束（到达 / 超时 / 失败 / 停止）就摘表，绝不留定时器。
    var finish = function () { stop(bot, state); };
    try {
      if (walking && typeof walking.then === "function") walking.then(finish, finish);
    } catch (e1) { finish(); }
    // 机器人断开 / 被踢也要立刻摘表：绝不在已经停掉的 bot 上又跳又挖。
    try { if (typeof bot.once === "function") bot.once("end", finish); } catch (e2) { /* ignore */ }
    logInfo("[anti-stuck] 看门狗已挂载 / watchdog armed: " + intervalMs + "ms");
    return handle;
  } catch (err) {
    logWarn("[anti-stuck] 看门狗挂载失败 / attach failed: " + errText(err));
    return handle;
  }
}

// 判断某个 bot 现在是否有看门狗在跑。
function isActive(bot) {
  try { return !!(bot && bot._mbAntiStuck && bot._mbAntiStuck.stopped !== true); } catch (e) { return false; }
}

// 改看门狗间隔（自检用；低于 20ms 的非法值一律恢复默认 3000ms）。
function setWatchdog(ms) {
  var n = toNum(ms, WATCHDOG_MS);
  if (!(n >= 20)) n = WATCHDOG_MS;
  WATCHDOG_MS = Math.round(n);
  // 显式调回引擎默认值时解除覆盖，让面板参数重新接管。
  try { watchdogOverridden = WATCHDOG_MS !== engineWatchdogMs(); }
  catch (e) { watchdogOverridden = true; }
  return WATCHDOG_MS;
}

// 对外导出：挂表 / 停表 / 查询 / 常量（自检与调试用）。
module.exports = {
  attach: attach,
  stop: stop,
  isActive: isActive,
  setWatchdog: setWatchdog,
  isEngineEnabled: isEngineEnabled,
  WATCHDOG_MS: WATCHDOG_MS,
  MAX_RESCUES: MAX_RESCUES,
  STUCK_EPSILON: STUCK_EPSILON
};
