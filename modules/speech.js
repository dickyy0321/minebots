// ========================================
// 文件：modules/speech.js
// 功能：说话语言纯净层——判定玩家语言 / 单语取词 / 去掉「中文 / English」双语混排
// 依赖：无（纯函数，不读盘不联网）
// 导出：detectLang、countCjk、countLatin、hasCjk、pick、cleanLine、clean、SYS_LANG_RULE
// 作者：MineBots
// ========================================
//
// 为什么要这一层：
//   游戏的聊天框只有一行，AI 回一句 "Hello, 你好" 会立刻出戏；
//   日志与界面里的中英双语是规范，但**发到游戏聊天里的话必须纯单语**。
//   所有要进 bot.chat 的文本都先走 clean(text, lang)：同语言不动，异语言只留玩家那一种。
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

// 常量：CJK（中日韩）字符范围——判断「这句话是不是中文」的唯一依据。
var CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
// 常量：拉丁字母范围——英文判定用。
var LATIN_RE = /[A-Za-z]/;
// 常量：中文 / 英文各自的语气词（取词时用，避免调用方到处写字符串）。
var ZH_YES = "好的";
var EN_YES = "ok";
// 常量：塞进 system prompt 的语言铁律（纯单语、不混排、不复述括号）。
var SYS_LANG_RULE = "Language rule: reply in the exact language the player used, and in that language only. " +
  "Chinese input -> Chinese only. English input -> English only. " +
  "Never mix two languages, never output '中文 / English' pairs, never translate your own sentence.";

// 常量：连续两个以上的拉丁字母——注释与文档里说明「英文单词」用（实际删除走 stripLatinWords）。
// 常量：CJK 字符——en 模式下整段删掉。
var CJK_CHAR_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
// 常量：删字之后一定要清掉的残局（多余空格 / 孤立的双语斜杠 / 连续标点）。
var SPACE_RUN_RE = /[ \t]{2,}/g;
var LONE_SLASH_RE = /[ \t]+[\/|]+[ \t]+/g;
var TAIL_SLASH_RE = /[ \t]*[\/|]+[ \t]*$/g;
var SPACE_BEFORE_PUNCT_RE = /[ \t]+([,，。！？、；：.!?;:])/g;
var DOUBLE_PUNCT_RE = /([,，。！？、；：.!?;:])\s*([,，。！？、；：.!?;:])/g;
var HEAD_PUNCT_RE = /^[\s,，。！？、；：.!?;:]+/;
var TAIL_PUNCT_RE = /[\s,，、；;:]+$/;

// 安全转字符串：null / undefined 统一成空串，转换失败也给空串。
function toText(value) {
  try {
    if (value === null || value === undefined) return "";
    return String(value);
  } catch (e) { return ""; }
}

// 删掉英文单词但保留「标识符」：带数字 / 下划线的 token（坐标、版本号、0123456789ab）原样留着，
// 纯字母且长度 >= 2 的才当英文单词删（单个字母可能是坐标轴 / 变量名）。
function stripLatinWords(line) {
  return toText(line).replace(/[A-Za-z0-9_]+/g, function (token) {
    if (/[0-9_]/.test(token)) return token;
    return token.length >= 2 ? "" : token;
  });
}

// 收拾删字之后的残局：压空格、去孤立斜杠、去孤立标点；失败时原样返回。
function tidySentence(line) {
  var s = toText(line);
  try {
    s = s.replace(SPACE_RUN_RE, " ");
    s = s.replace(LONE_SLASH_RE, " ");
    s = s.replace(TAIL_SLASH_RE, "");
    s = s.replace(SPACE_BEFORE_PUNCT_RE, "$1");
    for (var i = 0; i < 3; i++) s = s.replace(DOUBLE_PUNCT_RE, "$1");
    s = s.replace(HEAD_PUNCT_RE, "");
    s = s.replace(TAIL_PUNCT_RE, "");
    return s.replace(/^\s+|\s+$/g, "");
  } catch (e) { return s; }
}

// 功能 8：终极单语过滤——按 targetLang 把另一种语言「硬删」干净，删空了就给一句兜底。
// zh：删掉所有连续两个以上的英文字母（"Got it" / "OK" 直接消失）；en：删掉所有汉字。
// 斜杠开头的服务器指令（/login xxx）原样放过，改了就会报语法错误。失败时退回原文，绝不抛错。
function forceMonolingual(text, targetLang) {
  var raw = toText(text);
  if (raw.length === 0) return "";
  try {
    if (raw.charAt(0) === "/") return raw;
    var wantEn = toText(targetLang).toLowerCase() === "en";
    var fallback = wantEn ? "ok" : ZH_YES;
    var lines = raw.split(/\r?\n/);
    var kept = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var pure = wantEn ? line.replace(CJK_CHAR_RE, "") : stripLatinWords(line);
      pure = tidySentence(pure);
      if (pure.length > 0) kept.push(pure);
    }
    if (kept.length === 0) return fallback;
    return kept.join("\n");
  } catch (e) {
    return raw;
  }
}

// 功能 1：数一数文本里有几个 CJK 字符。
function countCjk(text) {
  var s = toText(text);
  var n = 0;
  for (var i = 0; i < s.length; i++) {
    if (CJK_RE.test(s.charAt(i))) n = n + 1;
  }
  return n;
}

// 功能 2：数一数文本里有几个拉丁字母。
function countLatin(text) {
  var s = toText(text);
  var n = 0;
  for (var i = 0; i < s.length; i++) {
    if (LATIN_RE.test(s.charAt(i))) n = n + 1;
  }
  return n;
}

// 功能 3：文本里有没有中文（判定语言用）。
function hasCjk(text) {
  return countCjk(text) > 0;
}

// 功能 4：判定玩家说的是哪种语言——有中文就是 zh，纯英文才是 en，其它（纯数字 / 纯符号）按 zh。
// 玩家说中文时哪怕夹了英文单词，也必须整句中文回，所以「有一个汉字就算 zh」。
function detectLang(text) {
  var s = toText(text);
  if (s.length === 0) return "zh";
  if (countCjk(s) > 0) return "zh";
  if (countLatin(s) > 0) return "en";
  return "zh";
}

// 功能 5：按语言从两条候选里取一条，只返回一种语言（调用方再也不用拼 "中文 / English"）。
function pick(lang, zh, en) {
  return toText(lang).toLowerCase() === "en" ? toText(en) : toText(zh);
}

// 功能 6：清洗一行——把「中文 / English」这种混排拆开，只留 lang 这一种语言。
// 两道闸：先按 " / " 拆双语对，再按逗号拆「Hello, 你好」这种半句混排；两侧同语言时一律不动。
function cleanLine(line, lang) {
  var s = toText(line);
  var wantZh = toText(lang).toLowerCase() !== "en";
  for (var guard = 0; guard < 4; guard++) {
    var m = /^(.*?)[ \t]*[\/|][ \t]*(.+)$/.exec(s);
    if (!m) break;
    var left = m[1];
    var right = m[2];
    var leftZh = hasCjk(left);
    var rightZh = hasCjk(right);
    if (leftZh === rightZh) break; // 两侧同语言，不是混排，原样保留
    if (wantZh) s = leftZh ? left : right;
    else s = leftZh ? right : left;
    s = s.replace(/^\s+|\s+$/g, "");
  }
  // 第二道闸：按逗号 / 分号切成半句，只保留玩家语言的半句（「Hello, 你好」→「你好」）。
  // 只有真的丢掉「外语半句」时才重写整句，否则原样返回——绝不改标点、绝不吞坐标。
  try {
    var parts = s.split(/[,，;；]/);
    if (parts.length > 1) {
      var kept = [];
      var dropped = false;
      for (var i = 0; i < parts.length; i++) {
        var piece = parts[i].replace(/^\s+|\s+$/g, "");
        if (piece.length === 0) continue;
        var pieceZh = hasCjk(piece);
        var pieceLatin = countLatin(piece) > 0;
        var neutral = !pieceZh && !pieceLatin;
        var foreign = wantZh ? (pieceLatin && !pieceZh) : pieceZh;
        if (foreign) { dropped = true; continue; }
        kept.push(piece); // 同语言半句 + 纯数字 / 纯符号半句都保留
      }
      if (dropped && kept.length > 0) s = kept.join(wantZh ? "，" : ", ");
    }
  } catch (e) { /* 拆半句失败就保留原句 */ }
  return s;
}

// 功能 7：清洗整段回复——逐行去混排、丢掉空行、压缩多余空格；最后再过一道硬过滤，失败原样返回。
function clean(text, lang) {
  var raw = toText(text);
  if (raw.length === 0) return "";
  try {
    var lines = raw.split(/\r?\n/);
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/[ \t]+/g, " ");
      line = cleanLine(line, lang).replace(/^\s+|\s+$/g, "");
      if (line.length > 0) out.push(line);
    }
    // 双保险：软清洗只拆「双语对 / 逗号混排」，剩下粘在一起的（"Got it 跟着你走"）靠硬过滤删干净。
    return forceMonolingual(out.join("\n"), lang);
  } catch (e) {
    return raw;
  }
}

// 对外导出：语言判定 + 单语取词 + 混排清洗 + 硬过滤 + 提示词铁律。
module.exports = {
  detectLang: detectLang,
  countCjk: countCjk,
  countLatin: countLatin,
  hasCjk: hasCjk,
  pick: pick,
  cleanLine: cleanLine,
  clean: clean,
  forceMonolingual: forceMonolingual,
  tidySentence: tidySentence,
  SYS_LANG_RULE: SYS_LANG_RULE,
  ZH_YES: ZH_YES,
  EN_YES: EN_YES
};
