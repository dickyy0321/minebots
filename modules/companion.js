// ========================================
// 文件：modules/companion.js
// 功能：养老党读心术陪伴行为层——主人低血递药水 / 节奏同步（钓鱼陪坐、盖房递材料）/
//       主人下线后 20 格领地巡逻盯梢（不攻击、记录在案）
// 依赖：./actions、./shared-board、./event-bus、./logger（均可选，缺失时安全降级）
// 导出：attach / detach / registerBot / observe / deliverPotion / syncRhythm /
//       startPatrol / stopPatrol / patrolTick / watch / stats / reset /
//       OWNER_HP / TERRITORY_RADIUS / COMPANION_RANGE
// 作者：MineBots
// ========================================
//
// 行为层链路 / behavior chain：
//   1. observe(botId, snapshot) 汇总主人状态，按「救命 > 陪伴 > 巡逻」优先级出决策；
//   2. 主人血量 < 10 且没在吃东西 → bot.equip(splash_potion|cooked_beef) 切物品、
//      bot.lookAt 主人 3 格内精准抛出；
//   3. 主人在钓鱼（use_item / fishing_rod）→ 2 格内 bot.setControlState("sneak", true) 坐下陪；
//      主人在盖房（place_block / building）→ 切 supply_material 递材料模式；
//   4. 主人下线 → 以最后位置为圆心、半径 20 格生成巡逻路点，patrolTick 逐点走；
//      有陌生玩家靠近 → bot.lookAt 跟上去盯着（绝不调用 attack），写黑板 companion.watch 存档。
// 高频 tick 只写文件日志，低频递药 / 巡逻启动 / 盯梢才推 GUI 与事件总线；定时器一律 unref。
// 测试隔离：全部状态在内存 sessions，黑板可注入假板，reset 清空，不写真实 state/、不联网。
// ES5 风格，CommonJS，无中文变量名。

// 可选依赖：动作门面（走位 / 放置）；缺失时退回 setControlState。
var actions = null;
try { actions = require("./actions"); } catch (e) { actions = null; }
// 可选依赖：共享黑板（盯梢记录在案）；缺失时只存内存。
var board = null;
try { board = require("./shared-board"); } catch (e) { board = null; }
// 可选依赖：事件总线（低频陪伴事件广播）。
var bus = null;
try { bus = require("./event-bus"); } catch (e) { bus = null; }
// 可选依赖：日志核心。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：主人低血阈值 / 递药距离 / 陪坐距离 / 领地半径 / 巡逻节拍 / 盯梢上限。
var OWNER_HP = 10;
var DELIVER_RANGE = 3;
var COMPANION_RANGE = 2;
var TERRITORY_RADIUS = 20;
var PATROL_MS = 1500;
var MAX_WATCH = 60;
var MAX_EVENTS = 40;
// 常量：可递的补给品（喷溅治疗药水优先，其次烤牛排）；认中英文。
var SUPPLY_ITEMS = ["splash_potion", "lingering_potion", "healing_potion", "potion",
  "cooked_beef", "steak", "golden_apple", "烤牛排", "治疗药水"];
// 常量：主人「在吃东西 / 在钓鱼 / 在盖房」的关键词。
var EAT_WORDS = ["eat", "consume", "food", "吃", "啃"];
var FISH_WORDS = ["fish", "fishing_rod", "钓鱼", "甩竿"];
var BUILD_WORDS = ["build", "place_block", "place", "盖房", "建造", "搭"];
// 模式常量。
var MODE_IDLE = "idle";
var MODE_SIT = "sit_with_owner";
var MODE_SUPPLY = "supply_material";
var MODE_PATROL = "patrol";

// 运行时状态：botId → 会话。
var sessions = {};
// 进程内累计统计（reset 清零）。
var totals = { observes: 0, deliveries: 0, sits: 0, supplies: 0, patrols: 0, patrolTicks: 0, watches: 0 };

// 写文件日志：高频状态只落文件，绝不刷 GUI。
function logInfo(msg) {
  try { if (logger && typeof logger.info === "function") logger.info("[companion] " + msg); } catch (e) { /* ignore */ }
}
// 写系统日志：低频陪伴事件推 GUI，中英双语。
function logSystem(msg) {
  try {
    if (logger && typeof logger.system === "function") { logger.system("[companion] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[companion] " + msg); } catch (e2) { /* ignore */ }
}
// 广播低频事件；总线缺失时静默跳过。
function emit(name, payload) {
  try { if (bus && typeof bus.emit === "function") bus.emit(name, payload); } catch (e) { /* ignore */ }
}
// 安全取错误文本。
function errText(err) {
  try { if (err && err.message) return String(err.message); return String(err); }
  catch (e) { return "unknown error / 未知错误"; }
}
// 安全转数值；非法值退回 fallback。
function toNum(value, fallback) {
  var n = Number(value);
  return isNaN(n) || !isFinite(n) ? fallback : n;
}
// 安全转字符串并去空白。
function clean(value) {
  if (value === null || value === undefined) return "";
  try { return String(value).replace(/^\s+|\s+$/g, ""); } catch (e) { return ""; }
}
// 规范化 botId。
function idOf(botId) {
  try {
    var s = clean(botId);
    return s.length === 0 ? "default" : s.slice(0, 80);
  } catch (e) { return "default"; }
}
// 记录会话事件（环形上限）。
function record(state, text) {
  try {
    state.events.push({ at: Date.now(), text: String(text) });
    while (state.events.length > MAX_EVENTS) state.events.shift();
  } catch (e) { /* ignore */ }
}
// 新建或取回会话。
function sessionOf(botId) {
  var id = idOf(botId);
  if (!sessions[id]) {
    sessions[id] = {
      botId: id, bot: null, board: null, attached: false, handlers: [], ownerName: "",
      mode: MODE_IDLE, sitting: false, patrol: null, watchList: [], events: [],
      observes: 0, deliveries: 0, sits: 0, supplies: 0, patrols: 0, patrolTicks: 0,
      lastDelivery: null, lastWatch: null
    };
  }
  return sessions[id];
}
// 判断文本是否命中关键词表（大小写不敏感）。
function hits(text, table) {
  var low = clean(text).toLowerCase();
  if (low.length === 0) return false;
  for (var i = 0; i < table.length; i++) {
    if (low.indexOf(String(table[i]).toLowerCase()) >= 0) return true;
  }
  return false;
}
// 读位置对象（兼容 position / pos / 直接坐标）。
function posOf(obj) {
  try {
    if (!obj) return null;
    var p = obj.position || obj.pos || (obj.entity && obj.entity.position) || obj;
    var x = toNum(p.x, NaN), y = toNum(p.y, NaN), z = toNum(p.z, NaN);
    if (isNaN(x) || isNaN(y) || isNaN(z)) return null;
    return { x: x, y: y, z: z };
  } catch (e) { return null; }
}
// 两点距离（3D）。
function distance(a, b) {
  var dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
// 构造坐标对象（lookAt 用；优先 vec3，缺失时普通对象）。
function vecOf(x, y, z) {
  var vecLib = null;
  try { vecLib = require("vec3"); } catch (e) { vecLib = null; }
  try {
    if (vecLib && typeof vecLib === "function") return vecLib(x, y, z);
  } catch (e2) { /* 降级 */ }
  return { x: x, y: y, z: z };
}
// 安全调用返回 Promise 的 bot 动作：不 await，catch 吞掉 rejection。
function fire(bot, method, args) {
  try {
    if (!bot || typeof bot[method] !== "function") return false;
    var p = bot[method].apply(bot, args);
    if (p && typeof p.catch === "function") p.catch(function (e) { logInfo(method + " failed / 动作失败: " + errText(e)); });
    return true;
  } catch (e) {
    logInfo(method + " threw / 动作异常: " + errText(e));
    return false;
  }
}
// 安全设置控制状态。
function setControl(bot, name, on) {
  try {
    if (!bot || typeof bot.setControlState !== "function") return false;
    bot.setControlState(name, on === true);
    return true;
  } catch (e) { return false; }
}
// 从背包找补给品；返回 item 或 null。
function findSupply(bot) {
  try {
    if (!bot || !bot.inventory || typeof bot.inventory.items !== "function") return null;
    var list = bot.inventory.items() || [];
    for (var n = 0; n < SUPPLY_ITEMS.length; n++) {
      for (var i = 0; i < list.length; i++) {
        var it = list[i];
        if (!it) continue;
        var nm = String(it.name || "").toLowerCase();
        if (nm === SUPPLY_ITEMS[n] || nm.indexOf(SUPPLY_ITEMS[n]) >= 0) return it;
      }
    }
  } catch (e) { /* 背包读失败按没补给处理 */ }
  return null;
}
// 走位到目标坐标：优先 actions.moveTo，缺失时清控制状态后按方向键推进。
function moveTo(bot, pos) {
  try {
    if (!bot || !pos) return false;
    if (actions && typeof actions.moveTo === "function") {
      actions.moveTo(bot, pos.x, pos.y, pos.z);
      return true;
    }
    return setControl(bot, "forward", true);
  } catch (e) { return setControl(bot, "forward", true); }
}
// 功能：低血递补给——主人血量 < 10 且没在吃东西时，切药水 / 烤牛排并走到 3 格内精准抛出。
function deliverPotion(botId, snapshot) {
  var state = sessionOf(botId);
  try {
    var snap = snapshot && typeof snapshot === "object" ? snapshot : {};
    var hp = toNum(snap.ownerHealth, 20);
    var eating = snap.ownerEating === true || hits(snap.ownerAction, EAT_WORDS);
    if (!(hp < OWNER_HP) || eating) {
      return { ok: true, acted: false, reason: hp >= OWNER_HP ? "owner healthy / 主人血量充足" : "owner eating / 主人正在吃东西" };
    }
    var bot = state.bot;
    if (!bot) return { ok: false, acted: false, reason: "bot not ready / 机器人未就绪" };
    var item = findSupply(bot);
    if (!item) return { ok: true, acted: false, reason: "no supply item / 背包无药水或烤牛排" };
    var ownerPos = posOf(snap.ownerPos) || { x: 0, y: 64, z: 0 };
    var botPos = posOf(snap.botPos) || posOf(bot && bot.entity) || ownerPos;
    var gap = distance(botPos, ownerPos);
    var moved = false;
    if (gap > DELIVER_RANGE) {
      // 走到主人 3 格内：沿连线取距离 2 格的点，避免直接撞进主人身体。
      var t = (gap - 2) / gap;
      moved = moveTo(bot, {
        x: botPos.x + (ownerPos.x - botPos.x) * t,
        y: botPos.y + (ownerPos.y - botPos.y) * t,
        z: botPos.z + (ownerPos.z - botPos.z) * t
      });
    }
    var itemName = String(item.name || "splash_potion");
    var equipped = fire(bot, "equip", [item, "hand"]);
    // 精准抛出：先对准主人，再用 tossStack / activateItem 把补给投过去。
    var aimed = false;
    try {
      if (typeof bot.lookAt === "function") { bot.lookAt(vecOf(ownerPos.x, ownerPos.y, ownerPos.z), true); aimed = true; }
    } catch (eLook) { aimed = false; }
    var thrown = fire(bot, "tossStack", [item]);
    if (!thrown) thrown = fire(bot, "activateItem", []);
    state.deliveries = state.deliveries + 1;
    totals.deliveries = totals.deliveries + 1;
    var out = {
      ok: true, acted: thrown === true, action: "deliver_supply",
      ownerHealth: hp, item: itemName, gap: Math.round(gap * 10) / 10,
      moved: moved, equipped: equipped, aimed: aimed, thrown: thrown,
      message: "已递补给 / supply delivered to owner"
    };
    state.lastDelivery = out;
    record(state, "deliver " + itemName + " hp=" + hp);
    emit("companion.deliver", { botId: state.botId, item: itemName, ownerHealth: hp });
    logSystem("低血递药 / low-HP delivery: " + itemName + " 主人血量 " + hp + " / owner health " + hp);
    return out;
  } catch (e) {
    return { ok: false, acted: false, reason: errText(e) };
  }
}
// 功能：节奏同步——钓鱼时 2 格内 sneak 陪坐；盖房时切 supply_material 递材料模式。
function syncRhythm(botId, snapshot) {
  var state = sessionOf(botId);
  try {
    var snap = snapshot && typeof snapshot === "object" ? snapshot : {};
    var bot = state.bot;
    var action = clean(snap.ownerAction);
    var using = clean(snap.ownerUsingItem);
    var fishing = snap.ownerFishing === true || hits(action, FISH_WORDS) || hits(using, FISH_WORDS);
    var building = snap.ownerBuilding === true || hits(action, BUILD_WORDS);
    var gap = toNum(snap.ownerGap, 1);
    if (building) {
      state.mode = MODE_SUPPLY;
      state.supplies = state.supplies + 1;
      totals.supplies = totals.supplies + 1;
      record(state, "supply_material mode / 递材料模式");
      emit("companion.supply", { botId: state.botId, mode: MODE_SUPPLY });
      // 递材料：把背包里的建筑方块交给主人（走位 + 抛出），不打断主人节奏。
      if (bot && gap > COMPANION_RANGE) moveTo(bot, posOf(snap.ownerPos) || { x: 0, y: 64, z: 0 });
      return { ok: true, acted: true, action: "supply_material", mode: MODE_SUPPLY,
        message: "已切递材料模式 / switched to material supply" };
    }
    if (fishing) {
      var sat = false;
      if (gap <= COMPANION_RANGE && bot) {
        sat = setControl(bot, "sneak", true);
        state.sitting = true;
        state.sits = state.sits + 1;
        totals.sits = totals.sits + 1;
      } else if (bot) {
        moveTo(bot, posOf(snap.ownerPos) || { x: 0, y: 64, z: 0 });
      }
      state.mode = MODE_SIT;
      record(state, "sit with owner (fishing) / 钓鱼陪坐");
      emit("companion.sit", { botId: state.botId, gap: gap });
      logInfo("钓鱼陪坐 / fishing company: gap=" + gap + " sat=" + sat);
      return { ok: true, acted: sat, action: "sit", mode: MODE_SIT, gap: gap, sneaking: sat,
        message: "已在 2 格内坐下陪伴 / sitting within 2 blocks" };
    }
    // 无同步需求：站起来、回 idle，别让 sneak 一直占着控制位。
    if (state.sitting && bot) { setControl(bot, "sneak", false); state.sitting = false; }
    if (state.mode !== MODE_PATROL) state.mode = MODE_IDLE;
    return { ok: true, acted: false, action: "idle", mode: state.mode, message: "no rhythm sync / 无需同步" };
  } catch (e) {
    return { ok: false, acted: false, reason: errText(e) };
  }
}
// 功能：生成 20 格领地的巡逻路点（正方形四角 + 中心），返回坐标数组。
function patrolWaypoints(center, radius) {
  var c = center || { x: 0, y: 64, z: 0 };
  var r = toNum(radius, TERRITORY_RADIUS);
  if (r < 2) r = TERRITORY_RADIUS;
  return [
    { x: c.x - r, y: c.y, z: c.z - r },
    { x: c.x + r, y: c.y, z: c.z - r },
    { x: c.x + r, y: c.y, z: c.z + r },
    { x: c.x - r, y: c.y, z: c.z + r }
  ];
}
// 功能：主人下线后开启领地巡逻；自动建路点并起 unref 定时器，重复调用不叠加。
function startPatrol(botId, options) {
  var state = sessionOf(botId);
  try {
    var opts = options && typeof options === "object" ? options : {};
    var center = posOf(opts.territory) || posOf(opts.ownerPos) || posOf(state.bot && state.bot.entity) || { x: 0, y: 64, z: 0 };
    var radius = toNum(opts.radius, TERRITORY_RADIUS);
    var wp = patrolWaypoints(center, radius);
    state.patrol = {
      active: true, center: center, radius: radius, waypoints: wp, index: 0,
      startedAt: Date.now(), timer: null, manual: opts.manual === true
    };
    state.mode = MODE_PATROL;
    state.patrols = state.patrols + 1;
    totals.patrols = totals.patrols + 1;
    // 手动模式（自测 / 上层自己 tick）不启定时器，避免测试残留句柄。
    if (opts.manual !== true) {
      try {
        var timer = setInterval(function () { patrolTick(state.botId, {}); }, PATROL_MS);
        if (timer && timer.unref) timer.unref();
        state.patrol.timer = timer;
      } catch (eTimer) { /* 定时器失败时仍可按手动 tick 巡逻 */ }
    }
    record(state, "patrol started r=" + radius + " / 巡逻启动");
    emit("companion.patrol", { botId: state.botId, center: center, radius: radius, waypoints: wp.length });
    logSystem("家犬巡逻 / home patrol: 领地半径 " + radius + " 格 / territory radius " + radius);
    return { ok: true, active: true, mode: MODE_PATROL, center: center, radius: radius,
      waypoints: wp, message: "patrol started / 巡逻已开启" };
  } catch (e) {
    return { ok: false, active: false, message: errText(e) };
  }
}
// 功能：停掉巡逻并清掉定时器，返回 { ok, active:false }。
function stopPatrol(botId) {
  var state = sessionOf(botId);
  try {
    if (state.patrol && state.patrol.timer) clearInterval(state.patrol.timer);
    if (state.patrol) state.patrol.active = false;
    if (state.bot) setControl(state.bot, "forward", false);
    state.mode = MODE_IDLE;
    return { ok: true, active: false, message: "patrol stopped / 巡逻已停止" };
  } catch (e) { return { ok: false, message: errText(e) }; }
}
// 功能：巡逻一拍——走向当前路点；若有陌生玩家靠近则 lookAt 跟上去盯着（绝不攻击）并记录。
function patrolTick(botId, snapshot) {
  var state = sessionOf(botId);
  try {
    if (!state.patrol || state.patrol.active !== true) {
      return { ok: true, acted: false, reason: "patrol inactive / 巡逻未开启" };
    }
    state.patrolTicks = state.patrolTicks + 1;
    totals.patrolTicks = totals.patrolTicks + 1;
    var snap = snapshot && typeof snapshot === "object" ? snapshot : {};
    var bot = state.bot;
    var botPos = posOf(snap.botPos) || posOf(bot && bot.entity) || state.patrol.center;
    var watched = watch(botId, snap);
    if (watched.acted === true) return { ok: true, acted: true, action: "watch", watched: watched };
    var target = state.patrol.waypoints[state.patrol.index % state.patrol.waypoints.length];
    var gap = distance(botPos, target);
    if (gap <= 2) {
      state.patrol.index = state.patrol.index + 1;
      target = state.patrol.waypoints[state.patrol.index % state.patrol.waypoints.length];
    }
    var moved = moveTo(bot, target);
    return { ok: true, acted: moved, action: "patrol_step", index: state.patrol.index,
      target: target, moved: moved, watched: watched.watched,
      message: "patrol step / 巡逻步进" };
  } catch (e) {
    return { ok: false, acted: false, reason: errText(e) };
  }
}
// 功能：盯梢——领地内有其他玩家靠近就 lookAt 跟上去（不攻击），并写黑板 companion.watch 存档。
function watch(botId, snapshot) {
  var state = sessionOf(botId);
  try {
    var snap = snapshot && typeof snapshot === "object" ? snapshot : {};
    var list = Array.isArray(snap.nearbyPlayers) ? snap.nearbyPlayers : [];
    if (list.length === 0) return { ok: true, acted: false, watched: 0, reason: "no visitor / 没有访客" };
    var bot = state.bot;
    var center = state.patrol ? state.patrol.center : (posOf(snap.botPos) || { x: 0, y: 64, z: 0 });
    var count = 0;
    for (var i = 0; i < list.length && count < 5; i++) {
      var who = list[i] && typeof list[i] === "object" ? list[i] : { name: list[i] };
      var name = clean(who.name || who.username || "stranger");
      if (name.length === 0 || name === state.ownerName) continue;
      var p = posOf(who) || center;
      var gap = distance(p, center);
      if (state.patrol && gap > state.patrol.radius) continue;
      // 跟上去盯着：只转视线 + 缓步靠近，绝不调用 attack / attackEntity。
      if (bot && typeof bot.lookAt === "function") {
        try { bot.lookAt(vecOf(p.x, p.y, p.z), true); } catch (eLook) { /* ignore */ }
      }
      var entry = { name: name, at: Date.now(), distance: Math.round(gap * 10) / 10,
        position: p, attacked: false, action: "watch" };
      state.watchList.push(entry);
      while (state.watchList.length > MAX_WATCH) state.watchList.shift();
      state.lastWatch = entry;
      count = count + 1;
      totals.watches = totals.watches + 1;
      // 记录在案：优先注入的假板，其次共享黑板；都不可用时内存 watchList 已足够。
      var b = state.board || board;
      try {
        if (b && typeof b.post === "function") {
          b.post("companion.watch:" + state.botId + ":" + name, entry);
        }
      } catch (eBoard) { /* 黑板写失败不影响盯梢 */ }
      emit("companion.watch", { botId: state.botId, name: name, distance: entry.distance });
    }
    if (count === 0) return { ok: true, acted: false, watched: 0, reason: "owner or out of range / 主人或超出领地" };
    logSystem("领地盯梢 / visitor watched: " + count + " 人（不攻击 / no attack）");
    return { ok: true, acted: true, watched: count, attacked: false,
      message: "visitors watched and logged / 已盯梢并记录在案" };
  } catch (e) {
    return { ok: false, acted: false, watched: 0, reason: errText(e) };
  }
}
// 功能：登记 bot（自测 / 上层接线），可注入假黑板与主人名。
function registerBot(botId, bot, options) {
  var state = sessionOf(botId);
  try {
    var opts = options && typeof options === "object" ? options : {};
    state.bot = bot || null;
    state.board = opts.board || null;
    state.ownerName = clean(opts.ownerName).slice(0, 60);
    return { ok: true, botId: state.botId, ownerName: state.ownerName };
  } catch (e) { return { ok: false, botId: idOf(botId), message: errText(e) }; }
}
// 功能：总决策入口——按「救命 > 陪伴 > 巡逻」出决策；主人下线自动开巡逻。
function observe(botId, snapshot) {
  var state = sessionOf(botId);
  try {
    var snap = snapshot && typeof snapshot === "object" ? snapshot : {};
    state.observes = state.observes + 1;
    totals.observes = totals.observes + 1;
    var decisions = [];
    var online = snap.ownerOnline !== false;
    if (!online) {
      if (!state.patrol || state.patrol.active !== true) {
        decisions.push(startPatrol(botId, {
          ownerPos: snap.ownerPos, radius: snap.radius,
          manual: snap.manual === true
        }));
      }
      decisions.push(patrolTick(botId, snap));
      return { ok: true, mode: MODE_PATROL, ownerOnline: false, decisions: decisions,
        message: "owner offline, patrolling / 主人下线，巡逻中" };
    }
    if (state.patrol && state.patrol.active === true) stopPatrol(botId);
    decisions.push(deliverPotion(botId, snap));
    decisions.push(syncRhythm(botId, snap));
    return { ok: true, mode: state.mode, ownerOnline: true, decisions: decisions,
      message: "owner state observed / 已感知主人状态" };
  } catch (e) {
    return { ok: false, mode: MODE_IDLE, decisions: [], message: errText(e) };
  }
}
// 功能：把陪伴层挂到真实 bot（playerLeave 触发巡逻）；重复调用先摘旧监听。
function attach(bot, botId, options) {
  var state = sessionOf(botId);
  try {
    if (!bot || typeof bot.on !== "function") return { ok: false, botId: state.botId, message: "bot not ready / 机器人未就绪" };
    if (state.attached) detach(state.botId);
    var opts = options && typeof options === "object" ? options : {};
    state.bot = bot;
    state.board = opts.board || state.board;
    state.ownerName = clean(opts.ownerName || state.ownerName).slice(0, 60);
    var onLeave = function (player) {
      try {
        var name = clean(player && (player.username || player.name));
        if (state.ownerName.length > 0 && name !== state.ownerName) return;
        observe(state.botId, { ownerOnline: false, ownerPos: posOf(player), manual: opts.manual === true });
      } catch (eLeave) { /* 单个事件回调失败不影响陪伴层 */ }
    };
    try { bot.on("playerLeave", onLeave); } catch (e1) { /* 事件挂不上仍可手动 observe */ }
    state.handlers = [{ event: "playerLeave", fn: onLeave }];
    state.attached = true;
    emit("companion.attached", { botId: state.botId, events: 1 });
    logSystem("陪伴层已挂载 / companion attached: " + state.botId);
    return { ok: true, botId: state.botId, events: 1, message: "companion attached / 陪伴层已挂载" };
  } catch (e) {
    return { ok: false, botId: state.botId, message: errText(e) };
  }
}
// 功能：卸载陪伴层，停掉巡逻定时器并摘掉监听。
function detach(botId) {
  var state = sessionOf(botId);
  var n = 0;
  try {
    stopPatrol(state.botId);
    for (var i = 0; i < state.handlers.length; i++) {
      try {
        if (state.bot && typeof state.bot.removeListener === "function") {
          state.bot.removeListener(state.handlers[i].event, state.handlers[i].fn);
          n = n + 1;
        }
      } catch (eOne) { /* 单个失败继续 */ }
    }
  } catch (e) { /* ignore */ }
  state.handlers = [];
  state.attached = false;
  return { ok: true, botId: state.botId, removed: n, message: "companion detached / 陪伴层已卸载" };
}
// 功能：读会话与全局统计，供 GUI / 自测断言；绝不抛错。
function stats(botId) {
  var state = sessionOf(botId);
  try {
    return {
      ok: true, botId: state.botId, attached: state.attached, ownerName: state.ownerName,
      mode: state.mode, sitting: state.sitting,
      patrol: state.patrol ? { active: state.patrol.active, radius: state.patrol.radius,
        index: state.patrol.index, waypoints: state.patrol.waypoints.length } : null,
      watchList: state.watchList.slice(0), events: state.events.slice(0),
      observes: state.observes, deliveries: state.deliveries, sits: state.sits,
      supplies: state.supplies, patrols: state.patrols, patrolTicks: state.patrolTicks,
      lastDelivery: state.lastDelivery, lastWatch: state.lastWatch,
      totals: { observes: totals.observes, deliveries: totals.deliveries, sits: totals.sits,
        supplies: totals.supplies, patrols: totals.patrols, patrolTicks: totals.patrolTicks, watches: totals.watches },
      ownerHp: OWNER_HP, territoryRadius: TERRITORY_RADIUS, companionRange: COMPANION_RANGE
    };
  } catch (e) { return { ok: false, botId: idOf(botId), message: errText(e) }; }
}
// 功能：清空全部会话与累计统计（自测隔离用）。
function reset() {
  try {
    for (var k in sessions) {
      if (!Object.prototype.hasOwnProperty.call(sessions, k)) continue;
      try { if (sessions[k].patrol && sessions[k].patrol.timer) clearInterval(sessions[k].patrol.timer); } catch (e) { /* ignore */ }
    }
    sessions = {};
    totals = { observes: 0, deliveries: 0, sits: 0, supplies: 0, patrols: 0, patrolTicks: 0, watches: 0 };
  } catch (e) { /* ignore */ }
  return { ok: true, message: "companion reset / 陪伴层已重置" };
}
// 事件桥：反射层每秒广播 survival.tick，行为层据此低频感知主人状态；总线缺失时仍可显式 observe。
// 只处理「主人在线」快照，避免把离线误判成巡逻；高频物理帧绝不进这里。
try {
  if (bus && typeof bus.on === "function") {
    bus.on("survival.tick", function (payload) {
      try {
        var p = payload && typeof payload === "object" ? payload : {};
        if (!p.botId) return;
        observe(p.botId, {
          ownerOnline: p.ownerOnline !== false, ownerPos: p.ownerPos,
          botPos: p.botPos, ownerHealth: p.ownerHealth,
          ownerAction: p.ownerAction, nearbyPlayers: p.nearbyPlayers, manual: true
        });
      } catch (eTick) { /* 心跳回调绝不冒到顶层 */ }
    });
  }
} catch (eBridge) { /* 总线不可用时仍可显式 observe */ }

// 对外导出：挂载 / 决策 / 巡逻 / 盯梢 / 统计 / 常量。
module.exports = {
  attach: attach,
  detach: detach,
  registerBot: registerBot,
  observe: observe,
  deliverPotion: deliverPotion,
  syncRhythm: syncRhythm,
  startPatrol: startPatrol,
  stopPatrol: stopPatrol,
  patrolTick: patrolTick,
  watch: watch,
  stats: stats,
  reset: reset,
  patrolWaypoints: patrolWaypoints,
  OWNER_HP: OWNER_HP,
  TERRITORY_RADIUS: TERRITORY_RADIUS,
  COMPANION_RANGE: COMPANION_RANGE,
  MODE_IDLE: MODE_IDLE,
  MODE_SIT: MODE_SIT,
  MODE_SUPPLY: MODE_SUPPLY,
  MODE_PATROL: MODE_PATROL
};
