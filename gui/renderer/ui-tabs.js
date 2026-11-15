// ========================================
// 文件：gui/renderer/ui-tabs.js
// 功能：高级抽屉的标签页切换（AI 配置 / 状态机与遥测 / 动作与驾驶 / 日志与调试）
// 依赖：无（纯 DOM，走 data-adv-tab / data-adv-pane 属性，不碰任何业务逻辑）
// 导出：window.uiTabs = { show, bind, current }
// 作者：MineBots
// ========================================
//
// 为什么单独一个文件：
//   主界面收纳之后，所有杂项面板都塞进抽屉里，靠标签页分组；这里只管「显示哪一个」，
//   面板本身的渲染仍然由各自的 panel-*.js / ui-*.js 负责（它们按 id 找人，位置随便搬）。
//   renderer 层不许 require，所以这里只用 window 全局与 DOM API。
window.uiTabs = {
  current: "ai",

  // 切到某个标签页：按钮高亮 + 面板显隐；名字非法时退回第一个 AI 页，绝不抛错。
  show: function (name) {
    var wanted = String(name || "ai");
    try {
      var tabs = document.querySelectorAll("[data-adv-tab]");
      var found = false;
      for (var i = 0; i < tabs.length; i++) {
        var on = tabs[i].getAttribute("data-adv-tab") === wanted;
        if (on) { tabs[i].classList.add("active"); found = true; }
        else tabs[i].classList.remove("active");
      }
      if (!found) wanted = "ai";
      var panes = document.querySelectorAll("[data-adv-pane]");
      for (var j = 0; j < panes.length; j++) {
        var hit = panes[j].getAttribute("data-adv-pane") === wanted;
        if (hit) panes[j].classList.remove("hidden");
        else panes[j].classList.add("hidden");
      }
      window.uiTabs.current = wanted;
      return wanted;
    } catch (e) { return window.uiTabs.current; }
  },

  // 绑定标签按钮：同一个按钮只绑一次（重复调用安全）。
  bind: function () {
    try {
      var tabs = document.querySelectorAll("[data-adv-tab]");
      for (var i = 0; i < tabs.length; i++) {
        if (tabs[i]._mbBoundAdvTab) continue;
        tabs[i]._mbBoundAdvTab = true;
        tabs[i].addEventListener("click", function () {
          window.uiTabs.show(this.getAttribute("data-adv-tab"));
        });
      }
      return true;
    } catch (e) { return false; }
  }
};

// DOM 就绪后自动绑定一次：HTML 里默认第一个标签页是打开的，这里只负责后续点击。
try {
  document.addEventListener("DOMContentLoaded", function () {
    try { window.uiTabs.bind(); } catch (e) { /* 绑定失败不影响其它面板 */ }
  });
} catch (e) { /* 非浏览器环境下直接忽略 */ }
