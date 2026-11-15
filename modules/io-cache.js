// ========================================
// 文件：modules/io-cache.js
// 功能：高频 IO 防爆——黑板与坐标等热数据先放内存，每 30 秒异步落盘一次；
//       读永远走内存，写只打脏标记，彻底避免高频 fs.writeFileSync 打爆磁盘。
// 依赖：fs / path（Node 内置）、./logger（可选）
// 导出：put / get / remove / keys / noteBoard / putCoord / getCoord / flush / flushNow /
//       start / stop / isActive / intervalMs / stats / reset / pathOf / DEFAULT_INTERVAL_MS
// 作者：MineBots
// ========================================
// 说明：异步落盘用 fs.writeFile 回调，不阻塞事件循环；周期定时器一律 unref，
//   进程退出前可显式调用 flushNow() 保证不丢数据。MINEBOTS_STATE_DIR 隔离同样生效。
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

var fs = require("fs");
var path = require("path");
// 可选依赖：日志（只写文件）。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
// 常量：默认落盘间隔 30 秒 / 缓存文件名 / 坐标前缀。
var DEFAULT_INTERVAL_MS = 30000;
var CACHE_FILE = "io-cache.json";
var COORD_PREFIX = "coord:";
// 运行时：内存数据、脏标记、定时器与统计。
var cache = {};
var dirty = {};
var timer = null;
var currentInterval = DEFAULT_INTERVAL_MS;
var totals = { puts: 0, gets: 0, dirtyWrites: 0, flushes: 0, asyncFlushes: 0, failed: 0 };

// 写普通日志：只落文件，不推 GUI。
function logInfo(text) {
  try { if (logger && typeof logger.info === "function") logger.info(text); } catch (e) { /* ignore */ }
}
// 取错误文本，catch 里绝不再次抛错。
function errText(err) {
  try { if (!err) return "unknown error"; if (err.message) return String(err.message); return String(err); } catch (e) { return "unknown error"; }
}
// 深拷贝一份普通 JSON 值，失败返回原值。
function clone(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch (e) { return value; }
}
// 功能：取缓存文件绝对路径（MINEBOTS_STATE_DIR 优先）。
function pathOf() {
  try {
    var custom = process.env.MINEBOTS_STATE_DIR;
    var dir = custom && String(custom).length > 0 ? path.resolve(String(custom)) : path.resolve(process.cwd(), "state");
    return path.join(dir, CACHE_FILE);
  } catch (e) { return path.join("state", CACHE_FILE); }
}
// 确保目录存在，失败返回 false。
function ensureDir(f) {
  try { var dir = path.dirname(f); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); return true; } catch (e) { return false; }
}
// 功能：写一条热数据到内存并打脏标记；不触发任何磁盘写入。
function put(key, value) {
  try {
    var k = String(key);
    cache[k] = clone(value);
    dirty[k] = true;
    totals.puts = totals.puts + 1;
    totals.dirtyWrites = totals.dirtyWrites + 1;
    return { ok: true, key: k, buffered: true, dirtyKeys: Object.keys(dirty).length };
  } catch (e) { return { ok: false, message: errText(e) }; }
}
// 功能：从内存读一条热数据；不存在返回 fallback。
function get(key, fallback) {
  try {
    totals.gets = totals.gets + 1;
    if (Object.prototype.hasOwnProperty.call(cache, String(key))) return clone(cache[String(key)]);
  } catch (e) { /* 读失败回 fallback */ }
  return fallback;
}
// 功能：删除一条内存数据并打脏标记。
function remove(key) {
  try {
    var k = String(key);
    delete cache[k];
    dirty[k] = true;
    return { ok: true, key: k };
  } catch (e) { return { ok: false, message: errText(e) }; }
}
// 功能：列出内存中的键。
function keys() {
  try { return Object.keys(cache); } catch (e) { return []; }
}
// 功能：登记一份黑板镜像（高频写入只进内存），返回脏键数量。
function noteBoard(snapshot) {
  try { return put("board", snapshot || {}); } catch (e) { return { ok: false, message: errText(e) }; }
}
// 功能：缓存某个 bot 的坐标，返回写入结果。
function putCoord(botId, pos) {
  try { return put(COORD_PREFIX + String(botId), pos || {}); } catch (e) { return { ok: false, message: errText(e) }; }
}
// 功能：读取某个 bot 的坐标；没有返回 null。
function getCoord(botId) {
  try { return get(COORD_PREFIX + String(botId), null); } catch (e) { return null; }
}
// 内部：把当前内存快照序列化成落盘文档。
function document() {
  return { at: Date.now(), version: 1, intervalMs: currentInterval, data: clone(cache), note: "IO cache / 高频数据缓存" };
}
// 功能：同步落盘（进程退出 / 自测断言用），返回 true / false。
function flushNow() {
  try {
    var f = pathOf();
    if (!ensureDir(f)) return false;
    var tmp = f + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(document(), null, 2), "utf8");
    fs.renameSync(tmp, f);
    dirty = {};
    totals.flushes = totals.flushes + 1;
    return true;
  } catch (e) { totals.failed = totals.failed + 1; return false; }
}
// 功能：异步落盘一次（30 秒周期走这里），返回 Promise，绝不抛到顶层。
function flush() {
  return new Promise(function (resolve) {
    try {
      var f = pathOf();
      if (!ensureDir(f)) { resolve({ ok: false, message: "dir failed / 目录创建失败" }); return; }
      var body = JSON.stringify(document(), null, 2);
      fs.writeFile(f, body, "utf8", function (err) {
        if (err) { totals.failed = totals.failed + 1; resolve({ ok: false, message: errText(err) }); return; }
        dirty = {};
        totals.flushes = totals.flushes + 1;
        totals.asyncFlushes = totals.asyncFlushes + 1;
        logInfo("[io-cache] async flush / 异步落盘完成");
        resolve({ ok: true, file: f });
      });
    } catch (e) { totals.failed = totals.failed + 1; resolve({ ok: false, message: errText(e) }); }
  });
}
// 功能：启动周期落盘（默认 30 秒），定时器 unref；重复启动幂等。
function start(ms) {
  try {
    var interval = Number(ms) > 0 ? Math.floor(Number(ms)) : DEFAULT_INTERVAL_MS;
    currentInterval = interval;
    if (timer) return { ok: true, active: true, intervalMs: interval, message: "already running / 已在运行" };
    timer = setInterval(function () {
      try { if (Object.keys(dirty).length > 0) flush(); } catch (e) { /* ignore */ }
    }, interval);
    if (timer && typeof timer.unref === "function") timer.unref();
    return { ok: true, active: true, intervalMs: interval, message: "io cache started / IO 缓存已启动" };
  } catch (e) { return { ok: false, active: false, message: errText(e) }; }
}
// 功能：停止周期定时器（不强制落盘），返回是否停掉了。
function stop() {
  try {
    if (!timer) return { ok: true, stopped: false };
    clearInterval(timer);
    timer = null;
    return { ok: true, stopped: true };
  } catch (e) { return { ok: false, message: errText(e) }; }
}
// 功能：周期定时器是否在运行。
function isActive() { return !!timer; }
// 功能：当前落盘间隔（毫秒）。
function intervalMs() { return currentInterval; }
// 功能：读统计快照。
function stats() {
  return { ok: true, entries: keys().length, dirtyKeys: Object.keys(dirty).length,
    active: isActive(), intervalMs: currentInterval, file: pathOf(),
    puts: totals.puts, gets: totals.gets, flushes: totals.flushes,
    asyncFlushes: totals.asyncFlushes, failed: totals.failed };
}
// 功能：复位内存与定时器，并删掉自己写过的缓存文件（自测隔离用）。
function reset() {
  try { stop(); } catch (e) { /* ignore */ }
  try { if (fs.existsSync(pathOf())) fs.unlinkSync(pathOf()); } catch (e) { /* ignore */ }
  cache = {}; dirty = {};
  currentInterval = DEFAULT_INTERVAL_MS;
  totals = { puts: 0, gets: 0, dirtyWrites: 0, flushes: 0, asyncFlushes: 0, failed: 0 };
  return { ok: true, message: "io cache reset / IO 缓存已复位" };
}
// 对外导出。
module.exports = {
  put: put, get: get, remove: remove, keys: keys, noteBoard: noteBoard,
  putCoord: putCoord, getCoord: getCoord, flush: flush, flushNow: flushNow,
  start: start, stop: stop, isActive: isActive, intervalMs: intervalMs,
  stats: stats, reset: reset, pathOf: pathOf, DEFAULT_INTERVAL_MS: DEFAULT_INTERVAL_MS
};
