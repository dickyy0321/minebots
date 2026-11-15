// ========================================
// 文件：scripts/selftest-p13e.js
// 功能：P13 模块5 回归自测——极限物理反射（20tps MLG / 跳跃重置 / Creeper 防爆盾）/
//       养老读心陪伴（低血递药 / 钓鱼陪坐 / 盖房递材料 / 下线 20 格巡逻）/
//       动态信任 2.0（吃醋 / 告状 / 非还手）/ 绝对主人特权 isOwner=true
//       （信任锁定 100 / AI 绝对服从 / 指令优先级 / GUI 👑 [主人] 标签）
// 依赖：path、fs、os；被测模块（都可选，缺了记失败而不崩）
// 导出：run（由 selftest-p5.js 调用）
// 作者：MineBots
// ========================================
// 说明：全程离线，bot 全是内存假实现；所有落盘经 MINEBOTS_STATE_DIR 重定向到临时目录，
//   收尾删除临时目录并还原环境变量，真实 state/ 不受任何污染。
var path = require("path");
var fs = require("fs");
var os = require("os");
var ROOT = path.join(__dirname, "..");
var TEMP_DIR = path.join(os.tmpdir(), "minebots-p13e-" + process.pid);

// 安全 require：缺失或抛错返回 null。
function load(rel) {
  try { return require(path.join(ROOT, rel)); } catch (e) { return null; }
}
// 读项目文件文本；读不到返回空串。
function readRel(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch (e) { return ""; }
}
// 递归删临时目录；失败静默。
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
// 生存微操假 bot：blockAt 在 y<=8 给地面，背包带水桶 / 盾，动作全部留痕。
function makeSurvivalBot(calls, opts) {
  var o = opts && typeof opts === "object" ? opts : {};
  var groundY = o.groundY === undefined ? 8 : o.groundY;
  var items = o.items || [{ name: "water_bucket", count: 1 }, { name: "shield", count: 1 }];
  return {
    entity: { position: { x: 2, y: 10, z: 3 }, velocity: { y: -1.6 } },
    players: { Steve: { entity: { position: { x: 3, y: 12, z: 3 }, velocity: { y: 0 } } } },
    inventory: { items: function () { return items; } },
    equip: function (it, dest) { calls.push("equip:" + it.name + ":" + dest); return Promise.resolve(); },
    placeBlock: function (ref, off) { calls.push("place:" + (ref && ref.name) + ":" + off.y); return Promise.resolve(); },
    activateItem: function (on) { calls.push("activate:" + on); return Promise.resolve(); },
    setControlState: function (k, v) { calls.push("ctrl:" + k + ":" + v); },
    lookAt: function () { calls.push("lookAt"); },
    blockAt: function (p) { return p.y <= groundY ? { name: o.groundName || "stone", position: p } : { name: "air" }; },
    pathfinder: { setGoal: function () { calls.push("stopGoal"); } },
    entities: {}, chat: function (t) { calls.push("chat:" + t); },
    on: function () {}, removeListener: function () {}
  };
}
// 陪伴层假 bot：背包带喷溅药水，装备 / 抛出 / 坐下全部留痕。
function makeCompanionBot(calls) {
  return {
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: { items: function () { return [{ name: "splash_potion", count: 3 }, { name: "stone", count: 64 }]; } },
    equip: function (it) { calls.push("equip:" + it.name); return Promise.resolve(); },
    tossStack: function (it) { calls.push("toss:" + it.name); return Promise.resolve(); },
    activateItem: function () { calls.push("activate"); return Promise.resolve(); },
    lookAt: function () { calls.push("lookAt"); },
    setControlState: function (k, v) { calls.push("ctrl:" + k + ":" + v); },
    chat: function (t) { calls.push("chat:" + t); },
    on: function () {}, removeListener: function () {}
  };
}
// 内存黑板：post / get 都留痕。
function fakeBoard() {
  var data = {};
  return {
    data: data,
    post: function (k, v) { data[k] = JSON.parse(JSON.stringify(v)); return { ok: true }; },
    get: function (k, d) { return data[k] === undefined ? d : data[k]; }
  };
}
// 28a：静态红线与全链路接线。
function checkStatic(h) {
  h.section("28a. 模块5 静态红线 / static");
  var op = readRel("modules/owner-privilege.js");
  var banned = [/\?\./, /\?\?/, /^import\s+/m, /^export\s+/m, /\bconst\b/, /\blet\b/, /=>/, /\x60/];
  var clean = op.length > 0 && op.indexOf("// ====") === 0 && op.split("\n").length <= 600;
  for (var i = 0; i < banned.length; i++) if (banned[i].test(op)) clean = false;
  h.expect("owner-privilege 满足头注释 / 600 行 / 禁用语法", clean, "lines=" + op.split("\n").length);
  h.expect("player-manager 挂上主人薄接线", readRel("modules/player-manager.js").indexOf("owner-privilege") > 0, "");
  h.expect("context-manager 把绝对服从段汇入 System Prompt",
    readRel("modules/context-manager.js").indexOf("ownerPrivilege.getPromptAppend") > 0, "");
  h.expect("emotion-trust 接了信任分锁定守卫",
    readRel("modules/emotion-trust.js").indexOf("guardTrustDelta") > 0, "");
  h.expect("chat-handler 主人指令强制走 owner 等级",
    readRel("modules/chat-handler.js").indexOf("owner-privilege") > 0 &&
    readRel("modules/chat-handler.js").indexOf('lv = "owner"') > 0, "");
  h.expect("GUI 主进程读 / 存 isOwner 名单",
    readRel("gui/main.js").indexOf("owner-privilege") > 0 && readRel("gui/main.js").indexOf("out.owners") > 0, "");
  h.expect("GUI 面板渲染 👑 [主人] 标签",
    readRel("gui/renderer/panel-settings.js").indexOf("renderOwnerBadges") > 0 &&
    readRel("gui/renderer/panel-settings.js").indexOf("👑 [主人]") > 0, "");
  h.expect("GUI 双语词条与样式齐备",
    readRel("gui/renderer/lang.js").indexOf("ownerBadgeEmpty") > 0 &&
    readRel("gui/renderer/style.css").indexOf(".owner-badge") > 0 &&
    readRel("gui/renderer/settings.html").indexOf("ownerBadges") > 0 &&
    readRel("gui/renderer/ui.js").indexOf("renderOwnerBadges") > 0, "");
  var pm = load("modules/player-manager.js");
  h.expect("player-manager 既有 5 个导出一个不少",
    !!pm && typeof pm.loadPlayers === "function" && typeof pm.savePlayers === "function" &&
    typeof pm.setAutoJudge === "function" && typeof pm.getLevel === "function" &&
    typeof pm.judgeByBehavior === "function", "");
  h.expect("player-manager 新增 7 个主人特权接口",
    !!pm && ["isOwner", "setOwnerFlag", "listOwners", "ownerLabel", "getOwnerPrompt",
      "guardOwnerTrust", "ownerStats"].every(function (k) { return typeof pm[k] === "function"; }), "");
}
// 28b：极限物理反射回归（20tps）。
function checkReflex(h) {
  h.section("28b. 极限物理反射回归 / 20tps reflex");
  var rs = load("modules/reflex-survival.js");
  if (!rs) { h.expect("reflex-survival 可加载", false, "null"); return; }
  rs.reset();
  h.expect("20tps / 下落阈值 -0.8 / 地面扫描 3 / Creeper 半径 3 全部在位",
    rs.TPS === 20 && rs.FALL_VELOCITY === -0.8 && rs.GROUND_SCAN === 3 &&
    rs.CREEPER_RADIUS === 3 && rs.MLG_ITEMS.indexOf("water_bucket") >= 0, "");
  var calls = [];
  rs.registerBot("e1", makeSurvivalBot(calls, {}), { ownerName: "Steve" });
  var m = rs.simulatePhysicsTick("e1", { self: { position: { x: 2, y: 10, z: 3 }, vy: -1.6 } }).results[0];
  h.expect("急坠一拍内 MLG 落地水真的切桶并放置",
    m.acted === true && m.action === "mlg" && m.item === "water_bucket" && m.placed === true &&
    calls.indexOf("equip:water_bucket:hand") >= 0, JSON.stringify(m));
  var hurt = rs.simulateHurt("e1", { source: "Alex" });
  h.expect("被攻击瞬间跳跃取消硬直",
    hurt.ok === true && hurt.action === "jump_reset" && hurt.jumped === true &&
    calls.indexOf("ctrl:jump:true") >= 0, JSON.stringify(hurt));
  var shield = rs.scanCreeper("e1", {
    self: { position: { x: 0, y: 64, z: 0 } }, owner: { position: { x: 0, y: 64, z: 0 } },
    entities: [{ name: "creeper", ignited: true, position: { x: 2, y: 64, z: 0 } }]
  });
  h.expect("3 格内引燃 Creeper 瞬间举盾挡在主人身前且不拔剑",
    shield.acted === true && shield.action === "creeper_shield" && shield.shieldEquipped === true &&
    shield.attacked === false && calls.indexOf("equip:shield:off-hand") >= 0, JSON.stringify(shield));
  rs.reset();
}
// 28c：养老读心陪伴回归。
function checkCompanion(h) {
  h.section("28c. 读心陪伴回归 / companion");
  var cp = load("modules/companion.js");
  if (!cp) { h.expect("companion 可加载", false, "null"); return; }
  cp.reset();
  h.expect("低血阈值 10 / 领地半径 20 / 三种陪伴模式在位",
    cp.OWNER_HP === 10 && cp.TERRITORY_RADIUS === 20 &&
    cp.MODE_SIT === "sit_with_owner" && cp.MODE_SUPPLY === "supply_material" && cp.MODE_PATROL === "patrol", "");
  var calls = [], board = fakeBoard();
  cp.registerBot("c1", makeCompanionBot(calls), { ownerName: "Steve", board: board });
  var potion = cp.deliverPotion("c1", { ownerHealth: 8, ownerEating: false,
    ownerPos: { x: 5, y: 64, z: 0 }, botPos: { x: 0, y: 64, z: 0 } });
  h.expect("主人低血自动递治疗药水",
    potion.acted === true && potion.item === "splash_potion" && potion.thrown === true &&
    calls.indexOf("toss:splash_potion") >= 0, JSON.stringify(potion));
  var fish = cp.syncRhythm("c1", { ownerAction: "fishing_rod", ownerFishing: true,
    ownerGap: 1.5, ownerPos: { x: 1, y: 64, z: 0 } });
  h.expect("主人钓鱼自动坐下陪伴", fish.action === "sit" && fish.sneaking === true, JSON.stringify(fish));
  var build = cp.syncRhythm("c1", { ownerAction: "place_block", ownerBuilding: true, ownerGap: 2 });
  h.expect("主人盖房自动递材料", build.mode === "supply_material" && build.acted === true, JSON.stringify(build));
  var off = cp.observe("c1", { ownerOnline: false, ownerPos: { x: 0, y: 64, z: 0 }, manual: true,
    nearbyPlayers: [{ name: "Alex", position: { x: 3, y: 64, z: 0 } }] });
  h.expect("主人下线在 20 格领地巡逻并盯梢陌生人",
    off.mode === "patrol" && cp.stats("c1").patrol.radius === 20 &&
    cp.stats("c1").watchList.length >= 1 && cp.stats("c1").watchList[0].attacked === false, JSON.stringify(off.decisions));
  var wp = cp.patrolWaypoints({ x: 0, y: 64, z: 0 }, 20);
  h.expect("巡逻路点确实覆盖 20 格", wp.length === 4 && wp[0].x === -20 && wp[1].z === -20, JSON.stringify(wp));
  cp.stopPatrol("c1");
  cp.reset();
}
// 28d：动态信任 2.0 回归（吃醋 / 告状 / 不还手）。
function checkTrust(h) {
  h.section("28d. 动态信任 2.0 回归 / trust");
  var emo = load("modules/emotion-trust.js");
  var pm = load("modules/player-manager.js");
  var ce = load("modules/combat-ethics.js");
  if (!emo || !pm || !ce) { h.expect("情感三模块可加载", false, "null"); return; }
  emo.reset(); ce.reset();
  h.expect("默认信任分 50 且范围 0~100", emo.DEFAULT_TRUST === 50 && emo.getTrustScore("Nobody") === 50, "");
  emo.setOwner("Steve");
  var j = pm.onGiftToOther("Steve", "Alex", "diamond", {});
  h.expect("主人送别人钻石 → 吃醋扣 5 分并公屏吐槽",
    j.jealous === true && j.delta === -5 && j.trustAfter === 45 &&
    j.taunt.indexOf("你居然把钻石给他不给我！") >= 0, JSON.stringify(j));
  var chats = [];
  var bot = { entity: { position: { x: 0, y: 64, z: 0 } }, health: 20, food: 20,
    chat: function (t) { chats.push(t); }, lookAt: function () {},
    setControlState: function () {}, attack: function () { chats.push("ATTACK"); }, swingArm: function () {} };
  var r = pm.onBotAttacked("Bob", { level: "close_friend", botId: "t1", bot: bot,
    ownerPosition: { x: 3, y: 64, z: 0 } });
  h.expect("亲密朋友打 Bot → 逃跑告状、绝不还手",
    r.retaliate === false && r.complaint === true && chats.indexOf("ATTACK") < 0 &&
    r.chat.indexOf("主人，你的朋友打我，我能还手吗？") >= 0, JSON.stringify(r));
  h.expect("告状待决时攻击门面拒绝拔剑", ce.canAttack("t1", "Bob", {}).allowed === false, "");
  h.expect("主人发话后才允许还手",
    ce.ownerAllows("t1", "Bob", {}).ok === true && ce.canAttack("t1", "Bob", {}).allowed === true, "");
  emo.reset(); ce.reset();
}
// 28e：绝对主人特权 isOwner=true。
function checkOwner(h) {
  h.section("28e. 绝对主人特权 / isOwner=true");
  var op = load("modules/owner-privilege.js");
  var pm = load("modules/player-manager.js");
  var emo = load("modules/emotion-trust.js");
  var cm = load("modules/context-manager.js");
  var perms = load("modules/chat-permissions.js");
  if (!op || !pm || !emo || !cm || !perms) { h.expect("特权五模块可加载", false, "null"); return; }
  op.reset(); emo.reset();
  h.expect("未配置主人时 Prompt 与标签都不污染既有链路",
    op.isOwner("Steve") === false && op.getPromptAppend() === "" && cm.getSystemPromptAppend() === "", "");
  var cfg = op.configure(["Steve", "Steve", "  "], {});
  h.expect("GUI 名单去重去空并落盘 isOwner=true",
    cfg.ok === true && cfg.count === 1 && op.listOwners()[0] === "Steve" &&
    fs.existsSync(op.pathOf()), JSON.stringify(cfg));
  h.expect("大小写不敏感识别绝对主人", op.isOwner("STEVE") === true && pm.isOwner("Steve") === true, "");
  h.expect("非主人不误判", op.isOwner("Alex") === false && pm.isOwner("Alex") === false, "");
  h.expect("GUI 显示 👑 [主人] / 👑 [Owner] 双语标签",
    op.labelOf("Steve", {}) === "👑 [主人] Steve" && op.labelOf("Steve", { lang: "en" }) === "👑 [Owner] Steve" &&
    op.LABEL_ZH === "👑 [主人]" && pm.ownerLabel("Steve") === "👑 [主人] Steve", op.labelOf("Steve", {}));
  h.expect("主人信任分恒定 100 / 非主人交回情感引擎",
    op.trustOf("Steve") === 100 && op.trustOf("Alex") === null, "");
  var verdict = op.guardTrustDelta("Steve", -30, {});
  h.expect("扣分守卫拦下主人负分并给出双语原因",
    verdict.locked === true && verdict.applied === false && verdict.score === 100 &&
    verdict.message.indexOf("锁定") >= 0 && verdict.message.indexOf("locked") >= 0, JSON.stringify(verdict));
  h.expect("非主人扣分守卫放行", op.guardTrustDelta("Alex", -30, {}).locked === false, "");
  emo.adjustTrust("Steve", 40, "first_meet");
  var lock = op.applyTrustLock({});
  h.expect("applyTrustLock 把主人信任分真正推到 100",
    lock.ok === true && lock.locked.length === 1 && emo.getTrustScore("Steve") === 100, JSON.stringify(lock));
  var penalty = emo.adjustTrust("Steve", -60, "hurt_owner");
  h.expect("引擎层扣分对主人无效，信任分仍锁 100",
    penalty.locked === true && penalty.after === 100 && penalty.delta === 0 &&
    emo.getTrustScore("Steve") === 100, JSON.stringify(penalty));
  var decision = op.decide("Steve", "去把家建好", {});
  h.expect("主人指令优先级 absolute、必须服从、不得拒绝",
    decision.isOwner === true && decision.priority === "absolute" && decision.obey === true &&
    decision.trustScore === 100 && decision.label.indexOf("👑") === 0 &&
    decision.message.indexOf("无条件") >= 0 && decision.message.indexOf("absolutely") >= 0, JSON.stringify(decision));
  h.expect("非主人仍走普通权限", op.decide("Alex", "去把家建好", {}).priority === "normal", "");
  var denied = perms.filterActions("normal", [{ type: "attack", target: "Steve" }]);
  var allowed = perms.filterActions("owner", [{ type: "attack", target: "Steve" }]);
  h.expect("owner 等级动作全放行（普通玩家被拒）",
    denied.blocked === true && allowed.blocked === false && allowed.allowed.length === 1,
    JSON.stringify({ denied: denied, allowed: allowed }));
  var prompt = cm.getSystemPromptAppend();
  h.expect("System Prompt 注入绝对服从段与 100/100 锁定",
    prompt.indexOf("[绝对主人特权 / Absolute Owner Privilege]") >= 0 &&
    prompt.indexOf("👑 [主人] Steve") >= 0 && prompt.indexOf("100/100") >= 0 &&
    prompt.indexOf("priority: absolute") >= 0 && prompt.indexOf("never refuse") >= 0, prompt.slice(0, 260));
  h.expect("player-manager 也能拿到同一段特权 Prompt",
    pm.getOwnerPrompt({}).indexOf("absolute") >= 0 && pm.ownerStats().count === 1, "");
  var removed = op.setOwner("Steve", false, {});
  h.expect("取消 isOwner 后特权立即失效且标签还原",
    removed.ok === true && op.isOwner("Steve") === false && op.labelOf("Steve", {}) === "Steve" &&
    cm.getSystemPromptAppend().indexOf("绝对主人特权") < 0, JSON.stringify(removed));
  op.reset(); emo.reset();
}
// 主流程：先隔离 state 目录，再逐组跑；任一组抛错只记一条失败；收尾清理还原。
async function run(h) {
  var OLD = process.env.MINEBOTS_STATE_DIR;
  try {
    safeRemove(TEMP_DIR);
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
    process.env.MINEBOTS_STATE_DIR = TEMP_DIR;
    var groups = [checkStatic, checkReflex, checkCompanion, checkTrust, checkOwner];
    for (var i = 0; i < groups.length; i++) {
      try { groups[i](h); } catch (e) { h.expect("28 组 " + (i + 1) + " 未抛错", false, String(e)); }
    }
  } catch (eStart) { h.expect("28 环境隔离未抛错", false, String(eStart)); }
  try {
    var op = load("modules/owner-privilege.js");
    var emo = load("modules/emotion-trust.js");
    if (op) op.reset();
    if (emo) emo.reset();
    safeRemove(TEMP_DIR);
    if (OLD === undefined) delete process.env.MINEBOTS_STATE_DIR;
    else process.env.MINEBOTS_STATE_DIR = OLD;
    h.expect("临时 state 目录已清理、环境已还原", fs.existsSync(TEMP_DIR) === false, TEMP_DIR);
  } catch (eEnd) { h.expect("28f 收尾未抛错", false, String(eEnd)); }
}
module.exports = { run: run };
