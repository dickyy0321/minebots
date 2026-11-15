// ========================================
// 文件：modules/ghost-anticheat.js
// 功能：幽灵反作弊巡检——Bot 常驻服务器，按拍采样玩家位移 / 挖掘频率 / 实体堆积，
//       发现移速异常、自动挖矿、恶意卡服时生成截图证据并双语上报管理员（服主）。
// 依赖：./logger、./event-bus、./external-bridge（均可选）
// 导出：start / stop / sample / inspect / capture / report / stats / reset / DEFAULT_INTERVAL_MS
// 作者：MineBots
// ========================================
// 说明：截图走 bot 的可选 screenshot / takeScreenshot 接口；没有接口时产出结构化证据快照，
//   绝不假装截了图。周期定时器一律 unref；真实 bot 只通过 options 注入，自测全离线。
// ES5 风格，CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

// 可选依赖：日志 / 事件总线 / 外部桥接（把告警推到 QQ / Discord 群）。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
var bus = null;
try { bus = require("./event-bus"); } catch (e) { bus = null; }
var bridge = null;
try { bridge = require("./external-bridge"); } catch (e) { bridge = null; }
// 常量：默认巡检间隔 / 各类阈值 / 双语上报文案。
var DEFAULT_INTERVAL_MS = 1000;
var SPEED_LIMIT = 12;
var AUTO_MINE_LIMIT = 8;
var LAG_ENTITY_LIMIT = 300;
var MAX_EVIDENCE = 24;
var ALERT_SPEED = "检测到移速异常 / Abnormal movement speed detected";
var ALERT_MINE = "检测到自动挖矿 / Automated mining detected";
var ALERT_LAG = "检测到恶意卡服 / Lag machine detected";

// 运行时：每个 bot 的会话、上一拍玩家坐标、证据列表与统计。
var sessions = {};
var totals = { samples: 0, violations: 0, reports: 0, screenshots: 0 };

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
// 取（或新建）会话。
function sessionOf(id) {
  var key = toText(id) || "default";
  if (!sessions[key]) sessions[key] = { id: key, bot: null, options: {}, timer: null,
    running: false, last: {}, evidence: [], samples: 0, violations: 0, reports: 0 };
  return sessions[key];
}
// 取三维坐标对象。
function pointOf(p) {
  try {
    var o = p && typeof p === "object" ? p : {};
    return { x: Number(o.x) || 0, y: Number(o.y) || 0, z: Number(o.z) || 0 };
  } catch (e) { return { x: 0, y: 0, z: 0 }; }
}
// 两点平面距离。
function distance(a, b) {
  var dx = a.x - b.x, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}
// 把 bot.players / 快照里的玩家统一成 [{ name, position }]。
function playersOf(bot, options) {
  var out = [];
  try {
    var opts = options && typeof options === "object" ? options : {};
    var src = opts.players || (bot && bot.players) || {};
    if (Array.isArray(src)) {
      for (var i = 0; i < src.length; i++) {
        var one = src[i] || {};
        out.push({ name: toText(one.name || one.username), position: pointOf(one.position || one.entity && one.entity.position) });
      }
      return out;
    }
    for (var k in src) {
      if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
      var rec = src[k] || {};
      out.push({ name: toText(k), position: pointOf(rec.position || (rec.entity && rec.entity.position)) });
    }
  } catch (e) { return []; }
  return out;
}
// 功能 1：启动巡检（manual:true 不挂定时器；周期模式定时器 unref）。
function start(bot, botId, options) {
  var out = { ok: false, botId: "", intervalMs: DEFAULT_INTERVAL_MS, running: false, message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var st = sessionOf(botId);
    st.bot = bot || st.bot;
    st.options = { bot: st.bot, admin: toText(opts.admin), players: opts.players };
    out.botId = st.id;
    out.intervalMs = Number(opts.intervalMs) > 0 ? Number(opts.intervalMs) : DEFAULT_INTERVAL_MS;
    if (st.running) { out.ok = true; out.running = true; out.message = "already running / 巡检已在运行"; return out; }
    st.running = true;
    if (opts.manual !== true) {
      st.timer = setInterval(function () {
        try { inspect(st.id, {}); } catch (eTick) { /* 单拍失败不影响下一拍 */ }
      }, out.intervalMs);
      if (st.timer && typeof st.timer.unref === "function") st.timer.unref();
    }
    out.ok = true; out.running = true;
    out.message = "ghost anticheat started / 幽灵巡检已启动";
    return out;
  } catch (e) { out.message = errText(e); return out; }
}
// 功能 2：停止巡检，清掉定时器。
function stop(botId) {
  try {
    var st = sessionOf(botId);
    if (st.timer) clearInterval(st.timer);
    st.timer = null; st.running = false;
    return { ok: true, stopped: true, botId: st.id, message: "ghost anticheat stopped / 巡检已停止" };
  } catch (e) { return { ok: false, stopped: false, message: errText(e) }; }
}
// 功能 3：一拍采样——比较上一拍坐标算移速，读挖矿计数与实体数。
function sample(botId, snapshot, options) {
  var out = { ok: true, botId: toText(botId) || "default", at: Date.now(),
    speed: 0, violations: [], message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var st = sessionOf(out.botId);
    var snap = snapshot && typeof snapshot === "object" ? snapshot : {};
    var at = Number(snap.at) > 0 ? Number(snap.at) : Date.now();
    var list = playersOf(st.bot, { players: snap.players || opts.players || st.options.players });
    var dt = Math.max(0.05, (at - (st.last.at || at - 1000)) / 1000);
    for (var i = 0; i < list.length; i++) {
      var name = list[i].name;
      if (name.length === 0) continue;
      var prev = st.last.players && st.last.players[name] ? st.last.players[name] : null;
      if (prev) {
        var d = distance(list[i].position, prev);
        var speed = d / dt;
        if (speed > out.speed) out.speed = speed;
        if (speed > SPEED_LIMIT) out.violations.push({ kind: "speed", player: name, speed: Math.round(speed * 10) / 10 });
      }
    }
    var mineRate = Number(snap.breakCount);
    if (isFinite(mineRate) && mineRate > AUTO_MINE_LIMIT) out.violations.push({ kind: "automine", player: toText(snap.miner), rate: mineRate });
    var entities = Number(snap.entityCount);
    if (isFinite(entities) && entities > LAG_ENTITY_LIMIT) out.violations.push({ kind: "lag", player: toText(snap.miner), count: entities });
    var next = {};
    for (var j = 0; j < list.length; j++) next[list[j].name] = list[j].position;
    st.last = { at: at, players: next };
    st.samples = st.samples + 1;
    totals.samples = totals.samples + 1;
    totals.violations = totals.violations + out.violations.length;
    st.violations = st.violations + out.violations.length;
    out.message = "sample done / 采样完成";
    return out;
  } catch (e) { out.ok = false; out.message = errText(e); return out; }
}
// 功能 4：截图取证——优先真实截图接口，缺失时明确标注结构化证据快照。
function capture(botId, target, options) {
  var out = { ok: true, screenshot: false, evidence: null, message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var st = sessionOf(botId);
    var bot = opts.bot || st.bot;
    var shot = null;
    try {
      if (bot && typeof bot.screenshot === "function") shot = bot.screenshot();
      else if (bot && typeof bot.takeScreenshot === "function") shot = bot.takeScreenshot();
    } catch (eShot) { shot = null; }
    out.screenshot = shot !== null && shot !== undefined;
    if (out.screenshot) totals.screenshots = totals.screenshots + 1;
    out.evidence = { kind: toText(target && target.kind) || "unknown", player: toText(target && target.player),
      at: Date.now(), botId: st.id, position: pointOf(opts.position),
      screenshotAvailable: out.screenshot, screenshot: shot || null,
      text: "证据快照 / evidence snapshot: " + toText(target && target.kind) };
    st.evidence.push(out.evidence);
    if (st.evidence.length > MAX_EVIDENCE) st.evidence.shift();
    out.message = out.screenshot ? "screenshot captured / 已截图取证" : "structured evidence captured / 已生成结构化证据";
    return out;
  } catch (e) { out.ok = false; out.message = errText(e); return out; }
}
// 功能 5：双语上报管理员——公屏 + 事件总线 + 外部群桥接 + 证据留痕。
function report(botId, violation, options) {
  var out = { ok: true, text: "", evidence: null, message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var st = sessionOf(botId);
    var bot = opts.bot || st.bot;
    var kind = toText(violation && violation.kind);
    var prefix = kind === "speed" ? ALERT_SPEED : (kind === "automine" ? ALERT_MINE : ALERT_LAG);
    out.text = prefix + "（" + toText(violation && violation.player) + " / " + kind + "）";
    var shot = capture(botId, violation, { bot: bot, position: opts.position });
    out.evidence = shot.evidence;
    try { if (bot && typeof bot.chat === "function") bot.chat(out.text); } catch (eChat) { /* 公屏失败继续 */ }
    try { if (bus && typeof bus.emit === "function") bus.emit("anticheat.alert", { botId: st.id, text: out.text, violation: violation }); } catch (eBus) { /* ignore */ }
    try {
      if (bridge && typeof bridge.push === "function") {
        bridge.push("anticheat.alert", { botId: st.id, text: out.text, player: toText(violation && violation.player),
          kind: kind, evidence: out.evidence }, {});
      }
    } catch (eBridge) { /* 桥接缺失不影响上报 */ }
    st.reports = st.reports + 1;
    totals.reports = totals.reports + 1;
    logInfo("[ghost-anticheat] " + out.text + " / reported");
    out.message = "admin notified / 已上报管理员";
    return out;
  } catch (e) { out.ok = false; out.message = errText(e); return out; }
}
// 功能 6：巡检一拍（定时器回调）——采样 + 逐条上报。
function inspect(botId, options) {
  var out = { ok: true, botId: toText(botId) || "default", violations: [], reports: 0, message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var snap = sample(out.botId, opts.snapshot || {}, opts);
    if (!snap.ok) { out.ok = false; out.message = snap.message; return out; }
    out.violations = snap.violations;
    for (var i = 0; i < snap.violations.length; i++) {
      report(out.botId, snap.violations[i], opts);
      out.reports = out.reports + 1;
    }
    out.message = "inspection done / 反作弊巡检完成";
    return out;
  } catch (e) { out.ok = false; out.message = errText(e); return out; }
}
// 功能 7：统计快照。
function stats(botId) {
  var st = botId ? sessionOf(botId) : null;
  return { ok: true, botId: st ? st.id : "all", running: st ? st.running : false,
    samples: st ? st.samples : totals.samples,
    violations: st ? st.violations : totals.violations,
    reports: st ? st.reports : totals.reports,
    screenshots: totals.screenshots,
    evidence: st ? st.evidence.length : 0,
    speedLimit: SPEED_LIMIT, mineLimit: AUTO_MINE_LIMIT, lagLimit: LAG_ENTITY_LIMIT,
    intervalMs: DEFAULT_INTERVAL_MS };
}
// 功能 8：复位全部会话、定时器与统计。
function reset() {
  try {
    for (var k in sessions) {
      if (!Object.prototype.hasOwnProperty.call(sessions, k)) continue;
      if (sessions[k].timer) clearInterval(sessions[k].timer);
    }
  } catch (e) { /* ignore */ }
  sessions = {};
  totals = { samples: 0, violations: 0, reports: 0, screenshots: 0 };
  return { ok: true, message: "ghost anticheat reset / 幽灵巡检已复位" };
}
// 对外导出。
module.exports = {
  start: start, stop: stop, sample: sample, inspect: inspect,
  capture: capture, report: report, stats: stats, reset: reset,
  DEFAULT_INTERVAL_MS: DEFAULT_INTERVAL_MS,
  ALERT_SPEED: ALERT_SPEED, ALERT_MINE: ALERT_MINE, ALERT_LAG: ALERT_LAG
};
