// ========================================
// 文件：modules/state-runtime.js
// 功能：状态机 3.0 三层编排——战略层下宏观目标 / 战术层跑行为树 / 反射层受击打断并自动恢复进度
// 依赖：./behavior-tree、./context-stack、./replan、./goap（可选）、./event-bus（可选）、./logger（可选）
// 导出：createPlan / assignGoal / attach / tick / onHurt / insertNodes / drainQueue / status /
//       reset / list / NODE_TYPES / LAYERS
// 作者：MineBots
// ========================================
//
// 打断与恢复 / interrupt and resume
//   1. 受击事件 → 把当前战术上下文（goal/progress/blackboard/done/lastPath）整帧压入上下文栈；
//   2. 行为树 interrupt 只改状态、保留已完成节点；跑高优先级 defense selector；
//   3. 战斗结束出栈，把黑板和 done 写回原树，bt.resume 跳过已完成节点，合成进度自动续跑。
// 死锁处理 / watchdog：节点失败累计 3 次 → replan.aiReplan → 合法 tool_calls 动态插入执行队列。
// ES5 风格，CommonJS，无中文变量名；所有对外函数返回带 ok 的对象，绝不抛到顶层。
var bt = null;
try { bt = require("./behavior-tree"); } catch (e) { bt = null; }

var stack = null;
try { stack = require("./context-stack"); } catch (e) { stack = null; }

var replan = null;
try { replan = require("./replan"); } catch (e) { replan = null; }

var goap = null;
try { goap = require("./goap"); } catch (e) { goap = null; }

var bus = null;
try { bus = require("./event-bus"); } catch (e) { bus = null; }

var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：三层名称 / 行为树节点类型（与 behavior-tree.js 保持同源）。
var LAYERS = { STRATEGIC: "strategic", TACTICAL: "tactical", REFLEX: "reflex" };
var NODE_TYPES = { SEQUENCE: "sequence", SELECTOR: "selector", PARALLEL: "parallel", ACTION: "action", CONDITION: "condition" };
var MAX_STEPS = 24;

// 状态：botId → 运行时（树、进度、防御日志、动态队列、统计）。
var runtimes = {};

// 写文件日志：节点级信息只落文件，绝不刷 GUI。
function logInfo(msg) {
  try { if (logger && typeof logger.info === "function") logger.info("[state-runtime] " + msg); } catch (e) { /* ignore */ }
}

// 写系统日志：目标下达 / 受击恢复 / AI 重规划这类低频事件推 GUI。
function logSystem(msg) {
  try {
    if (logger && typeof logger.system === "function") { logger.system("[state-runtime] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[state-runtime] " + msg); } catch (e2) { /* ignore */ }
}

// 广播运行时事件：总线缺失时静默跳过。
function emit(name, payload) {
  try { if (bus && typeof bus.emit === "function") bus.emit(name, payload); } catch (e) { /* ignore */ }
}

// 规范化 botId，坏值退回 default。
function idOf(botId) {
  try {
    var text = String(botId === null || botId === undefined ? "" : botId).replace(/^\s+|\s+$/g, "");
    return text.length === 0 ? "default" : text.slice(0, 80);
  } catch (e) { return "default"; }
}

// 深拷贝纯数据，坏值返回空对象。
function clone(value) {
  try {
    var out = JSON.parse(JSON.stringify(value === undefined ? null : value));
    return out && typeof out === "object" ? out : {};
  } catch (e) { return {}; }
}

// 安全取错误文本。
function errText(err) {
  try { if (err && err.message) return String(err.message); return String(err); }
  catch (e) { return "unknown error"; }
}

// 按目标拆出战术步骤；GOAP 可用且认得该目标时优先用它的前置任务链。
function goalSteps(goal) {
  var text = String(goal === null || goal === undefined ? "" : goal);
  var lower = text.toLowerCase();
  var steps = [];
  try {
    if (goap && typeof goap.plan === "function") {
      var planned = goap.plan(text);
      if (planned && planned.ok === true && Array.isArray(planned.chain)) {
        for (var i = 0; i < planned.chain.length && i < MAX_STEPS; i++) {
          var one = planned.chain[i];
          var name = typeof one === "string" ? one : (one && (one.action || one.name || one.id));
          if (name) steps.push(String(name));
        }
      }
    }
  } catch (e) { /* 回退关键字拆解 */ }
  if (steps.length > 0) return steps;
  if (lower.indexOf("pickaxe") >= 0 || lower.indexOf("木镐") >= 0 || lower.indexOf("craft") >= 0) {
    return ["get_wood", "craft_planks", "craft_sticks", "craft_pickaxe"];
  }
  if (lower.indexOf("chop") >= 0 || lower.indexOf("tree") >= 0 || lower.indexOf("砍树") >= 0 || lower.indexOf("wood") >= 0) {
    return ["get_wood", "collect"];
  }
  if (lower.indexOf("mine") >= 0 || lower.indexOf("挖矿") >= 0 || lower.indexOf("iron") >= 0) {
    return ["explore", "mine", "collect"];
  }
  if (lower.indexOf("build") >= 0 || lower.indexOf("house") >= 0 || lower.indexOf("建") >= 0) {
    return ["get_wood", "place_block", "place_block"];
  }
  return ["explore", "collect"];
}

// 功能：把一个宏观目标编译成可恢复行为树；返回 { ok, goal, steps, tree, log, definition }。
function createPlan(goal, options) {
  var opts = options && typeof options === "object" ? options : {};
  if (!bt || typeof bt.create !== "function") {
    return { ok: false, goal: String(goal || ""), steps: [], tree: null, log: [], message: "behavior-tree unavailable / 行为树不可用" };
  }
  var text = String(goal === null || goal === undefined ? "" : goal);
  var steps = goalSteps(text);
  var log = [];
  var executor = typeof opts.executor === "function" ? opts.executor : null;
  var hooks = opts.hooks && typeof opts.hooks === "object" ? opts.hooks : {};
  var paused = false;
  try {
    var leaves = [];
    for (var i = 0; i < steps.length; i++) {
      (function (name, index) {
        leaves.push({
          type: NODE_TYPES.ACTION,
          fn: function (ctx, board, tree) {
            log.push(name);
            board.steps = Number(board.steps || 0) + 1;
            board.lastAction = name;
            if (hooks.onStep && typeof hooks.onStep === "function") {
              try { hooks.onStep(name, index); } catch (eHook) { /* 钩子报错不影响节点 */ }
            }
            // 自测可用：某一步返回 running，模拟「合成进行中被打断」；恢复时只重跑该步。
            if (Number(opts.pauseAt) === index + 1 && paused === false) { paused = true; return "running"; }
            if (executor) {
              var value = null;
              try { value = executor(name, ctx, board, tree); } catch (eExec) { return false; }
              return value === false ? false : true;
            }
            return true;
          }
        });
      })(steps[i], i);
    }
    var root = { type: NODE_TYPES.SEQUENCE, children: leaves };
    // Parallel：一边走路一边吃东西，两个动作在同一 tick 内并发执行。
    if (opts.parallel === true) {
      root = { type: NODE_TYPES.PARALLEL, children: [
        { type: NODE_TYPES.SEQUENCE, children: [leaves[0] || { type: NODE_TYPES.ACTION, fn: function () { return true; } }] },
        { type: NODE_TYPES.SEQUENCE, children: [leaves[1] || { type: NODE_TYPES.ACTION, fn: function () { return true; } }] }
      ] };
    }
    var made = bt.create(root, { name: "plan:" + text, blackboard: { goal: text, steps: 0, lastAction: "" } });
    if (!made.ok) return { ok: false, goal: text, steps: steps, tree: null, log: log, message: made.message };
    return { ok: true, goal: text, steps: steps, tree: made.tree, log: log, definition: root, message: "plan created / 战术计划已生成" };
  } catch (e) {
    return { ok: false, goal: text, steps: steps, tree: null, log: log, message: errText(e) };
  }
}

// 功能：登记一个 bot 的运行时（战略层只在这里下宏观目标，不碰反射动作）。
function attach(botId, plan, options) {
  var id = idOf(botId);
  var opts = options && typeof options === "object" ? options : {};
  if (!plan || !plan.tree) return { ok: false, botId: id, message: "plan required / 缺少战术计划" };
  try {
    if (stack && typeof stack.clear === "function") stack.clear(id);
    var rt = {
      botId: id,
      goal: plan.goal,
      steps: plan.steps.slice(0),
      tree: plan.tree,
      log: plan.log,
      defenseLog: [],
      injected: [],
      queue: [],
      executor: typeof opts.executor === "function" ? opts.executor : null,
      hurts: 0, restores: 0, replans: 0, ticks: 0,
      createdAt: Date.now()
    };
    runtimes[id] = rt;
    logSystem("战略层下达目标 / strategic goal assigned: " + id + " -> " + rt.goal);
    emit("state.goal", { botId: id, goal: rt.goal, steps: rt.steps.length });
    return { ok: true, botId: id, goal: rt.goal, steps: rt.steps.length, message: "goal assigned / 宏观目标已下达" };
  } catch (e) {
    return { ok: false, botId: id, message: errText(e) };
  }
}

// 功能：战略层一站式入口——编译目标并登记运行时，返回 { ok, plan, attach }。
function assignGoal(botId, goal, options) {
  var plan = createPlan(goal, options);
  if (!plan.ok) return { ok: false, botId: idOf(botId), plan: plan, message: plan.message };
  var hit = attach(botId, plan, options);
  return { ok: hit.ok, botId: hit.botId, goal: plan.goal, steps: plan.steps, tree: plan.tree, log: plan.log, plan: plan, attach: hit, message: hit.message };
}

// 取运行时，不存在返回 null。
function runtimeOf(botId) {
  try { return runtimes[idOf(botId)] || null; } catch (e) { return null; }
}

// 功能：把 AI 重规划节点动态插入当前状态机的执行队列并立即交给执行器，坏节点跳过。
function insertNodes(botId, nodes) {
  var id = idOf(botId);
  var rt = runtimeOf(id);
  if (!rt) return { ok: false, botId: id, inserted: 0, message: "no runtime / 没有运行中的状态机" };
  try {
    var list = Array.isArray(nodes) ? nodes : [nodes];
    var inserted = 0;
    for (var i = 0; i < list.length && rt.queue.length < 64; i++) {
      var node = list[i];
      if (!node || typeof node !== "object" || !node.action) continue;
      var copy = { id: String(node.id || ("node-" + i)), action: String(node.action), args: clone(node.args || {}), source: String(node.source || "ai") };
      rt.queue.push(copy);
      inserted = inserted + 1;
      if (rt.executor) {
        try { rt.executor(copy.action, copy.args, { botId: id }, rt.tree.blackboard, rt.tree); } catch (eExec) { /* 执行失败不影响入队 */ }
      }
      rt.injected.push(copy.action);
    }
    emit("state.queue.insert", { botId: id, inserted: inserted, size: rt.queue.length });
    logInfo("动态节点插入 / dynamic nodes inserted: " + id + " x" + inserted);
    return { ok: true, botId: id, inserted: inserted, queue: rt.queue.length, message: "nodes inserted / 节点已插入执行队列" };
  } catch (e) {
    return { ok: false, botId: id, inserted: 0, message: errText(e) };
  }
}

// 功能：取出并清空动态执行队列（副本），异常返回空数组。
function drainQueue(botId) {
  var rt = runtimeOf(botId);
  if (!rt) return [];
  try { var out = clone(rt.queue); rt.queue = []; return out; } catch (e) { return []; }
}

// 功能：跑一个战术 tick；失败累计 3 次自动触发 AI 兜底重规划并把新节点插入队列。
async function tick(botId, ctx, options) {
  var id = idOf(botId);
  var rt = runtimeOf(id);
  var out = { ok: false, botId: id, status: "no-runtime", ran: 0, skipped: 0, watchdog: { needsReplan: false }, replan: null, message: "no runtime / 没有运行中的状态机" };
  if (!rt || !bt || typeof bt.tick !== "function") return out;
  try {
    rt.ticks = rt.ticks + 1;
    var res = await bt.tick(rt.tree, ctx || {});
    out.ok = res.ok === true;
    out.status = res.status;
    out.ran = res.ran;
    out.skipped = res.skipped;
    out.message = res.message;
    var fatal = res.ok === false && res.status !== "running" && res.status !== "interrupted" && res.status !== "disabled";
    if (fatal && replan && typeof replan.recordFailure === "function") {
      out.watchdog = replan.recordFailure(id, rt.tree.lastPath || rt.goal, res.message, {
        current_action: rt.goal, error: res.message, inventory: {}, position: {}, botId: id
      });
      if (out.watchdog.needsReplan && typeof replan.aiReplan === "function") {
        var rep = await replan.aiReplan(id, { current_action: rt.goal, error: res.message, inventory: {}, position: {}, botId: id }, options);
        out.replan = rep;
        rt.replans = rt.replans + 1;
        var nodes = typeof replan.drain === "function" ? replan.drain(id) : (rep.nodes || []);
        out.inserted = insertNodes(id, nodes);
        emit("state.replan", { botId: id, source: rep.source, nodes: rt.injected.length });
      }
    }
    return out;
  } catch (e) {
    out.message = errText(e);
    return out;
  }
}

// 功能：受击打断——冻结合成进度压栈、跑高优先级防御节点、出栈并自动恢复原任务链。
async function onHurt(botId, payload, ctx) {
  var id = idOf(botId);
  var rt = runtimeOf(id);
  if (!rt || !bt || !stack) {
    return { ok: false, botId: id, restored: false, message: "no runtime / 没有运行中的状态机" };
  }
  var empty = { ok: false, botId: id, restored: false, frozen: null, defense: "", defenseActions: [], progress: [], ran: 0, skipped: 0, message: "" };
  try {
    var info = payload && typeof payload === "object" ? payload : {};
    var reason = "entityHurt / 受击防御: " + String(info.source || "unknown");
    var frame = {
      goal: rt.goal,
      task: { name: rt.goal, currentNode: rt.tree.lastPath, layer: LAYERS.TACTICAL },
      progress: rt.log.slice(0),
      blackboard: bt.blackboard(rt.tree),
      done: clone(rt.tree.done),
      lastPath: String(rt.tree.lastPath || "")
    };
    var frozen = stack.push(id, frame, reason);
    emit("state.interrupt", { botId: id, reason: reason, frozen: frame.progress.length });
    logSystem("受击打断 / combat interrupt: " + id + " frozen=" + frame.progress.length);
    var wasInterrupted = bt.interrupt(rt.tree, reason);
    // 防御层 selector：先举盾，举盾失败再闪避；全部本地执行，绝不发 AI 请求。
    var defense = bt.create({ type: NODE_TYPES.SELECTOR, children: [
      { type: NODE_TYPES.ACTION, fn: function () { rt.defenseLog.push("local_shield"); return true; } },
      { type: NODE_TYPES.ACTION, fn: function () { rt.defenseLog.push("local_dodge"); return true; } }
    ] }, { name: "defense" });
    var dres = defense.ok ? await bt.tick(defense.tree, ctx || {}) : { status: "failure" };
    // 战斗结束：出栈并把黑板 / 已完成节点写回，resume 时自动跳过已完成步骤。
    var popped = stack.pop(id);
    if (popped.ok && popped.frame) {
      rt.tree.done = clone(popped.frame.done || {});
      rt.tree.blackboard = clone(popped.frame.blackboard || {});
      rt.tree.lastPath = String(popped.frame.lastPath || "");
    }
    var resumed = await bt.resume(rt.tree, ctx || {});
    rt.hurts = rt.hurts + 1;
    rt.restores = rt.restores + 1;
    emit("state.resume", { botId: id, restored: resumed.ok, skipped: resumed.skipped });
    logSystem("战斗结束，合成进度已恢复 / crafting resumed: " + id + " skipped=" + resumed.skipped);
    return {
      ok: true, botId: id, restored: resumed.ok === true, frozen: frozen.frame,
      frozenDepth: frozen.depth, interrupted: wasInterrupted.ok === true,
      defense: dres.status, defenseActions: rt.defenseLog.slice(0),
      progress: popped.frame ? popped.frame.progress.slice(0) : [],
      ran: resumed.ran, skipped: resumed.skipped, message: "progress restored / 合成进度已恢复"
    };
  } catch (e) {
    empty.message = errText(e);
    return empty;
  }
}

// 功能：读三层状态快照，供蜂群控制台与自测使用。
function status(botId) {
  var id = idOf(botId);
  var rt = runtimeOf(id);
  if (!rt) return { ok: false, botId: id, message: "no runtime / 没有运行中的状态机" };
  try {
    return {
      ok: true, botId: id, goal: rt.goal, layer: LAYERS.TACTICAL,
      steps: rt.steps.slice(0), progress: rt.log.slice(0),
      defenseActions: rt.defenseLog.slice(0), injected: rt.injected.slice(0),
      queue: rt.queue.length, hurts: rt.hurts, restores: rt.restores,
      replans: rt.replans, ticks: rt.ticks,
      stackDepth: stack && typeof stack.depth === "function" ? stack.depth(id) : 0,
      tree: bt && typeof bt.status === "function" ? bt.status(rt.tree) : null
    };
  } catch (e) {
    return { ok: false, botId: id, message: errText(e) };
  }
}

// 功能：重置一个 bot 的运行时与上下文栈（自测隔离用）。
function reset(botId) {
  var id = idOf(botId);
  try { delete runtimes[id]; } catch (e) { /* ignore */ }
  try { if (stack && typeof stack.clear === "function") stack.clear(id); } catch (e2) { /* ignore */ }
  return { ok: true, botId: id, message: "runtime reset / 运行时已重置" };
}

// 功能：清空全部运行时（进程退出 / 自测收尾用）。
function list() {
  var out = [];
  try {
    for (var key in runtimes) {
      if (!Object.prototype.hasOwnProperty.call(runtimes, key)) continue;
      out.push(key);
    }
  } catch (e) { return []; }
  return out;
}

// 反射层事件桥：antiafk.js 广播 reflex.hurt，这里统一交给 onHurt，两层之间没有直接依赖。
try {
  if (bus && typeof bus.on === "function") {
    bus.on("reflex.hurt", function (payload) {
      try {
        var data = payload && typeof payload === "object" ? payload : {};
        if (runtimeOf(data.botId)) onHurt(data.botId, data, {});
      } catch (e) { /* 事件回调绝不冒到顶层 */ }
    });
  }
} catch (eBridge) { /* 总线不可用时仍可显式调 onHurt */ }

// 对外导出：计划 / 目标 / tick / 打断恢复 / 动态队列 / 状态。
module.exports = {
  createPlan: createPlan,
  assignGoal: assignGoal,
  attach: attach,
  tick: tick,
  onHurt: onHurt,
  insertNodes: insertNodes,
  drainQueue: drainQueue,
  status: status,
  reset: reset,
  list: list,
  NODE_TYPES: NODE_TYPES,
  LAYERS: LAYERS
};
