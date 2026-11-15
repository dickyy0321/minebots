// ========================================
// 文件：modules/swarm-collision.js
// 功能：多 Bot 物理防碰撞——维护友军实时坐标，在寻路代价函数里给友军所在格加权，
//       目标点被友军占住时自动挑一个代价最低的绕行落点，并提供加权 A* 路线。
// 依赖：无外部依赖；./logger（可选）
// 导出：track / untrack / update / positions / costAt / avoidPoint / planRoute / stats / reset
// 作者：MineBots
// ========================================
// 说明：不改写 mineflayer-pathfinder 插件，只在 modules/pathfinding.js 下发目标前
//   做一次「绕行落点」修正；所有坐标来自内存假 bot 或真实 bot.entity，测试全离线。
// ES5 风格，CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

// 可选依赖：日志核心（只写文件，不推 GUI）。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
// 常量：安全半径 / 友军基础代价 / 绕行搜索圈 / A* 最大展开节点。
var SAFE_RADIUS = 2;
var FRIEND_COST = 12;
var SEARCH_RING = 3;
var MAX_NODES = 900;

// 运行时：botId → { id, bot, pos, at }；以及累计统计。
var friends = {};
var totals = { tracked: 0, updates: 0, shifts: 0, routes: 0 };

// 写普通日志：只落文件，不推 GUI。
function logInfo(text) {
  try { if (logger && typeof logger.info === "function") logger.info(text); } catch (e) { /* ignore */ }
}
// 安全取错误文本。
function errText(err) {
  try { if (!err) return "unknown error"; if (err.message) return String(err.message); return String(err); } catch (e) { return "unknown error"; }
}
// 安全转字符串。
function toText(v) {
  if (v === null || v === undefined) return "";
  try { return String(v).trim(); } catch (e) { return ""; }
}
// 安全取整。
function toInt(v, fallback) {
  var n = parseInt(v, 10);
  return isNaN(n) ? fallback : n;
}
// 从任意 bot 形状里读坐标；读不到返回 null。
function posOf(bot) {
  try {
    var p = bot && bot.entity && bot.entity.position ? bot.entity.position : (bot && bot.position ? bot.position : null);
    if (!p) return null;
    var x = Number(p.x), y = Number(p.y), z = Number(p.z);
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return null;
    return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
  } catch (e) { return null; }
}
// 功能 1：登记一个友军 bot（幂等，重复登记只更新引用）。
function track(bot, botId, options) {
  var out = { ok: false, botId: toText(botId) || "default", message: "" };
  try {
    if (!bot) { out.message = "bot not ready / 机器人未就绪"; return out; }
    var id = out.botId;
    friends[id] = { id: id, bot: bot, pos: posOf(bot) || { x: 0, y: 64, z: 0 }, at: Date.now() };
    totals.tracked = totals.tracked + 1;
    out.ok = true;
    out.message = "friend tracked / 友军坐标已登记";
    return out;
  } catch (e) { out.message = errText(e); return out; }
}
// 功能 2：摘掉一个友军（Bot 下线时调用）。
function untrack(botId) {
  var id = toText(botId) || "default";
  var had = Object.prototype.hasOwnProperty.call(friends, id);
  delete friends[id];
  return { ok: true, removed: had ? 1 : 0, botId: id, message: "friend untracked / 友军已摘除" };
}
// 功能 3：手动刷新某个友军坐标（假 bot / 外部注入用）。
function update(botId, pos, options) {
  var out = { ok: false, botId: toText(botId) || "default", message: "" };
  try {
    var id = out.botId;
    var p = pos && typeof pos === "object" ? pos : null;
    if (!p) { out.message = "position required / 缺少坐标"; return out; }
    if (!friends[id]) friends[id] = { id: id, bot: null, pos: { x: 0, y: 64, z: 0 }, at: 0 };
    friends[id].pos = { x: Math.floor(Number(p.x) || 0), y: Math.floor(Number(p.y) || 0), z: Math.floor(Number(p.z) || 0) };
    friends[id].at = Date.now();
    totals.updates = totals.updates + 1;
    out.ok = true;
    out.message = "position updated / 坐标已更新";
    return out;
  } catch (e) { out.message = errText(e); return out; }
}
// 功能 4：列出友军实时坐标；excludeId 用来排掉自己。
function positions(excludeId, options) {
  var out = [];
  try {
    var self = toText(excludeId).toLowerCase();
    for (var k in friends) {
      if (!Object.prototype.hasOwnProperty.call(friends, k)) continue;
      if (self.length > 0 && k.toLowerCase() === self) continue;
      var rec = friends[k];
      var fresh = rec.bot ? posOf(rec.bot) : null;
      if (fresh) rec.pos = fresh;
      out.push({ botId: rec.id, x: rec.pos.x, y: rec.pos.y, z: rec.pos.z, at: rec.at });
    }
  } catch (e) { return []; }
  return out;
}
// 功能 5：某格的友军代价权重——越近越贵，安全半径内最高。
function costAt(x, z, selfId, options) {
  var cost = 0;
  try {
    var list = positions(selfId, options);
    for (var i = 0; i < list.length; i++) {
      var d = Math.abs(list[i].x - x) + Math.abs(list[i].z - z);
      // 同格给硬代价（绕路一定比穿人便宜），相邻格只给轻微代价，远处不罚。
      if (d === 0) cost = cost + FRIEND_COST * 8;
      else if (d === 1) cost = cost + FRIEND_COST / 6;
      else if (d === 2) cost = cost + FRIEND_COST / 24;
    }
  } catch (e) { return 0; }
  return Math.round(cost * 100) / 100;
}
// 功能 6：目标点被友军占住时，挑一个加权代价最低的绕行落点。
function avoidPoint(bot, target, options) {
  var out = { ok: true, shifted: false, x: 0, y: 0, z: 0, cost: 0, originalCost: 0,
    selfId: "", message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var t = target && typeof target === "object" ? target : null;
    if (!t) { out.ok = false; out.message = "target required / 缺少目标"; return out; }
    var tx = Math.floor(Number(t.x) || 0), ty = Math.floor(Number(t.y) || 0), tz = Math.floor(Number(t.z) || 0);
    out.x = tx; out.y = ty; out.z = tz;
    var selfId = toText(opts.selfId) || toText(bot && bot.username) || "default";
    out.selfId = selfId;
    out.originalCost = costAt(tx, tz, selfId, opts);
    out.cost = out.originalCost;
    if (out.originalCost === 0) { out.message = "no friendly congestion / 目标点无友军"; return out; }
    var best = null;
    for (var dx = -SEARCH_RING; dx <= SEARCH_RING; dx++) {
      for (var dz = -SEARCH_RING; dz <= SEARCH_RING; dz++) {
        if (dx === 0 && dz === 0) continue;
        var c = costAt(tx + dx, tz + dz, selfId, opts) + (Math.abs(dx) + Math.abs(dz)) * 0.1;
        if (best === null || c < best.cost) best = { x: tx + dx, y: ty, z: tz + dz, cost: c };
      }
    }
    if (best && best.cost < out.originalCost) {
      out.shifted = true; out.x = best.x; out.y = best.y; out.z = best.z; out.cost = best.cost;
      totals.shifts = totals.shifts + 1;
      out.message = "route shifted around friend / 已绕开友军占位";
      logInfo("[swarm-collision] " + selfId + " shift to " + best.x + "," + best.y + "," + best.z);
    } else out.message = "no cheaper detour / 无更优绕行点";
    return out;
  } catch (e) { out.ok = false; out.message = errText(e); return out; }
}
// 功能 7：加权 A* 路线——每走一格付 1 + 友军代价，友军密集处自然绕开。
function planRoute(from, to, options) {
  var out = { ok: false, path: [], cost: 0, nodes: 0, message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    if (!from || !to) { out.message = "from/to required / 缺少起终点"; return out; }
    var selfId = toText(opts.selfId) || "default";
    var sx = Math.floor(Number(from.x) || 0), sz = Math.floor(Number(from.z) || 0);
    var tx = Math.floor(Number(to.x) || 0), tz = Math.floor(Number(to.z) || 0);
    var blocked = opts.blocked && typeof opts.blocked === "object" ? opts.blocked : {};
    function key(x, z) { return x + ":" + z; }
    function h(x, z) { return Math.abs(x - tx) + Math.abs(z - tz); }
    var open = [{ x: sx, z: sz, g: 0, f: h(sx, sz), parent: null }];
    var best = {}; best[key(sx, sz)] = 0;
    var closed = {};
    var guard = 0;
    while (open.length > 0 && guard < MAX_NODES) {
      guard = guard + 1;
      var pick = 0;
      for (var p = 1; p < open.length; p++) if (open[p].f < open[pick].f) pick = p;
      var cur = open.splice(pick, 1)[0];
      var ck = key(cur.x, cur.z);
      if (closed[ck]) continue;
      closed[ck] = true;
      if (cur.x === tx && cur.z === tz) {
        var node = cur;
        while (node) { out.path.push({ x: node.x, z: node.z }); node = node.parent; }
        out.path.reverse();
        out.cost = cur.g;
        out.ok = true;
        out.message = "weighted route found / 加权路线已生成";
        break;
      }
      var steps = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (var s = 0; s < steps.length; s++) {
        var nx = cur.x + steps[s][0], nz = cur.z + steps[s][1];
        var nk = key(nx, nz);
        if (blocked[nk] === true || closed[nk]) continue;
        var ng = cur.g + 1 + costAt(nx, nz, selfId, opts);
        if (best[nk] !== undefined && best[nk] <= ng) continue;
        best[nk] = ng;
        open.push({ x: nx, z: nz, g: ng, f: ng + h(nx, nz), parent: cur });
      }
    }
    out.nodes = guard;
    totals.routes = totals.routes + 1;
    if (!out.ok) out.message = "no route / 未找到路线";
    return out;
  } catch (e) { out.message = errText(e); return out; }
}
// 功能 8：统计快照。
function stats() {
  return { ok: true, friends: positions("", {}).length, ids: (function () {
      var a = []; var p = positions("", {});
      for (var i = 0; i < p.length; i++) a.push(p[i].botId);
      return a;
    })(), tracked: totals.tracked, updates: totals.updates, shifts: totals.shifts,
    routes: totals.routes, safeRadius: SAFE_RADIUS, friendCost: FRIEND_COST };
}
// 功能 9：复位全部友军与统计。
function reset() {
  friends = {};
  totals = { tracked: 0, updates: 0, shifts: 0, routes: 0 };
  return { ok: true, message: "swarm collision reset / 防碰撞已复位" };
}
// 对外导出。
module.exports = {
  track: track, untrack: untrack, update: update, positions: positions,
  costAt: costAt, avoidPoint: avoidPoint, planRoute: planRoute,
  stats: stats, reset: reset,
  SAFE_RADIUS: SAFE_RADIUS, FRIEND_COST: FRIEND_COST
};
