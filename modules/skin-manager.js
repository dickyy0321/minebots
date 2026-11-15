// ========================================
// 文件：modules/skin-manager.js
// 功能：皮肤导入与管理——校验 PNG（签名/尺寸/体积），写入后台仓库，返回 sha256 与尺寸供卡片预览
// 依赖：fs / path / crypto（Node 内置）、./bot-roster（仓库路径）、./logger（可选）
// 导出：parsePng / validate / importSkin / getSkin / removeSkin / skinInfo
// 说明：皮肤存在 %APPDATA%/MineBots/roster/skins/<botId>.png，和 Bot 档案同仓，永久删除时一起清。
//       只接受 64x64 / 64x32 / 128x128 / 256x256 的 PNG；单文件上限 2MB。
// 作者：MineBots
// ========================================
var fs = require("fs");
var path = require("path");
var crypto = require("crypto");

var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
var roster = null;
try { roster = require("./bot-roster"); } catch (e2) { roster = null; }

var MAX_SKIN_BYTES = 2 * 1024 * 1024;
var ALLOWED = { "64x64": true, "64x32": true, "128x128": true, "256x256": true };
var PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

function errText(err) {
  try { return err && err.message ? String(err.message) : String(err); } catch (e) { return "unknown error"; }
}
function logInfo(msg) {
  try { if (logger && typeof logger.info === "function") { logger.info("[skin-manager] " + msg); return; } } catch (e) { /* console */ }
  try { console.log("[skin-manager] " + msg); } catch (e2) { /* ignore */ }
}

// 解析 PNG 头：返回 { ok, width, height, bitDepth, colorType }，非 PNG 返回 ok:false。
function parsePng(buf) {
  try {
    if (!buf || buf.length < 33) return { ok: false, message: "文件太小 / file too small" };
    for (var i = 0; i < PNG_SIG.length; i++) {
      if (buf[i] !== PNG_SIG[i]) return { ok: false, message: "不是 PNG / not a png" };
    }
    // IHDR 必须是第一个块：长度 13 + 类型 "IHDR"。
    if (buf[12] !== 73 || buf[13] !== 72 || buf[14] !== 68 || buf[15] !== 82) {
      return { ok: false, message: "缺少 IHDR / missing IHDR" };
    }
    var width = buf.readUInt32BE(16);
    var height = buf.readUInt32BE(20);
    var bitDepth = buf[24];
    var colorType = buf[25];
    if (width <= 0 || height <= 0) return { ok: false, message: "尺寸非法 / invalid size" };
    return { ok: true, width: width, height: height, bitDepth: bitDepth, colorType: colorType };
  } catch (e) { return { ok: false, message: "解析 PNG 失败 / parse failed: " + errText(e) }; }
}

// 校验尺寸组合与体积。
function validate(buf) {
  var info = parsePng(buf);
  if (!info.ok) return info;
  if (!ALLOWED[info.width + "x" + info.height]) {
    return { ok: false, message: "尺寸不支持 / unsupported size: " + info.width + "x" + info.height + "（支持 64x64 / 64x32 / 128x128 / 256x256）" };
  }
  if (buf.length > MAX_SKIN_BYTES) return { ok: false, message: "文件超过 2MB / file exceeds 2MB" };
  return info;
}

// 把 base64 / dataURL 解成 Buffer。
function decode(dataBase64) {
  try {
    var text = String(dataBase64 === null || dataBase64 === undefined ? "" : dataBase64);
    var cut = text.indexOf("base64,");
    if (cut >= 0) text = text.slice(cut + 7);
    if (text.length === 0) return { ok: false, message: "数据为空 / empty data" };
    var buf = Buffer.from(text, "base64");
    if (!buf || buf.length === 0) return { ok: false, message: "base64 解码失败 / decode failed" };
    return { ok: true, buffer: buf };
  } catch (e) { return { ok: false, message: errText(e) }; }
}

function sha256(buf) {
  try { return crypto.createHash("sha256").update(buf).digest("hex"); } catch (e) { return ""; }
}

// 导入皮肤：{ botId, dataBase64, fileName } -> { ok, skin:{file,sha256,width,height,size,updatedAt} }
function importSkin(input) {
  try {
    var p = input && typeof input === "object" ? input : {};
    if (!roster) return { ok: false, message: "仓库模块不可用 / roster unavailable" };
    var id = roster.sanitizeId(p.botId);
    if (!id) return { ok: false, message: "Bot id 非法 / invalid bot id" };
    var dec = decode(p.dataBase64);
    if (!dec.ok) return dec;
    var check = validate(dec.buffer);
    if (!check.ok) return check;
    var file = roster.skinPath(id);
    if (!file) return { ok: false, message: "皮肤路径非法 / invalid path" };
    var dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    var tmp = file + ".tmp";
    fs.writeFileSync(tmp, dec.buffer);
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (eU) { /* ignore */ }
    fs.renameSync(tmp, file);
    var meta = {
      file: "skins/" + id + ".png", sha256: sha256(dec.buffer),
      width: check.width, height: check.height, size: dec.buffer.length,
      fileName: String(p.fileName || "skin.png"), updatedAt: new Date().toISOString()
    };
    logInfo("皮肤已导入 / skin imported: " + id + " (" + check.width + "x" + check.height + ")");
    return { ok: true, botId: id, skin: meta };
  } catch (e) { return { ok: false, message: "导入异常 / import error: " + errText(e) }; }
}

// 读皮肤：返回 base64 与元信息，供渲染进程画头像。
function getSkin(botId) {
  try {
    if (!roster) return { ok: false, message: "仓库模块不可用 / roster unavailable" };
    var id = roster.sanitizeId(botId);
    if (!id) return { ok: false, message: "Bot id 非法 / invalid bot id" };
    var file = roster.skinPath(id);
    if (!file || !fs.existsSync(file)) return { ok: false, message: "没有皮肤 / no skin: " + id };
    var buf = fs.readFileSync(file);
    var info = parsePng(buf);
    return {
      ok: true, botId: id, base64: buf.toString("base64"),
      width: info.ok ? info.width : 0, height: info.ok ? info.height : 0,
      sha256: sha256(buf), size: buf.length
    };
  } catch (e) { return { ok: false, message: "读取皮肤失败 / read failed: " + errText(e) }; }
}

function removeSkin(botId) {
  try {
    if (!roster) return { ok: false };
    var id = roster.sanitizeId(botId);
    if (!id) return { ok: false, message: "Bot id 非法 / invalid bot id" };
    var file = roster.skinPath(id);
    if (file && fs.existsSync(file)) { fs.unlinkSync(file); return { ok: true, id: id, message: "皮肤已删除 / skin removed" }; }
    return { ok: true, id: id, message: "没有皮肤可删 / no skin" };
  } catch (e) { return { ok: false, message: errText(e) }; }
}

// 只查元信息（不返回 base64）。
function skinInfo(botId) {
  var got = getSkin(botId);
  if (!got.ok) return got;
  return { ok: true, botId: got.botId, width: got.width, height: got.height, size: got.size, sha256: got.sha256 };
}

module.exports = {
  parsePng: parsePng, validate: validate, decode: decode,
  importSkin: importSkin, getSkin: getSkin, removeSkin: removeSkin, skinInfo: skinInfo,
  MAX_SKIN_BYTES: MAX_SKIN_BYTES
};
