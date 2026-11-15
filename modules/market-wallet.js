// ========================================
// 文件：modules/market-wallet.js
// 功能：服务器雇佣与交易系统——监听公屏招工（「谁能帮我建房子我给 10 钻石」），
//       自动识别任务与报酬、接单、收定金、完工结算，Bot 拥有自己的钱包。
// 依赖：fs / path（原子写入）；./logger、./event-bus（均可选）
// 导出：parseOffer / onChat / createOrder / collectDeposit / completeOrder /
//       walletOf / ordersOf / stats / reset / pathOf
// 作者：MineBots
// ========================================
// 数据文件：state/market.json → { wallet: { "bot-1": 0 }, orders: [], updatedAt: 0 }
// 说明：只解析文本 + 产出双语公屏回复 / 任务单，不真的交易物品；外部 bot 通过 options 注入。
// 测试隔离：环境变量 MINEBOTS_STATE_DIR 可替换 state 目录，自测不碰真实存档。
// ES5 风格，CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

var fs = require("fs");
var path = require("path");
// 可选依赖：日志与事件总线。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
var bus = null;
try { bus = require("./event-bus"); } catch (e) { bus = null; }
// 常量：任务关键词 / 货币别名 / 定金比例 / 单 Bot 最多并行订单 / 报价有效期。
var TASK_WORDS = ["建房子", "盖房子", "造房子", "建", "盖", "造", "挖矿", "挖", "修", "建桥", "刷怪塔", "build", "mine", "dig", "repair"];
var CURRENCY = [
  { key: "diamond", words: ["钻石", "diamond", "diamonds"] },
  { key: "emerald", words: ["绿宝石", "emerald", "emeralds"] },
  { key: "iron", words: ["铁锭", "iron", "iron_ingot"] }
];
var DEPOSIT_RATIO = 0.5;
var MAX_ORDERS = 32;
var REPLY_ACCEPT = "接单啦！我先收定金，马上开工 / Order accepted! Deposit first, starting now";
var REPLY_DONE = "活干完了，尾款已入账 / Job done, final payment received";
var FILE_NAME = "market.json";

// 写普通日志：只落文件，不推 GUI。
function logInfo(text) {
  try { if (logger && typeof logger.info === "function") logger.info(text); } catch (e) { /* ignore */ }
}
// 安全取错误文本。
function errText(err) {
  try { if (!err) return "unknown error"; if (err.message) return String(err.message); return String(err); } catch (e) { return "unknown error"; }
}
// 安全转字符串。
function toText(v) {
  if (v === null || v === undefined) return "";
  try { return String(v).trim(); } catch (e) { return ""; }
}
// 取 state 目录（自测隔离用）。
function stateDir() {
  try {
    var custom = process.env.MINEBOTS_STATE_DIR;
    if (custom && String(custom).length > 0) return String(custom);
  } catch (e) { /* ignore */ }
  return path.join(process.cwd(), "state");
}
// 功能：数据文件绝对路径。
function pathOf() {
  return path.join(stateDir(), FILE_NAME);
}
// 空数据结构。
function emptyData() {
  return { wallet: {}, orders: [], updatedAt: 0 };
}
// 把任意来源洗成标准结构。
function normalize(raw) {
  var out = emptyData();
  try {
    var src = raw && typeof raw === "object" ? raw : {};
    var w = src.wallet && typeof src.wallet === "object" ? src.wallet : {};
    for (var k in w) {
      if (!Object.prototype.hasOwnProperty.call(w, k)) continue;
      var n = Number(w[k]);
      out.wallet[toText(k)] = isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
    }
    var list = Array.isArray(src.orders) ? src.orders : [];
    for (var i = 0; i < list.length && out.orders.length < MAX_ORDERS; i++) {
      var o = list[i] && typeof list[i] === "object" ? list[i] : null;
      if (!o || !toText(o.id)) continue;
      out.orders.push({ id: toText(o.id), botId: toText(o.botId) || "default",
        customer: toText(o.customer), task: toText(o.task), reward: Number(o.reward) || 0,
        currency: toText(o.currency) || "diamond", deposit: Number(o.deposit) || 0,
        paid: Number(o.paid) || 0, status: toText(o.status) || "accepted", at: Number(o.at) || 0 });
    }
    out.updatedAt = Number(src.updatedAt) || 0;
  } catch (e) { return emptyData(); }
  return out;
}
// 读数据：缺文件 / 坏 JSON 都返回空结构，绝不改写文件。
function read() {
  try {
    var file = pathOf();
    if (!fs.existsSync(file)) return emptyData();
    var text = fs.readFileSync(file, "utf8");
    if (!text || text.trim().length === 0) return emptyData();
    return normalize(JSON.parse(text));
  } catch (e) { return emptyData(); }
}
// 原子写 JSON：先写 .tmp 再 rename。
function write(data) {
  try {
    var file = pathOf();
    var dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    var tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    try { if (fs.existsSync(pathOf() + ".tmp")) fs.unlinkSync(pathOf() + ".tmp"); } catch (e2) { /* ignore */ }
    logInfo("[market-wallet] write failed / 写入失败: " + errText(e));
    return false;
  }
}
// 广播订单事件：总线缺失时静默跳过。
function emit(name, payload) {
  try { if (bus && typeof bus.emit === "function") bus.emit(name, payload); } catch (e) { /* ignore */ }
}
// 功能 1：解析公屏招工——抓任务关键词、数量、货币，返回 { ok, task, reward, currency }。
function parseOffer(text, sender, options) {
  var out = { ok: false, task: "", reward: 0, currency: "diamond", customer: toText(sender),
    raw: toText(text), message: "" };
  try {
    var raw = out.raw;
    if (raw.length === 0) { out.message = "empty chat / 空消息"; return out; }
    var hire = /谁(能|可以|愿意)|有没有人|求帮|帮我|谁帮|需要人|who can|anyone|need someone|build me|hire/i.test(raw);
    var task = "";
    for (var i = 0; i < TASK_WORDS.length; i++) {
      if (raw.toLowerCase().indexOf(TASK_WORDS[i].toLowerCase()) >= 0) { task = TASK_WORDS[i]; break; }
    }
    if (!hire || task.length === 0) { out.message = "not a hire offer / 不是招工信息"; return out; }
    var m = /(\d+)\s*(钻石|绿宝石|铁锭|diamonds?|emeralds?|iron(?:_ingot)?s?)/i.exec(raw);
    if (!m) { out.message = "no reward / 没有报价"; return out; }
    var reward = parseInt(m[1], 10);
    if (!isFinite(reward) || reward <= 0) { out.message = "bad reward / 报价非法"; return out; }
    var unit = m[2].toLowerCase();
    for (var c = 0; c < CURRENCY.length; c++) {
      for (var w = 0; w < CURRENCY[c].words.length; w++) {
        if (unit.indexOf(CURRENCY[c].words[w].toLowerCase()) >= 0) { out.currency = CURRENCY[c].key; break; }
      }
      if (out.currency !== "diamond" && unit.indexOf(CURRENCY[c].words[0].toLowerCase()) >= 0) break;
    }
    out.ok = true;
    out.task = task;
    out.reward = reward;
    out.message = "offer parsed / 招工信息已解析";
    return out;
  } catch (e) { out.message = errText(e); return out; }
}
// 找订单（按 id）。
function findOrder(data, id) {
  for (var i = 0; i < data.orders.length; i++) if (data.orders[i].id === toText(id)) return data.orders[i];
  return null;
}
// 功能 2：创建订单（去重：同一客户 + 同一任务 + 未完成不重复接单）。
function createOrder(offer, options) {
  var out = { ok: false, order: null, duplicated: false, message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var o = offer && offer.ok === true ? offer : parseOffer(toText(offer), opts.customer, {});
    if (!o.ok) { out.message = o.message; return out; }
    var data = read();
    for (var i = 0; i < data.orders.length; i++) {
      var one = data.orders[i];
      if (one.customer === o.customer && one.task === o.task && one.status !== "done") {
        out.duplicated = true; out.ok = true; out.order = one;
        out.message = "order already accepted / 该订单已接过";
        return out;
      }
    }
    var botId = toText(opts.botId) || "default";
    var order = { id: "ord-" + Date.now().toString(36) + "-" + (data.orders.length + 1),
      botId: botId, customer: o.customer, task: o.task, reward: o.reward,
      currency: o.currency, deposit: Math.ceil(o.reward * DEPOSIT_RATIO), paid: 0,
      status: "accepted", at: Date.now() };
    data.orders.push(order);
    data.updatedAt = Date.now();
    if (!write(data)) { out.message = "write failed / 写入失败"; return out; }
    out.ok = true; out.order = order;
    out.message = "order created / 订单已创建";
    logInfo("[market-wallet] " + order.id + " / " + o.task + " " + o.reward + " " + o.currency);
    emit("market.order", { order: order, at: Date.now() });
    return out;
  } catch (e) { out.message = errText(e); return out; }
}
// 功能 3：公屏入口——识别招工后自动接单 + 双语回话 + 收定金。
function onChat(text, sender, options) {
  var out = { ok: true, matched: false, duplicated: false, offer: null, order: null, reply: "", message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var offer = parseOffer(text, sender, {});
    out.offer = offer;
    if (!offer.ok) { out.message = offer.message; return out; }
    var created = createOrder(offer, opts);
    out.matched = true;
    out.order = created.order;
    out.duplicated = created.duplicated === true;
    if (out.duplicated) { out.message = "order already accepted / 该订单已接过，不再刷屏"; return out; }
    out.reply = REPLY_ACCEPT + "（" + offer.task + " / " + offer.reward + " " + offer.currency + "）";
    try { if (opts.bot && typeof opts.bot.chat === "function") opts.bot.chat(out.reply); } catch (eChat) { /* 公屏失败继续 */ }
    if (created.ok && created.order) collectDeposit(created.order.id, opts);
    out.message = "hire handled / 招工已处理";
    return out;
  } catch (e) { out.message = errText(e); return out; }
}
// 功能 4：收定金——按报价一半入钱包。
function collectDeposit(orderId, options) {
  var out = { ok: false, amount: 0, balance: 0, message: "" };
  try {
    var data = read();
    var order = findOrder(data, orderId);
    if (!order) { out.message = "order not found / 订单不存在"; return out; }
    if (order.deposit > order.paid) {
      var amount = order.deposit - order.paid;
      order.paid = order.deposit;
      order.status = "working";
      var key = order.botId || "default";
      data.wallet[key] = (Number(data.wallet[key]) || 0) + amount;
      data.updatedAt = Date.now();
      if (!write(data)) { out.message = "write failed / 写入失败"; return out; }
      out.amount = amount;
      out.balance = data.wallet[key];
      emit("market.deposit", { orderId: order.id, amount: amount, balance: out.balance });
    }
    out.ok = true;
    out.balance = Number(data.wallet[order.botId || "default"]) || 0;
    out.message = "deposit collected / 定金已入账";
    return out;
  } catch (e) { out.message = errText(e); return out; }
}
// 功能 5：完工结算——尾款入钱包，订单置 done，公屏双语通知。
function completeOrder(orderId, options) {
  var out = { ok: false, amount: 0, balance: 0, reply: "", message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var data = read();
    var order = findOrder(data, orderId);
    if (!order) { out.message = "order not found / 订单不存在"; return out; }
    var rest = Math.max(0, order.reward - order.paid);
    if (order.status !== "done" && rest > 0) {
      data.wallet[order.botId] = (Number(data.wallet[order.botId]) || 0) + rest;
      order.paid = order.reward;
    }
    order.status = "done";
    data.updatedAt = Date.now();
    if (!write(data)) { out.message = "write failed / 写入失败"; return out; }
    out.ok = true; out.amount = rest;
    out.balance = Number(data.wallet[order.botId]) || 0;
    out.reply = REPLY_DONE + "（" + order.reward + " " + order.currency + "）";
    try { if (opts.bot && typeof opts.bot.chat === "function") opts.bot.chat(out.reply); } catch (eChat) { /* ignore */ }
    emit("market.completed", { orderId: order.id, paid: order.paid, balance: out.balance });
    out.message = "order completed / 订单已结算";
    return out;
  } catch (e) { out.message = errText(e); return out; }
}
// 功能 6：查某个 Bot 的钱包。
function walletOf(botId) {
  var data = read();
  var key = toText(botId) || "default";
  return { ok: true, botId: key, balance: Number(data.wallet[key]) || 0,
    currency: "mixed", message: "wallet read / 钱包已读取" };
}
// 功能 7：列订单（可按 botId 过滤）。
function ordersOf(botId, options) {
  var data = read();
  var key = toText(botId);
  var out = [];
  for (var i = 0; i < data.orders.length; i++) if (key.length === 0 || data.orders[i].botId === key) out.push(data.orders[i]);
  return out;
}
// 功能 8：统计快照。
function stats() {
  var data = read();
  var sum = 0;
  for (var k in data.wallet) if (Object.prototype.hasOwnProperty.call(data.wallet, k)) sum = sum + Number(data.wallet[k]);
  var done = 0;
  for (var i = 0; i < data.orders.length; i++) if (data.orders[i].status === "done") done = done + 1;
  return { ok: true, orders: data.orders.length, done: done, bots: Object.keys(data.wallet).length,
    totalBalance: sum, depositRatio: DEPOSIT_RATIO, path: pathOf() };
}
// 功能 9：复位（删除数据文件），自测隔离用。
function reset() {
  try {
    var file = pathOf();
    if (fs.existsSync(file)) fs.unlinkSync(file);
    if (fs.existsSync(file + ".tmp")) fs.unlinkSync(file + ".tmp");
    return { ok: true, message: "market reset / 雇佣钱包已复位" };
  } catch (e) { return { ok: false, message: errText(e) }; }
}
// 对外导出。
module.exports = {
  parseOffer: parseOffer, onChat: onChat, createOrder: createOrder,
  collectDeposit: collectDeposit, completeOrder: completeOrder,
  walletOf: walletOf, ordersOf: ordersOf, stats: stats, reset: reset, pathOf: pathOf,
  REPLY_ACCEPT: REPLY_ACCEPT, REPLY_DONE: REPLY_DONE
};
