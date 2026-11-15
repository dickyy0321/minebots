// ========================================
// 文件：modules/prefs.js
// 功能：界面 / 运行偏好的真实落盘（state/prefs.json）——测试模式、蜂巢思维、AI 编程、bot 对话、打字机、
//       精确建筑（engExactBuild，默认关）、红石触发频率（redstoneTickRate，默认 50ms）
//       以及【底层引擎控制】七大模块开关与参数
// 依赖：fs / path（Node 内置）、./logger（可选）
// 导出：DEFAULTS、load、save、get、getAll、getPath、reset
// 作者：MineBots
// ========================================
//
// 为什么不用 localStorage：界面里点下去的每一个开关都必须在 state/ 目录留下真实数据。
// 旧实现只写 localStorage，主进程完全不知道，等于「假开关」，这里统一收到主进程写盘。
// 测试隔离：环境变量 MINEBOTS_STATE_DIR 可替换 state 目录。
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

var fs = require("fs");
var path = require("path");
// 可选依赖：日志核心；缺失时退回 console。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
// 可选依赖：事件总线；每次落盘成功后广播，底层引擎无需重启即可感知改动。
var bus = null;
try { bus = require("./event-bus"); } catch (e) { bus = null; }

// 常量：默认偏好——打字机与七大底层引擎默认开启（开箱即用），其它高级开关默认关闭（宁严不松）。
// 引擎键的顺序与 modules/engine-control.js 的 SCHEMA 一一对应，改一处必须同步改另一处。
var DEFAULTS = {
  testMode: false,
  hiveMind: false,
  aiCode: false,
  botChat: false,
  typing: true,
  typingMode: "chunk",
  typingChunk: 12,
  typingPerCharMs: 33,
  typingCps: 30,
  engRadar: true, radarRadius: 64,
  engMotion: true, motionStrength: 5, motionDelayMs: 150,
  engTrace: true, traceFailureRate: 10,
  engAntiStuck: true, antiStuckWatchdogMs: 3000, antiStuckMaxRescues: 3,
  engProtocolForge: true, protocolMaxRetry: 3,
  engBehaviorTree: true, behaviorMaxTicks: 200,
  engExactBuild: false, redstoneTickRate: 50
};
// 常量：布尔型 / 数值型 / 枚举型字段，读盘时逐项清洗，坏值一律回默认。
var BOOL_KEYS = [
  "testMode", "hiveMind", "aiCode", "botChat", "typing",
  "engRadar", "engMotion", "engTrace", "engAntiStuck", "engProtocolForge", "engBehaviorTree",
  "engExactBuild"
];
var NUM_KEYS = {
  typingChunk: [3, 60], typingPerCharMs: [5, 200], typingCps: [5, 120],
  radarRadius: [16, 128],
  motionStrength: [1, 10], motionDelayMs: [50, 500],
  traceFailureRate: [0, 100],
  antiStuckWatchdogMs: [500, 10000], antiStuckMaxRescues: [1, 10],
  protocolMaxRetry: [0, 10],
  behaviorMaxTicks: [20, 1000],
  redstoneTickRate: [10, 1000]
};
var MODES = ["chunk", "delay", "off"];

// 写告警日志：优先 logger.warn，失败退回 console，绝不抛错。
function logWarn(message) {
  try {
    if (logger && typeof logger.warn === "function") logger.warn(message);
    else console.warn(message);
  } catch (e) { /* 日志失败不影响业务 */ }
}

// 安全取错误文本：catch 里再抛错就破红线了。
function getErrText(err) {
  try {
    if (!err) return "unknown error";
    if (err.message) return String(err.message);
    return String(err);
  } catch (e) { return "unknown error"; }
}

// 取 state 目录：允许用环境变量 MINEBOTS_STATE_DIR 覆盖（自测隔离用）。
function stateDir() {
  try {
    var custom = process.env.MINEBOTS_STATE_DIR;
    if (custom && String(custom).length > 0) return String(custom);
  } catch (e) { /* 读不到环境变量就用默认目录 */ }
  return path.join(process.cwd(), "state");
}

// 功能 6：偏好文件绝对路径（诊断 / 自测用）。
function getPath() {
  try { return path.join(stateDir(), "prefs.json"); } catch (e) { return "state/prefs.json"; }
}

// 常量：引擎开关键到内部名的映射，用于精确广播「哪个引擎被改了」。
var ENGINE_MAP = {
  engRadar: "radar", engMotion: "motion", engTrace: "trace", engAntiStuck: "antiStuck",
  typing: "typing", engProtocolForge: "protocolForge", engBehaviorTree: "behaviorTree",
  engExactBuild: "exactBuild", redstoneTickRate: "redstoneTick"
};

// 广播偏好变更：总线缺失或回调抛错都不影响落盘结果。
function announce(patch, clean) {
  try {
    if (!bus || typeof bus.emit !== "function") return;
    bus.emit("engine.changed", { prefs: clean, patch: patch, at: Date.now() });
    for (var key in ENGINE_MAP) {
      if (!Object.prototype.hasOwnProperty.call(ENGINE_MAP, key)) continue;
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      bus.emit("engine." + ENGINE_MAP[key] + ".changed", {
        key: ENGINE_MAP[key], enabled: clean[key] === true, at: Date.now()
      });
    }
  } catch (e) { /* 广播失败不影响落盘 */ }
}

// 深拷贝默认值，避免调用方改动内部常量。
function cloneDefaults() {
  var out = {};
  for (var k in DEFAULTS) {
    if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) out[k] = DEFAULTS[k];
  }
  return out;
}

// 把任意来源的偏好洗成合法结构：布尔只认 true/false，数值夹在范围内，模式只认白名单。
function normalize(raw) {
  var out = cloneDefaults();
  var src = raw && typeof raw === "object" ? raw : {};
  try {
    for (var i = 0; i < BOOL_KEYS.length; i++) {
      var bk = BOOL_KEYS[i];
      if (typeof src[bk] === "boolean") out[bk] = src[bk];
    }
    for (var nk in NUM_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(NUM_KEYS, nk)) continue;
      var range = NUM_KEYS[nk];
      var num = Number(src[nk]);
      if (isNaN(num)) continue;
      if (num < range[0]) num = range[0];
      if (num > range[1]) num = range[1];
      out[nk] = Math.round(num);
    }
    var mode = String(src.typingMode === null || src.typingMode === undefined ? "" : src.typingMode).toLowerCase();
    for (var m = 0; m < MODES.length; m++) {
      if (MODES[m] === mode) out.typingMode = mode;
    }
  } catch (e) { return cloneDefaults(); }
  return out;
}

// 功能 1：读偏好——文件不存在 / 坏掉都回默认值，绝不抛错。
function load() {
  try {
    var file = getPath();
    if (!fs.existsSync(file)) return cloneDefaults();
    var text = fs.readFileSync(file, "utf8");
    if (!text || text.replace(/\s+/g, "").length === 0) return cloneDefaults();
    return normalize(JSON.parse(text));
  } catch (err) {
    logWarn("[prefs] 读取失败，改用默认值 / read failed: " + getErrText(err));
    return cloneDefaults();
  }
}

// 原子写：先写 .tmp 再 rename，避免写一半留下坏文件；成功返回 true。
function writeAtomic(data) {
  try {
    var file = getPath();
    var dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    var tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    logWarn("[prefs] 写入失败 / write failed: " + getErrText(err));
    return false;
  }
}

// 功能 2：合并保存偏好（只改传进来的字段），返回 { ok, prefs } 或 { ok:false, error }。
function save(patch) {
  try {
    var next = normalize(load());
    var src = patch && typeof patch === "object" ? patch : {};
    var merged = {};
    for (var k in next) {
      if (Object.prototype.hasOwnProperty.call(next, k)) merged[k] = next[k];
    }
    for (var key in src) {
      if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
      if (src[key] === undefined) continue;
      merged[key] = src[key];
    }
    var clean = normalize(merged);
    if (!writeAtomic(clean)) return { ok: false, error: "write failed / 写入失败" };
    announce(src, clean);
    return { ok: true, prefs: clean };
  } catch (err) {
    return { ok: false, error: getErrText(err) };
  }
}

// 功能 3：读单个偏好键（不存在返回默认值）。
function get(key) {
  var all = load();
  var name = String(key === null || key === undefined ? "" : key);
  if (Object.prototype.hasOwnProperty.call(all, name)) return all[name];
  return undefined;
}

// 功能 4：读全部偏好（新副本，调用方改了也不影响磁盘）。
function getAll() {
  return load();
}

// 功能 5：恢复默认（写回磁盘），返回 { ok, prefs }。
function reset() {
  var clean = cloneDefaults();
  if (!writeAtomic(clean)) return { ok: false, error: "write failed / 写入失败" };
  announce(clean, clean);
  return { ok: true, prefs: clean };
}

// 对外导出：读 / 写 / 取单键 / 取全部 / 路径 / 复位。
module.exports = {
  DEFAULTS: DEFAULTS,
  load: load,
  save: save,
  get: get,
  getAll: getAll,
  getPath: getPath,
  reset: reset
};
