// ========================================
// 文件：gui/ipc-local.js
// 功能：本地推理框架 IPC——清单 / 读配置 / 存配置 / 探测路径 / 运行状态 / 启动 / 停止 / 模型列表
// 依赖：../modules/local-runtime（可选，缺失时各通道回 ok:false）
// 导出：CHANNELS / register
// 说明：按 gui/ipc-extra.js 的约定，main.js 在 registerIpc() 末尾调一次 register(ctx)；
//       探测与状态都带超时，启动只拉起子进程，停止只杀自己拉起的进程树。
// 作者：MineBots
// ========================================
var runtime = null;
try { runtime = require("../modules/local-runtime"); } catch (e) { runtime = null; }

var CHANNELS = {
  list: "local-frameworks",
  listResult: "local-frameworks-result",
  configLoad: "local-config-load",
  configLoadResult: "local-config-load-result",
  configSave: "local-config-save",
  configSaveResult: "local-config-save-result",
  detect: "local-detect",
  detectResult: "local-detect-result",
  status: "local-status",
  statusResult: "local-status-result",
  start: "local-start",
  startResult: "local-start-result",
  stop: "local-stop",
  stopResult: "local-stop-result",
  models: "local-models",
  modelsResult: "local-models-result",
  modelImport: "local-model-import",
  modelImportResult: "local-model-import-result",
  modelRemove: "local-model-remove",
  modelRemoveResult: "local-model-remove-result",
  instances: "local-instances",
  instancesResult: "local-instances-result",
  instanceCreate: "local-instance-create",
  instanceCreateResult: "local-instance-create-result",
  instanceRemove: "local-instance-remove",
  instanceRemoveResult: "local-instance-remove-result"
};

function errText(err) {
  try { return err && err.message ? String(err.message) : String(err); } catch (e) { return "unknown error"; }
}

function register(ctx) {
  var api = ctx || {};
  if (!api || typeof api.onRequest !== "function") {
    return { ok: false, channels: 0, message: "IPC 上下文不完整 / incomplete IPC context" };
  }
  var logWarn = typeof api.logWarn === "function" ? api.logWarn : function () { };
  var need = function () {
    if (!runtime) return { ok: false, message: "本地框架模块未加载 / local-runtime not loaded" };
    return null;
  };

  api.onRequest(CHANNELS.list, CHANNELS.listResult, function () {
    var bad = need(); if (bad) return bad;
    try { return runtime.listFrameworks(); } catch (e) { return { ok: false, message: errText(e) }; }
  });

  api.onRequest(CHANNELS.configLoad, CHANNELS.configLoadResult, function (event, payload) {
    var bad = need(); if (bad) return bad;
    var p = payload && typeof payload === "object" ? payload : {};
    try { return runtime.getConfig(p.name || ""); } catch (e) { return { ok: false, message: errText(e) }; }
  });

  api.onRequest(CHANNELS.configSave, CHANNELS.configSaveResult, function (event, payload) {
    var bad = need(); if (bad) return bad;
    var p = payload && typeof payload === "object" ? payload : {};
    try { return runtime.saveConfig(p.name || "", p); } catch (e) { logWarn("保存本地配置失败 / save failed: " + errText(e)); return { ok: false, message: errText(e) }; }
  });

  api.onRequest(CHANNELS.detect, CHANNELS.detectResult, function (event, payload) {
    var bad = need(); if (bad) return bad;
    var p = payload && typeof payload === "object" ? payload : {};
    try { return runtime.detect(p.name || ""); } catch (e) { return { ok: false, message: errText(e) }; }
  });

  api.onRequest(CHANNELS.status, CHANNELS.statusResult, function (event, payload) {
    var bad = need(); if (bad) return bad;
    var p = payload && typeof payload === "object" ? payload : {};
    try { return runtime.status(p.name || ""); } catch (e) { return { ok: false, message: errText(e) }; }
  });

  api.onRequest(CHANNELS.start, CHANNELS.startResult, function (event, payload) {
    var bad = need(); if (bad) return bad;
    var p = payload && typeof payload === "object" ? payload : {};
    try { return runtime.start(p.name || ""); } catch (e) { logWarn("启动本地框架失败 / start failed: " + errText(e)); return { ok: false, message: errText(e) }; }
  });

  api.onRequest(CHANNELS.stop, CHANNELS.stopResult, function (event, payload) {
    var bad = need(); if (bad) return bad;
    var p = payload && typeof payload === "object" ? payload : {};
    try { return runtime.stop(p.name || ""); } catch (e) { return { ok: false, message: errText(e) }; }
  });

  api.onRequest(CHANNELS.models, CHANNELS.modelsResult, function (event, payload) {
    var bad = need(); if (bad) return bad;
    var p = payload && typeof payload === "object" ? payload : {};
    try { return runtime.models(p.name || ""); } catch (e) { return { ok: false, message: errText(e) }; }
  });

  // 模型库：导入 / 移除（导入=登记到该框架的自定义清单并设为启动模型，不会下载大文件）。
  api.onRequest(CHANNELS.modelImport, CHANNELS.modelImportResult, function (event, payload) {
    var bad = need(); if (bad) return bad;
    var p = payload && typeof payload === "object" ? payload : {};
    try { return runtime.importModel(p.name || "", p.model || ""); } catch (e) { return { ok: false, message: errText(e) }; }
  });

  api.onRequest(CHANNELS.modelRemove, CHANNELS.modelRemoveResult, function (event, payload) {
    var bad = need(); if (bad) return bad;
    var p = payload && typeof payload === "object" ? payload : {};
    try { return runtime.removeModel(p.name || "", p.model || ""); } catch (e) { return { ok: false, message: errText(e) }; }
  });

  // 标签（实例）：一个标签 = 框架 + 模型 + 参数，可同时运行多个，分别供给不同 Bot。
  api.onRequest(CHANNELS.instances, CHANNELS.instancesResult, function () {
    var bad = need(); if (bad) return bad;
    try { return runtime.listInstances(); } catch (e) { return { ok: false, message: errText(e) }; }
  });

  api.onRequest(CHANNELS.instanceCreate, CHANNELS.instanceCreateResult, function (event, payload) {
    var bad = need(); if (bad) return bad;
    var p = payload && typeof payload === "object" ? payload : {};
    try { return runtime.createInstance(p); } catch (e) { return { ok: false, message: errText(e) }; }
  });

  api.onRequest(CHANNELS.instanceRemove, CHANNELS.instanceRemoveResult, function (event, payload) {
    var bad = need(); if (bad) return bad;
    var p = payload && typeof payload === "object" ? payload : {};
    try { return runtime.removeInstance(p.name || p.id || ""); } catch (e) { return { ok: false, message: errText(e) }; }
  });

  return { ok: true, channels: Object.keys(CHANNELS).length };
}

module.exports = { CHANNELS: CHANNELS, register: register };
