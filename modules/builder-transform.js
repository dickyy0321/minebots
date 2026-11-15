// ========================================
// 文件：modules/builder-transform.js
// 功能：蓝图变换与重绘——rotate(90/180/270) / mirror(x/z) 同步改写坐标与方块朝向；
//       遇到缺失方块按规则表或可选 AI 自动替换，保证蓝图永远可建造。
// 依赖：./logger（可选）、./ai-client（可选，缺失时走内置替换规则）
// 导出：rotate / mirror / replaceMissing / sizeOf / stats / reset / FACING_CYCLE
// 作者：MineBots
// ========================================
// 说明：只做纯数据变换，不联网（AI 替换仅在显式提供 options.ai 回调时才调用）。
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

// 可选依赖：日志（只写文件）。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
// 常量：水平朝向循环（顺时针 90 度）。
var FACING_CYCLE = ["north", "east", "south", "west"];
// 常量：常见缺失 / 未知方块的替换规则（中英双语说明）。
var REPLACEMENTS = {
  air: "stone", unknown: "stone", missing: "stone", unobtainable: "stone",
  "minecraft:unknown": "stone", bedrock: "obsidian", command_block: "stone",
  spawner: "stone", barrier: "glass", structure_void: "air",
  diamond_block: "iron_block", netherite_block: "iron_block",
  "": "stone", null: "stone"
};
// 运行时统计。
var totals = { rotations: 0, mirrors: 0, replaced: 0, aiReplaced: 0, failed: 0 };

// 写普通日志：只落文件，不推 GUI。
function logInfo(text) {
  try { if (logger && typeof logger.info === "function") logger.info(text); } catch (e) { /* ignore */ }
}
// 取错误文本，catch 里绝不再次抛错。
function errText(err) {
  try { if (!err) return "unknown error"; if (err.message) return String(err.message); return String(err); } catch (e) { return "unknown error"; }
}
// 安全转字符串：null / undefined 归一成空串。
function toText(value) {
  try { if (value === null || value === undefined) return ""; return String(value); } catch (e) { return ""; }
}
// 深拷贝方块表，避免改到调用方原始数据。
function copyBlocks(blocks) {
  var out = [];
  try {
    var list = Array.isArray(blocks) ? blocks : [];
    for (var i = 0; i < list.length; i++) out.push(JSON.parse(JSON.stringify(list[i] || {})));
  } catch (e) { return []; }
  return out;
}
// 功能：算方块表的包围盒尺寸与最小坐标。
function sizeOf(blocks) {
  var out = { minX: 0, minY: 0, minZ: 0, width: 0, height: 0, length: 0, count: 0 };
  try {
    var list = Array.isArray(blocks) ? blocks : [];
    if (list.length === 0) return out;
    var minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (var i = 0; i < list.length; i++) {
      var b = list[i] || {};
      var x = Number(b.x) || 0, y = Number(b.y) || 0, z = Number(b.z) || 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    out.minX = minX; out.minY = minY; out.minZ = minZ;
    out.width = maxX - minX + 1; out.height = maxY - minY + 1; out.length = maxZ - minZ + 1;
    out.count = list.length;
  } catch (e) { out.count = 0; }
  return out;
}
// 把朝向按步数旋转（顺时针），非水平朝向原样保留。
function turnFacing(facing, steps) {
  var f = toText(facing).toLowerCase();
  var at = FACING_CYCLE.indexOf(f);
  if (at < 0) return f;
  return FACING_CYCLE[(at + steps + 8) % 4];
}
// 把朝向沿某个轴镜像翻转。
function flipFacing(facing, axis) {
  var f = toText(facing).toLowerCase();
  if (axis === "x") { if (f === "east") return "west"; if (f === "west") return "east"; }
  if (axis === "z") { if (f === "north") return "south"; if (f === "south") return "north"; }
  return f;
}
// 功能：绕 Y 轴旋转 90 / 180 / 270 度，坐标与 facing 同步变换并归一到非负坐标。
function rotate(blocks, degrees, options) {
  var out = { ok: false, blocks: [], degrees: 0, size: null, message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var deg = Number(degrees);
    if (deg !== 90 && deg !== 180 && deg !== 270 && deg !== -90) {
      out.message = "unsupported angle / 只支持 90、180、270 度旋转";
      return out;
    }
    var steps = deg === -90 ? 3 : Math.round(deg / 90);
    var size = sizeOf(blocks);
    var list = copyBlocks(blocks);
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      var x = Number(b.x) || 0, z = Number(b.z) || 0;
      var nx = x, nz = z;
      for (var s = 0; s < steps; s++) {
        var t = nx;
        nx = -nz;
        nz = t;
      }
      b.x = nx; b.z = nz;
      if (b.facing) b.facing = turnFacing(b.facing, steps);
      if (b.props && b.props.facing) b.props.facing = turnFacing(b.props.facing, steps);
    }
    // 归一：平移到最小坐标为 0，避免出现负数坐标。
    var after = sizeOf(list);
    for (var j = 0; j < list.length; j++) { list[j].x = list[j].x - after.minX; list[j].z = list[j].z - after.minZ; }
    out.blocks = list;
    out.degrees = deg;
    out.size = sizeOf(list);
    out.ok = true;
    out.message = "blueprint rotated / 蓝图已旋转 " + deg + " 度";
    totals.rotations = totals.rotations + 1;
    logInfo("[builder-transform] rotate / 旋转 " + deg + " 度, blocks=" + list.length);
    return out;
  } catch (e) {
    totals.failed = totals.failed + 1;
    out.message = errText(e);
    return out;
  }
}
// 功能：沿 x 或 z 轴镜像，坐标与 facing 同步翻转并归一到非负坐标。
function mirror(blocks, axis, options) {
  var out = { ok: false, blocks: [], axis: "", message: "" };
  try {
    var a = toText(axis).toLowerCase();
    if (a !== "x" && a !== "z") { out.message = "axis must be x or z / 镜像轴只能是 x 或 z"; return out; }
    var size = sizeOf(blocks);
    var list = copyBlocks(blocks);
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (a === "x") b.x = -(Number(b.x) || 0);
      else b.z = -(Number(b.z) || 0);
      if (b.facing) b.facing = flipFacing(b.facing, a);
      if (b.props && b.props.facing) b.props.facing = flipFacing(b.props.facing, a);
    }
    var after = sizeOf(list);
    for (var j = 0; j < list.length; j++) { list[j].x = list[j].x - after.minX; list[j].z = list[j].z - after.minZ; }
    out.blocks = list;
    out.axis = a;
    out.size = sizeOf(list);
    out.ok = true;
    out.message = "blueprint mirrored / 蓝图已沿 " + a + " 轴镜像";
    totals.mirrors = totals.mirrors + 1;
    return out;
  } catch (e) {
    totals.failed = totals.failed + 1;
    out.message = errText(e);
    return out;
  }
}
// 判断一个方块名是否属于「缺失 / 不可获得」。
function isMissing(name) {
  var n = toText(name).toLowerCase().trim();
  if (n.length === 0) return true;
  if (REPLACEMENTS[n] !== undefined) return true;
  return n.indexOf("unknown") >= 0 || n.indexOf("missing") >= 0;
}
// 功能：缺失方块自动替换——先用内置规则表，显式注入 ai 回调时优先问 AI，失败一律回兜底。
function replaceMissing(blocks, options) {
  var out = { ok: true, blocks: [], replaced: [], aiUsed: 0, fallback: "stone", message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    out.fallback = opts.fallback || "stone";
    var list = copyBlocks(blocks);
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      var name = toText(b.block).toLowerCase().trim();
      if (!isMissing(name)) { out.blocks.push(b); continue; }
      var chosen = REPLACEMENTS[name] !== undefined ? REPLACEMENTS[name] : out.fallback;
      if (chosen === "stone") chosen = out.fallback;
      if (opts.ai && typeof opts.ai === "function") {
        try {
          var reply = opts.ai(b, chosen);
          if (reply && typeof reply === "string" && reply.length > 0) {
            chosen = reply;
            out.aiUsed = out.aiUsed + 1;
            totals.aiReplaced = totals.aiReplaced + 1;
          }
        } catch (eAi) { /* AI 失败用规则表 */ }
      }
      out.replaced.push({ x: b.x, y: b.y, z: b.z, from: name || "(empty)", to: chosen });
      b.block = chosen;
      b.substituted = true;
      out.blocks.push(b);
      totals.replaced = totals.replaced + 1;
    }
    out.message = "missing blocks replaced / 缺失方块已自动替换";
    return out;
  } catch (e) {
    totals.failed = totals.failed + 1;
    out.ok = false; out.message = errText(e);
    return out;
  }
}
// 功能：读统计快照。
function stats() {
  return { ok: true, rotations: totals.rotations, mirrors: totals.mirrors,
    replaced: totals.replaced, aiReplaced: totals.aiReplaced, failed: totals.failed,
    angles: [90, 180, 270], axes: ["x", "z"] };
}
// 功能：复位统计。
function reset() {
  totals = { rotations: 0, mirrors: 0, replaced: 0, aiReplaced: 0, failed: 0 };
  return { ok: true, message: "builder transform reset / 蓝图变换已复位" };
}
// 对外导出。
module.exports = {
  rotate: rotate, mirror: mirror, replaceMissing: replaceMissing,
  sizeOf: sizeOf, stats: stats, reset: reset, FACING_CYCLE: FACING_CYCLE
};
