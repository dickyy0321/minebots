// ========================================
// 文件：scripts/qa-env.js
// 功能：QA 环境层——扫描 PCL2 / .minecraft 版本；受控启动与只杀自有进程；nut-js 截屏并自编码 PNG；ffmpeg 合成演示视频
// 依赖：fs / path / os / child_process / zlib（Node 内置）、@nut-tree-fork/nut-js（可选）、ffmpeg（可选）
// 导出：scanEnvironment / launchPCL2 / killTracked / closeAll / grabFrame / synthFrame / encodePNG / saveFrame / makeVideo / writeStoryboard
// 说明：只杀本进程拉起的子进程，绝不 taskkill 全机 java；截不到屏时用合成帧保证视频链路不断；所有外部调用 try/catch。
// 作者：MineBots
// ========================================
var fs = require("fs");
var path = require("path");
var os = require("os");
var cp = require("child_process");
var zlib = require("zlib");

// 可选依赖：日志核心，缺失时退回 console。
var logger = null;
try { logger = require("../modules/logger"); } catch (e) { logger = null; }

var ROOT = path.join(__dirname, "..");
var HOME = "";
try { HOME = os.homedir(); } catch (e) { HOME = process.env.USERPROFILE || ""; }
// 本进程拉起并需要收尾的子进程（只动这些，绝不扫全机）。
var tracked = [];

// 写信息日志。
function logInfo(msg) {
  try { if (logger && typeof logger.info === "function") { logger.info("[qa-env] " + msg); return; } } catch (e) { /* 退回 console */ }
  try { console.log("[qa-env] " + msg); } catch (e2) { /* ignore */ }
}
// 安全提取错误文本。
function errText(err) {
  try { return err && err.message ? String(err.message) : String(err); } catch (e) { return "unknown error"; }
}
// 文件是否存在（不抛错）。
function exists(p) {
  try { return !!p && fs.existsSync(p); } catch (e) { return false; }
}

// 查找 ffmpeg：优先 FFMPEG_PATH，其次 PATH 里的 ffmpeg。
function findFfmpeg() {
  var env = process.env.FFMPEG_PATH;
  if (env && exists(env)) return env;
  try {
    var out = cp.execFileSync("ffmpeg", ["-version"], { stdio: "pipe", timeout: 8000 });
    if (out && out.length > 0) return "ffmpeg";
  } catch (e) { /* 没装 */ }
  return "";
}

// 深扫时跳过的系统 / 缓存目录：避免在 Windows / Program Files / node_modules 里空转。
var SKIP_DIRS = { "windows": true, "program files": true, "program files (x86)": true, "programdata": true, "$recycle.bin": true, "system volume information": true, "appdata": true, "node_modules": true, ".git": true, "windowsapps": true, "recovery": true, "perflogs": true };

// 列出存在的盘符（A: ~ Z:），多盘扫描用。
function listDrives() {
  var out = [];
  try {
    for (var i = 65; i <= 90; i++) {
      var root = String.fromCharCode(i) + ":\\";
      try { if (fs.existsSync(root)) out.push(root); } catch (e) { /* 没这个盘 */ }
    }
  } catch (e2) { /* ignore */ }
  return out;
}

// 在单个根目录做「有深度上限 + 有时间上限」的广度扫描，找 PCL 启动器与 .minecraft。
function walkFind(root, opts) {
  var o = opts || {};
  var maxDepth = typeof o.maxDepth === "number" ? o.maxDepth : 4;
  var deadline = o.deadline || 0;
  var out = { pcl2: [], mc: [] };
  var queue = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    if (deadline && Date.now() > deadline) break;
    var cur = queue.shift();
    var ents = [];
    try { ents = fs.readdirSync(cur.dir, { withFileTypes: true }); } catch (e) { continue; }
    for (var i = 0; i < ents.length; i++) {
      var ent = ents[i];
      var name = String(ent.name);
      var low = name.toLowerCase();
      var full = path.join(cur.dir, name);
      if (ent.isDirectory()) {
        if (low === ".minecraft") {
          try { if (fs.existsSync(path.join(full, "versions"))) out.mc.push(full); } catch (eM) { /* ignore */ }
          continue;
        }
        if (SKIP_DIRS[low] === true) continue;
        if (cur.depth < maxDepth) queue.push({ dir: full, depth: cur.depth + 1 });
      } else if (/\.exe$/i.test(name)) {
        if (/^(pcl|plain craft launcher)/i.test(name)) out.pcl2.push(full);
      }
    }
  }
  return out;
}

// 多盘深扫：先浅（深度 2，快）再深（深度 4），最后才回扫 C 盘浅层。
function deepScan() {
  var drives = listDrives();
  var pcl2 = [], mc = [];
  var budget = Date.now() + 15000;
  var i = 0;
  for (i = 0; i < drives.length; i++) {
    if (drives[i].toUpperCase() === "C:\\") continue;
    if (Date.now() > budget) break;
    var shallow = walkFind(drives[i], { maxDepth: 2, deadline: budget });
    pcl2 = pcl2.concat(shallow.pcl2); mc = mc.concat(shallow.mc);
    if (pcl2.length > 0 && mc.length > 0) break;
  }
  if ((pcl2.length === 0 || mc.length === 0) && Date.now() < budget) {
    for (i = 0; i < drives.length; i++) {
      if (drives[i].toUpperCase() === "C:\\") continue;
      if (Date.now() > budget) break;
      var deep = walkFind(drives[i], { maxDepth: 4, deadline: budget });
      pcl2 = pcl2.concat(deep.pcl2); mc = mc.concat(deep.mc);
      if (pcl2.length > 0 && mc.length > 0) break;
    }
  }
  if ((pcl2.length === 0 || mc.length === 0) && Date.now() < budget) {
    var c = walkFind("C:\\", { maxDepth: 3, deadline: budget });
    pcl2 = pcl2.concat(c.pcl2); mc = mc.concat(c.mc);
  }
  return { pcl2: pcl2, mc: mc };
}

// 扫描结果缓存：有 MINEBOTS_STATE_DIR 就写临时盘，否则写 state/qa-paths.json。
function cachePath() {
  try {
    var custom = process.env.MINEBOTS_STATE_DIR;
    if (custom && String(custom).length > 0) return path.resolve(String(custom), "qa-paths.json");
    return path.join(ROOT, "state", "qa-paths.json");
  } catch (e) { return ""; }
}
function readCache() {
  try {
    var f = cachePath();
    if (!f || !exists(f)) return null;
    var o = JSON.parse(fs.readFileSync(f, "utf8"));
    if (!o || !exists(o.pcl2) || !exists(o.minecraftDir)) return null;
    return o;
  } catch (e) { return null; }
}
function writeCache(obj) {
  try {
    var f = cachePath();
    if (!f) return false;
    var dir = path.dirname(f);
    if (!exists(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(f, JSON.stringify(obj, null, 2), "utf8");
    return true;
  } catch (e) { return false; }
}

// 判定版本是否模组版：先看名字，再看版本 JSON（fabric / forge / quilt 关键字）。
function isModdedVersion(vdir, id) {
  var low = String(id).toLowerCase();
  if (low.indexOf("fabric") >= 0 || low.indexOf("forge") >= 0 || low.indexOf("quilt") >= 0) return true;
  try {
    var f = path.join(vdir, id + ".json");
    if (!fs.existsSync(f)) return false;
    var text = fs.readFileSync(f, "utf8").toLowerCase();
    return text.indexOf("fabric") >= 0 || text.indexOf("forge") >= 0 || text.indexOf("quilt") >= 0;
  } catch (e) { return false; }
}

// 配对原版 / 模组版：优先选「同版本号下模组分支最多」的那对，保证两者可对比。
function pickPair(versions) {
  var counts = {};
  var i = 0;
  for (i = 0; i < versions.length; i++) {
    if (!versions[i].modded) continue;
    var base = String(versions[i].id).split("-")[0];
    counts[base] = (counts[base] || 0) + 1;
  }
  var bestBase = "", bestCount = 0;
  for (var k in counts) {
    if (Object.prototype.hasOwnProperty.call(counts, k) && counts[k] > bestCount) { bestBase = k; bestCount = counts[k]; }
  }
  var vanilla = null, modded = null;
  if (bestBase) {
    for (i = 0; i < versions.length; i++) { if (!versions[i].modded && versions[i].id === bestBase) { vanilla = versions[i].id; break; } }
  }
  if (!vanilla) {
    for (i = 0; i < versions.length; i++) { if (!versions[i].modded) { vanilla = versions[i].id; break; } }
  }
  if (bestBase) {
    for (i = 0; i < versions.length; i++) { if (versions[i].modded && String(versions[i].id).indexOf(bestBase + "-") === 0) { modded = versions[i].id; break; } }
  }
  if (!modded) {
    for (i = 0; i < versions.length; i++) { if (versions[i].modded) { modded = versions[i].id; break; } }
  }
  return { vanilla: vanilla, modded: modded };
}

// 扫描环境：PCL2 / .minecraft 及版本（原版 + 模组版）/ RPA 库 / ffmpeg。
// opts.deep === true 时才做多盘深扫（自测默认不深扫，保证快）。
function scanEnvironment(opts) {
  var o = opts || {};
  var out = { pcl2: "", minecraftDir: "", versions: [], vanilla: null, modded: null, rpa: { robotjs: false, nut: false }, ffmpeg: "", simulated: true, checkedAt: new Date().toISOString() };
  try {
    // 1) 先读缓存（上次深扫结果），再查环境变量与常见位置。
    var cached = readCache();
    if (cached) { out.pcl2 = cached.pcl2; out.minecraftDir = cached.minecraftDir; }
    var pclCands = [];
    if (process.env.PCL2_PATH) pclCands.push(process.env.PCL2_PATH);
    pclCands.push(path.join(ROOT, "PCL2.exe"));
    pclCands.push(path.join(HOME, "Desktop", "PCL2.exe"));
    pclCands.push(path.join(HOME, "Downloads", "PCL2.exe"));
    pclCands.push(path.join(HOME, "Desktop", "PCL", "PCL2.exe"));
    for (var i = 0; i < pclCands.length && !out.pcl2; i++) {
      if (exists(pclCands[i])) out.pcl2 = pclCands[i];
    }
    var mcCands = [];
    if (process.env.MINECRAFT_DIR) mcCands.push(process.env.MINECRAFT_DIR);
    if (process.env.APPDATA) mcCands.push(path.join(process.env.APPDATA, ".minecraft"));
    mcCands.push(path.join(HOME, ".minecraft"));
    for (var j = 0; j < mcCands.length && !out.minecraftDir; j++) {
      if (exists(path.join(mcCands[j], "versions"))) out.minecraftDir = mcCands[j];
    }
    // 2) 还没找齐且允许深扫：多盘找一次，并把结果缓存起来。
    if ((!out.pcl2 || !out.minecraftDir) && o.deep === true) {
      var found = deepScan();
      if (!out.pcl2 && found.pcl2.length > 0) out.pcl2 = found.pcl2[0];
      if (!out.minecraftDir && found.mc.length > 0) out.minecraftDir = found.mc[0];
      if (out.pcl2 && out.minecraftDir) writeCache({ pcl2: out.pcl2, minecraftDir: out.minecraftDir, at: new Date().toISOString() });
    }
    // 3) 版本清单 + 原版/模组版配对。
    if (out.minecraftDir) {
      var vdir = path.join(out.minecraftDir, "versions");
      var names = [];
      try { names = fs.readdirSync(vdir); } catch (e2) { names = []; }
      for (var k = 0; k < names.length; k++) {
        var id = String(names[k]);
        try { if (!fs.statSync(path.join(vdir, id)).isDirectory()) continue; } catch (eS) { continue; }
        out.versions.push({ id: id, modded: isModdedVersion(vdir, id), path: path.join(vdir, id) });
      }
      var pair = pickPair(out.versions);
      out.vanilla = pair.vanilla;
      out.modded = pair.modded;
      for (var p = 0; p < out.versions.length; p++) {
        if (out.versions[p].id === out.vanilla) out.vanillaPath = out.versions[p].path;
        if (out.versions[p].id === out.modded) out.moddedPath = out.versions[p].path;
      }
    }
    // 4) RPA 能力：robotjs 或 nut.js 任一可用即可真实操作。
    try { require.resolve("robotjs"); out.rpa.robotjs = true; } catch (e3) { out.rpa.robotjs = false; }
    try { require.resolve("@nut-tree-fork/nut-js"); out.rpa.nut = true; } catch (e4) { out.rpa.nut = false; }
    // 5) ffmpeg：录视频 / 合成 mp4 用。
    out.ffmpeg = findFfmpeg();
    // 6) 是否具备真实跑通条件（PCL2 + 版本目录 + 至少一个版本）。
    out.simulated = !(out.pcl2 && out.minecraftDir && out.versions.length > 0);
  } catch (e) { logInfo("环境扫描异常 / scan failed: " + errText(e)); }
  return out;
}

// 受控启动 PCL2：找不到 exe 就返回 ok:false（模拟模式），拉起的子进程登记在 tracked 里。
function launchPCL2(envInfo) {
  var info = envInfo || {};
  if (!info.pcl2 || !exists(info.pcl2)) {
    return { ok: false, pid: 0, message: "未找到 PCL2，跳过真实启动 / PCL2 not found, skip launch" };
  }
  try {
    // cwd 指到启动器目录：PCL 会以自身目录为根去找 .minecraft。
    var child = cp.spawn(info.pcl2, [], { cwd: path.dirname(info.pcl2), detached: false, stdio: "ignore" });
    if (child && child.pid) {
      tracked.push({ pid: child.pid, name: "PCL2", child: child });
      return { ok: true, pid: child.pid, message: "PCL2 已启动 / PCL2 launched: " + info.pcl2 };
    }
    return { ok: false, pid: 0, message: "PCL2 启动无 pid / no pid" };
  } catch (e) { return { ok: false, pid: 0, message: "PCL2 启动失败 / launch failed: " + errText(e) }; }
}

// 把指定 pid 的窗口提到前台（Windows 用 WScript.Shell.AppActivate），失败不影响主流程。
function focusWindow(pid) {
  try {
    if (process.platform !== "win32") return { ok: false, message: "非 Windows，跳过置顶 / non-windows" };
    var id = Number(pid) || 0;
    if (!id) return { ok: false, message: "无效 pid / invalid pid" };
    cp.execFileSync("powershell", ["-NoProfile", "-Command", "(New-Object -ComObject WScript.Shell).AppActivate(" + id + ")"], { stdio: "pipe", timeout: 8000 });
    return { ok: true, message: "窗口已置顶 / window focused: " + id };
  } catch (e) { return { ok: false, message: "置顶失败 / focus failed: " + errText(e) }; }
}

// 登记一个需要收尾的子进程（供测试内部使用）。
function trackChild(child, name) {
  try {
    if (child && child.pid) tracked.push({ pid: child.pid, name: String(name || "child"), child: child });
  } catch (e) { /* ignore */ }
}

// 收尾：只杀自己拉起的进程，先温和后强杀；绝不 taskkill 全机 java。
function killTracked() {
  var killed = 0;
  for (var i = 0; i < tracked.length; i++) {
    var it = tracked[i] || {};
    try {
      if (it.child && typeof it.child.kill === "function") { it.child.kill(); killed++; }
      else if (it.pid) { try { process.kill(it.pid); killed++; } catch (eK) { /* 已退出 */ } }
    } catch (e) { /* ignore */ }
  }
  tracked = [];
  return { ok: true, killed: killed, message: "已关闭自有进程 / tracked processes closed: " + killed };
}

// 别名：收尾关闭全部（游戏 / 服务端 / 启动器）。
function closeAll() { return killTracked(); }

// ---------- PNG 编码（无第三方依赖：zlib + CRC32） ----------
var CRC_TABLE = (function () {
  var table = new Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  var c = 0xFFFFFFFF;
  for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function pngChunk(type, data) {
  var len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  var typeBuf = Buffer.from(type, "ascii");
  var crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
// 把 RGBA 原始像素编码成合法 PNG。
function encodePNG(width, height, rgba) {
  var sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  var stride = width * 4 + 1;
  var raw = Buffer.alloc(stride * height);
  for (var y = 0; y < height; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  var idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}

// ---------- 合成帧（没有屏幕时也能出视频） ----------
var DIGITS = {
  "0": ["111", "101", "101", "101", "111"], "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"], "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"], "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"], "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"], "9": ["111", "101", "111", "001", "111"]
};
function fillRect(buf, w, h, x0, y0, x1, y1, r, g, b) {
  var xa = Math.max(0, x0), xb = Math.min(w, x1), ya = Math.max(0, y0), yb = Math.min(h, y1);
  for (var y = ya; y < yb; y++) {
    for (var x = xa; x < xb; x++) {
      var i = (y * w + x) * 4;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
    }
  }
}
function drawDigit(buf, w, h, digit, scale, ox, oy, r, g, b) {
  var rows = DIGITS[String(digit)] || DIGITS["0"];
  for (var ry = 0; ry < rows.length; ry++) {
    var row = rows[ry];
    for (var rx = 0; rx < row.length; rx++) {
      if (row.charAt(rx) === "1") {
        fillRect(buf, w, h, ox + rx * scale, oy + ry * scale, ox + (rx + 1) * scale, oy + (ry + 1) * scale, r, g, b);
      }
    }
  }
}
// 合成一帧：深色底 + 状态色顶栏 + 大号测试序号 + 进度条 + 9 格进度。
function synthFrame(index, total, ok) {
  var w = 1280, h = 720;
  var buf = Buffer.alloc(w * h * 4);
  fillRect(buf, w, h, 0, 0, w, h, 11, 15, 20);
  var main = ok ? [63, 185, 80] : [248, 81, 73];
  fillRect(buf, w, h, 0, 0, w, 14, main[0], main[1], main[2]);
  var digit = String(index);
  var scale = 64;
  var dw = digit.length * 3 * scale + (digit.length - 1) * scale;
  var dx = Math.floor((w - dw) / 2);
  var dy = 250;
  for (var d = 0; d < digit.length; d++) drawDigit(buf, w, h, digit.charAt(d), scale, dx + d * 4 * scale, dy, 235, 240, 245);
  // 进度条
  var pct = Math.max(0, Math.min(1, index / (total || 9)));
  fillRect(buf, w, h, 80, h - 90, w - 80, h - 62, 30, 38, 48);
  fillRect(buf, w, h, 80, h - 90, 80 + Math.floor((w - 160) * pct), h - 62, main[0], main[1], main[2]);
  // 9 格进度
  for (var i = 1; i <= (total || 9); i++) {
    var x0 = 80 + (i - 1) * 126;
    var col = i <= index ? main : [45, 55, 68];
    fillRect(buf, w, h, x0, h - 46, x0 + 108, h - 30, col[0], col[1], col[2]);
  }
  return { ok: true, width: w, height: h, rgba: buf, real: false, simulated: true };
}

// 截一帧真屏：nut-js 抓屏 -> 最近邻缩放到目标尺寸 -> RGBA；失败返回 ok:false。
async function grabFrame(targetW, targetH) {
  var tw = targetW || 1280, th = targetH || 720;
  try {
    var n = require("@nut-tree-fork/nut-js");
    var screen = n.screen;
    var img = await screen.grab();
    var w = Number(img.width) || 0, h = Number(img.height) || 0;
    if (!w || !h) return { ok: false, message: "截屏尺寸无效 / invalid screen size" };
    var src = null, ch = 3;
    try { var rgb = img.toRGB(); if (rgb && rgb.length >= w * h * 3) { src = rgb; ch = 3; } } catch (eRgb) { src = null; }
    if (!src && img.data && img.data.length >= w * h * 4) { src = img.data; ch = 4; }
    if (!src) return { ok: false, message: "截屏数据不可用 / screen data unavailable" };
    var out = Buffer.alloc(tw * th * 4);
    for (var y = 0; y < th; y++) {
      var sy = Math.min(h - 1, Math.floor(y * h / th));
      for (var x = 0; x < tw; x++) {
        var sx = Math.min(w - 1, Math.floor(x * w / tw));
        var si = (sy * w + sx) * ch;
        var di = (y * tw + x) * 4;
        out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2]; out[di + 3] = 255;
      }
    }
    return { ok: true, width: tw, height: th, rgba: out, real: true, simulated: false, srcWidth: w, srcHeight: h };
  } catch (e) { return { ok: false, message: errText(e) }; }
}

// 保存帧为 PNG：frame-001.png ...（固定三位序号，方便 ffmpeg 直接吃）。
function saveFrame(dir, index, frame) {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    var num = String(index);
    while (num.length < 3) num = "0" + num;
    var file = path.join(dir, "frame-" + num + ".png");
    fs.writeFileSync(file, encodePNG(frame.width, frame.height, frame.rgba));
    return { ok: true, file: file };
  } catch (e) { return { ok: false, message: errText(e) }; }
}

// 合成 MP4：1 fps 输入（每个测试 1 秒），30 fps 输出，yuv420p 保证剪辑软件都能读。
function makeVideo(framesDir, outFile, opts) {
  var o = opts || {};
  var ff = o.ffmpeg || findFfmpeg();
  if (!ff) return { ok: false, message: "ffmpeg 不可用 / ffmpeg unavailable" };
  var pattern = path.join(framesDir, "frame-%03d.png");
  if (!exists(path.join(framesDir, "frame-001.png"))) return { ok: false, message: "没有可用帧 / no frames" };
  try {
    if (!fs.existsSync(path.dirname(outFile))) fs.mkdirSync(path.dirname(outFile), { recursive: true });
    cp.execFileSync(ff, ["-y", "-framerate", "1", "-i", pattern, "-vf", "scale=1280:720:flags=neighbor,format=yuv420p", "-r", "30", outFile], { stdio: "pipe", timeout: 180000 });
    return { ok: true, file: outFile, message: "视频已生成 / video written" };
  } catch (e) { return { ok: false, message: "视频合成失败 / video failed: " + errText(e) }; }
}

// 兜底：生成 HTML 分镜，剪辑时可直接按帧拖时间线。
function writeStoryboard(framesDir, items, outHtml) {
  try {
    var rows = [];
    rows.push("<!doctype html><meta charset='utf-8'><title>MineBots QA Storyboard</title>");
    rows.push("<style>body{background:#0b0f14;color:#e6edf3;font-family:system-ui;margin:24px}h2{font-weight:600}figure{margin:0 0 18px}img{width:100%;max-width:960px;border:1px solid #263041;border-radius:8px}figcaption{color:#9aa7b4;margin-top:6px}</style>");
    rows.push("<h1>MineBots 全自动 QA 分镜 / storyboard</h1>");
    for (var i = 0; i < items.length; i++) {
      var it = items[i] || {};
      rows.push("<figure><img src='" + String(it.frame || "") + "'><figcaption>" + String(it.index || (i + 1)) + ". " + String(it.name || "") + " — " + String(it.status || "") + "</figcaption></figure>");
    }
    fs.writeFileSync(outHtml, rows.join("\n"), "utf8");
    return { ok: true, file: outHtml };
  } catch (e) { return { ok: false, message: errText(e) }; }
}

// 对外导出：环境 / 进程 / 截屏 / 视频。
module.exports = {
  scanEnvironment: scanEnvironment,
  launchPCL2: launchPCL2,
  focusWindow: focusWindow,
  trackChild: trackChild,
  killTracked: killTracked,
  closeAll: closeAll,
  findFfmpeg: findFfmpeg,
  grabFrame: grabFrame,
  synthFrame: synthFrame,
  encodePNG: encodePNG,
  saveFrame: saveFrame,
  makeVideo: makeVideo,
  writeStoryboard: writeStoryboard
};
