// ========================================
// 文件：modules/ai-tools-runner.js
// 功能：FC 工具执行器——执行前强校验参数，执行后识别空结果并静默（跳过 AI 二次回复），
//       同时提供批量执行与是否静默的纯判定，供聊天链路接线。
// 依赖：./ai-tools（可选）、./ai-tools-schema（可选）、./logger（可选）
// 导出：isSilent / shouldSkipAiReply / validate / run / batch / stats / reset
// 作者：MineBots
// ========================================
// 说明：null / undefined / 0 / 空字符串 四类空结果一律视为「无需解释」，
//   系统直接跳过 AI 的第二次调用，不再生成「好的，已完成」这类废话。
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

// 可选依赖：工具执行入口。
var tools = null;
try { tools = require("./ai-tools"); } catch (e) { tools = null; }
// 可选依赖：纯英文 schema 与强校验器。
var schema = null;
try { schema = require("./ai-tools-schema"); } catch (e) { schema = null; }
// 可选依赖：日志（只写文件）。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
// 运行时统计。
var totals = { runs: 0, validations: 0, rejected: 0, silent: 0, spoken: 0, batches: 0 };

// 写普通日志：只落文件，不推 GUI。
function logInfo(text) {
  try { if (logger && typeof logger.info === "function") logger.info(text); } catch (e) { /* ignore */ }
}
// 取错误文本，catch 里绝不再次抛错。
function errText(err) {
  try { if (!err) return "unknown error"; if (err.message) return String(err.message); return String(err); } catch (e) { return "unknown error"; }
}
// 功能：判定工具结果是否为空（null / undefined / 0 / 空字符串）；空白串也按空处理。
function isSilent(result) {
  try {
    if (result === null || result === undefined) return true;
    if (typeof result === "number" && result === 0) return true;
    if (typeof result === "string" && result.trim().length === 0) return true;
    return false;
  } catch (e) { return false; }
}
// 功能：空结果是否应跳过 AI 二次回复；与 isSilent 同源，语义更直白。
function shouldSkipAiReply(result) { return isSilent(result); }
// 功能：只做参数强校验，返回校验结果；校验器缺失时放行。
function validate(name, args) {
  try {
    totals.validations = totals.validations + 1;
    if (!schema || typeof schema.validateToolArgs !== "function") {
      return { ok: true, skipped: true, message: "validator unavailable / 校验器不可用" };
    }
    return schema.validateToolArgs(name, args);
  } catch (e) { return { ok: true, skipped: true, message: errText(e) }; }
}
// 功能：校验 + 执行一个工具，返回 { ok, silent, skipReply, text, validation }，绝不抛错。
function run(bot, name, args, options) {
  var out = { ok: true, silent: false, skipReply: false, text: "", validation: null, message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    totals.runs = totals.runs + 1;
    if (opts.validate !== false) {
      var v = validate(name, args);
      out.validation = v;
      if (v && v.ok === false && v.known !== false) {
        totals.rejected = totals.rejected + 1;
        out.ok = false;
        out.text = "执行失败 / failed: " + (v.errors || []).join("; ");
        out.message = "arguments rejected / 参数被拦截，未进入执行层";
        return out;
      }
    }
    if (!tools || typeof tools.executeTool !== "function") {
      out.ok = false;
      out.text = "执行失败 / failed: tools unavailable";
      return out;
    }
    var result = tools.executeTool(bot, name, args);
    if (result && typeof result.then === "function") {
      return result.then(function (text) { return finish(out, text); }, function (err) { return finish(out, "执行失败 / failed: " + errText(err)); });
    }
    return finish(out, result);
  } catch (e) {
    out.ok = false; out.text = "执行失败 / failed: " + errText(e);
    return out;
  }
}
// 内部：把执行结果收敛成最终返回结构，并记统计。
function finish(out, text) {
  try {
    out.silent = isSilent(text);
    out.text = text === null || text === undefined ? "" : String(text);
    out.skipReply = out.silent;
    if (out.silent) { totals.silent = totals.silent + 1; logInfo("[fc-runner] silent result / 空结果跳过二次回复"); }
    else totals.spoken = totals.spoken + 1;
  } catch (e) { out.ok = false; }
  return out;
}
// 功能：批量执行多个工具调用，返回 { ok, allSilent, results }；全部为空时整轮跳过二次回复。
function batch(bot, calls) {
  var out = { ok: true, allSilent: true, results: [] };
  try {
    var list = Array.isArray(calls) ? calls : [];
    totals.batches = totals.batches + 1;
    for (var i = 0; i < list.length; i++) {
      var c = list[i] || {};
      var r = run(bot, c.name, c.args, c.options || {});
      out.results.push(r);
    }
    return settleBatch(out);
  } catch (e) { out.ok = false; return out; }
}
// 内部：等待所有 Promise 结果并汇总 allSilent。
function settleBatch(out) {
  var pending = [];
  for (var i = 0; i < out.results.length; i++) if (out.results[i] && typeof out.results[i].then === "function") pending.push(i);
  if (pending.length === 0) {
    for (var j = 0; j < out.results.length; j++) if (!out.results[j].silent) out.allSilent = false;
    return out;
  }
  return Promise.all(pending.map(function (idx) { return out.results[idx]; })).then(function (vals) {
    for (var k = 0; k < vals.length; k++) out.results[pending[k]] = vals[k];
    for (var m = 0; m < out.results.length; m++) if (!out.results[m].silent) out.allSilent = false;
    return out;
  }, function () { out.ok = false; return out; });
}
// 功能：读统计快照。
function stats() {
  return { ok: true, runs: totals.runs, validations: totals.validations,
    rejected: totals.rejected, silent: totals.silent, spoken: totals.spoken, batches: totals.batches };
}
// 功能：复位统计（自测隔离用）。
function reset() {
  totals = { runs: 0, validations: 0, rejected: 0, silent: 0, spoken: 0, batches: 0 };
  return { ok: true, message: "fc runner reset / 工具执行器已复位" };
}
// 对外导出。
module.exports = {
  isSilent: isSilent, shouldSkipAiReply: shouldSkipAiReply, validate: validate,
  run: run, batch: batch, stats: stats, reset: reset
};
