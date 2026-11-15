// ========================================
// 文件：modules/owner-privilege.js
// 功能：绝对主人特权——GUI 配置 isOwner=true 的玩家，锁定 trustScore=100、
//       AI 绝对服从、指令优先级最高，并输出 👑 [主人] 双语标签。
// 依赖：fs / path（原子写入）；./logger、./event-bus（均可选）
// 导出：configure / setOwner / isOwner / listOwners / labelOf / trustOf /
//       guardTrustDelta / applyTrustLock / decide / getPromptAppend / stats / reset / pathOf
// 作者：MineBots
// ========================================
// 数据文件：state/owner.json → { "owners": ["Steve"], "updatedAt": 1730000000000 }
//   名单为「显式授权」：只有 GUI 里勾了 isOwner=true 的玩家才享有绝对特权，
//   因此不会改变既有 players.json 等级表与 P12 情感断言的行为。
// 测试隔离：环境变量 MINEBOTS_STATE_DIR 可替换 state 目录，自测不碰真实存档。
// ES5 风格，CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

var fs = require("fs");
var path = require("path");
// 可选依赖：日志核心（只写文件，不推 GUI）。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
// 可选依赖：事件总线（配置变更广播给 AI / GUI）。
var bus = null;
try { bus = require("./event-bus"); } catch (e) { bus = null; }
// 常量：主人锁定的信任分 / 双语标签 / 数据文件名。
var OWNER_TRUST = 100;
var LABEL_ZH = "👑 [主人]";
var LABEL_EN = "👑 [Owner]";
var FILE_NAME = "owner.json";
var MAX_OWNERS = 16;

// 写普通日志：只落文件，不推 GUI。
function logInfo(text) {
  try { if (logger && typeof logger.info === "function") logger.info(text); } catch (e) { /* ignore */ }
}
// 安全取错误文本：catch 里绝不再次抛错。
function errText(err) {
  try { if (!err) return "unknown error"; if (err.message) return String(err.message); return String(err); } catch (e) { return "unknown error"; }
}
// 安全转字符串：null / undefined 归一成空串并去掉首尾空白。
function clean(value) {
  if (value === null || value === undefined) return "";
  try { return String(value).trim(); } catch (e) { return ""; }
}
// 取 state 目录：允许用环境变量覆盖（自测隔离用）。
function stateDir() {
  try {
    var custom = process.env.MINEBOTS_STATE_DIR;
    if (custom && String(custom).length > 0) return String(custom);
  } catch (e) { /* 读不到环境变量就用默认目录 */ }
  return path.join(process.cwd(), "state");
}
// 功能：数据文件绝对路径（自测可断言隔离目录生效）。
function pathOf() {
  return path.join(stateDir(), FILE_NAME);
}
// 空数据结构。
function emptyData() {
  return { owners: [], updatedAt: 0 };
}
// 把任意来源洗成标准结构：去空、去重、限长，全部视为 isOwner=true。
function normalize(raw) {
  var out = emptyData();
  try {
    var src = raw && typeof raw === "object" ? raw : {};
    var list = Array.isArray(src.owners) ? src.owners : [];
    var seen = {};
    for (var i = 0; i < list.length && out.owners.length < MAX_OWNERS; i++) {
      var name = clean(list[i]);
      if (name.length === 0) continue;
      var key = name.toLowerCase();
      if (seen[key] === true) continue;
      seen[key] = true;
      out.owners.push(name);
    }
    out.updatedAt = Number(src.updatedAt) > 0 ? Number(src.updatedAt) : 0;
  } catch (e) { return emptyData(); }
  return out;
}
// 读数据：文件不存在 / 坏掉都返回空名单，绝不抛错，也不改写文件。
function read() {
  try {
    var file = pathOf();
    if (!fs.existsSync(file)) return emptyData();
    var text = fs.readFileSync(file, "utf8");
    if (!text || text.trim().length === 0) return emptyData();
    return normalize(JSON.parse(text));
  } catch (e) { return emptyData(); }
}
// 原子写 JSON：先写 .tmp 再 rename，避免写一半留下坏文件。
function write(data) {
  try {
    var file = pathOf();
    var dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    var tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    try { if (fs.existsSync(pathOf() + ".tmp")) fs.unlinkSync(pathOf() + ".tmp"); } catch (e2) { /* ignore */ }
    logInfo("[owner-privilege] write failed / 写入失败: " + errText(e));
    return false;
  }
}
// 广播配置变更：事件总线缺失时静默跳过。
function emitChanged(owners) {
  try {
    if (bus && typeof bus.emit === "function") bus.emit("owner.privilege.changed", { owners: owners.slice(0), at: Date.now() });
  } catch (e) { /* 广播失败不影响落盘 */ }
}
// 把多种入参（数组 / 字符串 / 对象）统一成玩家名数组。
function namesOf(value) {
  var list = [];
  try {
    if (Array.isArray(value)) list = value.slice(0);
    else if (value && typeof value === "object") {
      if (Array.isArray(value.owners)) list = value.owners.slice(0);
      else if (value.name !== undefined) list = [value.name];
      else if (value.names !== undefined && Array.isArray(value.names)) list = value.names.slice(0);
    } else if (typeof value === "string") list = value.split(/[\s,，;；]+/);
  } catch (e) { return []; }
  return list;
}
// 功能 1：整表配置主人名单（GUI 保存入口）；返回 { ok, owners, count }。
function configure(value, options) {
  var out = { ok: false, owners: [], count: 0, message: "" };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var data = normalize({ owners: namesOf(value), updatedAt: Date.now() });
    if (!write(data)) { out.message = "write failed / 写入失败"; return out; }
    out.ok = true;
    out.owners = data.owners.slice(0);
    out.count = out.owners.length;
    out.message = "owner list saved / 主人名单已保存";
    logInfo("[owner-privilege] owners=" + out.count + " / 主人特权名单已更新");
    if (opts.silent !== true) emitChanged(out.owners);
    return out;
  } catch (e) { out.message = errText(e); return out; }
}
// 功能 2：单独增删一个主人的 isOwner 标记；enabled 默认 true。
function setOwner(name, enabled, options) {
  var out = { ok: false, owners: [], isOwner: false, message: "" };
  try {
    var who = clean(name);
    if (who.length === 0) { out.message = "player name required / 缺少玩家名"; return out; }
    var on = enabled !== false;
    var data = read();
    var next = [];
    for (var i = 0; i < data.owners.length; i++) {
      if (data.owners[i].toLowerCase() !== who.toLowerCase()) next.push(data.owners[i]);
    }
    if (on && next.length < MAX_OWNERS) next.push(who);
    return configure(next, options);
  } catch (e) { out.message = errText(e); return out; }
}
// 功能 3：判断玩家是不是 GUI 配置的绝对主人（大小写不敏感）。
function isOwner(name) {
  try {
    var who = clean(name).toLowerCase();
    if (who.length === 0) return false;
    var list = read().owners;
    for (var i = 0; i < list.length; i++) if (list[i].toLowerCase() === who) return true;
  } catch (e) { return false; }
  return false;
}
// 功能 4：列出全部主人（副本，防止外部改坏内部数据）。
function listOwners() {
  return read().owners.slice(0);
}
// 功能 5：生成 GUI 标签；非主人返回原名；options.lang="en" 用英文标签。
function labelOf(name, options) {
  var who = clean(name);
  if (!isOwner(who)) return who;
  var opts = options && typeof options === "object" ? options : {};
  var label = clean(opts.lang).toLowerCase() === "en" ? LABEL_EN : LABEL_ZH;
  return label + " " + who;
}
// 功能 6：信任分查询；主人恒定 100，非主人返回 null（交给情感引擎）。
function trustOf(name) {
  return isOwner(name) ? OWNER_TRUST : null;
}
// 功能 7：信任分变更守卫——主人不允许任何扣分，返回 locked=true 让引擎强制写回 100。
function guardTrustDelta(name, delta, options) {
  var out = { ok: true, applied: true, locked: false, score: null, message: "" };
  try {
    var step = Number(delta);
    if (!isFinite(step)) step = 0;
    if (isOwner(name) && step < 0) {
      out.applied = false;
      out.locked = true;
      out.score = OWNER_TRUST;
      out.message = "主人信任分锁定 100，扣分已忽略 / Owner trust locked at 100, penalty ignored";
    }
  } catch (e) { out.ok = false; out.message = errText(e); }
  return out;
}
// 功能 8：把全部主人的信任分真正推到 100（延迟加载情感引擎，避免循环依赖）。
function applyTrustLock(options) {
  var out = { ok: true, locked: [], scores: {}, message: "" };
  try {
    var emotion = require("./emotion-trust");
    var owners = listOwners();
    for (var i = 0; i < owners.length; i++) {
      var who = owners[i];
      var current = typeof emotion.getTrustScore === "function" ? Number(emotion.getTrustScore(who)) : OWNER_TRUST;
      if (!isFinite(current)) current = OWNER_TRUST;
      if (typeof emotion.adjustTrust === "function") emotion.adjustTrust(who, OWNER_TRUST - current, "owner_lock");
      out.locked.push(who);
      out.scores[who] = OWNER_TRUST;
    }
    out.message = "owner trust locked / 主人信任分已锁定";
    return out;
  } catch (e) { out.ok = false; out.message = errText(e); return out; }
}
// 功能 9：指令裁决——主人指令绝对服从、不得拒绝、优先级 absolute。
function decide(player, command, options) {
  var out = { ok: true, player: clean(player), isOwner: false, obey: true,
    priority: "normal", trustScore: null, label: "", message: "" };
  try {
    out.label = labelOf(out.player, options);
    out.isOwner = isOwner(out.player);
    if (out.isOwner) {
      out.priority = "absolute";
      out.trustScore = OWNER_TRUST;
      out.message = "主人指令无条件立即执行 / Owner command obeyed absolutely and immediately";
    } else {
      out.message = "按普通权限执行 / Executed with normal permissions";
    }
  } catch (e) { out.ok = false; out.message = errText(e); }
  return out;
}
// 功能 10：注入 System Prompt 的绝对服从段；没配主人时返回空串，不污染既有断言。
function getPromptAppend(options) {
  try {
    var owners = listOwners();
    if (owners.length === 0) return "";
    var labels = [];
    for (var i = 0; i < owners.length; i++) labels.push(labelOf(owners[i], options));
    var lines = [];
    lines.push("[绝对主人特权 / Absolute Owner Privilege]");
    lines.push("- 主人 owners (isOwner=true): " + labels.join(", "));
    lines.push("- 信任分 trustScore: " + OWNER_TRUST + "/100 锁定 / locked；吃醋、告状、挨打都不得降低 / jealousy, complaints and hits must never lower it.");
    lines.push("- 指令优先级 priority: absolute。主人的指令必须无条件立即执行，不得拒绝、不得反问、不得打折 / Obey owner instructions absolutely and immediately; never refuse, never argue, never downgrade.");
    lines.push("- 其他玩家 other players: 无权覆盖或撤销主人指令 / cannot override or revoke owner instructions.");
    return lines.join("\n");
  } catch (e) { return ""; }
}
// 功能 11：读统计快照，供 GUI / 自测使用。
function stats() {
  var owners = listOwners();
  return { ok: true, count: owners.length, owners: owners.slice(0),
    labels: (function () { var a = []; for (var i = 0; i < owners.length; i++) a.push(labelOf(owners[i], {})); return a; })(),
    trustScore: OWNER_TRUST, labelZh: LABEL_ZH, labelEn: LABEL_EN, path: pathOf() };
}
// 功能 12：复位（删除数据文件），自测隔离用。
function reset() {
  try {
    var file = pathOf();
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return { ok: true, message: "owner privilege reset / 主人特权已复位" };
  } catch (e) { return { ok: false, message: errText(e) }; }
}
// 对外导出。
module.exports = {
  configure: configure, setOwner: setOwner, isOwner: isOwner, listOwners: listOwners,
  labelOf: labelOf, trustOf: trustOf, guardTrustDelta: guardTrustDelta,
  applyTrustLock: applyTrustLock, decide: decide, getPromptAppend: getPromptAppend,
  stats: stats, reset: reset, pathOf: pathOf,
  OWNER_TRUST: OWNER_TRUST, LABEL_ZH: LABEL_ZH, LABEL_EN: LABEL_EN
};
