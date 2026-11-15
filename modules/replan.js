// ========================================
// 文件：modules/replan.js
// 功能：动态重规划与 AI 兜底——看门狗累计 3 次失败后调 askWithTools，校验 tool_calls 后插入执行队列，非法即降级默认动作
// 依赖：./ai-client（可选）、./ai-tools（可选）、./event-bus（可选）、./logger（可选）
// 导出：recordFailure / buildContext / validateCalls / toNodes / aiReplan / enqueue / drain /
//       queueSize / stats / setAiClient / setTools / reset / FAILURE_THRESHOLD / DEFAULT_ACTION / ACTION_MAP
// 作者：MineBots
// ========================================
//
// 上下文样例 / replan context
//   { current_action: "挖矿 / mine", error: "找不到铁矿 / no iron ore",
//     inventory: { ... }, position: { x, y, z }, botId, attempts }
// 降级 / fallback：AI 不可用、返回 null、tool_calls 非法、JSON 解析失败，一律插入
//   DEFAULT_ACTION（explore），绝不把异常抛到顶层，也绝不联网重试。
// ES5 风格，CommonJS，无中文变量名。
var bus = null;
try { bus = require("./event-bus"); } catch (e) { bus = null; }

var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 可选依赖：五级 JSON 修复引擎；AI 重规划返回的 tool_calls.arguments 一律经它解析。
var jsonRepair = null; try { jsonRepair = require("./json-repair"); } catch (e) { jsonRepair = null; }

// 强制五级解析 tool_calls.arguments：引擎缺失时退回原生解析，五级全败返回 null，绝不抛错。
function safeJsonArgs(raw) {
  try {
    if (jsonRepair) {
      var d = jsonRepair.safeParseDetailed(raw, null);
      return d.usedFallback ? null : d.value;
    }
    return JSON.parse(raw);
  } catch (e) { return null; }
}

// 常量：失败阈值 / 单次最多插入节点 / 系统提示词。
var FAILURE_THRESHOLD = 3;
var MAX_CALLS = 8;
var REPLAN_PROMPT = "You are a Minecraft bot planner. The current action failed three times. Reply with tool_calls only, choosing a different feasible action. Available tools: get_wood, explore, mine, craft, collect, move_to, place_block, stop.";
// 常量：AI 返回非法时插入的兜底节点（默认动作）。
var DEFAULT_ACTION = { id: "replan-fallback", action: "explore", args: { seconds: 5 }, source: "fallback" };
// 常量：工具名到状态机动作名的白名单映射（不在表内一律判非法）。
var ACTION_MAP = {
  get_wood: "dig_tree", explore: "explore", mine: "mine", craft: "craft",
  collect: "collect", move_to: "move", place_block: "place", stop: "stop",
  dig_tree: "dig_tree", dig_block: "dig_block", attack: "attack", follow: "follow"
};

// 状态：注入的 AI 客户端（自测用假对象，绝不联网）/ 工具菜单 / 失败计数 / 执行队列。
var injectedAi = null;
var injectedTools = null;
var failures = {};
var queues = {};
var counters = { replans: 0, aiOk: 0, fallbacks: 0, invalid: 0 };

// 安全取错误文本，catch 里不会二次抛错。
function errText(err) {
  try { if (err && err.message) return String(err.message); return String(err); }
  catch (e) { return "unknown error"; }
}

// 写文件日志：失败累计属高频信息，只落文件。
function logInfo(msg) {
  try { if (logger && typeof logger.info === "function") logger.info("[replan] " + msg); } catch (e) { /* ignore */ }
}

// 写系统日志：重规划与降级是低频事件，推 GUI。
function logSystem(msg) {
  try {
    if (logger && typeof logger.system === "function") { logger.system("[replan] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[replan] " + msg); } catch (e2) { /* ignore */ }
}

// 广播重规划事件：总线缺失时静默跳过。
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

// 深拷贝纯数据，坏值返回空对象。
function clone(value) {
  try {
    var out = JSON.parse(JSON.stringify(value === undefined ? null : value));
    return out && typeof out === "object" ? out : {};
  } catch (e) { return {}; }
}

// 功能：注入 AI 客户端（自测用假对象）；传 null 可解除注入，返回当前是否为注入模式。
function setAiClient(client) {
  injectedAi = client || null;
  return { ok: true, injected: injectedAi !== null, message: "AI client set / AI 客户端已设置" };
}

// 功能：注入 tools 菜单（自测用）；传 null 解除注入。
function setTools(tools) {
  injectedTools = Array.isArray(tools) ? tools : null;
  return { ok: true, injected: injectedTools !== null, count: injectedTools ? injectedTools.length : 0, message: "tools set / 工具菜单已设置" };
}

// 取 AI 客户端：注入优先，否则延迟加载真实 ai-client（缺配置时其自身会安全返回 null）。
function aiClient() {
  if (injectedAi) return injectedAi;
  try { return require("./ai-client"); } catch (e) { return null; }
}

// 取工具菜单：注入优先，否则取 ai-tools.getTools()，再不行用内置最小菜单。
function toolsList() {
  if (injectedTools) return injectedTools;
  try {
    var tools = require("./ai-tools");
    if (tools && typeof tools.getTools === "function") {
      var out = tools.getTools();
      if (out && out.length) return out;
    }
  } catch (e) { /* 用内置菜单 */ }
  return [{ type: "function", function: { name: "explore", description: "explore the area / 探索周围" } }];
}

// 功能：记录一次节点失败；达到阈值返回 needsReplan:true 并清零计数，异常返回 ok:false。
function recordFailure(botId, nodeId, error, context) {
  var id = idOf(botId);
  try {
    if (!failures[id]) failures[id] = { count: 0, lastNode: "", lastError: "", replans: 0 };
    var rec = failures[id];
    rec.count = rec.count + 1;
    rec.lastNode = String(nodeId || "node");
    rec.lastError = String(error || "unknown error / 未知错误");
    rec.context = clone(context);
    var hit = rec.count >= FAILURE_THRESHOLD;
    if (hit) { rec.count = 0; rec.replans = rec.replans + 1; }
    logInfo("失败累计 / failure counted: " + id + " " + rec.lastNode + " x" + rec.count + " hit=" + hit);
    emit("replan.failure", { botId: id, node: rec.lastNode, count: rec.count, needsReplan: hit });
    return { ok: true, botId: id, count: rec.count, threshold: FAILURE_THRESHOLD, needsReplan: hit, message: hit ? "replan required / 需要重规划" : "failure recorded / 失败已记录" };
  } catch (e) {
    return { ok: false, botId: id, count: 0, needsReplan: false, message: errText(e) };
  }
}

// 功能：封装给 AI 看的上下文；字段缺失一律补空对象，绝不抛错。
function buildContext(ctx, botId) {
  var box = ctx && typeof ctx === "object" ? ctx : {};
  var out = { current_action: "", error: "", inventory: {}, position: {}, botId: idOf(botId), attempts: FAILURE_THRESHOLD };
  try {
    out.current_action = String(box.current_action || box.action || box.goal || "unknown / 未知动作");
    out.error = String(box.error || box.message || "action failed / 动作失败");
    out.inventory = clone(box.inventory || (box.bot && box.bot.inventory) || {});
    out.position = clone(box.position || (box.bot && box.bot.entity && box.bot.entity.position) || {});
    out.attempts = Number(box.attempts) > 0 ? Number(box.attempts) : FAILURE_THRESHOLD;
  } catch (e) { /* 返回已填好的部分 */ }
  return out;
}

// 功能：解析并校验 AI 回包里的 tool_calls；坏 JSON / 未知工具 / 空数组一律判非法并返回原因。
function validateCalls(choice) {
  var out = { ok: false, calls: [], reason: "no tool_calls / 没有工具调用" };
  try {
    var msg = choice && choice.message ? choice.message : null;
    var list = msg ? msg.tool_calls : null;
    if (!Array.isArray(list) || list.length === 0) return out;
    var calls = [];
    for (var i = 0; i < list.length && i < MAX_CALLS; i++) {
      var call = list[i];
      if (!call || !call.function) return { ok: false, calls: [], reason: "bad tool_call shape / 工具调用结构非法" };
      var name = String(call.function.name || "");
      if (!ACTION_MAP[name]) return { ok: false, calls: [], reason: "unknown tool / 未知工具: " + name };
      var raw = call.function.arguments;
      var args = {};
      if (typeof raw === "string") {
        if (raw.replace(/^\s+|\s+$/g, "").length > 0) {
          args = safeJsonArgs(raw);
          if (!args || typeof args !== "object") return { ok: false, calls: [], reason: "invalid JSON / 参数 JSON 非法" };
        }
      } else if (raw && typeof raw === "object") {
        args = clone(raw);
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        return { ok: false, calls: [], reason: "arguments must be object / 参数必须是对象" };
      }
      calls.push({ id: String(call.id || ("call-" + i)), name: name, action: ACTION_MAP[name], args: args });
    }
    if (calls.length === 0) return out;
    return { ok: true, calls: calls, reason: "" };
  } catch (e) {
    return { ok: false, calls: [], reason: errText(e) };
  }
}

// 功能：把 tool_calls 转成状态机节点；支持原始 OpenAI 结构与已校验结构，非法输入返回默认动作。
function toNodes(calls) {
  var list = Array.isArray(calls) ? calls : [];
  var out = [];
  try {
    for (var i = 0; i < list.length && i < MAX_CALLS; i++) {
      var c = list[i];
      if (!c || typeof c !== "object") continue;
      if (c.action && ACTION_MAP[c.name]) {
        out.push({ id: "replan-" + String(c.id || i), action: String(c.action), args: clone(c.args || {}), next: "", source: "ai" });
        continue;
      }
      if (c.function) {
        var one = validateCalls({ message: { tool_calls: [c] } });
        if (one.ok) {
          out.push({ id: "replan-" + String(one.calls[0].id), action: one.calls[0].action, args: clone(one.calls[0].args), next: "", source: "ai" });
        }
      }
    }
  } catch (e) { return [clone(DEFAULT_ACTION)]; }
  return out.length > 0 ? out : [clone(DEFAULT_ACTION)];
}

// 功能：把节点插入某个 bot 的动态执行队列，返回队列长度；坏值忽略。
function enqueue(botId, nodes) {
  var id = idOf(botId);
  try {
    if (!queues[id]) queues[id] = [];
    var list = Array.isArray(nodes) ? nodes : [nodes];
    for (var i = 0; i < list.length && queues[id].length < 64; i++) {
      if (!list[i] || typeof list[i] !== "object") continue;
      queues[id].push(clone(list[i]));
    }
    emit("replan.queue", { botId: id, size: queues[id].length });
    return { ok: true, botId: id, size: queues[id].length, inserted: list.length, message: "nodes queued / 节点已插入队列" };
  } catch (e) { return { ok: false, botId: id, size: 0, inserted: 0, message: errText(e) }; }
}

// 功能：取出并清空某个 bot 的动态执行队列（副本），异常返回空数组。
function drain(botId) {
  var id = idOf(botId);
  try {
    var list = queues[id] || [];
    queues[id] = [];
    return clone(list);
  } catch (e) { return []; }
}

// 功能：读队列长度，异常返回 0。
function queueSize(botId) {
  try { return (queues[idOf(botId)] || []).length; } catch (e) { return 0; }
}

// 功能：AI 兜底重规划——封装上下文 → askWithTools → 校验 → 入队；任何异常都降级为默认动作。
async function aiReplan(botId, context, options) {
  var id = idOf(botId);
  var opts = options && typeof options === "object" ? options : {};
  counters.replans = counters.replans + 1;
  var body = buildContext(context, id);
  var fallback = function (reason) {
    counters.fallbacks = counters.fallbacks + 1;
    var nodes = [clone(DEFAULT_ACTION)];
    enqueue(id, nodes);
    logSystem("重规划降级 / replan fallback: " + id + " reason=" + reason);
    emit("replan.fallback", { botId: id, reason: reason });
    return { ok: true, botId: id, source: "fallback", nodes: nodes, context: body, reason: reason, message: "fallback action / 已降级为默认动作" };
  };
  try {
    var client = aiClient();
    if (!client || typeof client.askWithTools !== "function") return fallback("AI unavailable / AI 不可用");
    if (opts.offline === true) return fallback("offline mode / 离线模式");
    var choice = null;
    try {
      choice = await client.askWithTools(REPLAN_PROMPT, JSON.stringify(body), toolsList(), null, id);
    } catch (e) { return fallback("AI error / AI 请求异常: " + errText(e)); }
    if (!choice) return fallback("empty AI reply / AI 无回包");
    var checked = validateCalls(choice);
    if (!checked.ok) {
      counters.invalid = counters.invalid + 1;
      return fallback("invalid tool_calls / 工具调用非法: " + checked.reason);
    }
    var nodes = toNodes(checked.calls);
    if (nodes.length === 1 && nodes[0].source === "fallback") return fallback("node conversion failed / 节点转换失败");
    counters.aiOk = counters.aiOk + 1;
    enqueue(id, nodes);
    logSystem("AI 重规划成功 / AI replan applied: " + id + " nodes=" + nodes.length);
    emit("replan.applied", { botId: id, nodes: nodes });
    return { ok: true, botId: id, source: "ai", nodes: nodes, context: body, reason: "", message: "AI replan applied / 已插入 AI 规划节点" };
  } catch (e) {
    return fallback("unexpected error / 未预期异常: " + errText(e));
  }
}

// 功能：读重规划统计，供蜂群面板与自测使用。
function stats(botId) {
  var id = idOf(botId);
  var rec = failures[id] || { count: 0, replans: 0, lastNode: "", lastError: "" };
  return {
    ok: true, botId: id, failures: rec.count, lastNode: rec.lastNode, lastError: rec.lastError,
    threshold: FAILURE_THRESHOLD, replans: counters.replans, aiOk: counters.aiOk,
    fallbacks: counters.fallbacks, invalid: counters.invalid, queue: queueSize(id)
  };
}

// 功能：清空计数与队列（自测隔离用），返回 { ok }。
function reset() {
  try {
    failures = {}; queues = {}; injectedAi = null; injectedTools = null;
    counters = { replans: 0, aiOk: 0, fallbacks: 0, invalid: 0 };
  } catch (e) { /* ignore */ }
  return { ok: true, message: "replan reset / 重规划状态已重置" };
}

// 对外导出：看门狗 / 上下文 / 校验 / 入队 / AI 兜底 / 统计。
module.exports = {
  recordFailure: recordFailure,
  buildContext: buildContext,
  validateCalls: validateCalls,
  toNodes: toNodes,
  aiReplan: aiReplan,
  enqueue: enqueue,
  drain: drain,
  queueSize: queueSize,
  stats: stats,
  setAiClient: setAiClient,
  setTools: setTools,
  reset: reset,
  FAILURE_THRESHOLD: FAILURE_THRESHOLD,
  DEFAULT_ACTION: DEFAULT_ACTION,
  ACTION_MAP: ACTION_MAP
};
