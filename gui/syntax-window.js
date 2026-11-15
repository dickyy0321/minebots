// gui/syntax-window.js
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("syntaxAPI", {
  onSetLang: function (callback) {
    ipcRenderer.on("set-lang", function (event, lang) { callback(lang); });
  }
});
