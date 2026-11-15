// ========================================
// 文件：modules/beacon-nav.js
// 功能：全维度信标导航——登记下界 / 末地 / 主世界传送点，规划残骸与末地城远征，
//       记录发现点建立信标，玩家一句指令就能拿到分段带路路线。
// 依赖：./logger（可选）
// 导出：registerPortal / planExpedition / recordFind / beacons / routeTo / guide /
//       commandsOf / stats / reset / DIMENSIONS
// 作者：MineBots
// ========================================
// 说明：主世界 ↔ 下界坐标按 8:1 换算；末地走要塞传送门。全程内存数据 + 双语指令，
//   不联网、不依赖真实 bot；需要真实 bot 时通过 options 注入。
// ES5 风格，CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

// 可选依赖：日志核心（只写文件）。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
// 常量：维度 / 目标 / 换算比例 / 下界残骸最佳层 / 双语引导文案。
var DIMENSIONS = ["overworld", "nether", "end"];
var NETHER_SCALE = 8;
var DEBRIS_Y = 15;
var GOALS = {
  ancient_debris: { dimension: "nether", block: "ancient_debris", y: DEBRIS_Y, label: "下界残骸 / Ancient Debris" },
  end_city: { dimension: "end", block: "end_city", y: 64, label: "末地城 / End City" },
  fortress: { dimension: "nether", block: "nether_bricks", y: 64, label: "下界要塞 / Nether Fortress" }
};
var GUIDE_HEAD = "带路开始，按信标顺序走 / Follow the beacons in order";

// 运行时：传送点 / 发现点 / 统计。
var portals = [];
var finds = [];
var totals = { portals: 0, expeditions: 0, finds: 0, guides: 0 };

// 写普通日志：只落文件，不推 GUI。
function logInfo(text) {
  try { if (logger && typeof logger.info === "function") logger.info(text); } catch (e) { /* ignore */ }
}
// 安全取错误文本。
function errText(err) {
  try { if (!err) return "unknown error"; if (err.message) return String(err.message); return String(err); } catch (e) { return "unknown error"; }
}
// 安全转字符串。
function toText(v) {
  if (v === null || v === undefined) return "";
  try { return String(v).trim(); } catch (e) { return ""; }
}
// 取坐标对象。
function pointOf(p) {
  try {
    var o = p && typeof p === "object" ? p : {};
    return { x: Number(o.x) || 0, y: Number(o.y) || 0, z: Number(o.z) || 0 };
  } catch (e) { return { x: 0, y: 0, z: 0 }; }
}
// 维度合法性检查，非法一律按主世界处理。
function dimensionOf(v) {
  var d = toText(v).toLowerCase();
  for (var i = 0; i < DIMENSIONS.length; i++) if (DIMENSIONS[i] === d) return d;
  return "overworld";
}
// 功能 1：登记一个传送点（同维度同名覆盖，避免重复信标）。
function registerPortal(botId, portal, options) {
  var out = { ok: false, portal: null, message: "" };
  try {
    var p = portal && typeof portal === "object" ? portal : null;
    if (!p) { out.message = "portal required / 缺少传送点"; return out; }
    var name = toText(p.name) || "portal-" + (portals.length + 1);
    var rec = { name: name, dimension: dimensionOf(p.dimension), pos: pointOf(p.pos || p),
      botId: toText(botId) || "default", at: Date.now(), kind: "portal" };
    for (var i = 0; i < portals.length; i++) {
      if (portals[i].name === name && portals[i].dimension === rec.dimension) { portals[i] = rec; break; }
    }
    if (i >= portals.length) portals.push(rec);
    totals.portals = totals.portals + 1;
    out.ok = true; out.portal = rec;
    out.message = "portal registered / 传送点已登记";
    logInfo("[beacon-nav] " + rec.dimension + " " + name);
    return out;
  } catch (e) { out.message = errText(e); return out; }
}
// 维度换算：主世界 → 下界除 8，下界 → 主世界乘 8。
function convert(pos, from, to) {
  var p = pointOf(pos);
  if (from === "overworld" && to === "nether") return { x: Math.floor(p.x / NETHER_SCALE), y: p.y, z: Math.floor(p.z / NETHER_SCALE) };
  if (from === "nether" && to === "overworld") return { x: p.x * NETHER_SCALE, y: p.y, z: p.z * NETHER_SCALE };
  return p;
}
// 找某维度的传送点。
function portalIn(dimension) {
  for (var i = 0; i < portals.length; i++) if (portals[i].dimension === dimension) return portals[i];
  return null;
}
// 功能 2：规划远征——给出维度、目标方块、推荐高度与跨维度传送段。
function planExpedition(goal, options) {
  var out = { ok: false, goal: toText(goal), dimension: "", block: "", y: 0,
    legs: [], message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var key = toText(goal).toLowerCase();
    var spec = GOALS[key] || null;
    if (!spec) {
      for (var g in GOALS) {
        if (Object.prototype.hasOwnProperty.call(GOALS, g) && key.indexOf(g) >= 0) { spec = GOALS[g]; key = g; break; }
      }
    }
    if (!spec) { out.message = "unknown expedition goal / 未知远征目标"; return out; }
    out.dimension = spec.dimension;
    out.block = spec.block;
    out.y = spec.y;
    var base = pointOf(opts.origin || { x: 0, y: 64, z: 0 });
    var home = portalIn("overworld");
    if (home) out.legs.push({ step: 1, kind: "portal", dimension: "overworld", pos: home.pos,
      text: "先到主世界传送门 / Go to the overworld portal: " + home.name });
    if (spec.dimension === "nether") {
      out.legs.push({ step: out.legs.length + 1, kind: "convert", dimension: "nether",
        pos: convert(base, "overworld", "nether"),
        text: "坐标按 8:1 换算进下界 / Coordinates scale 8:1 into the Nether" });
    } else {
      out.legs.push({ step: out.legs.length + 1, kind: "portal", dimension: "end",
        pos: pointOf({ x: 0, y: 64, z: 0 }), text: "走要塞传送门进末地 / Enter the End through the stronghold portal" });
    }
    out.legs.push({ step: out.legs.length + 1, kind: "search", dimension: spec.dimension,
      pos: { x: 0, y: spec.y, z: 0 }, text: "搜索 " + spec.label + " / Search for " + spec.label });
    totals.expeditions = totals.expeditions + 1;
    out.ok = true;
    out.message = "expedition planned / 远征路线已规划";
    return out;
  } catch (e) { out.message = errText(e); return out; }
}
// 功能 3：记录找到的目标，自动在该位置立信标。
function recordFind(botId, find, options) {
  var out = { ok: false, beacon: null, message: "" };
  try {
    var f = find && typeof find === "object" ? find : null;
    if (!f) { out.message = "find required / 缺少发现点"; return out; }
    var rec = { name: toText(f.name) || "beacon-" + (finds.length + 1),
      dimension: dimensionOf(f.dimension), pos: pointOf(f.pos || f),
      block: toText(f.block) || "beacon", botId: toText(botId) || "default",
      at: Date.now(), kind: "beacon" };
    finds.push(rec);
    totals.finds = totals.finds + 1;
    out.ok = true; out.beacon = rec;
    out.message = "beacon placed / 信标已建立";
    return out;
  } catch (e) { out.message = errText(e); return out; }
}
// 功能 4：列出全部信标（可按维度过滤）。
function beacons(dimension, options) {
  var d = toText(dimension);
  var out = [];
  for (var i = 0; i < finds.length; i++) if (d.length === 0 || finds[i].dimension === d) out.push(finds[i]);
  return out;
}
// 功能 5：拼一条分段带路路线（主世界门 → 目标维度门 → 信标 → 终点）。
function routeTo(botId, target, options) {
  var out = { ok: true, legs: [], message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var t = target && typeof target === "object" ? target : {};
    var dim = dimensionOf(t.dimension || opts.dimension);
    var home = portalIn("overworld");
    if (home) out.legs.push({ step: 1, kind: "portal", dimension: "overworld", pos: home.pos,
      text: "主世界传送门 / Overworld portal: " + home.name });
    var gate = portalIn(dim);
    if (gate && dim !== "overworld") out.legs.push({ step: out.legs.length + 1, kind: "portal",
      dimension: dim, pos: gate.pos, text: dim + " 传送点 / " + dim + " portal: " + gate.name });
    var marks = beacons(dim, {});
    for (var i = 0; i < marks.length; i++) out.legs.push({ step: out.legs.length + 1, kind: "beacon",
      dimension: dim, pos: marks[i].pos, text: "信标 / Beacon: " + marks[i].name });
    if (t.pos) out.legs.push({ step: out.legs.length + 1, kind: "target", dimension: dim,
      pos: pointOf(t.pos), text: "终点 / Destination" });
    totals.guides = totals.guides + 1;
    out.message = "route ready / 带路路线已生成";
    return out;
  } catch (e) { out.ok = false; out.message = errText(e); return out; }
}
// 功能 6：把路线转成可执行的 #goto 指令流（双语注释）。
function commandsOf(route, options) {
  var out = [];
  try {
    var legs = route && Array.isArray(route.legs) ? route.legs : [];
    for (var i = 0; i < legs.length; i++) {
      var p = pointOf(legs[i].pos);
      out.push("#goto " + p.x + " " + p.y + " " + p.z + "  # " + legs[i].text);
    }
  } catch (e) { return []; }
  return out;
}
// 功能 7：公屏双语带路（bot 可选注入，缺失时只返回文案）。
function guide(botId, target, options) {
  var out = { ok: true, text: "", legs: [], commands: [], message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var route = routeTo(botId, target, opts);
    out.legs = route.legs;
    out.commands = commandsOf(route, opts);
    out.text = GUIDE_HEAD + "：" + route.legs.length + " 段 / " + route.legs.length + " legs";
    try { if (opts.bot && typeof opts.bot.chat === "function") opts.bot.chat(out.text); } catch (eChat) { /* ignore */ }
    out.message = "guide sent / 带路指令已发出";
    return out;
  } catch (e) { out.ok = false; out.message = errText(e); return out; }
}
// 功能 8：统计快照。
function stats() {
  return { ok: true, portals: portals.length, beacons: finds.length,
    dimensions: DIMENSIONS.slice(0), scale: NETHER_SCALE,
    planned: totals.expeditions, found: totals.finds, guided: totals.guides };
}
// 功能 9：复位全部传送点与信标。
function reset() {
  portals = []; finds = [];
  totals = { portals: 0, expeditions: 0, finds: 0, guides: 0 };
  return { ok: true, message: "beacon nav reset / 信标导航已复位" };
}
// 对外导出。
module.exports = {
  registerPortal: registerPortal, planExpedition: planExpedition, recordFind: recordFind,
  beacons: beacons, routeTo: routeTo, guide: guide, commandsOf: commandsOf,
  stats: stats, reset: reset, DIMENSIONS: DIMENSIONS, GOALS: GOALS
};
