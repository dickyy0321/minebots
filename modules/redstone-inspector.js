// ========================================
// 文件：modules/redstone-inspector.js
// 功能：红石全量状态扫描与电路故障检测——遍历区域内所有红石元件、提取 stateId / getProperties，
//       对比预期图纸生成精确中文报错、bot.chat 报警、黑板挂 repair_request 调度修理机器人
// 依赖：vec3（可选）、./shared-board（可选）、./event-bus（可选）、./logger（可选）、./json-repair（可选）
// 导出：attach / registerBot / isRedstone / readState / scanRedstoneArea / verifyCircuit /
//       lastScan / REPAIR_TITLE / stats / reset / REDSTONE_KEYS
// 作者：MineBots
// ========================================
//
// 设计 / design
//   1. 签名与需求一致：scanRedstoneArea(pos1, pos2) 与 verifyCircuit(expectedStates)；
//      额外参数走可选的 options（bot / botId / board / pos1 / pos2），不破坏既有调用。
//   2. 真 mineflayer API：bot.blockAt(vec) 取方块，block.stateId / block.getProperties() 取状态；
//      假 bot 只提供 properties 对象也能跑，全部 try/catch 降级。
//   3. 校验失败时一次性完成三件事：双语详细报错、bot.chat 公屏报警、黑板 repair_request 任务。
// CommonJS，ES5 风格，无中文变量名；所有外部调用包 try/catch，日志与报错双语。
var vecLib = null;
try { vecLib = require("vec3"); } catch (e) { vecLib = null; }
var sharedBoard = null;
try { sharedBoard = require("./shared-board"); } catch (e) { sharedBoard = null; }
var bus = null;
try { bus = require("./event-bus"); } catch (e) { bus = null; }
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：红石元件关键字（含命名空间前缀与常见别名），大小写不敏感匹配。
var REDSTONE_KEYS = [
  "redstone_wire", "redstone_torch", "redstone_block", "redstone_lamp", "repeater", "comparator",
  "piston", "observer", "lever", "button", "pressure_plate", "target", "daylight_detector",
  "hopper", "dispenser", "dropper", "note_block", "tripwire", "sculk_sensor", "bell",
  "trapped_chest", "tnt", "jukebox", "lectern", "lightning_rod", "campfire"
];
// 常量：修理任务标题 / 单次扫描体积上限 / 单条报警最大长度 / 最多推送报警条数 / 内部内存状态。
var REPAIR_TITLE = "repair_request";
var MAX_SCAN_BLOCKS = 32768;
var MAX_ALERT_CHARS = 220;
var MAX_ALERTS = 6;
var attached = { bot: null, botId: "default" };
var registry = {};
var snapshot = { ok: false, count: 0, blocks: [], bounds: null, at: 0, message: "not scanned / 尚未扫描" };
var counters = { scans: 0, verified: 0, repairs: 0, alerts: 0, failed: 0 };

// 写文件日志：扫描属高频信息，只落文件不刷 GUI。
function logInfo(msg) {
  try { if (logger && typeof logger.info === "function") logger.info("[redstone] " + msg); } catch (e) { /* ignore */ }
}
// 写系统日志：电路故障属低频事件，推 GUI 让使用者看见。
function logSystem(msg) {
  try { if (logger && typeof logger.system === "function") { logger.system("[redstone] " + msg); return; } }
  catch (e) { /* 退回 console */ }
  try { console.log("[redstone] " + msg); } catch (e2) { /* ignore */ }
}
// 广播红石事件：总线缺失时静默跳过。
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
  try { var n = Number(value); if (isNaN(n) || !isFinite(n)) return fallback; return Math.floor(n); }
  catch (e) { return fallback; }
}
// 归一化坐标：支持 {x,y,z} / [x,y,z] / "x,y,z"，坏值返回 null。
function pointOf(value) {
  try {
    if (Array.isArray(value) && value.length >= 3) return { x: toInt(value[0], NaN), y: toInt(value[1], NaN), z: toInt(value[2], NaN) };
    if (typeof value === "string") {
      var parts = value.replace(/[\[\]（）()]/g, "").split(/[,，\s]+/);
      if (parts.length >= 3) return { x: toInt(parts[0], NaN), y: toInt(parts[1], NaN), z: toInt(parts[2], NaN) };
    }
    if (value && typeof value === "object") return { x: toInt(value.x, NaN), y: toInt(value.y, NaN), z: toInt(value.z, NaN) };
  } catch (e) { return null; }
  return null;
}
// 坐标键：用于 expectedStates 映射与比对，非法坐标返回空串。
function keyOf(pos) {
  var p = pointOf(pos);
  if (!p || isNaN(p.x) || isNaN(p.y) || isNaN(p.z)) return "";
  return p.x + "," + p.y + "," + p.z;
}
// 构造 bot.blockAt 需要的向量：优先 vec3，其次实体位置派生，最后普通对象。
function vecOf(bot, point) {
  try {
    if (vecLib && typeof vecLib.Vec3 === "function") return new vecLib.Vec3(point.x, point.y, point.z);
    var base = bot && bot.entity ? bot.entity.position : null;
    if (base && typeof base.offset === "function") {
      return base.offset(point.x - (Number(base.x) || 0), point.y - (Number(base.y) || 0), point.z - (Number(base.z) || 0));
    }
  } catch (e) { /* 退回普通对象 */ }
  return { x: point.x, y: point.y, z: point.z };
}
// 判断方块名是否红石元件：去命名空间后按关键字匹配，坏值返回 false。
function isRedstone(name) {
  try {
    var text = toText(name).toLowerCase();
    if (text.length === 0) return false;
    if (text.indexOf("minecraft:") === 0) text = text.slice(10);
    for (var i = 0; i < REDSTONE_KEYS.length; i++) {
      if (text.indexOf(REDSTONE_KEYS[i]) >= 0) return true;
    }
  } catch (e) { return false; }
  return false;
}
// 读取一个方块的状态：stateId / getProperties() / properties / metadata 全兼容，返回统一快照。
function readState(block) {
  var out = { name: "", stateId: null, props: {}, facing: "", powered: null, delay: null, type: 0 };
  try {
    if (!block) return out;
    out.name = block.name ? String(block.name) : "";
    out.stateId = block.stateId === undefined ? null : block.stateId;
    out.type = block.type === undefined ? 0 : block.type;
    var raw = null;
    if (typeof block.getProperties === "function") raw = block.getProperties();
    if ((!raw || typeof raw !== "object") && block.properties && typeof block.properties === "object") raw = block.properties;
    if ((!raw || typeof raw !== "object") && block._properties && typeof block._properties === "object") raw = block._properties;
    if (raw && typeof raw === "object") {
      for (var k in raw) {
        if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
        out.props[k] = raw[k];
      }
    }
    out.facing = out.props.facing === undefined ? "" : toText(out.props.facing);
    if (out.props.powered !== undefined) out.powered = out.props.powered;
    else if (block.powered !== undefined) out.powered = block.powered;
    if (out.props.delay !== undefined) out.delay = out.props.delay;
    else if (block.delay !== undefined) out.delay = block.delay;
    if (out.props.facing === undefined && block.facing !== undefined) out.facing = toText(block.facing);
  } catch (e) { /* 状态读取失败保留已有部分 */ }
  return out;
}
// 把 powered 归一化成布尔：兼容 true/false、"true"/"false"、1/0，未知返回 null。
function boolOf(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  var t = toText(value).toLowerCase();
  if (t === "true" || t === "1" || t === "yes") return true;
  if (t === "false" || t === "0" || t === "no") return false;
  return null;
}
// 绑定默认 bot（主进程或测试注入）；坏值清空，返回 { ok, botId }。
function attach(bot, botId) {
  try {
    attached.bot = bot || null;
    attached.botId = toText(botId) || "default";
    if (bot && attached.botId) registry[attached.botId] = bot;
    return { ok: true, botId: attached.botId, bound: !!bot };
  } catch (e) { return { ok: false, botId: "", bound: false, message: errText(e) }; }
}
// 注册多 bot：供多机器人协同扫描；返回注册数量。
function registerBot(botId, bot) {
  var id = toText(botId);
  if (!id || !bot) return { ok: false, count: Object.keys(registry).length, message: "botId and bot required / 缺少机器人" };
  try { registry[id] = bot; } catch (e) { return { ok: false, count: 0, message: errText(e) }; }
  return { ok: true, count: Object.keys(registry).length, botId: id };
}
// 解析本次使用的 bot：options.bot > options.botId 注册表 > attach 的默认 bot。
function botOf(options) {
  var opts = options && typeof options === "object" ? options : {};
  try {
    if (opts.bot) return opts.bot;
    var id = toText(opts.botId);
    if (id && registry[id]) return registry[id];
  } catch (e) { /* 退回默认 bot */ }
  return attached.bot;
}
// 解析本次使用的黑板：options.board > shared-board；都不存在返回 null。
function boardOf(options) {
  var opts = options && typeof options === "object" ? options : {};
  return opts.board || sharedBoard || null;
}
// 取两个角点归一化后的扫描边界；坏值返回 null。
function boundsOf(pos1, pos2) {
  var a = pointOf(pos1), b = pointOf(pos2);
  if (!a || !b || isNaN(a.x) || isNaN(a.y) || isNaN(a.z) || isNaN(b.x) || isNaN(b.y) || isNaN(b.z)) return null;
  return {
    min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) },
    max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) }
  };
}
// 全量扫描区域内红石元件：三重循环调 bot.blockAt，记录 stateId 与全部属性；失败只降级不抛错。
function scanRedstoneArea(pos1, pos2, options) {
  var opts = options && typeof options === "object" ? options : {};
  var out = { ok: false, count: 0, blocks: [], bounds: null, scanned: 0, message: "bot not ready / 机器人未就绪", at: Date.now() };
  try {
    var bounds = boundsOf(pos1, pos2);
    if (!bounds) { out.message = "bad bounds / 扫描区域坐标非法"; return out; }
    out.bounds = bounds;
    var volume = (bounds.max.x - bounds.min.x + 1) * (bounds.max.y - bounds.min.y + 1) * (bounds.max.z - bounds.min.z + 1);
    if (volume > MAX_SCAN_BLOCKS) {
      out.message = "area too large / 区域超过 " + MAX_SCAN_BLOCKS + " 格上限";
      return out;
    }
    var bot = botOf(opts);
    if (!bot || typeof bot.blockAt !== "function") return out;
    for (var y = bounds.min.y; y <= bounds.max.y; y++) {
      for (var z = bounds.min.z; z <= bounds.max.z; z++) {
        for (var x = bounds.min.x; x <= bounds.max.x; x++) {
          out.scanned = out.scanned + 1;
          var block = null;
          try { block = bot.blockAt(vecOf(bot, { x: x, y: y, z: z })); } catch (eOne) { block = null; }
          if (!block || !isRedstone(block.name)) continue;
          var st = readState(block);
          out.blocks.push({
            pos: { x: x, y: y, z: z }, key: x + "," + y + "," + z, name: st.name,
            stateId: st.stateId, type: st.type, props: st.props,
            facing: st.facing, powered: st.powered, delay: st.delay
          });
        }
      }
    }
    out.count = out.blocks.length;
    out.ok = true;
    out.message = "scan complete / 红石扫描完成";
    snapshot = { ok: true, count: out.count, blocks: out.blocks, bounds: out.bounds, at: out.at, message: out.message };
    counters.scans = counters.scans + 1;
    logInfo("扫描 / scan: " + out.scanned + " blocks, redstone=" + out.count);
    emit("redstone.scanned", { count: out.count, scanned: out.scanned, bounds: out.bounds, at: out.at });
    return out;
  } catch (e) {
    counters.failed = counters.failed + 1;
    out.message = errText(e);
    logInfo("扫描失败 / scan failed: " + out.message);
    return out;
  }
}
// 归一化预期状态：支持数组 [{pos,name,...}]、对象映射 {"x,y,z": {...}}、或带 x/y/z 的单条。
function expectedMap(expectedStates) {
  var out = {};
  try {
    var list = [];
    if (Array.isArray(expectedStates)) list = expectedStates;
    else if (expectedStates && typeof expectedStates === "object") {
      if (expectedStates.pos || expectedStates.x !== undefined) list = [expectedStates];
      else {
        for (var k in expectedStates) {
          if (!Object.prototype.hasOwnProperty.call(expectedStates, k)) continue;
          var one = expectedStates[k] && typeof expectedStates[k] === "object" ? expectedStates[k] : {};
          one.key = k;
          list.push(one);
        }
      }
    }
    for (var i = 0; i < list.length; i++) {
      var e = list[i] && typeof list[i] === "object" ? list[i] : {};
      var key = keyOf(e.pos || e) || toText(e.key);
      if (!key) continue;
      out[key] = e;
    }
  } catch (e) { return out; }
  return out;
}
// 生成一条精确的双语故障描述：区分缺件 / 未通电 / 朝向反了 / 延迟错 / 状态 ID 不符。
function describeMismatch(key, want, got) {
  var at = "坐标 " + key + " / at " + key;
  var label = toText(want.name || (got ? got.name : "")) || "红石元件 / redstone component";
  if (!got) return at + " 缺少" + label + " / missing " + label;
  if (want.stateId !== undefined && got.stateId !== null && String(want.stateId) !== String(got.stateId)) {
    return at + " 的" + label + "状态 ID 不符（期望 " + want.stateId + "，实际 " + got.stateId + "）/ stateId mismatch";
  }
  if (want.facing !== undefined && toText(want.facing).length > 0 && toText(want.facing) !== toText(got.facing)) {
    return at + " 的活塞朝向反了（期望 " + want.facing + "，实际 " + (got.facing || "unknown") + "）/ facing reversed";
  }
  var wantPowered = boolOf(want.powered !== undefined ? want.powered : (want.props ? want.props.powered : undefined));
  var gotPowered = boolOf(got.powered);
  if (wantPowered !== null && gotPowered !== null && wantPowered !== gotPowered) {
    return at + " 的中继器未通电 / repeater or component not powered (expected " + wantPowered + ", got " + gotPowered + ")";
  }
  if (want.delay !== undefined && got.delay !== null && toText(want.delay) !== toText(got.delay)) {
    return at + " 的中继器延迟错误（期望 " + want.delay + "，实际 " + got.delay + "）/ delay mismatch";
  }
  return at + " 的" + label + "状态与图纸不符 / state mismatch";
}
// 对照预期图纸校验电路：不一致时生成双语详细报错、bot.chat 报警、黑板挂 repair_request 任务。
function verifyCircuit(expectedStates, options) {
  var opts = options && typeof options === "object" ? options : {};
  var out = { ok: false, matched: 0, mismatches: [], report: [], alerted: 0, taskId: "",
    message: "no expectations / 没有预期状态" };
  try {
    var want = expectedMap(expectedStates);
    var keys = Object.keys(want);
    if (keys.length === 0) return out;
    var current = null;
    if (opts.pos1 && opts.pos2) current = scanRedstoneArea(opts.pos1, opts.pos2, opts);
    else if (opts.useFreshScan) current = scanRedstoneArea(snapshot.bounds.min, snapshot.bounds.max, opts);
    else current = snapshot;
    if (!current || !current.ok) { out.message = "scan unavailable / 没有可用的扫描快照"; return out; }
    var index = {};
    for (var c = 0; c < current.blocks.length; c++) index[current.blocks[c].key] = current.blocks[c];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i], expected = want[key], actual = index[key] || null;
      if (actual && isMatch(expected, actual)) { out.matched = out.matched + 1; continue; }
      var text = describeMismatch(key, expected, actual);
      out.mismatches.push({ key: key, expected: expected, actual: actual, message: text });
      out.report.push(text);
    }
    out.ok = out.mismatches.length === 0;
    counters.verified = counters.verified + 1;
    if (out.ok) {
      out.message = "circuit verified / 电路状态与图纸一致";
      emit("redstone.verified", { matched: out.matched, at: Date.now() });
      return out;
    }
    // 报警：合并前若干条详细报错，逐条 bot.chat（双语），绝不因 chat 缺失而中断。
    var bot = botOf(opts);
    if (bot && typeof bot.chat === "function" && opts.silent !== true) {
      for (var a = 0; a < out.report.length && a < MAX_ALERTS; a++) {
        var line = "[MineBots 红石告警 / Redstone] " + out.report[a].slice(0, MAX_ALERT_CHARS);
        try { bot.chat(line); out.alerted = out.alerted + 1; } catch (eChat) { /* 单条失败继续 */ }
      }
      counters.alerts = counters.alerts + out.alerted;
    }
    // 黑板挂修理单：payload 带完整差异，物流 / 修理机器人可 claimTask 抢单。
    var board = boardOf(opts);
    if (board && typeof board.postTask === "function" && opts.noTask !== true) {
      var posted = board.postTask({ title: REPAIR_TITLE, priority: 9,
        payload: { action: "repair_redstone", botId: toText(opts.botId) || attached.botId,
          count: out.mismatches.length, mismatches: out.mismatches, report: out.report, at: Date.now() } });
      if (posted && posted.ok) out.taskId = posted.taskId;
    }
    counters.repairs = counters.repairs + 1;
    out.message = "circuit mismatch / 检测到 " + out.mismatches.length + " 处电路故障";
    logSystem("电路故障 / circuit fault: " + out.mismatches.length + " issues, repair task=" + (out.taskId || "none"));
    emit("redstone.repair", { count: out.mismatches.length, taskId: out.taskId, report: out.report, at: Date.now() });
    return out;
  } catch (e) {
    counters.failed = counters.failed + 1;
    out.message = errText(e);
    return out;
  }
}
// 单条预期与实测是否匹配：只比明确给出的字段，未给出的字段不参与判定。
function isMatch(want, got) {
  try {
    if (want.name && toText(want.name).toLowerCase() !== toText(got.name).toLowerCase()) return false;
    if (want.stateId !== undefined && String(want.stateId) !== String(got.stateId)) return false;
    if (want.facing !== undefined && toText(want.facing).length > 0 && toText(want.facing) !== toText(got.facing)) return false;
    var wp = boolOf(want.powered !== undefined ? want.powered : (want.props ? want.props.powered : undefined));
    var gp = boolOf(got.powered);
    if (wp !== null && gp !== null && wp !== gp) return false;
    if (want.delay !== undefined && toText(want.delay) !== toText(got.delay)) return false;
    if (want.props && typeof want.props === "object") {
      for (var k in want.props) {
        if (!Object.prototype.hasOwnProperty.call(want.props, k)) continue;
        if (toText(got.props[k]) !== toText(want.props[k])) return false;
      }
    }
    return true;
  } catch (e) { return false; }
}
// 读最近一次扫描快照（副本）；供控制台与自测核对。
function lastScan() {
  try { return JSON.parse(JSON.stringify(snapshot)); } catch (e) { return { ok: false, count: 0, blocks: [] }; }
}
// 统计快照：扫描 / 校验 / 修理 / 报警 / 失败次数。
function stats() {
  return { ok: true, scans: counters.scans, verified: counters.verified, repairs: counters.repairs,
    alerts: counters.alerts, failed: counters.failed, attached: !!attached.bot,
    bots: Object.keys(registry).length, lastCount: snapshot.count, repairTitle: REPAIR_TITLE };
}
// 清空内存状态（不触碰黑板与 bot）；供自测隔离。
function reset() {
  try {
    attached = { bot: null, botId: "default" };
    registry = {};
    snapshot = { ok: false, count: 0, blocks: [], bounds: null, at: 0, message: "not scanned / 尚未扫描" };
    counters = { scans: 0, verified: 0, repairs: 0, alerts: 0, failed: 0 };
  } catch (e) { /* ignore */ }
  return { ok: true, message: "redstone inspector reset / 红石扫描器已重置" };
}

// 对外导出：绑定 / 判定 / 状态读取 / 扫描 / 校验 / 诊断。
module.exports = {
  attach: attach,
  registerBot: registerBot,
  isRedstone: isRedstone,
  readState: readState,
  scanRedstoneArea: scanRedstoneArea,
  verifyCircuit: verifyCircuit,
  lastScan: lastScan,
  stats: stats,
  reset: reset,
  REPAIR_TITLE: REPAIR_TITLE,
  REDSTONE_KEYS: REDSTONE_KEYS,
  MAX_SCAN_BLOCKS: MAX_SCAN_BLOCKS
};
