// ========================================
// 文件：modules/param-manager.js
// 功能：参数面板的真接口——按 key 读 / 写运行参数，真实落盘到 state/params.json；
//       精确建筑 / 红石触发频率两个全局键写入时经事件总线实时广播
// 依赖：fs / path（Node 内置）、./logger（可选）、./event-bus（可选）
// 导出：get、set、all、remove、getPath、DEFAULTS、GLOBAL_KEYS
// 作者：MineBots
// ========================================
//
// 为什么要有这个模块：
//   高级面板的「参数查询」以前调 window.api.paramGet，而主进程根本没有这个通道，
//   点了没反应 = 假接口。这里把它接到真实文件：任何一次 set 都能在 state/params.json 里看到。
// 测试隔离：环境变量 MINEBOTS_STATE_DIR 可替换 state 目录。
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

var fs = require("fs");
var path = require("path");
// 可选依赖：日志核心；缺失时静默。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
// 可选依赖：事件总线；全局键变更时实时广播，底层模块无需重启即可感知。
var bus = null;
try { bus = require("./event-bus"); } catch (e) { bus = null; }

// 常量：内置参数默认值（没写过盘时返回这些，界面上不会出现 undefined）。
var DEFAULTS = {
  "bot.digBatch": 16,
  "bot.collectRadius": 8,
  "bot.followDistance": 2,
  "ai.temperature": 0.7,
  "ai.maxTokens": 256,
  "typing.chunk": 12,
  "engExactBuild": false,
  "redstoneTickRate": 50
};
// 常量：全局开关 / 频率键——改动时除落盘本模块，还要广播并同步 state/prefs.json。
var GLOBAL_KEYS = { engExactBuild: "exactBuild", redstoneTickRate: "redstoneTick" };

// 写普通信息日志：只落文件不推 GUI。
function logInfo(message) {
  try { if (logger && typeof logger.info === "function") logger.info(message); } catch (e) { /* ignore */ }
}

// 把异常拍成一行文本，避免在 catch 里再次抛错。
function errText(err) {
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
  } catch (e) { /* 用默认目录 */ }
  return path.join(process.cwd(), "state");
}

// 功能 5：参数文件绝对路径（诊断 / 自测用）。
function getPath() {
  try { return path.join(stateDir(), "params.json"); } catch (e) { return "state/params.json"; }
}

// 读全量参数：文件缺失 / 坏掉都回空对象，绝不抛错。
function readAll() {
  try {
    var file = getPath();
    if (!fs.existsSync(file)) return {};
    var text = fs.readFileSync(file, "utf8");
    if (!text || text.replace(/\s+/g, "").length === 0) return {};
    var data = JSON.parse(text);
    return data && typeof data === "object" ? data : {};
  } catch (err) {
    logInfo("[param-manager] read failed: " + errText(err));
    return {};
  }
}

// 广播全局键变更：总线与偏好模块都可选，任一缺失都不影响参数落盘。
function announceGlobal(key, value) {
  try {
    if (!Object.prototype.hasOwnProperty.call(GLOBAL_KEYS, key)) return;
    if (bus && typeof bus.emit === "function") {
      bus.emit("param.changed", { key: key, value: value, at: Date.now() });
      bus.emit("engine." + GLOBAL_KEYS[key] + ".changed", { key: key, value: value, at: Date.now() });
    }
    var prefs = null;
    try { prefs = require("./prefs"); } catch (e) { prefs = null; }
    if (prefs && typeof prefs.save === "function") {
      var patch = {};
      patch[key] = value;
      prefs.save(patch);
    }
  } catch (e) { /* 广播失败不影响参数写入 */ }
}

// 原子写：先写 .tmp 再 rename，成功返回 true。
function writeAll(data) {
  try {
    var file = getPath();
    var dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    var tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    logInfo("[param-manager] write failed: " + errText(err));
    return false;
  }
}

// 功能 1：读一个参数——盘上有就用盘上的，没有就用默认值；都没有返回 { ok:false }。
function get(key) {
  var name = String(key === null || key === undefined ? "" : key).replace(/^\s+|\s+$/g, "");
  if (name.length === 0) return { ok: false, key: "", message: "key required / 缺少参数名" };
  var all = readAll();
  if (Object.prototype.hasOwnProperty.call(all, name)) {
    return { ok: true, key: name, value: all[name], source: "file" };
  }
  if (Object.prototype.hasOwnProperty.call(DEFAULTS, name)) {
    return { ok: true, key: name, value: DEFAULTS[name], source: "default" };
  }
  return { ok: false, key: name, message: "unknown param / 未知参数: " + name };
}

// 功能 2：写一个参数（值可以是数字 / 字符串 / 布尔），成功返回 { ok, key, value }。
function set(key, value) {
  var name = String(key === null || key === undefined ? "" : key).replace(/^\s+|\s+$/g, "");
  if (name.length === 0) return { ok: false, key: "", message: "key required / 缺少参数名" };
  try {
    var all = readAll();
    all[name] = value;
    if (!writeAll(all)) return { ok: false, key: name, message: "write failed / 写入失败" };
    logInfo("[param-manager] set " + name + " = " + JSON.stringify(value));
    announceGlobal(name, value);
    return { ok: true, key: name, value: value };
  } catch (err) {
    return { ok: false, key: name, message: errText(err) };
  }
}

// 功能 3：读全部参数（盘上的覆盖默认值），返回 { ok, params }。
function all() {
  var out = {};
  var key = "";
  for (key in DEFAULTS) {
    if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) out[key] = DEFAULTS[key];
  }
  var saved = readAll();
  for (key in saved) {
    if (Object.prototype.hasOwnProperty.call(saved, key)) out[key] = saved[key];
  }
  return { ok: true, params: out };
}

// 功能 4：删掉一个参数（回落到默认值），成功返回 { ok, key }。
function remove(key) {
  var name = String(key === null || key === undefined ? "" : key).replace(/^\s+|\s+$/g, "");
  if (name.length === 0) return { ok: false, key: "", message: "key required / 缺少参数名" };
  try {
    var saved = readAll();
    if (Object.prototype.hasOwnProperty.call(saved, name)) delete saved[name];
    if (!writeAll(saved)) return { ok: false, key: name, message: "write failed / 写入失败" };
    return { ok: true, key: name };
  } catch (err) {
    return { ok: false, key: name, message: errText(err) };
  }
}

// 对外导出：读 / 写 / 全部 / 删除 / 路径 / 默认值。
module.exports = {
  get: get,
  set: set,
  all: all,
  remove: remove,
  getPath: getPath,
  DEFAULTS: DEFAULTS,
  GLOBAL_KEYS: GLOBAL_KEYS
};
