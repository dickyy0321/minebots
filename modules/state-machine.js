// ========================================
// 文件：modules/state-machine.js
// 功能：状态机核心——JSON 定义校验 / 4 重防死循环护栏 / 条件分支 / 运行与停止 / 每 bot 独立运行时
// 依赖：./state-nodes（节点派发）、./state-util、./swarm（可选）、./logger（可选）
// 导出：validate / run / runByName / stop / isRunning / getRuntime / listRunning /
//       loadMachine / saveMachine / listMachines / evaluateCondition / getLimits
// 作者：MineBots
// ========================================
//
// 定义格式 / machine definition
//   { name, description, start, loop, maxSteps, maxDurationMs, maxNodeRepeat,
//     nodes: [ { id, action, args, next, when: { field, op, value, goto }, delayMs, onError } ] }
// 护栏 / loop guards（任何一条触发即停）
//   1. 节点总数 <= MAX_NODES      2. 总步数 <= maxSteps
//   3. 总时长 <= maxDurationMs   4. 单节点重复执行次数 <= maxNodeRepeat
// ES5 风格，CommonJS，无中文变量名
var fs = require("fs");
var path = require("path");

// 可选依赖：节点派发（8 大分类 + 宏）。
var nodes = null;
try { nodes = require("./state-nodes"); } catch (e) { nodes = null; }

// 可选依赖：公共工具（变量解析 / 日志 / sleep）。
var util = null;
try { util = require("./state-util"); } catch (e) { util = null; }

// 可选依赖：群体协同（登记 bot、同步状态），缺失时只影响多 bot 节点。
var swarm = null;
try { swarm = require("./swarm"); } catch (e) { swarm = null; }

// 可选依赖：日志核心，缺失时退回 console。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 可选依赖：五级 JSON 修复引擎；状态机定义文件一律经它解析，脏文件也能救回来。
var jsonRepair = null; try { jsonRepair = require("./json-repair"); } catch (e) { jsonRepair = null; }

// 强制五级解析状态 JSON：引擎缺失时退回原生解析，失败返回 null，绝不抛错。
function safeStateJson(text) {
  try {
    if (jsonRepair) {
      var d = jsonRepair.safeParseDetailed(text, null);
      return d.usedFallback ? null : d.value;
    }
    return JSON.parse(text);
  } catch (e) { return null; }
}

// 常量：护栏上限 / 定义目录。
var MAX_NODES = 200;
var DEFAULT_MAX_STEPS = 200;
var HARD_MAX_STEPS = 2000;
var DEFAULT_DURATION_MS = 600000;
var HARD_MAX_DURATION_MS = 3600000;
var DEFAULT_NODE_REPEAT = 50;
var MACHINE_DIR = path.join("state", "statemachines");
var ALLOWED_OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "exists", "contains", "truthy", "falsy"];

// 状态：botId → 运行时（含停止标记 / 当前节点 / 步数），每 bot 完全独立。
var runtimes = {};

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

// 转数字（失败返回兜底值）。
function toNum(value, fallback) {
  var base = (fallback === undefined) ? 0 : fallback;
  try {
    var num = parseFloat(toText(value));
    return isNaN(num) ? base : num;
  } catch (e) { return base; }
}

// 写文件日志：状态机每步都写文件，绝不刷 GUI。
function logInfo(msg) {
  try {
    if (logger && typeof logger.info === "function") { logger.info("[state-machine] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[state-machine] " + msg); } catch (e) { /* ignore */ }
}

// 写系统日志（推 GUI）：只用于启动 / 停止 / 触发护栏。
function logSystem(msg) {
  try {
    if (logger && typeof logger.system === "function") { logger.system("[state-machine] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[state-machine] " + msg); } catch (e) { /* ignore */ }
}

// 对外暴露护栏常量，GUI / 自测用来展示上限。
function getLimits() {
  return {
    maxNodes: MAX_NODES,
    maxSteps: HARD_MAX_STEPS,
    maxDurationMs: HARD_MAX_DURATION_MS,
    maxNodeRepeat: DEFAULT_NODE_REPEAT
  };
}

// 从 ctx 里按字段名取值：支持 "$var" / "$var.key" 以及直接写相对路径。
function readField(ctx, field) {
  var name = toText(field).replace(/^\s+|\s+$/g, "");
  if (name.length === 0) return undefined;
  var box = ctx || {};
  try {
    if (name.charAt(0) === "$") {
      if (util && typeof util.readVar === "function") {
        var found = util.readVar({ vars: box.vars, status: box.status, last: box.last }, name);
        if (found !== undefined) return found;
      }
      var plain = name.slice(1);
      if (box.vars && box.vars[plain] !== undefined) return box.vars[plain];
      return undefined;
    }
    if (name.indexOf("vars.") === 0) {
      var key = name.slice(5);
      return box.vars ? box.vars[key] : undefined;
    }
    if (name.indexOf("last.") === 0) {
      var lastKey = name.slice(5);
      return box.last ? box.last[lastKey] : undefined;
    }
    if (name === "health") { return box.bot ? box.bot.health : undefined; }
    if (name === "food") { return box.bot ? box.bot.food : undefined; }
    if (box.vars && box.vars[name] !== undefined) return box.vars[name];
    return undefined;
  } catch (e) { return undefined; }
}

// 判断一个条件是否成立：cond 形如 { field, op, value }；cond 为空视为成立。
function evaluateCondition(cond, ctx) {
  if (!cond || typeof cond !== "object") return true;
  var op = toText(cond.op || "eq").toLowerCase();
  var got = readField(ctx, cond.field !== undefined ? cond.field : cond.var);
  try {
    if (op === "exists") return got !== undefined && got !== null;
    if (op === "truthy") return !!got;
    if (op === "falsy") return !got;
    if (op === "contains") return toText(got).indexOf(toText(cond.value)) >= 0;
    if (op === "ne") return toText(got) !== toText(cond.value);
    if (op === "gt") return toNum(got, 0) > toNum(cond.value, 0);
    if (op === "gte") return toNum(got, 0) >= toNum(cond.value, 0);
    if (op === "lt") return toNum(got, 0) < toNum(cond.value, 0);
    if (op === "lte") return toNum(got, 0) <= toNum(cond.value, 0);
    return toText(got) === toText(cond.value);
  } catch (e) { return false; }
}

// 功能：校验状态机定义，返回 { ok, errors, definition }；errors 是中英双语文本数组。
function validate(definition) {
  var errors = [];
  var def = definition;
  try {
    if (!def || typeof def !== "object" || Array.isArray(def)) {
      return { ok: false, errors: ["定义必须是对象 / definition must be an object"], definition: null };
    }
    var list = Array.isArray(def.nodes) ? def.nodes : null;
    if (!list) return { ok: false, errors: ["nodes 必须是数组 / nodes must be an array"], definition: null };
    if (list.length === 0) return { ok: false, errors: ["nodes 不能为空 / nodes must not be empty"], definition: null };
    if (list.length > MAX_NODES) {
      errors.push("节点数超过上限 " + MAX_NODES + " / too many nodes: " + list.length);
    }
    var ids = {};
    for (var i = 0; i < list.length; i++) {
      var node = list[i];
      var where = "节点 #" + i + " / node #" + i;
      if (!node || typeof node !== "object") { errors.push(where + " 必须是对象 / must be an object"); continue; }
      var id = toText(node.id).replace(/^\s+|\s+$/g, "");
      if (id.length === 0) { errors.push(where + " 缺少 id / missing id"); continue; }
      if (ids[id]) { errors.push("id 重复 / duplicated id: " + id); continue; }
      ids[id] = true;
      var action = toText(node.action).replace(/^\s+|\s+$/g, "").toLowerCase();
      if (action.length === 0) { errors.push(id + " 缺少 action / missing action"); continue; }
      var known = nodes && typeof nodes.isAction === "function" ? nodes.isAction(action) : true;
      if (!known) errors.push(id + " 的动作不存在 / unknown action: " + action);
      if (node.args !== undefined && (typeof node.args !== "object" || node.args === null || Array.isArray(node.args))) {
        errors.push(id + " 的 args 必须是对象 / args must be an object");
      }
      var when = node.when;
      if (when !== undefined && when !== null) {
        if (typeof when !== "object" || Array.isArray(when)) {
          errors.push(id + " 的 when 必须是对象 / when must be an object");
        } else {
          var op = toText(when.op || "eq").toLowerCase();
          if (ALLOWED_OPS.indexOf(op) < 0) errors.push(id + " 的 when.op 不支持 / unsupported op: " + op);
          var gotoId = toText(when.goto).replace(/^\s+|\s+$/g, "");
          if (gotoId.length === 0) errors.push(id + " 的 when.goto 不能为空 / when.goto required");
        }
      }
    }
    // 第二遍：检查 next / goto 指向的节点是否存在（必须先收集完所有 id）
    for (var k = 0; k < list.length; k++) {
      var one = list[k];
      if (!one || typeof one !== "object") continue;
      var ownId = toText(one.id).replace(/^\s+|\s+$/g, "");
      var nextId = (one.next === null || one.next === undefined) ? "" : toText(one.next).replace(/^\s+|\s+$/g, "");
      if (nextId.length > 0 && nextId !== "end" && !ids[nextId]) {
        errors.push(ownId + " 的 next 指向不存在的节点 / next not found: " + nextId);
      }
      if (one.when && typeof one.when === "object") {
        var g = toText(one.when.goto).replace(/^\s+|\s+$/g, "");
        if (g.length > 0 && g !== "end" && !ids[g]) {
          errors.push(ownId + " 的 when.goto 指向不存在的节点 / goto not found: " + g);
        }
      }
    }
    var startId = toText(def.start).replace(/^\s+|\s+$/g, "");
    if (startId.length === 0) startId = toText(list[0] ? list[0].id : "").replace(/^\s+|\s+$/g, "");
    if (startId.length > 0 && !ids[startId]) {
      errors.push("start 指向不存在的节点 / start not found: " + startId);
    }
    if (errors.length > 0) return { ok: false, errors: errors, definition: null };
    return { ok: true, errors: [], definition: def };
  } catch (err) {
    return { ok: false, errors: [getErrText(err)], definition: null };
  }
}

// 取状态机定义目录的绝对路径，取不到退回相对路径。
function machineDir() {
  try { return path.resolve(process.cwd(), MACHINE_DIR); } catch (e) { return MACHINE_DIR; }
}

// 洗状态机名字：只留字母数字下划线横杠，最长 60，非法返回空串（防目录穿越）。
function cleanName(name) {
  try {
    var text = toText(name).replace(/^\s+|\s+$/g, "");
    if (text.length === 0) return "";
    if (!/^[A-Za-z0-9_-]+$/.test(text)) return "";
    return text.length > 60 ? text.slice(0, 60) : text;
  } catch (e) { return ""; }
}

// 功能：读一个状态机定义文件，返回 { ok, name, definition }；读不到 / 解析失败都返回 ok:false。
function loadMachine(name) {
  var key = cleanName(name);
  if (key.length === 0) return { ok: false, message: "状态机名字不合法 / invalid machine name" };
  try {
    var file = path.join(machineDir(), key + ".json");
    if (!fs.existsSync(file)) return { ok: false, message: "状态机不存在 / machine not found: " + key };
    var text = fs.readFileSync(file, "utf8");
    var parsed = safeStateJson(text);
    if (!parsed || typeof parsed !== "object") return { ok: false, message: "状态机定义不是合法 JSON / invalid machine JSON: " + key };
    return { ok: true, name: key, definition: parsed };
  } catch (err) {
    logInfo("读取状态机失败 / load failed: " + key + " - " + getErrText(err));
    return { ok: false, message: getErrText(err) };
  }
}

// 功能：保存一个状态机定义（先校验再落盘），返回 { ok, name, path }。
function saveMachine(name, definition) {
  var key = cleanName(name);
  if (key.length === 0) return { ok: false, message: "状态机名字不合法 / invalid machine name" };
  var check = validate(definition);
  if (!check.ok) return { ok: false, errors: check.errors, message: "定义不合法 / invalid definition" };
  try {
    var dir = machineDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    var file = path.join(dir, key + ".json");
    fs.writeFileSync(file, JSON.stringify(check.definition, null, 2), "utf8");
    logSystem("状态机已保存 / machine saved: " + key);
    return { ok: true, name: key, path: file };
  } catch (err) {
    return { ok: false, message: getErrText(err) };
  }
}

// 功能：列出全部已保存的状态机名字（去掉 .json），目录不存在返回空数组。
function listMachines() {
  var out = [];
  try {
    var dir = machineDir();
    if (!fs.existsSync(dir)) return out;
    var items = fs.readdirSync(dir);
    for (var i = 0; i < items.length; i++) {
      var fileName = toText(items[i]);
      if (!/\.json$/i.test(fileName)) continue;
      out.push(fileName.slice(0, fileName.length - 5));
    }
  } catch (err) {
    logInfo("列状态机失败 / list failed: " + getErrText(err));
  }
  return out;
}

// 功能：跑一个已经校验过的状态机定义；返回 { ok, steps, reason, message }，触发护栏也在 reason / guard 里说明。
async function run(bot, definition, botId, options) {
  var check = validate(definition);
  if (!check.ok) return { ok: false, errors: check.errors, message: "定义不合法 / invalid definition" };
  if (!bot) return { ok: false, message: "bot not ready / 机器人未就绪" };
  var def = check.definition;
  var id = toText(botId || (bot && bot.username) || "default");
  var map = {};
  var list = def.nodes;
  for (var i = 0; i < list.length; i++) {
    var key = toText(list[i].id).replace(/^\s+|\s+$/g, "");
    map[key] = list[i];
  }
  var startId = toText(def.start).replace(/^\s+|\s+$/g, "");
  if (startId.length === 0) startId = toText(list[0].id).replace(/^\s+|\s+$/g, "");
  var maxSteps = Math.round(toNum(def.maxSteps, DEFAULT_MAX_STEPS));
  if (maxSteps < 1) maxSteps = 1;
  if (maxSteps > HARD_MAX_STEPS) maxSteps = HARD_MAX_STEPS;
  var maxDuration = Math.round(toNum(def.maxDurationMs, DEFAULT_DURATION_MS));
  if (maxDuration < 1000) maxDuration = 1000;
  if (maxDuration > HARD_MAX_DURATION_MS) maxDuration = HARD_MAX_DURATION_MS;
  var maxRepeat = Math.round(toNum(def.maxNodeRepeat, DEFAULT_NODE_REPEAT));
  if (maxRepeat < 1) maxRepeat = 1;
  if (maxRepeat > 1000) maxRepeat = 1000;
  var runtime = {
    botId: id,
    name: toText(def.name || "machine"),
    startedAt: Date.now(),
    steps: 0,
    repeat: {},
    currentNode: startId,
    stopRequested: false,
    running: true,
    reason: "",
    lastResult: null
  };
  runtimes[id] = runtime;
  var ctx = { bot: bot, botId: id, vars: {}, counters: {}, events: {}, machine: def, runtime: runtime, last: null, status: null };
  try { if (swarm && typeof swarm.register === "function") swarm.register(bot, id); } catch (e) { /* 登记失败不影响运行 */ }
  logSystem("状态机启动 / machine started: " + runtime.name + " @ " + id);
  var result = await runLoop(ctx, runtime, map, startId, def, maxSteps, maxDuration, maxRepeat);
  runtime.running = false;
  runtime.reason = result.reason;
  runtime.guard = result.guard;
  runtime.elapsed = Date.now() - runtime.startedAt;
  logSystem("状态机结束 / machine stopped: " + runtime.name + " @ " + id + " -> " + result.reason + (result.guard.length > 0 ? " (" + result.guard + ")" : ""));
  var okDone = (result.reason === "finished" || result.reason === "stopped");
  return {
    ok: okDone,
    botId: id,
    name: runtime.name,
    steps: runtime.steps,
    reason: result.reason,
    guard: result.guard,
    message: okDone ? ("状态机完成 / machine done: " + runtime.steps + " 步 / steps") : ("状态机中断 / machine halted: " + (result.guard.length > 0 ? result.guard : result.reason))
  };
}

// 内部：状态机主循环——每轮先查护栏，再执行节点，最后按 when / next 决定下一跳。
async function runLoop(ctx, runtime, map, startId, def, maxSteps, maxDuration, maxRepeat) {
  var current = startId;
  var reason = "finished";
  var guard = "";
  while (true) {
    if (runtime.stopRequested) { reason = "stopped"; break; }
    if (runtime.steps >= maxSteps) { reason = "guard"; guard = "步数上限 / step limit: " + maxSteps; break; }
    if ((Date.now() - runtime.startedAt) >= maxDuration) { reason = "guard"; guard = "时长上限 / duration limit: " + maxDuration + "ms"; break; }
    var node = map[current];
    if (!node) { reason = "missing"; guard = "节点不存在 / node not found: " + current; break; }
    var repeatCount = toNum(runtime.repeat[current], 0) + 1;
    if (repeatCount > maxRepeat) { reason = "guard"; guard = "单节点重复上限 / node repeat limit: " + current + " x" + maxRepeat; break; }
    runtime.repeat[current] = repeatCount;
    runtime.currentNode = current;
    runtime.steps++;
    ctx.events = {};
    if (node.delayMs !== undefined) {
      var wait = toNum(node.delayMs, 0);
      if (wait > 0) { if (util) await util.sleep(wait); }
    }
    var res = nodes ? await nodes.execute(ctx, node.action, node.args) : { ok: false, message: "state-nodes 不可用 / state-nodes unavailable" };
    runtime.lastResult = res;
    try { ctx.last = res; ctx.vars.lastAction = toText(node.action); } catch (e) { /* ignore */ }
    if (res && res.ok === false && toText(node.onError).toLowerCase() === "stop") {
      reason = "error";
      guard = toText(res.message) || ("节点执行失败 / node failed: " + toText(node.action));
      break;
    }
    var nextId = (node.next === null || node.next === undefined) ? "" : toText(node.next).replace(/^\s+|\s+$/g, "");
    if (node.when && typeof node.when === "object" && evaluateCondition(node.when, ctx)) {
      nextId = toText(node.when.goto).replace(/^\s+|\s+$/g, "");
    }
    if (nextId === "end") nextId = "";
    if (nextId.length === 0) {
      if (def.loop === true) { nextId = startId; }
      else { reason = "finished"; break; }
    }
    current = nextId;
  }
  return { reason: reason, guard: guard };
}

// 功能：按名字读定义再跑；定义不存在直接返回 ok:false。
async function runByName(bot, name, botId, options) {
  var loaded = loadMachine(name);
  if (!loaded.ok) return loaded;
  return run(bot, loaded.definition, botId, options);
}

// 功能：请求停止某个 bot 的状态机（异步生效，最多再跑完当前节点）；没在跑时返回 ok:false。
function stop(botId) {
  var id = toText(botId || "default");
  var runtime = null;
  try { runtime = runtimes[id]; } catch (e) { runtime = null; }
  if (!runtime || runtime.running !== true) return { ok: false, botId: id, message: "该 bot 没有在跑状态机 / no running machine: " + id };
  runtime.stopRequested = true;
  return { ok: true, botId: id, message: "已请求停止 / stop requested: " + id };
}

// 功能：某个 bot 是否正在跑状态机。
function isRunning(botId) {
  var id = toText(botId || "default");
  try {
    var runtime = runtimes[id];
    return !!(runtime && runtime.running === true);
  } catch (e) { return false; }
}

// 功能：取某个 bot 的运行时快照（副本），没有返回 null。
function getRuntime(botId) {
  var id = toText(botId || "default");
  var runtime = null;
  try { runtime = runtimes[id]; } catch (e) { runtime = null; }
  if (!runtime) return null;
  return {
    botId: runtime.botId,
    name: runtime.name,
    steps: runtime.steps,
    currentNode: runtime.currentNode,
    running: runtime.running,
    reason: runtime.reason,
    guard: runtime.guard || "",
    startedAt: runtime.startedAt,
    elapsed: runtime.elapsed === undefined ? (Date.now() - runtime.startedAt) : runtime.elapsed,
    lastResult: runtime.lastResult
  };
}

// 功能：列出所有正在跑的 bot（id 数组）。
function listRunning() {
  var out = [];
  try {
    for (var key in runtimes) {
      if (!Object.prototype.hasOwnProperty.call(runtimes, key)) continue;
      if (runtimes[key] && runtimes[key].running === true) out.push(key);
    }
  } catch (e) { /* 返回已收集到的部分 */ }
  return out;
}

// 对外导出：校验 / 运行 / 停止 / 运行时查询 / 定义文件读写 / 护栏常量。
module.exports = {
  validate: validate,
  run: run,
  runByName: runByName,
  stop: stop,
  isRunning: isRunning,
  getRuntime: getRuntime,
  listRunning: listRunning,
  loadMachine: loadMachine,
  saveMachine: saveMachine,
  listMachines: listMachines,
  evaluateCondition: evaluateCondition,
  getLimits: getLimits
};






