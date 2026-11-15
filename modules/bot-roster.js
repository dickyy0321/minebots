// ========================================
// 文件：modules/bot-roster.js
// 功能：Bot 后台仓库——把某个 Bot 的全部配置（含皮肤）持久化到 state/ 之外的独立目录，本地清空也能拉回
// 依赖：fs / path / os（Node 内置）、./logger（可选）
// 导出：root / sanitizeId / save / load / list / restoreAll / remove / exists / profilePath / skinPath
// 说明：默认目录 %APPDATA%/MineBots/roster（可用 MINEBOTS_ROSTER_DIR 覆盖，自测隔离用）；
//       写入走「临时文件 + rename」原子替换；删除是永久删除（JSON + 皮肤一起删）。
// 作者：MineBots
// ========================================
var fs = require("fs");
var path = require("path");
var os = require("os");

var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

var SCHEMA = 1;
var MAX_PROFILE_BYTES = 512 * 1024;

function errText(err) {
  try { return err && err.message ? String(err.message) : String(err); } catch (e) { return "unknown error"; }
}
function logInfo(msg) {
  try { if (logger && typeof logger.info === "function") { logger.info("[bot-roster] " + msg); return; } } catch (e) { /* console */ }
  try { console.log("[bot-roster] " + msg); } catch (e2) { /* ignore */ }
}

// 仓库根目录：环境变量优先，其次 %APPDATA%/MineBots/roster，最后用户目录。
function root() {
  try {
    var custom = process.env.MINEBOTS_ROSTER_DIR;
    if (custom && String(custom).length > 0) return path.resolve(String(custom));
    var base = process.env.APPDATA || "";
    if (!base) {
      try { base = os.homedir(); } catch (e) { base = process.env.USERPROFILE || "."; }
      return path.join(base, ".minebots", "roster");
    }
    return path.join(base, "MineBots", "roster");
  } catch (e) { return path.join(".", "roster"); }
}

function profilesDir() { return path.join(root(), "profiles"); }
function skinsDir() { return path.join(root(), "skins"); }

function ensureDir(dir) {
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); return true; } catch (e) { return false; }
}
function exists(p) {
  try { return !!p && fs.existsSync(p); } catch (e) { return false; }
}

// 清洗 id：只允许字母数字点下划线横杠，最长 40，防路径穿越。
function sanitizeId(raw) {
  try {
    var text = String(raw === null || raw === undefined ? "" : raw).replace(/^\s+|\s+$/g, "");
    if (text.length === 0 || text.length > 40) return "";
    return /^[A-Za-z0-9._-]+$/.test(text) ? text : "";
  } catch (e) { return ""; }
}

function profilePath(id) {
  var key = sanitizeId(id);
  if (!key) return "";
  return path.join(profilesDir(), key + ".json");
}
function skinPath(id) {
  var key = sanitizeId(id);
  if (!key) return "";
  return path.join(skinsDir(), key + ".png");
}

// 原子写：先写 .tmp 再 rename，避免断电 / 崩溃留下半个文件。
function writeAtomic(file, text) {
  try {
    ensureDir(path.dirname(file));
    var tmp = file + ".tmp";
    fs.writeFileSync(tmp, text, "utf8");
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (eU) { /* ignore */ }
    fs.renameSync(tmp, file);
    return true;
  } catch (e) { return false; }
}

function readJson(file) {
  try {
    if (!exists(file)) return null;
    var parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (e) { return null; }
}

// 保存一份 Bot 档案：保留首次保存时间，更新 updatedAt；皮肤元信息随档案一起存。
function save(profile) {
  try {
    var p = profile && typeof profile === "object" ? profile : {};
    var id = sanitizeId(p.id);
    if (!id) return { ok: false, message: "Bot id 非法 / invalid bot id" };
    var text = JSON.stringify(p);
    if (text.length > MAX_PROFILE_BYTES) return { ok: false, message: "档案过大 / profile too large" };
    var file = profilePath(id);
    if (!file) return { ok: false, message: "档案路径非法 / invalid path" };
    var old = readJson(file);
    var now = new Date().toISOString();
    var rec = {
      schema: SCHEMA,
      id: id,
      savedAt: old && old.savedAt ? old.savedAt : now,
      updatedAt: now,
      skin: (p.skin && typeof p.skin === "object") ? p.skin : (old && old.skin ? old.skin : null),
      profile: p
    };
    if (!writeAtomic(file, JSON.stringify(rec, null, 2))) return { ok: false, message: "写入档案失败 / write failed" };
    logInfo("已保存 / saved: " + id);
    return { ok: true, id: id, savedAt: rec.savedAt, updatedAt: rec.updatedAt, skin: rec.skin, file: file };
  } catch (e) { return { ok: false, message: "保存异常 / save error: " + errText(e) }; }
}

// 读一份档案：返回 { ok, id, profile, skin, savedAt, updatedAt }。
function load(id) {
  var key = sanitizeId(id);
  if (!key) return { ok: false, message: "Bot id 非法 / invalid bot id" };
  var rec = readJson(profilePath(key));
  if (!rec) return { ok: false, message: "后台没有该 Bot / not found: " + key };
  return { ok: true, id: key, profile: rec.profile || {}, skin: rec.skin || null, savedAt: rec.savedAt || "", updatedAt: rec.updatedAt || "" };
}

// 列出全部档案（轻量摘要，不给皮肤二进制）。
function list() {
  var out = [];
  try {
    ensureDir(profilesDir());
    var names = fs.readdirSync(profilesDir());
    for (var i = 0; i < names.length; i++) {
      var name = String(names[i]);
      if (!/\.json$/.test(name)) continue;
      var rec = readJson(path.join(profilesDir(), name));
      if (!rec || !rec.id) continue;
      var p = rec.profile || {};
      out.push({
        id: rec.id, username: p.username || "", persona: p.persona || "",
        host: p.host || "", port: p.port || 0, version: p.version || "",
        loginMode: p.loginMode || "offline", skin: rec.skin || null,
        savedAt: rec.savedAt || "", updatedAt: rec.updatedAt || ""
      });
    }
    out.sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); });
  } catch (e) { /* 目录不存在按空处理 */ }
  return { ok: true, items: out, root: root() };
}

// 一键恢复：返回全部完整档案。
function restoreAll() {
  var out = [];
  var ls = list();
  for (var i = 0; i < ls.items.length; i++) {
    var got = load(ls.items[i].id);
    if (got.ok) out.push(got);
  }
  return { ok: true, items: out };
}

// 永久删除：JSON 档案 + 皮肤文件一起删，没有回收站。
function remove(id) {
  var key = sanitizeId(id);
  if (!key) return { ok: false, message: "Bot id 非法 / invalid bot id" };
  var removed = [];
  var files = [profilePath(key), skinPath(key)];
  for (var i = 0; i < files.length; i++) {
    try {
      if (exists(files[i])) { fs.unlinkSync(files[i]); removed.push(path.basename(files[i])); }
    } catch (e) { /* 单个删除失败不阻断 */ }
  }
  logInfo("已永久删除 / permanently removed: " + key + " (" + removed.length + " files)");
  return { ok: true, id: key, removed: removed, message: "已从后台永久删除 / permanently deleted: " + key };
}

module.exports = {
  root: root, sanitizeId: sanitizeId, save: save, load: load, list: list,
  restoreAll: restoreAll, remove: remove, exists: exists,
  profilePath: profilePath, skinPath: skinPath, profilesDir: profilesDir, skinsDir: skinsDir
};
