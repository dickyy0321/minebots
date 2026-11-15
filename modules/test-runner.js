// ========================================
// 文件：modules/test-runner.js
// 功能：带 Trace ID 的全链路追踪测试——真实调用底层、真实耗时、按 10% 概率注入故障、日志推 GUI
// 依赖：./event-bus（可选）、./logger（可选）；无第三方库
// 导出：run / runSimple / newTraceId / getTrace / getTraces / lastTrace / summary / clear / setGuiSink / DEFAULTS
// 作者：MineBots
// ========================================
//
// 追踪模型 / trace model
//   一次 run 生成一个 traceId，链路里每一步是一个 span：
//   { traceId, spanId, name, startMs, elapsedMs, ok, error, injected }
//   底层调用是调用方传入的真实函数（不是桩），耗时用真实 setTimeout 计量。
//   故障注入默认 10%（可用 options.failureRate 覆盖，options.random 注入确定性随机源）。
// CommonJS，ES5 风格，无中文变量名

// 可选依赖：事件总线，缺失时追踪仍可独立运行。
var bus = null;
try { bus = require("./event-bus"); } catch (e) { bus = null; }

// 可选依赖：日志核心，system / warn 会推 GUI，info 只落文件。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
// 可选依赖：引擎控制中心（专家模式可关 Trace / 调故障率）；缺失时默认开启。
var engineControl = null;
try { engineControl = require("./engine-control"); } catch (e) { engineControl = null; }

// 常量：默认故障率 / 每步默认真实耗时 / 追踪与 span 上限 / 单链路最多步数。
var DEFAULT_FAILURE_RATE = 0.10;
var DEFAULT_STEP_MS = 12;
var MAX_STEP_MS = 2000;
var MAX_TRACES = 60;
var MAX_SPANS = 600;
var MAX_STEPS = 60;

// 常量：对外暴露的默认配置（自测与 GUI 展示用）。
var DEFAULTS = { failureRate: DEFAULT_FAILURE_RATE, stepMs: DEFAULT_STEP_MS, maxSteps: MAX_STEPS };

// 状态：traceId → trace 记录；guiSink 为可注入的 GUI 日志槽。
var traces = {};
var order = [];
var guiSink = null;
var counter = 0;

// 写系统日志：追踪开始 / 结束这类低频信息，推 GUI。
function logSystem(message) {
  try {
    if (logger && typeof logger.system === "function") { logger.system("[trace] " + message); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[trace] " + message); } catch (e2) { /* ignore */ }
}

// 写警告日志：链路里的失败推 GUI，用户能直接看见。
function logWarn(message) {
  try {
    if (logger && typeof logger.warn === "function") { logger.warn("[trace] " + message); return; }
  } catch (e) { /* 退回 console */ }
  try { console.warn("[trace] " + message); } catch (e2) { /* ignore */ }
}

// 写信息日志：单个 span 属高频信息，只落文件，禁止刷 GUI。
function logInfo(message) {
  try { if (logger && typeof logger.info === "function") logger.info("[trace] " + message); } catch (e) { /* ignore */ }
}

// 把异常拍成一行文本，避免在 catch 里再次抛错。
function errText(err) {
  try { if (err && err.message) return String(err.message); return String(err); }
  catch (e) { return "unknown error"; }
}

// 把数字补零成两位字符串，供 Trace ID 拼接使用。
function pad2(n) { return String(n).length < 2 ? "0" + String(n) : String(n); }

// 睡眠指定毫秒：await 期间定时器必须保持 ref，否则事件循环抽空会让链路半途退出。
function sleep(ms) {
  return new Promise(function (resolve) {
    try { setTimeout(resolve, ms); } catch (e) { resolve(); }
  });
}

// 把一条追踪日志同时送给 GUI 槽、logger.system 与事件总线；任一环节失败都被隔离。
function pushGui(line) {
  if (guiSink) {
    try { guiSink({ kind: "trace", text: line, at: Date.now() }); } catch (e) { /* 槽异常不影响链路 */ }
  }
  logSystem(line);
  try { if (bus && typeof bus.emit === "function") bus.emit("trace.log", { text: line }); } catch (e) { /* ignore */ }
}

// 把 span 事件广播到总线，供其它模块订阅（不推 GUI，避免刷屏）。
function pushSpan(span) {
  try { if (bus && typeof bus.emit === "function") bus.emit("trace.span", span); } catch (e) { /* ignore */ }
  logInfo("span " + span.spanId + " " + span.name + " " + span.elapsedMs + "ms ok=" + span.ok);
}

// 功能：生成一个新的 Trace ID（时间 + 进程内递增序号 + 随机尾），异常时也能给出唯一串。
function newTraceId() {
  counter = counter + 1;
  try {
    var d = new Date();
    var stamp = String(d.getFullYear()) + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
      "-" + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
    var tail = Math.floor(Math.random() * 100000);
    return "trace-" + stamp + "-" + String(counter) + "-" + String(tail);
  } catch (e) { return "trace-fallback-" + String(counter) + "-" + Date.now(); }
}

// 内部：登记一条新 trace，超出上限时丢最旧的；返回 trace 对象。
function openTrace(traceId, name, failureRate) {
  var rec = {
    traceId: traceId, name: String(name || "chain"), startedAt: Date.now(),
    finishedAt: 0, elapsedMs: 0, ok: true, failureRate: failureRate,
    spans: [], errors: 0, injected: 0, reason: ""
  };
  try {
    traces[traceId] = rec;
    order.push(traceId);
    while (order.length > MAX_TRACES) {
      var old = order.shift();
      try { delete traces[old]; } catch (e) { /* ignore */ }
    }
  } catch (e) { /* 内存登记失败不影响本次运行 */ }
  return rec;
}

// 读引擎开关：控制中心缺失或读失败时按开启处理，保证自测与老调用方不受影响。
function engineOn() {
  try {
    if (engineControl && typeof engineControl.isEnabled === "function") return engineControl.isEnabled("trace") === true;
  } catch (e) { /* 读失败按开启 */ }
  return true;
}

// 读专家面板的故障注入率（百分数转小数）；读不到退回内置 10%。
function configuredFailureRate() {
  try {
    if (engineControl && typeof engineControl.param === "function") {
      var pct = engineControl.param("trace", "traceFailureRate");
      if (pct >= 0 && pct <= 100) return pct / 100;
    }
  } catch (e) { /* 读失败用默认值 */ }
  return DEFAULT_FAILURE_RATE;
}

// 内部：把 rate 与 random 归一化，坏值一律回默认，保证注入行为可控。
function resolveOptions(options) {
  var opts = options && typeof options === "object" ? options : {};
  var rate = Number(opts.failureRate);
  if (isNaN(rate) || rate < 0 || rate > 1) rate = configuredFailureRate();
  var stepMs = Number(opts.stepMs);
  if (isNaN(stepMs) || stepMs < 0) stepMs = DEFAULT_STEP_MS;
  if (stepMs > MAX_STEP_MS) stepMs = MAX_STEP_MS;
  var rnd = typeof opts.random === "function" ? opts.random : Math.random;
  return {
    rate: rate,
    stepMs: Math.round(stepMs),
    random: rnd,
    stopOnError: opts.stopOnError === true,
    sink: typeof opts.sink === "function" ? opts.sink : null
  };
}

// 内部：真实执行一步底层调用；call 可以是函数，也可以是 { fn, args }；永不抛到外层。
async function invoke(step) {
  try {
    if (!step) return { ok: false, value: null, error: "missing step / 缺少步骤定义" };
    var fn = typeof step === "function" ? step : (typeof step.call === "function" ? step.call : (typeof step.fn === "function" ? step.fn : null));
    if (!fn) return { ok: false, value: null, error: "no callable / 没有可调用的底层函数" };
    var args = Array.isArray(step.args) ? step.args : [];
    var value = await fn.apply(null, args);
    if (value && typeof value === "object" && value.ok === false) {
      return { ok: false, value: value, error: value.message || "bottom layer failed / 底层返回失败" };
    }
    return { ok: true, value: value, error: "" };
  } catch (e) {
    return { ok: false, value: null, error: errText(e) };
  }
}

// 功能：跑一条带 Trace ID 的全链路；steps 为 [{ name, call, delayMs }] 或函数数组。
// 返回 { ok, traceId, name, steps, errors, injected, elapsedMs, spans, message }，永不 reject。
async function run(name, steps, options) {
  // 专家面板关掉 Trace：不生成 Trace ID、不调底层、不推 GUI 日志，等同模块停止运作。
  if (!engineOn()) {
    return { ok: false, disabled: true, traceId: "", name: String(name || ""), steps: 0,
      errors: 0, injected: 0, elapsedMs: 0, spans: [],
      message: "trace disabled / 全链路追踪已关闭" };
  }
  var cfg = resolveOptions(options);
  var traceId = newTraceId();
  var rec = openTrace(traceId, name, cfg.rate);
  var list = Array.isArray(steps) ? steps : [];
  if (list.length > MAX_STEPS) list = list.slice(0, MAX_STEPS);
  if (cfg.sink) {
    var prev = guiSink;
    guiSink = cfg.sink;
    rec.previousSink = prev;
  }
  pushGui("链路开始 / trace started: " + traceId + " (" + String(rec.name) + ") steps=" + list.length +
    " failureRate=" + cfg.rate);
  for (var i = 0; i < list.length; i++) {
    var step = list[i] || {};
    var label = String(step.name || ("step-" + (i + 1)));
    var delay = Number(step.delayMs);
    if (isNaN(delay) || delay < 0) delay = cfg.stepMs;
    if (delay > MAX_STEP_MS) delay = MAX_STEP_MS;
    var started = Date.now();
    var span = {
      traceId: traceId, spanId: traceId + ":" + (i + 1), index: i + 1, name: label,
      startMs: started, elapsedMs: 0, ok: true, error: "", injected: false,
      delayMs: delay, bottom: ""
    };
    // 真实耗时：不是把计时器调快，而是真的等到底层调用前后各有一段时间流逝。
    if (delay > 0) await sleep(delay);
    var result = await invoke(step);
    // 10% 故障注入：注入的是「链路级故障」，底层调用仍然真实执行过。
    var roll = 1;
    try { roll = Number(cfg.random()); } catch (e) { roll = 1; }
    if (isNaN(roll)) roll = 1;
    if (roll < cfg.rate) {
      span.injected = true;
      span.ok = false;
      span.error = "injected failure / 注入故障 (roll=" + roll.toFixed(3) + ")";
      rec.injected = rec.injected + 1;
    } else if (!result.ok) {
      span.ok = false;
      span.error = result.error || "bottom layer failed / 底层调用失败";
    }
    try { span.bottom = result.value === undefined || result.value === null ? "" : JSON.stringify(result.value).slice(0, 120); }
    catch (e) { span.bottom = ""; }
    span.elapsedMs = Date.now() - started;
    if (!span.ok) rec.errors = rec.errors + 1;
    try {
      if (rec.spans.length < MAX_SPANS) rec.spans.push(span);
    } catch (e) { /* span 写不进不影响链路 */ }
    pushSpan(span);
    if (!span.ok) {
      logWarn("链路异常 / trace step failed: " + traceId + " #" + (i + 1) + " " + label + " -> " + span.error);
      if (cfg.stopOnError) { rec.reason = "aborted / 链路已中止"; break; }
    }
  }
  rec.finishedAt = Date.now();
  rec.elapsedMs = rec.finishedAt - rec.startedAt;
  rec.ok = rec.errors === 0;
  var msg = "链路结束 / trace finished: " + traceId + " steps=" + rec.spans.length +
    " errors=" + rec.errors + " injected=" + rec.injected + " in " + rec.elapsedMs + "ms" +
    (rec.ok ? " · OK / 全绿" : " · FAILED / 有故障");
  pushGui(msg);
  if (cfg.sink && Object.prototype.hasOwnProperty.call(rec, "previousSink")) guiSink = rec.previousSink;
  try { if (bus && typeof bus.emit === "function") bus.emit("trace.done", { traceId: traceId, ok: rec.ok, errors: rec.errors }); }
  catch (e) { /* ignore */ }
  return {
    ok: rec.ok,
    traceId: traceId,
    name: rec.name,
    steps: rec.spans.length,
    errors: rec.errors,
    injected: rec.injected,
    elapsedMs: rec.elapsedMs,
    failureRate: cfg.rate,
    spans: copySpans(rec.spans),
    message: msg + " / " + (rec.ok ? "已完成 / completed" : "已完成但有故障 / completed with errors")
  };
}

// 功能：便捷入口——只给函数名数组与一个底层函数，其余全用默认；返回与 run 相同的结构。
function runSimple(name, names, bottom, options) {
  var steps = [];
  var labels = Array.isArray(names) ? names : [];
  for (var i = 0; i < labels.length; i++) {
    steps.push({ name: String(labels[i]), call: bottom, delayMs: DEFAULT_STEP_MS });
  }
  return run(name, steps, options);
}

// 内部：把 span 数组浅拷贝一份，防止调用方改坏内部记录。
function copySpans(list) {
  var out = [];
  try {
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      out.push({
        traceId: s.traceId, spanId: s.spanId, index: s.index, name: s.name,
        startMs: s.startMs, elapsedMs: s.elapsedMs, ok: s.ok, error: s.error,
        injected: s.injected, delayMs: s.delayMs, bottom: s.bottom
      });
    }
  } catch (e) { out = []; }
  return out;
}

// 功能：按 traceId 取一条追踪快照，不存在返回 null。
function getTrace(traceId) {
  try {
    var rec = traces[String(traceId || "")];
    if (!rec) return null;
    return {
      traceId: rec.traceId, name: rec.name, startedAt: rec.startedAt, finishedAt: rec.finishedAt,
      elapsedMs: rec.elapsedMs, ok: rec.ok, failureRate: rec.failureRate,
      errors: rec.errors, injected: rec.injected, reason: rec.reason, spans: copySpans(rec.spans)
    };
  } catch (e) { return null; }
}

// 功能：按时间顺序列出全部追踪摘要，limit 缺省返回全部。
function getTraces(limit) {
  var out = [];
  try {
    var n = Number(limit);
    var start = 0;
    if (!isNaN(n) && n > 0 && n < order.length) start = order.length - Math.floor(n);
    for (var i = start; i < order.length; i++) {
      var rec = traces[order[i]];
      if (!rec) continue;
      out.push({ traceId: rec.traceId, name: rec.name, ok: rec.ok, steps: rec.spans.length, errors: rec.errors, injected: rec.injected, elapsedMs: rec.elapsedMs });
    }
  } catch (e) { out = []; }
  return out;
}

// 功能：取最新一条追踪的完整快照，没有返回 null。
function lastTrace() {
  try {
    if (order.length === 0) return null;
    return getTrace(order[order.length - 1]);
  } catch (e) { return null; }
}

// 功能：汇总统计 { traces, spans, ok, failed, injected, totalElapsedMs, failureRate }。
function summary() {
  var spans = 0;
  var ok = 0;
  var failed = 0;
  var injected = 0;
  var elapsed = 0;
  try {
    for (var i = 0; i < order.length; i++) {
      var rec = traces[order[i]];
      if (!rec) continue;
      spans = spans + rec.spans.length;
      elapsed = elapsed + rec.elapsedMs;
      injected = injected + rec.injected;
      if (rec.ok) ok = ok + 1; else failed = failed + 1;
    }
  } catch (e) { /* 返回已统计部分 */ }
  return { traces: order.length, spans: spans, ok: ok, failed: failed, injected: injected, totalElapsedMs: elapsed, failureRate: DEFAULT_FAILURE_RATE };
}

// 功能：清空全部追踪记录，返回 { ok, cleared }。
function clear() {
  var n = 0;
  try { n = order.length; traces = {}; order = []; } catch (e) { n = 0; }
  return { ok: true, cleared: n, message: "cleared / 追踪记录已清空" };
}

// 功能：设置 GUI 日志槽（传 null 取消），返回 { ok, message }。
function setGuiSink(fn) {
  if (fn !== null && typeof fn !== "function") return { ok: false, message: "sink must be a function / 日志槽必须是函数" };
  guiSink = fn;
  return { ok: true, message: "gui sink updated / 日志槽已更新" };
}

// 对外导出：链路运行 / 追踪查询 / 汇总 / 槽设置 / 默认配置。
module.exports = {
  run: run,
  runSimple: runSimple,
  newTraceId: newTraceId,
  getTrace: getTrace,
  getTraces: getTraces,
  lastTrace: lastTrace,
  summary: summary,
  clear: clear,
  setGuiSink: setGuiSink,
  isEngineEnabled: engineOn,
  DEFAULTS: DEFAULTS,
  DEFAULT_FAILURE_RATE: DEFAULT_FAILURE_RATE,
  MAX_TRACES: MAX_TRACES,
  MAX_STEPS: MAX_STEPS
};
