// ========================================
// 文件：scripts/selftest-p3.js
// 功能：P3 自测——实时遥测 / 手动驾驶 / 3D 视角桥 / 附加 IPC 通道（含 16 个高级动作目录）
// 依赖：modules/telemetry、modules/manual-control、modules/viewer-bridge、modules/actions-catalog、
//       gui/ipc-extra（都可选，缺失只报失败不崩）
// 产物：无（断言写进总报告；临时数据只在内存里造，不落盘）
// 作者：MineBots
// ========================================
//
// 用法：由 scripts/selftest.js 统一调用 run(helpers)，helpers 提供 section / expect / expectEqual / wait
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers
var path = require("path");
var ROOT = path.join(__dirname, "..");

// 载入项目内文件：失败返回 null（调用方据此报失败项，而不是让自测整体崩掉）。
function load(rel) {
  try { return require(path.join(ROOT, rel)); } catch (e) { return null; }
}

// 安全提取错误文本，catch 里不会二次抛错。
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

// 转数字（非法值返回兜底值）。
function toNum(value, fallback) {
  try {
    var n = parseFloat(value);
    return isNaN(n) ? fallback : n;
  } catch (e) { return fallback; }
}

// 造一个假 bot：手动控制的 6 个接口 + 遥测要读的字段 + 16 格内一只僵尸。
function makeP3Bot() {
  var bot = {
    username: "P3Bot", _mbBotId: "p3-bot", quickBarSlot: 0,
    health: 20, food: 18,
    entity: { position: { x: 10, y: 64, z: 10 }, yaw: 1.5, pitch: -0.25 },
    entities: {},
    game: { dimension: "overworld" },
    time: { timeOfDay: 6000 },
    experience: { level: 5, points: 100, progress: 0.5 },
    heldItem: { name: "iron_pickaxe", count: 1 },
    inventory: { items: function () { return [{ name: "oak_log", count: 3, slot: 36 }]; }, slots: {} },
    records: { controls: [], look: [], attack: [], swing: 0, use: 0 }
  };
  bot.entities["ent-1"] = { name: "zombie", type: "mob", position: { x: 12, y: 64, z: 10 } };
  bot.entities["ent-2"] = { username: "Steve", type: "player", position: { x: 10, y: 64, z: 14 } };
  bot.setControlState = function (name, on) { bot.records.controls.push(toText(name) + ":" + (on ? "1" : "0")); };
  bot.clearControlStates = function () { bot.records.controls.push("clear"); };
  bot.look = function (yaw, pitch) { bot.records.look.push(toNum(yaw, 0) + "," + toNum(pitch, 0)); return Promise.resolve(true); };
  bot.setQuickBarSlot = function (slot) { bot.quickBarSlot = toNum(slot, 0); };
  bot.attack = function (target) { bot.records.attack.push(toText(target && (target.username || target.name))); };
  bot.swingArm = function () { bot.records.swing = bot.records.swing + 1; };
  bot.activateItem = function () { bot.records.use = bot.records.use + 1; };
  bot.on = function () { return bot; };
  bot.removeListener = function () { return bot; };
  return bot;
}

// P3-1 手动驾驶：控制位清单 / 按下松开 / 视角夹取 / 快捷栏 / 攻击与使用。
function checkManual(h) {
  h.section("P3-1 手动驾驶 / manual-control");
  var mod = load("modules/manual-control.js");
  if (!mod) { h.expect("manual-control 可加载", false, "require 失败"); return null; }
  h.expect("manual-control 可加载", true, "");
  h.expect("控制位一共 7 个", Array.isArray(mod.CONTROLS) && mod.CONTROLS.length === 7, JSON.stringify(mod.CONTROLS));
  h.expect("子动作一共 6 个", Array.isArray(mod.ACTIONS) && mod.ACTIONS.length === 6, JSON.stringify(mod.ACTIONS));
  h.expect("isControl 认 forward", mod.isControl("forward") === true && mod.isControl(" FORWARD ") === true, "");
  h.expect("isControl 拒绝未知键", mod.isControl("fly") === false && mod.isControl("") === false, "");

  var bot = makeP3Bot();
  var down = mod.press(bot, "forward", true);
  h.expect("按下 forward 真的下发", down.ok === true && bot.records.controls.indexOf("forward:1") >= 0, JSON.stringify(bot.records.controls));
  var up = mod.press(bot, "forward", false);
  h.expect("松开 forward 真的下发", up.ok === true && bot.records.controls.indexOf("forward:0") >= 0, "");
  h.expect("按下未知键返回 ok:false", mod.press(bot, "fly", true).ok === false, "");
  h.expect("bot 为空返回 ok:false", mod.press(null, "forward", true).ok === false, "");

  var released = mod.releaseAll(bot);
  h.expect("releaseAll 调了 clearControlStates", released.ok === true && bot.records.controls.indexOf("clear") >= 0, JSON.stringify(bot.records.controls));

  var looked = mod.look(bot, 0.5, 9);
  h.expect("look 把俯仰夹到 ±90 度", looked.ok === true && Math.abs(looked.pitch - Math.PI / 2) < 1e-9, JSON.stringify(looked));
  h.expect("look 拒绝了非数字", mod.look(bot, "abc", 0).ok === false, "");

  var slot = mod.hotbar(bot, 3);
  h.expect("hotbar 切到第 4 格", slot.ok === true && bot.quickBarSlot === 3, JSON.stringify(slot));
  h.expect("hotbar 拒绝 0-8 之外的槽位", mod.hotbar(bot, 9).ok === false, "");

  var hit = mod.attack(bot);
  h.expect("attack 打到最近的僵尸", hit.ok === true && bot.records.attack.indexOf("zombie") >= 0, JSON.stringify(bot.records.attack));
  h.expect("attack 顺手挥了手", bot.records.swing === 1, String(bot.records.swing));
  h.expect("use 调了 activateItem", mod.use(bot).ok === true && bot.records.use === 1, String(bot.records.use));

  var viaHandle = mod.handle(bot, { action: "press", key: "jump", on: true });
  h.expect("handle 分派 press", viaHandle.ok === true && bot.records.controls.indexOf("jump:1") >= 0, JSON.stringify(viaHandle));
  h.expect("handle 拒绝未知动作", mod.handle(bot, { action: "fly" }).ok === false, "");
  h.expect("handle 缺 bot 返回 ok:false", mod.handle(null, { action: "use" }).ok === false, "");
  return bot;
}


// P3-2 实时遥测：状态打包 / 挨打告警 / 方块事件 / 快照 / 定时广播。
function checkTelemetry(h) {
  h.section("P3-2 实时遥测 / telemetry");
  var mod = load("modules/telemetry.js");
  if (!mod) { h.expect("telemetry 可加载", false, "require 失败"); return null; }
  h.expect("telemetry 可加载", true, "");
  h.expect("事件缓存上限 40", mod.MAX_EVENTS === 40, String(mod.MAX_EVENTS));
  h.expect("默认广播间隔 1000ms", mod.BROADCAST_MS === 1000, String(mod.BROADCAST_MS));

  var empty = mod.getBotState(null);
  h.expect("空 bot 的快照 ok:false", empty.ok === false && toText(empty.message).length > 0, JSON.stringify(empty));

  var bot = makeP3Bot();
  var state = mod.getBotState(bot);
  h.expect("快照 ok:true 且带 id", state.ok === true && state.id === "p3-bot", JSON.stringify({ ok: state.ok, id: state.id }));
  h.expect("血量 / 饥饿读到 20 / 18", state.health === 20 && state.food === 18, JSON.stringify({ h: state.health, f: state.food }));
  h.expect("坐标读到 (10,64,10)", state.position && state.position.x === 10 && state.position.y === 64 && state.position.z === 10, JSON.stringify(state.position));
  h.expect("维度 overworld", state.dimension === "overworld", toText(state.dimension));
  h.expect("时间 phase=day", state.time && state.time.phase === "day", JSON.stringify(state.time));
  h.expect("经验 5 级 / 100 点", state.experience && state.experience.level === 5 && state.experience.points === 100, JSON.stringify(state.experience));
  h.expect("主手读到铁镐", state.mainHand && state.mainHand.name === "iron_pickaxe", JSON.stringify(state.mainHand));
  h.expect("背包读到 1 格", state.inventorySlots === 1, String(state.inventorySlots));
  h.expect("朝向 yaw=1.5 / pitch=-0.25", state.view && state.view.yaw === 1.5 && Math.abs(state.view.pitch + 0.25) < 1e-9, JSON.stringify(state.view));
  h.expect("16 格内记到 2 个实体", Array.isArray(state.nearby) && state.nearby.length === 2, JSON.stringify(state.nearby));

  var pushed = [];
  h.expect("setSink 接受回调", mod.setSink(function (payload) { pushed.push(payload); }) === true, "");
  h.expect("attach 挂上了监听", mod.attach(bot, "p3-bot") === true, "");
  var hurt = mod.handleHurt(bot, bot.entity, { position: { x: 11, y: 64, z: 10 }, username: "Greifer" });
  h.expect("挨打记成 bot_under_attack", hurt && hurt.type === "bot_under_attack" && hurt.attackerName === "Greifer", JSON.stringify(hurt));
  h.expect("挨打推了一条 alert", pushed.length === 1 && pushed[0].kind === "alert", JSON.stringify(pushed[0] && pushed[0].kind));
  h.expect("别人的实体受伤不算遇袭", mod.handleHurt(bot, { position: { x: 0, y: 0, z: 0 } }, null) === null, "");
  var placed = mod.handleBlockChange(bot, "block_placed", { name: "stone", position: { x: 1, y: 2, z: 3 } }, null);
  h.expect("方块事件记到 stone", placed && placed.type === "block_placed" && placed.block === "stone", JSON.stringify(placed));
  var recent = mod.recentEvents(bot, 5);
  h.expect("最近事件里能读到方块事件", recent.length === 2 && recent[recent.length - 1].block === "stone", String(recent.length));

  var snaps = mod.snapshotBots([{ id: "alias", bot: bot }]);
  h.expect("快照数组套用外部 id", snaps.length === 1 && snaps[0].id === "alias" && snaps[0].health === 20, JSON.stringify(snaps[0] && snaps[0].id));

  h.expect("startBroadcast 拒绝空采集函数", mod.startBroadcast(null) === false, "");
  var collect = function () { return { bots: [] }; };
  h.expect("broadcastNow 推了一次", mod.broadcastNow(collect) === true && pushed[pushed.length - 1].kind === "telemetry", JSON.stringify(pushed[pushed.length - 1] && pushed[pushed.length - 1].kind));
  h.expect("startBroadcast 起定时器", mod.startBroadcast(collect, 200) === true, "");
  h.expect("stopBroadcast 收掉定时器", mod.stopBroadcast() === true, "");
  h.expect("detach 卸掉监听", mod.detach(bot) === true && !bot._mbTelemetry, "");
  h.expect("setSink(null) 把出口清空（没出口就推不出去）", mod.setSink(null) === false && mod.broadcastNow(collect) === false, "");
  return bot;
}

// P3-3 3D 视角桥：端口规整 / 地址 / 状态 / 幂等关闭。
function checkViewer(h) {
  h.section("P3-3 3D 视角桥 / viewer-bridge");
  var mod = load("modules/viewer-bridge.js");
  if (!mod) { h.expect("viewer-bridge 可加载", false, "require 失败"); return; }
  h.expect("viewer-bridge 可加载", true, "");
  h.expect("默认端口 3007", mod.DEFAULT_PORT === 3007, String(mod.DEFAULT_PORT));
  h.expect("isInstalled 返回布尔值", typeof mod.isInstalled() === "boolean", typeof mod.isInstalled());
  h.expect("默认地址是 127.0.0.1:3007", mod.url() === "http://127.0.0.1:3007/", toText(mod.url()));
  h.expect("非法端口回落到默认端口", mod.url(99999) === "http://127.0.0.1:3007/" && mod.url("abc") === "http://127.0.0.1:3007/", toText(mod.url(99999)));
  var st = mod.status();
  h.expect("空闲状态 ok:true / running:false", st.ok === true && st.running === false, JSON.stringify(st));
  h.expect("没 bot 时 start 返回 ok:false", mod.start(null, "", 3007).ok === false, JSON.stringify(mod.start(null)));
  h.expect("stop 可重复调用", mod.stop().ok === true && mod.stop().ok === true, "");
  if (!mod.isInstalled()) {
    var res = mod.start(makeP3Bot(), "p3-bot", 3007);
    h.expect("未装 prismarine-viewer 时给出双语提示", res.ok === false && res.installed === false && toText(res.message).length > 0, JSON.stringify(res));
  } else {
    if (typeof h.note === "function") h.note("prismarine-viewer 已安装 / installed", "跳过未安装分支");
  }
}


// P3-4 附加 IPC：通道表 / 注册 / 遥测采集 / 手动驾驶与动作通道（handler 是 (event, payload) 形式）。
function checkIpc(h, bot) {
  h.section("P3-4 附加 IPC 通道 / ipc-extra");
  var mod = load("gui/ipc-extra.js");
  if (!mod) { h.expect("ipc-extra 可加载", false, "require 失败"); return; }
  h.expect("ipc-extra 可加载", true, "");
  var names = Object.keys(mod.CHANNELS || {});
  h.expect("通道表 25 条（含蜂群控制台 / 聊天频道 / 模型档案池 / 按 Bot 绑定）", names.length === 25 && mod.CHANNELS.swarmConsole === "swarm-console" && mod.CHANNELS.swarmConsoleData === "swarm-console-data" && mod.CHANNELS.channelSet === "channel-set" && mod.CHANNELS.modelProfileSet === "model-profile-set" && mod.CHANNELS.modelProfileBind === "model-profile-bind", JSON.stringify(names));
  h.expect("通道名带连字符", mod.CHANNELS.telemetryGet === "telemetry-get" && mod.CHANNELS.actionRun === "action-run", JSON.stringify(mod.CHANNELS));
  h.expect("上下文不完整时 register 返回 ok:false", mod.register(null).ok === false, JSON.stringify(mod.register(null)));

  var requests = {};
  var sends = {};
  var api = {
    getWindow: function () { return null; },
    listBots: function () { return [{ id: "p3-bot", username: "P3Bot", status: "running" }, { id: "ghost", username: "Ghost", status: "stopped" }]; },
    botOf: function (id) { return id === "p3-bot" ? bot : null; },
    onRequest: function (channel, replyChannel, handler) { requests[channel] = handler; return { ok: true, channel: channel, reply: replyChannel }; },
    onSend: function (channel, handler) { sends[channel] = handler; return { ok: true, channel: channel }; }
  };
  var reg = mod.register(api);
  h.expect("register 返回 ok:true 且 25 条通道", reg.ok === true && reg.channels === 25, JSON.stringify(reg));
  h.expect("注册了 16 个请求通道 + 1 个发送通道", Object.keys(requests).length === 16 && Object.keys(sends).length === 1, JSON.stringify({ r: Object.keys(requests), s: Object.keys(sends) }));
  h.expect("请求通道名与通道表一致", !!requests["telemetry-get"] && !!requests["manual-control"] && !!requests["viewer-open"] && !!requests["viewer-stop"] && !!requests["action-list"] && !!requests["action-run"] && !!requests["swarm-console"], JSON.stringify(Object.keys(requests)));

  var snap = mod.collectState();
  h.expect("collectState ok:true 且 2 个 bot", snap.ok === true && Array.isArray(snap.bots) && snap.bots.length === 2, JSON.stringify({ ok: snap.ok, n: snap.bots && snap.bots.length }));
  h.expect("运行中的 bot 带血量与事件", snap.bots[0].ok === true && snap.bots[0].health === 20 && Array.isArray(snap.bots[0].events), JSON.stringify({ ok: snap.bots[0].ok, h: snap.bots[0].health }));
  h.expect("未运行的 bot 标 ok:false", snap.bots[1].ok === false && toText(snap.bots[1].message).length > 0, JSON.stringify(snap.bots[1]));

  var listRes = requests["action-list"]();
  h.expect("动作通道返回 16 个动作", listRes.ok === true && listRes.count === 16 && listRes.actions.length === 16, JSON.stringify({ ok: listRes.ok, n: listRes.count }));

  var manualOk = requests["manual-control"](null, { botId: "p3-bot", action: "press", key: "forward", on: true });
  h.expect("手动通道转发给 manual-control", manualOk.ok === true && manualOk.action === "press", JSON.stringify(manualOk));
  var manualNoBot = requests["manual-control"](null, { botId: "ghost", action: "press", key: "forward" });
  h.expect("bot 不存在时手动通道返回 ok:false", manualNoBot.ok === false, JSON.stringify(manualNoBot));
  var manualNoAction = requests["manual-control"](null, { botId: "p3-bot", action: "fly" });
  h.expect("未知子动作返回 ok:false", manualNoAction.ok === false, JSON.stringify(manualNoAction));

  var viewerNoBot = requests["viewer-open"](null, { botId: "ghost" });
  h.expect("视角通道对空 bot 返回 ok:false", viewerNoBot.ok === false && typeof viewerNoBot.installed === "boolean", JSON.stringify(viewerNoBot));
  h.expect("视角关闭通道可重复调用", requests["viewer-stop"]().ok === true, "");

  var watchOn = sends["telemetry-watch"];
  h.expect("推送通道存在", typeof watchOn === "function", typeof watchOn);
  if (typeof watchOn === "function") {
    watchOn(null, { on: true });
    watchOn(null, { on: false });
    h.expect("推送开关可来回切", true, "");
  }
  return requests;
}


// P3-5 高级动作执行通道：未知动作 / 空动作名 / 无 bot 都必须给双语失败，不能抛异常。
async function checkActionRun(h, requests) {
  h.section("P3-5 动作执行通道 / action-run");
  if (!requests || typeof requests["action-run"] !== "function") {
    h.expect("动作执行通道已注册", false, "未注册 / not registered");
    return;
  }
  h.expect("动作执行通道已注册", true, "");
  var unknown = await requests["action-run"](null, { botId: "p3-bot", name: "no_such_action" });
  h.expect("未知动作返回 ok:false", unknown && unknown.ok === false && toText(unknown.message).length > 0, JSON.stringify(unknown));
  var noName = await requests["action-run"](null, { botId: "p3-bot", name: "" });
  h.expect("空动作名返回 ok:false", noName && noName.ok === false, JSON.stringify(noName));
  var ghost = await requests["action-run"](null, { botId: "ghost", name: "pillar_bridge" });
  h.expect("bot 不存在时返回 ok:false", ghost && ghost.ok === false, JSON.stringify(ghost));
}

// P3-6 模组服加固：协议穿透 / 防卡死自救 / 未知实体物品兜底 / 模组方块开天眼。
async function checkModHardening(h) {
  h.section("P3-6 模组服加固 / mod hardening");
  var forge = load("modules/protocol-forge.js");
  var stuck = load("modules/anti-stuck.js");
  var guard = load("modules/mod-guard.js");
  var pfind = load("modules/pathfinding.js");
  h.expect("protocol-forge / anti-stuck / mod-guard 都能 require", !!forge && !!stuck && !!guard, JSON.stringify({ f: !!forge, s: !!stuck, g: !!guard }));
  if (forge) {
    var opts = forge.decorate({ host: "mc.example.com", port: 25565 });
    h.expect("协议层加了品牌伪装", opts.brand === forge.BRAND && opts.host === "mc.example.com", toText(opts.brand));
    h.expect("模组注册表报错认得出来", forge.classify("Unknown block registry entry").modRelated === true, "");
    h.expect("普通网络错误不误判成模组问题", forge.classify("connection reset by peer").modRelated === false, "");
    var retried = 0;
    var r1 = forge.onLoginError({ id: "p3" }, "missing registry", { retry: function () { retried = retried + 1; } });
    h.expect("模组错误不崩且重试一次", r1.handled === true && retried === 1, JSON.stringify(r1));
    var r2 = forge.onLoginError({ id: "p3", modRetryCount: forge.MAX_MOD_RETRY }, "missing registry", {});
    h.expect("重试超过上限就停手", r2.handled === true && r2.retried === false, JSON.stringify(r2));
  }
  if (guard) {
    var guardBot = makeP3Bot();
    guardBot.version = "1.21.1";
    guardBot.registry = { entitiesByName: { zombie: {} }, itemsByName: { stone: {} } };
    h.expect("认识的实体不误报", guard.classifyEntity(guardBot, { name: "zombie" }).unknown === false, "");
    var unknownOne = guard.classifyEntity(guardBot, { name: "create:golem" });
    h.expect("未知实体归类 unknown_entity", unknownOne.unknown === true && unknownOne.category === guard.UNKNOWN_ENTITY_LABEL, JSON.stringify(unknownOne));
    h.expect("未知物品显示兜底文案", guard.itemLabel(guardBot, "create:alloy") === guard.UNKNOWN_ITEM_LABEL, toText(guard.itemLabel(guardBot, "create:alloy")));
    var labels = guard.labelItems(guardBot, [{ name: "stone", count: 1 }, { name: "create:gear", count: 2 }]);
    h.expect("背包逐条兜底不抛异常", labels.length === 2 && labels[0].unknown === false && labels[1].unknown === true, JSON.stringify(labels));
    var hurt = guard.onEntityHurt(guardBot, "p3-bot", guardBot.entity, { name: "create:golem", position: { x: 1, y: 64, z: 1 } });
    h.expect("未知实体攻击 → bot_under_attack", hurt !== null && hurt.type === "bot_under_attack" && hurt.unknown === true, JSON.stringify(hurt));
    h.expect("别人挨打不算遇袭", guard.onEntityHurt(guardBot, "p3-bot", { name: "zombie" }, null) === null, "");
    h.expect("兜底监听能挂能摘", guard.attach(guardBot, "p3-bot") === true && guard.detach(guardBot) === true, "");
  }
  if (pfind) {
    var reg = { blocksArray: [{ name: "minecraft:stone", hardness: 1.5, diggable: true }, { name: "create:tree_bark", hardness: -1, diggable: false }] };
    var moves = { canDig: false, digCost: 35 };
    var patched = pfind.openModBlocks({ registry: reg }, moves);
    h.expect("寻路只给模组方块开天眼", patched === 1, "patched=" + patched);
    h.expect("不可破坏的模组方块改成可挖", reg.blocksArray[1].diggable === true && reg.blocksArray[1].hardness > 0, JSON.stringify(reg.blocksArray[1]));
    h.expect("原版方块没被动过", reg.blocksArray[0].hardness === 1.5, "");
    h.expect("重复调用不重复修", pfind.openModBlocks({ registry: reg }, moves) === 0, "");
    h.expect("没有 registry 也不崩", pfind.openModBlocks({}, moves) === 0, "");
  }
  if (stuck) {
    var stuckBot = makeP3Bot();
    stuck.setWatchdog(30);
    var walking = new Promise(function (resolve) { setTimeout(function () { resolve({ ok: false }); }, 4000); });
    var handle = stuck.attach(stuckBot, { x: 40, y: 64, z: 40 }, walking);
    h.expect("防卡死看门狗能挂上", stuck.isActive(stuckBot) === true, "");
    await h.wait(220);
    h.expect("卡住先跳（自救第一步）", stuckBot.records.controls.join(",").indexOf("jump:1") >= 0, stuckBot.records.controls.join(","));
    h.expect("自救 3 次后放弃并通知 AI", !!stuckBot._mbStuckGiveUp, JSON.stringify(stuckBot._mbStuckGiveUp));
    h.expect("放弃后自动摘表（不留定时器）", stuck.isActive(stuckBot) === false, "");
    if (handle && typeof handle.stop === "function") handle.stop();
    stuck.setWatchdog(3000);
  }
}

// 入口：按 helpers 跑完 P3 全部段落（单段失败只记账，不让自测整体崩）。
async function run(helpers) {
  var h = helpers || {};
  var manualBot = checkManual(h);
  var telemetryBot = checkTelemetry(h);
  var bot = telemetryBot || manualBot || makeP3Bot();
  checkViewer(h);
  var requests = checkIpc(h, bot);
  await checkActionRun(h, requests);
  await checkModHardening(h);
}

// 对外导出：只暴露 run，自测统一入口调用。
module.exports = { run: run };
