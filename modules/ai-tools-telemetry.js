// ========================================
// 文件：modules/ai-tools-telemetry.js
// 功能：AI 遥测工具（单件套）——get_bot_state：把机器人实时状态一句话讲给 AI 听
// 依赖：./telemetry（可选）、./chat-permissions（可选）、./logger（可选）
// 导出：getTools / filterTools / toolAllowed / isTelemetryTool / executeTool / TOOL_NAMES / TOOL_ACTIONS
// 作者：MineBots
// ========================================
//
// 安全约定：
//   1. 纯查询工具，不做任何破坏性动作，也不抢占正在跑的任务。
//   2. 权限走白名单的 query 等级；权限模块缺失一律拒绝（宁严不松）。
//   3. 遥测模块缺失 / 采集异常时返回「执行失败」双语文本，绝不抛错到上层。
// ES5 风格，CommonJS，无中文变量名
var telemetry = null;
try { telemetry = require("./telemetry"); } catch (e) { telemetry = null; }

// 可选依赖：权限表（缺失时 toolAllowed 一律拒绝）。
var permissions = null;
try { permissions = require("./chat-permissions"); } catch (e) { permissions = null; }

// 可选依赖：日志核心，缺失时退回 console。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 可选依赖：五级 JSON 修复引擎；AI 的 tool_calls.arguments 一律经它解析。
var jsonRepair = null; try { jsonRepair = require("./json-repair"); } catch (e) { jsonRepair = null; }

// 强制五级解析：引擎缺失时退回原生解析，失败返回 fallback，绝不抛错。
function safeJson(text, fallback) {
  try { if (jsonRepair) return jsonRepair.safeParse(text, fallback); return JSON.parse(toText(text)); }
  catch (e) { return fallback; }
}

// 常量：工具名 / 最近事件默认条数 / 回话里最多列几条事件与背包。
var STATE_TOOL = "get_bot_state";
var TOOL_NAMES = [STATE_TOOL];
var DEFAULT_EVENTS = 3;
var MAX_EVENTS_TEXT = 10;
var INVENTORY_TEXT = 8;

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

// 转数字（非法值返回兜底值）。
function toNum(value, fallback) {
  try {
    var n = Number(value);
    return isNaN(n) ? fallback : n;
  } catch (e) { return fallback; }
}

// 写文件日志：查询工具属高频信息，只落文件不推 GUI。
function logInfo(msg) {
  try {
    if (logger && typeof logger.info === "function") { logger.info("[ai-tools-telemetry] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[ai-tools-telemetry] " + msg); } catch (e2) { /* ignore */ }
}

// 写告警日志：只有工具被拒 / 执行失败才用（要让人看见）。
function logWarn(msg) {
  try {
    if (logger && typeof logger.warn === "function") { logger.warn("[ai-tools-telemetry] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.warn("[ai-tools-telemetry] " + msg); } catch (e2) { /* ignore */ }
}

// 组装一个 OpenAI 格式的工具定义。
function tool(name, description, props, required) {
  return {
    type: "function",
    function: {
      name: name,
      description: description,
      parameters: { type: "object", properties: props || {}, required: required || [] }
    }
  };
}

// 参数描述：整数，一律「中文 / English」。
function intProp(zh, en) { return { type: "integer", description: zh + " / " + en }; }

// 常量：工具菜单（只有 get_bot_state 一个）。
var TOOLS = [
  tool(STATE_TOOL, "读取机器人实时状态：血量 / 饥饿 / 经验 / 坐标 / 维度 / 昼夜 / 主副手 / 背包 / 最近事件 / Read the live bot state", {
    events: intProp("返回最近几条事件，默认 3，最多 10", "recent events count, default 3, max 10")
  }, [])
];

// 常量：工具 → 权限动作名（纯查询，走 query）。
var TOOL_ACTIONS = {};
TOOL_ACTIONS[STATE_TOOL] = "query";

// 工具名归一化：去空白、转小写，兼容部分模型带的 functions. 前缀。
function normalizeName(toolName) {
  var key = toText(toolName).replace(/^\s+|\s+$/g, "").toLowerCase();
  if (key.indexOf("functions.") === 0) key = key.slice(10);
  return key;
}

// 判断一个名字是不是遥测工具（大小写不敏感，兼容 functions. 前缀）。
function isTelemetryTool(name) {
  return TOOL_NAMES.indexOf(normalizeName(name)) >= 0;
}

// 功能：返回工具菜单副本（调用方随便改都不会污染内部定义）。
function getTools() {
  return TOOLS.slice(0);
}

// 单个工具是否允许：权限模块缺失一律拒绝；敌对等级全拒。
function toolAllowed(level, toolName) {
  var key = normalizeName(toolName);
  if (TOOL_NAMES.indexOf(key) < 0) return false;
  if (!permissions || typeof permissions.isAllowed !== "function") return false;
  try {
    if (typeof permissions.isHostile === "function" && permissions.isHostile(level)) return false;
    return permissions.isAllowed(level, TOOL_ACTIONS[key]);
  } catch (e) { return false; }
}

// 功能：按等级裁剪工具菜单——没权限的玩家连看都看不到。
function filterTools(level) {
  var out = [];
  try {
    for (var i = 0; i < TOOLS.length; i++) {
      if (toolAllowed(level, TOOLS[i].function.name)) out.push(TOOLS[i]);
    }
  } catch (e) { return []; }
  return out;
}

// 把参数解析成对象：接受对象或脏 JSON 字符串，强制五级修复，全败返回 null。
function parseArgs(args) {
  if (!args) return {};
  if (typeof args === "object") return args;
  var parsed = safeJson(args, null);
  return (parsed && typeof parsed === "object") ? parsed : null;
}

// 双语失败文本：交给 chat-handler 直接喂回 AI。
function failText(toolName, reason) {
  return "执行失败 / failed: " + toText(toolName) + " - " + toText(reason);
}

// 坐标转一句话：读不到坐标就回 unknown。
function posText(pos) {
  try {
    if (!pos) return "unknown";
    return "(" + toText(pos.x) + ", " + toText(pos.y) + ", " + toText(pos.z) + ")";
  } catch (e) { return "unknown"; }
}

// 物品转一句话（name x count）；没有物品回 none。
function itemText(item) {
  try {
    if (!item || !item.name) return "none";
    return toText(item.name) + " x" + toText(item.count);
  } catch (e) { return "none"; }
}

// 背包转一句话：最多列 INVENTORY_TEXT 类，后面用 +N 收尾。
function inventoryText(list) {
  try {
    var arr = Array.isArray(list) ? list : [];
    if (arr.length === 0) return "empty";
    var parts = [];
    for (var i = 0; i < arr.length && i < INVENTORY_TEXT; i++) parts.push(itemText(arr[i]));
    if (arr.length > INVENTORY_TEXT) parts.push("+" + (arr.length - INVENTORY_TEXT));
    return parts.join(", ");
  } catch (e) { return "empty"; }
}

// 最近事件转一句话：只列事件名，最多 MAX_EVENTS_TEXT 条。
function eventsText(list) {
  try {
    var arr = Array.isArray(list) ? list : [];
    if (arr.length === 0) return "none";
    var parts = [];
    var start = Math.max(0, arr.length - MAX_EVENTS_TEXT);
    for (var i = start; i < arr.length; i++) {
      var ev = arr[i] || {};
      var label = toText(ev.type).length > 0 ? toText(ev.type) : toText(ev.name);
      parts.push(label.length > 0 ? label : "event");
    }
    return parts.join(", ");
  } catch (e) { return "none"; }
}

// 功能：把采集到的状态打包成一句中英双语描述（AI 拿去二次回答）。
function describeState(state, events) {
  var h = (state.health === null || state.health === undefined) ? "unknown" : toText(state.health);
  var f = (state.food === null || state.food === undefined) ? "unknown" : toText(state.food);
  var lv = state.experience ? toText(state.experience.level) : "0";
  var phase = state.time ? toText(state.time.phase) : "unknown";
  var parts = [];
  parts.push("id=" + toText(state.id));
  parts.push("血量 / health=" + h);
  parts.push("饥饿 / food=" + f);
  parts.push("经验等级 / xp level=" + lv);
  parts.push("坐标 / position=" + posText(state.position));
  parts.push("维度 / dimension=" + toText(state.dimension));
  parts.push("昼夜 / phase=" + phase);
  parts.push("主手 / main hand=" + itemText(state.mainHand));
  parts.push("副手 / off hand=" + itemText(state.offHand));
  parts.push("背包 / inventory=" + inventoryText(state.inventory));
  parts.push("最近事件 / recent events=" + eventsText(events));
  return "成功 / ok: " + STATE_TOOL + " -> " + parts.join("; ");
}

// 功能：执行 get_bot_state——采集状态 + 最近事件；任何异常都降级成失败文本。
function executeTool(bot, botId, toolName, args) {
  var key = normalizeName(toolName);
  if (!isTelemetryTool(key)) return failText(key.length > 0 ? key : "?", "未知工具 / unknown tool");
  if (!bot) return failText(key, "bot not ready / 机器人未就绪");
  if (!telemetry || typeof telemetry.getBotState !== "function") {
    return failText(key, "telemetry unavailable / 遥测模块不可用");
  }
  var realArgs = parseArgs(args);
  if (!realArgs) return failText(key, "参数不是合法 JSON / arguments are not valid JSON");
  try {
    var state = telemetry.getBotState(bot);
    if (!state || state.ok !== true) {
      return failText(key, toText(state ? state.message : "state collect failed / 状态采集失败"));
    }
    var limit = Math.round(toNum(realArgs.events, DEFAULT_EVENTS));
    if (limit <= 0) limit = DEFAULT_EVENTS;
    if (limit > MAX_EVENTS_TEXT) limit = MAX_EVENTS_TEXT;
    var events = [];
    if (typeof telemetry.recentEvents === "function") events = telemetry.recentEvents(bot, limit);
    var text = describeState(state, events);
    logInfo("state queried" + (toText(botId).length > 0 ? " @ " + toText(botId) : ""));
    return text;
  } catch (err) {
    logWarn(key + " 执行异常 / failed: " + getErrText(err));
    return failText(key, getErrText(err));
  }
}

// 对外导出：菜单 / 权限裁剪 / 判定 / 执行 + 名单与动作映射。
module.exports = {
  getTools: getTools,
  filterTools: filterTools,
  toolAllowed: toolAllowed,
  isTelemetryTool: isTelemetryTool,
  executeTool: executeTool,
  TOOL_NAMES: TOOL_NAMES,
  TOOL_ACTIONS: TOOL_ACTIONS
};
