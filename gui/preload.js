// ========================================
// 文件：gui/preload.js
// 功能：Electron 预加载脚本——用 contextBridge 把主进程 IPC 接口暴露成渲染进程的 window.botAPI
// 依赖：electron（contextBridge / ipcRenderer；取不到时全部降级为空操作，绝不抛错）
// 导出：无（preload 是 Electron 特殊文件，不需要 module.exports）
// 作者：MineBots
// ========================================

// 可选依赖：electron 运行时对象。preload 一定跑在 Electron 里，但取不到时也绝不抛错。
var electron = null;
try { electron = require("electron"); } catch (e) { electron = null; }

// 常量：全部 IPC 通道名集中在此，避免字符串散落各处写错。
var CHANNEL = {
  startBot: "start-bot",
  stopBot: "stop-bot",
  stopAll: "stop-all",
  listBots: "list-bots",
  executeCommand: "execute-command",
  scheduleJoinOut: "schedule-join-out",
  setTestMode: "set-test-mode",
  openSyntaxWindow: "open-syntax-window",
  syntaxLang: "syntax-lang",
  contextLoad: "context-load",
  contextAdd: "context-add",
  contextRemove: "context-remove",
  contextClearTemp: "context-clear-temp",
  playerLoad: "player-load",
  playerSave: "player-save",
  playerSetAuto: "player-set-auto",
  aiConfigLoad: "ai-config-load",
  aiConfigSave: "ai-config-save",
  aiConfigTest: "ai-config-test",
  logLang: "log-lang",
  botLog: "bot-log",
  botResult: "bot-result",
  botList: "bot-list",
  contextData: "context-data",
  contextResult: "context-result",
  playerData: "player-data",
  playerResult: "player-result",
  aiConfigData: "ai-config-data",
  aiConfigResult: "ai-config-result",
  aiConfigTestResult: "ai-config-test-result",
  stateMachineList: "state-machine-list",
  stateMachineRun: "state-machine-run",
  stateMachineStop: "state-machine-stop",
  stateMachineConfirm: "state-machine-confirm",
  stateMachineCancel: "state-machine-cancel",
  stateMachineData: "state-machine-data",
  stateMachineResult: "state-machine-result",
  prefsLoad: "prefs-load",
  prefsSave: "prefs-save",
  prefsData: "prefs-data",
  prefsResult: "prefs-result",
  paramGet: "param-get",
  paramSet: "param-set",
  paramResult: "param-result",
  ollamaStatus: "ollama-status",
  ollamaStatusResult: "ollama-status-result",
  ollamaList: "ollama-list",
  ollamaListResult: "ollama-list-result",
  ollamaPull: "ollama-pull",
  ollamaRemove: "ollama-remove",
  ollamaOpenPage: "ollama-open-page",
  ollamaActionResult: "ollama-action-result",
  npmList: "npm-list",
  npmListResult: "npm-list-result",
  npmInstall: "npm-install",
  npmUninstall: "npm-uninstall",
  npmActionResult: "npm-action-result",
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
  modelProfileResult: "model-profile-result",
  microsoftAuthStart: "microsoft-auth",
  microsoftAuthResult: "microsoft-auth-result",
  microsoftAuthCode: "microsoft-auth-code",
  microsoftAuthStatus: "microsoft-auth-status",
  safetyClean: "safety-clean",
  safetyCleanResult: "safety-clean-result",
  safetyMemory: "safety-memory",
  safetyMemoryResult: "safety-memory-result",
  rosterList: "roster-list",
  rosterListResult: "roster-list-result",
  rosterSave: "roster-save",
  rosterSaveResult: "roster-save-result",
  rosterLoad: "roster-load",
  rosterLoadResult: "roster-load-result",
  rosterRestore: "roster-restore",
  rosterRestoreResult: "roster-restore-result",
  rosterDelete: "roster-delete",
  rosterDeleteResult: "roster-delete-result",
  skinImport: "skin-import",
  skinImportResult: "skin-import-result",
  skinGet: "skin-get",
  skinGetResult: "skin-get-result",
  skinRemove: "skin-remove",
  skinRemoveResult: "skin-remove-result",
  localFrameworks: "local-frameworks",
  localFrameworksResult: "local-frameworks-result",
  localConfigLoad: "local-config-load",
  localConfigLoadResult: "local-config-load-result",
  localConfigSave: "local-config-save",
  localConfigSaveResult: "local-config-save-result",
  localDetect: "local-detect",
  localDetectResult: "local-detect-result",
  localStatus: "local-status",
  localStatusResult: "local-status-result",
  localStart: "local-start",
  localStartResult: "local-start-result",
  localStop: "local-stop",
  localStopResult: "local-stop-result",
  localModels: "local-models",
  localModelsResult: "local-models-result",
  localModelImport: "local-model-import",
  localModelImportResult: "local-model-import-result",
  localModelRemove: "local-model-remove",
  localModelRemoveResult: "local-model-remove-result",
  localInstances: "local-instances",
  localInstancesResult: "local-instances-result",
  localInstanceCreate: "local-instance-create",
  localInstanceCreateResult: "local-instance-create-result",
  localInstanceRemove: "local-instance-remove",
  localInstanceRemoveResult: "local-instance-remove-result"
};

// 状态：electron 的两个子对象，取不到就是 null（下面每次调用都会先判空）。
var ipcRenderer = null;
var contextBridge = null;

// 内部：从 electron 上取子对象（ipcRenderer / contextBridge），取不到返回 null。
function pick(name) {
  try { if (electron && electron[name]) return electron[name]; } catch (e) { /* 取不到当作 null */ }
  return null;
}

// 初始化：取出两个子对象；任何异常都只降级，不影响脚本继续执行。
try {
  ipcRenderer = pick("ipcRenderer");
  contextBridge = pick("contextBridge");
} catch (e) {
  ipcRenderer = null;
  contextBridge = null;
}

// 内部：写警告日志——优先 console，本身也 try/catch，绝不抛错。
function logWarn(msg) {
  try { console.warn("[preload] " + msg); } catch (e) { /* 忽略 */ }
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

// 内部：向主进程发消息——所有外部调用集中收敛到这里，避免到处复制粘贴 try/catch。
function send(channel, payload) {
  try {
    if (!ipcRenderer || typeof ipcRenderer.send !== "function") return false;
    ipcRenderer.send(channel, payload);
    return true;
  } catch (e) {
    logWarn("发送失败 / send failed: " + channel + " - " + getErrText(e));
    return false;
  }
}

// 内部：监听主进程推送——注册动作与回调本身都 try/catch，单个回调出错不影响其它回调。
function listen(channel, callback) {
  try {
    if (typeof callback !== "function") return false;
    if (!ipcRenderer || typeof ipcRenderer.on !== "function") return false;
    ipcRenderer.on(channel, function (event, data) {
      try { callback(data); } catch (e) { logWarn("回调异常 / callback error: " + channel + " - " + getErrText(e)); }
    });
    return true;
  } catch (e) {
    logWarn("监听失败 / listen failed: " + channel + " - " + getErrText(e));
    return false;
  }
}

// 功能 1：组装暴露给渲染进程的接口对象（机器人 / 语法窗口 / 上下文 / 玩家 / AI 配置 / 日志语言）。
function buildApi() {
  return {
    // 机器人：启动一个；参数缺省时补空对象，主进程再兜底。
    startBot: function (o) { send(CHANNEL.startBot, o || {}); },
    // 机器人：停止指定 id。
    stopBot: function (id) { send(CHANNEL.stopBot, id); },
    // 机器人：停止全部。
    stopAll: function () { send(CHANNEL.stopAll); },
    // 机器人：查询全部状态（前端每 5 秒轮询一次）。
    listBots: function () { send(CHANNEL.listBots); },
    // 机器人：执行一条动作指令（action / range / time / back）。
    executeCommand: function (p) { send(CHANNEL.executeCommand, p || {}); },
    // 机器人：预约 join / out 定时上下线。
    scheduleJoinOut: function (p) { send(CHANNEL.scheduleJoinOut, p || {}); },
    // 机器人：切换测试模式（空转、不真打怪）。
    setTestMode: function (on) { send(CHANNEL.setTestMode, !!on); },

    // 语法窗口：打开只读语法规范窗口，并把当前语言传过去。
    openSyntaxWindow: function (lang) { send(CHANNEL.openSyntaxWindow, lang); },
    // 语法窗口：主窗口切语言时同步给已打开的语法窗口。
    syncSyntaxLang: function (lang) { send(CHANNEL.syntaxLang, lang || "zh"); },

    // 上下文：请求全量上下文。
    contextLoad: function () { send(CHANNEL.contextLoad); },
    // 上下文：追加一条（临时 / 永久）。
    contextAdd: function (p) { send(CHANNEL.contextAdd, p); },
    // 上下文：删除指定下标的一条。
    contextRemove: function (p) { send(CHANNEL.contextRemove, p); },
    // 上下文：清空临时上下文。
    contextClearTemp: function () { send(CHANNEL.contextClearTemp); },
    // 监听：上下文全量数据。
    onContextData: function (cb) { listen(CHANNEL.contextData, cb); },
    // 监听：上下文增删结果。
    onContextResult: function (cb) { listen(CHANNEL.contextResult, cb); },

    // 玩家：请求玩家等级数据。
    playerLoad: function () { send(CHANNEL.playerLoad); },
    // 玩家：保存手工等级名单与自动判定开关。
    playerSave: function (p) { send(CHANNEL.playerSave, p); },
    // 玩家：单独切换自动判定开关。
    playerSetAuto: function (on) { send(CHANNEL.playerSetAuto, !!on); },
    // 监听：玩家等级数据。
    onPlayerData: function (cb) { listen(CHANNEL.playerData, cb); },
    // 监听：玩家数据保存结果。
    onPlayerResult: function (cb) { listen(CHANNEL.playerResult, cb); },

    // AI 配置：请求当前配置（可带 botId，只读该 bot 自己的文件）。
    aiConfigLoad: function (botId) { send(CHANNEL.aiConfigLoad, botId || ""); },
    // AI 配置：保存配置（合并写盘，由 ai-config 校验）。
    aiConfigSave: function (p) { send(CHANNEL.aiConfigSave, p); },
    // AI 配置：测试连接。
    aiConfigTest: function () { send(CHANNEL.aiConfigTest); },
    // 监听：AI 配置数据。
    onAiConfigData: function (cb) { listen(CHANNEL.aiConfigData, cb); },
    // 监听：AI 配置保存结果。
    onAiConfigResult: function (cb) { listen(CHANNEL.aiConfigResult, cb); },
    // 监听：AI 连接测试结果。
    onAiConfigTestResult: function (cb) { listen(CHANNEL.aiConfigTestResult, cb); },

    // 状态机：列出 / 运行 / 停止 / 确认覆盖 / 取消确认（AI 接管必须走用户确认）。
    stateMachineList: function () { send(CHANNEL.stateMachineList); },
    stateMachineRun: function (p) { send(CHANNEL.stateMachineRun, p || {}); },
    stateMachineStop: function (botId) { send(CHANNEL.stateMachineStop, botId || ""); },
    stateMachineConfirm: function (botId) { send(CHANNEL.stateMachineConfirm, botId || ""); },
    stateMachineCancel: function (botId) { send(CHANNEL.stateMachineCancel, botId || ""); },
    // 监听：状态机清单 / 运行中 / 待确认数据。
    onStateMachineData: function (cb) { listen(CHANNEL.stateMachineData, cb); },
    // 监听：状态机操作结果。
    onStateMachineResult: function (cb) { listen(CHANNEL.stateMachineResult, cb); },

    // 偏好：加载 / 保存（测试模式、蜂巢思维、AI 编程、bot 对话、打字机开关）。
    prefsLoad: function () { send(CHANNEL.prefsLoad); },
    prefsSave: function (p) { send(CHANNEL.prefsSave, p || {}); },
    onPrefsData: function (cb) { listen(CHANNEL.prefsData, cb); },
    onPrefsResult: function (cb) { listen(CHANNEL.prefsResult, cb); },

    // 参数：查询 / 写入（真落盘 state/params.json）。
    paramGet: function (key) { send(CHANNEL.paramGet, key); },
    paramSet: function (p) { send(CHANNEL.paramSet, p || {}); },
    onParamResult: function (cb) { listen(CHANNEL.paramResult, cb); },

    // Ollama：状态 / 模型列表 / 拉取 / 删除 / 打开官网下载页。
    ollamaStatus: function () { send(CHANNEL.ollamaStatus); },
    ollamaList: function () { send(CHANNEL.ollamaList); },
    ollamaPull: function (name) { send(CHANNEL.ollamaPull, name); },
    ollamaRemove: function (name) { send(CHANNEL.ollamaRemove, name); },
    ollamaOpenPage: function () { send(CHANNEL.ollamaOpenPage); },
    onOllamaStatus: function (cb) { listen(CHANNEL.ollamaStatusResult, cb); },
    onOllamaList: function (cb) { listen(CHANNEL.ollamaListResult, cb); },
    onOllamaAction: function (cb) { listen(CHANNEL.ollamaActionResult, cb); },

    // npm 插件：列出已装 / 安装 / 卸载。
    npmList: function () { send(CHANNEL.npmList); },
    npmInstall: function (name) { send(CHANNEL.npmInstall, name); },
    npmUninstall: function (name) { send(CHANNEL.npmUninstall, name); },
    onNpmList: function (cb) { listen(CHANNEL.npmListResult, cb); },
    onNpmAction: function (cb) { listen(CHANNEL.npmActionResult, cb); },

    // 实时遥测：拉一次 / 开关 1 秒推送 / 监听数据（kind=alert 表示挨打告警）。
    telemetryGet: function () { send(CHANNEL.telemetryGet); },
    telemetryWatch: function (on) { send(CHANNEL.telemetryWatch, { on: on === true }); },
    onTelemetry: function (cb) { listen(CHANNEL.telemetryData, cb); },

    // 手动驾驶：{ botId, action, key, on, yaw, pitch, slot }（WASD / 空格 / 快捷栏 / 攻击 / 使用）。
    manualControl: function (p) { send(CHANNEL.manualControl, p || {}); },
    onManualResult: function (cb) { listen(CHANNEL.manualResult, cb); },

    // 3D 视角：打开 / 关闭 / 监听结果（主进程负责起服务并打开系统浏览器）。
    viewerOpen: function (p) { send(CHANNEL.viewerOpen, p || {}); },
    viewerStop: function () { send(CHANNEL.viewerStop); },
    onViewerResult: function (cb) { listen(CHANNEL.viewerResult, cb); },

    // 16 个高级动作：列表 / 执行 / 监听结果。
    actionList: function () { send(CHANNEL.actionList); },
    actionRun: function (p) { send(CHANNEL.actionRun, p || {}); },
    onActionList: function (cb) { listen(CHANNEL.actionListData, cb); },
    onActionResult: function (cb) { listen(CHANNEL.actionResult, cb); },

    // 状态机 3.0 蜂群控制台：发一条指令（或 action=status / commands / reset），监听统一回包。
    swarmConsole: function (p) { send(CHANNEL.swarmConsole, p || {}); },
    onSwarmConsole: function (cb) { listen(CHANNEL.swarmConsoleData, cb); },

    // 聊天频道隔离：清单 / 分配 / 公屏指令 / 清空，统一回包 channel-result。
    channelList: function () { send(CHANNEL.channelList); },
    channelSet: function (p) { send(CHANNEL.channelSet, p || {}); },
    channelCommand: function (p) { send(CHANNEL.channelCommand, p || {}); },
    channelClear: function () { send(CHANNEL.channelClear); },
    onChannelResult: function (cb) { listen(CHANNEL.channelResult, cb); },

    // 模型档案池：清单 / 按 bot 选档案 / 移除，统一回包 model-profile-result。
    modelProfileList: function () { send(CHANNEL.modelProfileList); },
    modelProfileSet: function (p) { send(CHANNEL.modelProfileSet, p || {}); },
    modelProfileRemove: function (p) { send(CHANNEL.modelProfileRemove, p || {}); },
    modelProfileBind: function (p) { send(CHANNEL.modelProfileBind, p || {}); },
    modelProfileUnbind: function (p) { send(CHANNEL.modelProfileUnbind, p || {}); },
    onModelProfileResult: function (cb) { listen(CHANNEL.modelProfileResult, cb); },

    // 日志语言：通知主进程 logger.setLang（中文 / 英文日志切换）。
    setLogLang: function (lang) { send(CHANNEL.logLang, lang || "zh"); },

    // 监听：主进程日志推送。
    onLog: function (cb) { listen(CHANNEL.botLog, cb); },
    // 监听：主进程操作结果（start / stop / execute 等）。
    onResult: function (cb) { listen(CHANNEL.botResult, cb); },
    // 监听：bot 状态列表推送（每 5 秒轮询的回包数据）。
    onBotList: function (cb) { listen(CHANNEL.botList, cb); },

    // 账号：发起微软正版授权（设备码流）。
    microsoftAuthStart: function (p) { send(CHANNEL.microsoftAuthStart, p || {}); },
    onMicrosoftAuthResult: function (cb) { listen(CHANNEL.microsoftAuthResult, cb); },
    // 监听：设备码弹窗信息（userCode / verificationUri）与授权进度。
    onMicrosoftAuthCode: function (cb) { listen(CHANNEL.microsoftAuthCode, cb); },
    onMicrosoftAuthStatus: function (cb) { listen(CHANNEL.microsoftAuthStatus, cb); },

    // 安全：一键清理并打包 state（脱敏）/ 内存检测告警。
    safetyClean: function (p) { send(CHANNEL.safetyClean, p || {}); },
    onSafetyCleanResult: function (cb) { listen(CHANNEL.safetyCleanResult, cb); },
    safetyMemory: function (p) { send(CHANNEL.safetyMemory, p || {}); },
    onSafetyMemoryResult: function (cb) { listen(CHANNEL.safetyMemoryResult, cb); },
    // Bot 后台仓库：一键保存 / 列表 / 恢复 / 永久删除 + 皮肤导入 / 读取 / 删除。
    rosterList: function () { send(CHANNEL.rosterList, {}); },
    onRosterListResult: function (cb) { listen(CHANNEL.rosterListResult, cb); },
    rosterSave: function (p) { send(CHANNEL.rosterSave, p || {}); },
    onRosterSaveResult: function (cb) { listen(CHANNEL.rosterSaveResult, cb); },
    rosterLoad: function (p) { send(CHANNEL.rosterLoad, p || {}); },
    onRosterLoadResult: function (cb) { listen(CHANNEL.rosterLoadResult, cb); },
    rosterRestore: function () { send(CHANNEL.rosterRestore, {}); },
    onRosterRestoreResult: function (cb) { listen(CHANNEL.rosterRestoreResult, cb); },
    rosterDelete: function (p) { send(CHANNEL.rosterDelete, p || {}); },
    onRosterDeleteResult: function (cb) { listen(CHANNEL.rosterDeleteResult, cb); },
    skinImport: function (p) { send(CHANNEL.skinImport, p || {}); },
    onSkinImportResult: function (cb) { listen(CHANNEL.skinImportResult, cb); },
    skinGet: function (p) { send(CHANNEL.skinGet, p || {}); },
    onSkinGetResult: function (cb) { listen(CHANNEL.skinGetResult, cb); },
    skinRemove: function (p) { send(CHANNEL.skinRemove, p || {}); },
    onSkinRemoveResult: function (cb) { listen(CHANNEL.skinRemoveResult, cb); },
    // 本地推理框架：清单 / 配置 / 探测 / 状态 / 启动 / 停止 / 模型列表。
    localFrameworks: function () { send(CHANNEL.localFrameworks, {}); },
    onLocalFrameworksResult: function (cb) { listen(CHANNEL.localFrameworksResult, cb); },
    localConfigLoad: function (p) { send(CHANNEL.localConfigLoad, p || {}); },
    onLocalConfigLoadResult: function (cb) { listen(CHANNEL.localConfigLoadResult, cb); },
    localConfigSave: function (p) { send(CHANNEL.localConfigSave, p || {}); },
    onLocalConfigSaveResult: function (cb) { listen(CHANNEL.localConfigSaveResult, cb); },
    localDetect: function (p) { send(CHANNEL.localDetect, p || {}); },
    onLocalDetectResult: function (cb) { listen(CHANNEL.localDetectResult, cb); },
    localStatus: function (p) { send(CHANNEL.localStatus, p || {}); },
    onLocalStatusResult: function (cb) { listen(CHANNEL.localStatusResult, cb); },
    localStart: function (p) { send(CHANNEL.localStart, p || {}); },
    onLocalStartResult: function (cb) { listen(CHANNEL.localStartResult, cb); },
    localStop: function (p) { send(CHANNEL.localStop, p || {}); },
    onLocalStopResult: function (cb) { listen(CHANNEL.localStopResult, cb); },
    localModels: function (p) { send(CHANNEL.localModels, p || {}); },
    onLocalModelsResult: function (cb) { listen(CHANNEL.localModelsResult, cb); },
    localModelImport: function (p) { send(CHANNEL.localModelImport, p || {}); },
    onLocalModelImportResult: function (cb) { listen(CHANNEL.localModelImportResult, cb); },
    localModelRemove: function (p) { send(CHANNEL.localModelRemove, p || {}); },
    onLocalModelRemoveResult: function (cb) { listen(CHANNEL.localModelRemoveResult, cb); },
    localInstances: function () { send(CHANNEL.localInstances, {}); },
    onLocalInstancesResult: function (cb) { listen(CHANNEL.localInstancesResult, cb); },
    localInstanceCreate: function (p) { send(CHANNEL.localInstanceCreate, p || {}); },
    onLocalInstanceCreateResult: function (cb) { listen(CHANNEL.localInstanceCreateResult, cb); },
    localInstanceRemove: function (p) { send(CHANNEL.localInstanceRemove, p || {}); },
    onLocalInstanceRemoveResult: function (cb) { listen(CHANNEL.localInstanceRemoveResult, cb); }
  };
}

// 功能 2：把接口挂到渲染进程的 window.botAPI（contextBridge 不可用时退回直接赋值）。
function exposeApi() {
  var api = buildApi();
  var ok = false;
  try {
    if (contextBridge && typeof contextBridge.exposeInMainWorld === "function") {
      contextBridge.exposeInMainWorld("botAPI", api);
      ok = true;
    }
  } catch (e) {
    logWarn("暴露 botAPI 失败 / expose botAPI failed: " + getErrText(e));
  }
  if (!ok) {
    try {
      if (typeof window !== "undefined") window.botAPI = api;
    } catch (e) {
      logWarn("降级赋值失败 / fallback assign failed: " + getErrText(e));
    }
  }
  return ok;
}

// 启动：立刻暴露接口；失败只写日志，绝不让 preload 抛错把窗口拖崩。
exposeApi();
