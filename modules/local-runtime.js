// ========================================
// 文件：modules/local-runtime.js
// 功能：本地推理运行时——按「标签 / 实例」管理：每个标签 = 推理框架 + 模型 + 参数（temperature / topP / maxTokens）+ 端口 + 程序路径
// 依赖：fs / path / os / child_process（Node 内置）、./local-probe（探测与 HTTP）、./logger（可选）
// 导出：listInstances / createInstance / removeInstance / listFrameworks / getConfig / saveConfig / detect /
//       status / models / start / stop / importModel / removeModel / getState / FRAMEWORKS
// 说明：配置存 state/local-runtimes.json（MINEBOTS_STATE_DIR 可隔离）。多个标签可同时运行（各自端口），
//       分别供给不同 Bot；启动只拉起本进程登记的子进程，停止只杀自己拉起的进程树。
// 作者：MineBots
// ========================================
var fs = require("fs");
var path = require("path");
var os = require("os");
var cp = require("child_process");

var probe = null;
try { probe = require("./local-probe"); } catch (e) { probe = null; }
var logger = null;
try { logger = require("./logger"); } catch (e2) { logger = null; }

var FILE_NAME = "local-runtimes.json";
var ID_LIMIT = 40;
var MAX_PORT = 65535;

// 本地框架定义：默认端口 / 可执行文件候选 / 启动参数 / 是否需要模型。
var FRAMEWORKS = {
  ollama: {
    name: "ollama", label: "Ollama", defaultPort: 11434, kind: "serve",
    exeNames: ["ollama.exe", "ollama"],
    startArgs: function () { return ["serve"]; },
    note: "Ollama 服务（ollama serve）/ Ollama server"
  },
  lmstudio: {
    name: "lmstudio", label: "LM Studio", defaultPort: 1234, kind: "app",
    exeNames: ["LM Studio.exe", "lms.exe"],
    startArgs: function () { return []; },
    note: "LM Studio 本机服务（端口在设置里开）/ LM Studio local server"
  },
  llamacpp: {
    name: "llamacpp", label: "llama.cpp", defaultPort: 8080, kind: "serve",
    exeNames: ["llama-server.exe", "llama-server"],
    startArgs: function (cfg) { return ["-m", String(cfg.model || ""), "--port", String(cfg.port || 8080)]; },
    needsModel: true,
    note: "llama-server -m 模型.gguf --port 8080"
  },
  sglang: {
    name: "sglang", label: "SGLang", defaultPort: 30000, kind: "python",
    exeNames: ["python.exe", "python3.exe", "python"],
    startArgs: function (cfg) { return ["-m", "sglang.launch_server", "--model-path", String(cfg.model || ""), "--port", String(cfg.port || 30000)]; },
    needsModel: true,
    note: "python -m sglang.launch_server --model-path 模型 --port 30000"
  },
  custom: {
    name: "custom", label: "自定义 / Custom", defaultPort: 8000, kind: "custom",
    exeNames: [],
    startArgs: function (cfg) { return splitArgs(cfg.extraArgs || ""); },
    note: "自己填可执行文件与启动参数 / your own exe and args"
  }
};

// 本进程拉起的框架进程（按标签 ID 登记）/ 秒退记录 / 运行统计。
var children = {};
var exits = {};
var totals = { started: 0, stopped: 0, probes: 0, created: 0 };

function errText(err) {
  try { return err && err.message ? String(err.message) : String(err); } catch (e) { return "unknown error"; }
}
function logInfo(msg) {
  try { if (logger && typeof logger.info === "function") { logger.info("[local-runtime] " + msg); return; } } catch (e) { /* console */ }
  try { console.log("[local-runtime] " + msg); } catch (e2) { /* ignore */ }
}
function toText(v) {
  try { return String(v === null || v === undefined ? "" : v); } catch (e) { return ""; }
}
function exists(p) {
  try { return !!p && fs.existsSync(p); } catch (e) { return false; }
}
function trim(v) { return toText(v).replace(/^\s+|\s+$/g, ""); }

// 洗框架名：只认白名单，未知一律空串。
function cleanFramework(v) {
  var t = trim(v).toLowerCase();
  return Object.prototype.hasOwnProperty.call(FRAMEWORKS, t) ? t : "";
}

// 洗标签 ID：字母数字下划线横杠点，最长 40。
function cleanId(v) {
  var t = trim(v);
  if (!t || !/^[A-Za-z0-9_.-]+$/.test(t)) return "";
  return t.length > ID_LIMIT ? t.slice(0, ID_LIMIT) : t;
}

function cleanPort(v) {
  var n = Number(v);
  if (!isFinite(n) || n < 1 || n > MAX_PORT) return 0;
  return Math.floor(n);
}

// 洗数值参数：超出范围回退默认值。
function clampNum(v, min, max, def) {
  var n = Number(v);
  if (!isFinite(n)) return def;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

// 洗模型名数组：去空、去重（不区分大小写）、限长限数量。
function cleanList(value) {
  var out = [];
  try {
    var list = Array.isArray(value) ? value : [];
    var seen = {};
    for (var i = 0; i < list.length && out.length < 120; i++) {
      var one = trim(list[i]).slice(0, 200);
      if (!one) continue;
      var key = one.toLowerCase();
      if (seen[key]) continue;
      seen[key] = true;
      out.push(one);
    }
  } catch (e) { return out; }
  return out;
}

function mergeModels(custom, probed) {
  return cleanList(cleanList(custom).concat(cleanList(probed)));
}

// 把 "a b \"c d\"" 这样的参数串切开（简单引号支持）。
function splitArgs(text) {
  var out = [], cur = "", q = false, s = toText(text);
  for (var i = 0; i < s.length; i++) {
    var ch = s.charAt(i);
    if (ch === "\"") { q = !q; continue; }
    if ((ch === " " || ch === "\t") && !q) { if (cur) { out.push(cur); cur = ""; } continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

// 配置路径：MINEBOTS_STATE_DIR 优先。
function getPath() {
  try {
    var custom = process.env.MINEBOTS_STATE_DIR;
    if (custom && String(custom).length > 0) return path.resolve(String(custom), FILE_NAME);
    return path.resolve(process.cwd(), "state", FILE_NAME);
  } catch (e) { return path.join("state", FILE_NAME); }
}

// 单个标签的默认值（新标签 / 老配置缺字段都走这里）。
function defaultsOf(framework, id) {
  var key = cleanFramework(framework) || "custom";
  var def = FRAMEWORKS[key];
  var port = def ? def.defaultPort : 8000;
  return {
    id: cleanId(id) || key, label: def ? def.label : "自定义 / Custom", framework: key,
    port: port, model: "", exePath: "", extraArgs: "",
    temperature: 0.7, topP: 0.9, maxTokens: 256,
    customModels: [], lastModels: [], baseUrl: "http://127.0.0.1:" + port + "/v1"
  };
}

// 归一化：任何脏数据都不允许进入界面或写盘。
function normalize(item) {
  var src = item && typeof item === "object" ? item : {};
  var framework = cleanFramework(src.framework) || cleanFramework(src.id) || "custom";
  var out = defaultsOf(framework, src.id || framework);
  out.label = trim(src.label).slice(0, 40) || out.label;
  var p = cleanPort(src.port);
  out.port = p > 0 ? p : out.port;
  out.model = trim(src.model).slice(0, 260);
  out.exePath = trim(src.exePath).slice(0, 520);
  out.extraArgs = trim(src.extraArgs).slice(0, 520);
  out.temperature = clampNum(src.temperature, 0, 2, 0.7);
  out.topP = clampNum(src.topP, 0, 1, 0.9);
  out.maxTokens = Math.floor(clampNum(src.maxTokens, 1, 65536, 256));
  out.customModels = cleanList(src.customModels);
  out.lastModels = cleanList(src.lastModels);
  out.baseUrl = "http://127.0.0.1:" + out.port + "/v1";
  out.models = mergeModels(out.customModels, out.lastModels);
  return out;
}

// 默认种子：每个框架一个标签，老的「按框架存」配置也能原样迁移。
function seedItems() {
  var names = Object.keys(FRAMEWORKS);
  var out = [];
  for (var i = 0; i < names.length; i++) out.push(normalize(defaultsOf(names[i], names[i])));
  return out;
}

// 读盘：兼容旧格式（{ ollama:{...}, sglang:{...} }）→ 新格式（{ version:2, items:[...] }）。
function loadItems() {
  try {
    var file = getPath();
    if (!exists(file)) return seedItems();
    var parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && Array.isArray(parsed.items)) {
      var list = [];
      for (var i = 0; i < parsed.items.length; i++) list.push(normalize(parsed.items[i]));
      return list.length > 0 ? list : seedItems();
    }
    var legacy = [];
    if (parsed && typeof parsed === "object") {
      var keys = Object.keys(parsed);
      for (var j = 0; j < keys.length; j++) {
        var fw = cleanFramework(keys[j]);
        if (!fw) continue;
        var old = parsed[keys[j]] && typeof parsed[keys[j]] === "object" ? parsed[keys[j]] : {};
        old.framework = fw;
        old.id = fw;
        legacy.push(normalize(old));
      }
    }
    return legacy.length > 0 ? legacy : seedItems();
  } catch (e) { return seedItems(); }
}

function saveItems(items) {
  try {
    var file = getPath();
    var dir = path.dirname(file);
    if (!exists(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 2, items: items }, null, 2), "utf8");
    return true;
  } catch (e) {
    logInfo("本地配置写盘失败 / save failed: " + errText(e));
    return false;
  }
}

// 按名字找标签：先按 ID，再按框架（取该框架第一个标签）。
function findItem(name) {
  var items = loadItems();
  var id = cleanId(name);
  if (id) {
    for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i];
  }
  var fw = cleanFramework(name);
  if (fw) {
    for (var j = 0; j < items.length; j++) if (items[j].framework === fw) return items[j];
  }
  return null;
}

// 运行态补充：running / pid / exits 提示。
function withState(item) {
  var out = {};
  for (var k in item) { if (Object.prototype.hasOwnProperty.call(item, k)) out[k] = item[k]; }
  var rec = children[item.id];
  out.running = !!(rec && rec.pid);
  out.pid = rec ? rec.pid : 0;
  out.frameworkLabel = FRAMEWORKS[item.framework] ? FRAMEWORKS[item.framework].label : item.framework;
  return out;
}

// 功能：列出全部标签（含运行态，不做任何网络探测）。
function listInstances() {
  var items = loadItems();
  var out = [];
  for (var i = 0; i < items.length; i++) out.push(withState(items[i]));
  return { ok: true, items: out, path: getPath(), running: Object.keys(children).length };
}

// 功能：新建标签——默认端口从框架默认端口往上找空闲的，ID 自动避重。
function createInstance(payload) {
  try {
    var p = payload && typeof payload === "object" ? payload : {};
    var framework = cleanFramework(p.framework) || "custom";
    var items = loadItems();
    var n = 1, id = "";
    while (true) {
      id = framework + "-" + n;
      var dup = false;
      for (var i = 0; i < items.length; i++) if (items[i].id === id) dup = true;
      if (!dup) break;
      n = n + 1;
      if (n > 99) return { ok: false, message: "标签太多 / too many instances" };
    }
    var port = cleanPort(p.port);
    if (port === 0) {
      var base = FRAMEWORKS[framework].defaultPort;
      port = base;
      for (var step = 0; step < 60; step++) {
        var used = false;
        for (var j = 0; j < items.length; j++) if (items[j].port === port) used = true;
        if (!used) break;
        port = port + 1;
        if (port > MAX_PORT) { port = base; break; }
      }
    }
    var item = normalize({
      id: id, label: trim(p.label).slice(0, 40) || (FRAMEWORKS[framework].label + " #" + n),
      framework: framework, port: port, model: p.model || ""
    });
    items.push(item);
    if (!saveItems(items)) return { ok: false, message: "写盘失败 / save failed" };
    totals.created = totals.created + 1;
    logInfo("新建标签 / instance created: " + item.id);
    return { ok: true, item: withState(item), items: listInstances().items };
  } catch (e) { return { ok: false, message: errText(e) }; }
}

// 功能：删除标签（正在运行的先停止；删到一个不剩时恢复默认种子）。
function removeInstance(name) {
  try {
    var item = findItem(name);
    if (!item) return { ok: false, message: "找不到标签 / instance not found" };
    if (children[item.id]) return { ok: false, message: "先停止再删除 / stop before removing" };
    var items = loadItems();
    var keep = [];
    for (var i = 0; i < items.length; i++) if (items[i].id !== item.id) keep.push(items[i]);
    if (keep.length === 0) keep = seedItems();
    if (!saveItems(keep)) return { ok: false, message: "写盘失败 / save failed" };
    delete exits[item.id];
    return { ok: true, removed: item.id, items: listInstances().items, message: "已删除 / removed: " + item.id };
  } catch (e) { return { ok: false, message: errText(e) }; }
}

// 功能：取某个标签的配置（按 ID 或框架名都能取）。
function getConfig(name) {
  var item = findItem(name);
  if (!item) return { ok: false, message: "未知本地标签 / unknown instance: " + toText(name) };
  var out = withState(item);
  out.label = item.label;
  return { ok: true, config: out, note: FRAMEWORKS[item.framework] ? FRAMEWORKS[item.framework].note : "" };
}

// 功能：保存某个标签的配置（只覆盖传入字段）；运行中改端口直接拒绝，避免端口和进程对不上。
function saveConfig(name, patch) {
  try {
    var item = findItem(name);
    if (!item) return { ok: false, message: "未知本地标签 / unknown instance: " + toText(name) };
    var p = patch && typeof patch === "object" ? patch : {};
    var next = item;
    if (p.port !== undefined) {
      var port = cleanPort(p.port);
      if (port === 0) return { ok: false, message: "端口必须 1-65535 / invalid port" };
      if (port !== item.port && children[item.id]) return { ok: false, message: "运行中不能改端口，先停止 / stop before changing port" };
      next.port = port;
    }
    if (p.framework !== undefined) {
      var fw = cleanFramework(p.framework);
      if (!fw) return { ok: false, message: "未知框架 / unknown framework" };
      if (fw !== item.framework && children[item.id]) return { ok: false, message: "运行中不能换框架，先停止 / stop before switching framework" };
      // 换框架时：端口还是旧框架的默认值就跟着换成新框架默认端口，名字还是旧框架默认名就跟着改名（用户自定义过的不动）。
      if (fw !== item.framework) {
        var oldDef = FRAMEWORKS[item.framework];
        var newDef = FRAMEWORKS[fw];
        if (p.port === undefined && oldDef && newDef && item.port === oldDef.defaultPort) next.port = newDef.defaultPort;
        if ((p.label === undefined || !trim(p.label)) && oldDef && newDef && item.label === oldDef.label) next.label = newDef.label;
      }
      next.framework = fw;
    }
    if (p.label !== undefined) next.label = trim(p.label).slice(0, 40) || next.label;
    if (p.model !== undefined) next.model = trim(p.model).slice(0, 260);
    if (p.exePath !== undefined) next.exePath = trim(p.exePath).slice(0, 520);
    if (p.extraArgs !== undefined) next.extraArgs = trim(p.extraArgs).slice(0, 520);
    if (p.temperature !== undefined) next.temperature = clampNum(p.temperature, 0, 2, next.temperature);
    if (p.topP !== undefined) next.topP = clampNum(p.topP, 0, 1, next.topP);
    if (p.maxTokens !== undefined) next.maxTokens = Math.floor(clampNum(p.maxTokens, 1, 65536, next.maxTokens));
    if (p.customModels !== undefined) next.customModels = cleanList(p.customModels);
    if (p.lastModels !== undefined) next.lastModels = cleanList(p.lastModels);
    next = normalize(next);
    var items = loadItems();
    var hit = false;
    for (var i = 0; i < items.length; i++) if (items[i].id === item.id) { items[i] = next; hit = true; }
    if (!hit) items.push(next);
    if (!saveItems(items)) return { ok: false, message: "写盘失败 / save failed" };
    return { ok: true, config: withState(next), message: "已保存 / saved: " + next.label };
  } catch (e) { return { ok: false, message: errText(e) }; }
}

// 功能：按框架列默认标签（兼容旧界面与自测：每个框架给一个代表实例）。
function listFrameworks() {
  var out = [];
  var items = loadItems();
  var names = Object.keys(FRAMEWORKS);
  for (var i = 0; i < names.length; i++) {
    var pick = null;
    for (var j = 0; j < items.length; j++) if (items[j].framework === names[i]) { pick = items[j]; break; }
    if (!pick) continue;
    var cfg = withState(pick);
    out.push({ name: names[i], label: FRAMEWORKS[names[i]].label, note: FRAMEWORKS[names[i]].note, config: cfg, models: cfg.models, id: cfg.id });
  }
  return { ok: true, frameworks: out };
}

// 功能：探测某个标签的可执行文件（按标签保存的路径优先）。
function detect(name) {
  var item = findItem(name);
  var fw = item ? item.framework : cleanFramework(name);
  var def = FRAMEWORKS[fw];
  if (!def) return { ok: false, message: "未知本地框架 / unknown framework" };
  if (!probe || typeof probe.detect !== "function") return { ok: false, message: "探测模块未加载 / probe module missing" };
  return probe.detect(def, item ? item.exePath : "");
}

// 功能：状态——请求该标签端口的 /v1/models（Ollama 兼容 /api/tags）。
async function status(name) {
  var item = findItem(name);
  if (!item) return { ok: false, running: false, message: "未知本地标签 / unknown instance" };
  totals.probes = totals.probes + 1;
  var base = "http://127.0.0.1:" + item.port;
  if (!probe || typeof probe.httpGet !== "function") return { ok: false, running: false, message: "探测模块未加载 / probe module missing" };
  var res = await probe.httpGet(base + "/v1/models", 1200);
  var ms = probe.parseModels(res.ok ? res.body : "");
  if (!res.ok && item.framework === "ollama") {
    res = await probe.httpGet(base + "/api/tags", 1200);
    ms = probe.parseModels(res.ok ? res.body : "");
  }
  var running = !!(res.ok && res.status >= 200 && res.status < 300);
  if (running && ms.length > 0 && ms.join("|") !== item.lastModels.join("|")) {
    try { saveConfig(item.id, { lastModels: ms }); } catch (eC) { /* 缓存失败不影响状态 */ }
  }
  var merged = mergeModels(item.customModels, ms);
  var msg = running ? ("运行中 / running: " + merged.length + " models") : "未运行或未响应 / not running";
  var ex = exits[item.id];
  if (!running && ex && (Date.now() - ex.at) < 120000) {
    msg = "启动后立刻退出（code " + ex.code + "）：可能未安装对应库、端口被占用或模型路径不对 / exited right after start";
  }
  return {
    ok: running, running: running, framework: item.framework, id: item.id, label: item.label,
    port: item.port, models: merged, probed: ms.length, imported: item.customModels.length,
    model: item.model, message: msg
  };
}

// 功能：模型列表（状态里已经带了，单独提供接口方便界面刷新）。
async function models(name) {
  var st = await status(name);
  return { ok: st.ok, running: st.running, id: st.id, framework: st.framework, port: st.port, models: st.models || [], model: st.model, message: st.message };
}

// 功能：导入模型——登记到该标签的自定义清单，并设为启动模型。
function importModel(name, model) {
  try {
    var item = findItem(name);
    if (!item) return { ok: false, message: "未知本地标签 / unknown instance" };
    var text = trim(model).slice(0, 200);
    if (!text) return { ok: false, message: "模型名不能为空 / model name required" };
    var list = cleanList(item.customModels);
    var hit = false;
    for (var i = 0; i < list.length; i++) if (list[i].toLowerCase() === text.toLowerCase()) { list[i] = text; hit = true; }
    if (!hit) list.push(text);
    var saved = saveConfig(item.id, { customModels: list, model: text });
    if (!saved.ok) return saved;
    return { ok: true, id: item.id, framework: item.framework, model: text, models: saved.config.models, message: "已导入 / imported: " + text };
  } catch (e) { return { ok: false, message: "导入失败 / import failed: " + errText(e) }; }
}

// 功能：移除导入的模型（只删自定义清单，不碰模型文件）。
function removeModel(name, model) {
  try {
    var item = findItem(name);
    if (!item) return { ok: false, message: "未知本地标签 / unknown instance" };
    var text = trim(model);
    if (!text) return { ok: false, message: "先选一个模型 / select a model first" };
    var list = cleanList(item.customModels);
    var keep = [], removed = false;
    for (var i = 0; i < list.length; i++) {
      if (list[i].toLowerCase() === text.toLowerCase()) { removed = true; continue; }
      keep.push(list[i]);
    }
    if (!removed) return { ok: false, models: item.models, message: "只能移除导入的模型 / only imported models can be removed" };
    var patch = { customModels: keep };
    if (trim(item.model).toLowerCase() === text.toLowerCase()) patch.model = "";
    var saved = saveConfig(item.id, patch);
    if (!saved.ok) return saved;
    return { ok: true, id: item.id, models: saved.config.models, message: "已移除 / removed: " + text };
  } catch (e) { return { ok: false, message: "移除失败 / remove failed: " + errText(e) }; }
}

// 功能：启动某个标签——解析路径、检查端口占用、按框架拼参数，只拉起本进程登记的子进程。
function start(name) {
  try {
    var item = findItem(name);
    if (!item) return { ok: false, message: "未知本地标签 / unknown instance" };
    if (children[item.id]) return { ok: true, pid: children[item.id].pid, message: "已在运行（本进程启动）/ already started" };
    delete exits[item.id];
    // 端口占用检查：两个标签撞同一端口时，第二个必须被挡住，否则会静默打到别人的服务上。
    var others = Object.keys(children);
    for (var i = 0; i < others.length; i++) {
      var rec = children[others[i]];
      var cfgOther = findItem(others[i]);
      if (rec && cfgOther && cfgOther.port === item.port) {
        return { ok: false, portBusy: true, message: "端口 " + item.port + " 已被标签 " + others[i] + " 占用 / port already used by " + others[i] };
      }
    }
    var def = FRAMEWORKS[item.framework];
    var detected = detect(item.id);
    var exe = item.exePath && exists(item.exePath) ? item.exePath : (detected.ok ? detected.path : "");
    if (!exe) return { ok: false, needPath: true, message: "缺少程序路径，请探测或手填 / exe path required" };
    if (def.needsModel && !trim(item.model)) return { ok: false, needModel: true, message: "请先填模型（或模型路径）/ model required" };
    var args = def.startArgs(item);
    var child = cp.spawn(exe, args, { cwd: path.dirname(exe), stdio: "ignore", windowsHide: true, detached: false });
    if (!child || !child.pid) return { ok: false, message: "启动失败 / spawn failed" };
    children[item.id] = { pid: child.pid, child: child, at: Date.now() };
    try {
      child.on("exit", function (code) {
        if (children[item.id] && children[item.id].pid === child.pid) delete children[item.id];
        exits[item.id] = { code: code === null || code === undefined ? -1 : code, at: Date.now() };
        logInfo("标签进程退出 / instance exited: " + item.id + " code=" + exits[item.id].code);
      });
    } catch (eE) { /* ignore */ }
    totals.started = totals.started + 1;
    logInfo("已启动 / started: " + item.id + " pid=" + child.pid + " port=" + item.port);
    return { ok: true, id: item.id, pid: child.pid, exe: exe, args: args, port: item.port, message: "已启动 / started: " + item.label };
  } catch (e) { return { ok: false, message: "启动异常 / start error: " + errText(e) }; }
}

// 功能：停止某个标签（只杀本进程拉起的进程树）。
function stop(name) {
  try {
    var item = findItem(name);
    if (!item) return { ok: false, message: "未知本地标签 / unknown instance" };
    var rec = children[item.id];
    if (!rec || !rec.pid) return { ok: false, message: "没有本进程启动的实例 / not started by us" };
    if (process.platform === "win32") {
      try { cp.execFileSync("taskkill", ["/PID", String(rec.pid), "/T", "/F"], { stdio: "pipe", timeout: 15000 }); } catch (eK) { /* 已退出 */ }
    } else {
      try { process.kill(rec.pid); } catch (eK2) { /* ignore */ }
    }
    delete children[item.id];
    delete exits[item.id];
    totals.stopped = totals.stopped + 1;
    return { ok: true, id: item.id, pid: rec.pid, message: "已停止 / stopped: " + item.label };
  } catch (e) { return { ok: false, message: errText(e) }; }
}

function getState() {
  var running = {};
  for (var k in children) { if (Object.prototype.hasOwnProperty.call(children, k)) running[k] = children[k].pid; }
  return { ok: true, running: running, count: Object.keys(running).length, totals: totals, path: getPath() };
}

module.exports = {
  FRAMEWORKS: FRAMEWORKS,
  listInstances: listInstances, createInstance: createInstance, removeInstance: removeInstance,
  listFrameworks: listFrameworks, getConfig: getConfig, saveConfig: saveConfig, detect: detect,
  status: status, models: models, start: start, stop: stop,
  importModel: importModel, removeModel: removeModel, getState: getState
};
