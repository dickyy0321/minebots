// ========================================
// 文件：scripts/selftest-p10.js
// 功能：P10 回归自测——红石工坊与全自动数字建筑公司：精确模式参数与事件总线广播 /
//       红石全量扫描与故障检测 / 零延迟高频触发器 / 告示牌物流分拣 /
//       .litematic 高维蓝图与 place_block_exact / 属性错误破坏重放 / 红石缺料自动发帖 / GUI 双控件
// 依赖：path、fs、zlib、prismarine-nbt（可选）；导出：run（由 selftest-p5.js 调用，复用 section / expect）
// 作者：MineBots
// ========================================
// 说明 / note：全程不联网、不碰真实 state/；黑板一律用内存假板注入，偏好与参数收尾恢复原值。
var path = require("path"); var fs = require("fs"); var zlib = require("zlib");
var ROOT = path.join(__dirname, "..");
// 按相对路径安全 require 一个模块；缺失或抛错时返回 null（不拖垮整轮自检）。
function load(rel) {
  try { return require(path.join(ROOT, rel)); } catch (e) { return null; }
}
// 读一个项目文件的文本；读不到返回空串。
function readRel(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch (e) { return ""; }
}
// 测试等待必须保持事件循环存活（触发器自身定时器已 unref），所以这里不 unref。
function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
// 造一个内存黑板：实现扫描告警 / 触发器 / 分拣 / 建筑缺料需要的全部接口，绝不写盘、绝不联网。
function fakeBoard() {
  var tasks = {}, data = {}, messages = {}, seq = 0;
  return {
    tasks: tasks, data: data, messages: messages,
    post: function (k, v) { data[k] = JSON.parse(JSON.stringify(v)); return { ok: true }; },
    get: function (k, d) { return data[k] === undefined ? d : JSON.parse(JSON.stringify(data[k])); },
    has: function (k) { return data[k] !== undefined; },
    keys: function () { return Object.keys(data); },
    del: function (k) { delete data[k]; return { ok: true }; },
    postTask: function (t) {
      seq = seq + 1;
      var id = "t" + seq;
      tasks[id] = { id: id, title: t.title, priority: Number(t.priority) || 0,
        payload: JSON.parse(JSON.stringify(t.payload || {})), status: "pending", claimedBy: "" };
      return { ok: true, taskId: id, task: tasks[id] };
    },
    listTasks: function (f) {
      var out = [], want = f && f.status ? f.status : "all";
      for (var k in tasks) {
        if (!Object.prototype.hasOwnProperty.call(tasks, k)) continue;
        if (want !== "all" && tasks[k].status !== want) continue;
        out.push(JSON.parse(JSON.stringify(tasks[k])));
      }
      out.sort(function (a, b2) { return Number(b2.priority) - Number(a.priority); });
      return out;
    },
    claimTask: function (botId, o) {
      var t = tasks[o && o.taskId];
      if (!t || t.status !== "pending") return { ok: false, message: "task taken / 已被抢走" };
      t.status = "claimed"; t.claimedBy = botId;
      return { ok: true, taskId: t.id, task: JSON.parse(JSON.stringify(t)) };
    },
    releaseTask: function (id) {
      if (!tasks[id]) return { ok: false };
      tasks[id].status = "pending"; tasks[id].claimedBy = "";
      return { ok: true };
    },
    completeTask: function (id) {
      if (!tasks[id]) return { ok: false };
      tasks[id].status = "done";
      return { ok: true };
    },
    postMessage: function (botId, text) {
      if (!messages[botId]) messages[botId] = [];
      messages[botId].push(text);
      return { ok: true };
    },
    postDemand: function (botId, items) {
      data["demand:" + botId] = { botId: botId, items: items };
      return { ok: true, botId: botId, items: items, message: "demand posted / 需求已发布" };
    },
    postSupply: function (botId, items) {
      data["supply:" + botId] = { botId: botId, items: items };
      return { ok: true, botId: botId, items: items, message: "supply posted / 供给已发布" };
    }
  };
}
// 假红石 bot：三个坐标分别是中继器 / 活塞 / 普通石头，状态由 getProperties() 提供。
function fakeRedstoneBot() {
  var chatLines = [];
  var repeater = { name: "minecraft:repeater", stateId: 101,
    getProperties: function () { return { facing: "north", powered: "true", delay: "2" }; } };
  var piston = { name: "minecraft:piston", stateId: 202,
    getProperties: function () { return { facing: "south", powered: "false" }; } };
  var stone = { name: "minecraft:stone", stateId: 1, getProperties: function () { return {}; } };
  return {
    chatLines: chatLines,
    blockAt: function (p) {
      var key = p.x + "," + p.y + "," + p.z;
      if (key === "0,64,0") return repeater;
      if (key === "1,64,0") return piston;
      if (key === "2,64,0") return stone;
      return { name: "minecraft:air", stateId: 0, getProperties: function () { return {}; } };
    },
    chat: function (text) { chatLines.push(String(text)); }
  };
}
// 假触发 bot：记录 bot.blockAt 预检次数与 bot.activateBlock 次数，可切成空气验证防漏包。
function fakeTriggerBot() {
  var reads = 0, activations = 0, looks = 0, air = false;
  return {
    blockAt: function () {
      reads = reads + 1;
      if (air) return { name: "air", stateId: 0, getProperties: function () { return {}; } };
      return { name: "minecraft:stone_button", stateId: 12,
        getProperties: function () { return { powered: "false" }; } };
    },
    activateBlock: function () { activations = activations + 1; return Promise.resolve(); },
    lookAt: function () { looks = looks + 1; return Promise.resolve(); },
    setAir: function (v) { air = v === true; },
    state: function () { return { reads: reads, activations: activations, looks: looks }; }
  };
}
// 假分拣 bot：箱子带 [分类] 石头 告示牌，clickWindow 记录槽位 / 按键 / 模式。
function fakeSortBot() {
  var clicks = [], closed = 0;
  return {
    clicks: clicks,
    window: { close: function () { closed = closed + 1; }, slots: [] },
    blockAt: function () { return { name: "minecraft:chest", signText: "[分类] 石头" }; },
    clickWindow: function (slot, button, mode) {
      clicks.push({ slot: slot, button: button, mode: mode });
      return Promise.resolve();
    },
    closeWindow: function () { closed = closed + 1; },
    state: function () { return { clicks: clicks, closed: closed }; }
  };
}
// 假精确建筑 bot：第一次放置 facing=south（错误），破坏后第二次 facing=north（正确）。
function fakeExactBot() {
  var placed = null, digs = 0, looks = 0, places = 0;
  function target(p) {
    return p.x === 5 && p.y === 64 && p.z === 0;
  }
  return {
    blockAt: function (p) {
      if (target(p)) {
        if (!placed) return { name: "minecraft:air", stateId: 0, getProperties: function () { return {}; } };
        return { name: "minecraft:oak_stairs", stateId: 33,
          getProperties: function () { return placed; } };
      }
      return { name: "minecraft:stone", stateId: 1, getProperties: function () { return {}; } };
    },
    lookAt: function () { looks = looks + 1; return Promise.resolve(); },
    placeBlock: function () {
      places = places + 1;
      placed = places === 1 ? { facing: "south", half: "top" } : { facing: "north", half: "top" };
      return Promise.resolve();
    },
    dig: function () { digs = digs + 1; placed = null; return Promise.resolve(); },
    state: function () { return { digs: digs, looks: looks, places: places, placed: placed }; }
  };
}
// 造一个真实 gzip + NBT 的 .litematic（2x1x1，palette 含带状态的楼梯 / 中继器），失败返回 null。
function makeLitematic() {
  var nbt = null;
  try { nbt = require("prismarine-nbt"); } catch (e) { return null; }
  try {
    function comp(value) { return { type: "compound", value: value }; }
    function int(value) { return { type: "int", value: value }; }
    var region = comp({
      Size: comp({ x: int(2), y: int(1), z: int(1) }),
      Position: comp({ x: int(5), y: int(64), z: int(0) }),
      BlockStatePalette: comp({
        "minecraft:air": int(0),
        "minecraft:oak_stairs[facing=north,half=top]": int(1),
        "minecraft:repeater[delay=2,facing=east]": int(2)
      }),
      BlockStates: nbt.longArray([[0, 18], [0, 0]])
    });
    var root = comp({ Regions: comp({ r1: region }) });
    root.name = "";
    return zlib.gzipSync(nbt.writeUncompressed(root));
  } catch (e) { return null; }
}
// 20a：静态接线——所有新增模块可加载、导出齐全，关键接线点都落在已有代码里。
function checkStatic(h) {
  h.section("20a. 红石工坊静态接线 / redstone workshop wiring");
  var pairs = [
    ["modules/exact-placement.js", ["centerOf", "aimAt", "placeAim", "activateBlock", "acceleration"]],
    ["modules/redstone-inspector.js", ["scanRedstoneArea", "verifyCircuit", "readState", "lastScan", "REPAIR_TITLE"]],
    ["modules/redstone-trigger.js", ["startTriggerLoop", "stopTriggerLoop", "stopAll", "tick", "list", "stats"]],
    ["modules/bot-logistics.js", ["autoSort", "chestTransfer", "parseRules", "onFarmFull", "logisticsTick"]],
    ["modules/blueprint-highdim.js", ["splitSpec", "parseProps", "fromLitematic", "decodeBlockStates", "buildExactTasks"]],
    ["modules/state-skills-build.js", ["HANDLERS", "NAMES", "has", "pick"]],
    ["modules/redstone-supply.js", ["composePost", "postForMissing", "isRedstone", "normalize"]]
  ];
  for (var i = 0; i < pairs.length; i++) {
    var mod = load(pairs[i][0]);
    var names = pairs[i][1];
    var ok = !!mod;
    if (ok) {
      for (var j = 0; j < names.length; j++) if (mod[names[j]] === undefined) ok = false;
    }
    h.expect("模块可加载且导出齐全: " + pairs[i][0], ok, "exports");
  }
  var bp = load("modules/builder-blueprint.js");
  h.expect("builder-blueprint 已接入 .litematic 与精确任务队列",
    !!bp && typeof bp.fromLitematic === "function" && typeof bp.buildExactTasks === "function" &&
    typeof bp.splitExactToTasks === "function", "builder-blueprint");
  var nodes = load("modules/state-nodes.js");
  h.expect("place_block_exact 已注册进既有 basic 分类（不新增第 12 组）",
    !!nodes && nodes.NAMES.indexOf("place_block_exact") >= 0 && nodes.isAction("place_block_exact") === true &&
    nodes.categoryOf("place_block_exact") === "basic", "state-nodes");
  var act = readRel("modules/actions.js");
  h.expect("actions.js 放置前对准中心且新增 activateBlock",
    act.indexOf("exactPlacement.placeAim") >= 0 && act.indexOf("function activateBlock") >= 0, "actions");
  var mot = readRel("modules/motion.js");
  h.expect("motion.js 暴露精确模式加速度门面", mot.indexOf("function acceleration") >= 0, "motion");
  var eng = readRel("modules/engine-control.js");
  h.expect("engine-control.js 提供实时红石频率", eng.indexOf("function tickRate") >= 0, "engine-control");
  var at = readRel("modules/ai-tools.js");
  h.expect("ai-tools.js 已接红石缺料自动拟帖", at.indexOf("materialSupply") >= 0, "ai-tools");
  var ait = readRel("modules/builder-ai-tools.js");
  h.expect("broadcast_post 支持 missing 缺料清单",
    ait.indexOf("requestMaterialPost") >= 0 && ait.indexOf("supply.composePost") >= 0, "builder-ai-tools");
  var sw = readRel("modules/builder-swarm.js");
  h.expect("蜂群缺料路径自动生成中文求助帖", sw.indexOf("supply.composePost") >= 0, "builder-swarm");
  h.expect("七个新增 / 修改的核心文件都在 600 行红线内",
    readRel("modules/actions.js").split("\n").length <= 600 &&
    readRel("modules/ai-tools.js").split("\n").length <= 600 &&
    readRel("modules/motion.js").split("\n").length <= 600, "600 lines");
}
// 20b：全局开关与频率——真落盘、实时读、事件总线广播四类事件。
function checkPrefs(h) {
  h.section("20b. 精确模式参数与事件总线 / prefs, params & bus");
  var prefs = load("modules/prefs.js");
  var params = load("modules/param-manager.js");
  var eng = load("modules/engine-control.js");
  var bus = load("modules/event-bus.js");
  if (!prefs || !params || !eng || !bus) { h.expect("参数 / 引擎 / 总线模块可加载", false, "require failed"); return; }
  h.expect("state/prefs.json 存在两个全局键（默认关 / 50ms）",
    prefs.getAll().engExactBuild === false && prefs.getAll().redstoneTickRate === 50,
    JSON.stringify({ e: prefs.getAll().engExactBuild, t: prefs.getAll().redstoneTickRate }));
  h.expect("param-manager 两个全局键与事件总线映射齐全",
    params.DEFAULTS.engExactBuild === false && params.DEFAULTS.redstoneTickRate === 50 &&
    params.GLOBAL_KEYS.engExactBuild === "exactBuild" && params.GLOBAL_KEYS.redstoneTickRate === "redstoneTick", "");
  h.expect("engine-control.tickRate 默认 50ms 且实时读盘",
    eng.tickRate() === 50 && typeof eng.tickRate === "function", String(eng.tickRate()));
  prefs.save({ redstoneTickRate: 120 });
  h.expect("热更新频率后 tickRate 立刻变 120ms", eng.tickRate() === 120, String(eng.tickRate()));
  prefs.save({ redstoneTickRate: 50 });
  var exactBefore = params.get("engExactBuild");
  var tickBefore = params.get("redstoneTickRate");
  var seen = [];
  var names = ["engine.changed", "param.changed", "engine.exactBuild.changed", "engine.redstoneTick.changed"];
  var handlers = [];
  for (var i = 0; i < names.length; i++) {
    (function (name) {
      var fn = function () { seen.push(name); };
      handlers.push({ name: name, fn: fn });
      bus.on(name, fn);
    })(names[i]);
  }
  params.set("engExactBuild", true);
  params.set("redstoneTickRate", 80);
  var distinct = {};
  for (var s = 0; s < seen.length; s++) distinct[seen[s]] = true;
  var allHit = true;
  for (var n = 0; n < names.length; n++) if (!distinct[names[n]]) allHit = false;
  h.expect("参数写入经事件总线广播四类事件", allHit, JSON.stringify(seen));
  h.expect("参数写入同步 state/prefs.json 并实时生效",
    prefs.getAll().engExactBuild === true && eng.tickRate() === 80,
    JSON.stringify({ e: prefs.getAll().engExactBuild, t: eng.tickRate() }));
  for (var k = 0; k < handlers.length; k++) bus.off(handlers[k].name, handlers[k].fn);
  // 还原：文件里原本有值就写回原值，原本没有就删键；不把测试状态留给后续分组或真实 state/。
  if (exactBefore.source === "file") params.set("engExactBuild", exactBefore.value);
  else params.remove("engExactBuild");
  if (tickBefore.source === "file") params.set("redstoneTickRate", tickBefore.value);
  else params.remove("redstoneTickRate");
  prefs.save({ engExactBuild: false, redstoneTickRate: 50 });
  h.expect("收尾还原后参数与偏好回到默认",
    params.get("engExactBuild").value === false && params.get("redstoneTickRate").value === 50 &&
    eng.tickRate() === 50 && prefs.getAll().engExactBuild === false, "restore");
}
// 20c：红石全量扫描与故障检测（模拟假 bot）。
function checkInspector(h) {
  h.section("20c. 红石全量扫描与故障检测 / scan & verify");
  var insp = load("modules/redstone-inspector.js");
  if (!insp) { h.expect("红石扫描模块可加载", false, "require failed"); return; }
  insp.reset();
  var bot = fakeRedstoneBot();
  var board = fakeBoard();
  var scan = insp.scanRedstoneArea({ x: 0, y: 64, z: 0 }, { x: 2, y: 64, z: 0 },
    { bot: bot, board: board, botId: "p10" });
  h.expect("scanRedstoneArea 遍历 3 格只挑出 2 个红石元件",
    scan.ok === true && scan.count === 2 && scan.scanned === 3, JSON.stringify(scan.message));
  var first = scan.blocks[0] || {};
  h.expect("stateId 与 getProperties 的 facing / powered / delay 全部读出",
    first.name === "minecraft:repeater" && first.stateId === 101 &&
    first.props.facing === "north" && first.props.powered === "true" && first.props.delay === "2" &&
    first.facing === "north" && first.powered === "true" && first.delay === "2", JSON.stringify(first));
  h.expect("lastScan 快照与本次扫描一致",
    insp.lastScan().ok === true && insp.lastScan().count === 2, "snapshot");
  h.expect("REDSTONE_KEYS 覆盖中继器 / 比较器 / 活塞 / 观察者 / 拉杆",
    insp.REDSTONE_KEYS.indexOf("repeater") >= 0 && insp.REDSTONE_KEYS.indexOf("comparator") >= 0 &&
    insp.REDSTONE_KEYS.indexOf("piston") >= 0 && insp.REDSTONE_KEYS.indexOf("observer") >= 0 &&
    insp.REDSTONE_KEYS.indexOf("lever") >= 0, "keys");
  var expected = {
    "0,64,0": { facing: "north", powered: "true", delay: "2" },
    "1,64,0": { facing: "north" }
  };
  var verify = insp.verifyCircuit(expected, { bot: bot, board: board, botId: "p10" });
  h.expect("verifyCircuit 精确报出 1 处活塞朝向错误",
    verify.ok === false && verify.mismatches.length === 1 && verify.matched === 1,
    JSON.stringify({ ok: verify.ok, n: verify.mismatches.length, matched: verify.matched }));
  h.expect("双语详细报错含坐标 / 期望 / 实际 / 英文原因",
    verify.report[0].indexOf("1,64,0") >= 0 && verify.report[0].indexOf("活塞朝向反了") >= 0 &&
    verify.report[0].indexOf("north") >= 0 && verify.report[0].indexOf("south") >= 0 &&
    verify.report[0].indexOf("facing reversed") >= 0, verify.report[0]);
  h.expect("bot.chat 双语报警真的发出", verify.alerted === 1 && bot.chatLines.length === 1 &&
    bot.chatLines[0].indexOf("Redstone") >= 0, JSON.stringify(bot.chatLines));
  var repair = board.listTasks({ status: "pending" }).filter(function (t) { return t.title === "repair_request"; });
  h.expect("黑板挂 repair_request 且 payload 带完整差异",
    repair.length === 1 && repair[0].priority === 9 && repair[0].payload.action === "repair_redstone" &&
    repair[0].payload.mismatches.length === 1 && verify.taskId === repair[0].id, "repair task");
  var good = insp.verifyCircuit({ "0,64,0": { facing: "north", powered: "true", delay: "2" } },
    { bot: bot, board: board, silent: true, noTask: true });
  h.expect("与图纸一致时校验通过且不报警", good.ok === true && good.matched === 1 &&
    good.alerted === 0 && good.taskId === "", JSON.stringify(good));
}
// 20d：零延迟高频触发器（漂移补偿 + 触发前状态预检 + 黑板挂起多触发器）。
async function checkTrigger(h) {
  h.section("20d. 零延迟高频触发器 / high frequency trigger");
  var trig = load("modules/redstone-trigger.js");
  var eng = load("modules/engine-control.js");
  if (!trig || !eng) { h.expect("触发器模块可加载", false, "require failed"); return; }
  trig.stopAll();
  trig.reset();
  var bot = fakeTriggerBot();
  var board = fakeBoard();
  var pos = { x: 1, y: 64, z: 0 };
  var started = trig.startTriggerLoop("p10-bot", pos, "activate", 15, { bot: bot, board: board });
  h.expect("startTriggerLoop 返回任务 id 与 15ms 间隔",
    started.ok === true && started.taskId.length > 0 && started.intervalMs === 15, JSON.stringify(started));
  h.expect("省略间隔时读 engine-control.tickRate 默认 50ms",
    trig.startTriggerLoop("p10-default", pos, "activate", null, { bot: bot, board: board, manual: true }).intervalMs === eng.tickRate(),
    "default interval");
  h.expect("共享黑板挂起 trigger_loop 任务与快照",
    board.listTasks({ status: "pending" }).filter(function (t) { return t.title === "trigger_loop"; }).length === 2 &&
    Object.keys(board.data).filter(function (k) { return k.indexOf("trigger:") === 0; }).length === 2, "board");
  await sleep(105);
  await sleep(20); // 让最后一拍的异步 fire 落地，再停表读数，避免竞态。
  var stopped = trig.stopTriggerLoop(started.taskId);
  h.expect("到达指定时间精准触发（15ms 间隔 105ms 内至少 4 拍）",
    stopped.ok === true && stopped.fired >= 4 && stopped.ticks >= 4 &&
    stopped.fired <= stopped.ticks && stopped.blocked === 0,
    JSON.stringify(stopped));
  h.expect("每次触发都真调 bot.activateBlock 且触发前读 bot.blockAt",
    bot.state().activations >= 4 && bot.state().reads >= 4, JSON.stringify(bot.state()));
  var firedAfterStop = bot.state().activations;
  await sleep(45);
  h.expect("stopTriggerLoop 后不再触发", bot.state().activations === firedAfterStop, "stopped");
  bot.setAir(true);
  var air = await trig.tick(started.taskId, {});
  h.expect("目标方块变成空气时状态预检阻止发网络包",
    air.ok === false && air.blocked === true, JSON.stringify(air));
  bot.setAir(false);
  var manual = await trig.tick(started.taskId, {});
  h.expect("手动 tick 走同一条 fire 链路", manual.ok === true && manual.fired === true, JSON.stringify(manual));
  trig.stopAll();
  var st = trig.stats();
  h.expect("stats 累计 fired / started 且 active 归零",
    st.fired >= 5 && st.started === 2 && st.active === 0, JSON.stringify(st));
  h.expect("stopAll 收掉全部触发器", trig.list().filter(function (r) { return r.active === true; }).length === 0, "stopAll");
}
// 20e：海量物流分拣（告示牌文本 / JSON 规则 / 箱子间搬运 / 农场满仓调度）。
async function checkLogistics(h) {
  h.section("20e. 海量物流分拣与自动化基建 / autoSort");
  var logi = load("modules/bot-logistics.js");
  if (!logi) { h.expect("物流模块可加载", false, "require failed"); return; }
  logi.reset();
  var bot = fakeSortBot();
  var board = fakeBoard();
  var items = [
    { name: "stone", count: 16, slot: 3 },
    { name: "dirt", count: 4, slot: 5 },
    { name: "cobblestone", count: 2, slot: 7 }
  ];
  var sorted = await logi.autoSort({ x: 0, y: 64, z: 0 }, null,
    { bot: bot, board: board, window: bot.window, items: items });
  h.expect("autoSort 从 bot.blockAt 读到 [分类] 石头 告示牌",
    sorted.signText.indexOf("[分类] 石头") >= 0 && !!sorted.rule && sorted.rule.parsed === true,
    JSON.stringify({ sign: sorted.signText, rule: sorted.rule }));
  h.expect("按告示牌只把石头类物品 clickWindow 存入箱子",
    sorted.ok === true && sorted.moved === 2 && sorted.skipped === 1 &&
    sorted.items[0].name === "stone" && sorted.items[1].name === "cobblestone", JSON.stringify(sorted));
  h.expect("bot.clickWindow(slot, 0, 1) 用快速移动模式且槽位正确",
    bot.state().clicks.length === 2 && bot.state().clicks[0].slot === 3 &&
    bot.state().clicks[0].button === 0 && bot.state().clicks[0].mode === 1 &&
    bot.state().clicks[1].slot === 7, JSON.stringify(bot.state().clicks));
  h.expect("容器窗口用完即关", bot.state().closed >= 1, "window.close");
  var discarded = logi.parseRules(null, "[废弃] 圆石");
  h.expect("[废弃] 告示牌解析成杂物集合", discarded.discard === true &&
    discarded.items.indexOf("cobblestone") >= 0 && discarded.items.indexOf("dirt") >= 0,
    JSON.stringify(discarded));
  var jsonRule = logi.parseRules("{\"items\":[\"repeater\",\"comparator\"],\"discard\":false}", "");
  h.expect("JSON 规则（含脏 JSON 修复）解析红石元件",
    jsonRule.parsed === true && jsonRule.items.indexOf("repeater") >= 0 &&
    jsonRule.items.indexOf("comparator") >= 0, JSON.stringify(jsonRule));
  var farm = logi.onFarmFull({ x: 4, y: 64, z: 0 }, { board: board, botId: "farm-1" });
  h.expect("农场满仓在黑板挂 logistics_sort 任务",
    farm.ok === true && farm.taskId.length > 0 &&
    board.tasks[farm.taskId].title === logi.SORT_TASK, JSON.stringify(farm));
  var transferBot = fakeSortBot();
  transferBot.window.slots = [{ name: "repeater", count: 10, slot: 0 }];
  var moved = await logi.chestTransfer({ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }, "repeater", 10,
    { bot: transferBot, window: transferBot.window, items: [{ name: "repeater", count: 10, slot: 2 }] });
  h.expect("chestTransfer 箱子间搬运真调 clickWindow",
    moved.ok === true && moved.transferred >= 1 && transferBot.state().clicks.length >= 2,
    JSON.stringify(moved));
}
// 20f：.litematic 高维蓝图与 place_block_exact 任务队列。
function checkHighdim(h) {
  h.section("20f. 高维蓝图精准度 / litematic & exact tasks");
  var hd = load("modules/blueprint-highdim.js");
  var bp = load("modules/builder-blueprint.js");
  if (!hd || !bp) { h.expect("高维蓝图模块可加载", false, "require failed"); return; }
  var spec = hd.splitSpec("minecraft:oak_stairs[facing=north,half=top]");
  var props = hd.parseProps("facing=north,half=top,delay=2,powered=true");
  h.expect("方块名与方块状态被拆开", spec.block === "oak_stairs" &&
    spec.state === "facing=north,half=top", JSON.stringify(spec));
  h.expect("高维属性 facing / half / delay / powered 全解析",
    props.facing === "north" && props.half === "top" && props.delay === "2" &&
    props.powered === "true", JSON.stringify(props));
  var ids = hd.decodeBlockStates([[0, 18], [0, 0]], 3, 2);
  h.expect("BlockStates 位压缩按 bits=2 正确解码（含跨 long 边界）",
    ids.length === 2 && ids[0] === 2 && ids[1] === 0, JSON.stringify(ids));
  var gz = makeLitematic();
  if (!gz) { h.expect("真实 gzip + NBT 的 .litematic 可构造", false, "nbt unavailable"); return; }
  var parsed = hd.fromLitematic(gz);
  h.expect("真实 gzip + NBT 的 .litematic 解析成功并跳过空气",
    parsed.ok === true && parsed.blueprint.format === "litematic" &&
    parsed.blueprint.blocks.length === 1, JSON.stringify(parsed.message));
  h.expect("litematic 保留 origin 与 palette 内嵌的 facing / delay 属性",
    parsed.blueprint.origin.x === 5 && parsed.blueprint.blocks[0].block === "repeater" &&
    parsed.blueprint.blocks[0].props.facing === "east" && parsed.blueprint.blocks[0].props.delay === "2",
    JSON.stringify(parsed.blueprint.blocks[0]));
  var viaBp = bp.parse(gz, { format: "litematic" });
  h.expect("builder-blueprint 的 parse(format:litematic) 走同一条高维链路",
    viaBp.ok === true && viaBp.blueprint.format === "litematic", "builder-blueprint");
  var tasks = bp.buildExactTasks(parsed.blueprint, { exact: true });
  h.expect("buildExactTasks 生成 place_block_exact 且带 expectedState / 放置面 / 重试次数",
    tasks.length === 1 && tasks[0].action === "place_block_exact" && tasks[0].pos.x === 5 &&
    tasks[0].expectedState.facing === "east" && tasks[0].expectedState.delay === "2" &&
    tasks[0].face === "east" && tasks[0].maxRetries === 2, JSON.stringify(tasks));
  var b = fakeBoard();
  var split = bp.splitExactToTasks(parsed.blueprint, { board: b, exact: true });
  h.expect("精确任务队列压入共享黑板且标题为 build:place_exact",
    split.ok === true && split.count === 1 && b.tasks[split.taskIds[0]].title === "build:place_exact" &&
    b.tasks[split.taskIds[0]].payload.action === "place_block_exact", JSON.stringify(split));
}
// 20g：place_block_exact 属性不符时 bot.dig 破坏 + 重新 lookAt + 换放置面重放。
async function checkExactSkill(h) {
  h.section("20g. 精确放置属性返工 / dig & realign & replace");
  var skills = load("modules/state-skills-build.js");
  var nodes = load("modules/state-nodes.js");
  var prefs = load("modules/prefs.js");
  if (!skills || !nodes || !prefs) { h.expect("精确放置节点可加载", false, "require failed"); return; }
  h.expect("节点经 state-nodes 统一派发可查到实现",
    skills.has("place_block_exact") === true && typeof skills.pick("place_block_exact") === "function" &&
    typeof nodes.execute === "function" && nodes.NAMES.indexOf("place_block_exact") >= 0, "dispatch");
  prefs.save({ engExactBuild: true });
  var bot = fakeExactBot();
  var res = await skills.HANDLERS.place_block_exact({ bot: bot }, {
    x: 5, y: 64, z: 0, block: "oak_stairs",
    props: { facing: "north", half: "top" }, maxRetries: 2
  });
  h.expect("属性不符时先 bot.dig 破坏，换放置面后重放并读回校验通过",
    res.ok === true && res.attempts === 2 && res.dug === 1 && res.realigned === 1 &&
    res.verified === true && res.face !== "north", JSON.stringify(res));
  var st = bot.state();
  h.expect("真调用 bot.dig / bot.placeBlock / bot.lookAt 且重调视线",
    st.digs === 1 && st.places === 2 && st.looks >= 2 && st.placed.facing === "north",
    JSON.stringify(st));
  var noBot = await skills.HANDLERS.place_block_exact({}, { x: 1, y: 2, z: 3, block: "stone" });
  h.expect("无 bot 时安全失败不抛异常", noBot.ok === false && noBot.message.indexOf("bot not ready") >= 0, JSON.stringify(noBot));
  prefs.save({ engExactBuild: false });
}
// 20h：红石材料缺失自动公屏发帖（AI 工具链 + 蜂群缺料路径）。
async function checkSupply(h) {
  h.section("20h. 红石缺料自动发帖 / auto help post");
  var supply = load("modules/redstone-supply.js");
  var ai = load("modules/builder-ai-tools.js");
  var tools = load("modules/ai-tools.js");
  var sw = load("modules/builder-swarm.js");
  var prefs = load("modules/prefs.js");
  if (!supply || !ai || !tools || !sw || !prefs) { h.expect("缺料发帖四模块可加载", false, "require failed"); return; }
  supply.reset();
  sw.reset();
  h.expect("AI 工具菜单仍注入 create_blueprint 与 broadcast_post",
    ai.TOOL_NAMES.length === 2 && ai.isTool("create_blueprint") === true && ai.isTool("broadcast_post") === true,
    "tools");
  h.expect("repeater / comparator 判定为红石元件，oak_planks 不是",
    supply.isRedstone("minecraft:repeater") === true && supply.isRedstone("comparator") === true &&
    supply.isRedstone("oak_planks") === false, "detect");
  var list = supply.normalize("repeater:10,comparator:2");
  h.expect("缺料文本清单归一化成带中文名的两项",
    list.length === 2 && list[0].count === 10 && list[0].label === "中继器" && list[1].count === 2,
    JSON.stringify(list));
  var post = supply.composePost({ repeater: 10 });
  h.expect("生成「谁有 10 个中继器，我用钻石换！」式双语求助帖",
    post.ok === true && post.redstone === true && post.content.indexOf("谁有 10 个中继器，我用钻石换！") === 0 &&
    post.content.indexOf("Need 10 repeaters") > 0, post.content);
  var mixed = supply.composePost({ repeater: 10, oak_planks: 32 });
  h.expect("红石与建筑材料混合缺料合并成一帖",
    mixed.content.indexOf("中继器") > 0 && mixed.content.indexOf("橡木木板") > 0, mixed.content);
  var b = fakeBoard();
  var sent = supply.postForMissing({ repeater: 10 }, { board: b, botId: "p10-ai" });
  h.expect("自动发帖真写黑板 broadcast:<postId>",
    sent.ok === true && sent.postId.length > 0 && sent.redstone === true &&
    !!b.data["broadcast:" + sent.postId], JSON.stringify(sent));
  var oldAi = prefs.getAll().aiCode === true;
  prefs.save({ aiCode: true });
  var viaTool = ai.execute("broadcast_post", { content: "", missing: { comparator: 2 }, board: b, botId: "p10-ai" });
  h.expect("AI 只给 missing 对象时自动生成帖子并走 broadcast_post",
    viaTool.ok === true && viaTool.missingPost === true && viaTool.post.content.indexOf("2 个比较器") > 0,
    JSON.stringify({ ok: viaTool.ok, content: viaTool.post && viaTool.post.content }));
  var viaAiTools = await tools.executeTool(null, "broadcast_post",
    { content: "", missing: { piston: 4 }, board: b });
  h.expect("ai-tools 统一入口也能把缺料清单补成求助帖",
    viaAiTools.indexOf("已发帖") === 0 && viaAiTools.indexOf("活塞") > 0, viaAiTools);
  prefs.save({ aiCode: oldAi });
  var b2 = fakeBoard();
  b2.postTask({ title: "build:place", priority: 5,
    payload: { block: "repeater", pos: { x: 1, y: 64, z: 0 }, jobId: "j-p10" } });
  var tick = sw.builderTick("builder-p10", {}, { board: b2, askHelp: true });
  h.expect("蜂群建筑缺料时自动在公屏发红石中文求助帖",
    tick.waiting === true && !!tick.demand && !!tick.demand.helpPost &&
    tick.demand.helpPost.post.content.indexOf("谁有 1 个中继器，我用钻石换！") === 0 &&
    tick.demand.helpPost.post.kind === "help", JSON.stringify(tick.demand && tick.demand.helpPost));
  h.expect("缺料同时挂求购单与采集任务",
    !!b2.data["demand:builder-p10"] && b2.listTasks({ status: "pending" })
      .filter(function (t) { return t.title === sw.TASK_GATHER; }).length === 1, "demand & gather");
  h.expect("缺料发帖统计累计正确", supply.stats().posted >= 1 && supply.stats().composed >= 3,
    JSON.stringify(supply.stats()));
}
// 20i：GUI 动作面板双控件与双语词条接线。
function checkGui(h) {
  h.section("20i. GUI 动作面板双控件 / precision panel");
  var html = readRel("gui/renderer/settings.html");
  var panel = readRel("gui/renderer/panel-precision.js");
  var app = readRel("gui/renderer/app.js");
  var lang = readRel("gui/renderer/lang.js");
  var css = readRel("gui/renderer/style.css");
  h.expect("动作面板内加入精确开关与红石频率滑块 / 数字框",
    html.indexOf("precisionPane") >= 0 && html.indexOf("precisionExactToggle") >= 0 &&
    html.indexOf("precisionTickRange") >= 0 &&     html.indexOf("precisionTickNumber") >= 0 &&
    html.indexOf('data-settings-pane="action"') >= 0, "index.html");
  h.expect("面板脚本按序加载", html.indexOf("panel-precision.js") > html.indexOf("panel-engine.js") &&
    html.indexOf("panel-precision.js") < html.indexOf("app.js"), "script order");
  h.expect("控件频率范围与默认值 10~1000 / 50ms 对齐 prefs",
    html.indexOf('min="10" max="1000" step="10" value="50"') >= 0, "range");
  h.expect("面板走 paramSet 真 IPC 并本地派发自定义事件实时广播",
    panel.indexOf("window.api.paramSet") >= 0 && panel.indexOf("CustomEvent") >= 0 &&
    panel.indexOf("engine.changed") >= 0 && panel.indexOf("param.changed") >= 0, "panel-precision.js");
  h.expect("面板 save / fill / stats / KEYS 接口齐全",
    panel.indexOf("function save(") >= 0 && panel.indexOf("function fill(") >= 0 &&
    panel.indexOf("function stats(") >= 0 && panel.indexOf("redstoneTickRate") >= 0, "api");
  h.expect("app.js 初始化面板并用 prefs 回包同步两处控件",
    app.indexOf("window.panelPrecision.init()") >= 0 && app.indexOf("window.panelPrecision.fill(data)") >= 0,
    "app.js");
  h.expect("中英双字典都加入精准面板词条",
    lang.indexOf("precisionTitle") >= 0 && lang.indexOf("precisionTickUnit") >= 0 &&
    lang.indexOf("Precision & Redstone") >= 0 && lang.indexOf("精准模式与红石频率") >= 0, "lang.js");
  h.expect("样式表补齐精准面板布局",
    css.indexOf(".precision-pane") >= 0 && css.indexOf(".precision-row") >= 0, "style.css");
}
// 主流程：依次跑全部分组；任一组抛错只记一条失败，不让整轮自检崩。
async function run(h) {
  var prefs = load("modules/prefs.js");
  var saved = prefs ? prefs.getAll() : {};
  try { checkStatic(h); } catch (e1) { h.expect("20a 未抛错", false, String(e1)); }
  try { checkPrefs(h); } catch (e2) { h.expect("20b 未抛错", false, String(e2)); }
  try { checkInspector(h); } catch (e3) { h.expect("20c 未抛错", false, String(e3)); }
  try { await checkTrigger(h); } catch (e4) { h.expect("20d 未抛错", false, String(e4)); }
  try { await checkLogistics(h); } catch (e5) { h.expect("20e 未抛错", false, String(e5)); }
  try { checkHighdim(h); } catch (e6) { h.expect("20f 未抛错", false, String(e6)); }
  try { await checkExactSkill(h); } catch (e7) { h.expect("20g 未抛错", false, String(e7)); }
  try { await checkSupply(h); } catch (e8) { h.expect("20h 未抛错", false, String(e8)); }
  try { checkGui(h); } catch (e9) { h.expect("20i 未抛错", false, String(e9)); }
  // 收尾：把本轮动过的偏好键与触发器恢复原状，绝不把测试状态留给后续分组或真实 state/。
  try {
    if (prefs) prefs.save({
      engExactBuild: saved.engExactBuild === true,
      redstoneTickRate: Number(saved.redstoneTickRate) || 50,
      aiCode: saved.aiCode === true
    });
    var trig = load("modules/redstone-trigger.js");
    if (trig) trig.stopAll();
    var supply = load("modules/redstone-supply.js");
    if (supply) supply.reset();
  } catch (e10) { h.expect("P10 收尾恢复成功", false, String(e10)); }
}
module.exports = { run: run };
