// ========================================
// 文件：gui/renderer/panel-state.js
// 功能：状态机面板接线——列出 state/statemachines 里的状态机、按 bot 运行 / 停止、AI 接管覆盖时的用户确认
// 依赖：window.api（preload 暴露）、window.panelAi（回填 bot 下拉，可选）
// 导出：window.panelState（init / fill / fillBots / run / stop / confirm / cancel / showResult）
// 说明：渲染进程不许 require，跨进程动作一律走 window.api；绑定幂等，重复 init 不会重复触发。
// 作者：MineBots
// ========================================

(function () {
  // 常量：待确认区的隐藏样式类。
  var HIDDEN = "hidden";

  // 内部：按 id 取元素，取不到返回 null。
  function byId(id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  }

  // 内部：按 id 写文字，元素不存在静默返回 false。
  function setText(id, text) {
    var el = byId(id);
    if (!el) return false;
    try { el.textContent = text; return true; } catch (e) { return false; }
  }

  // 内部：双语文案（i18n 缺失时退回字面量，绝不留空）。
  function t(key, fallback) {
    try {
      if (window.t) {
        var text = window.t(key);
        if (text && text !== key) return text;
      }
    } catch (e) { /* 退回兜底文案 */ }
    return fallback;
  }

  // 内部：元素只绑一次。
  function bindOnce(el, event, key, handler) {
    if (!el) return false;
    try {
      var flag = "_mbBound_" + key;
      if (el[flag]) return false;
      el[flag] = true;
      el.addEventListener(event, handler);
      return true;
    } catch (e) { return false; }
  }

  // 内部：把字符串数组填进下拉框（第一项是空值占位），返回是否成功。
  function fillSelect(el, items, emptyLabel) {
    if (!el) return false;
    try { el.innerHTML = ""; } catch (e) { return false; }
    var blank = document.createElement("option");
    blank.value = "";
    blank.textContent = emptyLabel;
    el.appendChild(blank);
    var list = Array.isArray(items) ? items : [];
    for (var i = 0; i < list.length; i++) {
      var opt = document.createElement("option");
      opt.value = String(list[i]);
      opt.textContent = String(list[i]);
      el.appendChild(opt);
    }
    return true;
  }

  window.panelState = {
    // 初始化：绑定按钮 + 订阅回包 + 拉一次数据（全部幂等）。
    init: function () {
      window.panelState.bindButtons();
      window.panelState.bindListeners();
      window.panelState.refresh();
      return true;
    },

    // 绑定运行 / 停止 / 刷新 / 确认 / 取消 五个按钮。
    bindButtons: function () {
      bindOnce(byId("stateMachineRunBtn"), "click", "smRun", function () { window.panelState.run(); });
      bindOnce(byId("stateMachineStopBtn"), "click", "smStop", function () { window.panelState.stop(); });
      bindOnce(byId("stateMachineRefreshBtn"), "click", "smRefresh", function () { window.panelState.refresh(); });
      bindOnce(byId("stateMachineConfirmBtn"), "click", "smConfirm", function () { window.panelState.confirm(); });
      bindOnce(byId("stateMachineCancelBtn"), "click", "smCancel", function () { window.panelState.cancel(); });
      return true;
    },

    // 订阅主进程回包：数据回包刷新界面，结果回包显示一句话并再拉一次数据。
    bindListeners: function () {
      try {
        if (window.api && typeof window.api.onStateMachineData === "function") {
          window.api.onStateMachineData(function (data) { window.panelState.fill(data); });
        }
        if (window.api && typeof window.api.onStateMachineResult === "function") {
          window.api.onStateMachineResult(function (res) {
            var msg = res && res.message ? String(res.message) : t("stateMachineDone", "操作完成 / done");
            window.panelState.showResult(msg);
            window.panelState.refresh();
          });
        }
      } catch (e) { /* 监听失败只影响刷新，不影响按钮 */ }
      return true;
    },

    // 请求主进程返回最新数据。
    refresh: function () {
      try {
        if (window.api && typeof window.api.stateMachineList === "function") window.api.stateMachineList();
      } catch (e) { return false; }
      return true;
    },

    // 当前选中的 botId（空串返回 "default"，与后端默认值对齐）。
    botId: function () {
      var el = byId("stateMachineBot");
      var id = el && el.value ? String(el.value).trim() : "";
      return id.length > 0 ? id : "default";
    },

    // 当前选中的状态机名（空串表示没选）。
    machineName: function () {
      var el = byId("stateMachineSelect");
      return el && el.value ? String(el.value).trim() : "";
    },

    // 运行选中的状态机（缺状态机只提示，不抛错）。
    run: function () {
      var name = window.panelState.machineName();
      if (name.length === 0) {
        window.panelState.showResult(t("stateMachinePickFirst", "请先选择状态机 / pick a machine first"));
        return false;
      }
      try {
        if (window.api && typeof window.api.stateMachineRun === "function") {
          window.api.stateMachineRun({ botId: window.panelState.botId(), name: name });
          window.panelState.showResult(t("stateMachineStarting", "正在启动 / starting: ") + name);
        }
      } catch (e) { return false; }
      return true;
    },

    // 停止选中 bot 的状态机。
    stop: function () {
      try {
        if (window.api && typeof window.api.stateMachineStop === "function") window.api.stateMachineStop(window.panelState.botId());
      } catch (e) { return false; }
      return true;
    },

    // 用户点了「确认覆盖」：AI 造的同名状态机这时才真正落盘并运行。
    confirm: function () {
      try {
        if (window.api && typeof window.api.stateMachineConfirm === "function") window.api.stateMachineConfirm(window.panelState.botId());
      } catch (e) { return false; }
      return true;
    },

    // 用户点了「取消」：丢掉待确认请求，不动磁盘上的旧文件。
    cancel: function () {
      try {
        if (window.api && typeof window.api.stateMachineCancel === "function") window.api.stateMachineCancel(window.panelState.botId());
        window.panelState.renderPending([]);
        window.panelState.showResult(t("stateMachineCancelled", "已取消 / cancelled"));
      } catch (e) { return false; }
      return true;
    },

    // 回填状态机下拉 + 运行中列表 + 待确认区。
    fill: function (data) {
      var d = data || {};
      fillSelect(byId("stateMachineSelect"), d.machines || [], t("stateMachineNone", "(暂无状态机 / none)"));
      var running = Array.isArray(d.running) ? d.running : [];
      var text = running.length > 0
        ? (t("stateMachineRunning", "运行中 / running: ") + running.join(", "))
        : t("stateMachineIdle", "没有状态机在跑 / idle");
      setText("stateMachineResult", text);
      window.panelState.renderPending(d.pending || []);
      return true;
    },

    // 回填 bot 下拉（第一项固定放 default，其余是真实 bot id）。
    fillBots: function (list) {
      var ids = [];
      try {
        var bots = Array.isArray(list) ? list : [];
        for (var i = 0; i < bots.length; i++) {
          var one = bots[i];
          var id = "";
          try { id = String(one && one.id ? one.id : one); } catch (e) { id = ""; }
          if (id.length > 0 && ids.indexOf(id) < 0) ids.push(id);
        }
      } catch (e) { ids = []; }
      if (ids.indexOf("default") < 0) ids.unshift("default");
      var sel = byId("stateMachineBot");
      var keep = sel && sel.value ? String(sel.value) : "";
      fillSelect(sel, ids, t("stateMachineBotAny", "默认 / default"));
      try {
        if (keep.length > 0 && ids.indexOf(keep) >= 0) sel.value = keep;
        else sel.value = "default";
      } catch (e) { /* 选不中就保持第一项 */ }
      if (window.panelAi && typeof window.panelAi.fillBotList === "function") window.panelAi.fillBotList(ids);
      return true;
    },

    // 渲染待确认区：有请求就显示确认 / 取消按钮，没有就藏起来。
    renderPending: function (pending) {
      var box = byId("stateMachinePending");
      var list = Array.isArray(pending) ? pending : [];
      if (!box) return false;
      try {
        if (list.length === 0) {
          box.classList.add(HIDDEN);
          setText("stateMachinePendingText", "");
          return true;
        }
        box.classList.remove(HIDDEN);
        var names = [];
        for (var i = 0; i < list.length; i++) {
          var one = list[i] || {};
          names.push(String(one.botId || "") + " -> " + String(one.name || ""));
        }
        setText("stateMachinePendingText", t("stateMachinePendingTip", "AI 想覆盖已有状态机，请确认 / AI wants to overwrite: ") + names.join("; "));
        return true;
      } catch (e) { return false; }
    },

    // 在状态位显示一句话（失败也不抛错）。
    showResult: function (text) {
      return setText("stateMachineResult", String(text === undefined || text === null ? "" : text));
    }
  };

  // 收到 bot 列表就刷新两个下拉（主进程每 5 秒推一次，重复回填不会丢选中值）。
  try {
    if (window.botAPI && typeof window.botAPI.onBotList === "function") {
      window.botAPI.onBotList(function (res) {
        var bots = res && res.bots ? res.bots : res;
        window.panelState.fillBots(bots);
      });
    }
  } catch (e) { /* 监听失败不影响面板其它功能 */ }
})();
