// ========================================
// 文件：modules/mod-detector.js
// 功能：模组探测器——扫区块里的未知方块，去噪后去重交给知识库学习（空气 / 原版方块一律不学）
// 依赖：./logger（可选，失败不崩）、./knowledge-base（可选，失败不崩）、./mod-context（可选，失败不崩）、minecraft-data（可选，失败不崩）
// 导出：startScan / onChunkLoad / onBlockUpdate / scanChunk / shouldSkip / getStats / SKIP_NAMESPACES
// 作者：MineBots
// ========================================

// 可选依赖：日志核心，缺失时所有输出退回 console，绝不抛错。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 可选依赖：模组知识库，缺失时只扫不学，扫描统计照旧。
var knowledgeBase = null;
try { knowledgeBase = require("./knowledge-base"); } catch (e) { knowledgeBase = null; }

// 可选依赖：模组上下文（联网查资料），缺失时跳过学习环节。
var modContext = null;
try { modContext = require("./mod-context"); } catch (e) { modContext = null; }

// 常量：跳过的命名空间（这些是已知的，不用学）。
var SKIP_NAMESPACES = [
  "minecraft",
  "sodium",
  "optifine",
  "iris",
  "shader",
  "sound",
  "fps",
  "performance"
];

// 常量：空气类方块——永远不学（它们只是地形底色，学到纯属噪声 / pure noise）。
var AIR_BLOCKS = { "air": true, "cave_air": true, "void_air": true };

// 常量：原版方块兜底表——拿不到 registry 也拿不到 minecraft-data 时靠它挡最常见的那批（宁缺毋滥）。
var VANILLA_FALLBACK = {
  "stone": true, "granite": true, "diorite": true, "andesite": true, "deepslate": true, "cobblestone": true,
  "dirt": true, "coarse_dirt": true, "rooted_dirt": true, "grass_block": true, "podzol": true, "mycelium": true,
  "farmland": true, "dirt_path": true, "gravel": true, "sand": true, "red_sand": true, "sandstone": true,
  "clay": true, "snow": true, "snow_block": true, "ice": true, "packed_ice": true, "blue_ice": true,
  "water": true, "lava": true, "bedrock": true, "obsidian": true, "netherrack": true, "soul_sand": true,
  "soul_soil": true, "end_stone": true, "torch": true, "wall_torch": true, "soul_torch": true, "lantern": true,
  "oak_log": true, "spruce_log": true, "birch_log": true, "jungle_log": true, "acacia_log": true, "dark_oak_log": true,
  "mangrove_log": true, "cherry_log": true, "oak_planks": true, "oak_leaves": true, "oak_sapling": true, "coal_ore": true,
  "iron_ore": true, "copper_ore": true, "gold_ore": true, "redstone_ore": true, "lapis_ore": true, "diamond_ore": true,
  "emerald_ore": true, "deepslate_coal_ore": true, "deepslate_iron_ore": true, "deepslate_gold_ore": true,
  "deepslate_diamond_ore": true, "crafting_table": true, "furnace": true, "chest": true, "glass": true,
  "short_grass": true, "tall_grass": true, "fern": true, "dandelion": true, "poppy": true, "dead_bush": true,
  "cobweb": true, "vine": true, "cactus": true, "sugar_cane": true, "melon": true, "pumpkin": true,
  "moss_carpet": true, "rail": true, "ladder": true
};

// 常量：方块更新累计阈值——攒够 10 次就清零并重扫一遍（写死，不读配置）。
var BLOCK_UPDATE_THRESHOLD = 10;
// 常量：单次扫描范围——x/z 各 16 格，y 取 8 层，越野车看脚边这么高就够了。
var CHUNK_SPAN_XZ = 16;
var CHUNK_SPAN_Y = 8;

// 内部状态：每个 bot 一个记录 { pending, scanned }，键是机器人编号。
var botStates = {};
// 内部状态：正在查资料的名字表，防止同名字并发重复联网。
var learningNow = {};

// 写日志：优先 logger.system，不可用时退回 console，绝不抛错。
function logLine(msg) {
  try {
    if (logger && typeof logger.system === "function") { logger.system(msg); return true; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[mod-detector] " + msg); } catch (e) { /* 连 console 都没有就算了 */ }
  return true;
}

// 安全提取错误文本，避免在 catch 里再次抛错。
function getErrText(err) {
  try {
    if (err && err.message) return String(err.message);
    return String(err);
  } catch (e) { return "unknown error"; }
}

// 把任意值转成字符串，转换失败返回空串。
function toText(value) {
  try {
    if (value === null || value === undefined) return "";
    return String(value);
  } catch (e) { return ""; }
}

// 常量：区块扫描防抖窗口（毫秒）/ 一拍最多扫几块 / 每个 bot 最多攒几块待扫（超出丢最旧的）。
var CHUNK_DEBOUNCE_MS = 1000;
var CHUNK_BATCH_MAX = 8;
var CHUNK_QUEUE_MAX = 32;

// 状态：待扫区块队列，键为 bot id → { list, timer, bot }（进服瞬间大量区块只排队，不卡主线程）。
var chunkQueues = {};

// 内部：把机器人编号统一成状态表的键，空值退回 "default"。
function stateKey(botId) {
  var key = toText(botId);
  return key.length > 0 ? key : "default";
}

// 内部：取（必要时新建）某个 bot 的状态记录，保证 pending / scanned / failed 都存在。
function ensureState(botId) {
  var key = stateKey(botId);
  if (!botStates[key]) botStates[key] = { pending: 0, scanned: new Set(), failed: new Set() };
  var record = botStates[key];
  try {
    if (!record.scanned || typeof record.scanned.add !== "function") record.scanned = new Set();
    if (!record.failed || typeof record.failed.add !== "function") record.failed = new Set();
    if (typeof record.pending !== "number" || isNaN(record.pending)) record.pending = 0;
  } catch (e) { record.pending = 0; }
  return record;
}

// 内部：把名字记进 failed，返回它是不是第一次失败（同一个方块失败只记一次，绝不刷屏）。
function markFailed(record, name) {
  try {
    if (record.failed.has(name)) return false;
    record.failed.add(name);
    return true;
  } catch (e) { return false; }
}

// 内部：这个方块名本会话是不是已经查失败过（失败过就不再重试，避免死循环联网）。
function hasFailed(botId, name) {
  try { return ensureState(botId).failed.has(name); } catch (e) { return false; }
}

// 内部：把名字记进 scanned，返回它是不是本会话第一次出现。
function markScanned(record, name) {
  try {
    if (record.scanned.has(name)) return false;
    record.scanned.add(name);
    return true;
  } catch (e) { return false; }
}

// 内部：scanned 里已记录的名字数量。
function scannedCount(record) {
  try { return record.scanned.size; } catch (e) { return 0; }
}

// 内部：把相对坐标加到基准位置上，优先用 Vec3.offset，退化时手工相加。
function offsetPos(base, dx, dy, dz) {
  try {
    if (base && typeof base.offset === "function") {
      var moved = base.offset(dx, dy, dz);
      if (moved) return moved;
    }
  } catch (e) { /* 退回手工相加 */ }
  try {
    return { x: Number(base.x) + dx, y: Number(base.y) + dy, z: Number(base.z) + dz };
  } catch (e) { return null; }
}

// 内部：从两个方块里挑一个带坐标的，都挑不到返回 null。
function pickBlock(primary, secondary) {
  try { if (primary && primary.position) return primary; } catch (e) { /* 试备用方块 */ }
  try { if (secondary && secondary.position) return secondary; } catch (e) { /* 都没有 */ }
  return null;
}

// 内部：取区块的基准坐标，缺 position 时返回 null。
function getChunkPosition(chunk) {
  try { if (chunk && chunk.position) return chunk.position; } catch (e) { /* 没有坐标 */ }
  return null;
}

// 内部：读一个坐标上的方块名，读不到（空气 / 越界 / 没这接口）返回空串。
function readBlockName(bot, pos) {
  if (!pos) return "";
  try {
    var block = bot.blockAt(pos);
    if (block && block.name) return toText(block.name);
    return "";
  } catch (e) { return ""; }
}

// 功能 1：启动扫描——给这个 bot 建状态记录，写启动日志，成功返回 true。
function startScan(bot, botId) {
  var key = stateKey(botId);
  try {
    if (!bot) { logLine("[" + key + "] mod-detector 启动失败：没有 bot 实例"); return false; }
    // 重连时先把上一轮的防抖定时器与队列清掉，避免旧定时器继续拖着进程。
    try { stopScan(botId); } catch (e0) { /* ignore */ }
    botStates[key] = { pending: 0, scanned: new Set(), failed: new Set() }; // 失败表也一起建：接口字段齐全，不用等 ensureState 补
    logLine("[" + key + "] mod-detector 启动");
    return true;
  } catch (e) {
    logLine("[" + key + "] mod-detector 启动失败: " + getErrText(e));
    return false;
  }
}

// 内部：取（必要时新建）某个 bot 的待扫队列。
function queueOf(key) {
  if (!chunkQueues[key]) chunkQueues[key] = { list: [], timer: null, bot: null };
  return chunkQueues[key];
}

// 内部：扫一块区块并记账，返回这一块新增的名字数量（异常时返回 0）。
function scanOne(bot, botId, chunk) {
  try {
    var record = ensureState(botId);
    var names = scanChunk(bot, botId, chunk);
    var fresh = 0;
    for (var i = 0; i < names.length; i++) if (markScanned(record, names[i])) fresh++;
    return fresh;
  } catch (e) { return 0; }
}

// 内部：把队列里的一批区块扫掉（一拍最多 CHUNK_BATCH_MAX 块），还剩就约下一拍；返回这一拍扫了几块。
function flushQueue(key) {
  try {
    var queue = chunkQueues[key];
    if (!queue) return 0;
    queue.timer = null;
    var scanned = 0;
    while (queue.list.length > 0 && scanned < CHUNK_BATCH_MAX) {
      var chunk = queue.list.shift();
      scanned++;
      try { scanOne(queue.bot, key, chunk); } catch (e1) { /* 单块失败不影响后面 */ }
    }
    if (queue.list.length > 0) {
      queue.timer = setTimeout(function () { flushQueue(key); }, CHUNK_DEBOUNCE_MS);
      if (queue.timer && queue.timer.unref) queue.timer.unref();
    }
    return scanned;
  } catch (e) { return 0; }
}

// 功能 1b：停止扫描——清掉这个 bot 的防抖定时器与待扫队列（bot 断开 / 停止时必须调）。
function stopScan(botId) {
  try {
    var key = stateKey(botId);
    var queue = chunkQueues[key];
    if (!queue) return true;
    if (queue.timer) { try { clearTimeout(queue.timer); } catch (e1) { /* ignore */ } }
    queue.timer = null;
    queue.list = [];
    queue.bot = null;
    delete chunkQueues[key];
    return true;
  } catch (e) { return false; }
}

// 功能 2：区块加载时扫描——第一块立刻扫，紧接着涌进来的一批进队列防抖，返回本次新名字数量。
function onChunkLoad(bot, botId, chunk) {
  try {
    var key = stateKey(botId);
    var queue = queueOf(key);
    if (bot) queue.bot = bot;
    // 单块加载：立刻扫（保持「进服马上学到方块」的体验），同时打开一个防抖窗口。
    if (queue.list.length === 0 && !queue.timer) {
      var fresh = scanOne(bot || queue.bot, botId, chunk);
      queue.timer = setTimeout(function () { flushQueue(key); }, CHUNK_DEBOUNCE_MS);
      if (queue.timer && queue.timer.unref) queue.timer.unref();
      return fresh;
    }
    // 窗口内又来了区块：只排队，等窗口结束一次扫一批（同时加载大量区块也不卡死）。
    if (queue.list.length >= CHUNK_QUEUE_MAX) queue.list.shift();
    queue.list.push(chunk);
    return 0;
  } catch (e) { return 0; }
}

// 功能 3：方块更新累计扫描——pending 累加，够阈值就清零并重扫一遍，返回是否触发了重扫。
function onBlockUpdate(bot, botId, oldBlock, newBlock) {
  var record = ensureState(botId);
  try { record.pending = (Number(record.pending) || 0) + 1; } catch (e) { record.pending = 0; }
  if (record.pending < BLOCK_UPDATE_THRESHOLD) return false;
  record.pending = 0;
  var anchor = pickBlock(newBlock, oldBlock);
  if (!anchor) return false;
  onChunkLoad(bot, botId, { position: anchor.position });
  return true;
}

// 功能 4：扫一个区块——遍历 x/z 各 16 格、y 8 层，收集不认识的方块名（已去重）并交给知识库。
function scanChunk(bot, botId, chunk) {
  var found = [];
  var origin = getChunkPosition(chunk);
  if (!origin) return found;
  try { if (!bot || typeof bot.blockAt !== "function") return found; } catch (e) { return found; }
  var seen = {};
  for (var x = 0; x < CHUNK_SPAN_XZ; x++) {
    for (var z = 0; z < CHUNK_SPAN_XZ; z++) {
      for (var y = 0; y < CHUNK_SPAN_Y; y++) {
        var name = readBlockName(bot, offsetPos(origin, x, y, z));
        if (name.length === 0 || shouldSkip(name, bot)) continue;
        if (seen[name]) continue;
        seen[name] = true;
        found.push(name);
        learnName(name, bot, botId);
      }
    }
  }
  return found;
}

// 内部：把一个名字交给知识库——学过的跳过，没学过的查上下文后存起来，全程不抛错。
function learnName(name, bot, botId) {
  var known = null;
  try { if (knowledgeBase && typeof knowledgeBase.find === "function") known = knowledgeBase.find(name); }
  catch (e) { known = null; }
  if (known) return false;
  if (hasFailed(botId, name)) return false; // 认不出就别死循环：同一个方块失败一次就记下来，不再重试
  if (learningNow[name]) return false;
  learningNow[name] = true;
  try {
    if (!modContext || typeof modContext.getContext !== "function") { learningNow[name] = false; return false; }
    var pending = modContext.getContext(name, bot);
    if (!pending || typeof pending.then !== "function") { learningNow[name] = false; return false; }
    pending.then(function (ctx) { saveContext(name, ctx, botId); }).catch(function (err) {
      if (markFailed(ensureState(botId), name)) logLine("[" + stateKey(botId) + "] 查询失败 " + name + ": " + getErrText(err));
    });
    return true;
  } catch (e) {
    learningNow[name] = false;
    if (markFailed(ensureState(botId), name)) logLine("[" + stateKey(botId) + "] 查询异常 " + name + ": " + getErrText(e));
    return false;
  }
}

// 内部：把查到的上下文写进知识库，失败只记日志、绝不抛错。
function saveContext(name, ctx, botId) {
  learningNow[name] = false;
  if (!ctx) return false;
  try {
    if (!knowledgeBase || typeof knowledgeBase.save !== "function") return false;
    var result = knowledgeBase.save(name, ctx);
    if (result && result.ok === false) {
      if (markFailed(ensureState(botId), name)) logLine("[" + stateKey(botId) + "] 保存失败 " + name + ": " + toText(result.error));
      return false;
    }
    logLine("[" + stateKey(botId) + "] 学到新方块 " + name);
    return true;
  } catch (e) {
    if (markFailed(ensureState(botId), name)) logLine("[" + stateKey(botId) + "] 保存异常 " + name + ": " + getErrText(e));
    return false;
  }
}

// 内部状态：原版方块名缓存 { key, names }，key 是版本号，避免每次扫描都重建整张表。
var vanillaCache = { key: null, names: null };

// 内部：从 minecraft-data 取某个版本的原版方块表，取不到返回 null（只读一次，按版本缓存）。
function vanillaFromData(version) {
  var ver = toText(version);
  if (ver.length === 0) return null;
  if (vanillaCache.key === ver) return vanillaCache.names;
  var names = null;
  try {
    var mcData = require("minecraft-data");
    var data = mcData(ver);
    if (data && data.blocksByName) names = data.blocksByName;
  } catch (e) { names = null; }
  vanillaCache.key = ver;
  vanillaCache.names = names;
  return names;
}

// 内部：判断名字是不是原版方块——registry → minecraft-data → 兜底表三级判定，都不中就当未知（返回 false）。
function isVanillaName(name, bot) {
  try {
    var registry = bot ? bot.registry : null;
    if (registry && registry.blocksByName && registry.blocksByName[name]) return true;
    var data = vanillaFromData(bot ? bot.version : "");
    if (data && data[name]) return true;
  } catch (e) { /* 都拿不到就只看兜底表 */ }
  return VANILLA_FALLBACK[name] === true;
}

// 功能 5：判断是否跳过——空名 / 空气 / minecraft: / 优化模组 / 原版方块都跳过，只有模组命名空间与真未知方块放行。
function shouldSkip(name, bot) {
  var text = toText(name).toLowerCase();
  if (text.length === 0) return true;
  try {
    var cut = text.indexOf(":");
    var ns = cut >= 0 ? text.slice(0, cut) : "";
    var bare = cut >= 0 ? text.slice(cut + 1) : text;
    if (AIR_BLOCKS[bare] === true) return true;                    // 空气三兄弟：永远不学
    for (var i = 0; i < SKIP_NAMESPACES.length; i++) {             // 优化 / 光影类命名空间：不学
      if (ns === SKIP_NAMESPACES[i] || text.indexOf(SKIP_NAMESPACES[i]) >= 0) return true;
    }
    if (ns.length > 0) return false;                              // 带模组命名空间（create: / botania:）：正是要学的
    return isVanillaName(bare, bot);                              // 没命名空间：原版跳过，认不出才学
  } catch (e) { return true; }
}

// 功能 6：获取扫描统计——返回 { pending, scannedCount, failedCount }，没有记录就是全 0。
function getStats(botId) {
  try {
    var record = ensureState(botId);
    var failedCount = 0;
    try { failedCount = record.failed.size; } catch (e) { failedCount = 0; }
    return { pending: Number(record.pending) || 0, scannedCount: scannedCount(record), failedCount: failedCount };
  } catch (e) {
    return { pending: 0, scannedCount: 0, failedCount: 0 };
  }
}

module.exports = {
  startScan: startScan,
  stopScan: stopScan,
  onChunkLoad: onChunkLoad,
  onBlockUpdate: onBlockUpdate,
  scanChunk: scanChunk,
  shouldSkip: shouldSkip,
  getStats: getStats,
  DEBOUNCE_MS: CHUNK_DEBOUNCE_MS,
  SKIP_NAMESPACES: SKIP_NAMESPACES
};
