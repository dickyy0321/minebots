// ========================================
// 文件：modules/fake-bot.js
// 功能：测试模式假机器人——握手完成后完整模拟游戏环境：世界状态 / 随机事件 / 死亡重生 / 断线重连 / 服务器公告
// 依赖：无（纯内置对象；日志函数由调用方注入，避免与 logger 形成循环引用）
// 导出：startSimulation / stopSimulation / isSimulating / 各时间间隔常量
// 作者：MineBots
// ========================================

// 常量：心跳间隔 5 分钟（只写文件日志，绝不推送 GUI，避免刷屏）。
var HEARTBEAT_MS = 300000;
// 常量：世界状态刷新间隔 30 秒（血量 / 饥饿 / 坐标 / 维度）。
var WORLD_TICK_MS = 30000;
// 常量：背包刷新间隔 60 秒（随机增减物品）。
var INVENTORY_TICK_MS = 60000;
// 常量：服务器公告间隔 2 分钟。
var SERVER_TICK_MS = 120000;
// 常量：随机事件间隔区间 3~5 分钟。
var EVENT_MIN_MS = 180000;
var EVENT_MAX_MS = 300000;
// 常量：死亡 / 断线模拟间隔（10 分钟 / 15 分钟）。
var DEATH_TICK_MS = 600000;
var DROP_TICK_MS = 900000;
// 常量：死亡重生 / 断线重连的等待时间 5 秒，与真服体验一致。
var RESPAWN_DELAY_MS = 5000;

// 常量：随机事件文案池（中英双语一起写日志；item 命中时同时改背包）。
var EVENT_POOL = [
  { zh: "附近出现僵尸", en: "A zombie appeared nearby" },
  { zh: "捡到 1 个 diamond", en: "Picked up 1 diamond", item: "diamond", count: 1 },
  { zh: "被骷髅射了一箭", en: "Shot by a skeleton", damage: 3 },
  { zh: "天黑了", en: "Night fell", dimension: "dark" },
  { zh: "雨停了", en: "The rain stopped" },
  { zh: "玩家 Steve 上线", en: "Player Steve joined" }
];

// 常量：服务器公告文案池。
var SERVER_POOL = [
  { zh: "欢迎来到服务器！", en: "Welcome to the server!" },
  { zh: "Steve 加入了游戏", en: "Steve joined the game" },
  { zh: "今天天气不错", en: "It's a beautiful day" }
];

// 常量：可切换的维度列表。
var DIMENSION_POOL = ["overworld", "nether", "end"];
// 常量：背包物品池（name 与 minecraft 物品名一致，便于将来对接真实逻辑）。
var ITEM_POOL = ["diamond", "oak_log", "cobblestone", "coal", "iron_ingot", "stick", "apple"];

// 工具：随机整数 [min, max]，参数非法时返回 min。
function randInt(min, max) {
  try {
    var lo = parseInt(min, 10);
    var hi = parseInt(max, 10);
    if (isNaN(lo) || isNaN(hi) || hi < lo) return isNaN(lo) ? 0 : lo;
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  } catch (e) {
    return 0;
  }
}

// 工具：从数组随机取一项，空数组返回 null。
function pickOne(list) {
  try {
    if (!list || !list.length) return null;
    return list[randInt(0, list.length - 1)];
  } catch (e) {
    return null;
  }
}

// 工具：拼中英双语文本（双语规范：日志与界面都保持两种语言）。
function dual(zh, en) {
  return String(zh) + " / " + String(en);
}

// 工具：把日志函数包成“调用失败也绝不抛错”的安全版本，缺失时退回 console。
function safeLog(fn, message) {
  try {
    if (typeof fn === "function") { fn(message); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log(String(message)); } catch (e) { /* 忽略 */ }
}

// 事件发射器：给假 bot 装上 on / once / removeListener / emit，风格与 mineflayer 一致。
function makeEmitter(target) {
  var handlers = {};
  target.handlers = handlers;
  target.on = function (event, fn) {
    try {
      if (typeof fn !== "function") return target;
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(fn);
    } catch (e) { /* 注册失败不影响其它监听 */ }
    return target;
  };
  target.once = function (event, fn) {
    try {
      if (typeof fn !== "function") return target;
      var wrapper = function () {
        try { target.removeListener(event, wrapper); } catch (e) { /* 忽略 */ }
        return fn.apply(target, arguments);
      };
      target.on(event, wrapper);
    } catch (e) { /* 忽略 */ }
    return target;
  };
  target.removeListener = function (event, fn) {
    try {
      var list = handlers[event] || [];
      for (var i = list.length - 1; i >= 0; i--) if (list[i] === fn) list.splice(i, 1);
    } catch (e) { /* 忽略 */ }
    return target;
  };
  target.listenerCount = function (event) {
    try { return (handlers[event] || []).length; } catch (e) { return 0; }
  };
  // emit：对外暴露的派发入口，参数形态与 mineflayer 一致（emit(name, a, b, ...)）。
  target.emit = function (name) {
    var args = Array.prototype.slice.call(arguments, 1);
    return emitEvent(target, name, args);
  };
  return target;
}

// 派发事件：单个监听器抛错不影响其它监听器，也绝不把异常抛给定时器。
function emitEvent(target, name, args) {
  try {
    if (!target || !target.handlers) return false;
    var list = (target.handlers[name] || []).slice(0);
    for (var i = 0; i < list.length; i++) {
      try { list[i].apply(target, args || []); } catch (e) { /* 单个监听器失败不影响其它 */ }
    }
    return true;
  } catch (e) {
    return false;
  }
}

// 生成初始世界状态：血量 / 饥饿 / 坐标 / 维度 / 背包。
function createWorld() {
  return {
    health: randInt(15, 20),
    food: randInt(15, 20),
    position: { x: randInt(0, 200), y: 64, z: randInt(0, 200) },
    dimension: "overworld",
    inventory: createInventory()
  };
}

// 生成初始背包：随机 1~3 种物品，每种 1~16 个。
function createInventory() {
  var out = [];
  var kinds = randInt(1, 3);
  for (var i = 0; i < kinds; i++) {
    var name = pickOne(ITEM_POOL);
    if (!name) continue;
    out.push({ name: name, count: randInt(1, 16) });
  }
  return out;
}

// 把世界状态同步到假 bot 实例上，让读取 bot.health / bot.entity.position 的代码拿到最新值。
function syncInstance(rec) {
  try {
    var bot = rec.bot;
    var world = rec.world;
    if (!bot || !world) return false;
    bot.health = world.health;
    bot.food = world.food;
    if (bot.entity && bot.entity.position) {
      bot.entity.position.x = world.position.x;
      bot.entity.position.y = world.position.y;
      bot.entity.position.z = world.position.z;
    }
    if (bot.game) bot.game.dimension = world.dimension;
    return true;
  } catch (e) {
    return false;
  }
}

// 创建假 bot 实例：字段与真 mineflayer bot 对齐，测试模式照样能 emit / chat / quit。
function createFakeInstance(rec, api) {
  var bot = {
    username: rec.username,
    health: 20,
    food: 20,
    entity: { position: { x: 0, y: 64, z: 0 } },
    game: { dimension: "overworld" },
    fake: true
  };
  // 背包读取接口：与 mineflayer 的 bot.inventory.items() 同形。
  bot.inventory = {
    items: function () {
      try { return (rec.world && rec.world.inventory) ? rec.world.inventory.slice() : []; }
      catch (e) { return []; }
    }
  };
  // 发消息：测试模式只写日志，不真的发包。
  bot.chat = function (text) {
    safeLog(api.info, "[" + rec.id + "] [TEST-CHAT] " + String(text));
    return true;
  };
  // 私聊：测试模式与普通聊天走同一条路径。
  bot.whisper = function (name, text) {
    safeLog(api.info, "[" + rec.id + "] [TEST-WHISPER] " + String(name) + ": " + String(text));
    return true;
  };
  // 退出：交给 stopSimulation 处理，这里只回包。
  bot.quit = function () { return true; };
  // 重生：立刻把状态恢复到 running（真实流程仍由死亡模拟的 5 秒定时器驱动）。
  bot.respawn = function () {
    try {
      if (rec.world) rec.world.health = randInt(15, 20);
      rec.status = "running";
      syncInstance(rec);
      emitEvent(bot, "respawn", []);
      return true;
    } catch (e) { return false; }
  };
  makeEmitter(bot);
  rec.bot = bot;
  return bot;
}

// 登记定时器：统一放进 rec.fakeTimers 并 unref，避免阻塞进程退出。
function addTimer(rec, handle) {
  try {
    if (!handle) return null;
    if (typeof handle.unref === "function") handle.unref();
    if (rec.fakeTimers && typeof rec.fakeTimers.push === "function") rec.fakeTimers.push(handle);
  } catch (e) { /* 登记失败只是少一个定时器 */ }
  return handle;
}

// 起一个循环定时器（登记到 fakeTimers）。
function setLoop(rec, fn, ms) {
  var handle = null;
  try {
    handle = setInterval(function () {
      try { fn(); } catch (e) { safeLog(rec._fakeApi.error, "[" + rec.id + "] 模拟任务失败: " + getErrText(e)); }
    }, ms);
  } catch (e) {
    handle = null;
  }
  return addTimer(rec, handle);
}

// 起一个一次性定时器（登记到 fakeTimers）。
function setOnce(rec, fn, ms) {
  var handle = null;
  try {
    handle = setTimeout(function () {
      try { fn(); } catch (e) { safeLog(rec._fakeApi.error, "[" + rec.id + "] 模拟任务失败: " + getErrText(e)); }
    }, ms);
  } catch (e) {
    handle = null;
  }
  return addTimer(rec, handle);
}

// 安全取错误文本，避免在 catch 里再抛错。
function getErrText(err) {
  try {
    if (err && err.message) return String(err.message);
    return String(err);
  } catch (e) {
    return "unknown error";
  }
}

// 把事件池里的一条文案拼成中英双语文本。
function eventText(item) {
  try {
    return dual(item.zh, item.en);
  } catch (e) {
    return "";
  }
}

// 世界状态刷新（30 秒）：血量 / 饥饿 / 坐标 / 维度随机变化后同步到 bot，只写文件日志不进 GUI。
function tickWorld(rec) {
  if (!alive(rec)) return false;
  try {
    var world = rec.world;
    world.health = randInt(15, 20);
    world.food = randInt(15, 20);
    world.position.x = randInt(0, 200);
    world.position.y = 64;
    world.position.z = randInt(0, 200);
    world.dimension = pickOne(DIMENSION_POOL) || "overworld";
    syncInstance(rec);
    safeLog(rec._fakeApi.info, "[TEST] " + rec.id + " world health=" + world.health + " food=" + world.food +
      " pos=(" + world.position.x + "," + world.position.y + "," + world.position.z + ") dimension=" + world.dimension);
    emitEvent(rec.bot, "world-state", [world]);
    return true;
  } catch (e) {
    return false;
  }
}

// 往背包加物品：同名的累加数量，否则新增一项。
function addItem(rec, name, count) {
  try {
    var list = rec.world.inventory;
    var add = parseInt(count, 10);
    if (isNaN(add) || add <= 0) add = 1;
    for (var i = 0; i < list.length; i++) {
      if (list[i].name === name) { list[i].count = list[i].count + add; return true; }
    }
    list.push({ name: name, count: add });
    return true;
  } catch (e) {
    return false;
  }
}

// 从背包随机减物品：数量归零就移除该项，空背包返回 false。
function removeItem(rec) {
  try {
    var list = rec.world.inventory;
    if (!list.length) return false;
    var index = randInt(0, list.length - 1);
    list[index].count = list[index].count - 1;
    if (list[index].count <= 0) list.splice(index, 1);
    return true;
  } catch (e) {
    return false;
  }
}

// 背包刷新（60 秒）：随机增减物品，只写文件日志。
function tickInventory(rec) {
  if (!alive(rec)) return false;
  try {
    var changed = false;
    if (Math.random() < 0.5) changed = addItem(rec, pickOne(ITEM_POOL) || "cobblestone", randInt(1, 8));
    else changed = removeItem(rec);
    var list = rec.world.inventory;
    safeLog(rec._fakeApi.info, "[TEST] " + rec.id + " inventory changed=" + changed + " items=" + list.length);
    emitEvent(rec.bot, "inventory-change", [list.slice(0)]);
    return true;
  } catch (e) {
    return false;
  }
}

// 心跳（5 分钟）：只写文件日志（logger.info 不推 GUI），彻底解决心跳刷屏。
function tickHeartbeat(rec) {
  if (!alive(rec)) return false;
  try {
    var world = rec.world;
    safeLog(rec._fakeApi.info, "[TEST] " + rec.id + " heartbeat status=" + rec.status +
      " health=" + world.health + " food=" + world.food + " dimension=" + world.dimension);
    return true;
  } catch (e) {
    return false;
  }
}

// 推送一条服务器消息事件：参数形态与 mineflayer 的 message 事件一致（对象带 toString）。
function emitMessage(rec, text) {
  var wrapper = {
    text: text,
    toString: function () { return String(text); }
  };
  return emitEvent(rec.bot, "message", [wrapper, "SERVER", false]);
}

// 服务器公告（2 分钟）：随机挑一条，按 SERVER 类型写日志（会推送 GUI）。
function tickServer(rec) {
  if (!alive(rec)) return false;
  var item = pickOne(SERVER_POOL);
  if (!item) return false;
  var text = eventText(item);
  safeLog(rec._fakeApi.server, "[SERVER] " + text);
  emitMessage(rec, text);
  return true;
}

// 随机事件（3~5 分钟）：挑一条事件文案，写系统日志（会推送 GUI）并 emit("chat")。
function tickEvent(rec) {
  if (!alive(rec)) return false;
  var item = pickOne(EVENT_POOL);
  if (!item) return false;
  var text = eventText(item);
  try {
    // 命中「捡到物品」就同步加背包，命中「被射一箭」就扣血，行为跟真服一致。
    if (item.item) addItem(rec, item.item, item.count || 1);
    if (item.damage) {
      rec.world.health = Math.max(1, rec.world.health - item.damage);
      syncInstance(rec);
    }
  } catch (e) { /* 事件副作用失败不影响日志 */ }
  safeLog(rec._fakeApi.system, "[TEST] " + rec.id + " 事件 / event: " + text);
  emitEvent(rec.bot, "chat", ["SYSTEM", text]);
  return true;
}

// 随机事件定时器：每次随机 3~5 分钟后触发一次，触发后再排下一次，形成不规律节奏。
function scheduleEvent(rec) {
  if (!alive(rec)) return false;
  setOnce(rec, function () {
    if (!alive(rec)) return;
    tickEvent(rec);
    scheduleEvent(rec);
  }, randInt(EVENT_MIN_MS, EVENT_MAX_MS));
  return true;
}

// 模拟是否仍在运行：所有定时任务开头都先问一次，停止后不再写日志。
function alive(rec) {
  try { return !!(rec && rec.fakeAlive === true); } catch (e) { return false; }
}

// 死亡与重生（10 分钟一次）：状态 dead -> 5 秒后自动重生 -> running。
function tickDeath(rec) {
  if (!alive(rec)) return false;
  try {
    rec.status = "dead";
    rec.world.health = 0;
    syncInstance(rec);
    rec.deathCount = (rec.deathCount || 0) + 1;
    safeLog(rec._fakeApi.warn, "[TEST] " + rec.id + " 死亡 / died（5 秒后自动重生 / auto respawn in 5s）");
    emitEvent(rec.bot, "death", []);
  } catch (e) {
    return false;
  }
  setOnce(rec, function () {
    if (!alive(rec)) return;
    try {
      rec.status = "running";
      rec.world.health = randInt(15, 20);
      rec.world.position.x = randInt(0, 200);
      rec.world.position.z = randInt(0, 200);
      syncInstance(rec);
      safeLog(rec._fakeApi.system, "[TEST] " + rec.id + " 已重生 / respawned");
      emitEvent(rec.bot, "respawn", []);
    } catch (e) { /* 重生失败也绝不抛给定时器 */ }
  }, RESPAWN_DELAY_MS);
  return true;
}

// 断线与重连（15 分钟一次）：状态 stopped -> 5 秒后自动重连 -> running。
function tickDrop(rec) {
  if (!alive(rec)) return false;
  try {
    rec.status = "stopped";
    rec.dropCount = (rec.dropCount || 0) + 1;
    safeLog(rec._fakeApi.warn, "[TEST] " + rec.id + " 连接超时 / connection timeout（5 秒后自动重连 / reconnecting in 5s）");
    emitEvent(rec.bot, "end", ["timeout"]);
  } catch (e) {
    return false;
  }
  setOnce(rec, function () {
    if (!alive(rec)) return;
    try {
      rec.status = "running";
      syncInstance(rec);
      safeLog(rec._fakeApi.system, "[TEST] " + rec.id + " 已重连 / reconnected");
      emitEvent(rec.bot, "spawn", []);
    } catch (e) { /* 重连失败也绝不抛给定时器 */ }
  }, RESPAWN_DELAY_MS);
  return true;
}

// 启动模拟：装假 bot 实例与世界状态，挂上七路定时器，返回是否成功。
function startSimulation(rec, api) {
  var log = api || {};
  try {
    if (!rec) return false;
    rec._fakeApi = log;
    rec.fakeAlive = true;
    rec.fakeTimers = [];
    rec.world = createWorld();
    rec.deathCount = 0;
    rec.dropCount = 0;
    createFakeInstance(rec, log);
    syncInstance(rec);
    // 世界 / 背包 / 心跳：只写文件日志，绝不推 GUI（心跳改成 5 分钟一次，不再刷屏）。
    setLoop(rec, function () { tickWorld(rec); }, WORLD_TICK_MS);
    setLoop(rec, function () { tickInventory(rec); }, INVENTORY_TICK_MS);
    rec.fakeTimer = setLoop(rec, function () { tickHeartbeat(rec); }, HEARTBEAT_MS);
    // 公告 / 事件 / 死亡 / 断线：重要事件，照旧推送 GUI。
    setLoop(rec, function () { tickServer(rec); }, SERVER_TICK_MS);
    setLoop(rec, function () { tickDeath(rec); }, DEATH_TICK_MS);
    setLoop(rec, function () { tickDrop(rec); }, DROP_TICK_MS);
    scheduleEvent(rec);
    // 启动瞬间先刷一次世界状态，GUI 立刻能看到血量 / 坐标 / 维度。
    tickWorld(rec);
    safeLog(log.system, "[TEST] " + rec.id + " 模拟环境已启动 / simulation started");
    return true;
  } catch (e) {
    safeLog(log.error, "[TEST] " + rec.id + " 模拟环境启动失败 / simulation failed: " + getErrText(e));
    return false;
  }
}

// 停止模拟：清掉全部定时器并标记为已停，返回清掉的定时器个数。
function stopSimulation(rec) {
  var cleared = 0;
  try {
    if (!rec) return 0;
    rec.fakeAlive = false;
    var timers = rec.fakeTimers || [];
    for (var i = 0; i < timers.length; i++) {
      try { clearInterval(timers[i]); } catch (e) { /* 忽略 */ }
      try { clearTimeout(timers[i]); } catch (e) { /* 忽略 */ }
      cleared = cleared + 1;
    }
    rec.fakeTimers = [];
    rec.fakeTimer = null;
  } catch (e) { /* 清理失败也要把标记置为已停 */ }
  return cleared;
}

// 是否正在模拟：给 GUI / 自检判断用。
function isSimulating(rec) {
  return alive(rec);
}

// 对外导出：启动 / 停止 / 查询 三个接口 + 各时间间隔常量（便于自检与将来调参）。
module.exports = {
  startSimulation: startSimulation,
  stopSimulation: stopSimulation,
  isSimulating: isSimulating,
  HEARTBEAT_MS: HEARTBEAT_MS,
  WORLD_TICK_MS: WORLD_TICK_MS,
  INVENTORY_TICK_MS: INVENTORY_TICK_MS,
  SERVER_TICK_MS: SERVER_TICK_MS,
  EVENT_MIN_MS: EVENT_MIN_MS,
  EVENT_MAX_MS: EVENT_MAX_MS,
  DEATH_TICK_MS: DEATH_TICK_MS,
  DROP_TICK_MS: DROP_TICK_MS,
  RESPAWN_DELAY_MS: RESPAWN_DELAY_MS
};


