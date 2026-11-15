// ========================================
// 文件：modules/state-nodes.js
// 功能：状态机节点总表 + 统一派发——10 大分类（基础 / 感知 / 物品 / 生存 / 数学 / 流程 / AI / 多 Bot / 宏 / 高级 / 触发器）
//       + 高维建筑节点 place_block_exact（属性不符自动破坏重放）
// 依赖：./state-skills、./state-skills-plus、./state-skills-ai、./state-skills-flow、./state-skills-build、
//       ./state-macros、./state-skills-trigger、./actions-catalog（都可选）
// 导出：CATEGORIES / ALL / isAction / categoryOf / execute / getCatalog / NAMES
// 作者：MineBots
// ========================================
//
// 说明：每个技能文件只负责自己那一类动作，本文件负责「按名字找到实现并调用」，
//       因此新增节点只要在对应技能文件的 HANDLERS 里加一行，这里自动生效。
// ES5 风格，CommonJS，无中文变量名
var util = null;
try { util = require("./state-util"); } catch (e) { util = null; }

// 可选依赖：四组技能实现（基础+多 Bot / 感知+物品+生存 / 数学+AI / 流程+事件）+ 宏节点。
var basic = null;
try { basic = require("./state-skills"); } catch (e) { basic = null; }
var plus = null;
try { plus = require("./state-skills-plus"); } catch (e) { plus = null; }
var aiSkills = null;
try { aiSkills = require("./state-skills-ai"); } catch (e) { aiSkills = null; }
var flowSkills = null;
try { flowSkills = require("./state-skills-flow"); } catch (e) { flowSkills = null; }
var macros = null;
try { macros = require("./state-macros"); } catch (e) { macros = null; }

// 可选依赖：触发器节点（下坠 / 被瞄准 / 背包满 / 没吃的 / 队友血低 / 正在挨打）。
var triggers = null;
try { triggers = require("./state-skills-trigger"); } catch (e) { triggers = null; }

// 可选依赖：高维建筑技能（place_block_exact）；缺失时该节点返回未知动作，其余节点不受影响。
var buildSkills = null;
try { buildSkills = require("./state-skills-build"); } catch (e) { buildSkills = null; }

// 可选依赖：高级动作目录（16 个高级动作：搭桥 / 落地水 / 盾墙 / 交易 / 存取箱 …）。
var catalog = null;
try { catalog = require("./actions-catalog"); } catch (e) { catalog = null; }

// 可选依赖：日志核心，缺失时退回 console。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：10 大分类的动作名清单（顺序即 GUI 下拉顺序）。
var CATEGORIES = {
  basic: ["move_to", "move_to_player", "dig_block", "dig_tree", "mine", "follow", "attack", "place_block", "place_block_exact", "craft", "collect", "stop", "wait", "chat", "set_var"],
  perception: ["scan_entities", "find_block", "get_status", "count_item", "distance_to"],
  item: ["equip_item", "drop_item", "take_item", "store_item"],
  survival: ["auto_eat", "flee", "pillar_up", "use_item"],
  math: ["var_add", "var_mul", "calc", "random_int", "var_copy"],
  flow: ["delay", "set_timer", "timer_done", "counter_inc", "counter_reset", "check_var", "emit_event", "on_chat_keyword", "on_player_near"],
  ai: ["ask_ai", "ai_decide"],
  multi: ["broadcast", "whisper_bot", "wait_for_bot", "assign_task"],
  macro: ["gather_resource", "farm_area", "safe_guard", "survive"],
  advanced: ["auto_bridge", "mlg_water", "dodge_arrow", "eat_golden_apple", "shield_wall", "lure_mobs_to_trap", "ignite_tnt", "pillar_bridge", "trade_with_villager", "bonemeal_crop", "place_redstone_circuit", "sort_inventory", "chest_deposit_all", "chest_withdraw_stack", "drop_stack_to_ally", "give_potion_to_ally"],
  trigger: ["trigger_fall", "trigger_aimed", "trigger_inventory_full", "trigger_food_out", "trigger_ally_low", "trigger_under_attack"]
};

// 常量：技能模块清单（按顺序查，命中即用）；高级动作走适配器，触发器走自己的模块。
var MODULES = [basic, plus, aiSkills, flowSkills, macros, triggers, buildSkills, makeCatalogAdapter()];

// 常量：全部动作名（去重、去掉空模块）。
var NAMES = [];
try {
  for (var c in CATEGORIES) {
    if (!Object.prototype.hasOwnProperty.call(CATEGORIES, c)) continue;
    for (var i = 0; i < CATEGORIES[c].length; i++) {
      if (NAMES.indexOf(CATEGORIES[c][i]) < 0) NAMES.push(CATEGORIES[c][i]);
    }
  }
} catch (e) { NAMES = []; }

// 常量：动作名 → 分类（反查表，校验与 GUI 提示都用它）。
var CATEGORY_OF = {};
try {
  for (var key in CATEGORIES) {
    if (!Object.prototype.hasOwnProperty.call(CATEGORIES, key)) continue;
    for (var k = 0; k < CATEGORIES[key].length; k++) CATEGORY_OF[CATEGORIES[key][k]] = key;
  }
} catch (e) { CATEGORY_OF = {}; }

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

// 写文件日志：节点执行属于高频信息，只落文件。
function logInfo(msg) {
  try {
    if (logger && typeof logger.info === "function") { logger.info("[state-nodes] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[state-nodes] " + msg); } catch (e) { /* ignore */ }
}

// 判断动作名是否在总表里（大小写不敏感，前后空白自动去掉）。
function isAction(name) {
  var key = toText(name).replace(/^\s+|\s+$/g, "").toLowerCase();
  if (key.length === 0) return false;
  return NAMES.indexOf(key) >= 0;
}

// 反查动作名属于哪个分类，查不到返回空串。
function categoryOf(name) {
  var key = toText(name).replace(/^\s+|\s+$/g, "").toLowerCase();
  if (key.length === 0) return "";
  return CATEGORY_OF[key] ? String(CATEGORY_OF[key]) : "";
}

// 构造高级动作适配器：把 actions-catalog 的 (bot, args) 签名适配成状态机的 (ctx, args)。
function makeCatalogAdapter() {
  return {
    pick: function (name) {
      if (!catalog || typeof catalog.pick !== "function") return null;
      var impl = null;
      try { impl = catalog.pick(name); } catch (e) { impl = null; }
      if (typeof impl !== "function") return null;
      return async function (ctx, args) {
        var bot = ctx ? ctx.bot : null;
        return await impl(bot, args || {});
      };
    }
  };
}

// 在技能模块里找实现：找到返回函数，找不到返回 null。
function findHandler(name) {
  var key = toText(name).replace(/^\s+|\s+$/g, "").toLowerCase();
  for (var i = 0; i < MODULES.length; i++) {
    var mod = MODULES[i];
    if (!mod || typeof mod.pick !== "function") continue;
    try {
      var handler = mod.pick(key);
      if (typeof handler === "function") return handler;
    } catch (e) { /* 换下一个模块 */ }
  }
  return null;
}

// 功能：执行一个节点动作——先解析变量，再找实现，最后统一兜住异常，永远返回 { ok, message }。
async function execute(ctx, action, args) {
  var name = toText(action).replace(/^\s+|\s+$/g, "").toLowerCase();
  if (name.length === 0) return { ok: false, message: "action 不能为空 / action required" };
  var handler = findHandler(name);
  if (typeof handler !== "function") return { ok: false, message: "未知节点动作 / unknown action: " + name };
  var box = (ctx && typeof ctx === "object") ? ctx : {};
  if (!box.vars || typeof box.vars !== "object") box.vars = {};
  if (!box.counters || typeof box.counters !== "object") box.counters = {};
  if (!box.events || typeof box.events !== "object") box.events = {};
  var realArgs = util ? util.resolveArgs(args || {}, box.vars) : (args || {});
  var started = Date.now();
  var res = null;
  try {
    res = await handler(box, realArgs);
  } catch (err) {
    logInfo(name + " 异常 / error: " + getErrText(err));
    return { ok: false, action: name, message: getErrText(err), elapsed: Date.now() - started };
  }
  var out = (res && typeof res === "object") ? res : { ok: true, value: res };
  out.action = name;
  out.elapsed = Date.now() - started;
  try { box.last = out; } catch (e) { /* ignore */ }
  return out;
}

// 功能：返回节点目录（分类 / 分类动作 / 总数），GUI 拿来渲染下拉框。
function getCatalog() {
  var out = { categories: {}, counts: {}, total: 0 };
  try {
    for (var key in CATEGORIES) {
      if (!Object.prototype.hasOwnProperty.call(CATEGORIES, key)) continue;
      var list = CATEGORIES[key].slice();
      out.categories[key] = list;
      out.counts[key] = list.length;
      out.total += list.length;
    }
  } catch (e) { /* 返回已拼好的部分 */ }
  return out;
}

// 对外导出：分类表 / 全部动作名 / 查询与派发函数。
module.exports = {
  CATEGORIES: CATEGORIES,
  CATEGORY_OF: CATEGORY_OF,
  NAMES: NAMES,
  ALL: NAMES,
  isAction: isAction,
  categoryOf: categoryOf,
  execute: execute,
  getCatalog: getCatalog
};

