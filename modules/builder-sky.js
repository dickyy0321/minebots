// ========================================
// 文件：modules/builder-sky.js
// 功能：悬浮建筑——从上方锚点向下挂倒挂脚手架，在空中无中生有打印奇观，完工后按逆序回收。
// 依赖：./logger（可选）、./builder-scaffold（可选，缺失时用内置支撑算法）
// 导出：plan / anchorPoints / recyclePlan / stats / reset / DEFAULT_SPACING
// 作者：MineBots
// ========================================
// 说明：只产出「挂点 → 支撑链 → 建造 → 回收」任务清单，不直接动世界；
//   倒挂的核心是先有上方锚点，再从锚点逐格向下搭支撑，最后自上而下拆掉。
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

// 可选依赖：日志（只写文件）。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
// 可选依赖：既有脚手架模块（只用于状态提示，不覆盖其算法）。
var scaffold = null;
try { scaffold = require("./builder-scaffold"); } catch (e) { scaffold = null; }
// 常量：锚点间距 / 每根支撑链最多挂多少格 / 默认支撑方块。
var DEFAULT_SPACING = 4;
var MAX_CHAIN = 32;
var DEFAULT_BLOCK = "scaffolding";
// 运行时统计。
var totals = { plans: 0, anchors: 0, supports: 0, recycled: 0, failed: 0 };

// 写普通日志：只落文件，不推 GUI。
function logInfo(text) {
  try { if (logger && typeof logger.info === "function") logger.info(text); } catch (e) { /* ignore */ }
}
// 取错误文本，catch 里绝不再次抛错。
function errText(err) {
  try { if (!err) return "unknown error"; if (err.message) return String(err.message); return String(err); } catch (e) { return "unknown error"; }
}
// 安全转整数；坏值回兜底。
function intOf(value, fallback) {
  var n = parseInt(value, 10);
  return isNaN(n) ? fallback : n;
}
// 从蓝图里取方块表与高度区间。
function metaOf(blueprint) {
  var out = { blocks: [], minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
  try {
    var list = Array.isArray(blueprint) ? blueprint : (blueprint && blueprint.blocks) || [];
    out.blocks = list;
    if (list.length === 0) return out;
    out.minX = Infinity; out.maxX = -Infinity; out.minY = Infinity; out.maxY = -Infinity;
    out.minZ = Infinity; out.maxZ = -Infinity;
    for (var i = 0; i < list.length; i++) {
      var b = list[i] || {};
      var x = intOf(b.x, 0), y = intOf(b.y, 0), z = intOf(b.z, 0);
      if (x < out.minX) out.minX = x; if (x > out.maxX) out.maxX = x;
      if (y < out.minY) out.minY = y; if (y > out.maxY) out.maxY = y;
      if (z < out.minZ) out.minZ = z; if (z > out.maxZ) out.maxZ = z;
    }
  } catch (e) { /* 用空区间 */ }
  return out;
}
// 功能：算悬浮建筑的上方锚点——按间距在顶部平面均匀布点，返回坐标数组。
function anchorPoints(blueprint, options) {
  var out = [];
  try {
    var opts = options && typeof options === "object" ? options : {};
    var m = metaOf(blueprint);
    if (m.blocks.length === 0) return out;
    var spacing = intOf(opts.spacing, DEFAULT_SPACING);
    if (spacing < 1) spacing = 1;
    var top = m.maxY + intOf(opts.clearance, 2);
    for (var x = m.minX; x <= m.maxX; x = x + spacing) {
      for (var z = m.minZ; z <= m.maxZ; z = z + spacing) {
        out.push({ x: x, y: top, z: z });
      }
    }
    // 四个角强制有锚点，避免边缘悬空。
    var corners = [{ x: m.minX, z: m.minZ }, { x: m.maxX, z: m.minZ },
      { x: m.minX, z: m.maxZ }, { x: m.maxX, z: m.maxZ }];
    for (var c = 0; c < corners.length; c++) {
      var found = false;
      for (var j = 0; j < out.length; j++) if (out[j].x === corners[c].x && out[j].z === corners[c].z) found = true;
      if (!found) out.push({ x: corners[c].x, y: top, z: corners[c].z });
    }
  } catch (e) { return out; }
  return out;
}
// 功能：生成倒挂施工方案——先挂锚，再从锚点逐格向下搭支撑链，最后铺蓝图本体。
function plan(blueprint, options) {
  var out = { ok: false, anchors: [], supports: [], build: [], recycle: [],
    tasks: [], hanging: false, message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var m = metaOf(blueprint);
    if (m.blocks.length === 0) { out.message = "empty blueprint / 空蓝图"; return out; }
    var block = opts.block || DEFAULT_BLOCK;
    var origin = opts.origin || { x: 0, y: 0, z: 0 };
    var anchors = anchorPoints(blueprint, opts);
    var chain = Math.min(MAX_CHAIN, Math.max(1, m.maxY - m.minY + intOf(opts.clearance, 2)));
    out.anchors = anchors;
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      out.tasks.push({ action: "place_block", x: a.x + origin.x, y: a.y + origin.y, z: a.z + origin.z,
        block: block, role: "sky", reason: "sky anchor / 悬浮锚点" });
      for (var d = 1; d <= chain; d++) {
        var link = { x: a.x + origin.x, y: a.y + origin.y - d, z: a.z + origin.z,
          block: block, role: "sky", reason: "hanging scaffold / 倒挂脚手架", anchor: i, depth: d };
        out.supports.push(link);
        out.tasks.push({ action: "place_block", x: link.x, y: link.y, z: link.z, block: block,
          role: "sky", reason: link.reason });
      }
    }
    for (var b = 0; b < m.blocks.length; b++) {
      var one = m.blocks[b] || {};
      var task = { action: "place_block_exact", x: intOf(one.x, 0) + origin.x,
        y: intOf(one.y, 0) + origin.y, z: intOf(one.z, 0) + origin.z,
        block: one.block || "stone", role: "sky", reason: "floating build / 悬浮建造" };
      out.build.push(task);
      out.tasks.push(task);
    }
    out.recycle = recyclePlan(out, opts).tasks;
    out.hanging = true;
    out.ok = true;
    out.message = "sky build plan ready / 悬浮建筑方案已生成";
    totals.plans = totals.plans + 1;
    totals.anchors = totals.anchors + anchors.length;
    totals.supports = totals.supports + out.supports.length;
    totals.recycled = totals.recycled + out.recycle.length;
    logInfo("[builder-sky] anchors=" + anchors.length + " supports=" + out.supports.length + " / 悬浮方案");
    return out;
  } catch (e) {
    totals.failed = totals.failed + 1;
    out.message = errText(e);
    return out;
  }
}
// 功能：生成回收顺序——先拆最深处的支撑，再拆锚点，保证拆的过程中不会塌。
function recyclePlan(planResult, options) {
  var out = { ok: true, tasks: [], message: "" };
  try {
    var src = planResult && typeof planResult === "object" ? planResult : {};
    var links = Array.isArray(src.supports) ? src.supports.slice(0) : [];
    links.sort(function (a, b) { return (b.depth || 0) - (a.depth || 0); });
    for (var i = 0; i < links.length; i++) {
      var l = links[i];
      out.tasks.push({ action: "dig_block", x: l.x, y: l.y, z: l.z,
        role: "sky", reason: "scaffold recycle / 脚手架回收" });
    }
    var anchors = Array.isArray(src.anchors) ? src.anchors : [];
    for (var j = 0; j < anchors.length; j++) {
      var a = anchors[j];
      out.tasks.push({ action: "dig_block", x: a.x, y: a.y, z: a.z,
        role: "sky", reason: "anchor recycle / 锚点回收" });
    }
    out.message = "recycle plan ready / 回收顺序已生成（自下而上）";
  } catch (e) { out.ok = false; out.message = errText(e); }
  return out;
}
// 功能：读统计快照。
function stats() {
  return { ok: true, plans: totals.plans, anchors: totals.anchors,
    supports: totals.supports, recycled: totals.recycled, failed: totals.failed,
    spacing: DEFAULT_SPACING, block: DEFAULT_BLOCK, scaffoldModule: !!scaffold };
}
// 功能：复位统计。
function reset() {
  totals = { plans: 0, anchors: 0, supports: 0, recycled: 0, failed: 0 };
  return { ok: true, message: "builder sky reset / 悬浮建筑模块已复位" };
}
// 对外导出。
module.exports = {
  plan: plan, anchorPoints: anchorPoints, recyclePlan: recyclePlan,
  stats: stats, reset: reset, DEFAULT_SPACING: DEFAULT_SPACING
};
