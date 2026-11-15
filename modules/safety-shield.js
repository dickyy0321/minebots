// ========================================
// 文件：modules/safety-shield.js
// 功能：沙盒容错与防呆安全——恶意数据包吞掉 / 内存检测（>50 bot 告警）/ 一键清理并打包 state（脱敏）/ 致命错误红警识别
// 依赖：fs / path（Node 内置）、./logger（可选）、archiver（可选，缺失时降级为文件夹复制）
// 导出：sanitizeIncoming / guardBot / checkMemory / redactValue / cleanState / detectAlert / FILE_SIZE_LIMIT / MEMORY_THRESHOLD
// 说明：所有外部调用都 try/catch；绝不把异常抛到顶层；支持 MINEBOTS_STATE_DIR 隔离。
// 作者：MineBots
// ========================================

// 可选依赖：日志核心，缺失时退回 console，绝不抛错。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

var fs = require("fs");
var path = require("path");

// 常量：单包/单文件大小上限（字节）——超过直接丢弃，防止畸形数据把进程拖崩 / OOM。
var FILE_SIZE_LIMIT = 1024 * 1024; // 1 MB
// 常量：内存检测阈值——bot 数超过即告警（公共服离线模式最多能轻松带 50 个，再多要盯内存）。
var MEMORY_THRESHOLD = 50;
// 常量：需要脱敏的字段名（命中即替换为星号）。
var SECRET_KEYS = /apikey|password|passwd|token|secret|authorization|access_token|client_secret/i;

// 状态：archiver 是否加载（懒加载一次，用于把清理结果打成 zip）。
var archiver = null;
var archiverTried = false;

// 安全转字符串：null / undefined 统一成空串。
function toText(value) {
  try { return String(value === null || value === undefined ? "" : value); } catch (e) { return ""; }
}

// 取错误文本：catch 里再抛错就破红线了。
function errText(err) {
  try { return err && err.message ? String(err.message) : String(err); } catch (e) { return "unknown error"; }
}

// 写信息日志：优先 logger.info（高频不刷 GUI），不可用时退回 console。
function logInfo(msg) {
  try {
    if (logger && typeof logger.info === "function") { logger.info("[safety] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[safety] " + msg); } catch (e2) { /* ignore */ }
}

// 写告警日志：安全事件要人看见。
function logWarn(msg) {
  try {
    if (logger && typeof logger.warn === "function") { logger.warn("[safety] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.warn("[safety] " + msg); } catch (e2) { /* ignore */ }
}

// 懒加载 archiver（可选，用于把清理结果打成 zip）；取不到就记住失败，后续直接降级为文件夹复制。
function getArchiver() {
  if (archiverTried) return archiver;
  archiverTried = true;
  try { archiver = require("archiver"); } catch (e) { archiver = null; }
  return archiver;
}

// 取 state 目录绝对路径：MINEBOTS_STATE_DIR 优先（自测隔离），否则项目根 state/。
function stateDir() {
  try {
    var custom = process.env.MINEBOTS_STATE_DIR;
    if (custom && String(custom).length > 0) return path.resolve(String(custom));
    return path.resolve(process.cwd(), "state");
  } catch (e) { return path.join("state"); }
}

// 功能：脱敏单个值——命中密钥字段就替换成星号，其余原样返回。
function redactValue(key, value) {
  try {
    if (SECRET_KEYS.test(String(key || ""))) return "***REDACTED***";
  } catch (e) { /* 正则失败不脱敏 */ }
  return value;
}

// 功能：递归脱敏一个对象（不修改入参，返回副本），命中密钥字段全部星号化。
function redactObject(obj) {
  try {
    if (obj === null || obj === undefined) return obj;
    if (Array.isArray(obj)) {
      var outA = [];
      for (var i = 0; i < obj.length; i++) outA.push(redactObject(obj[i]));
      return outA;
    }
    if (typeof obj === "object") {
      var outO = {};
      var keys = Object.keys(obj);
      for (var j = 0; j < keys.length; j++) outO[keys[j]] = redactValue(keys[j], redactObject(obj[keys[j]]));
      return outO;
    }
  } catch (e) { return obj; }
  return obj;
}

// 功能：安全校验一段入站数据——空 / 超大 / 非预期类型都判失败并记日志，绝不抛错（畸形数据包入口）。
function sanitizeIncoming(raw) {
  var out = { ok: false, reason: "", bytes: 0 };
  try {
    if (raw === null || raw === undefined) { out.reason = "empty"; logWarn("丢弃空数据包 / dropped empty packet"); return out; }
    var str = (typeof raw === "object") ? JSON.stringify(raw) : String(raw);
    out.bytes = str.length;
    if (str.length > FILE_SIZE_LIMIT) { out.reason = "too_large"; logWarn("丢弃超大数据包 / dropped oversized packet: " + str.length + " bytes"); return out; }
    out.ok = true; out.reason = "ok"; out.data = raw;
    return out;
  } catch (e) {
    out.reason = "error"; out.message = errText(e);
    logWarn("入站数据校验异常 / incoming validation error: " + errText(e));
    return out;
  }
}

// 功能：给一个 bot 挂安全网——吞掉异常事件 / 畸形 raw 包，写日志但不让主进程崩。返回是否挂上。
function guardBot(bot, id) {
  try {
    if (!bot || typeof bot.on !== "function") return false;
    var botId = String(id || "?");
    // 吞掉连接层异常：任何未被业务监听的错误都落日志，绝不冒到顶层。
    bot.on("error", function (err) {
      logWarn("[" + botId + "] 已吞掉异常数据 / swallowed bot error: " + errText(err));
    });
    // 畸形 raw 包：包体异常直接丢弃，不解析、不抛错（防恶意数据包 / 畸形属性把进程拖崩）。
    bot.on("raw", function (packet) {
      try {
        if (!packet || typeof packet !== "object") return; // 非对象包直接忽略
        if (JSON.stringify(packet).length > FILE_SIZE_LIMIT) {
          logWarn("[" + botId + "] 丢弃超大 raw 包 / dropped oversized raw packet");
        }
      } catch (e) { /* 序列化失败也只丢弃 */ }
    });
    return true;
  } catch (e) {
    logWarn("[" + String(id || "?") + "] 安全网挂失败 / guard attach failed: " + errText(e));
    return false;
  }
}

// 功能：内存检测——bot 数超过阈值即返回 warn:true，供 GUI 弹告警。绝不抛错。
function checkMemory(botCount) {
  var n = 0;
  try { n = Number(botCount) || 0; } catch (e) { n = 0; }
  var warn = n > MEMORY_THRESHOLD;
  return {
    ok: true, warn: warn, count: n, threshold: MEMORY_THRESHOLD,
    message: warn ? ("已启动 " + n + " 个机器人，请关注内存 / many bots (" + n + "), watch memory") : ""
  };
}

// 功能：识别致命错误文本（AI 欠费 402 / 网络中断），返回红警文案或 null。绝不抛错。
function detectAlert(text) {
  try {
    var s = toText(text);
    if (/402|payment required|欠费/i.test(s)) return "AI 接口欠费（402），请检查余额 / AI API payment required (402)";
    if (/ECONNRESET|ENOTFOUND|ECONNREFUSED|网络中断|network down|disconnect|连接被重置|超时|timeout/i.test(s)) {
      return "网络中断 / 连续断网，请检查连接 / network down, check connection";
    }
  } catch (e) { /* ignore */ }
  return null;
}

// 功能：一键清理并打包 state——把 state/ 复制到带时间戳的目录，脱敏密钥字段；
//       若 archiver 可用则额外打成 zip（可选）；原 state/ 不删（只做打包备份，防 API Key 泄露）。
// 返回 { ok, path, zip, files, redacted, message }——失败也返回 ok:false，绝不抛错。
function cleanState(options) {
  var opts = options && typeof options === "object" ? options : {};
  var src = stateDir();
  var out = { ok: false, path: "", zip: "", files: 0, redacted: 0, message: "" };
  try {
    if (!fs.existsSync(src)) { out.message = "state 目录不存在 / state dir not found"; return out; }
    var stamp = "state-clean-" + Date.now();
    var dst = path.join(path.dirname(src), stamp);
    if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
    var redacted = 0;
    var files = 0;
    // 深拷贝目录：文件脱敏、子目录递归。
    (function copyDir(from, to) {
      var entries = fs.readdirSync(from);
      for (var i = 0; i < entries.length; i++) {
        var name = entries[i];
        var fromP = path.join(from, name);
        var toP = path.join(to, name);
        var st = fs.statSync(fromP);
        if (st.isDirectory()) {
          if (!fs.existsSync(toP)) fs.mkdirSync(toP, { recursive: true });
          copyDir(fromP, toP);
        } else if (st.isFile()) {
          files = files + 1;
          var lower = name.toLowerCase();
          if (lower.endsWith(".json")) {
            try {
              var parsed = JSON.parse(fs.readFileSync(fromP, "utf8"));
              var redactedObj = redactObject(parsed);
              var changed = JSON.stringify(redactedObj) !== JSON.stringify(parsed);
              if (changed) redacted = redacted + 1;
              fs.writeFileSync(toP, JSON.stringify(redactedObj, null, 2), "utf8");
            } catch (eParse) {
              // 解析失败（可能本来就不是合法 JSON）原样复制，不阻断打包。
              fs.copyFileSync(fromP, toP);
            }
          } else {
            fs.copyFileSync(fromP, toP);
          }
        }
      }
    })(src, dst);
    out.files = files;
    out.redacted = redacted;
    out.path = dst;
    // 可选：打成 zip（archiver 缺失时跳过，只保留文件夹）。
    if (opts.pack === true) {
      var arc = getArchiver();
      if (arc) {
        try {
          var zipPath = dst + ".zip";
          var outS = fs.createWriteStream(zipPath);
          var archive = arc("zip", { zlib: { level: 9 } });
          var done = false;
          archive.on("error", function (eZip) { done = true; logWarn("打包失败 / zip failed: " + errText(eZip)); });
          archive.pipe(outS);
          archive.directory(dst, false);
          archive.finalize();
          out.zip = zipPath;
        } catch (eZip2) { logWarn("打包跳过 / zip skipped: " + errText(eZip2)); }
      }
    }
    out.ok = true;
    out.message = "已清理并打包 " + files + " 个文件，脱敏 " + redacted + " 个含密钥文件 / packed " + files + " files, redacted " + redacted;
    return out;
  } catch (e) {
    out.message = errText(e);
    logWarn("清理打包失败 / clean & pack failed: " + errText(e));
    return out;
  }
}

// 对外导出：全部安全接口 + 常量。
module.exports = {
  sanitizeIncoming: sanitizeIncoming,
  guardBot: guardBot,
  checkMemory: checkMemory,
  detectAlert: detectAlert,
  redactValue: redactValue,
  redactObject: redactObject,
  cleanState: cleanState,
  FILE_SIZE_LIMIT: FILE_SIZE_LIMIT,
  MEMORY_THRESHOLD: MEMORY_THRESHOLD
};
