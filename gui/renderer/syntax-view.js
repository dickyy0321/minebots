// gui/renderer/syntax-view.js
// 功能：语法窗口渲染——把 syntax.js 里的 SYNTAX_ZH / SYNTAX_EN 画到 #content，并跟随主窗口切语言
// 依赖：window.SYNTAX_ZH / window.SYNTAX_EN（由 syntax.js 提供）、window.syntaxAPI（preload 暴露，可选）
// 说明：纯展示、只读；数据缺失时给双语占位提示，绝不抛错

// 状态：当前语言（只认 en，其它一律按 zh 处理）。
var SYNTAX_LANG = "zh";

// 取当前语言的段落数组：数据缺失 / 类型不对就给空数组。
function syntaxItems(lang) {
  try {
    var list = lang === "en" ? window.SYNTAX_EN : window.SYNTAX_ZH;
    return Array.isArray(list) ? list : [];
  } catch (e) { return []; }
}

// 功能 1：渲染到 #content，同时更新标题与 body 的语言标记；渲染失败只清空，不抛错。
function renderSyntax(lang) {
  var box = document.getElementById("content");
  if (!box) return false;
  var items = syntaxItems(lang);
  try {
    if (items.length === 0) {
      box.textContent = "语法数据未加载 / syntax data not loaded";
    } else {
      box.innerHTML = items.join("\n");
    }
  } catch (e) {
    try { box.textContent = "语法渲染失败 / syntax render failed"; } catch (e2) { /* 忽略 */ }
    return false;
  }
  try { document.body.setAttribute("data-lang", lang); } catch (e3) { /* 忽略 */ }
  var title = document.getElementById("syntaxTitle");
  if (title) title.textContent = lang === "en" ? "Syntax Reference" : "语法规范";
  return true;
}

// 功能 2：切换语言（主进程推 set-lang 时调用）；非法值按中文处理。
function applySyntaxLang(lang) {
  SYNTAX_LANG = lang === "en" ? "en" : "zh";
  return renderSyntax(SYNTAX_LANG);
}

// 启动：先按中文渲染（不等主进程），收到 set-lang 后再覆盖成正确语言。
applySyntaxLang("zh");
if (window.syntaxAPI && typeof window.syntaxAPI.onSetLang === "function") {
  window.syntaxAPI.onSetLang(function (lang) { applySyntaxLang(lang); });
}
