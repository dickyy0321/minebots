// ========================================
// 文件：gui/ipc-account-safety.js
// 功能：主进程账号与安全 IPC——微软正版设备码授权 / 一键清理 state（脱敏打包）/ 内存阈值检测告警
// 依赖：../modules/account-manager、../modules/safety-shield（都可选，缺失时对应通道回 ok:false）
// 导出：CHANNELS / register
// 说明：按 gui/ipc-extra.js 的约定，main.js 只在 registerIpc() 末尾调一次 register(ctx)。
//       每条通道都回 { ok, message }（双语）；授权进度用 push 推给界面（microsoft-auth-code / microsoft-auth-status）。
// 作者：MineBots
// ========================================

// 可选依赖：账号管家（微软设备码流 / 本地 Token 缓存），缺失时授权通道回 ok:false。
var accountManager = null;
try { accountManager = require("../modules/account-manager"); } catch (e) { accountManager = null; }
// 可选依赖：沙盒安全（一键清理脱敏打包 / 内存阈值检测），缺失时对应通道回 ok:false。
var safetyShield = null;
try { safetyShield = require("../modules/safety-shield"); } catch (e) { safetyShield = null; }

// 通道表：请求通道 + 回包通道 + 授权进度推送通道。
var CHANNELS = {
  microsoftAuth: "microsoft-auth",
  microsoftAuthResult: "microsoft-auth-result",
  microsoftAuthCode: "microsoft-auth-code",
  microsoftAuthStatus: "microsoft-auth-status",
  safetyClean: "safety-clean",
  safetyCleanResult: "safety-clean-result",
  safetyMemory: "safety-memory",
  safetyMemoryResult: "safety-memory-result"
};

// 取错误文本：catch 里再抛错就破红线了。
function getErrText(err) {
  try { return err && err.message ? String(err.message) : String(err); } catch (e) { return "unknown error"; }
}

// 注册全部账号 / 安全通道：ctx 需提供 onRequest 与 getWindow；缺失一律优雅返回，绝不抛错。
function register(ctx) {
  var api = ctx || {};
  if (!api || typeof api.onRequest !== "function") {
    return { ok: false, channels: 0, message: "IPC 上下文不完整 / incomplete IPC context" };
  }
  var logWarn = typeof api.logWarn === "function" ? api.logWarn : function () {};
  var getWindow = typeof api.getWindow === "function" ? api.getWindow : function () { return null; };
  // 主进程 → 界面推送：窗口不存在或已销毁时静默跳过，绝不抛错。
  var push = function (channel, data) {
    try {
      var win = getWindow();
      if (win && !win.isDestroyed()) win.webContents.send(channel, data);
    } catch (e) { /* 推送失败只告警 */ }
  };
  // 账号：微软正版授权（设备码流），界面弹窗展示 userCode + verificationUri，授权后 Token 本地缓存。
  api.onRequest(CHANNELS.microsoftAuth, CHANNELS.microsoftAuthResult, function (event, payload) {
    var p = payload || {};
    if (!accountManager || typeof accountManager.acquireMicrosoft !== "function") {
      return { ok: false, message: "账号模块未加载 / account-manager not loaded" };
    }
    var username = String(p.username || "");
    return accountManager.acquireMicrosoft({
      username: username,
      onCode: function (code, url) { push(CHANNELS.microsoftAuthCode, { username: username, code: String(code || ""), url: String(url || "") }); },
      onStatus: function (text) { push(CHANNELS.microsoftAuthStatus, { username: username, text: String(text || "") }); }
    });
  });
  // 安全：一键清理并打包 state（脱敏 API Key / 密码 / Token 后复制，可选 zip）。
  api.onRequest(CHANNELS.safetyClean, CHANNELS.safetyCleanResult, function (event, payload) {
    if (!safetyShield || typeof safetyShield.cleanState !== "function") {
      return { ok: false, message: "安全模块未加载 / safety-shield not loaded" };
    }
    try { return safetyShield.cleanState(payload || {}); }
    catch (e) { logWarn("一键清理失败 / clean state failed: " + getErrText(e)); return { ok: false, message: getErrText(e) }; }
  });
  // 安全：内存检测（>50 bot 告警）。
  api.onRequest(CHANNELS.safetyMemory, CHANNELS.safetyMemoryResult, function (event, payload) {
    var count = Number((payload && payload.botCount) || 0) || 0;
    if (!safetyShield || typeof safetyShield.checkMemory !== "function") {
      return { ok: false, message: "安全模块未加载 / safety-shield not loaded" };
    }
    try { return safetyShield.checkMemory(count); }
    catch (e) { logWarn("内存检测失败 / memory check failed: " + getErrText(e)); return { ok: false, message: getErrText(e) }; }
  });
  return { ok: true, channels: 4 };
}

// 对外导出：通道表 / 注册入口。
module.exports = { CHANNELS: CHANNELS, register: register };
