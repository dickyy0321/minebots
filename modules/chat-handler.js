// ========================================
// 文件：modules/chat-handler.js
// 功能：聊天处理——听游戏内聊天，过滤系统提示后提取动作交给执行器，再用 AI（可带工具菜单）回一句（纯单语 + 打字机）
// 依赖：./logger、./intent、./ai-client、./player-manager、./chat-permissions、./ai-tools、./speech、./typing（都可选），缺哪个都不崩
// 导出：attach、handleChat、isSystemMessage、isSystemSender
// 作者：MineBots
// ========================================
//
// 流程 / flow
//   1. 过滤自己发的消息 + 系统提示（传送 / 上下线 / 死亡播报）/ ignore own & system messages
//   2. 记日志 [id] <username> message / write lan log
//   3. 提动作 → 按玩家等级过权限 → bot.emit("bot-action-queue") / gate by level then queue
//   4. 有动作被拒 → 回一句 “没有权限” + 写告警，不再让 AI 回话 / deny then stop
//   5. 全部放行 → 问 AI → bot.chat(回复) / ask ai then reply
//   6. AI 返回 tool_calls → 逐个执行工具 → 结果交回 AI 生成最终回复 / run tools then reply again
// 权限开关：环境变量 MINEBOTS_CHAT_AUTH=off 可临时放行全部（自测 / 单人调试用，默认严格）。
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

// 常量：回复长度上限（避免刷屏被服务器踢下线）。
var REPLY_LIMIT = 200;

// 常量：挂载标记，防止同一个 bot 重复挂载导致重复回复。
var ATTACH_FLAG = "__mbChatHandlerAttached";

// 常量：系统提示黑名单——服务器 / 游戏自动发出的提示不是玩家说话，绝不能进 AI。
// 典型事故：玩家 /tp 之后服务器播报 "Teleported MineBot1 to Steve"，被当成玩家指令派去执行。
var SYSTEM_PATTERNS = [
  /teleported/i,
  /\b(has\s+)?joined the (game|server)\b/i, /\b(has\s+)?left the (game|server)\b/i,
  /\bhas made the advancement\b/i, /\bhas completed the challenge\b/i, /\bhas reached the goal\b/i,
  /\bwas slain by\b/i, /\bwas shot by\b/i, /\bwas blown up by\b/i, /\bwas killed by\b/i, /\bwas fireballed by\b/i,
  /\bwas pummeled by\b/i, /\bwas impaled by\b/i, /\bwas struck by lightning\b/i, /\bwas squashed by\b/i,
  /\bdrowned\b/i, /\bburned to death\b/i, /\bfell from a high place\b/i, /\bstarved to death\b/i,
  /\bsuffocated\b/i, /\btried to swim in lava\b/i, /\bhit the ground too hard\b/i,
  /\bexperienced kinetic energy\b/i, /\bwithered away\b/i, /\bfroze to death\b/i, /\bwent up in flames\b/i,
  /加入了游戏/, /加入了服务器/, /退出了游戏/, /离开了服务器/, /加入了世界/,
  /完成(了)?进度/, /达成(了)?进度/, /获得了?进度/,
  /被.{0,20}杀(死|掉|害)了?/, /被.{0,20}击杀/, /死于/, /死亡信息/, /死亡了\s*$/,
  /掉进了?岩浆/, /从高处摔落/, /摔死了/, /饿死了/, /烧死了/, /淹死了/, /窒息/,
  /^\s*\[server\]/i, /^\s*<server>/i, /^\s*server\s*[:：]/i,
  /\bnot whitelisted\b/i, /\bwrong password\b/i, /\bplease log\s?in\b/i,
  /\bmoved too quickly\b/i, /\bflying is not enabled\b/i, /\byou (were|are) kicked\b/i,
  /§/
];

// 可选依赖：日志核心；缺失时退回 console。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 可选依赖：意图识别；缺失时聊天照常回，只是不提动作。
var intent = null;
try { intent = require("./intent"); } catch (e) { intent = null; }

// 可选依赖：AI 客户端；缺失时不回复，也不崩。
var ai = null;
try { ai = require("./ai-client"); } catch (e) { ai = null; }
// 可选依赖：状态机 3.0 的 JSON 加固门面；tool_calls.arguments 统一经五级解析。
var jsonGuard = null; try { jsonGuard = require("./ai-json-guard"); } catch (e) { jsonGuard = null; }

// 可选依赖：玩家等级；缺失时一律按 normal 处理（宁严不松）。
var playerManager = null;
try { playerManager = require("./player-manager"); } catch (e) { playerManager = null; }

// 可选依赖：指令权限表；缺失时所有动作一律拒绝（宁严不松）。
var permissions = null;
try { permissions = require("./chat-permissions"); } catch (e) { permissions = null; }

// 可选依赖：AI 工具菜单；缺失时退回纯聊天回复。
var aiTools = null;
try { aiTools = require("./ai-tools"); } catch (e) { aiTools = null; }

// 可选依赖：状态机工具（run / stop / create_and_run）；缺失时 AI 只能调普通工具。
var stateTools = null;
try { stateTools = require("./ai-tools-state"); } catch (e) { stateTools = null; }

// 可选依赖：遥测工具（get_bot_state）；缺失时 AI 只能问血量和坐标，拿不到完整状态。
var telemetryTools = null;
try { telemetryTools = require("./ai-tools-telemetry"); } catch (e) { telemetryTools = null; }

// 可选依赖：全局配置（只读防御开关 settings.defense.retaliate）；缺失视为关闭。
var settings = null;
try { settings = require("../settings"); } catch (e) { settings = null; }

// 可选依赖：任务播报（内置模板 + 8 秒冷却 + 不自问自答）；缺失时只是不回「收到」。
var narration = null;
try { narration = require("./task-narration"); } catch (e) { narration = null; }

// 可选依赖：语言纯净层（判定玩家语言 / 清洗中英混排）；缺失时退回原样回复。
var speech = null;
try { speech = require("./speech"); } catch (e) { speech = null; }

// 可选依赖：打字机引擎（3 字 / 100 毫秒分段发送）；缺失时直接 bot.chat。
var typing = null;
try { typing = require("./typing"); } catch (e) { typing = null; }

// 常量：权限开关的环境变量名（MINEBOTS_CHAT_AUTH=off 时临时放行全部，自测 / 单人调试用）。
var AUTH_ENV = "MINEBOTS_CHAT_AUTH";

// 常量：系统提示词——纯单语铁律（规则文本放在 speech.SYS_LANG_RULE，只有一处定义，不怕两处写歪）。
// speech 模块缺失时退回内联英文规则，保证「不许中英混排」这条底线永远在。
var SYS_PROMPT = "You are a Minecraft bot chatting in the in-game chat box. " +
  "Keep it under 60 characters. Use go/dig/attack/stop when an action is needed. " +
  (speech && speech.SYS_LANG_RULE ? speech.SYS_LANG_RULE : "Reply in the same language only, never mix two languages.");

// 常量：带工具时的系统提示词——要求优先调工具，别只说不做。
var TOOL_PROMPT = SYS_PROMPT + " When the player asks for an action, call the matching tool instead of only talking.";
// 常量：一条消息里最多执行几个工具调用 / 单个工具结果回传 AI 时的最大字符数。
var MAX_TOOL_CALLS = 4;
var TOOL_RESULT_LIMIT = 240;

// 写告警日志：优先 logger.warn，失败退回 console，绝不抛错。
function logWarn(message) {
  try {
    if (logger && typeof logger.warn === "function") logger.warn(message);
    else console.warn(message);
  } catch (e) { /* 日志失败不影响聊天 */ }
}

// 写 LAN 日志：优先 logger.lan，依次退回 system、console。
function logLan(message) {
  try {
    if (logger && typeof logger.lan === "function") logger.lan(message);
    else if (logger && typeof logger.system === "function") logger.system(message);
    else console.log(message);
  } catch (e) { /* 日志失败不影响聊天 */ }
}

// 写系统日志：优先 logger.system，退回 console。
function logSystem(message) {
  try {
    if (logger && typeof logger.system === "function") logger.system(message);
    else console.log(message);
  } catch (e) { /* 日志失败不影响聊天 */ }
}

// 写信息日志：优先 logger.info（只落盘、不推 GUI），被过滤掉的高频提示别去刷界面。
function logInfo(message) {
  try {
    if (logger && typeof logger.info === "function") { logger.info(message); return; }
  } catch (e) { /* 退回 console */ }
  try { console.debug(message); } catch (e) { /* ignore */ }
}

// 写错误日志：优先 logger.error（推 GUI 并落盘），依次退回 warn、console，绝不抛错。
function logError(message) {
  try {
    if (logger && typeof logger.error === "function") { logger.error(message); return; }
  } catch (e) { /* 退回 warn */ }
  logWarn(message);
}

// 安全取错误文本：catch 里再抛错就破红线了。
function getErrText(err) {
  try {
    if (!err) return "unknown error";
    if (err.message) return String(err.message);
    return String(err);
  } catch (e) { return "unknown error"; }
}

// 安全转字符串：null / undefined 统一成空串。
function toText(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

// 判定玩家语言：speech 缺失时按中文处理（宁可中文也不混排）。
function langOf(text) {
  try {
    if (speech && typeof speech.detectLang === "function") return speech.detectLang(text);
  } catch (e) { /* 退回中文 */ }
  return "zh";
}

// 按语言取一句话：speech 缺失时退回中文那一句（绝不拼成双语）。
function pickText(lang, zh, en) {
  try {
    if (speech && typeof speech.pick === "function") return speech.pick(lang, zh, en);
  } catch (e) { /* 退回中文 */ }
  return String(lang || "").toLowerCase() === "en" ? toText(en) : toText(zh);
}

// 权限拒绝句：优先 chat-permissions.denyText（单语），其次本地双语常量再清成单语。
function denyFor(lang) {
  try {
    if (permissions && typeof permissions.denyText === "function") return permissions.denyText(lang);
  } catch (e) { /* 退回本地常量 */ }
  return pickText(lang, "你没有权限执行此指令", "You don't have permission.");
}

// 权限是否被显式关掉：只有 MINEBOTS_CHAT_AUTH=off 才放行全部，其它值（含没设）都严格。
function authDisabled() {
  try { return String(process.env[AUTH_ENV] || "").toLowerCase().trim() === "off"; }
  catch (e) { return false; }
}

// 查玩家等级：模块缺失 / 取值失败 / 返回空串都按 normal 处理（宁严不松）。
function levelOf(username) {
  try {
    if (playerManager && typeof playerManager.getLevel === "function") {
      var level = toText(playerManager.getLevel(username)).toLowerCase().trim();
      if (level.length > 0) return level;
    }
  } catch (err) {
    logWarn("chat-handler getLevel failed: " + getErrText(err));
  }
  return "normal";
}

// 按等级过滤动作：返回 { level, allowed, denied, blocked, message }；权限模块缺失时全部拒绝。
function gateActions(username, actions, level) {
  var lv = toText(level).length > 0 ? level : levelOf(username);
  try { var op = require("./owner-privilege"); if (op.isOwner(username)) lv = "owner"; } catch (eOwner) { /* 特权模块缺失按原等级 */ }
  if (authDisabled()) return { level: lv, allowed: actions, denied: [], blocked: false, message: "" };
  try {
    if (permissions && typeof permissions.filterActions === "function") return permissions.filterActions(lv, actions);
  } catch (err) {
    logWarn("chat-handler permission filter failed: " + getErrText(err));
  }
  return { level: lv, allowed: [], denied: actions, blocked: true, message: denyFor(lv) };
}

// 把被拒动作名拼成一行写日志（最多 6 个，避免日志过长）。
function joinActionNames(actions) {
  var names = [];
  try {
    var list = Array.isArray(actions) ? actions : [];
    for (var i = 0; i < list.length && i < 6; i++) {
      var name = permissions && typeof permissions.actionName === "function" ? permissions.actionName(list[i]) : "";
      names.push(name.length > 0 ? name : "?");
    }
  } catch (e) { return "?"; }
  return names.join(",");
}

// 防御开关：只有配置里显式写 settings.defense.retaliate = true 才允许反击（默认关）。
function defenseOn() {
  try { return !!(settings && settings.defense && settings.defense.retaliate === true); }
  catch (e) { return false; }
}

// 反击：防御开启且能在 bot.entities 里找到该玩家时才打一下；失败只写日志，绝不抛错。
function retaliate(bot, username, id) {
  if (!defenseOn()) return false;
  try {
    var wanted = toText(username);
    var entities = bot && bot.entities ? bot.entities : null;
    if (!entities || wanted.length === 0) return false;
    var keys = Object.keys(entities);
    for (var i = 0; i < keys.length; i++) {
      var entity = entities[keys[i]];
      if (!entity) continue;
      if (toText(entity.username) !== wanted && toText(entity.name) !== wanted) continue;
      if (typeof bot.attack !== "function") return false;
      bot.attack(entity);
      logWarn("[" + toText(id) + "] 防御反击 / retaliate: " + wanted);
      return true;
    }
  } catch (err) {
    logWarn("[" + toText(id) + "] 反击失败 / retaliate failed: " + getErrText(err));
  }
  return false;
}

// 判定发信人不像玩家（空 / 带方括号 / 带空格 / Server 之类）——那是服务器自己在播报。
function isSystemSender(username) {
  var name = toText(username).trim();
  if (name.length === 0) return true;
  if (/[\[\]<>{}]/.test(name)) return true;
  if (/\s/.test(name)) return true;
  return /^(server|console|system|admin|game)$/i.test(name);
}

// 判定一条消息是系统提示（传送 / 上下线 / 死亡播报 / 登录提示等），命中就整条丢掉，绝不进 AI。
function isSystemMessage(message) {
  var text = toText(message);
  if (text.length === 0) return true;
  for (var i = 0; i < SYSTEM_PATTERNS.length; i++) {
    try { if (SYSTEM_PATTERNS[i].test(text)) return true; } catch (e) { /* 单条正则坏掉不牵连其它 */ }
  }
  return false;
}

// 是不是自己发的消息：用户名为空、或与 bot 用户名相同都算自己。
function isSelf(bot, username) {
  try {
    var name = toText(username);
    if (name.length === 0) return true;
    if (bot && toText(bot.username) === name) return true;
    return false;
  } catch (e) { return true; }
}

// 提动作：intent 不可用或解析失败都返回空数组（聊天照常回复）。
function extractActions(text) {
  try {
    if (!intent || typeof intent.parseIntent !== "function") return [];
    var list = intent.parseIntent(text);
    if (!Array.isArray(list)) return [];
    var actions = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].action) actions.push(list[i]);
    }
    return actions;
  } catch (err) {
    logWarn("chat-handler intent failed: " + getErrText(err));
    return [];
  }
}

// 读 AI 客户端最近一次错误（用于把失败原因直接暴露到 GUI），读不到返回空串。
function aiLastError() {
  try {
    if (!ai || typeof ai.getStatus !== "function") return "";
    var status = ai.getStatus();
    return toText(status && status.lastError).trim();
  } catch (e) { return ""; }
}

// 问 AI：模块不可用 / 请求失败 / 空回复都必须写 error 日志（推 GUI）并返回空串，绝不静默吞掉。
async function askAi(text, botId) {
  if (!ai || typeof ai.ask !== "function") {
    logError("chat-handler AI 不可用 / ai-client unavailable，无法回复 / cannot reply");
    return "";
  }
  try {
    var reply = await ai.ask(SYS_PROMPT, text, botId);
    var answer = toText(reply).trim();
    if (answer.length === 0) {
      var why = aiLastError();
      logError("[AI] 回复为空 / empty reply（检查 API Key / baseUrl / 网络）" + (why.length > 0 ? "，最近错误 / lastError: " + why : ""));
    }
    return answer;
  } catch (err) {
    logError("chat-handler AI 请求失败 / ai request failed: " + getErrText(err));
    return "";
  }
}

// 读状态机工具菜单：权限关掉时给全套，否则只给当前等级放行的那几个；模块缺失返回空数组。
function stateToolsFor(level) {
  if (!stateTools || typeof stateTools.getTools !== "function") return [];
  try {
    if (authDisabled()) return stateTools.getTools();
    if (typeof stateTools.filterTools === "function") return stateTools.filterTools(level);
    return [];
  } catch (err) { logWarn("chat-handler state tools failed: " + getErrText(err)); return []; }
}

// 读遥测工具菜单：权限关掉时给全套，否则按等级裁剪；模块缺失返回空数组。
function telemetryToolsFor(level) {
  if (!telemetryTools || typeof telemetryTools.getTools !== "function") return [];
  try {
    if (authDisabled()) return telemetryTools.getTools();
    if (typeof telemetryTools.filterTools === "function") return telemetryTools.filterTools(level);
    return [];
  } catch (err) { logWarn("chat-handler telemetry tools failed: " + getErrText(err)); return []; }
}

// 只暴露当前玩家有权限的工具：权限开关关掉时（自测 / 单人调试）直接给全套。
function toolsFor(level) {
  var out = [];
  if (aiTools && typeof aiTools.getTools === "function") {
    if (authDisabled()) out = aiTools.getTools();
    else if (typeof aiTools.filterTools === "function") {
      try { out = aiTools.filterTools(level); } catch (err) { logWarn("chat-handler filterTools failed: " + getErrText(err)); out = []; }
    }
  }
  var extra = stateToolsFor(level);
  for (var i = 0; i < extra.length; i++) out.push(extra[i]);
  var tele = telemetryToolsFor(level);
  for (var j = 0; j < tele.length; j++) out.push(tele[j]);
  return out;
}

// 判断一个工具是否允许：状态机 / 遥测工具各走自己的白名单，其它走 ai-tools 的判定。
function toolAllowedFor(level, name) {
  if (stateTools && typeof stateTools.isStateTool === "function" && stateTools.isStateTool(name)) {
    return (typeof stateTools.toolAllowed === "function") ? stateTools.toolAllowed(level, name) : false;
  }
  if (telemetryTools && typeof telemetryTools.isTelemetryTool === "function" && telemetryTools.isTelemetryTool(name)) {
    return (typeof telemetryTools.toolAllowed === "function") ? telemetryTools.toolAllowed(level, name) : false;
  }
  return !!(aiTools && typeof aiTools.toolAllowed === "function" && aiTools.toolAllowed(level, name));
}

// 执行一次工具：状态机工具交给 ai-tools-state，遥测工具交给 ai-tools-telemetry，其它交给 ai-tools。
async function runTool(bot, id, name, args) {
  if (stateTools && typeof stateTools.isStateTool === "function" && stateTools.isStateTool(name)) {
    if (typeof stateTools.executeTool !== "function") return "执行失败：工具模块不可用 / failed: ai-tools-state unavailable";
    return await stateTools.executeTool(bot, id, name, args);
  }
  if (telemetryTools && typeof telemetryTools.isTelemetryTool === "function" && telemetryTools.isTelemetryTool(name)) {
    if (typeof telemetryTools.executeTool !== "function") return "执行失败：工具模块不可用 / failed: ai-tools-telemetry unavailable";
    return await telemetryTools.executeTool(bot, id, name, args);
  }
  if (!aiTools || typeof aiTools.executeTool !== "function") return "执行失败：工具模块不可用 / failed: ai-tools unavailable";
  return await aiTools.executeTool(bot, name, args);
}

// 读 AI 返回的 tool_calls：arguments 强制走五级 JSON 修复，坏数据兜底成空对象再交给执行器。
function readToolCalls(choice) {
  var out = [];
  try {
    var msg = choice ? choice.message : null;
    var list = msg ? msg.tool_calls : null;
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length && i < MAX_TOOL_CALLS; i++) {
      var call = list[i];
      if (!call || !call.function) continue;
      var name = toText(call.function.name).trim();
      if (name.length === 0) continue;
      out.push({ id: toText(call.id), name: name, args: jsonGuard ? jsonGuard.cleanArguments(call.function.arguments) : call.function.arguments });
    }
  } catch (err) { return []; }
  return out;
}

// 取 AI 的文字回复：message.content 或 text，读不到返回空串。
function choiceText(choice) {
  try {
    if (choice && choice.message && typeof choice.message.content === "string") return choice.message.content.trim();
    if (choice && typeof choice.text === "string") return choice.text.trim();
  } catch (err) { /* 落到空串 */ }
  return "";
}

// 重建 assistant 的 tool_calls 消息：arguments 必须是字符串，坏数据兜成空对象。
function assistantMessage(calls) {
  var list = [];
  for (var i = 0; i < calls.length; i++) {
    var argsText = "{}";
    try { argsText = (typeof calls[i].args === "string") ? calls[i].args : JSON.stringify(calls[i].args || {}); }
    catch (err) { argsText = "{}"; }
    list.push({ id: calls[i].id, type: "function", function: { name: calls[i].name, arguments: argsText } });
  }
  return { role: "assistant", content: "", tool_calls: list };
}

// 问 AI（带工具）：返回最终要发出去的文本；工具结果会作为 tool 消息交回 AI 做二次对话。
async function askAiWithTools(bot, id, username, level, text, lang) {
  var tools = toolsFor(level);
  if (tools.length === 0 || !ai || typeof ai.askWithTools !== "function") return await askAi(text, id);
  var choice = null;
  try { choice = await ai.askWithTools(TOOL_PROMPT, text, tools, null, id); }
  catch (err) { logError("[" + toText(id) + "] askWithTools 失败 / failed: " + getErrText(err)); }
  if (!choice) return await askAi(text);
  var calls = readToolCalls(choice);
  if (calls.length === 0) {
    var plain = choiceText(choice);
    if (plain.length > 0) return plain;
    return await askAi(text, id);
  }
  if (!authDisabled()) {
    var denied = [];
    for (var i = 0; i < calls.length; i++) {
      var allow = toolAllowedFor(level, calls[i].name);
      if (!allow) denied.push(calls[i].name);
    }
    if (denied.length > 0) {
      logWarn("[" + toText(id) + "] 拒绝工具调用 / tool denied: " + toText(username) + " level=" + toText(level) + " tools=" + denied.join(","));
      return denyFor(lang);
    }
  }
  var history = [assistantMessage(calls)];
  var used = [], allSilent = true;
  for (var j = 0; j < calls.length; j++) {
    var result = "";
    try {
      result = await runTool(bot, id, calls[j].name, calls[j].args);
    } catch (err) {
      result = pickText(lang, "执行失败：" + getErrText(err), "failed: " + getErrText(err));
    }
    used.push(calls[j].name); try { if (require("./ai-tools-runner").isSilent(result) !== true) allSilent = false; } catch (eSil) { allSilent = false; }
    history.push({ role: "tool", tool_call_id: calls[j].id, content: toText(result).slice(0, TOOL_RESULT_LIMIT) });
  }
  logSystem("[" + toText(id) + "] " + toText(username) + "(" + toText(level) + ") 调用工具 / tool calls: " + used.join(","));
  if (allSilent) return ""; var finalChoice = null; // 静默执行：工具全是空结果，跳过 AI 二次回复不废话。
  try { finalChoice = await ai.askWithTools(TOOL_PROMPT, text, tools, history, id); }
  catch (err) { logError("[" + toText(id) + "] 工具二次对话失败 / second round failed: " + getErrText(err)); }
  var answer = choiceText(finalChoice);
  if (answer.length === 0) answer = pickText(lang, "好的：" + used.join(", "), "ok: " + used.join(", "));
  return answer;
}

// 回话：先清洗成单语，再交给打字机分段发出；失败只记日志。
// 返回实际排出去的段数（0 表示一个字都没发出去）。
function sayChat(bot, id, reply, lang) {
  try {
    if (!bot || typeof bot.chat !== "function") return 0;
    var pure = toText(reply);
    try { if (speech && typeof speech.clean === "function") pure = speech.clean(pure, lang); } catch (e1) { pure = toText(reply); }
    pure = toText(pure).replace(/^\s+|\s+$/g, "").slice(0, REPLY_LIMIT);
    if (pure.length === 0) return 0;
    var sent = 0;
    if (typing && typeof typing.send === "function") {
      var res = typing.send(bot, pure, { lang: lang });
      if (res && res.ok) sent = res.segments > 0 ? res.segments : 1;
    }
    if (sent === 0) {
      bot.chat(pure);
      sent = 1;
    }
    logLan("[" + toText(id) + "] <bot> " + pure);
    return sent;
  } catch (err) {
    logWarn("[" + toText(id) + "] bot.chat 失败: " + getErrText(err));
    return 0;
  }
}

// 功能 2：处理一条聊天——提动作 → 过权限 → 派发队列 → 问 AI（可调工具）→ 回话；全程不抛错。
async function handleChat(bot, id, username, message) {
  var text = toText(message).trim();
  if (text.length === 0) return false;
  // 语言判定 + 记到 bot 上：后续播报 / 执行层都按这个语言说话，绝不混排。
  var lang = langOf(text);
  try { if (bot) bot._mbLang = lang; } catch (e0) { /* 记不住就按中文播报 */ }
  // 公屏防污染第一道闸：系统提示 / 刷屏 / 废话 / Bot 自聊一律挡在 AI 上下文之外（整句式打字机不再打断）。
  try { if (String(process.env.MINEBOTS_CHAT_AUTH || "") !== "off") { var cf = require("./chat-filter"); if (cf.inspect(text, { sender: username }).ok === false) return false; } } catch (e1) { /* 过滤层缺失时放行 */ }
  var level = levelOf(username);
  var actions = extractActions(text);
  if (actions.length > 0) {
    var gate = gateActions(username, actions, level);
    if (gate.allowed.length > 0) {
      try {
        if (bot && typeof bot.emit === "function") {
          bot.emit("bot-action-queue", { from: username, actions: gate.allowed, message: text });
          logSystem("[" + toText(id) + "] " + toText(username) + "(" + toText(gate.level) + ") 的指令识别出 " + gate.allowed.length + " 个动作");
          // 边做边汇报：玩家刚下指令先回一句「收到」，后续步骤交给动作层按 8 秒冷却继续播报。
          try { if (narration && typeof narration.announce === "function") narration.announce(bot, id, "accept", { action: gate.allowed[0] && gate.allowed[0].action, lang: lang }); } catch (e2) { /* 播报失败不影响执行 */ }
        }
      } catch (err) {
        logWarn("[" + toText(id) + "] 动作队列派发失败: " + getErrText(err));
      }
    }
    if (gate.denied.length > 0) {
      logWarn("[" + toText(id) + "] 拒绝指令 / permission denied: " + toText(username) + " level=" + toText(gate.level) + " actions=" + joinActionNames(gate.denied));
      sayChat(bot, id, denyFor(lang), lang);
      if (permissions && typeof permissions.isHostile === "function" && permissions.isHostile(gate.level)) retaliate(bot, username, id);
      return true;
    }
  }
  logSystem("[DEBUG-AI] 开始向 AI 请求回复，输入文本: " + text);
  var reply = await askAiWithTools(bot, id, username, level, text, lang);
  if (reply.length > 0) sayChat(bot, id, reply, lang);
  else logWarn("[" + toText(id) + "] AI 没有给出回复 / no reply for: " + toText(username) + " level=" + toText(level));
  return true;
}

// 功能 1：挂到 bot 上听聊天；返回卸载函数（重复挂载会返回上一次的卸载函数）。
function attach(bot, botId) {
  if (!bot || typeof bot.on !== "function") {
    logWarn("chat-handler attach 失败：bot 不可用");
    return null;
  }
  var id = toText(botId || bot.id || "unknown");
  try {
    if (bot[ATTACH_FLAG]) return bot[ATTACH_FLAG];
  } catch (e) { /* 标记读不到就继续挂载 */ }
  var onChat = function (username, message) {
    try {
      // 调试雷达：收到任何聊天先打一条（自己发的也打，便于确认监听真的生效）。
      logSystem("[DEBUG-CHAT] 收到聊天: <" + toText(username) + "> " + toText(message) + (isSelf(bot, username) ? "（自己发的 / self, ignored）" : ""));
      // 系统提示（传送 / 上下线 / 死亡播报）和服务器发信人直接丢掉：只处理真正的玩家聊天。
      if (isSystemSender(username) || isSystemMessage(message)) {
        logInfo("[DEBUG-CHAT] 系统提示已忽略 / system message ignored: <" + toText(username) + "> " + toText(message).slice(0, 80));
        return;
      }
      if (isSelf(bot, username)) return;
      logLan("[" + id + "] <" + toText(username) + "> " + toText(message));
      var task = handleChat(bot, id, username, message);
      if (task && typeof task.catch === "function") {
        task.catch(function (err) { logWarn("[" + id + "] chat handler error: " + getErrText(err)); });
      }
    } catch (err) {
      logWarn("[" + id + "] chat handler error: " + getErrText(err));
    }
  };
  try {
    bot.on("chat", onChat);
  } catch (err) {
    logWarn("[" + id + "] 聊天监听挂载失败: " + getErrText(err));
    return null;
  }
  var detach = function () {
    try {
      if (typeof bot.removeListener === "function") bot.removeListener("chat", onChat);
      bot[ATTACH_FLAG] = null;
    } catch (err) {
      logWarn("[" + id + "] 聊天监听卸载失败: " + getErrText(err));
    }
  };
  try { bot[ATTACH_FLAG] = detach; } catch (e) { /* 标记写不进也不影响监听 */ }
  logSystem("[" + id + "] 聊天监听已挂载 / chat listener attached");
  return detach;
}

// 对外导出：§八 规定的 2 个接口，外加给自测 / 其它模块复用的系统消息判定。
module.exports = { attach: attach, handleChat: handleChat, isSystemMessage: isSystemMessage, isSystemSender: isSystemSender };