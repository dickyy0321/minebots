// gui/renderer/ui.js
window.ui = {
  applyLang: function () {
    var nodes = document.querySelectorAll("[data-i18n]");
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = window.t(nodes[i].getAttribute("data-i18n"));
    }
    var phNodes = document.querySelectorAll("[data-i18n-ph]");
    for (var j = 0; j < phNodes.length; j++) {
      phNodes[j].setAttribute("placeholder", window.t(phNodes[j].getAttribute("data-i18n-ph")));
    }
    var langBtn = document.getElementById("langBtn");
    if (langBtn) langBtn.textContent = window.state.currentLang === "zh" ? "中文" : "EN";
    var logLangBtn = document.getElementById("logLangBtn");
    if (logLangBtn) logLangBtn.textContent = window.state.logLang === "zh" ? "中文日志" : "EN Log";

    // 运行模式提示 / 驾驶提示 / 目标机器人是 JS 动态写的，切换语言后要重新同步一次。
    try {
      if (window.panelAi && window.panelAi.applyProvider) window.panelAi.applyProvider(window.panelAi.currentProvider(), { fill: false });
      // 本地框架提示是按框架动态写的，切语言后要按当前框架重刷一次（否则会退回 llama.cpp 那句）。
      if (window.panelAi && window.panelAi.syncEngine) {
        var engEl = document.getElementById("aiEngineSelect");
        if (engEl) window.panelAi.syncEngine(engEl.value);
      }
    } catch (e) { /* 提示同步失败不影响语言切换 */ }
    try {
      if (window.uiView && window.uiView.refreshText) window.uiView.refreshText();
    } catch (e2) { /* 同上 */ }
    try {
      if (window.panelSettings && window.panelSettings.renderOwnerBadges) window.panelSettings.renderOwnerBadges();
    } catch (e3) { /* 主人标签重绘失败不影响语言切换 */ }

    var frT = document.getElementById("frTitle");
    var frB = document.getElementById("frBody");
    var frC = document.getElementById("frCloseBtn");
    var frN = document.getElementById("frNoMoreBtn");
    if (frT) frT.textContent = window.t("frTitle");
    if (frB) frB.textContent = window.t("frBody");
    if (frC) frC.textContent = window.t("frClose");
    if (frN) frN.textContent = window.t("frNoMore");
  },
  addLog: function (entry) {
    if (window.uiLog && window.uiLog.add) window.uiLog.add(entry);
  },
  refreshStatuses: function () {
    var nodes = document.querySelectorAll("[data-status-for]");
    for (var i = 0; i < nodes.length; i++) {
      var id = nodes[i].getAttribute("data-status-for");
      var b = window.getBot(id);
      if (b) nodes[i].textContent = window.statusText(b.status);
    }
  },
  renderAll: function () {
    if (window.uiBot && window.uiBot.renderBots) window.uiBot.renderBots();
    if (window.uiBot && window.uiBot.renderBotSelects) window.uiBot.renderBotSelects();
  }
};
