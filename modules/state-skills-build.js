// ========================================
// 文件：modules/state-skills-build.js
// 功能：高维建筑技能节点——place_block_exact 精确放置；放置后读回方块状态，
//       属性不符（facing / half / delay / powered）时先 bot.dig 破坏，再重调视线与放置面重放
// 依赖：./state-util（可选）、./actions（可选）、./exact-placement（可选）、
//       ./blueprint-highdim（可选）、./logger（可选）、vec3（可选）
// 导出：HANDLERS / NAMES / has / pick
// 作者：MineBots
// ========================================
//
// 设计 / design
//   1. handler 形如 function (ctx, args) 返回 Promise<{ ok, message }>，与 state-skills*.js 完全一致，
//      由 state-nodes 的 MODULES 自动派发，绝不重写核心。
//   2. 每次放置后通过 bot.blockAt(pos).getProperties() 读回真实状态，与 expectedState 逐字段比对；
//      只有明确读到且不一致才返工，读不到属性时按「无法校验」放行，不误破坏。
//   3. 返工链路：精确对准中心 → bot.dig 破坏 → 换放置面 + 重新 bot.lookAt → 重放，最多 maxRetries 次。
// CommonJS，ES5 风格，无中文变量名；所有外部调用包 try/catch，日志与报错双语。
var actions = null;
try { actions = require("./actions"); } catch (e) { actions = null; }
var exact = null;
try { exact = require("./exact-placement"); } catch (e) { exact = null; }
var highdim = null;
try { highdim = require("./blueprint-highdim"); } catch (e) { highdim = null; }
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
var vecLib = null;
try { vecLib = require("vec3"); } catch (e) { vecLib = null; }

// 常量：放置面到法向量的映射 / 返工时的轮换顺序 / 默认重试次数。
var FACE_VECTORS = {
  up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, -1],
  south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0]
};
var FACE_ROTATION = ["up", "north", "east", "south", "west", "down"];
var DEFAULT_RETRIES = 2;

// 写文件日志：放置属高频动作，只落文件不刷 GUI。
function logInfo(msg) {
  try { if (logger && typeof logger.info === "function") logger.info("[build-skill] " + msg); } catch (e) { /* ignore */ }
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
// 安全转数字：坏值回 fallback。
function toNum(value, fallback) {
  try { var n = Number(value); if (isNaN(n) || !isFinite(n)) return fallback; return n; }
  catch (e) { return fallback; }
}
// 归一化期望状态：从 args.props / args.expectedState / args 顶层字段聚合，返回 { props, stateId, name }。
function expectedOf(args) {
  var out = { props: {}, stateId: null, name: "" };
  try {
    var spec = args.expectedState && typeof args.expectedState === "object" ? args.expectedState : {};
    var props = args.props && typeof args.props === "object" ? args.props : {};
    var sp = spec.props && typeof spec.props === "object" ? spec.props : {};
    function collect(src) {
      for (var k in src) {
        if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
        if (typeof src[k] === "object") continue;
        out.props[toText(k).toLowerCase()] = toText(src[k]);
      }
    }
    collect(props);
    collect(sp);
    // args.expectedState 的顶层字段也参与校验（facing / half / delay …）。
    for (var key in spec) {
      if (!Object.prototype.hasOwnProperty.call(spec, key)) continue;
      if (key === "props" || key === "name" || key === "stateId") continue;
      if (typeof spec[key] === "object") continue;
      out.props[toText(key).toLowerCase()] = toText(spec[key]);
    }
    for (var top in args) {
      if (!Object.prototype.hasOwnProperty.call(args, top)) continue;
      if (["facing", "half", "delay", "powered", "axis", "orientation", "shape", "type", "part", "open", "lit", "rotation"].indexOf(top) < 0) continue;
      out.props[top] = toText(args[top]);
    }
    if (spec.stateId !== undefined) out.stateId = spec.stateId;
    else if (args.stateId !== undefined) out.stateId = args.stateId;
    out.name = toText(spec.name || args.block || "");
  } catch (e) { /* 返回已解析部分 */ }
  return out;
}
// 构造 bot.blockAt / bot.placeBlock 需要的向量；缺 vec3 时用普通对象。
function vecOf(bot, x, y, z) {
  try {
    if (vecLib && typeof vecLib.Vec3 === "function") return new vecLib.Vec3(x, y, z);
    var base = bot && bot.entity ? bot.entity.position : null;
    if (base && typeof base.offset === "function") {
      return base.offset(x - toNum(base.x, 0), y - toNum(base.y, 0), z - toNum(base.z, 0));
    }
  } catch (e) { /* 退回普通对象 */ }
  return { x: x, y: y, z: z };
}
// 读回一个坐标的方块状态：优先 getProperties()，其次 properties / 顶层字段；读不到返回 null。
function readPlaced(bot, pos) {
  try {
    if (!bot || typeof bot.blockAt !== "function") return null;
    var block = bot.blockAt(vecOf(bot, pos.x, pos.y, pos.z));
    if (!block) return null;
    var out = { name: block.name ? String(block.name) : "", stateId: block.stateId === undefined ? null : block.stateId, props: {} };
    var raw = null;
    if (typeof block.getProperties === "function") raw = block.getProperties();
    if ((!raw || typeof raw !== "object") && block.properties && typeof block.properties === "object") raw = block.properties;
    if (!raw || typeof raw !== "object") {
      // 没有属性接口时退回几个常见顶层字段，保证红石元件也能校验。
      ["facing", "half", "delay", "powered", "axis", "shape", "type"].forEach(function (k) {
        if (block[k] !== undefined) out.props[k] = toText(block[k]);
      });
      return out;
    }
    for (var k2 in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, k2)) continue;
      out.props[toText(k2).toLowerCase()] = toText(raw[k2]);
    }
    return out;
  } catch (e) { return null; }
}
// 比对实际状态与期望：返回 { ok, diff, verified }；没有任何期望属性时 verified=false（放行不返工）。
function compare(expected, actual) {
  var out = { ok: true, verified: false, diff: [] };
  try {
    if (!actual) { out.verified = false; return out; }
    if (expected.name && actual.name && expected.name.indexOf(actual.name) < 0 && actual.name.indexOf(expected.name) < 0) {
      out.verified = true;
      out.ok = false;
      out.diff.push({ key: "name", want: expected.name, got: actual.name });
    }
    for (var key in expected.props) {
      if (!Object.prototype.hasOwnProperty.call(expected.props, key)) continue;
      out.verified = true;
      var want = toText(expected.props[key]).toLowerCase();
      var got = actual.props[key] === undefined ? "" : toText(actual.props[key]).toLowerCase();
      if (want !== got) {
        out.ok = false;
        out.diff.push({ key: key, want: want, got: got });
      }
    }
    if (expected.stateId !== null && expected.stateId !== undefined && actual.stateId !== null &&
        toText(expected.stateId) !== toText(actual.stateId)) {
      out.verified = true;
      out.ok = false;
      out.diff.push({ key: "stateId", want: toText(expected.stateId), got: toText(actual.stateId) });
    }
  } catch (e) { out.verified = false; }
  return out;
}
// 破坏错误方块：优先 bot.dig(block)，其次 actions.digBlock；返回是否真的调过破坏。
async function digWrong(bot, pos, actual) {
  try {
    var block = null;
    if (bot && typeof bot.blockAt === "function") block = bot.blockAt(vecOf(bot, pos.x, pos.y, pos.z));
    if (block && bot && typeof bot.dig === "function") {
      var running = bot.dig(block);
      if (running && typeof running.then === "function") await running.then(function () { return null; }, function () { return null; });
      return true;
    }
    if (actions && typeof actions.digBlock === "function") {
      var res = await actions.digBlock(bot, pos.x, pos.y, pos.z);
      return !!(res && res.ok !== false);
    }
  } catch (e) { logInfo("破坏失败 / dig failed: " + errText(e)); }
  return false;
}
// 执行一次放置：优先 actions.placeBlock（装备 + 参考块），退化到 bot.placeBlock(ref, faceVector)。
async function placeOnce(bot, blockName, pos, face) {
  try {
    // 精确建筑：任何一次放置前都先对准目标方块中心，返工时再调一次视线。
    if (exact && typeof exact.placeAim === "function") {
      await exact.placeAim(bot, pos.x, pos.y, pos.z).catch(function () { return null; });
    } else if (bot && typeof bot.lookAt === "function") {
      var center = { x: Math.floor(pos.x) + 0.5, y: Math.floor(pos.y) + 0.5, z: Math.floor(pos.z) + 0.5 };
      try { await bot.lookAt(vecOf(bot, center.x, center.y, center.z), true); } catch (eLook) { /* 视线失败继续 */ }
    }
    if (actions && typeof actions.placeBlock === "function") {
      var res = await actions.placeBlock(bot, blockName, pos.x, pos.y, pos.z);
      if (res && res.ok !== false) return { ok: true, via: "actions.placeBlock" };
    }
    if (bot && typeof bot.placeBlock === "function") {
      var ref = null;
      if (typeof bot.blockAt === "function") ref = bot.blockAt(vecOf(bot, pos.x, pos.y - 1, pos.z));
      if (!ref) return { ok: false, message: "no reference block / 找不到可依附的方块" };
      var fv = FACE_VECTORS[face] || FACE_VECTORS.up;
      var running = bot.placeBlock(ref, vecOf(bot, fv[0], fv[1], fv[2]));
      if (running && typeof running.then === "function") await running.then(function () { return null; }, function () { return null; });
      return { ok: true, via: "bot.placeBlock" };
    }
    return { ok: false, message: "place unavailable / 放置接口不可用" };
  } catch (e) { return { ok: false, message: errText(e) }; }
}
// place_block_exact：放置后读回属性，不符则 dig 破坏 + 换放置面 + 重调视线后重放。
async function placeBlockExact(ctx, args) {
  var out = { ok: false, attempts: 0, dug: 0, realigned: 0, verified: false,
    diff: [], face: "up", block: "", pos: null, message: "bot not ready / 机器人未就绪" };
  try {
    var box = ctx && typeof ctx === "object" ? ctx : {};
    var a = args && typeof args === "object" ? args : {};
    var bot = box.bot;
    if (!bot) return out;
    var x = toNum(a.x, NaN), y = toNum(a.y, NaN), z = toNum(a.z, NaN);
    if (isNaN(x) || isNaN(y) || isNaN(z)) { out.message = "x/y/z 必须是数字 / x, y, z must be numbers"; return out; }
    var pos = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
    out.pos = pos;
    var blockName = toText(a.block || a.name || a.material);
    if (!blockName) { out.message = "block required / 缺少方块名"; return out; }
    out.block = blockName;
    var expected = expectedOf(a);
    var retries = Math.max(0, Math.min(5, Math.floor(toNum(a.maxRetries, DEFAULT_RETRIES))));
    var face = toText(a.face || expected.props.facing || "up").toLowerCase();
    if (!FACE_VECTORS[face]) face = "up";
    out.face = face;
    var total = retries + 1;
    for (var i = 0; i < total; i++) {
      out.attempts = out.attempts + 1;
      var placed = await placeOnce(bot, blockName, pos, face);
      if (!placed.ok) { out.message = placed.message; continue; }
      var actual = readPlaced(bot, pos);
      var cmp = compare(expected, actual);
      out.verified = cmp.verified;
      out.diff = cmp.diff;
      if (cmp.ok || !cmp.verified) {
        out.ok = true;
        out.message = cmp.verified
          ? "place_block_exact verified / 精确放置属性校验通过"
          : "place_block_exact placed / 已放置（当前方块无属性接口，跳过校验）";
        return out;
      }
      // 属性不符：破坏 → 换放置面 → 重新对准中心 → 下一轮重放。
      if (i < total - 1) {
        var dug = await digWrong(bot, pos, actual);
        if (dug) out.dug = out.dug + 1;
        var at = FACE_ROTATION.indexOf(face);
        face = FACE_ROTATION[(at + 1 + FACE_ROTATION.length) % FACE_ROTATION.length];
        out.face = face;
        if (exact && typeof exact.aimAt === "function") {
          try { await exact.aimAt(bot, pos, { force: true }); } catch (eAim) { /* 视线失败继续 */ }
        }
        out.realigned = out.realigned + 1;
        logInfo("属性不符，返工 / state mismatch, rework: " + JSON.stringify(cmp.diff) + " face=" + face);
      }
    }
    out.message = "state mismatch after " + out.attempts + " attempts / 放置属性多次校验仍不符";
    return out;
  } catch (e) {
    out.message = errText(e);
    return out;
  }
}
// 节点名清单与查表接口，签名与 state-skills.js 一致，供 state-nodes 自动挂载。
var HANDLERS = { place_block_exact: placeBlockExact };
var NAMES = ["place_block_exact"];
// 判断是否有某节点；坏值返回 false。
function has(name) {
  try { return Object.prototype.hasOwnProperty.call(HANDLERS, toText(name)); } catch (e) { return false; }
}
// 取节点实现；不存在返回 null。
function pick(name) {
  try { return has(name) ? HANDLERS[toText(name)] : null; } catch (e) { return null; }
}

// 对外导出：节点表 / 名字 / 查询。
module.exports = { HANDLERS: HANDLERS, NAMES: NAMES, has: has, pick: pick };
