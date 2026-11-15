// ========================================
// 文件：modules/minecart-logistics.js
// 功能：矿车与物流分拣——从矿车（箱子矿车 / 漏斗矿车）取货、接收漏斗输出，
//       按规则把物品精准分类到对应箱子，并生成可执行的入库任务。
// 依赖：./logger（可选）、./bot-logistics（可选，复用其规则别名）、./shared-board（可选）
// 导出：registerBot / takeFromMinecart / acceptHopper / classify / store / run / stats / reset
// 作者：MineBots
// ========================================
// 说明：不直接操作真实容器，产出「取货 / 分类 / 入箱」任务清单；bot 通过 options 注入，
//   自测完全离线。规则按物品名子串匹配，未命中走默认箱或丢弃箱。
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

// 可选依赖：日志（只写文件）。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
// 可选依赖：既有物流模块（只借用别名表，不覆盖其自动分拣）。
var logistics = null;
try { logistics = require("./bot-logistics"); } catch (e) { logistics = null; }
// 可选依赖：黑板（记录本轮物流账）。
var board = null;
try { board = require("./shared-board"); } catch (e) { board = null; }
// 常量：矿车实体名字特征 / 掉落物名字特征 / 单轮最多处理物品数。
var CART_HINTS = ["minecart", "chest_minecart", "hopper_minecart", "minecart_chest"];
var MAX_ITEMS = 256;
// 运行时：每个 bot 的待处理货物与统计。
var sessions = {};
var totals = { carts: 0, hoppers: 0, items: 0, stored: 0, unmatched: 0 };

// 写普通日志：只落文件，不推 GUI。
function logInfo(text) {
  try { if (logger && typeof logger.info === "function") logger.info(text); } catch (e) { /* ignore */ }
}
// 取错误文本，catch 里绝不再次抛错。
function errText(err) {
  try { if (!err) return "unknown error"; if (err.message) return String(err.message); return String(err); } catch (e) { return "unknown error"; }
}
// 安全转字符串：null / undefined 归一成空串。
function toText(value) {
  try { if (value === null || value === undefined) return ""; return String(value); } catch (e) { return ""; }
}
// 取（或新建）会话。
function sessionOf(id) {
  var key = toText(id) || "default";
  if (!sessions[key]) sessions[key] = { id: key, bot: null, buffer: [], rules: [], carts: 0, hoppers: 0, stored: 0 };
  return sessions[key];
}
// 判断实体名字是不是矿车。
function isCart(name) {
  try {
    var low = toText(name).toLowerCase();
    for (var i = 0; i < CART_HINTS.length; i++) if (low.indexOf(CART_HINTS[i]) >= 0) return true;
  } catch (e) { return false; }
  return false;
}
// 把物品归一化成 { name, count }。
function normalize(item) {
  var one = item && typeof item === "object" ? item : { name: item };
  var name = toText(one.name || one.block || one.item).replace(/^minecraft:/, "");
  var count = Number(one.count === undefined ? 1 : one.count);
  if (isNaN(count) || count < 0) count = 0;
  return { name: name, count: Math.floor(count) };
}
// 功能：登记一个 bot 与它的分类规则；重复登记只更新，不丢缓存货物。
function registerBot(bot, botId, options) {
  try {
    var opts = options && typeof options === "object" ? options : {};
    var st = sessionOf(botId);
    st.bot = bot || st.bot;
    if (Array.isArray(opts.rules)) st.rules = opts.rules.slice(0);
    return { ok: true, botId: st.id, rules: st.rules.length, message: "cart bot registered / 矿车物流已登记" };
  } catch (e) { return { ok: false, message: errText(e) }; }
}
// 功能：从矿车取货——扫描 bot.entities 找矿车实体，读它的物品栏并入队。
function takeFromMinecart(botId, options) {
  var out = { ok: true, items: [], carts: 0, message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var st = sessionOf(botId);
    var bot = opts.bot || st.bot || null;
    var source = opts.entity || (bot && bot.entities) || {};
    var list = [];
    if (Array.isArray(source)) list = source;
    else for (var k in source) { if (Object.prototype.hasOwnProperty.call(source, k)) list.push(source[k]); }
    for (var i = 0; i < list.length && out.items.length < MAX_ITEMS; i++) {
      var ent = list[i] || {};
      var label = toText(ent.name || ent.type || ent.kind);
      if (!isCart(label)) continue;
      out.carts = out.carts + 1;
      var cargo = ent.items || ent.inventory || ent.cargo || [];
      for (var j = 0; j < cargo.length; j++) {
        var it = normalize(cargo[j]);
        if (it.name.length > 0 && it.count > 0) out.items.push(it);
      }
    }
    for (var n = 0; n < out.items.length; n++) st.buffer.push(out.items[n]);
    st.carts = st.carts + out.carts;
    totals.carts = totals.carts + out.carts;
    totals.items = totals.items + out.items.length;
    out.ok = out.carts > 0;
    out.message = out.ok ? "minecart unloaded / 矿车取货完成" : "no minecart / 附近没有矿车";
    logInfo("[minecart-logistics] carts=" + out.carts + " items=" + out.items.length + " / 矿车取货");
    return out;
  } catch (e) { return { ok: false, items: [], carts: 0, message: errText(e) }; }
}
// 功能：接收漏斗输出——把漏斗吐出的物品并入待分类缓冲区。
function acceptHopper(botId, items, options) {
  var out = { ok: true, accepted: 0, message: "" };
  try {
    var st = sessionOf(botId);
    var list = Array.isArray(items) ? items : [items];
    for (var i = 0; i < list.length && st.buffer.length < MAX_ITEMS; i++) {
      var it = normalize(list[i]);
      if (it.name.length === 0 || it.count <= 0) continue;
      st.buffer.push(it);
      out.accepted = out.accepted + 1;
    }
    st.hoppers = st.hoppers + 1;
    totals.hoppers = totals.hoppers + 1;
    totals.items = totals.items + out.accepted;
    out.message = "hopper accepted / 漏斗物品已接收";
    return out;
  } catch (e) { return { ok: false, accepted: 0, message: errText(e) }; }
}
// 按一条规则匹配物品名；支持 match 字符串 / 数组 / 正则式别名。
function ruleMatches(rule, name) {
  try {
    var m = rule.match;
    if (Array.isArray(m)) {
      for (var i = 0; i < m.length; i++) if (name.indexOf(toText(m[i]).toLowerCase()) >= 0) return true;
      return false;
    }
    return name.indexOf(toText(m).toLowerCase()) >= 0;
  } catch (e) { return false; }
}
// 功能：按规则把物品分类到箱子，返回 { ok, groups, unmatched, tasks }。
function classify(items, rules, options) {
  var out = { ok: true, groups: {}, unmatched: [], tasks: [], message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var list = Array.isArray(items) ? items : [];
    var defs = Array.isArray(rules) ? rules : [];
    var fallback = opts.fallbackChest || "misc";
    for (var i = 0; i < list.length; i++) {
      var it = normalize(list[i]);
      if (it.name.length === 0) continue;
      var target = "";
      for (var r = 0; r < defs.length; r++) {
        if (ruleMatches(defs[r] || {}, it.name.toLowerCase())) { target = toText((defs[r] || {}).chest); break; }
      }
      if (target.length === 0) { target = fallback; out.unmatched.push(it); }
      if (!out.groups[target]) out.groups[target] = [];
      out.groups[target].push(it);
    }
    for (var key in out.groups) {
      if (!Object.prototype.hasOwnProperty.call(out.groups, key)) continue;
      var chest = (opts.chests && opts.chests[key]) || { x: 0, y: 64, z: 0 };
      var count = 0;
      for (var q = 0; q < out.groups[key].length; q++) count = count + out.groups[key][q].count;
      out.tasks.push({ action: "chestTransfer", chest: key, pos: chest, count: count,
        items: out.groups[key], role: "logistics", reason: "sorted by rule / 规则精准分类" });
    }
    totals.unmatched = totals.unmatched + out.unmatched.length;
    out.message = "items classified / 物品已分类";
    return out;
  } catch (e) { return { ok: false, groups: {}, unmatched: [], tasks: [], message: errText(e) }; }
}
// 功能：把缓冲区的货物分类并入箱，返回完整账目；board 可选记账。
function store(botId, options) {
  var out = { ok: false, tasks: [], groups: {}, unmatched: [], stored: 0, message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var st = sessionOf(botId);
    var rules = Array.isArray(opts.rules) ? opts.rules : st.rules;
    var result = classify(st.buffer, rules, opts);
    out.tasks = result.tasks;
    out.groups = result.groups;
    out.unmatched = result.unmatched;
    out.stored = st.buffer.length;
    st.stored = st.stored + out.stored;
    totals.stored = totals.stored + out.stored;
    st.buffer = [];
    try {
      if (board && typeof board.post === "function") board.post("logistics.cart:" + st.id, { at: Date.now(), stored: out.stored });
    } catch (eBoard) { /* 黑板失败不影响入箱 */ }
    out.ok = true;
    out.message = "cargo stored / 货物已分类入箱";
    return out;
  } catch (e) { out.message = errText(e); return out; }
}
// 功能：一站式链路——取货 → 接收漏斗 → 分类入箱。
function run(botId, options) {
  var out = { ok: true, cart: null, hopper: null, stored: null, message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    out.cart = takeFromMinecart(botId, opts);
    if (Array.isArray(opts.hopperItems)) out.hopper = acceptHopper(botId, opts.hopperItems, opts);
    out.stored = store(botId, opts);
    out.ok = out.stored.ok;
    out.message = "cart logistics done / 矿车物流闭环完成";
    return out;
  } catch (e) { out.ok = false; out.message = errText(e); return out; }
}
// 功能：读统计快照。
function stats(botId) {
  var st = botId ? sessionOf(botId) : null;
  return { ok: true, botId: st ? st.id : "all", carts: st ? st.carts : totals.carts,
    hoppers: st ? st.hoppers : totals.hoppers, stored: st ? st.stored : totals.stored,
    buffered: st ? st.buffer.length : 0, unmatched: totals.unmatched,
    rules: st ? st.rules.length : 0, logisticsModule: !!logistics };
}
// 功能：复位全部会话与统计。
function reset() {
  sessions = {};
  totals = { carts: 0, hoppers: 0, items: 0, stored: 0, unmatched: 0 };
  return { ok: true, message: "minecart logistics reset / 矿车物流已复位" };
}
// 对外导出。
module.exports = {
  registerBot: registerBot, takeFromMinecart: takeFromMinecart, acceptHopper: acceptHopper,
  classify: classify, store: store, run: run, stats: stats, reset: reset
};
