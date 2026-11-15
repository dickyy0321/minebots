// ========================================
// 文件：gui/renderer/panel-channel.js
// 功能：设置页【聊天频道】面板——频道表 / 按 bot 分配 / 公屏指令 / 清空，全部走真实 IPC
// 依赖：window.api（preload 暴露）、window.botAPI（回包监听）、window.state / window.uiLog / window.t
// 导出：window.panelChannel = { init, fill, refresh, stats }
// 说明：renderer 层禁止 require；所有 IPC 调用先判空，主进程没起时界面只显示降级提示。
// 作者：MineBots
// ========================================
window.panelChannel = {
  inited: false,
  lastData: null,

  // 取元素：找不到返回 null，绝不抛错。
  byId: function (id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  },

  // 安全取文本：null / undefined 统一成空串。
  text: function (value) {
    try { return String(value === null || value === undefined ? "" : value); } catch (e) { return ""; }
  },

  // 往状态栏写一行双语提示；找不到元素就只写日志。
  say: function (msg) {
    var box = window.panelChannel.byId("channelStatus");
    if (box) box.textContent = msg;
    try { if (window.uiLog && window.uiLog.add) window.uiLog.add({ time: window.util.nowTime(), type: "SYSTEM", level: "info", message: msg }); } catch (e) { /* 日志缺失不影响 */ }
  },

  // 填机器人下拉框：没有卡片数据时塞一个 bot-1 占位，保证按钮永远有值可提交。
  fillBots: function () {
    var sel = window.panelChannel.byId("channelBotSelect");
    if (!sel) return false;
    try {
      var bots = (window.state && window.state.bots) || [];
      var keep = sel.value;
      sel.innerHTML = "";
      for (var i = 0; i < bots.length; i++) {
        var opt = document.createElement("option");
        opt.value = window.panelChannel.text(bots[i].id);
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

  // 渲染频道表：每行显示频道名、人数、成员，空表给双语空态。
  fillList: function (channels) {
    var box = window.panelChannel.byId("channelList");
    if (!box) return false;
    try {
      var list = Array.isArray(channels) ? channels : [];
      box.innerHTML = "";
      if (list.length === 0) {
        var empty = document.createElement("div");
        empty.className = "ctx-empty";
        empty.textContent = "还没有频道 / no channels yet";
        box.appendChild(empty);
        return true;
      }
      for (var i = 0; i < list.length; i++) {
        var row = document.createElement("div");
        row.className = "ctx-item";
        var label = document.createElement("span");
        label.className = "ctx-text";
        label.textContent = list[i].channel + " (" + list[i].count + "/" + (window.state.channelMax || 8) + ")";
        var members = document.createElement("span");
        members.className = "ctx-mode";
        members.textContent = (list[i].members || []).join(", ");
        row.appendChild(label);
        row.appendChild(members);
        box.appendChild(row);
      }
      return true;
    } catch (e) { return false; }
  },

  // 处理主进程回包：刷新状态栏 / 频道表 / 人数上限，并同步机器人卡片上的频道概览。
  fill: function (data) {
    var out = { ok: false, channels: 0 };
    try {
      var d = data && typeof data === "object" ? data : {};
      window.panelChannel.lastData = d;
      window.panelChannel.fillBots();
      out.channels = window.panelChannel.fillList(d.channels) ? (d.channels || []).length : 0;
      var st = d.stats && typeof d.stats === "object" ? d.stats : {};
      if (typeof st.maxMembers === "number") window.state.channelMax = st.maxMembers;
      var maxEl = window.panelChannel.byId("channelMaxInput");
      if (maxEl && typeof st.maxMembers === "number") maxEl.value = st.maxMembers;
      window.state.channelStats = st;
      var extra = " · 频道 " + (st.channels || 0) + " / 成员 " + (st.members || 0) + " / 拦截 " + (st.blocked || 0);
      window.panelChannel.say(window.panelChannel.text(d.message || "频道清单已刷新 / channel list refreshed") + extra);
      out.ok = true;
      return out;
    } catch (e) { return out; }
  },

  // 拉一次最新频道表（面板初始化 / 按钮 / 回包后都可调用）。
  refresh: function () {
    try { if (window.api && window.api.channelList) { window.api.channelList(); return true; } } catch (e) { /* 降级 */ }
    return false;
  },

  // 绑定四个按钮 + 回包监听；同一元素只绑一次，重复 init 安全。
  init: function () {
    var out = { ok: false, bound: 0 };
    try {
      var self = window.panelChannel;
      var assignBtn = self.byId("channelAssignBtn");
      if (assignBtn && !assignBtn._mbBoundChannel) {
        assignBtn._mbBoundChannel = true;
        assignBtn.addEventListener("click", function () {
          var botSel = self.byId("channelBotSelect");
          var nameEl = self.byId("channelNameInput");
          var maxEl = self.byId("channelMaxInput");
          var payload = {
            botId: botSel ? botSel.value : "bot-1",
            channel: nameEl ? nameEl.value : "",
            maxMembers: maxEl ? Number(maxEl.value) : 8
          };
          if (window.api && window.api.channelSet) window.api.channelSet(payload);
          else self.say("通道不可用 / channel API unavailable");
        });
        out.bound = out.bound + 1;
      }
      var refreshBtn = self.byId("channelRefreshBtn");
      if (refreshBtn && !refreshBtn._mbBoundChannel) {
        refreshBtn._mbBoundChannel = true;
        refreshBtn.addEventListener("click", function () { self.refresh(); });
        out.bound = out.bound + 1;
      }
      var clearBtn = self.byId("channelClearBtn");
      if (clearBtn && !clearBtn._mbBoundChannel) {
        clearBtn._mbBoundChannel = true;
        clearBtn.addEventListener("click", function () {
          if (window.api && window.api.channelClear) window.api.channelClear();
        });
        out.bound = out.bound + 1;
      }
      var cmdBtn = self.byId("channelCmdSend");
      if (cmdBtn && !cmdBtn._mbBoundChannel) {
        cmdBtn._mbBoundChannel = true;
        cmdBtn.addEventListener("click", function () {
          var inp = self.byId("channelCmdInput");
          var text = inp ? inp.value : "";
          if (window.api && window.api.channelCommand) window.api.channelCommand({ text: text });
          else self.say("通道不可用 / channel API unavailable");
        });
        out.bound = out.bound + 1;
      }
      var cmdInput = self.byId("channelCmdInput");
      if (cmdInput && !cmdInput._mbBoundChannelEnter) {
        cmdInput._mbBoundChannelEnter = true;
        cmdInput.addEventListener("keydown", function (ev) {
          if (ev && ev.key === "Enter" && cmdBtn) cmdBtn.click();
        });
      }
      if (!self.inited && window.botAPI && window.botAPI.onChannelResult) {
        window.botAPI.onChannelResult(function (data) { self.fill(data); });
        self.inited = true;
      }
      self.fillBots();
      self.refresh();
      out.ok = true;
      return out;
    } catch (e) { return out; }
  },

  // 给自检读的状态快照。
  stats: function () {
    return { inited: window.panelChannel.inited, channels: window.panelChannel.lastData && window.panelChannel.lastData.channels ? window.panelChannel.lastData.channels.length : 0 };
  }
};

// 页面就绪后自动初始化；非设置页没有这些元素，init 会安全降级为空操作。
try {
  document.addEventListener("DOMContentLoaded", function () {
    try { window.panelChannel.init(); } catch (e) { /* 初始化失败不影响其它面板 */ }
  });
} catch (eOuter) { /* 非浏览器环境直接忽略 */ }
