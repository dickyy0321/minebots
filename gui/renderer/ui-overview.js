// ========================================
// 文件：gui/renderer/ui-overview.js
// 功能：主页【状态概览】数值卡——机器人总数 / 运行中 / 当前频道 / AI 大脑，随主进程回包实时刷新
// 依赖：window.state / window.botAPI（可选）/ window.api（可选）
// 导出：window.uiOverview = { refresh, init, stats }
// 说明：不新开定时器（避免高频刷 GUI），只在 DOMContentLoaded 与 botList 回包时刷新一次。
// 作者：MineBots
// ========================================
window.uiOverview = {
  inited: false,

  // 写一行文本：元素不存在 / 写失败都静默跳过。
  setText: function (id, value) {
    try {
      var el = document.getElementById(id);
      if (el) el.textContent = String(value === null || value === undefined ? "" : value);
      return !!el;
    } catch (e) { return false; }
  },

  // 刷新四张卡；数据来源都是内存状态，读取失败各自兜底，不抛错。
  refresh: function () {
    var out = { ok: true, bots: 0, running: 0, channel: "global", brain: "deepseek" };
    try {
      var bots = (window.state && Array.isArray(window.state.bots)) ? window.state.bots : [];
      out.bots = bots.length;
      for (var i = 0; i < bots.length; i++) {
        if (bots[i] && bots[i].status === "running") out.running = out.running + 1;
      }
      try {
        var picks = (window.state && window.state.channelStats) || {};
        out.channel = picks.defaultChannel || "global";
      } catch (eCh) { /* 按默认频道 */ }
      try {
        var assigns = (window.state && window.state.modelAssignments) || {};
        var keys = Object.keys(assigns);
        out.brain = keys.length > 0 ? assigns[keys[0]] : "deepseek";
      } catch (eMp) { /* 按默认档案 */ }
      window.uiOverview.setText("overviewBotCount", out.bots);
      window.uiOverview.setText("overviewRunning", out.running);
      window.uiOverview.setText("overviewChannel", out.channel);
      window.uiOverview.setText("overviewBrain", out.brain);
      return out;
    } catch (e) { out.ok = false; return out; }
  },

  // 绑定主进程推送与语言切换后的刷新；重复调用安全。
  init: function () {
    try {
      window.uiOverview.refresh();
      if (!window.uiOverview.inited && window.botAPI && window.botAPI.onBotList) {
        window.botAPI.onBotList(function () { window.uiOverview.refresh(); });
      }
      if (!window.uiOverview.inited && window.botAPI && window.botAPI.onChannelResult) {
        window.botAPI.onChannelResult(function () { window.uiOverview.refresh(); });
      }
      if (!window.uiOverview.inited && window.botAPI && window.botAPI.onModelProfileResult) {
        window.botAPI.onModelProfileResult(function () { window.uiOverview.refresh(); });
      }
      window.uiOverview.inited = true;
      // 档案池数据：主页也拉一次，卡片下拉框才知道有哪些引擎。
      try { if (window.api && window.api.modelProfileList) window.api.modelProfileList(); } catch (eApi) { /* 缺失降级 */ }
      return { ok: true, message: "概览已就绪 / overview ready" };
    } catch (e) { return { ok: false, message: String(e && e.message ? e.message : e) }; }
  },

  // 给自检读的状态快照。
  stats: function () {
    return { inited: window.uiOverview.inited, last: window.uiOverview.refresh() };
  }
};

try {
  document.addEventListener("DOMContentLoaded", function () {
    try { window.uiOverview.init(); } catch (e) { /* 初始化失败不影响页面 */ }
  });
} catch (eOuter) { /* 非浏览器环境直接忽略 */ }
