// ========================================
// 文件：modules/swarm-console.js
// 功能：状态机 3.0 主进程门面——蜂群控制台 IPC 的统一入口，聚合命令分派 / 三层状态 / 反射层挂载
// 依赖：./swarm-command、./state-runtime、./shared-board、./antiafk、./replan（均可选）、./event-bus、./logger（可选）
// 导出：handle / status / commands / attachBot / reset / CHANNEL_HINT
// 作者：MineBots
// ========================================
//
// 为什么需要门面 / why a facade
//   GUI 只认一条通道：发 { botId, text }，拿 { ok, command, message, data }。
//   命令解析在 swarm-command，三层状态在 state-runtime，生态在 shared-board；
//   这里只做编排与降级，绝不复制业务逻辑，也不直接碰磁盘 state/。
// CommonJS，ES5 风格，无中文变量名；所有外部调用包 try/catch，异常一律回 ok:false。
var command = null;
try { command = require("./swarm-command"); } catch (e) { command = null; }

var runtime = null;
try { runtime = require("./state-runtime"); } catch (e) { runtime = null; }

var board = null;
try { board = require("./shared-board"); } catch (e) { board = null; }

var reflex = null;
try { reflex = require("./antiafk"); } catch (e) { reflex = null; }

// 可选依赖：生存党 Tick 级反射层（MLG / 跳跃重置 / 防爆盾）与读心陪伴层。
var survival = null;
try { survival = require("./reflex-survival"); } catch (e) { survival = null; }
var companion = null;
try { companion = require("./companion"); } catch (e) { companion = null; }

var replan = null;
try { replan = require("./replan"); } catch (e) { replan = null; }

var bus = null;
try { bus = require("./event-bus"); } catch (e) { bus = null; }

var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：给 GUI 的通道提示（渲染层不 require 主进程模块，靠回包里的这个字段显示帮助）。
var CHANNEL_HINT = "输入 #help 查看全部指令 / type #help for all commands";

// 安全取错误文本：catch 里绝不会二次抛错。
function errText(err) {
  try { if (err && err.message) return String(err.message); return String(err); }
  catch (e) { return "unknown error / 未知错误"; }
}

// 规范化 botId：坏值退回 default。
function idOf(botId) {
  try {
    var text = String(botId === null || botId === undefined ? "" : botId).replace(/^\s+|\s+$/g, "");
    return text.length === 0 ? "default" : text.slice(0, 80);
  } catch (e) { return "default"; }
}

// 安全转字符串：null / undefined 统一成空串。
function toText(value) {
  try { return value === null || value === undefined ? "" : String(value); } catch (e) { return ""; }
}

// 写文件日志：控制台每次请求只落文件，不刷 GUI。
function logInfo(msg) {
  try { if (logger && typeof logger.info === "function") logger.info("[swarm-console] " + msg); } catch (e) { /* ignore */ }
}

// 写系统日志：命令失败要人看见。
function logWarn(msg) {
  try {
    if (logger && typeof logger.warn === "function") { logger.warn("[swarm-console] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.warn("[swarm-console] " + msg); } catch (e2) { /* ignore */ }
}

// 广播控制台事件：总线缺失时静默跳过。
function emit(name, payload) {
  try { if (bus && typeof bus.emit === "function") bus.emit(name, payload); } catch (e) { /* ignore */ }
}

// 把真实 bot 挂到反射层（entityHurt / physicsTick）；用 bot 上的标记保证幂等，重复调用不叠加监听。
function attachBot(bot, botId) {
  var id = idOf(botId);
  try {
    if (!bot || typeof bot.on !== "function") return { ok: false, botId: id, message: "bot 未就绪 / bot not ready" };
    // 公屏频道指令：玩家发 set bot-1 channel=team_red 时立刻分配并双语回执，不进 AI 上下文。
    try {
      var ccMod = require("./chat-channel");
      if (bot._mbChannelCmd !== true && typeof ccMod.handleCommand === "function") {
        bot.on("chat", function (user, text) {
          try {
            var hit = ccMod.handleCommand(text, { sender: user });
            if (hit && hit.matched && bot && typeof bot.chat === "function") bot.chat(hit.message);
          } catch (eCcChat) { /* 单条解析失败不影响聊天 */ }
        });
        bot._mbChannelCmd = true;
      }
    } catch (eCc) { /* 频道模块缺失时跳过 */ }
    if (bot._mbSwarmReflex === true) return { ok: true, botId: id, attached: true, message: "反射层已挂载 / reflex already attached" };
    if (!reflex || typeof reflex.attach !== "function") return { ok: false, botId: id, message: "antiafk 未加载 / antiafk unavailable" };
    var hit = reflex.attach(bot, id, {});
    if (hit && hit.ok) bot._mbSwarmReflex = true;
    logInfo("反射层挂载 / reflex attach: " + id + " ok=" + !!(hit && hit.ok));
    // 生存反射与陪伴层同样幂等挂载：用 bot 上的独立标记，重复调用不叠加监听。
    var ownerName = "";
    try {
      var pm = require("./player-manager");
      var own = pm.loadPlayers().manual.owner;
      ownerName = Array.isArray(own) && own.length > 0 ? String(own[0]) : "";
    } catch (ePm) { /* 等级表读不到就按空主人降级 */ }
    if (survival && typeof survival.attach === "function" && bot._mbSurvivalReflex !== true) {
      try { if (survival.attach(bot, id, { ownerName: ownerName }).ok === true) bot._mbSurvivalReflex = true; }
      catch (eSur) { /* 单个模块挂不上不影响其余 */ }
    }
    if (companion && typeof companion.attach === "function" && bot._mbCompanion !== true) {
      try { if (companion.attach(bot, id, { ownerName: ownerName, manual: true }).ok === true) bot._mbCompanion = true; }
      catch (eCom) { /* 同上 */ }
    }
    // 公屏防污染：登记本 Bot 名，两个 Bot 在无玩家指令时绝不互相接话。
    try { var cf = require("./chat-filter"); if (bot.username) cf.registerBot(bot.username); } catch (eCf) { /* 过滤层缺失时跳过 */ }
    // 动作拟真微操：视线游移 / 偶尔轻跳 / 挖完环视，精确建筑模式下自动归零。
    try { var mm = require("./motion-micro"); if (bot._mbMotionMicro !== true) { mm.attach(bot, id, {}); bot._mbMotionMicro = true; } } catch (eMm) { /* 同上 */ }
    // 生态破圈：登记友军坐标（寻路绕人）/ 公屏招工接单 / 幽灵反作弊 / 外部群事件桥。
    try {
      var sc = require("./swarm-collision"); sc.track(bot, id, {});
      var mw = require("./market-wallet");
      if (bot._mbMarket !== true) {
        bot.on("chat", function (u, t) { try { mw.onChat(t, u, { bot: bot, botId: id }); } catch (eMwChat) { /* 招工解析失败不影响聊天 */ } });
        bot._mbMarket = true;
      }
      var ga = require("./ghost-anticheat"); ga.start(bot, id, { manual: true });
      var eb = require("./external-bridge"); eb.bindEvents();
    } catch (eEco) { /* 单个生态模块缺失不影响其余 */ }
    return { ok: !!(hit && hit.ok), botId: id, attached: !!(hit && hit.ok), message: hit ? hit.message : "attach failed / 挂载失败" };
  } catch (e) {
    return { ok: false, botId: id, attached: false, message: errText(e) };
  }
}

// 三层状态快照：优先用 swarm-command 的聚合，模块缺失时逐项降级为空对象。
function status(botId) {
  var id = idOf(botId);
  var out = { ok: true, botId: id, at: Date.now(), hint: CHANNEL_HINT, bots: [], status: null, ecosystem: null, watchdog: null, reflex: null };
  try {
    if (command && typeof command.collectStatus === "function") out.status = command.collectStatus(id);
    if (runtime && typeof runtime.list === "function") out.bots = runtime.list();
    if (board && typeof board.ecosystem === "function") out.ecosystem = board.ecosystem();
    if (replan && typeof replan.stats === "function") out.watchdog = replan.stats(id);
    if (reflex && typeof reflex.stats === "function") out.reflex = reflex.stats(id);
  } catch (e) {
    out.ok = false;
    out.message = "状态采集失败 / status failed: " + errText(e);
  }
  return out;
}

// 返回可用命令清单；解析模块缺失时返回空数组。
function commands() {
  try {
    if (command && typeof command.list === "function") {
      return { ok: true, commands: command.list(), hint: CHANNEL_HINT };
    }
  } catch (e) { /* 走下面统一降级 */ }
  return { ok: false, commands: [], hint: CHANNEL_HINT, message: "swarm-command 未加载 / swarm-command unavailable" };
}

// 执行一条控制台请求：{ botId, text } 或 { botId, command, args }；返回 Promise，绝不抛到顶层。
async function handle(payload) {
  var p = payload && typeof payload === "object" ? payload : {};
  var id = idOf(p.botId);
  var empty = { ok: false, botId: id, command: "", message: "控制台未加载 / console unavailable", data: null, at: Date.now(), hint: CHANNEL_HINT };
  if (!command) return empty;
  try {
    var out = null;
    var text = toText(p.text).replace(/^\s+|\s+$/g, "");
    if (text.length > 0) out = await command.handle(text, { botId: id });
    else {
      var name = command.resolve(p.command || "");
      if (!name) {
        empty.message = "指令为空或不认识 / empty or unknown command";
        return empty;
      }
      var args = toText(p.args);
      out = await command.execute(name, { botId: id, parsed: { raw: args, args: args.length > 0 ? args.split(/\s+/) : [], options: {} } });
    }
    if (!out) return empty;
    var reply = {
      ok: out.ok === true, botId: id, command: out.command || "", message: out.message || "",
      data: out.data || null, at: Date.now(), hint: CHANNEL_HINT, status: status(id)
    };
    emit("swarm.console", { botId: id, command: reply.command, ok: reply.ok });
    logInfo("控制台回包 / console reply: " + id + " " + reply.command + " ok=" + reply.ok);
    if (!reply.ok) logWarn("控制台命令失败 / console command failed: " + id + " " + reply.message);
    return reply;
  } catch (e) {
    empty.message = "控制台异常 / console error: " + errText(e);
    return empty;
  }
}

// 清空内存状态（不碰磁盘），供控制台 #reset 之外的显式调用。
function reset(botId) {
  var id = idOf(botId);
  try {
    if (runtime && typeof runtime.reset === "function") runtime.reset(id);
    if (replan && typeof replan.reset === "function") replan.reset();
    if (reflex && typeof reflex.reset === "function") reflex.reset();
  } catch (e) { return { ok: false, botId: id, message: errText(e) }; }
  return { ok: true, botId: id, message: "内存状态已重置 / in-memory state reset" };
}

// 对外导出：控制台主入口 / 状态 / 清单 / 反射挂载 / 重置。
module.exports = {
  handle: handle,
  status: status,
  commands: commands,
  attachBot: attachBot,
  reset: reset,
  CHANNEL_HINT: CHANNEL_HINT
};
