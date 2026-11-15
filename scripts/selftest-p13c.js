// ========================================
// 文件：scripts/selftest-p13c.js
// 功能：P13 模块3 回归自测——绝对精准模式 / .litematic 属性朝向解析 / 地形平整入仓 /
//       蓝图旋转镜像与缺失替换 / 自动内饰避柱 / 防熊巡检补块 / 悬浮倒挂脚手架 / /fill 贪心合并
// 依赖：path、fs、os；被测模块（都可选，缺了记失败而不崩）
// 导出：run（由 selftest-p5.js 调用）
// 作者：MineBots
// ========================================
// 说明：全程离线；litematic 用描述式 NBT 对象驱动真解析链，不依赖外部 NBT 库是否安装。
var path = require("path");
var fs = require("fs");
var os = require("os");
var ROOT = path.join(__dirname, "..");
var TEMP_DIR = path.join(os.tmpdir(), "minebots-p13c-" + process.pid);

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
// 造一片 10x10 的石头地板蓝图。
function stoneFloor(n, y) {
  var out = [];
  for (var x = 0; x < n; x++) for (var z = 0; z < n; z++) out.push({ x: x, y: y || 0, z: z, block: "stone" });
  return out;
}
// 造一个带承重柱的小房子（四角柱 + 地板）。
function house() {
  var out = stoneFloor(5, 0);
  var corners = [[0, 0], [4, 0], [0, 4], [4, 4]];
  for (var i = 0; i < corners.length; i++) {
    for (var y = 1; y <= 3; y++) out.push({ x: corners[i][0], y: y, z: corners[i][1], block: "oak_log" });
  }
  return out;
}
// 26a：静态红线与接线。
function checkStatic(h) {
  h.section("26a. 模块3 静态红线 / static");
  var files = ["modules/builder-litematic.js", "modules/builder-terrain.js", "modules/builder-transform.js",
    "modules/builder-interior.js", "modules/builder-patrol.js", "modules/builder-sky.js"];
  var banned = [/\?\./, /\?\?/, /^import\s+/m, /^export\s+/m];
  var ok = true;
  for (var i = 0; i < files.length; i++) {
    var text = readRel(files[i]);
    if (text.length === 0 || text.indexOf("// ====") !== 0 || text.split("\n").length > 600) ok = false;
    for (var j = 0; j < banned.length; j++) if (banned[j].test(text)) ok = false;
  }
  h.expect("6 个建筑新模块满足头注释 / 600 行 / 禁用语法", ok, "");
  h.expect("builder-litematic 委托真 NBT 位解码器而不重复造轮子",
    readRel("modules/builder-litematic.js").indexOf("litematic-codec") > 0, "");
  h.expect("悬浮脚手架复用既有脚手架模块", readRel("modules/builder-sky.js").indexOf("builder-scaffold") > 0, "");
}
// 26b：绝对精准模式 engExactBuild。
function checkExact(h) {
  h.section("26b. 绝对精准模式 / engExactBuild");
  var prefs = load("modules/prefs.js");
  var exact = load("modules/exact-placement.js");
  var micro = load("modules/motion-micro.js");
  if (!prefs || !exact || !micro) { h.expect("精准三模块可加载", false, "null"); return; }
  var old = prefs.load().engExactBuild;
  prefs.save({ engExactBuild: true });
  h.expect("开启 engExactBuild 后精确模式生效", exact.isExact() === true, "");
  h.expect("精确模式把瞄准加速度拉满（3D 打印机式）",
    exact.acceleration() === exact.MAX_ACCELERATION, String(exact.acceleration()));
  micro.reset();
  var walked = micro.walkTick({ yaw: 0, pitch: 0 }, "exact");
  h.expect("精确模式下所有拟真抖动归零", walked.suppressed === true && walked.wandered === false && walked.jumped === false, JSON.stringify(walked));
  var dug = micro.onDigDone({}, "exact");
  h.expect("精确模式下连挖完环视也关闭", dug.steps === 0 && dug.suppressed === true, JSON.stringify(dug));
  prefs.save({ engExactBuild: old === undefined ? false : old });
  micro.reset();
}
// 26c：.litematic 底层解析（属性 + 朝向）。
function checkLitematic(h) {
  h.section("26c. Litematica 属性与朝向 / litematic codec");
  var lm = load("modules/builder-litematic.js");
  if (!lm) { h.expect("builder-litematic 可加载", false, "null"); return; }
  lm.reset();
  var root = { Regions: { House: {
    Position: { x: 10, y: 64, z: 20 }, Size: { x: 3, y: 2, z: 3 },
    Blocks: [
      { x: 0, y: 0, z: 0, block: "minecraft:oak_stairs[facing=west]" },
      { x: 1, y: 0, z: 0, block: "minecraft:repeater[facing=east,delay=2]" },
      { x: 2, y: 1, z: 2, block: "minecraft:stone" }
    ]
  } } };
  var parsed = lm.parse(root, {});
  h.expect("解析出 3 个实体方块与原点 / 尺寸",
    parsed.ok === true && parsed.blocks.length === 3 && parsed.origin.x === 10 && parsed.size.width === 3,
    JSON.stringify({ ok: parsed.ok, blocks: parsed.blocks.length, origin: parsed.origin }));
  h.expect("方块属性被逐项提取（facing / delay）",
    parsed.withProps >= 2 && parsed.blocks[0].props.facing === "west" && parsed.blocks[1].props.delay === "2",
    JSON.stringify(parsed.blocks));
  h.expect("朝向单独成字段且方向正确",
    parsed.facings >= 2 && parsed.blocks[0].facing === "west" && parsed.blocks[1].facing === "east" && parsed.blocks[2].facing === "none",
    JSON.stringify(parsed.blocks));
  h.expect("propertiesOf 兼容 spec 里的中括号状态", lm.propertiesOf({ spec: "minecraft:oak_stairs[facing=north]" }).facing === "north", "");
  h.expect("facingOf 兼容 axis 与无朝向", lm.facingOf({ props: { axis: "y" } }) === "y" && lm.facingOf({}) === "none", "");
  var tasks = lm.toTasks(parsed, {});
  h.expect("解析结果能转成 place_block_exact 建筑任务",
    tasks.ok === true && tasks.count === 3 && tasks.tasks[0].action === "place_block_exact" && tasks.tasks[0].x === 10,
    JSON.stringify(tasks.tasks[0]));
  h.expect("任务保留属性和朝向", tasks.tasks[0].props.facing === "west" && tasks.tasks[0].facing === "west", "");
  h.expect("统计里能查到属性 / 朝向数量", lm.stats().withProps >= 2 && lm.stats().facings >= 2, JSON.stringify(lm.stats()));
}
// 26d：地形平整与材料入仓。
function checkTerrain(h) {
  h.section("26d. 地形平整 / terrain flatten");
  var t = load("modules/builder-terrain.js");
  if (!t) { h.expect("builder-terrain 可加载", false, "null"); return; }
  t.reset();
  var heights = function (x, z) { return x === 0 && z === 0 ? 68 : (x === 1 && z === 0 ? 62 : 65); };
  var est = t.estimate({ x1: 0, x2: 1, z1: 0, z2: 1 }, 65, { heightAt: heights });
  h.expect("估算削方 3 / 填方 3（共 4 列）",
    est.ok === true && est.columns === 4 && est.remove === 3 && est.fill === 3 && est.net === 0, JSON.stringify(est));
  var plan = t.flatten({ x1: 0, x2: 1, z1: 0, z2: 1 }, 65, { heightAt: heights, chest: { x: 9, y: 64, z: 9 } });
  h.expect("削平山头生成 dig_block，填海造陆生成 place_block",
    plan.ok === true && plan.removed === 3 && plan.filled === 3 && plan.tasks.length === 6, JSON.stringify({ r: plan.removed, f: plan.filled }));
  var digs = plan.tasks.filter(function (x) { return x.action === "dig_block"; });
  var fills = plan.tasks.filter(function (x) { return x.action === "place_block"; });
  h.expect("削方坐标在目标高度之上、填方在目标高度之下",
    digs.length === 3 && digs[0].y === 66 && fills.length === 3 && fills[0].block === t.DEFAULT_BLOCK,
    JSON.stringify({ digs: digs[0], fills: fills[0] }));
  h.expect("多余材料自动入仓并生成 chestTransfer 任务",
    plan.storage.length === 1 && plan.storage[0].action === "chestTransfer" && plan.storage[0].count === 3,
    JSON.stringify(plan.storage));
  h.expect("材料按方块名分组", plan.material.dirt === 3, JSON.stringify(plan.material));
  h.expect("统计里能看到计划数与入仓数", t.stats().plans >= 1 && t.stats().stored >= 1, JSON.stringify(t.stats()));
}
// 26e：蓝图变换与缺失替换。
function checkTransform(h) {
  h.section("26e. 蓝图变换 / rotate and mirror");
  var tr = load("modules/builder-transform.js");
  if (!tr) { h.expect("builder-transform 可加载", false, "null"); return; }
  tr.reset();
  var src = [
    { x: 0, y: 0, z: 0, block: "stone", facing: "north", props: { facing: "north" } },
    { x: 2, y: 0, z: 0, block: "oak_stairs", facing: "east", props: { facing: "east" } }
  ];
  var r90 = tr.rotate(src, 90, {});
  h.expect("90 度旋转后尺寸宽高对调且坐标归一到非负",
    r90.ok === true && r90.size.width === 1 && r90.size.length === 3, JSON.stringify(r90.size));
  h.expect("90 度旋转同步改写 facing 与 props.facing",
    r90.blocks[0].facing === "east" && r90.blocks[0].props.facing === "east", JSON.stringify(r90.blocks[0]));
  var r180 = tr.rotate(src, 180, {});
  var r270 = tr.rotate(src, 270, {});
  h.expect("180 / 270 度旋转都成功且朝向按循环推进",
    r180.ok === true && r270.ok === true && r180.blocks[0].facing === "south" && r270.blocks[0].facing === "west",
    JSON.stringify({ a: r180.blocks[0], b: r270.blocks[0] }));
  h.expect("非 90 倍数角度直接拒绝", tr.rotate(src, 45, {}).ok === false, "");
  var mx = tr.mirror(src, "x", {});
  var mz = tr.mirror(src, "z", {});
  h.expect("x / z 镜像成功且朝向正确翻转",
    mx.ok === true && mz.ok === true && mx.blocks[1].facing === "west" && mz.blocks[0].facing === "south",
    JSON.stringify({ mx: mx.blocks[1], mz: mz.blocks[0] }));
  h.expect("非法镜像轴直接拒绝", tr.mirror(src, "y", {}).ok === false, "");
  var missing = [
    { x: 0, y: 0, z: 0, block: "unknown" },
    { x: 1, y: 0, z: 0, block: "" },
    { x: 2, y: 0, z: 0, block: "stone" }
  ];
  var fixed = tr.replaceMissing(missing, { fallback: "cobblestone" });
  h.expect("缺失 / 未知方块自动替换成兜底材料",
    fixed.ok === true && fixed.replaced.length === 2 && fixed.blocks[0].block === "cobblestone" &&
    fixed.blocks[1].substituted === true && fixed.blocks[2].block === "stone", JSON.stringify(fixed.blocks));
  var aiFixed = tr.replaceMissing(missing, {
    ai: function () { return "glass"; }
  });
  h.expect("显式注入 AI 回调时优先用 AI 的替换结果",
    aiFixed.ok === true && aiFixed.aiUsed === 2 && aiFixed.blocks[0].block === "glass", JSON.stringify(aiFixed.blocks[0]));
  h.expect("统计里能看到旋转 / 镜像 / 替换次数",
    tr.stats().rotations === 3 && tr.stats().mirrors === 2 && tr.stats().replaced >= 4, JSON.stringify(tr.stats()));
}
// 26f：自动内饰与避柱。
function checkInterior(h) {
  h.section("26f. 自动内饰 / interior");
  var it = load("modules/builder-interior.js");
  if (!it) { h.expect("builder-interior 可加载", false, "null"); return; }
  it.reset();
  var bp = house();
  var pillars = it.pillarsOf(bp, {});
  h.expect("识别出 4 根承重柱", pillars.length === 4 && it.isPillar(0, 0, pillars) === true && it.isPillar(2, 2, pillars) === false, JSON.stringify(pillars));
  var plan = it.plan(bp, { lightSpacing: 2, beds: 1, chests: 2 });
  h.expect("内饰方案生成光源 / 床 / 箱子",
    plan.ok === true && plan.lights >= 1 && plan.beds === 1 && plan.chests === 2, JSON.stringify({ l: plan.lights, b: plan.beds, c: plan.chests }));
  var all = plan.tasks;
  var bad = all.filter(function (t) { return it.isPillar(t.x, t.z, pillars); });
  h.expect("所有家具都避开承重柱", bad.length === 0, JSON.stringify(bad));
  h.expect("任务带 role=interior 与放置动作",
    all.length > 0 && all[0].role === "interior" && all[0].action === "place_block", JSON.stringify(all[0]));
  h.expect("光源 / 床 / 箱子用的是真实方块名",
    JSON.stringify(all).indexOf("lantern") > 0 && JSON.stringify(all).indexOf("white_bed") > 0 && JSON.stringify(all).indexOf("chest") > 0, "");
  h.expect("统计里能看到避柱数量", it.stats().avoided >= 4, JSON.stringify(it.stats()));
}
// 26g：防熊巡检与补块报警。
function checkPatrol(h) {
  h.section("26g. 防熊巡检 / grief patrol");
  var p = load("modules/builder-patrol.js");
  if (!p) { h.expect("builder-patrol 可加载", false, "null"); return; }
  p.reset();
  var bp = [{ x: 0, y: 64, z: 0, block: "stone" }, { x: 1, y: 64, z: 0, block: "oak_planks" }, { x: 2, y: 64, z: 0, block: "glass" }];
  var world = { "0:64:0": "stone", "1:64:0": "air", "2:64:0": "dirt" };
  var chats = [];
  var bot = {
    blockAt: function (pos) { return { name: world[pos.x + ":" + pos.y + ":" + pos.z] || "air" }; },
    chat: function (t) { chats.push(t); }
  };
  var started = p.start(bot, bp, { id: "house1", manual: true, origin: { x: 0, y: 0, z: 0 } });
  h.expect("巡检会话可启动且手动模式不挂定时器", started.ok === true && started.running === true && p.stats("house1").running === true, JSON.stringify(started));
  var diff = p.inspect("house1", {});
  h.expect("逐格对比蓝图：1 块被炸没、1 块被换成泥土",
    diff.ok === true && diff.checked === 3 && diff.missing.length === 1 && diff.wrong.length === 1 &&
    diff.wrong[0].found === "dirt", JSON.stringify(diff));
  var fixed = p.repair("house1", { diff: diff, bot: bot });
  h.expect("自动生成 2 条 place_block_exact 补块任务",
    fixed.ok === true && fixed.repaired === 2 && fixed.tasks[0].action === "place_block_exact", JSON.stringify(fixed.tasks));
  h.expect("公屏发出中英双语报警",
    chats.length === 1 && chats[0].indexOf("建筑被破坏") > 0 && chats[0].indexOf("Damage detected") > 0, JSON.stringify(chats));
  var wp = p.waypoints(bp, { margin: 2 });
  h.expect("巡逻路点绕建筑一圈共 4 个", wp.length === 4 && wp[0].x === -2 && wp[2].z === 2, JSON.stringify(wp));
  h.expect("统计里能看到巡检 / 破坏 / 修复计数",
    p.stats("house1").inspections >= 1 && p.stats("house1").repaired === 2, JSON.stringify(p.stats("house1")));
  h.expect("停止巡检后会话不再运行", p.stop("house1").stopped === true && p.stats("house1").running === false, "");
  p.reset();
}
// 26h：悬浮倒挂脚手架。
function checkSky(h) {
  h.section("26h. 悬浮建筑 / sky scaffold");
  var sky = load("modules/builder-sky.js");
  if (!sky) { h.expect("builder-sky 可加载", false, "null"); return; }
  sky.reset();
  var bp = stoneFloor(5, 70);
  var anchors = sky.anchorPoints(bp, { spacing: 2 });
  h.expect("顶部均匀布锚点且四角必在", anchors.length >= 9 && anchors[0].y > 70, JSON.stringify(anchors.slice(0, 3)));
  var plan = sky.plan(bp, { spacing: 2, clearance: 2 });
  h.expect("悬浮方案含锚点 + 倒挂支撑链 + 本体建造任务",
    plan.ok === true && plan.hanging === true && plan.anchors.length >= 9 &&
    plan.supports.length > 0 && plan.build.length === 25, JSON.stringify({ a: plan.anchors.length, s: plan.supports.length, b: plan.build.length }));
  h.expect("支撑链是从锚点向下逐格挂的",
    plan.supports[0].depth === 1 && plan.supports[0].y < plan.anchors[0].y, JSON.stringify(plan.supports[0]));
  h.expect("回收顺序先把最深的支撑拆掉",
    plan.recycle.length > 0 && plan.recycle[0].action === "dig_block" &&
    plan.recycle[0].reason.indexOf("scaffold recycle") >= 0, JSON.stringify(plan.recycle[0]));
  h.expect("最后拆锚点（不会中途塌）",
    plan.recycle[plan.recycle.length - 1].reason.indexOf("anchor recycle") >= 0, JSON.stringify(plan.recycle[plan.recycle.length - 1]));
  h.expect("统计里能看到锚点与支撑数", sky.stats().anchors >= 9 && sky.stats().supports > 0, JSON.stringify(sky.stats()));
}
// 26i：贪心合并 /fill 与 requiresOp。
function checkFill(h) {
  h.section("26i. 贪心合并 /fill / greedy meshing");
  var mesher = load("modules/blueprint-mesher.js");
  if (!mesher) { h.expect("blueprint-mesher 可加载", false, "null"); return; }
  var boxes = mesher.greedyMeshing({ blocks: stoneFloor(10, 64) }, {});
  h.expect("10x10 石头地板合并成 1 个盒子", boxes.ok === true && boxes.boxes.length === 1, JSON.stringify(boxes.boxes.length));
  var cmds = mesher.fillCommands(boxes.boxes, {});
  h.expect("生成单条 /fill 指令且带 minecraft 命名空间",
    cmds.ok === true && cmds.commands.length === 1 && cmds.commands[0].indexOf("/fill ") === 0 &&
    cmds.commands[0].indexOf("minecraft:stone") > 0, JSON.stringify(cmds.commands));
  h.expect("每个 /fill 任务都挂上 requiresOp 标记",
    cmds.tasks[0].requiresOp === true && cmds.tasks[0].role === "builder", JSON.stringify(cmds.tasks[0]));
}
// 主流程：隔离 state → 逐组跑 → 复位 → 还原环境。
async function run(h) {
  var OLD = process.env.MINEBOTS_STATE_DIR;
  try {
    safeRemove(TEMP_DIR);
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
    process.env.MINEBOTS_STATE_DIR = TEMP_DIR;
  } catch (eDir) { h.expect("临时 state 目录就绪", false, String(eDir)); }
  var groups = [checkStatic, checkExact, checkLitematic, checkTerrain, checkTransform,
    checkInterior, checkPatrol, checkSky, checkFill];
  for (var i = 0; i < groups.length; i++) {
    try { groups[i](h); } catch (e) { h.expect("26 组 " + (i + 1) + " 未抛错", false, String(e)); }
  }
  try {
    var prefs = load("modules/prefs.js");
    if (prefs) prefs.save({ engExactBuild: false });
    var names = ["modules/builder-litematic.js", "modules/builder-terrain.js", "modules/builder-transform.js",
      "modules/builder-interior.js", "modules/builder-patrol.js", "modules/builder-sky.js"];
    for (var j = 0; j < names.length; j++) {
      try { var m = load(names[j]); if (m && typeof m.reset === "function") m.reset(); } catch (eR) { /* ignore */ }
    }
    safeRemove(TEMP_DIR);
    if (OLD === undefined) delete process.env.MINEBOTS_STATE_DIR;
    else process.env.MINEBOTS_STATE_DIR = OLD;
    h.expect("临时 state 目录已清理、环境已还原", fs.existsSync(TEMP_DIR) === false, TEMP_DIR);
  } catch (eEnd) { h.expect("26j 收尾未抛错", false, String(eEnd)); }
}
module.exports = { run: run };
