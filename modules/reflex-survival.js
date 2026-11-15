// ========================================
// 文件：modules/reflex-survival.js
// 功能：生存党 Tick 级微操反射层——极限 MLG（落地水 / 船）、PvP 跳跃重置、
//       引燃 Creeper 贴身防爆盾；挂 bot.physicsTick（20tps）与 entityHurt，全程本地无 AI 请求
// 依赖：vec3、./actions、./radar、./event-bus、./logger（均可选，缺失时安全降级）
// 导出：attach / detach / registerBot / simulatePhysicsTick / simulateHurt / scanCreeper /
//       stats / reset / TPS / FALL_VELOCITY / GROUND_SCAN / CREEPER_RADIUS
// 作者：MineBots
// ========================================
//
// 物理级链路 / physics-level chain：
//   1. physicsTick → 读 bot.entity.velocity.y 与 owner 实体速度，vy < -0.8 判定急坠；
//   2. bot.blockAt 逐格向下扫 ≤3 格找地面 / 岩浆，毫秒级算出落点；
//   3. bot.equip(water_bucket|boat, "hand") → bot.placeBlock(groundBlock, vec(0,1,0)) 放落点；
//   4. entityHurt → bot.setControlState("jump", true) + 向后拉扯，取消受击硬直；
//   5. 3 格内引燃 Creeper → 打断当前动作、副手 equip(shield)、站到主人与 Creeper 之间。
// 所有 mineflayer API 都先判空再调用，返回 Promise 的动作不 await（Tick 级不能等网络），
//   失败只写日志并计数，绝不抛到顶层；定时器一律 unref。
// 测试隔离：全部状态在内存 sessions 里，reset() 清空，不写 state/、不联网。
// ES5 风格，CommonJS，无中文变量名。

// 可选依赖：vec3 构造 blockAt / placeBlock 需要的坐标对象；缺失时降级为普通对象。
var vecLib = null;
try { vecLib = require("vec3"); } catch (e) { vecLib = null; }
// 可选依赖：基础动作门面（防爆盾走位）；缺失时退回 setControlState。
var actions = null;
try { actions = require("./actions"); } catch (e) { actions = null; }
// 可选依赖：2D 雷达（实体列表）；缺失时直接读 bot.entities。
var radar = null;
try { radar = require("./radar"); } catch (e) { radar = null; }
// 可选依赖：事件总线（低频事件广播）。
var bus = null;
try { bus = require("./event-bus"); } catch (e) { bus = null; }
// 可选依赖：日志核心；高频 tick 只写文件，低频救命事件推 GUI。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
// 可选依赖：情感引擎（物理帧同步血量饥饿进 System Prompt）；缺失时只跳过同步。
var emotion = null;
try { emotion = require("./emotion-trust"); } catch (e) { emotion = null; }
// 可选依赖：玩家等级表（受击时判定亲密朋友，触发告状而非反击）；缺失时按普通战斗处理。
var players = null;
try { players = require("./player-manager"); } catch (e) { players = null; }

// 常量：Minecraft 物理帧 20tps / 急坠阈值 / 向下扫描格数 / Creeper 警戒半径 / 事件环上限。
var TPS = 20;
var FALL_VELOCITY = -0.8;
var GROUND_SCAN = 3;
var CREEPER_RADIUS = 3;
var MAX_EVENTS = 40;
// 常量：MLG 冷却（毫秒），防同一次下落连放多桶水。
var MLG_COOLDOWN_MS = 900;
// 常量：跳跃重置的拉扯时长（毫秒），定时器 unref 后释放控制状态。
var JUMP_HOLD_MS = 120;
// 常量：可用来 MLG 的物品（水桶优先，其次各类船）与盾牌名。
var MLG_ITEMS = ["water_bucket", "boat", "oak_boat", "spruce_boat", "birch_boat", "acacia_boat", "dark_oak_boat", "mangrove_boat"];
var SHIELD_ITEM = "shield";
// 常量：地面判定里视为「不能落脚」的方块名前缀（空气类）与危险液体。
var AIR_WORDS = ["air", "cave_air", "void_air"];

// 运行时状态：botId → 会话。
var sessions = {};
// 进程内累计统计（reset 清零），供 GUI / 自测读取。
var totals = { ticks: 0, mlg: 0, jumpResets: 0, shields: 0, hurts: 0, creeperScans: 0, blocked: 0 };

// 写文件日志：物理帧属高频，只落文件，绝不刷 GUI。
function logInfo(msg) {
  try { if (logger && typeof logger.info === "function") logger.info("[reflex-survival] " + msg); } catch (e) { /* ignore */ }
}
// 写系统日志：MLG / 举盾这类低频救命事件推 GUI，中英双语。
function logSystem(msg) {
  try {
    if (logger && typeof logger.system === "function") { logger.system("[reflex-survival] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[reflex-survival] " + msg); } catch (e2) { /* ignore */ }
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
// 规范化 botId；坏值退回 default。
function idOf(botId) {
  try {
    var s = String(botId === null || botId === undefined ? "" : botId).replace(/^\s+|\s+$/g, "");
    return s.length === 0 ? "default" : s.slice(0, 80);
  } catch (e) { return "default"; }
}
// 记录一条会话事件（环形上限）。
function record(state, text) {
  try {
    state.events.push({ at: Date.now(), text: String(text) });
    while (state.events.length > MAX_EVENTS) state.events.shift();
  } catch (e) { /* ignore */ }
}
// 新建或取回会话；重复调用不覆盖已有统计。
function sessionOf(botId) {
  var id = idOf(botId);
  if (!sessions[id]) {
    sessions[id] = {
      botId: id, bot: null, attached: false, handlers: [], ownerName: "",
      lastMlgAt: 0, events: [],
      ticks: 0, mlg: 0, jumpResets: 0, hurts: 0, shields: 0, blocked: 0,
      lastMlg: null, lastJump: null, lastShield: null
    };
  }
  return sessions[id];
}
// 构造坐标对象：优先 vec3，缺失时用普通对象（mineflayer 与假 bot 都认 x/y/z）。
function vecOf(x, y, z) {
  try {
    if (vecLib) {
      if (typeof vecLib === "function") return vecLib(x, y, z);
      if (vecLib.Vec3 && typeof vecLib.Vec3 === "function") return new vecLib.Vec3(x, y, z);
    }
  } catch (e) { /* 降级为普通对象 */ }
  return { x: x, y: y, z: z };
}
// 读方块名：block 可能是字符串或对象，取不到返回空串。
function blockName(block) {
  try {
    if (!block) return "";
    if (typeof block === "string") return block;
    return String(block.name || block.type || "");
  } catch (e) { return ""; }
}
// 判断方块是不是空气类（不能落脚）。
function isAir(block) {
  var name = blockName(block).toLowerCase();
  if (name.length === 0) return true;
  for (var i = 0; i < AIR_WORDS.length; i++) if (name.indexOf(AIR_WORDS[i]) === 0) return true;
  return false;
}
// 判断方块是不是岩浆 / 岩浆海（危险落点，同样需要 MLG）。
function isLava(block) {
  return blockName(block).toLowerCase().indexOf("lava") >= 0;
}
// 安全调用返回 Promise 的 bot 动作：不 await，用 catch 吞掉 rejection，绝不 unhandled。
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
// 安全设置控制状态；bot 缺失或 API 不存在时返回 false。
function setControl(bot, name, on) {
  try {
    if (!bot || typeof bot.setControlState !== "function") return false;
    bot.setControlState(name, on === true);
    return true;
  } catch (e) { return false; }
}
// 从背包找指定名字列表里的物品：返回 item 对象或 null。
function findItem(bot, names) {
  try {
    if (!bot || !bot.inventory || typeof bot.inventory.items !== "function") return null;
    var list = bot.inventory.items() || [];
    for (var n = 0; n < names.length; n++) {
      for (var i = 0; i < list.length; i++) {
        var it = list[i];
        if (!it) continue;
        var nm = String(it.name || "").toLowerCase();
        if (nm === names[n] || nm.indexOf(names[n]) >= 0) return it;
      }
    }
  } catch (e) { /* 背包读失败按没物品处理 */ }
  return null;
}
// 读一个实体的位置（兼容 position / pos / entity.position）。
function posOf(obj) {
  try {
    if (!obj) return null;
    var p = obj.position || obj.pos || (obj.entity && obj.entity.position) || null;
    if (!p) return null;
    var x = toNum(p.x, NaN), y = toNum(p.y, NaN), z = toNum(p.z, NaN);
    if (isNaN(x) || isNaN(y) || isNaN(z)) return null;
    return { x: x, y: y, z: z };
  } catch (e) { return null; }
}
// 读一个实体的下落速度（兼容 velocity / entity.velocity / 直接 vy）。
function velocityOf(obj) {
  try {
    if (!obj) return 0;
    var v = obj.velocity || (obj.entity && obj.entity.velocity) || null;
    if (v) return toNum(v.y, 0);
    return toNum(obj.vy, 0);
  } catch (e) { return 0; }
}
// 两点距离（3D 欧氏）。
function distance(a, b) {
  var dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
// 功能：算出急坠目标的落点——从脚下逐格向下扫 ≤3 格找第一个可落脚 / 岩浆方块。
function landingOf(bot, pos, depth) {
  try {
    if (!bot || typeof bot.blockAt !== "function" || !pos) return null;
    var max = toNum(depth, GROUND_SCAN);
    if (max < 1) max = 1;
    if (max > 8) max = 8;
    var bx = Math.floor(pos.x), bz = Math.floor(pos.z), by = Math.floor(pos.y);
    for (var d = 0; d <= max; d++) {
      var block = bot.blockAt(vecOf(bx, by - d, bz));
      if (isAir(block)) continue;
      return {
        ground: block,
        distance: d,
        lava: isLava(block),
        blockName: blockName(block),
        pos: { x: bx + 0.5, y: by - d + 1, z: bz + 0.5 },
        groundY: by - d
      };
    }
  } catch (e) { /* 方块读取失败按没落点处理 */ }
  return null;
}
// 功能：极限 MLG——急坠且 3 格内有落点时，切水桶 / 船并 bot.placeBlock 放在落点。
function tryMlg(state, target, now) {
  var empty = { ok: false, acted: false, reason: "not falling / 未急坠" };
  try {
    var bot = state.bot;
    if (!bot) return { ok: false, acted: false, reason: "bot not ready / 机器人未就绪" };
    var pos = posOf(target);
    if (!pos) return { ok: false, acted: false, reason: "no position / 无坐标" };
    var vy = velocityOf(target);
    if (!(vy < FALL_VELOCITY)) return empty;
    if (now - state.lastMlgAt < MLG_COOLDOWN_MS) {
      state.blocked = state.blocked + 1;
      totals.blocked = totals.blocked + 1;
      return { ok: true, acted: false, reason: "cooldown / 冷却中", velocityY: vy };
    }
    var landing = landingOf(bot, pos, GROUND_SCAN);
    if (!landing) return { ok: true, acted: false, reason: "no landing within 3 / 3 格内无落点", velocityY: vy };
    var item = findItem(bot, MLG_ITEMS);
    if (!item) return { ok: true, acted: false, reason: "no water bucket or boat / 背包无水桶或船", velocityY: vy };
    var itemName = String(item.name || "water_bucket");
    // 毫秒级：同一物理帧内完成装备 + 放置，不 await 网络回包。
    var equipped = fire(bot, "equip", [item, "hand"]);
    var placed = fire(bot, "placeBlock", [landing.ground, vecOf(0, 1, 0)]);
    state.lastMlgAt = now;
    state.mlg = state.mlg + 1;
    totals.mlg = totals.mlg + 1;
    var info = {
      ok: true, acted: placed === true, action: "mlg", item: itemName,
      target: target && target.label ? target.label : "self",
      velocityY: vy, distance: landing.distance, lava: landing.lava,
      groundBlock: landing.blockName, landing: landing.pos,
      equipped: equipped, placed: placed, at: now,
      message: "MLG 已放水 / water placed at landing"
    };
    state.lastMlg = info;
    record(state, "MLG " + itemName + " -> " + JSON.stringify(landing.pos));
    emit("reflex.mlg", { botId: state.botId, item: itemName, landing: landing.pos, distance: landing.distance });
    logSystem("极限 MLG / MLG save: " + itemName + " 落点 " + landing.pos.x + "," + landing.pos.y + "," + landing.pos.z +
      " 距地 " + landing.distance + " 格 / " + landing.distance + " blocks");
    return info;
  } catch (e) {
    return { ok: false, acted: false, reason: errText(e) };
  }
}
// 功能：处理一个物理帧——同时检查 bot 自己与主人的下落速度，任一急坠就尝试 MLG。
function handlePhysics(botId, snapshot) {
  var state = sessionOf(botId);
  try {
    state.ticks = state.ticks + 1;
    totals.ticks = totals.ticks + 1;
    var now = Date.now();
    var snap = snapshot && typeof snapshot === "object" ? snapshot : {};
    var bot = state.bot;
    var results = [];
    // 每 20 帧（约 1 秒）把真实血量 / 饥饿喂给情感引擎，供 AI System Prompt 注入；高频只写内存。
    if (bot && emotion && typeof emotion.setBotState === "function" && state.ticks % TPS === 0) {
      try { emotion.setBotState({ health: bot.health, food: bot.food }); } catch (eVitals) { /* 状态同步失败不影响物理帧 */ }
    }
    // 每秒一拍的陪伴心跳：把主人在线 / 坐标交给行为层，绝不刷屏（20tps → 1Hz）。
    if (state.ticks % TPS === 0) {
      var ownerEnt = bot && bot.players && state.ownerName ? bot.players[state.ownerName] : null;
      emit("survival.tick", {
        botId: state.botId, ownerOnline: !!ownerEnt,
        ownerPos: posOf(ownerEnt), botPos: posOf(bot && bot.entity),
        ownerHealth: snap.ownerHealth, ownerAction: snap.ownerAction,
        nearbyPlayers: snap.nearbyPlayers
      });
    }
    // 自己：优先用快照覆盖，便于离线自测；没有快照就读 bot.entity。
    var me = snap.self || (bot && bot.entity) || null;
    if (me) {
      var selfTarget = { position: posOf(me), velocity: { y: toNum(me.vy !== undefined ? me.vy : velocityOf(me), 0) }, label: "self" };
      results.push(tryMlg(state, selfTarget, now));
    }
    // 主人：ownerName 命中 bot.players 时读实体；快照可直接给 owner。
    var owner = snap.owner || null;
    if (!owner && bot && bot.players && state.ownerName) {
      owner = bot.players[state.ownerName] || null;
    }
    if (owner) {
      owner.label = "owner";
      results.push(tryMlg(state, owner, now));
    }
    // Creeper 检测按每 4 帧一次，避免 20tps 高频刷屏。
    if (state.ticks % 4 === 0) checkCreeper(state, snap);
    return { ok: true, ticks: state.ticks, results: results, message: "physics tick / 物理帧" };
  } catch (e) {
    return { ok: false, ticks: state.ticks, results: [], message: errText(e) };
  }
}
// 功能：受击瞬间跳跃重置——jump + 向后拉扯，短延时后释放控制状态（定时器 unref）。
function handleHurt(botId, payload) {
  var state = sessionOf(botId);
  try {
    state.hurts = state.hurts + 1;
    totals.hurts = totals.hurts + 1;
    var info = payload && typeof payload === "object" ? payload : {};
    var bot = state.bot;
    var jumped = setControl(bot, "jump", true);
    var pulled = setControl(bot, "back", true);
    // 受击硬直取消：向前冲刺键先松开再重新置位，避免被击退锁死。
    setControl(bot, "forward", false);
    var out = {
      ok: true, action: "jump_reset", jumped: jumped, pulledBack: pulled,
      source: String(info.source || info.attacker || "unknown"), at: Date.now(),
      complaint: false, retaliate: true, counterAttack: true, fled: false, chat: "",
      message: "跳跃重置 / jump reset fired"
    };
    // 社交层：攻击者是玩家时走等级表决策——close_friend 只告状、绝不拔剑反击。
    if (info.playerAttack === true && out.source !== "unknown" && players &&
        typeof players.onBotAttacked === "function") {
      try {
        var ownerPos = null;
        if (bot && bot.players && state.ownerName && bot.players[state.ownerName]) {
          ownerPos = posOf(bot.players[state.ownerName]);
        }
        var social = players.onBotAttacked(out.source, {
          level: info.level, bot: bot, ownerPosition: ownerPos, actions: actions
        });
        if (social && social.ok === true) {
          out.retaliate = social.retaliate !== false;
          out.counterAttack = out.retaliate;
          out.complaint = social.complaint === true;
          out.fled = social.fled === true;
          out.chat = String(social.chat || "");
          if (out.complaint) {
            record(state, "complaint instead of counter attack / 告状未反击: " + out.source);
            emit("reflex.complaint", { botId: state.botId, attacker: out.source, chat: out.chat });
            logSystem("亲密朋友误伤，告状不拔剑 / reported instead of fighting: " + out.source);
          }
        }
      } catch (eSocial) { /* 等级决策失败不影响物理反射 */ }
    }
    state.lastJump = out;
    state.jumpResets = state.jumpResets + 1;
    totals.jumpResets = totals.jumpResets + 1;
    record(state, "jump_reset from " + out.source);
    emit("reflex.jump_reset", { botId: state.botId, source: out.source });
    logInfo("跳跃重置 / jump_reset: " + state.botId + " source=" + out.source);
    // 释放控制状态：定时器 unref，绝不拖住进程；假 bot 无该 API 时静默跳过。
    try {
      var timer = setTimeout(function () {
        setControl(state.bot, "jump", false);
        setControl(state.bot, "back", false);
      }, JUMP_HOLD_MS);
      if (timer && timer.unref) timer.unref();
    } catch (eTimer) { /* 释放失败不影响本次反射 */ }
    return out;
  } catch (e) {
    return { ok: false, action: "jump_reset", message: errText(e) };
  }
}
// 功能：判断实体是不是「已引燃的 Creeper」；兼容 metadata 数组 / 对象与直接标志位。
function isIgnitedCreeper(ent) {
  try {
    if (!ent || typeof ent !== "object") return false;
    var name = String(ent.name || ent.displayName || ent.mobType || "").toLowerCase();
    if (name.indexOf("creeper") < 0) return false;
    if (ent.ignited === true || ent.isIgnited === true || ent.creeperIgnited === true) return true;
    var md = ent.metadata;
    if (!md) return false;
    if (md.ignited === true || md.isIgnited === true || md.creeperIgnited === true) return true;
    if (Array.isArray(md) && (md[16] === 1 || md[16] === true || md[17] === 1 || md[17] === true)) return true;
    if (typeof md.fuse === "number" && md.fuse > 0) return true;
  } catch (e) { /* 元数据异常按未引燃处理 */ }
  return false;
}
// 功能：取实体列表——优先雷达快照，其次 bot.entities，坏值返回空数组。
function entityList(state, snap) {
  var out = [];
  try {
    if (snap && Array.isArray(snap.entities)) return snap.entities;
    if (radar && typeof radar.snapshot === "function" && state.bot) {
      var shot = radar.snapshot();
      if (shot && Array.isArray(shot.entities) && shot.entities.length > 0) return shot.entities;
    }
    var map = state.bot && state.bot.entities ? state.bot.entities : null;
    if (!map) return out;
    var keys = Object.keys(map);
    for (var i = 0; i < keys.length; i++) if (map[keys[i]]) out.push(map[keys[i]]);
  } catch (e) { /* 实体读取失败按空处理 */ }
  return out;
}
// 功能：打断当前动作（寻路目标 + 控制状态），让防爆盾能立刻接管。
function interrupt(bot) {
  var done = false;
  try {
    if (bot && bot.pathfinder && typeof bot.pathfinder.setGoal === "function") {
      bot.pathfinder.setGoal(null);
      done = true;
    }
  } catch (e) { /* 插件缺失时退回清控制状态 */ }
  try {
    var names = ["forward", "back", "left", "right", "sprint"];
    for (var i = 0; i < names.length; i++) if (setControl(bot, names[i], false)) done = true;
  } catch (e2) { /* ignore */ }
  return done;
}
// 功能：贴身防爆盾——3 格内引燃 Creeper 时打断动作、副手举盾、挡在主人与 Creeper 之间。
function checkCreeper(state, snap) {
  try {
    totals.creeperScans = totals.creeperScans + 1;
    var bot = state.bot;
    if (!bot) return { ok: false, acted: false, reason: "bot not ready / 机器人未就绪" };
    var botPos = posOf(snap && snap.self) || posOf(bot && bot.entity) || { x: 0, y: 0, z: 0 };
    var ownerPos = posOf(snap && snap.owner) || botPos;
    var list = entityList(state, snap);
    var found = null, best = CREEPER_RADIUS + 1;
    for (var i = 0; i < list.length; i++) {
      var ent = list[i];
      if (!isIgnitedCreeper(ent)) continue;
      var p = posOf(ent);
      if (!p) continue;
      var d = Math.min(distance(p, ownerPos), distance(p, botPos));
      if (d <= CREEPER_RADIUS && d < best) { best = d; found = { entity: ent, pos: p, distance: d }; }
    }
    if (!found) return { ok: true, acted: false, reason: "no ignited creeper / 无引燃 Creeper" };
    // 站位点：主人到 Creeper 连线上、靠主人 0.65 处（挡在中间）。
    var gx = ownerPos.x + (found.pos.x - ownerPos.x) * 0.65;
    var gy = ownerPos.y + (found.pos.y - ownerPos.y) * 0.65;
    var gz = ownerPos.z + (found.pos.z - ownerPos.z) * 0.65;
    var guardPos = { x: Math.round(gx * 10) / 10, y: Math.round(gy * 10) / 10, z: Math.round(gz * 10) / 10 };
    var stopped = interrupt(bot);
    var shield = findItem(bot, [SHIELD_ITEM]);
    var equipped = shield ? fire(bot, "equip", [shield, "off-hand"]) : false;
    var raised = fire(bot, "activateItem", [true]);
    if (typeof bot.lookAt === "function") { try { bot.lookAt(vecOf(found.pos.x, found.pos.y, found.pos.z), true); } catch (eLook) { /* ignore */ } }
    var moved = false;
    if (actions && typeof actions.moveTo === "function") {
      try { actions.moveTo(bot, guardPos.x, guardPos.y, guardPos.z); moved = true; } catch (eMove) { moved = false; }
    }
    if (!moved) moved = setControl(bot, "forward", true);
    state.shields = state.shields + 1;
    totals.shields = totals.shields + 1;
    var out = {
      ok: true, acted: true, action: "creeper_shield",
      distance: Math.round(found.distance * 10) / 10,
      interrupted: stopped, shieldEquipped: equipped, raised: raised, moved: moved,
      creeper: found.pos, owner: ownerPos, guardPos: guardPos,
      attacked: false,
      message: "贴身防爆盾 / body shield between owner and creeper"
    };
    state.lastShield = out;
    record(state, "creeper_shield d=" + out.distance);
    emit("reflex.creeper_shield", { botId: state.botId, distance: out.distance, guardPos: guardPos });
    logSystem("贴身防爆盾 / creeper shield: 距离 " + out.distance + " 格，挡位 " +
      guardPos.x + "," + guardPos.y + "," + guardPos.z + " / guard position");
    return out;
  } catch (e) {
    return { ok: false, acted: false, reason: errText(e) };
  }
}
// 功能：登记一个 bot（自测 / 上层接线用），可指定主人名；返回 { ok, botId }。
function registerBot(botId, bot, options) {
  var state = sessionOf(botId);
  try {
    var opts = options && typeof options === "object" ? options : {};
    state.bot = bot || null;
    state.ownerName = String(opts.ownerName || "").slice(0, 60);
    return { ok: true, botId: state.botId, ownerName: state.ownerName };
  } catch (e) { return { ok: false, botId: idOf(botId), message: errText(e) }; }
}
// 功能：把反射层挂到真实 bot 的 physicsTick（20tps）与 entityHurt；重复调用先摘旧监听。
function attach(bot, botId, options) {
  var state = sessionOf(botId);
  try {
    if (!bot || typeof bot.on !== "function") return { ok: false, botId: state.botId, message: "bot not ready / 机器人未就绪" };
    if (state.attached) detach(state.botId);
    var opts = options && typeof options === "object" ? options : {};
    state.bot = bot;
    state.ownerName = String(opts.ownerName || state.ownerName || "").slice(0, 60);
    var onPhysics = function () { handlePhysics(state.botId, null); };
    // entityHurt 的 payload 可能是实体对象或事件体：统一成 { source, playerAttack, level }。
    var onHurt = function (payload) {
      try {
        var p = payload && typeof payload === "object" ? payload : {};
        var ent = p.entity && typeof p.entity === "object" ? p.entity : p;
        var name = String(ent.username || ent.name || p.source || p.attacker || "unknown");
        var isPlayer = ent.username !== undefined || ent.type === "player" || p.playerAttack === true;
        handleHurt(state.botId, {
          source: name, playerAttack: isPlayer === true,
          level: p.level || (players && typeof players.getLevel === "function" ? players.getLevel(name) : "")
        });
      } catch (eHurt) { handleHurt(state.botId, { source: "unknown" }); }
    };
    try { bot.on("physicsTick", onPhysics); } catch (e1) { /* 单事件挂不上不影响另一个 */ }
    try { bot.on("entityHurt", onHurt); } catch (e2) { /* 同上 */ }
    state.handlers = [{ event: "physicsTick", fn: onPhysics }, { event: "entityHurt", fn: onHurt }];
    state.attached = true;
    emit("reflex.survival.attached", { botId: state.botId, events: 2 });
    logSystem("生存反射层已挂载 / survival reflex attached: " + state.botId + " (20tps)");
    return { ok: true, botId: state.botId, events: 2, tps: TPS, message: "survival reflex attached / 生存反射层已挂载" };
  } catch (e) {
    return { ok: false, botId: state.botId, message: errText(e) };
  }
}
// 功能：卸载反射层并摘掉监听，返回摘掉的句柄数。
function detach(botId) {
  var state = sessionOf(botId);
  var n = 0;
  try {
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
  return { ok: true, botId: state.botId, removed: n, message: "survival reflex detached / 生存反射层已卸载" };
}
// 功能：离线注入一个物理帧（自测 / 假 bot 用），可给 self / owner / entities 快照。
function simulatePhysicsTick(botId, snapshot) {
  return handlePhysics(botId, snapshot);
}
// 功能：离线注入一次受击（自测 / 假 bot 用），返回跳跃重置结果。
function simulateHurt(botId, payload) {
  return handleHurt(botId, payload);
}
// 功能：离线扫描一次 Creeper（自测 / 假 bot 用），返回防爆盾结果。
function scanCreeper(botId, snapshot) {
  return checkCreeper(sessionOf(botId), snapshot || {});
}
// 功能：读会话与全局统计，供 GUI / 自测断言；绝不抛错。
function stats(botId) {
  var state = sessionOf(botId);
  try {
    return {
      ok: true, botId: state.botId, attached: state.attached, ownerName: state.ownerName,
      ticks: state.ticks, mlg: state.mlg, jumpResets: state.jumpResets,
      hurts: state.hurts, shields: state.shields, blocked: state.blocked,
      lastMlg: state.lastMlg, lastJump: state.lastJump, lastShield: state.lastShield,
      events: state.events.slice(0),
      totals: { ticks: totals.ticks, mlg: totals.mlg, jumpResets: totals.jumpResets,
        shields: totals.shields, hurts: totals.hurts, creeperScans: totals.creeperScans, blocked: totals.blocked },
      tps: TPS, fallVelocity: FALL_VELOCITY, groundScan: GROUND_SCAN, creeperRadius: CREEPER_RADIUS
    };
  } catch (e) { return { ok: false, botId: idOf(botId), message: errText(e) }; }
}
// 功能：清空全部会话与累计统计（自测隔离用）。
function reset() {
  try {
    sessions = {};
    totals = { ticks: 0, mlg: 0, jumpResets: 0, shields: 0, hurts: 0, creeperScans: 0, blocked: 0 };
  } catch (e) { /* ignore */ }
  return { ok: true, message: "survival reflex reset / 生存反射层已重置" };
}
// 对外导出：挂载 / 模拟 / 扫描 / 统计 / 常量。
module.exports = {
  attach: attach,
  detach: detach,
  registerBot: registerBot,
  simulatePhysicsTick: simulatePhysicsTick,
  simulateHurt: simulateHurt,
  scanCreeper: scanCreeper,
  stats: stats,
  reset: reset,
  TPS: TPS,
  FALL_VELOCITY: FALL_VELOCITY,
  GROUND_SCAN: GROUND_SCAN,
  CREEPER_RADIUS: CREEPER_RADIUS,
  MLG_ITEMS: MLG_ITEMS
};
