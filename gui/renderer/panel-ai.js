// ========================================
// 文件：gui/renderer/panel-ai.js
// 功能：AI 面板接线——本地引擎快捷切换 / 保存参数 / 测试连接 / Ollama 模型列表与下载 / TTS 开关
// 依赖：window.api（preload 暴露）、window.events（可选，回填与保存转发）
// 导出：window.panelAi（init / applyEngine / syncEngine / saveConfig / testConnection / fillAiConfig ...）
// 说明：渲染进程里不许 require，跨进程动作一律走 window.api；绑定全部幂等，重复 init 不重复触发。
// 作者：MineBots
// ========================================

(function () {
  // 常量：本地引擎快捷预设——与 modules/ai-config.js 的 ENGINE_PRESETS 一一对应（自测 10f 会比对，改一处必须改两处）。
  var ENGINE_PRESETS = {
    ollama: { baseUrl: "http://127.0.0.1:11434/v1", model: "phi", port: 11434 },
    lmstudio: { baseUrl: "http://127.0.0.1:1234/v1", model: "local-model", port: 1234 },
    llamacpp: { baseUrl: "http://127.0.0.1:8080/v1", model: "local-model", port: 8080 },
    sglang: { baseUrl: "http://127.0.0.1:30000/v1", model: "", port: 30000 },
    custom: { baseUrl: "", model: "", port: 0 }
  };

  // 常量：每个本地框架的启动提示——选谁就显示谁的命令，不再只显示 llama.cpp 那一句。
  var ENGINE_HINTS = {
    ollama: "Ollama：ollama serve（默认 11434）/ run ollama serve",
    lmstudio: "LM Studio：先在本机开启 Local Server（默认 1234）/ enable local server",
    llamacpp: "llama.cpp：llama-server -m 模型.gguf --port 8080",
    sglang: "SGLang：python -m sglang.launch_server --model-path 模型 --port 30000",
    custom: "自定义：自己填可执行文件与启动参数 / your own exe and args"
  };

  // 常量：云端 API 预设——都是 OpenAI 兼容地址，填好地址再补一个 API Key 就能用（自定义留空）。
  var CLOUD_PRESETS = {
    deepseek: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
    openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
    moonshot: { baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
    siliconflow: { baseUrl: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen2.5-7B-Instruct" }
  };

  // 内部：元素只绑一次（events 与 panel-ai 都在绑同一个按钮时不会重复触发）。
  function bindOnce(el, event, key, handler) {
    if (!el) return false;
    try {
      var flag = "_mbBound_" + key;
      if (el[flag]) return false;
      el[flag] = true;
      el.addEventListener(event, handler);
      return true;
    } catch (e) { return false; }
  }

  // 内部：按 id 读输入框的值，元素不存在返回空串。
  function getVal(id) {
    try {
      var el = document.getElementById(id);
      if (!el) return "";
      return el.value;
    } catch (e) { return ""; }
  }

  // 内部：按 id 写输入框 / 下拉框的值，元素不存在静默返回 false。
  function setVal(id, value) {
    try {
      var el = document.getElementById(id);
      if (!el) return false;
      el.value = value;
      return true;
    } catch (e) { return false; }
  }

  // 内部：按 id 写文字，元素不存在静默返回 false。
  function setText(id, text) {
    try {
      var el = document.getElementById(id);
      if (!el) return false;
      el.textContent = text;
      return true;
    } catch (e) { return false; }
  }

  // 内部：把文字写进 #aiTestResult 状态位，元素不存在就静默返回 false。
  function showResult(text) {
    return setText("aiTestResult", text);
  }

  // 内部：按 id 显示 / 隐藏一个分组（云端与本地两套输入框互斥显示），失败静默返回 false。
  function toggleById(id, show) {
    try {
      var el = document.getElementById(id);
      if (!el) return false;
      el.style.display = show === true ? "" : "none";
      return true;
    } catch (e) { return false; }
  }

  // 内部：老配置没写 provider 时按地址猜——本机地址算本地，其余算云端。
  function guessProvider(baseUrl) {
    var base = String(baseUrl || "");
    return /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/i.test(base) ? "local" : "cloud";
  }

  // 内部：按 OpenAI 规范算出真正会请求的地址（与 modules/ai-client.js 的 buildChatUrl 同规则）。
  // llama.cpp 老式补全地址（/completion、/v1/completions）也归一到 /v1/chat/completions，预览与实际一致。
  function chatUrlOf(baseUrl) {
    var base = String(baseUrl || "").replace(/^\s+|\s+$/g, "");
    while (base.length > 1 && base.charAt(base.length - 1) === "/") base = base.slice(0, -1);
    if (!base) return "";
    if (/\/chat\/completions$/i.test(base)) return base;
    base = base.replace(/\/v1\/completions$/i, "/v1").replace(/\/completions$/i, "").replace(/\/completion$/i, "");
    if (/\/v\d+$/i.test(base)) return base + "/chat/completions";
    return base + "/v1/chat/completions";
  }

  // 内部：刷新「请求地址」预览（跟着输入框与引擎变化，方便排查 llama.cpp 端口写错）。
  function updateEndpoint() {
    var url = chatUrlOf(getVal("aiBaseUrl"));
    var label = t("aiEndpoint", "请求地址 / Endpoint");
    setText("aiEndpointPreview", url ? (label + "：" + url) : "");
    return url;
  }

  // 内部：双语文案（i18n 缺失时退回中英双语字面量，绝不留空）。
  function t(key, fallback) {
    try {
      if (window.t) {
        var text = window.t(key);
        if (text && text !== key) return text;
      }
    } catch (e) { /* 退回兜底文案 */ }
    return fallback;
  }

  window.panelAi = {
    // 初始化：所有绑定都是幂等的，events.init 之后再调一次也不会重复触发。
    init: function () {
      window.panelAi.bindTestBtn();
      window.panelAi.bindSaveBtn();
      window.panelAi.bindAutoSave();
      window.panelAi.bindEngineSelect();
      window.panelAi.bindProviderSelect();
      window.panelAi.bindCloudPreset();
      window.panelAi.bindEndpointPreview();
      window.panelAi.bindBotSelect();
      window.panelAi.bindOllamaRefresh();
      window.panelAi.bindOllamaDownload();
      updateEndpoint();
      // 首屏按当前运行模式收起另一个分组（本地 / 云端互斥显示）。
      window.panelAi.applyProvider(window.panelAi.currentProvider(), { fill: false });
    },

    // 暴露预设表副本（调试 / 自测对表用，外部改不到内部常量）。
    enginePresets: function () {
      var out = {};
      for (var key in ENGINE_PRESETS) {
        if (!Object.prototype.hasOwnProperty.call(ENGINE_PRESETS, key)) continue;
        out[key] = { baseUrl: ENGINE_PRESETS[key].baseUrl, model: ENGINE_PRESETS[key].model, port: ENGINE_PRESETS[key].port };
      }
      return out;
    },

    // 用户点选引擎：自动填地址与模型名；fill 传 false 时只改下拉与预览，不覆盖输入框。
    applyEngine: function (engine, opts) {
      var id = String(engine || "").toLowerCase();
      if (!ENGINE_PRESETS[id]) id = "custom";
      var preset = ENGINE_PRESETS[id];
      var fill = !(opts && opts.fill === false);
      setVal("aiEngineSelect", id);
      if (fill && preset.baseUrl) {
        setVal("aiBaseUrl", preset.baseUrl);
        setVal("aiModel", preset.model);
      }
      // 提示跟着框架走：每个本地框架都能单独设端口/模型/路径，命令别串台。
      try {
        var hint = document.getElementById("aiEngineHint");
        if (hint) hint.textContent = ENGINE_HINTS[id] || ENGINE_HINTS.custom;
      } catch (eH) { /* 提示更新失败不影响切换 */ }
      updateEndpoint();
      return preset;
    },

    // 回填配置时用：只同步下拉与预览，绝不覆盖用户存下来的地址和模型。
    syncEngine: function (engine) {
      return window.panelAi.applyEngine(engine, { fill: false });
    },

    // 当前运行模式（local / cloud），下拉缺失时按本地处理。
    currentProvider: function () {
      // 默认云端：下拉缺失时也绝不回退到本地 Ollama。
      return String(getVal("aiProviderSelect") || "").toLowerCase() === "local" ? "local" : "cloud";
    },

    // 切换运行模式：本地只显示本地引擎，云端只显示云端预设，并同步提示文字。
    // fill 传 false 时只切显示（回填配置用），不会覆盖用户的地址与模型。
    applyProvider: function (provider, opts) {
      var p = String(provider || "").toLowerCase();
      if (p !== "local") p = "cloud";
      var fill = !(opts && opts.fill === false);
      setVal("aiProviderSelect", p);
      toggleById("aiLocalGroup", p === "local");
      toggleById("aiCloudGroup", p === "cloud");
      setText("aiProviderHint", p === "cloud"
        ? t("aiProviderHintCloud", "云端 API：需要 API Key，按 token 计费 / Cloud: needs API key")
        : t("aiProviderHintLocal", "本地模型：不联网、不花钱 / Local model: offline & free"));
      if (p === "cloud" && fill) window.panelAi.applyCloudPreset(getVal("aiCloudPreset"), { fill: true });
      updateEndpoint();
      return p;
    },

    // 回填配置时用：只同步运行模式的显示，不动输入框。
    syncProvider: function (provider, baseUrl) {
      var p = String(provider || "").toLowerCase();
      if (p !== "cloud" && p !== "local") p = guessProvider(baseUrl);
      return window.panelAi.applyProvider(p, { fill: false });
    },

    // 云端预设：DeepSeek / OpenAI 等常见 OpenAI 兼容地址一键填好（模型名一起填，用户可以再改）。
    applyCloudPreset: function (name, opts) {
      var id = String(name || "").toLowerCase();
      var preset = CLOUD_PRESETS[id] ? CLOUD_PRESETS[id] : null;
      var fill = !(opts && opts.fill === false);
      setVal("aiCloudPreset", preset ? id : "");
      if (preset && fill) {
        // 地址为空的预设（如 SDLang）只切选项，不覆盖用户手填的地址。
        if (preset.baseUrl) setVal("aiBaseUrl", preset.baseUrl);
        if (preset.model) setVal("aiModel", preset.model);
      }
      updateEndpoint();
      return preset;
    },

    // 暴露云端预设表副本（调试 / 对表用，外部改不到内部常量）。
    cloudPresets: function () {
      var out = {};
      for (var key in CLOUD_PRESETS) {
        if (!Object.prototype.hasOwnProperty.call(CLOUD_PRESETS, key)) continue;
        out[key] = { baseUrl: CLOUD_PRESETS[key].baseUrl, model: CLOUD_PRESETS[key].model };
      }
      return out;
    },

    // 「运行模式」下拉：切到云端就显示云端预设，切回本地就显示本地引擎，并立刻落盘。
    bindProviderSelect: function () {
      return bindOnce(document.getElementById("aiProviderSelect"), "change", "aiProvider", function (ev) {
        var el = (ev && ev.target) ? ev.target : document.getElementById("aiProviderSelect");
        window.panelAi.applyProvider(el ? el.value : "cloud", { fill: false });
        window.panelAi.saveConfig(false);
      });
    },

    // 「云端预设」下拉：选中即填地址与模型名，并立刻落盘。
    bindCloudPreset: function () {
      return bindOnce(document.getElementById("aiCloudPreset"), "change", "aiCloudPreset", function (ev) {
        var el = (ev && ev.target) ? ev.target : document.getElementById("aiCloudPreset");
        window.panelAi.applyCloudPreset(el ? el.value : "", { fill: true });
        window.panelAi.saveConfig(false);
      });
    },

    // 当前作用对象：空串表示全局配置，非空表示某个 bot 自己的配置文件。
    currentBotId: function () {
      return String(getVal("aiBotSelect") || "").trim();
    },

    // 切换作用对象：立刻向主进程要该 bot 的配置并回填面板。
    selectBot: function (botId) {
      var id = String(botId === undefined || botId === null ? "" : botId).trim();
      setVal("aiBotSelect", id);
      try {
        if (window.api && typeof window.api.aiConfigLoad === "function") window.api.aiConfigLoad(id);
      } catch (e) { return id; }
      return id;
    },

    // 「作用对象」下拉：切到哪个 bot 就只改它自己的配置。
    bindBotSelect: function () {
      return bindOnce(document.getElementById("aiBotSelect"), "change", "aiBotSelect", function (ev) {
        var el = (ev && ev.target) ? ev.target : document.getElementById("aiBotSelect");
        window.panelAi.selectBot(el ? el.value : "");
      });
    },

    // 回填作用对象下拉：第一项是「全局配置」，其余是当前在跑的 bot（保留已选中的值）。
    fillBotList: function (list) {
      var sel = document.getElementById("aiBotSelect");
      if (!sel) return false;
      var keep = String(sel.value || "");
      var ids = [];
      try {
        var bots = Array.isArray(list) ? list : [];
        for (var i = 0; i < bots.length; i++) {
          var one = bots[i];
          var id = "";
          try { id = String(one && one.id ? one.id : one); } catch (e) { id = ""; }
          if (id.length > 0 && ids.indexOf(id) < 0) ids.push(id);
        }
      } catch (e) { ids = []; }
      try { sel.innerHTML = ""; } catch (e) { return false; }
      var all = document.createElement("option");
      all.value = "";
      all.textContent = t("aiBotGlobal", "全局配置 / Global");
      sel.appendChild(all);
      for (var k = 0; k < ids.length; k++) {
        var opt = document.createElement("option");
        opt.value = ids[k];
        opt.textContent = ids[k];
        sel.appendChild(opt);
      }
      if (keep.length > 0 && ids.indexOf(keep) >= 0) sel.value = keep;
      return true;
    },

    // 收集面板上的 AI 参数（缺元素当空串，字段齐全，不会给主进程 undefined）。
    // botId 为空 = 全局配置；非空 = 只改该 bot 自己的 state/ai-configs/<botId>.json。
    collectConfig: function () {
      return {
        botId: window.panelAi.currentBotId(),
        provider: window.panelAi.currentProvider(),
        baseUrl: getVal("aiBaseUrl"),
        apiKey: getVal("aiApiKey"),
        model: getVal("aiModel"),
        engine: getVal("aiEngineSelect") || "custom",
        systemPromptAppend: getVal("sysPromptAppend")
      };
    },

    // 保存 AI 参数到主进程；feedback 为 true 时状态位显示「已保存」。
    // 地址为空直接拒绝保存（主进程只会甩一句 "baseUrl must not be empty"，用户看不懂），失败返回 false。
    saveConfig: function (feedback) {
      try {
        if (!window.api || typeof window.api.aiConfigSave !== "function") {
          showResult(t("apiNotReady", "接口未就绪 / API not ready"));
          return false;
        }
        var cfg = window.panelAi.collectConfig();
        if (String(cfg.baseUrl || "").trim().length === 0) {
          showResult(t("aiBaseUrlRequired", "地址不能为空，请填写 / Address cannot be empty"));
          return false;
        }
        window.api.aiConfigSave(cfg);
        if (feedback) showResult(t("saved", "已保存 / Saved"));
        return true;
      } catch (e) {
        showResult(t("saveFailed", "保存失败 / Save failed"));
        return false;
      }
    },

    // 测试连接：先把当前参数存下去（存不成就别测了），再让主进程发一次最小请求；状态位先显示 "..."。
    testConnection: function () {
      try {
        showResult("...");
        if (!window.panelAi.saveConfig(false)) return false;
        if (!window.api || typeof window.api.aiConfigTest !== "function") {
          showResult(t("apiNotReady", "接口未就绪 / API not ready"));
          return false;
        }
        window.api.aiConfigTest(window.panelAi.currentBotId());
        return true;
      } catch (e) {
        showResult(t("aiTestFail", "测试失败 / Test failed"));
        return false;
      }
    },

    // 绑定「测试连接」按钮。
    bindTestBtn: function () {
      var btn = document.getElementById("aiTestBtn");
      return bindOnce(btn, "click", "aiTest", function () {
        window.panelAi.testConnection();
      });
    },

    // 绑定「保存」按钮（面板上有独立保存按钮就绑，没有就只靠自动保存）。
    bindSaveBtn: function () {
      var ids = ["aiSaveBtn", "saveAdvancedBtn"];
      for (var i = 0; i < ids.length; i++) {
        bindOnce(document.getElementById(ids[i]), "click", ids[i], function () {
          window.panelAi.saveConfig(true);
        });
      }
      return true;
    },

    // 输入框失焦 / 回车即自动保存，避免改完不点按钮就丢配置。
    bindAutoSave: function () {
      var ids = ["aiBaseUrl", "aiApiKey", "aiModel", "sysPromptAppend"];
      for (var i = 0; i < ids.length; i++) {
        bindOnce(document.getElementById(ids[i]), "change", "change_" + ids[i], function () {
          window.panelAi.saveConfig(false);
        });
      }
      return true;
    },

    // 「本地引擎」下拉：切换即填地址与模型名，并立刻落盘（engine 字段一起存）。
    bindEngineSelect: function () {
      return bindOnce(document.getElementById("aiEngineSelect"), "change", "aiEngine", function (ev) {
        var el = (ev && ev.target) ? ev.target : document.getElementById("aiEngineSelect");
        window.panelAi.applyEngine(el ? el.value : "", null);
        window.panelAi.saveConfig(false);
      });
    },

    // API 地址输入 / 失焦时实时刷新「请求地址」预览（llama.cpp 端口写错一眼能看出来）。
    bindEndpointPreview: function () {
      var el = document.getElementById("aiBaseUrl");
      var a = bindOnce(el, "input", "aiEndpointInput", function () { updateEndpoint(); });
      var b = bindOnce(el, "change", "aiEndpointChange", function () { updateEndpoint(); });
      return a || b;
    },

    // 绑定「刷新 Ollama 模型列表」按钮：委托给 panel-install（真接口在那里，绑一次就够）。
    bindOllamaRefresh: function () {
      if (window.panelInstall && typeof window.panelInstall.bindOllama === "function") return window.panelInstall.bindOllama();
      return false;
    },

    // 绑定「下载 Ollama 模型」按钮：同样委托给 panel-install（真实拉取，不是假按钮）。
    bindOllamaDownload: function () {
      if (window.panelInstall && typeof window.panelInstall.bindOllama === "function") return window.panelInstall.bindOllama();
      return false;
    },

    // 把 TTS 开关写进 localStorage（只影响界面偏好，失败静默返回 false）。
    saveTts: function (on) {
      try {
        var raw = localStorage.getItem("minebots-tts") || "{}";
        var data = JSON.parse(raw);
        data.enabled = !!on;
        localStorage.setItem("minebots-tts", JSON.stringify(data));
        return true;
      } catch (e) { return false; }
    },

    // 回填 Ollama 模型下拉框；空列表显示 (no models)。
    fillOllamaList: function (list) {
      var sel = document.getElementById("ollamaModelSelect");
      if (!sel) return false;
      try { sel.innerHTML = ""; } catch (e) { return false; }
      if (!list || list.length === 0) {
        var empty = document.createElement("option");
        empty.value = "";
        empty.textContent = "(no models)";
        sel.appendChild(empty);
        return true;
      }
      for (var i = 0; i < list.length; i++) {
        var name = "";
        try { name = list[i].name || list[i]; } catch (e) { name = ""; }
        var opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        sel.appendChild(opt);
      }
      return true;
    },

    // 主进程回包后回填 AI 参数（缺字段给默认值，不会把输入框清成 undefined）。
    fillAiConfig: function (data) {
      if (!data) return false;
      try {
        if (window.events && typeof window.events.fillAiConfig === "function") {
          window.events.fillAiConfig(data);
          window.panelAi.syncEngine(data.engine || "custom");
          window.panelAi.syncProvider(data.provider, data.baseUrl);
          return true;
        }
      } catch (e) { /* 退回本地回填 */ }
      try {
        var map = {
          aiBaseUrl: data.baseUrl || "http://127.0.0.1:11434/v1",
          aiApiKey: data.apiKey || "",
          aiModel: data.model || "phi",
          sysPromptAppend: data.systemPromptAppend || ""
        };
        for (var id in map) {
          if (!map.hasOwnProperty(id)) continue;
          var el = document.getElementById(id);
          if (el) el.value = map[id];
        }
        window.panelAi.syncEngine(data.engine || "custom");
        window.panelAi.syncProvider(data.provider, data.baseUrl);
        return true;
      } catch (e) { return false; }
    }
  };
})();
