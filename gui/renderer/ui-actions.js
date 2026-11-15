// ========================================
// 文件：gui/renderer/ui-actions.js
// 功能：高级动作面板——列出 16 个动作（分组 + 说明 + 是否可用）、按需执行并显示结果
// 依赖：window.api（preload 暴露）、window.util、window.t（可选）
// 导出：window.uiActions（init / refresh / fill / run / show / botId）
// 说明：渲染进程不许 require；动作执行一律走主进程，面板只负责选参数与显示结果。
// 作者：MineBots
// ========================================

(function () {
  // 内部：按 id 取元素，取不到返回 null。
  function byId(id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  }

  // 内部：双语文案（i18n 缺失时退回字面量）。
  function t(key, fallback) {
    try {
      if (window.t) {
        var text = window.t(key);
        if (text && text !== key) return text;
      }
    } catch (e) { /* 退回兜底文案 */ }
    return fallback;
  }

  // 内部：按 id 写文字，元素不存在静默返回 false。
  function setText(id, text) {
    var el = byId(id);
    if (!el) return false;
    try { el.textContent = text; return true; } catch (e) { return false; }
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

  // 内部：写一条 GUI 日志（日志模块不在就静默跳过）。
  function logLine(message, level) {
    try {
      if (window.uiLog && window.uiLog.add) {
        window.uiLog.add({
          time: window.util ? window.util.nowTime() : "",
          type: "SYSTEM", level: level || "info", message: String(message)
        });
      }
    } catch (e) { /* 日志失败不影响动作 */ }
  }

  window.uiActions = {
    // 初始化：绑按钮 + 订阅回包 + 拉一次动作清单（幂等）。
    init: function () {
      bindOnce(byId("actionRunBtn"), "click", "actRun", function () { window.uiActions.run(); });
      try {
        if (window.api && typeof window.api.onActionList === "function") {
          window.api.onActionList(function (data) { window.uiActions.fill(data); });
        }
        if (window.api && typeof window.api.onActionResult === "function") {
          window.api.onActionResult(function (res) { window.uiActions.show(res); });
        }
      } catch (e) { /* 监听失败不影响手动刷新 */ }
      window.uiActions.refresh();
      return true;
    },

    // 向主进程要一次动作清单。
    refresh: function () {
      try {
        if (window.api && typeof window.api.actionList === "function") window.api.actionList();
      } catch (e) { return false; }
      return true;
    },

    // 回填动作下拉：分组名 + 动作名 + 说明；没实现的动作标成「不可用」但仍列出。
    fill: function (data) {
      var sel = byId("actionSelect");
      if (!sel) return false;
      var list = Array.isArray(data) ? data : (data && Array.isArray(data.actions) ? data.actions : []);
      var keep = sel.value ? String(sel.value) : "";
      try { sel.innerHTML = ""; } catch (e) { return false; }
      for (var i = 0; i < list.length; i++) {
        var one = list[i] || {};
        var name = String(one.name || "");
        if (name.length === 0) continue;
        var opt = document.createElement("option");
        opt.value = name;
        var group = one.group ? "[" + String(one.group) + "] " : "";
        var desc = one.description ? " · " + String(one.description) : "";
        opt.textContent = group + name + desc + (one.ready === false ? " (" + t("actionNotReady", "不可用 / unavailable") + ")" : "");
        sel.appendChild(opt);
      }
      if (keep.length > 0) {
        try { sel.value = keep; } catch (e2) { /* 旧选项没了就保持第一个 */ }
      }
      setText("actionHint", String(list.length) + " actions / 动作");
      return true;
    },

    // 当前要操作的 bot：优先跟实时状态面板选中的那个保持一致。
    botId: function () {
      var sel = byId("telemetryBotSelect");
      if (sel && sel.value) return String(sel.value);
      try {
        if (window.state && Array.isArray(window.state.bots) && window.state.bots.length > 0) {
          return String(window.state.bots[0].id || "");
        }
      } catch (e) { /* 拿不到就交给主进程 */ }
      return "";
    },

    // 执行选中的动作：参数框里可以写 JSON，写错只提示、不发请求。
    run: function () {
      var sel = byId("actionSelect");
      var name = sel && sel.value ? String(sel.value) : "";
      if (name.length === 0) { setText("actionHint", t("actionPickFirst", "请先选择动作 / pick an action first")); return false; }
      var args = {};
      var input = byId("actionArgsInput");
      var raw = input && input.value ? String(input.value).replace(/^\s+|\s+$/g, "") : "";
      if (raw.length > 0) {
        try { args = JSON.parse(raw); } catch (err) {
          setText("actionHint", t("actionArgsBad", "参数不是合法 JSON / args is not valid JSON"));
          return false;
        }
        if (!args || typeof args !== "object") args = { value: args };
      }
      setText("actionHint", t("actionRunning", "执行中 / running: ") + name);
      try {
        if (window.api && typeof window.api.actionRun === "function") {
          window.api.actionRun({ botId: window.uiActions.botId(), name: name, args: args });
        }
      } catch (e) { setText("actionHint", "IPC failed / 通道异常"); return false; }
      return true;
    },

    // 显示动作结果（失败也是双语 message，直接照抄主进程那句）。
    show: function (res) {
      var r = res || {};
      var msg = r.message ? String(r.message) : (r.ok ? t("stateMachineDone", "操作完成 / done") : "no message / 无返回");
      var head = r.name || r.action ? String(r.name || r.action) + ": " : "";
      setText("actionHint", head + msg);
      logLine(head + msg, r.ok ? "info" : "warn");
      return true;
    }
  };
})();
