// ========================================
// 文件：gui/app-paths.js
// 功能：打包运行时的路径重定向——把 state / logs 指到用户数据目录，避免装到 Program Files 后写不进去
// 依赖：path（Node 内置）、electron（可选）、../settings（可选）
// 导出：init
// 说明：只在 app.isPackaged 为 true 时生效；开发态（npm run gui）完全不动，继续用仓库里的 state/ 与 logs/。
//       已经显式设置 MINEBOTS_STATE_DIR 的一律尊重（自测 / 便携模式都靠它）。
// 作者：MineBots
// ========================================
var path = require("path");
var fs = require("fs");

var app = null;
try { app = require("electron").app; } catch (e) { app = null; }

function logInfo(msg) {
  try { console.log("[app-paths] " + msg); } catch (e) { /* ignore */ }
}

// 内部：确保目录存在，失败只记日志（权限问题留给上层降级）。
function ensureDir(dir) {
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); return true; } catch (e) { return false; }
}

// 功能：初始化运行路径；返回 { ok, dir, logsDir, source }，失败只返回原因不抛错。
function init() {
  try {
    if (process.env.MINEBOTS_STATE_DIR && String(process.env.MINEBOTS_STATE_DIR).length > 0) {
      return { ok: true, dir: String(process.env.MINEBOTS_STATE_DIR), source: "env" };
    }
    if (!app || typeof app.getPath !== "function") return { ok: false, source: "no-electron" };
    // 开发态保持原样：仓库里的 state/ 便于调试与自检复用。
    if (typeof app.isPackaged === "boolean" && !app.isPackaged) return { ok: false, source: "dev" };
    var userData = app.getPath("userData");
    var stateDir = path.join(userData, "state");
    var logsDir = path.join(userData, "logs");
    process.env.MINEBOTS_STATE_DIR = stateDir;
    ensureDir(stateDir);
    ensureDir(logsDir);
    // 日志：logger 读 settings.logs.dir 且用 path.resolve 拼接，绝对路径会直接生效。
    try {
      var settings = require("../settings");
      if (settings && settings.logs && typeof settings.logs === "object") settings.logs.dir = logsDir;
    } catch (eS) { /* settings 缺失时日志退回默认，不影响启动 */ }
    logInfo("打包运行 / packaged: state=" + stateDir);
    return { ok: true, dir: stateDir, logsDir: logsDir, source: "userData" };
  } catch (e) { return { ok: false, message: e && e.message ? String(e.message) : String(e) }; }
}

module.exports = { init: init };
