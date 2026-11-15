// ========================================
// 文件：modules/state-skills-flow.js
// 功能：状态机技能（时间流程类 + 事件类）——延时 / 计时器 / 计数器 / 条件比较 / 发事件 / 听聊天关键词 / 玩家接近
// 依赖：./state-util
// 导出：HANDLERS / NAMES / has / pick / compare
// 作者：MineBots
// ========================================
//
// 说明：事件统一存在 ctx.events（普通对象），state-machine 每轮把它清空，
//       所以事件类节点只对「本轮发生的事」成立，不会因为旧事件反复触发。
// ES5 风格，CommonJS，无中文变量名
var util = null;
try { util = require("./state-util"); } catch (e) { util = null; }

// 可选依赖：日志核心，缺失时退回 console。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：单次延时上限（毫秒）/ 计时器名字长度上限。
var MAX_DELAY_MS = 30000;
var MAX_NAME_LEN = 40;

// 安全提取错误文本，catch 里不会二次抛错。
function getErrText(err) {
  try {
    if (err && err.message) return String(err.message);
    return String(err);
  } catch (e) { return "unknown error"; }
}

// 转文本（null / undefined → 空串）。
function toText(value) {
  try {
    if (value === null || value === undefined) return "";
    return String(value);
  } catch (e) { return ""; }
}

// 转数字（失败返回兜底值）。
function toNum(value, fallback) {
  var base = (fallback === undefined) ? 0 : fallback;
  try {
    var num = parseFloat(toText(value));
    return isNaN(num) ? base : num;
  } catch (e) { return base; }
}

// 洗名字：去空白并截断到 MAX_NAME_LEN，非法返回空串。
function cleanName(value) {
  var text = toText(value).replace(/^\s+|\s+$/g, "");
  if (text.length === 0) return "";
  return text.length > MAX_NAME_LEN ? text.slice(0, MAX_NAME_LEN) : text;
}

// 写文件日志：计时 / 计数属于高频信息，只落文件。
function logInfo(msg) {
  try {
    if (logger && typeof logger.info === "function") { logger.info("[state-skill4] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[state-skill4] " + msg); } catch (e) { /* ignore */ }
}

// 时间 1：延时等待若干毫秒（上限 MAX_DELAY_MS）。
async function delay(ctx, args) {
  var ms = toNum(args.ms, 1000);
  if (ms < 0) ms = 0;
  if (ms > MAX_DELAY_MS) ms = MAX_DELAY_MS;
  if (util && typeof util.sleep === "function") await util.sleep(ms);
  return { ok: true, waited: ms, message: "延时 " + ms + " 毫秒 / delayed " + ms + "ms" };
}

// 时间 2：设置一个计时器（现在时间 + ms），名字不能为空。
async function setTimer(ctx, args) {
  var name = cleanName(args.name);
  if (name.length === 0) return { ok: false, message: "name 不能为空 / name required" };
  var ms = toNum(args.ms, 1000);
  if (ms < 0) ms = 0;
  if (ms > MAX_DELAY_MS) ms = MAX_DELAY_MS;
  try { ctx.vars[name] = Date.now() + ms; } catch (e) { return { ok: false, message: getErrText(e) }; }
  return { ok: true, name: name, until: ctx.vars[name], message: "计时器已启动 / timer set: " + name };
}

// 时间 3：判断计时器是否到点（没设过一律算到点，避免卡死流程）。
async function timerDone(ctx, args) {
  var name = cleanName(args.name);
  if (name.length === 0) return { ok: false, message: "name 不能为空 / name required" };
  var until = null;
  try { until = ctx.vars[name]; } catch (e) { until = null; }
  var doneNow = (until === null || until === undefined) ? true : (Date.now() >= toNum(until, 0));
  try { ctx.vars.timerDone = doneNow; } catch (e) { /* ignore */ }
  return { ok: true, done: doneNow, message: doneNow ? ("到点 / done: " + name) : ("还没到 / pending: " + name) };
}

// 通用比较：支持 eq / ne / gt / gte / lt / lte / contains，类型不对按字符串比。
function compare(got, op, wanted) {
  var operator = toText(op || "eq").toLowerCase();
  try {
    if (operator === "gt") return toNum(got, 0) > toNum(wanted, 0);
    if (operator === "gte") return toNum(got, 0) >= toNum(wanted, 0);
    if (operator === "lt") return toNum(got, 0) < toNum(wanted, 0);
    if (operator === "lte") return toNum(got, 0) <= toNum(wanted, 0);
    if (operator === "ne") return toText(got) !== toText(wanted);
    if (operator === "contains") return toText(got).indexOf(toText(wanted)) >= 0;
    return toText(got) === toText(wanted);
  } catch (e) { return false; }
}

// 计数 1：计数器加一（步长默认 1），同时写进 vars 方便条件判断。
async function counterInc(ctx, args) {
  var name = cleanName(args.name || "counter");
  if (name.length === 0) return { ok: false, message: "name 不能为空 / name required" };
  var step = toNum(args.step, 1);
  var before = toNum(ctx.counters ? ctx.counters[name] : 0, 0);
  var after = before + step;
  try {
    if (ctx.counters) ctx.counters[name] = after;
    ctx.vars[name] = after;
  } catch (e) { return { ok: false, message: getErrText(e) }; }
  return { ok: true, name: name, value: after, message: name + " = " + after };
}

// 计数 2：计数器清零。
async function counterReset(ctx, args) {
  var name = cleanName(args.name || "counter");
  if (name.length === 0) return { ok: false, message: "name 不能为空 / name required" };
  try {
    if (ctx.counters) ctx.counters[name] = 0;
    ctx.vars[name] = 0;
  } catch (e) { return { ok: false, message: getErrText(e) }; }
  return { ok: true, name: name, value: 0, message: name + " 已清零 / reset" };
}

// 流程 1：比较一个变量（结果写进 vars.compare），方便后面用条件跳转。
async function checkVar(ctx, args) {
  var name = cleanName(args.name);
  if (name.length === 0) return { ok: false, message: "name 不能为空 / name required" };
  var got = null;
  try { got = ctx.vars[name]; } catch (e) { got = undefined; }
  var okNow = compare(got, args.op, args.value);
  try { ctx.vars.compare = okNow; } catch (e) { /* ignore */ }
  return { ok: true, matched: okNow, value: got, message: name + (okNow ? " 满足条件 / matched" : " 不满足 / not matched") };
}

// 事件 1：发一个内部事件（写进 ctx.events 与 vars.events，供后面的条件判断用）。
async function emitEvent(ctx, args) {
  var name = cleanName(args.name || args.event);
  if (name.length === 0) return { ok: false, message: "name 不能为空 / name required" };
  var payload = (args.payload === undefined) ? true : args.payload;
  try {
    if (!ctx.events) ctx.events = {};
    ctx.events[name] = payload;
    if (!ctx.vars.events) ctx.vars.events = {};
    ctx.vars.events[name] = payload;
  } catch (e) { return { ok: false, message: getErrText(e) }; }
  return { ok: true, name: name, message: "事件已发出 / event emitted: " + name };
}

// 事件 2：检查最近一条聊天里有没有关键词，结果写进 vars.chatMatched。
async function onChatKeyword(ctx, args) {
  var keyword = toText(args.keyword || args.text).toLowerCase();
  if (keyword.length === 0) return { ok: false, message: "keyword 不能为空 / keyword required" };
  var chat = "";
  try { chat = toText(ctx.events ? ctx.events.chat : ""); } catch (e) { chat = ""; }
  if (chat.length === 0 && ctx.bot) chat = toText(ctx.bot._mbLastChat);
  var matched = chat.toLowerCase().indexOf(keyword) >= 0;
  try { ctx.vars.chatMatched = matched; ctx.vars.lastChat = chat; } catch (e) { /* ignore */ }
  return { ok: true, matched: matched, message: matched ? ("聊天命中 / chat matched: " + keyword) : "聊天未命中 / chat not matched" };
}

// 事件 3：检查某个玩家是否在附近（radius 格内），结果写进 vars.playerNear。
async function onPlayerNear(ctx, args) {
  var player = toText(args.player).trim();
  if (player.length === 0) return { ok: false, message: "player 不能为空 / player required" };
  var radius = toNum(args.radius, 16);
  if (radius <= 0) radius = 16;
  var near = false;
  var pos = null;
  try {
    var entity = ctx.bot && ctx.bot.players && ctx.bot.players[player] ? ctx.bot.players[player].entity : null;
    if (entity) {
      pos = util ? util.posOf(ctx.bot) : null;
      var target = { x: toNum(entity.position ? entity.position.x : NaN, NaN), y: toNum(entity.position ? entity.position.y : NaN, NaN), z: toNum(entity.position ? entity.position.z : NaN, NaN) };
      if (pos && !isNaN(target.x)) near = (util ? util.distanceOf(pos, target) : Infinity) <= radius;
    }
  } catch (e) { near = false; }
  try { ctx.vars.playerNear = near; } catch (e) { /* ignore */ }
  return { ok: true, matched: near, message: near ? (player + " 在附近 / nearby") : (player + " 不在附近 / not nearby") };
}

// 常量：本文件负责的动作名 → 实现（时间流程 + 事件）。
var HANDLERS = {
  delay: delay,
  set_timer: setTimer,
  timer_done: timerDone,
  counter_inc: counterInc,
  counter_reset: counterReset,
  check_var: checkVar,
  emit_event: emitEvent,
  on_chat_keyword: onChatKeyword,
  on_player_near: onPlayerNear
};

// 常量：本文件支持的动作名列表。
var NAMES = [];
try { NAMES = Object.keys(HANDLERS); } catch (e) { NAMES = []; }

// 判断本文件是否支持某个动作名。
function has(name) {
  try { return Object.prototype.hasOwnProperty.call(HANDLERS, toText(name)); } catch (e) { return false; }
}

// 取某个动作的实现，没有返回 null（调用方必须判空）。
function pick(name) {
  try {
    var key = toText(name);
    return Object.prototype.hasOwnProperty.call(HANDLERS, key) ? HANDLERS[key] : null;
  } catch (e) { return null; }
}

// 对外导出：动作表 + 名单 + 查询函数 + 通用比较（自测直接调）。
module.exports = {
  HANDLERS: HANDLERS,
  NAMES: NAMES,
  has: has,
  pick: pick,
  compare: compare
};


