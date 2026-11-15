// ========================================
// 文件：modules/plugin-loader.js
// 功能：插件加载——15 个 mineflayer 插件（寻路前置排第一）/ 失败降级 / 纯库静默 / 加载报告
// 依赖：./logger（可选，失败不崩）
// 导出：loadPlugins / getReport / getCategory / applyPlugin / PLUGINS / PLUGIN_CATEGORIES / SILENT_PLUGINS / DEFERRED_PLUGINS
// 作者：MineBots
// ========================================

// 可选依赖：日志核心，缺失时所有输出退回 console，绝不抛错。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 写系统日志：优先 logger.system，不可用时退回 console，绝不抛错。
function logSystem(msg) {
  try {
    if (logger && typeof logger.system === "function") { logger.system(msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[SYSTEM] " + msg); } catch (e) { /* ignore */ }
}

// 写警告日志：优先 logger.warn，不可用时退回 console，绝不抛错。
function logWarn(msg) {
  try {
    if (logger && typeof logger.warn === "function") { logger.warn(msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.warn("[warn] " + msg); } catch (e) { /* ignore */ }
}

// 写纯文件日志（info 级，不推 GUI）：给纯 API 库的“没注入入口”这类正常信息用，绝不抛错。
function logInfo(msg) {
  try {
    if (logger && typeof logger.info === "function") { logger.info(msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[info] " + msg); } catch (e) { /* ignore */ }
}

// 安全提取错误文本，避免在 catch 里再次抛错。
function getErrText(err) {
  try {
    if (err && err.message) return String(err.message);
    return String(err);
  } catch (e) {
    return "unknown error";
  }
}

// 15 个插件清单：mineflayer-pathfinder 必须排第一（baritone 靠它先挂上寻路），其余顺序不变。
var PLUGINS = [
  "mineflayer-pathfinder",
  "@miner-org/mineflayer-baritone",
  "@rhld16/mineflayer-antiafk",
  "@nxg-org/mineflayer-custom-pvp",
  "@nxg-org/mineflayer-auto-armor",
  "@nxg-org/mineflayer-auto-buff",
  "mineflayer-statemachine",
  "@nxg-org/mineflayer-hive-mind",
  "mineflayer-schem",
  "@nxg-org/mineflayer-util-plugin",
  "@nxg-org/mineflayer-ender",
  "mineflayer-viaproxy",
  "mineflayer-mcefly",
  "@nxg-org/mineflayer-trajectories",
  "@nxg-org/mineflayer-tracker"
];

// 分类表：键为分类名，值为该分类下的插件名数组。
var PLUGIN_CATEGORIES = {
  "pathfinding":   ["mineflayer-pathfinder", "@miner-org/mineflayer-baritone"],
  "anti-afk":      ["@rhld16/mineflayer-antiafk"],
  "combat":        ["@nxg-org/mineflayer-custom-pvp"],
  "armor":         ["@nxg-org/mineflayer-auto-armor"],
  "buff":          ["@nxg-org/mineflayer-auto-buff"],
  "statemachine":  ["mineflayer-statemachine"],
  "hive-mind":     ["@nxg-org/mineflayer-hive-mind"],
  "schematic":     ["mineflayer-schem"],
  "util":          ["@nxg-org/mineflayer-util-plugin"],
  "ender":         ["@nxg-org/mineflayer-ender"],
  "viaproxy":      ["mineflayer-viaproxy"],
  "mcefly":        ["mineflayer-mcefly"],
  "trajectories":  ["@nxg-org/mineflayer-trajectories"],
  "tracker":       ["@nxg-org/mineflayer-tracker"]
};

// 静默名单：纯 API 库（本来就没有注入入口），"加载失败"属正常，只写 info 级文件日志，不刷 GUI。
var SILENT_PLUGINS = [
  "mineflayer-statemachine",
  "@nxg-org/mineflayer-hive-mind",
  "mineflayer-schem",
  "mineflayer-viaproxy",
  "@nxg-org/mineflayer-trajectories"
];

// 延后名单：值是必须等的事件名——antiafk 注入时要读 bot.autoEat，得等 mineflayer 把内核插件注完。
var DEFERRED_PLUGINS = {
  "@rhld16/mineflayer-antiafk": "spawn"
};

// 内部报告：最近一次加载结果，time 为 null 表示尚未加载过。
var lastReport = {
  time: null,
  botId: null,
  loaded: [],
  failed: [],
  total: 0
};

// 依次尝试 9 种常见导出写法注入插件（统一带一个 options 对象），成功返回 true；全都不符返回 false，绝不抛错。
function injectPlugin(mod, bot, options) {
  var opts = options || {};
  // 写法 1：module.exports = function (bot, opts) {}
  if (typeof mod === "function") { mod(bot, opts); return true; }
  // 写法 2：module.exports = { plugin: function (bot, opts) {} }
  if (mod && typeof mod.plugin === "function") { mod.plugin(bot, opts); return true; }
  // 写法 3：module.exports = { inject: function (bot, opts) {} }
  if (mod && typeof mod.inject === "function") { mod.inject(bot, opts); return true; }
  // 兼容 ESM 转 CJS：真正的导出可能挂在 .default 上（读不到就当成没有）。
  var def = null;
  try { def = mod ? mod.default : null; } catch (e) { def = null; }
  // 写法 4：export default function (bot, opts) {}
  if (typeof def === "function") { def(bot, opts); return true; }
  // 写法 5：export default { plugin: function (bot, opts) {} }
  if (def && typeof def.plugin === "function") { def.plugin(bot, opts); return true; }
  // 写法 6：export default { inject: function (bot, opts) {} }
  if (def && typeof def.inject === "function") { def.inject(bot, opts); return true; }
  // 写法 7：module.exports = { loader: function (bot, opts) {} }——baritone 用 loader，且必须拿到对象否则解构就崩。
  if (mod && typeof mod.loader === "function") { mod.loader(bot, opts); return true; }
  // 写法 8：module.exports = { getPlugin: function () { return fn } }——auto-armor 这类工厂写法。
  if (mod && typeof mod.getPlugin === "function") {
    var made = mod.getPlugin();
    if (typeof made === "function") { made(bot, opts); return true; }
  }
  // 写法 9：module.exports = { pathfinder: function (bot) {} }——mineflayer-pathfinder 用命名导出注入。
  if (mod && typeof mod.pathfinder === "function") { mod.pathfinder(bot, opts); return true; }
  return false;
}

// 尝试加载并注入单个插件（第三个参数可传插件选项），返回 { ok:true } 或 { ok:false, error }，绝不抛错。
function applyPlugin(bot, name, options) {
  var mod = null;
  var opts = {};
  try { if (options && typeof options === "object") opts = options; } catch (e) { opts = {}; }
  try {
    mod = require(name);
  } catch (err) {
    return { ok: false, error: getErrText(err) };
  }
  try {
    if (injectPlugin(mod, bot, opts)) return { ok: true };
    return { ok: false, error: "no valid loader method" };
  } catch (err) {
    return { ok: false, error: getErrText(err) };
  }
}

// 内部：插件名是否在静默名单里（纯 API 库，没有注入入口很正常）。
function isSilent(name) {
  for (var i = 0; i < SILENT_PLUGINS.length; i++) {
    if (SILENT_PLUGINS[i] === name) return true;
  }
  return false;
}

// 内部：把单个插件的加载结果记进报告——纯库只写 info 级文件日志，真失败才 warn 并推 GUI。
function handleResult(bot, name, result) {
  try {
    if (result && result.ok) {
      lastReport.loaded.push(name);
      logSystem("[插件] 已加载：" + name + "（分类：" + getCategory(name) + "）");
      return true;
    }
    var errText = result && result.error ? getErrText(result.error) : "unknown error";
    var libraryOnly = errText === "no valid loader method" && isSilent(name);
    if (libraryOnly) {
      lastReport.silent.push(name);
      logInfo("[插件] 纯库跳过（正常）：" + name + " / library-only package, no inject entry");
      return false;
    }
    lastReport.failed.push({ name: name, error: errText });
    logWarn("[插件] 加载失败：" + name + " -> " + errText +
      (errText === "no valid loader method" ? "（若是纯 API 库而非 mineflayer 插件，属正常 / library-only package, no inject entry）" : ""));
    return false;
  } catch (e) {
    return false;
  }
}

// 内部：把插件挂到事件上再注入（antiafk 必须等 spawn，否则读不到 bot.autoEat 直接崩）。
function deferPlugin(bot, name, eventName) {
  try {
    if (!bot || typeof bot.once !== "function") return handleResult(bot, name, applyPlugin(bot, name));
    bot.once(eventName, function () {
      try { handleResult(bot, name, applyPlugin(bot, name)); }
      catch (e) { logInfo("[插件] 延后加载异常：" + name + " -> " + getErrText(e)); }
    });
    lastReport.deferred.push(name);
    logSystem("[插件] 已排队：" + name + "（等 " + eventName + " 事件再注入 / queued until '" + eventName + "'）");
    return true;
  } catch (e) {
    lastReport.failed.push({ name: name, error: getErrText(e) });
    logInfo("[插件] 排队失败：" + name + " -> " + getErrText(e));
    return false;
  }
}

// 功能 1：加载全部插件，单个失败绝不影响其他，返回最新报告。
function loadPlugins(bot, botId) {
  var id = null;
  try { if (botId) id = String(botId); } catch (e) { id = null; }
  lastReport = { time: null, botId: id, loaded: [], deferred: [], silent: [], failed: [], total: PLUGINS.length };
  for (var i = 0; i < PLUGINS.length; i++) {
    var name = PLUGINS[i];
    // 有依赖前置条件的插件先排队，等事件到了再注入，绝不硬来。
    if (DEFERRED_PLUGINS[name]) { deferPlugin(bot, name, DEFERRED_PLUGINS[name]); continue; }
    handleResult(bot, name, applyPlugin(bot, name));
  }
  logSystem("[插件] 完成：成功 " + lastReport.loaded.length + " / 延后 " + lastReport.deferred.length +
    " / 纯库 " + lastReport.silent.length + " / 失败 " + lastReport.failed.length + " / 总共 " + PLUGINS.length +
    "（loaded / deferred / library-only / failed / total）");
  try { lastReport.time = new Date().toISOString(); } catch (e) { lastReport.time = ""; }
  lastReport.botId = id;
  lastReport.total = PLUGINS.length;
  return lastReport;
}

// 功能 2：返回报告副本（防止外部改动内部状态），从未加载过则返回 null。
function getReport() {
  if (!lastReport || lastReport.time === null) return null;
  try { return JSON.parse(JSON.stringify(lastReport)); } catch (e) { return null; }
}

// 功能 3：按插件名查分类，查不到返回 "unknown"。
function getCategory(pluginName) {
  var target = "";
  try { target = pluginName ? String(pluginName) : ""; } catch (e) { return "unknown"; }
  if (!target) return "unknown";
  for (var key in PLUGIN_CATEGORIES) {
    if (!Object.prototype.hasOwnProperty.call(PLUGIN_CATEGORIES, key)) continue;
    var list = PLUGIN_CATEGORIES[key];
    if (!list) continue;
    for (var i = 0; i < list.length; i++) {
      if (list[i] === target) return key;
    }
  }
  return "unknown";
}

// 对外导出：§六 规定的 5 个接口 + 单个插件注入入口（自测 / 诊断用），外加两张策略表（纯库静默 / 依赖延后）。
module.exports = {
  loadPlugins: loadPlugins,
  getReport: getReport,
  getCategory: getCategory,
  applyPlugin: applyPlugin,
  PLUGINS: PLUGINS,
  PLUGIN_CATEGORIES: PLUGIN_CATEGORIES,
  SILENT_PLUGINS: SILENT_PLUGINS,
  DEFERRED_PLUGINS: DEFERRED_PLUGINS
};