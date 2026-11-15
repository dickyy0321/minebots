// ========================================
// 文件：scripts/e2e-ui-full-helpers.js
// 功能：全量前端自测的 DOM 模拟与页面运行沙箱——纯 Node 内置 fs / path / vm，无第三方依赖。
//       parseAttrs / makeCtx / makeDom 构造最小 DOM；buildPage 解析 HTML；botApiMethods 从 preload 提取
//       IPC 清单；makePage 按 HTML 里的 script 顺序真实执行渲染层 JS 并挂探针；stateOf 读状态快照。
// 依赖：fs / path / vm（Node 内置）；被 e2e-ui-full-test.js require。
// 导出：module.exports = { ROOT, RENDERER, PAGES, makePage, stateOf }
// 作者：MineBots
// ========================================
var fs = require("fs");
var path = require("path");
var vm = require("vm");
var ROOT = path.join(__dirname, "..");
var RENDERER = path.join(ROOT, "gui", "renderer");

var PAGES = ["index.html", "settings.html"];
var VOID_TAGS = ["input", "br", "hr", "img", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr"];
var CTX_METHODS = ["fillRect", "clearRect", "strokeRect", "beginPath", "closePath", "moveTo", "lineTo", "arc", "fill", "stroke",
  "save", "restore", "translate", "rotate", "scale", "fillText", "strokeText", "measureText", "createLinearGradient",
  "createRadialGradient", "drawImage", "setTransform", "setLineDash", "bezierCurveTo", "quadraticCurveTo", "rect", "clip"];

// 解析属性串：支持双引号 / 单引号 / 无值布尔属性；异常返回空对象。
function parseAttrs(text) {
  var out = {};
  try {
    var re = /([A-Za-z_:][\w:.-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      var value = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : ""));
      out[m[1].toLowerCase()] = value;
    }
  } catch (e) { return {}; }
  return out;
}

// 造一个 2D 画布上下文：所有绘图方法都是空操作，保证 ui-map.js 不抛错。
function makeCtx() {
  var ctx = {};
  for (var i = 0; i < CTX_METHODS.length; i++) {
    (function (name) {
      ctx[name] = function () {
        if (name === "measureText") return { width: 10 };
        if (name === "createLinearGradient" || name === "createRadialGradient") return { addColorStop: function () {} };
        return undefined;
      };
    })(CTX_METHODS[i]);
  }
  ctx.canvas = null;
  return ctx;
}

// 元素：只实现渲染层真正用到的 DOM 子集，任何写操作都记一次 mutation 供「状态改变」判定。
function makeDom() {
  var doc = { byId: {}, mutations: 0, listeners: {}, scripts: [], fireErrors: [] };

  function Element(tag, attrs) {
    this.tagName = String(tag || "div").toUpperCase();
    this.attrs = attrs || {};
    this.id = this.attrs.id || "";
    this.className = this.attrs["class"] || "";
    this.value = this.attrs.value !== undefined ? this.attrs.value : "";
    this.checked = this.attrs.checked !== undefined;
    this.disabled = this.attrs.disabled !== undefined;
    this.type = this.attrs.type || (this.tagName === "SELECT" ? "select-one" : "text");
    this.textContent = "";
    this.innerHTML = "";
    this.children = [];
    this.childNodes = [];
    this.parentNode = null;
    this.style = {};
    this.listeners = {};
    this.nodeType = 1;
    this.ownerDocument = doc;
    if (this.id) doc.byId[this.id] = this;
    this.classList = makeClassList(this);
  }

  function makeClassList(el) {
    return {
      add: function () {
        var parts = String(el.className).split(/\s+/).filter(function (x) { return x.length > 0; });
        for (var i = 0; i < arguments.length; i++) if (parts.indexOf(arguments[i]) < 0) parts.push(arguments[i]);
        el.className = parts.join(" "); doc.mutations = doc.mutations + 1;
      },
      remove: function () {
        var parts = String(el.className).split(/\s+/).filter(function (x) { return x.length > 0; });
        for (var i = 0; i < arguments.length; i++) {
          var at = parts.indexOf(arguments[i]); if (at >= 0) parts.splice(at, 1);
        }
        el.className = parts.join(" "); doc.mutations = doc.mutations + 1;
      },
      toggle: function (name, force) {
        var has = this.contains(name);
        var on = force === undefined ? !has : !!force;
        if (on) this.add(name); else this.remove(name);
        return on;
      },
      contains: function (name) { return String(el.className).split(/\s+/).indexOf(name) >= 0; }
    };
  }

  Element.prototype.getAttribute = function (name) {
    var key = String(name).toLowerCase();
    if (key === "class") return this.className;
    if (key === "id") return this.id;
    if (key === "value") return this.value;
    return Object.prototype.hasOwnProperty.call(this.attrs, key) ? this.attrs[key] : null;
  };
  Element.prototype.setAttribute = function (name, value) {
    var key = String(name).toLowerCase();
    this.attrs[key] = String(value);
    if (key === "id") { this.id = String(value); doc.byId[this.id] = this; }
    if (key === "class") this.className = String(value);
    if (key === "value") this.value = String(value);
    doc.mutations = doc.mutations + 1;
    return true;
  };
  Element.prototype.removeAttribute = function (name) {
    delete this.attrs[String(name).toLowerCase()]; doc.mutations = doc.mutations + 1; return true;
  };
  Element.prototype.hasAttribute = function (name) { return Object.prototype.hasOwnProperty.call(this.attrs, String(name).toLowerCase()); };
  Element.prototype.addEventListener = function (type, fn) {
    if (typeof fn !== "function") return false;
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(fn);
    return true;
  };
  Element.prototype.removeEventListener = function (type, fn) {
    var list = this.listeners[type] || [];
    var at = list.indexOf(fn); if (at >= 0) list.splice(at, 1);
    return at >= 0;
  };
  Element.prototype.fire = function (type, ev) {
    var list = (this.listeners[type] || []).slice(0);
    var e = ev || {};
    e.type = type;
    e.target = e.target || this;
    e.currentTarget = this;
    e.preventDefault = e.preventDefault || function () {};
    e.stopPropagation = e.stopPropagation || function () {};
    for (var i = 0; i < list.length; i++) {
      try { list[i].call(this, e); } catch (err) { doc.fireErrors.push(String(err && err.message ? err.message : err)); }
    }
    return list.length;
  };
  Element.prototype.click = function () {
    if (this.disabled) return 0;
    return this.fire("click", {});
  };
  Element.prototype.appendChild = function (child) {
    if (!child) return child;
    child.parentNode = this;
    this.children.push(child);
    this.childNodes.push(child);
    if (child.id) doc.byId[child.id] = child;
    doc.mutations = doc.mutations + 1;
    return child;
  };
  Element.prototype.insertBefore = function (child, ref) {
    var at = this.children.indexOf(ref);
    if (at < 0) return this.appendChild(child);
    child.parentNode = this;
    this.children.splice(at, 0, child);
    this.childNodes.splice(at, 0, child);
    doc.mutations = doc.mutations + 1;
    return child;
  };
  Element.prototype.removeChild = function (child) {
    var at = this.children.indexOf(child);
    if (at >= 0) { this.children.splice(at, 1); this.childNodes.splice(at, 1); child.parentNode = null; }
    doc.mutations = doc.mutations + 1;
    return child;
  };
  Element.prototype.getContext = function () { return makeCtx(); };
  Element.prototype.focus = function () { return true; };
  Element.prototype.blur = function () { return true; };
  Element.prototype.scrollIntoView = function () { return true; };
  Element.prototype.remove = function () { if (this.parentNode) this.parentNode.removeChild(this); return true; };
  Element.prototype.closest = function () { return null; };
  Element.prototype.contains = function (child) {
    var node = child;
    while (node) { if (node === this) return true; node = node.parentNode; }
    return false;
  };
  Object.defineProperty(Element.prototype, "firstChild", { get: function () { return this.children.length > 0 ? this.children[0] : null; } });
  Object.defineProperty(Element.prototype, "nextSibling", {
    get: function () {
      if (!this.parentNode) return null;
      var at = this.parentNode.children.indexOf(this);
      return at >= 0 ? this.parentNode.children[at + 1] || null : null;
    }
  });
  Object.defineProperty(Element.prototype, "parentElement", { get: function () { return this.parentNode; } });

  // 简单选择器匹配：tag / #id / .class / [attr] / [attr="v"]，可组合。
  function matchOne(el, token) {
    try {
      var t = String(token).replace(/^\s+|\s+$/g, "");
      if (t.length === 0) return false;
      var head = /^([A-Za-z][\w-]*)?/.exec(t);
      var tag = head && head[1] ? head[1].toLowerCase() : "";
      if (tag && tag !== "*" && el.tagName.toLowerCase() !== tag) return false;
      var rest = t.slice(tag.length);
      var re = /(#)([\w-]+)|\.([\w-]+)|\[([^\]=]+)(?:=["']?([^\]"']*)["']?)?\]/g;
      var m;
      while ((m = re.exec(rest)) !== null) {
        if (m[1] === "#" && el.id !== m[2]) return false;
        if (m[3] && !el.classList.contains(m[3])) return false;
        if (m[4]) {
          var name = m[4].replace(/^\s+|\s+$/g, "");
          var got = el.getAttribute(name);
          if (got === null) return false;
          if (m[5] !== undefined && String(got) !== m[5]) return false;
        }
      }
      return true;
    } catch (e) { return false; }
  }

  function allOf(root) {
    var out = [];
    function walk(node) {
      if (!node || !node.children) return;
      for (var i = 0; i < node.children.length; i++) { out.push(node.children[i]); walk(node.children[i]); }
    }
    walk(root);
    return out;
  }

  function query(root, selector) {
    var out = [];
    try {
      var parts = String(selector).split(",");
      var all = allOf(root);
      for (var p = 0; p < parts.length; p++) {
        var tokens = parts[p].replace(/^\s+|\s+$/g, "").split(/\s+/);
        if (tokens.length === 0 || tokens[0].length === 0) continue;
        var last = tokens[tokens.length - 1];
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          if (!matchOne(el, last)) continue;
          var need = tokens.length - 2;
          var parent = el.parentNode;
          while (need >= 0 && parent) {
            if (matchOne(parent, tokens[need])) need = need - 1;
            parent = parent.parentNode;
          }
          if (need < 0 && out.indexOf(el) < 0) out.push(el);
        }
      }
    } catch (e) { return out; }
    return out;
  }

  Element.prototype.querySelectorAll = function (sel) { return query(this, sel); };
  Element.prototype.querySelector = function (sel) { var r = query(this, sel); return r.length > 0 ? r[0] : null; };

  var root = new Element("html", {});
  var head = new Element("head", {});
  var body = new Element("body", {});
  root.appendChild(head); root.appendChild(body);
  doc.root = root;
  doc.body = body;
  doc.documentElement = root;
  doc.createElement = function (tag) { return new Element(tag, {}); };
  doc.createTextNode = function (text) { return { nodeType: 3, textContent: String(text || "") }; };
  doc.getElementById = function (id) { return doc.byId[String(id)] || null; };
  doc.querySelectorAll = function (sel) { return query(root, sel); };
  doc.querySelector = function (sel) { var r = query(root, sel); return r.length > 0 ? r[0] : null; };
  doc.addEventListener = function (type, fn) {
    if (!doc.listeners[type]) doc.listeners[type] = [];
    doc.listeners[type].push(fn);
    return true;
  };
  doc.removeEventListener = function (type, fn) {
    var list = doc.listeners[type] || []; var at = list.indexOf(fn); if (at >= 0) list.splice(at, 1); return at >= 0;
  };
  doc.fire = function (type) {
    var list = (doc.listeners[type] || []).slice(0);
    for (var i = 0; i < list.length; i++) { try { list[i]({ type: type, target: doc }); } catch (e) { /* 单个回调失败不影响其它 */ } }
    return list.length;
  };
  doc.newElement = function (tag, attrs) { return new Element(tag, attrs || {}); };
  return doc;
}

// 从 HTML 构建 DOM 树并收集脚本 src（按顺序）。
function buildPage(html) {
  var doc = makeDom();
  var cleaned = String(html).replace(/<!--[\s\S]*?-->/g, "").replace(/<!DOCTYPE[^>]*>/gi, "");
  var re = /<\/?([A-Za-z][\w-]*)\b([^>]*)>/g;
  var stack = [doc.body];
  var m;
  while ((m = re.exec(cleaned)) !== null) {
    var full = m[0];
    var tag = m[1].toLowerCase();
    var attrsText = m[2] || "";
    if (full.charAt(1) === "/") {
      for (var i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName.toLowerCase() === tag) { stack.length = i; break; }
      }
      continue;
    }
    var attrs = parseAttrs(attrsText);
    if (tag === "script" && attrs.src) doc.scripts.push(attrs.src);
    var el = doc.newElement(tag, attrs);
    stack[stack.length - 1].appendChild(el);
    var selfClose = /\/\s*$/.test(attrsText);
    if (VOID_TAGS.indexOf(tag) < 0 && !selfClose) stack.push(el);
  }
  return doc;
}

// 从 preload.js 提取 botAPI 方法名，自动跟随新增 IPC 通道，不用手工维护清单。
function botApiMethods() {
  var out = [];
  try {
    var src = fs.readFileSync(path.join(ROOT, "gui", "preload.js"), "utf8");
    var re = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*function\s*\(/g;
    var m;
    while ((m = re.exec(src)) !== null) if (out.indexOf(m[1]) < 0) out.push(m[1]);
  } catch (e) { /* 读不到走下面的兜底清单 */ }
  var fallback = ["startBot", "stopBot", "executeCommand", "aiConfigLoad", "playerLoad", "prefsLoad",
    "channelList", "channelSet", "channelCommand", "modelProfileList", "modelProfileSet", "swarmConsole"];
  for (var i = 0; i < fallback.length; i++) if (out.indexOf(fallback[i]) < 0) out.push(fallback[i]);
  return out;
}

// 构造一个页面的运行沙箱：真实执行 HTML 里列出的所有 renderer 脚本。
function makePage(pageName) {
  var html = fs.readFileSync(path.join(RENDERER, pageName), "utf8");
  var doc = buildPage(html);
  var calls = [];
  var navLog = [];
  var scriptErrors = [];
  var winListeners = {};
  var storage = {};
  var location = { _href: "" };
  try {
    Object.defineProperty(location, "href", {
      get: function () { return location._href; },
      set: function (v) { location._href = String(v); navLog.push(String(v)); },
      configurable: true
    });
  } catch (e) { /* 定义失败退化为普通属性 */ }

  var deferred = [];
  var botApi = {};
  var apiNames = botApiMethods();
  for (var a = 0; a < apiNames.length; a++) {
    (function (name) {
      botApi[name] = function () {
        calls.push({ target: "botAPI", name: name, args: Array.prototype.slice.call(arguments) });
        return undefined;
      };
    })(apiNames[a]);
  }

  var quiet = { log: function () {}, warn: function () {}, error: function () {}, info: function () {}, debug: function () {} };
  var sandbox = {
    document: doc, location: location, localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null; },
      setItem: function (k, v) { storage[k] = String(v); },
      removeItem: function (k) { delete storage[k]; },
      clear: function () { storage = {}; }
    },
    navigator: { userAgent: "node-e2e-ui", language: "zh-CN" },
    console: quiet, botAPI: botApi, __calls: calls, __navLog: navLog,
    setTimeout: function (fn, ms) { if (typeof fn === "function" && (Number(ms) || 0) <= 0) deferred.push(fn); return 0; },
    clearTimeout: function () { return true; },
    setInterval: function () { return 0; }, clearInterval: function () { return true; },
    requestAnimationFrame: function () { return 0; }, cancelAnimationFrame: function () { return true; },
    alert: function () { return true; }, confirm: function () { return true; }, prompt: function () { return ""; },
    Image: function () { return {}; }, Event: function (t) { return { type: t }; },
    CustomEvent: function (t) { return { type: t }; },
    getComputedStyle: function () { return {}; },
    addEventListener: function (type, fn) {
      if (!winListeners[type]) winListeners[type] = [];
      winListeners[type].push(fn);
      return true;
    },
    removeEventListener: function () { return true; }
  };
  var ctx = vm.createContext(sandbox);
  try { vm.runInContext("var window = globalThis; window.window = window;", ctx); }
  catch (eWin) { sandbox.window = sandbox; }
  for (var s = 0; s < doc.scripts.length; s++) {
    var file = path.join(RENDERER, doc.scripts[s]);
    try {
      if (!fs.existsSync(file)) { scriptErrors.push(doc.scripts[s] + " missing / 脚本缺失"); continue; }
      vm.runInContext(fs.readFileSync(file, "utf8"), ctx, { filename: doc.scripts[s] });
    } catch (eScript) {
      scriptErrors.push(doc.scripts[s] + ": " + String(eScript && eScript.message ? eScript.message : eScript));
    }
  }
  try {
    vm.runInContext("(function () { var seen = __calls; var api = window.api || {}; Object.keys(api).forEach(function (k) { if (typeof api[k] !== 'function') return; var orig = api[k]; api[k] = function () { seen.push({ target: 'api', name: k, args: Array.prototype.slice.call(arguments) }); return orig.apply(api, arguments); }; }); })();", ctx);
  } catch (eSpy) { scriptErrors.push("api spy: " + String(eSpy && eSpy.message ? eSpy.message : eSpy)); }
  try {
    var dlist = (doc.listeners["DOMContentLoaded"] || []).slice(0);
    for (var d = 0; d < dlist.length; d++) {
      try { dlist[d]({ type: "DOMContentLoaded" }); }
      catch (eD) { scriptErrors.push("doc.DOMContentLoaded#" + d + ": " + String(eD && eD.message ? eD.message : eD)); }
    }
  } catch (eDom) { scriptErrors.push("DOMContentLoaded: " + String(eDom)); }
  try {
    var wlist = (winListeners["DOMContentLoaded"] || []).slice(0);
    for (var w = 0; w < wlist.length; w++) {
      try { wlist[w]({ type: "DOMContentLoaded" }); }
      catch (eOne) { scriptErrors.push("win.DOMContentLoaded#" + w + ": " + String(eOne && eOne.stack ? eOne.stack : eOne).slice(0, 400)); }
    }
  } catch (eWin2) { scriptErrors.push("window DOMContentLoaded: " + String(eWin2)); }
  try {
    var llist = (winListeners["load"] || []).slice(0);
    for (var l = 0; l < llist.length; l++) { try { llist[l]({ type: "load" }); } catch (eOne2) { /* load 回调失败不阻断 */ } }
  } catch (eLoad) { /* 同上 */ }
  for (var q = 0; q < deferred.length; q++) {
    try { deferred[q](); } catch (eQ) { scriptErrors.push("setTimeout(0)#" + q + ": " + String(eQ && eQ.message ? eQ.message : eQ)); }
  }
  try {
    var selects = doc.querySelectorAll("select");
    for (var si = 0; si < selects.length; si++) {
      var sel = selects[si];
      if (sel.children.length === 0) {
        var opt = doc.createElement("option");
        opt.setAttribute("value", "bot-1");
        opt.textContent = "bot-1";
        sel.appendChild(opt);
      }
      sel.value = "bot-1";
    }
  } catch (eSeed) { scriptErrors.push("seed selects: " + String(eSeed)); }
  try {
    vm.runInContext("(window.state.bots = window.state.bots || []).push({ id: 'bot-1', hostType: 'local', host: '127.0.0.1', port: 25565, username: 'bot-1', status: 'running' });", ctx);
  } catch (eBot) { scriptErrors.push("seed bot: " + String(eBot)); }
  try { vm.runInContext("if (window.uiBindAll && window.uiBindAll.refresh) window.uiBindAll.refresh();", ctx); }
  catch (eBind) { scriptErrors.push("uiBindAll: " + String(eBind)); }

  return { name: pageName, doc: doc, ctx: ctx, sandbox: sandbox, calls: calls, navLog: navLog,
    scriptErrors: scriptErrors, storage: storage, winListeners: winListeners };
}

// 读沙箱里的状态快照：点击计数 / 输入值 / bot 数 / 页面跳转标记。
function stateOf(page) {
  try {
    var raw = vm.runInContext("var s = window.state || {}; JSON.stringify({ clicks: s.uiClicks || {}, values: s.uiValues || {}, lastClick: s.lastClick || '', lastInput: s.lastInput || '', bots: (s.bots || []).length, nav: s.navigatedTo || '', stType: typeof window.state })", page.ctx);
    return JSON.parse(raw);
  } catch (e) { return { clicks: {}, values: {}, lastClick: "", lastInput: "", bots: 0, nav: "" }; }
}

module.exports = { ROOT: ROOT, RENDERER: RENDERER, PAGES: PAGES, makePage: makePage, stateOf: stateOf };
