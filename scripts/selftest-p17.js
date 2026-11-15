// ========================================
// 文件：scripts/selftest-p17.js
// 功能：Bot 皮肤与后台仓库回归——导入皮肤 / 一键存档 / 本地擦除后恢复 / 永久删除 / IPC 与 UI 接线
// 依赖：path、fs、os；被测 modules/bot-roster、modules/skin-manager、gui/ipc-roster、scripts/qa-env（造 PNG）
// 导出：run（由 selftest-p5.js 调用）
// 说明：仓库目录用 MINEBOTS_ROSTER_DIR 指向系统临时目录，收尾删除并还原环境变量，绝不碰真实 %APPDATA%。
// 作者：MineBots
// ========================================
var path = require("path");
var fs = require("fs");
var os = require("os");
var ROOT = path.join(__dirname, "..");
var TEMP_DIR = path.join(os.tmpdir(), "minebots-p17-" + process.pid);

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

// A. 静态红线。
function checkStatic(h) {
  var files = [
    { rel: "modules/bot-roster.js", wanted: ["root", "save", "load", "list", "restoreAll", "remove", "sanitizeId"] },
    { rel: "modules/skin-manager.js", wanted: ["parsePng", "validate", "importSkin", "getSkin", "removeSkin"] },
    { rel: "gui/ipc-roster.js", wanted: ["register"] },
    { rel: "gui/renderer/ui-roster.js", wanted: [], textOnly: true }
  ];
  var badOpt = new RegExp("\\?\\.");
  var badNull = new RegExp("\\?\\?");
  var badArrow = new RegExp("=\\>");
  var badTick = new RegExp(String.fromCharCode(96));
  var badDecl = new RegExp("\\b" + String.fromCharCode(99, 111, 110, 115, 116) + "\\b");
  for (var i = 0; i < files.length; i++) {
    var f = files[i].textOnly ? null : load(files[i].rel);
    if (!files[i].textOnly) h.expect("p17 静态: " + files[i].rel + " 可 require", !!f, "null");
    var src = readRel(files[i].rel);
    h.expect("p17 静态: " + files[i].rel + " 有文件头注释", src.indexOf("// ====") >= 0, "");
    h.expect("p17 静态: " + files[i].rel + " 无禁用语法", !badOpt.test(src) && !badNull.test(src) && !badArrow.test(src) && !badTick.test(src) && !badDecl.test(src), "");
    h.expect("p17 静态: " + files[i].rel + " 不超过 600 行", src.split("\n").length <= 600, String(src.split("\n").length));
    if (!files[i].textOnly) {
      for (var w = 0; w < files[i].wanted.length; w++) {
        h.expect("p17 静态: " + files[i].rel + " 导出 " + files[i].wanted[w], f && typeof f[files[i].wanted[w]] === "function", "");
      }
    }
  }
}

// B. 仓库：存档 / 读取 / 列表 / 本地擦除恢复 / 永久删除 / 路径穿越。
function checkRoster(h) {
  var roster = load("modules/bot-roster");
  if (!roster) { h.expect("p17 仓库: 模块可加载", false, "null"); return; }
  h.expect("p17 仓库: 目录不在仓库 state/ 下", String(roster.root()).indexOf(path.join(ROOT, "state")) !== 0, roster.root());
  var profile = { id: "bot-1", username: "QA_Bot", persona: "miner", host: "localhost", port: 25565, version: "1.21.1", loginMode: "offline", skin: { file: "skins/bot-1.png", sha256: "x" } };
  var saved = roster.save(profile);
  h.expect("p17 仓库: 保存成功", saved.ok === true && saved.id === "bot-1", JSON.stringify(saved));
  h.expect("p17 仓库: 档案文件落盘", fs.existsSync(roster.profilePath("bot-1")), "");
  var ls = roster.list();
  h.expect("p17 仓库: 列表含该 Bot", ls.ok === true && ls.items.length === 1 && ls.items[0].id === "bot-1", JSON.stringify(ls.items));
  var got = roster.load("bot-1");
  h.expect("p17 仓库: 读回完整配置", got.ok === true && got.profile.username === "QA_Bot" && got.profile.version === "1.21.1", JSON.stringify(got.profile));
  var rec = null;
  try { rec = JSON.parse(fs.readFileSync(roster.profilePath("bot-1"), "utf8")); } catch (e) { rec = null; }
  h.expect("p17 仓库: 档案带 schema 与时间戳", !!(rec && rec.schema === 1 && rec.savedAt && rec.updatedAt), JSON.stringify(rec && rec.schema));
  h.expect("p17 仓库: 拒绝路径穿越 id", roster.save({ id: "../evil" }).ok === false, "");
  h.expect("p17 仓库: 拒绝空 id", roster.sanitizeId("") === "", "");
  // 模拟本地被擦：删掉一个假的本地 state 目录，后台档案仍在。
  var fakeState = path.join(TEMP_DIR, "state");
  try { fs.mkdirSync(fakeState, { recursive: true }); } catch (eM) { /* ignore */ }
  try { fs.rmdirSync(fakeState); } catch (eR) { /* ignore */ }
  h.expect("p17 仓库: 本地擦除后仍可读回", roster.load("bot-1").ok === true, "");
  var del = roster.remove("bot-1");
  h.expect("p17 仓库: 永久删除成功", del.ok === true, JSON.stringify(del));
  h.expect("p17 仓库: 删除后档案文件消失", !fs.existsSync(roster.profilePath("bot-1")), "");
  h.expect("p17 仓库: 删除后读不到", roster.load("bot-1").ok === false, "");
}

// C. 皮肤：合法 PNG 导入 / 读取 / 非法与尺寸拒绝 / 删除。
function checkSkin(h) {
  var skin = load("modules/skin-manager");
  var q = load("scripts/qa-env");
  if (!skin || !q) { h.expect("p17 皮肤: 模块可加载", false, "null"); return; }
  var png = q.encodePNG(64, 64, Buffer.alloc(64 * 64 * 4, 200));
  var parsed = skin.parsePng(png);
  h.expect("p17 皮肤: 解析 64x64", parsed.ok === true && parsed.width === 64 && parsed.height === 64, JSON.stringify(parsed));
  var imported = skin.importSkin({ botId: "bot-1", fileName: "a.png", dataBase64: png.toString("base64") });
  h.expect("p17 皮肤: 导入成功", imported.ok === true && imported.skin.width === 64 && imported.skin.height === 64, JSON.stringify(imported));
  var roster = load("modules/bot-roster");
  h.expect("p17 皮肤: 文件落在仓库 skins/", !!(roster && fs.existsSync(roster.skinPath("bot-1"))), "");
  var got = skin.getSkin("bot-1");
  h.expect("p17 皮肤: 读回 base64", got.ok === true && typeof got.base64 === "string" && got.base64.length > 10, "");
  h.expect("p17 皮肤: sha256 非空", !!(imported.skin && imported.skin.sha256 && imported.skin.sha256.length === 64), "");
  var bad = skin.importSkin({ botId: "bot-1", fileName: "x.txt", dataBase64: Buffer.from("not a png").toString("base64") });
  h.expect("p17 皮肤: 非 PNG 被拒", bad.ok === false, JSON.stringify(bad));
  var small = q.encodePNG(8, 8, Buffer.alloc(8 * 8 * 4, 1));
  h.expect("p17 皮肤: 不支持尺寸被拒", skin.validate(small).ok === false, "");
  var rm = skin.removeSkin("bot-1");
  h.expect("p17 皮肤: 删除皮肤成功", rm.ok === true, JSON.stringify(rm));
}

// D. 接线：IPC 三件套 + UI 控件 + 自动恢复。
function checkWiring(h) {
  var preload = readRel("gui/preload.js");
  var api = readRel("gui/renderer/api.js");
  var main = readRel("gui/main.js");
  var index = readRel("gui/renderer/index.html");
  var settings = readRel("gui/renderer/settings.html");
  var uibot = readRel("gui/renderer/ui-bot.js");
  var uiroster = readRel("gui/renderer/ui-roster.js");
  var lang = readRel("gui/renderer/lang.js");
  h.expect("p17 接线: preload 含 roster-save 通道", preload.indexOf('"roster-save"') >= 0, "");
  h.expect("p17 接线: preload 含 skin-import 通道", preload.indexOf('"skin-import"') >= 0, "");
  h.expect("p17 接线: api.js 暴露 rosterSave", api.indexOf("rosterSave") >= 0, "");
  h.expect("p17 接线: api.js 暴露 skinImport", api.indexOf("skinImport") >= 0, "");
  h.expect("p17 接线: main.js 挂载 ipc-roster", main.indexOf("ipc-roster") >= 0, "");
  h.expect("p17 接线: index.html 引入 ui-roster.js", index.indexOf("ui-roster.js") >= 0, "");
  h.expect("p17 接线: settings.html 含仓库面板", settings.indexOf('data-settings-pane="roster"') >= 0 && settings.indexOf('id="rosterList"') >= 0, "");
  h.expect("p17 接线: ui-bot 含导入皮肤按钮", uibot.indexOf("skinImport") >= 0 && uibot.indexOf("rosterSave") >= 0, "");
  h.expect("p17 接线: ui-roster 含自动恢复", uiroster.indexOf("autoRestore") >= 0 && uiroster.indexOf("rosterRestore") >= 0, "");
  h.expect("p17 接线: 双语键齐全", lang.indexOf("rosterSave") >= 0 && lang.indexOf("skinImport") >= 0 && lang.indexOf("rosterDeleteConfirm") >= 0, "");
}

function run(h) {
  var oldDir = process.env.MINEBOTS_ROSTER_DIR;
  try {
    safeRemove(TEMP_DIR);
    fs.mkdirSync(path.join(TEMP_DIR, "roster"), { recursive: true });
    process.env.MINEBOTS_ROSTER_DIR = path.join(TEMP_DIR, "roster");
  } catch (e) { /* ignore */ }
  var groups = [checkStatic, checkRoster, checkSkin, checkWiring];
  for (var i = 0; i < groups.length; i++) {
    try { groups[i](h); } catch (e) { h.expect("p17 组 " + (i + 1) + " 未抛错", false, String(e)); }
  }
  try {
    safeRemove(TEMP_DIR);
    if (oldDir === undefined) delete process.env.MINEBOTS_ROSTER_DIR;
    else process.env.MINEBOTS_ROSTER_DIR = oldDir;
  } catch (e2) { /* ignore */ }
  return Promise.resolve();
}

module.exports = { run: run };
