// ========================================
// 文件：modules/task-narration.js
// 功能：任务播报——边做边汇报（内置模板 / 同 bot 8 秒冷却 / 失败只报一次 / 绝不自问自答）
// 依赖：./logger（可选，缺失时静默）
// 导出：announce / textFor / getState / reset / KINDS / COOLDOWN_MS
// 作者：MineBots
// ========================================
//
// 为什么要内置模板而不是让 AI 现编：
//   1) 播报是高频信息，走 AI 会刷爆 token 还可能胡编（自问自答）；
//   2) 模板句短、可控，配合 8 秒冷却就不会刷屏被服务器踢；
//   3) 本模块没有任何定时器——只有任务事件（收到 / 切换步骤 / 完成 / 失败）才会说话。
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

// 可选依赖：日志模块；缺失时全部静默，绝不抛错。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
// 可选依赖：语言纯净层；缺失时模板本身就只出一种语言，照样安全。
var speech = null;
try { speech = require("./speech"); } catch (e) { speech = null; }

// 常量：同一个 bot 主动播报的最小间隔（毫秒）——需求写死的 8 秒。
var COOLDOWN_MS = 8000;
// 常量：同一句错误在多少毫秒内不重复播报（防连续刷错误）。
var ERROR_REPEAT_MS = 30000;
// 常量：单条播报长度上限，防超长被服务器截断 / 踢人。
var MAX_TEXT = 200;
// 常量：允许的播报类型，其它值一律当不存在（防止调用方乱传把模板打穿）。
var KINDS = ["accept", "step", "done", "error"];

// 动作名 -> 中英文短标签；同时认 command-handler 的动作名和 actions 的方法名。
var LABELS = {
  dig_tree: { zh: "砍木头", en: "chopping wood" },
  dig_block: { zh: "挖方块", en: "digging a block" },
  digBlock: { zh: "挖方块", en: "digging a block" },
  mine: { zh: "挖矿", en: "mining" },
  move: { zh: "走过去", en: "walking over" },
  moveTo: { zh: "走过去", en: "walking over" },
  follow: { zh: "跟着你", en: "following you" },
  followPlayer: { zh: "跟着你", en: "following you" },
  attack: { zh: "打怪", en: "fighting mobs" },
  attack_all: { zh: "打怪", en: "fighting mobs" },
  attackEntity: { zh: "打目标", en: "attacking the target" },
  collect: { zh: "捡东西", en: "picking up items" },
  collectNearbyItems: { zh: "捡东西", en: "picking up items" },
  place: { zh: "放方块", en: "placing blocks" },
  placeBlock: { zh: "放方块", en: "placing blocks" },
  craft: { zh: "合成", en: "crafting" },
  stop: { zh: "停下", en: "stopping" },
  all: { zh: "整批任务", en: "the whole queue" }
};

// 写普通信息日志：只落文件不推 GUI（播报是高频信息，禁止刷界面）。
function logInfo(message) {
  try {
    if (logger && typeof logger.info === "function") logger.info(message);
  } catch (e) { /* ignore */ }
}

// 把任意值转成字符串，转换失败给空串。
function toText(value) {
  try {
    if (value === null || value === undefined) return "";
    return String(value);
  } catch (e) { return ""; }
}

// 把异常拍成一行文本，避免在 catch 里再次抛错。
function errText(err) {
  try {
    if (!err) return "unknown error / 未知错误";
    if (err.message) return String(err.message);
    return String(err);
  } catch (e) { return "unknown error / 未知错误"; }
}

// 取动作的中英文标签，认不出来时退回「这个活 / this job」。
function labelOf(action) {
  var key = toText(action);
  try {
    if (key && LABELS[key]) return LABELS[key];
  } catch (e) { /* 退回默认 */ }
  return { zh: "这个活", en: "this job" };
}

// 按类型生成播报句——**只出一种语言**（玩家说中文就只听中文）；类型不认识返回空串（调用方据此跳过）。
// lang 缺省为 zh；英文玩家传 "en"。绝不返回「中文 / English」混排（游戏聊天框里会立刻出戏）。
function textFor(kind, action, lang) {
  try {
    var name = toText(kind);
    var hit = false;
    for (var i = 0; i < KINDS.length; i++) if (KINDS[i] === name) hit = true;
    if (!hit) return "";
    var label = labelOf(action);
    var wantEn = toText(lang).toLowerCase() === "en";
    if (name === "accept") return wantEn ? "Got it, " + label.en : "收到，我去" + label.zh;
    if (name === "step") return wantEn ? "Next: " + label.en : "接下来：" + label.zh;
    if (name === "done") return wantEn ? "Done: " + label.en : label.zh + "完成";
    if (name === "error") return wantEn ? "Failed: " + label.en : label.zh + "没做成";
    return "";
  } catch (e) { return ""; }
}

// 造一份全新的播报状态（每个 bot 一份，存在 bot._mbNarrate 上，断开即丢）。
function freshState() {
  return {
    at: 0, lastText: "", said: 0, skipped: 0,
    errorAt: 0, errorText: "", errorRun: ""
  };
}

// 取（必要时新建）某个 bot 的播报状态；bot 不是对象时返回 null。
function ensureState(bot) {
  try {
    if (!bot || typeof bot !== "object") return null;
    if (!bot._mbNarrate || typeof bot._mbNarrate !== "object") bot._mbNarrate = freshState();
    var st = bot._mbNarrate;
    if (typeof st.at !== "number") st.at = 0;
    if (typeof st.said !== "number") st.said = 0;
    if (typeof st.skipped !== "number") st.skipped = 0;
    if (typeof st.errorAt !== "number") st.errorAt = 0;
    st.lastText = toText(st.lastText);
    st.errorText = toText(st.errorText);
    st.errorRun = toText(st.errorRun);
    return st;
  } catch (e) { return null; }
}

// 功能 1：任务播报——过冷却 / 去重后调 bot.chat，永远返回结果对象，绝不抛错。
// 返回 { ok, sent, kind, text, reason }；被冷却 / 去重拦下时 ok=false、reason 说明原因。
function announce(bot, botId, kind, extra) {
  var out = { ok: false, sent: false, kind: "", text: "", reason: "" };
  try {
    var opts = extra && typeof extra === "object" ? extra : {};
    var name = toText(kind) || "step";
    out.kind = name;
    var st = ensureState(bot);
    if (!st) { out.reason = "no-bot"; return out; }
    if (!bot || typeof bot.chat !== "function") { out.reason = "no-chat"; return out; }
    var text = textFor(name, opts.action, toText(opts.lang).length > 0 ? opts.lang : bot._mbLang);
    if (text.length === 0) { out.reason = "no-template"; return out; }
    // 发出前最后一道硬过滤：模板里哪怕夹了外语单词，也在这里被删干净（"Got it" 绝不进聊天框）。
    try {
      var langNow = toText(opts.lang).length > 0 ? opts.lang : bot._mbLang;
      if (speech && typeof speech.forceMonolingual === "function") text = toText(speech.forceMonolingual(text, langNow));
    } catch (eLang) { /* 过滤失败就按模板原文发（模板本身是单语） */ }
    if (text.length === 0) { out.reason = "empty-after-filter"; return out; }
    if (text.length > MAX_TEXT) text = text.substring(0, MAX_TEXT);
    out.text = text;
    var now = Date.now();
    var runId = toText(opts.runId);
    if (name === "error") {
      // 失败只播报一次：同一轮任务里报过就不再报；同一句话 30 秒内也不重复。
      if (runId && st.errorRun === runId) { out.reason = "duplicate"; st.skipped = st.skipped + 1; return out; }
      if (st.errorText === text && now - st.errorAt < ERROR_REPEAT_MS) { out.reason = "duplicate"; st.skipped = st.skipped + 1; return out; }
    } else {
      // 主动播报至少间隔 8 秒：这是「防刷屏」的第一道闸。
      if (st.at > 0 && now - st.at < COOLDOWN_MS) { out.reason = "cooldown"; st.skipped = st.skipped + 1; return out; }
      if (st.at > 0 && st.lastText === text) { out.reason = "duplicate"; st.skipped = st.skipped + 1; return out; }
    }
    var sent = bot.chat(text);
    if (sent === false) { out.reason = "chat-failed"; return out; }
    st.at = now;
    st.lastText = text;
    st.said = st.said + 1;
    if (name === "error") {
      st.errorAt = now;
      st.errorText = text;
      if (runId) st.errorRun = runId;
    }
    out.ok = true;
    out.sent = true;
    logInfo("[narration] " + (toText(botId) || "bot") + " -> " + text);
    return out;
  } catch (err) {
    out.reason = "error: " + errText(err);
    return out;
  }
}

// 功能 2：取某个 bot 的播报状态（活对象，自测里用来推进 / 检查冷却）。
function getState(bot) {
  return ensureState(bot);
}

// 功能 3：清空播报状态（重连 / 自测隔离用），成功返回 true。
function reset(bot) {
  try {
    if (!bot || typeof bot !== "object") return false;
    bot._mbNarrate = freshState();
    return true;
  } catch (e) { return false; }
}

// 对外导出：播报入口 + 模板 + 状态（自测 / 诊断用）。
module.exports = {
  announce: announce,
  textFor: textFor,
  getState: getState,
  reset: reset,
  KINDS: KINDS,
  LABELS: LABELS,
  COOLDOWN_MS: COOLDOWN_MS,
  ERROR_REPEAT_MS: ERROR_REPEAT_MS
};
