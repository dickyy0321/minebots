// ========================================
// 文件：modules/ai-tools.js
// 功能：AI 工具菜单（Function Calling）——14 个基础工具 + 【AI 编程】开关开启时动态追加 2 个建筑工具（create_blueprint / broadcast_post）+ 缺料自动拟帖 + 统一执行入口 + 按玩家等级裁剪
// 依赖：./actions、./action-bridge、./chat-permissions、./logger、vec3、./json-repair、./builder-ai-tools（都可选）
// 导出：getTools / executeTool / filterTools / toolAllowed / TOOL_NAMES / TOOL_ACTIONS
// 作者：MineBots
// ========================================
//
// 用法 / usage
//   1. getTools()                   → OpenAI tools 数组，直接交给 ai.askWithTools
//   2. filterTools(level)           → 按玩家等级裁剪后的子集（AI 只看到这个玩家有权限的工具）
//   3. executeTool(bot, name, args) → 执行并返回一句中英双语提示文本，永不抛错
// 说明：动作类工具统一走 ./actions 的既有实现；查询类直接读 bot 状态，不做任何破坏性动作。
// ES5 风格，CommonJS，无中文变量名
// 可选依赖：动作实现；缺失时所有动作类工具直接回失败文本。
var actions = null;
try { actions = require("./actions"); } catch (err) { actions = null; }
// 可选依赖：抢占接线层（内部再 require ./actions）；缺失时新指令前不做抢占。
var bridge = null; try { bridge = require("./action-bridge"); } catch (err) { bridge = null; }
// 可选依赖：指令权限表；缺失时 filterTools 一律返回空数组（宁严不松）。
var permissions = null;
try { permissions = require("./chat-permissions"); } catch (err) { permissions = null; }
// 可选依赖：日志模块；缺失时日志静默丢弃，绝不抛错。
var logger = null;
try { logger = require("./logger"); } catch (err) { logger = null; }
// 可选依赖：vec3，用来给 blockAt 构造坐标对象；缺失时退化成普通对象。
var vecLib = null;
try { vecLib = require("vec3"); } catch (err) { vecLib = null; }
// 可选依赖：五级 JSON 修复引擎；AI 的 tool_calls.arguments 一律经它解析。
var jsonRepair = null; try { jsonRepair = require("./json-repair"); } catch (err) { jsonRepair = null; }
// 可选依赖：实验性建筑 AI 工具（开关关时 definitions() 返回空数组，既有 14 个工具完全不变）。
var extraTools = null; try { extraTools = require("./builder-ai-tools"); } catch (err) { extraTools = null; }
// 可选依赖：红石 / 建筑缺料自动拟帖；AI 只给 missing 时补出中文求助帖再交给 broadcast_post。
var materialSupply = null; try { materialSupply = require("./redstone-supply"); } catch (err2) { materialSupply = null; }
// 常量：砍树 / 挖矿的默认数量与单次上限（上限防止一次调用把主线程占死）。
var DEFAULT_BLOCKS = 10;
var MAX_BLOCKS = 64;
// 常量：找方块的扫描半径（没有 findBlocks 时的备选扫描范围）。
var SCAN_RADIUS = 8;
// 常量：跟随距离（2 格，和 actions.followPlayer 默认值一致）/ 拾取半径 / 单次最多拾取数量。
var FOLLOW_DISTANCE = 2;
var COLLECT_RADIUS = 8;
var COLLECT_MAX = 5;
// 常量：背包回话里最多列几类物品 / 结果里最多列几个方块名。
var INVENTORY_LIMIT = 20;
var RESULT_NAME_LIMIT = 3;
// 写普通日志：只落文件不推 GUI（工具调用属高频信息）。
function logInfo(message) {
  try {
    if (logger && typeof logger.info === "function") logger.info(message);
  } catch (err) { /* ignore */ }
}
// 写警告日志：执行失败要让人看见；没有 logger 时退回 console。
function logWarn(message) {
  try {
    if (logger && typeof logger.warn === "function") { logger.warn(message); return; }
  } catch (err) { /* 退回 console */ }
  try { console.warn("[warn] " + message); } catch (err2) { /* ignore */ }
}
// 安全转字符串：null / undefined 统一成空串。
function toText(value) {
  if (value === null || value === undefined) return "";
  try { return String(value); } catch (err) { return ""; }
}
// 安全取错误文本：catch 里再抛错就破红线了。
function errText(err) {
  try {
    if (!err) return "unknown error / 未知错误";
    if (typeof err === "string") return err;
    if (err.message) return String(err.message);
    return String(err);
  } catch (e) { return "unknown error / 未知错误"; }
}
// 统一的失败文本：任务要求的「执行失败：」前缀 + 中英双语细节。
function failText(toolName, detail) {
  return "执行失败 / failed: " + toText(toolName) + " — " + toText(detail);
}
// 把 AI 传来的参数洗成对象：强制走五级 JSON 修复，彻底失败给空对象，绝不抛错。
function normalizeArgs(args) {
  if (!args) return {};
  if (typeof args === "object") return args;
  var parsed = {};
  try { parsed = jsonRepair ? jsonRepair.safeParse(args, {}) : {}; } catch (err) { parsed = {}; }
  return (parsed && typeof parsed === "object") ? parsed : {};
}
// 读整数参数：数字字符串也认，读不到返回 NaN。
function intArg(args, key) {
  try { return parseInt(args[key], 10); } catch (err) { return NaN; }
}
// 读字符串参数：去首尾空白，读不到返回空串。
function strArg(args, key) {
  try { return toText(args[key]).trim(); } catch (err) { return ""; }
}
// 读玩家名单：支持数组、逗号分隔字符串、单个名字。
function listArg(args, key) {
  var out = [];
  try {
    var value = args[key];
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) {
        var item = toText(value[i]).trim();
        if (item.length > 0) out.push(item);
      }
      return out;
    }
    var text = toText(value).trim();
    if (text.length === 0) return out;
    var parts = text.split(",");
    for (var j = 0; j < parts.length; j++) {
      var name = toText(parts[j]).trim();
      if (name.length > 0) out.push(name);
    }
  } catch (err) { return out; }
  return out;
}
// 把数量参数夹到 1..MAX_BLOCKS：非法值用默认数量。
function clampCount(value) {
  var n = Number(value);
  if (isNaN(n) || n < 1) n = DEFAULT_BLOCKS;
  n = Math.floor(n);
  if (n > MAX_BLOCKS) n = MAX_BLOCKS;
  return n;
}
// 三个坐标都是有效数字才算合法目标。
function isNum3(x, y, z) {
  return !isNaN(x) && !isNaN(y) && !isNaN(z);
}
// 构造坐标对象：优先 vec3，其次用 bot 现有坐标派生，最后退化成普通对象。
function makePosition(bot, x, y, z) {
  try {
    if (vecLib && typeof vecLib.Vec3 === "function") return new vecLib.Vec3(x, y, z);
    var base = bot && bot.entity ? bot.entity.position : null;
    if (base && typeof base.offset === "function") return base.offset(x - Number(base.x), y - Number(base.y), z - Number(base.z));
  } catch (err) { /* 退化到普通对象 */ }
  return { x: x, y: y, z: z };
}
// 取坐标处的方块：世界未加载或 API 缺失时返回 null。
function blockAtPos(bot, pos) {
  try {
    if (!bot || typeof bot.blockAt !== "function" || !pos) return null;
    return bot.blockAt(pos) || null;
  } catch (err) { return null; }
}
// 算方块到机器人的距离平方：算不出来给 -1。
function distanceSq(bot, pos) {
  try {
    var base = bot && bot.entity ? bot.entity.position : null;
    if (!base || !pos) return -1;
    var dx = Number(pos.x) - Number(base.x);
    var dy = Number(pos.y) - Number(base.y);
    var dz = Number(pos.z) - Number(base.z);
    if (isNaN(dx) || isNaN(dy) || isNaN(dz)) return -1;
    return dx * dx + dy * dy + dz * dz;
  } catch (err) { return -1; }
}
// 按由近到远排序方块列表：坐标读不出来的一律排到最后。
function sortByDistance(bot, list) {
  try {
    var copy = list.slice(0);
    copy.sort(function (a, b) {
      var da = distanceSq(bot, a ? a.position : null);
      var db = distanceSq(bot, b ? b.position : null);
      if (da < 0) da = 1e12;
      if (db < 0) db = 1e12;
      return da - db;
    });
    return copy;
  } catch (err) { return list; }
}
// 木头判定：给了种类就按名字包含判断（oak 命中 oak_log / oak_wood），没给就按后缀判断。
function woodMatcher(wood) {
  var want = toText(wood).toLowerCase().trim();
  return function (block) {
    try {
      var name = toText(block && block.name).toLowerCase();
      if (name.length === 0) return false;
      if (want.length > 0) {
        return name.indexOf(want) >= 0 && (name.indexOf("log") >= 0 || name.indexOf("wood") >= 0 || name.indexOf("stem") >= 0);
      }
      return name.indexOf("_log") >= 0 || name.indexOf("_wood") >= 0 || name === "mushroom_stem";
    } catch (err) { return false; }
  };
}
// 矿石判定：给了矿种就按名字包含判断，没给就认所有 xxx_ore 与远古残骸。
function oreMatcher(ores) {
  var wants = [];
  for (var i = 0; i < ores.length; i++) {
    var name = toText(ores[i]).toLowerCase().trim();
    if (name.length > 0) wants.push(name);
  }
  return function (block) {
    try {
      var blockName = toText(block && block.name).toLowerCase();
      if (blockName.length === 0) return false;
      if (wants.length === 0) return blockName.indexOf("_ore") >= 0 || blockName === "ancient_debris";
      for (var j = 0; j < wants.length; j++) {
        if (blockName.indexOf(wants[j]) >= 0) return true;
      }
      return false;
    } catch (err) { return false; }
  };
}
// 找最近的若干目标方块：优先 mineflayer 的 findBlocks，其次逐格扫描；找不到返回空数组。
function findTargetBlocks(bot, matcher, radius, count) {
  var out = [];
  try {
    if (typeof bot.findBlocks === "function") {
      var positions = bot.findBlocks({ matching: matcher, maxDistance: radius, count: count });
      var list = Array.isArray(positions) ? positions : [];
      for (var i = 0; i < list.length; i++) {
        var block = blockAtPos(bot, list[i]);
        if (block) out.push(block);
      }
      if (out.length > 0) return sortByDistance(bot, out);
    }
    var base = bot && bot.entity ? bot.entity.position : null;
    if (!base) return out;
    var bx = Math.floor(Number(base.x)), by = Math.floor(Number(base.y)), bz = Math.floor(Number(base.z));
    for (var dx = -radius; dx <= radius; dx++) {
      for (var dy = -radius; dy <= radius; dy++) {
        for (var dz = -radius; dz <= radius; dz++) {
          var hit = blockAtPos(bot, makePosition(bot, bx + dx, by + dy, bz + dz));
          if (!hit) continue;
          var matched = false;
          try { matched = matcher(hit) === true; } catch (e) { matched = false; }
          if (matched) out.push(hit);
          if (out.length >= count) return sortByDistance(bot, out);
        }
      }
    }
  } catch (err) { return out; }
  return sortByDistance(bot, out);
}
// 按用户名找最近的实体：名字忽略大小写，匹配多个时取最近的。
function findEntityByName(bot, name) {
  var wanted = toText(name).toLowerCase();
  if (wanted.length === 0) return null;
  try {
    var entities = bot ? bot.entities : null;
    if (!entities) return null;
    var best = null;
    var bestDist = -1;
    var keys = Object.keys(entities);
    for (var i = 0; i < keys.length; i++) {
      var entity = entities[keys[i]];
      if (!entity) continue;
      var uname = toText(entity.username).toLowerCase();
      var ename = toText(entity.name).toLowerCase();
      var dname = toText(entity.displayName).toLowerCase();
      if (uname !== wanted && ename !== wanted && dname !== wanted) continue;
      var dist = distanceSq(bot, entity.position ? entity.position : null);
      if (best === null || (dist >= 0 && (bestDist < 0 || dist < bestDist))) {
        best = entity;
        bestDist = dist;
      }
    }
    return best;
  } catch (err) { return null; }
}
// 取实体坐标：读不到返回 null。
function entityPosition(entity) {
  try {
    var pos = entity && entity.position ? entity.position : null;
    if (!pos) return null;
    return { x: Math.floor(Number(pos.x)), y: Math.floor(Number(pos.y)), z: Math.floor(Number(pos.z)) };
  } catch (err) { return null; }
}
// 查物品 id：优先 bot.registry.itemsByName，其次 itemsArray；查不到返回 null。
function itemId(bot, name) {
  try {
    var registry = bot ? bot.registry : null;
    if (registry && registry.itemsByName && registry.itemsByName[name]) return registry.itemsByName[name].id;
    if (registry && Array.isArray(registry.itemsArray)) {
      for (var i = 0; i < registry.itemsArray.length; i++) {
        if (toText(registry.itemsArray[i].name) === name) return registry.itemsArray[i].id;
      }
    }
  } catch (err) { return null; }
  return null;
}
// 找一条可用配方：先按「不用工作台」找，再按「允许工作台」找；都没有返回 null。
function pickRecipe(bot, id, count) {
  var recipes = [];
  try { recipes = bot.recipesFor(id, null, count, null) || []; } catch (e) { recipes = []; }
  if (recipes.length === 0) {
    try { recipes = bot.recipesFor(id, null, count, true) || []; } catch (e2) { recipes = []; }
  }
  return recipes.length > 0 ? recipes[0] : null;
}
// 挖掉一批目标方块：返回 { done, names }；单个方块失败只跳过，不中断整批。
async function digTargets(bot, matcher, count) {
  var result = { done: 0, names: [] };
  if (!actions || typeof actions.digBlock !== "function") return result;
  var targets = findTargetBlocks(bot, matcher, SCAN_RADIUS, count);
  for (var i = 0; i < targets.length && result.done < count; i++) {
    var block = targets[i];
    var pos = block && block.position ? block.position : null;
    if (!pos) continue;
    var res = null;
    try { res = await actions.digBlock(bot, pos.x, pos.y, pos.z); }
    catch (err) { logWarn("[ai-tools] 挖掘失败 / dig failed: " + errText(err)); continue; }
    if (res && res.ok) {
      result.done = result.done + 1;
      if (result.names.length < RESULT_NAME_LIMIT) result.names.push(toText(res.block ? res.block : block.name));
    }
  }
  return result;
}
// 工具：move_to —— 走到绝对坐标。
async function handleMoveTo(bot, args) {
  var x = intArg(args, "x"), y = intArg(args, "y"), z = intArg(args, "z");
  if (!isNum3(x, y, z)) return failText("move_to", "需要整数 x, y, z / integers x, y, z required");
  if (!actions || typeof actions.moveTo !== "function") return failText("move_to", "actions unavailable / 动作模块不可用");
  var res = await actions.moveTo(bot, x, y, z);
  if (res && res.ok === false) return failText("move_to", res.message);
  return "成功 / ok: 已走到 " + x + ", " + y + ", " + z + " / walked to target";
}
// 工具：move_to_player —— 先找玩家坐标，再走过去。
async function handleMoveToPlayer(bot, args) {
  var player = strArg(args, "player");
  if (player.length === 0) return failText("move_to_player", "缺少玩家名 / player required");
  var entity = findEntityByName(bot, player);
  if (!entity) return failText("move_to_player", "未找到玩家 / player not found: " + player);
  var pos = entityPosition(entity);
  if (!pos) return failText("move_to_player", "玩家坐标不可用 / player position unavailable");
  if (!actions || typeof actions.moveTo !== "function") return failText("move_to_player", "actions unavailable / 动作模块不可用");
  var res = await actions.moveTo(bot, pos.x, pos.y, pos.z);
  if (res && res.ok === false) return failText("move_to_player", res.message);
  return "成功 / ok: 已走到 " + player + " 身边 / walked to " + player;
}
// 工具：dig_block —— 挖掉指定坐标的方块。
async function handleDigBlock(bot, args) {
  var x = intArg(args, "x"), y = intArg(args, "y"), z = intArg(args, "z");
  if (!isNum3(x, y, z)) return failText("dig_block", "需要整数 x, y, z / integers x, y, z required");
  if (!actions || typeof actions.digBlock !== "function") return failText("dig_block", "actions unavailable / 动作模块不可用");
  var res = await actions.digBlock(bot, x, y, z);
  if (res && res.ok === false) return failText("dig_block", res.message);
  return "成功 / ok: 挖掉了 " + toText(res ? res.block : "") + " 于 " + x + ", " + y + ", " + z + " / dug block";
}
// 工具：dig_tree —— 自动找附近的木头挖掉。
async function handleDigTree(bot, args) {
  if (!actions || typeof actions.digBlock !== "function") return failText("dig_tree", "actions unavailable / 动作模块不可用");
  var count = clampCount(args.blocks);
  var dug = await digTargets(bot, woodMatcher(strArg(args, "wood")), count);
  if (dug.done === 0) return failText("dig_tree", "附近没有可砍的木头 / no log nearby");
  return "成功 / ok: 砍了 " + dug.done + " 个木头 / chopped " + dug.done + " logs (" + dug.names.join(", ") + ")";
}
// 工具：mine —— 自动找附近的矿石挖掉。
async function handleMine(bot, args) {
  if (!actions || typeof actions.digBlock !== "function") return failText("mine", "actions unavailable / 动作模块不可用");
  var count = clampCount(args.blocks);
  var dug = await digTargets(bot, oreMatcher(listArg(args, "ores")), count);
  if (dug.done === 0) return failText("mine", "附近没有可挖的矿石 / no ore nearby");
  return "成功 / ok: 挖了 " + dug.done + " 个矿石 / mined " + dug.done + " ores (" + dug.names.join(", ") + ")";
}
// 工具：follow —— 跟随玩家（动作层只维护一路跟随，多个名字时只跟第一个）。
async function handleFollow(bot, args) {
  var players = listArg(args, "players");
  if (players.length === 0) return failText("follow", "缺少玩家名 / players required");
  if (!actions || typeof actions.followPlayer !== "function") return failText("follow", "actions unavailable / 动作模块不可用");
  var res = await actions.followPlayer(bot, players[0], FOLLOW_DISTANCE);
  if (res && res.ok === false) return failText("follow", res.message);
  var extra = players.length > 1 ? "（只跟随第一个 / only the first player is followed）" : "";
  return "成功 / ok: 开始跟随 " + players[0] + " / following " + players[0] + extra;
}
// 工具：stop —— 停掉移动 / 跟随 / 挖矿。
async function handleStop(bot, args) {
  if (!actions || typeof actions.stopMoving !== "function") return failText("stop", "actions unavailable / 动作模块不可用");
  var res = await actions.stopMoving(bot);
  if (res && res.ok === false) return failText("stop", res.message);
  return "成功 / ok: 已停止 / stopped";
}
// 工具：attack —— 攻击目标实体。
async function handleAttack(bot, args) {
  var target = strArg(args, "target");
  if (target.length === 0) return failText("attack", "缺少目标 / target required");
  if (!actions || typeof actions.attackEntity !== "function") return failText("attack", "actions unavailable / 动作模块不可用");
  var hit = await actions.attackEntity(bot, target, 1);
  if (hit && hit.ok === false) return failText("attack", hit.message);
  return "成功 / ok: 攻击了 " + toText(hit ? hit.entity : target) + " / attacked";
}
// 工具：place_block —— 在指定坐标放方块。
async function handlePlaceBlock(bot, args) {
  var x = intArg(args, "x"), y = intArg(args, "y"), z = intArg(args, "z");
  var block = strArg(args, "block");
  if (!isNum3(x, y, z)) return failText("place_block", "需要整数 x, y, z / integers x, y, z required");
  if (block.length === 0) return failText("place_block", "缺少方块名 / block name required");
  if (!actions || typeof actions.placeBlock !== "function") return failText("place_block", "actions unavailable / 动作模块不可用");
  var res = await actions.placeBlock(bot, block, x, y, z);
  if (res && res.ok === false) return failText("place_block", res.message);
  return "成功 / ok: 放了 " + block + " 于 " + x + ", " + y + ", " + z + " / placed block";
}
// 工具：craft —— 按物品名合成指定数量。
async function handleCraft(bot, args) {
  var item = strArg(args, "item").toLowerCase();
  if (item.length === 0) return failText("craft", "缺少物品名 / item required");
  var count = intArg(args, "count");
  if (isNaN(count) || count < 1) count = 1;
  if (count > MAX_BLOCKS) count = MAX_BLOCKS;
  if (!bot || typeof bot.craft !== "function" || typeof bot.recipesFor !== "function") {
    return failText("craft", "当前机器人不支持合成 / crafting not supported");
  }
  var id = itemId(bot, item);
  if (id === null || id === undefined) return failText("craft", "未知物品 / unknown item: " + item);
  var recipe = pickRecipe(bot, id, count);
  if (!recipe) return failText("craft", "没有可用配方（材料不足？）/ no recipe available (missing materials?)");
  await bot.craft(recipe, count, null);
  return "成功 / ok: 合成了 " + item + " x" + count + " / crafted";
}
// 工具：collect —— 捡起附近的掉落物。
async function handleCollect(bot, args) {
  if (!actions || typeof actions.collectNearbyItems !== "function") return failText("collect", "actions unavailable / 动作模块不可用");
  var res = await actions.collectNearbyItems(bot, COLLECT_RADIUS, COLLECT_MAX);
  if (res && res.ok === false) return failText("collect", res.message);
  var found = res && res.found !== undefined ? Number(res.found) : 0;
  var got = res && res.collected !== undefined ? Number(res.collected) : 0;
  if (found === 0) return "成功 / ok: 附近没有掉落物 / no item nearby";
  return "成功 / ok: 捡到 " + got + " 个掉落物（发现 " + found + " 个）/ collected " + got + " of " + found + " items";
}
// 工具：get_position —— 查询当前坐标。
function handleGetPosition(bot, args) {
  var pos = bot && bot.entity ? bot.entity.position : null;
  if (!pos) return "位置不可用 / position unavailable";
  return "位置 / position: " + Math.round(Number(pos.x)) + ", " + Math.round(Number(pos.y)) + ", " + Math.round(Number(pos.z));
}
// 工具：get_health —— 查询血量与饥饿值。
function handleGetHealth(bot, args) {
  var health = bot ? Number(bot.health) : NaN;
  var food = bot ? Number(bot.food) : NaN;
  var healthText = isNaN(health) ? "未知 / unknown" : String(health);
  var foodText = isNaN(food) ? "未知 / unknown" : String(food);
  return "血量 / health: " + healthText + ", 饥饿 / food: " + foodText;
}
// 工具：get_inventory —— 查询背包物品。
function handleGetInventory(bot, args) {
  var items = [];
  try {
    if (bot && bot.inventory && typeof bot.inventory.items === "function") items = bot.inventory.items() || [];
  } catch (err) { items = []; }
  if (!Array.isArray(items) || items.length === 0) return "背包是空的 / inventory is empty";
  var lines = [];
  for (var i = 0; i < items.length && i < INVENTORY_LIMIT; i++) {
    var item = items[i];
    if (!item) continue;
    lines.push(toText(item.name) + " x" + toText(item.count));
  }
  return "背包 / inventory: " + lines.join(", ") + "（共 " + items.length + " 类 / " + items.length + " stacks）";
}
// 常量：工具菜单委托给纯英文精简 schema（描述全英文、Token 更省）；缺失时安全退回空表。
var schemaLib = null;
try { schemaLib = require("./ai-tools-schema"); } catch (eSchema) { schemaLib = null; }
var TOOLS = [];
try { if (schemaLib && Array.isArray(schemaLib.TOOLS)) TOOLS = schemaLib.TOOLS.slice(0); } catch (eTools) { TOOLS = []; }
// 常量：工具 → 权限动作名映射，与 chat-permissions 的白名单对齐（query 只给完全信任的人）。
var TOOL_ACTIONS = {
  move_to: "move", move_to_player: "move", dig_block: "dig", dig_tree: "dig_tree",
  mine: "dig", follow: "follow", stop: "stop", attack: "attack",
  place_block: "place", craft: "craft", collect: "collect",
  get_position: "query", get_health: "query", get_inventory: "query"
};
// 常量：不在白名单里但要放行的工具 —— stop 用 move 权限近似（能动的人就能喊停）。
var SAFE_FALLBACK = { stop: "move" };
// 常量：全部工具名（自检与日志用）。
var TOOL_NAMES = [];
for (var t = 0; t < TOOLS.length; t++) TOOL_NAMES.push(TOOLS[t].function.name);
// 工具名归一化：去空白、转小写，并兼容部分模型带的 functions. 前缀。
function normalizeName(toolName) {
  var name = toText(toolName).toLowerCase().trim();
  if (name.indexOf("functions.") === 0) name = name.slice(10).trim();
  return name;
}
// 功能：返回工具菜单副本；search 模式只给检索工具 + 少量核心工具，slim 模式给精简 schema。
function getTools(options) {
  var opts = options && typeof options === "object" ? options : {};
  var base = TOOLS.slice(0);
  try {
    if (opts.mode === "search" && schemaLib && typeof schemaLib.getMenu === "function") base = schemaLib.getMenu({ mode: "search" });
    else if (opts.slim === true && schemaLib && typeof schemaLib.slimTools === "function") base = schemaLib.slimTools();
  } catch (eMenu) { base = TOOLS.slice(0); }
  try { if (extraTools && typeof extraTools.definitions === "function") base = base.concat(extraTools.definitions()); }
  catch (err) { /* 实验模块缺失不影响既有 14 个工具 */ }
  return base;
}
// 常量：工具名 → 执行函数（函数声明会提升，放在这里不影响上面的 TOOLS 定义）。
var HANDLERS = {
  move_to: handleMoveTo, move_to_player: handleMoveToPlayer, dig_block: handleDigBlock,
  dig_tree: handleDigTree, mine: handleMine, follow: handleFollow, stop: handleStop,
  attack: handleAttack, place_block: handlePlaceBlock, craft: handleCraft,
  collect: handleCollect, get_position: handleGetPosition, get_health: handleGetHealth,
  get_inventory: handleGetInventory
};
// 把工具返回值收敛成一句话：字符串直接用，对象按 ok / message 与关键字段拼装。
function resultText(toolName, res) {
  if (typeof res === "string") return res;
  // 静默执行：null / undefined / 0 / 空字符串一律不产生二次回复文本。
  if (res === null || res === undefined || res === 0 || res === "") return "";
  if (!res) return "成功 / ok: " + toText(toolName);
  if (res.ok === false) return failText(toolName, res.message ? res.message : "未知错误 / unknown error");
  if (res.summary) return toText(res.summary); // 建筑 AI 工具自带双语摘要，回给 AI 看真实结果。
  var parts = [];
  if (res.count !== undefined) parts.push("count=" + toText(res.count));
  if (res.block !== undefined) parts.push("block=" + toText(res.block));
  if (res.item !== undefined) parts.push("item=" + toText(res.item));
  if (res.entity !== undefined) parts.push("entity=" + toText(res.entity));
  if (res.found !== undefined) parts.push("found=" + toText(res.found));
  if (res.collected !== undefined) parts.push("collected=" + toText(res.collected));
  return "成功 / ok: " + toText(toolName) + (parts.length > 0 ? " (" + parts.join(", ") + ")" : "");
}
// 单个工具是否允许：权限模块缺失一律拒绝；敌对等级全拒；stop 走 move 权限的近似判定。
function toolAllowed(level, toolName) {
  var name = normalizeName(toolName);
  // 实验性建筑工具：开关开启且玩家完全信任才放行，不污染既有 14 个工具的权限表。
  try { if (extraTools && extraTools.isTool(name)) return extraTools.enabled() === true && !!(permissions && permissions.isTrusted && permissions.isTrusted(level)); }
  catch (errX) { return false; }
  if (!HANDLERS[name]) return false;
  if (!permissions || typeof permissions.isAllowed !== "function") return false;
  try {
    if (typeof permissions.isHostile === "function" && permissions.isHostile(level)) return false;
    var fallback = SAFE_FALLBACK[name];
    if (fallback && permissions.isAllowed(level, fallback)) return true;
    return permissions.isAllowed(level, TOOL_ACTIONS[name]);
  } catch (err) { return false; }
}
// 功能：按等级裁剪工具菜单——AI 只能看到这个玩家有权限调用的工具。
function filterTools(level) {
  var out = [];
  try {
    var defs = getTools();
    for (var i = 0; i < defs.length; i++) {
      if (toolAllowed(level, defs[i].function.name)) out.push(defs[i]);
    }
  } catch (err) { return []; }
  return out;
}
// 常量：纯查询工具不抢占——问一句血量 / 坐标不该打断正在进行的动作。
var QUERY_TOOLS = ["get_position", "get_health", "get_inventory"];
// 新指令前先抢占：杀掉上一条遗留的持续任务（跟随定时器 / 寻路目标 / 遗留排队任务），查询类与 stop 除外。
function preemptBefore(bot, name) {
  try {
    if (!name || name === "stop" || QUERY_TOOLS.indexOf(name) >= 0) return false;
    if (!bridge || typeof bridge.preempt !== "function") return false;
    var res = bridge.preempt(bot, name); return !!(res && res.ok === true);
  } catch (err) { logWarn("[ai-tools] preempt failed / 抢占失败: " + errText(err)); return false; }
}
// 功能 2：执行一次工具调用，返回中英双语的提示文本；失败一律回「执行失败」文本，绝不抛错。
async function executeTool(bot, toolName, args) {
  var name = normalizeName(toolName);
  var extraArgs = normalizeArgs(args);
  // 红石 / 建筑缺料：AI 只给 missing 时自动补出「谁有 10 个中继器，我用钻石换！」式求助帖。
  if (name === "broadcast_post" && extraArgs && extraArgs.missing && !extraArgs.content && materialSupply) {
    try { extraArgs.content = materialSupply.composePost(extraArgs.missing).content; } catch (eMat) { /* 生成器缺失按原帖 */ }
  }
  // 建筑 AI 工具不需要真实 bot（生成蓝图 / 发帖都在主进程完成），放在 bot 判空前分派。
  try { if (extraTools && extraTools.isTool(name)) return resultText(name, extraTools.execute(name, extraArgs, bot)); }
  catch (errExtra) { return failText(name, errText(errExtra)); }
  var handler = HANDLERS[name];
  if (!handler) return failText(name.length > 0 ? name : "?", "未知工具 / unknown tool");
  // 参数强校验：缺必填 / 类型不对直接拦在门外，绝不把脏参数送进执行层。
  if (schemaLib && typeof schemaLib.validateToolArgs === "function") {
    var verdict = schemaLib.validateToolArgs(name, normalizeArgs(args));
    if (verdict && verdict.ok === false) return failText(name, (verdict.errors || []).join("; "));
  }
  if (!bot) return failText(name, "bot not ready / 机器人未就绪");
  preemptBefore(bot, name); // 新指令一律先抢占：否则上一条「跟随」会在砍完树后自己带路走回玩家
  try {
    var res = await handler(bot, normalizeArgs(args));
    var text = resultText(name, res);
    if (text.indexOf("执行失败") === 0) logWarn("[ai-tools] " + text);
    else logInfo("[ai-tools] " + name + " -> " + text);
    return text;
  } catch (err) {
    logWarn("[ai-tools] " + name + " 执行失败 / failed: " + errText(err));
    return failText(name, errText(err));
  }
}
// 对外导出：菜单 / 执行 / 权限裁剪 + 名字与动作映射表。
module.exports = {
  getTools: getTools,
  executeTool: executeTool,
  filterTools: filterTools,
  toolAllowed: toolAllowed,
  TOOL_NAMES: TOOL_NAMES,
  TOOL_ACTIONS: TOOL_ACTIONS,
  validateToolArgs: function (n, a) { return schemaLib ? schemaLib.validateToolArgs(n, a) : { ok: true, skipped: true, errors: [] }; },
  searchTools: function (q, o) { return schemaLib ? schemaLib.searchTools(q, o) : { ok: false, tools: [] }; },
  getSearchMenu: function () { return getTools({ mode: "search" }); }
};
