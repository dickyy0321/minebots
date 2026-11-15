// ========================================
// 文件：modules/bot-scan.js
// 功能：方块扫描——找最近的木头 / 矿石：先试 bot.findBlock，失败或结果为空就自己按半径逐格扫
// 依赖：无（只用 bot 的 blockAt / findBlock，全部 try/catch）
// 导出：findNearestBlock / scanNearestBlock / SCAN_RADIUS_LIMIT
// 作者：MineBots
// ========================================
//
// 为什么要单独一层：
//   扫描是「三重大循环」，最容易把主线程拖住，也最容易写崩；收成独立文件后可以单独限半径、
//   单独自测，command-handler 只负责「用最近的方块做动作」。
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

// 常量：兜底扫描的半径上限（防三重大循环卡死主线程）。
var SCAN_RADIUS_LIMIT = 8;

// 安全取自己的坐标：取不到返回 null。
function selfPos(bot) {
  try { if (bot && bot.entity && bot.entity.position) return bot.entity.position; } catch (e) { /* 拿不到就当没有 */ }
  return null;
}

// 安全取方块：越界 / 区块没加载都返回 null。
function blockAtSafe(bot, pos) {
  try { if (bot && typeof bot.blockAt === "function" && pos) return bot.blockAt(pos); } catch (e) { return null; }
  return null;
}

// 两点距离：算不出来返回 Infinity（等于够不到，会被过滤掉）。
function distanceBetween(from, to) {
  try {
    if (!from || !to) return Infinity;
    if (typeof from.distanceTo === "function") return from.distanceTo(to);
    var dx = Number(to.x) - Number(from.x);
    var dy = Number(to.y) - Number(from.y);
    var dz = Number(to.z) - Number(from.z);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  } catch (e) { return Infinity; }
}

// 兜底扫描：按半径逐格找（区块没加载 / blockAt 返回 null 会自动跳过），返回最近的方块或 null。
function scanNearestBlock(bot, matcher, maxDistance) {
  var base = selfPos(bot);
  if (!base) return null;
  var limit = Math.min(Math.max(Number(maxDistance) || 0, 1), SCAN_RADIUS_LIMIT);
  var best = null, bestDistance = Infinity;
  for (var dx = -limit; dx <= limit; dx++) {
    for (var dy = -4; dy <= 12; dy++) {
      for (var dz = -limit; dz <= limit; dz++) {
        var pos = null;
        try { pos = base.offset(dx, dy, dz); } catch (e) { pos = null; }
        if (!pos) continue;
        var block = blockAtSafe(bot, pos);
        if (!block || !matcher(block)) continue;
        var distance = distanceBetween(base, pos);
        if (distance < bestDistance) { bestDistance = distance; best = block; }
      }
    }
  }
  return best;
}

// 找最近的符合条件方块：先试 bot.findBlock，失败 / 结果为空就自己扫；永远返回方块或 null。
function findNearestBlock(bot, matcher, maxDistance) {
  try {
    if (bot && typeof bot.findBlock === "function") {
      var found = bot.findBlock({ matching: matcher, maxDistance: maxDistance });
      if (found) return found;
    }
  } catch (e) { /* 插件式查找失败就改用扫描 */ }
  return scanNearestBlock(bot, matcher, maxDistance);
}

// 对外导出：两个查找入口 + 半径上限。
module.exports = {
  findNearestBlock: findNearestBlock,
  scanNearestBlock: scanNearestBlock,
  SCAN_RADIUS_LIMIT: SCAN_RADIUS_LIMIT
};
