// ========================================
// 文件：modules/external-bridge.js
// 功能：QQ / Discord 外部桥接——把游戏内重要事件（玩家死亡、被熊孩子炸家、反作弊告警）
//       推送到外部群；外部群发来的指令回灌到游戏内执行。
// 依赖：http / https（Node 内置，可选真实 webhook）；./logger、./event-bus（均可选）
// 导出：configure / push / onExternal / bindEvents / pullCommands / outbox / inbox /
//       stats / reset / CHANNELS
// 作者：MineBots
// ========================================
// 说明：默认 offline —— 没有 webhook 时只进内存队列，绝不发真实网络请求，自测全离线；
//   配了 webhook 才用 Node 内置 http/https POST，全部包 try/catch，失败只记日志不抛错。
// ES5 风格，CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

var http = null;
try { http = require("http"); } catch (e) { http = null; }
var https = null;
try { https = require("https"); } catch (e) { https = null; }
// 可选依赖：日志与事件总线。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
var bus = null;
try { bus = require("./event-bus"); } catch (e) { bus = null; }
// 常量：关注的事件 / 双语提示 / 队列上限 / 请求超时。
// 注意：anticheat.alert 由 ghost-anticheat 直接 push，不在此重复订阅，避免一条告警推两遍。
var CHANNELS = ["player.death", "base.griefed", "market.order", "market.completed"];
var MAX_QUEUE = 200;
var REQUEST_TIMEOUT_MS = 3000;
var CMD_PREFIX = "#";

// 运行时：配置 / 待发队列 / 待执行指令 / 统计 / 事件桥标记。
var config = { qq: "", discord: "", offline: true, admin: "" };
var sent = [];
var commands = [];
var totals = { pushed: 0, delivered: 0, failed: 0, incoming: 0, executed: 0 };
var bridgeBound = false;

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
// 功能 1：配置 webhook；任一 webhook 非空即自动转在线模式（offline 可显式覆盖）。
function configure(options) {
  var out = { ok: true, offline: true, qq: false, discord: false, message: "" };
  try {
    var o = options && typeof options === "object" ? options : {};
    config.qq = toText(o.qq || (o.adapters && o.adapters.qq) || "");
    config.discord = toText(o.discord || (o.adapters && o.adapters.discord) || "");
    config.admin = toText(o.admin) || config.admin;
    if (typeof o.offline === "boolean") config.offline = o.offline;
    else config.offline = config.qq.length === 0 && config.discord.length === 0;
    out.offline = config.offline;
    out.qq = config.qq.length > 0;
    out.discord = config.discord.length > 0;
    out.message = "bridge configured / 外部桥接已配置";
    ensureEvents();
    return out;
  } catch (e) { out.ok = false; out.message = errText(e); return out; }
}
// 单条 webhook POST：超时自動销毁，任何失败都只记日志。
function post(url, body) {
  var ok = false;
  try {
    if (!url || (!http && !https)) return false;
    var lib = url.indexOf("https://") === 0 ? https : http;
    if (!lib || typeof lib.request !== "function") return false;
    var payload = JSON.stringify({ content: toText(body), at: Date.now() });
    var req = lib.request(url, { method: "POST", headers: {
      "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload)
    } }, function (res) {
      try { if (res && typeof res.resume === "function") res.resume(); } catch (eRes) { /* ignore */ }
    });
    if (req && typeof req.setTimeout === "function") req.setTimeout(REQUEST_TIMEOUT_MS, function () {
      try { req.destroy(); } catch (eDestroy) { /* ignore */ }
    });
    req.on("error", function () { /* 网络失败静默，由队列兜底 */ });
    req.write(payload);
    req.end();
    ok = true;
  } catch (e) { logInfo("[external-bridge] post failed / 推送失败: " + errText(e)); ok = false; }
  return ok;
}
// 功能 2：推送一个游戏内事件到外部群（双语文案 + 内存留痕）。
function push(event, payload, options) {
  var out = { ok: true, queued: false, delivered: 0, text: "", message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var name = toText(event) || "event";
    var p = payload && typeof payload === "object" ? payload : {};
    out.text = "[" + name + "] " + toText(p.text || p.message || JSON.stringify(p)) +
      " / 来自 MineBots 游戏内事件 / in-game event";
    var item = { event: name, text: out.text, at: Date.now(), payload: p };
    sent.push(item);
    if (sent.length > MAX_QUEUE) sent.shift();
    totals.pushed = totals.pushed + 1;
    if (config.offline === true || opts.forceOffline === true) {
      out.queued = true;
      out.message = "offline queued / 离线队列已暂存";
      return out;
    }
    if (config.qq.length > 0 && post(config.qq, out.text)) out.delivered = out.delivered + 1;
    if (config.discord.length > 0 && post(config.discord, out.text)) out.delivered = out.delivered + 1;
    totals.delivered = totals.delivered + out.delivered;
    if (out.delivered === 0) { totals.failed = totals.failed + 1; out.queued = true; }
    out.message = "event pushed / 事件已推送";
    return out;
  } catch (e) { out.ok = false; out.message = errText(e); return out; }
}
// 事件桥：订阅游戏内重要事件，总线 reset 清空订阅后可自愈重挂；handler 存表保证不叠加。
var handlers = {};
function ensureEvents() {
  try {
    if (!bus || typeof bus.on !== "function") return false;
    var n = typeof bus.listenerCount === "function" ? bus.listenerCount("player.death") : -1;
    if (bridgeBound && n > 0) return true;
    for (var i = 0; i < CHANNELS.length; i++) {
      (function (name) {
        if (typeof bus.off === "function" && handlers[name]) bus.off(name, handlers[name]);
        handlers[name] = function (p) { try { push(name, p, {}); } catch (eOne) { /* 单条失败不影响总线 */ } };
        bus.on(name, handlers[name]);
      })(CHANNELS[i]);
    }
    bridgeBound = true;
    return true;
  } catch (e) { return false; }
}
// 功能 3：显式挂事件桥（自测 / 启动链路调用）。
function bindEvents() {
  bridgeBound = false;
  return { ok: ensureEvents(), message: "game events bound / 游戏事件已挂载" };
}
// 功能 4：外部群指令回灌——解析 #指令，注入游戏内执行（bot.chat / actions 二选一）。
function onExternal(text, options) {
  var out = { ok: true, command: "", executed: false, reply: "", message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var raw = toText(text);
    if (raw.length === 0) { out.ok = false; out.message = "empty command / 空指令"; return out; }
    // 本地 HY-MT1.5-1.8B 翻译：保护指令与坐标、反向验证，失败自动退回原话。
    try {
      var tr = require("./local-translator");
      var converted = tr.translate(raw, { from: toText(opts.from), to: toText(opts.to) });
      if (converted && converted.ok === true && toText(converted.text).length > 0) raw = toText(converted.text);
    } catch (eTr) { /* 翻译层缺失按原文执行 */ }
    out.command = raw.charAt(0) === CMD_PREFIX ? raw : CMD_PREFIX + raw;
    commands.push({ command: out.command, at: Date.now(), source: toText(opts.source) || "external" });
    if (commands.length > MAX_QUEUE) commands.shift();
    totals.incoming = totals.incoming + 1;
    var inGame = raw.charAt(0) === CMD_PREFIX ? raw.substring(1) : raw;
    try {
      if (opts.bot && typeof opts.bot.chat === "function") { opts.bot.chat(out.command); out.executed = true; }
      else if (opts.execute && typeof opts.execute === "function") { opts.execute(inGame, opts); out.executed = true; }
    } catch (eExec) { out.executed = false; }
    if (out.executed) totals.executed = totals.executed + 1;
    try { if (bus && typeof bus.emit === "function") bus.emit("bridge.command", { command: out.command, at: Date.now() }); } catch (eBus) { /* ignore */ }
    out.reply = "外部指令已回灌游戏内 / External command relayed in-game: " + out.command;
    out.message = "command relayed / 指令已回灌";
    return out;
  } catch (e) { out.ok = false; out.message = errText(e); return out; }
}
// 功能 5：取出并清空待执行指令（控制台 / 自测用）。
function pullCommands() {
  var out = commands.slice(0);
  commands = [];
  return out;
}
// 功能 6：外发队列副本。
function outbox() {
  return sent.slice(0);
}
// 功能 7：外部指令队列副本。
function inbox() {
  return commands.slice(0);
}
// 功能 8：统计快照。
function stats() {
  return { ok: true, offline: config.offline, qq: config.qq.length > 0, discord: config.discord.length > 0,
    admin: config.admin, queued: sent.length, pendingCommands: commands.length,
    pushed: totals.pushed, delivered: totals.delivered, failed: totals.failed,
    incoming: totals.incoming, executed: totals.executed, events: CHANNELS.slice(0),
    bound: bridgeBound };
}
// 功能 9：复位配置与队列（不清事件总线订阅，避免影响其它模块）。
function reset() {
  config = { qq: "", discord: "", offline: true, admin: "" };
  sent = []; commands = [];
  totals = { pushed: 0, delivered: 0, failed: 0, incoming: 0, executed: 0 };
  bridgeBound = false;
  return { ok: true, message: "external bridge reset / 外部桥接已复位" };
}
// 对外导出。
module.exports = {
  configure: configure, push: push, onExternal: onExternal, bindEvents: bindEvents,
  pullCommands: pullCommands, outbox: outbox, inbox: inbox,
  stats: stats, reset: reset, CHANNELS: CHANNELS
};
