// gui/renderer/ui-bot.js
// 机器人卡片渲染

window.getBot = function (id) {
  var bots = window.state.bots;
  for (var i = 0; i < bots.length; i++) {
    if (bots[i].id === id) return bots[i];
  }
  return null;
};

window.statusText = function (status) {
  if (status === "running") return window.t("statusRunning");
  if (status === "stopped") return window.t("statusStopped");
  return window.t("statusIdle");
};

window.saveBots = function () {
  var plain = [];
  for (var i = 0; i < window.state.bots.length; i++) {
    var b = window.state.bots[i];
    plain.push({
      id: b.id, hostType: b.hostType, host: b.host, port: b.port,
      username: b.username, password: b.password,
      typingSpeed: b.typingSpeed, autoRespawn: b.autoRespawn, version: b.version,
      aiEnabled: b.aiEnabled, persona: b.persona, loginMode: b.loginMode || "offline",
      skin: b.skin || null
    });
  }
  try {
    localStorage.setItem("minebots-bots", JSON.stringify(plain));
  } catch (e) {}
};

window.loadBots = function () {
  var raw = localStorage.getItem("minebots-bots");
  if (!raw) return;
  try {
    var arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length === 0) return;
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      out.push(window.uiBot.normalizeBot(arr[i] || {}, i));
    }
    window.state.bots = out;
  } catch (e) {}
};

window.nextBotNumber = function () {
  var max = 0;
  for (var i = 0; i < window.state.bots.length; i++) {
    var m = String(window.state.bots[i].id).match(/^bot-(\d+)$/);
    if (m) {
      var n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return max + 1;
};

window.addBot = function () {
  var n = window.nextBotNumber();
  window.state.bots.push({
    id: "bot-" + n, hostType: "local", host: "localhost",
    port: 25565, username: "MineBot" + n, password: "",
    typingSpeed: 3, autoRespawn: true, aiEnabled: true, persona: "", version: "1.21.1",
    loginMode: "offline", status: "idle"
  });
  window.saveBots();
  window.uiBot.renderBots();
  window.uiBot.renderBotSelects();
};

window.removeBot = function (id) {
  var out = [];
  for (var i = 0; i < window.state.bots.length; i++) {
    if (window.state.bots[i].id !== id) out.push(window.state.bots[i]);
  }
  window.state.bots = out;
  if (window.uiBot.selectedBotId === id) window.uiBot.selectedBotId = null;
  window.saveBots();
  window.uiBot.renderBots();
  window.uiBot.renderBotSelects();
};

window.updateBot = function (id, patch) {
  var b = window.getBot(id);
  if (!b) return;
  for (var k in patch) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) b[k] = patch[k];
  }
  window.saveBots();
};

// 归一化版本号：空 / 自动探测 / latest / 非法字符一律回退 1.21.1（与主进程规则一致，兼容旧存档）。
window.normalizeBotVersion = function (raw) {
  var text = "";
  try { text = String(raw === undefined || raw === null ? "" : raw).trim(); } catch (e) { text = ""; }
  var lower = text.toLowerCase();
  if (!text || text.length > 32 || lower === "auto" || lower === "latest") return "1.21.1";
  return /^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(text) ? text : "1.21.1";
};

// 读界面上的测试模式开关：元素不存在或读取失败时返回 undefined（主进程保持原状态）。
window.isTestModeOn = function () {
  try {
    var el = document.getElementById("testModeToggle");
    return el ? !!el.checked : undefined;
  } catch (e) {
    return undefined;
  }
};

// 待确认动作表：记录用户刚刚点的是「启动」还是「停止」。
// 原因：app.js 收到主进程返回值后只能靠 result.message === "stopped" 猜状态，
// 而 botManager.stopBot 成功时返回 { ok: true, id }（不带 message），
// 于是「停止成功」被猜成了 running——这就是「停止按钮像在执行启动」的根因。
window.botPendingAction = {};

// 功能：记录一次机器人动作（"start" / "stop"），供返回值到达时判断该落哪个状态。
window.markBotAction = function (id, action) {
  try {
    window.botPendingAction[id] = action;
  } catch (e) { /* 记录失败不影响主流程 */ }
};

// 功能：按点击动作落状态——只有「启动成功」才是 running，其余（停止成功 / 任何失败）都是 stopped。
window.applyBotActionResult = function (result) {
  if (!result || !result.id) return;
  var action = null;
  try { action = window.botPendingAction[result.id]; } catch (e) { action = null; }
  if (!action) return;
  try { delete window.botPendingAction[result.id]; } catch (e) { /* 忽略 */ }
  var next = (result.ok && action === "start") ? "running" : "stopped";
  window.updateBot(result.id, { status: next });
  if (window.ui && typeof window.ui.refreshStatuses === "function") window.ui.refreshStatuses();
};

// 功能：把主进程返回值按点击动作纠正状态。
// 必须晚于 app.js 注册（这里用 DOMContentLoaded + setTimeout 排在 app.js 之后），
// 于是每次返回值都是「app.js 先猜、我们再纠正」，屏幕最终显示以点击动作为准。
window.addEventListener("DOMContentLoaded", function () {
  setTimeout(function () {
    try {
      if (window.botAPI && typeof window.botAPI.onResult === "function") {
        window.botAPI.onResult(window.applyBotActionResult);
      }
    } catch (e) { /* 挂不上监听不影响其它功能 */ }
  }, 0);
});

window.uiBot = {
  selectedBotId: null,

  normalizeBot: function (b, index) {
    var n = typeof index === "number" ? index + 1 : 1;
    return {
      id: b.id || ("bot-" + n),
      hostType: b.hostType || "local",
      host: b.host || "localhost",
      port: b.port || 25565,
      username: b.username || ("MineBot" + n),
      password: b.password || "",
      typingSpeed: typeof b.typingSpeed === "number" ? b.typingSpeed : 3,
      autoRespawn: b.autoRespawn !== false,
      version: window.normalizeBotVersion(b.version),
      aiEnabled: b.aiEnabled !== false,
      persona: b.persona || "",
      loginMode: b.loginMode || "offline",
      skin: b.skin || null,
      status: "idle"
    };
  },

  searchTerm: function () {
    var inp = document.getElementById("botSearch");
    return inp && inp.value ? String(inp.value).trim().toLowerCase() : "";
  },

  filterBots: function (term) {
    var bots = window.state.bots || [];
    if (!term) return bots.slice();
    var out = [];
    for (var i = 0; i < bots.length; i++) {
      var b = bots[i];
      // 匹配 id / 用户名 / 主机 / 人格：卡片上看得见的字段都应该能搜到。
      // Match id / username / host / persona so everything visible on the card is searchable.
      var hay = (String(b.id) + " " + String(b.username || "") + " " +
        String(b.host || "") + " " + String(b.persona || "")).toLowerCase();
      if (hay.indexOf(term) >= 0) out.push(b);
    }
    return out;
  },

  pickSelected: function (list) {
    if (!list.length) { window.uiBot.selectedBotId = null; return null; }
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === window.uiBot.selectedBotId) return list[i];
    }
    window.uiBot.selectedBotId = list[0].id;
    return list[0];
  },

  bindSearch: function () {
    var inp = document.getElementById("botSearch");
    if (!inp || inp.getAttribute("data-bound") === "1") return;
    inp.setAttribute("data-bound", "1");
    inp.addEventListener("input", function () { window.uiBot.renderBots(); });
  },

  renderTabs: function (wrap, list) {
    wrap.innerHTML = "";
    for (var i = 0; i < list.length; i++) {
      var id = list[i].id;
      var tab = document.createElement("button");
      tab.className = "bot-tab" + (id === window.uiBot.selectedBotId ? " active" : "");
      tab.setAttribute("data-tab-for", id);
      tab.textContent = id;
      tab.addEventListener("click", function () {
        window.uiBot.selectedBotId = this.getAttribute("data-tab-for");
        window.uiBot.renderBots();
      });
      wrap.appendChild(tab);
    }
  },

  renderBots: function () {
    var box = document.getElementById("botsBox");
    if (!box) return;
    window.uiBot.bindSearch();
    var list = window.uiBot.filterBots(window.uiBot.searchTerm());
    // 先确定选中项，再渲染标签：否则首帧 selectedBotId 还是 null，
    // 标签栏会没有任何高亮，而卡片却已经显示出来。
    // Resolve the selection BEFORE rendering tabs, otherwise no tab is highlighted on first paint.
    var sel = window.uiBot.pickSelected(list);
    var tabs = document.getElementById("botTabs");
    if (tabs) window.uiBot.renderTabs(tabs, list);
    box.innerHTML = "";
    if (sel) {
      box.appendChild(window.uiBot.buildCard(sel));
    } else {
      var empty = document.createElement("div");
      empty.className = "bot-tabs-empty";
      empty.textContent = window.t("noSearchResult");
      box.appendChild(empty);
    }
  },

  makeInputRow: function (labelText, value, onChange, phText) {
    var row = document.createElement("div");
    row.className = "row";
    var lab = document.createElement("label");
    lab.textContent = labelText;
    var inp = document.createElement("input");
    inp.className = "input";
    inp.value = value;
    if (phText) inp.setAttribute("placeholder", phText);
    inp.addEventListener("change", function () { onChange(inp.value); });
    row.appendChild(lab);
    row.appendChild(inp);
    return row;
  },

  makeCheckRow: function (labelText, checked, onChange) {
    var row = document.createElement("div");
    row.className = "row";
    var lab = document.createElement("label");
    lab.textContent = labelText;
    var inp = document.createElement("input");
    inp.type = "checkbox";
    inp.checked = !!checked;
    inp.addEventListener("change", function () { onChange(inp.checked); });
    row.appendChild(lab);
    row.appendChild(inp);
    return row;
  },

  buildCard: function (b) {
    var card = document.createElement("div");
    card.className = "bot-card";
    card.setAttribute("data-bot-id", b.id);

    var head = document.createElement("div");
    head.className = "bot-head";
    var idSpan = document.createElement("span");
    idSpan.className = "bot-id";
    idSpan.textContent = b.id;
    var del = document.createElement("button");
    del.className = "del-btn";
    del.textContent = window.t("delete");
    del.addEventListener("click", function () { window.removeBot(b.id); });
    head.appendChild(idSpan);
    head.appendChild(del);

    var typeRow = document.createElement("div");
    typeRow.className = "row";
    var typeLab = document.createElement("label");
    typeLab.textContent = window.t("host");
    var typeSel = document.createElement("select");
    typeSel.className = "cmd-select";
    var oL = document.createElement("option");
    oL.value = "local";
    oL.textContent = window.t("hostTypeLocal");
    var oS = document.createElement("option");
    oS.value = "server";
    oS.textContent = window.t("hostTypeServer");
    typeSel.appendChild(oL);
    typeSel.appendChild(oS);
    typeSel.value = b.hostType || "local";
    typeSel.addEventListener("change", function () {
      var v = typeSel.value;
      if (v === "local") window.updateBot(b.id, { hostType: "local", host: "localhost" });
      else window.updateBot(b.id, { hostType: "server" });
      window.uiBot.renderBots();
    });
    typeRow.appendChild(typeLab);
    typeRow.appendChild(typeSel);

    var hostRow = window.uiBot.makeInputRow(window.t("host"), b.host, function (v) {
      window.updateBot(b.id, { host: v });
    });
    var portRow = window.uiBot.makeInputRow(window.t("port"), b.port, function (v) {
      var n = parseInt(v, 10);
      window.updateBot(b.id, { port: isNaN(n) ? 25565 : n });
    });
    // 标记端口行：panel-main.js 的轮询把主进程自动分配的端口写回这个输入框（不重绘卡片）。
    try { portRow.setAttribute("data-port-for", b.id); } catch (e) { /* 标记失败不影响渲染 */ }
    var userRow = window.uiBot.makeInputRow(window.t("username"), b.username, function (v) {
      window.updateBot(b.id, { username: v });
    });
    // 版本号：紧贴用户名下方，改完立刻写回 state，启动时随 payload 一起传给主进程。
    var versionRow = window.uiBot.makeInputRow(window.t("version"), window.normalizeBotVersion(b.version), function (v) {
      window.updateBot(b.id, { version: window.normalizeBotVersion(v) });
    }, "1.21.1");
    var passRow = window.uiBot.makeInputRow(window.t("password"), b.password, function (v) {
      window.updateBot(b.id, { password: v });
    }, window.t("passwordPh"));

    var speedRow = window.uiBot.makeInputRow(window.t("typingSpeed"), typeof b.typingSpeed === "number" ? b.typingSpeed : 3, function (v) {
      var n = parseInt(v, 10);
      window.updateBot(b.id, { typingSpeed: isNaN(n) ? 3 : n });
    }, window.t("typingSpeedPh"));
    var respawnRow = window.uiBot.makeCheckRow(window.t("autoRespawn"), b.autoRespawn !== false, function (v) {
      window.updateBot(b.id, { autoRespawn: v });
    });
    var aiRow = window.uiBot.makeCheckRow(window.t("aiEnabled"), b.aiEnabled !== false, function (v) {
      window.updateBot(b.id, { aiEnabled: v });
    });
    var personaRow = window.uiBot.makeInputRow(window.t("persona"), b.persona || "", function (v) {
      window.updateBot(b.id, { persona: v });
    }, window.t("personaPh"));

    // AI 大脑：每个 bot 独立选「推理框架 + 具体模型」（ui-bot-brain.js），改动走真实 IPC 写后台绑定。
    var brainRow = null;
    if (window.uiBotBrain) {
      brainRow = window.uiBotBrain.build(b);
    } else {
      // 兜底：脚本缺失时只显示标签，绝不生成点了没反应的假控件。
      brainRow = document.createElement("div");
      brainRow.className = "row";
      var fbBrainLab = document.createElement("label");
      fbBrainLab.textContent = window.t("brainEngine");
      brainRow.appendChild(fbBrainLab);
    }

    var acts = document.createElement("div");
    acts.className = "bot-actions";
    var startBtn = document.createElement("button");
    startBtn.className = "btn primary small";
    startBtn.textContent = window.t("start");
    startBtn.addEventListener("click", function () {
      var cur = window.getBot(b.id);
      if (!cur) return;
      if (!window.api || typeof window.api.startBot !== "function") {
        console.warn("[ui-bot] window.api.startBot 不存在 / missing api.startBot");
        return;
      }
      // 不提前写「运行中」：状态一律等主进程返回值确认（启动成功 running / 失败 stopped）。
      window.markBotAction(b.id, "start");
      window.api.startBot({
        id: cur.id, host: cur.host, port: cur.port,
        username: cur.username, password: cur.password,
        typingSpeed: cur.typingSpeed, autoRespawn: cur.autoRespawn,
        aiEnabled: cur.aiEnabled, persona: cur.persona,
        loginMode: cur.loginMode || "offline",
        version: window.normalizeBotVersion(cur.version), testMode: window.isTestModeOn()
      });
    });
    var stopBtn = document.createElement("button");
    stopBtn.className = "btn danger small";
    stopBtn.textContent = window.t("stop");
    stopBtn.addEventListener("click", function () {
      var cur = window.getBot(b.id);
      if (!cur) return;
      if (!window.api || typeof window.api.stopBot !== "function") {
        console.warn("[ui-bot] window.api.stopBot 不存在 / missing api.stopBot");
        return;
      }
      // 停止按钮只调 stopBot(id)：传的是 id 字符串（不是 bot 对象）。
      window.markBotAction(b.id, "stop");
      window.api.stopBot(cur.id);
    });
    acts.appendChild(startBtn);
    acts.appendChild(stopBtn);

    var st = document.createElement("div");
    st.className = "status-line";
    st.textContent = window.statusText(b.status);
    st.setAttribute("data-status-for", b.id);

    card.appendChild(head);
    card.appendChild(typeRow);
    card.appendChild(hostRow);
    card.appendChild(portRow);
    card.appendChild(userRow);
    card.appendChild(versionRow);
    card.appendChild(passRow);
    card.appendChild(speedRow);
    card.appendChild(respawnRow);
    card.appendChild(aiRow);
    card.appendChild(brainRow);
    card.appendChild(personaRow);

    // 登录模式：离线（默认）/ 正版微软账号。选正版时显示一个「获取正版授权」按钮触发设备码流。
    var loginRow = document.createElement("div");
    loginRow.className = "row";
    var loginLab = document.createElement("label");
    loginLab.textContent = window.t("loginMode");
    var loginSel = document.createElement("select");
    loginSel.className = "cmd-select login-select";
    var oOff = document.createElement("option");
    oOff.value = "offline"; oOff.textContent = window.t("loginOffline");
    var oMs = document.createElement("option");
    oMs.value = "microsoft"; oMs.textContent = window.t("loginMicrosoft");
    loginSel.appendChild(oOff); loginSel.appendChild(oMs);
    loginSel.value = b.loginMode || "offline";
    loginSel.addEventListener("change", function () {
      var v = loginSel.value;
      window.updateBot(b.id, { loginMode: v });
      try { if (v === "microsoft" && authBtn) authBtn.style.display = "inline-block"; else if (authBtn) authBtn.style.display = "none"; } catch (e) { /* ignore */ }
    });
    loginRow.appendChild(loginLab);
    loginRow.appendChild(loginSel);

    var authBtn = document.createElement("button");
    authBtn.className = "btn small";
    authBtn.textContent = window.t("loginAuthBtn");
    authBtn.style.display = (b.loginMode === "microsoft") ? "inline-block" : "none";
    authBtn.addEventListener("click", function () {
      var cur = window.getBot(b.id);
      if (!cur) return;
      if (!window.api || typeof window.api.microsoftAuthStart !== "function") {
        window.uiLog.add({ time: window.util.nowTime(), type: "SYSTEM", level: "warn", message: window.t("loginAuthNoApi") });
        return;
      }
      window.api.microsoftAuthStart({ username: cur.username });
      window.uiLog.add({ time: window.util.nowTime(), type: "SYSTEM", level: "info", message: window.t("loginAuthStarted") });
    });
    loginRow.appendChild(authBtn);
    card.appendChild(loginRow);

    // 皮肤 + 后台仓库：导入该 Bot 的皮肤，一键把它的全部配置存到后台（本地清空也能拉回）。
    var skinRow = document.createElement("div");
    skinRow.className = "row skin-row";
    var avatar = document.createElement("canvas");
    avatar.className = "bot-avatar";
    avatar.setAttribute("data-avatar-for", b.id);
    skinRow.appendChild(avatar);
    var skinBtn = document.createElement("button");
    skinBtn.className = "btn small skin-btn";
    skinBtn.textContent = window.t("skinImport");
    skinBtn.addEventListener("click", function () {
      if (window.uiRoster) window.uiRoster.importSkin(b.id);
    });
    var rosterBtn = document.createElement("button");
    rosterBtn.className = "btn primary small roster-save-btn";
    rosterBtn.textContent = window.t("rosterSave");
    rosterBtn.addEventListener("click", function () {
      if (window.uiRoster) window.uiRoster.saveBot(b.id);
    });
    skinRow.appendChild(skinBtn);
    skinRow.appendChild(rosterBtn);
    card.appendChild(skinRow);
    if (window.uiRoster) window.uiRoster.paintAvatar(avatar, b.id);

    card.appendChild(acts);
    card.appendChild(st);

    // 世界信息行：生命 / 饥饿 / 坐标 / 维度，由 panel-main.js 的 5 秒轮询原地更新（[data-world-for]）。
    var worldLine = document.createElement("div");
    worldLine.className = "bot-line";
    worldLine.setAttribute("data-world-for", b.id);
    worldLine.textContent = "HP " + String(b.health === undefined ? "-" : b.health) +
      " / FOOD " + String(b.food === undefined ? "-" : b.food) +
      " / " + String(b.dimension || "-");
    card.appendChild(worldLine);
    return card;
  },

  renderBotSelects: function () {
    var tagSel = document.getElementById("tagTargetSelect");
    var cmdSel = document.getElementById("cmdTargetSelect");
    if (!tagSel || !cmdSel) return;
    var prevTag = tagSel.value;
    var prevCmd = cmdSel.value;
    tagSel.innerHTML = "";
    cmdSel.innerHTML = "";
    for (var i = 0; i < window.state.bots.length; i++) {
      var b = window.state.bots[i];
      var o1 = document.createElement("option");
      o1.value = b.id;
      o1.textContent = b.id;
      tagSel.appendChild(o1);
      var o2 = document.createElement("option");
      o2.value = b.id;
      o2.textContent = b.id;
      cmdSel.appendChild(o2);
    }
    if (prevTag && window.getBot(prevTag)) tagSel.value = prevTag;
    if (prevCmd && window.getBot(prevCmd)) cmdSel.value = prevCmd;
  }
};