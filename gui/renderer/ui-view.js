// ========================================
// 文件：gui/renderer/ui-view.js
// 功能：手动驾驶——方向键面板 / 键盘（WASD 与左手 IJKL·UOP·HY 双套键位）/ 快捷栏；3D 视角已废弃
// 依赖：window.api（preload 暴露）、window.util、window.uiTelemetry（读 yaw，可选）
// 导出：window.uiView（init / setEnabled / press / release / drive / look / hotbar / openViewer / stopViewer / show）
// 说明：渲染进程不许 require；所有按键事件都判 enabled，窗口失焦 / 关闭开关时一定发一次 release。
// 说明：openViewer / stopViewer / show 是「3D 视角已废弃」后的兼容占位接口（deprecated compatibility stubs），
//       不再绑定任何按钮、不再发送任何 IPC；保留仅为兼容旧调用方，界面只使用 2D 雷达。
// 作者：MineBots
// ========================================

(function () {
  // 状态：手动驾驶是否开启 / 当前按住的键（松手时要逐个复位）。
  var enabled = false;
  var held = {};

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
    } catch (e) { /* 日志失败不影响驾驶 */ }
  }

  // 内部：要操作的 bot——优先跟实时状态面板选中的那个一致。
  function botId() {
    var sel = byId("telemetryBotSelect");
    if (sel && sel.value) return String(sel.value);
    try {
      if (window.state && Array.isArray(window.state.bots) && window.state.bots.length > 0) {
        return String(window.state.bots[0].id || "");
      }
    } catch (e) { /* 拿不到就交给主进程 */ }
    return "";
  }

  // 内部：焦点在输入框里时不要抢键盘（否则打字会变成走路）。
  function typingNow() {
    try {
      var el = document.activeElement;
      if (!el || !el.tagName) return false;
      var tag = String(el.tagName).toUpperCase();
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
    } catch (e) { return false; }
  }

  // 内部：读当前视角（遥测行里的 yaw / pitch），读不到返回 { yaw:0, pitch:0 }。
  function currentView() {
    var view = {};
    try {
      var row = null;
      if (window.uiTelemetry && typeof window.uiTelemetry.lastRow === "function") row = window.uiTelemetry.lastRow();
      if (row && row.view) view = row.view;
    } catch (e) { view = {}; }
    var yaw = Number(view.yaw);
    var pitch = Number(view.pitch);
    return { yaw: isNaN(yaw) ? 0 : yaw, pitch: isNaN(pitch) ? 0 : pitch };
  }

  // 内部：发一条手动控制指令（任何异常都吞掉，绝不抛到顶层）。
  function send(payload) {
    try {
      if (window.api && typeof window.api.manualControl === "function") {
        window.api.manualControl(payload || {});
        return true;
      }
    } catch (e) { /* 通道异常只影响这一下按键 */ }
    return false;
  }

  // 内部：默认键位提示（中英双语，手动驾驶关掉时显示）。
  function driveHintText() {
    return "左手 I/J/K/L 前后左右 U 跳 O 抬头 P 低头 H 攻击 Y 使用 / IJKL move, U jump, O/P look, H attack, Y use" +
      "；原版 W A S D 照旧，1-9 快捷栏，滚轮转视角 / WASD still works, 1-9 hotbar, wheel to look";
  }

  window.uiView = {
    // 初始化：绑开关 / 方向盘 / 键盘 / 滚轮 / 视角按钮（全部幂等）。
    init: function () {
      window.uiView.bindButtons();
      window.uiView.bindPad();
      window.uiView.bindKeys();
      setText("driveHint", driveHintText());
      setText("viewerBotLabel", t("viewerBotLabel", "目标机器人 / Target bot") + ": " + (botId() || "(未选择 / none)"));
      return true;
    },

    // 绑定「手动驾驶开关」；3D 视角按钮已废弃，刻意不绑定任何点击事件 / deprecated, no binding.
    bindButtons: function () {
      bindOnce(byId("manualDriveToggle"), "change", "driveToggle", function (ev) {
        var on = !!(ev && ev.target && ev.target.checked);
        window.uiView.setEnabled(on);
      });
      return true;
    },

    // 绑定方向键面板：按下就走，抬手 / 移出 / 取消都松开。
    bindPad: function () {
      var pad = byId("drivePad");
      if (!pad) return false;
      var keys = [];
      try { keys = pad.querySelectorAll("[data-drive]"); } catch (e) { keys = []; }
      for (var i = 0; i < keys.length; i++) {
        (function (btn) {
          var name = btn.getAttribute ? String(btn.getAttribute("data-drive") || "") : "";
          if (name.length === 0) return;
          bindOnce(btn, "pointerdown", "padDown_" + name, function (ev) {
            if (ev && ev.preventDefault) ev.preventDefault();
            window.uiView.drive(name, true);
          });
          bindOnce(btn, "pointerup", "padUp_" + name, function () { window.uiView.drive(name, false); });
          bindOnce(btn, "pointerleave", "padOut_" + name, function () { window.uiView.drive(name, false); });
          bindOnce(btn, "pointercancel", "padCancel_" + name, function () { window.uiView.drive(name, false); });
        })(keys[i]);
      }
      return true;
    },

    // 绑定键盘（只在开启手动驾驶且焦点不在输入框时生效）与滚轮转视角。
    bindKeys: function () {
      try {
        document.addEventListener("keydown", function (ev) { window.uiView.onKey(ev, true); });
        document.addEventListener("keyup", function (ev) { window.uiView.onKey(ev, false); });
        document.addEventListener("wheel", function (ev) { window.uiView.onWheel(ev); }, { passive: true });
        window.addEventListener("blur", function () { window.uiView.release(); });
      } catch (e) { return false; }
      return true;
    },

    // 语言切换 / 面板重绘后刷新静态文案（驾驶提示、目标机器人），不改任何驾驶状态。
    refreshText: function () {
      setText("driveHint", enabled
        ? t("driveHintOn", "手动驾驶已开启 / manual driving on")
        : driveHintText());
      setText("viewerBotLabel", t("viewerBotLabel", "目标机器人 / Target bot") + ": " + (botId() || "(未选择 / none)"));
      return true;
    },

    // 开关手动驾驶：关掉时立刻松开所有键，避免机器人一直往前走。
    setEnabled: function (on) {
      enabled = on === true;
      if (!enabled) window.uiView.release();
      setText("driveHint", enabled
        ? t("driveHintOn", "手动驾驶已开启 / manual driving on")
        : driveHintText());
      return enabled;
    },

    // 按下 / 松开一个控制位（按住不重复发，避免刷屏）。
    press: function (key, on) {
      var name = String(key || "").toLowerCase();
      if (name.length === 0) return false;
      var down = on === true;
      if (down === (held[name] === true)) return true;
      held[name] = down;
      return send({ botId: botId(), action: "press", key: name, on: down });
    },

    // 松开全部按住的键（切 bot、关面板、窗口失焦都必须调）。
    release: function () {
      held = {};
      return send({ botId: botId(), action: "release" });
    },

    // 方向盘按钮：7 个控制位走 press，攻击 / 使用走一次性动作。
    drive: function (name, on) {
      var key = String(name || "").toLowerCase();
      if (key === "attack" || key === "use") {
        if (on !== true) return true;
        return send({ botId: botId(), action: key });
      }
      return window.uiView.press(key, on === true);
    },

    // 键盘事件 → 控制位 / 视角 / 快捷栏 / 攻击 / 使用（输入框里打字时一律不拦）。
    // 键位：原版 W A S D / Space / Shift / Ctrl 照旧；左手再加 I J K L 移动、U 跳、O 抬头、P 低头、H 攻击、Y 使用。
    onKey: function (ev, down) {
      if (!ev || !enabled || typingNow()) return false;
      var code = String(ev.code || "");
      var key = String(ev.key || "").toLowerCase();
      var map = {
        KeyW: "forward", KeyS: "back", KeyA: "left", KeyD: "right",
        Space: "jump", ShiftLeft: "sneak", ShiftRight: "sneak",
        ControlLeft: "sprint", ControlRight: "sprint",
        KeyI: "forward", KeyK: "back", KeyJ: "left", KeyL: "right", KeyU: "jump"
      };
      var control = map[code] || "";
      if (control.length > 0) {
        if (ev.preventDefault) ev.preventDefault();
        return window.uiView.press(control, down);
      }
      if (down !== true) return false;
      if (key === "o") { if (ev.preventDefault) ev.preventDefault(); return window.uiView.lookBy(0, -0.15); }
      if (key === "p") { if (ev.preventDefault) ev.preventDefault(); return window.uiView.lookBy(0, 0.15); }
      if (key === "h") { if (ev.preventDefault) ev.preventDefault(); send({ botId: botId(), action: "attack" }); return true; }
      if (key === "y") { if (ev.preventDefault) ev.preventDefault(); send({ botId: botId(), action: "use" }); return true; }
      if (/^[1-9]$/.test(key)) { window.uiView.hotbar(Number(key) - 1); return true; }
      return false;
    },

    // 在当前视角基础上偏移（O 抬头 / P 低头用；读不到当前视角就从 0 起算）。
    lookBy: function (dyaw, dpitch) {
      var view = currentView();
      var yawStep = Number(dyaw);
      var pitchStep = Number(dpitch);
      if (isNaN(yawStep)) yawStep = 0;
      if (isNaN(pitchStep)) pitchStep = 0;
      return window.uiView.look(view.yaw + yawStep, view.pitch + pitchStep);
    },

    // 滚轮：纵向滚动转视角（一次 0.08 弧度，越滚越顺）。
    onWheel: function (ev) {
      if (!ev || !enabled) return false;
      var delta = Number(ev.deltaY) || 0;
      if (delta === 0) return false;
      var view = currentView();
      return window.uiView.look(view.yaw + (delta > 0 ? 0.08 : -0.08), view.pitch);
    },

    // 切快捷栏第 slot 格（0 起）。
    hotbar: function (slot) {
      return send({ botId: botId(), action: "hotbar", slot: slot });
    },

    // 设置视角（弧度）。
    look: function (yaw, pitch) {
      return send({ botId: botId(), action: "look", yaw: yaw, pitch: pitch });
    },

    // 兼容占位：3D 视角已废弃，只回一句双语提示，绝不发 IPC / deprecated stub, never sends IPC.
    openViewer: function () {
      try { setText("viewerHint", "3D 视角已废弃，请使用 2D 雷达 / 3D view deprecated, use 2D radar"); }
      catch (e) { /* 元素不存在也无所谓 / element optional */ }
      return false;
    },

    // 兼容占位：3D 视角已废弃，关闭同样不发 IPC / deprecated stub, never sends IPC.
    stopViewer: function () {
      try { setText("viewerHint", "3D 视角已废弃 / 3D view deprecated"); }
      catch (e) { /* 元素不存在也无所谓 / element optional */ }
      return false;
    },

    // 兼容占位：3D 视角回包已无来源，保留仅为旧调用方不报错 / deprecated stub, kept for compatibility.
    show: function (res) {
      var r = res || {};
      try {
        setText("viewerHint", r && r.message ? String(r.message) : "3D 视角已废弃 / 3D view deprecated");
      } catch (e) { /* 元素不存在也无所谓 / element optional */ }
      return false;
    },

    // 供别的面板查询当前是否开着手动驾驶。
    isEnabled: function () { return enabled; }
  };
})();
