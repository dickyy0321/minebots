// ========================================
// 文件：modules/ai-config.js
// 功能：AI 配置——默认值 / 读取 / 校验 / 保存 / 变更通知
// 依赖：fs / path（Node 内置）、./logger（可选，失败不崩）
// 导出：load / save / getDefaults / validate / onChange / getPath / getEnginePresets
// 作者：MineBots
// ========================================

// 可选依赖：日志核心，缺失时所有输出退回 console，绝不抛错。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 内置依赖：文件读写与路径处理，Node 自带，不会加载失败。
var fs = require("fs");
var path = require("path");

// 常量：配置文件相对路径，相对进程工作目录（项目根）解析。
var CONFIG_RELATIVE = path.join("state", "ai-config.json");
// 常量：每个 bot 独立配置文件所在目录（state/ai-configs/<botId>.json），与全局配置互不影响。
var BOT_CONFIG_DIR = path.join("state", "ai-configs");
// 常量：推理引擎白名单，engine 只能取其中之一。
var ENGINES = ["ollama", "lmstudio", "llamacpp", "koboldcpp", "localai", "custom"];
// 常量：运行模式白名单——cloud = 云端 API（OpenAI / DeepSeek 等），local = 本地模型（Ollama / llama.cpp / LM Studio）。
var PROVIDERS = ["cloud", "local"];
// 常量：本地引擎预设（默认 baseUrl / 默认模型名 / 默认端口）——面板快捷切换与自测都按这份表对齐。
//   llama.cpp 的 llama-server 默认不接受 model 名做校验，任何名字都能过，故用 local-model。
var ENGINE_PRESETS = {
  ollama: { baseUrl: "http://127.0.0.1:11434/v1", model: "phi", port: 11434 },
  lmstudio: { baseUrl: "http://127.0.0.1:1234/v1", model: "local-model", port: 1234 },
  llamacpp: { baseUrl: "http://127.0.0.1:8080/v1", model: "local-model", port: 8080 },
  sglang: { baseUrl: "http://127.0.0.1:30000/v1", model: "", port: 30000 },
  custom: { baseUrl: "", model: "", port: 0 }
};
// 常量：默认配置，字段与规格一一对应。
var DEFAULTS = {
  // 默认走云端：新用户不必先装 Ollama；要本地模型再自己切「本地」。
  // Cloud-first defaults: users without Ollama can start immediately.
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "",
  model: "deepseek-chat",
  temperature: 0.7,
  topP: 0.9,
  maxTokens: 256,
  rpm: 20,
  timeout: 20000,
  retries: 3,
  systemPromptAppend: "",
  engine: "custom",
  // 运行模式：cloud = 云端 API，local = 本地模型；面板最上方的单选开关就写这个字段。
  provider: "cloud"
};

// 状态：save 成功后的变更回调集合。
var listeners = [];

// 写警告日志：优先 logger.warn，不可用时退回 console，绝不抛错。
function logWarn(msg) {
  try {
    if (logger && typeof logger.warn === "function") { logger.warn(msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.warn("[warn] " + msg); } catch (e) { /* ignore */ }
}

// 安全提取错误文本，避免在 catch 里再次抛错。
function getErrText(err) {
  try {
    if (err && err.message) return String(err.message);
    return String(err);
  } catch (e) {
    return "unknown error";
  }
}

// 深拷贝一个纯数据对象，失败时退回空对象。
function cloneData(data) {
  try { return JSON.parse(JSON.stringify(data)); } catch (e) { return {}; }
}

// 取配置文件绝对路径，process.cwd() 异常时退回相对路径。
function resolvePath() {
  try { return path.resolve(process.cwd(), CONFIG_RELATIVE); } catch (e) { return CONFIG_RELATIVE; }
}

// 确保配置文件所在目录存在，失败返回 false，绝不抛错。
function ensureDir() {
  try {
    var dir = path.dirname(resolvePath());
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch (e) {
    return false;
  }
}

// 读取并解析配置文件，文件缺失或内容非法时返回空对象。
function readFileSafe() {
  try {
    var file = resolvePath();
    if (!fs.existsSync(file)) return {};
    var parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch (e) {
    logWarn("[ai-config] 读取失败，改用默认配置: " + getErrText(e));
    return {};
  }
}

// 合并配置：只复制“已定义”的键，undefined 不会覆盖已有值。
function mergeConfig(base, patch) {
  var out = cloneData(base);
  if (!out || typeof out !== "object") out = {};
  if (!patch || typeof patch !== "object") return out;
  try {
    for (var key in patch) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      if (patch[key] === undefined) continue;
      out[key] = patch[key];
    }
  } catch (e) { /* 保留已合并的部分 */ }
  return out;
}

// 判断是否为整数（拒绝小数、NaN、字符串数字）。
function isInt(value) {
  return (typeof value === "number") && isFinite(value) && Math.floor(value) === value;
}

// 功能 3：返回默认配置的新副本，避免调用方改动内部常量。
function getDefaults() {
  return cloneData(DEFAULTS);
}

// 功能 7：返回本地引擎预设的新副本（面板快捷切换 / 自测比对用，改内部常量不会外泄）。
function getEnginePresets() {
  return cloneData(ENGINE_PRESETS);
}

// 功能 6：返回配置文件的绝对路径。
function getPath() {
  return resolvePath();
}

// 洗 botId：只留字母数字下划线横杠，最长 40，非法返回空串（顺带防目录穿越）。
function cleanBotId(botId) {
  try {
    var text = String(botId === null || botId === undefined ? "" : botId).replace(/^\s+|\s+$/g, "");
    if (text.length === 0) return "";
    if (!/^[A-Za-z0-9_-]+$/.test(text)) return "";
    return text.length > 40 ? text.slice(0, 40) : text;
  } catch (e) { return ""; }
}

// 功能 8：取某个 bot 自己的配置文件绝对路径；botId 非法返回空串。
function getPathFor(botId) {
  var id = cleanBotId(botId);
  if (id.length === 0) return "";
  try {
    return path.resolve(process.cwd(), BOT_CONFIG_DIR, id + ".json");
  } catch (e) {
    return path.join(BOT_CONFIG_DIR, id + ".json");
  }
}

// 读某个 bot 自己的配置文件，缺失 / 解析失败返回空对象。
function readBotFile(id) {
  try {
    var file = getPathFor(id);
    if (file.length === 0) return {};
    if (!fs.existsSync(file)) return {};
    var parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch (e) {
    logWarn("[ai-config] 读取 bot 配置失败，改用全局配置: " + getErrText(e));
    return {};
  }
}

// 功能 9：按 botId 读配置——默认值 → 全局文件 → 该 bot 自己的文件（后者优先），返回带 botId 的新对象。
function loadFor(botId) {
  var id = cleanBotId(botId);
  var base = mergeConfig(getDefaults(), readFileSafe());
  if (id.length === 0) return base;
  var merged = mergeConfig(base, readBotFile(id));
  merged.botId = id;
  return merged;
}

// 功能 10：按 botId 保存配置——只写该 bot 自己的文件，不动全局配置；非法 botId / 校验失败返回 ok:false。
function saveFor(botId, data) {
  var id = cleanBotId(botId);
  if (id.length === 0) return { ok: false, error: "botId invalid" };
  var oldConfig = loadFor(id);
  var patch = (data && typeof data === "object") ? data : {};
  var merged = mergeConfig(oldConfig, patch);
  merged.botId = id;
  var check = validate(merged);
  if (!check.ok) {
    logWarn("[ai-config] bot 配置校验失败: " + check.error);
    return { ok: false, error: check.error };
  }
  var file = getPathFor(id);
  try {
    if (file.length === 0) throw new Error("bad botId");
    var dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(merged, null, 2), "utf8");
  } catch (e) {
    logWarn("[ai-config] bot 配置保存失败: " + getErrText(e));
    return { ok: false, error: getErrText(e) };
  }
  fireChange(oldConfig, merged);
  return { ok: true, config: merged, path: file };
}

// 功能 1：读配置——文件缺失/解析失败即用默认值，与默认合并后返回新对象。
function load() {
  return mergeConfig(getDefaults(), readFileSafe());
}

// 功能 4：校验所有字段的类型与范围，全部合法返回 { ok:true }。
function validate(data) {
  try {
    if (!data || typeof data !== "object") return { ok: false, error: "config must be an object" };
    if (typeof data.baseUrl !== "string") return { ok: false, error: "baseUrl must be a string" };
    if (data.baseUrl.length === 0) return { ok: false, error: "baseUrl must not be empty" };
    if (!/^https?:\/\//i.test(data.baseUrl)) return { ok: false, error: "baseUrl must start with http:// or https://" };
    if (typeof data.apiKey !== "string") return { ok: false, error: "apiKey must be a string" };
    if (typeof data.model !== "string") return { ok: false, error: "model must be a string" };
    if (data.model.length === 0) return { ok: false, error: "model must not be empty" };
    if (typeof data.temperature !== "number" || isNaN(data.temperature)) return { ok: false, error: "temperature must be a number" };
    if (data.temperature < 0 || data.temperature > 2) return { ok: false, error: "temperature must be between 0 and 2" };
    if (typeof data.topP !== "number" || isNaN(data.topP)) return { ok: false, error: "topP must be a number" };
    if (data.topP < 0 || data.topP > 1) return { ok: false, error: "topP must be between 0 and 1" };
    if (!isInt(data.maxTokens)) return { ok: false, error: "maxTokens must be an integer" };
    if (data.maxTokens < 1 || data.maxTokens > 200000) return { ok: false, error: "maxTokens must be between 1 and 200000" };
    if (!isInt(data.rpm)) return { ok: false, error: "rpm must be an integer" };
    if (data.rpm < 1 || data.rpm > 600) return { ok: false, error: "rpm must be between 1 and 600" };
    if (!isInt(data.timeout)) return { ok: false, error: "timeout must be an integer" };
    if (data.timeout < 1000 || data.timeout > 600000) return { ok: false, error: "timeout must be between 1000 and 600000" };
    if (!isInt(data.retries)) return { ok: false, error: "retries must be an integer" };
    if (data.retries < 0 || data.retries > 10) return { ok: false, error: "retries must be between 0 and 10" };
    if (typeof data.systemPromptAppend !== "string") return { ok: false, error: "systemPromptAppend must be a string" };
    if (typeof data.engine !== "string") return { ok: false, error: "engine must be a string" };
    if (ENGINES.indexOf(data.engine) < 0) return { ok: false, error: "engine must be one of: " + ENGINES.join(" | ") };
    // 运行模式：老配置没有这个字段（undefined）时放行，写错值才拒绝。
    if (data.provider !== undefined) {
      if (typeof data.provider !== "string") return { ok: false, error: "provider must be a string" };
      if (PROVIDERS.indexOf(data.provider) < 0) return { ok: false, error: "provider must be one of: " + PROVIDERS.join(" | ") };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: getErrText(e) };
  }
}

// 功能 5：注册变更回调，返回取消注册函数；非函数入参直接拒绝。
function onChange(callback) {
  if (typeof callback !== "function") return null;
  listeners.push(callback);
  return function unsubscribe() {
    try {
      var i = listeners.indexOf(callback);
      if (i >= 0) listeners.splice(i, 1);
    } catch (e) { /* ignore */ }
  };
}

// 内部：save 成功后逐个通知监听者，单个回调报错不影响其他。
function fireChange(oldConfig, newConfig) {
  var snapshot = [];
  try { snapshot = listeners.slice(); } catch (e) { snapshot = []; }
  for (var i = 0; i < snapshot.length; i++) {
    try {
      snapshot[i]({ oldConfig: oldConfig, newConfig: newConfig });
    } catch (e) {
      logWarn("[ai-config] onChange 回调异常: " + getErrText(e));
    }
  }
}

// 功能 2：保存配置——合并 + 校验 + 写盘，成功后触发 onChange。
function save(data) {
  var oldConfig = load();
  var patch = (data && typeof data === "object") ? data : {};
  var merged = mergeConfig(oldConfig, patch);
  var check = validate(merged);
  if (!check.ok) {
    logWarn("[ai-config] 校验失败: " + check.error);
    return { ok: false, error: check.error };
  }
  try {
    if (!ensureDir()) throw new Error("cannot create config directory");
    fs.writeFileSync(resolvePath(), JSON.stringify(merged, null, 2), "utf8");
  } catch (e) {
    logWarn("[ai-config] 保存失败: " + getErrText(e));
    return { ok: false, error: getErrText(e) };
  }
  fireChange(oldConfig, merged);
  return { ok: true, config: merged };
}

// 对外导出：规格规定的 6 个接口，外加本地引擎预设表与运行模式白名单。
module.exports = {
  load: load,
  save: save,
  loadFor: loadFor,
  saveFor: saveFor,
  cleanBotId: cleanBotId,
  getDefaults: getDefaults,
  validate: validate,
  onChange: onChange,
  getPath: getPath,
  getPathFor: getPathFor,
  getEnginePresets: getEnginePresets,
  ENGINES: ENGINES,
  PROVIDERS: PROVIDERS
};

