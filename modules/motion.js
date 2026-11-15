// ========================================
// 文件：modules/motion.js
// 功能：拟真动作层——分步缓转视角 / 加减速缓转 / 高斯噪声抖动 / 人类反应延迟 / 挖掘手部晃动 / 惯性收步；
//       engExactBuild 开启时全部噪声 / 手抖 / 随机延迟归零，供绝对精确建筑做毫米级放置
// 依赖：./engine-control（可选，控制中心缺失时按拟真开启处理）
// 导出：smoothLookAt、easeLookAt、easeStop、pause、cancelLook、startDigJitter、isLooking、wait、whenDone、
//       gaussianNoise、noisyPoint、humanDelayMs、humanDelay、clampedNoise、configure、getConfig、isEngineEnabled、
//       localDodge、localShield、attachReflex、detachReflex、reflexStats、isExactBuild、acceleration、
//       MIN_STEPS、MAX_STEPS、STEP_MS、ACTION_PAUSE_MS、ACTION_PAUSE_MAX_MS、GAUSSIAN_SIGMA
// 作者：MineBots
// ========================================
//
// 为什么要这一层：
//   bot.lookAt(pos, true) 是「瞬间贴脸转向」，人不会这么动；
//   这里把一次转向拆成 5~10 步、每步 50ms，逐步插值到目标点，看起来才像人在转头。
//   与 pathfinder 不冲突：本层只改视线，从不碰控制键 / 寻路目标。
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

// 常量：步数上下限 / 每步间隔 / 挖掘晃动节拍与幅度。
var MIN_STEPS = 2;
var MAX_STEPS = 10;
var DEFAULT_STEPS = 6;
var STEP_MS = 50;
var DIG_JITTER_MS = 180;
var DIG_JITTER_RANGE = 0.18;
// 常量：动作之间的停顿区间（100~200ms）——太短像机器，太长像卡住。
var ACTION_PAUSE_MS = 100;
var ACTION_PAUSE_MAX_MS = 200;
// 常量：拟真噪声——高斯分布默认 sigma（格）/ 噪声总开关与幅度（可通过 configure 调整）。
var GAUSSIAN_SIGMA = 0.06;
var HUMAN_DELAY_MIN_MS = 100;
var HUMAN_DELAY_MAX_MS = 200;
var NOISE_CONFIG = { enabled: true, sigma: GAUSSIAN_SIGMA };
// 可选依赖：引擎控制中心（专家模式可关拟真 / 调强度与延迟）；缺失时默认全开。
var engineControl = null;
try { engineControl = require("./engine-control"); } catch (e) { engineControl = null; }
// 可选依赖：动作微操（视线游移 / 偶尔轻跳 / 挖完环视），精确建筑模式下自动归零。
var microMotion = null;
try { microMotion = require("./motion-micro"); } catch (e) { microMotion = null; }

// 安全转数字：不是合法数字就给兜底值。
function toNumber(value, fallback) {
  var n = Number(value);
  return isNaN(n) ? fallback : n;
}

// 把异常拍成一行文本，避免在 catch 里再次抛错。
function errText(err) {
  try {
    if (!err) return "unknown error";
    if (err.message) return String(err.message);
    return String(err);
  } catch (e) { return "unknown error"; }
}

// 每步间隔的默认值：允许用环境变量 MINEBOTS_MOTION_STEP_MS 覆盖（自测里调小，跑得快）。
function defaultStepMs() {
  try {
    var fromEnv = Number(process.env.MINEBOTS_MOTION_STEP_MS);
    if (!isNaN(fromEnv) && fromEnv > 0) return Math.round(fromEnv);
  } catch (e) { /* 用常量默认值 */ }
  return STEP_MS;
}

// 睡眠指定毫秒；注意：await 等待的定时器**必须 ref**（否则事件循环一空，进程会提前退出）。
function sleep(ms) {
  return new Promise(function (resolve) {
    try { setTimeout(resolve, ms); } catch (e) { resolve(); }
  });
}

// 把 { x, y, z } / Vec3 统一成纯数字点；读不到返回 null。
function pointOf(target) {
  try {
    if (!target) return null;
    var x = toNumber(target.x, NaN);
    var y = toNumber(target.y, NaN);
    var z = toNumber(target.z, NaN);
    if (isNaN(x) || isNaN(y) || isNaN(z)) return null;
    return { x: x, y: y, z: z };
  } catch (e) { return null; }
}

// 用 bot 现有坐标实例派生一个真 Vec3（mineflayer 只认真 Vec3）；派生不了退回普通对象。
function vecOf(bot, point) {
  try {
    var base = bot && bot.entity ? bot.entity.position : null;
    if (base && typeof base.offset === "function") {
      return base.offset(point.x - toNumber(base.x, 0), point.y - toNumber(base.y, 0), point.z - toNumber(base.z, 0));
    }
  } catch (e) { /* 退回普通对象 */ }
  return { x: point.x, y: point.y, z: point.z };
}

// 两点之间线性插值（t 从 0 到 1）。
function lerp(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

// 读引擎开关：控制中心缺失或读失败时按开启处理，保证老调用方行为不变。
function isEngineEnabled() {
  try {
    if (engineControl && typeof engineControl.isEnabled === "function") return engineControl.isEnabled("motion") === true;
  } catch (e) { /* 读失败按开启 */ }
  return true;
}

// 可选依赖：精确建筑底层门面；缺失时加速度按 0（沿用老缓动）返回，绝不抛错。
var exactPlacement = null;
try { exactPlacement = require("./exact-placement"); } catch (e) { exactPlacement = null; }

// 读精确建筑开关：开启时所有噪声 / 抖动 / 随机延迟强制归零（控制中心缺失时按关闭，保持老行为）。
function isExactBuild() {
  try {
    if (engineControl && typeof engineControl.exactBuild === "function") return engineControl.exactBuild() === true;
  } catch (e) { /* 读失败按关闭 */ }
  return false;
}

// 移动加速度：精确建筑开启时拉满（1 = 瞬时满速、无加减速缓动），关闭时 0 表示沿用原曲线。
function acceleration() {
  try { if (exactPlacement && typeof exactPlacement.acceleration === "function") return exactPlacement.acceleration(); }
  catch (e) { /* 门面缺失按 0 */ }
  return 0;
}

// 读拟真强度倍率（1~10 级映射到 0.2~2.0 倍），面板默认 5 级恰好等于 1 倍。
function engineScale() {
  try {
    if (engineControl && typeof engineControl.param === "function") {
      var level = engineControl.param("motion", "motionStrength");
      if (level >= 1 && level <= 10) return level / 5;
    }
  } catch (e) { /* 读失败用 1 倍 */ }
  return 1;
}

// 读面板配置的动作延迟（毫秒）；读不到退回 150ms。
function engineDelayMs() {
  try {
    if (engineControl && typeof engineControl.param === "function") {
      var ms = engineControl.param("motion", "motionDelayMs");
      if (ms >= 50) return ms;
    }
  } catch (e) { /* 读失败用默认值 */ }
  return 150;
}

// 生成高斯噪声：Box-Muller 变换，输出截断到正负 3 倍 sigma；参数非法时返回 0。
function gaussianNoise(mean, sigma) {
  try {
    var mu = toNumber(mean, 0);
    var sd = toNumber(sigma, GAUSSIAN_SIGMA);
    if (isNaN(mu) || isNaN(sd) || sd <= 0) return mu;
    var u = Math.random();
    var v = Math.random();
    if (u < 1e-9) u = 1e-9;
    var z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    if (z > 3) z = 3;
    if (z < -3) z = -3;
    return mu + z * sd;
  } catch (e) { return 0; }
}

// 生成一段截断到正负 range 内的高斯抖动；引擎或噪声关掉时返回 0（自测可确定性关闭）。
function clampedNoise(range) {
  try {
    if (isExactBuild()) return 0; // 精确建筑：噪声绝对归零，不做任何随机采样。
    if (!NOISE_CONFIG.enabled || !isEngineEnabled()) return 0;
    var scale = engineScale();
    var limit = toNumber(range, DIG_JITTER_RANGE) * scale;
    if (isNaN(limit) || limit <= 0) return 0;
    var value = gaussianNoise(0, limit / 2);
    if (value > limit) return limit;
    if (value < -limit) return -limit;
    return value;
  } catch (e) { return 0; }
}

// 给一个三维点叠加高斯噪声；坐标读不出来时返回 null。
function noisyPoint(point, sigma) {
  var base = pointOf(point);
  if (!base) return null;
  if (isExactBuild()) return { x: base.x, y: base.y, z: base.z }; // 精确建筑：坐标零抖动。
  try {
    var sd = toNumber(sigma, NOISE_CONFIG.sigma);
    return {
      x: base.x + clampedNoise(sd * 3),
      y: base.y + clampedNoise(sd * 3 * 0.6),
      z: base.z + clampedNoise(sd * 3)
    };
  } catch (e) { return { x: base.x, y: base.y, z: base.z }; }
}

// 计算一段拟真随机延迟（毫秒）：以 baseMs 为下界，高斯抖动后截断到 spreadMs 范围内。
function humanDelayMs(baseMs, spreadMs) {
  try {
    var base = toNumber(baseMs, HUMAN_DELAY_MIN_MS);
    var spread = toNumber(spreadMs, HUMAN_DELAY_MAX_MS - HUMAN_DELAY_MIN_MS);
    if (isNaN(base) || base < 0) base = HUMAN_DELAY_MIN_MS;
    if (isNaN(spread) || spread < 0) spread = 0;
    if (isExactBuild()) return 0; // 精确建筑：随机延迟归零，放置指令立即执行。
    if (!NOISE_CONFIG.enabled || !isEngineEnabled()) return Math.round(base + spread / 2);
    var jitter = gaussianNoise(spread / 2, spread / 3 * engineScale());
    var ms = Math.round(base + jitter);
    if (ms < base) ms = Math.round(base);
    if (ms > base + spread) ms = Math.round(base + spread);
    return ms;
  } catch (e) { return HUMAN_DELAY_MIN_MS; }
}

// 等待一段拟真随机延迟，返回实际等待的毫秒数；await 期间定时器保持 ref，不拖死链路也不提前退出。
function humanDelay(baseMs, spreadMs) {
  var ms = humanDelayMs(baseMs, spreadMs);
  return sleep(ms).then(function () { return ms; });
}

// 设置拟真参数（enabled / sigma），返回当前配置副本；坏值忽略。
function configure(options) {
  try {
    var opts = options && typeof options === "object" ? options : {};
    if (typeof opts.enabled === "boolean") NOISE_CONFIG.enabled = opts.enabled;
    var sd = toNumber(opts.sigma, NaN);
    if (!isNaN(sd) && sd >= 0 && sd <= 2) NOISE_CONFIG.sigma = sd;
  } catch (e) { /* 坏配置不改现状 */ }
  return getConfig();
}

// 读取当前拟真配置副本（含专家面板的强度与延迟）。
function getConfig() {
  if (isExactBuild()) {
    return { enabled: false, sigma: 0, strength: 0, delayMs: 0, exactBuild: true, acceleration: acceleration() };
  }
  return {
    enabled: NOISE_CONFIG.enabled === true && isEngineEnabled(),
    sigma: NOISE_CONFIG.sigma,
    strength: engineScale() * 5,
    delayMs: engineDelayMs(),
    exactBuild: false,
    acceleration: acceleration()
  };
}

// 起点估计：优先上次真实看过的点，其次玩家当前朝向（yaw / pitch）推算，最后直接对准目标。
function startPointOf(bot, target) {
  var last = pointOf(bot ? bot._mbLookPoint : null);
  if (last) return last;
  try {
    var ent = bot && bot.entity ? bot.entity : null;
    var pos = ent ? pointOf(ent.position) : null;
    var yaw = ent ? toNumber(ent.yaw, NaN) : NaN;
    var pitch = ent ? toNumber(ent.pitch, NaN) : NaN;
    if (pos && !isNaN(yaw) && !isNaN(pitch)) {
      var dist = 4;
      return {
        x: pos.x - Math.sin(yaw) * Math.cos(pitch) * dist,
        y: pos.y + 1.62 - Math.sin(pitch) * dist,
        z: pos.z - Math.cos(yaw) * Math.cos(pitch) * dist
      };
    }
  } catch (e) { /* 退回目标点 */ }
  return { x: target.x, y: target.y, z: target.z };
}

// 功能 1：分步缓转——steps 步、每步 stepMs 毫秒，逐步逼近目标点；被 cancelLook / 更新的转向抢占就立刻中止。
// 返回 { ok, steps, aborted, message }；bot 没有 lookAt 时返回 ok=false，绝不抛错。
async function smoothLookAt(bot, target, steps, options) {
  var wanted = pointOf(target);
  if (!bot || typeof bot.lookAt !== "function") {
    return { ok: false, steps: 0, aborted: false, message: "lookAt unavailable / 机器人不支持转向" };
  }
  if (!wanted) return { ok: false, steps: 0, aborted: false, message: "bad target / 目标坐标非法" };
  var opts = options && typeof options === "object" ? options : {};
  var total = Math.round(toNumber(steps, DEFAULT_STEPS));
  if (isNaN(total) || total < MIN_STEPS) total = DEFAULT_STEPS;
  if (total > MAX_STEPS) total = MAX_STEPS;
  var stepMs = Math.round(toNumber(opts.stepMs, 0));
  if (isNaN(stepMs) || stepMs <= 0) stepMs = defaultStepMs();
  if (stepMs < 1) stepMs = 1;
  if (stepMs > 400) stepMs = 400;
  if (isExactBuild()) { total = 1; stepMs = 1; } // 精确建筑：一步瞬时对准，视线零过渡。
  var seq = toNumber(bot._mbLookSeq, 0) + 1;
  bot._mbLookSeq = seq;
  var start = startPointOf(bot, wanted);
  var done = 0;
  for (var i = 1; i <= total; i++) {
    if (bot._mbLookSeq !== seq) return { ok: true, steps: done, aborted: true, message: "cancelled / 已中止" };
    var point = i === total ? wanted : lerp(start, wanted, i / total);
    try {
      var running = bot.lookAt(vecOf(bot, point), true);
      // 等这一步真的转完再走下一步：既像人转头，也保证多个动作之间的视线不会互相踩。
      if (running && typeof running.then === "function") {
        await running.then(function () { return null; }, function () { return null; });
      }
    } catch (err) {
      return { ok: done > 0, steps: done, aborted: false, message: errText(err) };
    }
    bot._mbLookPoint = point;
    done = i;
    if (i < total) await sleep(stepMs);
  }
  return { ok: true, steps: done, aborted: false, message: "" };
}

// 功能 2：取消所有进行中的转向——序号 +1，正在跑的分步转向下一拍就会自己退出。
function cancelLook(bot) {
  try {
    if (!bot) return false;
    bot._mbLookSeq = toNumber(bot._mbLookSeq, 0) + 1;
    // 顺手丢掉「上次看过哪」：留着它，下一次分步缓转就会从那个点（往往是挖方块时的脚下）出发，
    // 视觉上就是「转头转一半突然卡在盯地面」。清掉之后会按当前 yaw/pitch 重新起算。
    bot._mbLookPoint = null;
    return true;
  } catch (e) { return false; }
}

// 功能 3：挖掘手部晃动——每 180ms 在当前视线附近做 2 步小抖动（±0.18 格），像真人挖东西时手在动。
// 返回 { stop(), count() }：定时器一律 unref，绝不让进程挂在挖掘上。
function startDigJitter(bot, options) {
  var state = { timer: null, count: 0 };
  var opts = options && typeof options === "object" ? options : {};
  var every = Math.round(toNumber(opts.everyMs, DIG_JITTER_MS));
  if (isNaN(every) || every < 60) every = DIG_JITTER_MS;
  // 精确建筑：完全不启动手抖定时器，避免任何视线偏移。
  if (isExactBuild()) return { stop: function () { return 0; }, count: function () { return 0; } };
  try {
    if (!bot || typeof bot.lookAt !== "function") {
      return { stop: function () { return 0; }, count: function () { return 0; } };
    }
    state.timer = setInterval(function () {
      try {
        var base = pointOf(bot._mbLookPoint);
        if (!base) {
          var ent = bot.entity ? pointOf(bot.entity.position) : null;
          if (!ent) return;
          base = { x: ent.x, y: ent.y + 1.6, z: ent.z + 3 };
        }
        state.count = state.count + 1;
        // 高斯噪声替代均匀分布：抖动集中在零点附近、偶尔大幅偏移，更像真人手腕。
        var jitter = {
          x: base.x + clampedNoise(DIG_JITTER_RANGE),
          y: base.y + clampedNoise(DIG_JITTER_RANGE * 0.6),
          z: base.z + clampedNoise(DIG_JITTER_RANGE)
        };
        smoothLookAt(bot, jitter, 2, { stepMs: 35 });
      } catch (e1) { /* 目标没了就等下一拍 */ }
    }, every);
    try { if (state.timer && state.timer.unref) state.timer.unref(); } catch (e2) { /* ignore */ }
  } catch (e) { state.timer = null; }
  return {
    stop: function () {
      try { if (state.timer) clearInterval(state.timer); } catch (e3) { /* ignore */ }
      state.timer = null;
      // 收手时把正在进行的抖动转向也取消，别让它和新动作的视线打架。
      try { cancelLook(bot); } catch (e4) { /* ignore */ }
      return state.count;
    },
    count: function () { return state.count; }
  };
}

// 功能 4：当前是否正在转向（给测试 / 诊断用），读不到返回 false。
function isLooking(bot) {
  try { return !!(bot && typeof bot._mbLookSeq === "number" && bot._mbLookSeq > 0); }
  catch (e) { return false; }
}

// 功能 5：公用小睡（动作之间的节奏用，如两次挥手的间隔）——timer 一律 unref。
function wait(ms) {
  return sleep(Math.round(toNumber(ms, STEP_MS)));
}

// 功能 6：把「长动作 Promise」和「收手回调」绑在一起——动作成功 / 失败都会调 stop，绝不留下晃动的视线。
function whenDone(promise, stop) {
  var finish = function (value) {
    try { if (typeof stop === "function") stop(); } catch (e) { /* 收手失败就算了 */ }
    return value;
  };
  try { return Promise.resolve(promise).then(finish, finish); }
  catch (e2) { return Promise.resolve(promise); }
}

// 功能 7：带加减速的缓转——转头「先慢、中间快、最后慢」，比匀速更像真人（平滑过渡）。
// 返回 { ok, steps, aborted, message }；bot 没有 lookAt 时返回 ok=false，绝不抛错。
async function easeLookAt(bot, target, steps, options) {
  var out = { ok: false, steps: 0, aborted: false, message: "lookAt unavailable / 无法转向" };
  try {
    if (!bot || typeof bot.lookAt !== "function") return out;
    var point = pointOf(target);
    if (!point) { out.message = "bad target / 目标点非法"; return out; }
    var opts = options && typeof options === "object" ? options : {};
    var total = Math.round(toNumber(steps, DEFAULT_STEPS));
    if (isNaN(total) || total < MIN_STEPS) total = MIN_STEPS;
    if (total > MAX_STEPS) total = MAX_STEPS;
    if (isExactBuild()) total = 1; // 精确建筑：缓转压成单步，不对放置坐标做插值。
    var base = Math.round(toNumber(opts.stepMs, defaultStepMs()));
    if (isNaN(base) || base <= 0) base = STEP_MS;
    var seq = toNumber(bot._mbLookSeq, 0);
    cancelLook(bot);           // 抢占上一次转向
    seq = toNumber(bot._mbLookSeq, 0);
    var start = startPointOf(bot, point);
    var done = 0;
    for (var i = 1; i <= total; i++) {
      if (toNumber(bot._mbLookSeq, 0) !== seq) { out.ok = done > 0; out.steps = done; out.aborted = true; out.message = "superseded / 已被新的转向接管"; return out; }
      var t = i / total;
      // 速度曲线：两端 0.5 倍、中间 1.5 倍速，用正弦做加减速，视线不会「一甩就到位」。
      var speed = 0.5 + Math.sin(Math.PI * t) * 1.0;
      var stepMs = Math.max(20, Math.round(base / speed));
      try {
        var running = bot.lookAt(vecOf(bot, lerp(start, point, t)), true);
        if (running && typeof running.then === "function") {
          await running.then(function () { return null; }, function () { return null; });
        }
      } catch (err) {
        out.ok = done > 0; out.steps = done; out.message = errText(err); return out;
      }
      bot._mbLookPoint = lerp(start, point, t);
      done = i;
      if (i < total) await sleep(stepMs);
    }
    out.ok = true; out.steps = done; out.message = ""; return out;
  } catch (err) {
    out.message = errText(err);
    return out;
  }
}

// 功能 8：惯性收步——先让当前按键再保持 ms 毫秒，然后才松开，避免「说停就钉在原地」。
// 返回松开前保持的毫秒数；bot 不支持控制键时返回 0。
async function easeStop(bot, ms) {
  try {
    if (!bot || typeof bot.clearControlStates !== "function") return 0;
    var hold = Math.round(toNumber(ms, ACTION_PAUSE_MS));
    if (isNaN(hold) || hold < 0) hold = ACTION_PAUSE_MS;
    if (hold > 0) await sleep(hold);
    try { bot.clearControlStates(); } catch (e1) { /* 松开失败就算了 */ }
    return hold;
  } catch (e) { return 0; }
}

// 功能 9：动作之间的小停顿（默认 100~200ms 高斯随机，基准来自专家面板的动作延迟）。
function pause() {
  var base = engineDelayMs() - (HUMAN_DELAY_MIN_MS - ACTION_PAUSE_MS);
  if (base < 0) base = 0;
  return sleep(humanDelayMs(base, ACTION_PAUSE_MAX_MS - ACTION_PAUSE_MS));
}

// 常量：反射层节流窗口（毫秒）/ 运动学原始监听表（毫秒级，不发任何网络请求）。
var REFLEX_THROTTLE_MS = 120;
var reflexSessions = [];

// 安全地写一个控制状态位；bot 缺失或 API 不存在时返回 false，异常不外抛。
function setControlState(bot, name, on) {
  try {
    if (!bot || typeof bot.setControlState !== "function") return false;
    bot.setControlState(name, on === true);
    return true;
  } catch (e) { return false; }
}

// 功能 10：本地闪避——横移 + 跳跃 + 高斯手抖，全程同步完成，绝不 await 网络或 AI。
function localDodge(bot, options) {
  var opts = options && typeof options === "object" ? options : {};
  var started = Date.now();
  try {
    var side = opts.direction === "left" ? "left" : "right";
    var moved = setControlState(bot, side, true);
    var jumped = setControlState(bot, "jump", true);
    var jitter = clampedNoise(DIG_JITTER_RANGE);
    setControlState(bot, side, false);
    setControlState(bot, "jump", false);
    return { ok: true, action: "local_dodge", direction: side, jitter: jitter,
      moved: moved, jumped: jumped, latencyMs: Date.now() - started, message: "dodge done / 已本地闪避" };
  } catch (e) {
    return { ok: false, action: "local_dodge", latencyMs: Date.now() - started, message: String(e && e.message ? e.message : e) };
  }
}

// 功能 11：本地举盾——激活副手并短暂潜行；没有盾也安全返回 ok:true（已尽力防御）。
function localShield(bot, options) {
  var started = Date.now();
  try {
    var blocked = false;
    try {
      if (bot && typeof bot.activateItem === "function") { bot.activateItem(true); blocked = true; }
    } catch (eItem) { blocked = false; }
    setControlState(bot, "sneak", true);
    setControlState(bot, "sneak", false);
    return { ok: true, action: "local_shield", blocked: blocked,
      latencyMs: Date.now() - started, message: "shield done / 已本地举盾" };
  } catch (e) {
    return { ok: false, action: "local_shield", latencyMs: Date.now() - started, message: String(e && e.message ? e.message : e) };
  }
}

// 功能 12：在运动学层直接监听 entityHurt 与 physicsTick（反射层原始入口，不经过 AI）。
function attachReflex(bot, options) {
  var opts = options && typeof options === "object" ? options : {};
  try {
    if (!bot || typeof bot.on !== "function") return { ok: false, message: "bot not ready / 机器人未就绪" };
    detachReflex(bot);
    var session = { bot: bot, lastAt: 0, hurts: 0, physics: 0, actions: [] };
    session.onHurt = function (payload) {
      var now = Date.now();
      if (now - session.lastAt < REFLEX_THROTTLE_MS) return;
      session.lastAt = now;
      session.hurts = session.hurts + 1;
      var low = Number(bot.health) <= 8;
      var forced = payload && payload.action ? String(payload.action) : "";
      var useShield = forced === "local_shield" || (forced === "" && low);
      var res = useShield ? localShield(bot) : localDodge(bot);
      session.actions.push(res.action);
      if (opts.onHurt && typeof opts.onHurt === "function") {
        try { opts.onHurt(res); } catch (eHook) { /* 钩子报错不影响反射 */ }
      }
    };
    session.onPhysics = function () { session.physics = session.physics + 1; try { if (microMotion) microMotion.walkTick(bot, bot.username || "default"); } catch (eMicro) { /* 微操失败不影响反射 */ } };
    try { bot.on("entityHurt", session.onHurt); } catch (e1) { /* 单事件挂不上不影响另一个 */ }
    try { bot.on("physicsTick", session.onPhysics); } catch (e2) { /* 同上 */ }
    reflexSessions.push(session);
    return { ok: true, events: 2, message: "reflex attached / 运动学反射已挂载" };
  } catch (e) {
    return { ok: false, message: String(e && e.message ? e.message : e) };
  }
}

// 功能 13：摘掉某个 bot 的运动学反射监听，返回摘掉的会话数。
function detachReflex(bot) {
  var n = 0;
  try {
    for (var i = reflexSessions.length - 1; i >= 0; i--) {
      var s = reflexSessions[i];
      if (bot && s.bot !== bot) continue;
      try { if (s.bot && typeof s.bot.removeListener === "function") s.bot.removeListener("entityHurt", s.onHurt); } catch (e1) { /* ignore */ }
      try { if (s.bot && typeof s.bot.removeListener === "function") s.bot.removeListener("physicsTick", s.onPhysics); } catch (e2) { /* ignore */ }
      reflexSessions.splice(i, 1);
      n = n + 1;
    }
  } catch (e) { /* ignore */ }
  return { ok: true, removed: n, message: "reflex detached / 运动学反射已卸载" };
}

// 功能 14：读运动学反射统计（无会话返回零值），供自测与蜂群面板使用。
function reflexStats(bot) {
  try {
    for (var i = 0; i < reflexSessions.length; i++) {
      var s = reflexSessions[i];
      if (bot && s.bot !== bot) continue;
      return { ok: true, hurts: s.hurts, physics: s.physics, actions: s.actions.slice(0), attached: true };
    }
  } catch (e) { /* 返回零值 */ }
  return { ok: true, hurts: 0, physics: 0, actions: [], attached: false };
}

// 对外导出：缓转 / 取消 / 挖掘晃动 / 减速收步 / 动作停顿 / 反射原语 / 状态 + 常量（自测断言用）。
module.exports = {
  smoothLookAt: smoothLookAt,
  easeLookAt: easeLookAt,
  easeStop: easeStop,
  pause: pause,
  cancelLook: cancelLook,
  startDigJitter: startDigJitter,
  isLooking: isLooking,
  wait: wait,
  whenDone: whenDone,
  gaussianNoise: gaussianNoise,
  clampedNoise: clampedNoise,
  noisyPoint: noisyPoint,
  humanDelayMs: humanDelayMs,
  humanDelay: humanDelay,
  configure: configure,
  getConfig: getConfig,
  isEngineEnabled: isEngineEnabled,
  isExactBuild: isExactBuild,
  acceleration: acceleration,
  localDodge: localDodge,
  localShield: localShield,
  attachReflex: attachReflex,
  detachReflex: detachReflex,
  reflexStats: reflexStats,
  REFLEX_THROTTLE_MS: REFLEX_THROTTLE_MS,
  GAUSSIAN_SIGMA: GAUSSIAN_SIGMA,
  DIG_JITTER_MS: DIG_JITTER_MS,
  MIN_STEPS: MIN_STEPS,
  MAX_STEPS: MAX_STEPS,
  STEP_MS: STEP_MS,
  ACTION_PAUSE_MS: ACTION_PAUSE_MS,
  ACTION_PAUSE_MAX_MS: ACTION_PAUSE_MAX_MS
};
