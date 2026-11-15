// ========================================
// 文件：gui/renderer/ui-telemetry.js
// 功能：实时状态面板——1 秒推送 / 挨打告警 / 最近事件，并把同一份快照喂给小地图
// 依赖：window.api（preload 暴露）、window.util、window.t（可选）、window.uiMap（可选）
// 导出：window.uiTelemetry（init / toggle / refresh / fill / renderCards / renderEvents / lastRow / alert）
// 说明：渲染进程不许 require；绑定幂等，重复 init 不会重复触发；所有取值都判空。
// 作者：MineBots
// ========================================

(function () {
  // 状态：是否正在推送 / 最近一份快照（小地图与手动驾驶都读它）。
  var watching = false;
  var lastRow = null;

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

  // 内部：元素只绑一次，返回是否真的绑上了。
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

  // 内部：读当前选中的 bot id（空串表示「第一个可用 bot」）。
  function botId() {
    var sel = byId("telemetryBotSelect");
    return sel && sel.value ? String(sel.value) : "";
  }

  // 内部：数值格式化——null / undefined 显示 "-"，数字保留一位小数。
  function fmt(value) {
    try {
      if (value === null || value === undefined) return "-";
      var n = Number(value);
      if (!isNaN(n)) return String(Math.round(n * 10) / 10);
      return String(value);
    } catch (e) { return "-"; }
  }

  // 内部：造一张状态卡（标签 + 数值 + 色调），全部走 createElement，数据不会当 HTML 解析。
  function makeCard(label, value, tone) {
    var box = document.createElement("div");
    box.className = "telemetry-card" + (tone ? " " + tone : "");
    var name = document.createElement("span");
    name.className = "telemetry-card-label";
    name.textContent = label;
    var num = document.createElement("span");
    num.className = "telemetry-card-value";
    num.textContent = value;
    box.appendChild(name);
    box.appendChild(num);
    return box;
  }

  // 内部：把一条事件渲染成一行（时间 + 类型 + 说明）。
  function makeEventLine(one) {
    var row = document.createElement("div");
    row.className = "telemetry-event";
    var time = "--:--:--";
    try {
      var d = new Date(one && one.at ? one.at : Date.now());
      time = String(d.getHours()) + ":" + ("0" + d.getMinutes()).slice(-2) + ":" + ("0" + d.getSeconds()).slice(-2);
    } catch (e) { time = "--:--:--"; }
    var type = one && one.type ? String(one.type) : "info";
    var text = one && one.message ? String(one.message) : "";
    if (type === "hurt" && text.length === 0) text = "被攻击 / hurt by " + String((one && one.attacker) || "?");
    row.textContent = "[" + time + "] " + type + (text ? " · " + text : "");
    return row;
  }

  window.uiTelemetry = {
    // 初始化：绑定按钮 / 下拉 + 订阅推送 + 先拉一次（全部幂等）。
    init: function () {
      window.uiTelemetry.bindButtons();
      window.uiTelemetry.bindListeners();
      window.uiTelemetry.refresh();
      return true;
    },

    // 绑定「开始推送 / 停止推送」与「刷新」两个按钮。
    bindButtons: function () {
      bindOnce(byId("telemetryToggleBtn"), "click", "telToggle", function () { window.uiTelemetry.toggle(); });
      bindOnce(byId("telemetryRefreshBtn"), "click", "telRefresh", function () { window.uiTelemetry.refresh(); });
      bindOnce(byId("telemetryBotSelect"), "change", "telBot", function () { window.uiTelemetry.refresh(); });
      return true;
    },

    // 订阅主进程推送：kind=alert 是挨打告警，其余按整表快照渲染。
    bindListeners: function () {
      try {
        if (window.api && typeof window.api.onTelemetry === "function") {
          window.api.onTelemetry(function (payload) {
            if (payload && payload.kind === "alert") { window.uiTelemetry.alert(payload); return; }
            window.uiTelemetry.fill(payload);
          });
        }
        if (window.botAPI && typeof window.botAPI.onBotList === "function") {
          window.botAPI.onBotList(function (res) {
            window.uiTelemetry.fillBots(res && res.bots ? res.bots : res);
          });
        }
      } catch (e) { /* 监听失败不影响面板其它功能 */ }
      return true;
    },

    // 拉一次最新快照（不依赖推送，第一次打开面板就有数据）。
    refresh: function () {
      try {
        if (window.api && typeof window.api.telemetryGet === "function") window.api.telemetryGet();
      } catch (e) { return false; }
      return true;
    },

    // 开关 1 秒推送：按钮文案跟着变，绝不偷偷开着推送。
    toggle: function () {
      watching = !watching;
      try {
        if (window.api && typeof window.api.telemetryWatch === "function") window.api.telemetryWatch(watching);
      } catch (e) { /* 通道异常只影响文案 */ }
      setText("telemetryToggleBtn", watching
        ? t("telemetryWatchOff", "停止推送")
        : t("telemetryWatchOn", "开始推送"));
      return watching;
    },

    // 回填 bot 下拉（保持已选中的 id，避免每秒推送把选择清掉）。
    fillBots: function (list) {
      var sel = byId("telemetryBotSelect");
      if (!sel) return false;
      var ids = [];
      try {
        var rows = Array.isArray(list) ? list : [];
        for (var i = 0; i < rows.length; i++) {
          var one = rows[i] || {};
          var id = String(one.id ? one.id : one);
          if (id.length > 0 && ids.indexOf(id) < 0) ids.push(id);
        }
      } catch (e) { ids = []; }
      var keep = sel.value ? String(sel.value) : "";
      try {
        sel.innerHTML = "";
        for (var j = 0; j < ids.length; j++) {
          var opt = document.createElement("option");
          opt.value = ids[j];
          opt.textContent = ids[j];
          sel.appendChild(opt);
        }
        if (keep.length > 0 && ids.indexOf(keep) >= 0) sel.value = keep;
      } catch (e2) { return false; }
      return true;
    },

    // 收下一份快照：{ ok, bots: [...] }；只渲染当前选中的那个 bot。
    fill: function (data) {
      var rows = null;
      try {
        if (!data) return false;
        if (Array.isArray(data)) rows = data;
        else if (Array.isArray(data.bots)) rows = data.bots;
        else rows = [data];
      } catch (e) { return false; }
      if (!rows || rows.length === 0) {
        lastRow = null;
        window.uiTelemetry.renderCards(null);
        window.uiTelemetry.renderEvents([]);
        return true;
      }
      var want = botId();
      var row = rows[0];
      for (var i = 0; i < rows.length; i++) {
        var one = rows[i] || {};
        if (want.length > 0 && String(one.id) === want) { row = one; break; }
      }
      lastRow = row || null;
      window.uiTelemetry.renderCards(lastRow);
      window.uiTelemetry.renderEvents(lastRow && lastRow.events ? lastRow.events : []);
      try {
        if (window.uiMap && typeof window.uiMap.render === "function") window.uiMap.render(lastRow);
      } catch (e2) { /* 小地图失败不影响数值面板 */ }
      return true;
    },

    // 渲染 10 张状态卡：血量 / 饥饿 / 等级 / 坐标 / 维度 / 时间 / 主手 / 副手 / 背包 / 附近。
    renderCards: function (row) {
      var box = byId("telemetryCards");
      if (!box) return false;
      try { box.innerHTML = ""; } catch (e) { return false; }
      if (!row) {
        var empty = document.createElement("div");
        empty.className = "telemetry-card";
        empty.textContent = t("telemetryEmpty", "(暂无数据，先启动机器人)");
        box.appendChild(empty);
        return true;
      }
      var health = row.health === null || row.health === undefined ? null : Number(row.health);
      var tone = "";
      if (health !== null && !isNaN(health)) tone = health <= 6 ? "bad" : (health <= 12 ? "warn" : "good");
      var pos = row.position || {};
      var exp = row.experience || {};
      var time = row.time || {};
      var main = row.mainHand || {};
      var off = row.offHand || {};
      var near = Array.isArray(row.nearby) ? row.nearby.length : 0;
      box.appendChild(makeCard("HP", fmt(health) + " / 20", tone));
      box.appendChild(makeCard("Food", fmt(row.food) + " / 20", ""));
      box.appendChild(makeCard("Lv", fmt(exp.level), ""));
      box.appendChild(makeCard("XYZ", fmt(pos.x) + " " + fmt(pos.y) + " " + fmt(pos.z), ""));
      box.appendChild(makeCard("Dim", row.dimension ? String(row.dimension) : "-", ""));
      box.appendChild(makeCard("Time", fmt(time.timeOfDay) + " " + fmt(time.phase), ""));
      box.appendChild(makeCard("Main", main.name ? String(main.name) + " x" + fmt(main.count) : "-", ""));
      box.appendChild(makeCard("Off", off.name ? String(off.name) + " x" + fmt(off.count) : "-", ""));
      box.appendChild(makeCard("Bag", fmt(row.inventorySlots), ""));
      box.appendChild(makeCard("Near", String(near), near > 0 ? "warn" : ""));
      return true;
    },

    // 渲染最近事件（新的在上，最多 6 条）。
    renderEvents: function (list) {
      var box = byId("telemetryEvents");
      if (!box) return false;
      try { box.innerHTML = ""; } catch (e) { return false; }
      var rows = Array.isArray(list) ? list : [];
      var limit = rows.length > 6 ? 6 : rows.length;
      for (var i = rows.length - 1; i >= rows.length - limit; i--) {
        if (i < 0) break;
        box.appendChild(makeEventLine(rows[i]));
      }
      return true;
    },

    // 挨打告警：在事件区最上面插一行提示（同时写一条 GUI 日志）。
    alert: function (payload) {
      var box = byId("telemetryEvents");
      var one = { at: Date.now(), type: "hurt", message: payload && payload.message ? String(payload.message) : "" };
      try {
        if (one.message.length === 0 && payload && payload.attacker) one.message = "被攻击 / attacked by " + String(payload.attacker);
        if (box) box.insertBefore(makeEventLine(one), box.firstChild);
      } catch (e) { /* 面板不在也继续写日志 */ }
      try {
        if (window.uiLog && window.uiLog.add) {
          window.uiLog.add({ time: window.util ? window.util.nowTime() : "", type: "SYSTEM", level: "warn", message: one.message });
        }
      } catch (e2) { /* 日志失败不影响告警 */ }
      return true;
    },

    // 给别的面板读最近一份快照（手动驾驶要用 yaw / pitch）。
    lastRow: function () { return lastRow; }
  };
})();
