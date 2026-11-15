// ========================================
// 文件：modules/bot-manager.js
// 功能：机器人管理——创建 / 连接 / 自动重连 / 状态上报 / 多 bot 独立管理 / 模组服协议穿透
// 依赖：mineflayer / ./core / ./logger / ./plugin-loader / ./fake-bot-manager / ./chat-handler / ./protocol-forge / ./mod-guard（都可选，失败不崩）
// 导出：createBot / startBot / stopBot / stopAll / getBot / listBots / setTestMode / normalizeVersion
// 作者：MineBots
// ========================================

// 可选依赖：日志核心，缺失时所有输出退回 console，绝不抛错。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 可选依赖：核心地基，缺失不影响机器人管理，仅按规范保留引用。
var core = null;
try { core = require("./core"); } catch (e) { core = null; }

// 可选依赖：插件加载器，缺失时跳过插件加载。
var pluginLoader = null;
try { pluginLoader = require("./plugin-loader"); } catch (e) { pluginLoader = null; }

// 可选依赖：mineflayer 本体，缺失时真 bot 无法创建，测试模式仍可用。
var mineflayer = null;
try { mineflayer = require("mineflayer"); } catch (e) { mineflayer = null; }

// 可选依赖：测试模式管理器（假 bot 创建 / 模拟环境启停），缺失时测试模式直接拒绝启动，绝不偷偷真连。
var fakeBotManager = null;
try { fakeBotManager = require("./fake-bot-manager"); } catch (e) { fakeBotManager = null; }
// 可选依赖：聊天处理（听游戏内聊天 → 选动作 → AI 回复），缺失时只警告，不影响连接。
var chatHandler = null;
try { chatHandler = require("./chat-handler"); } catch (e) { chatHandler = null; }
// 可选依赖：模组检测（越野车层）——出生后扫未知方块，认不出只记一次。
var modDetector = null;
try { modDetector = require("./mod-detector"); } catch (e) { modDetector = null; }
// 可选依赖：模组服协议穿透（forge 兼容层 / 品牌伪装 / 注册表缺失重试）+ 未知实体物品兜底，缺失时按原样跑。
var protocolForge = null;
try { protocolForge = require("./protocol-forge"); } catch (e) { protocolForge = null; }
var modGuard = null;
try { modGuard = require("./mod-guard"); } catch (e) { modGuard = null; }

// 可选依赖：状态读取器（血量 / 饥饿 / 坐标 / 维度 / 背包），本地模块缺失时 listBots 退回 0 / 空数组。
var statusReader = null;
try { statusReader = require("./bot-status-reader"); } catch (e) { statusReader = null; }

// 可选依赖：账号管家（微软正版设备码流 / 本地 Token 缓存），缺失时一律降级成离线模式。
var accountManager = null;
try { accountManager = require("./account-manager"); } catch (e) { accountManager = null; }
// 可选依赖：沙盒容错与安全（恶意包吞掉 / 内存检测 / 一键清理 state / 红警识别），缺失只跳过守护。
var safetyShield = null;
try { safetyShield = require("./safety-shield"); } catch (e) { safetyShield = null; }

// 常量：maxBots 上限默认值，与 settings.bot.maxBots 保持一致。
var DEFAULT_MAX_BOTS = 10;
// 常量：重连间隔默认 5 秒。
var DEFAULT_RECONNECT_DELAY_MS = 5000;
// 常量：最多重连次数，超过即停止重连。
var DEFAULT_RECONNECT_MAX = 5;
// 常量：默认游戏版本——缺省 / 空 / 历史遗留的自动探测值一律归一到 1.21.1；下一行是版本对应协议号（只用于测试模式日志）。
var DEFAULT_VERSION = "1.21.1";
var PROTOCOL_OF = { "1.21.1": 767, "1.21": 767, "1.20.6": 766, "1.20.4": 765, "1.20.1": 763, "1.19.4": 762, "1.18.2": 758, "1.16.5": 754, "1.12.2": 340 };

// 状态：所有 bot 记录，键为 bot id。
var bots = {};
// 状态：定时上下线定时器，键为 bot id（兼容旧 GUI 接口使用）。
var scheduleTimers = {};
// 状态：全局测试模式开关，true 时创建假 bot 不真连。
var testMode = false;

// 写信息日志：优先 logger.info，不可用时退回 console，绝不抛错。
function logInfo(message) {
  try {
    if (logger && typeof logger.info === "function") { logger.info(message); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log(message); } catch (e) { /* ignore */ }
}

// 写警告日志：优先 logger.warn，不可用时退回 console，绝不抛错。
function logWarn(message) {
  try {
    if (logger && typeof logger.warn === "function") { logger.warn(message); return; }
  } catch (e) { /* 退回 console */ }
  try { console.warn(message); } catch (e) { /* ignore */ }
}

// 写错误日志：优先 logger.error，不可用时退回 console，绝不抛错。
function logError(message) {
  try {
    if (logger && typeof logger.error === "function") { logger.error(message); return; }
  } catch (e) { /* 退回 console */ }
  try { console.error(message); } catch (e) { /* ignore */ }
}

// 写系统日志：优先 logger.system，不可用时退回 console，绝不抛错。
function logSystem(message) {
  try {
    if (logger && typeof logger.system === "function") { logger.system(message); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[SYSTEM] " + message); } catch (e) { /* ignore */ }
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

// 归一化版本号：空 / 自动探测 / latest / 非法字符一律回退 1.21.1，保证 createBot 永远收不到自动探测值。
function normalizeVersion(raw) {
  var text = "";
  try { text = String(raw === undefined || raw === null ? "" : raw).trim(); } catch (e) { text = ""; }
  var lower = text.toLowerCase();
  if (!text || text.length > 32 || lower === "auto" || lower === "latest") return DEFAULT_VERSION;
  return /^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(text) ? text : DEFAULT_VERSION;
}

// 查版本对应协议号：表里没有或查失败都返回 0（只影响日志展示）。
function protocolOf(version) {
  try { return PROTOCOL_OF[version] || 0; } catch (e) { return 0; }
}

// 归一化入参：补齐默认值，任何异常都回退到安全默认配置。
function resolveOptions(options) {
  var opt = {};
  try { opt = options || {}; } catch (e) { opt = {}; }
  var id = ""; try { id = opt.id ? String(opt.id) : ("bot-" + Date.now()); } catch (e) { id = "bot-" + Date.now(); }
  var result = { id: id, host: "localhost", port: 25565, username: "MineBot", password: "", autoRespawn: true, version: DEFAULT_VERSION, loginMode: "offline", microsoftProfile: null };
  try { if (opt.host) result.host = String(opt.host); } catch (e) { /* 用默认 */ }
  try { if (opt.port) result.port = Number(opt.port) || 25565; } catch (e) { /* 用默认 */ }
  try { if (opt.username) result.username = String(opt.username); } catch (e) { /* 用默认 */ }
  try { if (opt.password) result.password = String(opt.password); } catch (e) { /* 用默认 */ }
  try { if (opt.autoRespawn === false) result.autoRespawn = false; } catch (e) { /* 用默认 */ }
  // 登录模式：offline（默认离线）/ microsoft（正版微软账号）。非法值一律回退离线。
  try {
    var mode = String(opt.loginMode || "offline").toLowerCase();
    result.loginMode = (mode === "microsoft") ? "microsoft" : "offline";
  } catch (e) { result.loginMode = "offline"; }
  // 正版模式：优先用调用方传来的已缓存档案；没有再让账号管家从本地磁盘读。
  try {
    if (result.loginMode === "microsoft" && opt.microsoftProfile && typeof opt.microsoftProfile === "object") {
      result.microsoftProfile = opt.microsoftProfile;
    } else if (result.loginMode === "microsoft" && accountManager && typeof accountManager.loadCached === "function") {
      result.microsoftProfile = accountManager.loadCached(result.username) || null;
    }
  } catch (e) { result.microsoftProfile = null; }
  result.version = normalizeVersion(opt.version);
  return result;
}

// 组装一条 bot 记录：字段与规格一致，测试模式 bot 实例为 null。
function buildRecord(opt) {
  return {
    id: opt.id,
    host: opt.host,
    port: opt.port,
    username: opt.username,
    password: opt.password,
    status: "idle",
    fake: false,
    bot: null,
    fakeTimer: null,
    reconnectTimer: null,
    reconnectCount: 0,
    skipReconnect: false,
    autoRespawn: opt.autoRespawn, version: opt.version,
    loginMode: opt.loginMode, microsoftProfile: opt.microsoftProfile
  };
}

// 是否已达 maxBots 上限（默认 10），异常时保守返回 true。
function hasReachedMaxBots() {
  try { return Object.keys(bots).length >= DEFAULT_MAX_BOTS; } catch (e) { return true; }
}

// 状态读取（血量 / 饥饿 / 坐标 / 维度 / 背包）已抽到 modules/bot-status-reader.js，listBots 直接调它。

// 功能 2：创建测试模式 bot——具体模拟全部交给 fake-bot-manager，这里只把自身工具函数注入进去。
// message 必须带 "started"：gui/renderer/app.js 收到 "stopped" 才显示「已停止」，其余都按「运行中」处理。
function createFakeBot(options) {
  if (!fakeBotManager || typeof fakeBotManager.createFakeBot !== "function") {
    return { ok: false, id: options && options.id ? String(options.id) : "", message: "fake-bot-manager 未加载 / not loaded" };
  }
  return fakeBotManager.createFakeBot(options, {
    resolve: resolveOptions,
    build: buildRecord,
    protocolOf: protocolOf,
    register: function (rec) { try { bots[rec.id] = rec; } catch (e) { /* 登记失败也继续模拟 */ } }
  });
}

// 内部：停止测试模式模拟——全部委托 fake-bot-manager；模块缺失时只是不做事，绝不抛错。
function stopFakeSimulation(rec) {
  try {
    if (fakeBotManager && typeof fakeBotManager.stopSimulation === "function") return fakeBotManager.stopSimulation(rec);
  } catch (e) {
    logWarn("[" + (rec && rec.id ? rec.id : "?") + "] 模拟环境停止异常 / stop failed: " + getErrText(e));
  }
  return 0;
}

// 功能 5：安排自动重连——次数 +1，超过 5 次停止，否则 5 秒后重新连接。
function scheduleReconnect(rec) {
  if (!rec || rec.skipReconnect) return;
  rec.reconnectCount = rec.reconnectCount + 1;
  if (rec.reconnectCount > DEFAULT_RECONNECT_MAX) {
    rec.status = "stopped";
    logSystem("[" + rec.id + "] 重连 5 次失败，停止");
    return;
  }
  rec.status = "respawning";
  try {
    if (rec.reconnectTimer) clearTimeout(rec.reconnectTimer);
    rec.reconnectTimer = setTimeout(function () {
      rec.reconnectTimer = null;
      if (rec.skipReconnect) return;
      try { attachRealBot(rec); }
      catch (e) { logError("[" + rec.id + "] 重连失败: " + getErrText(e)); scheduleReconnect(rec); }
    }, DEFAULT_RECONNECT_DELAY_MS);
  } catch (e) {
    rec.reconnectTimer = null;
    logError("[" + rec.id + "] 重连定时器创建失败: " + getErrText(e));
  }
}

// 注册自动登录：仅有密码时开启，命中登录/注册关键词时发送指令且只执行一次。
function attachAutoLogin(rec, bot) {
  if (!rec.password) return;
  var loginDone = false;
  bot.on("message", function (message) {
    if (loginDone) return;
    var text = "";
    try { text = String(message).toLowerCase(); } catch (e) { return; }
    try {
      if (text.indexOf("login") >= 0 || text.indexOf("请登录") >= 0) {
        bot.chat("/login " + rec.password);
        loginDone = true;
        logSystem("[" + rec.id + "] sent /login");
      } else if (text.indexOf("register") >= 0 || text.indexOf("请注册") >= 0) {
        bot.chat("/register " + rec.password + " " + rec.password);
        loginDone = true;
        logSystem("[" + rec.id + "] sent /register");
      }
    } catch (e) { logWarn("[" + rec.id + "] 自动登录失败: " + getErrText(e)); }
  });
}

// 创建 mineflayer 实例并注册全部事件与自动登录，首次连接和重连共用。
function attachRealBot(rec) {
  // 登录模式动态化：离线模式保持 auth:"offline"（默认）；正版微软账号切到 auth:"microsoft"。
  // 有本地缓存的微软档案就一并带上，下次启动免登录直接进服；没有则照常走设备码流。
  var authMode = "offline";
  try { authMode = (rec.loginMode === "microsoft") ? "microsoft" : "offline"; } catch (e) { authMode = "offline"; }
  // 模组服协议穿透：有 forge 兼容层就挂上，没有就靠 brand 伪装字段；装饰失败也必须照常连。
  var options = { host: rec.host, port: rec.port, username: rec.username, auth: authMode, version: normalizeVersion(rec.version), hideErrors: true };
  try {
    if (authMode === "microsoft" && rec.microsoftProfile && typeof rec.microsoftProfile === "object") {
      for (var k in rec.microsoftProfile) {
        if (Object.prototype.hasOwnProperty.call(rec.microsoftProfile, k)) options[k] = rec.microsoftProfile[k];
      }
    }
  } catch (eCache) { /* 带缓存失败照常按 auth:"microsoft" 联网取 */ }
  try { options = protocolForge && typeof protocolForge.decorate === "function" ? protocolForge.decorate(options, rec) : options; } catch (e0) { /* 伪装失败也继续连 */ }
  var bot = mineflayer.createBot(options);
  rec.bot = bot; rec.fake = false;
  // 沙盒守护：给真 bot 挂安全网（吞掉异常 / 畸形 raw 包），死保主进程不崩溃；缺失时跳过。
  try { if (safetyShield && typeof safetyShield.guardBot === "function") safetyShield.guardBot(bot, rec.id); } catch (eSG) { /* 守护挂失败也照常连 */ }
  try { if (protocolForge && typeof protocolForge.handshake === "function") protocolForge.handshake(bot, rec); } catch (eH) { /* 协议握手失败照常玩 */ }

  try { if (pluginLoader && typeof pluginLoader.loadPlugins === "function") pluginLoader.loadPlugins(bot); }
  catch (e) { logWarn("[" + rec.id + "] 插件加载失败: " + getErrText(e)); }
  // 挂聊天监听：玩家说话能不能被 AI 回复全看这一行；模块缺失时明确告警，但不影响连接。
  try { if (chatHandler && typeof chatHandler.attach === "function") chatHandler.attach(bot, rec.id); else logWarn("[" + rec.id + "] chat-handler 不可用 / unavailable，游戏内聊天不会回复"); }
  catch (e) { logWarn("[" + rec.id + "] 聊天监听挂载失败 / chat attach failed: " + getErrText(e)); }
  // 越野车层：区块加载 / 方块更新都喂给 mod-detector（内部有阈值与去重，高频信息只落文件）。
  try {
    bot.on("chunkColumnLoad", function (point) { try { if (modDetector) modDetector.onChunkLoad(bot, rec.id, { position: point }); } catch (e1) { /* ignore */ } });
    bot.on("blockUpdate", function (oldBlock, newBlock) { try { if (modDetector) modDetector.onBlockUpdate(bot, rec.id, oldBlock, newBlock); } catch (e2) { /* ignore */ } });
  } catch (e) { logWarn("[" + rec.id + "] 模组检测监听挂载失败 / mod-detector hook failed: " + getErrText(e)); }
  // 未知实体 / 未知物品 / 遇袭告警的兜底监听：内部自带 try/catch，断线自己摘。
  try { if (modGuard && typeof modGuard.attach === "function") modGuard.attach(bot, rec.id); } catch (eMG) { /* 兜底失败也不影响连接 */ }

  bot.once("spawn", function () {
    rec.status = "running";
    rec.reconnectCount = 0;
    logInfo("[" + rec.id + "] 已连接并出生: " + rec.username);
    // 出生后才启动扫描：这时才拿得到真实世界数据（第一次连和重连都会走到这里）。
    try { if (modDetector) modDetector.startScan(bot, rec.id); } catch (e) { logWarn("[" + rec.id + "] mod-detector 启动失败 / start failed: " + getErrText(e)); }
  });
  bot.on("kicked", function (reason) {
    logWarn("[" + rec.id + "] 被服务器踢出: " + String(reason));
  });
  bot.on("error", function (err) {
    logError("[" + rec.id + "] 连接错误: " + getErrText(err));
    // 模组注册表缺失这类错误不崩：交给 protocol-forge 记明确日志并按需重试。
    try { if (protocolForge) protocolForge.onLoginError(rec, err, { log: logSystem, retry: function () { retryConnect(rec); } }); }
    catch (ePF) { /* 协议层自己失败也绝不能影响连接 */ }
  });
  bot.on("end", function () {
    rec.bot = null;
    rec.status = "stopped";
    if (rec.skipReconnect) return;
    logWarn("[" + rec.id + "] 连接已断开");
    scheduleReconnect(rec);
  });
  bot.on("death", function () {
    rec.status = "dead";
    logWarn("[" + rec.id + "] 已死亡");
    try { if (rec.autoRespawn && bot && typeof bot.respawn === "function") bot.respawn(); }
    catch (e) { logWarn("[" + rec.id + "] 重生失败: " + getErrText(e)); }
  });
  bot.on("respawn", function () {
    rec.status = "running";
    logInfo("[" + rec.id + "] 已重生");
  });
  attachAutoLogin(rec, bot);
  return bot;
}

// 内部：模组服协议错误后的重连——直接重连一次，失败退回常规重连流程。
function retryConnect(rec) {
  try { attachRealBot(rec); } catch (e) { logWarn("[" + rec.id + "] 协议错误后重连失败: " + getErrText(e)); scheduleReconnect(rec); }
}

// 功能 1：创建真 bot——连接服务器、加载插件、注册事件与自动登录。
function createBot(options) {
  var opt = resolveOptions(options);
  if (!mineflayer) return { ok: false, id: opt.id, message: "mineflayer 未安装" };
  var rec = buildRecord(opt); bots[opt.id] = rec;
  try {
    attachRealBot(rec);
    logSystem("[" + opt.id + "] 正在连接 " + opt.host + ":" + opt.port + " 作为 " + opt.username);
  } catch (e) {
    try { delete bots[opt.id]; } catch (e2) { /* ignore */ }
    logError("[" + opt.id + "] 创建失败: " + getErrText(e));
    return { ok: false, id: opt.id, message: getErrText(e) };
  }
  // 同上：启动成功必须带 message: "started"，否则 GUI 无法把状态落成「运行中」。
  return { ok: true, id: opt.id, port: opt.port, message: "started" };
}

// 功能 3：启动 bot——查重、清残留、查上限、补端口，按测试模式选择真连或假连。
function startBot(options) {
  var opt = resolveOptions(options);
  if (bots[opt.id] && bots[opt.id].status === "running") return { ok: false, id: opt.id, message: "already running" };
  if (bots[opt.id]) { try { stopBot(opt.id); } catch (e) { /* 忽略残留清理异常 */ } }
  if (hasReachedMaxBots()) return { ok: false, id: opt.id, message: "maxBots reached" };
  // 端口为 0 / 空 / 非法时自动分配一个 5 位端口（10000~65535），测试模式与真连一致。
  if (wantsAutoPort(options)) {
    opt.port = assignPort();
    logSystem("[" + opt.id + "] 端口 / port " + opt.port + " 已自动分配 / auto assigned");
  }
  if (testMode) { // 测试模式硬隔离：模拟器缺失时直接失败，绝不回退到真实 mineflayer 连接。
    var fakeReady = !!(fakeBotManager && typeof fakeBotManager.isAvailable === "function" && fakeBotManager.isAvailable());
    return fakeReady ? createFakeBot(opt) : { ok: false, id: opt.id, message: "fake-bot 未加载，已阻止真实连接 / fake-bot not loaded, real connect blocked" };
  }
  return createBot(opt);
}

// 判断调用方是否要自动分配端口：没传 port / 传 0 / 传空串 / 传非法值都算「要」。
function wantsAutoPort(options) {
  try {
    if (!options) return true;
    var raw = options.port;
    if (raw === undefined || raw === null || raw === "") return true;
    var n = Number(raw);
    if (isNaN(n) || !isFinite(n) || n <= 0) return true;
    return false;
  } catch (e) {
    return true;
  }
}

// 生成一个 5 位随机端口（10000~65535），异常时退回 25565。
function assignPort() {
  var port = 25565;
  try {
    port = 10000 + Math.floor(Math.random() * (65535 - 10000 + 1));
    if (port < 10000 || port > 65535) port = 25565;
  } catch (e) {
    port = 25565;
  }
  return port;
}

// 内部：停止 bot 前把它身上的定时器彻底清干净（寻路 / 视线 / 跟随 / 待机 / 打字 / 模组扫描）。
// 为什么必须有它：quit() 不会替我们 clearInterval，遗留定时器会让进程与 CPU 一直挂着。
function cleanupBotTimers(rec) {
  if (!rec) return false;
  var bot = rec.bot || null;
  try {
    var handles = [];
    if (bot) {
      handles.push(bot._mbFallbackTimer);
      if (bot._mbGaze) handles.push(bot._mbGaze.timer);
      if (bot._mbFollow) handles.push(bot._mbFollow.timer);
      if (bot._mbIdle) handles.push(bot._mbIdle.timer);
      if (bot._mbTyping) handles.push(bot._mbTyping.timer);
    }
    for (var i = 0; i < handles.length; i++) {
      var h = handles[i];
      if (!h) continue;
      try { clearInterval(h); } catch (e1) { /* ignore */ }
      try { clearTimeout(h); } catch (e2) { /* ignore */ }
    }
    if (bot) {
      // 缓转中的视角立刻中止（motion 用序号做取消，改大序号就是收手）。
      try { bot._mbLookSeq = (Number(bot._mbLookSeq) || 0) + 1; } catch (e3) { /* ignore */ }
      try { bot._mbNodeDetach = null; } catch (e4) { /* ignore */ }
      try { bot._mbFallbackTimer = null; } catch (e5) { /* ignore */ }
      try { bot._mbGaze = null; } catch (e6) { /* ignore */ }
      try { bot._mbFollow = null; } catch (e7) { /* ignore */ }
      try { bot._mbIdle = null; } catch (e8) { /* ignore */ }
      try { if (bot._mbTyping) bot._mbTyping.timer = null; } catch (e9) { /* ignore */ }
      try { if (typeof bot.clearControlStates === "function") bot.clearControlStates(); } catch (e10) { /* ignore */ }
    }
  } catch (e) { /* 清理失败不影响停止流程 */ }
  // 模组扫描的防抖定时器也要清，否则 bot 都没了它还在等下一拍。
  try { if (modDetector && typeof modDetector.stopScan === "function") modDetector.stopScan(rec.id); } catch (e11) { /* ignore */ }
  return true;
}

// 功能 4：停止单个 bot——标记跳过重连、清理定时器、断开连接、移除记录。
function stopBot(id) {
  var rec = getBot(id);
  if (!rec) return { ok: false, id: id, message: "not found" };
  rec.skipReconnect = true;
  // 先停掉测试模式模拟（世界 / 事件 / 死亡重连等定时器），再清旧心跳兜底。
  stopFakeSimulation(rec);
  // 再清掉动作层（寻路 / 视线 / 跟随 / 待机 / 打字 / 模组扫描）的定时器，确保停得干净。
  try { cleanupBotTimers(rec); } catch (e) { /* ignore */ }
  try { if (rec.fakeTimer) clearInterval(rec.fakeTimer); } catch (e) { /* ignore */ }
  try { if (rec.reconnectTimer) clearTimeout(rec.reconnectTimer); } catch (e) { /* ignore */ }
  try { if (rec.bot && typeof rec.bot.quit === "function") rec.bot.quit(); } catch (e) { /* ignore */ }
  rec.fakeTimer = null;
  rec.reconnectTimer = null;
  rec.bot = null;
  rec.status = "stopped";
  try { delete bots[id]; } catch (e) { /* ignore */ }
  logSystem("stopBot done: " + id);
  // 必须带 message: "stopped"：gui/renderer/app.js 靠它把状态落成「已停止」；
  // 缺了会被当成「运行中」，看起来就像"停止按钮执行了启动"。
  return { ok: true, id: id, message: "stopped" };
}

// 功能 4b：停止全部 bot——先快照 id 列表再逐个停止，避免边遍历边删除。
function stopAll() {
  var ids = [];
  try { ids = Object.keys(bots); } catch (e) { ids = []; }
  var stopped = 0;
  for (var i = 0; i < ids.length; i++) {
    try { var r = stopBot(ids[i]); if (r && r.ok) stopped = stopped + 1; } catch (e) { /* ignore */ }
  }
  return { ok: true, count: stopped };
}

// 功能 8：按 id 取 bot 记录，不存在返回 null。
function getBot(id) {
  try {
    if (id && bots[id]) return bots[id];
  } catch (e) { /* ignore */ }
  return null;
}

// 功能 6：状态上报——返回所有 bot 的完整状态数组（含测试模式的世界状态），供 GUI 轮询。
function listBots() {
  var out = [];
  var ids = [];
  try { ids = Object.keys(bots); } catch (e) { ids = []; }
  for (var i = 0; i < ids.length; i++) {
    var rec = null; try { rec = bots[ids[i]]; } catch (e) { rec = null; }
    if (!rec) continue;
    out.push({
      id: rec.id,
      host: rec.host,
      port: rec.port,
      username: rec.username,
      status: rec.status,
      fake: rec.fake === true,
      health: statusReader && statusReader.readHealth ? statusReader.readHealth(rec) : 0,
      food: statusReader && statusReader.readFood ? statusReader.readFood(rec) : 0,
      position: statusReader && statusReader.readPosition ? statusReader.readPosition(rec) : { x: 0, y: 0, z: 0 },
      dimension: statusReader && statusReader.readDimension ? statusReader.readDimension(rec) : "",
      inventory: statusReader && statusReader.readInventory ? statusReader.readInventory(rec) : [],
      reconnectCount: Number(rec.reconnectCount) || 0, version: rec.version || DEFAULT_VERSION
    });
  }
  return out;
}

// 解析 "h:mm AM/PM" 形式的时间，非法返回 null。
function parseTime(str) {
  var s = "";
  try { s = String(str || "").trim(); } catch (e) { return null; }
  var m = s.match(/^(\d{1,2}):(\d{2})\s+(AM|PM)$/i);
  if (!m) return null;
  var h = parseInt(m[1], 10);
  var min = parseInt(m[2], 10);
  var ap = m[3].toUpperCase();
  if (h < 1 || h > 12 || min < 0 || min > 59) return null;
  if (ap === "AM" && h === 12) h = 0;
  if (ap === "PM" && h !== 12) h += 12;
  return { hour: h, minute: min };
}

// 计算距离下一个目标时刻的毫秒数，已过则顺延到明天。
function msUntilNext(parsed) {
  var now = new Date();
  var target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parsed.hour, parsed.minute, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target.getTime() - now.getTime();
}

// 兼容接口：安排定时上下线，时间非法或顺序颠倒则返回失败。
function scheduleJoinOut(payload) {
  var p = payload || {};
  var id = p.botId ? String(p.botId) : "";
  var join = parseTime(p.joinTime);
  var out = parseTime(p.outTime);
  if (!join || !out) return { ok: false, id: id, message: "bad time format" };
  if (join.hour * 60 + join.minute >= out.hour * 60 + out.minute) return { ok: false, id: id, message: "join time must be earlier than out time" };
  try {
    if (scheduleTimers[id]) {
      clearTimeout(scheduleTimers[id].joinTimer);
      clearTimeout(scheduleTimers[id].outTimer);
    }
    var joinTimer = setTimeout(function () { try { if (!bots[id]) startBot({ id: id }); } catch (e) { /* ignore */ } }, msUntilNext(join));
    var outTimer = setTimeout(function () { try { stopBot(id); } catch (e) { /* ignore */ } }, msUntilNext(out));
    scheduleTimers[id] = { joinTimer: joinTimer, outTimer: outTimer };
    return { ok: true, id: id, message: "scheduled" };
  } catch (e) {
    logWarn("[" + id + "] 定时上下线创建失败: " + getErrText(e));
    return { ok: false, id: id, message: getErrText(e) };
  }
}

// 兼容接口：把命令转发给 command-handler，bot 不在线或处理器缺失则返回失败。
function handleCommand(payload) {
  var p = payload || {};
  var botId = p.botId ? String(p.botId) : "unknown";
  var rec = getBot(botId);
  if (!rec || !rec.bot) return { ok: false, id: botId, message: "bot not running" };
  // 测试模式：不真的执行动作，只写日志并回包，模拟「指令已被服务器接受」。
  if (rec.fake) {
    logSystem("[" + botId + "] [TEST] 指令已接受 / command accepted: " + String(p.action || ""));
    return { ok: true, id: botId, message: "test mode command accepted" };
  }
  var handler = null;
  try { handler = require("./command-handler"); } catch (e) { handler = null; }
  if (!handler || typeof handler.executeAction !== "function") return { ok: false, id: botId, message: "command-handler 不可用" };
  try {
    handler.executeAction(rec.bot, p.action || "", {
      range: p.range || "", time: p.time || "", back: p.back || null, params: p.params || {}
    });
  } catch (e) {
    logWarn("[" + botId + "] 命令执行失败: " + getErrText(e));
    return { ok: false, id: botId, message: getErrText(e) };
  }
  return { ok: true, id: botId, message: "command accepted" };
}

// 功能 7：切换全局测试模式并写日志。
function setTestMode(on) {
  testMode = !!on;
  logSystem("Test mode = " + testMode);
  return { ok: true, testMode: testMode };
}

// 对外导出：§六 规定的 6 个接口，外加兼容旧 GUI 的 createBot / handleCommand / scheduleJoinOut / normalizeVersion。
module.exports = {
  startBot: startBot, stopBot: stopBot, stopAll: stopAll, getBot: getBot,
  listBots: listBots, setTestMode: setTestMode, createBot: createBot,
  handleCommand: handleCommand, scheduleJoinOut: scheduleJoinOut, normalizeVersion: normalizeVersion,
  resolveOptions: resolveOptions
};
