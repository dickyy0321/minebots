// ========================================
// 文件：modules/chat-channel.js
// 功能：聊天频道隔离——共享黑板 channels 表 / 指令分配频道 / 同频道私聊网关 / 频道人数上限
// 依赖：./shared-board（可选，缺失时退化为进程内存表）、./logger（可选）
// 导出：assign / unassign / removeChannel / channelOf / members / table / canHear / send /
//       parseCommand / handleCommand / format / stats / reset / DEFAULT_CHANNEL / MAX_MEMBERS / CHANNEL_KEY
// 说明：黑板键 channels 的结构是 { 频道名: [botId, ...] }；未分配的 bot 一律落在 default 频道，
//       只有同频道的两个 bot 才能互相私聊，杜绝全城刷屏。所有落盘走 shared-board，支持 MINEBOTS_STATE_DIR 隔离。
// 作者：MineBots
// ========================================

// 可选依赖：共享黑板与日志核心；取不到时退回内存表 / console，绝不抛错。
var board = null;
try { board = require("./shared-board"); } catch (e) { board = null; }
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：黑板键 / 默认频道 / 默认人数上限 / 频道名长度上限 / 消息长度上限。
var CHANNEL_KEY = "channels";
var DEFAULT_CHANNEL = "global";
var MAX_MEMBERS = 8;
var NAME_LIMIT = 24;
var MESSAGE_LIMIT = 256;

// 状态：黑板缺失时的内存降级表 / 操作计数（供 stats 与自测读）。
var memoryTable = {};
var totals = { assigned: 0, rejected: 0, blocked: 0, sent: 0, commands: 0 };

// 安全转字符串：null / undefined 统一成空串，异常返回空串。
function toText(value) {
  try { return String(value === null || value === undefined ? "" : value); } catch (e) { return ""; }
}

// 取错误文本：catch 里再抛错就破红线了。
function errText(err) {
  try { return err && err.message ? String(err.message) : String(err); } catch (e) { return "unknown error"; }
}

// 写告警日志：优先 logger.info（高频不刷 GUI），不可用时退回 console，绝不抛错。
function logInfo(msg) {
  try {
    if (logger && typeof logger.info === "function") { logger.info("[chat-channel] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[chat-channel] " + msg); } catch (e2) { /* ignore */ }
}

// 洗 botId：只留字母数字下划线横杠点，最长 40，非法返回空串。
function cleanId(value) {
  try {
    var text = toText(value).replace(/^\s+|\s+$/g, "");
    if (text.length === 0) return "";
    if (!/^[A-Za-z0-9_.-]+$/.test(text)) return "";
    return text.length > 40 ? text.slice(0, 40) : text;
  } catch (e) { return ""; }
}

// 洗频道名：小写化，只留字母数字下划线横杠，最长 24，非法返回空串。
function cleanChannel(value) {
  try {
    var text = toText(value).replace(/^\s+|\s+$/g, "").toLowerCase();
    if (text.length === 0) return "";
    text = text.replace(/^#/, "");
    if (!/^[a-z0-9_-]+$/.test(text)) return "";
    return text.length > NAME_LIMIT ? text.slice(0, NAME_LIMIT) : text;
  } catch (e) { return ""; }
}

// 深拷贝纯数据：失败时原样返回。
function clone(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch (e) { return value; }
}

// 读黑板上的频道表；结构异常时自动规整成对象，数组元素一律按字符串数组处理。
function table() {
  var raw = null;
  try {
    if (board && typeof board.get === "function") raw = board.get(CHANNEL_KEY, {});
  } catch (e) { raw = null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) raw = memoryTable;
  var out = {};
  try {
    var names = Object.keys(raw);
    for (var i = 0; i < names.length; i++) {
      var name = cleanChannel(names[i]);
      if (name.length === 0) continue;
      var list = raw[names[i]];
      if (!Array.isArray(list)) continue;
      var clean = [];
      for (var j = 0; j < list.length; j++) {
        var id = cleanId(list[j]);
        if (id.length > 0 && clean.indexOf(id) < 0) clean.push(id);
      }
      if (clean.length > 0) out[name] = clean;
    }
  } catch (e) { return {}; }
  return out;
}

// 写黑板频道表；黑板不可用时只写内存降级表，返回是否真的落到黑板。
function saveTable(data) {
  var safe = data && typeof data === "object" ? clone(data) : {};
  memoryTable = clone(safe);
  try {
    if (board && typeof board.post === "function") {
      board.post(CHANNEL_KEY, safe);
      return true;
    }
  } catch (e) { /* 退回内存表 */ }
  return false;
}

// 读某个 bot 所在频道；没分配过返回默认频道。
function channelOf(botId) {
  var id = cleanId(botId);
  if (id.length === 0) return DEFAULT_CHANNEL;
  try {
    var t = table();
    var names = Object.keys(t);
    for (var i = 0; i < names.length; i++) {
      if (t[names[i]].indexOf(id) >= 0) return names[i];
    }
  } catch (e) { /* 读失败按默认频道 */ }
  return DEFAULT_CHANNEL;
}

// 读某个频道的成员列表（副本）；频道不存在返回空数组。
function members(channel) {
  var name = cleanChannel(channel);
  if (name.length === 0) return [];
  try {
    var t = table();
    return Array.isArray(t[name]) ? t[name].slice(0) : [];
  } catch (e) { return []; }
}

// 功能：给 bot 分配频道——人数超上限直接拒绝并把原因双语返回，成功写回黑板。
function assign(botId, channel, options) {
  var out = { ok: false, botId: cleanId(botId), channel: cleanChannel(channel), members: [], message: "", limit: MAX_MEMBERS };
  try {
    var opts = options && typeof options === "object" ? options : {};
    if (out.botId.length === 0) { out.message = "botId 不能为空 / botId required"; return out; }
    if (out.channel.length === 0) { out.message = "频道名非法 / invalid channel name"; return out; }
    var limit = Number(opts.maxMembers) > 0 ? Math.floor(Number(opts.maxMembers)) : MAX_MEMBERS;
    out.limit = limit;
    var t = table();
    var list = Array.isArray(t[out.channel]) ? t[out.channel].slice(0) : [];
    var already = list.indexOf(out.botId) >= 0;
    if (!already && list.length >= limit) {
      totals.rejected = totals.rejected + 1;
      out.message = "频道 " + out.channel + " 已满（上限 " + limit + "）/ channel full (max " + limit + ")";
      return out;
    }
    // 一个 bot 只能在一个频道：先从其它频道摘掉，避免「到处都听得到」。
    var names = Object.keys(t);
    for (var i = 0; i < names.length; i++) {
      if (names[i] === out.channel) continue;
      var others = t[names[i]].filter(function (x) { return x !== out.botId; });
      if (others.length > 0) t[names[i]] = others;
      else delete t[names[i]];
    }
    if (!already) list.push(out.botId);
    t[out.channel] = list;
    saveTable(t);
    totals.assigned = totals.assigned + 1;
    out.ok = true;
    out.members = list.slice(0);
    out.message = out.botId + " 已加入频道 " + out.channel + " / " + out.botId + " joined channel " + out.channel;
    logInfo(out.message);
    return out;
  } catch (e) {
    out.message = errText(e);
    return out;
  }
}

// 功能：把 bot 从当前频道移除（回到默认频道），返回 { ok, botId, channel, message }。
function unassign(botId) {
  var id = cleanId(botId);
  var out = { ok: false, botId: id, channel: "", message: "" };
  if (id.length === 0) { out.message = "botId 不能为空 / botId required"; return out; }
  try {
    out.channel = channelOf(id);
    var t = table();
    if (!Array.isArray(t[out.channel])) { out.message = "bot 未在任何频道 / bot not assigned"; return out; }
    var list = t[out.channel].filter(function (x) { return x !== id; });
    if (list.length > 0) t[out.channel] = list;
    else delete t[out.channel];
    saveTable(t);
    out.ok = true;
    out.message = id + " 已退出频道 / " + id + " left the channel";
    return out;
  } catch (e) { out.message = errText(e); return out; }
}

// 功能：整频道解散，返回 { ok, channel, removed, message }。
function removeChannel(channel) {
  var name = cleanChannel(channel);
  var out = { ok: false, channel: name, removed: 0, message: "" };
  if (name.length === 0) { out.message = "频道名非法 / invalid channel name"; return out; }
  try {
    var t = table();
    out.removed = Array.isArray(t[name]) ? t[name].length : 0;
    delete t[name];
    saveTable(t);
    out.ok = true;
    out.message = "频道已解散 / channel removed: " + name;
    return out;
  } catch (e) { out.message = errText(e); return out; }
}

// 功能：判断两个 bot 能否互相私聊——必须同频道；返回含原因的判定对象。
function canHear(fromId, toId) {
  var from = cleanId(fromId);
  var to = cleanId(toId);
  var out = { ok: false, allowed: false, from: from, to: to, channel: "", targetChannel: "", reason: "" };
  try {
    if (from.length === 0 || to.length === 0) { out.reason = "botId 不能为空 / botId required"; return out; }
    out.channel = channelOf(from);
    out.targetChannel = channelOf(to);
    out.allowed = out.channel === out.targetChannel;
    out.ok = out.allowed;
    if (!out.allowed) {
      totals.blocked = totals.blocked + 1;
      out.reason = "跨频道私聊被拦截 / cross-channel whisper blocked: " + out.channel + " -> " + out.targetChannel;
      logInfo(out.reason);
    }
    return out;
  } catch (e) { out.reason = errText(e); return out; }
}

// 功能：把一条消息发给同频道的所有其它 bot（写各自黑板信箱），返回投递清单。
function send(fromId, text, options) {
  var from = cleanId(fromId);
  var body = toText(text).slice(0, MESSAGE_LIMIT);
  var out = { ok: false, from: from, channel: "", ids: [], delivered: 0, message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    if (from.length === 0) { out.message = "botId 不能为空 / botId required"; return out; }
    if (body.length === 0) { out.message = "消息不能为空 / message required"; return out; }
    out.channel = channelOf(from);
    var list = members(out.channel);
    var prefix = "[" + out.channel + "] [" + from + "] ";
    for (var i = 0; i < list.length; i++) {
      var target = list[i];
      if (target === from) continue;
      try {
        if (board && typeof board.postMessage === "function") board.postMessage(target, prefix + body);
        if (opts.whisper && typeof opts.whisper === "function") opts.whisper(from, target, body);
        out.ids.push(target);
      } catch (eOne) { /* 单个 bot 投递失败不影响其它成员 */ }
    }
    out.delivered = out.ids.length;
    out.ok = out.delivered > 0;
    totals.sent = totals.sent + out.delivered;
    out.message = out.ok
      ? "已投递 " + out.delivered + " 个同频道 bot / delivered to " + out.delivered + " bots in " + out.channel
      : "频道内没有其它 bot / no peers in " + out.channel;
    return out;
  } catch (e) { out.message = errText(e); return out; }
}

// 功能：解析玩家频道指令，支持 set bot-1 channel=team_red / set channel=team_red bot-1 /
//       channel bot-1 team_red / #channel bot-1 team_red；不认识时 matched=false。
function parseCommand(text) {
  var out = { ok: false, matched: false, botId: "", channel: "", raw: toText(text), message: "" };
  try {
    var raw = out.raw.replace(/^\s+|\s+$/g, "");
    if (raw.length === 0) return out;
    var body = raw.replace(/^[#/]\s*/, "");
    var lower = body.toLowerCase();
    if (lower.indexOf("channel") < 0) return out;
    // 先剥掉 set 前缀，否则 "set bot-1 channel=team_red" 会把 "set" 误认成 botId。
    var afterSet = body.replace(/^set\s+/i, "");
    // 形式 A：set <botId> channel=<name> 或 set channel=<name> <botId>
    var hit = /(?:^|\s)channel\s*[:=]\s*([a-z0-9_-]+)/i.exec(afterSet);
    if (hit) {
      out.channel = cleanChannel(hit[1]);
      var rest = afterSet.replace(hit[0], " ");
      var toks = rest.split(/\s+/);
      for (var i = 0; i < toks.length; i++) {
        var tok = toks[i];
        if (tok.length === 0 || /^(set|channel)$/i.test(tok)) continue;
        if (/^[a-z0-9_.-]+$/i.test(tok)) { out.botId = cleanId(tok); break; }
      }
    }
    // 形式 B：channel <botId> <name> / set <botId> channel <name>
    if (out.channel.length === 0 || out.botId.length === 0) {
      var parts = afterSet.split(/\s+/);
      for (var j = 0; j < parts.length; j++) {
        if (parts[j].toLowerCase() === "channel") {
          var a = parts[j + 1] || "", b = parts[j + 2] || "";
          if (b.length > 0) { out.botId = cleanId(a); out.channel = cleanChannel(b); }
          else {
            out.channel = cleanChannel(a);
            var head = parts[0] || "";
            out.botId = /^(channel|set)$/i.test(head) ? "" : cleanId(head);
          }
          break;
        }
      }
      // 形如 channel team_red bot-1 的倒序也要认。
      if (out.botId.length === 0) {
        var cand = parts.filter(function (x) { return /^bot[-_0-9a-z.]+$/i.test(x); });
        if (cand.length > 0) out.botId = cleanId(cand[0]);
      }
    }
    // 形如 set bot-1 channel=team_red 时上面 rest 可能只截到 bot-1，再兜一次全串扫描。
    if (out.botId.length === 0) {
      var all = body.split(/[\s=]+/);
      for (var k = 0; k < all.length; k++) {
        if (/^bot[-_0-9a-z.]+$/i.test(all[k])) { out.botId = cleanId(all[k]); break; }
      }
    }
    out.matched = out.botId.length > 0 && out.channel.length > 0;
    out.ok = out.matched;
    if (!out.matched) out.message = "频道指令格式不对 / bad channel command, e.g. set bot-1 channel=team_red";
    return out;
  } catch (e) { out.message = errText(e); return out; }
}

// 功能：处理一条玩家指令——命中就分配频道并返回双语回执，未命中原样返回 matched=false。
function handleCommand(text, options) {
  var parsed = parseCommand(text);
  var out = { ok: false, matched: parsed.matched, parsed: parsed, result: null, message: parsed.message };
  if (!parsed.matched) return out;
  try {
    totals.commands = totals.commands + 1;
    var res = assign(parsed.botId, parsed.channel, options);
    out.result = res;
    out.ok = res.ok;
    out.message = res.message;
    return out;
  } catch (e) { out.message = errText(e); return out; }
}

// 功能：把频道表整理成便于 GUI 展示的数组 [{ channel, members, count }]。
function format() {
  var out = [];
  try {
    var t = table();
    var names = Object.keys(t).sort();
    for (var i = 0; i < names.length; i++) {
      out.push({ channel: names[i], members: t[names[i]].slice(0), count: t[names[i]].length });
    }
  } catch (e) { return out; }
  return out;
}

// 功能：读统计快照（频道数 / 成员总数 / 累计拦截 / 累计投递 / 黑板是否可用）。
function stats() {
  var t = {};
  try { t = table(); } catch (e) { t = {}; }
  var count = 0;
  try {
    var names = Object.keys(t);
    for (var i = 0; i < names.length; i++) count = count + t[names[i]].length;
  } catch (e) { count = 0; }
  return {
    channels: Object.keys(t).length, members: count, assigned: totals.assigned,
    rejected: totals.rejected, blocked: totals.blocked, sent: totals.sent,
    commands: totals.commands, board: !!(board && typeof board.post === "function"),
    defaultChannel: DEFAULT_CHANNEL, maxMembers: MAX_MEMBERS
  };
}

// 功能：清空频道表与计数（自测隔离用，不动其它黑板数据）。
function reset() {
  memoryTable = {};
  totals = { assigned: 0, rejected: 0, blocked: 0, sent: 0, commands: 0 };
  try { saveTable({}); } catch (e) { /* ignore */ }
  try { if (board && typeof board.del === "function") board.del(CHANNEL_KEY); } catch (e2) { /* ignore */ }
  return { ok: true, message: "频道已清空 / channels cleared" };
}

module.exports = {
  assign: assign, unassign: unassign, removeChannel: removeChannel,
  channelOf: channelOf, members: members, table: table,
  canHear: canHear, send: send, parseCommand: parseCommand,
  handleCommand: handleCommand, format: format, stats: stats, reset: reset,
  DEFAULT_CHANNEL: DEFAULT_CHANNEL, MAX_MEMBERS: MAX_MEMBERS, CHANNEL_KEY: CHANNEL_KEY
};
