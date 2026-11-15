// scripts/selftest.js
// 总自测（P0-7 ~ P0-10）：静态检查 modules/*.js + 跑一遍解析 / 意图 / 聊天 / 执行的功能断言
// 用法：node scripts/selftest.js
// 依赖：node 内置 fs、path、child_process；被测模块 modules/intent.js、modules/intent-parser.js、
//       modules/chat-handler.js、modules/command-handler.js（都不联网、不需要真 bot，用假 bot 驱动）
// 产物：logs/p0-selftest-YYYYMMDD-HHMMSS.txt（有 FAIL 时退出码 1）；说明：不动其它文件，临时数据只在内存里造
// 作者：MineBots
// ========================================
// 检查清单 / checks
//   0 环境 1 静态（头注释 / 禁用语法 / 中文标识符 / 600 行上限 / 可 require / 导出接口） 2 解析器 3 解析器续（定时 / 开关 / 目标 / 错误码）
//   4 意图 5 聊天 6 执行器 7 战斗与交互 8 队列与集成 9 语法与守卫（node --check + guard.js check） 10 汇总
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers
var fs = require("fs");
var path = require("path");
var childProcess = require("child_process");
// 常量：项目根目录（本文件在 scripts/ 下）/ 单个模块最大行数（与 guard.js 一致）。
var ROOT = path.join(__dirname, ".."); var MAX_LINES = 600;
var MODULE_FILES = ["modules/intent.js", "modules/intent-parser.js", "modules/chat-handler.js", "modules/command-handler.js", "modules/speech.js", "modules/motion.js", "modules/typing.js", "modules/prefs.js", "modules/ollama-installer.js", "modules/npm-manager.js", "modules/param-manager.js", "modules/shared-board.js", "modules/swarm.js", "modules/state-util.js", "modules/state-nodes.js", "modules/state-skills.js", "modules/state-skills-plus.js", "modules/state-skills-ai.js", "modules/state-skills-flow.js", "modules/state-macros.js", "modules/state-machine.js", "modules/ai-tools-state.js", "modules/protocol-forge.js", "modules/mod-guard.js", "modules/anti-stuck.js", "modules/pathfinding.js", "modules/actions.js", "modules/bot-manager.js", "scripts/selftest-p2.js", "scripts/selftest-p3.js"]; // 常量：被测模块清单（guard 的 600 行上限对 scripts/ 同样有效）
var SELF_FILE = "scripts/selftest.js"; var MOTION_ENV = "MINEBOTS_MOTION_STEP_MS";

// 常量：禁用语法——前四条与 guard.js 对齐，后四条是本项目的书写风格（var / function）。
var FORBIDDEN = [
  { re: /\?\./, name: "可选链（问号加点）" },
  { re: /\?\?/, name: "空值合并（两个问号）" },
  { re: /^import\s+/m, name: "import（要用 require）" },
  { re: /^export\s+/m, name: "export" },
  { re: /\bconst\b/, name: "const（要用 var）" },
  { re: /\blet\b/, name: "let（要用 var）" },
  { re: /=>/, name: "箭头函数（要用 function）" },
  { re: /`/, name: "模板字符串（要用 + 拼接）" }
];
// 常量：中文标识符（变量名 / 函数名不许用中文）。
var ZH_IDENT = /(?:var|let|const|function)\s+([\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)/;
// 常量：每个模块必须导出的接口（§五 / §八 规定）。
var EXPORTS_WANTED = {
  "modules/intent.js": ["parseIntent", "getKeywords", "addKeyword", "KEYWORDS"],
  "modules/intent-parser.js": ["parse", "parseAction", "parseJoinOut", "validateTime", "formatError", "parseMany"],
  "modules/chat-handler.js": ["attach", "handleChat"],
  "modules/command-handler.js": ["attach", "executeAction", "runQueue"]
};
// 运行时状态 + 小工具 / state and helpers
var journal = []; var passCount = 0; var failCount = 0;
function toText(v) { return (v === null || v === undefined) ? "" : String(v); }
function toNumber(v, fallback) { var n = parseFloat(v); return isNaN(n) ? fallback : n; }
function getErrText(err) { try { if (!err) return "unknown error"; return String(err.message ? err.message : err); } catch (e) { return "unknown error"; } }
function isFn(v) { return typeof v === "function"; }
function pad(n, w) { var t = toText(n); while (t.length < w) t = "0" + t; return t; }
function stamp() { var d = new Date(); return toText(d.getFullYear()) + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2) + "-" + pad(d.getHours(), 2) + pad(d.getMinutes(), 2) + pad(d.getSeconds(), 2); }
function section(title) { var line = "== " + title + " =="; journal.push(""); journal.push(line); console.log(""); console.log(line); }
function pass(label) { passCount++; journal.push("[PASS] " + label); console.log("[PASS] " + label); }
function fail(label, detail) { failCount++; var text = toText(detail); var line = "[FAIL] " + label + (text.length > 0 ? "  -> " + text : ""); journal.push(line); console.log(line); }
function expect(label, condition, detail) { if (condition) pass(label); else fail(label, detail); }
function expectEqual(label, actual, wanted) { var a = JSON.stringify(actual); var w = JSON.stringify(wanted); expect(label, a === w, "actual=" + a + " wanted=" + w); }
function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
function note(label, detail) { var text = toText(detail); var line = "[INFO] " + label + (text.length > 0 ? "  -> " + text : ""); journal.push(line); console.log(line); }
// ===== 静态检查 / static =====
// 读项目内文件，读不到返回 null。
function readText(rel) { try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch (e) { return null; } }
// 检查四个模块：头注释、禁用语法、中文标识符、行数、module.exports、可 require、导出接口。
function checkStatic() {
  section("1. 静态检查 / static");
  for (var i = 0; i < MODULE_FILES.length; i++) {
    var rel = MODULE_FILES[i];
    var text = readText(rel);
    if (text === null) { fail(rel + " 可读取", "readFileSync 失败"); continue; }
    var lines = text.split("\n"), firstLine = "";
    for (var k = 0; k < lines.length; k++) if (lines[k].trim().length > 0) { firstLine = lines[k].trim(); break; }
    expect(rel + " 有文件头注释", firstLine.indexOf("//") === 0, "首行=" + firstLine);
    var bad = [];
    for (var p = 0; p < FORBIDDEN.length; p++) if (FORBIDDEN[p].re.test(text)) bad.push(FORBIDDEN[p].name);
    expect(rel + " 无禁用语法", bad.length === 0, bad.join(" / "));
    var zh = ZH_IDENT.exec(text);
    expect(rel + " 无中文标识符", zh === null, zh ? zh[1] : "");
    expect(rel + " 行数 <= " + MAX_LINES, lines.length <= MAX_LINES, lines.length + " 行");
    expect(rel + " 有 module.exports", text.indexOf("module.exports") >= 0, "");
  }
  var files = Object.keys(EXPORTS_WANTED);
  for (var j = 0; j < files.length; j++) {
    var file = files[j], mod = null, loadError = "";
    try { mod = require(path.join(ROOT, file)); } catch (e) { mod = null; loadError = getErrText(e); }
    expect(file + " 可 require（不联网也不崩）", mod !== null, loadError);
    if (mod === null) continue;
    var names = EXPORTS_WANTED[file];
    for (var n = 0; n < names.length; n++) {
      var name = names[n], value = mod[name];
      if (name === "KEYWORDS") expect(file + " 导出 " + name + " 是数组", Array.isArray(value), typeof value);
      else expect(file + " 导出 " + name + " 是函数", isFn(value), typeof value);
    }
  }
}
// ===== 假 bot / fake bot =====
// 造一个向量点（带 offset / distanceTo，模拟 mineflayer 的 Vec3）。
function makeVec(x, y, z) {
  return {
    x: x, y: y, z: z,
    offset: function (dx, dy, dz) { return makeVec(x + dx, y + dy, z + dz); },
    distanceTo: function (other) {
      var dx = toNumber(other.x, 0) - x, dy = toNumber(other.y, 0) - y, dz = toNumber(other.z, 0) - z;
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
  };
}
// 坐标转文本：用于断言里对比。
function posText(pos) {
  try { if (!pos) return "null"; return Math.round(toNumber(pos.x, 0)) + "," + Math.round(toNumber(pos.y, 0)) + "," + Math.round(toNumber(pos.z, 0)); } catch (e) { return "?"; }
}
// 造一个方块 / 一个实体（怪物 / 玩家 / 掉落物），extra 里的键直接挂上去。
function makeBlock(name, x, y, z) { return { name: name, position: makeVec(x, y, z), type: 1 }; }
function makeEntity(id, type, name, x, y, z, extra) {
  var entity = { id: id, type: type, name: name, position: makeVec(x, y, z) };
  var keys = Object.keys(extra || {});
  for (var i = 0; i < keys.length; i++) entity[keys[i]] = extra[keys[i]];
  return entity;
}
// 给对象装一个极简事件发射器（on / removeListener / emit / listenerCount）。
function makeEmitter(target) {
  var handlers = {};
  target.handlers = handlers;
  target.lastError = null;
  target.on = function (event, fn) { if (!handlers[event]) handlers[event] = []; handlers[event].push(fn); return target; };
  target.removeListener = function (event, fn) { var list = handlers[event] || []; for (var i = list.length - 1; i >= 0; i--) if (list[i] === fn) list.splice(i, 1); return target; };
  target.emit = function (event) {
    var args = Array.prototype.slice.call(arguments, 1), list = (handlers[event] || []).slice(0);
    for (var i = 0; i < list.length; i++) { try { list[i].apply(target, args); } catch (e) { target.lastError = getErrText(e); } }
    return true;
  };
  target.listenerCount = function (event) { return (handlers[event] || []).length; };
  return target;
}
// 造一个假 bot：只实现执行器要用到的接口，每次调用都记进 bot.records。
function makeBot(options) {
  var opts = options || {};
  var bot = {};
  bot.username = toText(opts.username).length > 0 ? opts.username : "MineBot";
  bot.entity = { position: makeVec(toNumber(opts.x, 0), toNumber(opts.y, 64), toNumber(opts.z, 0)) };
  bot.entities = opts.entities || {};
  bot.blocks = opts.blocks || [];
  bot.delay = toNumber(opts.delay, 0);
  bot.records = { dig: [], lookAt: [], controls: [], attack: [], equip: [], place: [], craft: [], chat: [], queue: [] };
  bot.inventory = { items: function () { return opts.items || []; } };
  bot.registry = { itemsByName: { dirt: { id: 3 }, stone: { id: 1 }, oak_planks: { id: 5 }, stick: { id: 280 }, crafting_table: { id: 58 } } };
  bot.blockAt = function (pos) {
    for (var i = 0; i < bot.blocks.length; i++) if (posText(bot.blocks[i].position) === posText(pos)) return bot.blocks[i];
    return null;
  };
  // findBlock：真按 matching 过滤器挑最近的候选（这样能验证挖木头 / 挖矿的过滤逻辑）。
  bot.findBlock = function (o) {
    var matching = o ? o.matching : null;
    var max = o && o.maxDistance !== undefined ? toNumber(o.maxDistance, Infinity) : Infinity;
    var best = null, bestDistance = Infinity;
    for (var i = 0; i < bot.blocks.length; i++) {
      var block = bot.blocks[i], hit = false;
      try { hit = isFn(matching) ? matching(block) === true : false; } catch (e) { hit = false; }
      if (!hit) continue;
      var distance = bot.entity.position.distanceTo(block.position);
      if (distance <= max && distance < bestDistance) { bestDistance = distance; best = block; }
    }
    return best;
  };
  bot.canDigBlock = function () { return opts.canDig !== false; };
  bot.lookAt = function (pos) {
    bot.records.lookAt.push("start:" + posText(pos));
    if (bot.delay <= 0) { bot.records.lookAt.push("end:" + posText(pos)); return Promise.resolve(true); }
    return new Promise(function (resolve) { setTimeout(function () { bot.records.lookAt.push("end:" + posText(pos)); resolve(true); }, bot.delay); });
  };
  bot.dig = function (block) { bot.records.dig.push(block ? block.name : "null"); return Promise.resolve(); };
  bot.setControlState = function (name, on) { bot.records.controls.push(name + "=" + (on ? "1" : "0")); return true; };
  bot.clearControlStates = function () { bot.records.controls.push("clear"); return true; };
  bot.attack = function (entity) { bot.records.attack.push(toText(entity && (entity.username || entity.name))); try { if (entity && bot.entities[entity.id]) delete bot.entities[entity.id]; } catch (e) { /* 已经死了 */ } return true; };
  bot.swingArm = function () { return true; };
  bot.equip = function (item) { bot.records.equip.push(toText(item && item.name)); return Promise.resolve(); };
  bot.placeBlock = function (block) { bot.records.place.push(toText(block && block.name)); return Promise.resolve(); };
  bot.craft = function (recipe, count) { bot.records.craft.push(toNumber(count, 0)); return Promise.resolve(); };
  bot.recipesFor = function (id) { if (opts.recipes === false) return []; return id ? [{ id: id }] : []; };
  bot.chat = function (text) { bot.records.chat.push(toText(text)); return true; };
  bot.pathfinder = null;
  makeEmitter(bot);
  bot.on("bot-action-queue", function (payload) { bot.records.queue.push(payload); });
  return bot;
}
// ===== 2. 解析器 / intent-parser =====
// 断言成功结果（ok 为真且动作名对得上）/ 失败结果（ok 为假且错误码对得上）。
function expectOk(label, result, action) { expect(label, result && result.ok === true && result.action === action, JSON.stringify(result)); }
function expectFail(label, result, code) { expect(label, result && result.ok === false && result.error && result.error.code === code, JSON.stringify(result)); }

// 跑一遍 §九 列出的动作语法与边界。
function checkParser() {
  section("2. 解析器 / intent-parser");
  var parser = require(path.join(ROOT, "modules/intent-parser.js"));
  var dig = parser.parse("dig_tree");
  expectOk("dig_tree 能解析", dig, "dig_tree");
  expect("dig_tree 默认挖满背包（blocks=null）", dig && dig.blocks === null && dig.fillInventory === true, JSON.stringify(dig));
  var dig2 = parser.parse("dig_tree, blocks=10, oak");
  expectOk("dig_tree 带参数能解析", dig2, "dig_tree");
  expect("dig_tree 参数生效（blocks=10 / wood=oak / 不挖满背包）", dig2 && dig2.blocks === 10 && dig2.wood === "oak" && dig2.fillInventory === false, JSON.stringify(dig2));
  var mine = parser.parse("mine, blocks=10, (iron)");
  expectOk("mine 能解析", mine, "mine");
  expect("mine 的 (iron) 进 ores", mine && mine.ores.length === 1 && mine.ores[0] === "iron", JSON.stringify(mine));
  var mineList = parser.parse("mine, (iron), (gold)");
  expectEqual("mine 多个 (ore) 都认", mineList ? mineList.ores : null, ["iron", "gold"]);
  var mineAll = parser.parse("mine, blocks=10");
  expect("mine 不带 (ore) 时 ores 为空数组", mineAll && Array.isArray(mineAll.ores) && mineAll.ores.length === 0, JSON.stringify(mineAll));
  var follow = parser.parse("follow, Steve");
  expectOk("follow 能解析", follow, "follow");
  expectEqual("follow 玩家名进 players", follow ? follow.players : null, ["Steve"]);
  var followMany = parser.parse("follow, Steve, Alex");
  expectEqual("follow 多个玩家名都认", followMany ? followMany.players : null, ["Steve", "Alex"]);
  expectFail("follow 不带玩家名报错", parser.parse("follow"), "missingPlayer");
  var plain = parser.parse("stop");
  expectOk("stop 能解析", plain, "stop"); expectOk("collect 能解析", parser.parse("collect"), "collect");
  expectOk("place 能解析", parser.parse("place"), "place"); expectOk("craft 能解析", parser.parse("craft"), "craft");
  expectEqual("PLAIN_ACTIONS 就是这四个", parser.PLAIN_ACTIONS, ["stop", "collect", "place", "craft"]);
  var move = parser.parse("move, 10 64 10");
  expectOk("move 能解析", move, "move");
  expect("move 坐标进 position 与 x/y/z", move && posText(move.position) === "10,64,10" && move.x === 10 && move.y === 64 && move.z === 10, JSON.stringify(move));
  expectFail("move 坐标不合法报错", parser.parse("move, a b c"), "badPosition");
  var attackAll = parser.parse("attack_all");
  expectOk("attack_all 能解析", attackAll, "attack_all");
  expect("attack_all 默认 range=5*5", attackAll && attackAll.range === "5*5", JSON.stringify(attackAll));
  expect("attack_all 认 range 参数", parser.parse("attack_all range=5*5").range === "5*5", "");
  expectFail("attack_all 多余参数报错", parser.parse("attack_all, foo"), "extraArgs");
  var attack = parser.parse("attack, zombie");
  expectOk("attack 能解析", attack, "attack");
  expect("attack 目标进 attackTarget", attack && attack.attackTarget === "zombie", JSON.stringify(attack));
}
// 解析器：定时 / 开关 / 目标前缀 / 时长范围回位 / 错误码。
function checkParserMore() {
  section("3. 解析器续 / schedule, switch, target, error");
  var parser = require(path.join(ROOT, "modules/intent-parser.js"));
  var sched = parser.parse("join 9:00 AM, out 5:00 PM");
  expect("定时能解析（isJoinOut=true）", sched && sched.isJoinOut === true && sched.ok === true, JSON.stringify(sched));
  expect("定时时刻换算成分针（540 / 1020）", sched && sched.join && sched.out && sched.join.minutes === 540 && sched.out.minutes === 1020, JSON.stringify(sched));
  expectFail("定时只写一半报错", parser.parse("join 9:00 AM"), "scheduleIncomplete");
  expectFail("定时时刻不合法报错", parser.parse("join 25:00, out 5:00 PM"), "joinBadTime");
  expect("parseSchedule 对非定时返回 null", parser.parseSchedule("stop") === null, JSON.stringify(parser.parseSchedule("stop")));
  expect("parseSchedule 对定时返回结果", parser.parseSchedule("join 9:00 AM, out 5:00 PM").isJoinOut === true, "");
  var on = parser.parse("test mode on");
  expect("开关能解析（test_mode = on）", on && on.type === "switch" && on.key === "test_mode" && on.on === true, JSON.stringify(on));
  var off = parser.parse("hive mind off");
  expect("开关能解析（hive_mind = off）", off && off.type === "switch" && off.key === "hive_mind" && off.on === false, JSON.stringify(off));
  expectFail("开关值不合法报错", parser.parse("test mode foo"), "switchValue");
  expect("目标前缀 all 生效", parser.parse("all dig_tree, blocks=5").target === "all", ""); expect("目标前缀 bot1 生效", parser.parse("bot1 follow, Steve").target === "bot1", "");
  expect("目标前缀 bot3-5 生效", parser.parse("bot3-5 stop").target === "bot3-5", "");
  var full = parser.parse("dig_tree, blocks=10, oak, time=10m, range=5*5, back 10 64 10");
  expect("time=10m 换算成 600 秒", full && full.time === "10m" && full.timeSeconds === 600, JSON.stringify(full));
  expect("range=5*5 保留文本", full && full.range === "5*5", JSON.stringify(full));
  expectEqual("back 坐标进 back 数组", full ? full.back : null, [10, 64, 10]);
  expect("裸时长（dig_tree, 10m）也认", parser.parse("dig_tree, 10m").timeSeconds === 600, "");
  expectFail("空指令报 empty", parser.parse(""), "empty");
  expectFail("纯空格报 empty", parser.parse("   "), "empty");
  var unknown = parser.parse("nonsense stuff");
  expectFail("不认识的指令报 unknownAction", unknown, "unknownAction");
  expect("错误结果带双语说明与建议", unknown && unknown.error.zh.length > 0 && unknown.error.en.length > 0 && unknown.error.suggestions.length > 0, JSON.stringify(unknown && unknown.error));
  var text = parser.formatError(unknown);
  expect("formatError 输出双语（含 / 分隔）", text.indexOf("错误：") === 0 && text.indexOf(" / ") > 0, text); expect("formatError 对成功结果返回空串", parser.formatError(parser.parse("stop")) === "", "");
  var many = parser.parseMany("dig_tree\n\nstop");
  expect("parseMany 跳空行并返回两条", many.length === 2 && many[1].action === "stop", JSON.stringify(many));
  expect("validateTime 认得 9:00 AM", parser.validateTime("9:00 AM").ok === true, ""); expect("validateTime 不认得乱写", parser.validateTime("zzz").ok === false, "");
  expect("parseDuration('10m') = 600 秒", parser.parseDuration("10m").seconds === 600, ""); expect("parseDuration 乱写返回 null", parser.parseDuration("zzz") === null, "");
  expect("parseClock('9:00 AM') = 540 分", parser.parseClock("9:00 AM").minutes === 540, ""); expect("parseClock 乱写返回 null", parser.parseClock("zzz") === null, "");
  expect("parseRange('5*5') 宽高都是 5", parser.parseRange("5*5").width === 5 && parser.parseRange("5*5").depth === 5, ""); expect("parseRange 乱写返回 null", parser.parseRange("zzz") === null, "");
  expect("closest 能给相近建议", parser.closest("dig_tre", 3).indexOf("dig_tree") === 0, JSON.stringify(parser.closest("dig_tre", 3)));
}
// ===== 4. 意图 / intent =====
// 语法优先、关键词兜底、关键词表的深拷贝与动态扩充。
function checkIntent() {
  section("4. 意图 / intent");
  var intent = require(path.join(ROOT, "modules/intent.js"));
  var grammar = intent.parseIntent("mine, blocks=3, (iron)");
  expect("语法优先：1 条动作且带完整参数", grammar.length === 1 && grammar[0].action === "mine" && grammar[0].command.blocks === 3, JSON.stringify(grammar));
  expectEqual("关键词兜底：按出现顺序出两个动作", intent.parseIntent("先砍树再跟随"), [{ action: "dig_tree" }, { action: "follow" }]);
  expect("空文本返回空队列", intent.parseIntent("").length === 0, "");
  expect("乱码文本返回空队列（不抛错）", intent.parseIntent("@#$%^&").length === 0, JSON.stringify(intent.parseIntent("@#$%^&")));
  expect("matchKeywords 不依赖语法", intent.matchKeywords("先挖矿再停下")[0].action === "mine", JSON.stringify(intent.matchKeywords("先挖矿再停下")));
  var table = intent.getKeywords();
  expect("getKeywords 返回深拷贝（长度一致）", table.length === intent.KEYWORDS.length, table.length + " vs " + intent.KEYWORDS.length);
  table[0].action = "hacked";
  table.push({ action: "x", words: ["x"] });
  expect("改拷贝不会动到内部关键词表", intent.KEYWORDS[0].action === "dig_tree" && intent.KEYWORDS.length === table.length - 1, JSON.stringify(intent.KEYWORDS[0]));
  expect("addKeyword 加新触发词返回 true", intent.addKeyword("dig_tree", "清场砍树") === true, ""); expect("addKeyword 重复触发词（忽略大小写）返回 false", intent.addKeyword("dig_tree", "清场砍树") === false, "");
  expect("addKeyword 能新建动作组", intent.addKeyword("test_only", "自检专用词") === true, ""); expect("addKeyword 空参数返回 false", intent.addKeyword("", "") === false, "");
  expect("新加的触发词立刻能识别", intent.parseIntent("自检专用词")[0].action === "test_only", JSON.stringify(intent.parseIntent("自检专用词")));
  var bad = intent.parseCommand("nonsense stuff");
  expect("parseCommand 透传解析器错误", bad.ok === false && bad.error.code === "unknownAction", JSON.stringify(bad));
  expect("parseCommand 对空文本不抛错", intent.parseCommand("").ok === false, ""); expect("formatError 把失败转成中文说明", intent.formatError(bad).indexOf("错误：") === 0, intent.formatError(bad));
  expect("formatError 对成功结果返回空串", intent.formatError(intent.parseCommand("stop")) === "", "");
  expect("GRAMMAR_ONLY 保留 join / switch", intent.GRAMMAR_ONLY.indexOf("join") >= 0 && intent.GRAMMAR_ONLY.indexOf("switch") >= 0, JSON.stringify(intent.GRAMMAR_ONLY));
}
// ===== 5. 聊天 / chat-handler =====
// 用假的 ai-client 重新加载 chat-handler：自检绝不联网，回复内容可控。
function loadChatWithStub(reply) {
  var aiFile = require.resolve(path.join(ROOT, "modules/ai-client.js")), chatFile = require.resolve(path.join(ROOT, "modules/chat-handler.js"));
  var savedAi = require.cache[aiFile];
  require.cache[aiFile] = {
    id: aiFile, filename: aiFile, loaded: true,
    exports: { ask: function () { return Promise.resolve(toText(reply)); }, askWithTools: function () { return Promise.resolve(null); }, embed: function () { return Promise.resolve(null); } }
  };
  delete require.cache[chatFile];
  var mod = require(chatFile);
  if (savedAi) require.cache[aiFile] = savedAi; else delete require.cache[aiFile];
  return mod;
}

// 聊天：忽略自己的消息、派发动作队列、AI 回复、挂载与卸载、端到端。
async function checkChat() {
  section("5. 聊天 / chat-handler");
  var chat = loadChatWithStub("好的，马上");
  var bot = makeBot({ username: "MineBot" });
  expect("attach(null) 返回 null", chat.attach(null) === null, "");
  expect("attach 裸对象（没有 on）返回 null", chat.attach({ id: "x" }) === null, "");
  var detach = chat.attach(bot, "bot1");
  expect("attach 返回卸载函数", isFn(detach), typeof detach);
  expect("attach 挂上了 chat 监听", bot.listenerCount("chat") === 1, bot.listenerCount("chat") + "");
  expect("重复 attach 返回同一个卸载函数", chat.attach(bot, "bot1") === detach, typeof chat.attach(bot, "bot1"));
  expect("重复 attach 不会重复挂监听", bot.listenerCount("chat") === 1, bot.listenerCount("chat") + "");
  bot.emit("chat", "MineBot", "dig_tree");
  await wait(5);
  expect("自己发的消息被忽略", bot.records.queue.length === 0, JSON.stringify(bot.records.queue));
  bot.emit("chat", "Steve", "dig_tree, blocks=5");
  await wait(5);
  expect("别人的指令派发到 bot-action-queue", bot.records.queue.length === 1, JSON.stringify(bot.records.queue));
  var payload = bot.records.queue[0];
  expect("队列负载带 from / actions / message", payload && payload.from === "Steve" && payload.actions.length === 1 && payload.actions[0].action === "dig_tree" && payload.message === "dig_tree, blocks=5", JSON.stringify(payload));
  expect("动作带完整参数（blocks=5）", payload && payload.actions[0].command && payload.actions[0].command.blocks === 5, JSON.stringify(payload && payload.actions[0]));
  expect("AI 回复真的发出去了（英文玩家拿到纯英文兜底，中文被硬过滤掉）", bot.records.chat.length > 0 && bot.records.chat.join("|").indexOf("好的，马上") < 0 && bot.records.chat.indexOf("ok") >= 0, JSON.stringify(bot.records.chat));
  expect("英文玩家只收到英文播报（不再中英混排）", bot.records.chat.indexOf("Got it, chopping wood") >= 0 && bot.records.chat.join("|").indexOf("收到，我去") < 0, JSON.stringify(bot.records.chat));
  bot.emit("chat", "Alex", "砍树");
  await wait(5);
  expect("中文关键词也能派发", bot.records.queue.length === 2 && bot.records.queue[1].actions[0].action === "dig_tree", JSON.stringify(bot.records.queue[1]));
  bot.emit("chat", "Alex", "今天天气不错");
  await wait(5);
  expect("纯聊天不进动作队列", bot.records.queue.length === 2, JSON.stringify(bot.records.queue.length));
  expect("纯聊天也没抛错", bot.lastError === null, toText(bot.lastError));
  expect("handleChat 空消息返回 false", (await chat.handleChat(bot, "bot1", "Steve", "")) === false, "");
  expect("handleChat 正常消息返回 true", (await chat.handleChat(bot, "bot1", "Steve", "挖矿")) === true, "");
  expect("handleChat 也派发了动作", bot.records.queue.length === 3, bot.records.queue.length + "");
  expect("裸 bot（没有 emit）handleChat 不崩", (await chat.handleChat({ id: "bare" }, "bare", "Steve", "stop")) === true, "");
  detach();
  var before = bot.records.queue.length;
  bot.emit("chat", "Steve", "dig_tree");
  await wait(5);
  expect("卸载后不再派发", bot.records.queue.length === before, bot.records.queue.length + " vs " + before);
}
// ===== 6. 执行器 / command-handler =====
// 一撮测试方块：木头 / 石头 / 铁矿各一个。
function testBlocks() {
  return [makeBlock("oak_log", 1, 64, 0), makeBlock("stone", 2, 64, 0), makeBlock("iron_ore", 3, 64, 0)];
}
// 执行器：9 个动作 + 队列 + 挂载 + 端到端。
async function checkExecutor() {
  section("6. 执行器 / command-handler");
  var handler = require(path.join(ROOT, "modules/command-handler.js"));
  var bot = makeBot({});
  var stop = await handler.executeAction(bot, { action: "stop" });
  expect("stop 成功", stop.ok === true && stop.action === "stop", JSON.stringify(stop));
  expect("stop 清空控制状态", bot.records.controls.join(",") === "clear", JSON.stringify(bot.records.controls));
  var unknown = await handler.executeAction(bot, { action: "fly" });
  expect("不认识的动作返回 unknown-action", unknown.ok === false && unknown.action === "unknown-action", JSON.stringify(unknown));
  var noName = await handler.executeAction(bot, {});
  expect("缺少 action 字段返回 unknown-action", noName.ok === false && noName.action === "unknown-action", JSON.stringify(noName));
  var noBot = await handler.executeAction(null, { action: "stop" });
  expect("没有 bot 时返回失败而不抛错", noBot.ok === false && toText(noBot.error).length > 0, JSON.stringify(noBot));
  var move = await handler.executeAction(bot, { action: "move", back: [10, 64, 10] });
  expect("move 成功并记住目标坐标", move.ok === true && move.position.x === 10 && move.position.z === 10, JSON.stringify(move));
  expect("move 真的调了 lookAt（看向目标头顶一格，不是地平线以下）", bot.records.lookAt.length >= 2 && bot.records.lookAt[bot.records.lookAt.length - 1] === "end:10,65,10", JSON.stringify(bot.records.lookAt));
  var digBot = makeBot({ blocks: testBlocks() });
  var dig = await handler.executeAction(digBot, "dig_tree", { blocks: 2 });
  expect("executeAction 支持（bot, 动作名, 参数）形式", dig.ok === true && dig.count === 2, JSON.stringify(dig));
  expect("dig_tree 只挖木头（不碰石头 / 矿石）", digBot.records.dig.join(",") === "oak_log,oak_log", JSON.stringify(digBot.records.dig));
  var digAll = await handler.executeAction(makeBot({ blocks: testBlocks() }), { action: "dig_tree" });
  expect("dig_tree 没写 blocks 时按默认量挖 3 个", digAll.ok === true && digAll.count === 3 && digAll.want === 3, JSON.stringify(digAll));
  var mineBot = makeBot({ blocks: testBlocks() });
  var mine = await handler.executeAction(mineBot, { action: "mine", blocks: 1 });
  expect("mine 成功且只挖矿石", mine.ok === true && mine.count === 1 && mineBot.records.dig.join(",") === "iron_ore", JSON.stringify(mine) + JSON.stringify(mineBot.records.dig));
  var mineEmpty = await handler.executeAction(makeBot({ blocks: [makeBlock("oak_log", 1, 64, 0)] }), { action: "mine", blocks: 1 });
  expect("附近没矿时老实失败", mineEmpty.ok === false && toText(mineEmpty.error).length > 0, JSON.stringify(mineEmpty));
  var oreFilterBot = makeBot({ blocks: [makeBlock("iron_ore", 1, 64, 0), makeBlock("gold_ore", 1, 64, 2)] });
  var oreFilter = await handler.executeAction(oreFilterBot, { action: "mine", blocks: 1, ores: ["gold"] });
  expect("mine 的 (gold) 能过滤矿石", oreFilter.ok === true && oreFilterBot.records.dig.join(",") === "gold_ore", JSON.stringify(oreFilterBot.records.dig));
  var woodFilterBot = makeBot({ blocks: [makeBlock("oak_log", 1, 64, 0), makeBlock("birch_log", 1, 64, 2)] });
  var woodFilter = await handler.executeAction(woodFilterBot, { action: "dig_tree", blocks: 1, wood: "birch" });
  expect("dig_tree 的 wood 能过滤树种", woodFilter.ok === true && woodFilterBot.records.dig.join(",") === "birch_log", JSON.stringify(woodFilterBot.records.dig));
  var farBot = makeBot({ blocks: [makeBlock("diamond_ore", 60, 64, 0)] });
  var far = await handler.executeAction(farBot, { action: "mine", blocks: 1, range: "4*4" });
  expect("超出 range 的矿找不到（也不会硬挖）", far.ok === false && farBot.records.dig.length === 0, JSON.stringify(far));
  var noDigBot = makeBot({ blocks: [makeBlock("oak_log", 1, 64, 0)], canDig: false });
  var noDig = await handler.executeAction(noDigBot, { action: "dig_tree", blocks: 1 });
  expect("canDigBlock 为假时不硬挖", noDig.ok === false && noDigBot.records.dig.length === 0, JSON.stringify(noDig));
}
// 检查 lookAt 记录：end 必须跟在一个未配对的 start 之后（分步缓转可能和其他视线交错，但绝不丢配对）。
function lookPairsContiguous(bot) {
  var list = bot.records.lookAt, open = 0;
  if (list.length === 0 || list.length % 2 !== 0) return false;
  for (var i = 0; i < list.length; i++) {
    var s = String(list[i]);
    if (s.indexOf("start:") === 0) open++;
    else if (s.indexOf("end:") === 0 && open > 0) open--;
    else return false;
  }
  return open === 0;
}
// 执行器续：打怪 / 跟随 / 捡东西 / 放置 / 合成。
async function checkExecutorMore() {
  section("7. 战斗与交互 / attack, follow, collect, place, craft");
  var handler = require(path.join(ROOT, "modules/command-handler.js"));
  var fightBot = makeBot({
    entities: {
      "1": makeEntity(1, "mob", "zombie", 3, 64, 0), "2": makeEntity(2, "mob", "skeleton", 4, 64, 0),
      "3": makeEntity(3, "player", "Steve", 2, 64, 0, { username: "Steve" }), "4": makeEntity(4, "animal", "cow", 1, 64, 1)
    }
  });
  var atk = await handler.executeAction(fightBot, { action: "attack_all", range: "10*10" });
  expect("attack_all 打到 2 只怪", atk.ok === true && atk.count === 2, JSON.stringify(atk));
  expect("attack_all 不碰玩家与动物", fightBot.records.attack.join(",").indexOf("Steve") < 0 && fightBot.records.attack.join(",").indexOf("cow") < 0, JSON.stringify(fightBot.records.attack));
  var atkAlias = await handler.executeAction(makeBot({ entities: { "1": makeEntity(1, "mob", "zombie", 2, 64, 0) } }), { action: "attack", range: "5*5" });
  expect("attack 是 attack_all 的别名", atkAlias.ok === true && atkAlias.action === "attack" && atkAlias.count === 1, JSON.stringify(atkAlias));
  var noFoe = await handler.executeAction(makeBot({}), { action: "attack_all" });
  expect("附近没怪时诚实失败", noFoe.ok === false && noFoe.action === "attack_all", JSON.stringify(noFoe));
  var farFoe = await handler.executeAction(makeBot({ entities: { "1": makeEntity(1, "mob", "zombie", 30, 64, 0) } }), { action: "attack_all", range: "5*5" });
  expect("超出范围的怪不会被追打", farFoe.ok === false, JSON.stringify(farFoe));
  var followBot = makeBot({
    entities: {
      "1": makeEntity(1, "player", "Steve", 3, 64, 0, { username: "Steve" }), "2": makeEntity(2, "player", "Alex", 5, 64, 0, { username: "Alex" })
    }
  });
  var follow = await handler.executeAction(followBot, { action: "follow", players: ["Alex"] });
  expect("follow 按名单挑玩家", follow.ok === true && follow.player === "Alex", JSON.stringify(follow));
  await wait(1100); // actions.followPlayer 的退化跟随每秒 tick 一次，等一拍再断言「看向 + 前进」
  expect("follow 看向并前进（视线心跳在跑）", followBot.records.lookAt.length >= 2 && followBot.records.controls.indexOf("forward=1") >= 0 && !!followBot._mbGaze, JSON.stringify(followBot.records));
  var followNear = await handler.executeAction(makeBot({ entities: { "1": makeEntity(1, "player", "Steve", 3, 64, 0, { username: "Steve" }) } }), { action: "follow" });
  expect("follow 不带名单时跟最近的玩家", followNear.ok === true && followNear.player === "Steve", JSON.stringify(followNear));
  var followNone = await handler.executeAction(makeBot({}), { action: "follow" });
  expect("附近没人时 follow 失败", followNone.ok === false, JSON.stringify(followNone));
  var lootBot = makeBot({ entities: { "9": makeEntity(9, "object", "item", 2, 64, 0) } });
  var collect = await handler.executeAction(lootBot, { action: "collect" });
  expect("collect 找到掉落物并走过去", collect.ok === true && collect.item === "item" && lootBot.records.controls.indexOf("forward=1") >= 0, JSON.stringify(collect));
  var collectNone = await handler.executeAction(makeBot({}), { action: "collect" });
  expect("附近没掉落物时 collect 失败", collectNone.ok === false, JSON.stringify(collectNone));
  var placeBot = makeBot({ items: [{ name: "dirt", count: 3 }], blocks: [makeBlock("grass_block", 0, 63, 0)] });
  var place = await handler.executeAction(placeBot, { action: "place" });
  expect("place 先装备再放下方块", place.ok === true && placeBot.records.equip.join(",") === "dirt" && placeBot.records.place.join(",") === "grass_block", JSON.stringify(place) + JSON.stringify(placeBot.records));
  var placeNone = await handler.executeAction(makeBot({ blocks: [makeBlock("grass_block", 0, 63, 0)] }), { action: "place" });
  expect("背包没方块时 place 失败", placeNone.ok === false, JSON.stringify(placeNone));
  var placeNoGround = await handler.executeAction(makeBot({ items: [{ name: "dirt", count: 1 }] }), { action: "place" });
  expect("脚下没参照方块时 place 失败", placeNoGround.ok === false, JSON.stringify(placeNoGround));
  var craftBot = makeBot({});
  var craft = await handler.executeAction(craftBot, { action: "craft", wood: "oak" });
  expect("craft 按 wood 找配方并合成 1 个", craft.ok === true && craft.item === "oak_planks" && craftBot.records.craft.join(",") === "1", JSON.stringify(craft));
  var craftNone = await handler.executeAction(makeBot({ recipes: false }), { action: "craft", wood: "oak" });
  expect("没有可用配方时 craft 失败而不崩", craftNone.ok === false && toText(craftNone.error).length > 0, JSON.stringify(craftNone));
  var craftNoBot = await handler.executeAction({}, { action: "craft" });
  expect("bot 不支持合成时 craft 老实失败", craftNoBot.ok === false, JSON.stringify(craftNoBot));
}
// 队列：串行、back 回位、坏项跳过、空队列、挂载与卸载、端到端。
async function checkQueue() {
  section("8. 队列与集成 / queue, attach, end-to-end");
  var handler = require(path.join(ROOT, "modules/command-handler.js"));
  var qBot = makeBot({ blocks: [makeBlock("oak_log", 1, 64, 0)], delay: 10 });
  var report = await handler.runQueue(qBot, [{ action: "dig_tree", blocks: 1 }, { action: "stop" }, { action: "dig_tree", blocks: 1, back: [5, 64, 5] }]);
  expect("runQueue 三项都成功", report.ok === true && report.total === 3 && report.done === 3 && report.failed === 0, JSON.stringify(report));
  expect("队列末尾按 back 走回去", report.results.length === 4 && report.results[3].action === "move", JSON.stringify(report.results));
  expectEqual("back 坐标被记进汇总", report.back, { x: 5, y: 64, z: 5 });
  expect("队列串行执行（lookAt 成对不交错）", lookPairsContiguous(qBot), JSON.stringify(qBot.records.lookAt));
  var sBot = makeBot({ blocks: [makeBlock("oak_log", 1, 64, 0)], delay: 15 });
  var p1 = handler.runQueue(sBot, [{ action: "dig_tree", blocks: 1 }, { action: "dig_tree", blocks: 1 }]);
  var p2 = handler.runQueue(sBot, [{ action: "dig_tree", blocks: 1 }, { action: "dig_tree", blocks: 1 }]);
  var both = await Promise.all([p1, p2]);
  expect("两条并发队列都跑完", both[0].ok === true && both[1].ok === true && sBot.records.dig.length === 4, JSON.stringify(sBot.records.dig));
  expect("并发队列也不交错（全局串行链）", lookPairsContiguous(sBot), JSON.stringify(sBot.records.lookAt));
  var mixBot = makeBot({});
  var mix = await handler.runQueue(mixBot, [{ action: "nope" }, { action: "stop" }]);
  expect("队列遇到不认识的动作仍然往下跑", mix.ok === false && mix.failed === 1 && mix.done === 1 && mixBot.records.controls.indexOf("clear") >= 0, JSON.stringify(mix));
  var emptyQueue = await handler.runQueue(makeBot({}), []);
  expect("空队列也能跑（total=0）", emptyQueue.ok === true && emptyQueue.total === 0 && emptyQueue.failed === 0, JSON.stringify(emptyQueue));
  var notArray = await handler.runQueue(makeBot({}), null);
  expect("队列不是数组也不崩", notArray.ok === true && notArray.total === 0, JSON.stringify(notArray));
  var aBot = makeBot({ blocks: [makeBlock("oak_log", 1, 64, 0)] });
  expect("attach(null) 返回 null", handler.attach(null) === null, "");
  var detachQueue = handler.attach(aBot);
  expect("attach 返回卸载函数", isFn(detachQueue), typeof detachQueue);
  aBot.emit("bot-action-queue", { from: "Steve", actions: [{ action: "stop" }], message: "stop" });
  await wait(60);
  expect("收到队列事件后真的执行了动作", aBot.records.controls.indexOf("clear") >= 0, JSON.stringify(aBot.records.controls));
  aBot.emit("bot-action-queue", { actions: [] });
  expect("空动作列表直接跳过（不报错）", aBot.lastError === null, toText(aBot.lastError));
  detachQueue();
  var clears = aBot.records.controls.join(",").split("clear").length - 1;
  aBot.emit("bot-action-queue", { actions: [{ action: "stop" }] });
  await wait(60);
  expect("卸载后不再响应队列事件", clears === 1 && aBot.records.controls.join(",").split("clear").length - 1 === 1, JSON.stringify(aBot.records.controls));
  var chat = loadChatWithStub("好的");
  var eBot = makeBot({ blocks: [makeBlock("oak_log", 1, 64, 0)] });
  var detachChat = chat.attach(eBot, "bot1");
  var detachE2e = handler.attach(eBot);
  eBot.emit("chat", "Steve", "砍树");
  await wait(80);
  expect("端到端：聊天 → 动作队列 → 真的挖了木头", eBot.records.dig.length > 0 && eBot.records.dig[0] === "oak_log", JSON.stringify(eBot.records.dig));
  eBot.emit("chat", "Steve", "先挖矿再停下");
  await wait(80);
  expect("端到端：一条消息里的多个动作都进队列", eBot.records.queue.length === 2, JSON.stringify(eBot.records.queue.length));
  expect("端到端：后面的 stop 也执行了", eBot.records.controls.indexOf("clear") >= 0, JSON.stringify(eBot.records.controls));
  expect("端到端：AI 回复也发出去了", eBot.records.chat.join(",").indexOf("好的") >= 0, JSON.stringify(eBot.records.chat));
  detachChat();
  detachE2e();
}
// ===== 9. 语法与守卫 / syntax and guard =====
// 从 guard 输出里解析越界清单（guard.js 只打印不抛错，退出码永远是 0，所以只能读文本）。
function parseGuardViolations(out) {
  var list = [], rows = toText(out).split("\n");
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i].trim();
    if (row.indexOf("x ") !== 0) continue;
    var parts = row.slice(2).split("->");
    var file = parts.length > 0 ? parts[0].trim() : "", rule = parts.length > 1 ? parts.slice(1).join("->").trim() : "";
    if (file.length > 0) list.push({ file: file, rule: rule });
  }
  return list;
}
// 跑 node --check 与 node guard.js check（子进程）：交付文件必须既语法正确，又不在越界清单里。
function checkGuard() {
  section("10. 语法与守卫 / node --check, guard.js");
  var files = MODULE_FILES.concat([SELF_FILE]);
  for (var i = 0; i < files.length; i++) {
    var ok = true, msg = "";
    try { childProcess.execFileSync(process.execPath, ["--check", path.join(ROOT, files[i])], { cwd: ROOT, encoding: "utf8" }); }
    catch (e) { ok = false; msg = getErrText(e); }
    expect("node --check " + files[i], ok, msg);
  }
  var out = "";
  try { out = toText(childProcess.execFileSync(process.execPath, ["guard.js", "check"], { cwd: ROOT, encoding: "utf8", timeout: 60000 })); }
  catch (e) { out = toText(e && e.stdout) + toText(e && e.stderr); }
  expect("guard.js check 能给出结论", out.indexOf("[guard]") >= 0, "没有 [guard] 输出");
  var violations = parseGuardViolations(out);
  var said = /\[guard\] 发现 (\d+) 处越界/.exec(out);
  if (said) expect("guard 报的条数与解析出的清单一致", toNumber(said[1], -1) === violations.length, "报 " + said[1] + " 条，解析出 " + violations.length + " 条");
  else pass("guard 直接报通过（0 处越界）");
  var mine = [], others = [];
  for (var j = 0; j < violations.length; j++) {
    var entry = violations[j].file + " -> " + violations[j].rule;
    if (files.indexOf(violations[j].file) >= 0) mine.push(entry); else others.push(entry);
  }
  expect("越界清单里没有本次交付的文件（" + files.length + " 个）", mine.length === 0, mine.join(" | "));
  if (others.length > 0) note("guard 还报了 " + others.length + " 处既有越界（不在 P0 范围内，未处理）", others.join(" | "));
  return out;
}

// 写报告到 logs/p0-selftest-YYYYMMDD-HHMMSS.txt，返回路径。
function writeReport(status, guardOut) {
  var selfLines = 0;
  try { selfLines = fs.readFileSync(__filename, "utf8").split("\n").length; } catch (e) { selfLines = 0; }
  var lines = [];
  lines.push("MineBots P0 自检报告 / self-test report");
  lines.push("时间 / time    : " + new Date().toISOString());
  lines.push("Node           : " + process.version);
  lines.push("结果 / result  : " + status);
  lines.push("通过 / pass    : " + passCount);
  lines.push("失败 / fail    : " + failCount);
  lines.push("模块 / modules : " + MODULE_FILES.join(", "));
  lines.push("本文件 / self  : " + SELF_FILE + "（" + selfLines + " 行，上限 " + MAX_LINES + "）");
  lines.push("");
  lines.push("明细 / details");
  for (var i = 0; i < journal.length; i++) lines.push(journal[i]);
  lines.push("", "guard.js check 原始输出 / raw output");
  lines.push(toText(guardOut));
  var dir = path.join(ROOT, "logs"), outPath = path.join(dir, "p0-selftest-" + stamp() + ".txt");
  var ok = true, msg = "";
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir); fs.writeFileSync(outPath, lines.join("\n"), "utf8"); }
  catch (e) { ok = false; msg = getErrText(e); }
  expect("自检报告已写出 / report written", ok, msg + " " + outPath);
  return outPath;
}
// 主流程：环境 → 静态 → 解析 → 解析器续 → 意图 → 聊天 → 执行器 → 执行器续 → 队列 → guard → 报告 → 汇总。
async function main() {
  process.env.MINEBOTS_CHAT_AUTH = "off"; process.env.MINEBOTS_TYPING = "off"; process.env[MOTION_ENV] = "5"; section("0. 环境 / env"); var keepAlive = setInterval(function () { return null; }, 500); // 单测统一关掉权限拦截 / 打字机分段，并把缓转步长调小；keepAlive 防止事件循环中途抽空导致跑一半就退出
  expect("Node 版本 >= 14（支持 async / await）", parseInt(process.versions.node, 10) >= 14, process.version);
  checkStatic();
  checkParser();
  checkParserMore();
  checkIntent();
  await checkChat();
  await checkExecutor();
  await checkExecutorMore();
  await checkQueue();
  await require("./selftest-managers").run({ section: section, expect: expect, expectEqual: expectEqual, makeBot: makeBot, makeBlock: makeBlock, makeEntity: makeEntity, wait: wait });
  await require("./selftest-preempt").run({ section: section, expect: expect, makeBot: makeBot, makeBlock: makeBlock, makeEntity: makeEntity, wait: wait });
  await require("./selftest-p1").run({ section: section, expect: expect, expectEqual: expectEqual, makeBot: makeBot, makeBlock: makeBlock, makeEntity: makeEntity, wait: wait }); await require("./selftest-p2").run({ section: section, expect: expect, expectEqual: expectEqual, makeBot: makeBot, makeBlock: makeBlock, makeEntity: makeEntity, wait: wait }); await require("./selftest-p3").run({ section: section, expect: expect, expectEqual: expectEqual, makeBot: makeBot, makeBlock: makeBlock, makeEntity: makeEntity, wait: wait, note: note }); await require("./selftest-p4").run({ section: section, expect: expect, makeBot: makeBot, makeBlock: makeBlock, makeEntity: makeEntity, wait: wait });
  var guardOut = checkGuard();
  var outPath = writeReport(failCount === 0 ? "PASS" : "FAIL", guardOut);
  section("11. 汇总 / summary");
  console.log("通过 / pass  : " + passCount);
  console.log("失败 / fail  : " + failCount);
  console.log("报告 / report: " + outPath);
  console.log(failCount === 0 ? "[PASS] P0 自检全绿 / all green" : "[FAIL] P0 自检有失败项，见报告 / see report");
  if (failCount > 0) process.exitCode = 1; clearInterval(keepAlive);
}
main().catch(function (err) {
  console.log("[FAIL] 自检自身崩了 / selftest crashed: " + getErrText(err));
  process.exitCode = 1;
});
