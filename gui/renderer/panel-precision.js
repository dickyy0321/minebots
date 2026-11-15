// ========================================
// 文件：gui/renderer/panel-precision.js
// 功能：动作面板【精准模式】双控件——engExactBuild 开关 + redstoneTickRate 滑块 / 数字框；
//       改动走既有 param-set IPC，主进程 param-manager.set 写 state/params.json 后
//       经事件总线广播 param.changed / engine.<key>.changed 并同步 prefs.save（再广播 engine.changed），
//       底层 motion / actions / redstone-trigger 下一次调用立即生效，无需重启
// 依赖：无（渲染层禁止 require；只用 window.api / document / window.dispatchEvent）
// 导出：window.panelPrecision = { init / build / fill / save / stats / KEYS / LIMITS / EVENT }
// 作者：MineBots
// ========================================
//
// 为什么单独一个面板模块 / why a separate module
//   1. 动作面板只加节点，不重写 ui-actions / panel-engine 的任何逻辑（接线而非重写）。
//   2. 渲染层不能 require 主进程模块，所以走 window.api.paramSet 这条已存在的真实 IPC 通道。
//   3. 除主进程事件总线广播外，渲染层再发一次 DOM 自定义事件，保证同一窗口内其他面板即时同步。
// CommonJS 无关（浏览器全局脚本），ES5 风格，无中文变量名

(function () {
  // 常量：两个全局键 / 红石频率合法范围 / 渲染层本地事件名。
  var KEYS = { exact: "engExactBuild", tick: "redstoneTickRate" };
  var LIMITS = { min: 10, max: 1000, step: 10, def: 50 };
  var EVENT = "minebots:precision.changed";

  // 状态：是否已构建 / 最后一次回填的偏好 / 是否已绑过事件。
  var built = false;
  var lastPrefs = {};
  var bound = false;

  // 内部：按 id 取元素；DOM 不可用时返回 null，绝不抛到上层。
  function byId(id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  }

  // 内部：双语词条；字典缺失时回落默认中文文本。
  function t(key, fallback) {
    try {
      if (window.t) {
        var text = window.t(key);
        if (text && text !== key) return String(text);
      }
    } catch (e) { /* 字典缺失用回落 */ }
    return fallback;
  }

  // 内部：写面板底部状态行（双语）。
  function setStatus(text) {
    try {
      var box = byId("precisionStatus");
      if (box) box.textContent = text;
      return !!box;
    } catch (e) { return false; }
  }

  // 内部：把红石频率夹到 10~1000ms，坏值回默认 50ms。
  function clampTick(value) {
    var n = Number(value);
    if (isNaN(n) || !isFinite(n)) n = LIMITS.def;
    if (n < LIMITS.min) n = LIMITS.min;
    if (n > LIMITS.max) n = LIMITS.max;
    return Math.round(n);
  }

  // 内部：同步滑块 / 数字框 / 数值标签，返回最终数值。
  function showTick(value) {
    var n = clampTick(value);
    var range = byId("precisionTickRange");
    var number = byId("precisionTickNumber");
    var val = byId("precisionTickValue");
    try { if (range) range.value = String(n); } catch (e1) { /* ignore */ }
    try { if (number) number.value = String(n); } catch (e2) { /* ignore */ }
    try { if (val) val.textContent = n + " ms / " + t("precisionTickUnit", "毫秒"); } catch (e3) { /* ignore */ }
    return n;
  }

  // 内部：把开关状态显示成双语文字；引擎开关用同一套 .engine-switch 样式。
  function showExact(on) {
    var hint = byId("precisionExactHint");
    try { if (hint) hint.textContent = on ? "开 / ON" : "关 / OFF"; } catch (e) { /* ignore */ }
    return !!on;
  }

  // 内部：渲染层本地广播——让同窗口其它面板也能订阅这次变更。
  function emitLocal(key, value) {
    try {
      if (window.dispatchEvent && typeof window.CustomEvent === "function") {
        window.dispatchEvent(new window.CustomEvent(EVENT, {
          detail: { key: key, value: value, at: Date.now() }
        }));
      }
    } catch (e) { /* 广播失败不影响落盘 */ }
  }

  // 功能：提交一个键值到主进程（真写盘 + 主进程事件总线广播）；返回是否发出。
  function save(key, value) {
    try {
      if (window.api && typeof window.api.paramSet === "function") {
        window.api.paramSet({ key: key, value: value });
        emitLocal(key, value);
        setStatus("已保存并经事件总线广播 / saved & broadcast: " + key + " = " + value);
        return true;
      }
    } catch (e) { /* 通道缺失只降级提示 */ }
    setStatus("参数通道未接线 / param API unavailable");
    return false;
  }

  // 功能：绑定两个控件的事件（幂等）；返回成功绑定的控件数。
  function build() {
    if (bound) return 2;
    var count = 0;
    try {
      var toggle = byId("precisionExactToggle");
      if (toggle) {
        toggle.checked = false;
        toggle.addEventListener("change", function () {
          showExact(toggle.checked);
          save(KEYS.exact, toggle.checked === true);
        });
        count = count + 1;
      }
      var range = byId("precisionTickRange");
      var number = byId("precisionTickNumber");
      if (range) {
        range.addEventListener("input", function () { showTick(range.value); });
        range.addEventListener("change", function () { save(KEYS.tick, showTick(range.value)); });
        count = count + 1;
      }
      if (number) {
        number.addEventListener("change", function () { save(KEYS.tick, showTick(number.value)); });
      }
      showTick(LIMITS.def);
      showExact(false);
      bound = true;
      built = count > 0;
      return count;
    } catch (e) { return 0; }
  }

  // 功能：用主进程 prefs-data 回包回填两个控件；返回回填成功的控件数。
  function fill(data) {
    var prefs = data && typeof data === "object" ? data : {};
    lastPrefs = prefs;
    var filled = 0;
    try {
      if (typeof prefs[KEYS.exact] === "boolean") {
        var toggle = byId("precisionExactToggle");
        if (toggle) { toggle.checked = prefs[KEYS.exact]; filled = filled + 1; }
        showExact(prefs[KEYS.exact]);
      }
      showTick(prefs[KEYS.tick] === undefined ? LIMITS.def : prefs[KEYS.tick]);
      if (prefs[KEYS.tick] !== undefined) filled = filled + 1;
      setStatus(t("precisionReady", "精准面板已加载 / precision panel loaded · 改动即时生效 / changes apply live"));
    } catch (e) { /* 回填失败不抛到上层 */ }
    return filled;
  }

  // 功能：初始化——建控件、拉一次真实偏好；可重复调用，不重复绑定。
  function init() {
    var count = build();
    try { if (window.api && typeof window.api.prefsLoad === "function") window.api.prefsLoad(); }
    catch (e) { /* 通道缺失不影响面板构建 */ }
    return { ok: built, controls: count, keys: [KEYS.exact, KEYS.tick], message: "precision panel ready / 精准面板就绪" };
  }

  // 功能：状态快照（自测与实机验证用）。
  function stats() {
    var toggle = byId("precisionExactToggle");
    var number = byId("precisionTickNumber");
    return {
      built: built, bound: bound, event: EVENT,
      exact: toggle ? toggle.checked === true : false,
      tickMs: number ? clampTick(number.value) : LIMITS.def,
      prefs: lastPrefs
    };
  }

  window.panelPrecision = {
    init: init,
    build: build,
    fill: fill,
    save: save,
    stats: stats,
    KEYS: KEYS,
    LIMITS: LIMITS,
    EVENT: EVENT
  };
})();
