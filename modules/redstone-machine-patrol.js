// ========================================
// 文件：modules/redstone-machine-patrol.js
// 功能：红石机器巡检——Bot 自动拉杆启动机器、定时绕机器巡逻，
//       发现漏斗溢出或掉落物漏出立刻中英双语报警并记黑板。
// 依赖：./logger（可选）、./shared-board（可选）、./redstone-safety（可选，读取降频状态）
// 导出：start / stop / startMachine / inspect / patrolTick / alert / stats / reset / DEFAULT_INTERVAL_MS
// 作者：MineBots
// ========================================
// 说明：周期定时器一律 unref；真实 bot 只通过 options 注入，自测用内存假世界离线跑。
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

// 可选依赖：日志与黑板。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
var board = null;
try { board = require("./shared-board"); } catch (e) { board = null; }
// 可选依赖：安全阀门（读取当前是否降频，只做展示不做控制）。
var safety = null;
try { safety = require("./redstone-safety"); } catch (e) { safety = null; }
// 常量：默认巡检间隔 / 漏斗容量阈值 / 掉落物报警阈值 / 报警文案。
var DEFAULT_INTERVAL_MS = 5000;
var HOPPER_FULL = 5;
var DROPPED_ITEM_LIMIT = 3;
var ALERT_OVERFLOW = "漏斗溢出，请检查机器 / Hopper overflow, please check the machine";
var ALERT_LEAK = "检测到掉落物漏出 / Loose items detected outside the machine";
// 运行时：每台机器的会话与统计。
var sessions = {};
var totals = { starts: 0, leverPulls: 0, ticks: 0, overflow: 0, leaks: 0, alerts: 0 };

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
  if (!sessions[key]) sessions[key] = { id: key, bot: null, options: {}, timer: null, running: false,
    leverPulls: 0, ticks: 0, overflow: 0, leaks: 0, alerts: 0, lastAlerts: [] };
  return sessions[key];
}
// 功能：自动拉杆启动机器——优先 activateBlock，其次 activateItem，全部留痕。
function startMachine(botId, options) {
  var out = { ok: false, action: "none", message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var st = sessionOf(botId);
    var bot = opts.bot || st.bot || null;
    if (!bot) { out.message = "bot not ready / 机器人未就绪"; return out; }
    var lever = opts.lever || { x: 0, y: 64, z: 0 };
    if (typeof bot.activateBlock === "function") { bot.activateBlock(lever); out.action = "activateBlock"; }
    else if (typeof bot.activateItem === "function") { bot.activateItem(true); out.action = "activateItem"; }
    else { out.message = "no lever API / 没有拉杆接口"; return out; }
    st.leverPulls = st.leverPulls + 1;
    totals.leverPulls = totals.leverPulls + 1;
    out.ok = true;
    out.message = "machine started / 机器已拉杆启动";
    logInfo("[machine-patrol] lever pulled / 已拉杆启动机器: " + st.id);
    return out;
  } catch (e) { out.message = errText(e); return out; }
}
// 统计漏斗里的物品数（兼容 items 数组 / count 字段 / container 对象）。
function hopperCount(hopper) {
  try {
    var h = hopper || {};
    if (Array.isArray(h.items)) return h.items.length;
    if (typeof h.count === "number") return h.count;
    if (h.container && Array.isArray(h.container.items)) return h.container.items.length;
  } catch (e) { return 0; }
  return 0;
}
// 统计漏出的掉落物实体（名字含 item / drop / 带 position）。
function droppedCount(bot, options) {
  var n = 0;
  try {
    var opts = options && typeof options === "object" ? options : {};
    var ents = opts.entities || (bot && bot.entities) || {};
    var list = [];
    if (Array.isArray(ents)) list = ents;
    else for (var k in ents) { if (Object.prototype.hasOwnProperty.call(ents, k)) list.push(ents[k]); }
    for (var i = 0; i < list.length; i++) {
      var e = list[i] || {};
      var name = toText(e.name || e.type || "").toLowerCase();
      if (name.indexOf("item") >= 0 || name.indexOf("drop") >= 0 || e.isDropped === true) n = n + 1;
    }
  } catch (e) { return n; }
  return n;
}
// 功能：发一条双语报警——公屏 bot.chat + 黑板记录 + 内存留痕，绝不抛错。
function alert(botId, kind, detail, options) {
  var out = { ok: true, kind: kind, text: "", message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var st = sessionOf(botId);
    var bot = opts.bot || st.bot || null;
    var prefix = kind === "overflow" ? ALERT_OVERFLOW : ALERT_LEAK;
    out.text = prefix + "（" + toText(detail) + " / count=" + toText(opts.count) + "）";
    try { if (bot && typeof bot.chat === "function") bot.chat(out.text); } catch (eChat) { /* 公屏失败继续记账 */ }
    try { if (board && typeof board.post === "function") board.post("machine.alert:" + st.id, { kind: kind, at: Date.now(), count: opts.count }); } catch (eBoard) { /* 黑板失败继续 */ }
    st.lastAlerts.push({ kind: kind, text: out.text, at: Date.now() });
    if (st.lastAlerts.length > 20) st.lastAlerts.shift();
    st.alerts = st.alerts + 1;
    totals.alerts = totals.alerts + 1;
    if (kind === "overflow") { st.overflow = st.overflow + 1; totals.overflow = totals.overflow + 1; }
    else { st.leaks = st.leaks + 1; totals.leaks = totals.leaks + 1; }
    out.message = "alert sent / 报警已发出";
    return out;
  } catch (e) { return { ok: false, kind: kind, text: "", message: errText(e) }; }
}
// 功能：巡检一拍——检查漏斗溢出与掉落物漏出，返回 { ok, overflow, leaks, alerts }。
function inspect(botId, options) {
  var out = { ok: true, overflow: 0, leaks: 0, alerts: 0, throttled: false, message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var st = sessionOf(botId);
    var saved = st.options || {};
    var bot = opts.bot || saved.bot || null;
    var hoppers = opts.hoppers || saved.hoppers || [];
    var fullAt = Number(opts.hopperFull) > 0 ? Number(opts.hopperFull) :
      (Number(saved.hopperFull) > 0 ? Number(saved.hopperFull) : HOPPER_FULL);
    var leakAt = Number(opts.dropLimit) > 0 ? Number(opts.dropLimit) :
      (Number(saved.dropLimit) > 0 ? Number(saved.dropLimit) : DROPPED_ITEM_LIMIT);
    out.throttled = !!(safety && typeof safety.stats === "function" && safety.stats().throttled === true);
    for (var i = 0; i < hoppers.length; i++) {
      var count = hopperCount(hoppers[i]);
      if (count >= fullAt) {
        out.overflow = out.overflow + 1;
        alert(botId, "overflow", "hopper " + i, { bot: bot, count: count });
        out.alerts = out.alerts + 1;
      }
    }
    var drops = droppedCount(bot, opts);
    if (drops >= leakAt) {
      out.leaks = 1;
      alert(botId, "leak", "loose items", { bot: bot, count: drops });
      out.alerts = out.alerts + 1;
    }
    out.message = "inspection done / 机器巡检完成";
    return out;
  } catch (e) { return { ok: false, overflow: 0, leaks: 0, alerts: 0, throttled: false, message: errText(e) }; }
}
// 功能：巡逻一拍（定时器回调入口），额外累加 ticks 计数。
function patrolTick(botId, options) {
  try {
    var st = sessionOf(botId);
    st.ticks = st.ticks + 1;
    totals.ticks = totals.ticks + 1;
    return inspect(botId, options);
  } catch (e) { return { ok: false, message: errText(e) }; }
}
// 功能：启动机器巡检——先拉杆启动，再挂周期定时器（unref），重复启动幂等。
function start(bot, botId, options) {
  var out = { ok: false, id: "", intervalMs: DEFAULT_INTERVAL_MS, lever: null, running: false, message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var st = sessionOf(botId);
    st.bot = bot || st.bot;
    st.options = { bot: st.bot, hoppers: opts.hoppers || [], hopperFull: opts.hopperFull,
      dropLimit: opts.dropLimit, lever: opts.lever };
    out.id = st.id;
    out.intervalMs = Number(opts.intervalMs) > 0 ? Number(opts.intervalMs) : DEFAULT_INTERVAL_MS;
    if (opts.startMachine !== false) out.lever = startMachine(st.id, { bot: st.bot, lever: opts.lever });
    if (st.running) { out.ok = true; out.running = true; out.message = "already running / 巡检已在运行"; return out; }
    st.running = true;
    if (opts.manual !== true) {
      st.timer = setInterval(function () {
        try { patrolTick(st.id, {}); } catch (eTick) { /* 单拍失败不影响下一拍 */ }
      }, out.intervalMs);
      if (st.timer && typeof st.timer.unref === "function") st.timer.unref();
    }
    totals.starts = totals.starts + 1;
    out.ok = true;
    out.running = true;
    out.message = "machine patrol started / 机器巡检已启动";
    return out;
  } catch (e) { out.message = errText(e); return out; }
}
// 功能：停止巡检，清掉定时器。
function stop(botId) {
  try {
    var st = sessionOf(botId);
    if (st.timer) clearInterval(st.timer);
    st.timer = null;
    st.running = false;
    return { ok: true, stopped: true, id: st.id };
  } catch (e) { return { ok: false, stopped: false, message: errText(e) }; }
}
// 功能：读统计快照。
function stats(botId) {
  var st = botId ? sessionOf(botId) : null;
  return { ok: true, id: st ? st.id : "all", running: st ? st.running : false,
    leverPulls: st ? st.leverPulls : totals.leverPulls,
    ticks: st ? st.ticks : totals.ticks,
    overflow: st ? st.overflow : totals.overflow,
    leaks: st ? st.leaks : totals.leaks,
    alerts: st ? st.alerts : totals.alerts,
    lastAlerts: st ? st.lastAlerts.slice(-3) : [],
    intervalMs: DEFAULT_INTERVAL_MS, hopperFull: HOPPER_FULL, dropLimit: DROPPED_ITEM_LIMIT };
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
  totals = { starts: 0, leverPulls: 0, ticks: 0, overflow: 0, leaks: 0, alerts: 0 };
  return { ok: true, message: "machine patrol reset / 机器巡检已复位" };
}
// 对外导出。
module.exports = {
  start: start, stop: stop, startMachine: startMachine, inspect: inspect,
  patrolTick: patrolTick, alert: alert, stats: stats, reset: reset,
  DEFAULT_INTERVAL_MS: DEFAULT_INTERVAL_MS
};
