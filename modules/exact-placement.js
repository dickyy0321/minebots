// ========================================
// 文件：modules/exact-placement.js
// 功能：精确建筑 / 红石触发的统一底层门面——开关读取、方块中心坐标对准（bot.lookAt）、
//       加速度拉满、activateBlock 状态预检与触发，供 actions / motion / redstone-trigger 复用
// 依赖：./engine-control（可选）、./logger（可选）、./event-bus（可选）、vec3（可选）
// 导出：isExact / acceleration / centerOf / aimAt / activateBlock / placeAim / stats / reset
// 作者：MineBots
// ========================================
//
// 设计 / design
//   1. engExactBuild 默认关：关闭时 aimAt 直接返回 aimed:false，绝不改变既有动作链路（老断言全绿）。
//   2. 开启后，放置 / 触发前一律先 bot.lookAt 对准目标方块的中心（x+0.5, y+0.5, z+0.5），
//      再执行 placeBlock / activateBlock，杜绝朝向与放置面漂移。
//   3. 加速度拉满：acceleration() 返回 1（瞬时满速、无加减速缓动），motion 的缓转同步压成单步。
//   4. 真实 mineflayer API 每次调用都判空 + try/catch，失败只降级，绝不把异常抛到顶层。
// CommonJS，ES5 风格，无中文变量名；所有外部调用包 try/catch，日志与报错双语。
var engineControl = null;
try { engineControl = require("./engine-control"); } catch (e) { engineControl = null; }
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
var bus = null;
try { bus = require("./event-bus"); } catch (e) { bus = null; }
var vecLib = null;
try { vecLib = require("vec3"); } catch (e) { vecLib = null; }

// 常量：精确模式下的加速度（1 = 拉满，无 ramp）/ 中心偏移 / 累计统计。
var MAX_ACCELERATION = 1;
var CENTER_OFFSET = 0.5;
var counters = { aims: 0, activations: 0, blocked: 0, failed: 0 };

// 写文件日志：放置 / 触发属高频动作，只落文件不刷 GUI。
function logInfo(msg) {
  try { if (logger && typeof logger.info === "function") logger.info("[exact] " + msg); } catch (e) { /* ignore */ }
}
// 写告警日志：精确模式下的失败要让人看见，没有 logger 时静默。
function logWarn(msg) {
  try { if (logger && typeof logger.warn === "function") { logger.warn("[exact] " + msg); return; } }
  catch (e) { /* 退回静默 */ }
  try { console.warn("[exact] " + msg); } catch (e2) { /* ignore */ }
}
// 广播精确模式事件：低频才推，总线缺失时静默跳过。
function emit(name, payload) {
  try { if (bus && typeof bus.emit === "function") bus.emit(name, payload); } catch (e) { /* ignore */ }
}
// 安全取错误文本：catch 里绝不会二次抛错。
function errText(err) {
  try { if (err && err.message) return String(err.message); return String(err); }
  catch (e) { return "unknown error / 未知错误"; }
}
// 安全转有限数字：坏值返回 fallback。
function toNum(value, fallback) {
  try {
    var n = Number(value);
    if (isNaN(n) || !isFinite(n)) return fallback;
    return n;
  } catch (e) { return fallback; }
}
// 归一化坐标：支持 {x,y,z} / [x,y,z] / 字符串 "x,y,z"，坏值返回 null。
function pointOf(value) {
  try {
    if (Array.isArray(value) && value.length >= 3) {
      return { x: toNum(value[0], NaN), y: toNum(value[1], NaN), z: toNum(value[2], NaN) };
    }
    if (typeof value === "string") {
      var parts = value.replace(/[\[\]（）()]/g, "").split(/[,，\s]+/);
      if (parts.length >= 3) return { x: toNum(parts[0], NaN), y: toNum(parts[1], NaN), z: toNum(parts[2], NaN) };
    }
    if (value && typeof value === "object") {
      return { x: toNum(value.x, NaN), y: toNum(value.y, NaN), z: toNum(value.z, NaN) };
    }
  } catch (e) { return null; }
  return null;
}
// 精确建筑开关是否开启；控制中心缺失时按关闭（保持既有拟真行为）。
function isExact() {
  try {
    if (engineControl && typeof engineControl.exactBuild === "function") return engineControl.exactBuild() === true;
  } catch (e) { /* 读失败按关闭 */ }
  return false;
}
// 移动加速度：精确模式拉满返回 1；普通模式返回 0 表示沿用原加减速曲线，绝不返回 NaN。
function acceleration() {
  return isExact() ? MAX_ACCELERATION : 0;
}
// 目标方块的中心坐标：整数坐标 + 0.5，坏输入返回 null。
function centerOf(pos) {
  var p = pointOf(pos);
  if (!p || isNaN(p.x) || isNaN(p.y) || isNaN(p.z)) return null;
  return {
    x: Math.floor(p.x) + CENTER_OFFSET,
    y: Math.floor(p.y) + CENTER_OFFSET,
    z: Math.floor(p.z) + CENTER_OFFSET
  };
}
// 构造 bot.lookAt 需要的向量：优先 vec3 实例，其次从 entity.position 派生，最后普通对象。
function vecOf(bot, point) {
  try {
    if (vecLib && typeof vecLib.Vec3 === "function") return new vecLib.Vec3(point.x, point.y, point.z);
    var base = bot && bot.entity ? bot.entity.position : null;
    if (base && typeof base.offset === "function") {
      return base.offset(point.x - toNum(base.x, 0), point.y - toNum(base.y, 0), point.z - toNum(base.z, 0));
    }
  } catch (e) { /* 退回普通对象 */ }
  return { x: point.x, y: point.y, z: point.z };
}
// 精确对准目标方块中心：仅 engExactBuild 开启时真正调 bot.lookAt；返回 { ok, aimed, center, message }。
async function aimAt(bot, pos, options) {
  var opts = options && typeof options === "object" ? options : {};
  var out = { ok: false, aimed: false, center: null, exact: false, message: "exact build off / 精确建筑未开启" };
  try {
    if (!isExact() && opts.force !== true) return out;
    out.exact = true;
    if (!bot) { out.message = "bot not ready / 机器人未就绪"; return out; }
    var center = centerOf(pos);
    if (!center) { out.message = "bad target / 目标坐标非法"; return out; }
    out.center = center;
    if (typeof bot.lookAt !== "function") { out.message = "lookAt unavailable / 机器人不支持转向"; return out; }
    var running = bot.lookAt(vecOf(bot, center), true);
    if (running && typeof running.then === "function") {
      await running.then(function () { return null; }, function () { return null; });
    }
    out.ok = true;
    out.aimed = true;
    out.message = "aimed at block center / 已对准方块中心";
    counters.aims = counters.aims + 1;
    logInfo("对准中心 / aim: " + center.x + "," + center.y + "," + center.z);
    return out;
  } catch (e) {
    counters.failed = counters.failed + 1;
    out.message = errText(e);
    logWarn("中心对准失败 / aim failed: " + out.message);
    return out;
  }
}
// 放置前的统一钩子：精确模式对准中心，普通模式直接放行（不产生任何额外网络调用）。
async function placeAim(bot, x, y, z) {
  try { return await aimAt(bot, { x: x, y: y, z: z }); }
  catch (e) { return { ok: false, aimed: false, center: null, exact: false, message: errText(e) }; }
}
// 读取方块状态快照（供触发前预检）：stateId / name / powered / getProperties 都兼容，绝不抛错。
function stateOf(block) {
  var out = { stateId: null, name: "", powered: null, props: {} };
  try {
    if (!block) return out;
    out.stateId = block.stateId === undefined ? null : block.stateId;
    out.name = block.name ? String(block.name) : "";
    if (typeof block.getProperties === "function") {
      var props = block.getProperties();
      if (props && typeof props === "object") out.props = props;
    }
    if (out.props && typeof out.props === "object" && out.props.powered !== undefined) {
      out.powered = out.props.powered;
    }
    if (out.powered === null && block.powered !== undefined) out.powered = block.powered;
  } catch (e) { /* 状态读取失败按空快照 */ }
  return out;
}
// 精确触发一个红石元件：先对准中心，再 blockAt 预检（防服务器卡顿漏包），最后 bot.activateBlock。
// 返回 { ok, activated, aimed, blocked, state, message }；任何一步失败都只降级不抛异常。
async function activateBlock(bot, pos, options) {
  var opts = options && typeof options === "object" ? options : {};
  var out = { ok: false, activated: false, aimed: false, blocked: false, state: null,
    pos: pointOf(pos), message: "bot not ready / 机器人未就绪" };
  try {
    if (!bot) return out;
    var p = pointOf(pos);
    if (!p || isNaN(p.x) || isNaN(p.y) || isNaN(p.z)) {
      out.message = "bad target / 目标坐标非法"; return out;
    }
    var aimed = await aimAt(bot, p);
    out.aimed = aimed.aimed === true;
    if (typeof bot.blockAt !== "function") { out.blocked = true; out.message = "blockAt unavailable / 无法读取方块状态"; return out; }
    var vec = vecOf(bot, { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
    var block = bot.blockAt(vec);
    var st = stateOf(block);
    out.state = st;
    // 预检：方块不存在 / 是空气时不发网络包，避免无效触发与漏包重发。
    if (!block || st.name === "" || st.name.indexOf("air") === 0) {
      out.blocked = true;
      counters.blocked = counters.blocked + 1;
      out.message = "block missing / 目标方块不存在或为空气";
      logInfo("触发被阻止 / activation blocked: " + p.x + "," + p.y + "," + p.z);
      return out;
    }
    if (typeof bot.activateBlock !== "function") {
      out.blocked = true;
      out.message = "activateBlock unavailable / 机器人不支持触发方块";
      return out;
    }
    var running = bot.activateBlock(block);
    if (running && typeof running.then === "function") {
      await running.then(function () { return null; }, function () { return null; });
    }
    out.ok = true;
    out.activated = true;
    out.message = "block activated / 方块已触发";
    counters.activations = counters.activations + 1;
    emit("exact.activated", { pos: p, name: st.name, stateId: st.stateId, at: Date.now() });
    return out;
  } catch (e) {
    counters.failed = counters.failed + 1;
    out.message = errText(e);
    logWarn("触发失败 / activation failed: " + out.message);
    return out;
  }
}
// 状态快照：累计对准 / 触发 / 阻止 / 失败次数与当前开关。
function stats() {
  return { ok: true, exact: isExact(), acceleration: acceleration(), aims: counters.aims,
    activations: counters.activations, blocked: counters.blocked, failed: counters.failed };
}
// 清空内存计数（不触碰偏好磁盘）；供自测隔离。
function reset() {
  try { counters = { aims: 0, activations: 0, blocked: 0, failed: 0 }; } catch (e) { /* ignore */ }
  return { ok: true, message: "exact placement stats reset / 精确放置统计已重置" };
}

// 对外导出：开关 / 加速度 / 中心坐标 / 对准 / 触发 / 诊断。
module.exports = {
  isExact: isExact,
  acceleration: acceleration,
  centerOf: centerOf,
  aimAt: aimAt,
  placeAim: placeAim,
  activateBlock: activateBlock,
  stateOf: stateOf,
  stats: stats,
  reset: reset,
  MAX_ACCELERATION: MAX_ACCELERATION
};
