// ========================================
// 文件：scripts/selftest-p2.js
// 功能：P2 自测——多 Bot 独立 AI / 状态机节点库 8 大分类 + 宏 / 共享黑板 / AI 状态机工具 / 每 bot 独立配置
// 依赖：modules/shared-board、swarm、state-util、state-nodes、state-skills*、state-macros、
//       state-machine、ai-tools-state、ai-config、ai-client、chat-handler（都可选，缺失只报失败不崩）
// 产物：无（只往日志里追加断言；临时文件测完自己删）
// 作者：MineBots
// ========================================
//
// 用法：由 scripts/selftest.js 统一调用 run(helpers)，helpers 提供 section / expect / expectEqual / wait / makeBot / makeBlock
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers
var fs = require("fs");
var path = require("path");
var ROOT = path.join(__dirname, "..");

// 载入模块：失败返回 null（调用方会据此报失败项，而不是让自测整体崩掉）。
function load(name) {
  try { return require(path.join(ROOT, "modules", name)); } catch (e) { return null; }
}

// 安全提取错误文本。
function getErrText(err) {
  try {
    if (err && err.message) return String(err.message);
    return String(err);
  } catch (e) { return "unknown error"; }
}

// 转文本（null / undefined → 空串）。
function toText(value) {
  try {
    if (value === null || value === undefined) return "";
    return String(value);
  } catch (e) { return ""; }
}

// 造一个最小可用的上下文（状态机节点执行的 ctx）。
function makeCtx(bot, botId) {
  return { bot: bot, botId: botId, vars: {}, counters: {}, events: {}, last: null, status: null };
}

// 造一个带 toss / consume / activateItem 假实现的 bot（在 helpers.makeBot 上补接口）。
function makeFullBot(h, options) {
  var bot = h.makeBot(options || {});
  bot.records.toss = [];
  bot.toss = function (type, meta, count) { bot.records.toss.push(type + ":" + count); return Promise.resolve(true); };
  bot.consume = function () { bot.records.consumed = (bot.records.consumed || 0) + 1; return Promise.resolve(true); };
  bot.activateItem = function () { bot.records.activated = (bot.records.activated || 0) + 1; return true; };
  return bot;
}

// 共享黑板：读写 / 深拷贝隔离 / 命名空间 / 信箱 / 落盘。
function checkBoard(h) {
  h.section("P2-1 共享黑板 / shared board");
  var board = load("shared-board");
  if (!board) { h.expect("shared-board 可加载", false, "require 失败"); return null; }
  h.expect("shared-board 可加载", true, "");
  board.post("p2:key", { a: 1, list: [1, 2] });
  var got = board.get("p2:key");
  h.expect("写入后能读回", got && got.a === 1, JSON.stringify(got));
  got.a = 999;
  h.expect("读回的是深拷贝（改副本不影响存储）", board.get("p2:key").a === 1, JSON.stringify(board.get("p2:key")));
  var setFor = board.setFor("p2bot", "hp", 20);
  h.expect("setFor 写入 bot 命名空间", setFor && setFor.ok === true, JSON.stringify(setFor));
  h.expect("getFor 读回 bot 字段", board.getFor("p2bot").hp === 20, JSON.stringify(board.getFor("p2bot")));
  var posted = board.postMessage("p2bot", "hello board");
  var inbox = board.inbox("p2bot");
  h.expect("postMessage 写进信箱", posted && posted.ok === true && inbox.length >= 1, JSON.stringify(inbox));
  h.expect("信箱里能看到刚发的文本", JSON.stringify(inbox).indexOf("hello board") >= 0, JSON.stringify(inbox));
  h.expect("getPath 指向 shared-board.json", /shared-board\.json$/.test(board.getPath()), board.getPath());
  var flushed = board.flush();
  h.expect("flush 能落盘（返回 true 且文件存在）", flushed === true && fs.existsSync(board.getPath()), String(flushed));
  return board;
}

// 群体协同：登记 / 列表 / 广播 / 私聊 / 派活 / 等待（含超时）。
async function checkSwarm(h) {
  h.section("P2-2 群体协同 / swarm");
  var swarm = load("swarm");
  if (!swarm) { h.expect("swarm 可加载", false, "require 失败"); return; }
  h.expect("swarm 可加载", true, "");
  swarm.clear();
  var botA = makeFullBot(h, { username: "P2Alpha" });
  var botB = makeFullBot(h, { username: "P2Beta" });
  var a = swarm.register(botA, "p2-alpha");
  var b = swarm.register(botB, "p2-beta");
  h.expect("register 两个 bot 都成功", a.ok === true && b.ok === true && swarm.size() === 2, JSON.stringify([a, b, swarm.size()]));
  h.expect("get 能取到 bot 对象", swarm.get("p2-alpha") === botA, "对象不一致");
  h.expect("find 支持按用户名反查", swarm.find("P2Beta") === "p2-beta", swarm.find("P2Beta"));
  h.expect("list 里有位置与血量字段", swarm.list().length === 2 && swarm.list()[0].position !== undefined, JSON.stringify(swarm.list()));
  var bc = swarm.broadcast("集体集合 / rally", "p2-alpha");
  h.expect("broadcast 只发给别人（排除自己）", bc.ok === true && bc.sent === 1 && bc.ids.indexOf("p2-beta") >= 0, JSON.stringify(bc));
  h.expect("被广播的 bot 真的收到聊天", botB.records.chat.indexOf("集体集合 / rally") >= 0, JSON.stringify(botB.records.chat));
  var wh = swarm.whisper("p2-alpha", "p2-beta", "私聊内容 / psst");
  h.expect("whisper 投递成功", wh.ok === true && wh.delivered === true, JSON.stringify(wh));
  h.expect("whisper 写进了对方信箱", JSON.stringify(swarm.inboxOf("p2-beta")).indexOf("psst") >= 0, JSON.stringify(swarm.inboxOf("p2-beta")));
  var as = swarm.assign("p2-beta", "砍树 / chop", "woodcutter");
  h.expect("assign 派活成功", as.ok === true, JSON.stringify(as));
  h.expect("taskOf 读回任务名", swarm.taskOf("p2-beta") && swarm.taskOf("p2-beta").machine === "woodcutter", JSON.stringify(swarm.taskOf("p2-beta")));
  var waited = await swarm.waitFor("p2-beta", { field: "online", op: "eq", value: true }, 1500);
  h.expect("waitFor 条件已满足时立刻返回", waited.ok === true, JSON.stringify(waited));
  var timeout = await swarm.waitFor("p2-nobody", { field: "online", op: "eq", value: true }, 700);
  h.expect("waitFor 超时返回 ok:false", timeout.ok === false && /timeout|超时/.test(toText(timeout.reason)), JSON.stringify(timeout));
  h.expect("statusOf 能读到黑板状态", swarm.statusOf("p2-beta").username === "P2Beta", JSON.stringify(swarm.statusOf("p2-beta")));
  h.expect("unregister 能注销", swarm.unregister("p2-alpha").removed === true && swarm.size() === 1, String(swarm.size()));
  swarm.unregister("p2-beta");
  h.expect("清空后 size 归零", swarm.size() === 0, String(swarm.size()));
}

// 公共工具：变量替换 / 背包 / 方块 / 坐标。
function checkUtil(h) {
  h.section("P2-3 公共工具 / state-util");
  var util = load("state-util");
  if (!util) { h.expect("state-util 可加载", false, "require 失败"); return; }
  h.expect("state-util 可加载", true, "");
  var resolved = util.resolveArgs({ x: "$p.x", list: ["$p.y"], flag: true }, { p: { x: 3, y: 8 } });
  h.expect("resolveArgs 能替换 $变量（含数组）", resolved.x === 3 && resolved.list[0] === 8 && resolved.flag === true, JSON.stringify(resolved));
  var items = [{ name: "dirt", count: 5, type: 3 }, { name: "oak_log", count: 2, type: 7 }];
  var bot = h.makeBot({ items: items, blocks: [h.makeBlock("oak_log", 1, 64, 0)] });
  h.expect("countItem 统计数量", util.countItem(bot, "dirt") === 5, String(util.countItem(bot, "dirt")));
  h.expect("hasItem 判断有无", util.hasItem(bot, "dirt") === true && util.hasItem(bot, "iron") === false, "");
  h.expect("itemNames 去重列名字", util.itemNames(bot).length === 2, JSON.stringify(util.itemNames(bot)));
  var block = util.nearestBlock(bot, "log", 16);
  h.expect("nearestBlock 按子串找到方块", block && block.name === "oak_log", JSON.stringify(block && block.name));
  h.expect("nearestBlock 找不到返回 null", util.nearestBlock(bot, "diamond", 16) === null, "");
  var pos = util.posOf(bot);
  h.expect("posOf 读坐标", pos && pos.y === 64, JSON.stringify(pos));
  h.expect("distanceOf 算距离", util.distanceOf({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 }) === 5, "");
  h.expect("toNum 非法值回落到兜底", util.toNum("abc", 7) === 7, String(util.toNum("abc", 7)));
}

// 节点总表：8 大分类 + 宏 + 高级动作 + 触发器、动作名反查、未知动作兜底。
async function checkNodeTable(h) {
  h.section("P2-4 节点总表 / state-nodes");
  var nodes = load("state-nodes");
  if (!nodes) { h.expect("state-nodes 可加载", false, "require 失败"); return; }
  h.expect("state-nodes 可加载", true, "");
  var catalog = nodes.getCatalog();
  var groups = Object.keys(catalog.categories);
  h.expect("分类数为 8 大分类 + 宏 + 高级 + 触发器 = 11 组", groups.length === 11, JSON.stringify(groups));
  h.expect("高级动作 16 个 / 触发器 6 个", catalog.counts.advanced === 16 && catalog.counts.trigger === 6, JSON.stringify({ a: catalog.counts.advanced, t: catalog.counts.trigger }));
  h.expect("宏分类有 4 个节点", catalog.counts.macro === 4, String(catalog.counts.macro));
  h.expect("节点总数 >= 45", catalog.total >= 45, String(catalog.total));
  h.expect("NAMES 与目录总数一致", nodes.NAMES.length === catalog.total, nodes.NAMES.length + " vs " + catalog.total);
  h.expect("isAction 认已知动作", nodes.isAction("dig_tree") === true && nodes.isAction("gather_resource") === true, "");
  h.expect("isAction 拒绝未知动作", nodes.isAction("fly_to_moon") === false && nodes.isAction("") === false, "");
  h.expect("categoryOf 反查分类", nodes.categoryOf("gather_resource") === "macro" && nodes.categoryOf("ask_ai") === "ai", nodes.categoryOf("ask_ai"));
  var ctx = makeCtx(h.makeBot({}), "p2-node");
  var unknown = await nodes.execute(ctx, "fly_to_moon", {});
  h.expect("未知动作返回 ok:false", unknown && unknown.ok === false && toText(unknown.message).length > 0, JSON.stringify(unknown));
  var okWait = await nodes.execute(ctx, "wait", { ms: 5 });
  h.expect("已知动作能执行（wait）", okWait && okWait.ok === true, JSON.stringify(okWait));
  h.expect("执行结果带 action 与 elapsed", okWait.action === "wait" && typeof okWait.elapsed === "number", JSON.stringify(okWait));
  h.expect("空动作名直接失败", (await nodes.execute(ctx, "", {})).ok === false, "");
}

// 基础技能 + 多 Bot 技能（state-skills）。
async function checkBasicSkills(h) {
  h.section("P2-5 基础 / 多 Bot 技能 / state-skills");
  var skills = load("state-skills");
  if (!skills) { h.expect("state-skills 可加载", false, "require 失败"); return; }
  h.expect("state-skills 可加载", true, "");
  var bot = makeFullBot(h, { username: "P2Skill", blocks: [h.makeBlock("oak_log", 0, 64, 0)] });
  var ctx = makeCtx(bot, "p2-skill");
  var said = await skills.pick("chat")(ctx, { message: "你好 / hi" });
  h.expect("chat 节点真的说了话", said.ok === true && bot.records.chat.indexOf("你好 / hi") >= 0, JSON.stringify(bot.records.chat));
  var varSet = await skills.pick("set_var")(ctx, { name: "phase", value: 2 });
  h.expect("set_var -> ctx.vars 正确", varSet.ok === true && ctx.vars.phase === 2, JSON.stringify(ctx.vars));
  var wood = await skills.pick("dig_tree")(ctx, { blocks: 3 });
  h.expect("dig_tree 砍到 3 个原木", wood.ok === true && wood.count === 3 && bot.records.dig.length === 3, JSON.stringify(wood));
  h.expect("dig_tree 把结果写进变量", ctx.vars.woodDug === 3, String(ctx.vars.woodDug));
  var stopped = await skills.pick("stop")(ctx, {});
  h.expect("stop 触发清空控制状态", stopped.ok === true && bot.records.controls.indexOf("clear") >= 0, JSON.stringify(bot.records.controls));
  var noPlayer = await skills.pick("follow")(ctx, {});
  h.expect("follow 缺 player 返回 ok:false", noPlayer.ok === false, JSON.stringify(noPlayer));
  var swarm = load("swarm");
  var peer = makeFullBot(h, { username: "P2Peer" });
  if (swarm) { swarm.clear(); swarm.register(peer, "p2-peer"); }
  var bc = await skills.pick("broadcast")(ctx, { message: "集合 / rally" });
  h.expect("broadcast 节点能发出去", bc.ok === true && bc.sent >= 1, JSON.stringify(bc));
  var wh = await skills.pick("whisper_bot")(ctx, { to: "p2-peer", message: "过来 / come" });
  h.expect("whisper_bot 节点投递成功", wh.ok === true, JSON.stringify(wh));
  var as = await skills.pick("assign_task")(ctx, { bot: "p2-peer", task: "守望 / guard" });
  h.expect("assign_task 节点派活成功", as.ok === true, JSON.stringify(as));
  var missing = await skills.pick("whisper_bot")(ctx, { to: "", message: "x" });
  h.expect("whisper_bot 缺目标返回 ok:false", missing.ok === false, JSON.stringify(missing));
  if (swarm) swarm.clear();
}

// 感知 / 物品 / 生存技能（state-skills-plus）。
async function checkPlusSkills(h) {
  h.section("P2-6 感知 / 物品 / 生存技能 / state-skills-plus");
  var plus = load("state-skills-plus");
  if (!plus) { h.expect("state-skills-plus 可加载", false, "require 失败"); return; }
  h.expect("state-skills-plus 可加载", true, "");
  var zombie = h.makeEntity(9, "mob", "zombie", 3, 64, 0);
  var items = [{ name: "bread", count: 3, type: 297 }, { name: "dirt", count: 10, type: 3 }];
  var bot = makeFullBot(h, { username: "P2Plus", entities: { 9: zombie }, items: items });
  bot.health = 12;
  bot.food = 9;
  var ctx = makeCtx(bot, "p2-plus");
  var scan = await plus.pick("scan_entities")(ctx, { radius: 16, kind: "mob" });
  h.expect("scan_entities 找到附近的怪物", scan.ok === true && scan.count === 1 && ctx.vars.entities.length === 1, JSON.stringify(scan));
  var status = await plus.pick("get_status")(ctx, {});
  h.expect("get_status 读血量与饱食度", status.ok === true && status.health === 12 && status.food === 9 && ctx.vars.health === 12, JSON.stringify(status));
  var counted = await plus.pick("count_item")(ctx, { item: "dirt" });
  h.expect("count_item 统计背包数量", counted.ok === true && counted.count === 10, JSON.stringify(counted));
  var dist = await plus.pick("distance_to")(ctx, { x: 3, y: 64, z: 0 });
  h.expect("distance_to 算到坐标的距离", dist.ok === true && dist.distance === 3, JSON.stringify(dist));
  var bad = await plus.pick("distance_to")(ctx, { x: "abc", y: 1, z: 1 });
  h.expect("distance_to 非法坐标返回 ok:false", bad.ok === false, JSON.stringify(bad));
  var equipped = await plus.pick("equip_item")(ctx, { item: "dirt" });
  h.expect("equip_item 真的调了 equip", equipped.ok === true && bot.records.equip.indexOf("dirt") >= 0, JSON.stringify(bot.records.equip));
  var dropped = await plus.pick("drop_item")(ctx, { item: "dirt", count: 2 });
  h.expect("drop_item 真的调了 toss", dropped.ok === true && bot.records.toss.length === 1, JSON.stringify(bot.records.toss));
  var noItem = await plus.pick("equip_item")(ctx, { item: "diamond" });
  h.expect("equip_item 没物品返回 ok:false", noItem.ok === false, JSON.stringify(noItem));
  var ate = await plus.pick("auto_eat")(ctx, {});
  h.expect("auto_eat 找到面包并吃掉", ate.ok === true && ate.item === "bread" && bot.records.consumed === 1, JSON.stringify(ate));
  var used = await plus.pick("use_item")(ctx, {});
  h.expect("use_item 调 activateItem", used.ok === true && bot.records.activated === 1, JSON.stringify(used));
  var noChest = await plus.pick("take_item")(ctx, { item: "bread" });
  h.expect("take_item 附近没箱子返回 ok:false", noChest.ok === false, JSON.stringify(noChest));
}

// 数学变量 + AI 技能（state-skills-ai）。
async function checkMathSkills(h) {
  h.section("P2-7 数学变量 + AI 技能 / state-skills-ai");
  var aiSkills = load("state-skills-ai");
  if (!aiSkills) { h.expect("state-skills-ai 可加载", false, "require 失败"); return; }
  h.expect("state-skills-ai 可加载", true, "");
  h.expect("evalExpr 支持优先级", aiSkills.evalExpr("1+2*3", {}) === 7, String(aiSkills.evalExpr("1+2*3", {})));
  h.expect("evalExpr 支持括号", aiSkills.evalExpr("(1+2)*3", {}) === 9, String(aiSkills.evalExpr("(1+2)*3", {})));
  h.expect("evalExpr 支持 $变量", aiSkills.evalExpr("$a*2+1", { a: 5 }) === 11, String(aiSkills.evalExpr("$a*2+1", { a: 5 })));
  h.expect("evalExpr 除零返回 NaN", isNaN(aiSkills.evalExpr("1/0", {})), String(aiSkills.evalExpr("1/0", {})));
  h.expect("evalExpr 拒绝非法字符", isNaN(aiSkills.evalExpr("1+alert(1)", {})), String(aiSkills.evalExpr("1+alert(1)", {})));
  var ctx = makeCtx(makeFullBot(h, {}), "p2-math");
  ctx.vars.stone = 10;
  var added = await aiSkills.pick("var_add")(ctx, { name: "stone", value: 5 });
  h.expect("var_add 累加正确", added.ok === true && ctx.vars.stone === 15, JSON.stringify(ctx.vars.stone));
  var muled = await aiSkills.pick("var_mul")(ctx, { name: "stone", value: 2 });
  h.expect("var_mul 乘法正确", muled.ok === true && ctx.vars.stone === 30, String(ctx.vars.stone));
  var calced = await aiSkills.pick("calc")(ctx, { name: "total", expr: "$stone/(2+3)" });
  h.expect("calc 支持变量与括号", calced.ok === true && ctx.vars.total === 6, String(ctx.vars.total));
  var badCalc = await aiSkills.pick("calc")(ctx, { name: "x", expr: "1+" });
  h.expect("calc 非法表达式返回 ok:false", badCalc.ok === false, JSON.stringify(badCalc));
  var random = await aiSkills.pick("random_int")(ctx, { name: "roll", min: 1, max: 3 });
  h.expect("random_int 落在区间内", random.ok === true && ctx.vars.roll >= 1 && ctx.vars.roll <= 3, String(ctx.vars.roll));
  var copied = await aiSkills.pick("var_copy")(ctx, { from: "stone", to: "backup" });
  h.expect("var_copy 拷贝变量", copied.ok === true && ctx.vars.backup === 30, String(ctx.vars.backup));
  var noPrompt = await aiSkills.pick("ask_ai")(ctx, {});
  h.expect("ask_ai 缺 prompt 返回 ok:false（不发网络请求）", noPrompt.ok === false, JSON.stringify(noPrompt));
  var noOptions = await aiSkills.pick("ai_decide")(ctx, { prompt: "选一个" });
  h.expect("ai_decide 缺 options 返回 ok:false", noOptions.ok === false, JSON.stringify(noOptions));
}

// 时间流程 + 事件技能（state-skills-flow）。
async function checkFlowSkills(h) {
  h.section("P2-8 时间流程 + 事件技能 / state-skills-flow");
  var flow = load("state-skills-flow");
  if (!flow) { h.expect("state-skills-flow 可加载", false, "require 失败"); return; }
  h.expect("state-skills-flow 可加载", true, "");
  h.expect("compare 支持 gt / contains / eq", flow.compare(5, "gt", 3) === true && flow.compare("hello", "contains", "ell") === true && flow.compare("a", "eq", "a") === true, "");
  var ctx = makeCtx(makeFullBot(h, {}), "p2-flow");
  var delayed = await flow.pick("delay")(ctx, { ms: 5 });
  h.expect("delay 正常返回", delayed.ok === true && delayed.waited === 5, JSON.stringify(delayed));
  var timer = await flow.pick("set_timer")(ctx, { name: "t1", ms: 20 });
  h.expect("set_timer 写进变量", timer.ok === true && typeof ctx.vars.t1 === "number", JSON.stringify(ctx.vars.t1));
  var pending = await flow.pick("timer_done")(ctx, { name: "t1" });
  h.expect("timer_done 未到点返回 done:false", pending.ok === true && pending.done === false, JSON.stringify(pending));
  await h.wait(40);
  var fired = await flow.pick("timer_done")(ctx, { name: "t1" });
  h.expect("timer_done 到点返回 done:true", fired.ok === true && fired.done === true, JSON.stringify(fired));
  var inc = await flow.pick("counter_inc")(ctx, { name: "tries", step: 2 });
  h.expect("counter_inc 作用在计数器上", inc.ok === true && ctx.counters.tries === 2 && ctx.vars.tries === 2, JSON.stringify(ctx.counters));
  var reset = await flow.pick("counter_reset")(ctx, { name: "tries" });
  h.expect("counter_reset 归零", reset.ok === true && ctx.counters.tries === 0, JSON.stringify(ctx.counters));
  ctx.vars.stone = 20;
  var cmp = await flow.pick("check_var")(ctx, { name: "stone", op: "gte", value: 10 });
  h.expect("check_var -> matched:true", cmp.ok === true && cmp.matched === true && ctx.vars.compare === true, JSON.stringify(cmp));
  var cmp2 = await flow.pick("check_var")(ctx, { name: "stone", op: "lt", value: 5 });
  h.expect("check_var -> matched:false", cmp2.ok === true && cmp2.matched === false, JSON.stringify(cmp2));
  var emitted = await flow.pick("emit_event")(ctx, { name: "boom", payload: 7 });
  h.expect("emit_event 写进 ctx.events", emitted.ok === true && ctx.events.boom === 7, JSON.stringify(ctx.events));
  ctx.events.chat = "Steve: follow me please";
  var hit = await flow.pick("on_chat_keyword")(ctx, { keyword: "follow" });
  h.expect("on_chat_keyword 命中聊天", hit.ok === true && hit.matched === true && ctx.vars.chatMatched === true, JSON.stringify(hit));
  ctx.events.chat = "Steve: nothing";
  var miss = await flow.pick("on_chat_keyword")(ctx, { keyword: "follow" });
  h.expect("on_chat_keyword 未命中返回 matched:false", miss.ok === true && miss.matched === false, JSON.stringify(miss));
}

// 宏节点（state-macros）：采集 / 收割 / 守护 / 保命。
async function checkMacros(h) {
  h.section("P2-9 宏节点 / state-macros");
  var macros = load("state-macros");
  if (!macros) { h.expect("state-macros 可加载", false, "require 失败"); return; }
  h.expect("state-macros 可加载", true, "");
  h.expect("宏节点一共 4 个", macros.NAMES.length === 4 && macros.CATEGORIES.macro.length === 4, JSON.stringify(macros.NAMES));
  var bot = makeFullBot(h, { blocks: [h.makeBlock("oak_log", 0, 64, 0)] });
  var ctx = makeCtx(bot, "p2-macro");
  var gathered = await macros.pick("gather_resource")(ctx, { block: "log", count: 2 });
  h.expect("gather_resource 采到 2 个", gathered.ok === true && gathered.steps === 2, JSON.stringify(gathered));
  var farmBot = makeFullBot(h, { blocks: [h.makeBlock("wheat", 0, 64, 0)] });
  var farmed = await macros.pick("farm_area")(makeCtx(farmBot, "p2-macro-farm"), { radius: 8 });
  h.expect("farm_area 至少收 1 个作物", farmed.ok === true && farmed.steps >= 1, JSON.stringify(farmed));
  var emptyCtx = makeCtx(makeFullBot(h, { blocks: [] }), "p2-macro-empty");
  var nothing = await macros.pick("gather_resource")(emptyCtx, { block: "log", count: 3 });
  h.expect("没资源时 gather_resource 返回 ok:false", nothing.ok === false && nothing.steps === 0, JSON.stringify(nothing));
  var healthy = makeFullBot(h, {});
  healthy.health = 20;
  healthy.food = 20;
  var survive = await macros.pick("survive")(makeCtx(healthy, "p2-macro-ok"), {});
  h.expect("状态良好时 survive 不做动作", survive.ok === false && /nothing needed/.test(toText(survive.message)), JSON.stringify(survive));
  var hungry = makeFullBot(h, { items: [{ name: "bread", count: 2, type: 297 }] });
  hungry.health = 20;
  hungry.food = 5;
  var ate = await macros.pick("survive")(makeCtx(hungry, "p2-macro-hungry"), { durationMs: 1000, intervalMs: 10 });
  h.expect("饿了时 survive 会去吃东西", ate.ok === true && ate.steps >= 1, JSON.stringify(ate));
  var guard = await macros.pick("safe_guard")(makeCtx(makeFullBot(h, { entities: {} }), "p2-macro-guard"), { durationMs: 1000, intervalMs: 10 });
  h.expect("没有敌人时 safe_guard 返回 ok:false", guard.ok === false, JSON.stringify(guard));
}

// 状态机核心：校验 / 运行 / 4 重护栏 / 停止 / 每 bot 独立运行时 / 定义文件读写。
async function checkStateMachine(h) {
  h.section("P2-10 状态机核心 / state-machine");
  var sm = load("state-machine");
  if (!sm) { h.expect("state-machine 可加载", false, "require 失败"); return; }
  h.expect("state-machine 可加载", true, "");
  var limits = sm.getLimits();
  h.expect("护栏上限对外可见", limits.maxNodes === 200 && limits.maxSteps === 2000 && limits.maxDurationMs === 3600000, JSON.stringify(limits));
  h.expect("空定义被拒", sm.validate(null).ok === false && sm.validate({ nodes: [] }).ok === false, "");
  var badAction = sm.validate({ nodes: [{ id: "a", action: "fly_to_moon" }] });
  h.expect("未知动作被拒", badAction.ok === false && badAction.errors.length >= 1, JSON.stringify(badAction.errors));
  var dupId = sm.validate({ nodes: [{ id: "a", action: "wait" }, { id: "a", action: "wait" }] });
  h.expect("重复 id 被拒", dupId.ok === false, JSON.stringify(dupId.errors));
  var badNext = sm.validate({ nodes: [{ id: "a", action: "wait", next: "ghost" }] });
  h.expect("next 指向不存在节点被拒", badNext.ok === false, JSON.stringify(badNext.errors));
  var badGoto = sm.validate({ nodes: [{ id: "a", action: "wait", when: { field: "$x", op: "eq", value: 1, goto: "ghost" } }] });
  h.expect("when.goto 指向不存在节点被拒", badGoto.ok === false, JSON.stringify(badGoto.errors));
  var badOp = sm.validate({ nodes: [{ id: "a", action: "wait", when: { field: "$x", op: "~~", value: 1, goto: "a" } }] });
  h.expect("不支持的 when.op 被拒", badOp.ok === false, JSON.stringify(badOp.errors));
  var many = [];
  for (var i = 0; i < 201; i++) many.push({ id: "n" + i, action: "wait" });
  h.expect("节点数超过 200 被拒", sm.validate({ nodes: many }).ok === false, "");

  var bot = makeFullBot(h, { username: "P2Machine" });
  var simple = {
    name: "p2-simple",
    start: "say",
    nodes: [
      { id: "say", action: "chat", args: { message: "机器启动 / machine up" }, next: "hold" },
      { id: "hold", action: "wait", args: { ms: 5 }, next: null }
    ]
  };
  var ran = await sm.run(bot, simple, "p2-machine");
  h.expect("简单状态机跑完 2 步", ran.ok === true && ran.steps === 2 && ran.reason === "finished", JSON.stringify(ran));
  h.expect("状态机真的执行了节点动作", bot.records.chat.indexOf("机器启动 / machine up") >= 0, JSON.stringify(bot.records.chat));
  h.expect("跑完后 isRunning 为 false", sm.isRunning("p2-machine") === false, String(sm.isRunning("p2-machine")));
  h.expect("getRuntime 能读到最近一次运行", sm.getRuntime("p2-machine") && sm.getRuntime("p2-machine").steps === 2, JSON.stringify(sm.getRuntime("p2-machine")));
  h.expect("没跑的 bot 返回 null", sm.getRuntime("p2-ghost") === null && sm.isRunning("p2-ghost") === false, "");

  var loopDef = { name: "p2-loop", start: "a", loop: true, maxSteps: 3, nodes: [{ id: "a", action: "wait", args: { ms: 1 }, next: "a" }] };
  var stepGuard = await sm.run(bot, loopDef, "p2-steps");
  h.expect("步数护栏生效", stepGuard.ok === false && /step limit/.test(toText(stepGuard.guard)) && stepGuard.steps === 3, JSON.stringify(stepGuard));

  var repeatDef = { name: "p2-repeat", start: "a", loop: true, maxSteps: 50, maxNodeRepeat: 2, nodes: [{ id: "a", action: "wait", args: { ms: 1 }, next: "a" }] };
  var repeatGuard = await sm.run(bot, repeatDef, "p2-repeat");
  h.expect("单节点重复护栏生效", repeatGuard.ok === false && /repeat limit/.test(toText(repeatGuard.guard)), JSON.stringify(repeatGuard));

  var onErr = { name: "p2-err", start: "a", nodes: [{ id: "a", action: "chat", args: { message: "" }, onError: "stop", next: null }] };
  var errRun = await sm.run(bot, onErr, "p2-err");
  h.expect("onError:stop 时节点失败即中断", errRun.ok === false && errRun.reason === "error", JSON.stringify(errRun));

  var stopped = sm.stop("p2-ghost");
  h.expect("停一个没在跑的 bot 返回 ok:false", stopped.ok === false, JSON.stringify(stopped));

  var condCtx = { vars: { n: 5 }, bot: bot };
  h.expect("evaluateCondition 支持 $变量比较", sm.evaluateCondition({ field: "$n", op: "gte", value: 5 }, condCtx) === true, "");
  h.expect("evaluateCondition 支持 exists", sm.evaluateCondition({ field: "$n", op: "exists" }, condCtx) === true && sm.evaluateCondition({ field: "$m", op: "exists" }, condCtx) === false, "");
  h.expect("evaluateCondition 空条件视为成立", sm.evaluateCondition(null, condCtx) === true, "");

  var names = sm.listMachines();
  h.expect("模板目录里能看到 3 个状态机", names.indexOf("woodcutter") >= 0 && names.indexOf("patrol-guard") >= 0 && names.indexOf("farm-worker") >= 0, JSON.stringify(names));
  var wood = sm.loadMachine("woodcutter");
  h.expect("woodcutter 模板能加载且通过校验", wood.ok === true && sm.validate(wood.definition).ok === true, JSON.stringify(wood.ok));
  h.expect("不存在的状态机返回 ok:false", sm.loadMachine("no-such-machine").ok === false, "");
  h.expect("非法名字（目录穿越）被拒", sm.loadMachine("../evil").ok === false && sm.saveMachine("../evil", simple).ok === false, "");
  var saved = sm.saveMachine("selftest-p2-tmp", simple);
  h.expect("saveMachine 能保存合法定义", saved.ok === true && fs.existsSync(saved.path), JSON.stringify(saved));
  try { fs.unlinkSync(saved.path); } catch (e) { /* 清理失败不影响断言 */ }
  h.expect("saveMachine 拒绝不合法定义", sm.saveMachine("selftest-p2-bad", { nodes: [] }).ok === false, "");
  var byName = await sm.runByName(makeFullBot(h, { blocks: [h.makeBlock("oak_log", 0, 64, 0)] }), "woodcutter", "p2-byname");
  h.expect("runByName 能跑模板状态机", byName.ok === true && byName.steps >= 2, JSON.stringify(byName));
}

// AI 状态机工具三件套（ai-tools-state）。
async function checkAiTools(h) {
  h.section("P2-11 AI 状态机工具 / ai-tools-state");
  var tools = load("ai-tools-state");
  if (!tools) { h.expect("ai-tools-state 可加载", false, "require 失败"); return; }
  h.expect("ai-tools-state 可加载", true, "");
  h.expect("三件套工具名齐全", tools.TOOL_NAMES.length === 3 && tools.getTools().length === 3, JSON.stringify(tools.TOOL_NAMES));
  h.expect("工具定义符合 OpenAI 规范", tools.getTools()[0].type === "function" && tools.getTools()[0].function.parameters.type === "object", "");
  h.expect("isStateTool 认状态机工具", tools.isStateTool("run_state_machine") === true && tools.isStateTool("functions.stop_state_machine") === true, "");
  h.expect("isStateTool 不认普通工具", tools.isStateTool("dig_block") === false, "");
  var bot = makeFullBot(h, { blocks: [h.makeBlock("oak_log", 0, 64, 0)] });
  var unknown = await tools.executeTool(bot, "p2-tools", "fly_to_moon", "{}");
  h.expect("未知工具返回执行失败文本", unknown.indexOf("执行失败") === 0, unknown);
  var badJson = await tools.executeTool(bot, "p2-tools", "run_state_machine", "{oops");
  h.expect("参数不是合法 JSON 时被拒", badJson.indexOf("执行失败") === 0 && /JSON/.test(badJson), badJson);
  var noMachine = await tools.executeTool(bot, "p2-tools", "run_state_machine", { machine: "no-such-machine" });
  h.expect("跑不存在的状态机返回执行失败", noMachine.indexOf("执行失败") === 0, noMachine);
  var emptyName = await tools.executeTool(bot, "p2-tools", "run_state_machine", {});
  h.expect("缺 machine 参数被拒", emptyName.indexOf("执行失败") === 0, emptyName);
  var badDef = await tools.executeTool(bot, "p2-tools", "create_and_run_machine", { name: "selftest-p2-ai", definition: { nodes: [] } });
  h.expect("定义不合法时拒绝落盘", badDef.indexOf("执行失败") === 0, badDef);
  var goodDef = {
    name: "selftest-p2-ai",
    start: "say",
    nodes: [{ id: "say", action: "chat", args: { message: "AI 造的状态机 / ai made" }, next: null }]
  };
  var created = await tools.executeTool(bot, "p2-tools", "create_and_run_machine", { name: "selftest-p2-ai", definition: goodDef });
  h.expect("合法定义能创建并运行", created.indexOf("成功") === 0, created);
  h.expect("AI 造的状态机真的说了话", bot.records.chat.indexOf("AI 造的状态机 / ai made") >= 0, JSON.stringify(bot.records.chat));
  var again = await tools.executeTool(bot, "p2-tools", "create_and_run_machine", { name: "selftest-p2-ai", definition: goodDef });
  h.expect("同名文件默认不覆盖，走用户确认", again.indexOf("需要用户确认") >= 0, again);
  h.expect("待确认队列里有这条请求", tools.listPending().length === 1 && tools.listPending()[0].name === "selftest-p2-ai", JSON.stringify(tools.listPending()));
  var cancelled = tools.cancelPending("p2-tools");
  h.expect("取消确认后队列清空", cancelled.removed === true && tools.listPending().length === 0, JSON.stringify(cancelled));
  var noPending = await tools.confirmPending("p2-tools", bot);
  h.expect("没有待确认请求时 confirm 返回 ok:false", noPending.ok === false, JSON.stringify(noPending));
  var stopMissing = await tools.executeTool(bot, "p2-tools", "stop_state_machine", {});
  h.expect("停一个没在跑的 bot 返回执行失败", stopMissing.indexOf("执行失败") === 0, stopMissing);
  h.expect("权限表缺失 / 等级不够时工具不放行", tools.toolAllowed("stranger", "run_state_machine") === false, "");
  var sm = load("state-machine");
  if (sm) {
    var file = path.join(ROOT, "state", "statemachines", "selftest-p2-ai.json");
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (e) { /* 清不掉也不影响后续断言 */ }
  }
}

// 每 bot 独立 AI 配置（ai-config + ai-client）。
function checkPerBotConfig(h) {
  h.section("P2-12 每 bot 独立 AI 配置 / per-bot ai config");
  var cfg = load("ai-config");
  if (!cfg) { h.expect("ai-config 可加载", false, "require 失败"); return; }
  h.expect("ai-config 可加载", true, "");
  h.expect("新增接口已导出", typeof cfg.loadFor === "function" && typeof cfg.saveFor === "function" && typeof cfg.getPathFor === "function", "");
  h.expect("非法 botId 被洗掉", cfg.cleanBotId("../evil") === "" && cfg.cleanBotId("ok_id-1") === "ok_id-1", cfg.cleanBotId("ok_id-1"));
  h.expect("getPathFor 指向 ai-configs 目录", /ai-configs/.test(cfg.getPathFor("p2bot")), cfg.getPathFor("p2bot"));
  h.expect("非法 botId 保存被拒", cfg.saveFor("../evil", { model: "x" }).ok === false, "");
  var baseGlobal = cfg.load();
  h.expect("全局配置仍然能读", baseGlobal && typeof baseGlobal.model === "string", JSON.stringify(baseGlobal && baseGlobal.model));
  var saved = cfg.saveFor("p2bot", { model: "p2-model", engine: "llamacpp", baseUrl: "http://127.0.0.1:8080/v1" });
  h.expect("按 bot 保存成功", saved.ok === true, JSON.stringify(saved));
  var perBot = cfg.loadFor("p2bot");
  h.expect("按 bot 读到自己的模型", perBot.model === "p2-model" && perBot.engine === "llamacpp", JSON.stringify(perBot));
  h.expect("按 bot 读配置带 botId 标记", perBot.botId === "p2bot", toText(perBot.botId));
  var other = cfg.loadFor("p2other");
  h.expect("别的 bot 不受影响（回落到全局）", other.model !== "p2-model", JSON.stringify(other.model));
  var ai = load("ai-client");
  h.expect("ai-client 可加载且接受 botId 参数", !!ai && ai.ask.length >= 3 && ai.askWithTools.length >= 5, ai ? (ai.ask.length + "/" + ai.askWithTools.length) : "null");
  var chat = load("chat-handler");
  h.expect("chat-handler 仍导出 attach / handleChat", !!chat && typeof chat.attach === "function" && typeof chat.handleChat === "function", "");
  var file = cfg.getPathFor("p2bot");
  try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (e) { /* 清理失败不影响断言 */ }
}

// 功能：P2 自测入口——按顺序跑完 12 组断言；任何模块缺失只报失败项，绝不抛出。
async function run(h) {
  var helpers = h || {};
  try {
    checkBoard(helpers);
    await checkSwarm(helpers);
    checkUtil(helpers);
    await checkNodeTable(helpers);
    await checkBasicSkills(helpers);
    await checkPlusSkills(helpers);
    await checkMathSkills(helpers);
    await checkFlowSkills(helpers);
    await checkMacros(helpers);
    await checkStateMachine(helpers);
    await checkAiTools(helpers);
    checkPerBotConfig(helpers);
  } catch (err) {
    try { helpers.expect("P2 自测整体没崩 / P2 suite did not crash", false, getErrText(err)); } catch (e) { /* 连 expect 都不可用就只能放弃 */ }
  }
  return { ok: true };
}

// 对外导出：只暴露 run（由 scripts/selftest.js 统一调用）。
module.exports = { run: run };







