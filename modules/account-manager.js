// ========================================
// 文件：modules/account-manager.js
// 功能：账号系统——离线模式 / 正版微软账号双支持；微软设备码流（Device Code Flow）+ 本地 Token 缓存
// 依赖：fs / path（Node 内置）、prismarine-auth（可选，缺失时降级）、./logger（可选）
// 导出：authMode / available / acquireMicrosoft / loadCached / clearCache / cachePath
// 说明：prismarine-auth 用懒加载（try/catch require），未安装时所有正版流程返回 ok:false 的双语提示，
//       绝不把异常抛到顶层；授权成功后的 Token 缓存到 state/microsoft-tokens/<username>.json，
//       下次启动直接带缓存进服（免登录）。支持 MINEBOTS_STATE_DIR 隔离。
// 作者：MineBots
// ========================================

// 可选依赖：日志核心，缺失时退回 console，绝不抛错。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

var fs = require("fs");
var path = require("path");

// 常量：Token 缓存目录名 / 缓存文件名后缀 / 文件名长度上限。
var TOKEN_DIR = "microsoft-tokens";
var NAME_LIMIT = 40;

// 状态：prismarine-auth 是否已加载（懒加载一次）。
var authLib = null;
var authLibTried = false;

// 安全转字符串：null / undefined 统一成空串。
function toText(value) {
  try { return String(value === null || value === undefined ? "" : value); } catch (e) { return ""; }
}

// 取错误文本：catch 里再抛错就破红线了。
function errText(err) {
  try { return err && err.message ? String(err.message) : String(err); } catch (e) { return "unknown error"; }
}

// 写信息日志：优先 logger.info（高频不刷 GUI），不可用时退回 console。
function logInfo(msg) {
  try {
    if (logger && typeof logger.info === "function") { logger.info("[account-manager] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[account-manager] " + msg); } catch (e2) { /* ignore */ }
}

// 写告警日志：授权失败这类事要人看见。
function logWarn(msg) {
  try {
    if (logger && typeof logger.warn === "function") { logger.warn("[account-manager] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.warn("[account-manager] " + msg); } catch (e2) { /* ignore */ }
}

// 懒加载 prismarine-auth：只在第一次用到时尝试；取不到就记住失败，后续不再重试，直接降级。
// 为什么懒加载：它是外部库，可能没装；顶层 require 失败会直接让整个模块加载崩，违反红线。
function getAuthLib() {
  if (authLibTried) return authLib;
  authLibTried = true;
  try {
    var m = require("prismarine-auth");
    // 两种导出形态都认：{ MicrosoftAuthFlow } 或直接是构造函数。
    authLib = (m && m.MicrosoftAuthFlow) ? m.MicrosoftAuthFlow : (typeof m === "function" ? m : null);
  } catch (e) {
    authLib = null;
  }
  return authLib;
}

// 功能：prismarine-auth 是否可用（GUI 据此决定「正版账号」选项是否可点）。
function available() {
  return !!getAuthLib();
}

// 洗用户名：只留字母数字下划线横杠点，最长 40，非法返回空串（缓存文件名要用）。
function cleanName(value) {
  try {
    var text = toText(value).replace(/^\s+|\s+$/g, "");
    if (text.length === 0 || !/^[A-Za-z0-9_.-]+$/.test(text)) return "";
    return text.length > NAME_LIMIT ? text.slice(0, NAME_LIMIT) : text;
  } catch (e) { return ""; }
}

// 取 Token 缓存目录绝对路径：MINEBOTS_STATE_DIR 优先（自测隔离），否则项目根 state/。
function tokenDir() {
  try {
    var custom = process.env.MINEBOTS_STATE_DIR;
    if (custom && String(custom).length > 0) return path.resolve(String(custom), TOKEN_DIR);
    return path.resolve(process.cwd(), "state", TOKEN_DIR);
  } catch (e) { return path.join("state", TOKEN_DIR); }
}

// 取某个用户名的缓存文件绝对路径。
function cachePath(username) {
  var name = cleanName(username);
  if (name.length === 0) return "";
  try { return path.join(tokenDir(), name + ".json"); } catch (e) { return ""; }
}

// 功能：读取本地缓存的微软档案；没有 / 损坏时返回 null，绝不抛错。
function loadCached(username) {
  var file = cachePath(username);
  if (!file) return null;
  try {
    if (!fs.existsSync(file)) return null;
    var parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object") {
      logInfo("命中本地微软 Token 缓存 / cached microsoft token loaded: " + username);
      return parsed;
    }
  } catch (e) { logWarn("读取微软缓存失败 / read token cache failed: " + errText(e)); }
  return null;
}

// 功能：把授权成功后的档案写盘缓存（下次启动免登录）；失败只写日志不抛错。
function saveCache(username, profile) {
  var file = cachePath(username);
  if (!file || !profile || typeof profile !== "object") return false;
  try {
    var dir = tokenDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(profile, null, 2), "utf8");
    logInfo("微软 Token 已缓存到本地 / microsoft token cached: " + username);
    return true;
  } catch (e) {
    logWarn("微软 Token 缓存失败 / token cache failed: " + errText(e));
    return false;
  }
}

// 功能：删除某个用户名的正版缓存（用户手动「退出正版登录」用）。
function clearCache(username) {
  var file = cachePath(username);
  if (!file) return { ok: false, message: "用户名非法 / invalid username" };
  try {
    if (fs.existsSync(file)) { fs.unlinkSync(file); return { ok: true, message: "已清除正版缓存 / token cache cleared: " + username }; }
    return { ok: true, message: "没有可清除的缓存 / no cache to clear" };
  } catch (e) { return { ok: false, message: errText(e) }; }
}

// 功能：发起微软正版授权（设备码流）——GUI 弹窗展示 userCode + verificationUri，授权成功后缓存档案。
// 参数：{ username, onCode, onStatus }；onCode(userCode, url) 供界面弹窗；onStatus(text) 供界面滚动提示。
// 返回 Promise<{ ok, username, profile?, message }>——未装库 / 流程异常都返回 ok:false，绝不冒到顶层。
function acquireMicrosoft(options) {
  var opts = options && typeof options === "object" ? options : {};
  var username = toText(opts.username || "minecraft");
  var onCode = typeof opts.onCode === "function" ? opts.onCode : null;
  var onStatus = typeof opts.onStatus === "function" ? opts.onStatus : null;
  var lib = getAuthLib();
  if (!lib) {
    if (onStatus) try { onStatus("未安装 prismarine-auth，无法走正版授权 / prismarine-auth not installed"); } catch (e) { /* ignore */ }
    return Promise.resolve({ ok: false, username: username, message: "未安装 prismarine-auth，请在离线保护下运行 npm i prismarine-auth" });
  }
  try {
    // 已缓存则直接返回，实现「免登录」：下次启动带缓存进服。
    var hit = loadCached(username);
    if (hit) {
      if (onStatus) try { onStatus("使用本地缓存 Token，免登录 / using cached token"); } catch (e) { /* ignore */ }
      return Promise.resolve({ ok: true, username: username, profile: hit, cached: true, message: "使用本地缓存 Token / using cached token" });
    }
  } catch (eCache) { /* 缓存读失败继续走联网授权 */ }
  try {
    if (onStatus) onStatus("正在向微软发起设备码授权 / requesting device code from Microsoft");
    // 设备码流：创建流程实例，授权端点用 Minecraft Java 的 Azure 注册（协议号 00000000402...）。
    var flow = new lib("00000000402b1e90", {});
    var schema = "minecraft";
    // getAuthForAzure 走设备码；onCode 回调拿到 userCode 与 verificationUri 后交给界面弹窗。
    var p = flow.getAuthForAzure(schema, {
      onCode: function (data) {
        try {
          var code = (data && (data.userCode || data.user_code)) || "";
          var uri = (data && (data.verificationUri || data.verification_uri)) || "https://www.microsoft.com/link";
          if (onCode) onCode(code, uri);
        } catch (eCode) { /* 拿不到码只告警 */ }
      }
    });
    if (p && typeof p.then === "function") {
      return p.then(function (result) {
        var profile = result && typeof result === "object" ? result : {};
        saveCache(username, profile);
        if (onStatus) try { onStatus("授权成功，Token 已缓存 / authorized, token cached"); } catch (e) { /* ignore */ }
        return { ok: true, username: username, profile: profile, cached: false, message: "授权成功 / authorized" };
      }, function (err) {
        logWarn("微软授权失败 / microsoft auth failed: " + errText(err));
        if (onStatus) try { onStatus("授权失败 / authorization failed: " + errText(err)); } catch (e) { /* ignore */ }
        return { ok: false, username: username, message: "授权失败 / authorization failed: " + errText(err) };
      });
    }
    // 同步返回（理论上不会走到）：仍然缓存并返回。
    saveCache(username, {});
    return Promise.resolve({ ok: true, username: username, profile: {}, message: "授权完成（同步） / authorized (sync)" });
  } catch (e) {
    logWarn("微软授权异常 / microsoft auth error: " + errText(e));
    return Promise.resolve({ ok: false, username: username, message: "授权异常 / auth error: " + errText(e) });
  }
}

// 登录模式归一化：任何入参都收敛到 offline / microsoft 两态，GUI 与 bot-manager 共用。
// 它同时是函数（authMode("microsoft")）和常量袋（authMode.OFFLINE / authMode.MICROSOFT），两种用法都成立。
function authMode(raw) {
  try { return String(raw).toLowerCase() === "microsoft" ? "microsoft" : "offline"; } catch (e) { return "offline"; }
}
authMode.OFFLINE = "offline";
authMode.MICROSOFT = "microsoft";

// 对外导出：登录模式常量 + 全部接口。
module.exports = {
  authMode: authMode,
  available: available,
  acquireMicrosoft: acquireMicrosoft,
  loadCached: loadCached,
  clearCache: clearCache,
  cachePath: cachePath
};
