// ========================================
// 文件：modules/manual-control.js
// 功能：手动驾驶——把 GUI 的按键（左手 I/J/K/L 前进后退左右移、U 跳、O/P 抬头低头、H 攻击、Y 使用、快捷栏 1-9）翻译成 mineflayer 控制指令
// 依赖：./logger（可选，缺失退回 console）
// 导出：CONTROLS / ACTIONS / KEYS / isControl / keyToControl / press / releaseAll / look / hotbar / attack / use / handle
// 作者：MineBots
// ========================================
//
// 约定：
//   1. 只做「翻译 + 转发」，不自己判胜负、不自己寻路；按下就发，松开必须发 releaseAll。
//   2. bot 未就绪一律返回 { ok:false, message:"bot not ready / 机器人未就绪" }，绝不抛错。
//   3. 真 bot 与测试模式假 bot 走同一套接口，假 bot 没实现的接口只降级成 ok:false。
// ES5 风格，CommonJS，无中文变量名
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：mineflayer 认识的 7 个控制位（顺序即 GUI 按键顺序）。
var CONTROLS = ["forward", "back", "left", "right", "jump", "sneak", "sprint"];
// 常量：本模块支持的全部子动作名。
var ACTIONS = ["press", "release", "look", "hotbar", "attack", "use"];
// 常量：视角俯仰的合法区间（弧度，约 -90 度 ~ +90 度）。
var PITCH_LIMIT = Math.PI / 2;
// 常量：手动攻击时找目标的搜索半径（格）。
var ATTACK_RADIUS = 4;
// 常量：左手键位表——全部避开原版 WASD（原版键位照常可用，不被抢占）：
//   I 前进 / K 后退 / J 左移 / L 右移 / U 跳跃 / O 抬头 / P 低头 / H 攻击 / Y 使用。
var KEYS = {
  i: "forward", k: "back", j: "left", l: "right",
  u: "jump", o: "lookUp", p: "lookDown",
  h: "attack", y: "use"
};

// 安全提取错误文本，catch 里不会二次抛错。
function getErrText(err) {
  try {
    if (!err) return "unknown error";
    if (err.message) return String(err.message);
    return String(err);
  } catch (e) { return "unknown error"; }
}

// 转文本（null / undefined → 空串）并去首尾空白。
function toText(value) {
  try {
    if (value === null || value === undefined) return "";
    return String(value).replace(/^\s+|\s+$/g, "");
  } catch (e) { return ""; }
}

// 转数字（非法值返回兜底值）。
function toNum(value, fallback) {
  try {
    var n = parseFloat(toText(value));
    return isNaN(n) ? fallback : n;
  } catch (e) { return fallback; }
}

// 写文件日志：手动按键是高频信息，只落文件不推 GUI。
function logInfo(msg) {
  try {
    if (logger && typeof logger.info === "function") { logger.info("[manual-control] " + msg); return; }
  } catch (e) { /* 退回 console */ }
  try { console.log("[manual-control] " + msg); } catch (e2) { /* ignore */ }
}

// 统一失败回包（永不抛出）。
function fail(action, message) {
  return { ok: false, action: toText(action), message: toText(message) };
}

// 判断按键名是否属于 7 个控制位（大小写 / 空白不敏感）。
function isControl(key) {
  return CONTROLS.indexOf(toText(key).toLowerCase()) >= 0;
}

// 功能 1：按下一个控制位 / 松开一个控制位；成功返回 { ok:true, key, on }。
function press(bot, key, on) {
  var name = toText(key).toLowerCase();
  if (!bot) return fail("press", "bot not ready / 机器人未就绪");
  if (!isControl(name)) return fail("press", "未知按键 / unknown key: " + name);
  if (typeof bot.setControlState !== "function") return fail("press", "bot 不支持手动控制 / manual control unsupported");
  var down = on === true;
  try {
    bot.setControlState(name, down);
    return { ok: true, action: "press", key: name, on: down, message: (down ? "已按下 / pressed: " : "已松开 / released: ") + name };
  } catch (err) {
    logInfo("按键失败 / press failed: " + name + " " + getErrText(err));
    return fail("press", "按键失败 / press failed: " + getErrText(err));
  }
}

// 功能 2：松开全部控制位（GUI 松开按钮 / 切换 bot / 关闭面板都必须调它，避免一直往前走）。
function releaseAll(bot) {
  if (!bot) return fail("release", "bot not ready / 机器人未就绪");
  try {
    if (typeof bot.clearControlStates === "function") {
      bot.clearControlStates();
      return { ok: true, action: "release", message: "已松开全部按键 / all controls released" };
    }
    if (typeof bot.setControlState === "function") {
      for (var i = 0; i < CONTROLS.length; i++) bot.setControlState(CONTROLS[i], false);
      return { ok: true, action: "release", message: "已松开全部按键 / all controls released" };
    }
  } catch (err) {
    logInfo("松开按键失败 / release failed: " + getErrText(err));
    return fail("release", "松开按键失败 / release failed: " + getErrText(err));
  }
  return fail("release", "bot 不支持手动控制 / manual control unsupported");
}

// 功能 3：设置视角（yaw / pitch 弧度，俯仰自动夹到 ±90 度）。
function look(bot, yaw, pitch) {
  if (!bot) return fail("look", "bot not ready / 机器人未就绪");
  var y = toNum(yaw, NaN);
  var p = toNum(pitch, NaN);
  if (isNaN(y) || isNaN(p)) return fail("look", "yaw / pitch 必须是数字 / yaw and pitch must be numbers");
  if (typeof bot.look !== "function") return fail("look", "bot 不支持视角控制 / look unsupported");
  if (p > PITCH_LIMIT) p = PITCH_LIMIT;
  if (p < -PITCH_LIMIT) p = -PITCH_LIMIT;
  try {
    var res = bot.look(y, p, true);
    if (res && typeof res.catch === "function") res.catch(function () { return null; });
    return { ok: true, action: "look", yaw: y, pitch: p, message: "视角已转向 / look applied" };
  } catch (err) {
    logInfo("转视角失败 / look failed: " + getErrText(err));
    return fail("look", "转视角失败 / look failed: " + getErrText(err));
  }
}

// 功能 4：切换快捷栏槽位（0~8，对应键盘 1~9）。
function hotbar(bot, slot) {
  if (!bot) return fail("hotbar", "bot not ready / 机器人未就绪");
  var idx = Math.round(toNum(slot, NaN));
  if (isNaN(idx) || idx < 0 || idx > 8) return fail("hotbar", "槽位必须是 0-8 / slot must be 0-8: " + toText(slot));
  try {
    if (typeof bot.setQuickBarSlot === "function") bot.setQuickBarSlot(idx);
    else if (typeof bot.quickBarSlot !== "undefined") bot.quickBarSlot = idx;
    else return fail("hotbar", "bot 不支持快捷栏 / hotbar unsupported");
    return { ok: true, action: "hotbar", slot: idx, message: "快捷栏切到 / hotbar slot " + (idx + 1) };
  } catch (err) {
    logInfo("切快捷栏失败 / hotbar failed: " + getErrText(err));
    return fail("hotbar", "切快捷栏失败 / hotbar failed: " + getErrText(err));
  }
}

// 内部：在 ATTACK_RADIUS 内找最近的生物 / 玩家（找不到返回 null）。
function nearestTarget(bot) {
  var best = null, bestDistance = Infinity;
  try {
    if (!bot || !bot.entity || !bot.entity.position || !bot.entities) return null;
    var me = bot.entity.position;
    var keys = Object.keys(bot.entities);
    for (var i = 0; i < keys.length; i++) {
      var ent = bot.entities[keys[i]];
      if (!ent || ent === bot.entity || !ent.position) continue;
      var isPlayer = !!ent.username;
      var isMob = (ent.type === "mob" || ent.type === "hostile" || ent.type === "animal");
      if (!isPlayer && !isMob) continue;
      var dx = toNum(ent.position.x, 0) - toNum(me.x, 0);
      var dy = toNum(ent.position.y, 0) - toNum(me.y, 0);
      var dz = toNum(ent.position.z, 0) - toNum(me.z, 0);
      var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > ATTACK_RADIUS || d >= bestDistance) continue;
      bestDistance = d;
      best = ent;
    }
  } catch (e) { return null; }
  return best;
}

// 功能 5：手动攻击最近的生物 / 玩家（顺带挥一下手，客户端表现才正常）。
function attack(bot) {
  if (!bot) return fail("attack", "bot not ready / 机器人未就绪");
  if (typeof bot.attack !== "function") return fail("attack", "bot 不支持攻击 / attack unsupported");
  var target = nearestTarget(bot);
  if (!target) return fail("attack", "附近没有可攻击目标 / no target nearby");
  try {
    bot.attack(target);
    if (typeof bot.swingArm === "function") bot.swingArm("right");
    var name = toText(target.username || target.name || target.displayName) || "entity";
    return { ok: true, action: "attack", target: name, message: "已攻击 / attacked: " + name };
  } catch (err) {
    logInfo("攻击失败 / attack failed: " + getErrText(err));
    return fail("attack", "攻击失败 / attack failed: " + getErrText(err));
  }
}

// 功能 6：使用手上的物品 / 右键（放方块、吃东西、拉弓都走这个）。
function use(bot) {
  if (!bot) return fail("use", "bot not ready / 机器人未就绪");
  if (typeof bot.activateItem !== "function") return fail("use", "bot 不支持使用物品 / use unsupported");
  try {
    bot.activateItem();
    return { ok: true, action: "use", message: "已使用手上物品 / used held item" };
  } catch (err) {
    logInfo("使用物品失败 / use failed: " + getErrText(err));
    return fail("use", "使用物品失败 / use failed: " + getErrText(err));
  }
}

// 功能 7：统一入口——GUI 只发 { action, key, on, yaw, pitch, slot }，这里分派到上面的实现。
function handle(bot, payload) {
  var p = (payload && typeof payload === "object") ? payload : {};
  var action = toText(p.action).toLowerCase();
  if (action.length === 0) action = "press";
  if (!bot) return fail(action, "bot not ready / 机器人未就绪");
  try {
    if (action === "press") return press(bot, p.key, p.on === true || p.on === "true");
    if (action === "release") return releaseAll(bot);
    if (action === "look") return look(bot, p.yaw, p.pitch);
    if (action === "hotbar") return hotbar(bot, p.slot);
    if (action === "attack") return attack(bot);
    if (action === "use") return use(bot);
  } catch (err) {
    logInfo("手动控制异常 / manual control failed: " + getErrText(err));
    return fail(action, "手动控制异常 / manual control failed: " + getErrText(err));
  }
  return fail(action, "未知手动动作 / unknown manual action: " + action);
}

// 把键盘字符翻成控制位：{ control, action, key }；方向键类（O / P / H / Y）control 为空串。
function keyToControl(key) {
  var k = toText(key).toLowerCase();
  var hit = KEYS[k] || "";
  if (hit.length === 0) return { control: "", action: "", key: k };
  if (CONTROLS.indexOf(hit) >= 0) return { control: hit, action: "press", key: k };
  return { control: "", action: hit, key: k };
}

// 对外导出：控制位清单 / 子动作清单 / 左手键位表 / 键位翻译 / 各子动作实现 / 统一入口。
module.exports = {
  CONTROLS: CONTROLS,
  ACTIONS: ACTIONS,
  KEYS: KEYS,
  isControl: isControl,
  keyToControl: keyToControl,
  press: press,
  releaseAll: releaseAll,
  look: look,
  hotbar: hotbar,
  attack: attack,
  use: use,
  handle: handle
};
