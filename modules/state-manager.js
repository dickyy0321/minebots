// ========================================
// 文件：modules/state-manager.js
// 功能：通用状态文件读写 + 断线不失忆快照——Bot 被踢重连后自动读取中断的任务队列与黑板状态，继续干活。
// 依赖：fs / path（Node 内置）、./task-queue（可选）、./shared-board（可选）、./logger（可选）
// 导出：load / save / remove / snapshot / restore / listSnapshots / clearSnapshot / stats
// 作者：MineBots
// ========================================
// 说明：load/save/remove 保持历史语义（项目根 state/ 下按名字读写 JSON）；
//   快照单独放 state/snapshots/，并支持 MINEBOTS_STATE_DIR 隔离，自测绝不碰真实数据。
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

var fs = require("fs");
var path = require("path");
// 常量：通用状态目录（历史语义）与快照子目录名。
var STATE_DIR = path.resolve(process.cwd(), "state");
var SNAPSHOT_DIR = "snapshots";
var SNAPSHOT_VERSION = 1;
// 可选依赖：任务队列与黑板，快照时自动采集；缺失时只存调用方传入的数据。
var queue = null;
try { queue = require("./task-queue"); } catch (e) { queue = null; }
var board = null;
try { board = require("./shared-board"); } catch (e) { board = null; }
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
// 运行时统计。
var totals = { snapshots: 0, restores: 0, hits: 0, misses: 0 };

// 写普通日志：只落文件，不推 GUI。
function logInfo(text) {
  try { if (logger && typeof logger.info === "function") logger.info(text); } catch (e) { /* ignore */ }
}
// 取错误文本，catch 里绝不再次抛错。
function errText(err) {
  try { if (!err) return "unknown error"; if (err.message) return String(err.message); return String(err); } catch (e) { return "unknown error"; }
}
// 取快照根目录：MINEBOTS_STATE_DIR 优先（自测隔离），否则项目根 state/。
function stateDir() {
  try {
    var custom = process.env.MINEBOTS_STATE_DIR;
    if (custom && String(custom).length > 0) return path.resolve(String(custom));
  } catch (e) { /* 读不到按默认 */ }
  return STATE_DIR;
}
// 确保目录存在，失败返回 false。
function ensureDir(dir) {
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); return true; } catch (e) { return false; }
}
// 拼通用状态文件路径。
function filePath(name) { return path.join(STATE_DIR, String(name) + ".json"); }
// 功能：读一个通用状态文件，失败或不存在时返回 fallback。
function load(name, fallback) {
  try {
    var f = filePath(name);
    if (!fs.existsSync(f)) return fallback;
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (err) { return fallback; }
}
// 功能：原子写一个通用状态文件，返回 true / false，绝不抛错。
function save(name, data) {
  try {
    ensureDir(STATE_DIR);
    var f = filePath(name);
    var tmp = f + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, f);
    return true;
  } catch (err) { return false; }
}
// 功能：删除一个通用状态文件，返回 true / false。
function remove(name) {
  try { var f = filePath(name); if (fs.existsSync(f)) fs.unlinkSync(f); return true; } catch (err) { return false; }
}
// 把 botId 洗成安全文件名：只留字母数字下划线与短横。
function safeId(botId) {
  var raw = String(botId === null || botId === undefined ? "default" : botId);
  var out = "";
  try {
    for (var i = 0; i < raw.length && i < 64; i++) {
      var ch = raw.charAt(i);
      if (/[A-Za-z0-9_\-]/.test(ch)) out = out + ch;
    }
  } catch (e) { return "default"; }
  return out.length > 0 ? out : "default";
}
// 拼快照文件绝对路径。
function snapshotPath(botId) {
  return path.join(stateDir(), SNAPSHOT_DIR, safeId(botId) + ".json");
}
// 从可选模块里安全采集任务队列与黑板状态；拿不到就返回空结构。
function collect(options) {
  var out = { queue: [], board: {}, position: null, source: "manual" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    if (opts.queue !== undefined) out.queue = opts.queue;
    else if (queue && typeof queue.snapshot === "function") { out.queue = queue.snapshot() || []; out.source = "task-queue"; }
    if (opts.board !== undefined) out.board = opts.board;
    else if (board && typeof board.snapshot === "function") { out.board = board.snapshot() || {}; out.source = "shared-board"; }
    if (opts.position !== undefined) out.position = opts.position;
  } catch (e) { logInfo("[state-manager] collect partial / 采集部分失败: " + errText(e)); }
  return out;
}
// 功能：写入一个断线快照（任务队列 / 黑板 / 坐标），返回 { ok, path, at, items }。
function snapshot(botId, options) {
  var out = { ok: false, botId: safeId(botId), path: "", at: 0, items: 0, message: "" };
  try {
    var payload = collect(options);
    var at = Date.now();
    var doc = { version: SNAPSHOT_VERSION, botId: out.botId, at: at,
      queue: payload.queue, board: payload.board, position: payload.position,
      note: "断线快照 / disconnect snapshot" };
    var f = snapshotPath(botId);
    if (!ensureDir(path.dirname(f))) { out.message = "dir failed / 目录创建失败"; return out; }
    var tmp = f + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), "utf8");
    fs.renameSync(tmp, f);
    totals.snapshots = totals.snapshots + 1;
    out.ok = true; out.path = f; out.at = at;
    out.items = Array.isArray(doc.queue) ? doc.queue.length : 0;
    out.message = "snapshot saved / 快照已保存";
    logInfo("[state-manager] snapshot / 断线快照已保存: " + out.botId + " queue=" + out.items);
    return out;
  } catch (e) { out.message = errText(e); return out; }
}
// 功能：重连后读取快照，返回 { ok, found, data, ageMs, message }；无快照时 found=false 且不报错。
function restore(botId, options) {
  var out = { ok: true, found: false, data: null, ageMs: 0, message: "no snapshot / 没有快照" };
  try {
    totals.restores = totals.restores + 1;
    var f = snapshotPath(botId);
    if (!fs.existsSync(f)) { totals.misses = totals.misses + 1; return out; }
    var doc = JSON.parse(fs.readFileSync(f, "utf8"));
    var opts = options && typeof options === "object" ? options : {};
    var maxAge = Number(opts.maxAgeMs) > 0 ? Number(opts.maxAgeMs) : 0;
    var nowMs = Number(opts.now) > 0 ? Number(opts.now) : Date.now();
    out.ageMs = Math.max(0, nowMs - (Number(doc.at) || 0));
    if (maxAge > 0 && out.ageMs > maxAge) { out.message = "snapshot expired / 快照已过期"; return out; }
    out.found = true; out.data = doc;
    out.message = "snapshot restored / 快照已恢复，继续干活";
    totals.hits = totals.hits + 1;
    logInfo("[state-manager] restore / 重连恢复任务: " + safeId(botId));
    return out;
  } catch (e) { out.ok = false; out.message = errText(e); return out; }
}
// 功能：列出全部快照文件（只列文件名，不读内容）。
function listSnapshots() {
  var out = [];
  try {
    var dir = path.join(stateDir(), SNAPSHOT_DIR);
    if (!fs.existsSync(dir)) return out;
    var names = fs.readdirSync(dir);
    for (var i = 0; i < names.length; i++) if (/\.json$/.test(names[i])) out.push(names[i].replace(/\.json$/, ""));
  } catch (e) { return out; }
  return out;
}
// 功能：删除某个 bot 的快照（任务彻底完成后清理），返回 true / false。
function clearSnapshot(botId) {
  try {
    var f = snapshotPath(botId);
    if (!fs.existsSync(f)) return false;
    fs.unlinkSync(f);
    return true;
  } catch (e) { return false; }
}
// 功能：读统计快照。
function stats() {
  return { ok: true, snapshots: totals.snapshots, restores: totals.restores,
    hits: totals.hits, misses: totals.misses, files: listSnapshots().length,
    dir: path.join(stateDir(), SNAPSHOT_DIR), version: SNAPSHOT_VERSION };
}
// 对外导出：通用读写 + 断线快照。
module.exports = {
  load: load, save: save, remove: remove,
  snapshot: snapshot, restore: restore, listSnapshots: listSnapshots,
  clearSnapshot: clearSnapshot, stats: stats
};
