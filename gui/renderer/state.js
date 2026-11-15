// gui/renderer/state.js
// 全局变量

window.state = {
  currentLang: "zh",
  logLang: "zh",
  bots: [],
  eggCount: 0,
  eggBusy: false
};

window.t = function (key) {
  var lang = window.state.currentLang || "zh";
  var p = window.LANG[lang] || window.LANG.zh;
  return p[key] || key;
};