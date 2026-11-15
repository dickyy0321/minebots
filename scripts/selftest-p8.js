// ========================================
// 文件：scripts/selftest-p8.js
// 功能：P8 回归自测——五级 JSON 修复引擎 / 极端脏文本 / AI 大脑与状态机接线 / 兜底触发 1 次 AI 重试
// 依赖：path、fs；../modules/json-repair、../modules/ai-json-guard、../modules/ai-client、
//       ../modules/ai-tools、../modules/ai-tools-state、../modules/replan、../modules/state-machine（都可选）
// 导出：run（由 scripts/selftest-p5.js 调用，复用它的 section / expect / 假机器人工厂）
// 作者：MineBots
// ========================================
// 说明 / note：全程不联网；AI 重试用 require.cache 注入假 axios / 假 ai-config，用完立即还原。
var path = require("path");
var fs = require("fs");
var ROOT = path.join(__dirname, "..");

// 按相对路径安全 require 一个模块；缺失或抛错时返回 null（不拖垮整轮自检）。
function load(rel) {
  try { return require(path.join(ROOT, rel)); } catch (e) { return null; }
}

// 读一个项目文件的文本；读不到返回空串。
function readRel(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch (e) { return ""; }
}

// 任务 3 的五条指定断言 + 五级命中覆盖 + 绝不抛异常。
function checkRepair(h) {
  h.section("18a. 五级 JSON 修复引擎 / json-repair");
  var jr = load("modules/json-repair.js");
  if (!jr) { h.expect("json-repair 可加载", false, "require 失败"); return; }
  h.expect("json-repair 可加载且导出 safeParse", typeof jr.safeParse === "function", "");
  jr.resetStats();

  // 1. 纯 JSON 文本能正常解析。
  var pure = jr.safeParse("{\"a\":1,\"b\":[2,3]}", null);
  h.expect("纯 JSON 文本能正常解析", !!pure && pure.a === 1 && pure.b.length === 2 && jr.safeParseDetailed("{\"a\":1}", null).level === 1, JSON.stringify(pure));

  // 2. 带 ```json ... ``` Markdown 标记的能解析。
  var md = jr.safeParse("```json\n{\"a\":1}\n```", null);
  h.expect("带 ```json 围栏的能解析", !!md && md.a === 1 && jr.safeParseDetailed("```json\n{\"a\":1}\n```", null).level === 2, JSON.stringify(md));

  // 3. 前后有废话（“好的，这是代码：{...}”）能解析。
  var prose = jr.safeParse("好的，这是代码：{\"a\":1} 谢谢 / thanks", null);
  h.expect("前后有废话时能解析出中间 JSON", !!prose && prose.a === 1, JSON.stringify(prose));

  // 4. 尾随逗号 {"a":1,} 能解析（jsonrepair 库未安装时由四级内置等价修复接住）。
  var trailing = jr.safeParse("{\"a\":1,}", null);
  h.expect("尾随逗号能解析（四级修复）", !!trailing && trailing.a === 1 && jr.safeParseDetailed("{\"a\":1,}", null).level === 4, JSON.stringify(trailing));

  // 5. 彻底乱码 "abc" 返回 fallback 且不抛错。
  var threw = false, fb = null;
  try { fb = jr.safeParse("abc", { ok: false, tag: "FB" }); } catch (e) { threw = true; }
  h.expect("彻底乱码返回 fallback 且绝不抛错", threw === false && !!fb && fb.tag === "FB" && jr.safeParse("abc", 7) === 7, JSON.stringify(fb));

  // 五级链路逐级可达：三级括号提取 / 五级暴力清洗各造一个专属脏样本。
  var lv3 = jr.safeParseDetailed("说明 { 这里有个括号 } 好的：{\"a\":1}", null);
  var lv5 = jr.safeParseDetailed("｛＂a＂：１，＂b＂：\"x\ny\"｝", null);
  h.expect("三级括号提取命中（杂散括号 + 真 JSON）", lv3.ok === true && lv3.level === 3 && lv3.value.a === 1, JSON.stringify(lv3.level));
  h.expect("五级暴力清洗命中（全角标点 + 裸换行）", lv5.ok === true && lv5.level === 5 && lv5.value.a === 1 && lv5.value.b.indexOf("x") === 0, JSON.stringify(lv5.level));
  var whole = jr.safeParse("{\"name\":\"p8\",\"nodes\":[{\"id\":\"a\",\"action\":\"wait\"},],}", null);
  h.expect("外层脏 + 内层合法时优先救外层，不误返回子对象", !!whole && !!whole.name && Array.isArray(whole.nodes) && whole.nodes.length === 1, JSON.stringify(whole));
  h.expect("五级全部命中过（统计覆盖 1..5）", (function () {
    var s = jr.getStats();
    return s.byLevel[1] > 0 && s.byLevel[2] > 0 && s.byLevel[3] > 0 && s.byLevel[4] > 0 && s.byLevel[5] > 0;
  })(), JSON.stringify(jr.getStats()));

  // 极端输入绝不抛异常：null / undefined / 数字 / 对象 / 残缺括号 / 空串。
  var weird = [null, undefined, 0, "", "{oops", "{这不是 JSON", "[1,2,", {"a": 1}];
  var safe = true;
  for (var i = 0; i < weird.length; i++) {
    try { jr.safeParse(weird[i], "FB"); } catch (e) { safe = false; }
  }
  h.expect("8 种极端输入全部不抛异常", safe, "");
  h.expect("统计记录了兜底次数与 jsonrepair 状态", jr.getStats().fallbacks >= 2 && typeof jr.getStats().hasJsonrepair === "boolean", JSON.stringify(jr.getStats()));
}

// ai-json-guard：tool_calls.arguments 强制清洗 + 兜底触发最多 1 次重试（纯内存，不联网）。
async function checkGuard(h) {
  h.section("18b. JSON 加固门面 / ai-json-guard");
  var guard = load("modules/ai-json-guard.js");
  if (!guard) { h.expect("ai-json-guard 可加载", false, "require 失败"); return; }
  guard.resetStats();

  var dirty = { message: { tool_calls: [{ id: "c1", function: { name: "dig_block", arguments: "```json\n{\"x\":0,\"y\":63,}\n```" } }] } };
  var pass = guard.hardenPass(dirty);
  h.expect("脏参数（围栏 + 尾随逗号）被修成纯 JSON", pass.bad === 0 && pass.repaired === 1 && dirty.message.tool_calls[0].function.arguments === "{\"x\":0,\"y\":63}", JSON.stringify(pass));
  h.expect("坏参数经 cleanArguments 兜底成空对象", JSON.stringify(guard.cleanArguments("{oops")) === "{}", "");

  var badChoice = { message: { tool_calls: [{ id: "c2", function: { name: "explore", arguments: "{oops" } }] } };
  var hints = [], rounds = 0;
  var fixed = await guard.harden(badChoice, function (hint) {
    rounds++; hints.push(hint);
    return { message: { tool_calls: [{ id: "c2", function: { name: "explore", arguments: "{\"seconds\":5}" } }] } };
  });
  h.expect("兜底值触发恰好 1 次 AI 重试", rounds === 1 && guard.stats().retries === 1, JSON.stringify({ rounds: rounds, stats: guard.stats() }));
  h.expect("重试提示要求严格输出纯 JSON（中英双语）", hints.length === 1 && hints[0].indexOf("严格输出纯 JSON 格式") > 0 && hints[0].indexOf("strict pure JSON") > 0, String(hints[0]));
  h.expect("重试成功后返回修好的 choice", fixed.message.tool_calls[0].function.arguments === "{\"seconds\":5}" && guard.stats().retriesOk === 1, JSON.stringify(fixed));

  var clean = { message: { tool_calls: [{ id: "c3", function: { name: "stop", arguments: "{}" } }] } };
  var noRetry = 0;
  await guard.harden(clean, function () { noRetry++; return clean; });
  h.expect("参数本来就合法时不重试", noRetry === 0, String(noRetry));

  var stillBad = { message: { tool_calls: [{ id: "c4", function: { name: "explore", arguments: "abc" } }] } };
  var second = await guard.harden(stillBad, function () { return { message: { tool_calls: [{ id: "c4", function: { name: "explore", arguments: "abc" } }] } }; });
  h.expect("重试仍失败时兜底空对象且不抛错", second.message.tool_calls[0].function.arguments === "{}", JSON.stringify(second));
}

// 真实 ai-client.askWithTools 链路：假 axios / 假 ai-config，坏 JSON 自动重试一次，全程不联网。
async function checkClientRetry(h) {
  h.section("18c. AI 大脑接线 / askWithTools 一次重试");
  var aiFile = require.resolve(path.join(ROOT, "modules/ai-client.js"));
  var cfgFile = require.resolve(path.join(ROOT, "modules/ai-config.js"));
  var axiosFile = null;
  try { axiosFile = require.resolve("axios", { paths: [ROOT] }); } catch (e) { axiosFile = null; }
  var guard = load("modules/ai-json-guard.js");
  if (guard) guard.resetStats();
  if (!axiosFile) { h.expect("axios 可解析（跳过注入）", false, "axios 未安装"); return; }
  var savedAi = require.cache[aiFile], savedCfg = require.cache[cfgFile], savedAxios = require.cache[axiosFile];
  var prompts = [], mode = { bad: true };
  var cfg = { baseUrl: "http://127.0.0.1:1/v1", apiKey: "", model: "local-model", engine: "ollama",
    temperature: 0.7, topP: 0.9, maxTokens: 64, timeout: 1000, retries: 0, systemPromptAppend: "" };
  var choice = null;
  try {
    require.cache[cfgFile] = { id: cfgFile, filename: cfgFile, loaded: true, children: [], paths: [],
      exports: { load: function () { return cfg; } } };
    require.cache[axiosFile] = { id: axiosFile, filename: axiosFile, loaded: true, children: [], paths: [],
      exports: {
        post: function (url, body) {
          prompts.push(body.messages[1].content);
          var args = (mode.bad && prompts.length === 1) ? "{oops" : "{\"x\":0,\"y\":63,\"z\":0}";
          return Promise.resolve({ data: { choices: [{ message: { role: "assistant", content: "",
            tool_calls: [{ id: "call-1", type: "function", function: { name: "dig_block", arguments: args } }] } }] } });
        },
        get: function () { return Promise.resolve({ data: {} }); }
      } };
    delete require.cache[aiFile];
    var ai = require(aiFile);
    var tools = [{ type: "function", function: { name: "dig_block", parameters: { type: "object" } } }];
    choice = await ai.askWithTools("sys", "挖石头", tools, null, "p8-bot");
  } catch (e) {
    h.expect("askWithTools 假链路未抛错", false, String(e));
  } finally {
    if (savedAi) require.cache[aiFile] = savedAi; else delete require.cache[aiFile];
    if (savedCfg) require.cache[cfgFile] = savedCfg; else delete require.cache[cfgFile];
    if (savedAxios) require.cache[axiosFile] = savedAxios; else delete require.cache[axiosFile];
  }
  h.expect("坏 JSON 在真实 askWithTools 链路里触发恰好 2 次请求", prompts.length === 2, JSON.stringify(prompts.length));
  h.expect("第二次请求带上纯 JSON 纠错提示", prompts.length === 2 && prompts[1].indexOf("严格输出纯 JSON 格式") > 0, String(prompts.length > 1 ? prompts[1] : ""));
  h.expect("返回的 choice 参数已是纯 JSON 字符串", !!choice && choice.message.tool_calls[0].function.arguments === "{\"x\":0,\"y\":63,\"z\":0}", JSON.stringify(choice));
  h.expect("加固统计记录重试且成功", !!guard && guard.stats().retries === 1 && guard.stats().retriesOk === 1, JSON.stringify(guard ? guard.stats() : null));
}

// 下游接入点：ai-tools / ai-tools-state / replan / state-machine / 静态接线一致性。
async function checkWiring(h) {
  h.section("18d. 下游接入点 / tool_calls + 状态 JSON");
  var tools = load("modules/ai-tools.js");
  if (tools && h.makeBot && h.makeBlock) {
    var bot = h.makeBot({ blocks: [h.makeBlock("stone", 0, 63, 0)] });
    var text = await tools.executeTool(bot, "dig_block", "```json\n{\"x\":0,\"y\":63,\"z\":0,}\n```");
    h.expect("ai-tools 参数强制走五级解析（脏参数也能挖到方块）", bot.records.dig.join(",") === "stone" && text.indexOf("成功") === 0, text);
    var bad = await tools.executeTool(bot, "dig_block", "{这不是 JSON");
    h.expect("ai-tools 彻底乱码仍老实失败不抛错", bad.indexOf("执行失败") === 0, bad);
  } else { h.expect("ai-tools 可加载", false, "模块或假 bot 缺失"); }

  var stateTools = load("modules/ai-tools-state.js");
  if (stateTools) {
    var rejected = await stateTools.executeTool(h.makeBot({}), "p8", "run_state_machine", "{oops");
    h.expect("ai-tools-state 彻底乱码仍被拒且提示 JSON", rejected.indexOf("执行失败") === 0 && /JSON/.test(rejected), rejected);
  } else { h.expect("ai-tools-state 可加载", false, "require 失败"); }

  var rp = load("modules/replan.js");
  if (rp) {
    var checked = rp.validateCalls({ message: { tool_calls: [{ function: { name: "explore", arguments: "{\"seconds\":5,}" } }] } });
    h.expect("replan 的 tool_calls 参数也走五级解析（尾随逗号可用）", checked.ok === true && checked.calls.length === 1 && checked.calls[0].args.seconds === 5, JSON.stringify(checked));
    h.expect("replan 彻底乱码仍判非法", rp.validateCalls({ message: { tool_calls: [{ function: { name: "explore", arguments: "{oops" } }] } }).ok === false, "bad json");
  } else { h.expect("replan 可加载", false, "require 失败"); }

  // 状态机定义 JSON：造一个带尾随逗号的脏文件，loadMachine 应修复加载，随后立刻删掉。
  var sm = load("modules/state-machine.js");
  var dirtyFile = path.join(ROOT, "state", "statemachines", "p8-dirty-machine.json");
  var loaded = null;
  try {
    var dir = path.dirname(dirtyFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dirtyFile, "{\"name\":\"p8\",\"start\":\"a\",\"nodes\":[{\"id\":\"a\",\"action\":\"wait\",\"args\":{\"ms\":1},\"next\":null},],}", "utf8");
    if (sm) loaded = sm.loadMachine("p8-dirty-machine");
  } catch (e) { loaded = null; }
  try { if (fs.existsSync(dirtyFile)) fs.unlinkSync(dirtyFile); } catch (e2) { /* 清理失败不影响断言 */ }
  h.expect("state-machine 状态 JSON 走五级解析（脏文件能救回）", !!sm && !!loaded && loaded.ok === true && sm.validate(loaded.definition).ok === true, JSON.stringify(loaded));

  var clientText = readRel("modules/ai-client.js"), chatText = readRel("modules/chat-handler.js");
  var stateText = readRel("modules/state-machine.js"), toolsText = readRel("modules/ai-tools.js");
  h.expect("接线点齐全：ai-client / chat-handler / ai-tools / state-machine",
    clientText.indexOf("jsonGuard.harden") > 0 && chatText.indexOf("jsonGuard.cleanArguments") > 0 &&
    toolsText.indexOf("jsonRepair.safeParse") > 0 && stateText.indexOf("safeStateJson") > 0, "wiring");
  h.expect("接线点齐全：replan / ai-tools-state / ai-tools-telemetry",
    readRel("modules/replan.js").indexOf("safeJsonArgs") > 0 &&
    readRel("modules/ai-tools-state.js").indexOf("jsonRepair.safeParse") > 0 &&
    readRel("modules/ai-tools-telemetry.js").indexOf("jsonRepair.safeParse") > 0, "wiring");
}

// 主入口：四组用例，任何一组抛错都记一条失败断言，不拖垮整轮自检。
async function run(h) {
  try { checkRepair(h); } catch (e1) { h.expect("18a 未抛错", false, String(e1)); }
  try { await checkGuard(h); } catch (e2) { h.expect("18b 未抛错", false, String(e2)); }
  try { await checkClientRetry(h); } catch (e3) { h.expect("18c 未抛错", false, String(e3)); }
  try { await checkWiring(h); } catch (e4) { h.expect("18d 未抛错", false, String(e4)); }
}

module.exports = { run: run };
