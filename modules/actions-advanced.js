// ========================================
// 文件：modules/actions-advanced.js
// 功能：高级动作（战斗 / 移动类）——自动搭桥、落水缓冲、闪避箭矢、吃金苹果、盾墙、引怪入坑、引爆 TNT、跳搭升天
// 依赖：./actions（可选）、./motion（可选）、./logger（可选）
// 导出：autoBridge / mlgWater / dodgeArrow / eatGoldenApple / shieldWall / lureMobsToTrap / igniteTnt /
//       pillarBridge / NAMES / has / pick / ACTIONS
// 作者：MineBots
// ========================================
//
// 约定：每个动作 async (bot, args) → Promise<{ ok, action, message, ... }>，永不 reject。
//       所有 mineflayer 调用都先做能力判断，缺 API 就回 ok:false + 双语 message，绝不抛到顶层。
// ES5 风格，CommonJS，无中文变量名
var actions = null;
try { actions = require("./actions"); } catch (e) { actions = null; }
var motion = null;
try { motion = require("./motion"); } catch (e) { motion = null; }
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：搭桥 / 引怪最大步数、搜索半径、TNT 撤退距离。
var MAX_STEPS = 24;
var DEFAULT_STEPS = 6;
var SEARCH_RADIUS = 16;
var RETREAT_DISTANCE = 8;
// 常量：可用来搭桥 / 垫脚的方块（按优先级）。
var BRIDGE_BLOCKS = ["cobblestone", "dirt", "stone", "oak_planks", "netherrack", "sand", "gravel"];
// 常量：会主动打人的生物关键字（引怪与盾墙都用它筛目标）。
var HOSTILE_HINTS = ["zombie", "skeleton", "spider", "creeper", "witch", "pillager", "blaze", "enderman", "husk", "drowned", "piglin", "vindicator", "ravager", "phantom", "slime", "magma"];

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

// 写文件日志：动作细节只落文件，不刷 GUI。
function logInfo(msg) {
  try {
    if (logger && typeof logger.info === "function") { logger.info("[actions2] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[actions2] " + msg); } catch (e2) { /* ignore */ }
}

// 写警告日志：动作失败要让人看见。
function logWarn(msg) {
  try {
    if (logger && typeof logger.warn === "function") { logger.warn("[actions2] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.warn("[actions2] " + msg); } catch (e2) { /* ignore */ }
}

// 统一失败体：ok / action / code / 双语 message。
function fail(action, code, message) {
  logWarn("[actions2] " + action + " -> " + message);
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

// 两点水平距离（y 轴不参与），读不到返回 -1。
function flatDist(a, b) {
  try {
    if (!a || !b) return -1;
    var dx = a.x - b.x, dz = a.z - b.z;
    return Math.sqrt(dx * dx + dz * dz);
  } catch (e) { return -1; }
}

// 在背包里按名字找物品；精确名优先，其次前缀包含匹配。
function findItem(bot, name) {
  var want = toText(name);
  var fuzzy = null;
  try {
    if (!bot || !bot.inventory || typeof bot.inventory.items !== "function") return null;
    var items = bot.inventory.items() || [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it) continue;
      var iname = toText(it.name);
      if (iname === want) return it;
      if (!fuzzy && want && iname.indexOf(want) >= 0) fuzzy = it;
    }
  } catch (e) { return null; }
  return fuzzy;
}

// 按优先级挑一个搭桥方块；args 指定优先，其次 BRIDGE_BLOCKS 顺序，最后任意非工具方块。
function pickBridgeBlock(bot, wanted) {
  try {
    var want = toText(wanted);
    if (want) {
      var picked = findItem(bot, want);
      if (picked) return picked;
    }
    for (var i = 0; i < BRIDGE_BLOCKS.length; i++) {
      var it = findItem(bot, BRIDGE_BLOCKS[i]);
      if (it) return it;
    }
    if (!bot || !bot.inventory || typeof bot.inventory.items !== "function") return null;
    var all = bot.inventory.items() || [];
    for (var j = 0; j < all.length; j++) {
      var name = toText(all[j] ? all[j].name : "");
      if (name.indexOf("bucket") >= 0 || name.indexOf("sword") >= 0 || name.indexOf("pickaxe") >= 0) continue;
      return all[j];
    }
  } catch (e) { return null; }
  return null;
}

// 把方向参数（x / z）换算成单位向量；不传就按 bot 当前朝向算「正前方」。
function forwardDir(bot, dir) {
  try {
    var dx = toNum(dir && dir.x, NaN);
    var dz = toNum(dir && dir.z, NaN);
    if (!isNaN(dx) || !isNaN(dz)) {
      var ax = isNaN(dx) ? 0 : dx;
      var az = isNaN(dz) ? 0 : dz;
      var len = Math.sqrt(ax * ax + az * az);
      if (len > 0.0001) return { x: ax / len, z: az / len };
    }
    var ent = bot && bot.entity ? bot.entity : null;
    var yaw = ent ? toNum(ent.yaw, NaN) : NaN;
    if (!isNaN(yaw)) return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
  } catch (e) { /* 退回 +z */ }
  return { x: 0, z: 1 };
}

// 列出半径内的敌对生物（按由近到远），读不到返回空数组。
function listHostiles(bot, radius) {
  var out = [];
  try {
    if (!bot || !bot.entities) return out;
    var me = posOf(bot.entity);
    if (!me) return out;
    var limit = toNum(radius, SEARCH_RADIUS);
    for (var key in bot.entities) {
      if (!Object.prototype.hasOwnProperty.call(bot.entities, key)) continue;
      var ent = bot.entities[key];
      if (!ent || ent === bot.entity) continue;
      var name = toText(ent.name).toLowerCase();
      var hit = false;
      for (var i = 0; i < HOSTILE_HINTS.length; i++) {
        if (name.indexOf(HOSTILE_HINTS[i]) >= 0) { hit = true; break; }
      }
      if (!hit) continue;
      var p = posOf(ent);
      if (!p) continue;
      var d = flatDist(p, me);
      if (d < 0 || d > limit) continue;
      out.push({ entity: ent, pos: p, dist: d });
    }
    out.sort(function (a, b) { return a.dist - b.dist; });
  } catch (e) { return []; }
  return out;
}

// 列出半径内的箭矢 / 三叉戟实体（闪避用），读不到返回空数组。
function listArrows(bot, radius) {
  var out = [];
  try {
    if (!bot || !bot.entities) return out;
    var me = posOf(bot.entity);
    if (!me) return out;
    var limit = toNum(radius, 10);
    for (var key in bot.entities) {
      if (!Object.prototype.hasOwnProperty.call(bot.entities, key)) continue;
      var ent = bot.entities[key];
      if (!ent) continue;
      var name = toText(ent.name).toLowerCase();
      var kind = toText(ent.objectType).toLowerCase();
      var isArrow = name.indexOf("arrow") >= 0 || name.indexOf("trident") >= 0 || kind.indexOf("arrow") >= 0;
      if (!isArrow) continue;
      var p = posOf(ent);
      if (!p) continue;
      var d = flatDist(p, me);
      if (d < 0 || d > limit) continue;
      out.push({ entity: ent, pos: p, dist: d });
    }
    out.sort(function (a, b) { return a.dist - b.dist; });
  } catch (e) { return []; }
  return out;
}
// 按住某个控制键走一小步再松开（搭桥 / 闪避的节奏单元），失败不抛错。
async function tapControl(bot, control, ms) {
  try {
    if (!bot || typeof bot.setControlState !== "function") return false;
    bot.setControlState(control, true);
    await motionWait(toNum(ms, 180));
    bot.setControlState(control, false);
    return true;
  } catch (e) { return false; }
}

// 可 await 的小睡（motion 缺失时用 setTimeout 兜底）。
function motionWait(ms) {
  return new Promise(function (resolve) {
    try { setTimeout(resolve, Math.round(toNum(ms, 100))); } catch (e) { resolve(); }
  });
}

// 收步：交给 motion.easeStop 做惯性减速，没有 motion 就自己清控制键。
async function easeOff(bot) {
  try {
    if (motion && typeof motion.easeStop === "function") { await motion.easeStop(bot, 120); return true; }
    if (bot && typeof bot.clearControlStates === "function") { bot.clearControlStates(); return true; }
  } catch (e) { /* ignore */ }
  return false;
}

// 动作之间的呼吸停顿（100~200ms），没有 motion 就缩短等待。
async function breathe() {
  try {
    if (motion && typeof motion.pause === "function") { await motion.pause(); return; }
  } catch (e) { /* 退回定长等待 */ }
  await motionWait(120);
}

// 高级动作 1：自动搭桥——朝前铺方块并一小步一小步往前走，材料没了立刻停。
async function autoBridge(bot, args) {
  var action = "auto_bridge";
  try {
    if (!bot) return fail(action, "BOT_NOT_READY", "bot not ready / 机器人未就绪");
    if (typeof bot.setControlState !== "function") return fail(action, "BAD_PARAM", "control unsupported / 机器人不支持控制键");
    if (!actions || typeof actions.placeBlock !== "function") return fail(action, "BAD_PARAM", "actions unavailable / 动作模块不可用");
    var steps = Math.round(toNum(args && args.steps, DEFAULT_STEPS));
    if (isNaN(steps) || steps < 1) steps = 1;
    if (steps > MAX_STEPS) steps = MAX_STEPS;
    var item = pickBridgeBlock(bot, args && args.block);
    if (!item) return fail(action, "BAD_PARAM", "no block for bridge / 背包里没有可搭桥的方块");
    var self = posOf(bot.entity);
    if (!self) return fail(action, "BAD_PARAM", "position unavailable / 坐标读不到");
    var dir = forwardDir(bot, args);
    var placed = 0;
    for (var i = 1; i <= steps; i++) {
      var tx = Math.floor(self.x + dir.x * i);
      var tz = Math.floor(self.z + dir.z * i);
      var ty = Math.floor(self.y) - 1;
      var res = null;
      try { res = await actions.placeBlock(bot, item.name, tx, ty, tz); } catch (e1) { res = null; }
      if (!res || res.ok !== true) break;
      placed = placed + 1;
      await tapControl(bot, "forward", 180);
      await breathe();
    }
    await easeOff(bot);
    if (placed === 0) return fail(action, "FAILED", "bridge failed / 搭桥失败（方块没放上去）");
    return succ(action, { placed: placed, steps: steps, block: item.name },
      "搭桥 " + placed + " 格 / bridged " + placed + " blocks");
  } catch (err) { return fail(action, "FAILED", "failed / 执行失败: " + errText(err)); }
}

// 高级动作 2：摔落水缓冲——正在下落且带水桶时，朝脚下放水，落地后再把水收回。
async function mlgWater(bot) {
  var action = "mlg_water";
  try {
    if (!bot) return fail(action, "BOT_NOT_READY", "bot not ready / 机器人未就绪");
    var self = posOf(bot.entity);
    if (!self) return fail(action, "BAD_PARAM", "position unavailable / 坐标读不到");
    var vel = bot.entity ? bot.entity.velocity : null;
    var fall = vel ? toNum(vel.y, 0) : 0;
    if (fall > -0.2) return fail(action, "BAD_STATE", "not falling / 当前不在下落中");
    var bucket = findItem(bot, "water_bucket");
    if (!bucket) return fail(action, "BAD_PARAM", "no water bucket / 背包里没有水桶");
    if (typeof bot.equip !== "function") return fail(action, "BAD_PARAM", "equip unsupported / 不支持装备物品");
    await bot.equip(bucket, "hand");
    if (motion && typeof motion.easeLookAt === "function") {
      await motion.easeLookAt(bot, { x: self.x, y: self.y - 4, z: self.z }, 3, { stepMs: 40 });
    }
    if (typeof bot.activateItem !== "function") return fail(action, "BAD_PARAM", "activate unsupported / 不支持使用物品");
    bot.activateItem();
    await motionWait(350);
    // 收水：再按一次右键把水收回桶里，避免留一滩水。
    try { bot.activateItem(); } catch (e1) { /* 收不回来也不影响落地缓冲 */ }
    return succ(action, { fallSpeed: Math.round(fall * 100) / 100 }, "已落地缓冲 / water bucket placed");
  } catch (err) { return fail(action, "FAILED", "failed / 执行失败: " + errText(err)); }
}
// 高级动作 3：闪避箭矢——发现飞行物就朝垂直于来向的方向横移一小步并跳一下。
async function dodgeArrow(bot) {
  var action = "dodge_arrow";
  try {
    if (!bot) return fail(action, "BOT_NOT_READY", "bot not ready / 机器人未就绪");
    if (typeof bot.setControlState !== "function") return fail(action, "BAD_PARAM", "control unsupported / 机器人不支持控制键");
    var arrows = listArrows(bot, 10);
    if (!arrows.length) return fail(action, "BAD_STATE", "no arrow nearby / 附近没有飞行物");
    var arrow = arrows[0];
    var vel = arrow.entity ? arrow.entity.velocity : null;
    // 箭从左边飞来就往右躲：用箭的水平速度符号决定横移方向。
    var vx = vel ? toNum(vel.x, 0) : 0;
    var side = vx >= 0 ? "left" : "right";
    bot.setControlState(side, true);
    try { bot.setControlState("jump", true); } catch (e1) { /* 跳不起来也能横移 */ }
    await motionWait(260);
    try { bot.setControlState("jump", false); } catch (e2) { /* ignore */ }
    await easeOff(bot);
    return succ(action, { side: side, distance: Math.round(arrow.dist * 100) / 100 }, "已闪避 / dodged to " + side);
  } catch (err) { return fail(action, "FAILED", "failed / 执行失败: " + errText(err)); }
}

// 高级动作 4：吃金苹果（优先附魔金苹果），没货就回 ok:false。
async function eatGoldenApple(bot) {
  var action = "eat_golden_apple";
  try {
    if (!bot) return fail(action, "BOT_NOT_READY", "bot not ready / 机器人未就绪");
    var item = findItem(bot, "enchanted_golden_apple") || findItem(bot, "golden_apple") || findItem(bot, "apple");
    if (!item) return fail(action, "BAD_PARAM", "no golden apple / 背包里没有金苹果");
    if (typeof bot.equip !== "function" || typeof bot.consume !== "function") {
      return fail(action, "BAD_PARAM", "eat unsupported / 不支持进食");
    }
    await bot.equip(item, "hand");
    await breathe();
    await bot.consume();
    var itemName = toText(item.name);
    return succ(action, { item: itemName }, "已吃 " + itemName + " / ate " + itemName);
  } catch (err) { return fail(action, "FAILED", "failed / 执行失败: " + errText(err)); }
}

// 高级动作 5：盾墙——把盾装到副手、面向最近的敌人并举起盾。
async function shieldWall(bot, args) {
  var action = "shield_wall";
  try {
    if (!bot) return fail(action, "BOT_NOT_READY", "bot not ready / 机器人未就绪");
    var shield = findItem(bot, "shield");
    if (!shield) return fail(action, "BAD_PARAM", "no shield / 背包里没有盾牌");
    if (typeof bot.equip !== "function") return fail(action, "BAD_PARAM", "equip unsupported / 不支持装备物品");
    await bot.equip(shield, "off-hand");
    var target = null;
    var hostiles = listHostiles(bot, SEARCH_RADIUS);
    if (hostiles.length) target = hostiles[0];
    if (target && typeof bot.lookAt === "function") {
      var aim = { x: target.pos.x, y: target.pos.y + 1.4, z: target.pos.z };
      if (motion && typeof motion.easeLookAt === "function") await motion.easeLookAt(bot, aim, 4, { stepMs: 45 });
      else { try { await bot.lookAt(aim, true); } catch (e1) { /* 视线失败也要举盾 */ } }
    }
    if (typeof bot.activateItem !== "function") return fail(action, "BAD_PARAM", "activate unsupported / 不支持使用物品");
    try { bot.activateItem(true); } catch (e2) { /* 副手使用失败：盾已装上，仍算部分成功 */ }
    var facing = target ? toText(target.entity.username || target.entity.name) : "";
    return succ(action, { equipped: "shield", facing: facing },
      facing ? ("盾墙就位，正对 " + facing + " / shield up facing " + facing) : "盾墙就位 / shield up");
  } catch (err) { return fail(action, "FAILED", "failed / 执行失败: " + errText(err)); }
}

// 高级动作 6：引怪入坑——挑最近的敌人，朝远离它的方向撤到陷阱点，并一直回头盯着它。
async function lureMobsToTrap(bot, args) {
  var action = "lure_mobs_to_trap";
  try {
    if (!bot) return fail(action, "BOT_NOT_READY", "bot not ready / 机器人未就绪");
    var self = posOf(bot.entity);
    if (!self) return fail(action, "BAD_PARAM", "position unavailable / 坐标读不到");
    var hostiles = listHostiles(bot, SEARCH_RADIUS);
    if (!hostiles.length) return fail(action, "BAD_STATE", "no mob nearby / 附近没有可引的怪");
    var mob = hostiles[0];
    var trap = null;
    if (args && !isNaN(toNum(args.x, NaN)) && !isNaN(toNum(args.z, NaN))) {
      trap = { x: Math.floor(toNum(args.x, self.x)), y: Math.floor(toNum(args.y, self.y)), z: Math.floor(toNum(args.z, self.z)) };
    } else {
      // 没给陷阱点：朝「背离怪」的方向退 RETREAT_DISTANCE 格，边退边把它们带走。
      var dx = self.x - mob.pos.x;
      var dz = self.z - mob.pos.z;
      var len = Math.sqrt(dx * dx + dz * dz);
      if (len < 0.001) { dx = 1; dz = 0; len = 1; }
      var dist = toNum(args && args.distance, RETREAT_DISTANCE);
      trap = {
        x: Math.floor(self.x + (dx / len) * dist),
        y: Math.floor(self.y),
        z: Math.floor(self.z + (dz / len) * dist)
      };
    }
    if (!actions || typeof actions.moveTo !== "function") return fail(action, "BAD_PARAM", "actions unavailable / 动作模块不可用");
    await actions.moveTo(bot, trap.x, trap.y, trap.z, toNum(args && args.timeoutMs, 8000));
    if (typeof bot.lookAt === "function") {
      var aim = { x: mob.pos.x, y: mob.pos.y + 1.4, z: mob.pos.z };
      if (motion && typeof motion.easeLookAt === "function") await motion.easeLookAt(bot, aim, 4, { stepMs: 45 });
    }
    var mobName = toText(mob.entity.name);
    return succ(action, { mob: mobName, trap: trap, distance: Math.round(mob.dist * 100) / 100 },
      "已把 " + mobName + " 引向陷阱 / lured " + mobName + " to trap");
  } catch (err) { return fail(action, "FAILED", "failed / 执行失败: " + errText(err)); }
}
// 高级动作 7：引爆 TNT——在前方放一个 TNT，用打火石点着，然后立刻后撤 RETREAT_DISTANCE 格。
async function igniteTnt(bot, args) {
  var action = "ignite_tnt";
  try {
    if (!bot) return fail(action, "BOT_NOT_READY", "bot not ready / 机器人未就绪");
    if (!actions || typeof actions.placeBlock !== "function") return fail(action, "BAD_PARAM", "actions unavailable / 动作模块不可用");
    var self = posOf(bot.entity);
    if (!self) return fail(action, "BAD_PARAM", "position unavailable / 坐标读不到");
    var tnt = findItem(bot, "tnt");
    if (!tnt) return fail(action, "BAD_PARAM", "no tnt / 背包里没有 TNT");
    var lighter = findItem(bot, "flint_and_steel");
    if (!lighter) return fail(action, "BAD_PARAM", "no flint and steel / 背包里没有打火石");
    var dir = forwardDir(bot, args);
    var tx = Math.floor(self.x + dir.x * 2);
    var tz = Math.floor(self.z + dir.z * 2);
    var ty = Math.floor(self.y);
    var placed = await actions.placeBlock(bot, "tnt", tx, ty, tz);
    if (!placed || placed.ok !== true) return fail(action, "FAILED", "tnt place failed / TNT 没放成");
    // 点火：先装备打火石，再用右键点 TNT 方块本身。
    if (typeof bot.equip === "function") { try { await bot.equip(lighter, "hand"); } catch (e1) { /* 手上已有就打火 */ } }
    var lit = false;
    try {
      var block = null;
      if (typeof bot.blockAt === "function") block = bot.blockAt({ x: tx, y: ty, z: tz });
      if (block && typeof bot.activateBlock === "function") { await bot.activateBlock(block); lit = true; }
      else if (typeof bot.activateItem === "function") { bot.activateItem(); lit = true; }
    } catch (e2) { lit = false; }
    // 不管点着没点着都先撤：TNT 一旦落地点着就是几秒的事。
    var back = {
      x: Math.floor(self.x - dir.x * RETREAT_DISTANCE),
      y: Math.floor(self.y),
      z: Math.floor(self.z - dir.z * RETREAT_DISTANCE)
    };
    if (typeof actions.moveTo === "function") {
      try { await actions.moveTo(bot, back.x, back.y, back.z, toNum(args && args.timeoutMs, 6000)); } catch (e3) { /* 撤不走也别停在这 */ }
    }
    if (!lit) return fail(action, "FAILED", "tnt not ignited / TNT 没点着");
    return succ(action, { tnt: { x: tx, y: ty, z: tz }, retreat: back },
      "TNT 已点燃并后撤 / tnt ignited, retreated");
  } catch (err) { return fail(action, "FAILED", "failed / 执行失败: " + errText(err)); }
}

// 高级动作 8：跳搭升天——边跳边往脚下垫方块，一格格往上升（爬墙 / 逃出坑）。
async function pillarBridge(bot, args) {
  var action = "pillar_bridge";
  try {
    if (!bot) return fail(action, "BOT_NOT_READY", "bot not ready / 机器人未就绪");
    if (typeof bot.setControlState !== "function") return fail(action, "BAD_PARAM", "control unsupported / 机器人不支持控制键");
    if (!actions || typeof actions.placeBlock !== "function") return fail(action, "BAD_PARAM", "actions unavailable / 动作模块不可用");
    var steps = Math.round(toNum(args && args.steps, 3));
    if (isNaN(steps) || steps < 1) steps = 1;
    if (steps > 12) steps = 12;
    var item = pickBridgeBlock(bot, args && args.block);
    if (!item) return fail(action, "BAD_PARAM", "no block for pillar / 背包里没有可垫的方块");
    var up = 0;
    for (var i = 0; i < steps; i++) {
      var self = posOf(bot.entity);
      if (!self) break;
      bot.setControlState("jump", true);
      await motionWait(250);
      bot.setControlState("jump", false);
      var res = null;
      try {
        res = await actions.placeBlock(bot, item.name, Math.floor(self.x), Math.floor(self.y), Math.floor(self.z));
      } catch (e1) { res = null; }
      if (!res || res.ok !== true) break;
      up = up + 1;
      await breathe();
    }
    await easeOff(bot);
    if (up === 0) return fail(action, "FAILED", "pillar failed / 垫高失败（方块没放上去）");
    return succ(action, { levels: up, block: item.name }, "垫高了 " + up + " 格 / climbed " + up + " blocks");
  } catch (err) { return fail(action, "FAILED", "failed / 执行失败: " + errText(err)); }
}

// 常量：本文件动作名 → 实现（供动作桥 / 状态机 / AI 统一按名字调用）。
var HANDLERS = {
  auto_bridge: autoBridge,
  mlg_water: mlgWater,
  dodge_arrow: dodgeArrow,
  eat_golden_apple: eatGoldenApple,
  shield_wall: shieldWall,
  lure_mobs_to_trap: lureMobsToTrap,
  ignite_tnt: igniteTnt,
  pillar_bridge: pillarBridge
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

// 对外导出：8 个高级动作 + 名单 + 查询函数。
module.exports = {
  autoBridge: autoBridge,
  mlgWater: mlgWater,
  dodgeArrow: dodgeArrow,
  eatGoldenApple: eatGoldenApple,
  shieldWall: shieldWall,
  lureMobsToTrap: lureMobsToTrap,
  igniteTnt: igniteTnt,
  pillarBridge: pillarBridge,
  HANDLERS: HANDLERS,
  NAMES: NAMES,
  ACTIONS: NAMES,
  has: has,
  pick: pick,
  MAX_STEPS: MAX_STEPS,
  RETREAT_DISTANCE: RETREAT_DISTANCE
};



