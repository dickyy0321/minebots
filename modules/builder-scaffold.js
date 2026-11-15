// ========================================
// 文件：modules/builder-scaffold.js
// 功能：建筑脚手架——目标方块过高时自动搭临时支撑靠近，建完自动拆除并把材料挂回供给单回收
// 依赖：./builder-blueprint（可选）、./shared-board（可选）、./event-bus（可选）、./logger（可选）
// 导出：plan / build / recycle / run / status / reset / DEFAULT_REACH / DEFAULT_BLOCK
// 作者：MineBots
// ========================================
//
// 设计 / design
//   1. 高度判定用「绝对 y 与 bot 脚底 y 的差」，超过 maxReach（默认 3 格）即判定够不着。
//   2. 每个够不着的方块在其正下方生成临时支撑块；同一坐标只生成一次，避免重复放块。
//   3. 脚手架任务优先级高于正式放置任务，拆除任务优先级最高且由建完后的 recycle 才发布。
//   4. 拆除时把支撑材料按数量挂成 supply 供给单，物流机器人可回收，材料不算丢。
// CommonJS，ES5 风格，无中文变量名；外部调用一律 try/catch，日志双语。
var blueprints = null;
try { blueprints = require("./builder-blueprint"); } catch (e) { blueprints = null; }
var sharedBoard = null;
try { sharedBoard = require("./shared-board"); } catch (e) { sharedBoard = null; }
var bus = null;
try { bus = require("./event-bus"); } catch (e) { bus = null; }
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：默认可达高度 / 临时支撑方块 / 任务优先级（脚手架 > 放置，拆除 > 脚手架）。
var DEFAULT_REACH = 3;
var DEFAULT_BLOCK = "dirt";
var PRIORITY_SCAFFOLD = 20;
var PRIORITY_TEARDOWN = 25;
var MAX_SCAFFOLD = 4000;
// 内部状态：最近一次计划与累计统计。
var lastPlan = null;
var counters = { plans: 0, built: 0, recycled: 0, blocks: 0 };

// 写文件日志：脚手架拆单属高频信息，只落文件不刷 GUI。
function logInfo(msg) {
  try { if (logger && typeof logger.info === "function") logger.info("[scaffold] " + msg); } catch (e) { /* ignore */ }
}
// 写系统日志：搭 / 拆属低频事件，推 GUI 让人看得见。
function logSystem(msg) {
  try {
    if (logger && typeof logger.system === "function") { logger.system("[scaffold] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[scaffold] " + msg); } catch (e2) { /* ignore */ }
}
// 广播脚手架事件：总线缺失时静默跳过。
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
// 安全转整数：坏值回 fallback，保证坐标不发生浮点漂移。
function toInt(value, fallback) {
  try { var n = Number(value); return (isNaN(n) || !isFinite(n)) ? fallback : Math.round(n); }
  catch (e) { return fallback; }
}
// 生成坐标键，用于支撑块去重。
function posKey(pos) {
  return toInt(pos.x, 0) + "," + toInt(pos.y, 0) + "," + toInt(pos.z, 0);
}
// 生成脚手架计划：返回 { ok, needed, scaffolds, cost, teardown, maxY, reach, jobId, message }。
function plan(blueprint, options) {
  var opts = options && typeof options === "object" ? options : {};
  var out = { ok: false, needed: 0, scaffolds: [], teardown: [], cost: {},
    maxY: 0, reach: DEFAULT_REACH, jobId: "", message: "invalid blueprint / 蓝图不可用" };
  try {
    if (!blueprint || !Array.isArray(blueprint.blocks)) return out;
    var origin = blueprint.origin || {};
    var baseY = toInt(opts.baseY === undefined ? origin.y : opts.baseY, 0);
    var reach = toInt(opts.maxReach, DEFAULT_REACH);
    if (reach < 1) reach = 1;
    if (reach > 16) reach = 16;
    var block = blueprints && typeof blueprints.cleanBlock === "function"
      ? blueprints.cleanBlock(opts.block || DEFAULT_BLOCK) : DEFAULT_BLOCK;
    if (!block) block = DEFAULT_BLOCK;
    var posOf = blueprints && typeof blueprints.absolutePos === "function"
      ? blueprints.absolutePos : null;
    var seen = {};
    var list = [];
    for (var i = 0; i < blueprint.blocks.length; i++) {
      var one = blueprint.blocks[i];
      var pos = null;
      if (posOf) pos = posOf(blueprint, one);
      else pos = { x: toInt(origin.x, 0) + toInt(one.x, 0), y: toInt(origin.y, 0) + toInt(one.y, 0), z: toInt(origin.z, 0) + toInt(one.z, 0) };
      if (pos.y > out.maxY) out.maxY = pos.y;
      if (pos.y <= baseY + reach) continue;
      // 够不着：在目标正下方搭一层可站立 / 可依附的临时支撑。
      var support = { x: pos.x, y: pos.y - 1, z: pos.z };
      var key = posKey(support);
      if (seen[key] || list.length >= MAX_SCAFFOLD) continue;
      seen[key] = true;
      list.push({ pos: support, block: block, face: "up", forBlock: toText(one.block), target: pos });
    }
    out.scaffolds = list;
    out.needed = list.length;
    out.reach = reach;
    out.cost[block] = list.length;
    out.jobId = toText(opts.jobId) || "scaffold-" + Date.now().toString(36) + "-" + (counters.plans + 1);
    for (var j = 0; j < list.length; j++) {
      out.teardown.push({ pos: list[j].pos, block: list[j].block, jobId: out.jobId });
    }
    out.ok = true;
    out.message = out.needed > 0
      ? "scaffold needed / 高处目标已生成脚手架"
      : "no scaffold needed / 目标均在可达范围内";
    lastPlan = out;
    counters.plans = counters.plans + 1;
    counters.blocks = counters.blocks + list.length;
    return out;
  } catch (e) {
    out.message = errText(e);
    return out;
  }
}
// 压入脚手架搭建任务（priority 高于正式放置，保证先搭后建）；返回 { ok, count, taskIds, message }。
function build(planData, options) {
  var opts = options && typeof options === "object" ? options : {};
  var p = planData && planData.ok ? planData : lastPlan;
  var out = { ok: false, count: 0, taskIds: [], message: "no scaffold plan / 没有脚手架计划" };
  try {
    if (!p || !Array.isArray(p.scaffolds) || p.scaffolds.length === 0) return out;
    var b = opts.board || sharedBoard;
    if (!b || typeof b.postTask !== "function") { out.message = "board unavailable / 黑板不可用"; return out; }
    for (var i = 0; i < p.scaffolds.length; i++) {
      var one = p.scaffolds[i];
      var posted = null;
      try {
        posted = b.postTask({ title: "build:scaffold", priority: PRIORITY_SCAFFOLD,
          payload: { action: "scaffold", role: "builder", jobId: p.jobId, index: i,
            pos: one.pos, block: one.block, face: "up", target: one.target } });
      } catch (ePost) { posted = null; }
      if (posted && posted.ok) out.taskIds.push(posted.taskId);
    }
    out.count = out.taskIds.length;
    out.ok = out.count > 0;
    counters.built = counters.built + out.count;
    out.message = out.ok ? "scaffold built / 脚手架已排入任务池" : "scaffold failed / 脚手架发布失败";
    logSystem("搭脚手架 / scaffold queued: " + out.count + " blocks, job=" + p.jobId);
    emit("scaffold.build", { jobId: p.jobId, count: out.count });
    return out;
  } catch (e) {
    out.message = errText(e);
    return out;
  }
}
// 建完后拆除并回收：发布拆除任务 + 把材料挂成 supply 供给单；返回 { ok, count, recycled, taskIds }。
function recycle(planData, options) {
  var opts = options && typeof options === "object" ? options : {};
  var p = planData && planData.ok ? planData : lastPlan;
  var out = { ok: false, count: 0, taskIds: [], recycled: {}, supply: null,
    message: "no scaffold plan / 没有脚手架计划" };
  try {
    if (!p || !Array.isArray(p.teardown)) return out;
    var b = opts.board || sharedBoard;
    if (!b || typeof b.postTask !== "function") { out.message = "board unavailable / 黑板不可用"; return out; }
    var recycled = {};
    for (var i = 0; i < p.teardown.length; i++) {
      var one = p.teardown[i];
      var posted = null;
      try {
        posted = b.postTask({ title: "build:teardown", priority: PRIORITY_TEARDOWN,
          payload: { action: "teardown", role: "builder", jobId: p.jobId, index: i,
            pos: one.pos, block: one.block } });
      } catch (ePost) { posted = null; }
      if (posted && posted.ok) out.taskIds.push(posted.taskId);
      recycled[one.block] = (recycled[one.block] || 0) + 1;
    }
    out.recycled = recycled;
    out.count = out.taskIds.length;
    // 材料不丢：把回收到的临时方块挂成供给单，供物流机器人取走 / 下次复用。
    if (typeof b.postSupply === "function") {
      try { out.supply = b.postSupply(opts.botId || "scaffold", recycled, opts.position || { x: 0, y: 0, z: 0 }); }
      catch (eSup) { out.supply = null; }
    }
    out.ok = true;
    counters.recycled = counters.recycled + p.teardown.length;
    out.message = "scaffold recycled / 脚手架已拆除并回收材料";
    logSystem("拆脚手架并回收 / scaffold recycled: " + out.count + " tasks");
    emit("scaffold.recycle", { jobId: p.jobId, count: out.count, recycled: recycled });
    return out;
  } catch (e) {
    out.message = errText(e);
    return out;
  }
}
// 一站式：计划 → 排队搭建 → 生成拆除回收结果；不实际等待建造完成（由战术层逐 tick 驱动）。
function run(blueprint, options) {
  var opts = options && typeof options === "object" ? options : {};
  var out = { ok: false, plan: null, build: null, recycle: null, message: "run failed / 脚手架流程失败" };
  try {
    var p = plan(blueprint, opts);
    out.plan = p;
    if (!p.ok) { out.message = p.message; return out; }
    out.build = build(p, opts);
    // 拆除计划随建造结果一起返回：建造完成后由 builder-swarm 调 recycle(plan) 真正发布任务。
    out.recycle = { ok: true, pending: p.teardown.length, message: "teardown pending / 待建完后拆除" };
    out.ok = true;
    out.message = "scaffold pipeline ready / 脚手架流程已就绪";
    return out;
  } catch (e) {
    out.message = errText(e);
    return out;
  }
}
// 状态快照：最近计划与累计统计。
function status() {
  return { ok: true, plans: counters.plans, built: counters.built, recycled: counters.recycled,
    blocks: counters.blocks, lastPlan: lastPlan ? { jobId: lastPlan.jobId, needed: lastPlan.needed, maxY: lastPlan.maxY, reach: lastPlan.reach } : null };
}
// 清空内存状态（不触碰黑板持久化任务）；供自测隔离。
function reset() {
  try { lastPlan = null; counters = { plans: 0, built: 0, recycled: 0, blocks: 0 }; }
  catch (e) { /* ignore */ }
  return { ok: true, message: "scaffold reset / 脚手架状态已重置" };
}

// 对外导出：计划 / 搭建 / 拆除回收 / 一站式 / 诊断。
module.exports = {
  plan: plan,
  build: build,
  recycle: recycle,
  run: run,
  status: status,
  reset: reset,
  DEFAULT_REACH: DEFAULT_REACH,
  DEFAULT_BLOCK: DEFAULT_BLOCK,
  PRIORITY_SCAFFOLD: PRIORITY_SCAFFOLD,
  PRIORITY_TEARDOWN: PRIORITY_TEARDOWN
};
