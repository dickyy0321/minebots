// ========================================
// 文件：modules/local-probe.js
// 功能：本地推理框架探测与 HTTP 探测——可执行文件探测（含 SGLang 的安装校验）/ 带超时的 GET / 模型清单解析
// 依赖：fs / path / child_process / http（Node 内置）
// 导出：detect / hasSglang / httpGet / parseModels
// 说明：纯工具层，不读配置、不启动进程；所有异常都收敛成 { ok:false, message }，绝不向上抛。
// 作者：MineBots
// ========================================
var fs = require("fs");
var path = require("path");
var http = require("http");
var cp = require("child_process");

var PROBE_TIMEOUT_MS = 1200;

function errText(err) {
  try { return err && err.message ? String(err.message) : String(err); } catch (e) { return "unknown error"; }
}

function exists(p) {
  try { return !!p && fs.existsSync(p); } catch (e) { return false; }
}

// 检查某个 Python 解释器里是否装了 sglang（find_spec 只查模块位置，不真正 import，几百毫秒内返回）。
function hasSglang(exe) {
  try {
    cp.execFileSync(exe, ["-c", "import importlib.util,sys;sys.exit(0 if importlib.util.find_spec('sglang') else 1)"], { stdio: "pipe", timeout: 6000 });
    return true;
  } catch (e) { return false; }
}

// 探测可执行文件：已保存路径 > 环境变量 > where/which > 常见安装目录。
// def 是框架定义（name / exeNames），savedPath 是该实例已保存的 exePath。
function detect(def, savedPath) {
  try {
    if (!def || !def.name) return { ok: false, message: "未知本地框架 / unknown framework" };
    var key = def.name;
    if (savedPath && exists(savedPath)) return { ok: true, path: savedPath, source: "saved" };
    var envKey = "MINEBOTS_" + key.toUpperCase() + "_PATH";
    var envPath = process.env[envKey];
    if (envPath && exists(envPath)) return { ok: true, path: envPath, source: "env" };
    var names = Array.isArray(def.exeNames) ? def.exeNames : [];
    for (var i = 0; i < names.length; i++) {
      try {
        var cmd = process.platform === "win32" ? "where" : "which";
        var out = cp.execFileSync(cmd, [names[i]], { stdio: "pipe", timeout: 5000 });
        var text = String(out || "").split(/\r?\n/)[0].replace(/^\s+|\s+$/g, "");
        if (text && exists(text)) {
          // SGLang 只认真装了 sglang 的 Python：随便一个 python.exe 启动必然秒退。
          if (key === "sglang" && !hasSglang(text)) continue;
          return { ok: true, path: text, source: "path" };
        }
      } catch (eW) { /* 继续候选 */ }
    }
    var cands = [];
    var la = process.env.LOCALAPPDATA || "";
    var pf = process.env.ProgramFiles || "C:/Program Files";
    if (key === "ollama") {
      if (la) cands.push(path.join(la, "Programs", "Ollama", "ollama.exe"));
      cands.push(path.join(pf, "Ollama", "ollama.exe"));
      cands.push("G:/Ollama/ollama.exe");
    } else if (key === "lmstudio") {
      if (la) cands.push(path.join(la, "Programs", "LM Studio", "LM Studio.exe"));
    } else if (key === "llamacpp") {
      cands.push(path.join(process.cwd(), "llama-server.exe"));
    }
    for (var j = 0; j < cands.length; j++) {
      if (exists(cands[j])) return { ok: true, path: cands[j], source: "candidate" };
    }
    if (key === "sglang") {
      return { ok: false, message: "找到 Python 但没装 sglang：先 pip install \"sglang[all]\" / python found but sglang missing" };
    }
    return { ok: false, message: "没探测到，请手动填路径 / not found, set path manually" };
  } catch (e) { return { ok: false, message: errText(e) }; }
}

// HTTP GET（带超时），用于状态与模型列表。
function httpGet(url, timeoutMs) {
  return new Promise(function (resolve) {
    var done = false;
    var req = null;
    var finish = function (res) { if (!done) { done = true; resolve(res); } };
    try {
      req = http.get(url, function (res) {
        var body = "";
        res.setEncoding("utf8");
        res.on("data", function (chunk) { body += chunk; });
        res.on("end", function () { finish({ ok: true, status: res.statusCode, body: body }); });
      });
      req.setTimeout(Number(timeoutMs) || PROBE_TIMEOUT_MS, function () {
        try { req.destroy(); } catch (eD) { /* ignore */ }
        finish({ ok: false, message: "timeout" });
      });
      req.on("error", function (err) { finish({ ok: false, message: errText(err) }); });
    } catch (e) { finish({ ok: false, message: errText(e) }); }
  });
}

// 把 /v1/models 或 /api/tags 的响应解析成模型名数组。
function parseModels(body) {
  var out = [];
  try {
    var data = JSON.parse(String(body || "{}"));
    var list = Array.isArray(data.data) ? data.data : (Array.isArray(data.models) ? data.models : []);
    for (var i = 0; i < list.length; i++) {
      var it = list[i] || {};
      var id = it.id || it.name || it.model || "";
      if (id) out.push(String(id));
    }
  } catch (e) { /* ignore */ }
  return out;
}

module.exports = { detect: detect, hasSglang: hasSglang, httpGet: httpGet, parseModels: parseModels };
