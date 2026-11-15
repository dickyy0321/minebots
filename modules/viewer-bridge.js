// ========================================
// 文件：modules/viewer-bridge.js
// 功能：3D 视角桥——给运行中的 bot 起一个 prismarine-viewer 网页（默认 127.0.0.1:3007），把地址交给 GUI 打开
// 依赖：prismarine-viewer（可选，缺失只降级并给出 npm 安装提示）、./logger（可选）
// 导出：DEFAULT_PORT / isInstalled / url / status / start / stop / startSmart / probePort / findFreePort / pageTitle / servePage
// 作者：MineBots
// ========================================
//
// 约定：
//   1. 未安装 prismarine-viewer 不算错误：返回 ok:false + 双语提示，GUI 直接把提示显示出来。
//   2. 同一时间只留一个视角服务；换 bot 先关旧的，绝不监听同一端口两次。
//   3. 所有外部调用（require / 起服务 / 关服务）都包 try/catch，失败只写日志。
// ES5 风格，CommonJS，无中文变量名
var net = require("net");
var http = require("http");
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：默认端口（和 prismarine-viewer 官方示例一致，避开 25565 / 3000）。
var DEFAULT_PORT = 3007;
// 常量：允许的端口区间。
var MIN_PORT = 1024;
var MAX_PORT = 65535;
// 常量：端口被占时往后试几个（3007 占用就试 3008、3009…）。
var PORT_SCAN_SPAN = 20;
// 常量：视角服务的视距（区块），6 在低配机器上也不卡。
var VIEW_DISTANCE = 6;

// 状态：当前正在跑的视角服务 { botId, port, server, at }。
var current = { botId: "", port: 0, server: null, at: 0 };
// 状态：包装页（改标题用的那层 iframe 页）的 http 服务。
var pageServer = null;
// 状态：prismarine-viewer 模块缓存（只 require 一次，缺失就一直记着缺失）。
var viewerMod = null;
var viewerTried = false;

// 安全提取错误文本，catch 里不会二次抛错。
function getErrText(err) {
  try {
    if (!err) return "unknown error";
    if (err.message) return String(err.message);
    return String(err);
  } catch (e) { return "unknown error"; }
}

// 转文本（null / undefined → 空串）。
function toText(value) {
  try {
    if (value === null || value === undefined) return "";
    return String(value);
  } catch (e) { return ""; }
}

// 转数字（非法值返回兜底值）。
function toNum(value, fallback) {
  try {
    var n = parseInt(toText(value), 10);
    return isNaN(n) ? fallback : n;
  } catch (e) { return fallback; }
}

// 写文件日志：视角服务属低频信息，只落文件。
function logInfo(msg) {
  try {
    if (logger && typeof logger.info === "function") { logger.info("[viewer-bridge] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[viewer-bridge] " + msg); } catch (e2) { /* ignore */ }
}

// 写告警日志：起服务失败要人看见。
function logWarn(msg) {
  try {
    if (logger && typeof logger.warn === "function") { logger.warn("[viewer-bridge] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.warn("[viewer-bridge] " + msg); } catch (e2) { /* ignore */ }
}

// 内部：懒加载 prismarine-viewer（可选依赖，缺失时返回 null，且不会反复尝试 require）。
function loadViewer() {
  if (viewerTried) return viewerMod;
  viewerTried = true;
  try { viewerMod = require("prismarine-viewer"); } catch (e) { viewerMod = null; }
  if (!viewerMod) logInfo("prismarine-viewer 未安装 / not installed");
  return viewerMod;
}

// 功能 1：prismarine-viewer 是否可用（GUI 用它决定按钮是「打开」还是「去安装」）。
function isInstalled() {
  var mod = loadViewer();
  return !!(mod && typeof mod.mineflayer === "function");
}

// 内部：把端口规整到合法区间，非法值一律回落到默认端口。
function normalizePort(port) {
  var p = toNum(port, DEFAULT_PORT);
  if (isNaN(p) || p < MIN_PORT || p > MAX_PORT) p = DEFAULT_PORT;
  return p;
}

// 功能 2：视角网页地址（不开服务也算得出来，GUI 先展示再打开）。
function url(port) {
  return "http://127.0.0.1:" + normalizePort(port) + "/";
}

// 功能 3：当前状态——running / botId / port / url / installed；永不出错。
function status() {
  var running = !!(current && current.server);
  return {
    ok: true,
    running: running,
    botId: running ? toText(current.botId) : "",
    port: running ? current.port : DEFAULT_PORT,
    url: running ? url(current.port) : "",
    installed: isInstalled(),
    message: running
      ? ("视角服务运行中 / viewer running: " + url(current.port))
      : "视角服务未启动 / viewer idle"
  };
}

// 功能 4：给某个 bot 起视角网页；成功返回 { ok:true, url }，失败返回 ok:false + 双语提示。
function start(bot, botId, port) {
  var id = toText(botId) || toText(bot && (bot._mbBotId || bot.username));
  if (!bot) return { ok: false, installed: isInstalled(), message: "bot not ready / 机器人未就绪" };
  var mod = loadViewer();
  if (!mod || typeof mod.mineflayer !== "function") {
    return {
      ok: false, installed: false, botId: id,
      message: "未安装 prismarine-viewer / not installed: npm i prismarine-viewer"
    };
  }
  stop();
  var p = normalizePort(port);
  try {
    var server = mod.mineflayer(bot, { port: p, firstPerson: false, viewDistance: VIEW_DISTANCE });
    current = { botId: id, port: p, server: server || {}, at: Date.now() };
    logInfo("视角服务已启动 / viewer started: " + id + " @ " + url(p));
    return { ok: true, botId: id, port: p, url: url(p), message: "3D 视角已启动 / viewer started: " + url(p) };
  } catch (err) {
    current = { botId: "", port: 0, server: null, at: 0 };
    logWarn("视角服务启动失败 / viewer start failed: " + getErrText(err));
    return { ok: false, installed: true, botId: id, port: p, message: "视角服务启动失败 / viewer start failed: " + getErrText(err) };
  }
}

// 功能 5：关掉视角服务（重复调用安全），close 接口不统一所以三种写法都试一遍。
function stop() {
  stopPage();
  var target = current ? current.server : null;
  current = { botId: "", port: 0, server: null, at: 0 };
  if (!target) return { ok: true, message: "视角服务未启动 / viewer not running" };
  try {
    if (typeof target.close === "function") target.close();
    else if (target.httpServer && typeof target.httpServer.close === "function") target.httpServer.close();
    else if (typeof target.kill === "function") target.kill();
    logInfo("视角服务已关闭 / viewer stopped");
    return { ok: true, message: "视角服务已关闭 / viewer stopped" };
  } catch (err) {
    logWarn("视角服务关闭失败 / viewer stop failed: " + getErrText(err));
    return { ok: false, message: "视角服务关闭失败 / viewer stop failed: " + getErrText(err) };
  }
}

// 内部：关掉包装页服务（没起过就安全返回 false）。
function stopPage() {
  var target = pageServer;
  pageServer = null;
  if (!target) return false;
  try {
    if (typeof target.close === "function") target.close();
    return true;
  } catch (e) { return false; }
}

// 功能 6：探测端口是否空闲，空闲 resolve(true)，被占用 / 出错 resolve(false)，永不 reject。
function probePort(port) {
  return new Promise(function (resolve) {
    var p = normalizePort(port);
    var probe = null;
    var done = false;
    function finish(free) {
      if (done) return;
      done = true;
      try { if (probe) probe.close(); } catch (e) { /* ignore */ }
      resolve(free === true);
    }
    try {
      probe = net.createServer();
      probe.once("error", function () { finish(false); });
      probe.once("listening", function () { finish(true); });
      probe.listen(p, "127.0.0.1");
      if (probe.unref) probe.unref();
    } catch (err) {
      finish(false);
    }
  });
}

// 功能 7：从 startPort 往后找一个空闲端口（跨度 span），全被占用就退回 startPort 让 start() 如实报错。
function findFreePort(startPort, span) {
  var start = normalizePort(startPort);
  var total = toNum(span, PORT_SCAN_SPAN);
  if (isNaN(total) || total < 1) total = PORT_SCAN_SPAN;
  var tried = 0;
  function step(p) {
    if (tried >= total || p > MAX_PORT) return Promise.resolve(start);
    tried++;
    return probePort(p).then(function (free) {
      if (free) return p;
      return step(p + 1);
    });
  }
  try { return step(start); } catch (e) { return Promise.resolve(start); }
}

// 功能 8：浏览器标签标题——固定 "MineBots - [机器人] 的 3D 视角"。
function pageTitle(botId) {
  var id = toText(botId) || "bot";
  return "MineBots - [" + id + "] 的 3D 视角";
}

// 内部：拼包装页 HTML（viewer 自带页面改不了 title，用 iframe 套一层）。
function buildPage(title, innerUrl) {
  var safeTitle = toText(title).replace(/</g, "&lt;");
  return "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">" +
    "<title>" + safeTitle + "</title>" +
    "<style>html,body{margin:0;height:100%;background:#111;color:#ddd;" +
    "font:13px/1.6 system-ui,sans-serif}iframe{border:0;width:100%;height:100%;display:block}</style>" +
    "</head><body><iframe src=\"" + toText(innerUrl) + "\" allowfullscreen></iframe></body></html>";
}

// 功能 9：起包装页（带标题），成功 resolve({ ok:true, url, port, title })，失败 resolve ok:false，永不 reject。
function servePage(botId, innerUrl, port) {
  return new Promise(function (resolve) {
    var p = normalizePort(port);
    var title = pageTitle(botId);
    var html = buildPage(title, innerUrl);
    var server = null;
    try {
      stopPage();
      server = http.createServer(function (req, res) {
        try {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
        } catch (e1) { /* 单次请求失败不影响服务 */ }
      });
      server.on("error", function (err) {
        logWarn("包装页启动失败 / page server failed: " + getErrText(err));
        try { server.close(); } catch (e2) { /* ignore */ }
        resolve({ ok: false, port: p, message: "包装页启动失败 / page server failed: " + getErrText(err) });
      });
      server.listen(p, "127.0.0.1", function () {
        pageServer = server;
        logInfo("视角页面已就绪 / viewer page ready: " + url(p) + " title=" + title);
        resolve({ ok: true, port: p, url: url(p), title: title });
      });
      if (server.unref) server.unref();
    } catch (err) {
      resolve({ ok: false, port: p, message: "包装页异常 / page server error: " + getErrText(err) });
    }
  });
}

// 功能 10：智能启动——先在出生之后、再找空闲端口（默认 3007，占用自动 3008…），最后套一层带标题的页面。
// 返回 { ok, installed, botId, port, url, title?, message }，任何情况都不抛错。
function startSmart(bot, botId, port) {
  var id = toText(botId) || toText(bot && (bot._mbBotId || bot.username));
  if (!bot) return Promise.resolve({ ok: false, installed: isInstalled(), message: "bot not ready / 机器人未就绪" });
  if (!isInstalled()) {
    return Promise.resolve({
      ok: false, installed: false, botId: id,
      message: "未安装 prismarine-viewer / not installed: npm i prismarine-viewer"
    });
  }
  var spawned = false;
  try { spawned = !!(bot.entity && bot.entity.position); } catch (e) { spawned = false; }
  if (!spawned) {
    return Promise.resolve({
      ok: false, installed: true, botId: id,
      message: "机器人还没进入世界 / bot not spawned yet：请等出生后再开 3D 视角"
    });
  }
  var prefer = normalizePort(port);
  return findFreePort(prefer, PORT_SCAN_SPAN).then(function (inner) {
    var res = start(bot, id, inner);
    if (!res || res.ok !== true) return res;
    var pageStart = inner + 1 > MAX_PORT ? DEFAULT_PORT : inner + 1;
    return findFreePort(pageStart, PORT_SCAN_SPAN).then(function (pagePort) {
      return servePage(id, res.url, pagePort).then(function (page) {
        if (page && page.ok) {
          res.port = inner;
          res.url = page.url;
          res.pageUrl = page.url;
          res.title = page.title;
          res.viewerUrl = url(inner);
          res.message = "3D 视角已启动 / viewer started: " + page.url;
        }
        return res;
      });
    });
  }).then(function (out) {
    return out;
  }, function (err) {
    logWarn("视角智能启动失败 / viewer smart start failed: " + getErrText(err));
    return { ok: false, installed: true, botId: id, message: "视角服务启动失败 / viewer start failed: " + getErrText(err) };
  });
}

// 对外导出：端口常量 / 探测 / 地址 / 状态 / 启动 / 关闭（含智能启动与端口扫描）。
module.exports = {
  DEFAULT_PORT: DEFAULT_PORT,
  isInstalled: isInstalled,
  url: url,
  status: status,
  start: start,
  stop: stop,
  startSmart: startSmart,
  probePort: probePort,
  findFreePort: findFreePort,
  pageTitle: pageTitle,
  servePage: servePage
};
