// ========================================
// 文件：modules/bot-status-reader.js
// 功能：从 bot 记录里安全读取状态量（血量 / 饥饿 / 坐标 / 维度 / 背包），真 bot 与测试模式通用。
// 依赖：./mod-guard（可选，缺失时模组物品只贴「未知」标签）
// 导出：readHealth / readFood / readPosition / readDimension / readInventory
// 作者：MineBots
// ========================================

// 可选依赖：模组识别兜底，缺失时陌生物品只贴原名，绝不抛错。
var modGuard = null;
try { modGuard = require("./mod-guard"); } catch (e) { modGuard = null; }

// 读取 bot 血量：测试模式读模拟世界，真 bot 读 bot.health，失败回退 0。
function readHealth(rec) {
  if (rec.fake) {
    try { if (rec.world && typeof rec.world.health === "number") return rec.world.health; } catch (e) { /* 回退 */ }
    return 20;
  }
  try { if (rec.bot && typeof rec.bot.health === "number") return rec.bot.health; } catch (e) { /* 回退 */ }
  return 0;
}

// 读取 bot 饥饿值：测试模式读模拟世界，真 bot 读 bot.food，失败回退 0。
function readFood(rec) {
  if (rec.fake) {
    try { if (rec.world && typeof rec.world.food === "number") return rec.world.food; } catch (e) { /* 回退 */ }
    return 20;
  }
  try { if (rec.bot && typeof rec.bot.food === "number") return rec.bot.food; } catch (e) { /* 回退 */ }
  return 0;
}

// 读取 bot 坐标：测试模式读模拟世界，真 bot 读实体坐标并向下取整。
function readPosition(rec) {
  if (rec.fake) {
    try {
      if (rec.world && rec.world.position) return { x: Math.floor(rec.world.position.x), y: Math.floor(rec.world.position.y), z: Math.floor(rec.world.position.z) };
    } catch (e) { /* 回退 */ }
    return { x: 0, y: 64, z: 0 };
  }
  try {
    var p = rec.bot && rec.bot.entity ? rec.bot.entity.position : null;
    if (p) return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
  } catch (e) { /* 回退 */ }
  return { x: 0, y: 0, z: 0 };
}

// 读取 bot 所在维度：测试模式读模拟世界，真 bot 读 bot.game.dimension。
function readDimension(rec) {
  if (rec.fake) {
    try { if (rec.world && rec.world.dimension) return String(rec.world.dimension); } catch (e) { /* 回退 */ }
    return "overworld";
  }
  try { if (rec.bot && rec.bot.game && rec.bot.game.dimension) return String(rec.bot.game.dimension); } catch (e) { /* 回退 */ }
  return "";
}

// 读取 bot 背包快照：测试模式读模拟背包，真 bot 读 bot.inventory.items()，失败回退空数组。
function readInventory(rec) {
  try {
    if (rec.fake) return (rec.world && rec.world.inventory) ? rec.world.inventory.slice(0) : [];
    if (rec.bot && rec.bot.inventory && typeof rec.bot.inventory.items === "function") {
      var items = rec.bot.inventory.items(); var out = [];
      for (var i = 0; i < items.length; i++) {
        var label = items[i].name;
        // 模组物品认不出时只贴「未知模组物品」标签，绝不因为陌生名字抛异常。
        try { if (modGuard && typeof modGuard.itemLabel === "function") label = modGuard.itemLabel(rec.bot, items[i].name); } catch (eL) { label = items[i].name; }
        out.push({ name: items[i].name, count: items[i].count, label: label });
      }
      return out;
    }
  } catch (e) { /* 回退空数组 */ }
  return [];
}

// 对外导出：五个只读状态读取器，仅供 bot-manager 的 listBots 调用。
module.exports = {
  readHealth: readHealth, readFood: readFood, readPosition: readPosition,
  readDimension: readDimension, readInventory: readInventory
};
