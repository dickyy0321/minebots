// ========================================
// 文件：modules/swarm.js
// 功能：群体协同——多 bot 登记 / 广播喊话 / 内部私聊 / 状态同步 / 轮询等待 / 自动分工
// 依赖：./shared-board（共享黑板，可选）、./logger（可选）
// 导出：register / unregister / get / getRecord / list / find / sync / statusOf / broadcast /
//       whisper / inboxOf / assign / taskOf / waitFor / clear / size
// 作者：MineBots
// ========================================
//
// 说明：本模块只做「登记 + 转发 + 轮询等待」，真正的移动 / 挖掘动作交给 state-nodes，
//       因此它不引用 state-machine / actions，避免循环依赖。
// ES5 风格，CommonJS，无中文变量名
var board = null;
try { board = require("./shared-board"); } catch (e) { board = null; }

// 可选依赖：日志核心，缺失时退回 console。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 可选依赖：聊天频道隔离；缺失时私聊 / 广播保持原行为（全城可见），绝不阻断协同。
var chatChannel = null;
try { chatChannel = require("./chat-channel"); } catch (e) { chatChannel = null; }

// 常量：轮询间隔（毫秒）——1 秒一拍足够，蜂群调度不是高频任务。
var POLL_MS = 1000;
var WAIT_DEFAULT_MS = 10000;
var WAIT_MAX_MS = 60000;

// 状态：id → { id, bot, at }，进程内注册表。
var registry = {};

// 写信息日志：优先 logger.info（只落文件不刷 GUI），失败退回 console。
function logInfo(msg) {
  try {
    if (logger && typeof logger.info === "function") { logger.info(msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[swarm] " + msg); } catch (e) { /* ignore */ }
}

// 写告警日志：优先 logger.warn，失败退回 console。
function logWarn(msg) {
  try {
    if (logger && typeof logger.warn === "function") { logger.warn(msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.warn("[swarm] " + msg); } catch (e) { /* ignore */ }
}

// 安全提取错误文本，catch 里不会二次抛错。
function getErrText(err) {
  try {
    if (err && err.message) return String(err.message);
    return String(err);
  } catch (e) { return "unknown error"; }
}

// 洗 id：去空白、限长 60，非法返回空串。
function cleanId(value) {
  try {
    var text = String(value === null || value === undefined ? "" : value).replace(/^\s+|\s+$/g, "");
    if (text.length === 0) return "";
    return text.length > 60 ? text.slice(0, 60) : text;
  } catch (e) { return ""; }
}

// 推断 id：优先调用方给的 id，其次 bot.username。
function inferId(bot, givenId) {
  var id = cleanId(givenId);
  if (id.length > 0) return id;
  try {
    if (bot && bot.username) return cleanId(bot.username);
  } catch (e) { /* ignore */ }
  return "";
}

// 读 bot 的坐标（保留两位小数），读不到返回 null。
function readPosition(bot) {
  try {
    var pos = bot && bot.entity && bot.entity.position;
    if (!pos) return null;
    return [Math.round(pos.x * 100) / 100, Math.round(pos.y * 100) / 100, Math.round(pos.z * 100) / 100];
  } catch (e) { return null; }
}

// 读 bot 的数值字段（health / food），读不到返回 null。
function readNumber(bot, field) {
  try {
    var value = bot ? bot[field] : null;
    if (typeof value === "number" && isFinite(value)) return value;
    return null;
  } catch (e) { return null; }
}

// 读 bot 的用户名，读不到返回空串。
function readUsername(bot) {
  try { return bot && bot.username ? String(bot.username) : ""; } catch (e) { return ""; }
}

// 功能：登记一个在线 bot（重复登记覆盖），并同步一次状态，失败返回 { ok:false }。
function register(bot, id) {
  var key = inferId(bot, id);
  if (key.length === 0) return { ok: false, message: "botId 不能为空 / botId required" };
  if (!bot) return { ok: false, message: "bot not ready / 机器人未就绪" };
  try {
    registry[key] = { id: key, bot: bot, at: new Date().toISOString() };
    sync(key);
    logInfo("登记 bot / register bot: " + key);
    return { ok: true, id: key, size: size() };
  } catch (e) {
    return { ok: false, id: key, message: getErrText(e) };
  }
}

// 功能：注销一个 bot（下线时调用），返回 { ok, removed }。
function unregister(id) {
  var key = cleanId(id);
  if (key.length === 0) return { ok: false, message: "botId 不能为空 / botId required" };
  var removed = false;
  try {
    if (Object.prototype.hasOwnProperty.call(registry, key)) { delete registry[key]; removed = true; }
    if (board && typeof board.setFor === "function") board.setFor(key, "online", false);
  } catch (e) { return { ok: false, id: key, message: getErrText(e) }; }
  return { ok: true, id: key, removed: removed };
}

// 功能：取某个 id 的 bot 对象，没有返回 null（调用方必须判空）。
function get(id) {
  var key = cleanId(id);
  if (key.length === 0) return null;
  try {
    var rec = registry[key];
    return rec ? (rec.bot || null) : null;
  } catch (e) { return null; }
}

// 功能：取某个 id 的登记摘要（含黑板里的最新状态），没有返回 null。
function getRecord(id) {
  var key = cleanId(id);
  if (key.length === 0) return null;
  try {
    var rec = registry[key];
    if (!rec) return null;
    return { id: rec.id, at: rec.at, online: true, username: readUsername(rec.bot), status: statusOf(key) };
  } catch (e) { return null; }
}

// 功能：列出全部已登记 bot 的摘要数组（id / username / position / health / food）。
function list() {
  var out = [];
  var ids = [];
  try { ids = Object.keys(registry); } catch (e) { ids = []; }
  for (var i = 0; i < ids.length; i++) {
    try {
      var rec = registry[ids[i]];
      if (!rec) continue;
      out.push({
        id: rec.id,
        username: readUsername(rec.bot),
        online: true,
        position: readPosition(rec.bot),
        health: readNumber(rec.bot, "health"),
        food: readNumber(rec.bot, "food")
      });
    } catch (e) { /* 单个 bot 出错不影响整体 */ }
  }
  return out;
}

// 功能：按 id 或用户名找 bot 的 id，找不到返回空串。
function find(name) {
  var wanted = cleanId(name).toLowerCase();
  if (wanted.length === 0) return "";
  var ids = [];
  try { ids = Object.keys(registry); } catch (e) { ids = []; }
  for (var i = 0; i < ids.length; i++) {
    try {
      if (String(ids[i]).toLowerCase() === wanted) return ids[i];
      var uname = readUsername(registry[ids[i]].bot).toLowerCase();
      if (uname.length > 0 && uname === wanted) return ids[i];
    } catch (e) { /* 继续找下一个 */ }
  }
  return "";
}

// 功能：把某个 bot 的实时状态写进共享黑板（bot:<id>），失败返回 { ok:false }。
function sync(id) {
  var key = cleanId(id);
  if (key.length === 0) return { ok: false, message: "botId 不能为空 / botId required" };
  var bot = get(key);
  if (!bot) return { ok: false, id: key, message: "bot 未登记 / bot not registered" };
  if (!board || typeof board.setFor !== "function") return { ok: false, id: key, message: "board 不可用 / board unavailable" };
  var res = { ok: true, id: key };
  var fields = { online: true, username: readUsername(bot), position: readPosition(bot), health: readNumber(bot, "health"), food: readNumber(bot, "food") };
  for (var name in fields) {
    if (!Object.prototype.hasOwnProperty.call(fields, name)) continue;
    var one = board.setFor(key, name, fields[name]);
    if (!one || one.ok !== true) res = { ok: false, id: key, message: "黑板写入失败 / board write failed" };
  }
  return res;
}

// 功能：读某个 bot 在黑板里的状态记录，没有返回空对象。
function statusOf(id) {
  var key = cleanId(id);
  if (key.length === 0) return {};
  try {
    if (board && typeof board.getFor === "function") return board.getFor(key);
    return {};
  } catch (e) { return {}; }
}

// 功能：群发一条消息给所有已登记 bot（可排除发起者）；传 options.fromId / options.channel 时
//       只发给同频道成员，杜绝全城刷屏。不传 options 时完全保持旧的「全员广播」行为。
function broadcast(text, exceptId, options) {
  var body = String(text === null || text === undefined ? "" : text);
  if (body.length === 0) return { ok: false, message: "消息不能为空 / message required" };
  var skip = cleanId(exceptId);
  var opts = options && typeof options === "object" ? options : {};
  var wantedChannel = "";
  try {
    if (chatChannel && typeof chatChannel.channelOf === "function" && (cleanId(opts.fromId).length > 0 || opts.channel)) {
      wantedChannel = opts.channel ? String(opts.channel).toLowerCase() : chatChannel.channelOf(cleanId(opts.fromId));
    }
  } catch (eCh) { wantedChannel = ""; }
  var sent = [];
  var ids = [];
  try { ids = Object.keys(registry); } catch (e) { ids = []; }
  for (var i = 0; i < ids.length; i++) {
    var key = ids[i];
    if (skip.length > 0 && key === skip) continue;
    if (wantedChannel.length > 0 && chatChannel && typeof chatChannel.channelOf === "function") {
      try { if (chatChannel.channelOf(key) !== wantedChannel) continue; } catch (eFilter) { /* 过滤失败按放行 */ }
    }
    try {
      var bot = registry[key].bot;
      if (bot && typeof bot.chat === "function") { bot.chat(body); sent.push(key); }
      if (board && typeof board.postMessage === "function") board.postMessage(key, body);
    } catch (e) { logWarn("广播失败 / broadcast failed: " + key + " - " + getErrText(e)); }
  }
  return { ok: sent.length > 0, sent: sent.length, ids: sent };
}

// 功能：内部私聊——先过频道网关（跨频道直接拒绝），再写进目标 bot 的黑板信箱，目标在线时复述一遍。
function whisper(fromId, toId, text) {
  var from = cleanId(fromId);
  var to = cleanId(toId);
  var body = String(text === null || text === undefined ? "" : text);
  if (to.length === 0) return { ok: false, message: "目标 bot 不能为空 / target botId required" };
  if (body.length === 0) return { ok: false, message: "消息不能为空 / message required" };
  // 频道隔离：不在同一频道的 bot 收不到私聊，防止全城刷屏；频道模块缺失时放行。
  try {
    if (chatChannel && typeof chatChannel.canHear === "function" && from.length > 0) {
      var verdict = chatChannel.canHear(from, to);
      if (verdict && verdict.allowed === false) {
        return { ok: false, from: from, to: to, delivered: false, blocked: true,
          channel: verdict.channel, targetChannel: verdict.targetChannel, message: verdict.reason };
      }
    }
  } catch (eChannel) { /* 频道网关异常时按原行为继续 */ }
  var delivered = false;
  try {
    if (board && typeof board.postMessage === "function") {
      var res = board.postMessage(to, (from.length > 0 ? "[" + from + "] " : "") + body);
      delivered = !!(res && res.ok === true);
    }
    var target = get(to);
    if (target && typeof target.chat === "function") { target.chat("(私聊/whisper) " + body); delivered = true; }
  } catch (e) {
    return { ok: false, message: getErrText(e) };
  }
  return { ok: delivered, from: from, to: to, delivered: delivered };
}

// 功能：读某个 bot 的信箱（最近的内部消息），没有返回空数组。
function inboxOf(id) {
  var key = cleanId(id);
  if (key.length === 0) return [];
  try {
    if (board && typeof board.inbox === "function") return board.inbox(key);
    return [];
  } catch (e) { return []; }
}

// 功能：处理玩家频道指令（如 set bot-1 channel=team_red），返回双语回执；频道模块缺失时 ok:false。
function channelCommand(text, options) {
  try {
    if (!chatChannel || typeof chatChannel.handleCommand !== "function") {
      return { ok: false, matched: false, message: "频道模块未加载 / chat-channel unavailable" };
    }
    return chatChannel.handleCommand(text, options);
  } catch (e) { return { ok: false, matched: false, message: getErrText(e) }; }
}

// 功能：同频道广播——写黑板信箱，在线成员再复述一遍，返回投递清单。
function channelBroadcast(fromId, text) {
  try {
    if (!chatChannel || typeof chatChannel.send !== "function") {
      return { ok: false, ids: [], delivered: 0, message: "频道模块未加载 / chat-channel unavailable" };
    }
    return chatChannel.send(fromId, text, {
      whisper: function (from, to, body) {
        try {
          var target = get(to);
          if (target && typeof target.chat === "function") target.chat("(频道/channel) " + body);
        } catch (eOne) { /* 单个成员投递失败不影响其它成员 */ }
      }
    });
  } catch (e) { return { ok: false, ids: [], delivered: 0, message: getErrText(e) }; }
}

// 功能：读某个 bot 所在频道名；频道模块缺失时返回 default。
function channelOf(id) {
  try {
    if (chatChannel && typeof chatChannel.channelOf === "function") return chatChannel.channelOf(cleanId(id));
  } catch (e) { /* 读失败按默认频道 */ }
  return "global";
}

// 功能：把任务分配给某个 bot（写黑板 task:<id> 与 bot 记录），返回 { ok, task }。
function assign(toId, task, machineName) {
  var to = cleanId(toId);
  if (to.length === 0) return { ok: false, message: "目标 bot 不能为空 / target botId required" };
  var payload = { task: String(task === null || task === undefined ? "" : task), machine: cleanId(machineName), at: new Date().toISOString() };
  if (payload.task.length === 0 && payload.machine.length === 0) return { ok: false, message: "任务不能为空 / task required" };
  try {
    if (board && typeof board.post === "function") board.post("task:" + to, payload);
    if (board && typeof board.setFor === "function") board.setFor(to, "task", payload.task.length > 0 ? payload.task : payload.machine);
  } catch (e) {
    return { ok: false, message: getErrText(e) };
  }
  return { ok: true, to: to, task: payload };
}

// 功能：读某个 bot 当前被分配的任务，没有返回 null。
function taskOf(id) {
  var to = cleanId(id);
  if (to.length === 0) return null;
  try {
    if (board && typeof board.get === "function") return board.get("task:" + to, null);
    return null;
  } catch (e) { return null; }
}

// 内部：睡一会儿（定时器 unref，绝不拖住进程）。
function sleep(ms) {
  return new Promise(function (resolve) {
    var timer = null;
    try {
      timer = setTimeout(function () { resolve(true); }, ms);
      if (timer && typeof timer.unref === "function") timer.unref();
    } catch (e) { resolve(false); }
  });
}

// 内部：判断一次等待条件——expect 形如 { field, op, value }，op 缺省按 eq 比较。
function checkExpect(status, expect) {
  if (!expect || typeof expect !== "object") return false;
  var field = String(expect.field === undefined ? "online" : expect.field);
  var op = String(expect.op === undefined ? "eq" : expect.op).toLowerCase();
  var wanted = expect.value;
  var got = status ? status[field] : undefined;
  try {
    if (op === "gt") return Number(got) > Number(wanted);
    if (op === "gte") return Number(got) >= Number(wanted);
    if (op === "lt") return Number(got) < Number(wanted);
    if (op === "lte") return Number(got) <= Number(wanted);
    if (op === "exists") return got !== undefined && got !== null;
    return JSON.stringify(got) === JSON.stringify(wanted);
  } catch (e) { return false; }
}

// 功能：轮询等待某个 bot 达到条件，返回 Promise<{ ok, waited, reason }>；超时只返回 ok:false。
function waitFor(id, expect, timeoutMs) {
  var key = cleanId(id);
  if (key.length === 0) return Promise.resolve({ ok: false, reason: "botId 不能为空 / botId required" });
  var limit = Number(timeoutMs);
  if (!isFinite(limit) || limit <= 0) limit = WAIT_DEFAULT_MS;
  if (limit > WAIT_MAX_MS) limit = WAIT_MAX_MS;
  var started = Date.now();
  return new Promise(function (resolve) {
    var tick = function () {
      var status = statusOf(key);
      if (checkExpect(status, expect)) { resolve({ ok: true, id: key, waited: Date.now() - started }); return; }
      if (Date.now() - started >= limit) { resolve({ ok: false, id: key, waited: Date.now() - started, reason: "timeout / 等待超时" }); return; }
      sleep(POLL_MS).then(tick);
    };
    tick();
  });
}

// 功能：清空注册表（停止全部 bot / 自测用），返回 { ok, count }。
function clear() {
  var count = 0;
  try { count = Object.keys(registry).length; } catch (e) { count = 0; }
  registry = {};
  return { ok: true, count: count };
}

// 功能：已登记的 bot 数量。
function size() {
  try { return Object.keys(registry).length; } catch (e) { return 0; }
}

// 对外导出：注册 / 查询 / 通信 / 等待 / 分工。
module.exports = {
  register: register,
  unregister: unregister,
  get: get,
  getRecord: getRecord,
  list: list,
  find: find,
  sync: sync,
  statusOf: statusOf,
  broadcast: broadcast,
  whisper: whisper,
  channelCommand: channelCommand,
  channelBroadcast: channelBroadcast,
  channelOf: channelOf,
  inboxOf: inboxOf,
  assign: assign,
  taskOf: taskOf,
  waitFor: waitFor,
  clear: clear,
  size: size
};

