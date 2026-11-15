// ========================================
// 文件：scripts/selftest-p19.js
// 功能：本地推理框架回归——Ollama / LM Studio / llama.cpp / SGLang / 自定义：默认端口、配置存取、探测、状态、启动前置校验、IPC/UI 接线
// 依赖：path、fs、os；被测 modules/local-runtime、gui/ipc-local、gui/renderer/panel-local.js（文本断言）
// 导出：run（由 selftest-p5.js 调用）
// 说明：配置写 MINEBOTS_STATE_DIR 临时目录；状态探测只打 127.0.0.1 的未监听端口，不联网；不会真的启动任何框架。
// 作者：MineBots
// ========================================
var path = require("path");
var fs = require("fs");
var os = require("os");
var ROOT = path.join(__dirname, "..");
var TEMP_DIR = path.join(os.tmpdir(), "minebots-p19-" + process.pid);

function load(rel) {
  try { return require(path.join(ROOT, rel)); } catch (e) { return null; }
}
function readRel(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch (e) { return ""; }
}
function safeRemove(dir) {
  try {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir).forEach(function (n) {
      var p = path.join(dir, n);
      try { if (fs.lstatSync(p).isDirectory()) safeRemove(p); else fs.unlinkSync(p); } catch (e) { /* ignore */ }
    });
    try { fs.rmdirSync(dir); } catch (e2) { /* ignore */ }
  } catch (e) { /* ignore */ }
}

// A. 静态红线与导出。
function checkStatic(h) {
  var files = [
    { rel: "modules/local-runtime.js", wanted: ["listFrameworks", "getConfig", "saveConfig", "detect", "status", "start", "stop"] },
    { rel: "gui/ipc-local.js", wanted: ["register"] },
    { rel: "gui/renderer/panel-local.js", wanted: [], textOnly: true }
  ];
  var badOpt = new RegExp("\\?\\.");
  var badNull = new RegExp("\\?\\?");
  var badArrow = new RegExp("=\\>");
  var badTick = new RegExp(String.fromCharCode(96));
  var badDecl = new RegExp("\\b" + String.fromCharCode(99, 111, 110, 115, 116) + "\\b");
  for (var i = 0; i < files.length; i++) {
    var f = files[i].textOnly ? null : load(files[i].rel);
    if (!files[i].textOnly) h.expect("p19 静态: " + files[i].rel + " 可 require", !!f, "null");
    var src = readRel(files[i].rel);
    h.expect("p19 静态: " + files[i].rel + " 有文件头注释", src.indexOf("// ====") >= 0, "");
    h.expect("p19 静态: " + files[i].rel + " 无禁用语法", !badOpt.test(src) && !badNull.test(src) && !badArrow.test(src) && !badTick.test(src) && !badDecl.test(src), "");
    h.expect("p19 静态: " + files[i].rel + " 不超过 600 行", src.split("\n").length <= 600, String(src.split("\n").length));
    if (!files[i].textOnly) {
      for (var w = 0; w < files[i].wanted.length; w++) {
        h.expect("p19 静态: " + files[i].rel + " 导出 " + files[i].wanted[w], f && typeof f[files[i].wanted[w]] === "function", "");
      }
    }
  }
}

// B. 框架清单与默认端口。
function checkFrameworks(h) {
  var rt = load("modules/local-runtime");
  if (!rt) { h.expect("p19 框架: 模块可加载", false, "null"); return; }
  var ls = rt.listFrameworks();
  h.expect("p19 框架: 清单可读", ls.ok === true && Array.isArray(ls.frameworks), "");
  var map = {};
  for (var i = 0; i < (ls.frameworks || []).length; i++) map[ls.frameworks[i].name] = ls.frameworks[i].config;
  h.expect("p19 框架: 含 ollama/lmstudio/llamacpp/sglang/custom", !!(map.ollama && map.lmstudio && map.llamacpp && map.sglang && map.custom), Object.keys(map).join(","));
  h.expect("p19 框架: Ollama 默认 11434", map.ollama && map.ollama.port === 11434, map.ollama && map.ollama.port);
  h.expect("p19 框架: LM Studio 默认 1234", map.lmstudio && map.lmstudio.port === 1234, map.lmstudio && map.lmstudio.port);
  h.expect("p19 框架: llama.cpp 默认 8080", map.llamacpp && map.llamacpp.port === 8080, map.llamacpp && map.llamacpp.port);
  h.expect("p19 框架: SGLang 默认 30000", map.sglang && map.sglang.port === 30000, map.sglang && map.sglang.port);
  h.expect("p19 框架: baseUrl 跟着端口", map.sglang && map.sglang.baseUrl === "http://127.0.0.1:30000/v1", map.sglang && map.sglang.baseUrl);
}

// C. 配置存取：自定义端口 / 模型 / 路径 / 非法端口。
function checkConfig(h) {
  var rt = load("modules/local-runtime");
  if (!rt) return;
  var saved = rt.saveConfig("sglang", { port: 30123, model: "Qwen/Qwen2.5-7B-Instruct", exePath: "C:/Python311/python.exe", extraArgs: "--mem-fraction-static 0.8" });
  h.expect("p19 配置: 保存成功", saved.ok === true, JSON.stringify(saved));
  var got = rt.getConfig("sglang");
  h.expect("p19 配置: 端口读回", got.ok && got.config.port === 30123, JSON.stringify(got.config));
  h.expect("p19 配置: 模型读回", got.ok && got.config.model === "Qwen/Qwen2.5-7B-Instruct", got.config && got.config.model);
  h.expect("p19 配置: 路径与参数读回", got.ok && got.config.exePath.indexOf("python") >= 0 && got.config.extraArgs.indexOf("mem-fraction") >= 0, JSON.stringify(got.config));
  h.expect("p19 配置: baseUrl 随端口更新", got.ok && got.config.baseUrl === "http://127.0.0.1:30123/v1", got.config && got.config.baseUrl);
  h.expect("p19 配置: 非法端口被拒", rt.saveConfig("sglang", { port: 70000 }).ok === false, "");
  h.expect("p19 配置: 未知框架被拒", rt.getConfig("nope").ok === false, "");
  h.expect("p19 配置: 落盘文件存在", fs.existsSync(path.join(TEMP_DIR, "local-runtimes.json")), "");
}

// D. 探测 / 状态 / 启动前置校验 / 停止。
async function checkRuntime(h) {
  var rt = load("modules/local-runtime");
  if (!rt) return;
  var det = rt.detect("ollama");
  h.expect("p19 运行: 探测返回结构", !!det && typeof det.ok === "boolean", JSON.stringify(det));
  if (det.ok) h.expect("p19 运行: 探测到路径存在", fs.existsSync(det.path), det.path);
  h.expect("p19 运行: 未知框架探测失败", rt.detect("nope").ok === false, "");
  var noPath = rt.start("custom");
  h.expect("p19 运行: 无路径启动被拒（needPath）", noPath.ok === false && noPath.needPath === true, JSON.stringify(noPath));
  var stop = rt.stop("ollama");
  h.expect("p19 运行: 未启动的实例不能停", stop.ok === false, JSON.stringify(stop));
  var st = await rt.status("custom");
  h.expect("p19 运行: 未监听端口判未运行", st.ok === false && st.running === false, JSON.stringify(st));
  var ms = await rt.models("custom");
  h.expect("p19 运行: 模型列表空也返回结构", ms && Array.isArray(ms.models), JSON.stringify(ms));
}

// E. 接线：IPC 三件套 + UI 控件 + 预设归位。
function checkWiring(h) {
  var main = readRel("gui/main.js");
  var preload = readRel("gui/preload.js");
  var api = readRel("gui/renderer/api.js");
  var settings = readRel("gui/renderer/settings.html");
  var panelLocal = readRel("gui/renderer/panel-local.js");
  var aiConfig = load("modules/ai-config");
  var mp = load("modules/model-profile");
  h.expect("p19 接线: main 挂载 ipc-local", main.indexOf("ipc-local") >= 0, "");
  h.expect("p19 接线: preload 含 local-config-save", preload.indexOf('"local-config-save"') >= 0, "");
  h.expect("p19 接线: preload 含 local-start", preload.indexOf('"local-start"') >= 0, "");
  h.expect("p19 接线: api 暴露 localStart", api.indexOf("localStart") >= 0, "");
  h.expect("p19 接线: 设置页有端口/路径/启动控件", settings.indexOf('id="localPortInput"') >= 0 && settings.indexOf('id="localExeInput"') >= 0 && settings.indexOf('id="localStartBtn"') >= 0 && settings.indexOf('id="localDetectBtn"') >= 0, "");
  h.expect("p19 接线: 设置页框架含 SGLang", settings.indexOf('value="sglang"') >= 0, "");
  h.expect("p19 接线: panel-local 有探测/启动/停止", panelLocal.indexOf("detect:") >= 0 && panelLocal.indexOf("start:") >= 0 && panelLocal.indexOf("stop:") >= 0, "");
  var presets = aiConfig && typeof aiConfig.getEnginePresets === "function" ? aiConfig.getEnginePresets() : {};
  h.expect("p19 接线: ai-config 引擎预设含 sglang/30000", !!(presets.sglang && presets.sglang.port === 30000), JSON.stringify(Object.keys(presets)));
  h.expect("p19 接线: 模型档案 SGLang 是本地", !!(mp && mp.DEFINITIONS.sglang && mp.DEFINITIONS.sglang.provider === "local"), "");
  var aiClient = readRel("modules/ai-client.js");
  h.expect("p19 接线: 本地引擎名单含 sglang", aiClient.indexOf('"sglang"') >= 0, "");
}

function run(h) {
  var oldDir = process.env.MINEBOTS_STATE_DIR;
  try {
    safeRemove(TEMP_DIR);
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    process.env.MINEBOTS_STATE_DIR = TEMP_DIR;
  } catch (e) { /* ignore */ }
  var groups = [checkStatic, checkFrameworks, checkConfig, checkWiring];
  for (var i = 0; i < groups.length; i++) {
    try { groups[i](h); } catch (e) { h.expect("p19 组 " + (i + 1) + " 未抛错", false, String(e)); }
  }
  return Promise.resolve()
    .then(function () { return checkRuntime(h); })
    .catch(function (e) { h.expect("p19 运行组未抛错", false, String(e)); })
    .then(function () {
      try {
        safeRemove(TEMP_DIR);
        if (oldDir === undefined) delete process.env.MINEBOTS_STATE_DIR;
        else process.env.MINEBOTS_STATE_DIR = oldDir;
      } catch (e2) { /* ignore */ }
    });
}

module.exports = { run: run };
