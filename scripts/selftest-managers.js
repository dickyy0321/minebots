// ========================================
// 文件：scripts/selftest-managers.js
// 功能：P1 自测补充——player-manager / context-manager / action-bridge 接线 + AI 工具（Function Calling）闭环
// 依赖：fs / path / os；../modules/player-manager、../modules/context-manager、../modules/action-bridge、../modules/command-handler、../modules/ai-tools
// 导出：run（由 scripts/selftest.js 调用，复用它的 section / expect / 造机器人工厂，避免重复代码）
// 作者：MineBots
// ========================================
// 隔离做法：先把 MINEBOTS_STATE_DIR 指到系统临时目录，再 require 两个状态模块（它们按需读环境变量），跑完删临时目录、还原环境变量并清 require 缓存，保证后续测试 / 真实机器人不受影响。
// ES5 风格，CommonJS，无中文变量名

var fs = require("fs");
var os = require("os");
var path = require("path");
var ROOT = path.join(__dirname, "..");
var TEMP_DIR = path.join(os.tmpdir(), "minebots-selftest-" + process.pid + "-" + Date.now());
var OLD_STATE_DIR = process.env.MINEBOTS_STATE_DIR;
var OLD_AUTH = process.env.MINEBOTS_CHAT_AUTH;

// 安静删目录：老 Node 没有 rmSync，就退回逐个删文件再删目录。
function safeRemove(dir) {
  try {
    if (fs.rmSync) { fs.rmSync(dir, { recursive: true, force: true }); return; }
  } catch (e) { /* 删不掉就算了，临时目录交给系统 */ }
  try {
    var names = fs.readdirSync(dir);
    for (var i = 0; i < names.length; i++) {
      try { fs.unlinkSync(path.join(dir, names[i])); } catch (e2) { /* ignore */ }
    }
    fs.rmdirSync(dir);
  } catch (e3) { /* ignore */ }
}

// 列目录：目录不存在时给空数组，免得断言里还要判空。
function listFiles(dir) {
  try { return fs.readdirSync(dir); } catch (e) { return []; }
}

// 数一数列表里某个值出现几次（断言「只清了一次控制状态」这种用）。
function countOf(list, word) {
  var total = 0;
  try {
    var src = list || [];
    for (var i = 0; i < src.length; i++) if (src[i] === word) total = total + 1;
  } catch (e) { return 0; }
  return total;
}

// 解析模块路径，解析不到给 null（可选模块自测用，避免 resolve 直接抛错）。
function resolveOrNull(rel) {
  try { return require.resolve(path.join(ROOT, rel)); } catch (e) { return null; }
}

// 清空临时目录里的文件（保留目录本身），用于「连续几次操作之间」的干净状态。
function cleanDir(dir) {
  var names = listFiles(dir);
  for (var i = 0; i < names.length; i++) {
    try { fs.unlinkSync(path.join(dir, names[i])); } catch (e) { /* ignore */ }
  }
}

// 用假的 ai-client 加载 chat-handler：自测全程不联网，AI 回复固定空串（不回话）。
function loadChatWithStub() {
  var aiFile = require.resolve(path.join(ROOT, "modules/ai-client.js"));
  var chatFile = require.resolve(path.join(ROOT, "modules/chat-handler.js"));
  var savedAi = require.cache[aiFile];
  require.cache[aiFile] = {
    id: aiFile, filename: aiFile, loaded: true,
    exports: {
      ask: function () { return Promise.resolve(""); },
      askWithTools: function () { return Promise.resolve(null); },
      embed: function () { return Promise.resolve(null); }
    }
  };
  delete require.cache[chatFile];
  var mod = require(chatFile);
  if (savedAi) require.cache[aiFile] = savedAi; else delete require.cache[aiFile];
  return mod;
}

// 主入口：h 是 scripts/selftest.js 传进来的工具箱（section / expect / makeBot / ...）。
async function run(h) {
  var section = h.section;
  var expect = h.expect;
  var expectEqual = h.expectEqual;
  section("9. 玩家等级 / 上下文 / 动作接线");
  var pm = null, cm = null, bridge = null, handler = null;
  try {
    process.env.MINEBOTS_STATE_DIR = TEMP_DIR;
    safeRemove(TEMP_DIR);
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
    pm = require(path.join(ROOT, "modules/player-manager.js"));
    cm = require(path.join(ROOT, "modules/context-manager.js"));
    bridge = require(path.join(ROOT, "modules/action-bridge.js"));
    handler = require(path.join(ROOT, "modules/command-handler.js"));
  } catch (err) {
    expect("状态 / 接线模块都能 require", false, String(err && err.message));
    return;
  }
  // ---------- 玩家等级 / player-manager ----------
  var empty = pm.loadPlayers();
  expect("loadPlayers 缺文件时给默认结构", empty.autoJudge === true && Array.isArray(empty.manual.owner) && Object.keys(empty.judged).length === 0, JSON.stringify(empty));
  expect("只是读一下不会擅自写盘", listFiles(TEMP_DIR).length === 0, listFiles(TEMP_DIR).join(","));
  var saved = pm.savePlayers({ manual: { owner: ["Steve"], hostile: ["Herobrine", ""] }, autoJudge: false });
  expect("savePlayers 成功并落盘", saved && saved.ok === true && listFiles(TEMP_DIR).indexOf("players.json") >= 0, JSON.stringify(saved));
  var reloaded = pm.loadPlayers();
  expectEqual("落盘后能读回（空玩家名被丢掉）", { owner: reloaded.manual.owner, hostile: reloaded.manual.hostile, autoJudge: reloaded.autoJudge }, { owner: ["Steve"], hostile: ["Herobrine"], autoJudge: false });
  expectEqual("getLevel 命中 manual owner", pm.getLevel("Steve"), "owner");
  expectEqual("getLevel 忽略大小写", pm.getLevel("steve"), "owner");
  expectEqual("getLevel 查不到给 normal", pm.getLevel("Random"), "normal");
  expectEqual("getLevel 空名字也给 normal", pm.getLevel(""), "normal");
  var mergedSave = pm.savePlayers({ manual: { friend: ["Alex"] } });
  var mergedData = pm.loadPlayers();
  expect("按等级合并：没提交的等级保持原样", mergedSave.ok === true && mergedData.manual.owner.length === 1 && mergedData.manual.friend.length === 1, JSON.stringify(mergedData.manual));
  expect("提交空数组能删掉整级的人", pm.savePlayers({ manual: { hostile: [] } }).ok === true && pm.loadPlayers().manual.hostile.length === 0, "");
  expect("manual 不是对象时被忽略而不是崩", pm.savePlayers({ manual: "oops" }).ok === true && pm.loadPlayers().manual.friend.length === 1, "");
  var judgedOff = pm.judgeByBehavior("Tommy", "attacked_bot");
  expect("autoJudge 关闭时直接跳过、不改判", judgedOff.ok === true && judgedOff.skipped === true && pm.getLevel("Tommy") === "normal", JSON.stringify(judgedOff));
  expect("setAutoJudge(true) 打开自动评判", pm.setAutoJudge(true).autoJudge === true, "");
  var judgedOn = pm.judgeByBehavior("Tommy", "attacked_bot");
  expectEqual("attacked_bot 判成 hostile 并落盘", { ok: judgedOn.ok, level: judgedOn.level, levelLater: pm.getLevel("Tommy") }, { ok: true, level: "hostile", levelLater: "hostile" });
  expectEqual("gave_item 判成 friend", pm.judgeByBehavior("Bob", "gave_item").level, "friend");
  expect("未知行为事件老实失败", pm.judgeByBehavior("Tommy", "danced").ok === false, "");
  expect("缺玩家名老实失败", pm.judgeByBehavior("", "gave_item").ok === false, "");
  expect("manual 优先于 judged", pm.savePlayers({ manual: { owner: ["Tommy"] } }).ok === true && pm.getLevel("Tommy") === "owner", pm.getLevel("Tommy"));
  expect("落盘用 .tmp + rename，没留下临时文件", listFiles(TEMP_DIR).join(",").indexOf(".tmp") < 0, listFiles(TEMP_DIR).join(","));
  var brokenOk = true;
  try { fs.writeFileSync(path.join(TEMP_DIR, "players.json"), "{ not json", "utf8"); } catch (e) { brokenOk = false; }
  expect("坏 JSON 也能读出默认结构（不崩）", brokenOk === true && pm.loadPlayers().autoJudge === true && pm.getLevel("Alex") === "normal", "");
  // ---------- 指令权限 / chat permissions ----------
  cleanDir(TEMP_DIR);
  process.env.MINEBOTS_CHAT_AUTH = "on";
  pm.savePlayers({ manual: { owner: ["Steve"], friend: ["Alex"], hostile: ["Herobrine"], targeted: ["Griefer"] }, autoJudge: false });
  var chatPermissions = require(path.join(ROOT, "modules/chat-permissions.js"));
  var chat = loadChatWithStub();
  var pBot = h.makeBot({ username: "MineBot", entities: { "1": h.makeEntity(1, "player", "Herobrine", 3, 64, 0, { username: "Herobrine" }) } });
  var r1 = await chat.handleChat(pBot, "bot1", "Steve", "dig_tree, blocks=5");
  expect("owner 的指令全部放行", r1 === true && pBot.records.queue.length === 1 && pBot.records.queue[0].actions[0].action === "dig_tree" && pBot.records.queue[0].from === "Steve", JSON.stringify(pBot.records.queue));
  expect("owner 放行时不回“没有权限”", pBot.records.chat.indexOf(chatPermissions.DENY_ZH) < 0 && pBot.records.chat.indexOf(chatPermissions.DENY_EN) < 0, JSON.stringify(pBot.records.chat));
  await chat.handleChat(pBot, "bot1", "steve", "砍树");
  expect("owner 判定忽略大小写", pBot.records.queue.length === 2, JSON.stringify(pBot.records.queue.length));
  await chat.handleChat(pBot, "bot1", "Alex", "跟随");
  expect("friend 放行基础动作（follow）", pBot.records.queue.length === 3 && pBot.records.queue[2].actions[0].action === "follow", JSON.stringify(pBot.records.queue[2]));
  var chatBefore = pBot.records.chat.length;
  await chat.handleChat(pBot, "bot1", "Alex", "攻击");
  expect("friend 拒绝危险动作（attack_all 不进队列）", pBot.records.queue.length === 3 && pBot.records.chat.length === chatBefore + 1, JSON.stringify(pBot.records.queue.length));
  expect("拒绝时只回中文（不再中英混排）", pBot.records.chat[pBot.records.chat.length - 1] === chatPermissions.denyText("zh"), JSON.stringify(pBot.records.chat));
  await chat.handleChat(pBot, "bot1", "Bob", "dig_tree");
  expect("normal 只能聊天：动作被拒且只回英文（玩家说英文）", pBot.records.queue.length === 3 && pBot.records.chat[pBot.records.chat.length - 1] === chatPermissions.denyText("en"), JSON.stringify(pBot.records.queue.length));
  await chat.handleChat(pBot, "bot1", "Herobrine", "stop");
  expect("hostile 全部拒绝且默认不反击", pBot.records.queue.length === 3 && pBot.records.attack.length === 0, JSON.stringify({ queue: pBot.records.queue.length, attack: pBot.records.attack }));
  await chat.handleChat(pBot, "bot1", "Griefer", "挖矿");
  expect("targeted 也全部拒绝", pBot.records.queue.length === 3 && pBot.records.chat[pBot.records.chat.length - 1] === chatPermissions.denyText("zh"), JSON.stringify(pBot.records.queue.length));
  await chat.handleChat(pBot, "bot1", "Alex", "砍树然后攻击");
  expect("部分允许：基础动作放行、危险动作被拒", pBot.records.queue.length === 4 && pBot.records.queue[3].actions.length === 1 && pBot.records.queue[3].actions[0].action === "dig_tree", JSON.stringify(pBot.records.queue[3]));
  expect("部分允许也回“没有权限”（中文玩家只看中文）", pBot.records.chat[pBot.records.chat.length - 1] === chatPermissions.denyText("zh"), JSON.stringify(pBot.records.chat));
  process.env.MINEBOTS_CHAT_AUTH = "off";
  await chat.handleChat(pBot, "bot1", "Bob", "dig_tree");
  expect("MINEBOTS_CHAT_AUTH=off 时放行全部（自测开关）", pBot.records.queue.length === 5, JSON.stringify(pBot.records.queue.length));
  process.env.MINEBOTS_CHAT_AUTH = "on";
  expectEqual("权限纯函数：friend 只允许基础动作", { follow: chatPermissions.isAllowed("friend", "follow"), attack: chatPermissions.isAllowed("friend", "attack_all"), dig: chatPermissions.isAllowed("friend", { action: "dig_block" }) }, { follow: true, attack: false, dig: true });
  expect("权限纯函数：normal 不允许动作 / hostile 判敌对 / close_friend 可信", chatPermissions.isAllowed("normal", "move") === false && chatPermissions.isHostile("targeted") === true && chatPermissions.isTrusted("close_friend") === true, "");
  if (OLD_AUTH === undefined) delete process.env.MINEBOTS_CHAT_AUTH; else process.env.MINEBOTS_CHAT_AUTH = OLD_AUTH;
  try { delete require.cache[require.resolve(path.join(ROOT, "modules/chat-handler.js"))]; } catch (e) { /* ignore */ }
  cleanDir(TEMP_DIR);
  // ---------- 上下文 / context-manager ----------
  var ctxEmpty = cm.loadContext();
  expect("loadContext 空目录给两个空列表", ctxEmpty.permanent.length === 0 && ctxEmpty.temporary.length === 0, JSON.stringify(ctxEmpty));
  expectEqual("没有上下文时 prompt 追加是空串", cm.getSystemPromptAppend(), "");
  var addPerm = cm.addContext("  基地在 100,64,200  ", "permanent");
  var addTemp = cm.addContext("正在下雨，先别出门", "temporary");
  expect("永久 / 临时都能加且去掉首尾空白", addPerm.ok === true && addPerm.mode === "permanent" && addTemp.ok === true && addTemp.mode === "temporary", JSON.stringify([addPerm, addTemp]));
  var ctx = cm.loadContext();
  expect("两个文件分开落盘，带 createdAt", ctx.permanent.length === 1 && ctx.permanent[0].text === "基地在 100,64,200" && typeof ctx.permanent[0].createdAt === "string" && ctx.temporary.length === 1, JSON.stringify(ctx));
  expectEqual("prompt 追加：永久在前、临时在后", cm.getSystemPromptAppend(), "- 基地在 100,64,200\n- 正在下雨，先别出门");
  expect("mode 不是 permanent 一律按临时处理", cm.addContext("别挖基岩", "whatever").mode === "temporary" && cm.loadContext().temporary.length === 2, "");
  expect("空文本不写盘", cm.addContext("   ").ok === false && cm.loadContext().temporary.length === 2, "");
  expect("序号越界老实失败", cm.removeContext(99, "permanent").ok === false && cm.loadContext().permanent.length === 1, "");
  expect("序号不是数字老实失败", cm.removeContext("abc", "temporary").ok === false, "");
  var removedCtx = cm.removeContext(0, "temporary");
  expectEqual("按序号删并返回删掉的内容", { ok: removedCtx.ok, removed: removedCtx.removed, left: cm.loadContext().temporary.length }, { ok: true, removed: "正在下雨，先别出门", left: 1 });
  expect("clearTemporary 只清临时", cm.clearTemporary().ok === true && cm.loadContext().temporary.length === 0 && cm.loadContext().permanent.length === 1, "");
  expectEqual("清完临时后 prompt 只剩永久", cm.getSystemPromptAppend(), "- 基地在 100,64,200");
  expect("上下文落盘也不留 .tmp", listFiles(TEMP_DIR).join(",").indexOf(".tmp") < 0, listFiles(TEMP_DIR).join(","));
  // ---------- AI 组装：上下文记忆真的进了 system 消息（假 axios，不联网） ----------
  var axiosPath = require.resolve("axios");
  var aiPath = require.resolve(path.join(ROOT, "modules/ai-client.js"));
  var savedAxios = require.cache[axiosPath] || null;
  var savedAi = require.cache[aiPath] || null;
  var sentBody = null, aiReply = "";
  try {
    require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: { post: async function (url, body) { sentBody = body; return { data: { choices: [{ message: { content: "收到" } }] } }; } } };
    delete require.cache[aiPath];
    aiReply = await require(aiPath).ask("你是测试", "在吗");
  } catch (err) { sentBody = null; aiReply = ""; }
  if (savedAxios) require.cache[axiosPath] = savedAxios; else delete require.cache[axiosPath];
  if (savedAi) require.cache[aiPath] = savedAi; else delete require.cache[aiPath];
  var sysMsg = (sentBody && sentBody.messages && sentBody.messages[0]) ? String(sentBody.messages[0].content) : "";
  expect("ai-client 用假 axios 跑通（不联网）", aiReply === "收到" && sentBody !== null, aiReply);
  expect("system 消息 = 基础提示 + 上下文记忆", sysMsg.indexOf("你是测试") === 0 && sysMsg.indexOf("- 基地在 100,64,200") > 0, sysMsg);
  expect("user 消息原样发送", !!sentBody && sentBody.messages[1].content === "在吗", sentBody ? String(sentBody.messages[1].content) : "");
  // ---------- 动作接线 / action-bridge + command-handler ----------
  expect("action-bridge 认出 actions 已接线", bridge.available() === true, "");
  expect("没挂寻路插件的 bot 判成不可寻路", bridge.canPathfind(h.makeBot({})) === false, "");
  var pathBot = h.makeBot({});
  pathBot.pathfinder = { setGoal: function () { return true; }, stop: function () { return true; }, goto: function () { return Promise.resolve(); } };
  expect("挂了 setGoal 就判成可寻路", bridge.canPathfind(pathBot) === true, "");
  var missingRes = await bridge.call(pathBot, "noSuchAction", [], "noop", {});
  expect("actions 里没有的方法返回 null（调用方走老实现）", missingRes === null, JSON.stringify(missingRes));
  var failRes = await bridge.call(pathBot, "digBlock", [0, 0, 0], "dig_block", {});
  expect("actions 失败也规整成 { ok:false, error, action }", failRes && failRes.ok === false && typeof failRes.error === "string" && failRes.action === "dig_block", JSON.stringify(failRes));
  var digBot = h.makeBot({ blocks: [h.makeBlock("stone", 2, 64, 0)] });
  var digRes = await handler.executeAction(digBot, { action: "dig_block", position: [2, 64, 0] });
  expect("dig_block 交给 actions.digBlock 并真的挖了", digRes.ok === true && digRes.block === "stone" && digBot.records.dig.join(",") === "stone", JSON.stringify(digRes));
  var digNoPos = await handler.executeAction(digBot, { action: "dig_block" });
  expect("dig_block 缺坐标老实失败", digNoPos.ok === false && typeof digNoPos.error === "string", JSON.stringify(digNoPos));
  var moveBot = h.makeBot({});
  var moveRes = await handler.executeAction(moveBot, { action: "move", position: [1, 64, 1] });
  expect("没 pathfinder 时 move 走分步缓转（不标记 delegated）", moveRes.ok === true && moveRes.delegated === undefined && moveBot.records.lookAt.length >= 2, JSON.stringify(moveRes) + " lookAt=" + moveBot.records.lookAt.length);
  var followBot = h.makeBot({ x: 0, y: 64, z: 0, entities: { "1": h.makeEntity(1, "player", "Alex", 5, 64, 0, { username: "Alex" }) } });
  var followRes = await handler.executeAction(followBot, { action: "follow", players: ["Alex"] });
  expect("follow 交给 actions.followPlayer", followRes.ok === true && followRes.delegated === "actions.followPlayer" && followRes.mode === "simple" && !!followBot._mbFollow, JSON.stringify(followRes));
  await h.wait(1100);
  expect("退化跟随每秒 tick：真的看向并前进", followBot.records.lookAt.length >= 1 && followBot.records.controls.indexOf("forward=1") >= 0, JSON.stringify(followBot.records));
  var stopRes = await handler.executeAction(followBot, { action: "stop" });
  expect("stop 清定时器 + 松开前进键 + 清控制状态", stopRes.ok === true && followBot._mbFollow === null && followBot.records.controls.join(",").indexOf("forward=0,clear") >= 0, JSON.stringify(followBot.records.controls));
  expect("跟随默认保持 2 格", followRes.distance === 2, JSON.stringify(followRes));
  var gazeHead = followBot.records.lookAt.length > 0 ? followBot.records.lookAt[0] : "";
  expect("跟随看的是玩家的头（不是脚底）", gazeHead.indexOf("start:5,66,0") === 0, gazeHead);
  var nearBot = h.makeBot({ x: 0, y: 64, z: 0, entities: { "2": h.makeEntity(2, "player", "Alex", 1, 64, 0, { username: "Alex" }) } });
  var nearRes = await handler.executeAction(nearBot, { action: "follow", players: ["Alex"] });
  await h.wait(1100);
  expect("2 格以内站住不顶人", nearRes.ok === true && nearRes.close === true && nearBot.records.controls.indexOf("forward=1") < 0, JSON.stringify(nearBot.records.controls));
  await handler.executeAction(nearBot, { action: "stop" });
  var pfGoals = [], pfLatch = { stopped: false };
  var pfBot = h.makeBot({ x: 0, y: 64, z: 0, entities: { "3": h.makeEntity(3, "player", "Steve", 6, 64, 0, { username: "Steve" }) } });
  pfBot._mbMoves = { allowSprinting: true, allowParkour: true, canDig: false };
  pfBot.pathfinder = { // 假插件：闸门没复位时 setGoal 直接丢弃目标（等价于 mineflayer-pathfinder 的 stopPathing）
    setMovements: function () { pfLatch.stopped = false; return true; },
    setGoal: function (goal, dynamic) { if (pfLatch.stopped) return true; this.goal = goal; pfGoals.push({ dynamic: dynamic, rangeSq: goal ? goal.rangeSq : -1 }); return true; },
    isMoving: function () { return false; },
    stop: function () { pfLatch.stopped = true; this.goal = null; return true; }
  };
  var pfRes = await handler.executeAction(pfBot, { action: "follow", players: ["Steve"] });
  expect("有插件时跟随交给官方 GoalFollow（2 格 + dynamic）", pfRes.ok === true && pfRes.mode === "pathfinder" && pfGoals.length === 1 && pfGoals[0].rangeSq === 4 && pfGoals[0].dynamic === true, JSON.stringify(pfRes) + " / " + JSON.stringify(pfGoals));
  // 不能跟随自己：跟自己的脚 = 原地不动 + 低头盯地面
  var actsMod = null; try { actsMod = require(path.join(ROOT, "modules/actions.js")); } catch (e1) { actsMod = null; }
  var selfBot = h.makeBot({}); selfBot.entity.id = 99; selfBot.entities["99"] = { id: 99, type: "player", username: "MineBot", position: { x: 0, y: 64, z: 0 } };
  var selfRes = actsMod ? actsMod.followPlayer(selfBot, "MineBot", 2) : null;
  expect("不能跟随自己（否则原地不动 + 低头盯地面）", selfRes !== null && selfRes.ok === false, JSON.stringify(selfRes));

  var collectBot = h.makeBot({});
  collectBot.pathfinder = { setGoal: function () { return true; } };
  var collectRes = await handler.executeAction(collectBot, { action: "collect" });
  expect("collect 交给 actions.collectNearbyItems（附近没东西就报 0）", collectRes.ok === true && collectRes.delegated === "actions.collectNearbyItems" && collectRes.found === 0, JSON.stringify(collectRes));
  var placeBot = h.makeBot({ x: 0, y: 64, z: 0, blocks: [h.makeBlock("dirt", 0, 63, 0)], items: [{ name: "dirt", type: 3, count: 5 }] });
  var placeRes = await handler.executeAction(placeBot, { action: "place" });
  expect("place 交给 actions.placeBlock", placeRes.ok === true && placeRes.delegated === "actions.placeBlock" && placeBot.records.place.join(",") === "dirt", JSON.stringify(placeRes));
  var atkBot = h.makeBot({ entities: { "7": h.makeEntity(7, "mob", "zombie", 2, 64, 0, {}) } });
  var atkRes = await handler.executeAction(atkBot, { action: "attack" });
  expect("attack 交给 actions.attackEntity", atkRes.ok === true && atkBot.records.attack.join(",") === "zombie", JSON.stringify(atkRes));
  // ---------- AI 工具 / Function Calling ----------
  section("9b. AI 工具 / Function Calling");
  var toolMod = null;
  try { toolMod = require(path.join(ROOT, "modules/ai-tools.js")); } catch (err2) { toolMod = null; }
  expect("ai-tools 能 require", toolMod !== null, "");
  if (toolMod !== null) {
    var menu = toolMod.getTools();
    expect("工具菜单一共 14 个", menu.length === 14 && toolMod.TOOL_NAMES.length === 14, menu.length + " / " + toolMod.TOOL_NAMES.length);
    var schemaOk = true, schemaBad = "";
    for (var ti = 0; ti < menu.length; ti++) {
      var item = menu[ti];
      if (!item || item.type !== "function" || !item.function || typeof item.function.name !== "string" || !item.function.parameters || typeof item.function.description !== "string") { schemaOk = false; schemaBad = "第 " + (ti + 1) + " 个"; break; }
    }
    expect("每个工具都带 type / function / parameters / description", schemaOk, schemaBad);
    var copy = toolMod.getTools();
    copy.push({ type: "function" });
    expect("getTools 给的是副本（改外部不影响内部）", toolMod.getTools().length === 14, toolMod.getTools().length + "");
    expectEqual("TOOL_ACTIONS 覆盖全部工具名", Object.keys(toolMod.TOOL_ACTIONS).length, toolMod.TOOL_NAMES.length);
    expect("owner 拿到全套 14 个", toolMod.filterTools("owner").length === 14, toolMod.filterTools("owner").length + "");
    expect("friend 只拿到基础工具（8 个，含 stop）", toolMod.filterTools("friend").length === 8 && toolMod.toolAllowed("friend", "stop") === true && toolMod.toolAllowed("friend", "attack") === false, toolMod.filterTools("friend").length + "");
    expect("normal / hostile 一个不给", toolMod.filterTools("normal").length === 0 && toolMod.filterTools("hostile").length === 0, "");
    expect("未知工具一律拒绝", toolMod.toolAllowed("owner", "self_destruct") === false && toolMod.toolAllowed("owner", "functions.stop") === true, "");
    var toolBot = h.makeBot({ blocks: [h.makeBlock("stone", 0, 63, 0)] });
    var digText = await toolMod.executeTool(toolBot, "dig_block", { x: 0, y: 63, z: 0 });
    expect("executeTool 真的挖了方块", toolBot.records.dig.join(",") === "stone" && digText.indexOf("成功") === 0, digText);
    var posText2 = await toolMod.executeTool(toolBot, "get_position", {});
    expect("查询类工具读到坐标", posText2.indexOf("position") > 0, posText2);
    var noBotText = await toolMod.executeTool(null, "stop", {});
    expect("没有 bot 时老实失败不抛错", noBotText.indexOf("执行失败") === 0 && noBotText.indexOf("机器人未就绪") > 0, noBotText);
    var unkText = await toolMod.executeTool(toolBot, "self_destruct", {});
    expect("未知工具老实失败不抛错", unkText.indexOf("执行失败") === 0 && unkText.indexOf("未知工具") > 0, unkText);
    var badArgText = await toolMod.executeTool(toolBot, "dig_block", "{这不是 JSON");
    expect("坏参数老实失败不抛错", badArgText.indexOf("执行失败") === 0, badArgText);
    // 闭环：AI 首轮返回 tool_calls → 执行工具 → 结果回传 → 二次对话拿最终回复（假 ai-client，不联网）
    var toolAiPath = require.resolve(path.join(ROOT, "modules/ai-client.js"));
    var toolChatPath = require.resolve(path.join(ROOT, "modules/chat-handler.js"));
    var savedToolAi = require.cache[toolAiPath];
    var stubRounds = [];
    require.cache[toolAiPath] = {
      id: toolAiPath, filename: toolAiPath, loaded: true,
      exports: {
        ask: function () { return Promise.resolve("纯聊天兜底"); },
        askWithTools: function (sys, user, list, history) {
          stubRounds.push({ count: list ? list.length : 0, history: history || null });
          if (!history) return Promise.resolve({ message: { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "dig_block", arguments: JSON.stringify({ x: 0, y: 63, z: 0 }) } }] } });
          return Promise.resolve({ message: { role: "assistant", content: "石头挖掉了" } });
        },
        embed: function () { return Promise.resolve(null); }
      }
    };
    delete require.cache[toolChatPath];
    var toolChat = require(toolChatPath);
    var loopBot = h.makeBot({ blocks: [h.makeBlock("stone", 0, 63, 0)] });
    var loopOk = await toolChat.handleChat(loopBot, "bot1", "Steve", "把脚下那块石头挖了");
    expect("闭环：工具真的被执行", loopOk === true && loopBot.records.dig.join(",") === "stone", JSON.stringify(loopBot.records.dig));
    expect("闭环：最终回复发给玩家", loopBot.records.chat.join(",") === "石头挖掉了", JSON.stringify(loopBot.records.chat));
    var round2 = stubRounds.length > 1 ? stubRounds[1].history : null;
    expect("闭环：二次对话带上 assistant.tool_calls + tool 结果", Array.isArray(round2) && round2.length === 2 && round2[0].role === "assistant" && round2[1].role === "tool" && round2[1].tool_call_id === "c1" && round2[1].content.indexOf("stone") > 0, JSON.stringify(round2));
    expect("闭环：首轮菜单已按等级裁剪且非空（14 基础工具 + 3 状态机工具）", stubRounds.length > 0 && stubRounds[0].count >= 14, stubRounds.length > 0 ? stubRounds[0].count + "" : "没调 askWithTools");
    if (savedToolAi) require.cache[toolAiPath] = savedToolAi; else delete require.cache[toolAiPath];
    delete require.cache[toolChatPath];
  }

  // ---------- 9c. 版本号 / bot version（自动探测值必须被彻底屏蔽） ----------
  section("9c. 版本号 / bot version");
  var botMod = require(path.join(ROOT, "modules/bot-manager.js"));
  expect("normalizeVersion 把自动探测值改成 1.21.1",
    botMod.normalizeVersion("auto") === "1.21.1" && botMod.normalizeVersion("AUTO") === "1.21.1", botMod.normalizeVersion("auto"));
  expect("normalizeVersion 空值 / latest / 非法字符都兜底 1.21.1",
    botMod.normalizeVersion("") === "1.21.1" && botMod.normalizeVersion("latest") === "1.21.1" &&
    botMod.normalizeVersion("1.2 0;rm") === "1.21.1" && botMod.normalizeVersion(null) === "1.21.1", "");
  expect("normalizeVersion 保留合法版本号（含首尾空格）",
    botMod.normalizeVersion("1.20.4") === "1.20.4" && botMod.normalizeVersion(" 1.21.1 ") === "1.21.1", "");
  var rootSettings = require(path.join(ROOT, "settings.js"));
  expect("settings.js 里的自动探测版本经归一化后是 1.21.1",
    botMod.normalizeVersion(rootSettings && rootSettings.minecraft ? rootSettings.minecraft.version : "") === "1.21.1", "");
  botMod.setTestMode(true);
  var verStart = botMod.startBot({ id: "selftest-ver", host: "localhost", port: 25565, username: "VerBot", version: "auto" });
  var verRec = botMod.getBot("selftest-ver");
  expect("测试模式启动成功，且记录里版本是 1.21.1 而不是自动探测值",
    verStart && verStart.ok === true && verRec && verRec.version === "1.21.1" && verRec.fake === true, JSON.stringify(verStart));
  var verListed = null;
  var verAll = botMod.listBots();
  for (var vi = 0; vi < verAll.length; vi++) { if (verAll[vi].id === "selftest-ver") verListed = verAll[vi]; }
  expect("listBots 把版本号报给 GUI", verListed !== null && verListed.version === "1.21.1", JSON.stringify(verListed));
  botMod.stopBot("selftest-ver");
  botMod.setTestMode(false);
  expect("停止后记录已清理，测试模式已复原", botMod.getBot("selftest-ver") === null, "");

  // ---------- 9d. 插件加载器 / plugin loader（六种导出写法都必须能注入） ----------
  section("9d. 插件加载器 / plugin loader");
  var pluginLoader = require(path.join(ROOT, "modules/plugin-loader.js"));
  var pluginDir = path.join(TEMP_DIR, "plugins");
  try { fs.mkdirSync(pluginDir, { recursive: true }); } catch (e) { /* 建不了就在下面的 writeFileSync 里暴露 */ }
  var pluginCases = [
    { tag: "fn", code: "module.exports = function (bot) { bot.__hit = 'fn'; };" },
    { tag: "plugin", code: "module.exports = { plugin: function (bot) { bot.__hit = 'plugin'; } };" },
    { tag: "inject", code: "module.exports = { inject: function (bot) { bot.__hit = 'inject'; } };" },
    { tag: "default_fn", code: "module.exports = { default: function (bot) { bot.__hit = 'default_fn'; } };" },
    { tag: "default_plugin", code: "module.exports = { default: { plugin: function (bot) { bot.__hit = 'default_plugin'; } } };" },
    { tag: "default_inject", code: "module.exports = { default: { inject: function (bot) { bot.__hit = 'default_inject'; } } };" },
    { tag: "loader", code: "module.exports = { loader: function (bot) { bot.__hit = 'loader'; } };" },
    { tag: "getplugin", code: "module.exports = { getPlugin: function () { return function (bot) { bot.__hit = 'getplugin'; }; } };" },
    { tag: "pathfinder", code: "module.exports = { pathfinder: function (bot) { bot.__hit = 'pathfinder'; } };" },
    { tag: "loader_opts", code: "module.exports = { loader: function (bot, opts) { bot.__hit = (opts && typeof opts === 'object') ? 'loader_opts' : 'loader_none'; } };" }
  ];
  for (var pc = 0; pc < pluginCases.length; pc++) {
    var casePath = path.join(pluginDir, "case_" + pluginCases[pc].tag + ".js");
    try { fs.writeFileSync(casePath, pluginCases[pc].code, "utf8"); } catch (e) { /* 写失败下面断言会报出来 */ }
    var caseBot = {};
    var caseRes = pluginLoader.applyPlugin(caseBot, casePath);
    expect("插件写法 " + pluginCases[pc].tag + " 能被注入",
      caseRes.ok === true && caseBot.__hit === pluginCases[pc].tag, JSON.stringify(caseRes));
  }
  var nonePath = path.join(pluginDir, "case_none.js");
  try { fs.writeFileSync(nonePath, "module.exports = { hello: 1 };", "utf8"); } catch (e) { /* ignore */ }
  var noneRes = pluginLoader.applyPlugin({}, nonePath);
  expect("不认识的导出写法如实报 no valid loader method",
    noneRes.ok === false && noneRes.error === "no valid loader method", JSON.stringify(noneRes));
  var missingRes = pluginLoader.applyPlugin({}, path.join(pluginDir, "no_such_plugin.js"));
  expect("模块不存在时老实失败不抛错", missingRes.ok === false && String(missingRes.error || "").length > 0, JSON.stringify(missingRes));
  expect("15 个插件清单与分类表保持齐全（寻路前置排第一）",
    pluginLoader.PLUGINS.length === 15 && Object.keys(pluginLoader.PLUGIN_CATEGORIES).length === 14 &&
    pluginLoader.PLUGINS[0] === "mineflayer-pathfinder" &&
    pluginLoader.getCategory("mineflayer-pathfinder") === "pathfinding", "");
  expect("纯 API 库进静默名单，antiafk 走 spawn 延后注入",
    pluginLoader.SILENT_PLUGINS.length === 5 &&
    pluginLoader.SILENT_PLUGINS.indexOf("mineflayer-viaproxy") >= 0 &&
    pluginLoader.DEFERRED_PLUGINS["@rhld16/mineflayer-antiafk"] === "spawn", "");


  // ---------- 9e. 聊天调试雷达 / chat debug radar（监听挂载 + AI 失败必须暴露） ----------
  section("9e. 聊天调试雷达 / chat debug radar");
  var radarLogPath = require.resolve(path.join(ROOT, "modules/logger.js"));
  var radarAiPath = require.resolve(path.join(ROOT, "modules/ai-client.js"));
  var radarChatPath = require.resolve(path.join(ROOT, "modules/chat-handler.js"));
  var savedRadarLog = require.cache[radarLogPath];
  var savedRadarAi = require.cache[radarAiPath];
  var radarLines = [];
  require.cache[radarLogPath] = {
    id: radarLogPath, filename: radarLogPath, loaded: true,
    exports: {
      system: function (m) { radarLines.push("system|" + m); },
      warn: function (m) { radarLines.push("warn|" + m); },
      error: function (m) { radarLines.push("error|" + m); },
      lan: function (m) { radarLines.push("lan|" + m); },
      info: function () {}, debug: function () {}, server: function () {}
    }
  };
  require.cache[radarAiPath] = {
    id: radarAiPath, filename: radarAiPath, loaded: true,
    exports: {
      ask: function () { return Promise.reject(new Error("selftest-ai-down")); },
      askWithTools: function () { return Promise.resolve(null); },
      embed: function () { return Promise.resolve(null); },
      getStatus: function () { return { lastError: "selftest-ai-down" }; }
    }
  };
  delete require.cache[radarChatPath];
  var radarChat = require(radarChatPath);
  var radarBot = h.makeBot({ username: "RadarBot" });
  var radarDetach = radarChat.attach(radarBot, "radar");
  expect("监听挂载后 GUI 能看到挂载日志", radarLines.join("|").indexOf("聊天监听已挂载") > 0, radarLines.join("|"));
  radarBot.emit("chat", "Steve", "你好呀");
  await h.wait(20);
  var radarAll = radarLines.join("\n");
  expect("[DEBUG-CHAT] 能看到收到的聊天原文", radarAll.indexOf("[DEBUG-CHAT] 收到聊天: <Steve> 你好呀") >= 0, radarAll);
  expect("[DEBUG-AI] 能看到准备请求 AI 的输入文本", radarAll.indexOf("[DEBUG-AI] 开始向 AI 请求回复，输入文本: 你好呀") >= 0, radarAll);
  expect("AI 失败必须走 error 日志（不静默吞掉）",
    radarLines.filter(function (l) { return l.indexOf("error|") === 0 && l.indexOf("selftest-ai-down") >= 0; }).length > 0, radarAll);
  expect("AI 没回复时补一条明确告警", radarLines.filter(function (l) { return l.indexOf("warn|") === 0 && l.indexOf("AI 没有给出回复") >= 0; }).length > 0, radarAll);
  radarBot.emit("chat", "RadarBot", "自己说的话");
  await h.wait(20);
  expect("自己发的消息也打雷达，但标记为跳过",
    radarLines.join("\n").indexOf("[DEBUG-CHAT] 收到聊天: <RadarBot> 自己说的话（自己发的 / self, ignored）") >= 0, radarLines.join("\n"));
  try { radarDetach(); } catch (e) { /* 卸载失败不影响断言 */ }
  if (savedRadarLog) require.cache[radarLogPath] = savedRadarLog; else delete require.cache[radarLogPath];
  if (savedRadarAi) require.cache[radarAiPath] = savedRadarAi; else delete require.cache[radarAiPath];
  delete require.cache[radarChatPath];

  // ---------- 9f. 抢占与视线 / preempt & gaze（新指令抢控制权 + 500ms 视线心跳） ----------
  section("9f. 抢占与视线 / preempt & gaze");
  var gHandler = require(path.join(ROOT, "modules/command-handler.js"));
  var gazeBot = h.makeBot({ entities: { "3": h.makeEntity(3, "player", "Alex", 5, 64, 0, { username: "Alex" }) } });
  var gazeFollow = await gHandler.executeAction(gazeBot, { action: "follow", players: ["Alex"] });
  var gazeAt = gazeBot.records.lookAt.length;
  await h.wait(700);
  expect("跟随时视线有 500ms 心跳（不是只看一眼就走）",
    gazeFollow.ok === true && !!gazeBot._mbGaze && gazeBot.records.lookAt.length > gazeAt,
    gazeAt + " -> " + gazeBot.records.lookAt.length);
  var gazeStop = await gHandler.executeAction(gazeBot, { action: "stop" });
  expect("stop 同时关掉视线心跳与跟随定时器",
    gazeStop.ok === true && gazeBot._mbGaze === null && gazeBot._mbFollow === null, JSON.stringify(gazeBot.records.controls));
  var preBot = h.makeBot({ entities: { "4": h.makeEntity(4, "player", "Steve", 4, 64, 0, { username: "Steve" }) } });
  var preFollow = await gHandler.executeAction(preBot, { action: "follow", players: ["Steve"] });
  var clearBefore = countOf(preBot.records.controls, "clear");
  expect("新动作先抢占：控制状态被清过一次",
    preFollow.ok === true && clearBefore >= 1 && !!preBot._mbGaze, JSON.stringify(preBot.records.controls));
  var preStop = await gHandler.executeAction(preBot, { action: "stop" });
  expect("stop 不再重复抢占（只多清一次控制状态）",
    preStop.ok === true && countOf(preBot.records.controls, "clear") === clearBefore + 1, JSON.stringify(preBot.records.controls));

  // ---------- 9g. 任务播报 / task narration（模板双语 + 8 秒冷却 + 错误只报一次） ----------
  section("9g. 任务播报 / task narration");
  var narr = require(path.join(ROOT, "modules/task-narration.js"));
  expect("播报模板是单语：中文只出中文、英文只出英文",
    narr.textFor("accept", "dig_tree") === "收到，我去砍木头" && narr.textFor("step", "mine") === "接下来：挖矿" &&
    narr.textFor("done", "collect") === "捡东西完成" && narr.textFor("error", "attack") === "打怪没做成" &&
    narr.textFor("accept", "dig_tree", "en") === "Got it, chopping wood" && narr.textFor("error", "mine", "en") === "Failed: mining",
    narr.textFor("step", "mine"));
  expect("不认识的类型返回空串，不认识的动作退回「这个活」",
    narr.textFor("pause", "mine") === "" && narr.textFor("accept", "unknown_job") === "收到，我去这个活",
    narr.textFor("accept", "unknown_job"));
  var narrBot = h.makeBot({});
  var narrFirst = narr.announce(narrBot, "narr", "accept", { action: "dig_tree" });
  expect("收到任务先播报一句",
    narrFirst.ok === true && narrFirst.sent === true && narrBot.records.chat.length === 1, JSON.stringify(narrFirst));
  var narrSecond = narr.announce(narrBot, "narr", "step", { action: "mine" });
  expect("8 秒冷却内不再刷屏",
    narrSecond.ok === false && narrSecond.reason === "cooldown" && narrBot.records.chat.length === 1 &&
    narr.getState(narrBot).skipped === 1, JSON.stringify(narrSecond));
  expect("冷却时长写死 8 秒", narr.COOLDOWN_MS === 8000, narr.COOLDOWN_MS + "");
  narr.reset(narrBot);
  var narrErr1 = narr.announce(narrBot, "narr", "error", { action: "mine", runId: "run-1" });
  var narrErr2 = narr.announce(narrBot, "narr", "error", { action: "mine", runId: "run-1" });
  expect("同一轮任务里错误只报一次",
    narrErr1.ok === true && narrErr2.ok === false && narrErr2.reason === "duplicate" && narrBot.records.chat.length === 2,
    JSON.stringify([narrErr1, narrErr2]));
  var narrErr3 = narr.announce(narrBot, "narr", "error", { action: "mine", runId: "run-2" });
  expect("换一轮任务、同样一句话 30 秒内也不重复",
    narrErr3.ok === false && narrErr3.reason === "duplicate", JSON.stringify(narrErr3));
  var narrNoBot = narr.announce(null, "narr", "step", { action: "mine" });
  expect("没有 bot 时老实返回 no-bot（不抛错）", narrNoBot.ok === false && narrNoBot.reason === "no-bot", JSON.stringify(narrNoBot));
  var narrMute = narr.announce({}, "narr", "step", { action: "mine" });
  expect("bot 没有 chat 接口时返回 no-chat", narrMute.ok === false && narrMute.reason === "no-chat", JSON.stringify(narrMute));
  var narrFalseBot = h.makeBot({});
  narrFalseBot.chat = function () { return false; };
  var narrFalse = narr.announce(narrFalseBot, "narr", "step", { action: "move" });
  expect("chat 自己返回 false 时不算已播报",
    narrFalse.ok === false && narrFalse.reason === "chat-failed" && narr.getState(narrFalseBot).said === 0, JSON.stringify(narrFalse));

  // ---------- 9h. 模组探测器 / mod detector（去重 + 学一次失败就停，不刷屏不空转） ----------
  section("9h. 模组探测器 / mod detector");
  var detFile = resolveOrNull("modules/mod-detector.js");
  var detKbFile = resolveOrNull("modules/knowledge-base.js");
  var detCtxFile = resolveOrNull("modules/mod-context.js");
  var savedDetKb = detKbFile ? require.cache[detKbFile] : null;
  var savedDetCtx = detCtxFile ? require.cache[detCtxFile] : null;
  var detCtxCalls = [];
  if (detKbFile) {
    require.cache[detKbFile] = {
      id: detKbFile, filename: detKbFile, loaded: true,
      exports: { find: function () { return null; }, save: function () { return { ok: true }; } }
    };
  }
  if (detCtxFile) {
    require.cache[detCtxFile] = {
      id: detCtxFile, filename: detCtxFile, loaded: true,
      exports: { getContext: function (name) { detCtxCalls.push(name); return Promise.reject(new Error("selftest-offline")); } }
    };
  }
  if (detFile) delete require.cache[detFile];
  var det = detFile ? require(detFile) : null;
  expect("mod-detector 能 require", det !== null, "");
  if (det !== null) {
    var detBot = h.makeBot({ blocks: [
      h.makeBlock("coolmod:crystal_ore", 0, 64, 0),
      h.makeBlock("minecraft:stone", 1, 64, 0),
      h.makeBlock("iris:shader_block", 2, 64, 0)
    ] });
    var detChunk = { position: { x: 0, y: 64, z: 0 } };
    var detNames = det.scanChunk(detBot, "det", detChunk);
    expect("扫区块只收未知方块（minecraft / 优化模组都跳过）",
      JSON.stringify(detNames) === JSON.stringify(["coolmod:crystal_ore"]), JSON.stringify(detNames));
    await h.wait(30);
    expect("查不到资料的名字被记成 failed（failedCount = 1）",
      detCtxCalls.length === 1 && det.getStats("det").failedCount === 1,
      detCtxCalls.join(",") + " / " + JSON.stringify(det.getStats("det")));
    det.scanChunk(detBot, "det", detChunk);
    await h.wait(30);
    expect("同一个失败方块不再重复联网（学一次失败就够）",
      detCtxCalls.length === 1 && det.getStats("det").failedCount === 1, detCtxCalls.length + "");
    var detFresh = det.onChunkLoad(detBot, "det2", detChunk);
    await h.wait(30);
    var detAgain = det.onChunkLoad(detBot, "det2", detChunk);
    expect("区块加载只记新名字（同一个区块第二次 0 个）",
      detFresh === 1 && detAgain === 0 && det.getStats("det2").scannedCount === 1, detFresh + " / " + detAgain);
    var detUpBot = h.makeBot({});
    var detTriggers = 0;
    for (var dui = 0; dui < 10; dui++) {
      if (det.onBlockUpdate(detUpBot, "det3", null, h.makeBlock("coolmod:test_ore", 0, 64, 0)) === true) detTriggers++;
    }
    expect("方块更新攒够 10 次才重扫一次", detTriggers === 1 && det.getStats("det3").pending === 0,
      detTriggers + " / " + JSON.stringify(det.getStats("det3")));
    expect("shouldSkip 认空名 / minecraft / 优化模组，未知模组方块放行",
      det.shouldSkip("") === true && det.shouldSkip("minecraft:stone") === true &&
      det.shouldSkip("iris:shader_block") === true && det.shouldSkip("coolmod:crystal_ore") === false, "");
    expect("getStats 对新 botId 返回全 0（不抛错）",
      JSON.stringify(det.getStats("never-seen")) === JSON.stringify({ pending: 0, scannedCount: 0, failedCount: 0 }),
      JSON.stringify(det.getStats("never-seen")));
    expect("startScan 建状态（重连从零开始），没有 bot 时老实返回 false",
      det.startScan(detUpBot, "det3") === true && det.getStats("det3").failedCount === 0 &&
      det.getStats("det3").scannedCount === 0 && det.startScan(null, "det4") === false, JSON.stringify(det.getStats("det3")));
    expect("空气与常见原版方块一律不学（去噪）",
      det.shouldSkip("air") === true && det.shouldSkip("cave_air") === true && det.shouldSkip("void_air") === true &&
      det.shouldSkip("oak_log") === true && det.shouldSkip("torch") === true && det.shouldSkip("stone") === true, "");
    expect("registry 认得的是原版（跳过），registry 不认的才学",
      det.shouldSkip("weird_ore", { registry: { blocksByName: { weird_ore: {} } } }) === true &&
      det.shouldSkip("weird_ore", { registry: { blocksByName: {} } }) === false, "");
    var detNoiseBot = h.makeBot({ blocks: [
      h.makeBlock("air", 0, 64, 0), h.makeBlock("oak_log", 1, 64, 0),
      h.makeBlock("torch", 2, 64, 0), h.makeBlock("coolmod:noise_ore", 3, 64, 0)
    ] });
    var detNoise = det.scanChunk(detNoiseBot, "det5", detChunk);
    expect("扫区块滤掉空气 / 原版方块，只留模组方块",
      JSON.stringify(detNoise) === JSON.stringify(["coolmod:noise_ore"]), JSON.stringify(detNoise));
  }
  if (detKbFile) { if (savedDetKb) require.cache[detKbFile] = savedDetKb; else delete require.cache[detKbFile]; }
  if (detCtxFile) { if (savedDetCtx) require.cache[detCtxFile] = savedDetCtx; else delete require.cache[detCtxFile]; }
  if (detFile) delete require.cache[detFile];

  // ---------- 收尾：删临时目录、还原环境变量、清缓存 ----------
  safeRemove(TEMP_DIR);
  if (OLD_STATE_DIR === undefined) delete process.env.MINEBOTS_STATE_DIR;
  else process.env.MINEBOTS_STATE_DIR = OLD_STATE_DIR;
  var purge = ["modules/player-manager.js", "modules/context-manager.js"];
  for (var i = 0; i < purge.length; i++) {
    try { delete require.cache[require.resolve(path.join(ROOT, purge[i]))]; } catch (e) { /* ignore */ }
  }
  expect("临时 state 目录已清掉", fs.existsSync(TEMP_DIR) === false, TEMP_DIR);
}

// 导出：selftest.js 里一行 require 就能跑完这一节。
module.exports = { run: run };



