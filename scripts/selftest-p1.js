// ========================================
// 文件：scripts/selftest-p1.js
// 功能：P1 冲刺自测——纯语言聊天 / 拟真动作 / 打字机 / 真实接口（消灭假按钮）/ 偏好落盘
// 依赖：fs / path；../modules/speech、../modules/motion、../modules/typing、../modules/prefs、
//       ../modules/param-manager、../modules/ollama-installer、../modules/npm-manager、../modules/actions
// 导出：run（由 scripts/selftest.js 调用，复用它的 section / expect / 造机器人工厂）
// 作者：MineBots
// ========================================
// 覆盖矩阵 / coverage
//   10a 语言纯净：detectLang / clean / 播报模板 / 权限拒绝句
//   10b 拟真动作：分步缓转步数 / 抢占取消 / 挖掘晃动 / 攻击先对准
//   10c 打字机：分段计划 / 真分段发送 / 插话打断 / 长句改整体延迟
//   10d 真实接口：扫描 renderer 里所有 window.api.xxx 都有实现、所有 getElementById 都在 index.html 里
//   10e 落盘：prefs.json / params.json 真写进 state 目录
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers
var fs = require("fs");
var path = require("path");
// 常量：项目根目录（本文件在 scripts/ 下）。
var ROOT = path.join(__dirname, "..");

// 读项目内文件，读不到返回空串。
function readText(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch (e) { return ""; }
}

// 收集目录下所有 .js 文件名（不递归）。
function jsFiles(relDir) {
  var out = [];
  try {
    var names = fs.readdirSync(path.join(ROOT, relDir));
    for (var i = 0; i < names.length; i++) {
      if (/\.js$/i.test(names[i])) out.push(relDir + "/" + names[i]);
    }
  } catch (e) { return []; }
  return out;
}

// 从源码里提取某个正则的全部去重匹配（第 1 个捕获组）。
function allMatches(text, re) {
  var out = [];
  var seen = {};
  var m = null;
  var source = String(text || "");
  while ((m = re.exec(source)) !== null) {
    var name = m[1];
    if (!name || seen[name] === true) continue;
    seen[name] = true;
    out.push(name);
  }
  return out;
}

// 造一个 lookAt 有延迟的 bot：用来验证「抢占能中止正在进行的缓转」。
function slowBot(h, delay) {
  var bot = h.makeBot({});
  bot.delay = delay || 0;
  return bot;
}

// 主入口：跑完全部 P1 断言（由 selftest.js 汇总 pass / fail）。
async function run(h) {
  var section = h.section;
  var expect = h.expect;
  var wait = h.wait;
  var speech = require(path.join(ROOT, "modules/speech.js"));
  var motion = require(path.join(ROOT, "modules/motion.js"));
  var typing = require(path.join(ROOT, "modules/typing.js"));
  var actions = require(path.join(ROOT, "modules/actions.js"));
  var narration = require(path.join(ROOT, "modules/task-narration.js"));
  var chatPermissions = require(path.join(ROOT, "modules/chat-permissions.js"));

  // ---------- 10a. 语言纯净 / pure language ----------
  section("10a. 语言纯净 / pure language");
  expect("有汉字就是中文（夹英文单词也算）",
    speech.detectLang("你好") === "zh" && speech.detectLang("帮我 dig 一下") === "zh" && speech.detectLang("在吗？") === "zh", "");
  expect("纯英文判成 en，纯符号 / 空串按中文兜底",
    speech.detectLang("hello bot") === "en" && speech.detectLang("123") === "zh" && speech.detectLang("") === "zh", "");
  expect("pick 只返回一种语言（不再拼双语）",
    speech.pick("zh", "好的", "ok") === "好的" && speech.pick("en", "好的", "ok") === "ok", "");
  expect("clean 拆掉「中文 / English」双语对（按玩家语言取一半）",
    speech.clean("收到，我去砍木头 / Got it, chopping wood", "zh") === "收到，我去砍木头" &&
    speech.clean("收到，我去砍木头 / Got it, chopping wood", "en") === "Got it, chopping wood",
    speech.clean("收到，我去砍木头 / Got it, chopping wood", "en"));
  expect("clean 干掉「Hello, 你好」这种半句混排",
    speech.clean("Hello, 你好", "zh") === "你好" && speech.clean("你好, hello", "en") === "hello",
    speech.clean("Hello, 你好", "zh"));
  expect("clean 不误伤同语言文本 / 坐标 / 路径",
    speech.clean("基地在 100,64,200", "zh") === "基地在 100,64,200" &&
    speech.clean("use /help first", "en") === "use /help first",
    speech.clean("基地在 100,64,200", "zh"));
  expect("播报模板只出一种语言",
    narration.textFor("accept", "dig_tree") === "收到，我去砍木头" &&
    narration.textFor("accept", "dig_tree", "en") === "Got it, chopping wood" &&
    narration.textFor("step", "mine", "en") === "Next: mining", narration.textFor("step", "mine"));
  expect("权限拒绝句按语言二选一（绝不混排）",
    chatPermissions.denyText("zh") === "你没有权限执行此指令" && chatPermissions.denyText("en") === "You don't have permission." &&
    chatPermissions.denyText("zh").indexOf("/") < 0, chatPermissions.denyText("zh"));
  expect("语言铁律只写一处（speech.SYS_LANG_RULE），聊天提示词直接复用它",
    readText("modules/speech.js").indexOf("Never mix two languages") > 0 &&
    readText("modules/chat-handler.js").indexOf("speech.SYS_LANG_RULE") > 0 &&
    readText("modules/chat-handler.js").indexOf("Reply briefly in the same language") < 0, "");

  // ---------- 10b. 拟真动作 / smooth motion ----------
  section("10b. 拟真动作 / smooth motion");
  var lookBot = h.makeBot({});
  lookBot._mbLookPoint = { x: 0, y: 64, z: 0 }; // 有「上一次看的地方」才能验证第一步是中间点
  var lookRes = await motion.smoothLookAt(lookBot, { x: 3, y: 65, z: 0 }, 5, { stepMs: 20 });
  expect("分步缓转真的走了 5 步（每步一次 lookAt，共 10 条记录）",
    lookRes.ok === true && lookRes.steps === 5 && lookBot.records.lookAt.length === 10, JSON.stringify(lookRes) + " / " + lookBot.records.lookAt.length);
  expect("第一步落在中间点（不是瞬间贴脸转向目标）",
    lookBot.records.lookAt.length > 0 && lookBot.records.lookAt[0].indexOf("start:3,65,0") < 0, lookBot.records.lookAt[0]);
  var clampBot = h.makeBot({});
  var clampRes = await motion.smoothLookAt(clampBot, { x: 0, y: 65, z: 1 }, 99, { stepMs: 10 });
  expect("步数上限 10（不会为了拟真把一次转头拖成 99 步）", clampRes.steps === motion.MAX_STEPS, JSON.stringify(clampRes));
  var cancelBot = slowBot(h, 30);
  var pending = motion.smoothLookAt(cancelBot, { x: 5, y: 65, z: 5 }, 9, { stepMs: 40 });
  await wait(70);
  motion.cancelLook(cancelBot);
  var cancelRes = await pending;
  expect("抢占（stop / 新动作）能立刻中止正在进行的缓转",
    cancelRes.aborted === true && cancelRes.steps < 9, JSON.stringify(cancelRes));
  expect("没有 lookAt 接口的 bot 老实返回 ok:false（不抛错）",
    (await motion.smoothLookAt({}, { x: 0, y: 0, z: 0 }, 5)).ok === false, "");
  var digBot = h.makeBot({ blocks: [h.makeBlock("oak_log", 1, 64, 0)] });
  var digRes = await actions.digBlock(digBot, 1, 64, 0);
  expect("挖方块照旧成功（拟真晃动不挡挖掘）", digRes.ok === true && digBot.records.dig.join(",") === "oak_log", JSON.stringify(digRes));
  var jitterBot = h.makeBot({});
  var jitter = motion.startDigJitter(jitterBot, { everyMs: 60 });
  await wait(200);
  var jitterCount = jitter.stop();
  var afterStop = jitterBot.records.lookAt.length;
  await wait(120);
  expect("挖掘时视线有微抖（模拟手部动作），stop 之后不再抖",
    jitterCount >= 1 && jitterBot.records.lookAt.length === afterStop, "jitter=" + jitterCount);
  var atkBot = h.makeBot({ entities: { "7": h.makeEntity(7, "mob", "zombie", 2, 64, 0, {}) } });
  var atkRes = await actions.attackEntity(atkBot, "zombie", 1);
  expect("攻击前先缓转对准目标（lookAt 至少 2 条记录）再抬手",
    atkRes.ok === true && atkRes.hits === 1 && atkBot.records.attack.join(",") === "zombie" && atkBot.records.lookAt.length >= 2,
    JSON.stringify(atkRes) + " lookAt=" + atkBot.records.lookAt.length);
  var stopRes = actions.stopMoving(atkBot);
  expect("stop 会把正在进行的缓转一起取消", stopRes.ok === true && stopRes.action === "stopMoving", JSON.stringify(stopRes));

  // ---------- 10c. 打字机 / typewriter ----------
  section("10c. 打字机 / typewriter");
  expect("节奏常量写死「3 字 / 100 毫秒」", typing.PER_CHARS === 3 && typing.PER_MS === 100, typing.PER_CHARS + "/" + typing.PER_MS);
  var offPlan = typing.plan("这是一句话", { typing: false });
  expect("关掉打字机时整句一次发出", offPlan.segments.length === 1 && offPlan.mode === "off", JSON.stringify(offPlan));
  var chunkPlan = typing.plan("0123456789ab", { typing: true, mode: "chunk", chunk: 5, perCharMs: 10 });
  expect("打开后按 chunk 分段（12 字 / 5 = 3 段），段间隔 = 字数 × 每字毫秒",
    chunkPlan.mode === "chunk" && chunkPlan.segments.length === 3 && chunkPlan.gapMs === 50, JSON.stringify(chunkPlan));
  var longText = "";
  for (var li = 0; li < 60; li++) longText = longText + "长句";
  var longPlan = typing.plan(longText, { typing: true, mode: "chunk", chunk: 12, perCharMs: 10 });
  expect("超长句自动退回「整体延迟发送」（不刷 20 条消息）",
    longPlan.mode === "delay" && longPlan.segments.length === 1 && longPlan.firstMs > 0, JSON.stringify({ mode: longPlan.mode, firstMs: longPlan.firstMs }));
  var typeBot = h.makeBot({});
  var sendRes = typing.send(typeBot, "0123456789ab", { lang: "zh", typing: true, mode: "chunk", chunk: 5, perCharMs: 10 });
  await wait(300);
  expect("整句等待后一次性发出，内容完整不分段",
    sendRes.ok === true && typeBot.records.chat.length === 1 && typeBot.records.chat.join("") === "0123456789ab" && sendRes.waitMs > 0,
    JSON.stringify({ res: sendRes, chat: typeBot.records.chat }));
  expect("状态里整句发送计数为 1", typing.status(typeBot).whole === 1 && typing.status(typeBot).chunks === 1, JSON.stringify(typing.status(typeBot)));
  var cutBot = h.makeBot({});
  typing.send(cutBot, "0123456789abcdefghij", { lang: "zh", typing: true, mode: "chunk", chunk: 2, perCharMs: 60 });
  await wait(30);
  var dropped = typing.interrupt(cutBot);
  await wait(300);
  expect("玩家插话能打断排队（后面的段不再发）",
    dropped >= 1 && cutBot.records.chat.length <= 1 && typing.status(cutBot).queued === 0,
    "dropped=" + dropped + " sent=" + cutBot.records.chat.length);
  var mixBot = h.makeBot({});
  typing.send(mixBot, "Hello, 你好", { lang: "zh", typing: false });
  await wait(60);
  expect("打字机出口也挡混排（只发「你好」）", mixBot.records.chat.join("") === "你好", JSON.stringify(mixBot.records.chat));
  var muteRes = typing.send({}, "hi", {});
  expect("没有 chat 接口的 bot 老实返回 ok:false", muteRes.ok === false && muteRes.message.length > 0, JSON.stringify(muteRes));

  // ---------- 10d. 真实接口 / no fake buttons ----------
  section("10d. 真实接口 / no fake buttons");
  var prefs = require(path.join(ROOT, "modules/prefs.js"));
  var paramManager = require(path.join(ROOT, "modules/param-manager.js"));
  var ollama = require(path.join(ROOT, "modules/ollama-installer.js"));
  var npmManager = require(path.join(ROOT, "modules/npm-manager.js"));
  var rendererFiles = jsFiles("gui/renderer");
  var apiSrc = readText("gui/renderer/api.js");
  var preloadSrc = readText("gui/preload.js");
  var htmlSrc = readText("gui/renderer/index.html") + readText("gui/renderer/syntax.html") + readText("gui/renderer/settings.html");
  var apiUsed = [];
  var idsUsed = [];
  for (var ri = 0; ri < rendererFiles.length; ri++) {
    var src = readText(rendererFiles[ri]);
    apiUsed = apiUsed.concat(allMatches(src, /window\.api\.([A-Za-z0-9_]+)/g));
    idsUsed = idsUsed.concat(allMatches(src, /getElementById\(\s*["']([A-Za-z0-9_]+)["']\s*\)/g));
  }
  var missingApi = [];
  for (var ai = 0; ai < apiUsed.length; ai++) {
    if (!new RegExp("\\b" + apiUsed[ai] + "\\s*:\\s*function").test(apiSrc)) missingApi.push(apiUsed[ai]);
  }
  expect("renderer 里用到的 " + apiUsed.length + " 个 window.api 方法全都有实现（没有点了没反应的）",
    missingApi.length === 0, missingApi.join(","));
  var missingPreload = [];
  for (var pi = 0; pi < apiUsed.length; pi++) {
    if (!new RegExp("\\b" + apiUsed[pi] + "\\s*:\\s*function").test(preloadSrc)) missingPreload.push(apiUsed[pi]);
  }
  expect("这些方法在 preload 里也真的有 IPC 出口（三件套齐全）", missingPreload.length === 0, missingPreload.join(","));
  var missingIds = [];
  for (var ii = 0; ii < idsUsed.length; ii++) {
    if (htmlSrc.indexOf("\"" + idsUsed[ii] + "\"") < 0) missingIds.push(idsUsed[ii]);
  }
  expect("renderer 引用的 " + idsUsed.length + " 个元素 id 在 HTML 里都存在（不绑空气按钮）",
    missingIds.length === 0, missingIds.join(","));
  expect("假模块已补成真实现：Ollama / npm / 参数中心",
    typeof ollama.status === "function" && typeof ollama.listModels === "function" && typeof ollama.pull === "function" &&
    typeof ollama.remove === "function" && typeof ollama.openDownloadPage === "function" &&
    typeof npmManager.list === "function" && typeof npmManager.install === "function" && typeof npmManager.uninstall === "function" &&
    typeof paramManager.get === "function" && typeof paramManager.set === "function" && typeof prefs.save === "function", "");
  expect("npm 包名白名单挡得住命令行注入",
    npmManager.isValidName("mineflayer-pathfinder") === true && npmManager.isValidName("@nxg-org/mineflayer-util-plugin") === true &&
    npmManager.isValidName("rm -rf /") === false && npmManager.isValidName("--foo") === false, "");
  expect("Ollama 参数校验先于联网（空名 / 非法名直接拒绝）",
    (await ollama.pull("")).ok === false && (await ollama.pull("bad name!")).ok === false && typeof ollama.getHost() === "string", "");
  expect("main.js 三件套里没有遗留的假通道名（installPython / installNpm / taskList 等）",
    readText("gui/main.js").indexOf("install-python") < 0 && readText("gui/preload.js").indexOf("installPython") < 0 &&
    apiSrc.indexOf("installPython") < 0 && apiSrc.indexOf("swarmBroadcast") < 0, "");

  // ---------- 10e. 偏好 / 参数真落盘 ----------
  section("10e. 偏好 / 参数真落盘");
  var oldDir = process.env.MINEBOTS_STATE_DIR;
  var tempDir = path.join(require("os").tmpdir(), "minebots-p1-" + process.pid + "-" + Date.now());
  process.env.MINEBOTS_STATE_DIR = tempDir;
  try {
    var defaults = prefs.load();
    expect("默认偏好：打字机开、其它高级开关关", defaults.typing === true && defaults.hiveMind === false && defaults.testMode === false, JSON.stringify(defaults));
    var saved = prefs.save({ hiveMind: true, typing: false, typingChunk: 999, typingMode: "nonsense" });
    expect("保存偏好成功并做了边界清洗", saved.ok === true && saved.prefs.hiveMind === true && saved.prefs.typing === false &&
      saved.prefs.typingChunk === 60 && saved.prefs.typingMode === "chunk", JSON.stringify(saved));
    expect("state/prefs.json 真的写出来了", fs.existsSync(prefs.getPath()), prefs.getPath());
    expect("重新读盘拿到的是刚保存的值", prefs.load().hiveMind === true && prefs.get("typing") === false, JSON.stringify(prefs.load()));
    var paramSet = paramManager.set("bot.digBatch", 32);
    var paramGet = paramManager.get("bot.digBatch");
    expect("参数写入后能读回，并真的写到 state/params.json",
      paramSet.ok === true && paramGet.ok === true && paramGet.value === 32 && fs.existsSync(paramManager.getPath()), JSON.stringify(paramGet));
    expect("未知参数老实返回 ok:false（不编值）", paramManager.get("no.such.param").ok === false, "");
    expect("内置默认参数可直接查到", paramManager.get("ai.temperature").value === 0.7, JSON.stringify(paramManager.get("ai.temperature")));
  } finally {
    try { if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    if (oldDir === undefined) delete process.env.MINEBOTS_STATE_DIR;
    else process.env.MINEBOTS_STATE_DIR = oldDir;
  }

  // ---------- 10f. 本地引擎兼容（llama.cpp / LM Studio） ----------
  section("10f. 本地引擎兼容 / llama.cpp compatible");
  var aiConfig = require(path.join(ROOT, "modules/ai-config.js"));
  var aiClient = require(path.join(ROOT, "modules/ai-client.js"));
  var presets = aiConfig.getEnginePresets();
  expect("预设表端口与地址对得上（Ollama 11434 / LM Studio 1234 / llama.cpp 8080）",
    presets.ollama.port === 11434 && presets.lmstudio.port === 1234 && presets.llamacpp.port === 8080 &&
    presets.llamacpp.baseUrl === "http://127.0.0.1:8080/v1" && presets.lmstudio.baseUrl === "http://127.0.0.1:1234/v1",
    JSON.stringify(presets));
  expect("llama.cpp 用任意模型名都行（预设给的是 local-model）",
    presets.llamacpp.model === "local-model" && presets.lmstudio.model === "local-model", JSON.stringify(presets.llamacpp));
  expect("请求永远落在 /v1/chat/completions，不依赖 Ollama 的 /api/tags",
    aiClient.getChatUrl("http://127.0.0.1:8080") === "http://127.0.0.1:8080/v1/chat/completions" &&
    aiClient.getChatUrl("http://127.0.0.1:8080/v1/") === "http://127.0.0.1:8080/v1/chat/completions" &&
    aiClient.getChatUrl("http://127.0.0.1:8080/v1/chat/completions") === "http://127.0.0.1:8080/v1/chat/completions" &&
    aiClient.getChatUrl("http://127.0.0.1:1234/v1") === "http://127.0.0.1:1234/v1/chat/completions", "");
  expect("/v1/models 探活地址也能拼对（兜底判定用）",
    aiClient.getModelsUrl("http://127.0.0.1:8080/v1") === "http://127.0.0.1:8080/v1/models" &&
    aiClient.getModelsUrl("http://127.0.0.1:8080/v1/chat/completions") === "http://127.0.0.1:8080/v1/models", "");
  expect("结构有偏差的回复体也能解析出文本 / 解析不了返回空串",
    aiClient.parseReply({ choices: [{ text: "OK" }] }) === "OK" &&
    aiClient.parseReply({ choices: [{ message: { content: [{ type: "text", text: "O" }, { type: "text", text: "K" }] } }] }) === "OK" &&
    aiClient.parseReply({ response: "OK" }) === "OK" &&
    aiClient.parseReply({ data: { choices: [{ message: { content: "OK" } }] } }) === "OK" &&
    aiClient.parseReply("OK") === "OK" && aiClient.parseReply(null) === "" && aiClient.parseReply({}) === "",
    aiClient.parseReply({ choices: [{ text: "OK" }] }));
  var cfgLlama = aiConfig.getDefaults();
  cfgLlama.engine = "llamacpp";
  cfgLlama.model = "local-model";
  cfgLlama.baseUrl = "http://127.0.0.1:8080/v1";
  var cfgLm = aiConfig.getDefaults();
  cfgLm.engine = "lmstudio";
  var cfgBad = aiConfig.getDefaults();
  cfgBad.engine = "nope";
  expect("引擎白名单收下 llamacpp / lmstudio，乱写的引擎仍被拒",
    aiConfig.validate(cfgLlama).ok === true && aiConfig.validate(cfgLm).ok === true && aiConfig.validate(cfgBad).ok === false,
    JSON.stringify(aiConfig.validate(cfgBad)));

  // 用假 axios + 假 config 重载 ai-client：不联网也能验证「结构偏差 / 只回 /v1/models 都算连上」。
  var aiFile = require.resolve(path.join(ROOT, "modules/ai-client.js"));
  var cfgFile = require.resolve(path.join(ROOT, "modules/ai-config.js"));
  var axiosFile = null;
  try { axiosFile = require.resolve("axios", { paths: [ROOT] }); } catch (e) { axiosFile = null; }
  var savedAi = require.cache[aiFile];
  var savedCfg = require.cache[cfgFile];
  var savedAxios = (axiosFile && require.cache[axiosFile]) ? require.cache[axiosFile] : null;
  var mode = { reply: null, postFail: null, getFail: null };
  var calls = [];
  var cfgLocal = {
    baseUrl: "http://127.0.0.1:8080/v1", apiKey: "", model: "local-model", temperature: 0.7,
    topP: 0.9, maxTokens: 64, timeout: 2000, retries: 0, systemPromptAppend: "", engine: "llamacpp"
  };
  try {
    require.cache[cfgFile] = {
      id: cfgFile, filename: cfgFile, loaded: true, children: [], paths: [],
      exports: { load: function () { return cfgLocal; } }
    };
    if (axiosFile) {
      require.cache[axiosFile] = {
        id: axiosFile, filename: axiosFile, loaded: true, children: [], paths: [],
        exports: {
          // 假 POST：记录地址与请求体，按 mode 决定成功还是失败。
          post: function (url, body) {
            calls.push({ url: url, body: body });
            if (mode.postFail) return Promise.reject(mode.postFail);
            return Promise.resolve({ data: mode.reply });
          },
          // 假 GET：模型列表探活用。
          get: function (url) {
            calls.push({ url: url });
            if (mode.getFail) return Promise.reject(mode.getFail);
            return Promise.resolve({ data: { object: "list", data: [{ id: "local-model" }] } });
          }
        }
      };
    }
    delete require.cache[aiFile];
    var llama = require(aiFile);
    mode.reply = { choices: [{ message: { role: "assistant", content: "OK" } }] };
    var r1 = await llama.testConnection();
    expect("标准 OpenAI 返回体 → 连接成功，地址就是 /v1/chat/completions",
      r1.ok === true && r1.via === "chat" && r1.reply === "OK" && calls.length > 0 &&
      /\/v1\/chat\/completions$/.test(calls[0].url) && calls[0].body.model === "local-model", JSON.stringify(r1));
    mode.reply = { choices: [{ text: "OK" }] };
    var r2 = await llama.testConnection();
    expect("只有 choices[0].text（非标准）也判成功", r2.ok === true && r2.reply === "OK", JSON.stringify(r2));
    mode.reply = { choices: [{ message: { content: "" }, finish_reason: "stop" }] };
    var r3 = await llama.testConnection();
    expect("引擎按格式应答但内容是空的也算连上（不误报失败）", r3.ok === true && r3.via === "chat", JSON.stringify(r3));
    mode.reply = null;
    mode.postFail = new Error("Request failed with status code 400");
    calls.length = 0;
    var r4 = await llama.testConnection();
    expect("chat 挂了但 /v1/models 通 → 仍判连接成功（兜底探活）",
      r4.ok === true && r4.via === "models" && calls.length >= 2 && /\/v1\/models$/.test(calls[calls.length - 1].url),
      JSON.stringify(r4));
    mode.getFail = new Error("connect ECONNREFUSED 127.0.0.1:8080");
    var r5 = await llama.testConnection();
    expect("chat 与 /v1/models 都不通 → 老实返回 ok:false + 原因",
      r5.ok === false && typeof r5.error === "string" && r5.error.length > 0, JSON.stringify(r5));
    expect("自检全程没有碰过 Ollama 特有的 /api/tags",
      calls.every(function (c) { return c.url.indexOf("/api/tags") < 0; }), JSON.stringify(calls));
  } finally {
    if (axiosFile) {
      if (savedAxios) require.cache[axiosFile] = savedAxios;
      else delete require.cache[axiosFile];
    }
    if (savedCfg) require.cache[cfgFile] = savedCfg;
    else delete require.cache[cfgFile];
    if (savedAi) require.cache[aiFile] = savedAi;
    else delete require.cache[aiFile];
  }

  // 界面侧：下拉 + 浅色提示 + 双语词条，改一处漏一处都能被抓出来。
  var panelAiSrc = readText("gui/renderer/panel-ai.js");
  var htmlSrc = readText("gui/renderer/settings.html");
  var langSrc = readText("gui/renderer/lang.js");
  var eventsSrc = readText("gui/renderer/events.js");
  expect("面板有「本地引擎」下拉，三个预设地址与模块里的预设表一致",
    htmlSrc.indexOf("id=\"aiEngineSelect\"") >= 0 &&
    panelAiSrc.indexOf("http://127.0.0.1:11434/v1") >= 0 &&
    panelAiSrc.indexOf("http://127.0.0.1:1234/v1") >= 0 &&
    panelAiSrc.indexOf("http://127.0.0.1:8080/v1") >= 0, "");
  expect("点选引擎会同时填地址与模型名，并立刻落盘（带 engine 字段）",
    panelAiSrc.indexOf("applyEngine") >= 0 && panelAiSrc.indexOf("local-model") >= 0 &&
    panelAiSrc.indexOf("bindEngineSelect") >= 0 && panelAiSrc.indexOf("engine: getVal(\"aiEngineSelect\")") >= 0 &&
    eventsSrc.indexOf("engine: window.events.getVal(\"aiEngineSelect\")") >= 0, "");
  expect("回填配置只同步下拉、不覆盖用户输入（fill:false 走 syncEngine）",
    panelAiSrc.indexOf("syncEngine") >= 0 && panelAiSrc.indexOf("fill: false") >= 0, "");
  expect("llama.cpp 启动提示是浅色小字，中英双语都写了",
    htmlSrc.indexOf("llama-server -m") >= 0 && langSrc.split("llama-server -m").length - 1 === 2 &&
    readText("gui/renderer/style.css").indexOf(".engine-hint") >= 0, "");
}

// 对外导出：run（由 scripts/selftest.js 统一调度）。
module.exports = { run: run };
