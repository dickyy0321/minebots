// ========================================
// 文件：gui/ipc-roster.js
// 功能：Bot 后台仓库与皮肤的 IPC——一键保存配置 / 列表 / 恢复 / 永久删除 / 导入皮肤 / 读取皮肤
// 依赖：../modules/bot-roster、../modules/skin-manager（都可选，缺失时对应通道回 ok:false）
// 导出：CHANNELS / register
// 说明：按 gui/ipc-extra.js 的约定，main.js 在 registerIpc() 末尾调一次 register(ctx)。
//       所有通道都回 { ok, message }（双语），异常吞掉写日志，绝不冒到 Electron 顶层。
// 作者：MineBots
// ========================================
var roster = null;
try { roster = require("../modules/bot-roster"); } catch (e) { roster = null; }
var skinManager = null;
try { skinManager = require("../modules/skin-manager"); } catch (e2) { skinManager = null; }

var CHANNELS = {
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
  skinRemoveResult: "skin-remove-result"
};

function getErrText(err) {
  try { return err && err.message ? String(err.message) : String(err); } catch (e) { return "unknown error"; }
}
function ready(moduleObj) {
  return !!moduleObj;
}

function register(ctx) {
  var api = ctx || {};
  if (!api || typeof api.onRequest !== "function") {
    return { ok: false, channels: 0, message: "IPC 上下文不完整 / incomplete IPC context" };
  }
  var logWarn = typeof api.logWarn === "function" ? api.logWarn : function () {};

  // 列出后台仓库里的全部 Bot 摘要。
  api.onRequest(CHANNELS.rosterList, CHANNELS.rosterListResult, function () {
    if (!ready(roster)) return { ok: false, message: "仓库模块未加载 / roster not loaded", items: [] };
    try { return roster.list(); } catch (e) { return { ok: false, message: getErrText(e), items: [] }; }
  });

  // 一键保存某个 Bot 的全部配置（profile 由渲染进程整理好）。
  api.onRequest(CHANNELS.rosterSave, CHANNELS.rosterSaveResult, function (event, payload) {
    if (!ready(roster)) return { ok: false, message: "仓库模块未加载 / roster not loaded" };
    var p = payload && typeof payload === "object" ? payload : {};
    try { return roster.save(p.profile || p); } catch (e) { logWarn("保存 Bot 档案失败 / save failed: " + getErrText(e)); return { ok: false, message: getErrText(e) }; }
  });

  // 读单个档案（含完整配置）。
  api.onRequest(CHANNELS.rosterLoad, CHANNELS.rosterLoadResult, function (event, payload) {
    if (!ready(roster)) return { ok: false, message: "仓库模块未加载 / roster not loaded" };
    var p = payload && typeof payload === "object" ? payload : {};
    try { return roster.load(p.id || p.botId || ""); } catch (e) { return { ok: false, message: getErrText(e) }; }
  });

  // 一键恢复全部档案。
  api.onRequest(CHANNELS.rosterRestore, CHANNELS.rosterRestoreResult, function () {
    if (!ready(roster)) return { ok: false, message: "仓库模块未加载 / roster not loaded", items: [] };
    try { return roster.restoreAll(); } catch (e) { return { ok: false, message: getErrText(e), items: [] }; }
  });

  // 永久删除（JSON + 皮肤一起删）。
  api.onRequest(CHANNELS.rosterDelete, CHANNELS.rosterDeleteResult, function (event, payload) {
    if (!ready(roster)) return { ok: false, message: "仓库模块未加载 / roster not loaded" };
    var p = payload && typeof payload === "object" ? payload : {};
    try { return roster.remove(p.id || p.botId || ""); } catch (e) { return { ok: false, message: getErrText(e) }; }
  });

  // 导入皮肤：{ botId, fileName, dataBase64 }。
  api.onRequest(CHANNELS.skinImport, CHANNELS.skinImportResult, function (event, payload) {
    if (!ready(skinManager)) return { ok: false, message: "皮肤模块未加载 / skin-manager not loaded" };
    try { return skinManager.importSkin(payload || {}); } catch (e) { logWarn("导入皮肤失败 / import skin failed: " + getErrText(e)); return { ok: false, message: getErrText(e) }; }
  });

  // 读皮肤：返回 base64 供卡片画头像。
  api.onRequest(CHANNELS.skinGet, CHANNELS.skinGetResult, function (event, payload) {
    if (!ready(skinManager)) return { ok: false, message: "皮肤模块未加载 / skin-manager not loaded" };
    var p = payload && typeof payload === "object" ? payload : {};
    try { return skinManager.getSkin(p.botId || p.id || ""); } catch (e) { return { ok: false, message: getErrText(e) }; }
  });

  // 删除皮肤（不删档案）。
  api.onRequest(CHANNELS.skinRemove, CHANNELS.skinRemoveResult, function (event, payload) {
    if (!ready(skinManager)) return { ok: false, message: "皮肤模块未加载 / skin-manager not loaded" };
    var p = payload && typeof payload === "object" ? payload : {};
    try { return skinManager.removeSkin(p.botId || p.id || ""); } catch (e) { return { ok: false, message: getErrText(e) }; }
  });

  return { ok: true, channels: 8 };
}

module.exports = { CHANNELS: CHANNELS, register: register };
