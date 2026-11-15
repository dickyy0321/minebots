// ========================================
// 文件：modules/ai-client.js
// 功能：AI 调用核心——OpenAI 兼容对话 / 工具调用 / 向量 / 连接测试 / 状态
//       兼容 Ollama、LM Studio、llama.cpp（llama-server）：只认 /v1/chat/completions，不检测 /api/tags，
//       返回 JSON 结构不标准时也能宽容解析；引擎不支持 tools 时自动降级为纯对话。
// 依赖：axios、./logger（可选）、./ai-config（可选）、./context-manager（可选，上下文记忆）
// 导出：ask / askWithTools / embed / testConnection / getStatus / parseReply / getChatUrl / getModelsUrl / getConfig / resolveProvider / describeHttpError / loadProfile / saveProfile
// 作者：MineBots
// ========================================

// 可选依赖：日志核心，缺失时所有输出退回 console，绝不抛错。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 可选依赖：AI 配置中心，缺失时改用内置兜底配置。
var aiConfig = null;
try { aiConfig = require("./ai-config"); } catch (e) { aiConfig = null; }

// 可选依赖：HTTP 客户端，缺失时所有请求直接失败并返回空结果。
var axios = null;
try { axios = require("axios"); } catch (e) { axios = null; }

// 可选依赖：上下文记忆（永久 / 临时），缺失时 prompt 只带配置里的追加文本。
var contextManager = null;
try { contextManager = require("./context-manager"); } catch (e) { contextManager = null; }
// 可选依赖：状态机 3.0 的 JSON 加固门面（tool_calls 参数五级解析 + 1 次 AI 重试）；缺失时原样返回。
var jsonGuard = null; try { jsonGuard = require("./ai-json-guard"); } catch (e) { jsonGuard = null; }
var modelProfile = null; try { modelProfile = require("./model-profile"); } catch (eMp) { modelProfile = null; } // 模型档案池（共享单例）

// 常量：ai-config 不可用时的最小兜底配置，保证请求体字段不会是 undefined。
var FALLBACK_CONFIG = {
  baseUrl: "https://api.deepseek.com/v1", apiKey: "", model: "deepseek-chat", engine: "custom", provider: "cloud",
  temperature: 0.7, topP: 0.9, maxTokens: 256, timeout: 20000, retries: 3, systemPromptAppend: ""
};
// 常量：向量模型默认值（配置表未定义该字段，故在此兜底）。
var DEFAULT_EMBED_MODEL = "bge-small-en-v1.5";
// 常量：本地引擎名单——这些引擎不需要 API Key，只有云端服务才必须填 key。
var LOCAL_ENGINES = ["ollama", "lmstudio", "llamacpp", "sglang", "koboldcpp", "localai"];
// 常量：单次重试等待上限（毫秒）。
var MAX_BACKOFF_MS = 4000;
// 常量：常见 HTTP 错误码 → 给用户看的人话（中英双语），绝不把 axios 原文直接甩到界面上。
var HTTP_HINTS = {
  401: "[错误] API Key 无效！ / [ERROR] Invalid API Key (401 Unauthorized)", 402: "[错误] AI 接口余额不足，请检查 API Key 账户！ / [ERROR] AI API 402 Payment Required!",
  403: "[错误] 没有访问权限，检查 Key 权限或地区限制！ / [ERROR] 403 Forbidden", 404: "[错误] API 地址填错了！ / [ERROR] API endpoint not found (404)",
  429: "[错误] 请求太频繁被限流，稍后再试！ / [ERROR] 429 Too Many Requests", 500: "[错误] AI 服务端内部错误，稍后再试！ / [ERROR] 500 Internal Server Error",
  502: "[错误] AI 网关错误，稍后再试！ / [ERROR] 502 Bad Gateway", 503: "[错误] AI 服务暂时不可用，稍后再试！ / [ERROR] 503 Service Unavailable"
};
// 常量：这几个状态码重试一定还失败（key / 余额 / 权限 / 地址），见到就立刻停，别让用户傻等。
var FATAL_STATUS = [400, 401, 402, 403, 404];

// 状态：最近一次错误信息，供 getStatus 使用。
var lastError = "";
// 状态：成功调用次数。
var callCount = 0;
// 状态：最近一次成功调用时间（ISO 字符串）。
var lastCallTime = "";
// 状态：连接是否可用。
var connected = false;

// 写警告日志：优先 logger.warn，不可用时退回 console，绝不抛错。
function logWarn(msg) {
  try {
    if (logger && typeof logger.warn === "function") { logger.warn(msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.warn("[warn] " + msg); } catch (e) { /* ignore */ }
}

// 写错误日志：优先 logger.error（推 GUI 并落盘），依次退回 warn、console，绝不抛错。
function logError(msg) {
  try {
    if (logger && typeof logger.error === "function") { logger.error(msg); return; }
  } catch (e) { /* 退回 warn */ }
  logWarn(msg);
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

// 从 axios 错误里取 HTTP 状态码；网络错误 / 超时没有 response，一律返回 0。
function httpStatusOf(err) {
  try {
    var status = (err && err.response) ? Number(err.response.status) : 0;
    if (isFinite(status) && status >= 100 && status <= 599) return status;
  } catch (e) { /* 取不到就当 0 */ }
  return 0;
}

// 把 HTTP 错误翻成人话：命中映射表返回双语提示，命中不了返回空串（交给原错误文本）。
function httpHintOf(err) {
  var status = httpStatusOf(err);
  if (status > 0 && HTTP_HINTS[status]) return HTTP_HINTS[status];
  return "";
}

// 这个错误重试也没意义（缺 Key / 余额不足 / 无权限 / 地址错），withRetry 见到就直接收工。
function httpFatal(err) {
  var status = httpStatusOf(err);
  return status > 0 && FATAL_STATUS.indexOf(status) >= 0;
}

// 判断运行模式：显式 provider 优先，老配置没写就看地址是不是本机（本机算本地，其余算云端）。
function resolveProvider(cfg) {
  try {
    var p = String((cfg && cfg.provider) ? cfg.provider : "").toLowerCase();
    if (p === "cloud" || p === "local") return p;
    var base = String((cfg && cfg.baseUrl) ? cfg.baseUrl : "");
    return /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/i.test(base) ? "local" : "cloud";
  } catch (e) { return "local"; }
}

// 读取当前 AI 配置：ai-config 可用时走它，再叠加该 bot 的模型档案 / 独立绑定（绑定也算有效覆盖，没选档案也要走自己的地址）。
function getConfig(botId) {
  var cfg = null;
  try {
    if (aiConfig && typeof aiConfig.loadFor === "function") cfg = aiConfig.loadFor(botId);
    else if (aiConfig && typeof aiConfig.load === "function") cfg = aiConfig.load();
  } catch (e) { cfg = null; }
  if (!cfg || typeof cfg !== "object") cfg = FALLBACK_CONFIG;
  try { if (modelProfile && modelProfile.applyTo && botId) { var m = modelProfile.applyTo(botId, cfg); if (m && (m.profile || m.binding)) cfg = m; } return cfg; } catch (eMp2) { return cfg; }
}

// 配置自检：地址为空、或云端地址却没有 API Key 时，把原因直接暴露到 GUI（否则只会静默返回空回复）。
// 本地引擎（含局域网里的 llama.cpp）不算错，不要求 key。
function checkConfig(cfg) {
  var problems = [];
  try {
    var base = String((cfg && cfg.baseUrl) ? cfg.baseUrl : "").trim();
    var key = String((cfg && cfg.apiKey) ? cfg.apiKey : "").trim();
    var engine = String((cfg && cfg.engine) ? cfg.engine : "").toLowerCase();
    var localOk = LOCAL_ENGINES.indexOf(engine) >= 0 || /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/i.test(base);
    if (base.length === 0) problems.push("baseUrl 未配置 / baseUrl missing");
    else if (resolveProvider(cfg) === "cloud" && key.length === 0 && !localOk) problems.push("API Key 未配置 / api key missing（baseUrl=" + base + "）");
  } catch (e) { problems.push("配置读取失败 / config read failed"); }
  if (problems.length === 0) return false;
  logError("[AI] 配置有问题 / config problem: " + problems.join("；"));
  return true;
}

// 去掉字符串末尾的全部斜杠，避免拼出双斜杠。
function stripTrailingSlashes(text) {
  var s = String(text || "");
  while (s.length > 1 && s.charAt(s.length - 1) === "/") s = s.slice(0, -1);
  return s;
}

// 组装 OpenAI 兼容对话地址：baseUrl 缺 /v1 时自动补 /v1/chat/completions。
// llama.cpp 的老式补全地址（/completion、/v1/completions）也统一归一到标准 /v1/chat/completions。
function buildChatUrl(baseUrl) {
  var base = stripTrailingSlashes(baseUrl);
  if (/\/chat\/completions$/i.test(base)) return base;
  base = base.replace(/\/v1\/completions$/i, "/v1");
  base = base.replace(/\/completions$/i, "");
  base = base.replace(/\/completion$/i, "");
  if (/\/v\d+$/i.test(base)) return base + "/chat/completions";
  return base + "/v1/chat/completions";
}

// 组装 Ollama 向量地址：自动去掉末尾 /v1，再拼 /api/embeddings。
function buildEmbedUrl(baseUrl) {
  var base = stripTrailingSlashes(baseUrl);
  if (/\/api\/embeddings$/i.test(base)) return base;
  base = base.replace(/\/v\d+$/i, "");
  if (/\/api$/i.test(base)) return base + "/embeddings";
  return base + "/api/embeddings";
}

// 组装模型列表地址：/chat/completions 换成 /models，其余按 /v1/models 补全（llama.cpp、LM Studio 都支持）。
function buildModelsUrl(baseUrl) {
  var base = stripTrailingSlashes(baseUrl);
  if (!base) return "";
  if (/\/chat\/completions$/i.test(base)) return base.replace(/\/chat\/completions$/i, "/models");
  if (/\/models$/i.test(base)) return base;
  if (/\/v\d+$/i.test(base)) return base + "/models";
  return base + "/v1/models";
}

// 组装请求头：默认 JSON，配置了 apiKey 时附加 Bearer 认证。
function buildHeaders(cfg) {
  var headers = { "Content-Type": "application/json" };
  try { if (cfg && cfg.apiKey) headers["Authorization"] = "Bearer " + String(cfg.apiKey); } catch (e) { /* 无 apiKey 时保持匿名 */ }
  return headers;
}

// 组装 axios 选项：统一超时（取配置 timeout，缺省 20 秒）与请求头。
function buildOptions(cfg) {
  var timeout = 20000;
  try { timeout = Number(cfg ? cfg.timeout : null) || 20000; } catch (e) { timeout = 20000; }
  return { headers: buildHeaders(cfg), timeout: timeout };
}

// 规范化外部传入的历史消息：只保留合法 role 与字符串 content，坏数据直接丢掉（绝不抛错）。
function normalizeHistory(history) {
  var out = [];
  try {
    var list = Array.isArray(history) ? history : [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!item || typeof item !== "object") continue;
      var role = String(item.role || "");
      if (role !== "assistant" && role !== "tool" && role !== "user" && role !== "system") continue;
      var msg = { role: role, content: (typeof item.content === "string") ? item.content : "" };
      if (role === "tool" && typeof item.tool_call_id === "string") msg.tool_call_id = item.tool_call_id;
      if (role === "assistant" && Array.isArray(item.tool_calls)) msg.tool_calls = item.tool_calls;
      out.push(msg);
    }
  } catch (e) { return []; }
  return out;
}

// 组装请求体：system + user 两条消息，叠加「配置追加 + 上下文记忆」，按需附带 tools 与历史消息。
function buildBody(cfg, sysPrompt, userPrompt, tools, history) {
  var sys = String(sysPrompt || "");
  try { if (cfg && cfg.systemPromptAppend) sys = sys + "\n\n" + String(cfg.systemPromptAppend); }
  catch (e) { /* 叠加失败则用原始 system 提示 */ }
  try {
    if (contextManager && typeof contextManager.getSystemPromptAppend === "function") {
      var memory = String(contextManager.getSystemPromptAppend() || "");
      if (memory.length > 0) sys = sys + "\n\n" + memory;
    }
  } catch (e) { /* 记忆读失败就退回原 system 提示，绝不阻断对话 */ }
  var messages = [{ role: "system", content: sys }, { role: "user", content: String(userPrompt || "") }];
  var extra = normalizeHistory(history);
  for (var k = 0; k < extra.length; k++) messages.push(extra[k]);
  var body = { model: String((cfg && cfg.model) ? cfg.model : "phi"), messages: messages, stream: false };
  // 采样参数只在配置给了合法数字时才带上：llama.cpp 收到 null / NaN 的 temperature 会直接 400。
  try {
    var temp = Number(cfg ? cfg.temperature : NaN), topP = Number(cfg ? cfg.topP : NaN), maxTok = Number(cfg ? cfg.maxTokens : NaN);
    if (isFinite(temp)) body.temperature = temp;
    if (isFinite(topP)) body.top_p = topP;
    if (isFinite(maxTok) && maxTok > 0) body.max_tokens = maxTok;
  } catch (e) { /* 参数异常就用引擎默认值，不影响对话 */ }
  try {
    if (tools && tools.length) { body.tools = tools; body.tool_choice = "auto"; }
  } catch (e) { /* 工具列表异常时退化为纯对话 */ }
  return body;
}

// 判断响应里有没有 choices 数组（只要引擎按对话格式应答，内容为空也算连通）。
function hasChoices(data) {
  try {
    if (!data || typeof data !== "object") return false;
    return Array.isArray(data.choices) && data.choices.length > 0;
  } catch (e) { return false; }
}

// 从 message / delta 里取文本，兼容「字符串」与「分段数组」两种写法，取不到返回空串。
function nodeText(node) {
  try {
    if (!node || typeof node !== "object") return "";
    var content = node.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      var parts = [];
      for (var i = 0; i < content.length; i++) {
        var p = content[i];
        if (typeof p === "string") parts.push(p);
        else if (p && typeof p.text === "string") parts.push(p.text);
      }
      return parts.join("");
    }
    if (typeof node.text === "string") return node.text;
    return "";
  } catch (e) { return ""; }
}

// 从任意 JSON 挖出第一段文本：容忍 llama.cpp / LM Studio / 各种代理的非标准结构，挖不到返回空串。
function parseReply(data) {
  try {
    if (typeof data === "string") return String(data).replace(/\s+$/g, "");
    if (!data || typeof data !== "object") return "";
    var choice = null;
    if (Array.isArray(data.choices) && data.choices.length > 0) choice = data.choices[0];
    if (choice) {
      if (typeof choice === "string") return choice;
      var fromChoice = nodeText(choice.message) || nodeText(choice.delta);
      if (fromChoice) return fromChoice;
      var flat = nodeText(choice);
      if (flat) return flat;
    }
    var direct = nodeText(data) || nodeText(data.message);
    if (direct) return direct;
    var keys = ["response", "completion", "result", "output", "answer", "generated_text"];
    for (var i = 0; i < keys.length; i++) {
      var val = data[keys[i]];
      if (typeof val === "string" && val.length > 0) return val;
      if (val && typeof val === "object") {
        var nested = nodeText(val);
        if (nested) return nested;
      }
    }
    if (Array.isArray(data) && data.length > 0) return parseReply(data[0]);
    if (data.data && typeof data.data === "object") return parseReply(data.data);
    return "";
  } catch (e) { return ""; }
}

// 从响应中取 choices[0]，结构不符时返回 null（返回体只有 message / content 时也包成 choice）。
function readChoice(res) {
  try {
    var data = res ? res.data : null;
    if (hasChoices(data)) return data.choices[0];
    var text = parseReply(data);
    if (text) return { message: { role: "assistant", content: text } };
    return null;
  } catch (e) {
    return null;
  }
}

// 从 choices[0] 提取文本，走同一套宽容解析；取不到即抛错交给重试器。
function readChoiceText(choice) {
  var text = parseReply({ choices: [choice] }) || parseReply(choice);
  if (text) return text;
  throw new Error("empty content");
}

// 睡眠指定毫秒数，绝不抛错。
function sleep(ms) {
  return new Promise(function (resolve) {
    try { setTimeout(resolve, ms); } catch (e) { resolve(); }
  });
}

// 计算第 attempt 次重试前的等待时间：指数退避，封顶 4 秒。
function backoffMs(attempt) {
  var wait = 1000 * Math.pow(2, attempt - 1);
  return wait > MAX_BACKOFF_MS ? MAX_BACKOFF_MS : wait;
}

// 标记一次成功调用：累加计数、刷新时间、清空错误、置连接可用。
function markOk() {
  try {
    callCount++;
    lastCallTime = new Date().toISOString();
    lastError = "";
    connected = true;
  } catch (e) { /* ignore */ }
}

// 标记一次失败调用：HTTP 错误先翻成人话再记下来，GUI / 日志直接就能看懂。
function markFail(err) {
  try {
    var hint = httpHintOf(err);
    lastError = hint.length > 0 ? hint : getErrText(err);
    connected = false;
  } catch (e) { /* ignore */ }
}

// 发一次对话请求，返回 choices[0]；响应非法则抛错，交给重试器处理。
async function requestChoice(cfg, sysPrompt, userPrompt, tools, history) {
  if (!cfg || !cfg.baseUrl) throw new Error("AI baseUrl 未配置 / baseUrl missing");
  if (!axios || typeof axios.post !== "function") throw new Error("axios unavailable");
  var res = await axios.post(buildChatUrl(cfg.baseUrl), buildBody(cfg, sysPrompt, userPrompt, tools, history), buildOptions(cfg));
  var choice = readChoice(res);
  if (!choice) throw new Error("invalid response");
  return choice;
}

// 判断这次失败是不是「引擎不支持工具调用」：400/404/422/501，或错误里提到 tool / function。
function toolsUnsupported(err) {
  try {
    var status = (err && err.response) ? Number(err.response.status) : 0;
    if (status === 400 || status === 404 || status === 422 || status === 501) return true;
    var text = getErrText(err).toLowerCase();
    return text.indexOf("tool") >= 0 || text.indexOf("function") >= 0;
  } catch (e) { return false; }
}

// 带工具的请求：引擎不认 tools（llama.cpp 常见 400）就地降级成纯对话，保证还能正常说话。
async function requestChoiceSafe(cfg, sysPrompt, userPrompt, tools, history) {
  try {
    return await requestChoice(cfg, sysPrompt, userPrompt, tools, history);
  } catch (err) {
    if (!tools || !tools.length || !toolsUnsupported(err)) throw err;
    logWarn("[AI] 引擎不支持 tools，降级为纯对话 / tools unsupported, falling back: " + getErrText(err));
    return await requestChoice(cfg, sysPrompt, userPrompt, null, history);
  }
}

// 通用重试器：指数退避，全部失败返回 null 并记住最后一次错误，绝不抛错。
// 401 / 402 / 403 / 404 / 400 这类重试也不会好的错误：打一条 error 日志后立刻停，不让用户白等。
async function withRetry(fn, label, retries) {
  var max = (typeof retries === "number" && retries >= 0) ? Math.floor(retries) : 0;
  var attempt = 0;
  while (attempt <= max) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      markFail(err);
      var hint = httpHintOf(err);
      var fatal = httpFatal(err);
      if (hint.length > 0 && (fatal || attempt > max)) logError("[AI] " + label + " 失败 / failed: " + hint);
      else logWarn("[AI] " + label + " 第 " + attempt + " 次失败: " + getErrText(err));
      if (fatal) {
        logWarn("[AI] " + label + " 重试也解决不了，停止重试 / fatal HTTP error, stop retrying");
        return null;
      }
      if (attempt > max) return null;
      await sleep(backoffMs(attempt));
    }
  }
  return null;
}

// 功能 1：发送对话，返回 AI 回复文本；失败必须写 error 日志（推 GUI）再返回空字符串。
async function ask(sysPrompt, userPrompt, botId) {
  var cfg = getConfig(botId);
  checkConfig(cfg);
  var text = null;
  try {
    text = await withRetry(async function () {
      var choice = await requestChoice(cfg, sysPrompt, userPrompt, null);
      return readChoiceText(choice);
    }, "ask", cfg.retries);
  } catch (err) {
    markFail(err);
    logError("[AI] ask 请求失败 / ask failed: " + getErrText(err));
    return "";
  }
  if (!text) {
    logError("[AI] ask 没有拿到回复 / no reply，最近错误 / lastError: " + String(lastError || "unknown"));
    return "";
  }
  markOk();
  return String(text);
}

// 功能 2：工具调用版本，返回完整的 choices[0]（含 message.tool_calls），失败返回 null。
// history：上一轮 assistant.tool_calls + tool 结果，用于「执行工具 → 二次对话」闭环。
async function askWithTools(sysPrompt, userPrompt, tools, history, botId) {
  var cfg = getConfig(botId);
  checkConfig(cfg);
  var list = (tools && tools.length) ? tools : null;
  var choice = null;
  try {
    choice = await withRetry(function () {
      return requestChoiceSafe(cfg, sysPrompt, userPrompt, list, history);
    }, "askWithTools", cfg.retries);
  } catch (err) {
    markFail(err);
    logError("[AI] askWithTools 请求失败 / failed: " + getErrText(err));
    return null;
  }
  if (!choice) {
    logError("[AI] askWithTools 没有拿到回复 / no choice，最近错误 / lastError: " + String(lastError || "unknown"));
    return null;
  }
  markOk();
  // 状态机 3.0：tool_calls.arguments 强制五级解析，出现兜底值时最多追加一次「请输出纯 JSON」重试。
  try { if (jsonGuard) return await jsonGuard.harden(choice, function (hint) { return requestChoiceSafe(cfg, sysPrompt, userPrompt + hint, list, history); }); }
  catch (eGuard) { logWarn("[AI] JSON 加固降级 / json guard skipped: " + getErrText(eGuard)); }
  return choice;
}

// 功能 3：生成文本向量，走 Ollama 的 /api/embeddings，失败返回 null。
async function embed(text) {
  var cfg = getConfig();
  if (!axios || typeof axios.post !== "function") return null;
  var model = DEFAULT_EMBED_MODEL;
  try { if (cfg && cfg.embedModel) model = String(cfg.embedModel); } catch (e) { model = DEFAULT_EMBED_MODEL; }
  var vec = null;
  try {
    vec = await withRetry(async function () {
      var res = await axios.post(buildEmbedUrl(cfg.baseUrl), { model: model, prompt: String(text || "") }, buildOptions(cfg));
      if (res && res.data && res.data.embedding) return res.data.embedding;
      throw new Error("no embedding");
    }, "embed", cfg.retries);
  } catch (err) { markFail(err); return null; }
  if (!vec) return null;
  markOk();
  return vec;
}

// 从模型列表响应里取模型名（兼容 {data:[{id}]} / {models:[{name}]} / 纯字符串数组），失败返回空数组。
function readModelNames(data) {
  var out = [];
  try {
    var list = null;
    if (data) list = Array.isArray(data) ? data : (Array.isArray(data.data) ? data.data : (Array.isArray(data.models) ? data.models : null));
    if (!list) return out;
    for (var i = 0; i < list.length && out.length < 5; i++) {
      var item = list[i];
      if (typeof item === "string") out.push(item);
      else if (item && typeof item.id === "string") out.push(item.id);
      else if (item && typeof item.name === "string") out.push(item.name);
    }
  } catch (e) { return []; }
  return out;
}

// 发一次「说 OK」的最小请求：只要引擎按对话格式应答（哪怕 content 为空）就算连通，返回 { answered, reply, error }。
async function pingChat(cfg) {
  var out = { answered: false, reply: "", error: "" };
  try {
    if (!cfg || !cfg.baseUrl) { out.error = "AI baseUrl 未配置 / baseUrl missing"; return out; }
    if (!axios || typeof axios.post !== "function") { out.error = "axios unavailable"; return out; }
    var retries = Number(cfg.retries);
    if (!isFinite(retries) || retries < 0) retries = 0;
    if (retries > 1) retries = 1;
    var res = await withRetry(async function () {
      return await axios.post(buildChatUrl(cfg.baseUrl),
        buildBody(cfg, "You are a connectivity tester. Reply with OK.", "Say OK", null), buildOptions(cfg));
    }, "testConnection", retries);
    if (!res) { out.error = String(lastError || "no response"); return out; }
    var data = res ? res.data : null;
    out.reply = parseReply(data);
    out.answered = hasChoices(data) || out.reply.length > 0;
    if (!out.answered) out.error = String(lastError || "unrecognized response");
    return out;
  } catch (err) {
    out.error = getErrText(err);
    return out;
  }
}

// 探活：GET /v1/models（llama.cpp、LM Studio、Ollama 都提供），2xx 就算引擎在线，失败返回 { ok:false, error }。
async function probeModels(cfg) {
  var url = buildModelsUrl(cfg ? cfg.baseUrl : "");
  if (!url) return { ok: false, error: "bad baseUrl" };
  if (!axios || typeof axios.get !== "function") return { ok: false, error: "axios unavailable" };
  try {
    var options = buildOptions(cfg);
    try { options.timeout = 5000; } catch (e0) { /* 用默认超时 */ }
    var res = await axios.get(url, options);
    var names = readModelNames(res ? res.data : null);
    var reply = names.length > 0 ? ("引擎在线 / engine reachable: " + names.join(", ")) : "引擎在线 / engine reachable (/v1/models)";
    return { ok: true, reply: reply, models: names };
  } catch (err) {
    return { ok: false, error: getErrText(err) };
  }
}

// 功能 4：测试连接——先发一次最小对话请求（结构不标准也认），不行再探 /v1/models；
// 只要引擎活着就返回 { ok:true, reply, endpoint, via }，完全不依赖 Ollama 特有的 /api/tags。
async function testConnection(botId) {
  var cfg = getConfig(botId);
  var endpoint = "";
  try { endpoint = buildChatUrl(cfg.baseUrl); } catch (e) { endpoint = ""; }
  var chat = await pingChat(cfg);
  if (chat.answered) {
    markOk();
    return { ok: true, reply: chat.reply || "OK", endpoint: endpoint, via: "chat" };
  }
  var probe = await probeModels(cfg);
  if (probe.ok) {
    markOk();
    return { ok: true, reply: probe.reply, endpoint: endpoint, via: "models" };
  }
  var reason = chat.error || probe.error || "no response";
  markFail(new Error(reason));
  return { ok: false, error: reason, endpoint: endpoint };
}

// 功能 5：返回运行状态快照（连接 / 最近错误 / 调用次数 / 最近调用时间）。
function getStatus() {
  var snapshot = { connected: false, lastError: "", callCount: 0, lastCallTime: "" };
  try {
    snapshot.connected = !!connected;
    snapshot.lastError = String(lastError || "");
    snapshot.callCount = callCount;
    snapshot.lastCallTime = String(lastCallTime || "");
  } catch (e) { /* 返回初值 */ }
  return snapshot;
}

// 兼容接口：旧 GUI 的 loadProfile()，把当前配置映射成 { model, aiConfig } 结构。
function loadProfile() {
  var cfg = getConfig();
  return { model: cfg.model, aiConfig: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, systemPromptAppend: cfg.systemPromptAppend } };
}

// 兼容接口：旧 GUI 的 saveProfile()，把 { model, aiConfig } 回写到 ai-config.json。
function saveProfile(profile) {
  if (!aiConfig || typeof aiConfig.save !== "function") return { ok: false, error: "ai-config unavailable" };
  try {
    var p = (profile && typeof profile === "object") ? profile : {};
    var nested = (p.aiConfig && typeof p.aiConfig === "object") ? p.aiConfig : {};
    var pick = function (k) { return (nested[k] === undefined) ? p[k] : nested[k]; };
    return aiConfig.save({ baseUrl: pick("baseUrl"), apiKey: pick("apiKey"), model: pick("model"), systemPromptAppend: pick("systemPromptAppend") });
  } catch (e) {
    return { ok: false, error: getErrText(e) };
  }
}

// 对外导出：规格规定的 5 个接口 + 兼容旧 GUI 的 loadProfile / saveProfile，
// 外加给界面 / 自测用的纯函数（宽容解析、地址拼装、HTTP 错误翻译）。
module.exports = {
  ask: ask, askWithTools: askWithTools, embed: embed, testConnection: testConnection, getStatus: getStatus,
  loadProfile: loadProfile, saveProfile: saveProfile, parseReply: parseReply, getChatUrl: buildChatUrl,
  getModelsUrl: buildModelsUrl, resolveProvider: resolveProvider, describeHttpError: httpHintOf, getConfig: getConfig
};
