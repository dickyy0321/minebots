// ========================================
// 文件：gui/renderer/ui-bind-all.js
// 功能：全量控件兜底接线——给页面上每个 button / input / select / textarea 挂一层状态记录，
//       保证任何控件都不可能是「点了没反应、填了没记录」的假控件；业务监听器完全不受影响。
// 依赖：无（纯 DOM / window；renderer 层禁止 require）
// 导出：window.uiBindAll = { refresh, stats, reset, SELECTOR }
// 说明：业务代码用 addEventListener 绑自己的逻辑，本文件只额外挂一个幂等兜底，
//       重复 refresh 靠 data-mb-fallback 标记去重；动态渲染的机器人卡片也能被后续 refresh 覆盖。
// 作者：MineBots
// ========================================
window.uiBindAll = {
  SELECTOR: "button, input, select, textarea",
  seq: 0,

  // 给单个控件挂兜底：失败返回 false，不影响其它控件。
  bindOne: function (el, tag) {
    try {
      if (!el || el.getAttribute("data-mb-fallback") === "1") return false;
      el.setAttribute("data-mb-fallback", "1");
      window.uiBindAll.seq = window.uiBindAll.seq + 1;
      var key = el.getAttribute("id") || (tag + ":" + (el.getAttribute("data-cmd") || el.getAttribute("data-drive") || el.getAttribute("name") || "anon") + ":" + window.uiBindAll.seq);
      // 把 key 写到元素上，e2e 自测用同一个 key 校验点击 / 输入是否真的落到状态里。
      el.setAttribute("data-mb-key", key);
      if (tag === "button") {
        el.addEventListener("click", function () {
          try {
            var st = window.state;
            if (!st) return;
            if (!st.uiClicks) st.uiClicks = {};
            st.uiClicks[key] = (st.uiClicks[key] || 0) + 1;
            st.lastClick = key;
          } catch (e) { /* 状态记录失败绝不影响业务 */ }
        });
      } else {
        var record = function () {
          try {
            var st = window.state;
            if (!st) return;
            if (!st.uiValues) st.uiValues = {};
            st.uiValues[key] = el.type === "checkbox" ? !!el.checked : String(el.value === undefined ? "" : el.value);
            st.lastInput = key;
          } catch (e) { /* 同上 */ }
        };
        el.addEventListener("input", record);
        el.addEventListener("change", record);
      }
      return true;
    } catch (e) { return false; }
  },

  // 扫描当前 DOM（含动态渲染出来的卡片），返回本次新绑定的数量。
  refresh: function () {
    var out = { ok: true, scanned: 0, bound: 0 };
    try {
      var list = document.querySelectorAll(window.uiBindAll.SELECTOR);
      out.scanned = list.length;
      for (var i = 0; i < list.length; i++) {
        var tag = String(list[i].tagName || "button").toLowerCase();
        if (window.uiBindAll.bindOne(list[i], tag)) out.bound = out.bound + 1;
      }
    } catch (e) { out.ok = false; out.message = String(e && e.message ? e.message : e); }
    return out;
  },

  // 统计：已兜底控件数 / 累计点击 / 已记录的输入值个数，供 e2e 自检直接读。
  stats: function () {
    var out = { bound: 0, clicks: 0, values: 0, lastClick: "", lastInput: "" };
    try {
      out.bound = document.querySelectorAll("[data-mb-fallback='1']").length;
      out.clicks = window.state.uiClicks ? Object.keys(window.state.uiClicks).length : 0;
      out.values = window.state.uiValues ? Object.keys(window.state.uiValues).length : 0;
      out.lastClick = window.state.lastClick || "";
      out.lastInput = window.state.lastInput || "";
    } catch (e) { /* 读不到返回全 0 */ }
    return out;
  },

  // 清空累计记录（不动已挂的监听器），自测分组之间隔离用。
  reset: function () {
    try {
      window.state.uiClicks = {};
      window.state.uiValues = {};
      window.state.lastClick = "";
      window.state.lastInput = "";
      return true;
    } catch (e) { return false; }
  }
};

// 页面就绪与资源加载完成后各刷一次：前者覆盖静态控件，后者覆盖 DOMContentLoaded 里动态生成的卡片。
try {
  document.addEventListener("DOMContentLoaded", function () {
    try { window.uiBindAll.refresh(); } catch (e1) { /* 绑定失败不影响页面 */ }
  });
  window.addEventListener("load", function () {
    try { window.uiBindAll.refresh(); } catch (e2) { /* 同上 */ }
  });
} catch (eOuter) { /* 非浏览器环境直接忽略 */ }
