// ========================================
// 文件：modules/error-diagnose.js
// 功能：网络报错底层化——捕获 AggregateError 时遍历 err.errors 与 err.code，逐条给出中英双语原因、
//       端口拒绝 / 版本不匹配判定与可执行的排查建议，并打到控制台。
// 依赖：无（只用 Node 内置；console 输出全部包 try/catch）
// 导出：diagnose / report / adviceOf / linesOf / last / stats / reset / ADVICE / VERSION_HINTS
// 作者：MineBots
// ========================================
//
// 为什么需要：Node 的 AggregateError 把「所有连接尝试」塞在 err.errors 里，
//   只打印 err.message 只会看到一句毫无信息量的 "All promises were rejected"。
//   本模块拆出每个子错误的 code / address / port / syscall，直接告诉用户是端口拒绝、
//   超时、DNS 失败、协议版本不匹配还是 TLS 证书问题，并给出下一步建议。
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

// 常量：错误码到双语原因与排查建议的映射。
var ADVICE = {
  ECONNREFUSED: { zh: "端口拒绝连接 / connection refused", en: "Target port refused the connection", fix: "确认服务器已启动、端口与防火墙放行 / Check the server is up, port and firewall are open" },
  ETIMEDOUT: { zh: "连接超时 / connection timed out", en: "Connection timed out", fix: "检查 IP、端口与网络延迟 / Verify host, port and network latency" },
  EHOSTUNREACH: { zh: "主机不可达 / host unreachable", en: "No route to host", fix: "检查网关与路由 / Check gateway and routing" },
  ENETUNREACH: { zh: "网络不可达 / network unreachable", en: "Network unreachable", fix: "检查本机网络配置 / Check local network settings" },
  ENOTFOUND: { zh: "域名解析失败 / DNS lookup failed", en: "Host name not resolved", fix: "检查主机名拼写或改用 IP / Check hostname spelling or use an IP" },
  ECONNRESET: { zh: "连接被重置 / connection reset", en: "Peer reset the connection", fix: "服务器可能重启或踢出，稍后重连 / Server may have restarted, retry later" },
  EPIPE: { zh: "写入已关闭的连接 / broken pipe", en: "Write to closed socket", fix: "重连后再发送 / Reconnect before sending" },
  EPROTO: { zh: "协议不兼容 / protocol mismatch", en: "Protocol version mismatch", fix: "核对 MC 版本与 mineflayer 版本 / Match MC server and mineflayer versions" },
  ERR_TLS_CERT_ALTNAME_INVALID: { zh: "证书域名不匹配 / TLS certificate mismatch", en: "Certificate alt name invalid", fix: "检查代理或证书 / Check proxy or certificate" },
  CERT_HAS_EXPIRED: { zh: "证书已过期 / certificate expired", en: "TLS certificate expired", fix: "更新证书或调整测试环境校验 / Renew certificate or adjust verification for tests" },
  EADDRINUSE: { zh: "本地端口被占用 / local port in use", en: "Address already in use", fix: "换端口或结束占用进程 / Pick another port or stop the owner" },
  EACCES: { zh: "权限不足 / permission denied", en: "Access denied", fix: "以合适权限运行或换高端口 / Run with proper rights or use a high port" }
};
// 常量：版本 / 协议不匹配的文本特征。
var VERSION_HINTS = ["protocol", "version", "outdated", "unsupported", "incompatible", "版本", "协议", "不匹配", "过旧"];
// 运行时：最近一次诊断与计数。
var lastReport = null;
var totals = { reports: 0, aggregate: 0, causes: 0, versionIssues: 0 };

// 安全转字符串：null / undefined 归一成空串。
function toText(value) {
  try { if (value === null || value === undefined) return ""; return String(value); } catch (e) { return ""; }
}
// 取错误文本，catch 里绝不再次抛错。
function errText(err) {
  try { if (!err) return "unknown error / 未知错误"; if (typeof err === "string") return err; if (err.message) return toText(err.message); return toText(err); }
  catch (e) { return "unknown error / 未知错误"; }
}
// 功能：按错误码查双语原因与排查建议；未知码给通用建议。
function adviceOf(code) {
  try {
    var key = toText(code).toUpperCase().trim();
    if (ADVICE[key]) return { ok: true, code: key, zh: ADVICE[key].zh, en: ADVICE[key].en, fix: ADVICE[key].fix };
    return { ok: false, code: key, zh: "未分类错误 / unclassified error", en: "Unclassified network error: " + key,
      fix: "检查服务端日志与网络连通性 / Inspect server logs and connectivity" };
  } catch (e) { return { ok: false, code: "", zh: "诊断失败 / diagnose failed", en: errText(e), fix: "重试 / Retry" }; }
}
// 判断文本里是否含版本 / 协议不匹配特征。
function looksVersion(text) {
  try {
    var low = toText(text).toLowerCase();
    for (var i = 0; i < VERSION_HINTS.length; i++) if (low.indexOf(VERSION_HINTS[i]) >= 0) return true;
  } catch (e) { return false; }
  return false;
}
// 把一个子错误整理成一条原因记录：code / 端口 / 地址 / 双语原因 / 建议。
function causeOf(err, index) {
  var out = { index: index, code: "", message: "", address: "", port: 0, syscall: "", zh: "", en: "", fix: "", version: false };
  try {
    out.code = toText(err && err.code);
    out.message = errText(err);
    out.address = toText(err && (err.address || err.hostname || err.host));
    out.port = Number(err && err.port) || 0;
    out.syscall = toText(err && err.syscall);
    out.version = looksVersion(out.message) || out.code === "EPROTO";
    var adv = adviceOf(out.code);
    if (!adv.ok && out.version) {
      out.code = out.code || "VERSION_MISMATCH";
      adv = { zh: "MC 版本或协议不匹配 / game version or protocol mismatch",
        en: "Client and server protocol versions do not match",
        fix: "把 mineflayer 与服务器版本对齐 / Align mineflayer with the server version" };
    }
    out.zh = adv.zh; out.en = adv.en; out.fix = adv.fix;
  } catch (e) { out.message = errText(e); }
  return out;
}
// 把错误展开成子错误数组：AggregateError 优先遍历 err.errors，普通错误作为单元素。
function errorsOf(err) {
  var list = [];
  try {
    if (err && Array.isArray(err.errors) && err.errors.length > 0) {
      for (var i = 0; i < err.errors.length; i++) list.push(err.errors[i]);
      return list;
    }
  } catch (e) { /* 退化成单错误 */ }
  list.push(err);
  return list;
}
// 功能：诊断任意错误，返回 { ok, aggregate, name, message, causes, version, summary }，绝不抛错。
function diagnose(err) {
  var out = { ok: true, aggregate: false, name: "", message: "", causes: [], version: false, summary: "" };
  try {
    out.name = toText(err && err.name) || "Error";
    out.message = errText(err);
    out.aggregate = out.name === "AggregateError" || !!(err && Array.isArray(err.errors));
    var raw = errorsOf(err);
    for (var i = 0; i < raw.length; i++) out.causes.push(causeOf(raw[i], i + 1));
    for (var j = 0; j < out.causes.length; j++) if (out.causes[j].version) out.version = true;
    if (looksVersion(out.message)) out.version = true;
    totals.causes = totals.causes + out.causes.length;
    if (out.aggregate) totals.aggregate = totals.aggregate + 1;
    if (out.version) totals.versionIssues = totals.versionIssues + 1;
    out.summary = out.causes.length > 0 ? out.causes[0].zh + " / " + out.causes[0].en : "unknown / 未知";
    return out;
  } catch (e) {
    out.ok = false; out.message = errText(e); out.causes = [causeOf(e, 1)];
    return out;
  }
}
// 功能：生成可打印的中英双语诊断行；不改任何状态。
function linesOf(err) {
  var lines = [];
  try {
    var causes = diagnose(err).causes;
    lines.push("[network] " + causes.length + " 个底层原因 / underlying causes:");
    for (var i = 0; i < causes.length; i++) {
      var c = causes[i];
      var where = c.address ? " " + c.address + (c.port ? ":" + c.port : "") : "";
      lines.push("  #" + (i + 1) + " [" + (c.code || "NO_CODE") + "]" + where + " " + c.zh + " / " + c.en);
      lines.push("      -> " + c.fix);
      if (c.message) lines.push("      msg: " + c.message.slice(0, 120));
    }
    lines.push("[network] 汇总 / summary: " + (causes[0] ? causes[0].zh : "unknown / 未知"));
  } catch (e) { lines.push("[network] 诊断异常 / diagnose error: " + errText(e)); }
  return lines;
}
// 功能：把诊断打到控制台（中英双语），并记住最后一次；返回结构化结果。
function report(err) {
  var result = diagnose(err);
  try {
    var lines = linesOf(err);
    for (var i = 0; i < lines.length; i++) console.error(lines[i]);
  } catch (e) { /* 控制台不可用时静默 */ }
  lastReport = result;
  totals.reports = totals.reports + 1;
  return result;
}
// 功能：读最近一次诊断结果。
function last() { return lastReport; }
// 功能：读统计快照。
function stats() {
  return { ok: true, reports: totals.reports, aggregate: totals.aggregate,
    causes: totals.causes, versionIssues: totals.versionIssues, hasLast: !!lastReport };
}
// 功能：复位统计与最近诊断。
function reset() {
  lastReport = null;
  totals = { reports: 0, aggregate: 0, causes: 0, versionIssues: 0 };
  return { ok: true, message: "error diagnose reset / 网络诊断已复位" };
}
// 对外导出。
module.exports = {
  diagnose: diagnose, report: report, adviceOf: adviceOf, linesOf: linesOf,
  last: last, stats: stats, reset: reset, ADVICE: ADVICE, VERSION_HINTS: VERSION_HINTS
};
