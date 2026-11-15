// ========================================
// 文件：gui/renderer/panel-swarm.js
// 功能：状态机 3.0【蜂群控制台】——命令输入 / 三层状态 / 黑板生态 / 反射统计 / #help 指令清单
// 依赖：无（渲染层禁止 require；只用 window.api 与 document）
// 导出：window.panelSwarm = { init / build / send / refresh / render / stats }
// 作者：MineBots
// ========================================
//
// 真实链路 / real chain
//   panel-swarm → window.api.swarmConsole → preload → ipc-extra.handleSwarm →
//   modules/swarm-console → modules/swarm-command → state-runtime / shared-board / antiafk / replan。
//   刷新只拉快照，不下发动作；所有回包一律带 ok / message（中英双语）。
// CommonJS 无关（浏览器全局脚本），ES5 风格，无中文变量名；DOM 与 IPC 全部包 try/catch。

(function () {
  // 常量：默认 botId 与输入框占位文案（双语）。
  var DEFAULT_BOT = "bot-1";
  var PLACEHOLDER = "输入 #goal 挖矿 或 #help / type #goal mine or #help";

  // 状态：是否已构建 / 最后一次命令 / 最后一次回包是否成功 / 控件数。
  var built = false;
  var controls = 0;
  var lastCommand = "";
  var lastOk = null;
  var bound = false;

  // 内部：按 id 取元素，取不到返回 null。
  function byId(id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  }

  // 内部：建元素并挂 class / 属性；DOM 异常时返回 null。
  function el(tag, cls, attrs) {
    try {
      var node = document.createElement(tag);
      if (cls) node.className = cls;
      if (attrs) {
        for (var k in attrs) {
          if (Object.prototype.hasOwnProperty.call(attrs, k)) node.setAttribute(k, String(attrs[k]));
        }
      }
      return node;
    } catch (e) { return null; }
  }

  // 内部：安全转文本，null / undefined 统一成空串。
  function toText(value) {
    try { return value === null || value === undefined ? "" : String(value); } catch (e) { return ""; }
  }

  // 内部：写一行提示到结果区；ok=false 用告警色，异常时静默。
  function setResult(text, ok) {
    var box = byId("swarmResultBox");
    if (!box) return false;
    try {
      box.textContent = text;
      if (box.classList) {
        box.classList.remove("swarm-ok", "swarm-bad");
        box.classList.add(ok === false ? "swarm-bad" : "swarm-ok");
      }
      return true;
    } catch (e) { return false; }
  }

  // 内部：把对象压成短字符串，避免长 JSON 撑爆面板。
  function brief(value, limit) {
    try {
      var text = JSON.stringify(value === undefined ? null : value);
      if (text.length > limit) text = text.slice(0, limit) + "…";
      return text;
    } catch (e) { return "(不可序列化 / not serializable)"; }
  }

  // 内部：读当前 botId 输入框；空值退回默认。
  function botId() {
    try {
      var input = byId("swarmBotInput");
      var text = input && input.value ? String(input.value).replace(/^\s+|\s+$/g, "") : "";
      return text.length > 0 ? text : DEFAULT_BOT;
    } catch (e) { return DEFAULT_BOT; }
  }

  // 内部：判断 window.api 的控制台接口是否可用，不可用时写降级提示。
  function apiReady() {
    try { return !!(window.api && typeof window.api.swarmConsole === "function"); } catch (e) { return false; }
  }

  // 功能：发一条控制台请求（统一走 window.api），返回是否发出。
  function request(payload, label) {
    if (!apiReady()) {
      setResult("控制台通道未接线 / swarm console API unavailable", false);
      return false;
    }
    try {
      window.api.swarmConsole(payload);
      lastCommand = label;
      setResult("已发送 / sent: " + label, true);
      return true;
    } catch (e) {
      setResult("发送失败 / send failed: " + toText(e && e.message), false);
      return false;
    }
  }

  // 功能：发送输入框里的文本命令（#goal / #bid / #help …），返回是否发出。
  function send(text) {
    var line = toText(text);
    if (line.replace(/^\s+|\s+$/g, "").length === 0) line = "#status";
    var input = byId("swarmCmdInput");
    if (input && !text) line = toText(input.value).replace(/^\s+|\s+$/g, "") || "#status";
    return request({ botId: botId(), text: line }, line);
  }

  // 功能：只拉一次状态快照与指令清单，不下发任何动作。
  function refresh() {
    var id = botId();
    var ok1 = request({ botId: id, action: "status" }, "status");
    var ok2 = request({ botId: id, action: "commands" }, "commands");
    return ok1 && ok2;
  }

  // 内部：把三层状态压成双语摘要文本；字段缺失显示「-」。
  function statusText(data) {
    var lines = [];
    try {
      var s = data && typeof data === "object" ? data : {};
      var rt = s.status && typeof s.status === "object" ? s.status : s;
      var strategic = rt.strategic || s.strategic || null;
      var market = s.ecosystem || (rt.market && rt.market.ok !== false ? rt.market : null) || rt.market || null;
      var watchdog = s.watchdog || rt.watchdog || null;
      var reflex = s.reflex || rt.reflex || null;
      lines.push("目标 / goal      : " + (strategic && strategic.goal ? strategic.goal : "-"));
      lines.push("层 / layer       : " + (strategic && strategic.layer ? strategic.layer : "tactical"));
      lines.push("进度 / progress  : " + (strategic && strategic.progress ? strategic.progress.length : 0) +
        " 步 / steps · 受击 / hurts " + (strategic && strategic.hurts ? strategic.hurts : 0) +
        " · 恢复 / restores " + (strategic && strategic.restores ? strategic.restores : 0));
      lines.push("看门狗 / watchdog: 失败 / failures " + (watchdog ? watchdog.failures : 0) +
        " · 重规划 / replans " + (watchdog ? watchdog.replans : 0));
      lines.push("反射 / reflex    : 受击 / hurts " + (reflex ? reflex.hurts : 0) +
        " · AI 调用 / aiCalls " + (reflex ? reflex.aiCalls : 0) + "（恒为 0 / always 0）");
      lines.push("生态 / ecosystem : 需求 / demands " + (market ? market.demands : 0) +
        " · 供给 / supplies " + (market ? market.supplies : 0) +
        " · 待领 / pending " + (market ? market.pending : 0));
      lines.push("运行时 / runtimes: " + (s.bots ? s.bots.length : 0) + " 个 / bots");
    } catch (e) { lines.push("状态解析失败 / status parse failed: " + toText(e && e.message)); }
    return lines.join("\n");
  }

  // 内部：渲染指令清单（#help 回包在 data，commands 回包在 commands 字段）。
  function renderCommands(reply) {
    var box = byId("swarmCommandsBox");
    if (!box) return 0;
    try {
      var list = reply && reply.commands ? reply.commands : (reply && reply.data && reply.data.length ? reply.data : null);
      if (!list || !list.length) return 0;
      var lines = ["指令清单 / command list"];
      for (var i = 0; i < list.length; i++) {
        var one = list[i] || {};
        lines.push("#" + toText(one.usage || one.name) + " — " + toText(one.desc));
      }
      box.textContent = lines.join("\n");
      return list.length;
    } catch (e) { return 0; }
  }

  // 功能：处理主进程回包——刷新状态区、写结果行、必要时渲染指令清单。
  function render(reply) {
    var data = reply && typeof reply === "object" ? reply : {};
    lastOk = data.ok !== false;
    try {
      var box = byId("swarmStatusBox");
      if (box && (data.status || data.ecosystem || data.strategic || data.ok !== false)) {
        box.textContent = statusText(data);
      }
      if (data.commands || (data.command === "help" && data.data)) renderCommands(data);
      var label = data.command ? data.command : (data.commands ? "commands" : "status");
      var text = "[" + (lastOk ? "OK" : "FAIL") + "] " + label + " — " + toText(data.message || data.hint || "");
      if (data.data && data.command) text = text + "\n" + brief(data.data, 360);
      setResult(text, lastOk);
      return { ok: lastOk, command: label, message: data.message || "" };
    } catch (e) {
      setResult("回包解析失败 / reply parse failed: " + toText(e && e.message), false);
      return { ok: false, command: "", message: "" };
    }
  }

  // 内部：绑定按钮 / 回车 / 主进程回包，用 bound 保证幂等。
  function bind() {
    if (bound) return true;
    try {
      var sendBtn = byId("swarmSendBtn");
      if (sendBtn) sendBtn.addEventListener("click", function () { send(""); });
      var refreshBtn = byId("swarmRefreshBtn");
      if (refreshBtn) refreshBtn.addEventListener("click", function () { refresh(); });
      var helpBtn = byId("swarmHelpBtn");
      if (helpBtn) helpBtn.addEventListener("click", function () { send("#help"); });
      var input = byId("swarmCmdInput");
      if (input) {
        input.addEventListener("keydown", function (ev) {
          try { if (ev && ev.key === "Enter") send(""); } catch (e) { /* 回车异常不影响面板 */ }
        });
      }
      if (window.api && typeof window.api.onSwarmConsole === "function") {
        window.api.onSwarmConsole(function (reply) { render(reply); });
      }
      bound = true;
    } catch (e) { return false; }
    return bound;
  }

  // 功能：构建面板（幂等）；返回控件总数，容器不存在返回 0。
  function build() {
    if (built) return controls;
    var host = byId("swarmPanel");
    if (!host) return 0;
    try {
      var row = el("div", "swarm-row");
      var bot = el("input", "swarm-bot-input", { id: "swarmBotInput", type: "text", value: DEFAULT_BOT, "aria-label": "botId / 机器人编号" });
      var input = el("input", "cmd-input", { id: "swarmCmdInput", type: "text", placeholder: PLACEHOLDER, "aria-label": "swarm command / 蜂群指令" });
      var sendBtn = el("button", "btn primary small", { id: "swarmSendBtn", type: "button" });
      var refreshBtn = el("button", "btn small", { id: "swarmRefreshBtn", type: "button" });
      var helpBtn = el("button", "btn small", { id: "swarmHelpBtn", type: "button" });
      if (sendBtn) sendBtn.textContent = "发送 / Send";
      if (refreshBtn) refreshBtn.textContent = "刷新状态 / Refresh";
      if (helpBtn) helpBtn.textContent = "#help";
      if (row) {
        if (bot) row.appendChild(bot);
        if (input) row.appendChild(input);
        if (sendBtn) row.appendChild(sendBtn);
        if (refreshBtn) row.appendChild(refreshBtn);
        if (helpBtn) row.appendChild(helpBtn);
        host.appendChild(row);
      }
      var statusBox = el("div", "swarm-status", { id: "swarmStatusBox" });
      var resultBox = el("div", "swarm-result", { id: "swarmResultBox" });
      var commandBox = el("div", "swarm-commands", { id: "swarmCommandsBox" });
      if (statusBox) { statusBox.textContent = "状态加载中 / loading status…"; host.appendChild(statusBox); }
      if (resultBox) { resultBox.textContent = "控制台就绪 / console ready · 输入 #help / type #help"; host.appendChild(resultBox); }
      if (commandBox) { commandBox.textContent = "输入 #help 查看指令 / type #help for commands"; host.appendChild(commandBox); }
      controls = (bot ? 1 : 0) + (input ? 1 : 0) + (sendBtn ? 1 : 0) + (refreshBtn ? 1 : 0) + (helpBtn ? 1 : 0) + 3;
      built = controls > 0;
      return controls;
    } catch (e) { return 0; }
  }

  // 功能：初始化——建面板、绑事件、拉一次状态与指令清单；可重复调用。
  function init() {
    var count = build();
    bind();
    refresh();
    return { ok: built, controls: count, bound: bound, message: "swarm console ready / 蜂群控制台就绪" };
  }

  // 功能：状态快照（实机验证 / 自测用）。
  function stats() {
    return { built: built, bound: bound, controls: controls, lastCommand: lastCommand, lastOk: lastOk, bot: botId() };
  }

  window.panelSwarm = {
    init: init,
    build: build,
    send: send,
    refresh: refresh,
    render: render,
    stats: stats
  };
})();
