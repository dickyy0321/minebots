// ========================================
// 文件：modules/knowledge-base.js
// 功能：模组知识库——持久化学会的模组知识条目与向量
// 依赖：fs / path（Node 内置）、./logger（可选，失败不崩）
// 导出：loadAll / find / save / remove / listNames / stats / saveVector / loadVector / getPath
// 作者：MineBots
// ========================================

// 可选依赖：日志核心，缺失时所有输出退回 console，绝不抛错。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 内置依赖：文件读写与路径处理，Node 自带，不会加载失败。
var fs = require("fs");
var path = require("path");

// 常量：状态目录与两个数据文件，相对进程工作目录（项目根）解析。
var STATE_DIR = path.resolve(process.cwd(), "state");
var KNOW_FILE = path.join(STATE_DIR, "mod-knowledge.json");
var VEC_FILE = path.join(STATE_DIR, "mod-vectors.json");
// 常量：置信度默认值与每次学会的增量、上限。
var DEFAULT_CONFIDENCE = 0.5;
var CONFIDENCE_STEP = 0.1;
var MAX_CONFIDENCE = 1;

// 写日志：优先 logger.info，不可用时退回 console，绝不抛错。
function logInfo(msg) {
  try {
    if (logger && typeof logger.info === "function") { logger.info(msg); return true; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[knowledge-base] " + msg); } catch (e) { /* 连 console 都没有就算了 */ }
  return true;
}

// 安全提取错误文本，避免在 catch 里再次抛错。
function getErrText(err) {
  try {
    if (err && err.message) return String(err.message);
    return String(err);
  } catch (e) { return "unknown error"; }
}

// 把任意值转成字符串，转换失败返回空串。
function toText(value) {
  try {
    if (value === null || value === undefined) return "";
    return String(value);
  } catch (e) { return ""; }
}

// 把任意值整理成普通字典，数组 / null / 非对象一律当空字典。
function asDict(value) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value;
  } catch (e) { return {}; }
}

// 把置信度夹到 [0, 1]，非数字退回默认值 0.5。
function clampConfidence(value) {
  var n = Number(value);
  if (isNaN(n)) return DEFAULT_CONFIDENCE;
  if (n < 0) return 0;
  if (n > MAX_CONFIDENCE) return MAX_CONFIDENCE;
  return n;
}

// 判断是不是全数字数组，空数组也算合法。
function isNumberArray(value) {
  try {
    if (!Array.isArray(value)) return false;
    for (var i = 0; i < value.length; i++) {
      var n = Number(value[i]);
      if (isNaN(n) || !isFinite(n)) return false;
    }
    return true;
  } catch (e) { return false; }
}

// 目录不存在则递归创建，失败返回 false。
function ensureStateDir() {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    return true;
  } catch (e) { return false; }
}

// 读一个 JSON 文件，文件缺失或解析失败都返回备份值。
function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) { return fallback; }
}

// 原子写 JSON：先写 .tmp 再 rename，失败返回 { ok:false, error }。
function writeJsonAtomic(file, data) {
  var tmp = file + ".tmp";
  try {
    if (!ensureStateDir()) return { ok: false, error: "state dir unavailable: " + STATE_DIR };
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) { /* 残留临时文件不影响主流程 */ }
    return { ok: false, error: getErrText(e) };
  }
}

// 功能 1：读取全部——读 state/mod-knowledge.json，缺失或解析失败都返回空字典。
function loadAll() {
  return asDict(readJsonSafe(KNOW_FILE, {}));
}

// 功能 2：查找一个——按方块名取条目，没有返回 null。
function find(name) {
  var key = toText(name);
  if (key.length === 0) return null;
  try {
    var items = loadAll();
    return items[key] || null;
  } catch (e) { return null; }
}

// 功能 3：保存一条——已存在只涨置信度（+0.1，上限 1.0）与更新时间，否则建新条目，返回 { ok }。
function save(name, ctx) {
  var key = toText(name);
  if (key.length === 0) return { ok: false, error: "name is required" };
  if (!ctx || typeof ctx !== "object") return { ok: false, error: "context is required" };
  try {
    var items = loadAll();
    var now = new Date().toISOString();
    if (items[key]) {
      items[key].confidence = clampConfidence(clampConfidence(items[key].confidence) + CONFIDENCE_STEP);
      items[key].updatedAt = now;
    } else {
      items[key] = {
        name: key,
        purpose: toText(ctx.purpose) || key,
        interaction: toText(ctx.interaction) || "unknown",
        confidence: clampConfidence(ctx.confidence),
        source: toText(ctx.source) || "unknown",
        description: toText(ctx.description),
        bestInteraction: null,
        createdAt: now,
        updatedAt: now
      };
    }
    var result = writeJsonAtomic(KNOW_FILE, items);
    if (!result.ok) logInfo("保存失败 " + key + ": " + toText(result.error));
    return result;
  } catch (e) {
    return { ok: false, error: getErrText(e) };
  }
}

// 功能 4：删除一条——删掉条目并写盘，成功返回 true。
function remove(name) {
  var key = toText(name);
  if (key.length === 0) return false;
  try {
    var items = loadAll();
    if (!items[key]) return false;
    delete items[key];
    var result = writeJsonAtomic(KNOW_FILE, items);
    if (!result.ok) logInfo("删除失败 " + key + ": " + toText(result.error));
    return result.ok === true;
  } catch (e) { return false; }
}

// 功能 5：列出全部名字——返回名字数组（没有条目就是空数组）。
function listNames() {
  try { return Object.keys(loadAll()); } catch (e) { return []; }
}

// 功能 6：统计——返回 { total, bySource: { 来源: 条数 } }。
function stats() {
  var out = { total: 0, bySource: {} };
  try {
    var items = loadAll();
    var keys = Object.keys(items);
    out.total = keys.length;
    for (var i = 0; i < keys.length; i++) {
      var entry = asDict(items[keys[i]]);
      var source = toText(entry.source) || "unknown";
      out.bySource[source] = (Number(out.bySource[source]) || 0) + 1;
    }
  } catch (e) {
    return { total: 0, bySource: {} };
  }
  return out;
}

// 功能 7：存向量——name 对数字数组，写 state/mod-vectors.json，返回 { ok }。
function saveVector(name, vector) {
  var key = toText(name);
  if (key.length === 0) return { ok: false, error: "name is required" };
  if (!isNumberArray(vector)) return { ok: false, error: "vector must be an array of numbers" };
  try {
    var vectors = asDict(readJsonSafe(VEC_FILE, {}));
    vectors[key] = vector.slice(0);
    var result = writeJsonAtomic(VEC_FILE, vectors);
    if (!result.ok) logInfo("存向量失败 " + key + ": " + toText(result.error));
    return result;
  } catch (e) {
    return { ok: false, error: getErrText(e) };
  }
}

// 功能 7：读向量——没有或者存得不对都返回 null。
function loadVector(name) {
  var key = toText(name);
  if (key.length === 0) return null;
  try {
    var vectors = asDict(readJsonSafe(VEC_FILE, {}));
    var vector = vectors[key];
    if (!Array.isArray(vector)) return null;
    return vector;
  } catch (e) { return null; }
}

// 功能 8：返回数据文件绝对路径，kind 传 "vectors" 时返回向量文件，默认知识条目文件。
function getPath(kind) {
  try { if (toText(kind) === "vectors") return VEC_FILE; } catch (e) { /* 退回知识条目文件 */ }
  return KNOW_FILE;
}

module.exports = {
  loadAll: loadAll,
  find: find,
  save: save,
  remove: remove,
  listNames: listNames,
  stats: stats,
  saveVector: saveVector,
  loadVector: loadVector,
  getPath: getPath
};
