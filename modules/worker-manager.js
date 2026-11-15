// ========================================
// 文件：modules/worker-manager.js
// 功能：并发底盘——用 worker_threads 把 bot 任务隔离到工作线程，主进程只负责 UI 渲染
// 依赖：worker_threads（Node 内置，可选降级）、./event-bus（可选）、./logger（可选）
// 导出：spawn / send / stop / stopAll / list / status / stats / setUiSink / isAvailable / MAX_WORKERS
// 作者：MineBots
// ========================================
//
// 为什么这样拆 / rationale
//   主进程（Electron BrowserWindow 所在线程）只做渲染与消息转发；
//   每个 bot 的心跳 / 计算放进独立 Worker，卡住也不会冻住窗口。
//   Worker 代码内联（eval 模式），不新增入口文件，也不连真实服务器。
//   真实 mineflayer 实例由业务层通过 send 的任务类型接入，本层只管生命周期。
// CommonJS，ES5 风格，无中文变量名

// 可选依赖：Node 内置线程库，缺失时整层降级为「不可用」，绝不抛错。
var threads = null;
try { threads = require("worker_threads"); } catch (e) { threads = null; }

// 可选依赖：事件总线，缺失时不影响线程管理。
var bus = null;
try { bus = require("./event-bus"); } catch (e) { bus = null; }

// 可选依赖：日志核心，缺失时退回 console。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：与 GUI 的 10 bot 上限一致 / 单次任务默认超时 / 每线程最多待处理任务。
var MAX_WORKERS = 10;
var DEFAULT_TIMEOUT_MS = 5000;
var MAX_PENDING = 32;
var MAX_SLEEP_MS = 2000;

// 工作线程源码：只处理纯计算与消息回显，不联网、不加载 mineflayer，测试可安全运行。
var WORKER_SOURCE = [
  "var port = require('worker_threads').parentPort;",
  "function reply(msg) { try { port.postMessage(msg); } catch (e) { /* ignore */ } }",
  "function work(job) {",
  "  var out = { id: job.id, ok: true, type: job.type, at: Date.now(), thread: true };",
  "  if (job.type === 'ping') { out.value = 'pong'; return out; }",
  "  if (job.type === 'sleep') { out.value = 'slept'; return out; }",
  "  if (job.type === 'echo') { out.value = job.payload; return out; }",
  "  if (job.type === 'compute') {",
  "    var n = Number(job.payload && job.payload.n) || 20000;",
  "    if (n > 2000000) n = 2000000;",
  "    var sum = 0;",
  "    for (var i = 0; i < n; i++) { sum = sum + (i % 7); }",
  "    out.value = sum; return out;",
  "  }",
  "  if (job.type === 'fail') { out.ok = false; out.message = 'injected worker failure / 注入的线程故障'; return out; }",
  "  out.ok = false; out.message = 'unknown job type / 未知任务类型'; return out;",
  "}",
  "port.on('message', function (job) {",
  "  try {",
  "    if (!job || typeof job !== 'object') { reply({ id: 0, ok: false, message: 'bad job / 任务格式非法' }); return; }",
  "    if (job.type === 'sleep') {",
  "      var ms = Number(job.payload && job.payload.ms) || 1;",
  "      if (ms < 0) ms = 0;",
  "      if (ms > 2000) ms = 2000;",
  "      setTimeout(function () { var r = work({ id: job.id, type: 'sleep', payload: job.payload }); r.slept = ms; reply(r); }, ms);",
  "      return;",
  "    }",
  "    reply(work(job));",
  "  } catch (e) { reply({ id: job && job.id ? job.id : 0, ok: false, message: String(e && e.message ? e.message : e) }); }",
  "});"
].join("\n");

// 状态：id → { worker, createdAt, jobs, errors, alive }；pending 为 jobId → 回调。
var pool = {};
var pending = {};
var uiSink = null;
var nextId = 0;
var nextJobId = 0;
var totalJobs = 0;

// 写系统日志（推 GUI）：只用于线程创建 / 退出这类低频事件。
function logSystem(message) {
  try {
    if (logger && typeof logger.system === "function") { logger.system("[worker-manager] " + message); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[worker-manager] " + message); } catch (e2) { /* ignore */ }
}

// 写信息日志：只落文件不推 GUI（任务回包是高频信息）。
function logInfo(message) {
  try { if (logger && typeof logger.info === "function") logger.info("[worker-manager] " + message); } catch (e) { /* ignore */ }
}

// 写警告日志：线程异常属于重要信息，推 GUI。
function logWarn(message) {
  try {
    if (logger && typeof logger.warn === "function") { logger.warn("[worker-manager] " + message); return; }
  } catch (e) { /* 退回 console */ }
  try { console.warn("[worker-manager] " + message); } catch (e2) { /* ignore */ }
}

// 把异常拍成一行文本，避免在 catch 里再次抛错。
function errText(err) {
  try { if (err && err.message) return String(err.message); return String(err); }
  catch (e) { return "unknown error"; }
}

// 广播到事件总线：模块缺失时静默跳过，绝不抛错。
function busEmit(name, payload) {
  try { if (bus && typeof bus.emit === "function") bus.emit(name, payload); } catch (e) { /* ignore */ }
}

// 把线程回包转给 UI 渲染槽：槽函数异常只记日志，不回流到线程层。
function forward(payload) {
  if (!uiSink) return false;
  try { uiSink(payload); return true; }
  catch (e) { logWarn("UI 转发失败 / ui sink failed: " + errText(e)); return false; }
}

// 功能：worker_threads 是否可用，返回布尔。
function isAvailable() {
  try { return !!(threads && typeof threads.Worker === "function"); }
  catch (e) { return false; }
}

// 内部：给某个 id 的全部待处理任务回一个失败体，避免请求永久悬挂。
function failPending(id, reason) {
  try {
    for (var key in pending) {
      if (!Object.prototype.hasOwnProperty.call(pending, key)) continue;
      if (pending[key].workerId !== id) continue;
      var item = pending[key];
      delete pending[key];
      try { if (item.timer) clearTimeout(item.timer); } catch (e) { /* ignore */ }
      try { item.resolve({ ok: false, workerId: id, message: reason }); } catch (e2) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
}

// 内部：处理一次线程回包，找到 pending 回调并兑现。
function onMessage(id, msg) {
  try {
    if (!msg || typeof msg !== "object") return false;
    var jobId = String(msg.id === undefined || msg.id === null ? "" : msg.id);
    var item = pending[jobId];
    if (!item) { logInfo("迟到的回包 / late reply: " + jobId); return false; }
    delete pending[jobId];
    try { if (item.timer) clearTimeout(item.timer); } catch (e) { /* ignore */ }
    var out = {
      ok: msg.ok !== false,
      workerId: id,
      jobId: jobId,
      type: msg.type || "",
      value: msg.value,
      elapsedMs: Date.now() - item.startedAt,
      slept: msg.slept,
      message: msg.message || (msg.ok !== false ? "ok / 完成" : "worker failed / 线程任务失败")
    };
    if (pool[id]) pool[id].jobs = pool[id].jobs + 1;
    forward({ kind: "worker.reply", workerId: id, jobId: jobId, ok: out.ok, elapsedMs: out.elapsedMs });
    busEmit("worker.reply", out);
    logInfo("job " + jobId + " done in " + out.elapsedMs + "ms / 任务完成");
    item.resolve(out);
    return true;
  } catch (e) {
    logWarn("回包处理失败 / reply handling failed: " + errText(e));
    return false;
  }
}

// 功能：创建一个工作线程，返回 { ok, id, message }；超上限或库缺失时返回 ok:false。
function spawn(options) {
  if (!isAvailable()) return { ok: false, id: "", message: "worker_threads 不可用 / worker_threads unavailable" };
  var keys = [];
  try { keys = Object.keys(pool); } catch (e) { keys = []; }
  if (keys.length >= MAX_WORKERS) {
    return { ok: false, id: "", message: "已达线程上限 / worker limit reached: " + MAX_WORKERS };
  }
  var id = "";
  try {
    nextId = nextId + 1;
    id = "worker-" + nextId;
    var opts = options && typeof options === "object" ? options : {};
    var worker = new threads.Worker(WORKER_SOURCE, { eval: true });
    pool[id] = { worker: worker, createdAt: Date.now(), jobs: 0, errors: 0, alive: true };
    worker.on("message", function (msg) { onMessage(id, msg); });
    worker.on("error", function (err) {
      try {
        if (pool[id]) pool[id].errors = pool[id].errors + 1;
        logWarn("[" + id + "] 线程报错 / worker error: " + errText(err));
        busEmit("worker.error", { workerId: id, message: errText(err) });
      } catch (e) { /* ignore */ }
    });
    worker.on("exit", function (code) {
      try {
        if (pool[id]) pool[id].alive = false;
        failPending(id, "worker exited / 线程已退出 (code " + code + ")");
        logSystem("[" + id + "] 线程退出 / worker exited (code " + code + ")");
        busEmit("worker.exit", { workerId: id, code: code });
      } catch (e) { /* ignore */ }
    });
    try { if (typeof worker.unref === "function") worker.unref(); } catch (e) { /* ignore */ }
    if (opts.label) pool[id].label = String(opts.label).slice(0, 60);
    logSystem("[" + id + "] 线程已创建 / worker spawned");
    busEmit("worker.spawn", { workerId: id, label: pool[id].label || "" });
    return { ok: true, id: id, message: "spawned / 线程已创建" };
  } catch (e) {
    try { delete pool[id]; } catch (e2) { /* ignore */ }
    return { ok: false, id: id, message: errText(e) };
  }
}

// 功能：向工作线程派一个任务，返回永不 reject 的 Promise（带真实超时）。
function send(id, type, payload, timeoutMs) {
  return new Promise(function (resolve) {
    var rec = null;
    try { rec = pool[id]; } catch (e) { rec = null; }
    if (!rec || !rec.alive) {
      resolve({ ok: false, workerId: String(id || ""), message: "worker not available / 线程不可用" });
      return;
    }
    var count = 0;
    try { count = Object.keys(pending).length; } catch (e) { count = 0; }
    if (count >= MAX_PENDING) {
      resolve({ ok: false, workerId: id, message: "too many pending jobs / 待处理任务过多" });
      return;
    }
    try {
      nextJobId = nextJobId + 1;
      totalJobs = totalJobs + 1;
      var jobId = "job-" + nextJobId;
      var ms = Number(timeoutMs);
      if (isNaN(ms) || ms <= 0) ms = DEFAULT_TIMEOUT_MS;
      if (ms > 60000) ms = 60000;
      var item = { workerId: id, startedAt: Date.now(), resolve: resolve, timer: null };
      pending[jobId] = item;
      item.timer = setTimeout(function () {
        try {
          if (!pending[jobId]) return;
          delete pending[jobId];
          resolve({ ok: false, workerId: id, jobId: jobId, message: "timeout / 线程任务超时" });
        } catch (e) { /* ignore */ }
      }, ms);
      try { if (item.timer && typeof item.timer.unref === "function") item.timer.unref(); } catch (e) { /* ignore */ }
      forward({ kind: "worker.send", workerId: id, jobId: jobId, type: String(type || "") });
      rec.worker.postMessage({ id: jobId, type: String(type || "ping"), payload: payload });
    } catch (e) {
      logWarn("派发失败 / dispatch failed: " + errText(e));
      resolve({ ok: false, workerId: id, message: errText(e) });
    }
  });
}

// 功能：停止单个线程（terminate 并清待处理任务），返回 { ok, id, message }。
function stop(id) {
  var rec = null;
  try { rec = pool[id]; } catch (e) { rec = null; }
  if (!rec) return { ok: false, id: String(id || ""), message: "worker not found / 线程不存在" };
  try {
    failPending(id, "worker stopped / 线程已停止");
    if (typeof rec.worker.terminate === "function") rec.worker.terminate();
    delete pool[id];
    logSystem("[" + id + "] 线程已停止 / worker stopped");
    busEmit("worker.stop", { workerId: id });
    return { ok: true, id: id, message: "stopped / 已停止" };
  } catch (e) { return { ok: false, id: id, message: errText(e) }; }
}

// 功能：停止全部线程，返回 { ok, count, message }。
function stopAll() {
  var ids = [];
  try { ids = Object.keys(pool); } catch (e) { ids = []; }
  var count = 0;
  for (var i = 0; i < ids.length; i++) {
    try { if (stop(ids[i]).ok) count = count + 1; } catch (e) { /* ignore */ }
  }
  return { ok: true, count: count, message: "all stopped / 全部线程已停止" };
}

// 功能：列出全部线程状态快照数组（供 GUI 展示）。
function list() {
  var out = [];
  try {
    var ids = Object.keys(pool);
    for (var i = 0; i < ids.length; i++) {
      var rec = pool[ids[i]];
      out.push({ id: ids[i], label: rec.label || "", alive: rec.alive, jobs: rec.jobs, errors: rec.errors, uptimeMs: Date.now() - rec.createdAt });
    }
  } catch (e) { out = []; }
  return out;
}

// 功能：查单个线程状态，不存在返回 null。
function status(id) {
  try {
    var rec = pool[id];
    if (!rec) return null;
    return { id: id, label: rec.label || "", alive: rec.alive, jobs: rec.jobs, errors: rec.errors, uptimeMs: Date.now() - rec.createdAt };
  } catch (e) { return null; }
}

// 功能：读并发底盘统计 { available, workers, pending, totalJobs, maxWorkers, uiSink }。
function stats() {
  var n = 0;
  var p = 0;
  try { n = Object.keys(pool).length; p = Object.keys(pending).length; } catch (e) { n = 0; p = 0; }
  return { available: isAvailable(), workers: n, pending: p, totalJobs: totalJobs, maxWorkers: MAX_WORKERS, uiSink: !!uiSink };
}

// 功能：设置 UI 渲染槽（传 null 取消），返回 { ok, message }。
function setUiSink(fn) {
  if (fn !== null && typeof fn !== "function") return { ok: false, message: "sink must be a function / 渲染槽必须是函数" };
  uiSink = fn;
  return { ok: true, message: "ui sink updated / 渲染槽已更新" };
}

// 对外导出：线程生命周期 + 任务派发 + 状态查询。
module.exports = {
  spawn: spawn,
  send: send,
  stop: stop,
  stopAll: stopAll,
  list: list,
  status: status,
  stats: stats,
  setUiSink: setUiSink,
  isAvailable: isAvailable,
  MAX_WORKERS: MAX_WORKERS,
  DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
  MAX_SLEEP_MS: MAX_SLEEP_MS
};
