// ========================================
// 文件：modules/typing.js
// 功能：整句式打字机——AI 想好完整句子后按「字数 ÷ 字/秒」等待，时间到一次性 bot.chat 发出；
//       发送链路不再分段、不再中途打断；旧的分段计算接口 plan / smartSplit 保留为兼容计算 API，不参与发送。
// 依赖：./speech（可选）、./prefs（可选）、./logger（可选）
// 导出：send / interrupt / flush / status / reset / plan / planWhole / smartSplit /
//       SMART_PUNCT / DEFAULTS / PER_CHARS / PER_MS / MAX_CHUNKS / WHOLE_MODE / MAX_WHOLE_DELAY_MS
// 作者：MineBots
// ========================================
//
// 节奏 / pacing：等待毫秒 = 句子字数 × 每字毫秒；每字毫秒由打字速度（字/秒）换算，
//   上限 MAX_WHOLE_DELAY_MS 防止长句把回复拖到几十秒。等待期间队列里只有这一整句，
//   到点一次 bot.chat(fullText)，绝不切成多段，也不会发到一半被新消息截断。
// 兼容 / legacy：plan() 与 smartSplit() 仍是旧的分段数学，供既有自检与面板读数使用；
//   真实发送只走 planWhole() + pump()，两者互不干扰。
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

// 可选依赖：语言纯净层；缺失时原文照发。
var speech = null;
try { speech = require("./speech"); } catch (e) { speech = null; }
// 可选依赖：偏好中心；缺失时用内置默认值。
var prefs = null;
try { prefs = require("./prefs"); } catch (e) { prefs = null; }
// 可选依赖：日志核心；缺失时静默（打字机是高频信息，绝不推 GUI）。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：旧节奏——3 字 / 100 毫秒，保留给 plan() 计算与面板读数。
var PER_CHARS = 3;
var PER_MS = 100;
var DEFAULT_CHUNK = 12;
var MAX_CHUNKS = 3;
var SMART_PUNCT = "，。！？、；：,.!?;:!?…";
var MAX_QUEUE = 4;
var MAX_TEXT = 200;
var MAX_DELAY_MS = 1500;
// 常量：整句模式名与最长等待（毫秒）；超过上限按上限等，不让玩家干等。
var WHOLE_MODE = "whole";
var MAX_WHOLE_DELAY_MS = 4000;
var DEFAULTS = { typing: true, typingMode: "chunk", typingChunk: DEFAULT_CHUNK, typingPerCharMs: Math.round(PER_MS / PER_CHARS) };

// 写普通信息日志：只落文件不推 GUI。
function logInfo(message) {
  try { if (logger && typeof logger.info === "function") logger.info(message); } catch (e) { /* ignore */ }
}
// 把异常拍成一行文本，避免在 catch 里再次抛错。
function errText(err) {
  try { if (!err) return "unknown error"; if (err.message) return String(err.message); return String(err); } catch (e) { return "unknown error"; }
}
// 安全转字符串：null / undefined 统一成空串。
function toText(value) {
  try { if (value === null || value === undefined) return ""; return String(value); } catch (e) { return ""; }
}
// 取（必要时新建）某 bot 的打字机状态；bot 不是对象时返回 null。
function stateOf(bot) {
  try {
    if (!bot || (typeof bot !== "object" && typeof bot !== "function")) return null;
    if (!bot._mbTyping || typeof bot._mbTyping !== "object") {
      bot._mbTyping = { timer: null, busy: false, queue: [], sent: 0, failed: 0, dropped: 0, chunks: 0, whole: 0, lastText: "", lang: "zh" };
    }
    var st = bot._mbTyping;
    if (!Array.isArray(st.queue)) st.queue = [];
    if (typeof st.sent !== "number") st.sent = 0;
    if (typeof st.failed !== "number") st.failed = 0;
    if (typeof st.dropped !== "number") st.dropped = 0;
    if (typeof st.chunks !== "number") st.chunks = 0;
    if (typeof st.whole !== "number") st.whole = 0;
    st.lastText = toText(st.lastText);
    return st;
  } catch (e) { return null; }
}
// 读当前配置：opts 覆盖 prefs，prefs 覆盖内置默认值；坏值一律回默认。
function configOf(options) {
  var out = { on: DEFAULTS.typing, mode: "chunk", chunk: DEFAULTS.typingChunk, perChar: DEFAULTS.typingPerCharMs };
  try {
    if (prefs && typeof prefs.load === "function") {
      var saved = prefs.load() || {};
      if (typeof saved.typing === "boolean") out.on = saved.typing;
      if (saved.typingMode) out.mode = String(saved.typingMode);
      if (saved.typingChunk) out.chunk = Number(saved.typingChunk);
      if (saved.typingPerCharMs) out.perChar = Number(saved.typingPerCharMs);
      // 专家面板「打字速度（字/秒）」优先级最高：滑块一动下一次发言立刻换节奏。
      if (saved.typingCps) {
        var cps = Number(saved.typingCps);
        if (!isNaN(cps) && cps >= 5 && cps <= 120) out.perChar = Math.round(1000 / cps);
      }
    }
  } catch (e) { /* 用内置默认 */ }
  try {
    if (String(process.env.MINEBOTS_TYPING || "").toLowerCase() === "off") { out.on = false; out.mode = "off"; }
  } catch (e2) { /* 读不到环境变量就按配置走 */ }
  var opts = options && typeof options === "object" ? options : {};
  if (opts.mode) out.mode = String(opts.mode);
  if (typeof opts.typing === "boolean") out.on = opts.typing;
  if (opts.chunk) out.chunk = Number(opts.chunk);
  if (opts.perCharMs) out.perChar = Number(opts.perCharMs);
  if (opts.cps) {
    var cps2 = Number(opts.cps);
    if (!isNaN(cps2) && cps2 >= 5 && cps2 <= 120) out.perChar = Math.round(1000 / cps2);
  }
  if (isNaN(out.chunk) || out.chunk < 3) out.chunk = DEFAULT_CHUNK;
  if (out.chunk > 60) out.chunk = 60;
  if (isNaN(out.perChar) || out.perChar < 5) out.perChar = DEFAULTS.typingPerCharMs;
  if (out.perChar > 200) out.perChar = 200;
  if (out.mode !== "chunk" && out.mode !== "delay" && out.mode !== "off" && out.mode !== WHOLE_MODE) out.mode = "chunk";
  if (!out.on) out.mode = "off";
  // 调用方显式打开整句式打字机时，忽略旧 prefs 里遗留的「分段关闭」模式，保证等待时间照算。
  if (opts.typing === true && out.mode === "off") out.mode = "chunk";
  return out;
}
// 判断一个无边界串是不是纯英文单词：纯字母必须整段保留。
function isLatinWord(body) {
  try { return /^[A-Za-z]+$/.test(body); } catch (e) { return false; }
}
// 兼容计算 API：按标点与空格智能切分，返回段数组；无边界且非英文单词时返回 null。
function smartSplit(text, maxSegments, options) {
  var body = toText(text);
  if (body.length === 0) return [];
  var cap = Number(maxSegments);
  if (isNaN(cap) || cap < 1) cap = MAX_CHUNKS;
  if (cap > MAX_CHUNKS) cap = MAX_CHUNKS;
  var hasBoundary = /[\s\u3000]/.test(body) || /[，。！？、；：,.!?;:!?…]/.test(body);
  if (!hasBoundary) { if (isLatinWord(body)) return [body]; return null; }
  try {
    var units = [];
    var buf = "";
    for (var i = 0; i < body.length; i++) {
      var ch = body.charAt(i);
      buf = buf + ch;
      if (ch === " " || ch === "\t" || ch === "\u3000" || SMART_PUNCT.indexOf(ch) >= 0) { units.push(buf); buf = ""; }
    }
    if (buf.length > 0) units.push(buf);
    if (units.length <= cap) return units;
    var target = Math.ceil(body.length / cap);
    if (target < 1) target = 1;
    var out = [];
    var current = "";
    for (var j = 0; j < units.length; j++) {
      if (out.length >= cap - 1) { current = current + units[j]; continue; }
      if (current.length + units[j].length > target && current.length > 0) { out.push(current); current = units[j]; }
      else current = current + units[j];
    }
    if (current.length > 0) out.push(current);
    while (out.length > cap) { var last = out.pop(); out[out.length - 1] = out[out.length - 1] + last; }
    return out.length > 0 ? out : [body];
  } catch (e) { return [body]; }
}
// 兼容计算 API：旧的分段计划，仅用于自检与面板读数，真实发送不再消费它。
function plan(text, options) {
  var body = toText(text).replace(/\r?\n+/g, " ");
  if (body.length > MAX_TEXT) body = body.substring(0, MAX_TEXT);
  var cfg = configOf(options);
  var out = { text: body, segments: [], gapMs: 0, firstMs: 0, mode: cfg.mode, chars: body.length };
  if (body.length === 0) return out;
  if (cfg.mode === "off") { out.segments = [body]; out.mode = "off"; return out; }
  var perChar = cfg.perChar;
  if (cfg.mode === "delay" || cfg.mode === WHOLE_MODE || body.length > cfg.chunk * MAX_CHUNKS) {
    out.segments = [body];
    out.mode = cfg.mode === WHOLE_MODE ? WHOLE_MODE : "delay";
    var wait = Math.round(body.length * perChar);
    out.firstMs = wait > MAX_DELAY_MS ? MAX_DELAY_MS : wait;
    return out;
  }
  var smart = smartSplit(body, MAX_CHUNKS, cfg);
  if (smart && smart.length > 0 && smart.length <= MAX_CHUNKS) out.segments = smart;
  else {
    for (var i = 0; i < body.length && out.segments.length < MAX_CHUNKS; i = i + cfg.chunk) out.segments.push(body.substring(i, i + cfg.chunk));
    if (out.segments.length === MAX_CHUNKS && out.segments.length * cfg.chunk < body.length) {
      out.segments[MAX_CHUNKS - 1] = body.substring((MAX_CHUNKS - 1) * cfg.chunk);
    }
  }
  out.gapMs = Math.round(Math.min(cfg.chunk, out.segments.length > 1 ? cfg.chunk : body.length) * perChar);
  if (out.gapMs < perChar) out.gapMs = perChar;
  out.firstMs = out.gapMs;
  return out;
}
// 功能：整句发送计划——按字数与字/秒算出等待毫秒，返回单段整句；空文本 waitMs=0。
function planWhole(text, options) {
  var body = toText(text).replace(/\r?\n+/g, " ");
  if (body.length > MAX_TEXT) body = body.substring(0, MAX_TEXT);
  var cfg = configOf(options);
  var cps = Math.round(1000 / cfg.perChar);
  var waitMs = Math.round(body.length * cfg.perChar);
  if (waitMs > MAX_WHOLE_DELAY_MS) waitMs = MAX_WHOLE_DELAY_MS;
  if (cfg.mode === "off" || !cfg.on) waitMs = 0;
  return { ok: body.length > 0, text: body, segments: [body], waitMs: waitMs, chars: body.length,
    cps: cps, perCharMs: cfg.perChar, mode: WHOLE_MODE, capped: Math.round(body.length * cfg.perChar) > MAX_WHOLE_DELAY_MS };
}
// 内部：排一次定时器（发送属于有活没干完，不 unref，避免说到一半进程退出）。
function later(fn, ms) {
  try { return setTimeout(function () { try { fn(); } catch (e) { /* 单句失败不影响后续 */ } }, ms); }
  catch (e3) { return null; }
}
// 内部：把完整一句一次性交给 bot.chat；失败只记数，不抛到顶层。
function sayOne(bot, st, text, prefiltered) {
  var ok = true;
  var body = toText(text);
  if (prefiltered !== true) {
    try { if (speech && typeof speech.forceMonolingual === "function") body = speech.forceMonolingual(body, st.lang); }
    catch (e0) { body = toText(text); }
  }
  body = toText(body);
  if (body.length === 0) { st.dropped = st.dropped + 1; return false; }
  try { ok = bot.chat(body); } catch (err) { ok = false; }
  if (ok === false) {
    st.failed = st.failed + 1;
    logInfo("[typing] chat failed / 整句发送失败: " + body.substring(0, 20));
    return false;
  }
  st.sent = st.sent + 1;
  st.chunks = st.chunks + 1;
  st.whole = st.whole + 1;
  return true;
}
// 内部：泵——队首一整句等满时长后一次性发出，再处理下一句；无分段、无中途打断。
function pump(bot, st) {
  try {
    if (!st || st.busy || st.timer) return false;
    var item = st.queue[0];
    if (!item) return false;
    st.busy = true;
    var fire = function () {
      st.timer = null;
      try {
        if (!st.queue.length || st.queue[0] !== item) { st.busy = false; pump(bot, st); return; }
        st.queue.shift();
        sayOne(bot, st, item.text, true);
        st.lastText = item.text;
      } catch (e) { /* 单句失败继续下一句 */ }
      st.busy = false;
      pump(bot, st);
    };
    if (item.waitMs > 0) {
      st.timer = later(fire, item.waitMs);
      if (!st.timer) { st.busy = false; }
    } else fire();
    return true;
  } catch (e) { if (st) { st.busy = false; st.timer = null; } return false; }
}
// 功能：发一句完整话——清洗语言后按字数等待，到点一次性 bot.chat；返回计划摘要，绝不抛错。
function send(bot, text, options) {
  var out = { ok: false, mode: WHOLE_MODE, segments: 0, queued: 0, dropped: 0, waitMs: 0, chars: 0, message: "" };
  var st = stateOf(bot);
  if (!st) { out.message = "no bot / 机器人不可用"; return out; }
  if (!bot || typeof bot.chat !== "function") { out.message = "no chat / 机器人没有聊天接口"; return out; }
  try {
    var opts = options && typeof options === "object" ? options : {};
    st.lang = toText(opts.lang).length > 0 ? toText(opts.lang) : "zh";
    var body = toText(text);
    if (speech && typeof speech.clean === "function") body = speech.clean(body, st.lang);
    if (toText(body).length === 0) { out.message = "empty / 空文本"; return out; }
    var ready = planWhole(body, opts);
    out.mode = WHOLE_MODE;
    out.segments = 1;
    out.waitMs = ready.waitMs;
    out.chars = ready.chars;
    if (st.queue.length >= MAX_QUEUE) {
      var droppedOld = st.queue.length;
      st.queue = [];
      st.dropped = st.dropped + droppedOld;
      out.dropped = droppedOld;
    }
    st.queue.push({ text: ready.text, waitMs: ready.waitMs, filtered: true });
    out.queued = st.queue.length;
    out.ok = true;
    pump(bot, st);
    logInfo("[typing] whole sentence queued / 整句排队: chars=" + ready.chars + " waitMs=" + ready.waitMs);
    return out;
  } catch (err) { out.message = errText(err); return out; }
}
// 功能：取消尚未发出的整句（停止任务 / 重连时用），返回被取消的句数；已发出的句子不受影响。
function interrupt(bot) {
  var st = stateOf(bot);
  if (!st) return 0;
  var dropped = st.queue.length;
  try { if (st.timer) clearTimeout(st.timer); } catch (e) { /* ignore */ }
  st.timer = null;
  st.busy = false;
  st.queue = [];
  if (dropped > 0) {
    st.dropped = st.dropped + dropped;
    logInfo("[typing] cancelled " + dropped + " / 取消待发整句 " + dropped + " 句");
  }
  return dropped;
}
// 兼容别名：flush 与 interrupt 同义。
function flush(bot) { return interrupt(bot); }
// 功能：读状态快照，含整句发送计数 whole。
function status(bot) {
  var empty = { queued: 0, sent: 0, failed: 0, dropped: 0, chunks: 0, whole: 0, lastText: "" };
  var st = stateOf(bot);
  if (!st) return empty;
  return { queued: st.queue.length, sent: st.sent, failed: st.failed, dropped: st.dropped,
    chunks: st.chunks, whole: st.whole, lastText: st.lastText };
}
// 功能：清空状态（重连 / 自测隔离用），返回 true 表示清掉了。
function reset(bot) {
  try {
    if (!bot || typeof bot !== "object") return false;
    if (bot._mbTyping && bot._mbTyping.timer) clearTimeout(bot._mbTyping.timer);
    bot._mbTyping = null;
    return true;
  } catch (e) { return false; }
}
// 对外导出：发送 / 取消 / 状态 / 整句计划 / 兼容旧计划。
module.exports = {
  send: send,
  interrupt: interrupt,
  flush: flush,
  status: status,
  reset: reset,
  plan: plan,
  planWhole: planWhole,
  smartSplit: smartSplit,
  SMART_PUNCT: SMART_PUNCT,
  DEFAULTS: DEFAULTS,
  PER_CHARS: PER_CHARS,
  PER_MS: PER_MS,
  MAX_CHUNKS: MAX_CHUNKS,
  WHOLE_MODE: WHOLE_MODE,
  MAX_WHOLE_DELAY_MS: MAX_WHOLE_DELAY_MS
};
