// ========================================
// 文件：gui/renderer/ui-log.js
// 功能：日志渲染入口——优先走虚拟列表（DOM 节点数恒定），不可用时降级为有上限的普通渲染；
//       启动时自动对高级面板做深度折叠，防止 DOM 过多卡死界面。
// 依赖：window.MBVirtualList（可选，脚本加载顺序保证）、window.state、window.api
// 导出：window.uiLog
// 作者：MineBots
// ========================================
// 说明：渲染层不 require 主进程模块；所有 DOM 操作包 try/catch。
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

// 常量：降级渲染时最多保留的 DOM 行数。
var MAX_DOM_LINES = 200;
// 格式化一条日志：带时间 / 类型 / 级别前缀，双语界面不受影响。
function format(entry) {
  try {
    var e = entry || {};
    return "[" + (e.time || "") + "][" + (e.type || "SYSTEM") + "][" + (e.level || "info") + "] " + (e.message || "");
  } catch (err) { return ""; }
}
// 降级路径：直接追加 div，但严格限制节点总数。
function appendPlain(box, entry) {
  try {
    var line = document.createElement("div");
    line.className = "log-line " + (entry.type || "SYSTEM") + " " + (entry.level || "info");
    line.textContent = format(entry);
    box.appendChild(line);
    while (box.children.length > MAX_DOM_LINES) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
    return true;
  } catch (err) { return false; }
}
// 启动时初始化虚拟列表与深度折叠；重复调用无副作用。
function init() {
  try {
    var vl = window.MBVirtualList;
    if (!vl) return { ok: false, message: "virtual list missing / 虚拟列表未加载" };
    var box = document.getElementById("logBox");
    if (box) vl.mount(box, { rowHeight: 20 });
    vl.deepFold(document.getElementById("settingsContent"), { threshold: 3 });
    return { ok: true, message: "log ui initialized / 日志界面已初始化" };
  } catch (err) { return { ok: false, message: String(err && err.message ? err.message : err) }; }
}
// 页面就绪后自动初始化；load 事件缺失时立即尝试一次。
try {
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("load", function () { init(); });
  }
} catch (eInit) { /* 事件不可用不影响手动 init */ }

// 对外导出：add / clear / toggleLang / init / stats。
window.uiLog = {
  add: function (entry) {
    try {
      var box = document.getElementById("logBox");
      if (!box) return;
      var vl = window.MBVirtualList;
      if (vl && vl.stats().mounted) { vl.add(entry || {}); return; }
      appendPlain(box, entry || {});
    } catch (err) { /* 单条日志失败不影响界面 */ }
  },

  clear: function () {
    try {
      var vl = window.MBVirtualList;
      if (vl && vl.stats().mounted) { vl.clear(); return; }
      var box = document.getElementById("logBox");
      if (box) box.innerHTML = "";
    } catch (err) { /* ignore */ }
  },

  toggleLang: function () {
    try {
      window.state.logLang = window.state.logLang === "zh" ? "en" : "zh";
      var btn = document.getElementById("logLangBtn");
      if (btn) btn.textContent = window.state.logLang === "zh" ? "中文日志" : "EN Log";
      if (window.api && window.api.setLogLang) window.api.setLogLang(window.state.logLang);
    } catch (err) { /* ignore */ }
  },

  init: init,

  stats: function () {
    try {
      var vl = window.MBVirtualList;
      if (vl) return vl.stats();
      return { ok: true, mounted: false, source: "plain / 普通渲染", maxDomLines: MAX_DOM_LINES };
    } catch (err) { return { ok: false }; }
  }
};
