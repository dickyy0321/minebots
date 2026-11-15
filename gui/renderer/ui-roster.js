// ========================================
// 文件：gui/renderer/ui-roster.js
// 功能：Bot 后台仓库 UI——导入皮肤 / 一键保存全部配置 / 后台列表 / 一键恢复 / 永久删除
// 依赖：window.api / window.uiBot / window.uiLog / window.util / window.t（已在其它脚本注入）
// 导出：window.uiRoster（bind / saveBot / importSkin / autoRestore / restoreAll / mergeRestored / remove / refresh / renderList / paintAvatar）
// 说明：仓库在主进程后台（%APPDATA%/MineBots/roster），本地 localStorage 被清空也能恢复；
//       永久删除必须二次确认，删完档案与皮肤一起没。界面文字中英双语，外部调用全部 try/catch。
// 作者：MineBots
// ========================================

window.uiRoster = {
  bound: false,
  skinCache: {},
  list: [],

  // 统一的日志出口：缺 uiLog 时退回 console。
  log: function (msg, level) {
    try {
      if (window.uiLog && window.util) {
        window.uiLog.add({ time: window.util.nowTime(), type: "SYSTEM", level: level || "info", message: String(msg) });
        return;
      }
    } catch (e) { /* console */ }
    try { console.log("[roster] " + msg); } catch (e2) { /* ignore */ }
  },

  // 收集某个 Bot 的全部配置（去掉瞬时 status），用作后台档案。
  collectProfile: function (id) {
    try {
      var b = window.getBot ? window.getBot(id) : null;
      if (!b) return null;
      var out = {};
      for (var k in b) {
        if (Object.prototype.hasOwnProperty.call(b, k) && k !== "status") out[k] = b[k];
      }
      out.status = undefined;
      try { delete out.status; } catch (eD) { /* ignore */ }
      try { out.modelProfile = (window.state.modelAssignments && window.state.modelAssignments[id]) || ""; } catch (eM) { out.modelProfile = ""; }
      out.savedAt = new Date().toISOString();
      return out;
    } catch (e) { return null; }
  },

  // 一键保存到后台仓库。
  saveBot: function (id) {
    try {
      var p = this.collectProfile(id);
      if (!p) { this.log(window.t("rosterNoBot"), "warn"); return; }
      if (!window.api || typeof window.api.rosterSave !== "function") { this.log(window.t("rosterNoApi"), "warn"); return; }
      window.api.rosterSave({ profile: p });
    } catch (e) { this.log("保存失败 / save failed: " + String(e && e.message ? e.message : e), "error"); }
  },

  // 选择 PNG 并导入为该 Bot 的皮肤。
  importSkin: function (id) {
    try {
      var self = this;
      var input = document.createElement("input");
      input.type = "file";
      input.accept = "image/png";
      input.style.display = "none";
      input.addEventListener("change", function () {
        try {
          var f = input.files && input.files[0];
          if (!f) return;
          if (f.size > 2 * 1024 * 1024) { self.log(window.t("skinTooLarge"), "warn"); return; }
          var reader = new FileReader();
          reader.onload = function () {
            try {
              if (!window.api || typeof window.api.skinImport !== "function") { self.log(window.t("rosterNoApi"), "warn"); return; }
              window.api.skinImport({ botId: id, fileName: f.name, dataBase64: String(reader.result || "") });
            } catch (eI) { self.log("导入失败 / import failed: " + String(eI && eI.message ? eI.message : eI), "error"); }
          };
          reader.readAsDataURL(f);
        } catch (eC) { self.log("读取文件失败 / read failed: " + String(eC && eC.message ? eC.message : eC), "error"); }
      });
      try { document.body.appendChild(input); } catch (eA) { /* 某些环境不需要挂载 */ }
      input.click();
    } catch (e) { this.log("无法打开文件选择 / file picker failed: " + String(e && e.message ? e.message : e), "error"); }
  },

  // 把皮肤元信息写回本地 Bot，并立刻刷新卡片。
  applySkin: function (botId, skin) {
    try {
      var b = window.getBot ? window.getBot(botId) : null;
      if (!b || !skin) return;
      b.skin = skin;
      if (window.saveBots) window.saveBots();
      if (window.uiBot) window.uiBot.renderBots();
      this.skinCache[botId] = null;
      // 导入皮肤即自动把该 Bot 的全部配置连同皮肤存进后台，省一次点击。
      this.saveBot(botId);
      this.refresh();
    } catch (e) { /* ignore */ }
  },

  // 画头像：优先用缓存，其次向主进程要 base64；没有皮肤就画一个带首字母的色块。
  paintAvatar: function (canvas, botId) {
    try {
      if (!canvas) return;
      var cached = this.skinCache[botId];
      if (cached && cached !== "none") { this.drawAvatar(canvas, cached); return; }
      if (cached === "none") { this.drawFallback(canvas, botId); return; }
      if (!window.api || typeof window.api.skinGet !== "function") { this.drawFallback(canvas, botId); return; }
      window.api.skinGet({ botId: botId });
    } catch (e) { /* ignore */ }
  },

  drawAvatar: function (canvas, base64) {
    try {
      canvas.width = 40; canvas.height = 40;
      var ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, 40, 40);
      var img = new Image();
      img.onload = function () {
        try {
          ctx.imageSmoothingEnabled = false;
          ctx.clearRect(0, 0, 40, 40);
          ctx.drawImage(img, 8, 8, 8, 8, 0, 0, 40, 40);
          if (img.height >= 64) { try { ctx.drawImage(img, 40, 8, 8, 8, 0, 0, 40, 40); } catch (eH) { /* 无帽子层 */ } }
        } catch (eD) { /* ignore */ }
      };
      img.src = "data:image/png;base64," + base64;
    } catch (e) { /* ignore */ }
  },

  drawFallback: function (canvas, botId) {
    try {
      canvas.width = 40; canvas.height = 40;
      var ctx = canvas.getContext("2d");
      if (!ctx) return;
      var hash = 0, text = String(botId || "?");
      for (var i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
      var hue = hash % 360;
      ctx.fillStyle = "hsl(" + hue + ", 45%, 38%)";
      ctx.fillRect(0, 0, 40, 40);
      ctx.fillStyle = "#e6edf3";
      ctx.font = "bold 20px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text.replace(/^bot-/, "").slice(0, 2) || "?", 20, 21);
    } catch (e) { /* ignore */ }
  },

  // 合并后台档案：默认占位 bot 会被清掉；已有 id 覆盖配置，没有则新增。
  mergeRestored: function (items) {
    try {
      if (!Array.isArray(items) || items.length === 0) return 0;
      var bots = window.state.bots || [];
      if (bots.length === 1 && bots[0].id === "bot-1" && bots[0].username === "MineBot1" && !bots[0].persona && !bots[0].skin) {
        bots = [];
      }
      var added = 0, patched = 0;
      for (var i = 0; i < items.length; i++) {
        var it = items[i] || {};
        var prof = it.profile || it;
        var id = prof.id || it.id;
        if (!id) continue;
        var cur = null;
        for (var c = 0; c < bots.length; c++) { if (bots[c].id === id) { cur = bots[c]; break; } }
        if (cur) {
          for (var k in prof) { if (Object.prototype.hasOwnProperty.call(prof, k)) cur[k] = prof[k]; }
          patched++;
        } else {
          var nb = window.uiBot ? window.uiBot.normalizeBot(prof, bots.length) : prof;
          nb.skin = prof.skin || it.skin || null;
          bots.push(nb);
          added++;
        }
      }
      window.state.bots = bots;
      if (window.saveBots) window.saveBots();
      if (window.uiBot) { window.uiBot.renderBots(); window.uiBot.renderBotSelects(); }
      this.log(window.t("rosterRestored") + " +" + added + " / ~" + patched);
      return added + patched;
    } catch (e) { return 0; }
  },

  // 一键恢复全部。
  restoreAll: function () {
    try {
      if (!window.api || typeof window.api.rosterRestore !== "function") { this.log(window.t("rosterNoApi"), "warn"); return; }
      window.api.rosterRestore();
    } catch (e) { /* ignore */ }
  },

  // 单条恢复。
  loadOne: function (id) {
    try {
      if (!window.api || typeof window.api.rosterLoad !== "function") return;
      window.api.rosterLoad({ id: id });
    } catch (e) { /* ignore */ }
  },

  // 永久删除（档案 + 皮肤），二次确认。
  remove: function (id) {
    try {
      var ok = true;
      try { ok = window.confirm(window.t("rosterDeleteConfirm") + "\n" + id); } catch (eC) { ok = true; }
      if (!ok) return;
      if (!window.api || typeof window.api.rosterDelete !== "function") return;
      window.api.rosterDelete({ id: id });
    } catch (e) { /* ignore */ }
  },

  refresh: function () {
    try { if (window.api && typeof window.api.rosterList === "function") window.api.rosterList(); } catch (e) { /* ignore */ }
  },

  renderList: function () {
    try {
      var box = document.getElementById("rosterList");
      if (!box) return;
      box.innerHTML = "";
      if (!this.list.length) {
        var empty = document.createElement("div");
        empty.className = "cmd-hint";
        empty.textContent = window.t("rosterEmpty");
        box.appendChild(empty);
        return;
      }
      var self = this;
      for (var i = 0; i < this.list.length; i++) {
        var it = this.list[i] || {};
        var row = document.createElement("div");
        row.className = "roster-row";
        var canvas = document.createElement("canvas");
        canvas.className = "roster-avatar";
        row.appendChild(canvas);
        self.paintAvatar(canvas, it.id);
        var info = document.createElement("div");
        info.className = "roster-info";
        var title = document.createElement("div");
        title.className = "roster-title";
        title.textContent = it.id + " · " + (it.username || "-");
        var sub = document.createElement("div");
        sub.className = "cmd-hint";
        sub.textContent = (it.version || "-") + " · " + (it.host || "-") + ":" + (it.port || "-") + " · " + (it.updatedAt || it.savedAt || "");
        info.appendChild(title);
        info.appendChild(sub);
        row.appendChild(info);
        var acts = document.createElement("div");
        acts.className = "roster-acts";
        var loadBtn = document.createElement("button");
        loadBtn.className = "btn primary small";
        loadBtn.textContent = window.t("rosterRestore");
        loadBtn.addEventListener("click", function () { self.loadOne(this.getAttribute("data-load-for")); });
        loadBtn.setAttribute("data-load-for", it.id);
        var delBtn = document.createElement("button");
        delBtn.className = "btn danger small";
        delBtn.textContent = window.t("rosterDelete");
        delBtn.addEventListener("click", function () { self.remove(this.getAttribute("data-del-for")); });
        delBtn.setAttribute("data-del-for", it.id);
        acts.appendChild(loadBtn);
        acts.appendChild(delBtn);
        row.appendChild(acts);
        box.appendChild(row);
      }
    } catch (e) { /* ignore */ }
  },

  // 启动时自动恢复：仅当本地只有默认占位 bot（或为空）才拉后台，避免覆盖用户新改的配置。
  autoRestore: function () {
    try {
      var bots = window.state.bots || [];
      var placeholder = bots.length === 0 || (bots.length === 1 && bots[0].id === "bot-1" && bots[0].username === "MineBot1" && !bots[0].persona);
      if (!placeholder) return;
      if (!window.api || typeof window.api.rosterRestore !== "function") return;
      window.api.rosterRestore();
    } catch (e) { /* ignore */ }
  },

  bind: function () {
    if (this.bound) return;
    this.bound = true;
    try {
      var self = this;
      if (window.api && typeof window.api.onRosterListResult === "function") {
        window.api.onRosterListResult(function (res) {
          try {
            self.list = (res && res.items) || [];
            self.renderList();
          } catch (e) { /* ignore */ }
        });
      }
      if (window.api && typeof window.api.onRosterSaveResult === "function") {
        window.api.onRosterSaveResult(function (res) {
          try {
            if (res && res.ok) self.log(window.t("rosterSaved") + " " + (res.id || ""));
            else self.log(window.t("rosterSaveFail") + " " + ((res && res.message) || ""), "warn");
            self.refresh();
          } catch (e) { /* ignore */ }
        });
      }
      if (window.api && typeof window.api.onRosterRestoreResult === "function") {
        window.api.onRosterRestoreResult(function (res) {
          try {
            if (!res || res.ok === false) { self.log(window.t("rosterSaveFail") + " " + ((res && res.message) || ""), "warn"); return; }
            self.mergeRestored((res && res.items) || []);
            self.refresh();
          } catch (e) { /* ignore */ }
        });
      }
      if (window.api && typeof window.api.onRosterLoadResult === "function") {
        window.api.onRosterLoadResult(function (res) {
          try { if (res && res.ok) { self.mergeRestored([res]); self.refresh(); } } catch (e) { /* ignore */ }
        });
      }
      if (window.api && typeof window.api.onRosterDeleteResult === "function") {
        window.api.onRosterDeleteResult(function (res) {
          try { self.log((res && res.ok) ? window.t("rosterDeleted") : window.t("rosterDeleteFail"), (res && res.ok) ? "info" : "warn"); self.refresh(); } catch (e) { /* ignore */ }
        });
      }
      if (window.api && typeof window.api.onSkinImportResult === "function") {
        window.api.onSkinImportResult(function (res) {
          try {
            if (res && res.ok && res.skin) { self.applySkin(res.botId, res.skin); self.log(window.t("skinImported") + " " + res.botId); }
            else self.log(window.t("skinImportFail") + " " + ((res && res.message) || ""), "warn");
          } catch (e) { /* ignore */ }
        });
      }
      if (window.api && typeof window.api.onSkinGetResult === "function") {
        window.api.onSkinGetResult(function (res) {
          try {
            if (res && res.ok) {
              self.skinCache[res.botId] = res.base64;
              var list = document.querySelectorAll('canvas[data-avatar-for]');
              for (var i = 0; i < list.length; i++) {
                if (list[i].getAttribute("data-avatar-for") === res.botId) self.drawAvatar(list[i], res.base64);
              }
            } else if (res && res.botId) {
              self.skinCache[res.botId] = "none";
            }
          } catch (e) { /* ignore */ }
        });
      }
      if (window.api && typeof window.api.onSkinRemoveResult === "function") {
        window.api.onSkinRemoveResult(function (res) {
          try { self.log((res && res.ok) ? window.t("skinRemoved") : window.t("skinImportFail"), (res && res.ok) ? "info" : "warn"); } catch (e) { /* ignore */ }
        });
      }
      var restoreBtn = document.getElementById("rosterRestoreAllBtn");
      if (restoreBtn) restoreBtn.addEventListener("click", function () { self.restoreAll(); });
      var refreshBtn = document.getElementById("rosterRefreshBtn");
      if (refreshBtn) refreshBtn.addEventListener("click", function () { self.refresh(); });
      // 有卡片列表的主窗口才自动恢复；设置页只做仓库管理。
      if (document.getElementById("botsBox")) self.autoRestore();
      self.refresh();
    } catch (e) { /* 绑定失败不影响其它功能 */ }
  }
};

// 两个页面都挂：主界面（卡片）与设置页（仓库面板）。
try {
  if (typeof window.addEventListener === "function") {
    window.addEventListener("DOMContentLoaded", function () {
      try { window.uiRoster.bind(); } catch (e) { /* ignore */ }
    });
  }
} catch (e) { /* ignore */ }
