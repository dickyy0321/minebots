// ========================================
// 文件：modules/actions.js
// 功能：基础动作封装——移动 / 挖掘 / 放置 / 攻击 / 跟随 / 拾取 / 停止 / 红石触发，全部可安全失败；
//       engExactBuild 开启时放置与触发前先 bot.lookAt 精确对准目标方块中心
// 依赖：./pathfinding、vec3、mineflayer-pathfinder、./logger、./anti-stuck、./exact-placement（都可选）
// 导出：moveTo / digBlock / placeBlock / attackEntity / followPlayer / collectNearbyItems / stopMoving / activateBlock
// 作者：MineBots
// ========================================

// 可选依赖：寻路模块；缺失时 moveTo 直接回失败体，不影响其它动作。
var pathfinding = null;
try { pathfinding = require("./pathfinding"); } catch (err) { pathfinding = null; }
// 可选依赖：vec3，用来构造 blockAt / placeBlock 需要的坐标对象；缺失时降级为普通对象。
var vecLib = null;
try { vecLib = require("vec3"); } catch (err) { vecLib = null; }
// 可选依赖：官方寻路插件，只用于 GoalFollow 跟随；未安装时走「朝目标走」的退化实现。
var pfLib = null;
try { pfLib = require("mineflayer-pathfinder"); } catch (err) { pfLib = null; }
// 可选依赖：日志模块；缺失时所有日志静默丢弃，绝不抛错。
var logger = null;
try { logger = require("./logger"); } catch (err) { logger = null; }
// 可选依赖：拟真动作层（分步缓转 + 挖掘手部晃动）；缺失时退回瞬间转向，动作照做。
var motion = null;
try { motion = require("./motion"); } catch (err) { motion = null; }
// 可选依赖：防卡死自救（3 秒不动就跳 / 挖 / 放弃），缺失时只是不自救。
var antiStuck = null;
try { antiStuck = require("./anti-stuck"); } catch (err) { antiStuck = null; }
// 可选依赖：精确建筑门面（中心坐标对准 + 触发）；缺失时放置 / 触发完全沿用老链路。
var exactPlacement = null;
try { exactPlacement = require("./exact-placement"); } catch (err) { exactPlacement = null; }

// 常量：单次动作默认超时，与 task-queue 的 10 秒任务上限保持一致。
var DEFAULT_TIMEOUT_MS = 10000;
// 常量：挖掘 / 放置 / 攻击的硬超时——bot.dig 这类 Promise 在方块挖不动时会永远不 resolve，
// 没有超时就会把整条串行队列（以及后面的 stop）一起拖死；自测可用 MINEBOTS_DIG_TIMEOUT_MS 调小。
var DIG_TIMEOUT_MS = 9000;
var PLACE_TIMEOUT_MS = 6000;
var ATTACK_TIMEOUT_MS = 5000;
try {
  var envDig = Number(process.env.MINEBOTS_DIG_TIMEOUT_MS);
  if (!isNaN(envDig) && envDig > 0) DIG_TIMEOUT_MS = envDig;
} catch (eEnv) { /* 读不到环境变量就用默认值 */ }
// 常量：跟随节拍 / 退化跟随最长持续时间 / 跟随保持距离（默认 2 格）/ 距离上限。
var FOLLOW_TICK_MS = 1000;
var FOLLOW_MAX_MS = 30000;
var FOLLOW_DISTANCE = 2, FOLLOW_DIST_MAX = 8;
// 常量：插件跟随连续几拍没进展就重新挂一次目标（2 拍 ≈ 2 秒）。
var FOLLOW_REARM_TICKS = 2;
// 常量：拾取默认半径与单次最多拾取的掉落物数量。
var COLLECT_RADIUS = 8, COLLECT_MAX = 5;

// 写普通信息日志：只落文件不推 GUI（动作级日志量大，避免刷屏）。
function logInfo(message) {
  try {
    if (logger && typeof logger.info === "function") logger.info(message);
  } catch (err) { /* ignore */ }
}

// 写警告日志：动作失败属重要信息，推 GUI 让用户看得见；无 logger 时退回 console。
function logWarn(message) {
  try {
    if (logger && typeof logger.warn === "function") logger.warn(message);
    else console.warn(message);
  } catch (err) { /* ignore */ }
}

// 把异常对象拍成一行文本，避免 undefined 或 [object Object] 写进日志。
function errText(err) {
  try {
    if (!err) return "unknown error / 未知错误";
    if (typeof err === "string") return err;
    if (err.message) return String(err.message);
    return String(err);
  } catch (e) { return "unknown error / 未知错误"; }
}

// 统一的「机器人未就绪」返回体：bot 为空时所有动作都回这个，前端按 code 提示。
function notReady(action) {
  var msg = "bot not ready / 机器人未就绪";
  logWarn("[actions] " + action + " -> " + msg);
  return { ok: false, action: action, code: "BOT_NOT_READY", message: msg };
}

// 统一的「参数非法」返回体，message 必须自带中英双语。
function badParam(action, message) {
  logWarn("[actions] " + action + " -> " + message);
  return { ok: false, action: action, code: "BAD_PARAM", message: message };
}

// 统一的「执行失败」返回体，err 既可以是 Error 也可以是字符串。
function failure(action, err) {
  var msg = "failed / 执行失败: " + errText(err);
  logWarn("[actions] " + action + " -> " + msg);
  return { ok: false, action: action, code: "FAILED", message: msg };
}

// 带硬超时的收敛器：promise 超过 ms 还没结束就判超时并 resolve 失败体（定时器 unref，绝不拖进程）。
// 为什么必须有：bot.dig / bot.placeBlock 在卡住时会永远不 resolve，串行队列会被它一个人锁死。
function withTimeout(promise, ms, action, fields) {
  return new Promise(function (resolve) {
    var done = false;
    var timer = null;
    var close = function (result) {
      if (done) return;
      done = true;
      try { if (timer) clearTimeout(timer); } catch (e1) { /* ignore */ }
      resolve(result);
    };
    var okBody = function () {
      var out = { ok: true, action: action };
      try {
        for (var k in fields) {
          if (Object.prototype.hasOwnProperty.call(fields, k)) out[k] = fields[k];
        }
      } catch (err) { /* 附加字段失败不影响成功结果 */ }
      close(out);
    };
    try {
      var every = Number(ms);
      if (!isNaN(every) && every > 0) {
        timer = setTimeout(function () {
          close({
            ok: false, action: action, code: "TIMEOUT",
            message: "timeout / 动作超时（已强制收手，避免卡死后续指令）"
          });
        }, every);
        if (timer && timer.unref) timer.unref();
      }
    } catch (e2) { timer = null; }
    try {
      Promise.resolve(promise).then(okBody, function (err) { close(failure(action, err)); });
    } catch (err3) { close(failure(action, err3)); }
  });
}

// 读取实体坐标并拍平成 { x, y, z }；实体或坐标缺失时返回 null。
function posOf(entity) {
  try {
    var p = entity && entity.position ? entity.position : null;
    if (!p) return null;
    var x = Number(p.x);
    var y = Number(p.y);
    var z = Number(p.z);
    if (isNaN(x) || isNaN(y) || isNaN(z)) return null;
    return { x: x, y: y, z: z };
  } catch (err) { return null; }
}

// 校验三个坐标是否都是合法数字。
function isNum3(x, y, z) {
  var a = Number(x), b = Number(y), c = Number(z);
  if (isNaN(a) || isNaN(b) || isNaN(c)) return false;
  return true;
}

// 判断实体是不是机器人自己：对象同一性 + entityId 双保险（跟自己的脚走 = 原地不动 + 低头盯地面）。
function isSelfEntity(bot, entity) {
  try {
    if (!bot || !bot.entity || !entity) return false;
    var a = entity.id, b = bot.entity.id, has = a !== undefined && a !== null && b !== undefined && b !== null;
    return entity === bot.entity || (has && String(a) === String(b));
  } catch (err) { return false; }
}

// 水平距离平方：跟随只看平面距离（玩家站坡上也还算「在附近」）；坐标读不出来时返回 -1。
function horizontalSq(a, b) {
  try {
    var dx = Number(a.x) - Number(b.x), dz = Number(a.z) - Number(b.z);
    if (isNaN(dx) || isNaN(dz)) return -1;
    return dx * dx + dz * dz;
  } catch (err) { return -1; }
}

// 取实体「头」的坐标：玩家身高 1.8 → 约 +1.62；取不到身高按 1.6 算，绝不用脚底坐标（那就是低头看地面）。
function headPoint(bot, entity) {
  try {
    var p = posOf(entity);
    if (!p) return null;
    var h = Number(entity && entity.height);
    if (isNaN(h) || h <= 0.5) h = 1.8;
    return makeVec(bot, p.x, p.y + Math.min(1.8, Math.max(1.2, h * 0.9)), p.z);
  } catch (err) { return null; }
}

// 官方 GoalFollow 是否可用：插件模块 / bot.pathfinder / goals.GoalFollow 三者齐全才算。
function couldPathfind(bot) {
  try {
    if (!bot || !bot.pathfinder || typeof bot.pathfinder.setGoal !== "function") return false;
    return !!(pfLib && pfLib.goals && typeof pfLib.goals.GoalFollow === "function");
  } catch (err) { return false; }
}

// 构造坐标对象：优先 vec3 库，其次用 bot 现有坐标实例派生，最后退化成普通对象。
function makeVec(bot, x, y, z) {
  try {
    var vx = Number(x);
    var vy = Number(y);
    var vz = Number(z);
    if (isNaN(vx) || isNaN(vy) || isNaN(vz)) return null;
    if (vecLib && typeof vecLib.Vec3 === "function") return new vecLib.Vec3(vx, vy, vz);
    var base = posOf(bot && bot.entity ? bot.entity : null);
    if (base && bot && bot.entity && bot.entity.position &&
        typeof bot.entity.position.offset === "function") {
      return bot.entity.position.offset(vx - base.x, vy - base.y, vz - base.z);
    }
    return { x: vx, y: vy, z: vz };
  } catch (err) { return null; }
}

// 取指定坐标的方块；世界未加载、坐标越界或 API 缺失时返回 null。
function findBlock(bot, x, y, z) {
  try {
    if (!bot || typeof bot.blockAt !== "function") return null;
    var vec = makeVec(bot, Math.floor(Number(x)), Math.floor(Number(y)), Math.floor(Number(z)));
    if (!vec) return null;
    return bot.blockAt(vec) || null;
  } catch (err) { return null; }
}
// 取实体：target 是数字按 entityId 找，是字符串按 username / name / displayName 找，命中多个取最近。
function findEntity(bot, target) {
  try {
    if (!bot || !bot.entities) return null;
    var want = "";
    var wantId = -1;
    if (typeof target === "number") wantId = target;
    else if (target !== undefined && target !== null) want = String(target);
    var me = posOf(bot.entity);
    var best = null;
    var bestDist = -1;
    for (var key in bot.entities) {
      if (!Object.prototype.hasOwnProperty.call(bot.entities, key)) continue;
      var ent = bot.entities[key];
      if (!ent) continue;
      if (isSelfEntity(bot, ent)) continue; // 自己不算候选：否则「跟随」会盯住自己的脚（原地不动 + 低头）
      var hit = false;
      if (wantId >= 0) hit = Number(ent.id) === wantId;
      else if (want) hit = !!((ent.username && String(ent.username) === want) ||
        (ent.name && String(ent.name) === want) || (ent.displayName && String(ent.displayName) === want));
      if (!hit) continue;
      var p = posOf(ent);
      var d = -1;
      if (p && me) {
        var dx = p.x - me.x;
        var dy = p.y - me.y;
        var dz = p.z - me.z;
        d = dx * dx + dy * dy + dz * dz;
      }
      if (!best || (d >= 0 && (bestDist < 0 || d < bestDist))) {
        best = ent;
        bestDist = d;
      }
    }
    return best;
  } catch (err) { return null; }
}

// 列出半径内的掉落物实体，按由近到远排序；世界或坐标缺失时返回空数组。
function listItemEntities(bot, radius) {
  var out = [];
  try {
    if (!bot || !bot.entities) return out;
    var me = posOf(bot.entity);
    if (!me) return out;
    var limit = Number(radius);
    if (isNaN(limit) || limit <= 0) limit = COLLECT_RADIUS;
    var limitSq = limit * limit;
    for (var key in bot.entities) {
      if (!Object.prototype.hasOwnProperty.call(bot.entities, key)) continue;
      var ent = bot.entities[key];
      if (!ent) continue;
      var isItem = false;
      if (ent.name === "item") isItem = true;
      else if (ent.displayName === "Item") isItem = true;
      else if (ent.objectType === "Item") isItem = true;
      if (!isItem) continue;
      var p = posOf(ent);
      if (!p) continue;
      var dx = p.x - me.x;
      var dy = p.y - me.y;
      var dz = p.z - me.z;
      var d = dx * dx + dy * dy + dz * dz;
      if (d > limitSq) continue;
      out.push({ entity: ent, dist: d });
    }
    out.sort(function (a, b) { return a.dist - b.dist; });
    var list = [];
    for (var i = 0; i < out.length; i++) list.push(out[i].entity);
    return list;
  } catch (err) { return []; }
}

// 在背包里按名字找物品，找不到或背包不可读时返回 null。
function findItem(bot, name) {
  try {
    if (!bot || !bot.inventory || typeof bot.inventory.items !== "function") return null;
    var items = bot.inventory.items() || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i] && String(items[i].name) === name) return items[i];
    }
  } catch (err) { return null; }
  return null;
}

// 挑一个可依附的方块做放置参考：优先目标下方，其次脚下，最后目标左右两侧。
function pickReferenceBlock(bot, target) {
  try {
    if (!bot) return null;
    var candidates = [];
    var pos = posOf(bot.entity);
    if (pos) candidates.push({ x: pos.x, y: pos.y - 1, z: pos.z, ox: 0, oy: 1, oz: 0 });
    if (target) {
      candidates.push({ x: target.x, y: target.y - 1, z: target.z, ox: 0, oy: 1, oz: 0 });
      candidates.push({ x: target.x - 1, y: target.y, z: target.z, ox: 1, oy: 0, oz: 0 });
      candidates.push({ x: target.x + 1, y: target.y, z: target.z, ox: -1, oy: 0, oz: 0 });
    }
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      var block = findBlock(bot, c.x, c.y, c.z);
      if (!block) continue;
      var name = block.name ? String(block.name) : "";
      if (name.indexOf("air") === 0 || name.indexOf("water") === 0 || name.indexOf("lava") === 0) continue;
      return { block: block, offset: makeVec(bot, c.ox, c.oy, c.oz) };
    }
  } catch (err) { return null; }
  return null;
}
// 可选依赖：视线心跳（每 500ms 对准一次目标）；缺失时只是「不再自动转头」，动作照做。
var gazeMod = null;
try { gazeMod = require("./action-gaze"); } catch (e) { gazeMod = null; }
// 可选依赖：跟随实现；缺失时 followPlayer 直接回失败体（别的动作不受影响）。
var followMod = null;
try { followMod = require("./action-follow"); } catch (e) { followMod = null; }

// 启动视线心跳：转给 action-gaze；模块缺失时安静返回 null。
function startGaze(bot, pick, ms) {
  try { if (gazeMod && typeof gazeMod.startGaze === "function") return gazeMod.startGaze(bot, pick, ms); } catch (err) { /* ignore */ }
  return null;
}

// 清掉视线定时器：转给 action-gaze；模块缺失时返回 false。
function stopGaze(bot, want) {
  try { if (gazeMod && typeof gazeMod.stopGaze === "function") return gazeMod.stopGaze(bot, want); } catch (err) { /* ignore */ }
  return false;
}

// 走向指定坐标：交给 ./pathfinding 的 goTo；模块缺失或机器人根本动不了时直接回失败体。
function moveTo(bot, x, y, z, timeout) {
  var action = "moveTo";
  try {
    if (!bot) return notReady(action);
    if (!isNum3(x, y, z)) return badParam(action, "bad target / 目标坐标非法");
    if (!pathfinding || typeof pathfinding.goTo !== "function") {
      return badParam(action, "pathfinding unavailable / 寻路模块不可用");
    }
    var canMove = false;
    if (bot.pathfinder) canMove = true;
    else if (typeof bot.setControlState === "function") canMove = true;
    if (!canMove) return badParam(action, "bot cannot move / 机器人不可移动");
    var ms = Number(timeout);
    if (isNaN(ms) || ms <= 0) ms = DEFAULT_TIMEOUT_MS;
    try { if (typeof pathfinding.setup === "function") pathfinding.setup(bot); } catch (e1) { /* ignore */ }
    // 边走边看：每 500ms 对准目标「头顶上一格」抬一次头，走起来才不像木头人（绝不给地平线以下的点）。
    var gaze = startGaze(bot, function () { return makeVec(bot, Number(x), Number(y) + 1, Number(z)); });
    var walking = pathfinding.goTo(bot, Number(x), Number(y), Number(z), ms);
    // 防卡死：3 秒不动就自救（跳 → 挖），满 3 次放弃并通知 AI；寻路一结束自动摘表。
    var guard = antiStuck && typeof antiStuck.attach === "function" ? antiStuck.attach(bot, { x: Number(x), y: Number(y), z: Number(z) }, walking) : null;
    // 寻路一结束（到达 / 超时 / 失败）就停表；只清自己那一个，别把新动作的视线也停了。
    var cleanup = function () { stopGaze(bot, gaze); if (guard && typeof guard.stop === "function") guard.stop(); return null; };
    try { Promise.resolve(walking).then(cleanup, cleanup); } catch (e2) { stopGaze(bot, gaze); }
    return walking;
  } catch (err) { return failure(action, err); }
}

// 挖掉指定坐标的方块：返回永不 reject 的 Promise，失败体里带 message。
function digBlock(bot, x, y, z) {
  var action = "digBlock";
  try {
    if (!bot) return notReady(action);
    if (!isNum3(x, y, z)) return badParam(action, "bad target / 目标坐标非法");
    if (typeof bot.dig !== "function") return badParam(action, "dig not supported / 当前机器人不支持挖掘");
    var block = findBlock(bot, x, y, z);
    if (!block) return badParam(action, "block not found / 目标方块不存在");
    var bname = block.name ? String(block.name) : "";
    if (bname.indexOf("air") === 0) return badParam(action, "block is air / 目标是空气");
    logInfo("[actions] dig " + bname + " at " + Math.floor(Number(x)) + "," +
      Math.floor(Number(y)) + "," + Math.floor(Number(z)) + " / 开始挖掘");
    var fields = { block: bname, x: Math.floor(Number(x)), y: Math.floor(Number(y)), z: Math.floor(Number(z)) };
    // 挖掘时手会动：视线每 180ms 做一次 ±0.18 格小抖动，挖完立刻收手（定时器 unref，绝不拖进程）。
    // 关键：digging 必须带超时——bot.dig 卡住时它永远不 resolve，抖动定时器会一直活到进程结束。
    var jitter = motion && typeof motion.startDigJitter === "function" ? motion.startDigJitter(bot) : null;
    var digging = withTimeout(bot.dig(block), DIG_TIMEOUT_MS, action, fields);
    if (!jitter) return digging;
    return motion.whenDone(digging, function () { jitter.stop(); });
  } catch (err) { return failure(action, err); }
}

// 在指定坐标放一个方块：先装备手持物品，再朝参考方块放置；缺物品 / 参考方块时回失败体。
function placeBlock(bot, itemName, x, y, z) {
  var action = "placeBlock";
  try {
    if (!bot) return notReady(action);
    if (!isNum3(x, y, z)) return badParam(action, "bad target / 目标坐标非法");
    var name = itemName ? String(itemName) : "";
    if (!name) return badParam(action, "itemName required / 缺少物品名");
    if (typeof bot.placeBlock !== "function") return badParam(action, "place not supported / 当前机器人不支持放置");
    var item = findItem(bot, name);
    if (!item) return badParam(action, "item not in inventory / 背包里没有该物品");
    var tx = Math.floor(Number(x));
    var ty = Math.floor(Number(y));
    var tz = Math.floor(Number(z));
    var target = makeVec(bot, tx, ty, tz);
    if (!target) return badParam(action, "vec unavailable / 无法构造坐标");
    var ref = pickReferenceBlock(bot, { x: tx, y: ty, z: tz });
    if (!ref || !ref.offset) return badParam(action, "no reference block / 找不到可依附的方块");
    var chain = Promise.resolve();
    // 精确建筑：装备 / 放置前先对准目标方块中心，普通模式这一步直接放行且不产生任何网络调用。
    if (exactPlacement && typeof exactPlacement.placeAim === "function") {
      chain = chain.then(function () { return exactPlacement.placeAim(bot, tx, ty, tz); });
    }
    if (typeof bot.equip === "function") {
      chain = chain.then(function () { return bot.equip(item, "hand"); });
    }
    chain = chain.then(function () { return bot.placeBlock(ref.block, ref.offset); });
    logInfo("[actions] place " + name + " at " + tx + "," + ty + "," + tz + " / 开始放置");
    return withTimeout(chain, PLACE_TIMEOUT_MS, action, { item: name, x: tx, y: ty, z: tz });
  } catch (err) { return failure(action, err); }
}
// 攻击实体：target 可以是 entityId 或名字，times 默认 1（上限 10，避免误伤刷屏）。
// 出手前先分步缓转对准目标（5 步 × 50ms），多段攻击之间留 150ms 节奏——不再「瞬间转头 + 瞬间连打」。
async function attackEntity(bot, target, times) {
  var action = "attackEntity";
  try {
    if (!bot) return notReady(action);
    if (typeof bot.attack !== "function") return badParam(action, "attack not supported / 当前机器人不支持攻击");
    var entity = findEntity(bot, target);
    if (!entity) return badParam(action, "entity not found / 未找到目标实体");
    var n = Number(times);
    if (isNaN(n) || n < 1) n = 1;
    n = Math.floor(n);
    if (n > 10) n = 10;
    // 打之前先缓缓转向目标（头，不是脚底）：看不见目标就抬手，看着像木头人在挥空气。
    var aim = headPoint(bot, entity) || posOf(entity);
    if (aim && motion && typeof motion.smoothLookAt === "function") await motion.smoothLookAt(bot, aim, 5);
    var hits = 0;
    for (var i = 0; i < n; i++) {
      if (i > 0 && motion && typeof motion.wait === "function") await motion.wait(150);
      try { bot.attack(entity); hits = hits + 1; } catch (e1) { break; }
    }
    if (hits === 0) return failure(action, "attack call failed / 攻击调用失败");
    var who = entity.username ? String(entity.username) : (entity.name ? String(entity.name) : String(entity.id));
    return { ok: true, action: action, entity: who, hits: hits };
  } catch (err) { return failure(action, err); }
}

// 清掉跟随定时器并松开前进键：跟随结束 / 停止移动 / 重新跟随时都要调用；传 want 只清自己那一支。
function stopFollowTimer(bot, want) {
  try {
    if (!bot) return;
    var state = bot._mbFollow || null;
    if (want && state !== want) {
      // 已经被新的跟随 / 新动作接管：只关自己那支定时器，绝不误杀别人的视线与状态。
      try { if (want.timer) clearInterval(want.timer); } catch (e0) { /* ignore */ }
      return;
    }
    if (state && state.timer) {
      try { clearInterval(state.timer); } catch (e1) { /* ignore */ }
    }
    bot._mbFollow = null; stopGaze(bot); // 顺手停掉视线心跳，别一直盯着玩家消失的位置
    // 只有真的在跟随时才需要松开前进键：没跟随过就别多发一次控制指令（stop 只清状态）。
    if (state && typeof bot.setControlState === "function") {
      try { bot.setControlState("forward", false); } catch (e2) { /* ignore */ }
    }
  } catch (err) { /* ignore */ }
}

// 跟随心跳 / 跟随实现的公共依赖包：显式注入，action-follow 不需要反查 actions 内部。
function followCtx() {
  return {
    logInfo: logInfo, notReady: notReady, badParam: badParam, failure: failure,
    findEntity: findEntity, posOf: posOf, isSelfEntity: isSelfEntity, headPoint: headPoint,
    horizontalSq: horizontalSq, couldPathfind: couldPathfind, startGaze: startGaze,
    stopFollowTimer: stopFollowTimer, pathfinding: pathfinding, pfLib: pfLib,
    FOLLOW_TICK_MS: FOLLOW_TICK_MS, FOLLOW_MAX_MS: FOLLOW_MAX_MS,
    FOLLOW_DISTANCE: FOLLOW_DISTANCE, FOLLOW_DIST_MAX: FOLLOW_DIST_MAX,
    FOLLOW_REARM_TICKS: FOLLOW_REARM_TICKS
  };
}

// 跟随玩家：交给 action-follow（插件用 GoalFollow，没插件退化朝人走）；模块缺失时回失败体。
function followPlayer(bot, username, distance) {
  try {
    if (!followMod || typeof followMod.followPlayer !== "function") {
      return badParam("followPlayer", "follow module unavailable / 跟随模块不可用");
    }
    return followMod.followPlayer(bot, username, distance, followCtx());
  } catch (err) { return failure("followPlayer", err); }
}
// 拾取附近的掉落物：按由近到远依次走过去，返回走到几个；永不 reject。
function collectNearbyItems(bot, radius, maxCount) {
  var action = "collectNearbyItems";
  try {
    if (!bot) return notReady(action);
    var r = Number(radius);
    if (isNaN(r) || r <= 0) r = COLLECT_RADIUS;
    var cap = Number(maxCount);
    if (isNaN(cap) || cap <= 0) cap = COLLECT_MAX;
    var items = listItemEntities(bot, r).slice(0, Math.floor(cap));
    if (items.length === 0) {
      return { ok: true, action: action, found: 0, collected: 0, message: "no item nearby / 附近没有掉落物" };
    }
    if (!pathfinding || typeof pathfinding.goTo !== "function") {
      return badParam(action, "pathfinding unavailable / 寻路模块不可用");
    }
    var chain = Promise.resolve();
    var collected = 0;
    // 停止令牌：拾取是一串 goTo，用户中途喊停时后面的目标必须全部作废，绝不能自己又走起来。
    var token = pathfinding && typeof pathfinding.stopToken === "function" ? pathfinding.stopToken(bot) : 0;
    for (var i = 0; i < items.length; i++) {
      (function (ent) {
        chain = chain.then(function () {
          var now = pathfinding && typeof pathfinding.stopToken === "function" ? pathfinding.stopToken(bot) : token;
          if (now !== token) return null; // 期间被执行过 stop：整个拾取链立刻收工
          var p = posOf(ent);
          if (!p) return null;
          return pathfinding.goTo(bot, p.x, p.y, p.z, 8000).then(function (res) {
            if (res && res.ok) collected = collected + 1;
            return res;
          }, function () { return null; });
        });
      }(items[i]));
    }
    return chain.then(function () {
      return { ok: true, action: action, found: items.length, collected: collected };
    }, function (err) {
      return failure(action, err);
    });
  } catch (err) { return failure(action, err); }
}

// 停止一切移动：清跟随定时器、停 pathfinder、松开所有控制键。
function stopMoving(bot) {
  var action = "stopMoving";
  try {
    if (!bot) return notReady(action);
    stopFollowTimer(bot);
    stopGaze(bot); if (antiStuck && typeof antiStuck.stop === "function") antiStuck.stop(bot);
    // 正在缓转的视角也立刻收手：停止之后不该还自己转头。
    if (motion && typeof motion.cancelLook === "function") motion.cancelLook(bot);
    // 交给 pathfinding.stop：它会打断在跑的 goTo（轮询 / 超时定时器一并收掉）再清目标。
    // 模块缺失时才退回「自己动手停插件」，保证无论如何都停得下来。
    var stoppedByPath = false;
    if (pathfinding && typeof pathfinding.stop === "function") {
      try {
        var pRes = pathfinding.stop(bot);
        stoppedByPath = !!(pRes && pRes.ok !== false);
      } catch (e0) { stoppedByPath = false; }
    }
    if (!stoppedByPath) {
      try {
        if (bot.pathfinder && typeof bot.pathfinder.stop === "function") bot.pathfinder.stop();
      } catch (e1) { /* ignore */ }
      try {
        if (bot.pathfinder && typeof bot.pathfinder.setGoal === "function") bot.pathfinder.setGoal(null);
      } catch (e2) { /* ignore */ }
    }
    try {
      if (typeof bot.clearControlStates === "function") bot.clearControlStates();
    } catch (e3) { /* ignore */ }
    return { ok: true, action: action, message: "stopped / 已停止" };
  } catch (err) { return failure(action, err); }
}

// 触发指定坐标的红石元件：精确模式下先对准中心，再预检方块状态并调 bot.activateBlock；失败只回 ok:false。
function activateBlock(bot, x, y, z, options) {
  if (!bot) return notReady("activateBlock");
  if (!isNum3(x, y, z)) return badParam("activateBlock", "bad target / 目标坐标非法");
  if (!exactPlacement || typeof exactPlacement.activateBlock !== "function") {
    return badParam("activateBlock", "exact-placement unavailable / 精确触发模块不可用");
  }
  try { return withTimeout(exactPlacement.activateBlock(bot, { x: x, y: y, z: z }, options),
    PLACE_TIMEOUT_MS, "activateBlock", { x: x, y: y, z: z }); }
  catch (err) { return failure("activateBlock", err); }
}

// 对外导出：8 个基础动作，全部可安全失败。
module.exports = {
  moveTo: moveTo,
  digBlock: digBlock,
  placeBlock: placeBlock,
  attackEntity: attackEntity,
  followPlayer: followPlayer,
  collectNearbyItems: collectNearbyItems,
  stopMoving: stopMoving,
  activateBlock: activateBlock
};
