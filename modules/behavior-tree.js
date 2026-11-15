// ========================================
// 文件：modules/behavior-tree.js
// 功能：可恢复行为树——sequence / selector / condition / action，被打断后从断点续跑而不重做已完成步骤
// 依赖：./event-bus（可选）、./logger（可选）；无第三方库
// 导出：create / tick / interrupt / resume / status / reset / blackboard / NODE_TYPES
// 作者：MineBots
// ========================================
//
// 恢复语义 / resume semantics
//   每个节点有稳定 path（如 "0.2.1"），成功执行过的 action 记进 tree.done。
//   interrupt 只把 status 改成 interrupted 并保留 done / 黑板，绝不重置进度。
//   resume 再 tick 时，done 里的节点直接跳过，于是不重复挥手、不重复采集。
// CommonJS，ES5 风格，无中文变量名

// 可选依赖：事件总线，缺失时树照常运行。
var bus = null;
try { bus = require("./event-bus"); } catch (e) { bus = null; }

// 可选依赖：日志核心，节点日志属高频信息，只落文件。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
// 可选依赖：引擎控制中心（专家模式可关行为树 / 调单次执行节点预算）。
var engineControl = null;
try { engineControl = require("./engine-control"); } catch (e) { engineControl = null; }

// 常量：支持的节点类型 / 单次 tick 最多执行节点数 / 单棵树最多节点数。
var NODE_TYPES = { SEQUENCE: "sequence", SELECTOR: "selector", ACTION: "action", CONDITION: "condition", PARALLEL: "parallel" };
var MAX_NODES_PER_TICK = 200;
var MAX_TREE_NODES = 300;

// 状态：树实例计数，用于生成稳定 id / 单次 tick 的当前节点预算（每次 tick 从面板配置读一次）。
var treeCounter = 0;
var nodeBudget = MAX_NODES_PER_TICK;

// 读引擎开关：控制中心缺失或读失败时按开启处理。
function isEngineEnabled() {
  try {
    if (engineControl && typeof engineControl.isEnabled === "function") return engineControl.isEnabled("behaviorTree") === true;
  } catch (e) { /* 读失败按开启 */ }
  return true;
}

// 读面板配置的单次 tick 节点预算；读不到退回内置 200。
function engineTickBudget() {
  try {
    if (engineControl && typeof engineControl.param === "function") {
      var n = engineControl.param("behaviorTree", "behaviorMaxTicks");
      if (n >= 20) return n;
    }
  } catch (e) { /* 读失败用默认值 */ }
  return MAX_NODES_PER_TICK;
}

// 写信息日志：节点执行属高频信息，只落文件，绝不推 GUI。
function logInfo(message) {
  try { if (logger && typeof logger.info === "function") logger.info("[behavior-tree] " + message); } catch (e) { /* ignore */ }
}

// 写系统日志：打断 / 恢复这类低频事件推 GUI。
function logSystem(message) {
  try {
    if (logger && typeof logger.system === "function") { logger.system("[behavior-tree] " + message); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[behavior-tree] " + message); } catch (e2) { /* ignore */ }
}

// 把异常拍成一行文本，避免在 catch 里再次抛错。
function errText(err) {
  try { if (err && err.message) return String(err.message); return String(err); }
  catch (e) { return "unknown error"; }
}

// 广播树事件：总线缺失时静默跳过，绝不抛错。
function busEmit(name, payload) {
  try { if (bus && typeof bus.emit === "function") bus.emit(name, payload); } catch (e) { /* ignore */ }
}

// 内部：递归给每个节点挂稳定 path，并统计节点数；超过上限时返回 false。
function tagNodes(node, path, counter) {
  try {
    if (!node || typeof node !== "object") return true;
    counter.n = counter.n + 1;
    if (counter.n > MAX_TREE_NODES) return false;
    node._path = path;
    if (Array.isArray(node.children)) {
      for (var i = 0; i < node.children.length; i++) {
        if (!tagNodes(node.children[i], path + "." + i, counter)) return false;
      }
    }
    return true;
  } catch (e) { return false; }
}

// 功能：创建一棵行为树，返回 { ok, tree, message }；定义非法时返回 ok:false。
function create(definition, options) {
  var opts = options && typeof options === "object" ? options : {};
  if (!definition || typeof definition !== "object") {
    return { ok: false, tree: null, message: "definition must be an object / 定义必须是对象" };
  }
  try {
    treeCounter = treeCounter + 1;
    var counter = { n: 0 };
    if (!tagNodes(definition, "0", counter)) {
      return { ok: false, tree: null, message: "tree too large / 节点数超过上限" };
    }
    var tree = {
      id: "bt-" + treeCounter,
      name: String(opts.name || definition.name || "tree"),
      root: definition,
      status: "idle",
      done: {},
      blackboard: opts.blackboard && typeof opts.blackboard === "object" ? opts.blackboard : {},
      nodes: counter.n,
      ticks: 0,
      ran: 0,
      skipped: 0,
      interrupts: 0,
      lastPath: "",
      lastError: "",
      startedAt: Date.now(),
      finishedAt: 0
    };
    return { ok: true, tree: tree, message: "tree created / 行为树已创建" };
  } catch (e) {
    return { ok: false, tree: null, message: errText(e) };
  }
}

// 内部：把节点回包归一化成 { ok, running, value }，永不抛错。
function normalizeResult(value) {
  try {
    if (value === "running") return { ok: false, running: true, value: null };
    if (value === true || value === "success") return { ok: true, running: false, value: null };
    if (value === false || value === "failure" || value === undefined) return { ok: false, running: false, value: null };
    if (value && typeof value === "object") {
      if (value.running === true) return { ok: false, running: true, value: value };
      return { ok: value.ok !== false, running: false, value: value };
    }
    return { ok: true, running: false, value: value };
  } catch (e) { return { ok: false, running: false, value: null }; }
}

// 内部：执行一个叶子节点；已完成的 action 直接跳过，实现断点续跑。
async function runLeaf(node, tree, ctx, budget) {
  var path = node._path || "leaf";
  if (tree.done[path] === true) {
    tree.skipped = tree.skipped + 1;
    return { status: "success", skipped: true };
  }
  budget.n = budget.n + 1;
  if (budget.n > nodeBudget) return { status: "failure", error: "tick budget exceeded / 单次执行节点过多" };
  if (typeof node.fn !== "function") return { status: "failure", error: "leaf has no fn / 叶子缺少执行函数" };
  if (tree.status === "interrupted") return { status: "interrupted", skipped: false };
  var value = null;
  try { value = await node.fn(ctx, tree.blackboard, tree); }
  catch (e) { return { status: "failure", error: errText(e) }; }
  var res = normalizeResult(value);
  tree.ran = tree.ran + 1;
  tree.lastPath = path;
  logInfo("node " + path + " " + String(node.type) + " -> " + (res.running ? "running" : (res.ok ? "success" : "failure")));
  busEmit("bt.node", { treeId: tree.id, path: path, ok: res.ok, running: res.running });
  if (res.running) return { status: "running", skipped: false };
  if (!res.ok) return { status: "failure", error: node.message || "node failed / 节点失败" };
  tree.done[path] = true;
  return { status: "success", skipped: false, value: res.value };
}

// 内部：并行节点——所有子节点在同一 tick 内并发起跑（一边走路一边吃东西），最后汇总结果。
async function runParallel(children, tree, ctx, budget) {
  var jobs = [];
  for (var i = 0; i < children.length; i++) {
    budget.n = budget.n + 1;
    if (budget.n > nodeBudget) return { status: "failure", error: "tick budget exceeded / 单次执行节点过多" };
    jobs.push(runNode(children[i], tree, ctx, budget));
  }
  var results = [];
  try { results = await Promise.all(jobs); }
  catch (e) { return { status: "failure", error: errText(e) }; }
  var running = false;
  var lastError = "";
  for (var j = 0; j < results.length; j++) {
    var one = results[j] || { status: "failure", error: "" };
    if (one.status === "interrupted") return { status: "interrupted" };
    if (one.status === "failure") return { status: "failure", error: one.error || "" };
    if (one.status === "running") running = true;
    if (one.error) lastError = one.error;
  }
  if (running) return { status: "running" };
  return { status: "success", error: lastError };
}

// 内部：递归执行一棵子树；sequence 全成功才成功，selector 任一成功即可，parallel 真并发。
async function runNode(node, tree, ctx, budget) {
  if (!node || typeof node !== "object") return { status: "failure", error: "bad node / 节点非法" };
  if (tree.status === "interrupted") return { status: "interrupted" };
  var type = String(node.type || NODE_TYPES.ACTION).toLowerCase();
  if (type === NODE_TYPES.ACTION || type === NODE_TYPES.CONDITION) return runLeaf(node, tree, ctx, budget);
  var children = Array.isArray(node.children) ? node.children : [];
  if (children.length === 0) return { status: "success" };
  if (type === NODE_TYPES.PARALLEL) return runParallel(children, tree, ctx, budget);
  var anyRunning = false;
  var lastError = "";
  for (var i = 0; i < children.length; i++) {
    budget.n = budget.n + 1;
    if (budget.n > nodeBudget) return { status: "failure", error: "tick budget exceeded / 单次执行节点过多" };
    var res = await runNode(children[i], tree, ctx, budget);
    if (res.status === "interrupted") return { status: "interrupted" };
    // 顺序 / 选择节点遇到 running 立刻挂起本 tick，后面的兄弟节点留到下次 tick，符合「失败则中断」语义。
    if (res.status === "running" && (type === NODE_TYPES.SEQUENCE || type === NODE_TYPES.SELECTOR)) {
      return { status: "running" };
    }
    if (res.status === "running") anyRunning = true;
    if (res.status === "success" && type === NODE_TYPES.SELECTOR) return { status: "success" };
    if (res.status === "failure" && type === NODE_TYPES.SEQUENCE) {
      return { status: "failure", error: res.error || "" };
    }
    if (res.error) lastError = res.error;
  }
  if (anyRunning) return { status: "running" };
  if (type === NODE_TYPES.SELECTOR) return { status: "failure", error: lastError || "all branches failed / 全部分支失败" };
  return { status: "success" };
}

// 功能：跑一次树，返回 { ok, status, ran, skipped, message }；永不 reject。
async function tick(tree, ctx) {
  if (!tree || typeof tree !== "object") {
    return { ok: false, status: "failure", ran: 0, skipped: 0, message: "tree required / 缺少行为树" };
  }
  // 专家面板关掉行为树：不改树状态、不执行任何节点，等同模块停止运作。
  if (!isEngineEnabled()) {
    return { ok: false, status: "disabled", ran: 0, skipped: 0, disabled: true,
      message: "behavior tree disabled / 行为树状态机已关闭" };
  }
  try {
    nodeBudget = engineTickBudget();
    if (tree.status === "success" || tree.status === "failure") {
      return { ok: tree.status === "success", status: tree.status, ran: 0, skipped: 0, message: "already finished / 树已结束" };
    }
    tree.status = "running";
    tree.ticks = tree.ticks + 1;
    var budget = { n: 0 };
    var res = await runNode(tree.root, tree, ctx || {}, budget);
    if (res.status === "interrupted") {
      tree.status = "interrupted";
      return { ok: false, status: "interrupted", ran: tree.ran, skipped: tree.skipped, message: "interrupted / 已被打断" };
    }
    if (res.status === "running") {
      tree.status = "running";
      return { ok: false, status: "running", ran: tree.ran, skipped: tree.skipped, message: "running / 仍在执行" };
    }
    tree.status = res.status;
    tree.finishedAt = Date.now();
    tree.lastError = res.error || "";
    busEmit("bt.done", { treeId: tree.id, status: tree.status, ran: tree.ran, skipped: tree.skipped });
    return {
      ok: res.status === "success",
      status: tree.status,
      ran: tree.ran,
      skipped: tree.skipped,
      message: res.status === "success" ? "tree done / 行为树完成" : ("tree failed / 行为树失败: " + (res.error || ""))
    };
  } catch (e) {
    tree.status = "failure";
    tree.lastError = errText(e);
    return { ok: false, status: "failure", ran: tree.ran, skipped: tree.skipped, message: errText(e) };
  }
}

// 功能：打断当前树——只改状态并保留已完成节点与黑板，返回 { ok, status, done }。
function interrupt(tree, reason) {
  if (!tree || typeof tree !== "object") return { ok: false, status: "", done: 0, message: "tree required / 缺少行为树" };
  try {
    tree.status = "interrupted";
    tree.interrupts = tree.interrupts + 1;
    tree.lastError = String(reason || "external interrupt / 外部打断");
    var count = 0;
    for (var key in tree.done) { if (Object.prototype.hasOwnProperty.call(tree.done, key)) count = count + 1; }
    logSystem("树已打断 / tree interrupted: " + tree.id + " done=" + count + " reason=" + tree.lastError);
    busEmit("bt.interrupt", { treeId: tree.id, done: count, reason: tree.lastError });
    return { ok: true, status: "interrupted", done: count, message: "interrupted / 已打断，进度已保留" };
  } catch (e) { return { ok: false, status: "", done: 0, message: errText(e) }; }
}

// 功能：从断点恢复并继续跑；已完成的节点会被跳过，返回与 tick 相同结构。
async function resume(tree, ctx, options) {
  if (!tree || typeof tree !== "object") return { ok: false, status: "failure", ran: 0, skipped: 0, resumed: false, message: "tree required / 缺少行为树" };
  var opts = options && typeof options === "object" ? options : {};
  try {
    if (tree.status === "interrupted") {
      tree.status = "idle";
      logSystem("树已恢复 / tree resumed: " + tree.id + " from " + (tree.lastPath || "start"));
      busEmit("bt.resume", { treeId: tree.id, from: tree.lastPath });
    }
    if (opts.resetDone === true) tree.done = {};
    var res = await tick(tree, ctx);
    res.resumed = true;
    return res;
  } catch (e) { return { ok: false, status: "failure", ran: 0, skipped: 0, resumed: false, message: errText(e) }; }
}

// 功能：读树的状态快照（副本），异常返回 null。
function status(tree) {
  try {
    if (!tree || typeof tree !== "object") return null;
    var count = 0;
    for (var key in tree.done) { if (Object.prototype.hasOwnProperty.call(tree.done, key)) count = count + 1; }
    return {
      id: tree.id, name: tree.name, status: tree.status, nodes: tree.nodes,
      ticks: tree.ticks, ran: tree.ran, skipped: tree.skipped, done: count,
      interrupts: tree.interrupts, lastPath: tree.lastPath, lastError: tree.lastError,
      elapsedMs: (tree.finishedAt || Date.now()) - tree.startedAt
    };
  } catch (e) { return null; }
}

// 功能：取黑板副本，异常返回空对象。
function blackboard(tree) {
  try {
    if (!tree || !tree.blackboard) return {};
    return JSON.parse(JSON.stringify(tree.blackboard));
  } catch (e) { return {}; }
}

// 功能：重置进度（保留树结构），返回 { ok, message }。
function reset(tree) {
  if (!tree || typeof tree !== "object") return { ok: false, message: "tree required / 缺少行为树" };
  try {
    tree.done = {};
    tree.status = "idle";
    tree.ticks = 0;
    tree.ran = 0;
    tree.skipped = 0;
    tree.interrupts = 0;
    tree.lastPath = "";
    tree.lastError = "";
    tree.finishedAt = 0;
    return { ok: true, message: "reset / 已重置" };
  } catch (e) { return { ok: false, message: errText(e) }; }
}

// 对外导出：建树 / 执行 / 打断 / 恢复 / 查询 / 重置。
module.exports = {
  create: create,
  tick: tick,
  interrupt: interrupt,
  resume: resume,
  status: status,
  blackboard: blackboard,
  reset: reset,
  NODE_TYPES: NODE_TYPES,
  MAX_NODES_PER_TICK: MAX_NODES_PER_TICK,
  MAX_TREE_NODES: MAX_TREE_NODES,
  isEngineEnabled: isEngineEnabled
};
