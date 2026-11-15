// ========================================
// 文件：modules/player-manager.js
// 功能：玩家等级判定与记忆——manual 手工表优先，其次 judged 自动评判，最后默认 normal；
//       情感与信任 2.0 薄接线（好感度衰减 / 吃醋 / 告状 / System Prompt 注入）
// 依赖：fs / path（原子写入：先写 .tmp 再 rename）；./logger、./emotion-trust（均可选）
// 导出：loadPlayers、savePlayers、setAutoJudge、getLevel、judgeByBehavior、
//       getTrustScore、decayMemories、onGiftToOther、noteGiftToBot、onBotAttacked、
//       setBotState、getEmotionPrompt、emotionStats、resetEmotion
// 作者：MineBots
// ========================================
//
// 数据文件：state/players.json
//   { "manual": { "owner": ["Steve"], ... }, "judged": { "Alex": "friend" }, "autoJudge": true }
// 等级优先级：owner > close_friend > friend > normal > hostile > targeted（manual 查表按此顺序命中）
// 情感数据另存 state/emotion.json（由 ./emotion-trust 管理），players.json 结构保持不变，
//   这样既有等级断言与手工表合并语义完全不受影响。
// 测试隔离：环境变量 MINEBOTS_STATE_DIR 可替换 state 目录（自测用临时目录，不碰真实数据）。
// ES5 风格，CommonJS，无中文变量名

var fs = require("fs");
var path = require("path");
// 可选依赖：日志核心；缺失时退回 console。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
// 可选依赖：情感与信任 2.0 引擎；缺失时所有情感接线安全降级，不影响等级判定。
var emotion = null;
try { emotion = require("./emotion-trust"); } catch (e) { emotion = null; }
// 等级常量：这两级攻击 Bot 时只告状不拔剑（对应「亲密朋友」语义）。
var NO_RETALIATE = ["owner", "close_friend"];

// 等级常量：顺序即优先级，同一个玩家出现在多个手工表里时，靠前的等级生效。
var LEVELS = ["owner", "close_friend", "friend", "normal", "hostile", "targeted"];
// 默认等级：查不到任何记录时的结论。
var DEFAULT_LEVEL = "normal";
// 自动评判支持的行为事件 → 等级。
var BEHAVIOR_LEVELS = { attacked_bot: "hostile", gave_item: "friend" };

// 写告警日志：优先 logger.warn，失败退回 console，绝不抛错。
function logWarn(message) {
  try {
    if (logger && typeof logger.warn === "function") logger.warn(message);
    else console.warn(message);
  } catch (e) { /* 日志失败不影响业务 */ }
}

// 安全取错误文本：catch 里再抛错就破红线了。
function getErrText(err) {
  try {
    if (!err) return "unknown error";
    if (err.message) return String(err.message);
    return String(err);
  } catch (e) { return "unknown error"; }
}

// 安全取字符串：null / undefined 统一成空串并去掉首尾空白。
function cleanName(value) {
  if (value === null || value === undefined) return "";
  try { return String(value).trim(); } catch (e) { return ""; }
}

// 判断是不是合法等级常量。
function isLevel(name) {
  for (var i = 0; i < LEVELS.length; i++) {
    if (LEVELS[i] === name) return true;
  }
  return false;
}

// 取 state 目录：允许用环境变量 MINEBOTS_STATE_DIR 覆盖（自测隔离用）。
function stateDir() {
  try {
    var custom = process.env.MINEBOTS_STATE_DIR;
    if (custom && String(custom).length > 0) return String(custom);
  } catch (e) { /* 读不到环境变量就用默认目录 */ }
  return path.join(process.cwd(), "state");
}

// 玩家数据文件路径。
function playersFile() {
  return path.join(stateDir(), "players.json");
}

// 空数据结构：六个手工等级都在，autoJudge 默认开。
function emptyPlayers() {
  var out = { manual: {}, judged: {}, autoJudge: true };
  for (var i = 0; i < LEVELS.length; i++) out.manual[LEVELS[i]] = [];
  return out;
}

// 清掉空的 / 非字符串的玩家名，并按大小写去重（保留第一次出现的写法）。
function cleanList(list) {
  var out = [];
  var seen = {};
  if (!Array.isArray(list)) return out;
  for (var i = 0; i < list.length; i++) {
    var name = cleanName(list[i]);
    if (name.length === 0) continue;
    var key = name.toLowerCase();
    if (seen[key] === true) continue;
    seen[key] = true;
    out.push(name);
  }
  return out;
}

// 把任意来源的数据洗成标准结构：缺的等级补空数组，非法等级 / 非法玩家名一律丢掉。
function normalizePlayers(raw) {
  var out = emptyPlayers();
  var src = raw && typeof raw === "object" ? raw : {};
  var manual = src.manual && typeof src.manual === "object" ? src.manual : {};
  for (var i = 0; i < LEVELS.length; i++) {
    var level = LEVELS[i];
    out.manual[level] = cleanList(manual[level]);
  }
  var judged = src.judged && typeof src.judged === "object" ? src.judged : {};
  var keys = Object.keys(judged);
  for (var k = 0; k < keys.length; k++) {
    var name = cleanName(keys[k]);
    var value = judged[keys[k]];
    if (name.length === 0) continue;
    if (typeof value !== "string") continue;
    if (!isLevel(value)) continue;
    out.judged[name] = value;
  }
  out.autoJudge = typeof src.autoJudge === "boolean" ? src.autoJudge : true;
  return out;
}

// 原子写 JSON：先写同目录的 .tmp，再 rename 覆盖，避免写一半留下坏文件。
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
    logWarn("[player-manager] write failed: " + getErrText(err));
    return false;
  }
}

// 功能 1：读玩家数据；文件不存在 / 坏掉都返回默认结构，绝不抛错，也不改写文件。
function loadPlayers() {
  try {
    var file = playersFile();
    if (!fs.existsSync(file)) return emptyPlayers();
    var text = fs.readFileSync(file, "utf8");
    if (!text || text.trim().length === 0) return emptyPlayers();
    return normalizePlayers(JSON.parse(text));
  } catch (err) {
    logWarn("[player-manager] load failed: " + getErrText(err));
    return emptyPlayers();
  }
}

// 把 payload 合并进 current：manual 按等级覆盖（提交哪个等级就换哪个等级，因此能删人），judged 按名字覆盖。
function mergePlayers(current, payload) {
  var out = normalizePlayers(current);
  var src = payload && typeof payload === "object" ? payload : {};
  var manual = src.manual && typeof src.manual === "object" ? src.manual : null;
  if (manual) {
    for (var i = 0; i < LEVELS.length; i++) {
      var level = LEVELS[i];
      if (manual[level] === undefined || manual[level] === null) continue;
      if (!Array.isArray(manual[level])) continue;
      out.manual[level] = cleanList(manual[level]);
    }
  }
  var judged = src.judged && typeof src.judged === "object" ? src.judged : null;
  if (judged) {
    var keys = Object.keys(judged);
    for (var k = 0; k < keys.length; k++) {
      var name = cleanName(keys[k]);
      if (name.length === 0) continue;
      var value = judged[keys[k]];
      if (value === null || value === "") { delete out.judged[name]; continue; }
      if (typeof value !== "string" || !isLevel(value)) continue;
      out.judged[name] = value;
    }
  }
  if (typeof src.autoJudge === "boolean") out.autoJudge = src.autoJudge;
  return out;
}

// 功能 2：合并并保存玩家数据，成功返回 { ok:true }，失败只给 { ok:false, error }，不抛错。
function savePlayers(payload) {
  try {
    var next = mergePlayers(loadPlayers(), payload);
    if (!writeJsonAtomic(playersFile(), next)) return { ok: false, error: "write failed / 写入失败" };
    return { ok: true };
  } catch (err) {
    logWarn("[player-manager] save failed: " + getErrText(err));
    return { ok: false, error: getErrText(err) };
  }
}

// 功能 3：开关自动评判，落盘后返回结果。
function setAutoJudge(on) {
  try {
    var next = loadPlayers();
    next.autoJudge = !!on;
    if (!writeJsonAtomic(playersFile(), next)) return { ok: false, error: "write failed / 写入失败" };
    return { ok: true, autoJudge: next.autoJudge };
  } catch (err) {
    logWarn("[player-manager] setAutoJudge failed: " + getErrText(err));
    return { ok: false, error: getErrText(err) };
  }
}

// 在手工表里找玩家：先精确匹配，再忽略大小写；命中返回等级，没命中返回空串。
function findManualLevel(data, name) {
  var wanted = name.toLowerCase();
  for (var i = 0; i < LEVELS.length; i++) {
    var list = data.manual[LEVELS[i]] || [];
    for (var k = 0; k < list.length; k++) {
      if (list[k] === name) return LEVELS[i];
    }
    for (var m = 0; m < list.length; m++) {
      if (list[m].toLowerCase() === wanted) return LEVELS[i];
    }
  }
  return "";
}

// 功能 4：查玩家等级：manual 优先 → judged → 默认 normal；名字为空也算 normal。
function getLevel(name) {
  try {
    var wanted = cleanName(name);
    if (wanted.length === 0) return DEFAULT_LEVEL;
    var data = loadPlayers();
    var manualLevel = findManualLevel(data, wanted);
    if (manualLevel.length > 0) return manualLevel;
    if (data.judged[wanted] && isLevel(data.judged[wanted])) return data.judged[wanted];
    return DEFAULT_LEVEL;
  } catch (err) {
    logWarn("[player-manager] getLevel failed: " + getErrText(err));
    return DEFAULT_LEVEL;
  }
}

// 功能 5：按行为自动评判：attacked_bot → hostile，gave_item → friend；自动评判关掉就直接跳过。
function judgeByBehavior(name, event) {
  try {
    var wanted = cleanName(name);
    var data = loadPlayers();
    if (data.autoJudge !== true) return { ok: true, skipped: true, level: DEFAULT_LEVEL };
    if (wanted.length === 0) return { ok: false, error: "player name required / 缺少玩家名" };
    var kind = cleanName(event);
    if (!Object.prototype.hasOwnProperty.call(BEHAVIOR_LEVELS, kind)) {
      return { ok: false, error: "unknown event / 未知行为事件：" + kind };
    }
    var level = BEHAVIOR_LEVELS[kind];
    data.judged[wanted] = level;
    if (!writeJsonAtomic(playersFile(), data)) return { ok: false, error: "write failed / 写入失败" };
    return { ok: true, level: level, player: wanted, event: kind };
  } catch (err) {
    logWarn("[player-manager] judgeByBehavior failed: " + getErrText(err));
    return { ok: false, error: getErrText(err) };
  }
}

// 情感接线是否可用：引擎缺失时统一返回这份降级体，绝不抛错。
function emotionDown() {
  return { ok: false, skipped: true, message: "emotion-trust unavailable / 情感引擎不可用" };
}
// 功能：查某玩家的信任分（好感度）；引擎缺失时返回默认值 50。
function getTrustScore(player) {
  try {
    if (!emotion || typeof emotion.getTrustScore !== "function") return 50;
    return emotion.getTrustScore(cleanName(player));
  } catch (err) { logWarn("[player-manager] getTrustScore failed: " + getErrText(err)); return 50; }
}
// 功能：记忆权重衰减——一周前的攻击事件权重减半；返回 { ok, decayed }。
function decayMemories(now) {
  try {
    if (!emotion || typeof emotion.decayMemories !== "function") return emotionDown();
    return emotion.decayMemories(now);
  } catch (err) { return { ok: false, decayed: 0, message: getErrText(err) }; }
}
// 功能：主人把高价值物品给了别人却没给 Bot——信任 -5 并公屏吐槽（吃醋逻辑）。
function onGiftToOther(owner, target, item, options) {
  try {
    if (!emotion || typeof emotion.onGiftToOther !== "function") return emotionDown();
    return emotion.onGiftToOther(cleanName(owner), cleanName(target), cleanName(item), options);
  } catch (err) { return { ok: false, jealous: false, message: getErrText(err) }; }
}
// 功能：登记主人刚给过 Bot 礼物，用于抑制误吃醋；返回 { ok }。
function noteGiftToBot(options) {
  try {
    if (!emotion || typeof emotion.noteGiftToBot !== "function") return emotionDown();
    return emotion.noteGiftToBot(options);
  } catch (err) { return { ok: false, message: getErrText(err) }; }
}
// 功能：玩家攻击 Bot 的统一决策入口——用既有等级表判定，close_friend / owner 只告状不拔剑。
function onBotAttacked(attacker, options) {
  try {
    var who = cleanName(attacker);
    var opts = options && typeof options === "object" ? options : {};
    var level = cleanName(opts.level) || getLevel(who);
    if (!emotion || typeof emotion.onAttacked !== "function") return emotionDown();
    var payload = { level: level, bot: opts.bot || null, botId: opts.botId || "default",
      ownerPosition: opts.ownerPosition || null, actions: opts.actions || null };
    return emotion.onAttacked(who, payload);
  } catch (err) { return { ok: false, retaliate: true, message: getErrText(err) }; }
}
// 功能：更新当前血量 / 饥饿，供 System Prompt 注入；引擎缺失时静默跳过。
function setBotState(state) {
  try {
    if (!emotion || typeof emotion.setBotState !== "function") return emotionDown();
    return emotion.setBotState(state);
  } catch (err) { return { ok: false, message: getErrText(err) }; }
}
// 功能：生成注入 System Prompt 的情绪段（trustScore / memories / health / food）。
function getEmotionPrompt(options) {
  try {
    if (!emotion || typeof emotion.getPromptAppend !== "function") return "";
    return String(emotion.getPromptAppend(options) || "");
  } catch (err) { return ""; }
}
// 功能：读情感引擎统计，供 GUI / 自测使用；引擎缺失时返回空统计。
function emotionStats() {
  try {
    if (!emotion || typeof emotion.stats !== "function") return emotionDown();
    return emotion.stats();
  } catch (err) { return { ok: false, message: getErrText(err) }; }
}
// 功能：重置情感数据（自测隔离用）；引擎缺失时返回降级体。
function resetEmotion() {
  try {
    if (!emotion || typeof emotion.reset !== "function") return emotionDown();
    return emotion.reset();
  } catch (err) { return { ok: false, message: getErrText(err) }; }
}

// ===== 绝对主人特权薄接线 / absolute owner privilege =====
// 功能：GUI 配置 isOwner=true 的玩家名单读写；模块缺失时全部安全降级。
function isOwner(player) {
  try {
    var op = require("./owner-privilege");
    return typeof op.isOwner === "function" ? op.isOwner(cleanName(player)) : false;
  } catch (e) { return false; }
}
function setOwnerFlag(player, on, options) {
  try {
    var op = require("./owner-privilege");
    if (!op || typeof op.setOwner !== "function") return { ok: false, message: "owner-privilege unavailable / 特权模块不可用" };
    return op.setOwner(cleanName(player), on, options);
  } catch (e) { return { ok: false, message: getErrText(e) }; }
}
function listOwners() {
  try {
    var op = require("./owner-privilege");
    return typeof op.listOwners === "function" ? op.listOwners() : [];
  } catch (e) { return []; }
}
function ownerLabel(player, options) {
  try {
    var op = require("./owner-privilege");
    return typeof op.labelOf === "function" ? op.labelOf(cleanName(player), options) : cleanName(player);
  } catch (e) { return cleanName(player); }
}
function getOwnerPrompt(options) {
  try {
    var op = require("./owner-privilege");
    return typeof op.getPromptAppend === "function" ? String(op.getPromptAppend(options) || "") : "";
  } catch (e) { return ""; }
}
function guardOwnerTrust(player, delta, options) {
  try {
    var op = require("./owner-privilege");
    return typeof op.guardTrustDelta === "function" ? op.guardTrustDelta(cleanName(player), delta, options) : null;
  } catch (e) { return null; }
}
function ownerStats() {
  try {
    var op = require("./owner-privilege");
    return typeof op.stats === "function" ? op.stats() : { ok: false, count: 0 };
  } catch (e) { return { ok: false, count: 0 }; }
}

// 对外导出：读 / 存 / 自动评判开关 / 查等级 / 按行为评判 + 情感信任 2.0 + 绝对主人特权。
module.exports = {
  loadPlayers: loadPlayers,
  savePlayers: savePlayers,
  setAutoJudge: setAutoJudge,
  getLevel: getLevel,
  judgeByBehavior: judgeByBehavior,
  getTrustScore: getTrustScore,
  decayMemories: decayMemories,
  onGiftToOther: onGiftToOther,
  noteGiftToBot: noteGiftToBot,
  onBotAttacked: onBotAttacked,
  setBotState: setBotState,
  getEmotionPrompt: getEmotionPrompt,
  emotionStats: emotionStats,
  resetEmotion: resetEmotion,
  isOwner: isOwner,
  setOwnerFlag: setOwnerFlag,
  listOwners: listOwners,
  ownerLabel: ownerLabel,
  getOwnerPrompt: getOwnerPrompt,
  guardOwnerTrust: guardOwnerTrust,
  ownerStats: ownerStats,
  NO_RETALIATE: NO_RETALIATE
};
