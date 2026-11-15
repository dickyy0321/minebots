// ========================================
// 文件：modules/logger.js
// 功能：日志核心——分级 / 双语 / 分色 / 写盘 / 崩溃日志 / 缓冲刷新
// 依赖：./core（可选，失败不崩）
// 导出：info / warn / error / debug / system / lan / server / flush / onLog
// 作者：MineBots
// ========================================

// 内置模块：日志写盘与路径处理，Node 自带，不会加载失败。
const fs = require("fs");
const path = require("path");

// 说明：本次不 require "./core"：core.js 顶层会 require "./logger"，
// 反向引用在部分加载顺序下会把 core 内的 logger 引用打成空对象，导致 core 日志降级。
// 可选依赖：settings 用于读取日志目录与刷新阈值，缺失时全部退回内置默认值。
let settings = null;
try { settings = require("../settings"); } catch (err) { settings = null; }

// 常量：日志目录默认值，settings.logs.dir 缺省时使用。
const DEFAULT_DIR = "logs";
// 常量：缓冲区满多少条立刻刷新。
const DEFAULT_MAX_LINES = 20;
// 常量：定时刷新间隔（毫秒），与条数条件哪个先到先触发。
const DEFAULT_INTERVAL_MS = 2000;
// 常量：GUI 推送默认档位，默认只推送重要日志。
const DEFAULT_GUI_LEVEL = "important";

// 状态：当前日志语言，默认中文，前端可按日志里的 lang 字段决定显示哪种。
let logLang = "zh";
// 状态：GUI 推送档位，取值 all / important / none。
let guiLevel = DEFAULT_GUI_LEVEL;
// 状态：内存日志缓冲，每一项是一整行文本。
let buffer = [];
// 状态：定时刷新句柄，防止重复注册定时器。
let flushTimer = null;
// 状态：onLog 注册的回调集合。
let listeners = [];
// 状态：调试开关，生产默认关闭，用环境变量 MINEBOTS_DEBUG=1 打开。
let debugEnabled = false;
try { debugEnabled = process.env.MINEBOTS_DEBUG === "1"; } catch (err) { debugEnabled = false; }

// 目录不存在则递归创建，失败不抛异常。
function ensureDir(dir) {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch (err) {
    return false;
  }
}

// 数字补零成两位，用于拼接时间。
function pad2(value) {
  let n = Number(value);
  if (isNaN(n)) n = 0;
  return n < 10 ? "0" + n : String(n);
}

// 生成日期字符串 YYYY-MM-DD，用于当天日志文件名。
function dateStr() {
  const d = new Date();
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

// 生成时间字符串 HH:MM:SS，用于每条日志的 time 字段。
function timeStr() {
  const d = new Date();
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}

// 生成崩溃文件名时间戳 YYYYMMDD-HHMMSS。
function stampStr() {
  const d = new Date();
  return "" + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + "-" +
    pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
}

// 生成崩溃文件名唯一后缀（毫秒 + pid），避免与 core / crash-guard 同秒互相覆盖。
function stampUnique() {
  let ms = 0;
  let pid = 0;
  try { ms = new Date().getMilliseconds(); } catch (err) { ms = 0; }
  try { pid = process.pid; } catch (err) { pid = 0; }
  return "-" + ("00" + ms).slice(-3) + "-" + pid;
}

// 解析日志目录：优先 settings.logs.dir，缺省 logs，统一相对项目根目录。
function logDir() {
  let rel = DEFAULT_DIR;
  try {
    if (settings && settings.logs && settings.logs.dir) rel = settings.logs.dir;
  } catch (err) { rel = DEFAULT_DIR; }
  try { return path.resolve(__dirname, "..", rel); } catch (err) { return rel; }
}

// 计算当天日志文件路径，每次调用重取日期，跨天后自动切换到新文件。
function logFile() {
  ensureDir(logDir());
  try { return path.join(logDir(), "bot-" + dateStr() + ".log"); }
  catch (err) { return logDir() + "/bot-" + dateStr() + ".log"; }
}

// 清理定时刷新句柄。
function clearFlushTimer() {
  if (flushTimer) {
    try { clearTimeout(flushTimer); } catch (err) { /* ignore */ }
    flushTimer = null;
  }
}

// 立即把缓冲区写入当天日志文件，写盘失败只告警不抛异常。
function flush() {
  clearFlushTimer();
  if (buffer.length === 0) return;
  const lines = buffer.join("\n") + "\n";
  buffer = [];
  try {
    fs.appendFileSync(logFile(), lines, "utf8");
  } catch (err) {
    try { console.error("[logger] write log failed: " + err.message); } catch (e) { /* ignore */ }
  }
}

// 读取缓冲刷新条数阈值，settings 缺失时用默认值。
function maxLines() {
  try {
    if (settings && settings.logs && settings.logs.flushMaxLines) return settings.logs.flushMaxLines;
  } catch (err) { /* 用默认值 */ }
  return DEFAULT_MAX_LINES;
}

// 读取定时刷新间隔（毫秒），settings 缺失时用默认值。
function intervalMs() {
  try {
    if (settings && settings.logs && settings.logs.flushIntervalMs) return settings.logs.flushIntervalMs;
  } catch (err) { /* 用默认值 */ }
  return DEFAULT_INTERVAL_MS;
}

// 安排一次定时刷新，已安排则不重复注册，句柄 unref 不阻塞进程退出。
function scheduleFlush() {
  if (flushTimer) return;
  try {
    flushTimer = setTimeout(function () {
      flushTimer = null;
      try { flush(); } catch (err) { /* ignore */ }
    }, intervalMs());
    if (flushTimer && typeof flushTimer.unref === "function") flushTimer.unref();
  } catch (err) { flushTimer = null; }
}

// 处理双语消息：字符串原样返回，{ zh, en } 对象按当前语言取词。
function pickText(message) {
  try {
    if (message && typeof message === "object" && !Array.isArray(message)) {
      const zh = message.zh ? String(message.zh) : "";
      const en = message.en ? String(message.en) : "";
      return logLang === "en" ? (en || zh) : (zh || en);
    }
    if (message === undefined || message === null) return "";
    return String(message);
  } catch (err) {
    return "";
  }
}

// 判断一条日志是否推送到 GUI：none 全不发，all 全发，important 只发重要级别。
function shouldPush(important) {
  if (guiLevel === "none") return false;
  if (guiLevel === "all") return true;
  return important === true;
}

// 把日志记录逐个交给已注册的回调，单条回调出错不影响其他回调。
function pushToGui(entry) {
  const list = listeners.slice();
  for (let i = 0; i < list.length; i++) {
    try {
      if (typeof list[i] === "function") list[i](entry);
    } catch (err) { /* ignore */ }
  }
}

// 组装一条日志：入缓冲、按需推 GUI、满条立即刷新否则定时刷新。
function writeEntry(type, level, message, important) {
  const entry = {
    time: timeStr(),
    type: type,
    level: level,
    message: pickText(message),
    lang: logLang
  };
  try {
    buffer.push("[" + entry.time + "][" + entry.type + "][" + entry.level + "] " + entry.message);
  } catch (err) { /* ignore */ }
  try {
    if (shouldPush(important)) pushToGui(entry);
  } catch (err) { /* ignore */ }
  try {
    if (buffer.length >= maxLines()) flush();
    else scheduleFlush();
  } catch (err) { /* ignore */ }
}

// 类型与颜色约定：LAN 绿 / SERVER 蓝 / SYSTEM 黄 / error 红 / warn 橙（前端按类型上色）。
// 普通信息：类型 SYSTEM，等级 info，只写文件不发 GUI。
function info(message) {
  writeEntry("SYSTEM", "info", message, false);
}

// 调试信息：类型 SYSTEM，等级 debug，生产环境默认不输出。
function debug(message) {
  if (!debugEnabled) return;
  writeEntry("SYSTEM", "debug", message, false);
}

// 警告：类型 warn，等级 warn，写文件并发 GUI。
function warn(message) {
  writeEntry("warn", "warn", message, true);
}

// 错误：类型 error，等级 error，写文件并发 GUI。
function error(message) {
  writeEntry("error", "error", message, true);
}

// 系统消息：类型 SYSTEM，等级 info，写文件并发 GUI。
function system(message) {
  writeEntry("SYSTEM", "info", message, true);
}

// 局域网消息：类型 LAN，等级 info，写文件并发 GUI。
function lan(message) {
  writeEntry("LAN", "info", message, true);
}

// 服务器消息：类型 SERVER，等级 info，写文件并发 GUI。
function server(message) {
  writeEntry("SERVER", "info", message, true);
}

// 切换日志语言：只接受 zh / en，非法值回退中文。
function setLang(lang) {
  logLang = (lang === "en") ? "en" : "zh";
  return logLang;
}

// 预留接口（reserved for future extension）：返回当前日志语言；当前版本无调用方，供外部集成读取，刻意保留导出。
function getLang() {
  return logLang;
}

// 预留接口（reserved for future extension）：设置 GUI 推送档位 all / important / none，非法值保持原档位；
// 当前版本无调用方，为后续「日志降噪」面板预留，刻意保留导出。
function setGuiLevel(level) {
  try {
    if (level === "all" || level === "important" || level === "none") guiLevel = level;
  } catch (err) { /* ignore */ }
  return guiLevel;
}

// 写崩溃日志：logs/crash-YYYYMMDD-HHMMSS-毫秒-pid.log，四段 [type]/[time]/[message]/[stack]。
function crash(type, err) {
  let file = null;
  try {
    ensureDir(logDir());
    file = path.join(logDir(), "crash-" + stampStr() + stampUnique() + ".log");
    const tag = type ? String(type) : "crash";
    let iso = "";
    try { iso = new Date().toISOString(); } catch (e) { iso = ""; }
    let msg = "";
    let stack = "";
    if (err && typeof err === "object") {
      msg = err.message ? String(err.message) : String(err);
      stack = err.stack ? String(err.stack) : "";
    } else if (err !== undefined && err !== null) {
      msg = String(err);
    }
    const lines = [];
    lines.push("[type] " + tag);
    lines.push("[time] " + iso);
    lines.push("[message] " + msg);
    lines.push("[stack]");
    lines.push(stack ? stack : msg);
    fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
  } catch (fail) {
    file = null;
    try { console.error("[logger] write crash log failed: " + fail.message); } catch (e) { /* ignore */ }
  }
  return file;
}

// 注册日志回调：每条推送到 GUI 的日志都会回调一次。
function onLog(callback) {
  try {
    if (typeof callback === "function") listeners.push(callback);
  } catch (err) { /* ignore */ }
  return listeners.length;
}

// 进程退出前把缓冲区剩余日志刷进文件，避免丢日志。
try {
  process.on("exit", function () {
    try { flush(); } catch (err) { /* ignore */ }
  });
} catch (err) { /* ignore */ }

// 对外导出：严格 13 个接口，与 P0-2 规格完全一致。
module.exports = {
  info: info,
  warn: warn,
  error: error,
  debug: debug,
  system: system,
  lan: lan,
  server: server,
  crash: crash,
  flush: flush,
  onLog: onLog,
  setLang: setLang,
  getLang: getLang,
  setGuiLevel: setGuiLevel
};