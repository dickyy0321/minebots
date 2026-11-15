// ========================================
// 文件：scripts/selftest-p7.js
// 功能：P7 回归自测——状态机 3.0 三层架构 / 上下文栈 / 看门狗重规划 / 反射层 / 黑板竞价与物资循环 / 命令化与控制台接线
// 依赖：path、fs、os、child_process；项目内模块（都可选，缺了记失败而不崩）
// 导出：run（由 scripts/selftest-p6.js 调用，复用 selftest.js 的 section / expect）
// 作者：MineBots
// ========================================
// 说明 / note：全程注入纯内存假黑板，并把 MINEBOTS_STATE_DIR 指到临时目录，绝不碰真实 state/、绝不联网。
var path = require("path");
var fs = require("fs");
var os = require("os");
var childProcess = require("child_process");
var ROOT = path.join(__dirname, "..");

// 按相对路径安全 require 一个模块；缺失或抛错时返回 null。
function load(rel) {
  try { return require(path.join(ROOT, rel)); } catch (e) { return null; }
}

// 按相对路径读文本；读不到返回空串。
function read(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch (e) { return ""; }
}

// 安全转字符串：null / undefined 统一成空串。
function toText(value) {
  try { return value === null || value === undefined ? "" : String(value); } catch (e) { return ""; }
}

// 异步等待若干毫秒（不 unref，用完由事件循环自然收尾）。
function wait(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// 造一个最小可用的假 bot：带事件监听、控制键、血量，不联网。
function makeBot() {
  var listeners = {};
  var bot = {
    _mbBotId: "p7-bot", username: "P7Bot", health: 20,
    entity: { position: { x: 0, y: 64, z: 0 } }, entities: {},
    controls: {}, activated: false,
    on: function (name, fn) {
      if (!listeners[name]) listeners[name] = [];
      listeners[name].push(fn);
      return bot;
    },
    removeListener: function (name, fn) {
      var list = listeners[name] || [];
      for (var i = list.length - 1; i >= 0; i--) if (list[i] === fn) list.splice(i, 1);
      return bot;
    },
    emit: function (name, payload) {
      var list = listeners[name] || [];
      for (var i = 0; i < list.length; i++) {
        try { list[i](payload); } catch (e) { /* 单个监听报错不影响其它 */ }
      }
      return true;
    },
    setControlState: function (name, on) { bot.controls[name] = on === true; return true; },
    activateItem: function () { bot.activated = true; return true; }
  };
  return bot;
}

// 造一个纯内存假黑板：接口与 shared-board 对齐，竞价 / 物资循环全程不落盘。
function makeBoard() {
  var data = {};
  var tasks = [];
  var seq = 0;
  function copy(value) { try { return JSON.parse(JSON.stringify(value)); } catch (e) { return {}; } }
  return {
    post: function (key, value) { data[String(key)] = copy(value); return { ok: true }; },
    get: function (key, fallback) { return data[String(key)] === undefined ? fallback : copy(data[String(key)]); },
    has: function (key) { return data[String(key)] !== undefined; },
    del: function (key) { delete data[String(key)]; return { ok: true }; },
    keys: function () { return Object.keys(data); },
    snapshot: function () { return copy(data); },
    postTask: function (spec) {
      seq = seq + 1;
      var one = spec && typeof spec === "object" ? spec : {};
      var task = { id: "task-" + seq, title: String(one.title || "task"), priority: Number(one.priority) || 1,
        payload: copy(one.payload || {}), status: "pending", claimedBy: "" };
      tasks.push(task);
      return { ok: true, taskId: task.id, task: copy(task) };
    },
    listTasks: function (filter) {
      var out = [];
      var want = filter && filter.status ? String(filter.status) : "";
      for (var i = 0; i < tasks.length; i++) {
        if (want && tasks[i].status !== want) continue;
        out.push(copy(tasks[i]));
      }
      return out;
    },
    claimTask: function (botId, options) {
      var opts = options && typeof options === "object" ? options : {};
      for (var i = 0; i < tasks.length; i++) {
        if (tasks[i].status !== "pending") continue;
        if (opts.taskId && tasks[i].id !== opts.taskId) continue;
        tasks[i].status = "claimed";
        tasks[i].claimedBy = String(botId);
        return { ok: true, taskId: tasks[i].id, task: copy(tasks[i]), message: "claimed / 已认领" };
      }
      return { ok: false, message: "no pending task / 暂无待领任务" };
    },
    completeTask: function (taskId) {
      for (var i = 0; i < tasks.length; i++) {
        if (tasks[i].id === taskId) { tasks[i].status = "done"; return { ok: true }; }
      }
      return { ok: false, message: "task not found / 任务不存在" };
    },
    taskStats: function () {
      var out = { pending: 0, claimed: 0, done: 0, total: tasks.length };
      for (var i = 0; i < tasks.length; i++) {
        if (out[tasks[i].status] !== undefined) out[tasks[i].status] = out[tasks[i].status] + 1;
      }
      return out;
    }
  };
}

// 常量：本轮交付的全部新文件（静态红线与语法检查用）。
var FILES = [
  "modules/context-stack.js", "modules/replan.js", "modules/state-runtime.js",
  "modules/antiafk.js", "modules/swarm-market.js", "modules/shared-board.js",
  "modules/behavior-tree.js", "modules/motion.js", "modules/swarm-command.js",
  "modules/swarm-console.js", "gui/renderer/panel-swarm.js", "scripts/selftest-p7.js"
];

// 静态红线：文件头 / 行数 / 禁用语法 / 双语 / node --check，缺一项就记失败。
function checkStatic(h) {
  h.section("17a. 状态机 3.0 静态红线 / state machine 3.0 static");
  var bannedOptional = "?" + ".";
  var bannedNullish = "?" + "?";
  var allGood = true;
  var broken = [];
  for (var i = 0; i < FILES.length; i++) {
    var text = read(FILES[i]);
    var ok = text.length > 0 && text.indexOf("// ====") === 0 &&
      text.split("\n").length <= 600 && text.indexOf("// 文件：") >= 0 &&
      text.indexOf(" / ") >= 0 && text.indexOf(bannedOptional) < 0 && text.indexOf(bannedNullish) < 0;
    var syntax = true;
    try {
      childProcess.execFileSync(process.execPath, ["--check", path.join(ROOT, FILES[i])], { cwd: ROOT, encoding: "utf8" });
    } catch (e) { syntax = false; }
    if (!ok || !syntax) { allGood = false; broken.push(FILES[i] + (syntax ? "" : "(syntax)")); }
  }
  h.expect("12 个交付文件全部通过文件头 / 行数 / 双语 / 禁用语法 / node --check", allGood, broken.join(","));
  var rt = read("modules/state-runtime.js");
  h.expect("三层常量与反射恢复入口齐全",
    rt.indexOf("STRATEGIC") >= 0 && rt.indexOf("TACTICAL") >= 0 && rt.indexOf("REFLEX") >= 0 &&
    rt.indexOf("function onHurt") >= 0 && rt.indexOf("function tick") >= 0, "layers");
  var bt = read("modules/behavior-tree.js");
  h.expect("Parallel 用 Promise.all 真并发，不是旧串行循环",
    bt.indexOf("function runParallel") >= 0 && bt.indexOf("Promise.all(jobs)") >= 0, "parallel");
  var board = read("modules/shared-board.js");
  h.expect("黑板生态门面把 13 个能力挂到导出上",
    board.indexOf("marketCall(") >= 0 && board.indexOf("postDemand:") >= 0 && board.indexOf("deliver:") >= 0, "facade");
}

// 上下文栈：压栈 / 冻结 / 窥顶 / 出栈 / 深度 / 清空，异常输入不崩。
function checkStack(h) {
  h.section("17b. 上下文栈 / context stack");
  var stack = load("modules/context-stack.js");
  if (!stack) { h.expect("context-stack 可加载", false, "require failed"); return; }
  stack.clearAll();
  var frame = { goal: "挖矿 / mine", progress: ["get_wood"], done: { "0.0": true }, blackboard: { steps: 1 } };
  var pushed = stack.push("p7-stack", frame, "entityHurt / 受击");
  h.expect("压栈返回 ok:true 且深度为 1", pushed.ok === true && pushed.depth === 1, JSON.stringify(pushed.message));
  h.expect("栈顶帧保留进度 / 黑板 / 原因",
    stack.peek("p7-stack") && stack.peek("p7-stack").progress[0] === "get_wood" &&
    stack.peek("p7-stack").blackboard.steps === 1 && stack.peek("p7-stack").reason.indexOf("受击") >= 0, "frame");
  var frozen = stack.freeze("p7-stack", { name: "craft" }, ["a", "b"], "combat / 战斗");
  h.expect("冻结进度是 push 的语义封装", frozen.ok === true && frozen.depth === 2, "freeze");
  var popped = stack.pop("p7-stack");
  h.expect("出栈交还上一帧且深度回到 1",
    popped.ok === true && popped.depth === 1 && popped.frame.progress.length === 2 && popped.restored === true, "pop");
  var st = stack.status("p7-stack");
  h.expect("状态快照含 pushes / pops / 深度", st.ok === true && st.depth === 1 && st.pushes >= 2 && st.pops === 1, JSON.stringify(st));
  h.expect("空栈出栈返回 ok:false 而不是抛错", stack.pop("p7-none").ok === false, "empty");
  h.expect("坏入参也能压一条空帧", stack.push("p7-bad", null, null).ok === true, "bad frame");
  h.expect("快照是副本，改它不会污染栈", (function () {
    var snap = stack.snapshot();
    var before = stack.depth("p7-stack");
    snap["p7-stack"] = [];
    return stack.depth("p7-stack") === before;
  })(), "snapshot copy");
  stack.clearAll();
  h.expect("clearAll 后所有栈为空", stack.depth("p7-stack") === 0 && stack.depth("p7-bad") === 0, "clearAll");
}

// 行为树：Parallel 真并发 / interrupt 保留进度 / resume 跳过已完成节点。
async function checkTree(h) {
  h.section("17c. 行为树并发与断点 / parallel & resume");
  var bt = load("modules/behavior-tree.js");
  var eng = load("modules/engine-control.js");
  if (!bt) { h.expect("behavior-tree 可加载", false, "require failed"); return; }
  if (eng) eng.reset();
  h.expect("行为树引擎默认开启", bt.isEngineEnabled() === true, "engine");
  var startedA = false, startedB = false, finishedA = false, concurrent = false;
  var made = bt.create({ type: "parallel", children: [
    { type: "action", fn: async function () { startedA = true; await wait(12); finishedA = true; return true; } },
    { type: "action", fn: async function () { startedB = true; if (!finishedA) concurrent = true; await wait(12); return true; } }
  ] }, { name: "p7-parallel" });
  var res = await bt.tick(made.tree, {});
  h.expect("两个并行分支都在同一 tick 内起跑", startedA === true && startedB === true && res.ok === true, JSON.stringify(res));
  h.expect("第二个分支在第一个完成前就启动（真并发）", concurrent === true, "serial loop detected");
  var log = [];
  var seq = bt.create({ type: "sequence", children: [
    { type: "action", fn: function () { log.push("a"); return true; } },
    { type: "action", fn: function () { log.push("b"); return true; } }
  ] }, { name: "p7-seq" });
  var first = await bt.tick(seq.tree, {});
  h.expect("顺序树一次跑完两步", first.ok === true && log.length === 2, JSON.stringify(first));
  var cut = bt.interrupt(seq.tree, "p7 test / 自测打断");
  h.expect("interrupt 保留两位已完成节点", cut.ok === true && cut.done === 2, JSON.stringify(cut));
  var again = await bt.resume(seq.tree, {});
  h.expect("resume 跳过已完成节点，不重跑动作", again.ok === true && again.skipped >= 2 && log.length === 2, JSON.stringify(again));
  h.expect("树状态快照含 done / interrupts", (function () {
    var s = bt.status(seq.tree);
    return !!s && s.done === 2 && s.interrupts === 1;
  })(), "status");
}

// 三层运行时：目标编译 / tick / 受击打断恢复 / 动态队列 / 断点续跑 / 重置。
async function checkRuntime(h) {
  h.section("17d. 三层运行时 / three-layer runtime");
  var rt = load("modules/state-runtime.js");
  if (!rt) { h.expect("state-runtime 可加载", false, "require failed"); return; }
  var plan = rt.createPlan("砍树 / chop tree", {});
  h.expect("宏观目标编译成至少 2 步战术链", plan.ok === true && plan.steps.length >= 2, JSON.stringify(plan.steps));
  var hit = rt.assignGoal("p7-run", "挖矿 / mine", {});
  h.expect("战略层下达目标并登记运行时", hit.ok === true && rt.status("p7-run").goal.indexOf("挖矿") >= 0, JSON.stringify(hit.message));
  var ticked = await rt.tick("p7-run", {});
  h.expect("战术层一个 tick 跑完整条链", ticked.ok === true && ticked.ran >= 1, JSON.stringify(ticked));
  var hurt = await rt.onHurt("p7-run", { source: "zombie" }, {});
  h.expect("反射层受击后冻结合成进度并恢复",
    hurt.ok === true && hurt.restored === true && hurt.frozen && Array.isArray(hurt.frozen.progress), JSON.stringify(hurt.message));
  h.expect("防御 selector 走本地举盾，不发 AI 请求",
    hurt.defense === "success" && hurt.defenseActions.indexOf("local_shield") >= 0, JSON.stringify(hurt.defenseActions));
  h.expect("恢复时跳过已完成步骤，不重做合成", hurt.skipped >= 1, JSON.stringify({ skipped: hurt.skipped }));
  var st = rt.status("p7-run");
  h.expect("状态快照记录受击 / 恢复 / 栈已清空", st.hurts === 1 && st.restores === 1 && st.stackDepth === 0, JSON.stringify({ hurts: st.hurts, restores: st.restores, depth: st.stackDepth }));
  var ins = rt.insertNodes("p7-run", [{ id: "n1", action: "explore", args: { seconds: 5 } }, null, { bad: true }]);
  h.expect("动态节点入队，坏节点被跳过", ins.ok === true && ins.inserted === 1, JSON.stringify(ins));
  var drained = rt.drainQueue("p7-run");
  h.expect("队列可取出且取出后清空", drained.length === 1 && rt.status("p7-run").queue === 0, JSON.stringify(drained));
  var paused = rt.createPlan("建房子 / build house", { pauseAt: 1 });
  rt.attach("p7-resume", paused, {});
  var t1 = await rt.tick("p7-resume", {});
  var logAfterFirst = paused.log.length;
  var t2 = await rt.tick("p7-resume", {});
  h.expect("合成第一步挂起时后续步骤不执行", t1.status === "running" && logAfterFirst === 1, JSON.stringify({ status: t1.status, log: logAfterFirst }));
  h.expect("下一次 tick 从断点继续跑完整条链", t2.ok === true && paused.log.length > logAfterFirst, JSON.stringify({ status: t2.status, log: paused.log.length }));
  h.expect("未登记的 bot 返回 no-runtime 而不是抛错", (await rt.tick("p7-none", {})).ok === false, "no runtime");
  h.expect("reset 清空运行时与上下文栈", rt.reset("p7-run").ok === true && rt.status("p7-run").ok === false, "reset");
  rt.reset("p7-resume");
}

// 看门狗与 AI 兜底：失败累计 3 次 / tool_calls 校验 / 注入假 AI / 离线降级 / 队列。
async function checkReplan(h) {
  h.section("17e. 看门狗与 AI 重规划 / watchdog & ai replan");
  var rp = load("modules/replan.js");
  if (!rp) { h.expect("replan 可加载", false, "require failed"); return; }
  rp.reset();
  var f1 = rp.recordFailure("p7-rp", "mine", "no iron / 找不到铁矿", {});
  var f2 = rp.recordFailure("p7-rp", "mine", "no iron / 找不到铁矿", {});
  var f3 = rp.recordFailure("p7-rp", "mine", "no iron / 找不到铁矿", {});
  h.expect("失败累计到第 3 次触发重规划", f1.needsReplan === false && f2.needsReplan === false && f3.needsReplan === true, "threshold");
  var ctx = rp.buildContext({ current_action: "mine", error: "no iron", inventory: { pickaxe: 1 }, position: { x: 1, y: 64, z: 2 } }, "p7-rp");
  h.expect("上下文补齐动作 / 错误 / 背包 / 坐标 / 次数",
    ctx.current_action === "mine" && ctx.inventory.pickaxe === 1 && ctx.position.x === 1 && ctx.attempts === 3, JSON.stringify(ctx));
  var good = { message: { tool_calls: [
    { id: "c1", function: { name: "explore", arguments: "{\"seconds\":5}" } },
    { id: "c2", function: { name: "get_wood", arguments: {} } }
  ] } };
  var checked = rp.validateCalls(good);
  h.expect("合法 tool_calls 通过校验并映射成动作", checked.ok === true && checked.calls.length === 2 && checked.calls[1].action === "dig_tree", JSON.stringify(checked));
  h.expect("未知工具被拒", rp.validateCalls({ message: { tool_calls: [{ function: { name: "nuke", arguments: "{}" } }] } }).ok === false, "unknown tool");
  h.expect("坏 JSON 参数被拒", rp.validateCalls({ message: { tool_calls: [{ function: { name: "explore", arguments: "{oops" } }] } }).ok === false, "bad json");
  h.expect("空 tool_calls 被拒", rp.validateCalls({ message: {} }).ok === false, "empty");
  h.expect("toNodes 把校验结果转成状态机节点", rp.toNodes(checked.calls).length === 2, "nodes");
  h.expect("坏输入转节点降级为默认 explore", rp.toNodes(null)[0].action === "explore", "fallback node");
  var fakeAi = { askWithTools: function () { return good; } };
  rp.setAiClient(fakeAi);
  var applied = await rp.aiReplan("p7-rp", ctx, {});
  h.expect("注入假 AI 后重规划成功（不联网）", applied.ok === true && applied.source === "ai" && applied.nodes.length === 2, JSON.stringify(applied.message));
  h.expect("重规划节点进了动态队列", rp.queueSize("p7-rp") === 2 && rp.drain("p7-rp").length === 2, "queue");
  var offline = await rp.aiReplan("p7-rp", ctx, { offline: true });
  h.expect("离线模式降级为默认动作", offline.ok === true && offline.source === "fallback" && offline.nodes[0].action === "explore", JSON.stringify(offline.reason));
  rp.setAiClient(null);
  var badAi = { askWithTools: function () { return { message: { tool_calls: [{ function: { name: "nuke", arguments: "{}" } }] } }; } };
  rp.setAiClient(badAi);
  var invalid = await rp.aiReplan("p7-rp", ctx, {});
  h.expect("非法回包降级，绝不插入未知动作", invalid.source === "fallback" && invalid.nodes.length === 1, JSON.stringify(invalid.reason));
  var stats = rp.stats("p7-rp");
  h.expect("统计含重规划 / 成功 / 降级 / 非法次数", stats.replans >= 3 && stats.aiOk === 1 && stats.fallbacks >= 2 && stats.invalid >= 1, JSON.stringify(stats));
  rp.setAiClient(null);
  rp.reset();
}

// 反射层：本地闪避 / 举盾 / 挂载事件 / 节流 / 物理帧 / aiCalls 恒为 0。
function checkReflex(h) {
  h.section("17f. 反射层 / reflex layer");
  var afk = load("modules/antiafk.js");
  var motion = load("modules/motion.js");
  if (!afk || !motion) { h.expect("antiafk 与 motion 可加载", false, "require failed"); return; }
  afk.reset();
  var bot = makeBot();
  var dodge = motion.localDodge(bot, { direction: "left" });
  var shield = motion.localShield(bot, {});
  h.expect("运动学层本地闪避 / 举盾都同步完成",
    dodge.ok === true && dodge.action === "local_dodge" && shield.ok === true && shield.action === "local_shield", "local");
  h.expect("本地反射带手抖与耗时，不经网络", dodge.jitter !== undefined && dodge.latencyMs >= 0 && bot.activated === true, "latency");
  var attached = motion.attachReflex(bot, {});
  h.expect("运动学反射挂 entityHurt + physicsTick 两个事件", attached.ok === true && attached.events === 2, JSON.stringify(attached));
  bot.emit("entityHurt", { source: "zombie" });
  bot.emit("physicsTick", {});
  var mst = motion.reflexStats(bot);
  h.expect("运动学反射统计记录受击与物理帧", mst.attached === true && mst.hurts === 1 && mst.physics === 1 && mst.actions.length === 1, JSON.stringify(mst));
  motion.detachReflex(bot);
  h.expect("卸载后不再有会话", motion.reflexStats(bot).attached === false, "detach");
  var own = makeBot();
  var bind = afk.attach(own, "p7-reflex", {});
  h.expect("反射层挂到 bot（两个事件）", bind.ok === true && bind.events === 2, JSON.stringify(bind));
  var first = afk.simulateHurt("p7-reflex", { action: "local_shield", source: "creeper" });
  h.expect("受击立刻本地举盾，AI 调用为 0", first.ok === true && first.action === "local_shield" && first.aiCalls === 0, JSON.stringify(first));
  var second = afk.simulateHurt("p7-reflex", { action: "local_dodge" });
  h.expect("同一时间窗内第二次受击被节流", second.ok === false && second.throttled === true, JSON.stringify(second));
  var physics = afk.simulatePhysics("p7-reflex", 40);
  h.expect("物理帧计数且产生防挂机微动作", physics.ticks === 40 && physics.acted > 0, JSON.stringify(physics));
  var st = afk.stats("p7-reflex");
  h.expect("反射统计 hurts / shields / aiCalls 正确", st.hurts === 1 && st.shields === 1 && st.aiCalls === 0, JSON.stringify(st));
  h.expect("卸载摘掉两个监听", afk.detach("p7-reflex").removed === 2, "detach");
  afk.reset();
}

// 黑板竞价与物资循环：全程注入纯内存假 board，不碰磁盘。
function checkMarket(h) {
  h.section("17g. 黑板竞价与物资循环 / bidding & logistics");
  var board = load("modules/shared-board.js");
  var market = load("modules/swarm-market.js");
  if (!board || !market) { h.expect("shared-board 与 swarm-market 可加载", false, "require failed"); return; }
  var mem = makeBoard();
  market.setBoard(mem);
  market.reset();
  h.expect("黑板导出 13 个生态门面能力", (function () {
    var names = ["postDemand", "postSupply", "listDemand", "listSupply", "matchSupply", "postBigTask",
      "bid", "runAuction", "onInventoryFull", "claimHaul", "deliver", "ecosystem", "registerBot"];
    for (var i = 0; i < names.length; i++) if (typeof board[names[i]] !== "function") return false;
    return true;
  })(), "facade exports");
  var demand = market.postDemand("p7-a", { wood: 32, stone: 16 });
  var supply = market.postSupply("p7-b", { wood: 64, stone: 32 }, { x: 10, y: 64, z: 0 });
  h.expect("需求单 / 供给单都能挂到黑板", demand.ok === true && supply.ok === true, "post");
  h.expect("门面转发的挂单能列出来", board.listDemand().length === 1 && board.listSupply().length === 1, "facade list");
  var matched = market.matchSupply();
  h.expect("供需撮合生成 haul 搬运任务", matched.ok === true && matched.matches >= 1 && matched.taskIds.length >= 1, JSON.stringify(matched));
  var big = market.postBigTask({ count: 5, block: "planks" });
  h.expect("大任务拆成 5 个子任务", big.ok === true && big.count === 5 && big.taskIds.length === 5, JSON.stringify(big.count));
  h.expect("拆单硬上限 200 生效", market.postBigTask({ count: 999 }).count <= 200, "cap");
  market.registerBot("p7-c", { position: { x: 0, y: 0, z: 0 }, load: 0, status: "idle" });
  var bid = market.bid("p7-c", { position: { x: 0, y: 0, z: 0 }, load: 0, status: "idle" });
  h.expect("空闲 bot 竞价抢到分最高的任务", bid.ok === true && bid.taskId.length > 0, JSON.stringify(bid));
  var auction = market.runAuction([{ botId: "p7-d", position: { x: 1, y: 0, z: 1 }, load: 0, status: "idle" }]);
  h.expect("全蜂群一轮竞价返回参与者与分配", auction.ok === true && auction.participants === 1, JSON.stringify(auction));
  var full = market.onInventoryFull("p7-e", { iron: 10 }, { x: 5, y: 64, z: 5 });
  h.expect("背包满自动挂供给并生成搬运单", full.ok === true && full.taskId.length > 0, JSON.stringify(full));
  var haul = market.claimHaul("p7-f", {});
  h.expect("搬运 bot 能抢到 haul 任务", haul.ok === true && haul.task.title === "haul", JSON.stringify(haul.message));
  var delivered = market.deliver("p7-f", haul.taskId, { iron: 10 });
  h.expect("物资入库并结单", delivered.ok === true && delivered.warehouse.iron === 10, JSON.stringify(delivered.warehouse));
  var eco = market.ecosystem();
  h.expect("生态统计含挂单 / 任务 / 仓库 / 累计次数",
    eco.ok === true && eco.demands >= 1 && eco.supplies >= 2 && eco.pending >= 1 && eco.deliveries >= 1, JSON.stringify(eco));
  h.expect("门面 ecosystem 与底层同源", board.ecosystem().deliveries === eco.deliveries, "facade ecosystem");
  market.setBoard(null);
  market.reset();
}

// 命令化：文本解析 / 别名 / 物资串 / 清单 / 执行 / command-handler 真链路。
async function checkCommand(h) {
  h.section("17h. 命令化与动作分派 / command layer");
  var cmd = load("modules/swarm-command.js");
  var handler = load("modules/command-handler.js");
  if (!cmd || !handler) { h.expect("swarm-command 与 command-handler 可加载", false, "require failed"); return; }
  var p1 = cmd.parse("#goal 挖矿");
  h.expect("解析 #goal 文本得到命令名与参数", p1.ok === true && p1.name === "goal" && p1.raw === "挖矿", JSON.stringify(p1));
  h.expect("swarm_ 前缀与短别名都能解析", cmd.parse("swarm_bid").name === "bid" && cmd.parse("#g 建房子").name === "goal", "alias");
  h.expect("未知指令返回 ok:false", cmd.parse("#nope").ok === false, "unknown");
  h.expect("空文本返回 ok:false", cmd.parse("  ").ok === false, "empty");
  h.expect("isSwarm 只拦 swarm_ 前缀，不碰既有动作", cmd.isSwarm("swarm_status") === true && cmd.isSwarm("stop") === false, "prefix");
  var items = cmd.parseItems("wood:32,stone:16");
  h.expect("物资串解析成数量字典", items.wood === 32 && items.stone === 16, JSON.stringify(items));
  h.expect("坏物资串返回空对象", Object.keys(cmd.parseItems("")).length === 0, "bad items");
  h.expect("指令清单至少 18 条且都是 # 用法", cmd.list().length >= 18 && cmd.list()[0].usage.charAt(0) === "#", "list");
  var st = await cmd.execute("status", { botId: "p7-cmd" });
  h.expect("status 命令回 ok:true 与三层聚合", st.ok === true && st.data && st.data.strategic !== undefined, JSON.stringify(st.message));
  var goal = await cmd.handle("#goal 砍树", { botId: "p7-cmd" });
  h.expect("文本命令能直接下达战略层目标", goal.ok === true && goal.command === "goal", JSON.stringify(goal.message));
  var run = await cmd.run("swarm_status", makeBot(), { botId: "p7-cmd" });
  h.expect("run 压成 command-handler 需要的结构", run.ok === true && run.error === null && run.action === "swarm_status", JSON.stringify(run));
  var bad = await cmd.run("swarm_nope", makeBot(), {});
  h.expect("不认识的 swarm 动作回 ok:false 而不是抛错", bad.ok === false && bad.error.length > 0, JSON.stringify(bad));
  var real = await handler.executeAction(makeBot(), "swarm_status", { botId: "p7-cmd" });
  h.expect("command-handler 真链路：swarm_status 走新分派", real.ok === true, JSON.stringify(real));
  var normal = await handler.executeAction(null, "stop", {});
  h.expect("原有动作链路没被破坏（无 bot 仍回 ok:false）", normal.ok === false, JSON.stringify(normal));
  var src = read("modules/command-handler.js");
  h.expect("执行器只加一行分派，可选依赖降级",
    src.indexOf("require(\"./swarm-command\")") >= 0 && src.indexOf("swarmCmd.isSwarm(name)") >= 0, "wiring");
}

// 主进程门面 + IPC 真链路：状态 / 清单 / 文本命令 / 反射挂载 / reset。
async function checkConsole(h) {
  h.section("17i. 蜂群控制台主进程链路 / console IPC chain");
  var con = load("modules/swarm-console.js");
  var ipc = load("gui/ipc-extra.js");
  if (!con || !ipc) { h.expect("swarm-console 与 ipc-extra 可加载", false, "require failed"); return; }
  var snap = con.status("p7-cmd");
  h.expect("状态门面返回三层快照与提示", snap.ok === true && snap.status && snap.hint.length > 0, JSON.stringify(snap.message));
  var cmds = con.commands();
  h.expect("清单门面返回至少 18 条指令", cmds.ok === true && cmds.commands.length >= 18, JSON.stringify(cmds.ok));
  var help = await con.handle({ botId: "p7-cmd", text: "#help" });
  h.expect("控制台执行 #help 回包带 command / data / status",
    help.ok === true && help.command === "help" && Array.isArray(help.data) && help.status, JSON.stringify(help.message));
  var eco = await con.handle({ botId: "p7-cmd", text: "#ecosystem" });
  h.expect("控制台执行 #ecosystem 走黑板生态", eco.ok === true && eco.data, JSON.stringify(eco.message));
  var empty = await con.handle({ botId: "p7-cmd", text: "" });
  h.expect("空指令回 ok:false 双语提示", empty.ok === false && empty.message.indexOf(" / ") >= 0, JSON.stringify(empty.message));
  var bot = makeBot();
  var a1 = con.attachBot(bot, "p7-cmd");
  var a2 = con.attachBot(bot, "p7-cmd");
  h.expect("attachBot 幂等，不重复挂监听", a1.ok === true && a1.attached === true && a2.ok === true && bot._mbSwarmReflex === true, JSON.stringify(a1));
  h.expect("reset 清空内存状态但不抛错", con.reset("p7-cmd").ok === true, "reset");
  var requests = {};
  var api = {
    getWindow: function () { return null; },
    listBots: function () { return []; },
    botOf: function (id) { return id === "p7-cmd" ? bot : null; },
    onRequest: function (channel, reply, fn) { requests[channel] = fn; return true; },
    onSend: function () { return true; }
  };
  ipc.register(api);
  var handler = requests["swarm-console"];
  h.expect("主进程注册了 swarm-console 请求通道", typeof handler === "function", JSON.stringify(Object.keys(requests)));
  if (typeof handler === "function") {
    var reply = await handler(null, { botId: "p7-cmd", text: "#status" });
    h.expect("IPC 真链路：文本命令回 ok:true", reply && reply.ok === true && reply.command === "status", JSON.stringify(reply && reply.message));
    var statusReply = await handler(null, { botId: "p7-cmd", action: "status" });
    h.expect("IPC 真链路：action=status 回三层快照", statusReply && statusReply.ok === true && statusReply.status, JSON.stringify(statusReply && statusReply.message));
    var cmdReply = await handler(null, { botId: "p7-cmd", action: "commands" });
    h.expect("IPC 真链路：action=commands 回指令清单", cmdReply && cmdReply.ok === true && cmdReply.commands.length >= 18, "commands");
  }
}

// 渲染层静态接线：通道三件套 / 面板容器 / 脚本 / 双语 / 样式 / 幂等初始化。
function checkUi(h) {
  h.section("17j. 蜂群控制台 GUI 接线 / console UI wiring");
  var preload = read("gui/preload.js");
  var apiJs = read("gui/renderer/api.js");
  var app = read("gui/renderer/app.js");
  var html = read("gui/renderer/settings.html");
  var css = read("gui/renderer/style.css");
  var panel = read("gui/renderer/panel-swarm.js");
  var extra = read("gui/ipc-extra.js");
  h.expect("IPC 通道三件套同名：ipc-extra / preload / api",
    extra.indexOf("swarm-console-data") >= 0 && preload.indexOf("swarm-console-data") >= 0 &&
    apiJs.indexOf("swarmConsole") >= 0 && apiJs.indexOf("onSwarmConsole") >= 0, "channels");
  h.expect("preload 暴露 swarmConsole 与回包监听",
    preload.indexOf("swarmConsole: function") >= 0 && preload.indexOf("onSwarmConsole: function") >= 0, "preload api");
  h.expect("app.js 幂等初始化蜂群面板", app.indexOf("window.panelSwarm") >= 0 && app.indexOf("panelSwarm.init()") >= 0, "init");
  h.expect("index.html 有容器 / 双语标题 / 脚本引入",
    html.indexOf('id="swarmPane"') >= 0 && html.indexOf('id="swarmPanel"') >= 0 &&
    html.indexOf("蜂群控制台 / Swarm Console") >= 0 && html.indexOf("panel-swarm.js") >= 0, "html");
  h.expect("样式包含蜂群面板与新手模式隐藏", css.indexOf(".swarm-pane") >= 0 && css.indexOf("mode-novice .swarm-pane") >= 0, "css");
  h.expect("面板脚本导出 init / build / send / refresh / render / stats",
    panel.indexOf("window.panelSwarm") >= 0 && panel.indexOf("function init") >= 0 && panel.indexOf("function render") >= 0 &&
    panel.indexOf("function build") >= 0 && panel.indexOf("function stats") >= 0, "panel exports");
  h.expect("面板只用 window.api，不 require 主进程模块",
    panel.indexOf("window.api.swarmConsole") >= 0 && panel.indexOf("require(") < 0, "no require");
  h.expect("面板中英双语状态行与命令提示",
    panel.indexOf("目标 / goal") >= 0 && panel.indexOf(" #help") >= 0, "bilingual");
}

// 主流程：隔离 state 目录 → 恢复默认引擎 → 依次跑十个分组 → 收尾恢复环境。
async function run(h) {
  var oldDir = process.env.MINEBOTS_STATE_DIR;
  var tmp = "";
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mb-p7-state-"));
    process.env.MINEBOTS_STATE_DIR = tmp;
  } catch (e) { tmp = ""; }
  var eng = load("modules/engine-control.js");
  if (eng) eng.reset();
  try { checkStatic(h); } catch (e1) { h.expect("17a 未抛错", false, String(e1)); }
  try { checkStack(h); } catch (e2) { h.expect("17b 未抛错", false, String(e2)); }
  try { await checkTree(h); } catch (e3) { h.expect("17c 未抛错", false, String(e3)); }
  try { await checkRuntime(h); } catch (e4) { h.expect("17d 未抛错", false, String(e4)); }
  try { await checkReplan(h); } catch (e5) { h.expect("17e 未抛错", false, String(e5)); }
  try { checkReflex(h); } catch (e6) { h.expect("17f 未抛错", false, String(e6)); }
  try { checkMarket(h); } catch (e7) { h.expect("17g 未抛错", false, String(e7)); }
  try { await checkCommand(h); } catch (e8) { h.expect("17h 未抛错", false, String(e8)); }
  try { await checkConsole(h); } catch (e9) { h.expect("17i 未抛错", false, String(e9)); }
  try { checkUi(h); } catch (e10) { h.expect("17j 未抛错", false, String(e10)); }
  try {
    var market = load("modules/swarm-market.js");
    var rt = load("modules/state-runtime.js");
    var afk = load("modules/antiafk.js");
    var rp = load("modules/replan.js");
    if (market) { market.setBoard(null); market.reset(); }
    if (rt) { rt.reset("p7-run"); rt.reset("p7-resume"); rt.reset("p7-cmd"); }
    if (afk) afk.reset();
    if (rp) rp.reset();
  } catch (e11) { /* 收尾失败不影响汇总 */ }
  try {
    if (oldDir === undefined) delete process.env.MINEBOTS_STATE_DIR;
    else process.env.MINEBOTS_STATE_DIR = oldDir;
  } catch (e12) { /* 环境变量恢复失败不影响汇总 */ }
  try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch (e13) { /* 临时目录清不掉不影响主流程 */ }
}

module.exports = { run: run };
