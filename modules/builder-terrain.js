// ========================================
// 文件：modules/builder-terrain.js
// 功能：地形平整——削平山头 / 填海造陆，按列算方量，多余材料自动入仓并生成入库任务。
// 依赖：./logger（可选）
// 导出：flatten / estimate / storagePlan / stats / reset / DEFAULT_BLOCK
// 作者：MineBots
// ========================================
// 说明：只产出任务清单，不直接动世界；真实 bot 的 blockAt 通过 options.sample 注入，
//   自测完全离线。材料入仓按方块名分组，避免一个箱子塞满十几种材料。
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

// 可选依赖：日志（只写文件）。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
// 常量：默认填充方块 / 单列最大高差 / 单次任务上限。
var DEFAULT_BLOCK = "dirt";
var MAX_DELTA = 64;
var MAX_TASKS = 2000;
// 运行时统计。
var totals = { plans: 0, removed: 0, filled: 0, stored: 0, failed: 0 };

// 写普通日志：只落文件，不推 GUI。
function logInfo(text) {
  try { if (logger && typeof logger.info === "function") logger.info(text); } catch (e) { /* ignore */ }
}
// 取错误文本，catch 里绝不再次抛错。
function errText(err) {
  try { if (!err) return "unknown error"; if (err.message) return String(err.message); return String(err); } catch (e) { return "unknown error"; }
}
// 安全转整数；坏值返回兜底。
function intOf(value, fallback) {
  var n = parseInt(value, 10);
  return isNaN(n) ? fallback : n;
}
// 取区域四角，坏值收敛成 0..0 的空区域。
function bounds(area) {
  var a = area && typeof area === "object" ? area : {};
  var x1 = intOf(a.x1, 0), x2 = intOf(a.x2, 0), z1 = intOf(a.z1, 0), z2 = intOf(a.z2, 0);
  if (x2 < x1) { var t = x1; x1 = x2; x2 = t; }
  if (z2 < z1) { var u = z1; z1 = z2; z2 = u; }
  return { x1: x1, x2: x2, z1: z1, z2: z2, columns: (x2 - x1 + 1) * (z2 - z1 + 1) };
}
// 功能：纯估算——给定目标高度与每列实际高度，算出削方 / 填方总量，不产任务。
function estimate(area, targetY, options) {
  var out = { ok: true, columns: 0, remove: 0, fill: 0, net: 0, targetY: intOf(targetY, 64) };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var box = bounds(area);
    out.columns = box.columns;
    for (var x = box.x1; x <= box.x2; x++) {
      for (var z = box.z1; z <= box.z2; z++) {
        var top = intOf(opts.heightAt ? opts.heightAt(x, z) : opts.defaultHeight, out.targetY);
        var delta = top - out.targetY;
        if (delta > 0) out.remove = out.remove + Math.min(delta, MAX_DELTA);
        else if (delta < 0) out.fill = out.fill + Math.min(-delta, MAX_DELTA);
      }
    }
    out.net = out.fill - out.remove;
  } catch (e) { out.ok = false; out.message = errText(e); }
  return out;
}
// 功能：生成地形平整任务——高于目标逐层削掉，低于目标逐层填平；返回任务清单与材料账。
function flatten(area, targetY, options) {
  var out = { ok: false, tasks: [], removed: 0, filled: 0, material: {}, columns: 0,
    storage: [], targetY: intOf(targetY, 64), message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var box = bounds(area);
    var block = opts.block || DEFAULT_BLOCK;
    var origin = opts.origin || { x: 0, y: 0, z: 0 };
    out.columns = box.columns;
    for (var x = box.x1; x <= box.x2; x++) {
      for (var z = box.z1; z <= box.z2; z++) {
        var top = intOf(opts.heightAt ? opts.heightAt(x, z) : opts.defaultHeight, out.targetY);
        var y = 0;
        if (top > out.targetY) {
          for (y = out.targetY + 1; y <= top && out.tasks.length < MAX_TASKS; y++) {
            out.tasks.push({ action: "dig_block", x: x + origin.x, y: y + origin.y, z: z + origin.z,
              role: "terrain", reason: "flatten / 削平山头" });
            out.removed = out.removed + 1;
            out.material[block] = (out.material[block] || 0) + 1;
          }
        } else if (top < out.targetY) {
          for (y = top + 1; y <= out.targetY && out.tasks.length < MAX_TASKS; y++) {
            out.tasks.push({ action: "place_block", x: x + origin.x, y: y + origin.y, z: z + origin.z,
              block: block, role: "terrain", reason: "landfill / 填海造陆" });
            out.filled = out.filled + 1;
          }
        }
      }
    }
    out.storage = storagePlan(out.material, opts).tasks;
    out.ok = true;
    out.message = "terrain plan ready / 地形平整任务已生成";
    totals.plans = totals.plans + 1;
    totals.removed = totals.removed + out.removed;
    totals.filled = totals.filled + out.filled;
    totals.stored = totals.stored + out.storage.length;
    logInfo("[builder-terrain] removed=" + out.removed + " filled=" + out.filled + " / 削填完成");
    return out;
  } catch (e) {
    totals.failed = totals.failed + 1;
    out.message = errText(e);
    return out;
  }
}
// 功能：材料自动入仓——按方块名分组，生成 chestTransfer 任务，返回 { ok, tasks, groups }。
function storagePlan(material, options) {
  var out = { ok: true, tasks: [], groups: [], message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var chest = opts.chest || { x: 0, y: 64, z: 0 };
    var data = material && typeof material === "object" ? material : {};
    for (var name in data) {
      if (!Object.prototype.hasOwnProperty.call(data, name)) continue;
      var count = intOf(data[name], 0);
      if (count <= 0) continue;
      out.groups.push({ block: name, count: count });
      out.tasks.push({ action: "chestTransfer", block: name, count: count,
        chest: { x: chest.x, y: chest.y, z: chest.z }, role: "logistics",
        reason: "material to storage / 材料自动入仓" });
    }
    out.message = "storage plan ready / 入仓任务已生成";
  } catch (e) { out.ok = false; out.message = errText(e); }
  return out;
}
// 功能：读统计快照。
function stats() {
  return { ok: true, plans: totals.plans, removed: totals.removed,
    filled: totals.filled, stored: totals.stored, failed: totals.failed, defaultBlock: DEFAULT_BLOCK };
}
// 功能：复位统计。
function reset() {
  totals = { plans: 0, removed: 0, filled: 0, stored: 0, failed: 0 };
  return { ok: true, message: "builder terrain reset / 地形模块已复位" };
}
// 对外导出。
module.exports = {
  flatten: flatten, estimate: estimate, storagePlan: storagePlan,
  stats: stats, reset: reset, DEFAULT_BLOCK: DEFAULT_BLOCK
};
