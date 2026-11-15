// ========================================
// 文件：modules/core.js
// 功能：核心地基——崩溃兜底 / 网络重试 / 状态持久化 / 限流熔断 / 版本检测 / 健康检查
// 依赖：./logger（可选，失败不崩）
// 导出：install / request / state / limiter / checkNodeVersion / healthCheck / startHealthCheck / stopHealthCheck
// 附带兼容别名：retry / readState / writeState / checkVersion（旧接口，转发到新实现）
// 作者：MineBots
// ========================================

const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.resolve(__dirname, "..");
const STATE_DIR = path.join(ROOT, "state");

// 可选依赖：settings 加载失败时回退默认值，绝不让进程崩。
let settings = null;
try { settings = require("../settings"); } catch (err) { settings = null; }

// 可选依赖：logger 可能为空，加载失败时所有日志退回 console。
let logger = null;
try { logger = require("./logger"); } catch (err) { logger = null; }

// 可选依赖：axios 用于网络重试，缺失时 request 直接返回 null。
let axios = null;
try { axios = require("axios"); } catch (err) { axios = null; }

let installed = false;
let healthTimer = null;

// 写警告日志：优先 logger.warn，不可用时退回 console，绝不抛错。
function logWarn(message) {
  try {
    if (logger && typeof logger.warn === "function") { logger.warn(message); return; }
  } catch (err) { /* 退回 console */ }
  try { console.error("[warn] " + message); } catch (err) { /* ignore */ }
}

// 写信息日志：优先 logger.info，不可用时退回 console，绝不抛错。
function logInfo(message) {
  try {
    if (logger && typeof logger.info === "function") { logger.info(message); return; }
  } catch (err) { /* 退回 console */ }
  try { console.log("[info] " + message); } catch (err) { /* ignore */ }
}

// 写错误日志：优先 logger.error，不可用时退回 console，绝不抛错。
function logError(message) {
  try {
    if (logger && typeof logger.error === "function") { logger.error(message); return; }
  } catch (err) { /* 退回 console */ }
  try { console.error("[error] " + message); } catch (err) { /* ignore */ }
}

// 解析日志目录：优先 settings.logs.dir，缺省 logs/，都相对项目根目录。
function logDir() {
  let rel = "logs";
  try {
    if (settings && settings.logs && settings.logs.dir) rel = settings.logs.dir;
  } catch (err) { rel = "logs"; }
  return path.resolve(ROOT, rel);
}

// 确保目录存在：成功返回 true，失败返回 false，绝不抛错。
function ensureDir(dir) {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch (err) {
    logError("创建目录失败 / mkdir failed: " + dir + " - " + (err && err.message ? err.message : String(err)));
    return false;
  }
}

// 把数字补零成两位字符串，供时间戳拼接使用。
function pad2(n) {
  return String(n).padStart(2, "0");
}

// 生成崩溃文件名时间戳 YYYYMMDD-HHMMSS。
function stamp() {
  const d = new Date();
  return String(d.getFullYear()) + pad2(d.getMonth() + 1) + pad2(d.getDate()) + "-" +
    pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
}

// 生成日期串 YYYYMMDD，供按天归档的健康日志使用。
function dayStamp() {
  const d = new Date();
  return String(d.getFullYear()) + pad2(d.getMonth() + 1) + pad2(d.getDate());
}

// ========================================
// 功能 1：崩溃兜底
// ========================================

// 写入崩溃日志 logs/crash-YYYYMMDD-HHMMSS.log，成功返回路径，失败返回 null。
function writeCrash(type, err) {
  let file = null;
  try {
    const dir = logDir();
    ensureDir(dir);
    file = path.join(dir, "crash-" + stamp() + ".log");
    const lines = [];
    lines.push("[type] " + type);
    lines.push("[time] " + new Date().toISOString());
    lines.push("[message] " + (err && err.message ? err.message : String(err)));
    lines.push("[stack]");
    lines.push(err && err.stack ? err.stack : "(no stack)");
    fs.writeFileSync(file, lines.join(os.EOL) + os.EOL, "utf8");
    logError("已写崩溃日志 / crash log written: " + file);
    return file;
  } catch (err2) {
    logError("崩溃日志写入失败 / crash log failed: " + (err2 && err2.message ? err2.message : String(err2)));
    return null;
  }
}

// 处理未捕获异常：写崩溃日志并记录，但不退出进程。
function onUncaughtException(err) {
  try { writeCrash("uncaughtException", err); } catch (e) { /* ignore */ }
  try { logError("未捕获异常 / uncaughtException: " + (err && err.message ? err.message : String(err))); } catch (e) { /* ignore */ }
}

// 处理未处理的 Promise 拒绝：转成 Error 后写崩溃日志，但不退出进程。
function onUnhandledRejection(reason) {
  try {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    writeCrash("unhandledRejection", err);
  } catch (e) { /* ignore */ }
  try { logError("未处理拒绝 / unhandledRejection: " + (reason && reason.message ? reason.message : String(reason))); } catch (e) { /* ignore */ }
}

// 优雅退出：停掉健康检查、刷新日志缓冲，然后结束进程。
function gracefulExit(signal) {
  try { logInfo("准备退出 / shutting down: " + signal); } catch (err) { /* ignore */ }
  try { stopHealthCheck(); } catch (err) { /* ignore */ }
  try { if (logger && typeof logger.flush === "function") logger.flush(); } catch (err) { /* ignore */ }
  try {
    setTimeout(function () {
      try { process.exit(0); } catch (err) { /* ignore */ }
    }, 50);
  } catch (err) {
    try { process.exit(0); } catch (e) { /* ignore */ }
  }
}

// 响应 SIGINT 信号：走优雅退出流程。
function onSigint() {
  gracefulExit("SIGINT");
}

// 响应 SIGTERM 信号：走优雅退出流程。
function onSigterm() {
  gracefulExit("SIGTERM");
}

// 安装全局兜底处理器：重复调用只生效一次，成功返回 true。
function install() {
  if (installed) return false;
  installed = true;
  try { process.on("uncaughtException", onUncaughtException); } catch (err) { /* ignore */ }
  try { process.on("unhandledRejection", onUnhandledRejection); } catch (err) { /* ignore */ }
  try { process.on("SIGINT", onSigint); } catch (err) { /* ignore */ }
  try { process.on("SIGTERM", onSigterm); } catch (err) { /* ignore */ }
  try { logInfo("崩溃兜底已安装 / crash guard installed"); } catch (err) { /* ignore */ }
  return true;
}

// ========================================
// 功能 2：网络重试
// ========================================

// 等待指定毫秒数，永不抛错。
function sleep(ms) {
  return new Promise(function (resolve) {
    try { setTimeout(resolve, ms); } catch (err) { resolve(); }
  });
}

// 指数退避重试器：重试耗尽后返回 null，绝不抛出异常。
async function retry(fn, options) {
  const opts = options || {};
  const retries = typeof opts.retries === "number" ? opts.retries : 3;
  const baseDelay = typeof opts.baseDelay === "number" ? opts.baseDelay : 300;
  const factor = typeof opts.factor === "number" ? opts.factor : 2;
  const label = opts.label ? opts.label : "task";
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= retries) break;
      const delay = baseDelay * Math.pow(factor, attempt);
      logWarn("重试 / retry [" + label + "] " + (attempt + 1) + "/" + retries +
        " in " + delay + "ms - " + (err && err.message ? err.message : String(err)));
      await sleep(delay);
    }
  }
  logError("重试耗尽 / retry exhausted [" + label + "]: " +
    (lastErr && lastErr.message ? lastErr.message : String(lastErr)));
  return null;
}

// 用 axios 发一次 HTTP 请求，成功返回响应数据，失败抛出异常交给重试器。
function axiosSend(opts) {
  return new Promise(function (resolve, reject) {
    try {
      if (!axios) { reject(new Error("axios 未安装 / axios missing")); return; }
      const method = String(opts.method ? opts.method : "GET").toUpperCase();
      const allowed = ["GET", "POST", "PUT", "DELETE"];
      if (allowed.indexOf(method) === -1) {
        reject(new Error("不支持的请求方法 / method not allowed: " + method));
        return;
      }
      const conf = {
        method: method,
        url: opts.url,
        timeout: typeof opts.timeout === "number" ? opts.timeout : 8000,
        headers: opts.headers ? opts.headers : {}
      };
      if (opts.data !== undefined && opts.data !== null) conf.data = opts.data;
      axios(conf).then(function (res) {
        resolve(res ? res.data : null);
      }).catch(function (err) {
        reject(err);
      });
    } catch (err) {
      reject(err);
    }
  });
}

// 带重试的网络请求：url 缺失或重试耗尽都返回 null，不抛异常。
function request(options) {
  const opts = options || {};
  if (!opts.url) {
    logError("request 缺少 url / request needs options.url");
    return Promise.resolve(null);
  }
  const retries = typeof opts.retries === "number" ? opts.retries : 3;
  return retry(function () {
    return axiosSend(opts);
  }, { retries: retries, baseDelay: 1000, factor: 2, label: "request " + String(opts.url) });
}

// ========================================
// 功能 3：状态持久化
// ========================================

// 把状态名清洗成安全的 state/<name>.json 路径。
function stateFile(name) {
  let safe = String(name ? name : "state").replace(/[^a-zA-Z0-9._-]/g, "_");
  if (safe.indexOf(".json") !== safe.length - 5) safe = safe + ".json";
  return path.join(STATE_DIR, safe);
}

// 保存状态到 state/<name>.json：先写 .tmp 再改名，实现原子写入。
function stateSave(name, data) {
  const file = stateFile(name);
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
  try {
    if (!ensureDir(STATE_DIR)) return false;
    let text = null;
    try { text = JSON.stringify(data, null, 2); } catch (err) { text = null; }
    if (!text) {
      logError("状态无法序列化 / state not serializable: " + file);
      return false;
    }
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    logError("保存状态失败 / save state failed: " + file + " - " + (err && err.message ? err.message : String(err)));
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
    return false;
  }
}

// 读取 state/<name>.json：文件缺失或解析失败时返回 fallback。
function stateLoad(name, fallback) {
  const file = stateFile(name);
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    if (!raw || raw.trim().length === 0) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    logWarn("读取状态失败 / load state failed: " + file + " - " + (err && err.message ? err.message : String(err)));
    return fallback;
  }
}

const state = { save: stateSave, load: stateLoad };

// ========================================
// 功能 4：限流熔断
// ========================================

const LIMITER_THRESHOLD = 5;
const LIMITER_COOLDOWN_MS = 60000;
let limiterFailures = 0;
let limiterOpenedAt = 0;

// 查询是否放行：熔断打开期间返回 false，冷却结束后自动恢复。
function limiterCheck() {
  try {
    if (limiterFailures < LIMITER_THRESHOLD) return true;
    if (limiterOpenedAt > 0 && Date.now() - limiterOpenedAt >= LIMITER_COOLDOWN_MS) {
      limiterFailures = 0;
      limiterOpenedAt = 0;
      return true;
    }
    return false;
  } catch (err) {
    return true;
  }
}

// 记录一次成功：失败计数清零并解除熔断。
function limiterSuccess() {
  limiterFailures = 0;
  limiterOpenedAt = 0;
  return true;
}

// 记录一次失败：计数达到 5 次时打开 60 秒熔断。
function limiterFail() {
  try {
    limiterFailures += 1;
    if (limiterFailures >= LIMITER_THRESHOLD && limiterOpenedAt === 0) {
      limiterOpenedAt = Date.now();
      logWarn("熔断打开 / limiter open after " + limiterFailures + " failures, cooldown " + LIMITER_COOLDOWN_MS + "ms");
    }
  } catch (err) { /* 计数异常不影响调用方 */ }
  return limiterFailures;
}

const limiter = { check: limiterCheck, success: limiterSuccess, fail: limiterFail };

// ========================================
// 功能 5：版本检测
// ========================================

// 检测 Node 版本：主版本低于 18 返回警告字符串，否则返回 null，不退出进程。
function checkNodeVersion() {
  let major = 0;
  try { major = parseInt(String(process.versions.node).split(".")[0], 10); } catch (err) { major = 0; }
  if (major >= 18) return null;
  return "Node 版本过低 / Node too old: " + process.versions.node + "（建议 18+ / 18+ recommended）";
}

// ========================================
// 功能 6：健康检查
// ========================================

// 试探目录是否可写：写临时文件再删除，成功返回 true。
function probeDir(dir) {
  const tmp = path.join(dir, ".health-" + process.pid + "-" + Date.now() + ".tmp");
  try {
    fs.writeFileSync(tmp, "ok", "utf8");
    try { fs.unlinkSync(tmp); } catch (err) { /* ignore */ }
    return true;
  } catch (err) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
    return false;
  }
}

// 把健康检查发现的问题追加写入 logs/health-YYYYMMDD.log。
function writeHealthLog(problems) {
  try {
    const dir = logDir();
    ensureDir(dir);
    const file = path.join(dir, "health-" + dayStamp() + ".log");
    const lines = [];
    lines.push("[time] " + new Date().toISOString());
    lines.push("[pid] " + process.pid);
    for (let i = 0; i < problems.length; i++) lines.push("[problem] " + problems[i]);
    fs.appendFileSync(file, lines.join(os.EOL) + os.EOL, "utf8");
    return file;
  } catch (err) {
    return null;
  }
}

// 健康检查：全部正常返回 true 且不写日志，有问题返回 false 并写健康日志。
function healthCheck() {
  const problems = [];
  try {
    if (!ensureDir(STATE_DIR) || !probeDir(STATE_DIR)) problems.push("state 目录不可写 / state dir not writable");
  } catch (err) { problems.push("state 目录检查异常 / state dir check error"); }
  try {
    const dir = logDir();
    if (!ensureDir(dir) || !probeDir(dir)) problems.push("logs 目录不可写 / logs dir not writable");
  } catch (err) { problems.push("logs 目录检查异常 / logs dir check error"); }
  try {
    const warn = checkNodeVersion();
    if (warn) problems.push(warn);
  } catch (err) { problems.push("Node 版本检查异常 / node version check error"); }
  if (problems.length === 0) return true;
  try { writeHealthLog(problems); } catch (err) { /* ignore */ }
  return false;
}

// 启动健康检查定时器：每 5 分钟跑一次，成功返回 true。
function startHealthCheck() {
  try {
    stopHealthCheck();
    healthTimer = setInterval(function () {
      try { healthCheck(); } catch (err) { /* ignore */ }
    }, 300000);
    if (healthTimer && typeof healthTimer.unref === "function") healthTimer.unref();
    return true;
  } catch (err) {
    healthTimer = null;
    logError("启动健康检查失败 / start health check failed: " + (err && err.message ? err.message : String(err)));
    return false;
  }
}

// 停止健康检查定时器：清掉 timer，可重复调用。
function stopHealthCheck() {
  try {
    if (healthTimer) clearInterval(healthTimer);
    healthTimer = null;
    return true;
  } catch (err) {
    healthTimer = null;
    return false;
  }
}

// ========================================
// 兼容别名：旧版 core 的接口名转发到新实现，避免隐性依赖被破坏。
// ========================================

// 兼容旧接口：等价于 state.load。
function readState(name, fallback) {
  return stateLoad(name, fallback);
}

// 兼容旧接口：等价于 state.save。
function writeState(name, data) {
  return stateSave(name, data);
}

// 兼容旧接口：返回 { ok, node, required, message } 形式的版本信息。
function checkVersion() {
  const warn = checkNodeVersion();
  const ok = (warn === null);
  const result = {
    ok: ok,
    node: String(process.versions.node),
    required: 18,
    message: ok ? "Node 版本正常 / Node version OK (" + process.versions.node + ")" : warn
  };
  if (!ok) logWarn(warn);
  return result;
}

module.exports = {
  install: install,
  request: request,
  state: state,
  limiter: limiter,
  checkNodeVersion: checkNodeVersion,
  healthCheck: healthCheck,
  startHealthCheck: startHealthCheck,
  stopHealthCheck: stopHealthCheck,
  retry: retry,
  readState: readState,
  writeState: writeState,
  checkVersion: checkVersion
};
