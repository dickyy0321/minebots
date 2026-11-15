// ========================================
// 文件：scripts/selftest-p21.js
// 功能：本地标签（实例）——一个标签 = 框架+模型+参数 / 多标签同时运行 / 端口冲突拦截 / 删除保护 / 按标签绑定到 Bot
// 依赖：fs / path / os（Node 内置）、../modules/local-runtime、../modules/model-profile、../modules/ai-client
// 导出：run(h)
// 说明：全部断言走真实模块与临时 state（MINEBOTS_STATE_DIR）；启动的进程是本机 node 空转，测完立刻回收，不联网。
// 作者：MineBots
// ========================================
var fs = require("fs");
var path = require("path");
var os = require("os");

var ROOT = path.resolve(__dirname, "..");

function readRel(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch (e) { return ""; }
}
function lines(rel) {
  try { return readRel(rel).split(/\r?\n/).length; } catch (e) { return 0; }
}

function run(h) {
  var oldDir = process.env.MINEBOTS_STATE_DIR;
  var tmp = path.join(os.tmpdir(), "minebots-p21-" + process.pid + "-" + Date.now());
  try { fs.mkdirSync(tmp, { recursive: true }); } catch (eMk) { /* 建不了也继续 */ }
  process.env.MINEBOTS_STATE_DIR = tmp;

  var rt = null, mp = null, ai = null;
  try { rt = require("../modules/local-runtime"); } catch (e1) { rt = null; }
  try { mp = require("../modules/model-profile"); } catch (e2) { mp = null; }
  try { ai = require("../modules/ai-client"); } catch (e3) { ai = null; }

  h.expect("p21 模块: local-runtime / model-profile / ai-client 可加载", !!(rt && mp && ai), JSON.stringify([!!rt, !!mp, !!ai]));
  h.expect("p21 模块: 标签接口齐全",
    !!(rt && typeof rt.listInstances === "function" && typeof rt.createInstance === "function" && typeof rt.removeInstance === "function"), "");

  var started = [];
  var stopAll = function () {
    for (var i = 0; i < started.length; i++) {
      try { rt.stop(started[i]); } catch (eS) { /* ignore */ }
    }
    started = [];
  };

  try {
    // A. 默认种子：每个框架一个标签，端口各不相同。
    var seed = rt.listInstances();
    h.expect("p21 种子: 5 个默认标签", !!(seed.ok && seed.items.length === 5), JSON.stringify(seed.items && seed.items.length));
    var fws = {};
    for (var i = 0; i < seed.items.length; i++) fws[seed.items[i].framework] = seed.items[i].port;
    h.expect("p21 种子: 覆盖 ollama/lmstudio/llamacpp/sglang/custom",
      !!(fws.ollama === 11434 && fws.lmstudio === 1234 && fws.llamacpp === 8080 && fws.sglang === 30000 && fws.custom === 8000), JSON.stringify(fws));
    h.expect("p21 种子: 每个标签带默认参数",
      seed.items[0].temperature === 0.7 && seed.items[0].topP === 0.9 && seed.items[0].maxTokens === 256, JSON.stringify(seed.items[0]));

    // B. 新建标签：同框架可建多个，端口自动避重，ID 不重复。
    var c1 = rt.createInstance({ framework: "sglang", label: "SGLang 大模型" });
    h.expect("p21 新建: sglang-1 建成功", !!(c1.ok && c1.item.id === "sglang-1"), JSON.stringify(c1.item && c1.item.id));
    h.expect("p21 新建: 端口自动避开 30000", !!(c1.item && c1.item.port === 30001), String(c1.item && c1.item.port));
    var c2 = rt.createInstance({ framework: "sglang" });
    h.expect("p21 新建: sglang-2 端口继续递增", !!(c2.ok && c2.item.id === "sglang-2" && c2.item.port === 30002), JSON.stringify([c2.item && c2.item.id, c2.item && c2.item.port]));
    h.expect("p21 新建: 标签总数 7", rt.listInstances().items.length === 7, String(rt.listInstances().items.length));

    // C. 参数按标签隔离：改 sglang-1 不影响 sglang-2 / ollama。
    var s1 = rt.saveConfig("sglang-1", { model: "Qwen/Qwen3-8B", temperature: 0.2, topP: 0.5, maxTokens: 1024 });
    h.expect("p21 参数: 保存成功", !!(s1.ok && s1.config.temperature === 0.2 && s1.config.topP === 0.5 && s1.config.maxTokens === 1024), JSON.stringify(s1.config && [s1.config.temperature, s1.config.topP, s1.config.maxTokens]));
    var s2 = rt.getConfig("sglang-2").config;
    var so = rt.getConfig("ollama").config;
    h.expect("p21 参数: sglang-2 不受影响", s2.temperature === 0.7 && s2.maxTokens === 256, JSON.stringify([s2.temperature, s2.maxTokens]));
    h.expect("p21 参数: ollama 不受影响", so.temperature === 0.7 && so.model === "", JSON.stringify([so.temperature, so.model]));
    h.expect("p21 参数: temperature 越界被夹住", rt.saveConfig("sglang-1", { temperature: 9 }).config.temperature === 2, "");
    var beforeMt = rt.getConfig("sglang-1").config.maxTokens;
    h.expect("p21 参数: maxTokens 非法保持原值", rt.saveConfig("sglang-1", { maxTokens: "abc" }).config.maxTokens === beforeMt, String(beforeMt));
    rt.saveConfig("sglang-1", { temperature: 0.2, topP: 0.5, maxTokens: 1024 });

    // D. 多标签同时运行：两个自定义标签各跑一个 node 空转，端口不同，互不影响。
    var exe = process.execPath;
    var args = "-e \"setInterval(function(){},1000)\"";
    var d1 = rt.createInstance({ framework: "custom", label: "空转 A", port: 18101 });
    var d2 = rt.createInstance({ framework: "custom", label: "空转 B", port: 18102 });
    h.expect("p21 运行: 两个自定义标签就绪", !!(d1.ok && d2.ok), JSON.stringify([d1.item && d1.item.id, d2.item && d2.item.id]));
    rt.saveConfig(d1.item.id, { exePath: exe, extraArgs: args, model: "demo-a" });
    rt.saveConfig(d2.item.id, { exePath: exe, extraArgs: args, model: "demo-b" });
    var r1 = rt.start(d1.item.id);
    var r2 = rt.start(d2.item.id);
    started.push(d1.item.id, d2.item.id);
    h.expect("p21 运行: 两个标签都启动成功", !!(r1.ok && r2.ok), JSON.stringify([r1.message, r2.message]));
    h.expect("p21 运行: 两个进程端口不同", r1.port === 18101 && r2.port === 18102, JSON.stringify([r1.port, r2.port]));
    var st = rt.getState();
    h.expect("p21 运行: 同时在跑 2 个", st.count === 2 && !!st.running[d1.item.id] && !!st.running[d2.item.id], JSON.stringify(st.running));
    h.expect("p21 运行: 运行中的标签不能改端口", rt.saveConfig(d1.item.id, { port: 18103 }).ok === false, "");
    h.expect("p21 运行: 运行中的标签不能删", rt.removeInstance(d1.item.id).ok === false, "");

    // E. 端口冲突：第二个标签撞同一端口必须被挡住。
    var d3 = rt.createInstance({ framework: "custom", label: "撞端口", port: 18101 });
    rt.saveConfig(d3.item.id, { exePath: exe, extraArgs: args });
    var r3 = rt.start(d3.item.id);
    h.expect("p21 冲突: 同端口被拒绝", !!(r3.ok === false && r3.portBusy === true), JSON.stringify(r3.message));

    // F. 停止后可以改端口 / 删除。
    var stop1 = rt.stop(d1.item.id);
    h.expect("p21 停止: 停止成功", !!stop1.ok, JSON.stringify(stop1.message));
    h.expect("p21 停止: 剩余 1 个在跑", rt.getState().count === 1, JSON.stringify(rt.getState().running));
    h.expect("p21 停止: 停止后能改端口", rt.saveConfig(d1.item.id, { port: 18103 }).ok === true, "");
    h.expect("p21 停止: 停止后能删除", rt.removeInstance(d3.item.id).ok === true, "");
    stopAll();

    // G. 按标签绑定到 Bot：两个 Bot 各用一个标签（框架 / 地址 / 模型 / 参数全独立）。
    mp.reset();
    var b1 = mp.bind("bot-1", { instanceId: "sglang-1", engine: "sglang", model: "Qwen/Qwen3-8B", baseUrl: rt.getConfig("sglang-1").config.baseUrl, port: 30001, temperature: 0.2, topP: 0.5, maxTokens: 1024 });
    var b2 = mp.bind("bot-2", { instanceId: "ollama", engine: "ollama", model: "phi", baseUrl: rt.getConfig("ollama").config.baseUrl, port: 11434, temperature: 1.2, topP: 0.95, maxTokens: 256 });
    h.expect("p21 绑定: 两个 Bot 绑定成功", !!(b1.ok && b2.ok), JSON.stringify([b1.message, b2.message]));
    h.expect("p21 绑定: instanceId 落库", !!(mp.bindingOf("bot-1").instanceId === "sglang-1" && mp.bindingOf("bot-2").instanceId === "ollama"), JSON.stringify(mp.listBindings()));
    var g1 = ai.getConfig("bot-1");
    var g2 = ai.getConfig("bot-2");
    h.expect("p21 绑定: bot-1 走 sglang-1 的地址", String(g1.baseUrl).indexOf("30001") >= 0 && g1.model === "Qwen/Qwen3-8B", JSON.stringify([g1.baseUrl, g1.model]));
    h.expect("p21 绑定: bot-2 走 ollama 的地址", String(g2.baseUrl).indexOf("11434") >= 0 && g2.model === "phi", JSON.stringify([g2.baseUrl, g2.model]));
    h.expect("p21 绑定: 参数各自生效", g1.temperature === 0.2 && g2.temperature === 1.2 && g1.maxTokens === 1024, JSON.stringify([g1.temperature, g2.temperature, g1.maxTokens]));
    h.expect("p21 绑定: 两个 Bot 的模型不串", g1.model !== g2.model, g1.model + " / " + g2.model);

    // H. 接线：标签条 / 参数输入 / IPC / 卡片来源。
    var settings = readRel("gui/renderer/settings.html");
    var panelLocal = readRel("gui/renderer/panel-local.js");
    var brain = readRel("gui/renderer/ui-bot-brain.js");
    var ipcLocal = readRel("gui/ipc-local.js");
    var preload = readRel("gui/preload.js");
    var api = readRel("gui/renderer/api.js");
    h.expect("p21 界面: 设置页有标签条与新建/删除", settings.indexOf('id="localTabs"') >= 0 && settings.indexOf('id="localNewBtn"') >= 0 && settings.indexOf('id="localRemoveBtn"') >= 0, "");
    h.expect("p21 界面: 设置页有参数输入", settings.indexOf('id="localTempInput"') >= 0 && settings.indexOf('id="localTopPInput"') >= 0 && settings.indexOf('id="localMaxTokensInput"') >= 0, "");
    h.expect("p21 界面: 面板能渲染标签", panelLocal.indexOf("renderTabs:") >= 0 && panelLocal.indexOf("local-tab") >= 0, "");
    h.expect("p21 界面: 面板能新建/删除标签", panelLocal.indexOf("create:") >= 0 && panelLocal.indexOf("remove:") >= 0, "");
    h.expect("p21 界面: 卡片按标签选来源", brain.indexOf("applyInstances") >= 0 && brain.indexOf("instanceId") >= 0, "");
    h.expect("p21 接线: IPC 有标签通道", ipcLocal.indexOf('"local-instance-create"') >= 0 && ipcLocal.indexOf('"local-instances"') >= 0, "");
    h.expect("p21 接线: preload / api 暴露标签接口", preload.indexOf("localInstanceCreate") >= 0 && api.indexOf("localInstanceCreate") >= 0, "");
  } catch (e4) {
    stopAll();
    h.expect("p21 未抛错", false, String(e4));
  }

  // 收尾：回收进程 + 恢复环境变量 + 清临时目录。
  stopAll();
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
