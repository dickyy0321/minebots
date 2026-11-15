// ========================================
// 文件：modules/protocol-forge.js
// 功能：模组服协议穿透——forge 兼容层探测 / 客户端品牌伪装 / 「模组注册表缺失」判定与重试
// 依赖：./logger（可选，失败不崩）；minecraft-protocol-forge 系列包（可选，装了才用）
// 导出：describe / isAvailable / decorate / handshake / classify / onLoginError
//       常量 BRAND / MAX_MOD_RETRY / FORGE_PACKAGES / MOD_ERROR_HINTS
// 作者：MineBots
// ========================================
//
// 说明：本项目不内置 forge 兼容层（node_modules 里没有就只用品牌伪装），
//       decorate / handshake 全部「有就挂，没有就降级」，绝不因为缺包让机器人连不上。

// 可选依赖：日志核心，缺失时退回 console，绝不抛错。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
// 可选依赖：引擎控制中心（专家模式可关协议穿透 / 调模组重试上限）。
var engineControl = null;
try { engineControl = require("./engine-control"); } catch (e) { engineControl = null; }

// 常量：客户端品牌伪装串——forge / fml / neoforge 三连，服务器读 MC|Brand 时看到的就是它。
var BRAND = "fml,forge,neoforge";
// 常量：forge 兼容层候选包名（装了哪个用哪个，一个都没装就只做品牌伪装）。
var FORGE_PACKAGES = ["minecraft-protocol-forge", "node-minecraft-protocol-forge", "mineflayer-forge"];
// 常量：同一个 bot 最多为「模组注册表缺失」重连几次，超过就认命停下，避免死循环刷屏。
var MAX_MOD_RETRY = 3;
// 常量：判定「模组注册表缺失」的关键词（服务器原话命中任意一条就按模组问题处理）。
var MOD_ERROR_HINTS = [
  "unknown block", "unknown item", "unknown entity", "missing mod", "missing registry",
  "registry", "mod rejection", "incompatible mod", "missing tag", "mod mismatch",
  "palette", "registry entry", "modded", "forge", "fml", "neoforge"
];

// 内部状态：兼容层懒加载缓存（只找一次，找到就一直用）。
var forgeLib = null;
var forgeScanned = false;

// 读引擎开关：控制中心缺失或读失败时按开启处理。
function isEngineEnabled() {
  try {
    if (engineControl && typeof engineControl.isEnabled === "function") return engineControl.isEnabled("protocolForge") === true;
  } catch (e) { /* 读失败按开启 */ }
  return true;
}

// 读面板配置的模组重试上限；读不到退回内置 3 次。
function engineMaxRetry() {
  try {
    if (engineControl && typeof engineControl.param === "function") {
      var n = engineControl.param("protocolForge", "protocolMaxRetry");
      if (n >= 0 && n <= 10) return n;
    }
  } catch (e) { /* 读失败用默认值 */ }
  return MAX_MOD_RETRY;
}

// 写普通信息日志：只落文件，缺 logger 时静默。
function logInfo(message) {
  try { if (logger && typeof logger.info === "function") logger.info(message); } catch (e) { /* ignore */ }
}

// 写警告日志：优先 logger.warn（会推 GUI），缺 logger 时退回 console。
function logWarn(message) {
  try {
    if (logger && typeof logger.warn === "function") { logger.warn(message); return; }
    console.warn(message);
  } catch (e) { /* ignore */ }
}

// 安全提取错误文本，catch 里绝不二次抛错。
function errText(err) {
  try {
    if (!err) return "unknown error / 未知错误";
    if (typeof err === "string") return err;
    if (err.message) return String(err.message);
    return String(err);
  } catch (e) { return "unknown error / 未知错误"; }
}

// 懒加载 forge 兼容层：按候选包名逐个 require，成功就缓存；失败返回 null，绝不抛错。
function loadForge() {
  if (forgeScanned) return forgeLib;
  forgeScanned = true;
  for (var i = 0; i < FORGE_PACKAGES.length; i++) {
    var mod = null;
    try { mod = require(FORGE_PACKAGES[i]); } catch (e) { mod = null; }
    if (mod) {
      forgeLib = mod;
      logInfo("[protocol-forge] 已挂载 forge 兼容层 / forge layer loaded: " + FORGE_PACKAGES[i]);
      return forgeLib;
    }
  }
  logInfo("[protocol-forge] 未找到 forge 兼容层，改用品牌伪装 / no forge layer, brand spoof only");
  return null;
}

// 兼容层是否可用（装了 minecraft-protocol-forge 之类的包才算）。
function isAvailable() {
  return loadForge() !== null;
}

// 描述当前协议层状态：{ ok, available, module, brand }，供日志与 GUI 展示（纯只读，不抛错）。
function describe() {
  var lib = null;
  try { lib = loadForge(); } catch (e) { lib = null; }
  return { ok: true, available: lib !== null, module: lib ? "forge-layer" : null, brand: BRAND };
}

// 装饰 createBot 入参：复制一份再塞品牌伪装（有兼容层就顺带打 forge 标记）；失败返回复制品。
function decorate(options) {
  var out = {};
  try {
    var src = options || {};
    for (var key in src) {
      if (Object.prototype.hasOwnProperty.call(src, key)) out[key] = src[key];
    }
  } catch (e) { out = {}; }
  // 专家面板关掉协议穿透：不塞品牌伪装、不挂 forge 标记，原样连服务器。
  if (!isEngineEnabled()) return out;
  // 品牌伪装：先骗过服务器首包对客户端品牌的检查（forge 服最常见的「不认识的客户端」就是这么挡的）。
  try { out.brand = BRAND; } catch (e1) { /* 加不上就按原样连 */ }
  var lib = null;
  try { lib = loadForge(); } catch (e2) { lib = null; }
  if (lib) {
    try { if (!out.forge) out.forge = {}; } catch (e3) { /* 兼容层标记加不上也不影响连接 */ }
  }
  return out;
}

// 建连后补一次客户端层握手：有兼容层就 addSupportTo；没有就什么都不做，只回 ok:false。
function handshake(bot, rec) {
  var id = rec && rec.id ? String(rec.id) : "?";
  var lib = null;
  try { lib = loadForge(); } catch (e) { lib = null; }
  if (!lib) return { ok: false, handled: false, message: "forge layer unavailable / 兼容层不可用" };
  var client = null;
  try { client = bot && bot._client ? bot._client : null; } catch (e1) { client = null; }
  if (!client) return { ok: false, handled: false, message: "client not ready / 客户端未就绪" };
  try {
    if (typeof lib.addSupportTo === "function") lib.addSupportTo(client);
    logInfo("[protocol-forge] [" + id + "] 已给客户端挂上 forge 协议支持 / forge support attached");
    return { ok: true, handled: true, message: "forge handshake attached / 协议握手已挂载" };
  } catch (e2) {
    logWarn("[protocol-forge] [" + id + "] forge 握手挂载失败 / forge attach failed: " + errText(e2));
    return { ok: false, handled: false, message: errText(e2) };
  }
}

// 判定错误是不是「模组注册表缺失」类：返回 { modRelated, hint }，判定失败一律当非模组问题。
function classify(errOrText) {
  var text = "";
  try { text = errText(errOrText).toLowerCase(); } catch (e) { text = ""; }
  if (text.length === 0) return { modRelated: false, hint: "" };
  for (var i = 0; i < MOD_ERROR_HINTS.length; i++) {
    var hint = MOD_ERROR_HINTS[i];
    // 单看 forge / fml / modded 太宽（普通服务器名里也可能出现），必须和报错语境同现才认。
    if (hint === "forge" || hint === "fml" || hint === "neoforge" || hint === "modded") {
      var bad = text.indexOf("error") >= 0 || text.indexOf("reject") >= 0 || text.indexOf("fail") >= 0;
      if (text.indexOf(hint) >= 0 && bad) return { modRelated: true, hint: hint };
      continue;
    }
    if (text.indexOf(hint) >= 0) return { modRelated: true, hint: hint };
  }
  return { modRelated: false, hint: "" };
}

// 登录错误处理：模组注册表缺失不崩，记明确日志并按需重试；返回 { ok, handled, retried, hint }。
// hooks 有两个可选回调：log(文本) 用来写日志，retry() 用来立刻重连一次。
function onLoginError(rec, err, hooks) {
  // 专家面板关掉协议穿透：不判定模组问题、不重试，等同模块停止运作。
  if (!isEngineEnabled()) {
    return { ok: false, handled: false, retried: false, hint: "", disabled: true,
      message: "protocol forge disabled / 协议穿透已关闭" };
  }
  var seen = null;
  try { seen = classify(err); } catch (e) { seen = { modRelated: false, hint: "" }; }
  if (!rec || !seen || !seen.modRelated) return { ok: false, handled: false, retried: false, hint: "" };
  var id = rec.id ? String(rec.id) : "?";
  var say = hooks && typeof hooks.log === "function" ? hooks.log : logWarn;
  var tries = 0;
  try { tries = Number(rec.modRetryCount) || 0; } catch (e1) { tries = 0; }
  tries = tries + 1;
  try { rec.modRetryCount = tries; } catch (e2) { /* 记不上也不影响重试 */ }
  try { rec.modErrorHint = seen.hint; } catch (e3) { /* ignore */ }
  // 模组问题不算网络重连：把常规重连计数清零，别让 5 次上限把这个重试掐死。
  try { rec.reconnectCount = 0; } catch (e4) { /* ignore */ }
  if (tries > engineMaxRetry()) {
    try { rec.skipReconnect = true; } catch (e5) { /* ignore */ }
    try { say("[" + id + "] 模组注册表缺失，重试 " + (tries - 1) + " 次仍未通过，停止重连 / mod registry missing, giving up after " + (tries - 1) + " retries"); }
    catch (e6) { /* ignore */ }
    return { ok: true, handled: true, retried: false, hint: seen.hint, attempt: tries };
  }
  try { say("[" + id + "] 检测到模组服协议问题（" + seen.hint + "），不崩溃，第 " + tries + " 次重试 / modded protocol issue, retry #" + tries); }
  catch (e7) { /* ignore */ }
  try { if (hooks && typeof hooks.retry === "function") hooks.retry(); } catch (e8) { logWarn("[" + id + "] 模组重试失败 / mod retry failed: " + errText(e8)); }
  return { ok: true, handled: true, retried: true, hint: seen.hint, attempt: tries };
}

// 对外导出：协议层探测 / 参数装饰 / 握手 / 错误判定与重试。
module.exports = {
  BRAND: BRAND,
  MAX_MOD_RETRY: MAX_MOD_RETRY,
  FORGE_PACKAGES: FORGE_PACKAGES,
  MOD_ERROR_HINTS: MOD_ERROR_HINTS,
  isAvailable: isAvailable,
  describe: describe,
  decorate: decorate,
  handshake: handshake,
  classify: classify,
  onLoginError: onLoginError,
  isEngineEnabled: isEngineEnabled
};
