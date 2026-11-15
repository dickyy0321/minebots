// ========================================
// 文件：scripts/selftest-p13a.js
// 功能：P13 模块1 回归自测——整句式打字机 / 公屏防污染与禁绝私聊 / 动作微操 /
//       AggregateError 双语底层诊断 / 断线快照 / IO 缓存 30 秒落盘 / 前端虚拟列表与深度折叠
// 依赖：path、fs、os；被测模块（都可选，缺了记失败而不崩）
// 导出：run（由 selftest-p5.js 调用）
// 作者：MineBots
// ========================================
// 说明：全程离线、不联网；state 一律重定向到独立临时目录，收尾逐模块 reset 并还原环境。
var path = require("path");
var fs = require("fs");
var os = require("os");
var ROOT = path.join(__dirname, "..");
var TEMP_DIR = path.join(os.tmpdir(), "minebots-p13a-" + process.pid);

// 安全 require：缺失或抛错返回 null。
function load(rel) {
  try { return require(path.join(ROOT, rel)); } catch (e) { return null; }
}
// 读项目文件文本；读不到返回空串。
function readRel(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch (e) { return ""; }
}
// 递归删临时目录（快照会建子目录）；失败静默。
function safeRemove(dir) {
  try {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir).forEach(function (n) {
      var p = path.join(dir, n);
      try {
        if (fs.lstatSync(p).isDirectory()) safeRemove(p);
        else fs.unlinkSync(p);
      } catch (e) { /* ignore */ }
    });
    fs.rmdirSync(dir);
  } catch (e) { /* ignore */ }
}
// 等待若干毫秒；不 unref，保证异步链路跑完前进程不退出。
function wait(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}
// 假 bot：chat / look / setControlState 全部留痕。
function makeBot(calls, opts) {
  var o = opts || {};
  return {
    username: o.username || "p13a-bot",
    yaw: 0, pitch: 0,
    chat: function (t) { calls.push("chat:" + t); return true; },
    look: function (y, p) { calls.push("look:" + y.toFixed(2) + ":" + p.toFixed(2)); },
    setControlState: function (k, v) { calls.push("ctrl:" + k + ":" + v); },
    on: function (e) { calls.push("on:" + e); },
    removeListener: function (e) { calls.push("off:" + e); }
  };
}
// 24a：静态红线——新文件存在、头注释、行数、禁用语法、关键接线落地。
function checkStatic(h) {
  h.section("24a. 模块1 静态红线与接线 / static and wiring");
  var files = ["modules/chat-filter.js", "modules/motion-micro.js", "modules/error-diagnose.js",
    "modules/state-manager.js", "modules/network.js", "modules/io-cache.js",
    "gui/renderer/virtual-list.js", "gui/renderer/ui-log.js"];
  var banned = [/\?\./, /\?\?/, /\bconst\b/, /\blet\b/, /=>/, /`/, /^import\s+/m, /^export\s+/m];
  var allOk = true;
  for (var i = 0; i < files.length; i++) {
    var text = readRel(files[i]);
    var ok = text.length > 0 && text.indexOf("// ====") === 0 && text.split("\n").length <= 600;
    for (var j = 0; j < banned.length; j++) if (banned[j].test(text)) ok = false;
    if (!ok) { allOk = false; h.expect(files[i] + " 静态红线", false, "len=" + text.length); }
  }
  h.expect("8 个新增/重写文件都满足头注释 / 600 行 / 禁用语法", allOk, "");
  var ch = readRel("modules/chat-handler.js");
  var mo = readRel("modules/motion.js");
  var sb = readRel("modules/shared-board.js");
  var html = readRel("gui/renderer/index.html");
  var uilog = readRel("gui/renderer/ui-log.js");
  var con = readRel("modules/swarm-console.js");
  h.expect("chat-handler 入口已接公屏过滤且废弃分段打断",
    ch.indexOf("chat-filter") > 0 && ch.indexOf("typing.interrupt") < 0, "");
  h.expect("motion 物理帧已接动作微操", mo.indexOf("motion-micro") > 0 && mo.indexOf("microMotion.walkTick") > 0, "");
  h.expect("shared-board 落盘间隔可由 IO 缓存接管", sb.indexOf("io-cache") > 0 && sb.indexOf("saveDelayMs()") > 0, "");
  h.expect("渲染层已加载虚拟列表脚本", html.indexOf("virtual-list.js") > 0, "");
  h.expect("ui-log 优先走虚拟列表并做深度折叠", uilog.indexOf("MBVirtualList") > 0 && uilog.indexOf("deepFold") > 0, "");
  h.expect("启动链路登记 Bot 名并挂微操", con.indexOf("registerBot") > 0 && con.indexOf("motion-micro") > 0, "");
}
// 24b：整句式打字机——按字数等待，一次性发完整句。
async function checkTyping(h) {
  h.section("24b. 整句式打字机 / whole sentence typing");
  var typing = load("modules/typing.js");
  if (!typing) { h.expect("typing 可加载", false, "null"); return; }
  var whole = typing.planWhole("0123456789", { typing: true, cps: 10 });
  h.expect("等待时间 = 字数 ÷ 字/秒（10 字 / 10 字每秒 = 1000ms）",
    whole.ok === true && whole.waitMs === 1000 && whole.cps === 10, JSON.stringify(whole));
  h.expect("计划里只有一整段且不丢字",
    whole.segments.length === 1 && whole.segments[0] === "0123456789" && whole.mode === "whole", JSON.stringify(whole.segments));
  var longText = "";
  for (var i = 0; i < 200; i++) longText = longText + "长";
  var capped = typing.planWhole(longText, { typing: true, cps: 5 });
  h.expect("超长句等待被上限截断且仍是一整句",
    capped.capped === true && capped.waitMs === typing.MAX_WHOLE_DELAY_MS && capped.segments.length === 1, JSON.stringify({ waitMs: capped.waitMs }));
  var off = typing.planWhole("你好", { typing: false });
  h.expect("关闭打字机时零等待直发", off.waitMs === 0 && off.segments[0] === "你好", JSON.stringify(off));
  var calls = [];
  var bot = makeBot(calls, {});
  var res = typing.send(bot, "Hello world, 你好", { lang: "zh", typing: true, cps: 100 });
  h.expect("send 返回整句计划且只有 1 段",
    res.ok === true && res.segments === 1 && res.waitMs > 0 && res.chars > 0, JSON.stringify(res));
  h.expect("等待期间绝不提前吐出半句", calls.length === 0, JSON.stringify(calls));
  await wait(160);
  var chats = [];
  for (var k = 0; k < calls.length; k++) if (calls[k].indexOf("chat:") === 0) chats.push(calls[k].slice(5));
  h.expect("时间到后一次性发出完整句子，不是多段拼接",
    chats.length === 1 && chats[0].indexOf("你好") >= 0, JSON.stringify(chats));
  h.expect("状态里整句计数为 1 且无残留队列",
    typing.status(bot).whole === 1 && typing.status(bot).chunks === 1 && typing.status(bot).queued === 0,
    JSON.stringify(typing.status(bot)));
  typing.reset(bot);
}
// 24c：公屏防污染与禁绝私聊。
function checkFilter(h) {
  h.section("24c. 公屏防污染 / chat filter");
  var cf = load("modules/chat-filter.js");
  if (!cf) { h.expect("chat-filter 可加载", false, "null"); return; }
  cf.reset();
  h.expect("服务器系统提示被挡在 AI 上下文之外",
    cf.inspect("[Server] Saving the world", { sender: "Server" }).ok === false &&
    cf.inspect("Steve joined the game", { sender: "Steve" }).category === "system", "");
  h.expect("空消息与纯标点废话被过滤",
    cf.inspect("   ", { sender: "A" }).ok === false && cf.inspect("。。。！！！", { sender: "B" }).ok === false, "");
  h.expect("正常中文玩家可以进来（中文不是标点）",
    cf.inspect("帮我挖点石头，谢谢", { sender: "Steve" }).ok === true, "");
  var same = cf.inspect("刷屏消息", { sender: "Spam" });
  cf.inspect("刷屏消息", { sender: "Spam" });
  cf.inspect("刷屏消息", { sender: "Spam" });
  h.expect("复读到第 4 次判定为重复刷屏（前两次指令照常放行）",
    same.ok === true && cf.inspect("刷屏消息", { sender: "Spam" }).category === "flood", "");
  for (var i = 0; i < cf.FLOOD_MAX + 2; i++) cf.inspect("第 " + i + " 条不同内容", { sender: "Spam" });
  h.expect("同一玩家窗口内超量消息判定为刷屏",
    cf.inspect("再来一条", { sender: "Spam" }).category === "flood", JSON.stringify(cf.stats()));
  h.expect("斜杠指令回显不进上下文", cf.inspect("/tp Steve", { sender: "Steve" }).category === "commandEcho", "");
  cf.registerBot("BotAlpha");
  h.expect("Bot 名可登记且可识别", cf.isBot("botalpha") === true && cf.isBot("Steve") === false, "");
  h.expect("两个 Bot 无玩家指令时不自聊",
    cf.inspect("我们一起建房子吧", { sender: "BotAlpha" }).category === "botTalk" &&
    cf.gateReply("BotAlpha", {}).allowed === false, "");
  h.expect("玩家明确指令时放行 Bot 发言",
    cf.inspect("收到，马上开工", { sender: "BotAlpha", playerDirected: true }).ok === true &&
    cf.gateReply("BotAlpha", { playerDirected: true }).allowed === true, "");
  var st = cf.stats();
  h.expect("统计里能查到系统 / 刷屏 / 废话 / 自聊拦截数",
    st.seen > 0 && st.droppedSystem > 0 && st.droppedFlood > 0 && st.droppedBotTalk > 0, JSON.stringify(st));
  cf.reset();
}
// 24d：动作微操。
function checkMicro(h) {
  h.section("24d. 动作拟真微操 / motion micro");
  var mm = load("modules/motion-micro.js");
  if (!mm) { h.expect("motion-micro 可加载", false, "null"); return; }
  mm.reset();
  var calls = [];
  var bot = makeBot(calls, {});
  var sim = mm.simulate(bot, "m1", 80);
  h.expect("80 帧里出现视线游移与偶尔轻跳",
    sim.ok === true && sim.wanders >= 8 && sim.jumps >= 1, JSON.stringify(sim));
  h.expect("游移真的调用了 bot.look，跳跃真的改了控制状态",
    calls.join("|").indexOf("look:") >= 0 && calls.join("|").indexOf("ctrl:jump:true") >= 0, "");
  var around = mm.onDigDone(bot, "m1");
  h.expect("挖完方块环视一圈（4 段）", around.ok === true && around.steps === 4, JSON.stringify(around));
  mm.configure({ enabled: false });
  var silent = mm.walkTick(bot, "m1");
  h.expect("关闭拟真后微操全部归零", silent.action === "none" || silent.suppressed === true, JSON.stringify(silent));
  mm.configure({ enabled: true });
  var at = mm.attach(bot, "m2", {});
  h.expect("真实挂载 move 与 diggingCompleted 两个监听", at.ok === true && at.events === 2, JSON.stringify(at));
  var off = mm.detach(bot, "m2");
  h.expect("卸载摘掉两个监听", off.ok === true && off.removed === 2 && mm.stats("m2").attached === false, JSON.stringify(off));
  h.expect("统计里累计了游移 / 跳跃 / 环视", mm.stats("m1").totals.wanders > 0 && mm.stats("m1").totals.lookArounds > 0, JSON.stringify(mm.stats("m1")));
  mm.reset();
}
// 24e：AggregateError 双语底层诊断 + 网络层接线。
function checkNetwork(h) {
  h.section("24e. 网络报错底层化 / network diagnosis");
  var ed = load("modules/error-diagnose.js");
  var net = load("modules/network.js");
  if (!ed || !net) { h.expect("诊断与网络模块可加载", false, "null"); return; }
  ed.reset(); net.reset();
  var err = new Error("All promises were rejected");
  err.name = "AggregateError";
  err.errors = [
    Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:25565"), { code: "ECONNREFUSED", address: "127.0.0.1", port: 25565, syscall: "connect" }),
    Object.assign(new Error("Unsupported protocol version 765"), { code: "EPROTO", address: "mc.example.com", port: 25565 })
  ];
  var diag = ed.diagnose(err);
  h.expect("识别 AggregateError 并遍历全部 err.errors",
    diag.aggregate === true && diag.causes.length === 2, JSON.stringify(diag.causes.length));
  h.expect("逐条带出 code / 地址 / 端口",
    diag.causes[0].code === "ECONNREFUSED" && diag.causes[0].address === "127.0.0.1" && diag.causes[0].port === 25565,
    JSON.stringify(diag.causes[0]));
  h.expect("端口拒绝给出中英双语原因与排查建议",
    diag.causes[0].zh.indexOf("端口拒绝") >= 0 && diag.causes[0].en.indexOf("refused") >= 0 && diag.causes[0].fix.length > 0, "");
  h.expect("版本 / 协议不匹配被单独识别",
    diag.version === true && diag.causes[1].version === true && diag.causes[1].fix.indexOf("版本") >= 0, JSON.stringify(diag.causes[1]));
  var lines = ed.linesOf(err);
  h.expect("诊断行同时含中文与英文且列出两个原因",
    lines.join("\n").indexOf("端口拒绝") >= 0 && lines.join("\n").indexOf("refused") >= 0 && lines.length >= 6, "");
  var adv = ed.adviceOf("ETIMEDOUT");
  h.expect("adviceOf 对超时给出可执行建议", adv.ok === true && adv.fix.length > 0, JSON.stringify(adv));
  var rep = ed.report(err);
  h.expect("report 记住最近一次诊断且统计可见",
    ed.last() === rep && ed.stats().reports === 1 && ed.stats().aggregate >= 1, JSON.stringify(ed.stats()));
  h.expect("网络层暴露最近失败与统计接口",
    typeof net.lastError === "function" && net.stats().ok === true && typeof net.request === "function", "");
  ed.reset(); net.reset();
}
// 24f：断线不失忆快照。
function checkSnapshot(h) {
  h.section("24f. 断线不失忆 / state snapshot");
  var sm = load("modules/state-manager.js");
  if (!sm) { h.expect("state-manager 可加载", false, "null"); return; }
  var snap = sm.snapshot("p13a-1", { queue: [{ id: "t1", action: "挖矿" }, { id: "t2", action: "盖房" }], board: { wood: 12 }, position: { x: 1, y: 64, z: 3 } });
  h.expect("断线快照写入成功且带 2 个待办任务", snap.ok === true && snap.items === 2, JSON.stringify(snap));
  var back = sm.restore("p13a-1");
  h.expect("重连后自动读回中断的任务队列",
    back.ok === true && back.found === true && back.data.queue.length === 2 && back.data.queue[0].action === "挖矿", JSON.stringify(back.data && back.data.queue));
  h.expect("黑板状态与坐标一并恢复",
    back.data.board.wood === 12 && back.data.position.y === 64, JSON.stringify(back.data));
  h.expect("快照文件落在隔离目录（不碰真实 state）", snap.path.indexOf(TEMP_DIR) === 0, snap.path);
  h.expect("快照列表可查", sm.listSnapshots().indexOf("p13a-1") >= 0, JSON.stringify(sm.listSnapshots()));
  h.expect("不存在的 bot 不谎报恢复", sm.restore("nobody").found === false, "");
  h.expect("过期快照可拒绝（注入未来时间）", sm.restore("p13a-1", { maxAgeMs: 1000, now: Date.now() + 5000 }).found === false, "");
  h.expect("统计里能看到快照与命中数", sm.stats().snapshots >= 1 && sm.stats().hits >= 1, JSON.stringify(sm.stats()));
  h.expect("任务完成后可清理快照", sm.clearSnapshot("p13a-1") === true && sm.listSnapshots().indexOf("p13a-1") < 0, "");
}
// 24g：IO 缓存 30 秒异步落盘。
async function checkIoCache(h) {
  h.section("24g. IO 缓存防爆 / io cache");
  var io = load("modules/io-cache.js");
  var board = load("modules/shared-board.js");
  if (!io) { h.expect("io-cache 可加载", false, "null"); return; }
  io.reset();
  h.expect("默认落盘间隔是 30 秒", io.DEFAULT_INTERVAL_MS === 30000 && io.intervalMs() === 30000, "");
  io.put("board", { wood: 5 });
  io.putCoord("b1", { x: 10, y: 64, z: -3 });
  h.expect("写只进内存，磁盘上还没有文件（零同步 IO）",
    io.get("board").wood === 5 && io.getCoord("b1").x === 10 && fs.existsSync(io.pathOf()) === false, "");
  h.expect("脏键统计可见", io.stats().dirtyKeys === 2 && io.stats().entries === 2, JSON.stringify(io.stats()));
  var ok = io.flushNow();
  h.expect("同步 flush 后数据落盘且脏键清零",
    ok === true && fs.existsSync(io.pathOf()) === true && io.stats().dirtyKeys === 0, "");
  var doc = JSON.parse(fs.readFileSync(io.pathOf(), "utf8"));
  h.expect("落盘文档含数据与 30 秒周期标记", doc.data.board.wood === 5 && doc.intervalMs === 30000, JSON.stringify(doc).slice(0, 120));
  io.put("board", { wood: 9 });
  io.start(20);
  h.expect("IO 缓存周期定时器已启动", io.isActive() === true && io.intervalMs() === 20, "");
  if (board) {
    var before = readRel("modules/shared-board.js");
    h.expect("黑板落盘间隔读取 IO 缓存周期（接线存在）", before.indexOf("saveDelayMs()") > 0, "");
  }
  await wait(90);
  h.expect("周期到点后自动异步落盘", io.stats().asyncFlushes >= 1, JSON.stringify(io.stats()));
  var doc2 = JSON.parse(fs.readFileSync(io.pathOf(), "utf8"));
  h.expect("异步落盘写的是最新值", doc2.data.board.wood === 9, JSON.stringify(doc2.data));
  io.stop();
  h.expect("停止后定时器不再运行", io.isActive() === false, "");
  io.reset();
}
// 24h：前端虚拟列表与深度折叠纯逻辑。
function checkUI(h) {
  h.section("24h. 前端性能 / virtual list");
  var vl = load("gui/renderer/virtual-list.js");
  if (!vl) { h.expect("virtual-list 可加载", false, "null"); return; }
  vl.reset();
  var r = vl.visibleRange(2000, 200, 20, 5000);
  h.expect("5000 条日志只渲染可视区十几行，DOM 不随总量膨胀",
    r.rows < 20 && r.start >= 96 && r.end <= 115 && r.height === 100000, JSON.stringify(r));
  var bottom = vl.visibleRange(99960, 200, 20, 5000);
  h.expect("滚到底部不会越界", bottom.end === 5000 && bottom.rows < 20, JSON.stringify(bottom));
  h.expect("空列表不产生行", vl.visibleRange(0, 200, 20, 0).rows === 0, "");
  var plan = vl.foldPlan(9, 3);
  h.expect("高级面板超过阈值就深度折叠", plan.deep === true && plan.folds === 8, JSON.stringify(plan));
  h.expect("少量面板不折叠", vl.foldPlan(2, 3).folds === 0, "");
  h.expect("统计接口可读且未挂载时为 false", vl.stats().ok === true && vl.stats().mounted === false, JSON.stringify(vl.stats()));
  vl.reset();
}
// 主流程：隔离 state → 逐组跑 → 逐模块复位 → 还原环境。
async function run(h) {
  var OLD = process.env.MINEBOTS_STATE_DIR;
  try {
    safeRemove(TEMP_DIR);
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
    process.env.MINEBOTS_STATE_DIR = TEMP_DIR;
  } catch (eDir) { h.expect("临时 state 目录就绪", false, String(eDir)); }
  try { checkStatic(h); } catch (e1) { h.expect("24a 未抛错", false, String(e1)); }
  try { await checkTyping(h); } catch (e2) { h.expect("24b 未抛错", false, String(e2)); }
  try { checkFilter(h); } catch (e3) { h.expect("24c 未抛错", false, String(e3)); }
  try { checkMicro(h); } catch (e4) { h.expect("24d 未抛错", false, String(e4)); }
  try { checkNetwork(h); } catch (e5) { h.expect("24e 未抛错", false, String(e5)); }
  try { checkSnapshot(h); } catch (e6) { h.expect("24f 未抛错", false, String(e6)); }
  try { await checkIoCache(h); } catch (e7) { h.expect("24g 未抛错", false, String(e7)); }
  try { checkUI(h); } catch (e8) { h.expect("24h 未抛错", false, String(e8)); }
  try {
    var cf = load("modules/chat-filter.js");
    var mm = load("modules/motion-micro.js");
    var ed = load("modules/error-diagnose.js");
    var io = load("modules/io-cache.js");
    var vl = load("gui/renderer/virtual-list.js");
    if (cf) cf.reset();
    if (mm) mm.reset();
    if (ed) ed.reset();
    if (io) io.reset();
    if (vl) vl.reset();
    safeRemove(TEMP_DIR);
    if (OLD === undefined) delete process.env.MINEBOTS_STATE_DIR;
    else process.env.MINEBOTS_STATE_DIR = OLD;
    h.expect("临时 state 目录已清理、环境已还原", fs.existsSync(TEMP_DIR) === false, TEMP_DIR);
  } catch (eEnd) { h.expect("24i 收尾未抛错", false, String(eEnd)); }
}
module.exports = { run: run };
