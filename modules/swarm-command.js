// ========================================
// 文件：modules/swarm-command.js
// 功能：状态机 3.0 命令化——把「#goal / #bid / #build …」文本解析成蜂群指令，分派到三层状态机、黑板生态与建筑蜂群
// 依赖：./state-runtime、./shared-board、./replan、./antiafk、./builder-blueprint、./builder-swarm、
//       ./builder-ai-tools、./builder-scaffold、./prefs（都可选）、./event-bus、./logger
// 导出：parse / handle / execute / run / isSwarm / list / resolve / COMMANDS / PREFIX
// 作者：MineBots
// ========================================
//
// 三层分工 / three layers
//   #goal / #tick / #status / #hurt / #nodes / #queue / #replan → 战略层 + 战术层 + 看门狗
//   #demand / #supply / #match / #bigtask / #bid / #auction / #claim / #deliver → 黑板任务池与物资循环
//   #reflex / #inventory / #reset / #help → 反射层与控制台辅助
// 「接线而非重写」：本文件不碰既有动作执行器；command-handler.js 只加一行分派，识别 swarm_ 前缀。
// CommonJS，ES5 风格，无中文变量名；所有外部调用包 try/catch，异常一律降级为 ok:false，绝不抛到顶层。
var runtime = null;
try { runtime = require("./state-runtime"); } catch (e) { runtime = null; }

var board = null;
try { board = require("./shared-board"); } catch (e) { board = null; }

var replan = null;
try { replan = require("./replan"); } catch (e) { replan = null; }

var reflex = null;
try { reflex = require("./antiafk"); } catch (e) { reflex = null; }

var bus = null;
try { bus = require("./event-bus"); } catch (e) { bus = null; }

var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
// 可选依赖：建筑生态（蓝图 / 蜂群 / AI 工具 / 脚手架 / 精确开关），缺失时建筑命令统一回 ok:false。
var builderBlueprint = null; try { builderBlueprint = require("./builder-blueprint"); } catch (e) { builderBlueprint = null; }
var builderSwarm = null; try { builderSwarm = require("./builder-swarm"); } catch (e) { builderSwarm = null; }
var builderAi = null; try { builderAi = require("./builder-ai-tools"); } catch (e) { builderAi = null; }
var builderScaffold = null; try { builderScaffold = require("./builder-scaffold"); } catch (e) { builderScaffold = null; }
var prefs = null; try { prefs = require("./prefs"); } catch (e) { prefs = null; }

// 常量：命令前缀（GUI 控制台 / 聊天框都认）与动作名前缀（command-handler 只认这个）。
var PREFIX = "swarm_";
// 常量：短别名，只用于文本解析，不参与 isSwarm 判定，避免误拦既有动作。
var ALIAS = {
  g: "goal", t: "tick", h: "hurt", s: "status", q: "queue",
  d: "demand", sup: "supply", m: "match", big: "bigtask", b: "bid",
  a: "auction", inv: "inventory", c: "claim", deliver: "deliver",
  eco: "ecosystem", rp: "replan", rx: "reflex", n: "nodes", r: "reset", "?": "help",
  bp: "blueprint", bd: "build", br: "builder", lg: "logistics", ga: "gather",
  cy: "cycle", sc: "scaffold", pt: "posts", ex: "exact", an: "analyze", po: "post",
  ch: "channel"
};
// 常量：命令清单（控制台与 #help 用）；usage / desc 一律中英双语。
var COMMANDS = [
  { name: "goal", usage: "goal <目标 / objective>", desc: "战略层下达宏观目标 / assign strategic goal" },
  { name: "tick", usage: "tick", desc: "推进一个战术 tick / run one tactical tick" },
  { name: "hurt", usage: "hurt [source=怪物 / mob]", desc: "受击打断并恢复进度 / interrupt & resume" },
  { name: "status", usage: "status", desc: "三层状态快照 / three-layer snapshot" },
  { name: "nodes", usage: "nodes <a,b,c / 动作名>", desc: "动态插入执行节点 / insert dynamic nodes" },
  { name: "queue", usage: "queue", desc: "取出动态执行队列 / drain dynamic queue" },
  { name: "replan", usage: "replan", desc: "看门狗兜底重规划（离线降级）/ offline replan fallback" },
  { name: "demand", usage: "demand <wood:32,stone:16>", desc: "发布物资需求 / post demand" },
  { name: "supply", usage: "supply <iron:10>", desc: "发布物资供给 / post supply" },
  { name: "match", usage: "match", desc: "撮合供需生成搬运单 / match supply & demand" },
  { name: "bigtask", usage: "bigtask [count=50] [block=planks]", desc: "大任务拆单 / split big task" },
  { name: "bid", usage: "bid", desc: "单 bot 竞价抢单 / claim best task" },
  { name: "auction", usage: "auction [botA,botB]", desc: "全蜂群一轮竞价 / run one auction" },
  { name: "inventory", usage: "inventory <cobblestone:64>", desc: "背包满挂单 / list surplus items" },
  { name: "claim", usage: "claim", desc: "抢一个搬运任务 / claim haul task" },
  { name: "deliver", usage: "deliver <taskId> <iron:10>", desc: "物资入库并结单 / deliver to warehouse" },
  { name: "ecosystem", usage: "ecosystem", desc: "生态统计 / ecosystem counters" },
  { name: "reflex", usage: "reflex [action=local_dodge]", desc: "注入一次受击反射 / inject hurt reflex" },
  { name: "reset", usage: "reset", desc: "清空内存状态（不碰磁盘）/ clear in-memory state" },
  { name: "help", usage: "help", desc: "列出全部指令 / list all commands" },
  { name: "blueprint", usage: "blueprint <建筑描述 / prompt>", desc: "生成 JSON 蓝图并拆单入池 / generate blueprint & split tasks" },
  { name: "build", usage: "build <建筑描述 / prompt>", desc: "三层架构一站式开工 / start build in 3 layers" },
  { name: "analyze", usage: "analyze <建筑描述 / prompt>", desc: "蓝图算账：总材料与缺失清单 / material bill & shortage" },
  { name: "builder", usage: "builder [botId]", desc: "建筑 bot 抢一个放置任务 / builder claims one place task" },
  { name: "logistics", usage: "logistics [botId]", desc: "物流 bot 抢单取货送达 / logistics delivers materials" },
  { name: "gather", usage: "gather [botId]", desc: "采集 bot 挖矿 / 砍树补齐 / gatherer refills materials" },
  { name: "cycle", usage: "cycle [botA,botB]", desc: "多 bot 分工跑一轮 / one swarm build cycle" },
  { name: "scaffold", usage: "scaffold <建筑描述 / prompt>", desc: "高处自动搭拆脚手架并回收 / auto scaffold & recycle" },
  { name: "post", usage: "post <内容 / content> [kind=offer]", desc: "公屏发帖求助或接代工 / public help or service post" },
  { name: "posts", usage: "posts", desc: "列出公屏帖子 / list broadcast posts" },
  { name: "exact", usage: "exact [on|off]", desc: "精确建筑开关：噪声归零 / exact build, zero motion noise" },
  { name: "channel", usage: "channel <botId> <频道名 / name>", desc: "给 bot 分配聊天频道 / assign chat channel" }
];
// 常量：建筑类命令名，分派时与三层 / 生态命令分开处理。
var BUILD_COMMANDS = ["blueprint", "build", "analyze", "builder", "logistics", "gather", "cycle",
  "scaffold", "post", "posts", "exact"];

// 安全取错误文本：catch 里绝不会二次抛错。
function errText(err) {
  try { if (err && err.message) return String(err.message); return String(err); }
  catch (e) { return "unknown error / 未知错误"; }
}

// 写文件日志：命令分派属高频信息，只落文件不刷 GUI。
function logInfo(msg) {
  try { if (logger && typeof logger.info === "function") logger.info("[swarm-command] " + msg); } catch (e) { /* ignore */ }
}

// 写系统日志：目标下达 / 竞价这类低频事件推 GUI。
function logSystem(msg) {
  try {
    if (logger && typeof logger.system === "function") { logger.system("[swarm-command] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[swarm-command] " + msg); } catch (e2) { /* ignore */ }
}

// 广播命令事件：总线缺失时静默跳过。
function emit(name, payload) {
  try { if (bus && typeof bus.emit === "function") bus.emit(name, payload); } catch (e) { /* ignore */ }
}

// 规范化 botId：坏值退回 default。
function idOf(botId) {
  try {
    var text = String(botId === null || botId === undefined ? "" : botId).replace(/^\s+|\s+$/g, "");
    return text.length === 0 ? "default" : text.slice(0, 80);
  } catch (e) { return "default"; }
}

// 安全转字符串：null / undefined 统一成空串。
function toText(value) {
  try { return value === null || value === undefined ? "" : String(value); } catch (e) { return ""; }
}

// 取一个已登记的命令定义，找不到返回 null。
function findCommand(name) {
  try {
    for (var i = 0; i < COMMANDS.length; i++) if (COMMANDS[i].name === name) return COMMANDS[i];
  } catch (e) { return null; }
  return null;
}

// 判断动作名是不是蜂群命令：只认 swarm_ 前缀，避免拦截既有 stop / move 等动作。
function isSwarm(name) {
  try { return toText(name).toLowerCase().indexOf(PREFIX) === 0; } catch (e) { return false; }
}

// 解析命令名：去 # / swarm_ 前缀，套短别名；返回标准名或空串。
function resolve(name) {
  try {
    var text = toText(name).toLowerCase().replace(/^\s+|\s+$/g, "");
    if (text.charAt(0) === "#") text = text.slice(1);
    if (text.indexOf(PREFIX) === 0) text = text.slice(PREFIX.length);
    if (ALIAS[text]) text = ALIAS[text];
    return findCommand(text) ? text : "";
  } catch (e) { return ""; }
}

// 把 key=value 参数收成对象；没有等号的参数留在外面。
function optionsOf(tokens) {
  var opts = {}, rest = [];
  try {
    for (var i = 0; i < tokens.length; i++) {
      var one = toText(tokens[i]);
      var at = one.indexOf("=");
      if (at > 0) opts[one.slice(0, at)] = one.slice(at + 1);
      else rest.push(one);
    }
  } catch (e) { return { opts: {}, rest: [] }; }
  return { opts: opts, rest: rest };
}

// 解析一条命令文本：返回 { ok, name, args, raw, options, text }，不可识别时 ok:false。
function parse(text) {
  var out = { ok: false, name: "", args: [], raw: "", options: {}, text: toText(text), message: "" };
  try {
    var clean = out.text.replace(/^\s+|\s+$/g, "");
    if (clean.length === 0) { out.message = "指令为空 / empty command"; return out; }
    var tokens = clean.split(/\s+/);
    var head = tokens.shift();
    var name = resolve(head);
    if (!name) { out.message = "不认识的指令 / unknown command: " + head; return out; }
    var parsed = optionsOf(tokens);
    out.ok = true;
    out.name = name;
    out.args = parsed.rest;
    out.options = parsed.opts;
    out.raw = parsed.rest.join(" ");
    out.message = "command parsed / 指令已解析";
  } catch (e) { out.message = errText(e); }
  return out;
}

// 解析物资串：支持 "wood:32,stone:16"、"wood 32"、"iron=10"；坏值返回空对象。
function parseItems(text) {
  var out = {};
  try {
    var clean = toText(text).replace(/[,，]/g, " ").replace(/[:=]/g, " ").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
    if (clean.length === 0) return out;
    var parts = clean.split(" ");
    for (var i = 0; i < parts.length; i += 2) {
      var key = String(parts[i] || "").replace(/[^a-zA-Z0-9_]/g, "");
      var num = parseInt(parts[i + 1], 10);
      if (!key || isNaN(num) || num <= 0) continue;
      out[key] = (out[key] || 0) + num;
    }
  } catch (e) { return {}; }
  return out;
}

// 解析坐标串："1,64,2" / "1 64 2"；坏值返回原点。
function parsePosition(text) {
  var out = { x: 0, y: 64, z: 0 };
  try {
    var nums = toText(text).replace(/[,，]/g, " ").split(/\s+/);
    if (nums.length >= 3) {
      out.x = Number(nums[0]) || 0; out.y = Number(nums[1]) || 64; out.z = Number(nums[2]) || 0;
    }
  } catch (e) { return { x: 0, y: 64, z: 0 }; }
  return out;
}

// 统一构造命令结果：所有分派都回 { ok, command, message, data }。
function result(name, ok, message, data) {
  return { ok: ok === true, command: name, action: PREFIX + name, message: String(message || ""), data: data || null };
}

// 聚合三层状态：运行时 / 生态 / 反射 / 看门狗，任一模块缺失只留空对象。
function collectStatus(botId) {
  var out = { ok: true, botId: botId, strategic: null, tactical: null, reflex: null, watchdog: null, market: null };
  try { if (runtime && typeof runtime.status === "function") { var st = runtime.status(botId); out.strategic = st; out.tactical = st ? st.tree : null; } } catch (e1) { /* 单个模块失败不影响其它 */ }
  try { if (board && typeof board.ecosystem === "function") out.market = board.ecosystem(); } catch (e2) { /* ignore */ }
  try { if (reflex && typeof reflex.stats === "function") out.reflex = reflex.stats(botId); } catch (e3) { /* ignore */ }
  try { if (replan && typeof replan.stats === "function") out.watchdog = replan.stats(botId); } catch (e4) { /* ignore */ }
  return out;
}

// 分派聊天频道指令：#channel bot-1 team_red，或 #channel bot=bot-1 name=team_red；返回频道表。
function dispatchChannel(name, p, parsed) {
  var cc = null;
  try { cc = require("./chat-channel"); } catch (eCc) { cc = null; }
  if (!cc || typeof cc.assign !== "function") {
    return result(name, false, "频道模块未加载 / chat-channel unavailable", null);
  }
  try {
    var args = Array.isArray(parsed.args) ? parsed.args : [];
    var opts = parsed.options && typeof parsed.options === "object" ? parsed.options : {};
    var botId = toText(opts.bot || opts.botId || args[0]);
    var channel = toText(opts.name || opts.channel || args[1]);
    if (botId.length === 0 || channel.length === 0) {
      return result(name, false, "用法 / usage: #channel <botId> <频道名 / name>", { channels: cc.format() });
    }
    var hit = cc.assign(botId, channel, {});
    return result(name, hit.ok, hit.message, { botId: hit.botId, channel: hit.channel, channels: cc.format() });
  } catch (e) { return result(name, false, "频道分配失败 / channel assign failed: " + errText(e), null); }
}

// 分派到三层状态机：goal / tick / hurt / status / nodes / queue / replan；返回 Promise<result>。
async function dispatchState(name, p, parsed) {
  if (!runtime) return result(name, false, "state-runtime 未加载 / state-runtime unavailable");
  try {
    if (name === "goal") {
      if (parsed.raw.length === 0) return result(name, false, "目标不能为空 / objective required");
      var hit = runtime.assignGoal(p.botId, parsed.raw, { executor: p.executor || null });
      if (hit.ok) logSystem("控制台下达目标 / console goal: " + p.botId + " -> " + parsed.raw);
      return result(name, hit.ok, hit.message, hit);
    }
    if (name === "tick") {
      var ticked = await runtime.tick(p.botId, { botId: p.botId }, { offline: true });
      return result(name, ticked.ok, ticked.message, ticked);
    }
    if (name === "hurt") {
      var hurt = await runtime.onHurt(p.botId, { source: parsed.options.source || "console" }, { botId: p.botId });
      return result(name, hurt.ok, hurt.message, hurt);
    }
    if (name === "status") return result(name, true, "状态已读取 / status collected", collectStatus(p.botId));
    if (name === "nodes") {
      var names = parsed.raw.replace(/[,，]/g, " ").split(/\s+/);
      var nodes = [];
      for (var i = 0; i < names.length; i++) {
        if (!names[i]) continue;
        nodes.push({ id: "cmd-" + i, action: names[i], args: {}, source: "console" });
      }
      if (nodes.length === 0) return result(name, false, "节点名为空 / node names required");
      return result(name, true, "节点已插入 / nodes inserted", runtime.insertNodes(p.botId, nodes));
    }
    if (name === "queue") return result(name, true, "队列已取出 / queue drained", runtime.drainQueue(p.botId));
    if (name === "replan") {
      if (!replan) return result(name, false, "replan 未加载 / replan unavailable");
      var rep = await replan.aiReplan(p.botId, { current_action: parsed.raw || "console", error: "manual replan / 手动重规划", botId: p.botId }, { offline: true });
      return result(name, rep.ok, rep.message, rep);
    }
  } catch (e) { return result(name, false, errText(e)); }
  return result(name, false, "不支持的状态命令 / unsupported state command");
}

// 分派到黑板生态：挂单 / 撮合 / 拆单 / 竞价 / 搬运 / 入库；返回 result。
function dispatchMarket(name, p, parsed) {
  if (!board) return result(name, false, "shared-board 未加载 / shared-board unavailable");
  try {
    var items = parseItems(parsed.raw);
    var pos = parsePosition(parsed.options.position || parsed.options.pos || "");
    var one = null;
    if (name === "demand") one = board.postDemand(p.botId, items);
    else if (name === "supply") one = board.postSupply(p.botId, items, pos);
    else if (name === "match") one = board.matchSupply();
    else if (name === "bigtask") one = board.postBigTask({ count: parsed.options.count || 50, block: parsed.options.block || "planks", position: pos });
    else if (name === "bid") one = board.bid(p.botId, { position: pos, load: 0, status: "idle" });
    else if (name === "auction") {
      var names = parsed.raw.replace(/[,，]/g, " ").split(/\s+/);
      var bots = [];
      for (var i = 0; i < names.length; i++) {
        if (names[i]) bots.push({ botId: names[i], position: pos, load: 0, status: "idle" });
      }
      if (bots.length === 0) bots.push({ botId: p.botId, position: pos, load: 0, status: "idle" });
      one = board.runAuction(bots);
    } else if (name === "inventory") one = board.onInventoryFull(p.botId, items, pos);
    else if (name === "claim") one = board.claimHaul(p.botId, { position: pos });
    else if (name === "deliver") one = board.deliver(p.botId, parsed.args[0] || parsed.options.task || "", items);
    else if (name === "ecosystem") one = board.ecosystem();
    if (!one) return result(name, false, "不支持的生态命令 / unsupported market command");
    var ok = one.ok !== false;
    return result(name, ok, one.message || (ok ? "已执行 / executed" : "执行失败 / failed"), one);
  } catch (e) { return result(name, false, errText(e)); }
}

// 判断是不是建筑类命令；坏值返回 false。
function isBuildCommand(name) {
  try { return BUILD_COMMANDS.indexOf(toText(name)) >= 0; } catch (e) { return false; }
}

// 从文本描述生成一个蓝图对象：优先 AI 工具生成器（离线模板），坏文本返回 null，绝不抛错。
function blueprintFromText(text) {
  try {
    if (!builderAi || typeof builderAi.generateBlueprint !== "function") return null;
    var made = builderAi.generateBlueprint(toText(text) || "platform");
    return made && made.ok && made.blueprint ? made.blueprint : null;
  } catch (e) { return null; }
}

// 分派建筑生态命令：蓝图 / 开工 / 算账 / 三种战术 tick / 脚手架 / 发帖 / 精确开关；返回 result。
function dispatchBuild(name, p, parsed) {
  var raw = parsed.raw || "";
  try {
    if (name === "exact") {
      if (!prefs || typeof prefs.save !== "function") return result(name, false, "prefs unavailable / 偏好模块不可用");
      var on = toText(parsed.options.on || raw).toLowerCase() !== "off" && toText(parsed.options.on || raw).toLowerCase() !== "false";
      if (toText(parsed.options.on || raw).length === 0) on = true;
      var saved = prefs.save({ engExactBuild: on });
      return result(name, !!(saved && saved.ok), on ? "精确建筑已开启：噪声归零 / exact build ON, noise zero" : "精确建筑已关闭 / exact build OFF",
        { engExactBuild: on, prefs: saved && saved.prefs ? saved.prefs : null });
    }
    if (name === "posts") {
      if (!builderSwarm || typeof builderSwarm.posts !== "function") return result(name, false, "builder-swarm unavailable / 建筑蜂群不可用");
      var list = builderSwarm.posts();
      return result(name, true, "帖子已列出 / posts listed", { count: list.length, posts: list });
    }
    if (name === "post") {
      if (!builderSwarm || typeof builderSwarm.post !== "function") return result(name, false, "builder-swarm unavailable / 建筑蜂群不可用");
      if (raw.length === 0) return result(name, false, "帖子内容不能为空 / content required");
      var posted = builderSwarm.post(p.botId, raw, { kind: parsed.options.kind || "help" });
      return result(name, posted.ok, posted.message, posted);
    }
    if (name === "builder" || name === "logistics" || name === "gather" || name === "cycle") {
      if (!builderSwarm) return result(name, false, "builder-swarm unavailable / 建筑蜂群不可用");
      var bots = raw.replace(/[,，]/g, " ").split(/\s+/);
      var clean = [];
      for (var bi = 0; bi < bots.length; bi++) if (bots[bi]) clean.push(bots[bi]);
      if (clean.length === 0) clean.push(p.botId);
      var hit = null;
      if (name === "builder") hit = builderSwarm.builderTick(clean[0], null, {});
      else if (name === "logistics") hit = builderSwarm.logisticsTick(clean[0], {});
      else if (name === "gather") hit = builderSwarm.gatherTick(clean[0], {});
      else hit = builderSwarm.runCycle({ builders: clean, logistics: [clean[0] + "-haul"], gatherers: [clean[0] + "-dig"] }, {});
      return result(name, hit.ok !== false, hit.message || "已执行 / executed", hit);
    }
    var bp = blueprintFromText(raw);
    if (!bp) return result(name, false, "blueprint generation unavailable / 蓝图生成不可用");
    if (name === "analyze") {
      if (!builderBlueprint) return result(name, false, "builder-blueprint unavailable / 蓝图模块不可用");
      var bill = builderBlueprint.analyzeBlueprint(bp, null);
      return result(name, bill.ok, bill.message, { name: bp.name, blocks: bp.blocks.length, total: bill.total, missing: bill.missing, missingCount: bill.missingCount });
    }
    if (name === "blueprint") {
      if (!builderBlueprint) return result(name, false, "builder-blueprint unavailable / 蓝图模块不可用");
      var split = builderBlueprint.splitBlueprintToTasks(bp, { board: board });
      return result(name, split.ok, split.message, { name: bp.name, blocks: bp.blocks.length, count: split.count, jobId: split.jobId, taskIds: split.taskIds });
    }
    if (name === "build") {
      if (!builderSwarm) return result(name, false, "builder-swarm unavailable / 建筑蜂群不可用");
      var started = builderSwarm.startBuild(bp, { board: board, botId: p.botId });
      return result(name, started.ok, started.message, { jobId: started.jobId, split: started.split, goal: started.goal, shortage: started.shortage });
    }
    if (name === "scaffold") {
      if (!builderScaffold || typeof builderScaffold.run !== "function") return result(name, false, "builder-scaffold unavailable / 脚手架模块不可用");
      var sc = builderScaffold.run(bp, { board: board, maxReach: parsed.options.reach || 3 });
      return result(name, sc.ok, sc.message, { needed: sc.plan ? sc.plan.needed : 0, queued: sc.build ? sc.build.count : 0, recyclePending: sc.recycle ? sc.recycle.pending : 0 });
    }
  } catch (e) { return result(name, false, errText(e)); }
  return result(name, false, "不支持的建筑命令 / unsupported build command");
}

// 清空内存状态：只影响本次进程，不删除 state/ 下的持久化文件。
function dispatchReset(p) {
  try {
    if (runtime && typeof runtime.reset === "function") runtime.reset(p.botId);
    if (replan && typeof replan.reset === "function") replan.reset();
    if (reflex && typeof reflex.reset === "function") reflex.reset();
  } catch (e) { return result("reset", false, errText(e)); }
  return result("reset", true, "内存状态已重置 / in-memory state reset", { botId: p.botId });
}

// 执行一条已解析命令：p = { botId, executor }；返回 Promise<result>，绝不抛到顶层。
async function execute(name, payload) {
  var p = payload && typeof payload === "object" ? payload : {};
  p.botId = idOf(p.botId);
  var parsed = p.parsed && typeof p.parsed === "object" ? p.parsed : { raw: toText(p.args), args: [], options: {} };
  var out = null;
  try {
    if (name === "help") out = result(name, true, "指令清单 / command list", list());
    else if (name === "channel") out = dispatchChannel(name, p, parsed);
    else if (name === "reset") out = dispatchReset(p);
    else if (name === "reflex") {
      if (!reflex) out = result(name, false, "antiafk 未加载 / antiafk unavailable");
      else {
        var fired = reflex.simulateHurt(p.botId, { action: parsed.options.action || "", source: "console" });
        out = result(name, fired.ok, fired.message, fired);
      }
    } else if (name === "goal" || name === "tick" || name === "hurt" || name === "status" ||
               name === "nodes" || name === "queue" || name === "replan") {
      out = await dispatchState(name, p, parsed);
    } else if (isBuildCommand(name)) {
      out = dispatchBuild(name, p, parsed);
    } else {
      out = dispatchMarket(name, p, parsed);
    }
    emit("swarm.command", { botId: p.botId, command: name, ok: out.ok });
    logInfo("命令执行 / command executed: " + p.botId + " " + name + " ok=" + out.ok);
    return out;
  } catch (e) {
    return result(name, false, "命令异常 / command error: " + errText(e));
  }
}

// 解析并执行一整条文本："#goal 挖矿" / "swarm_bid"；返回 Promise<result>。
async function handle(text, payload) {
  var parsed = parse(text);
  if (!parsed.ok) return result("", false, parsed.message, parsed);
  var p = payload && typeof payload === "object" ? payload : {};
  p.parsed = parsed;
  var out = await execute(parsed.name, p);
  out.text = parsed.text;
  out.parsed = parsed;
  return out;
}

// command-handler 专用入口：把 execute 的结构压成 { ok, action, error, message, data }。
async function run(name, bot, config) {
  var cfg = config && typeof config === "object" ? config : {};
  var clean = resolve(name);
  if (!clean) return { ok: false, action: toText(name), error: "不认识的蜂群指令 / unknown swarm command", message: "" };
  var botId = idOf(cfg.botId || (bot && (bot._mbBotId || bot.username)) || "");
  var out = await execute(clean, { botId: botId, args: cfg.text || cfg.raw || "", executor: cfg.executor || null });
  return { ok: out.ok, action: toText(name) || out.action, error: out.ok ? null : out.message, message: out.message, data: out.data };
}

// 返回命令清单副本（控制台渲染 / 自测用）。
function list() {
  var out = [];
  try {
    for (var i = 0; i < COMMANDS.length; i++) {
      out.push({ name: COMMANDS[i].name, usage: "#" + COMMANDS[i].usage, desc: COMMANDS[i].desc });
    }
  } catch (e) { return []; }
  return out;
}

// 对外导出：解析 / 执行 / 兼容 command-handler 的 run / 清单。
module.exports = {
  parse: parse,
  handle: handle,
  execute: execute,
  run: run,
  isSwarm: isSwarm,
  list: list,
  resolve: resolve,
  parseItems: parseItems,
  collectStatus: collectStatus,
  COMMANDS: COMMANDS,
  PREFIX: PREFIX
};
