// ========================================
// 文件：modules/blueprint-mesher.js
// 功能：建筑蓝图体积填充优化——3D greedyMeshing 把相邻同材质方块合并成最大长方体，
//       生成 /fill x1 y1 z1 x2 y2 z2 minecraft:stone 指令流并压入共享黑板任务池（OP bot 抢单执行）；
//       复杂形状用 SDF（Signed Distance Functions）生成平滑体素模型，再转成真实 .litematic 格式。
// 依赖：./shared-board（可选）、./litematic-codec（可选）、./event-bus（可选）、./logger（可选）
// 导出：materialOf / greedyMeshing / fillCommands / splitFillToTasks / estimateSavings /
//       sdfSphere / sdfBox / sdfUnion / sdfSubtract / sdfSmoothUnion / voxelize /
//       sdfToBlueprint / toLitematic / stats / reset / MAX_BOXES
// 作者：MineBots
// ========================================
//
// 设计 / design
//   1. 材质签名 = 方块名 + 排序后的状态属性；只有完全相同的材质才能合并进同一个 /fill，
//      否则会把 facing 不同的楼梯 / delay 不同的中继器错误地刷成同一状态。
//   2. 标准 3D 贪心网格：逐格先沿 X 扩宽度，再沿 Z 扩深度（整行同材质），最后沿 Y 扩高度
//      （整层同材质），并把覆盖到的体素全部标记 used；10x10 石头平面因此只产出 1 个长方体。
//   3. /fill 任务 payload 带 requiresOp:true，只有 OP 权限机器人应该抢；指令用绝对坐标（局部 + origin）。
//   4. SDF 以 signedDistance <= 0 判定实体，smoothUnion 用多项式平滑实现平滑体素模型，
//      导出走 litematic-codec.encode（gzip + NBT + 位压缩 BlockStates），不是纸面 JSON。
// CommonJS，ES5 风格，无中文变量名；所有外部调用包 try/catch，日志双语，绝不把异常抛到顶层。
var sharedBoard = null;
try { sharedBoard = require("./shared-board"); } catch (e) { sharedBoard = null; }
var codec = null;
try { codec = require("./litematic-codec"); } catch (e) { codec = null; }
var bus = null;
try { bus = require("./event-bus"); } catch (e) { bus = null; }
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：合并上限 / 空气别名 / 内部计数。
var MAX_BOXES = 20000;
var MAX_VOXELS = 20000;
var AIR_NAMES = ["air", "cave_air", "void_air", "structure_void", ""];
var counters = { meshed: 0, boxes: 0, commands: 0, queued: 0, sdf: 0, encoded: 0, failed: 0, jobs: {} };

// 写文件日志：合并与体素化属高频计算，只落文件不刷 GUI。
function logInfo(msg) {
  try { if (logger && typeof logger.info === "function") logger.info("[mesher] " + msg); } catch (e) { /* ignore */ }
}
// 写告警日志：任务发布失败要让人看见；logger 缺失退回 console。
function logWarn(msg) {
  try { if (logger && typeof logger.warn === "function") { logger.warn("[mesher] " + msg); return; } }
  catch (e) { /* 退回 console */ }
  try { console.warn("[mesher] " + msg); } catch (e2) { /* ignore */ }
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
// 安全转整数：坏值回 fallback。
function toInt(value, fallback) {
  try { var n = Number(value); if (isNaN(n) || !isFinite(n)) return fallback; return Math.round(n); }
  catch (e) { return fallback; }
}
// 安全转浮点：坏值回 fallback。
function toNum(value, fallback) {
  try { var n = Number(value); if (isNaN(n) || !isFinite(n)) return fallback; return n; }
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
// 体素 key：三维整数坐标拼成字符串，避免负坐标下标问题。
function voxelKey(x, y, z) { return x + ":" + y + ":" + z; }
// 材质签名：方块名 + 排序后的状态属性；空气返回空串，坏值返回空串。
function materialOf(one) {
  try {
    var src = one && typeof one === "object" ? one : {};
    var block = cleanBlock(src.block || src.name || "");
    if (!block) return "";
    var props = src.props || src.properties || {};
    var keys = [];
    for (var k in props) if (Object.prototype.hasOwnProperty.call(props, k)) keys.push(k);
    keys.sort();
    var parts = [];
    for (var i = 0; i < keys.length; i++) parts.push(keys[i] + "=" + toText(props[keys[i]]));
    return block + (parts.length > 0 ? "[" + parts.join(",") + "]" : "");
  } catch (e) { return ""; }
}
// 从材质签名还原方块规格，供 /fill 指令与任务 payload 使用。
function specOf(material) {
  try {
    var text = toText(material);
    var at = text.indexOf("[");
    var block = at >= 0 ? text.slice(0, at) : text;
    var state = at >= 0 ? text.slice(at + 1).replace(/\]$/, "") : "";
    var props = {};
    if (state) {
      var parts = state.split(",");
      for (var i = 0; i < parts.length; i++) {
        var pair = parts[i].split("=");
        if (pair.length >= 2) props[toText(pair[0]).trim()] = toText(pair[1]).trim();
      }
    }
    return { block: block, props: props, spec: "minecraft:" + text };
  } catch (e) { return { block: "", props: {}, spec: "minecraft:air" }; }
}
// 取蓝图的原点与尺寸：优先显式 origin / size，否则由方块反推。
function boundsOf(blueprint, blocks) {
  var out = { origin: { x: 0, y: 0, z: 0 }, size: { width: 0, height: 0, length: 0 } };
  try {
    var bp = blueprint && typeof blueprint === "object" ? blueprint : {};
    var o = bp.origin || {};
    out.origin = { x: toInt(o.x, 0), y: toInt(o.y, 0), z: toInt(o.z, 0) };
    var maxX = 0, maxY = 0, maxZ = 0;
    for (var i = 0; i < blocks.length; i++) {
      var one = blocks[i] || {};
      if (toInt(one.x, 0) > maxX) maxX = toInt(one.x, 0);
      if (toInt(one.y, 0) > maxY) maxY = toInt(one.y, 0);
      if (toInt(one.z, 0) > maxZ) maxZ = toInt(one.z, 0);
    }
    var s = bp.size || {};
    out.size = { width: Math.max(toInt(s.width, 0), maxX + 1),
      height: Math.max(toInt(s.height, 0), maxY + 1),
      length: Math.max(toInt(s.length, 0), maxZ + 1) };
  } catch (e) { /* 返回已统计部分 */ }
  return out;
}
// 3D 贪心网格合并：相邻同材质方块合成最大长方体；返回 boxes 与覆盖率。
function greedyMeshing(blueprint, options) {
  var out = { ok: false, boxes: [], original: 0, coverage: 0, size: null, origin: null,
    message: "empty blueprint / 空蓝图" };
  try {
    var bp = blueprint && typeof blueprint === "object" ? blueprint : {};
    var blocks = Array.isArray(bp.blocks) ? bp.blocks : [];
    if (blocks.length === 0) return out;
    var opts = options && typeof options === "object" ? options : {};
    var vox = {};
    var minX = 0, minY = 0, minZ = 0, maxX = 0, maxY = 0, maxZ = 0;
    var first = true;
    for (var i = 0; i < blocks.length && i < MAX_VOXELS; i++) {
      var one = blocks[i] || {};
      var material = materialOf(one);
      if (!material) continue;
      var x = toInt(one.x, 0), y = toInt(one.y, 0), z = toInt(one.z, 0);
      vox[voxelKey(x, y, z)] = material;
      if (first) { minX = maxX = x; minY = maxY = y; minZ = maxZ = z; first = false; }
      else {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      out.original = out.original + 1;
    }
    if (out.original === 0) return out;
    var used = {};
    function canUse(cx, cy, cz, material) {
      var key = voxelKey(cx, cy, cz);
      return !used[key] && vox[key] === material;
    }
    for (var yy = minY; yy <= maxY; yy++) {
      for (var zz = minZ; zz <= maxZ; zz++) {
        for (var xx = minX; xx <= maxX; xx++) {
          var material = vox[voxelKey(xx, yy, zz)];
          if (!material || used[voxelKey(xx, yy, zz)]) continue;
          // 1) 沿 X 扩宽度。
          var w = 1;
          while (xx + w <= maxX && canUse(xx + w, yy, zz, material)) w = w + 1;
          // 2) 沿 Z 扩深度：整行 x..x+w 必须同材质且未占用。
          var d = 1, rowOk = true;
          while (zz + d <= maxZ && rowOk) {
            for (var ax = xx; ax < xx + w; ax++) {
              if (!canUse(ax, yy, zz + d, material)) { rowOk = false; break; }
            }
            if (rowOk) d = d + 1;
          }
          // 3) 沿 Y 扩高度：整层矩形必须同材质且未占用。
          var h = 1, layerOk = true;
          while (yy + h <= maxY && layerOk) {
            for (var az = zz; az < zz + d && layerOk; az++) {
              for (var bx = xx; bx < xx + w; bx++) {
                if (!canUse(bx, yy + h, az, material)) { layerOk = false; break; }
              }
            }
            if (layerOk) h = h + 1;
          }
          // 4) 标记覆盖体素，产出长方体。
          for (var ly = yy; ly < yy + h; ly++) {
            for (var lz = zz; lz < zz + d; lz++) {
              for (var lx = xx; lx < xx + w; lx++) used[voxelKey(lx, ly, lz)] = true;
            }
          }
          var info = specOf(material);
          out.boxes.push({ x1: xx, y1: yy, z1: zz, x2: xx + w - 1, y2: yy + h - 1, z2: zz + d - 1,
            block: info.block, props: info.props, spec: info.spec, material: material,
            volume: w * h * d });
          out.coverage = out.coverage + w * h * d;
          if (out.boxes.length >= MAX_BOXES) break;
        }
        if (out.boxes.length >= MAX_BOXES) break;
      }
      if (out.boxes.length >= MAX_BOXES) break;
    }
    var b = boundsOf(bp, blocks);
    if (opts.origin) b.origin = opts.origin;
    out.origin = b.origin;
    out.size = b.size;
    out.ok = out.boxes.length > 0;
    out.message = out.ok ? "greedy meshing done / 贪心合并完成" : "no boxes / 没有可合并区域";
    counters.meshed = counters.meshed + 1;
    counters.boxes = counters.boxes + out.boxes.length;
    logInfo("贪心合并 / mesh: blocks=" + out.original + " boxes=" + out.boxes.length);
    emit("blueprint.meshed", { blocks: out.original, boxes: out.boxes.length, at: Date.now() });
  } catch (e) {
    counters.failed = counters.failed + 1;
    out.message = errText(e);
  }
  return out;
}
// 生成 /fill 指令流：绝对坐标（局部 + origin），保留方块状态；返回指令与结构化任务项。
function fillCommands(boxes, options) {
  var out = { ok: false, commands: [], tasks: [], message: "no boxes / 没有填充区域" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var list = Array.isArray(boxes) ? boxes : [];
    var origin = opts.origin || { x: 0, y: 0, z: 0 };
    for (var i = 0; i < list.length && i < MAX_BOXES; i++) {
      var b = list[i] || {};
      var block = cleanBlock(b.block || specOf(b.material).block);
      if (!block) continue;
      var spec = b.spec || ("minecraft:" + toText(b.material || block));
      var x1 = toInt(b.x1, 0) + toInt(origin.x, 0);
      var y1 = toInt(b.y1, 0) + toInt(origin.y, 0);
      var z1 = toInt(b.z1, 0) + toInt(origin.z, 0);
      var x2 = toInt(b.x2, 0) + toInt(origin.x, 0);
      var y2 = toInt(b.y2, 0) + toInt(origin.y, 0);
      var z2 = toInt(b.z2, 0) + toInt(origin.z, 0);
      var command = "/fill " + x1 + " " + y1 + " " + z1 + " " + x2 + " " + y2 + " " + z2 + " " + spec;
      out.commands.push(command);
      out.tasks.push({ command: command, pos1: { x: x1, y: y1, z: z1 }, pos2: { x: x2, y: y2, z: z2 },
        block: block, spec: spec, volume: toInt(b.volume, 1), requiresOp: true, role: "builder" });
    }
    out.ok = out.commands.length > 0;
    out.message = out.ok ? "fill commands built / 填充指令已生成" : "no commands / 没有可生成指令";
    counters.commands = counters.commands + out.commands.length;
  } catch (e) { out.message = errText(e); }
  return out;
}
// 一步到位：合并蓝图 → 生成 /fill → 压入共享黑板任务池；options.board 可注入假板。
function splitFillToTasks(blueprint, options) {
  var out = { ok: false, count: 0, commands: [], taskIds: [], jobId: "", boxes: 0, failed: 0,
    message: "board unavailable / 黑板不可用" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var meshed = greedyMeshing(blueprint, opts);
    if (!meshed.ok) { out.message = meshed.message; return out; }
    out.boxes = meshed.boxes.length;
    var built = fillCommands(meshed.boxes, { origin: meshed.origin });
    out.commands = built.commands;
    var board = opts.board || sharedBoard;
    if (!board || typeof board.postTask !== "function") { logWarn(out.message); return out; }
    out.jobId = "fill-" + Date.now().toString(36) + "-" + (counters.meshed + 1);
    for (var i = 0; i < built.tasks.length; i++) {
      var t = built.tasks[i];
      var posted = null;
      try {
        posted = board.postTask({ title: "build:fill", priority: toInt(opts.priority, 5),
          payload: { action: "fill", role: t.role, requiresOp: t.requiresOp, jobId: out.jobId,
            index: i, command: t.command, pos1: t.pos1, pos2: t.pos2, block: t.block,
            spec: t.spec, volume: t.volume } });
      } catch (ePost) { posted = null; }
      if (posted && posted.ok) { out.taskIds.push(posted.taskId); out.count = out.count + 1; }
      else out.failed = out.failed + 1;
    }
    out.ok = out.count > 0;
    counters.queued = counters.queued + out.count;
    counters.jobs[out.jobId] = { count: out.count, boxes: out.boxes, at: Date.now() };
    out.message = out.ok ? "fill tasks queued / 填充任务已入池" : "all fill tasks failed / 填充任务发布失败";
    logInfo("填充拆单 / fill split: " + out.jobId + " commands=" + out.commands.length);
    emit("blueprint.fill_queued", { jobId: out.jobId, count: out.count, at: Date.now() });
  } catch (e) {
    counters.failed = counters.failed + 1;
    out.message = errText(e);
  }
  return out;
}
// 估算节省量：逐方块放置次数 vs /fill 指令数。
function estimateSavings(blueprint, boxes) {
  var out = { ok: true, blocks: 0, commands: 0, saved: 0, ratio: 0 };
  try {
    out.blocks = Array.isArray(blueprint && blueprint.blocks) ? blueprint.blocks.length : 0;
    out.commands = Array.isArray(boxes) ? boxes.length : 0;
    out.saved = Math.max(0, out.blocks - out.commands);
    out.ratio = out.blocks > 0 ? Math.round((1 - out.commands / out.blocks) * 1000) / 10 : 0;
  } catch (e) { return out; }
  return out;
}
// SDF：球体，负值为实体内部；坏半径回 0。
function sdfSphere(cx, cy, cz, radius) {
  var px = toNum(cx, 0), py = toNum(cy, 0), pz = toNum(cz, 0), r = Math.abs(toNum(radius, 1));
  return function (x, y, z) {
    var dx = x - px, dy = y - py, dz = z - pz;
    return Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
  };
}
// SDF：轴对齐长方体，负值为实体内部。
function sdfBox(cx, cy, cz, hx, hy, hz) {
  var px = toNum(cx, 0), py = toNum(cy, 0), pz = toNum(cz, 0);
  var ax = Math.abs(toNum(hx, 1)), ay = Math.abs(toNum(hy, 1)), az = Math.abs(toNum(hz, 1));
  return function (x, y, z) {
    var qx = Math.abs(x - px) - ax, qy = Math.abs(y - py) - ay, qz = Math.abs(z - pz) - az;
    var outside = Math.sqrt(Math.max(qx, 0) * Math.max(qx, 0) + Math.max(qy, 0) * Math.max(qy, 0) + Math.max(qz, 0) * Math.max(qz, 0));
    return outside + Math.min(Math.max(qx, Math.max(qy, qz)), 0);
  };
}
// SDF：并集（取较小距离）。
function sdfUnion(a, b) {
  return function (x, y, z) {
    try { return Math.min(a(x, y, z), b(x, y, z)); } catch (e) { return 1; }
  };
}
// SDF：差集（a 减去 b）。
function sdfSubtract(a, b) {
  return function (x, y, z) {
    try { return Math.max(a(x, y, z), -b(x, y, z)); } catch (e) { return 1; }
  };
}
// SDF：多项式平滑并集，k 越大过渡越圆滑，用来生成平滑体素模型。
function sdfSmoothUnion(a, b, k) {
  var s = Math.abs(toNum(k, 1));
  if (s < 0.0001) s = 0.0001;
  return function (x, y, z) {
    try {
      var da = a(x, y, z), db = b(x, y, z);
      var h = Math.max(s - Math.abs(da - db), 0) / s;
      return Math.min(da, db) - h * h * s * 0.25;
    } catch (e) { return 1; }
  };
}
// 体素化：在 bounds 内逐格采样 SDF，distance <= 0 生成实体方块；返回蓝图片段。
function voxelize(sdf, bounds, options) {
  var out = { ok: false, blocks: [], size: { width: 0, height: 0, length: 0 }, sampled: 0, message: "bad sdf / SDF 非法" };
  try {
    if (typeof sdf !== "function") return out;
    var opts = options && typeof options === "object" ? options : {};
    var b = bounds && typeof bounds === "object" ? bounds : {};
    var w = Math.max(1, Math.min(64, toInt(b.width, 8)));
    var h = Math.max(1, Math.min(64, toInt(b.height, 8)));
    var l = Math.max(1, Math.min(64, toInt(b.length, 8)));
    var block = cleanBlock(opts.block || "stone") || "stone";
    var props = opts.props && typeof opts.props === "object" ? opts.props : {};
    for (var y = 0; y < h; y++) {
      for (var z = 0; z < l; z++) {
        for (var x = 0; x < w && out.blocks.length < MAX_VOXELS; x++) {
          out.sampled = out.sampled + 1;
          var d = sdf(x, y, z);
          if (d <= 0) out.blocks.push({ x: x, y: y, z: z, block: block, props: props, face: "up" });
        }
      }
    }
    out.size = { width: w, height: h, length: l };
    out.ok = out.blocks.length > 0;
    out.message = out.ok ? "voxelized / SDF 体素化完成" : "empty sdf / SDF 没有实体区域";
    counters.sdf = counters.sdf + 1;
    logInfo("SDF 体素化 / voxelize: sampled=" + out.sampled + " blocks=" + out.blocks.length);
  } catch (e) { out.message = errText(e); }
  return out;
}
// 把 SDF 结果包成统一蓝图对象；失败返回 ok:false。
function sdfToBlueprint(sdf, bounds, options) {
  var out = { ok: false, blueprint: null, message: "voxelize failed / 体素化失败" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var vox = voxelize(sdf, bounds, opts);
    if (!vox.ok) { out.message = vox.message; return out; }
    out.blueprint = { name: toText(opts.name) || "sdf_model", format: "sdf",
      origin: opts.origin || { x: 0, y: 64, z: 0 }, size: vox.size, blocks: vox.blocks,
      meta: { source: "sdf", smooth: opts.smooth === true } };
    out.ok = true;
    out.message = "sdf blueprint ready / SDF 蓝图已生成";
  } catch (e) { out.message = errText(e); }
  return out;
}
// 导出为真实 .litematic（gzip + NBT + 位压缩 BlockStates）；编解码器缺失时 ok:false。
function toLitematic(blueprint, options) {
  var out = { ok: false, buffer: null, palette: [], bits: 0, message: "codec unavailable / 编码器不可用" };
  try {
    if (!codec || typeof codec.encode !== "function") { logWarn(out.message); return out; }
    var encoded = codec.encode(blueprint, options || {});
    if (!encoded.ok) { out.message = encoded.message; return out; }
    out.ok = true;
    out.buffer = encoded.buffer;
    out.palette = encoded.palette;
    out.bits = encoded.bits;
    out.message = "litematic exported / 已导出 .litematic";
    counters.encoded = counters.encoded + 1;
    emit("blueprint.sdf_exported", { palette: out.palette.length, bits: out.bits, at: Date.now() });
  } catch (e) { out.message = errText(e); }
  return out;
}
// 统计快照：合并 / 长方体 / 指令 / 入池 / SDF / 导出 / 失败次数。
function stats() {
  return { ok: true, meshed: counters.meshed, boxes: counters.boxes, commands: counters.commands,
    queued: counters.queued, sdf: counters.sdf, encoded: counters.encoded,
    failed: counters.failed, jobs: Object.keys(counters.jobs).length };
}
// 清空内存计数（不触碰磁盘 / 黑板）；供自测隔离。
function reset() {
  try { counters = { meshed: 0, boxes: 0, commands: 0, queued: 0, sdf: 0, encoded: 0, failed: 0, jobs: {} }; }
  catch (e) { /* ignore */ }
  return { ok: true, message: "mesher stats reset / 网格合并统计已重置" };
}

// 对外导出：贪心合并 / /fill 任务流 / SDF 体素与 Litematica 导出 / 诊断。
module.exports = {
  materialOf: materialOf,
  greedyMeshing: greedyMeshing,
  fillCommands: fillCommands,
  splitFillToTasks: splitFillToTasks,
  estimateSavings: estimateSavings,
  sdfSphere: sdfSphere,
  sdfBox: sdfBox,
  sdfUnion: sdfUnion,
  sdfSubtract: sdfSubtract,
  sdfSmoothUnion: sdfSmoothUnion,
  voxelize: voxelize,
  sdfToBlueprint: sdfToBlueprint,
  toLitematic: toLitematic,
  stats: stats,
  reset: reset,
  MAX_BOXES: MAX_BOXES
};
