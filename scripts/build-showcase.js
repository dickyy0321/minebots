// ========================================
// 文件：scripts/build-showcase.js
// 功能：建筑演示录制台——程序化生成大教堂蓝图 → builder-blueprint 拆任务 → 起专用服务端 →
//       两个建筑 Bot 分片放置 → 启动客户端观景 → 供外部录屏
// 依赖：fs / path / crypto / child_process（Node 内置）；../modules/builder-blueprint（可选）；
//       ./qa-mc（可选，读启动参数）；mineflayer（可选，缺了就只起服务端）
// 导出：main / makeBlueprint / offlineUuid
// 说明：只在 127.0.0.1 起服务端（online-mode=false），坐标固定在出生点正前方；所有外部调用 try/catch，
//       只关本脚本拉起的进程；蓝图生成是纯函数，可单独自测。
// 作者：MineBots
// ========================================
var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var cp = require("child_process");

var ROOT = path.resolve(__dirname, "..");
var SERVER_DIR = path.join(ROOT, "state", "qa-server");
var PORT = 25565;

function say(msg) {
  try { console.log("[build-showcase] " + msg); } catch (e) { /* ignore */ }
}
function wait(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// ---------- 离线 UUID（vanilla 规则：MD5("OfflinePlayer:<name>") + 版本位） ----------
function offlineUuid(name) {
  try {
    var md5 = crypto.createHash("md5").update("OfflinePlayer:" + String(name), "utf8").digest();
    md5[6] = (md5[6] & 0x0f) | 0x30;
    md5[8] = (md5[8] & 0x3f) | 0x80;
    var hex = md5.toString("hex");
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
  } catch (e) { return ""; }
}

// ---------- 蓝图：对称大教堂 ----------
// 结构：26x26 底座 → 四角塔 → 三层拱窗主体 → 阶梯穹顶 → 金色顶饰；内部每层一圈海晶灯。
function makeBlueprint(origin) {
  var o = origin || { x: 0, y: 70, z: 40 };
  var blocks = [];
  var seen = {};
  function put(x, y, z, name) {
    var key = x + "," + y + "," + z;
    if (seen[key]) return;
    seen[key] = 1;
    blocks.push({ x: x + o.x, y: y + o.y, z: z + o.z, name: name });
  }
  var S = 26, H = S / 2, Y = 0;
  var i, j, k;

  // 1) 台基：两层，外圈深板岩，内圈石英
  for (i = 0; i < S; i++) {
    for (j = 0; j < S; j++) {
      var edge = (i === 0 || j === 0 || i === S - 1 || j === S - 1);
      put(i - H, Y, j - H, edge ? "minecraft:polished_deepslate" : "minecraft:quartz_block");
    }
  }
  for (i = 1; i < S - 1; i++) {
    for (j = 1; j < S - 1; j++) put(i - H, Y + 1, j - H, "minecraft:smooth_quartz");
  }

  // 2) 四角塔：5x5 塔身 + 尖顶
  var towers = [[-9, -9], [-9, 9], [9, -9], [9, 9]];
  for (var t = 0; t < towers.length; t++) {
    var tx = towers[t][0], tz = towers[t][1];
    for (var y = 2; y <= 26; y++) {
      for (i = 0; i < 5; i++) {
        for (j = 0; j < 5; j++) {
          var wall = (i === 0 || j === 0 || i === 4 || j === 4);
          if (!wall) continue;
          var glow = (y % 6 === 0) && (i === 2 || j === 2);
          put(tx + i - 2, y, tz + j - 2, glow ? "minecraft:sea_lantern" : "minecraft:quartz_block");
        }
      }
    }
    for (k = 0; k < 5; k++) {
      var r = 2 - Math.floor(k / 2);
      for (i = -r; i <= r; i++) {
        for (j = -r; j <= r; j++) put(tx + i, 27 + k, tz + j, (k % 2 === 0) ? "minecraft:gold_block" : "minecraft:quartz_block");
      }
    }
  }

  // 3) 主体：三层，每层拱窗
  var tiers = [{ y0: 2, y1: 8, half: 11 }, { y0: 9, y1: 15, half: 9 }, { y0: 16, y1: 22, half: 7 }];
  for (var ti = 0; ti < tiers.length; ti++) {
    var tr = tiers[ti];
    for (var yy = tr.y0; yy <= tr.y1; yy++) {
      for (i = -tr.half; i <= tr.half; i++) {
        for (j = -tr.half; j <= tr.half; j++) {
          var onEdge = (Math.abs(i) === tr.half || Math.abs(j) === tr.half);
          if (!onEdge) continue;
          var corner = (Math.abs(i) === tr.half && Math.abs(j) === tr.half);
          if (corner) { put(i, yy, j, "minecraft:quartz_pillar"); continue; }
          var center = (Math.abs(i) <= 1 || Math.abs(j) <= 1);
          var isGlass = center && yy > tr.y0 + 1 && yy < tr.y1;
          put(i, yy, j, isGlass ? "minecraft:light_blue_stained_glass" : "minecraft:quartz_block");
        }
      }
      // 每层楼板
      if (yy === tr.y1) {
        for (i = -tr.half + 1; i < tr.half; i++) {
          for (j = -tr.half + 1; j < tr.half; j++) put(i, yy + 1, j, "minecraft:smooth_quartz");
        }
      }
    }
    // 楼板上的灯圈
    for (i = -tr.half + 3; i <= tr.half - 3; i += 3) {
      put(i, tr.y0 + 1, tr.half - 1, "minecraft:sea_lantern");
      put(i, tr.y0 + 1, -tr.half + 1, "minecraft:sea_lantern");
    }
  }

  // 4) 穹顶：阶梯收口 + 四角小尖
  for (k = 0; k < 7; k++) {
    var half2 = 6 - k;
    for (i = -half2; i <= half2; i++) {
      for (j = -half2; j <= half2; j++) {
        if (Math.abs(i) !== half2 && Math.abs(j) !== half2) continue;
        put(i, 24 + k, j, (k % 2 === 0) ? "minecraft:smooth_quartz" : "minecraft:quartz_block");
      }
    }
  }
  for (k = 0; k < 6; k++) put(0, 31 + k, 0, k === 5 ? "minecraft:gold_block" : "minecraft:quartz_pillar");
  put(0, 37, 0, "minecraft:sea_lantern");

  return { name: "Sky Cathedral", version: 1, origin: o, blocks: blocks };
}

// ---------- 服务端 ----------
function writeOps(names) {
  try {
    var list = [];
    for (var i = 0; i < names.length; i++) {
      list.push({ uuid: offlineUuid(names[i]), name: String(names[i]), level: 4, bypassesPlayerLimit: true });
    }
    fs.writeFileSync(path.join(SERVER_DIR, "ops.json"), JSON.stringify(list, null, 2), "utf8");
    return { ok: true, count: list.length };
  } catch (e) { return { ok: false, message: String(e && e.message) }; }
}

function startServer() {
  var qs = require("./qa-server");
  var qm = require("./qa-mc");
  var env = qs.getState();
  if (env && env.running) return { ok: true, reused: true };
  var mcDir = process.env.MINEBOTS_MC_DIR || "";
  if (!mcDir) {
    // 从环境扫描里拿 .minecraft 路径
    try {
      var qenv = require("./qa-env");
      var scan = qenv.scanEnvironment({ deep: true });
      mcDir = scan.minecraftDir || "";
    } catch (e) { mcDir = ""; }
  }
  if (!mcDir) return { ok: false, message: "找不到 .minecraft / minecraft dir missing" };
  try { qm.readLaunch(mcDir, "1.21.1"); } catch (e2) { /* 只探测，失败交给 startServer */ }
  return qs.startServer({ mcDir: mcDir, version: "1.21.1", port: PORT });
}

// ---------- 客户端 ----------
function startClient(tag) {
  var qm = require("./qa-mc");
  var mcDir = process.env.MINEBOTS_MC_DIR || "";
  if (!mcDir) {
    try {
      var qenv = require("./qa-env");
      mcDir = (qenv.scanEnvironment({ deep: true }).minecraftDir) || "";
    } catch (e) { mcDir = ""; }
  }
  if (!mcDir) return { ok: false, message: "找不到 .minecraft" };
  var launch = qm.readLaunch(mcDir, "1.21.1");
  if (!launch.ok) return launch;
  var args = [];
  for (var i = 0; i < launch.args.length; i++) {
    var a = launch.args[i];
    if (a === "--quickPlaySingleplayer") { i++; continue; }
    if (a === "--width" || a === "--height") { i++; continue; }
    args.push(a);
  }
  args.push("--quickPlayMultiplayer", "127.0.0.1:" + PORT);
  args.push("--width", "3840", "--height", "2160");
  var logDir = path.join(launch.gameDir, "logs");
  try { if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true }); } catch (e2) { /* ignore */ }
  var logPath = path.join(logDir, "showcase-mp-" + Date.now() + ".log");
  var child = cp.spawn(launch.java, args, { cwd: launch.gameDir, stdio: ["ignore", "pipe", "pipe"], windowsHide: false });
  var pipe = function (buf) { try { fs.appendFileSync(logPath, buf); } catch (e) { /* ignore */ } };
  try { child.stdout.on("data", pipe); } catch (e3) { /* ignore */ }
  try { child.stderr.on("data", pipe); } catch (e4) { /* ignore */ }
  say("客户端已启动 / client started: " + (child && child.pid));
  return { ok: true, pid: child && child.pid, log: logPath, child: child };
}

// ---------- 建筑 Bot ----------
async function runBuilders(bp, names) {
  var mineflayer = null;
  try { mineflayer = require("mineflayer"); } catch (e) { mineflayer = null; }
  if (!mineflayer) return { ok: false, message: "mineflayer 不可用" };
  var bpMod = null;
  try { bpMod = require("../modules/builder-blueprint"); } catch (e2) { bpMod = null; }

  // 用模块拆任务（拿不到就退化为直接按方块列表）
  var tasks = [];
  if (bpMod && typeof bpMod.buildTasks === "function") {
    var parsed = bpMod.parse(bp, {});
    if (parsed && parsed.ok) tasks = bpMod.buildTasks(parsed.blueprint, {});
  }
  if (!tasks.length) {
    for (var i = 0; i < bp.blocks.length; i++) {
      var b = bp.blocks[i];
      tasks.push({ pos: { x: b.x, y: b.y, z: b.z }, block: b.name, index: i });
    }
  }
  say("任务数 / tasks: " + tasks.length);

  var bots = [];
  for (var n = 0; n < names.length; n++) {
    (function (name) {
      var bot = mineflayer.createBot({ host: "127.0.0.1", port: PORT, username: name, version: "1.21.1", auth: "offline" });
      bot._name = name;
      bots.push(bot);
    }(names[n]));
  }
  // 等全部 spawn
  var t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    var ready = bots.filter(function (b) { return b && b.entity; }).length;
    if (ready === bots.length) break;
    await wait(500);
  }
  if (bots.length !== names.length) return { ok: false, message: "bot 未全部就绪" };
  for (var s = 0; s < bots.length; s++) {
    try { bots[s].chat("/gamemode creative"); } catch (e5) { /* ignore */ }
    try { bots[s].chat("/tp " + names[s] + " 0 72 20"); } catch (e6) { /* ignore */ }
  }
  await wait(1200);
  var delayMs = Number(process.env.MINEBOTS_BUILD_DELAY_MS || 0);
  if (delayMs > 0) { say("等待开建 / delay ms: " + delayMs); await wait(delayMs); }

  var placed = 0;
  var failed = 0;
  var per = 12;
  var idx = [0, 1];
  var done = false;
  var loop = async function (which) {
    var bot = bots[which];
    while (idx[which] < tasks.length) {
      var batch = 0;
      while (batch < per && idx[which] < tasks.length) {
        var task = tasks[idx[which]];
        idx[which] += 2;
        var p = task.pos || {};
        var blk = task.block || "minecraft:stone";
        try {
          bot.chat("/setblock " + Math.round(p.x) + " " + Math.round(p.y) + " " + Math.round(p.z) + " " + blk + " replace");
          placed += 1;
        } catch (e7) { failed += 1; }
        batch += 1;
      }
      // 每批移动一次，画面里像是在绕着建筑跑
      try {
        var cur = tasks[Math.min(idx[which], tasks.length - 1)].pos;
        bot.chat("/tp " + bot._name + " " + (cur.x + 8) + " " + (cur.y + 6) + " " + (cur.z + 8));
      } catch (e8) { /* ignore */ }
      await wait(650);
    }
  };
  await Promise.all([loop(0), loop(1)]);
  done = true;
  try { bots[0].chat("建筑完工 / build complete: " + placed + " blocks"); } catch (e9) { /* ignore */ }
  say("放置完成 / placed " + placed + " failed " + failed + " done=" + done);
  var holdMs = Number(process.env.MINEBOTS_HOLD_MS || 0);
  if (holdMs > 0) { say("保持运行 / hold ms: " + holdMs); await wait(holdMs); }
  return { ok: true, placed: placed, failed: failed, bots: bots };
}

// ---------- 主流程 ----------
async function main() {
  var names = ["BuilderA", "BuilderB"];
  var origin = { x: 0, y: 70, z: 40 };
  try {
    var oParts = String(process.env.MINEBOTS_BUILD_ORIGIN || "").split(",");
    if (oParts.length === 3) origin = { x: Number(oParts[0]), y: Number(oParts[1]), z: Number(oParts[2]) };
  } catch (eO) { /* 用默认 */ }
  var bp = null;
  try {
    var bpFile = String(process.env.MINEBOTS_BUILD_BLUEPRINT || "");
    if (bpFile) {
      var raw = JSON.parse(fs.readFileSync(bpFile, "utf8"));
      var src = Array.isArray(raw.blocks) ? raw.blocks : [];
      var shifted = [];
      for (var bi = 0; bi < src.length; bi++) {
        var one = src[bi];
        shifted.push({ x: (one.x || 0) + origin.x, y: (one.y || 0) + origin.y, z: (one.z || 0) + origin.z, block: one.block || one.name });
      }
      bp = { name: raw.name || "ai-blueprint", origin: { x: 0, y: 0, z: 0 }, blocks: shifted };
      say("从文件加载蓝图 / blueprint file: " + bpFile + " blocks=" + shifted.length);
    }
  } catch (eBp) { say("蓝图文件读取失败 / blueprint load failed: " + (eBp && eBp.message)); }
  if (!bp) bp = makeBlueprint(origin);
  // 可选：引擎补一个阶梯屋顶（AI 蓝图常常只出墙体和门窗，顶面开口）
  if (process.env.MINEBOTS_BUILD_ROOF === "1" && bp && Array.isArray(bp.blocks) && bp.blocks.length) {
    var rmin = { x: 1e9, z: 1e9 }, rmax = { x: -1e9, z: -1e9 }, rtop = -1e9, rseen = {};
    for (var ri = 0; ri < bp.blocks.length; ri++) {
      var rb = bp.blocks[ri];
      rmin.x = Math.min(rmin.x, rb.x); rmax.x = Math.max(rmax.x, rb.x);
      rmin.z = Math.min(rmin.z, rb.z); rmax.z = Math.max(rmax.z, rb.z);
      rtop = Math.max(rtop, rb.y);
      rseen[rb.x + "," + rb.y + "," + rb.z] = 1;
    }
    var added = 0;
    for (var rk = 0; rk < 4; rk++) {
      var ry = rtop + 1 + rk;
      for (var rx = rmin.x + rk; rx <= rmax.x - rk; rx++) {
        for (var rz = rmin.z + rk; rz <= rmax.z - rk; rz++) {
          var rkey = rx + "," + ry + "," + rz;
          if (rseen[rkey]) continue;
          rseen[rkey] = 1;
          bp.blocks.push({ x: rx, y: ry, z: rz, block: rk === 3 ? "minecraft:spruce_planks" : "minecraft:spruce_stairs" });
          added += 1;
        }
      }
    }
    say("引擎补屋顶 / roof added: " + added);
  }
  say("蓝图方块数 / blueprint blocks: " + bp.blocks.length);

  var ops = writeOps(names.concat(["Steve", "Carpenter"]));
  say("ops.json: " + JSON.stringify(ops));

  var srv = startServer();
  if (!srv.ok) { say("服务端启动失败 / server failed: " + srv.message); return { ok: false }; }
  say("服务端 pid / pid: " + srv.pid);
  var qs = require("./qa-server");
  var ready = { ok: false, message: "timeout" };
  var tReady = Date.now();
  while (Date.now() - tReady < 180000) {
    var tail = "";
    try { tail = fs.readFileSync(srv.log, "utf8"); } catch (eTail) { tail = ""; }
    if (/Done \([0-9.]+s\)!/.test(tail)) { ready = { ok: true, message: "ready" }; break; }
    if (/Address already in use|Failed to start/.test(tail)) { ready = { ok: false, message: "server failed" }; break; }
    if (!qs.getState().running) { ready = { ok: false, message: "server exited" }; break; }
    await wait(1000);
  }
  say("服务端就绪 / server ready: " + JSON.stringify(ready));
  if (!ready.ok) return { ok: false, message: ready.message };

  var client = startClient();
  if (!client.ok) say("客户端启动失败 / client failed: " + client.message);

  var build = await runBuilders(bp, names);
  say("建筑结果 / build: " + JSON.stringify({ ok: build.ok, placed: build.placed, failed: build.failed }));
  return { ok: build.ok, blueprint: bp.blocks.length, placed: build.placed, client: client.ok };
}

if (require.main === module) {
  main().then(function (r) {
    say("完成 / done: " + JSON.stringify(r));
    process.exit(0);
  }).catch(function (e) {
    say("失败 / failed: " + (e && e.message ? e.message : e));
    process.exit(1);
  });
}

module.exports = { main: main, makeBlueprint: makeBlueprint, offlineUuid: offlineUuid, startClient: startClient };
