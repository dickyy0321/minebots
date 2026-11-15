// ========================================
// 文件：gui/renderer/ui-mode.js
// 功能：双模式 UI——【新手模式】只留常用项，【专家模式】用可折叠面板收纳全部高级参数
// 依赖：无（只用 window / document / localStorage；渲染层禁止 require）
// 导出：window.uiMode（init / get / set / toggle / apply / stats）
// 说明：不搬动 DOM 节点，只切换 class 与属性，既有事件绑定与 id 查询全部保持有效。
// 作者：MineBots
// ========================================

(function () {
  // 常量：本地存储键 / 两种合法模式 / 面板选择器。
  var STORAGE_KEY = "minebots-ui-mode";
  var NOVICE = "novice";
  var EXPERT = "expert";
  // 抽屉已废弃：全屏设置页的右侧内容区就是分组容器，找不到时退回旧抽屉（兼容老页面）。
  var PANEL_SELECTOR = "#settingsContent";

  // 状态：是否已初始化 / 分组缓存 / 用户手动折叠过的分组下标。
  var inited = false;
  var groups = [];
  var manualClosed = {};
  var manualOpened = {};

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

  // 内部：读持久化模式，坏值一律回新手模式。
  function readSaved() {
    try {
      var value = localStorage.getItem(STORAGE_KEY);
      if (value === EXPERT) return EXPERT;
      return NOVICE;
    } catch (e) { return NOVICE; }
  }

  // 内部：写持久化模式，失败只降级为内存态。
  function writeSaved(mode) {
    try { localStorage.setItem(STORAGE_KEY, mode); return true; } catch (e) { return false; }
  }

  // 内部：收集一个 h3 之后、下一个 h3 之前的全部兄弟元素，作为该分组的内容。
  function collectGroup(head) {
    var items = [];
    try {
      var node = head.nextSibling;
      while (node) {
        if (node.nodeType === 1 && String(node.tagName).toUpperCase() === "H3") break;
        if (node.nodeType === 1) items.push(node);
        node = node.nextSibling;
      }
    } catch (e) { /* 返回已收集部分 */ }
    return items;
  }

  // 内部：扫描高级面板里的直接子级 h3，建立分组缓存；重复调用不重复建。
  function scanGroups() {
    groups = [];
    try {
      var body = document.querySelector(PANEL_SELECTOR) || byId("settingsContent");
      if (!body) return groups.length;
      var heads = body.querySelectorAll("h3");
      for (var i = 0; i < heads.length; i++) {
        var head = heads[i];
        // h3 可能嵌在 .adv-pane 等二级容器里，分组按「同父级下的后续兄弟」计算，不要求直接子级。
        head.classList.add("expert-fold-head");
        head.setAttribute("role", "button");
        head.setAttribute("tabindex", "0");
        groups.push({ index: groups.length, head: head, items: collectGroup(head), text: String(head.textContent || "") });
      }
      // 从后往前绑定，闭包捕获各自分组，避免循环变量串味。
      for (var j = groups.length - 1; j >= 0; j--) {
        (function (group) {
          var flip = function () {
            try {
              var open = group.head.getAttribute("aria-expanded") === "true";
              if (open) manualClosed[group.index] = true;
              else { delete manualClosed[group.index]; manualOpened[group.index] = true; }
              setGroupOpen(group, !open);
              return !open;
            } catch (e) { return false; }
          };
          group.head.addEventListener("click", flip);
          group.head.addEventListener("keydown", function (ev) {
            try { if (ev && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); flip(); } } catch (e) { /* ignore */ }
          });
        }(groups[j]));
      }
    } catch (e) { /* 分组扫描失败不影响页面 */ }
    return groups.length;
  }

  // 内部：展开 / 折叠一个分组，只切 class 与 aria 属性，不移动任何 DOM 节点。
  function setGroupOpen(group, open) {
    try {
      group.head.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) group.head.classList.add("open");
      else group.head.classList.remove("open");
      for (var i = 0; i < group.items.length; i++) {
        if (open) group.items[i].classList.remove("fold-hidden");
        else group.items[i].classList.add("fold-hidden");
      }
      return true;
    } catch (e) { return false; }
  }

  // 内部：判断某分组是不是雷达分组（新手模式也要保持展开，方便看 2D 雷达）。
  function isRadarGroup(group) {
    try {
      var text = String(group.text || "").toLowerCase();
      return text.indexOf("地图") >= 0 || text.indexOf("map") >= 0 || text.indexOf("雷达") >= 0 || text.indexOf("radar") >= 0;
    } catch (e) { return false; }
  }

  // 内部：更新模式按钮文案（中英双语）与 aria 状态。
  function updateButton(mode) {
    var btn = byId("modeBtn");
    if (!btn) return false;
    try {
      if (mode === EXPERT) btn.textContent = t("modeExpert", "专家模式 / Expert");
      else btn.textContent = t("modeNovice", "新手模式 / Novice");
      btn.setAttribute("data-mode", mode);
      btn.setAttribute("aria-label", t("modeSwitch", "切换界面模式 / Switch UI mode"));
      return true;
    } catch (e) { return false; }
  }

  // 功能：把当前模式应用到页面（body class + 分组折叠状态 + 按钮文案）；返回模式名。
  function apply() {
    var mode = readSaved();
    try {
      if (document.body) {
        document.body.classList.remove("mode-novice", "mode-expert");
        document.body.classList.add(mode === EXPERT ? "mode-expert" : "mode-novice");
      }
      for (var i = 0; i < groups.length; i++) {
        var group = groups[i];
        var open;
        if (manualClosed[group.index]) open = false;
        else if (manualOpened[group.index]) open = true;
        else open = mode === EXPERT ? true : isRadarGroup(group);
        setGroupOpen(group, open);
      }
      updateButton(mode);
    } catch (e) { /* 应用失败不影响页面其它功能 */ }
    return mode;
  }

  // 功能：读当前模式，返回 "novice" / "expert"。
  function get() { return readSaved(); }

  // 功能：设置模式（非法值按新手处理），清掉手动折叠记忆并重新应用；返回 { ok, mode, message }。
  function set(mode) {
    var next = mode === EXPERT ? EXPERT : NOVICE;
    try {
      writeSaved(next);
      manualClosed = {};
      manualOpened = {};
      apply();
      return { ok: true, mode: next, message: next === EXPERT ? "专家模式 / Expert mode" : "新手模式 / Novice mode" };
    } catch (e) { return { ok: false, mode: next, message: "mode switch failed / 切换失败" }; }
  }

  // 功能：在新手 / 专家之间切换，返回新模式名。
  function toggle() {
    var next = readSaved() === EXPERT ? NOVICE : EXPERT;
    set(next);
    return next;
  }

  // 功能：初始化——建分组、绑按钮、应用模式；可重复调用（幂等）。
  function init() {
    try {
      if (!inited) {
        scanGroups();
        var btn = byId("modeBtn");
        if (btn) btn.addEventListener("click", function () { toggle(); });
        inited = true;
      }
      return { ok: true, mode: apply(), groups: groups.length, message: "ui mode ready / 界面模式就绪" };
    } catch (e) { return { ok: false, mode: NOVICE, groups: 0, message: "ui mode init failed / 初始化失败" }; }
  }

  // 功能：读状态快照（自测与实机验证用）。
  function stats() {
    var open = 0;
    try {
      for (var i = 0; i < groups.length; i++) {
        if (groups[i].head.getAttribute("aria-expanded") === "true") open = open + 1;
      }
    } catch (e) { open = 0; }
    return { inited: inited, mode: readSaved(), groups: groups.length, open: open };
  }

  window.uiMode = {
    init: init,
    get: get,
    set: set,
    toggle: toggle,
    apply: apply,
    stats: stats,
    NOVICE: NOVICE,
    EXPERT: EXPERT,
    STORAGE_KEY: STORAGE_KEY
  };
})();
