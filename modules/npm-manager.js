// ========================================
// 文件：modules/npm-manager.js
// 功能：npm 插件面板的真接口——列出已装 / 安装 / 卸载 / 校验包名（全部走本机 npm CLI）
// 依赖：child_process（Node 内置）、./logger（可选）
// 导出：list、install、uninstall、isValidName、has、NPM_TIMEOUT_MS
// 作者：MineBots
// ========================================
//
// 设计要点：
//   1) 只允许合法包名（/^(@scope\/)?name$|name@version$），避免把任意命令行塞进 shell；
//   2) 一律 execFile + shell:true（Windows 上 npm 是 npm.cmd），带超时，超时直接杀掉；
//   3) 绝不 reject：成功返回 { ok:true, ... }，失败返回 { ok:false, message }。
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

var childProcess = require("child_process");
// 可选依赖：日志核心；缺失时静默。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：单次 npm 命令超时（装包可能要一两分钟）/ 包名白名单正则。
var NPM_TIMEOUT_MS = 180000;
var NAME_RE = /^(@[a-z0-9-._~]+\/)?[a-z0-9][a-z0-9-._~]*(@[a-z0-9-._~^<>=* ]+)?$/;

// 写普通信息日志：只落文件不推 GUI。
function logInfo(message) {
  try { if (logger && typeof logger.info === "function") logger.info(message); } catch (e) { /* ignore */ }
}

// 写告警日志：安装失败要让用户看见，推 GUI。
function logWarn(message) {
  try {
    if (logger && typeof logger.warn === "function") logger.warn(message);
    else console.warn(message);
  } catch (e) { /* ignore */ }
}

// 把异常拍成一行文本，避免在 catch 里再次抛错。
function errText(err) {
  try {
    if (!err) return "unknown error";
    if (err.message) return String(err.message);
    return String(err);
  } catch (e) { return "unknown error"; }
}

// 功能 1：校验包名——只认 npm 合法包名（含 @scope/name 与 name@version），别的一律拒绝。
function isValidName(name) {
  var text = String(name === null || name === undefined ? "" : name).replace(/^\s+|\s+$/g, "");
  if (text.length === 0 || text.length > 214) return false;
  return NAME_RE.test(text);
}

// 内部：跑一条 npm 命令——返回 { ok, code, stdout, stderr, message }，超时 / 找不到 npm 都不抛错。
function runNpm(args, timeoutMs) {
  return new Promise(function (resolve) {
    var done = false;
    var finish = function (result) {
      if (done) return;
      done = true;
      resolve(result);
    };
    try {
      var child = childProcess.execFile(
        "npm", args,
        { timeout: timeoutMs || NPM_TIMEOUT_MS, shell: true, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        function (err, stdout, stderr) {
          var out = String(stdout || "");
          var errOut = String(stderr || "");
          if (err) {
            finish({ ok: false, code: err.code, stdout: out, stderr: errOut, message: errText(err) });
            return;
          }
          finish({ ok: true, code: 0, stdout: out, stderr: errOut, message: "" });
        }
      );
      try { if (child && child.unref) child.unref(); } catch (e1) { /* ignore */ }
    } catch (err) {
      finish({ ok: false, code: -1, stdout: "", stderr: "", message: errText(err) });
    }
  });
}

// 功能 2：列出已安装依赖（含 devDependencies），返回 { ok, packages: [{name, version}] }。
async function list() {
  var res = await runNpm(["ls", "--depth=0", "--json", "--silent"], 60000);
  var text = res.stdout && res.stdout.length > 0 ? res.stdout : res.stderr;
  var data = null;
  try { data = JSON.parse(text); } catch (e) { data = null; }
  if (!data) {
    logWarn("[npm] list failed: " + res.message);
    return { ok: false, packages: [], message: "npm ls failed / 读取已装插件失败: " + res.message };
  }
  var deps = data.dependencies && typeof data.dependencies === "object" ? data.dependencies : {};
  var keys = Object.keys(deps);
  var out = [];
  for (var i = 0; i < keys.length; i++) {
    var version = "";
    try { version = deps[keys[i]] && deps[keys[i]].version ? String(deps[keys[i]].version) : ""; } catch (e) { version = ""; }
    out.push({ name: keys[i], version: version });
  }
  out.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
  return { ok: true, packages: out, message: "" };
}

// 功能 3：安装一个包——包名非法直接拒绝；成功返回 { ok, name, message }。
async function install(name) {
  var wanted = String(name === null || name === undefined ? "" : name).replace(/^\s+|\s+$/g, "");
  if (!isValidName(wanted)) {
    return { ok: false, name: wanted, message: "invalid package name / 包名不合法" };
  }
  logWarn("[npm] installing / 正在安装: " + wanted);
  var res = await runNpm(["install", wanted, "--no-audit", "--no-fund", "--loglevel=error"]);
  if (!res.ok) {
    logWarn("[npm] install " + wanted + " failed: " + res.message + " " + res.stderr);
    return { ok: false, name: wanted, message: "install failed / 安装失败: " + res.message };
  }
  logWarn("[npm] installed / 安装完成: " + wanted);
  return { ok: true, name: wanted, message: "installed / 已安装: " + wanted };
}

// 功能 4：卸载一个包——同样先校验包名，成功返回 { ok, name }。
async function uninstall(name) {
  var wanted = String(name === null || name === undefined ? "" : name).replace(/^\s+|\s+$/g, "");
  if (!isValidName(wanted)) {
    return { ok: false, name: wanted, message: "invalid package name / 包名不合法" };
  }
  var res = await runNpm(["uninstall", wanted, "--no-audit", "--no-fund", "--loglevel=error"]);
  if (!res.ok) {
    logWarn("[npm] uninstall " + wanted + " failed: " + res.message);
    return { ok: false, name: wanted, message: "uninstall failed / 卸载失败: " + res.message };
  }
  return { ok: true, name: wanted, message: "uninstalled / 已卸载: " + wanted };
}

// 功能 5：某个包是否已安装——返回 { ok, name, installed }，读不到包列表时 installed 为 false。
async function has(name) {
  var wanted = String(name === null || name === undefined ? "" : name).replace(/^\s+|\s+$/g, "");
  var res = await list();
  if (!res.ok) return { ok: false, name: wanted, installed: false, message: res.message };
  for (var i = 0; i < res.packages.length; i++) {
    if (res.packages[i].name === wanted) return { ok: true, name: wanted, installed: true, message: "" };
  }
  return { ok: true, name: wanted, installed: false, message: "" };
}

// 对外导出：列表 / 安装 / 卸载 / 校验 / 查询 / 超时常量。
module.exports = {
  list: list,
  install: install,
  uninstall: uninstall,
  isValidName: isValidName,
  has: has,
  NPM_TIMEOUT_MS: NPM_TIMEOUT_MS
};
