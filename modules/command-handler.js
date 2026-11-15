// ========================================
// 文件：modules/command-handler.js
// 功能：指令执行器——把解析后的动作真正作用到 mineflayer bot 上（越野车：不认识就跳过）；swarm_ 前缀转状态机 3.0
// 依赖：./action-bridge → ./actions、./logger、./swarm-command（可选，缺失时原有动作完全不受影响）；bot 上的 mineflayer 接口（每次调用都 try/catch）
// 导出：attach、executeAction、runQueue
// 作者：MineBots
// ========================================
//
// 动作清单 / actions
//   stop / move / dig_block / dig_tree / mine / attack_all / attack / follow / collect / place / craft
// P1 接线：stop/move/dig_block/dig_tree/mine/attack_all/attack/follow/collect/place 优先交给 ./actions
//   （经 ./action-bridge 规整结果）；dig_tree、mine 仍由本文件扫描目标，再逐个交给 actions.digBlock。
// 失败一律返回 { ok:false, action, error }，只写日志，绝不抛出。
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers
// 可选依赖：日志核心；缺失时退回 console。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
// 可选依赖：基础动作接线层（内部再 require ./actions）；缺失时所有动作退回本文件的老实现。
var bridge = null;
try { bridge = require("./action-bridge"); } catch (e) { bridge = null; }
// 可选依赖：方块扫描（找最近的木头 / 矿石）；缺失时挖矿类动作直接回「没找到方块」。
var scanMod = null;
try { scanMod = require("./bot-scan"); } catch (e) { scanMod = null; }
var swarmCmd = null; try { swarmCmd = require("./swarm-command"); } catch (e) { swarmCmd = null; } // 可选依赖：状态机 3.0 蜂群命令。
var actionToken = 0; // 状态：动作代号——每来一个新动作就 +1，老循环（挖木头）看到代号变了立刻收工。
var DEFAULT_RANGE = 32; // 常量：默认搜索半径（格）。
var SCAN_RADIUS_LIMIT = 8; // 常量：兜底扫描的半径上限（防三重大循环卡死主线程）。
var UNKNOWN_ACTION = "unknown-action"; // 常量：不认识的指令错误码。
var WOOD_NAME_RE = /(_log|_wood|_stem|_hyphae|^log)/i; // 常量：木头 / 矿石的宽松判定（越野车：模组方块认不出就直接跳过）。
var ORE_NAME_RE = /(_ore|_debris)/i;
var HOSTILE_TYPES = ["mob", "hostile"]; // 常量：mineflayer 不同版本对怪物的类型命名不同，能认的都认。
var CONTROL_DIRECTIONS = ["forward", "back", "left", "right", "jump", "sprint", "sneak"]; // 常量：清理控制状态时要关掉的方向。
function logWarn(message) { // 写告警日志：优先 logger.warn，失败退回 console，绝不抛错。
  try { if (logger && typeof logger.warn === "function") logger.warn(message); else console.warn(message); } catch (e) { /* 日志失败不影响执行 */ }
}
function logLan(message) { // 写 LAN 日志：优先 logger.lan，依次退回 system、console。
  try { if (logger && typeof logger.lan === "function") logger.lan(message); else if (logger && typeof logger.system === "function") logger.system(message); else console.log(message); } catch (e) { /* 日志失败不影响执行 */ }
}
function logSystem(message) { // 写系统日志：优先 logger.system，退回 console。
  try { if (logger && typeof logger.system === "function") logger.system(message); else console.log(message); } catch (e) { /* 日志失败不影响执行 */ }
}
function getErrText(err) { // 安全取错误文本：catch 里再抛错就破红线了。
  try { if (!err) return "unknown error"; if (err.message) return String(err.message); return String(err); } catch (e) { return "unknown error"; }
}
function toText(value) { // 安全转字符串：null / undefined 统一成空串。
  return (value === null || value === undefined) ? "" : String(value);
}
function toNumber(value, fallback) { // 安全转数字：非法时用兜底值。
  var num = parseFloat(value); return isNaN(num) ? fallback : num;
}
function rangeToDistance(range, fallback) { // 把解析器的 range（"5*5" / "10" / ""）换算成搜索半径。
  var text = toText(range).trim();
  if (text.length === 0) return fallback;
  var hit = /(\d+)\s*[*xX]\s*(\d+)/.exec(text);
  if (hit) return Math.max(parseInt(hit[1], 10), parseInt(hit[2], 10));
  var single = toNumber(text, 0);
  if (single > 0) return single;
  return fallback;
}
function selfPosition(bot) { // 安全取 bot 当前位置，取不到返回 null。
  try { if (bot && bot.entity && bot.entity.position) return bot.entity.position; } catch (e) { /* 拿不到就当没有 */ }
  return null;
}
function entityPosition(entity) { // 取实体坐标，取不到返回 null。
  try { if (entity && entity.position) return entity.position; } catch (e) { /* 拿不到就当没有 */ }
  return null;
}
function makeVec(bot, x, y, z) { // 构造坐标：优先复用 bot 实体坐标的向量类，造不出来退回普通对象。
  try {
    var base = selfPosition(bot);
    if (base && typeof base.offset === "function") return base.offset(-toNumber(base.x, 0), -toNumber(base.y, 0), -toNumber(base.z, 0)).offset(x, y, z);
    if (base && base.constructor) return new base.constructor(x, y, z);
  } catch (e) { logWarn("makeVec failed: " + getErrText(e)); }
  return { x: x, y: y, z: z };
}
function distanceBetween(from, to) { // 两点距离：拿不准返回 Infinity（等于够不到，会被过滤掉）。
  try {
    if (!from || !to) return Infinity;
    if (typeof from.distanceTo === "function") return from.distanceTo(to);
    var dx = toNumber(to.x, 0) - toNumber(from.x, 0);
    var dy = toNumber(to.y, 0) - toNumber(from.y, 0);
    var dz = toNumber(to.z, 0) - toNumber(from.z, 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  } catch (e) { return Infinity; }
}
// 安全取方块：越界 / 区块没加载都返回 null。
function blockAtSafe(bot, pos) {
  try { if (bot && typeof bot.blockAt === "function" && pos) return bot.blockAt(pos); } catch (e) { logWarn("blockAt failed: " + getErrText(e)); }
  return null;
}
// 找最近的木头 / 矿石：交给 ./bot-scan（先 findBlock 再兜底扫描）；模块缺失时返回 null。
function findNearestBlock(bot, matcher, maxDistance) {
  try {
    if (scanMod && typeof scanMod.findNearestBlock === "function") return scanMod.findNearestBlock(bot, matcher, maxDistance);
  } catch (e) { logWarn("findNearestBlock failed: " + getErrText(e)); }
  return null;
}
async function digSafely(bot, block) { // 挖掉一个方块：先对准再看能不能挖，全程 try/catch。
  if (!block) return false;
  try {
    if (typeof bot.canDigBlock === "function" && !bot.canDigBlock(block)) return false;
    if (typeof bot.lookAt === "function" && block.position) await lookTo(bot, block.position);
    if (typeof bot.dig !== "function") return false;
    await bot.dig(block);
    return true;
  } catch (e) { logWarn("dig failed: " + getErrText(e)); return false; }
}
async function lookTo(bot, pos) { // 看向某个坐标：走 action-bridge 的分步缓转（拟人）；没有 lookAt 不算失败，只是没看。
  try { if (pos && typeof bot.lookAt === "function") { if (bridge && typeof bridge.lookAt === "function") return await bridge.lookAt(bot, pos, 5); await bot.lookAt(pos, true); return true; } } catch (e) { logWarn("lookAt failed: " + getErrText(e)); }
  return false;
}
function pulseForward(bot, ms) { // 短促前进：按毫秒脉冲，到点自己停（不认识路也不崩，走两步就停）。
  try {
    if (typeof bot.setControlState !== "function") return false;
    bot.setControlState("forward", true);
    var timer = setTimeout(function () {
      try { bot.setControlState("forward", false); } catch (e) { /* 已经断开连接 */ }
    }, ms);
    if (timer && typeof timer.unref === "function") timer.unref();
    return true;
  } catch (e) { logWarn("pulseForward failed: " + getErrText(e)); return false; }
}
async function walkToward(bot, pos, ms) { // 走向目标点：先看向，再短促前进（真寻路交给可选插件，这里保底不崩）。
  var looked = await lookTo(bot, pos);
  pulseForward(bot, ms || FOLLOW_PULSE_MS);
  return looked;
}
function stopMoving(bot) { // 停下：清空所有控制状态。
  try {
    if (typeof bot.clearControlStates === "function") { bot.clearControlStates(); return true; }
    if (typeof bot.setControlState === "function") {
      for (var i = 0; i < CONTROL_DIRECTIONS.length; i++) bot.setControlState(CONTROL_DIRECTIONS[i], false);
      return true;
    }
  } catch (e) { logWarn("stopMoving failed: " + getErrText(e)); }
  return false;
}
var HOSTILE_NAMES = [ // 常量：常见敌对生物名（各版本 / 模组对不上时直接跳过，越野车不纠结）。
  "zombie", "skeleton", "creeper", "spider", "enderman", "witch", "slime", "blaze",
  "ghast", "husk", "stray", "drowned", "phantom", "pillager", "vindicator", "ravager",
  "piglin", "hoglin", "zoglin", "magma_cube", "silverfish", "endermite", "guardian",
  "shulker", "evoker", "vex", "cave_spider", "warden", "bogged", "breeze"
];
function isPlayerEntity(entity) { // 判断是不是玩家实体：先看 type，再看有没有用户名。
  try {
    if (!entity) return false;
    return toText(entity.type).toLowerCase() === "player" || toText(entity.username).length > 0;
  } catch (e) { return false; }
}
function isItemEntity(entity) { // 判断是不是掉落物实体：各版本命名不同，能认的都认。
  try {
    if (!entity) return false;
    if (toText(entity.name).toLowerCase() === "item") return true;
    return toText(entity.objectType).toLowerCase() === "item";
  } catch (e) { return false; }
}
function isHostileEntity(entity) { // 判断是不是敌对生物：先排除玩家，再看类型与名字关键词。
  try {
    if (!entity) return false;
    if (isPlayerEntity(entity)) return false;
    var kind = toText(entity.type).toLowerCase();
    for (var i = 0; i < HOSTILE_TYPES.length; i++) if (kind === HOSTILE_TYPES[i]) return true;
    var name = toText(entity.name).toLowerCase();
    if (name.length === 0) return false;
    for (var j = 0; j < HOSTILE_NAMES.length; j++) if (name === HOSTILE_NAMES[j] || name.indexOf(HOSTILE_NAMES[j]) >= 0) return true;
    return false;
  } catch (e) { return false; }
}
function nearestEntity(bot, filter, radius) { // 找最近的实体：filter(entity) 为真才算候选，超出半径就忽略。
  try {
    if (!bot || !bot.entities) return null;
    var base = selfPosition(bot);
    var limit = radius === undefined || radius === null ? DEFAULT_RANGE : radius;
    var best = null, bestDistance = Infinity;
    var ids = Object.keys(bot.entities);
    for (var i = 0; i < ids.length; i++) {
      var entity = null;
      try { entity = bot.entities[ids[i]]; } catch (e) { entity = null; }
      if (!entity || entity === bot.entity) continue;
      if (filter && !filter(entity)) continue;
      var pos = entityPosition(entity);
      if (!base || !pos) { best = best || entity; continue; }
      var dist = distanceBetween(base, pos);
      if (dist > limit) continue;
      if (dist < bestDistance) { bestDistance = dist; best = entity; }
    }
    return best;
  } catch (e) { logWarn("nearestEntity failed: " + getErrText(e)); return null; }
}
function isWoodBlock(name) { // 木头判定：原木 / 木头 / 木板 / 树叶都当木头（宁可多砍，别卡死）。
  var text = toText(name).toLowerCase();
  if (text.length === 0) return false;
  if (text.indexOf("planks") >= 0 || text.indexOf("leaves") >= 0) return true;
  if (text.indexOf("_log") >= 0 || text.indexOf("log_") === 0) return true;
  if (text.indexOf("_wood") >= 0 || text.indexOf("_stem") >= 0 || text.indexOf("_hyphae") >= 0) return true;
  return WOOD_NAME_RE.test(text);
}
function isOreBlock(name) { // 矿石判定：凡带 ore 的都算，远古残骸单列。
  var text = toText(name).toLowerCase();
  if (text.length === 0) return false;
  return text.indexOf("ancient_debris") >= 0 || ORE_NAME_RE.test(text);
}
function findPlaceableItem(bot) { // 找手上能放的方块：先在快捷栏找，再退回背包（找不到返回 null）。
  try {
    if (!bot || !bot.inventory || typeof bot.inventory.items !== "function") return null;
    if (typeof bot.heldItem !== "undefined" && bot.heldItem && bot.heldItem.name) return bot.heldItem;
    var items = bot.inventory.items();
    if (!items || items.length === 0) return null;
    for (var i = 0; i < items.length; i++) {
      var item = items[i], name = toText(item && item.name).toLowerCase();
      if (name.length === 0) continue;
      if (name.indexOf("_log") >= 0 || name.indexOf("planks") >= 0) return item;
      if (name.indexOf("_block") >= 0 || name === "cobblestone" || name === "dirt" || name === "stone") return item;
    }
    return items[0];
  } catch (e) { logWarn("findPlaceableItem failed: " + getErrText(e)); return null; }
}
function actionOk(action, extra) { // 结果：成功 { ok:true, action, error:null }；失败 { ok:false, action, error:"..." }。
  var out = extra || {};
  out.ok = true; out.action = action;
  if (out.error === undefined) out.error = null;
  return out;
}
function actionFail(action, message) { // 失败结果：error 一定是字符串，调用方直接拿去写日志。
  return { ok: false, action: action, error: toText(message) || "failed" };
}
var FOLLOW_PULSE_MS = 600, FOLLOW_DISTANCE = 2; // 常量：兜底前进脉冲时长（毫秒）/ 跟随保持距离（格，2 格以内不再顶人）。真寻路交给可选插件，这里保证「能动一下就停」。
var DEFAULT_ATTACK_DISTANCE = 5; // 常量：默认攻击半径（格）；解析器没给 range 时用它。
var DIG_FILL_BATCH = 3; // 常量：没写 blocks 时一次挖几个（不做无限循环，防止主线程被占死）。
function readTargetPos(opts) { // 读目标坐标：back / position 支持 [x,y,z]、{x,y,z} 或 "x y z" 字符串。
  var src = opts || {};
  var raw = src.back !== undefined && src.back !== null ? src.back : src.position;
  try {
    if (!raw) return null;
    if (typeof raw === "string") {
      var hit = /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/.exec(raw);
      if (!hit) return null;
      return { x: parseFloat(hit[1]), y: parseFloat(hit[2]), z: parseFloat(hit[3]) };
    }
    if (typeof raw.x === "number" && typeof raw.y === "number" && typeof raw.z === "number") {
      return { x: raw.x, y: raw.y, z: raw.z };
    }
    if (typeof raw.length === "number" && raw.length >= 3) {
      return { x: toNumber(raw[0], 0), y: toNumber(raw[1], 0), z: toNumber(raw[2], 0) };
    }
  } catch (e) { logWarn("readTargetPos failed: " + getErrText(e)); }
  return null;
}
function makeDelta(bot, x, y, z) { // 构造方向增量（face vector）：借 bot 实体的向量类，造不出来退回普通对象。
  try {
    var base = selfPosition(bot);
    if (base && base.constructor) return new base.constructor(x, y, z);
  } catch (e) { logWarn("makeDelta failed: " + getErrText(e)); }
  return { x: x, y: y, z: z };
}
async function execStop(bot) { // 动作：stop —— 交给 actions.stopMoving；没接线时退回本地停控制。
  var res = bridge ? await bridge.call(bot, "stopMoving", [], "stop", { delegated: "actions.stopMoving" }) : null;
  if (res) return res;
  var ok = stopMoving(bot);
  try { if (bot && bot.pathfinder && typeof bot.pathfinder.setGoal === "function") bot.pathfinder.setGoal(null); } catch (e) { /* 没插件就算了，不影响停下 */ }
  if (!ok) return actionFail("stop", "bot 不支持停止控制");
  return actionOk("stop");
}
async function execMove(bot, opts) { // 动作：move —— 有寻路时 actions.moveTo 走到目标；否则朝坐标短促走一步。
  var pos = readTargetPos(opts);
  var base = selfPosition(bot);
  if (!pos && !base) return actionFail("move", "拿不到自己的坐标");
  if (!pos) pos = { x: toNumber(base.x, 0) + 2, y: toNumber(base.y, 0), z: toNumber(base.z, 0) };
  var res = bridge ? await bridge.call(bot, "moveTo", [pos.x, pos.y, pos.z], "move", { position: pos, delegated: "actions.moveTo" }, { needsPath: true }) : null;
  if (res && res.ok) return res;
  // 被 stop / 新指令中止的寻路不是「没有寻路能力」：原样回报失败，绝不再补一段脉冲前进。
  if (res && res.code === "ABORTED") return res;
  var looked = await lookTo(bot, makeVec(bot, pos.x, pos.y + 1, pos.z)); // 看向目标头顶一格，不看地平线以下
  pulseForward(bot, FOLLOW_PULSE_MS);
  if (!looked) return actionOk("move", { position: pos, note: "no-lookAt" });
  return actionOk("move", { position: pos });
}
async function digByActions(bot, block) { // 把「挖这个方块」交给 actions.digBlock；返回 null 表示没接线（叫老实现上）。
  if (!bridge) return null;
  var pos = entityPosition(block);
  if (!pos) return null;
  if (typeof bot.canDigBlock === "function" && !bot.canDigBlock(block)) return false;
  await lookTo(bot, pos);
  var res = await bridge.call(bot, "digBlock", [pos.x, pos.y, pos.z], "dig_block", { block: toText(block.name) });
  return res ? res.ok === true : null;
}
async function execDig(bot, action, opts) { // 动作：dig_tree / mine —— 找最近的木头 / 矿石挖掉，一次最多挖 want 个。
  var params = readParams(opts);
  var want = parseInt(params.blocks, 10);
  if (isNaN(want) || want <= 0) want = DIG_FILL_BATCH;
  var maxDistance = rangeToDistance(readRange(opts), DEFAULT_RANGE);
  var wantWood = action === "dig_tree";
  var woodName = toText(params.wood).toLowerCase(), token = actionToken; // 记下本轮代号：被新指令抢占后就不再挖下一块（瞬间放弃旧动作）
  var oreNames = [];
  if (params.ores && params.ores.length) {
    for (var k = 0; k < params.ores.length; k++) oreNames.push(toText(params.ores[k]).toLowerCase());
  }
  var matcher = function (block) {
    try {
      var name = toText(block && block.name).toLowerCase();
      if (name.length === 0) return false;
      if (wantWood) {
        if (woodName.length > 0) return name.indexOf(woodName) >= 0;
        return isWoodBlock(name);
      }
      if (oreNames.length > 0) {
        for (var j = 0; j < oreNames.length; j++) {
          if (name.indexOf(oreNames[j]) >= 0) return true;
        }
        return false;
      }
      return isOreBlock(name);
    } catch (e) { return false; }
  };
  var done = 0;
  for (var n = 0; n < want && token === actionToken; n++) {
    var block = findNearestBlock(bot, matcher, maxDistance);
    if (!block) break;
    var dug = await digByActions(bot, block);
    if (dug === null) dug = await digSafely(bot, block);
    if (!dug) break;
    done++;
  }
  if (done === 0) return actionFail(action, "没找到能挖的方块");
  return actionOk(action, { count: done, want: want });
}
var ATTACK_BATCH = 3; // 常量：一次队列里最多连打几只怪（防止无限追怪把主线程占死）。
function readParams(opts) { // 读动作参数：兼容扁平结构（{action, blocks, ...}）与嵌套结构（{action, params:{...}}）。
  var src = opts || {};
  try { if (src.params && typeof src.params === "object") return src.params; } catch (e) { /* 读不到就当扁平结构 */ }
  return src;
}
function readRange(opts) { // 读动作范围：同样兼容扁平与嵌套两种结构。
  var src = opts || {};
  if (toText(src.range).length > 0) return toText(src.range);
  var params = readParams(src);
  if (params && params !== src) return toText(params.range);
  return "";
}
async function attackEntity(bot, entity) { // 攻击一个实体：接线后交给 actions.attackEntity；没接线才退回「先看向再抬手」。
  if (bridge && entity) {
    var who = toText(entity.username) || toText(entity.name);
    var hit = await bridge.call(bot, "attackEntity", [who.length > 0 ? who : entity.id], "attackEntity");
    if (hit) return hit.ok === true;
  }
  try {
    if (!entity) return false;
    var pos = entityPosition(entity);
    if (pos) await lookTo(bot, pos);
    if (typeof bot.attack === "function") { bot.attack(entity); return true; }
    if (typeof bot.swingArm === "function") { bot.swingArm("right"); return true; }
  } catch (e) { logWarn("attack failed: " + getErrText(e)); }
  return false;
}
async function execAttackAll(bot, opts, actionName) { // 动作：attack_all / attack —— 打最近的敌对生物，一次最多 ATTACK_BATCH 只。
  var name = toText(actionName) || "attack_all";
  var radius = rangeToDistance(readRange(opts), DEFAULT_ATTACK_DISTANCE);
  var hit = 0;
  for (var n = 0; n < ATTACK_BATCH; n++) {
    var target = nearestEntity(bot, isHostileEntity, radius);
    if (!target) break;
    if (!(await attackEntity(bot, target))) break;
    hit++;
  }
  if (hit === 0) return actionFail(name, "附近没有能打的怪");
  return actionOk(name, { count: hit });
}
async function execFollow(bot, opts) { // 动作：follow —— 跟最近的玩家；带 players 名单时只认名单里的名字。
  var params = readParams(opts);
  var wanted = [];
  if (params && params.players && params.players.length) {
    for (var i = 0; i < params.players.length; i++) wanted.push(toText(params.players[i]).toLowerCase());
  }
  var matcher = function (entity) {
    try {
      if (!isPlayerEntity(entity)) return false;
      if (wanted.length === 0) return true;
      var name = toText(entity.username).toLowerCase();
      for (var k = 0; k < wanted.length; k++) {
        if (name === wanted[k]) return true;
      }
      return false;
    } catch (e) { return false; }
  };
  var target = nearestEntity(bot, matcher, DEFAULT_RANGE);
  if (!target) return actionFail("follow", "附近没有要跟随的玩家");
  var pos = entityPosition(target);
  if (!pos) return actionFail("follow", "读不到玩家坐标");
  var player = toText(target.username);
  var res = bridge ? await bridge.call(bot, "followPlayer", [player, FOLLOW_DISTANCE], "follow", { player: player, distance: FOLLOW_DISTANCE, delegated: "actions.followPlayer" }) : null;
  if (res && res.ok) return res;
  var close = distanceBetween(selfPosition(bot), pos) <= FOLLOW_DISTANCE; // 2 格以内不再往玩家身上顶
  var looked = close ? null : await walkToward(bot, makeVec(bot, toNumber(pos.x, 0), toNumber(pos.y, 0) + 1.6, toNumber(pos.z, 0)), FOLLOW_PULSE_MS);
  if (!looked) return actionOk("follow", { player: player, note: close ? "already-close" : "no-lookAt" });
  return actionOk("follow", { player: player });
}
async function execCollect(bot) { // 动作：collect —— 有寻路时交给 actions.collectNearbyItems 捡一圈，否则朝最近的掉落物走。
  var res = bridge ? await bridge.call(bot, "collectNearbyItems", [], "collect", { delegated: "actions.collectNearbyItems" }, { needsPath: true }) : null;
  if (res && res.ok) return res;
  if (res && res.code === "ABORTED") return res;
  var item = nearestEntity(bot, isItemEntity, DEFAULT_RANGE);
  if (!item) return actionFail("collect", "附近没有掉落物");
  var pos = entityPosition(item);
  if (!pos) return actionFail("collect", "读不到掉落物坐标");
  await walkToward(bot, makeVec(bot, toNumber(pos.x, 0), toNumber(pos.y, 0), toNumber(pos.z, 0)), FOLLOW_PULSE_MS);
  return actionOk("collect", { item: toText(item.name) });
}
async function execPlace(bot) { // 动作：place —— 交给 actions.placeBlock 放到脚下上方；没接线时走本地实现。
  var item = findPlaceableItem(bot);
  if (!item) return actionFail("place", "背包里没有能放的方块");
  var base = selfPosition(bot);
  if (!base) return actionFail("place", "拿不到自己的坐标");
  var res = bridge ? await bridge.call(bot, "placeBlock", [toText(item.name), base.x, base.y, base.z], "place", { item: toText(item.name), delegated: "actions.placeBlock" }) : null;
  if (res) return res.ok ? res : actionFail("place", toText(res.error));
  try {
    if (typeof bot.equip === "function") await bot.equip(item, "hand");
    var below = null;
    try { if (typeof base.offset === "function") below = base.offset(0, -1, 0); } catch (e) { below = null; }
    if (!below) below = { x: toNumber(base.x, 0), y: toNumber(base.y, 0) - 1, z: toNumber(base.z, 0) };
    var ground = blockAtSafe(bot, below);
    if (!ground) return actionFail("place", "脚下没有可放的参照方块");
    if (typeof bot.placeBlock !== "function") return actionFail("place", "bot 不支持放置方块");
    await bot.placeBlock(ground, makeDelta(bot, 0, 1, 0));
    return actionOk("place", { item: toText(item.name) });
  } catch (e) { logWarn("place failed: " + getErrText(e)); return actionFail("place", getErrText(e)); }
}
async function execDigBlock(bot, opts) { // 动作：dig_block —— 挖指定坐标的方块（交给 actions.digBlock）。
  var pos = readTargetPos(opts);
  if (!pos) return actionFail("dig_block", "缺少目标坐标");
  var res = bridge ? await bridge.call(bot, "digBlock", [pos.x, pos.y, pos.z], "dig_block", {}) : null;
  if (!res) return actionFail("dig_block", "基础动作模块不可用");
  return res;
}
function itemIdByName(bot, name) { // 把物品名换成注册表里的数字 id（各版本字段不同，能查的都查）；查不到返回 null。
  try {
    var registry = bot && bot.registry;
    if (!registry) return null;
    if (registry.itemsByName && registry.itemsByName[name]) return registry.itemsByName[name].id;
    if (registry.items && registry.items[name]) return registry.items[name].id;
    if (registry.itemsArray && registry.itemsArray.length) {
      for (var i = 0; i < registry.itemsArray.length; i++) {
        var item = registry.itemsArray[i];
        if (item && toText(item.name) === name) return item.id;
      }
    }
  } catch (e) { logWarn("itemIdByName failed: " + getErrText(e)); }
  return null;
}
async function execCraft(bot, opts) { // 动作：craft —— 按 wood 名字找配方合成 1 个（找不到配方只记失败，不崩）。
  var params = readParams(opts);
  var wood = toText(params && params.wood).toLowerCase();
  var wanted = [];
  if (wood.length > 0) { wanted.push(wood + "_planks"); wanted.push(wood); }
  wanted.push("oak_planks", "stick", "crafting_table");
  try {
    if (!bot || typeof bot.craft !== "function" || typeof bot.recipesFor !== "function") return actionFail("craft", "bot 不支持合成");
    for (var i = 0; i < wanted.length; i++) {
      var id = itemIdByName(bot, wanted[i]);
      if (id === null) continue;
      var recipes = [];
      try { recipes = bot.recipesFor(id, null, 1, null) || []; } catch (e) { recipes = []; }
      if (recipes.length === 0) {
        try { recipes = bot.recipesFor(id, null, 1, true) || []; } catch (e) { recipes = []; }
      }
      if (recipes.length === 0) continue;
      await bot.craft(recipes[0], 1, null);
      return actionOk("craft", { item: wanted[i] });
    }
  } catch (e) { logWarn("craft failed: " + getErrText(e)); return actionFail("craft", getErrText(e)); }
  return actionFail("craft", "没有找到能用的配方");
}
// 可选依赖：动作串行链（可插队）；缺失时退回本文件里的朴素串行链（老行为，严格排队）。
var chainMod = null;
try { chainMod = require("./action-chain"); } catch (e) { chainMod = null; }
var localChain = null; // 兜底串行链：只在 action-chain 缺失时用。
// 常量：没有 action-chain 时的插队等待上限（毫秒），与 action-chain.QUEUE_ESCAPE_MS 保持一致。
var QUEUE_ESCAPE_MS = 250;
// 把任务排进串行链：默认严格排队；escapeMs 有值时最多等这么久，等不到就强行插队。
function enqueue(task, escapeMs) {
  try {
    if (chainMod && typeof chainMod.enqueue === "function") return chainMod.enqueue(task, escapeMs);
  } catch (e0) { /* 退回本地串行链 */ }
  var run = function () { return Promise.resolve().then(task); };
  var next = localChain ? localChain.then(run, run) : run();
  localChain = next.then(function () { return null; }, function () { return null; });
  return next;
}
// 内部：新动作要不要先抢占——stop 自己就是「停下」（actions.stopMoving 会清跟随 / 视线 / 寻路），
// 再抢一次只会重复清控制状态、多刷一条播报，所以直接跳过。返回是否真的执行了抢占。
function preemptFor(bot, name) {
  if (toText(name).toLowerCase().trim() === "stop") return false;
  try { if (bridge && typeof bridge.preempt === "function") { bridge.preempt(bot, name); return true; } } catch (e) { logWarn("preempt failed: " + getErrText(e)); }
  return false;
}
// 内部：这批队列里有没有「真会动」的动作——全是 stop 就不抢占（同上，避免重复清状态）。
function queueNeedsPreempt(queue) {
  try {
    if (!Array.isArray(queue)) return false;
    for (var i = 0; i < queue.length; i++) {
      var item = queue[i], name = item && typeof item === "object" ? toText(item.action) : toText(item);
      if (name.toLowerCase().trim() !== "stop") return true;
    }
  } catch (e) { /* 判不出来就按不需要处理 */ }
  return false;
}
// 内部：这批队列是不是「纯停止」——纯 stop 只是清状态，可以直接插队（0 毫秒等待）。
function stopOnly(queue) {
  return !queueNeedsPreempt(queue);
}
// 功能 1：执行一个动作。action 可以是动作名字符串（配第二参数 opts），
async function executeAction(bot, action, opts) { // 也可以是解析结果对象，或队列项 { action, command }。
  var name = "";
  var config = {};
  try {
    if (action && typeof action === "object") {
      name = toText(action.action).toLowerCase().trim();
      config = action.command && typeof action.command === "object" ? action.command : action;
    } else {
      name = toText(action).toLowerCase().trim();
      config = opts || {};
    }
  } catch (e) { return actionFail(UNKNOWN_ACTION, "动作参数不合法"); }
  if (name.length === 0) return actionFail(UNKNOWN_ACTION, "动作对象缺少 action 字段");
  if (!bot) return actionFail(name, "没有可用的 bot 实例");
  if (swarmCmd && swarmCmd.isSwarm(name)) return await swarmCmd.run(name, bot, config); // 状态机 3.0：swarm_ 前缀直连蜂群控制台，不抢占既有动作队列。
  if (bridge && typeof bridge.preempt === "function") preemptFor(bot, name); // 抢占：停旧动作 + 清寻路目标，别被上一条卡死
  actionToken++; // 代号 +1：还在跑的老循环（挖木头 / 连打）下一次检查就自己退出
  try {
    if (name === "stop") return await execStop(bot);
    if (name === "move") return await execMove(bot, config);
    if (name === "dig_block") return await execDigBlock(bot, config);
    if (name === "dig_tree" || name === "mine") return await execDig(bot, name, config);
    if (name === "attack_all" || name === "attack") return await execAttackAll(bot, config, name);
    if (name === "follow") return await execFollow(bot, config);
    if (name === "collect") return await execCollect(bot);
    if (name === "place") return await execPlace(bot);
    if (name === "craft") return await execCraft(bot, config);
  } catch (e) { logWarn("executeAction(" + name + ") failed: " + getErrText(e)); return actionFail(name, getErrText(e)); }
  logLan("skip unknown action: " + name);
  return actionFail(UNKNOWN_ACTION, "不认识的动作：" + name);
}
async function runQueueInner(bot, queue) { // 功能 2：顺序执行队列本体；某一项带 back 坐标的，全部做完再走回那个坐标。
  var list = [];
  try { list = Array.isArray(queue) ? queue : []; } catch (e) { list = []; }
  var summary = { ok: true, total: list.length, done: 0, failed: 0, results: [], back: null };
  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    var config = item && typeof item === "object" ? (item.command || item) : {};
    var backPos = readTargetPos({ back: config ? config.back : null });
    if (backPos && !summary.back) summary.back = backPos;
    var result = await executeAction(bot, item, config);
    if (result && result.ok) summary.done++;
    else { summary.failed++; summary.ok = false; }
    summary.results.push(result);
  }
  if (summary.back) {
    var backResult = await executeAction(bot, { action: "move", back: summary.back });
    summary.results.push(backResult);
    if (!backResult.ok) summary.backFailed = true;
  }
  logSystem("queue done: " + summary.done + "/" + summary.total + ", failed=" + summary.failed);
  return summary;
}
function runQueue(bot, queue) { // 功能 3：把整条队列排进串行链，返回执行报告（调用方 await）。
  try {
    if (queueNeedsPreempt(queue) && bridge && typeof bridge.preempt === "function") bridge.preempt(bot, toText(queue[0] && queue[0].action)); // 新指令一到就松手：旧移动 / 跟随 / 遗留队列立刻放弃，不等超时
    // 纯 stop 直接插队（0 毫秒）；其它指令最多等旧任务 QUEUE_ESCAPE_MS——挂死的老任务不许饿死新指令。
    var escape = stopOnly(queue) ? 0 : QUEUE_ESCAPE_MS;
    return enqueue(function () { return runQueueInner(bot, queue); }, escape);
  } catch (e) {
    logWarn("runQueue failed: " + getErrText(e));
    return Promise.resolve({ ok: false, total: 0, done: 0, failed: 0, results: [], error: getErrText(e) });
  }
}
function attach(bot) { // 功能 4：挂到 bot 上听 "bot-action-queue"；返回卸载函数（bot 不可用时返回 null）。
  if (!bot || typeof bot.on !== "function") {
    logWarn("command-handler attach failed: bot unavailable");
    return null;
  }
  var onQueue = function (payload) {
    try {
      var list = [];
      if (Array.isArray(payload)) list = payload;
      else if (payload && Array.isArray(payload.actions)) list = payload.actions;
      if (list.length === 0) return;
      var task = runQueue(bot, list);
      if (task && typeof task.catch === "function") {
        task.catch(function (err) { logWarn("runQueue failed: " + getErrText(err)); });
      }
    } catch (e) { logWarn("queue listener failed: " + getErrText(e)); }
  };
  try { bot.on("bot-action-queue", onQueue); } catch (e) { logWarn("attach failed: " + getErrText(e)); return null; }
  return function detach() {
    try { if (typeof bot.removeListener === "function") bot.removeListener("bot-action-queue", onQueue); } catch (e) { /* 已经断开就算了 */ }
    return true;
  };
}
module.exports = { attach: attach, executeAction: executeAction, runQueue: runQueue }; // 对外导出：attach、executeAction、runQueue。
