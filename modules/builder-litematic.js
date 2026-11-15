// ========================================
// 文件：modules/builder-litematic.js
// 功能：Litematica 蓝图底层解析门面——走 gzip + NBT + BlockStates LongArray 位解码，
//       逐块提取方块属性（facing / axis / powered 等）与朝向，输出建筑链可直接消费的方块表。
// 依赖：./litematic-codec（可选，缺失时安全降级）、./logger（可选）
// 导出：parse / facingOf / propertiesOf / toTasks / stats / reset
// 作者：MineBots
// ========================================
// 说明：真正的位解压在 litematic-codec.js 里实现；本模块只做「属性 / 朝向」的结构化提取，
//   不重复实现解码，保证与 P11 的 .litematic 断言同源。
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

// 可选依赖：真 .litematic 编解码器。
var codec = null;
try { codec = require("./litematic-codec"); } catch (e) { codec = null; }
// 可选依赖：日志（只写文件）。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
// 常量：朝向属性名与旋转顺序（用于结构化提取）。
var FACING_KEYS = ["facing", "axis", "rotation", "orientation", "type"];
var DIRECTIONS = ["north", "east", "south", "west", "up", "down"];
// 运行时统计。
var totals = { parsed: 0, blocks: 0, withProps: 0, facings: 0, failed: 0 };

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
// 从方块对象里取出属性字典；兼容 props / properties / state 三种字段。
function propertiesOf(block) {
  try {
    var b = block && typeof block === "object" ? block : {};
    var raw = b.props || b.properties || b.state || null;
    if (raw && typeof raw === "object") return raw;
    var spec = toText(b.spec || b.block || b.name);
    var open = spec.indexOf("[");
    if (open < 0) return {};
    var body = spec.slice(open + 1).replace(/\]$/, "");
    var out = {};
    var pairs = body.split(",");
    for (var i = 0; i < pairs.length; i++) {
      var eq = pairs[i].indexOf("=");
      if (eq > 0) out[pairs[i].slice(0, eq).trim()] = pairs[i].slice(eq + 1).trim();
    }
    return out;
  } catch (e) { return {}; }
}
// 功能：提取方块朝向；优先 facing，其次 axis / rotation，都没有返回 "none"。
function facingOf(block) {
  try {
    var p = propertiesOf(block);
    for (var i = 0; i < FACING_KEYS.length; i++) {
      var v = toText(p[FACING_KEYS[i]]).toLowerCase();
      if (v.length === 0) continue;
      if (DIRECTIONS.indexOf(v) >= 0) return v;
      if (FACING_KEYS[i] !== "facing") return v;
    }
    return "none";
  } catch (e) { return "none"; }
}
// 把解码器返回的方块名规范成裸名（去掉命名空间与属性后缀）。
function cleanName(block) {
  var raw = toText(block && (block.block || block.name || block.spec));
  var cut = raw.indexOf("[");
  if (cut >= 0) raw = raw.slice(0, cut);
  var colon = raw.lastIndexOf(":");
  if (colon >= 0) raw = raw.slice(colon + 1);
  return raw;
}
// 功能：解析 .litematic（Buffer / gzip / 简化 NBT 对象 / JSON 文本均可），返回结构化方块表。
function parse(input, options) {
  var out = { ok: false, blocks: [], origin: { x: 0, y: 0, z: 0 }, size: { width: 0, height: 0, length: 0 },
    palette: [], bits: 0, withProps: 0, facings: 0, regions: 0, message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    if (!codec || typeof codec.parse !== "function") {
      out.message = "litematic codec unavailable / NBT 解码器不可用";
      totals.failed = totals.failed + 1;
      return out;
    }
    var decoded = codec.parse(input, opts);
    if (!decoded || !decoded.ok) {
      out.message = decoded ? decoded.message : "decode failed / 解码失败";
      totals.failed = totals.failed + 1;
      return out;
    }
    out.origin = decoded.origin || out.origin;
    out.size = decoded.size || out.size;
    out.regions = (decoded.regions || []).length;
    var list = decoded.blocks || [];
    for (var i = 0; i < list.length; i++) {
      var one = list[i] || {};
      var name = cleanName(one);
      if (name.length === 0 || name === "air") continue;
      var props = propertiesOf(one);
      var facing = facingOf(one);
      var rec = { x: Number(one.x) || 0, y: Number(one.y) || 0, z: Number(one.z) || 0,
        block: name, props: props, facing: facing };
      out.blocks.push(rec);
      if (Object.keys(props).length > 0) out.withProps = out.withProps + 1;
      if (facing !== "none") out.facings = out.facings + 1;
    }
    if (codec.paletteOf && decoded.regions && decoded.regions[0]) {
      try { out.palette = codec.paletteOf(decoded.regions[0]) || []; } catch (ePal) { out.palette = []; }
    }
    out.bits = typeof codec.bitsPerBlock === "function" ? codec.bitsPerBlock(Math.max(2, out.palette.length || 2)) : 0;
    out.ok = true;
    out.message = ".litematic decoded / 高维蓝图属性与朝向已提取";
    totals.parsed = totals.parsed + 1;
    totals.blocks = totals.blocks + out.blocks.length;
    totals.withProps = totals.withProps + out.withProps;
    totals.facings = totals.facings + out.facings;
    logInfo("[builder-litematic] parsed / 解析完成: blocks=" + out.blocks.length + " facings=" + out.facings);
    return out;
  } catch (e) {
    totals.failed = totals.failed + 1;
    out.message = errText(e);
    return out;
  }
}
// 功能：把解析结果转成建筑任务清单（保留属性与朝向，供 place_block_exact 使用）。
function toTasks(parsed, options) {
  var out = { ok: false, tasks: [], count: 0, message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var data = parsed && parsed.blocks ? parsed : parse(parsed, opts);
    var blocks = data.blocks || [];
    var origin = opts.origin || data.origin || { x: 0, y: 0, z: 0 };
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      out.tasks.push({ action: "place_block_exact", x: b.x + origin.x, y: b.y + origin.y, z: b.z + origin.z,
        block: b.block, props: b.props, facing: b.facing, requiresOp: false, role: "builder" });
    }
    out.count = out.tasks.length;
    out.ok = true;
    out.message = "tasks built / 建筑任务已生成";
  } catch (e) { out.message = errText(e); }
  return out;
}
// 功能：读统计快照。
function stats() {
  return { ok: true, parsed: totals.parsed, blocks: totals.blocks,
    withProps: totals.withProps, facings: totals.facings, failed: totals.failed,
    codec: !!codec, directions: DIRECTIONS.slice(0) };
}
// 功能：复位统计。
function reset() {
  totals = { parsed: 0, blocks: 0, withProps: 0, facings: 0, failed: 0 };
  return { ok: true, message: "builder litematic reset / 蓝图解析门面已复位" };
}
// 对外导出。
module.exports = {
  parse: parse, facingOf: facingOf, propertiesOf: propertiesOf,
  toTasks: toTasks, stats: stats, reset: reset
};
