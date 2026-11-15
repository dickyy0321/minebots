// ========================================
// 文件：modules/litematic-codec.js
// 功能：Litematica (.litematic) 底层编解码——gzip + NBT + BlockStates LongArray 位压缩流；
//       bitsPerBlock = max(2, ceil(log2(palette.length)))；把整个 LongArray 视为一条连续比特流，
//       按 i * bitsPerBlock 起始位做跨 32 位字 / 跨 Long 边界的位提取；按 YZX 顺序把一维索引
//       还原成 (x,y,z) 并叠加 Regions.<name>.Position 得到绝对坐标；解析 BlockStatePalette 的
//       {Name, Properties} 列表与 compound 映射两种格式；反向编码供 SDF 体素模型导出 .litematic。
// 依赖：Node 内置 zlib / fs、prismarine-nbt（可选）、./json-repair（可选）、
//       ./event-bus（可选）、./logger（可选）；不依赖 blueprint-highdim，避免循环引用。
// 导出：bitsPerBlock / longWords / extractBits / decodeBlockStates / encodeBlockStates /
//       coordinateOf / absoluteOf / paletteOf / readRegion / parse / encode / stats / reset /
//       MIN_BITS / MAX_BLOCKS
// 作者：MineBots
// ========================================
//
// 设计 / design
//   1. Litematica 沿用旧版紧凑布局：palette 只有 2 项时 bitsPerBlock 仍为 2，不能退化成 1 位，
//      否则一个 long 里会解出 64 个条目而不是 32 个，坐标全错。
//   2. 位宽用整数循环 cap = cap * 2 计算，等价于 max(2, ceil(log2(n)))，但避开 log(4)/LN2
//      浮点误差把 2 算成 3 的经典坑。
//   3. prismarine-nbt 简化后的 TAG_Long_Array 是 [[hi,lo], ...]；本模块统一拆成低位字在前的
//      32 位字数组，位流因此跨 long 连续，无需对每个条目做 BigInt 移位。
//   4. 方块索引顺序是 YZX：index = (y * length + z) * width + x；绝对坐标 = Position + 局部坐标。
// CommonJS，ES5 风格，无中文变量名；所有外部调用包 try/catch，日志双语，绝不把异常抛到顶层。
var fs = require("fs");
var zlib = require("zlib");
var nbt = null;
try { nbt = require("prismarine-nbt"); } catch (e) { nbt = null; }
var repair = null;
try { repair = require("./json-repair"); } catch (e) { repair = null; }
var bus = null;
try { bus = require("./event-bus"); } catch (e) { bus = null; }
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：最小位宽 / 方块上限 / 合法放置面 / 空气别名 / 需要保留的状态键。
var MIN_BITS = 2;
var MAX_BLOCKS = 20000;
var FACES = ["up", "down", "north", "south", "east", "west"];
var AIR_NAMES = ["air", "cave_air", "void_air", "structure_void", ""];
var counters = { parsed: 0, regions: 0, decoded: 0, encoded: 0, failed: 0 };

// 写文件日志：蓝图解析属高频信息，只落文件不刷 GUI。
function logInfo(msg) {
  try { if (logger && typeof logger.info === "function") logger.info("[litematic] " + msg); } catch (e) { /* ignore */ }
}
// 写告警日志：解码失败要让人看见；logger 缺失退回 console。
function logWarn(msg) {
  try { if (logger && typeof logger.warn === "function") { logger.warn("[litematic] " + msg); return; } }
  catch (e) { /* 退回 console */ }
  try { console.warn("[litematic] " + msg); } catch (e2) { /* ignore */ }
}
// 广播低频事件：总线缺失时静默跳过。
function emit(name, payload) {
  try { if (bus && typeof bus.emit === "function") bus.emit(name, payload); } catch (e) { /* ignore */ }
}
// 安全转错误文本：catch 里绝不二次抛错。
function errText(err) {
  try { if (err && err.message) return String(err.message); return String(err); }
  catch (e) { return "unknown error / 未知错误"; }
}
// 安全转字符串：null / undefined 统一成空串。
function toText(value) {
  try { return value === null || value === undefined ? "" : String(value); } catch (e) { return ""; }
}
// 取 NBT 简化值：兼容 {type:"int",value:2} / 纯数字 / 字符串。
function valueOf(value, fallback) {
  try {
    if (value === null || value === undefined) return fallback;
    if (typeof value === "object" && value.value !== undefined) return value.value;
    return value;
  } catch (e) { return fallback; }
}
// 安全转整数：坏值回 fallback，负数与 NaN 都不放行。
function toInt(value, fallback) {
  try { var n = Number(valueOf(value, NaN)); if (isNaN(n) || !isFinite(n)) return fallback; return Math.round(n); }
  catch (e) { return fallback; }
}
// 归一化方块名：去命名空间、小写、只留合法字符；空气返回空串。
function cleanBlock(value) {
  try {
    var name = toText(value).toLowerCase().trim();
    if (name.indexOf("minecraft:") === 0) name = name.slice(10);
    name = name.replace(/[^a-z0-9_]/g, "");
    if (AIR_NAMES.indexOf(name) >= 0) return "";
    return name;
  } catch (e) { return ""; }
}
// 拆分方块规格："oak_stairs[facing=north,half=top]" → { block, state }；失败返回空块。
function splitSpec(value) {
  var text = toText(value).trim();
  var out = { block: text, state: "" };
  try {
    var at = text.indexOf("[");
    if (at >= 0) {
      var end = text.lastIndexOf("]");
      out.block = text.slice(0, at);
      if (end > at) out.state = text.slice(at + 1, end);
    }
    out.block = cleanBlock(out.block);
  } catch (e) { out.block = cleanBlock(text); }
  return out;
}
// 解析状态串 / Properties 对象："facing=north,delay=2" → { facing:"north", delay:"2" }。
function parseProps(value) {
  var out = {};
  try {
    if (!value) return out;
    if (typeof value === "object" && !Array.isArray(value)) {
      for (var key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        out[toText(key).toLowerCase()] = toText(valueOf(value[key], ""));
      }
      return out;
    }
    if (Array.isArray(value)) {
      for (var a = 0; a < value.length; a++) {
        var one = parseProps(value[a]);
        for (var k in one) if (Object.prototype.hasOwnProperty.call(one, k)) out[k] = one[k];
      }
      return out;
    }
    var parts = toText(value).replace(/^\[|\]$/g, "").replace(/;/g, ",").split(",");
    for (var p = 0; p < parts.length; p++) {
      var pair = parts[p].split("=");
      if (pair.length < 2) continue;
      var name = toText(pair[0]).toLowerCase().trim().replace(/[^a-z0-9_]/g, "");
      var val = toText(pair[1]).trim().replace(/^["']|["']$/g, "");
      if (name.length > 0) out[name] = val;
    }
  } catch (e) { return out; }
  return out;
}
// 把任意输入转成 Buffer：Buffer / 数字数组 / base64 / .litematic 文件路径；失败返回 null。
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
// 计算 Litematica 位宽：max(2, ceil(log2(paletteSize)))；整数循环规避浮点误差，坏值回 2。
function bitsPerBlock(paletteSize) {
  try {
    var n = toInt(paletteSize, 2);
    if (n < 2) n = 2;
    var bits = 0;
    var cap = 1;
    while (cap < n) { cap = cap * 2; bits = bits + 1; }
    return Math.max(MIN_BITS, bits);
  } catch (e) { return MIN_BITS; }
}
// 归一化 LongArray：输出低位字在前的 32 位字数组；支持 [[hi,lo]] / BigInt64Array / Buffer / 数字数组 / {low,high}。
function longWords(raw) {
  var words = [];
  try {
    var list = raw;
    if (raw && typeof raw === "object" && !Array.isArray(raw) && !Buffer.isBuffer(raw) && Array.isArray(raw.value)) {
      list = raw.value;
    }
    if (Buffer.isBuffer(list)) {
      for (var b = 0; b + 7 < list.length; b = b + 8) {
        words.push(list.readUInt32BE(b + 4) >>> 0, list.readUInt32BE(b) >>> 0);
      }
      return words;
    }
    if (!Array.isArray(list) && !(list && typeof list.length === "number")) return words;
    var total = list.length;
    for (var i = 0; i < total; i++) {
      var one = list[i];
      if (Array.isArray(one) && one.length >= 2) {
        // prismarine-nbt 简化为 [hi, lo]；位流从低位开始，所以先放 lo 再放 hi。
        words.push(Number(valueOf(one[1], 0)) >>> 0, Number(valueOf(one[0], 0)) >>> 0);
      } else if (typeof one === "bigint") {
        var mask = BigInt(4294967295);
        var lo = Number(one & mask) >>> 0;
        var hi = Number((one >> BigInt(32)) & mask) >>> 0;
        words.push(lo, hi);
      } else if (typeof one === "number") {
        words.push(one >>> 0, 0);
      } else if (one && typeof one === "object") {
        words.push(Number(valueOf(one.low, 0)) >>> 0, Number(valueOf(one.high, 0)) >>> 0);
      }
    }
  } catch (e) { return words; }
  return words;
}
// 从连续比特流的 start 位取 bits 位：逐位跨 32 位字 / 跨 Long 边界，返回无符号整数。
function extractBits(words, start, bits) {
  var value = 0;
  try {
    for (var b = 0; b < bits; b++) {
      var n = start + b;
      var w = Math.floor(n / 32);
      if (w >= words.length) break;
      var bit = (words[w] >>> (n % 32)) & 1;
      if (bit) value = value + Math.pow(2, b);
    }
  } catch (e) { return 0; }
  return value;
}
// 位压缩解码：第 i 个方块起始位 i * bitsPerBlock；越界索引回 0（空气），失败返回已解部分。
function decodeBlockStates(raw, paletteSize, count, options) {
  var out = [];
  try {
    var size = toInt(paletteSize, 1);
    if (size < 1) size = 1;
    var total = Math.min(Math.max(0, toInt(count, 0)), MAX_BLOCKS);
    var bits = bitsPerBlock(size);
    var words = longWords(raw);
    for (var i = 0; i < total; i++) {
      var v = extractBits(words, i * bits, bits);
      out.push(v < size ? v : 0);
    }
    counters.decoded = counters.decoded + total;
  } catch (e) { return out; }
  return out;
}
// 位压缩编码：把 palette 索引写回同一条连续比特流，输出 prismarine-nbt 的 [[hi,lo]] 形式。
function encodeBlockStates(ids, paletteSize, options) {
  var out = [[0, 0]];
  try {
    var size = toInt(paletteSize, 1);
    if (size < 1) size = 1;
    var list = Array.isArray(ids) ? ids : [];
    var total = Math.min(list.length, MAX_BLOCKS);
    var bits = bitsPerBlock(size);
    var longCount = Math.max(1, Math.ceil(total * bits / 64));
    var words = [];
    for (var w = 0; w < longCount * 2; w++) words.push(0);
    for (var i = 0; i < total; i++) {
      var v = toInt(list[i], 0);
      if (v < 0 || v >= size) v = 0;
      for (var b = 0; b < bits; b++) {
        if (Math.floor(v / Math.pow(2, b)) % 2 === 1) {
          var n = i * bits + b;
          var wi = Math.floor(n / 32);
          if (wi < words.length) words[wi] = (words[wi] | (1 << (n % 32))) >>> 0;
        }
      }
    }
    out = [];
    for (var k = 0; k < longCount; k++) out.push([words[k * 2 + 1] >>> 0, words[k * 2] >>> 0]);
    counters.encoded = counters.encoded + 1;
  } catch (e) { return [[0, 0]]; }
  return out;
}
// YZX 一维索引还原局部三维坐标：index = (y * length + z) * width + x；越界用 valid 标记。
function coordinateOf(index, size) {
  try {
    var s = size && typeof size === "object" ? size : {};
    var w = Math.max(1, toInt(s.width === undefined ? s.x : s.width, 1));
    var h = Math.max(1, toInt(s.height === undefined ? s.y : s.height, 1));
    var l = Math.max(1, toInt(s.length === undefined ? s.z : s.length, 1));
    var i = Math.max(0, toInt(index, 0));
    var x = i % w;
    var z = Math.floor(i / w) % l;
    var y = Math.floor(i / (w * l)) % h;
    return { x: x, y: y, z: z, index: i, valid: i < w * h * l };
  } catch (e) { return { x: 0, y: 0, z: 0, index: 0, valid: false }; }
}
// 按 Regions.<name>.Position 叠加偏移得到绝对坐标；坏值回原点。
function absoluteOf(local, position) {
  try {
    var p = position && typeof position === "object" ? position : {};
    var l = local && typeof local === "object" ? local : {};
    return { x: toInt(p.x, 0) + toInt(l.x, 0),
      y: toInt(p.y, 0) + toInt(l.y, 0),
      z: toInt(p.z, 0) + toInt(l.z, 0) };
  } catch (e) { return { x: 0, y: 0, z: 0 }; }
}
// 解析 BlockStatePalette：数组 [{Name,Properties}] 与 compound 映射 {"minecraft:air":0} 双格式。
function paletteOf(region) {
  var out = { names: [], props: [], size: 0 };
  try {
    var pal = region.BlockStatePalette || region.blockStatePalette || region.Palette || region.palette;
    if (Array.isArray(pal)) {
      for (var i = 0; i < pal.length; i++) {
        var entry = pal[i] && typeof pal[i] === "object" ? pal[i] : { Name: pal[i] };
        // 兼容未 simplify 的原始 NBT：Name 可能是 {type:"string",value:"..."}，Properties 可能是 compound 标签。
        var rawName = valueOf(entry.Name || entry.name || entry.block || "", "");
        var spec = splitSpec(rawName);
        var pp = parseProps(spec.state);
        var more = parseProps(valueOf(entry.Properties || entry.properties || null, null));
        for (var k in more) if (Object.prototype.hasOwnProperty.call(more, k)) pp[k] = more[k];
        out.names[i] = spec.block;
        out.props[i] = pp;
      }
      out.size = pal.length;
    } else if (pal && typeof pal === "object") {
      var maxIndex = -1;
      for (var key in pal) {
        if (!Object.prototype.hasOwnProperty.call(pal, key)) continue;
        var idx = toInt(pal[key], -1);
        if (idx < 0 || idx >= MAX_BLOCKS) continue;
        var sp = splitSpec(key);
        out.names[idx] = sp.block;
        out.props[idx] = parseProps(sp.state);
        if (idx > maxIndex) maxIndex = idx;
      }
      out.size = maxIndex + 1;
      for (var f = 0; f < out.size; f++) {
        if (out.names[f] === undefined) out.names[f] = "";
        if (out.props[f] === undefined) out.props[f] = {};
      }
    }
  } catch (e) { return out; }
  return out;
}
// 读单个 Region：Size / Position / Palette / BlockStates → 带绝对坐标和属性的方块条目。
function readRegion(name, region, options) {
  var out = { ok: false, name: toText(name) || "region", size: { width: 0, height: 0, length: 0 },
    position: { x: 0, y: 0, z: 0 }, bits: 0, paletteSize: 0, blocks: [], message: "empty region / 空区域" };
  try {
    var reg = region && typeof region === "object" ? region : {};
    var sz = reg.Size || reg.size || {};
    var width = Math.max(0, toInt(sz.x === undefined ? sz.width : sz.x, 0));
    var height = Math.max(0, toInt(sz.y === undefined ? sz.height : sz.y, 0));
    var length = Math.max(0, toInt(sz.z === undefined ? sz.length : sz.z, 0));
    if (width === 0 || height === 0 || length === 0) return out;
    var pos = reg.Position || reg.position || {};
    out.size = { width: width, height: height, length: length };
    out.position = { x: toInt(pos.x, 0), y: toInt(pos.y, 0), z: toInt(pos.z, 0) };
    var pal = paletteOf(reg);
    out.paletteSize = pal.size;
    out.bits = bitsPerBlock(pal.size);
    // 描述式降级：直接给 Blocks 数组时按它走，不依赖 NBT 库。
    var direct = Array.isArray(reg.Blocks) ? reg.Blocks : (Array.isArray(reg.blocks) ? reg.blocks : null);
    if (direct) {
      for (var d = 0; d < direct.length && out.blocks.length < MAX_BLOCKS; d++) {
        var row = direct[d] && typeof direct[d] === "object" ? direct[d] : {};
        var si = splitSpec(row.block || row.name || "");
        if (!si.block) continue;
        var rp = parseProps(si.state);
        var localRow = { x: toInt(row.x, 0), y: toInt(row.y, 0), z: toInt(row.z, 0) };
        out.blocks.push({ x: localRow.x, y: localRow.y, z: localRow.z,
          absolute: absoluteOf(localRow, out.position), block: si.block, props: rp,
          face: rp.facing && FACES.indexOf(rp.facing) >= 0 ? rp.facing : "up", paletteIndex: -1 });
      }
      out.ok = out.blocks.length > 0;
      out.message = out.ok ? "region read / 区域已读取" : "no solid blocks / 区域没有实体方块";
      return out;
    }
    if (pal.size === 0) return out;
    var count = Math.min(width * height * length, MAX_BLOCKS);
    var raw = reg.BlockStates || reg.blockStates || reg.BlockData || reg.blockData || [];
    var ids = decodeBlockStates(raw, pal.size, count);
    for (var i = 0; i < count && out.blocks.length < MAX_BLOCKS; i++) {
      var pid = ids[i] || 0;
      var blockName = pal.names[pid] || "";
      if (!blockName) continue;
      var props = pal.props[pid] || {};
      var local = coordinateOf(i, out.size);
      out.blocks.push({ x: local.x, y: local.y, z: local.z,
        absolute: absoluteOf(local, out.position), block: blockName, props: props,
        face: props.facing && FACES.indexOf(props.facing) >= 0 ? props.facing : "up", paletteIndex: pid });
    }
    out.ok = true;
    out.message = "region decoded / 区域位流已解码";
    counters.regions = counters.regions + 1;
    logInfo("区域解码 / region: " + out.name + " size=" + width + "x" + height + "x" + length +
      " bits=" + out.bits + " blocks=" + out.blocks.length);
  } catch (e) {
    out.message = errText(e);
    logWarn("区域解码失败 / region decode failed: " + out.message);
  }
  return out;
}
// 解析完整 .litematic：gzip → NBT → simplify → 逐 Region 解码；也接受已简化对象 / JSON 描述式。
function parse(input, options) {
  var out = { ok: false, regions: [], blocks: [], origin: { x: 0, y: 0, z: 0 },
    size: { width: 0, height: 0, length: 0 }, message: "invalid .litematic / 高维蓝图解析失败" };
  try {
    var root = null;
    if (input && typeof input === "object" && !Buffer.isBuffer(input) && !Array.isArray(input)) root = input;
    if (typeof input === "string" && input.indexOf("{") >= 0) {
      if (repair && typeof repair.safeParse === "function") root = repair.safeParse(input, null);
      else root = JSON.parse(input);
    }
    if (!root) {
      var buf = toBuffer(input);
      if (!buf || buf.length < 2) { out.message = "empty .litematic / 文件为空"; return out; }
      if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
      if (!nbt || typeof nbt.parseUncompressed !== "function") {
        out.message = "prismarine-nbt unavailable / NBT 解析库不可用";
        logWarn(out.message);
        return out;
      }
      var parsed = nbt.parseUncompressed(buf);
      root = typeof nbt.simplify === "function" ? nbt.simplify(parsed) : parsed;
    }
    if (!root || typeof root !== "object") return out;
    var regs = root.Regions || root.regions || null;
    if (!regs || typeof regs !== "object") { out.message = "no Regions / 缺少 Regions 字段"; return out; }
    var first = true;
    for (var name in regs) {
      if (!Object.prototype.hasOwnProperty.call(regs, name)) continue;
      var rr = readRegion(name, regs[name], options);
      if (!rr.ok) continue;
      out.regions.push(rr);
      if (first) { out.origin = rr.position; out.size = rr.size; first = false; }
      for (var b = 0; b < rr.blocks.length && out.blocks.length < MAX_BLOCKS; b++) out.blocks.push(rr.blocks[b]);
    }
    out.ok = out.regions.length > 0;
    out.message = out.ok ? ".litematic decoded / 高维蓝图位流已解码" : "no solid regions / 没有实体区域";
    if (out.ok) {
      counters.parsed = counters.parsed + 1;
      emit("litematic.decoded", { regions: out.regions.length, blocks: out.blocks.length, at: Date.now() });
    } else counters.failed = counters.failed + 1;
  } catch (e) {
    counters.failed = counters.failed + 1;
    out.message = errText(e);
    logWarn(".litematic 解析失败 / parse failed: " + out.message);
  }
  return out;
}
// 反向编码：把统一蓝图对象写成真实 gzip + NBT 的 .litematic；库缺失返回 ok:false，绝不抛错。
function encode(blueprint, options) {
  var opts = options && typeof options === "object" ? options : {};
  var out = { ok: false, buffer: null, palette: [], bits: 0, message: "nbt unavailable / NBT 编码库不可用" };
  try {
    if (!nbt || typeof nbt.writeUncompressed !== "function") { logWarn(out.message); return out; }
    var bp = blueprint && typeof blueprint === "object" ? blueprint : {};
    var blocks = Array.isArray(bp.blocks) ? bp.blocks : [];
    if (blocks.length === 0) { out.message = "empty blueprint / 空蓝图"; return out; }
    var size = bp.size && bp.size.width ? bp.size : sizeFromBlocks(blocks);
    var width = Math.max(1, toInt(size.width, 1));
    var height = Math.max(1, toInt(size.height, 1));
    var length = Math.max(1, toInt(size.length, 1));
    var cap = Math.min(width * height * length, MAX_BLOCKS);
    // palette 索引 0 固定为空气，其余按 block + props 去重。
    var palette = ["minecraft:air"];
    var keys = { "minecraft:air": 0 };
    var ids = [];
    var b = 0;
    for (b = 0; b < cap; b++) ids.push(0);
    for (var i = 0; i < blocks.length; i++) {
      var one = blocks[i] || {};
      var name = cleanBlock(one.block);
      if (!name) continue;
      var lx = toInt(one.x, 0), ly = toInt(one.y, 0), lz = toInt(one.z, 0);
      if (lx < 0 || ly < 0 || lz < 0 || lx >= width || ly >= height || lz >= length) continue;
      var props = one.props && typeof one.props === "object" ? one.props : {};
      var parts = [];
      for (var pk in props) if (Object.prototype.hasOwnProperty.call(props, pk)) parts.push(pk + "=" + toText(props[pk]));
      parts.sort();
      var spec = "minecraft:" + name + (parts.length > 0 ? "[" + parts.join(",") + "]" : "");
      var pid = keys[spec];
      if (pid === undefined) {
        if (palette.length >= MAX_BLOCKS) continue;
        pid = palette.length;
        keys[spec] = pid;
        palette.push(spec);
      }
      var index = (ly * length + lz) * width + lx;
      if (index >= 0 && index < cap) ids[index] = pid;
    }
    out.palette = palette;
    out.bits = bitsPerBlock(palette.length);
    var states = encodeBlockStates(ids, palette.length, opts);
    // prismarine-nbt 的 TAG_List<TAG_Compound> 元素必须是「compound 的 value 字典」，不能再包一层 type/name。
    var palList = [];
    for (var p = 0; p < palette.length; p++) palList.push({ Name: { type: "string", value: palette[p] } });
    var origin = bp.origin || { x: 0, y: 0, z: 0 };
    var region = { type: "compound", value: {
      Position: { type: "compound", value: {
        x: { type: "int", value: toInt(origin.x, 0) }, y: { type: "int", value: toInt(origin.y, 0) },
        z: { type: "int", value: toInt(origin.z, 0) } } },
      Size: { type: "compound", value: {
        x: { type: "int", value: width }, y: { type: "int", value: height }, z: { type: "int", value: length } } },
      BlockStatePalette: { type: "list", value: { type: "compound", value: palList } },
      BlockStates: { type: "longArray", value: states }
    } };
    var root = { type: "compound", name: "", value: {
      MinecraftDataVersion: { type: "int", value: 2975 },
      Version: { type: "int", value: 6 },
      SubVersion: { type: "int", value: 1 },
      Regions: { type: "compound", value: { main: region } }
    } };
    out.buffer = zlib.gzipSync(nbt.writeUncompressed(root));
    out.ok = true;
    out.message = ".litematic encoded / 高维蓝图已编码";
    emit("litematic.encoded", { blocks: blocks.length, palette: palette.length, bits: out.bits, at: Date.now() });
  } catch (e) {
    counters.failed = counters.failed + 1;
    out.message = errText(e);
    logWarn(".litematic 编码失败 / encode failed: " + out.message);
  }
  return out;
}
// 由方块条目反推尺寸；空数组返回零尺寸。
function sizeFromBlocks(blocks) {
  var max = { width: 0, height: 0, length: 0 };
  try {
    for (var i = 0; i < blocks.length; i++) {
      var one = blocks[i] || {};
      if (toInt(one.x, 0) + 1 > max.width) max.width = toInt(one.x, 0) + 1;
      if (toInt(one.y, 0) + 1 > max.height) max.height = toInt(one.y, 0) + 1;
      if (toInt(one.z, 0) + 1 > max.length) max.length = toInt(one.z, 0) + 1;
    }
  } catch (e) { /* 返回已统计部分 */ }
  return max;
}
// 统计快照：解析 / 区域 / 解码条目 / 编码 / 失败次数。
function stats() {
  return { ok: true, parsed: counters.parsed, regions: counters.regions, decoded: counters.decoded,
    encoded: counters.encoded, failed: counters.failed, minBits: MIN_BITS };
}
// 清空内存计数（不触碰磁盘）；供自测隔离。
function reset() {
  try { counters = { parsed: 0, regions: 0, decoded: 0, encoded: 0, failed: 0 }; } catch (e) { /* ignore */ }
  return { ok: true, message: "litematic stats reset / 编解码统计已重置" };
}

// 对外导出：位运算 / 坐标 / palette / Region / 完整解析与编码 / 诊断。
module.exports = {
  bitsPerBlock: bitsPerBlock,
  longWords: longWords,
  extractBits: extractBits,
  decodeBlockStates: decodeBlockStates,
  encodeBlockStates: encodeBlockStates,
  coordinateOf: coordinateOf,
  absoluteOf: absoluteOf,
  paletteOf: paletteOf,
  readRegion: readRegion,
  parse: parse,
  encode: encode,
  stats: stats,
  reset: reset,
  MIN_BITS: MIN_BITS,
  MAX_BLOCKS: MAX_BLOCKS
};
