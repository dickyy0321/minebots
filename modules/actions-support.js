// ========================================
// 文件：modules/actions-support.js
// 功能：高级动作（辅助类）——村民交易、骨粉催熟、红石小回路、整理背包、箱子存取、整组丢给队友、给队友药水
// 依赖：./actions（可选）、./motion（可选）、./logger（可选）
// 导出：tradeWithVillager / bonemealCrop / placeRedstoneCircuit / sortInventory / chestDepositAll /
//       chestWithdrawStack / dropStackToAlly / givePotionToAlly / NAMES / has / pick / ACTIONS
// 作者：MineBots
// ========================================
//
// 约定：每个动作 async (bot, args) → Promise<{ ok, action, message, ... }>，永不 reject。
//       窗口 / 交易 / 容器这类 API 各版本差异大，全部先判断能力再调用，缺 API 只降级不抛错。
// ES5 风格，CommonJS，无中文变量名
var actions = null;
try { actions = require("./actions"); } catch (e) { actions = null; }
var motion = null;
try { motion = require("./motion"); } catch (e) { motion = null; }
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：容器 / 村民 / 作物的搜索半径与背包格子数。
var SEARCH_RADIUS = 16;
var CONTAINER_NAMES = ["chest", "trapped_chest", "barrel", "ender_chest", "shulker_box"];
var CROP_NAMES = ["wheat", "carrots", "potatoes", "beetroots", "melon_stem", "pumpkin_stem", "nether_wart", "sweet_berry_bush"];
var MAX_STACK = 64;

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

// 转数字（非法值返回兜底值）。
function toNum(value, fallback) {
  try {
    var n = Number(value);
    return isNaN(n) ? fallback : n;
  } catch (e) { return fallback; }
}

// 写文件日志：动作细节只落文件。
function logInfo(msg) {
  try {
    if (logger && typeof logger.info === "function") { logger.info("[actions3] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[actions3] " + msg); } catch (e2) { /* ignore */ }
}

// 写警告日志：失败要让人看见。
function logWarn(msg) {
  try {
    if (logger && typeof logger.warn === "function") { logger.warn("[actions3] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.warn("[actions3] " + msg); } catch (e2) { /* ignore */ }
}

// 统一失败体。
function fail(action, code, message) {
  logWarn("[actions3] " + action + " -> " + message);
  return { ok: false, action: action, code: code, message: message };
}

// 统一成功体：合并附加字段。
function succ(action, fields, message) {
  var out = { ok: true, action: action, message: message || "" };
  try {
    for (var k in fields) {
      if (Object.prototype.hasOwnProperty.call(fields, k)) out[k] = fields[k];
    }
  } catch (e) { /* 附加字段失败不影响成功 */ }
  return out;
}

// 读任意实体的坐标；读不到返回 null。
function posOf(entity) {
  try {
    var p = entity && entity.position ? entity.position : entity;
    if (!p) return null;
    var x = toNum(p.x, NaN), y = toNum(p.y, NaN), z = toNum(p.z, NaN);
    if (isNaN(x) || isNaN(y) || isNaN(z)) return null;
    return { x: x, y: y, z: z };
  } catch (e) { return null; }
}

// 读背包物品数组；读不到返回空数组。
function inventoryItems(bot) {
  try {
    if (!bot || !bot.inventory || typeof bot.inventory.items !== "function") return [];
    return bot.inventory.items() || [];
  } catch (e) { return []; }
}

// 在背包里按名字找物品（精确优先，其次包含匹配）；找不到返回 null。
function findItem(bot, name) {
  var want = toText(name);
  var fuzzy = null;
  var items = inventoryItems(bot);
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (!it) continue;
    var iname = toText(it.name);
    if (iname === want) return it;
    if (!fuzzy && want && iname.indexOf(want) >= 0) fuzzy = it;
  }
  return fuzzy;
}

// 可 await 的小睡（motion 缺失时兜底）。
function waitMs(ms) {
  return new Promise(function (resolve) {
    try { setTimeout(resolve, Math.round(toNum(ms, 100))); } catch (e) { resolve(); }
  });
}

// 分步缓转看某个点（交给 motion；失败忽略）。
async function lookTo(bot, point) {
  try {
    if (!bot || !point) return false;
    if (motion && typeof motion.easeLookAt === "function") {
      await motion.easeLookAt(bot, point, 4, { stepMs: 45 });
      return true;
    }
    if (typeof bot.lookAt === "function") { await bot.lookAt(point, true); return true; }
  } catch (e) { /* 视线失败不影响主流程 */ }
  return false;
}

// 在附近找指定名字的方块（名字数组），找到返回方块对象，找不到返回 null。
function findNearbyBlock(bot, names, radius) {
  try {
    if (!bot || typeof bot.findBlock !== "function") return null;
    var limit = toNum(radius, SEARCH_RADIUS);
    var wanted = names || [];
    var block = bot.findBlock({
      matching: function (b) { return !!b && wanted.indexOf(toText(b.name)) >= 0; },
      maxDistance: limit
    });
    return block || null;
  } catch (e) { return null; }
}
// 在附近找最近的实体（filter 返回 true 才算），返回 { entity, pos, dist } 或 null。
function nearestEntity(bot, filter, radius) {
  var best = null;
  try {
    if (!bot || !bot.entities) return null;
    var me = posOf(bot.entity);
    if (!me) return null;
    var limit = toNum(radius, SEARCH_RADIUS);
    for (var key in bot.entities) {
      if (!Object.prototype.hasOwnProperty.call(bot.entities, key)) continue;
      var ent = bot.entities[key];
      if (!ent || ent === bot.entity) continue;
      var hit = false;
      try { hit = !!filter(ent); } catch (e1) { hit = false; }
      if (!hit) continue;
      var p = posOf(ent);
      if (!p) continue;
      var dx = p.x - me.x, dy = p.y - me.y, dz = p.z - me.z;
      var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > limit) continue;
      if (!best || d < best.dist) best = { entity: ent, pos: p, dist: d };
    }
  } catch (e) { return null; }
  return best;
}

// 高级动作 9：村民交易——走到最近的村民旁，开交易窗，按索引成交若干次。
async function tradeWithVillager(bot, args) {
  var action = "trade_with_villager";
  try {
    if (!bot) return fail(action, "BOT_NOT_READY", "bot not ready / 机器人未就绪");
    var found = nearestEntity(bot, function (ent) {
      var name = toText(ent.name).toLowerCase();
      return !!ent.username ? false : (toText(ent.kind).indexOf("villager") >= 0 || name.indexOf("villager") >= 0 || name.indexOf("wandering_trader") >= 0);
    }, toNum(args && args.radius, 8));
    if (!found) return fail(action, "BAD_STATE", "no villager nearby / 附近没有村民");
    var villager = found.entity;
    if (typeof bot.trade !== "function") return fail(action, "BAD_PARAM", "trade unsupported / 当前版本不支持交易");
    await lookTo(bot, { x: found.pos.x, y: found.pos.y + 1.5, z: found.pos.z });
    var index = Math.round(toNum(args && args.index, 0));
    if (isNaN(index) || index < 0) index = 0;
    var times = Math.round(toNum(args && args.times, 1));
    if (isNaN(times) || times < 1) times = 1;
    if (times > 8) times = 8;
    await bot.trade(villager, index, times);
    return succ(action, { villager: toText(villager.name), index: index, times: times },
      "交易完成 / traded with villager x" + times);
  } catch (err) { return fail(action, "FAILED", "failed / 执行失败: " + errText(err)); }
}

// 高级动作 10：骨粉催熟——找最近的一株作物，装骨粉右键催一下。
async function bonemealCrop(bot, args) {
  var action = "bonemeal_crop";
  try {
    if (!bot) return fail(action, "BOT_NOT_READY", "bot not ready / 机器人未就绪");
    var meal = findItem(bot, "bone_meal");
    if (!meal) return fail(action, "BAD_PARAM", "no bone meal / 背包里没有骨粉");
    var crop = findNearbyBlock(bot, CROP_NAMES, toNum(args && args.radius, 6));
    if (!crop) return fail(action, "BAD_STATE", "no crop nearby / 附近没有作物");
    if (typeof bot.equip !== "function" || typeof bot.activateBlock !== "function") {
      return fail(action, "BAD_PARAM", "bonemeal unsupported / 不支持催熟");
    }
    await bot.equip(meal, "hand");
    var cp = posOf(crop.position ? crop.position : crop);
    if (cp) await lookTo(bot, { x: cp.x + 0.5, y: cp.y + 0.5, z: cp.z + 0.5 });
    await bot.activateBlock(crop);
    return succ(action, { crop: toText(crop.name) }, "已催熟 / fertilized " + toText(crop.name));
  } catch (err) { return fail(action, "FAILED", "failed / 执行失败: " + errText(err)); }
}

// 高级动作 11：红石小回路——按「前方 / 脚下」的相对偏移依次放方块（默认火把 + 红石 + 活塞）。
async function placeRedstoneCircuit(bot, args) {
  var action = "place_redstone_circuit";
  try {
    if (!bot) return fail(action, "BOT_NOT_READY", "bot not ready / 机器人未就绪");
    if (!actions || typeof actions.placeBlock !== "function") return fail(action, "BAD_PARAM", "actions unavailable / 动作模块不可用");
    var self = posOf(bot.entity);
    if (!self) return fail(action, "BAD_PARAM", "position unavailable / 坐标读不到");
    // 默认回路：脚前方一格放红石块，脚下放红石火把，再前面两格放活塞。
    var plan = args && Array.isArray(args.pattern) ? args.pattern : [
      { name: "redstone_block", dx: 1, dy: -1, dz: 0 },
      { name: "redstone_torch", dx: 0, dy: 0, dz: 1 },
      { name: "piston", dx: 2, dy: -1, dz: 0 }
    ];
    var placed = [];
    var failed = [];
    for (var i = 0; i < plan.length; i++) {
      var step = plan[i] || {};
      var name = toText(step.name);
      if (!name) continue;
      var tx = Math.floor(self.x + toNum(step.dx, 0));
      var ty = Math.floor(self.y + toNum(step.dy, -1));
      var tz = Math.floor(self.z + toNum(step.dz, 1));
      var res = null;
      try { res = await actions.placeBlock(bot, name, tx, ty, tz); } catch (e1) { res = null; }
      if (res && res.ok === true) placed.push({ name: name, x: tx, y: ty, z: tz });
      else failed.push(name);
      await waitMs(120);
    }
    if (!placed.length) return fail(action, "FAILED", "circuit failed / 红石回路一个都没放成");
    return succ(action, { placed: placed, failed: failed },
      "红石回路 " + placed.length + " 个部件就位 / placed " + placed.length + " redstone parts");
  } catch (err) { return fail(action, "FAILED", "failed / 执行失败: " + errText(err)); }
}
// 高级动作 12：整理背包——把同名未满的堆叠合并到一格里（能合并就 moveSlotItem，合并不了就只出报告）。
async function sortInventory(bot) {
  var action = "sort_inventory";
  try {
    if (!bot) return fail(action, "BOT_NOT_READY", "bot not ready / 机器人未就绪");
    var items = inventoryItems(bot);
    if (!items.length) return succ(action, { stacks: 0, merged: 0, mergedPairs: [] }, "背包是空的 / inventory empty");
    var groups = {};
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it) continue;
      var name = toText(it.name);
      if (!groups[name]) groups[name] = [];
      groups[name].push(it);
    }
    var pairs = [];
    var mergeable = 0;
    for (var key in groups) {
      if (!Object.prototype.hasOwnProperty.call(groups, key)) continue;
      var stack = groups[key];
      if (stack.length < 2) continue;
      mergeable = mergeable + (stack.length - 1);
      pairs.push({ from: stack[1].slot, to: stack[0].slot, name: key });
    }
    var merged = 0;
    if (typeof bot.moveSlotItem === "function") {
      for (var j = 0; j < pairs.length; j++) {
        try {
          await bot.moveSlotItem(pairs[j].from, pairs[j].to);
          merged = merged + 1;
          await waitMs(120);
        } catch (e1) { /* 单对合并失败就跳过 */ }
      }
    }
    return succ(action, { stacks: items.length, mergeable: mergeable, merged: merged, pairs: pairs },
      "背包整理完成，合并 " + merged + " 组 / inventory sorted, merged " + merged);
  } catch (err) { return fail(action, "FAILED", "failed / 执行失败: " + errText(err)); }
}

// 内部：找最近的容器并打开，返回 { ok, window, block } 或失败体。
async function openNearestContainer(bot, radius) {
  try {
    var block = findNearbyBlock(bot, CONTAINER_NAMES, radius);
    if (!block) return { ok: false, message: "no container nearby / 附近没有箱子" };
    var window = null;
    if (typeof bot.openContainer === "function") window = await bot.openContainer(block);
    else if (typeof bot.openBlock === "function") window = await bot.openBlock(block);
    else return { ok: false, message: "open container unsupported / 当前版本不支持开箱子" };
    if (!window) return { ok: false, message: "container did not open / 箱子没打开" };
    return { ok: true, window: window, block: block };
  } catch (err) {
    return { ok: false, message: "open container failed / 开箱子失败: " + errText(err) };
  }
}

// 内部：关箱子，失败只记日志。
async function closeContainer(bot, window) {
  try {
    if (bot && typeof bot.closeWindow === "function" && window) await bot.closeWindow(window);
    return true;
  } catch (e) { return false; }
}

// 高级动作 13：一键把背包全存进最近的箱子（args.keep 里的名字保留不存）。
async function chestDepositAll(bot, args) {
  var action = "chest_deposit_all";
  try {
    if (!bot) return fail(action, "BOT_NOT_READY", "bot not ready / 机器人未就绪");
    var opened = await openNearestContainer(bot, toNum(args && args.radius, SEARCH_RADIUS));
    if (!opened.ok) return fail(action, "BAD_STATE", opened.message);
    var window = opened.window;
    if (typeof window.deposit !== "function") {
      await closeContainer(bot, window);
      return fail(action, "BAD_PARAM", "deposit unsupported / 当前版本不支持存箱");
    }
    var keep = (args && Array.isArray(args.keep)) ? args.keep : [];
    var items = inventoryItems(bot);
    var stored = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it) continue;
      var name = toText(it.name);
      if (keep.indexOf(name) >= 0) continue;
      try {
        await window.deposit(toNum(it.type, 0), null, toNum(it.count, 1));
        stored = stored + 1;
      } catch (e1) { /* 单个物品存不进去就跳过 */ }
    }
    await closeContainer(bot, window);
    return succ(action, { stored: stored, container: toText(opened.block ? opened.block.name : "chest") },
      "已存 " + stored + " 组进箱子 / deposited " + stored + " stacks");
  } catch (err) { return fail(action, "FAILED", "failed / 执行失败: " + errText(err)); }
}

// 高级动作 14：从最近的箱子取一叠指定物品（默认 64 个）。
async function chestWithdrawStack(bot, args) {
  var action = "chest_withdraw_stack";
  try {
    if (!bot) return fail(action, "BOT_NOT_READY", "bot not ready / 机器人未就绪");
    var want = toText(args && args.item);
    if (!want) return fail(action, "BAD_PARAM", "item required / 缺少物品名");
    var opened = await openNearestContainer(bot, toNum(args && args.radius, SEARCH_RADIUS));
    if (!opened.ok) return fail(action, "BAD_STATE", opened.message);
    var window = opened.window;
    if (typeof window.withdraw !== "function") {
      await closeContainer(bot, window);
      return fail(action, "BAD_PARAM", "withdraw unsupported / 当前版本不支持取箱");
    }
    var count = Math.round(toNum(args && args.count, MAX_STACK));
    if (isNaN(count) || count < 1) count = 1;
    if (count > MAX_STACK) count = MAX_STACK;
    var target = null;
    try {
      var inside = (typeof window.containerItems === "function") ? window.containerItems() : [];
      for (var i = 0; i < inside.length; i++) {
        if (inside[i] && toText(inside[i].name) === want) { target = inside[i]; break; }
      }
    } catch (e1) { target = null; }
    if (!target) {
      await closeContainer(bot, window);
      return fail(action, "BAD_STATE", "item not in container / 箱子里没有该物品: " + want);
    }
    await window.withdraw(toNum(target.type, 0), null, count);
    await closeContainer(bot, window);
    return succ(action, { item: want, count: count }, "取出 " + want + " x" + count + " / withdrew " + want);
  } catch (err) { return fail(action, "FAILED", "failed / 执行失败: " + errText(err)); }
}
// 高级动作 15：整组丢给队友——先转向队友（像「递东西」），再把手上的整叠丢出去。
async function dropStackToAlly(bot, args) {
  var action = "drop_stack_to_ally";
  try {
    if (!bot) return fail(action, "BOT_NOT_READY", "bot not ready / 机器人未就绪");
    var wantName = toText(args && args.item);
    var item = wantName ? findItem(bot, wantName) : null;
    if (!item) {
      var items = inventoryItems(bot);
      if (!items.length) return fail(action, "BAD_STATE", "inventory empty / 背包是空的");
      item = items[0];
    }
    if (typeof bot.toss !== "function") return fail(action, "BAD_PARAM", "toss unsupported / 不支持丢弃物品");
    var allyName = toText(args && args.target);
    var ally = null;
    if (allyName) {
      ally = nearestEntity(bot, function (ent) {
        var nm = toText(ent.username) || toText(ent.name);
        return nm === allyName;
      }, toNum(args && args.radius, 16));
    }
    if (ally) {
      // 先看向队友，再把东西扔出去，落点更靠近他。
      await lookTo(bot, { x: ally.pos.x, y: ally.pos.y + 1.4, z: ally.pos.z });
      if (motion && typeof motion.pause === "function") { try { await motion.pause(); } catch (e1) { /* ignore */ } }
    }
    var count = Math.round(toNum(args && args.count, toNum(item.count, 1)));
    if (isNaN(count) || count < 1) count = 1;
    await bot.toss(toNum(item.type, 0), null, count);
    var itemName = toText(item.name);
    return succ(action, {
      item: itemName, count: count,
      target: ally ? (toText(ally.entity.username) || toText(ally.entity.name)) : ""
    }, "已丢出 " + itemName + " x" + count + " / dropped " + itemName);
  } catch (err) { return fail(action, "FAILED", "failed / 执行失败: " + errText(err)); }
}

// 高级动作 16：给队友丢治疗药水——装喷溅药水、转向队友、右键出手。
async function givePotionToAlly(bot, args) {
  var action = "give_potion_to_ally";
  try {
    if (!bot) return fail(action, "BOT_NOT_READY", "bot not ready / 机器人未就绪");
    var allyName = toText(args && args.target);
    if (!allyName) return fail(action, "BAD_PARAM", "target required / 缺少队友名");
    var potion = findItem(bot, toText(args && args.potion) || "splash_potion") || findItem(bot, "splash_") || findItem(bot, "potion");
    if (!potion) return fail(action, "BAD_PARAM", "no potion / 背包里没有药水");
    if (typeof bot.equip !== "function" || typeof bot.activateItem !== "function") {
      return fail(action, "BAD_PARAM", "potion throw unsupported / 当前版本不支持扔药水");
    }
    var ally = nearestEntity(bot, function (ent) {
      var nm = toText(ent.username) || toText(ent.name);
      return nm === allyName;
    }, toNum(args && args.radius, 16));
    if (!ally) return fail(action, "BAD_STATE", "ally not found / 没找到队友: " + allyName);
    await bot.equip(potion, "hand");
    await lookTo(bot, { x: ally.pos.x, y: ally.pos.y + 1.2, z: ally.pos.z });
    if (motion && typeof motion.pause === "function") { try { await motion.pause(); } catch (e1) { /* ignore */ } }
    bot.activateItem();
    var potionName = toText(potion.name);
    return succ(action, { item: potionName, target: allyName, distance: Math.round(ally.dist * 100) / 100 },
      "已把 " + potionName + " 丢给 " + allyName + " / threw " + potionName + " to " + allyName);
  } catch (err) { return fail(action, "FAILED", "failed / 执行失败: " + errText(err)); }
}

// 常量：本文件动作名 → 实现（供动作桥 / 状态机 / AI 统一按名字调用）。
var HANDLERS = {
  trade_with_villager: tradeWithVillager,
  bonemeal_crop: bonemealCrop,
  place_redstone_circuit: placeRedstoneCircuit,
  sort_inventory: sortInventory,
  chest_deposit_all: chestDepositAll,
  chest_withdraw_stack: chestWithdrawStack,
  drop_stack_to_ally: dropStackToAlly,
  give_potion_to_ally: givePotionToAlly
};

// 常量：动作名列表（顺序即 GUI / 文档顺序）。
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

// 对外导出：8 个辅助动作 + 名单 + 查询函数。
module.exports = {
  tradeWithVillager: tradeWithVillager,
  bonemealCrop: bonemealCrop,
  placeRedstoneCircuit: placeRedstoneCircuit,
  sortInventory: sortInventory,
  chestDepositAll: chestDepositAll,
  chestWithdrawStack: chestWithdrawStack,
  dropStackToAlly: dropStackToAlly,
  givePotionToAlly: givePotionToAlly,
  HANDLERS: HANDLERS,
  NAMES: NAMES,
  ACTIONS: NAMES,
  has: has,
  pick: pick,
  CONTAINER_NAMES: CONTAINER_NAMES,
  CROP_NAMES: CROP_NAMES
};


