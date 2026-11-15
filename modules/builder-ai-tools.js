// ========================================
// 文件：modules/builder-ai-tools.js
// 功能：AI 自主编程与社交发帖工具——【AI 编程】实验开关开启后向 AI 工具菜单注入
//       create_blueprint(prompt)（自然语言生成精确 JSON 蓝图并移交建筑任务池）与
//       broadcast_post(content)（缺料求助 / 接代工生意的公屏发帖）；
//       缺料清单可由 ./redstone-supply 自动生成「谁有 10 个中继器，我用钻石换！」式求助帖
// 依赖：./prefs、./json-repair（可选）、./builder-blueprint（可选）、./builder-swarm（可选）、
//       ./redstone-supply（可选）、./event-bus（可选）、./logger（可选）；ai-client 仅在显式 useAI 时才调用（默认全程离线）
// 导出：enabled / definitions / isTool / execute / generateBlueprint / templateBlueprint /
//       broadcastPost / createBlueprint / requestMaterialPost / materialPost / setGenerator / posts / reset / stats / TOOL_NAMES
// 作者：MineBots
// ========================================
//
// 链路 / pipeline
//   prompt →（注入的 AI 生成器 / 内置确定性模板）→ 五级 JSON 修复 → 蓝图解析 → 算账 →
//   拆单压入共享黑板任务池 → 战略层下达建造目标 → 回执给 AI。
//   离线优先：默认走内置模板，不联网；setGenerator() 可注入真 AI 客户端，测试用假生成器验证全链路。
// CommonJS，ES5 风格，无中文变量名；所有外部调用包 try/catch，日志双语。
var prefs = null;
try { prefs = require("./prefs"); } catch (e) { prefs = null; }
var repair = null;
try { repair = require("./json-repair"); } catch (e) { repair = null; }
var blueprints = null;
try { blueprints = require("./builder-blueprint"); } catch (e) { blueprints = null; }
var swarm = null;
try { swarm = require("./builder-swarm"); } catch (e) { swarm = null; }
// 可选依赖：红石 / 建筑材料缺料自动发帖（内部延迟 require 蜂群，不会形成启动循环）。
var supply = null;
try { supply = require("./redstone-supply"); } catch (e) { supply = null; }
var bus = null;
try { bus = require("./event-bus"); } catch (e) { bus = null; }
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：两个工具名 / 单次生成蓝图方块上限 / 注入的 AI 生成器（null 时走内置模板）。
var TOOL_NAMES = ["create_blueprint", "broadcast_post"];
var MAX_PROMPT = 300;
var generator = null;
var counters = { generated: 0, repaired: 0, posted: 0, failed: 0 };

// 写文件日志：工具调用属高频信息，只落文件不刷 GUI。
function logInfo(msg) {
  try { if (logger && typeof logger.info === "function") logger.info("[builder-ai] " + msg); } catch (e) { /* ignore */ }
}
// 写系统日志：AI 生成蓝图 / 发帖属低频事件，推 GUI。
function logSystem(msg) {
  try {
    if (logger && typeof logger.system === "function") { logger.system("[builder-ai] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[builder-ai] " + msg); } catch (e2) { /* ignore */ }
}
// 广播工具事件：总线缺失时静默跳过。
function emit(name, payload) {
  try { if (bus && typeof bus.emit === "function") bus.emit(name, payload); } catch (e) { /* ignore */ }
}
// 安全取错误文本：catch 里绝不会二次抛错。
function errText(err) {
  try { if (err && err.message) return String(err.message); return String(err); }
  catch (e) { return "unknown error / 未知错误"; }
}
// 安全转字符串：null / undefined 统一成空串。
function toText(value) {
  try { return value === null || value === undefined ? "" : String(value); } catch (e) { return ""; }
}
// AI 编程实验性开关：prefs 缺失或读盘失败一律按关闭处理（宁严不松）。
function enabled() {
  try { return !!(prefs && typeof prefs.get === "function" && prefs.get("aiCode") === true); }
  catch (e) { return false; }
}
// 两个 OpenAI 格式工具定义（中英双语描述）；开关关闭时返回空数组。
function definitions() {
  if (!enabled()) return [];
  return [
    { type: "function", function: {
      name: "create_blueprint",
      description: "根据自然语言生成精确 JSON 建筑蓝图并移交建筑任务池 / Generate a precise JSON blueprint from natural language and queue build tasks",
      parameters: { type: "object", properties: {
        prompt: { type: "string", description: "建筑描述，如「造个小木屋」 / build description such as a small wooden house" },
        origin: { type: "string", description: "建造原点坐标 x,y,z，可省略 / optional origin x,y,z" }
      }, required: ["prompt"] }
    } },
    { type: "function", function: {
      name: "broadcast_post",
      description: "在公屏发帖求助或接代工生意；检测到缺红石 / 建筑材料时可只传 missing 对象（如 {\"repeater\":10}），系统自动生成「谁有 10 个中继器，我用钻石换！」式求助帖 / Post a help request; pass missing to auto-compose a material shortage post",
      parameters: { type: "object", properties: {
        content: { type: "string", description: "帖子内容；给 missing 时可留空 / post content, optional when missing is given" },
        missing: { type: "object", description: "缺料清单，如 {\"repeater\":10,\"comparator\":2} / shortage map" },
        kind: { type: "string", description: "help（求助）或 offer（接单）/ help or offer" }
      }, required: ["content"] }
    } }
  ];
}
// 判断工具名是否属于本模块；坏值返回 false。
function isTool(name) {
  try { return TOOL_NAMES.indexOf(toText(name).toLowerCase().trim()) >= 0; } catch (e) { return false; }
}
// 注入 AI 生成器（真 AI 客户端 / 测试假生成器）；传 null 恢复内置模板。
function setGenerator(fn) {
  generator = typeof fn === "function" ? fn : null;
  return { ok: true, injected: generator !== null, message: "generator set / 生成器已设置" };
}
// 内置确定性模板：按关键词生成精确 JSON 蓝图（离线可用，绝不联网），返回 JSON 字符串。
function templateBlueprint(prompt) {
  try {
    var text = toText(prompt).toLowerCase();
    var blocks = [];
    var wall = "oak_planks", floor = "cobblestone", roof = "oak_stairs";
    var x = 0, y = 0, z = 0, i = 0;
    if (text.indexOf("tower") >= 0 || text.indexOf("塔") >= 0) {
      for (y = 0; y < 8; y++) {
        for (x = 0; x < 3; x++) for (z = 0; z < 3; z++) {
          if (x === 1 && z === 1) continue;
          if (x !== 0 && x !== 2 && z !== 0 && z !== 2) continue;
          blocks.push({ x: x, y: y, z: z, block: "stone_bricks", face: "up" });
        }
      }
      return JSON.stringify({ name: "tower", origin: { x: 0, y: 64, z: 0 }, blocks: blocks });
    }
    if (text.indexOf("wall") >= 0 || text.indexOf("墙") >= 0) {
      for (x = 0; x < 8; x++) for (y = 0; y < 3; y++) blocks.push({ x: x, y: y, z: 0, block: "stone", face: "up" });
      return JSON.stringify({ name: "wall", origin: { x: 0, y: 64, z: 0 }, blocks: blocks });
    }
    if (text.indexOf("bridge") >= 0 || text.indexOf("桥") >= 0) {
      for (x = 0; x < 8; x++) { blocks.push({ x: x, y: 0, z: 0, block: wall, face: "up" }); blocks.push({ x: x, y: 0, z: 1, block: wall, face: "up" }); }
      return JSON.stringify({ name: "bridge", origin: { x: 0, y: 64, z: 0 }, blocks: blocks });
    }
    // 默认 / 小木屋：5x4x5，墙留门洞，顶层封屋顶。
    for (x = 0; x < 5; x++) for (z = 0; z < 5; z++) blocks.push({ x: x, y: 0, z: z, block: floor, face: "up" });
    for (y = 1; y <= 3; y++) {
      for (i = 0; i < 5; i++) {
        if (y <= 2 && i === 2) continue; // 正面中间留门
        blocks.push({ x: i, y: y, z: 0, block: wall, face: "up" });
        blocks.push({ x: i, y: y, z: 4, block: wall, face: "up" });
        blocks.push({ x: 0, y: y, z: i, block: wall, face: "up" });
        blocks.push({ x: 4, y: y, z: i, block: wall, face: "up" });
      }
    }
    for (x = 0; x < 5; x++) for (z = 0; z < 5; z++) blocks.push({ x: x, y: 4, z: z, block: roof, face: "up" });
    return JSON.stringify({ name: text.indexOf("house") >= 0 || text.indexOf("屋") >= 0 ? "wooden_house" : "platform",
      origin: { x: 0, y: 64, z: 0 }, blocks: blocks });
  } catch (e) {
    return JSON.stringify({ name: "fallback", origin: { x: 0, y: 64, z: 0 },
      blocks: [{ x: 0, y: 0, z: 0, block: "oak_planks", face: "up" }] });
  }
}
// 从任意 AI 回包里取出蓝图数据：字符串走五级修复，对象直接用；全败返回 null 并降级到模板。
function parseGenerated(raw) {
  try {
    if (raw && typeof raw === "object") return raw;
    var text = toText(raw);
    if (text.length === 0) return null;
    if (repair && typeof repair.safeParseDetailed === "function") {
      var hit = repair.safeParseDetailed(text, null);
      if (hit && hit.ok && !hit.usedFallback) {
        if (hit.level > 1) counters.repaired = counters.repaired + 1;
        return hit.value;
      }
    }
    return JSON.parse(text);
  } catch (e) { return null; }
}
// 生成蓝图：优先注入的 AI 生成器，其次内置模板；返回 { ok, blueprint, source, message }。
function generateBlueprint(prompt, options) {
  var opts = options && typeof options === "object" ? options : {};
  var out = { ok: false, blueprint: null, source: "", message: "blueprint unavailable / 蓝图模块不可用" };
  try {
    if (!blueprints) return out;
    var raw = null;
    if (generator) {
      try { raw = generator(toText(prompt).slice(0, MAX_PROMPT), opts); }
      catch (eGen) { raw = null; logInfo("AI 生成器异常，降级模板 / generator failed, fallback: " + errText(eGen)); }
      out.source = raw === null ? "template" : "ai";
    } else out.source = "template";
    var data = parseGenerated(raw);
    if (!data) { data = parseGenerated(templateBlueprint(prompt)); out.source = out.source + "+template"; }
    if (!data || typeof data !== "object") { counters.failed = counters.failed + 1; return out; }
    var parsed = blueprints.parse(data, { origin: opts.origin });
    if (!parsed.ok || !parsed.blueprint) {
      out.message = parsed.message;
      counters.failed = counters.failed + 1;
      return out;
    }
    out.ok = true;
    out.blueprint = parsed.blueprint;
    out.message = "blueprint generated / 蓝图已生成";
    counters.generated = counters.generated + 1;
    return out;
  } catch (e) {
    out.message = errText(e);
    counters.failed = counters.failed + 1;
    return out;
  }
}
// create_blueprint：生成 → 算账 → 开工（三层架构 + 拆单入池）；返回完整回执。
function createBlueprint(prompt, options) {
  var opts = options && typeof options === "object" ? options : {};
  var out = { ok: false, name: "", blocks: 0, tasks: 0, jobId: "", analysis: null,
    goal: null, source: "", message: "AI coding disabled / AI 编程开关未开启" };
  try {
    if (!enabled()) return out;
    if (toText(prompt).length === 0) { out.message = "prompt required / 缺少建筑描述"; return out; }
    var made = generateBlueprint(prompt, opts);
    if (!made.ok || !made.blueprint) { out.message = made.message; return out; }
    var bp = made.blueprint;
    out.name = bp.name;
    out.blocks = bp.blocks.length;
    out.source = made.source;
    out.analysis = blueprints && typeof blueprints.analyzeBlueprint === "function"
      ? blueprints.analyzeBlueprint(bp, opts.inventory) : null;
    if (swarm && typeof swarm.startBuild === "function") {
      var started = swarm.startBuild(bp, { board: opts.board, botId: opts.botId || "ai-builder",
        inventory: opts.inventory, bot: opts.bot || null });
      out.ok = started.ok === true;
      out.jobId = started.jobId;
      out.tasks = started.split ? started.split.count : 0;
      out.goal = started.goal;
      out.message = started.message;
    } else if (blueprints) {
      var split = blueprints.splitBlueprintToTasks(bp, { board: opts.board });
      out.ok = split.ok; out.jobId = split.jobId; out.tasks = split.count;
      out.message = split.message;
    }
    logSystem("AI 生成蓝图 / AI blueprint: " + out.name + " blocks=" + out.blocks + " tasks=" + out.tasks);
    emit("builder.ai.blueprint", { name: out.name, blocks: out.blocks, tasks: out.tasks, jobId: out.jobId });
    return out;
  } catch (e) {
    out.message = errText(e);
    counters.failed = counters.failed + 1;
    return out;
  }
}
// broadcast_post：公屏发帖（求助 / 接代工）；返回 { ok, postId, post, message }。
function broadcastPost(content, options) {
  var opts = options && typeof options === "object" ? options : {};
  var out = { ok: false, postId: "", post: null, message: "AI coding disabled / AI 编程开关未开启" };
  try {
    if (!enabled()) return out;
    if (!swarm || typeof swarm.post !== "function") { out.message = "swarm unavailable / 蜂群模块不可用"; return out; }
    var hit = swarm.post(opts.botId || "ai", content,
      { kind: opts.kind || "help", board: opts.board, bot: opts.bot || null, jobId: opts.jobId });
    out.ok = hit.ok; out.postId = hit.postId; out.post = hit.post; out.message = hit.message;
    if (hit.ok) counters.posted = counters.posted + 1;
    return out;
  } catch (e) {
    out.message = errText(e);
    return out;
  }
}
// 缺料自动发帖（AI / 蜂群 / 命令共用）：把清单变成中文求助帖并真正发出，不受 aiCode 开关限制。
function requestMaterialPost(missing, options) {
  try {
    if (supply && typeof supply.postForMissing === "function") {
      return supply.postForMissing(missing, options || {});
    }
  } catch (e) { return { ok: false, message: errText(e) }; }
  return { ok: false, message: "redstone supply unavailable / 缺料发帖模块不可用" };
}
// 只生成缺料求助帖文、不发送；供 AI 预览、GUI 与自测使用。
function materialPost(missing, options) {
  try {
    if (supply && typeof supply.composePost === "function") {
      return supply.composePost(missing, options || {});
    }
  } catch (e) { return { ok: false, content: "", message: errText(e) }; }
  return { ok: false, content: "", message: "redstone supply unavailable / 缺料发帖模块不可用" };
}
// 统一工具执行入口：ai-tools.executeTool 在 bot 判空前分派到这里；失败一律回 ok:false，绝不抛错。
function execute(name, args, bot) {
  var tool = toText(name).toLowerCase().trim();
  var body = args && typeof args === "object" ? args : {};
  try {
    if (tool === "create_blueprint") {
      var made = createBlueprint(body.prompt || body.text || body.description,
        { origin: body.origin, botId: body.botId, bot: bot, inventory: body.inventory, board: body.board });
      made.summary = made.ok
        ? "蓝图已生成 / blueprint: " + made.name + " blocks=" + made.blocks + " tasks=" + made.tasks + " job=" + made.jobId
        : "蓝图生成失败 / blueprint failed: " + made.message;
      return made;
    }
    if (tool === "broadcast_post") {
      var content = body.content || body.text;
      // AI 只给缺料清单时，自动生成红石 / 建筑材料求助帖，再走同一条发帖链路。
      if (body.missing && supply && typeof supply.composePost === "function") {
        var made = supply.composePost(body.missing,
          { paymentZh: body.paymentZh, paymentEn: body.paymentEn });
        if (made.ok) content = made.content;
      }
      var hit = broadcastPost(content,
        { kind: body.kind, botId: body.botId, bot: bot, board: body.board });
      hit.missingPost = !!(body.missing && content);
      hit.summary = hit.ok
        ? "已发帖 / posted: " + hit.postId + " " + toText(content).slice(0, 80)
        : "发帖失败 / post failed: " + hit.message;
      return hit;
    }
    return { ok: false, message: "unknown tool / 未知工具: " + tool };
  } catch (e) {
    return { ok: false, message: errText(e) };
  }
}
// 读取帖子列表（副本）；蜂群模块不可用时返回空数组。
function posts() {
  try { return swarm && typeof swarm.posts === "function" ? swarm.posts() : []; }
  catch (e) { return []; }
}
// 状态快照：开关 / 工具 / 累计统计。
function stats() {
  return { ok: true, enabled: enabled(), tools: TOOL_NAMES.slice(0),
    generated: counters.generated, repaired: counters.repaired, posted: counters.posted, failed: counters.failed };
}
// 清空注入生成器与内存计数（不触碰黑板）；供自测隔离。
function reset() {
  try { generator = null; counters = { generated: 0, repaired: 0, posted: 0, failed: 0 }; }
  catch (e) { /* ignore */ }
  return { ok: true, message: "builder ai tools reset / AI 工具状态已重置" };
}

// 对外导出：开关 / 定义 / 执行 / 生成 / 发帖 / 诊断。
module.exports = {
  enabled: enabled,
  definitions: definitions,
  isTool: isTool,
  execute: execute,
  generateBlueprint: generateBlueprint,
  templateBlueprint: templateBlueprint,
  createBlueprint: createBlueprint,
  broadcastPost: broadcastPost,
  requestMaterialPost: requestMaterialPost,
  materialPost: materialPost,
  setGenerator: setGenerator,
  posts: posts,
  stats: stats,
  reset: reset,
  TOOL_NAMES: TOOL_NAMES
};
