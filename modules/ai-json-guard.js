// ========================================
// 文件：modules/ai-json-guard.js
// 功能：AI JSON 加固门面——tool_calls.arguments 全部强制走五级解析，解析出兜底值时最多触发 1 次 AI 重试，
//       把坏参数回写成纯 JSON 或空对象，绝不把异常抛到上层。
// 依赖：./json-repair（可选）、./logger（可选）
// 导出：harden / hardenPass / stats / resetStats / REPAIR_HINT
// 作者：MineBots
// ========================================
// 说明 / note：ai-client.askWithTools 拿到 choice 后调 harden；重试提示词拼在 userPrompt 尾部，
//   不改 system、不重复指数退避，最多只额外发一次请求。ES5 风格，CommonJS，无中文变量名。

// 可选依赖：五级 JSON 修复引擎；缺失时退回原生 JSON.parse，功能降级但绝不崩。
var jsonRepair = null;
try { jsonRepair = require("./json-repair"); } catch (e) { jsonRepair = null; }

// 可选依赖：日志核心；缺失时 warn 退回 console。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：JSON 格式有误时追加给 AI 的提示（中英双语，要求纯 JSON）。
var REPAIR_HINT = "\n\n[系统提示 / system] 你的 JSON 格式有误，请严格输出纯 JSON 格式 / " +
  "Your JSON was invalid. Reply with strict pure JSON only: no Markdown fences, no trailing commas, no comments.";

// 常量：内部哨兵，用来区分「解析失败兜底」和「真的解析出了一个对象」。
var FAILED = { __mbJsonGuardFailed: true };

// 状态：加固次数 / 修复条数 / 重试次数 / 重试成功次数 / 兜底条数。
var counters = { calls: 0, repaired: 0, retries: 0, retriesOk: 0, fallbacks: 0 };

// 安全取错误文本：catch 里再抛错就破红线了，失败返回固定串。
function errText(err) {
  try { if (err && err.message) return String(err.message); return String(err); }
  catch (e) { return "unknown error / 未知错误"; }
}

// 写一条 warn 双语日志：JSON 坏掉或重试失败时调用，绝不抛错。
function logWarn(message) {
  try {
    if (logger && typeof logger.warn === "function") { logger.warn("[ai-json-guard] " + message); return; }
  } catch (e) { /* 落到 console */ }
  try { console.warn("[warn] [ai-json-guard] " + message); } catch (e2) { /* ignore */ }
}

// 强制走五级解析；解析失败返回 { ok:false }，绝不抛异常。
function parseDetail(text) {
  if (jsonRepair && typeof jsonRepair.safeParseDetailed === "function") {
    return jsonRepair.safeParseDetailed(text, FAILED);
  }
  try { return { ok: true, value: JSON.parse(text), level: 1, usedFallback: false }; }
  catch (e) { return { ok: false, value: FAILED, level: 0, usedFallback: true }; }
}

// 清洗单条 arguments：返回 { ok, args, repaired }；坏参数一律回 "{}"，绝不抛异常。
function cleanOne(raw) {
  try {
    if (raw === null || raw === undefined || raw === "") return { ok: true, args: "{}", repaired: false };
    if (typeof raw === "object" && !Array.isArray(raw)) {
      return { ok: true, args: JSON.stringify(raw), repaired: false };
    }
    if (typeof raw !== "string") return { ok: false, args: "{}", repaired: false };
    var d = parseDetail(raw);
    if (!d.ok || d.usedFallback || d.value === FAILED) return { ok: false, args: "{}", repaired: false };
    if (!d.value || typeof d.value !== "object" || Array.isArray(d.value)) return { ok: false, args: "{}", repaired: false };
    return { ok: true, args: JSON.stringify(d.value), repaired: d.level > 1 };
  } catch (e) { return { ok: false, args: "{}", repaired: false }; }
}

// 对外便捷接口：把单条 arguments 洗成纯对象，坏数据兜底成空对象，绝不抛错。
function cleanArguments(raw) {
  try { return JSON.parse(cleanOne(raw).args); } catch (e) { return {}; }
}

// 取出 choice 里的 tool_calls 数组；结构不符返回空数组，绝不抛异常。
function callsOf(choice) {
  try {
    var msg = choice ? choice.message : null;
    if (msg && Array.isArray(msg.tool_calls)) return msg.tool_calls;
    if (choice && Array.isArray(choice.tool_calls)) return choice.tool_calls;
  } catch (e) { return []; }
  return [];
}

// 就地加固一轮：每条 arguments 强制过五级解析并回写纯 JSON；返回坏参数与修复条数。
function hardenPass(choice) {
  var out = { choice: choice, bad: 0, repaired: 0 };
  try {
    var list = callsOf(choice);
    for (var i = 0; i < list.length; i++) {
      var call = list[i];
      if (!call || typeof call !== "object" || !call.function) continue;
      var one = cleanOne(call.function.arguments);
      call.function.arguments = one.args;
      if (!one.ok) out.bad++;
      if (one.repaired) out.repaired++;
    }
  } catch (e) { logWarn("加固一轮失败 / harden pass failed: " + errText(e)); }
  return out;
}

// 对外主接口：坏 JSON 触发最多 1 次重试；重试也失败就保留已兜底的 choice，绝不抛异常。
async function harden(choice, retryFn) {
  try {
    counters.calls++;
    var first = hardenPass(choice);
    counters.repaired += first.repaired;
    counters.fallbacks += first.bad;
    if (first.bad === 0) return first.choice;
    logWarn("检测到 " + first.bad + " 条非法 JSON 参数，触发 1 次 AI 重试 / invalid tool arguments, retrying once");
    if (typeof retryFn !== "function") return first.choice;
    counters.retries++;
    var second = null;
    try { second = await retryFn(REPAIR_HINT); }
    catch (e) { logWarn("AI 重试失败 / retry failed: " + errText(e)); }
    if (!second) return first.choice;
    var again = hardenPass(second);
    counters.repaired += again.repaired;
    counters.fallbacks += again.bad;
    if (again.bad === 0) { counters.retriesOk++; return again.choice; }
    logWarn("重试后仍有 " + again.bad + " 条非法参数，已兜底为空对象 / still invalid, fallback to empty object");
    return again.choice;
  } catch (e) {
    logWarn("加固异常，原样返回 / guard error, returning raw choice: " + errText(e));
    return choice;
  }
}

// 返回加固统计快照（拷贝），供自测与排障；失败返回空统计。
function stats() {
  try {
    return { calls: counters.calls, repaired: counters.repaired, retries: counters.retries,
      retriesOk: counters.retriesOk, fallbacks: counters.fallbacks };
  } catch (e) { return { calls: 0, repaired: 0, retries: 0, retriesOk: 0, fallbacks: 0 }; }
}

// 清零加固统计，失败只忽略，绝不抛错。
function resetStats() {
  try { counters.calls = 0; counters.repaired = 0; counters.retries = 0; counters.retriesOk = 0; counters.fallbacks = 0; }
  catch (e) { /* ignore */ }
}

module.exports = {
  harden: harden,
  hardenPass: hardenPass,
  cleanArguments: cleanArguments,
  stats: stats,
  resetStats: resetStats,
  REPAIR_HINT: REPAIR_HINT
};
