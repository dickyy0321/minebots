// ========================================
// 文件：modules/swarm-market.js
// 功能：蜂群生态循环——demand / supply 挂单撮合、大任务拆单竞价、满包挂单搬运入库、生态状态统计
// 依赖：./shared-board（延迟加载，避免循环 require）、./event-bus（可选）、./logger（可选）
// 导出：setBoard / registerBot / postDemand / postSupply / listDemand / listSupply / matchSupply /
//       postBigTask / scoreTask / bid / runAuction / onInventoryFull / claimHaul / deliver /
//       ecosystem / reset / MAX_TASK_SPLIT
// 作者：MineBots
// ========================================
//
// 生态闭环 / ecology loop
//   bot-1: need { wood: 10 }  → demand 挂单
//   bot-2: offer { wood: 64 } → supply 挂单（背包满自动挂）→ match 生成 haul 搬运任务
//   空闲 bot 按「任务优先级 - 距离 - 自身负载」竞价抢单 → 取货 → deliver 存入基地仓库
// 任务全部落在 shared-board 的 task: 分片里，认领是单线程内无 await 的原子操作。
// ES5 风格，CommonJS，无中文变量名；所有对外函数返回带 ok 的对象。
var bus = null;
try { bus = require("./event-bus"); } catch (e) { bus = null; }

var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：黑板键前缀 / 大任务拆单上限。
var DEMAND_PREFIX = "demand:";
var SUPPLY_PREFIX = "supply:";
var WAREHOUSE_PREFIX = "warehouse:";
var MAX_TASK_SPLIT = 200;

// 状态：可注入的 board（自测隔离）/ bot 状态表 / 统计。
var injectedBoard = null;
var botStates = {};
var counters = { auctions: 0, bids: 0, deliveries: 0, matches: 0 };

// 取黑板：注入优先；延迟 require 避免 shared-board 加载本文件时的循环依赖。
function board() {
  if (injectedBoard) return injectedBoard;
  try { return require("./shared-board"); } catch (e) { return null; }
}

// 写文件日志：竞价属高频信息，只落文件，绝不刷 GUI。
function logInfo(msg) {
  try { if (logger && typeof logger.info === "function") logger.info("[swarm-market] " + msg); } catch (e) { /* ignore */ }
}

// 写系统日志：挂单、撮合、入库是低频事件，推 GUI。
function logSystem(msg) {
  try {
    if (logger && typeof logger.system === "function") { logger.system("[swarm-market] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[swarm-market] " + msg); } catch (e2) { /* ignore */ }
}

// 广播生态事件：总线缺失时静默跳过。
function emit(name, payload) {
  try { if (bus && typeof bus.emit === "function") bus.emit(name, payload); } catch (e) { /* ignore */ }
}

// 安全取错误文本。
function errText(err) {
  try { if (err && err.message) return String(err.message); return String(err); }
  catch (e) { return "unknown error"; }
}

// 规范化 botId，坏值返回空串。
function cleanId(value) {
  try {
    var text = String(value === null || value === undefined ? "" : value).replace(/^\s+|\s+$/g, "");
    return text.length === 0 ? "" : text.slice(0, 80);
  } catch (e) { return ""; }
}

// 深拷贝纯数据，坏值返回空对象。
function clone(value) {
  try {
    var out = JSON.parse(JSON.stringify(value === undefined ? null : value));
    return out && typeof out === "object" ? out : {};
  } catch (e) { return {}; }
}

// 把物资表洗成 { item: 正数 }，坏值丢弃。
function normalizeItems(items) {
  var out = {};
  try {
    if (!items || typeof items !== "object") return out;
    for (var key in items) {
      if (!Object.prototype.hasOwnProperty.call(items, key)) continue;
      var n = Number(items[key]);
      if (!isNaN(n) && n > 0) out[String(key).slice(0, 40)] = n;
    }
  } catch (e) { return {}; }
  return out;
}

// 两点之间的水平距离；坐标缺失按 0 处理。
function distanceOf(a, b) {
  try {
    var ax = Number(a && a.x) || 0;
    var az = Number(a && a.z) || 0;
    var bx = Number(b && b.x) || 0;
    var bz = Number(b && b.z) || 0;
    return Math.sqrt((ax - bx) * (ax - bx) + (az - bz) * (az - bz));
  } catch (e) { return 0; }
}

// 功能：注入一个 board 实现（自测隔离 / 嵌入用）；传 null 恢复使用真实 shared-board。
function setBoard(custom) {
  injectedBoard = custom || null;
  return { ok: true, injected: injectedBoard !== null, message: "board set / 黑板已注入" };
}

// 功能：登记或更新一个 bot 的竞价状态 { position, load, status }，坏值补默认。
function registerBot(botId, state) {
  var id = cleanId(botId);
  if (id.length === 0) return { ok: false, botId: "", message: "botId required / 缺少 botId" };
  try {
    var body = state && typeof state === "object" ? state : {};
    botStates[id] = {
      botId: id,
      position: clone(body.position || { x: 0, y: 0, z: 0 }),
      load: Number(body.load) > 0 ? Number(body.load) : 0,
      status: String(body.status || "idle")
    };
    return { ok: true, botId: id, state: clone(botStates[id]), message: "bot registered / 机器人已登记" };
  } catch (e) { return { ok: false, botId: id, message: errText(e) }; }
}

// 功能：发布需求单（谁缺什么），写进黑板 demand: 前缀键；返回 { ok, botId, items }。
function postDemand(botId, items) {
  var id = cleanId(botId);
  var b = board();
  if (!b || id.length === 0) return { ok: false, botId: id, message: "board or botId missing / 黑板或 botId 不可用" };
  try {
    var need = normalizeItems(items);
    var rec = { botId: id, items: need, at: Date.now() };
    b.post(DEMAND_PREFIX + id, rec);
    emit("market.demand", { botId: id, items: need });
    logSystem("需求挂单 / demand posted: " + id + " " + JSON.stringify(need));
    return { ok: true, botId: id, items: need, message: "demand posted / 需求已发布" };
  } catch (e) { return { ok: false, botId: id, message: errText(e) }; }
}

// 功能：发布供给单（谁有多余物资 + 取货坐标），写进黑板 supply: 前缀键。
function postSupply(botId, items, position) {
  var id = cleanId(botId);
  var b = board();
  if (!b || id.length === 0) return { ok: false, botId: id, message: "board or botId missing / 黑板或 botId 不可用" };
  try {
    var offer = normalizeItems(items);
    var rec = { botId: id, items: offer, position: clone(position || { x: 0, y: 0, z: 0 }), at: Date.now() };
    b.post(SUPPLY_PREFIX + id, rec);
    emit("market.supply", { botId: id, items: offer });
    logSystem("供给挂单 / supply posted: " + id + " " + JSON.stringify(offer));
    return { ok: true, botId: id, items: offer, position: rec.position, message: "supply posted / 供给已发布" };
  } catch (e) { return { ok: false, botId: id, message: errText(e) }; }
}

// 按前缀列出黑板上的挂单副本；黑板不可用时返回空数组。
function listByPrefix(prefix) {
  var b = board();
  var out = [];
  if (!b || typeof b.keys !== "function") return out;
  try {
    var all = b.keys();
    for (var i = 0; i < all.length; i++) {
      var key = String(all[i]);
      if (key.indexOf(prefix) !== 0) continue;
      var rec = b.get(key, null);
      if (rec && typeof rec === "object") out.push(clone(rec));
    }
  } catch (e) { return []; }
  return out;
}

// 功能：列出全部需求单（副本数组）。
function listDemand() { return listByPrefix(DEMAND_PREFIX); }

// 功能：列出全部供给单（副本数组）。
function listSupply() { return listByPrefix(SUPPLY_PREFIX); }

// 功能：撮合需求与供给，为每组可满足的物资生成一个 haul 搬运任务；返回 { ok, matches, taskIds }。
function matchSupply() {
  var b = board();
  var out = { ok: false, matches: 0, taskIds: [], message: "board unavailable / 黑板不可用" };
  if (!b || typeof b.postTask !== "function") return out;
  try {
    var demands = listDemand();
    var supplies = listSupply();
    for (var i = 0; i < demands.length; i++) {
      for (var j = 0; j < supplies.length; j++) {
        var need = demands[i].items || {};
        var offer = supplies[j].items || {};
        for (var item in need) {
          if (!Object.prototype.hasOwnProperty.call(need, item)) continue;
          if (Number(offer[item]) < Number(need[item])) continue;
          var amount = Number(need[item]);
          var posted = b.postTask({
            title: "haul", priority: 8,
            payload: { action: "haul", item: item, amount: amount, from: clone(supplies[j].position), fromBot: supplies[j].botId, toBot: demands[i].botId }
          });
          if (posted && posted.ok) {
            out.taskIds.push(posted.taskId);
            out.matches = out.matches + 1;
            counters.matches = counters.matches + 1;
          }
        }
      }
    }
    out.ok = true;
    out.message = "supply matched / 供需已撮合";
    emit("market.match", { matches: out.matches });
    logSystem("供需撮合 / supply matched: " + out.matches + " haul tasks");
  } catch (e) { out.message = errText(e); }
  return out;
}

// 功能：把大任务拆成 N 个放置子任务丢进任务池（默认 50，硬上限 200）；返回任务 id 数组。
function postBigTask(spec) {
  var b = board();
  var body = spec && typeof spec === "object" ? spec : {};
  var out = { ok: false, count: 0, taskIds: [], message: "board unavailable / 黑板不可用" };
  if (!b || typeof b.postTask !== "function") return out;
  try {
    var count = Math.round(Number(body.count) > 0 ? Number(body.count) : 50);
    if (count > MAX_TASK_SPLIT) count = MAX_TASK_SPLIT;
    var origin = clone(body.position || { x: 0, y: 0, z: 0 });
    var jobId = "job-" + Date.now().toString(36);
    for (var i = 0; i < count; i++) {
      var posted = b.postTask({
        title: "place-" + (i + 1), priority: Number(body.priority) || 1,
        payload: { action: "place_block", jobId: jobId, index: i, block: String(body.block || "planks"),
          position: { x: Number(origin.x) + (i % 10), y: Number(origin.y), z: Number(origin.z) + Math.floor(i / 10) } }
      });
      if (posted && posted.ok) out.taskIds.push(posted.taskId);
    }
    out.ok = true;
    out.count = out.taskIds.length;
    out.jobId = jobId;
    out.message = "big task split / 大任务已拆单";
    emit("market.bigtask", { jobId: jobId, count: out.count });
    logSystem("大任务拆单 / big task split: " + jobId + " -> " + out.count + " place tasks");
  } catch (e) { out.message = errText(e); }
  return out;
}

// 功能：给一个任务算竞价分（优先级 * 10 - 距离 * 0.5 - 负载 * 2 + 搬运加成），坏值按 0 处理。
function scoreTask(botId, state, task) {
  try {
    var body = state && typeof state === "object" ? state : (botStates[cleanId(botId)] || {});
    var job = task && typeof task === "object" ? task : {};
    var target = job.payload && job.payload.position ? job.payload.position : (job.payload && job.payload.from ? job.payload.from : {});
    var dist = distanceOf(body.position, target);
    var priority = Number(job.priority) || 0;
    var load = Number(body.load) || 0;
    var bonus = String(job.title) === "haul" ? 3 : 0;
    return priority * 10 - dist * 0.5 - load * 2 + bonus;
  } catch (e) { return 0; }
}

// 功能：单个 bot 竞价抢单——从 pending 里挑分最高的任务并原子认领；无任务返回 ok:false。
function bid(botId, state) {
  var id = cleanId(botId);
  var b = board();
  if (!b || id.length === 0 || typeof b.listTasks !== "function") {
    return { ok: false, botId: id, message: "board or botId missing / 黑板或 botId 不可用" };
  }
  try {
    var body = state && typeof state === "object" ? state : (botStates[id] || { status: "idle" });
    if (String(body.status || "idle") !== "idle") {
      return { ok: false, botId: id, message: "bot busy / 机器人非空闲" };
    }
    var pending = b.listTasks({ status: "pending" });
    if (!pending || pending.length === 0) return { ok: false, botId: id, message: "no pending task / 暂无待领任务" };
    var best = pending[0];
    var bestScore = scoreTask(id, body, best);
    for (var i = 1; i < pending.length; i++) {
      var score = scoreTask(id, body, pending[i]);
      if (score > bestScore) { bestScore = score; best = pending[i]; }
    }
    var claim = b.claimTask(id, { taskId: best.id, score: bestScore });
    if (!claim.ok) return { ok: false, botId: id, message: claim.message };
    botStates[id] = { botId: id, position: clone(body.position), load: Number(body.load) || 0, status: "working" };
    counters.bids = counters.bids + 1;
    logInfo("竞价成功 / bid won: " + id + " task=" + best.id + " score=" + bestScore);
    emit("market.bid", { botId: id, taskId: best.id, score: bestScore });
    return { ok: true, botId: id, taskId: best.id, title: best.title, score: bestScore, message: "task claimed / 任务已抢到" };
  } catch (e) { return { ok: false, botId: id, message: errText(e) }; }
}

// 功能：一轮全蜂群竞价；入参可为 [{ botId, position, load, status }] 或 { id: state }，只让空闲 bot 抢单。
function runAuction(bots) {
  var out = { ok: true, participants: 0, claimed: 0, assignments: [], message: "auction done / 竞价结束" };
  try {
    counters.auctions = counters.auctions + 1;
    var list = [];
    if (Array.isArray(bots)) {
      for (var i = 0; i < bots.length; i++) {
        var one = bots[i] && typeof bots[i] === "object" ? bots[i] : {};
        list.push({ botId: one.botId || one.id, position: one.position, load: one.load, status: one.status || "idle" });
      }
    } else if (bots && typeof bots === "object") {
      for (var key in bots) {
        if (!Object.prototype.hasOwnProperty.call(bots, key)) continue;
        var st = bots[key] && typeof bots[key] === "object" ? bots[key] : {};
        list.push({ botId: key, position: st.position, load: st.load, status: st.status || "idle" });
      }
    }
    for (var j = 0; j < list.length; j++) {
      registerBot(list[j].botId, list[j]);
      out.participants = out.participants + 1;
      var hit = bid(list[j].botId, list[j]);
      if (hit.ok) { out.claimed = out.claimed + 1; out.assignments.push({ botId: hit.botId, taskId: hit.taskId, score: hit.score }); }
    }
  } catch (e) { out.message = errText(e); }
  return out;
}

// 功能：背包满自动挂供给单并生成搬运任务；返回 { ok, supply, taskId }。
function onInventoryFull(botId, items, position) {
  var id = cleanId(botId);
  var posted = postSupply(id, items, position);
  if (!posted.ok) return { ok: false, botId: id, message: posted.message };
  var b = board();
  var taskId = "";
  try {
    if (b && typeof b.postTask === "function") {
      var one = b.postTask({ title: "haul", priority: 9,
        payload: { action: "haul", items: posted.items, from: clone(posted.position), fromBot: id } });
      if (one && one.ok) taskId = one.taskId;
    }
  } catch (e) { /* 没生成任务也不影响挂单 */ }
  emit("market.inventoryFull", { botId: id, taskId: taskId });
  logSystem("背包满挂单 / inventory full: " + id + " task=" + taskId);
  return { ok: true, botId: id, supply: posted.items, taskId: taskId, message: "supply listed / 多余物资已挂单" };
}

// 功能：搬运 bot 抢一个 haul 任务，返回 { ok, taskId, task }。
function claimHaul(botId, state) {
  var b = board();
  var out = { ok: false, botId: cleanId(botId), taskId: "", task: null, message: "no haul task / 暂无搬运任务" };
  if (!b || typeof b.listTasks !== "function") return out;
  try {
    var pending = b.listTasks({ status: "pending" });
    var haul = null;
    for (var i = 0; i < pending.length; i++) {
      if (String(pending[i].title) === "haul") { haul = pending[i]; break; }
    }
    if (!haul) return out;
    var claim = b.claimTask(out.botId, { taskId: haul.id });
    if (!claim.ok) { out.message = claim.message; return out; }
    out.ok = true;
    out.taskId = haul.id;
    out.task = clone(haul);
    out.message = "haul claimed / 搬运任务已抢到";
    return out;
  } catch (e) { out.message = errText(e); return out; }
}

// 功能：把取到的物资存进基地仓库并完成任务；返回仓库快照，异常降级不抛错。
function deliver(botId, taskId, items) {
  var b = board();
  var id = cleanId(botId);
  var out = { ok: false, botId: id, taskId: String(taskId || ""), warehouse: {}, message: "board unavailable / 黑板不可用" };
  if (!b) return out;
  try {
    var goods = normalizeItems(items);
    for (var item in goods) {
      if (!Object.prototype.hasOwnProperty.call(goods, item)) continue;
      var key = WAREHOUSE_PREFIX + item;
      var before = Number(b.get(key, 0)) || 0;
      b.post(key, before + goods[item]);
    }
    if (typeof b.completeTask === "function") {
      try { b.completeTask(out.taskId, id, { delivered: goods }); } catch (eDone) { /* 完成失败不影响入库 */ }
    }
    try { b.del(SUPPLY_PREFIX + id); } catch (eDel) { /* 供给单可能属于别人 */ }
    if (botStates[id]) botStates[id].status = "idle";
    counters.deliveries = counters.deliveries + 1;
    out.ok = true;
    out.warehouse = warehouse();
    out.message = "delivered / 物资已入库";
    emit("market.deliver", { botId: id, taskId: out.taskId, items: goods });
    logSystem("物资入库 / delivered to base: " + id + " " + JSON.stringify(goods));
  } catch (e) { out.message = errText(e); }
  return out;
}

// 读仓库快照：遍历 warehouse: 前缀键。
function warehouse() {
  var b = board();
  var out = {};
  if (!b || typeof b.keys !== "function") return out;
  try {
    var all = b.keys();
    for (var i = 0; i < all.length; i++) {
      var key = String(all[i]);
      if (key.indexOf(WAREHOUSE_PREFIX) !== 0) continue;
      out[key.slice(WAREHOUSE_PREFIX.length)] = Number(b.get(key, 0)) || 0;
    }
  } catch (e) { return {}; }
  return out;
}

// 功能：生态状态监控——挂单数 / 任务数 / 执行中与空闲 bot / 仓库 / 累计统计。
function ecosystem() {
  var out = { ok: true, demands: 0, supplies: 0, pending: 0, claimed: 0, done: 0,
    working: 0, idle: 0, bots: 0, warehouse: {}, deliveries: 0, auctions: 0, bids: 0, matches: 0 };
  try {
    out.demands = listDemand().length;
    out.supplies = listSupply().length;
    var b = board();
    if (b && typeof b.taskStats === "function") {
      var st = b.taskStats();
      out.pending = st.pending || 0;
      out.claimed = st.claimed || 0;
      out.done = st.done || 0;
    }
    for (var key in botStates) {
      if (!Object.prototype.hasOwnProperty.call(botStates, key)) continue;
      out.bots = out.bots + 1;
      if (botStates[key].status === "working") out.working = out.working + 1;
      else out.idle = out.idle + 1;
    }
    out.warehouse = warehouse();
    out.deliveries = counters.deliveries;
    out.auctions = counters.auctions;
    out.bids = counters.bids;
    out.matches = counters.matches;
  } catch (e) { out.message = errText(e); }
  return out;
}

// 功能：清空内存生态状态（自测隔离用），不触碰黑板上的持久化任务。
function reset() {
  try {
    botStates = {};
    counters = { auctions: 0, bids: 0, deliveries: 0, matches: 0 };
  } catch (e) { /* ignore */ }
  return { ok: true, message: "market reset / 生态状态已重置" };
}

// 对外导出：挂单 / 撮合 / 拆单 / 竞价 / 搬运 / 统计。
module.exports = {
  setBoard: setBoard,
  registerBot: registerBot,
  postDemand: postDemand,
  postSupply: postSupply,
  listDemand: listDemand,
  listSupply: listSupply,
  matchSupply: matchSupply,
  postBigTask: postBigTask,
  scoreTask: scoreTask,
  bid: bid,
  runAuction: runAuction,
  onInventoryFull: onInventoryFull,
  claimHaul: claimHaul,
  deliver: deliver,
  ecosystem: ecosystem,
  reset: reset,
  MAX_TASK_SPLIT: MAX_TASK_SPLIT
};
