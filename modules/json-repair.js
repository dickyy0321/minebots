// ========================================
// 文件：modules/json-repair.js
// 功能：终极 JSON 容错引擎——五级防弹解析（原生 / 剥离 Markdown / 提取最外层括号 / jsonrepair 修复 / 暴力清洗），
//       五级全败返回兜底值并写一条 warn 双语日志，任何情况下绝不抛异常。
// 依赖：./logger（可选）、jsonrepair（可选第三方库；未安装时自动切换内置等价修复）
// 导出：safeParse / safeParseDetailed / getStats / resetStats / HAS_JSONREPAIR
// 作者：MineBots
// ========================================
// 说明 / note：AI 常返回 ```json 围栏、前后废话、尾随逗号、单引号、全角标点、未转义换行、残缺括号。
//   本模块逐级把这些脏文本洗成合法 JSON；任一级成功立即返回，并把命中等级记进统计，便于自测与排障。
// ES5 风格，CommonJS，无中文变量名。

// 可选依赖：日志核心；缺失时 warn 退回 console，绝不抛错。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 可选依赖：第三方修复库 jsonrepair（项目未安装时，四级改用内置等价修复，功能不缺席）。
var repairLib = null;
try { repairLib = require("jsonrepair"); } catch (e) { repairLib = null; }
var HAS_JSONREPAIR = !!(repairLib && (typeof repairLib === "function" || typeof repairLib.jsonrepair === "function"));

// 常量：全角标点 / 弯引号到 ASCII 的映射（用 Unicode 转义，避免源码编码差异）。
var FULLWIDTH_MAP = {
  "\uFF0C": ",", "\uFF1A": ":", "\uFF1B": ";", "\uFF5B": "{", "\uFF5D": "}",
  "\uFF3B": "[", "\uFF3D": "]", "\uFF02": "\"", "\uFF07": "'", "\u3001": ",",
  "\u201C": "\"", "\u201D": "\"", "\u2018": "'", "\u2019": "'",
  "\uFF08": "(", "\uFF09": ")", "\u3000": " "
};
// 全角数字 0-9 也补齐半角映射：五级暴力清洗后 JSON 里的数值才合法。
for (var fwDigit = 0; fwDigit <= 9; fwDigit++) {
  FULLWIDTH_MAP[String.fromCharCode(0xFF10 + fwDigit)] = String(fwDigit);
}

// 状态：解析次数 / 每级命中次数（0 级表示对象直通或兜底）/ 兜底次数。
var stats = { total: 0, byLevel: [0, 0, 0, 0, 0, 0], fallbacks: 0 };

// 安全转字符串：null / undefined / 对象统一转空串，异常也返回空串。
function toText(value) {
  try {
    if (value === null || value === undefined) return "";
    if (typeof value === "object") return "";
    return String(value);
  } catch (e) { return ""; }
}

// 安全取错误文本：catch 里再抛错就破红线了，失败返回固定串。
function errText(err) {
  try { if (err && err.message) return String(err.message); return String(err); }
  catch (e) { return "unknown error / 未知错误"; }
}

// 写一条 warn 双语日志：五级全败时调一次，日志模块缺失退回 console，绝不抛错。
function logWarn(message) {
  try {
    if (logger && typeof logger.warn === "function") { logger.warn(message); return; }
  } catch (e) { /* 落到 console */ }
  try { console.warn("[warn] " + message); } catch (e2) { /* ignore */ }
}

// 去重追加：候选文本去重，避免同一份脏文本被反复尝试。
function pushUnique(list, text) {
  try {
    if (!text || typeof text !== "string") return;
    for (var i = 0; i < list.length; i++) if (list[i] === text) return;
    list.push(text);
  } catch (e) { /* 候选收集失败不影响后续级别 */ }
}

// 统一解析尝试：成功返回 { ok:true, value }，失败返回 { ok:false, value:null }，绝不抛错。
function attempt(text) {
  try {
    if (typeof text !== "string" || text.length === 0) return { ok: false, value: null };
    return { ok: true, value: JSON.parse(text) };
  } catch (e) { return { ok: false, value: null }; }
}

// 记录一次成功：累加等级命中，返回统一结构（usedFallback 恒为 false）。
function succeed(value, level) {
  try { stats.byLevel[level] = (stats.byLevel[level] || 0) + 1; } catch (e) { /* 统计失败不影响解析 */ }
  return { ok: true, value: value, level: level, usedFallback: false, error: "" };
}

// 记录一次兜底：写 warn 双语日志，返回统一结构（usedFallback 为 true），绝不抛错。
function giveUp(fallback, reason) {
  try { stats.fallbacks++; } catch (e) { /* 统计失败不影响兜底 */ }
  logWarn("[json-repair] 五级解析全部失败，返回兜底值 / all 5 levels failed, fallback returned: " + toText(reason));
  return { ok: false, value: fallback, level: 0, usedFallback: true, error: toText(reason) };
}

// 第二级：剥掉 ```json / ``` 代码围栏，并去掉 JSON 前后的中英文废话，返回清洗后的文本。
function stripMarkdown(text) {
  var s = toText(text);
  try {
    s = s.replace(/```\s*json\s*/gi, "").replace(/```/g, "");
    var firstObj = s.indexOf("{"), firstArr = s.indexOf("[");
    var start = -1;
    if (firstObj >= 0 && firstArr >= 0) start = Math.min(firstObj, firstArr);
    else start = (firstObj >= 0) ? firstObj : firstArr;
    if (start > 0) s = s.slice(start);
    var end = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
    if (end >= 0 && end < s.length - 1) s = s.slice(0, end + 1);
    return s.replace(/^\s+|\s+$/g, "");
  } catch (e) { return s; }
}

// 从 start 处按引号 / 转义 / 括号深度截取一段配平文本；配不上返回空串。
function balancedSlice(text, start) {
  var stack = [], inStr = false;
  try {
    for (var i = start; i < text.length; i++) {
      var ch = text.charAt(i);
      if (ch === "\\") { i++; continue; }
      if (ch === "\"") { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{" || ch === "[") stack.push(ch);
      else if (ch === "}" || ch === "]") {
        stack.pop();
        if (stack.length === 0) return text.slice(start, i + 1);
      }
    }
  } catch (e) { return ""; }
  return "";
}

// 生成括号候选：先用正则 /\{[\s\S]*\}/、/\[[\s\S]*\]/ 抓最外层，再从每个起始括号做配平截取并去重。
function bracketCandidates(text) {
  var out = [], s = toText(text);
  try {
    var obj = s.match(/\{[\s\S]*\}/);
    if (obj && obj[0]) pushUnique(out, obj[0]);
    var arr = s.match(/\[[\s\S]*\]/);
    if (arr && arr[0]) pushUnique(out, arr[0]);
    for (var i = 0; i < s.length; i++) {
      if (s.charAt(i) !== "{" && s.charAt(i) !== "[") continue;
      pushUnique(out, balancedSlice(s, i));
    }
  } catch (e) { return out; }
  return out;
}

// 第三级：逐个候选解析；返回 { ok, value, text, outer, nested }，outer 是最外层候选供四 / 五级加工。
// nested 表示命中的是内层片段：此时主链路会先尝试修复最外层，避免返回语义错误的子对象。
function extractAndParse(text) {
  var out = { ok: false, value: null, text: "", outer: "", nested: false };
  try {
    var list = bracketCandidates(text);
    if (list.length > 0) { out.text = list[0]; out.outer = list[0]; }
    for (var i = 0; i < list.length; i++) {
      var one = attempt(list[i]);
      if (one.ok) { out.ok = true; out.value = one.value; out.nested = i > 0; return out; }
    }
  } catch (e) { return out; }
  return out;
}

// 把单引号字符串改成双引号（逐字符扫描，不误伤双引号里的撇号）；失败返回原文。
function singleToDouble(text) {
  var out = "", inDouble = false;
  try {
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (ch === "\\") { out += ch + ((i + 1 < text.length) ? text.charAt(i + 1) : ""); i++; continue; }
      if (ch === "\"") { inDouble = !inDouble; out += ch; continue; }
      if (ch === "'" && !inDouble) {
        var body = "", j = i + 1;
        while (j < text.length) {
          if (text.charAt(j) === "\\") { body += text.charAt(j) + ((j + 1 < text.length) ? text.charAt(j + 1) : ""); j += 2; continue; }
          if (text.charAt(j) === "'") break;
          body += text.charAt(j); j++;
        }
        if (j < text.length) { out += "\"" + body.replace(/"/g, "\\\"") + "\""; i = j; continue; }
      }
      out += ch;
    }
    return out;
  } catch (e) { return text; }
}

// 修复字符串内部未转义的换行 / 制表 / 控制字符；字符串外的空白保持原样。
function escapeControlInStrings(text) {
  var out = "", inStr = false;
  try {
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (ch === "\\") { out += ch; if (i + 1 < text.length) { out += text.charAt(i + 1); i++; } continue; }
      if (ch === "\"") { inStr = !inStr; out += ch; continue; }
      if (!inStr) { out += ch; continue; }
      if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else if (text.charCodeAt(i) < 32) out += " ";
      else out += ch;
    }
    return out;
  } catch (e) { return text; }
}

// 按括号栈补齐末尾缺失的 } / ]；引号内的括号不计入，失败返回原文。
function closeBrackets(text) {
  var stack = [], inStr = false;
  try {
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (ch === "\\") { i++; continue; }
      if (ch === "\"") { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{" || ch === "[") stack.push(ch);
      else if (ch === "}" || ch === "]") stack.pop();
    }
    var tail = "";
    for (var j = stack.length - 1; j >= 0; j--) tail += (stack[j] === "{") ? "}" : "]";
    return tail.length > 0 ? text + tail : text;
  } catch (e) { return text; }
}

// 内置等价修复：处理注释 / 单引号 / 无引号键 / 尾随逗号 / 裸控制符 / 残缺括号；失败返回原文。
function builtinRepair(text) {
  var s = toText(text);
  try {
    s = s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    s = singleToDouble(s);
    s = s.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)(\s*:)/g, "$1\"$2\"$3");
    s = s.replace(/,(\s*[}\]])/g, "$1");
    s = escapeControlInStrings(s);
    s = closeBrackets(s);
    return s;
  } catch (e) { return s; }
}

// 第四级：装了 jsonrepair 就调它修复（多余逗号 / 单引号 / 残缺括号），否则用内置等价修复；返回解析结果。
function levelFour(text) {
  var s = toText(text);
  if (HAS_JSONREPAIR) {
    try {
      var fn = (typeof repairLib === "function") ? repairLib : repairLib.jsonrepair;
      var fixed = fn(s);
      var r = attempt(fixed);
      if (r.ok) return r;
    } catch (e) { /* 三方库失败就退回内置修复 */ }
  }
  return attempt(builtinRepair(s));
}

// 第五级暴力清洗：全角标点归一化 + 裸换行修复 + 补齐末尾大括号，再叠加一次内置修复。
function brutalClean(text) {
  var s = toText(text);
  try {
    var out = "";
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      out += Object.prototype.hasOwnProperty.call(FULLWIDTH_MAP, ch) ? FULLWIDTH_MAP[ch] : ch;
    }
    return closeBrackets(escapeControlInStrings(out));
  } catch (e) { return s; }
}

// 第五级入口：先原生解析暴力清洗结果，不行再叠加内置修复解析。
function levelFive(text) {
  var s = brutalClean(text);
  var r = attempt(s);
  if (r.ok) return r;
  return attempt(builtinRepair(s));
}

// 主链路：五级防弹解析；传入对象直接放行；全部失败返回 { ok:false, usedFallback:true }，绝不抛异常。
function safeParseDetailed(text, fallback) {
  try {
    stats.total++;
    if (text !== null && typeof text === "object") return succeed(text, 0);
    var src = toText(text);
    if (src.length === 0) return giveUp(fallback, "empty input / 输入为空");
    var lv1 = attempt(src);                       // 一级：原生 JSON.parse
    if (lv1.ok) return succeed(lv1.value, 1);
    var stripped = stripMarkdown(src);            // 二级：剥 Markdown 围栏 + 去前后废话
    var lv2 = attempt(stripped);
    if (lv2.ok) return succeed(lv2.value, 2);
    var bracket = extractAndParse(src);           // 三级：正则抓最外层 + 配平提取
    if (bracket.ok) {
      // 内层片段合法但外层脏时，先救外层（尾随逗号等），避免把子对象当成整份数据返回。
      if (bracket.nested) {
        var rescued = levelFour(bracket.outer);
        if (rescued.ok) return succeed(rescued.value, 4);
      }
      return succeed(bracket.value, 3);
    }
    var bases = [];                              // 四 / 五级在全部候选文本上轮番尝试
    pushUnique(bases, src);
    pushUnique(bases, stripped);
    pushUnique(bases, bracket.text);
    for (var i = 0; i < bases.length; i++) {     // 四级：jsonrepair（或内置修复）
      var lv4 = levelFour(bases[i]);
      if (lv4.ok) return succeed(lv4.value, 4);
    }
    for (var j = 0; j < bases.length; j++) {     // 五级：暴力清洗
      var lv5 = levelFive(bases[j]);
      if (lv5.ok) return succeed(lv5.value, 5);
    }
    return giveUp(fallback, "unrepairable text / 文本无法修复: " + src.slice(0, 80));
  } catch (e) {
    return giveUp(fallback, errText(e));
  }
}

// 对外主接口：五级解析脏文本；全败返回 fallback（默认 null）并写 warn 日志，绝不抛异常。
function safeParse(text, fallback) {
  var fb = (arguments.length > 1) ? fallback : null;
  try { return safeParseDetailed(text, fb).value; } catch (e) { return fb; }
}

// 返回解析统计快照（拷贝），供自测与 GUI 排障；失败返回空统计。
function getStats() {
  try {
    return { total: stats.total, byLevel: stats.byLevel.slice(0), fallbacks: stats.fallbacks, hasJsonrepair: HAS_JSONREPAIR };
  } catch (e) { return { total: 0, byLevel: [0, 0, 0, 0, 0, 0], fallbacks: 0, hasJsonrepair: HAS_JSONREPAIR }; }
}

// 清零解析统计，失败只忽略，绝不抛错。
function resetStats() {
  try { stats.total = 0; stats.byLevel = [0, 0, 0, 0, 0, 0]; stats.fallbacks = 0; } catch (e) { /* ignore */ }
}

module.exports = {
  safeParse: safeParse,
  safeParseDetailed: safeParseDetailed,
  getStats: getStats,
  resetStats: resetStats,
  HAS_JSONREPAIR: HAS_JSONREPAIR
};
