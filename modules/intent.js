// ========================================
// 文件：modules/intent.js
// 功能：意图识别——把用户说的话翻译成动作队列
// 依赖：./intent-parser（可选，失败不崩）、./logger（可选，失败退回 console）
// 导出：parseIntent、getKeywords、addKeyword、KEYWORDS
// 兼容：parseCommand、formatError、matchKeywords、GRAMMAR_ONLY（旧调用方不用改）
// 作者：MineBots
// ========================================
//
// 解析顺序 / resolution order
//   1. 先走完整语法（dig_tree, blocks=10, oak / mine, (iron) / follow, Steve）
//   2. 语法不匹配时退回关键词匹配（聊天里随口说的话："砍树然后跟随"）
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

// 可选依赖：语法解析器；缺失时本模块只做关键词匹配，绝不崩。
var parser = null;
try { parser = require("./intent-parser"); } catch (e) { parser = null; }

// 可选依赖：日志核心；缺失时退回 console，绝不崩。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：关键词表（动作名 → 触发词），可用 addKeyword 动态扩充。
var KEYWORDS = [
  { action: "dig_tree", words: ["砍树", "撸树", "砍木头", "chop", "dig tree", "cut tree"] },
  { action: "mine", words: ["挖矿", "采矿", "mine", "mining"] },
  { action: "attack_all", words: ["攻击", "打", "揍", "attack", "kill", "hit"] },
  { action: "follow", words: ["跟随", "跟我", "跟着", "follow"] },
  { action: "stop", words: ["停", "停下", "别动", "stop", "halt"] },
  { action: "collect", words: ["捡", "捡起", "拾取", "pick up", "collect"] },
  { action: "place", words: ["放", "放置", "place"] },
  { action: "craft", words: ["合成", "做", "craft"] },
  { action: "move", words: ["走", "过去", "移动", "move", "go"] }
];

// 常量：只能靠完整语法、不能靠关键词猜的类型，保留给旧调用方判断。
var GRAMMAR_ONLY = ["join", "switch"];

// 写告警日志：优先 logger.warn，失败退回 console，绝不抛错。
function logWarn(message) {
  try {
    if (logger && typeof logger.warn === "function") logger.warn(message);
    else console.warn(message);
  } catch (e) { /* 日志失败不影响主流程 */ }
}

// 安全取错误文本：catch 里再抛错就破红线了，这里全程兜底。
function getErrText(err) {
  try {
    if (!err) return "unknown error";
    if (err.message) return String(err.message);
    return String(err);
  } catch (e) { return "unknown error"; }
}

// 安全转字符串：null / undefined 统一成空串。
function toText(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

// 深拷贝纯数据：失败时返回兜底值，供 getKeywords 防外部改动内部表。
function cloneData(data, fallback) {
  try { return JSON.parse(JSON.stringify(data)); } catch (e) { return fallback; }
}
// 内部：把一段文本拆成命中列表（动作名、出现位置、表内序号）。
function findHits(lowerText) {
  var hits = [];
  for (var i = 0; i < KEYWORDS.length; i++) {
    var item = KEYWORDS[i];
    if (!item || !item.words) continue;
    var best = -1;
    for (var j = 0; j < item.words.length; j++) {
      var word = toText(item.words[j]).toLowerCase();
      if (word.length === 0) continue;
      var index = lowerText.indexOf(word);
      if (index >= 0 && (best < 0 || index < best)) best = index;
    }
    if (best >= 0) hits.push({ action: item.action, index: best, order: i });
  }
  return hits;
}

// 内部：命中按出现位置排序，位置相同按表内顺序，保证结果稳定。
function sortHits(hits) {
  hits.sort(function (a, b) {
    if (a.index !== b.index) return a.index - b.index;
    return a.order - b.order;
  });
  return hits;
}

// 功能 1：文本 → 动作队列；先试完整语法（能带 blocks/wood/range 参数），失败再退回关键词。
function parseIntent(text, options) {
  var raw = toText(text);
  if (raw.trim().length === 0) return [];
  var parsed = null;
  try {
    if (parser && typeof parser.parse === "function") parsed = parser.parse(raw, options);
  } catch (e) {
    logWarn("[intent] 语法解析失败 / grammar parse failed: " + getErrText(e));
    parsed = null;
  }
  if (parsed && parsed.ok === true && parsed.action) {
    return [{ action: parsed.action, command: parsed }];
  }
  return matchKeywords(raw);
}

// 兼容：完整语法解析（含 join 与开关），直接转发给 intent-parser。
function parseCommand(text, options) {
  try {
    if (!parser || typeof parser.parse !== "function") {
      return { ok: false, error: { code: "noParser", zh: "语法解析器不可用。", en: "Parser unavailable.", suggestions: [] } };
    }
    return parser.parse(text, options);
  } catch (e) {
    return { ok: false, error: { code: "parseFailed", zh: "解析出错：" + getErrText(e), en: "Parse failed: " + getErrText(e), suggestions: [] } };
  }
}

// 功能 2：返回关键词表深拷贝，外部随便改都改不到内部表。
function getKeywords() {
  return cloneData(KEYWORDS, []);
}

// 功能 3：动态添加触发词；动作不存在就新建，重复（忽略大小写）不重复加。
function addKeyword(action, word) {
  var actionName = toText(action).trim();
  var trigger = toText(word).trim();
  if (actionName.length === 0 || trigger.length === 0) return false;
  var lower = trigger.toLowerCase();
  for (var i = 0; i < KEYWORDS.length; i++) {
    var item = KEYWORDS[i];
    if (!item || item.action !== actionName) continue;
    if (!item.words) item.words = [];
    for (var j = 0; j < item.words.length; j++) {
      if (toText(item.words[j]).toLowerCase() === lower) return false;
    }
    item.words.push(trigger);
    return true;
  }
  KEYWORDS.push({ action: actionName, words: [trigger] });
  return true;
}

// 兼容：只做关键词匹配（不做语法解析），返回 [{action}]，顺序按出现位置。
function matchKeywords(text) {
  var hits = sortHits(findHits(toText(text).toLowerCase()));
  var out = [];
  for (var i = 0; i < hits.length; i++) out.push({ action: hits[i].action });
  return out;
}

// 兼容：把失败结果转成中文错误说明；成功或空结果返回空串。
function formatError(result) {
  try {
    if (typeof result === "string") return result;
    if (!result || result.ok === true) return "";
    if (result.message && !result.error) return "错误：" + result.message;
    if (parser && typeof parser.formatError === "function") return parser.formatError(result);
    var err = result.error || {};
    if (typeof err === "string") return err;
    return "错误：" + toText(err.zh || err.en || "指令无法识别。");
  } catch (e) {
    return "错误：解析失败。";
  }
}

// 对外导出：§五 规定的 4 个接口 + 4 个旧兼容键。
module.exports = {
  parseIntent: parseIntent,
  getKeywords: getKeywords,
  addKeyword: addKeyword,
  KEYWORDS: KEYWORDS,
  parseCommand: parseCommand,
  formatError: formatError,
  matchKeywords: matchKeywords,
  GRAMMAR_ONLY: GRAMMAR_ONLY
};
