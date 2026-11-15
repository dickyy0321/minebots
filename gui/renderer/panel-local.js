// ========================================
// 文件：gui/renderer/panel-local.js
// 功能：本地配置面板——标签（实例）管理：一个标签 = 推理框架 + 模型 + 参数（temperature / topP / maxTokens）+ 端口 + 路径
// 依赖：window.api（preload 暴露）、window.uiLog / window.panelAi / window.util（可选）
// 导出：window.panelLocal（bind / load / fill / save / detect / status / start / stop / current / currentFramework /
//       renderTabs / select / create / remove / importModel / useModel / refresh）
// 说明：渲染进程禁止 require；所有动作走 IPC。多个标签可同时运行（各自端口），分别供给不同 Bot。
// 作者：MineBots
// ========================================
window.panelLocal = {
  bound: false,
  last: null,
  currentId: "",
  pendingRemove: "",
  creating: false,

  byId: function (id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  },
  val: function (id) {
    var el = window.panelLocal.byId(id);
    return el ? String(el.value || "") : "";
  },
  set: function (id, v) {
    var el = window.panelLocal.byId(id);
    if (el) el.value = v === null || v === undefined ? "" : v;
    return !!el;
  },
  text: function (msg, level) {
    var box = window.panelLocal.byId("localStatusText");
    if (box) box.textContent = String(msg === null || msg === undefined ? "" : msg);
    try {
      if (window.uiLog && window.util) window.uiLog.add({ time: window.util.nowTime(), type: "SYSTEM", level: level || "info", message: String(msg) });
    } catch (e) { /* ignore */ }
  },

  // 内部：当前标签 ID（没有就取列表第一个）。
  current: function () {
    var id = window.panelLocal.currentId;
    if (id) return id;
    var items = window.panelLocal.items();
    if (items.length > 0) { window.panelLocal.currentId = items[0].id; return items[0].id; }
    return window.panelLocal.val("aiEngineSelect").toLowerCase() || "ollama";
  },

  // 内部：本地标签清单（主进程回包后写进 state）。
  items: function () {
    try {
      var st = window.state && typeof window.state === "object" ? window.state : {};
      return Array.isArray(st.localInstances) ? st.localInstances : [];
    } catch (e) { return []; }
  },

  // 内部：当前标签的框架名。
  currentFramework: function () {
    var id = window.panelLocal.current();
    var items = window.panelLocal.items();
    for (var i = 0; i < items.length; i++) if (items[i].id === id) return String(items[i].framework || "");
    return window.panelLocal.val("aiEngineSelect").toLowerCase() || "ollama";
  },

  // 内部：按 ID 找标签。
  find: function (id) {
    var items = window.panelLocal.items();
    for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i];
    return null;
  },

  // 功能：刷新标签清单（只读配置，不联网）。
  refresh: function () {
    try {
      if (window.api && typeof window.api.localInstances === "function") window.api.localInstances();
      return true;
    } catch (e) { return false; }
  },

  // 功能：渲染标签条——标签上显示「名字 · 框架 · 端口」，运行中的点变绿。
  renderTabs: function (items) {
    try {
      var box = window.panelLocal.byId("localTabs");
      var list = Array.isArray(items) ? items : window.panelLocal.items();
      if (!box) return false;
      box.innerHTML = "";
      var cur = window.panelLocal.current();
      for (var i = 0; i < list.length; i++) {
        var it = list[i] || {};
        var chip = document.createElement("button");
        chip.type = "button";
        chip.className = "local-tab" + (it.id === cur ? " on" : "") + (it.running ? " running" : "");
        chip.setAttribute("data-local-tab", String(it.id || ""));
        var dot = document.createElement("span");
        dot.className = "dot";
        var name = document.createElement("span");
        name.textContent = String(it.label || it.id || "");
        var meta = document.createElement("span");
        meta.className = "meta";
        meta.textContent = String(it.framework || "") + " · " + String(it.port || "") + (it.model ? (" · " + String(it.model)) : "");
        chip.appendChild(dot);
        chip.appendChild(name);
        chip.appendChild(meta);
        chip.addEventListener("click", function () {
          var id = this.getAttribute("data-local-tab");
          window.panelLocal.select(id);
        });
        box.appendChild(chip);
      }
      return true;
    } catch (e) { return false; }
  },

  // 功能：切换标签——先把当前输入存一次，再读新标签配置。
  select: function (id) {
    try {
      var target = String(id || "");
      if (!target || target === window.panelLocal.currentId) return false;
      window.panelLocal.save();
      window.panelLocal.currentId = target;
      window.panelLocal.pendingRemove = "";
      window.panelLocal.renderTabs();
      window.panelLocal.load(target);
      return true;
    } catch (e) { return false; }
  },

  // 功能：新建标签——默认继承当前框架，端口自动避重。
  create: function () {
    try {
      if (!window.api || typeof window.api.localInstanceCreate !== "function") return false;
      if (window.panelLocal.creating) return false;
      window.panelLocal.creating = true;
      window.panelLocal.text("新建标签… / creating tab");
      window.api.localInstanceCreate({ framework: window.panelLocal.currentFramework() });
      return true;
    } catch (e) { window.panelLocal.creating = false; return false; }
  },

  // 功能：删除当前标签——第一次点只提示，第二次点才真删（不弹系统对话框）。
  remove: function () {
    try {
      var id = window.panelLocal.current();
      if (!id) return false;
      if (window.panelLocal.pendingRemove !== id) {
        window.panelLocal.pendingRemove = id;
        window.panelLocal.text("再点一次「删除此标签」确认删除 / click Remove again to confirm: " + id, "warn");
        return false;
      }
      window.panelLocal.pendingRemove = "";
      if (!window.api || typeof window.api.localInstanceRemove !== "function") return false;
      window.panelLocal.text("删除中… / removing " + id);
      window.api.localInstanceRemove({ name: id });
      return true;
    } catch (e) { return false; }
  },

  // 功能：读某个标签的后台配置并回填。
  load: function (name) {
    try {
      var key = name || window.panelLocal.current();
      if (!window.api || typeof window.api.localConfigLoad !== "function") return false;
      window.api.localConfigLoad({ name: key });
      return true;
    } catch (e) { return false; }
  },

  // 功能：回填全部字段（标签名 / 框架 / 端口 / 模型 / 路径 / 参数），并把地址同步到 AI 配置。
  fill: function (cfg) {
    try {
      if (!cfg || typeof cfg !== "object") return false;
      window.panelLocal.last = cfg;
      if (cfg.id) window.panelLocal.currentId = String(cfg.id);
      window.panelLocal.set("localLabelInput", cfg.label || "");
      window.panelLocal.set("localPortInput", cfg.port || "");
      window.panelLocal.set("localModelInput", cfg.model || "");
      window.panelLocal.set("localExeInput", cfg.exePath || "");
      window.panelLocal.set("localArgsInput", cfg.extraArgs || "");
      window.panelLocal.set("localTempInput", cfg.temperature === undefined ? "" : cfg.temperature);
      window.panelLocal.set("localTopPInput", cfg.topP === undefined ? "" : cfg.topP);
      window.panelLocal.set("localMaxTokensInput", cfg.maxTokens === undefined ? "" : cfg.maxTokens);
      try {
        if (window.panelAi && window.panelAi.applyEngine) window.panelAi.applyEngine(cfg.framework, { fill: false });
      } catch (eP) { /* ignore */ }
      // 兜底：全局 AI 配置回填可能晚一步把框架改回去，这里再确认一次（只在本地面板里生效）。
      try {
        window.panelLocal.set("aiEngineSelect", String(cfg.framework || "custom"));
      } catch (eFw) { /* ignore */ }
      if (cfg.baseUrl) {
        window.panelLocal.set("aiBaseUrl", cfg.baseUrl);
        try { if (window.panelAi && window.panelAi.syncEngine) window.panelAi.syncEngine(cfg.framework); } catch (eS) { /* ignore */ }
      }
      var modelEl = window.panelLocal.byId("aiModel");
      if (modelEl && !String(modelEl.value || "").replace(/^\s+|\s+$/g, "") && cfg.model) modelEl.value = cfg.model;
      window.panelLocal.text((cfg.label || cfg.id) + " · " + (cfg.framework || "") + " · 端口 / port " + cfg.port + " · " + (cfg.exePath || "路径未设置 / path not set"));
      try { window.panelLocal.fillModels(cfg.models || []); } catch (eFm) { /* ignore */ }
      try {
        if (window.state) {
          if (!window.state.localFrameworkConfigs) window.state.localFrameworkConfigs = {};
          window.state.localFrameworkConfigs[cfg.framework] = {
            port: Number(cfg.port) || 0, baseUrl: String(cfg.baseUrl || ""),
            model: String(cfg.model || ""), models: Array.isArray(cfg.models) ? cfg.models.slice(0) : []
          };
        }
      } catch (eSt) { /* ignore */ }
      window.panelLocal.renderTabs();
      return true;
    } catch (e) { return false; }
  },

  // 功能：保存当前标签（框架 / 名称 / 端口 / 模型 / 路径 / 参数）。
  save: function () {
    try {
      var id = window.panelLocal.current();
      if (!id) return false;
      var payload = {
        name: id,
        framework: window.panelLocal.val("aiEngineSelect").toLowerCase(),
        label: window.panelLocal.val("localLabelInput"),
        port: window.panelLocal.val("localPortInput"),
        model: window.panelLocal.val("localModelInput"),
        exePath: window.panelLocal.val("localExeInput"),
        extraArgs: window.panelLocal.val("localArgsInput"),
        temperature: window.panelLocal.val("localTempInput"),
        topP: window.panelLocal.val("localTopPInput"),
        maxTokens: window.panelLocal.val("localMaxTokensInput")
      };
      if (!payload.temperature) delete payload.temperature;
      if (!payload.topP) delete payload.topP;
      if (!payload.maxTokens) delete payload.maxTokens;
      if (!window.api || typeof window.api.localConfigSave !== "function") return false;
      window.api.localConfigSave(payload);
      return true;
    } catch (e) { return false; }
  },

  detect: function () {
    try {
      if (!window.api || typeof window.api.localDetect !== "function") return false;
      window.panelLocal.text("探测中… / detecting");
      window.api.localDetect({ name: window.panelLocal.current() });
      return true;
    } catch (e) { return false; }
  },

  status: function () {
    try {
      if (!window.api || typeof window.api.localStatus !== "function") return false;
      window.panelLocal.text("检测中… / checking");
      window.api.localStatus({ name: window.panelLocal.current() });
      return true;
    } catch (e) { return false; }
  },

  start: function () {
    try {
      if (!window.api || typeof window.api.localStart !== "function") return false;
      window.panelLocal.save();
      window.panelLocal.text("启动中… / starting " + window.panelLocal.current());
      window.api.localStart({ name: window.panelLocal.current() });
      return true;
    } catch (e) { return false; }
  },

  stop: function () {
    try {
      if (!window.api || typeof window.api.localStop !== "function") return false;
      window.api.localStop({ name: window.panelLocal.current() });
      window.panelLocal.text("停止中… / stopping");
      return true;
    } catch (e) { return false; }
  },

  // 功能：填充模型下拉（同时同步给 Bot 卡片的模型下拉）。
  fillModels: function (models) {
    try {
      var sel = window.panelLocal.byId("localModelSelect");
      var key = window.panelLocal.currentFramework();
      var list = Array.isArray(models) ? models : [];
      try {
        if (window.state && key) {
          if (!window.state.localModelsByEngine) window.state.localModelsByEngine = {};
          window.state.localModelsByEngine[key] = list.slice(0);
        }
      } catch (eS) { /* 状态写失败不影响本地面板 */ }
      if (!sel) return false;
      var keep = String(sel.value || "");
      sel.innerHTML = "";
      if (list.length === 0) {
        var opt0 = document.createElement("option");
        opt0.value = ""; opt0.textContent = "（没有模型 / no models）";
        sel.appendChild(opt0);
        return true;
      }
      for (var i = 0; i < list.length; i++) {
        var opt = document.createElement("option");
        opt.value = String(list[i]); opt.textContent = String(list[i]);
        sel.appendChild(opt);
      }
      if (keep && list.indexOf(keep) >= 0) sel.value = keep;
      return true;
    } catch (e) { return false; }
  },

  // 功能：导入模型到当前标签（登记名字，不下载大文件）。
  importModel: function () {
    try {
      var name = window.panelLocal.val("localImportInput").replace(/^\s+|\s+$/g, "");
      if (!name) { window.panelLocal.text("先填模型名 / fill a model name first", "warn"); return false; }
      if (!window.api || typeof window.api.localModelImport !== "function") return false;
      window.panelLocal.text("导入中… / importing " + name);
      window.api.localModelImport({ name: window.panelLocal.current(), model: name });
      return true;
    } catch (e) { return false; }
  },

  // 功能：把下拉里选中的模型设为当前标签的启动模型。
  useModel: function () {
    try {
      var sel = window.panelLocal.byId("localModelSelect");
      var model = sel ? String(sel.value || "") : "";
      if (!model) { window.panelLocal.text("先选一个模型 / select a model first", "warn"); return false; }
      window.panelLocal.set("localModelInput", model);
      window.panelLocal.set("aiModel", model);
      window.panelLocal.save();
      window.panelLocal.text("已设为当前模型 / current model: " + model);
      return true;
    } catch (e) { return false; }
  },

  bind: function () {
    if (window.panelLocal.bound) return;
    if (!window.panelLocal.byId("localPortInput")) return;
    window.panelLocal.bound = true;
    try {
      var self = window.panelLocal;
      var click = function (id, fn) {
        var el = self.byId(id);
        if (el && !el._mbLocalBound) { el._mbLocalBound = true; el.addEventListener("click", fn); }
      };
      click("localNewBtn", function () { self.create(); });
      click("localRemoveBtn", function () { self.remove(); });
      click("localDetectBtn", function () { self.detect(); });
      click("localSaveBtn", function () { self.save(); self.text("保存中… / saving"); });
      click("localStatusBtn", function () { self.status(); });
      click("localStartBtn", function () { self.start(); });
      click("localStopBtn", function () { self.stop(); });
      click("localImportBtn", function () { self.importModel(); });
      click("localUseModelBtn", function () { self.useModel(); });

      // 框架下拉 = 改「当前标签」的框架（不是切换标签），运行中会被主进程拒绝并提示先停止。
      var fw = self.byId("aiEngineSelect");
      if (fw && !fw._mbLocalFw) {
        fw._mbLocalFw = true;
        fw.addEventListener("change", function () {
          try { window.panelLocal.save(); } catch (eSv) { /* ignore */ }
          setTimeout(function () { self.load(self.current()); }, 160);
          try { if (window.panelInstall && window.panelInstall.syncHint) window.panelInstall.syncHint(); } catch (eH) { /* ignore */ }
        });
      }
      var port = self.byId("localPortInput");
      if (port && !port._mbLocalPort) {
        port._mbLocalPort = true;
        port.addEventListener("change", function () {
          var n = parseInt(port.value, 10);
          if (isNaN(n) || n < 1 || n > 65535) return;
          self.set("aiBaseUrl", "http://127.0.0.1:" + n + "/v1");
        });
      }
      var sel = self.byId("localModelSelect");
      if (sel && !sel._mbLocalModel) {
        sel._mbLocalModel = true;
        sel.addEventListener("change", function () {
          if (sel.value) self.set("aiModel", sel.value);
        });
      }

      if (window.api) {
        if (typeof window.api.onLocalInstancesResult === "function") {
          window.api.onLocalInstancesResult(function (res) {
            if (!res || !Array.isArray(res.items)) return;
            try { if (window.state) window.state.localInstances = res.items; } catch (eS2) { /* ignore */ }
            if (!self.currentId && res.items.length > 0) self.currentId = res.items[0].id;
            self.renderTabs(res.items);
            if (window.uiBotBrain && typeof window.uiBotBrain.refreshAll === "function") window.uiBotBrain.refreshAll();
          });
        }
        if (typeof window.api.onLocalInstanceCreateResult === "function") {
          window.api.onLocalInstanceCreateResult(function (res) {
            self.creating = false;
            if (res && res.ok && res.item) {
              try { if (window.state) window.state.localInstances = res.items || []; } catch (eS3) { /* ignore */ }
              self.currentId = res.item.id;
              self.renderTabs(res.items || []);
              self.fill(res.item);
              self.text("已新建标签 / tab created: " + res.item.label);
            } else self.text((res && res.message) || "新建失败 / create failed", "warn");
          });
        }
        if (typeof window.api.onLocalInstanceRemoveResult === "function") {
          window.api.onLocalInstanceRemoveResult(function (res) {
            if (res && res.ok) {
              try { if (window.state) window.state.localInstances = res.items || []; } catch (eS4) { /* ignore */ }
              var rest = res.items || [];
              self.currentId = rest.length > 0 ? rest[0].id : "";
              self.renderTabs(rest);
              if (self.currentId) self.load(self.currentId);
              self.text("已删除 / removed: " + (res.removed || ""));
            } else self.text((res && res.message) || "删除失败 / remove failed", "warn");
          });
        }
        if (typeof window.api.onLocalConfigLoadResult === "function") {
          window.api.onLocalConfigLoadResult(function (res) { if (res && res.ok && res.config) self.fill(res.config); });
        }
        if (typeof window.api.onLocalDetectResult === "function") {
          window.api.onLocalDetectResult(function (res) {
            if (res && res.ok) { self.set("localExeInput", res.path || ""); self.text("已探测到 / detected: " + (res.path || "")); }
            else self.text((res && res.message) || "没探测到 / not found", "warn");
          });
        }
        if (typeof window.api.onLocalConfigSaveResult === "function") {
          window.api.onLocalConfigSaveResult(function (res) {
            if (res && res.ok) {
              if (res.config) self.fill(res.config);
              self.text("已保存 / saved: " + (res.config ? res.config.label : ""));
              self.refresh();
            } else self.text((res && res.message) || "保存失败 / save failed", "warn");
          });
        }
        if (typeof window.api.onLocalStatusResult === "function") {
          window.api.onLocalStatusResult(function (res) {
            if (!res) return;
            if (res.running) {
              self.text("运行中 / running · " + ((res.models || []).length) + " 个模型");
              self.fillModels(res.models || []);
            } else {
              self.text("未运行 / not running · " + (res.message || "") + " · 仍可用导入的模型", "warn");
              self.fillModels(res.models || []);
            }
            self.refresh();
          });
        }
        if (typeof window.api.onLocalStartResult === "function") {
          window.api.onLocalStartResult(function (res) {
            if (res && res.ok) {
              self.text("已启动 / started（pid " + res.pid + "，端口 " + res.port + "），2 秒后检测状态");
              setTimeout(function () { self.status(); }, 2000);
              self.refresh();
            } else if (res && res.portBusy) self.text(res.message || "端口被占用 / port busy", "warn");
            else if (res && res.needPath) self.text("缺少程序路径：先点「探测路径」或手填 / exe path required", "warn");
            else if (res && res.needModel) self.text("先填启动模型（llama.cpp / SGLang 需要）/ model required", "warn");
            else self.text((res && res.message) || "启动失败 / start failed", "warn");
          });
        }
        if (typeof window.api.onLocalStopResult === "function") {
          window.api.onLocalStopResult(function (res) {
            self.text((res && res.ok) ? ("已停止 / stopped" + (res.pid ? " (" + res.pid + ")" : "")) : ((res && res.message) || "停止失败"), (res && res.ok) ? "info" : "warn");
            self.refresh();
          });
        }
        if (typeof window.api.onLocalModelsResult === "function") {
          window.api.onLocalModelsResult(function (res) { self.fillModels((res && res.models) || []); });
        }
        if (typeof window.api.onLocalModelImportResult === "function") {
          window.api.onLocalModelImportResult(function (res) {
            if (res && res.ok) {
              self.fillModels(res.models || []);
              self.set("localModelInput", res.model || "");
              self.text("已导入 / imported: " + (res.model || ""));
            } else self.text((res && res.message) || "导入失败 / import failed", "warn");
          });
        }
        if (typeof window.api.onLocalModelRemoveResult === "function") {
          window.api.onLocalModelRemoveResult(function (res) {
            if (res && res.ok) { self.fillModels(res.models || []); self.text("已移除 / removed"); }
            else self.text((res && res.message) || "移除失败 / remove failed", "warn");
          });
        }
      }
      self.refresh();
      self.load(self.current());
    } catch (e) { /* 绑定失败不影响其它面板 */ }
  }
};

try {
  if (typeof window.addEventListener === "function") {
    window.addEventListener("DOMContentLoaded", function () {
      try { window.panelLocal.bind(); } catch (e) { /* ignore */ }
    });
  }
} catch (e) { /* ignore */ }
