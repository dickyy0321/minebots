// ========================================
// 文件：modules/ollama-installer.js
// 功能：Ollama 真接口——服务状态 / 模型列表 / 拉取模型 / 删除模型 / 打开官网下载页
// 依赖：axios（可选，缺失时全部返回 ok:false）、../settings（可选，host 兜底）、./logger（可选）
// 导出：status、listModels、pull、remove、openDownloadPage、getHost
// 作者：MineBots
// ========================================
//
// 为什么是 HTTP 而不是「下载安装包」：
//   真实的 Ollama 自带 HTTP API（/api/tags、/api/pull、/api/delete），只要本机装了它就能用；
//   「下载安装包并静默安装」既不可验证也有安全风险，所以不放假按钮：
//   真需要安装时用 openDownloadPage() 打开官网，让用户自己决定。
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

// 可选依赖：HTTP 客户端；缺失时所有请求直接失败并返回 ok:false。
var axios = null;
try { axios = require("axios"); } catch (e) { axios = null; }
// 可选依赖：全局配置（读 ollama.host）；缺失时用内置默认地址。
var settings = null;
try { settings = require("../settings"); } catch (e2) { settings = null; }
// 可选依赖：日志核心；缺失时静默。
var logger = null;
try { logger = require("./logger"); } catch (e3) { logger = null; }

// 常量：默认地址 / 普通请求超时 / 拉取模型超时（下载可能很久）/ 官网地址。
var DEFAULT_HOST = "http://127.0.0.1:11434";
var TIMEOUT_MS = 6000;
var PULL_TIMEOUT_MS = 600000;
var DOWNLOAD_PAGE = "https://ollama.com/download";

// 写普通信息日志：只落文件不推 GUI（模型列表这类高频信息不刷界面）。
function logInfo(message) {
  try { if (logger && typeof logger.info === "function") logger.info(message); } catch (e) { /* ignore */ }
}

// 写告警日志：真实失败要让人看见，推 GUI。
function logWarn(message) {
  try {
    if (logger && typeof logger.warn === "function") logger.warn(message);
    else console.warn(message);
  } catch (e) { /* ignore */ }
}

// 把异常拍成一行文本，避免在 catch 里再次抛错。
function errText(err) {
  try {
    if (!err) return "unknown error";
    if (err.message) return String(err.message);
    return String(err);
  } catch (e) { return "unknown error"; }
}

// 去掉字符串末尾的斜杠，避免拼出双斜杠。
function trimSlash(text) {
  var s = String(text || "");
  while (s.length > 1 && s.charAt(s.length - 1) === "/") s = s.slice(0, -1);
  return s;
}

// 功能 6：取 Ollama 服务地址——配置里写了就用配置，读不到用默认地址，绝不抛错。
function getHost() {
  try {
    var host = settings && settings.ollama ? settings.ollama.host : "";
    var text = trimSlash(host);
    if (text.length > 0) return text;
  } catch (e) { /* 用默认地址 */ }
  return DEFAULT_HOST;
}

// 内部：发一次请求，统一超时与错误处理；成功返回 { ok:true, data }，失败返回 { ok:false, message }。
async function request(method, path, body, timeoutMs) {
  if (!axios || typeof axios.request !== "function") {
    return { ok: false, message: "axios unavailable / HTTP 客户端不可用" };
  }
  try {
    var res = await axios.request({
      method: method, url: getHost() + path, data: body || undefined,
      timeout: timeoutMs || TIMEOUT_MS, headers: { "Content-Type": "application/json" }
    });
    return { ok: true, data: res && res.data ? res.data : null };
  } catch (err) {
    return { ok: false, message: errText(err) };
  }
}

// 功能 1：查服务状态——通不通 / 有几个模型；不通也算正常结果（ok:true, up:false）。
async function status() {
  var out = { ok: true, up: false, host: getHost(), count: 0, message: "" };
  var res = await request("GET", "/api/tags", null, TIMEOUT_MS);
  if (!res.ok) {
    out.message = "offline / 服务未启动: " + res.message;
    return out;
  }
  var models = res.data && Array.isArray(res.data.models) ? res.data.models : [];
  out.up = true;
  out.count = models.length;
  out.message = "online / 服务在线，模型 " + models.length + " 个";
  return out;
}

// 功能 2：列出本机已有模型名（按名字排序），失败返回空数组 + message。
async function listModels() {
  var out = { ok: false, models: [], host: getHost(), message: "" };
  var res = await request("GET", "/api/tags", null, TIMEOUT_MS);
  if (!res.ok) {
    out.message = "offline / 服务未启动: " + res.message;
    logWarn("[ollama] list failed: " + res.message);
    return out;
  }
  var raw = res.data && Array.isArray(res.data.models) ? res.data.models : [];
  var names = [];
  for (var i = 0; i < raw.length; i++) {
    var name = "";
    try { name = raw[i] && raw[i].name ? String(raw[i].name) : ""; } catch (e) { name = ""; }
    if (name.length > 0) names.push(name);
  }
  names.sort();
  out.ok = true;
  out.models = names;
  logInfo("[ollama] models: " + names.join(","));
  return out;
}

// 功能 3：拉取（下载）一个模型——名字必须像 xx:tag，成功返回 { ok, model }；失败只写日志。
async function pull(name) {
  var model = String(name || "").replace(/^\s+|\s+$/g, "");
  if (model.length === 0) return { ok: false, model: "", message: "model name required / 缺少模型名" };
  if (!/^[A-Za-z0-9._\-\/:]+$/.test(model)) {
    return { ok: false, model: model, message: "bad model name / 模型名不合法" };
  }
  var res = await request("POST", "/api/pull", { name: model, stream: false }, PULL_TIMEOUT_MS);
  if (!res.ok) {
    logWarn("[ollama] pull " + model + " failed: " + res.message);
    return { ok: false, model: model, message: "pull failed / 拉取失败: " + res.message };
  }
  logWarn("[ollama] pulled model / 已下载模型: " + model);
  return { ok: true, model: model, message: "pulled / 已下载: " + model };
}

// 功能 4：删除本机模型；失败只写日志并返回 ok:false。
async function remove(name) {
  var model = String(name || "").replace(/^\s+|\s+$/g, "");
  if (model.length === 0) return { ok: false, model: "", message: "model name required / 缺少模型名" };
  var res = await request("DELETE", "/api/delete", { name: model }, TIMEOUT_MS);
  if (!res.ok) {
    logWarn("[ollama] delete " + model + " failed: " + res.message);
    return { ok: false, model: model, message: "delete failed / 删除失败: " + res.message };
  }
  logWarn("[ollama] deleted model / 已删除模型: " + model);
  return { ok: true, model: model, message: "deleted / 已删除: " + model };
}

// 功能 5：打开官网下载页（真正的「安装」入口）——Electron 不在时给提示，绝不自称已安装。
async function openDownloadPage() {
  var shell = null;
  try {
    var electron = require("electron");
    shell = electron ? electron.shell : null;
  } catch (e) { shell = null; }
  if (!shell || typeof shell.openExternal !== "function") {
    return { ok: false, message: "open " + DOWNLOAD_PAGE + " manually / 请手动打开官网下载页" };
  }
  try {
    await shell.openExternal(DOWNLOAD_PAGE);
    return { ok: true, message: "browser opened / 已打开下载页: " + DOWNLOAD_PAGE };
  } catch (err) {
    return { ok: false, message: "open failed / 打开失败: " + errText(err) };
  }
}

// 对外导出：状态 / 列表 / 拉取 / 删除 / 官网 / 地址。
module.exports = {
  status: status,
  listModels: listModels,
  pull: pull,
  remove: remove,
  openDownloadPage: openDownloadPage,
  getHost: getHost
};
