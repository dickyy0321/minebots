// ========================================
// 文件：modules/chat-permissions.js
// 功能：游戏内指令权限表——按玩家等级决定哪些动作能被执行（纯函数，不读盘、不联网）
// 依赖：无（日志与回话由调用方负责）
// 导出：filterActions、isAllowed、isHostile、isTrusted、normalizeLevel、actionName、DENY_TEXT、BASIC_ACTIONS、LEVELS
// 作者：MineBots
// ========================================
//
// 等级 → 允许的动作 / policy
//   owner / close_friend   全部放行 / everything allowed
//   friend                 move、dig、dig_block、dig_tree、collect、follow
//   normal                 只能聊天，不能指挥 / chat only
//   hostile / targeted     全部拒绝（是否反击由调用方决定）/ deny everything
// 说明：白名单制——查不到等级或动作名不认识的，一律按拒绝处理（宁严不松）。
// ES5 风格，CommonJS，无中文变量名

// 常量：拒绝时回给玩家的两句话（按玩家语言二选一，绝不同时发）。
var DENY_TEXT = "你没有权限执行此指令 / You don't have permission.";
// 常量：单语拒绝句——中文 / 英文各一条，由 denyText(lang) 取用。
var DENY_ZH = "你没有权限执行此指令";
var DENY_EN = "You don't have permission.";
// 常量：friend 等级允许的基础动作（移动 / 采集合成以外的动作一律拒绝）。
var BASIC_ACTIONS = ["move", "dig", "dig_block", "dig_tree", "collect", "follow"];
// 常量：全部等级（顺序与 player-manager 一致）。
var LEVELS = ["owner", "close_friend", "friend", "normal", "hostile", "targeted"];
// 常量：默认等级——等级缺失 / 非法时按这个处理。
var DEFAULT_LEVEL = "normal";
// 常量：完全信任的等级 / 敌对等级（数组判定，改策略只动这两行）。
var TRUSTED_LEVELS = ["owner", "close_friend"];
var HOSTILE_LEVELS = ["hostile", "targeted"];

// 安全转字符串：null / undefined 统一成空串，避免调用方传 undefined 崩掉。
function toText(value) {
  if (value === null || value === undefined) return "";
  try { return String(value); } catch (e) { return ""; }
}

// 从队列项里取动作名：支持 { action } 与直接传字符串，统一转小写并去空白。
function actionName(item) {
  try {
    if (item && typeof item === "object") return toText(item.action).toLowerCase().trim();
    return toText(item).toLowerCase().trim();
  } catch (e) { return ""; }
}

// 把任意来源的等级洗成合法值：不认识的一律按 normal 处理。
function normalizeLevel(level) {
  var wanted = toText(level).toLowerCase().trim();
  for (var i = 0; i < LEVELS.length; i++) {
    if (LEVELS[i] === wanted) return wanted;
  }
  return DEFAULT_LEVEL;
}

// 是不是完全信任（owner / close_friend）：全部动作放行。
function isTrusted(level) {
  var wanted = normalizeLevel(level);
  for (var i = 0; i < TRUSTED_LEVELS.length; i++) {
    if (TRUSTED_LEVELS[i] === wanted) return true;
  }
  return false;
}

// 是不是敌对（hostile / targeted）：全部动作拒绝，调用方可以选择反击。
function isHostile(level) {
  var wanted = normalizeLevel(level);
  for (var i = 0; i < HOSTILE_LEVELS.length; i++) {
    if (HOSTILE_LEVELS[i] === wanted) return true;
  }
  return false;
}

// 单个动作是否允许：信任级全放行，friend 只放基础动作，其余（含空动作名）一律拒绝。
function isAllowed(level, action) {
  try {
    var wanted = normalizeLevel(level);
    if (isTrusted(wanted)) return true;
    if (wanted !== "friend") return false;
    var name = actionName(action);
    if (name.length === 0) return false;
    for (var i = 0; i < BASIC_ACTIONS.length; i++) {
      if (BASIC_ACTIONS[i] === name) return true;
    }
    return false;
  } catch (e) { return false; }
}

// 功能：按等级拆分动作队列，返回 { level, allowed, denied, blocked, message }，任何异常都按全拒绝处理。
function filterActions(level, actions) {
  var wanted = normalizeLevel(level);
  var out = { level: wanted, allowed: [], denied: [], blocked: false, message: "" };
  try {
    var list = Array.isArray(actions) ? actions : [];
    for (var i = 0; i < list.length; i++) {
      if (isAllowed(wanted, list[i])) out.allowed.push(list[i]);
      else out.denied.push(list[i]);
    }
  } catch (e) {
    out.allowed = [];
    out.denied = [];
    out.blocked = true;
    out.message = DENY_TEXT;
    return out;
  }
  if (out.denied.length > 0) {
    out.message = DENY_TEXT;
    out.blocked = out.allowed.length === 0;
  }
  return out;
}

// 功能：按玩家语言取拒绝句——只返回一种语言（中文玩家只看中文，英文玩家只看英文）。
function denyText(lang) {
  try { return String(lang || "").toLowerCase() === "en" ? DENY_EN : DENY_ZH; }
  catch (e) { return DENY_ZH; }
}

// 对外导出：策略常量 + 4 个判定函数 + 1 个批量过滤函数 + 1 个单语拒绝句。
module.exports = {
  filterActions: filterActions,
  isAllowed: isAllowed,
  isHostile: isHostile,
  isTrusted: isTrusted,
  normalizeLevel: normalizeLevel,
  actionName: actionName,
  denyText: denyText,
  DENY_TEXT: DENY_TEXT,
  DENY_ZH: DENY_ZH,
  DENY_EN: DENY_EN,
  BASIC_ACTIONS: BASIC_ACTIONS,
  LEVELS: LEVELS
};
