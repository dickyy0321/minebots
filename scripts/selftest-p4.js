// ========================================
// 文件：scripts/selftest-p4.js
// 功能：P4 回归自测——强制单语 / 遥测防误报 / stop 打断寻路 / 队列插队 / UI 收纳结构
// 依赖：path、fs；../modules/speech、../modules/typing、../modules/telemetry、../modules/actions、../modules/command-handler（都可选，缺了就跳过）
// 导出：run（由 scripts/selftest.js 调用，复用它的 section / expect / 造机器人工厂）
// 作者：MineBots
// ========================================
// 说明 / note：这一组用例只验「本次四个修复点」，不碰任何既有行为。
var path = require("path");
var fs = require("fs");
var ROOT = path.join(__dirname, "..");

// 按相对路径安全 require 一个模块；缺失或抛错时返回 null（不拖垮整轮自检）。
function tryRequire(rel) {
  try { return require(path.join(ROOT, rel)); } catch (err) { return null; }
}

// 造一个记录得很全的假 pathfinder：setGoal 记目标、stop 清目标，等价于官方插件的闸门行为。
function makePathfinder(log) {
  var pf = { goal: null, movements: { allowSprinting: true, allowParkour: true, canDig: false, digCost: 30 } };
  pf.getMovements = function () { return pf.movements; };
  pf.setMovements = function (moves) { if (moves) pf.movements = moves; return true; };
  pf.isMoving = function () { return false; };
  pf.stop = function () { pf.goal = null; log.stops = (log.stops || 0) + 1; return true; };
  pf.setGoal = function (goal) { pf.goal = goal || null; log.goals.push(goal ? "goal" : "null"); return true; };
  return pf;
}

// 分组 1：强制单语——zh 删英文、en 删中文、指令与坐标不许误伤。
function checkSpeech(h) {
  var speech = tryRequire("modules/speech.js");
  h.section("15a. 强制单语 / force monolingual");
  if (!speech || typeof speech.forceMonolingual !== "function") {
    h.expect("speech.forceMonolingual 存在", false, "modules/speech.js 缺函数");
    return;
  }
  var f = speech.forceMonolingual;
  h.expect("zh：连续英文单词整段删掉（Got it, 跟着你走 -> 跟着你走）",
    f("Got it, 跟着你走", "zh") === "跟着你走", JSON.stringify(f("Got it, 跟着你走", "zh")));
  h.expect("zh：纯英文直接给兜底中文（OK -> 好的）",
    f("OK", "zh") === "好的" && f("Got it  hello world", "zh") === "好的", JSON.stringify(f("OK", "zh")));
  h.expect("en：汉字全部删掉（好的 ok -> ok / 跟着你走 -> ok）",
    f("好的 ok", "en") === "ok" && f("跟着你走", "en") === "ok",
    JSON.stringify([f("好的 ok", "en"), f("跟着你走", "en")]));
  h.expect("双语对按目标语言取一半（软清洗 + 硬过滤一起生效）",
    f("收到，我去砍木头 / Got it, chopping wood", "zh") === "收到，我去砍木头" &&
    f("收到，我去砍木头 / Got it, chopping wood", "en") === "Got it, chopping wood",
    JSON.stringify([f("收到，我去砍木头 / Got it, chopping wood", "zh"), f("收到，我去砍木头 / Got it, chopping wood", "en")]));
  h.expect("不误伤坐标 / 服务器指令（100,64,200 与 /login 原样保留）",
    f("基地在 100,64,200", "zh") === "基地在 100,64,200" && f("/login abc123", "zh") === "/login abc123",
    JSON.stringify([f("基地在 100,64,200", "zh"), f("/login abc123", "zh")]));
  h.expect("speech.clean 也带上硬过滤（Hello, 你好 -> 你好）",
    speech.clean("Hello, 你好", "zh") === "你好" && speech.clean("你好, hello", "en") === "hello",
    JSON.stringify([speech.clean("Hello, 你好", "zh"), speech.clean("你好, hello", "en")]));
}

// 分组 2：打字机最后一道闸——bot.chat 收到的每一句都必须是纯单语。
function checkTypingGate(h) {
  var typing = tryRequire("modules/typing.js");
  h.section("15b. 发出前硬过滤 / chat gate");
  if (!typing || typeof typing.send !== "function") {
    h.expect("typing.send 存在", false, "modules/typing.js 缺函数");
    return;
  }
  var bot = h.makeBot({ username: "ChatBot" });
  var zhRes = typing.send(bot, "Got it, 跟着你走", { lang: "zh", mode: "off" });
  h.expect("zh 回复发出去的是纯中文（Got it 消失）",
    zhRes && zhRes.ok === true && bot.records.chat.length === 1 && bot.records.chat[0] === "跟着你走",
    JSON.stringify(bot.records.chat));
  var bot2 = h.makeBot({ username: "ChatBot2" });
  typing.send(bot2, "好的 Follow me now", { lang: "en", mode: "off" });
  var sent = bot2.records.chat.join(" | ");
  h.expect("en 回复发出去的不含汉字",
    bot2.records.chat.length === 1 && !/[\u4e00-\u9fff]/.test(sent), sent);
}

// 分组 3：遥测防误报——别人打架绝不算 bot 遇袭。
function checkTelemetry(h) {
  var telemetry = tryRequire("modules/telemetry.js");
  h.section("15c. 遥测防误报 / no false alarm");
  if (!telemetry || typeof telemetry.handleHurt !== "function") {
    h.expect("telemetry.handleHurt 存在", false, "modules/telemetry.js 缺函数");
    return;
  }
  var self = { id: 7, position: { x: 0, y: 64, z: 0 } };
  var other = { id: 9, username: "Alex", type: "player", position: { x: 1, y: 64, z: 0 } };
  var bot = {
    entity: self, _mbTelemetry: { events: [] }, _mbBotId: "bot-x",
    entities: { "7": self, "9": other }
  };
  h.expect("别的玩家挨打 -> 不产生警报",
    telemetry.handleHurt(bot, other, { id: 7 }) === null, "should be null");
  h.expect("entityHurt 没给实体 -> 也不产生警报（老代码会误报）",
    telemetry.handleHurt(bot, undefined, undefined) === null, "should be null");
  var ev = telemetry.handleHurt(bot, self, other);
  h.expect("自己挨打 -> 警报 + 攻击者名字正确",
    ev && ev.type === "bot_under_attack" && ev.attackerName === "Alex", JSON.stringify(ev));
  h.expect("只给 entityId 也能认出自己 / isSelfEntity",
    telemetry.isSelfEntity(bot, { id: "7" }) === true && telemetry.isSelfEntity(bot, other) === false,
    "isSelfEntity");
  h.expect("附近玩家不再被猜成凶手 / no player guessing",
    telemetry.handleHurt(bot, self, null) !== null, "self hurt without source still reports");
}


// 分组 4：stop 必须能打断在跑的寻路（否则「喊停」要等 10 秒超时才生效）。
async function checkStopAborts(h) {
  var actions = tryRequire("modules/actions.js");
  h.section("15d. stop 打断寻路 / stop aborts goTo");
  if (!actions || typeof actions.moveTo !== "function") {
    h.expect("actions.moveTo 存在", false, "modules/actions.js 缺函数");
    return;
  }
  var log = { goals: [] };
  var bot = h.makeBot({ x: 0, y: 64, z: 0 });
  bot.pathfinder = makePathfinder(log);
  bot._mbMoves = bot.pathfinder.movements;
  var walking = actions.moveTo(bot, 10, 64, 10);
  await h.wait(200);
  var stopRes = actions.stopMoving(bot);
  var walkRes = await Promise.race([walking, h.wait(1500).then(function () { return { ok: "timeout" }; })]);
  h.expect("moveTo 被 stop 立刻中止（code=ABORTED）",
    walkRes && walkRes.ok === false && walkRes.code === "ABORTED", JSON.stringify(walkRes));
  h.expect("stop 之后寻路目标被清空、也没有遗留跟随定时器",
    stopRes && stopRes.ok === true && bot.pathfinder.goal === null && bot._mbFollow === null,
    JSON.stringify({ goal: bot.pathfinder.goal, follow: bot._mbFollow }));
}

// 分组 5：队列插队——前一条指令挂死时，stop 与新指令必须照样能跑（本轮死锁回归）。
async function checkQueueEscape(h) {
  var handler = tryRequire("modules/command-handler.js");
  h.section("15e. 挂死任务不饿死新指令 / queue escape");
  if (!handler || typeof handler.runQueue !== "function") {
    h.expect("command-handler.runQueue 存在", false, "modules/command-handler.js 缺函数");
    return;
  }
  var bot = h.makeBot({ x: 0, y: 64, z: 0, blocks: [h.makeBlock("oak_log", 3, 64, 0)] });
  // 故意让挖掘永不结束：真实世界里就是「方块挖不动 / 区块丢了」。
  bot.dig = function (block) {
    bot.records.dig.push(block && block.name ? block.name : "null");
    return new Promise(function () { /* 永远悬着 */ });
  };
  var hung = handler.runQueue(bot, [{ action: "dig_tree" }]);
  if (hung && typeof hung.catch === "function") hung.catch(function () { return null; });
  await h.wait(250);
  var digStarted = bot.records.dig.length > 0;
  var t0 = Date.now();
  var stopRes = await Promise.race([
    handler.runQueue(bot, [{ action: "stop" }]),
    h.wait(1500).then(function () { return { ok: false, error: "queue-timeout" }; })
  ]);
  var spent = Date.now() - t0;
  h.expect("挂死动作确实开始执行", digStarted === true, JSON.stringify(bot.records.dig));
  h.expect("挂死时 stop 依然立刻返回（队列可插队）",
    stopRes && stopRes.ok === true && spent < 1200, JSON.stringify(stopRes) + " spent=" + spent + "ms");
  var t1 = Date.now();
  var moveRes = await Promise.race([
    handler.runQueue(bot, [{ action: "move", position: { x: 1, y: 64, z: 0 } }]),
    h.wait(2500).then(function () { return { ok: false, error: "queue-timeout" }; })
  ]);
  h.expect("挂死之后的新指令照常执行",
    moveRes && moveRes.ok !== undefined, JSON.stringify(moveRes) + " spent=" + (Date.now() - t1) + "ms");
}

// 分组 6：UI 主次分明结构——主页保留卡片/输入/缩略日志/雷达；设置页全屏、左侧导航+右侧内容、废抽屉。
function checkUiLayout(h) {
  h.section("15f. UI 主次分明 / main + fullscreen settings");
  var idxPath = path.join(ROOT, "gui", "renderer", "index.html");
  var setPath = path.join(ROOT, "gui", "renderer", "settings.html");
  var idx = "", set = "";
  try { idx = fs.readFileSync(idxPath, "utf8"); } catch (err) { idx = ""; }
  try { set = fs.readFileSync(setPath, "utf8"); } catch (err) { set = ""; }
  h.expect("index.html 可读", idx.length > 0, idxPath);
  h.expect("settings.html 可读", set.length > 0, setPath);
  if (idx.length === 0 || set.length === 0) return;
  // 主界面保留核心区，且废除侧滑抽屉。
  var idxOk = idx.indexOf('id="botsBox"') >= 0 && idx.indexOf('id="cmdInput"') >= 0 &&
    idx.indexOf('id="logBox"') >= 0 && idx.indexOf('id="miniMap"') >= 0 &&
    idx.indexOf('id="overviewBotCount"') >= 0 && idx.indexOf('id="advancedBtn"') >= 0 &&
    idx.indexOf('advancedPanel') < 0;
  h.expect("主界面保留卡片/输入/缩略日志/雷达且废除 advancedPanel 抽屉", idxOk, "idx structure");
  h.expect("主界面设置按钮跳转到全屏设置页", idx.indexOf('data-nav-target="settings.html"') >= 0, "nav to settings");
  // 设置页：左上角返回、左侧导航、右侧内容区、6 个分组面板、频道与档案池控件。
  var setOk = set.indexOf('id="backToMainBtn"') >= 0 &&
    (set.split("data-settings-nav=").length - 1) >= 6 &&
    (set.split("data-settings-pane=").length - 1) >= 6 &&
    set.indexOf('id="channelAssignBtn"') >= 0 && set.indexOf('id="modelApplyBtn"') >= 0 &&
    set.indexOf('advancedPanel') < 0;
  h.expect("设置页全屏：返回按钮 + 左侧导航 + 右侧内容 + 6 面板 + 频道/档案池", setOk, "settings structure");
  h.expect("设置页左上角有返回主界面按钮（data-nav-target=index.html）",
    set.indexOf('id="backToMainBtn"') >= 0 && set.indexOf('data-nav-target="index.html"') >= 0, "back btn");
}

// 主流程：依次跑六个分组；任一分组抛错只记一条失败，不让整轮自检崩。
async function run(h) {
  try { checkSpeech(h); } catch (e1) { h.expect("15a 未抛错", false, String(e1)); }
  try { checkTypingGate(h); } catch (e2) { h.expect("15b 未抛错", false, String(e2)); }
  try { checkTelemetry(h); } catch (e3) { h.expect("15c 未抛错", false, String(e3)); }
  try { await checkStopAborts(h); } catch (e4) { h.expect("15d 未抛错", false, String(e4)); }
  try { await checkQueueEscape(h); } catch (e5) { h.expect("15e 未抛错", false, String(e5)); }
  try { checkUiLayout(h); } catch (e6) { h.expect("15f 未抛错", false, String(e6)); }
  // P5：并发底盘 / 追踪 / 雷达 / GOAP / 行为树 / 蜂群 / 双模式 UI 的新增回归用例。
  try { await require("./selftest-p5").run(h); } catch (e7) { h.expect("15g 未抛错", false, String(e7)); }
}

module.exports = { run: run };

