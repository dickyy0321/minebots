// ========================================
// 文件：modules/state-skills-plus.js
// 功能：状态机技能（感知类 + 物品类 + 生存类）——扫描实体 / 找方块 / 查状态 / 换装备 / 存取箱子 / 吃东西 / 逃跑
// 依赖：./state-util、./actions（可选）
// 导出：HANDLERS / NAMES / has / pick / ACTIONS
// 作者：MineBots
// ========================================
//
// 约定：所有 handler 形如 function (ctx, args)，返回 Promise<{ ok, message }>，绝不抛错。
// ES5 风格，CommonJS，无中文变量名
var util = null;
try { util = require("./state-util"); } catch (e) { util = null; }

// 可选依赖：动作执行层（移动 / 停止）。
var actions = null;
try { actions = require("./actions"); } catch (e) { actions = null; }

// 可选依赖：日志核心，缺失时退回 console。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：可吃的食物名关键字（自动进食按这份表判断）。
var FOOD_KEYWORDS = ["bread", "apple", "carrot", "potato", "beef", "porkchop", "chicken", "mutton", "cod", "salmon", "cookie", "melon", "stew", "berry", "baked_potato", "cooked"];

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

// 写文件日志：高频感知动作只落文件，不推 GUI。
function logInfo(msg) {
  try {
    if (logger && typeof logger.info === "function") { logger.info("[state-skill2] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[state-skill2] " + msg); } catch (e) { /* ignore */ }
}

// 判断 bot 是否可用；不可用直接返回双语失败结果。
function requireBot(bot) {
  if (!bot) return { ok: false, message: "bot not ready / 机器人未就绪" };
  try {
    if (!bot.entity) return { ok: false, message: "bot entity missing / 机器人实体未加载" };
  } catch (e) { return { ok: false, message: "bot not ready / 机器人未就绪" }; }
  return { ok: true };
}

// 读一个实体的坐标，读不到返回 null。
function entityPos(entity) {
  try {
    var pos = entity && entity.position;
    if (!pos) return null;
    return { x: Math.round(pos.x * 100) / 100, y: Math.round(pos.y * 100) / 100, z: Math.round(pos.z * 100) / 100 };
  } catch (e) { return null; }
}

// 读实体类型（player / mob / item / 其它），读不到返回 unknown。
function entityKind(entity) {
  try {
    if (!entity) return "unknown";
    if (entity.username) return "player";
    if (entity.name === "item" || entity.objectType === "Item") return "item";
    if (entity.type === "mob" || entity.type === "animal" || entity.type === "hostile") return "mob";
    if (entity.type) return String(entity.type);
    return "unknown";
  } catch (e) { return "unknown"; }
}

// 读实体显示名（用户名优先，其次实体名），读不到返回空串。
function entityName(entity) {
  try {
    if (!entity) return "";
    if (entity.username) return String(entity.username);
    if (entity.name) return String(entity.name);
    if (entity.displayName) return String(entity.displayName);
    return "";
  } catch (e) { return ""; }
}

// 感知 1：扫描附近实体，结果写进 vars.entities，返回数量。
async function scanEntities(ctx, args) {
  var ready = requireBot(ctx.bot);
  if (!ready.ok) return ready;
  var radius = toNum(args.radius, 16);
  if (radius <= 0) radius = 16;
  if (radius > 64) radius = 64;
  var kindFilter = toText(args.kind || args.type).toLowerCase();
  var self = util ? util.posOf(ctx.bot) : null;
  var out = [];
  try {
    var list = ctx.bot.entities || {};
    for (var id in list) {
      if (!Object.prototype.hasOwnProperty.call(list, id)) continue;
      var entity = list[id];
      if (!entity || entity === ctx.bot.entity) continue;
      var pos = entityPos(entity);
      var kind = entityKind(entity);
      if (kindFilter.length > 0 && kind !== kindFilter) continue;
      var dist = util && self && pos ? util.distanceOf(self, pos) : Infinity;
      if (dist > radius) continue;
      out.push({ id: toText(id), name: entityName(entity), kind: kind, distance: Math.round(dist * 100) / 100, position: pos });
    }
  } catch (err) {
    logInfo("scan_entities 失败 / failed: " + getErrText(err));
  }
  try { ctx.vars.entities = out; ctx.vars.entityCount = out.length; } catch (e) { /* ignore */ }
  return { ok: true, count: out.length, entities: out, message: "扫描到 " + out.length + " 个实体 / found " + out.length + " entities" };
}

// 感知 2：找最近的指定方块，坐标写进 vars.foundBlock，找不到返回 ok:false。
async function findBlock(ctx, args) {
  var ready = requireBot(ctx.bot);
  if (!ready.ok) return ready;
  var name = toText(args.block || args.name).trim();
  if (name.length === 0) return { ok: false, message: "block 不能为空 / block required" };
  var block = util ? util.nearestBlock(ctx.bot, name, toNum(args.radius, 32)) : null;
  if (!block) {
    try { ctx.vars.foundBlock = null; } catch (e) { /* ignore */ }
    return { ok: false, message: "附近没有该方块 / block not found: " + name };
  }
  var pos = entityPos(block);
  if (!pos) return { ok: false, message: "方块坐标读不到 / block position missing" };
  try { ctx.vars.foundBlock = pos; } catch (e) { /* ignore */ }
  return { ok: true, block: name, position: pos, message: "找到 " + name + " " + (util ? util.posText(pos) : "") };
}

// 感知 3：把血量 / 饥饿值 / 坐标写进 vars.status。
async function getStatus(ctx) {
  var ready = requireBot(ctx.bot);
  if (!ready.ok) return ready;
  var status = {
    health: toNum(ctx.bot.health, 0),
    food: toNum(ctx.bot.food, 0),
    position: util ? util.posOf(ctx.bot) : null
  };
  try { ctx.vars.status = status; ctx.vars.health = status.health; ctx.vars.food = status.food; } catch (e) { /* ignore */ }
  return { ok: true, health: status.health, food: status.food, position: status.position, message: "血量 " + status.health + " / 饱食 " + status.food };
}

// 感知 4：统计背包里某个物品的数量，写进 vars.itemCount。
async function countItem(ctx, args) {
  var ready = requireBot(ctx.bot);
  if (!ready.ok) return ready;
  var name = toText(args.item || args.name).trim();
  if (name.length === 0) return { ok: false, message: "item 不能为空 / item required" };
  var count = util ? util.countItem(ctx.bot, name) : 0;
  try { ctx.vars.itemCount = count; ctx.vars.lastItem = name; } catch (e) { /* ignore */ }
  return { ok: true, item: name, count: count, message: name + " 有 " + count + " 个 / " + name + " x" + count };
}

// 感知 5：算到指定坐标的距离，写进 vars.distance。
async function distanceTo(ctx, args) {
  var ready = requireBot(ctx.bot);
  if (!ready.ok) return ready;
  var self = util ? util.posOf(ctx.bot) : null;
  var target = { x: toNum(args.x, NaN), y: toNum(args.y, NaN), z: toNum(args.z, NaN) };
  if (isNaN(target.x) || isNaN(target.y) || isNaN(target.z)) return { ok: false, message: "x/y/z 必须是数字 / x, y, z must be numbers" };
  var dist = util ? util.distanceOf(self, target) : Infinity;
  if (!isFinite(dist)) return { ok: false, message: "坐标读不到 / position unavailable" };
  dist = Math.round(dist * 100) / 100;
  try { ctx.vars.distance = dist; } catch (e) { /* ignore */ }
  return { ok: true, distance: dist, message: "距离 " + dist + " 格 / distance " + dist };
}

// 物品 1：把背包里的物品装备到手上；没有该物品返回 ok:false。
async function equipItem(ctx, args) {
  var ready = requireBot(ctx.bot);
  if (!ready.ok) return ready;
  var name = toText(args.item || args.name).trim();
  if (name.length === 0) return { ok: false, message: "item 不能为空 / item required" };
  var item = util ? util.findItem(ctx.bot, name) : null;
  if (!item) return { ok: false, message: "背包里没有该物品 / item not in inventory: " + name };
  if (typeof ctx.bot.equip !== "function") return { ok: false, message: "equip 不可用 / equip unavailable" };
  try {
    await ctx.bot.equip(item, toText(args.destination) || "hand");
    return { ok: true, item: toText(item.name), message: "已装备 / equipped: " + toText(item.name) };
  } catch (err) {
    return { ok: false, message: getErrText(err) };
  }
}

// 物品 2：丢掉背包里的物品（默认全部丢掉）。
async function dropItem(ctx, args) {
  var ready = requireBot(ctx.bot);
  if (!ready.ok) return ready;
  var name = toText(args.item || args.name).trim();
  if (name.length === 0) return { ok: false, message: "item 不能为空 / item required" };
  var item = util ? util.findItem(ctx.bot, name) : null;
  if (!item) return { ok: false, message: "背包里没有该物品 / item not in inventory: " + name };
  if (typeof ctx.bot.toss !== "function") return { ok: false, message: "toss 不可用 / toss unavailable" };
  var count = toNum(args.count, item.count || 1);
  if (count < 1) count = 1;
  try {
    await ctx.bot.toss(item.type, null, count);
    return { ok: true, item: toText(item.name), count: count, message: "丢掉 " + count + " 个 / dropped " + count };
  } catch (err) {
    return { ok: false, message: getErrText(err) };
  }
}

// 物品 3：从最近的箱子取东西（取不到返回 ok:false）。
async function takeItem(ctx, args) {
  var ready = requireBot(ctx.bot);
  if (!ready.ok) return ready;
  var name = toText(args.item || args.name).trim();
  if (name.length === 0) return { ok: false, message: "item 不能为空 / item required" };
  var count = toNum(args.count, 1);
  if (count < 1) count = 1;
  if (typeof ctx.bot.openContainer !== "function") return { ok: false, message: "openContainer 不可用 / openContainer unavailable" };
  var block = util ? util.nearestBlock(ctx.bot, ["chest", "barrel", "shulker_box"], toNum(args.radius, 16)) : null;
  if (!block) return { ok: false, message: "附近没有容器 / no container nearby" };
  var container = null;
  try {
    container = await ctx.bot.openContainer(block);
    var itemType = null;
    try {
      var def = ctx.bot.registry ? ctx.bot.registry.itemsByName[name] : null;
      itemType = def ? def.id : null;
    } catch (e) { itemType = null; }
    if (itemType === null) throw new Error("未知物品 / unknown item: " + name);
    await container.withdraw(itemType, null, count);
    return { ok: true, item: name, count: count, message: "取出 " + count + " 个 " + name + " / took " + count };
  } catch (err) {
    return { ok: false, message: getErrText(err) };
  } finally {
    try { if (container && typeof container.close === "function") container.close(); } catch (e) { /* ignore */ }
  }
}

// 物品 4：把东西放进最近的箱子（失败返回 ok:false）。
async function storeItem(ctx, args) {
  var ready = requireBot(ctx.bot);
  if (!ready.ok) return ready;
  var name = toText(args.item || args.name).trim();
  if (name.length === 0) return { ok: false, message: "item 不能为空 / item required" };
  var item = util ? util.findItem(ctx.bot, name) : null;
  if (!item) return { ok: false, message: "背包里没有该物品 / item not in inventory: " + name };
  if (typeof ctx.bot.openContainer !== "function") return { ok: false, message: "openContainer 不可用 / openContainer unavailable" };
  var block = util ? util.nearestBlock(ctx.bot, ["chest", "barrel", "shulker_box"], toNum(args.radius, 16)) : null;
  if (!block) return { ok: false, message: "附近没有容器 / no container nearby" };
  var count = toNum(args.count, item.count || 1);
  if (count < 1) count = 1;
  var container = null;
  try {
    container = await ctx.bot.openContainer(block);
    await container.deposit(item.type, null, count);
    return { ok: true, item: toText(item.name), count: count, message: "存入 " + count + " 个 / stored " + count };
  } catch (err) {
    return { ok: false, message: getErrText(err) };
  } finally {
    try { if (container && typeof container.close === "function") container.close(); } catch (e) { /* ignore */ }
  }
}

// 生存 1：找背包里的食物吃掉；找不到食物返回 ok:false。
async function autoEat(ctx, args) {
  var ready = requireBot(ctx.bot);
  if (!ready.ok) return ready;
  var items = util ? util.inventoryItems(ctx.bot) : [];
  var food = null;
  for (var i = 0; i < items.length; i++) {
    var name = toText(items[i].name).toLowerCase();
    for (var k = 0; k < FOOD_KEYWORDS.length; k++) {
      if (name.indexOf(FOOD_KEYWORDS[k]) >= 0) { food = items[i]; break; }
    }
    if (food) break;
  }
  if (!food) return { ok: false, message: "背包里没有食物 / no food in inventory" };
  if (typeof ctx.bot.equip !== "function" || typeof ctx.bot.consume !== "function") {
    return { ok: false, message: "consume 不可用 / consume unavailable" };
  }
  try {
    await ctx.bot.equip(food, "hand");
    await ctx.bot.consume();
    try { ctx.vars.lastFood = toText(food.name); } catch (e) { /* ignore */ }
    return { ok: true, item: toText(food.name), message: "吃掉了 / ate: " + toText(food.name) };
  } catch (err) {
    return { ok: false, message: getErrText(err) };
  }
}

// 生存 2：远离某个坐标 / 实体（默认朝反方向走 distance 格）。
async function flee(ctx, args) {
  var ready = requireBot(ctx.bot);
  if (!ready.ok) return ready;
  var self = util ? util.posOf(ctx.bot) : null;
  if (!self) return { ok: false, message: "坐标读不到 / position unavailable" };
  var from = { x: toNum(args.x, NaN), y: toNum(args.y, NaN), z: toNum(args.z, NaN) };
  if (isNaN(from.x) || isNaN(from.y) || isNaN(from.z)) {
    var threat = toText(args.from || args.entity).trim();
    var found = null;
    try {
      var list = ctx.bot.entities || {};
      for (var id in list) {
        if (!Object.prototype.hasOwnProperty.call(list, id)) continue;
        var entity = list[id];
        if (!entity || entity === ctx.bot.entity) continue;
        if (threat.length > 0 && entityName(entity).toLowerCase() !== threat.toLowerCase()) continue;
        found = entityPos(entity);
        if (found) break;
      }
    } catch (e) { found = null; }
    if (!found) return { ok: false, message: "找不到要远离的目标 / threat not found" };
    from = found;
  }
  var steps = toNum(args.distance, 8);
  if (steps < 2) steps = 2;
  if (steps > 32) steps = 32;
  var dx = self.x - from.x, dz = self.z - from.z;
  var len = Math.sqrt(dx * dx + dz * dz);
  if (len < 0.001) { dx = 1; dz = 0; len = 1; }
  var target = { x: Math.round(self.x + (dx / len) * steps), y: Math.round(self.y), z: Math.round(self.z + (dz / len) * steps) };
  if (!actions || typeof actions.moveTo !== "function") return { ok: false, message: "actions 不可用 / actions unavailable" };
  try {
    await actions.moveTo(ctx.bot, target.x, target.y, target.z, toNum(args.timeoutMs, 8000));
    return { ok: true, position: target, message: "已撤离到 " + (util ? util.posText(target) : "") };
  } catch (err) {
    return { ok: false, message: getErrText(err) };
  }
}

// 生存 3：跳起垫方块往上爬（best-effort，材料不足返回 ok:false）。
async function pillarUp(ctx, args) {
  var ready = requireBot(ctx.bot);
  if (!ready.ok) return ready;
  var block = toText(args.block || "dirt").trim();
  var item = util ? util.findItem(ctx.bot, block) : null;
  if (!item) return { ok: false, message: "没有垫脚方块 / no scaffolding block: " + block };
  if (!actions || typeof actions.placeBlock !== "function") return { ok: false, message: "actions 不可用 / actions unavailable" };
  var self = util ? util.posOf(ctx.bot) : null;
  if (!self) return { ok: false, message: "坐标读不到 / position unavailable" };
  try {
    if (typeof ctx.bot.setControlState === "function") ctx.bot.setControlState("jump", true);
    if (util) await util.sleep(250);
    if (typeof ctx.bot.setControlState === "function") ctx.bot.setControlState("jump", false);
    await actions.placeBlock(ctx.bot, block, Math.floor(self.x), Math.floor(self.y), Math.floor(self.z));
    return { ok: true, block: block, message: "垫了一格 / placed one: " + block };
  } catch (err) {
    return { ok: false, message: getErrText(err) };
  }
}

// 生存 4：使用手上的物品（右肩键动作）。
async function useItem(ctx) {
  var ready = requireBot(ctx.bot);
  if (!ready.ok) return ready;
  try {
    if (typeof ctx.bot.activateItem !== "function") return { ok: false, message: "activateItem 不可用 / activateItem unavailable" };
    ctx.bot.activateItem();
    return { ok: true, message: "已使用手上物品 / used held item" };
  } catch (err) {
    return { ok: false, message: getErrText(err) };
  }
}

// 常量：本文件负责的动作名 → 实现（感知 / 物品 / 生存）。
var HANDLERS = {
  scan_entities: scanEntities,
  find_block: findBlock,
  get_status: getStatus,
  count_item: countItem,
  distance_to: distanceTo,
  equip_item: equipItem,
  drop_item: dropItem,
  take_item: takeItem,
  store_item: storeItem,
  auto_eat: autoEat,
  flee: flee,
  pillar_up: pillarUp,
  use_item: useItem
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

// 对外导出：动作表 + 名单 + 查询函数（ACTIONS 是 NAMES 的别名，方便文档统一）。
module.exports = {
  HANDLERS: HANDLERS,
  NAMES: NAMES,
  ACTIONS: NAMES,
  has: has,
  pick: pick
};

