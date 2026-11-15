// gui/renderer/panel-settings.js
// 玩家等级 + 上下文 + 开关指令 + 参数设置（前后端对接：只走 window.api / window.uiContext）
// 说明：本文件负责「高级」面板的加载与保存；主进程回包由 app.js 分发到 fillPlayerPanel / uiContext.render。

// 常量：6 个玩家等级输入框 → state/players.json 里的 manual 键（顺序同面板）。
var LEVEL_FIELDS = [
  { id: "pLvlOwner", key: "owner" },
  { id: "pLvlClose", key: "close_friend" },
  { id: "pLvlFriend", key: "friend" },
  { id: "pLvlNormal", key: "normal" },
  { id: "pLvlHostile", key: "hostile" },
  { id: "pLvlTargeted", key: "targeted" }
];

window.panelSettings = {
  // 功能 1：初始化（绑定 + 首次拉取玩家等级与上下文）。
  init: function () {
    window.panelSettings.bindPlayerPanel();
    window.panelSettings.bindContextPanel();
    window.panelSettings.bindSwitchCmd();
    window.panelSettings.bindParamSearch();
    window.panelSettings.load();
  },

  // 功能 2：绑定玩家等级区域——手动输入开关 + 「保存」按钮同时保存等级名单。
  bindPlayerPanel: function () {
    var toggle = document.getElementById("playerManualToggle");
    if (toggle && !toggle.mbBound) {
      toggle.mbBound = true;
      toggle.addEventListener("change", function () { window.panelSettings.applyManualVisibility(); });
    }
    var saveBtn = document.getElementById("saveAdvancedBtn");
    if (saveBtn && !saveBtn.mbPlayerBound) {
      saveBtn.mbPlayerBound = true;
      saveBtn.addEventListener("click", function () { window.panelSettings.savePlayer(); });
    }
  },

  // 功能 3：绑定上下文区域——刷新 / 添加临时 / 添加永久 / 清空临时。
  bindContextPanel: function () {
    var refreshBtn = document.getElementById("ctxRefreshBtn");
    var addTempBtn = document.getElementById("ctxAddTempBtn");
    var addPermBtn = document.getElementById("ctxAddPermBtn");
    var clearTempBtn = document.getElementById("ctxClearTempBtn");
    var input = document.getElementById("ctxInput");
    window.panelSettings.bindClick(refreshBtn, "mbCtxRefresh", function () { window.api.contextLoad(); });
    window.panelSettings.bindClick(addTempBtn, "mbCtxTemp", function () { window.panelSettings.addContext(input, "temporary"); });
    window.panelSettings.bindClick(addPermBtn, "mbCtxPerm", function () { window.panelSettings.addContext(input, "permanent"); });
    window.panelSettings.bindClick(clearTempBtn, "mbCtxClear", function () { window.api.contextClearTemp(); });
  },

  // 内部：给元素挂一次点击事件（用自定义标记防重复绑定）。
  bindClick: function (el, flag, handler) {
    if (!el || el[flag]) return false;
    el[flag] = true;
    el.addEventListener("click", handler);
    return true;
  },

  // 功能 4：从 #ctxInput 取文本并添加一条上下文（空白不提交）。
  addContext: function (input, mode) {
    if (!input) return false;
    var text = String(input.value || "").trim();
    if (text.length === 0) return false;
    window.api.contextAdd({ text: text, mode: mode });
    input.value = "";
    return true;
  },

  // 功能 5：开关指令输入框（回车 / 点发送都走 events.executeSwitchCmd）。
  bindSwitchCmd: function () {
    var input = document.getElementById("switchCmdInput");
    var sendBtn = document.getElementById("switchCmdSend");
    var send = function () {
      if (!input) return;
      window.events.executeSwitchCmd(input.value);
      input.value = "";
    };
    if (input && !input.mbSwitchBound) {
      input.mbSwitchBound = true;
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") send(); });
    }
    window.panelSettings.bindClick(sendBtn, "mbSwitchSend", send);
  },

  // 功能 6：参数查询输入框（回车查询）。
  bindParamSearch: function () {
    var input = document.getElementById("paramSearchInput");
    if (!input || input.mbParamBound) return;
    input.mbParamBound = true;
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") window.panelSettings.searchParam(input.value);
    });
  },

  // 功能 7：拉取玩家等级与上下文（页面加载 / 打开高级面板时都调用）。
  load: function () {
    window.api.playerLoad();
    window.api.contextLoad();
  },

  // 兼容旧调用名。
  loadSettings: function () { window.panelSettings.load(); },

  // 功能 8：收集 6 个输入框（空格分隔）+ 自动判定开关，提交给主进程。
  savePlayer: function () {
    var manual = {};
    for (var i = 0; i < LEVEL_FIELDS.length; i++) {
      manual[LEVEL_FIELDS[i].key] = window.panelSettings.collectNames(LEVEL_FIELDS[i].id);
    }
    var autoEl = document.getElementById("playerAutoToggle");
    var autoJudge = autoEl ? !!autoEl.checked : true;
    var owners = window.panelSettings.collectNames("ownerNames");
    window.api.playerSave({ manual: manual, autoJudge: autoJudge, owners: owners });
    return true;
  },

  // 内部：按空白把输入框拆成玩家名数组（空框给空数组）。
  collectNames: function (id) {
    var el = document.getElementById(id);
    if (!el) return [];
    try { return String(el.value || "").split(/\s+/).filter(Boolean); }
    catch (e) { return []; }
  },

  // 功能 9：把主进程回包填回面板（6 个输入框 + 自动判定 + 手动开关状态）。
  fillPlayerPanel: function (data) {
    if (!data) return false;
    var manual = data.manual && typeof data.manual === "object" ? data.manual : {};
    var hasManual = false;
    for (var i = 0; i < LEVEL_FIELDS.length; i++) {
      var field = LEVEL_FIELDS[i];
      var list = Array.isArray(manual[field.key]) ? manual[field.key] : [];
      if (list.length > 0) hasManual = true;
      var el = document.getElementById(field.id);
      if (el) el.value = list.join(" ");
    }
    var autoEl = document.getElementById("playerAutoToggle");
    if (autoEl) autoEl.checked = data.autoJudge !== false;
    var toggle = document.getElementById("playerManualToggle");
    if (toggle) toggle.checked = hasManual;
    window.panelSettings.applyManualVisibility();
    window.panelSettings.renderOwnerBadges(data.owners);
    return true;
  },

  // 功能：把 isOwner=true 的玩家渲染成 👑 [主人] / 👑 [Owner] 标签；
  //       不传 owners 时从输入框重读（语言切换时用），双向都不碰 DOM 之外的状态。
  renderOwnerBadges: function (owners) {
    var box = document.getElementById("ownerBadges");
    if (!box) return false;
    var input = document.getElementById("ownerNames");
    var list = Array.isArray(owners) ? owners : [];
    if (!Array.isArray(owners) && input) list = window.panelSettings.collectNames("ownerNames");
    if (input && Array.isArray(owners)) input.value = list.join(" ");
    box.innerHTML = "";
    if (list.length === 0) {
      var empty = document.createElement("span");
      empty.className = "owner-empty";
      empty.textContent = window.t ? window.t("ownerBadgeEmpty") : "尚未配置主人 / No owner configured";
      box.appendChild(empty);
      return true;
    }
    var en = window.state && window.state.currentLang === "en";
    for (var i = 0; i < list.length; i++) {
      var tag = document.createElement("span");
      tag.className = "owner-badge";
      tag.textContent = (en ? "👑 [Owner] " : "👑 [主人] ") + String(list[i]);
      box.appendChild(tag);
    }
    return true;
  },

  // 内部：按手动开关决定 6 个输入框显示 / 隐藏。
  applyManualVisibility: function () {
    var toggle = document.getElementById("playerManualToggle");
    var box = document.getElementById("playerManualBox");
    if (!toggle || !box) return false;
    if (toggle.checked) box.classList.remove("hidden");
    else box.classList.add("hidden");
    return true;
  },

  // 功能 10：参数查询（主进程还没接 param 通道时给出双语提示，不抛错）。
  searchParam: function (key) {
    var text = String(key || "").trim();
    if (text.length === 0) return false;
    if (window.api && typeof window.api.paramGet === "function") {
      window.api.paramGet(text);
      return true;
    }
    window.panelSettings.showParam(text, "参数接口未接线 / param API not wired");
    return false;
  },

  // 功能 11：把一条参数结果写到 #paramResult。
  showParam: function (key, value) {
    var box = document.getElementById("paramResult");
    if (!box) return false;
    box.textContent = key + " = " + value;
    return true;
  }
};
