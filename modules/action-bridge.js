// ========================================
// 文件：modules/action-bridge.js
// 功能：command-handler → actions 的接线层：找方法 / 判寻路可用 / await + try/catch / 结果规整
// 依赖：./actions（可选，缺失时 call 一律返回 null，调用方走老实现）、./task-queue（可选，缺失时只清动作不清队列）、./logger（可选）
// 导出：available、canPathfind、preempt、call
// 作者：MineBots
// ========================================
//
// 为什么单独一层：
//   actions.* 是「坐标 / 实体」原语（如 digBlock(bot,x,y,z)），command-handler 是「扫描式」动作
//   （先找最近的木头再挖）。接线层只做三件事：找到方法、把 Promise 收成统一结果、失败只写日志。
//   返回 null 代表「没接线」，调用方据此保留原来的兜底实现，绝不会出现两套逻辑同时动手。
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

// 可选依赖：日志核心；缺失时退回 console。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
// 可选依赖：基础动作模块；缺失时 call 一律返回 null。
var actions = null;
try { actions = require("./actions"); } catch (err) { actions = null; }
// 可选依赖：任务播报（内置模板 + 8 秒冷却）；缺失时整层静默，不影响动作执行。
var narration = null;
try { narration = require("./task-narration"); } catch (e) { narration = null; }
// 可选依赖：任务队列；缺失时新指令只清动作，不清遗留的排队任务。
var taskQueue = null;
try { taskQueue = require("./task-queue"); } catch (e2) { taskQueue = null; }
// 可选依赖：拟真动作层（分步缓转）；缺失时退回瞬间 lookAt。
var motion = null;
try { motion = require("./motion"); } catch (e3) { motion = null; }
// 常量：这些原语不播报——「接下来：停下」这种话只会招人烦。
var NARRATE_SKIP = ["stopMoving"];

// 写告警日志：优先 logger.warn，失败退回 console，绝不抛错。
function logWarn(message) {
  try {
    if (logger && typeof logger.warn === "function") logger.warn(message);
    else console.warn(message);
  } catch (e) { /* 日志失败不影响执行 */ }
}

// 取 actions 里的方法：模块缺失、方法不存在或不是函数时返回 null。
function get(method) {
  try {
    if (actions && typeof actions[method] === "function") return actions[method];
  } catch (e) { logWarn("action-bridge get failed: " + getErrText(e)); }
  return null;
}

// 安全取错误文本：catch 里再抛错就破红线了。
function getErrText(err) {
  try {
    if (!err) return "unknown error";
    if (err.message) return String(err.message);
    return String(err);
  } catch (e) { return "unknown error"; }
}

// actions 模块是否可用：随便取一个必需方法就能判断。
function available() {
  return get("stopMoving") !== null;
}

// 真寻路是否已经挂到 bot 上：没插件时 actions.moveTo / collectNearbyItems 只能原地空转到超时。
function canPathfind(bot) {
  try {
    return !!(bot && bot.pathfinder && typeof bot.pathfinder.setGoal === "function");
  } catch (e) { return false; }
}

// 清掉该 bot 遗留的排队任务：新指令一到就作废旧排队（follow 除外）；模块缺失 / 没 bot 时安静跳过。
// 返回被扔掉的任务条数，失败一律返回 0，绝不抛错。
function clearBacklog(bot, actionName) {
  try {
    if (!bot || !taskQueue || typeof taskQueue.clearLeftovers !== "function") return 0;
    var res = taskQueue.clearLeftovers(bot, actionName);
    var dropped = res && res.cleared ? res.cleared : 0;
    if (dropped > 0) logWarn("[action-bridge] 新指令作废排队任务 " + dropped + " 条 / dropped " + dropped + " queued tasks");
    return dropped;
  } catch (e1) { return 0; }
}

// 抢占：新指令进来先停掉旧动作（松控制键 / 停寻路 / 清寻路目标 / 清视线心跳 / 清遗留队列），失败只记日志。
// actionName 是新指令的名字（follow 会保留排队任务）；返回动作结果对象，bot 不可用时返回 ok=false。
function preempt(bot, actionName) {
  try {
    if (!bot) return { ok: false, action: "preempt", message: "bot not ready / 机器人未就绪" };
    clearBacklog(bot, actionName);
    var fn = get("stopMoving");
    if (fn) {
      var res = fn.call(actions, bot);
      if (res && typeof res === "object") return res;
      return { ok: true, action: "preempt", message: "stopped / 已停止" };
    }
  } catch (err) { logWarn("action-bridge preempt failed: " + getErrText(err)); }
  try {
    // actions 模块缺失时的兜底：直接把寻路目标清空，别让旧目标把新指令卡住。
    if (bot.pathfinder && typeof bot.pathfinder.setGoal === "function") bot.pathfinder.setGoal(null);
  } catch (e2) { /* 插件不在就到此为止 */ }
  return { ok: true, action: "preempt", message: "stopped / 已停止" };
}

// 播报一步（模板 + 冷却），模块缺失 / 模板未知都静默。
function narrateStep(bot, label) {
  try {
    if (!narration || typeof narration.announce !== "function") return;
    for (var i = 0; i < NARRATE_SKIP.length; i++) if (NARRATE_SKIP[i] === label) return;
    narration.announce(bot, "", "step", { action: label });
  } catch (e) { /* 播报失败不影响动作 */ }
}

// 播报结果：成功说一句（多数被 8 秒冷却吃掉），失败同一句话 30 秒内只报一次。
function narrateResult(bot, label, ok) {
  try {
    if (!narration || typeof narration.announce !== "function") return;
    for (var i = 0; i < NARRATE_SKIP.length; i++) if (NARRATE_SKIP[i] === label) return;
    narration.announce(bot, "", ok ? "done" : "error", { action: label });
  } catch (e) { /* 播报失败不影响动作 */ }
}

// 把 actions 的 { ok, code, message } 翻成 command-handler 的 { ok, action, error, ...extra }。
// extra 里的字段优先（调用方知道的上下文），actions 自己带回的字段（block / found / mode ...）补进来，
// 这样上层拿到的结果和以前手写实现一样丰满，日志 / 汇报不用再猜。
function normalize(name, res, extra) {
  var out = {};
  var src = extra && typeof extra === "object" ? extra : {};
  var keys = Object.keys(src);
  for (var i = 0; i < keys.length; i++) out[keys[i]] = src[keys[i]];
  if (res && typeof res === "object") {
    var resKeys = Object.keys(res);
    for (var k = 0; k < resKeys.length; k++) {
      var key = resKeys[k];
      if (key === "ok" || key === "message" || key === "code") continue;
      if (out[key] === undefined) out[key] = res[key];
    }
  }
  out.ok = !!(res && res.ok === true);
  out.action = String(name === undefined || name === null ? "" : name);
  if (out.ok) {
    out.error = null;
    return out;
  }
  var msg = res && (res.message || res.code) ? String(res.message || res.code) : "actions failed / 基础动作执行失败";
  out.error = msg;
  if (res && res.code) out.code = String(res.code);
  return out;
}

// 调一个 actions 方法：没接线返回 null；接线后一定 await，异常只记日志并按失败结果返回。
// options.needsPath 为真时，bot 上没挂寻路插件就返回 null（叫调用方走老实现，别空转）。
async function call(bot, method, args, name, extra, options) {
  var fn = get(method);
  if (!fn) return null;
  var opt = options && typeof options === "object" ? options : {};
  if (opt.needsPath === true && !canPathfind(bot)) return null;
  var list = Array.isArray(args) ? args : [];
  var label = name || method;
  narrateStep(bot, label);
  try {
    var res = await fn.apply(actions, [bot].concat(list));
    var done = normalize(label, res, extra);
    narrateResult(bot, label, done.ok === true);
    return done;
  } catch (err) {
    logWarn("actions." + method + " failed: " + getErrText(err));
    var failed = normalize(label, null, extra);
    narrateResult(bot, label, false);
    return failed;
  }
}

// 看向某个坐标：优先分步缓转（拟人，5 步 × 50ms），没有 motion 模块时退回瞬间 lookAt。
// 返回 true 表示已发出转向指令；bot 没有 lookAt 时返回 false，绝不抛错。
async function lookAt(bot, pos, steps) {
  try {
    if (!bot || !pos || typeof bot.lookAt !== "function") return false;
    if (motion && typeof motion.smoothLookAt === "function") {
      var res = await motion.smoothLookAt(bot, pos, steps || 5);
      return !!(res && res.ok !== false);
    }
    await bot.lookAt(pos, true);
    return true;
  } catch (err) {
    logWarn("[action-bridge] lookAt failed: " + getErrText(err));
    return false;
  }
}

// 对外导出：available / canPathfind / preempt / call / lookAt。
module.exports = {
  available: available,
  canPathfind: canPathfind,
  preempt: preempt,
  call: call,
  lookAt: lookAt
};
