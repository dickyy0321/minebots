// ========================================
// 文件：gui/renderer/panel-model.js
// 功能：设置页【模型档案池】面板——档案清单 / 每个 bot 独立选 AI 大脑引擎 / 单例内存统计
// 依赖：window.api（preload 暴露）、window.botAPI（回包监听）、window.state / window.uiLog
// 导出：window.panelModel = { init, fill, refresh, stats }
// 说明：renderer 层禁止 require；档案对象由主进程内存共享单例持有，这里只存名字，不复制配置。
// 作者：MineBots
// ========================================
window.panelModel = {
  inited: false,
  lastData: null,
  FALLBACK: ["deepseek", "openai", "hunyuan", "custom", "ollama", "lmstudio", "llamacpp", "sglang"],
  defaultProfile: "deepseek",

  // 取元素：找不到返回 null，绝不抛错。
  byId: function (id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  },

  // 安全取文本：null / undefined 统一成空串。
  text: function (value) {
    try { return String(value === null || value === undefined ? "" : value); } catch (e) { return ""; }
  },

  // 往状态栏写一行结果并留日志。
  say: function (msg) {
    var box = window.panelModel.byId("modelStatus");
    if (box) box.textContent = msg;
    try { if (window.uiLog && window.uiLog.add) window.uiLog.add({ time: window.util.nowTime(), type: "SYSTEM", level: "info", message: msg }); } catch (e) { /* 日志缺失不影响 */ }
  },

  // 填机器人下拉框：没有卡片数据时塞 bot-1 占位。
  fillBots: function () {
    var sel = window.panelModel.byId("modelBotSelect");
    if (!sel) return false;
    try {
      var bots = (window.state && window.state.bots) || [];
      var keep = sel.value;
      sel.innerHTML = "";
      for (var i = 0; i < bots.length; i++) {
        var opt = document.createElement("option");
        opt.value = window.panelModel.text(bots[i].id);
        opt.textContent = opt.value;
        sel.appendChild(opt);
      }
      if (bots.length === 0) {
        var one = document.createElement("option");
        one.value = "bot-1"; one.textContent = "bot-1";
        sel.appendChild(one);
      }
      if (keep) sel.value = keep;
      return true;
    } catch (e) { return false; }
  },

  // 填档案下拉框与档案卡列表；档案列表为空时用内置白名单兜底。
  fillProfiles: function (profiles, assignments) {
    var out = { ok: false, count: 0 };
    try {
      var list = Array.isArray(profiles) && profiles.length > 0 ? profiles : [];
      var names = [];
      for (var i = 0; i < list.length; i++) names.push(window.panelModel.text(list[i].name));
      if (names.length === 0) names = window.panelModel.FALLBACK.slice(0);
      window.state.modelProfiles = names;
      window.state.modelAssignments = assignments && typeof assignments === "object" ? assignments : {};
      var sel = window.panelModel.byId("modelProfileSelect");
      if (sel) {
        var keep = sel.value;
        sel.innerHTML = "";
        for (var j = 0; j < names.length; j++) {
          var opt = document.createElement("option");
          opt.value = names[j];
          opt.textContent = j < list.length ? window.panelModel.text(list[j].label) : names[j];
          sel.appendChild(opt);
        }
        if (keep && names.indexOf(keep) >= 0) sel.value = keep;
        else if (window.panelModel.defaultProfile && names.indexOf(window.panelModel.defaultProfile) >= 0) sel.value = window.panelModel.defaultProfile;
      }
      var box = window.panelModel.byId("modelProfileList");
      if (box) {
        box.innerHTML = "";
        for (var k = 0; k < names.length; k++) {
          var def = k < list.length ? list[k] : {};
          var card = document.createElement("div");
          card.className = "model-card";
          card.setAttribute("data-model-card", names[k]);
          var head = document.createElement("div");
          head.className = "model-card-head";
          var title = document.createElement("span");
          title.className = "model-card-name";
          title.textContent = def.label ? window.panelModel.text(def.label) : names[k];
          var badge = document.createElement("span");
          var prov = window.panelModel.text(def.provider || "cloud");
          badge.className = "model-badge " + (prov === "local" ? "local" : "cloud");
          badge.textContent = prov === "local" ? "本地 / local" : "云端 / cloud";
          head.appendChild(title);
          head.appendChild(badge);
          card.appendChild(head);
          var meta = document.createElement("div");
          meta.className = "model-card-meta";
          meta.textContent = window.panelModel.text(def.engine || "-") + " · " + window.panelModel.text(def.model || "(默认 / default)");
          card.appendChild(meta);
          var url = document.createElement("div");
          url.className = "model-card-url";
          url.textContent = window.panelModel.text(def.baseUrl || "(沿用 AI 配置页 / uses AI config page)");
          card.appendChild(url);
          if (def.note) {
            var note = document.createElement("div");
            note.className = "cmd-hint";
            note.textContent = window.panelModel.text(def.note);
            card.appendChild(note);
          }
          var acts = document.createElement("div");
          acts.className = "model-card-acts";
          var applyBtn = document.createElement("button");
          applyBtn.className = "btn primary small";
          applyBtn.textContent = "应用到 Bot / Apply";
          applyBtn.setAttribute("data-apply-profile", names[k]);
          applyBtn.addEventListener("click", function () {
            var botSel = window.panelModel.byId("modelBotSelect");
            var botId = botSel && botSel.value ? String(botSel.value) : "bot-1";
            var profile = this.getAttribute("data-apply-profile");
            try { if (window.api && window.api.modelProfileSet) window.api.modelProfileSet({ botId: botId, profile: profile }); } catch (e) { /* ignore */ }
            window.panelModel.say(botId + " → " + profile);
          });
          var removeBtn = document.createElement("button");
          removeBtn.className = "btn small";
          removeBtn.textContent = "移除 / Remove";
          removeBtn.setAttribute("data-remove-profile", names[k]);
          removeBtn.addEventListener("click", function () {
            var botSel = window.panelModel.byId("modelBotSelect");
            var botId = botSel && botSel.value ? String(botSel.value) : "bot-1";
            try { if (window.api && window.api.modelProfileRemove) window.api.modelProfileRemove({ botId: botId }); } catch (e) { /* ignore */ }
            window.panelModel.say(botId + " 已恢复默认 / back to default");
          });
          acts.appendChild(applyBtn);
          acts.appendChild(removeBtn);
          card.appendChild(acts);
          box.appendChild(card);
        }
      }
      out.count = names.length;
      out.ok = true;
      return out;
    } catch (e) { return out; }
  },

  // 处理主进程回包：刷新档案表 / bot 选择 / 单例统计，并同步卡片上的 AI 大脑概览。
  fill: function (data) {
    var out = { ok: false, profiles: 0 };
    try {
      var d = data && typeof data === "object" ? data : {};
      window.panelModel.lastData = d;
      out.profiles = window.panelModel.fillProfiles(d.profiles, d.assignments).count;
      window.panelModel.fillBots();
      var st = d.stats && typeof d.stats === "object" ? d.stats : {};
      window.state.modelStats = st;
      if (st.defaultProfile) window.panelModel.defaultProfile = String(st.defaultProfile);
      var botSel = window.panelModel.byId("modelBotSelect");
      if (botSel && d.assignments && d.assignments[botSel.value]) {
        var profSel = window.panelModel.byId("modelProfileSelect");
        if (profSel) profSel.value = d.assignments[botSel.value];
      }
      var extra = " · 档案 " + (st.profiles || 0) + " / 实例 " + (st.instances || 0) + " / 已选 bot " + (st.assignments || 0);
      window.panelModel.say(window.panelModel.text(d.message || "档案池已刷新 / profile pool refreshed") + extra);
      try { if (window.uiBot && window.uiBot.renderBots) window.uiBot.renderBots(); } catch (eCard) { /* 卡片重绘失败不影响 */ }
      out.ok = true;
      return out;
    } catch (e) { return out; }
  },

  // 拉一次最新档案池。
  refresh: function () {
    try { if (window.api && window.api.modelProfileList) { window.api.modelProfileList(); return true; } } catch (e) { /* 降级 */ }
    return false;
  },

  // 绑定应用 / 刷新按钮 + 回包监听；同一元素只绑一次。
  init: function () {
    var out = { ok: false, bound: 0 };
    try {
      var self = window.panelModel;
      var applyBtn = self.byId("modelApplyBtn");
      if (applyBtn && !applyBtn._mbBoundModel) {
        applyBtn._mbBoundModel = true;
        applyBtn.addEventListener("click", function () {
          var botSel = self.byId("modelBotSelect");
          var profSel = self.byId("modelProfileSelect");
          if (window.api && window.api.modelProfileSet) {
            window.api.modelProfileSet({ botId: botSel ? botSel.value : "bot-1", profile: profSel ? profSel.value : "deepseek" });
          } else self.say("通道不可用 / model API unavailable");
        });
        out.bound = out.bound + 1;
      }
      var refreshBtn = self.byId("modelRefreshBtn");
      if (refreshBtn && !refreshBtn._mbBoundModel) {
        refreshBtn._mbBoundModel = true;
        refreshBtn.addEventListener("click", function () { self.refresh(); });
        out.bound = out.bound + 1;
      }
      if (!self.inited && window.botAPI && window.botAPI.onModelProfileResult) {
        window.botAPI.onModelProfileResult(function (data) { self.fill(data); });
        self.inited = true;
      }
      self.fillProfiles([], {});
      self.fillBots();
      self.refresh();
      out.ok = true;
      return out;
    } catch (e) { return out; }
  },

  // 给自检读的状态快照。
  stats: function () {
    return { inited: window.panelModel.inited, profiles: (window.state.modelProfiles || []).length };
  }
};

// 页面就绪后自动初始化；主页没有这些元素时安全降级。
try {
  document.addEventListener("DOMContentLoaded", function () {
    try { window.panelModel.init(); } catch (e) { /* 初始化失败不影响其它面板 */ }
  });
} catch (eOuter) { /* 非浏览器环境直接忽略 */ }
