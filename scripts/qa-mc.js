// ========================================
// 文件：scripts/qa-mc.js
// 功能：真机链路——解析 PCL 的 LatestLaunch.bat，预建世界并直接 quickPlay 进世界，再自动开局域网并从日志抓端口
// 依赖：fs / path / os / zlib / child_process（Node 内置）、prismarine-nbt（可选）、@nut-tree-fork/nut-js（可选）
// 导出：splitWinArgs / readLaunch / prepareWorld / launchGame / waitForWorld / openLAN / startRealGame / stopGame / readPort
// 说明：只杀自己拉起的游戏进程（taskkill /T 只作用于该 PID 的进程树）；任何一步失败都返回 ok:false 并带日志尾巴，
//       由编排器决定降级为模拟，绝不挂死。
// 作者：MineBots
// ========================================
var fs = require("fs");
var path = require("path");
var zlib = require("zlib");
var cp = require("child_process");

var logger = null;
try { logger = require("../modules/logger"); } catch (e) { logger = null; }
var nbt = null;
try { nbt = require("prismarine-nbt"); } catch (e2) { nbt = null; }

var ROOT = path.join(__dirname, "..");
// 已拉起的游戏进程（只收尾这些）。
var gameChild = null;
var gameLog = "";
var gamePid = 0;

function errText(err) {
  try { return err && err.message ? String(err.message) : String(err); } catch (e) { return "unknown error"; }
}
function say(msg) {
  try { if (logger && typeof logger.info === "function") { logger.info("[qa-mc] " + msg); return; } } catch (e) { /* console */ }
  try { console.log("[qa-mc] " + msg); } catch (e2) { /* ignore */ }
}
function exists(p) {
  try { return !!p && fs.existsSync(p); } catch (e) { return false; }
}
function qdelay(ms) {
  var wait = Math.max(0, Math.min(Number(ms) || 0, 10000));
  return new Promise(function (resolve) { try { setTimeout(resolve, wait); } catch (e) { resolve(); } });
}

// 按 Windows 命令行规则切分（双引号内空格不切，引号本身去掉）。
function splitWinArgs(line) {
  var out = [], cur = "", inQuote = false;
  var text = String(line === null || line === undefined ? "" : line);
  for (var i = 0; i < text.length; i++) {
    var ch = text.charAt(i);
    if (ch === "\"") { inQuote = !inQuote; continue; }
    if ((ch === " " || ch === "\t") && !inQuote) {
      if (cur.length > 0) { out.push(cur); cur = ""; }
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

// 从 <pcl>/PCL/LatestLaunch.bat 里解析出 java 路径与完整参数。
function readLaunch(mcDir, versionId) {
  try {
    var pclDir = path.join(path.dirname(mcDir), "PCL");
    var bat = path.join(pclDir, "LatestLaunch.bat");
    if (!exists(bat)) return { ok: false, message: "缺少 PCL/LatestLaunch.bat / launcher script missing" };
    var lines = String(fs.readFileSync(bat, "utf8")).split(/\r?\n/);
    var hit = "";
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf("net.minecraft.client.main.Main") >= 0) { hit = lines[i]; break; }
    }
    if (!hit) return { ok: false, message: "启动脚本里没有 Main 命令行 / no Main command" };
    var argv = splitWinArgs(hit);
    if (argv.length < 3) return { ok: false, message: "启动命令解析失败 / parse failed" };
    // 清掉 PCL 没替换的占位符（${clientid} / ${auth_xuid}），避免把字面量喂给游戏。
    for (var a = 0; a < argv.length; a++) {
      if (argv[a].indexOf("${") >= 0) argv[a] = "0";
    }
    var args = argv.slice(1);
    // 读出版本对应的 gameDir（PCL 版本隔离时是 versions/<id>）。
    var gameDir = "";
    for (var g = 0; g < args.length; g++) {
      if (args[g] === "--gameDir" && args[g + 1]) { gameDir = args[g + 1]; break; }
    }
    if (!gameDir) gameDir = path.join(mcDir, "versions", String(versionId || ""));
    return { ok: true, java: argv[0], args: args, gameDir: gameDir, width: 1280, height: 720 };
  } catch (e) { return { ok: false, message: "读取启动脚本失败 / read launch failed: " + errText(e) }; }
}

// 往 options.txt 里合并键值（保留原文件其它行），并按需覆盖。
function mergeOptions(gameDir, pairs) {
  try {
    var file = path.join(gameDir, "options.txt");
    var lines = [];
    try { if (exists(file)) lines = String(fs.readFileSync(file, "utf8")).split(/\r?\n/); } catch (e) { lines = []; }
    var map = {};
    for (var i = 0; i < lines.length; i++) {
      var cut = lines[i].indexOf(":");
      if (cut > 0) map[lines[i].slice(0, cut)] = lines[i].slice(cut + 1);
    }
    for (var k in pairs) { if (Object.prototype.hasOwnProperty.call(pairs, k)) map[k] = String(pairs[k]); }
    var out = [];
    for (var key in map) { if (Object.prototype.hasOwnProperty.call(map, key)) out.push(key + ":" + map[key]); }
    if (!exists(gameDir)) fs.mkdirSync(gameDir, { recursive: true });
    fs.writeFileSync(file, out.join("\n") + "\n", "utf8");
    return { ok: true, file: file };
  } catch (e) { return { ok: false, message: "写 options.txt 失败 / options failed: " + errText(e) }; }
}

// 生成一个可加载的 level.dat（1.21.1 会自动补全缺失字段并生成地形）。
function writeLevelDat(worldDir, worldName) {
  if (!nbt) return { ok: false, message: "prismarine-nbt 不可用 / nbt unavailable" };
  try {
    if (!exists(worldDir)) fs.mkdirSync(worldDir, { recursive: true });
    // 已有合法世界（比如服务端生成的）绝不覆盖，否则会把好档写坏。
    if (exists(path.join(worldDir, "level.dat"))) return { ok: true, dir: worldDir, skipped: true };
    var now = Date.now();
    var hi = Math.floor(now / 4294967296);
    var lo = now >>> 0;
    // nbt.long 接收 [高 32 位, 低 32 位]，低 32 位必须按有符号整数传，否则会越界。
    if (lo > 0x7FFFFFFF) lo = lo - 0x100000000;
    var doc = nbt.comp({
      Data: nbt.comp({
        DataVersion: nbt.int(3953),
        version: nbt.comp({ Id: nbt.int(3953), Name: nbt.string("1.21.1"), Series: nbt.string("main"), Snapshot: nbt.byte(0) }),
        LevelName: nbt.string(String(worldName)),
        GameType: nbt.int(1),
        Difficulty: nbt.byte(1),
        DifficultyLocked: nbt.byte(0),
        hardcore: nbt.byte(0),
        allowCommands: nbt.byte(1),
        initialized: nbt.byte(0),
        generatorName: nbt.string("minecraft:normal"),
        generatorVersion: nbt.int(0),
        RandomSeed: nbt.long([0, 20261114]),
        LastPlayed: nbt.long([hi, lo]),
        Time: nbt.long([0, 0]),
        DayTime: nbt.long([0, 6000]),
        SpawnX: nbt.int(0), SpawnY: nbt.int(64), SpawnZ: nbt.int(0),
        raining: nbt.byte(0), snowing: nbt.byte(0), thundering: nbt.byte(0),
        rainTime: nbt.int(0), snowTime: nbt.int(0), thunderTime: nbt.int(0), clearWeatherTime: nbt.int(0),
        WasModded: nbt.byte(0),
        DataPacks: nbt.comp({
          Enabled: { type: "list", value: { type: "string", value: ["vanilla"] } },
          Disabled: { type: "list", value: { type: "string", value: [] } }
        }),
        ServerBrands: { type: "list", value: { type: "string", value: ["vanilla"] } }
      })
    });
    var raw = nbt.writeUncompressed(doc, "big");
    fs.writeFileSync(path.join(worldDir, "level.dat"), zlib.gzipSync(raw));
    return { ok: true, dir: worldDir };
  } catch (e) { return { ok: false, message: "生成 level.dat 失败 / level.dat failed: " + errText(e) }; }
}

// 预建世界 + 写好 options（小窗口、简体中文、关声音、关失焦暂停、跳过教程）。
function prepareWorld(gameDir, worldName) {
  try {
    var opts = mergeOptions(gameDir, {
      version: "3955", lang: "zh_CN", guiScale: "2", fullscreen: "false",
      pauseOnLostFocus: "false", skipMultiplayerWarning: "true", skipRealms32bitWarning: "true",
      tutorialStep: "none", onboardAccessibility: "false", renderDistance: "4", simulationDistance: "5",
      graphicsMode: "0", maxFps: "60", soundCategory_master: "0", narrator: "0", autoJump: "false", gamma: "1.0"
    });
    if (!opts.ok) return opts;
    var worldDir = path.join(gameDir, "saves", String(worldName));
    var made = writeLevelDat(worldDir, worldName);
    if (!made.ok) return made;
    return { ok: true, world: worldName, dir: worldDir, options: opts.file };
  } catch (e) { return { ok: false, message: "准备世界失败 / prepare world failed: " + errText(e) }; }
}

// 覆盖 --width / --height / 追加 quickPlay；returns new args。
function buildArgs(args, opts) {
  var o = opts || {};
  var out = [];
  for (var i = 0; i < args.length; i++) {
    if (args[i] === "--width") { out.push("--width", String(o.width || 1280)); i++; continue; }
    if (args[i] === "--height") { out.push("--height", String(o.height || 720)); i++; continue; }
    if (args[i] === "--quickPlaySingleplayer") { i++; continue; }
    out.push(args[i]);
  }
  if (o.world) out.push("--quickPlaySingleplayer", String(o.world));
  if (o.fullscreen) out.push("--fullscreen");
  return out;
}

// 启动游戏：java 直接起（不经 bat），stdout/stderr 落日志，方便按日志判断进度与端口。
function launchGame(mcDir, versionId, opts) {
  var o = opts || {};
  var launch = readLaunch(mcDir, versionId);
  if (!launch.ok) return launch;
  if (!exists(launch.java)) return { ok: false, message: "Java 不存在 / java missing: " + launch.java };
  var prep = prepareWorld(launch.gameDir, o.world || "MineBotsQA");
  if (!prep.ok) return prep;
  var envW = Number(process.env.MINEBOTS_QA_WIDTH) || 0, envH = Number(process.env.MINEBOTS_QA_HEIGHT) || 0;
  var args = buildArgs(launch.args, { world: o.world || "MineBotsQA", width: envW || o.width || 1280, height: envH || o.height || 720, fullscreen: process.env.MINEBOTS_QA_FULLSCREEN === "1" });
  var logDir = path.join(launch.gameDir, "logs");
  try { if (!exists(logDir)) fs.mkdirSync(logDir, { recursive: true }); } catch (eL) { /* ignore */ }
  var logPath = path.join(logDir, "qa-mc-" + Date.now() + ".log");
  try {
    var child = cp.spawn(launch.java, args, { cwd: launch.gameDir, stdio: ["ignore", "pipe", "pipe"], windowsHide: false });
    if (!child || !child.pid) return { ok: false, message: "游戏进程启动失败 / spawn failed" };
    gameChild = child; gamePid = child.pid; gameLog = logPath;
    try { fs.writeFileSync(logPath, "", "utf8"); } catch (eW) { /* ignore */ }
    var pipe = function (buf) {
      try { fs.appendFileSync(logPath, buf); } catch (eA) { /* ignore */ }
    };
    try { child.stdout.on("data", pipe); } catch (e1) { /* ignore */ }
    try { child.stderr.on("data", pipe); } catch (e2) { /* ignore */ }
    try { child.on("exit", function () { gameChild = null; }); } catch (e3) { /* ignore */ }
    return { ok: true, pid: child.pid, log: logPath, gameDir: launch.gameDir, world: prep.world, java: launch.java };
  } catch (e) { return { ok: false, message: "启动游戏异常 / launch error: " + errText(e) }; }
}

// 读日志尾巴（最多 120KB），失败返回空串。
function tailLog(logPath) {
  try {
    if (!logPath || !exists(logPath)) return "";
    var size = fs.statSync(logPath).size;
    var start = Math.max(0, size - 120000);
    var fd = fs.openSync(logPath, "r");
    var buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    try { fs.closeSync(fd); } catch (eC) { /* ignore */ }
    return buf.toString("utf8");
  } catch (e) { return ""; }
}

// 等世界加载完：日志出现 Preparing spawn / Time elapsed / Loaded ... recipes 即算进服。
async function waitForWorld(logPath, timeoutMs) {
  var deadline = Date.now() + (Number(timeoutMs) || 90000);
  var last = "";
  while (Date.now() < deadline) {
    last = tailLog(logPath);
    if (/Preparing spawn area|Time elapsed|Loaded \d+ recipes|Started serving|Local game hosted/i.test(last)) {
      return { ok: true, message: "世界已加载 / world loaded" };
    }
    if (/Failed to load|Failed to start|Exception in thread "main"/i.test(last)) {
      return { ok: false, message: "世界加载失败 / world load failed", tail: last.slice(-800) };
    }
    if (!gameChild) return { ok: false, message: "游戏进程已退出 / game exited", tail: last.slice(-800) };
    await qdelay(1200);
  }
  return { ok: false, message: "等待世界超时 / world timeout", tail: last.slice(-800) };
}

// 从日志里抓局域网端口。
function readPort(logPath) {
  var text = arguments.length > 0 && logPath ? tailLog(logPath) : "";
  var re = /(?:Started serving on|Local game hosted on(?: port)?|局域网.*端口)[\s:：]*[0-9a-f.:]*?(\d{2,5})/i;
  var m = text.match(re);
  if (m && m[1]) return Number(m[1]);
  return 0;
}

// 键盘 / 鼠标自动开局域网：多套策略，日志出现端口即成功。
async function openLAN(logPath, opts) {
  var o = opts || {};
  var width = Number(o.width) || 1280, height = Number(o.height) || 720;
  var nut = null;
  try { nut = require("@nut-tree-fork/nut-js"); } catch (e) { nut = null; }
  if (!nut) return { ok: false, message: "nut-js 不可用，无法自动开局域网 / nut unavailable" };
  var keyboard = nut.keyboard, mouse = nut.mouse, Key = nut.Key, Button = nut.Button;
  var clicked = async function (x, y) {
    try { await mouse.setPosition({ x: Math.round(x), y: Math.round(y) }); await mouse.click(Button.LEFT); } catch (e) { /* ignore */ }
  };
  var key = async function (k) { try { await keyboard.pressKey(k); } catch (e) { /* ignore */ } };
  var attempt = async function (pauseTabs, lanTabs) {
    try { await key(Key.Escape); await qdelay(800); } catch (eEsc) { /* ignore */ }
    for (var t = 0; t < pauseTabs; t++) { try { await key(Key.Tab); await qdelay(130); } catch (eT) { /* ignore */ } }
    try { await key(Key.Enter); await qdelay(1300); } catch (eE) { /* ignore */ }
    for (var u = 0; u < lanTabs; u++) { try { await key(Key.Tab); await qdelay(130); } catch (eT2) { /* ignore */ } }
    try { await key(Key.Enter); await qdelay(2200); } catch (eE2) { /* ignore */ }
    return readPort(logPath) > 0;
  };
  // 实测序列（1.21.1 / 1280x720 / guiScale=2）：Esc 后 Tab×7 到「对局域网开放」，
  // 进 LAN 界面焦点在端口框，Tab×3 到「创建局域网世界」。其余是容错候选。
  var plans = [
    { name: "tab7-3", pauseTabs: 7, lanTabs: 3 },
    { name: "tab7-2", pauseTabs: 7, lanTabs: 2 },
    { name: "tab7-4", pauseTabs: 7, lanTabs: 4 },
    { name: "tab6-3", pauseTabs: 6, lanTabs: 3 },
    { name: "tab8-3", pauseTabs: 8, lanTabs: 3 }
  ];
  for (var p = 0; p < plans.length; p++) {
    try {
      var ok = await attempt(plans[p].pauseTabs, plans[p].lanTabs);
      if (ok) return { ok: true, port: readPort(logPath), strategy: plans[p].name, message: "局域网已开启 / LAN opened: " + readPort(logPath) };
      // 没成功就把界面退回去，避免卡在 LAN 界面影响下一套策略。
      try { await key(Key.Escape); await qdelay(350); await key(Key.Escape); await qdelay(500); } catch (eBack) { /* ignore */ }
    } catch (ePlan) { /* 换下一套 */ }
  }
  // 最后兜底：鼠标点 LAN 界面的「创建局域网世界」按钮（底行左键）。
  try {
    await key(Key.Escape); await qdelay(600);
    await clicked(width * 0.38, height * 0.925); await qdelay(2200);
    if (readPort(logPath) > 0) return { ok: true, port: readPort(logPath), strategy: "mouse-start", message: "局域网已开启 / LAN opened: " + readPort(logPath) };
  } catch (eMouse) { /* ignore */ }
  return { ok: false, message: "开局域网失败 / open LAN failed", tail: tailLog(logPath).slice(-600) };
}

// 一站式：读启动脚本 -> 预建世界 -> 启动 -> 等世界 -> 开局域网。
async function startRealGame(mcDir, versionId, opts) {
  var o = opts || {};
  var launched = launchGame(mcDir, versionId, o);
  if (!launched.ok) return launched;
  say("游戏进程已启动 / game launched: pid=" + launched.pid);
  var world = await waitForWorld(launched.log, o.worldTimeoutMs || 90000);
  if (!world.ok) { stopGame(); return { ok: false, message: world.message, tail: world.tail || "" }; }
  // 世界刚加载完角色还没站稳，等几秒再操作；并把游戏窗口提到前台，否则键盘事件会打到别的窗口。
  await qdelay(4500);
  try { var qe = require("./qa-env"); qe.focusWindow(launched.pid); } catch (eF) { /* ignore */ }
  await qdelay(700);
  say("世界已加载，开始开局域网 / world loaded, opening LAN");
  var lan = await openLAN(launched.log, { width: o.width || 1280, height: o.height || 720 });
  if (!lan.ok) { stopGame(); return { ok: false, message: lan.message, tail: lan.tail || "" }; }
  return { ok: true, pid: launched.pid, port: lan.port, log: launched.log, world: launched.world, gameDir: launched.gameDir, strategy: lan.strategy };
}

// 收尾：只杀本进程拉起的游戏进程树。
function stopGame() {
  var pid = gamePid;
  if (!pid) return { ok: true, killed: 0, message: "没有需要关闭的游戏 / no game" };
  try {
    if (process.platform === "win32") cp.execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "pipe", timeout: 15000 });
    else { try { process.kill(pid); } catch (eK) { /* ignore */ } }
    gamePid = 0; gameChild = null;
    return { ok: true, killed: 1, message: "游戏进程已关闭 / game closed: " + pid };
  } catch (e) { return { ok: false, killed: 0, message: "关闭游戏失败 / close failed: " + errText(e) }; }
}

module.exports = {
  splitWinArgs: splitWinArgs, readLaunch: readLaunch, prepareWorld: prepareWorld,
  launchGame: launchGame, waitForWorld: waitForWorld, readPort: readPort, openLAN: openLAN,
  startRealGame: startRealGame, stopGame: stopGame, tailLog: tailLog
};
