// ========================================
// 文件：scripts/selftest-p13d.js
// 功能：P13 模块4 回归自测——红石网表真值表 / A* 自动布线 / 15ms 漂移补偿 / TPS-Ping 安全阀门 /
//       矿车取货 + 漏斗接收 + 规则精准分类 / 机器拉杆启动与溢出漏出报警
// 依赖：path、fs；被测模块（都可选，缺了记失败而不崩）
// 导出：run（由 selftest-p5.js 调用）
// 作者：MineBots
// ========================================
// 说明：全程离线，bot / 容器 / 漏斗全部内存假实现，不联网、不碰真实存档。
var path = require("path");
var fs = require("fs");
var ROOT = path.join(__dirname, "..");

// 安全 require：缺失或抛错返回 null。
function load(rel) {
  try { return require(path.join(ROOT, rel)); } catch (e) { return null; }
}
// 读项目文件文本；读不到返回空串。
function readRel(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch (e) { return ""; }
}
// 27a：静态红线与接线。
function checkStatic(h) {
  h.section("27a. 模块4 静态红线 / static");
  var files = ["modules/minecart-logistics.js", "modules/redstone-machine-patrol.js"];
  var banned = [/\?\./, /\?\?/, /^import\s+/m, /^export\s+/m];
  var ok = true;
  for (var i = 0; i < files.length; i++) {
    var text = readRel(files[i]);
    if (text.length === 0 || text.indexOf("// ====") !== 0 || text.split("\n").length > 600) ok = false;
    for (var j = 0; j < banned.length; j++) if (banned[j].test(text)) ok = false;
  }
  h.expect("2 个红石新模块满足头注释 / 600 行 / 禁用语法", ok, "");
  h.expect("矿车物流复用既有物流别名表", readRel("modules/minecart-logistics.js").indexOf("bot-logistics") > 0, "");
  h.expect("机器巡检读取安全阀门降频状态", readRel("modules/redstone-machine-patrol.js").indexOf("redstone-safety") > 0, "");
}
// 27b：既有红石四大能力回归。
function checkExisting(h) {
  h.section("27b. 红石四大底座回归 / existing engines");
  var sim = load("modules/redstone-sim.js");
  var router = load("modules/redstone-router.js");
  var trigger = load("modules/redstone-trigger.js");
  var safety = load("modules/redstone-safety.js");
  var logistics = load("modules/bot-logistics.js");
  if (!sim || !router || !trigger || !safety || !logistics) { h.expect("红石五模块可加载", false, "null"); return; }
  h.expect("网表仿真支持 AND / OR / NOT / XOR 四门",
    ["AND", "OR", "NOT", "XOR"].every(function (g) { return sim.GATE_TYPES.indexOf(g) >= 0; }), JSON.stringify(sim.GATE_TYPES));
  var tables = ["AND", "OR", "NOT", "XOR"];
  var allOk = true;
  for (var i = 0; i < tables.length; i++) if (!sim.verifyTruthTable(tables[i]).ok) allOk = false;
  h.expect("四种门真值表全部跑通（Tick 级网表仿真）", allOk, "");
  h.expect("AND 真值表 4 个用例零失败", sim.verifyTruthTable("AND").cases === 4 && sim.verifyTruthTable("AND").failed === 0, "");
  var nl = router.netlistOf("AND", 3, {});
  var pl = router.place(nl, {});
  var pathResult = router.astar(pl, { x: 0, z: 0 }, { x: 3, z: 1 }, {});
  var dodged = Array.isArray(pathResult) && pathResult.length >= 4;
  for (var pi = 1; pi < (Array.isArray(pathResult) ? pathResult.length - 1 : 0); pi++) {
    if (pl.blocked[pathResult[pi].x + ":" + pathResult[pi].z]) dodged = false;
  }
  h.expect("A* 自动布线能绕开障碍找到一条路", dodged, JSON.stringify(pathResult).slice(0, 160));
  var req = router.parseRequest("建一个三输入与门");
  h.expect("自动布线能解析三输入与门需求", req.ok === true && req.gate === "AND" && req.inputCount === 3, JSON.stringify(req));
  h.expect("超距自动插中继器的上限常量可见", router.MAX_WIRE_LENGTH >= 15, String(router.MAX_WIRE_LENGTH));
  h.expect("触发器最小间隔达到 15ms 精度以内", trigger.MIN_INTERVAL_MS <= 15, String(trigger.MIN_INTERVAL_MS));
  var trigText = readRel("modules/redstone-trigger.js");
  h.expect("触发器具备漂移补偿与动态调频接口",
    typeof trigger.startTriggerLoop === "function" && typeof trigger.setIntervalMs === "function" &&
    trigText.indexOf("漂移补偿") >= 0 && trigText.indexOf("startedAt") >= 0 &&
    trigText.indexOf("scheduled") >= 0 && trigText.indexOf(".unref()") >= 0, "");
  h.expect("安全阀门阈值为 TPS<18 / Ping>200", safety.TPS_THRESHOLD === 18 && safety.PING_LIMIT === 200, "");
  h.expect("安全阀门能采样、评估、应用降频",
    typeof safety.sample === "function" && typeof safety.evaluate === "function" && typeof safety.apply === "function", "");
  var rules = logistics.parseRules(null, "[分类] 石头 圆石");
  h.expect("告示牌规则解析出物品白名单", rules.parsed === true && rules.items.indexOf("stone") >= 0, JSON.stringify(rules));
}
// 27c：矿车取货、漏斗接收与规则分类。
function checkCart(h) {
  h.section("27c. 矿车与物流分拣 / minecart logistics");
  var m = load("modules/minecart-logistics.js");
  if (!m) { h.expect("minecart-logistics 可加载", false, "null"); return; }
  m.reset();
  var bot = { entities: {
    cart1: { name: "minecraft:chest_minecart", items: [{ name: "iron_ingot", count: 8 }, { name: "redstone", count: 12 }] },
    mob1: { name: "minecraft:pig", items: [] }
  } };
  m.registerBot(bot, "c1", { rules: [
    { match: "iron", chest: "ore" }, { match: "redstone", chest: "dust" }, { match: "diamond", chest: "gem" }
  ] });
  var taken = m.takeFromMinecart("c1", {});
  h.expect("只认矿车实体、不把猪当矿车", taken.ok === true && taken.carts === 1 && taken.items.length === 2, JSON.stringify(taken));
  h.expect("取货清单保留数量与去命名空间", taken.items[0].name === "iron_ingot" && taken.items[0].count === 8, JSON.stringify(taken.items));
  var hop = m.acceptHopper("c1", [{ name: "redstone_dust", count: 4 }], {});
  h.expect("漏斗输出并入待分类缓冲区", hop.ok === true && hop.accepted === 1 && m.stats("c1").buffered === 3, JSON.stringify(m.stats("c1")));
  var stored = m.store("c1", { chests: { ore: { x: 1, y: 64, z: 0 }, dust: { x: 2, y: 64, z: 0 } } });
  h.expect("按规则精准分到 ore / dust 两个箱子",
    stored.ok === true && stored.groups.ore && stored.groups.dust && stored.tasks.length === 2,
    JSON.stringify(stored.groups));
  var ore = stored.tasks.filter(function (t) { return t.chest === "ore"; })[0];
  var dust = stored.tasks.filter(function (t) { return t.chest === "dust"; })[0];
  h.expect("箱子任务带正确数量与坐标",
    ore && ore.count === 8 && ore.pos.x === 1 && dust && dust.count === 16, JSON.stringify(stored.tasks));
  h.expect("入箱后缓冲区清空", m.stats("c1").buffered === 0 && m.stats("c1").stored === 3, JSON.stringify(m.stats("c1")));
  var cls = m.classify([{ name: "unknown_thing", count: 1 }], [], { fallbackChest: "misc" });
  h.expect("未命中规则的物品进默认箱且不丢", cls.unmatched.length === 1 && cls.groups.misc.length === 1, JSON.stringify(cls.groups));
  var full = m.run("c2", { bot: bot, hopperItems: [{ name: "diamond", count: 2 }],
    rules: [{ match: "diamond", chest: "gem" }] });
  h.expect("一站式链路：取货 → 漏斗 → 分类入箱",
    full.ok === true && full.cart.items.length === 2 && full.hopper.accepted === 1 && full.stored.stored === 3,
    JSON.stringify({ cart: full.cart.items.length, hopper: full.hopper.accepted, stored: full.stored.stored }));
  h.expect("统计里能看到矿车 / 漏斗 / 入箱数", m.stats().carts >= 2 && m.stats().hoppers >= 2 && m.stats().stored >= 6, JSON.stringify(m.stats()));
  m.reset();
}
// 27d：机器巡检、拉杆启动与溢出报警。
function checkMachine(h) {
  h.section("27d. 机器巡检 / machine patrol");
  var p = load("modules/redstone-machine-patrol.js");
  if (!p) { h.expect("redstone-machine-patrol 可加载", false, "null"); return; }
  p.reset();
  var calls = [];
  var chats = [];
  var bot = {
    activateBlock: function (pos) { calls.push("lever:" + pos.x + "," + pos.y + "," + pos.z); },
    chat: function (t) { chats.push(t); },
    entities: { i1: { name: "item" }, i2: { name: "item" }, i3: { name: "item" }, pig: { name: "pig" } }
  };
  var started = p.start(bot, "m1", { manual: true, lever: { x: 3, y: 64, z: 0 },
    hoppers: [{ items: [1, 2, 3, 4, 5] }, { items: [1] }], hopperFull: 5, dropLimit: 3 });
  h.expect("启动巡检时自动拉杆启动机器",
    started.ok === true && started.lever.ok === true && calls.length === 1 && calls[0] === "lever:3,64,0",
    JSON.stringify({ started: started.ok, calls: calls }));
  var round = p.inspect("m1", {});
  h.expect("一拍同时发现漏斗溢出与掉落物漏出",
    round.ok === true && round.overflow === 1 && round.leaks === 1 && round.alerts === 2, JSON.stringify(round));
  h.expect("两类报警都是中英双语",
    chats.length === 2 && chats[0].indexOf("漏斗溢出") >= 0 && chats[0].indexOf("Hopper overflow") > 0 &&
    chats[1].indexOf("掉落物漏出") >= 0 && chats[1].indexOf("Loose items") > 0, JSON.stringify(chats));
  var tick = p.patrolTick("m1", { hoppers: [], entities: [] });
  h.expect("无异常的一拍不误报", tick.ok === true && tick.alerts === 0 && p.stats("m1").ticks === 1, JSON.stringify(tick));
  h.expect("手动模式不挂定时器，周期模式定时器 unref",
    readRel("modules/redstone-machine-patrol.js").indexOf(".unref()") > 0 && p.stats("m1").running === true, "");
  h.expect("统计里能看到拉杆 / 溢出 / 漏出 / 报警数",
    p.stats("m1").leverPulls === 1 && p.stats("m1").overflow === 1 &&
    p.stats("m1").leaks === 1 && p.stats("m1").alerts === 2, JSON.stringify(p.stats("m1")));
  h.expect("停止后会话不再运行", p.stop("m1").stopped === true && p.stats("m1").running === false, "");
  p.reset();
}
// 27e：15ms 漂移补偿真实打拍 + 动态调频（手工模式，不联网不挂定时器）。
async function checkTrigger(h) {
  h.section("27e. 零延迟触发 / drift-free trigger");
  var t = load("modules/redstone-trigger.js");
  if (!t) { h.expect("触发器可加载", false, "null"); return; }
  try { t.stopAll(); } catch (e0) { /* 清理历史残留 */ }
  var fires = 0;
  var fake = {
    blockAt: function () { return { name: "lever", stateId: 7, powered: false }; },
    chat: function () { /* noop */ }
  };
  var action = function () { fires = fires + 1; return { ok: true }; };
  var st = t.startTriggerLoop("d1", { x: 1, y: 64, z: 0 }, action, 15,
    { bot: fake, manual: true, board: null });
  h.expect("15ms 间隔被接受且手工模式不挂定时器",
    st.ok === true && st.intervalMs === 15 && !!st.taskId, JSON.stringify(st));
  for (var i = 0; i < 3; i++) await t.tick(st.taskId, { force: true });
  var rec = null;
  var list = t.list();
  for (var j = 0; j < list.length; j++) if (list[j].taskId === st.taskId) rec = list[j];
  h.expect("手工连打三拍全部真实触发、零阻塞",
    !!rec && rec.fired === 3 && rec.blocked === 0 && fires === 3, JSON.stringify(rec));
  var retune = t.setIntervalMs(st.taskId, 10, { manual: true });
  var after = null;
  var list2 = t.list();
  for (var k = 0; k < list2.length; k++) if (list2[k].taskId === st.taskId) after = list2[k];
  h.expect("动态调频到 10ms 并重置漂移基准",
    retune.ok === true && retune.previousMs === 15 && retune.intervalMs === 10 &&
    !!after && after.intervalMs === 10, JSON.stringify(retune));
  var stopped = t.stopTriggerLoop(st.taskId, {});
  var inactive = true;
  var list3 = t.list();
  for (var q = 0; q < list3.length; q++) if (list3[q].active === true) inactive = false;
  h.expect("停止后循环不再活跃且统计归零",
    stopped.ok === true && inactive === true && t.stats().active === 0,
    JSON.stringify({ stopped: stopped, stats: t.stats() }));
  try { t.stopAll(); } catch (e1) { /* ignore */ }
}
// 主流程：逐组跑，任一组抛错只记一条失败。
async function run(h) {
  var groups = [checkStatic, checkExisting, checkCart, checkMachine, checkTrigger];
  for (var i = 0; i < groups.length; i++) {
    try { await groups[i](h); } catch (e) { h.expect("27 组 " + (i + 1) + " 未抛错", false, String(e)); }
  }
}
module.exports = { run: run };
