// ========================================
// 文件：scripts/selftest-p14a.js
// 功能：P14 模块3 回归自测——聊天频道隔离：共享黑板 channels / 指令分配频道 /
//       同频道私聊互通、异频道听不到 / 频道人数上限 / swarm 私聊按频道过滤
// 依赖：path、fs、os；被测模块 chat-channel、shared-board、swarm（可选，缺了记失败而不崩）
// 导出：run（由 selftest-p5.js 调用）
// 作者：MineBots
// ========================================
// 说明：全程离线，bot / 玩家全是内存假实现；落盘经 MINEBOTS_STATE_DIR 重定向，
//   收尾删除临时目录并还原环境变量，真实 state/ 不受影响。
var path = require("path");
var fs = require("fs");
var os = require("os");
var ROOT = path.join(__dirname, "..");
var TEMP_DIR = path.join(os.tmpdir(), "minebots-p14a-" + process.pid);

function load(rel) {
  try { return require(path.join(ROOT, rel)); } catch (e) { return null; }
}
function readRel(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch (e) { return ""; }
}
function safeRemove(dir) {
  try {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir).forEach(function (n) {
      var p = path.join(dir, n);
      try { if (fs.lstatSync(p).isDirectory()) safeRemove(p); else fs.unlinkSync(p); } catch (e) { /* ignore */ }
    });
    fs.rmdirSync(dir);
  } catch (e) { /* ignore */ }
}
function fresh() {
  try {
    if (fs.existsSync(TEMP_DIR)) safeRemove(TEMP_DIR);
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    process.env.MINEBOTS_STATE_DIR = TEMP_DIR;
  } catch (e) { /* ignore */ }
  var board = load("modules/shared-board");
  if (board && typeof board.load === "function") board.load();
  var ch = load("modules/chat-channel");
  if (ch && typeof ch.reset === "function") ch.reset();
  var swarm = load("modules/swarm");
  if (swarm && typeof swarm.reset === "function") swarm.reset();
}

// 静态红线：chat-channel 不超 600 行、文件头注释、禁用语法。
function checkStatic(h) {
  h.section("30a. 聊天频道静态红线 / static");
  var text = readRel("modules/chat-channel.js");
  var banned = [/\?\./, /\?\?/, /^import\s+/m, /^export\s+/m, /\bconst\b/, /\blet\b/, /=>/, /\x60/];
  var ok = text.indexOf("// ====") === 0 && text.split("\n").length <= 600;
  for (var j = 0; j < banned.length; j++) if (banned[j].test(text)) ok = false;
  h.expect("chat-channel.js 满足头注释 / 600 行 / 禁用语法", ok, "");
  var con = readRel("modules/swarm-console.js");
  h.expect("真实启动链路挂了频道模块", con.indexOf("chat-channel") > 0, "");
  var sw = readRel("modules/swarm.js");
  h.expect("私聊按频道过滤（异频道听不到）", sw.indexOf("canHear") > 0, "");
}

// 指令解析与频道分配：set bot-1 channel=team_red 等形态。
function checkAssign(h) {
  h.section("30b. 频道指令解析与分配 / assign");
  fresh();
  var ch = load("modules/chat-channel");
  if (!ch) { h.expect("chat-channel 可加载", false, "null"); return; }
  var cases = [
    ["set bot-1 channel=team_red", "bot-1", "team_red"],
    ["set channel=team_blue bot-2", "bot-2", "team_blue"],
    ["channel bot-3 team_red", "bot-3", "team_red"],
    ["#channel bot-4 team_red", "bot-4", "team_red"]
  ];
  var allOk = true;
  for (var i = 0; i < cases.length; i++) {
    var parsed = ch.parseCommand(cases[i][0]);
    var good = parsed && parsed.matched === true && parsed.botId === cases[i][1] && parsed.channel === cases[i][2];
    if (!good) allOk = false;
  }
  h.expect("四种频道分配指令都能解析出 botId 与频道名", allOk, "");
  var r1 = ch.handleCommand("set bot-1 channel=team_red", {});
  h.expect("handleCommand 分配频道成功并落黑板", r1.ok === true && ch.channelOf("bot-1") === "team_red", JSON.stringify(r1));
  var board = load("modules/shared-board");
  var channels = board && board.get ? board.get("channels", {}) : {};
  h.expect("共享黑板写入 channels 映射（频道名→bot 列表）", channels && Array.isArray(channels["team_red"]) && channels["team_red"].indexOf("bot-1") >= 0, JSON.stringify(channels));
  ch.assign("bot-2", "team_blue", {});
  h.expect("table 同时含两个频道", Object.keys(ch.table()).length === 2, JSON.stringify(ch.table()));
}

// 频道互通隔离：同频道私聊能收到，异频道收不到；人数上限。
function checkIsolation(h) {
  h.section("30c. 频道互通隔离 / isolation");
  fresh();
  var ch = load("modules/chat-channel");
  if (!ch) { h.expect("chat-channel 可加载", false, "null"); return; }
  ch.assign("bot-1", "team_red", {});
  ch.assign("bot-2", "team_red", {});
  ch.assign("bot-3", "team_blue", {});
  var h12 = ch.canHear("bot-1", "bot-2");
  var h13 = ch.canHear("bot-1", "bot-3");
  h.expect("同频道 bot 之间可互通", h12.allowed === true, JSON.stringify(h12));
  h.expect("异频道 bot 之间互相听不到", h13.allowed === false, JSON.stringify(h13));
  var board = load("modules/shared-board");
  ch.send("bot-1", "集合 / rally", {});
  var inbox2 = board ? board.inbox("bot-2") : [];
  var inbox3 = board ? board.inbox("bot-3") : [];
  h.expect("同频道 bot-2 收到私聊", inbox2.length > 0, JSON.stringify(inbox2));
  h.expect("异频道 bot-3 收不到私聊", inbox3.length === 0, JSON.stringify(inbox3));
  // 人数上限：灌满后拒绝新成员。
  for (var i = 0; i < 8; i++) ch.assign("fill-" + i, "full_room", { maxMembers: 5 });
  var over = ch.assign("overflow", "full_room", { maxMembers: 5 });
  h.expect("频道超出人数上限时被拒绝", over.ok === false && over.message.indexOf("full") >= 0, JSON.stringify(over));
}

// swarm 私聊按频道过滤：异频道 whisper 不应送达。
function checkSwarm(h) {
  h.section("30d. swarm 私聊按频道过滤 / swarm whisper");
  fresh();
  var ch = load("modules/chat-channel");
  var swarm = load("modules/swarm");
  if (!ch || !swarm) { h.expect("chat-channel / swarm 可加载", false, "null"); return; }
  ch.assign("a", "red", {});
  ch.assign("b", "red", {});
  ch.assign("c", "blue", {});
  var aBot = { last: null, chat: function (t) { aBot.last = t; } };
  var bBot = { last: null, chat: function (t) { bBot.last = t; } };
  var cBot = { last: null, chat: function (t) { cBot.last = t; } };
  swarm.register("a", aBot);
  swarm.register("b", bBot);
  swarm.register("c", cBot);
  var w1 = swarm.whisper("a", "b", "同频私聊 red");
  var w2 = swarm.whisper("a", "c", "异频私聊 blue");
  var board = load("modules/shared-board");
  var inB = board && board.inbox ? board.inbox("b") : [];
  var inC = board && board.inbox ? board.inbox("c") : [];
  var bGot = false, cGot = false;
  function textOf(x) { return x && typeof x === "object" && typeof x.text === "string" ? x.text : String(x); }
  for (var k = 0; k < inB.length; k++) if (textOf(inB[k]).indexOf("同频私聊") >= 0) bGot = true;
  for (var m = 0; m < inC.length; m++) if (textOf(inC[m]).indexOf("异频私聊") >= 0) cGot = true;
  h.expect("同频道私聊成功送达，bot b 信箱收到原文", w1.ok === true && w1.delivered === true && bGot === true, JSON.stringify(w1) + " inboxB=" + JSON.stringify(inB));
  h.expect("异频道私聊被频道隔离拦下，bot c 信箱收不到", w2.ok === false && w2.blocked === true && cGot === false, JSON.stringify(w2) + " inboxC=" + JSON.stringify(inC));
}

function run(h) {
  var groups = [checkStatic, checkAssign, checkIsolation, checkSwarm];
  for (var i = 0; i < groups.length; i++) {
    try { groups[i](h); } catch (e) { h.expect("30 组 " + (i + 1) + " 未抛错", false, String(e)); }
  }
  try { if (fs.existsSync(TEMP_DIR)) safeRemove(TEMP_DIR); } catch (e) { /* ignore */ }
}

module.exports = { run: run };
