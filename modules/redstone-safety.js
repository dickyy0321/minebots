// ========================================
// 文件：modules/redstone-safety.js
// 功能：红石电路安全与限流——监听 bot.time.timeOfDay 与 bot.entity.ping，按两次采样的游戏 tick
//       增量估算服务器 TPS；TPS < 18 或 Ping > 200ms 时自动降低全部高频触发器频率（默认 2 倍间隔），
//       并在公屏 bot.chat 发送双语警告「服务器负载过高，已自动降频。」；负载恢复后自动回升到原频率。
// 依赖：./redstone-trigger（可选）、./engine-control（可选）、./event-bus（可选）、./logger（可选）
// 导出：registerBot / attach / readTelemetry / estimateTps / sample / evaluate / apply /
//       check / start / stop / stats / reset / TPS_THRESHOLD / PING_LIMIT
// 作者：MineBots
// ========================================
//
// 设计 / design
//   1. mineflayer 的 bot.time.timeOfDay 每游戏 tick +1（0..23999 回绕），bot.entity.ping 是当前延迟；
//      两次采样的 tick 差除以真实经过秒数即 TPS，满速为 20。回绕时补 24000。
//   2. 迟滞阈值：降频 TPS<18 / ping>200，恢复 TPS>=19.5 且 ping<=150，避免在阈值附近来回抖动刷屏。
//   3. 每个 taskId 记住降频前的原始间隔，恢复时精确还原；限流只重排定时器，不重建触发器、不丢计数。
//   4. 状态未变化时不重复发公屏消息；采样级信息只落文件日志，绝不刷 GUI。
// CommonJS，ES5 风格，无中文变量名；所有外部调用包 try/catch，定时器一律 unref。
var trigger = null;
try { trigger = require("./redstone-trigger"); } catch (e) { trigger = null; }
var engineControl = null;
try { engineControl = require("./engine-control"); } catch (e) { engineControl = null; }
var bus = null;
try { bus = require("./event-bus"); } catch (e) { bus = null; }
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：降频 / 恢复阈值、采样间隔、降频倍数、内部状态。
var TPS_THRESHOLD = 18;
var TPS_RECOVER = 19.5;
var PING_LIMIT = 200;
var PING_RECOVER = 150;
var DEFAULT_SAMPLE_MS = 1000;
var THROTTLE_FACTOR = 2;
var DAY_TICKS = 24000;
var bots = {};
var lastSample = {};
var originals = {};
var level = "normal";
var timer = null;
var counters = { samples: 0, throttles: 0, restores: 0, retuned: 0, chats: 0, failed: 0 };

// 写文件日志：采样属高频信息，只落文件不刷 GUI。
function logInfo(msg) {
  try { if (logger && typeof logger.info === "function") logger.info("[redstone-safety] " + msg); } catch (e) { /* ignore */ }
}
// 写系统日志：降频 / 恢复属低频事件，推 GUI。
function logSystem(msg) {
  try { if (logger && typeof logger.system === "function") { logger.system("[redstone-safety] " + msg); return; } }
  catch (e) { /* 退回 console */ }
  try { console.log("[redstone-safety] " + msg); } catch (e2) { /* ignore */ }
}
// 广播低频事件：总线缺失时静默跳过。
function emit(name, payload) {
  try { if (bus && typeof bus.emit === "function") bus.emit(name, payload); } catch (e) { /* ignore */ }
}
// 安全转错误文本：catch 里绝不二次抛错。
function errText(err) {
  try { if (err && err.message) return String(err.message); return String(err); }
  catch (e) { return "unknown error / 未知错误"; }
}
// 安全转字符串：null / undefined 统一成空串。
function toText(value) {
  try { return value === null || value === undefined ? "" : String(value); } catch (e) { return ""; }
}
// 安全转数值：坏值回 fallback。
function toNum(value, fallback) {
  try { var n = Number(value); if (isNaN(n) || !isFinite(n)) return fallback; return n; }
  catch (e) { return fallback; }
}
// 夹取数值到 [lo, hi]，坏值回 fallback。
function clamp(value, lo, hi, fallback) {
  var n = toNum(value, fallback);
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
// 注册机器人实例：支持 registerBot(id, bot) 与 registerBot(bot)；坏值返回 ok:false。
function registerBot(botId, bot, options) {
  var out = { ok: false, botId: "", message: "bot not ready / 机器人未就绪" };
  try {
    var id = botId, instance = bot;
    if (botId && typeof botId === "object") { instance = botId; id = toText(botId.username || botId.name || "default"); }
    if (!instance || typeof instance !== "object") return out;
    id = toText(id) || "default";
    bots[id] = instance;
    delete lastSample[id];
    out.ok = true;
    out.botId = id;
    out.message = "bot registered / 机器人已注册";
  } catch (e) { out.message = errText(e); }
  return out;
}
// 按 id 取机器人；缺失时返回注册表中的第一个。
function botOf(botId) {
  try {
    if (botId && typeof botId === "object") return botId;
    if (botId && bots[toText(botId)]) return bots[toText(botId)];
    var keys = Object.keys(bots);
    return keys.length > 0 ? bots[keys[0]] : null;
  } catch (e) { return null; }
}
// 读一次遥测：timeOfDay / age / entity.ping；options 可注入 tps / ping / timeOfDay 供离线自测。
function readTelemetry(bot, options) {
  var out = { ok: true, timeOfDay: 0, gameTicks: 0, ping: 0, at: Date.now(), source: "injected" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var b = bot && typeof bot === "object" ? bot : {};
    var time = b.time && typeof b.time === "object" ? b.time : {};
    var entity = b.entity && typeof b.entity === "object" ? b.entity : {};
    var player = b.player && typeof b.player === "object" ? b.player : {};
    out.timeOfDay = opts.timeOfDay !== undefined ? toNum(opts.timeOfDay, 0) : toNum(time.timeOfDay, 0);
    out.gameTicks = toNum(time.age, out.timeOfDay);
    out.ping = opts.ping !== undefined ? toNum(opts.ping, 0) : toNum(entity.ping, toNum(player.ping, 0));
    out.at = opts.at !== undefined ? toNum(opts.at, Date.now()) : Date.now();
    out.source = opts.timeOfDay !== undefined || opts.ping !== undefined ? "injected" : "mineflayer";
  } catch (e) { out.ok = false; }
  return out;
}
// 由相邻两次采样估算 TPS：tick 差 / 真实秒数，满速 20；回绕补 24000，坏值回 20。
function estimateTps(prev, cur) {
  try {
    if (!prev || !cur) return 20;
    var elapsedMs = cur.at - prev.at;
    if (elapsedMs <= 0) return 20;
    var delta = 0;
    if (cur.gameTicks !== undefined && prev.gameTicks !== undefined && cur.gameTicks !== prev.gameTicks) {
      delta = cur.gameTicks - prev.gameTicks;
    } else {
      delta = cur.timeOfDay - prev.timeOfDay;
      if (delta < 0) delta = delta + DAY_TICKS;
    }
    if (delta < 0) delta = 0;
    return clamp(delta / (elapsedMs / 1000), 0, 20, 20);
  } catch (e) { return 20; }
}
// 采样一次并缓存：返回 { ok, tps, ping, ready, telemetry }；首次采样 ready:false 且 tps 取注入值或 20。
function sample(botId, options) {
  var out = { ok: false, tps: 20, ping: 0, ready: false, telemetry: null, message: "no bot / 没有可用机器人" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var id = toText(botId) || "default";
    var bot = botOf(botId);
    var telemetry = readTelemetry(bot, opts);
    out.telemetry = telemetry;
    out.ping = telemetry.ping;
    var prev = lastSample[id];
    var tps = opts.tps !== undefined ? clamp(opts.tps, 0, 20, 20) : estimateTps(prev, telemetry);
    lastSample[id] = telemetry;
    out.tps = Math.round(tps * 10) / 10;
    out.ready = !!prev || opts.tps !== undefined;
    out.ok = true;
    out.message = "sample ok / 采样完成";
    counters.samples = counters.samples + 1;
    logInfo("采样 / sample: bot=" + id + " tps=" + out.tps + " ping=" + out.ping +
      "ms timeOfDay=" + telemetry.timeOfDay + " ready=" + out.ready);
  } catch (e) {
    counters.failed = counters.failed + 1;
    out.message = errText(e);
  }
  return out;
}
// 评估当前状态：迟滞阈值决定是否降频 / 恢复；返回 level / reason / targetIntervalMs / changed。
function evaluate(snapshot, options) {
  var out = { ok: true, level: level, reason: "normal / 负载正常", changed: false,
    tps: 20, ping: 0, factor: THROTTLE_FACTOR, message: "" };
  try {
    var s = snapshot && typeof snapshot === "object" ? snapshot : {};
    var opts = options && typeof options === "object" ? options : {};
    out.tps = clamp(s.tps === undefined ? 20 : s.tps, 0, 20, 20);
    out.ping = clamp(s.ping === undefined ? 0 : s.ping, 0, 100000, 0);
    out.factor = Math.max(1, toNum(opts.factor, THROTTLE_FACTOR));
    var tpsLow = out.tps < toNum(opts.tpsThreshold, TPS_THRESHOLD);
    var pingHigh = out.ping > toNum(opts.pingLimit, PING_LIMIT);
    var recovered = out.tps >= toNum(opts.tpsRecover, TPS_RECOVER) &&
      out.ping <= toNum(opts.pingRecover, PING_RECOVER);
    if (level === "normal" && (tpsLow || pingHigh)) {
      out.level = "throttled";
      out.reason = tpsLow ? "TPS low / TPS 过低" : "ping high / 延迟过高";
      if (tpsLow && pingHigh) out.reason = "TPS low and ping high / TPS 过低且延迟过高";
    } else if (level === "throttled" && recovered) {
      out.level = "normal";
      out.reason = "load recovered / 负载已恢复";
    }
    out.changed = out.level !== level;
    out.message = out.level === "throttled" ? "throttle required / 需要降频" : "normal rate / 正常频率";
  } catch (e) { out.message = errText(e); }
  return out;
}
// 公屏双语警告 / 恢复通知；bot 或 chat 缺失时静默跳过，绝不抛错。
function announce(bot, nextLevel, info) {
  try {
    if (!bot || typeof bot.chat !== "function") return false;
    var text = nextLevel === "throttled"
      ? "[MineBots] 服务器负载过高，已自动降频。/ Server load high, trigger rate reduced. (TPS " +
        info.tps + ", ping " + info.ping + "ms)"
      : "[MineBots] 服务器负载恢复，已恢复触发频率。/ Server load recovered, trigger rate restored. (TPS " +
        info.tps + ", ping " + info.ping + "ms)";
    bot.chat(text);
    counters.chats = counters.chats + 1;
    logSystem(text);
    return true;
  } catch (e) { return false; }
}
// 对所有活跃触发器应用目标频率；降频记原始间隔，恢复精确还原；返回每条 retune 结果。
function apply(action, options) {
  var out = { ok: false, count: 0, retuned: [], level: level, message: "trigger unavailable / 触发器模块不可用" };
  try {
    var a = action && typeof action === "object" ? action : {};
    var opts = options && typeof options === "object" ? options : {};
    if (!trigger || typeof trigger.list !== "function" || typeof trigger.setIntervalMs !== "function") return out;
    var list = trigger.list();
    for (var i = 0; i < list.length; i++) {
      var rec = list[i];
      if (!rec || rec.active !== true) continue;
      var id = toText(rec.taskId);
      var base = originals[id];
      if (base === undefined) { base = toNum(rec.intervalMs, 50); originals[id] = base; }
      var target = a.level === "throttled" ? base * toNum(opts.factor, THROTTLE_FACTOR) : base;
      var hit = trigger.setIntervalMs(id, target, opts);
      out.retuned.push({ taskId: id, ok: hit.ok, previousMs: hit.previousMs, intervalMs: hit.intervalMs });
      if (hit.ok) out.count = out.count + 1;
      if (a.level === "normal") delete originals[id];
    }
    out.level = a.level || level;
    out.ok = true;
    out.message = out.count > 0 ? "rate applied / 触发频率已应用" : "no active trigger / 没有活跃触发器";
    counters.retuned = counters.retuned + out.count;
    logInfo("限流应用 / apply: level=" + out.level + " triggers=" + out.count);
  } catch (e) { out.message = errText(e); }
  return out;
}
// 完整闭环：采样 → 评估 → 应用 + 状态变化时公屏播报；返回可诊断快照。
function check(botId, options) {
  var out = { ok: false, level: level, tps: 20, ping: 0, changed: false, throttled: false,
    count: 0, retuned: [], reason: "", message: "check failed / 检查失败" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var snap = sample(botId, opts);
    var verdict = evaluate(snap, opts);
    out.tps = verdict.tps;
    out.ping = verdict.ping;
    out.reason = verdict.reason;
    out.changed = verdict.changed;
    out.level = verdict.level;
    out.throttled = verdict.level === "throttled";
    if (verdict.changed) {
      var bot = botOf(botId);
      announce(bot, verdict.level, verdict);
      if (verdict.level === "throttled") counters.throttles = counters.throttles + 1;
      else counters.restores = counters.restores + 1;
      level = verdict.level;
      emit(verdict.level === "throttled" ? "redstone.safety.throttle" : "redstone.safety.restored",
        { tps: out.tps, ping: out.ping, reason: out.reason, at: Date.now() });
    }
    // 频率只在状态变化或显式 force 时重排，避免每秒都重置漂移基准。
    if (verdict.changed || opts.force === true) {
      var applied = apply({ level: verdict.level }, opts);
      out.count = applied.count;
      out.retuned = applied.retuned;
    }
    out.ok = true;
    out.message = out.throttled ? "throttled / 已降频" : "normal / 频率正常";
  } catch (e) {
    counters.failed = counters.failed + 1;
    out.message = errText(e);
  }
  return out;
}
// 启动周期采样（默认 1000ms）；定时器 unref，重复调用不会叠加，坏间隔回默认。
function start(botId, options) {
  var out = { ok: false, intervalMs: DEFAULT_SAMPLE_MS, message: "already running / 已在运行" };
  try {
    if (timer) return out;
    var opts = options && typeof options === "object" ? options : {};
    var ms = toNum(opts.intervalMs, DEFAULT_SAMPLE_MS);
    if (ms < 100) ms = 100;
    out.intervalMs = ms;
    timer = setInterval(function () {
      try { check(botId, opts); } catch (eTick) { logInfo("巡检异常 / poll failed: " + errText(eTick)); }
    }, ms);
    try { if (timer && timer.unref) timer.unref(); } catch (eUnref) { /* ignore */ }
    out.ok = true;
    out.message = "safety monitor started / 安全巡检已启动";
    logSystem(out.message + " interval=" + ms + "ms");
  } catch (e) { out.message = errText(e); }
  return out;
}
// 停止周期采样；定时器已清时返回 ok:true。
function stop() {
  try {
    if (timer) { try { clearInterval(timer); } catch (eClear) { /* ignore */ } }
    timer = null;
    return { ok: true, message: "safety monitor stopped / 安全巡检已停止" };
  } catch (e) { return { ok: false, message: errText(e) }; }
}
// 统计快照：采样 / 降频 / 恢复 / 重排 / 播报 / 失败次数与当前等级。
function stats() {
  return { ok: true, level: level, samples: counters.samples, throttles: counters.throttles,
    restores: counters.restores, retuned: counters.retuned, chats: counters.chats,
    failed: counters.failed, monitored: timer !== null, bots: Object.keys(bots).length };
}
// 清空内存状态并停表（不触碰真实 state/）；供自测隔离。
function reset() {
  try {
    stop();
    bots = {}; lastSample = {}; originals = {}; level = "normal";
    counters = { samples: 0, throttles: 0, restores: 0, retuned: 0, chats: 0, failed: 0 };
  } catch (e) { return { ok: false, message: errText(e) }; }
  return { ok: true, message: "safety state reset / 安全限流状态已重置" };
}

// 对外导出：注册 / 遥测 / 估算 / 采样 / 评估 / 应用 / 闭环 / 巡检 / 诊断。
module.exports = {
  registerBot: registerBot,
  attach: registerBot,
  readTelemetry: readTelemetry,
  estimateTps: estimateTps,
  sample: sample,
  evaluate: evaluate,
  apply: apply,
  check: check,
  start: start,
  stop: stop,
  stats: stats,
  reset: reset,
  TPS_THRESHOLD: TPS_THRESHOLD,
  PING_LIMIT: PING_LIMIT
};
