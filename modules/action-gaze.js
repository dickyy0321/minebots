// ========================================
// 文件：modules/action-gaze.js
// 功能：视线心跳——每 500ms 重新对准一次目标（分步缓转），停止时连同「看过的低处坐标」一起清空
// 依赖：./motion（可选，缺失时退回瞬间 lookAt）
// 导出：startGaze / stopGaze / GAZE_TICK_MS
// 作者：MineBots
// ========================================
//
// 为什么单独一层：
//   「只看不走」= 木头人，「转头转一半被抢占」= 盯着地面。把视线心跳收成一个文件，
//   actions.js 只管在动作开始 / 结束 / 被抢占时调 startGaze / stopGaze，逻辑不再散落。
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

// 可选依赖：拟真动作层（分步缓转）；缺失时退回瞬间 lookAt。
var motion = null;
try { motion = require("./motion"); } catch (e) { motion = null; }

// 常量：视线心跳间隔——500ms 重新对准一次目标就活了。
var GAZE_TICK_MS = 500;

// 清掉视线定时器：传 want 只清自己那一个，避免误杀新动作刚起的眼睛；返回是否真的清掉了。
function stopGaze(bot, want) {
  try {
    if (!bot) return false;
    var state = bot._mbGaze || null;
    if (!state) return false;
    if (want && state !== want) return false;
    try { if (state.timer) clearInterval(state.timer); } catch (e1) { /* ignore */ }
    bot._mbGaze = null;
    // 顺手把「转头转了一半」和「上次看过的低处坐标」一起清掉：
    // 留着它，下一次分步缓转就会从那个（往往是脚底的）点出发，看起来就是在盯地面。
    try { if (motion && typeof motion.cancelLook === "function") motion.cancelLook(bot); } catch (e2) { /* ignore */ }
    try { bot._mbLookPoint = null; } catch (e3) { /* ignore */ }
    return true;
  } catch (err) { return false; }
}

// 启动视线心跳：每 ms 毫秒调一次 pick() 拿目标点再看过去；返回状态对象或 null（不支持时）。
function startGaze(bot, pick, ms) {
  stopGaze(bot);
  try {
    if (!bot || typeof bot.lookAt !== "function" || typeof pick !== "function") return null;
    var every = Number(ms);
    if (isNaN(every) || every <= 0) every = GAZE_TICK_MS;
    var state = { timer: null, pick: pick };
    state.timer = setInterval(function () {
      try {
        var pos = pick();
        if (!pos) return;
        // 分两步缓转（2 步 × 60ms）：不再「瞬间贴脸」，也不会和下一个心跳重叠。
        if (motion && typeof motion.smoothLookAt === "function") motion.smoothLookAt(bot, pos, 2, { stepMs: 60 });
        else {
          var running = bot.lookAt(pos, true);
          if (running && typeof running.catch === "function") running.catch(function () { return null; });
        }
      } catch (e1) { /* 目标跑了就等下一拍 */ }
    }, every);
    if (state.timer && state.timer.unref) state.timer.unref();
    bot._mbGaze = state;
    return state;
  } catch (err) { return null; }
}

// 对外导出：启动 / 停止 / 节拍常量。
module.exports = {
  startGaze: startGaze,
  stopGaze: stopGaze,
  GAZE_TICK_MS: GAZE_TICK_MS
};
