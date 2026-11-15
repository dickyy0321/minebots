// ========================================
// 文件：modules/intent-parser.js
// 功能：指令语法解析器——把一行文字解析成可执行的动作对象
// 依赖：./logger（可选，失败退回 console）；无其它外部依赖
// 导出：parse、parseAction、parseJoinOut、validateTime、formatError
// 兼容：parseMany、parseSwitch、parseSchedule、parseClock、parseDuration、parseRange、closest
// 作者：MineBots
// ========================================
//
// 支持的语法（与 GUI 语法窗口一致）/ supported syntax
//   1. 通用 / general : action, range, time, back x y z（逗号分隔，后三项可省略）
//   2. 砍树 / dig_tree: dig_tree / dig_tree, blocks=10 / dig_tree, blocks=10, oak / ...wood=oak
//   3. 挖矿 / mine    : mine / mine, blocks=10 / mine, blocks=10, (iron) / ...(iron), (gold)
//   4. 跟随 / follow  : follow, Steve / follow, Steve, Alex
//   5. 停止 / stop    : stop
//   6. 定时 / schedule: join 9:00 AM, out 5:00 PM（AM/PM 前必须有空格；起始必须早于结束）
//   7. 开关 / switches: test mode on / hive mind off / ai code on ...（只能 on|off）
//   范围用 *（× 会自动换成 *）；识别不了会报错，并给出最接近的几条写法。
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers
"use strict";

// 可选依赖：日志核心；缺失时退回 console，绝不崩。
var logger = null;
try { logger = require("./logger"); } catch (e) { logger = null; }

// 常量：开关指令关键字（动作键 → 写法），与 GUI 高级面板一致。
var SWITCH_KEYS = [
  { key: "test_mode", words: ["test mode", "测试模式"] },
  { key: "hive_mind", words: ["hive mind", "蜂群思维"] },
  { key: "ai_code", words: ["ai code", "ai 代码"] },
  { key: "bot_chat", words: ["bot chat", "机器人聊天"] },
  { key: "typing", words: ["typing", "打字"] },
  { key: "voice", words: ["voice", "语音"] }
];

// 常量：合法动作名（不在这张表里的动作一律跳过，越野车不崩）。
var ACTION_WORDS = [
  "dig_tree", "mine", "follow", "stop", "move", "attack", "attack_all",
  "collect", "place", "craft"
];

// 常量：不需要额外参数的动作。
var PLAIN_ACTIONS = ["stop", "collect", "place", "craft"];

// 常量：报错建议池（closest 从这里挑最接近的写法）。
var SUGGEST_POOL = ACTION_WORDS.concat([
  "dig_tree, blocks=10, oak", "mine, blocks=10, (iron)", "follow, Steve",
  "move, 10 64 10", "back 10 64 10", "attack_all, range=5*5",
  "join 9:00 AM, out 5:00 PM", "test mode on", "hive mind off", "ai code on"
]);

// 常量：正则（每条只管一个片段，保持单一职责）。
var JOIN_RE = /^join\s+([\s\S]+)$/i;
var OUT_RE = /^out\s+([\s\S]+)$/i;
var CLOCK_RE = /^(\d{1,2}):(\d{2})\s+(AM|PM)$/i;
var CLOCK_TIGHT_RE = /^(\d{1,2}):(\d{2})(AM|PM)$/i;
var DURATION_RE = /^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i;
var RANGE_RE = /^(\d+)\s*[*x]\s*(\d+)$/;
var BACK_RE = /^back\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)$/i;
var BLOCKS_RE = /^blocks\s*=\s*(\d+)$/i;
var WOOD_RE = /^wood\s*=\s*([A-Za-z_][A-Za-z0-9_]*)$/;
var ORE_RE = /^\(([^()]+)\)$/;
var TIME_SEG_RE = /^time\s*=\s*(.+)$/i;
var RANGE_SEG_RE = /^range\s*=\s*(.+)$/i;
var PLAYER_SEG_RE = /^player\s*=\s*(.+)$/i;
var COORD_SEG_RE = /^(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)$/;

// 常量：时长单位换算（秒）。
var DURATION_UNITS = {
  ms: 0.001, s: 1, sec: 1, second: 1, m: 60, min: 60, minute: 60,
  h: 3600, hr: 3600, hour: 3600, d: 86400, day: 86400
};

// 常量：默认攻击范围（attack_all 没写 range 时用）。
var DEFAULT_ATTACK_RANGE = "5*5";

// 写告警日志：优先 logger.warn，失败退回 console，绝不抛错。
function logWarn(message) {
  try {
    if (logger && typeof logger.warn === "function") logger.warn(message);
    else console.warn(message);
  } catch (e) { /* 日志失败不影响解析 */ }
}

// 安全取错误文本：catch 里再抛错就破红线了。
function getErrText(err) {
  try {
    if (!err) return "unknown error";
    if (err.message) return String(err.message);
    return String(err);
  } catch (e) { return "unknown error"; }
}

// 安全转字符串：null / undefined 统一成空串。
function toText(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

// 空值判定：去掉所有空白后为空即为空。
function isBlank(value) {
  return toText(value).replace(/\s+/g, "") === "";
}

// 全角 × 统一成 *，方便范围解析。
function normalizeSymbols(text) {
  return toText(text).replace(/×/g, "*");
}

// 按逗号切段：去掉两端空白与空段。
function splitSegments(text) {
  return normalizeSymbols(text).split(",").map(function (part) {
    return part.trim();
  }).filter(function (part) {
    return part.length > 0;
  });
}

// 编辑距离：给「你是不是想输入」提示用。
function editDistance(a, b) {
  var left = toText(a).toLowerCase();
  var right = toText(b).toLowerCase();
  var rows = left.length + 1;
  var cols = right.length + 1;
  var grid = [];
  var i = 0;
  var j = 0;
  for (i = 0; i < rows; i++) { grid[i] = [i]; }
  for (j = 0; j < cols; j++) { grid[0][j] = j; }
  for (i = 1; i < rows; i++) {
    for (j = 1; j < cols; j++) {
      var cost = left.charAt(i - 1) === right.charAt(j - 1) ? 0 : 1;
      grid[i][j] = Math.min(grid[i - 1][j] + 1, grid[i][j - 1] + 1, grid[i - 1][j - 1] + cost);
    }
  }
  return grid[rows - 1][cols - 1];
}

// 取最接近的几条写法（前缀命中优先）。
function closest(text, limit) {
  var wanted = toText(text).trim().toLowerCase();
  var scored = SUGGEST_POOL.map(function (item) {
    var lower = item.toLowerCase();
    var score = editDistance(wanted, lower);
    if (wanted.length > 0 && lower.indexOf(wanted) === 0) score -= 3;
    else if (wanted.length > 1 && lower.indexOf(wanted) >= 0) score -= 1;
    return { item: item, score: score };
  });
  scored.sort(function (a, b) { return a.score - b.score; });
  return scored.slice(0, limit || 3).map(function (entry) { return entry.item; });
}

// 失败结果：{ ok:false, error:{ code, zh, en, suggestions } }。
function fail(code, zh, en, suggestions) {
  return { ok: false, error: { code: code, zh: zh, en: en, suggestions: suggestions || [] } };
}

// 成功结果：扁平展开（ok 为真，isJoinOut 默认 false）。
function pass(fields) {
  var out = fields || {};
  out.ok = true;
  if (out.isJoinOut === undefined) out.isJoinOut = false;
  return out;
}

// 小时内分钟数：用来比较两个时刻的先后。
function clockToMinutes(hour, minute) {
  return hour * 60 + minute;
}

// 时刻解析：9:00 AM → { text, hour, minute, minutes }；非法返回 null（12 AM = 0 点，12 PM = 12 点）。
function parseClock(text) {
  var raw = toText(text).trim();
  var hit = CLOCK_RE.exec(raw);
  if (!hit) return null;
  var hour12 = parseInt(hit[1], 10);
  var minute = parseInt(hit[2], 10);
  if (hour12 < 1 || hour12 > 12 || minute < 0 || minute > 59) return null;
  var meridiem = hit[3].toUpperCase();
  var hour = hour12 % 12;
  if (meridiem === "PM") hour += 12;
  return {
    text: raw, hour: hour, minute: minute, meridiem: meridiem,
    minutes: clockToMinutes(hour, minute)
  };
}

// 时长解析：10s / 2h / 30m → { text, seconds }；非法返回 null。
function parseDuration(text) {
  var raw = toText(text).trim();
  var hit = DURATION_RE.exec(raw);
  if (!hit) return null;
  var unit = hit[2].toLowerCase();
  if (DURATION_UNITS[unit] === undefined && unit.length > 1 && unit.charAt(unit.length - 1) === "s") {
    unit = unit.slice(0, -1);
  }
  if (DURATION_UNITS[unit] === undefined) return null;
  var value = parseFloat(hit[1]);
  return { text: raw, value: value, unit: unit, seconds: Math.round(value * DURATION_UNITS[unit]) };
}

// 范围解析：5*5 / 10 → { text, width, depth }；非法返回 null。
function parseRange(text) {
  var raw = normalizeSymbols(text).trim();
  var hit = RANGE_RE.exec(raw);
  if (hit) return { text: raw, width: parseInt(hit[1], 10), depth: parseInt(hit[2], 10) };
  var single = /^(\d+)$/.exec(raw);
  if (single) {
    var size = parseInt(single[1], 10);
    return { text: raw, width: size, depth: size };
  }
  return null;
}

// 功能 4：校验 "9:00 AM" 格式，返回 { ok, hour, minute } 或 { ok:false, error }。
function validateTime(text) {
  var raw = toText(text).trim();
  var clock = parseClock(raw);
  if (clock) return { ok: true, hour: clock.hour, minute: clock.minute, text: raw };
  if (CLOCK_TIGHT_RE.test(raw)) {
    return fail("clockNeedsSpace", "数字和 AM/PM 之间要有空格，例如 9:00 AM。",
      "AM/PM must be preceded by a space, e.g. 9:00 AM.", ["join 9:00 AM, out 5:00 PM"]);
  }
  return fail("badClock", "时间格式应为 9:00 AM（12 小时制）。",
    "Time must look like 9:00 AM (12-hour clock).", ["join 9:00 AM, out 5:00 PM"]);
}

// 定时失败结果：始终带上 isJoinOut / joinTime / outTime，方便 GUI 显示。
function joinFail(code, zh, en, suggestions, joinText, outText) {
  var out = fail(code, zh, en, suggestions);
  out.isJoinOut = true;
  out.type = "schedule";
  out.joinTime = toText(joinText).trim();
  out.outTime = toText(outText).trim();
  return out;
}

// 功能 2：解析定时上下线，返回 { ok, isJoinOut, joinTime, outTime, join, out }。
function parseJoinOut(text) {
  var raw = normalizeSymbols(text).trim();
  var parts = splitSegments(raw);
  var joinText = "";
  var outText = "";
  for (var i = 0; i < parts.length; i++) {
    var seg = parts[i];
    var hit = JOIN_RE.exec(seg);
    if (hit) { joinText = hit[1].trim(); continue; }
    hit = OUT_RE.exec(seg);
    if (hit) { outText = hit[1].trim(); continue; }
  }
  if (joinText.length === 0 || outText.length === 0) {
    return joinFail("scheduleIncomplete", "定时要写全：join 9:00 AM, out 5:00 PM",
      "Schedule needs both parts: join 9:00 AM, out 5:00 PM", ["join 9:00 AM, out 5:00 PM"], joinText, outText);
  }
  var joinCheck = validateTime(joinText);
  if (!joinCheck.ok) {
    return joinFail("joinBadTime", joinCheck.error.zh, joinCheck.error.en,
      ["join 9:00 AM, out 5:00 PM"], joinText, outText);
  }
  var outCheck = validateTime(outText);
  if (!outCheck.ok) {
    return joinFail("joinBadTime", outCheck.error.zh, outCheck.error.en,
      ["join 9:00 AM, out 5:00 PM"], joinText, outText);
  }
  var joinMinutes = clockToMinutes(joinCheck.hour, joinCheck.minute);
  var outMinutes = clockToMinutes(outCheck.hour, outCheck.minute);
  if (joinMinutes >= outMinutes) {
    return joinFail("joinOrder", "起始时间必须早于结束时间。", "Join time must be earlier than out time.",
      ["join 9:00 AM, out 5:00 PM"], joinText, outText);
  }
  return pass({
    isJoinOut: true, type: "schedule", raw: raw, joinTime: joinText, outTime: outText,
    join: { hour: joinCheck.hour, minute: joinCheck.minute, minutes: joinMinutes },
    out: { hour: outCheck.hour, minute: outCheck.minute, minutes: outMinutes }
  });
}

// 兼容（旧 GUI 开关面板）：test mode on / hive mind off / ai code off ...
function parseSwitch(text) {
  var raw = toText(text).trim();
  var flat = raw.toLowerCase().replace(/\s+/g, " ");
  for (var i = 0; i < SWITCH_KEYS.length; i++) {
    var entry = SWITCH_KEYS[i];
    for (var j = 0; j < entry.words.length; j++) {
      var word = entry.words[j];
      if (flat === word + " on") return pass({ type: "switch", key: entry.key, label: word, on: true, value: true, raw: raw });
      if (flat === word + " off") return pass({ type: "switch", key: entry.key, label: word, on: false, value: false, raw: raw });
      if (flat.indexOf(word + " ") === 0) {
        return fail("switchValue", "开关只能用 on 或 off。", "Switch value must be on or off.", [word + " on", word + " off"]);
      }
    }
  }
  return null;
}

// 是不是定时指令：join / out 开头的都交给 parseJoinOut。
function looksLikeSchedule(text) {
  var raw = toText(text).trim();
  return JOIN_RE.test(raw) || OUT_RE.test(raw) || /^join\b/i.test(raw) || /^out\b/i.test(raw);
}

// 首段可能混进参数（例如 "dig_tree 10 64 10"），拆出动作名和剩余片段。
function splitHead(head, parts) {
  var words = toText(head).split(/\s+/);
  var rest = [];
  if (words.length > 1) rest.push(words.slice(1).join(" "));
  for (var i = 1; i < parts.length; i++) rest.push(parts[i]);
  return { name: words[0].toLowerCase(), rest: rest };
}

// 玩家片段可能一次写多个（follow, Steve, Alex），按空格与逗号拆开。
function pushPlayers(list, text) {
  var words = toText(text).split(/[\s,]+/);
  for (var i = 0; i < words.length; i++) {
    if (words[i].length > 0) list.push(words[i]);
  }
  return list;
}

// 时间片段：10m / 2h / 30s 算时长，9:00 AM 算时刻；都不像就报错。
function readTime(text) {
  var duration = parseDuration(text);
  if (duration) return { ok: true, text: duration.text, seconds: duration.seconds, kind: "duration" };
  var clock = parseClock(text);
  if (clock) return { ok: true, text: clock.text, seconds: 0, kind: "clock" };
  return { ok: false };
}

// 功能 3：解析动作指令，返回扁平结果（与 GUI 本地解析器同形，方便直接转发）。
//   dig_tree → { ok, action, blocks, wood, fillInventory, range, time, back }
//   mine     → { ok, action, blocks, ores, range, time, back }
//   follow   → { ok, action, players, range, time, back }
//   move     → { ok, action, position, range, time, back }
// 参数不合法 → { ok:false, error:{ code, zh, en, suggestions } }
function parseAction(text, options) {
  var raw = normalizeSymbols(toText(text)).trim();
  if (isBlank(raw)) return fail("empty", "指令为空。", "Empty command.");
  var parts = splitSegments(raw);
  if (parts.length === 0) return fail("empty", "指令为空。", "Empty command.");
  var head = splitHead(parts[0], parts);
  var name = head.name;
  if (ACTION_WORDS.indexOf(name) < 0) {
    return fail("unknownAction", "无法识别指令：" + parts[0], "Unknown command: " + parts[0],
      closest(parts[0], 3));
  }
  var rest = head.rest;
  var rangeText = "";
  var timeText = "";
  var timeSeconds = 0;
  var back = null;
  var blocks = null;
  var wood = null;
  var ores = [];
  var players = [];
  var position = null;
  var loose = [];
  for (var i = 0; i < rest.length; i++) {
    var seg = rest[i];
    var hit = null;
    if ((hit = BLOCKS_RE.exec(seg)) !== null) { blocks = parseInt(hit[1], 10); continue; }
    if ((hit = TIME_SEG_RE.exec(seg)) !== null) {
      var timeRead = readTime(hit[1]);
      if (!timeRead.ok) {
        return fail("badTime", "时间写法要像 10m、2h 或 9:00 AM。",
          "Time must look like 10m, 2h or 9:00 AM.", ["time=10m", "time=2h"]);
      }
      timeText = timeRead.text;
      timeSeconds = timeRead.seconds;
      continue;
    }
    if ((hit = RANGE_SEG_RE.exec(seg)) !== null) {
      var rangeHit = parseRange(hit[1]);
      if (!rangeHit) {
        return fail("badRange", "范围写法要像 5*5（用 * 不用 ×）。",
          "Range must look like 5*5 (use * not ×).", ["range=5*5"]);
      }
      rangeText = rangeHit.text;
      continue;
    }
    if ((hit = BACK_RE.exec(seg)) !== null) {
      back = [parseFloat(hit[1]), parseFloat(hit[2]), parseFloat(hit[3])];
      continue;
    }
    if ((hit = WOOD_RE.exec(seg)) !== null) { wood = hit[1].toLowerCase(); continue; }
    if ((hit = ORE_RE.exec(seg)) !== null) {
      if (isBlank(hit[1])) continue;
      ores.push(hit[1].trim().toLowerCase());
      continue;
    }
    if ((hit = PLAYER_SEG_RE.exec(seg)) !== null) { pushPlayers(players, hit[1]); continue; }
    if (/^back\b/i.test(seg)) { loose.push(seg); continue; }
    var coordHit = COORD_SEG_RE.exec(seg);
    if (coordHit) {
      position = {
        x: parseFloat(coordHit[1]), y: parseFloat(coordHit[2]), z: parseFloat(coordHit[3])
      };
      continue;
    }
    var looseRange = parseRange(seg);
    if (looseRange && rangeText.length === 0) { rangeText = looseRange.text; continue; }
    var looseTime = readTime(seg);
    if (looseTime.ok && timeText.length === 0) {
      timeText = looseTime.text;
      timeSeconds = looseTime.seconds;
      continue;
    }
    loose.push(seg);
  }
  // 参数分发：不同动作接受的参数不一样，多给的宁可报错也别乱做。
  if (name === "dig_tree" || name === "mine") {
    var fillInventory = blocks === null;
    if (loose.length > 0) {
      if (name === "dig_tree") { if (wood === null) wood = loose[0].toLowerCase(); }
      else if (ores.length === 0) ores.push(loose[0].toLowerCase());
    }
    if (loose.length > 1) {
      return fail("extraArgs", name + " 只支持一个目标。", name + " accepts only one target.",
        [name + ", blocks=10, wood=oak", name + ", blocks=10, (iron)"]);
    }
    return pass({
      action: name, blocks: blocks, wood: wood, ores: ores, fillInventory: fillInventory,
      range: rangeText, time: timeText, timeSeconds: timeSeconds, back: back, target: null
    });
  }

  if (name === "follow") {
    pushPlayers(players, loose.join(" "));
    if (players.length === 0) {
      return fail("missingPlayer", "follow 后面要跟玩家名，例如 follow, Steve。",
        "follow needs a player name, e.g. follow, Steve.", ["follow, Steve"]);
    }
    return pass({
      action: name, players: players, range: rangeText, time: timeText,
      timeSeconds: timeSeconds, back: back, target: null
    });
  }

  if (name === "attack") {
    if (loose.length === 0) {
      return fail("missingTarget", "attack 后面要跟目标，例如 attack, zombie。",
        "attack needs a target, e.g. attack, zombie.", ["attack, zombie"]);
    }
    return pass({
      action: name, attackTarget: loose.join(" "), range: rangeText, time: timeText,
      timeSeconds: timeSeconds, back: back, target: null
    });
  }

  if (name === "attack_all") {
    if (loose.length > 0) {
      return fail("extraArgs", "attack_all 只接受 range 参数。", "attack_all only accepts range.",
        ["attack_all, range=5*5"]);
    }
    if (rangeText.length === 0) rangeText = DEFAULT_ATTACK_RANGE;
    return pass({
      action: name, range: rangeText, time: timeText, timeSeconds: timeSeconds, back: back, target: null
    });
  }

  if (name === "move") {
    if (!position && loose.length > 0) {
      var joined = COORD_SEG_RE.exec(loose.join(" ").trim());
      if (joined) {
        position = { x: parseFloat(joined[1]), y: parseFloat(joined[2]), z: parseFloat(joined[3]) };
        loose = [];
      }
    }
    if (!position) {
      return fail("badPosition", "move 需要三个坐标：move, 10 64 10",
        "move needs three coordinates: move, 10 64 10", ["move, 10 64 10"]);
    }
    return pass({
      action: name, position: position, x: position.x, y: position.y, z: position.z,
      range: rangeText, time: timeText, timeSeconds: timeSeconds, back: back, target: null
    });
  }

  if (PLAIN_ACTIONS.indexOf(name) >= 0) {
    if (loose.length > 0) {
      return fail("extraArgs", name + " 不需要额外参数。", name + " takes no extra argument.", [name]);
    }
    return pass({
      action: name, wood: wood, range: rangeText, time: timeText,
      timeSeconds: timeSeconds, back: back, target: null
    });
  }

  return fail("unknownAction", "无法识别指令：" + parts[0], "Unknown command: " + parts[0],
    closest(parts[0], 3));
}

// 常量：目标前缀（all / bot1 / bot1-2）——写法与 GUI 目标下拉一致。
var TARGET_PREFIX_RE = /^(all|bot\d+(?:-\d+)?)\s+([\s\S]+)$/i;

// 功能 1：入口——开关 → 定时 → 动作（带 all / bot1 前缀的也认）。
function parse(text, options) {
  var raw = normalizeSymbols(toText(text)).trim();
  if (isBlank(raw)) return fail("empty", "指令为空。", "Empty command.");
  var switchResult = parseSwitch(raw);
  if (switchResult) return switchResult;
  if (looksLikeSchedule(raw)) return parseJoinOut(raw);
  var prefixHit = TARGET_PREFIX_RE.exec(raw);
  if (prefixHit) {
    var inner = parseAction(prefixHit[2].trim(), options);
    if (inner && inner.ok) {
      inner.target = prefixHit[1].toLowerCase();
      inner.raw = raw;
    }
    return inner;
  }
  var result = parseAction(raw, options);
  if (result && result.ok) result.raw = raw;
  return result;
}
// 兼容（旧交互）：批量解析多行文本，空行自动忽略。
function parseMany(text, options) {
  var lines = toText(text).split(/\r?\n/);
  var results = [];
  for (var i = 0; i < lines.length; i++) {
    if (isBlank(lines[i])) continue;
    results.push(parse(lines[i], options));
  }
  return results;
}

// 兼容（旧交互）：parseJoinOut 的别名——不像定时指令就返回 null。
function parseSchedule(text) {
  if (!looksLikeSchedule(text)) return null;
  return parseJoinOut(text);
}

// 功能 5：把失败结果转成双语说明；成功或空结果返回空串。
function formatError(result) {
  try {
    if (typeof result === "string") return result;
    if (!result || result.ok === true) return "";
    var error = result.error || {};
    var lines = ["错误：" + toText(error.zh) + " / Error: " + toText(error.en)];
    if (error.suggestions && error.suggestions.length > 0) {
      lines.push("你是不是想输入 / did you mean: " + error.suggestions.join(" | "));
    }
    return lines.join("\n");
  } catch (e) {
    return "错误：解析失败。 / Error: parse failed.";
  }
}

// 对外导出：主接口 + 旧调用方兼容键。
module.exports = {
  parse: parse,
  parseAction: parseAction,
  parseJoinOut: parseJoinOut,
  validateTime: validateTime,
  formatError: formatError,
  parseMany: parseMany,
  parseSwitch: parseSwitch,
  parseSchedule: parseSchedule,
  parseClock: parseClock,
  parseDuration: parseDuration,
  parseRange: parseRange,
  closest: closest,
  ACTION_WORDS: ACTION_WORDS,
  PLAIN_ACTIONS: PLAIN_ACTIONS,
  SWITCH_KEYS: SWITCH_KEYS,
  SUGGEST_POOL: SUGGEST_POOL
};






