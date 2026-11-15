// ========================================
// 文件：modules/state-skills.js
// 功能：状态机技能（基础类 + 多 Bot 协同类）——移动 / 挖掘 / 跟随 / 攻击 / 合成 / 广播 / 私聊 / 等待 / 派活
// 依赖：./state-util、./actions（可选）、./swarm（可选）
// 导出：HANDLERS / NAMES / has / pick
// 作者：MineBots
// ========================================
//
// 约定：所有 handler 形如 function (ctx, args)，返回 Promise<{ ok, message }>，绝不抛错；
//       ctx = { bot, botId, vars, counters, board, swarm, machine }，由 state-machine 组装。
// ES5 风格，CommonJS，无中文变量名
var util = null;
try { util = require("./state-util"); } catch (e) { util = null; }

// 可选依赖：动作执行层（移动 / 挖掘 / 放置 / 攻击 / 跟随 / 捡东西 / 停止）。
var actions = null;
try { actions = require("./actions"); } catch (e) { actions = null; }

// 可选依赖：群体协同（广播 / 私聊 / 等待 / 派活）。
var swarm = null;
try { swarm = require("./swarm"); } catch (e) { swarm = null; }

// 可选依赖：日志核心，缺失时所有输出退回 console。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 可选依赖：战斗伦理门面（亲密朋友告状待决时禁止拔剑）；缺失时攻击行为完全不变。
var combatEthics = null;
try { combatEthics = require("./combat-ethics"); } catch (e) { combatEthics = null; }

// 常量：循环类动作的安全上限（防止一个节点把整个进程卡死）/ 默认等待毫秒数。
var MAX_LOOP = 32;
var DEFAULT_WAIT_MS = 1000;

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

// 写文件日志：高频动作只落文件，不推 GUI。
function logInfo(msg) {
  try {
    if (logger && typeof logger.info === "function") { logger.info("[state-skill] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[state-skill] " + msg); } catch (e) { /* ignore */ }
}

// 判断 bot 是否可用；不可用直接返回双语失败结果。
function requireBot(bot) {
  if (!bot) return { ok: false, message: "bot not ready / 机器人未就绪" };
  try {
    if (!bot.entity) return { ok: false, message: "bot entity missing / 机器人实体未加载" };
  } catch (e) { return { ok: false, message: "bot not ready / 机器人未就绪" }; }
  return { ok: true };
}

// 包装一次外部动作调用：非 Promise 值也统一成 Promise，异常一律转成 ok:false。
async function runSafely(label, task) {
  try {
    var res = await task();
    if (res && typeof res === "object" && res.ok === false) {
      logInfo(label + " 失败 / failed: " + toText(res.message));
      return res;
    }
    return (res && typeof res === "object") ? res : { ok: true, value: res };
  } catch (err) {
    logInfo(label + " 异常 / error: " + getErrText(err));
    return { ok: false, message: getErrText(err) };
  }
}

// 走到指定坐标：参数缺 x/y/z 时直接失败（避免原地打转）。
async function moveTo(ctx, args) {
  var ready = requireBot(ctx.bot);
  if (!ready.ok) return ready;
  var x = toNum(args.x, NaN), y = toNum(args.y, NaN), z = toNum(args.z, NaN);
  if (isNaN(x) || isNaN(y) || isNaN(z)) return { ok: false, message: "x/y/z 必须是数字 / x, y, z must be numbers" };
  if (!actions || typeof actions.moveTo !== "function") return { ok: false, message: "actions 不可用 / actions unavailable" };
  var res = await runSafely("move_to", function () { return actions.moveTo(ctx.bot, x, y, z, toNum(args.timeoutMs, 0) || undefined); });
  try { ctx.vars.lastPos = [x, y, z]; } catch (e) { /* 记不住不影响移动 */ }
  return res;
}

// 走到某个玩家身边：玩家名缺失直接失败。
async function moveToPlayer(ctx, args) {
  var ready = requireBot(ctx.bot);
  if (!ready.ok) return ready;
  var player = toText(args.player).trim();
  if (player.length === 0) return { ok: false, message: "player 不能为空 / player required" };
  if (!actions || typeof actions.followPlayer !== "function") return { ok: false, message: "actions 不可用 / actions unavailable" };
  return runSafely("move_to_player", function () { return actions.followPlayer(ctx.bot, player, toNum(args.distance, 2)); });
}

// 挖掉指定坐标的方块。
async function digBlock(ctx, args) {
  var ready = requireBot(ctx.bot);
  if (!ready.ok) return ready;
  var x = toNum(args.x, NaN), y = toNum(args.y, NaN), z = toNum(args.z, NaN);
  if (isNaN(x) || isNaN(y) || isNaN(z)) return { ok: false, message: "x/y/z 必须是数字 / x, y, z must be numbers" };
  if (!actions || typeof actions.digBlock !== "function") return { ok: false, message: "actions 不可用 / actions unavailable" };
  return runSafely("dig_block", function () { return actions.digBlock(ctx.bot, x, y, z); });
}

// 内部：反复找最近的方块并挖掉，返回总共挖到几个（0 表示附近没有）。
async function digRepeatedly(ctx, label, pattern, limit, radius) {
  var dug = 0;
  for (var i = 0; i < limit; i++) {
    var block = util ? util.nearestBlock(ctx.bot, pattern, radius) : null;
    if (!block) break;
    var pos = null;
    try { pos = block.position; } catch (e) { pos = null; }
    if (!pos) break;
    var px = pos.x, py = pos.y, pz = pos.z;
    var near = await runSafely(label, function () {
      if (actions && typeof actions.moveTo === "function") return actions.moveTo(ctx.bot, px, py, pz, 8000);
      return { ok: true };
    });
    // 走不过去也照样试着挖一次：够不到会由 digBlock 自己给出失败原因（不能因为走路失败就假装附近没资源）。
    if (!near.ok) logInfo(label + " 靠近失败，直接尝试挖掘 / move failed, dig anyway");
    var one = await runSafely(label, function () { return actions.digBlock(ctx.bot, px, py, pz); });
    if (!one.ok) break;
    dug++;
  }
  return { ok: dug > 0, count: dug };
}

// 砍树：反复找最近的原木挖掉，最多 blocks 次（默认 10，上限 MAX_LOOP）。
async function digTree(ctx, args) {
  var ready = requireBot(ctx.bot);
  if (!ready.ok) return ready;
  var limit = toNum(args.blocks, 10);
  if (limit < 1) limit = 1;
  if (limit > MAX_LOOP) limit = MAX_LOOP;
  var wood = toText(args.wood).trim();
  var pattern = wood.length > 0 ? [wood] : ["log", "wood"];
  var res = await digRepeatedly(ctx, "dig_tree", pattern, limit, toNum(args.radius, 32));
  try { ctx.vars.woodDug = res.count; } catch (e) { /* ignore */ }
  if (!res.ok) return { ok: false, message: "附近没有可砍的树 / no log found nearby" };
  return { ok: true, count: res.count, message: "砍到 " + res.count + " 个原木 / chopped " + res.count };
}

// 挖矿：按 ores 名字反复找最近的矿石挖掉，最多 blocks 次。
async function mine(ctx, args) {
  var ready = requireBot(ctx.bot);
  if (!ready.ok) return ready;
  var limit = toNum(args.blocks, 10);
  if (limit < 1) limit = 1;
  if (limit > MAX_LOOP) limit = MAX_LOOP;
  var ores = Array.isArray(args.ores) ? args.ores : [];
  var pattern = ores.length > 0 ? ores : ["_ore"];
  var res = await digRepeatedly(ctx, "mine", pattern, limit, toNum(args.radius, 32));
  try { ctx.vars.oreMined = res.count; } catch (e) { /* ignore */ }
  if (!res.ok) return { ok: false, message: "附近没有可挖的矿石 / no ore found nearby" };
  return { ok: true, count: res.count, message: "挖到 " + res.count + " 个矿石 / mined " + res.count };
}

// 跟随玩家（持续动作，直到 stop 或下一个节点抢占）。
async function follow(ctx, args) {
  var ready = requireBot(ctx.bot);
  if (!ready.ok) return ready;
  var player = toText(args.player || args.players).trim();
  if (player.length === 0) return { ok: false, message: "player 不能为空 / player required" };
  if (!actions || typeof actions.followPlayer !== "function") return { ok: false, message: "actions 不可用 / actions unavailable" };
  return runSafely("follow", function () { return actions.followPlayer(ctx.bot, player, toNum(args.distance, 2)); });
}

// 攻击目标实体 times 次（默认 1 次，最多 10 次）。
async function attack(ctx, args) {
  var ready = requireBot(ctx.bot);
  if (!ready.ok) return ready;
  var target = toText(args.target || args.entity).trim();
  if (target.length === 0) return { ok: false, message: "target 不能为空 / target required" };
  // 情感信任 2.0：亲密朋友告状待决时拒绝拔剑，先等主人发话（门面缺失 / 无待决时照常攻击）。
  try {
    if (combatEthics && typeof combatEthics.canAttack === "function") {
      var verdict = combatEthics.canAttack(ctx.botId, target, {});
      if (verdict && verdict.allowed === false) {
        return { ok: false, action: "attack", blocked: true, target: target, message: verdict.message };
      }
    }
  } catch (eEthics) { /* 门面判定失败不阻断既有攻击行为 */ }
  if (!actions || typeof actions.attackEntity !== "function") return { ok: false, message: "actions 不可用 / actions unavailable" };
  var times = toNum(args.times, 1);
  if (times < 1) times = 1;
  if (times > 10) times = 10;
  return runSafely("attack", function () { return actions.attackEntity(ctx.bot, target, times); });
}

// 在坐标处放方块：物品名与坐标缺一不可。
async function placeBlock(ctx, args) {
  var ready = requireBot(ctx.bot);
  if (!ready.ok) return ready;
  var block = toText(args.block || args.item).trim();
  var x = toNum(args.x, NaN), y = toNum(args.y, NaN), z = toNum(args.z, NaN);
  if (block.length === 0) return { ok: false, message: "block 不能为空 / block required" };
  if (isNaN(x) || isNaN(y) || isNaN(z)) return { ok: false, message: "x/y/z 必须是数字 / x, y, z must be numbers" };
  if (!actions || typeof actions.placeBlock !== "function") return { ok: false, message: "actions 不可用 / actions unavailable" };
  return runSafely("place_block", function () { return actions.placeBlock(ctx.bot, block, x, y, z); });
}

// 合成物品：registry 里没有这个物品名或没有配方时返回 ok:false。
async function craft(ctx, args) {
  var ready = requireBot(ctx.bot);
  if (!ready.ok) return ready;
  var name = toText(args.item || args.name).trim();
  if (name.length === 0) return { ok: false, message: "item 不能为空 / item required" };
  var count = toNum(args.count, 1);
  if (count < 1) count = 1;
  if (count > 64) count = 64;
  if (typeof ctx.bot.craft !== "function") return { ok: false, message: "craft 不可用 / craft unavailable" };
  var itemId = null;
  try {
    var def = ctx.bot.registry ? ctx.bot.registry.itemsByName[name] : null;
    itemId = def ? def.id : null;
  } catch (e) { itemId = null; }
  if (itemId === null) return { ok: false, message: "未知物品 / unknown item: " + name };
  var recipes = [];
  try { recipes = ctx.bot.recipesFor(itemId) || []; } catch (e) { recipes = []; }
  if (!Array.isArray(recipes) || recipes.length === 0) return { ok: false, message: "没有可用配方 / no recipe: " + name };
  return runSafely("craft", function () { return ctx.bot.craft(recipes[0], count, null); });
}

// 捡起附近的掉落物。
async function collect(ctx, args) {
  var ready = requireBot(ctx.bot);
  if (!ready.ok) return ready;
  if (!actions || typeof actions.collectNearbyItems !== "function") return { ok: false, message: "actions 不可用 / actions unavailable" };
  return runSafely("collect", function () { return actions.collectNearbyItems(ctx.bot, toNum(args.radius, 8), toNum(args.maxCount, 16)); });
}

// 停止一切动作（移动 / 挖掘 / 跟随 / 寻路）。
async function stop(ctx) {
  var ready = requireBot(ctx.bot);
  if (!ready.ok) return ready;
  if (!actions || typeof actions.stopMoving !== "function") return { ok: false, message: "actions 不可用 / actions unavailable" };
  return runSafely("stop", function () { return actions.stopMoving(ctx.bot); });
}

// 等一会儿（毫秒，默认 1000，超过 30 秒按 30 秒算）。
async function wait(ctx, args) {
  var ms = toNum(args.ms, DEFAULT_WAIT_MS);
  if (ms < 0) ms = 0;
  if (ms > 30000) ms = 30000;
  if (util && typeof util.sleep === "function") await util.sleep(ms);
  return { ok: true, waited: ms, message: "等待 " + ms + " 毫秒 / waited " + ms + "ms" };
}

// 在游戏里说一句话（bot.chat）；失败只记日志。
async function chat(ctx, args) {
  var ready = requireBot(ctx.bot);
  if (!ready.ok) return ready;
  var text = toText(args.message || args.text).trim();
  if (text.length === 0) return { ok: false, message: "message 不能为空 / message required" };
  try {
    if (typeof ctx.bot.chat === "function") ctx.bot.chat(text.slice(0, 200));
    return { ok: true, message: "已说话 / said: " + text.slice(0, 40) };
  } catch (err) {
    return { ok: false, message: getErrText(err) };
  }
}

// 写一个变量到 ctx.vars（值可以是数字 / 字符串 / 对象）。
async function setVar(ctx, args) {
  var name = toText(args.name).trim();
  if (name.length === 0) return { ok: false, message: "name 不能为空 / name required" };
  var value = args.value;
  try { ctx.vars[name] = value; } catch (e) { return { ok: false, message: getErrText(e) }; }
  return { ok: true, name: name, value: value, message: "变量已写入 / var set: " + name };
}

// 广播喊话给所有在线 bot（默认排除自己）。
async function broadcast(ctx, args) {
  var text = toText(args.message || args.text).trim();
  if (text.length === 0) return { ok: false, message: "message 不能为空 / message required" };
  if (!swarm || typeof swarm.broadcast !== "function") return { ok: false, message: "swarm 不可用 / swarm unavailable" };
  var except = args.excludeSelf === false ? "" : ctx.botId;
  var res = swarm.broadcast(text, except);
  return { ok: !!res.ok, sent: res.sent || 0, message: "广播给 " + (res.sent || 0) + " 个 bot / broadcast to " + (res.sent || 0) };
}

// 私聊另一个 bot（写对方黑板信箱 + 对方在线时复述）。
async function whisperBot(ctx, args) {
  var to = toText(args.to || args.bot).trim();
  var text = toText(args.message || args.text).trim();
  if (to.length === 0) return { ok: false, message: "目标 bot 不能为空 / target botId required" };
  if (text.length === 0) return { ok: false, message: "message 不能为空 / message required" };
  if (!swarm || typeof swarm.whisper !== "function") return { ok: false, message: "swarm 不可用 / swarm unavailable" };
  var res = swarm.whisper(ctx.botId, to, text);
  return { ok: !!res.ok, to: to, message: "已私聊 " + to + " / whispered " + to };
}

// 等待另一个 bot 满足条件（默认 10 秒，最长 60 秒）。
async function waitForBot(ctx, args) {
  var to = toText(args.bot || args.to).trim();
  if (to.length === 0) return { ok: false, message: "目标 bot 不能为空 / target botId required" };
  if (!swarm || typeof swarm.waitFor !== "function") return { ok: false, message: "swarm 不可用 / swarm unavailable" };
  var expect = { field: toText(args.field || "online"), op: toText(args.op || "eq"), value: args.value };
  var res = await swarm.waitFor(to, expect, toNum(args.timeoutMs, 10000));
  return { ok: !!res.ok, waited: res.waited || 0, message: res.ok ? ("等到 " + to + " 达成条件 / condition met") : ("等待超时 / timeout: " + to) };
}

// 给另一个 bot 派活（写黑板 task:<id>）。
async function assignTask(ctx, args) {
  var to = toText(args.bot || args.to).trim();
  if (to.length === 0) return { ok: false, message: "目标 bot 不能为空 / target botId required" };
  if (!swarm || typeof swarm.assign !== "function") return { ok: false, message: "swarm 不可用 / swarm unavailable" };
  var res = swarm.assign(to, toText(args.task), toText(args.machine));
  return { ok: !!res.ok, to: to, message: "已派活给 " + to + " / task assigned" };
}

// 常量：本文件负责的动作名 → 实现（基础类 + 多 Bot 协同类）。
var HANDLERS = {
  move_to: moveTo,
  move_to_player: moveToPlayer,
  dig_block: digBlock,
  dig_tree: digTree,
  mine: mine,
  follow: follow,
  attack: attack,
  place_block: placeBlock,
  craft: craft,
  collect: collect,
  stop: stop,
  wait: wait,
  chat: chat,
  set_var: setVar,
  broadcast: broadcast,
  whisper_bot: whisperBot,
  wait_for_bot: waitForBot,
  assign_task: assignTask
};

// 常量：本文件支持的动作名列表（顺序即文档顺序）。
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

// 对外导出：动作表 + 名单 + 查询函数。
module.exports = {
  HANDLERS: HANDLERS,
  NAMES: NAMES,
  has: has,
  pick: pick
};
