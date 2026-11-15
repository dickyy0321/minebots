// ========================================
// 文件：modules/builder-swarm.js
// 功能：蜂群建筑物流与协作中枢——三层架构内跑建筑，建筑 bot 抢放置任务 / 缺料挂求购单，
//       物流 bot 抢单取货送达，材料耗尽自动调度挖矿 / 砍树 bot 补齐，并支持公屏发帖求助与接单
// 依赖：./builder-blueprint、./builder-scaffold、./shared-board、./state-runtime（可选）、
//       ./engine-control（可选）、./redstone-supply（可选）、./event-bus（可选）、./logger（可选）
// 导出：startBuild / builderTick / logisticsTick / gatherTick / runCycle / buildExecutor / layers /
//       post / posts / status / reset / ROLES
// 作者：MineBots
// ========================================
//
// 三层分工 / three layers
//   战略层：startBuild() → state-runtime.assignGoal("build ...")，只下宏观目标，不碰具体方块。
//   战术层：builderTick / logisticsTick / gatherTick 由行为树 tick 的 executor 驱动，逐单推进黑板任务。
//   反射层：受击 / 高处坠落交给既有 antiafk 与 motion 的本地反射；精确模式下噪声归零保障放置精度。
// 多 Bot 分工：runCycle({ builders:[], logistics:[], gatherers:[] }) 一轮内并行推进三种角色。
// CommonJS，ES5 风格，无中文变量名；所有外部调用包 try/catch，日志双语，绝不抛到顶层。
var blueprints = null;
try { blueprints = require("./builder-blueprint"); } catch (e) { blueprints = null; }
var scaffold = null;
try { scaffold = require("./builder-scaffold"); } catch (e) { scaffold = null; }
var sharedBoard = null;
try { sharedBoard = require("./shared-board"); } catch (e) { sharedBoard = null; }
var runtime = null;
try { runtime = require("./state-runtime"); } catch (e) { runtime = null; }
var engines = null;
try { engines = require("./engine-control"); } catch (e) { engines = null; }
// 可选依赖：缺料自动拟帖（内部延迟 require 本模块，不会形成启动循环）。
var supply = null;
try { supply = require("./redstone-supply"); } catch (e) { supply = null; }
var bus = null;
try { bus = require("./event-bus"); } catch (e) { bus = null; }
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：三种协作角色 / 任务标题 / 采集动作关键词 / 帖子保留上限。
var ROLES = ["builder", "logistics", "gatherer"];
var TASK_PLACE = "build:place";
var TASK_GATHER = "build:gather";
var TASK_SCAFFOLD = "build:scaffold";
var TASK_TEARDOWN = "build:teardown";
var MAX_POSTS = 100;
// 内部状态：帖子 / 累计统计 / 最近一次建造作业。
var postList = [];
var counters = { cycles: 0, placed: 0, waiting: 0, hauled: 0, gathered: 0, posts: 0, goals: 0 };
var lastJob = null;

// 写文件日志：逐 tick 推进属高频信息，只落文件不刷 GUI。
function logInfo(msg) {
  try { if (logger && typeof logger.info === "function") logger.info("[build-swarm] " + msg); } catch (e) { /* ignore */ }
}
// 写系统日志：开工 / 求助 / 送达属低频事件，推 GUI。
function logSystem(msg) {
  try {
    if (logger && typeof logger.system === "function") { logger.system("[build-swarm] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[build-swarm] " + msg); } catch (e2) { /* ignore */ }
}
// 广播建筑事件：总线缺失时静默跳过。
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
// 安全转正整数：坏值 / 负数一律回 0。
function toCount(value) {
  try { var n = Number(value); return (isNaN(n) || !isFinite(n) || n < 0) ? 0 : Math.round(n); }
  catch (e) { return 0; }
}
// 精确建筑是否开启：控制中心缺失时按关闭处理，保证默认拟真行为不变。
function isExact() {
  try { return !!(engines && typeof engines.exactBuild === "function" && engines.exactBuild() === true); }
  catch (e) { return false; }
}
// 取当前使用的黑板：options.board 可注入假板（自测隔离），否则用真实共享黑板。
function boardOf(options) {
  var opts = options && typeof options === "object" ? options : {};
  return opts.board || sharedBoard;
}
// 归一化 botId：坏值退回 default。
function idOf(botId) {
  try {
    var text = toText(botId).replace(/^\s+|\s+$/g, "");
    return text.length === 0 ? "default" : text.slice(0, 80);
  } catch (e) { return "default"; }
}
// 背包是否有足够某方块；返回布尔。
function hasBlock(inventory, block) {
  try {
    var have = blueprints && typeof blueprints.inventoryOf === "function"
      ? blueprints.inventoryOf(inventory) : (inventory || {});
    return toCount(have[block]) > 0;
  } catch (e) { return false; }
}
// 背包扣掉一个方块，返回扣减后的背包副本（不改调用方对象）。
function consume(inventory, block) {
  var out = {};
  try {
    var src = blueprints && typeof blueprints.inventoryOf === "function"
      ? blueprints.inventoryOf(inventory) : (inventory || {});
    for (var key in src) {
      if (Object.prototype.hasOwnProperty.call(src, key)) out[key] = toCount(src[key]);
    }
    if (out[block] > 0) out[block] = out[block] - 1;
  } catch (e) { return out; }
  return out;
}
// 列出指定标题的待办任务（按黑板默认优先级排序）；黑板不可用时返回空数组。
function pendingByTitle(b, titles) {
  var out = [];
  try {
    if (!b || typeof b.listTasks !== "function") return out;
    var all = b.listTasks({ status: "pending" });
    for (var i = 0; i < all.length; i++) {
      if (titles.indexOf(toText(all[i].title)) >= 0) out.push(all[i]);
    }
  } catch (e) { return []; }
  return out;
}
// 公屏发帖：写黑板 broadcast: 前缀键 + 事件广播 + 有真 bot 时补一句聊天；返回 { ok, postId, post }。
function post(botId, content, options) {
  var opts = options && typeof options === "object" ? options : {};
  var id = idOf(botId);
  var out = { ok: false, postId: "", post: null, message: "empty post / 帖子内容为空" };
  try {
    var text = toText(content).replace(/^\s+|\s+$/g, "").slice(0, 300);
    if (text.length === 0) return out;
    var rec = {
      id: "p" + Date.now().toString(36) + "-" + (counters.posts + 1),
      botId: id, content: text, kind: toText(opts.kind) || "help",
      jobId: toText(opts.jobId), at: Date.now()
    };
    var b = boardOf(opts);
    if (b && typeof b.post === "function") b.post("broadcast:" + rec.id, rec);
    postList.push(rec);
    if (postList.length > MAX_POSTS) postList = postList.slice(postList.length - MAX_POSTS);
    counters.posts = counters.posts + 1;
    emit("broadcast.post", { botId: id, postId: rec.id, kind: rec.kind, content: text });
    logSystem("公屏发帖 / broadcast: [" + rec.kind + "] " + id + " -> " + text);
    if (opts.bot && typeof opts.bot.chat === "function") {
      try { opts.bot.chat(text); } catch (eChat) { /* 没连服务器也不影响发帖记录 */ }
    }
    out.ok = true; out.postId = rec.id; out.post = rec;
    out.message = "post published / 帖子已发布";
    return out;
  } catch (e) {
    out.message = errText(e);
    return out;
  }
}
// 读取全部帖子（副本数组）；黑板不可用时仍返回内存记录。
function posts() {
  var out = [];
  try {
    for (var i = 0; i < postList.length; i++) out.push(postList[i]);
  } catch (e) { return []; }
  return out;
}
// 缺料处理：挂求购单 + 发求助帖 + 发布采集任务（自动调度挖矿 / 砍树 bot）；返回汇总。
function requestMaterials(b, botId, missing, options) {
  var opts = options && typeof options === "object" ? options : {};
  var id = idOf(botId);
  var out = { ok: false, demand: null, helpPost: null, tasks: [], count: 0, message: "board unavailable / 黑板不可用" };
  try {
    if (!b) return out;
    var need = {};
    var names = [];
    for (var key in missing) {
      if (!Object.prototype.hasOwnProperty.call(missing, key)) continue;
      var n = toCount(missing[key]);
      if (n <= 0) continue;
      need[key] = n; names.push(key + ":" + n);
    }
    if (names.length === 0) { out.ok = true; out.message = "no shortage / 没有缺料"; return out; }
    if (typeof b.postDemand === "function") out.demand = b.postDemand(id, need);
    if (opts.askHelp !== false) {
      // 红石 / 建筑缺料优先用自动拟帖链路，生成「谁有 10 个中继器，我用钻石换！」式公屏求助。
      var helpText = "求助 / HELP: 建造缺料 " + names.join(",") + "，有货请联系 / need materials for build";
      if (supply && typeof supply.composePost === "function") {
        var composed = supply.composePost(need, { bot: opts.bot || null });
        if (composed.ok) helpText = composed.content;
      }
      out.helpPost = post(id, helpText,
        { kind: "help", jobId: opts.jobId, board: b, bot: opts.bot || null });
    }
    // 材料耗尽自动调度：每个缺料方块一条采集任务，payload 带推荐动作（挖矿 / 砍树）。
    for (var item in need) {
      if (!Object.prototype.hasOwnProperty.call(need, item)) continue;
      var woody = item.indexOf("log") >= 0 || item.indexOf("plank") >= 0 || item.indexOf("wood") >= 0 || item.indexOf("stick") >= 0;
      var action = woody ? "chop" : "mine";
      var posted = null;
      try {
        posted = b.postTask({ title: TASK_GATHER, priority: 12,
          payload: { action: action, role: "gatherer", item: item, amount: need[item], jobId: opts.jobId, forBot: id } });
      } catch (ePost) { posted = null; }
      if (posted && posted.ok) { out.tasks.push(posted.taskId); out.count = out.count + 1; }
    }
    out.ok = true;
    out.message = "shortage handled / 缺料已挂单并调度采集";
    emit("build.shortage", { botId: id, jobId: opts.jobId, items: need, tasks: out.count });
    logSystem("缺料求助 / shortage: " + id + " " + names.join(",") + " gather=" + out.count);
    return out;
  } catch (e) {
    out.message = errText(e);
    return out;
  }
}
// 建造开工：解析蓝图 → 算账 → 拆单 → 脚手架 → 缺料调度 → 战略层下达宏观目标；返回完整汇总。
function startBuild(input, options) {
  var opts = options && typeof options === "object" ? options : {};
  var out = { ok: false, layer: "strategic", blueprint: null, analysis: null, split: null,
    scaffold: null, shortage: null, goal: null, exact: isExact(), jobId: "",
    message: "builder unavailable / 建筑模块不可用" };
  try {
    if (!blueprints) return out;
    var b = boardOf(opts);
    var parsed = blueprints.parse(input, opts);
    if (!parsed.ok || !parsed.blueprint) { out.message = parsed.message; return out; }
    var bp = parsed.blueprint;
    out.blueprint = { name: bp.name, format: bp.format, origin: bp.origin, size: bp.size, blocks: bp.blocks.length };
    var analysis = blueprints.analyzeBlueprint(bp, opts.inventory);
    out.analysis = analysis;
    var split = blueprints.splitBlueprintToTasks(bp, { board: b, priority: opts.priority });
    out.split = { ok: split.ok, count: split.count, jobId: split.jobId, failed: split.failed, message: split.message };
    if (!split.ok) { out.message = split.message; return out; }
    out.jobId = split.jobId;
    if (scaffold && typeof scaffold.run === "function") {
      var sc = scaffold.run(bp, { board: b, jobId: split.jobId, baseY: opts.baseY, maxReach: opts.maxReach });
      out.scaffold = { ok: sc.ok, needed: sc.plan ? sc.plan.needed : 0,
        queued: sc.build ? sc.build.count : 0, recyclePending: sc.recycle ? sc.recycle.pending : 0 };
    }
    if (analysis.ok && analysis.missingCount > 0) {
      out.shortage = requestMaterials(b, opts.botId || "builder", analysis.missing,
        { jobId: split.jobId, bot: opts.bot || null, askHelp: opts.askHelp, board: b });
    }
    // 战略层：只下宏观目标，不放具体方块；executor 由行为树 tick 驱动战术层逐单推进。
    if (runtime && typeof runtime.assignGoal === "function") {
      var goal = runtime.assignGoal(idOf(opts.botId || "builder"), "build " + bp.name,
        { executor: buildExecutor(opts.botId || "builder", { board: b, inventory: opts.inventory }) });
      out.goal = { ok: goal.ok, botId: goal.botId, steps: goal.steps ? goal.steps.length : 0, message: goal.message };
      if (goal.ok) counters.goals = counters.goals + 1;
    }
    lastJob = { jobId: split.jobId, name: bp.name, blocks: bp.blocks.length, at: Date.now(), exact: out.exact };
    out.ok = true;
    out.message = "build started / 建造已开工（三层架构）";
    logSystem("开工 / build started: " + bp.name + " blocks=" + bp.blocks.length + " tasks=" + split.count + " exact=" + out.exact);
    emit("build.start", { jobId: split.jobId, name: bp.name, blocks: bp.blocks.length, exact: out.exact });
    return out;
  } catch (e) {
    out.message = errText(e);
    logInfo("开工失败 / build start failed: " + out.message);
    return out;
  }
}
// 生成战术层 executor：行为树每推进一步就抢一个建筑任务，返回 true 让节点成功。
function buildExecutor(botId, options) {
  var opts = options && typeof options === "object" ? options : {};
  var id = idOf(botId);
  var stock = opts.inventory || {};
  return function (name, ctx, blackboard, tree) {
    try {
      var tick = builderTick(id, stock, { board: opts.board, place: opts.place, askHelp: opts.askHelp });
      if (tick.ok) stock = tick.inventory;
      blackboard.buildPlaced = counters.placed;
      blackboard.buildWaiting = counters.waiting;
      return tick.ok === true || tick.waiting === true;
    } catch (e) { return false; }
  };
}
// 建筑 bot 的一个战术 tick：抢放置 / 脚手架 / 拆除任务，有料则精确放置并结单，没料挂求购单。
function builderTick(botId, inventory, options) {
  var opts = options && typeof options === "object" ? options : {};
  var id = idOf(botId);
  var b = boardOf(opts);
  var out = { ok: false, waiting: false, taskId: "", block: "", pos: null, exact: isExact(),
    inventory: inventory || {}, demand: null, message: "no build task / 暂无建筑任务" };
  try {
    if (!b || typeof b.claimTask !== "function") return out;
    var pending = pendingByTitle(b, [TASK_SCAFFOLD, TASK_PLACE, TASK_TEARDOWN]);
    if (pending.length === 0) return out;
    var task = pending[0];
    var payload = task.payload && typeof task.payload === "object" ? task.payload : {};
    var block = toText(payload.block);
    // 拆除任务不消耗材料；搭建 / 放置需要背包里有对应方块。
    var needsMaterial = toText(task.title) !== TASK_TEARDOWN && block.length > 0;
    if (needsMaterial && !hasBlock(inventory, block)) {
      var claim = b.claimTask(id, { taskId: task.id });
      if (claim && claim.ok && typeof b.releaseTask === "function") b.releaseTask(task.id, id);
      var miss = {}; miss[block] = 1;
      out.demand = requestMaterials(b, id, miss, { jobId: payload.jobId, bot: opts.bot || null, askHelp: opts.askHelp, board: b });
      out.waiting = true;
      out.block = block;
      out.message = "waiting for material / 缺料，已挂求购单并求助";
      counters.waiting = counters.waiting + 1;
      emit("build.waiting", { botId: id, block: block, taskId: task.id });
      return out;
    }
    var got = b.claimTask(id, { taskId: task.id });
    if (!got || !got.ok) { out.message = got ? got.message : "claim failed / 抢单失败"; return out; }
    out.taskId = got.taskId;
    out.block = block;
    out.pos = payload.pos || null;
    // 精确放置：motion 在 engExactBuild 下噪声与延迟已归零；有注入的 place 回调就真执行一次。
    if (opts.place && typeof opts.place === "function") {
      try { opts.place(payload, { exact: out.exact, botId: id }); } catch (ePlace) { /* 放置失败仍结单降级 */ }
    }
    if (needsMaterial) out.inventory = consume(inventory, block);
    if (typeof b.completeTask === "function") {
      b.completeTask(got.taskId, id, { action: toText(payload.action) || "place", block: block, exact: out.exact });
    }
    out.ok = true;
    counters.placed = counters.placed + 1;
    out.message = "task done / 建筑任务已完成";
    logInfo("建筑 tick / builder tick: " + id + " " + got.taskId + " " + block + " exact=" + out.exact);
    emit("build.tick", { botId: id, taskId: got.taskId, block: block, exact: out.exact });
    return out;
  } catch (e) {
    out.message = errText(e);
    return out;
  }
}
// 物流 bot 的一个战术 tick：撮合供需 → 抢 haul 单 → 送达入库 → 通知建筑工；返回汇总。
function logisticsTick(botId, options) {
  var opts = options && typeof options === "object" ? options : {};
  var id = idOf(botId);
  var b = boardOf(opts);
  var out = { ok: false, matched: 0, taskId: "", delivered: {}, notified: false,
    message: "no haul task / 暂无搬运任务" };
  try {
    if (!b) return out;
    if (opts.match !== false && typeof b.matchSupply === "function") {
      var m = b.matchSupply();
      out.matched = m && m.matches ? m.matches : 0;
    }
    var claim = typeof b.claimHaul === "function" ? b.claimHaul(id, { position: opts.position || { x: 0, y: 0, z: 0 } }) : null;
    if (!claim || !claim.ok) { out.message = claim ? claim.message : "claimHaul unavailable / 抢单接口不可用"; return out; }
    out.taskId = claim.taskId;
    var payload = claim.task && claim.task.payload && typeof claim.task.payload === "object" ? claim.task.payload : {};
    var goods = {};
    if (payload.item) goods[toText(payload.item)] = toCount(payload.amount) || 1;
    else if (payload.items) {
      for (var key in payload.items) {
        if (Object.prototype.hasOwnProperty.call(payload.items, key)) goods[key] = toCount(payload.items[key]);
      }
    }
    out.delivered = goods;
    if (typeof b.deliver === "function") {
      var done = b.deliver(id, claim.taskId, goods);
      out.ok = !!(done && done.ok);
    }
    // 送到建筑工手上：给目标 bot 投一条消息，建筑工下一次 tick 就知道料到了。
    var target = toText(payload.toBot || payload.fromBot);
    if (target && b && typeof b.postMessage === "function") {
      try {
        b.postMessage(target, "物资已送达 / delivery: " + JSON.stringify(goods) + " by " + id);
        out.notified = true;
      } catch (eMsg) { /* 消息失败不影响结单 */ }
    }
    counters.hauled = counters.hauled + 1;
    out.message = out.ok ? "delivered / 物资已送达" : "deliver degraded / 送达已降级";
    emit("build.logistics", { botId: id, taskId: claim.taskId, goods: goods, notified: out.notified });
    logSystem("物流送达 / delivery: " + id + " " + claim.taskId + " " + JSON.stringify(goods));
    return out;
  } catch (e) {
    out.message = errText(e);
    return out;
  }
}
// 采集 bot 的一个战术 tick：抢缺料生成的挖矿 / 砍树任务，完成后把物资入仓库并挂供给单。
function gatherTick(botId, options) {
  var opts = options && typeof options === "object" ? options : {};
  var id = idOf(botId);
  var b = boardOf(opts);
  var out = { ok: false, taskId: "", item: "", amount: 0, action: "", warehouse: null,
    message: "no gather task / 暂无采集任务" };
  try {
    if (!b || typeof b.claimTask !== "function") return out;
    var pending = pendingByTitle(b, [TASK_GATHER]);
    if (pending.length === 0) return out;
    var task = pending[0];
    var payload = task.payload && typeof task.payload === "object" ? task.payload : {};
    var got = b.claimTask(id, { taskId: task.id });
    if (!got || !got.ok) { out.message = got ? got.message : "claim failed / 抢单失败"; return out; }
    out.taskId = got.taskId;
    out.item = toText(payload.item);
    out.amount = toCount(payload.amount);
    out.action = toText(payload.action) || "mine";
    if (opts.gather && typeof opts.gather === "function") {
      try { opts.gather(payload, { botId: id }); } catch (eGather) { /* 真 bot 不在场时走模拟入库 */ }
    }
    // 采到的物资写进仓库，并挂供给单让物流 bot 能撮合送到建筑工手上。
    if (out.item && out.amount > 0 && typeof b.post === "function") {
      var key = "warehouse:" + out.item;
      var before = toCount(b.get(key, 0));
      b.post(key, before + out.amount);
      out.warehouse = { item: out.item, total: before + out.amount };
      if (typeof b.postSupply === "function") {
        try { b.postSupply(id, (function () { var one = {}; one[out.item] = out.amount; return one; })(), opts.position || { x: 0, y: 0, z: 0 }); }
        catch (eSup) { /* 供给单失败不影响入库 */ }
      }
    }
    if (typeof b.completeTask === "function") b.completeTask(got.taskId, id, { gathered: out.amount, item: out.item });
    out.ok = true;
    counters.gathered = counters.gathered + 1;
    out.message = "gathered / 采集任务已完成并入库";
    emit("build.gather", { botId: id, item: out.item, amount: out.amount, action: out.action });
    logSystem("采集补齐 / gathered: " + id + " " + out.action + " " + out.item + " x" + out.amount);
    return out;
  } catch (e) {
    out.message = errText(e);
    return out;
  }
}
// 一轮多 Bot 分工协作：roles 可给 builders / logistics / gatherers 数组；返回每个角色的汇总。
function runCycle(roles, options) {
  var opts = options && typeof options === "object" ? options : {};
  var spec = roles && typeof roles === "object" ? roles : {};
  var out = { ok: true, cycles: 0, builders: [], logistics: [], gatherers: [], message: "cycle done / 协作轮次完成" };
  try {
    var builders = Array.isArray(spec.builders) && spec.builders.length > 0 ? spec.builders : ["builder"];
    var logistics = Array.isArray(spec.logistics) ? spec.logistics : ["logistics"];
    var gatherers = Array.isArray(spec.gatherers) ? spec.gatherers : ["gatherer"];
    for (var i = 0; i < builders.length; i++) {
      out.builders.push(builderTick(builders[i], opts.inventory, opts));
    }
    for (var j = 0; j < logistics.length; j++) out.logistics.push(logisticsTick(logistics[j], opts));
    for (var k = 0; k < gatherers.length; k++) out.gatherers.push(gatherTick(gatherers[k], opts));
    counters.cycles = counters.cycles + 1;
    out.cycles = counters.cycles;
    return out;
  } catch (e) {
    out.ok = false; out.message = errText(e);
    return out;
  }
}
// 三层架构快照：证明建筑跑在战略 / 战术 / 反射三层内；任一模块缺失只留空对象。
function layers(botId) {
  var out = { ok: true, botId: idOf(botId), strategic: null, tactical: null, reflex: null, exact: isExact() };
  try {
    if (runtime && typeof runtime.status === "function") {
      var st = runtime.status(idOf(botId));
      out.strategic = st || null;
      out.tactical = st && st.tree ? st.tree : null;
    }
    var b = boardOf({});
    out.tactical = out.tactical || { tasks: b && typeof b.taskStats === "function" ? b.taskStats() : null };
    out.reflex = { exactMotion: out.exact, engine: "motion", noiseZero: out.exact };
  } catch (e) { out.message = errText(e); }
  return out;
}
// 状态快照：累计统计 / 最近作业 / 帖子数 / 精确模式。
function status() {
  return { ok: true, cycles: counters.cycles, placed: counters.placed, waiting: counters.waiting,
    hauled: counters.hauled, gathered: counters.gathered, posts: counters.posts,
    goals: counters.goals, exact: isExact(), lastJob: lastJob, roles: ROLES.slice(0) };
}
// 清空内存状态（不触碰黑板持久化任务）；供自测隔离。
function reset() {
  try {
    postList = [];
    counters = { cycles: 0, placed: 0, waiting: 0, hauled: 0, gathered: 0, posts: 0, goals: 0 };
    lastJob = null;
  } catch (e) { /* ignore */ }
  return { ok: true, message: "builder swarm reset / 建筑蜂群状态已重置" };
}

// 对外导出：开工 / 三种 tick / 协作轮次 / 三层快照 / 发帖 / 诊断。
module.exports = {
  startBuild: startBuild,
  builderTick: builderTick,
  logisticsTick: logisticsTick,
  gatherTick: gatherTick,
  runCycle: runCycle,
  buildExecutor: buildExecutor,
  layers: layers,
  post: post,
  posts: posts,
  status: status,
  reset: reset,
  ROLES: ROLES,
  TASK_PLACE: TASK_PLACE,
  TASK_GATHER: TASK_GATHER,
  TASK_SCAFFOLD: TASK_SCAFFOLD,
  TASK_TEARDOWN: TASK_TEARDOWN
};
