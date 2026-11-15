// ========================================
// 文件：scripts/selftest-p20.js
// 功能：本地配置与按 Bot 绑定模型——多框架独立配置 / 模型导入删除 / 每个 Bot 各用不同框架的不同模型 / 接线
// 依赖：fs / path / os（Node 内置）、../modules/local-runtime、../modules/model-profile
// 导出：run(h)
// 说明：全部断言走真实模块与临时 state（MINEBOTS_STATE_DIR），不联网、不启动任何推理框架、不碰真实 state/。
// 作者：MineBots
// ========================================
var fs = require("fs");
var path = require("path");
var os = require("os");

var ROOT = path.resolve(__dirname, "..");

function readRel(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch (e) { return ""; }
}

function count(text, needle) {
  try {
    var n = 0, i = 0;
    while (true) {
      var at = text.indexOf(needle, i);
      if (at < 0) break;
      n = n + 1;
      i = at + needle.length;
    }
    return n;
  } catch (e) { return 0; }
}

function lines(rel) {
  try { return readRel(rel).split(/\r?\n/).length; } catch (e) { return 0; }
}

function run(h) {
  var oldDir = process.env.MINEBOTS_STATE_DIR;
  var tmp = path.join(os.tmpdir(), "minebots-p20-" + process.pid + "-" + Date.now());
  try { fs.mkdirSync(tmp, { recursive: true }); } catch (eMk) { /* 建不了也继续，reset 会兜底 */ }
  process.env.MINEBOTS_STATE_DIR = tmp;

  var rt = null, mp = null;
  try { rt = require("../modules/local-runtime"); } catch (e1) { rt = null; }
  try { mp = require("../modules/model-profile"); } catch (e2) { mp = null; }

  h.expect("p20 模块: local-runtime 可加载", !!rt, "null");
  h.expect("p20 模块: model-profile 可加载", !!mp, "null");
  h.expect("p20 模块: 导出 importModel / removeModel", !!(rt && typeof rt.importModel === "function" && typeof rt.removeModel === "function"), "");
  h.expect("p20 模块: 导出 bind / unbind / bindingOf / listBindings",
    !!(mp && typeof mp.bind === "function" && typeof mp.unbind === "function" && typeof mp.bindingOf === "function" && typeof mp.listBindings === "function"), "");

  // A. 多框架独立配置：端口 / 模型 / 路径互不覆盖。
  try {
    h.expect("p20 配置: 框架清单含 ollama / sglang / llamacpp / lmstudio / custom",
      !!(rt && rt.FRAMEWORKS && rt.FRAMEWORKS.ollama && rt.FRAMEWORKS.sglang && rt.FRAMEWORKS.llamacpp && rt.FRAMEWORKS.lmstudio && rt.FRAMEWORKS.custom), "");
    var s1 = rt.saveConfig("ollama", { port: 11434, model: "phi", exePath: "C:/ollama/ollama.exe" });
    var s2 = rt.saveConfig("sglang", { port: 30000, model: "Qwen/Qwen3-8B", exePath: "C:/python/python.exe" });
    h.expect("p20 配置: Ollama 与 SGLang 都能保存", !!(s1 && s1.ok && s2 && s2.ok), JSON.stringify([s1 && s1.message, s2 && s2.message]));
    var c1 = rt.getConfig("ollama").config;
    var c2 = rt.getConfig("sglang").config;
    h.expect("p20 配置: 两个框架端口独立", c1.port === 11434 && c2.port === 30000, c1.port + " / " + c2.port);
    h.expect("p20 配置: 两个框架模型独立", c1.model === "phi" && c2.model === "Qwen/Qwen3-8B", c1.model + " / " + c2.model);
    h.expect("p20 配置: baseUrl 跟着各自端口", c1.baseUrl === "http://127.0.0.1:11434/v1" && c2.baseUrl === "http://127.0.0.1:30000/v1", c1.baseUrl + " / " + c2.baseUrl);
    h.expect("p20 配置: 程序路径独立", c1.exePath.indexOf("ollama") >= 0 && c2.exePath.indexOf("python") >= 0, c1.exePath + " / " + c2.exePath);
  } catch (e3) { h.expect("p20 配置: 未抛错", false, String(e3)); }

  // B. 模型库：导入 / 去重 / 移除，只影响当前框架。
  try {
    var i1 = rt.importModel("sglang", "meta-llama/Llama-3.1-8B");
    h.expect("p20 模型: 导入成功且进入清单", !!(i1 && i1.ok && i1.models && i1.models.indexOf("meta-llama/Llama-3.1-8B") >= 0), JSON.stringify(i1 && i1.models));
    h.expect("p20 模型: 导入后设为启动模型", rt.getConfig("sglang").config.model === "meta-llama/Llama-3.1-8B", rt.getConfig("sglang").config.model);
    var i2 = rt.importModel("sglang", "META-LLAMA/llama-3.1-8b");
    h.expect("p20 模型: 同名不区分大小写去重", !!(i2 && i2.models && i2.models.length === 1), JSON.stringify(i2 && i2.models));
    h.expect("p20 模型: 不影响其它框架", rt.getConfig("ollama").config.models.length === 0, JSON.stringify(rt.getConfig("ollama").config.models));
    var r1 = rt.removeModel("sglang", "meta-llama/Llama-3.1-8B");
    h.expect("p20 模型: 移除成功", !!(r1 && r1.ok && r1.models.length === 0), JSON.stringify(r1 && r1.models));
    var i3 = rt.importModel("sglang", "");
    h.expect("p20 模型: 空模型名被拒绝", !!(i3 && i3.ok === false), JSON.stringify(i3 && i3.message));
    var i4 = rt.importModel("nope", "x");
    h.expect("p20 模型: 未知框架被拒绝", !!(i4 && i4.ok === false), JSON.stringify(i4 && i4.message));
  } catch (e4) { h.expect("p20 模型: 未抛错", false, String(e4)); }

  // C. 每个 Bot 各用不同框架的不同模型（核心需求）。
  try {
    mp.reset();
    var b1 = mp.bind("bot-1", { engine: "ollama", model: "phi", baseUrl: "http://127.0.0.1:11434/v1", port: 11434 });
    var b2 = mp.bind("bot-2", { engine: "sglang", model: "Qwen/Qwen3-8B", baseUrl: "http://127.0.0.1:30000/v1", port: 30000 });
    h.expect("p20 绑定: 两个 Bot 都绑定成功", !!(b1 && b1.ok && b2 && b2.ok), JSON.stringify([b1 && b1.message, b2 && b2.message]));
    var g1 = mp.configFor("bot-1");
    var g2 = mp.configFor("bot-2");
    h.expect("p20 绑定: bot-1 用 Ollama 的 phi", g1.engine === "ollama" && g1.model === "phi" && g1.baseUrl.indexOf("11434") >= 0, JSON.stringify([g1.engine, g1.model, g1.baseUrl]));
    h.expect("p20 绑定: bot-2 用 SGLang 的 Qwen", g2.engine === "sglang" && g2.model === "Qwen/Qwen3-8B" && g2.baseUrl.indexOf("30000") >= 0, JSON.stringify([g2.engine, g2.model, g2.baseUrl]));
    h.expect("p20 绑定: 两个 Bot 互不串台", g1.model !== g2.model && g1.baseUrl !== g2.baseUrl, g1.model + " vs " + g2.model);
    h.expect("p20 绑定: 本地框架 provider=local", g1.provider === "local" && g2.provider === "local", g1.provider + " / " + g2.provider);
    h.expect("p20 绑定: 标记 binding=true", g1.binding === true && g2.binding === true, "");
    var g3 = mp.configFor("bot-3");
    h.expect("p20 绑定: 未绑定的 Bot 走默认档案", g3.model === "deepseek-chat" && !g3.binding, g3.model);

    var bindFile = path.join(tmp, "model-bindings.json");
    h.expect("p20 绑定: 落盘到 model-bindings.json", fs.existsSync(bindFile), bindFile);
    var saved = {};
    try { saved = JSON.parse(fs.readFileSync(bindFile, "utf8")); } catch (eP) { saved = {}; }
    h.expect("p20 绑定: 文件里有两个 Bot", !!(saved["bot-1"] && saved["bot-2"] && saved["bot-1"].engine === "ollama" && saved["bot-2"].engine === "sglang"), JSON.stringify(Object.keys(saved)));

    h.expect("p20 绑定: 解绑成功", !!mp.unbind("bot-2").ok, "");
    h.expect("p20 绑定: 解绑后回到默认档案", mp.configFor("bot-2").model === "deepseek-chat", mp.configFor("bot-2").model);
    h.expect("p20 绑定: 解绑只影响自己", mp.configFor("bot-1").model === "phi", mp.configFor("bot-1").model);
    h.expect("p20 绑定: 解绑不存在的 Bot 返回失败", mp.unbind("bot-404").ok === false, "");
    h.expect("p20 绑定: 统计里有 bindings 计数", mp.stats().bindings === 1, JSON.stringify(mp.stats().bindings));

    // 真正在用的链路：ai-client.getConfig 必须拿到各自绑定的地址与模型（两个 Bot 各走各的端点）。
    var ai = null;
    try { ai = require("../modules/ai-client"); } catch (eAi) { ai = null; }
    h.expect("p20 绑定: ai-client 暴露 getConfig", !!(ai && typeof ai.getConfig === "function"), "null");
    if (ai && typeof ai.getConfig === "function") {
      // 重新绑一遍（上一段已解绑 bot-2），再看 ai-client 读到的值。
      mp.bind("bot-2", { engine: "sglang", model: "Qwen/Qwen3-8B", baseUrl: "http://127.0.0.1:30000/v1", port: 30000 });
      var a1 = ai.getConfig("bot-1");
      var a2 = ai.getConfig("bot-2");
      h.expect("p20 绑定: ai-client 读到 bot-1 的地址", String(a1.baseUrl).indexOf("11434") >= 0, a1.baseUrl);
      h.expect("p20 绑定: ai-client 读到 bot-2 的地址", String(a2.baseUrl).indexOf("30000") >= 0, a2.baseUrl);
      h.expect("p20 绑定: ai-client 读到各自模型", a1.model === "phi" && a2.model === "Qwen/Qwen3-8B", a1.model + " / " + a2.model);
      var a3 = ai.getConfig("bot-nobody");
      h.expect("p20 绑定: 未绑定的 Bot 仍走云端默认", String(a3.baseUrl).indexOf("api.deepseek.com") >= 0, a3.baseUrl);
    }
  } catch (e5) { h.expect("p20 绑定: 未抛错", false, String(e5)); }

  // D. 脏数据防线：非法引擎/地址一律洗净，绝不写进配置。
  try {
    var bad = mp.bind("bot-evil", { engine: "../etc/passwd", model: "x", baseUrl: "javascript:alert(1)", port: "abc" });
    h.expect("p20 安全: 非法引擎回退 custom", !!(bad && bad.ok && bad.binding.engine === "custom"), JSON.stringify(bad && bad.binding));
    h.expect("p20 安全: 非 http 地址被丢弃", bad && bad.binding.baseUrl === "", JSON.stringify(bad && bad.binding));
    h.expect("p20 安全: 非法端口归零", bad && bad.binding.port === 0, JSON.stringify(bad && bad.binding));
    h.expect("p20 安全: 空 botId 被拒绝", mp.bind("", { engine: "ollama" }).ok === false, "");
    var plain = mp.applyTo("bot-clean", { model: "base", baseUrl: "https://x/v1" });
    h.expect("p20 安全: 未绑定不改原配置", plain.model === "base" && plain.baseUrl === "https://x/v1" && !plain.binding, JSON.stringify(plain));
    mp.reset();
    h.expect("p20 安全: reset 清空绑定文件", !fs.existsSync(path.join(tmp, "model-bindings.json")), "");
  } catch (e6) { h.expect("p20 安全: 未抛错", false, String(e6)); }

  // E. 接线：IPC 三件套 + 界面控件 + 脚本引用。
  try {
    var preload = readRel("gui/preload.js");
    var api = readRel("gui/renderer/api.js");
    var ipcLocal = readRel("gui/ipc-local.js");
    var ipcExtra = readRel("gui/ipc-extra.js");
    var brain = readRel("gui/renderer/ui-bot-brain.js");
    var uiBot = readRel("gui/renderer/ui-bot.js");
    var settings = readRel("gui/renderer/settings.html");
    var index = readRel("gui/renderer/index.html");
    var lang = readRel("gui/renderer/lang.js");
    var install = readRel("gui/renderer/panel-install.js");
    var panelLocal = readRel("gui/renderer/panel-local.js");

    h.expect("p20 接线: preload 有 local-model-import", preload.indexOf('"local-model-import"') >= 0, "");
    h.expect("p20 接线: preload 有 model-profile-bind", preload.indexOf('"model-profile-bind"') >= 0, "");
    h.expect("p20 接线: api 暴露 localModelImport", api.indexOf("localModelImport:") >= 0, "");
    h.expect("p20 接线: api 暴露 modelProfileBind", api.indexOf("modelProfileBind:") >= 0, "");
    h.expect("p20 接线: ipc-local 注册 importModel", ipcLocal.indexOf("runtime.importModel") >= 0, "");
    h.expect("p20 接线: ipc-local 注册 removeModel", ipcLocal.indexOf("runtime.removeModel") >= 0, "");
    h.expect("p20 接线: ipc-extra 处理 bind", ipcExtra.indexOf('handleModel("bind"') >= 0, "");
    h.expect("p20 接线: ipc-extra 回包带 bindings", ipcExtra.indexOf("listBindings()") >= 0, "");

    h.expect("p20 界面: 卡片用 uiBotBrain.build", uiBot.indexOf("uiBotBrain.build") >= 0, "");
    h.expect("p20 界面: 双下拉标记齐全", brain.indexOf("data-brain-for") >= 0 && brain.indexOf("data-model-for") >= 0, "");
    h.expect("p20 界面: 选模型走 modelProfileBind", brain.indexOf("modelProfileBind") >= 0, "");
    h.expect("p20 界面: 换框架先解绑", brain.indexOf("modelProfileUnbind") >= 0, "");
    h.expect("p20 界面: index 先加载 ui-bot-brain 再加载 ui-bot",
      index.indexOf("ui-bot-brain.js") >= 0 && index.indexOf("ui-bot-brain.js") < index.indexOf("ui-bot.js"), "");
    h.expect("p20 界面: 设置页叫「本地配置」", settings.indexOf('data-i18n="localConfigTitle"') >= 0, "");
    h.expect("p20 界面: 设置页不再写「仅 Ollama」", settings.indexOf("仅 Ollama") < 0, "");
    h.expect("p20 界面: 本地框架含 SGLang", settings.indexOf('value="sglang"') >= 0, "");
    h.expect("p20 界面: 本地配置有导入模型按钮", settings.indexOf("localImportBtn") >= 0 && settings.indexOf("localUseModelBtn") >= 0, "");
    h.expect("p20 界面: 模型库标题中英都有", count(lang, "modelLibraryTitle") >= 2, String(count(lang, "modelLibraryTitle")));
    h.expect("p20 界面: 本地配置标题中英都有", count(lang, "localConfigTitle") >= 2, String(count(lang, "localConfigTitle")));
    h.expect("p20 界面: 模型库按当前框架刷新", install.indexOf("localModels") >= 0, "");
    h.expect("p20 界面: 非 Ollama 走导入", install.indexOf("localModelImport") >= 0, "");
    h.expect("p20 界面: 本地面板能导入/设为当前模型", panelLocal.indexOf("importModel:") >= 0 && panelLocal.indexOf("useModel:") >= 0, "");
  } catch (e7) { h.expect("p20 接线: 未抛错", false, String(e7)); }

  // F. 行数红线（新增/改动的关键文件都必须在 600 行内）。
  try {
    var files = ["modules/local-runtime.js", "modules/model-profile.js", "gui/ipc-local.js", "gui/ipc-extra.js",
      "gui/preload.js", "gui/renderer/ui-bot-brain.js", "gui/renderer/ui-bot.js", "gui/renderer/panel-local.js",
      "gui/renderer/panel-install.js", "gui/renderer/api.js", "scripts/selftest-p20.js"];
    for (var i = 0; i < files.length; i++) {
      var n = lines(files[i]);
      h.expect("p20 行数: " + files[i] + " ≤ 600", n > 0 && n <= 600, String(n));
    }
  } catch (e8) { h.expect("p20 行数: 未抛错", false, String(e8)); }

  // G. i18n 完整性：两条 HTML 用到的 data-i18n 键，中英文案都必须存在（否则界面会显示成键名）。
  try {
    var langSrc = readRel("gui/renderer/lang.js");
    var htmls = ["gui/renderer/index.html", "gui/renderer/settings.html"];
    var miss = [];
    for (var f = 0; f < htmls.length; f++) {
      var src = readRel(htmls[f]);
      var re = /data-i18n(?:-ph)?="([^"]+)"/g;
      var m = null;
      while ((m = re.exec(src)) !== null) {
        var key = m[1];
        if (count(langSrc, key + ":") < 2 && miss.indexOf(key) < 0) miss.push(key);
      }
    }
    h.expect("p20 i18n: 所有 data-i18n 键中英齐全", miss.length === 0, miss.join(","));
  } catch (e9) { h.expect("p20 i18n: 未抛错", false, String(e9)); }

  // 收尾：恢复环境变量并清掉临时目录。
  try {
    if (oldDir === undefined) delete process.env.MINEBOTS_STATE_DIR;
    else process.env.MINEBOTS_STATE_DIR = oldDir;
    var names = fs.readdirSync(tmp);
    for (var j = 0; j < names.length; j++) {
      try { fs.unlinkSync(path.join(tmp, names[j])); } catch (eU) { /* ignore */ }
    }
    try { fs.rmdirSync(tmp); } catch (eR) { /* 非空就留着 */ }
  } catch (eC) { /* ignore */ }
}

module.exports = { run: run };
