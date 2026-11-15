// ========================================
// 文件：gui/renderer/ui-demo.js
// 功能：演示模式（Demo Mode）——点击后日志爆出高密度绿色 Trace、雷达闪烁，方便主人录屏
// 依赖：window.uiLog / window.util / document / window.t（已在其它脚本注入）
// 导出：window.uiDemo（bind / toggle / burst）
// 说明：绿色 Trace 用一次性 burst（不挂定时器，避免阻塞 / 挂起进程）；雷达闪烁走 CSS 动画，自愈不依赖 JS 定时器。
//       界面文字中英双语。所有外部调用都 try/catch 包裹，绝不抛到顶层。
// 作者：MineBots
// ========================================

// 功能：绑定演示模式按钮（顶栏 demoBtn），缺元素时静默返回。
function bindDemo() {
  try {
    var btn = document.getElementById("demoBtn");
    if (!btn) return;
    btn.addEventListener("click", function () { window.uiDemo.toggle(); });
  } catch (e) { /* 绑定失败不影响其它功能 */ }
}

window.uiDemo = {
  on: false,

  // 功能：切换演示模式——开：加 body.demo 类（CSS 雷达闪烁）+ 爆一波绿色 Trace；关：移除类。
  toggle: function () {
    try {
      this.on = !this.on;
      if (typeof document !== "undefined" && document.body) {
        if (this.on) document.body.classList.add("demo"); else document.body.classList.remove("demo");
      }
      if (this.on) this.burst();
      if (window.uiLog && window.util) {
        window.uiLog.add({ time: window.util.nowTime(), type: "SYSTEM", level: "info", message: window.t("demoModeOn") });
      }
    } catch (e) { /* 切换失败不影响主流程 */ }
  },

  // 功能：一次性爆出 N 条绿色 Trace 日志（演示录屏用），不挂定时器、不阻塞进程。
  burst: function () {
    try {
      if (!window.uiLog || !window.util) return;
      var samples = [
        "swarm tick ok / 蜂群节拍正常", "pathfinder 0 hops / 寻路 0 跳", "radar scan 64x64 / 雷达扫描 64x64",
        "telemetry push / 遥测推送", "ai reply 12ms / AI 回复 12ms", "build queue 3 / 建造队列 3",
        "redstone tick / 红石触发", "inventory sync / 背包同步", "chat whisper same-channel / 同频道私聊"
      ];
      for (var i = 0; i < 60; i++) {
        var msg = "[DEMO] " + samples[i % samples.length] + " #" + (i + 1);
        window.uiLog.add({ time: window.util.nowTime(), type: "TRACE", level: "trace", message: msg });
      }
    } catch (e) { /* 爆屏失败不影响主流程 */ }
  }
};

// 挂载绑定入口：events.js 通过 window.uiDemo.bind() 调用。
window.uiDemo.bind = bindDemo;
