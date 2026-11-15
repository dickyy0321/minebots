// ========================================
// 文件：modules/bot-logistics.js
// 功能：海量物流分拣与自动化基建——读箱子告示牌 signText / JSON 规则，把背包物品经
//       bot.clickWindow 存入对应箱子，箱子间 chestTransfer 搬运，黑板联动农场满仓自动调度
// 依赖：vec3（可选）、./shared-board（可选）、./event-bus（可选）、./logger（可选）、./json-repair（可选）
// 导出：attach / registerBot / readSignText / parseRules / autoSort / chestTransfer /
//       onFarmFull / logisticsTick / SORT_TASK / stats / reset
// 作者：MineBots
// ========================================
//
// 设计 / design
//   1. 真 mineflayer API：bot.blockAt(pos) 取箱子方块与 signText；bot.openChest / bot.openContainer
//      打开窗口；bot.clickWindow(slot, 0, 1) 左键 + 快速移动把背包物品推入箱子；window.close() 收尾。
//   2. 规则来源两路：箱子告示牌（[分类] 石头 / [废弃] / [sort] stone）与传入的 JSON 规则；
//      内置中英关键词映射，坏规则一律跳过，不误塞任何物品。
//   3. 农场满仓 → 黑板 logistics_sort 任务 → 物流机器人 claimTask 抢单 → autoSort → completeTask。
// CommonJS，ES5 风格，无中文变量名；所有外部调用包 try/catch，日志与报错双语。
var sharedBoard = null;
try { sharedBoard = require("./shared-board"); } catch (e) { sharedBoard = null; }
var bus = null;
try { bus = require("./event-bus"); } catch (e) { bus = null; }
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
var repair = null;
try { repair = require("./json-repair"); } catch (e) { repair = null; }

// 常量：黑板任务标题 / 快速移动点击参数 / 内置分类关键词（中英双语）/ 内存状态。
var SORT_TASK = "logistics_sort";
var CLICK_BUTTON = 0;
var CLICK_MODE_QUICK = 1;
var ALIASES = {
  "stone": ["stone", "cobblestone", "石头", "圆石", "stone_bricks", "石砖"],
  "oak_log": ["oak_log", "log", "木头", "原木", "oak_planks", "木板"],
  "dirt": ["dirt", "grass_block", "泥土", "草方块"],
  "redstone": ["redstone", "redstone_wire", "redstone_torch", "红石", "红石粉", "repeater", "中继器", "comparator", "比较器"],
  "piston": ["piston", "sticky_piston", "活塞", "粘性活塞", "observer", "观察者"],
  "iron_ingot": ["iron_ingot", "raw_iron", "铁锭", "铁", "gold_ingot", "金锭", "diamond", "钻石"],
  "wheat": ["wheat", "小麦", "seeds", "种子", "carrot", "胡萝卜", "potato", "土豆"],
  "discard": ["cobblestone", "dirt", "gravel", "沙子", "碎石", "圆石"]
};
var attached = { bot: null, botId: "default" };
var registry = {};
var counters = { sorts: 0, moved: 0, transfers: 0, tasks: 0, failed: 0 };

// 写文件日志：分拣属高频动作，只落文件不刷 GUI。
function logInfo(msg) {
  try { if (logger && typeof logger.info === "function") logger.info("[logistics] " + msg); } catch (e) { /* ignore */ }
}
// 写系统日志：满仓调度属低频事件，推 GUI。
function logSystem(msg) {
  try { if (logger && typeof logger.system === "function") { logger.system("[logistics] " + msg); return; } }
  catch (e) { /* 退回 console */ }
  try { console.log("[logistics] " + msg); } catch (e2) { /* ignore */ }
}
// 广播物流事件：总线缺失时静默跳过。
function emit(name, payload) {
  try { if (bus && typeof bus.emit === "function") bus.emit(name, payload); } catch (e) { /* ignore */ }
}
// 安全取错误文本：catch 里绝不会二次抛错。
function errText(err) {
  try { if (err && err.message) return String(err.message); return String(err); }
  catch (e) { return "unknown error / 未知错误"; }
}
// 安全转字符串：null / undefined 统一成空串。
function toText(value) {
  try { return value === null || value === undefined ? "" : String(value); } catch (e) { return ""; }
}
// 安全转整数：坏值回 fallback。
function toInt(value, fallback) {
  try { var n = Number(value); if (isNaN(n) || !isFinite(n)) return fallback; return Math.floor(n); }
  catch (e) { return fallback; }
}
// 归一化坐标：支持 {x,y,z} / [x,y,z] / "x,y,z"，坏值返回 null。
function pointOf(value) {
  try {
    if (Array.isArray(value) && value.length >= 3) return { x: toInt(value[0], NaN), y: toInt(value[1], NaN), z: toInt(value[2], NaN) };
    if (typeof value === "string") {
      var parts = value.replace(/[\[\]（）()]/g, "").split(/[,，\s]+/);
      if (parts.length >= 3) return { x: toInt(parts[0], NaN), y: toInt(parts[1], NaN), z: toInt(parts[2], NaN) };
    }
    if (value && typeof value === "object") return { x: toInt(value.x, NaN), y: toInt(value.y, NaN), z: toInt(value.z, NaN) };
  } catch (e) { return null; }
  return null;
}
// 构造 bot.blockAt 需要的向量；缺 vec3 时用普通对象（假 bot 兼容）。
function vecOf(bot, point) {
  try {
    var vecLib = require("vec3");
    if (vecLib && typeof vecLib.Vec3 === "function") return new vecLib.Vec3(point.x, point.y, point.z);
  } catch (e) { /* 退回普通对象 */ }
  return { x: point.x, y: point.y, z: point.z };
}
// 绑定默认 bot（主进程或测试注入）；坏值清空，返回 { ok, botId, bound }。
function attach(bot, botId) {
  try {
    attached.bot = bot || null;
    attached.botId = toText(botId) || "default";
    if (bot && attached.botId) registry[attached.botId] = bot;
    return { ok: true, botId: attached.botId, bound: !!bot };
  } catch (e) { return { ok: false, bound: false, message: errText(e) }; }
}
// 注册多 bot：供多机器人协同分拣；返回注册数量。
function registerBot(botId, bot) {
  var id = toText(botId);
  if (!id || !bot) return { ok: false, count: Object.keys(registry).length, message: "botId and bot required / 缺少机器人" };
  try { registry[id] = bot; } catch (e) { return { ok: false, count: 0, message: errText(e) }; }
  return { ok: true, count: Object.keys(registry).length, botId: id };
}
// 解析本次使用的 bot：options.bot > options.botId 注册表 > attach 的默认 bot。
function botOf(options) {
  var opts = options && typeof options === "object" ? options : {};
  try {
    if (opts.bot) return opts.bot;
    var id = toText(opts.botId);
    if (id && registry[id]) return registry[id];
  } catch (e) { /* 退回默认 bot */ }
  return attached.bot;
}
// 解析本次使用的黑板：options.board > shared-board；都没有返回 null。
function boardOf(options) {
  var opts = options && typeof options === "object" ? options : {};
  return opts.board || sharedBoard || null;
}
// 读箱子告示牌：兼容 signText 字符串 / 数组 / getSignText() / entity.signText，返回拼接后的文本。
function readSignText(block) {
  try {
    if (!block) return "";
    var raw = null;
    if (typeof block.getSignText === "function") raw = block.getSignText();
    if (raw === null || raw === undefined || raw === "") raw = block.signText;
    if ((raw === null || raw === undefined || raw === "") && block.entity) raw = block.entity.signText;
    if (Array.isArray(raw)) {
      var lines = [];
      for (var i = 0; i < raw.length; i++) {
        var line = toText(raw[i]);
        if (line.length > 0) lines.push(line);
      }
      return lines.join(" ");
    }
    if (raw && typeof raw === "object") {
      var parts = [];
      for (var k in raw) {
        if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
        if (toText(raw[k]).length > 0) parts.push(toText(raw[k]));
      }
      return parts.join(" ");
    }
    return toText(raw);
  } catch (e) { return ""; }
}
// 归一化物品名：去命名空间、小写，坏值返回空串。
function cleanItem(value) {
  try {
    var name = toText(value).toLowerCase().trim();
    if (name.indexOf("minecraft:") === 0) name = name.slice(10);
    return name;
  } catch (e) { return ""; }
}
// 把一段标签（中文 / 英文 / 方块名）解析成候选物品名数组；未知标签返回空数组。
function aliasesOf(label) {
  var out = [];
  var text = toText(label).toLowerCase().trim();
  if (text.length === 0) return out;
  for (var key in ALIASES) {
    if (!Object.prototype.hasOwnProperty.call(ALIASES, key)) continue;
    var list = ALIASES[key];
    var hit = false;
    for (var i = 0; i < list.length; i++) if (text.indexOf(toText(list[i]).toLowerCase()) >= 0) hit = true;
    if (hit) {
      out.push(key);
      for (var j = 0; j < list.length; j++) {
        var one = cleanItem(list[j]);
        if (one && out.indexOf(one) < 0) out.push(one);
      }
    }
  }
  var direct = cleanItem(text);
  if (direct && out.indexOf(direct) < 0) out.push(direct);
  return out;
}
// 解析规则：支持 JSON 字符串 / 对象 / 数组 / 告示牌文本，统一成 { tags:[], items:[], discard:boolean, text }。
function parseRules(rules, signText) {
  var out = { tags: [], items: [], discard: false, text: "", parsed: false };
  try {
    var text = toText(signText);
    out.text = text;
    if (text.indexOf("[废弃]") >= 0 || text.indexOf("[discard]") >= 0 || text.toLowerCase().indexOf("trash") >= 0) out.discard = true;
    var tagRe = /\[(?:分类|sort|sorted|category)\]\s*([^\]\s]+)/gi;
    var hit = null;
    while ((hit = tagRe.exec(text)) !== null) out.tags.push(hit[1]);
    if (out.tags.length > 0) out.parsed = true;
    var raw = rules;
    if (typeof raw === "string") {
      if (raw.trim().indexOf("{") === 0 || raw.trim().indexOf("[") === 0) {
        if (repair && typeof repair.safeParse === "function") raw = repair.safeParse(raw, null);
        else { try { raw = JSON.parse(raw); } catch (eJson) { raw = null; } }
      }
    }
    if (Array.isArray(raw)) {
      for (var a = 0; a < raw.length; a++) {
        var one = raw[a];
        if (typeof one === "string") out.items.push(cleanItem(one));
        else if (one && typeof one === "object") out.items.push(cleanItem(one.item || one.name || one.block));
      }
      out.parsed = true;
    } else if (raw && typeof raw === "object") {
      var list = Array.isArray(raw.items) ? raw.items : (Array.isArray(raw.include) ? raw.include : []);
      for (var i = 0; i < list.length; i++) {
        var v = typeof list[i] === "string" ? list[i] : (list[i] && (list[i].item || list[i].name));
        var cv = cleanItem(v);
        if (cv && out.items.indexOf(cv) < 0) out.items.push(cv);
      }
      if (Array.isArray(raw.tags)) for (var t = 0; t < raw.tags.length; t++) out.tags.push(toText(raw.tags[t]));
      if (raw.discard === true) out.discard = true;
      out.parsed = true;
    }
    for (var tg = 0; tg < out.tags.length; tg++) {
      var aliases = aliasesOf(out.tags[tg]);
      for (var m = 0; m < aliases.length; m++) if (out.items.indexOf(aliases[m]) < 0) out.items.push(aliases[m]);
    }
    if (out.discard) {
      var waste = ALIASES.discard;
      for (var w = 0; w < waste.length; w++) {
        var cw = cleanItem(waste[w]);
        if (cw && out.items.indexOf(cw) < 0) out.items.push(cw);
      }
    }
    // 去重并丢掉空项。
    var clean = [];
    for (var c = 0; c < out.items.length; c++) if (out.items[c] && clean.indexOf(out.items[c]) < 0) clean.push(out.items[c]);
    out.items = clean;
  } catch (e) { /* 返回已解析部分 */ }
  return out;
}
// 打开一个容器窗口：优先 bot.openChest，其次 bot.openContainer；options.window 可直接注入（自测隔离）。
async function openWindow(bot, pos, options) {
  var opts = options && typeof options === "object" ? options : {};
  if (opts.window) return { ok: true, window: opts.window, source: "injected" };
  try {
    var block = null;
    if (bot && typeof bot.blockAt === "function") block = bot.blockAt(vecOf(bot, pos));
    if (!block) return { ok: false, window: null, message: "chest not found / 箱子不存在" };
    var fn = typeof bot.openChest === "function" ? bot.openChest : (typeof bot.openContainer === "function" ? bot.openContainer : null);
    if (!fn) return { ok: false, window: null, message: "openChest unavailable / 无法打开容器" };
    var win = await fn.call(bot, block);
    if (!win) return { ok: false, window: null, message: "window empty / 容器窗口为空" };
    return { ok: true, window: win, block: block, source: "bot" };
  } catch (e) { return { ok: false, window: null, message: errText(e) }; }
}
// 关掉容器窗口：真 window.close() / bot.closeWindow() 都兼容，失败静默。
function closeWindow(bot, win) {
  try {
    if (win && typeof win.close === "function") { win.close(); return true; }
    if (bot && typeof bot.closeWindow === "function") { bot.closeWindow(win); return true; }
  } catch (e) { /* 关闭失败不影响分拣结果 */ }
  return false;
}
// 列出背包物品：真 bot.inventory.items() / 数组 / options.items 注入，坏值返回空数组。
function inventoryOf(bot, options) {
  var opts = options && typeof options === "object" ? options : {};
  try {
    if (Array.isArray(opts.items)) return opts.items;
    if (bot && bot.inventory && typeof bot.inventory.items === "function") {
      var list = bot.inventory.items();
      return Array.isArray(list) ? list : [];
    }
    if (Array.isArray(bot && bot.inventory)) return bot.inventory;
  } catch (e) { return []; }
  return [];
}
// 判定物品是否命中规则：按精确名 / 前缀 / 中英别名包含匹配。
function matches(item, rule) {
  try {
    var name = cleanItem(item && (item.name || item.block || item.item));
    if (!name || rule.items.length === 0) return false;
    for (var i = 0; i < rule.items.length; i++) {
      var want = rule.items[i];
      if (name === want || name.indexOf(want) >= 0 || want.indexOf(name) >= 0) return true;
    }
  } catch (e) { return false; }
  return false;
}
// 快速移动一个物品槽：bot.clickWindow(slot, 0, 1)（左键 + Shift 快速移动），失败只降级不抛错。
async function quickMove(bot, slot) {
  try {
    if (!bot || typeof bot.clickWindow !== "function") return { ok: false, message: "clickWindow unavailable / 无法操作窗口" };
    var running = bot.clickWindow(toInt(slot, -1), CLICK_BUTTON, CLICK_MODE_QUICK);
    if (running && typeof running.then === "function") await running.then(function () { return null; }, function () { return null; });
    return { ok: true, slot: toInt(slot, -1) };
  } catch (e) { return { ok: false, message: errText(e) }; }
}
// 箱子间搬运：源箱取出 itemName×count 到背包，再放入目标箱；返回 { ok, transferred, item, message }。
async function chestTransfer(fromPos, toPos, itemName, count, options) {
  var opts = options && typeof options === "object" ? options : {};
  var out = { ok: false, transferred: 0, item: cleanItem(itemName), from: null, to: null,
    message: "bot not ready / 机器人未就绪" };
  try {
    var from = pointOf(fromPos), to = pointOf(toPos);
    if (!from || !to) { out.message = "bad chest position / 箱子坐标非法"; return out; }
    out.from = from; out.to = to;
    var want = Math.max(0, toInt(count, 0));
    if (!out.item || want === 0) { out.message = "item and count required / 缺少物品名或数量"; return out; }
    var bot = botOf(opts);
    if (!bot) return out;
    var src = await openWindow(bot, from, opts);
    if (!src.ok) { out.message = src.message; return out; }
    var srcItems = [];
    try {
      if (src.window && Array.isArray(src.window.slots)) srcItems = src.window.slots;
      else if (src.window && typeof src.window.containerItems === "function") srcItems = src.window.containerItems();
    } catch (eSlots) { srcItems = []; }
    var taken = 0;
    for (var i = 0; i < srcItems.length && taken < want; i++) {
      var one = srcItems[i];
      if (!one || cleanItem(one.name) !== out.item) continue;
      var got = await quickMove(bot, one.slot === undefined ? i : one.slot);
      if (got.ok) taken = taken + Math.max(1, toInt(one.count, 1));
    }
    closeWindow(bot, src.window);
    if (taken === 0) { out.message = "item not in source chest / 源箱里没有该物品"; return out; }
    var dst = await openWindow(bot, to, opts);
    if (!dst.ok) { out.message = dst.message; return out; }
    var bag = inventoryOf(bot, opts);
    var stored = 0;
    for (var j = 0; j < bag.length && stored < taken; j++) {
      var item = bag[j];
      if (!item || cleanItem(item.name) !== out.item) continue;
      var put = await quickMove(bot, item.slot === undefined ? j : item.slot);
      if (put.ok) stored = stored + Math.max(1, toInt(item.count, 1));
    }
    closeWindow(bot, dst.window);
    out.transferred = stored;
    out.ok = stored > 0;
    out.message = out.ok ? "transfer complete / 箱子搬运完成" : "nothing transferred / 没有物品被搬运";
    counters.transfers = counters.transfers + 1;
    counters.moved = counters.moved + stored;
    emit("logistics.transfer", { item: out.item, count: stored, from: from, to: to, at: Date.now() });
    return out;
  } catch (e) {
    counters.failed = counters.failed + 1;
    out.message = errText(e);
    return out;
  }
}
// 自动分拣：告示牌 / JSON 规则命中后把背包物品 bot.clickWindow 存入对应箱子，返回完整回执。
async function autoSort(chestPos, rules, options) {
  var opts = options && typeof options === "object" ? options : {};
  var out = { ok: false, moved: 0, skipped: 0, items: [], rule: null, signText: "",
    chest: null, message: "bot not ready / 机器人未就绪" };
  try {
    var pos = pointOf(chestPos);
    if (!pos) { out.message = "bad chest position / 箱子坐标非法"; return out; }
    out.chest = pos;
    var bot = botOf(opts);
    if (!bot) return out;
    var block = null;
    try { if (typeof bot.blockAt === "function") block = bot.blockAt(vecOf(bot, pos)); }
    catch (eBlock) { block = null; }
    if (!block && !opts.window) { out.message = "chest not found / 箱子不存在"; return out; }
    out.signText = readSignText(block);
    var rule = parseRules(rules, out.signText);
    out.rule = rule;
    if (rule.items.length === 0) {
      out.message = "no matching rule / 没有可用的分类规则";
      return out;
    }
    var opened = await openWindow(bot, pos, opts);
    if (!opened.ok) { out.message = opened.message; return out; }
    var bag = inventoryOf(bot, opts);
    for (var i = 0; i < bag.length; i++) {
      var item = bag[i] || {};
      if (!matches(item, rule)) { out.skipped = out.skipped + 1; continue; }
      var hit = await quickMove(bot, item.slot === undefined ? i : item.slot);
      if (!hit.ok) { out.skipped = out.skipped + 1; continue; }
      out.moved = out.moved + 1;
      out.items.push({ name: cleanItem(item.name || item.block), count: toInt(item.count, 1), slot: hit.slot });
    }
    closeWindow(bot, opened.window);
    out.ok = out.moved > 0;
    out.message = out.ok ? "auto sort complete / 自动分拣完成" : "no item matched / 没有物品命中分类规则";
    counters.sorts = counters.sorts + 1;
    counters.moved = counters.moved + out.moved;
    logInfo("分拣 / sort: moved=" + out.moved + " skipped=" + out.skipped + " rule=" + JSON.stringify(rule.items));
    emit("logistics.sorted", { chest: pos, moved: out.moved, signText: out.signText, at: Date.now() });
    return out;
  } catch (e) {
    counters.failed = counters.failed + 1;
    out.message = errText(e);
    return out;
  }
}
// 农场满仓：黑板挂 logistics_sort 任务，供物流机器人抢单；返回 { ok, taskId, message }。
function onFarmFull(chestPos, options) {
  var opts = options && typeof options === "object" ? options : {};
  var out = { ok: false, taskId: "", chest: pointOf(chestPos), message: "board unavailable / 黑板不可用" };
  try {
    if (!out.chest) { out.message = "bad chest position / 箱子坐标非法"; return out; }
    var board = boardOf(opts);
    if (!board || typeof board.postTask !== "function") return out;
    var posted = board.postTask({ title: SORT_TASK, priority: 7,
      payload: { action: "autoSort", chestPos: out.chest, rules: opts.rules || null,
        farm: toText(opts.farm) || "farm", botId: toText(opts.botId), at: Date.now() } });
    if (posted && posted.ok) out.taskId = posted.taskId;
    out.ok = out.taskId.length > 0;
    out.message = out.ok ? "sort task posted / 分拣任务已发布" : "post failed / 任务发布失败";
    counters.tasks = counters.tasks + 1;
    logSystem("农场满仓，调度物流 / farm full, logistics dispatched: " + out.taskId);
    emit("logistics.farm_full", { chest: out.chest, taskId: out.taskId, at: Date.now() });
    return out;
  } catch (e) { out.message = errText(e); return out; }
}
// 物流机器人抢一单分拣任务并执行 autoSort，完成后 completeTask；返回完整回执。
async function logisticsTick(botId, options) {
  var opts = options && typeof options === "object" ? options : {};
  var out = { ok: false, botId: toText(botId), taskId: "", sort: null, message: "board unavailable / 黑板不可用" };
  try {
    var board = boardOf(opts);
    if (!board || typeof board.listTasks !== "function") return out;
    var pending = board.listTasks({ status: "pending" });
    var task = null;
    for (var i = 0; i < pending.length; i++) {
      if (pending[i].title === SORT_TASK) { task = pending[i]; break; }
    }
    if (!task) { out.message = "no sort task / 暂无分拣任务"; return out; }
    var claimed = typeof board.claimTask === "function" ? board.claimTask(out.botId, { taskId: task.id }) : null;
    if (claimed && claimed.ok === false) { out.message = claimed.message; return out; }
    out.taskId = task.id;
    var payload = task.payload || {};
    var sorted = await autoSort(payload.chestPos, payload.rules, opts);
    out.sort = sorted;
    out.ok = sorted.ok === true;
    if (out.ok && board && typeof board.completeTask === "function") {
      try { board.completeTask(task.id); } catch (eDone) { /* 完成标记失败不影响分拣 */ }
    }
    out.message = sorted.message;
    return out;
  } catch (e) { out.message = errText(e); return out; }
}
// 统计快照：分拣 / 搬运 / 任务 / 失败次数。
function stats() {
  return { ok: true, sorts: counters.sorts, moved: counters.moved, transfers: counters.transfers,
    tasks: counters.tasks, failed: counters.failed, attached: !!attached.bot,
    bots: Object.keys(registry).length, taskTitle: SORT_TASK };
}
// 清空内存状态（不触碰黑板）；供自测隔离。
function reset() {
  try {
    attached = { bot: null, botId: "default" };
    registry = {};
    counters = { sorts: 0, moved: 0, transfers: 0, tasks: 0, failed: 0 };
  } catch (e) { /* ignore */ }
  return { ok: true, message: "bot logistics reset / 物流模块已重置" };
}

// 对外导出：绑定 / 告示牌与规则 / 分拣 / 搬运 / 黑板调度 / 诊断。
module.exports = {
  attach: attach,
  registerBot: registerBot,
  readSignText: readSignText,
  parseRules: parseRules,
  autoSort: autoSort,
  chestTransfer: chestTransfer,
  onFarmFull: onFarmFull,
  logisticsTick: logisticsTick,
  stats: stats,
  reset: reset,
  SORT_TASK: SORT_TASK,
  ALIASES: ALIASES
};
