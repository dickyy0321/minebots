// ========================================
// 文件：modules/emotion-trust.js
// 功能：情感与信任 2.0——好感度记忆权重衰减 / 吃醋扣分 / 金苹果覆盖仇视记忆 /
//       亲密朋友攻击时告状而非拔剑 / 生成注入 System Prompt 的情绪状态段
// 依赖：fs / path（原子写入，MINEBOTS_STATE_DIR 隔离）、./event-bus（可选）、./logger（可选）
// 导出：setOwner / getOwner / getTrustScore / adjustTrust / recordMemory / decayMemories /
//       onGift / onGiftToOther / onAttacked / setBotState / getBotState /
//       getPromptAppend / stats / reset / DEFAULT_TRUST / WEEK_MS
// 作者：MineBots
// ========================================
//
// 数据文件：state/emotion.json
//   { owner, trust:{ 玩家:分数 }, memories:[{type,actor,weight,at,text,decayed}],
//     botState:{health,food}, stats:{...} }
// 记忆规则 / memory rules：
//   1. 一周前的攻击事件权重减半（只衰减一次，decayed 标记防重复）。
//   2. 近期收到金苹果直接覆盖该玩家的仇视记忆（抹掉 attack 类记录）。
//   3. 主人把高价值物品给了别人却没给 Bot，信任分 -5 并吐槽。
//   4. 亲密朋友攻击 Bot：不拔剑反击，逃到主人身边并公屏告状。
// 注入规则 / prompt rules：active 为 false（没有任何情感写操作）时 getPromptAppend 返回空串，
//   保证 context-manager 的既有精确断言不被污染；任何写操作后置 true，段里必带
//   trustScore / memories / health / food 四个可断言字段。
// 测试隔离：环境变量 MINEBOTS_STATE_DIR 可替换 state 目录；reset 会删掉数据文件。
// ES5 风格，CommonJS，无中文变量名；所有外部调用包 try/catch，绝不抛到顶层。

var fs = require("fs");
var path = require("path");
// 可选依赖：事件总线，低频情感事件广播；缺失时静默跳过。
var bus = null;
try { bus = require("./event-bus"); } catch (e) { bus = null; }
// 可选依赖：日志核心，高频信息只写文件，低频情绪事件推 GUI。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：默认信任分 / 一周毫秒数 / 记忆条数上限 / 吃醋扣分 / 信任分区间。
var DEFAULT_TRUST = 50;
var WEEK_MS = 7 * 24 * 60 * 60 * 1000;
var MAX_MEMORIES = 60;
var JEALOUSY_DELTA = -5;
var TRUST_MIN = 0;
var TRUST_MAX = 100;
// 高价值物品：命中即触发吃醋判定（同时认中英文物品名）。
var HIGH_VALUE = ["diamond", "diamond_block", "netherite", "netherite_ingot", "emerald",
  "gold_ingot", "gold_block", "钻石", "下界合金", "绿宝石", "金锭"];
// 金苹果别名：命中即覆盖仇视记忆。
var GOLDEN_APPLE = ["golden_apple", "enchanted_golden_apple", "金苹果", "附魔金苹果"];
// 双语固定文案：吐槽与告状必须逐字可断言。
var TAUNT_ZH = "你居然把钻石给他不给我！";
var TAUNT_EN = "You gave him diamonds but not me!";
var COMPLAINT_ZH = "主人，你的朋友打我，我能还手吗？";
var COMPLAINT_EN = "Owner, your friend hit me, may I fight back?";

// 进程内标记：只有发生过情感写操作才往 System Prompt 注入内容。
var active = false;
// 进程内缓存：当前血量 / 饥饿（高频更新，不落盘）。
var vitals = { health: 20, food: 20 };

// 写文件日志：高频状态只落文件，绝不刷 GUI。
function logInfo(msg) {
  try { if (logger && typeof logger.info === "function") logger.info("[emotion-trust] " + msg); } catch (e) { /* ignore */ }
}
// 写系统日志：吃醋 / 告状这类低频拟人事件推 GUI。
function logSystem(msg) {
  try {
    if (logger && typeof logger.system === "function") { logger.system("[emotion-trust] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[emotion-trust] " + msg); } catch (e2) { /* ignore */ }
}
// 广播低频情感事件；总线缺失时静默跳过。
function emit(name, payload) {
  try { if (bus && typeof bus.emit === "function") bus.emit(name, payload); } catch (e) { /* ignore */ }
}
// 安全取错误文本：catch 里绝不会二次抛错。
function errText(err) {
  try { if (err && err.message) return String(err.message); return String(err); }
  catch (e) { return "unknown error / 未知错误"; }
}
// 安全转字符串并去空白；null 与 undefined 统一成空串。
function clean(value) {
  if (value === null || value === undefined) return "";
  try { return String(value).replace(/^\s+|\s+$/g, ""); } catch (e) { return ""; }
}
// 安全转整数；非法值退回 fallback。
function toInt(value, fallback) {
  var n = parseInt(value, 10);
  return isNaN(n) ? fallback : n;
}
// 取 state 目录：允许 MINEBOTS_STATE_DIR 覆盖（自测隔离用）。
function stateDir() {
  try {
    var custom = process.env.MINEBOTS_STATE_DIR;
    if (custom && String(custom).length > 0) return String(custom);
  } catch (e) { /* 读不到环境变量就用默认目录 */ }
  return path.join(process.cwd(), "state");
}
// 情感数据文件路径。
function emotionFile() {
  return path.join(stateDir(), "emotion.json");
}
// 空数据结构：全默认，保证缺文件时行为可预测。
function emptyData() {
  return {
    owner: "", trust: {}, memories: [], botState: { health: 20, food: 20 },
    stats: { gifts: 0, attacks: 0, jealous: 0, complaints: 0, decays: 0, overrides: 0, prompts: 0 }
  };
}
// 把任意来源洗成标准结构：坏值一律丢掉，不信任外部输入。
function normalize(raw) {
  var out = emptyData();
  var src = raw && typeof raw === "object" ? raw : {};
  try { out.owner = clean(src.owner).slice(0, 60); } catch (e) { /* ignore */ }
  try {
    var trust = src.trust && typeof src.trust === "object" ? src.trust : {};
    var keys = Object.keys(trust);
    for (var i = 0; i < keys.length; i++) {
      var who = clean(keys[i]);
      var score = Number(trust[keys[i]]);
      if (who.length === 0 || !isFinite(score)) continue;
      out.trust[who] = Math.max(TRUST_MIN, Math.min(TRUST_MAX, Math.round(score)));
    }
  } catch (e) { /* 坏 trust 段按空处理 */ }
  try {
    var list = Array.isArray(src.memories) ? src.memories : [];
    for (var k = 0; k < list.length && out.memories.length < MAX_MEMORIES; k++) {
      var one = list[k] && typeof list[k] === "object" ? list[k] : {};
      var mem = {
        type: clean(one.type) || "event",
        actor: clean(one.actor) || "someone",
        weight: Number(one.weight),
        at: Number(one.at) || 0,
        text: clean(one.text).slice(0, 160),
        decayed: one.decayed === true
      };
      if (!isFinite(mem.weight) || mem.weight < 0) mem.weight = 1;
      out.memories.push(mem);
    }
  } catch (e) { /* 坏 memories 段按空处理 */ }
  try {
    var st = src.stats && typeof src.stats === "object" ? src.stats : {};
    var fields = ["gifts", "attacks", "jealous", "complaints", "decays", "overrides", "prompts"];
    for (var f = 0; f < fields.length; f++) out.stats[fields[f]] = toInt(st[fields[f]], 0);
  } catch (e) { /* 坏 stats 段按零处理 */ }
  return out;
}
// 原子写 JSON：先写同目录 .tmp 再 rename，避免写一半留下坏文件。
function writeJsonAtomic(file, data) {
  try {
    var dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    var tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    try { if (fs.existsSync(file + ".tmp")) fs.unlinkSync(file + ".tmp"); } catch (e) { /* 清不掉就算了 */ }
    logInfo("write failed / 写入失败: " + errText(err));
    return false;
  }
}
// 读情感数据：缺文件 / 坏 JSON 都返回默认结构，绝不抛错。
function load() {
  try {
    var file = emotionFile();
    if (!fs.existsSync(file)) return emptyData();
    var text = fs.readFileSync(file, "utf8");
    if (!text || text.trim().length === 0) return emptyData();
    return normalize(JSON.parse(text));
  } catch (err) {
    logInfo("load failed / 读取失败: " + errText(err));
    return emptyData();
  }
}
// 写情感数据：返回是否成功；内存 vitals 与 active 不落盘。
function save(data) {
  return writeJsonAtomic(emotionFile(), normalize(data));
}
// 判断是否包含给定别名表中的任一关键词（大小写不敏感）。
function hits(text, table) {
  var low = clean(text).toLowerCase();
  if (low.length === 0) return false;
  for (var i = 0; i < table.length; i++) {
    if (low.indexOf(String(table[i]).toLowerCase()) >= 0) return true;
  }
  return false;
}
// 功能：设置主人名字；空名字忽略，成功返回 { ok, owner }。
function setOwner(name) {
  try {
    var who = clean(name);
    if (who.length === 0) return { ok: false, message: "owner name required / 缺少主人名" };
    var data = load();
    data.owner = who;
    if (!save(data)) return { ok: false, message: "write failed / 写入失败" };
    active = true;
    logSystem("主人已设定 / owner set: " + who);
    return { ok: true, owner: who };
  } catch (err) { return { ok: false, message: errText(err) }; }
}
// 功能：读主人名字；没设过返回空串。
function getOwner() {
  try { return load().owner; } catch (e) { return ""; }
}
// 功能：查某玩家信任分；没记录返回默认 50。
function getTrustScore(player) {
  try {
    var who = clean(player);
    if (who.length === 0) return DEFAULT_TRUST;
    var data = load();
    var score = data.trust[who];
    return typeof score === "number" ? score : DEFAULT_TRUST;
  } catch (err) { return DEFAULT_TRUST; }
}
// 功能：增减信任分并落盘，返回变动前后值；区间钳制在 0..100。
function adjustTrust(player, delta, reason) {
  try {
    var who = clean(player) || "owner";
    var step = Number(delta);
    if (!isFinite(step)) step = 0;
    // 绝对主人特权：GUI 配置 isOwner=true 的玩家信任分恒定 100，任何扣分直接忽略。
    try {
      var privilege = require("./owner-privilege");
      var verdict = privilege && typeof privilege.guardTrustDelta === "function" ?
        privilege.guardTrustDelta(who, step, {}) : null;
      if (verdict && verdict.locked === true) {
        var locked = load();
        locked.trust[who] = TRUST_MAX;
        save(locked);
        emit("emotion.trust", { player: who, before: TRUST_MAX, after: TRUST_MAX, delta: 0, reason: "owner_locked" });
        return { ok: true, player: who, before: TRUST_MAX, after: TRUST_MAX, delta: 0,
          locked: true, reason: clean(reason) };
      }
    } catch (ePrivilege) { /* 特权模块缺失时按原逻辑增减 */ }
    var data = load();
    var before = typeof data.trust[who] === "number" ? data.trust[who] : DEFAULT_TRUST;
    var after = Math.max(TRUST_MIN, Math.min(TRUST_MAX, Math.round(before + step)));
    data.trust[who] = after;
    if (!save(data)) return { ok: false, before: before, after: before, message: "write failed / 写入失败" };
    active = true;
    emit("emotion.trust", { player: who, before: before, after: after, delta: after - before, reason: clean(reason) });
    logInfo("信任分 / trust: " + who + " " + before + " -> " + after + " (" + clean(reason) + ")");
    return { ok: true, player: who, before: before, after: after, delta: after - before, reason: clean(reason) };
  } catch (err) { return { ok: false, message: errText(err) }; }
}
// 功能：追加一条带权重的记忆；超出上限时丢掉最旧的，返回 { ok, memory }。
function recordMemory(type, actor, options) {
  try {
    var opts = options && typeof options === "object" ? options : {};
    var data = load();
    var mem = {
      type: clean(type) || "event",
      actor: clean(actor) || "someone",
      weight: Number(opts.weight),
      at: Number(opts.at) || Date.now(),
      text: clean(opts.text).slice(0, 160),
      decayed: opts.decayed === true
    };
    if (!isFinite(mem.weight) || mem.weight < 0) mem.weight = 1;
    data.memories.push(mem);
    while (data.memories.length > MAX_MEMORIES) data.memories.shift();
    if (!save(data)) return { ok: false, message: "write failed / 写入失败" };
    active = true;
    emit("emotion.memory", { type: mem.type, actor: mem.actor, weight: mem.weight });
    return { ok: true, memory: mem, count: data.memories.length };
  } catch (err) { return { ok: false, message: errText(err) }; }
}
// 功能：记忆权重衰减——一周前的攻击事件权重减半，且每条只衰减一次。
function decayMemories(now) {
  try {
    var at = Number(now);
    if (!isFinite(at) || at <= 0) at = Date.now();
    var data = load();
    var changed = 0;
    for (var i = 0; i < data.memories.length; i++) {
      var one = data.memories[i];
      if (one.type !== "attack" || one.decayed === true) continue;
      if (at - one.at < WEEK_MS) continue;
      one.weight = Math.round(one.weight * 0.5 * 100) / 100;
      one.decayed = true;
      changed = changed + 1;
    }
    if (changed > 0) {
      data.stats.decays = data.stats.decays + changed;
      save(data);
      logInfo("记忆衰减 / memory decay: " + changed + " 条攻击记忆权重减半 / attack weights halved");
    }
    return { ok: true, decayed: changed, total: data.memories.length, weekMs: WEEK_MS };
  } catch (err) { return { ok: false, decayed: 0, message: errText(err) }; }
}
// 功能：收到礼物——金苹果直接覆盖该玩家的仇视记忆并大幅加分，普通礼物小幅加分。
function onGift(player, item, options) {
  try {
    var opts = options && typeof options === "object" ? options : {};
    var who = clean(player) || "owner";
    var name = clean(item);
    var data = load();
    var premium = hits(name, GOLDEN_APPLE);
    var removed = 0;
    if (premium) {
      var kept = [];
      for (var i = 0; i < data.memories.length; i++) {
        var one = data.memories[i];
        if (one.actor === who && (one.type === "attack" || one.type === "hostile" || one.type === "jealousy")) { removed = removed + 1; continue; }
        kept.push(one);
      }
      data.memories = kept;
    }
    var step = premium ? 12 : 3;
    var before = typeof data.trust[who] === "number" ? data.trust[who] : DEFAULT_TRUST;
    data.trust[who] = Math.max(TRUST_MIN, Math.min(TRUST_MAX, Math.round(before + step)));
    data.stats.gifts = data.stats.gifts + 1;
    if (premium) data.stats.overrides = data.stats.overrides + 1;
    if (!save(data)) return { ok: false, message: "write failed / 写入失败" };
    active = true;
    var mem = recordMemory("gift", who, {
      weight: premium ? 3 : 1,
      text: (premium ? "送过金苹果，旧怨一笔勾销 / gave golden apple, grudge cleared" : "送过礼物 / gave a gift") + ": " + name
    });
    emit("emotion.gift", { player: who, item: name, premium: premium, overridden: removed, trust: data.trust[who] });
    logSystem("收到礼物 / gift from " + who + ": " + name + (premium ? "（覆盖仇视 / grudge overridden）" : ""));
    return {
      ok: true, player: who, item: name, premium: premium, overridden: removed,
      trustBefore: before, trustAfter: data.trust[who], delta: step,
      memory: mem && mem.ok ? mem.memory : null
    };
  } catch (err) { return { ok: false, message: errText(err) }; }
}
// 功能：吃醋——主人把高价值物品给了别人且近期没给 Bot，信任 -5 并生成吐槽文案。
function onGiftToOther(ownerName, target, item, options) {
  try {
    var opts = options && typeof options === "object" ? options : {};
    var owner = clean(ownerName) || load().owner || "owner";
    var other = clean(target);
    var name = clean(item);
    var valuable = hits(name, HIGH_VALUE);
    // 近期（一天内）给过 Bot 礼物就不吃醋，避免误判。
    var data = load();
    var recent = false;
    var now = Date.now();
    for (var i = 0; i < data.memories.length; i++) {
      var m = data.memories[i];
      if (m.type === "gift_to_bot" && now - m.at < 24 * 60 * 60 * 1000) { recent = true; break; }
    }
    if (!valuable || other.length === 0 || recent === true) {
      return { ok: true, jealous: false, owner: owner, target: other, item: name,
        message: "no jealousy / 未触发吃醋" };
    }
    var hit = adjustTrust(owner, JEALOUSY_DELTA, "jealousy");
    // 必须重新读盘再改统计：adjustTrust 已落盘，用旧快照回写会把刚扣的信任分覆盖掉。
    var fresh = load();
    fresh.stats.jealous = fresh.stats.jealous + 1;
    save(fresh);
    recordMemory("jealousy", owner, {
      weight: 1.5,
      text: "把 " + name + " 给了 " + other + " 却没给我 / gave " + name + " to " + other + ", not me"
    });
    var taunt = TAUNT_ZH + " / " + TAUNT_EN;
    // 有真实 bot 就公屏吐槽；没有也返回文案供上层使用。
    try {
      if (opts.bot && typeof opts.bot.chat === "function") opts.bot.chat(taunt);
    } catch (eChat) { /* 聊天失败不影响判定 */ }
    emit("emotion.jealousy", { owner: owner, target: other, item: name, trust: hit.after, taunt: taunt });
    logSystem("吃醋 / jealous: " + owner + " -> " + other + " (" + name + ") 信任 -5 / trust -5");
    return {
      ok: true, jealous: true, owner: owner, target: other, item: name,
      trustBefore: hit.before, trustAfter: hit.after, delta: JEALOUSY_DELTA,
      taunt: taunt, chat: taunt, message: taunt
    };
  } catch (err) { return { ok: false, jealous: false, message: errText(err) }; }
}
// 功能：标记主人刚给过 Bot 礼物（抑制吃醋），返回 { ok }。
function noteGiftToBot(options) {
  try {
    var opts = options && typeof options === "object" ? options : {};
    return recordMemory("gift_to_bot", clean(opts.owner) || load().owner || "owner", {
      weight: 1, text: clean(opts.item) || "gift to bot / 给 Bot 的礼物"
    });
  } catch (err) { return { ok: false, message: errText(err) }; }
}
// 功能：被攻击决策——close_friend 不拔剑反击，逃到主人身边并公屏告状；其余等级正常反击。
function onAttacked(attacker, options) {
  try {
    var opts = options && typeof options === "object" ? options : {};
    var who = clean(attacker) || "someone";
    var level = clean(opts.level) || "normal";
    var data = load();
    data.stats.attacks = data.stats.attacks + 1;
    var friendly = level === "close_friend" || level === "owner";
    if (friendly) {
      data.stats.complaints = data.stats.complaints + 1;
      save(data);
      recordMemory("attack", who, {
        weight: 0.5, text: "亲密朋友误伤，忍了并告状 / friend hit me, reported instead of fighting back"
      });
      adjustTrust(who, -2, "friend_attack");
      var appeal = COMPLAINT_ZH + " / " + COMPLAINT_EN;
      var ownerPos = opts.ownerPosition && typeof opts.ownerPosition === "object" ? opts.ownerPosition : null;
      var fled = false;
      // 有真实 bot 就公屏告状 + 逃到主人身边；绝不调用 attack / attackEntity。
      try {
        if (opts.bot) {
          if (typeof opts.bot.chat === "function") opts.bot.chat(appeal);
          if (ownerPos && typeof opts.bot.lookAt === "function") opts.bot.lookAt(ownerPos, true);
          if (ownerPos && opts.actions && typeof opts.actions.moveTo === "function") {
            opts.actions.moveTo(opts.bot, ownerPos.x, ownerPos.y, ownerPos.z);
            fled = true;
          } else if (typeof opts.bot.setControlState === "function") {
            opts.bot.setControlState("sprint", true);
            opts.bot.setControlState("forward", true);
            fled = true;
          }
        }
      } catch (eBot) { /* bot 动作失败不影响决策 */ }
      emit("emotion.complaint", {
        botId: clean(opts.botId) || "default", attacker: who, source: who,
        level: level, appeal: appeal, chat: appeal, retaliate: false, fled: fled
      });
      logSystem("告状 / complaint: " + who + "（" + level + "）打了我，先问主人 / ask owner first");
      return {
        ok: true, attacker: who, level: level, retaliate: false, counterAttack: false,
        action: "flee_to_owner", fleeToOwner: true, complaint: true, fled: fled,
        chat: appeal, message: appeal, trust: getTrustScore(who)
      };
    }
    save(data);
    recordMemory("attack", who, { weight: 1, text: "攻击过我 / attacked me" });
    adjustTrust(who, -8, "attack");
    emit("emotion.attack", { attacker: who, level: level, retaliate: true });
    return {
      ok: true, attacker: who, level: level, retaliate: true, counterAttack: true,
      action: "counter_attack", fleeToOwner: false, complaint: false,
      chat: "", message: "counter attack / 正常反击"
    };
  } catch (err) {
    return { ok: false, retaliate: true, action: "counter_attack", message: errText(err) };
  }
}
// 功能：更新当前血量 / 饥饿（高频，只写内存）；返回最新状态。
function setBotState(state) {
  try {
    var s = state && typeof state === "object" ? state : {};
    var h = Number(s.health), f = Number(s.food);
    if (isFinite(h)) vitals.health = Math.max(0, Math.min(20, Math.round(h)));
    if (isFinite(f)) vitals.food = Math.max(0, Math.min(20, Math.round(f)));
    active = true;
    return { ok: true, health: vitals.health, food: vitals.food };
  } catch (err) { return { ok: false, health: vitals.health, food: vitals.food, message: errText(err) }; }
}
// 功能：读当前血量 / 饥饿；返回数值副本。
function getBotState() {
  return { health: vitals.health, food: vitals.food };
}
// 功能：生成注入 System Prompt 的情绪段；未发生任何情感写操作时返回空串。
function getPromptAppend(options) {
  try {
    if (active !== true) return "";
    var opts = options && typeof options === "object" ? options : {};
    var data = load();
    var owner = clean(opts.owner) || data.owner || "owner";
    var score = typeof data.trust[owner] === "number" ? data.trust[owner] : DEFAULT_TRUST;
    var memLines = [];
    for (var i = 0; i < data.memories.length && memLines.length < 4; i++) {
      var m = data.memories[i];
      memLines.push("- " + m.actor + " [" + m.type + ", 权重 weight=" + m.weight + "] " + m.text);
    }
    if (memLines.length === 0) memLines.push("- 暂无特别记忆 / no special memories yet");
    var tone = score >= 75 ? "亲近、撒娇、依赖 / warm, playful, attached"
      : (score >= 40 ? "平静但带点小情绪 / calm with mild sulk"
        : "委屈、戒备、闹别扭 / hurt, wary, sulking");
    var lines = [];
    lines.push("[情感与信任 / Emotion & Trust]");
    lines.push("- 信任分 trustScore: " + score + "/100（对 " + owner + " / toward " + owner + "）");
    lines.push("- 记忆 memories: ");
    for (var k = 0; k < memLines.length; k++) lines.push("  " + memLines[k]);
    lines.push("- 当前状态 state: 血量 health=" + vitals.health + "/20, 饥饿 food=" + vitals.food + "/20");
    lines.push("- 语气 tone: " + tone);
    lines.push("- 要求 / instruction: 依据 trustScore、memories 与当前血量饥饿拟人化表达，会吃醋、会委屈、会关心主人，不要机械回答 / Speak like a loyal companion using trust, memories and vitals; never sound robotic.");
    data.stats.prompts = data.stats.prompts + 1;
    save(data);
    return lines.join("\n");
  } catch (err) { return ""; }
}
// 功能：读统计与当前状态，供自测与 GUI 使用；失败也返回带 ok:false 的结构。
function stats() {
  try {
    var data = load();
    return {
      ok: true, active: active, owner: data.owner, trust: data.trust,
      memories: data.memories.length, botState: getBotState(),
      stats: data.stats, weekMs: WEEK_MS, defaultTrust: DEFAULT_TRUST
    };
  } catch (err) { return { ok: false, active: active, memories: 0, message: errText(err) }; }
}
// 功能：清空内存状态并删除情感数据文件（自测隔离用），返回 { ok }。
function reset() {
  active = false;
  vitals = { health: 20, food: 20 };
  try {
    var file = emotionFile();
    if (fs.existsSync(file)) fs.unlinkSync(file);
    if (fs.existsSync(file + ".tmp")) fs.unlinkSync(file + ".tmp");
  } catch (err) { return { ok: false, message: errText(err) }; }
  return { ok: true, message: "emotion reset / 情感状态已重置" };
}
// 对外导出：情感信任 2.0 全量接口。
module.exports = {
  setOwner: setOwner,
  getOwner: getOwner,
  getTrustScore: getTrustScore,
  adjustTrust: adjustTrust,
  recordMemory: recordMemory,
  decayMemories: decayMemories,
  onGift: onGift,
  onGiftToOther: onGiftToOther,
  noteGiftToBot: noteGiftToBot,
  onAttacked: onAttacked,
  setBotState: setBotState,
  getBotState: getBotState,
  getPromptAppend: getPromptAppend,
  stats: stats,
  reset: reset,
  DEFAULT_TRUST: DEFAULT_TRUST,
  WEEK_MS: WEEK_MS,
  TAUNT_ZH: TAUNT_ZH,
  COMPLAINT_ZH: COMPLAINT_ZH
};
