// ========================================
// 文件：modules/actions-catalog.js
// 功能：高级动作总目录——把 actions-advanced / actions-support 的 16 个动作并成一张表，
//       供状态机节点、AI 工具、GUI 面板按名字统一查询与执行
// 依赖：./actions-advanced（可选）、./actions-support（可选）、./logger（可选）
// 导出：NAMES / GROUPS / DESCRIPTIONS / list / has / pick / execute / count
// 作者：MineBots
// ========================================
//
// 约定：
//   1. 只做「查表 + 转发」，真正的实现留在 actions-advanced / actions-support 里。
//   2. 任一子模块缺失都只让对应动作消失，目录本身照常可用（不抛错）。
//   3. 执行结果统一 { ok, action, message }，失败一律 ok:false + 双语 message。
// ES5 风格，CommonJS，无中文变量名
var advanced = null;
try { advanced = require("./actions-advanced"); } catch (e) { advanced = null; }

var support = null;
try { support = require("./actions-support"); } catch (e) { support = null; }

// 可选依赖：日志核心，缺失时退回 console。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：两组动作名（顺序即 GUI / 文档顺序）。
var ADVANCED_NAMES = ["auto_bridge", "mlg_water", "dodge_arrow", "eat_golden_apple", "shield_wall", "lure_mobs_to_trap", "ignite_tnt", "pillar_bridge"];
var SUPPORT_NAMES = ["trade_with_villager", "bonemeal_crop", "place_redstone_circuit", "sort_inventory", "chest_deposit_all", "chest_withdraw_stack", "drop_stack_to_ally", "give_potion_to_ally"];

// 常量：动作 → 双语说明（GUI 悬停提示 / AI 提示词共用）。
var DESCRIPTIONS = {
  auto_bridge: "朝前铺方块搭桥 / Bridge forward with blocks",
  mlg_water: "落地前一格倒水免摔 / MLG water bucket before landing",
  dodge_arrow: "侧移躲箭 / Sidestep incoming arrows",
  eat_golden_apple: "吃金苹果回血 / Eat a golden apple",
  shield_wall: "副手举盾挡伤害 / Raise a shield in the off hand",
  lure_mobs_to_trap: "把怪引到陷阱点 / Lure mobs to the trap spot",
  ignite_tnt: "放 TNT 并点燃 / Place and ignite TNT",
  pillar_bridge: "跳搭垫脚往上升 / Pillar up by jumping and placing",
  trade_with_villager: "和村民交易 / Trade with a villager",
  bonemeal_crop: "骨粉催熟作物 / Bonemeal a crop",
  place_redstone_circuit: "铺一段红石线 / Place a redstone circuit",
  sort_inventory: "整理背包堆叠 / Merge inventory stacks",
  chest_deposit_all: "把背包塞进箱子 / Deposit everything into a chest",
  chest_withdraw_stack: "从箱子取一整组 / Withdraw one stack from a chest",
  drop_stack_to_ally: "把整组丢给队友 / Drop a stack for an ally",
  give_potion_to_ally: "给队友扔药水 / Toss a potion to an ally"
};

// 常量：分组表 + 全名单（按组顺序拼接）。
var GROUPS = { advanced: ADVANCED_NAMES, support: SUPPORT_NAMES };
var NAMES = ADVANCED_NAMES.concat(SUPPORT_NAMES);

// 写文件日志：目录查询属高频信息，只落文件不推 GUI。
function logInfo(msg) {
  try {
    if (logger && typeof logger.info === "function") { logger.info("[actions-catalog] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[actions-catalog] " + msg); } catch (e2) { /* ignore */ }
}

// 安全提取错误文本，catch 里不会二次抛错。
function errText(err) {
  try {
    if (!err) return "unknown error";
    if (err.message) return String(err.message);
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

// 双语失败对象（永不 reject 的返回值）。
function fail(action, message) {
  return { ok: false, action: toText(action), message: toText(message) };
}

// 分组名判断：advanced / support / 其它返回空串。
function groupOf(name) {
  var key = toText(name);
  if (ADVANCED_NAMES.indexOf(key) >= 0) return "advanced";
  if (SUPPORT_NAMES.indexOf(key) >= 0) return "support";
  return "";
}

// 判断目录里是否有这个动作名（大小写 / 空白不敏感）。
function has(name) {
  try {
    var key = toText(name).replace(/^\s+|\s+$/g, "").toLowerCase();
    return NAMES.indexOf(key) >= 0;
  } catch (e) { return false; }
}

// 取某个动作的实现函数，没有返回 null（调用方必须判空）。
function pick(name) {
  try {
    var key = toText(name).replace(/^\s+|\s+$/g, "").toLowerCase();
    if (ADVANCED_NAMES.indexOf(key) >= 0) {
      if (advanced && typeof advanced.pick === "function") return advanced.pick(key);
      return null;
    }
    if (SUPPORT_NAMES.indexOf(key) >= 0) {
      if (support && typeof support.pick === "function") return support.pick(key);
      return null;
    }
    return null;
  } catch (err) { logInfo("pick failed / 取动作失败: " + errText(err)); return null; }
}

// 功能：列出全部动作（名字 / 分组 / 说明 / 是否可用），GUI 与自检共用。
function list() {
  var out = [];
  try {
    for (var i = 0; i < NAMES.length; i++) {
      var name = NAMES[i];
      out.push({
        name: name,
        group: groupOf(name),
        description: toText(DESCRIPTIONS[name]),
        ready: pick(name) !== null
      });
    }
  } catch (err) { logInfo("list failed / 列目录失败: " + errText(err)); }
  return out;
}

// 功能：动作总数（只数真正有实现的）——自检与文档用。
function count() {
  var n = 0;
  try {
    for (var i = 0; i < NAMES.length; i++) { if (pick(NAMES[i]) !== null) n++; }
  } catch (err) { return n; }
  return n;
}

// 功能：按名字执行一个高级动作，统一成 { ok, action, message }，永不 reject。
async function execute(bot, name, args) {
  var key = toText(name).replace(/^\s+|\s+$/g, "").toLowerCase();
  if (!has(key)) return fail(key, "未知动作 / unknown action: " + key);
  if (!bot) return fail(key, "bot not ready / 机器人未就绪");
  var fn = pick(key);
  if (!fn) return fail(key, "动作模块不可用 / action module unavailable: " + key);
  try {
    var res = await fn(bot, args || {});
    if (res && typeof res === "object" && res.action === undefined) res.action = key;
    if (!res) return fail(key, "动作没有返回结果 / action returned nothing");
    return res;
  } catch (err) {
    logInfo(key + " 执行异常 / failed: " + errText(err));
    return fail(key, "动作执行异常 / action failed: " + errText(err));
  }
}

// 对外导出：名单 / 分组 / 说明 / 查询 / 执行。
module.exports = {
  NAMES: NAMES,
  GROUPS: GROUPS,
  DESCRIPTIONS: DESCRIPTIONS,
  ADVANCED_NAMES: ADVANCED_NAMES,
  SUPPORT_NAMES: SUPPORT_NAMES,
  list: list,
  has: has,
  pick: pick,
  execute: execute,
  count: count,
  groupOf: groupOf
};
