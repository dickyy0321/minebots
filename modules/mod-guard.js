// ========================================
// 文件：modules/mod-guard.js
// 功能：未知模组实体 / 物品的终极兜底——认不出就归类 unknown_entity / 未知模组物品，遇袭只告警不崩
// 依赖：./logger（可选）、./telemetry（可选）、minecraft-data（可选），全部失败不崩
// 导出：attach / detach / onEntitySpawn / onEntityHurt / classifyEntity / isKnownEntity /
//       itemLabel / labelItems / getStats，常量 UNKNOWN_ENTITY_LABEL / UNKNOWN_ITEM_LABEL
// 作者：MineBots
// ========================================
//
// 约定：高频信息（每个实体出生都一样）只走 logger.info 落文件；只有「被未知实体攻击」才 warn 推 GUI。

// 可选依赖：日志核心，缺失时退回 console / 静默。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
// 可选依赖：遥测（它自己已经会推 bot_under_attack 警报），缺失时由本模块补一次告警。
var telemetry = null;
try { telemetry = require("./telemetry"); } catch (e) { telemetry = null; }

// 常量：未知实体的归类名（写日志 / 事件里统一用这个，程序好判断）。
var UNKNOWN_ENTITY_LABEL = "unknown_entity";
// 常量：未知物品显示文案（中英双语，GUI 直接展示）。
var UNKNOWN_ITEM_LABEL = "未知模组物品 / unknown mod item";
// 常量：每个 bot 最多记多少个未知名字，防止长期挂机把内存吃满。
var MAX_NAMES = 40;
// 常量：原版实体兜底表——拿不到 registry 也拿不到 minecraft-data 时靠它挡最常见的那批。
var VANILLA_ENTITIES = {
  "player": true, "item": true, "experience_orb": true, "arrow": true, "zombie": true, "skeleton": true,
  "creeper": true, "spider": true, "enderman": true, "slime": true, "witch": true, "villager": true,
  "cow": true, "pig": true, "sheep": true, "chicken": true, "horse": true, "wolf": true, "cat": true,
  "bat": true, "squid": true, "cod": true, "salmon": true, "bee": true, "boat": true, "minecart": true,
  "armor_stand": true, "item_frame": true, "falling_block": true, "tnt": true, "firework_rocket": true
};

// 内部状态：每个 bot 一份统计 { entities, items, attacks, seen }，键是机器人编号。
var botStates = {};
// 内部状态：minecraft-data 缓存 { key, data }，按版本只查一次。
var dataCache = { key: null, data: null };

// 写普通信息日志：只落文件（实体出生这种高频信息绝不刷 GUI）。
function logInfo(message) {
  try { if (logger && typeof logger.info === "function") logger.info(message); } catch (e) { /* ignore */ }
}

// 写警告日志：优先 logger.warn（推 GUI），缺 logger 时退回 console。
function logWarn(message) {
  try {
    if (logger && typeof logger.warn === "function") { logger.warn(message); return; }
    console.warn(message);
  } catch (e) { /* ignore */ }
}

// 安全提取错误文本，catch 里绝不二次抛错。
function errText(err) {
  try {
    if (!err) return "unknown error / 未知错误";
    if (typeof err === "string") return err;
    if (err.message) return String(err.message);
    return String(err);
  } catch (e) { return "unknown error / 未知错误"; }
}

// 转文本（null / undefined → 空串）。
function toText(value) {
  try {
    if (value === null || value === undefined) return "";
    return String(value);
  } catch (e) { return ""; }
}

// 取某个版本的原版数据表（只读一次，按版本缓存）；取不到返回 null。
function dataOf(version) {
  var ver = toText(version);
  if (ver.length === 0) return null;
  if (dataCache.key === ver) return dataCache.data;
  var data = null;
  try {
    var mcData = require("minecraft-data");
    data = mcData(ver) || null;
  } catch (e) { data = null; }
  dataCache.key = ver;
  dataCache.data = data;
  return data;
}

// 取名字的命名空间（create:tree → create；unprefixed → 空串）。
function namespaceOf(name) {
  var text = toText(name).toLowerCase();
  var cut = text.indexOf(":");
  if (cut <= 0) return "";
  return text.slice(0, cut);
}

// 判断名字是不是模组命名空间（有命名空间且不是 minecraft）。
function isModName(name) {
  var ns = namespaceOf(name);
  return ns.length > 0 && ns !== "minecraft";
}

// 取实体的可读名字：name → displayName → type → objectType → username，全没有就空串。
function entityName(entity) {
  try {
    if (!entity) return "";
    var keys = ["name", "displayName", "type", "objectType", "username"];
    for (var i = 0; i < keys.length; i++) {
      var text = toText(entity[keys[i]]);
      if (text.length > 0 && text !== "undefined") return text;
    }
  } catch (e) { /* 返回空串 */ }
  return "";
}

// 判断实体名是否认识：registry → minecraft-data → 原版兜底表三级判定，都不中就当未知。
function isKnownEntity(bot, name) {
  var text = toText(name);
  if (text.length === 0) return false;
  try {
    var registry = bot ? bot.registry : null;
    if (registry && registry.entitiesByName && registry.entitiesByName[text]) return true;
  } catch (e1) { /* 往下看数据表 */ }
  try {
    var data = dataOf(bot ? bot.version : "");
    if (data && data.entitiesByName && data.entitiesByName[text]) return true;
  } catch (e2) { /* 再看兜底表 */ }
  if (VANILLA_ENTITIES[text.toLowerCase()] === true) return true;
  return false;
}

// 判断物品名是否认识：minecraft: 前缀直接算认识，再看 registry / 数据表。
function isKnownItem(bot, name) {
  var text = toText(name);
  if (text.length === 0) return false;
  var ns = namespaceOf(text);
  if (ns === "minecraft") return true;
  try {
    var registry = bot ? bot.registry : null;
    if (registry && registry.itemsByName && registry.itemsByName[text]) return true;
  } catch (e1) { /* 往下看数据表 */ }
  try {
    var data = dataOf(bot ? bot.version : "");
    if (data && data.itemsByName && data.itemsByName[text]) return true;
  } catch (e2) { /* 认不出就当未知 */ }
  return false;
}

// 物品标签：认识的给原名，认不出的统一显示「未知模组物品 / unknown mod item」，绝不抛错。
function itemLabel(bot, name) {
  var text = toText(name);
  if (text.length === 0) return UNKNOWN_ITEM_LABEL;
  try { return isKnownItem(bot, text) ? text : UNKNOWN_ITEM_LABEL; } catch (e) { return UNKNOWN_ITEM_LABEL; }
}

// 背包兜底：把 [{ name, count }] 补成 [{ name, count, label, unknown }]；传什么都返回数组。
function labelItems(bot, items) {
  var out = [];
  try {
    if (!items || typeof items.length !== "number") return out;
    for (var i = 0; i < items.length; i++) {
      var row = items[i] || {};
      var name = toText(row.name);
      var label = itemLabel(bot, name);
      out.push({ name: name, count: Number(row.count) || 0, label: label, unknown: label !== name });
    }
  } catch (e) { return out; }
  return out;
}

// 名字是不是纯数字（mineflayer 对认不出的实体常给数字 type，这种等于没名字）。
function isNumericName(text) {
  try { return /^[0-9]+$/.test(toText(text)); } catch (e) { return false; }
}

// 实体兜底归类：返回 { ok, name, namespace, unknown, category }，任何异常都归成 unknown_entity。
function classifyEntity(bot, entity) {
  try {
    var raw = entityName(entity);
    var name = raw.length > 0 && !isNumericName(raw) ? raw : UNKNOWN_ENTITY_LABEL;
    var unknown = !isKnownEntity(bot, name);
    return {
      ok: true,
      name: name,
      namespace: namespaceOf(name),
      unknown: unknown,
      category: unknown ? UNKNOWN_ENTITY_LABEL : "known"
    };
  } catch (e) {
    return { ok: false, name: UNKNOWN_ENTITY_LABEL, namespace: "", unknown: true, category: UNKNOWN_ENTITY_LABEL };
  }
}

// 取某个 bot 的统计记录，没有就建一个（键为空时统一记在 "-" 上）。
function stateOf(botId) {
  var key = toText(botId);
  if (key.length === 0) key = "-";
  if (!botStates[key]) botStates[key] = { entities: {}, items: {}, attacks: 0, seen: {}, lastAt: 0 };
  return botStates[key];
}

// 记一个未知名字（同名字只记一次，超过 MAX_NAMES 不再增长）；返回是否是新名字。
function rememberName(record, table, name) {
  try {
    if (!record || !table || name.length === 0) return false;
    if (table[name] === true) return false;
    if (Object.keys(table).length >= MAX_NAMES) return false;
    table[name] = true;
    return true;
  } catch (e) { return false; }
}

// 把坐标拍成 "x,y,z" 文本，缺失返回 "?"。
function posText(pos) {
  try {
    if (!pos) return "?";
    return Math.floor(Number(pos.x)) + "," + Math.floor(Number(pos.y)) + "," + Math.floor(Number(pos.z));
  } catch (e) { return "?"; }
}

// 把坐标拍成 { x, y, z }；缺失返回 null。
function posJson(pos) {
  try {
    if (!pos) return null;
    var x = Number(pos.x), y = Number(pos.y), z = Number(pos.z);
    if (isNaN(x) || isNaN(y) || isNaN(z)) return null;
    return { x: Math.round(x), y: Math.round(y), z: Math.round(z) };
  } catch (e) { return null; }
}

// 实体出生兜底：认得出就放过，认不出就归类 unknown_entity 并记一次日志；绝不抛错。
function onEntitySpawn(bot, botId, entity) {
  try {
    if (!bot || !entity) return { ok: false, name: "", unknown: false, message: "no entity / 空实体" };
    if (bot.entity && entity === bot.entity) return { ok: true, name: "self", unknown: false, skipped: true };
    var info = classifyEntity(bot, entity);
    var record = stateOf(botId);
    record.lastAt = Date.now();
    if (!info.unknown) return { ok: true, name: info.name, namespace: info.namespace, unknown: false, category: "known" };
    // 未知实体：打上标记，同名字只写一条日志（高频 → 只落文件，不刷 GUI）。
    try { entity._mbUnknown = true; entity._mbCategory = UNKNOWN_ENTITY_LABEL; } catch (e1) { /* 标记失败也继续 */ }
    var first = rememberName(record, record.entities, info.name);
    if (first) logInfo("[" + toText(botId) + "] 未知模组实体，已归类 " + UNKNOWN_ENTITY_LABEL + " / unknown mod entity: " + info.name + " @ " + posText(entity.position));
    return { ok: true, name: info.name, namespace: info.namespace, unknown: true, category: UNKNOWN_ENTITY_LABEL, first: first };
  } catch (e) {
    return { ok: false, name: UNKNOWN_ENTITY_LABEL, unknown: true, category: UNKNOWN_ENTITY_LABEL, message: errText(e) };
  }
}

// 挨打兜底：打自己的是未知实体就告警；遥测没挂时顺带补一条 bot_under_attack（不重复推）。
function onEntityHurt(bot, botId, entity, source) {
  try {
    if (!bot || !bot.entity) return null;
    // entityHurt 对所有实体触发：挨打的不是自己就不算「遇袭」。
    // 只有「被打的是机器人自己」才算遇袭；别人打架一概不报（判定：对象同一性 + entityId 双保险）。
    var mine = true;
    if (telemetry && typeof telemetry.isUnderAttack === "function") mine = telemetry.isUnderAttack(bot, entity) === true;
    else mine = (entity === bot.entity);
    if (!mine) return null;
    var info = classifyEntity(bot, source);
    var record = stateOf(botId);
    record.attacks = (Number(record.attacks) || 0) + 1;
    record.lastAt = Date.now();
    var event = {
      type: "bot_under_attack", at: Date.now(), botId: toText(botId),
      attackerName: info.name, unknown: info.unknown, category: info.category,
      attacker: posJson(source ? source.position : null)
    };
    if (info.unknown) {
      logWarn("[" + toText(botId) + "] 遭遇未知模组实体攻击 / attacked by unknown mod entity: " + info.name + " @ " + posText(source ? source.position : null));
      rememberName(record, record.entities, info.name);
    }
    // 遥测已挂的话它自己会推 bot_under_attack，这里只补那份「未知实体」日志，避免同一个事件推两条。
    var attached = false;
    try { attached = !!(bot._mbTelemetry && typeof bot._mbTelemetry.onHurt === "function"); } catch (e1) { attached = false; }
    if (!attached && telemetry && typeof telemetry.handleHurt === "function") {
      try { telemetry.handleHurt(bot, bot.entity, source || null); }
      catch (e2) { logInfo("[" + toText(botId) + "] 遇袭告警推送失败 / alert push failed: " + errText(e2)); }
    }
    return event;
  } catch (e) { return null; }
}

// 挂载兜底监听：entitySpawn + entityHurt（bot 断开自动摘掉）；已挂过直接回 true，失败回 false。
function attach(bot, botId) {
  try {
    if (!bot || typeof bot.on !== "function") return false;
    if (bot._mbModGuard) return true;
    var id = toText(botId).length > 0 ? toText(botId) : (toText(bot.username).length > 0 ? toText(bot.username) : "?");
    stateOf(id);
    var onSpawn = function (entity) { try { onEntitySpawn(bot, id, entity); } catch (e1) { /* 单个实体失败不影响别的 */ } };
    var onHurt = function (entity, source) { try { onEntityHurt(bot, id, entity, source); } catch (e2) { /* ignore */ } };
    var onEnd = function () { try { detach(bot); } catch (e3) { /* ignore */ } };
    bot.on("entitySpawn", onSpawn);
    bot.on("entityHurt", onHurt);
    bot.on("end", onEnd);
    bot.on("kicked", onEnd);
    bot._mbModGuard = { botId: id, onSpawn: onSpawn, onHurt: onHurt, onEnd: onEnd };
    return true;
  } catch (e) { return false; }
}

// 摘掉兜底监听（断线 / 停止时调用）；没挂过也安全返回 false。
function detach(bot) {
  try {
    if (!bot || !bot._mbModGuard) return false;
    var state = bot._mbModGuard;
    if (typeof bot.removeListener === "function") {
      if (state.onSpawn) bot.removeListener("entitySpawn", state.onSpawn);
      if (state.onHurt) bot.removeListener("entityHurt", state.onHurt);
      if (state.onEnd) {
        bot.removeListener("end", state.onEnd);
        bot.removeListener("kicked", state.onEnd);
      }
    }
    bot._mbModGuard = null;
    return true;
  } catch (e) { return false; }
}

// 取统计：{ ok, unknownEntities, unknownItems, attacks }，没有记录就是全 0。
function getStats(botId) {
  try {
    var record = stateOf(botId);
    return {
      ok: true,
      unknownEntities: Object.keys(record.entities).length,
      unknownItems: Object.keys(record.items).length,
      attacks: Number(record.attacks) || 0
    };
  } catch (e) {
    return { ok: false, unknownEntities: 0, unknownItems: 0, attacks: 0 };
  }
}

// 对外导出：挂 / 摘、实体与物品兜底、统计与常量。
module.exports = {
  attach: attach,
  detach: detach,
  onEntitySpawn: onEntitySpawn,
  onEntityHurt: onEntityHurt,
  classifyEntity: classifyEntity,
  isKnownEntity: isKnownEntity,
  isKnownItem: isKnownItem,
  itemLabel: itemLabel,
  labelItems: labelItems,
  getStats: getStats,
  UNKNOWN_ENTITY_LABEL: UNKNOWN_ENTITY_LABEL,
  UNKNOWN_ITEM_LABEL: UNKNOWN_ITEM_LABEL
};
