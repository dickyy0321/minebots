// ========================================
// 文件：modules/builder-blueprint.js
// 功能：绝对精确建筑蓝图底盘——解析 .json / .schem / .litematic 蓝图、保留方块全部状态属性
//       （facing / half / delay / powered）、自动算账、拆成微观放置或 place_block_exact 任务入黑板
// 依赖：Node 内置 fs / path / zlib、prismarine-nbt（可选）、./json-repair、./blueprint-highdim、
//       ./shared-board、./event-bus、./logger（都可选）
// 导出：parse / fromJson / fromSchem / fromLitematic / normalize / absolutePos / analyzeBlueprint /
//       buildTasks / buildExactTasks / splitBlueprintToTasks / splitExactToTasks / listJobs / stats / reset / FACES
// 作者：MineBots
// ========================================
//
// 设计 / design
//   1. 内部蓝图统一为 { name, format, origin, size, blocks:[{x,y,z,block,face}] }，xyz 为相对 origin 的局部坐标。
//   2. .schem 走真实 Sponge Schematic NBT（gzip + prismarine-nbt），库缺失或文件坏掉只降级，绝不抛到顶层。
//   3. AI 生成或手写蓝图常带废话 / 尾随逗号，一律先过五级 JSON 修复引擎再归一化。
//   4. 每个方块一个 task，payload 带绝对坐标、放置面、支撑点、jobId、role，供建筑 / 物流机器人分工抢单。
// CommonJS，ES5 风格，无中文变量名；所有外部调用包 try/catch，双语日志。
var fs = require("fs");
var path = require("path");
var zlib = require("zlib");
// 可选依赖：真实 Sponge .schem 是 gzip 压缩的 NBT；缺库时 .schem 走 JSON 描述式降级。
var nbt = null;
try { nbt = require("prismarine-nbt"); } catch (e) { nbt = null; }
// 可选依赖：五级 JSON 修复（AI 蓝图 / 手写蓝图容错）。
var repair = null;
try { repair = require("./json-repair"); } catch (e) { repair = null; }
// 可选依赖：共享黑板任务池；测试可注入假板，生产用真实黑板。
var sharedBoard = null;
try { sharedBoard = require("./shared-board"); } catch (e) { sharedBoard = null; }
// 可选依赖：事件总线 / 日志（低频事件才推 GUI，拆单属高频只写文件）。
var bus = null;
try { bus = require("./event-bus"); } catch (e) { bus = null; }
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
// 可选依赖：高维蓝图底盘（属性解析 / .litematic / place_block_exact 队列）；缺失时老行为完全不变。
var highdim = null;
try { highdim = require("./blueprint-highdim"); } catch (e) { highdim = null; }

// 常量：合法放置面 / 空气别名 / 单蓝图方块上限（防止一次拆单撑爆任务池）。
var FACES = ["up", "down", "north", "south", "east", "west"];
var AIR_NAMES = ["air", "cave_air", "void_air", "structure_void"];
var MAX_BLOCKS = 20000;
var DEFAULT_FACE = "up";
// 内部计数：累计解析 / 拆单 / 方块数，供自测与控制台诊断。
var counters = { parsed: 0, split: 0, tasks: 0, failed: 0, jobs: {} };

// 写文件日志：拆单属高频信息，只落文件不刷 GUI；缺 logger 时静默。
function logInfo(msg) {
  try { if (logger && typeof logger.info === "function") logger.info("[blueprint] " + msg); } catch (e) { /* ignore */ }
}
// 写告警日志：解析失败要让人看见；没有 logger 时退回 console。
function logWarn(msg) {
  try {
    if (logger && typeof logger.warn === "function") { logger.warn("[blueprint] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.warn("[blueprint] " + msg); } catch (e2) { /* ignore */ }
}
// 广播蓝图事件：总线缺失时静默跳过。
function emit(name, payload) {
  try { if (bus && typeof bus.emit === "function") bus.emit(name, payload); } catch (e) { /* ignore */ }
}
// 安全取错误文本：catch 里绝不会二次抛错。
function errText(err) {
  try { if (err && err.message) return String(err.message); return String(err); }
  catch (e) { return "unknown error / 未知错误"; }
}
// 安全转字符串：null / undefined 统一成空串。
function toText(value) {
  try { return value === null || value === undefined ? "" : String(value); } catch (e) { return ""; }
}
// 安全转整数：坏值回 fallback，坐标一律取整（毫米级精确放置不允许浮点漂移）。
function toInt(value, fallback) {
  try {
    var n = Number(value);
    if (isNaN(n) || !isFinite(n)) return fallback;
    return Math.round(n);
  } catch (e) { return fallback; }
}
// 深拷贝一个纯数据对象；坏值返回原值，绝不抛错。
function clone(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch (e) { return value; }
}
// 归一化方块名：去 minecraft: 前缀、小写、过滤非法字符；空气返回空串。
function cleanBlock(value) {
  try {
    var name = toText(value).toLowerCase().trim();
    if (name.indexOf("minecraft:") === 0) name = name.slice(10);
    name = name.replace(/[^a-z0-9_]/g, "");
    if (AIR_NAMES.indexOf(name) >= 0) return "";
    return name;
  } catch (e) { return ""; }
}
// 归一化坐标点：读不出 xyz 一律回原点。
function pointOf(value) {
  var src = value && typeof value === "object" ? value : {};
  return { x: toInt(src.x, 0), y: toInt(src.y, 0), z: toInt(src.z, 0) };
}
// 归一化放置面：只认白名单，坏值回默认朝上。
function faceOf(value) {
  try {
    var face = toText(value).toLowerCase().trim();
    return FACES.indexOf(face) >= 0 ? face : DEFAULT_FACE;
  } catch (e) { return DEFAULT_FACE; }
}
// 背包 / 仓库归一化成 { block: 数量 }：支持对象、数组、Map 式条目，坏值忽略。
function inventoryOf(value) {
  var out = {};
  try {
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) {
        var one = value[i] && typeof value[i] === "object" ? value[i] : {};
        var n = cleanBlock(one.block || one.name || one.item);
        if (n) out[n] = (out[n] || 0) + Math.max(0, toInt(one.count || one.amount, 0));
      }
      return out;
    }
    if (!value || typeof value !== "object") return out;
    for (var key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      var name = cleanBlock(key);
      if (!name) continue;
      out[name] = (out[name] || 0) + Math.max(0, toInt(value[key], 0));
    }
  } catch (e) { return {}; }
  return out;
}
// 构造统一蓝图对象；失败返回 null。
function blueprintOf(name, format, origin, size, blocks, meta) {
  try {
    if (!blocks || blocks.length === 0) return null;
    return {
      name: toText(name) || "blueprint", format: format, origin: pointOf(origin),
      size: { width: toInt(size.width, 0), height: toInt(size.height, 0), length: toInt(size.length, 0) },
      blocks: blocks.slice(0, MAX_BLOCKS), meta: meta && typeof meta === "object" ? clone(meta) : {}
    };
  } catch (e) { return null; }
}
// 从 blocks 数组（每项 {x,y,z,block,face}）生成归一化条目；返回数组。
function entriesFromBlocks(raw, defaultFace) {
  var out = [];
  try {
    var list = Array.isArray(raw) ? raw : [];
    for (var i = 0; i < list.length && out.length < MAX_BLOCKS; i++) {
      var one = list[i] && typeof list[i] === "object" ? list[i] : null;
      if (!one) continue;
      var block = cleanBlock(one.block || one.name || one.item || one.material);
      if (!block) continue;
      var entry = {
        x: toInt(one.x, 0), y: toInt(one.y, 0), z: toInt(one.z, 0),
        block: block, face: faceOf(one.face || defaultFace), props: {}, stateId: null
      };
      // 高维属性：方块名内嵌 [facing=north,half=top] 或条目 props / stateId，一律保留到任务。
      if (highdim && typeof highdim.propsOf === "function") {
        var info = highdim.propsOf(one, entry.face);
        entry.props = info.props;
        entry.stateId = info.stateId;
        if (info.face) entry.face = faceOf(info.face);
      }
      out.push(entry);
    }
  } catch (e) { return out; }
  return out;
}
// 从 palette + data 紧凑格式生成归一化条目：data 支持 [x,y,z,id]、[id,x,y,z]、[{...}]。
function entriesFromPalette(raw, defaultFace) {
  var out = [];
  try {
    var spec = raw && typeof raw === "object" ? raw : {};
    var palette = [];
    var paletteProps = [];
    // palette 键可能是 "minecraft:repeater[facing=north,delay=2]"：先拆状态，再归一化方块名，
    // 否则方括号会被 cleanBlock 揉成乱码方块名，属性全部丢失。
    function putPalette(value, index) {
      var spec2 = highdim && typeof highdim.splitSpec === "function" ? highdim.splitSpec(value) : null;
      var nm = spec2 ? spec2.block : cleanBlock(value);
      var pp = spec2 && typeof highdim.parseProps === "function" ? highdim.parseProps(spec2.state) : {};
      if (index === undefined) { palette.push(nm); paletteProps.push(pp); }
      else { palette[index] = nm; paletteProps[index] = pp; }
    }
    if (Array.isArray(spec.palette)) {
      for (var p = 0; p < spec.palette.length; p++) putPalette(spec.palette[p], undefined);
    } else if (spec.palette && typeof spec.palette === "object") {
      for (var key in spec.palette) {
        if (!Object.prototype.hasOwnProperty.call(spec.palette, key)) continue;
        putPalette(key, toInt(spec.palette[key], -1));
      }
    }
    var data = Array.isArray(spec.data) ? spec.data : [];
    for (var i = 0; i < data.length && out.length < MAX_BLOCKS; i++) {
      var row = data[i];
      if (!row) continue;
      if (Array.isArray(row)) {
        var x = toInt(row[0], 0), y = toInt(row[1], 0), z = toInt(row[2], 0);
        var id = toInt(row[3], -1);
        // 兼容 [id,x,y,z] 变体：第一项落在 palette 范围内且第四项是坐标量级时换位。
        if (id < 0 && row.length >= 4) { id = x; x = toInt(row[1], 0); y = toInt(row[2], 0); z = toInt(row[3], 0); }
        var name = palette[id] || "";
        if (!name) continue;
        var item = { x: x, y: y, z: z, block: name, face: faceOf(row[4] || defaultFace), props: {}, stateId: null };
        if (paletteProps[id] && typeof paletteProps[id] === "object") item.props = paletteProps[id];
        if (item.props.facing && FACES.indexOf(item.props.facing) >= 0 && !row[4]) item.face = item.props.facing;
        if (highdim && typeof highdim.propsOf === "function") {
          var pi = highdim.propsOf({ block: name, face: item.face }, item.face);
          item.block = pi.block || name; item.face = faceOf(pi.face);
          for (var pk in pi.props) if (Object.prototype.hasOwnProperty.call(pi.props, pk)) item.props[pk] = pi.props[pk];
        }
        out.push(item);
      } else if (typeof row === "object") {
        var obj = entriesFromBlocks([row], defaultFace);
        if (obj.length > 0) out.push(obj[0]);
      }
    }
  } catch (e) { return out; }
  return out;
}
// 从 Sponge Schematic 的 NBT 简化对象生成 block 条目；返回 { blocks, size }。
function entriesFromSchem(root) {
  var out = { blocks: [], size: { width: 0, height: 0, length: 0 } };
  try {
    var sch = root && (root.Schematic || root.schematic) ? (root.Schematic || root.schematic) : root;
    if (!sch || typeof sch !== "object") return out;
    var width = Math.max(0, toInt(sch.Width, 0));
    var height = Math.max(0, toInt(sch.Height, 0));
    var length = Math.max(0, toInt(sch.Length, 0));
    if (width === 0 || height === 0 || length === 0) return out;
    out.size = { width: width, height: height, length: length };
    var palette = sch.Palette || sch.palette || {};
    var names = [];
    var schemProps = [];
    for (var key in palette) {
      if (!Object.prototype.hasOwnProperty.call(palette, key)) continue;
      var id = toInt(palette[key], -1);
      if (id < 0) continue;
      // Sponge palette 键同样可能带 [facing=north,delay=2]，先拆状态再归一化方块名。
      var sp = highdim && typeof highdim.splitSpec === "function" ? highdim.splitSpec(key) : null;
      names[id] = sp ? sp.block : cleanBlock(key);
      schemProps[id] = sp && typeof highdim.parseProps === "function" ? highdim.parseProps(sp.state) : {};
    }
    var raw = sch.Blocks || sch.blocks || sch.BlockData || sch.blockData || [];
    var arr = [];
    if (Buffer.isBuffer(raw)) { for (var b = 0; b < raw.length; b++) arr.push(raw[b]); }
    else if (Array.isArray(raw) || (raw && typeof raw.length === "number")) {
      for (var a = 0; a < raw.length; a++) arr.push(toInt(raw[a], 0));
    }
    // Sponge v2 顺序：(y * Length + z) * Width + x；不足的索引按空气跳过。
    for (var y = 0; y < height && out.blocks.length < MAX_BLOCKS; y++) {
      for (var z = 0; z < length && out.blocks.length < MAX_BLOCKS; z++) {
        for (var x = 0; x < width && out.blocks.length < MAX_BLOCKS; x++) {
          var idx = (y * length + z) * width + x;
          var name = names[arr[idx]] || "";
          if (!name) continue;
          var cell = { x: x, y: y, z: z, block: name, face: DEFAULT_FACE, props: {}, stateId: null };
          if (schemProps[arr[idx]]) cell.props = schemProps[arr[idx]];
          if (cell.props.facing && FACES.indexOf(cell.props.facing) >= 0) cell.face = cell.props.facing;
          if (highdim && typeof highdim.propsOf === "function") {
            var ci = highdim.propsOf({ block: name, face: cell.face }, cell.face);
            cell.block = ci.block || name; cell.face = faceOf(ci.face);
          }
          out.blocks.push(cell);
        }
      }
    }
  } catch (e) { return { blocks: [], size: out.size }; }
  return out;
}
// 读文本 / 文件输入：文件路径读盘，其余原样返回；失败返回空串。
function readInput(input) {
  try {
    if (typeof input === "string" && input.length < 512 && input.indexOf("\n") < 0 &&
        (input.indexOf(".json") >= 0 || input.indexOf(".schem") >= 0) && fs.existsSync(input)) {
      return fs.readFileSync(input, "utf8");
    }
  } catch (e) { return ""; }
  return typeof input === "string" ? input : "";
}
// 解析 JSON 蓝图：支持对象 / JSON 文本 / .json 文件 / 前后废话与尾随逗号；返回 { ok, blueprint, message }。
function fromJson(input, options) {
  var opts = options && typeof options === "object" ? options : {};
  var bad = { ok: false, blueprint: null, message: "invalid JSON blueprint / JSON 蓝图解析失败" };
  try {
    var raw = input;
    if (typeof input === "string") {
      var text = readInput(input);
      if (repair && typeof repair.safeParse === "function") raw = repair.safeParse(text, null);
      else raw = JSON.parse(text);
    }
    if (!raw || typeof raw !== "object") return bad;
    var face = faceOf(opts.face || raw.face || DEFAULT_FACE);
    var entries = [];
    if (Array.isArray(raw.blocks) && raw.blocks.length > 0 && raw.blocks[0] && typeof raw.blocks[0] === "object") {
      entries = entriesFromBlocks(raw.blocks, face);
    } else if (raw.palette || raw.data) {
      entries = entriesFromPalette(raw, face);
    } else if (raw.Schematic || raw.Width) {
      var schem = entriesFromSchem(raw);
      entries = schem.blocks;
    }
    if (entries.length === 0) { bad.message = "empty blueprint / 蓝图没有可放置的方块"; return bad; }
    var origin = pointOf(opts.origin || raw.origin || raw.offset || {});
    var size = raw.size && typeof raw.size === "object" ? raw.size : { width: raw.width, height: raw.height, length: raw.length };
    var bp = blueprintOf(raw.name || opts.name || "blueprint", "json", origin, size, entries, { source: "json" });
    if (!bp) return bad;
    if (bp.size.width === 0) bp.size = sizeFromBlocks(entries);
    counters.parsed = counters.parsed + 1;
    return { ok: true, blueprint: bp, message: "JSON blueprint parsed / JSON 蓝图已解析" };
  } catch (e) {
    counters.failed = counters.failed + 1;
    bad.message = errText(e);
    logWarn("JSON 蓝图解析失败 / JSON parse failed: " + bad.message);
    return bad;
  }
}
// 由方块条目反推尺寸（宽 / 高 / 长）；空数组返回零尺寸。
function sizeFromBlocks(blocks) {
  var max = { width: 0, height: 0, length: 0 };
  try {
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i].x + 1 > max.width) max.width = blocks[i].x + 1;
      if (blocks[i].y + 1 > max.height) max.height = blocks[i].y + 1;
      if (blocks[i].z + 1 > max.length) max.length = blocks[i].z + 1;
    }
  } catch (e) { /* 返回已统计部分 */ }
  return max;
}
// 把任意输入转成 Buffer：支持 Buffer / Uint8Array / base64 文本 / .schem 文件路径；失败返回 null。
function toBuffer(input) {
  try {
    if (Buffer.isBuffer(input)) return input;
    if (input && typeof input === "object" && typeof input.length === "number") return Buffer.from(input);
    if (typeof input === "string") {
      if (input.length < 512 && fs.existsSync(input)) return fs.readFileSync(input);
      if (/^[A-Za-z0-9+/=\s]+$/.test(input) && input.length > 16) return Buffer.from(input.replace(/\s+/g, ""), "base64");
    }
  } catch (e) { return null; }
  return null;
}
// 解析 .schem 蓝图：gzip + NBT → Sponge Palette / Blocks；库缺失时支持 JSON 描述式 .schem 降级。
function fromSchem(input, options) {
  var opts = options && typeof options === "object" ? options : {};
  var bad = { ok: false, blueprint: null, message: "invalid .schem / .schem 蓝图解析失败" };
  try {
    var raw = input;
    if (typeof input === "string" && input.indexOf("{") >= 0) return fromJson(input, opts);
    var buf = toBuffer(input);
    if (!buf || buf.length < 2) { bad.message = "empty .schem / .schem 文件为空"; return bad; }
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
    if (!nbt || typeof nbt.parseUncompressed !== "function") {
      bad.message = "prismarine-nbt unavailable / NBT 解析库不可用";
      logWarn(bad.message);
      return bad;
    }
    var parsed = nbt.parseUncompressed(buf);
    var simple = typeof nbt.simplify === "function" ? nbt.simplify(parsed) : parsed;
    var built = entriesFromSchem(simple);
    if (built.blocks.length === 0) { bad.message = "no solid blocks / .schem 里没有实体方块"; return bad; }
    var origin = pointOf(opts.origin || (simple && simple.Offset) || {});
    var bp = blueprintOf(opts.name || "schematic", "schem", origin, built.size, built.blocks, { source: "schem", bytes: buf.length });
    if (!bp) return bad;
    counters.parsed = counters.parsed + 1;
    return { ok: true, blueprint: bp, message: "Sponge .schem parsed / .schem 蓝图已解析" };
  } catch (e) {
    counters.failed = counters.failed + 1;
    bad.message = errText(e);
    logWarn("Sponge .schem 解析失败 / schem parse failed: " + bad.message);
    return bad;
  }
}
// 自动识别格式并解析：.schem 后缀 / gzip magic 走 fromSchem，其余走 fromJson；失败只回 ok:false。
function parse(input, options) {
  var opts = options && typeof options === "object" ? options : {};
  try {
    var format = toText(opts.format).toLowerCase();
    if (format === "schem" || format === "nbt") return fromSchem(input, opts);
    if (format === "litematic" || format === "litematica") return fromLitematic(input, opts);
    if (format === "json") return fromJson(input, opts);
    if (typeof input === "string" && input.indexOf(".litematic") >= 0 && input.indexOf("{") < 0) return fromLitematic(input, opts);
    if (typeof input === "string" && (input.indexOf(".schem") >= 0 && input.indexOf("{") < 0)) return fromSchem(input, opts);
    var buf = toBuffer(input);
    if (buf && buf.length > 1 && buf[0] === 0x1f && buf[1] === 0x8b) return fromSchem(buf, opts);
    if (input && typeof input === "object" && (input.Schematic || input.Width)) return fromSchem(input, opts);
    var hit = fromJson(input, opts);
    if (!hit.ok) counters.failed = counters.failed + 1;
    return hit;
  } catch (e) {
    counters.failed = counters.failed + 1;
    return { ok: false, blueprint: null, message: errText(e) };
  }
}
// 兼容别名：normalize 与 parse 等价，便于调用方按语义选择。
function normalize(input, options) {
  return parse(input, options);
}
// 解析 .litematic：转给高维底盘；模块缺失时回 ok:false，绝不抛异常。
function fromLitematic(input, options) {
  if (!highdim || typeof highdim.fromLitematic !== "function") {
    return { ok: false, blueprint: null, message: "highdim unavailable / 高维蓝图模块不可用" };
  }
  try { return highdim.fromLitematic(input, options); }
  catch (e) { return { ok: false, blueprint: null, message: errText(e) }; }
}
// 生成 place_block_exact 高精度任务队列；模块缺失时返回空数组。
function buildExactTasks(blueprint, options) {
  try { if (highdim && typeof highdim.buildExactTasks === "function") return highdim.buildExactTasks(blueprint, options); }
  catch (e) { return []; }
  return [];
}
// 把 place_block_exact 队列压入黑板；模块缺失时回 ok:false。
function splitExactToTasks(blueprint, options) {
  if (!highdim || typeof highdim.splitExactToTasks !== "function") {
    return { ok: false, count: 0, taskIds: [], message: "highdim unavailable / 高维蓝图模块不可用" };
  }
  try { return highdim.splitExactToTasks(blueprint, options); }
  catch (e) { return { ok: false, count: 0, taskIds: [], message: errText(e) }; }
}
// 取一个方块条目的绝对世界坐标；坏蓝图返回原点。
function absolutePos(blueprint, block) {
  var bp = blueprint && typeof blueprint === "object" ? blueprint : {};
  var origin = pointOf(bp.origin);
  var one = block && typeof block === "object" ? block : {};
  return { x: origin.x + toInt(one.x, 0), y: origin.y + toInt(one.y, 0), z: origin.z + toInt(one.z, 0) };
}
// 自动算账：输出总材料清单、缺失清单、是否够料；inventory 可为对象 / 数组 / null，坏值按空背包。
function analyzeBlueprint(blueprint, inventory) {
  var out = { ok: false, total: {}, totalCount: 0, missing: {}, missingCount: 0,
    sufficient: false, blocks: 0, inventory: {}, message: "invalid blueprint / 蓝图不可用" };
  try {
    if (!blueprint || !Array.isArray(blueprint.blocks)) return out;
    var have = inventoryOf(inventory);
    out.inventory = have;
    for (var i = 0; i < blueprint.blocks.length; i++) {
      var name = cleanBlock(blueprint.blocks[i].block);
      if (!name) continue;
      out.total[name] = (out.total[name] || 0) + 1;
      out.totalCount = out.totalCount + 1;
    }
    for (var key in out.total) {
      if (!Object.prototype.hasOwnProperty.call(out.total, key)) continue;
      var lack = out.total[key] - (have[key] || 0);
      if (lack > 0) { out.missing[key] = lack; out.missingCount = out.missingCount + lack; }
    }
    out.blocks = blueprint.blocks.length;
    out.sufficient = out.missingCount === 0;
    out.ok = true;
    out.message = out.sufficient ? "materials sufficient / 材料齐备" : "materials missing / 材料不足";
    return out;
  } catch (e) {
    out.message = errText(e);
    return out;
  }
}
// 生成微观任务数组（不落板）：每项带绝对坐标、局部坐标、方块名、放置面、支撑点、jobId、role。
function buildTasks(blueprint, options) {
  var out = [];
  try {
    if (!blueprint || !Array.isArray(blueprint.blocks)) return out;
    var opts = options && typeof options === "object" ? options : {};
    var jobId = toText(opts.jobId) || "job-" + Date.now().toString(36) + "-" + (counters.split + 1);
    var face = faceOf(opts.face || DEFAULT_FACE);
    for (var i = 0; i < blueprint.blocks.length && i < MAX_BLOCKS; i++) {
      var one = blueprint.blocks[i];
      var pos = absolutePos(blueprint, one);
      var name = cleanBlock(one.block);
      if (!name) continue;
      out.push({
        index: i, jobId: jobId, action: opts.exact === true ? "place_block_exact" : "place", role: "builder",
        pos: pos, local: { x: toInt(one.x, 0), y: toInt(one.y, 0), z: toInt(one.z, 0) },
        block: name, face: faceOf(one.face || face),
        props: one.props && typeof one.props === "object" ? one.props : {},
        stateId: one.stateId === undefined ? null : one.stateId,
        support: { x: pos.x, y: pos.y - 1, z: pos.z },
        priority: Number(opts.priority) || 5
      });
    }
  } catch (e) { return out; }
  return out;
}
// 拆单并压入共享黑板任务池；options.board 可注入假板（自测隔离），失败逐单降级不抛错。
function splitBlueprintToTasks(blueprint, options) {
  var opts = options && typeof options === "object" ? options : {};
  var out = { ok: false, count: 0, tasks: [], taskIds: [], jobId: "", failed: 0, message: "board unavailable / 黑板不可用" };
  try {
    var tasks = buildTasks(blueprint, opts);
    if (tasks.length === 0) { out.message = "no tasks / 蓝图没有可拆的方块"; return out; }
    var b = opts.board || sharedBoard;
    if (!b || typeof b.postTask !== "function") { logWarn(out.message); return out; }
    out.jobId = tasks[0].jobId;
    for (var i = 0; i < tasks.length; i++) {
      var posted = null;
      try {
        posted = b.postTask({
          title: tasks[i].action === "place_block_exact" ? "build:place_exact" : "build:place",
          priority: tasks[i].priority,
          payload: { action: tasks[i].action, role: "builder", jobId: tasks[i].jobId, index: tasks[i].index,
            pos: tasks[i].pos, local: tasks[i].local, block: tasks[i].block,
            face: tasks[i].face, support: tasks[i].support,
            props: tasks[i].props, stateId: tasks[i].stateId,
            expectedState: { name: tasks[i].block, props: tasks[i].props, stateId: tasks[i].stateId },
            maxRetries: 2 }
        });
      } catch (ePost) { posted = null; }
      if (posted && posted.ok) { out.taskIds.push(posted.taskId); out.tasks.push(tasks[i]); }
      else out.failed = out.failed + 1;
    }
    out.count = out.taskIds.length;
    out.ok = out.count > 0;
    counters.split = counters.split + 1;
    counters.tasks = counters.tasks + out.count;
    counters.jobs[out.jobId] = { count: out.count, at: Date.now(), name: toText(blueprint && blueprint.name) };
    out.message = out.ok ? "blueprint split / 蓝图已拆单入池" : "all tasks failed / 全部任务发布失败";
    logInfo("拆单 / split: " + out.jobId + " tasks=" + out.count + " failed=" + out.failed);
    emit("blueprint.split", { jobId: out.jobId, count: out.count, name: toText(blueprint && blueprint.name) });
    return out;
  } catch (e) {
    out.message = errText(e);
    logWarn("蓝图拆单失败 / split failed: " + out.message);
    return out;
  }
}
// 列出已拆过的作业（副本），供控制台与自测核对。
function listJobs() {
  try { return clone(counters.jobs); } catch (e) { return {}; }
}
// 统计快照：解析 / 拆单 / 任务 / 失败次数。
function stats() {
  return { ok: true, parsed: counters.parsed, split: counters.split, tasks: counters.tasks,
    failed: counters.failed, jobs: Object.keys(counters.jobs).length, maxBlocks: MAX_BLOCKS };
}
// 清空内存计数（不触碰黑板持久化任务）；供自测隔离。
function reset() {
  try { counters = { parsed: 0, split: 0, tasks: 0, failed: 0, jobs: {} }; } catch (e) { /* ignore */ }
  return { ok: true, message: "blueprint stats reset / 蓝图统计已重置" };
}

// 对外导出：解析 / 算账 / 拆单 / 诊断。
module.exports = {
  parse: parse,
  normalize: normalize,
  fromJson: fromJson,
  fromSchem: fromSchem,
  fromLitematic: fromLitematic,
  absolutePos: absolutePos,
  analyzeBlueprint: analyzeBlueprint,
  buildTasks: buildTasks,
  buildExactTasks: buildExactTasks,
  splitBlueprintToTasks: splitBlueprintToTasks,
  splitExactToTasks: splitExactToTasks,
  sizeFromBlocks: sizeFromBlocks,
  cleanBlock: cleanBlock,
  inventoryOf: inventoryOf,
  listJobs: listJobs,
  stats: stats,
  reset: reset,
  FACES: FACES,
  MAX_BLOCKS: MAX_BLOCKS,
  DEFAULT_FACE: DEFAULT_FACE
};
