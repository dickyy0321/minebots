// ========================================
// 文件：modules/redstone-supply.js
// 功能：红石 / 建筑材料缺料自动发帖——把缺料清单转成「谁有 10 个中继器，我用钻石换！」式
//       中英双语公屏求助帖，并走既有 broadcast_post / builder-swarm.post 真正发出去
// 依赖：./event-bus（可选）、./logger（可选）、./json-repair（可选）、
//       ./builder-ai-tools 与 ./builder-swarm（函数内延迟 require，避免启动时循环依赖）
// 导出：ITEMS / isRedstone / normalize / composePost / postForMissing / stats / reset / DEFAULT_PAYMENT
// 作者：MineBots
// ========================================
//
// 链路 / pipeline
//   缺料清单（builder-swarm.requestMaterials 或 AI 的 broadcast_post.missing）
//     → normalize() 归一化 → composePost() 生成双语求助帖
//     → aiCode 开启时走 builder-ai-tools.broadcastPost，否则走 builder-swarm.post
//     → 黑板 broadcast:<postId> + 事件广播 + 真 bot.chat 公屏播报
//   不重写任何既有模块，只在缺料路径上换掉帖文并补一条可独立调用的自动发帖入口。
// CommonJS，ES5 风格，无中文变量名；所有外部调用包 try/catch，日志与报错双语。
var bus = null;
try { bus = require("./event-bus"); } catch (e) { bus = null; }
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
var repair = null;
try { repair = require("./json-repair"); } catch (e) { repair = null; }

// 常量：红石 / 建筑材料的中文名、英文复数名与红石元件标记。
var ITEMS = {
  "repeater": { zh: "中继器", en: "repeaters", redstone: true },
  "comparator": { zh: "比较器", en: "comparators", redstone: true },
  "redstone": { zh: "红石粉", en: "redstone dust", redstone: true },
  "redstone_wire": { zh: "红石粉", en: "redstone dust", redstone: true },
  "redstone_torch": { zh: "红石火把", en: "redstone torches", redstone: true },
  "redstone_block": { zh: "红石块", en: "redstone blocks", redstone: true },
  "redstone_lamp": { zh: "红石灯", en: "redstone lamps", redstone: true },
  "piston": { zh: "活塞", en: "pistons", redstone: true },
  "sticky_piston": { zh: "粘性活塞", en: "sticky pistons", redstone: true },
  "observer": { zh: "观察者", en: "observers", redstone: true },
  "lever": { zh: "拉杆", en: "levers", redstone: true },
  "button": { zh: "按钮", en: "buttons", redstone: true },
  "stone_button": { zh: "石质按钮", en: "stone buttons", redstone: true },
  "pressure_plate": { zh: "压力板", en: "pressure plates", redstone: true },
  "hopper": { zh: "漏斗", en: "hoppers", redstone: true },
  "dispenser": { zh: "发射器", en: "dispensers", redstone: true },
  "dropper": { zh: "投掷器", en: "droppers", redstone: true },
  "target": { zh: "标靶", en: "target blocks", redstone: true },
  "daylight_detector": { zh: "阳光探测器", en: "daylight detectors", redstone: true },
  "note_block": { zh: "音符盒", en: "note blocks", redstone: true },
  "tripwire_hook": { zh: "绊线钩", en: "tripwire hooks", redstone: true },
  "stone": { zh: "石头", en: "stone", redstone: false },
  "cobblestone": { zh: "圆石", en: "cobblestone", redstone: false },
  "oak_log": { zh: "橡木原木", en: "oak logs", redstone: false },
  "oak_planks": { zh: "橡木木板", en: "oak planks", redstone: false },
  "planks": { zh: "木板", en: "planks", redstone: false },
  "glass": { zh: "玻璃", en: "glass", redstone: false },
  "iron_ingot": { zh: "铁锭", en: "iron ingots", redstone: false },
  "diamond": { zh: "钻石", en: "diamonds", redstone: false },
  "quartz": { zh: "石英", en: "quartz", redstone: false },
  "slime_block": { zh: "粘液块", en: "slime blocks", redstone: true },
  "honey_block": { zh: "蜂蜜块", en: "honey blocks", redstone: true }
};
// 常量：红石元件模糊匹配关键字（未登记的模组红石件也能识别）。
var REDSTONE_HINTS = ["redstone", "repeater", "comparator", "piston", "observer", "lever",
  "button", "pressure_plate", "hopper", "dispenser", "dropper", "target", "daylight",
  "note_block", "tripwire", "sculk", "lamp", "torch"];
// 常量：默认支付物 / 单次最多列几种材料 / 单种材料数量上限 / 帖文长度上限。
var DEFAULT_PAYMENT = { zh: "钻石", en: "diamonds" };
var MAX_ITEMS = 8;
var MAX_COUNT = 9999;
var MAX_POST_CHARS = 300;
var counters = { composed: 0, posted: 0, redstone: 0, failed: 0 };

// 写文件日志：缺料属高频信息，只落文件不刷 GUI。
function logInfo(msg) {
  try { if (logger && typeof logger.info === "function") logger.info("[redstone-supply] " + msg); } catch (e) { /* ignore */ }
}
// 写系统日志：自动发帖属低频事件，推 GUI 让使用者看见。
function logSystem(msg) {
  try {
    if (logger && typeof logger.system === "function") { logger.system("[redstone-supply] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[redstone-supply] " + msg); } catch (e2) { /* ignore */ }
}
// 广播缺料事件：总线缺失时静默跳过。
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
// 安全转正整数：坏值 / 负数回 0。
function toCount(value) {
  try {
    var n = Number(value);
    if (isNaN(n) || !isFinite(n) || n <= 0) return 0;
    n = Math.floor(n);
    return n > MAX_COUNT ? MAX_COUNT : n;
  } catch (e) { return 0; }
}
// 归一化物品名：去命名空间、去方块状态、小写、下划线统一。
function cleanItem(value) {
  var text = toText(value).toLowerCase().trim();
  try {
    text = text.replace(/^minecraft:/, "").replace(/\[[^\]]*\]/g, "");
    text = text.replace(/[^a-z0-9_]/g, "");
  } catch (e) { /* 保留已清洗部分 */ }
  return text;
}
// 查物品登记信息；未登记时按关键字推断，绝不返回 null。
function infoOf(item) {
  var key = cleanItem(item);
  var hit = ITEMS[key];
  if (hit) return { zh: hit.zh, en: hit.en, redstone: hit.redstone === true };
  for (var i = 0; i < REDSTONE_HINTS.length; i++) {
    if (key.indexOf(REDSTONE_HINTS[i]) >= 0) {
      return { zh: key.replace(/_/g, " "), en: key.replace(/_/g, " "), redstone: true };
    }
  }
  return { zh: key.length > 0 ? key.replace(/_/g, " ") : "材料", en: key.length > 0 ? key.replace(/_/g, " ") : "materials", redstone: false };
}
// 判断一个物品是否红石元件。
function isRedstone(item) {
  try { return infoOf(item).redstone; } catch (e) { return false; }
}
// 把任意格式的缺料清单归一化成数组；支持对象 / 数组 / JSON 字符串 / "repeater:10" 文本。
function normalize(missing) {
  var out = [];
  try {
    var raw = missing;
    if (typeof raw === "string") {
      var text = raw.trim();
      if (text.indexOf("{") === 0 || text.indexOf("[") === 0) {
        raw = repair && typeof repair.safeParse === "function" ? repair.safeParse(text, null) : null;
        if (!raw) { try { raw = JSON.parse(text); } catch (eJson) { raw = null; } }
      } else {
        var pairs = text.split(/[,;，；\n]+/);
        raw = [];
        for (var p = 0; p < pairs.length; p++) {
          var kv = pairs[p].split(":");
          if (kv.length < 2) continue;
          raw.push({ item: kv[0], count: kv[1] });
        }
      }
    }
    var list = [];
    if (Array.isArray(raw)) list = raw;
    else if (raw && typeof raw === "object") {
      for (var k in raw) {
        if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
        list.push({ item: k, count: raw[k] });
      }
    }
    for (var i = 0; i < list.length && out.length < MAX_ITEMS; i++) {
      var one = list[i];
      var item = "", count = 0;
      if (typeof one === "string") {
        var parts = one.split(":");
        item = parts[0]; count = parts.length > 1 ? toCount(parts[1]) : 1;
      } else if (one && typeof one === "object") {
        item = toText(one.item || one.name || one.block || one.key);
        count = toCount(one.count === undefined ? one.amount : one.count);
      }
      if (!cleanItem(item) || count === 0) continue;
      var info = infoOf(item);
      out.push({ item: cleanItem(item), count: count, label: info.zh, en: info.en, redstone: info.redstone });
    }
  } catch (e) { /* 返回已解析部分 */ }
  return out;
}
// 生成一条中英双语的缺料求助帖；无有效缺料时返回 ok:false，绝不抛错。
function composePost(missing, options) {
  var opts = options && typeof options === "object" ? options : {};
  var out = { ok: false, content: "", zh: "", en: "", items: [], redstone: false,
    message: "no shortage / 没有缺料" };
  try {
    var list = normalize(missing);
    if (list.length === 0) return out;
    out.items = list;
    var zhParts = [], enParts = [], redstone = false;
    for (var i = 0; i < list.length; i++) {
      zhParts.push(list[i].count + " 个" + list[i].label);
      enParts.push(list[i].count + " " + list[i].en);
      if (list[i].redstone) redstone = true;
    }
    var payZh = toText(opts.paymentZh || DEFAULT_PAYMENT.zh);
    var payEn = toText(opts.paymentEn || DEFAULT_PAYMENT.en);
    out.zh = "谁有 " + zhParts.join("、") + "，我用" + payZh + "换！";
    out.en = "Need " + enParts.join(", ") + ", paying " + payEn + "!";
    out.content = (out.zh + " / " + out.en).slice(0, MAX_POST_CHARS);
    out.redstone = redstone;
    out.ok = true;
    out.message = "post composed / 求助帖已生成";
    counters.composed = counters.composed + 1;
    if (redstone) counters.redstone = counters.redstone + 1;
    logInfo("生成求助帖 / compose: " + out.content);
    return out;
  } catch (e) {
    out.message = errText(e);
    counters.failed = counters.failed + 1;
    return out;
  }
}
// 自动发帖：把缺料清单变成帖子并真正发出去；返回 { ok, postId, content, redstone, via, message }。
function postForMissing(missing, options) {
  var opts = options && typeof options === "object" ? options : {};
  var out = { ok: false, postId: "", content: "", redstone: false, via: "",
    post: null, message: "post failed / 发帖失败" };
  try {
    var composed = composePost(missing, opts);
    if (!composed.ok) { out.message = composed.message; return out; }
    out.content = composed.content;
    out.redstone = composed.redstone;
    var sendOpts = { kind: "help", board: opts.board, bot: opts.bot || null, jobId: opts.jobId };
    // aiCode 开启且显式要求走 AI 工具链时，先用 broadcast_post（等价于 AI 的 function call）。
    if (opts.ai === true) {
      var aiTools = null;
      try { aiTools = require("./builder-ai-tools"); } catch (eAi) { aiTools = null; }
      if (aiTools && typeof aiTools.broadcastPost === "function" && aiTools.enabled && aiTools.enabled()) {
        var viaAi = aiTools.broadcastPost(out.content, { kind: sendOpts.kind, board: sendOpts.board,
          bot: sendOpts.bot, botId: opts.botId, jobId: sendOpts.jobId });
        if (viaAi && viaAi.ok) {
          out.ok = true; out.postId = viaAi.postId; out.post = viaAi.post; out.via = "broadcast_post";
        }
      }
    }
    // 未走 AI 工具链时直接走蜂群发帖（不受 aiCode 实验开关限制，保证自动求助永远可用）。
    if (!out.ok) {
      var swarm = null;
      try { swarm = require("./builder-swarm"); } catch (eSwarm) { swarm = null; }
      if (swarm && typeof swarm.post === "function") {
        var hit = swarm.post(opts.botId || "supply", out.content, sendOpts);
        if (hit && hit.ok) {
          out.ok = true; out.postId = hit.postId; out.post = hit.post; out.via = "swarm.post";
        }
      }
    }
    if (!out.ok) {
      counters.failed = counters.failed + 1;
      out.message = "post channel unavailable / 发帖通道不可用";
      return out;
    }
    counters.posted = counters.posted + 1;
    out.message = "shortage post published / 缺料求助帖已发布";
    emit("redstone.supply.post", { postId: out.postId, redstone: out.redstone,
      items: composed.items, content: out.content, via: out.via, at: Date.now() });
    logSystem("缺料自动发帖 / auto help post: [" + out.via + "] " + out.content);
    return out;
  } catch (e) {
    counters.failed = counters.failed + 1;
    out.message = errText(e);
    return out;
  }
}
// 状态快照：累计生成 / 发帖 / 红石件命中 / 失败数。
function stats() {
  return { ok: true, composed: counters.composed, posted: counters.posted,
    redstone: counters.redstone, failed: counters.failed };
}
// 清空内存计数（不触碰黑板）；供自测隔离。
function reset() {
  try { counters = { composed: 0, posted: 0, redstone: 0, failed: 0 }; }
  catch (e) { /* ignore */ }
  return { ok: true, message: "redstone supply reset / 红石缺料发帖状态已重置" };
}

// 对外导出：登记表 / 判定 / 归一化 / 帖文生成 / 自动发帖 / 诊断。
module.exports = {
  ITEMS: ITEMS,
  isRedstone: isRedstone,
  normalize: normalize,
  composePost: composePost,
  postForMissing: postForMissing,
  stats: stats,
  reset: reset,
  DEFAULT_PAYMENT: DEFAULT_PAYMENT
};
