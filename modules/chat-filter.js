// ========================================
// 文件：modules/chat-filter.js
// 功能：公屏防污染网关——挡掉服务器系统提示 / 玩家刷屏 / 无效废话，并禁绝两个 Bot 在无玩家指令时自聊；
//       只有通过的干净文本才允许进入 AI 上下文。
// 依赖：./logger（可选，缺失时静默）
// 导出：inspect / gateReply / registerBot / isBot / stats / reset / REASONS / FLOOD_WINDOW_MS
// 作者：MineBots
// ========================================
//
// 为什么需要：公屏的服务器广播、玩家刷屏、空话会把 AI 的上下文撑爆甚至被注入；
//   自身多个 Bot 若互相接话会形成无限对话循环。本模块是 chat-handler 的第一道闸，
//   只做只读判定，不改写业务状态；判定结果带中英双语原因，便于控制台排查。
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

// 可选依赖：日志核心；本层属高频，只写文件不推 GUI。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
// 常量：刷屏判定窗口（毫秒）、窗口内最大条数、相同文本最短间隔。
var FLOOD_WINDOW_MS = 3000;
var FLOOD_MAX = 8;
var FLOOD_SAME_MS = 1200;
// 常量：同一条文本要复读到第几次才算刷屏（放过玩家连续下两次相同指令）。
var FLOOD_SAME_MIN = 3;
// 常量：判定原因（中英双语，控制台与自检都读它）。
var REASONS = {
  empty: "空消息 / empty message",
  system: "服务器系统提示 / server system notice",
  flood: "玩家刷屏 / player flooding",
  duplicate: "重复刷屏 / repeated message",
  nonsense: "无效废话 / meaningless text",
  commandEcho: "指令回显 / command echo",
  botTalk: "Bot 自聊 / bot self chat",
  pass: "正常消息 / normal message"
};
// 常量：系统提示特征（中英常见广播、进出服、进度、白名单、死亡播报里的机器前缀）。
var SYSTEM_PATTERNS = [
  /^\[?(server|console|system|rcon)\]?\s*[:\]：>-]?/i,
  /^\*+\s*(welcome|服务器|欢迎)/i,
  /(joined the game|left the game|has joined|has left|登录了游戏|离开了游戏)/i,
  /(made the advancement|has completed the challenge|达成了进度|完成了挑战)/i,
  /^\[(公告|通知|系统|broadcast|announcement)\]/i,
  /(server restarted|服务器重启|正在保存世界|saving the world|autosave)/i,
  /^unknown command|^未知命令/i
];
// 常量：废话特征——纯标点 / 单字符 / 同字符复读 / 纯数字噪声 / 纯空白。
var NONSENSE_PATTERNS = [
  /^[\s.,!?;:~、，。！？；：…\-_=+*#@^&%$()\[\]{}<>\/\\|"'\x60]+$/,
  /^(.)\1{5,}$/,
  /^[0-9\s]{1,3}$/
];
// 常量：判废话时先剥掉的标点与空白集合（中文是正常内容，绝不能当标点剥掉）。
var PUNCT_STRIP = /[\s.,!?;:~、，。！？；：…\-_=+*#@^&%$()\[\]{}<>\/\\|"'\x60]+/g;
// 运行时状态：每个发送者的近期消息时间/文本；已注册 Bot 名单；统计。
var recent = {};
var bots = {};
var totals = { seen: 0, passed: 0, dropped: 0, system: 0, flood: 0, nonsense: 0, botTalk: 0 };

// 写普通日志：只落文件，绝不刷 GUI。
function logInfo(text) {
  try { if (logger && typeof logger.info === "function") logger.info(text); } catch (e) { /* ignore */ }
}
// 安全转字符串：null / undefined 归一成空串。
function toText(value) {
  try { if (value === null || value === undefined) return ""; return String(value); } catch (e) { return ""; }
}
// 取错误文本，catch 里绝不再次抛错。
function errText(err) {
  try { if (!err) return "unknown error"; if (err.message) return String(err.message); return String(err); } catch (e) { return "unknown error"; }
}
// 取当前时间；系统时钟异常时退回 0。
function now() {
  try { return Date.now(); } catch (e) { return 0; }
}
// 判断是不是服务器系统提示。
function looksSystem(text) {
  try {
    for (var i = 0; i < SYSTEM_PATTERNS.length; i++) if (SYSTEM_PATTERNS[i].test(text)) return true;
  } catch (e) { return false; }
  return false;
}
// 判断是不是无效废话。
function looksNonsense(text) {
  try {
    var trimmed = text.replace(/\s+/g, " ").trim();
    if (trimmed.length < 2) return true;
    for (var i = 0; i < NONSENSE_PATTERNS.length; i++) if (NONSENSE_PATTERNS[i].test(trimmed)) return true;
    if (toText(trimmed).replace(PUNCT_STRIP, "").length === 0) return true;
  } catch (e) { return false; }
  return false;
}
// 记录并判定刷屏：同窗口内超量或同文本过快重复都算刷屏。
function isFlood(sender, text, at) {
  try {
    var key = toText(sender) || "anonymous";
    if (!recent[key]) recent[key] = [];
    var list = recent[key];
    while (list.length > 0 && at - list[0].at > FLOOD_WINDOW_MS) list.shift();
    var sameCount = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].text === text && at - list[i].at < FLOOD_SAME_MS) sameCount = sameCount + 1;
    }
    if (sameCount >= FLOOD_SAME_MIN) return "duplicate";
    if (list.length + 1 > FLOOD_MAX) return "flood";
    list.push({ at: at, text: text });
    return "";
  } catch (e) { return ""; }
}
// 功能：登记一个 Bot 名（大小写不敏感），用于识别「Bot 对 Bot」对话。
function registerBot(name) {
  try {
    var key = toText(name).trim().toLowerCase();
    if (key.length === 0) return { ok: false, message: "name required / 缺少 Bot 名" };
    bots[key] = true;
    return { ok: true, name: key, message: "bot registered / Bot 已登记" };
  } catch (e) { return { ok: false, message: errText(e) }; }
}
// 功能：判断某个发送者是不是已登记的 Bot。
function isBot(name) {
  try { return bots[toText(name).trim().toLowerCase()] === true; } catch (e) { return false; }
}
// 功能：检查一条公屏消息是否可进入 AI 上下文，返回 { ok, action, reason, clean, category }。
function inspect(message, options) {
  var out = { ok: false, action: "drop", reason: REASONS.empty, clean: "", category: "empty", sender: "", bot: false };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var sender = toText(opts.sender || opts.username);
    var text = toText(message).trim();
    out.sender = sender;
    out.bot = isBot(sender);
    totals.seen = totals.seen + 1;
    if (text.length === 0) return out;
    if (looksSystem(text)) {
      out.reason = REASONS.system; out.category = "system"; totals.system = totals.system + 1;
      logInfo("[chat-filter] drop system / 挡下系统提示: " + text.slice(0, 40));
      return out;
    }
    if (text.charAt(0) === "/" || text.indexOf("> /") === 0) {
      out.reason = REASONS.commandEcho; out.category = "commandEcho";
      return out;
    }
    if (looksNonsense(text)) {
      out.reason = REASONS.nonsense; out.category = "nonsense"; totals.nonsense = totals.nonsense + 1;
      return out;
    }
    var flood = isFlood(sender, text, now());
    if (flood.length > 0) {
      out.reason = flood === "duplicate" ? REASONS.duplicate : REASONS.flood;
      out.category = "flood"; totals.flood = totals.flood + 1;
      logInfo("[chat-filter] drop flood / 挡下刷屏: " + sender);
      return out;
    }
    // 禁绝私聊：Bot 发的话只有在「玩家明确指令」或显式放行时才进上下文。
    if (out.bot && opts.playerDirected !== true && opts.allowBotTalk !== true) {
      out.reason = REASONS.botTalk; out.category = "botTalk"; totals.botTalk = totals.botTalk + 1;
      logInfo("[chat-filter] drop bot talk / 挡下 Bot 自聊: " + sender);
      return out;
    }
    out.ok = true; out.action = "pass"; out.reason = REASONS.pass; out.clean = text; out.category = "chat";
    totals.passed = totals.passed + 1;
    return out;
  } catch (e) {
    totals.dropped = totals.dropped + 1;
    out.reason = "过滤异常 / filter error: " + errText(e);
    return out;
  }
}
// 功能：判断 Bot 是否允许回复某个发送者——无玩家指令时绝不接另一个 Bot 的话。
function gateReply(sender, options) {
  try {
    var opts = options && typeof options === "object" ? options : {};
    if (opts.playerDirected === true || opts.allowBotTalk === true) return { ok: true, allowed: true, reason: REASONS.pass };
    if (isBot(sender)) return { ok: true, allowed: false, reason: REASONS.botTalk };
    return { ok: true, allowed: true, reason: REASONS.pass };
  } catch (e) { return { ok: false, allowed: false, reason: errText(e) }; }
}
// 功能：读统计快照。
function stats() {
  return { ok: true, seen: totals.seen, passed: totals.passed, droppedSystem: totals.system,
    droppedFlood: totals.flood, droppedNonsense: totals.nonsense, droppedBotTalk: totals.botTalk,
    bots: Object.keys(bots).length, windowMs: FLOOD_WINDOW_MS, maxPerWindow: FLOOD_MAX };
}
// 功能：复位全部内存状态（重连 / 自测隔离用）。
function reset() {
  recent = {}; bots = {};
  totals = { seen: 0, passed: 0, dropped: 0, system: 0, flood: 0, nonsense: 0, botTalk: 0 };
  return { ok: true, message: "chat filter reset / 公屏过滤已复位" };
}
// 对外导出。
module.exports = {
  inspect: inspect,
  gateReply: gateReply,
  registerBot: registerBot,
  isBot: isBot,
  stats: stats,
  reset: reset,
  REASONS: REASONS,
  FLOOD_WINDOW_MS: FLOOD_WINDOW_MS,
  FLOOD_MAX: FLOOD_MAX
};
