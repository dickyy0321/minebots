// ========================================
// 文件：modules/network.js
// 功能：带指数退避的 HTTP 请求；失败时把 AggregateError 等底层原因交给 error-diagnose 双语打屏，
//       并保留最近一次失败供控制台 / GUI 排查。
// 依赖：axios（可选，缺失时安全降级）、./error-diagnose（可选）、./logger（可选）
// 导出：request / lastError / stats / reset
// 作者：MineBots
// ========================================
// 说明：请求层不再吞掉错误原因；每次最终失败都会逐条打印端口拒绝 / 超时 / 版本不匹配等线索。
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

// 可选依赖：HTTP 客户端；缺失时所有请求安全返回 null。
var axios = null;
try { axios = require("axios"); } catch (e) { axios = null; }
// 可选依赖：底层诊断器。
var diagnose = null;
try { diagnose = require("./error-diagnose"); } catch (e) { diagnose = null; }
// 可选依赖：日志（只写文件）。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
// 运行时状态。
var lastFailure = null;
var totals = { requests: 0, retries: 0, failures: 0, succeeded: 0 };

// 写普通日志：只落文件，不推 GUI。
function logInfo(text) {
  try { if (logger && typeof logger.info === "function") logger.info(text); } catch (e) { /* ignore */ }
}
// 取错误文本，catch 里绝不再次抛错。
function errText(err) {
  try { if (!err) return "unknown error"; if (err.message) return String(err.message); return String(err); } catch (e) { return "unknown error"; }
}
// 等待若干毫秒；定时器 unref，绝不拖住进程退出。
function sleep(ms) {
  return new Promise(function (resolve) {
    try {
      var timer = setTimeout(resolve, ms);
      if (timer && typeof timer.unref === "function") timer.unref();
    } catch (e) { resolve(); }
  });
}
// 把最终失败交给诊断器：逐条双语打印底层原因，并记住结果。
function handleFailure(err) {
  var result = null;
  try {
    if (diagnose && typeof diagnose.report === "function") result = diagnose.report(err);
  } catch (e) { result = null; }
  lastFailure = { at: Date.now(), message: errText(err), report: result };
  totals.failures = totals.failures + 1;
  logInfo("[network] request failed / 请求失败: " + errText(err));
  return result;
}
// 发起一次请求；axios 缺失时直接返回 null，不抛错。
function once(cfg) {
  return new Promise(function (resolve) {
    try {
      if (!axios) { resolve({ ok: false, error: "axios missing / 缺少 axios 依赖" }); return; }
      Promise.resolve(axios(cfg)).then(function (res) { resolve({ ok: true, response: res }); },
        function (err) { resolve({ ok: false, error: err }); });
    } catch (err) { resolve({ ok: false, error: err }); }
  });
}
// 功能：发 HTTP 请求，按指数退避重试；全部失败返回 null 并双语诊断，绝不抛到顶层。
function request(options) {
  var opts = options && typeof options === "object" ? options : {};
  var cfg = { method: String(opts.method || "GET").toUpperCase(), url: opts.url,
    timeout: Number(opts.timeout) > 0 ? Number(opts.timeout) : 8000, headers: opts.headers || {} };
  if (opts.data) cfg.data = opts.data;
  var retries = typeof opts.retries === "number" && opts.retries >= 0 ? opts.retries : 3;
  totals.requests = totals.requests + 1;
  return new Promise(function (resolve) {
    function attempt(n) {
      once(cfg).then(function (r) {
        if (r.ok) { totals.succeeded = totals.succeeded + 1; resolve(r.response); return; }
        if (n >= retries) { handleFailure(r.error); resolve(null); return; }
        totals.retries = totals.retries + 1;
        var backoff = Math.min(1000 * Math.pow(2, n), 4000);
        sleep(backoff).then(function () { attempt(n + 1); }, function () { attempt(n + 1); });
      }, function (err) { handleFailure(err); resolve(null); });
    }
    try { attempt(0); } catch (err) { handleFailure(err); resolve(null); }
  });
}
// 功能：读最近一次失败（供 GUI / 控制台展示），没有则 null。
function lastError() { return lastFailure; }
// 功能：读统计快照。
function stats() {
  return { ok: true, requests: totals.requests, retries: totals.retries,
    failures: totals.failures, succeeded: totals.succeeded, hasLastError: !!lastFailure };
}
// 功能：复位统计与最近失败。
function reset() {
  lastFailure = null;
  totals = { requests: 0, retries: 0, failures: 0, succeeded: 0 };
  return { ok: true, message: "network reset / 网络状态已复位" };
}
// 对外导出。
module.exports = { request: request, lastError: lastError, stats: stats, reset: reset };
