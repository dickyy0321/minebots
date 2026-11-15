// ========================================
// 文件：gui/renderer/ui-wizard.js
// 功能：首次向导——三步走（填 API Key -> 选流派 -> 生成第一个 Bot），首次打开软件弹出
// 依赖：window.api / window.addBot / window.updateBot / window.uiLog / window.t / window.util（全部已在其它脚本注入）
// 导出：window.uiWizard（bind / show / hide / next / prev / skip）
// 说明：向导只在 localStorage 没有 minebots-wizard-done 时弹出；风险告知弹窗关闭后触发；
//       每一步的数据即时落盘（AI 配置 / 机器人人格），绝不阻塞主流程。界面文字中英双语。
// 作者：MineBots
// ========================================

// 功能：绑定向导按钮与「风险弹窗关闭后触发向导」；缺元素时静默返回，绝不抛错。
function bindWizard() {
    try {
      var modal = document.getElementById("wizardModal");
      var nextBtn = document.getElementById("wizardNextBtn");
      var prevBtn = document.getElementById("wizardPrevBtn");
      var skipBtn = document.getElementById("wizardSkipBtn");
      if (nextBtn) nextBtn.addEventListener("click", function () { window.uiWizard.next(); });
      if (prevBtn) prevBtn.addEventListener("click", function () { window.uiWizard.prev(); });
      if (skipBtn) skipBtn.addEventListener("click", function () { window.uiWizard.skip(); });
      // 风险告知弹窗关闭后，若向导没做过就弹出。
      var frClose = document.getElementById("frCloseBtn");
      var frNoMore = document.getElementById("frNoMoreBtn");
      var afterRisk = function () {
        try {
          if (localStorage.getItem("minebots-wizard-done") === "1") return;
          window.uiWizard.show();
        } catch (e) { /* 取不到本地存储只跳过向导 */ }
      };
      if (frClose && !frClose._mbWizard) { frClose._mbWizard = true; frClose.addEventListener("click", afterRisk); }
      if (frNoMore && !frNoMore._mbWizard) { frNoMore._mbWizard = true; frNoMore.addEventListener("click", afterRisk); }
    } catch (e) { /* 绑定失败不影响其它功能 */ }
}

window.uiWizard = {
  step: 1,
  persona: "",

  // 功能：显示向导并渲染第一步。
  show: function () {
    try {
      this.step = 1; this.persona = "";
      var modal = document.getElementById("wizardModal");
      if (modal) modal.classList.remove("hidden");
      this.render();
    } catch (e) { /* 显示失败不影响后续 */ }
  },

  // 功能：隐藏向导并标记已完成（写入 localStorage，重启不再弹）。
  hide: function () {
    try {
      var modal = document.getElementById("wizardModal");
      if (modal) modal.classList.add("hidden");
      localStorage.setItem("minebots-wizard-done", "1");
    } catch (e) { /* 写本地存储失败只隐藏 */ }
  },

  // 功能：渲染步骤指示条与当前步内容。
  render: function () {
    try {
      var steps = document.getElementById("wizardSteps");
      if (steps) {
        steps.innerHTML = "";
        for (var i = 1; i <= 3; i++) {
          var d = document.createElement("div");
          d.className = "step" + (i === this.step ? " active" : "");
          d.textContent = String(i);
          steps.appendChild(d);
        }
      }
      var body = document.getElementById("wizardBody");
      if (!body) return;
      body.innerHTML = "";
      if (this.step === 1) {
        var h1 = document.createElement("h3"); h1.textContent = window.t("wizardStep1Title");
        var p1 = document.createElement("p"); p1.textContent = window.t("wizardStep1Body");
        var row1 = document.createElement("div"); row1.className = "row";
        var inp1 = document.createElement("input"); inp1.className = "input"; inp1.id = "wwApiKey";
        inp1.setAttribute("placeholder", "sk-... / 本地 Ollama 可留空");
        this._apiKeyEl = inp1;
        row1.appendChild(inp1);
        body.appendChild(h1); body.appendChild(p1); body.appendChild(row1);
      } else if (this.step === 2) {
        var h2 = document.createElement("h3"); h2.textContent = window.t("wizardStep2Title");
        var p2 = document.createElement("p"); p2.textContent = window.t("wizardStep2Body");
        var row2 = document.createElement("div"); row2.className = "row";
        var sel = document.createElement("select"); sel.className = "cmd-select"; sel.id = "wwStyle";
        this._styleEl = sel;
        var styles = [["miner", "矿工 / Miner"], ["guard", "守卫 / Guard"], ["builder", "建筑师 / Builder"]];
        for (var s = 0; s < styles.length; s++) {
          var o = document.createElement("option"); o.value = styles[s][0]; o.textContent = styles[s][1]; sel.appendChild(o);
        }
        row2.appendChild(sel);
        body.appendChild(h2); body.appendChild(p2); body.appendChild(row2);
      } else {
        var h3 = document.createElement("h3"); h3.textContent = window.t("wizardStep3Title");
        var p3 = document.createElement("p"); p3.textContent = window.t("wizardStep3Body");
        var gen = document.createElement("button"); gen.className = "btn primary small"; gen.id = "wwGenerate";
        gen.textContent = window.t("wizardFinish");
        var self = this;
        gen.addEventListener("click", function () { self.finish(); });
        body.appendChild(h3); body.appendChild(p3); body.appendChild(gen);
      }
    } catch (e) { /* 渲染失败不影响弹窗 */ }
  },

  // 功能：下一步——先保存当前步数据，到第三步的「下一步」即生成 Bot；最后一步点生成走 finish。
  next: function () {
    try {
      if (this.step === 1) {
        var k = this._apiKeyEl;
        if (k && window.api && window.api.aiConfigSave) {
          window.api.aiConfigSave({ apiKey: String(k.value || "") });
        }
        this.step = 2; this.render();
      } else if (this.step === 2) {
        var st = this._styleEl;
        var map = { miner: "勤劳的矿工 / hardworking miner", guard: "忠诚的守卫 / loyal guard", builder: "创意建筑师 / creative builder" };
        this.persona = st ? (map[st.value] || "") : "";
        this.step = 3; this.render();
      } else {
        this.finish();
      }
    } catch (e) { /* 推进失败保持当前步 */ }
  },

  // 功能：上一步。
  prev: function () {
    try { if (this.step > 1) { this.step = this.step - 1; this.render(); } } catch (e) { /* ignore */ }
  },

  // 功能：跳过向导（直接标记完成，不再弹）。
  skip: function () {
    try { this.hide(); } catch (e) { /* ignore */ }
  },

  // 功能：生成 / 配置第一个 Bot：确保 bot-1 存在并写入人格，完成后隐藏向导。
  finish: function () {
    try {
      if (!window.getBot || !window.getBot("bot-1")) {
        if (window.addBot) window.addBot();
      }
      if (window.updateBot && this.persona) window.updateBot("bot-1", { persona: this.persona });
      if (window.uiLog && window.util) {
        window.uiLog.add({ time: window.util.nowTime(), type: "SYSTEM", level: "info", message: window.t("wizardFinish") + " (bot-1)" });
      }
      this.hide();
    } catch (e) { /* 生成失败也隐藏向导 */ }
  }
};

// 挂载绑定入口：events.js 通过 window.uiWizard.bind() 调用。
window.uiWizard.bind = bindWizard;
