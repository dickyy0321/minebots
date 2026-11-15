// ========================================
// 文件：scripts/selftest-p15.js
// 功能：终极发布版本回归——模块1 账号双支持 / 模块3 向导+演示 / 模块4 沙盒安全 / 模块5 自动演示
// 依赖：path、fs、os、assert；被测模块 account-manager、safety-shield、bot-manager、auto-game-demo（懒加载）
// 导出：run（由 selftest-p5.js 调用）
// 说明：全程离线；落盘经 MINEBOTS_STATE_DIR 重定向到临时目录，收尾删除，真实 state/ 不受影响。
// 作者：MineBots
// ========================================
var path = require("path");
var fs = require("fs");
var os = require("os");
var assert = require("assert");
var ROOT = path.join(__dirname, "..");
var TEMP_DIR = path.join(os.tmpdir(), "minebots-p15-" + process.pid);

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
}

// 静态检查：头注释 / 禁用语法 / 行数 / 导出接口（与 selftest.js 一致）。
function checkStatic(h) {
  var files = [
    { rel: "modules/account-manager.js", wanted: ["authMode", "available", "acquireMicrosoft", "loadCached", "clearCache", "cachePath"] },
    { rel: "modules/safety-shield.js", wanted: ["sanitizeIncoming", "guardBot", "checkMemory", "detectAlert", "cleanState", "redactObject"] },
    { rel: "scripts/auto-game-demo.js", wanted: ["loadRobot", "launchPCL2", "openLAN", "wakeBots", "runActions", "captureReport", "main"] }
  ];
  var forbidden = [/\?\./, /\?\?/, /^import\s+/m, /^export\s+/m, /\bconst\b/, /\blet\b/, /=>/, /`/];
  for (var i = 0; i < files.length; i++) {
    var rel = files[i].rel;
    var abs = path.join(ROOT, rel);
    var f = load(rel);
    h.expect("p15 静态: " + rel + " 可 require", !!f, "null");
    var src = readRel(rel);
    h.expect("p15 静态: " + rel + " 有文件头注释", src.indexOf("// ====") >= 0, "");
    var bad = null;
    for (var k = 0; k < forbidden.length; k++) { if (forbidden[k].test(src)) { bad = forbidden[k]; break; } }
    h.expect("p15 静态: " + rel + " 无禁用语法", bad === null, String(bad));
    var lines = src.split("\n").length;
    h.expect("p15 静态: " + rel + " 不超过 600 行（" + lines + "）", lines <= 600, "lines=" + lines);
    for (var w = 0; w < files[i].wanted.length; w++) {
      h.expect("p15 静态: " + rel + " 导出 " + files[i].wanted[w], f && typeof f[files[i].wanted[w]] === "function", "");
    }
  }
  // bot-manager 必须保留动态 auth（不再写死 offline）。
  var bmSrc = readRel("modules/bot-manager.js");
  h.expect("p15 静态: bot-manager 仍引用 mineflayer.createBot", bmSrc.indexOf("mineflayer.createBot") >= 0, "");
  h.expect("p15 静态: bot-manager 动态读取 loginMode", bmSrc.indexOf("authMode") >= 0 && bmSrc.indexOf('auth: authMode') >= 0, "");
}

// 模块1：账号系统——微软授权优雅降级 + 本地 Token 缓存读写。
function checkAuth(h) {
  fresh();
  var acct = load("modules/account-manager");
  if (!acct) { h.expect("p15 账号: account-manager 可加载", false, "null"); return; }
  h.expect("p15 账号: authMode 含 offline/microsoft", acct.authMode.OFFLINE === "offline" && acct.authMode.MICROSOFT === "microsoft", "");
  // prismarine-auth 未安装时 available() 必须返回 false，绝不抛错。
  h.expect("p15 账号: 未装 prismarine-auth 时 available()=false", acct.available() === false, "");
  // acquireMicrosoft 未装库时返回 ok:false 的双语提示，且不抛错、不联网。
  return acct.acquireMicrosoft({ username: "demo" }).then(function (res) {
    h.expect("p15 账号: 未装库时 acquireMicrosoft 优雅返回 ok:false", res && res.ok === false, JSON.stringify(res));
    // 本地 Token 缓存：写一份再到 loadCached 读回。
    var tokenDir = path.join(TEMP_DIR, "microsoft-tokens");
    try { fs.mkdirSync(tokenDir, { recursive: true }); } catch (e) { /* ignore */ }
    var cacheFile = path.join(tokenDir, "demo.json");
    fs.writeFileSync(cacheFile, JSON.stringify({ username: "demo", cached: true }), "utf8");
    var cached = acct.loadCached("demo");
    h.expect("p15 账号: loadCached 读回本地缓存 Token", cached && cached.cached === true, JSON.stringify(cached));
    var clr = acct.clearCache("demo");
    h.expect("p15 账号: clearCache 删除缓存", clr && clr.ok === true, JSON.stringify(clr));
  });
}

// 模块1：bot-manager 的 resolveOptions 必须透传 loginMode（离线/正版动态化）。
function checkBotAuth(h) {
  var bm = load("modules/bot-manager");
  if (!bm) { h.expect("p15 账号: bot-manager 可加载", false, "null"); return; }
  var off = bm.resolveOptions({ id: "bot-1", username: "x" });
  h.expect("p15 账号: 默认 loginMode=offline", off.loginMode === "offline", off.loginMode);
  var ms = bm.resolveOptions({ id: "bot-2", username: "y", loginMode: "microsoft" });
  h.expect("p15 账号: resolveOptions 透传 microsoft", ms.loginMode === "microsoft", ms.loginMode);
  var bad = bm.resolveOptions({ id: "bot-3", username: "z", loginMode: "hacked" });
  h.expect("p15 账号: 非法 loginMode 回退 offline", bad.loginMode === "offline", bad.loginMode);
}

// 模块4：沙盒安全——恶意包吞掉 / 内存检测 / 脱敏 / 红警识别 / 清理打包。
function checkSafety(h) {
  fresh();
  var s = load("modules/safety-shield");
  if (!s) { h.expect("p15 安全: safety-shield 可加载", false, "null"); return; }
  h.expect("p15 安全: sanitizeIncoming 空包判失败", s.sanitizeIncoming(null).ok === false, "");
  var big = { x: "a".repeat(2 * 1024 * 1024) };
  h.expect("p15 安全: sanitizeIncoming 超大包判失败", s.sanitizeIncoming(big).ok === false, "");
  h.expect("p15 安全: sanitizeIncoming 正常对象判成功", s.sanitizeIncoming({ a: 1 }).ok === true, "");
  h.expect("p15 安全: checkMemory(60)>50 告警", s.checkMemory(60).warn === true, "");
  h.expect("p15 安全: checkMemory(10) 不告警", s.checkMemory(10).warn === false, "");
  var redacted = s.redactObject({ apiKey: "sk-x", password: "pw", name: "ok" });
  h.expect("p15 安全: redactObject 脱敏 apiKey/password", redacted.apiKey === "***REDACTED***" && redacted.password === "***REDACTED***" && redacted.name === "ok", JSON.stringify(redacted));
  h.expect("p15 安全: detectAlert(402) 返回红警文案", !!s.detectAlert("402 Payment Required"), "");
  h.expect("p15 安全: detectAlert(ECONNRESET) 返回红警文案", !!s.detectAlert("Error: ECONNRESET"), "");
  h.expect("p15 安全: detectAlert(正常) 返回 null", s.detectAlert("all good") === null, "");
  // 清理打包：在临时 state 写一份含 apiKey 的配置，cleanState 应脱敏后打包。
  var stateDir = TEMP_DIR;
  try { fs.mkdirSync(stateDir, { recursive: true }); } catch (e) { /* ignore */ }
  fs.writeFileSync(path.join(stateDir, "ai-config.json"), JSON.stringify({ apiKey: "sk-secret", model: "phi" }), "utf8");
  fs.writeFileSync(path.join(stateDir, "notes.txt"), "hello", "utf8");
  var c = s.cleanState({ pack: false });
  h.expect("p15 安全: cleanState 成功并脱敏含密钥文件", c.ok === true && c.redacted >= 1, JSON.stringify(c));
  // 验证脱敏真的生效（打包目录里的 ai-config.json 不应含 sk-secret）。
  var packedFile = path.join(c.path || "", "ai-config.json");
  var packedTxt = "";
  try { packedTxt = fs.readFileSync(packedFile, "utf8"); } catch (e) { packedTxt = ""; }
  h.expect("p15 安全: 打包文件已脱敏（不含 sk-secret）", packedTxt.indexOf("sk-secret") < 0, packedTxt.slice(0, 80));
}

// 模块3/5：向导+演示+自动演示脚本的 Node 端贯通（测试模式，不污染真实 state）。
function checkWizardDemo(h) {
  fresh();
  var demo = load("scripts/auto-game-demo");
  if (!demo) { h.expect("p15 演示: auto-game-demo 可加载", false, "null"); return; }
  h.expect("p15 演示: loadRobot 缺失时返回 null（优雅降级）", demo.loadRobot() === null, "应无 robotjs");
  // 测试模式内进程模拟：唤醒 bot-1/bot-2 并跑指令遍历，验证多引擎联调路径不崩。
  var wake = demo.wakeBots();
  h.expect("p15 演示: wakeBots 返回结果对象", wake && Array.isArray(wake.bots), JSON.stringify(wake));
  var acts = demo.runActions();
  h.expect("p15 演示: runActions 返回日志数组", Array.isArray(acts) && acts.length >= 0, "");
  // 集成捕获（模拟模式）不抛错且产出步骤。
  var rep = demo.captureReport(null);
  h.expect("p15 演示: captureReport 模拟模式跑通", rep && rep.ok === true, JSON.stringify(rep).slice(0, 120));
}

// 模块3/1/4：IPC 三件套 + 新 UI 控件已接线（静态断言，不依赖 Electron）。
function checkWiring(h) {
  var preload = readRel("gui/preload.js");
  var api = readRel("gui/renderer/api.js");
  var main = readRel("gui/main.js");
  var acctIpc = readRel("gui/ipc-account-safety.js");
  var index = readRel("gui/renderer/index.html");
  var settings = readRel("gui/renderer/settings.html");
  var wizard = readRel("gui/renderer/ui-wizard.js");
  var uidemo = readRel("gui/renderer/ui-demo.js");
  var safety = readRel("gui/renderer/ui-safety.js");
  h.expect("p15 接线: preload 含 microsoft-auth 通道", preload.indexOf('"microsoft-auth"') >= 0, "");
  h.expect("p15 接线: preload 含 safety-clean / safety-memory 通道", preload.indexOf('"safety-clean"') >= 0 && preload.indexOf('"safety-memory"') >= 0, "");
  h.expect("p15 接线: api.js 暴露 microsoftAuthStart", api.indexOf("microsoftAuthStart") >= 0, "");
  h.expect("p15 接线: api.js 暴露 safetyClean", api.indexOf("safetyClean") >= 0, "");
  h.expect("p15 接线: main.js 挂载账号/安全通道模块", main.indexOf("ipc-account-safety") >= 0, "");
  h.expect("p15 接线: 账号/安全模块注册 microsoft-auth 处理", acctIpc.indexOf('"microsoft-auth"') >= 0, "");
  h.expect("p15 接线: 账号/安全模块注册 safety-clean 处理", acctIpc.indexOf('"safety-clean"') >= 0, "");
  h.expect("p15 接线: index.html 含演示模式按钮", index.indexOf('id="demoBtn"') >= 0, "");
  h.expect("p15 接线: index.html 含向导弹窗", index.indexOf('id="wizardModal"') >= 0, "");
  h.expect("p15 接线: index.html 含微软授权弹窗", index.indexOf('id="msAuthModal"') >= 0, "");
  h.expect("p15 接线: index.html 含红色告警横幅", index.indexOf('id="redAlert"') >= 0, "");
  h.expect("p15 接线: settings.html 含一键清理按钮", settings.indexOf('id="safetyCleanBtn"') >= 0, "");
  h.expect("p15 接线: ui-wizard.js 导出并绑定", wizard.indexOf("window.uiWizard") >= 0 && wizard.indexOf(".bind") >= 0, "");
  h.expect("p15 接线: ui-demo.js 导出并绑定", uidemo.indexOf("window.uiDemo") >= 0 && uidemo.indexOf(".bind") >= 0, "");
  h.expect("p15 接线: ui-safety.js 导出并绑定", safety.indexOf("window.uiSafety") >= 0 && safety.indexOf(".bind") >= 0, "");
  // 新卡片登录模式下拉框已接线。
  h.expect("p15 接线: ui-bot.js 含登录模式下拉框", readRel("gui/renderer/ui-bot.js").indexOf("loginMode") >= 0, "");
}

function run(h) {
  var groups = [checkStatic, checkBotAuth, checkSafety, checkWizardDemo, checkWiring];
  for (var i = 0; i < groups.length; i++) {
    try { groups[i](h); } catch (e) { h.expect("p15 组 " + (i + 1) + " 未抛错", false, String(e)); }
  }
  // 账号授权为异步（设备码流），单独 await，确保不抛错且优雅降级。
  return Promise.resolve()
    .then(function () { return checkAuth(h); })
    .catch(function (e) { h.expect("p15 账号: 异步组未抛错", false, String(e)); })
    .then(function () {
      try { if (fs.existsSync(TEMP_DIR)) safeRemove(TEMP_DIR); } catch (e) { /* ignore */ }
    });
}

module.exports = { run: run };
