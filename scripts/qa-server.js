// ========================================
// 文件：scripts/qa-server.js
// 功能：真服务端支撑——用客户端 jar 里的 net.minecraft.server.Main 生成合法世界，并把世界复制进客户端存档
// 依赖：fs / path / child_process（Node 内置）、./qa-mc（解析 java 与 classpath）
// 导出：ensureWorld / startServer / waitReady / stopServer / copyWorld / readPort / getState
// 说明：只在没有合法世界时启一次服务端做世界生成；online-mode=false 仅本机 127.0.0.1 使用。
//       只杀自己拉起的服务端进程树（stop 指令优先，taskkill 兜底）。
// 作者：MineBots
// ========================================
var fs = require("fs");
var path = require("path");
var cp = require("child_process");

var logger = null;
try { logger = require("../modules/logger"); } catch (e) { logger = null; }
var qaMc = null;
try { qaMc = require("./qa-mc"); } catch (e2) { qaMc = null; }

var ROOT = path.join(__dirname, "..");
var SERVER_DIR = path.join(ROOT, "state", "qa-server");
var serverChild = null;
var serverPid = 0;
var serverLog = "";

function errText(err) {
  try { return err && err.message ? String(err.message) : String(err); } catch (e) { return "unknown error"; }
}
function say(msg) {
  try { if (logger && typeof logger.info === "function") { logger.info("[qa-server] " + msg); return; } } catch (e) { /* console */ }
  try { console.log("[qa-server] " + msg); } catch (e2) { /* ignore */ }
}
function exists(p) {
  try { return !!p && fs.existsSync(p); } catch (e) { return false; }
}
function qdelay(ms) {
  var wait = Math.max(0, Math.min(Number(ms) || 0, 10000));
  return new Promise(function (resolve) { try { setTimeout(resolve, wait); } catch (e) { resolve(); } });
}

// 写 eula 与 server.properties（本机离线模式；端口可配，默认 25565）。
function prepareServer(port) {
  try {
    if (!exists(SERVER_DIR)) fs.mkdirSync(SERVER_DIR, { recursive: true });
    var eula = path.join(SERVER_DIR, "eula.txt");
    if (!exists(eula)) fs.writeFileSync(eula, "eula=true\n", "utf8");
    var props = [
      "online-mode=false",
      "level-name=world",
      "level-type=minecraft:normal",
      "spawn-protection=0",
      "max-players=10",
      "view-distance=6",
      "simulation-distance=6",
      "motd=MineBots QA",
      "enable-command-block=true",
      "allow-flight=true",
      "gamemode=creative",
      "difficulty=easy",
      "server-port=" + (Number(port) || 25565),
      "sync-chunk-writes=false",
      "network-compression-threshold=256"
    ];
    fs.writeFileSync(path.join(SERVER_DIR, "server.properties"), props.join("\n") + "\n", "utf8");
    return { ok: true };
  } catch (e) { return { ok: false, message: "服务端配置失败 / prepare server failed: " + errText(e) }; }
}

// 启动服务端：java -cp <客户端 classpath> net.minecraft.server.Main --nogui。
function startServer(opts) {
  var o = opts || {};
  var mcDir = o.mcDir;
  var version = o.version || "1.21.1";
  if (!mcDir) return { ok: false, message: "缺少 .minecraft 路径 / mcDir required" };
  if (!qaMc) return { ok: false, message: "qa-mc 不可用 / qa-mc unavailable" };
  var launch = qaMc.readLaunch(mcDir, version);
  if (!launch.ok) return launch;
  var cpIndex = launch.args.indexOf("-cp");
  var classpath = cpIndex >= 0 ? launch.args[cpIndex + 1] : "";
  if (!classpath) return { ok: false, message: "启动命令里没有 -cp / no classpath" };
  var prep = prepareServer(o.port);
  if (!prep.ok) return prep;
  try {
    if (!exists(SERVER_DIR)) fs.mkdirSync(SERVER_DIR, { recursive: true });
    var libDir = path.join(SERVER_DIR, "logs");
    if (!exists(libDir)) fs.mkdirSync(libDir, { recursive: true });
    var logPath = path.join(libDir, "qa-server-" + Date.now() + ".log");
    var child = cp.spawn(launch.java, ["-Xmx2G", "-XX:+UseG1GC", "-cp", classpath, "net.minecraft.server.Main", "--nogui"], { cwd: SERVER_DIR, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    if (!child || !child.pid) return { ok: false, message: "服务端启动失败 / server spawn failed" };
    serverChild = child; serverPid = child.pid; serverLog = logPath;
    // 控制通道：外部把控制台命令写进 state/qa-server/cmd.txt，逐行转发到服务端 stdin（避免依赖游戏内聊天框）
    try {
      var cmdFile = path.join(SERVER_DIR, "cmd.txt");
      var cmdPos = 0;
      var cmdTimer = setInterval(function () {
        try {
          if (!serverChild || !serverChild.stdin) return;
          if (!exists(cmdFile)) return;
          var text = fs.readFileSync(cmdFile, "utf8");
          if (text.length <= cmdPos) return;
          var fresh = text.slice(cmdPos);
          cmdPos = text.length;
          var lines = fresh.split(/\r?\n/);
          for (var li = 0; li < lines.length; li++) {
            var one = lines[li].trim();
            if (!one) continue;
            try { serverChild.stdin.write(one + "\n"); } catch (eW) { /* ignore */ }
          }
        } catch (eT) { /* ignore */ }
      }, 400);
      if (cmdTimer && cmdTimer.unref) cmdTimer.unref();
    } catch (eCmd) { /* ignore */ }
    try { fs.writeFileSync(logPath, "", "utf8"); } catch (eW) { /* ignore */ }
    var pipe = function (buf) { try { fs.appendFileSync(logPath, buf); } catch (eA) { /* ignore */ } };
    try { child.stdout.on("data", pipe); } catch (e1) { /* ignore */ }
    try { child.stderr.on("data", pipe); } catch (e2) { /* ignore */ }
    try { child.on("exit", function () { serverChild = null; }); } catch (e3) { /* ignore */ }
    return { ok: true, pid: child.pid, log: logPath, dir: SERVER_DIR };
  } catch (e) { return { ok: false, message: "服务端启动异常 / server error: " + errText(e) }; }
}

// 读日志尾巴。
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

// 等服务端 ready（日志出现 Done ( 且已监听端口）。
async function waitReady(logPath, timeoutMs) {
  var deadline = Date.now() + (Number(timeoutMs) || 90000);
  var last = "";
  while (Date.now() < deadline) {
    last = tailLog(logPath);
    if (/Done \([0-9.]+s\)!/.test(last) && /Starting Minecraft server on/i.test(last)) {
      return { ok: true, port: readPort(logPath), message: "服务端就绪 / server ready" };
    }
    if (/You need to agree to the EULA|Failed to start the minecraft server|Address already in use/i.test(last)) {
      return { ok: false, message: "服务端启动失败 / server failed", tail: last.slice(-600) };
    }
    if (!serverChild) return { ok: false, message: "服务端已退出 / server exited", tail: last.slice(-600) };
    await qdelay(900);
  }
  return { ok: false, message: "服务端就绪超时 / server timeout", tail: last.slice(-600) };
}

// 从服务端日志抓端口。
function readPort(logPath) {
  var text = tailLog(logPath);
  var m = text.match(/Starting Minecraft server on \S*?:(\d{2,5})/i);
  if (m && m[1]) return Number(m[1]);
  return 0;
}

// 手写递归复制：这台机器的 Node 22 上 fs.cpSync 会段错误，只能用 copyFileSync 逐个拷。
function copyDir(src, dest) {
  try {
    if (!exists(src)) return { ok: false, message: "源目录不存在 / source missing: " + src };
    removeDir(dest);
    fs.mkdirSync(dest, { recursive: true });
    var ents = fs.readdirSync(src, { withFileTypes: true });
    for (var i = 0; i < ents.length; i++) {
      var ent = ents[i];
      var from = path.join(src, String(ent.name));
      var to = path.join(dest, String(ent.name));
      if (ent.isDirectory()) {
        var sub = copyDir(from, to);
        if (!sub.ok) return sub;
      } else if (ent.isFile()) {
        fs.copyFileSync(from, to);
      }
    }
    return { ok: true, dest: dest };
  } catch (e) { return { ok: false, message: "复制世界失败 / copy world failed: " + errText(e) }; }
}

// 手写递归删除（同样避开 rmSync 的递归实现）。
function removeDir(dir) {
  try {
    if (!exists(dir)) return { ok: true };
    var ents = fs.readdirSync(dir, { withFileTypes: true });
    for (var i = 0; i < ents.length; i++) {
      var ent = ents[i];
      var full = path.join(dir, String(ent.name));
      if (ent.isDirectory()) removeDir(full);
      else { try { fs.unlinkSync(full); } catch (eU) { /* ignore */ } }
    }
    try { fs.rmdirSync(dir); } catch (eR) { /* ignore */ }
    return { ok: true };
  } catch (e) { return { ok: false, message: errText(e) }; }
}

// 把服务端生成的世界复制到客户端存档（quickPlay 用）。
function copyWorld(mcDir, versionId, worldName) {
  var src = path.join(SERVER_DIR, "world");
  var dest = path.join(mcDir, "versions", String(versionId), "saves", String(worldName));
  return copyDir(src, dest);
}

// 确保客户端有一个合法世界：已有就复用，没有就启服务端生成一次再复制。
async function ensureWorld(mcDir, versionId, worldName, opts) {
  var o = opts || {};
  var dest = path.join(mcDir, "versions", String(versionId), "saves", String(worldName));
  var level = path.join(dest, "level.dat");
  if (exists(level)) {
    // 还要有 region 数据，否则只是空壳。
    var regionDir = path.join(dest, "region");
    if (exists(regionDir)) {
      try { if (fs.readdirSync(regionDir).length > 0) return { ok: true, reused: true, world: worldName, dir: dest }; } catch (eR) { /* ignore */ }
    }
  }
  // 服务端目录里已经有生成好的世界就直接复用，省一次启动。
  var serverWorld = path.join(SERVER_DIR, "world");
  if (exists(path.join(serverWorld, "level.dat"))) {
    var direct = copyWorld(mcDir, versionId, worldName);
    if (direct.ok) return { ok: true, reused: true, world: worldName, dir: direct.dest, source: "server-cache" };
  }
  say("没有可用世界，启服务端生成 / generating world via server");
  var started = startServer({ mcDir: mcDir, version: versionId, port: o.port || 25565 });
  if (!started.ok) return started;
  var ready = await waitReady(started.log, o.timeoutMs || 120000);
  if (!ready.ok) { await stopServer(); return { ok: false, message: ready.message, tail: ready.tail || "" }; }
  say("服务端就绪，复制世界 / server ready, copying world");
  var copied = copyWorld(mcDir, versionId, worldName);
  await stopServer();
  if (!copied.ok) return copied;
  return { ok: true, reused: false, world: worldName, dir: copied.dest, port: ready.port };
}

// 收尾：先发 stop 并等它自己落盘退出（最多 8 秒），超时才强杀进程树。
async function stopServer() {
  var pid = serverPid;
  if (!pid) return { ok: true, killed: 0, message: "没有需要关闭的服务端 / no server" };
  try {
    if (serverChild && serverChild.stdin && serverChild.stdin.writable) {
      try { serverChild.stdin.write("stop\n"); } catch (eW) { /* ignore */ }
    }
  } catch (eI) { /* ignore */ }
  for (var i = 0; i < 16 && serverChild; i++) await qdelay(500);
  if (!serverChild) { serverPid = 0; return { ok: true, killed: 1, message: "服务端已优雅退出 / server stopped: " + pid }; }
  try {
    if (process.platform === "win32") cp.execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "pipe", timeout: 15000 });
    else { try { process.kill(pid); } catch (eK) { /* ignore */ } }
    serverPid = 0; serverChild = null;
    return { ok: true, killed: 1, message: "服务端已强制关闭 / server killed: " + pid };
  } catch (e) { return { ok: false, killed: 0, message: "关闭服务端失败 / close failed: " + errText(e) }; }
}

function getState() {
  return { dir: SERVER_DIR, pid: serverPid, log: serverLog, running: !!serverPid };
}

module.exports = {
  ensureWorld: ensureWorld, startServer: startServer, waitReady: waitReady,
  stopServer: stopServer, copyWorld: copyWorld, readPort: readPort, getState: getState,
  SERVER_DIR: SERVER_DIR
};
