// ========================================
// 文件：modules/task-queue.js
// 功能：任务队列——按 bot 维护队列 / 顺序执行 / 单任务 10 秒超时 / 失败重试 3 次 / 边做边播报
// 依赖：./logger（可选）、./task-narration（可选，缺了就闭嘴）
// 导出：addTask / getQueue / clearQueue / clearLeftovers / isLongTask / queueKey / runQueue / narrate / getNarrateState / resetNarrate
// 作者：MineBots
// ========================================

// 可选依赖：日志模块，只用 info / warn；缺失时全部静默。
var logger = null;
try { logger = require("./logger"); } catch (err) { logger = null; }
// 可选依赖：任务播报（内置模板 + 8 秒冷却 + 失败只报一次）；缺失时整个队列静默。
var narration = null;
try { narration = require("./task-narration"); } catch (err2) { narration = null; }

// 常量：单任务超时上限（毫秒）。
var TASK_TIMEOUT_MS = 10000;
// 常量：失败后额外重试的次数（首次不算重试）。
var RETRY_LIMIT = 3;
// 常量：单个 bot 的队列长度上限，防止任务灌爆内存。
var MAX_QUEUE = 100;
// 常量：长线任务——只有它们允许在队列里排队等（follow 要一直挂在身上跑，不能被新指令顺手清掉）。
var LONG_ACTIONS = ["follow"];

// 状态：botId -> 任务数组；数组顺序就是执行顺序。
var queues = {};
// 状态：botId -> 是否正在执行（true 时拒绝第二次 runQueue）。
var running = {};
// 状态：任务编号自增计数器。
var seq = 0;

// 写普通信息日志：只落文件，不推 GUI。
function logInfo(message) {
  try {
    if (logger && typeof logger.info === "function") logger.info(message);
  } catch (err) { /* ignore */ }
}

// 写警告日志（双语），推 GUI 便于用户看到队列失败。
function logWarn(message) {
  try {
    if (logger && typeof logger.warn === "function") logger.warn(message);
    else console.warn(message);
  } catch (err) { /* ignore */ }
}

// 把异常对象拍成一行文本，保证 message 永远是字符串。
function errText(err) {
  try {
    if (!err) return "unknown error / 未知错误";
    if (typeof err === "string") return err;
    if (err.message) return String(err.message);
    return String(err);
  } catch (e) { return "unknown error / 未知错误"; }
}

// 功能 5：任务播报（委托 ./task-narration）；模块缺失 / bot 没挂上时静默，绝不抛错。
function narrate(bot, botId, kind, extra) {
  try {
    if (!narration || typeof narration.announce !== "function") return { ok: false, sent: false, reason: "unavailable" };
    return narration.announce(bot, botId, kind, extra);
  } catch (err) { return { ok: false, sent: false, reason: errText(err) }; }
}

// 功能 6：读播报状态（自测 / 诊断用；没有播报模块时返回 null）。
function getNarrateState(bot) {
  try { return narration && typeof narration.getState === "function" ? narration.getState(bot) : null; }
  catch (err) { return null; }
}

// 功能 7：清空播报状态（重连 / 自测隔离用），成功返回 true。
function resetNarrate(bot) {
  try { return narration && typeof narration.reset === "function" ? narration.reset(bot) : false; }
  catch (err) { return false; }
}

// 生成任务编号：时间戳 36 进制 + 自增序号，保证同一进程内唯一。
function nextId() {
  try {
    seq = seq + 1;
    return "task-" + Date.now().toString(36) + "-" + seq;
  } catch (err) {
    seq = seq + 1;
    return "task-" + seq;
  }
}

// 取（必要时创建）某个 bot 的队列数组；始终返回同一个数组引用。
function ensureQueue(botId) {
  try {
    var id = String(botId);
    if (!queues[id]) queues[id] = [];
    return queues[id];
  } catch (err) { return []; }
}

// 深拷贝一份任务对象，避免外部改到队列里的活数据。
function cloneTask(task) {
  try {
    if (!task) return null;
    var out = { id: task.id, action: task.action, status: task.status, attempts: task.attempts, error: task.error, timeout: task.timeout };
    out.params = {};
    var src = task.params || {};
    for (var k in src) {
      if (Object.prototype.hasOwnProperty.call(src, k)) out.params[k] = src[k];
    }
    return out;
  } catch (err) { return null; }
}

// 拷贝整个任务数组，丢弃空项。
function cloneList(list) {
  var out = [];
  try {
    var src = list || [];
    for (var i = 0; i < src.length; i++) {
      var item = cloneTask(src[i]);
      if (item) out.push(item);
    }
  } catch (err) { /* ignore */ }
  return out;
}

// 把执行函数的返回值归一化：undefined / 无 ok 字段都视为成功。
function normalizeResult(res) {
  try {
    if (res === undefined || res === null) return { ok: true };
    if (typeof res === "boolean") return { ok: res };
    if (typeof res === "object") {
      if (typeof res.ok === "boolean") return res;
      return { ok: true, value: res };
    }
    return { ok: true, value: res };
  } catch (err) {
    return { ok: false, message: errText(err) };
  }
}
// 把一条任务推进队列：action 必填，params 归一化成对象；队列满或参数非法时回失败体。
function addTask(botId, task) {
  try {
    if (!botId) return { ok: false, action: "addTask", message: "botId required / 缺少机器人 id" };
    if (!task || typeof task !== "object") {
      return { ok: false, action: "addTask", message: "task required / 缺少任务对象" };
    }
    var action = task.action ? String(task.action) : "";
    if (!action) return { ok: false, action: "addTask", message: "task.action required / 缺少动作名" };
    // 新指令清场：不是长线任务（follow）就先把排队旧任务全部扔掉，跑完这条立刻回空闲。
    var cleared = clearLeftovers(botId, action).cleared;
    var list = ensureQueue(botId);
    if (list.length >= MAX_QUEUE) {
      return { ok: false, action: "addTask", message: "queue full / 队列已满" };
    }
    var params = {};
    if (task.params && typeof task.params === "object") {
      for (var k in task.params) {
        if (Object.prototype.hasOwnProperty.call(task.params, k)) params[k] = task.params[k];
      }
    }
    var item = {
      id: nextId(),
      action: action,
      params: params,
      status: "pending",
      attempts: 0,
      error: ""
    };
    // 允许单任务自定义超时（毫秒），不传就用 10 秒默认值。
    var custom = Number(task.timeout);
    if (!isNaN(custom) && custom > 0) item.timeout = custom;
    list.push(item);
    logInfo("[task-queue] add " + action + " -> " + String(botId) + " (size " + list.length + ", cleared " + cleared + ") / 任务已入队");
    return { ok: true, id: item.id, action: action, botId: String(botId), size: list.length, position: list.length - 1, cleared: cleared };
  } catch (err) {
    logWarn("[task-queue] addTask -> failed / 入队失败: " + errText(err));
    return { ok: false, action: "addTask", message: errText(err) };
  }
}

// 查队列：传 botId 返回该 bot 的任务数组副本；不传则返回 { ok, total, bots } 汇总。
function getQueue(botId) {
  try {
    if (botId) return cloneList(ensureQueue(botId));
    var out = { ok: true, total: 0, bots: {} };
    for (var id in queues) {
      if (!Object.prototype.hasOwnProperty.call(queues, id)) continue;
      var list = queues[id] || [];
      out.bots[id] = list.length;
      out.total = out.total + list.length;
    }
    return out;
  } catch (err) {
    logWarn("[task-queue] getQueue -> failed / 查询失败: " + errText(err));
    return [];
  }
}

// 清空队列：传 botId 只清该 bot（原地清空，正在跑的 runQueue 立刻停下）；不传清全部。
function clearQueue(botId) {
  try {
    if (botId) {
      var id = String(botId);
      var list = queues[id] || [];
      var cleared = list.length;
      for (var i = 0; i < list.length; i++) {
        try { list[i].status = "cancelled"; } catch (e1) { /* ignore */ }
      }
      list.length = 0;
      running[id] = false;
      logInfo("[task-queue] clear " + id + " (" + cleared + ") / 队列已清空");
      return { ok: true, botId: id, cleared: cleared };
    }
    var total = 0;
    var bots = 0;
    for (var key in queues) {
      if (!Object.prototype.hasOwnProperty.call(queues, key)) continue;
      total = total + (queues[key] ? queues[key].length : 0);
      queues[key] = [];
      running[key] = false;
      bots = bots + 1;
    }
    logInfo("[task-queue] clear all (" + total + ") / 全部队列已清空");
    return { ok: true, cleared: total, bots: bots };
  } catch (err) {
    logWarn("[task-queue] clearQueue -> failed / 清空失败: " + errText(err));
    return { ok: false, message: errText(err) };
  }
}
// 取队列键：字符串直接用；bot 对象优先 _mbBotId（管理器 id），再退回 username / id；取不到返回空串。
function queueKey(target) {
  try {
    if (!target) return "";
    if (typeof target === "string") return target;
    if (target._mbBotId) return String(target._mbBotId);
    if (target.username) return String(target.username);
    if (target.id !== undefined && target.id !== null) return String(target.id);
  } catch (err) { /* 取不到就当没有 */ }
  return "";
}

// 判断是不是长线任务（follow）：只有长线任务允许在队列里排队等，其它指令一到旧的就该收工。
function isLongTask(action) {
  try {
    var name = action ? String(action).toLowerCase().trim() : "";
    for (var i = 0; i < LONG_ACTIONS.length; i++) if (LONG_ACTIONS[i] === name) return true;
  } catch (err) { /* 判不出来就当不是长线任务 */ }
  return false;
}

// 新指令清场：新指令不是长线任务时，把该 bot 遗留的排队任务全部扔掉（正在跑的那条跑完就回空闲）。
// target 可以是 botId 或 bot 对象；返回 { ok, cleared }，bot 缺失时跳过，绝不抛错。
function clearLeftovers(target, action) {
  try {
    var id = queueKey(target);
    if (!id) return { ok: true, cleared: 0, skipped: "no-bot" };
    if (isLongTask(action)) return { ok: true, cleared: 0, skipped: "long-task" };
    var res = clearQueue(id);
    var dropped = res && res.cleared ? res.cleared : 0;
    if (dropped > 0) logInfo("[task-queue] 新指令清场 " + id + " -> " + String(action) + " / dropped " + dropped + " stale tasks");
    return { ok: res && res.ok === true, cleared: dropped };
  } catch (err) { return { ok: false, cleared: 0, message: errText(err) }; }
}

// 按顺序执行队列：上一个完成才跑下一个，单任务 10 秒超时，失败重试 3 次，永远 resolve。
function runQueue(botId, botInstance, executeFn) {
  return new Promise(function (resolve) {
    var id = "";
    try {
      if (!botId) {
        resolve({ ok: false, action: "runQueue", message: "botId required / 缺少机器人 id" });
        return;
      }
      id = String(botId);
      if (typeof executeFn !== "function") {
        resolve({ ok: false, action: "runQueue", botId: id, message: "executeFn required / 缺少执行函数" });
        return;
      }
      if (running[id] === true) {
        resolve({ ok: false, action: "runQueue", botId: id, message: "queue already running / 队列正在执行" });
        return;
      }
      running[id] = true;
      var list = ensureQueue(id);
      var runId = "run-" + id + "-" + Date.now().toString(36); // 播报去重用的轮次号：同一轮失败只报一次
      var prevAction = ""; // 上一个执行过的动作：只有「关键步骤切换」才播报，别每一步都喊
      narrate(botInstance, id, "accept", { action: list.length > 0 ? list[0].action : "all", runId: runId });
      var results = [];
      var succeeded = 0;
      var failed = 0;

      // 执行一次任务：超时 / 抛错 / reject 全部收敛成 { ok:false } 结果。
      function runOnce(task) {
        return new Promise(function (done) {
          var finished = false;
          var limit = Number(task.timeout);
          if (isNaN(limit) || limit <= 0) limit = TASK_TIMEOUT_MS;
          var timer = setTimeout(function () {
            if (finished) return;
            finished = true;
            done({ ok: false, code: "TIMEOUT", message: "task timeout / 任务超时" });
          }, limit);
          if (timer && timer.unref) timer.unref();
          var out = null;
          try {
            out = executeFn(task, botInstance);
          } catch (err) {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            done({ ok: false, code: "THROW", message: errText(err) });
            return;
          }
          Promise.resolve(out).then(function (res) {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            done(normalizeResult(res));
          }, function (err) {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            done({ ok: false, code: "REJECT", message: errText(err) });
          });
        });
      }

      // 带重试执行：首次 + 重试 3 次；只有拿到 ok 才算成功。
      function runWithRetry(task, callback) {
        var attempt = 0;
        function tryOnce() {
          attempt = attempt + 1;
          task.attempts = attempt;
          task.status = "running";
          runOnce(task).then(function (res) {
            if (res && res.ok === true) { callback(true, res, attempt); return; }
            if (attempt <= RETRY_LIMIT) { tryOnce(); return; }
            callback(false, res, attempt);
          }, function (err) {
            if (attempt <= RETRY_LIMIT) { tryOnce(); return; }
            callback(false, { ok: false, message: errText(err) }, attempt);
          });
        }
        tryOnce();
      }

      // 组装最终汇总：全部成功才算 ok。
      function summary() {
        return {
          ok: failed === 0, action: "runQueue", botId: id,
          total: results.length, succeeded: succeeded, failed: failed, results: results
        };
      }

      // 取下一个任务执行（取走即出队）；队列清空或执行标记被清掉时立刻收尾。
      function next() {
        try {
          if (running[id] !== true) { resolve(summary()); return; }
          if (list.length === 0) {
            running[id] = false;
            logInfo("[task-queue] " + id + " done: ok " + succeeded + " / failed " + failed + " / 队列执行完毕");
            narrate(botInstance, id, "done", { action: "all", runId: runId });
            resolve(summary());
            return;
          }
          var task = list.shift();
          if (!task) { next(); return; }
          if (task.status === "cancelled") { next(); return; }
          // 关键步骤切换才播报：同一个动作连续做（比如连挖十块木头）不再重复喊。
          if (task.action !== prevAction) {
            narrate(botInstance, id, "step", { action: task.action, runId: runId });
            prevAction = task.action;
          }
          runWithRetry(task, function (ok, res, attempt) {
            try {
              task.attempts = attempt;
              task.status = ok ? "done" : "failed";
              task.error = ok ? "" : (res && res.message ? String(res.message) : "");
              results.push({ id: task.id, action: task.action, ok: ok, attempts: attempt, result: res });
              if (ok) { succeeded = succeeded + 1; narrate(botInstance, id, "done", { action: task.action, runId: runId }); }
              else {
                failed = failed + 1;
                narrate(botInstance, id, "error", { action: task.action, runId: runId });
                logWarn("[task-queue] " + task.action + " failed after " + attempt + " attempts / 任务重试后仍失败");
              }
            } catch (e1) { /* ignore */ }
            next();
          });
        } catch (err) {
          running[id] = false;
          resolve({ ok: false, action: "runQueue", botId: id, message: errText(err), results: results });
        }
      }

      next();
    } catch (err) {
      try { if (id) running[id] = false; } catch (e1) { /* ignore */ }
      resolve({ ok: false, action: "runQueue", botId: id, message: errText(err) });
    }
  });
}

// 对外导出：加任务 / 查队列 / 清队列 / 跑队列 / 播报（自测要能直接验冷却与去重）。
module.exports = {
  addTask: addTask,
  getQueue: getQueue,
  clearQueue: clearQueue,
  clearLeftovers: clearLeftovers,
  isLongTask: isLongTask,
  queueKey: queueKey,
  runQueue: runQueue,
  narrate: narrate,
  getNarrateState: getNarrateState,
  resetNarrate: resetNarrate
};
