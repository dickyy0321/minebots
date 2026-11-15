// ========================================
// 文件：modules/state-util.js
// 功能：状态机公共工具——日志 / 数值清洗 / 变量替换 / 背包与方块查询 / 非阻塞 sleep
// 依赖：./logger（可选）
// 导出：toText / toNum / clampNum / getErrText / logInfo / logWarn / logSystem / sleep /
//       isBotReady / posOf / posText / distanceOf / resolveValue / resolveArgs /
//       inventoryItems / findItem / countItem / hasItem / itemNames / nearestBlock / blockName
// 作者：MineBots
// ========================================
//
// 说明：state-skills*.js / state-macros.js / state-nodes.js 全部依赖本文件，
//       所有函数都不抛异常（出错只返回兜底值），保证状态机主循环不会被单个节点拖死。
// ES5 风格，CommonJS，无中文变量名
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：变量引用前缀（$name / $name.index / $name.key）。
var VAR_PREFIX = "$";

// 安全提取错误文本，catch 里不会二次抛错。
function getErrText(err) {
  try {
    if (err && err.message) return String(err.message);
    return String(err);
  } catch (e) { return "unknown error"; }
}

// 转文本：null / undefined 一律变空串。
function toText(value) {
  try {
    if (value === null || value === undefined) return "";
    return String(value);
  } catch (e) { return ""; }
}

// 转数字：解析失败返回兜底值（兜底默认 0）。
function toNum(value, fallback) {
  var base = (fallback === undefined) ? 0 : fallback;
  try {
    if (typeof value === "number") return isFinite(value) ? value : base;
    var num = parseFloat(toText(value));
    return isNaN(num) ? base : num;
  } catch (e) { return base; }
}

// 取整并夹在 [min, max] 之间，越界一律拉回边界。
function clampNum(value, min, max, fallback) {
  var num = toNum(value, fallback === undefined ? min : fallback);
  if (num < min) num = min;
  if (num > max) num = max;
  return Math.round(num);
}

// 写文件日志（不推 GUI）：周期性状态、轮询一律走这里，避免刷屏。
function logInfo(msg) {
  try {
    if (logger && typeof logger.info === "function") { logger.info("[state] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[state] " + msg); } catch (e) { /* ignore */ }
}

// 写告警日志（推 GUI）：只在真正需要用户知道时调用。
function logWarn(msg) {
  try {
    if (logger && typeof logger.warn === "function") { logger.warn("[state] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.warn("[state] " + msg); } catch (e) { /* ignore */ }
}

// 写系统日志（推 GUI）：状态机启动 / 停止这类一次性事件用它。
function logSystem(msg) {
  try {
    if (logger && typeof logger.system === "function") { logger.system("[state] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[state] " + msg); } catch (e) { /* ignore */ }
}

// 非阻塞等待：定时器 unref，绝不拖住进程；毫秒非法时按 0 处理。
function sleep(ms) {
  var wait = toNum(ms, 0);
  if (wait < 0) wait = 0;
  if (wait > 30000) wait = 30000;
  return new Promise(function (resolve) {
    try {
      var timer = setTimeout(function () { resolve(true); }, wait);
      if (timer && typeof timer.unref === "function") timer.unref();
    } catch (e) { resolve(false); }
  });
}

// 判断 bot 是否可用，不可用时返回 { ok:false, message }（双语）。
function isBotReady(bot) {
  if (!bot) return { ok: false, message: "bot not ready / 机器人未就绪" };
  try {
    if (!bot.entity) return { ok: false, message: "bot entity missing / 机器人实体未加载" };
  } catch (e) { return { ok: false, message: "bot not ready / 机器人未就绪" }; }
  return { ok: true };
}

// 读 bot 坐标（四舍五入到两位小数），读不到返回 null。
function posOf(bot) {
  try {
    var pos = bot && bot.entity && bot.entity.position;
    if (!pos) return null;
    return { x: Math.round(pos.x * 100) / 100, y: Math.round(pos.y * 100) / 100, z: Math.round(pos.z * 100) / 100 };
  } catch (e) { return null; }
}

// 把坐标格式化成 "(x, y, z)"，坐标缺失返回 "(?, ?, ?)"。
function posText(pos) {
  var p = pos || {};
  return "(" + toText(p.x) + ", " + toText(p.y) + ", " + toText(p.z) + ")";
}

// 计算两点距离（缺坐标返回 Infinity）。
function distanceOf(a, b) {
  try {
    if (!a || !b) return Infinity;
    var dx = toNum(a.x) - toNum(b.x);
    var dy = toNum(a.y) - toNum(b.y);
    var dz = toNum(a.z) - toNum(b.z);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  } catch (e) { return Infinity; }
}

// 按路径读变量：支持 "$a" / "$a.b" / "$a.0"，读不到返回 undefined。
function readVar(vars, path) {
  var text = toText(path);
  if (text.indexOf(VAR_PREFIX) === 0) text = text.slice(1);
  var parts = text.split(".");
  var cur = vars;
  for (var i = 0; i < parts.length; i++) {
    if (cur === null || cur === undefined) return undefined;
    try { cur = cur[parts[i]]; } catch (e) { return undefined; }
  }
  return cur;
}

// 递归替换参数里的 "$变量"：字符串整串引用返回原值，对象 / 数组逐项替换，其它原样返回。
function resolveValue(value, vars, depth) {
  var level = toNum(depth, 0);
  if (level > 6) return value;
  try {
    if (typeof value === "string") {
      if (value.length > 1 && value.charAt(0) === VAR_PREFIX) {
        var found = readVar(vars || {}, value);
        return (found === undefined) ? value : found;
      }
      return value;
    }
    if (Array.isArray(value)) {
      var list = [];
      for (var i = 0; i < value.length; i++) list.push(resolveValue(value[i], vars, level + 1));
      return list;
    }
    if (value && typeof value === "object") {
      var out = {};
      for (var key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        out[key] = resolveValue(value[key], vars, level + 1);
      }
      return out;
    }
    return value;
  } catch (e) { return value; }
}

// 替换整份参数对象（节点 args → 真实参数）。
function resolveArgs(args, vars) {
  if (!args || typeof args !== "object") return {};
  var out = resolveValue(args, vars || {}, 0);
  return (out && typeof out === "object") ? out : {};
}

// 列出背包里的物品（过滤空槽），出错返回空数组。
function inventoryItems(bot) {
  var out = [];
  try {
    var items = bot && bot.inventory ? bot.inventory.items() : null;
    if (!Array.isArray(items)) return out;
    for (var i = 0; i < items.length; i++) {
      if (items[i]) out.push(items[i]);
    }
  } catch (e) { /* 返回已收集到的部分 */ }
  return out;
}

// 按名字（可含子串）找背包物品，优先完全同名，找不到返回 null。
function findItem(bot, name) {
  var wanted = toText(name).toLowerCase();
  if (wanted.length === 0) return null;
  var items = inventoryItems(bot);
  var fuzzy = null;
  for (var i = 0; i < items.length; i++) {
    var itemName = toText(items[i].name).toLowerCase();
    if (itemName === wanted) return items[i];
    if (!fuzzy && itemName.indexOf(wanted) >= 0) fuzzy = items[i];
  }
  return fuzzy;
}

// 统计背包里某个物品的总数量，找不到返回 0。
function countItem(bot, name) {
  var wanted = toText(name).toLowerCase();
  if (wanted.length === 0) return 0;
  var total = 0;
  var items = inventoryItems(bot);
  for (var i = 0; i < items.length; i++) {
    var itemName = toText(items[i].name).toLowerCase();
    if (itemName === wanted || itemName.indexOf(wanted) >= 0) total += toNum(items[i].count, 0);
  }
  return total;
}

// 背包里是否至少有 1 个该物品。
function hasItem(bot, name) {
  return countItem(bot, name) > 0;
}

// 列出背包里所有物品名（去重），出错返回空数组。
function itemNames(bot) {
  var out = [];
  var items = inventoryItems(bot);
  for (var i = 0; i < items.length; i++) {
    var name = toText(items[i].name);
    if (name.length > 0 && out.indexOf(name) < 0) out.push(name);
  }
  return out;
}

// 读方块名：优先 block.name，其次 registry 查名，读不到返回空串。
function blockName(block) {
  try {
    if (!block) return "";
    if (block.name) return String(block.name);
    return "";
  } catch (e) { return ""; }
}

// 找最近的方块：wanted 可以是名字 / 名字数组 / 空（任意方块）；找不到返回 null。
function nearestBlock(bot, wanted, radius) {
  try {
    if (!bot || typeof bot.findBlock !== "function") return null;
    var limit = toNum(radius, 32);
    var list = [];
    if (Array.isArray(wanted)) list = wanted;
    else if (toText(wanted).length > 0) list = [toText(wanted)];
    var lowered = [];
    for (var i = 0; i < list.length; i++) lowered.push(toText(list[i]).toLowerCase());
    var matching = function (block) {
      if (lowered.length === 0) return true;
      var name = blockName(block).toLowerCase();
      if (name.length === 0) return false;
      for (var k = 0; k < lowered.length; k++) {
        if (name === lowered[k] || name.indexOf(lowered[k]) >= 0) return true;
      }
      return false;
    };
    return bot.findBlock({ matching: matching, maxDistance: limit });
  } catch (e) { return null; }
}

// 对外导出：全部公共工具。
module.exports = {
  toText: toText,
  toNum: toNum,
  clampNum: clampNum,
  getErrText: getErrText,
  logInfo: logInfo,
  logWarn: logWarn,
  logSystem: logSystem,
  sleep: sleep,
  isBotReady: isBotReady,
  posOf: posOf,
  posText: posText,
  distanceOf: distanceOf,
  readVar: readVar,
  resolveValue: resolveValue,
  resolveArgs: resolveArgs,
  inventoryItems: inventoryItems,
  findItem: findItem,
  countItem: countItem,
  hasItem: hasItem,
  itemNames: itemNames,
  nearestBlock: nearestBlock,
  blockName: blockName
};
