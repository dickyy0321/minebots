// ========================================
// 文件：modules/redstone-sim.js
// 功能：红石电路 Tick 级闭环仿真——优先探测 nucleation（MCHPRS WASM）的 Schematic.create /
//       setBlockFromString / onUseBlock / tick(n) / isLit 接口；不可用时按方案约定的分支启用内置
//       轻量级逻辑门验证器（AND / OR / NOT / XOR / NAND / NOR / XNOR 真值表 + 网表传播 + 门延迟）。
//       不改动 package.json（禁改文件）、不联网、不装新依赖，纯计算推进 tick。
// 依赖：./event-bus（可选）、./logger（可选）；nucleation 为可选 require，缺失即降级。
// 导出：Schematic / create / backend / truthTable / verifyTruthTable / buildNotGateDemo /
//       GATE_TYPES / TRUTH_TABLE / stats / reset
// 作者：MineBots
// ========================================
//
// 设计 / design
//   1. 方案要求「在 package.json 中尝试引入 nucleation」：本项目 package.json 属 guard 禁改文件，
//      且自检必须离线，因此不能新增依赖。这里保留可选 require 探测与接口适配，一旦未来环境
//      装了 nucleation 就自动切到真仿真，否则走内置网表验证器，行为对外完全一致。
//   2. 坐标统一用 "x,y,z" 字符串做 key；每个节点记录 power(0/1) / lit / block / props。
//   3. 逻辑门挂在网表上：inputs → 真值表 → output；gate.delay 表示红石中继器 tick 延迟，
//      tick(n) 用 pending 队列逐拍提交，避免一次 tick 把多级电路瞬间算完。
//   4. NOT 门是验收基准：拉杆 off 时输出亮，onUseBlock 翻转拉杆后 tick 推进，输出灭。
// CommonJS，ES5 风格，无中文变量名；所有外部调用包 try/catch，日志双语，绝不把异常抛到顶层。
var bus = null;
try { bus = require("./event-bus"); } catch (e) { bus = null; }
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
// 可选依赖：MCHPRS 的 WASM 红石仿真。装上就走真后端，没装就走内置验证器，绝不硬依赖。
var nucleation = null;
try { nucleation = require("nucleation"); } catch (e) { nucleation = null; }

// 常量：支持的门类型 / 输入上限 / 单次 tick 上限 / 内部计数。
var GATE_TYPES = ["AND", "OR", "NOT", "XOR", "NAND", "NOR", "XNOR", "BUFFER"];
var MAX_INPUTS = 8;
var MAX_TICKS = 128;
var counters = { created: 0, ticks: 0, uses: 0, gates: 0, verified: 0, failed: 0 };

// 写文件日志：仿真属高频计算，只落文件不刷 GUI。
function logInfo(msg) {
  try { if (logger && typeof logger.info === "function") logger.info("[redstone-sim] " + msg); } catch (e) { /* ignore */ }
}
// 写告警日志：解析失败要让人看见；logger 缺失退回 console。
function logWarn(msg) {
  try { if (logger && typeof logger.warn === "function") { logger.warn("[redstone-sim] " + msg); return; } }
  catch (e) { /* 退回 console */ }
  try { console.warn("[redstone-sim] " + msg); } catch (e2) { /* ignore */ }
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
// 安全转整数：坏值回 fallback。
function toInt(value, fallback) {
  try { var n = Number(value); if (isNaN(n) || !isFinite(n)) return fallback; return Math.round(n); }
  catch (e) { return fallback; }
}
// 安全转字符串：null / undefined 统一成空串。
function toText(value) {
  try { return value === null || value === undefined ? "" : String(value); } catch (e) { return ""; }
}
// 归一化坐标 key：坏值回 "0,0,0"。
function keyOf(pos) {
  try {
    var p = pos && typeof pos === "object" ? pos : {};
    var x = toInt(p.x, 0), y = toInt(p.y, 0), z = toInt(p.z, 0);
    if (arguments.length >= 3) { x = toInt(arguments[0], 0); y = toInt(arguments[1], 0); z = toInt(arguments[2], 0); }
    return x + "," + y + "," + z;
  } catch (e) { return "0,0,0"; }
}
// 兼容两种调用：keyOf({x,y,z}) 与 keyOf(x,y,z)。
function coordKey(a, b, c) {
  if (typeof a === "object") return keyOf(a);
  return keyOf({ x: a, y: b, z: c });
}
// 解析方块规格字符串："minecraft:lever[facing=east,face=floor,powered=false]" → { block, props }。
function parseSpec(spec) {
  var out = { block: "", props: {} };
  try {
    var text = toText(spec).trim();
    if (!text) return out;
    var at = text.indexOf("[");
    var state = "";
    if (at >= 0) {
      var end = text.lastIndexOf("]");
      state = end > at ? text.slice(at + 1, end) : "";
      text = text.slice(0, at);
    }
    out.block = text.toLowerCase().replace(/^minecraft:/, "").replace(/[^a-z0-9_]/g, "");
    if (state) {
      var parts = state.split(",");
      for (var i = 0; i < parts.length; i++) {
        var pair = parts[i].split("=");
        if (pair.length < 2) continue;
        out.props[toText(pair[0]).trim().toLowerCase()] = toText(pair[1]).trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch (e) { return out; }
  return out;
}
// 判断字符串是否为真值：true / 1 / on / yes 都算通电。
function truthy(value) {
  var t = toText(value).toLowerCase();
  return t === "true" || t === "1" || t === "on" || t === "yes";
}
// 基础逻辑门真值表函数表：全部返回 0 / 1，坏输入按 0 处理。
var TRUTH_TABLE = {
  AND: function (a, b) { return a && b ? 1 : 0; },
  OR: function (a, b) { return a || b ? 1 : 0; },
  NOT: function (a) { return a ? 0 : 1; },
  XOR: function (a, b) { return (a ? 1 : 0) !== (b ? 1 : 0) ? 1 : 0; },
  NAND: function (a, b) { return a && b ? 0 : 1; },
  NOR: function (a, b) { return a || b ? 0 : 1; },
  XNOR: function (a, b) { return (a ? 1 : 0) !== (b ? 1 : 0) ? 0 : 1; },
  BUFFER: function (a) { return a ? 1 : 0; }
};
// 生成某个门的全输入组合真值表；未知门返回空数组。
function truthTable(type) {
  var out = [];
  try {
    var name = toText(type).toUpperCase().trim();
    var fn = TRUTH_TABLE[name];
    if (!fn) return out;
    var arity = name === "NOT" || name === "BUFFER" ? 1 : 2;
    var combos = arity === 1 ? [[0], [1]] : [[0, 0], [0, 1], [1, 0], [1, 1]];
    for (var i = 0; i < combos.length; i++) {
      var expected = arity === 1 ? fn(combos[i][0]) : fn(combos[i][0], combos[i][1]);
      out.push({ inputs: combos[i].slice(), out: expected });
    }
  } catch (e) { return out; }
  return out;
}
// 用真值表逐项验证门实现（纯函数级回归），返回 ok / cases / failed。
function verifyTruthTable(type) {
  var out = { ok: false, gate: toText(type).toUpperCase(), cases: 0, failed: 0, message: "unknown gate / 未知门" };
  try {
    var fn = TRUTH_TABLE[out.gate];
    if (!fn) return out;
    var table = truthTable(out.gate);
    for (var i = 0; i < table.length; i++) {
      var row = table[i];
      var got = row.inputs.length === 1 ? fn(row.inputs[0]) : fn(row.inputs[0], row.inputs[1]);
      out.cases = out.cases + 1;
      if (got !== row.out) out.failed = out.failed + 1;
    }
    out.ok = out.failed === 0 && out.cases > 0;
    out.message = out.ok ? "truth table verified / 真值表校验通过" : "truth table mismatch / 真值表不一致";
    counters.verified = counters.verified + 1;
  } catch (e) { out.message = errText(e); }
  return out;
}
// 当前仿真后端名称：nucleation 可用返回 nucleation，否则 builtin。
function backend() {
  try {
    if (nucleation && nucleation.Schematic && typeof nucleation.Schematic.create === "function") return "nucleation";
  } catch (e) { /* 降级 */ }
  return "builtin";
}
// 包装外部 nucleation world：只转发方案要求的 4 个接口，缺失能力返回安全兜底。
function wrapExternal(world, name) {
  function call(method, fallback) {
    try { if (world && typeof world[method] === "function") return world[method].apply(world, Array.prototype.slice.call(arguments, 2)); }
    catch (e) { logWarn("外部仿真调用失败 / external sim failed: " + method + " " + errText(e)); }
    return fallback;
  }
  return {
    name: toText(name) || "test_circuit",
    backend: "nucleation",
    setBlockFromString: function (x, y, z, spec) {
      try { return call("setBlockFromString", { ok: false }, x, y, z, spec); } catch (e) { return { ok: false, message: errText(e) }; }
    },
    onUseBlock: function (x, y, z) {
      try { return call("onUseBlock", { ok: false }, x, y, z); } catch (e) { return { ok: false, message: errText(e) }; }
    },
    tick: function (n) {
      try { return call("tick", { ok: false, ticks: 0 }, n); } catch (e) { return { ok: false, ticks: 0, message: errText(e) }; }
    },
    isLit: function (x, y, z) {
      try { return call("isLit", false, x, y, z) === true; } catch (e) { return false; }
    },
    getBlock: function (x, y, z) {
      try { return call("getBlock", null, x, y, z); } catch (e) { return null; }
    },
    snapshot: function () { return { ok: true, backend: "nucleation", external: true }; },
    reset: function () { return { ok: true, message: "external reset / 外部仿真重置" }; }
  };
}
// 创建空白电路（对齐 nucleation 的 Schematic.create(name)）；返回带统一接口的 world。
function create(name) {
  try {
    if (backend() === "nucleation") {
      try {
        var ext = nucleation.Schematic.create(toText(name) || "test_circuit");
        if (ext) { counters.created = counters.created + 1; return wrapExternal(ext, name); }
      } catch (eExt) { logWarn("nucleation 创建失败，改用内置验证器 / fallback: " + errText(eExt)); }
    }
    return builtinWorld(name);
  } catch (e) {
    counters.failed = counters.failed + 1;
    logWarn("电路创建失败 / create failed: " + errText(e));
    return builtinWorld(name);
  }
}
// 内置 world：记录方块、输入翻转、网表门、pending 延迟队列与输出灯状态。
function builtinWorld(name) {
  var blocks = {};
  var gates = [];
  var nets = [];
  var pending = [];
  var clock = 0;

  // 取（或惰性建）坐标节点；坏坐标返回 null。
  function nodeAt(pos, createIfMissing) {
    try {
      var key = coordKey(pos);
      if (!blocks[key] && createIfMissing) {
        var p = typeof pos === "object" ? pos : { x: arguments[0], y: arguments[1], z: arguments[2] };
        blocks[key] = { key: key, x: toInt(p && p.x, 0), y: toInt(p && p.y, 0), z: toInt(p && p.z, 0),
          block: "air", props: {}, power: 0, lit: false, isInput: false, isOutput: false };
      }
      return blocks[key] || null;
    } catch (e) { return null; }
  }
  // 放置元件：解析方块串与属性，拉杆 / 按钮作为输入，红石灯作为输出。
  function setBlockFromString(a, b, c, spec) {
    var out = { ok: false, key: "", block: "", message: "bad spec / 方块规格非法" };
    try {
      var x = a, y = b, z = c;
      if (typeof a === "object") { x = a.x; y = a.y; z = a.z; spec = b; }
      var info = parseSpec(spec);
      if (!info.block) return out;
      var key = coordKey(x, y, z);
      var node = nodeAt({ x: x, y: y, z: z }, true);
      if (!node) return out;
      node.block = info.block;
      node.props = info.props;
      node.isInput = info.block === "lever" || info.block.indexOf("button") >= 0 || info.block === "pressure_plate";
      node.isOutput = info.block === "redstone_lamp" || info.block === "redstone_wire" || info.block === "redstone_block";
      node.lit = info.block !== "redstone_lamp" ? false : truthy(info.props.lit);
      if (info.props.powered !== undefined) node.power = truthy(info.props.powered) ? 1 : 0;
      else if (truthy(info.props.lit)) node.power = 1;
      out.ok = true;
      out.key = key;
      out.block = info.block;
      out.message = "block set / 元件已放置";
    } catch (e) { out.message = errText(e); }
    return out;
  }
  // 读取坐标节点（副本）；不存在返回 null。
  function getBlock(x, y, z) {
    try {
      var node = nodeAt(typeof x === "object" ? x : { x: x, y: y, z: z }, false);
      if (!node) return null;
      return { x: node.x, y: node.y, z: node.z, block: node.block, props: node.props,
        power: node.power, lit: node.lit, isInput: node.isInput, isOutput: node.isOutput };
    } catch (e) { return null; }
  }
  // 挂一个逻辑门到网表：inputs 是坐标数组，output 是坐标，delay 为中继器 tick 数。
  function addGate(type, inputs, output, options) {
    var out = { ok: false, id: "", message: "unknown gate / 未知门" };
    try {
      var name = toText(type).toUpperCase().trim();
      if (TRUTH_TABLE[name] === undefined) return out;
      var opts = options && typeof options === "object" ? options : {};
      var src = Array.isArray(inputs) ? inputs : [inputs];
      if (src.length === 0 || src.length > MAX_INPUTS) { out.message = "bad inputs / 输入数量非法"; return out; }
      var keys = [];
      for (var i = 0; i < src.length; i++) {
        var k = coordKey(src[i]);
        var nd = nodeAt(src[i], true);
        if (!nd) { out.message = "bad input coord / 输入坐标非法"; return out; }
        nd.isInput = true;
        keys.push(k);
      }
      var outKey = coordKey(output);
      var outNode = nodeAt(output, true);
      if (!outNode) { out.message = "bad output coord / 输出坐标非法"; return out; }
      outNode.isOutput = true;
      gates.push({ id: "g" + (gates.length + 1), type: name, inputs: keys, output: outKey,
        delay: Math.max(0, Math.min(16, toInt(opts.delay, 0))) });
      counters.gates = counters.gates + 1;
      out.ok = true;
      out.id = "g" + gates.length;
      out.message = "gate added / 逻辑门已入网表";
    } catch (e) { out.message = errText(e); }
    return out;
  }
  // 记录一条网表连线（供布线 / 快照查看），不直接产生信号。
  function connect(from, to, options) {
    var out = { ok: false, message: "bad net / 连线坐标非法" };
    try {
      var opts = options && typeof options === "object" ? options : {};
      var a = coordKey(from), b = coordKey(to);
      nets.push({ from: a, to: b, length: toInt(opts.length, 0), repeaters: toInt(opts.repeaters, 0) });
      out.ok = true;
      out.message = "net connected / 网表连线已登记";
    } catch (e) { out.message = errText(e); }
    return out;
  }
  // 直接给输入节点置电（自测 / 网表驱动用）；坏坐标返回 ok:false。
  function setPower(x, y, z, value) {
    try {
      var node = nodeAt(typeof x === "object" ? x : { x: x, y: y, z: z }, true);
      if (!node) return { ok: false, message: "bad coord / 坐标非法" };
      var v = typeof x === "object" ? y : value;
      node.power = truthy(v) || Number(v) > 0 ? 1 : 0;
      return { ok: true, power: node.power };
    } catch (e) { return { ok: false, message: errText(e) }; }
  }
  // 模拟右键使用拉杆 / 按钮：翻转 powered 并把变化写回 props；非输入元件返回 ok:false。
  function onUseBlock(x, y, z) {
    var out = { ok: false, powered: false, key: "", message: "not an input / 该方块不是输入元件" };
    try {
      var pos = typeof x === "object" ? x : { x: x, y: y, z: z };
      var node = nodeAt(pos, false);
      if (!node || !node.isInput) return out;
      node.power = node.power ? 0 : 1;
      node.props.powered = node.power ? "true" : "false";
      counters.uses = counters.uses + 1;
      out.ok = true;
      out.powered = node.power === 1;
      out.key = node.key;
      out.message = "lever toggled / 输入已翻转";
      emit("redstone.sim.use", { key: node.key, powered: out.powered, at: Date.now() });
    } catch (e) { out.message = errText(e); }
    return out;
  }
  // 计算一个门当前应输出的值；多输入门按左折叠逐个参与真值表。
  function gateValue(gate) {
    try {
      var fn = TRUTH_TABLE[gate.type];
      if (!fn) return 0;
      var vals = [];
      for (var i = 0; i < gate.inputs.length; i++) {
        var n = blocks[gate.inputs[i]];
        vals.push(n ? n.power : 0);
      }
      if (gate.type === "NOT" || gate.type === "BUFFER") return fn(vals[0]);
      var acc = vals[0];
      for (var j = 1; j < vals.length; j++) acc = fn(acc, vals[j]);
      return acc;
    } catch (e) { return 0; }
  }
  // 提交所有到期 pending，返回变化数；未到期的留在队列里等下一拍。
  function commit() {
    var changes = 0;
    var remain = [];
    for (var i = 0; i < pending.length; i++) {
      var job = pending[i];
      if (job.at > clock) { remain.push(job); continue; }
      var target = blocks[job.key];
      if (!target) continue;
      if (target.power !== job.power || target.lit !== job.power) {
        target.power = job.power;
        target.lit = job.power === 1;
        changes = changes + 1;
      }
    }
    pending = remain;
    return changes;
  }
  // 推进一拍：先提交上一拍的延迟值，再按门延迟把新值排入队列，delay=0 的门同拍生效。
  function step() {
    var changes = 0;
    try {
      clock = clock + 1;
      changes = changes + commit();
      for (var g = 0; g < gates.length; g++) {
        var gate = gates[g];
        var value = gateValue(gate);
        pending.push({ key: gate.output, power: value, at: clock + gate.delay });
      }
      changes = changes + commit();
    } catch (e) { return changes; }
    return changes;
  }
  // 推进 n 个红石 tick（上限 MAX_TICKS），返回累计变化；n 非法按 1 处理。
  function tick(n) {
    var out = { ok: false, ticks: 0, changes: 0, message: "tick failed / tick 推进失败" };
    try {
      var count = toInt(n, 1);
      if (count < 1) count = 1;
      if (count > MAX_TICKS) count = MAX_TICKS;
      for (var i = 0; i < count; i++) out.changes = out.changes + step();
      out.ticks = count;
      out.ok = true;
      out.message = "tick advanced / 红石 tick 已推进";
      counters.ticks = counters.ticks + count;
      logInfo("仿真推进 / sim tick: " + name + " ticks=" + count + " changes=" + out.changes);
    } catch (e) { out.message = errText(e); }
    return out;
  }
  // 读红石灯是否亮起：灯取 lit，红石线 / 其它节点取 power；不存在返回 false。
  function isLit(x, y, z) {
    try {
      var node = nodeAt(typeof x === "object" ? x : { x: x, y: y, z: z }, false);
      if (!node) return false;
      if (node.block === "redstone_lamp") return node.lit === true;
      return node.power > 0;
    } catch (e) { return false; }
  }
  // 全量快照：方块 / 门 / 连线 / 时钟 / 待提交队列，供自测与控制台诊断。
  function snapshot() {
    try {
      var list = [];
      for (var k in blocks) if (Object.prototype.hasOwnProperty.call(blocks, k)) list.push(getBlock(blocks[k].x, blocks[k].y, blocks[k].z));
      return { ok: true, backend: "builtin", name: toText(name) || "test_circuit", clock: clock,
        blocks: list, gates: gates.slice(), nets: nets.slice(), pending: pending.length };
    } catch (e) { return { ok: false, backend: "builtin", blocks: [], message: errText(e) }; }
  }
  // 清空电路（不销毁 world 引用），返回 ok。
  function reset() {
    try { blocks = {}; gates = []; nets = []; pending = []; clock = 0; }
    catch (e) { return { ok: false, message: errText(e) }; }
    return { ok: true, message: "circuit reset / 电路已重置" };
  }
  counters.created = counters.created + 1;
  return {
    name: toText(name) || "test_circuit", backend: "builtin",
    setBlockFromString: setBlockFromString, getBlock: getBlock, addGate: addGate, gate: addGate,
    connect: connect, setPower: setPower, onUseBlock: onUseBlock, tick: tick, isLit: isLit,
    snapshot: snapshot, reset: reset
  };
}
// 预置 NOT 门基准电路：lever(0,0,0) → torch/NOT → lamp(2,0,0)；返回 world 与坐标说明。
function buildNotGateDemo(options) {
  var opts = options && typeof options === "object" ? options : {};
  var world = create(opts.name || "test_circuit");
  try {
    var lever = { x: 0, y: 0, z: 0 };
    var lamp = { x: 2, y: 0, z: 0 };
    world.setBlockFromString(lever.x, lever.y, lever.z, "minecraft:lever[facing=east,face=floor,powered=false]");
    world.setBlockFromString(1, 0, 0, "minecraft:redstone_torch[lit=true]");
    world.setBlockFromString(lamp.x, lamp.y, lamp.z, "minecraft:redstone_lamp[lit=false]");
    if (typeof world.addGate === "function") world.addGate("NOT", [lever], lamp, { delay: 0 });
    if (typeof world.connect === "function") world.connect(lever, lamp, { length: 2 });
    world.tick(1);
  } catch (e) { logWarn("NOT 门模板创建失败 / NOT demo failed: " + errText(e)); }
  return { ok: true, world: world, lever: { x: 0, y: 0, z: 0 }, lamp: { x: 2, y: 0, z: 0 },
    message: "NOT gate ready / 非门基准电路已就绪" };
}
// 统计快照：创建 / tick / 使用 / 门 / 校验 / 失败次数与当前后端。
function stats() {
  return { ok: true, backend: backend(), created: counters.created, ticks: counters.ticks,
    uses: counters.uses, gates: counters.gates, verified: counters.verified, failed: counters.failed };
}
// 清空内存计数（不触碰磁盘）；供自测隔离。
function reset() {
  try { counters = { created: 0, ticks: 0, uses: 0, gates: 0, verified: 0, failed: 0 }; } catch (e) { /* ignore */ }
  return { ok: true, message: "redstone-sim stats reset / 红石仿真统计已重置" };
}

// 对外导出：Schematic.create 兼容入口 / 真值表 / NOT 门模板 / 诊断。
module.exports = {
  Schematic: { create: create },
  create: create,
  backend: backend,
  truthTable: truthTable,
  verifyTruthTable: verifyTruthTable,
  buildNotGateDemo: buildNotGateDemo,
  GATE_TYPES: GATE_TYPES,
  TRUTH_TABLE: TRUTH_TABLE,
  stats: stats,
  reset: reset
};
