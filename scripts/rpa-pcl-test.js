// ========================================
// 文件：scripts/rpa-pcl-test.js
// 功能：PCL2 自动化联调——启动启动器、尝试点击启动游戏、扫描局域网端口、握手确认真 MC 服、接入 bot-manager 跑「砍树 -> 挖矿 -> 放置方块」
// 依赖：fs / path / net / child_process（内置）；可选 logger / bot-manager / command-handler、可选 RPA 库 nut.js 或 robotjs、PowerShell（仅 Windows 查询与截图）
// 导出：parseArgs / writeVarInt / readVarInt / parseNetstatLine / listListeningPorts / probeMinecraft / main（独立脚本：node scripts/rpa-pcl-test.js）
// 作者：MineBots
// ========================================
// 边界 / boundary：只读既有模块，绝不修改 modules/ 与 gui/ 下任何业务代码，也不写 state/。
// 降级 / fallback：RPA 库缺失、窗口找不到、点击失败、PowerShell 不可用、端口扫不到时，打印人工接管提示并继续监听端口。
// 用法 / usage：node scripts/rpa-pcl-test.js [选项]，详见 printUsage()。
var fs = require("fs");
var path = require("path");
var net = require("net");
var childProcess = require("child_process");
var ROOT = path.join(__dirname, "..");
var LOG_DIR = path.join(ROOT, "logs");
var BOT_ID = "rpa-pcl-test";
// 可选依赖：项目日志核心，缺失时只写控制台与本地报告文件。
var logger = null;
try { logger = require(path.join(ROOT, "modules", "logger")); } catch (e) { logger = null; }
// 可选依赖：机器人管理器，缺失时联调直接判失败，绝不自行重造连接逻辑。
var botManager = null;
try { botManager = require(path.join(ROOT, "modules", "bot-manager")); } catch (e) { botManager = null; }
// 可选依赖：动作队列执行器，缺失时只报告不执行动作链。
var commandHandler = null;
try { commandHandler = require(path.join(ROOT, "modules", "command-handler")); } catch (e) { commandHandler = null; }
// 配置：全部可由环境变量覆盖，避免把用户机器路径写死。
function envNum(name, fallback) { var n = 0; try { n = Number(process.env[name]) || 0; } catch (e) { n = 0; } return n > 0 ? n : fallback; }
var CFG = {
  pclPath: process.env.PCL2_PATH || "",
  pclWaitMs: 5000, mcWaitMs: 30000, scanIntervalMs: 2000,
  lanTimeoutMs: envNum("RPA_LAN_TIMEOUT_MS", 600000),
  clickRx: envNum("RPA_CLICK_RX", 0.78), clickRy: envNum("RPA_CLICK_RY", 0.88),
  clickX: envNum("RPA_CLICK_X", 0), clickY: envNum("RPA_CLICK_Y", 0),
  mcVersion: process.env.RPA_MC_VERSION || "", botName: process.env.RPA_BOT_USERNAME || "RpaTestBot",
  screenshot: process.env.RPA_NO_SHOT !== "1"
};
// 状态：报告缓冲、保活端口（扫描时排除自身）、是否真的启动过 bot。
var reportLines = [];
var keepAlivePort = 0;
var botStarted = false;
// PowerShell 片段：枚举可见窗口，找 PCL2 / Minecraft 标题，置前并返回矩形 JSON；找不到返回空对象。
var PS_FIND_WINDOW = [
  "$ErrorActionPreference='SilentlyContinue'",
  "Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; public class RpaWin { public delegate bool EnumProc(IntPtr h, IntPtr l); [DllImport(\"user32.dll\")] public static extern bool EnumWindows(EnumProc cb, IntPtr l); [DllImport(\"user32.dll\")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n); [DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr h); [DllImport(\"user32.dll\")] public static extern bool GetWindowRect(IntPtr h, out RECT r); [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h); [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; } }'",
  "$Global:found = $null",
  "$cb = [RpaWin+EnumProc]{ param($h,$l); if (-not [RpaWin]::IsWindowVisible($h)) { return $true }; $sb=[System.Text.StringBuilder]::new(512); [void][RpaWin]::GetWindowText($h,$sb,512); $t=$sb.ToString(); if ($t -match 'PCL|Plain Craft|Minecraft|我的世界') { $r=[RpaWin+RECT]::new(); [void][RpaWin]::GetWindowRect($h,[ref]$r); $Global:found=@{x=$r.L;y=$r.T;w=($r.R-$r.L);h=($r.B-$r.T);title=$t;handle=$h.ToInt64()}; return $false }; return $true }",
  "[void][RpaWin]::EnumWindows($cb,[IntPtr]::Zero)",
  "if ($null -ne $Global:found) { [void][RpaWin]::SetForegroundWindow([IntPtr]$Global:found.handle) }",
  "if ($null -eq $Global:found) { '{}' } else { $Global:found | ConvertTo-Json -Compress }"
].join("\n");
// PowerShell 片段：列出 TCP 监听端口与所属进程名，格式 port|pid|name；命令不可用时输出空。
var PS_LIST_PORTS = [
  "$ErrorActionPreference='SilentlyContinue'",
  "Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -ge 10000 -and $_.LocalPort -le 65535 } | ForEach-Object { $p=Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; \"$($_.LocalPort)|$($_.OwningProcess)|$($p.ProcessName)\" }"
].join("\n");
// PowerShell 片段：列出 java 进程命令行，用于判定 Minecraft 客户端是否起来了；失败输出空。
var PS_JAVA_PROCS = "$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process -Filter \"Name='java.exe' OR Name='javaw.exe'\" | ForEach-Object { \"$($_.ProcessId)|$($_.CommandLine)\" }";
// 输出用法：参数与环境变量一次说清，失败返回 false。
function printUsage() {
  try {
    var rows = [
      "用法 / Usage: node scripts/rpa-pcl-test.js [options]",
      "  --probe-only   只扫端口并握手，不启动 PCL2、不连 Bot / port probe only",
      "  --no-launch    跳过启动器与点击，直接监听端口 / skip launcher",
      "  --port=NNNNN   跳过扫描，直连指定端口 / force port",
      "  --dry-run      只自检依赖与端口枚举，不做任何连接 / self check only",
      "  --help         显示帮助 / show help",
      "环境变量 / Env: PCL2_PATH, RPA_CLICK_X, RPA_CLICK_Y, RPA_CLICK_RX, RPA_CLICK_RY,",
      "  RPA_MC_VERSION, RPA_BOT_USERNAME, RPA_LAN_TIMEOUT_MS, RPA_NO_SHOT"
    ];
    console.log(rows.join("\n"));
    return true;
  } catch (e) { return false; }
}
// 解析命令行参数：返回选项对象；异常时返回默认选项而不是抛出。
function parseArgs(argv) {
  var out = { help: false, probeOnly: false, noLaunch: false, dryRun: false, port: 0 };
  try {
    var list = Array.isArray(argv) ? argv : [];
    for (var i = 0; i < list.length; i++) {
      var arg = String(list[i] || "");
      if (arg === "--help" || arg === "-h") out.help = true;
      else if (arg === "--probe-only") out.probeOnly = true;
      else if (arg === "--no-launch") out.noLaunch = true;
      else if (arg === "--dry-run") out.dryRun = true;
      else if (arg.indexOf("--port=") === 0) out.port = Number(arg.slice(7)) || 0;
    }
  } catch (e) { /* 用默认选项 */ }
  return out;
}
// 把异常拍成一行文本：catch 里不会二次抛错，失败返回固定字符串。
function errText(err) { try { return err && err.message ? String(err.message) : (err ? String(err) : "unknown error / 未知错误"); } catch (e) { return "unknown error / 未知错误"; } }
// 写一条双语日志：console + logger.info（只写文件不推 GUI）+ 报告缓冲；任一路失败都不影响其它路。
function logLine(text) {
  var line = "[RPA] " + String(text);
  try { console.log(line); } catch (e) { /* ignore */ }
  try { if (logger && typeof logger.info === "function") logger.info(line); } catch (e) { /* ignore */ }
  try { reportLines.push(new Date().toISOString() + " " + line); } catch (e) { /* ignore */ }
}
// 等待若干毫秒：定时器一律 unref，进程存活由 keepAlive 服务负责；失败也会 resolve。
function sleep(ms) { return new Promise(function (resolve) { try { var t = setTimeout(function () { resolve(true); }, ms); if (t && t.unref) t.unref(); } catch (e) { resolve(false); } }); }
// 启动保活服务：让所有 unref 定时器期间进程不退出；失败返回 null。
function startKeepAlive() {
  try {
    var server = net.createServer(function (socket) { try { socket.destroy(); } catch (e) { /* ignore */ } });
    server.on("listening", function () { try { keepAlivePort = Number(server.address().port) || 0; } catch (e) { keepAlivePort = 0; } });
    server.on("error", function () { /* 保活失败不影响主流程 */ });
    server.listen(0, "127.0.0.1");
    return server;
  } catch (e) { return null; }
}
// 执行外部命令：返回 { ok, out, error }；超时 / 不存在 / 抛错一律降级为 ok:false。
function runProcess(file, args, timeoutMs) {
  return new Promise(function (resolve) {
    var done = false;
    try {
      childProcess.execFile(file, args, { timeout: timeoutMs || 15000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, function (err, stdout) {
        if (done) return;
        done = true;
        resolve({ ok: !err, out: String(stdout || ""), error: err ? errText(err) : "" });
      });
    } catch (e) { if (!done) { done = true; resolve({ ok: false, out: "", error: errText(e) }); } }
  });
}
// 执行 PowerShell 片段：用 UTF-16LE 编码命令规避中文与引号转义；失败返回 ok:false。
function runPs(script, timeoutMs) {
  var encoded = "";
  try { encoded = Buffer.from(script, "utf16le").toString("base64"); } catch (e) { encoded = ""; }
  if (!encoded) return Promise.resolve({ ok: false, out: "", error: "encode failed / 编码失败" });
  return runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], timeoutMs || 15000);
}
// 解析一行 netstat 输出：成功返回 { port, pid, name }，失败返回 null。
function parseNetstatLine(line) {
  try {
    var hit = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+(?:LISTENING|LISTEN)\s+(\d+)/i.exec(String(line));
    if (!hit) return null;
    var port = Number(hit[1]);
    if (port < 10000 || port > 65535) return null;
    return { port: port, pid: Number(hit[2]), name: "" };
  } catch (e) { return null; }
}
// 解析 tasklist CSV 输出：返回 pid 到进程名的映射；解析失败返回空对象。
function parseTasklist(text) {
  var map = {};
  try {
    var lines = String(text || "").split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var hit = /^"?([^",]+)"?\s*,\s*"?(\d+)"?/.exec(lines[i]);
      if (hit) map[hit[2]] = hit[1].toLowerCase();
    }
  } catch (e) { /* 返回已有映射 */ }
  return map;
}
// 列出本机 5 位 TCP 监听端口：优先 PowerShell（带进程名），失败退回 netstat + tasklist；异常返回空数组。
function listListeningPorts() {
  return runPs(PS_LIST_PORTS, 12000).then(function (ps) {
    var rows = [];
    var lines = [];
    try { lines = String(ps.out || "").split(/\r?\n/); } catch (e) { lines = []; }
    for (var i = 0; i < lines.length; i++) {
      var parts = lines[i].split("|");
      var port = parts.length >= 2 ? Number(parts[0]) : 0;
      if (port >= 10000 && port <= 65535 && port !== keepAlivePort) rows.push({ port: port, pid: Number(parts[1]) || 0, name: String(parts[2] || "").toLowerCase() });
    }
    if (rows.length > 0) return rows;
    return runProcess("netstat", ["-ano", "-p", "tcp"], 12000).then(function (ns) {
      var fallback = [];
      var nsLines = [];
      try { nsLines = String(ns.out || "").split(/\r?\n/); } catch (e) { nsLines = []; }
      for (var j = 0; j < nsLines.length; j++) {
        var row = parseNetstatLine(nsLines[j]);
        if (row && row.port !== keepAlivePort) fallback.push(row);
      }
      return runProcess("tasklist", ["/FO", "CSV", "/NH"], 12000).then(function (tl) {
        var names = parseTasklist(tl.out);
        for (var k = 0; k < fallback.length; k++) fallback[k].name = names[String(fallback[k].pid)] || "";
        return fallback;
      });
    });
  }).catch(function () { return []; });
}
// 按可疑程度排序端口：java 进程优先，其次 5 开头端口，最多 24 个；异常返回空数组。
function prioritizePorts(rows) {
  try {
    var list = Array.isArray(rows) ? rows.slice(0) : [];
    list.sort(function (a, b) {
      var ja = String(a.name).indexOf("java") >= 0 ? 0 : 1;
      var jb = String(b.name).indexOf("java") >= 0 ? 0 : 1;
      if (ja !== jb) return ja - jb;
      var fa = a.port >= 50000 && a.port < 60000 ? 0 : 1;
      var fb = b.port >= 50000 && b.port < 60000 ? 0 : 1;
      return fa - fb;
    });
    return list.slice(0, 24);
  } catch (e) { return []; }
}
// 写 Minecraft VarInt：失败返回空 Buffer。
function writeVarInt(value) {
  try {
    var out = [];
    var num = Number(value) >>> 0;
    do { var temp = num & 0x7f; num = num >>> 7; if (num !== 0) temp = temp | 0x80; out.push(temp); } while (num !== 0);
    return Buffer.from(out);
  } catch (e) { return Buffer.alloc(0); }
}
// 读 Minecraft VarInt：成功返回 { value, next }，数据不足或非法返回 null。
function readVarInt(buf, offset) {
  try {
    var value = 0, shift = 0, pos = offset;
    for (var i = 0; i < 5; i++) {
      if (pos >= buf.length) return null;
      var byte = buf[pos];
      pos = pos + 1;
      value = value | ((byte & 0x7f) << shift);
      if ((byte & 0x80) === 0) return { value: value, next: pos };
      shift = shift + 7;
    }
    return null;
  } catch (e) { return null; }
}
// 从状态响应缓冲区解析 JSON：成功返回 { ok:true, info }，未收齐返回 { ok:false, wait:true }，失败返回 { ok:false }。
function parseStatusBuffer(buf) {
  try {
    var len = readVarInt(buf, 0);
    if (!len || len.value <= 0) return { ok: false, wait: buf.length < 8 };
    if (buf.length < len.next + len.value) return { ok: false, wait: true };
    var body = buf.slice(len.next, len.next + len.value);
    var pid = readVarInt(body, 0);
    if (!pid || pid.value !== 0) return { ok: false };
    var strLen = readVarInt(body, pid.next);
    if (!strLen || strLen.value <= 0) return { ok: false };
    var info = JSON.parse(body.slice(strLen.next, strLen.next + strLen.value).toString("utf8"));
    return { ok: true, info: info };
  } catch (e) { return { ok: false }; }
}
// 对单个端口做 Minecraft 状态握手（handshake + status request）：成功返回 { ok:true, version, motd }，超时 / 非 MC 服返回 ok:false。
function probeMinecraft(port, timeoutMs) {
  return new Promise(function (resolve) {
    var finished = false, socket = null, buf = Buffer.alloc(0);
    function finish(result) {
      if (finished) return;
      finished = true;
      try { if (socket) socket.destroy(); } catch (e) { /* ignore */ }
      resolve(result);
    }
    try {
      socket = net.createConnection({ host: "127.0.0.1", port: port });
      socket.setTimeout(timeoutMs || 1200, function () { finish({ ok: false, error: "timeout" }); });
      socket.on("error", function () { finish({ ok: false, error: "connect failed" }); });
      socket.on("connect", function () {
        try {
          var portBuf = Buffer.alloc(2);
          portBuf.writeUInt16BE(Number(port), 0);
          var hostBuf = Buffer.from("localhost", "utf8");
          var payload = Buffer.concat([Buffer.from([0x00]), writeVarInt(767), writeVarInt(hostBuf.length), hostBuf, portBuf, writeVarInt(1)]);
          socket.write(Buffer.concat([writeVarInt(payload.length), payload]));
          socket.write(Buffer.from([0x01, 0x00]));
        } catch (e) { finish({ ok: false, error: errText(e) }); }
      });
      socket.on("data", function (chunk) {
        try {
          buf = Buffer.concat([buf, chunk]);
          var parsed = parseStatusBuffer(buf);
          if (parsed.ok) {
            var info = parsed.info || {};
            var desc = info.description ? (typeof info.description === "string" ? info.description : String(info.description.text || "")) : "";
            finish({ ok: true, version: info.version && info.version.name ? String(info.version.name) : "", motd: desc, port: Number(port) });
          } else if (!parsed.wait) finish({ ok: false, error: "not a minecraft server" });
        } catch (e) { finish({ ok: false, error: errText(e) }); }
      });
      socket.on("close", function () { finish({ ok: false, error: "closed" }); });
    } catch (e) { finish({ ok: false, error: errText(e) }); }
  });
}
// 并发握手一批候选端口：返回第一个确认是 MC 服的结果，全部失败返回 null。
function probePorts(rows) {
  return new Promise(function (resolve) {
    var list = prioritizePorts(rows);
    var hits = [], left = list.length;
    if (left === 0) { resolve(null); return; }
    for (var i = 0; i < list.length; i++) (function (row) {
      probeMinecraft(row.port, 1200).then(function (res) {
        if (res && res.ok) hits.push(res);
        left = left - 1;
        if (left === 0) { hits.sort(function (a, b) { return a.port - b.port; }); resolve(hits.length > 0 ? hits[0] : null); }
      }).catch(function () {
        left = left - 1;
        if (left === 0) { hits.sort(function (a, b) { return a.port - b.port; }); resolve(hits.length > 0 ? hits[0] : null); }
      });
    })(list[i]);
  });
}
// 持续监听局域网端口：命中返回握手结果，超时返回 null；每 5 轮写一条低频 info 日志。
function listenForLanPort(timeoutMs) {
  var started = Date.now(), round = 0;
  function loop() {
    return listListeningPorts().then(function (rows) {
      return probePorts(rows).then(function (hit) {
        if (hit) return hit;
        round = round + 1;
        if (Date.now() - started >= timeoutMs) return null;
        if (round % 5 === 1) logLine("正在监听局域网端口 / Listening for LAN port, candidates=" + rows.length + ", round=" + round);
        return sleep(CFG.scanIntervalMs).then(loop);
      });
    });
  }
  return loop();
}
// 定位 PCL2 可执行文件：环境变量优先，其次本机已知路径与常见目录；找不到返回空串。
function findPclPath() {
  // 只认配置里的路径与项目根目录下的 PCL2.exe，不内置任何本机绝对路径
  var candidates = [CFG.pclPath, path.join(ROOT, "PCL2.exe")].filter(Boolean);
  try { if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, "PCL2", "PCL2.exe")); } catch (e) { /* 用已有候选 */ }
  for (var i = 0; i < candidates.length; i++) {
    try { if (candidates[i] && fs.existsSync(candidates[i])) return candidates[i]; } catch (e) { /* 继续找 */ }
  }
  return "";
}
// 启动 PCL2：独立进程、不继承 stdio；失败返回 { ok:false, message }。
function launchPcl(pclPath) {
  try {
    var child = childProcess.spawn(pclPath, [], { cwd: path.dirname(pclPath), detached: true, stdio: "ignore", windowsHide: false });
    try { child.unref(); } catch (e) { /* ignore */ }
    child.on("error", function (err) { logLine("启动器进程报错 / Launcher process error: " + errText(err)); });
    return { ok: true, message: "spawned" };
  } catch (e) { return { ok: false, message: errText(e) }; }
}
// 查询 PCL2 / Minecraft 窗口矩形并置前：成功返回 { ok:true, rect }，失败返回 ok:false。
function findWindowRect() {
  return runPs(PS_FIND_WINDOW, 15000).then(function (res) {
    try {
      var text = String(res.out || "").trim();
      if (!text || text.indexOf("{") < 0) return { ok: false };
      var rect = JSON.parse(text);
      return rect && rect.w && rect.h ? { ok: true, rect: rect } : { ok: false };
    } catch (e) { return { ok: false }; }
  }).catch(function () { return { ok: false }; });
}
// 加载 RPA 库：按 nut.js 开源分支 / 官方版 / robotjs 顺序探测；全部失败返回 ok:false。
function loadRpa() {
  var names = ["@nut-tree-fork/nut-js", "@nut-tree/nut-js", "robotjs"];
  for (var i = 0; i < names.length; i++) {
    try { var mod = require(names[i]); if (mod && typeof mod === "object") return { ok: true, name: names[i], mod: mod }; }
    catch (e) { /* 试下一个 */ }
  }
  return { ok: false, name: "none", mod: null };
}
// 用 RPA 库点击指定屏幕坐标：成功返回 { ok:true, name }，任何异常返回 ok:false。
function clickByRpa(rpa, x, y) {
  return new Promise(function (resolve) {
    try {
      var mod = rpa.mod;
      if (rpa.name === "robotjs") { mod.moveMouse(x, y); mod.mouseClick("left"); resolve({ ok: true, name: "robotjs.mouseClick" }); return; }
      var mouse = mod.mouse, Point = mod.Point;
      if (!mouse || !Point) { resolve({ ok: false, name: "no mouse api" }); return; }
      var target = new Point(x, y);
      var moved = typeof mouse.setPosition === "function" ? mouse.setPosition(target) : (typeof mouse.move === "function" && mod.straightTo ? mouse.move(mod.straightTo(target)) : null);
      Promise.resolve(moved).then(function () {
        if (typeof mouse.click === "function" && mod.Button) return mouse.click(mod.Button.LEFT);
        if (typeof mouse.leftClick === "function") return mouse.leftClick();
        return null;
      }).then(function () { resolve({ ok: true, name: rpa.name + ".mouse.click" }); }).catch(function (err) { resolve({ ok: false, name: errText(err) }); });
    } catch (e) { resolve({ ok: false, name: errText(e) }); }
  });
}
// 无 RPA 库时的按键降级：激活窗口后发送 Enter；失败返回 ok:false，绝不抛到顶层。
function pressEnterByPs(title) {
  var safe = "PCL";
  try { safe = String(title || "PCL").replace(/'/g, "''"); } catch (e) { safe = "PCL"; }
  var script = "Add-Type -AssemblyName System.Windows.Forms; $w=New-Object -ComObject WScript.Shell; [void]$w.AppActivate('" + safe + "'); Start-Sleep -Milliseconds 300; [System.Windows.Forms.SendKeys]::SendWait('{ENTER}'); 'ok'";
  return runPs(script, 10000).then(function (res) { return { ok: !!(res && res.ok), name: "SendKeys ENTER" }; }).catch(function () { return { ok: false, name: "SendKeys failed" }; });
}
// 检测 Minecraft 客户端进程（java 命令行含 minecraft）：成功返回 ok:true，超时返回 ok:false。
function waitForMinecraft(totalMs) {
  var started = Date.now();
  function loop() {
    return runPs(PS_JAVA_PROCS, 10000).then(function (res) {
      if (String(res.out || "").toLowerCase().indexOf("minecraft") >= 0) return { ok: true, waitedMs: Date.now() - started };
      if (Date.now() - started >= totalMs) return { ok: false, waitedMs: Date.now() - started };
      return sleep(3000).then(loop);
    }).catch(function () { return { ok: false, waitedMs: Date.now() - started }; });
  }
  return loop();
}
// 打印人工接管提示：RPA 自动点击失败或游戏内需要手动开 LAN 时统一走这里；失败返回 false。
function printManualHint(reason) {
  try {
    logLine("自动点击未完成 / Auto click unavailable: " + String(reason || "unknown"));
    logLine("请手动启动游戏并开放局域网，脚本正在监听端口… / Please start the game manually and open to LAN, listening for port...");
    return true;
  } catch (e) { return false; }
}
// 阶段一：启动 PCL2、等 5 秒、尝试点击启动游戏、等 30 秒客户端；返回 { ok, rpa, clicked, mcStarted }。
function stageLaunch() {
  var result = { ok: true, rpa: "none", clicked: false, mcStarted: false };
  var pclPath = findPclPath();
  if (!pclPath) {
    logLine("未找到 PCL2.exe，可用 PCL2_PATH 指定 / PCL2.exe not found, set PCL2_PATH");
    printManualHint("PCL2.exe not found / 找不到启动器");
    return Promise.resolve(result);
  }
  logLine("已定位启动器 / Launcher found: " + pclPath);
  var launched = launchPcl(pclPath);
  logLine(launched.ok ? "已执行 PCL2，等待窗口加载 5 秒 / PCL2 spawned, waiting 5s for window" : "启动器执行失败 / Launcher spawn failed: " + launched.message);
  var rpa = loadRpa();
  result.rpa = rpa.name;
  logLine("RPA 库 / RPA library: " + rpa.name + (rpa.ok ? " (ready / 就绪)" : " (missing / 不可用)"));
  return sleep(CFG.pclWaitMs).then(function () { return findWindowRect(); }).then(function (found) {
    if (!found.ok) { printManualHint("window not found / 没找到启动器窗口"); return null; }
    var rect = found.rect;
    var x = CFG.clickX > 0 ? CFG.clickX : Math.round(rect.x + rect.w * CFG.clickRx);
    var y = CFG.clickY > 0 ? CFG.clickY : Math.round(rect.y + rect.h * CFG.clickRy);
    logLine("窗口已就绪 / Window ready: " + String(rect.title) + " @ " + rect.x + "," + rect.y + " " + rect.w + "x" + rect.h);
    logLine("尝试点击「启动游戏」/ Trying to click Launch Game at " + x + "," + y);
    if (rpa.ok) return clickByRpa(rpa, x, y).then(function (res) {
      if (res.ok) { result.clicked = true; logLine("点击完成 / Click done via " + res.name); return true; }
      logLine("RPA 点击失败 / RPA click failed: " + res.name);
      return pressEnterByPs(rect.title).then(function (keyRes) { result.clicked = keyRes.ok; return keyRes.ok; });
    });
    return pressEnterByPs(rect.title).then(function (keyRes) { result.clicked = keyRes.ok; return keyRes.ok; });
  }).then(function (clicked) {
    if (!clicked) printManualHint("auto click failed / 自动点击不可用");
    logLine("等待 Minecraft 客户端启动 30 秒 / Waiting up to 30s for Minecraft client");
    return waitForMinecraft(CFG.mcWaitMs);
  }).then(function (mc) {
    result.mcStarted = !!(mc && mc.ok);
    logLine("客户端检测 / Client detection: " + (result.mcStarted ? "已启动 / started" : "未确认 / not confirmed"));
    return result;
  }).catch(function (err) { logLine("启动阶段异常 / Launch stage error: " + errText(err)); return result; });
}
// 通过既有 bot-manager 连服：成功返回 { ok:true, bot, version }，失败返回带双语 message 的 ok:false。
function connectBot(port, version) {
  if (!botManager || typeof botManager.startBot !== "function") return Promise.resolve({ ok: false, message: "bot-manager 不可用 / bot-manager unavailable" });
  var useVersion = version || CFG.mcVersion || "1.21.1";
  var res = null;
  try { res = botManager.startBot({ id: BOT_ID, host: "localhost", port: port, username: CFG.botName, version: useVersion, autoRespawn: true }); }
  catch (e) { return Promise.resolve({ ok: false, message: "startBot 异常 / startBot error: " + errText(e) }); }
  if (!res || !res.ok) return Promise.resolve({ ok: false, message: "startBot 拒绝 / startBot rejected: " + (res ? String(res.message) : "no result") });
  botStarted = true;
  logLine("Bot 正在连接 / Bot connecting to localhost:" + port + " version=" + useVersion);
  var started = Date.now();
  function loop() {
    var rec = null;
    try { rec = botManager.getBot(BOT_ID); } catch (e) { rec = null; }
    if (rec && rec.bot && rec.status === "running") return Promise.resolve({ ok: true, bot: rec.bot, version: useVersion });
    if (Date.now() - started >= 40000) return Promise.resolve({ ok: false, message: "等待出生超时 / spawn wait timeout" });
    return sleep(500).then(loop);
  }
  return loop();
}
// 执行「砍树 -> 挖矿 -> 放置方块」：返回 { ok, total, done, failed, results }，模块缺失或异常返回 ok:false。
function runActionChain(bot) {
  if (!commandHandler || typeof commandHandler.runQueue !== "function") return Promise.resolve({ ok: false, message: "command-handler 不可用 / command-handler unavailable" });
  var queue = [{ action: "dig_tree", command: { blocks: 2 } }, { action: "mine", command: { blocks: 2 } }, { action: "place", command: {} }];
  logLine("开始动作链 / Starting action chain: dig_tree -> mine -> place");
  return Promise.resolve().then(function () { return commandHandler.runQueue(bot, queue); }).then(function (out) {
    var summary = out || {};
    var results = Array.isArray(summary.results) ? summary.results : [];
    for (var i = 0; i < results.length; i++) {
      var r = results[i] || {};
      logLine("动作结果 / Action " + (i + 1) + ": " + String(r.action || "unknown") + " -> " + (r.ok ? "OK" : "FAIL " + String(r.error || "")));
    }
    return { ok: summary.ok === true, total: Number(summary.total) || 3, done: Number(summary.done) || 0, failed: Number(summary.failed) || 0, results: results };
  }).catch(function (err) { return { ok: false, message: "动作链异常 / chain error: " + errText(err), results: [] }; });
}
// 截屏存档：用 PowerShell + System.Drawing 保存 PNG 到 logs/；无桌面会话或失败时返回 ok:false 并只写日志。
function captureScreen() {
  var target = path.join(LOG_DIR, "rpa-pcl-last.png");
  var safe = "";
  try { safe = target.replace(/'/g, "''"); } catch (e) { safe = ""; }
  if (!safe) return Promise.resolve({ ok: false, path: "" });
  var script = [
    "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing;",
    "$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=[System.Drawing.Bitmap]::new($b.Width,$b.Height);",
    "$g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);",
    "$bmp.Save('" + safe + "',[System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose(); 'ok'"
  ].join("\n");
  return runPs(script, 15000).then(function (res) {
    var ok = !!(res && res.ok && fs.existsSync(target));
    logLine("屏幕截图 / Screenshot: " + (ok ? target : "不可用，已改用日志 / unavailable, log only"));
    return { ok: ok, path: ok ? target : "" };
  }).catch(function () { return { ok: false, path: "" }; });
}
// 落盘双语报告：写 logs/rpa-pcl-last.json 与 .txt，并 flush logger；写盘失败只记控制台。
function writeReport(summary) {
  try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) { /* ignore */ }
  var payload = { time: new Date().toISOString(), ok: summary.ok === true, stage: summary.stage || "", port: summary.port || 0, version: summary.version || "", rpa: summary.rpa || "none", chain: summary.chain || null, lines: reportLines };
  try { fs.writeFileSync(path.join(LOG_DIR, "rpa-pcl-last.json"), JSON.stringify(payload, null, 2), "utf8"); } catch (e) { /* ignore */ }
  try { fs.writeFileSync(path.join(LOG_DIR, "rpa-pcl-last.txt"), reportLines.join("\n") + "\n", "utf8"); } catch (e) { /* ignore */ }
  try { if (logger && typeof logger.flush === "function") logger.flush(); } catch (e) { /* ignore */ }
  return { ok: true, path: path.join(LOG_DIR, "rpa-pcl-last.json") };
}
// 主流程：编排各阶段；任何异常都收敛成 ok:false 报告，绝不把异常抛到顶层。
function main() {
  var args = parseArgs(process.argv.slice(2));
  if (args.help) { printUsage(); return Promise.resolve({ ok: true, stage: "help" }); }
  var keepAlive = startKeepAlive();
  var summary = { ok: false, stage: "init", port: 0, version: "", rpa: "none", chain: null };
  function finish() {
    if (botStarted && botManager && typeof botManager.stopBot === "function") {
      try { botManager.stopBot(BOT_ID); logLine("Bot 已停止 / Bot stopped"); } catch (e) { /* ignore */ }
    }
    try { if (keepAlive && typeof keepAlive.close === "function") keepAlive.close(); } catch (e) { /* ignore */ }
    var rep = writeReport(summary);
    logLine("报告已写入 / Report written: " + rep.path);
    logLine("最终结果 / Final result: " + (summary.ok ? "PASS / 通过" : "FAIL / 未通过") + " stage=" + summary.stage);
    process.exitCode = summary.ok ? 0 : 1;
    return summary;
  }
  if (args.dryRun) {
    summary.stage = "dry-run";
    var rpaInfo = loadRpa();
    summary.rpa = rpaInfo.name;
    logLine("自检 / Self check: bot-manager=" + (botManager ? "ready / 就绪" : "missing / 缺失") + ", command-handler=" + (commandHandler ? "ready / 就绪" : "missing / 缺失"));
    logLine("自检 / Self check: RPA=" + rpaInfo.name + ", PCL2=" + (findPclPath() ? "found / 已找到" : "missing / 未找到"));
    return listListeningPorts().then(function (rows) {
      logLine("自检 / Self check: 监听端口 / listening ports=" + rows.length);
      summary.ok = true;
      return finish();
    }).catch(function (err) { logLine("自检异常 / Self check error: " + errText(err)); return finish(); });
  }
  var launchFlow = (args.noLaunch || args.probeOnly) ? Promise.resolve({ ok: true, rpa: "skipped", clicked: false, mcStarted: false }) : stageLaunch();
  return launchFlow.then(function (launch) {
    summary.stage = "launch";
    summary.rpa = launch.rpa || "none";
    logLine("进入端口监听阶段 / Entering LAN port listening stage");
    logLine("请手动启动游戏并开放局域网，脚本正在监听端口… / Please start the game manually and open to LAN, listening for port...");
    if (args.port > 0) { logLine("使用指定端口 / Using forced port: " + args.port); return probeMinecraft(args.port, 2000); }
    return listenForLanPort(CFG.lanTimeoutMs);
  }).then(function (hit) {
    if (!hit || !hit.ok) { summary.stage = "port"; logLine("未捕获局域网端口 / LAN port not captured within timeout"); return null; }
    summary.stage = "port";
    summary.port = hit.port;
    summary.version = hit.version || "";
    logLine("捕获局域网端口 / LAN port captured: localhost:" + hit.port + " version=" + (hit.version || "unknown") + " motd=" + String(hit.motd || ""));
    if (args.probeOnly) { summary.ok = true; return null; }
    summary.stage = "connect";
    return connectBot(hit.port, hit.version);
  }).then(function (conn) {
    if (!conn) return null;
    if (conn.message) { logLine("Bot 连接失败 / Bot connect failed: " + conn.message); return null; }
    if (!conn.bot) return null;
    logLine("Bot 已出生 / Bot spawned, ready for action chain");
    summary.stage = "chain";
    return runActionChain(conn.bot).then(function (chain) { summary.chain = chain; summary.ok = chain.ok === true; return chain; });
  }).then(function () {
    if (args.probeOnly || !CFG.screenshot) return null;
    return captureScreen();
  }).then(function () { return finish(); }).catch(function (err) {
    logLine("主流程异常 / Main flow error: " + errText(err));
    return finish();
  });
}
// 顶层兜底：任何未处理的拒绝与异常都只记日志并落报告，不向顶层抛出。
process.on("unhandledRejection", function (reason) { logLine("未处理的 Promise 拒绝 / Unhandled rejection: " + errText(reason)); });
process.on("uncaughtException", function (err) { logLine("未捕获异常 / Uncaught exception: " + errText(err)); });
if (require.main === module) {
  main().then(function () { /* 结果已在 finish 里落盘 */ }).catch(function (err) {
    try { console.error("[RPA] 致命错误 / Fatal error: " + errText(err)); } catch (e) { /* ignore */ }
    process.exitCode = 1;
  });
}
module.exports = { parseArgs: parseArgs, writeVarInt: writeVarInt, readVarInt: readVarInt, parseNetstatLine: parseNetstatLine, listListeningPorts: listListeningPorts, probeMinecraft: probeMinecraft, main: main };
