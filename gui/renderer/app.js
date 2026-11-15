// gui/renderer/app.js
// 入口：初始化

// 依据主进程回包严格判定 bot 的新状态：只认白名单，返回空字符串表示「保持原状态、不乱改」。
// Resolve the new status from a main-process reply; an empty string means "keep the current status".
window.resolveResultStatus = function (result) {
  try {
    if (!result) return "";
    var msg = result.message ? String(result.message) : "";
    if (msg === "started") return "running";
    if (msg === "stopped") return "stopped";
    // 重复启动不是失败：主进程回 already running，此时显示必须保持运行中。
    if (msg.indexOf("already running") >= 0) return "";
    if (result.ok === false) return "stopped";
    return "";
  } catch (err) {
    return "";
  }
};

window.maybeShowFirstRun = function () {
  var done = localStorage.getItem("minebots-first-run-done");
  if (done === "1") return;
  var modal = document.getElementById("firstRunModal");
  if (modal) modal.classList.remove("hidden");
};

window.addEventListener("DOMContentLoaded", function () {
  // 1. 加载机器人
  window.loadBots();
  if (window.state.bots.length === 0) {
    window.state.bots.push({
      id: "bot-1", hostType: "local", host: "localhost",
      port: 25565, username: "MineBot1", password: "",
      typingSpeed: 3, autoRespawn: true, aiEnabled: true, persona: "",
      status: "idle"
    });
    window.saveBots();
  }

  // 2. 应用语言
  window.ui.applyLang();
  window.ui.renderAll();

  // 3. 加载高级设置
  window.events.loadAdvanced();

  // 4. 首次运行弹窗
  window.maybeShowFirstRun();

  // 5. 加载 AI 配置
  window.api.aiConfigLoad();

  // 5.1 同步日志语言到主进程：渲染进程重载后 state.logLang 会回到默认值，
  // 不同步就会出现“按钮写着中文日志、主进程仍输出英文”的错位。
  // Sync log language on startup so a renderer reload cannot desync from the main process.
  if (window.api && window.api.setLogLang) window.api.setLogLang(window.state.logLang);

  // 6. 绑定所有事件
  window.events.bind();

  // 6.1 双模式界面：扫描高级参数分组并应用上次保存的新手 / 专家模式（幂等）。
  if (window.uiMode) window.uiMode.init();

  // 7. 监听主进程推送
  if (window.botAPI && window.botAPI.onLog) {
    window.botAPI.onLog(function (entry) {
      window.uiLog.add(entry);
    });
  }
  if (window.botAPI && window.botAPI.onResult) {
    window.botAPI.onResult(function (result) {
      if (result && result.id) {
        // 严格白名单：只有主进程明确说 started / stopped（或真失败）才动状态；
        // scheduled、already running、队列回包等一律保持原状态，避免「一点启动就变已停止」的错乱。
        // Strict whitelist: only an explicit started / stopped (or a real failure) changes the status.
        var newStatus = window.resolveResultStatus(result);
        if (newStatus) window.updateBot(result.id, { status: newStatus });
        if (window.ui && typeof window.ui.refreshStatuses === "function") window.ui.refreshStatuses();
      }
      window.uiLog.add({
        time: window.util.nowTime(),
        type: "SYSTEM",
        level: (result && result.ok) ? "info" : "warn",
        message: JSON.stringify(result)
      });
    });
  }
  if (window.botAPI && window.botAPI.onContextData) {
    window.botAPI.onContextData(function (data) {
      window.uiContext.render(data);
    });
  }
  if (window.botAPI && window.botAPI.onContextResult) {
    window.botAPI.onContextResult(function (r) {
      if (r && r.ok) {
        var isAdd = r.mode === "permanent" || r.mode === "temporary";
        window.uiLog.add({
          time: window.util.nowTime(), type: "SYSTEM", level: "info",
          message: isAdd ? window.t("ctxAdded") : window.t("ctxRemoved")
        });
      }
    });
  }
  if (window.botAPI && window.botAPI.onPlayerData) {
    window.botAPI.onPlayerData(function (data) {
      window.events.fillPlayerPanel(data);
    });
  }
  if (window.botAPI && window.botAPI.onPlayerResult) {
    window.botAPI.onPlayerResult(function () {
      window.uiLog.add({
        time: window.util.nowTime(), type: "SYSTEM", level: "info", message: window.t("saved")
      });
    });
  }
  if (window.botAPI && window.botAPI.onAiConfigData) {
    window.botAPI.onAiConfigData(function (data) {
      window.events.fillAiConfig(data);
    });
  }
  if (window.botAPI && window.botAPI.onAiConfigTestResult) {
    window.botAPI.onAiConfigTestResult(function (r) {
      var el = document.getElementById("aiTestResult");
      if (!el) return;
      if (r && r.ok) el.textContent = window.t("aiTestOk") + (r.reply || "").substring(0, 60);
      else el.textContent = window.t("aiTestFail") + ((r && r.reply) || "no reply").substring(0, 60);
    });
  }

  // 8. 高级面板接线：玩家等级 6 个输入框 + 上下文列表（放在监听器注册之后，回包不会丢）
  if (window.panelSettings) window.panelSettings.init();
  // 9. AI 面板接线：保存参数 / 测试连接 / Ollama 列表（绑定幂等，和 events 抢同一个按钮也不会抖）
  if (window.panelAi) window.panelAi.init();
  // 10. 环境面板接线：Ollama 状态/模型、npm 插件安装（全部走真实 IPC）
  if (window.panelInstall) window.panelInstall.init();
  // 10b. 状态机面板接线：状态机清单 / 运行 / 停止 / AI 接管覆盖确认（真实读写 state/statemachines）
  if (window.panelState) window.panelState.init();
  // 10c. 专家模式【底层引擎控制】：7 个开关 + 参数滑块，改动即写盘并实时生效
  if (window.panelEngine) window.panelEngine.init();
  // 10d. 状态机 3.0【蜂群控制台】：三层状态 / 命令化 / 黑板竞价（幂等，重复调用不重复绑定）
  if (window.panelSwarm) window.panelSwarm.init();
  // 10e. 动作面板【精准模式】：精确建筑开关 + 红石触发频率滑块，改动经参数通道写盘并广播
  if (window.panelPrecision) window.panelPrecision.init();

  // 11. 新增的真实通道监听：偏好 / 参数 / Ollama / npm（每条都能在 state/ 里找到真实数据）
  if (window.botAPI && window.botAPI.onPrefsData) {
    window.botAPI.onPrefsData(function (data) {
      window.events.fillPrefs(data);
      // 偏好回包同时同步精准面板，保证引擎面板与动作面板两处控件永远一致。
      if (window.panelPrecision) window.panelPrecision.fill(data);
    });
  }
  if (window.botAPI && window.botAPI.onPrefsResult) {
    window.botAPI.onPrefsResult(function (r) {
      if (r && r.ok === false) {
        window.uiLog.add({ time: window.util.nowTime(), type: "SYSTEM", level: "warn", message: String(r.error || r.message || "prefs save failed") });
      }
    });
  }
  if (window.botAPI && window.botAPI.onParamResult) {
    window.botAPI.onParamResult(function (r) {
      var box = document.getElementById("paramResult");
      if (!box) return;
      if (!r) { box.textContent = "no result / 无结果"; return; }
      box.textContent = r.ok ? (String(r.key) + " = " + JSON.stringify(r.value) + (r.source ? " (" + r.source + ")" : "")) : String(r.message || "not found / 找不到该参数");
    });
  }
  if (window.botAPI && window.botAPI.onOllamaStatus) {
    window.botAPI.onOllamaStatus(function (d) { if (window.panelInstall) window.panelInstall.fillStatus(d); });
  }
  if (window.botAPI && window.botAPI.onOllamaList) {
    window.botAPI.onOllamaList(function (d) { if (window.panelInstall) window.panelInstall.fillModels(d); });
  }
  if (window.botAPI && window.botAPI.onOllamaAction) {
    window.botAPI.onOllamaAction(function (d) {
      if (window.panelInstall) window.panelInstall.fillAction(d);
      if (d && d.ok && window.api && window.api.ollamaList) window.api.ollamaList();
    });
  }
  if (window.botAPI && window.botAPI.onNpmList) {
    window.botAPI.onNpmList(function (d) { if (window.panelInstall) window.panelInstall.fillNpm(d); });
  }
  if (window.botAPI && window.botAPI.onNpmAction) {
    window.botAPI.onNpmAction(function (d) {
      if (window.panelInstall) window.panelInstall.fillAction(d);
      if (d && d.ok && window.api && window.api.npmList) window.api.npmList();
    });
  }

  // 12. 实时状态 / 高级动作 / 手动驾驶 + 3D 视角：三个新面板接线（三者都幂等，重复调用不会重复绑定）
  if (window.uiTelemetry) window.uiTelemetry.init();
  if (window.uiActions) window.uiActions.init();
  if (window.uiView) window.uiView.init();

});