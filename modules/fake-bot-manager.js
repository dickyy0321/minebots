// ========================================
// 文件：modules/fake-bot-manager.js
// 功能：测试模式假 bot 管理——创建假 bot（假握手日志）/ 启动模拟环境 / 停止模拟；真连逻辑仍留在 bot-manager
// 依赖：./fake-bot（可选，缺失时只剩 5 分钟兜底心跳）/ ./logger（可选，缺失退回 console）
// 导出：createFakeBot / startSimulation / stopSimulation / isAvailable / FAKE_HEARTBEAT_MS
// 作者：MineBots
// ========================================

// 可选依赖：测试模式模拟器（世界状态 / 事件 / 死亡重生 / 断线重连 / 服务器公告），缺失时退回极简心跳。
var fakeBot = null;
try { fakeBot = require("./fake-bot"); } catch (e) { fakeBot = null; }

// 可选依赖：日志核心，缺失时所有输出退回 console，绝不抛错。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：测试模式兜底心跳间隔 5 分钟——只在 fake-bot 模块缺失时启用，正常模拟全由 fake-bot 负责。
var FAKE_HEARTBEAT_MS = 300000;

// 写系统日志：优先 logger.system（推 GUI），不可用时退回 console，绝不抛错。
function logSystem(message) {
  try {
    if (logger && typeof logger.system === "function") { logger.system(message); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[SYSTEM] " + message); } catch (e2) { /* 忽略 */ }
}

// 写信息日志：优先 logger.info（只写文件，绝不推 GUI），不可用时退回 console，绝不抛错。
function logInfo(message) {
  try {
    if (logger && typeof logger.info === "function") { logger.info(message); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log(message); } catch (e2) { /* 忽略 */ }
}

// 写调试日志：优先 logger.debug，不可用时退回 logInfo（只在文件里，不推 GUI）。
function logDebug(message) {
  try {
    if (logger && typeof logger.debug === "function") { logger.debug(message); return; }
  } catch (e) { /* 退回 logInfo */ }
  logInfo(message);
}

// 写警告日志：优先 logger.warn（推 GUI），不可用时退回 console，绝不抛错。
function logWarn(message) {
  try {
    if (logger && typeof logger.warn === "function") { logger.warn(message); return; }
  } catch (e) { /* 退回 console */ }
  try { console.warn(message); } catch (e2) { /* 忽略 */ }
}

// 写错误日志：优先 logger.error（推 GUI），不可用时退回 console，绝不抛错。
function logError(message) {
  try {
    if (logger && typeof logger.error === "function") { logger.error(message); return; }
  } catch (e) { /* 退回 console */ }
  try { console.error(message); } catch (e2) { /* 忽略 */ }
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

// 取 bot id 用作日志前缀：记录为空时返回 "?"，绝不抛错。
function idOf(rec) {
  try { return rec && rec.id ? String(rec.id) : "?"; } catch (e) { return "?"; }
}

// 是否可用：fake-bot 模块在就算可用；缺失时 bot-manager 会直接拒绝测试模式启动，绝不偷偷真连。
function isAvailable() {
  return !!fakeBot;
}

// 打印假握手日志：把「创建 / 版本 / 协议 / 登录 / 出生」整套流程写进日志，肉眼可核对是不是模拟环境。
function announce(opt, protocol) {
  try {
    logSystem("[TEST] 创建假 bot " + opt.id + " -> " + opt.host + ":" + opt.port + " as " + opt.username);
    logSystem("[TEST] version=" + opt.version + " protocol=" + protocol);
    logSystem("[TEST] " + opt.id + " handshake protocol=" + protocol);
    logSystem("[TEST] " + opt.id + " login start: " + opt.username);
    logSystem("[TEST] " + opt.id + " login success: uuid=fake-uuid-" + opt.id);
    logSystem("[TEST] " + opt.id + " spawn OK, pretending in-game.");
  } catch (e) {
    logWarn("[TEST] 假握手日志写入失败 / handshake log failed: " + getErrText(e));
  }
}

// 启动模拟：优先交给 fake-bot（完整游戏环境），模块缺失或启动失败时退回一条 5 分钟兜底心跳，返回是否走完整模拟。
function startSimulation(rec) {
  try {
    if (fakeBot && typeof fakeBot.startSimulation === "function") {
      var api = { info: logInfo, debug: logDebug, warn: logWarn, error: logError, system: logSystem, server: logSystem };
      if (fakeBot.startSimulation(rec, api)) return true;
      logWarn("[" + idOf(rec) + "] fake-bot 启动失败，退回兜底心跳 / falling back to heartbeat");
    }
  } catch (e) {
    logError("[" + idOf(rec) + "] 模拟环境启动异常 / simulation failed: " + getErrText(e));
  }
  try {
    rec.fakeTimer = setInterval(function () {
      logInfo("[TEST] " + rec.id + " heartbeat");
    }, FAKE_HEARTBEAT_MS);
    if (rec.fakeTimer && typeof rec.fakeTimer.unref === "function") rec.fakeTimer.unref();
    return false;
  } catch (e2) {
    rec.fakeTimer = null;
    logError("[" + idOf(rec) + "] 心跳定时器创建失败 / heartbeat timer failed: " + getErrText(e2));
    return false;
  }
}

// 停止模拟：清掉 fake-bot 的全部定时器（兜底心跳由 bot-manager 自己清），返回清掉的定时器个数，失败返回 0。
function stopSimulation(rec) {
  try {
    if (fakeBot && typeof fakeBot.stopSimulation === "function") return fakeBot.stopSimulation(rec);
  } catch (e) {
    logWarn("[" + idOf(rec) + "] 模拟环境停止异常 / stop failed: " + getErrText(e));
  }
  return 0;
}

// 功能 2：创建测试模式 bot——不真连，但把游戏环境整套模拟出来（握手 / 世界 / 事件 / 死亡 / 断线 / 公告）。
// hooks 由 bot-manager 注入（resolve / build / protocolOf / register），两边就不会互相 require 成环。
// 失败返回 { ok:false, message }；成功返回 { ok:true, message:"started" }（GUI 靠 "started" 判定运行中）。
function createFakeBot(options, hooks) {
  var h = hooks || {};
  try {
    if (typeof h.resolve !== "function" || typeof h.build !== "function") {
      return { ok: false, id: "", message: "fake-bot-manager 缺少注入依赖 / missing hooks" };
    }
    var opt = h.resolve(options);
    var rec = h.build(opt);
    rec.fake = true;
    rec.status = "running";
    rec.port = opt.port;
    if (typeof h.register === "function") h.register(rec);
    var protocol = typeof h.protocolOf === "function" ? h.protocolOf(opt.version) : 0;
    announce(opt, protocol);
    startSimulation(rec);
    return { ok: true, id: opt.id, port: opt.port, message: "started" };
  } catch (e) {
    return { ok: false, id: options && options.id ? String(options.id) : "", message: getErrText(e) };
  }
}

// 对外导出：创建 / 启动 / 停止 / 可用性 四个接口 + 兜底心跳常量（便于自检与将来调参）。
module.exports = {
  createFakeBot: createFakeBot,
  startSimulation: startSimulation,
  stopSimulation: stopSimulation,
  isAvailable: isAvailable,
  FAKE_HEARTBEAT_MS: FAKE_HEARTBEAT_MS
};
