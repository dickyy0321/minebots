// ========================================
// 文件：gui/renderer/panel-install.js
// 功能：环境面板接线——Ollama 状态 / 模型列表 / 拉取 / 删除 / 官网下载，npm 插件 安装 / 卸载 / 已装列表
// 依赖：window.api（preload 暴露的真实 IPC）
// 导出：window.panelInstall（init / bindOllama / bindNpm / fillStatus / fillModels / fillNpm）
// 说明：这里每个按钮都对应主进程的真实现（HTTP 调 Ollama、execFile 调 npm），
//       绝不出现「点了没反应」的假按钮；Python / LiteLLM 没有真实现，所以界面里干脆不出现。
// 作者：MineBots
// ========================================

window.panelInstall = {
  // 功能 1：初始化——绑定 Ollama 与 npm 两组按钮，并各拉一次真实状态。
  init: function () {
    window.panelInstall.bindOllama();
    window.panelInstall.bindNpm();
    // 启动时绝不探测 Ollama：用户可能稍后才启动它，开局探测只会制造“端口错误”。
    window.panelInstall.setStatus("ollamaStatus", "未检测，点「刷新」再查 / not probed yet, click Refresh");
    window.panelInstall.bindLocalResults();
    window.panelInstall.syncHint();
    window.panelInstall.load();
  },

  // 内部：当前本地框架（模型库区块跟着「本地配置」的框架走，不再只服务 Ollama）。
  current: function () {
    try {
      if (window.panelLocal && typeof window.panelLocal.current === "function") return window.panelLocal.current();
    } catch (e) { /* 落到兜底 */ }
    return "ollama";
  },

  // 内部：当前标签的框架名（判断能不能用 ollama pull）。
  currentFramework: function () {
    try {
      if (window.panelLocal && typeof window.panelLocal.currentFramework === "function") return window.panelLocal.currentFramework();
    } catch (e) { /* 落到兜底 */ }
    return "ollama";
  },

  // 内部：订阅本地框架的模型回包（只订阅一次），把模型库下拉与提示刷新。
  bindLocalResults: function () {
    if (window.panelInstall._mbLocalResults) return false;
    window.panelInstall._mbLocalResults = true;
    try {
      if (window.api && typeof window.api.onLocalModelsResult === "function") {
        window.api.onLocalModelsResult(function (res) {
          window.panelInstall.fillModels(res || {});
          if (res && res.running) window.panelInstall.setStatus("ollamaStatus", "运行中 / running · " + ((res.models || []).length) + " 个模型");
        });
      }
      if (window.api && typeof window.api.onLocalModelImportResult === "function") {
        window.api.onLocalModelImportResult(function (res) {
          window.panelInstall.fillModels(res || {});
          window.panelInstall.setStatus("ollamaStatus", (res && res.ok) ? ("已导入 / imported: " + (res.model || "")) : ((res && res.message) || "导入失败 / import failed"));
        });
      }
      if (window.api && typeof window.api.onLocalModelRemoveResult === "function") {
        window.api.onLocalModelRemoveResult(function (res) {
          window.panelInstall.fillModels(res || {});
          window.panelInstall.setStatus("ollamaStatus", (res && res.ok) ? "已移除 / removed" : ((res && res.message) || "移除失败 / remove failed"));
        });
      }
    } catch (e) { /* 订阅失败只影响模型库区块 */ }
    return true;
  },

  // 内部：按 id 取元素（不存在返回 null，绝不抛错）。
  el: function (id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  },

  // 内部：给按钮挂一次点击（自带幂等标记，重复 init 不会重复触发）。
  bindClick: function (el, flag, handler) {
    if (!el || el[flag]) return false;
    el[flag] = true;
    el.addEventListener("click", handler);
    return true;
  },

  // 功能 2：绑定模型库区域——刷新（任意框架）/ 打开官网 / 导入或拉取模型 / 删除。
  bindOllama: function () {
    window.panelInstall.bindClick(window.panelInstall.el("ollamaStatusBtn"), "mbOllamaStatus", function () {
      var fw = window.panelInstall.current();
      window.panelInstall.setStatus("ollamaStatus", "查询中… / checking " + fw);
      window.panelInstall.syncHint();
      // 统一走 localModels：Ollama / SGLang / LM Studio / llama.cpp 都能列模型；只读缓存 + 短超时探测。
      if (window.api && typeof window.api.localModels === "function") window.api.localModels({ name: fw });
      else if (window.api && window.api.ollamaStatus) window.api.ollamaStatus();
      if (window.api && typeof window.api.localFrameworks === "function") window.api.localFrameworks();
    });
    window.panelInstall.bindClick(window.panelInstall.el("ollamaOpenPageBtn"), "mbOllamaPage", function () {
      if (window.api && window.api.ollamaOpenPage) window.api.ollamaOpenPage();
    });
    window.panelInstall.bindClick(window.panelInstall.el("ollamaPullBtn"), "mbOllamaPull", function () {
      var input = window.panelInstall.el("ollamaModelInput");
      var name = input ? String(input.value || "").replace(/^\s+|\s+$/g, "") : "";
      if (name.length === 0) {
        window.panelInstall.setStatus("ollamaStatus", "先填模型名 / fill a model name first");
        return;
      }
      var fw = window.panelInstall.current();
      if (window.panelInstall.currentFramework() === "ollama") {
        window.panelInstall.setStatus("ollamaStatus", "拉取中… / pulling " + name);
        if (window.api && window.api.ollamaPull) window.api.ollamaPull(name);
      } else {
        // 非 Ollama：登记为导入模型（这些框架的模型通常已在本地或由服务端加载）。
        window.panelInstall.setStatus("ollamaStatus", "导入中… / importing " + name);
        if (window.api && typeof window.api.localModelImport === "function") window.api.localModelImport({ name: fw, model: name });
        else window.panelInstall.setStatus("ollamaStatus", "该框架请用「本地配置」里的导入模型 / use Import in Local runtime");
      }
      if (input) input.value = "";
    });
    window.panelInstall.bindClick(window.panelInstall.el("ollamaRemoveBtn"), "mbOllamaRemove", function () {
      var sel = window.panelInstall.el("ollamaModelSelect");
      var name = sel ? String(sel.value || "") : "";
      if (name.length === 0) {
        window.panelInstall.setStatus("ollamaStatus", "先选一个模型 / select a model first");
        return;
      }
      var fw = window.panelInstall.current();
      window.panelInstall.setStatus("ollamaStatus", "删除中… / removing " + name);
      if (window.panelInstall.currentFramework() === "ollama") {
        if (window.api && window.api.ollamaRemove) window.api.ollamaRemove(name);
      } else if (window.api && typeof window.api.localModelRemove === "function") {
        window.api.localModelRemove({ name: fw, model: name });
      } else {
        window.panelInstall.setStatus("ollamaStatus", "只能移除导入的模型 / only imported models can be removed");
      }
    });
    return true;
  },
  // 功能 3：绑定 npm 区域——安装输入框里的包、卸载同名包。
  bindNpm: function () {
    window.panelInstall.bindClick(window.panelInstall.el("npmInstallBtn"), "mbNpmInstall", function () {
      var input = window.panelInstall.el("npmPackageInput");
      var name = input ? String(input.value || "").replace(/^\s+|\s+$/g, "") : "";
      if (name.length === 0) {
        window.panelInstall.setStatus("npmStatus", "先填包名 / fill a package name first");
        return;
      }
      window.panelInstall.setStatus("npmStatus", "安装中… / installing " + name);
      if (window.api && window.api.npmInstall) window.api.npmInstall(name);
      if (input) input.value = "";
    });
    window.panelInstall.bindClick(window.panelInstall.el("npmUninstallBtn"), "mbNpmUninstall", function () {
      var input = window.panelInstall.el("npmPackageInput");
      var name = input ? String(input.value || "").replace(/^\s+|\s+$/g, "") : "";
      if (name.length === 0) {
        window.panelInstall.setStatus("npmStatus", "先填包名 / fill a package name first");
        return;
      }
      window.panelInstall.setStatus("npmStatus", "卸载中… / uninstalling " + name);
      if (window.api && window.api.npmUninstall) window.api.npmUninstall(name);
      if (input) input.value = "";
    });
    return true;
  },

  // 功能 4：拉取 npm 已装列表（启动时只查本地文件，不联网）。
  load: function () {
    try {
      if (window.api && window.api.npmList) window.api.npmList();
    } catch (e) { /* 单个失败不影响其它 */ }
    return true;
  },

  // 功能 4b：用户主动点「刷新」时才探测本地框架（没装 / 没开只显示提示，不弹红警）。
  loadOllama: function () {
    try {
      var fw = window.panelInstall.current();
      if (window.api && typeof window.api.localModels === "function") window.api.localModels({ name: fw });
      else if (window.api && window.api.ollamaStatus) window.api.ollamaStatus();
      if (window.api && typeof window.api.localFrameworks === "function") window.api.localFrameworks();
    } catch (e) { /* ignore */ }
    return true;
  },



  // 内部：模型库提示跟着「本地配置」里选中的标签走（名字 + 框架 + 端口）。
  syncHint: function () {
    try {
      var el = window.panelInstall.el("modelLibraryHint");
      if (!el) return false;
      var id = window.panelInstall.current();
      var label = id;
      try {
        var list = (window.state && window.state.localInstances) || [];
        for (var i = 0; i < list.length; i++) {
          if (String(list[i].id) === String(id)) label = String(list[i].label || id) + " · " + String(list[i].framework || "") + " " + String(list[i].port || "");
        }
      } catch (eC) { /* 用标签 ID */ }
      el.textContent = "当前标签 / current: " + label + " · 检测 / 导入 / 选为启动模型；每个标签各自独立，Bot 可各用一套。";
      return true;
    } catch (e) { return false; }
  },

  setStatus: function (id, text) {
    var el = window.panelInstall.el(id);
    if (!el) return false;
    el.textContent = String(text === null || text === undefined ? "" : text);
    return true;
  },

  fillStatus: function (data) {
    if (!data) return false;
    var msg = data.message ? String(data.message) : "";
    if (data.up === false && msg.length === 0) msg = "服务未启动 / offline";
    return window.panelInstall.setStatus("ollamaStatus", msg);
  },

  // 功能 7：把模型列表填进下拉框；空列表给出可读提示（不是空白下拉）。
  fillModels: function (data) {
    var sel = window.panelInstall.el("ollamaModelSelect");
    var models = data && Array.isArray(data.models) ? data.models : [];
    if (data && data.ok === false) window.panelInstall.setStatus("ollamaStatus", String(data.message || "offline / 服务未启动"));
    if (!sel) return false;
    try { sel.innerHTML = ""; } catch (e) { return false; }
    if (models.length === 0) {
      var empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "(no models)";
      sel.appendChild(empty);
      return true;
    }
    for (var i = 0; i < models.length; i++) {
      var opt = document.createElement("option");
      opt.value = String(models[i]);
      opt.textContent = String(models[i]);
      sel.appendChild(opt);
    }
    return true;
  },

  // 功能 8：把 npm 已装列表渲染进 #npmList（最多显示 30 条，避免面板被撑爆）。
  fillNpm: function (data) {
    var box = window.panelInstall.el("npmList");
    var packages = data && Array.isArray(data.packages) ? data.packages : [];
    if (data && data.ok === false) window.panelInstall.setStatus("npmStatus", String(data.message || "npm list failed"));
    if (data && data.ok === true) window.panelInstall.setStatus("npmStatus", "已装 " + packages.length + " 个插件 / " + packages.length + " packages");
    if (!box) return false;
    try { box.innerHTML = ""; } catch (e) { return false; }
    var limit = packages.length > 30 ? 30 : packages.length;
    for (var i = 0; i < limit; i++) {
      var row = document.createElement("div");
      row.className = "ctx-item";
      var name = document.createElement("span");
      name.className = "ctx-text";
      name.textContent = String(packages[i].name) + (packages[i].version ? " @" + packages[i].version : "");
      row.appendChild(name);
      box.appendChild(row);
    }
    return true;
  },

  // 功能 9：动作结果（安装 / 卸载 / 拉取 / 删除）写状态位——成功失败都如实显示。
  fillAction: function (data) {
    if (!data) return false;
    var msg = String(data.message || (data.ok ? "ok" : "failed"));
    var target = data.name ? "npmStatus" : "ollamaStatus";
    return window.panelInstall.setStatus(target, msg);
  },

  // 兼容旧名：错误统一显示在 npm 状态位（界面上已经没有独立的错误框）。
  showInstallError: function (msg) {
    return window.panelInstall.setStatus("npmStatus", String(msg === null || msg === undefined ? "" : msg));
  }
};
