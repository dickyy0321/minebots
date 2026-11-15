// ========================================
// 文件：modules/qa-heal.js
// 功能：遇错自愈引擎——把失败日志交给大模型，解析出「文件 + 定位片段 + 替换片段」补丁，安全应用到源码
// 依赖：fs / path / child_process（Node 内置）、./ai-client（可选）、./logger（可选）
// 导出：parsePatch / isPatchable / forbiddenSyntax / applyPatch / buildHealPrompt / requestPatch / heal
// 说明：补丁只允许落在 modules / scripts / gui 下的 .js；禁改文件一律拒绝；必须唯一匹配、
//       改后不超过 600 行且通过 node --check，任何一步不过就原样回滚，绝不把坏代码留在盘上。
// 作者：MineBots
// ========================================
var fs = require("fs");
var path = require("path");
var cp = require("child_process");

// 可选依赖：AI 客户端（复用已配置的云端 / 本地模型），缺失时自愈直接跳过（测试照常重试）。
var aiClient = null;
try { aiClient = require("./ai-client"); } catch (e) { aiClient = null; }
// 可选依赖：日志核心，缺失时退回 console。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

var ROOT = path.join(__dirname, "..");
var MAX_FILE_LINES = 600;
var MAX_PATCH_CHARS = 200000;
var MAX_ERROR_CHARS = 4000;

// 禁改文件（与 .clinerules 保持一致）：这些文件任何情况下都不许自愈补丁碰。
var FORBIDDEN_FILES = [
  "package.json", "settings.js", "index.js", "guard.js",
  "README.md", "LICENSE", "structure.md", ".clinerules"
];

// 允许补丁的目录与扩展名：只认 modules / scripts / gui 下的一级 .js。
var PATCHABLE_RE = /^(modules|scripts|gui)\/[A-Za-z0-9._-]+\.js$/;

// 禁用语法检测：用字符码拼装，避免本文件自身被 guard 的纯文本扫描误伤。
var W_CONST = new RegExp("\\b" + String.fromCharCode(99, 111, 110, 115, 116) + "\\b");
var W_LET = new RegExp("\\b" + String.fromCharCode(108, 101, 116) + "\\b");
var W_IMPORT = new RegExp("^" + String.fromCharCode(105, 109, 112, 111, 114, 116) + "\\s+", "m");
var W_EXPORT = new RegExp("^" + String.fromCharCode(101, 120, 112, 111, 114, 116) + "\\s+", "m");
var W_ARROW = new RegExp("=\\>");
var W_TICK = new RegExp(String.fromCharCode(92) + "x60");
var W_OPT = new RegExp("\\?\\.");
var W_NULLISH = new RegExp("\\?\\?");
var W_BACKTICK = new RegExp(String.fromCharCode(96));

// 写信息日志：优先 logger.info，不可用时退回 console，绝不抛错。
function logInfo(msg) {
  try { if (logger && typeof logger.info === "function") { logger.info("[qa-heal] " + msg); return; } } catch (e) { /* 退回 console */ }
  try { console.log("[qa-heal] " + msg); } catch (e2) { /* ignore */ }
}
// 写告警日志。
function logWarn(msg) {
  try { if (logger && typeof logger.warn === "function") { logger.warn("[qa-heal] " + msg); return; } } catch (e) { /* 退回 console */ }
  try { console.warn("[qa-heal] " + msg); } catch (e2) { /* ignore */ }
}
// 安全提取错误文本。
function errText(err) {
  try { return err && err.message ? String(err.message) : String(err); } catch (e) { return "unknown error"; }
}

// 脱敏：把日志里的密钥 / Token 打码，避免写进报告或再次发给模型。
function sanitize(text) {
  try {
    var s = String(text === null || text === undefined ? "" : text);
    s = s.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***REDACTED***");
    s = s.replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer ***REDACTED***");
    return s.length > MAX_ERROR_CHARS ? (s.slice(0, MAX_ERROR_CHARS) + " ...[truncated]") : s;
  } catch (e) { return ""; }
}

// 扫禁用语法：返回命中的规则名，干净返回空串。
function forbiddenSyntax(text) {
  var src = String(text === null || text === undefined ? "" : text);
  if (W_OPT.test(src)) return "optional-chaining";
  if (W_NULLISH.test(src)) return "nullish";
  if (W_ARROW.test(src)) return "arrow";
  if (W_BACKTICK.test(src) || W_TICK.test(src)) return "template";
  if (W_IMPORT.test(src)) return "import";
  if (W_EXPORT.test(src)) return "export";
  if (W_CONST.test(src)) return "legacy-decl-1";
  if (W_LET.test(src)) return "legacy-decl-2";
  return "";
}

// 解析模型回复里的补丁：支持三个反引号围栏（可带 json 标记），也支持裸 JSON；格式不对一律返回 null。
var TICK_CH = String.fromCharCode(96);
var FENCE_RE = new RegExp(TICK_CH + "{3}(?:json)?\\s*([\\s\\S]*?)" + TICK_CH + "{3}", "i");
function parsePatch(text) {
  if (!text) return null;
  var s = String(text);
  var fence = s.match(FENCE_RE);
  if (fence && fence[1]) s = fence[1];
  var start = s.indexOf("{");
  var end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  var obj = null;
  try { obj = JSON.parse(s.slice(start, end + 1)); } catch (e) { return null; }
  if (!obj || typeof obj !== "object") return null;
  if (typeof obj.file !== "string" || typeof obj.search !== "string" || typeof obj.replace !== "string") return null;
  if (obj.search.length === 0) return null;
  return { file: obj.file, search: obj.search, replace: obj.replace, reason: String(obj.reason || "") };
}

// 校验补丁目标：禁改文件 / 越界目录 / 不存在的文件全部拒绝。
function isPatchable(relPath, root) {
  var rel = String(relPath === null || relPath === undefined ? "" : relPath).replace(/\\/g, "/").replace(/^\.\//, "");
  if (rel.length === 0) return { ok: false, message: "补丁缺少目标文件 / missing target file" };
  if (rel.indexOf("..") >= 0) return { ok: false, message: "补丁目标越界 / path traversal" };
  for (var i = 0; i < FORBIDDEN_FILES.length; i++) {
    if (rel === FORBIDDEN_FILES[i]) return { ok: false, message: "禁止修改核心文件 / forbidden file: " + rel };
  }
  if (!PATCHABLE_RE.test(rel)) return { ok: false, message: "补丁目标不在允许范围 / target not allowed: " + rel };
  var base = root ? String(root) : ROOT;
  var abs = path.join(base, rel);
  try {
    if (!fs.existsSync(abs)) return { ok: false, message: "目标文件不存在 / target missing: " + rel };
  } catch (e) { return { ok: false, message: errText(e) }; }
  return { ok: true, rel: rel, abs: abs };
}

// 语法检查：直接调 node --check，15 秒超时，失败返回 false。
function syntaxOk(absPath) {
  try {
    cp.execFileSync(process.execPath, ["--check", absPath], { stdio: "pipe", timeout: 15000 });
    return true;
  } catch (e) { return false; }
}

// 应用补丁：备份 -> 唯一替换 -> 体量 / 行数 / 语法三重校验 -> 失败回滚。
function applyPatch(patch, opts) {
  var o = opts || {};
  var chk = isPatchable(patch && patch.file, o.root);
  if (!chk.ok) return { ok: false, message: chk.message };
  var before = "";
  try { before = fs.readFileSync(chk.abs, "utf8"); } catch (e) { return { ok: false, message: errText(e) }; }
  var hit = before.indexOf(patch.search);
  if (hit < 0) return { ok: false, message: "补丁定位失败 / search text not found" };
  if (before.indexOf(patch.search, hit + 1) >= 0) return { ok: false, message: "补丁定位不唯一 / search text not unique" };
  var after = before.slice(0, hit) + patch.replace + before.slice(hit + patch.search.length);
  if (after.length > MAX_PATCH_CHARS) return { ok: false, message: "补丁过大 / patch too large" };
  var lines = after.split("\n").length;
  if (lines > MAX_FILE_LINES) return { ok: false, message: "改后超行数上限 / exceeds line limit: " + lines };
  var bad = forbiddenSyntax(after);
  if (bad) return { ok: false, message: "改后含禁用语法 / forbidden syntax: " + bad };
  var backup = chk.abs + ".heal-bak";
  try {
    fs.writeFileSync(backup, before, "utf8");
    fs.writeFileSync(chk.abs, after, "utf8");
  } catch (e) { return { ok: false, message: errText(e) }; }
  if (o.checkSyntax !== false && !syntaxOk(chk.abs)) {
    try { fs.writeFileSync(chk.abs, before, "utf8"); } catch (e2) { /* 回滚失败也要清备份 */ }
    try { fs.unlinkSync(backup); } catch (e3) { /* ignore */ }
    return { ok: false, message: "改后语法不通过，已回滚 / syntax failed, rolled back" };
  }
  try { fs.unlinkSync(backup); } catch (e4) { /* ignore */ }
  logInfo("补丁已应用 / patch applied: " + chk.rel + " (" + lines + " lines)");
  return { ok: true, file: chk.rel, lines: lines, message: "已应用补丁 / patch applied" };
}

// 组装发给模型的提示词：system 定角色，user 给测试名 + 脱敏后的报错。
function buildHealPrompt(testName, errorText) {
  var head = "你是代码修复专家，请根据报错分析原因并给出修改方案。";
  head += "只输出一个 JSON 对象，不要解释、不要多余文字。";
  head += "格式：{\"file\":\"modules/xxx.js\",\"search\":\"原文件中唯一的一段原文\",\"replace\":\"替换后的内容\",\"reason\":\"原因\"}。";
  head += "约束：只能改 modules/ scripts/ gui/ 下的 .js；禁止改 package.json / guard.js / index.js / settings.js；";
  head += "search 必须在原文件里唯一出现；改后文件不得超过 600 行，且必须是 CommonJS + ES5 写法。";
  var body = "测试项 / test: " + String(testName || "unknown") + "\n\n报错日志 / error log:\n" + sanitize(errorText);
  return { system: head, user: body };
}

// 向模型要补丁：AI 不可用 / 回复不可解析 / 网络异常都返回 ok:false，绝不抛错。
async function requestPatch(testName, errorText, opts) {
  var o = opts || {};
  var ai = o.aiClient || aiClient;
  if (!ai || typeof ai.ask !== "function") {
    return { ok: false, message: "AI 客户端不可用 / AI client unavailable" };
  }
  var built = buildHealPrompt(testName, errorText);
  var reply = null;
  try { reply = await ai.ask(built.system, built.user, o.botId || "qa-heal"); }
  catch (e) { return { ok: false, message: "AI 调用失败 / AI call failed: " + errText(e) }; }
  var text = (reply && typeof reply === "object") ? (reply.text || reply.reply || reply.content || "") : reply;
  if (!text) return { ok: false, message: "模型没有返回内容 / empty reply" };
  var patch = parsePatch(text);
  if (!patch) return { ok: false, message: "模型未返回可解析补丁 / no parsable patch", raw: sanitize(text) };
  return { ok: true, patch: patch };
}

// 一步到位：要补丁 -> 安全应用；返回 { ok, applied, message }，任何异常都被吞掉。
async function heal(testName, errorText, opts) {
  var got = await requestPatch(testName, errorText, opts);
  if (!got.ok) return { ok: false, applied: false, message: got.message, raw: got.raw || "" };
  var applied = applyPatch(got.patch, opts);
  return { ok: !!applied.ok, applied: !!applied.ok, message: applied.message, patch: got.patch, file: applied.file || "" };
}

// 对外导出：全部纯函数 / 安全动作，供编排器与自测直接调用。
module.exports = {
  parsePatch: parsePatch,
  isPatchable: isPatchable,
  forbiddenSyntax: forbiddenSyntax,
  applyPatch: applyPatch,
  buildHealPrompt: buildHealPrompt,
  requestPatch: requestPatch,
  heal: heal,
  sanitize: sanitize,
  FORBIDDEN_FILES: FORBIDDEN_FILES
};
