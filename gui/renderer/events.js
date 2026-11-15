// gui/renderer/events.js
// 所有事件绑定

window.events = {
  bind: function () {
    window.events.bindLangBtn();
    window.events.bindLogLangBtn();
    window.events.bindSyntaxBtn();
    window.events.bindAdvancedBtn();
    window.events.bindSaveAdvancedBtn();
    window.events.bindAddBotBtn();
    window.events.bindClearLogBtn();
    window.events.bindCmdTags();
    window.events.bindCmdInput();
    window.events.bindSwitchCmd();
    window.events.bindEasterEgg();
    window.events.bindFirstRunBtns();
    window.events.bindAiTestBtn();
    window.events.bindTypingToggle();
    // 首次向导 / 演示模式 / 沙盒安全 UI（红警 + 微软授权弹窗 + 一键清理 state）。
    if (window.uiWizard && typeof window.uiWizard.bind === "function") window.uiWizard.bind();
    if (window.uiDemo && typeof window.uiDemo.bind === "function") window.uiDemo.bind();
    if (window.uiSafety && typeof window.uiSafety.bind === "function") window.uiSafety.bind();
    // 模型目录订阅：本地标签（只读配置，不探测端口）+ 档案/绑定回包，供 Bot 卡片的「来源 + 模型」双下拉使用。
    try {
      if (window.api && typeof window.api.onLocalInstancesResult === "function") {
        window.api.onLocalInstancesResult(function (res) {
          if (window.uiBotBrain && typeof window.uiBotBrain.applyInstances === "function") window.uiBotBrain.applyInstances(res);
        });
      }
      if (window.api && typeof window.api.onModelProfileResult === "function") {
        window.api.onModelProfileResult(function (res) {
          if (window.uiBotBrain && typeof window.uiBotBrain.applyProfiles === "function") window.uiBotBrain.applyProfiles(res);
        });
      }
    } catch (eCat) { /* 目录订阅失败不影响其它功能 */ }
  },

  bindLangBtn: function () {
    var btn = document.getElementById("langBtn");
    if (!btn) return;
    btn.addEventListener("click", function () {
      window.state.currentLang = window.state.currentLang === "zh" ? "en" : "zh";
      window.ui.applyLang();
      window.uiBot.renderBots();
      window.uiBot.renderBotSelects();
      // 语法窗口开着时同步切换语言（窗口没开主进程会忽略）。
      if (window.api && window.api.syncSyntaxLang) window.api.syncSyntaxLang(window.state.currentLang);
    });
  },

  bindLogLangBtn: function () {
    var btn = document.getElementById("logLangBtn");
    if (!btn) return;
    btn.addEventListener("click", function () {
      window.uiLog.toggleLang();
    });
  },

  bindSyntaxBtn: function () {
    var btn = document.getElementById("syntaxBtn");
    if (!btn) return;
    btn.addEventListener("click", function () {
      window.api.openSyntaxWindow(window.state.currentLang);
    });
  },

  // 打开设置：跳到全屏 settings.html（侧滑抽屉已废弃），跳转前把设置页要用的数据先拉一次。
  // 自检脚本靠 window.state.navigatedTo 与 API 调用记录验证这个按钮真的接通了。
  bindAdvancedBtn: function () {
    var openBtn = document.getElementById("advancedBtn");
    if (!openBtn) return false;
    openBtn.addEventListener("click", function () {
      var url = openBtn.getAttribute("data-nav-target") || "settings.html";
      try {
        if (window.uiContext && window.uiContext.refresh) window.uiContext.refresh();
        if (window.api && window.api.playerLoad) window.api.playerLoad();
        if (window.api && window.api.aiConfigLoad) window.api.aiConfigLoad();
      } catch (ePre) { /* 预取失败不阻断跳转 */ }
      try { window.state.navigatedTo = url; } catch (eState) { /* state 缺失也继续 */ }
      try { window.location.href = url; } catch (eNav) { /* 非浏览器环境只记状态 */ }
    });
    return true;
  },

  bindSaveAdvancedBtn: function () {
    var btn = document.getElementById("saveAdvancedBtn");
    if (!btn) return false;
    // 幂等：events 与 panel-ai 都可能在绑，同一个按钮只允许一个监听器。
    if (btn._mbBound_saveAdvancedBtn) return false;
    btn._mbBound_saveAdvancedBtn = true;
    btn.addEventListener("click", function () {
      window.events.saveAdvanced();
      if (window.panelAi && typeof window.panelAi.saveConfig === "function") { window.panelAi.saveConfig(true); return; }
      window.events.saveAiConfig();
    });
    return true;
  },

  bindAddBotBtn: function () {
    var btn = document.getElementById("addBotBtn");
    if (!btn) return;
    btn.addEventListener("click", function () {
      window.addBot();
    });
  },

  bindClearLogBtn: function () {
    var btn = document.getElementById("clearLogBtn");
    if (!btn) return;
    btn.addEventListener("click", function () {
      window.uiLog.clear();
    });
  },

  bindCmdTags: function () {
    var tags = document.querySelectorAll(".cmd-tag");
    for (var i = 0; i < tags.length; i++) {
      tags[i].addEventListener("click", function () {
        window.events.executeTag(this.getAttribute("data-cmd"));
      });
    }
  },

  bindCmdInput: function () {
    var input = document.getElementById("cmdInput");
    var sendBtn = document.getElementById("cmdSendBtn");
    if (input) {
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          window.events.executeCommandLine(input.value);
          input.value = "";
        }
      });
    }
    if (sendBtn) {
      sendBtn.addEventListener("click", function () {
        if (input) {
          window.events.executeCommandLine(input.value);
          input.value = "";
        }
      });
    }
  },

  bindSwitchCmd: function () {
    var input = document.getElementById("switchCmdInput");
    var sendBtn = document.getElementById("switchCmdSend");
    if (input) {
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          window.events.executeSwitchCmd(input.value);
          input.value = "";
        }
      });
    }
    if (sendBtn) {
      sendBtn.addEventListener("click", function () {
        if (input) {
          window.events.executeSwitchCmd(input.value);
          input.value = "";
        }
      });
    }
  },

  // 上下文按钮：已迁到 panel-settings.bindContextPanel（避免重复绑定导致一次点击发两遍）。
  // Context buttons now live in panel-settings.bindContextPanel to avoid double binding.
  bindContextBtns: function () {
    if (window.panelSettings && window.panelSettings.bindContextPanel) window.panelSettings.bindContextPanel();
    return true;
  },

  // 手动开关：已迁到 panel-settings（保留旧名转发，老调用方不用改）。
  bindPlayerManual: function () {
    if (window.panelSettings && window.panelSettings.bindPlayerPanel) window.panelSettings.bindPlayerPanel();
    return true;
  },

  bindEasterEgg: function () {
    var btn = document.getElementById("easterEggBtn");
    if (!btn) return;
    btn.addEventListener("click", function () {
      window.easter.trigger();
    });
  },

  bindFirstRunBtns: function () {
    var closeBtn = document.getElementById("frCloseBtn");
    var noMoreBtn = document.getElementById("frNoMoreBtn");
    var modal = document.getElementById("firstRunModal");
    if (closeBtn) closeBtn.addEventListener("click", function () {
      if (modal) modal.classList.add("hidden");
    });
    if (noMoreBtn) noMoreBtn.addEventListener("click", function () {
      try { localStorage.setItem("minebots-first-run-done", "1"); } catch (e) {}
      if (modal) modal.classList.add("hidden");
    });
  },

  bindAiTestBtn: function () {
    var btn = document.getElementById("aiTestBtn");
    if (!btn) return false;
    // 幂等：panel-ai 也绑这个按钮（同一个 flag），谁先绑谁生效，绝不重复发请求。
    if (btn._mbBound_aiTest) return false;
    btn._mbBound_aiTest = true;
    btn.addEventListener("click", function () {
      if (window.panelAi && typeof window.panelAi.testConnection === "function") { window.panelAi.testConnection(); return; }
      var res = document.getElementById("aiTestResult");
      if (res) res.textContent = "...";
      window.events.saveAiConfig();
      window.api.aiConfigTest();
    });
    return true;
  },

  executeTag: function (cmd) {
    var sel = document.getElementById("tagTargetSelect");
    if (!sel) return;
    var bot = window.getBot(sel.value);
    if (!bot) {
      window.uiLog.add({ time: window.util.nowTime(), type: "SYSTEM", level: "warn", message: window.t("noRunningBot") });
      return;
    }
    window.api.executeCommand({ botId: bot.id, action: cmd, range: "", time: "", back: null });
  },

  executeCommandLine: function (text) {
    var sel = document.getElementById("cmdTargetSelect");
    if (!sel) return;
    var bot = window.getBot(sel.value);
    if (!bot) {
      window.uiLog.add({ time: window.util.nowTime(), type: "SYSTEM", level: "warn", message: window.t("noRunningBot") });
      return;
    }
    var parsed = window.events.parseAction(text);
    if (!parsed) {
      window.uiLog.add({ time: window.util.nowTime(), type: "SYSTEM", level: "warn", message: window.t("badCmd") });
      return;
    }
    if (parsed.isJoinOut) {
      if (!parsed.joinTime || !parsed.outTime) {
        window.uiLog.add({ time: window.util.nowTime(), type: "SYSTEM", level: "error", message: window.t("joinBadTime") });
        return;
      }
      window.api.scheduleJoinOut({ botId: bot.id, joinTime: parsed.joinTime, outTime: parsed.outTime });
      return;
    }
    window.api.executeCommand({
      botId: bot.id, action: parsed.action, range: parsed.range,
      time: parsed.time, back: parsed.back,
      params: { blocks: parsed.blocks, wood: parsed.wood, ores: parsed.ores, players: parsed.players }
    });
  },

  executeSwitchCmd: function (text) {
    var s = String(text || "").trim().toLowerCase();
    var parts = s.split(/\s+/);
    if (parts.length < 2) {
      window.uiLog.add({ time: window.util.nowTime(), type: "SYSTEM", level: "error", message: window.t("badSwitch") });
      return;
    }
    var state = parts[parts.length - 1];
    var name = parts.slice(0, parts.length - 1).join(" ");
    if (state !== "on" && state !== "off") {
      window.uiLog.add({ time: window.util.nowTime(), type: "SYSTEM", level: "error", message: window.t("badSwitch") });
      return;
    }
    var isOn = state === "on";
    if (name === "test mode") {
      var t1 = document.getElementById("testModeToggle");
      if (t1) t1.checked = isOn;
      window.api.setTestMode(isOn);
    } else if (name === "hive mind") {
      var t2 = document.getElementById("hiveMindToggle");
      if (t2) t2.checked = isOn;
    } else if (name === "ai code") {
      var t3 = document.getElementById("aiCodeToggle");
      if (t3) t3.checked = isOn;
    } else if (name === "bot chat") {
      var t4 = document.getElementById("botChatToggle");
      if (t4) t4.checked = isOn;
    } else {
      window.uiLog.add({ time: window.util.nowTime(), type: "SYSTEM", level: "error", message: window.t("badSwitch") });
      return;
    }
    window.events.saveAdvanced();
  },

  saveAdvanced: function () {
    var tm = document.getElementById("testModeToggle");
    var hm = document.getElementById("hiveMindToggle");
    var ac = document.getElementById("aiCodeToggle");
    var bc = document.getElementById("botChatToggle");
    var ty = document.getElementById("typingToggle");
    var data = {
      testMode: tm ? tm.checked : false,
      hiveMind: hm ? hm.checked : false,
      aiCode: ac ? ac.checked : false,
      botChat: bc ? bc.checked : false,
      typing: ty ? ty.checked : true
    };
    // 真落盘：主进程写 state/prefs.json，重启后开关不会回到默认值（不再只写 localStorage）。
    if (window.api && typeof window.api.prefsSave === "function") window.api.prefsSave(data);
    window.api.setTestMode(data.testMode);
    window.uiLog.add({ time: window.util.nowTime(), type: "SYSTEM", level: "info", message: window.t("saved") });
  },

  // 拉取真实偏好（主进程回包后由 fillPrefs 回填界面）。
  loadAdvanced: function () {
    if (window.api && typeof window.api.prefsLoad === "function") window.api.prefsLoad();
    return true;
  },

  // 把主进程偏好的回包填回 5 个开关（缺字段保持原状，绝不把勾选清空）。
  fillPrefs: function (data) {
    if (!data) return false;
    var map = { testModeToggle: "testMode", hiveMindToggle: "hiveMind", aiCodeToggle: "aiCode", botChatToggle: "botChat", typingToggle: "typing" };
    for (var id in map) {
      if (!Object.prototype.hasOwnProperty.call(map, id)) continue;
      var el = document.getElementById(id);
      if (!el) continue;
      var value = data[map[id]];
      if (typeof value === "boolean") el.checked = value;
    }
    if (typeof data.testMode === "boolean") window.api.setTestMode(data.testMode);
    // 引擎控制面板由同一份偏好回包回填（7 个 Toggle + 参数滑块），缺字段保持原状。
    if (window.panelEngine && typeof window.panelEngine.fill === "function") window.panelEngine.fill(data);
    return true;
  },

  // 打字机开关：一改就落盘（不用等用户点保存）。
  bindTypingToggle: function () {
    var el = document.getElementById("typingToggle");
    if (!el || el._mbBound_typing) return false;
    el._mbBound_typing = true;
    el.addEventListener("change", function () { window.events.saveAdvanced(); });
    return true;
  },

  // 玩家面板保存：已迁到 panel-settings.savePlayer（这里只做转发，保持老调用方可用）。
  savePlayerPanel: function () {
    if (window.panelSettings && window.panelSettings.savePlayer) return window.panelSettings.savePlayer();
    return false;
  },

  splitNames: function (id) {
    var el = document.getElementById(id);
    if (!el) return [];
    return el.value.split(/\s+/).filter(Boolean);
  },

  // 玩家面板回填：已迁到 panel-settings.fillPlayerPanel（这里只做转发）。
  fillPlayerPanel: function (data) {
    if (window.panelSettings && window.panelSettings.fillPlayerPanel) return window.panelSettings.fillPlayerPanel(data);
    return false;
  },

  setVal: function (id, v) {
    var el = document.getElementById(id);
    if (el) el.value = v;
  },

  saveAiConfig: function () {
    window.api.aiConfigSave({
      baseUrl: window.events.getVal("aiBaseUrl"),
      apiKey: window.events.getVal("aiApiKey"),
      model: window.events.getVal("aiModel"),
      engine: window.events.getVal("aiEngineSelect") || "custom",
      systemPromptAppend: window.events.getVal("sysPromptAppend")
    });
  },

  fillAiConfig: function (data) {
    if (!data) return;
    // 本地模式下「框架 / 地址 / 模型」归本地标签所有，全局配置不能把它们覆盖回去（否则标签切了框架会显示错）。
    // 判断用「本地标签是否已加载」而不是运行模式：设置页加载时下拉还停在云端默认值，按值判断会漏。
    var localMode = false;
    try { localMode = !!(window.panelLocal && window.panelLocal.currentId && window.panelLocal.last); } catch (eL) { localMode = false; }
    if (!localMode) {
      window.events.setVal("aiBaseUrl", data.baseUrl || "https://api.deepseek.com/v1");
      window.events.setVal("aiModel", data.model || "deepseek-chat");
      window.events.setVal("aiEngineSelect", data.engine || "custom");
    }
    window.events.setVal("aiApiKey", data.apiKey || "");
    window.events.setVal("sysPromptAppend", data.systemPromptAppend || "");
    // 同步「请求地址」预览（下拉换了引擎也要跟着变，回填后不会显示旧端口）。
    if (!localMode) {
      try { if (window.panelAi && window.panelAi.syncEngine) window.panelAi.syncEngine(data.engine || "custom"); } catch (e) { /* 预览失败不影响回填 */ }
    }
    // 同步「运行模式」分组（本地 / 云端互斥显示，老配置按地址猜）。
    try { if (window.panelAi && window.panelAi.syncProvider) window.panelAi.syncProvider(data.provider, data.baseUrl); } catch (e2) { /* 模式同步失败不影响回填 */ }
  },

  getVal: function (id) {
    var el = document.getElementById(id);
    return el ? el.value : "";
  },

  parseAction: function (text) {
    var parts = String(text || "").split(",").map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
    if (parts.length === 0) return null;
    var action = parts[0] || "";
    var blocks = null, wood = null, ores = [], players = [], back = null, time = "", range = "";

    if (/^join\s+/i.test(action)) {
      var joinTime = action.replace(/^join\s+/i, "").trim();
      var outTime = "";
      for (var i = 1; i < parts.length; i++) {
        if (/^out\s+/i.test(parts[i])) outTime = parts[i].replace(/^out\s+/i, "").trim();
      }
      return { isJoinOut: true, joinTime: joinTime, outTime: outTime };
    }

    if (action === "follow") {
      for (var j = 1; j < parts.length; j++) {
        var p = parts[j];
        if (p.indexOf("player=") === 0) {
          var rest = p.substring(7).split(/[\s,]+/).filter(Boolean);
          for (var k = 0; k < rest.length; k++) players.push(rest[k]);
        } else if (p.indexOf("=") < 0 && p.indexOf("back ") !== 0) {
          var rest2 = p.split(/\s+/).filter(Boolean);
          for (var k2 = 0; k2 < rest2.length; k2++) players.push(rest2[k2]);
        }
      }
      return { action: action, players: players };
    }

    for (var n = 1; n < parts.length; n++) {
      var pp = parts[n];
      if (pp.indexOf("back ") === 0) {
        var c = pp.substring(5).trim().split(/\s+/);
        if (c.length === 3) {
          var nums = c.map(parseFloat);
          if (!isNaN(nums[0]) && !isNaN(nums[1]) && !isNaN(nums[2])) back = nums;
        }
      } else if (pp.indexOf("blocks=") === 0) {
        var bn = parseInt(pp.substring(7), 10);
        if (!isNaN(bn)) blocks = bn;
      } else if (pp.indexOf("wood=") === 0) {
        wood = pp.substring(5).trim();
      } else if (pp.indexOf("(") === 0 && pp.indexOf(")") > 0) {
        var ore = pp.substring(1, pp.indexOf(")")).trim();
        if (ore) ores.push(ore);
      } else if (/^\d+\*\d+$/.test(pp)) {
        range = pp;
      } else if (/^\d+(\.\d+)?[sm]$/.test(pp)) {
        time = pp;
      } else if (pp && pp.indexOf("=") < 0 && !wood) {
        wood = pp;
      }
    }
    return { action: action, range: range, time: time, back: back, blocks: blocks, wood: wood, ores: ores };
  }
};