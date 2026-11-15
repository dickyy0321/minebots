// ========================================
// 文件：modules/model-profile.js
// 功能：模型档案池（Model Profile）——API 接入与 Ollama 解耦，按 bot 独立选档案，档案对象内存共享单例
// 依赖：fs / path（Node 内置）、./ai-config（可选）、./logger（可选）
// 导出：list / get / profileOf / setFor / removeFor / configFor / applyTo / assignments / stats / reset /
//       bind / unbind / bindingOf / listBindings / DEFINITIONS / DEFAULT_PROFILE / FILE_NAME / BIND_FILE
// 说明：state/model-profiles.json 只存 { botId: 档案名 } 的映射；state/model-bindings.json 存
//       { botId: { engine, model, baseUrl, port } } 的独立绑定（两个 bot 可各用不同框架的不同模型）。
//       档案本体（地址 / 模型 / provider）在进程内只有一份实例，100 个 bot 选同一档案也只占一份内存。
//       支持 MINEBOTS_STATE_DIR 隔离。
// 作者：MineBots
// ========================================

// 可选依赖：AI 配置中心（合并用户自定义字段）与日志核心，缺失时降级。
var aiConfig = null;
try { aiConfig = require("./ai-config"); } catch (e) { aiConfig = null; }
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

var fs = require("fs");
var path = require("path");

// 常量：档案定义表——每个档案是「接入参数包」，而不是每个 bot 一份拷贝。
// needsKey 表示云端必须填 API Key；local 档案一律不联网也能跑。
var DEFINITIONS = {
  ollama: {
    name: "ollama", label: "本地配置 · Ollama / Local · Ollama", provider: "local", engine: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1", model: "phi", needsKey: false,
    note: "本地离线，零费用 / offline & free"
  },
  lmstudio: {
    name: "lmstudio", label: "LM Studio 本地 / LM Studio local", provider: "local", engine: "lmstudio",
    baseUrl: "http://127.0.0.1:1234/v1", model: "local-model", needsKey: false,
    note: "需先启动 LM Studio 本地服务 / start LM Studio server first"
  },
  llamacpp: {
    name: "llamacpp", label: "llama.cpp 本地 / llama.cpp local", provider: "local", engine: "llamacpp",
    baseUrl: "http://127.0.0.1:8080/v1", model: "local-model", needsKey: false,
    note: "需 llama-server -m 模型.gguf --port 8080"
  },
  deepseek: {
    name: "deepseek", label: "DeepSeek 云端 / DeepSeek cloud", provider: "cloud", engine: "custom",
    baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", needsKey: true,
    note: "按 token 计费 / billed per token"
  },
  hunyuan: {
    name: "hunyuan", label: "腾讯混元 / Tencent Hunyuan", provider: "cloud", engine: "custom",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1", model: "hunyuan", needsKey: true,
    note: "混元 OpenAI 兼容端点 / Hunyuan OpenAI-compatible endpoint"
  },
  openai: {
    name: "openai", label: "OpenAI 云端 / OpenAI cloud", provider: "cloud", engine: "custom",
    baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", needsKey: true,
    note: "按 token 计费 / billed per token"
  },
  sglang: {
    name: "sglang", label: "SGLang 本地 / SGLang local", provider: "local", engine: "sglang",
    baseUrl: "http://127.0.0.1:30000/v1", model: "", needsKey: false,
    note: "SGLang OpenAI 兼容服务（默认 30000）/ SGLang OpenAI-compatible server"
  },
  custom: {
    name: "custom", label: "自定义 / Custom", provider: "cloud", engine: "custom",
    baseUrl: "", model: "", needsKey: false,
    note: "沿用 AI 配置页手填的地址与模型 / keep values from the AI config page"
  }
};

// 默认档案走云端（DeepSeek）；本地 Ollama 只在用户显式选择时才用，避免没装就报端口错。
var DEFAULT_PROFILE = "deepseek";
var FILE_NAME = "model-profiles.json";
// 独立绑定表：{ botId: { engine, model, baseUrl, port, provider } }——让两个 bot 各用不同框架的不同模型。
var BIND_FILE = "model-bindings.json";
var NAME_LIMIT = 40;
var BIND_ENGINES = ["ollama", "lmstudio", "llamacpp", "sglang", "custom", "deepseek", "openai", "hunyuan", "moonshot", "siliconflow"];

// 状态：档案单例缓存（档案名 → 同一对象引用）/ bot 选择表 / 是否已从磁盘加载。
var instances = {};
var assigned = {};
var loaded = false;
var bindings = {};
var bindLoaded = false;
var totals = { set: 0, removed: 0, reads: 0, bound: 0 };

// 安全转字符串：null / undefined 统一成空串。
function toText(value) {
  try { return String(value === null || value === undefined ? "" : value); } catch (e) { return ""; }
}

// 取错误文本：catch 里再抛错就破红线了。
function errText(err) {
  try { return err && err.message ? String(err.message) : String(err); } catch (e) { return "unknown error"; }
}

// 写信息日志：优先 logger.info（高频不刷 GUI），不可用时退回 console。
function logInfo(msg) {
  try { if (logger && typeof logger.info === "function") { logger.info("[model-profile] " + msg); return; } } catch (e) { /* 退回 */ }
  try { console.log("[model-profile] " + msg); } catch (e2) { /* ignore */ }
}

// 洗 botId：只留字母数字下划线横杠点，最长 40，非法返回空串。
function cleanId(value) {
  try {
    var text = toText(value).replace(/^\s+|\s+$/g, "");
    if (text.length === 0 || !/^[A-Za-z0-9_.-]+$/.test(text)) return "";
    return text.length > NAME_LIMIT ? text.slice(0, NAME_LIMIT) : text;
  } catch (e) { return ""; }
}

// 洗档案名：小写化并查白名单，非法返回空串。
function cleanName(value) {
  try {
    var text = toText(value).replace(/^\s+|\s+$/g, "").toLowerCase();
    if (text.length === 0) return "";
    return Object.prototype.hasOwnProperty.call(DEFINITIONS, text) ? text : "";
  } catch (e) { return ""; }
}

// 取映射文件绝对路径：MINEBOTS_STATE_DIR 优先（自测隔离），否则项目根 state/。
function getPath() {
  try {
    var custom = process.env.MINEBOTS_STATE_DIR;
    if (custom && String(custom).length > 0) return path.resolve(String(custom), FILE_NAME);
    return path.resolve(process.cwd(), "state", FILE_NAME);
  } catch (e) { return path.join("state", FILE_NAME); }
}

// 从磁盘读映射表；文件不存在 / 解析失败一律返回空对象，绝不抛错。
function load() {
  try {
    var file = getPath();
    if (!fs.existsSync(file)) { loaded = true; return {}; }
    var parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      var safe = {};
      var keys = Object.keys(parsed);
      for (var i = 0; i < keys.length; i++) {
        var id = cleanId(keys[i]);
        var name = cleanName(parsed[keys[i]]);
        if (id.length > 0 && name.length > 0) safe[id] = name;
      }
      assigned = safe;
    }
  } catch (e) { assigned = {}; }
  loaded = true;
  return assigned;
}

// 立即落盘映射表；目录不存在自动建，失败只写日志不抛错。
function save() {
  try {
    var file = getPath();
    var dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(assigned, null, 2), "utf8");
    return true;
  } catch (e) {
    logInfo("档案映射写盘失败 / save failed: " + errText(e));
    return false;
  }
}

// 确保映射表已加载（懒加载，整个进程只读一次盘）。
function ensureLoaded() {
  if (!loaded) load();
  return assigned;
}

// 功能：取档案单例——同名永远返回同一个对象引用，进程内绝不复制第二份。
function get(name) {
  var key = cleanName(name);
  if (key.length === 0) return null;
  if (!Object.prototype.hasOwnProperty.call(instances, key)) {
    var def = DEFINITIONS[key];
    instances[key] = {
      name: key, label: def.label, provider: def.provider, engine: def.engine,
      baseUrl: def.baseUrl, model: def.model, needsKey: def.needsKey, note: def.note,
      shared: true, createdAt: new Date().toISOString()
    };
    logInfo("创建共享档案实例 / shared profile instance created: " + key);
  }
  return instances[key];
}

// 功能：列出全部档案（给 GUI 下拉框），返回副本数组，外部改不动单例。
function list() {
  var out = [];
  try {
    var names = Object.keys(DEFINITIONS);
    for (var i = 0; i < names.length; i++) {
      var def = DEFINITIONS[names[i]];
      out.push({
        name: def.name, label: def.label, provider: def.provider, engine: def.engine,
        baseUrl: def.baseUrl, model: def.model, needsKey: def.needsKey, note: def.note, shared: true
      });
    }
  } catch (e) { return out; }
  return out;
}

// 洗引擎名：小写白名单，未知一律 custom（绝不让脏字符串进配置文件）。
function cleanEngine(value) {
  try {
    var text = toText(value).replace(/^\s+|\s+$/g, "").toLowerCase();
    return BIND_ENGINES.indexOf(text) >= 0 ? text : "custom";
  } catch (e) { return "custom"; }
}

// 洗地址：只接受 http/https，去掉末尾斜杠；空串合法（表示沿用档案预设）。
function cleanBaseUrl(value) {
  try {
    var text = toText(value).replace(/^\s+|\s+$/g, "").replace(/\/+$/, "");
    if (text.length === 0) return "";
    if (!/^https?:\/\//i.test(text) || text.length > 300) return "";
    return text;
  } catch (e) { return ""; }
}

// 推断 provider：本地引擎 / 本地地址算 local，其余算 cloud。
function providerOf(engine, baseUrl) {
  var e = cleanEngine(engine);
  if (e === "ollama" || e === "lmstudio" || e === "llamacpp" || e === "sglang") return "local";
  var u = toText(baseUrl).toLowerCase();
  if (u.indexOf("127.0.0.1") >= 0 || u.indexOf("localhost") >= 0) return "local";
  return "cloud";
}

// 洗生成参数：temperature 0-2 / topP 0-1 / maxTokens 1-65536；非法或未填返回 -1（表示不覆盖）。
function cleanParam(value, min, max, isInt) {
  var n = Number(value);
  if (value === undefined || value === null || value === "" || !isFinite(n)) return -1;
  if (n < min) n = min;
  if (n > max) n = max;
  return isInt ? Math.floor(n) : n;
}

// 绑定表路径：MINEBOTS_STATE_DIR 优先。
function getBindPath() {
  try {
    var custom = process.env.MINEBOTS_STATE_DIR;
    if (custom && String(custom).length > 0) return path.resolve(String(custom), BIND_FILE);
    return path.resolve(process.cwd(), "state", BIND_FILE);
  } catch (e) { return path.join("state", BIND_FILE); }
}

// 读绑定表：任何脏数据（数组 / 非法字段）一律丢弃，绝不抛错。
function loadBindings() {
  try {
    var file = getBindPath();
    bindings = {};
    if (!fs.existsSync(file)) { bindLoaded = true; return bindings; }
    var parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { bindLoaded = true; return bindings; }
    var keys = Object.keys(parsed);
    for (var i = 0; i < keys.length; i++) {
      var id = cleanId(keys[i]);
      var item = parsed[keys[i]];
      if (id.length === 0 || !item || typeof item !== "object") continue;
      var engine = cleanEngine(item.engine);
      var baseUrl = cleanBaseUrl(item.baseUrl);
      var port = Number(item.port);
      if (!isFinite(port) || port < 1 || port > 65535) port = 0;
      var t = cleanParam(item.temperature, 0, 2, false);
      var tp = cleanParam(item.topP, 0, 1, false);
      var mt = cleanParam(item.maxTokens, 1, 65536, true);
      bindings[id] = {
        engine: engine, model: toText(item.model).replace(/^\s+|\s+$/g, "").slice(0, 200),
        baseUrl: baseUrl, port: Math.floor(port), provider: providerOf(engine, baseUrl),
        instanceId: cleanId(item.instanceId),
        temperature: t, topP: tp, maxTokens: mt,
        at: toText(item.at).slice(0, 40)
      };
    }
  } catch (e) { bindings = {}; }
  bindLoaded = true;
  return bindings;
}

// 写绑定表（目录不存在自动建，失败只记日志）。
function saveBindings() {
  try {
    var file = getBindPath();
    var dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(bindings, null, 2), "utf8");
    return true;
  } catch (e) {
    logInfo("模型绑定写盘失败 / save bindings failed: " + errText(e));
    return false;
  }
}

function ensureBindings() {
  if (!bindLoaded) loadBindings();
  return bindings;
}

// 功能：把某个 bot 绑到「具体框架 + 具体模型」（可带独立地址/端口），返回绑定后的配置。
function bind(botId, spec) {
  var out = { ok: false, botId: cleanId(botId), binding: null, config: null, message: "" };
  try {
    if (out.botId.length === 0) { out.message = "botId 不能为空 / botId required"; return out; }
    var p = spec && typeof spec === "object" ? spec : {};
    var engine = cleanEngine(p.engine);
    var baseUrl = cleanBaseUrl(p.baseUrl);
    var port = Number(p.port);
    if (!isFinite(port) || port < 1 || port > 65535) port = 0;
    var item = {
      engine: engine, model: toText(p.model).replace(/^\s+|\s+$/g, "").slice(0, 200),
      baseUrl: baseUrl, port: Math.floor(port), provider: providerOf(engine, baseUrl),
      instanceId: cleanId(p.instanceId),
      temperature: cleanParam(p.temperature, 0, 2, false),
      topP: cleanParam(p.topP, 0, 1, false),
      maxTokens: cleanParam(p.maxTokens, 1, 65536, true),
      at: new Date().toISOString()
    };
    ensureBindings();
    bindings[out.botId] = item;
    saveBindings();
    totals.bound = totals.bound + 1;
    out.ok = true;
    out.binding = item;
    out.config = configFor(out.botId, {});
    out.message = out.botId + " → " + engine + (item.model ? (" · " + item.model) : "");
    logInfo(out.message);
    return out;
  } catch (e) { out.message = errText(e); return out; }
}

// 功能：取消绑定（回到档案预设），返回 { ok, botId, message }。
function unbind(botId) {
  var id = cleanId(botId);
  if (id.length === 0) return { ok: false, message: "botId 不能为空 / botId required" };
  try {
    ensureBindings();
    if (!Object.prototype.hasOwnProperty.call(bindings, id)) return { ok: false, botId: id, message: "没有独立绑定 / no binding" };
    delete bindings[id];
    saveBindings();
    return { ok: true, botId: id, message: id + " 已回到档案预设 / back to profile preset" };
  } catch (e) { return { ok: false, botId: id, message: errText(e) }; }
}

// 功能：读某个 bot 的独立绑定；没有返回 null。
function bindingOf(botId) {
  var id = cleanId(botId);
  if (id.length === 0) return null;
  try {
    var table = ensureBindings();
    if (!Object.prototype.hasOwnProperty.call(table, id)) return null;
    var b = table[id];
    return {
      engine: b.engine, model: b.model, baseUrl: b.baseUrl, port: b.port,
      provider: b.provider, instanceId: b.instanceId || "",
      temperature: b.temperature, topP: b.topP, maxTokens: b.maxTokens, at: b.at
    };
  } catch (e) { return null; }
}

// 功能：全部绑定的副本（GUI 展示 / 自测用）。
function listBindings() {
  var out = {};
  try {
    var table = ensureBindings();
    var keys = Object.keys(table);
    for (var i = 0; i < keys.length; i++) {
      out[keys[i]] = {
        engine: table[keys[i]].engine, model: table[keys[i]].model, baseUrl: table[keys[i]].baseUrl,
        port: table[keys[i]].port, provider: table[keys[i]].provider,
        instanceId: table[keys[i]].instanceId || "",
        temperature: table[keys[i]].temperature, topP: table[keys[i]].topP, maxTokens: table[keys[i]].maxTokens,
        at: table[keys[i]].at
      };
    }
  } catch (e) { return out; }
  return out;
}

// 功能：读某个 bot 选的档案名；没设置过返回默认档案。
function profileOf(botId) {
  var id = cleanId(botId);
  if (id.length === 0) return { ok: false, botId: "", profile: DEFAULT_PROFILE, message: "botId 不能为空 / botId required" };
  try {
    var table = ensureLoaded();
    var name = Object.prototype.hasOwnProperty.call(table, id) ? table[id] : DEFAULT_PROFILE;
    return { ok: true, botId: id, profile: name, custom: Object.prototype.hasOwnProperty.call(table, id) };
  } catch (e) { return { ok: false, botId: id, profile: DEFAULT_PROFILE, message: errText(e) }; }
}

// 功能：给 bot 选择档案——只写映射，不动 ai-config 全局配置；返回档案与合并后的配置。
function setFor(botId, name, options) {
  var out = { ok: false, botId: cleanId(botId), profile: cleanName(name), message: "", config: null };
  try {
    var opts = options && typeof options === "object" ? options : {};
    if (out.botId.length === 0) { out.message = "botId 不能为空 / botId required"; return out; }
    if (out.profile.length === 0) { out.message = "未知档案 / unknown profile: " + toText(name); return out; }
    ensureLoaded();
    assigned[out.botId] = out.profile;
    save();
    get(out.profile);
    totals.set = totals.set + 1;
    out.ok = true;
    out.config = configFor(out.botId, opts);
    out.message = out.botId + " 已使用档案 " + out.profile + " / " + out.botId + " uses profile " + out.profile;
    logInfo(out.message);
    return out;
  } catch (e) { out.message = errText(e); return out; }
}

// 功能：移除某个 bot 的档案选择（回到默认），返回 { ok, botId, message }。
function removeFor(botId) {
  var id = cleanId(botId);
  if (id.length === 0) return { ok: false, message: "botId 不能为空 / botId required" };
  try {
    ensureLoaded();
    if (!Object.prototype.hasOwnProperty.call(assigned, id)) return { ok: false, botId: id, message: "未设置过档案 / no profile set" };
    delete assigned[id];
    save();
    totals.removed = totals.removed + 1;
    return { ok: true, botId: id, message: id + " 已恢复默认档案 / " + id + " back to default profile" };
  } catch (e) { return { ok: false, botId: id, message: errText(e) }; }
}

// 功能：返回全部映射的副本（GUI 展示 / 自测用）。
function assignments() {
  var out = {};
  try {
    var table = ensureLoaded();
    var keys = Object.keys(table);
    for (var i = 0; i < keys.length; i++) out[keys[i]] = table[keys[i]];
  } catch (e) { return out; }
  return out;
}

// 功能：把档案预设 + bot 独立绑定叠加到一份已有配置上（纯函数，不读 ai-config，避免递归）。
//       优先级：全局/单 bot 配置 < 档案预设 < 独立绑定（绑定最具体，所以最后覆盖）。
//       只有显式设置过档案或绑定的 bot 才改动，未设置的原样返回，保证旧行为完全不变。
function applyTo(botId, base, options) {
  var out = {};
  try {
    var src = base && typeof base === "object" ? base : {};
    var keys = Object.keys(src);
    for (var i = 0; i < keys.length; i++) out[keys[i]] = src[keys[i]];
  } catch (e) { /* 保持空对象走兜底 */ }
  try {
    var pick = profileOf(botId);
    if (pick.custom) {
      var prof = get(pick.profile);
      if (prof) {
        totals.reads = totals.reads + 1;
        // custom 档案不覆盖手填配置；其余档案用共享单例的预设值覆盖接入参数。
        if (prof.name !== "custom") {
          if (prof.baseUrl.length > 0) out.baseUrl = prof.baseUrl;
          if (prof.model.length > 0) out.model = prof.model;
          out.engine = prof.engine;
          out.provider = prof.provider;
        }
        out.profile = prof.name;
        out.profileName = prof.label;
      }
    }
    // 独立绑定：某个 bot 指定了「框架 + 模型 + 地址」就压过档案预设，实现两个 bot 各走各的推理框架。
    var b = bindingOf(botId);
    if (b) {
      if (b.baseUrl.length > 0) out.baseUrl = b.baseUrl;
      if (b.model.length > 0) out.model = b.model;
      if (b.engine.length > 0) out.engine = b.engine;
      out.provider = b.provider;
      if (b.port > 0) out.port = b.port;
      // 生成参数：标签里配的 temperature / top_p / max_tokens 跟着绑定一起生效。
      if (typeof b.temperature === "number" && b.temperature >= 0) out.temperature = b.temperature;
      if (typeof b.topP === "number" && b.topP >= 0) out.topP = b.topP;
      if (typeof b.maxTokens === "number" && b.maxTokens > 0) out.maxTokens = b.maxTokens;
      out.binding = true;
      out.bindingModel = b.model;
      out.bindingEngine = b.engine;
    }
    return out;
  } catch (e) { return out; }
}

// 功能：读一份完整配置（默认 → 全局文件 → bot 文件 → 档案预设），供 GUI 与自测直接调用。
function configFor(botId, options) {
  var base = null;
  try {
    if (aiConfig && typeof aiConfig.loadFor === "function") base = aiConfig.loadFor(botId);
    else if (aiConfig && typeof aiConfig.load === "function") base = aiConfig.load();
  } catch (e) { base = null; }
  if (!base || typeof base !== "object") {
    // 兜底也走云端：绝不让「没装 Ollama」变成默认路径。
    base = { baseUrl: "https://api.deepseek.com/v1", apiKey: "", model: "deepseek-chat", engine: "custom", provider: "cloud" };
  }
  return applyTo(botId, base, options);
}

// 功能：统计快照——instances 是档案实例数（与 bot 数无关），assignments 是已选档案的 bot 数。
function stats() {
  var table = {};
  try { table = assignments(); } catch (e) { table = {}; }
  var binds = {};
  try { binds = listBindings(); } catch (e2) { binds = {}; }
  return {
    profiles: Object.keys(DEFINITIONS).length,
    instances: Object.keys(instances).length,
    assignments: Object.keys(table).length,
    bindings: Object.keys(binds).length,
    set: totals.set, removed: totals.removed, reads: totals.reads, bound: totals.bound,
    shared: true, defaultProfile: DEFAULT_PROFILE,
    path: getPath(), bindPath: getBindPath(), memoryPerBot: false
  };
}

// 功能：清空内存单例、映射与独立绑定，并删除落盘文件（自测隔离用）。
function reset() {
  instances = {};
  assigned = {};
  bindings = {};
  loaded = true;
  bindLoaded = true;
  totals = { set: 0, removed: 0, reads: 0, bound: 0 };
  var files = [getPath(), getBindPath()];
  for (var i = 0; i < files.length; i++) {
    try { if (fs.existsSync(files[i])) fs.unlinkSync(files[i]); } catch (e) { /* 删不掉只清内存 */ }
  }
  return { ok: true, message: "档案池与绑定已重置 / profile pool and bindings reset" };
}

module.exports = {
  list: list, get: get, profileOf: profileOf, setFor: setFor, removeFor: removeFor,
  configFor: configFor, applyTo: applyTo, assignments: assignments, stats: stats, reset: reset,
  bind: bind, unbind: unbind, bindingOf: bindingOf, listBindings: listBindings,
  DEFINITIONS: DEFINITIONS, DEFAULT_PROFILE: DEFAULT_PROFILE, FILE_NAME: FILE_NAME, BIND_FILE: BIND_FILE
};
