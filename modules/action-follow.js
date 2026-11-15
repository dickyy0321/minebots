// ========================================
// 文件：modules/action-follow.js
// 功能：跟随玩家——插件模式用官方 GoalFollow（2 格）+ 心跳督目标，无插件时退化「朝人走」
// 依赖：./pathfinding（可选）、mineflayer-pathfinder（可选）；其余基础函数由 actions.js 通过 ctx 注入
// 导出：followPlayer / followTick / armFollowGoal
// 作者：MineBots
// ========================================
//
// 为什么要单独一层：
//   跟随是唯一「长时间自己跑」的动作，逻辑最多也最容易和其它动作抢控制权；
//   收成独立文件后，actions.js 只负责 ctx 组装与抢占入口，两边都保持在 600 行以内。
//   ctx 里必须带：logInfo / notReady / badParam / failure / findEntity / posOf / isSelfEntity /
//   headPoint / horizontalSq / couldPathfind / startGaze / stopFollowTimer / pathfinding / pfLib / 跟随常量。
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

// 跟随心跳：插件模式只管「GoalFollow 挂得住」，退化模式每秒迈一步；两者都在 2 格以内站住。
function followTick(bot, state, ctx) {
  try {
    if (!bot || !bot.entity || bot._mbFollow !== state) { ctx.stopFollowTimer(bot, state); return; }
    var ent = ctx.findEntity(bot, state.target);
    if (!ent || ctx.isSelfEntity(bot, ent)) { if (state.mode !== "pathfinder") ctx.stopFollowTimer(bot, state); return; }
    var p = ctx.posOf(ent), me = ctx.posOf(bot.entity);
    if (!p || !me) return;
    var d2 = ctx.horizontalSq(p, me);
    if (d2 >= 0 && d2 <= state.distance * state.distance) {
      // 已经在 2 格以内：松手站住，别一直顶着玩家。
      state.stall = 0; if (typeof bot.clearControlStates === "function") bot.clearControlStates();
      return;
    }
    if (state.mode === "pathfinder") { armFollowGoal(bot, ent, state, ctx); return; }
    if (Date.now() - state.startedAt > ctx.FOLLOW_MAX_MS) { ctx.stopFollowTimer(bot, state); return; }
    if (typeof bot.setControlState === "function") bot.setControlState("forward", true);
  } catch (e1) { ctx.stopFollowTimer(bot, state); }
}

// 插件模式：目标丢了 / 连续两拍没进展就 arm 复位闸门再挂官方 GoalFollow（闸门没复位时 setGoal 会被当场抹掉）。
function armFollowGoal(bot, ent, state, ctx) {
  try {
    var moving = false, lost = true;
    try { if (typeof bot.pathfinder.isMoving === "function") moving = bot.pathfinder.isMoving() === true; } catch (e0) { moving = false; }
    try { lost = !bot.pathfinder.goal; } catch (e2) { lost = true; }
    if (moving) { state.stall = 0; return; }
    state.stall = state.stall + 1;
    if (!lost && state.stall < ctx.FOLLOW_REARM_TICKS) return;
    if (ctx.pathfinding && typeof ctx.pathfinding.arm === "function") ctx.pathfinding.arm(bot);
    bot.pathfinder.setGoal(new ctx.pfLib.goals.GoalFollow(ent, state.distance), true);
    state.stall = 0; state.rearm = state.rearm + 1;
    ctx.logInfo("[follow] follow re-arm " + state.target + " #" + state.rearm + " / 重新挂跟随目标");
  } catch (e3) { /* 下一拍再试 */ }
}

// 跟随玩家：有插件就用官方 GoalFollow（2 格）+ 心跳督目标；没插件才走退化跟随。
function followPlayer(bot, username, distance, ctx) {
  var action = "followPlayer";
  try {
    if (!bot) return ctx.notReady(action);
    var name = username ? String(username) : "";
    if (!name) return ctx.badParam(action, "username required / 缺少玩家名");
    var entity = ctx.findEntity(bot, name);
    if (!entity) return ctx.badParam(action, "player not found / 未找到玩家");
    if (ctx.isSelfEntity(bot, entity)) return ctx.badParam(action, "cannot follow myself / 不能跟随自己");
    var dist = Number(distance);
    if (isNaN(dist) || dist < 1) dist = ctx.FOLLOW_DISTANCE;
    if (dist > ctx.FOLLOW_DIST_MAX) dist = ctx.FOLLOW_DIST_MAX;
    // 新跟随先彻底清掉旧跟随（定时器 / 视线 / 前进键），不给自己留第二条循环。
    ctx.stopFollowTimer(bot);
    var state = { timer: null, startedAt: Date.now(), target: name, distance: dist, mode: "simple", stall: 0, rearm: 0 };
    bot._mbFollow = state;
    // 跟随也要「看着人走」：500ms 重新对准玩家的头（不是脚），插件寻路模式下同样生效。
    ctx.startGaze(bot, function () {
      var now = ctx.findEntity(bot, name);
      if (!now || ctx.isSelfEntity(bot, now)) return null;
      return ctx.headPoint(bot, now);
    });
    var me = ctx.posOf(bot.entity), target = ctx.posOf(entity);
    var d2 = me && target ? ctx.horizontalSq(target, me) : -1;
    var closeNow = d2 >= 0 && d2 <= dist * dist;
    if (ctx.couldPathfind(bot)) state.mode = "pathfinder";
    state.timer = setInterval(function () { followTick(bot, state, ctx); }, ctx.FOLLOW_TICK_MS);
    if (state.timer && state.timer.unref) state.timer.unref();
    if (!closeNow) followTick(bot, state, ctx); // 立刻挂一次目标 / 迈一步，别让用户等满一秒
    if (state.mode === "pathfinder") return { ok: true, action: action, mode: "pathfinder", target: name, distance: dist, close: closeNow };
    return { ok: true, action: action, mode: "simple", target: name, distance: dist, maxMs: ctx.FOLLOW_MAX_MS, close: closeNow };
  } catch (err) { return ctx.failure(action, err); }
}

// 对外导出：三个跟随入口，全部由 actions.js 传 ctx 调用。
module.exports = {
  followPlayer: followPlayer,
  followTick: followTick,
  armFollowGoal: armFollowGoal
};
