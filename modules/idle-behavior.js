// ========================================
// 文件：modules/idle-behavior.js
// 功能：待机行为——空闲超过 10 秒就从动作池随机挑一个动作执行，避免站桩像掉线
// 依赖：./logger（可选）
// 导出：startIdle / stopIdle
// 作者：MineBots
// ========================================

// 可选依赖：日志模块，只用 info / warn；缺失时全部静默。
var logger = null;
try { logger = require("./logger"); } catch (err) { logger = null; }

// 常量：超过多少毫秒没有动作算「空闲」。
var IDLE_THRESHOLD_MS = 10000;
// 常量：空闲检查节拍（毫秒）。
var TICK_MS = 2000;
// 常量：动作池——跳跃 / 潜行 / 环顾 / 短距离走位。
var ACTION_POOL = ["jump", "sneak", "look_around", "walk_short"];
// 常量：各动作的持续时间（毫秒）。
var JUMP_MS = 250;
var SNEAK_MS = 600;
var WALK_MS = 800;
// 常量：动作之间的冷却，防止连发。
var ACTION_COOLDOWN_MS = 600;

// 写普通信息日志：只落文件，不推 GUI（待机行为本身不是重要事件）。
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

// 把异常对象拍成一行文本，保证日志里不出现 undefined。
function errText(err) {
  try {
    if (!err) return "unknown error / 未知错误";
    if (typeof err === "string") return err;
    if (err.message) return String(err.message);
    return String(err);
  } catch (e) { return "unknown error / 未知错误"; }
}

// 给 bot 起一个可读标签，用于日志。
function label(bot) {
  try {
    if (!bot) return "bot";
    if (bot.username) return String(bot.username);
    if (bot.id) return String(bot.id);
  } catch (err) { /* ignore */ }
  return "bot";
}

// 统一的「机器人未就绪」返回体。
function notReady(action) {
  var msg = "bot not ready / 机器人未就绪";
  logWarn("[idle] " + action + " -> " + msg);
  return { ok: false, action: action, code: "BOT_NOT_READY", message: msg };
}

// 统一的「执行失败」返回体。
function failure(action, err) {
  var msg = "failed / 执行失败: " + errText(err);
  logWarn("[idle] " + action + " -> " + msg);
  return { ok: false, action: action, code: "FAILED", message: msg };
}

// 刷新最后活跃时间：任何真实动作 / 事件都算「不空闲」。
function touch(state) {
  try {
    if (state) state.lastActive = Date.now();
  } catch (err) { /* ignore */ }
}

// 注册一个「有动作」事件监听，事件触发就刷新活跃时间；失败只返回 false。
function attachIdleEvent(bot, state, eventName) {
  try {
    if (!bot || typeof bot.on !== "function" || !state) return false;
    var handler = function () { touch(state); };
    bot.on(eventName, handler);
    state.handlers.push({ event: eventName, handler: handler });
    return true;
  } catch (err) { return false; }
}

// 延时执行一次操作并在完成后释放控制键；定时器 unref，绝不拖住进程退出。
function releaseLater(bot, control, holdMs, state) {
  try {
    var t = setTimeout(function () {
      try { if (bot && typeof bot.setControlState === "function") bot.setControlState(control, false); } catch (e1) { /* ignore */ }
      try { if (state) state.busy = false; } catch (e2) { /* ignore */ }
    }, holdMs);
    if (t && t.unref) t.unref();
    return true;
  } catch (err) { return false; }
}
// 动作：跳一下——按住 jump 到 JUMP_MS 后由 releaseLater 松开。
function doJump(bot, state) {
  try {
    if (!bot || typeof bot.setControlState !== "function") return false;
    bot.setControlState("jump", true);
    releaseLater(bot, "jump", JUMP_MS, state);
    touch(state);
    return true;
  } catch (err) {
    try { state.busy = false; } catch (e1) { /* ignore */ }
    return false;
  }
}

// 动作：潜行一下——按住 sneak 到 SNEAK_MS 后松开，看起来像在「蹲着观察」。
function doSneak(bot, state) {
  try {
    if (!bot || typeof bot.setControlState !== "function") return false;
    bot.setControlState("sneak", true);
    releaseLater(bot, "sneak", SNEAK_MS, state);
    touch(state);
    return true;
  } catch (err) {
    try { state.busy = false; } catch (e1) { /* ignore */ }
    return false;
  }
}

// 动作：环顾四周——随机水平朝向 + 轻微俯仰，需要 bot.look 可用。
function doLookAround(bot, state) {
  try {
    if (!bot || typeof bot.look !== "function") return false;
    var yaw = Math.random() * Math.PI * 2 - Math.PI;
    var pitch = (Math.random() - 0.5) * 0.6;
    bot.look(yaw, pitch, false);
    touch(state);
    var t = setTimeout(function () { try { if (state) state.busy = false; } catch (e1) { /* ignore */ } }, ACTION_COOLDOWN_MS);
    if (t && t.unref) t.unref();
    return true;
  } catch (err) {
    try { state.busy = false; } catch (e1) { /* ignore */ }
    return false;
  }
}

// 动作：短距离走位——随机方向按住 WALK_MS，然后松开。
function doWalkShort(bot, state) {
  try {
    if (!bot || typeof bot.setControlState !== "function") return false;
    var dirs = ["forward", "back", "left", "right"];
    var dir = dirs[Math.floor(Math.random() * dirs.length)];
    bot.setControlState(dir, true);
    releaseLater(bot, dir, WALK_MS, state);
    touch(state);
    return true;
  } catch (err) {
    try { state.busy = false; } catch (e1) { /* ignore */ }
    return false;
  }
}

// 从动作池里随机挑一个，避免连续两次挑到同一个动作。
function pickAction(state) {
  try {
    var pool = state && state.pool && state.pool.length ? state.pool : ACTION_POOL;
    if (pool.length === 1) return String(pool[0]);
    var idx = Math.floor(Math.random() * pool.length);
    if (pool[idx] === state.lastAction) idx = (idx + 1) % pool.length;
    return String(pool[idx]);
  } catch (err) { return "jump"; }
}

// 执行指定动作名：返回 true 表示真的发起了动作，false 表示被跳过。
function executeAction(bot, state, name) {
  try {
    if (name === "jump") return doJump(bot, state);
    if (name === "sneak") return doSneak(bot, state);
    if (name === "look_around") return doLookAround(bot, state);
    if (name === "walk_short") return doWalkShort(bot, state);
    return false;
  } catch (err) { return false; }
}

// 空闲检查节拍：空闲超过 10 秒就执行一个随机动作，执行完再由 releaseLater 解锁。
function tick(bot, state) {
  try {
    if (!state || state.stopped === true) return;
    if (!bot) return;
    if (state.busy === true) return;
    var idleMs = Date.now() - Number(state.lastActive || 0);
    if (idleMs < IDLE_THRESHOLD_MS) return;
    state.busy = true;
    var name = pickAction(state);
    state.lastAction = name;
    state.count = Number(state.count || 0) + 1;
    var ok = executeAction(bot, state, name);
    if (!ok) state.busy = false;
    logInfo("[idle] " + label(bot) + " idle " + Math.round(idleMs / 1000) + "s -> " + name +
      (ok ? " ok / 已执行" : " skipped / 已跳过"));
    touch(state);
  } catch (err) {
    try { if (state) state.busy = false; } catch (e1) { /* ignore */ }
  }
}
// 启动待机行为：挂事件监听 + 2 秒检查节拍；重复启动回失败体，不抛错。
function startIdle(bot, options) {
  var action = "startIdle";
  try {
    if (!bot) return notReady(action);
    var opt = options && typeof options === "object" ? options : {};
    var existed = bot._mbIdle || null;
    if (existed && existed.timer) {
      return { ok: false, action: action, code: "ALREADY_RUNNING", message: "idle already running / 待机行为已在运行" };
    }
    var state = {
      timer: null,
      lastActive: Date.now(),
      lastAction: "",
      count: 0,
      busy: false,
      stopped: false,
      pool: (opt.pool && opt.pool.length ? opt.pool : ACTION_POOL).slice(0),
      handlers: []
    };
    var events = ["move", "chat", "health", "diggingCompleted", "playerCollect", "death"];
    for (var i = 0; i < events.length; i++) attachIdleEvent(bot, state, events[i]);
    state.timer = setInterval(function () { tick(bot, state); }, TICK_MS);
    if (state.timer && state.timer.unref) state.timer.unref();
    bot._mbIdle = state;
    logInfo("[idle] start / 待机行为已启动: " + label(bot) + " pool=" + state.pool.join(","));
    return { ok: true, action: action, pool: state.pool, thresholdMs: IDLE_THRESHOLD_MS, tickMs: TICK_MS };
  } catch (err) { return failure(action, err); }
}

// 停止待机行为：清定时器、摘掉事件监听、松开控制键；未启动时也返回 ok。
function stopIdle(bot) {
  var action = "stopIdle";
  try {
    if (!bot) return notReady(action);
    var state = bot._mbIdle || null;
    if (!state) {
      return { ok: true, action: action, count: 0, message: "idle not running / 待机行为未启动" };
    }
    state.stopped = true;
    try { if (state.timer) clearInterval(state.timer); } catch (e1) { /* ignore */ }
    state.timer = null;
    var hands = state.handlers || [];
    for (var i = 0; i < hands.length; i++) {
      try {
        if (typeof bot.removeListener === "function") bot.removeListener(hands[i].event, hands[i].handler);
      } catch (e2) { /* ignore */ }
    }
    state.handlers = [];
    try { if (typeof bot.clearControlStates === "function") bot.clearControlStates(); } catch (e3) { /* ignore */ }
    try { bot._mbIdle = null; } catch (e4) { /* ignore */ }
    logInfo("[idle] stop / 待机行为已停止: " + label(bot) + " actions=" + Number(state.count || 0));
    return { ok: true, action: action, count: Number(state.count || 0) };
  } catch (err) { return failure(action, err); }
}

// 对外导出：启动 / 停止 两个接口。
module.exports = {
  startIdle: startIdle,
  stopIdle: stopIdle
};
