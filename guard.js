// ========================================
// 文件：guard.js
// 功能：AI 改代码护栏。init 备份 / check 检查 / restore 回滚
// 用法：
//   node guard.js init      初始化快照（第一次用）
//   node guard.js check     检查有没有越界
//   node guard.js restore   一键回滚
// 注意：guard.js 自己不被检查，也不在快照里
// ========================================

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const GUARD = path.join(ROOT, ".guard");
const BACKUP = path.join(GUARD, "backup");
const SNAP = path.join(GUARD, "snapshot.json");

// ===== 规则 =====
// 允许 AI 修改的目录（空字符串代表项目根目录，但根目录下有白名单）
const ALLOWED_DIRS = ["modules", "gui", "scripts"];

// 根目录下允许 AI 新建的文件（白名单）
const ALLOWED_ROOT_FILES = [
  "setup-project.js", "scan-g.bat", "scan-vscode.bat", "scan-pc.bat"
];

// 绝对禁止改的文件
const FORBIDDEN_FILES = [
  "package.json",
  "settings.js",
  "index.js",
  "README.md",
  "structure.md",
  "LICENSE"
];

// 单个文件最大行数
const MAX_LINES = 600;

// 禁止的语法
const FORBIDDEN_PATTERNS = [
  { re: /\?\./, name: "?. 可选链" },
  { re: /\?\?/, name: "?? 空值合并" },
  { re: /^import\s+/m, name: "import（要用 require）" },
  { re: /^export\s+/m, name: "export" }
];

// 必须有的
const REQUIRED_PATTERNS = [
  { re: /^\/\/\s*.+/m, name: "文件头注释" }
];

// 这个文件自己，不检查
const SKIP_FILES = ["guard.js"];

// ===== 工具 =====
function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function walk(dir, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  var items = fs.readdirSync(dir);
  for (var i = 0; i < items.length; i++) {
    var name = items[i];
    if (name === "node_modules") continue;
    if (name === ".guard") continue;
    if (name === ".git") continue;
    if (name === ".vscode") continue;
    var full = path.join(dir, name);
    var st;
    try { st = fs.statSync(full); } catch (e) { continue; }
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join("/");
}

function hash(s) {
  return crypto.createHash("sha1").update(s || "", "utf8").digest("hex");
}

function readText(p) {
  try { return fs.readFileSync(p, "utf8"); } catch (e) { return null; }
}

function isAllowedDir(relPath) {
  for (var i = 0; i < ALLOWED_DIRS.length; i++) {
    if (relPath.indexOf(ALLOWED_DIRS[i] + "/") === 0) return true;
  }
  return false;
}

function isForbidden(relPath) {
  for (var i = 0; i < FORBIDDEN_FILES.length; i++) {
    if (relPath === FORBIDDEN_FILES[i]) return true;
  }
  return false;
}

function isSkip(relPath) {
  for (var i = 0; i < SKIP_FILES.length; i++) {
    if (relPath === SKIP_FILES[i]) return true;
  }
  return false;
}

// ===== init =====
function cmdInit() {
  ensureDir(GUARD);
  ensureDir(BACKUP);
  var files = walk(ROOT);
  var snap = { time: new Date().toISOString(), files: {} };
  var count = 0;
  for (var i = 0; i < files.length; i++) {
    var r = rel(files[i]);
    if (isSkip(r)) continue;
    var text = readText(files[i]);
    if (text === null) continue;
    snap.files[r] = { hash: hash(text), lines: text.split("\n").length };
    var target = path.join(BACKUP, r);
    ensureDir(path.dirname(target));
    fs.writeFileSync(target, text, "utf8");
    count++;
  }
  fs.writeFileSync(SNAP, JSON.stringify(snap, null, 2), "utf8");
  console.log("[guard] 快照完成，备份 " + count + " 个文件到 .guard/backup/");
}

// ===== check =====
function cmdCheck() {
  if (!fs.existsSync(SNAP)) {
    console.log("[guard] 还没有快照，先跑：node guard.js init");
    return;
  }
  var snap = JSON.parse(fs.readFileSync(SNAP, "utf8"));
  var files = walk(ROOT);
  var violations = [];

  for (var i = 0; i < files.length; i++) {
    var r = rel(files[i]);
    if (isSkip(r)) continue;

    // 1. 绝对禁止改的文件
    if (isForbidden(r)) {
      var curForbidden = readText(files[i]) || "";
      if (!snap.files[r] || snap.files[r].hash !== hash(curForbidden)) {
        violations.push({ file: r, rule: "禁止修改核心文件" });
      }
      continue;
    }

    // 2. 只检查 .js 文件
    if (!r.endsWith(".js")) continue;

    var text = readText(files[i]);
    if (text === null) continue;
    var lines = text.split("\n");

    // 3. 目录检查
    var inAllowed = isAllowedDir(r);
    // 根目录文件，看白名单
    if (r.indexOf("/") < 0) {
      var inRootAllowed = false;
      for (var a = 0; a < ALLOWED_ROOT_FILES.length; a++) {
        if (r === ALLOWED_ROOT_FILES[a]) { inRootAllowed = true; break; }
      }
      // 根目录里的旧文件（快照里已有的），允许保留，不检查目录
      if (!inRootAllowed && !snap.files[r]) {
        violations.push({ file: r, rule: "禁止在项目根目录新建文件" });
      }
    } else if (!inAllowed) {
      violations.push({ file: r, rule: "禁止在未授权目录新建文件" });
    }

    // 4. 行数
    if (lines.length > MAX_LINES) {
      violations.push({ file: r, rule: "超过 " + MAX_LINES + " 行", detail: lines.length + " 行" });
    }

    // 5. 禁止语法
    for (var p = 0; p < FORBIDDEN_PATTERNS.length; p++) {
      if (FORBIDDEN_PATTERNS[p].re.test(text)) {
        violations.push({ file: r, rule: "禁止语法：" + FORBIDDEN_PATTERNS[p].name });
      }
    }

    // 6. 必须有文件头注释
    for (var q = 0; q < REQUIRED_PATTERNS.length; q++) {
      if (!REQUIRED_PATTERNS[q].re.test(text)) {
        violations.push({ file: r, rule: "缺少：" + REQUIRED_PATTERNS[q].name });
      }
    }

    // 7. 中文标识符
    var zhId = /(?:var|let|const|function)\s+([\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)/;
    if (zhId.test(text)) {
      violations.push({ file: r, rule: "变量名/函数名不能用中文" });
    }
  }

  // 8. 被删的文件
  for (var rr in snap.files) {
    if (!Object.prototype.hasOwnProperty.call(snap.files, rr)) continue;
    if (!fs.existsSync(path.join(ROOT, rr))) {
      violations.push({ file: rr, rule: "文件被删除" });
    }
  }

  if (violations.length === 0) {
    console.log("[guard] 通过，没有越界。");
    return;
  }

  console.log("[guard] 发现 " + violations.length + " 处越界：");
  for (var v = 0; v < violations.length; v++) {
    var msg = "  x " + violations[v].file + "  ->  " + violations[v].rule;
    if (violations[v].detail) msg += " (" + violations[v].detail + ")";
    console.log(msg);
  }
  console.log("");
  console.log("要回滚，跑：node guard.js restore");
}

// ===== restore =====
function cmdRestore() {
  if (!fs.existsSync(SNAP)) {
    console.log("[guard] 没有快照，无法恢复");
    return;
  }
  var snap = JSON.parse(fs.readFileSync(SNAP, "utf8"));
  var restored = 0;
  var deleted = 0;

  // 恢复被改的文件
  for (var r in snap.files) {
    if (!Object.prototype.hasOwnProperty.call(snap.files, r)) continue;
    var full = path.join(ROOT, r);
    var backupFile = path.join(BACKUP, r);
    var original = readText(backupFile);
    if (original === null) continue;
    var current = readText(full);
    if (current === null) {
      ensureDir(path.dirname(full));
      fs.writeFileSync(full, original, "utf8");
      restored++;
      console.log("  恢复：" + r);
    } else if (hash(current) !== snap.files[r].hash) {
      fs.writeFileSync(full, original, "utf8");
      restored++;
      console.log("  恢复：" + r);
    }
  }

  // 删除 AI 新建的文件
  var now = walk(ROOT);
  for (var i = 0; i < now.length; i++) {
    var rr = rel(now[i]);
    if (isSkip(rr)) continue;
    if (!snap.files[rr]) {
      try { fs.unlinkSync(now[i]); deleted++; console.log("  删除新增：" + rr); } catch (e) {}
    }
  }

  console.log("");
  console.log("[guard] 恢复 " + restored + " 个，删除新增 " + deleted + " 个。");
  console.log("[guard] 再跑：node guard.js check");
}

// ===== 入口 =====
var cmd = process.argv[2] || "";
if (cmd === "init") cmdInit();
else if (cmd === "check") cmdCheck();
else if (cmd === "restore") cmdRestore();
else {
  console.log("用法：");
  console.log("  node guard.js init      初始化快照（第一次用）");
  console.log("  node guard.js check     检查有没有越界");
  console.log("  node guard.js restore   一键回滚");
}