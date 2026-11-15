// ========================================
// 文件：scripts/selftest-p18.js
// 功能：AI 默认值与预设回归——默认云端 / 启动不探测 Ollama / SGLang 本地框架 / 预设卡片排版 / 本地引擎错误不弹红警
// 依赖：path、fs；被测 modules/ai-config、modules/model-profile、gui/renderer/panel-*.js（文本断言）
// 导出：run（由 selftest-p5.js 调用）
// 说明：全程离线、不碰真实 state/；只读默认值与源码文本，不发任何网络请求。
// 作者：MineBots
// ========================================
var path = require("path");
var fs = require("fs");
var ROOT = path.join(__dirname, "..");

function load(rel) {
  try { return require(path.join(ROOT, rel)); } catch (e) { return null; }
}
function readRel(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch (e) { return ""; }
}
function pickFunction(src, name) {
  try {
    var re = new RegExp(name + ": function \\(\\) \\{([\\s\\S]*?)\\n  \\},");
    var m = src.match(re);
    return m && m[1] ? m[1] : "";
  } catch (e) { return ""; }
}

// A. 默认值：云端优先，绝不默认 Ollama。
function checkDefaults(h) {
  var ac = load("modules/ai-config");
  h.expect("p18 默认: ai-config 可加载", !!ac, "null");
  var d = ac && typeof ac.getDefaults === "function" ? ac.getDefaults() : {};
  h.expect("p18 默认: provider=cloud", d.provider === "cloud", String(d.provider));
  h.expect("p18 默认: engine=custom（不是 ollama）", d.engine === "custom", String(d.engine));
  h.expect("p18 默认: 地址走云端而不是 11434", String(d.baseUrl || "").indexOf("11434") < 0 && String(d.baseUrl || "").indexOf("http") === 0, String(d.baseUrl));
  h.expect("p18 默认: 默认模型是云端模型", String(d.model || "").length > 0 && String(d.model).indexOf("deepseek") >= 0, String(d.model));

  var mp = load("modules/model-profile");
  h.expect("p18 默认: 模型档案池可加载", !!mp, "null");
  h.expect("p18 默认: 默认档案是 deepseek", mp && mp.DEFAULT_PROFILE === "deepseek", mp && mp.DEFAULT_PROFILE);
  var names = mp && mp.list ? mp.list().map(function (x) { return x.name; }) : [];
  h.expect("p18 默认: 预设里有 sglang", names.indexOf("sglang") >= 0, JSON.stringify(names));
  h.expect("p18 默认: Ollama 仍保留可选", names.indexOf("ollama") >= 0, JSON.stringify(names));
  var sd = mp && mp.DEFINITIONS ? mp.DEFINITIONS.sglang : null;
  h.expect("p18 默认: SGLang 是本地框架（不是云端）", !!(sd && sd.provider === "local" && sd.engine === "sglang" && sd.needsKey === false), JSON.stringify(sd));
  var ol = mp && mp.DEFINITIONS ? mp.DEFINITIONS.ollama : null;
  h.expect("p18 默认: Ollama 档案改名为本地配置", !!(ol && String(ol.label).indexOf("本地配置") >= 0), ol && ol.label);
}

// B. 启动不探测 Ollama + 本地错误不弹红警。
function checkNoProbe(h) {
  var install = readRel("gui/renderer/panel-install.js");
  var init = pickFunction(install, "init");
  h.expect("p18 探测: panel-install.init 存在", init.length > 0, "");
  h.expect("p18 探测: 启动时不调用 ollama 探测接口", init.indexOf("api.ollamaStatus") < 0 && init.indexOf("api.ollamaList") < 0, init.slice(0, 80));
  h.expect("p18 探测: 启动时给出「未检测」提示", install.indexOf("未检测，点「刷新」再查") >= 0, "");
  var safety = readRel("gui/renderer/ui-safety.js");
  h.expect("p18 探测: 本地引擎错误不弹红警", /ollama\|11434/.test(safety) || safety.indexOf("ollama|11434") >= 0, "");
  h.expect("p18 探测: 有主动探测入口 loadOllama", install.indexOf("loadOllama") >= 0, "");
}

// C. 面板：云端默认 + SGLang 本地选项 + 预设卡片。
function checkUi(h) {
  var settings = readRel("gui/renderer/settings.html");
  h.expect("p18 面板: 运行模式默认选中云端", settings.indexOf('value="cloud"') >= 0 && settings.indexOf("selected") >= 0, "");
  h.expect("p18 面板: 本地框架含 SGLang", settings.indexOf('value="sglang"') >= 0, "");
  h.expect("p18 面板: SGLang 不在云端预设里", settings.indexOf('value="sdlang"') < 0, "");
  h.expect("p18 面板: 本地分组默认收起", settings.indexOf('id="aiLocalGroup" style="display:none"') >= 0, "");
  var pai = readRel("gui/renderer/panel-ai.js");
  h.expect("p18 面板: panel-ai 不再有 sdlang 云端预设", /sdlang:\s*\{/.test(pai) === false, "");
  h.expect("p18 面板: 空地址预设不覆盖手填地址", pai.indexOf("if (preset.baseUrl)") >= 0, "");
  h.expect("p18 面板: currentProvider 默认云端", pai.indexOf('=== "local" ? "local" : "cloud"') >= 0, "");
  var pm = readRel("gui/renderer/panel-model.js");
  h.expect("p18 面板: 预设用卡片排版", pm.indexOf("model-card") >= 0 && pm.indexOf("data-apply-profile") >= 0, "");
  h.expect("p18 面板: 卡片带 provider 徽标", pm.indexOf("model-badge") >= 0, "");
  h.expect("p18 面板: 默认档案回填", pm.indexOf("defaultProfile") >= 0, "");
  var css = readRel("gui/renderer/style.css");
  h.expect("p18 面板: 卡片网格样式存在", css.indexOf(".model-card") >= 0 && css.indexOf("grid-template-columns") >= 0, "");
  var uibot = readRel("gui/renderer/ui-bot.js");
  var brainUi = readRel("gui/renderer/ui-bot-brain.js");
  h.expect("p18 面板: 卡片大脑默认 deepseek", brainUi.indexOf('"deepseek"') >= 0 && uibot.indexOf("uiBotBrain.build") >= 0, "");
}

// D. 兜底配置：ai-client 的 FALLBACK 也必须是云端。
function checkFallback(h) {
  var src = readRel("modules/ai-client.js");
  h.expect("p18 兜底: FALLBACK 不含 11434", src.indexOf("FALLBACK_CONFIG") >= 0 && src.indexOf('baseUrl: "http://127.0.0.1:11434/v1"') < 0, "");
  h.expect("p18 兜底: FALLBACK 指向云端", src.indexOf('baseUrl: "https://api.deepseek.com/v1"') >= 0, "");
  h.expect("p18 兜底: FALLBACK provider=cloud", src.indexOf('provider: "cloud"') >= 0, "");
}

function run(h) {
  var groups = [checkDefaults, checkNoProbe, checkUi, checkFallback];
  for (var i = 0; i < groups.length; i++) {
    try { groups[i](h); } catch (e) { h.expect("p18 组 " + (i + 1) + " 未抛错", false, String(e)); }
  }
  return Promise.resolve();
}

module.exports = { run: run };
