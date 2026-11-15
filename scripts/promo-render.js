// 发布片渲染器：用 Electron 离屏把 HTML 动画逐帧截成图片，供 ffmpeg 编码。
// 用法：env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/promo-render.js --html=logs/promo/index.html --out=logs/promo/frames --fps=30 --dur=82
// 说明：页面里必须暴露 window.setFrame(t) 与 window.__DURATION__。
"use strict";

var fs = require("fs");
var path = require("path");

function argOf(name, def) {
  var pre = "--" + name + "=";
  for (var i = 2; i < process.argv.length; i++) {
    if (process.argv[i].indexOf(pre) === 0) return process.argv[i].slice(pre.length);
  }
  return def;
}

var electron = require("electron");
var app = electron.app;
var BrowserWindow = electron.BrowserWindow;

var HTML = path.resolve(argOf("html", path.join("logs", "promo", "index.html")));
var OUT = path.resolve(argOf("out", path.join("logs", "promo", "frames")));
var FPS = Number(argOf("fps", 30));
var DUR = Number(argOf("dur", 82));
var ONLY = Number(argOf("only", 0));
var FROM = Number(argOf("from", 0));
var TO = Number(argOf("to", 0));
var FROM = Number(argOf("from", 0));
var TO = Number(argOf("to", 0));          // 只渲染前 N 帧（自检用）
var W = Number(argOf("w", 1920));
var H = Number(argOf("h", 1080));

app.disableHardwareAcceleration();

function log(msg) { try { console.log("[promo] " + msg); } catch (e) { /* ignore */ } }

app.whenReady().then(async function () {
  try {
    if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
    var win = new BrowserWindow({
      width: W, height: H, show: false, frame: false,
      webPreferences: { offscreen: false, backgroundThrottling: false, paintWhenInitiallyHidden: true }
    });
    win.setContentSize(W, H);
    await win.loadFile(HTML);
    await new Promise(function (r) { setTimeout(r, 400); });

    var total = ONLY > 0 ? Math.min(ONLY, Math.round(DUR * FPS)) : Math.round(DUR * FPS);
    if (TO > 0) total = Math.min(total, TO);
    if (TO > 0) total = Math.min(total, TO);
    log("html=" + HTML + " out=" + OUT + " fps=" + FPS + " frames=" + total);

    for (var f = FROM; f < total; f++) {
      var t = f / FPS;
      await win.webContents.executeJavaScript("window.setFrame(" + t.toFixed(4) + "); 1", true);
      var img = await win.webContents.capturePage();
      var buf = img.toJPEG(94);
      var name = "f" + String(f).padStart(5, "0") + ".jpg";
      fs.writeFileSync(path.join(OUT, name), buf);
      if (f % 150 === 0) log("frame " + f + "/" + total + " t=" + t.toFixed(2) + "s size=" + Math.round(buf.length / 1024) + "KB");
    }
    log("done");
    app.exit(0);
  } catch (e) {
    log("failed: " + (e && e.message ? e.message : e));
    app.exit(1);
  }
});
