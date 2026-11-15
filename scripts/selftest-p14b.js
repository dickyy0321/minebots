// ========================================
// 文件：scripts/selftest-p14b.js
// 功能：P14 模块4 回归自测——模型档案池 Model Profile：与 Ollama 解耦、deepseek/ollama/hunyuan 档案、
//       每 bot 独立选档案、内存共享单例（100 bot 只占一份引擎内存）、ai-client 读档覆盖接入参数
// 依赖：path、fs、os；被测模块 model-profile、ai-client（可选，缺了记失败而不崩）
// 导出：run（由 selftest-p5.js 调用）
// 作者：MineBots
// ========================================
// 说明：全程离线，无真实 HTTP；落盘经 MINEBOTS_STATE_DIR 重定向，收尾删除临时目录，
//   真实 state/、真实网络均不受影响。
var path = require("path");
var fs = require("fs");
var os = require("os");
var ROOT = path.join(__dirname, "..");
var TEMP_DIR = path.join(os.tmpdir(), "minebots-p14b-" + process.pid);

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
  var mp = load("modules/model-profile");
  if (mp && typeof mp.reset === "function") mp.reset();
}

function checkStatic(h) {
  h.section("31a. 模型档案池静态红线 / static");
  var text = readRel("modules/model-profile.js");
  var ac = readRel("modules/ai-client.js");
  var banned = [/\?\./, /\?\?/, /^import\s+/m, /^export\s+/m, /\bconst\b/, /\blet\b/, /=>/, /\x60/];
  var ok = text.indexOf("// ====") === 0 && text.split("\n").length <= 600 &&
    ac.indexOf("// ====") === 0 && ac.split("\n").length <= 600;
  for (var j = 0; j < banned.length; j++) if (banned[j].test(text) || banned[j].test(ac)) ok = false;
  h.expect("model-profile.js / ai-client.js 满足头注释 / 600 行 / 禁用语法", ok, "");
  h.expect("ai-client 接入模型档案池（解耦 Ollama）", ac.indexOf("model-profile") > 0 && ac.indexOf("applyTo") > 0, "");
}

function checkProfiles(h) {
  h.section("31b. 档案预设与单例 / profiles");
  fresh();
  var mp = load("modules/model-profile");
  if (!mp) { h.expect("model-profile 可加载", false, "null"); return; }
  var list = mp.list();
  var names = list.map(function (x) { return x.name; });
  h.expect("预设含 deepseek/ollama/hunyuan", names.indexOf("deepseek") >= 0 && names.indexOf("ollama") >= 0 && names.indexOf("hunyuan") >= 0, JSON.stringify(names));
  h.expect("档案对象是进程内共享单例（同一引用）", mp.get("deepseek") === mp.get("deepseek"), "");
  // 选档：每 bot 独立指向不同档案。
  mp.setFor("bot-1", "deepseek", {});
  mp.setFor("bot-2", "hunyuan", {});
  h.expect("bot-1 选 deepseek / bot-2 选 hunyuan", mp.profileOf("bot-1").profile === "deepseek" && mp.profileOf("bot-2").profile === "hunyuan", JSON.stringify(mp.assignments()));
  // 100 bot 用同一引擎只存一份引擎内存：所有选 deepseek 的 bot 指向同一档案对象。
  for (var i = 0; i < 100; i++) mp.setFor("s" + i, "deepseek", {});
  var first = mp.get("deepseek");
  var same = true;
  for (var k = 0; k < 100; k++) if (mp.configFor("s" + k).provider !== first.provider) same = false;
  h.expect("100 个 bot 选 deepseek 共用同一份引擎预设", same && mp.stats().assignments === 102, JSON.stringify(mp.stats()));
  // 未选档的 bot 不覆盖原配置：provider 回落默认。
  h.expect("未选档 bot 默认走云端档案 / default profile is cloud", mp.profileOf("nobody").profile === "deepseek", JSON.stringify(mp.profileOf("nobody")));
}

function checkApply(h) {
  h.section("31c. 档案覆盖接入参数 / apply");
  fresh();
  var mp = load("modules/model-profile");
  var ac = load("modules/ai-client");
  if (!mp || !ac) { h.expect("model-profile / ai-client 可加载", false, "null"); return; }
  mp.setFor("bot-7", "deepseek", {});
  var cfg = mp.configFor("bot-7");
  h.expect("选档后 configFor 接入参数被档案覆盖", cfg.profile === "deepseek" && cfg.provider === "cloud" && cfg.engine === "custom" && cfg.model === "deepseek-chat" && cfg.baseUrl.indexOf("deepseek") >= 0, JSON.stringify(cfg));
  // applyTo 给 ai-client 用：custom 档不覆盖手填配置。
  mp.setFor("bot-7", "custom", { baseUrl: "http://x", model: "m", engine: "x", provider: "x" });
  var base = { baseUrl: "http://x", model: "m", engine: "x", provider: "x" };
  var applied = mp.applyTo("bot-7", base);
  h.expect("custom 档 applyTo 保留手填配置不被档案改写", applied.provider === "x" && applied.model === "m", JSON.stringify(applied));
  // 集成：ai-client 在解析接入时读取档案池（解耦 Ollama 后仍能拿到 deepseek 配置）。
  var probe = mp.applyTo("bot-7", { baseUrl: "", model: "", provider: "local", engine: "ollama" });
  h.expect("ai-client 走 applyTo 接入档案池（单一来源）", typeof probe.profile === "string", JSON.stringify(probe));
}

function run(h) {
  var groups = [checkStatic, checkProfiles, checkApply];
  for (var i = 0; i < groups.length; i++) {
    try { groups[i](h); } catch (e) { h.expect("31 组 " + (i + 1) + " 未抛错", false, String(e)); }
  }
  try { if (fs.existsSync(TEMP_DIR)) safeRemove(TEMP_DIR); } catch (e) { /* ignore */ }
}

module.exports = { run: run };
