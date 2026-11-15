// ========================================
// 文件：modules/state-skills-ai.js
// 功能：状态机技能（数学变量类 + AI 类）——变量加减乘除 / 安全表达式求值 / 随机数 / 问 AI / 让 AI 决策
// 依赖：./state-util、./ai-client（可选）
// 导出：HANDLERS / NAMES / has / pick / evalExpr
// 作者：MineBots
// ========================================
//
// 说明：calc 节点用的是自带的小型递归下降求值器（只认数字、括号和 + - * / %），
//       绝不调用 eval / Function，避免状态机文件里塞进可执行代码。
// ES5 风格，CommonJS，无中文变量名
var util = null;
try { util = require("./state-util"); } catch (e) { util = null; }

// 可选依赖：AI 客户端（问模型 / 让模型决策），缺失时相关节点直接返回 ok:false。
var ai = null;
try { ai = require("./ai-client"); } catch (e) { ai = null; }

// 可选依赖：日志核心，缺失时退回 console。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

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

// 写文件日志：节点求值属于高频信息，只落文件。
function logInfo(msg) {
  try {
    if (logger && typeof logger.info === "function") { logger.info("[state-skill3] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[state-skill3] " + msg); } catch (e) { /* ignore */ }
}

// 把表达式切成 token：数字 / 运算符 / 括号 / 变量引用，非法字符直接抛错（外层转 ok:false）。
function tokenize(expr) {
  var text = toText(expr);
  var tokens = [];
  var i = 0;
  while (i < text.length) {
    var ch = text.charAt(i);
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { i++; continue; }
    if ("+-*/%()".indexOf(ch) >= 0) { tokens.push({ type: ch }); i++; continue; }
    if (ch === "$") {
      var start = i + 1;
      var end = start;
      while (end < text.length && /[A-Za-z0-9_.]/.test(text.charAt(end))) end++;
      if (end === start) throw new Error("bad variable / 变量名不合法");
      tokens.push({ type: "var", name: text.slice(start, end) });
      i = end;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      var numText = "";
      while (i < text.length && /[0-9.]/.test(text.charAt(i))) { numText += text.charAt(i); i++; }
      var value = parseFloat(numText);
      if (isNaN(value)) throw new Error("bad number / 数字不合法: " + numText);
      tokens.push({ type: "num", value: value });
      continue;
    }
    throw new Error("bad char / 非法字符: " + ch);
  }
  return tokens;
}

// 变量取值：从 vars 里按名字读，读不到按 0 处理。
function varValue(vars, name) {
  var found = null;
  try { found = vars ? vars[name] : undefined; } catch (e) { found = undefined; }
  var num = parseFloat(toText(found));
  return isNaN(num) ? 0 : num;
}

// 安全求值表达式（递归下降）：支持 + - * / % 与括号，出错返回 NaN。
function evalExpr(expr, vars) {
  var tokens = [];
  try { tokens = tokenize(expr); } catch (e) { return NaN; }
  var pos = 0;
  // 内部：读当前 token。
  function peek() { return pos < tokens.length ? tokens[pos] : null; }
  // 内部：取下一个 token。
  function next() { var t = peek(); pos++; return t; }
  // 内部：解析一元 +-。
  function parseUnary() {
    var t = peek();
    if (t && t.type === "-") { next(); return -parseUnary(); }
    if (t && t.type === "+") { next(); return parseUnary(); }
    return parsePrimary();
  }
  // 内部：解析数字 / 变量 / 括号。
  function parsePrimary() {
    var t = next();
    if (!t) return NaN;
    if (t.type === "num") return t.value;
    if (t.type === "var") return varValue(vars, t.name);
    if (t.type === "(") {
      var inner = parseAdd();
      var close = next();
      if (!close || close.type !== ")") return NaN;
      return inner;
    }
    return NaN;
  }
  // 内部：解析乘除取余。
  function parseMul() {
    var left = parseUnary();
    while (true) {
      var t = peek();
      if (!t || (t.type !== "*" && t.type !== "/" && t.type !== "%")) return left;
      next();
      var right = parseUnary();
      if (t.type === "*") left = left * right;
      else if (t.type === "/") left = right === 0 ? NaN : left / right;
      else left = right === 0 ? NaN : left % right;
    }
  }
  // 内部：解析加减。
  function parseAdd() {
    var left = parseMul();
    while (true) {
      var t = peek();
      if (!t || (t.type !== "+" && t.type !== "-")) return left;
      next();
      var right = parseMul();
      left = t.type === "+" ? left + right : left - right;
    }
  }
  var result = parseAdd();
  if (pos !== tokens.length) return NaN;
  return result;
}

// 数学 1：变量加（缺省当 0 处理），结果写回 vars。
async function varAdd(ctx, args) {
  var name = toText(args.name).trim();
  if (name.length === 0) return { ok: false, message: "name 不能为空 / name required" };
  var before = varValue(ctx.vars, name);
  var delta = toNum(args.value, 1);
  var after = before + delta;
  try { ctx.vars[name] = after; } catch (e) { return { ok: false, message: getErrText(e) }; }
  return { ok: true, name: name, value: after, message: name + " = " + after };
}

// 数学 2：变量乘（缺省乘 1）。
async function varMul(ctx, args) {
  var name = toText(args.name).trim();
  if (name.length === 0) return { ok: false, message: "name 不能为空 / name required" };
  var before = varValue(ctx.vars, name);
  var times = toNum(args.value, 1);
  var after = before * times;
  try { ctx.vars[name] = after; } catch (e) { return { ok: false, message: getErrText(e) }; }
  return { ok: true, name: name, value: after, message: name + " = " + after };
}

// 数学 3：表达式求值（$变量会被替换成当前值），结果写进 name。
async function calc(ctx, args) {
  var name = toText(args.name || args.to || "calc").trim();
  var expr = toText(args.expr || args.value).trim();
  if (expr.length === 0) return { ok: false, message: "expr 不能为空 / expr required" };
  var value = evalExpr(expr, ctx.vars);
  if (isNaN(value)) return { ok: false, message: "表达式不合法 / invalid expr: " + expr };
  try { ctx.vars[name] = value; } catch (e) { return { ok: false, message: getErrText(e) }; }
  return { ok: true, name: name, value: value, message: name + " = " + value };
}

// 数学 4：随机整数（含两端），结果写进 name。
async function randomInt(ctx, args) {
  var name = toText(args.name || "random").trim();
  var min = Math.round(toNum(args.min, 0));
  var max = Math.round(toNum(args.max, 100));
  if (max < min) { var tmp = min; min = max; max = tmp; }
  var value = min + Math.floor(Math.random() * (max - min + 1));
  try { ctx.vars[name] = value; } catch (e) { return { ok: false, message: getErrText(e) }; }
  return { ok: true, name: name, value: value, message: name + " = " + value };
}

// 数学 5：变量拷贝（from → to）。
async function varCopy(ctx, args) {
  var from = toText(args.from).trim();
  var to = toText(args.to || args.name).trim();
  if (from.length === 0 || to.length === 0) return { ok: false, message: "from / to 不能为空 / from and to required" };
  var value = null;
  try { value = ctx.vars[from]; } catch (e) { value = undefined; }
  try { ctx.vars[to] = value; } catch (e) { return { ok: false, message: getErrText(e) }; }
  return { ok: true, from: from, to: to, message: to + " = " + toText(value) };
}

// AI 1：问模型一句话，回答写进 saveTo（默认 aiReply）。
async function askAi(ctx, args) {
  var prompt = toText(args.prompt || args.text).trim();
  if (prompt.length === 0) return { ok: false, message: "prompt 不能为空 / prompt required" };
  if (!ai || typeof ai.ask !== "function") return { ok: false, message: "ai-client 不可用 / ai-client unavailable" };
  var sys = toText(args.system || "你是 Minecraft 机器人助手，回答尽量短。 / You are a Minecraft bot assistant, answer briefly.");
  var saveTo = toText(args.saveTo || args.name || "aiReply").trim();
  var reply = "";
  try {
    reply = toText(await ai.ask(sys, prompt, ctx.botId)).trim();
  } catch (err) {
    return { ok: false, message: getErrText(err) };
  }
  if (reply.length === 0) return { ok: false, message: "AI 无回复 / empty AI reply" };
  try { ctx.vars[saveTo] = reply; } catch (e) { /* 记不住也不影响返回 */ }
  logInfo("ask_ai 成功 / ok: " + saveTo);
  return { ok: true, reply: reply, message: "AI 回复已写入 " + saveTo };
}

// AI 2：让模型在给定选项里挑一个，结果写进 vars.choice。
async function aiDecide(ctx, args) {
  var prompt = toText(args.prompt || args.question).trim();
  var options = Array.isArray(args.options) ? args.options : [];
  if (prompt.length === 0) return { ok: false, message: "prompt 不能为空 / prompt required" };
  if (options.length === 0) return { ok: false, message: "options 不能为空 / options required" };
  if (!ai || typeof ai.ask !== "function") return { ok: false, message: "ai-client 不可用 / ai-client unavailable" };
  var names = [];
  for (var i = 0; i < options.length; i++) names.push(toText(options[i]));
  var sys = "只回答一个选项名，不要解释。 / Answer with exactly one option name, no explanation.";
  var question = prompt + "\n选项 / options: " + names.join(" | ");
  var reply = "";
  try {
    reply = toText(await ai.ask(sys, question, ctx.botId)).trim();
  } catch (err) {
    return { ok: false, message: getErrText(err) };
  }
  var chosen = "";
  var lowered = reply.toLowerCase();
  for (var k = 0; k < names.length; k++) {
    if (lowered.indexOf(names[k].toLowerCase()) >= 0) { chosen = names[k]; break; }
  }
  if (chosen.length === 0) chosen = names[0];
  try { ctx.vars.choice = chosen; } catch (e) { /* ignore */ }
  return { ok: true, choice: chosen, message: "AI 选择 / chose: " + chosen };
}

// 常量：本文件负责的动作名 → 实现（数学变量 + AI）。
var HANDLERS = {
  var_add: varAdd,
  var_mul: varMul,
  calc: calc,
  random_int: randomInt,
  var_copy: varCopy,
  ask_ai: askAi,
  ai_decide: aiDecide
};

// 常量：本文件支持的动作名列表。
var NAMES = [];
try { NAMES = Object.keys(HANDLERS); } catch (e) { NAMES = []; }

// 判断本文件是否支持某个动作名。
function has(name) {
  try { return Object.prototype.hasOwnProperty.call(HANDLERS, toText(name)); } catch (e) { return false; }
}

// 取某个动作的实现，没有返回 null（调用方必须判空）。
function pick(name) {
  try {
    var key = toText(name);
    return Object.prototype.hasOwnProperty.call(HANDLERS, key) ? HANDLERS[key] : null;
  } catch (e) { return null; }
}

// 对外导出：动作表 + 名单 + 查询函数 + 表达式求值（自测直接调）。
module.exports = {
  HANDLERS: HANDLERS,
  NAMES: NAMES,
  has: has,
  pick: pick,
  evalExpr: evalExpr
};

