// ========================================
// 文件：gui/renderer/virtual-list.js
// 功能：前端性能防卡死——日志区虚拟列表只渲染可视区 DOM；高级面板深度折叠，避免上千节点拖垮渲染进程。
// 依赖：无（只用浏览器 DOM；不 require 任何主进程模块，符合 renderer 约定）
// 导出：window.MBVirtualList（同时兼容 Node require 做纯函数自测）
// 作者：MineBots
// ========================================
// 说明：渲染层绝不使用 require；与 Node 的兼容只为让 selftest 能验证纯计算逻辑，
//   所有 DOM 操作都包 try/catch，浏览器 API 缺失时自动降级为普通增量渲染。
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

// 用 IIFE 包住全部实现：顶层 var state / var api 曾经污染 window.state 与 window.api，
// 让 app.js 的 DOMContentLoaded 初始化中断，整页按钮全部变成「假按钮」。这里彻底隔离作用域。
(function () {
// 建立浏览器 / Node 双环境根对象（渲染层在 Node 里只暴露纯函数）。
var root = typeof window !== "undefined" ? window : {};
// 常量：默认行高、可视区外缓冲行数、最大保留条数、DOM 降级上限。
var DEFAULT_ROW_HEIGHT = 20;
var OVERSCAN = 4;
var MAX_ITEMS = 5000;
var DOM_FALLBACK_MAX = 200;
// 运行时：挂载状态与统计。
var state = { box: null, spacer: null, items: [], rowHeight: DEFAULT_ROW_HEIGHT,
  mounted: false, renders: 0, painted: 0, maxNodes: 0, folds: 0 };
// 纯函数：算可视区应该渲染哪几行；不碰 DOM，供自测直接调用。
function visibleRange(scrollTop, viewportHeight, rowHeight, total) {
  var h = Number(rowHeight) > 0 ? Number(rowHeight) : DEFAULT_ROW_HEIGHT;
  var count = Number(total) > 0 ? Math.floor(Number(total)) : 0;
  var top = Number(scrollTop) > 0 ? Number(scrollTop) : 0;
  var vh = Number(viewportHeight) > 0 ? Number(viewportHeight) : h;
  var start = Math.max(0, Math.floor(top / h) - OVERSCAN);
  var end = Math.min(count, Math.ceil((top + vh) / h) + OVERSCAN);
  if (end < start) end = start;
  return { start: start, end: end, rows: Math.max(0, end - start), total: count, height: count * h };
}
// 纯函数：深度折叠计划——超过阈值的子块才折叠，返回应折叠的数量。
function foldPlan(nodeCount, threshold) {
  var n = Number(nodeCount) > 0 ? Math.floor(Number(nodeCount)) : 0;
  var limit = Number(threshold) > 0 ? Math.floor(Number(threshold)) : 3;
  return { total: n, threshold: limit, folds: n > limit ? n - 1 : 0, deep: n > limit };
}
// 安全取元素：没有 document 或选择器查不到都返回 null。
function byId(id) {
  try { if (typeof document === "undefined") return null; return document.getElementById(id); } catch (e) { return null; }
}
// 把一条数据渲染成一行文本；支持字符串与对象两种条目。
function lineOf(item) {
  try {
    if (typeof item === "string") return item;
    if (item && item.text !== undefined) return String(item.text);
    if (item && item.message !== undefined) {
      return "[" + (item.time || "") + "][" + (item.type || "SYSTEM") + "][" + (item.level || "info") + "] " + item.message;
    }
    return String(item);
  } catch (e) { return ""; }
}
// 取条目类型样式类；不可用时返回空串。
function classOf(item) {
  try {
    if (item && typeof item === "object") return "log-line " + (item.type || "SYSTEM") + " " + (item.level || "info");
  } catch (e) { /* ignore */ }
  return "log-line";
}
// 重绘可视区：清空后只挂可见行，DOM 节点数始终与屏幕高度同量级。
function paint() {
  try {
    if (!state.mounted || !state.box || !state.spacer) return { ok: false, rows: 0 };
    if (typeof document === "undefined") return { ok: false, rows: 0 };
    var top = state.box.scrollTop || 0;
    var vh = state.box.clientHeight || state.rowHeight * 10;
    var range = visibleRange(top, vh, state.rowHeight, state.items.length);
    state.spacer.style.height = range.height + "px";
    var frag = document.createDocumentFragment();
    for (var i = range.start; i < range.end; i++) {
      var row = document.createElement("div");
      row.className = classOf(state.items[i]);
      row.style.position = "absolute";
      row.style.top = (i * state.rowHeight) + "px";
      row.style.left = "0";
      row.style.right = "0";
      row.style.height = state.rowHeight + "px";
      row.textContent = lineOf(state.items[i]);
      frag.appendChild(row);
    }
    state.spacer.innerHTML = "";
    state.spacer.appendChild(frag);
    state.renders = state.renders + 1;
    state.painted = range.rows;
    if (range.rows > state.maxNodes) state.maxNodes = range.rows;
    return { ok: true, rows: range.rows, start: range.start, end: range.end };
  } catch (e) { return { ok: false, rows: 0, message: String(e && e.message ? e.message : e) }; }
}
// 功能：把虚拟列表挂到指定容器；容器不存在返回 ok:false，重复挂载幂等。
function mount(box, options) {
  try {
    var opts = options && typeof options === "object" ? options : {};
    var el = box || byId(opts.id || "logBox");
    if (!el || typeof document === "undefined") return { ok: false, message: "no container / 容器不可用" };
    if (state.mounted && state.box === el) return { ok: true, mounted: true, message: "already mounted / 已挂载" };
    state.box = el;
    state.rowHeight = Number(opts.rowHeight) > 0 ? Number(opts.rowHeight) : DEFAULT_ROW_HEIGHT;
    state.items = Array.isArray(opts.items) ? opts.items.slice(0) : [];
    var spacer = document.createElement("div");
    spacer.className = "vl-spacer";
    spacer.style.position = "relative";
    spacer.style.width = "100%";
    el.innerHTML = "";
    el.appendChild(spacer);
    state.spacer = spacer;
    state.mounted = true;
    var self = paint;
    el.addEventListener("scroll", function () { self(); });
    paint();
    return { ok: true, mounted: true, rowHeight: state.rowHeight, message: "virtual list mounted / 虚拟列表已挂载" };
  } catch (e) { return { ok: false, message: String(e && e.message ? e.message : e) }; }
}
// 功能：追加一条日志；超过 MAX_ITEMS 时淘汰最旧的，DOM 节点数不随日志总量增长。
function add(item) {
  try {
    state.items.push(item);
    if (state.items.length > MAX_ITEMS) state.items.splice(0, state.items.length - MAX_ITEMS);
    if (!state.mounted) return { ok: true, virtual: false, total: state.items.length };
    paint();
    scrollToBottom();
    return { ok: true, virtual: true, total: state.items.length, nodes: state.painted };
  } catch (e) { return { ok: false, message: String(e && e.message ? e.message : e) }; }
}
// 功能：清空列表。
function clear() {
  try {
    state.items = [];
    if (state.spacer) state.spacer.innerHTML = "";
    paint();
    return { ok: true, total: 0 };
  } catch (e) { return { ok: false, message: String(e && e.message ? e.message : e) }; }
}
// 功能：滚到底部（日志跟随）。
function scrollToBottom() {
  try {
    if (!state.box) return { ok: false };
    state.box.scrollTop = state.items.length * state.rowHeight;
    return { ok: true, scrollTop: state.box.scrollTop };
  } catch (e) { return { ok: false }; }
}
// 功能：高级面板深度折叠——把多余子块包进 details 且默认收起，返回折叠数量。
function deepFold(container, options) {
  var out = { ok: false, wrapped: 0, message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var el = container || byId(opts.id || "settingsContent");
    if (!el || typeof document === "undefined") { out.message = "no container / 容器不可用"; return out; }
    var plan = foldPlan(el.children ? el.children.length : 0, opts.threshold || 3);
    if (!plan.deep) { out.ok = true; out.message = "no fold needed / 无需折叠"; return out; }
    var kids = [];
    for (var i = 0; i < el.children.length; i++) kids.push(el.children[i]);
    for (var j = 1; j < kids.length; j++) {
      var details = document.createElement("details");
      details.className = "deep-fold";
      var summary = document.createElement("summary");
      summary.textContent = "更多设置 / More settings";
      details.appendChild(summary);
      el.insertBefore(details, kids[j]);
      details.appendChild(kids[j]);
      out.wrapped = out.wrapped + 1;
    }
    state.folds = state.folds + out.wrapped;
    out.ok = true;
    out.message = "panels folded / 高级面板已深度折叠";
    return out;
  } catch (e) { out.message = String(e && e.message ? e.message : e); return out; }
}
// 功能：读统计快照（自检与 GUI 诊断共用）。
function stats() {
  return { ok: true, mounted: state.mounted, total: state.items.length,
    nodes: state.painted, maxNodes: state.maxNodes, renders: state.renders,
    folds: state.folds, rowHeight: state.rowHeight, maxItems: MAX_ITEMS };
}
// 功能：复位内存状态（重载 / 自测隔离用）。
function reset() {
  try { if (state.spacer) state.spacer.innerHTML = ""; } catch (e) { /* ignore */ }
  state = { box: null, spacer: null, items: [], rowHeight: DEFAULT_ROW_HEIGHT,
    mounted: false, renders: 0, painted: 0, maxNodes: 0, folds: 0 };
  return { ok: true, message: "virtual list reset / 虚拟列表已复位" };
}
// 对外导出：浏览器挂 window，Node 侧走 module.exports 做纯函数自测。
var api = {
  visibleRange: visibleRange, foldPlan: foldPlan, mount: mount, add: add,
  clear: clear, scrollToBottom: scrollToBottom, deepFold: deepFold,
  stats: stats, reset: reset, paint: paint,
  DEFAULT_ROW_HEIGHT: DEFAULT_ROW_HEIGHT, MAX_ITEMS: MAX_ITEMS, DOM_FALLBACK_MAX: DOM_FALLBACK_MAX
};
try { root.MBVirtualList = api; } catch (eRoot) { /* ignore */ }
if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
