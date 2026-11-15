// ========================================
// 文件：modules/shared-board.js
// 功能：共享黑板——所有 bot 共用的读写内存表（任务、状态、变量、消息）+ 100 bot 原子抢任务与 TTL 租约
//       + 生态循环门面（demand / supply 挂单、大任务拆单竞价、物资搬运入库）
// 依赖：fs / path（Node 内置）、./logger（可选）、./swarm-market（可选，延迟取 board 避免循环 require）
// 导出：post / get / has / del / keys / snapshot / clear / setFor / getFor / postMessage / inbox /
//       onChange / load / save / flush / getPath / postTask / claimTask / releaseTask /
//       completeTask / listTasks / reapExpired / taskStats / shardOf /
//       postDemand / postSupply / listDemand / listSupply / matchSupply / postBigTask / bid /
//       runAuction / onInventoryFull / claimHaul / deliver / ecosystem / registerBot / setBoard
// 作者：MineBots
// ========================================
//
// 用法 / usage
//   board.post("wood", 12)                 写一条数据（任意 JSON 值）
//   board.get("wood", 0)                   读一条数据，缺失返回兜底值
//   board.setFor("bot-1", "task", "砍树")   写某个 bot 的状态记录（键名 bot:<id>）
//   board.postMessage("bot-1", "集合")      给某个 bot 塞一条内部消息（环形队列，最多 50 条）
// 说明：写操作只改内存并安排一次防抖落盘（300 毫秒，定时器 unref），读操作永远不抛错。
// 测试隔离：环境变量 MINEBOTS_STATE_DIR 可替换 state 目录（与 prefs / param-manager 一致，不碰真实数据）。
// ES5 风格，CommonJS，无中文变量名
// 可选依赖：日志核心，缺失时所有输出退回 console，绝不抛错。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
// 可选依赖：生态循环（延迟取 board，故此处加载不会形成循环依赖）。
var market = null;
try { market = require("./swarm-market"); } catch (e) { market = null; }
// 可选依赖：IO 缓存（启动 30 秒周期后，黑板防抖落盘跟着降到同一节奏，防磁盘 IO 爆炸）。
var ioCache = null;
try { ioCache = require("./io-cache"); } catch (e) { ioCache = null; }

// 内置依赖：文件读写与路径处理，Node 自带，不会加载失败。
var fs = require("fs");
var path = require("path");

// 常量：落盘文件相对路径（相对项目根）/ 单条消息队列上限 / 落盘防抖毫秒数。
var BOARD_RELATIVE = path.join("state", "shared-board.json");
var MAX_INBOX = 50;
var SAVE_DEBOUNCE_MS = 300;
// 常量：键名最大长度（防止把奇怪的长串写进 JSON 键里）。
var KEY_LIMIT = 80;
// 常量：任务键前缀 / 分片数 / 默认租约 / 任务与认领上限（为 100 bot 抢任务准备）。
var TASK_PREFIX = "task:";
var TASK_SHARDS = 16;
var DEFAULT_LEASE_MS = 60000;
var MAX_TASKS = 1000;
var MAX_BOTS_SWARM = 100;

// 状态：黑板本体（键 → 值）/ 变更回调 / 落盘定时器句柄。
var data = {};
var listeners = [];
var saveTimer = null;
var dirty = false;
// 状态：任务分片索引（shard → taskId 数组），让 100 bot 抢任务时扫描是 O(分片内条数)。
var taskShards = [];
var taskCounter = 0;

// 写告警日志：优先 logger.warn，不可用时退回 console，绝不抛错。
function logWarn(msg) {
  try {
    if (logger && typeof logger.warn === "function") { logger.warn(msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.warn("[shared-board] " + msg); } catch (e) { /* ignore */ }
}

// 安全提取错误文本，避免在 catch 里再次抛错。
function getErrText(err) {
  try {
    if (err && err.message) return String(err.message);
    return String(err);
  } catch (e) { return "unknown error"; }
}

// 深拷贝一个纯数据值：拷贝失败（循环引用等）时原样返回，绝不抛错。
function cloneValue(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch (e) { return value; }
}

// 洗键名：去空白、截断，非法（空 / 非字符串）返回空串。
function cleanKey(key) {
  try {
    var text = String(key === null || key === undefined ? "" : key).replace(/^\s+|\s+$/g, "");
    if (text.length === 0) return "";
    if (text.length > KEY_LIMIT) text = text.slice(0, KEY_LIMIT);
    return text;
  } catch (e) { return ""; }
}

// 取落盘文件绝对路径，取不到退回相对路径。
// 取落盘路径：环境变量 MINEBOTS_STATE_DIR 优先（自测隔离），否则用项目根下的 state/shared-board.json。
function getPath() {
  try {
    var custom = process.env.MINEBOTS_STATE_DIR;
    if (custom && String(custom).length > 0) return path.resolve(String(custom), "shared-board.json");
    return path.resolve(process.cwd(), BOARD_RELATIVE);
  } catch (e) { return BOARD_RELATIVE; }
}

// 确保目录存在，失败返回 false。
function ensureDir() {
  try {
    var dir = path.dirname(getPath());
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch (e) { return false; }
}

// 算任务 id 落在哪个分片：稳定字符串哈希，异常一律回 0。
function shardOf(taskId) {
  try {
    var text = String(taskId === null || taskId === undefined ? "" : taskId);
    var h = 0;
    for (var i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 1000003;
    return h % TASK_SHARDS;
  } catch (e) { return 0; }
}

// 重建任务分片索引：从黑板里所有 task: 键重新登记，重复调用安全。
function rebuildTaskIndex() {
  try {
    taskShards = [];
    for (var i = 0; i < TASK_SHARDS; i++) taskShards.push([]);
    for (var key in data) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
      if (key.indexOf(TASK_PREFIX) !== 0) continue;
      var id = key.slice(TASK_PREFIX.length);
      var s = shardOf(id);
      if (taskShards[s].indexOf(id) < 0) taskShards[s].push(id);
    }
    return true;
  } catch (e) { return false; }
}

// 通知所有监听者：单个回调报错不影响其他回调。
function fireChange(key, value) {
  var list = [];
  try { list = listeners.slice(); } catch (e) { list = []; }
  for (var i = 0; i < list.length; i++) {
    try { list[i]({ key: key, value: cloneValue(value) }); } catch (e) { logWarn("onChange 回调异常 / callback failed: " + getErrText(e)); }
  }
}

// 功能：立即把黑板写进 state/shared-board.json，失败只写日志并返回 false。
function flush() {
  try {
    if (!ensureDir()) return false;
    fs.writeFileSync(getPath(), JSON.stringify(data, null, 2), "utf8");
    dirty = false;
    return true;
  } catch (e) {
    logWarn("黑板落盘失败 / save failed: " + getErrText(e));
    return false;
  }
}

// 取落盘防抖间隔：IO 缓存已启动就用它的 30 秒周期，否则维持 300 毫秒（自测可观测）。
function saveDelayMs() {
  try {
    if (ioCache && typeof ioCache.isActive === "function" && ioCache.isActive() && typeof ioCache.intervalMs === "function") {
      var ms = Number(ioCache.intervalMs());
      if (ms > 0) return ms;
    }
  } catch (e) { /* 读不到按默认 */ }
  return SAVE_DEBOUNCE_MS;
}
// 内部：安排一次防抖落盘（默认 300 毫秒；IO 缓存接管后 30 秒），定时器 unref，不拖住进程。
function scheduleSave() {
  dirty = true;
  try {
    if (saveTimer) return true;
    saveTimer = setTimeout(function () {
      saveTimer = null;
      try { if (dirty) flush(); } catch (e) { logWarn("防抖落盘异常 / debounce flush failed: " + getErrText(e)); }
    }, saveDelayMs());
    if (saveTimer && typeof saveTimer.unref === "function") saveTimer.unref();
    return true;
  } catch (e) {
    saveTimer = null;
    return false;
  }
}

// 功能：写一条数据（任意 JSON 值），返回 { ok, key }。
function post(key, value) {
  var name = cleanKey(key);
  if (name.length === 0) return { ok: false, message: "key 不能为空 / key required" };
  try {
    data[name] = cloneValue(value);
    scheduleSave();
    fireChange(name, data[name]);
    return { ok: true, key: name, value: cloneValue(data[name]) };
  } catch (e) {
    return { ok: false, key: name, message: getErrText(e) };
  }
}

// 功能：读一条数据，缺失返回兜底值（兜底值也会被深拷贝，防止调用方改坏黑板）。
function get(key, fallback) {
  var name = cleanKey(key);
  if (name.length === 0) return fallback;
  try {
    if (!Object.prototype.hasOwnProperty.call(data, name)) return fallback;
    return cloneValue(data[name]);
  } catch (e) { return fallback; }
}

// 功能：判断键是否存在，异常一律按不存在处理。
function has(key) {
  var name = cleanKey(key);
  if (name.length === 0) return false;
  try { return Object.prototype.hasOwnProperty.call(data, name); } catch (e) { return false; }
}

// 功能：删掉一条数据，返回 { ok, removed }。
function del(key) {
  var name = cleanKey(key);
  if (name.length === 0) return { ok: false, message: "key 不能为空 / key required" };
  var removed = false;
  try {
    if (Object.prototype.hasOwnProperty.call(data, name)) { delete data[name]; removed = true; }
    scheduleSave();
    if (removed) fireChange(name, null);
  } catch (e) { return { ok: false, message: getErrText(e) }; }
  return { ok: true, key: name, removed: removed };
}

// 功能：列出全部键名（副本），异常返回空数组。
function keys() {
  var out = [];
  try { out = Object.keys(data); } catch (e) { out = []; }
  return out;
}

// 功能：取整块黑板的快照（深拷贝），异常返回空对象。
function snapshot() {
  return cloneValue(data) || {};
}

// 功能：清空整块黑板（含消息队列），返回 { ok, count }。
function clear() {
  var count = 0;
  try { count = Object.keys(data).length; } catch (e) { count = 0; }
  data = {};
  rebuildTaskIndex();
  scheduleSave();
  return { ok: true, count: count };
}

// 功能：写某个 bot 的记录字段（键名 bot:<id>，值一定是对象），返回 { ok, record }。
function setFor(botId, field, value) {
  var id = cleanKey(botId);
  if (id.length === 0) return { ok: false, message: "botId 不能为空 / botId required" };
  var name = cleanKey(field);
  if (name.length === 0) return { ok: false, message: "field 不能为空 / field required" };
  var key = "bot:" + id;
  var record = {};
  try {
    var current = data[key];
    if (current && typeof current === "object") record = cloneValue(current);
    record[name] = cloneValue(value);
    record.updatedAt = new Date().toISOString();
    data[key] = record;
    scheduleSave();
    fireChange(key, record);
    return { ok: true, id: id, record: cloneValue(record) };
  } catch (e) {
    return { ok: false, id: id, message: getErrText(e) };
  }
}

// 功能：读某个 bot 的记录（副本），没有返回空对象。
function getFor(botId) {
  var id = cleanKey(botId);
  if (id.length === 0) return {};
  try {
    var record = data["bot:" + id];
    if (!record || typeof record !== "object") return {};
    return cloneValue(record);
  } catch (e) { return {}; }
}

// 功能：给某个 bot 塞一条内部消息（环形队列，最多 50 条），返回 { ok, size }。
function postMessage(botId, message) {
  var id = cleanKey(botId);
  if (id.length === 0) return { ok: false, message: "botId 不能为空 / botId required" };
  var key = "inbox:" + id;
  var list = [];
  try {
    var current = data[key];
    if (Array.isArray(current)) list = cloneValue(current);
    list.push({ at: new Date().toISOString(), text: String(message === null || message === undefined ? "" : message) });
    while (list.length > MAX_INBOX) list.shift();
    data[key] = list;
    scheduleSave();
    fireChange(key, list);
    return { ok: true, id: id, size: list.length };
  } catch (e) {
    return { ok: false, id: id, message: getErrText(e) };
  }
}

// 功能：读某个 bot 的内部消息队列（副本），没有返回空数组。
function inbox(botId) {
  var id = cleanKey(botId);
  if (id.length === 0) return [];
  try {
    var list = data["inbox:" + id];
    if (!Array.isArray(list)) return [];
    return cloneValue(list);
  } catch (e) { return []; }
}

// 功能：注册变更回调，返回取消注册函数；非函数入参直接拒绝。
function onChange(callback) {
  if (typeof callback !== "function") return null;
  listeners.push(callback);
  return function unsubscribe() {
    try {
      var i = listeners.indexOf(callback);
      if (i >= 0) listeners.splice(i, 1);
    } catch (e) { /* ignore */ }
  };
}

// 功能：从磁盘载入黑板（进程启动时调一次），解析失败保持空黑板并返回 { ok:false }。
function load() {
  try {
    var file = getPath();
    if (!fs.existsSync(file)) return { ok: true, loaded: false };
    var parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed;
    rebuildTaskIndex();
    return { ok: true, loaded: true, keys: keys().length };
  } catch (e) {
    logWarn("黑板载入失败 / load failed: " + getErrText(e));
    return { ok: false, message: getErrText(e) };
  }
}

// 功能：兼容别名——save 与 flush 等价（都立即落盘）。
function save() {
  return flush();
}

// 功能：清空内存黑板并按当前 MINEBOTS_STATE_DIR 重新载入（测试隔离 / 热重载用）。
// 为什么需要：黑板在 require 时只载入一次，自测想换到临时盘必须能主动重载，否则会沿用上一次的数据。
function reload() {
  try {
    data = {};
    taskShards = [];
    taskCounter = 0;
    dirty = false;
    if (saveTimer) { try { clearTimeout(saveTimer); } catch (eT) { /* ignore */ } saveTimer = null; }
    return load();
  } catch (e) { return { ok: false, message: getErrText(e) }; }
}

// 功能：发布一个任务，返回 { ok, taskId, task, message }；黑板满了或入参非法时返回 ok:false。
function postTask(task) {
  var body = task && typeof task === "object" ? task : {};
  try {
    if (listTasks({ status: "all" }).length >= MAX_TASKS) {
      return { ok: false, message: "task limit / 任务数已达上限" };
    }
    taskCounter = taskCounter + 1;
    var id = "t" + Date.now().toString(36) + "-" + String(taskCounter);
    var now = Date.now();
    var rec = {
      id: id,
      title: String(body.title || body.name || id).slice(0, 120),
      payload: cloneValue(body.payload === undefined ? {} : body.payload),
      priority: Number(body.priority) || 0,
      status: "pending",
      claimedBy: "",
      claimedAt: 0,
      leaseMs: Number(body.leaseMs) > 0 ? Number(body.leaseMs) : DEFAULT_LEASE_MS,
      createdAt: now,
      finishedAt: 0,
      result: null,
      shard: shardOf(id)
    };
    var key = TASK_PREFIX + id;
    data[key] = rec;
    if (!taskShards[rec.shard]) taskShards[rec.shard] = [];
    taskShards[rec.shard].push(id);
    scheduleSave();
    fireChange(key, rec);
    return { ok: true, taskId: id, task: cloneValue(rec), message: "task posted / 任务已发布" };
  } catch (e) {
    return { ok: false, message: getErrText(e) };
  }
}

// 功能：列出任务；filter 可带 status（pending/claimed/done/all）与 botId，异常返回空数组。
function listTasks(filter) {
  var out = [];
  var opt = filter && typeof filter === "object" ? filter : {};
  var want = String(opt.status || "all");
  try {
    for (var key in data) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
      if (key.indexOf(TASK_PREFIX) !== 0) continue;
      var rec = data[key];
      if (!rec || typeof rec !== "object") continue;
      if (want !== "all" && rec.status !== want) continue;
      if (opt.botId && String(rec.claimedBy) !== String(opt.botId)) continue;
      out.push(cloneValue(rec));
    }
    out.sort(function (a, b) {
      if (Number(b.priority) !== Number(a.priority)) return Number(b.priority) - Number(a.priority);
      return Number(a.createdAt) - Number(b.createdAt);
    });
  } catch (e) { out = []; }
  return out;
}

// 功能：回收过期租约（bot 掉线后任务不会永久锁死），返回被回收的任务数。
function reapExpired(nowMs) {
  var now = Number(nowMs) || Date.now();
  var count = 0;
  try {
    var list = listTasks({ status: "claimed" });
    for (var i = 0; i < list.length; i++) {
      var rec = list[i];
      if (Number(rec.claimedAt) + Number(rec.leaseMs) > now) continue;
      var key = TASK_PREFIX + rec.id;
      var live = data[key];
      if (!live || live.status !== "claimed") continue;
      live.status = "pending";
      live.claimedBy = "";
      live.claimedAt = 0;
      count = count + 1;
      fireChange(key, live);
    }
    if (count > 0) scheduleSave();
  } catch (e) { /* 回收失败不影响主流程 */ }
  return count;
}

// 功能：原子认领一个任务——单线程内无 await，100 bot 同时抢也不会把同一任务发给两个人。
// filter 可带 priority / tag；无可用任务时返回 ok:false。
function claimTask(botId, options) {
  var id = cleanKey(botId);
  if (id.length === 0) return { ok: false, message: "botId 不能为空 / botId required" };
  try {
    reapExpired(Date.now());
    var pending = listTasks({ status: "pending" });
    if (pending.length === 0) return { ok: false, botId: id, message: "no pending task / 暂无待领任务" };
    // 竞价派发：options.taskId 指定抢哪一单；不指定时保持老行为（取优先级最高的第一单）。
    var opt = options && typeof options === "object" ? options : {};
    var rec = pending[0];
    if (opt.taskId) {
      for (var t = 0; t < pending.length; t++) {
        if (String(pending[t].id) === String(opt.taskId)) { rec = pending[t]; break; }
      }
    }
    var key = TASK_PREFIX + rec.id;
    var live = data[key];
    if (!live || live.status !== "pending") return { ok: false, botId: id, message: "task taken / 任务已被抢走" };
    live.status = "claimed";
    live.claimedBy = id;
    live.claimedAt = Date.now();
    fireChange(key, live);
    scheduleSave();
    return { ok: true, botId: id, taskId: rec.id, task: cloneValue(live), message: "task claimed / 任务已认领" };
  } catch (e) {
    return { ok: false, botId: id, message: getErrText(e) };
  }
}

// 功能：归还任务（只有当前持有者能还），返回 { ok, taskId, message }。
function releaseTask(taskId, botId) {
  var key = TASK_PREFIX + String(taskId || "");
  try {
    var live = data[key];
    if (!live) return { ok: false, message: "task not found / 任务不存在" };
    if (String(live.claimedBy) !== String(botId || "")) return { ok: false, message: "not owner / 不是任务持有者" };
    live.status = "pending";
    live.claimedBy = "";
    live.claimedAt = 0;
    fireChange(key, live);
    scheduleSave();
    return { ok: true, taskId: live.id, message: "task released / 任务已归还" };
  } catch (e) { return { ok: false, message: getErrText(e) }; }
}

// 功能：标记任务完成（只有当前持有者能完成），返回 { ok, taskId, message }。
function completeTask(taskId, botId, result) {
  var key = TASK_PREFIX + String(taskId || "");
  try {
    var live = data[key];
    if (!live) return { ok: false, message: "task not found / 任务不存在" };
    if (String(live.claimedBy) !== String(botId || "")) return { ok: false, message: "not owner / 不是任务持有者" };
    live.status = "done";
    live.finishedAt = Date.now();
    live.result = cloneValue(result === undefined ? null : result);
    fireChange(key, live);
    scheduleSave();
    return { ok: true, taskId: live.id, message: "task done / 任务已完成" };
  } catch (e) { return { ok: false, message: getErrText(e) }; }
}

// 功能：任务板统计 { total, pending, claimed, done, shards, maxBots }。
function taskStats() {
  var out = { total: 0, pending: 0, claimed: 0, done: 0, shards: TASK_SHARDS, maxBots: MAX_BOTS_SWARM };
  try {
    var all = listTasks({ status: "all" });
    out.total = all.length;
    for (var i = 0; i < all.length; i++) {
      if (out[all[i].status] !== undefined) out[all[i].status] = out[all[i].status] + 1;
    }
    var used = 0;
    for (var s = 0; s < taskShards.length; s++) if (taskShards[s] && taskShards[s].length > 0) used = used + 1;
    out.usedShards = used;
  } catch (e) { /* 返回已统计部分 */ }
  return out;
}

// 启动：进程一起来就把上一次的黑板读回来，失败也只写日志。
rebuildTaskIndex();
load();

// 生态门面：把 swarm-market 的能力挂到黑板导出上；模块缺失或抛错都统一降级为 ok:false。
function marketCall(name) {
  return function () {
    try {
      if (!market || typeof market[name] !== "function") {
        return { ok: false, message: "swarm-market unavailable / 生态模块不可用" };
      }
      return market[name].apply(market, arguments);
    } catch (e) { return { ok: false, message: getErrText(e) }; }
  };
}

// 对外导出：读写 + 消息 + 事件 + 落盘 + 生态循环。
module.exports = {
  post: post,
  get: get,
  has: has,
  del: del,
  keys: keys,
  snapshot: snapshot,
  clear: clear,
  setFor: setFor,
  getFor: getFor,
  postMessage: postMessage,
  inbox: inbox,
  onChange: onChange,
  load: load,
  save: save,
  flush: flush,
  reload: reload,
  getPath: getPath,
  postTask: postTask,
  claimTask: claimTask,
  releaseTask: releaseTask,
  completeTask: completeTask,
  listTasks: listTasks,
  reapExpired: reapExpired,
  taskStats: taskStats,
  shardOf: shardOf,
  registerBot: marketCall("registerBot"),
  setBoard: marketCall("setBoard"),
  postDemand: marketCall("postDemand"),
  postSupply: marketCall("postSupply"),
  listDemand: marketCall("listDemand"),
  listSupply: marketCall("listSupply"),
  matchSupply: marketCall("matchSupply"),
  postBigTask: marketCall("postBigTask"),
  bid: marketCall("bid"),
  runAuction: marketCall("runAuction"),
  onInventoryFull: marketCall("onInventoryFull"),
  claimHaul: marketCall("claimHaul"),
  deliver: marketCall("deliver"),
  ecosystem: marketCall("ecosystem"),
  TASK_SHARDS: TASK_SHARDS,
  DEFAULT_LEASE_MS: DEFAULT_LEASE_MS,
  MAX_BOTS_SWARM: MAX_BOTS_SWARM
};
