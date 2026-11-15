// ========================================
// 文件：gui/renderer/panel-engine.js
// 功能：专家模式【底层引擎控制】面板——七大模块独立 Toggle + 参数滑块，一改即写 state/prefs.json 并实时生效
// 依赖：无（渲染层禁止 require；只用 window.api / document）
// 导出：window.panelEngine = { init / build / fill / save / resetAll / stats / DEFAULTS }
// 作者：MineBots
// ========================================
//
// 与 modules/engine-control.js 的关系 / relation
//   这里的 ENGINES 是引擎注册表在渲染层的镜像（渲染层不能 require 主进程模块）。
//   改动走既有的 prefs-load / prefs-save IPC 三件套，不新增通道；主进程 prefs.save() 落盘后
//   广播 engine.changed，七个底层模块在各自入口读 modules/engine-control.js，下一次调用立刻生效。
// CommonJS 无关（浏览器全局脚本），ES5 风格，无中文变量名

(function () {
  // 常量：七大引擎的面板定义；flag 是 prefs 开关键，params 是滑块 / 数字框定义。
  var ENGINES = [
    {
      key: "radar", flag: "engRadar",
      label: "2D 雷达与实体追踪 / 2D Radar & Tracking",
      note: "关闭后遥测快照不再推送雷达数据 / Off: no radar data pushed",
      params: [
        { key: "radarRadius", label: "雷达范围 / Radar range", min: 16, max: 128, step: 8, def: 64, unit: "格 / blocks" }
      ]
    },
    {
      key: "motion", flag: "engMotion",
      label: "拟真动作（高斯噪声 / 延迟） / Humanized Motion",
      note: "关闭后动作无噪声、无随机延迟 / Off: no noise, no random delay",
      params: [
        { key: "motionStrength", label: "拟真强度 / Humanize level", min: 1, max: 10, step: 1, def: 5, unit: "级 / level" },
        { key: "motionDelayMs", label: "动作延迟 / Action delay", min: 50, max: 500, step: 10, def: 150, unit: "毫秒 / ms" }
      ]
    },
    {
      key: "trace", flag: "engTrace",
      label: "全链路 Trace 追踪 / Full-chain Trace",
      note: "仅测试模式生效 / Active in test mode only",
      params: [
        { key: "traceFailureRate", label: "故障注入率 / Fault injection", min: 0, max: 100, step: 1, def: 10, unit: "%" }
      ]
    },
    {
      key: "antiStuck", flag: "engAntiStuck",
      label: "自动防卡死自救 / Anti-stuck Rescue",
      note: "关闭后不再挂看门狗定时器 / Off: watchdog not armed",
      params: [
        { key: "antiStuckWatchdogMs", label: "看门狗间隔 / Watchdog interval", min: 500, max: 10000, step: 100, def: 3000, unit: "毫秒 / ms" },
        { key: "antiStuckMaxRescues", label: "自救次数上限 / Max rescues", min: 1, max: 10, step: 1, def: 3, unit: "次 / times" }
      ]
    },
    {
      key: "typing", flag: "typing",
      label: "打字机（防刷屏） / Anti-spam Typewriter",
      note: "关闭后整句一次发出；单条最多 3 段 / Off: send whole message at once",
      params: [
        { key: "typingCps", label: "打字速度 / Typing speed", min: 5, max: 120, step: 1, def: 30, unit: "字/秒 / cps" },
        { key: "typingChunk", label: "单段字数 / Chunk size", min: 3, max: 60, step: 1, def: 12, unit: "字 / chars" }
      ]
    },
    {
      key: "protocolForge", flag: "engProtocolForge",
      label: "协议穿透 / Protocol Forge",
      note: "关闭后不做品牌伪装与模组重试 / Off: no brand spoof, no mod retry",
      params: [
        { key: "protocolMaxRetry", label: "模组重试上限 / Mod retry limit", min: 0, max: 10, step: 1, def: 3, unit: "次 / times" }
      ]
    },
    {
      key: "behaviorTree", flag: "engBehaviorTree",
      label: "行为树状态机（含 GOAP） / Behavior Tree & GOAP",
      note: "关闭后不执行节点、不产出规划链 / Off: no ticks, no plans",
      params: [
        { key: "behaviorMaxTicks", label: "单次节点预算 / Tick budget", min: 20, max: 1000, step: 10, def: 200, unit: "节点 / nodes" }
      ]
    }
  ];

  // 常量：恢复默认用的补丁（与 modules/prefs.js 的 DEFAULTS 引擎部分一致）。
  var DEFAULTS = {};
  for (var di = 0; di < ENGINES.length; di++) {
    DEFAULTS[ENGINES[di].flag] = true;
    for (var dj = 0; dj < ENGINES[di].params.length; dj++) {
      DEFAULTS[ENGINES[di].params[dj].key] = ENGINES[di].params[dj].def;
    }
  }
  // 精确建筑默认关：开启后拟真噪声归零，与默认全开的七大引擎分开渲染。
  DEFAULTS.engExactBuild = false;

  // 状态：是否已构建 / 最后一次回填的偏好 / 控件计数。
  var built = false;
  var lastPrefs = {};
  var controlCount = 0;

  // 内部：按 id 取元素，取不到返回 null。
  function byId(id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  }

  // 内部：写面板底部状态行（双语），缺元素时静默。
  function setStatus(text) {
    var box = byId("engineStatus");
    if (!box) return false;
    try { box.textContent = text; return true; } catch (e) { return false; }
  }

  // 内部：建一个元素并挂 class / 属性，DOM 异常时返回 null。
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

  // 内部：把数值夹到合法范围，坏值回默认值。
  function clamp(value, spec) {
    var n = Number(value);
    if (isNaN(n)) n = spec.def;
    if (n < spec.min) n = spec.min;
    if (n > spec.max) n = spec.max;
    return Math.round(n);
  }

  // 功能：提交一个键值到主进程（真写 state/prefs.json）；返回是否发出。
  function save(key, value) {
    try {
      var patch = {};
      patch[key] = value;
      if (window.api && typeof window.api.prefsSave === "function") {
        window.api.prefsSave(patch);
        setStatus("已保存并实时生效 / saved & applied: " + key + " = " + value);
        return true;
      }
    } catch (e) { /* 通道缺失只降级提示 */ }
    setStatus("保存通道未接线 / prefs API unavailable");
    return false;
  }

  // 内部：构建一个引擎卡片——标题 + Toggle + 说明 + 若干参数行。
  function buildCard(engine, host) {
    var card = el("div", "engine-card", { "data-engine": engine.key });
    if (!card) return 0;
    var head = el("div", "engine-head");
    var name = el("span", "engine-name");
    if (name) name.textContent = engine.label;
    var toggle = el("input", "engine-switch", {
      type: "checkbox", "data-flag": engine.flag, "aria-label": engine.label
    });
    if (toggle) {
      toggle.checked = true;
      toggle.addEventListener("change", function () {
        if (card.classList) {
          if (toggle.checked) card.classList.remove("engine-off");
          else card.classList.add("engine-off");
        }
        save(engine.flag, toggle.checked);
      });
    }
    if (head) {
      if (name) head.appendChild(name);
      if (toggle) head.appendChild(toggle);
      card.appendChild(head);
    }
    var note = el("div", "engine-note cmd-hint");
    if (note) { note.textContent = engine.note; card.appendChild(note); }
    var made = toggle ? 1 : 0;
    for (var i = 0; i < engine.params.length; i++) {
      if (buildParam(engine.params[i], card)) made = made + 1;
    }
    try { host.appendChild(card); } catch (e) { return 0; }
    return made;
  }

  // 内部：构建一个参数行——滑块 + 数字框 + 实时数值标签；change 时才落盘，不刷写。
  function buildParam(spec, card) {
    var row = el("div", "engine-param", { "data-param": spec.key });
    if (!row) return false;
    var label = el("label", "engine-param-label");
    if (label) label.textContent = spec.label;
    var range = el("input", "engine-range", {
      type: "range", min: spec.min, max: spec.max, step: spec.step, value: spec.def, "data-key": spec.key
    });
    var number = el("input", "engine-number", {
      type: "number", min: spec.min, max: spec.max, step: spec.step, value: spec.def, "data-key": spec.key
    });
    var val = el("span", "engine-val");
    var show = function (raw) {
      var n = clamp(raw, spec);
      if (range) range.value = String(n);
      if (number) number.value = String(n);
      if (val) val.textContent = n + " " + spec.unit;
      return n;
    };
    show(spec.def);
    if (range) {
      range.addEventListener("input", function () { show(range.value); });
      range.addEventListener("change", function () { save(spec.key, show(range.value)); });
    }
    if (number) {
      number.addEventListener("change", function () { save(spec.key, show(number.value)); });
    }
    try {
      if (label) row.appendChild(label);
      if (range) row.appendChild(range);
      if (number) row.appendChild(number);
      if (val) row.appendChild(val);
      card.appendChild(row);
      return true;
    } catch (e) { return false; }
  }

  // 内部：构建【精确建筑】独立开关卡片（不进七大引擎注册表）；默认关，改动真落盘。
  function buildExactCard(host) {
    try {
      var card = el("div", "engine-card", { "data-engine": "exactBuild" });
      if (!card) return 0;
      var label = "精确建筑（毫米级放置） / Exact Build (millimeter placement)";
      var head = el("div", "engine-head");
      var name = el("span", "engine-name");
      if (name) name.textContent = label;
      var toggle = el("input", "engine-switch", {
        type: "checkbox", "data-flag": "engExactBuild", "aria-label": label
      });
      if (toggle) {
        toggle.checked = false;
        toggle.addEventListener("change", function () { save("engExactBuild", toggle.checked); });
      }
      if (head) {
        if (name) head.appendChild(name);
        if (toggle) head.appendChild(toggle);
        card.appendChild(head);
      }
      var note = el("div", "engine-note cmd-hint");
      if (note) {
        note.textContent = "开启后强制关闭高斯噪声 / 手抖 / 随机延迟 / ON: zero noise, jitter and random delay";
        card.appendChild(note);
      }
      host.appendChild(card);
      return toggle ? 1 : 0;
    } catch (e) { return 0; }
  }

  // 功能：构建整个面板（幂等）；返回控件总数。
  function build() {
    if (built) return controlCount;
    var host = byId("engineControls");
    if (!host) return 0;
    try {
      controlCount = 0;
      for (var i = 0; i < ENGINES.length; i++) controlCount = controlCount + buildCard(ENGINES[i], host);
      controlCount = controlCount + buildExactCard(host);
      built = controlCount > 0;
      return controlCount;
    } catch (e) { return 0; }
  }

  // 功能：用主进程回包回填所有 Toggle 与参数；返回成功回填的控件数。
  function fill(data) {
    var prefs = data && typeof data === "object" ? data : {};
    lastPrefs = prefs;
    var filled = 0;
    try {
      for (var i = 0; i < ENGINES.length; i++) {
        var engine = ENGINES[i];
        var toggle = document.querySelector('.engine-switch[data-flag="' + engine.flag + '"]');
        if (toggle && typeof prefs[engine.flag] === "boolean") {
          toggle.checked = prefs[engine.flag];
          filled = filled + 1;
          var card = toggle.parentNode && toggle.parentNode.parentNode ? toggle.parentNode.parentNode : null;
          if (card && card.classList) {
            if (toggle.checked) card.classList.remove("engine-off");
            else card.classList.add("engine-off");
          }
        }
        for (var j = 0; j < engine.params.length; j++) {
          var spec = engine.params[j];
          if (typeof prefs[spec.key] !== "number") continue;
          var n = clamp(prefs[spec.key], spec);
          var range = document.querySelector('.engine-range[data-key="' + spec.key + '"]');
          var number = document.querySelector('.engine-number[data-key="' + spec.key + '"]');
          var val = document.querySelector('.engine-param[data-param="' + spec.key + '"] .engine-val');
          if (range) range.value = String(n);
          if (number) number.value = String(n);
          if (val) val.textContent = n + " " + spec.unit;
          filled = filled + 1;
        }
      }
      var exact = document.querySelector('.engine-switch[data-flag="engExactBuild"]');
      if (exact && typeof prefs.engExactBuild === "boolean") { exact.checked = prefs.engExactBuild; filled = filled + 1; }
      setStatus("引擎控制已加载 / engine control loaded · 改动即时生效 / changes apply live");
    } catch (e) { /* 回填失败不抛到上层 */ }
    return filled;
  }

  // 功能：恢复七大引擎默认全开与默认参数；返回是否发出。
  function resetAll() {
    try {
      if (window.api && typeof window.api.prefsSave === "function") {
        window.api.prefsSave(DEFAULTS);
        fill(DEFAULTS);
        setStatus("已恢复默认全开 / restored all engines ON");
        return true;
      }
    } catch (e) { /* 通道缺失只降级 */ }
    return false;
  }

  // 功能：初始化——建面板、绑恢复按钮、拉一次真实偏好；可重复调用。
  function init() {
    var count = build();
    var btn = byId("engineResetBtn");
    if (btn && !btn._mbEngineBound) {
      btn._mbEngineBound = true;
      try { btn.addEventListener("click", function () { resetAll(); }); } catch (e) { /* ignore */ }
    }
    try { if (window.api && typeof window.api.prefsLoad === "function") window.api.prefsLoad(); }
    catch (e) { /* 通道缺失不影响面板构建 */ }
    return { ok: built, controls: count, engines: ENGINES.length, message: "engine panel ready / 引擎面板就绪" };
  }

  // 功能：状态快照（自测与实机验证用）。
  function stats() {
    var on = 0;
    try {
      var toggles = document.querySelectorAll(".engine-switch");
      for (var i = 0; i < toggles.length; i++) if (toggles[i].checked) on = on + 1;
    } catch (e) { on = 0; }
    return { built: built, engines: ENGINES.length, toggles: on, controls: controlCount, prefs: lastPrefs };
  }

  window.panelEngine = {
    init: init,
    build: build,
    fill: fill,
    save: save,
    resetAll: resetAll,
    stats: stats,
    DEFAULTS: DEFAULTS,
    ENGINES: ENGINES
  };
})();
