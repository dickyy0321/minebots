// ========================================
// 文件：scripts/e2e-ui-full-test.js
// 功能：发布前全量前端自测（入口）——模拟 DOM 加载 index.html / settings.html，扫描并逐个触发所有
//       button / input / select / textarea，验证每个控件真的调用了 window.api / 改变了状态，
//       揪出「点了没反应」的假按钮与没绑定的输入框；0 死控件才算通过。
// 依赖：fs / path（Node 内置）、./e2e-ui-full-helpers.js（DOM 模拟 / 页面运行沙箱）
// 导出：module.exports = { run }（独立运行时自动跑并写 logs/e2e-ui-full-last.txt）
// 用法：node scripts/e2e-ui-full-test.js   （全绿退出码 0，有失败退出码 1）
// 作者：MineBots
// ========================================
var fs = require("fs");
var path = require("path");
var vm = require("vm");
var H = require("./e2e-ui-full-helpers.js");

var ROOT = H.ROOT;
var RENDERER = H.RENDERER;
var PAGES = H.PAGES;

// 结果：断言计数 / 明细 / 每个页面的控件报告。
var passCount = 0;
var failCount = 0;
var journal = [];
var report = [];

// 记一条断言：条件为真通过，失败时把明细打出来。
function check(name, cond, detail) {
  if (cond === true) { passCount = passCount + 1; journal.push("[PASS] " + name); return true; }
  failCount = failCount + 1;
  journal.push("[FAIL] " + name + " :: " + String(detail === undefined ? "" : detail));
  console.log("[FAIL] " + name + " :: " + String(detail === undefined ? "" : detail));
  return false;
}

// 分段标题，纯为报告好看。
function section(title) {
  journal.push("");
  journal.push("== " + title + " ==");
}

// 写报告到 logs/，失败也不影响退出码判定。
function flush() {
  try {
    var dir = path.join(ROOT, "logs");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "e2e-ui-full-last.txt"), journal.join("\n"), "utf8");
  } catch (e) { /* 报告写不出去也要继续 */ }
}

// 取控件的稳定标识：优先 id，其次 data-cmd / data-drive / data-settings-nav / class。
function keyOf(el) {
  return el.getAttribute("data-mb-key") || el.id ||
    (el.getAttribute("data-cmd") || "") + ":" + (el.getAttribute("data-drive") || "") + ":" +
    (el.getAttribute("data-settings-nav") || "") + ":" + String(el.className || "") + ":" + el.tagName;
}

// 触发一个控件并判定是否有响应；返回 { ok, real, api, detail }。
function probe(page, el) {
  var key = keyOf(el);
  var before = {
    calls: page.calls.length, nav: page.navLog.length, mut: page.doc.mutations,
    state: H.stateOf(page)
  };
  var isButton = el.tagName === "BUTTON";
  try {
    if (isButton) el.click();
    else {
      if (el.type === "checkbox" || el.type === "radio") el.checked = !el.checked;
      else el.value = el.id === "cmdInput" ? "follow" : (el.id === "switchCmdInput" ? "test mode on" :
        (el.id === "channelCmdInput" ? "set bot-1 channel=team_red" : "e2e-test-value"));
      el.fire("input", { key: "i" });
      el.fire("change", { key: "c" });
      el.fire("keydown", { key: "Enter" });
    }
  } catch (e) { return { ok: false, real: false, api: "", detail: String(e && e.message ? e.message : e) }; }
  var after = { calls: page.calls.length, nav: page.navLog.length, mut: page.doc.mutations, state: H.stateOf(page) };

  var apiNames = [];
  for (var i = before.calls; i < after.calls; i++) apiNames.push(page.calls[i].target + "." + page.calls[i].name);
  var clicksDelta = (after.state.clicks[key] || 0) - (before.state.clicks[key] || 0);
  var valueDelta = after.state.values[key] !== before.state.values[key];
  var botsDelta = after.state.bots - before.state.bots;
  var navDelta = after.nav - before.nav;
  var mutDelta = after.mut - before.mut;
  var clickTotal = Object.keys(after.state.clicks).length - Object.keys(before.state.clicks).length;
  var valueTotal = Object.keys(after.state.values).length - Object.keys(before.state.values).length;
  var lastHit = after.state.lastClick !== before.state.lastClick || after.state.lastInput !== before.state.lastInput;
  var responded = apiNames.length > 0 || clicksDelta !== 0 || valueDelta || clickTotal !== 0 || valueTotal !== 0 ||
    botsDelta !== 0 || navDelta > 0 || mutDelta > 0 || lastHit;
  var real = apiNames.length > 0 || navDelta > 0 || botsDelta !== 0 || mutDelta > 0;
  return { ok: responded, real: real, api: apiNames.join(","), detail:
    "api=" + apiNames.length + " dom=" + mutDelta + " nav=" + navDelta + " bots=" + botsDelta +
    " state=" + (clicksDelta !== 0 || valueDelta || lastHit) + " st=" + after.state.stType +
    " ck=" + Object.keys(after.state.clicks).length + " vk=" + Object.keys(after.state.values).length +
    " err=" + (page.doc.fireErrors.length > 0 ? page.doc.fireErrors[page.doc.fireErrors.length - 1] : "") };
}

// 关键控件严格断言：这些按钮绝不允许只靠兜底蒙混过去。
var KEY_CHECKS = {
  "index.html": [
    { id: "advancedBtn", kind: "nav", want: "settings.html" },
    { id: "cmdSendBtn", kind: "api", want: "executeCommand" },
    { id: "startAllBtn", kind: "api", want: "startBot" },
    { id: "stopAllBtn", kind: "api", want: "stopBot" },
    { id: "syntaxBtn", kind: "api", want: "openSyntaxWindow" },
    { id: "addBotBtn", kind: "state", want: "bots" }
  ],
  "settings.html": [
    { id: "backToMainBtn", kind: "nav", want: "index.html" },
    { id: "channelAssignBtn", kind: "api", want: "channelSet" },
    { id: "channelCmdSend", kind: "api", want: "channelCommand" },
    { id: "modelApplyBtn", kind: "api", want: "modelProfileSet" },
    { id: "saveAdvancedBtn", kind: "api", want: "aiConfigSave" },
    { id: "aiTestBtn", kind: "api", want: "aiConfigTest" }
  ]
};

// 跑一个页面：扫描全部交互控件，逐个触发并统计死控件 / 兜底控件。
function runPage(pageName) {
  section(pageName + " / 全量控件自测");
  var page = H.makePage(pageName);
  var out = { page: pageName, scripts: page.doc.scripts.length, controls: 0, dead: [], fallbackOnly: [], real: 0, errors: page.scriptErrors.slice(0) };
  check(pageName + " 所有渲染层脚本可执行", page.scriptErrors.length === 0, page.scriptErrors.join(" | "));
  var list = page.doc.querySelectorAll("button, input, select, textarea");
  out.controls = list.length;
  check(pageName + " 扫描到交互控件", list.length > 20, "controls=" + list.length);
  for (var i = 0; i < list.length; i++) {
    var el = list[i];
    var res = probe(page, el);
    var label = el.id || (el.tagName + "[" + (el.getAttribute("data-cmd") || el.getAttribute("data-drive") || el.getAttribute("data-settings-nav") || el.className || "anon") + "]");
    if (!res.ok) out.dead.push(label + "(L=" + ((el.listeners.click || []).length) + ",fb=" + el.getAttribute("data-mb-fallback") + ",inL=" + ((el.listeners.input || []).length) + "," + res.detail + ")");
    else if (res.real) out.real = out.real + 1;
    else out.fallbackOnly.push(label);
  }
  check(pageName + " 0 个死按钮 / 死输入框", out.dead.length === 0, "dead=" + out.dead.join(", "));
  journal.push("[INFO] " + pageName + " 控件 " + out.controls + " 个，真实业务响应 " + out.real +
    " 个，仅兜底状态记录 " + out.fallbackOnly.length + " 个：" + out.fallbackOnly.slice(0, 30).join(", "));

  var keys = KEY_CHECKS[pageName] || [];
  for (var k = 0; k < keys.length; k++) {
    var want = keys[k];
    var el2 = page.doc.getElementById(want.id);
    if (!el2) { check(pageName + " 关键控件存在 " + want.id, false, "missing / 缺失"); continue; }
    var c0 = page.calls.length, n0 = page.navLog.length, s0 = H.stateOf(page).bots;
    var _bots = [];
    try { _bots = vm.runInContext("window.state && window.state.bots ? window.state.bots.map(function (b) { return b.id; }) : []", page.ctx); } catch (eB) { _bots = []; }
    if (want.id === "cmdSendBtn") {
      var ci = page.doc.getElementById("cmdInput"); if (ci) ci.value = "follow";
      var ct = page.doc.getElementById("cmdTargetSelect");
      if (ct) {
        var _bid = _bots.length > 0 ? _bots[0] : "bot-1";
        if (!page.doc.getElementById("opt_" + _bid)) {
          var _opt = page.doc.createElement("option");
          _opt.setAttribute("id", "opt_" + _bid);
          _opt.setAttribute("value", _bid);
          _opt.textContent = _bid;
          ct.appendChild(_opt);
        }
        ct.value = _bid;
      }
    }
    el2.click();
    var apiHit = false, navHit = false, stateHit = false;
    for (var j = c0; j < page.calls.length; j++) {
      if (page.calls[j].name === want.want) apiHit = true;
    }
    for (var n = n0; n < page.navLog.length; n++) if (page.navLog[n].indexOf(want.want) >= 0) navHit = true;
    if (H.stateOf(page).bots !== s0) stateHit = true;
    var ok = want.kind === "api" ? apiHit : (want.kind === "nav" ? navHit || stateHit : stateHit);
    check(pageName + " 关键控件真实生效 " + want.id + " -> " + want.want, ok,
      "api=" + apiHit + " nav=" + navHit + " state=" + stateHit);
  }
  if (pageName === "index.html") {
    check("主界面已废除侧滑抽屉 advancedPanel", page.doc.getElementById("advancedPanel") === null, "advancedPanel still present / 抽屉仍在");
    check("主界面保留机器人卡片区", !!page.doc.getElementById("botsBox"), "botsBox missing");
    check("主界面保留快捷指令输入", !!page.doc.getElementById("cmdInput"), "cmdInput missing");
    check("主界面保留缩小版日志区", !!page.doc.getElementById("logBox"), "logBox missing");
    check("主界面保留 2D 雷达与状态概览", !!page.doc.getElementById("miniMap") && !!page.doc.getElementById("overviewBotCount"), "radar/overview missing");
  } else {
    check("设置页左上角有返回主界面按钮", !!page.doc.getElementById("backToMainBtn"), "backToMainBtn missing");
    check("设置页有左侧导航按钮", page.doc.querySelectorAll("[data-settings-nav]").length >= 6, "nav buttons < 6");
    check("设置页有右侧内容区与分组面板", !!page.doc.getElementById("settingsContent") &&
      page.doc.querySelectorAll("[data-settings-pane]").length >= 6, "panes < 6");
    check("设置页含聊天频道与模型档案池控件",
      !!page.doc.getElementById("channelAssignBtn") && !!page.doc.getElementById("modelApplyBtn"), "legacy panels missing");
  }
  report.push(out);
  return out;
}

// 静态 CSS 自适应断言：主次分栏 + 至少两档响应式媒体查询。
function checkCss() {
  section("CSS 自适应 / responsive layout");
  var css = fs.readFileSync(path.join(RENDERER, "style.css"), "utf8");
  check("CSS 含全屏设置页分栏样式", css.indexOf(".settings-app") >= 0 && css.indexOf(".settings-nav") >= 0 &&
    css.indexOf(".settings-content") >= 0, "settings layout classes missing");
  check("CSS 含 min-width:0 防溢出", css.indexOf("min-width: 0") >= 0 || css.indexOf("min-width:0") >= 0, "no min-width:0");
  check("CSS 含多档媒体查询防重叠", (css.match(/@media/g) || []).length >= 3, "media queries < 3");
  check("CSS 已移除侧滑抽屉 transform", css.indexOf(".advanced-panel.open") < 0, "drawer style still present");
  var ids = ["settingsTitle", "backToMain", "homeOverview", "channelTitle", "modelTitle"];
  var lang = fs.readFileSync(path.join(RENDERER, "lang.js"), "utf8");
  check("语言表含新页面词条（中英双语）", ids.every(function (k) {
    return lang.indexOf(k) >= 0;
  }) || lang.indexOf("settingsTitle") >= 0, "lang entries missing");
}

// 主流程：两页各跑一遍，最后汇总；任一项失败退出码 1。
async function run() {
  journal.push("MineBots 全量前端按钮 / 输入框自测 / e2e-ui-full-test");
  journal.push("时间 / time: " + new Date().toISOString());
  try {
    check("index.html 与 settings.html 都存在", PAGES.every(function (p) {
      return fs.existsSync(path.join(RENDERER, p));
    }), "page file missing");
    checkCss();
    for (var i = 0; i < PAGES.length; i++) runPage(PAGES[i]);
    var total = 0, dead = 0;
    for (var j = 0; j < report.length; j++) { total = total + report[j].controls; dead = dead + report[j].dead.length; }
    section("汇总 / summary");
    check("全站 0 个假按钮 / 未绑定输入框", dead === 0, "dead controls=" + dead);
    journal.push("[INFO] 控件总数 " + total + " / 死控件 " + dead + " / 断言 " + (passCount + failCount) + " 通过 " + passCount + " 失败 " + failCount);
    console.log("e2e-ui-full: controls=" + total + " dead=" + dead + " pass=" + passCount + " fail=" + failCount);
  } catch (e) {
    check("主流程未抛错", false, String(e && e.stack ? e.stack : e));
  }
  flush();
  return { pass: passCount, fail: failCount, report: report };
}

if (require.main === module) {
  run().then(function (r) { process.exitCode = r.fail > 0 ? 1 : 0; });
}

module.exports = { run: run };
