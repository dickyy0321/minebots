// ========================================
// 文件：modules/radar.js
// 功能：2D 雷达数据源——扫描机器人周围 64 格实体，分类玩家 / 怪物 / 掉落物
// 依赖：./logger（可选）；不联网、不加载 mineflayer
// 导出：scan / classify / snapshot / entitiesToRadar / isEnabled / RADAR_RADIUS / MAX_ENTITIES / TYPES
// 作者：MineBots
// ========================================
//
// 与旧小地图的关系 / relation to the old minimap
//   modules/telemetry.js 的 nearby 仍保持 16 格 / 8 个（既有自测依赖它，绝不动）。
//   本模块独立提供 64 格全量扫描，作为 Canvas 2D 雷达的输入。
// CommonJS，ES5 风格，无中文变量名

// 可选依赖：日志核心，高频扫描只落文件，缺失时静默。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
// 可选依赖：引擎控制中心（专家模式可关雷达 / 调范围）；缺失时默认全开，保持旧行为。
var engineControl = null;
try { engineControl = require("./engine-control"); } catch (e) { engineControl = null; }

// 常量：雷达半径（格）/ 单次最多返回实体数 / 实体分类表。
var RADAR_RADIUS = 64;
var MAX_ENTITIES = 256;
var TYPES = { PLAYER: "player", MOB: "mob", DROP: "drop", UNKNOWN: "unknown" };

// 状态：最近一次扫描结果，供 GUI 拉取与自测断言。
var lastSnapshot = { ok: false, enabled: true, radius: RADAR_RADIUS, entities: [], at: 0, scanned: 0 };

// 写信息日志：扫描属于高频信息，只落文件，绝不推 GUI。
function logInfo(message) {
  try { if (logger && typeof logger.info === "function") logger.info("[radar] " + message); } catch (e) { /* ignore */ }
}

// 把异常拍成一行文本，避免在 catch 里再次抛错。
function errText(err) {
  try { if (err && err.message) return String(err.message); return String(err); }
  catch (e) { return "unknown error"; }
}

// 安全转数字：不是合法数字就给兜底值。
function toNum(value, fallback) {
  try {
    var n = Number(value);
    return isNaN(n) || !isFinite(n) ? fallback : n;
  } catch (e) { return fallback; }
}

// 安全转字符串：null / undefined 统一成空串。
function toText(value) {
  try { return value === null || value === undefined ? "" : String(value); }
  catch (e) { return ""; }
}

// 功能：判定一个实体属于玩家 / 怪物 / 掉落物 / 未知，读不出时返回 unknown。
function classify(ent) {
  try {
    if (!ent || typeof ent !== "object") return TYPES.UNKNOWN;
    if (ent.type === "player" || ent.username) return TYPES.PLAYER;
    var name = toText(ent.name || ent.displayName).toLowerCase();
    if (ent.type === "object" || ent.objectType === "Item" || name === "item" || name === "item_stack" ||
        ent.kind === "drop" || ent.pickupTime !== undefined) return TYPES.DROP;
    if (ent.type === "mob" || ent.type === "hostile" || ent.type === "animal" ||
        ent.type === "monster" || ent.mobType || ent.isMob === true) return TYPES.MOB;
    // 未知模组实体也归到怪物：雷达上至少画出来，绝不因为认不出就丢掉。
    if (ent.type === "other" || ent.type === "unknown" || ent.type === "global") return TYPES.MOB;
    return TYPES.UNKNOWN;
  } catch (e) { return TYPES.UNKNOWN; }
}

// 功能：把实体列表转成雷达点数组（带相对坐标），非法输入返回空数组。
function entitiesToRadar(list, me, options) {
  var out = [];
  var opts = options && typeof options === "object" ? options : {};
  var radius = toNum(opts.radius, RADAR_RADIUS);
  if (radius < 1) radius = RADAR_RADIUS;
  if (radius > 256) radius = 256;
  var origin = me && typeof me === "object" ? me : { x: 0, y: 0, z: 0 };
  var ox = toNum(origin.x, 0), oy = toNum(origin.y, 0), oz = toNum(origin.z, 0);
  try {
    var items = Array.isArray(list) ? list : [];
    for (var i = 0; i < items.length && out.length < MAX_ENTITIES; i++) {
      var ent = items[i];
      if (!ent) continue;
      var p = ent.position || ent.pos || null;
      if (!p) continue;
      var dx = toNum(p.x, ox) - ox;
      var dy = toNum(p.y, oy) - oy;
      var dz = toNum(p.z, oz) - oz;
      var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > radius) continue;
      var kind = ent.kind || classify(ent);
      if (kind === TYPES.UNKNOWN) continue;
      out.push({
        type: kind,
        name: toText(ent.username || ent.name || ent.displayName || kind).slice(0, 40),
        dx: Math.round(dx * 10) / 10,
        dy: Math.round(dy * 10) / 10,
        dz: Math.round(dz * 10) / 10,
        distance: Math.round(dist * 10) / 10
      });
    }
    out.sort(function (a, b) { return a.distance - b.distance; });
  } catch (e) { logInfo("实体转换失败 / conversion failed: " + errText(e)); }
  return out;
}

// 功能：读引擎开关；控制中心缺失时按默认全开处理，读失败也保持开启。
function isEnabled() {
  try {
    if (engineControl && typeof engineControl.isEnabled === "function") return engineControl.isEnabled("radar") === true;
  } catch (e) { /* 读失败按开启 */ }
  return true;
}

// 功能：读专家面板配置的雷达半径；控制中心缺失或坏值退回 64 格。
function configuredRadius() {
  try {
    if (engineControl && typeof engineControl.param === "function") {
      var value = engineControl.param("radar", "radarRadius");
      if (value >= 1) return value;
    }
  } catch (e) { /* 读失败用常量 */ }
  return RADAR_RADIUS;
}

// 功能：扫描一个 mineflayer / 假 bot 周围 64 格；bot 空或引擎关闭时返回空盘（不推送任何数据）。
function scan(bot, options) {
  var opts = options && typeof options === "object" ? options : {};
  var radius = toNum(opts.radius, configuredRadius());
  if (radius < 1) radius = RADAR_RADIUS;
  var empty = { ok: false, enabled: true, radius: radius, entities: [], at: Date.now(), scanned: 0, counts: { player: 0, mob: 0, drop: 0 }, message: "bot not ready / 机器人未就绪" };
  try {
    // 专家面板把雷达关掉后：不扫、不记、不推，快照也同步清空。
    if (!isEnabled()) {
      var off = { ok: false, enabled: false, radius: radius, entities: [], at: Date.now(), scanned: 0,
        counts: { player: 0, mob: 0, drop: 0 }, message: "radar disabled / 雷达已关闭" };
      lastSnapshot = off;
      return off;
    }
    if (!bot || !bot.entities) { lastSnapshot = empty; return empty; }
    var me = bot.entity && bot.entity.position ? bot.entity.position : { x: 0, y: 0, z: 0 };
    var list = [];
    var keys = Object.keys(bot.entities);
    for (var i = 0; i < keys.length; i++) {
      var ent = bot.entities[keys[i]];
      if (!ent || (bot.entity && ent === bot.entity)) continue;
      list.push(ent);
    }
    var points = entitiesToRadar(list, me, { radius: radius });
    var counts = { player: 0, mob: 0, drop: 0 };
    for (var j = 0; j < points.length; j++) {
      if (counts[points[j].type] !== undefined) counts[points[j].type] = counts[points[j].type] + 1;
    }
    var snap = {
      ok: true, enabled: true, radius: radius, entities: points, at: Date.now(),
      scanned: keys.length, counts: counts,
      position: { x: Math.round(toNum(me.x, 0)), y: Math.round(toNum(me.y, 0)), z: Math.round(toNum(me.z, 0)) },
      message: "radar ok / 雷达扫描完成"
    };
    lastSnapshot = snap;
    logInfo("scan radius=" + radius + " total=" + keys.length + " drawn=" + points.length);
    return snap;
  } catch (e) {
    empty.message = errText(e);
    lastSnapshot = empty;
    return empty;
  }
}

// 功能：取最近一次扫描快照副本，没扫过返回空盘。
function snapshot() {
  try {
    return {
      ok: lastSnapshot.ok === true,
      enabled: lastSnapshot.enabled !== false,
      radius: lastSnapshot.radius,
      entities: lastSnapshot.entities.slice(0),
      at: lastSnapshot.at,
      scanned: lastSnapshot.scanned || 0,
      counts: lastSnapshot.counts || { player: 0, mob: 0, drop: 0 },
      message: lastSnapshot.message || ""
    };
  } catch (e) { return { ok: false, enabled: false, radius: RADAR_RADIUS, entities: [], at: 0, scanned: 0 }; }
}

// 对外导出：扫描 / 分类 / 快照 / 常量。
module.exports = {
  scan: scan,
  classify: classify,
  snapshot: snapshot,
  entitiesToRadar: entitiesToRadar,
  isEnabled: isEnabled,
  configuredRadius: configuredRadius,
  RADAR_RADIUS: RADAR_RADIUS,
  MAX_ENTITIES: MAX_ENTITIES,
  TYPES: TYPES
};
