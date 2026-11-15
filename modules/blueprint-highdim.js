// ========================================
// 文件：modules/blueprint-highdim.js
// 功能：高维蓝图底盘——解析方块全部状态属性（facing=north / half=top / delay=2）、
//       真实 .litematic（gzip + NBT + 位压缩 BlockStates）解码、生成 place_block_exact 任务队列
// 依赖：Node 内置 fs / path / zlib、prismarine-nbt（可选）、./json-repair（可选）、
//       ./litematic-codec（底层位解码，可选）、./shared-board（可选）、./event-bus（可选）、./logger（可选）
// 导出：splitSpec / parseProps / propsOf / fromLitematic / decodeBlockStates / bitsPerBlock /
//       buildExactTasks / splitExactToTasks / FACES / stats / reset / litematicCodec
// 作者：MineBots
// ========================================
//
// 设计 / design
//   1. 方块名与状态可以写在一起："minecraft:oak_stairs[facing=north,half=top]"，
//      splitSpec 先把方括号状态剥离，避免 cleanBlock 把它揉成一段乱码方块名。
//   2. Litematica 的 BlockStates 位流全权交给 litematic-codec：bits = max(2, ceil(log2(palette)))，
//      索引顺序 (y * sizeZ + z) * sizeX + x，long 内低位在前，跨 long 边界逐位提取并按 Position 映射绝对坐标。
//   3. place_block_exact 任务带完整 expectedState（props + facing + stateId），供放置节点校验与返工。
// CommonJS，ES5 风格，无中文变量名；所有外部调用包 try/catch，日志与报错双语。
var fs = require("fs");
var path = require("path");
var zlib = require("zlib");
var nbt = null;
try { nbt = require("prismarine-nbt"); } catch (e) { nbt = null; }
var repair = null;
try { repair = require("./json-repair"); } catch (e) { repair = null; }
// 可选依赖：Litematica 底层 LongArray 位解码器（本模块只做蓝图归一化与任务队列，不再自己拆比特）。
var codec = null;
try { codec = require("./litematic-codec"); } catch (e) { codec = null; }
var sharedBoard = null;
try { sharedBoard = require("./shared-board"); } catch (e) { sharedBoard = null; }
var bus = null;
try { bus = require("./event-bus"); } catch (e) { bus = null; }
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：合法放置面 / 需要校验的状态键 / 方块上限 / 内部计数。
var FACES = ["up", "down", "north", "south", "east", "west"];
var STATE_KEYS = ["facing", "half", "delay", "powered", "axis", "orientation", "type", "shape",
  "mode", "part", "open", "lit", "attached", "extended", "triggered", "rotation", "waterlogged"];
var MAX_BLOCKS = 20000;
var counters = { litematic: 0, exactTasks: 0, split: 0, failed: 0, jobs: {} };

// 写文件日志：拆单属高频信息，只落文件不刷 GUI。
function logInfo(msg) {
  try { if (logger && typeof logger.info === "function") logger.info("[highdim] " + msg); } catch (e) { /* ignore */ }
}
// 写告警日志：蓝图解析失败要让人看见。
function logWarn(msg) {
  try { if (logger && typeof logger.warn === "function") { logger.warn("[highdim] " + msg); return; } }
  catch (e) { /* 退回 console */ }
  try { console.warn("[highdim] " + msg); } catch (e2) { /* ignore */ }
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
// 安全转整数：坏值回 fallback。
function toInt(value, fallback) {
  try { var n = Number(value); if (isNaN(n) || !isFinite(n)) return fallback; return Math.round(n); }
  catch (e) { return fallback; }
}
// 归一化方块名：去命名空间、小写、只留合法字符；空气返回空串。
function cleanBlock(value) {
  try {
    var name = toText(value).toLowerCase().trim();
    if (name.indexOf("minecraft:") === 0) name = name.slice(10);
    name = name.replace(/[^a-z0-9_]/g, "");
    if (name === "air" || name === "cave_air" || name === "void_air" || name === "structure_void") return "";
    return name;
  } catch (e) { return ""; }
}
// 拆分方块规格：把 "oak_stairs[facing=north,half=top]" 拆成 { block, state }，无方括号时 state 为空。
function splitSpec(value) {
  var text = toText(value).trim();
  var out = { block: text, state: "", stateId: null };
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
// 解析状态串："facing=north,half=top,delay=2" → { facing:"north", half:"top", delay:"2" }。
function parseProps(value) {
  var out = {};
  try {
    if (!value) return out;
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) {
        var one = parseProps(value[i]);
        for (var k in one) if (Object.prototype.hasOwnProperty.call(one, k)) out[k] = one[k];
      }
      return out;
    }
    if (typeof value === "object") {
      for (var key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        var v = value[key];
        if (v && typeof v === "object" && v.value !== undefined) v = v.value;
        out[toText(key).toLowerCase()] = toText(v);
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
// 从一个蓝图条目 / palette 键提取全部状态属性，统一成 { block, props, stateId, face }。
function propsOf(one, defaultFace) {
  var out = { block: "", props: {}, stateId: null, face: "up" };
  try {
    var src = one && typeof one === "object" ? one : { block: one };
    var spec = splitSpec(src.block || src.name || src.item || src.material || one);
    out.block = spec.block;
    var props = parseProps(spec.state);
    var extra = parseProps(src.props || src.properties || src.state || src.states || src.blockStates || null);
    for (var k in props) if (Object.prototype.hasOwnProperty.call(props, k)) out.props[k] = props[k];
    for (var j in extra) if (Object.prototype.hasOwnProperty.call(extra, j)) out.props[j] = extra[j];
    if (src.stateId !== undefined && src.stateId !== null) out.stateId = src.stateId;
    else if (src.metadata !== undefined && src.type !== undefined) out.stateId = toInt(src.type, null);
    var face = toText(src.face || defaultFace || "up").toLowerCase();
    out.face = FACES.indexOf(face) >= 0 ? face : "up";
    // 从属性里补朝向：面向类方块没写 face 时，用 facing 决定放置面。
    if (out.face === "up" && out.props.facing && FACES.indexOf(out.props.facing) >= 0 && !src.face) {
      out.face = out.props.facing;
    }
  } catch (e) { /* 返回已解析部分 */ }
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
// 位压缩解码：委托底层 codec（位宽 max(2, ceil(log2(palette)))、跨 long 边界）；库缺失时按内置老算法降级。
function decodeBlockStates(raw, paletteSize, count) {
  var out = [];
  try {
    if (codec && typeof codec.decodeBlockStates === "function") {
      return codec.decodeBlockStates(raw, paletteSize, count, {});
    }
    var size = Math.max(1, toInt(paletteSize, 1));
    var total = Math.min(Math.max(0, toInt(count, 0)), MAX_BLOCKS);
    var bits = Math.max(1, Math.ceil(Math.log(Math.max(2, size)) / Math.LN2));
    var words = [];
    if (Array.isArray(raw)) {
      for (var i = 0; i < raw.length; i++) {
        var one = raw[i];
        if (Array.isArray(one) && one.length >= 2) words.push(Number(one[1]) >>> 0, Number(one[0]) >>> 0);
        else words.push(Number(one) >>> 0, 0);
      }
    }
    for (var n = 0; n < total; n++) {
      var start = n * bits;
      var value = 0;
      for (var b = 0; b < bits; b++) {
        var bitIndex = start + b;
        var w = Math.floor(bitIndex / 32);
        if (w >= words.length) break;
        if (((words[w] >>> (bitIndex % 32)) & 1) === 1) value = value + Math.pow(2, b);
      }
      out.push(value < size ? value : 0);
    }
  } catch (e) { return out; }
  return out;
}
// 取底层 codec 的位宽（max(2, ceil(log2(palette)))）；缺库时给保守值 2。
function bitsPerBlock(paletteSize) {
  try { if (codec && typeof codec.bitsPerBlock === "function") return codec.bitsPerBlock(paletteSize); }
  catch (e) { /* 降级 */ }
  return 2;
}
// codec 缺失时的最小降级：读 Size / Position / Palette / BlockStates，复用本模块的 decodeBlockStates。
function legacyRegion(region) {
  var out = { ok: false, size: { width: 0, height: 0, length: 0 }, position: { x: 0, y: 0, z: 0 }, blocks: [] };
  try {
    var sz = region.Size || region.size || {};
    var width = Math.max(0, toInt(sz.x === undefined ? sz.width : sz.x, 0));
    var height = Math.max(0, toInt(sz.y === undefined ? sz.height : sz.y, 0));
    var length = Math.max(0, toInt(sz.z === undefined ? sz.length : sz.z, 0));
    if (width === 0 || height === 0 || length === 0) return out;
    var pos = region.Position || region.position || {};
    out.size = { width: width, height: height, length: length };
    out.position = { x: toInt(pos.x, 0), y: toInt(pos.y, 0), z: toInt(pos.z, 0) };
    var direct = Array.isArray(region.Blocks) ? region.Blocks : (Array.isArray(region.blocks) ? region.blocks : null);
    if (direct) {
      for (var d = 0; d < direct.length && out.blocks.length < MAX_BLOCKS; d++) {
        var row = direct[d] && typeof direct[d] === "object" ? direct[d] : {};
        var info = propsOf(row, "up");
        if (!info.block) continue;
        out.blocks.push({ x: toInt(row.x, 0), y: toInt(row.y, 0), z: toInt(row.z, 0),
          block: info.block, face: info.face, props: info.props, paletteIndex: -1 });
      }
      out.ok = out.blocks.length > 0;
      return out;
    }
    var palette = region.BlockStatePalette || region.blockStatePalette || region.Palette || region.palette || [];
    var names = [], propsList = [];
    if (Array.isArray(palette)) {
      for (var p = 0; p < palette.length; p++) {
        var entry = palette[p] && typeof palette[p] === "object" ? palette[p] : { Name: palette[p] };
        var spec = splitSpec(entry.Name || entry.name || "");
        names.push(spec.block);
        var pp = parseProps(spec.state);
        var more = parseProps(entry.Properties || entry.properties || null);
        for (var mk in more) if (Object.prototype.hasOwnProperty.call(more, mk)) pp[mk] = more[mk];
        propsList.push(pp);
      }
    } else if (palette && typeof palette === "object") {
      for (var key in palette) {
        if (!Object.prototype.hasOwnProperty.call(palette, key)) continue;
        var idx = toInt(palette[key], -1);
        if (idx < 0) continue;
        var sp = splitSpec(key);
        names[idx] = sp.block;
        propsList[idx] = parseProps(sp.state);
      }
    }
    if (names.length === 0) return out;
    var count = Math.min(width * height * length, MAX_BLOCKS);
    var raw = region.BlockStates || region.blockStates || region.BlockData || region.blockData || [];
    var ids = decodeBlockStates(raw, names.length, count);
    for (var y = 0; y < height && out.blocks.length < MAX_BLOCKS; y++) {
      for (var z = 0; z < length && out.blocks.length < MAX_BLOCKS; z++) {
        for (var x = 0; x < width && out.blocks.length < MAX_BLOCKS; x++) {
          var pid = ids[(y * length + z) * width + x] || 0;
          var blockName = names[pid] || "";
          if (!blockName) continue;
          var pset = propsList[pid] || {};
          out.blocks.push({ x: x, y: y, z: z, block: blockName,
            face: FACES.indexOf(pset.facing) >= 0 ? pset.facing : "up", props: pset, paletteIndex: pid });
        }
      }
    }
    out.ok = true;
  } catch (e) { return out; }
  return out;
}
// 从简化后的 Litematica Regions 生成方块条目数组；位流与坐标映射交给 codec，失败返回空数组。
function entriesFromRegions(root) {
  var out = { blocks: [], size: { width: 0, height: 0, length: 0 }, origin: { x: 0, y: 0, z: 0 } };
  try {
    var regions = root && root.Regions ? root.Regions : (root && root.regions ? root.regions : null);
    if (!regions || typeof regions !== "object") return out;
    for (var name in regions) {
      if (!Object.prototype.hasOwnProperty.call(regions, name)) continue;
      var region = regions[name] && typeof regions[name] === "object" ? regions[name] : {};
      var built = codec && typeof codec.readRegion === "function"
        ? codec.readRegion(name, region, {}) : legacyRegion(region);
      if (!built || !built.ok || built.blocks.length === 0) continue;
      if (out.blocks.length === 0) { out.size = built.size; out.origin = built.position; }
      for (var i = 0; i < built.blocks.length && out.blocks.length < MAX_BLOCKS; i++) {
        var b = built.blocks[i];
        var pp = b.props || {};
        out.blocks.push({ x: toInt(b.x, 0), y: toInt(b.y, 0), z: toInt(b.z, 0),
          block: cleanBlock(b.block), face: FACES.indexOf(pp.facing) >= 0 ? pp.facing : "up",
          props: pp, stateId: null, paletteIndex: b.paletteIndex });
      }
    }
  } catch (e) { return out; }
  return out;
}
// 解析 .litematic：gzip + NBT 或 JSON 描述式 / 简化对象，输出 builder-blueprint 兼容的蓝图对象。
function fromLitematic(input, options) {
  var opts = options && typeof options === "object" ? options : {};
  var bad = { ok: false, blueprint: null, message: "invalid .litematic / 高维蓝图解析失败" };
  try {
    var root = null;
    if (input && typeof input === "object" && !Buffer.isBuffer(input) && !Array.isArray(input)) root = input;
    if (typeof input === "string" && input.indexOf("{") >= 0) {
      if (repair && typeof repair.safeParse === "function") root = repair.safeParse(input, null);
      else root = JSON.parse(input);
    }
    if (!root) {
      var buf = toBuffer(input);
      if (!buf || buf.length < 2) { bad.message = "empty .litematic / 文件为空"; return bad; }
      if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
      if (!nbt || typeof nbt.parseUncompressed !== "function") {
        bad.message = "prismarine-nbt unavailable / NBT 解析库不可用";
        logWarn(bad.message);
        return bad;
      }
      var parsed = nbt.parseUncompressed(buf);
      root = typeof nbt.simplify === "function" ? nbt.simplify(parsed) : parsed;
    }
    if (!root || typeof root !== "object") return bad;
    // 兼容直接给 blocks 数组的描述式蓝图。
    if (Array.isArray(root.blocks)) {
      var simple = [];
      for (var s = 0; s < root.blocks.length && simple.length < MAX_BLOCKS; s++) {
        var si = propsOf(root.blocks[s], "up");
        if (!si.block) continue;
        simple.push({ x: toInt(root.blocks[s].x, 0), y: toInt(root.blocks[s].y, 0), z: toInt(root.blocks[s].z, 0),
          block: si.block, face: si.face, props: si.props, stateId: si.stateId });
      }
      if (simple.length === 0) { bad.message = "no solid blocks / 蓝图没有实体方块"; return bad; }
      return blueprintOf(root, simple, { width: 0, height: 0, length: 0 }, opts, "json-litematic");
    }
    var built = entriesFromRegions(root);
    if (built.blocks.length === 0) { bad.message = "no solid blocks / .litematic 里没有实体方块"; return bad; }
    return blueprintOf(root, built.blocks, built.size, opts, "litematic", built.origin);
  } catch (e) {
    counters.failed = counters.failed + 1;
    bad.message = errText(e);
    logWarn(".litematic 解析失败 / parse failed: " + bad.message);
    return bad;
  }
}
// 组装统一蓝图对象（与 builder-blueprint 的字段完全一致）；失败返回 ok:false。
function blueprintOf(root, blocks, size, opts, format, origin) {
  try {
    if (!blocks || blocks.length === 0) return { ok: false, blueprint: null, message: "empty blueprint / 空蓝图" };
    var bp = {
      name: toText(opts.name || root.name || root.Name || "litematic") || "litematic",
      format: format,
      origin: opts.origin || origin || { x: 0, y: 0, z: 0 },
      size: size && size.width ? size : sizeFromBlocks(blocks),
      blocks: blocks.slice(0, MAX_BLOCKS),
      meta: { source: format, highdim: true }
    };
    counters.litematic = counters.litematic + 1;
    return { ok: true, blueprint: bp, message: ".litematic parsed / 高维蓝图已解析" };
  } catch (e) { return { ok: false, blueprint: null, message: errText(e) }; }
}
// 由方块条目反推尺寸；空数组返回零尺寸。
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
// 取绝对坐标：蓝图原点 + 局部坐标，坏值回原点。
function absolutePos(blueprint, block) {
  var bp = blueprint && typeof blueprint === "object" ? blueprint : {};
  var o = bp.origin || {};
  var one = block && typeof block === "object" ? block : {};
  return { x: toInt(o.x, 0) + toInt(one.x, 0), y: toInt(o.y, 0) + toInt(one.y, 0), z: toInt(o.z, 0) + toInt(one.z, 0) };
}
// 生成高精度 place_block_exact 任务队列（不落板）：每项带完整 expectedState 与放置面。
function buildExactTasks(blueprint, options) {
  var opts = options && typeof options === "object" ? options : {};
  var out = [];
  try {
    if (!blueprint || !Array.isArray(blueprint.blocks)) return out;
    var jobId = toText(opts.jobId) || "exact-" + Date.now().toString(36) + "-" + (counters.split + 1);
    for (var i = 0; i < blueprint.blocks.length && i < MAX_BLOCKS; i++) {
      var one = blueprint.blocks[i] || {};
      var info = propsOf(one, one.face || "up");
      var block = info.block || cleanBlock(one.block);
      if (!block) continue;
      var pos = absolutePos(blueprint, one);
      var expectedState = { name: block, props: info.props, stateId: info.stateId };
      for (var k = 0; k < STATE_KEYS.length; k++) {
        var key = STATE_KEYS[k];
        if (info.props[key] !== undefined) expectedState[key] = info.props[key];
      }
      out.push({
        index: i, jobId: jobId, action: "place_block_exact", role: "builder",
        pos: pos, local: { x: toInt(one.x, 0), y: toInt(one.y, 0), z: toInt(one.z, 0) },
        block: block, face: info.face, props: info.props, expectedState: expectedState,
        support: { x: pos.x, y: pos.y - 1, z: pos.z },
        priority: Number(opts.priority) || 5,
        maxRetries: toInt(opts.maxRetries, 2)
      });
    }
    counters.exactTasks = counters.exactTasks + out.length;
  } catch (e) { return out; }
  return out;
}
// 把 place_block_exact 队列压入共享黑板任务池；options.board 可注入假板，失败逐单降级不抛错。
function splitExactToTasks(blueprint, options) {
  var opts = options && typeof options === "object" ? options : {};
  var out = { ok: false, count: 0, tasks: [], taskIds: [], jobId: "", failed: 0,
    message: "board unavailable / 黑板不可用" };
  try {
    var tasks = buildExactTasks(blueprint, opts);
    if (tasks.length === 0) { out.message = "no tasks / 蓝图没有可拆的方块"; return out; }
    var board = opts.board || sharedBoard;
    if (!board || typeof board.postTask !== "function") { logWarn(out.message); return out; }
    out.jobId = tasks[0].jobId;
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      var posted = null;
      try {
        posted = board.postTask({ title: "build:place_exact", priority: t.priority,
          payload: { action: t.action, role: t.role, jobId: t.jobId, index: t.index,
            pos: t.pos, local: t.local, block: t.block, face: t.face, props: t.props,
            expectedState: t.expectedState, support: t.support, maxRetries: t.maxRetries } });
      } catch (ePost) { posted = null; }
      if (posted && posted.ok) { out.taskIds.push(posted.taskId); out.tasks.push(t); }
      else out.failed = out.failed + 1;
    }
    out.count = out.taskIds.length;
    out.ok = out.count > 0;
    counters.split = counters.split + 1;
    counters.jobs[out.jobId] = { count: out.count, at: Date.now(), name: toText(blueprint && blueprint.name) };
    out.message = out.ok ? "exact tasks queued / 精确放置任务已入池" : "all tasks failed / 全部任务发布失败";
    logInfo("精确拆单 / exact split: " + out.jobId + " tasks=" + out.count);
    emit("blueprint.exact_split", { jobId: out.jobId, count: out.count, at: Date.now() });
    return out;
  } catch (e) {
    out.message = errText(e);
    return out;
  }
}
// 统计快照：解析 / 任务 / 拆单 / 失败次数。
function stats() {
  return { ok: true, litematic: counters.litematic, exactTasks: counters.exactTasks,
    split: counters.split, failed: counters.failed, jobs: Object.keys(counters.jobs).length };
}
// 清空内存计数（不触碰黑板）；供自测隔离。
function reset() {
  try { counters = { litematic: 0, exactTasks: 0, split: 0, failed: 0, jobs: {} }; } catch (e) { /* ignore */ }
  return { ok: true, message: "highdim stats reset / 高维蓝图统计已重置" };
}

// 对外导出：属性解析 / .litematic / 精确任务 / 诊断。
module.exports = {
  splitSpec: splitSpec,
  parseProps: parseProps,
  propsOf: propsOf,
  fromLitematic: fromLitematic,
  decodeBlockStates: decodeBlockStates,
  bitsPerBlock: bitsPerBlock,
  litematicCodec: codec,
  entriesFromRegions: entriesFromRegions,
  buildExactTasks: buildExactTasks,
  splitExactToTasks: splitExactToTasks,
  sizeFromBlocks: sizeFromBlocks,
  stats: stats,
  reset: reset,
  FACES: FACES,
  STATE_KEYS: STATE_KEYS,
  MAX_BLOCKS: MAX_BLOCKS
};
