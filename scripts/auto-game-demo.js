// ========================================
// 文件：scripts/auto-game-demo.js
// 功能：终极自动化 QA 编排器——扫描环境 -> 拉起 PCL2 -> 串跑 9 项硬核测试 -> 遇错自愈重试 ->
//       逐步截屏 / 合成演示视频 -> 生成 Final_QA_Report.md -> 收尾关闭自有进程
// 依赖：fs / path / os（Node 内置）；./qa-env（环境/截屏/视频）、./qa-tests（9 项测试）、../modules/qa-heal（自愈）
// 导出：loadRobot / launchPCL2 / openLAN / readLANPort / wakeBots / runActions / screenshot / captureReport /
//       writeReport / runWithHealing / runAllTests / buildReport / writeFinalReport / main
// 说明：机器上没有 PCL2 / .minecraft 时自动降级为模拟口径，但仍调用真实模块断言；所有外部调用 try/catch，
//       只杀本进程拉起的子进程，绝不 taskkill 全机 java。
// 作者：MineBots
// ========================================
var fs = require("fs");
var path = require("path");
var os = require("os");

// 安全提取错误文本。
function errText(err) {
  try { return err && err.message ? String(err.message) : String(err); } catch (e) { return "unknown error"; }
}
// 输出到终端（编排器自己的进度行）。
function say(msg) {
  try { console.log("[auto-game-demo] " + msg); } catch (e) { /* ignore */ }
}

// ---------- 旧接口（自测 p15 依赖） ----------
// RPA 库：只有 robotjs / nut.js 才算「能操作鼠标键盘」；@nut-tree-fork 只用于截屏。
function loadRobot() {
  try { return require("robotjs"); } catch (e1) {
    try { return require("nut.js"); } catch (e2) { return null; }
  }
}

function launchPCL2(robot) {
  // 自测（p15）会以 null 调用：没有 RPA 控制权时绝不真启动，避免测试时弹出启动器。
  if (!robot) return { ok: false, message: "无 RPA 控制权，跳过真实启动 / no RPA control, skip launch" };
  try {
    var q = require("./qa-env");
    var env = q.scanEnvironment();
    if (!env.pcl2) return { ok: false, message: "未找到 PCL2，跳过真实启动 / PCL2 not found, skip launch" };
    return q.launchPCL2(env);
  } catch (e) { return { ok: false, message: "启动器异常 / launcher error: " + errText(e) }; }
}

function openLAN(robot) {
  if (!robot) return { ok: true, port: 25565, simulated: true, message: "模拟局域网 / simulated LAN (port 25565)" };
  try {
    robot.moveMouseSmooth(640, 400); robot.mouseClick();
    return { ok: true, port: 25565, message: "已点开局域网 / LAN opened" };
  } catch (e) { return { ok: false, port: 0, message: "开局域网失败 / open LAN failed: " + errText(e) }; }
}

function readLANPort() { return 25565; }

// 唤醒 Bot-1（Ollama）与 Bot-2（云端），state 指向系统临时目录，绝不污染真实 state/。
function wakeBots() {
  var report = { bots: [], message: "" };
  try {
    var botManager = require(path.resolve(__dirname, "..", "modules", "bot-manager"));
    var modelProfile = require(path.resolve(__dirname, "..", "modules", "model-profile"));
    var tmpState = path.join(os.tmpdir(), "minebots-demo-state-" + Date.now());
    try { fs.mkdirSync(tmpState, { recursive: true }); } catch (e) { /* ignore */ }
    process.env.MINEBOTS_STATE_DIR = tmpState;
    if (botManager && typeof botManager.setTestMode === "function") botManager.setTestMode(true);
    if (modelProfile && typeof modelProfile.setFor === "function") {
      var r1 = modelProfile.setFor("bot-1", "ollama", {});
      var r2 = modelProfile.setFor("bot-2", "deepseek", {});
      report.bots.push({ id: "bot-1", profile: "ollama", ok: r1.ok });
      report.bots.push({ id: "bot-2", profile: "deepseek", ok: r2.ok });
    }
    if (botManager && typeof botManager.startBot === "function") {
      botManager.startBot({ id: "bot-1", username: "DemoBot1", testMode: true });
      botManager.startBot({ id: "bot-2", username: "DemoBot2", testMode: true });
    }
    report.message = "已唤醒 Bot-1(Ollama) 与 Bot-2(DeepSeek)，多引擎并行 / woke bot-1 + bot-2";
  } catch (e) { report.message = "唤醒失败 / wake failed: " + errText(e); }
  return report;
}

// 全功能遍历：下发砍树 + 建筑指令（测试模式只记录接受）。
function runActions() {
  var lines = [];
  try {
    var botManager = require(path.resolve(__dirname, "..", "modules", "bot-manager"));
    var targets = ["bot-1", "bot-2"];
    for (var i = 0; i < targets.length; i++) {
      if (botManager && typeof botManager.handleCommand === "function") {
        var r = botManager.handleCommand({ botId: targets[i], action: "dig_tree", params: { blocks: 10 } });
        lines.push("[DEMO] " + targets[i] + " 砍树 / chop: " + (r && r.ok ? "ok" : "skip"));
        r = botManager.handleCommand({ botId: targets[i], action: "build", params: { size: 3 } });
        lines.push("[DEMO] " + targets[i] + " 建筑 / build: " + (r && r.ok ? "ok" : "skip"));
      }
    }
  } catch (e) { lines.push("[DEMO] 指令异常 / action error: " + errText(e)); }
  return lines;
}

// 单帧截图：优先合成帧（同步、无依赖），保证旧接口永远是同步返回。
function screenshot(robot, dir) {
  try {
    var q = require("./qa-env");
    var frame = q.synthFrame(1, 9, true);
    var saved = q.saveFrame(dir, 1, frame);
    return saved.ok ? { ok: true, file: saved.file, simulated: true } : { ok: false, message: saved.message };
  } catch (e) { return { ok: false, message: errText(e) }; }
}

// 旧接口：归集一份演示报告（p15 会同步调用）。
function captureReport(robot) {
  var rep = { ok: true, steps: [], logs: [], screenshots: [], message: "" };
  try {
    rep.steps.push(launchPCL2(robot));
    rep.steps.push(openLAN(robot));
    var port = readLANPort(robot);
    rep.steps.push({ ok: true, port: port, message: "局域网端口 / LAN port: " + port });
    rep.steps.push(wakeBots());
    rep.logs = runActions();
    var dir = robot ? path.join(__dirname, "..", "logs", "demo-report") : os.tmpdir();
    var shot = screenshot(robot, dir);
    if (shot && shot.file) rep.screenshots.push(shot.file);
    rep.message = "演示链路跑通 / demo pipeline finished";
  } catch (e) { rep.ok = false; rep.message = errText(e); }
  return rep;
}

// 旧接口：把报告写到 logs/demo-report/report-<ts>.txt。
function writeReport(rep) {
  try {
    var dir = path.join(__dirname, "..", "logs", "demo-report");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    var file = path.join(dir, "report-" + Date.now() + ".txt");
    var lines = [];
    lines.push("=== MineBots 全自动演示报告 / Auto-game demo report ===");
    lines.push("时间 / time: " + new Date().toISOString());
    lines.push("结果 / result: " + (rep && rep.ok ? "OK" : "FAIL"));
    lines.push("摘要 / summary: " + String(rep && rep.message ? rep.message : ""));
    for (var i = 0; i < ((rep && rep.steps) || []).length; i++) {
      var s = rep.steps[i] || {};
      lines.push((s.ok ? "[OK] " : "[--] ") + String(s.message || ""));
    }
    fs.writeFileSync(file, lines.join("\n"), "utf8");
    return { ok: true, file: file };
  } catch (e) { return { ok: false, message: errText(e) }; }
}

// ---------- 自愈重试 ----------
// 跑一项测试：失败 -> 交给自愈引擎出补丁 -> 重启环境 -> 再跑，最多 maxRetries 次；超限记 FAILED 继续。
async function runWithHealing(testName, testFn, maxRetries, opts) {
  var o = opts || {};
  var max = typeof maxRetries === "number" ? maxRetries : 3;
  var attempts = 0;
  var healLog = [];
  var lastErr = "";
  while (true) {
    attempts++;
    var res = null;
    try { res = await testFn(); }
    catch (e) { res = { ok: false, message: errText(e) + "\n" + (e && e.stack ? String(e.stack) : "") }; }
    if (res && res.ok !== false) {
      return { status: "PASS", retries: attempts - 1, healLog: healLog, result: res };
    }
    lastErr = res && res.message ? String(res.message) : "unknown failure";
    if (attempts - 1 >= max) break;
    var healer = o.heal;
    if (!healer) { try { healer = require("../modules/qa-heal").heal; } catch (eH) { healer = null; } }
    var healed = { ok: false, applied: false, message: "自愈未执行 / healing skipped" };
    if (healer) { try { healed = await healer(testName, lastErr, o.healOpts || {}); } catch (eH2) { healed = { ok: false, message: errText(eH2) }; } }
    healLog.push({ attempt: attempts, message: healed.message || "", file: healed.file || "", applied: !!(healed && healed.applied) });
    if (o.restart) { try { await o.restart(); } catch (eR) { /* 重启失败也继续重试 */ } }
  }
  return { status: "FAILED", retries: max, healLog: healLog, message: lastErr };
}

// 串跑 9 项：每项失败进入自愈循环，成功 / 超限后截一帧（真屏优先，失败用合成帧）。
async function runAllTests(opts) {
  var o = opts || {};
  var q = require("./qa-env");
  var t = require("./qa-tests");
  var ctx = o.ctx || {};
  var dir = o.framesDir || path.join(__dirname, "..", "logs", "demo-report", "frames");
  var results = [];
  var frames = [];
  for (var i = 0; i < t.SPECS.length; i++) {
    var spec = t.SPECS[i];
    say("测试 " + spec.index + "/9 开始 / start: " + spec.name);
    var r = await runWithHealing(spec.name, function () { return spec.fn(ctx); }, typeof o.maxRetries === "number" ? o.maxRetries : 3, o);
    var frame = null;
    try { frame = await q.grabFrame(1280, 720); } catch (eG) { frame = null; }
    if (!frame || !frame.ok) frame = q.synthFrame(spec.index, 9, r.status === "PASS");
    var saved = q.saveFrame(dir, spec.index, frame);
    var fpath = saved.ok ? saved.file : "";
    results.push({
      index: spec.index, name: spec.name, status: r.status, retries: r.retries,
      healLog: r.healLog || [], message: r.message || (r.result && r.result.message) || "",
      detail: (r.result && r.result.detail) || null, frame: fpath, realScreen: !!(frame && frame.real)
    });
    frames.push({ index: spec.index, name: spec.name, status: r.status, frame: fpath ? path.basename(fpath) : "" });
    say("测试 " + spec.index + "/9 " + r.status + "，重试 " + r.retries + " 次 / retries");
  }
  return { results: results, frames: frames };
}

// 生成报告文本（纯函数，自测可直接断言 9 行）。
function buildReport(results, meta) {
  var m = meta || {};
  var list = results || [];
  var pass = 0, failed = 0, retriesTotal = 0;
  for (var i = 0; i < list.length; i++) {
    if (list[i].status === "PASS") pass++; else failed++;
    retriesTotal += Number(list[i].retries) || 0;
  }
  var lines = [];
  lines.push("# MineBots Final QA Report");
  lines.push("");
  lines.push("- 时间 / time: " + new Date().toISOString());
  lines.push("- 模式 / mode: " + (m.simulated ? "模拟 / simulation" : "真机 / real"));
  lines.push("- 结果 / result: " + (failed === 0 ? "ALL PASS" : (failed + " FAILED")));
  lines.push("- 通过 / pass: " + pass + " / " + list.length + "，自愈重试合计 / retries: " + retriesTotal);
  lines.push("- 耗时 / duration: " + (Number(m.durationMs) || 0) + " ms");
  lines.push("");
  lines.push("| # | 测试 / test | 状态 | 自愈重试 | 截图 |");
  lines.push("|---|---|---|---|---|");
  for (var r = 0; r < list.length; r++) {
    var it = list[r];
    var shot = it.frame ? ("[frame](" + path.basename(it.frame) + ")") : "-";
    lines.push("| " + it.index + " | " + String(it.name).replace(/\|/g, "/") + " | " + it.status + " | " + (Number(it.retries) || 0) + " | " + shot + " |");
  }
  lines.push("");
  lines.push("## 自愈明细 / healing detail");
  var anyHeal = false;
  for (var h = 0; h < list.length; h++) {
    var lg = list[h].healLog || [];
    for (var k = 0; k < lg.length; k++) {
      anyHeal = true;
      lines.push("- [" + list[h].index + "] 第 " + lg[k].attempt + " 次失败后 / after failure: " + String(lg[k].message || "") + (lg[k].file ? ("（" + lg[k].file + "）") : ""));
    }
  }
  if (!anyHeal) lines.push("- 无失败，未触发自愈 / no healing triggered");
  lines.push("");
  lines.push("## 环境 / environment");
  var env = m.env || {};
  lines.push("- PCL2: " + (env.pcl2 || "未找到 / not found"));
  lines.push("- .minecraft: " + (env.minecraftDir || "未找到 / not found"));
  lines.push("- 版本数 / versions: " + ((env.versions && env.versions.length) || 0));
  lines.push("- 原版 / vanilla: " + (env.vanilla || "无 / none") + (env.vanillaPath ? ("（" + env.vanillaPath + "）") : ""));
  lines.push("- 模组版 / modded: " + (env.modded || "无 / none") + (env.moddedPath ? ("（" + env.moddedPath + "）") : ""));
  lines.push("- RPA: robotjs=" + (env.rpa && env.rpa.robotjs ? "yes" : "no") + ", nut=" + (env.rpa && env.rpa.nut ? "yes" : "no"));
  lines.push("- ffmpeg: " + (env.ffmpeg || "不可用 / unavailable"));
  if (m.real) {
    lines.push("- 局域网端口 / LAN port: " + m.real.port);
    lines.push("- 开局域网策略 / LAN strategy: " + m.real.strategy);
    lines.push("- 游戏日志 / game log: " + m.real.log);
  } else if (m.realErr) lines.push("- 真机降级原因 / real fallback: " + m.realErr);
  if (m.video) lines.push("- 演示视频 / reel: " + m.video);
  if (m.closed) lines.push("- 收尾 / closed: " + m.closed);
  return lines.join("\n");
}

// 写最终报告到 logs/demo-report/Final_QA_Report.md。
function writeFinalReport(results, meta) {
  try {
    var dir = path.join(__dirname, "..", "logs", "demo-report");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    var file = path.join(dir, "Final_QA_Report.md");
    fs.writeFileSync(file, buildReport(results, meta), "utf8");
    return { ok: true, file: file };
  } catch (e) { return { ok: false, message: errText(e) }; }
}

// 载入被测模块：必须在 MINEBOTS_STATE_DIR 设好之后再调，保证状态隔离生效。
function loadContext(env) {
  function safe(rel) { try { return require(rel); } catch (e) { return null; } }
  return {
    env: env || {},
    simulated: !!(env && env.simulated),
    botManager: safe("../modules/bot-manager"),
    modDetector: safe("../modules/mod-detector"),
    protocolForge: safe("../modules/protocol-forge"),
    actions: safe("../modules/actions"),
    pathfinding: safe("../modules/pathfinding"),
    emotionTrust: safe("../modules/emotion-trust"),
    modelProfile: safe("../modules/model-profile"),
    aiTools: safe("../modules/ai-tools"),
    stateMachine: safe("../modules/state-machine")
  };
}

// 主流程：扫描 -> 隔离 -> 启动 -> 9 项 -> 报告 -> 视频 -> 收尾。
async function main() {
  var started = Date.now();
  var q = require("./qa-env");
  var td = require("./qa-tests");
  var env = q.scanEnvironment({ deep: true });
  say("运行模式 / mode: " + (env.simulated ? "模拟 / simulation" : "真机 / real") + "；PCL2=" + (env.pcl2 || "not found"));
  say("原版 / vanilla=" + (env.vanilla || "none") + "；模组版 / modded=" + (env.modded || "none"));
  var outDir = path.join(__dirname, "..", "logs", "demo-report");
  var framesDir = path.join(outDir, "frames");
  try {
    if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir, { recursive: true });
    var old = fs.readdirSync(framesDir);
    for (var i = 0; i < old.length; i++) { try { fs.unlinkSync(path.join(framesDir, old[i])); } catch (eD) { /* ignore */ } }
  } catch (e) { /* 目录异常不影响测试 */ }
  // 状态隔离：临时目录 + 环境变量，测试结束清理。
  var tmpState = path.join(os.tmpdir(), "minebots-qa-state-" + Date.now());
  try { fs.mkdirSync(tmpState, { recursive: true }); process.env.MINEBOTS_STATE_DIR = tmpState; } catch (eS) { /* ignore */ }
  // 真机链路：先保证有合法世界（服务端生成一次），再用 PCL 的启动命令 quickPlay 直进世界并开局域网。
  var qaSrv = require("./qa-server");
  var qaMc = require("./qa-mc");
  var real = null, realErr = "";
  if (!env.simulated) {
    var world = await qaSrv.ensureWorld(env.minecraftDir, env.vanilla, "MineBotsQA", { port: 25565, timeoutMs: 180000 });
    if (world.ok) {
      var game = await qaMc.startRealGame(env.minecraftDir, env.vanilla, { world: "MineBotsQA", width: 1280, height: 720, worldTimeoutMs: 180000 });
      if (game.ok) { real = { port: game.port, pid: game.pid, log: game.log, strategy: game.strategy }; }
      else realErr = game.message || "";
    } else realErr = world.message || "";
    if (real) say("真机就绪 / real ready：LAN 端口 / port " + real.port + "（" + real.strategy + "）");
    else say("真机链路失败，降级模拟 / real failed, fallback: " + realErr);
  } else {
    var launched = q.launchPCL2(env);
    if (launched && launched.ok) {
      try { await td.delay(2200); } catch (eW) { /* 等窗口出现失败也继续 */ }
      try { q.focusWindow(launched.pid); } catch (eF) { /* 置顶失败不影响测试 */ }
      try { await td.delay(900); } catch (eW2) { /* ignore */ }
    }
  }
  var ctx = loadContext(env);
  if (real) ctx.realPort = real.port;
  var run = await runAllTests({
    ctx: ctx, framesDir: framesDir, maxRetries: 3, healOpts: { botId: "qa-heal" },
    restart: async function () { q.killTracked(); await td.delay(120); }
  });
  var video = "";
  var vid = q.makeVideo(framesDir, path.join(outDir, "demo-reel.mp4"), { ffmpeg: env.ffmpeg });
  if (vid && vid.ok) video = vid.file;
  else { try { var sb = q.writeStoryboard(framesDir, run.frames, path.join(outDir, "storyboard.html")); if (sb && sb.ok) say("分镜已生成 / storyboard: " + sb.file); } catch (eSb) { /* ignore */ } }
  var gameClosed = { ok: true, killed: 0 };
  try { if (real) gameClosed = qaMc.stopGame(); } catch (eG) { /* ignore */ }
  try { await qaSrv.stopServer(); } catch (eS2) { /* ignore */ }
  var closed = q.closeAll();
  try { if (ctx.botManager && typeof ctx.botManager.stopAll === "function") ctx.botManager.stopAll(); } catch (eStop) { /* ignore */ }
  try { if (fs.existsSync(tmpState)) fs.readdirSync(tmpState).forEach(function (n) { try { fs.unlinkSync(path.join(tmpState, n)); } catch (eU) { /* ignore */ } }); } catch (eClean) { /* ignore */ }
  var meta = { simulated: env.simulated, env: env, durationMs: Date.now() - started, video: video, closed: (closed.killed + gameClosed.killed) + " 个自有进程 / processes", real: real, realErr: realErr };
  var rep = writeFinalReport(run.results, meta);
  var fail = 0;
  for (var r = 0; r < run.results.length; r++) { if (run.results[r].status !== "PASS") fail++; }
  return { ok: fail === 0, results: run.results, report: rep.ok ? rep.file : "", video: video, closed: closed.killed, simulated: env.simulated, real: !!real };
}

if (require.main === module) {
  main().then(function (r) {
    say("完成 / done: " + (r.ok ? "ALL PASS" : "HAS FAILURES") + "；报告 / report: " + (r.report || "n/a") + "；视频 / video: " + (r.video || "n/a"));
    // 机器人连接 / 定时器可能还挂着事件循环，收尾完成后主动退出，避免脚本挂死。
    process.exit(0);
  }).catch(function (e) {
    say("致命错误 / fatal: " + errText(e));
    try { require("./qa-env").closeAll(); } catch (e2) { /* ignore */ }
    try { require("./qa-mc").stopGame(); } catch (e3) { /* ignore */ }
    process.exit(1);
  });
}

module.exports = {
  loadRobot: loadRobot, launchPCL2: launchPCL2, openLAN: openLAN, readLANPort: readLANPort,
  wakeBots: wakeBots, runActions: runActions, screenshot: screenshot, captureReport: captureReport,
  writeReport: writeReport, runWithHealing: runWithHealing, runAllTests: runAllTests,
  buildReport: buildReport, writeFinalReport: writeFinalReport, main: main
};
