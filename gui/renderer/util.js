// gui/renderer/util.js
// 通用工具

window.util = {
  nowTime: function () {
    var d = new Date();
    var h = String(d.getHours()).padStart(2, "0");
    var m = String(d.getMinutes()).padStart(2, "0");
    var s = String(d.getSeconds()).padStart(2, "0");
    return h + ":" + m + ":" + s;
  },

  safeParseInt: function (v, fallback) {
    var n = parseInt(v, 10);
    return isNaN(n) ? fallback : n;
  },

  escapeHtml: function (s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  },

  copyToClipboard: function (text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
      }
    } catch (e) {}
  }
};

// 兼容旧代码里的 ui.addLog
if (!window.ui) window.ui = {};
if (!window.ui.addLog) {
  window.ui.addLog = function (entry) {
    if (window.uiLog && window.uiLog.add) window.uiLog.add(entry);
  };
}