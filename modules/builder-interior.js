// ========================================
// 文件：modules/builder-interior.js
// 功能：自动内饰——建完房子后按面积布置光源 / 床 / 箱子，自动识别并避开承重柱。
// 依赖：./logger（可选）
// 导出：plan / pillarsOf / isPillar / stats / reset / DEFAULT_LIGHT_SPACING
// 作者：MineBots
// ========================================
// 说明：只输出放置任务清单，不直接动世界；承重柱按「同一 (x,z) 从地面连续堆到屋顶」判定，
//   也可以由调用方通过 options.pillars 显式指定，两种来源取并集。
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

// 可选依赖：日志（只写文件）。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
// 常量：默认光源间距 / 每个房间床数 / 箱子按每多少格一个。
var DEFAULT_LIGHT_SPACING = 5;
var DEFAULT_BEDS = 1;
var CHEST_PER_AREA = 24;
// 运行时统计。
var totals = { plans: 0, lights: 0, beds: 0, chests: 0, avoided: 0, failed: 0 };

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
// 把 (x,z) 做成稳定键。
function keyOf(x, z) { return x + ":" + z; }
// 功能：从蓝图方块里识别承重柱——同一水平位置从最低层连续堆到最高层即视为柱。
function pillarsOf(blocks, options) {
  var out = [];
  try {
    var opts = options && typeof options === "object" ? options : {};
    var list = Array.isArray(blocks) ? blocks : [];
    var map = {};
    var minY = Infinity, maxY = -Infinity;
    for (var i = 0; i < list.length; i++) {
      var b = list[i] || {};
      var x = intOf(b.x, 0), y = intOf(b.y, 0), z = intOf(b.z, 0);
      var k = keyOf(x, z);
      if (!map[k]) map[k] = [];
      map[k].push(y);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    var need = Math.max(2, maxY - minY + 1);
    var minCount = intOf(opts.minStack, Math.max(2, need - 1));
    for (var k in map) {
      if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
      if (map[k].length >= minCount) out.push(k);
    }
    var extra = Array.isArray(opts.pillars) ? opts.pillars : [];
    for (var j = 0; j < extra.length; j++) {
      var p = extra[j] || {};
      var pk = keyOf(intOf(p.x, 0), intOf(p.z, 0));
      if (out.indexOf(pk) < 0) out.push(pk);
    }
  } catch (e) { return out; }
  return out;
}
// 功能：判断某个水平位置是不是承重柱。
function isPillar(x, z, pillars) {
  try { return (pillars || []).indexOf(keyOf(x, z)) >= 0; } catch (e) { return false; }
}
// 找地板候选格：取蓝图里 y 最小的那一层，且不在柱子上。
function floorCells(blocks, pillars) {
  var out = [];
  try {
    var list = Array.isArray(blocks) ? blocks : [];
    var minY = Infinity;
    for (var i = 0; i < list.length; i++) minY = Math.min(minY, intOf(list[i].y, 0));
    if (!isFinite(minY)) return out;
    var seen = {};
    for (var j = 0; j < list.length; j++) {
      var b = list[j] || {};
      if (intOf(b.y, 0) !== minY) continue;
      var x = intOf(b.x, 0), z = intOf(b.z, 0);
      var k = keyOf(x, z);
      if (seen[k]) continue;
      seen[k] = true;
      if (isPillar(x, z, pillars)) continue;
      out.push({ x: x, y: minY + 1, z: z });
    }
  } catch (e) { return out; }
  return out;
}
// 功能：生成内饰任务清单——光源按间距铺开、床与箱子靠边放，全部避开承重柱。
function plan(blueprint, options) {
  var out = { ok: false, tasks: [], lights: 0, beds: 0, chests: 0, avoided: 0,
    pillars: [], message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var blocks = Array.isArray(blueprint) ? blueprint : (blueprint && blueprint.blocks) || [];
    var pillars = pillarsOf(blocks, opts);
    out.pillars = pillars;
    var cells = floorCells(blocks, pillars);
    out.avoided = pillars.length;
    var spacing = intOf(opts.lightSpacing, DEFAULT_LIGHT_SPACING);
    if (spacing < 2) spacing = 2;
    var light = opts.light || "lantern";
    var placed = {};
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      var k = keyOf(c.x, c.z);
      if (placed[k]) continue;
      if (c.x % spacing !== 0 || c.z % spacing !== 0) continue;
      placed[k] = true;
      out.tasks.push({ action: "place_block", x: c.x, y: c.y, z: c.z, block: light,
        role: "interior", reason: "light / 自动光源" });
      out.lights = out.lights + 1;
    }
    var bedCount = intOf(opts.beds, DEFAULT_BEDS);
    var chestCount = intOf(opts.chests, Math.max(1, Math.floor(cells.length / CHEST_PER_AREA)));
    var edge = cells.filter(function (c) { return c.x === 0 || c.z === 0; });
    if (edge.length === 0) edge = cells;
    for (var b = 0; b < bedCount && b < edge.length; b++) {
      var spot = edge[b];
      out.tasks.push({ action: "place_block", x: spot.x, y: spot.y, z: spot.z, block: "white_bed",
        role: "interior", reason: "bed / 自动放床" });
      out.beds = out.beds + 1;
    }
    for (var q = 0; q < chestCount && q < edge.length; q++) {
      var idx = edge.length - 1 - q;
      out.tasks.push({ action: "place_block", x: edge[idx].x, y: edge[idx].y, z: edge[idx].z, block: "chest",
        role: "interior", reason: "storage / 自动放箱子" });
      out.chests = out.chests + 1;
    }
    out.ok = true;
    out.message = "interior plan ready / 内饰方案已生成（已避开承重柱）";
    totals.plans = totals.plans + 1;
    totals.lights = totals.lights + out.lights;
    totals.beds = totals.beds + out.beds;
    totals.chests = totals.chests + out.chests;
    totals.avoided = totals.avoided + out.avoided;
    logInfo("[builder-interior] lights=" + out.lights + " beds=" + out.beds + " chests=" + out.chests);
    return out;
  } catch (e) {
    totals.failed = totals.failed + 1;
    out.message = errText(e);
    return out;
  }
}
// 功能：读统计快照。
function stats() {
  return { ok: true, plans: totals.plans, lights: totals.lights,
    beds: totals.beds, chests: totals.chests, avoided: totals.avoided,
    failed: totals.failed, lightSpacing: DEFAULT_LIGHT_SPACING };
}
// 功能：复位统计。
function reset() {
  totals = { plans: 0, lights: 0, beds: 0, chests: 0, avoided: 0, failed: 0 };
  return { ok: true, message: "builder interior reset / 内饰模块已复位" };
}
// 对外导出。
module.exports = {
  plan: plan, pillarsOf: pillarsOf, isPillar: isPillar,
  stats: stats, reset: reset, DEFAULT_LIGHT_SPACING: DEFAULT_LIGHT_SPACING
};
