// ========================================
// 文件：modules/state-macros.js
// 功能：状态机宏节点——gather_resource（采集资源）/ farm_area（农场收割）/ safe_guard（守护）/ survive（保命）
// 依赖：./state-util、./actions（可选）、./state-skills（可选）、./state-skills-plus（可选）
// 导出：HANDLERS / NAMES / has / pick
// 作者：MineBots
// ========================================
//
// 说明：宏节点是「多个基础节点串起来的一条流水线」，每个宏都有步数预算（最多次数 + 最长时长），
//       保证它在状态机里不会变成死循环；返回 { ok, message, steps } 由上层照常判定成功 / 失败。
// ES5 风格，CommonJS，无中文变量名
var util = null;
try { util = require("./state-util"); } catch (e) { util = null; }

// 可选依赖：动作执行层（移动 / 挖掘）。
var actions = null;
try { actions = require("./actions"); } catch (e) { actions = null; }

// 可选依赖：基础技能（广播 / 聊天等，宏内部按需借用）。
var skills = null;
try { skills = require("./state-skills"); } catch (e) { skills = null; }

// 可选依赖：感知与生存技能（自动进食 / 逃跑）。
var skillsPlus = null;
try { skillsPlus = require("./state-skills-plus"); } catch (e) { skillsPlus = null; }

// 常量：宏的步数预算与时长上限（防止单个宏卡死状态机）。
var MAX_STEPS = 16;
var MAX_MACRO_MS = 60000;

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

// 判断 bot 是否可用；不可用直接返回双语失败结果。
function requireBot(bot) {
  if (!bot) return { ok: false, message: "bot not ready / 机器人未就绪" };
  try {
    if (!bot.entity) return { ok: false, message: "bot entity missing / 机器人实体未加载" };
  } catch (e) { return { ok: false, message: "bot not ready / 机器人未就绪" }; }
  return { ok: true };
}

// 调一个技能 handler（模块缺失或函数不存在时返回 null，调用方自己兜底）。
async function callSkill(module, name, ctx, args) {
  try {
    if (!module || typeof module.pick !== "function") return null;
    var handler = module.pick(name);
    if (typeof handler !== "function") return null;
    return await handler(ctx, args || {});
  } catch (err) {
    return { ok: false, message: getErrText(err) };
  }
}

// 走一步再挖：先靠近方块坐标，再挖掉；只有真的挖成功才返回 true。
async function digOne(ctx, block) {
  var pos = null;
  try { pos = block && block.position ? block.position : null; } catch (e) { pos = null; }
  if (!pos) return false;
  var px = pos.x, py = pos.y, pz = pos.z;
  try {
    if (actions && typeof actions.moveTo === "function") await actions.moveTo(ctx.bot, px, py, pz, 8000);
    if (!actions || typeof actions.digBlock !== "function") return false;
    var res = await actions.digBlock(ctx.bot, px, py, pz);
    return !(res && res.ok === false);
  } catch (err) {
    return false;
  }
}

// 宏 1：采集资源——反复找指定方块挖掉，凑够 count 个（默认 8，上限 MAX_STEPS）。
async function gatherResource(ctx, args) {
  var ready = requireBot(ctx.bot);
  if (!ready.ok) return ready;
  var name = toText(args.block || args.resource || "log").trim();
  if (name.length === 0) return { ok: false, message: "block 不能为空 / block required" };
  var want = toNum(args.count, 8);
  if (want < 1) want = 1;
  if (want > MAX_STEPS) want = MAX_STEPS;
  var radius = toNum(args.radius, 32);
  var started = Date.now();
  var steps = 0;
  while (steps < want && (Date.now() - started) < MAX_MACRO_MS) {
    var block = util ? util.nearestBlock(ctx.bot, name, radius) : null;
    if (!block) break;
    var doneOne = await digOne(ctx, block);
    if (!doneOne) break;
    steps++;
  }
  try { ctx.vars.gathered = steps; ctx.vars.gatherTarget = name; } catch (e) { /* ignore */ }
  if (steps === 0) return { ok: false, steps: 0, message: "没找到可采集的 " + name + " / nothing gathered" };
  return { ok: true, steps: steps, message: "采集 " + name + " x" + steps + " / gathered " + steps };
}

// 宏 2：农场收割——在半径内收走成熟作物（小麦 / 胡萝卜 / 土豆 / 甜菜根）。
async function farmArea(ctx, args) {
  var ready = requireBot(ctx.bot);
  if (!ready.ok) return ready;
  var radius = toNum(args.radius, 16);
  if (radius < 2) radius = 2;
  if (radius > 48) radius = 48;
  var crops = Array.isArray(args.crops) ? args.crops : ["wheat", "carrots", "potatoes", "beetroots"];
  var started = Date.now();
  var steps = 0;
  while (steps < MAX_STEPS && (Date.now() - started) < MAX_MACRO_MS) {
    var block = util ? util.nearestBlock(ctx.bot, crops, radius) : null;
    if (!block) break;
    var doneOne = await digOne(ctx, block);
    if (!doneOne) break;
    steps++;
  }
  try { ctx.vars.harvested = steps; } catch (e) { /* ignore */ }
  if (steps === 0) return { ok: false, steps: 0, message: "附近没有成熟作物 / no crop nearby" };
  return { ok: true, steps: steps, message: "收割 " + steps + " 个作物 / harvested " + steps };
}

// 宏 3：守护——在 durationMs 内反复扫描附近敌对生物并攻击（步数有上限）。
async function safeGuard(ctx, args) {
  var ready = requireBot(ctx.bot);
  if (!ready.ok) return ready;
  var radius = toNum(args.radius, 12);
  if (radius < 2) radius = 2;
  if (radius > 32) radius = 32;
  var duration = toNum(args.durationMs, 15000);
  if (duration < 1000) duration = 1000;
  if (duration > MAX_MACRO_MS) duration = MAX_MACRO_MS;
  var started = Date.now();
  var strikes = 0;
  var steps = 0;
  while (steps < MAX_STEPS && (Date.now() - started) < duration) {
    var hit = await callSkill(skillsPlus, "scan_entities", ctx, { radius: radius, kind: "mob" });
    var list = (hit && Array.isArray(hit.entities)) ? hit.entities : [];
    if (list.length === 0) break;
    var target = list[0];
    var one = await callSkill(skills, "attack", ctx, { target: target.name || target.kind, times: 1 });
    if (!one || one.ok !== true) break;
    strikes++;
    steps++;
    if (util) await util.sleep(toNum(args.intervalMs, 500));
  }
  try { ctx.vars.guardStrikes = strikes; } catch (e) { /* ignore */ }
  if (strikes === 0) return { ok: false, steps: steps, message: "附近没有敌人 / no threat nearby" };
  return { ok: true, steps: strikes, message: "守护中出手 " + strikes + " 次 / guarded " + strikes };
}

// 宏 4：保命——血少就撤、饿了就吃，循环到时长结束或步数用完。
async function survive(ctx, args) {
  var ready = requireBot(ctx.bot);
  if (!ready.ok) return ready;
  var duration = toNum(args.durationMs, 15000);
  if (duration < 1000) duration = 1000;
  if (duration > MAX_MACRO_MS) duration = MAX_MACRO_MS;
  var lowHealth = toNum(args.lowHealth, 8);
  var lowFood = toNum(args.lowFood, 14);
  var started = Date.now();
  var actionsTaken = 0;
  var steps = 0;
  while (steps < MAX_STEPS && (Date.now() - started) < duration) {
    var health = toNum(ctx.bot ? ctx.bot.health : 20, 20);
    var food = toNum(ctx.bot ? ctx.bot.food : 20, 20);
    if (health <= lowHealth) {
      await callSkill(skillsPlus, "flee", ctx, { distance: toNum(args.fleeDistance, 10) });
      actionsTaken++;
    } else if (food <= lowFood) {
      var ate = await callSkill(skillsPlus, "auto_eat", ctx, {});
      if (!ate || ate.ok !== true) break;
      actionsTaken++;
    } else {
      break;
    }
    steps++;
    if (util) await util.sleep(toNum(args.intervalMs, 500));
  }
  try { ctx.vars.survived = actionsTaken; } catch (e) { /* ignore */ }
  return { ok: actionsTaken > 0, steps: actionsTaken, message: actionsTaken > 0 ? ("保命动作 " + actionsTaken + " 次 / survived steps " + actionsTaken) : "状态良好，无需动作 / nothing needed" };
}

// 常量：宏节点名 → 实现（gather_resource / farm_area / safe_guard / survive）。
var HANDLERS = {
  gather_resource: gatherResource,
  farm_area: farmArea,
  safe_guard: safeGuard,
  survive: survive
};

// 常量：宏节点名单 + 分类表（GUI 与自测共用）。
var NAMES = ["gather_resource", "farm_area", "safe_guard", "survive"];
var CATEGORIES = { macro: NAMES.slice() };

// 判断是否支持某个宏节点。
function has(name) {
  try { return Object.prototype.hasOwnProperty.call(HANDLERS, toText(name)); } catch (e) { return false; }
}

// 取某个宏节点的实现，没有返回 null（调用方必须判空）。
function pick(name) {
  try {
    var key = toText(name);
    return Object.prototype.hasOwnProperty.call(HANDLERS, key) ? HANDLERS[key] : null;
  } catch (e) { return null; }
}

// 对外导出：宏动作表 + 名单 + 分类 + 查询函数。
module.exports = {
  HANDLERS: HANDLERS,
  NAMES: NAMES,
  CATEGORIES: CATEGORIES,
  has: has,
  pick: pick
};


