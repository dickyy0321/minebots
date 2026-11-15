// ========================================
// 文件：scripts/selftest-p12.js
// 功能：P12 回归自测——Tick 级生存微操（MLG / 跳跃重置 / 防爆盾）/ 读心陪伴（递药 / 钓鱼陪坐 /
//       领地巡逻）/ 情感信任 2.0（吃醋 / 记忆衰减 / 金苹果覆盖 / 告状不拔剑 / AI Prompt 注入）
// 依赖：path、fs、os；导出：run（由 selftest-p5.js 调用，复用 section / expect）
// 作者：MineBots
// ========================================
// 说明 / note：全程离线、不联网、不碰真实 state/；bot 与黑板一律内存假实现，
//   情感数据写在独立临时目录，收尾逐模块 reset 并还原环境变量与模块缓存。
var path = require("path"); var fs = require("fs"); var os = require("os");
var ROOT = path.join(__dirname, "..");
var TEMP_DIR = path.join(os.tmpdir(), "minebots-p12-" + process.pid);
// 按相对路径安全 require；缺失或抛错返回 null，不拖垮整轮自检。
function load(rel) {
  try { return require(path.join(ROOT, rel)); } catch (e) { return null; }
}
// 读项目文件文本；读不到返回空串。
function readRel(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch (e) { return ""; }
}
// 安全删临时目录；失败静默，绝不抛到顶层。
function safeRemove(dir) {
  try {
    if (!fs.existsSync(dir)) return;
    var names = fs.readdirSync(dir);
    for (var i = 0; i < names.length; i++) {
      try { fs.unlinkSync(path.join(dir, names[i])); } catch (e) { /* 单个删不掉继续 */ }
    }
    fs.rmdirSync(dir);
  } catch (e) { /* ignore */ }
}
// 等待若干毫秒；定时器不 unref，保证异步链路跑完前进程不退出。
function wait(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}
// 内存假黑板：只实现 post，用于验证盯梢记录在案。
function fakeBoard() {
  var data = {};
  return {
    data: data,
    post: function (k, v) { data[k] = JSON.parse(JSON.stringify(v)); return { ok: true }; },
    get: function (k, d) { return data[k] === undefined ? d : data[k]; }
  };
}
// 生存微操假 bot：blockAt 在 y<=8 给地面，背包带水桶 / 船 / 盾，动作全部留痕。
function makeSurvivalBot(calls, opts) {
  var o = opts && typeof opts === "object" ? opts : {};
  var groundY = o.groundY === undefined ? 8 : o.groundY;
  var items = o.items || [{ name: "water_bucket", count: 1 }, { name: "shield", count: 1 }];
  return {
    entity: { position: { x: 2, y: 10, z: 3 }, velocity: { y: -1.6 } },
    players: { Steve: { entity: { position: { x: 3, y: 12, z: 3 }, velocity: { y: 0 } } } },
    inventory: { items: function () { return items; } },
    equip: function (it, dest) { calls.push("equip:" + it.name + ":" + dest); return Promise.resolve(); },
    placeBlock: function (ref, off) { calls.push("place:" + (ref && ref.name) + ":" + off.y); return Promise.resolve(); },
    activateItem: function (on) { calls.push("activate:" + on); return Promise.resolve(); },
    setControlState: function (k, v) { calls.push("ctrl:" + k + ":" + v); },
    lookAt: function () { calls.push("lookAt"); },
    blockAt: function (p) {
      if (p.y <= groundY) return { name: o.groundName || "stone", position: p };
      return { name: "air" };
    },
    pathfinder: { setGoal: function () { calls.push("stopGoal"); } },
    entities: {}, chat: function (t) { calls.push("chat:" + t); },
    on: function () {}, removeListener: function () {}
  };
}
// 陪伴层假 bot：背包带喷溅药水，装备 / 抛出 / 坐下全部留痕。
function makeCompanionBot(calls) {
  return {
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: { items: function () { return [{ name: "splash_potion", count: 3 }, { name: "stone", count: 64 }]; } },
    equip: function (it) { calls.push("equip:" + it.name); return Promise.resolve(); },
    tossStack: function (it) { calls.push("toss:" + it.name); return Promise.resolve(); },
    activateItem: function () { calls.push("activate"); return Promise.resolve(); },
    lookAt: function () { calls.push("lookAt"); },
    setControlState: function (k, v) { calls.push("ctrl:" + k + ":" + v); },
    chat: function (t) { calls.push("chat:" + t); },
    on: function () {}, removeListener: function () {}
  };
}
// 23a：静态接线——5 个新模块可加载、导出齐全，关键接线落在既有代码里，文件不越 600 行。
function checkStatic(h) {
  var files = ["modules/reflex-survival.js", "modules/companion.js", "modules/combat-ethics.js",
    "modules/emotion-trust.js"];
  for (var i = 0; i < files.length; i++) {
    var mod = load(files[i]);
    h.expect(files[i] + " 可 require 且导出齐全", !!mod && Object.keys(mod).length >= 6,
      mod ? Object.keys(mod).join(",") : "null");
    var text = readRel(files[i]);
    h.expect(files[i] + " 不越 600 行", text.length > 0 && text.split("\n").length <= 600,
      String(text.split("\n").length));
    h.expect(files[i] + " 有文件头注释且双语", text.indexOf("// 文件：") >= 0 && text.indexOf(" / ") >= 0, "");
  }
  var pm = load("modules/player-manager.js");
  h.expect("player-manager 升级后既有 5 个导出一个不少",
    !!pm && typeof pm.loadPlayers === "function" && typeof pm.savePlayers === "function" &&
    typeof pm.setAutoJudge === "function" && typeof pm.getLevel === "function" &&
    typeof pm.judgeByBehavior === "function", "");
  h.expect("player-manager 新增情感薄接线导出",
    !!pm && typeof pm.getTrustScore === "function" && typeof pm.decayMemories === "function" &&
    typeof pm.onGiftToOther === "function" && typeof pm.onBotAttacked === "function" &&
    typeof pm.getEmotionPrompt === "function" && typeof pm.resetEmotion === "function", "");
  var cm = readRel("modules/context-manager.js");
  h.expect("context-manager 把情感段汇入 System Prompt",
    cm.indexOf("emotion-trust") >= 0 && cm.indexOf("getPromptAppend") >= 0, "");
  var skills = readRel("modules/state-skills.js");
  h.expect("attack 节点接了战斗伦理门面",
    skills.indexOf("combat-ethics") >= 0 && skills.indexOf("canAttack") >= 0, "");
  var con = readRel("modules/swarm-console.js");
  h.expect("真实 bot 启动链路挂了生存反射与陪伴层",
    con.indexOf("reflex-survival") >= 0 && con.indexOf("./companion") >= 0 &&
    con.indexOf("_mbSurvivalReflex") >= 0, "");
  var rs = readRel("modules/reflex-survival.js");
  h.expect("反射层挂 physicsTick 与 entityHurt 并广播陪伴心跳",
    rs.indexOf("physicsTick") >= 0 && rs.indexOf("entityHurt") >= 0 &&
    rs.indexOf("survival.tick") >= 0, "");
  var cp = readRel("modules/companion.js");
  h.expect("陪伴层订阅心跳且巡逻定时器 unref",
    cp.indexOf("survival.tick") >= 0 && cp.indexOf("unref") >= 0, "");
  h.expect("双语固定文案逐字落地",
    readRel("modules/emotion-trust.js").indexOf("你居然把钻石给他不给我！") >= 0 &&
    readRel("modules/emotion-trust.js").indexOf("你的朋友打我，我能还手吗") >= 0, "");
}
// 23b：MLG——模拟物理 Tick 急坠，验证是否真的切水桶并 placeBlock 放水。
function checkMlg(h) {
  var rs = load("modules/reflex-survival.js");
  if (!rs) { h.expect("reflex-survival 可加载", false, "null"); return; }
  rs.reset();
  var calls = [];
  var bot = makeSurvivalBot(calls, {});
  rs.registerBot("mlg1", bot, { ownerName: "Steve" });
  // 指定断言 1：vy=-1.6 < -0.8，脚下 2 格是地面 → 必须放水。
  var t = rs.simulatePhysicsTick("mlg1", {
    self: { position: { x: 2, y: 10, z: 3 }, vy: -1.6 },
    owner: { position: { x: 3, y: 12, z: 3 }, vy: 0, label: "owner" }
  });
  var m = t.results[0];
  h.expect("物理Tick急坠触发 MLG 且放置了水",
    m.ok === true && m.acted === true && m.action === "mlg" && m.item === "water_bucket" &&
    m.placed === true && m.equipped === true && m.distance <= 3,
    JSON.stringify(m));
  h.expect("MLG 真的调用了 equip(水桶) 与 placeBlock",
    calls.indexOf("equip:water_bucket:hand") >= 0 && calls.indexOf("place:stone:1") >= 0,
    JSON.stringify(calls));
  h.expect("落点按地面坐标毫秒级算出",
    !!m.landing && m.landing.y === 9 && m.landing.x === 2.5 && m.groundBlock === "stone",
    JSON.stringify(m.landing));
  h.expect("20tps 与 -0.8 阈值常量正确",
    rs.TPS === 20 && rs.FALL_VELOCITY === -0.8 && rs.GROUND_SCAN === 3, "");
  // 未急坠不触发。
  rs.reset(); calls = [];
  rs.registerBot("mlg2", makeSurvivalBot(calls, {}), {});
  var slow = rs.simulatePhysicsTick("mlg2", { self: { position: { x: 2, y: 10, z: 3 }, vy: -0.2 } });
  h.expect("下落速度 -0.2 不误触发 MLG",
    slow.results[0].acted === false && calls.length === 0, JSON.stringify(slow.results[0]));
  // 3 格内没地面不触发。
  rs.reset(); calls = [];
  rs.registerBot("mlg3", makeSurvivalBot(calls, { groundY: -99 }), {});
  var deep = rs.simulatePhysicsTick("mlg3", { self: { position: { x: 2, y: 10, z: 3 }, vy: -2.4 } });
  h.expect("3 格内无落点不误放水",
    deep.results[0].acted === false && calls.length === 0, JSON.stringify(deep.results[0]));
  // 船也能 MLG，岩浆也算危险落点。
  rs.reset(); calls = [];
  rs.registerBot("mlg4", makeSurvivalBot(calls, { groundName: "lava", items: [{ name: "oak_boat", count: 1 }] }), {});
  var lava = rs.simulatePhysicsTick("mlg4", { self: { position: { x: 2, y: 10, z: 3 }, vy: -1.9 } });
  h.expect("岩浆落点可用船完成 MLG",
    lava.results[0].acted === true && lava.results[0].item === "oak_boat" &&
    lava.results[0].lava === true, JSON.stringify(lava.results[0]));
  // 冷却防连放。
  rs.reset(); calls = [];
  rs.registerBot("mlg5", makeSurvivalBot(calls, {}), {});
  var snap = { self: { position: { x: 2, y: 10, z: 3 }, vy: -1.6 } };
  rs.simulatePhysicsTick("mlg5", snap);
  var second = rs.simulatePhysicsTick("mlg5", snap);
  h.expect("MLG 冷却防同一次下落连放多桶",
    second.results[0].acted === false && rs.stats("mlg5").blocked === 1,
    JSON.stringify(second.results[0]));
  // 真实挂载：physicsTick / entityHurt 两个监听都能挂上。
  rs.reset();
  var handlers = {};
  var removed = {};
  var hb = makeSurvivalBot([], {});
  hb.on = function (e) { handlers[e] = (handlers[e] || 0) + 1; };
  hb.removeListener = function (e) { removed[e] = (removed[e] || 0) + 1; };
  var at = rs.attach(hb, "mlg6", { ownerName: "Steve" });
  h.expect("生存反射层挂到 bot.physicsTick + entityHurt",
    at.ok === true && at.events === 2 && handlers.physicsTick === 1 && handlers.entityHurt === 1,
    JSON.stringify(handlers));
  var off = rs.detach("mlg6");
  h.expect("卸载摘掉两个监听且统计可见",
    typeof rs.detach === "function" && off.ok === true && off.removed === 2 &&
    removed.physicsTick === 1 && removed.entityHurt === 1 &&
    rs.stats("mlg6").attached === false && rs.stats("mlg6").tps === 20,
    JSON.stringify(removed) + " " + JSON.stringify(off));
}
// 23c：跳跃重置与引燃 Creeper 防爆盾。
function checkCombatReflex(h) {
  var rs = load("modules/reflex-survival.js");
  if (!rs) { h.expect("reflex-survival 可加载", false, "null"); return; }
  rs.reset();
  var calls = [];
  var bot = makeSurvivalBot(calls, {});
  rs.registerBot("cb1", bot, { ownerName: "Steve" });
  var hurt = rs.simulateHurt("cb1", { source: "Alex" });
  h.expect("受击瞬间跳跃重置：jump + 向后拉扯",
    hurt.ok === true && hurt.action === "jump_reset" && hurt.jumped === true &&
    hurt.pulledBack === true && calls.indexOf("ctrl:jump:true") >= 0 &&
    calls.indexOf("ctrl:back:true") >= 0, JSON.stringify(hurt));
  var creeper = { name: "creeper", ignited: true, position: { x: 2, y: 64, z: 0 } };
  var shield = rs.scanCreeper("cb1", {
    self: { position: { x: 0, y: 64, z: 0 } },
    owner: { position: { x: 0, y: 64, z: 0 } },
    entities: [creeper]
  });
  h.expect("3 格内引燃 Creeper 触发贴身防爆盾",
    shield.ok === true && shield.acted === true && shield.action === "creeper_shield" &&
    shield.distance <= 3 && shield.interrupted === true && shield.shieldEquipped === true,
    JSON.stringify(shield));
  h.expect("副手切盾且挡在主人与 Creeper 之间",
    calls.indexOf("equip:shield:off-hand") >= 0 && calls.indexOf("stopGoal") >= 0 &&
    !!shield.guardPos && shield.guardPos.x > 0 && shield.guardPos.x < 2 &&
    shield.attacked === false, JSON.stringify(shield.guardPos));
  var safe = rs.scanCreeper("cb1", {
    self: { position: { x: 0, y: 64, z: 0 } }, owner: { position: { x: 0, y: 64, z: 0 } },
    entities: [{ name: "creeper", ignited: false, position: { x: 2, y: 64, z: 0 } }]
  });
  h.expect("未引燃的 Creeper 不误举盾", safe.acted === false, JSON.stringify(safe));
  var far = rs.scanCreeper("cb1", {
    self: { position: { x: 0, y: 64, z: 0 } }, owner: { position: { x: 0, y: 64, z: 0 } },
    entities: [{ name: "creeper", ignited: true, position: { x: 9, y: 64, z: 0 } }]
  });
  h.expect("超过 3 格的 Creeper 不误举盾", far.acted === false, JSON.stringify(far));
  h.expect("反射层统计累计 MLG / 跳跃 / 举盾",
    rs.stats("cb1").jumpResets === 1 && rs.stats("cb1").shields === 1, JSON.stringify(rs.stats("cb1").totals));
}
// 23d：读心陪伴——低血递药 / 钓鱼陪坐 / 盖房递材料 / 下线巡逻 / 盯梢不攻击。
function checkCompanion(h) {
  var cp = load("modules/companion.js");
  if (!cp) { h.expect("companion 可加载", false, "null"); return; }
  cp.reset();
  var calls = [], board = fakeBoard();
  var bot = makeCompanionBot(calls);
  cp.registerBot("cp1", bot, { ownerName: "Steve", board: board });
  var d = cp.deliverPotion("cp1", {
    ownerHealth: 8, ownerEating: false,
    ownerPos: { x: 5, y: 64, z: 0 }, botPos: { x: 0, y: 64, z: 0 }
  });
  h.expect("主人血量低于 10 且没吃东西 → 切药水走到 3 格内抛出",
    d.ok === true && d.acted === true && d.item === "splash_potion" &&
    d.equipped === true && d.aimed === true && d.thrown === true &&
    calls.indexOf("equip:splash_potion") >= 0 && calls.indexOf("lookAt") >= 0 &&
    calls.indexOf("toss:splash_potion") >= 0, JSON.stringify(d));
  h.expect("主人在吃东西或血量充足时不误递药",
    cp.deliverPotion("cp1", { ownerHealth: 8, ownerEating: true }).acted === false &&
    cp.deliverPotion("cp1", { ownerHealth: 18, ownerEating: false }).acted === false, "");
  var fish = cp.syncRhythm("cp1", {
    ownerAction: "fishing_rod", ownerFishing: true, ownerGap: 1.5,
    ownerPos: { x: 1, y: 64, z: 0 }
  });
  h.expect("主人钓鱼 → 2 格内 sneak 坐下陪伴",
    fish.ok === true && fish.acted === true && fish.action === "sit" &&
    fish.sneaking === true && calls.indexOf("ctrl:sneak:true") >= 0, JSON.stringify(fish));
  var build = cp.syncRhythm("cp1", { ownerAction: "place_block", ownerBuilding: true, ownerGap: 2 });
  h.expect("主人盖房 → 切 supply_material 递材料模式",
    build.ok === true && build.mode === "supply_material" && build.acted === true, JSON.stringify(build));
  var off = cp.observe("cp1", {
    ownerOnline: false, ownerPos: { x: 0, y: 64, z: 0 }, manual: true,
    nearbyPlayers: [{ name: "Alex", position: { x: 3, y: 64, z: 0 } }]
  });
  h.expect("主人下线 → 20 格领地巡逻并逐拍推进",
    off.ok === true && off.ownerOnline === false && off.mode === "patrol" &&
    cp.stats("cp1").patrol && cp.stats("cp1").patrol.active === true &&
    cp.stats("cp1").patrol.radius === 20 && cp.stats("cp1").patrol.waypoints === 4,
    JSON.stringify(off.decisions));
  var watch = cp.stats("cp1").watchList;
  h.expect("陌生人靠近 → 跟上去盯着、不攻击、记录在案",
    watch.length >= 1 && watch[0].name === "Alex" && watch[0].attacked === false &&
    board.data["companion.watch:cp1:Alex"] !== undefined, JSON.stringify(watch));
  h.expect("巡逻定时器不拖进程且能停", cp.stopPatrol("cp1").active === false, "");
  var wp = cp.patrolWaypoints({ x: 0, y: 64, z: 0 }, 20);
  h.expect("领地路点确实覆盖 20 格范围",
    wp.length === 4 && wp[0].x === -20 && wp[1].z === -20, JSON.stringify(wp));
}
// 23e：情感信任 2.0——吃醋 / 衰减 / 金苹果覆盖 / 告状不拔剑。
function checkEmotion(h) {
  var emo = load("modules/emotion-trust.js");
  var pm = load("modules/player-manager.js");
  var ce = load("modules/combat-ethics.js");
  if (!emo || !pm || !ce) { h.expect("情感三模块可加载", false, "null"); return; }
  emo.reset(); ce.reset();
  // 全量链里 P5 会调 event-bus.reset() 清空订阅；门面必须能自愈重挂，否则告状事件丢失。
  var bus = load("modules/event-bus.js");
  if (bus && typeof bus.off === "function") bus.off("emotion.complaint");
  ce.reset();
  h.expect("总线订阅被清空后告状事件桥可自愈重挂",
    typeof ce.bind === "function" && ce.bind() === true && !!bus &&
    bus.listenerCount("emotion.complaint") >= 1 && bus.listenerCount("reflex.complaint") >= 1,
    bus ? JSON.stringify(bus.stats()) : "bus missing");
  h.expect("未发生情感写操作时 Prompt 注入为空串（不污染既有断言）",
    emo.getPromptAppend() === "" && load("modules/context-manager.js").getSystemPromptAppend() === "", "");
  h.expect("默认信任分 50", emo.getTrustScore("Steve") === 50, "");
  emo.setOwner("Steve");
  var j = pm.onGiftToOther("Steve", "Alex", "diamond", {});
  h.expect("主人把钻石给别人 → 信任分对主人 -5 并落盘",
    j.ok === true && j.jealous === true && j.delta === -5 &&
    j.trustBefore === 50 && j.trustAfter === 45 && pm.getTrustScore("Steve") === 45,
    JSON.stringify(j));
  h.expect("吃醋吐槽逐字含「你居然把钻石给他不给我！」",
    j.taunt.indexOf("你居然把钻石给他不给我！") >= 0 && j.taunt.indexOf(" / ") >= 0, j.taunt);
  h.expect("普通物品 / 给 Bot 自己不吃醋",
    pm.onGiftToOther("Steve", "Alex", "dirt", {}).jealous === false &&
    emo.noteGiftToBot({ owner: "Steve", item: "diamond" }).ok === true &&
    pm.onGiftToOther("Steve", "Alex", "netherite_ingot", {}).jealous === false, "");
  // 记忆衰减：一周前攻击事件权重减半，只衰减一次。
  emo.reset();
  var now = Date.now();
  emo.recordMemory("attack", "OldFoe", { weight: 1, at: now - 8 * 24 * 3600 * 1000, text: "很久以前打过我" });
  emo.recordMemory("attack", "NewFoe", { weight: 1, at: now - 1000, text: "刚打过我" });
  var dec = pm.decayMemories(now);
  h.expect("一周前攻击事件权重减半、近期的不动",
    dec.ok === true && dec.decayed === 1 && emo.stats().stats.decays === 1, JSON.stringify(dec));
  var mem = emo.stats();
  h.expect("再衰减一次不重复减半", pm.decayMemories(now).decayed === 0, "");
  // 金苹果覆盖仇视记忆。
  emo.recordMemory("attack", "Alex", { weight: 1, at: now, text: "打了我" });
  var apple = emo.onGift("Alex", "golden_apple", {});
  h.expect("近期给金苹果直接覆盖仇视记忆",
    apple.ok === true && apple.premium === true && apple.overridden >= 1 &&
    apple.delta === 12 && emo.stats().stats.overrides >= 1, JSON.stringify(apple));
  // 指定断言 2：close_friend 攻击 → 告状而不是拔剑。
  var calls = [];
  var bot = {
    entity: { position: { x: 0, y: 64, z: 0 } }, health: 20, food: 20,
    chat: function (t) { calls.push("chat:" + t); },
    lookAt: function () { calls.push("lookAt"); },
    setControlState: function (k, v) { calls.push("ctrl:" + k + ":" + v); },
    attack: function () { calls.push("ATTACK"); },
    swingArm: function () { calls.push("SWING"); }
  };
  var r = pm.onBotAttacked("Bob", {
    level: "close_friend", botId: "e1", bot: bot,
    ownerPosition: { x: 3, y: 64, z: 0 }
  });
  h.expect("close_friend 攻击 → 不拔剑反击，逃到主人身边并公屏告状",
    r.ok === true && r.retaliate === false && r.counterAttack === false &&
    r.complaint === true && r.action === "flee_to_owner" && r.fled === true &&
    r.chat.indexOf("主人，你的朋友打我，我能还手吗？") >= 0 &&
    calls.indexOf("ATTACK") < 0 && calls.indexOf("SWING") < 0,
    JSON.stringify(r));
  h.expect("公屏真的发出了告状且看向主人",
    calls.indexOf("chat:" + r.chat) >= 0 && calls.indexOf("lookAt") >= 0, JSON.stringify(calls));
  h.expect("告状事件自动登记为待决、攻击门面拒绝拔剑",
    ce.pending().length >= 1 && ce.canAttack("e1", "Bob", {}).allowed === false,
    JSON.stringify(ce.stats()));
  h.expect("主人发话后才允许还手",
    ce.ownerAllows("e1", "Bob", {}).ok === true && ce.canAttack("e1", "Bob", {}).allowed === true, "");
  var hostile = pm.onBotAttacked("Griefer", { level: "hostile", botId: "e1", bot: bot });
  h.expect("敌对玩家攻击仍正常反击（不误伤战斗逻辑）",
    hostile.ok === true && hostile.retaliate === true && hostile.complaint === false &&
    hostile.action === "counter_attack", JSON.stringify(hostile));
  h.expect("等级表驱动：close_friend 走告状分支",
    pm.savePlayers({ manual: { close_friend: ["Cara"] }, autoJudge: false }).ok === true &&
    pm.onBotAttacked("Cara", { botId: "e1", bot: bot }).complaint === true, "");
  h.expect("情感统计含吃醋 / 告状 / 衰减 / 覆盖计数",
    emo.stats().stats.complaints >= 1 && emo.stats().stats.attacks >= 1,
    JSON.stringify(emo.stats().stats));
  ce.reset(); emo.reset();
}
// 23f：AI 语气注入——好感度变动后 System Prompt 带正确记忆与信任分（假 axios，不联网）。
async function checkPrompt(h) {
  var emo = load("modules/emotion-trust.js");
  var pm = load("modules/player-manager.js");
  var cm = load("modules/context-manager.js");
  if (!emo || !pm || !cm) { h.expect("Prompt 链路模块可加载", false, "null"); return; }
  emo.reset();
  emo.setOwner("Steve");
  emo.adjustTrust("Steve", 22, "long_term_care");
  emo.recordMemory("attack", "Alex", { weight: 0.5, text: "Alex 一周前攻击过我 / attacked me a week ago" });
  emo.recordMemory("jealousy", "Steve", { weight: 1.5, text: "主人把钻石给了别人 / owner gave diamonds away" });
  pm.setBotState({ health: 8, food: 6 });
  var append = cm.getSystemPromptAppend();
  // 指定断言 3：Prompt 携带正确信任分、记忆、血量、饥饿。
  h.expect("System Prompt 注入 trustScore 且数值正确",
    append.indexOf("trustScore") >= 0 && append.indexOf("72/100") >= 0, append);
  h.expect("System Prompt 注入 memories 且含具体记忆",
    append.indexOf("memories") >= 0 && append.indexOf("diamond") >= 0 &&
    append.indexOf("weight=") >= 0, append);
  h.expect("System Prompt 注入当前血量 / 饥饿",
    append.indexOf("health=8/20") >= 0 && append.indexOf("food=6/20") >= 0, append);
  h.expect("player-manager.getEmotionPrompt 与上下文通道同源",
    pm.getEmotionPrompt({}).indexOf("trustScore") >= 0, "");
  // 用假 axios 走真实 ai-client.ask，验证 system 消息真的带上了这些字段。
  var axiosPath = null, aiPath = null, savedAxios = null, savedAi = null;
  var sentBody = null, aiReply = "";
  try {
    axiosPath = require.resolve("axios");
    aiPath = require.resolve(path.join(ROOT, "modules/ai-client.js"));
    savedAxios = require.cache[axiosPath] || null;
    savedAi = require.cache[aiPath] || null;
    require.cache[axiosPath] = {
      id: axiosPath, filename: axiosPath, loaded: true,
      exports: { post: async function (url, body) {
        sentBody = body;
        return { data: { choices: [{ message: { content: "收到" } }] } };
      } }
    };
    delete require.cache[aiPath];
    aiReply = await require(aiPath).ask("你是测试", "在吗", "p12bot");
  } catch (err) { sentBody = null; aiReply = ""; }
  if (axiosPath) {
    if (savedAxios) require.cache[axiosPath] = savedAxios; else delete require.cache[axiosPath];
  }
  if (aiPath) {
    if (savedAi) require.cache[aiPath] = savedAi; else delete require.cache[aiPath];
  }
  var sys = sentBody && sentBody.messages && sentBody.messages[0] ?
    String(sentBody.messages[0].content) : "";
  h.expect("ai-client 用假 axios 跑通（不联网）", aiReply === "收到" && sentBody !== null, aiReply);
  h.expect("真实请求体的 system 消息带 trustScore 与数值",
    sys.indexOf("你是测试") === 0 && sys.indexOf("trustScore") > 0 && sys.indexOf("72/100") > 0, sys.slice(0, 220));
  h.expect("真实请求体的 system 消息带记忆与血量饥饿",
    sys.indexOf("memories") > 0 && sys.indexOf("health=8/20") > 0 &&
    sys.indexOf("food=6/20") > 0 && sys.indexOf("diamond") > 0, sys.slice(0, 260));
  h.expect("user 消息不被情绪段污染",
    !!sentBody && sentBody.messages[1].content === "在吗", sentBody ? sentBody.messages[1].content : "");
  h.expect("reset 后注入回到空串",
    emo.reset().ok === true && emo.getPromptAppend() === "" &&
    cm.getSystemPromptAppend() === "", "");
}
// 23g：攻击节点门面拦截 + 真实启动链路 + 全模块复位。
async function checkWiring(h) {
  var ce = load("modules/combat-ethics.js");
  var pm = load("modules/player-manager.js");
  var skills = load("modules/state-skills.js");
  var con = load("modules/swarm-console.js");
  var rs = load("modules/reflex-survival.js");
  var cp = load("modules/companion.js");
  if (!ce || !pm || !skills || !con) { h.expect("接线模块可加载", false, "null"); return; }
  ce.reset();
  var calls = [];
  var bot = {
    entity: { position: { x: 0, y: 64, z: 0 } }, health: 20, food: 20,
    chat: function () {}, lookAt: function () {}, setControlState: function () {},
    attack: function () { calls.push("ATTACK"); }, swingArm: function () { calls.push("SWING"); },
    on: function () {}, removeListener: function () {}, players: {}
  };
  pm.onBotAttacked("Bob", { level: "close_friend", botId: "w1", bot: bot });
  var node = skills.pick("attack");
  h.expect("attack 节点可从目录取到", typeof node === "function", "");
  var blocked = await node({ bot: bot, botId: "w1" }, { target: "Bob", times: 1 });
  h.expect("告状待决时 attack 节点拒绝出手且未调用 bot.attack",
    blocked.ok === false && blocked.blocked === true && calls.length === 0,
    JSON.stringify(blocked) + " calls=" + JSON.stringify(calls));
  ce.ownerAllows("w1", "Bob", {});
  var allowed = ce.canAttack("w1", "Bob", {});
  h.expect("主人放行后门面恢复放行", allowed.allowed === true, JSON.stringify(allowed));
  ce.clear("w1");
  // 真实启动链路幂等挂载。
  if (rs) rs.reset();
  if (cp) cp.reset();
  var handlers = {};
  var real = {
    on: function (e) { handlers[e] = (handlers[e] || 0) + 1; },
    removeListener: function () {}, entity: { position: { x: 0, y: 64, z: 0 } },
    players: {}, health: 20, food: 20
  };
  var a1 = con.attachBot(real, "wire1");
  var a2 = con.attachBot(real, "wire1");
  h.expect("attachBot 幂等且三个反射/陪伴模块都挂上",
    a1.ok === true && a1.attached === true && a2.ok === true &&
    real._mbSwarmReflex === true && real._mbSurvivalReflex === true &&
    real._mbCompanion === true && handlers.physicsTick === 2 &&
    handlers.entityHurt === 2 && handlers.playerLeave === 1,
    JSON.stringify(handlers));
  h.expect("反射层统计可见且陪伴层已挂载",
    !!rs && rs.stats("wire1").attached === true && !!cp && cp.stats("wire1").attached === true, "");
  // 事件总线：反射层受击事件能触发战略层既有桥（只验证不抛错）。
  var bus = load("modules/event-bus.js");
  if (bus && typeof bus.emit === "function") {
    try { bus.emit("reflex.hurt", { botId: "wire1", source: "creeper", action: "local_dodge" }); }
    catch (eBus) { h.expect("事件总线广播不抛错", false, String(eBus)); }
    h.expect("事件总线广播不抛错", true, "");
  }
  // 全模块复位。
  if (rs) rs.reset();
  if (cp) cp.reset();
  ce.reset();
  h.expect("全模块 reset 后统计归零",
    !!rs && rs.stats("wire1").ticks === 0 && !!cp && cp.stats("wire1").observes === 0 &&
    ce.stats().pending === 0, "");
}
// 主流程：依次跑全部分组；任一组抛错只记一条失败，不让整轮自检崩。
async function run(h) {
  var OLD = process.env.MINEBOTS_STATE_DIR;
  try {
    safeRemove(TEMP_DIR);
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
    process.env.MINEBOTS_STATE_DIR = TEMP_DIR;
  } catch (eDir) { h.expect("临时 state 目录就绪", false, String(eDir)); }
  try { checkStatic(h); } catch (e1) { h.expect("22a 未抛错", false, String(e1)); }
  try { checkMlg(h); } catch (e2) { h.expect("22b 未抛错", false, String(e2)); }
  try { checkCombatReflex(h); } catch (e3) { h.expect("22c 未抛错", false, String(e3)); }
  try { checkCompanion(h); } catch (e4) { h.expect("22d 未抛错", false, String(e4)); }
  try { checkEmotion(h); } catch (e5) { h.expect("22e 未抛错", false, String(e5)); }
  try { await checkPrompt(h); } catch (e6) { h.expect("22f 未抛错", false, String(e6)); }
  try { await checkWiring(h); } catch (e7) { h.expect("22g 未抛错", false, String(e7)); }
  // 收尾：逐模块复位、还原环境变量与模块缓存、删临时目录。
  try {
    var emo = load("modules/emotion-trust.js");
    var pm = load("modules/player-manager.js");
    var ce = load("modules/combat-ethics.js");
    var rs = load("modules/reflex-survival.js");
    var cp = load("modules/companion.js");
    if (emo) emo.reset();
    if (pm) pm.resetEmotion();
    if (ce) ce.reset();
    if (rs) rs.reset();
    if (cp) cp.reset();
    safeRemove(TEMP_DIR);
    if (OLD === undefined) delete process.env.MINEBOTS_STATE_DIR;
    else process.env.MINEBOTS_STATE_DIR = OLD;
    var purge = ["modules/player-manager.js", "modules/context-manager.js", "modules/emotion-trust.js"];
    for (var i = 0; i < purge.length; i++) {
      try { delete require.cache[require.resolve(path.join(ROOT, purge[i]))]; } catch (e) { /* ignore */ }
    }
    h.expect("临时 state 目录已清掉、环境已还原", fs.existsSync(TEMP_DIR) === false, TEMP_DIR);
  } catch (eEnd) { h.expect("22h 收尾未抛错", false, String(eEnd)); }
}
module.exports = { run: run };
