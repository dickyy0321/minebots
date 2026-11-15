// ========================================
// 文件：modules/pathfinding.js
// 功能：寻路封装——插件加载 / Movements 分级 / 模组方块开天眼 / 走点 / 停止；缺插件时自动退化，绝不抛错
// 依赖：mineflayer-pathfinder（可选）、vec3（可选）、./logger（可选）
// 导出：setup / arm / goTo / stop / setLevel / openModBlocks / isModName
// 作者：MineBots
// ========================================

// 可选依赖：官方寻路插件；未安装时 goTo 走「朝目标步进」的退化实现。
var pfLib = null;
try { pfLib = require("mineflayer-pathfinder"); } catch (err) { pfLib = null; }
// 可选依赖：vec3，退化模式里给 lookAt 提供坐标对象。
var vecLib = null;
try { vecLib = require("vec3"); } catch (err) { vecLib = null; }
// 可选依赖：日志模块，只用 info（只落文件，不推 GUI）。
var logger = null;
try { logger = require("./logger"); } catch (err) { logger = null; }

// 常量：goTo 默认超时，与 task-queue 单任务 10 秒上限对齐。
var DEFAULT_TIMEOUT_MS = 10000;
// 常量：到达判定与轮询间隔（毫秒）——1 秒盯一次到位就够，250ms 纯属空转烧 CPU。
var ARRIVE_DISTANCE = 1.6;
var POLL_MS = 1000;
// 常量：算力护栏——A* 最多搜多少节点 / 单次思考最多几毫秒 / 搜索半径上限（超预算立刻放弃或走直线）。
var MAX_PATH_NODES = 8000;
var THINK_TIMEOUT_MS = 3000;
var MAX_SEARCH_RADIUS = 48;
// 常量：默认等级名，setup 之后生效。
var DEFAULT_LEVEL = "medium";

// 等级表：levels 越高路径越聪明但越吃 CPU；smart 允许挖方块换取更短路径。
var LEVELS = {
  low: { allowSprinting: false, allowParkour: false, canDig: false, maxDropDown: 2, digCost: 1 },
  medium: { allowSprinting: true, allowParkour: true, canDig: false, maxDropDown: 3, digCost: 35 },
  high: { allowSprinting: true, allowParkour: true, canDig: true, maxDropDown: 4, digCost: 12 },
  smart: { allowSprinting: true, allowParkour: true, canDig: true, maxDropDown: 4, digCost: 6 }
};

// 写普通信息日志：只落文件，缺 logger 时静默。
function logInfo(message) {
  try {
    if (logger && typeof logger.info === "function") logger.info(message);
  } catch (err) { /* ignore */ }
}

// 写警告日志（双语），缺 logger 时退回 console。
function logWarn(message) {
  try {
    if (logger && typeof logger.warn === "function") logger.warn(message);
    else console.warn(message);
  } catch (err) { /* ignore */ }
}

// 把异常对象拍成一行文本，避免日志里出现 undefined。
function errText(err) {
  try {
    if (!err) return "unknown error / 未知错误";
    if (typeof err === "string") return err;
    if (err.message) return String(err.message);
    return String(err);
  } catch (e) { return "unknown error / 未知错误"; }
}

// 统一的「机器人未就绪」返回体。
function notReady(action) {
  var msg = "bot not ready / 机器人未就绪";
  logWarn("[pathfinding] " + action + " -> " + msg);
  return { ok: false, action: action, code: "BOT_NOT_READY", message: msg };
}

// 统一的「执行失败」返回体。
function failure(action, err) {
  var msg = "failed / 执行失败: " + errText(err);
  logWarn("[pathfinding] " + action + " -> " + msg);
  return { ok: false, action: action, code: "FAILED", message: msg };
}

// 把三个坐标转成整数对象；任一非法返回 null。
function num3(x, y, z) {
  var vx = Math.floor(Number(x));
  var vy = Math.floor(Number(y));
  var vz = Math.floor(Number(z));
  if (isNaN(vx) || isNaN(vy) || isNaN(vz)) return null;
  return { x: vx, y: vy, z: vz };
}

// 计算 bot 与目标点的水平距离平方；坐标缺失返回 -1 表示「无法判断」。
function distSq(bot, x, y, z) {
  try {
    var p = bot && bot.entity && bot.entity.position ? bot.entity.position : null;
    if (!p) return -1;
    var dx = Number(p.x) - Number(x);
    var dz = Number(p.z) - Number(z);
    if (isNaN(dx) || isNaN(dz)) return -1;
    return dx * dx + dz * dz;
  } catch (err) { return -1; }
}

// 判断寻路插件是否可用：必须能 require 到且带 pathfinder 与 goals。
function available() {
  try {
    if (!pfLib) return false;
    if (!pfLib.pathfinder) return false;
    if (!pfLib.goals || typeof pfLib.goals.GoalBlock !== "function") return false;
    return true;
  } catch (err) { return false; }
}

// 清掉退化模式的定时器并松开移动键，避免机器人一直往前冲。
// 清掉退化步进的定时器：有定时器才说明按过前进键，这时才顺手松开控制键（别多发一次清空）。
function clearFallbackTimer(bot) {
  try {
    if (!bot) return;
    var t = bot._mbFallbackTimer;
    if (!t) return;
    try { clearInterval(t); } catch (e1) { /* ignore */ }
    bot._mbFallbackTimer = null;
    if (typeof bot.clearControlStates === "function") bot.clearControlStates();
  } catch (err) { /* ignore */ }
}
// 给寻路插件套上算力上限（思考时间 / 搜索半径）：插件没有这两个字段就静默跳过，返回是否写到。
function applyLimits(bot) {
  try {
    if (!bot || !bot.pathfinder) return false;
    var ok = false;
    try { bot.pathfinder.thinkTimeout = THINK_TIMEOUT_MS; ok = true; } catch (e1) { /* ignore */ }
    try { bot.pathfinder.searchRadius = MAX_SEARCH_RADIUS; ok = true; } catch (e2) { /* ignore */ }
    return ok;
  } catch (err) { return false; }
}

// 常量：模组方块兜底硬度——注册表给 -1（不可破坏）或离谱大值时按这个算，保证能挖得穿。
var MOD_BLOCK_HARDNESS = 1.2;
// 常量：模组「木头类」方块名关键词（模组树是卡死重灾区，这些一定要能挖穿）。
var MOD_WOOD_HINTS = ["log", "wood", "tree", "leaves", "plank", "bamboo", "vine", "stem", "branch"];
// 常量：按状态 id 兜底扫 registry.blocks 时的上限（防死循环，正常版本远小于它）。
var MAX_BLOCK_STATES = 8192;

// 判断方块名是不是模组方块：有命名空间且不是 minecraft。
function isModName(name) {
  try {
    var text = name ? String(name).toLowerCase() : "";
    var cut = text.indexOf(":");
    if (cut <= 0) return false;
    return text.slice(0, cut) !== "minecraft";
  } catch (err) { return false; }
}

// 遍历注册表里的所有方块定义：优先 blocksArray，其次 blocksByName，最后按状态 id 扫 registry.blocks（有上限）。
function visitAll(registry, visit) {
  var count = 0;
  try {
    if (!registry || typeof visit !== "function") return 0;
    var list = registry.blocksArray;
    if (list && typeof list.length === "number" && list.length > 0) {
      for (var i = 0; i < list.length; i++) { if (visit(list[i]) === true) count = count + 1; }
      return count;
    }
    var byName = registry.blocksByName;
    if (byName) {
      var keys = Object.keys(byName);
      for (var k = 0; k < keys.length; k++) { if (visit(byName[keys[k]]) === true) count = count + 1; }
      return count;
    }
    var states = registry.blocks;
    for (var s = 0; s < MAX_BLOCK_STATES; s++) {
      var block = null;
      try { block = states[s]; } catch (e1) { block = null; }
      if (!block) break;
      if (visit(block) === true) count = count + 1;
    }
  } catch (err) { return count; }
  return count;
}

// 开天眼：把模组方块的物理属性摊平（可挖穿 + 硬度封顶），返回被修正的块数。
// 为什么要它：模组方块经常带着 -1 硬度 / 奇怪 boundingBox 进注册表，A* 会把整片模组地形当墙，
// 机器人就原地磨蹭；标记成可挖后「绕不过就挖过去」，模组树不再是无解屏障。
function openModBlocks(bot, moves) {
  var patched = 0;
  var woods = 0;
  try {
    var registry = bot ? bot.registry : null;
    if (!registry) return 0;
    var visit = function (block) {
      try {
        if (!block) return false;
        var name = block.name ? String(block.name) : "";
        if (!isModName(name)) return false;
        if (block._mbOpened === true) return false; // 同一份注册表只修一次（会缓存复用）
        try { block.diggable = true; } catch (e1) { /* ignore */ }
        var hard = Number(block.hardness);
        if (isNaN(hard) || hard < 0 || hard > 50) {
          try { block.hardness = MOD_BLOCK_HARDNESS; } catch (e2) { /* ignore */ }
        }
        var lower = name.toLowerCase();
        for (var i = 0; i < MOD_WOOD_HINTS.length; i++) {
          if (lower.indexOf(MOD_WOOD_HINTS[i]) >= 0) {
            woods = woods + 1;
            try { if (Number(block.hardness) > 1.5) block.hardness = 1.5; } catch (e3) { /* ignore */ }
            break;
          }
        }
        try { block._mbOpened = true; } catch (e4) { /* 标记失败下轮再修，不影响正确性 */ }
        patched = patched + 1;
        return true;
      } catch (e0) { return false; }
    };
    visitAll(registry, visit);
    // 有模组方块就把挖掘代价压到合理区间：等级表里的 digCost 太离谱时不至于永远不肯挖。
    if (patched > 0 && moves) {
      try { if (!(Number(moves.digCost) > 0)) moves.digCost = 20; } catch (e5) { /* ignore */ }
    }
    if (patched > 0) logInfo("[pathfinding] 模组方块开天眼 / mod blocks opened: " + patched + " (wood " + woods + ")");
  } catch (err) {
    logWarn("[pathfinding] 模组方块处理失败 / mod block patch failed: " + errText(err));
  }
  return patched;
}

// 挂 movements：先开天眼再交给插件（顺序反了 A* 还是会把模组地形当墙）；返回是否挂上。
function applyMovements(bot, moves) {
  var ok = false;
  try {
    if (!bot || !moves) return false;
    var patched = openModBlocks(bot, moves);
    // 摊平过模组方块才打开 canDig：否则「模组树 / 模组实心方块」依然是无解屏障（只有真需要时才挖）。
    try { if (patched > 0) moves.canDig = true; } catch (e1) { /* ignore */ }
    if (bot.pathfinder && typeof bot.pathfinder.setMovements === "function") {
      bot.pathfinder.setMovements(moves);
      ok = true;
    }
  } catch (err) { logWarn("[pathfinding] 挂 movements 失败 / setMovements failed: " + errText(err)); }
  return ok;
}

// 监听 A* 的节点数，超预算就回调一次（调用方负责停下改走直线）；拿不到事件时返回 null。
function watchNodes(bot, onExceed) {
  var handler = null;
  try {
    if (!bot || typeof bot.on !== "function") return null;
    handler = function (report) {
      var used = 0;
      try { used = Number(report && report.nodes) || 0; } catch (e1) { used = 0; }
      if (used <= MAX_PATH_NODES) return;
      try { if (typeof onExceed === "function") onExceed(used); } catch (e2) { /* 回调失败只是这次没放弃 */ }
    };
    bot.on("path_update", handler);
  } catch (err) { return null; }
  return function detach() {
    try { if (typeof bot.removeListener === "function") bot.removeListener("path_update", handler); } catch (e3) { /* ignore */ }
    return true;
  };
}

// 摘掉节点监听（换目标 / 停止 / 断开时都要调），返回是否真的摘掉。
function detachNodeWatch(bot) {
  try {
    if (!bot || typeof bot._mbNodeDetach !== "function") return false;
    var fn = bot._mbNodeDetach;
    bot._mbNodeDetach = null;
    fn();
    return true;
  } catch (err) { return false; }
}

// 把等级表应用到 bot 的 movements 上（不合法等级回默认），返回 { ok, level } 或失败体。
function applyLevel(bot, level) {
  try {
    if (!bot) return notReady("setLevel");
    var name = LEVELS[level] ? String(level) : DEFAULT_LEVEL;
    var preset = LEVELS[name];
    var moves = bot._mbMoves || null;
    if (!moves && bot.pathfinder && typeof bot.pathfinder.getMovements === "function") {
      moves = bot.pathfinder.getMovements();
    }
    if (!moves && pfLib && typeof pfLib.Movements === "function") {
      try { moves = new pfLib.Movements(bot); } catch (e1) { moves = null; }
    }
    if (!moves) {
      return { ok: false, action: "setLevel", level: name, message: "movements unavailable / 寻路参数不可用" };
    }
    try { moves.allowSprinting = preset.allowSprinting; } catch (e2) { /* ignore */ }
    try { moves.allowParkour = preset.allowParkour; } catch (e3) { /* ignore */ }
    try { moves.canDig = preset.canDig; } catch (e4) { /* ignore */ }
    try { moves.maxDropDown = preset.maxDropDown; } catch (e5) { /* ignore */ }
    try { moves.digCost = preset.digCost; } catch (e6) { /* ignore */ }
    bot._mbMoves = moves;
    bot._mbLevel = name;
    applyMovements(bot, moves);
    logInfo("[pathfinding] level -> " + name + " / 寻路等级已切换");
    return { ok: true, action: "setLevel", level: name };
  } catch (err) { return failure("setLevel", err); }
}

// 加载寻路插件并设置 Movements（允许疾跑 / 允许跑酷 / 禁止挖方块）；已加载时只重设参数。
function setup(bot) {
  try {
    if (!bot) return notReady("setup");
    if (!available()) {
      var missMsg = "mineflayer-pathfinder not installed / 未安装寻路插件";
      logWarn("[pathfinding] setup -> " + missMsg);
      return { ok: false, action: "setup", available: false, message: missMsg };
    }
    if (!bot.pathfinder) {
      if (typeof bot.loadPlugin !== "function") {
        return { ok: false, action: "setup", available: false, message: "loadPlugin unavailable / 无法加载插件" };
      }
      bot.loadPlugin(pfLib.pathfinder);
    }
    var moves = null;
    if (bot.pathfinder && typeof bot.pathfinder.getMovements === "function") {
      moves = bot.pathfinder.getMovements();
    }
    if (!moves) {
      try { moves = new pfLib.Movements(bot); } catch (e1) { moves = null; }
    }
    if (!moves) {
      return { ok: false, action: "setup", available: false, message: "movements unavailable / 寻路参数不可用" };
    }
    try { moves.allowSprinting = true; } catch (e2) { /* ignore */ }
    try { moves.allowParkour = true; } catch (e3) { /* ignore */ }
    try { moves.canDig = false; } catch (e4) { /* ignore */ }
    bot._mbMoves = moves;
    bot._mbLevel = DEFAULT_LEVEL;
    // 开天眼 + 挂 movements：模组方块在挂之前就摊平，A* 才不会把模组地形当墙。
    applyMovements(bot, moves);
    // 算力护栏：思考限时 + 搜索半径封顶，防止复杂地形把 CPU 拉满。
    try { applyLimits(bot); } catch (e5b) { /* ignore */ }
    logInfo("[pathfinding] setup ok / 寻路已就绪: " + (bot.username ? String(bot.username) : "bot"));
    return { ok: true, action: "setup", available: true, level: DEFAULT_LEVEL };
  } catch (err) { return failure("setup", err); }
}
// 复位寻路插件内部的「已停止」闸门并确保 movements 已挂上；失败返回 ok=false，绝不抛错。
// 为什么必须有它：mineflayer-pathfinder 的 stop() 只是把内部 stopPathing 置真，
// 下一次 setGoal 会走 resetPath 里的 if (stopPathing) return stop()，新目标被当场抹掉 ——
// 外部表现就是「指令收到了、机器人一动不动」。setMovements 会走一遍 resetPath，把闸门复位。
function arm(bot) {
  try {
    if (!bot) return notReady("arm");
    if (!bot.pathfinder || typeof bot.pathfinder.setMovements !== "function") {
      return { ok: false, action: "arm", available: false, message: "pathfinder unavailable / 寻路插件不可用" };
    }
    var moves = bot._mbMoves || null;
    if (!moves && typeof bot.pathfinder.getMovements === "function") {
      moves = bot.pathfinder.getMovements();
    }
    if (!moves && pfLib && typeof pfLib.Movements === "function") {
      try { moves = new pfLib.Movements(bot); } catch (e1) { moves = null; }
    }
    if (!moves) {
      return { ok: false, action: "arm", available: false, message: "movements unavailable / 寻路参数不可用" };
    }
    bot._mbMoves = moves;
    applyMovements(bot, moves);
    return { ok: true, action: "arm" };
  } catch (err) { return failure("arm", err); }
}

// 走到指定坐标：有插件走 GoalBlock，无插件走退化步进；永远 resolve，不会 reject。
function goTo(bot, x, y, z, timeout) {
  return new Promise(function (resolve) {
    var finished = false;
    var timer = null;
    var poll = null;
    var usingFallback = false;
    var detachBudget = null;
    var abortFn = null;

    // 收敛出口：清掉所有定时器与节点监听后只 resolve 一次。
    function finish(result) {
      if (finished) return;
      finished = true;
      try { if (poll) clearInterval(poll); } catch (e1) { /* ignore */ }
      try { if (timer) clearTimeout(timer); } catch (e2) { /* ignore */ }
      try { clearFallbackTimer(bot); } catch (e3) { /* ignore */ }
      // 收尾必须摘掉 A* 节点监听，否则每换一次目标就多挂一个回调。
      try { if (typeof detachBudget === "function") detachBudget(); } catch (e3b) { /* ignore */ }
      detachBudget = null;
      try { bot._mbNodeDetach = null; } catch (e3c) { /* ignore */ }
      // 自己的中止入口自己摘掉，别把后来的寻路一起废掉。
      try { if (abortFn && bot && bot._mbGoToAbort === abortFn) bot._mbGoToAbort = null; } catch (e3d) { /* ignore */ }
      resolve(result);
    }

    try {
      if (!bot) { finish(notReady("goTo")); return; }
      var target = num3(x, y, z);
      if (!target) {
        finish({ ok: false, action: "goTo", code: "BAD_PARAM", message: "bad target / 目标坐标非法" });
        return;
      }
      var ms = Number(timeout);
      if (isNaN(ms) || ms <= 0) ms = DEFAULT_TIMEOUT_MS;
      // 登记中止入口：外部 stop() 能立刻打断这次寻路，不用干等超时（「停不下来」的病根之一）。
      abortFn = function () {
        finish({
          ok: false, action: "goTo", target: target, code: "ABORTED",
          mode: usingFallback ? "fallback" : "pathfinder",
          message: "stopped / 已被停止"
        });
      };
      try { bot._mbGoToAbort = abortFn; } catch (e9) { abortFn = null; }
      var near = distSq(bot, target.x, target.y, target.z);
      if (near >= 0 && near <= ARRIVE_DISTANCE * ARRIVE_DISTANCE) {
        finish({ ok: true, action: "goTo", target: target, mode: "already", message: "already there / 已在该位置" });
        return;
      }
      timer = setTimeout(function () {
        try {
          if (bot.pathfinder && typeof bot.pathfinder.stop === "function") bot.pathfinder.stop();
        } catch (e4) { /* ignore */ }
        finish({
          ok: false, action: "goTo", target: target, code: "TIMEOUT",
          mode: usingFallback ? "fallback" : "pathfinder",
          message: "timeout / 寻路超时"
        });
      }, ms);
      if (timer && timer.unref) timer.unref();

      if (!available() || !bot.pathfinder || typeof bot.pathfinder.setGoal !== "function") {
        usingFallback = true;
        fallbackWalk(bot, target, ms, finish);
        return;
      }
      if (!bot._mbMoves) {
        try { setup(bot); } catch (e5) { /* ignore */ }
      }
      // 关键：先复位插件内部的「已停止」闸门，否则新目标会被 resetPath 当场抹掉（机器人一动不动）。
      try { arm(bot); } catch (e5b) { /* 复位失败也要继续试一把 */ }
      // 多 Bot 防碰撞：目标点被友军占住时，先走加权代价最低的绕行落点。
      try {
        var swarmCollision = require("./swarm-collision");
        var detour = swarmCollision.avoidPoint(bot, target, {});
        if (detour && detour.shifted === true) target = { x: detour.x, y: detour.y, z: detour.z };
      } catch (eSwarm) { /* 防碰撞模块缺失时按原目标走 */ }
      try {
        bot.pathfinder.setGoal(new pfLib.goals.GoalBlock(target.x, target.y, target.z));
      } catch (err) {
        finish(failure("goTo", err));
        return;
      }
      // 节点预算护栏：A* 搜过 MAX_PATH_NODES 还没结果就立刻放弃，改走直线（防止 CPU 满载）。
      try { applyLimits(bot); } catch (e5c) { /* ignore */ }
      detachBudget = watchNodes(bot, function (used) {
        logWarn("[pathfinding] A* 超出节点预算 / node budget exceeded: " + used + " > " + MAX_PATH_NODES);
        try {
          if (bot.pathfinder && typeof bot.pathfinder.stop === "function") bot.pathfinder.stop();
        } catch (e5d) { /* ignore */ }
        if (finished) return;
        usingFallback = true;
        fallbackWalk(bot, target, ms, finish);
      });
      try { bot._mbNodeDetach = detachBudget; } catch (e5e) { /* ignore */ }
      try {
        if (typeof bot.once === "function") {
          bot.once("goal_reached", function () {
            finish({ ok: true, action: "goTo", target: target, mode: "pathfinder", message: "arrived / 已到达" });
          });
        }
      } catch (e6) { /* ignore */ }
      poll = setInterval(function () {
        try {
          var d = distSq(bot, target.x, target.y, target.z);
          if (d >= 0 && d <= ARRIVE_DISTANCE * ARRIVE_DISTANCE) {
            try {
              if (bot.pathfinder && typeof bot.pathfinder.stop === "function") bot.pathfinder.stop();
            } catch (e7) { /* ignore */ }
            finish({ ok: true, action: "goTo", target: target, mode: "pathfinder", message: "arrived / 已到达" });
          }
        } catch (e8) { /* ignore */ }
      }, POLL_MS);
      if (poll && poll.unref) poll.unref();
    } catch (err) {
      finish(failure("goTo", err));
    }
  });
}
// 无寻路插件时的退化步进：每 250ms 朝目标方向按前进键，到达或超时即收尾。
function fallbackWalk(bot, target, ms, finish) {
  try {
    var startedAt = Date.now();
    var timer = setInterval(function () {
      try {
        var d = distSq(bot, target.x, target.y, target.z);
        if (d >= 0 && d <= ARRIVE_DISTANCE * ARRIVE_DISTANCE) {
          finish({ ok: true, action: "goTo", target: target, mode: "fallback", message: "arrived / 已到达" });
          return;
        }
        if (Date.now() - startedAt >= ms) {
          finish({
            ok: false, action: "goTo", target: target, mode: "fallback",
            code: "TIMEOUT", message: "timeout / 寻路超时（无寻路插件）"
          });
          return;
        }
        var p = bot && bot.entity && bot.entity.position ? bot.entity.position : null;
        if (!p) return;
        if (vecLib && typeof vecLib.Vec3 === "function" && typeof bot.lookAt === "function") {
          // 退化步进也要看向目标「头顶上一格」，绝不能给地平线以下的点（否则低头看地面）。
          try { bot.lookAt(new vecLib.Vec3(target.x, Number(target.y) + 1, target.z)); } catch (e1) { /* ignore */ }
        }
        if (typeof bot.setControlState === "function") bot.setControlState("forward", true);
      } catch (e2) { /* ignore */ }
    }, POLL_MS);
    if (timer && timer.unref) timer.unref();
    bot._mbFallbackTimer = timer;
  } catch (err) {
    finish({ ok: false, action: "goTo", target: target, message: errText(err) });
  }
}

// 停止寻路：清退化定时器、停 pathfinder、取消当前目标，重复调用安全。
function stop(bot) {
  try {
    if (!bot) return notReady("stop");
    // 先摘掉 A* 节点监听，再清退化定时器与目标，确保停止后不再有回调活下来。
    try { detachNodeWatch(bot); } catch (e0) { /* ignore */ }
    try { clearFallbackTimer(bot); } catch (e1) { /* ignore */ }
    // 打断还在跑的 goTo：否则它的轮询会一直转到超时（外部表现就是「喊停停不下来」）。
    try { if (typeof bot._mbGoToAbort === "function") bot._mbGoToAbort(); } catch (e1b) { /* ignore */ }
    try { bot._mbGoToAbort = null; } catch (e1c) { /* ignore */ }
    // 停止令牌 +1：批量寻路（拾取一串掉落物）看到令牌变了就收工，绝不在 stop 之后又走起来。
    try { bot._mbStopToken = (Number(bot._mbStopToken) || 0) + 1; } catch (e1d) { /* ignore */ }
    try {
      if (bot.pathfinder && typeof bot.pathfinder.stop === "function") bot.pathfinder.stop();
    } catch (e2) { /* ignore */ }
    try {
      if (bot.pathfinder && typeof bot.pathfinder.setGoal === "function") bot.pathfinder.setGoal(null);
    } catch (e3) { /* ignore */ }
    return { ok: true, action: "stop", message: "stopped / 已停止" };
  } catch (err) { return failure("stop", err); }
}

// 读当前停止令牌：批量动作在每一步之前比一次，变了就说明期间执行过 stop。
function stopToken(bot) {
  try { return Number(bot && bot._mbStopToken) || 0; } catch (e) { return 0; }
}

// 切换寻路等级：只接受 low / medium / high / smart，其它值回参数非法。
function setLevel(bot, level) {
  try {
    if (!bot) return notReady("setLevel");
    var name = level ? String(level) : "";
    if (!LEVELS[name]) {
      return {
        ok: false, action: "setLevel", code: "BAD_PARAM",
        message: "level must be low / medium / high / smart（等级非法）"
      };
    }
    return applyLevel(bot, name);
  } catch (err) { return failure("setLevel", err); }
}

// 对外导出：setup / arm / goTo / stop / setLevel，另附算力护栏常量与节点监听（自检与调试用）。
module.exports = {
  setup: setup,
  arm: arm,
  goTo: goTo,
  stop: stop,
  stopToken: stopToken,
  setLevel: setLevel,
  watchNodes: watchNodes,
  openModBlocks: openModBlocks,
  isModName: isModName,
  LIMITS: {
    MAX_PATH_NODES: MAX_PATH_NODES,
    THINK_TIMEOUT_MS: THINK_TIMEOUT_MS,
    MAX_SEARCH_RADIUS: MAX_SEARCH_RADIUS,
    POLL_MS: POLL_MS
  }
};
