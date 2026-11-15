// ========================================
// 文件：modules/combat-ethics.js
// 功能：战斗伦理门面——亲密朋友攻击 Bot 后进入「告状待决」状态，期间禁止拔剑反击，
//       直到主人明确允许或超时；默认放行，绝不改变既有攻击行为
// 依赖：./event-bus、./player-manager、./logger（均可选，缺失时安全降级）
// 导出：noteComplaint / canAttack / ownerAllows / clear / pending / stats / reset / bind /
//       COMPLAINT_TTL_MS
// 作者：MineBots
// ========================================
//
// 为什么需要 / why：情感信任 2.0 的告状逻辑只负责「说话 + 逃跑」，但战斗节点仍在跑，
//   必须在攻击执行前有一道与认知层同源的门：告状未决 → attack 节点直接拒绝出手。
//   门面默认放行，只有显式登记过 complaint 的目标才被拦，既有自测行为完全不变。
// 事件订阅 / subscriptions：emotion.complaint / reflex.complaint → 自动登记待决告状。
// ES5 风格，CommonJS，无中文变量名；所有外部调用包 try/catch，绝不抛到顶层。

// 可选依赖：事件总线（自动登记告状）。
var bus = null;
try { bus = require("./event-bus"); } catch (e) { bus = null; }
// 可选依赖：玩家等级表（二次校验亲密关系）。
var players = null;
try { players = require("./player-manager"); } catch (e) { players = null; }
// 可选依赖：日志核心。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：告状待决有效期（毫秒），超时后自动放行，避免永久锁死战斗。
var COMPLAINT_TTL_MS = 120000;
// 常量：视为「亲密关系」的等级（这两级攻击时只告状）。
var CLOSE_LEVELS = ["owner", "close_friend"];
// 常量：拒绝出手的双语理由。
var DENY_MESSAGE = "已向主人告状，等待主人允许，暂不还手 / Complaint pending, waiting for owner permission";

// 待决告状：键为 botId + "|" + attacker，值为 { at, attacker, chat }。
var complaints = {};
// 累计统计（reset 清零）。
var totals = { complaints: 0, blocked: 0, allowed: 0, expired: 0, permissions: 0 };
// 事件桥挂载标记：event-bus.reset() 清空订阅后，下一次门面调用会自愈重挂。
var bridgeBound = false;

// 写文件日志：门面判定属高频，只落文件。
function logInfo(msg) {
  try { if (logger && typeof logger.info === "function") logger.info("[combat-ethics] " + msg); } catch (e) { /* ignore */ }
}
// 写系统日志：告状登记 / 主人放行是低频事件，推 GUI。
function logSystem(msg) {
  try {
    if (logger && typeof logger.system === "function") { logger.system("[combat-ethics] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[combat-ethics] " + msg); } catch (e2) { /* ignore */ }
}
// 安全取错误文本。
function errText(err) {
  try { if (err && err.message) return String(err.message); return String(err); }
  catch (e) { return "unknown error / 未知错误"; }
}
// 规范化 botId。
function idOf(botId) {
  try {
    var s = String(botId === null || botId === undefined ? "" : botId).replace(/^\s+|\s+$/g, "");
    return s.length === 0 ? "default" : s.slice(0, 80);
  } catch (e) { return "default"; }
}
// 规范化玩家名。
function clean(value) {
  if (value === null || value === undefined) return "";
  try { return String(value).replace(/^\s+|\s+$/g, ""); } catch (e) { return ""; }
}
// 拼待决键。
function keyOf(botId, attacker) {
  return idOf(botId) + "|" + clean(attacker).toLowerCase();
}
// 判断等级是否属于亲密关系。
function isClose(level) {
  var s = clean(level).toLowerCase();
  for (var i = 0; i < CLOSE_LEVELS.length; i++) if (s === CLOSE_LEVELS[i]) return true;
  return false;
}
// 功能：登记一条待决告状；返回 { ok, key, attacker }。
// 功能：接收情感层 / 反射层的告状事件并登记为待决；回调绝不抛到顶层。
function onComplaint(payload) {
  try {
    var p = payload && typeof payload === "object" ? payload : {};
    var who = clean(p.attacker || p.source || p.player);
    if (who.length > 0) noteComplaint(p.botId, who, { level: p.level, chat: p.chat || p.appeal });
  } catch (e) { /* 事件回调绝不冒到顶层 / never throw from callback */ }
}
// 功能：确保事件桥仍挂在总线上；总线被 reset 清空订阅后可自愈重挂（幂等）。
function ensureBridge() {
  try {
    if (!bus || typeof bus.on !== "function") return false;
    var n1 = typeof bus.listenerCount === "function" ? bus.listenerCount("emotion.complaint") : -1;
    var n2 = typeof bus.listenerCount === "function" ? bus.listenerCount("reflex.complaint") : -1;
    if (bridgeBound && n1 > 0 && n2 > 0) return true;
    if (typeof bus.off === "function") {
      bus.off("emotion.complaint", onComplaint);
      bus.off("reflex.complaint", onComplaint);
    }
    bus.on("emotion.complaint", onComplaint);
    bus.on("reflex.complaint", onComplaint);
    bridgeBound = true;
    return true;
  } catch (e) { return false; }
}
function noteComplaint(botId, attacker, options) {
  try {
    ensureBridge();
    var opts = options && typeof options === "object" ? options : {};
    var who = clean(attacker);
    if (who.length === 0) return { ok: false, message: "attacker required / 缺少攻击者名" };
    var id = idOf(botId);
    var key = keyOf(id, who);
    complaints[key] = {
      botId: id, attacker: who, at: Number(opts.at) || Date.now(),
      level: clean(opts.level) || "close_friend", chat: clean(opts.chat)
    };
    totals.complaints = totals.complaints + 1;
    logSystem("告状待决 / complaint pending: " + who + "，等待主人发话 / awaiting owner");
    return { ok: true, key: key, botId: id, attacker: who, ttlMs: COMPLAINT_TTL_MS };
  } catch (e) { return { ok: false, message: errText(e) }; }
}
// 清掉过期条目；返回清掉的条数。
function prune(now) {
  var n = 0;
  try {
    var at = Number(now) || Date.now();
    var keys = Object.keys(complaints);
    for (var i = 0; i < keys.length; i++) {
      if (at - complaints[keys[i]].at > COMPLAINT_TTL_MS) {
        delete complaints[keys[i]];
        n = n + 1;
      }
    }
  } catch (e) { /* 清理失败按无过期处理 */ }
  if (n > 0) totals.expired = totals.expired + n;
  return n;
}
// 功能：攻击前判定——告状未决（且未超时）的亲密朋友禁止拔剑；其余一律放行。
function canAttack(botId, target, options) {
  try {
    ensureBridge();
    var opts = options && typeof options === "object" ? options : {};
    var who = clean(target);
    var id = idOf(botId);
    prune(opts.now);
    if (who.length === 0) return { ok: true, allowed: true, reason: "no target / 无目标" };
    var key = keyOf(id, who);
    var pendingItem = complaints[key];
    // 跨 bot 兜底：同一个主人朋友被任一 bot 告状，全蜂群都不拔剑（事件可能只带 default id）。
    if (!pendingItem) {
      var allKeys = Object.keys(complaints);
      for (var k = 0; k < allKeys.length; k++) {
        if (complaints[allKeys[k]].attacker.toLowerCase() === who.toLowerCase()) {
          pendingItem = complaints[allKeys[k]];
          break;
        }
      }
    }
    if (pendingItem) {
      totals.blocked = totals.blocked + 1;
      logInfo("拒绝反击 / counter attack blocked: " + who + "（告状待决 / complaint pending）");
      return {
        ok: true, allowed: false, blocked: true, botId: id, target: who,
        reason: DENY_MESSAGE, message: DENY_MESSAGE,
        complaintAt: pendingItem.at, action: "wait_for_owner"
      };
    }
    // 二次校验：等级表明确是亲密关系且引擎标记为刚被告状过，也拦。
    if (players && typeof players.getLevel === "function" && isClose(players.getLevel(who)) &&
        opts.closeGuard === true) {
      totals.blocked = totals.blocked + 1;
      return { ok: true, allowed: false, blocked: true, botId: id, target: who,
        reason: "close friend / 亲密朋友，先问主人", message: DENY_MESSAGE, action: "ask_owner" };
    }
    totals.allowed = totals.allowed + 1;
    return { ok: true, allowed: true, blocked: false, botId: id, target: who,
      reason: "no pending complaint / 无待决告状" };
  } catch (e) {
    return { ok: false, allowed: true, blocked: false, message: errText(e) };
  }
}
// 功能：主人明确允许还手——清掉该目标的待决告状，返回 { ok }。
function ownerAllows(botId, attacker, options) {
  try {
    var opts = options && typeof options === "object" ? options : {};
    var who = clean(attacker);
    var id = idOf(botId);
    var removed = 0;
    if (who.length === 0) {
      var keys = Object.keys(complaints);
      for (var i = 0; i < keys.length; i++) {
        if (complaints[keys[i]].botId === id) { delete complaints[keys[i]]; removed = removed + 1; }
      }
    } else {
      var key = keyOf(id, who);
      if (complaints[key]) { delete complaints[key]; removed = 1; }
    }
    totals.permissions = totals.permissions + 1;
    logSystem("主人已允许还手 / owner granted permission: " + (who || "all") + " (" + removed + ")");
    return { ok: true, botId: id, attacker: who, removed: removed, message: "permission granted / 已允许还手" };
  } catch (e) { return { ok: false, message: errText(e) }; }
}
// 功能：手动清掉某个 bot 的待决告状（自测 / 下线清理）。
function clear(botId, attacker) {
  try {
    var id = idOf(botId);
    var who = clean(attacker);
    var n = 0;
    var keys = Object.keys(complaints);
    for (var i = 0; i < keys.length; i++) {
      var it = complaints[keys[i]];
      if (it.botId !== id) continue;
      if (who.length > 0 && it.attacker.toLowerCase() !== who.toLowerCase()) continue;
      delete complaints[keys[i]];
      n = n + 1;
    }
    return { ok: true, botId: id, removed: n };
  } catch (e) { return { ok: false, removed: 0, message: errText(e) }; }
}
// 功能：读待决告状列表（副本），供 GUI / 自测断言。
function pending(botId) {
  var out = [];
  try {
    var id = botId === undefined ? null : idOf(botId);
    var keys = Object.keys(complaints);
    for (var i = 0; i < keys.length; i++) {
      var it = complaints[keys[i]];
      if (id !== null && it.botId !== id) continue;
      out.push({ botId: it.botId, attacker: it.attacker, at: it.at, level: it.level, chat: it.chat });
    }
  } catch (e) { /* 读失败返回已有部分 */ }
  return out;
}
// 功能：读统计；失败也返回带 ok:false 的结构。
function stats() {
  try {
    prune(Date.now());
    return { ok: true, pending: pending().length, totals: {
      complaints: totals.complaints, blocked: totals.blocked, allowed: totals.allowed,
      expired: totals.expired, permissions: totals.permissions
    }, ttlMs: COMPLAINT_TTL_MS };
  } catch (e) { return { ok: false, pending: 0, message: errText(e) }; }
}
// 功能：重置全部待决与统计（自测隔离用）。
function reset() {
  complaints = {};
  totals = { complaints: 0, blocked: 0, allowed: 0, expired: 0, permissions: 0 };
  ensureBridge();
  return { ok: true, message: "combat ethics reset / 战斗伦理已重置" };
}
// 事件桥：模块加载即挂，后续由 ensureBridge() 在总线被清空后自愈；总线缺失时仍可显式登记。
try { ensureBridge(); } catch (eBridge) { /* 总线不可用时仍可显式 noteComplaint */ }

// 对外导出：登记 / 判定 / 放行 / 清理 / 统计。
module.exports = {
  noteComplaint: noteComplaint,
  canAttack: canAttack,
  ownerAllows: ownerAllows,
  clear: clear,
  pending: pending,
  stats: stats,
  reset: reset,
  bind: ensureBridge,
  COMPLAINT_TTL_MS: COMPLAINT_TTL_MS,
  DENY_MESSAGE: DENY_MESSAGE
};
