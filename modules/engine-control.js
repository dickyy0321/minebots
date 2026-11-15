// ========================================
// 文件：modules/engine-control.js
// 功能：底层引擎控制中心——七大核心模块默认全开 / 参数可调 / 写 state/prefs.json 即时生效 / 事件总线实时广播
// 依赖：./prefs（可选）、./event-bus（可选）、./logger（可选），缺失时全部安全降级
// 导出：KEYS / SCHEMA / DEFAULTS / engineOf / isEnabled / effective / param / params /
//       status / getAll / change / reset / traceArmed / bootTrace / exactBuild / tickRate
// 作者：MineBots
// ========================================
//
// 设计要点 / design notes
//   1. 不缓存配置：每次读 modules/prefs.js（state/prefs.json），因此界面一改、底层下一次调用立刻生效，无需重启。
//   2. 不做 push 式强推：七个底层模块在自己的入口处「拉」本模块，既避免循环 require，也不会漏掉跨进程改动。
//   3. 另发事件广播：change() 同时往事件总线推 engine.changed 与 engine.<key>.changed，供 GUI / 遥测订阅。
//   4. 默认全开：所有 enabledKey 缺省或坏值一律按 true 处理（fail-open 到开箱即用）。
//   5. Trace 例外：开关默认开，但 effective() 还要求 testMode=true，即「仅在测试模式启用」。
// CommonJS，ES5 风格，无中文变量名 / CommonJS, no Chinese identifiers

// 可选依赖：偏好落盘中心。
var prefs = null;
try { prefs = require("./prefs"); } catch (e) { prefs = null; }
// 可选依赖：事件总线，用于实时广播。
var bus = null;
try { bus = require("./event-bus"); } catch (e) { bus = null; }
// 可选依赖：日志核心；引擎配置变更属低频信息，只写文件，不刷 GUI。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：七大引擎注册表。key 是内部名，enabledKey 是 prefs 键，params 是专家面板可调参数。
var SCHEMA = [
  {
    key: "radar", enabledKey: "engRadar", testModeOnly: false,
    label: "2D 雷达与实体追踪 / 2D Radar & Entity Tracking",
    params: [
      { key: "radarRadius", label: "雷达范围 / Radar range", min: 16, max: 128, step: 8, def: 64, unit: "格 / blocks" }
    ]
  },
  {
    key: "motion", enabledKey: "engMotion", testModeOnly: false,
    label: "拟真动作（高斯噪声 / 延迟） / Humanized Motion",
    params: [
      { key: "motionStrength", label: "拟真强度 / Humanize strength", min: 1, max: 10, step: 1, def: 5, unit: "级 / level" },
      { key: "motionDelayMs", label: "动作延迟 / Action delay", min: 50, max: 500, step: 10, def: 150, unit: "毫秒 / ms" }
    ]
  },
  {
    key: "trace", enabledKey: "engTrace", testModeOnly: true,
    label: "全链路 Trace 追踪（仅测试模式） / Full-chain Trace (test mode only)",
    params: [
      { key: "traceFailureRate", label: "故障注入率 / Fault injection", min: 0, max: 100, step: 1, def: 10, unit: "%" }
    ]
  },
  {
    key: "antiStuck", enabledKey: "engAntiStuck", testModeOnly: false,
    label: "自动防卡死自救 / Anti-stuck Rescue",
    params: [
      { key: "antiStuckWatchdogMs", label: "看门狗间隔 / Watchdog interval", min: 500, max: 10000, step: 100, def: 3000, unit: "毫秒 / ms" },
      { key: "antiStuckMaxRescues", label: "自救次数上限 / Max rescues", min: 1, max: 10, step: 1, def: 3, unit: "次 / times" }
    ]
  },
  {
    key: "typing", enabledKey: "typing", testModeOnly: false,
    label: "打字机（防刷屏） / Anti-spam Typewriter",
    params: [
      { key: "typingCps", label: "打字速度 / Typing speed", min: 5, max: 120, step: 1, def: 30, unit: "字/秒 / cps" },
      { key: "typingChunk", label: "单段字数 / Chunk size", min: 3, max: 60, step: 1, def: 12, unit: "字 / chars" }
    ]
  },
  {
    key: "protocolForge", enabledKey: "engProtocolForge", testModeOnly: false,
    label: "协议穿透 / Protocol Forge",
    params: [
      { key: "protocolMaxRetry", label: "模组重试上限 / Mod retry limit", min: 0, max: 10, step: 1, def: 3, unit: "次 / times" }
    ]
  },
  {
    key: "behaviorTree", enabledKey: "engBehaviorTree", testModeOnly: false,
    label: "行为树状态机（含 GOAP） / Behavior Tree & GOAP",
    params: [
      { key: "behaviorMaxTicks", label: "单次执行节点预算 / Tick budget", min: 20, max: 1000, step: 10, def: 200, unit: "节点 / nodes" }
    ]
  }
];

// 常量：引擎名数组 / 默认全开的偏好键值表（供 UI 与自测读取）。
var KEYS = [];
var DEFAULTS = {};
for (var si = 0; si < SCHEMA.length; si++) {
  KEYS.push(SCHEMA[si].key);
  DEFAULTS[SCHEMA[si].enabledKey] = true;
  for (var pi = 0; pi < SCHEMA[si].params.length; pi++) {
    DEFAULTS[SCHEMA[si].params[pi].key] = SCHEMA[si].params[pi].def;
  }
}

// 写信息日志：只落文件，缺 logger 时静默。
function logInfo(message) {
  try { if (logger && typeof logger.info === "function") logger.info("[engine] " + message); } catch (e) { /* ignore */ }
}

// 把异常拍成一行文本，catch 里绝不二次抛错。
function errText(err) {
  try { if (err && err.message) return String(err.message); return String(err); }
  catch (e) { return "unknown error"; }
}

// 深拷贝默认引擎键值，避免调用方改坏内部常量。
function cloneDefaults() {
  var out = {};
  for (var k in DEFAULTS) {
    if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) out[k] = DEFAULTS[k];
  }
  return out;
}

// 读当前偏好：prefs 不可用时退回默认全开表，绝不抛错。
function readPrefs() {
  try {
    if (prefs && typeof prefs.load === "function") {
      var loaded = prefs.load();
      if (loaded && typeof loaded === "object") return loaded;
    }
  } catch (e) { /* 读盘失败按默认全开 */ }
  return cloneDefaults();
}

// 广播一个事件：总线缺失时静默跳过。
function busEmit(name, payload) {
  try { if (bus && typeof bus.emit === "function") bus.emit(name, payload); } catch (e) { /* ignore */ }
}

// 按内部名取引擎定义，找不到返回 null。
function engineOf(key) {
  try {
    var name = String(key === null || key === undefined ? "" : key);
    for (var i = 0; i < SCHEMA.length; i++) {
      if (SCHEMA[i].key === name) return SCHEMA[i];
    }
  } catch (e) { /* 返回 null */ }
  return null;
}

// 在引擎定义里按 prefs 键找参数规格，找不到返回 null。
function paramSpec(engine, prefKey) {
  try {
    for (var i = 0; i < engine.params.length; i++) {
      if (engine.params[i].key === prefKey) return engine.params[i];
    }
  } catch (e) { /* 返回 null */ }
  return null;
}

// 功能：读某引擎的独立开关；未配置 / 坏值一律返回 true（默认全开），未知引擎返回 false。
function isEnabled(key) {
  var engine = engineOf(key);
  if (!engine) return false;
  try {
    var value = readPrefs()[engine.enabledKey];
    if (typeof value === "boolean") return value;
    return true;
  } catch (e) { return true; }
}

// 功能：读某引擎的实际生效状态；testModeOnly 的引擎还要求测试模式打开，否则返回 false。
function effective(key) {
  var engine = engineOf(key);
  if (!engine) return false;
  var on = isEnabled(key);
  if (!engine.testModeOnly) return on;
  try { return on === true && readPrefs().testMode === true; }
  catch (e) { return false; }
}

// 功能：读某引擎的一个数值参数；坏值 / 越界一律夹到合法范围，未知参数返回 0。
function param(key, prefKey) {
  var engine = engineOf(key);
  if (!engine) return 0;
  var spec = paramSpec(engine, prefKey);
  if (!spec) return 0;
  try {
    var raw = Number(readPrefs()[prefKey]);
    if (isNaN(raw) || !isFinite(raw)) return spec.def;
    if (raw < spec.min) raw = spec.min;
    if (raw > spec.max) raw = spec.max;
    return Math.round(raw);
  } catch (e) { return spec.def; }
}

// 功能：读某引擎全部参数，返回 { prefKey: value }；未知引擎返回空对象。
function params(key) {
  var out = {};
  var engine = engineOf(key);
  if (!engine) return out;
  try {
    for (var i = 0; i < engine.params.length; i++) out[engine.params[i].key] = param(key, engine.params[i].key);
  } catch (e) { /* 返回已读部分 */ }
  return out;
}

// 功能：七个引擎的完整状态快照（自测与 GUI 用），返回数组，永不抛错。
function status() {
  var out = [];
  try {
    for (var i = 0; i < SCHEMA.length; i++) {
      var engine = SCHEMA[i];
      var list = [];
      for (var j = 0; j < engine.params.length; j++) {
        var spec = engine.params[j];
        list.push({
          key: spec.key, label: spec.label, value: param(engine.key, spec.key),
          min: spec.min, max: spec.max, step: spec.step, unit: spec.unit
        });
      }
      out.push({
        key: engine.key, label: engine.label, enabledKey: engine.enabledKey,
        enabled: isEnabled(engine.key), effective: effective(engine.key),
        testModeOnly: engine.testModeOnly === true, params: list
      });
    }
  } catch (e) { /* 返回已统计部分 */ }
  return out;
}

// 功能：总览——{ ok, prefs, engines, defaults, message }；读盘失败也返回 ok:true 的默认全开表。
function getAll() {
  try {
    return {
      ok: true, prefs: readPrefs(), engines: status(), defaults: cloneDefaults(),
      message: "engine control ready / 引擎控制就绪"
    };
  } catch (e) {
    return { ok: true, prefs: cloneDefaults(), engines: [], defaults: cloneDefaults(), message: errText(e) };
  }
}

// 判断一次变更涉及哪些引擎，用于精确广播；返回引擎 key 数组。
function touchedEngines(patch) {
  var out = [];
  try {
    for (var i = 0; i < SCHEMA.length; i++) {
      var engine = SCHEMA[i];
      var hit = Object.prototype.hasOwnProperty.call(patch, engine.enabledKey);
      for (var j = 0; j < engine.params.length; j++) {
        if (Object.prototype.hasOwnProperty.call(patch, engine.params[j].key)) hit = true;
      }
      if (hit) out.push(engine.key);
    }
  } catch (e) { /* 返回已收集部分 */ }
  return out;
}

// 功能：保存偏好并立即通知底层（真写 state/prefs.json + 事件广播）；返回 { ok, prefs, engines, message }。
function change(patch) {
  var src = patch && typeof patch === "object" ? patch : {};
  try {
    if (!prefs || typeof prefs.save !== "function") {
      return { ok: false, prefs: readPrefs(), engines: status(), message: "prefs unavailable / 偏好模块未加载" };
    }
    var saved = prefs.save(src);
    if (!saved || saved.ok !== true) {
      return { ok: false, prefs: readPrefs(), engines: status(), message: (saved && saved.error) || "write failed / 写入失败" };
    }
    // engine.changed / engine.<key>.changed 由 prefs.save() 统一广播，这里只补一条参数快照事件。
    var changed = touchedEngines(src);
    busEmit("engine.applied", { prefs: saved.prefs, keys: changed, at: Date.now() });
    logInfo("配置已生效 / config applied: " + JSON.stringify(src));
    return { ok: true, prefs: saved.prefs, engines: status(), keys: changed, message: "config applied / 配置已实时生效" };
  } catch (e) {
    return { ok: false, prefs: readPrefs(), engines: status(), message: errText(e) };
  }
}

// 功能：把七个引擎恢复默认全开（只覆盖引擎键，不动测试模式等其它偏好），返回与 change 相同结构。
function reset() {
  return change(cloneDefaults());
}

// 功能：精确建筑模式是否开启（engExactBuild，默认关）；开启时 motion 噪声与随机延迟全部归零。
// 该开关独立于七大引擎注册表，不进 SCHEMA，既有 7 个引擎的数量断言保持不变。
function exactBuild() {
  try { return readPrefs().engExactBuild === true; } catch (e) { return false; }
}

// 功能：红石触发频率（redstoneTickRate，默认 50ms，合法 10~1000ms）；坏值一律回默认，供高频触发器读取。
function tickRate() {
  try {
    var ms = Number(readPrefs().redstoneTickRate);
    if (!isNaN(ms) && ms >= 10 && ms <= 1000) return Math.round(ms);
  } catch (e) { /* 读盘失败回默认 */ }
  return 50;
}

// 功能：Trace 是否真正启用（开关开 + 测试模式开），供主进程启动时决定是否跑启动链路。
function traceArmed() {
  return effective("trace") === true;
}

// 功能：主进程启动时调用——仅在测试模式且 Trace 开关打开时跑一条真实启动链路，否则什么都不做。
function bootTrace() {
  if (!traceArmed()) {
    return { ok: false, armed: false, message: "trace off / 追踪未启用（仅测试模式）" };
  }
  try {
    var runner = require("./test-runner");
    if (!runner || typeof runner.runSimple !== "function") {
      return { ok: false, armed: true, message: "trace runner unavailable / 追踪模块不可用" };
    }
    runner.runSimple("启动链路 / boot trace", ["core", "bot"], function () { return { ok: true }; }, { failureRate: 0 });
    busEmit("engine.trace.boot", { at: Date.now() });
    return { ok: true, armed: true, message: "trace armed / 测试模式追踪已启用" };
  } catch (e) {
    return { ok: false, armed: true, message: errText(e) };
  }
}

// 对外导出：注册表 / 查询 / 快照 / 变更 / 复位。
module.exports = {
  KEYS: KEYS,
  SCHEMA: SCHEMA,
  DEFAULTS: DEFAULTS,
  engineOf: engineOf,
  isEnabled: isEnabled,
  effective: effective,
  param: param,
  params: params,
  status: status,
  getAll: getAll,
  change: change,
  reset: reset,
  traceArmed: traceArmed,
  bootTrace: bootTrace,
  exactBuild: exactBuild,
  tickRate: tickRate
};
