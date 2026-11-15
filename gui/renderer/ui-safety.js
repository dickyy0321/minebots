// ========================================
// 文件：gui/renderer/ui-safety.js
// 功能：沙盒容错与防呆安全 UI——红色告警横幅（连续断网 / AI 欠费 402）/ 微软授权弹窗 / 一键清理 state
// 依赖：window.api / window.t / window.util（已在其它脚本注入）
// 导出：window.uiSafety（bind / alert / clear）
// 说明：红警由主进程日志（402 / 网络错误）与内存检测回包触发；微软授权弹窗展示设备码与地址；
//       一键清理 state 走主进程 safety-clean（脱敏后打包）。所有外部调用 try/catch 包裹。
// 作者：MineBots
// ========================================

// 功能：绑定全部安全相关 UI（红警 / 微软弹窗 / 清理回包 / 内存回包），缺元素或缺少 API 时静默降级。
function bindSafety() {
  try {
      var msClose = document.getElementById("msAuthCloseBtn");
      if (msClose) msClose.addEventListener("click", function () {
        var m = document.getElementById("msAuthModal"); if (m) m.classList.add("hidden");
      });
      var red = document.getElementById("redAlert");
      if (red) red.addEventListener("click", function () { window.uiSafety.clear(); });

      if (window.api && typeof window.api.onMicrosoftAuthCode === "function") {
        window.api.onMicrosoftAuthCode(function (data) { window.uiSafety.showMsAuth(data); });
      }
      if (window.api && typeof window.api.onMicrosoftAuthStatus === "function") {
        window.api.onMicrosoftAuthStatus(function (data) { window.uiSafety.updateMsAuth(data); });
      }
      if (window.api && typeof window.api.onLog === "function") {
        window.api.onLog(function (entry) { window.uiSafety.checkLog(entry); });
      }
      if (window.api && typeof window.api.onSafetyCleanResult === "function") {
        window.api.onSafetyCleanResult(function (data) { window.uiSafety.onClean(data); });
      }
      if (window.api && typeof window.api.onSafetyMemoryResult === "function") {
        window.api.onSafetyMemoryResult(function (data) { window.uiSafety.onMemory(data); });
      }
      var cleanBtn = document.getElementById("safetyCleanBtn");
      if (cleanBtn) cleanBtn.addEventListener("click", function () {
        if (window.api && window.api.safetyClean) window.api.safetyClean({ pack: true });
      });
      var memBtn = document.getElementById("safetyMemoryBtn");
      if (memBtn) memBtn.addEventListener("click", function () {
        var n = 0; try { n = (window.state && window.state.bots) ? window.state.bots.length : 0; } catch (e) { n = 0; }
        if (window.api && window.api.safetyMemory) window.api.safetyMemory({ botCount: n });
      });
    } catch (e) { /* 绑定失败不影响其它功能 */ }
}

window.uiSafety = {
  alertTimer: null,

  // 功能：显示微软授权弹窗并填入设备码与访问地址。
  showMsAuth: function (data) {
    try {
      var m = document.getElementById("msAuthModal");
      var body = document.getElementById("msAuthBody");
      if (!m || !body) return;
      m.classList.remove("hidden");
      body.innerHTML = "";
      var tip = document.createElement("p"); tip.textContent = window.t("msAuthBody");
      var link = document.createElement("div"); link.className = "ms-auth-link";
      link.textContent = (data && data.url) ? String(data.url) : "https://www.microsoft.com/link";
      var code = document.createElement("div"); code.className = "ms-auth-code";
      code.textContent = (data && data.code) ? String(data.code) : "------";
      body.appendChild(tip); body.appendChild(link); body.appendChild(code);
    } catch (e) { /* 显示失败不影响授权流程 */ }
  },

  // 功能：更新授权进度文本。
  updateMsAuth: function (data) {
    try {
      var body = document.getElementById("msAuthBody");
      if (!body) return;
      var st = document.createElement("div"); st.className = "ms-auth-status";
      st.textContent = window.t("msAuthStatus") + "：" + ((data && data.text) ? String(data.text) : "");
      body.appendChild(st);
    } catch (e) { /* ignore */ }
  },

  // 功能：从主进程日志里识别致命错误（402 欠费 / 网络中断）并弹红警。
  checkLog: function (entry) {
    try {
      if (!entry) return;
      var msg = String(entry.message || entry.text || "");
      var lvl = String(entry.level || "");
      if (lvl !== "error" && lvl !== "warn") return;
      // 本地引擎没启动（Ollama / LM Studio / llama.cpp）不是致命错误：面板里提示即可，绝不弹红警。
      if (/ollama|11434|lm\s*studio|llama\.cpp|llama-server/i.test(msg)) return;
      if (/402|欠费|payment required/i.test(msg) || /ECONN|ENOTFOUND|网络中断|network down|断开|disconnect/i.test(msg)) {
        window.uiSafety.alert(msg);
      }
    } catch (e) { /* ignore */ }
  },

  // 功能：清理回包——成功显示提示，失败红警。
  onClean: function (data) {
    try {
      if (!data) return;
      if (data.ok) {
        if (window.uiLog && window.util) window.uiLog.add({ time: window.util.nowTime(), type: "SYSTEM", level: "info", message: window.t("safetyCleanDone") + ((data.path) ? data.path : "") });
      } else {
        window.uiSafety.alert(window.t("safetyCleanFail") + ((data.message) ? data.message : ""));
      }
    } catch (e) { /* ignore */ }
  },

  // 功能：内存检测回包——有告警时弹红警。
  onMemory: function (data) {
    try {
      if (!data) return;
      if (data.warn) window.uiSafety.alert(window.t("safetyMemoryWarn"));
    } catch (e) { /* ignore */ }
  },

  // 功能：弹出红色告警横幅（致命错误），8 秒后自动隐藏（点击也能立刻关）。
  alert: function (text) {
    try {
      var red = document.getElementById("redAlert");
      var txt = document.getElementById("redAlertText");
      if (!red) return;
      if (txt) txt.textContent = String(text || "");
      red.classList.remove("hidden");
      if (this.alertTimer) { try { clearTimeout(this.alertTimer); } catch (e) { /* ignore */ } }
      this.alertTimer = setTimeout(function () { window.uiSafety.clear(); }, 8000);
    } catch (e) { /* 弹红警失败只记日志 */ }
  },

  // 功能：隐藏红色告警横幅。
  clear: function () {
    try {
      var red = document.getElementById("redAlert");
      if (red) red.classList.add("hidden");
      if (this.alertTimer) { try { clearTimeout(this.alertTimer); } catch (e) { /* ignore */ } this.alertTimer = null; }
    } catch (e) { /* ignore */ }
  }
};

// 挂载绑定入口：events.js 通过 window.uiSafety.bind() 调用。
window.uiSafety.bind = bindSafety;
