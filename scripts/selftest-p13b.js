// ========================================
// 文件：scripts/selftest-p13b.js
// 功能：P13 模块2 回归自测——纯英文 Function Calling schema / validateToolArgs 强校验 /
//       空结果静默跳过二次回复 / search_tools 按需检索与 slim 降 Token
// 依赖：path、fs；被测模块（都可选，缺了记失败而不崩）
// 导出：run（由 selftest-p5.js 调用）
// 作者：MineBots
// ========================================
// 说明：全程离线；需要 mock 工具返回值时只替换内存中的函数引用，收尾一定还原。
var path = require("path");
var fs = require("fs");
var ROOT = path.join(__dirname, "..");

// 安全 require：缺失或抛错返回 null。
function load(rel) {
  try { return require(path.join(ROOT, rel)); } catch (e) { return null; }
}
// 读项目文件文本；读不到返回空串。
function readRel(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch (e) { return ""; }
}
// 假 bot：只记录 dig 调用，足够验证「校验不通过绝不进入执行层」。
function makeBot() {
  return {
    records: { dig: [], chat: [] },
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: { items: function () { return []; } },
    dig: function (b) { this.records.dig.push(b && b.name ? b.name : "?"); return Promise.resolve(); },
    blockAt: function () { return { name: "stone", position: { x: 0, y: 63, z: 0 } }; },
    chat: function (t) { this.records.chat.push(t); }
  };
}
// 25a：静态红线与接线。
function checkStatic(h) {
  h.section("25a. 模块2 静态红线与接线 / static and wiring");
  var files = ["modules/ai-tools-schema.js", "modules/ai-tools-runner.js"];
  var banned = [/\?\./, /\?\?/, /^import\s+/m, /^export\s+/m];
  var ok = true;
  for (var i = 0; i < files.length; i++) {
    var text = readRel(files[i]);
    if (text.length === 0 || text.indexOf("// ====") !== 0 || text.split("\n").length > 600) ok = false;
    for (var j = 0; j < banned.length; j++) if (banned[j].test(text)) ok = false;
  }
  h.expect("两个新模块满足头注释 / 600 行 / 禁用语法", ok, "");
  var src = readRel("modules/ai-tools.js");
  var chat = readRel("modules/chat-handler.js");
  h.expect("ai-tools 已委托纯英文精简 schema", src.indexOf("ai-tools-schema") > 0 && src.indexOf("目标 X 坐标") < 0, "");
  h.expect("ai-tools 执行前接了参数强校验", src.indexOf("validateToolArgs(name, normalizeArgs(args))") > 0, "");
  h.expect("ai-tools 结果层支持空值静默", src.indexOf('res === 0 || res === ""') > 0, "");
  h.expect("聊天链路逐项判空并在全空时跳过二次回复",
    chat.indexOf("isSilent(result)") > 0 && chat.indexOf('if (allSilent) return ""') > 0, "");
}
// 25b：纯英文 schema 与默认菜单兼容。
function checkEnglish(h) {
  h.section("25b. 纯英文工具菜单 / english-only schema");
  var tools = load("modules/ai-tools.js");
  var schema = load("modules/ai-tools-schema.js");
  if (!tools || !schema) { h.expect("工具与 schema 模块可加载", false, "null"); return; }
  var menu = tools.getTools();
  h.expect("默认菜单仍是 14 个（既有权限与断言不破）", menu.length === 14 && tools.TOOL_NAMES.length === 14, String(menu.length));
  var zh = /[\u4e00-\u9fa5]/;
  var clean = true;
  for (var i = 0; i < menu.length; i++) {
    var f = menu[i].function;
    if (zh.test(f.name) || zh.test(f.description)) clean = false;
    var props = f.parameters.properties || {};
    for (var k in props) {
      if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
      if (props[k].description && zh.test(props[k].description)) clean = false;
    }
  }
  h.expect("工具名 / 描述 / 参数描述全部纯英文，无中文", clean && schema.stats().englishOnly === true, "");
  h.expect("参数描述已精简掉（降 Token）",
    menu[0].function.parameters.properties.x.description === undefined, JSON.stringify(menu[0].function.parameters));
  h.expect("描述是短句而非长篇双语", menu[0].function.description.length < 60, menu[0].function.description);
  h.expect("名字与 required 与历史菜单逐字一致",
    menu[0].function.name === "move_to" && menu[0].function.parameters.required.join(",") === "x,y,z" &&
    menu[7].function.name === "attack" && menu[7].function.parameters.required[0] === "target", "");
  h.expect("getTools 给的仍是副本", tools.getTools() !== tools.getTools() && tools.getTools().length === 14, "");
}
// 25c：validateToolArgs 强校验。
function checkValidate(h) {
  h.section("25c. 参数强校验 / validateToolArgs");
  var schema = load("modules/ai-tools-schema.js");
  if (!schema) { h.expect("schema 可加载", false, "null"); return; }
  var missing = schema.validateToolArgs("dig_block", { x: 0, y: 63 });
  h.expect("缺必填 z 直接拦截", missing.ok === false && missing.errors.join(" ").indexOf("z") >= 0, JSON.stringify(missing.errors));
  var wrong = schema.validateToolArgs("dig_block", { x: "abc", y: 63, z: 0 });
  h.expect("类型不对直接拦截且带双语原因",
    wrong.ok === false && wrong.errors.join(" ").indexOf("wrong type") >= 0 && wrong.errors.join(" ").indexOf("类型") >= 0,
    JSON.stringify(wrong.errors));
  var good = schema.validateToolArgs("dig_block", { x: 0, y: 63, z: 0 });
  h.expect("合法参数放行且值保留", good.ok === true && good.known === true && good.normalized.y === 63, JSON.stringify(good));
  var coerced = schema.validateToolArgs("dig_tree", { blocks: "12", wood: "oak" });
  h.expect("数字字符串收敛成整数", coerced.ok === true && coerced.normalized.blocks === 12, JSON.stringify(coerced.normalized));
  var arr = schema.validateToolArgs("mine", { ores: "iron,gold" });
  h.expect("逗号串收敛成数组", arr.ok === true && Array.isArray(arr.normalized.ores) && arr.normalized.ores.length === 2, JSON.stringify(arr.normalized));
  h.expect("functions. 前缀归一化", schema.validateToolArgs("functions.craft", { item: "stick" }).ok === true, "");
  var unknown = schema.validateToolArgs("self_destruct", {});
  h.expect("未知工具被标为 unknown，不误放行到执行层", unknown.ok === false && unknown.known === false, JSON.stringify(unknown));
  h.expect("无参数工具 stop 直接放行", schema.validateToolArgs("stop", {}).ok === true, "");
  h.expect("ai-tools 门面也暴露同一个校验器", typeof load("modules/ai-tools.js").validateToolArgs === "function" &&
    load("modules/ai-tools.js").validateToolArgs("dig_block", {}).ok === false, "");
}
// 25d：执行层强校验接线（脏参数不进入 handler）。
async function checkExecute(h) {
  h.section("25d. 执行层拦截 / executeTool gating");
  var tools = load("modules/ai-tools.js");
  if (!tools) { h.expect("ai-tools 可加载", false, "null"); return; }
  var bot = makeBot();
  var rejected = await tools.executeTool(bot, "dig_block", { x: 0, y: 63 });
  h.expect("缺参数时 executeTool 返回执行失败且未挖方块",
    rejected.indexOf("执行失败") === 0 && rejected.indexOf("缺少必填参数") > 0 && bot.records.dig.length === 0, rejected);
  var badJson = await tools.executeTool(bot, "dig_block", "{这不是 JSON");
  h.expect("坏参数老实失败不抛错（P8 兼容）", badJson.indexOf("执行失败") === 0, badJson);
  var noBot = await tools.executeTool(null, "stop", {});
  h.expect("无必填参数的工具仍走原有 bot 判空", noBot.indexOf("执行失败") === 0 && noBot.indexOf("机器人未就绪") > 0, noBot);
  var unknownTool = await tools.executeTool(bot, "self_destruct", {});
  h.expect("未知工具仍由原有逻辑拒绝", unknownTool.indexOf("执行失败") === 0 && unknownTool.indexOf("未知工具") > 0, unknownTool);
}
// 25e：静默执行——空结果跳过二次回复。
async function checkSilent(h) {
  h.section("25e. 静默执行 / silent tool result");
  var runner = load("modules/ai-tools-runner.js");
  var tools = load("modules/ai-tools.js");
  if (!runner || !tools) { h.expect("runner 与 tools 可加载", false, "null"); return; }
  runner.reset();
  h.expect("null / undefined / 0 / 空串 / 空白串都判空",
    runner.isSilent(null) === true && runner.isSilent(undefined) === true &&
    runner.isSilent(0) === true && runner.isSilent("") === true && runner.isSilent("   ") === true, "");
  h.expect("有内容的文本与对象不判空", runner.isSilent("成功 / ok") === false && runner.isSilent(false) === false, "");
  h.expect("shouldSkipAiReply 与 isSilent 同源", runner.shouldSkipAiReply("") === true && runner.shouldSkipAiReply("ok") === false, "");
  var original = tools.executeTool;
  try {
    tools.executeTool = function () { return ""; };
    var r = await runner.run(null, "stop", {});
    h.expect("工具返回空串时 run 标记 silent 且 skipReply",
      r.ok === true && r.silent === true && r.skipReply === true && r.text === "", JSON.stringify(r));
    tools.executeTool = function () { return 0; };
    var z = await runner.run(null, "stop", {});
    h.expect("工具返回 0 时同样静默", z.silent === true && z.skipReply === true, JSON.stringify(z));
    tools.executeTool = function () { return "成功 / ok: stop"; };
    var s = await runner.run(null, "stop", {});
    h.expect("非空结果照常触发二次回复", s.silent === false && s.skipReply === false, JSON.stringify(s));
    tools.executeTool = function () { return ""; };
    var batch = await runner.batch(null, [{ name: "stop", args: {} }, { name: "collect", args: {} }]);
    h.expect("整批都是空结果 → allSilent=true（整轮跳过二次回复）",
      batch.ok === true && batch.allSilent === true && batch.results.length === 2, JSON.stringify(batch));
    var reject = await runner.run(null, "dig_block", { x: 1, y: 2 });
    h.expect("校验失败的结果带拒绝文本且不静默",
      reject.ok === false && reject.text.indexOf("执行失败") === 0 && reject.silent === false, JSON.stringify(reject));
  } finally {
    tools.executeTool = original;
  }
  h.expect("统计里能看到静默与放行次数", runner.stats().silent >= 3 && runner.stats().spoken >= 1, JSON.stringify(runner.stats()));
  runner.reset();
}
// 25f：search_tools 按需检索与降 Token。
function checkSearch(h) {
  h.section("25f. 按需检索与降 Token / search_tools");
  var tools = load("modules/ai-tools.js");
  var schema = load("modules/ai-tools-schema.js");
  if (!tools || !schema) { h.expect("工具与 schema 可加载", false, "null"); return; }
  var found = tools.searchTools("dig", { limit: 5 });
  h.expect("按关键词搜到挖方块 / 砍树工具",
    found.ok === true && found.tools.length >= 2 && found.tools[0].function.name === "dig_block", JSON.stringify(found.tools.map(function (t) { return t.function.name; })));
  h.expect("搜索结果带完整英文定义", found.tools[0].function.parameters.required.length === 3, "");
  var menu = tools.getTools({ mode: "search" });
  h.expect("search 模式第一项是 search_tools 而非全量菜单",
    menu.length > 0 && menu[0].function.name === "search_tools" && menu.length < 14, String(menu.length));
  h.expect("search_tools 自身定义是纯英文且要求 query",
    schema.searchToolDefinition().function.parameters.required[0] === "query" &&
    /[\u4e00-\u9fa5]/.test(schema.searchToolDefinition().function.description) === false, "");
  var slim = tools.getTools({ slim: true });
  h.expect("slim 菜单剥掉工具描述，字符数明显更少",
    slim.length === 14 && slim[0].function.description === undefined &&
    schema.stats().slimChars < schema.stats().schemaChars, JSON.stringify(schema.stats()));
  var limit = tools.searchTools("inventory", { limit: 1 });
  h.expect("limit 生效，不一次性返回全部工具", limit.tools.length === 1, JSON.stringify(limit.tools.length));
  h.expect("默认 getTools 仍返回完整 14 个（不破坏既有调用链）", tools.getTools().length === 14, "");
}
// 主流程：逐组跑，任一组抛错只记一条失败。
async function run(h) {
  try { checkStatic(h); } catch (e1) { h.expect("25a 未抛错", false, String(e1)); }
  try { checkEnglish(h); } catch (e2) { h.expect("25b 未抛错", false, String(e2)); }
  try { checkValidate(h); } catch (e3) { h.expect("25c 未抛错", false, String(e3)); }
  try { await checkExecute(h); } catch (e4) { h.expect("25d 未抛错", false, String(e4)); }
  try { await checkSilent(h); } catch (e5) { h.expect("25e 未抛错", false, String(e5)); }
  try { checkSearch(h); } catch (e6) { h.expect("25f 未抛错", false, String(e6)); }
}
module.exports = { run: run };
