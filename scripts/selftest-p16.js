// ========================================
// 文件：scripts/selftest-p16.js
// 功能：终极自动化 QA 回归——自愈重试循环 / 补丁安全边界 / 环境扫描 / 9 项测试清单 / 最终报告 / 极速通关定义
// 依赖：path、fs、os；被测 modules/qa-heal、scripts/qa-env、scripts/qa-tests、scripts/auto-game-demo（懒加载）
// 导出：run（由 selftest-p5.js 调用）
// 说明：全程离线；补丁测试只写系统临时目录，收尾删除；绝不触网、绝不改仓库源码。
// 作者：MineBots
// ========================================
var path = require("path");
var fs = require("fs");
var os = require("os");
var ROOT = path.join(__dirname, "..");
var TEMP_DIR = path.join(os.tmpdir(), "minebots-p16-" + process.pid);
var TICK = String.fromCharCode(96);

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
    try { fs.rmdirSync(dir); } catch (e2) { /* ignore */ }
  } catch (e) { /* ignore */ }
}
function fresh() {
  safeRemove(TEMP_DIR);
  try { fs.mkdirSync(path.join(TEMP_DIR, "modules"), { recursive: true }); } catch (e) { /* ignore */ }
}

// A. 静态红线：头注释 / 禁止语法 / 行数 / 导出。
function checkStatic(h) {
  var files = [
    { rel: "modules/qa-heal.js", wanted: ["parsePatch", "isPatchable", "applyPatch", "heal", "buildHealPrompt"] },
    { rel: "scripts/qa-env.js", wanted: ["scanEnvironment", "grabFrame", "synthFrame", "encodePNG", "makeVideo", "closeAll"] },
    { rel: "scripts/qa-tests.js", wanted: [] },
    { rel: "scripts/auto-game-demo.js", wanted: ["runWithHealing", "runAllTests", "buildReport", "writeFinalReport", "main", "loadRobot", "captureReport"] }
  ];
  var badOpt = new RegExp("\\?\\.");
  var badNull = new RegExp("\\?\\?");
  var badArrow = new RegExp("=\\>");
  var badTick = new RegExp(String.fromCharCode(96));
  var badDecl = new RegExp("\\b" + String.fromCharCode(99, 111, 110, 115, 116) + "\\b");
  for (var i = 0; i < files.length; i++) {
    var f = load(files[i].rel);
    h.expect("p16 静态: " + files[i].rel + " 可 require", !!f, "null");
    var src = readRel(files[i].rel);
    h.expect("p16 静态: " + files[i].rel + " 有文件头注释", src.indexOf("// ====") >= 0, "");
    h.expect("p16 静态: " + files[i].rel + " 无禁用语法", !badOpt.test(src) && !badNull.test(src) && !badArrow.test(src) && !badTick.test(src) && !badDecl.test(src), "");
    h.expect("p16 静态: " + files[i].rel + " 不超过 600 行", src.split("\n").length <= 600, String(src.split("\n").length));
    for (var w = 0; w < files[i].wanted.length; w++) {
      h.expect("p16 静态: " + files[i].rel + " 导出 " + files[i].wanted[w], f && typeof f[files[i].wanted[w]] === "function", "");
    }
  }
}

// B. 自愈循环：失败 -> 自愈 -> 重试成功；连续 3 次失败 -> FAILED 且不卡死。
function checkHealing(h) {
  var demo = load("scripts/auto-game-demo");
  if (!demo) { h.expect("p16 自愈: 编排器可加载", false, "null"); return Promise.resolve(); }
  var calls1 = 0, restarts = 0;
  var fn1 = function () { calls1++; return calls1 === 1 ? { ok: false, message: "第一次故意失败" } : { ok: true, message: "第二次成功" }; };
  var heal1 = function () { return { ok: true, applied: false, message: "stub patch" }; };
  var p1 = demo.runWithHealing("stub-pass", fn1, 3, { heal: heal1, restart: function () { restarts++; } }).then(function (r) {
    h.expect("p16 自愈: 失败一次后重试成功", r.status === "PASS", JSON.stringify(r));
    h.expect("p16 自愈: 记录 1 次重试", r.retries === 1, String(r.retries));
    h.expect("p16 自愈: 自愈日志 1 条", (r.healLog || []).length === 1, String((r.healLog || []).length));
    h.expect("p16 自愈: 触发 1 次环境重启", restarts === 1, String(restarts));
  });
  var calls2 = 0;
  var fn2 = function () { calls2++; return { ok: false, message: "持续失败" }; };
  var heal2 = function () { return { ok: false, applied: false, message: "无法修复" }; };
  var p2 = demo.runWithHealing("stub-fail", fn2, 2, { heal: heal2 }).then(function (r) {
    h.expect("p16 自愈: 连续失败标记 FAILED", r.status === "FAILED", JSON.stringify(r));
    h.expect("p16 自愈: 重试 2 次后停手", r.retries === 2, String(r.retries));
    h.expect("p16 自愈: 总调用 3 次（首发+2 重试）", calls2 === 3, String(calls2));
    h.expect("p16 自愈: FAILED 也返回未抛错", !!r.message, "");
  });
  var fn3 = function () { throw new Error("爆炸"); };
  var p3 = demo.runWithHealing("stub-throw", fn3, 0, { heal: function () { return { ok: false }; } }).then(function (r) {
    h.expect("p16 自愈: 抛错被捕获且不冒出", r.status === "FAILED" && String(r.message).indexOf("爆炸") >= 0, JSON.stringify(r).slice(0, 120));
  });
  return Promise.all([p1, p2, p3]).then(function () { /* 三组都跑完 */ });
}

// C. 补丁安全：禁改文件 / 路径越界 / 唯一匹配 / 语法校验回滚。
function checkPatch(h) {
  var qh = load("modules/qa-heal");
  if (!qh) { h.expect("p16 补丁: qa-heal 可加载", false, "null"); return; }
  h.expect("p16 补丁: 拒绝 guard.js", qh.isPatchable("guard.js").ok === false, "");
  h.expect("p16 补丁: 拒绝 package.json", qh.isPatchable("package.json").ok === false, "");
  h.expect("p16 补丁: 拒绝路径越界", qh.isPatchable("../evil.js").ok === false, "");
  h.expect("p16 补丁: 拒绝不存在的文件", qh.isPatchable("modules/not-there.js", TEMP_DIR).ok === false, "");
  var fenced = TICK + TICK + TICK + "json\n{\"file\":\"modules/x.js\",\"search\":\"var a = 1;\",\"replace\":\"var a = 2;\"}\n" + TICK + TICK + TICK;
  var parsed = qh.parsePatch(fenced);
  h.expect("p16 补丁: 能解析围栏 JSON", !!(parsed && parsed.file === "modules/x.js" && parsed.replace === "var a = 2;"), JSON.stringify(parsed));
  h.expect("p16 补丁: 垃圾回复返回 null", qh.parsePatch("我看不懂") === null, "");
  fresh();
  var target = path.join(TEMP_DIR, "modules", "x.js");
  fs.writeFileSync(target, "var a = 1;\nvar b = 2;\n", "utf8");
  var okPatch = qh.applyPatch({ file: "modules/x.js", search: "var a = 1;", replace: "var a = 9;" }, { root: TEMP_DIR });
  h.expect("p16 补丁: 合法补丁可应用", okPatch.ok === true, JSON.stringify(okPatch));
  h.expect("p16 补丁: 应用后内容已变", fs.readFileSync(target, "utf8").indexOf("var a = 9;") >= 0, "");
  var dup = qh.applyPatch({ file: "modules/x.js", search: "var", replace: "var q" }, { root: TEMP_DIR });
  h.expect("p16 补丁: 非唯一匹配被拒", dup.ok === false, JSON.stringify(dup));
  var broken = qh.applyPatch({ file: "modules/x.js", search: "var a = 9;", replace: "var a = ;" }, { root: TEMP_DIR });
  h.expect("p16 补丁: 语法坏补丁被回滚", broken.ok === false, JSON.stringify(broken));
  h.expect("p16 补丁: 回滚后内容原样", fs.readFileSync(target, "utf8").indexOf("var a = 9;") >= 0, "");
  var forb = qh.applyPatch({ file: "guard.js", search: "x", replace: "y" }, { root: ROOT });
  h.expect("p16 补丁: 应用层也拒绝禁改文件", forb.ok === false, JSON.stringify(forb));
}

// D. 环境层：扫描结构 / 合成帧尺寸 / PNG 头 / 落盘。
function checkEnv(h) {
  var q = load("scripts/qa-env");
  if (!q) { h.expect("p16 环境: qa-env 可加载", false, "null"); return; }
  var env = q.scanEnvironment();
  h.expect("p16 环境: 扫描返回对象", !!env && typeof env === "object", "");
  h.expect("p16 环境: versions 是数组", Array.isArray(env.versions), "");
  h.expect("p16 环境: rpa 能力字段存在", !!env.rpa && typeof env.rpa.nut === "boolean", "");
  h.expect("p16 环境: ffmpeg 字段是字符串", typeof env.ffmpeg === "string", "");
  var frame = q.synthFrame(5, 9, true);
  h.expect("p16 环境: 合成帧 1280x720", frame.width === 1280 && frame.height === 720, frame.width + "x" + frame.height);
  h.expect("p16 环境: 合成帧像素长度正确", frame.rgba.length === 1280 * 720 * 4, String(frame.rgba.length));
  var png = q.encodePNG(2, 2, Buffer.alloc(2 * 2 * 4, 255));
  var sig = [137, 80, 78, 71, 13, 10, 26, 10];
  var okSig = true;
  for (var i = 0; i < sig.length; i++) { if (png[i] !== sig[i]) { okSig = false; break; } }
  h.expect("p16 环境: PNG 签名正确", okSig && png.length > 40, String(png.length));
  fresh();
  var saved = q.saveFrame(TEMP_DIR, 3, frame);
  h.expect("p16 环境: 帧可落盘", saved.ok === true && fs.existsSync(saved.file), JSON.stringify(saved));
}

// E. 9 项测试清单 + BFS 纯函数。
function checkSpecs(h) {
  var t = load("scripts/qa-tests");
  if (!t) { h.expect("p16 清单: qa-tests 可加载", false, "null"); return; }
  h.expect("p16 清单: 正好 9 项", Array.isArray(t.SPECS) && t.SPECS.length === 9, String(t.SPECS && t.SPECS.length));
  var seq = "";
  for (var i = 0; i < t.SPECS.length; i++) seq += String(t.SPECS[i].index);
  h.expect("p16 清单: 序号 1..9", seq === "123456789", seq);
  h.expect("p16 清单: 每项都有名字与函数", !!t.SPECS[0].name && typeof t.SPECS[0].fn === "function", "");
  var route = t.bfsPath(8, 8, {});
  h.expect("p16 清单: BFS 能连通", route.length === 15, String(route.length));
  var blocked = t.bfsPath(4, 4, { "3,3": true });
  h.expect("p16 清单: BFS 遇墙返回空", blocked.length === 0, String(blocked.length));
}

// F. 报告：9 行状态 + 重试次数 + 截图列。
function checkReport(h) {
  var demo = load("scripts/auto-game-demo");
  if (!demo) { h.expect("p16 报告: 编排器可加载", false, "null"); return; }
  var rows = [];
  for (var i = 1; i <= 9; i++) rows.push({ index: i, name: "测试项 " + i, status: i === 5 ? "FAILED" : "PASS", retries: i === 1 ? 2 : 0, healLog: i === 1 ? [{ attempt: 1, message: "stub" }] : [], frame: "frame-00" + i + ".png" });
  var md = demo.buildReport(rows, { simulated: true, env: { pcl2: "x", rpa: {}, ffmpeg: "ffmpeg" } });
  h.expect("p16 报告: 含 9 行表格", md.indexOf("| 1 |") >= 0 && md.indexOf("| 9 |") >= 0, "");
  h.expect("p16 报告: 记录 FAILED", md.indexOf("FAILED") >= 0, "");
  h.expect("p16 报告: 记录自愈重试次数", md.indexOf("自愈重试合计") >= 0 && md.indexOf("| 2 |") >= 0, "");
  h.expect("p16 报告: 含截图列链接", md.indexOf("frame-001.png") >= 0, "");
  h.expect("p16 报告: 含自愈明细", md.indexOf("自愈明细") >= 0, "");
}

// G. 极速通关定义：能通过状态机校验且阶段数足够。
function checkSpeedrun(h) {
  var sm = load("modules/state-machine");
  var file = path.join(ROOT, "state", "statemachines", "speedrun_mc.json");
  h.expect("p16 通关: speedrun_mc.json 存在", fs.existsSync(file), "");
  var def = null;
  try { def = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { def = null; }
  h.expect("p16 通关: JSON 可解析", !!def, "null");
  var v = sm && def ? sm.validate(def) : { ok: false, errors: [] };
  h.expect("p16 通关: 状态机校验通过", v.ok === true, JSON.stringify(v.errors || []).slice(0, 120));
  h.expect("p16 通关: 至少 5 个阶段", !!(def && def.nodes && def.nodes.length >= 5), String(def && def.nodes && def.nodes.length));
}

function run(h) {
  var syncGroups = [checkStatic, checkPatch, checkEnv, checkSpecs, checkReport, checkSpeedrun];
  for (var i = 0; i < syncGroups.length; i++) {
    try { syncGroups[i](h); } catch (e) { h.expect("p16 组 " + (i + 1) + " 未抛错", false, String(e)); }
  }
  return Promise.resolve()
    .then(function () { return checkHealing(h); })
    .catch(function (e) { h.expect("p16 自愈组未抛错", false, String(e)); })
    .then(function () { safeRemove(TEMP_DIR); });
}

module.exports = { run: run };
