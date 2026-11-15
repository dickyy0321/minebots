// ========================================
// 文件：scripts/gui-shot.js
// 功能：GUI 截图工具——通过 Chrome DevTools 协议连上正在运行的 MineBots 窗口，切页 / 展开分组 / 截图存档
// 依赖：Node 内置 fetch / WebSocket（Node 18+），Electron 需以 --remote-debugging-port=9222 启动
// 用法：npm run gui -- --remote-debugging-port=9222   （另开一个终端）
//       node scripts/gui-shot.js                      默认截主界面 -> logs/demo-report/gui-main.png
//       node scripts/gui-shot.js --page=settings      切到设置页再截 -> logs/demo-report/gui-settings.png
//       node scripts/gui-shot.js --page=settings --local   设置页 + 切到本地模式 + 展开全部分组
// 说明：只读操作（导航 / 展开 / 切模式），不改任何配置；失败只打印原因，绝不抛错。
// 作者：MineBots
// ========================================
var fs = require("fs");
var path = require("path");

var ROOT = path.resolve(__dirname, "..");
var CDP = "http://127.0.0.1:9222/json/list";
var OUT_DIR = path.join(ROOT, "logs", "demo-report");

function argOf(name, def) {
  var list = process.argv || [];
  for (var i = 0; i < list.length; i++) {
    var one = String(list[i]);
    if (one.indexOf("--" + name + "=") === 0) return one.slice(name.length + 3);
    if (one === "--" + name) return true;
  }
  return def;
}

function logInfo(msg) {
  try { console.log("[gui-shot] " + msg); } catch (e) { /* ignore */ }
}

// 连接 CDP：返回 { call, close }；15 秒无响应按超时处理。
async function connect() {
  var list = await (await fetch(CDP)).json();
  var target = null;
  for (var i = 0; i < list.length; i++) {
    if (list[i].type === "page" && String(list[i].url).indexOf("renderer") >= 0) target = list[i];
  }
  if (!target) {
    for (var j = 0; j < list.length; j++) if (list[j].type === "page") target = list[j];
  }
  if (!target || !target.webSocketDebuggerUrl) throw new Error("没有可用的页面目标 / no page target");

  var ws = new WebSocket(target.webSocketDebuggerUrl);
  var seq = 0;
  var waits = {};
  ws.onmessage = function (ev) {
    try {
      var m = JSON.parse(ev.data);
      if (m.id && waits[m.id]) { var r = waits[m.id]; delete waits[m.id]; r(m); }
    } catch (e) { /* ignore */ }
  };
  await new Promise(function (resolve, reject) {
    ws.onopen = resolve;
    ws.onerror = function () { reject(new Error("CDP 连接失败 / connect failed")); };
  });
  var call = function (method, params) {
    return new Promise(function (resolve) {
      var id = ++seq;
      waits[id] = resolve;
      try { ws.send(JSON.stringify({ id: id, method: method, params: params || {} })); }
      catch (e) { delete waits[id]; resolve({ error: String(e && e.message) }); }
      setTimeout(function () {
        if (waits[id]) { delete waits[id]; resolve({ error: "timeout " + method }); }
      }, 15000);
    });
  };
  return { call: call, close: function () { try { ws.close(); } catch (e) { /* ignore */ } }, target: target };
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function main() {
  var page = String(argOf("page", "index"));
  var local = argOf("local", false) === true;
  var reload = argOf("reload", false) === true;
  var scrollTo = String(argOf("scroll", local ? "localTabs" : ""));
  var outName = String(argOf("out", page === "settings" ? "gui-settings.png" : "gui-main.png"));

  var conn = await connect();
  await conn.call("Page.enable");
  // 把窗口提到前台：Chromium 对后台窗口会节流渲染，不置顶可能截到旧帧。
  await conn.call("Page.bringToFront");
  // 最大化：设置页内容较长，小窗会截掉一半（拿不到 windowId 就保持原样）。
  if (argOf("nomax", false) !== true) {
    try {
      var win = await conn.call("Browser.getWindowForTarget", {});
      var wid = win && win.result ? win.result.windowId : 0;
      if (wid) await conn.call("Browser.setWindowBounds", { windowId: wid, bounds: { windowState: "maximized" } });
    } catch (eM) { /* 最大化失败不影响截图 */ }
  }
  await conn.call("Runtime.evaluate", { expression: "1", returnByValue: true });
  await sleep(500);

  // 1) 切页：只在当前不是目标页时导航，避免每次刷新丢状态。
  var cur = String(conn.target.url || "");
  if (page === "settings" && cur.indexOf("settings.html") < 0) {
    await conn.call("Runtime.evaluate", { expression: "location.href='settings.html'", returnByValue: true });
    await sleep(2600);
  } else if (page === "index" && cur.indexOf("index.html") < 0) {
    await conn.call("Runtime.evaluate", { expression: "location.href='index.html'", returnByValue: true });
    await sleep(2600);
  } else if (reload) {
    // 代码改完要截最新界面时用：强制重载当前页（会丢掉未保存的输入，只在截图工具里用）。
    await conn.call("Page.reload", { ignoreCache: true });
    await sleep(2800);
  }

  // 2) 设置页：展开所有折叠分组（h3 被 ui-mode 变成了 expert-fold-head）；--local 再切到本地模式并滚到标签条。
  if (page === "settings") {
    var expr = [
      "var hs=document.querySelectorAll('.expert-fold-head');",
      "for(var i=0;i<hs.length;i++){ if(hs[i].getAttribute('aria-expanded')!=='true') hs[i].click(); }",
      local ? "var s=document.getElementById('aiProviderSelect'); if(s){s.value='local'; s.dispatchEvent(new Event('change',{bubbles:true}));}" : "",
      "var nav=document.querySelector('[data-settings-nav=\"ai\"]'); if(nav) nav.click();",
      local ? "var t=document.getElementById('localTabs'); if(t) t.scrollIntoView({block:'center'});" : "",
      scrollTo ? "var sc=document.getElementById('" + scrollTo + "'); if(sc) sc.scrollIntoView({block:'center'});" : "",
      "'ok'"
    ].join(" ");
    await conn.call("Runtime.evaluate", { expression: expr, returnByValue: true });
    await sleep(1800);
  }

  // 3) 截图。
  var shot = await conn.call("Page.captureScreenshot", { format: "png" });
  var data = shot && shot.result ? shot.result.data : "";
  if (!data) {
    logInfo("截图失败 / capture failed: " + JSON.stringify(shot).slice(0, 160));
    conn.close();
    return { ok: false, message: "capture failed" };
  }
  try { if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true }); } catch (eMk) { /* ignore */ }
  var out = path.join(OUT_DIR, outName);
  fs.writeFileSync(out, Buffer.from(data, "base64"));

  // 4) 顺手回报页面状态，便于自检 / 排查。
  var info = await conn.call("Runtime.evaluate", {
    expression: "'url='+location.pathname.split('/').pop()+' | tabs='+((document.getElementById('localTabs')||{children:[]}).children.length)+' | title='+document.title",
    returnByValue: true
  });
  var text = info && info.result && info.result.result ? info.result.result.value : "";
  conn.close();
  logInfo("saved " + out + " (" + fs.statSync(out).size + " bytes) | " + text);
  return { ok: true, file: out, info: text };
}

if (require.main === module) {
  main().then(function (r) {
    if (r && r.ok === false) process.exitCode = 1;
  }).catch(function (e) {
    logInfo("失败 / failed: " + (e && e.message ? e.message : e));
    process.exitCode = 1;
  });
}

module.exports = { main: main };
