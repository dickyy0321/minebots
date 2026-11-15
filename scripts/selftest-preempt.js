// ========================================
// 文件：scripts/selftest-preempt.js
// 功能：抢占回归自测——新指令必须彻底销毁旧的持续任务（follow -> dig_tree 砍完后必须原地空闲，不许自己跟回去）
// 依赖：path；../modules/command-handler、../modules/ai-tools、../modules/task-queue（都可选，缺了就跳过对应断言）
// 导出：run（由 scripts/selftest.js 调用，复用它的 section / expect / 造机器人工厂）
// 作者：MineBots
// ========================================
// 说明 / note：这一组用例只验「旧任务有没有被彻底销毁」，不改任何业务代码路径。
var path = require("path");
var ROOT = path.join(__dirname, "..");

// 数一数控制键记录里某个值出现几次（断言「不再自己按前进」用）；入参不是数组时返回 0。
function countOf(list, word) {
  try {
    if (!list || typeof list.length !== "number") return 0;
    var total = 0;
    for (var i = 0; i < list.length; i++) if (list[i] === word) total = total + 1;
    return total;
  } catch (err) { return 0; }
}

// 造一个记录得很全的假 pathfinder：setGoal 记目标、stop 清目标，等价于官方插件的闸门行为。
// log.goals 只记真目标（null 不算），用来断言「砍完树后没有再把 GoalFollow 挂回来」。
function makePathfinder(log) {
  var pf = { goal: null };
  pf.setMovements = function () { return true; };
  pf.setGoal = function (goal) {
    pf.goal = goal;
    if (goal) log.goals.push(goal.rangeSq);
    return true;
  };
  pf.isMoving = function () { return false; };
  pf.stop = function () { pf.goal = null; return true; };
  return pf;
}

// 按名字安全 require 一个模块；缺失或抛错时返回 null（不拖垮整轮自检）。
function tryRequire(rel) {
  try { return require(path.join(ROOT, rel)); } catch (err) { return null; }
}

// 主流程：四项回归——命令层 follow -> dig_tree、退化跟随的定时器、AI 工具链同样抢占、队列清场。
async function run(h) {
  var handler = tryRequire("modules/command-handler.js");
  var expect = h.expect;

  // ---------- 1. 命令层：follow -> dig_tree，砍完必须原地空闲 ----------
  h.section("12a. 新指令销毁旧跟随 / new command kills follow");
  if (handler === null) {
    expect("command-handler 能 require", false, "modules/command-handler.js 缺失");
  } else {
    var pfLog = { goals: [] };
    var pfBot = h.makeBot({
      x: 0, y: 64, z: 0,
      blocks: [h.makeBlock("oak_log", 3, 64, 0)],
      entities: { "1": h.makeEntity(1, "player", "Alex", 6, 64, 0, { username: "Alex" }) }
    });
    pfBot._mbMoves = { allowSprinting: true, allowParkour: true, canDig: false };
    pfBot.pathfinder = makePathfinder(pfLog);
    var pfFollow = await handler.executeAction(pfBot, { action: "follow", players: ["Alex"] });
    var pfAlive = pfBot._mbFollow !== null && pfLog.goals.length === 1;
    var pfDig = await handler.executeAction(pfBot, { action: "dig_tree" });
    await h.wait(1200); // 多等一整拍跟随心跳：定时器要是没被杀掉，它会把 GoalFollow 再挂回来
    expect("follow -> dig_tree：跟随定时器 / 寻路目标都没活下来（砍完原地站住）",
      pfAlive === true && pfFollow.ok === true && pfDig.ok === true && pfBot.records.dig.length >= 1 &&
      pfBot._mbFollow === null && pfBot._mbGaze === null && pfBot.pathfinder.goal === null && pfLog.goals.length === 1,
      JSON.stringify({ follow: pfFollow, dig: pfDig, goals: pfLog.goals }));
  }

  // ---------- 2. 退化跟随：没有寻路插件时，定时器也必须被彻底 clearInterval ----------
  if (handler !== null) {
    var simpleBot = h.makeBot({
      x: 0, y: 64, z: 0,
      blocks: [h.makeBlock("birch_log", 3, 64, 0)],
      entities: { "2": h.makeEntity(2, "player", "Alex", 6, 64, 0, { username: "Alex" }) }
    });
    var simpleFollow = await handler.executeAction(simpleBot, { action: "follow", players: ["Alex"] });
    var simpleFwd = countOf(simpleBot.records.controls, "forward=1");
    var simpleDig = await handler.executeAction(simpleBot, { action: "dig_tree" });
    var fwdAfterDig = countOf(simpleBot.records.controls, "forward=1");
    await h.wait(1200); // 定时器活着的话这一拍必然再按一次前进
    expect("退化跟随：砍树时定时器被 clearInterval 销毁（不再自己按前进）",
      simpleFollow.ok === true && simpleFwd === 1 && simpleDig.ok === true &&
      simpleBot._mbFollow === null && countOf(simpleBot.records.controls, "forward=1") === fwdAfterDig &&
      simpleBot.records.controls.indexOf("forward=0") >= 0,
      JSON.stringify(simpleBot.records.controls));
  }

  // ---------- 3. AI 工具链：真实 bug 路径——executeTool(follow) 之后 executeTool(dig_tree) ----------
  h.section("12b. AI 工具链同样抢占 / ai-tools preempt");
  var tools = tryRequire("modules/ai-tools.js");
  if (tools === null) {
    expect("ai-tools 能 require", false, "modules/ai-tools.js 缺失");
  } else {
    var aiLog = { goals: [] };
    var aiBot = h.makeBot({
      x: 0, y: 64, z: 0,
      blocks: [h.makeBlock("oak_log", 2, 64, 0)],
      entities: { "3": h.makeEntity(3, "player", "Alex", 5, 64, 0, { username: "Alex" }) }
    });
    aiBot._mbMoves = { allowSprinting: true, allowParkour: true, canDig: false };
    aiBot.pathfinder = makePathfinder(aiLog);
    var aiFollowText = await tools.executeTool(aiBot, "follow", { players: ["Alex"] });
    var aiAlive = aiBot._mbFollow !== null && aiLog.goals.length === 1;
    var aiDigText = await tools.executeTool(aiBot, "dig_tree", { blocks: 1 });
    await h.wait(1200);
    expect("AI 工具链 follow -> dig_tree 不再自动跟回去（本次 bug 回归）",
      aiAlive === true && aiFollowText.indexOf("成功") === 0 && aiDigText.indexOf("成功") === 0 &&
      aiBot._mbFollow === null && aiBot.pathfinder.goal === null && aiLog.goals.length === 1,
      aiFollowText + " | " + aiDigText + " | goals=" + aiLog.goals.length);
    var clearsBeforeQuery = countOf(aiBot.records.controls, "clear");
    var aiQueryText = await tools.executeTool(aiBot, "get_position", {});
    expect("纯查询工具不抢占（问坐标不该打断手里的活）",
      aiQueryText.indexOf("执行失败") < 0 && countOf(aiBot.records.controls, "clear") === clearsBeforeQuery,
      aiQueryText + " / clears=" + countOf(aiBot.records.controls, "clear"));
  }

  // ---------- 4. 任务队列：新指令入队先清空遗留，follow 例外 ----------
  h.section("12c. 队列清场 / drop stale queue");
  var tq = tryRequire("modules/task-queue.js");
  if (tq === null) {
    expect("task-queue 能 require", false, "modules/task-queue.js 缺失");
  } else {
    tq.clearQueue("q1");
    var qMove = tq.addTask("q1", { action: "move" });
    var qDigFirst = tq.addTask("q1", { action: "dig_tree" });
    var qFollow = tq.addTask("q1", { action: "follow", params: { players: ["Alex"] } });
    var qKept = tq.getQueue("q1").length;
    var qDig = tq.addTask("q1", { action: "dig_tree" });
    var qLeft = tq.getQueue("q1");
    expect("新指令（非 follow）入队时先清空遗留队列",
      qMove.cleared === 0 && qDigFirst.cleared === 1 && qFollow.cleared === 0 && qKept === 2 &&
      qDig.cleared === 2 && qLeft.length === 1 && qLeft[0].action === "dig_tree",
      JSON.stringify({ move: qMove.cleared, dig1: qDigFirst.cleared, follow: qFollow.cleared, kept: qKept, dig2: qDig.cleared, left: qLeft }));
    var qSkip = tq.clearLeftovers("q1", "follow");
    expect("follow 不清队列（长线任务允许排队等）",
      qSkip.ok === true && qSkip.cleared === 0 && qSkip.skipped === "long-task" && tq.getQueue("q1").length === 1,
      JSON.stringify(qSkip));
    tq.addTask("QueueBot", { action: "move" });
    var qBotClear = tq.clearLeftovers(h.makeBot({ username: "QueueBot" }), "attack");
    expect("bot 对象也能定位队列（按 username 清场）",
      qBotClear.ok === true && qBotClear.cleared === 1 && tq.getQueue("QueueBot").length === 0, JSON.stringify(qBotClear));
    tq.clearQueue("q1");
  }
}

module.exports = { run: run };

