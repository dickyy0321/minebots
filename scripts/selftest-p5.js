// ========================================
// 文件：scripts/selftest-p5.js
// 功能：P5 回归自测——并发底盘 / 全链路追踪 / 拟真与雷达 / GOAP 与行为树 / 蜂群任务板 / 双模式 UI
// 依赖：path、fs、os、child_process；项目内新模块（都可选，缺了就记失败而不崩）
// 导出：run（由 scripts/selftest-p4.js 调用，复用 selftest.js 的 section / expect / wait）
// 作者：MineBots
// ========================================
// 说明 / note：任务板测试在独立子进程 + 临时 cwd 里跑，绝不碰真实 state/ 目录。
var path = require("path");
var fs = require("fs");
var os = require("os");
var childProcess = require("child_process");
var ROOT = path.join(__dirname, "..");

// 按相对路径安全 require 一个模块；缺失或抛错时返回 null。
function load(rel) {
  try { return require(path.join(ROOT, rel)); } catch (e) { return null; }
}

// 按相对路径读文本；读不到返回空串。
function read(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch (e) { return ""; }
}

// 静态检查：新文件存在 / 行数不超 600 / 有文件头 / 无禁用语法 / node --check 通过。
function checkStatic(h) {
  h.section("16a. 新模块静态红线 / static red lines");
  var files = [
    "modules/event-bus.js", "modules/worker-manager.js", "modules/test-runner.js",
    "modules/radar.js", "modules/goap.js", "modules/behavior-tree.js",
    "gui/renderer/ui-mode.js", "gui/renderer/ui-map.js", "scripts/selftest-p5.js"
  ];
  var allGood = true;
  var bad = [];
  for (var i = 0; i < files.length; i++) {
    var text = read(files[i]);
    var ok = text.length > 0 &&
      text.split("\n").length <= 600 &&
      text.indexOf("// ====") === 0 &&
      text.indexOf("module.exports") >= 0 || (files[i].indexOf("gui/") === 0 && text.indexOf("window.ui") >= 0);
    if (files[i].indexOf("gui/") === 0) ok = text.length > 0 && text.split("\n").length <= 600 && text.indexOf("// ====") === 0;
    var bannedOptional = "?" + ".";
    var bannedNullish = "?" + "?";
    if (text.indexOf(bannedOptional) >= 0 || text.indexOf(bannedNullish) >= 0) ok = false;
    try {
      childProcess.execFileSync(process.execPath, ["--check", path.join(ROOT, files[i])], { timeout: 15000 });
    } catch (e) { ok = false; }
    if (!ok) { allGood = false; bad.push(files[i]); }
  }
  h.expect("9 个新文件全部通过语法 / 行数 / 文件头 / 禁用语法检查", allGood === true, bad.join(","));
  h.expect("package.json 未被改动（禁改清单）", read("package.json").indexOf('"minecraft-data"') >= 0, "package.json");
}

// 事件总线：订阅 / 派发 / 通配符 / 失败隔离 / once / 历史 / 转发槽 / 重置。
function checkBus(h) {
  h.section("16b. 事件总线 / event bus");
  var bus = load("modules/event-bus.js");
  if (!bus) { h.expect("event-bus 可加载", false, "require failed"); return; }
  bus.reset();
  h.expect("event-bus 可加载", true, "");
  var got = [];
  var un = bus.on("trace.*", function (payload) { got.push(payload); });
  var r1 = bus.emit("trace.span", { n: 1 });
  h.expect("通配符订阅收到事件", r1.ok === true && r1.delivered === 1 && got.length === 1, JSON.stringify(r1));
  bus.on("trace.span", function () { throw new Error("boom / 故意出错"); });
  var r2 = bus.emit("trace.span", { n: 2 });
  h.expect("订阅者抛错被隔离", r2.ok === true && r2.failed === 1 && r2.delivered >= 1, JSON.stringify(r2));
  h.expect("事件历史被记录", bus.history().length >= 2, String(bus.history().length));
  if (un) un();
  var r3 = bus.emit("trace.span", { n: 3 });
  h.expect("退订后不再收到", r3.delivered === 0, JSON.stringify(r3));
  var onceCount = 0;
  bus.once("once.evt", function () { onceCount = onceCount + 1; });
  bus.emit("once.evt", {}); bus.emit("once.evt", {});
  h.expect("once 只触发一次", onceCount === 1, String(onceCount));
  var sinkHits = [];
  bus.setSink(function (e) { sinkHits.push(e.name); });
  bus.emit("gui.evt", {});
  h.expect("GUI 转发槽生效", sinkHits.indexOf("gui.evt") >= 0, sinkHits.join(","));
  var st = bus.stats();
  h.expect("统计含频道 / 订阅 / 历史", typeof st.channels === "number" && typeof st.listeners === "number", JSON.stringify(st));
  bus.setSink(null);
  bus.reset();
  h.expect("reset 后回到干净状态", bus.stats().listeners === 0, JSON.stringify(bus.stats()));
}

// 并发底盘：真实 worker_threads 创建 / ping / echo / compute / sleep / fail / 停止。
async function checkWorkers(h) {
  h.section("16c. 并发底盘 / worker threads");
  var wm = load("modules/worker-manager.js");
  if (!wm) { h.expect("worker-manager 可加载", false, "require failed"); return; }
  h.expect("worker-manager 可加载", true, "");
  if (!wm.isAvailable()) {
    h.expect("线程库缺失时安全降级", wm.spawn({}).ok === false, "degraded");
    return;
  }
  h.expect("worker_threads 可用", true, "");
  var sp = wm.spawn({ label: "selftest" });
  h.expect("工作线程创建成功", sp.ok === true && sp.id.length > 0, JSON.stringify(sp));
  if (!sp.ok) return;
  var ping = await wm.send(sp.id, "ping", {});
  h.expect("ping 回 pong（跨线程）", ping.ok === true && ping.value === "pong", JSON.stringify(ping));
  var echo = await wm.send(sp.id, "echo", { hello: "world" });
  h.expect("echo 原样回传", echo.ok === true && echo.value && echo.value.hello === "world", JSON.stringify(echo));
  var calc = await wm.send(sp.id, "compute", { n: 50000 });
  h.expect("compute 返回真实计算结果", calc.ok === true && typeof calc.value === "number" && calc.value > 0, JSON.stringify(calc));
  var slept = await wm.send(sp.id, "sleep", { ms: 25 });
  h.expect("sleep 产生真实耗时", slept.ok === true && slept.elapsedMs >= 15, JSON.stringify(slept));
  var fail = await wm.send(sp.id, "fail", {});
  h.expect("故障任务回 ok:false 但不崩", fail.ok === false, JSON.stringify(fail));
  var unknown = await wm.send(sp.id, "not-exist", {});
  h.expect("未知任务类型被拒绝", unknown.ok === false, JSON.stringify(unknown));
  var st = wm.stats();
  h.expect("并发统计含线程数与上限", st.workers === 1 && st.maxWorkers >= 10, JSON.stringify(st));
  h.expect("线程状态可查询", wm.status(sp.id) !== null && wm.list().length === 1, JSON.stringify(wm.list()));
  var stopped = wm.stop(sp.id);
  h.expect("线程可优雅停止", stopped.ok === true && wm.list().length === 0, JSON.stringify(stopped));
  var all = wm.stopAll();
  h.expect("stopAll 幂等", all.ok === true, JSON.stringify(all));
}

// 全链路追踪：Trace ID / 真实调用 / 真实耗时 / 10% 注入 / GUI 日志 / 查询汇总。
async function checkTraces(h) {
  h.section("16d. 全链路追踪 / trace runner");
  var tr = load("modules/test-runner.js");
  var bus = load("modules/event-bus.js");
  if (!tr) { h.expect("test-runner 可加载", false, "require failed"); return; }
  h.expect("test-runner 可加载", true, "");
  tr.clear();
  var guiLines = [];
  var calls = 0;
  var steps = [
    { name: "底层A / bottom A", delayMs: 6, call: function () { calls = calls + 1; return { ok: true, value: "a" }; } },
    { name: "底层B / bottom B", delayMs: 6, call: function () { calls = calls + 1; return { ok: true, value: "b" }; } },
    { name: "底层C / bottom C", delayMs: 6, call: function () { calls = calls + 1; return { ok: true, value: "c" }; } }
  ];
  var res = await tr.run("P5 全绿链路", steps, {
    failureRate: 0, random: function () { return 0.99; },
    sink: function (e) { guiLines.push(e.text); }
  });
  h.expect("底层函数被真实调用 3 次", calls === 3, String(calls));
  h.expect("链路全绿且 3 个 span", res.ok === true && res.steps === 3, JSON.stringify({ ok: res.ok, steps: res.steps }));
  h.expect("Trace ID 格式正确", /^trace-/.test(res.traceId), res.traceId);
  h.expect("每步都记录了真实耗时", res.spans[0].elapsedMs >= 4 && res.elapsedMs >= 12, JSON.stringify(res.spans[0]));
  h.expect("追踪日志推到 GUI", guiLines.length >= 2, String(guiLines.length));
  h.expect("span 带 spanId 与双语步骤名", res.spans[0].spanId.indexOf(res.traceId) === 0, res.spans[0].spanId);
  var got = tr.getTrace(res.traceId);
  h.expect("按 Trace ID 能查回整条链", !!got && got.spans.length === 3, JSON.stringify(got && got.traceId));
  var forced = await tr.run("P5 故障注入", [
    { name: "故障步", delayMs: 0, call: function () { return { ok: true }; } }
  ], { failureRate: 1, random: function () { return 0; } });
  h.expect("故障注入真能让链路失败", forced.ok === false && forced.injected === 1, JSON.stringify({ ok: forced.ok, injected: forced.injected }));
  h.expect("默认故障率为 10%", Math.abs(tr.DEFAULT_FAILURE_RATE - 0.1) < 1e-9, String(tr.DEFAULT_FAILURE_RATE));
  h.expect("Trace ID 全局唯一", tr.newTraceId() !== tr.newTraceId(), "unique");
  h.expect("lastTrace 能取到最新一条", tr.lastTrace() !== null, "lastTrace");
  h.expect("汇总统计正确", tr.summary().traces >= 2 && tr.summary().spans >= 4, JSON.stringify(tr.summary()));
  if (bus) {
    var busHits = 0;
    var un = bus.on("trace.*", function () { busHits = busHits + 1; });
    await tr.run("总线联动", [{ name: "x", delayMs: 0, call: function () { return { ok: true }; } }], { failureRate: 0 });
    if (un) un();
    h.expect("追踪事件广播到事件总线", busHits >= 1, String(busHits));
  }
  var simple = await tr.runSimple("便捷入口", ["一", "二"], function () { return { ok: true }; }, { failureRate: 0, stepMs: 0 });
  h.expect("runSimple 也能跑完两步", simple.ok === true && simple.steps === 2, JSON.stringify(simple));
  tr.clear();
  h.expect("追踪记录可清空", tr.summary().traces === 0, JSON.stringify(tr.summary()));
}

// 拟真动作层：高斯噪声 / 噪声点 / 人类延迟 / 配置 / 旧接口兼容。
async function checkMotion(h) {
  h.section("16e. 拟真噪声 / gaussian motion");
  var motion = load("modules/motion.js");
  if (!motion) { h.expect("motion 可加载", false, "require failed"); return; }
  h.expect("motion 可加载", true, "");
  motion.configure({ enabled: false });
  h.expect("噪声可一键关闭", motion.clampedNoise(1) === 0, "0");
  motion.configure({ enabled: true, sigma: 0.1 });
  var sum = 0;
  var max = 0;
  for (var i = 0; i < 200; i++) {
    var n = motion.gaussianNoise(0, 0.1);
    sum = sum + n;
    if (Math.abs(n) > max) max = Math.abs(n);
  }
  h.expect("高斯噪声均值接近 0", Math.abs(sum / 200) < 0.05, String(sum / 200));
  h.expect("高斯噪声被截断在 3σ 内", max <= 0.300001, String(max));
  var noisy = motion.noisyPoint({ x: 1, y: 2, z: 3 }, 0.05);
  h.expect("噪声点保留三维数字坐标", !!noisy && typeof noisy.x === "number" && typeof noisy.y === "number" && typeof noisy.z === "number", JSON.stringify(noisy));
  h.expect("噪声点不是原样复制", !!noisy && noisy.x !== 1, JSON.stringify(noisy));
  var d = motion.humanDelayMs(100, 100);
  h.expect("人类延迟落在 100~200ms", d >= 100 && d <= 200, String(d));
  var t0 = Date.now();
  var waited = await motion.humanDelay(12, 20);
  h.expect("humanDelay 产生真实等待", Date.now() - t0 >= 8 && waited >= 12, String(waited));
  h.expect("配置读回正确", motion.getConfig().enabled === true, JSON.stringify(motion.getConfig()));
  h.expect("旧接口 smoothLookAt 未被破坏", typeof motion.smoothLookAt === "function" && typeof motion.pause === "function", "legacy api");
  motion.configure({ enabled: true, sigma: 0.06 });
}

// 打字机：智能切分 / 不切英文单词 / 最多 3 段 / 拼回原文 / 老断言兼容。
function checkTyping(h) {
  h.section("16f. 智能切分打字机 / smart typewriter");
  var typing = load("modules/typing.js");
  if (!typing) { h.expect("typing 可加载", false, "require failed"); return; }
  h.expect("typing 可加载", true, "");
  h.expect("单条消息最多切 3 段", typing.MAX_CHUNKS === 3, String(typing.MAX_CHUNKS));
  var word = typing.smartSplit("supercalifragilisticexpialidocious", 3);
  h.expect("纯英文长单词绝不切断", word.length === 1 && word[0] === "supercalifragilisticexpialidocious", JSON.stringify(word));
  var text = "Hello world, this is a test. Follow me now, please stop here!";
  var parts = typing.smartSplit(text, 3);
  h.expect("按标点空格切分不超过 3 段", parts.length <= 3 && parts.length >= 1, JSON.stringify(parts));
  h.expect("切分后拼回原文一致", parts.join("") === text, parts.join("|"));
  var joined = parts.join("");
  h.expect("Hello / Follow / please 都完整出现", joined.indexOf("Hello") >= 0 && joined.indexOf("Follow") >= 0 && joined.indexOf("please") >= 0, joined.slice(0, 40));
  var cn = typing.smartSplit("第一句。第二句！第三句？第四句；", 3);
  h.expect("中文按标点切分且不超 3 段", cn.length <= 3 && cn.join("") === "第一句。第二句！第三句？第四句；", JSON.stringify(cn));
  var plan = typing.plan(text, { typing: true, mode: "chunk", chunk: 8, perCharMs: 10 });
  h.expect("plan 走智能切分后仍不超过 3 段", plan.segments.length <= 3, JSON.stringify(plan.segments));
  h.expect("plan 的文本完整保留", plan.segments.join("") === text, plan.segments.join("|"));
  var legacy = typing.plan("0123456789ab", { typing: true, mode: "chunk", chunk: 5, perCharMs: 10 });
  h.expect("老节奏断言仍成立（3 段 / gap=50）", legacy.mode === "chunk" && legacy.segments.length === 3 && legacy.gapMs === 50, JSON.stringify(legacy));
  var off = typing.plan("这是一句话", { typing: false });
  h.expect("关闭打字机仍整句一次发出", off.segments.length === 1 && off.mode === "off", JSON.stringify(off));
}

// 2D 雷达数据源：三色分类 / 64 格覆盖 / 超距过滤 / 快照。
function checkRadar(h) {
  h.section("16g. 64 格雷达数据 / radar source");
  var radar = load("modules/radar.js");
  if (!radar) { h.expect("radar 可加载", false, "require failed"); return; }
  h.expect("radar 可加载", true, "");
  h.expect("雷达半径为 64 格", radar.RADAR_RADIUS === 64, String(radar.RADAR_RADIUS));
  h.expect("玩家分类正确", radar.classify({ username: "Steve", type: "player" }) === "player", "player");
  h.expect("怪物分类正确", radar.classify({ name: "zombie", type: "mob" }) === "mob", "mob");
  h.expect("掉落物分类正确", radar.classify({ name: "item", type: "object" }) === "drop", "drop");
  var me = { position: { x: 0, y: 64, z: 0 } };
  var bot = {
    entity: me,
    entities: {
      self: me,
      p1: { username: "Steve", type: "player", position: { x: 10, y: 64, z: 0 } },
      m1: { name: "zombie", type: "mob", position: { x: -20, y: 64, z: 0 } },
      d1: { name: "item", type: "object", position: { x: 0, y: 64, z: 30 } },
      far: { name: "creeper", type: "mob", position: { x: 100, y: 64, z: 0 } }
    }
  };
  var snap = radar.scan(bot);
  h.expect("64 格内扫到 3 个实体", snap.ok === true && snap.entities.length === 3, JSON.stringify(snap.entities));
  h.expect("三类实体计数正确", snap.counts.player === 1 && snap.counts.mob === 1 && snap.counts.drop === 1, JSON.stringify(snap.counts));
  h.expect("超过 64 格的实体被过滤", snap.entities.length === 3 && snap.scanned === 5, JSON.stringify({ len: snap.entities.length, scanned: snap.scanned }));
  h.expect("快照可回读", radar.snapshot().entities.length === 3, JSON.stringify(radar.snapshot().counts));
  var empty = radar.scan(null);
  h.expect("空 bot 返回 ok:false 而非抛错", empty.ok === false && empty.entities.length === 0, JSON.stringify(empty));
  h.expect("雷达点数按距离排序", snap.entities[0].distance <= snap.entities[1].distance, JSON.stringify(snap.entities));
}

// GOAP：中英目标解析 / 木镐前置链 / 已有材料跳过 / 防环 / minecraft-data 接入。
function checkGoap(h) {
  h.section("16h. GOAP 目标规划 / causal planner");
  var goap = load("modules/goap.js");
  if (!goap) { h.expect("goap 可加载", false, "require failed"); return; }
  h.expect("goap 可加载", true, "");
  h.expect("中文「木镐」解析成功", goap.resolveGoal("木镐") === "wooden_pickaxe", goap.resolveGoal("木镐"));
  h.expect("英文 wooden pickaxe 解析成功", goap.resolveGoal("wooden pickaxe") === "wooden_pickaxe", goap.resolveGoal("wooden pickaxe"));
  h.expect("未知目标返回空串", goap.resolveGoal("飞船") === "", "unknown");
  var plan = goap.plan("木镐", {});
  h.expect("木镐自动推导 4 步前置链", plan.ok === true && plan.chain.length === 4, plan.chain.join(" > "));
  h.expect("链从采集原木开始", plan.chain[0] === "chop_tree", plan.chain.join(","));
  h.expect("链含合成木板与木棍", plan.chain.indexOf("craft_planks") >= 0 && plan.chain.indexOf("craft_stick") >= 0, plan.chain.join(","));
  h.expect("链以合成木镐收尾", plan.chain[plan.chain.length - 1] === "craft_wooden_pickaxe", plan.chain.join(","));
  h.expect("前置顺序因果正确", plan.chain.indexOf("craft_planks") < plan.chain.indexOf("craft_stick") && plan.chain.indexOf("craft_stick") < plan.chain.indexOf("craft_wooden_pickaxe"), plan.chain.join(","));
  var skip = goap.plan("木镐", { planks: 10, stick: 5 });
  h.expect("背包已有材料时跳过前置任务", skip.chain.join(",") === "craft_wooden_pickaxe", skip.chain.join(","));
  var stone = goap.plan("石镐", {});
  h.expect("石镐链包含挖圆石", stone.chain.indexOf("mine_stone") >= 0, stone.chain.join(","));
  h.expect("规划有数据源标注", typeof plan.source === "string" && plan.source.length > 0, plan.source);
  h.expect("规划说明是双语文本", goap.explain(plan).indexOf(" / ") >= 0, goap.explain(plan).slice(0, 60));
  var info = goap.dataInfo("wooden_pickaxe");
  h.expect("minecraft-data 配方查询可用或有内置兜底", info !== null || goap.getRules().wooden_pickaxe.action === "craft_wooden_pickaxe", JSON.stringify(info));
  h.expect("规则表可列出全部目标", goap.availableGoals().indexOf("wooden_pickaxe") >= 0, goap.availableGoals().join(","));
  h.expect("规则表副本不可改坏内部状态", (function () { var r = goap.getRules(); r.log = null; return goap.getRules().log.action === "chop_tree"; })(), "immutable");
}

// 行为树：顺序执行 / 打断 / 恢复不重做 / selector / 条件 / 黑板 / 重置。
async function checkTree(h) {
  h.section("16i. 可恢复行为树 / resumable behavior tree");
  var bt = load("modules/behavior-tree.js");
  if (!bt) { h.expect("behavior-tree 可加载", false, "require failed"); return; }
  h.expect("behavior-tree 可加载", true, "");
  var made = bt.create({ type: "sequence", children: [
    { type: "action", fn: function () { return true; } },
    { type: "action", fn: function () { return true; } }
  ] }, { name: "basic" });
  h.expect("行为树创建成功", made.ok === true && made.tree.nodes >= 3, JSON.stringify(made.message));
  var base = await bt.tick(made.tree, {});
  h.expect("sequence 全部成功", base.ok === true && base.ran === 2, JSON.stringify(base));
  var ran = [];
  var tree = null;
  var def = { type: "sequence", children: [
    { type: "action", fn: function () { ran.push("a"); return true; } },
    { type: "action", fn: function () { ran.push("b"); if (bt && tree) bt.interrupt(tree, "test / 测试打断"); return true; } },
    { type: "action", fn: function () { ran.push("c"); return true; } }
  ] };
  var made2 = bt.create(def, { name: "resume" });
  tree = made2.tree;
  var first = await bt.tick(tree, {});
  h.expect("中途打断返回 interrupted", first.status === "interrupted", JSON.stringify(first));
  h.expect("打断时只跑了前两步", ran.join(",") === "a,b", ran.join(","));
  var resumed = await bt.resume(tree, {});
  h.expect("恢复后链路跑完", resumed.ok === true, JSON.stringify(resumed));
  h.expect("恢复不重做已完成步骤", ran.join(",") === "a,b,c", ran.join(","));
  h.expect("恢复统计里有跳过计数", resumed.skipped >= 2, String(resumed.skipped));
  var selHit = 0;
  var selBad = 0;
  var sel = bt.create({ type: "selector", children: [
    { type: "condition", fn: function () { return false; } },
    { type: "action", fn: function () { selHit = selHit + 1; return true; } },
    { type: "action", fn: function () { selBad = selBad + 1; return true; } }
  ] });
  var selRes = await bt.tick(sel.tree, {});
  h.expect("selector 命中第二个分支且不再往下", selRes.ok === true && selHit === 1 && selBad === 0, JSON.stringify({ hit: selHit, bad: selBad }));
  var bb = bt.create({ type: "action", fn: function (ctx, board) { board.hp = 20; return true; } }, { blackboard: { hp: 1 } });
  await bt.tick(bb.tree, {});
  h.expect("黑板能被动作写入并读回", bt.blackboard(bb.tree).hp === 20, JSON.stringify(bt.blackboard(bb.tree)));
  var bad = bt.create({ type: "action", fn: function () { throw new Error("boom / 故意出错"); } });
  var badRes = await bt.tick(bad.tree, {});
  h.expect("动作抛错转成 failure 不冒到顶层", badRes.ok === false && badRes.status === "failure", JSON.stringify(badRes));
  h.expect("状态快照可读", bt.status(made.tree).status === "success", JSON.stringify(bt.status(made.tree)));
  h.expect("reset 后进度归零", bt.reset(made.tree).ok === true && bt.status(made.tree).done === 0, JSON.stringify(bt.status(made.tree)));
}

// 蜂群任务板：在独立子进程 + 临时 cwd 里跑，绝不污染真实 state/。
function checkBoard(h) {
  h.section("16j. 100 bot 抢任务 / swarm task board");
  var tmp = "";
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mb-p5-board-"));
    var boardPath = path.join(ROOT, "modules", "shared-board.js").split(path.sep).join("/");
    var code = [
      "var b = require(" + JSON.stringify(boardPath) + ");",
      "b.clear();",
      "var posted = 12;",
      "for (var i = 0; i < posted; i++) b.postTask({ title: 'task-' + i, priority: i });",
      "var claimed = {}; var okCount = 0; var dup = 0;",
      "for (var j = 0; j < 100; j++) {",
      "  var r = b.claimTask('bot-' + j);",
      "  if (r.ok) { okCount++; if (claimed[r.taskId]) dup++; claimed[r.taskId] = true; }",
      "}",
      "var st = b.taskStats();",
      "var list = b.listTasks({ status: 'claimed' });",
      "var a = list[0]; var c = list[1];",
      "var done = a ? b.completeTask(a.id, a.claimedBy, { ok: true }) : { ok: false };",
      "var rel = c ? b.releaseTask(c.id, c.claimedBy) : { ok: false };",
      "var wrong = c ? b.releaseTask(c.id, 'intruder') : { ok: false };",
      "var reaped = b.reapExpired(Date.now() + 9999999);",
      "var after = b.taskStats();",
      "console.log(JSON.stringify({ okCount: okCount, dup: dup, stats: st, after: after,",
      "  shard: b.shardOf('abc'), done: done.ok, rel: rel.ok, wrong: wrong.ok, reaped: reaped }));"
    ].join("\n");
    var out = childProcess.execFileSync(process.execPath, ["-e", code], { cwd: tmp, encoding: "utf8", timeout: 20000 });
    var lines = String(out).trim().split("\n");
    var r = JSON.parse(lines[lines.length - 1]);
    h.expect("隔离进程任务板测试跑通", true, JSON.stringify({ okCount: r.okCount, dup: r.dup }));
    h.expect("12 个任务被 100 bot 全抢完", r.okCount === 12, String(r.okCount));
    h.expect("没有任务被两个 bot 重复认领", r.dup === 0, String(r.dup));
    h.expect("任务板按 16 分片且上限 100 bot", r.stats.shards === 16 && r.stats.maxBots === 100, JSON.stringify(r.stats));
    h.expect("分片哈希稳定且落在合法范围", r.shard >= 0 && r.shard < 16, String(r.shard));
    h.expect("完成与归还接口生效", r.done === true && r.rel === true, JSON.stringify({ done: r.done, rel: r.rel }));
    h.expect("非持有者不能归还任务", r.wrong === false, String(r.wrong));
    h.expect("过期租约能被回收", r.reaped > 0, String(r.reaped));
    h.expect("回收后待领任务数回升", r.after.pending >= 1, JSON.stringify(r.after));
  } catch (e) {
    h.expect("共享黑板隔离测试未抛错", false, String(e && e.message ? e.message : e));
  } finally {
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 临时目录清不掉不影响主流程 */ }
  }
}

// UI 接线静态检查：双模式 / 折叠 / 2D 雷达 / 3D 废弃 / 遥测接雷达。
function checkUi(h) {
  h.section("16k. 双模式 UI 与雷达接线 / dual mode + radar wiring");
  var html = read("gui/renderer/index.html");
  h.expect("模式切换按钮存在", html.indexOf('id="modeBtn"') >= 0, "modeBtn");
  h.expect("ui-mode.js 被页面引用", html.indexOf("ui-mode.js") >= 0, "ui-mode.js");
  h.expect("雷达画布升级到 256", html.indexOf('width="256" height="256"') >= 0, "canvas");
  h.expect("3D 视角按钮已从主界面移除（3D 已废弃）", html.indexOf('id="viewerOpenBtn"') < 0, "3D removed");
  var setHtml = read("gui/renderer/settings.html");
  h.expect("设置页采用左侧导航 + 右侧内容区（≥6 导航 + ≥6 面板）",
    (setHtml.split("data-settings-nav=").length - 1) >= 6 && (setHtml.split("data-settings-pane=").length - 1) >= 6, "settings nav/pane");
  var mapJs = read("gui/renderer/ui-map.js");
  h.expect("雷达半径为 64 格", mapJs.indexOf("RADIUS_BLOCKS = 64") >= 0, "radius");
  h.expect("玩家蓝色 / 怪物红色 / 掉落白色", mapJs.indexOf("#4aa3ff") >= 0 && mapJs.indexOf("#ff4d4f") >= 0 && mapJs.indexOf("#f5f7fb") >= 0, "colors");
  h.expect("雷达用离屏缓存与 rAF 合帧", mapJs.indexOf("requestAnimationFrame") >= 0 && mapJs.indexOf("buildBase") >= 0, "performance");
  h.expect("雷达暴露 render / feed / clear / stats", mapJs.indexOf("render: function") >= 0 && mapJs.indexOf("feed: function") >= 0 && mapJs.indexOf("stats: function") >= 0, "api");
  var modeJs = read("gui/renderer/ui-mode.js");
  h.expect("双模式常量齐全", modeJs.indexOf('NOVICE = "novice"') >= 0 && modeJs.indexOf('EXPERT = "expert"') >= 0, "modes");
  h.expect("折叠面板不搬动 DOM", modeJs.indexOf("fold-hidden") >= 0 && modeJs.indexOf("aria-expanded") >= 0, "fold");
  var css = read("gui/renderer/style.css");
  h.expect("折叠样式已加入", css.indexOf(".fold-hidden") >= 0 && css.indexOf(".expert-fold-head") >= 0, "css");
  h.expect("雷达画布样式已加入", css.indexOf(".mini-map { width: 256px") >= 0, "css canvas");
  var app = read("gui/renderer/app.js");
  h.expect("app 启动时初始化双模式", app.indexOf("window.uiMode.init()") >= 0, "app init");
  var lang = read("gui/renderer/lang.js");
  h.expect("双语词条已补齐", lang.indexOf("modeNovice") >= 0 && lang.indexOf("radarLegend") >= 0, "i18n");
  var tel = read("modules/telemetry.js");
  h.expect("遥测快照已接入 64 格雷达", tel.indexOf("radarSource.scan") >= 0, "telemetry wiring");
  var telMod = load("modules/telemetry.js");
  var st = telMod ? telMod.getBotState(null) : null;
  h.expect("遥测模块仍可加载且空 bot 安全失败", !!st && st.ok === false, JSON.stringify(st));
}

// 主流程：依次跑全部分组；任一分组抛错只记一条失败，不让整轮自检崩。
async function run(h) {
  try { checkStatic(h); } catch (e1) { h.expect("16a 未抛错", false, String(e1)); }
  try { checkBus(h); } catch (e2) { h.expect("16b 未抛错", false, String(e2)); }
  try { await checkWorkers(h); } catch (e3) { h.expect("16c 未抛错", false, String(e3)); }
  try { await checkTraces(h); } catch (e4) { h.expect("16d 未抛错", false, String(e4)); }
  try { await checkMotion(h); } catch (e5) { h.expect("16e 未抛错", false, String(e5)); }
  try { checkTyping(h); } catch (e6) { h.expect("16f 未抛错", false, String(e6)); }
  try { checkRadar(h); } catch (e7) { h.expect("16g 未抛错", false, String(e7)); }
  try { checkGoap(h); } catch (e8) { h.expect("16h 未抛错", false, String(e8)); }
  try { await checkTree(h); } catch (e9) { h.expect("16i 未抛错", false, String(e9)); }
  try { checkBoard(h); } catch (e10) { h.expect("16j 未抛错", false, String(e10)); }
  try { checkUi(h); } catch (e11) { h.expect("16k 未抛错", false, String(e11)); }
  // P6：七大引擎默认全开 / 专家面板参数落盘 / 关闭即停 / 实时生效。
  try { await require("./selftest-p6").run(h); } catch (e12) { h.expect("16l 未抛错", false, String(e12)); }
  // P7：状态机 3.0 三层架构 / 看门狗 / 反射层 / 黑板竞价 / 命令化与蜂群控制台。
  try { await require("./selftest-p7").run(h); } catch (e13) { h.expect("17a 未抛错", false, String(e13)); }
  // P8：五级 JSON 修复引擎 / 极端脏文本 / AI 大脑与状态机接线 / 兜底触发 1 次 AI 重试。
  try { await require("./selftest-p8").run(h); } catch (e14) { h.expect("18a 未抛错", false, String(e14)); }
  // P9：精确建筑 / 蓝图与 .schem / 脚手架 / AI 自主编程与发帖 / 蜂群物流 / 命令化 / 全系统回归。
  try { await require("./selftest-p9").run(h); } catch (e15) { h.expect("19a 未抛错", false, String(e15)); }
  // P10：红石扫描与故障检测 / 高频触发器 / 告示牌分拣 / .litematic 高维蓝图 /
  //      place_block_exact 属性返工 / 红石缺料自动发帖 / GUI 精准面板双控件。
  try { await require("./selftest-p10").run(h); } catch (e16) { h.expect("20a 未抛错", false, String(e16)); }
  // P11：Litematica LongArray 位解码 / 红石 Tick 仿真 / 自动布线 A* / 贪心合并 /fill /
  //      SDF 转 .litematic / TPS + Ping 安全限流。
  try { await require("./selftest-p11").run(h); } catch (e17) { h.expect("21a 未抛错", false, String(e17)); }
  // P12：Tick 级生存微操（MLG / 跳跃重置 / 防爆盾）/ 读心陪伴 / 情感信任 2.0 与 AI Prompt 注入。
  try { await require("./selftest-p12").run(h); } catch (e18) { h.expect("22a 未抛错", false, String(e18)); }
  // P13a：整句式打字机 / 公屏防污染 / 动作微操 / 网络底层诊断 / 断线快照 / IO 缓存 / 虚拟列表。
  try { await require("./selftest-p13a").run(h); } catch (e19) { h.expect("24j 未抛错", false, String(e19)); }
  // P13b：纯英文 FC schema / 参数强校验 / 空结果静默 / search_tools 按需检索降 Token。
  try { await require("./selftest-p13b").run(h); } catch (e20) { h.expect("25g 未抛错", false, String(e20)); }
  // P13c：精准建筑 / .litematic 属性朝向 / 地形 / 变换 / 内饰 / 防熊巡检 / 悬浮脚手架 / /fill。
  try { await require("./selftest-p13c").run(h); } catch (e21) { h.expect("26k 未抛错", false, String(e21)); }
  // P13d：红石真值表 / A* 自动布线 / 15ms 漂移补偿 / TPS-Ping 阀门 / 矿车物流 / 机器巡检报警。
  try { await require("./selftest-p13d").run(h); } catch (e22) { h.expect("27e 未抛错", false, String(e22)); }
  // P13e：物理反射 / 读心陪伴 / 动态信任 2.0 回归 + 绝对主人特权 isOwner=true / 👑 [主人]。
  try { await require("./selftest-p13e").run(h); } catch (e23) { h.expect("28g 未抛错", false, String(e23)); }
  // P13f：多 Bot 防碰撞 / 雇佣钱包 / 幽灵反作弊 / 全维度信标 / QQ-Discord 桥 / 本地翻译模型。
  try { await require("./selftest-p13f").run(h); } catch (e24) { h.expect("29i 未抛错", false, String(e24)); }
  // P14a：聊天频道隔离——共享黑板 channels / 指令分配 / 同频道互通异频道隔离 / 人数上限 / swarm 私聊过滤。
  try { await require("./selftest-p14a").run(h); } catch (e25) { h.expect("30j 未抛错", false, String(e25)); }
  // P14b：模型档案池——Ollama 解耦 / 预设档 / 每 bot 独立选档 / 内存共享单例 / ai-client 读档覆盖接入。
  try { await require("./selftest-p14b").run(h); } catch (e26) { h.expect("31k 未抛错", false, String(e26)); }
  // P15：终极发布——账号双支持（离线/正版）/ 沙盒容错 / 演示与向导 / 全自动 RPA 脚本，全五模块 Node 端逻辑覆盖。
  try { await require("./selftest-p15").run(h); } catch (e27) { h.expect("32a 未抛错", false, String(e27)); }
  // P16：终极 QA——自愈重试循环 / 补丁安全边界 / 环境扫描 / 9 项测试清单 / 最终报告 / speedrun_mc 定义。
  try { await require("./selftest-p16").run(h); } catch (e28) { h.expect("33a 未抛错", false, String(e28)); }
  // P17：Bot 皮肤与后台仓库——导入皮肤 / 一键存档 / 本地擦除后恢复 / 永久删除 / IPC 与 UI 接线。
  try { await require("./selftest-p17").run(h); } catch (e29) { h.expect("34a 未抛错", false, String(e29)); }
  // P18：AI 默认值与预设——默认云端 / 启动不探测 Ollama / SGLang 归位本地 / 预设卡片 / 本地错误不弹红警。
  try { await require("./selftest-p18").run(h); } catch (e30) { h.expect("35a 未抛错", false, String(e30)); }
  // P19：本地推理框架——Ollama / LM Studio / llama.cpp / SGLang / 自定义：端口模型路径、探测、状态、启动前置校验、IPC/UI 接线。
  try { await require("./selftest-p19").run(h); } catch (e31) { h.expect("36a 未抛错", false, String(e31)); }
  // P20：本地配置与按 Bot 绑定模型——多框架独立配置 / 模型导入删除 / 每个 Bot 各用不同框架的不同模型 / 接线。
  try { await require("./selftest-p20").run(h); } catch (e32) { h.expect("37a 未抛错", false, String(e32)); }
  // P21：本地标签（实例）——一个标签=框架+模型+参数 / 多标签同时运行 / 端口冲突 / 删除保护 / 按标签绑定到 Bot。
  try { await require("./selftest-p21").run(h); } catch (e33) { h.expect("38a 未抛错", false, String(e33)); }
}

module.exports = { run: run };
