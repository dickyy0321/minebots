// ========================================
// 文件：modules/redstone-router.js
// 功能：自动红石布线 Place-and-Route（参考 PERSHING 论文的网表 / 放置 / 布线三段式）——
//       把逻辑门抽象成 Netlist，紧凑放到 2D 网格上，用 A* 在网格里为红石线寻路并避开障碍物，
//       按信号距离自动插入 Repeater 延长信号，垂直信号用红石火把塔或阶梯式布线；
//       预置 AND / OR / NOT / XOR 标准逻辑门 JSON 蓝图模板，按玩家需求拼接并自动生成中间连线，
//       输出 builder-blueprint 兼容的统一蓝图对象（可直接 buildTasks 拆单）。
// 依赖：./event-bus（可选）、./logger（可选）
// 导出：TEMPLATES / GATE_TYPES / parseRequest / netlistOf / place / astar / route /
//       verticalRoute / buildTemplate / toBlueprint / stats / reset / MAX_WIRE_LENGTH
// 作者：MineBots
// ========================================
//
// 设计 / design
//   1. 三段式：netlistOf 生成网表 → place 在 2D 网格紧凑布局并登记障碍 → route 逐条 net 走 A*。
//   2. A* 用曼哈顿启发式 + 4 邻域，open 表用数组线性取最小（红石网格规模小，稳定且 ES5 友好）。
//   3. 红石线信号上限 15 格：路径每累计 MAX_WIRE_LENGTH 就在该格换成 repeater[facing=...,delay=1]。
//   4. 门核心与输出不同高度时走 verticalRoute：火把塔每 2 格插一个 redstone_torch + 支撑方块，
//      或者阶梯式每升一层 x 前进一格，避免垂直方向直接连红石线这种不合法接法。
// CommonJS，ES5 风格，无中文变量名；所有外部调用包 try/catch，日志双语，绝不把异常抛到顶层。
var bus = null;
try { bus = require("./event-bus"); } catch (e) { bus = null; }
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：红石线最大传输距离 / 门类型 / 网格上限 / 内部计数。
var MAX_WIRE_LENGTH = 15;
var GATE_TYPES = ["AND", "OR", "NOT", "XOR"];
var MAX_GRID = 64;
var MAX_INPUTS = 8;
var MAX_NODES = 4096;
var counters = { requests: 0, placed: 0, routed: 0, repeaters: 0, verticals: 0, failed: 0 };

// 标准逻辑门 JSON 蓝图模板：core 是门主体相对坐标，inputRow 决定输入杆排布，output 是输出端。
var TEMPLATES = {
  NOT: { type: "NOT", arity: 1, coreBlock: "redstone_torch", coreY: 1, outputY: 1,
    label: "非门 / NOT gate", core: [{ x: 0, y: 0, z: 0, block: "stone" }, { x: 0, y: 1, z: 0, block: "redstone_torch", props: { facing: "east", lit: "true" } }] },
  AND: { type: "AND", arity: 2, coreBlock: "redstone_torch", coreY: 1, outputY: 1,
    label: "与门 / AND gate", core: [{ x: 0, y: 0, z: 0, block: "stone" }, { x: 0, y: 1, z: 0, block: "redstone_torch", props: { facing: "east", lit: "true" } }, { x: 1, y: 1, z: 0, block: "redstone_wire", props: { power: "15" } }] },
  OR: { type: "OR", arity: 2, coreBlock: "redstone_wire", coreY: 0, outputY: 0,
    label: "或门 / OR gate", core: [{ x: 0, y: 0, z: 0, block: "redstone_wire", props: { power: "15" } }] },
  XOR: { type: "XOR", arity: 2, coreBlock: "comparator", coreY: 0, outputY: 0,
    label: "异或门 / XOR gate", core: [{ x: 0, y: 0, z: 0, block: "comparator", props: { facing: "east", mode: "subtract" } }, { x: 1, y: 0, z: 0, block: "redstone_wire", props: { power: "15" } }] }
};

// 写文件日志：布线属高频计算，只落文件不刷 GUI。
function logInfo(msg) {
  try { if (logger && typeof logger.info === "function") logger.info("[redstone-router] " + msg); } catch (e) { /* ignore */ }
}
// 写告警日志：布线失败要让人看见；logger 缺失退回 console。
function logWarn(msg) {
  try { if (logger && typeof logger.warn === "function") { logger.warn("[redstone-router] " + msg); return; } }
  catch (e) { /* 退回 console */ }
  try { console.warn("[redstone-router] " + msg); } catch (e2) { /* ignore */ }
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
// 2D 网格 key：红石布线在 XZ 平面展开，y 只用于垂直段。
function cellKey(x, z) { return x + ":" + z; }
// 单个数词转整数：支持 "3" 与 "三" / "两" 等中文数字；无法识别返回 0。
function digitOf(text) {
  try {
    var value = toText(text);
    if (/^[0-9]+$/.test(value)) return toInt(value, 0);
    var map = { "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8 };
    for (var k in map) if (Object.prototype.hasOwnProperty.call(map, k) && value.indexOf(k) >= 0) return map[k];
  } catch (e) { return 0; }
  return 0;
}
// 只认「N输入 / N-input」这种明确数量表达，避免「建一个三输入与门」里的量词「一个」被当成 1。
function cnNumber(text) {
  try {
    var m = toText(text).match(/([0-9]+|[一二两三四五六七八]+)\s*-?\s*(?:输入|inputs?)/i);
    return m ? digitOf(m[1]) : 0;
  } catch (e) { return 0; }
}
// 解析自然语言需求："建一个三输入与门" / "3-input AND gate" → { gate, inputCount, ok }。
function parseRequest(text) {
  var out = { ok: false, gate: "AND", inputCount: 2, message: "unrecognized request / 无法识别的需求" };
  try {
    var raw = toText(text);
    var hit = "";
    // 中文关键词优先（异或要先于或匹配），长度不限，避免 /[a-z]/ 把中文别名全部过滤掉。
    var zh = [["异或", "XOR"], ["或门", "OR"], ["非门", "NOT"], ["取反", "NOT"], ["反相", "NOT"], ["与门", "AND"]];
    for (var z = 0; z < zh.length; z++) if (raw.indexOf(zh[z][0]) >= 0) { hit = zh[z][1]; break; }
    // 英文关键词用词边界，避免 OR 命中 INPUT / XOR 之类子串。
    if (!hit) {
      var en = [["XOR", "XOR"], ["OR", "OR"], ["NOT", "NOT"], ["AND", "AND"]];
      for (var e = 0; e < en.length; e++) {
        if (new RegExp("\\b" + en[e][0] + "\\b", "i").test(raw)) { hit = en[e][1]; break; }
      }
    }
    if (!hit) {
      if (raw.indexOf("异") >= 0) hit = "XOR";
      else if (raw.indexOf("或") >= 0) hit = "OR";
      else if (raw.indexOf("非") >= 0) hit = "NOT";
      else if (raw.indexOf("与") >= 0) hit = "AND";
    }
    if (!hit) return out;
    var count = cnNumber(raw);
    if (count < 1) count = hit === "NOT" ? 1 : 2;
    if (count > MAX_INPUTS) count = MAX_INPUTS;
    if (hit === "NOT") count = 1;
    out.ok = true;
    out.gate = hit;
    out.inputCount = count;
    out.message = "request parsed / 需求已解析";
    counters.requests = counters.requests + 1;
  } catch (e) { out.message = errText(e); }
  return out;
}
// 生成网表：输入节点 → 单个逻辑门 → 输出节点，附带待布的 nets 列表；坏门返回 ok:false。
function netlistOf(gateType, inputCount, options) {
  var out = { ok: false, type: "", inputCount: 0, inputs: [], gate: null, output: null, nets: [], message: "unknown gate / 未知门" };
  try {
    var type = toText(gateType).toUpperCase().trim();
    if (!TEMPLATES[type]) return out;
    var opts = options && typeof options === "object" ? options : {};
    var n = toInt(inputCount, TEMPLATES[type].arity);
    if (n < 1) n = 1;
    if (n > MAX_INPUTS) n = MAX_INPUTS;
    if (type === "NOT") n = 1;
    var tpl = TEMPLATES[type];
    var inputs = [];
    for (var i = 0; i < n; i++) inputs.push({ id: "in" + (i + 1), x: 0, y: 0, z: i, role: "input" });
    var gatePos = { x: 3, y: tpl.coreY, z: Math.floor((n - 1) / 2), role: "gate" };
    var outPos = { x: opts.outputX ? toInt(opts.outputX, 8) : 8, y: tpl.outputY,
      z: Math.floor((n - 1) / 2), role: "output" };
    out.type = type;
    out.inputCount = n;
    out.inputs = inputs;
    out.gate = { id: "g1", type: type, pos: gatePos, inputs: inputs.slice(), output: outPos };
    out.output = outPos;
    for (var k = 0; k < inputs.length; k++) out.nets.push({ from: inputs[k], to: gatePos, id: "net" + (k + 1) });
    out.nets.push({ from: gatePos, to: outPos, id: "netOut" });
    out.ok = true;
    out.message = "netlist built / 网表已生成";
  } catch (e) { out.message = errText(e); }
  return out;
}
// 紧凑放置：输入竖排在 x=0，门核心在 x=3，输出在 x=8；返回 grid 与已占障碍表。
function place(netlist, options) {
  var out = { ok: false, width: 0, height: 0, blocked: {}, cells: [], message: "bad netlist / 网表非法" };
  try {
    if (!netlist || !netlist.ok) return out;
    var opts = options && typeof options === "object" ? options : {};
    var width = Math.min(MAX_GRID, Math.max(9, toInt(opts.width, 10)));
    var height = Math.min(MAX_GRID, Math.max(netlist.inputCount + 2, toInt(opts.height, netlist.inputCount + 2)));
    out.width = width;
    out.height = height;
    // 门核心占位（2 格宽）作为障碍，迫使 A* 绕行而不是穿门。
    var gx = netlist.gate.pos.x;
    var gz = netlist.gate.pos.z;
    for (var dx = 0; dx < 2; dx++) {
      for (var dz = -1; dz <= 1; dz++) {
        var bx = gx + dx, bz = gz + dz;
        if (bx >= 0 && bx < width && bz >= 0 && bz < height) out.blocked[cellKey(bx, bz)] = "gate";
      }
    }
    // 输入与输出各自占位，避免连线压在杆 / 灯上。
    for (var i = 0; i < netlist.inputs.length; i++) out.blocked[cellKey(0, netlist.inputs[i].z)] = "input";
    out.blocked[cellKey(netlist.output.x, netlist.output.z)] = "output";
    if (opts.obstacles && Array.isArray(opts.obstacles)) {
      for (var o = 0; o < opts.obstacles.length; o++) {
        var ob = opts.obstacles[o] || {};
        var ox = toInt(ob.x, -1), oz = toInt(ob.z, -1);
        if (ox > 0 && ox < width && oz >= 0 && oz < height) out.blocked[cellKey(ox, oz)] = "obstacle";
      }
    }
    out.cells.push({ x: 0, z: 0, note: "grid ready / 网格就绪" });
    out.ok = true;
    out.message = "placement ready / 紧凑放置完成";
    counters.placed = counters.placed + 1;
    logInfo("放置 / place: " + netlist.type + " grid=" + width + "x" + height);
  } catch (e) { out.message = errText(e); }
  return out;
}
// A* 寻路：4 邻域 + 曼哈顿启发式，避开 blocked；返回 [{x,z},...]，失败返回空数组。
function astar(grid, start, goal, options) {
  var out = [];
  try {
    if (!grid || !start || !goal) return out;
    var opts = options && typeof options === "object" ? options : {};
    var sx = toInt(start.x, 0), sz = toInt(start.z, 0);
    var tx = toInt(goal.x, 0), tz = toInt(goal.z, 0);
    var width = Math.max(1, toInt(grid.width, 1));
    var height = Math.max(1, toInt(grid.height, 1));
    var blocked = grid.blocked || {};
    var allowGoal = opts.allowGoal !== false;
    function h(x, z) { return Math.abs(x - tx) + Math.abs(z - tz); }
    function passable(x, z) {
      if (x < 0 || z < 0 || x >= width || z >= height) return false;
      var k = cellKey(x, z);
      if (x === tx && z === tz) return allowGoal;
      if (x === sx && z === sz) return true;
      return !blocked[k];
    }
    var open = [{ x: sx, z: sz, g: 0, f: h(sx, sz), parent: null }];
    var best = {};
    best[cellKey(sx, sz)] = 0;
    var closed = {};
    var guard = 0;
    while (open.length > 0 && guard < MAX_NODES) {
      guard = guard + 1;
      var pick = 0;
      for (var p = 1; p < open.length; p++) if (open[p].f < open[pick].f) pick = p;
      var cur = open.splice(pick, 1)[0];
      var ck = cellKey(cur.x, cur.z);
      if (closed[ck]) continue;
      closed[ck] = true;
      if (cur.x === tx && cur.z === tz) {
        var node = cur;
        while (node) { out.push({ x: node.x, z: node.z }); node = node.parent; }
        out.reverse();
        return out;
      }
      var steps = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (var s = 0; s < steps.length; s++) {
        var nx = cur.x + steps[s][0], nz = cur.z + steps[s][1];
        if (!passable(nx, nz)) continue;
        var nk = cellKey(nx, nz);
        if (closed[nk]) continue;
        var ng = cur.g + 1;
        if (best[nk] !== undefined && best[nk] <= ng) continue;
        best[nk] = ng;
        open.push({ x: nx, z: nz, g: ng, f: ng + h(nx, nz), parent: cur });
      }
    }
  } catch (e) { return []; }
  return out;
}
// 垂直信号传输：火把塔（每 2 格一个 redstone_torch + stone 支撑）或阶梯式（每升一层 x+1）。
function verticalRoute(from, to, options) {
  var out = { ok: false, mode: "torch_tower", blocks: [], message: "no vertical delta / 无高度差" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var y1 = toInt(from.y, 0), y2 = toInt(to.y, 0);
    var delta = y2 - y1;
    if (delta === 0) return out;
    var mode = opts.mode === "stair" ? "stair" : "torch_tower";
    var dir = delta > 0 ? 1 : -1;
    var x = toInt(from.x, 0), z = toInt(from.z, 0);
    var blocks = [];
    var steps = Math.abs(delta);
    for (var i = 1; i <= steps; i++) {
      var y = y1 + i * dir;
      if (mode === "torch_tower") {
        blocks.push({ x: x, y: y - dir, z: z, block: "stone", props: {} });
        blocks.push({ x: x, y: y, z: z, block: "redstone_torch", props: { facing: "up", lit: "true" } });
      } else {
        x = x + 1;
        blocks.push({ x: x, y: y - dir, z: z, block: "stone", props: {} });
        blocks.push({ x: x, y: y, z: z, block: "redstone_wire", props: { power: "15" } });
      }
    }
    out.ok = true;
    out.mode = mode;
    out.blocks = blocks;
    out.message = mode === "stair" ? "stair route / 阶梯式垂直布线" : "torch tower / 红石火把塔";
    counters.verticals = counters.verticals + 1;
  } catch (e) { out.message = errText(e); }
  return out;
}
// 布线主流程：逐条 net 走 A*，把路径转成红石线；超过 15 格自动插 repeater；高度差走垂直段。
function route(netlist, placement, options) {
  var out = { ok: false, blocks: [], wires: [], repeaters: [], verticals: [], paths: [],
    message: "route failed / 布线失败" };
  try {
    if (!netlist || !netlist.ok || !placement || !placement.ok) return out;
    var opts = options && typeof options === "object" ? options : {};
    var maxWire = Math.max(2, toInt(opts.maxWireLength, MAX_WIRE_LENGTH));
    var used = {};
    for (var n = 0; n < netlist.nets.length; n++) {
      var net = netlist.nets[n];
      var path = astar(placement, net.from, net.to, { allowGoal: true });
      if (path.length === 0) { logWarn("A* 寻路失败 / no path: " + net.id); continue; }
      out.paths.push({ id: net.id, length: path.length, path: path });
      var sinceRepeater = 0;
      for (var i = 1; i < path.length - 1; i++) {
        var cell = path[i];
        var key = cellKey(cell.x, cell.z);
        if (used[key]) continue;
        used[key] = true;
        var y = toInt(net.to.y, 0);
        var prev = path[i - 1];
        var facing = cell.x > prev.x ? "east" : (cell.x < prev.x ? "west" : (cell.z > prev.z ? "south" : "north"));
        sinceRepeater = sinceRepeater + 1;
        if (sinceRepeater > maxWire) {
          out.repeaters.push({ x: cell.x, y: y, z: cell.z, block: "repeater", props: { facing: facing, delay: "1" } });
          sinceRepeater = 0;
          counters.repeaters = counters.repeaters + 1;
        } else {
          out.wires.push({ x: cell.x, y: y, z: cell.z, block: "redstone_wire", props: { power: "15", facing: facing } });
        }
      }
      // 门核心与输出存在高度差时补垂直段（火把塔 / 阶梯）。
      var dy = toInt(net.to.y, 0) - toInt(net.from.y, 0);
      if (dy !== 0) {
        var vr = verticalRoute(net.from, net.to, { mode: opts.verticalMode });
        if (vr.ok) {
          out.verticals.push(vr);
          for (var v = 0; v < vr.blocks.length; v++) out.blocks.push(vr.blocks[v]);
        }
      }
    }
    for (var w = 0; w < out.wires.length; w++) out.blocks.push(out.wires[w]);
    for (var r = 0; r < out.repeaters.length; r++) out.blocks.push(out.repeaters[r]);
    out.ok = out.paths.length > 0;
    out.message = out.ok ? "routing done / 自动布线完成" : "no route / 没有可用路径";
    counters.routed = counters.routed + 1;
    logInfo("布线 / route: paths=" + out.paths.length + " wires=" + out.wires.length +
      " repeaters=" + out.repeaters.length);
    emit("redstone.router.done", { type: netlist.type, paths: out.paths.length, at: Date.now() });
  } catch (e) {
    counters.failed = counters.failed + 1;
    out.message = errText(e);
  }
  return out;
}
// 拼接标准门模板：输入拉杆 + 门核心方块 + 输出灯 + A* 连线 + 中继器 + 垂直段。
function buildTemplate(gateType, inputCount, options) {
  var out = { ok: false, gate: toText(gateType).toUpperCase(), inputCount: 0, blocks: [],
    netlist: null, routing: null, size: { width: 0, height: 0, length: 0 }, message: "template failed / 模板拼接失败" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var type = out.gate;
    var tpl = TEMPLATES[type];
    if (!tpl) return out;
    var netlist = netlistOf(type, inputCount, opts);
    if (!netlist.ok) { out.message = netlist.message; return out; }
    var placement = place(netlist, opts);
    if (!placement.ok) { out.message = placement.message; return out; }
    var routing = route(netlist, placement, opts);
    var blocks = [];
    var origin = opts.origin || { x: 0, y: 64, z: 0 };
    // 1. 输入拉杆：每个输入一根，带 facing / face / powered 属性。
    for (var i = 0; i < netlist.inputs.length; i++) {
      var inp = netlist.inputs[i];
      blocks.push({ x: inp.x, y: inp.y, z: inp.z, block: "lever",
        props: { facing: "east", face: "floor", powered: "false" }, face: "up", role: "input" });
    }
    // 2. 预置门核心 JSON 模板，按 gate.pos 平移；多输入门按 z 复制 comparators 支路。
    for (var c = 0; c < tpl.core.length; c++) {
      var core = tpl.core[c];
      blocks.push({ x: netlist.gate.pos.x + core.x, y: core.y, z: netlist.gate.pos.z + core.z,
        block: core.block, props: core.props || {}, face: "up", role: "gate" });
    }
    for (var k = 1; k < netlist.inputCount; k++) {
      blocks.push({ x: netlist.gate.pos.x, y: 0, z: k - 1, block: "stone", props: {}, face: "up", role: "support" });
      blocks.push({ x: netlist.gate.pos.x, y: 1, z: k - 1, block: "redstone_wire",
        props: { power: "15" }, face: "up", role: "gate_merge" });
    }
    // 3. 输出灯。
    blocks.push({ x: netlist.output.x, y: netlist.output.y, z: netlist.output.z,
      block: "redstone_lamp", props: { lit: "false" }, face: "up", role: "output" });
    // 4. A* 生成的中间连线 / 中继器 / 垂直段。
    for (var b = 0; b < routing.blocks.length; b++) {
      var rb = routing.blocks[b];
      blocks.push({ x: rb.x, y: rb.y, z: rb.z, block: rb.block, props: rb.props || {}, face: "up", role: "route" });
    }
    var maxX = 0, maxY = 0, maxZ = 0;
    for (var m = 0; m < blocks.length; m++) {
      if (blocks[m].x > maxX) maxX = blocks[m].x;
      if (blocks[m].y > maxY) maxY = blocks[m].y;
      if (blocks[m].z > maxZ) maxZ = blocks[m].z;
    }
    out.ok = true;
    out.inputCount = netlist.inputCount;
    out.netlist = netlist;
    out.routing = routing;
    out.blocks = blocks;
    out.origin = origin;
    out.size = { width: maxX + 1, height: maxY + 1, length: maxZ + 1 };
    out.message = "template assembled / 逻辑门模板已拼接";
  } catch (e) {
    counters.failed = counters.failed + 1;
    out.message = errText(e);
  }
  return out;
}
// 把布线结果包成 builder-blueprint 兼容蓝图；失败返回 ok:false，绝不抛错。
function toBlueprint(result, options) {
  var out = { ok: false, blueprint: null, message: "bad result / 布线结果为空" };
  try {
    if (!result || !result.ok || !Array.isArray(result.blocks)) return out;
    var opts = options && typeof options === "object" ? options : {};
    out.blueprint = { name: toText(opts.name) || (result.gate + "_" + result.inputCount + "in"),
      format: "router", origin: opts.origin || result.origin || { x: 0, y: 64, z: 0 },
      size: result.size, blocks: result.blocks.slice(), meta: { source: "redstone-router", gate: result.gate } };
    out.ok = true;
    out.message = "blueprint ready / 布线蓝图已生成";
  } catch (e) { out.message = errText(e); }
  return out;
}
// 统计快照：需求 / 放置 / 布线 / 中继器 / 垂直段 / 失败次数。
function stats() {
  return { ok: true, requests: counters.requests, placed: counters.placed, routed: counters.routed,
    repeaters: counters.repeaters, verticals: counters.verticals, failed: counters.failed };
}
// 清空内存计数（不触碰磁盘）；供自测隔离。
function reset() {
  try { counters = { requests: 0, placed: 0, routed: 0, repeaters: 0, verticals: 0, failed: 0 }; } catch (e) { /* ignore */ }
  return { ok: true, message: "router stats reset / 布线统计已重置" };
}

// 对外导出：模板 / 需求解析 / 网表 / 放置 / A* / 布线 / 垂直传输 / 蓝图转换 / 诊断。
module.exports = {
  TEMPLATES: TEMPLATES,
  GATE_TYPES: GATE_TYPES,
  parseRequest: parseRequest,
  netlistOf: netlistOf,
  place: place,
  astar: astar,
  route: route,
  verticalRoute: verticalRoute,
  buildTemplate: buildTemplate,
  toBlueprint: toBlueprint,
  stats: stats,
  reset: reset,
  MAX_WIRE_LENGTH: MAX_WIRE_LENGTH
};
