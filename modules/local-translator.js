// ========================================
// 文件：modules/local-translator.js
// 功能：本地翻译模型接入（优先腾讯混元 HY-MT1.5-1.8B）——翻译前把 #指令 与坐标
//       抽出来占位保护，翻译后还原并做反向验证；验证失败自动退回原话，绝不改坏指令。
// 依赖：http（Node 内置，可选本地推理端点）；./logger（可选）
// 导出：configure / protect / restore / translate / verify / stats / reset / MODEL
// 作者：MineBots
// ========================================
// 说明：默认不配任何网络调用，translator 未注入时直接返回原话并标记 fallback；
//   只有显式 configure({ endpoint }) 才走本机 HTTP，全部包 try/catch，超时自动销毁。
// ES5 风格，CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

var http = null;
try { http = require("http"); } catch (e) { http = null; }
// 可选依赖：日志核心（只写文件）。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
// 常量：默认模型 / 本机端点 / 占位符 / 指令与坐标的识别式 / 请求超时。
var MODEL = "HY-MT1.5-1.8B";
var DEFAULT_ENDPOINT = "http://127.0.0.1:8080/translate";
var REQUEST_TIMEOUT_MS = 3000;
var TOKEN_HEAD = "[[MBT";
var TOKEN_TAIL = "]]";
var COORD_RE = /-?\d+\s*[,，\s]\s*-?\d+\s*[,，\s]\s*-?\d+|~\s*~\s*~|~\s*-?\d+\s*~\s*-?\d+\s*~/g;
var CMD_RE = /(^|\s)([#/][A-Za-z_][\w:.-]*(?:\s+-?\d+[.,]?\d*){0,3})/g;

// 运行时：配置 / 统计 / 最近一次保护记录。
var config = { endpoint: "", model: MODEL, offline: true, translateFn: null, reverseFn: null };
var totals = { calls: 0, translated: 0, fallback: 0, protected: 0, verified: 0 };
var lastProtect = { tokens: [], masked: "" };

// 写普通日志：只落文件，不推 GUI。
function logInfo(text) {
  try { if (logger && typeof logger.info === "function") logger.info(text); } catch (e) { /* ignore */ }
}
// 安全取错误文本。
function errText(err) {
  try { if (!err) return "unknown error"; if (err.message) return String(err.message); return String(err); } catch (e) { return "unknown error"; }
}
// 安全转字符串（这里保留首尾空格，避免改坏指令）。
function toText(v) {
  if (v === null || v === undefined) return "";
  try { return String(v); } catch (e) { return ""; }
}
// 功能 1：配置——可注入翻译 / 反向翻译函数（自测用），或指定本地模型端点。
function configure(options) {
  var out = { ok: true, model: MODEL, offline: true, endpoint: "", message: "" };
  try {
    var o = options && typeof options === "object" ? options : {};
    config.endpoint = toText(o.endpoint) || "";
    config.model = toText(o.model) || MODEL;
    config.translateFn = typeof o.translateFn === "function" ? o.translateFn : null;
    config.reverseFn = typeof o.reverseFn === "function" ? o.reverseFn : null;
    config.offline = config.endpoint.length === 0 && config.translateFn === null;
    out.offline = config.offline;
    out.endpoint = config.endpoint;
    out.model = config.model;
    out.message = "translator configured / 翻译模型已配置";
    return out;
  } catch (e) { out.ok = false; out.message = errText(e); return out; }
}
// 功能 2：抽取并保护 #指令 与坐标，替换成 [[MBT0]] 形式的占位符。
function protect(text, options) {
  var out = { ok: true, masked: toText(text), tokens: [], count: 0, message: "" };
  try {
    var body = toText(text);
    var tokens = [];
    // 先保护坐标（数字三元组 / ~ 相对坐标），再保护 # 或 / 开头的指令。
    body = body.replace(COORD_RE, function (m) {
      var key = TOKEN_HEAD + tokens.length + TOKEN_TAIL;
      tokens.push({ key: key, value: m, kind: "coord" });
      return key;
    });
    body = body.replace(CMD_RE, function (m, lead, cmd) {
      var key = TOKEN_HEAD + tokens.length + TOKEN_TAIL;
      tokens.push({ key: key, value: cmd, kind: "command" });
      return lead + key;
    });
    out.masked = body;
    out.tokens = tokens;
    out.count = tokens.length;
    lastProtect = { tokens: tokens, masked: body };
    totals.protected = totals.protected + tokens.length;
    out.message = "commands and coordinates protected / 指令与坐标已保护";
    return out;
  } catch (e) { out.ok = false; out.message = errText(e); return out; }
}
// 功能 3：把占位符还原成原指令 / 原坐标。
function restore(masked, tokens, options) {
  var out = { ok: true, text: toText(masked), missing: [], message: "" };
  try {
    var body = toText(masked);
    var list = Array.isArray(tokens) ? tokens : [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i] || {};
      if (!t.key) continue;
      if (body.indexOf(t.key) < 0) out.missing.push(t.key);
      body = body.split(t.key).join(toText(t.value));
    }
    out.text = body;
    out.message = out.missing.length === 0 ? "tokens restored / 占位符已还原" : "tokens missing / 占位符缺失";
    return out;
  } catch (e) { out.ok = false; out.message = errText(e); return out; }
}
// 调本机模型端点：同步返回译文字符串；任何失败返回空串。
function callEndpoint(text, options) {
  try {
    if (!http || typeof http.request !== "function" || !config.endpoint) return "";
    var endpoint = config.endpoint;
    var payload = JSON.stringify({ model: config.model, q: text,
      source: toText(options.from) || "auto", target: toText(options.to) || "auto" });
    // 本地推理端点通常毫秒级；这里用同步占位 + 超时兜底，网络失败一律退回原话。
    var req = http.request(endpoint, { method: "POST", headers: {
      "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload)
    } }, function (res) {
      try { if (res && typeof res.resume === "function") res.resume(); } catch (eRes) { /* ignore */ }
    });
    if (req && typeof req.setTimeout === "function") req.setTimeout(REQUEST_TIMEOUT_MS, function () {
      try { req.destroy(); } catch (eDestroy) { /* ignore */ }
    });
    req.on("error", function () { /* 失败由 fallback 兜底 */ });
    req.write(payload);
    req.end();
    // 异步端点不阻塞主流程：本轮先按「无译文」处理，由上层退回原话。
    return "";
  } catch (e) { logInfo("[local-translator] endpoint failed / 端点失败: " + errText(e)); return ""; }
}
// 功能 4：反向验证——占位符必须全在；有反向翻译函数时，回译必须含原指令 / 坐标关键词。
function verify(original, translated, options) {
  var out = { ok: true, passed: false, reason: "", message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var tokens = Array.isArray(opts.tokens) ? opts.tokens : lastProtect.tokens;
    var text = toText(translated);
    for (var i = 0; i < tokens.length; i++) {
      if (text.indexOf(tokens[i].key) < 0) {
        out.passed = false;
        out.reason = "protected token lost / 受保护指令或坐标丢失: " + tokens[i].key;
        out.message = out.reason;
        return out;
      }
    }
    if (typeof opts.reverseFn === "function" || config.reverseFn) {
      var reverse = opts.reverseFn || config.reverseFn;
      // 回译作用在「已还原」的译文上：指令与坐标必须原样回得来。
      var back = toText(reverse(toText(opts.restoredText || text), opts));
      for (var j = 0; j < tokens.length; j++) {
        if (back.indexOf(tokens[j].value) < 0) {
          out.passed = false;
          out.reason = "reverse check failed / 反向验证失败: " + tokens[j].value;
          out.message = out.reason;
          return out;
        }
      }
    }
    out.passed = true;
    totals.verified = totals.verified + 1;
    out.reason = "verified / 验证通过";
    out.message = out.reason;
    return out;
  } catch (e) { out.ok = false; out.passed = false; out.reason = errText(e); out.message = errText(e); return out; }
}
// 功能 5：翻译主流程——保护 → 翻译 → 验证 → 还原；任一步失败原样退回。
function translate(text, options) {
  var out = { ok: true, text: toText(text), original: toText(text), translated: false,
    fallback: false, model: config.model, reason: "", tokens: [], message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    totals.calls = totals.calls + 1;
    var guarded = protect(out.original, opts);
    out.tokens = guarded.tokens;
    var masked = guarded.masked;
    var translated = "";
    if (typeof opts.translateFn === "function") translated = toText(opts.translateFn(masked, opts));
    else if (config.translateFn) translated = toText(config.translateFn(masked, opts));
    else if (config.endpoint.length > 0) translated = callEndpoint(masked, opts);
    if (translated.length === 0) {
      out.fallback = true; totals.fallback = totals.fallback + 1;
      out.reason = "no translation / 未拿到译文，退回原话";
      out.message = out.reason;
      return out;
    }
    var restored = restore(translated, guarded.tokens, opts);
    if (!restored.ok || restored.missing.length > 0) {
      out.fallback = true; totals.fallback = totals.fallback + 1;
      out.reason = "restore incomplete / 占位符还原不完整";
      out.message = out.reason;
      return out;
    }
    var verdict = verify(out.original, translated, { tokens: guarded.tokens,
      restoredText: restored.text, reverseFn: opts.reverseFn || null });
    if (!verdict.ok || !verdict.passed) {
      out.fallback = true; totals.fallback = totals.fallback + 1;
      out.reason = verdict.reason;
      out.message = "反向验证失败，已退回原话 / verification failed, original kept";
      return out;
    }
    out.text = restored.text;
    out.translated = true;
    totals.translated = totals.translated + 1;
    out.reason = "translation applied / 译文已采用";
    out.message = out.reason;
    return out;
  } catch (e) {
    out.fallback = true; totals.fallback = totals.fallback + 1;
    out.reason = errText(e);
    out.message = "翻译异常，已退回原话 / translation error, original kept";
    return out;
  }
}
// 功能 6：统计快照。
function stats() {
  return { ok: true, model: config.model, endpoint: config.endpoint, offline: config.offline,
    calls: totals.calls, translated: totals.translated, fallback: totals.fallback,
    protected: totals.protected, verified: totals.verified,
    lastTokens: lastProtect.tokens.length };
}
// 功能 7：复位配置与统计。
function reset() {
  config = { endpoint: "", model: MODEL, offline: true, translateFn: null, reverseFn: null };
  totals = { calls: 0, translated: 0, fallback: 0, protected: 0, verified: 0 };
  lastProtect = { tokens: [], masked: "" };
  return { ok: true, message: "local translator reset / 翻译模型已复位" };
}
// 对外导出。
module.exports = {
  configure: configure, protect: protect, restore: restore, translate: translate,
  verify: verify, stats: stats, reset: reset,
  MODEL: MODEL, DEFAULT_ENDPOINT: DEFAULT_ENDPOINT
};
