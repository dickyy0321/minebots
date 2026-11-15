// ========================================
// 文件：scripts/selftest-p13f.js
// 功能：P13 模块6 回归自测——生态破圈：多 Bot 防碰撞 / 公屏雇佣钱包 / 幽灵反作弊巡检 /
//       全维度信标导航 / QQ-Discord 外部桥接 / 本地 HY-MT1.5-1.8B 翻译模型
// 依赖：path、fs、os；被测模块（都可选，缺了记失败而不崩）
// 导出：run（由 selftest-p5.js 调用）
// 作者：MineBots
// ========================================
// 说明：全程离线，bot / 玩家 / 网络端点全是内存假实现；落盘经 MINEBOTS_STATE_DIR 重定向，
//   收尾删除临时目录并还原环境变量，真实 state/、真实网络均不受影响。
var path = require("path");
var fs = require("fs");
var os = require("os");
var ROOT = path.join(__dirname, "..");
var TEMP_DIR = path.join(os.tmpdir(), "minebots-p13f-" + process.pid);

// 安全 require：缺失或抛错返回 null。
function load(rel) {
  try { return require(path.join(ROOT, rel)); } catch (e) { return null; }
}
// 读项目文件文本；读不到返回空串。
function readRel(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch (e) { return ""; }
}
// 递归删临时目录；失败静默。
function safeRemove(dir) {
  try {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir).forEach(function (n) {
      var p = path.join(dir, n);
      try { if (fs.lstatSync(p).isDirectory()) safeRemove(p); else fs.unlinkSync(p); } catch (e) { /* ignore */ }
    });
    fs.rmdirSync(dir);
  } catch (e) { /* ignore */ }
}
// 29a：静态红线与接线。
function checkStatic(h) {
  h.section("29a. 模块6 静态红线 / static");
  var files = ["modules/swarm-collision.js", "modules/market-wallet.js", "modules/ghost-anticheat.js",
    "modules/beacon-nav.js", "modules/external-bridge.js", "modules/local-translator.js"];
  var banned = [/\?\./, /\?\?/, /^import\s+/m, /^export\s+/m, /\bconst\b/, /\blet\b/, /=>/, /\x60/];
  var ok = true;
  for (var i = 0; i < files.length; i++) {
    var text = readRel(files[i]);
    if (text.length === 0 || text.indexOf("// ====") !== 0 || text.split("\n").length > 600) ok = false;
    for (var j = 0; j < banned.length; j++) if (banned[j].test(text)) ok = false;
  }
  h.expect("6 个生态模块满足头注释 / 600 行 / 禁用语法", ok, "");
  var pf = readRel("modules/pathfinding.js");
  h.expect("寻路下发目标前接了友军绕行落点",
    pf.indexOf("swarm-collision") > 0 && pf.indexOf("avoidPoint") > 0, "");
  var con = readRel("modules/swarm-console.js");
  h.expect("真实启动链路挂了四个生态模块",
    con.indexOf("swarm-collision") > 0 && con.indexOf("market-wallet") > 0 &&
    con.indexOf("ghost-anticheat") > 0 && con.indexOf("external-bridge") > 0, "");
  h.expect("外部群指令先过本地翻译保护", readRel("modules/external-bridge.js").indexOf("local-translator") > 0, "");
  h.expect("反作弊告警接外部群推送", readRel("modules/ghost-anticheat.js").indexOf("bridge.push") > 0, "");
}
// 29b：多 Bot 防碰撞与加权 A*。
function checkCollision(h) {
  h.section("29b. 多 Bot 防碰撞 / swarm collision");
  var sc = load("modules/swarm-collision.js");
  if (!sc) { h.expect("swarm-collision 可加载", false, "null"); return; }
  sc.reset();
  h.expect("登记两个友军并读到坐标",
    sc.track({ entity: { position: { x: 2, y: 64, z: 0 } } }, "friend1", {}).ok === true &&
    sc.update("friend2", { x: 8, y: 64, z: 8 }, {}).ok === true &&
    sc.positions("", {}).length === 2, JSON.stringify(sc.positions("", {})));
  h.expect("忽略自己、只算其余友军", sc.positions("friend1", {}).length === 1, "");
  h.expect("友军同格代价远高于邻格与远处",
    sc.costAt(2, 0, "me", {}) > sc.costAt(2, 1, "me", {}) &&
    sc.costAt(2, 1, "me", {}) > sc.costAt(5, 0, "me", {}) &&
    sc.costAt(5, 0, "me", {}) === 0, JSON.stringify({ a: sc.costAt(2, 0, "me", {}), b: sc.costAt(2, 1, "me", {}) }));
  var avoid = sc.avoidPoint({ username: "me" }, { x: 2, y: 64, z: 0 }, {});
  h.expect("目标被友军占住时改走代价更低的落点",
    avoid.ok === true && avoid.shifted === true && avoid.cost < avoid.originalCost &&
    (avoid.x !== 2 || avoid.z !== 0), JSON.stringify(avoid));
  sc.reset();
  sc.update("friend1", { x: 2, y: 64, z: 0 }, {});
  var route = sc.planRoute({ x: 0, z: 0 }, { x: 4, z: 0 }, { selfId: "me" });
  var hit = false;
  for (var i = 0; i < route.path.length; i++) if (route.path[i].x === 2 && route.path[i].z === 0) hit = true;
  h.expect("加权 A* 路线绕开友军所在格且能抵达终点",
    route.ok === true && route.path.length >= 5 && hit === false &&
    route.path[route.path.length - 1].x === 4, JSON.stringify(route.path));
  h.expect("无友军时不产生无谓绕行",
    sc.reset().ok === true && sc.avoidPoint({ username: "me" }, { x: 2, y: 64, z: 0 }, {}).shifted === false, "");
  h.expect("统计里能看见登记 / 绕行 / 路线次数", sc.stats().ok === true, "");
}
// 29c：公屏雇佣与钱包。
function checkMarket(h) {
  h.section("29c. 雇佣交易与钱包 / market wallet");
  var mw = load("modules/market-wallet.js");
  if (!mw) { h.expect("market-wallet.js 加载失败", false, "null"); return; }
  mw.reset();
  var zh = mw.parseOffer("谁能帮我建房子我给10钻石", "Steve", {});
  h.expect("中文招工解析出任务 / 报价 / 货币 / 雇主",
    zh.ok === true && zh.task === "建房子" && zh.reward === 10 &&
    zh.currency === "diamond" && zh.customer === "Steve", JSON.stringify(zh));
  var en = mw.parseOffer("build me a tower for 8 emeralds", "Alex", {});
  h.expect("英文招工同样能识别且货币是绿宝石",
    en.ok === true && en.task === "build" && en.reward === 8 && en.currency === "emerald", JSON.stringify(en));
  h.expect("普通闲聊与无报价招工不接单",
    mw.parseOffer("今天天气真好", "Steve", {}).ok === false &&
    mw.parseOffer("谁能帮我建房子", "Steve", {}).ok === false, "");
  var chats = [];
  var bot = { chat: function (t) { chats.push(t); } };
  var hit = mw.onChat("谁能帮我建房子我给10钻石", "Steve", { bot: bot, botId: "bot-1" });
  h.expect("公屏招工自动接单并双语回话",
    hit.matched === true && !!hit.order && hit.order.status === "accepted" &&
    chats.length === 1 && chats[0].indexOf("接单啦") >= 0 && chats[0].indexOf("Order accepted") >= 0,
    JSON.stringify({ hit: hit.matched, chats: chats }));
  h.expect("自动收一半定金进 Bot 钱包",
    mw.walletOf("bot-1").balance === 5 && mw.ordersOf("bot-1")[0].status === "working",
    JSON.stringify(mw.walletOf("bot-1")));
  var dup = mw.onChat("谁能帮我建房子我给10钻石", "Steve", { bot: bot, botId: "bot-1" });
  h.expect("同一雇主同一任务不重复接单、也不重复刷屏",
    dup.duplicated === true && mw.stats().orders === 1 && chats.length === 1,
    JSON.stringify({ dup: dup.duplicated, stats: mw.stats(), chats: chats }));
  var done = mw.completeOrder(hit.order.id, { bot: bot });
  h.expect("完工结算尾款、钱包累计 10 且订单 done",
    done.ok === true && done.amount === 5 && done.balance === 10 &&
    mw.ordersOf("bot-1")[0].status === "done" && chats.length === 2 &&
    chats[1].indexOf("Job done") >= 0, JSON.stringify(done));
  h.expect("钱包与订单确实落盘且统计可见",
    fs.existsSync(mw.pathOf()) && mw.stats().totalBalance === 10 && mw.stats().done === 1, JSON.stringify(mw.stats()));
  mw.reset();
}
// 29d：幽灵反作弊巡检与截图上报。
function checkAntiCheat(h) {
  h.section("29d. 幽灵反作弊 / ghost anticheat");
  var ga = load("modules/ghost-anticheat.js");
  var eb = load("modules/external-bridge.js");
  if (!ga || !eb) { h.expect("反作弊与桥接可加载", false, "null"); return; }
  ga.reset(); eb.reset(); eb.configure({ offline: true, admin: "Steve" });
  var chats = [];
  var bot = { players: {}, chat: function (t) { chats.push(t); },
    screenshot: function () { return "BASE64-FAKE-SHOT"; } };
  h.expect("手动巡检不挂定时器且阈值在位",
    ga.start(bot, "g1", { manual: true, admin: "Steve" }).ok === true &&
    ga.stats("g1").running === true && ga.stats("g1").speedLimit === 12 &&
    ga.stats("g1").mineLimit === 8 && ga.stats("g1").lagLimit === 300, "");
  ga.sample("g1", { at: 1000, players: [{ name: "Hacker", position: { x: 0, y: 64, z: 0 } }] }, {});
  var round = ga.inspect("g1", { bot: bot, snapshot: { at: 2000,
    players: [{ name: "Hacker", position: { x: 40, y: 64, z: 0 } }],
    breakCount: 12, miner: "Hacker", entityCount: 350 } });
  var kinds = [];
  for (var i = 0; i < round.violations.length; i++) kinds.push(round.violations[i].kind);
  h.expect("一拍同时抓到移速异常 / 自动挖矿 / 恶意卡服",
    round.ok === true && round.reports === 3 && kinds.indexOf("speed") >= 0 &&
    kinds.indexOf("automine") >= 0 && kinds.indexOf("lag") >= 0, JSON.stringify(round.violations));
  h.expect("三条双语告警都发到公屏且截图计数上升",
    chats.length === 3 && chats[0].indexOf("移速异常") >= 0 && chats[0].indexOf("Abnormal") >= 0 &&
    chats[1].indexOf("自动挖矿") >= 0 && chats[2].indexOf("恶意卡服") >= 0 &&
    ga.stats("g1").screenshots === 3, JSON.stringify(chats));
  h.expect("告警同步推送到外部群队列",
    eb.outbox().length === 3 && eb.outbox()[0].event === "anticheat.alert", JSON.stringify(eb.stats()));
  var shot = ga.capture("g1", { kind: "speed", player: "Hacker" }, { bot: bot });
  h.expect("截图接口可用时产出真截图证据",
    shot.ok === true && shot.screenshot === true && shot.evidence.screenshotAvailable === true, JSON.stringify(shot.evidence));
  var noShot = ga.capture("g1", { kind: "lag", player: "Hacker" }, { bot: { chat: function () {} } });
  h.expect("没有截图接口时如实标注为结构化证据",
    noShot.screenshot === false && noShot.evidence.screenshotAvailable === false, JSON.stringify(noShot.evidence));
  var clean = ga.inspect("g1", { bot: bot, snapshot: { at: 3000,
    players: [{ name: "Hacker", position: { x: 41, y: 64, z: 0 } }], breakCount: 1, entityCount: 2 } });
  h.expect("正常一拍不误报", clean.ok === true && clean.reports === 0, JSON.stringify(clean));
  h.expect("停止后巡检不再运行", ga.stop("g1").stopped === true && ga.stats("g1").running === false, "");
  ga.reset();
}
// 29e：全维度信标导航。
function checkBeacon(h) {
  h.section("29e. 全维度信标导航 / beacon nav");
  var bn = load("modules/beacon-nav.js");
  if (!bn) { h.expect("beacon-nav 可加载", false, "null"); return; }
  bn.reset();
  h.expect("三个维度常量齐备", bn.DIMENSIONS.join(",") === "overworld,nether,end", "");
  bn.registerPortal("b1", { name: "home", dimension: "overworld", pos: { x: 80, y: 64, z: 80 } }, {});
  bn.registerPortal("b1", { name: "nether_hub", dimension: "nether", pos: { x: 10, y: 64, z: 10 } }, {});
  h.expect("同名同维度传送点覆盖不重复", bn.stats().portals === 2, JSON.stringify(bn.stats()));
  var debris = bn.planExpedition("ancient_debris", { origin: { x: 80, y: 64, z: 80 } });
  h.expect("下界残骸远征：维度 / 方块 / 15 层 / 8:1 换算",
    debris.ok === true && debris.dimension === "nether" && debris.block === "ancient_debris" &&
    debris.y === 15 && debris.legs.length === 3 && debris.legs[1].pos.x === 10, JSON.stringify(debris.legs));
  var end = bn.planExpedition("end_city", {});
  h.expect("末地城远征走要塞传送门", end.ok === true && end.dimension === "end" &&
    end.legs[1].kind === "portal", JSON.stringify(end.legs));
  bn.recordFind("b1", { name: "debris1", dimension: "nether", pos: { x: 12, y: 15, z: 12 } }, {});
  h.expect("发现点自动立信标且可按维度检索",
    bn.beacons("nether", {}).length === 1 && bn.beacons("nether", {})[0].kind === "beacon", "");
  var chats = [];
  var guide = bn.guide("b1", { dimension: "nether", pos: { x: 20, y: 15, z: 20 } },
    { bot: { chat: function (t) { chats.push(t); } } });
  h.expect("一句指令给出主世界门 → 下界门 → 信标 → 终点四段带路",
    guide.ok === true && guide.legs.length === 4 && guide.commands.length === 4 &&
    guide.commands[0].indexOf("#goto 80 64 80") === 0 &&
    guide.commands[2].indexOf("#goto 12 15 12") === 0 &&
    chats.length === 1 && chats[0].indexOf("Follow the beacons") >= 0, JSON.stringify(guide.commands));
  h.expect("未知远征目标安全失败", bn.planExpedition("unknown_thing", {}).ok === false, "");
  bn.reset();
}
// 29f：QQ / Discord 外部桥接。
function checkBridge(h) {
  h.section("29f. 外部桥接 / QQ-Discord bridge");
  var eb = load("modules/external-bridge.js");
  var bus = load("modules/event-bus.js");
  if (!eb || !bus) { h.expect("桥接与总线可加载", false, "null"); return; }
  eb.reset();
  var cfg = eb.configure({ offline: true, admin: "Steve" });
  h.expect("默认离线模式绝不做真实网络请求",
    cfg.ok === true && cfg.offline === true && eb.stats().offline === true, "");
  var pushed = eb.push("player.death", { text: "Steve 掉进岩浆 / Steve fell into lava" }, {});
  h.expect("游戏内死亡事件生成双语推送并进离线队列",
    pushed.ok === true && pushed.queued === true && pushed.delivered === 0 &&
    pushed.text.indexOf("[player.death]") >= 0 && pushed.text.indexOf(" / ") >= 0 &&
    eb.outbox().length === 1, JSON.stringify(pushed));
  h.expect("关注的事件含炸家 / 死亡 / 雇佣订单",
    eb.CHANNELS.indexOf("base.griefed") >= 0 && eb.CHANNELS.indexOf("player.death") >= 0 &&
    eb.CHANNELS.indexOf("market.order") >= 0, JSON.stringify(eb.CHANNELS));
  h.expect("事件桥可挂载且总线 reset 后能自愈重挂",
    eb.bindEvents().ok === true && bus.listenerCount("player.death") >= 1 &&
    (bus.reset(), eb.bindEvents().ok === true, bus.listenerCount("player.death") >= 1), "");
  bus.emit("base.griefed", { text: "家被炸了 / base griefed" });
  h.expect("游戏内炸家事件自动推到外部群",
    eb.outbox().length >= 2 && eb.outbox()[eb.outbox().length - 1].event === "base.griefed", JSON.stringify(eb.stats()));
  var chats = [];
  var relay = eb.onExternal("goto 100 64 200", { bot: { chat: function (t) { chats.push(t); } } });
  h.expect("外部群指令回灌游戏内并原样保住坐标",
    relay.ok === true && relay.executed === true && relay.command === "#goto 100 64 200" &&
    chats.length === 1 && chats[0] === "#goto 100 64 200", JSON.stringify(relay));
  h.expect("待执行指令队列可拉取且统计可见",
    eb.pullCommands().length === 1 && eb.inbox().length === 0 &&
    eb.stats().incoming === 1 && eb.stats().executed === 1, JSON.stringify(eb.stats()));
  eb.reset();
}
// 29g：本地 HY-MT1.5-1.8B 翻译与保护 / 反向验证。
function checkTranslator(h) {
  h.section("29g. 本地翻译模型 / HY-MT1.5-1.8B");
  var tr = load("modules/local-translator.js");
  if (!tr) { h.expect("local-translator 可加载", false, "null"); return; }
  tr.reset();
  h.expect("优先模型是腾讯混元 HY-MT1.5-1.8B 且默认离线",
    tr.MODEL === "HY-MT1.5-1.8B" && tr.DEFAULT_ENDPOINT.indexOf("127.0.0.1") >= 0 &&
    tr.stats().offline === true, JSON.stringify(tr.stats()));
  var raw = "请带我去 #goto 100 64 200 那里 / please guide me to #goto 100 64 200";
  var guarded = tr.protect(raw, {});
  h.expect("翻译前把 #指令 与坐标全部换成占位符",
    guarded.ok === true && guarded.count === 4 && guarded.masked.indexOf("#goto") < 0 &&
    guarded.masked.indexOf("100 64 200") < 0 && guarded.masked.indexOf("[[MBT0]]") >= 0,
    JSON.stringify(guarded));
  h.expect("占位符可逐字还原成原话", tr.restore(guarded.masked, guarded.tokens, {}).text === raw, "");
  var good = tr.translate(raw, {
    translateFn: function (m) { return m.replace("请带我去", "带我前往").replace("please guide me to", "take me to"); },
    reverseFn: function (m) { return m; }
  });
  h.expect("正常译文通过反向验证且指令坐标分毫不动",
    good.translated === true && good.fallback === false && good.text.indexOf("带我前往") >= 0 &&
    good.text.indexOf("#goto 100 64 200") >= 0 && good.text.indexOf("take me to") >= 0, JSON.stringify(good));
  var bad = tr.translate(raw, { translateFn: function () { return "完全改坏的译文"; }, reverseFn: function (m) { return m; } });
  h.expect("译文吞掉受保护占位符时自动退回原话",
    bad.fallback === true && bad.translated === false && bad.text === raw, JSON.stringify(bad.text));
  var reversed = tr.translate(raw, { translateFn: function (m) { return m; },
    reverseFn: function () { return "回译把坐标吞了"; } });
  h.expect("反向验证坐标丢失时自动退回原话",
    reversed.fallback === true && reversed.text === raw && reversed.reason.indexOf("reverse check failed") >= 0,
    JSON.stringify(reversed.reason));
  var noModel = tr.translate(raw, {});
  h.expect("没配模型时原样返回并标记 fallback",
    noModel.fallback === true && noModel.text === raw, JSON.stringify(noModel.reason));
  h.expect("统计里能看到调用 / 成功 / 回退 / 保护数",
    tr.stats().calls === 4 && tr.stats().translated === 1 && tr.stats().fallback === 3 &&
    tr.stats().protected >= 16, JSON.stringify(tr.stats()));
  tr.reset();
}
// 主流程：先隔离 state 目录，再逐组跑；任一组抛错只记一条失败；收尾清理还原。
async function run(h) {
  var OLD = process.env.MINEBOTS_STATE_DIR;
  try {
    safeRemove(TEMP_DIR);
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
    process.env.MINEBOTS_STATE_DIR = TEMP_DIR;
    var groups = [checkStatic, checkCollision, checkMarket, checkAntiCheat, checkBeacon, checkBridge, checkTranslator];
    for (var i = 0; i < groups.length; i++) {
      try { groups[i](h); } catch (e) { h.expect("29 组 " + (i + 1) + " 未抛错", false, String(e)); }
    }
  } catch (eStart) { h.expect("29 环境隔离未抛错", false, String(eStart)); }
  try {
    var names = ["market-wallet", "ghost-anticheat", "beacon-nav", "external-bridge", "local-translator", "swarm-collision"];
    for (var k = 0; k < names.length; k++) {
      var mod = load("modules/" + names[k] + ".js");
      try { if (mod && typeof mod.reset === "function") mod.reset(); } catch (eR) { /* ignore */ }
    }
    safeRemove(TEMP_DIR);
    if (OLD === undefined) delete process.env.MINEBOTS_STATE_DIR;
    else process.env.MINEBOTS_STATE_DIR = OLD;
    h.expect("临时 state 目录已清理、环境已还原", fs.existsSync(TEMP_DIR) === false, TEMP_DIR);
  } catch (eEnd) { h.expect("29h 收尾未抛错", false, String(eEnd)); }
}
module.exports = { run: run };
