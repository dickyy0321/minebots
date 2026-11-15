// ========================================
// 文件：modules/state-skills-trigger.js
// 功能：状态机触发器节点——6 个「条件」动作：下坠 / 被瞄准 / 背包满 / 没吃的 / 队友血低 / 正在挨打
// 依赖：./state-util（可选）、./telemetry（可选）、./logger（可选）
// 导出：HANDLERS / NAMES / has / pick / ACTIONS
// 作者：MineBots
// ========================================
//
// 约定：触发器是「只读判断」，绝不动手；返回 { ok, value:true|false, message }。
//       状态机把 value 拿去做跳转条件，ok:false 只在 bot 不可用时出现。
// ES5 风格，CommonJS，无中文变量名
var util = null;
try { util = require("./state-util"); } catch (e) { util = null; }

// 可选依赖：遥测（挨打事件存在环形缓存里）。
var telemetry = null;
try { telemetry = require("./telemetry"); } catch (e) { telemetry = null; }

// 可选依赖：日志核心，缺失时退回 console。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：各触发器的默认阈值（都可在节点参数里覆盖）。
var FALL_MIN = 3;
var AIM_RADIUS = 10;
var AIM_ANGLE = 30;
var FREE_SLOTS = 2;
var FOOD_MIN = 6;
var ALLY_PERCENT = 30;
var HURT_WINDOW_MS = 5000;

// 安全提取错误文本，catch 里不会二次抛错。
function getErrText(err) {
  try {
    if (err && err.message) return String(err.message);
    return String(err);
  } catch (e) { return "unknown error"; }
}

// 转文本（null / undefined → 空串）。
function toText(value) {
  try {
    if (value === null || value === undefined) return "";
    return String(value);
  } catch (e) { return ""; }
}

// 转数字（失败返回兜底值）。
function toNum(value, fallback) {
  var base = (fallback === undefined) ? 0 : fallback;
  try {
    var num = parseFloat(toText(value));
    return isNaN(num) ? base : num;
  } catch (e) { return base; }
}

// 写文件日志：触发器每秒都在跑，只落文件不推 GUI。
function logInfo(msg) {
  try {
    if (logger && typeof logger.info === "function") { logger.info("[state-trigger] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[state-trigger] " + msg); } catch (e2) { /* ignore */ }
}

// 判断 bot 是否可用；不可用直接返回双语失败结果。
function requireBot(bot) {
  if (!bot) return { ok: false, message: "bot not ready / 机器人未就绪" };
  try {
    if (!bot.entity) return { ok: false, message: "bot entity missing / 机器人实体缺失" };
  } catch (e) { return { ok: false, message: "bot entity missing / 机器人实体缺失" }; }
  return null;
}

// 造一个条件结果：value 是真假，message 里带具体数值方便 GUI / 日志看。
function result(name, value, detail) {
  var tail = toText(detail);
  return {
    ok: true,
    name: name,
    value: value === true,
    message: (value === true ? "条件成立 / triggered: " : "条件不成立 / idle: ") + name + (tail.length > 0 ? " (" + tail + ")" : "")
  };
}

// 安全读 bot 的 position（读不到返回 null）。
function posOf(bot) {
  try {
    return (bot && bot.entity && bot.entity.position) ? bot.entity.position : null;
  } catch (e) { return null; }
}

// 安全读实体的 y 坐标（读不到返回 NaN）。
function yOf(point) {
  try {
    if (!point) return NaN;
    return toNum(point.y, NaN);
  } catch (e) { return NaN; }
}

// 内部：两个水平坐标之间的平面距离。
function horizontalDist(a, b) {
  try {
    var dx = toNum(a.x, 0) - toNum(b.x, 0);
    var dz = toNum(a.z, 0) - toNum(b.z, 0);
    return Math.sqrt(dx * dx + dz * dz);
  } catch (e) { return Infinity; }
}

// 内部：把角度归一化到 -180~180 度。
function normalizeDeg(deg) {
  var d = toNum(deg, 0) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

// 内部：算「我从 me 看向 target」的 yaw（弧度，和 mineflayer 的 entity.yaw 同向）。
function yawTo(me, target) {
  try {
    var dx = toNum(target.x, 0) - toNum(me.x, 0);
    var dz = toNum(target.z, 0) - toNum(me.z, 0);
    return Math.atan2(-dx, -dz);
  } catch (e) { return 0; }
}

// 内部：两个 yaw 之间的夹角（度），读不到返回 180（=不算对着）。
function yawGapDeg(yawA, yawB) {
  try {
    var gap = (toNum(yawA, 0) - toNum(yawB, 0)) * 180 / Math.PI;
    return Math.abs(normalizeDeg(gap));
  } catch (e) { return 180; }
}

// 内部：读一个实体的血量；读不到返回 NaN（不同版本字段不一样）。
function healthOf(entity) {
  try {
    if (entity && typeof entity.health === "number") return entity.health;
  } catch (e) { /* 换下一种读法 */ }
  try {
    var md = entity ? entity.metadata : null;
    if (Array.isArray(md)) {
      for (var i = 0; i < md.length; i++) {
        var slot = md[i];
        if (slot && typeof slot === "object" && typeof slot.health === "number") return slot.health;
      }
    }
  } catch (e2) { /* 返回 NaN */ }
  return NaN;
}

// 内部：判断一个实体是不是「会打我的」——玩家或者敌对生物。
function isThreat(bot, entity) {
  try {
    if (!entity || entity === bot.entity) return false;
    if (entity.username) return true;
    var kind = toText(entity.type);
    if (kind === "player" || kind === "mob" || kind === "hostile") return true;
    return false;
  } catch (e) { return false; }
}

// 触发器 1：下坠超过 N 格（默认 3 格，摔伤阈值）——空中就提前报警，好让状态机去倒水 / 吃苹果。
async function triggerFall(ctx, args) {
  var name = "trigger_fall";
  var bot = ctx ? ctx.bot : null;
  var guard = requireBot(bot); if (guard) return guard;
  try {
    var min = Math.max(1, toNum(args ? args.min : NaN, FALL_MIN));
    var pos = posOf(bot);
    var y = yOf(pos);
    if (isNaN(y)) return result(name, false, "position unknown");
    var onGround = !!bot.entity.onGround;
    if (onGround) { bot._mbFallPeak = y; return result(name, false, "on ground"); }
    var peak = toNum(bot._mbFallPeak, NaN);
    if (isNaN(peak) || y > peak) { peak = y; bot._mbFallPeak = y; }
    var drop = Math.round((peak - y) * 10) / 10;
    return result(name, drop >= min, "drop=" + drop + ", min=" + min);
  } catch (err) {
    logInfo(name + " 异常 / error: " + getErrText(err));
    return { ok: false, message: "触发器异常 / trigger failed: " + getErrText(err) };
  }
}

// 触发器 2：附近有威胁正对着我（默认 10 格内、夹角 30 度内；已贴脸则放宽）。
async function triggerAimed(ctx, args) {
  var name = "trigger_aimed";
  var bot = ctx ? ctx.bot : null;
  var guard = requireBot(bot); if (guard) return guard;
  try {
    var radius = Math.max(2, toNum(args ? args.radius : NaN, AIM_RADIUS));
    var angle = Math.max(5, toNum(args ? args.angle : NaN, AIM_ANGLE));
    var me = posOf(bot);
    if (!me) return result(name, false, "position unknown");
    var keys = Object.keys(bot.entities || {});
    var best = null;
    for (var i = 0; i < keys.length; i++) {
      var ent = bot.entities[keys[i]];
      if (!isThreat(bot, ent)) continue;
      var spot = ent ? ent.position : null;
      if (!spot) continue;
      var dist = horizontalDist(me, spot);
      if (dist > radius) continue;
      var gap = 180;
      if (typeof ent.yaw === "number") gap = yawGapDeg(ent.yaw, yawTo(spot, me));
      if (gap > angle && dist > radius * 0.6) continue;
      if (!best || dist < best.dist) {
        best = { who: toText(ent.username || ent.name || ent.type), dist: Math.round(dist * 10) / 10, gap: Math.round(gap) };
      }
    }
    if (!best) return result(name, false, "no threat aiming");
    return result(name, true, "who=" + best.who + ", dist=" + best.dist + ", gap=" + best.gap);
  } catch (err) {
    logInfo(name + " 异常 / error: " + getErrText(err));
    return { ok: false, message: "触发器异常 / trigger failed: " + getErrText(err) };
  }
}

// 触发器 3：背包快满了（空槽位少于 N 个，默认 2）——该去存箱子了。
async function triggerInventoryFull(ctx, args) {
  var name = "trigger_inventory_full";
  var bot = ctx ? ctx.bot : null;
  var guard = requireBot(bot); if (guard) return guard;
  try {
    var need = Math.max(1, toNum(args ? args.free : NaN, FREE_SLOTS));
    var free = -1;
    try {
      if (bot.inventory && typeof bot.inventory.emptySlotCount === "function") free = bot.inventory.emptySlotCount();
    } catch (e1) { free = -1; }
    if (free < 0) {
      var used = 0;
      try {
        used = (bot.inventory && typeof bot.inventory.items === "function") ? (bot.inventory.items() || []).length : 0;
      } catch (e2) { used = 0; }
      free = Math.max(0, 36 - used);
    }
    return result(name, free < need, "free=" + free + ", need=" + need);
  } catch (err) {
    logInfo(name + " 异常 / error: " + getErrText(err));
    return { ok: false, message: "触发器异常 / trigger failed: " + getErrText(err) };
  }
}

// 触发器 4：饿了（food 低于阈值，默认 6）——附带背包里还有没有吃的。
async function triggerFoodOut(ctx, args) {
  var name = "trigger_food_out";
  var bot = ctx ? ctx.bot : null;
  var guard = requireBot(bot); if (guard) return guard;
  try {
    var min = Math.max(1, toNum(args ? args.min : NaN, FOOD_MIN));
    var food = toNum(bot.food, NaN);
    if (isNaN(food)) return result(name, false, "food unknown");
    var hasFood = false;
    try {
      var items = (bot.inventory && typeof bot.inventory.items === "function") ? (bot.inventory.items() || []) : [];
      for (var i = 0; i < items.length; i++) {
        var itemName = toText(items[i] ? items[i].name : "");
        if (itemName.indexOf("apple") >= 0 || itemName.indexOf("bread") >= 0 || itemName.indexOf("cooked") >= 0 ||
            itemName.indexOf("carrot") >= 0 || itemName.indexOf("potato") >= 0 || itemName.indexOf("beef") >= 0 ||
            itemName.indexOf("porkchop") >= 0 || itemName.indexOf("chicken") >= 0 || itemName.indexOf("stew") >= 0 ||
            itemName.indexOf("berry") >= 0 || itemName.indexOf("cod") >= 0 || itemName.indexOf("salmon") >= 0) { hasFood = true; break; }
      }
    } catch (e1) { hasFood = false; }
    return result(name, food < min, "food=" + food + ", min=" + min + ", hasFood=" + hasFood);
  } catch (err) {
    logInfo(name + " 异常 / error: " + getErrText(err));
    return { ok: false, message: "触发器异常 / trigger failed: " + getErrText(err) };
  }
}

// 触发器 5：有队友血量低于 N%（默认 30%）——读不到血量的队友直接跳过。
async function triggerAllyLow(ctx, args) {
  var name = "trigger_ally_low";
  var bot = ctx ? ctx.bot : null;
  var guard = requireBot(bot); if (guard) return guard;
  try {
    var percent = Math.max(5, toNum(args ? args.percent : NaN, ALLY_PERCENT));
    var limit = 20 * percent / 100;
    var me = posOf(bot);
    var keys = Object.keys(bot.entities || {});
    var worst = null;
    for (var i = 0; i < keys.length; i++) {
      var ent = bot.entities[keys[i]];
      if (!ent || ent === bot.entity || !ent.username) continue;
      var spot = ent.position;
      if (me && spot && horizontalDist(me, spot) > 32) continue;
      var hp = healthOf(ent);
      if (isNaN(hp)) continue;
      if (hp >= limit) continue;
      if (!worst || hp < worst.hp) worst = { who: toText(ent.username), hp: Math.round(hp * 10) / 10 };
    }
    if (!worst) return result(name, false, "no ally below " + percent + "%");
    return result(name, true, "who=" + worst.who + ", hp=" + worst.hp + ", limit=" + Math.round(limit * 10) / 10);
  } catch (err) {
    logInfo(name + " 异常 / error: " + getErrText(err));
    return { ok: false, message: "触发器异常 / trigger failed: " + getErrText(err) };
  }
}

// 触发器 6：最近 N 毫秒内挨过打（默认 5 秒）——直接读遥测的事件环形缓存。
async function triggerUnderAttack(ctx, args) {
  var name = "trigger_under_attack";
  var bot = ctx ? ctx.bot : null;
  var guard = requireBot(bot); if (guard) return guard;
  try {
    var windowMs = Math.max(500, toNum(args ? args.windowMs : NaN, HURT_WINDOW_MS));
    if (!telemetry || typeof telemetry.recentEvents !== "function") {
      return result(name, false, "telemetry unavailable");
    }
    var events = telemetry.recentEvents(bot, 20);
    var now = Date.now();
    var hit = null;
    for (var i = events.length - 1; i >= 0; i--) {
      var ev = events[i] || {};
      if (toText(ev.type) !== "bot_under_attack") continue;
      var at = toNum(ev.at, 0);
      if (at <= 0 || now - at > windowMs) continue;
      hit = ev;
      break;
    }
    if (!hit) return result(name, false, "no hurt in " + windowMs + "ms");
    return result(name, true, "attacker=" + toText(hit.attackerName || "unknown") + ", ago=" + (now - toNum(hit.at, now)) + "ms");
  } catch (err) {
    logInfo(name + " 异常 / error: " + getErrText(err));
    return { ok: false, message: "触发器异常 / trigger failed: " + getErrText(err) };
  }
}

// 常量：本文件动作名 → 实现（供状态机总表统一派发）。
var HANDLERS = {
  trigger_fall: triggerFall,
  trigger_aimed: triggerAimed,
  trigger_inventory_full: triggerInventoryFull,
  trigger_food_out: triggerFoodOut,
  trigger_ally_low: triggerAllyLow,
  trigger_under_attack: triggerUnderAttack
};

// 常量：本文件支持的动作名列表。
var NAMES = [];
try { NAMES = Object.keys(HANDLERS); } catch (e) { NAMES = []; }

// 判断本文件是否支持某个动作名。
function has(name) {
  try { return Object.prototype.hasOwnProperty.call(HANDLERS, toText(name)); } catch (e) { return false; }
}

// 取某个动作的实现，没有返回 null（调用方必须判空）。
function pick(name) {
  try {
    var key = toText(name);
    return Object.prototype.hasOwnProperty.call(HANDLERS, key) ? HANDLERS[key] : null;
  } catch (e) { return null; }
}

// 对外导出：动作表 + 名单 + 查询函数 + 阈值常量（GUI 提示用）。
module.exports = {
  HANDLERS: HANDLERS,
  NAMES: NAMES,
  ACTIONS: NAMES,
  has: has,
  pick: pick,
  FALL_MIN: FALL_MIN,
  AIM_RADIUS: AIM_RADIUS,
  FREE_SLOTS: FREE_SLOTS,
  FOOD_MIN: FOOD_MIN,
  ALLY_PERCENT: ALLY_PERCENT,
  HURT_WINDOW_MS: HURT_WINDOW_MS
};
