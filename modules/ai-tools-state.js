// ========================================
// 文件：modules/ai-tools-state.js
// 功能：AI 状态机工具（三件套）——run_state_machine / stop_state_machine / create_and_run_machine
// 依赖：./state-machine、./state-nodes、./state-util、./logger（可选）、./chat-permissions（可选）
// 导出：getTools / filterTools / toolAllowed / executeTool / isStateTool / listPending /
//       confirmPending / cancelPending / TOOL_NAMES / TOOL_ACTIONS
// 作者：MineBots
// ========================================
//
// 安全约定：
//   1. AI 只能跑「已经存在」的状态机；要新建 / 覆盖必须先写入 pending，等用户在 GUI 点确认后才落盘。
//   2. 定义一律先过 state-machine.validate（节点数 / 步数 / 时长 / 单节点重复 4 重护栏）。
//   3. 权限走白名单：跑 / 停按 move，新建要求 move；等级不够一律拒绝。
// ES5 风格，CommonJS，无中文变量名
var stateMachine = null;
try { stateMachine = require("./state-machine"); } catch (e) { stateMachine = null; }

// 可选依赖：节点目录（给 AI 提示可用动作名）。
var nodes = null;
try { nodes = require("./state-nodes"); } catch (e) { nodes = null; }

// 可选依赖：公共工具（转文本 / 日志）。
var util = null;
try { util = require("./state-util"); } catch (e) { util = null; }

// 可选依赖：权限表（缺失时一律拒绝，宁严不松）。
var permissions = null;
try { permissions = require("./chat-permissions"); } catch (e) { permissions = null; }

// 可选依赖：日志核心，缺失时退回 console。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 可选依赖：五级 JSON 修复引擎；AI 参数与 AI 生成的状态机定义一律经它解析。
var jsonRepair = null; try { jsonRepair = require("./json-repair"); } catch (e) { jsonRepair = null; }

// 强制五级解析：引擎缺失时退回原生解析，失败返回 fallback，绝不抛错。
function safeJson(text, fallback) {
  try { if (jsonRepair) return jsonRepair.safeParse(text, fallback); return JSON.parse(toText(text)); }
  catch (e) { return fallback; }
}

// 常量：三个工具名（顺序即 AI 看到的顺序）/ 待确认表的最大条目数。
var RUN_TOOL = "run_state_machine";
var STOP_TOOL = "stop_state_machine";
var CREATE_TOOL = "create_and_run_machine";
var TOOL_NAMES = [RUN_TOOL, STOP_TOOL, CREATE_TOOL];
var MAX_PENDING = 8;

// 状态：botId → { name, definition, at }（等用户确认的覆盖请求）。
var pending = {};

// 安全提取错误文本，catch 里不会二次抛错。
function getErrText(err) {
  try {
    if (err && err.message) return String(err.message);
    return String(err);
  } catch (e) { return "unknown error"; }
}

// 转文本（null / undefined → 空串）。
function toText(value) {
  try {
    if (value === null || value === undefined) return "";
    return String(value);
  } catch (e) { return ""; }
}

// 写文件日志：工具调用只落文件，避免刷 GUI。
function logInfo(msg) {
  try {
    if (logger && typeof logger.info === "function") { logger.info("[ai-tools-state] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[ai-tools-state] " + msg); } catch (e) { /* ignore */ }
}

// 写告警日志（推 GUI）：工具被拒 / 需要确认这类要用户知道的事才用。
function logWarn(msg) {
  try {
    if (logger && typeof logger.warn === "function") { logger.warn("[ai-tools-state] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.warn("[ai-tools-state] " + msg); } catch (e) { /* ignore */ }
}

// 组装一个 OpenAI 格式的工具定义。
function tool(name, description, props, required) {
  return {
    type: "function",
    function: {
      name: name,
      description: description,
      parameters: { type: "object", properties: props || {}, required: required || [] }
    }
  };
}

// 参数描述：整数 / 字符串 / 布尔 / 对象，一律「中文 / English」。
function strProp(zh, en) { return { type: "string", description: zh + " / " + en }; }
function intProp(zh, en) { return { type: "integer", description: zh + " / " + en }; }
function boolProp(zh, en) { return { type: "boolean", description: zh + " / " + en }; }
function objProp(zh, en) { return { type: "object", description: zh + " / " + en }; }

// 常量：工具菜单（AI 只能看到这三个状态机工具）。
var TOOLS = [
  tool(RUN_TOOL, "运行一个已保存的状态机（名字来自 state/statemachines）/ Run a saved state machine", {
    machine: strProp("状态机名字，如 woodcutter", "machine name such as woodcutter"),
    bot: strProp("目标 bot 名字，可省略（默认自己）", "target bot name, optional")
  }, ["machine"]),
  tool(STOP_TOOL, "停止正在跑的状态机 / Stop the running state machine", {
    bot: strProp("目标 bot 名字，可省略（默认自己）", "target bot name, optional")
  }, []),
  tool(CREATE_TOOL, "新建并运行状态机（会先校验，覆盖已有文件需要用户确认）/ Create and run a machine (validated, overwrite needs user confirmation)", {
    name: strProp("状态机名字，只能字母数字下划线横杠", "machine name, letters digits underscore dash only"),
    definition: objProp("状态机定义对象（nodes 数组 + start）", "machine definition object (nodes array + start)"),
    overwrite: boolProp("是否允许覆盖同名文件（需用户确认）", "allow overwriting an existing file (needs user confirmation)")
  }, ["name", "definition"])
];

// 常量：工具 → 权限动作名（跑 / 停 / 新建都按 move 判，宁严不松）。
var TOOL_ACTIONS = {};
TOOL_ACTIONS[RUN_TOOL] = "move";
TOOL_ACTIONS[STOP_TOOL] = "move";
TOOL_ACTIONS[CREATE_TOOL] = "move";

// 判断某个名字是不是状态机工具（大小写不敏感，兼容 functions. 前缀）。
function isStateTool(name) {
  var key = toText(name).replace(/^\s+|\s+$/g, "").toLowerCase();
  if (key.indexOf("functions.") === 0) key = key.slice(10);
  return TOOL_NAMES.indexOf(key) >= 0;
}

// 功能：返回三个状态机工具的完整定义（直接交给 ai.askWithTools）。
function getTools() {
  return TOOLS.slice();
}

// 单个工具是否允许：权限模块缺失一律拒绝，敌对等级全拒。
function toolAllowed(level, toolName) {
  var key = toText(toolName).replace(/^\s+|\s+$/g, "").toLowerCase();
  if (key.indexOf("functions.") === 0) key = key.slice(10);
  if (TOOL_NAMES.indexOf(key) < 0) return false;
  if (!permissions || typeof permissions.isAllowed !== "function") return false;
  try {
    if (typeof permissions.isHostile === "function" && permissions.isHostile(level)) return false;
    return permissions.isAllowed(level, TOOL_ACTIONS[key]);
  } catch (e) { return false; }
}

// 功能：按等级裁剪工具菜单——只给当前玩家有权限调用的那几个。
function filterTools(level) {
  var out = [];
  try {
    for (var i = 0; i < TOOLS.length; i++) {
      if (toolAllowed(level, TOOLS[i].function.name)) out.push(TOOLS[i]);
    }
  } catch (e) { return []; }
  return out;
}

// 把参数解析成对象：接受对象或脏 JSON 字符串，强制五级修复，全败返回 null。
function parseArgs(args) {
  if (!args) return {};
  if (typeof args === "object") return args;
  var parsed = safeJson(args, null);
  return (parsed && typeof parsed === "object") ? parsed : null;
}

// 双语失败文本：供 chat-handler 直接交给 AI 做二次对话。
function failText(toolName, reason) {
  return "执行失败 / failed: " + toText(toolName) + " - " + toText(reason);
}

// 双语成功文本。
function okText(toolName, detail) {
  var tail = toText(detail);
  return "成功 / ok: " + toText(toolName) + (tail.length > 0 ? " (" + tail + ")" : "");
}

// 功能：把待确认的覆盖请求写进内存表（同一个 bot 只留最新一条）。
function requestOverwrite(botId, name, definition) {
  var id = toText(botId || "default");
  var key = toText(name);
  try {
    var count = 0;
    for (var k in pending) { if (Object.prototype.hasOwnProperty.call(pending, k)) count++; }
    if (count >= MAX_PENDING && !pending[id]) return { ok: false, message: "待确认请求过多 / too many pending requests" };
    pending[id] = { name: key, definition: definition, at: new Date().toISOString() };
    return { ok: true, id: id, name: key };
  } catch (e) {
    return { ok: false, message: getErrText(e) };
  }
}

// 功能：列出所有待确认的覆盖请求（GUI 确认弹窗用）。
function listPending() {
  var out = [];
  try {
    for (var key in pending) {
      if (!Object.prototype.hasOwnProperty.call(pending, key)) continue;
      out.push({ botId: key, name: pending[key].name, at: pending[key].at });
    }
  } catch (e) { /* 返回已收集到的部分 */ }
  return out;
}

// 功能：用户点了确认——真正落盘并立刻运行，返回 { ok, message }。
async function confirmPending(botId, bot) {
  var id = toText(botId || "default");
  var item = null;
  try { item = pending[id]; } catch (e) { item = null; }
  if (!item) return { ok: false, message: "没有待确认的请求 / no pending request: " + id };
  if (!stateMachine || typeof stateMachine.saveMachine !== "function") return { ok: false, message: "state-machine 不可用 / state-machine unavailable" };
  var saved = stateMachine.saveMachine(item.name, item.definition);
  if (!saved || saved.ok !== true) return { ok: false, message: toText(saved ? saved.message : "save failed") };
  try { delete pending[id]; } catch (e) { /* ignore */ }
  logWarn("用户确认覆盖状态机 / overwrite confirmed: " + item.name + " @ " + id);
  var runner = (typeof stateMachine.run === "function") ? stateMachine.run : null;
  if (!runner) return { ok: true, name: item.name, message: "已保存 / saved: " + item.name };
  var res = await runner(bot, item.definition, id);
  return { ok: !!res.ok, name: item.name, message: toText(res.message) };
}

// 功能：用户点了取消——丢掉待确认请求，返回 { ok, removed }。
function cancelPending(botId) {
  var id = toText(botId || "default");
  var had = false;
  try { had = !!pending[id]; delete pending[id]; } catch (e) { had = false; }
  return { ok: true, botId: id, removed: had };
}

// 把校验错误拼成一句话（最多列 3 条，避免刷屏）。
function errorsText(errors) {
  var list = Array.isArray(errors) ? errors : [];
  var parts = [];
  for (var i = 0; i < list.length && i < 3; i++) parts.push(toText(list[i]));
  return parts.length > 0 ? parts.join("；") : "定义不合法 / invalid definition";
}

// 功能：执行 run_state_machine——只跑已保存的状态机。
async function doRun(bot, botId, args) {
  var name = toText(args.machine).replace(/^\s+|\s+$/g, "");
  if (name.length === 0) return failText(RUN_TOOL, "machine 不能为空 / machine required");
  if (!stateMachine || typeof stateMachine.runByName !== "function") return failText(RUN_TOOL, "state-machine 不可用 / state-machine unavailable");
  if (typeof stateMachine.isRunning === "function" && stateMachine.isRunning(botId)) {
    return failText(RUN_TOOL, "该 bot 已经在跑状态机 / already running: " + toText(botId));
  }
  var res = await stateMachine.runByName(bot, name, botId);
  if (!res || res.ok !== true) {
    var why = toText(res ? res.message : "");
    if (res && Array.isArray(res.errors)) why = errorsText(res.errors);
    return failText(RUN_TOOL, why.length > 0 ? why : "无法运行 / cannot run");
  }
  return okText(RUN_TOOL, toText(res.name) + " steps=" + toText(res.steps));
}

// 功能：执行 stop_state_machine——停掉当前 bot 的状态机。
async function doStop(bot, botId, args) {
  if (!stateMachine || typeof stateMachine.stop !== "function") return failText(STOP_TOOL, "state-machine 不可用 / state-machine unavailable");
  var target = toText(args.bot).replace(/^\s+|\s+$/g, "");
  if (target.length === 0) target = toText(botId);
  var res = stateMachine.stop(target);
  if (!res || res.ok !== true) return failText(STOP_TOOL, toText(res ? res.message : "stop failed"));
  return okText(STOP_TOOL, target);
}

// 功能：执行 create_and_run_machine——先校验；同名文件已存在时进待确认队列，等用户确认。
async function doCreate(bot, botId, args) {
  var name = toText(args.name).replace(/^\s+|\s+$/g, "");
  if (name.length === 0) return failText(CREATE_TOOL, "name 不能为空 / name required");
  var def = args.definition;
  if (typeof def === "string") {
    def = safeJson(def, null); // AI 生成的状态 JSON：先过五级修复，再交给 validate。
    if (!def || typeof def !== "object") return failText(CREATE_TOOL, "definition 不是合法 JSON / definition is not valid JSON");
  }
  if (!def || typeof def !== "object") return failText(CREATE_TOOL, "definition 必须是对象 / definition must be an object");
  if (!stateMachine || typeof stateMachine.validate !== "function") return failText(CREATE_TOOL, "state-machine 不可用 / state-machine unavailable");
  var check = stateMachine.validate(def);
  if (!check.ok) return failText(CREATE_TOOL, errorsText(check.errors));
  var exists = false;
  try {
    var listed = (typeof stateMachine.listMachines === "function") ? stateMachine.listMachines() : [];
    exists = listed.indexOf(name) >= 0;
  } catch (e) { exists = false; }
  if (exists) {
    var token = requestOverwrite(botId, name, def);
    if (!token.ok) return failText(CREATE_TOOL, toText(token.message));
    logWarn("状态机同名，等待用户确认 / pending overwrite: " + name + " @ " + toText(botId));
    return "需要用户确认 / needs confirmation: 状态机 " + name + " 已存在，请在面板点确认后才会覆盖并运行 / machine exists, confirm in panel first";
  }
  var saved = stateMachine.saveMachine(name, def);
  if (!saved || saved.ok !== true) return failText(CREATE_TOOL, toText(saved ? saved.message : "save failed"));
  if (typeof stateMachine.run !== "function") return okText(CREATE_TOOL, "saved " + name);
  var res = await stateMachine.run(bot, def, botId);
  if (!res || res.ok !== true) return failText(CREATE_TOOL, toText(res ? res.message : "run failed"));
  return okText(CREATE_TOOL, name + " steps=" + toText(res.steps));
}

// 功能：执行一次状态机工具调用，返回中英双语提示文本；失败一律回「执行失败」，绝不抛错。
async function executeTool(bot, botId, toolName, args) {
  var key = toText(toolName).replace(/^\s+|\s+$/g, "").toLowerCase();
  if (key.indexOf("functions.") === 0) key = key.slice(10);
  if (TOOL_NAMES.indexOf(key) < 0) return failText(key.length > 0 ? key : "?", "未知工具 / unknown tool");
  if (!bot) return failText(key, "bot not ready / 机器人未就绪");
  var realArgs = parseArgs(args);
  if (!realArgs) return failText(key, "参数不是合法 JSON / arguments are not valid JSON");
  try {
    if (key === RUN_TOOL) return await doRun(bot, botId, realArgs);
    if (key === STOP_TOOL) return await doStop(bot, botId, realArgs);
    return await doCreate(bot, botId, realArgs);
  } catch (err) {
    logWarn(key + " 执行异常 / failed: " + getErrText(err));
    return failText(key, getErrText(err));
  }
}

// 对外导出：三件套菜单 / 权限裁剪 / 执行 / 待确认队列 / 名单与动作映射。
module.exports = {
  getTools: getTools,
  filterTools: filterTools,
  toolAllowed: toolAllowed,
  isStateTool: isStateTool,
  executeTool: executeTool,
  listPending: listPending,
  confirmPending: confirmPending,
  cancelPending: cancelPending,
  TOOL_NAMES: TOOL_NAMES,
  TOOL_ACTIONS: TOOL_ACTIONS
};


