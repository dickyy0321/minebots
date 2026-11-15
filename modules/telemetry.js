// ========================================
// 文件：modules/telemetry.js
// 功能：实时状态遥测——打包血量 / 饥饿 / 经验 / 坐标 / 主副手 / 背包 / 维度 / 时间，并即时推送挨打与方块变化
// 依赖：./logger（可选）、./context-manager（可选）、./radar（可选，提供 64 格 2D 雷达数据）
// 导出：getBotState / attach / detach / snapshotBots / startBroadcast / stopBroadcast / setSink /
//       broadcastNow / recentEvents / MAX_EVENTS / BROADCAST_MS
// 作者：MineBots
// ========================================
//
// 用法 / usage
//   1. telemetry.setSink(fn)                 → 主进程注册「往 GUI 推」的回调（只推一条 JSON）
//   2. telemetry.attach(bot, "bot-1")        → 挂事件监听（entityHurt / blockPlaced / blockUpdate / end）
//   3. telemetry.getBotState(bot)            → 当前状态快照（AI 的 get_bot_state 工具与 GUI 面板都用它）
//   4. telemetry.startBroadcast(collect, ms) → 定时把 collect() 的结果推给 GUI（默认 1 秒一拍）
// 约定：所有外部调用（mineflayer 事件、上下文写入、定时器）一律 try/catch，失败只降级写日志。
// ES5 风格，CommonJS，无中文变量名
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 可选依赖：上下文管理（挨打时把攻击者坐标写进 AI 上下文，AI 才知道该防谁）。
var contextManager = null;
try { contextManager = require("./context-manager"); } catch (e) { contextManager = null; }

// 可选依赖：2D 雷达数据源（64 格扫描）；缺失时快照里 radar 为 null，小地图自动回退 nearby。
var radarSource = null;
try { radarSource = require("./radar"); } catch (e) { radarSource = null; }

// 常量：每个 bot 最多保留多少条事件 / 默认广播间隔（毫秒）/ 挨打时找凶手的搜索半径。
var MAX_EVENTS = 40;
var BROADCAST_MS = 1000;
var ATTACKER_RADIUS = 12;
// 常量：小地图关注半径（格）——超出这个距离的生物不往快照里塞。
var NEARBY_RADIUS = 16;

// 状态：GUI 推送回调（主进程注入）/ 广播定时器句柄。
var sink = null;
var broadcastTimer = null;

// 安全提取错误文本，catch 里不会二次抛错。
function getErrText(err) {
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

// 写文件日志：遥测是高频信息，只落文件不推 GUI。
function logInfo(msg) {
  try {
    if (logger && typeof logger.info === "function") { logger.info("[telemetry] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[telemetry] " + msg); } catch (e2) { /* ignore */ }
}

// 写告警日志：挨打 / 推送失败这类要人看见的事才推 GUI。
function logWarn(msg) {
  try {
    if (logger && typeof logger.warn === "function") { logger.warn("[telemetry] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.warn("[telemetry] " + msg); } catch (e2) { /* ignore */ }
}


// 把任意坐标对象拍成 { x, y, z }（保留两位小数）；读不到返回 null。
function posJson(point) {
  try {
    if (!point) return null;
    var x = toNum(point.x, NaN);
    var y = toNum(point.y, NaN);
    var z = toNum(point.z, NaN);
    if (isNaN(x) || isNaN(y) || isNaN(z)) return null;
    var round = function (v) { return Math.round(v * 100) / 100; };
    return { x: round(x), y: round(y), z: round(z) };
  } catch (e) { return null; }
}

// 读背包物品列表（含数量）：读不到返回空数组。
function listItems(bot) {
  try {
    if (!bot || !bot.inventory || typeof bot.inventory.items !== "function") return [];
    var items = bot.inventory.items() || [];
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it) continue;
      out.push({ name: toText(it.name), count: Math.round(toNum(it.count, 0)), slot: toNum(it.slot, -1) });
    }
    return out;
  } catch (e) { return []; }
}

// 把一件物品拍成 { name, count }；没有物品时返回 null（JSON 里就是 null，AI 好判断）。
function itemJson(item) {
  try {
    if (!item) return null;
    return { name: toText(item.name), count: Math.round(toNum(item.count, 0)) };
  } catch (e) { return null; }
}

// 读主手物品：优先 bot.heldItem，其次按快捷栏槽位从背包里找。
function mainHandOf(bot) {
  try {
    if (!bot) return null;
    var held = itemJson(bot.heldItem);
    if (held) return held;
    if (bot.inventory && bot.inventory.slots && typeof bot.quickBarSlot === "number") {
      return itemJson(bot.inventory.slots[36 + bot.quickBarSlot]);
    }
  } catch (e) { /* 返回 null */ }
  return null;
}

// 读副手物品：mineflayer 的副手槽固定是 45，读不到就返回 null。
function offHandOf(bot) {
  try {
    if (!bot || !bot.inventory || !bot.inventory.slots) return null;
    return itemJson(bot.inventory.slots[45]);
  } catch (e) { return null; }
}

// 读当前维度：先看 bot.game.dimension，再看 bot.dimension，都没有返回 unknown。
function dimensionOf(bot) {
  try {
    if (bot && bot.game && bot.game.dimension) return toText(bot.game.dimension);
    if (bot && bot.dimension) return toText(bot.dimension);
  } catch (e) { /* 返回 unknown */ }
  return "unknown";
}

// 读时间：timeOfDay 0~24000（12000 以后算夜里），读不到返回 phase=unknown。
function timeOfDayOf(bot) {
  var out = { timeOfDay: -1, phase: "unknown" };
  try {
    if (!bot || !bot.time) return out;
    var raw = toNum(bot.time.timeOfDay, NaN);
    if (isNaN(raw)) raw = toNum(bot.time.age, NaN);
    if (isNaN(raw)) return out;
    out.timeOfDay = Math.round(raw);
    out.phase = (raw >= 12000 && raw < 23000) ? "night" : "day";
  } catch (e) { /* 返回 unknown */ }
  return out;
}

// 读经验：等级 / 当前点数 / 进度（缺字段按 0 处理）。
function experienceOf(bot) {
  var out = { level: 0, points: 0, progress: 0 };
  try {
    if (!bot || !bot.experience) return out;
    out.level = Math.round(toNum(bot.experience.level, 0));
    out.points = Math.round(toNum(bot.experience.points, 0));
    out.progress = toNum(bot.experience.progress, 0);
  } catch (e) { /* 返回默认值 */ }
  return out;
}

// 读视角朝向（yaw / pitch 弧度）：优先 bot.entity，读不到返回 null（小地图与手动驾驶都要用）。
function viewOf(bot) {
  try {
    var ent = bot && bot.entity ? bot.entity : null;
    if (!ent) return null;
    if (typeof ent.yaw !== "number") return null;
    return {
      yaw: Math.round(toNum(ent.yaw, 0) * 1000) / 1000,
      pitch: Math.round(toNum(ent.pitch, 0) * 1000) / 1000
    };
  } catch (e) { return null; }
}

// 数一下身边 16 格内的玩家 / 生物（小地图画点用），最多记 8 个；读不到返回空数组。
function nearbyOf(bot) {
  var out = [];
  try {
    if (!bot || !bot.entity || !bot.entity.position || !bot.entities) return out;
    var me = bot.entity.position;
    var keys = Object.keys(bot.entities);
    var rows = [];
    for (var i = 0; i < keys.length; i++) {
      var ent = bot.entities[keys[i]];
      if (!ent || ent === bot.entity || !ent.position) continue;
      var name = toText(ent.username || ent.name || ent.displayName);
      var isPlayer = ent.username ? true : false;
      var isMob = ent.type === "mob" || ent.type === "hostile" || ent.type === "animal";
      if (!isPlayer && !isMob) continue;
      var dx = toNum(ent.position.x, 0) - toNum(me.x, 0);
      var dy = toNum(ent.position.y, 0) - toNum(me.y, 0);
      var dz = toNum(ent.position.z, 0) - toNum(me.z, 0);
      var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > NEARBY_RADIUS) continue;
      rows.push({ name: name, player: isPlayer, dx: Math.round(dx * 10) / 10, dz: Math.round(dz * 10) / 10, distance: Math.round(dist * 10) / 10 });
    }
    rows.sort(function (a, b) { return a.distance - b.distance; });
    out = rows.slice(0, 8);
  } catch (e) { return out; }
  return out;
}

// 功能 1：把 bot 的实时状态打包成 JSON（AI 的 get_bot_state 与 GUI 面板共用同一份结构）。
function getBotState(bot) {
  var out = {
    ok: false, id: "", health: null, food: null, experience: { level: 0, points: 0, progress: 0 },
    position: null, dimension: "unknown", time: { timeOfDay: -1, phase: "unknown" },
    mainHand: null, offHand: null, inventory: [], inventorySlots: 0, view: null, nearby: [], at: Date.now()
  };
  try {
    if (!bot) { out.message = "bot not ready / 机器人未就绪"; return out; }
    out.ok = true;
    out.id = toText(bot._mbBotId || bot.username);
    if (typeof bot.health === "number") out.health = Math.round(bot.health * 10) / 10;
    if (typeof bot.food === "number") out.food = Math.round(bot.food * 10) / 10;
    out.experience = experienceOf(bot);
    out.position = posJson(bot.entity ? bot.entity.position : null);
    out.dimension = dimensionOf(bot);
    out.time = timeOfDayOf(bot);
    out.mainHand = mainHandOf(bot);
    out.offHand = offHandOf(bot);
    out.inventory = listItems(bot);
    out.inventorySlots = out.inventory.length;
    out.view = viewOf(bot);
    out.nearby = nearbyOf(bot);
    // 2D 雷达：独立 64 格扫描，nearby 保持 16 格 / 8 个的既有语义不变。
    // 专家面板关掉雷达后，快照里 radar 直接为 null，主进程不再向 GUI 推送任何雷达数据。
    try {
      var radarOn = !(radarSource && typeof radarSource.isEnabled === "function" && radarSource.isEnabled() === false);
      var radarSnap = radarOn && radarSource && typeof radarSource.scan === "function" ? radarSource.scan(bot) : null;
      out.radar = radarSnap && radarSnap.enabled === false ? null : radarSnap;
    } catch (eRadar) { out.radar = null; }
  } catch (err) {
    out.ok = false;
    out.message = "state collect failed / 状态采集失败: " + getErrText(err);
  }
  return out;
}

// 功能 2：注册「往 GUI 推」的回调（主进程注入；推函数为空时只落日志，不报错）。
function setSink(fn) {
  try {
    sink = (typeof fn === "function") ? fn : null;
    return sink !== null;
  } catch (e) { sink = null; return false; }
}

// 内部：把一条数据推给 GUI；没有回调或回调抛错都只降级写日志。
function push(payload) {
  try {
    if (typeof sink !== "function") return false;
    sink(payload);
    return true;
  } catch (err) {
    logWarn("推送失败 / push failed: " + getErrText(err));
    return false;
  }
}

// 内部：把事件塞进 bot 的环形缓存（最多 MAX_EVENTS 条），返回最新一条。
function remember(bot, event) {
  try {
    if (!bot) return event;
    if (!bot._mbTelemetry || typeof bot._mbTelemetry !== "object") return event;
    var list = bot._mbTelemetry.events;
    if (!list) { list = []; bot._mbTelemetry.events = list; }
    list.push(event);
    while (list.length > MAX_EVENTS) list.shift();
  } catch (e) { /* 缓存失败不影响推送 */ }
  return event;
}

// 内部：读最近事件（新的在后）；没有事件返回空数组。
function recentEvents(bot, limit) {
  try {
    if (!bot || !bot._mbTelemetry || !bot._mbTelemetry.events) return [];
    var list = bot._mbTelemetry.events.slice(0);
    var max = Math.round(toNum(limit, 10));
    if (max <= 0) max = 10;
    return list.slice(Math.max(0, list.length - max));
  } catch (e) { return []; }
}

// 内部：在附近找一个最可能的攻击者（只认会打的生物，绝不把路过的玩家栽赃成凶手）。
// 为什么不再猜玩家：mineflayer 的 entityHurt 只在极少数情况下给 source，
// 之前「12 格内最近的玩家」这个兜底会把站在旁边看戏的玩家当成凶手 → 前端天天误报「遇袭」。
function findAttacker(bot) {
  var best = null;
  var bestDist = Infinity;
  try {
    if (!bot || !bot.entities || !bot.entity) return null;
    var me = bot.entity.position;
    if (!me) return null;
    var keys = Object.keys(bot.entities);
    for (var i = 0; i < keys.length; i++) {
      var ent = bot.entities[keys[i]];
      if (!ent || ent === bot.entity || !ent.position) continue;
      // 玩家一律不给：只有插件明确给了 source 才认定玩家攻击，站位近不算证据。
      var isMob = (ent.type === "mob" || ent.type === "hostile" || ent.type === "animal");
      if (!isMob) continue;
      var dx = toNum(ent.position.x, 0) - toNum(me.x, 0);
      var dy = toNum(ent.position.y, 0) - toNum(me.y, 0);
      var dz = toNum(ent.position.z, 0) - toNum(me.z, 0);
      var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > ATTACKER_RADIUS) continue;
      if (d < bestDist) { bestDist = d; best = ent; }
    }
  } catch (e) { return null; }
  return best;
}

// 功能 2：判断某个实体是不是 bot 自己——对象同一性 + entityId 双保险。
// 为什么不用 entity === bot.entity 单条判断：mineflayer 换维度 / 重连后会重新造实体对象，
// 只比对象会把「自己挨打」漏掉，只比对象又会在 entity 为 undefined 时把「别人挨打」当成自己挨打。
function isSelfEntity(bot, entity) {
  try {
    var me = bot ? bot.entity : null;
    if (!entity || !me) return false;
    if (entity === me) return true;
    var a = entity.id, b = me.id;
    if (a === undefined || a === null || b === undefined || b === null) return false;
    return String(a) === String(b);
  } catch (e) { return false; }
}

// 功能 2b：这次 entityHurt 是不是「bot 自己被打」——只有它为真才允许产生遇袭警报。
function isUnderAttack(bot, entity) {
  if (!bot || !bot.entity) return false;
  return isSelfEntity(bot, entity);
}


function noteAttacker(bot, event) {
  try {
    if (!contextManager || typeof contextManager.addContext !== "function") return false;
    var who = toText(event.attackerName) || "unknown";
    var pos = event.attacker ? ("(" + event.attacker.x + "," + event.attacker.y + "," + event.attacker.z + ")") : "(未知 / unknown)";
    var text = "遇袭 / under attack: 攻击者 " + who + " 位于 " + pos + "，bot 血量 " + toText(event.health);
    contextManager.addContext(text, "temporary");
    return true;
  } catch (err) {
    logInfo("写入上下文失败 / context write failed: " + getErrText(err));
    return false;
  }
}

// 功能 4：挨打处理——立刻推 bot_under_attack 警报，并把攻击者坐标发进 AI 上下文。
// 严格只认「自己挨打」：别的玩家 / 怪物互相打，这里一律返回 null（不推前端、不发系统警告）。
function handleHurt(bot, entity, source) {
  try {
    if (!bot || !bot.entity) return null;
    if (!isUnderAttack(bot, entity)) return null;
    var attacker = null;
    try { if (source && !isSelfEntity(bot, source)) attacker = source; } catch (e1) { attacker = null; }
    if (!attacker) attacker = findAttacker(bot); // 只认贴身的怪，绝不把路过的玩家栽赃成凶手
    var attackerPos = posJson(attacker ? attacker.position : null);
    var attackerName = attacker ? toText(attacker.username || attacker.name || attacker.displayName) : "";
    var state = getBotState(bot);
    var event = remember(bot, {
      type: "bot_under_attack",
      at: Date.now(),
      botId: toText(bot._mbBotId || bot.username),
      attackerName: attackerName,
      attacker: attackerPos,
      health: state.health,
      position: state.position,
      message: "遇袭 / under attack: " + (attackerName || "unknown")
    });
    noteAttacker(bot, event);
    logWarn("遇袭 / under attack: " + toText(bot._mbBotId) + " <- " + (attackerName || "unknown") + " @ " + JSON.stringify(attackerPos));
    push({ kind: "alert", alert: event, bot: state });
    return event;
  } catch (err) {
    logInfo("挨打处理失败 / hurt handler failed: " + getErrText(err));
    return null;
  }
}

// 功能 5：记录放置 / 挖掉的方块（方块名 + 坐标 + bot），推给 GUI 与 AI 事件缓存。
function handleBlockChange(bot, kind, block, otherBlock) {
  try {
    if (!bot) return null;
    var name = "";
    var pos = null;
    try {
      if (block) { name = toText(block.name); pos = posJson(block.position); }
      if ((!name || name === "air") && otherBlock) { name = toText(otherBlock.name); pos = posJson(otherBlock.position); }
    } catch (e1) { /* 方块被卸载了就只记名字 */ }
    var event = remember(bot, {
      type: kind,
      at: Date.now(),
      botId: toText(bot._mbBotId || bot.username),
      block: name,
      position: pos,
      message: (kind === "block_placed" ? "放置方块 / placed: " : "方块变化 / block changed: ") + name
    });
    logInfo(event.message + " @ " + JSON.stringify(pos));
    push({ kind: "event", alert: event });
    return event;
  } catch (err) {
    logInfo("方块事件失败 / block event failed: " + getErrText(err));
    return null;
  }
}

// 功能 6：给一个 bot 挂遥测监听；重复挂会先卸旧的，返回是否挂成功。
function attach(bot, botId) {
  try {
    if (!bot || typeof bot.on !== "function") return false;
    detach(bot);
    bot._mbBotId = toText(botId) || toText(bot._mbBotId) || toText(bot.username);
    bot._mbTelemetry = { events: [], onHurt: null, onPlaced: null, onUpdate: null, onEnd: null };
    var state = bot._mbTelemetry;

    // 挨打：mineflayer 的 entityHurt 会给 (entity, source)，source 不一定有，缺就自己找凶手。
    if (typeof bot.on === "function") {
      state.onHurt = function (entity, source) { return handleHurt(bot, entity, source); };
      bot.on("entityHurt", state.onHurt);
      // 放置方块 / 方块变化：只做事件记录，不做任何动作。
      state.onPlaced = function (block, newBlock) { return handleBlockChange(bot, "block_placed", block || newBlock, newBlock); };
      bot.on("blockPlaced", state.onPlaced);
      state.onUpdate = function (oldBlock, newBlock) { return handleBlockChange(bot, "block_update", newBlock || oldBlock, oldBlock); };
      bot.on("blockUpdate", state.onUpdate);
      // 机器人断开就把监听摘掉，别让定时器 / 回调拖住进程。
      state.onEnd = function () { detach(bot); };
      bot.on("end", state.onEnd);
      bot.on("kicked", state.onEnd);
    }
    logInfo("遥测已挂载 / telemetry attached: " + toText(bot._mbBotId));
    return true;
  } catch (err) {
    logInfo("挂载遥测失败 / attach failed: " + getErrText(err));
    return false;
  }
}

// 功能 7：摘掉遥测监听并清空缓存；没有挂过也安全返回 false。
function detach(bot) {
  try {
    if (!bot || typeof bot.removeListener !== "function") return false;
    var state = bot._mbTelemetry;
    if (!state) return false;
    if (state.onHurt) bot.removeListener("entityHurt", state.onHurt);
    if (state.onPlaced) bot.removeListener("blockPlaced", state.onPlaced);
    if (state.onUpdate) bot.removeListener("blockUpdate", state.onUpdate);
    if (state.onEnd) {
      bot.removeListener("end", state.onEnd);
      bot.removeListener("kicked", state.onEnd);
    }
    bot._mbTelemetry = null;
    return true;
  } catch (err) {
    logInfo("卸载遥测失败 / detach failed: " + getErrText(err));
    return false;
  }
}

// 功能 8：把多个 bot 一起拍成快照数组；传进来的每项可以是 bot 本身或 { id, bot }。
function snapshotBots(list) {
  var out = [];
  try {
    if (!list) return out;
    var arr = Array.isArray(list) ? list : [];
    for (var i = 0; i < arr.length; i++) {
      var row = arr[i];
      var bot = row && row.bot ? row.bot : row;
      if (!bot) continue;
      var snap = getBotState(bot);
      if (row && row.id) snap.id = toText(row.id);
      out.push(snap);
    }
  } catch (err) {
    logInfo("快照失败 / snapshot failed: " + getErrText(err));
  }
  return out;
}

// 功能 9：立刻广播一次（collect() 返回什么就推什么，推的时候统一包一层 type=telemetry）。
function broadcastNow(collect) {
  try {
    var payload = null;
    if (typeof collect === "function") payload = collect();
    if (!payload) return false;
    return push({ kind: "telemetry", bots: payload.bots || payload, at: Date.now() });
  } catch (err) {
    logInfo("广播失败 / broadcast failed: " + getErrText(err));
    return false;
  }
}

// 功能 10：起一个定时广播（默认 1000ms 一拍，定时器 unref，绝不拖住进程）；返回是否启动成功。
function startBroadcast(collect, everyMs) {
  try {
    if (typeof collect !== "function") return false;
    stopBroadcast();
    var every = Math.round(toNum(everyMs, BROADCAST_MS));
    // 性能护栏：低于 1 秒的推送一律抬到 1 秒，绝不允许高频刷 GUI。
    if (every < BROADCAST_MS) every = BROADCAST_MS;
    broadcastTimer = setInterval(function () {
      try { broadcastNow(collect); } catch (e1) { /* 单拍失败不影响下一拍 */ }
    }, every);
    if (broadcastTimer && broadcastTimer.unref) broadcastTimer.unref();
    logInfo("状态广播已启动 / telemetry broadcast started: " + every + "ms");
    return true;
  } catch (err) {
    logInfo("启动广播失败 / start broadcast failed: " + getErrText(err));
    broadcastTimer = null;
    return false;
  }
}

// 功能 11：停掉定时广播（重复调用安全）。
function stopBroadcast() {
  try {
    if (broadcastTimer) clearInterval(broadcastTimer);
    broadcastTimer = null;
    return true;
  } catch (e) { broadcastTimer = null; return false; }
}

// 对外导出：状态快照 / 事件监听 / 广播控制。
module.exports = {
  getBotState: getBotState,
  attach: attach,
  detach: detach,
  snapshotBots: snapshotBots,
  startBroadcast: startBroadcast,
  stopBroadcast: stopBroadcast,
  broadcastNow: broadcastNow,
  setSink: setSink,
  recentEvents: recentEvents,
  handleHurt: handleHurt,
  handleBlockChange: handleBlockChange,
  isSelfEntity: isSelfEntity,
  isUnderAttack: isUnderAttack,
  MAX_EVENTS: MAX_EVENTS,
  BROADCAST_MS: BROADCAST_MS
};
