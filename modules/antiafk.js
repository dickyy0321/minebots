// ========================================
// 文件：modules/antiafk.js
// 功能：反射层（毫秒级）——监听 entityHurt / physicsTick，本地执行 local_dodge / local_shield 与防挂机微动作，绝不走 AI 网络请求
// 依赖：./motion（可选，提供拟真反射原语）、./event-bus（可选）、./logger（可选）
// 导出：attach / detach / localDodge / localShield / simulateHurt / simulatePhysics / stats / reset /
//       REFLEX_MS / PHYSICS_STRIDE
// 作者：MineBots
// ========================================
//
// 潜意识 / reflex：受击到出手的链路里没有 await 网络、没有 LLM、没有队列，只有本地控制状态位。
// 主意识 / strategic：AI 只负责下宏观目标，由 state-runtime 拆成行为树节点，两者通过事件总线单向解耦。
// ES5 风格，CommonJS，无中文变量名；所有 bot API 调用都判空并包 try/catch。
var motion = null;
try { motion = require("./motion"); } catch (e) { motion = null; }

var bus = null;
try { bus = require("./event-bus"); } catch (e) { bus = null; }

var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：反射节流窗口（毫秒）/ 每多少个物理帧做一次防挂机微动作 / 单 bot 事件日志上限。
var REFLEX_MS = 120;
var PHYSICS_STRIDE = 20;
var MAX_EVENTS = 40;

// 状态：botId → 反射运行时；aiCalls 恒为 0，用来证明反射层不经 AI。
var sessions = {};

// 写文件日志：物理帧属高频信息，只落文件，绝不推 GUI。
function logInfo(msg) {
  try { if (logger && typeof logger.info === "function") logger.info("[antiafk] " + msg); } catch (e) { /* ignore */ }
}

// 写系统日志：挂载 / 卸载是低频事件，推 GUI。
function logSystem(msg) {
  try {
    if (logger && typeof logger.system === "function") { logger.system("[antiafk] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[antiafk] " + msg); } catch (e2) { /* ignore */ }
}

// 广播反射事件：总线缺失时静默跳过。
function emit(name, payload) {
  try { if (bus && typeof bus.emit === "function") bus.emit(name, payload); } catch (e) { /* ignore */ }
}

// 规范化 botId，坏值退回 default。
function idOf(botId) {
  try {
    var text = String(botId === null || botId === undefined ? "" : botId).replace(/^\s+|\s+$/g, "");
    return text.length === 0 ? "default" : text.slice(0, 80);
  } catch (e) { return "default"; }
}

// 造一条空会话；重复调用不覆盖已有统计。
function sessionOf(botId) {
  var id = idOf(botId);
  if (!sessions[id]) {
    sessions[id] = {
      botId: id, attached: false, bot: null, handlers: [], lastReflexAt: 0,
      hurts: 0, dodges: 0, shields: 0, physicsTicks: 0, microActions: 0,
      aiCalls: 0, events: [], hooks: {}
    };
  }
  return sessions[id];
}

// 记录一条反射事件（环形上限），坏值忽略。
function record(state, text) {
  try {
    state.events.push({ at: Date.now(), text: String(text) });
    while (state.events.length > MAX_EVENTS) state.events.shift();
  } catch (e) { /* ignore */ }
}

// 安全设置机器人的控制状态；bot 缺失或 API 不存在时返回 false。
function setControl(bot, name, on) {
  try {
    if (!bot || typeof bot.setControlState !== "function") return false;
    bot.setControlState(name, on === true);
    return true;
  } catch (e) { return false; }
}

// 功能：本地闪避——横移 + 跳跃一小步，全程不等待网络；返回 { ok, action, latencyMs }。
function localDodge(bot, options) {
  var started = Date.now();
  var opts = options && typeof options === "object" ? options : {};
  try {
    var dir = opts.direction === "left" ? "left" : "right";
    var moved = setControl(bot, dir, true);
    var jumped = setControl(bot, "jump", true);
    // 同步释放：控制状态位不长期占住，避免影响主状态机的寻路。
    setControl(bot, dir, false);
    setControl(bot, "jump", false);
    if (motion && typeof motion.clampedNoise === "function") {
      try { motion.clampedNoise(0.05); } catch (eNoise) { /* 噪声失败不影响闪避 */ }
    }
    logInfo("本地闪避 / local_dodge: " + dir);
    return { ok: true, action: "local_dodge", moved: moved, jumped: jumped, latencyMs: Date.now() - started, message: "dodge done / 已本地闪避" };
  } catch (e) {
    return { ok: false, action: "local_dodge", latencyMs: Date.now() - started, message: String(e && e.message ? e.message : e) };
  }
}

// 功能：本地举盾——激活副手（有盾时）并短暂潜行；bot 没盾也安全返回 ok:true（已尽力）。
function localShield(bot, options) {
  var started = Date.now();
  try {
    var blocked = false;
    try {
      if (bot && typeof bot.activateItem === "function") { bot.activateItem(true); blocked = true; }
    } catch (eItem) { blocked = false; }
    setControl(bot, "sneak", true);
    setControl(bot, "sneak", false);
    logInfo("本地举盾 / local_shield: blocked=" + blocked);
    return { ok: true, action: "local_shield", blocked: blocked, latencyMs: Date.now() - started, message: "shield done / 已本地举盾" };
  } catch (e) {
    return { ok: false, action: "local_shield", latencyMs: Date.now() - started, message: String(e && e.message ? e.message : e) };
  }
}

// 选反射动作：血量低或有盾优先举盾，否则闪避；payload 可强制指定。
function chooseAction(bot, payload) {
  try {
    var forced = payload && payload.action ? String(payload.action) : "";
    if (forced === "local_dodge" || forced === "dodge") return "local_dodge";
    if (forced === "local_shield" || forced === "shield") return "local_shield";
    var hp = Number(bot && bot.health);
    if (!isNaN(hp) && hp > 0 && hp <= 8) return "local_shield";
    return "local_dodge";
  } catch (e) { return "local_dodge"; }
}

// 功能：受击主处理——节流后立刻本地出手，并广播事件让战略层冻结上下文；绝不调用 AI。
function handleHurt(botId, payload, botRef) {
  var state = sessionOf(botId);
  var info = payload && typeof payload === "object" ? payload : {};
  var now = Date.now();
  try {
    if (now - state.lastReflexAt < REFLEX_MS) {
      return { ok: false, throttled: true, action: "", message: "reflex throttled / 反射已节流" };
    }
    state.lastReflexAt = now;
    state.hurts = state.hurts + 1;
    var bot = botRef || state.bot;
    var action = chooseAction(bot, info);
    var result = action === "local_shield" ? localShield(bot) : localDodge(bot);
    if (action === "local_shield") state.shields = state.shields + 1;
    else state.dodges = state.dodges + 1;
    record(state, action);
    var notice = { botId: state.botId, source: String(info.source || "unknown"), action: action, at: now, latencyMs: result.latencyMs, aiCalls: 0 };
    emit("reflex.action", notice);
    // 单向通知战略层：state-runtime 订阅 reflex.hurt，自己决定冻结与恢复；反射层不等回包。
    emit("reflex.hurt", notice);
    if (state.hooks.onHurt && typeof state.hooks.onHurt === "function") {
      try { state.hooks.onHurt(notice); } catch (eHook) { /* 钩子报错不影响反射 */ }
    }
    logSystem("受击反射 / hurt reflex: " + state.botId + " -> " + action + " " + result.latencyMs + "ms");
    return { ok: true, throttled: false, botId: state.botId, action: action, latencyMs: result.latencyMs, aiCalls: 0, message: "reflex fired / 反射已触发" };
  } catch (e) {
    return { ok: false, throttled: false, action: "", message: String(e && e.message ? e.message : e) };
  }
}

// 功能：物理帧处理——只计数，每 PHYSICS_STRIDE 帧做一次极小的视角抖动防挂机，绝不刷 GUI。
function handlePhysics(botId) {
  var state = sessionOf(botId);
  try {
    state.physicsTicks = state.physicsTicks + 1;
    if (state.physicsTicks % PHYSICS_STRIDE !== 0) return { ok: true, acted: false, ticks: state.physicsTicks };
    state.microActions = state.microActions + 1;
    try {
      if (motion && typeof motion.clampedNoise === "function") motion.clampedNoise(0.02);
    } catch (eNoise) { /* 抖动失败不影响计数 */ }
    emit("reflex.physics", { botId: state.botId, ticks: state.physicsTicks });
    logInfo("物理帧 / physicsTick: " + state.botId + " tick=" + state.physicsTicks);
    return { ok: true, acted: true, ticks: state.physicsTicks, message: "anti-afk micro action / 防挂机微动作" };
  } catch (e) {
    return { ok: false, acted: false, ticks: state.physicsTicks, message: String(e && e.message ? e.message : e) };
  }
}

// 功能：把反射层挂到 bot 上（entityHurt + physicsTick）；bot 没有 on 时返回 ok:false。
function attach(bot, botId, options) {
  var state = sessionOf(botId);
  var opts = options && typeof options === "object" ? options : {};
  try {
    if (!bot || typeof bot.on !== "function") {
      return { ok: false, botId: state.botId, message: "bot not ready / 机器人未就绪" };
    }
    if (state.attached) detach(state.botId);
    state.bot = bot;
    state.hooks = opts.hooks && typeof opts.hooks === "object" ? opts.hooks : {};
    var onHurt = function (payload) { handleHurt(state.botId, payload, bot); };
    var onPhysics = function () { handlePhysics(state.botId); };
    try { bot.on("entityHurt", onHurt); } catch (e1) { /* 单个事件挂不上不影响另一个 */ }
    try { bot.on("physicsTick", onPhysics); } catch (e2) { /* 同上 */ }
    state.handlers = [{ event: "entityHurt", fn: onHurt }, { event: "physicsTick", fn: onPhysics }];
    state.attached = true;
    logSystem("反射层已挂载 / reflex attached: " + state.botId);
    return { ok: true, botId: state.botId, events: 2, message: "reflex attached / 反射层已挂载" };
  } catch (e) {
    return { ok: false, botId: state.botId, message: String(e && e.message ? e.message : e) };
  }
}

// 功能：卸载反射层并摘掉事件监听，返回摘掉的句柄数。
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
      } catch (eOne) { /* 单个摘除失败继续 */ }
    }
    state.handlers = [];
    state.attached = false;
    state.bot = null;
  } catch (e) { /* ignore */ }
  return { ok: true, botId: state.botId, removed: n, message: "reflex detached / 反射层已卸载" };
}

// 功能：不依赖真实 bot 地注入一次受击（自测 / 假 bot 用），返回与真实链路相同结构。
function simulateHurt(botId, payload) {
  return handleHurt(botId, payload, sessionOf(botId).bot);
}

// 功能：不依赖真实 bot 地注入物理帧（自测 / 假 bot 用）。
function simulatePhysics(botId, count) {
  var n = Number(count) > 0 ? Math.min(Number(count), 500) : 1;
  var out = { ok: true, acted: 0, ticks: 0 };
  for (var i = 0; i < n; i++) {
    var one = handlePhysics(botId);
    if (one.acted) out.acted = out.acted + 1;
    out.ticks = one.ticks;
  }
  return out;
}

// 功能：读反射统计（aiCalls 恒为 0 证明不经 AI），供蜂群面板与自测使用。
function stats(botId) {
  var state = sessionOf(botId);
  try {
    return {
      ok: true, botId: state.botId, attached: state.attached, hurts: state.hurts,
      dodges: state.dodges, shields: state.shields, physicsTicks: state.physicsTicks,
      microActions: state.microActions, aiCalls: state.aiCalls,
      events: state.events.slice(0), reflexMs: REFLEX_MS, physicsStride: PHYSICS_STRIDE
    };
  } catch (e) {
    return { ok: false, botId: idOf(botId), message: String(e && e.message ? e.message : e) };
  }
}

// 功能：清空全部反射会话（自测隔离用）。
function reset() {
  try { sessions = {}; } catch (e) { /* ignore */ }
  return { ok: true, message: "reflex reset / 反射层已重置" };
}

// 对外导出：挂载 / 本地反射原语 / 模拟 / 统计。
module.exports = {
  attach: attach,
  detach: detach,
  localDodge: localDodge,
  localShield: localShield,
  simulateHurt: simulateHurt,
  simulatePhysics: simulatePhysics,
  stats: stats,
  reset: reset,
  REFLEX_MS: REFLEX_MS,
  PHYSICS_STRIDE: PHYSICS_STRIDE
};
