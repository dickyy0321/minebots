// ========================================
// 文件：scripts/e2e-test.js
// 功能：端到端死锁回归——假 bot 跑「follow → 1 秒 → moveTo → 1 秒 → stop」，盯死定时器 / 寻路目标 / 视线是否被彻底清空
// 依赖：path、events、vec3（可选）、../modules/command-handler（可选）、../modules/actions（可选）、../modules/pathfinding（可选）
// 导出：无（独立脚本：node scripts/e2e-test.js）
// 作者：MineBots
// ========================================
//
// 为什么要这个脚本 / why
//   用户反馈「让它跟随，它盯着地面死锁，之后砍树 / 停止全都没反应」。
//   这类问题只在「真实指令序列 + 真实定时器」下复现，普通单测打不到，所以单独做一个 E2E：
//     1. 用 setInterval / clearInterval 的探针记录「谁开了定时器、谁关掉了」；
//     2. 用假 pathfinder 记录每次 setGoal / stop，断言旧目标被清成 null；
//     3. 让 bot.dig 永远不 resolve，复现「一条指令挂死 → 后面所有指令排队饿死」；
//     4. 记录每次 lookAt 的 y，断言视线不再指向脚下。
// 用法 / usage：node scripts/e2e-test.js   （全绿退出码 0，有失败退出码 1）
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers
var path = require("path");
var EventEmitter = require("events").EventEmitter;
var ROOT = path.join(__dirname, "..");

// 可选依赖：vec3，造真 Vec3（mineflayer 与 GoalFollow 只认它）；缺失时退化成普通对象。
var vecLib = null;
try { vecLib = require(path.join(ROOT, "node_modules", "vec3")); } catch (e) { vecLib = null; }

// 统计：通过 / 失败 / 明细行。
var passCount = 0;
var failCount = 0;
var journal = [];

// 记一条结论：cond 为真算通过；detail 只在失败时打印，成功时也留在报告里备用。
// 每记一条就落一次盘（UTF-8）：脚本中途挂住时也能看到已经跑到哪一步。
function check(name, cond, detail) {
  if (cond === true) {
    passCount = passCount + 1;
    journal.push("[PASS] " + name);
    console.log("[PASS] " + name);
    flushJournal();
    return true;
  }
  failCount = failCount + 1;
  journal.push("[FAIL] " + name + " :: " + String(detail === undefined ? "" : detail));
  console.log("[FAIL] " + name + " :: " + String(detail === undefined ? "" : detail));
  flushJournal();
  return false;
}

// 把当前结论落盘（logs/e2e-last.txt，UTF-8）；写盘失败只吞掉，不影响测试结果。
function flushJournal() {
  try {
    var fsLib = require("fs");
    var dir = path.join(ROOT, "logs");
    try { if (!fsLib.existsSync(dir)) fsLib.mkdirSync(dir); } catch (e0) { /* 目录已存在 */ }
    fsLib.writeFileSync(path.join(dir, "e2e-last.txt"), journal.join("\n"), "utf8");
  } catch (e) { /* 报告写不出去也要继续跑 */ }
}

// 分段标题，纯为了报告好看。
function section(title) {
  journal.push("");
  journal.push("== " + title + " ==");
  console.log("");
  console.log("== " + title + " ==");
  flushJournal();
}

// 等一会儿（毫秒）；定时器故意保持 ref——被验证的模块大量用 unref，真 unref 会让脚本提前退出。
function wait(ms) {
  return new Promise(function (resolve) {
    setTimeout(function () { resolve(true); }, ms);
  });
}

// 把错误拍成一行文本，catch 里不会二次抛错。
function errText(err) {
  try {
    if (!err) return "unknown error / 未知错误";
    if (err.message) return String(err.message);
    return String(err);
  } catch (e) { return "unknown error / 未知错误"; }
}

// 造坐标：优先 vec3.Vec3，缺失时退化成普通对象；坐标非法返回 null。
function vec(x, y, z) {
  var nx = Number(x), ny = Number(y), nz = Number(z);
  if (isNaN(nx) || isNaN(ny) || isNaN(nz)) return null;
  try { if (vecLib && typeof vecLib.Vec3 === "function") return new vecLib.Vec3(nx, ny, nz); } catch (e) { /* 退化 */ }
  return { x: nx, y: ny, z: nz };
}

// ---------------- 定时器探针 ----------------
// 记录所有还活着的 setInterval：Timeout 对象 → 创建它的代码位置（谁开的定时器一眼可见）。
var liveIntervals = new Map();
var rawSetInterval = global.setInterval;
var rawClearInterval = global.clearInterval;

// 包一层 setInterval：登记句柄 + 记录调用栈（栈里第 3 行就是调用点）。
function patchedSetInterval(fn, ms) {
  var timer = rawSetInterval(fn, ms);
  try {
    var stack = String(new Error().stack || "").split("\n");
    liveIntervals.set(timer, { ms: ms, at: stack.length > 2 ? stack[2].trim() : "" });
  } catch (e) { liveIntervals.set(timer, { ms: ms, at: "" }); }
  return timer;
}

// 包一层 clearInterval：从活表里摘掉，再交给原函数。
function patchedClearInterval(timer) {
  try { liveIntervals.delete(timer); } catch (e) { /* ignore */ }
  return rawClearInterval(timer);
}

// 列出当前还活着的定时器（只保留「谁开的」，方便报告）。
function liveList() {
  var out = [];
  liveIntervals.forEach(function (meta) { out.push((meta && meta.at ? meta.at : "?") + "(" + (meta ? meta.ms : "?") + "ms)"); });
  return out;
}

// 打开 / 关闭探针（默认脚本一开始就打开）。
function installTimerSpy() {
  global.setInterval = patchedSetInterval;
  global.clearInterval = patchedClearInterval;
}

// 还原原生定时器，避免影响调用方把脚本当模块用。
function restoreTimerSpy() {
  global.setInterval = rawSetInterval;
  global.clearInterval = rawClearInterval;
}


// 造一个够用的假 bot：位置 / 实体表 / 方块表 / 控制键记录 / 视线记录 / 假 pathfinder 全部自己实现。
// opts 里可以给：x,y,z（自身坐标）、entities（实体表）、blocks（方块表）、digHangs（true 时 bot.dig 永不 resolve）。
function makeBot(opts) {
  var cfg = opts && typeof opts === "object" ? opts : {};
  var bot = new EventEmitter();
  bot.username = cfg.username ? String(cfg.username) : "MineBot";
  bot.records = { controls: [], goals: [], lookAt: [], chat: [] };
  bot.entity = {
    id: 1, username: bot.username, height: 1.8,
    position: vec(cfg.x === undefined ? 0 : cfg.x, cfg.y === undefined ? 64 : cfg.y, cfg.z === undefined ? 0 : cfg.z),
    yaw: 0, pitch: 0
  };
  bot.entities = {};
  bot.entities["1"] = bot.entity;
  var given = cfg.entities && typeof cfg.entities === "object" ? cfg.entities : {};
  var ids = Object.keys(given);
  for (var i = 0; i < ids.length; i++) bot.entities[ids[i]] = given[ids[i]];
  // 方块表：坐标字符串 → 方块对象（blockAt / findBlock 都从这里取）。
  var blocks = cfg.blocks && typeof cfg.blocks === "object" ? cfg.blocks : {};
  // 假 pathfinder：setGoal 记目标、stop 清目标，等价于官方插件的闸门行为。
  var pf = { goal: null, movements: { allowSprinting: true, allowParkour: true, canDig: false, digCost: 30 } };
  pf.getMovements = function () { return pf.movements; };
  pf.setMovements = function (moves) { if (moves) pf.movements = moves; return true; };
  pf.isMoving = function () { return false; };
  pf.stop = function () { bot.records.goals.push("stop"); pf.goal = null; return true; };
  pf.setGoal = function (goal) {
    pf.goal = goal || null;
    bot.records.goals.push(goal ? describeGoal(goal) : "null");
    // 真插件收到 GoalBlock 就会走路；这里直接把 bot 传送到目标，模拟「走到了」。
    if (goal && typeof goal.x === "number" && typeof goal.y === "number" && typeof goal.z === "number" && cfg.stayPut !== true) {
      bot.entity.position = vec(goal.x, goal.y, goal.z);
    }
    return true;
  };
  bot.pathfinder = pf;
  bot._mbMoves = pf.movements;
  // 控制键：记录每一次按 / 松，方便断言「停止之后没人再按前进」。
  bot.setControlState = function (name, value) {
    bot.records.controls.push(String(name) + "=" + (value ? "1" : "0"));
    return true;
  };
  bot.clearControlStates = function () { bot.records.controls.push("clear"); return true; };
  // 视线：记录每次对准的绝对坐标（y 用来判断「是不是在盯地面」）。
  bot.lookAt = function (point) {
    var y = point ? Number(point.y) : NaN;
    bot.records.lookAt.push({ y: isNaN(y) ? null : y, footY: Number(bot.entity.position ? bot.entity.position.y : 0) });
    if (point) { bot.entity.yaw = 0; bot.entity.pitch = 0; }
    return Promise.resolve(true);
  };
  // 方块查询：没给方块表就一律返回空气方块。
  bot.blockAt = function (point) {
    try {
      var key = Math.floor(Number(point.x)) + "," + Math.floor(Number(point.y)) + "," + Math.floor(Number(point.z));
      if (blocks[key]) return blocks[key];
      return { name: "air", position: vec(point.x, point.y, point.z), diggable: false };
    } catch (e) { return null; }
  };
  bot.findBlock = function (options) {
    var found = null;
    var keys = Object.keys(blocks);
    for (var k = 0; k < keys.length; k++) {
      var block = blocks[keys[k]];
      if (!block) continue;
      try { if (options && typeof options.matching === "function" && !options.matching(block)) continue; } catch (e) { continue; }
      found = block;
      break;
    }
    return found;
  };
  bot.canDigBlock = function () { return true; };
  // 挖掘：digHangs 为真时永不 resolve —— 复现「一条指令挂死，队列全断电」。
  bot.dig = function (block) {
    bot.records.dig = bot.records.dig || [];
    bot.records.dig.push(block && block.name ? String(block.name) : "?");
    if (cfg.digHangs === true) return new Promise(function () { /* 永远不结束：卡死在这里 */ });
    return Promise.resolve(true);
  };
  bot.chat = function (text) { bot.records.chat.push(String(text)); return true; };
  bot.inventory = { items: function () { return []; } };
  bot.heldItem = null;
  return bot;
}

// 造一个方块对象（名字 + 坐标），坐标非法时返回 null。
function makeBlock(name, x, y, z) {
  var pos = vec(x, y, z);
  if (!pos) return null;
  return { name: String(name), position: pos, diggable: true, _mbOpened: true };
}

// 造一个实体（玩家 / 怪）：username 只在玩家身上给。
function makeEntity(id, kind, name, x, y, z, extra) {
  var pos = vec(x, y, z);
  var ent = { id: Number(id), name: String(name), type: String(kind), position: pos, height: 1.8 };
  var src = extra && typeof extra === "object" ? extra : {};
  var keys = Object.keys(src);
  for (var i = 0; i < keys.length; i++) ent[keys[i]] = src[keys[i]];
  return ent;
}

// 把寻路目标翻译成可读字符串：GoalBlock 记坐标，GoalFollow 记 follow，其它记 rangeSq。
function describeGoal(goal) {
  try {
    if (!goal) return "null";
    if (typeof goal.x === "number" && typeof goal.y === "number" && typeof goal.z === "number") {
      return "GoalBlock(" + goal.x + "," + goal.y + "," + goal.z + ")";
    }
    if (goal.entity) return "GoalFollow";
    if (typeof goal.rangeSq === "number") return "Goal(rangeSq=" + goal.rangeSq + ")";
  } catch (e) { /* 退化 */ }
  return "goal";
}

// 统计某个字面量在记录里出现几次（用来断言「不再自己按前进」）。
function countOf(list, word) {
  try {
    if (!list || typeof list.length !== "number") return 0;
    var total = 0;
    for (var i = 0; i < list.length; i++) if (list[i] === word) total = total + 1;
    return total;
  } catch (e) { return 0; }
}

// 平地上「还站着没走的指令」——用来断言 stop 之后没有任何遗留定时器 / 目标。
function danglingGoal(bot) {
  try { return JSON.stringify(bot.pathfinder.goal); } catch (e) { return "?"; }
}

// 判断控制键记录里「最后一次按前进」是否早于「最后一次松前进 / 清空」——true 表示确实松手了。
function forwardReleased(controls) {
  try {
    var lastOn = -1, lastOff = -1;
    for (var i = 0; i < controls.length; i++) {
      if (controls[i] === "forward=1") lastOn = i;
      else if (controls[i] === "forward=0" || controls[i] === "clear") lastOff = i;
    }
    return lastOn < lastOff;
  } catch (e) { return false; }
}

// 场景 A：用户报的真实序列——follow → 1 秒 → moveTo（走不到） → 1 秒 → stop。
// 断言：旧跟随定时器被 clearInterval、寻路轮询被 stop 彻底中断、视线不再指向脚下。
async function scenarioFollowMoveStop(handler) {
  section("A. follow → moveTo → stop / 真实指令序列");
  var bot = makeBot({
    x: 0, y: 64, z: 0, stayPut: true,
    blocks: { "3,64,0": makeBlock("oak_log", 3, 64, 0) },
    entities: { "2": makeEntity(2, "player", "Alex", 6, 64, 0, { username: "Alex" }) }
  });
  var followRes = await handler.executeAction(bot, { action: "follow", players: ["Alex"] });
  check("follow 指令被接受 / follow accepted", followRes && followRes.ok === true, JSON.stringify(followRes));
  check("follow 之后确有跟随心跳与视线定时器 / follow timers alive",
    !!(bot._mbFollow && bot._mbFollow.timer) && bot._mbGaze !== null && liveIntervals.size >= 2,
    "follow=" + !!(bot._mbFollow && bot._mbFollow.timer) + " gaze=" + !!bot._mbGaze + " live=" + liveList().join(" | "));

  await wait(1000); // 让跟随心跳真跑一拍
  var followGoalCount = countOf(bot.records.goals, "GoalFollow");
  var followGaze = bot._mbGaze;

  // moveTo：假 pathfinder 收到 GoalBlock 也不动（stayPut），所以这一句会一直悬着——正是死锁现场。
  var moveTask = handler.executeAction(bot, { action: "move", position: { x: 20, y: 64, z: 0 } });
  if (moveTask && typeof moveTask.catch === "function") moveTask.catch(function () { return null; });
  await wait(1200);
  check("moveTo 期间旧跟随定时器与旧视线都被换掉 / follow timer replaced",
    bot._mbFollow === null && bot._mbGaze !== followGaze,
    "follow=" + String(bot._mbFollow) + " sameGaze=" + (bot._mbGaze === followGaze));
  check("moveTo 之后没有人把 GoalFollow 挂回来 / no follow re-arm",
    countOf(bot.records.goals, "GoalFollow") === followGoalCount, "goals=" + bot.records.goals.join(" | "));

  var t0 = Date.now();
  var stopRes = await handler.executeAction(bot, { action: "stop" });
  var stopMs = Date.now() - t0;
  check("stop 立即返回 / stop resolved", stopRes && stopRes.ok === true && stopMs < 1000, JSON.stringify(stopRes) + " " + stopMs + "ms");
  check("stop 之后寻路目标为 null / goal cleared",
    bot.pathfinder.goal === null && countOf(bot.records.goals, "null") >= 1, "goals=" + bot.records.goals.join(" | ") + " goal=" + danglingGoal(bot));
  check("stop 之后确实松开了前进键 / forward released", forwardReleased(bot.records.controls),
    "controls=" + bot.records.controls.join(" | "));

  // 挂着的 moveTo 必须被 stop 立刻中止（否则它会一直轮询到超时，看起来就是「停不下来」）。
  var moveOut = await Promise.race([moveTask, wait(2000).then(function () { return { ok: "pending" }; })]);
  check("stop 会中止还在跑的 moveTo / pending moveTo aborted",
    moveOut && moveOut.ok !== "pending" && moveOut.ok === false, JSON.stringify(moveOut));
  check("stop 之后没有任何遗留 setInterval / no leaked interval",
    liveIntervals.size === 0, "live=" + liveList().join(" | "));

  // 视线：任何一拍都不许低于脚底 + 0.9（0.9 以下就是在盯地面）
  var low = null;
  for (var i = 0; i < bot.records.lookAt.length; i++) {
    var row = bot.records.lookAt[i];
    if (row.y === null) continue;
    var delta = row.y - row.footY;
    if (low === null || delta < low) low = delta;
  }
  check("视线从不指向脚下 / never stares at the ground", low !== null && low >= 0.9, "minDelta=" + String(low));
  check("stop 之后清掉陈旧视线点 / stale look point cleared", !bot._mbLookPoint, "lookPoint=" + JSON.stringify(bot._mbLookPoint));
  return bot;
}


// 场景 B：死锁真凶——队列里某个动作的 Promise 永不 resolve（bot.dig 卡住）。
// 走 runQueue（聊天 / AI 指令的真实入口），验证：① 动作自带超时能自愈；② 新指令不被饿死。
async function scenarioHungDig(handler) {
  section("B. 挂死动作不再拖死队列 / hung dig must not block queue");
  var bot = makeBot({
    x: 0, y: 64, z: 0, digHangs: true,
    blocks: { "3,64,0": makeBlock("oak_log", 3, 64, 0) },
    entities: { "2": makeEntity(2, "player", "Alex", 6, 64, 0, { username: "Alex" }) }
  });
  // 故意不 await：dig_tree 会永远悬在 bot.dig 上（真实世界 = 方块挖不动 / 区块丢了）。
  var hung = handler.runQueue(bot, [{ action: "dig_tree" }]);
  if (hung && typeof hung.catch === "function") hung.catch(function () { return null; });
  await wait(300);
  check("挂死动作确实已经开始 / hung action started", !!(bot.records.dig && bot.records.dig.length > 0),
    "dig=" + JSON.stringify(bot.records.dig || []));

  var t0 = Date.now();
  var stopRes = await Promise.race([
    handler.runQueue(bot, [{ action: "stop" }]),
    wait(2500).then(function () { return { ok: false, error: "queue-timeout" }; })
  ]);
  var stopMs = Date.now() - t0;
  check("挂死时 stop 仍然立刻生效 / stop survives hung action",
    stopRes && stopRes.ok === true && stopMs < 2000, JSON.stringify(stopRes) + " spent=" + stopMs + "ms");
  check("挂死时 stop 也清空了寻路目标 / goal cleared while hung",
    bot.pathfinder.goal === null, "goal=" + danglingGoal(bot));

  // 紧接着再下一条指令：必须还能跑（不是「后面所有指令全废」）。
  var t1 = Date.now();
  var followRes = await Promise.race([
    handler.runQueue(bot, [{ action: "follow", players: ["Alex"] }]),
    wait(2500).then(function () { return { ok: false, error: "queue-timeout" }; })
  ]);
  var followMs = Date.now() - t1;
  check("挂死之后的后续指令照常执行 / next command still runs",
    followRes && followRes.ok === true && followMs < 2000, JSON.stringify(followRes) + " spent=" + followMs + "ms");
  await Promise.race([handler.runQueue(bot, [{ action: "stop" }]), wait(2500)]);

  // 动作自带的超时：不动 stop 也能自己收手（否则挖掘抖动定时器会一直活着）。
  await wait(1800);
  check("挂死动作到点自己超时收手 / hung action times out on its own",
    liveIntervals.size === 0, "live=" + liveList().join(" | "));
  var late = await Promise.race([hung, wait(600).then(function () { return { ok: "pending" }; })]);
  check("超时之后旧队列任务不再悬挂 / hung queue job settled",
    late && late.ok !== "pending", JSON.stringify(late));
}



// 场景 C：同一时刻只允许存在一套「动起来」的定时器——连续三次改主意也不许叠加。
async function scenarioRapidSwitch(handler) {
  section("C. 连续改主意不叠加定时器 / rapid preempt");
  var bot = makeBot({
    x: 0, y: 64, z: 0,
    blocks: { "3,64,0": makeBlock("oak_log", 3, 64, 0) },
    entities: { "2": makeEntity(2, "player", "Alex", 6, 64, 0, { username: "Alex" }) }
  });
  await handler.executeAction(bot, { action: "follow", players: ["Alex"] });
  var firstLive = liveIntervals.size;
  await handler.executeAction(bot, { action: "follow", players: ["Alex"] });
  await handler.executeAction(bot, { action: "follow", players: ["Alex"] });
  check("重复 follow 不会叠加定时器 / repeated follow does not stack timers",
    liveIntervals.size <= firstLive && firstLive >= 1,
    "first=" + firstLive + " now=" + liveIntervals.size + " live=" + liveList().join(" | "));
  await handler.executeAction(bot, { action: "stop" });
  await wait(400);
  check("三次改主意之后依旧零遗留定时器 / zero leaked timers",
    liveIntervals.size === 0, "live=" + liveList().join(" | "));
}

// 主流程：装探针 → 依次跑三个场景 → 打印汇总 → 按结果设置退出码。
async function main() {
  installTimerSpy();
  // 保命定时器：被验证的模块到处 unref，没有它就可能在 await 中途直接退进程（ref 住主循环）。
  var keepAlive = rawSetInterval(function () { return null; }, 500);
  // 挖掘超时压到 1.2 秒：生产默认 9 秒，自测要是等 9 秒就没法跑了。
  process.env.MINEBOTS_DIG_TIMEOUT_MS = "1200";
  var handler = null;
  try { handler = require(path.join(ROOT, "modules", "command-handler.js")); } catch (e) { handler = null; }
  section("0. 环境 / env");
  check("command-handler 能加载 / handler loaded", handler !== null, "modules/command-handler.js");
  if (!handler) {
    restoreTimerSpy();
    clearInterval(keepAlive);
    process.exit(1);
    return;
  }
  try { await scenarioFollowMoveStop(handler); } catch (e) { check("场景 A 未抛错 / scenario A", false, errText(e)); }
  try { await scenarioHungDig(handler); } catch (e) { check("场景 B 未抛错 / scenario B", false, errText(e)); }
  try { await scenarioRapidSwitch(handler); } catch (e) { check("场景 C 未抛错 / scenario C", false, errText(e)); }
  section("汇总 / summary");
  console.log("通过 / pass : " + passCount);
  console.log("失败 / fail : " + failCount);
  journal.push("");
  journal.push("通过 / pass : " + passCount);
  journal.push("失败 / fail : " + failCount);
  try { require("fs").writeFileSync(path.join(ROOT, "logs", "e2e-last.txt"), journal.join("\n"), "utf8"); } catch (e) { /* 写报告失败不影响退出码 */ }
  restoreTimerSpy();
  clearInterval(keepAlive);
  var code = failCount === 0 ? 0 : 1;
  console.log(failCount === 0 ? "[PASS] E2E 全绿：抢占与死锁都没问题 / all green" : "[FAIL] E2E 有失败项 / see above");
  // 挂死的场景会留下悬空 Promise，这里直接退出，别等事件循环。
  process.exit(code);
}

main().catch(function (err) {
  console.log("[FAIL] E2E 自身崩了 / e2e crashed: " + errText(err));
  restoreTimerSpy();
  process.exit(1);
});
