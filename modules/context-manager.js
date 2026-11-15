// ========================================
// 文件：modules/context-manager.js
// 功能：上下文记忆——永久 / 临时两个列表的读写，以及拼进 system prompt 的追加文本；
//       情感与信任 2.0 的 trustScore / memories / 血量饥饿也在此汇入 system prompt
// 依赖：fs / path（原子写入）；./logger、./emotion-trust（均可选，缺失时安全降级）
// 导出：loadContext、addContext、removeContext、clearTemporary、getSystemPromptAppend
// 作者：MineBots
// ========================================
//
// 数据文件：state/context-permanent.json、state/context-temporary.json
//   列表元素：{ "text": "记住：基地在 100,64,200", "createdAt": "2026-01-01T00:00:00.000Z" }
// 永久 = 一直生效；临时 = 可一键清空（clearTemporary）。两者都进 getSystemPromptAppend()。
// 情感段来自 ./emotion-trust.getPromptAppend()：只有发生过情感写操作才非空，
//   因此未激活时本函数返回值逐字不变，既有精确断言不受影响。
// 测试隔离：环境变量 MINEBOTS_STATE_DIR 可替换 state 目录（自测用临时目录，不碰真实数据）。
// ES5 风格，CommonJS，无中文变量名

var fs = require("fs");
var path = require("path");
// 可选依赖：日志核心；缺失时退回 console。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }
// 可选依赖：情感与信任 2.0；缺失或读失败时 system prompt 只带上下文记忆，绝不阻断对话。
var emotion = null;
try { emotion = require("./emotion-trust"); } catch (e) { emotion = null; }
// 可选依赖：绝对主人特权；没配主人时返回空串，既有精确断言逐字不变。
var ownerPrivilege = null;
try { ownerPrivilege = require("./owner-privilege"); } catch (e) { ownerPrivilege = null; }
// 两种模式常量：除 "permanent" 之外一律按临时处理（对旧调用方宽容）。
var MODE_PERMANENT = "permanent";
var MODE_TEMPORARY = "temporary";
// 单条上下文长度上限：防止把整篇文档塞进 prompt。
var MAX_TEXT_LENGTH = 4000;

// 写日志：优先 logger.system，缺失时静默（上下文操作本身有返回值）。
function logSystem(message) {
  try {
    if (logger && typeof logger.system === "function") logger.system(message);
  } catch (e) { /* 日志失败不影响业务 */ }
}

// 安全取错误文本：catch 里再抛错就破红线了。
function getErrText(err) {
  try {
    if (!err) return "unknown error";
    if (err.message) return String(err.message);
    return String(err);
  } catch (e) { return "unknown error"; }
}

// 取 state 目录：允许用环境变量 MINEBOTS_STATE_DIR 覆盖（自测隔离用）。
function stateDir() {
  try {
    var custom = process.env.MINEBOTS_STATE_DIR;
    if (custom && String(custom).length > 0) return String(custom);
  } catch (e) { /* 读不到环境变量就用默认目录 */ }
  return path.join(process.cwd(), "state");
}

// 某个模式的上下文文件路径。
function contextFile(mode) {
  var name = mode === MODE_PERMANENT ? "context-permanent.json" : "context-temporary.json";
  return path.join(stateDir(), name);
}

// 原子写 JSON：先写同目录的 .tmp，再 rename 覆盖，避免写一半留下坏文件。
function writeJsonAtomic(file, data) {
  try {
    var dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    var tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    try { if (fs.existsSync(file + ".tmp")) fs.unlinkSync(file + ".tmp"); } catch (e) { /* 清不掉就算了 */ }
    logSystem("[context-manager] write failed: " + getErrText(err));
    return false;
  }
}

// 读一个列表文件：不存在 / 坏掉都返回空数组，绝不抛错，也不改写文件。
function readList(mode) {
  try {
    var file = contextFile(mode);
    if (!fs.existsSync(file)) return [];
    var text = fs.readFileSync(file, "utf8");
    if (!text || text.trim().length === 0) return [];
    var raw = JSON.parse(text);
    return normalizeList(raw);
  } catch (err) {
    logSystem("[context-manager] read failed: " + getErrText(err));
    return [];
  }
}

// 把任意来源洗成标准列表：只留非空 text，createdAt 非法就补当前时间。
function normalizeList(raw) {
  var out = [];
  if (!Array.isArray(raw)) return out;
  for (var i = 0; i < raw.length; i++) {
    var item = raw[i];
    var text = "";
    var createdAt = "";
    if (typeof item === "string") {
      text = item;
    } else if (item && typeof item === "object") {
      if (item.text !== null && item.text !== undefined) text = String(item.text);
      if (item.createdAt !== null && item.createdAt !== undefined) createdAt = String(item.createdAt);
    }
    text = text.trim();
    if (text.length === 0) continue;
    if (text.length > MAX_TEXT_LENGTH) text = text.substring(0, MAX_TEXT_LENGTH);
    if (createdAt.length === 0) createdAt = new Date().toISOString();
    out.push({ text: text, createdAt: createdAt });
  }
  return out;
}

// 功能 1：一次读回两个列表：{ permanent: [...], temporary: [...] }；任何异常都退化成空列表。
function loadContext() {
  try {
    return { permanent: readList(MODE_PERMANENT), temporary: readList(MODE_TEMPORARY) };
  } catch (err) {
    logSystem("[context-manager] loadContext failed: " + getErrText(err));
    return { permanent: [], temporary: [] };
  }
}

// 功能 2：追加一条上下文；mode 不是 "permanent" 就按临时处理。空文本返回 { ok:false }。
function addContext(text, mode) {
  try {
    var body = "";
    if (text !== null && text !== undefined) body = String(text);
    body = body.trim();
    if (body.length === 0) return { ok: false, message: "empty text / 空文本" };
    if (body.length > MAX_TEXT_LENGTH) body = body.substring(0, MAX_TEXT_LENGTH);
    var target = mode === MODE_PERMANENT ? MODE_PERMANENT : MODE_TEMPORARY;
    var list = readList(target);
    list.push({ text: body, createdAt: new Date().toISOString() });
    if (!writeJsonAtomic(contextFile(target), list)) return { ok: false, message: "write failed / 写入失败" };
    logSystem("Context added (" + target + "): " + body.substring(0, 60));
    return { ok: true, mode: target, count: list.length };
  } catch (err) {
    logSystem("[context-manager] addContext failed: " + getErrText(err));
    return { ok: false, message: getErrText(err) };
  }
}

// 功能 3：按序号删一条；序号非法返回 { ok:false }，成功返回删掉的内容。
function removeContext(index, mode) {
  try {
    var target = mode === MODE_PERMANENT ? MODE_PERMANENT : MODE_TEMPORARY;
    var pos = parseInt(index, 10);
    if (isNaN(pos)) return { ok: false, message: "index must be a number / 序号必须是数字" };
    var list = readList(target);
    if (pos < 0 || pos >= list.length) {
      return { ok: false, message: "index out of range / 序号越界：" + pos };
    }
    var removed = list.splice(pos, 1)[0];
    if (!writeJsonAtomic(contextFile(target), list)) return { ok: false, message: "write failed / 写入失败" };
    logSystem("Context removed (" + target + "): " + removed.text.substring(0, 60));
    return { ok: true, removed: removed.text, count: list.length };
  } catch (err) {
    logSystem("[context-manager] removeContext failed: " + getErrText(err));
    return { ok: false, message: getErrText(err) };
  }
}

// 功能 4：清空临时上下文（永久的不动）。
function clearTemporary() {
  try {
    if (!writeJsonAtomic(contextFile(MODE_TEMPORARY), [])) return { ok: false, message: "write failed / 写入失败" };
    logSystem("Temporary context cleared.");
    return { ok: true };
  } catch (err) {
    logSystem("[context-manager] clearTemporary failed: " + getErrText(err));
    return { ok: false, message: getErrText(err) };
  }
}

// 功能 5：拼 system prompt 追加文本：永久在前、临时在后，每行 "- 内容"；
//         末尾追加情感段（trustScore / memories / 血量饥饿）；全空时返回空串。
function getSystemPromptAppend() {
  try {
    var all = readList(MODE_PERMANENT).concat(readList(MODE_TEMPORARY));
    var lines = [];
    for (var i = 0; i < all.length; i++) lines.push("- " + all[i].text);
    // 情感段只在引擎已激活时非空；任何异常都静默降级，不影响对话与自检断言。
    try {
      if (emotion && typeof emotion.getPromptAppend === "function") {
        var emo = String(emotion.getPromptAppend() || "");
        if (emo.length > 0) lines.push(emo);
      }
    } catch (eEmo) { /* 情感段读失败就只带上下文记忆 */ }
    // 主人特权段：只有 GUI 配了 isOwner=true 才有内容，保证 AI 绝对服从。
    try {
      if (ownerPrivilege && typeof ownerPrivilege.getPromptAppend === "function") {
        var own = String(ownerPrivilege.getPromptAppend() || "");
        if (own.length > 0) lines.push(own);
      }
    } catch (eOwner) { /* 特权段读失败不影响对话 */ }
    if (lines.length === 0) return "";
    return lines.join("\n");
  } catch (err) {
    logSystem("[context-manager] getSystemPromptAppend failed: " + getErrText(err));
    return "";
  }
}

// 对外导出：读 / 加 / 删 / 清临时 / 拼 prompt。
module.exports = {
  loadContext: loadContext,
  addContext: addContext,
  removeContext: removeContext,
  clearTemporary: clearTemporary,
  getSystemPromptAppend: getSystemPromptAppend
};

