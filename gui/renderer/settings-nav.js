// ========================================
// 文件：gui/renderer/settings-nav.js
// 功能：全屏设置页——左侧导航分组切换 + 左上角返回主界面（页面跳转，不再是侧滑抽屉）
// 依赖：无（纯 DOM / window / localStorage；renderer 层禁止 require）
// 导出：window.settingsNav = { show, bind, back, current, stats }
// 说明：主页 index.html 与设置页 settings.html 是两张独立页面，靠 location.href 互跳；
//       分组状态写 localStorage，返回再进来仍停在上次看的那一页。
// 作者：MineBots
// ========================================
window.settingsNav = {
  current: "ai",
  STORAGE_KEY: "minebots-settings-nav",

  // 切到某个分组：导航按钮高亮 + 内容面板显隐；名字非法时退回第一页，绝不抛错。
  show: function (name) {
    var wanted = String(name || "ai");
    try {
      var buttons = document.querySelectorAll("[data-settings-nav]");
      var found = false;
      for (var i = 0; i < buttons.length; i++) {
        var on = buttons[i].getAttribute("data-settings-nav") === wanted;
        if (on) { buttons[i].classList.add("active"); found = true; }
        else buttons[i].classList.remove("active");
      }
      if (!found && buttons.length > 0) {
        wanted = buttons[0].getAttribute("data-settings-nav") || "ai";
        buttons[0].classList.add("active");
      }
      var panes = document.querySelectorAll("[data-settings-pane]");
      for (var j = 0; j < panes.length; j++) {
        var hit = panes[j].getAttribute("data-settings-pane") === wanted;
        if (hit) panes[j].classList.remove("hidden");
        else panes[j].classList.add("hidden");
      }
      window.settingsNav.current = wanted;
      try { localStorage.setItem(window.settingsNav.STORAGE_KEY, wanted); } catch (eLs) { /* 存储不可用不影响切换 */ }
      // 切换后重刷一次兜底绑定，覆盖面板里动态生成的按钮 / 输入框。
      try { if (window.uiBindAll && window.uiBindAll.refresh) window.uiBindAll.refresh(); } catch (eBind) { /* 同上 */ }
      return wanted;
    } catch (e) { return window.settingsNav.current; }
  },

  // 回到主界面：记录去向再跳转，自检脚本靠 state.navigatedTo 验证按钮真的生效。
  back: function (target) {
    var url = String(target || "index.html");
    try { window.state.navigatedTo = url; } catch (eState) { /* state 缺失也继续跳 */ }
    try { window.location.href = url; } catch (eNav) { /* 非浏览器环境只记状态 */ }
    return url;
  },

  // 绑定导航按钮与返回按钮；同一元素只绑一次（重复调用安全）。
  bind: function () {
    var bound = 0;
    try {
      var buttons = document.querySelectorAll("[data-settings-nav]");
      for (var i = 0; i < buttons.length; i++) {
        (function (btn) {
          if (btn._mbBoundSettingsNav) return;
          btn._mbBoundSettingsNav = true;
          btn.addEventListener("click", function () {
            window.settingsNav.show(btn.getAttribute("data-settings-nav"));
          });
          bound = bound + 1;
        })(buttons[i]);
      }
      var back = document.getElementById("backToMainBtn");
      if (back && !back._mbBoundBack) {
        back._mbBoundBack = true;
        back.addEventListener("click", function () {
          window.settingsNav.back(back.getAttribute("data-nav-target") || "index.html");
        });
        bound = bound + 1;
      }
    } catch (e) { return { ok: false, bound: bound, message: String(e && e.message ? e.message : e) }; }
    return { ok: true, bound: bound, current: window.settingsNav.current };
  },

  // 给自检用的小统计：分组数 / 当前分组 / 是否已绑定返回按钮。
  stats: function () {
    var out = { panes: 0, buttons: 0, current: window.settingsNav.current, backBound: false };
    try { out.panes = document.querySelectorAll("[data-settings-pane]").length; } catch (e1) { /* ignore */ }
    try { out.buttons = document.querySelectorAll("[data-settings-nav]").length; } catch (e2) { /* ignore */ }
    try { var b = document.getElementById("backToMainBtn"); out.backBound = !!(b && b._mbBoundBack); } catch (e3) { /* ignore */ }
    return out;
  }
};

// 页面就绪后自动绑定并恢复上次分组；localStorage 不可用时默认第一页。
try {
  document.addEventListener("DOMContentLoaded", function () {
    try {
      var last = "";
      try { last = localStorage.getItem(window.settingsNav.STORAGE_KEY) || ""; } catch (eLs) { last = ""; }
      window.settingsNav.bind();
      window.settingsNav.show(last.length > 0 ? last : "ai");
    } catch (e) { /* 初始化失败不影响其它面板 */ }
  });
} catch (eOuter) { /* 非浏览器环境直接忽略 */ }
