// ========================================
// 文件：gui/ipc-extra.js
// 功能：主进程附加 IPC——实时遥测（1 秒推送 + 挨打告警）/ 手动驾驶 / 3D 视角 / 16 个高级动作 / 蜂群控制台
// 依赖：../modules/telemetry、../modules/manual-control、../modules/viewer-bridge、
//       ../modules/actions-catalog、../modules/swarm-console（都可选，缺失时对应通道回 ok:false）、../modules/logger（可选）
// 导出：CHANNELS / register / collectState
// 说明：viewerOpen / viewerStop 通道是「3D 视角已废弃」后的兼容保留（deprecated, kept for compatibility），
//       界面已停用、前端也不再绑定或发送，仅为旧数据不报错；地图能力一律走 2D 雷达。
// 作者：MineBots
// ========================================
//
// 约定：
//   1. main.js 只负责在 registerIpc() 末尾调一次 register(ctx)，本文件自己注册全部通道。
//   2. 每条通道都必须回 { ok, message }（双语），异常一律吞掉并写日志，绝不冒到 Electron 顶层。
//   3. 遥测是「推」的：主进程 1 秒一拍，只在窗口存在时推，窗口销毁后自动静默。
// ES5 风格，CommonJS，无中文变量名
var telemetry = null;
try { telemetry = require("../modules/telemetry"); } catch (e) { telemetry = null; }

var manualControl = null;
try { manualControl = require("../modules/manual-control"); } catch (e) { manualControl = null; }

var viewerBridge = null;
try { viewerBridge = require("../modules/viewer-bridge"); } catch (e) { viewerBridge = null; }

var actionsCatalog = null;
try { actionsCatalog = require("../modules/actions-catalog"); } catch (e) { actionsCatalog = null; }

var swarmConsole = null;
try { swarmConsole = require("../modules/swarm-console"); } catch (e) { swarmConsole = null; }

// 可选依赖：聊天频道隔离与模型档案池（发布前遗留补丁），缺失时对应通道回 ok:false。
var chatChannel = null;
try { chatChannel = require("../modules/chat-channel"); } catch (e) { chatChannel = null; }
var modelProfile = null;
try { modelProfile = require("../modules/model-profile"); } catch (e) { modelProfile = null; }

var logger = null;
try { logger = require("../modules/logger"); } catch (e) { logger = null; }

// 常量：本文件负责的全部 IPC 通道名（渲染进程 / preload 必须与之一致）。
var CHANNELS = {
  telemetryGet: "telemetry-get",
  telemetryData: "telemetry-data",
  telemetryWatch: "telemetry-watch",
  manualControl: "manual-control",
  manualResult: "manual-result",
  viewerOpen: "viewer-open",
  viewerStop: "viewer-stop",
  viewerResult: "viewer-result",
  actionList: "action-list",
  actionListData: "action-list-data",
  actionRun: "action-run",
  actionResult: "action-result",
  swarmConsole: "swarm-console",
  swarmConsoleData: "swarm-console-data",
  channelList: "channel-list",
  channelSet: "channel-set",
  channelCommand: "channel-command",
  channelClear: "channel-clear",
  channelResult: "channel-result",
  modelProfileList: "model-profile-list",
  modelProfileSet: "model-profile-set",
  modelProfileRemove: "model-profile-remove",
  modelProfileBind: "model-profile-bind",
  modelProfileUnbind: "model-profile-unbind",
  modelProfileResult: "model-profile-result"
};

// 常量：遥测推送间隔（毫秒）——1 秒一拍，再快就是刷屏。
var BROADCAST_MS = 1000;

// 状态：main.js 传进来的上下文 + 当前是否在推送。
var ctxRef = null;
var watching = false;

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

// 写文件日志：推送心跳属高频信息，只落文件不推 GUI。
function logInfo(msg) {
  try {
    if (logger && typeof logger.info === "function") { logger.info("[ipc-extra] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[ipc-extra] " + msg); } catch (e2) { /* ignore */ }
}

// 写告警日志：通道异常要人看见。
function logWarn(msg) {
  try {
    if (logger && typeof logger.warn === "function") { logger.warn("[ipc-extra] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.warn("[ipc-extra] " + msg); } catch (e2) { /* ignore */ }
}

// 内部：往 GUI 推一条数据；窗口不存在 / 已销毁时静默返回 false。
function sendToGui(channel, payload) {
  try {
    if (!ctxRef || typeof ctxRef.getWindow !== "function") return false;
    var win = ctxRef.getWindow();
    if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) return false;
    if (!win.webContents || typeof win.webContents.send !== "function") return false;
    win.webContents.send(channel, payload);
    return true;
  } catch (err) {
    logWarn("推送失败 / push failed: " + channel + " - " + getErrText(err));
    return false;
  }
}

// 内部：给 bot 挂遥测监听（幂等：已经挂过就不再挂，避免把事件环形缓存清空）。
function ensureTelemetry(bot, botId) {
  try {
    if (!telemetry || !bot) return false;
    if (bot._mbTelemetry) return true;
    if (typeof telemetry.attach !== "function") return false;
    return telemetry.attach(bot, botId) === true;
  } catch (err) {
    logInfo("遥测挂载失败 / telemetry attach failed: " + getErrText(err));
    return false;
  }
}

// 功能 1：采集一轮所有 bot 的实时状态（GUI 面板与 AI 工具读的是同一份结构）。
function collectState() {
  var out = { ok: true, bots: [], at: Date.now() };
  try {
    if (!ctxRef || typeof ctxRef.listBots !== "function") return out;
    var rows = ctxRef.listBots() || [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i] || {};
      var id = toText(row.id);
      var bot = null;
      try { bot = ctxRef.botOf(id); } catch (e1) { bot = null; }
      if (!bot) bot = row.bot || null;
      if (!bot) {
        out.bots.push({ ok: false, id: id, username: toText(row.username), status: toText(row.status), message: "bot 未运行 / bot not running", events: [] });
        continue;
      }
      ensureTelemetry(bot, id);
      var state = null;
      try { state = telemetry ? telemetry.getBotState(bot) : null; } catch (e2) { state = null; }
      if (!state) state = { ok: false, id: id, message: "telemetry 未加载 / telemetry not loaded" };
      state.id = id || toText(state.id);
      state.username = toText(row.username) || toText(bot.username);
      state.status = toText(row.status);
      state.events = [];
      try { state.events = telemetry && telemetry.recentEvents ? telemetry.recentEvents(bot, 5) : []; } catch (e3) { state.events = []; }
      out.bots.push(state);
    }
  } catch (err) {
    logInfo("采集失败 / collect failed: " + getErrText(err));
    out.ok = false;
    out.message = "采集失败 / collect failed: " + getErrText(err);
  }
  return out;
}

// 内部：取请求里指定的 bot；没指定或取不到时回双语失败（调用方直接 return）。
function botOfPayload(payload) {
  var p = payload || {};
  var id = toText(p.botId || p.id);
  var bot = null;
  try { bot = (ctxRef && typeof ctxRef.botOf === "function") ? ctxRef.botOf(id) : null; } catch (e) { bot = null; }
  if (bot) return { ok: true, bot: bot, id: id };
  return { ok: false, bot: null, id: id, message: "bot 未运行 / bot not running: " + (id.length > 0 ? id : "(未指定 / none)") };
}

// 功能 2：手动驾驶——{ botId, action, key, on, yaw, pitch, slot } 直接转给 manual-control。
function handleManual(payload) {
  var p = payload || {};
  var action = toText(p.action) || "press";
  if (!manualControl || typeof manualControl.handle !== "function") {
    return { ok: false, action: action, message: "manual-control 未加载 / manual-control not loaded" };
  }
  var hit = botOfPayload(p);
  if (!hit.ok) return { ok: false, action: action, message: hit.message };
  return manualControl.handle(hit.bot, p);
}

// 功能 3：打开 3D 视角——等出生后找空闲端口（默认 3007，被占自动 3008…）起服务，再用系统浏览器打开带标题的页面。
function handleViewerOpen(payload) {
  var p = payload || {};
  if (!viewerBridge || typeof viewerBridge.start !== "function") {
    return { ok: false, installed: false, message: "viewer-bridge 未加载 / viewer-bridge not loaded" };
  }
  var hit = botOfPayload(p);
  if (!hit.ok) return { ok: false, installed: viewerBridge.isInstalled(), message: hit.message };
  var run = (typeof viewerBridge.startSmart === "function")
    ? function () { return viewerBridge.startSmart(hit.bot, hit.id, p.port); }
    : function () { return viewerBridge.start(hit.bot, hit.id, p.port); };
  return Promise.resolve().then(run).then(function (res) {
    var out = (res && typeof res === "object") ? res : { ok: false, message: "视角服务无返回 / viewer no result" };
    if (out.ok && out.url) out.opened = openBrowser(out.url);
    return out;
  }, function (err) {
    logWarn("视角服务启动失败 / viewer start failed: " + getErrText(err));
    return {
      ok: false, installed: viewerBridge.isInstalled(), botId: hit.id,
      message: "视角服务启动失败 / viewer start failed: " + getErrText(err)
    };
  });
}

// 内部：用系统默认浏览器打开地址（Electron 不在 / 调不通只降级，不影响视角服务本身）。
function openBrowser(target) {
  try {
    var electron = require("electron");
    var sh = electron ? electron.shell : null;
    if (!sh || typeof sh.openExternal !== "function") return false;
    var res = sh.openExternal(target);
    if (res && typeof res.catch === "function") res.catch(function () { return null; });
    return true;
  } catch (err) {
    logWarn("打开浏览器失败 / open browser failed: " + getErrText(err));
    return false;
  }
}

// 功能 4：关掉 3D 视角（窗口关掉 / 换 bot 时调）。
function handleViewerStop() {
  if (!viewerBridge || typeof viewerBridge.stop !== "function") {
    return { ok: false, message: "viewer-bridge 未加载 / viewer-bridge not loaded" };
  }
  return viewerBridge.stop();
}

// 功能 5：执行一个高级动作——{ botId, name, args }，返回动作自己的 { ok, action, message }。
function runAction(payload) {
  var p = payload || {};
  var name = toText(p.name);
  if (!actionsCatalog || typeof actionsCatalog.execute !== "function") {
    return { ok: false, action: name, message: "actions-catalog 未加载 / actions-catalog not loaded" };
  }
  if (name.length === 0) return { ok: false, action: "", message: "动作名不能为空 / action name required" };
  var hit = botOfPayload(p);
  if (!hit.ok) return Promise.resolve({ ok: false, action: name, message: hit.message });
  return actionsCatalog.execute(hit.bot, name, p.args || {});
}

// 功能 6：蜂群控制台统一入口——status / commands / reset 走快照，其余交给 swarm-console.handle；绝不抛到顶层。
function handleSwarm(payload) {
  var p = payload && typeof payload === "object" ? payload : {};
  var id = toText(p.botId || p.id) || "default";
  var bad = { ok: false, botId: id, command: "", message: "swarm-console 未加载 / swarm-console not loaded", data: null, at: Date.now() };
  if (!swarmConsole) return Promise.resolve(bad);
  // 真实 bot 在场时挂反射层（幂等）；bot 未运行时战略 / 生态命令仍可离线执行。
  try {
    var bot = null;
    try { bot = ctxRef && typeof ctxRef.botOf === "function" ? ctxRef.botOf(id) : null; } catch (eBot) { bot = null; }
    if (bot) swarmConsole.attachBot(bot, id);
  } catch (eAttach) { logInfo("反射层挂载跳过 / reflex attach skipped: " + getErrText(eAttach)); }
  try {
    var action = toText(p.action).toLowerCase();
    if (action === "status") return Promise.resolve(swarmConsole.status(id));
    if (action === "commands") return Promise.resolve(swarmConsole.commands());
    if (action === "reset") return Promise.resolve(swarmConsole.reset(id));
    return Promise.resolve(swarmConsole.handle(p));
  } catch (e) {
    logWarn("蜂群控制台失败 / swarm console failed: " + getErrText(e));
    bad.message = "蜂群控制台异常 / swarm console error: " + getErrText(e);
    return Promise.resolve(bad);
  }
}

// 功能 7：注册全部附加通道（main.js 在 registerIpc() 末尾调一次即可）。
// 处理聊天频道请求：list / set / command / clear；回包同时带最新频道表与统计，前端不用再拉一次。
function handleChannel(action, payload) {
  var p = payload && typeof payload === "object" ? payload : {};
  var out = { ok: false, action: action, message: "", channels: [], stats: null, matched: false };
  if (!chatChannel) { out.message = "频道模块未加载 / chat-channel unavailable"; return out; }
  try {
    if (action === "set") {
      var r = chatChannel.assign(p.botId, p.channel, { maxMembers: p.maxMembers });
      out.ok = r.ok; out.message = r.message;
    } else if (action === "command") {
      var c = chatChannel.handleCommand(p.text, {});
      out.ok = c.ok; out.matched = c.matched;
      out.message = c.message || "频道指令未命中 / channel command not matched";
    } else if (action === "clear") {
      chatChannel.reset(); out.ok = true; out.message = "频道已清空 / channels cleared";
    } else {
      out.ok = true; out.message = "频道清单已刷新 / channel list refreshed";
    }
    out.channels = chatChannel.format();
    out.stats = chatChannel.stats();
    return out;
  } catch (err) {
    out.message = "频道请求失败 / channel request failed: " + getErrText(err);
    return out;
  }
}

// 处理模型档案池请求：list / set / remove；回包带档案列表、每个 bot 的选择与单例统计。
function handleModel(action, payload) {
  var p = payload && typeof payload === "object" ? payload : {};
  var out = { ok: false, action: action, message: "", profiles: [], assignments: {}, stats: null };
  if (!modelProfile) { out.message = "档案池未加载 / model-profile unavailable"; return out; }
  try {
    if (action === "set") {
      var r = modelProfile.setFor(p.botId, p.profile, {});
      out.ok = r.ok; out.message = r.message;
    } else if (action === "remove") {
      var d = modelProfile.removeFor(p.botId);
      out.ok = d.ok; out.message = d.message;
    } else if (action === "bind") {
      // 独立绑定：某个 bot 固定用「某框架 + 某模型」，压过档案预设。
      var b = modelProfile.bind(p.botId, p);
      out.ok = b.ok; out.message = b.message; out.binding = b.binding; out.config = b.config;
    } else if (action === "unbind") {
      var u = modelProfile.unbind(p.botId);
      out.ok = u.ok; out.message = u.message;
    } else {
      out.ok = true; out.message = "档案池已刷新 / profile pool refreshed";
    }
    out.profiles = modelProfile.list();
    out.assignments = modelProfile.assignments();
    out.bindings = modelProfile.listBindings();
    out.stats = modelProfile.stats();
    return out;
  } catch (err) {
    out.message = "档案池请求失败 / profile request failed: " + getErrText(err);
    return out;
  }
}

function register(ctx) {
  var api = ctx || {};
  ctxRef = api;
  if (!api || typeof api.onRequest !== "function" || typeof api.onSend !== "function") {
    logWarn("IPC 上下文不完整 / incomplete IPC context");
    return { ok: false, channels: 0, message: "IPC 上下文不完整 / incomplete IPC context" };
  }
  // 遥测：一拍推一次；kind=alert 表示挨打告警（渲染进程弹提示）。
  try {
    if (telemetry && typeof telemetry.setSink === "function") {
      telemetry.setSink(function (payload) { sendToGui(CHANNELS.telemetryData, payload); });
    }
  } catch (err) { logWarn("注册遥测出口失败 / telemetry sink failed: " + getErrText(err)); }

  api.onRequest(CHANNELS.telemetryGet, CHANNELS.telemetryData, function () { return collectState(); });
  api.onSend(CHANNELS.telemetryWatch, function (event, payload) {
    var on = !!(payload && payload.on === true);
    watching = on;
    try {
      if (!telemetry) return;
      if (on && typeof telemetry.startBroadcast === "function") {
        telemetry.startBroadcast(collectState, BROADCAST_MS);
      } else if (typeof telemetry.stopBroadcast === "function") {
        telemetry.stopBroadcast();
      }
    } catch (err) { logWarn("切换推送失败 / toggle broadcast failed: " + getErrText(err)); }
    sendToGui(CHANNELS.telemetryData, collectState());
    logInfo("遥测推送 / broadcast watching = " + (on ? "on" : "off"));
  });
  api.onRequest(CHANNELS.manualControl, CHANNELS.manualResult, function (event, payload) { return handleManual(payload); });
  api.onRequest(CHANNELS.viewerOpen, CHANNELS.viewerResult, function (event, payload) { return handleViewerOpen(payload); });
  api.onRequest(CHANNELS.viewerStop, CHANNELS.viewerResult, function () { return handleViewerStop(); });
  api.onRequest(CHANNELS.actionList, CHANNELS.actionListData, function () {
    if (!actionsCatalog || typeof actionsCatalog.list !== "function") {
      return { ok: false, actions: [], message: "actions-catalog 未加载 / actions-catalog not loaded" };
    }
    var list = [];
    try { list = actionsCatalog.list(); } catch (err) { list = []; }
    return { ok: true, actions: list, count: list.length };
  });
  api.onRequest(CHANNELS.actionRun, CHANNELS.actionResult, function (event, payload) { return runAction(payload); });
  api.onRequest(CHANNELS.swarmConsole, CHANNELS.swarmConsoleData, function (event, payload) { return handleSwarm(payload); });
  // 发布前遗留补丁：聊天频道隔离 + 模型档案池（每个通道都回 { ok, message, 最新数据 }）。
  api.onRequest(CHANNELS.channelList, CHANNELS.channelResult, function () { return handleChannel("list", {}); });
  api.onRequest(CHANNELS.channelSet, CHANNELS.channelResult, function (event, payload) { return handleChannel("set", payload); });
  api.onRequest(CHANNELS.channelCommand, CHANNELS.channelResult, function (event, payload) { return handleChannel("command", payload); });
  api.onRequest(CHANNELS.channelClear, CHANNELS.channelResult, function () { return handleChannel("clear", {}); });
  api.onRequest(CHANNELS.modelProfileList, CHANNELS.modelProfileResult, function () { return handleModel("list", {}); });
  api.onRequest(CHANNELS.modelProfileSet, CHANNELS.modelProfileResult, function (event, payload) { return handleModel("set", payload); });
  api.onRequest(CHANNELS.modelProfileRemove, CHANNELS.modelProfileResult, function (event, payload) { return handleModel("remove", payload); });
  api.onRequest(CHANNELS.modelProfileBind, CHANNELS.modelProfileResult, function (event, payload) { return handleModel("bind", payload); });
  api.onRequest(CHANNELS.modelProfileUnbind, CHANNELS.modelProfileResult, function (event, payload) { return handleModel("unbind", payload); });
  logInfo("附加通道已注册 / extra channels registered: " + Object.keys(CHANNELS).length);
  return { ok: true, channels: Object.keys(CHANNELS).length, watching: watching };
}

// 对外导出：通道表 / 注册入口 / 采集（自检会直接调 collectState）。
module.exports = {
  CHANNELS: CHANNELS,
  register: register,
  collectState: collectState
};
