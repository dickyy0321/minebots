// ========================================
// 文件：gui/renderer/ui-bot-brain.js
// 功能：Bot 卡片的大脑选择——每个 Bot 独立选「本地标签（框架+模型+参数）」或「云端档案」，绑定写到后台
// 依赖：window.api（preload 暴露）、window.state / window.t（可选）
// 导出：window.uiBotBrain（build / refreshAll / refreshModels / ensureCatalog / applyInstances / applyProfiles）
// 说明：本地标签来自 local-instances（只读配置，不联网探测）；绑定带 instanceId 与 temperature/topP/maxTokens，
//       所以两个 Bot 可以同时用两个不同标签（不同框架、不同端口、不同模型、不同参数）。
// 作者：MineBots
// ========================================

window.uiBotBrain = {
  loaded: false,
  loading: false,

  state: function () {
    try { return window.state && typeof window.state === "object" ? window.state : {}; } catch (e) { return {}; }
  },

  // 内部：读标签 + 档案目录（都只读本地配置，不在启动时探测端口）。
  ensureCatalog: function () {
    var self = window.uiBotBrain;
    if (self.loaded || self.loading) return false;
    if (!window.api) return false;
    self.loading = true;
    try {
      if (typeof window.api.localInstances === "function") window.api.localInstances();
      if (typeof window.api.modelProfileList === "function") window.api.modelProfileList();
      return true;
    } catch (e) { self.loading = false; return false; }
  },

  // 功能：标签清单到货（主进程回包）——存状态并刷新所有卡片的模型下拉。
  applyInstances: function (res) {
    try {
      if (!res || !Array.isArray(res.items)) return false;
      var st = window.uiBotBrain.state();
      st.localInstances = res.items;
      window.uiBotBrain.loaded = true;
      window.uiBotBrain.loading = false;
      window.uiBotBrain.refreshAll();
      return true;
    } catch (e) { window.uiBotBrain.loading = false; return false; }
  },

  // 功能：档案回包——存定义与绑定，再刷新卡片。
  applyProfiles: function (res) {
    if (!res) return false;
    try {
      var st = window.uiBotBrain.state();
      if (Array.isArray(res.profiles)) {
        var names = [];
        for (var i = 0; i < res.profiles.length; i++) names.push(String((res.profiles[i] && res.profiles[i].name) || ""));
        st.modelProfileDefs = res.profiles;
        st.modelProfiles = names;
      }
      if (res.assignments && typeof res.assignments === "object") st.modelAssignments = res.assignments;
      if (res.bindings && typeof res.bindings === "object") st.modelBindings = res.bindings;
      window.uiBotBrain.refreshAll();
      return true;
    } catch (e) { return false; }
  },

  items: function () {
    try {
      var st = window.uiBotBrain.state();
      return Array.isArray(st.localInstances) ? st.localInstances : [];
    } catch (e) { return []; }
  },

  findItem: function (id) {
    var list = window.uiBotBrain.items();
    for (var i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return list[i];
    return null;
  },

  // 内部：按档案名找定义（引擎 / 默认地址 / 默认模型 / provider）。
  defOf: function (name) {
    try {
      var st = window.uiBotBrain.state();
      var defs = st.modelProfileDefs;
      if (Array.isArray(defs)) {
        for (var i = 0; i < defs.length; i++) if (defs[i] && String(defs[i].name) === String(name)) return defs[i];
      }
    } catch (e) { /* 返回空 */ }
    return null;
  },

  // 内部：可选来源——本地标签（i:）在前，云端档案（p:）在后。
  sources: function () {
    var out = [];
    var list = window.uiBotBrain.items();
    for (var i = 0; i < list.length; i++) {
      var it = list[i] || {};
      out.push({
        value: "i:" + String(it.id),
        text: String(it.label || it.id) + " · " + String(it.framework || "") + " " + String(it.port || "")
      });
    }
    var defs = window.uiBotBrain.state().modelProfileDefs;
    var names = [];
    if (Array.isArray(defs) && defs.length > 0) {
      for (var j = 0; j < defs.length; j++) {
        if (defs[j] && String(defs[j].provider) === "cloud") names.push(defs[j]);
      }
    }
    if (names.length === 0) {
      names = [
        { name: "deepseek", label: "DeepSeek 云端", model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1", engine: "custom" },
        { name: "openai", label: "OpenAI 云端", model: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1", engine: "custom" }
      ];
    }
    for (var k = 0; k < names.length; k++) {
      out.push({ value: "p:" + String(names[k].name), text: String(names[k].label || names[k].name) });
    }
    return out;
  },

  // 内部：解析下拉值——i:标签 / p:档案。
  parse: function (value) {
    var s = String(value || "");
    if (s.indexOf("i:") === 0) return { type: "instance", id: s.slice(2) };
    if (s.indexOf("p:") === 0) return { type: "profile", name: s.slice(2) };
    return { type: "profile", name: s };
  },

  // 内部：当前选中值（绑定优先，其次档案选择，最后第一个来源）。
  currentValue: function (botId) {
    var st = window.uiBotBrain.state();
    var bind = (st.modelBindings || {})[botId];
    if (bind && bind.instanceId && window.uiBotBrain.findItem(bind.instanceId)) return "i:" + bind.instanceId;
    var picks = st.modelAssignments || {};
    var assigned = picks[botId];
    if (assigned) {
      var list = window.uiBotBrain.items();
      for (var i = 0; i < list.length; i++) if (String(list[i].framework) === String(assigned)) return "i:" + list[i].id;
      return "p:" + assigned;
    }
    if (bind && bind.engine) {
      var list2 = window.uiBotBrain.items();
      for (var j = 0; j < list2.length; j++) if (String(list2[j].framework) === String(bind.engine)) return "i:" + list2[j].id;
    }
    var all = window.uiBotBrain.sources();
    return all.length > 0 ? all[0].value : "";
  },

  // 功能：某来源下的模型清单（绑定模型 > 标签模型/清单 > 档案默认）。
  modelList: function (value, botId) {
    var out = [];
    var seen = {};
    var push = function (v) {
      var t = String(v === null || v === undefined ? "" : v).replace(/^\s+|\s+$/g, "");
      if (!t) return;
      var k = t.toLowerCase();
      if (seen[k]) return;
      seen[k] = true;
      out.push(t);
    };
    try {
      var st = window.uiBotBrain.state();
      var pick = window.uiBotBrain.parse(value);
      var bind = (st.modelBindings || {})[botId];
      if (pick.type === "instance") {
        var it = window.uiBotBrain.findItem(pick.id);
        if (bind && bind.model && String(bind.instanceId) === String(pick.id)) push(bind.model);
        if (it) {
          if (it.model) push(it.model);
          var ms = Array.isArray(it.models) ? it.models : [];
          for (var i = 0; i < ms.length; i++) push(ms[i]);
        }
      } else {
        if (bind && bind.model && !bind.instanceId) push(bind.model);
        var def = window.uiBotBrain.defOf(pick.name);
        if (def && def.model) push(def.model);
      }
    } catch (e) { /* 返回已有内容 */ }
    return out;
  },

  // 内部：当前选中的模型。
  currentModel: function (value, botId) {
    try {
      var st = window.uiBotBrain.state();
      var bind = (st.modelBindings || {})[botId];
      var pick = window.uiBotBrain.parse(value);
      if (bind && bind.model) {
        if (pick.type === "instance" && String(bind.instanceId) === String(pick.id)) return String(bind.model);
        if (pick.type === "profile" && !bind.instanceId) return String(bind.model);
      }
      if (pick.type === "instance") {
        var it = window.uiBotBrain.findItem(pick.id);
        return it && it.model ? String(it.model) : "";
      }
      var def = window.uiBotBrain.defOf(pick.name);
      return def && def.model ? String(def.model) : "";
    } catch (e) { return ""; }
  },

  // 内部：填充模型下拉。
  fillModels: function (sel, value, botId) {
    try {
      if (!sel) return false;
      var list = window.uiBotBrain.modelList(value, botId);
      var cur = window.uiBotBrain.currentModel(value, botId);
      sel.innerHTML = "";
      if (list.length === 0) {
        var opt0 = document.createElement("option");
        opt0.value = "";
        opt0.textContent = "（默认 / default）";
        sel.appendChild(opt0);
        sel.value = "";
        return true;
      }
      for (var i = 0; i < list.length; i++) {
        var opt = document.createElement("option");
        opt.value = list[i];
        opt.textContent = list[i];
        sel.appendChild(opt);
      }
      sel.value = list.indexOf(cur) >= 0 ? cur : list[0];
      return true;
    } catch (e) { return false; }
  },

  // 内部：按来源 + 模型写绑定（标签带 instanceId 与参数，云端档案只带地址与模型）。
  applyBinding: function (botId, value, model) {
    try {
      var pick = window.uiBotBrain.parse(value);
      if (!window.api || typeof window.api.modelProfileBind !== "function") return false;
      if (pick.type === "instance") {
        var it = window.uiBotBrain.findItem(pick.id);
        if (!it) return false;
        window.api.modelProfileBind({
          botId: botId, instanceId: it.id, engine: it.framework, model: model || it.model || "",
          baseUrl: it.baseUrl, port: it.port,
          temperature: it.temperature, topP: it.topP, maxTokens: it.maxTokens
        });
        try {
          var st = window.uiBotBrain.state();
          if (!st.modelBindings) st.modelBindings = {};
          st.modelBindings[botId] = {
            instanceId: it.id, engine: it.framework, model: model || it.model || "",
            baseUrl: it.baseUrl, port: it.port, temperature: it.temperature, topP: it.topP, maxTokens: it.maxTokens
          };
        } catch (eS) { /* ignore */ }
        return true;
      }
      var def = window.uiBotBrain.defOf(pick.name);
      var baseUrl = def && def.baseUrl ? def.baseUrl : "";
      window.api.modelProfileBind({
        botId: botId, engine: def ? def.engine : "custom", model: model || (def ? def.model : ""), baseUrl: baseUrl
      });
      return true;
    } catch (e) { return false; }
  },

  // 功能：重建某个 Bot 的模型下拉（换来源后调用）。
  refreshModels: function (botId) {
    try {
      var sel = document.querySelector('[data-model-for="' + String(botId) + '"]');
      var fw = document.querySelector('[data-brain-for="' + String(botId) + '"]');
      if (!sel || !fw) return false;
      return window.uiBotBrain.fillModels(sel, fw.value, botId);
    } catch (e) { return false; }
  },

  // 功能：目录到货后刷新所有卡片的模型下拉。
  refreshAll: function () {
    try {
      var nodes = document.querySelectorAll("[data-model-for]");
      for (var i = 0; i < nodes.length; i++) window.uiBotBrain.refreshModels(nodes[i].getAttribute("data-model-for"));
      return true;
    } catch (e) { return false; }
  },

  // 功能：构建 Bot 卡片的「来源 / 模型」两行控件。
  build: function (b) {
    var row = document.createElement("div");
    row.className = "row brain-row";
    try {
      window.uiBotBrain.ensureCatalog();
      var lab = document.createElement("label");
      lab.textContent = window.t ? window.t("brainEngine") : "大脑 / Brain";
      row.appendChild(lab);

      var fw = document.createElement("select");
      fw.className = "cmd-select brain-select";
      fw.setAttribute("data-brain-for", b.id);
      fw.title = "本地标签 / 云端档案";
      var src = window.uiBotBrain.sources();
      var cur = window.uiBotBrain.currentValue(b.id);
      var found = false;
      for (var i = 0; i < src.length; i++) {
        var opt = document.createElement("option");
        opt.value = src[i].value;
        opt.textContent = src[i].text;
        fw.appendChild(opt);
        if (src[i].value === cur) found = true;
      }
      if (!found && cur) {
        var extra = document.createElement("option");
        extra.value = cur;
        extra.textContent = cur;
        fw.appendChild(extra);
      }
      fw.value = cur;

      var md = document.createElement("select");
      md.className = "cmd-select model-select";
      md.setAttribute("data-model-for", b.id);
      md.title = "模型 / Model";
      window.uiBotBrain.fillModels(md, cur, b.id);

      // 换来源：本地标签 → 直接绑标签（带参数）；云端档案 → 解绑 + 写档案选择。
      fw.addEventListener("change", function () {
        var picked = fw.value;
        var info = window.uiBotBrain.parse(picked);
        try {
          var s2 = window.uiBotBrain.state();
          if (!s2.modelAssignments) s2.modelAssignments = {};
          if (info.type === "profile") {
            s2.modelAssignments[b.id] = info.name;
            if (s2.modelBindings) delete s2.modelBindings[b.id];
            if (window.api && typeof window.api.modelProfileUnbind === "function") window.api.modelProfileUnbind({ botId: b.id });
            if (window.api && typeof window.api.modelProfileSet === "function") window.api.modelProfileSet({ botId: b.id, profile: info.name });
          } else {
            var it = window.uiBotBrain.findItem(info.id);
            if (it) s2.modelAssignments[b.id] = it.framework;
            if (window.api && typeof window.api.modelProfileSet === "function" && it) window.api.modelProfileSet({ botId: b.id, profile: it.framework });
          }
        } catch (eS) { /* 状态写失败不阻断 */ }
        window.uiBotBrain.fillModels(md, picked, b.id);
        if (info.type === "instance") window.uiBotBrain.applyBinding(b.id, picked, md.value);
      });

      // 选模型：把「标签 + 模型 + 参数」绑到这个 Bot。
      md.addEventListener("change", function () {
        window.uiBotBrain.applyBinding(b.id, fw.value, md.value);
      });

      row.appendChild(fw);
      row.appendChild(md);
      return row;
    } catch (e) {
      return row;
    }
  }
};
