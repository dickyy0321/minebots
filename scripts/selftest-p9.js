// ========================================
// 文件：scripts/selftest-p9.js
// 功能：P9 回归自测——精确建筑 engExactBuild / JSON 与 .schem 蓝图算账拆单 / 脚手架搭拆回收 /
//       AI 自主生成蓝图与公屏发帖工具链 / 蜂群建筑物流多 Bot 分工 / 命令化 / 前序全系统回归
// 依赖：path、fs、zlib、prismarine-nbt；../modules/builder-*、../modules/ai-tools、../modules/prefs、
//       ../modules/motion、../modules/engine-control、../modules/swarm-command（都可选）
// 导出：run（由 scripts/selftest-p5.js 调用，复用它的 section / expect）
// 作者：MineBots
// ========================================
// 说明 / note：全程不联网、不碰真实 state/；黑板一律用内存假板注入，prefs 改动在收尾恢复。
var path = require("path");
var fs = require("fs");
var os = require("os");
var zlib = require("zlib");
var ROOT = path.join(__dirname, "..");

// 按相对路径安全 require 一个模块；缺失或抛错时返回 null（不拖垮整轮自检）。
function load(rel) {
  try { return require(path.join(ROOT, rel)); } catch (e) { return null; }
}
// 读一个项目文件的文本；读不到返回空串。
function readRel(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch (e) { return ""; }
}
// 造一个内存黑板：实现建筑 / 物流闭环需要的全部接口，绝不写盘、绝不联网。
function fakeBoard() {
  var tasks = {}, data = {}, messages = {}, seq = 0;
  var b = {
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
    postSupply: function (botId, items, position) {
      var key = "supply:" + botId;
      var rec = data[key] || { botId: botId, items: {}, position: position };
      for (var k in items) {
        if (!Object.prototype.hasOwnProperty.call(items, k)) continue;
        rec.items[k] = (Number(rec.items[k]) || 0) + Number(items[k]);
      }
      data[key] = rec;
      return { ok: true, botId: botId, items: rec.items, message: "supply posted / 供给已发布" };
    },
    matchSupply: function () {
      var out = { ok: true, matches: 0, taskIds: [], message: "supply matched / 供需已撮合" };
      var demandKeys = [], supplyKeys = [], i = 0, j = 0;
      for (var k in data) {
        if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
        if (k.indexOf("demand:") === 0) demandKeys.push(k);
        if (k.indexOf("supply:") === 0) supplyKeys.push(k);
      }
      for (i = 0; i < demandKeys.length; i++) {
        for (j = 0; j < supplyKeys.length; j++) {
          var need = data[demandKeys[i]].items || {}, offer = data[supplyKeys[j]].items || {};
          for (var item in need) {
            if (!Object.prototype.hasOwnProperty.call(need, item)) continue;
            if (Number(offer[item]) < Number(need[item])) continue;
            var posted = b.postTask({ title: "haul", priority: 8,
              payload: { action: "haul", item: item, amount: Number(need[item]),
                fromBot: data[supplyKeys[j]].botId, toBot: data[demandKeys[i]].botId, from: data[supplyKeys[j]].position } });
            if (posted.ok) { out.taskIds.push(posted.taskId); out.matches = out.matches + 1; }
          }
        }
      }
      return out;
    },
    claimHaul: function (botId) {
      var pending = b.listTasks({ status: "pending" });
      for (var i = 0; i < pending.length; i++) {
        if (pending[i].title !== "haul") continue;
        var claim = b.claimTask(botId, { taskId: pending[i].id });
        if (claim.ok) return { ok: true, taskId: claim.taskId, task: claim.task, message: "haul claimed / 搬运任务已抢到" };
      }
      return { ok: false, message: "no haul task / 暂无搬运任务" };
    },
    deliver: function (botId, taskId, items) {
      var warehouse = {};
      for (var item in items) {
        if (!Object.prototype.hasOwnProperty.call(items, item)) continue;
        var key = "warehouse:" + item;
        data[key] = (Number(data[key]) || 0) + Number(items[item]);
        warehouse[item] = data[key];
      }
      b.completeTask(taskId);
      return { ok: true, botId: botId, taskId: taskId, warehouse: warehouse, message: "delivered / 物资已入库" };
    },
    taskStats: function () {
      var out = { total: 0, pending: 0, claimed: 0, done: 0 };
      for (var k in tasks) {
        if (!Object.prototype.hasOwnProperty.call(tasks, k)) continue;
        out.total = out.total + 1;
        if (out[tasks[k].status] !== undefined) out[tasks[k].status] = out[tasks[k].status] + 1;
      }
      return out;
    },
    ecosystem: function () { return { ok: true, pending: b.taskStats().pending }; }
  };
  return b;
}
// 造一个 Sponge .schem 的 gzip NBT（2x2x1，含空气 / 石头 / 木板），返回 Buffer。
function makeSchem() {
  var nbt = null;
  try { nbt = require("prismarine-nbt"); } catch (e) { return null; }
  try {
    var root = { type: "compound", name: "Schematic", value: {
      Schematic: { type: "compound", value: {
        Width: { type: "short", value: 2 }, Height: { type: "short", value: 2 }, Length: { type: "short", value: 1 },
        Palette: { type: "compound", value: {
          "minecraft:air": { type: "int", value: 0 }, "minecraft:stone": { type: "int", value: 1 },
          "minecraft:oak_planks": { type: "int", value: 2 } } },
        Blocks: { type: "byteArray", value: [0, 1, 0, 2] }
      } }
    } };
    return zlib.gzipSync(nbt.writeUncompressed(root));
  } catch (e) { return null; }
}
// 测试用蓝图：3 个方块，两种材料，带一个显式放置面。
function sampleBlueprint() {
  return { name: "hut", origin: { x: 10, y: 64, z: 20 },
    blocks: [{ x: 0, y: 0, z: 0, block: "oak_planks" },
      { x: 1, y: 0, z: 0, block: "stone", face: "north" },
      { x: 1, y: 1, z: 0, block: "oak_planks" }] };
}

// 19a：新模块静态红线 + 接线点一致性。
function checkStatic(h) {
  h.section("19a. 建筑生态静态红线 / build ecosystem red lines");
  var files = ["modules/builder-blueprint.js", "modules/builder-scaffold.js",
    "modules/builder-swarm.js", "modules/builder-ai-tools.js", "scripts/selftest-p9.js"];
  var bannedOptional = "?" + ".";
  var bannedNullish = "?" + "?";
  var bannedArrow = "=" + ">";
  var allGood = true, bad = [];
  for (var i = 0; i < files.length; i++) {
    var text = readRel(files[i]);
    var ok = text.length > 0 && text.indexOf("// ====") === 0 &&
      text.split("\n").length <= 600 && text.indexOf("module.exports") >= 0 &&
      text.indexOf(bannedOptional) < 0 && text.indexOf(bannedNullish) < 0 &&
      text.indexOf(bannedArrow) < 0 && text.indexOf(" / ") >= 0;
    if (!ok) { allGood = false; bad.push(files[i]); }
  }
  h.expect("5 个新文件全部通过头注释 / 行数 / 禁用语法 / 双语检查", allGood, bad.join(","));
  var bp = load("modules/builder-blueprint.js");
  var sc = load("modules/builder-scaffold.js");
  var sw = load("modules/builder-swarm.js");
  var ai = load("modules/builder-ai-tools.js");
  h.expect("四个建筑模块都能 require", !!bp && !!sc && !!sw && !!ai, "");
  h.expect("blueprint 导出解析 / 算账 / 拆单",
    !!bp && ["parse", "fromJson", "fromSchem", "analyzeBlueprint", "buildTasks", "splitBlueprintToTasks"].every(function (k) { return typeof bp[k] === "function"; }), "exports");
  h.expect("scaffold 导出计划 / 搭建 / 拆除回收",
    !!sc && ["plan", "build", "recycle", "run"].every(function (k) { return typeof sc[k] === "function"; }), "exports");
  h.expect("swarm 导出开工 / 三种 tick / 协作 / 发帖",
    !!sw && ["startBuild", "builderTick", "logisticsTick", "gatherTick", "runCycle", "post"].every(function (k) { return typeof sw[k] === "function"; }), "exports");
  h.expect("AI 工具导出开关 / 定义 / 执行 / 生成",
    !!ai && ["enabled", "definitions", "isTool", "execute", "generateBlueprint"].every(function (k) { return typeof ai[k] === "function"; }), "exports");
  var wiring = [
    ["modules/prefs.js", "engExactBuild"], ["modules/engine-control.js", "exactBuild"],
    ["modules/motion.js", "isExactBuild"], ["modules/ai-tools.js", "builder-ai-tools"],
    ["modules/swarm-command.js", "BUILD_COMMANDS"], ["gui/renderer/panel-engine.js", "engExactBuild"]];
  var wired = true;
  for (var w = 0; w < wiring.length; w++) if (readRel(wiring[w][0]).indexOf(wiring[w][1]) < 0) wired = false;
  h.expect("六处接线点齐全（prefs / 引擎中心 / motion / ai-tools / 命令 / 专家面板）", wired, "wiring");
  h.expect("文件头与函数注释齐全（中英双语说明）",
    readRel("modules/builder-blueprint.js").indexOf("CommonJS，ES5 风格") >= 0 &&
    readRel("modules/builder-swarm.js").indexOf("三层分工") >= 0, "comments");
}

// 19b：engExactBuild 开启后所有噪声 / 手抖 / 随机延迟归零，关闭后完全恢复。
async function checkExact(h) {
  h.section("19b. 精确建筑 engExactBuild / zero-noise exact build");
  var prefs = load("modules/prefs.js");
  var engines = load("modules/engine-control.js");
  var motion = load("modules/motion.js");
  if (!prefs || !engines || !motion) { h.expect("精确建筑三模块可加载", false, "require failed"); return; }
  h.expect("engExactBuild 默认关闭（不破坏默认拟真）", prefs.DEFAULTS.engExactBuild === false, "default");
  h.expect("prefs 会清洗 engExactBuild 布尔值",
    prefs.save({ engExactBuild: true }).ok === true && prefs.get("engExactBuild") === true, "save");
  h.expect("控制中心 exactBuild() 实时读到开启", engines.exactBuild() === true, "");
  h.expect("七大引擎注册表数量不变（仍是 7 个）", engines.status().length === 7, "engines");
  var cfg = motion.getConfig();
  h.expect("精确模式配置：拟真关闭 / 强度 0 / 延迟 0",
    cfg.exactBuild === true && cfg.enabled === false && cfg.sigma === 0 && cfg.strength === 0 && cfg.delayMs === 0, JSON.stringify(cfg));
  h.expect("高斯噪声绝对归零", motion.clampedNoise(1) === 0, "");
  var pt = motion.noisyPoint({ x: 1, y: 2, z: 3 }, 0.5);
  h.expect("坐标抖动归零（毫米级精确）", pt.x === 1 && pt.y === 2 && pt.z === 3, JSON.stringify(pt));
  h.expect("随机动作延迟归零", motion.humanDelayMs(100, 100) === 0, "");
  var waited = await motion.humanDelay(100, 100);
  h.expect("humanDelay 等待毫秒数也归零", waited === 0, String(waited));
  var jit = motion.startDigJitter(null, {});
  h.expect("挖掘手抖定时器在精确模式不启动", jit.count() === 0 && jit.stop() === 0, "");
  var dodge = motion.localDodge(null, {});
  h.expect("本地闪避抖动值归零", dodge.jitter === 0, JSON.stringify(dodge));
  var fakeBot = { lookAt: function () { return Promise.resolve(); }, entity: { position: { x: 0, y: 64, z: 0 } } };
  var looked = await motion.smoothLookAt(fakeBot, { x: 1, y: 65, z: 1 }, 8, {});
  h.expect("精确模式视线一步瞬时对准（零过渡）", looked.ok === true && looked.steps === 1, JSON.stringify(looked));
  h.expect("motion.isExactBuild 与开关同步", motion.isExactBuild() === true, "");
  prefs.save({ engExactBuild: false });
  var back = motion.getConfig();
  h.expect("关闭后拟真完全恢复（原特性未破坏）",
    back.exactBuild === false && back.enabled === true && back.strength > 0 && back.delayMs > 0, JSON.stringify(back));
}

// 19c：JSON / .schem 蓝图解析、算账、微观任务拆分精度。
function checkBlueprint(h) {
  h.section("19c. 蓝图解析与精确算账 / blueprint parse & bill");
  var bp = load("modules/builder-blueprint.js");
  if (!bp) { h.expect("builder-blueprint 可加载", false, "require failed"); return; }
  bp.reset();
  var parsed = bp.parse(sampleBlueprint());
  h.expect("JSON 对象蓝图解析成功", parsed.ok === true && parsed.blueprint.blocks.length === 3, parsed.message);
  var text = bp.parse(JSON.stringify(sampleBlueprint()));
  h.expect("JSON 文本蓝图解析成功", text.ok === true && text.blueprint.format === "json", text.message);
  var dirty = bp.parse("好的，这是代码：" + JSON.stringify(sampleBlueprint()) + " 谢谢 / thanks");
  h.expect("前后带废话的 AI 蓝图也能解析（五级修复）", dirty.ok === true && dirty.blueprint.blocks.length === 3, dirty.message);
  var compact = bp.parse({ name: "compact", palette: ["stone", "oak_planks"],
    data: [[0, 0, 0, 0], [1, 0, 0, 1], [2, 0, 0, 1]] });
  h.expect("palette + data 紧凑格式能解析", compact.ok === true && compact.blueprint.blocks.length === 3, compact.message);
  var bill = bp.analyzeBlueprint(parsed.blueprint, { oak_planks: 1 });
  h.expect("总材料清单精确（oak_planks 2 / stone 1）",
    bill.total.oak_planks === 2 && bill.total.stone === 1 && bill.totalCount === 3, JSON.stringify(bill.total));
  h.expect("缺失清单精确（各缺 1，共缺 2）",
    bill.missing.oak_planks === 1 && bill.missing.stone === 1 && bill.missingCount === 2 && bill.sufficient === false, JSON.stringify(bill.missing));
  var full = bp.analyzeBlueprint(parsed.blueprint, { oak_planks: 2, stone: 1 });
  h.expect("材料齐备时 sufficient=true 且缺失为 0", full.sufficient === true && full.missingCount === 0, "sufficient");
  var b = fakeBoard();
  var split = bp.splitBlueprintToTasks(parsed.blueprint, { board: b, priority: 7 });
  h.expect("拆单数量与方块数一致且 jobId 非空", split.ok === true && split.count === 3 && split.jobId.length > 0, JSON.stringify(split.count));
  h.expect("三条微观任务真的压进了黑板任务池", b.listTasks({ status: "pending" }).length === 3, "board tasks");
  var t0 = split.tasks[0];
  h.expect("微观任务带绝对坐标（origin 叠加正确）",
    t0.pos.x === 10 && t0.pos.y === 64 && t0.pos.z === 20, JSON.stringify(t0.pos));
  h.expect("微观任务带方块名 / 放置面 / 支撑点 / role",
    t0.block === "oak_planks" && t0.face === "up" && t0.support.y === 63 && t0.role === "builder", JSON.stringify(t0));
  var t1 = split.tasks[1];
  h.expect("蓝图显式 face 被保留（north）", t1.face === "north" && t1.pos.x === 11, JSON.stringify(t1));
  h.expect("每条任务都带同一 jobId 便于多 Bot 分工", split.tasks[1].jobId === split.jobId && split.tasks[2].jobId === split.jobId, "jobId");
  h.expect("bad input 不抛错、只回 ok:false", bp.parse("abc", {}).ok === false, "");
  h.expect("空蓝图不会拆出任务", bp.splitBlueprintToTasks({ blocks: [] }, { board: b }).ok === false, "");
  h.expect("统计快照记录了解析与拆单", bp.stats().parsed >= 4 && bp.stats().split >= 1, JSON.stringify(bp.stats()));
  var gz = makeSchem();
  var schem = bp.fromSchem(gz);
  h.expect("真实 gzip + NBT 的 .schem 能解析（Sponge Palette / Blocks）",
    schem.ok === true && schem.blueprint.format === "schem" && schem.blueprint.blocks.length === 2, schem.message);
  if (schem.ok) {
    h.expect("schem 方块名去掉 minecraft: 前缀且跳过空气",
      schem.blueprint.blocks[0].block === "stone" && schem.blueprint.blocks[1].block === "oak_planks",
      JSON.stringify(schem.blueprint.blocks));
    h.expect("schem 尺寸与坐标按 (y,z,x) 还原",
      schem.blueprint.size.width === 2 && schem.blueprint.size.height === 2 &&
      schem.blueprint.blocks[1].x === 1 && schem.blueprint.blocks[1].y === 1, JSON.stringify(schem.blueprint.blocks[1]));
  }
  h.expect("坏 .schem 缓冲只回 ok:false 不抛错", bp.fromSchem(Buffer.from([1, 2, 3])).ok === false, "");
}

// 19d：高处自动搭脚手架，建完拆除并把材料挂回供给单。
function checkScaffold(h) {
  h.section("19d. 脚手架自动搭拆回收 / auto scaffold & recycle");
  var bp = load("modules/builder-blueprint.js");
  var sc = load("modules/builder-scaffold.js");
  if (!bp || !sc) { h.expect("脚手架模块可加载", false, "require failed"); return; }
  sc.reset();
  var tall = bp.parse({ name: "tower", origin: { x: 0, y: 64, z: 0 },
    blocks: [{ x: 0, y: 10, z: 0, block: "stone" }, { x: 0, y: 12, z: 0, block: "stone" }] }).blueprint;
  var plan = sc.plan(tall, { baseY: 64, maxReach: 3, block: "dirt" });
  h.expect("过高目标判定需要脚手架", plan.ok === true && plan.needed === 2 && plan.maxY === 76, JSON.stringify(plan.needed));
  h.expect("支撑块落在目标正下方（可达高度内）",
    plan.scaffolds[0].pos.y === 73 && plan.scaffolds[1].pos.y === 75, JSON.stringify(plan.scaffolds));
  h.expect("成本清单精确统计临时方块", plan.cost.dirt === 2, JSON.stringify(plan.cost));
  var low = bp.parse(sampleBlueprint()).blueprint;
  h.expect("可达范围内的目标不需要脚手架（不浪费材料）", sc.plan(low, { baseY: 64, maxReach: 3 }).needed === 0, "");
  var b = fakeBoard();
  var built = sc.build(plan, { board: b });
  h.expect("脚手架搭建任务真的排进任务池", built.ok === true && built.count === 2, JSON.stringify(built));
  var scaffoldTasks = b.listTasks({ status: "pending" });
  h.expect("脚手架优先级高于正式放置任务", scaffoldTasks[0].priority > 7, String(scaffoldTasks[0].priority));
  var rec = sc.recycle(plan, { board: b, botId: "scaffold-bot" });
  h.expect("建完后拆除任务全部发布", rec.ok === true && rec.count === 2, JSON.stringify(rec.count));
  h.expect("拆除材料被统计回收（dirt x2）", rec.recycled.dirt === 2, JSON.stringify(rec.recycled));
  h.expect("回收材料挂到供给单，不丢失", !!rec.supply && rec.supply.ok === true && b.data["supply:scaffold-bot"].items.dirt === 2, "supply");
  var run = sc.run(tall, { board: fakeBoard(), baseY: 64, maxReach: 3 });
  h.expect("一站式 run 返回计划 / 搭建 / 待拆回收", run.ok === true && run.plan.needed === 2 && run.recycle.pending === 2, run.message);
}

// 19e：AI 编程开关 / 蓝图生成工具链 / 公屏发帖工具。
async function checkAiTools(h) {
  h.section("19e. AI 自主编程与社交发帖 / AI blueprint & broadcast");
  var prefs = load("modules/prefs.js");
  var ai = load("modules/builder-ai-tools.js");
  var tools = load("modules/ai-tools.js");
  if (!prefs || !ai || !tools) { h.expect("AI 工具三模块可加载", false, "require failed"); return; }
  ai.reset();
  prefs.save({ aiCode: false });
  h.expect("开关关闭时实验工具不出现在菜单", ai.enabled() === false && ai.definitions().length === 0, "");
  h.expect("开关关闭时既有 14 个工具完全不变", tools.getTools().length === 14 && tools.TOOL_NAMES.length === 14, "");
  prefs.save({ aiCode: true });
  var defs = ai.definitions();
  h.expect("开关开启后注入 2 个工具定义", ai.enabled() === true && defs.length === 2, "");
  h.expect("工具名是 create_blueprint 与 broadcast_post",
    defs[0].function.name === "create_blueprint" && defs[1].function.name === "broadcast_post", "");
  h.expect("工具定义符合 OpenAI function schema 规范", defs[0].type === "function" && defs[0].function.parameters.required[0] === "prompt", "");
  h.expect("getTools 变 16 个且 owner 全部可见", tools.getTools().length === 16 && tools.filterTools("owner").length === 16, "");
  h.expect("实验工具只给完全信任玩家，friend 被拒",
    tools.toolAllowed("owner", "create_blueprint") === true && tools.toolAllowed("friend", "broadcast_post") === false, "permission");
  var tpl = ai.templateBlueprint("造个小木屋");
  h.expect("内置模板是合法精确 JSON 蓝图", bpParseOk(tpl), "template");
  h.expect("塔 / 墙关键词生成不同结构",
    JSON.parse(ai.templateBlueprint("tower")).name === "tower" && JSON.parse(ai.templateBlueprint("wall")).name === "wall", "");
  // 注入一个故意吐脏 JSON 的假 AI：Markdown 围栏 + 尾随逗号，验证五级修复真的接在链路里。
  ai.setGenerator(function () { return "```json\n" + JSON.stringify(sampleBlueprint()).replace(/\}$/, ",\n}") + "\n```"; });
  var made = ai.generateBlueprint("造个带脏 JSON 的小屋");
  h.expect("AI 吐 Markdown 围栏 + 尾随逗号仍被五级修复救回", made.ok === true && made.blueprint.blocks.length === 3, made.message);
  var b = fakeBoard();
  var created = ai.createBlueprint("造个小木屋", { board: b, botId: "ai-1" });
  h.expect("create_blueprint 生成蓝图并移交建筑任务池",
    created.ok === true && created.blocks === 3 && created.tasks === 3 && created.jobId.length > 0, JSON.stringify(created));
  h.expect("生成的蓝图在三层架构里下达了战略目标", !!created.goal && created.goal.ok === true, JSON.stringify(created.goal));
  h.expect("任务池里确实有 3 条放置任务", b.listTasks({ status: "pending" }).length >= 3, "tasks");
  var viaTools = await tools.executeTool(null, "create_blueprint", { prompt: "造个塔", board: b, botId: "ai-2" });
  h.expect("ai-tools 统一入口真执行实验工具且回执带蓝图摘要",
    viaTools.indexOf("蓝图已生成") === 0 && viaTools.indexOf("tasks=") > 0, viaTools);
  var postHit = ai.broadcastPost("缺木材，求助 / need wood, help", { board: b, botId: "ai-1", kind: "help" });
  h.expect("broadcast_post 发帖成功并写进黑板", postHit.ok === true && postHit.postId.length > 0 && !!b.data["broadcast:" + postHit.postId], "");
  var viaPost = await tools.executeTool(null, "broadcast_post", { content: "承接代工 / build service", kind: "offer", board: b, botId: "ai-2" });
  h.expect("发帖工具经 ai-tools 入口回执带帖子 id", viaPost.indexOf("已发帖") === 0 && viaPost.indexOf("posted: p") > 0, viaPost);
  h.expect("帖子列表累计两条且带 kind", ai.posts().length >= 2 && ai.posts()[0].kind === "help", JSON.stringify(ai.posts().length));
  h.expect("未知工具安全拒绝、绝不抛错", ai.execute("no_such_tool", {}).ok === false, "");
  ai.setGenerator(null);
  ai.reset();
  prefs.save({ aiCode: false });
  h.expect("收尾关闭开关后菜单恢复 14 个", tools.getTools().length === 14, "");
}
// 判断一段模板文本能否被解析成含方块的 JSON（不依赖 builder-blueprint，避免循环）。
function bpParseOk(text) {
  try { var o = JSON.parse(text); return !!(o && Array.isArray(o.blocks) && o.blocks.length > 0); }
  catch (e) { return false; }
}

// 19f：建筑 / 物流 / 采集三类 bot 的完整协作闭环。
function checkSwarm(h) {
  h.section("19f. 蜂群建筑物流协作 / swarm build logistics");
  var bp = load("modules/builder-blueprint.js");
  var sw = load("modules/builder-swarm.js");
  if (!bp || !sw) { h.expect("蜂群建筑模块可加载", false, "require failed"); return; }
  sw.reset();
  var b = fakeBoard();
  var started = sw.startBuild(sampleBlueprint(), { board: b, botId: "builder-1", inventory: {} });
  h.expect("三层架构一站式开工成功", started.ok === true && started.layer === "strategic", started.message);
  h.expect("开工把蓝图拆成 3 条放置任务", started.split && started.split.count === 3, JSON.stringify(started.split));
  h.expect("开工在战略层下达了宏观目标", !!started.goal && started.goal.ok === true, JSON.stringify(started.goal));
  h.expect("材料耗尽自动调度挖矿 / 砍树采集任务",
    !!started.shortage && started.shortage.ok === true && started.shortage.count === 2, JSON.stringify(started.shortage));
  var wait = sw.builderTick("builder-1", {}, { board: b });
  h.expect("建筑 bot 没方块时进入等待并挂求购单",
    wait.ok === false && wait.waiting === true && !!b.data["demand:builder-1"], JSON.stringify(wait));
  h.expect("缺料自动在公屏发求助帖", sw.posts().length >= 1 && sw.posts()[0].kind === "help", "help post");
  var gather1 = sw.gatherTick("miner-1", { board: b });
  var gather2 = sw.gatherTick("miner-1", { board: b });
  h.expect("采集 bot 抢单补齐材料并入库",
    gather1.ok === true && gather2.ok === true && !!gather1.warehouse, JSON.stringify([gather1.item, gather2.item]));
  h.expect("采集物资挂了供给单供撮合", !!b.data["supply:miner-1"], "supply");
  var matched = b.matchSupply();
  h.expect("供需撮合生成 haul 搬运单", matched.matches >= 1, JSON.stringify(matched));
  var logi = sw.logisticsTick("hauler-1", { board: b });
  h.expect("物流 bot 抢单取货并送达入库", logi.ok === true && logi.taskId.length > 0, JSON.stringify(logi));
  var notified = false;
  for (var key in b.messages) if (b.messages[key].length > 0) notified = true;
  h.expect("送达后通知建筑工（送到手上）", notified === true || logi.notified === true, "messages");
  var placed = sw.builderTick("builder-1", { oak_planks: 5, stone: 5 }, { board: b });
  h.expect("有料的建筑 bot 精确完成一个放置任务", placed.ok === true && placed.block.length > 0, JSON.stringify(placed));
  var cycle = sw.runCycle({ builders: ["b1", "b2"], logistics: ["l1"], gatherers: ["g1", "g2"] }, { board: b, inventory: { oak_planks: 9, stone: 9 } });
  h.expect("多 Bot 分工一轮同时推进三种角色",
    cycle.ok === true && cycle.builders.length === 2 && cycle.logistics.length === 1 && cycle.gatherers.length === 2, JSON.stringify(cycle.cycles));
  var layers = sw.layers("builder-1");
  h.expect("建筑跑在战略 / 战术 / 反射三层架构内",
    layers.ok === true && layers.strategic !== null && layers.tactical !== null && layers.reflex !== null, JSON.stringify(Object.keys(layers)));
  var offer = sw.post("builder-1", "承接代工 / build service available", { board: b, kind: "offer" });
  h.expect("公屏可接代工生意（offer 帖）", offer.ok === true && offer.post.kind === "offer", "");
  h.expect("状态快照含累计与精确模式标记",
    sw.status().ok === true && sw.status().placed >= 2 && typeof sw.status().exact === "boolean", JSON.stringify(sw.status()));
  h.expect("坏蓝图开工只回 ok:false 不抛错", sw.startBuild("garbage", { board: b }).ok === false, "");
}

// 19g：命令化、参数指令化与前序全系统回归。
async function checkCommands(h) {
  h.section("19g. 命令化与前序全系统回归 / commands & regression");
  var cmd = load("modules/swarm-command.js");
  var prefs = load("modules/prefs.js");
  if (!cmd || !prefs) { h.expect("命令模块可加载", false, "require failed"); return; }
  var list = cmd.list();
  h.expect("命令清单保留前序 20 条并新增建筑指令（共 31 条）", list.length >= 31, String(list.length));
  h.expect("新命令别名可解析（bp / ex / cy）",
    cmd.resolve("bp") === "blueprint" && cmd.resolve("ex") === "exact" && cmd.resolve("cy") === "cycle", "aliases");
  h.expect("前序 20 条命令仍全部可解析",
    ["goal", "tick", "hurt", "status", "nodes", "queue", "replan", "demand", "supply", "match",
      "bigtask", "bid", "auction", "inventory", "claim", "deliver", "ecosystem", "reflex", "reset", "help"]
      .every(function (n) { return cmd.resolve(n) === n; }), "legacy commands");
  var an = await cmd.handle("#analyze 造个墙", { botId: "c1" });
  h.expect("#analyze 回出总材料清单", an.ok === true && !!an.data.total, JSON.stringify(an.data));
  var blue = await cmd.handle("#blueprint 造个桥", { botId: "c1" });
  h.expect("#blueprint 拆单入池", blue.ok === true && blue.data.count > 0, JSON.stringify(blue.data));
  var build = await cmd.handle("#build 造个小木屋", { botId: "c1" });
  h.expect("#build 走三层架构开工并下战略目标", build.ok === true && !!build.data.goal, JSON.stringify(build.message));
  var exOn = await cmd.handle("#exact on", { botId: "c1" });
  h.expect("#exact on 指令真落盘（参数指令化）",
    exOn.ok === true && exOn.data.engExactBuild === true && prefs.get("engExactBuild") === true, "exact on");
  var exOff = await cmd.handle("#exact off", { botId: "c1" });
  h.expect("#exact off 能关回拟真", exOff.ok === true && prefs.get("engExactBuild") === false, "exact off");
  var po = await cmd.handle("#post 求购木材 / need wood kind=help", { botId: "c1" });
  h.expect("#post 公屏发帖可用", po.ok === true && po.data.postId.length > 0, po.message);
  var pts = await cmd.handle("#posts", { botId: "c1" });
  h.expect("#posts 能列出帖子", pts.ok === true && pts.data.count >= 1, JSON.stringify(pts.data));
  var cy = await cmd.handle("#cycle b1,b2", { botId: "c1" });
  h.expect("#cycle 多 Bot 分工可执行", cy.ok === true, cy.message);
  // 前序全系统回归：所有旧特性接口仍在，且新功能没有改写它们。
  var checks = [
    ["modules/state-runtime.js", ["assignGoal", "tick", "onHurt", "status", "insertNodes"]],
    ["modules/context-stack.js", ["push", "freeze", "pop", "snapshot"]],
    ["modules/replan.js", ["aiReplan", "validateCalls", "recordFailure"]],
    ["modules/antiafk.js", ["attach", "simulateHurt", "stats"]],
    ["modules/swarm-market.js", ["postDemand", "matchSupply", "runAuction", "deliver", "ecosystem"]],
    ["modules/event-bus.js", ["on", "emit", "history", "reset"]],
    ["modules/worker-manager.js", ["spawn", "send", "status"]],
    ["modules/radar.js", ["scan", "classify", "isEnabled"]],
    ["modules/goap.js", ["plan", "explain", "resolveGoal"]],
    ["modules/behavior-tree.js", ["create", "tick", "interrupt", "resume"]],
    ["modules/engine-control.js", ["isEnabled", "change", "param", "status"]],
    ["modules/json-repair.js", ["safeParse", "safeParseDetailed"]],
    ["modules/shared-board.js", ["postTask", "claimTask", "completeTask", "ecosystem"]]
  ];
  var intact = true, missing = [];
  for (var i = 0; i < checks.length; i++) {
    var mod = load(checks[i][0]);
    if (!mod) { intact = false; missing.push(checks[i][0]); continue; }
    for (var j = 0; j < checks[i][1].length; j++) {
      if (typeof mod[checks[i][1][j]] !== "function") { intact = false; missing.push(checks[i][0] + ":" + checks[i][1][j]); }
    }
  }
  h.expect("前序 13 个模块的旧接口全部完好（三层 / 上下文栈 / 看门狗 / 竞价 / 总线 / Worker / 雷达 / GOAP / BT / 热更新 / JSON 修复）", intact, missing.join(","));
  var bus = load("modules/event-bus.js");
  var got = [];
  var un = bus.on("blueprint.split", function (p) { got.push(p); });
  bus.emit("blueprint.split", { jobId: "regress" });
  if (un) un();
  h.expect("事件总线仍能订阅建筑事件（新旧特性融合）", got.length === 1 && got[0].jobId === "regress", "bus");
  var eng = load("modules/engine-control.js");
  h.expect("参数热更新仍可真写盘并实时生效",
    eng.change({ engRadar: false }).ok === true && eng.isEnabled("radar") === false &&
    eng.change({ engRadar: true }).ok === true && eng.isEnabled("radar") === true, "hot reload");
  h.expect("中英双语在命令说明与日志中保持",
    list[0].desc.indexOf(" / ") > 0 && readRel("modules/builder-swarm.js").indexOf("日志双语") >= 0, "bilingual");
}

// 主流程：依次跑全部分组；任一分组抛错只记一条失败，不让整轮自检崩。
async function run(h) {
  var prefs = load("modules/prefs.js");
  var saved = prefs ? prefs.getAll() : {};
  // 黑板隔离：state 指向临时目录并热重载，避免历史遗留任务的 1000 条上限把本轮 blueprint/build 发布打满。
  var oldDir = process.env.MINEBOTS_STATE_DIR;
  var tmpDir = path.join(os.tmpdir(), "minebots-p9-" + process.pid);
  var board = null;
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    process.env.MINEBOTS_STATE_DIR = tmpDir;
    board = load("modules/shared-board.js");
    if (board && typeof board.reload === "function") board.reload();
  } catch (eIso) { /* 隔离失败也继续跑 */ }
  try { checkStatic(h); } catch (e1) { h.expect("19a 未抛错", false, String(e1)); }
  try { await checkExact(h); } catch (e2) { h.expect("19b 未抛错", false, String(e2)); }
  try { checkBlueprint(h); } catch (e3) { h.expect("19c 未抛错", false, String(e3)); }
  try { checkScaffold(h); } catch (e4) { h.expect("19d 未抛错", false, String(e4)); }
  try { await checkAiTools(h); } catch (e5) { h.expect("19e 未抛错", false, String(e5)); }
  try { checkSwarm(h); } catch (e6) { h.expect("19f 未抛错", false, String(e6)); }
  try { await checkCommands(h); } catch (e7) { h.expect("19g 未抛错", false, String(e7)); }
  // 收尾：把本轮动过的偏好键恢复原值，并把黑板切回真实 state/，绝不把测试状态留给后续分组。
  try {
    if (prefs) prefs.save({ aiCode: saved.aiCode === true, engExactBuild: saved.engExactBuild === true });
    if (oldDir === undefined) delete process.env.MINEBOTS_STATE_DIR;
    else process.env.MINEBOTS_STATE_DIR = oldDir;
    if (board && typeof board.reload === "function") board.reload();
    try {
      if (fs.existsSync(tmpDir)) fs.readdirSync(tmpDir).forEach(function (n) { try { fs.unlinkSync(path.join(tmpDir, n)); } catch (eU) { /* ignore */ } });
    } catch (eC) { /* ignore */ }
  } catch (e8) { h.expect("偏好恢复成功", false, String(e8)); }
}

module.exports = { run: run };
