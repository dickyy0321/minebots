// ========================================
// 文件：modules/builder-patrol.js
// 功能：防熊孩子巡检——定时绕建筑一圈，逐格对比原始蓝图，发现被炸 / 被改的方块立刻补上并双语报警。
// 依赖：./logger（可选）、./shared-board（可选，缺失时只写内存）
// 导出：start / stop / inspect / repair / waypoints / stats / reset / DEFAULT_INTERVAL_MS
// 作者：MineBots
// ========================================
// 说明：周期定时器一律 unref；真实 bot 的 blockAt 通过 options.bot 注入，
//   自测用内存假世界离线跑，绝不联网、不碰真实存档。
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

// 可选依赖：日志与黑板。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
var board = null;
try { board = require("./shared-board"); } catch (e) { board = null; }
// 常量：默认巡检间隔 / 领地路点数 / 单次最多修复块数 / 双语报警文案。
var DEFAULT_INTERVAL_MS = 15000;
var WAYPOINTS = 4;
var MAX_REPAIR = 200;
var ALERT_ZH = "检测到建筑被破坏，已自动补上 / Damage detected, blocks restored: ";
// 运行时：每个建筑的巡检会话与统计。
var sessions = {};
var totals = { starts: 0, inspections: 0, damaged: 0, repaired: 0, alerts: 0 };

// 写普通日志：只落文件，不推 GUI。
function logInfo(text) {
  try { if (logger && typeof logger.info === "function") logger.info(text); } catch (e) { /* ignore */ }
}
// 取错误文本，catch 里绝不再次抛错。
function errText(err) {
  try { if (!err) return "unknown error"; if (err.message) return String(err.message); return String(err); } catch (e) { return "unknown error"; }
}
// 安全转字符串：null / undefined 归一成空串。
function toText(value) {
  try { if (value === null || value === undefined) return ""; return String(value); } catch (e) { return ""; }
}
// 取（或新建）会话。
function sessionOf(id) {
  var key = toText(id) || "default";
  if (!sessions[key]) sessions[key] = { id: key, timer: null, blueprint: [], options: {}, running: false,
    inspections: 0, damaged: 0, repaired: 0, alerts: 0, lastDiff: [] };
  return sessions[key];
}
// 从蓝图对象里取方块表。
function blocksOf(blueprint) {
  if (Array.isArray(blueprint)) return blueprint;
  if (blueprint && Array.isArray(blueprint.blocks)) return blueprint.blocks;
  return [];
}
// 功能：生成绕建筑一圈的巡逻路点（四个角，向外扩 margin 格）。
function waypoints(blueprint, options) {
  var out = [];
  try {
    var opts = options && typeof options === "object" ? options : {};
    var blocks = blocksOf(blueprint);
    var margin = Number(opts.margin) > 0 ? Number(opts.margin) : 2;
    var minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, y = 64;
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i] || {};
      var x = Number(b.x) || 0, z = Number(b.z) || 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      y = Number(b.y) || y;
    }
    if (!isFinite(minX)) { minX = 0; maxX = 4; minZ = 0; maxZ = 4; }
    out.push({ x: minX - margin, y: y, z: minZ - margin });
    out.push({ x: maxX + margin, y: y, z: minZ - margin });
    out.push({ x: maxX + margin, y: y, z: maxZ + margin });
    out.push({ x: minX - margin, y: y, z: maxZ + margin });
  } catch (e) { return out; }
  return out;
}
// 读某个坐标当前的方块名；bot 不可用或读失败返回空串（按「缺失」处理）。
function currentBlock(bot, one, origin) {
  try {
    if (!bot || typeof bot.blockAt !== "function") return "";
    var pos = { x: one.x + origin.x, y: one.y + origin.y, z: one.z + origin.z };
    var hit = bot.blockAt(pos);
    if (!hit) return "";
    return toText(hit.name || hit.block || "").replace(/^minecraft:/, "");
  } catch (e) { return ""; }
}
// 功能：对比原始蓝图与当前世界，返回 { ok, missing, wrong, checked, message }。
function inspect(id, options) {
  var out = { ok: true, missing: [], wrong: [], checked: 0, damaged: 0, message: "" };
  try {
    var st = sessionOf(id);
    var opts = options && typeof options === "object" ? options : {};
    var saved = st.options || {};
    var bot = opts.bot || saved.bot || null;
    var origin = opts.origin || saved.origin || { x: 0, y: 0, z: 0 };
    var blocks = Array.isArray(opts.blocks) ? opts.blocks : st.blueprint;
    for (var i = 0; i < blocks.length && i < MAX_REPAIR * 4; i++) {
      var one = blocks[i] || {};
      var want = toText(one.block || one.name).replace(/^minecraft:/, "");
      if (want.length === 0 || want === "air") continue;
      var got = currentBlock(bot, one, origin);
      out.checked = out.checked + 1;
      if (got.length === 0 || got === "air") out.missing.push({ x: one.x, y: one.y, z: one.z, block: want });
      else if (got !== want) out.wrong.push({ x: one.x, y: one.y, z: one.z, block: want, found: got });
    }
    out.damaged = out.missing.length + out.wrong.length;
    st.inspections = st.inspections + 1;
    st.lastDiff = out.missing.concat(out.wrong);
    st.damaged = st.damaged + out.damaged;
    totals.inspections = totals.inspections + 1;
    totals.damaged = totals.damaged + out.damaged;
    out.message = "inspection done / 巡检完成";
    if (out.damaged > 0) logInfo("[builder-patrol] damage / 发现破坏: " + out.damaged);
    return out;
  } catch (e) { return { ok: false, missing: [], wrong: [], checked: 0, damaged: 0, message: errText(e) }; }
}
// 功能：把被破坏的方块补上——生成补块任务、双语公屏报警、黑板记账；返回修复摘要。
function repair(id, options) {
  var out = { ok: true, repaired: 0, tasks: [], alert: "", message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var st = sessionOf(id);
    var diff = opts.diff || inspect(id, opts);
    var list = (diff.missing || []).concat(diff.wrong || []);
    var bot = opts.bot || (st.options && st.options.bot) || null;
    for (var i = 0; i < list.length && i < MAX_REPAIR; i++) {
      var d = list[i];
      out.tasks.push({ action: "place_block_exact", x: d.x, y: d.y, z: d.z, block: d.block,
        role: "patrol", reason: "grief repair / 防熊补块" });
    }
    out.repaired = out.tasks.length;
    if (out.repaired > 0) {
      out.alert = ALERT_ZH + out.repaired + " 块";
      try { if (bot && typeof bot.chat === "function") bot.chat(out.alert); } catch (eChat) { /* 公屏失败不影响修复 */ }
      try { if (board && typeof board.post === "function") board.post("patrol.repair:" + st.id, { at: Date.now(), count: out.repaired }); } catch (eBoard) { /* 黑板失败不影响修复 */ }
      st.repaired = st.repaired + out.repaired;
      st.alerts = st.alerts + 1;
      totals.repaired = totals.repaired + out.repaired;
      totals.alerts = totals.alerts + 1;
    }
    out.message = "repair planned / 补块任务已生成";
    return out;
  } catch (e) { return { ok: false, repaired: 0, tasks: [], alert: "", message: errText(e) }; }
}
// 功能：启动定时巡检（默认 15 秒一圈），定时器 unref，重复启动幂等。
function start(bot, blueprint, options) {
  var out = { ok: false, id: "", intervalMs: DEFAULT_INTERVAL_MS, running: false, message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var st = sessionOf(opts.id || "default");
    var blocks = blocksOf(blueprint);
    st.blueprint = blocks.slice(0);
    st.options = { bot: bot, origin: opts.origin || { x: 0, y: 0, z: 0 }, margin: opts.margin };
    out.id = st.id;
    out.intervalMs = Number(opts.intervalMs) > 0 ? Number(opts.intervalMs) : DEFAULT_INTERVAL_MS;
    if (st.running) { out.ok = true; out.running = true; out.message = "already running / 巡检已在运行"; return out; }
    st.running = true;
    if (opts.manual !== true) {
      st.timer = setInterval(function () {
        try {
          var diff = inspect(st.id, {});
          if (diff.damaged > 0) repair(st.id, { diff: diff });
        } catch (eTick) { /* 单拍失败不影响下一拍 */ }
      }, out.intervalMs);
      if (st.timer && typeof st.timer.unref === "function") st.timer.unref();
    }
    totals.starts = totals.starts + 1;
    out.ok = true;
    out.running = true;
    out.message = "patrol started / 防熊巡检已启动";
    logInfo("[builder-patrol] started / 巡检启动: " + st.id + " every " + out.intervalMs + "ms");
    return out;
  } catch (e) { out.message = errText(e); return out; }
}
// 功能：停止定时巡检，返回是否停掉了。
function stop(id) {
  try {
    var st = sessionOf(id);
    if (st.timer) clearInterval(st.timer);
    st.timer = null;
    st.running = false;
    return { ok: true, stopped: true, id: st.id };
  } catch (e) { return { ok: false, stopped: false, message: errText(e) }; }
}
// 功能：读统计快照（可传 id 看单个建筑）。
function stats(id) {
  var st = id ? sessionOf(id) : null;
  return { ok: true, id: st ? st.id : "all", running: st ? st.running : false,
    inspections: st ? st.inspections : totals.inspections,
    damaged: st ? st.damaged : totals.damaged,
    repaired: st ? st.repaired : totals.repaired,
    alerts: st ? st.alerts : totals.alerts,
    waypoints: WAYPOINTS, intervalMs: DEFAULT_INTERVAL_MS, sessions: Object.keys(sessions).length };
}
// 功能：复位全部会话、定时器与统计。
function reset() {
  try {
    for (var k in sessions) {
      if (!Object.prototype.hasOwnProperty.call(sessions, k)) continue;
      if (sessions[k].timer) clearInterval(sessions[k].timer);
    }
  } catch (e) { /* ignore */ }
  sessions = {};
  totals = { starts: 0, inspections: 0, damaged: 0, repaired: 0, alerts: 0 };
  return { ok: true, message: "builder patrol reset / 防熊巡检已复位" };
}
// 对外导出。
module.exports = {
  start: start, stop: stop, inspect: inspect, repair: repair,
  waypoints: waypoints, stats: stats, reset: reset,
  DEFAULT_INTERVAL_MS: DEFAULT_INTERVAL_MS, WAYPOINTS: WAYPOINTS
};
