// ========================================
// 文件：gui/main.js
// 功能：Electron 主进程——创建主窗口与语法窗口，并在渲染进程与各模块之间转发 IPC
// 依赖：path（Node 内置）、electron（app / BrowserWindow / ipcMain）、
//       ../modules/crash-guard、../modules/core、../modules/logger、../modules/bot-manager、
//       ../modules/ai-config、../modules/context-manager、../modules/player-manager、
//       ../modules/ai-client（按需加载）、../settings
//       （除 path 外全部可选：加载失败只少一块功能，绝不崩）
// 导出：无（Electron 主进程入口，不需要 module.exports）
// 作者：MineBots
// ========================================

// 内置依赖：路径处理，Node 自带，不会加载失败。
var path = require("path");

// 可选依赖：Electron 运行时对象；取不到就只写日志，不让进程崩。
var electron = null;
try { electron = require("electron"); } catch (e) { electron = null; }
try { require("./app-paths").init(); } catch (ePaths) { /* 打包态把 state / logs 指到用户数据目录，失败不阻断启动 */ }

// 状态：Electron 的三个核心对象（取不到就是 null，后面每次都判空）。
var app = null;
var BrowserWindow = null;
var ipcMain = null;

// 可选依赖：日志 / 崩溃守卫 / 全局处理 / 机器人 / 配置。任何一个缺失都只是少一块功能。
var logger = null;
try { logger = require("../modules/logger"); } catch (e) { logger = null; }
var crashGuard = null;
try { crashGuard = require("../modules/crash-guard"); } catch (e) { crashGuard = null; }
var core = null;
try { core = require("../modules/core"); } catch (e) { core = null; }
var botManager = null;
try { botManager = require("../modules/bot-manager"); } catch (e) { botManager = null; }
var aiConfig = null;
try { aiConfig = require("../modules/ai-config"); } catch (e) { aiConfig = null; }
var contextManager = null;
try { contextManager = require("../modules/context-manager"); } catch (e) { contextManager = null; }
var playerManager = null;
try { playerManager = require("../modules/player-manager"); } catch (e) { playerManager = null; }
var settings = null;
try { settings = require("../settings"); } catch (e) { settings = null; }
// 可选依赖：偏好落盘（测试模式 / 打字机等开关，真写 state/prefs.json）。
var prefs = null;
try { prefs = require("../modules/prefs"); } catch (e) { prefs = null; }
// 可选依赖：引擎控制中心（启动时决定 Trace 是否按测试模式启用）。
var engineControl = null; try { engineControl = require("../modules/engine-control"); } catch (e) { engineControl = null; }
// 可选依赖：Ollama 真接口（状态 / 模型列表 / 拉取 / 删除）。
var ollamaInstaller = null;
try { ollamaInstaller = require("../modules/ollama-installer"); } catch (e) { ollamaInstaller = null; }
// 可选依赖：npm 插件真接口（列出 / 安装 / 卸载）。
var npmManager = null;
try { npmManager = require("../modules/npm-manager"); } catch (e) { npmManager = null; }
// 可选依赖：参数中心（参数查询面板的真数据源）。
var paramManager = null;
try { paramManager = require("../modules/param-manager"); } catch (e) { paramManager = null; }
// 常量：窗口尺寸与最小尺寸（settings 里配了就用配置值，否则用这里的默认值）。
var WIDTH = 1180;
var HEIGHT = 760;
var MIN_WIDTH = 900;
var MIN_HEIGHT = 600;
// 常量：语法窗口尺寸与两个窗口的底色。
var SYNTAX_WIDTH = 640;
var SYNTAX_HEIGHT = 720;
var BG_MAIN = "#111318";
var BG_SYNTAX = "#0f1117";

// 状态：主窗口与语法窗口的引用，窗口关闭时清空。
var mainWindow = null;
var syntaxWindow = null;

// 初始化：取出 Electron 的三个核心对象，取不到就保持 null。
function pickElectron() {
  try {
    if (!electron) return;
    app = electron.app || null;
    BrowserWindow = electron.BrowserWindow || null;
    ipcMain = electron.ipcMain || null;
  } catch (e) {
    app = null;
    BrowserWindow = null;
    ipcMain = null;
  }
}
pickElectron();

// 内部：写警告日志——优先 logger.warn，不可用时退回 console，绝不抛错。
function logWarn(msg) {
  try {
    if (logger && typeof logger.warn === "function") { logger.warn(msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.warn("[gui] " + msg); } catch (e) { /* 忽略 */ }
}

// 内部：安全提取错误文本，避免在 catch 里再次抛错。
function getErrText(err) {
  try {
    if (err && err.message) return String(err.message);
    return String(err);
  } catch (e) {
    return "unknown error";
  }
}

// 内部：安全调用模块方法——模块缺失 / 方法缺失 / 抛错都返回兜底值，绝不崩。
function call(mod, name, args, fallback) {
  try {
    if (mod && typeof mod[name] === "function") return mod[name].apply(mod, args || []);
  } catch (e) {
    logWarn("调用失败 / call failed: " + name + " - " + getErrText(e));
  }
  return fallback;
}

// 内部：模块没加载时统一返回的错误对象（中英双语提示）。
function notLoaded(name) {
  return { ok: false, message: name + " 未加载 / " + name + " not loaded" };
}
// 内部：安全回包——窗口已销毁 / 渲染进程已断开时不抛错。
function safeReply(event, channel, payload) {
  try {
    if (event && typeof event.reply === "function") event.reply(channel, payload);
  } catch (e) {
    logWarn("回包失败 / reply failed: " + channel + " - " + getErrText(e));
  }
}

// 内部：注册「请求-应答」式 IPC——处理函数返回 Promise 时自动等待，异常统一回包。
function onRequest(channel, replyChannel, handler) {
  try {
    if (!ipcMain || typeof ipcMain.on !== "function") return false;
    ipcMain.on(channel, function (event, payload) {
      var out = null;
      try {
        out = handler(event, payload);
      } catch (e) {
        safeReply(event, replyChannel, { ok: false, message: getErrText(e) });
        return;
      }
      if (out && typeof out.then === "function") {
        out.then(function (result) { safeReply(event, replyChannel, result); })
          .catch(function (err) { safeReply(event, replyChannel, { ok: false, message: getErrText(err) }); });
        return;
      }
      safeReply(event, replyChannel, out);
    });
    return true;
  } catch (e) {
    logWarn("注册 IPC 失败 / register IPC failed: " + channel + " - " + getErrText(e));
    return false;
  }
}

// 内部：注册「应答 + 推送刷新」式 IPC——处理函数返回 { result, data }，data 推给列表通道。
function onRequestPush(channel, replyChannel, dataChannel, handler) {
  return onRequest(channel, replyChannel, function (event, payload) {
    var out = handler(event, payload);
    var data = null;
    try { data = out ? out.data : null; } catch (e) { data = null; }
    safeReply(event, dataChannel, data);
    return out ? out.result : null;
  });
}

// 内部：注册单向 IPC（渲染进程只发不问）。
function onSend(channel, handler) {
  try {
    if (!ipcMain || typeof ipcMain.on !== "function") return false;
    ipcMain.on(channel, function (event, payload) {
      try {
        handler(event, payload);
      } catch (e) {
        logWarn("处理失败 / handle failed: " + channel + " - " + getErrText(e));
      }
    });
    return true;
  } catch (e) {
    logWarn("注册 IPC 失败 / register IPC failed: " + channel + " - " + getErrText(e));
    return false;
  }
}
// 内部：取窗口尺寸——settings 里配了合法数字就用它，否则用常量默认值。
function sizeOf(value, fallback) {
  try {
    var n = Number(value);
    if (isFinite(n) && n > 0) return Math.round(n);
  } catch (e) { /* 用默认值 */ }
  return fallback;
}

// 功能 1：创建主窗口——尺寸取 settings，加载 gui/renderer/index.html。
function createWindow() {
  try {
    if (!BrowserWindow) {
      logWarn("BrowserWindow 不可用 / BrowserWindow unavailable");
      return null;
    }
    var gui = (settings && settings.gui) ? settings.gui : {};
    mainWindow = new BrowserWindow({
      width: sizeOf(gui.windowWidth, WIDTH),
      height: sizeOf(gui.windowHeight, HEIGHT),
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      title: "MineBots",
      backgroundColor: BG_MAIN,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
    mainWindow.on("closed", function () { mainWindow = null; });
    return mainWindow;
  } catch (e) {
    logWarn("创建主窗口失败 / create window failed: " + getErrText(e));
    return null;
  }
}

// 功能 2：创建（或复用）语法窗口——已存在就只发语言消息并聚焦。
function createSyntaxWindow(lang) {
  try {
    if (!BrowserWindow) {
      logWarn("BrowserWindow 不可用 / BrowserWindow unavailable");
      return null;
    }
    var want = lang ? String(lang) : "zh";
    if (syntaxWindow && !syntaxWindow.isDestroyed()) {
      syntaxWindow.webContents.send("set-lang", want);
      syntaxWindow.focus();
      return syntaxWindow;
    }
    syntaxWindow = new BrowserWindow({
      width: SYNTAX_WIDTH,
      height: SYNTAX_HEIGHT,
      parent: mainWindow || undefined,
      modal: false,
      title: "Syntax",
      backgroundColor: BG_SYNTAX,
      webPreferences: {
        preload: path.join(__dirname, "syntax-window.js"),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    var win = syntaxWindow;
    if (!win) return null;
    win.loadFile(path.join(__dirname, "renderer", "syntax.html"));
    win.webContents.once("did-finish-load", function () {
      try {
        if (win && !win.isDestroyed()) win.webContents.send("set-lang", want);
      } catch (e) {
        logWarn("发送语言失败 / send lang failed: " + getErrText(e));
      }
    });
    win.on("closed", function () { syntaxWindow = null; });
    return win;
  } catch (e) {
    logWarn("创建语法窗口失败 / create syntax window failed: " + getErrText(e));
    return null;
  }
}
// 功能 3：把主进程日志推给渲染进程（logger 缺失时只提示，不影响其它功能）。
function forwardLogs() {
  try {
    if (!logger || typeof logger.onLog !== "function") {
      logWarn("logger 不可用，日志不转发 / logger unavailable, logs not forwarded");
      return false;
    }
    logger.onLog(function (entry) {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("bot-log", entry);
      } catch (e) {
        logWarn("转发日志失败 / forward log failed: " + getErrText(e));
      }
    });
    return true;
  } catch (e) {
    logWarn("注册日志转发失败 / register log forward failed: " + getErrText(e));
    return false;
  }
}

// 内部：读 AI 配置（ai-config 缺失时返回空对象，UI 显示默认值）；传 botId 时读该 bot 自己的配置。
function readAiConfig(botId) {
  var id = String(botId === undefined || botId === null ? "" : botId).trim();
  if (id.length > 0 && aiConfig && typeof aiConfig.loadFor === "function") {
    return call(aiConfig, "loadFor", [id], {});
  }
  return call(aiConfig, "load", [], {});
}

// 内部：读上下文（缺失时返回空结构，列表不会崩）。
function readContext() {
  return call(contextManager, "loadContext", [], { permanent: [], temporary: [] });
}

// 内部：读玩家等级数据 + 绝对主人名单（缺失时返回空对象，面板保留原值）。
function readPlayers() {
  var out = call(playerManager, "loadPlayers", [], {});
  try { out.owners = call(require("../modules/owner-privilege"), "listOwners", [], []); } catch (e) { out.owners = []; }
  return out;
}
// 内部：把 ai-client 的 { ok, reply } / { ok, error } 统一成 UI 期望的 { ok, reply }。
function shapeTestResult(result) {
  var out = { ok: false, reply: "无响应 / no response" };
  try {
    if (result && typeof result === "object") {
      out.ok = !!result.ok;
      if (result.reply) out.reply = String(result.reply);
      else if (result.error) out.reply = String(result.error);
    }
  } catch (e) {
    out = { ok: false, reply: getErrText(e) };
  }
  return out;
}

// 功能 4：测试 AI 连接——ai-client 按需加载，返回 Promise 时由 onRequest 自动等待。
// botId 可选：传了就测那个 bot 自己配置里的引擎。
function testAiConfig(botId) {
  var aiClient = null;
  try { aiClient = require("../modules/ai-client"); } catch (e) { aiClient = null; }
  if (!aiClient || typeof aiClient.testConnection !== "function") {
    return { ok: false, reply: "ai-client 未加载 / ai-client not loaded" };
  }
  var running = null;
  try {
    running = aiClient.testConnection(String(botId === undefined || botId === null ? "" : botId));
  } catch (e) {
    return { ok: false, reply: getErrText(e) };
  }
  if (running && typeof running.then === "function") {
    return running.then(function (r) { return shapeTestResult(r); }, function (err) {
      return { ok: false, reply: getErrText(err) };
    });
  }
  return shapeTestResult(running);
}

// 内部：按需加载状态机核心（缺失返回 null，IPC 会回 not loaded）。
function stateCore() { try { return require("../modules/state-machine"); } catch (e) { return null; } }
// 内部：按需加载状态机工具（待确认覆盖队列在它里面）。
function stateTools() { try { return require("../modules/ai-tools-state"); } catch (e) { return null; } }
// 内部：取某个 bot 的实例（假 bot 也认），拿不到返回 null。
function botOf(botId) {
  try { var rec = botManager && typeof botManager.getBot === "function" ? botManager.getBot(String(botId || "")) : null; return rec && rec.bot ? rec.bot : null; }
  catch (e) { return null; }
}

// 内部：状态机面板数据——清单 / 运行中 / 待确认（模块缺失一律给空结构，面板不会崩）。
function readMachines() {
  var core = stateCore(); var tools = stateTools();
  var out = { ok: true, machines: [], running: [], pending: [] };
  try { if (core && typeof core.listMachines === "function") out.machines = core.listMachines(); } catch (e) { out.machines = []; }
  try { if (core && typeof core.listRunning === "function") out.running = core.listRunning(); } catch (e) { out.running = []; }
  try { if (tools && typeof tools.listPending === "function") out.pending = tools.listPending(); } catch (e) { out.pending = []; }
  return out;
}

// 功能：启动一个状态机（不等它跑完，运行状态由面板轮询/刷新查看）。
function runMachine(payload) {
  var p = payload || {}; var core = stateCore();
  if (!core || typeof core.runByName !== "function") return { ok: false, message: "state-machine 未加载 / state-machine not loaded" };
  var botId = String(p.botId === undefined || p.botId === null ? "default" : p.botId);
  var name = String(p.name === undefined || p.name === null ? "" : p.name).trim();
  if (name.length === 0) return { ok: false, id: botId, message: "状态机名字不能为空 / machine name required" };
  var bot = botOf(botId);
  if (!bot) return { ok: false, id: botId, message: "bot 未运行 / bot not running: " + botId };
  try {
    var running = core.runByName(bot, name, botId);
    if (running && typeof running.catch === "function") running.catch(function () { return null; });
    return { ok: true, id: botId, name: name, message: "状态机已启动 / machine started: " + name };
  } catch (e) { return { ok: false, id: botId, message: getErrText(e) }; }
}

// 功能 5：注册全部 IPC 转发（渲染进程 → 模块 → 渲染进程），每个通道都走统一兜底。
function registerIpc() {
  // 机器人：启动 / 停止 / 停止全部。
  onRequest("start-bot", "bot-result", function (event, payload) {
    var p = payload || {};
    // 测试模式隔离：请求里带了 testMode 就先同步给 bot-manager，避免「界面是测试模式、主进程却真连」。
    if (p.testMode !== undefined) call(botManager, "setTestMode", [!!p.testMode], null);
    return call(botManager, "startBot", [p], notLoaded("botManager"));
  });
  onRequest("stop-bot", "bot-result", function (event, id) {
    return call(botManager, "stopBot", [id], notLoaded("botManager"));
  });
  onRequest("stop-all", "bot-result", function () {
    return call(botManager, "stopAll", [], notLoaded("botManager"));
  });
  // 机器人：查询全部 bot 的完整状态——前端每 5 秒轮询一次（主进程侧不写日志，避免刷屏）。
  onRequest("list-bots", "bot-list", function () {
    return { ok: true, bots: call(botManager, "listBots", [], []) };
  });
  // 机器人：执行指令 / 预约上下线 / 测试模式。
  onRequest("execute-command", "bot-result", function (event, payload) {
    return call(botManager, "handleCommand", [payload || {}], notLoaded("botManager"));
  });
  onRequest("schedule-join-out", "bot-result", function (event, payload) {
    return call(botManager, "scheduleJoinOut", [payload || {}], notLoaded("botManager"));
  });
  onRequest("set-test-mode", "bot-result", function (event, on) {
    return call(botManager, "setTestMode", [!!on], notLoaded("botManager"));
  });
  // 语法窗口：单向打开（主进程负责去重与聚焦）。
  onSend("open-syntax-window", function (event, lang) { createSyntaxWindow(lang); });
  // 语法窗口：主窗口切语言时同步过去（窗口没开就忽略，不新建）。
  onSend("syntax-lang", function (event, lang) {
    try {
      if (!syntaxWindow || syntaxWindow.isDestroyed()) return;
      syntaxWindow.webContents.send("set-lang", lang ? String(lang) : "zh");
    } catch (e) {
      logWarn("同步语法窗口语言失败 / sync syntax lang failed: " + getErrText(e));
    }
  });

  // 上下文：加载 / 添加 / 删除 / 清空临时（增删后同时推送最新列表）。
  onRequest("context-load", "context-data", function () { return readContext(); });
  onRequestPush("context-add", "context-result", "context-data", function (event, payload) {
    var p = payload || {};
    return {
      result: call(contextManager, "addContext", [p.text, p.mode], notLoaded("contextManager")),
      data: readContext()
    };
  });
  onRequestPush("context-remove", "context-result", "context-data", function (event, payload) {
    var p = payload || {};
    return {
      result: call(contextManager, "removeContext", [p.index, p.mode], notLoaded("contextManager")),
      data: readContext()
    };
  });
  onRequestPush("context-clear-temp", "context-result", "context-data", function () {
    return {
      result: call(contextManager, "clearTemporary", [], notLoaded("contextManager")),
      data: readContext()
    };
  });
  // 玩家：加载 / 保存（同时刷新面板）/ 自动判定开关。
  onRequest("player-load", "player-data", function () { return readPlayers(); });
  onRequestPush("player-save", "player-result", "player-data", function (event, payload) {
    try { if (payload && payload.owners) call(require("../modules/owner-privilege"), "configure", [payload.owners], {}); } catch (eOwner) { /* 特权模块缺失按原逻辑 */ }
    return {
      result: call(playerManager, "savePlayers", [payload], notLoaded("playerManager")),
      data: readPlayers()
    };
  });
  onRequest("player-set-auto", "player-result", function (event, on) {
    return call(playerManager, "setAutoJudge", [!!on], notLoaded("playerManager"));
  });

  // AI 配置：加载 / 保存（同时刷新面板）/ 连接测试（都可带 botId，实现每 bot 独立配置）。
  onRequest("ai-config-load", "ai-config-data", function (event, payload) { return readAiConfig(payload); });
  onRequestPush("ai-config-save", "ai-config-result", "ai-config-data", function (event, payload) {
    var p = payload || {};
    var botId = String(p.botId === undefined || p.botId === null ? "" : p.botId).trim();
    var saved = (botId.length > 0 && aiConfig && typeof aiConfig.saveFor === "function")
      ? call(aiConfig, "saveFor", [botId, p], notLoaded("aiConfig"))
      : call(aiConfig, "save", [p], notLoaded("aiConfig"));
    return { result: saved, data: readAiConfig(botId) };
  });
  onRequest("ai-config-test", "ai-config-test-result", function (event, payload) { return testAiConfig(payload); });

  // 状态机：列出 / 运行 / 停止 / 确认覆盖 / 取消确认（AI 接管必须由用户在面板点确认）。
  onRequest("state-machine-list", "state-machine-data", function () { return readMachines(); });
  onRequestPush("state-machine-run", "state-machine-result", "state-machine-data", function (event, payload) {
    return { result: runMachine(payload), data: readMachines() };
  });
  onRequestPush("state-machine-stop", "state-machine-result", "state-machine-data", function (event, payload) {
    var id = String(payload === undefined || payload === null || payload === "" ? "default" : payload);
    return { result: call(stateCore(), "stop", [id], notLoaded("stateMachine")), data: readMachines() };
  });
  onRequestPush("state-machine-confirm", "state-machine-result", "state-machine-data", function (event, payload) {
    var id = String(payload || "default"); var tools = stateTools(); var res = null;
    try {
      res = (tools && typeof tools.confirmPending === "function")
        ? tools.confirmPending(id, botOf(id))
        : { ok: false, message: "ai-tools-state 未加载 / ai-tools-state not loaded" };
    } catch (e) { res = { ok: false, message: getErrText(e) }; }
    if (res && typeof res.then === "function") {
      return res.then(function (done) { return { result: done, data: readMachines() }; }, function (err) { return { result: { ok: false, message: getErrText(err) }, data: readMachines() }; });
    }
    return { result: res, data: readMachines() };
  });
  onSend("state-machine-cancel", function (event, payload) {
    var id = String(payload === undefined || payload === null || payload === "" ? "default" : payload);
    call(stateTools(), "cancelPending", [id], null);
  });

  // 日志语言：单向切换（渲染层切换中英文日志）。
  onSend("log-lang", function (event, lang) { call(logger, "setLang", [lang || "zh"], null); });

  // 偏好：加载 / 保存（测试模式、蜂巢思维、AI 编程、bot 对话、打字机开关，真写 state/prefs.json）。
  onRequest("prefs-load", "prefs-data", function () { return call(prefs, "load", [], { ok: false, message: "prefs unavailable / 偏好模块未加载" }); });
  onRequestPush("prefs-save", "prefs-result", "prefs-data", function (event, payload) {
    return {
      result: call(prefs, "save", [payload || {}], notLoaded("prefs")),
      data: call(prefs, "load", [], {})
    };
  });

  // 参数：查询 / 写入（高级面板「参数查询」的真数据源，落盘 state/params.json）。
  onRequest("param-get", "param-result", function (event, key) {
    return call(paramManager, "get", [key], notLoaded("paramManager"));
  });
  onRequest("param-set", "param-result", function (event, payload) {
    var p = payload || {};
    return call(paramManager, "set", [p.key, p.value], notLoaded("paramManager"));
  });

  // Ollama：状态 / 模型列表 / 拉取 / 删除 / 打开官网（全部是真实 HTTP 调用，不再是假按钮）。
  onRequest("ollama-status", "ollama-status-result", function () {
    return call(ollamaInstaller, "status", [], notLoaded("ollamaInstaller"));
  });
  onRequest("ollama-list", "ollama-list-result", function () {
    return call(ollamaInstaller, "listModels", [], notLoaded("ollamaInstaller"));
  });
  onRequest("ollama-pull", "ollama-action-result", function (event, name) {
    return call(ollamaInstaller, "pull", [name], notLoaded("ollamaInstaller"));
  });
  onRequest("ollama-remove", "ollama-action-result", function (event, name) {
    return call(ollamaInstaller, "remove", [name], notLoaded("ollamaInstaller"));
  });
  onRequest("ollama-open-page", "ollama-action-result", function () {
    return call(ollamaInstaller, "openDownloadPage", [], notLoaded("ollamaInstaller"));
  });

  // npm 插件：列出已装 / 安装 / 卸载（真实调用本机 npm CLI，包名先过白名单）。
  onRequest("npm-list", "npm-list-result", function () {
    return call(npmManager, "list", [], notLoaded("npmManager"));
  });
  onRequest("npm-install", "npm-action-result", function (event, name) {
    return call(npmManager, "install", [name], notLoaded("npmManager"));
  });
  onRequest("npm-uninstall", "npm-action-result", function (event, name) {
    return call(npmManager, "uninstall", [name], notLoaded("npmManager"));
  });

  // 附加通道：遥测 / 手动 / 3D / 高级动作（gui/ipc-extra.js）+ 账号/安全（gui/ipc-account-safety.js），缺失只降级。
  try { var extra = require("./ipc-extra"); if (extra && typeof extra.register === "function") extra.register({ onRequest: onRequest, onSend: onSend, botOf: botOf, logWarn: logWarn, getWindow: function () { return mainWindow; }, listBots: function () { return call(botManager, "listBots", [], []); } }); var acct = require("./ipc-account-safety"); if (acct && typeof acct.register === "function") acct.register({ onRequest: onRequest, logWarn: logWarn, getWindow: function () { return mainWindow; } }); var ros = require("./ipc-roster"); if (ros && typeof ros.register === "function") ros.register({ onRequest: onRequest, logWarn: logWarn }); var loc = require("./ipc-local"); if (loc && typeof loc.register === "function") loc.register({ onRequest: onRequest, logWarn: logWarn }); }
  catch (e) { logWarn("附加通道注册失败 / extra IPC failed: " + getErrText(e)); }
}

// 功能 6：装上崩溃守卫与全局错误处理（模块缺失就跳过，绝不因此崩）。
function installGuards() {
  call(crashGuard, "install", [], null);
  call(core, "install", [], null);
}

// 功能 7：启动流程——建主窗口 → 健康检查 → 日志转发 → 注册 IPC。
function bootstrap() {
  // 启动时把偏好里的测试模式同步给 bot-manager：界面勾选过就必须真生效（settings 里的老开关也算）。
  try {
    var savedPrefs = call(prefs, "load", [], {});
    var wantTest = !!(savedPrefs && savedPrefs.testMode === true);
    if (!wantTest && settings && settings.bot && settings.bot.testMode) wantTest = true;
    if (wantTest) call(botManager, "setTestMode", [true], null);
  } catch (e) { /* 忽略配置读取异常 */ }
  createWindow(); call(engineControl, "bootTrace", [], null);
  call(core, "startHealthCheck", [], null);
  forwardLogs();
  registerIpc();
}

// 入口：Electron 就绪后启动；拿不到 app 时只写日志，不进入崩溃循环。
try {
  installGuards();
  if (app && typeof app.whenReady === "function") {
    app.whenReady().then(function () {
      try {
        bootstrap();
      } catch (e) {
        logWarn("启动失败 / bootstrap failed: " + getErrText(e));
      }
    }).catch(function (err) {
      logWarn("whenReady 失败 / whenReady failed: " + getErrText(err));
    });
    app.on("activate", function () {
      try {
        if (BrowserWindow && BrowserWindow.getAllWindows().length === 0) createWindow();
      } catch (e) {
        logWarn("activate 失败 / activate failed: " + getErrText(e));
      }
    });
    app.on("window-all-closed", function () {
      try {
        if (process.platform !== "darwin") app.quit();
      } catch (e) {
        logWarn("退出失败 / quit failed: " + getErrText(e));
      }
    });
  } else {
    logWarn("Electron app 不可用 / Electron app unavailable");
  }
} catch (e) {
  logWarn("初始化 Electron 失败 / init Electron failed: " + getErrText(e));
}
