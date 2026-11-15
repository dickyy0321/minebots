// ========================================
// 文件：gui/renderer/panel-main.js
// 功能：主面板前端脚本——机器人卡片渲染 / 目标下拉选择 / 状态文本与刷新 / 面板初始化
// 依赖：window.state（state.js）、window.LANG（lang.js）、window.api（api.js）、
//       window.uiBot / window.getBot / window.updateBot / window.addBot（ui-bot.js）
//       ——以上全部可选，缺失时走内置兜底渲染，绝不报错
// 导出：window.panelMain = { renderBots, renderBotSelects, statusText, refreshStatuses, init,
//       bindResultBox, showResult, clearResult }
// 作者：MineBots
// ========================================

// 全局对象：主面板对外接口（用立即执行函数包住内部助手，不额外污染 window）。
window.panelMain = (function () {
  // 常量：启动参数缺省端口与缺省打字速度。
  var DEFAULT_PORT = 25565;
  var DEFAULT_TYPING_SPEED = 3;

  // 常量：界面文字的内置双语默认值（LANG 表里查不到翻译时用它兜底）。
  var TEXT_DEFAULT = {
    hostType: "主机类型 / Host type",
    local: "本地 / Local",
    server: "服务器 / Server",
    host: "主机 / Host",
    port: "端口 / Port",
    username: "账号 / Username",
    password: "密码 / Password", version: "版本 / Version",
    start: "启动 / Start",
    stop: "停止 / Stop",
    health: "生命 / Health",
    position: "坐标 / Position"
  };

  // 内部：写控制台警告——本身也 try/catch，绝不抛错。
  function logWarn(msg) {
    try { console.warn("[panel-main] " + msg); } catch (e) { /* 忽略 */ }
  }

  // 内部：取中英双语文本——LANG 表里中英都有就用「中文 / English」，否则用内置默认值。
  function dualText(key) {
    var zh = "";
    var en = "";
    try {
      if (window.LANG && window.LANG.zh && window.LANG.zh[key]) zh = String(window.LANG.zh[key]);
      if (window.LANG && window.LANG.en && window.LANG.en[key]) en = String(window.LANG.en[key]);
    } catch (e) {
      zh = "";
      en = "";
    }
    if (zh && en) return zh === en ? zh : (zh + " / " + en);
    return TEXT_DEFAULT[key] ? TEXT_DEFAULT[key] : key;
  }

  // 内部：取机器人列表（state 未就绪 / 类型不对时返回空数组）。
  function getBots() {
    try {
      if (window.state && window.state.bots && window.state.bots.length !== undefined) return window.state.bots;
    } catch (e) {
      logWarn("读取 state.bots 失败 / read state.bots failed: " + e.message);
    }
    return [];
  }

  // 内部：按 id 找机器人——优先 window.getBot，找不到再在 state.bots 里线性找。
  function findBot(id) {
    try {
      if (typeof window.getBot === "function") {
        var hit = window.getBot(id);
        if (hit) return hit;
      }
    } catch (e) {
      logWarn("window.getBot 调用失败 / getBot failed: " + e.message);
    }
    var bots = getBots();
    for (var i = 0; i < bots.length; i++) {
      if (bots[i] && bots[i].id === id) return bots[i];
    }
    return null;
  }

  // 内部：安全调用 window.api 上的方法（api 未就绪时只写警告）。
  function apiCall(name, args) {
    try {
      if (window.api && typeof window.api[name] === "function") {
        return window.api[name].apply(window.api, args || []);
      }
      logWarn("window.api." + name + " 不存在 / missing api method");
    } catch (e) {
      logWarn("接口调用失败 / api call failed: " + name + " - " + e.message);
    }
    return null;
  }

  // 内部：记录刚点的动作（"start" / "stop"）——ui-bot.js 的 window.markBotAction 提供，
  // 用途：app.js 只能靠 result.message 猜状态，用不上时跳过即可，绝不报错。
  function markBotAction(id, action) {
    try {
      if (typeof window.markBotAction === "function") window.markBotAction(id, action);
    } catch (e) {
      logWarn("记录动作失败 / mark action failed: " + e.message);
    }
  }

  // 内部：写机器人状态并刷新状态行（updateBot 缺失时直接改内存对象）。
  // 注意：按钮点击后的状态一律由主进程返回值落定（见 ui-bot.js 的 applyBotActionResult），
  //       这个助手只在 updateBot 不可用的降级场景里就地写状态用。
  function applyStatus(id, status) {
    try {
      if (typeof window.updateBot === "function") window.updateBot(id, { status: status });
      else { var bot = findBot(id); if (bot) bot.status = status; }
    } catch (e) { logWarn("写状态失败 / set status failed: " + e.message); }
    refreshStatuses();
  }

  // 功能 1：渲染机器人卡片——优先交给 ui-bot.js，异常或缺失时用内置兜底渲染。
  function renderBots() {
    if (window.uiBot && typeof window.uiBot.renderBots === "function") {
      try { window.uiBot.renderBots(); return; } catch (e) { logWarn("uiBot.renderBots 异常，改用兜底渲染 / falling back: " + e.message); }
    }
    var box = document.getElementById("botsBox");
    if (!box) return;
    try { box.innerHTML = ""; } catch (e) { logWarn("清空卡片失败 / clear cards failed: " + e.message); }
    var bots = getBots();
    for (var i = 0; i < bots.length; i++) {
      try {
        box.appendChild(buildCard(bots[i]));
      } catch (e) {
        logWarn("渲染卡片失败 / render card failed: " + e.message);
      }
    }
  }

  // 内部：填充单个目标下拉——先记住旧值，填完再恢复（旧值已消失就保持第一项）。
  function fillSelect(sel) {
    if (!sel) return;
    var prev = "";
    try { prev = String(sel.value || ""); } catch (e) { prev = ""; }
    try { sel.innerHTML = ""; } catch (e) { logWarn("清空下拉失败 / clear select failed: " + e.message); return; }
    var bots = getBots();
    for (var i = 0; i < bots.length; i++) {
      if (!bots[i] || !bots[i].id) continue;
      var opt = document.createElement("option");
      opt.value = bots[i].id;
      opt.textContent = bots[i].id;
      sel.appendChild(opt);
    }
    if (prev && findBot(prev)) sel.value = prev;
  }

  // 功能 2：渲染目标下拉——填 #tagTargetSelect 与 #cmdTargetSelect，并保留原选中值。
  function renderBotSelects() {
    if (window.uiBot && typeof window.uiBot.renderBotSelects === "function") {
      try { window.uiBot.renderBotSelects(); return; } catch (e) { logWarn("uiBot.renderBotSelects 异常，改用兜底填充 / falling back: " + e.message); }
    }
    fillSelect(document.getElementById("tagTargetSelect"));
    fillSelect(document.getElementById("cmdTargetSelect"));
  }

  // 功能 3：状态文本——idle/running/dead/stopped 返回「中文 / English」，其它状态原样返回。
  function statusText(status) {
    if (status === "idle") return "空闲 / Idle";
    if (status === "running") return "运行中 / Running";
    if (status === "dead") return "已死亡 / Dead"; if (status === "stopped") return "已停止 / Stopped";
    return status ? String(status) : "";
  }

  // 功能 4：刷新状态——遍历所有 [data-status-for]，按最新状态改写状态行文字。
  function refreshStatuses() {
    var nodes = null;
    try { nodes = document.querySelectorAll("[data-status-for]"); } catch (e) { nodes = null; }
    if (!nodes) return;
    for (var i = 0; i < nodes.length; i++) {
      var id = "";
      try { id = nodes[i].getAttribute("data-status-for"); } catch (e) { id = ""; }
      var bot = findBot(id);
      try { nodes[i].textContent = statusText(bot ? bot.status : ""); } catch (e) { /* 单个节点失败不影响其它 */ }
    }
  }

  // 内部：拼启动参数——字段与 ui-bot.js 保持一致，主进程还会再做一次兜底。
  function startPayload(id) {
    var bot = findBot(id) || {};
    var port = Number(bot.port);
    if (!isFinite(port) || port <= 0) port = DEFAULT_PORT;
    return {
      id: bot.id || id,
      host: bot.host || "localhost",
      port: port,
      username: bot.username || "",
      password: bot.password || "",
      typingSpeed: typeof bot.typingSpeed === "number" ? bot.typingSpeed : DEFAULT_TYPING_SPEED,
      autoRespawn: bot.autoRespawn !== false,
      aiEnabled: bot.aiEnabled !== false,
      persona: bot.persona || "", version: bot.version || "1.21.1",
      testMode: (typeof window.isTestModeOn === "function" ? window.isTestModeOn() : undefined)
    };
  }

  // 内部：把坐标对象格式化成「x, y, z」（字段缺失用 ? 占位，兼容各种实体对象）。
  function formatPosition(pos) {
    try {
      var x = typeof pos.x === "number" ? pos.x.toFixed(1) : "?";
      var y = typeof pos.y === "number" ? pos.y.toFixed(1) : "?";
      var z = typeof pos.z === "number" ? pos.z.toFixed(1) : "?";
      return x + ", " + y + ", " + z;
    } catch (e) {
      return "?";
    }
  }

  // 内部：造一行纯文本（生命 / 坐标等附加信息用）。
  function makeLine(textValue) {
    var row = document.createElement("div");
    row.className = "bot-line";
    row.textContent = textValue;
    return row;
  }

  // 内部：造一行「标签 + 主机类型下拉」（本地 / 服务器），改完写回 state。
  function makeSelectRow(labelText, bot) {
    var row = document.createElement("div");
    row.className = "bot-row";
    var lab = document.createElement("span");
    lab.className = "bot-label";
    lab.textContent = labelText;
    var sel = document.createElement("select");
    sel.className = "input small";
    var opts = [{ v: "local", t: dualText("local") }, { v: "server", t: dualText("server") }];
    for (var i = 0; i < opts.length; i++) {
      var opt = document.createElement("option");
      opt.value = opts[i].v;
      opt.textContent = opts[i].t;
      sel.appendChild(opt);
    }
    sel.value = bot.hostType === "server" ? "server" : "local";
    sel.addEventListener("change", function () {
      try {
        if (typeof window.updateBot === "function") window.updateBot(bot.id, { hostType: sel.value });
        else bot.hostType = sel.value;
      } catch (e) {
        logWarn("保存主机类型失败 / save host type failed: " + e.message);
      }
    });
    row.appendChild(lab);
    row.appendChild(sel);
    return row;
  }

  // 内部：造一行「标签 + 输入框」，change 时写回 state（端口自动转数字）。
  function makeInputRow(labelText, field, bot) {
    var row = document.createElement("div");
    row.className = "bot-row";
    var lab = document.createElement("span");
    lab.className = "bot-label";
    lab.textContent = labelText;
    var input = document.createElement("input");
    input.className = "input small";
    input.value = (bot[field] === undefined || bot[field] === null) ? "" : String(bot[field]);
    input.addEventListener("change", function () {
      try {
        var patch = {};
        if (field === "port") {
          var n = parseInt(input.value, 10);
          patch.port = (isNaN(n) || n <= 0) ? DEFAULT_PORT : n;
        } else {
          patch[field] = input.value;
        }
        if (typeof window.updateBot === "function") window.updateBot(bot.id, patch);
        else bot[field] = patch[field];
      } catch (e) {
        logWarn("保存字段失败 / save field failed: " + field + " - " + e.message);
      }
    });
    row.appendChild(lab);
    row.appendChild(input);
    return row;
  }

  // 内部：兜底渲染单张机器人卡片（ui-bot.js 未加载时使用），内容与规格一致。
  function buildCard(bot) {
    var card = document.createElement("div");
    card.className = "bot-card";
    card.setAttribute("data-bot-card", bot.id);

    var head = document.createElement("div");
    head.className = "bot-head";
    head.textContent = bot.id;
    card.appendChild(head);

    var st = document.createElement("div");
    st.className = "status-line";
    st.setAttribute("data-status-for", bot.id);
    st.textContent = statusText(bot.status);
    card.appendChild(st);

    // 生命 / 坐标：只有数据存在时才显示，缺数据就跳过（原版服与模组服都兼容）。
    if (typeof bot.health === "number") card.appendChild(makeLine(dualText("health") + ": " + bot.health));
    if (bot.position) card.appendChild(makeLine(dualText("position") + ": " + formatPosition(bot.position)));

    card.appendChild(makeSelectRow(dualText("hostType"), bot));
    card.appendChild(makeInputRow(dualText("host"), "host", bot));
    card.appendChild(makeInputRow(dualText("port"), "port", bot));
    card.appendChild(makeInputRow(dualText("username"), "username", bot));
    card.appendChild(makeInputRow(dualText("version"), "version", { id: bot.id, version: bot.version || "1.21.1" }));
    card.appendChild(makeInputRow(dualText("password"), "password", bot));

    var acts = document.createElement("div");
    acts.className = "bot-actions";
    var startBtn = document.createElement("button");
    startBtn.className = "btn primary small";
    startBtn.textContent = dualText("start");
    startBtn.addEventListener("click", function () {
      // 启动：调 startBot(bot 参数) 并记录动作；状态等主进程返回值落定，不提前写「运行中」。
      markBotAction(bot.id, "start");
      apiCall("startBot", [startPayload(bot.id)]);
    });
    var stopBtn = document.createElement("button");
    stopBtn.className = "btn danger small";
    stopBtn.textContent = dualText("stop");
    stopBtn.addEventListener("click", function () {
      // 停止：调 stopBot(botId) 并记录动作；状态由主进程返回值落定为「已停止」。
      markBotAction(bot.id, "stop");
      apiCall("stopBot", [bot.id]);
    });
    acts.appendChild(startBtn);
    acts.appendChild(stopBtn);
    card.appendChild(acts);
    return card;
  }

  // 内部：幂等绑定点击事件——用 data 标记去重，重复初始化不会绑两次。
  function bindOnce(el, key, handler) {
    if (!el) return false;
    var flag = "data-panel-main-" + key;
    try {
      if (el.getAttribute(flag) === "1") return false;
      el.setAttribute(flag, "1");
      el.addEventListener("click", handler);
      return true;
    } catch (e) {
      logWarn("绑定按钮失败 / bind button failed: " + key + " - " + e.message);
      return false;
    }
  }

  // 内部：绑定「添加机器人」按钮——events.js 已接管时跳过，避免一次点击加出两个机器人。
  function bindAddBotButton() {
    if (window.events) return false;
    return bindOnce(document.getElementById("addBotBtn"), "addBot", function () {
      if (typeof window.addBot === "function") window.addBot();
      else logWarn("window.addBot 未加载 / window.addBot not loaded");
    });
  }

  // 功能 5：初始化——先渲染卡片与下拉，再绑定「添加机器人 / 全部启动 / 全部停止」。
  function init() {
    renderBots();
    renderBotSelects();
    bindAddBotButton();
    bindOnce(document.getElementById("startAllBtn"), "startAll", function () {
      var bots = getBots();
      for (var i = 0; i < bots.length; i++) {
        markBotAction(bots[i].id, "start");
        apiCall("startBot", [startPayload(bots[i].id)]);
      }
    });
    bindOnce(document.getElementById("stopAllBtn"), "stopAll", function () {
      var bots = getBots();
      for (var i = 0; i < bots.length; i++) {
        markBotAction(bots[i].id, "stop");
        apiCall("stopBot", [bots[i].id]);
      }
    });
    bindResultBox();
  }

  // 功能 6：绑定返回值弹框的关闭按钮（用途：查看 AI / 指令返回值）。
  function bindResultBox() {
    bindOnce(document.getElementById("resultCloseBtn"), "resultClose", function () {
      try {
        var box = document.getElementById("resultBox");
        var list = document.getElementById("resultList");
        if (box) box.classList.add("hidden");
        if (list) list.innerHTML = "";
      } catch (e) {
        logWarn("关闭返回值弹框失败 / close result box failed: " + e.message);
      }
    });
  }

  // 功能 7：往返回值弹框追加一组文本（时间取 window.util.nowTime，缺失就留空）。
  function showResult(title, lines) {
    try {
      var box = document.getElementById("resultBox");
      var list = document.getElementById("resultList");
      if (!box || !list) return;
      var titleEl = document.getElementById("resultTitle");
      if (titleEl) titleEl.textContent = title || "";
      var rows = (lines && lines.length) ? lines : [];
      var time = "";
      try { if (window.util && typeof window.util.nowTime === "function") time = window.util.nowTime(); } catch (e) { time = ""; }
      var group = document.createElement("div");
      group.className = "result-group";
      var head = document.createElement("div");
      head.className = "result-head";
      head.textContent = "[" + time + "] " + (title || "");
      group.appendChild(head);
      for (var i = 0; i < rows.length; i++) {
        var line = document.createElement("div");
        line.className = "result-line";
        line.textContent = String(rows[i]);
        group.appendChild(line);
      }
      list.appendChild(group);
      list.scrollTop = list.scrollHeight;
      box.classList.remove("hidden");
    } catch (e) {
      logWarn("显示返回值失败 / show result failed: " + e.message);
    }
  }

  // 功能 8：清空返回值弹框内容。
  function clearResult() {
    try {
      var list = document.getElementById("resultList");
      if (list) list.innerHTML = "";
    } catch (e) {
      logWarn("清空返回值失败 / clear result failed: " + e.message);
    }
  }

  // 常量：状态轮询间隔 5 秒（任务 5 要求）。
  var POLL_INTERVAL_MS = 5000;

  // 状态：轮询定时器与上一次快照签名——用来判断「有没有变化」，变了才动 UI。
  var pollTimer = null;
  var lastSnapshot = "";
  // 状态：窗口不可见时被跳过的轮询标记——恢复可见后补一次，保证界面不是旧数据。
  var pollSkipped = false;

  // 内部：现在该不该轮询——页面隐藏 / 窗口最小化时先停手，省 CPU 也不打扰主进程。
  function shouldPoll() {
    try { if (document.hidden === true) return false; if (document.visibilityState === "hidden") return false; } catch (e) { return true; }
    return true;
  }

  // 内部：把一条 bot 快照压成签名串，用于变化检测（状态 / 端口 / 生命 / 饥饿 / 坐标 / 维度）。
  function snapshotKey(bot) {
    try {
      var pos = bot.position ? bot.position : {};
      return String(bot.id) + "|" + String(bot.status) + "|" + String(bot.port) + "|" + String(bot.health) + "|" +
        String(bot.food) + "|" + String(bot.dimension) + "|" + String(pos.x) + "," + String(pos.y) + "," + String(pos.z);
    } catch (e) {
      return "";
    }
  }

  // 内部：把生命 / 饥饿 / 坐标 / 维度写到卡片的世界信息行（[data-world-for]），元素不存在就跳过。
  function writeWorldLine(id, bot) {
    try {
      var nodes = document.querySelectorAll("[data-world-for]");
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].getAttribute("data-world-for") !== id) continue;
        var pos = bot.position ? bot.position : {};
        nodes[i].textContent = "HP " + String(bot.health) + " / FOOD " + String(bot.food) + " / " +
          String(pos.x) + "," + String(pos.y) + "," + String(pos.z) + " / " + String(bot.dimension || "");
      }
    } catch (e) {
      logWarn("写世界信息失败 / write world line failed: " + e.message);
    }
  }

  // 内部：把主进程分配的端口写回卡片端口输入框（[data-port-for]），正在输入时不打扰。
  function writePort(id, port) {
    try {
      var nodes = document.querySelectorAll("[data-port-for]");
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].getAttribute("data-port-for") !== id) continue;
        var input = nodes[i].querySelector("input");
        if (!input) continue;
        try { if (document.activeElement === input) continue; } catch (e) { /* 判断不了就照常写 */ }
        input.value = String(port);
      }
    } catch (e) {
      logWarn("写端口失败 / write port failed: " + e.message);
    }
  }

  // 功能 9：应用一次轮询结果——只对变化过的 bot 写 state，并刷新状态行 / 世界信息 / 端口。
  function applySnapshot(bots) {
    var changed = false;
    var keys = [];
    for (var i = 0; i < bots.length; i++) {
      var item = bots[i];
      if (!item || !item.id) continue;
      var key = snapshotKey(item);
      keys.push(key);
      if (lastSnapshot.indexOf("|" + key + "|") >= 0) continue;
      if (typeof window.updateBot === "function") {
        window.updateBot(item.id, {
          status: item.status, port: item.port, health: item.health, food: item.food,
          position: item.position, dimension: item.dimension
        });
      }
      writePort(item.id, item.port);
      writeWorldLine(item.id, item);
      changed = true;
    }
    lastSnapshot = "|" + keys.join("|") + "|";
    if (changed) refreshStatuses();
    return changed;
  }

  // 内部：轮询一次——向主进程要 listBots()，异常只写警告，绝不打断界面。
  function pollOnce() {
    // 省 CPU：窗口最小化 / 页面隐藏时不发请求，只记一个待补标记。
    if (!shouldPoll()) { pollSkipped = true; return false; }
    pollSkipped = false;
    try {
      if (window.api && typeof window.api.listBots === "function") window.api.listBots();
      return true;
    } catch (e) {
      logWarn("轮询失败 / poll failed: " + e.message);
      return false;
    }
  }

  // 功能 9b：启动轮询——注册一次回包监听 + 5 秒定时器；重复调用只生效一次，且不写任何日志。
  function startPolling() {
    try {
      if (pollTimer) return false;
      if (window.botAPI && typeof window.botAPI.onBotList === "function") {
        window.botAPI.onBotList(function (data) {
          try {
            var list = (data && data.bots && data.bots.length !== undefined) ? data.bots : [];
            applySnapshot(list);
          } catch (e) {
            logWarn("应用状态失败 / apply snapshot failed: " + e.message);
          }
        });
      }
      if (typeof window.setInterval === "function") pollTimer = window.setInterval(pollOnce, POLL_INTERVAL_MS);
      // 窗口重新可见 / 重新获得焦点时立刻补一次（被最小化跳过的那一轮）。
      try {
        document.addEventListener("visibilitychange", function () { try { if (!document.hidden) pollOnce(); } catch (e) { logWarn("可见性轮询失败 / visibility poll failed: " + e.message); } });
        window.addEventListener("focus", function () { try { if (pollSkipped) pollOnce(); } catch (e) { logWarn("焦点轮询失败 / focus poll failed: " + e.message); } });
      } catch (e) {
        logWarn("注册可见性监听失败 / register visibility listener failed: " + e.message);
      }
      pollOnce();
      return true;
    } catch (e) {
      logWarn("启动轮询失败 / start polling failed: " + e.message);
      return false;
    }
  }

  // 自动初始化：本脚本先于 events.js / app.js 执行，等 DOM 就绪后再初始化。
  // 注意：app.js 的 DOMContentLoaded 回调会先 loadBots() 填充 state.bots，
  //       因此这里用 setTimeout 让出本轮事件循环，保证首屏渲染拿到的是真实列表。
  function autoInit() {
    try {
      init();
    } catch (e) {
      logWarn("自动初始化失败 / auto init failed: " + e.message);
    }
    // 启动 5 秒状态轮询（任务 5）：只更新变化的卡片，不写日志、不刷屏。
    startPolling();
  }

  // 内部：延迟到其它模块初始化之后再跑 init（window.events 此时已存在，不会重复绑按钮）。
  function scheduleInit() {
    try {
      if (typeof window.setTimeout === "function") window.setTimeout(autoInit, 0);
      else autoInit();
    } catch (e) {
      autoInit();
    }
  }

  try {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scheduleInit);
    else scheduleInit();
  } catch (e) {
    logWarn("注册自动初始化失败 / register auto init failed: " + e.message);
  }

  // 对外导出：规格要求的 5 个接口 + 兼容保留的返回值弹框 3 个接口 + 任务 5 的状态轮询接口。
  return {
    renderBots: renderBots, renderBotSelects: renderBotSelects, statusText: statusText,
    refreshStatuses: refreshStatuses, init: init, startPolling: startPolling,
    bindResultBox: bindResultBox, showResult: showResult, clearResult: clearResult
  };
}());
