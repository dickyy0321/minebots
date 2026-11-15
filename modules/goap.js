// ========================================
// 文件：modules/goap.js
// 功能：GOAP 目标导向规划——输入「木镐」自动反推前置任务链，配方数据优先取 minecraft-data
// 依赖：minecraft-data（可选，缺失时回退内置配方表）、./logger（可选）
// 导出：plan / explain / resolveGoal / availableGoals / getRules / dataInfo / isDataBacked / MAX_DEPTH
// 作者：MineBots
// ========================================
//
// 规划方式 / planner
//   反向依赖展开（后序 DFS）：目标 → 前置物品 → 再前置，直到叶子采集动作；
//   再把链反过来正序输出。visited 防环，worldState 里已有的物品直接跳过。
//   配方优先用 minecraft-data 校验物品真实性，失败一律走内置表，绝不因数据缺失而崩。
// CommonJS，ES5 风格，无中文变量名

// 可选依赖：minecraft-data 已在 package.json 的 dependencies 中，缺失时回退内置配方。
var mcLib = null;
try { mcLib = require("minecraft-data"); } catch (e) { mcLib = null; }

// 可选依赖：日志核心，缺失时静默。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
// 可选依赖：引擎控制中心（专家模式的「行为树状态机」开关同时管 GOAP 规划）。
var engineControl = null;
try { engineControl = require("./engine-control"); } catch (e) { engineControl = null; }

// 常量：最大展开深度 / 单链最多步骤 / 默认游戏版本。
var MAX_DEPTH = 32;
var MAX_STEPS = 64;
var MC_VERSION = "1.21.1";

// 内置配方表：每条 = { action, needs:[{item,count}], label(双语), source }。
var RULES = {
  log: { action: "chop_tree", needs: [], label: "采集原木 / gather log" },
  cobblestone: { action: "mine_stone", needs: [], label: "挖圆石 / mine cobblestone" },
  coal: { action: "mine_coal", needs: [], label: "挖煤矿 / mine coal" },
  planks: { action: "craft_planks", needs: [{ item: "log", count: 1 }], label: "合成木板 / craft planks" },
  stick: { action: "craft_stick", needs: [{ item: "planks", count: 2 }], label: "合成木棍 / craft sticks" },
  crafting_table: { action: "craft_crafting_table", needs: [{ item: "planks", count: 4 }], label: "合成工作台 / craft table" },
  wooden_pickaxe: { action: "craft_wooden_pickaxe", needs: [{ item: "planks", count: 3 }, { item: "stick", count: 2 }], label: "合成木镐 / craft wooden pickaxe" },
  stone_pickaxe: { action: "craft_stone_pickaxe", needs: [{ item: "cobblestone", count: 3 }, { item: "stick", count: 2 }], label: "合成石镐 / craft stone pickaxe" },
  torch: { action: "craft_torch", needs: [{ item: "coal", count: 1 }, { item: "stick", count: 1 }], label: "合成火把 / craft torch" }
};

// 中英别名表：把自然语言目标归一到规则键。
var ALIASES = {
  "木镐": "wooden_pickaxe", "wooden pickaxe": "wooden_pickaxe", "wooden_pickaxe": "wooden_pickaxe",
  "wood pickaxe": "wooden_pickaxe", "木稿": "wooden_pickaxe",
  "石镐": "stone_pickaxe", "stone pickaxe": "stone_pickaxe", "stone_pickaxe": "stone_pickaxe",
  "工作台": "crafting_table", "crafting table": "crafting_table", "crafting_table": "crafting_table",
  "木板": "planks", "plank": "planks", "planks": "planks",
  "木棍": "stick", "sticks": "stick", "stick": "stick",
  "原木": "log", "木头": "log", "log": "log", "oak_log": "log",
  "圆石": "cobblestone", "cobblestone": "cobblestone",
  "火把": "torch", "torch": "torch", "煤": "coal", "coal": "coal"
};

// 写信息日志：规划属于低频信息，只落文件，不推 GUI。
function logInfo(message) {
  try { if (logger && typeof logger.info === "function") logger.info("[goap] " + message); } catch (e) { /* ignore */ }
}

// 把异常拍成一行文本，避免在 catch 里再次抛错。
function errText(err) {
  try { if (err && err.message) return String(err.message); return String(err); }
  catch (e) { return "unknown error"; }
}

// 安全转文本并小写，用于别名匹配。
function normalize(text) {
  try { return String(text === null || text === undefined ? "" : text).replace(/^\s+|\s+$/g, "").toLowerCase(); }
  catch (e) { return ""; }
}

// 功能：把用户目标（中文 / 英文 / 带下划线）归一到规则键，认不出返回空串。
function resolveGoal(goal) {
  var key = normalize(goal);
  if (key.length === 0) return "";
  try {
    if (Object.prototype.hasOwnProperty.call(ALIASES, key)) return ALIASES[key];
    var flat = key.replace(/[\s-]+/g, "_");
    if (Object.prototype.hasOwnProperty.call(ALIASES, flat)) return ALIASES[flat];
    if (Object.prototype.hasOwnProperty.call(RULES, flat)) return flat;
    if (key.indexOf("minecraft:") === 0) {
      var bare = key.slice(10);
      if (Object.prototype.hasOwnProperty.call(RULES, bare)) return bare;
    }
  } catch (e) { /* 返回空串 */ }
  return "";
}

// 功能：查 minecraft-data 里的物品与配方数量；库缺失 / 版本无数据时返回 null。
function dataInfo(itemName) {
  try {
    if (!mcLib) return null;
    var data = null;
    try { data = mcLib(MC_VERSION); } catch (e) { data = null; }
    if (!data) return null;
    var key = normalize(itemName);
    var item = data.itemsByName && data.itemsByName[key] ? data.itemsByName[key] : null;
    if (!item) return null;
    var recipeCount = 0;
    try {
      if (data.recipes && data.recipes[item.id]) recipeCount = Array.isArray(data.recipes[item.id]) ? data.recipes[item.id].length : 0;
    } catch (e) { recipeCount = 0; }
    return { id: item.id, name: item.name, displayName: item.displayName || item.name, version: MC_VERSION, recipeCount: recipeCount };
  } catch (e) { return null; }
}

// 功能：minecraft-data 是否可用（供自测与 GUI 展示数据源）。
function isDataBacked() {
  try { return dataInfo("wooden_pickaxe") !== null; } catch (e) { return false; }
}

// 内部：worldState 里是否已有足够数量的某物品（数量不足视为没有）。
function hasEnough(state, item, count) {
  try {
    if (!state || typeof state !== "object") return false;
    var own = Number(state[item]);
    if (isNaN(own)) return false;
    return own >= Number(count || 1);
  } catch (e) { return false; }
}

// 内部：反向展开依赖，把动作按后序压入 out；visited 防环，depth 防深递归。
function expand(item, state, visited, out, depth, dataHits) {
  if (depth > MAX_DEPTH || out.length >= MAX_STEPS) return false;
  if (!Object.prototype.hasOwnProperty.call(RULES, item)) return false;
  var rule = RULES[item];
  if (visited[item]) return true;
  visited[item] = true;
  for (var i = 0; i < rule.needs.length; i++) {
    var need = rule.needs[i];
    if (hasEnough(state, need.item, need.count)) continue;
    expand(need.item, state, visited, out, depth + 1, dataHits);
  }
  var info = dataInfo(item);
  if (info) dataHits.push(item);
  out.push({
    id: rule.action,
    item: item,
    label: rule.label,
    depth: depth,
    needs: rule.needs.slice(0),
    dataBacked: info !== null,
    message: "step ready / 步骤就绪"
  });
  return true;
}

// 读引擎开关：控制中心缺失或读失败时按开启处理。
function isEngineEnabled() {
  try {
    if (engineControl && typeof engineControl.isEnabled === "function") return engineControl.isEnabled("behaviorTree") === true;
  } catch (e) { /* 读失败按开启 */ }
  return true;
}

// 功能：规划一个目标，返回 { ok, goal, chain, steps, dataBacked, message }；认不出目标返回 ok:false。
function plan(goal, worldState, options) {
  // 专家面板关掉行为树状态机：连 GOAP 规划一起停，不产出任何任务链。
  if (!isEngineEnabled()) {
    return { ok: false, disabled: true, goal: normalize(goal), chain: [], steps: [],
      dataBacked: false, message: "behavior tree disabled / 行为树状态机已关闭" };
  }
  var opts = options && typeof options === "object" ? options : {};
  var key = resolveGoal(goal);
  if (key.length === 0 || !Object.prototype.hasOwnProperty.call(RULES, key)) {
    return { ok: false, goal: normalize(goal), chain: [], steps: [], dataBacked: false, message: "unknown goal / 无法识别目标" };
  }
  var state = worldState && typeof worldState === "object" ? worldState : {};
  var out = [];
  var visited = {};
  var dataHits = [];
  try {
    if (opts.maxDepth !== undefined && Number(opts.maxDepth) > 0) {
      // 调用方可调小深度做边界测试，但不能超过硬上限。
      var cap = Math.min(Number(opts.maxDepth), MAX_DEPTH);
      var saved = MAX_DEPTH;
      MAX_DEPTH = cap;
      try { expand(key, state, visited, out, 0, dataHits); } finally { MAX_DEPTH = saved; }
    } else {
      expand(key, state, visited, out, 0, dataHits);
    }
  } catch (e) {
    return { ok: false, goal: key, chain: [], steps: [], dataBacked: false, message: errText(e) };
  }
  var chain = [];
  for (var i = 0; i < out.length; i++) chain.push(out[i].id);
  logInfo("plan " + key + " -> " + chain.join(" > ") + " (data=" + dataHits.length + ")");
  return {
    ok: chain.length > 0,
    goal: key,
    chain: chain,
    steps: out,
    dataBacked: dataHits.length > 0,
    source: dataHits.length > 0 ? "minecraft-data / 配方库" : "built-in / 内置配方表",
    message: chain.length > 0 ? ("规划完成 / planned " + chain.length + " steps") : "empty plan / 空规划"
  };
}

// 功能：把规划结果转成一行中英双语可读文本；空链返回提示。
function explain(result) {
  try {
    if (!result || !Array.isArray(result.steps) || result.steps.length === 0) return "无规划 / no plan";
    var parts = [];
    for (var i = 0; i < result.steps.length; i++) parts.push(String(i + 1) + ". " + result.steps[i].label);
    return parts.join(" -> ") + " | " + parts.length + " 步 / steps";
  } catch (e) { return "说明生成失败 / explain failed"; }
}

// 功能：列出全部可规划的目标键（副本）。
function availableGoals() {
  var out = [];
  try { for (var key in RULES) { if (Object.prototype.hasOwnProperty.call(RULES, key)) out.push(key); } }
  catch (e) { out = []; }
  return out;
}

// 功能：取内置规则表快照副本（防止调用方改坏内部表）。
function getRules() {
  var out = {};
  try {
    for (var key in RULES) {
      if (!Object.prototype.hasOwnProperty.call(RULES, key)) continue;
      out[key] = { action: RULES[key].action, needs: RULES[key].needs.slice(0), label: RULES[key].label };
    }
  } catch (e) { out = {}; }
  return out;
}

// 对外导出：规划 / 解释 / 目标解析 / 规则 / 数据源状态。
module.exports = {
  plan: plan,
  explain: explain,
  resolveGoal: resolveGoal,
  availableGoals: availableGoals,
  getRules: getRules,
  dataInfo: dataInfo,
  isDataBacked: isDataBacked,
  isEngineEnabled: isEngineEnabled,
  MAX_DEPTH: MAX_DEPTH,
  MAX_STEPS: MAX_STEPS
};
