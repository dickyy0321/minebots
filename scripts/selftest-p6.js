// ========================================
// 文件：scripts/selftest-p6.js
// 功能：P6 回归自测——七大引擎默认全开 / 参数真落盘 / 关闭即停 / 实时生效 / 专家面板接线
// 依赖：path、fs、os；项目内模块（都可选，缺了记失败而不崩）
// 导出：run（由 scripts/selftest-p5.js 调用，复用 selftest.js 的 section / expect）
// 作者：MineBots
// ========================================
// 说明 / note：全程把 MINEBOTS_STATE_DIR 指到临时目录，绝不碰真实 state/prefs.json。
var path = require("path");
var fs = require("fs");
var os = require("os");
var ROOT = path.join(__dirname, "..");

// 按相对路径安全 require 一个模块；缺失或抛错时返回 null。
function load(rel) {
  try { return require(path.join(ROOT, rel)); } catch (e) { return null; }
}

// 按相对路径读文本；读不到返回空串。
function read(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch (e) { return ""; }
}

// 造一个最小可用的假 bot（带实体表 / 坐标 / 控制键接口）。
function makeBot() {
  var me = { position: { x: 0, y: 64, z: 0 } };
  return {
    _mbBotId: "p6-bot", entity: me, username: "P6Bot",
    setControlState: function () { return true; },
    entities: {
      self: me,
      p1: { username: "Steve", type: "player", position: { x: 10, y: 64, z: 0 } },
      m1: { name: "zombie", type: "mob", position: { x: -20, y: 64, z: 0 } },
      d1: { name: "item", type: "object", position: { x: 0, y: 64, z: 30 } },
      mid: { name: "creeper", type: "mob", position: { x: 50, y: 64, z: 0 } }
    }
  };
}

// 检查 P6 新文件的静态红线（行数 / 文件头 / 禁用语法）。
function checkStatic(h) {
  h.section("16l. 引擎控制静态红线 / engine control static");
  var files = ["modules/engine-control.js", "gui/renderer/panel-engine.js", "scripts/selftest-p6.js"];
  var allGood = true;
  for (var i = 0; i < files.length; i++) {
    var text = read(files[i]);
    var ok = text.length > 0 && text.split("\n").length <= 600 && text.indexOf("// ====") === 0;
    var bannedOptional = "?" + ".";
    var bannedNullish = "?" + "?";
    if (text.indexOf(bannedOptional) >= 0 || text.indexOf(bannedNullish) >= 0) ok = false;
    if (!ok) allGood = false;
  }
  h.expect("三个新文件通过行数 / 文件头 / 禁用语法检查", allGood, files.join(","));
  var ec = read("modules/engine-control.js");
  h.expect("控制中心注册 7 个引擎", (ec.split("key: \"").length - 1) >= 7, "engines");
  h.expect("控制中心不缓存配置（每次读盘）", ec.indexOf("function readPrefs") >= 0, "no cache");
}

// 默认全开：prefs.DEFAULTS / 控制中心状态 / Trace 的测试模式门控。
function checkDefaults(h) {
  h.section("16m. 七大模块默认全开 / all engines ON by default");
  var prefs = load("modules/prefs.js");
  var eng = load("modules/engine-control.js");
  if (!prefs || !eng) { h.expect("prefs 与 engine-control 可加载", false, "require failed"); return; }
  var flags = ["typing", "engRadar", "engMotion", "engTrace", "engAntiStuck", "engProtocolForge", "engBehaviorTree"];
  var allOn = true;
  for (var i = 0; i < flags.length; i++) if (prefs.DEFAULTS[flags[i]] !== true) allOn = false;
  h.expect("七个引擎开关默认值全为 true", allOn, JSON.stringify(flags));
  var st = eng.status();
  var enabled = 0;
  for (var j = 0; j < st.length; j++) if (st[j].enabled === true) enabled = enabled + 1;
  h.expect("控制中心列出 7 个引擎且全部 enabled", st.length === 7 && enabled === 7, JSON.stringify({ n: st.length, on: enabled }));
  h.expect("默认参数齐全：雷达 64 格 / 拟真 5 级 / 打字 30 字每秒",
    eng.param("radar", "radarRadius") === 64 && eng.param("motion", "motionStrength") === 5 &&
    eng.param("typing", "typingCps") === 30, JSON.stringify(eng.getAll().prefs));
  h.expect("Trace 开关默认开，但非测试模式下 effective 为 false",
    eng.isEnabled("trace") === true && eng.effective("trace") === false && eng.traceArmed() === false, "testModeOnly");
  var bootOff = eng.bootTrace();
  h.expect("非测试模式不跑启动链路", bootOff.ok === false && bootOff.armed === false, JSON.stringify(bootOff));
  eng.change({ testMode: true });
  h.expect("打开测试模式后 Trace 真正启用", eng.traceArmed() === true && eng.effective("trace") === true, "trace armed");
  var bootOn = eng.bootTrace();
  h.expect("测试模式才跑启动链路（仅在测试模式开启）", bootOn.ok === true && bootOn.armed === true, JSON.stringify(bootOn));
  eng.change({ testMode: false });
}

// 落盘与实时广播：prefs.save 真写文件并往事件总线发 engine.changed。
function checkPersist(h) {
  h.section("16n. 参数写盘与实时广播 / persistence & live broadcast");
  var prefs = load("modules/prefs.js");
  var eng = load("modules/engine-control.js");
  var bus = load("modules/event-bus.js");
  if (!prefs || !eng || !bus) { h.expect("三个模块可加载", false, "require failed"); return; }
  var hits = 0;
  var un = bus.on("engine.changed", function () { hits = hits + 1; });
  var changed = eng.change({ radarRadius: 32, typingCps: 60 });
  if (un) un();
  h.expect("参数变更返回 ok:true", changed.ok === true, JSON.stringify(changed.message));
  h.expect("事件总线收到 engine.changed 实时广播", hits === 1, String(hits));
  var raw = "";
  try { raw = fs.readFileSync(prefs.getPath(), "utf8"); } catch (e) { raw = ""; }
  var parsed = null;
  try { parsed = JSON.parse(raw); } catch (e2) { parsed = null; }
  h.expect("state/prefs.json 真的写出了 32 格与 60 字每秒",
    !!parsed && parsed.radarRadius === 32 && parsed.typingCps === 60, raw.slice(0, 160));
  h.expect("下一次读取立刻拿到新值（无需重启）",
    eng.param("radar", "radarRadius") === 32 && eng.param("typing", "typingCps") === 60, "live");
  var bad = eng.change({ radarRadius: 9999, motionStrength: -3, typingCps: 999 });
  h.expect("越界参数被夹回合法范围",
    bad.ok === true && eng.param("radar", "radarRadius") === 128 &&
    eng.param("motion", "motionStrength") === 1 && eng.param("typing", "typingCps") === 120, "clamped");
  eng.reset();
}

// 关闭即停：七个模块逐一验证「不再工作」，再逐一验证恢复默认后立刻复活。
async function checkDisable(h) {
  h.section("16o. 关闭开关后模块停止 / switches really stop engines");
  var eng = load("modules/engine-control.js");
  var radar = load("modules/radar.js");
  var telemetry = load("modules/telemetry.js");
  var motion = load("modules/motion.js");
  var typing = load("modules/typing.js");
  var tr = load("modules/test-runner.js");
  var stuck = load("modules/anti-stuck.js");
  var forge = load("modules/protocol-forge.js");
  var bt = load("modules/behavior-tree.js");
  var goap = load("modules/goap.js");
  if (!eng || !radar || !motion || !typing || !tr || !stuck || !forge || !bt || !goap || !telemetry) {
    h.expect("九个底层模块可加载", false, "require failed");
    return;
  }
  var patch = {
    engRadar: false, engMotion: false, engTrace: false, engAntiStuck: false,
    typing: false, engProtocolForge: false, engBehaviorTree: false
  };
  var saved = eng.change(patch);
  h.expect("七个开关同时关闭并写入成功", saved.ok === true, JSON.stringify(saved.message));
  var bot = makeBot();

  // 1. 雷达：不扫描、不推送，遥测快照 radar 为 null。
  var snap = radar.scan(bot);
  h.expect("关闭雷达后不再扫描实体", snap.ok === false && snap.enabled === false && snap.entities.length === 0, JSON.stringify(snap.message));
  h.expect("关闭雷达后 isEnabled 为 false", radar.isEnabled() === false, "flag");
  var tel = telemetry.getBotState(bot);
  h.expect("关闭雷达后遥测快照不再推送 radar 数据", tel && tel.radar === null, JSON.stringify(tel && tel.radar));

  // 2. 拟真：噪声归零、延迟变确定值。
  h.expect("关闭拟真后高斯噪声归零", motion.clampedNoise(1) === 0 && motion.getConfig().enabled === false, "motion");
  h.expect("关闭拟真后延迟不再随机", motion.humanDelayMs(100, 100) === 150, "delay");

  // 3. Trace：不生成 Trace ID、不调用底层。
  var calls = 0;
  var trace = await tr.run("P6 关闭链路", [{ name: "底层 / bottom", delayMs: 0, call: function () { calls = calls + 1; return { ok: true }; } }], { failureRate: 0 });
  h.expect("关闭 Trace 后不生成链路也不调底层", trace.disabled === true && trace.steps === 0 && calls === 0, JSON.stringify(trace));

  // 4. 防卡死：不再挂看门狗。
  var stuckBot = makeBot();
  var handle = stuck.attach(stuckBot, { x: 40, y: 64, z: 40 }, null);
  h.expect("关闭防卡死后不挂看门狗", stuck.isActive(stuckBot) === false && stuck.isEngineEnabled() === false, "anti-stuck");
  if (handle && typeof handle.stop === "function") handle.stop();

  // 5. 打字机：开关关闭后整句一次发出。
  var plan = typing.plan("Hello world, this is a test.");
  h.expect("关闭打字机后整句一次发出", plan.mode === "off" && plan.segments.length === 1, JSON.stringify(plan));

  // 6. 协议穿透：不伪装品牌、不重试模组错误。
  var decorated = forge.decorate({ host: "mc.example.com" });
  var login = forge.onLoginError({ id: "p6" }, "missing registry", {});
  h.expect("关闭协议穿透后不再品牌伪装", decorated.brand === undefined && decorated.host === "mc.example.com", JSON.stringify(decorated));
  h.expect("关闭协议穿透后不处理模组错误", login.disabled === true && login.handled === false && login.retried === false, JSON.stringify(login));

  // 7. 行为树 / GOAP：不执行节点、不产出规划链。
  var made = bt.create({ type: "action", fn: function () { return true; } });
  var ticked = await bt.tick(made.tree, {});
  var goapPlan = goap.plan("木镐", {});
  h.expect("关闭行为树后不执行任何节点", ticked.status === "disabled" && ticked.ran === 0, JSON.stringify(ticked));
  h.expect("关闭行为树后 GOAP 不产出规划链", goapPlan.chain.length === 0 && goapPlan.disabled === true, JSON.stringify(goapPlan));

  // 恢复默认全开：不重新 require，验证「实时生效、无需重启」。
  eng.reset();
  var snap2 = radar.scan(bot);
  h.expect("恢复默认后雷达立刻复活并扫到实体", snap2.ok === true && snap2.entities.length >= 4, JSON.stringify(snap2.counts));
  h.expect("恢复默认后遥测快照重新带雷达", telemetry.getBotState(bot).radar !== null, "radar back");
  h.expect("恢复默认后拟真 / 打字机 / 协议穿透复活",
    motion.getConfig().enabled === true && typing.plan("Hello world, this is a test.").mode === "chunk" &&
    forge.decorate({}).brand === forge.BRAND, "restored");
  var revived = await tr.run("P6 复活链路", [{ name: "底层 / bottom", delayMs: 0, call: function () { return { ok: true }; } }], { failureRate: 0 });
  h.expect("恢复默认后 Trace 链路重新可跑", revived.ok === true && revived.steps === 1, JSON.stringify(revived));
  var revivedPlan = goap.plan("木镐", {});
  h.expect("恢复默认后 GOAP 重新推导木镐链", revivedPlan.ok === true && revivedPlan.chain.length === 4, revivedPlan.chain.join(","));
  var revivedTree = await bt.tick(bt.create({ type: "action", fn: function () { return true; } }).tree, {});
  h.expect("恢复默认后行为树重新执行", revivedTree.ok === true && revivedTree.ran === 1, JSON.stringify(revivedTree));
  var stuckBot2 = makeBot();
  var handle2 = stuck.attach(stuckBot2, { x: 40, y: 64, z: 40 }, null);
  h.expect("恢复默认后防卡死重新挂表", stuck.isActive(stuckBot2) === true, "watchdog back");
  if (handle2 && typeof handle2.stop === "function") handle2.stop();
}

// 参数确实改变底层行为：雷达范围 / 打字速度 / 故障率 / 拟真强度。
async function checkParams(h) {
  h.section("16p. 参数实时改变底层行为 / params really applied");
  var eng = load("modules/engine-control.js");
  var radar = load("modules/radar.js");
  var typing = load("modules/typing.js");
  var motion = load("modules/motion.js");
  var forge = load("modules/protocol-forge.js");
  if (!eng || !radar || !typing || !motion || !forge) { h.expect("五个模块可加载", false, "require failed"); return; }
  var text = "Hello world, this is a test.";
  var slow = typing.plan(text).gapMs;
  eng.change({ radarRadius: 32, typingCps: 60, motionStrength: 10, protocolMaxRetry: 0 });
  h.expect("雷达范围参数被控制中心读到", eng.param("radar", "radarRadius") === 32, "radius");
  var bot = makeBot();
  var snap = radar.scan(bot);
  h.expect("32 格范围过滤掉 50 格外的实体", snap.radius === 32 && snap.entities.length === 3, JSON.stringify(snap.counts));
  var fast = typing.plan(text).gapMs;
  h.expect("打字速度改到 60 字每秒后段间隔变短", fast > 0 && fast < slow, JSON.stringify({ slow: slow, fast: fast }));
  h.expect("拟真强度改到 10 级后配置读回为 10", motion.getConfig().strength === 10, JSON.stringify(motion.getConfig()));
  var retry = forge.onLoginError({ id: "p6-retry" }, "missing registry", {});
  h.expect("模组重试上限改成 0 后不再重试", retry.retried === false && retry.handled === true, JSON.stringify(retry));
  eng.reset();
  h.expect("复位后雷达范围回到 64 格", radar.configuredRadius() === 64, "reset");
}

// 专家面板接线：HTML / CSS / app / events / 面板 schema 一致性。
function checkUi(h) {
  h.section("16q. 专家模式引擎面板接线 / expert engine panel");
  var html = read("gui/renderer/settings.html");
  h.expect("底层引擎控制折叠面板存在", html.indexOf('id="enginePane"') >= 0 && html.indexOf("底层引擎控制 / Engine Control") >= 0, "enginePane");
  h.expect("面板容器与恢复按钮存在", html.indexOf('id="engineControls"') >= 0 && html.indexOf('id="engineResetBtn"') >= 0, "controls");
  h.expect("panel-engine.js 被页面引用", html.indexOf("panel-engine.js") >= 0, "script");
  h.expect("无 i18n 缺失风险的纯双语文案", html.indexOf("恢复默认全开 / Restore all ON") >= 0, "bilingual");
  var css = read("gui/renderer/style.css");
  h.expect("拨动开关与新手模式隐藏样式齐全", css.indexOf(".engine-switch:checked") >= 0 && css.indexOf("body.mode-novice .engine-pane") >= 0, "css");
  var app = read("gui/renderer/app.js");
  h.expect("app 启动时初始化引擎面板", app.indexOf("window.panelEngine.init()") >= 0, "app init");
  var events = read("gui/renderer/events.js");
  h.expect("偏好回包会回填引擎面板", events.indexOf("window.panelEngine.fill(data)") >= 0, "fill");
  var panel = read("gui/renderer/panel-engine.js");
  var flags = ["engRadar", "engMotion", "engTrace", "engAntiStuck", '"typing"', "engProtocolForge", "engBehaviorTree"];
  var allFlags = true;
  for (var i = 0; i < flags.length; i++) if (panel.indexOf(flags[i]) < 0) allFlags = false;
  h.expect("面板 7 个独立 Toggle 与注册表一致", allFlags, flags.join(","));
  h.expect("面板参数含雷达范围 / 拟真强度 / 打字速度",
    panel.indexOf("radarRadius") >= 0 && panel.indexOf("motionStrength") >= 0 && panel.indexOf("typingCps") >= 0, "params");
  h.expect("面板改动走既有 prefsSave 通道（真落盘）", panel.indexOf("window.api.prefsSave") >= 0, "ipc");
  var prefsSrc = read("modules/prefs.js");
  h.expect("主进程保存时广播 engine.changed", prefsSrc.indexOf('engine.changed') >= 0, "broadcast");
  var main = read("gui/main.js");
  h.expect("主进程按测试模式决定是否启用 Trace", main.indexOf('"bootTrace"') >= 0, "main wiring");
  h.expect("main.js 仍在 600 行上限内", main.split("\n").length <= 600, String(main.split("\n").length));
}

// 主流程：在隔离的 state 目录里跑完全部分组；异常只记一条失败，不让整轮自检崩。
async function run(h) {
  var tmp = "";
  var oldDir = process.env.MINEBOTS_STATE_DIR;
  var oldTypingEnv = process.env.MINEBOTS_TYPING;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mb-p6-engine-"));
    process.env.MINEBOTS_STATE_DIR = tmp;
    // 总自测把打字机全局直发关掉以便跑老用例；本段要验证 prefs 开关，先恢复成配置驱动。
    process.env.MINEBOTS_TYPING = "";
    try { checkStatic(h); } catch (e1) { h.expect("16l 未抛错", false, String(e1)); }
    try { checkDefaults(h); } catch (e2) { h.expect("16m 未抛错", false, String(e2)); }
    try { checkPersist(h); } catch (e3) { h.expect("16n 未抛错", false, String(e3)); }
    try { await checkDisable(h); } catch (e4) { h.expect("16o 未抛错", false, String(e4)); }
    try { await checkParams(h); } catch (e5) { h.expect("16p 未抛错", false, String(e5)); }
    try { checkUi(h); } catch (e6) { h.expect("16q 未抛错", false, String(e6)); }
  } finally {
    try {
      if (oldDir === undefined) delete process.env.MINEBOTS_STATE_DIR;
      else process.env.MINEBOTS_STATE_DIR = oldDir;
    } catch (e7) { /* 环境变量恢复失败不影响汇总 */ }
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch (e8) { /* 临时目录清不掉不影响主流程 */ }
    try {
      if (oldTypingEnv === undefined) delete process.env.MINEBOTS_TYPING;
      else process.env.MINEBOTS_TYPING = oldTypingEnv;
    } catch (e9) { /* 环境变量恢复失败不影响汇总 */ }
  }
}

module.exports = { run: run };
