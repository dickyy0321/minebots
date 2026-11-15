// ========================================
// 文件：modules/ai-tools-schema.js
// 功能：Function Calling 纯英文精简 schema——14 个工具的英文短描述、参数类型表、
//       validateToolArgs 强校验、search_tools 按需检索与 slim 精简菜单（降 Token）。
// 依赖：无（纯数据 + 纯函数）
// 导出：TOOLS / TYPES / REQUIRED / validateToolArgs / searchTools / slimTools /
//       searchToolDefinition / getMenu / stats / SEARCH_TOOL_NAME
// 作者：MineBots
// ========================================
// 说明：工具名与 required 保持和历史菜单逐字一致，只有描述改成纯英文短句，
//   这样既有权限表、断言、AI 调用链都不用改；默认菜单仍是 14 个完整工具。
// CommonJS，无中文变量名 / CommonJS, no Chinese identifiers

// 常量：按需检索工具名。
var SEARCH_TOOL_NAME = "search_tools";
// 常量：每个工具的参数类型（integer / string / array），强校验与 slim 都读它。
var TYPES = {
  move_to: { x: "integer", y: "integer", z: "integer" },
  move_to_player: { player: "string" },
  dig_block: { x: "integer", y: "integer", z: "integer" },
  dig_tree: { blocks: "integer", wood: "string" },
  mine: { blocks: "integer", ores: "array" },
  follow: { players: "array" },
  stop: {},
  attack: { target: "string" },
  place_block: { x: "integer", y: "integer", z: "integer", block: "string" },
  craft: { item: "string", count: "integer" },
  collect: {},
  get_position: {},
  get_health: {},
  get_inventory: {}
};
// 常量：必填参数（与历史菜单逐字一致）。
var REQUIRED = {
  move_to: ["x", "y", "z"], move_to_player: ["player"], dig_block: ["x", "y", "z"],
  dig_tree: [], mine: [], follow: ["players"], stop: [], attack: ["target"],
  place_block: ["x", "y", "z", "block"], craft: ["item"], collect: [],
  get_position: [], get_health: [], get_inventory: []
};
// 内部：组装一个 OpenAI 格式工具定义；描述一律纯英文短句。
function def(name, description, required) {
  var props = {};
  var t = TYPES[name] || {};
  for (var key in t) {
    if (!Object.prototype.hasOwnProperty.call(t, key)) continue;
    var type = t[key];
    props[key] = type === "array" ? { type: "array", items: { type: "string" } } : { type: type };
  }
  return { type: "function", function: { name: name, description: description,
    parameters: { type: "object", properties: props, required: (required || []).slice(0) } } };
}
// 常量：14 个工具的纯英文精简菜单（顺序与旧菜单一致）。
var TOOLS = [
  def("move_to", "Walk to coordinates x,y,z.", REQUIRED.move_to),
  def("move_to_player", "Walk to a player.", REQUIRED.move_to_player),
  def("dig_block", "Dig the block at x,y,z.", REQUIRED.dig_block),
  def("dig_tree", "Chop nearby logs.", REQUIRED.dig_tree),
  def("mine", "Mine nearby ores.", REQUIRED.mine),
  def("follow", "Follow the listed players.", REQUIRED.follow),
  def("stop", "Stop all current actions.", REQUIRED.stop),
  def("attack", "Attack a named entity.", REQUIRED.attack),
  def("place_block", "Place a block at x,y,z.", REQUIRED.place_block),
  def("craft", "Craft an item.", REQUIRED.craft),
  def("collect", "Pick up nearby dropped items.", REQUIRED.collect),
  def("get_position", "Get the bot position.", REQUIRED.get_position),
  def("get_health", "Get health and food.", REQUIRED.get_health),
  def("get_inventory", "List inventory items.", REQUIRED.get_inventory)
];
// 安全转字符串：null / undefined 归一成空串。
function toText(value) {
  try { if (value === null || value === undefined) return ""; return String(value); } catch (e) { return ""; }
}
// 归一化工具名：去空白、转小写、兼容 models 带的 functions. 前缀。
function normalizeName(name) {
  var out = toText(name).toLowerCase().trim();
  if (out.indexOf("functions.") === 0) out = out.slice(10).trim();
  return out;
}
// 判断一个值是否满足声明类型；数字字符串允许落到 integer。
function typeOk(value, type) {
  try {
    if (type === "integer") {
      if (typeof value === "number") return isFinite(value) && Math.floor(value) === value;
      if (typeof value === "string" && value.trim().length > 0) return !isNaN(Number(value));
      return false;
    }
    if (type === "string") return typeof value === "string" || typeof value === "number";
    if (type === "array") return Array.isArray(value) || (typeof value === "string" && value.length > 0);
  } catch (e) { return false; }
  return true;
}
// 把可宽松接受到的值收敛成目标类型；收敛不了返回原值。
function coerce(value, type) {
  try {
    if (type === "integer" && typeof value === "string") return parseInt(value, 10);
    if (type === "array" && typeof value === "string") return value.split(",").map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
  } catch (e) { /* 收敛失败用原值 */ }
  return value;
}
// 功能：强校验参数——缺必填 / 类型不对直接报错，返回 { ok, known, name, errors, normalized }。
function validateToolArgs(name, args) {
  var out = { ok: true, known: true, name: "", errors: [], normalized: {} };
  try {
    var key = normalizeName(name);
    out.name = key;
    var rules = TYPES[key];
    if (!rules) { out.known = false; out.errors.push("unknown tool / 未知工具: " + key); out.ok = false; return out; }
    var input = args && typeof args === "object" ? args : {};
    var must = REQUIRED[key] || [];
    for (var i = 0; i < must.length; i++) {
      var k = must[i];
      var v = input[k];
      if (v === undefined || v === null || (typeof v === "string" && v.trim().length === 0)) {
        out.errors.push("missing required argument / 缺少必填参数: " + k);
      }
    }
    for (var prop in rules) {
      if (!Object.prototype.hasOwnProperty.call(rules, prop)) continue;
      if (input[prop] === undefined) { out.normalized[prop] = undefined; continue; }
      if (!typeOk(input[prop], rules[prop])) {
        out.errors.push("wrong type / 参数类型不对: " + prop + " expects " + rules[prop]);
        out.normalized[prop] = input[prop];
      } else out.normalized[prop] = coerce(input[prop], rules[prop]);
    }
    out.ok = out.errors.length === 0;
    return out;
  } catch (e) {
    out.ok = false;
    out.errors.push("validation error / 校验异常: " + toText(e && e.message ? e.message : e));
    return out;
  }
}
// 功能：按需搜索工具——按名称与英文描述匹配，返回最多 limit 个定义。
function searchTools(query, options) {
  var out = { ok: true, query: "", total: 0, tools: [] };
  try {
    var opts = options && typeof options === "object" ? options : {};
    var q = toText(query).toLowerCase().trim();
    out.query = q;
    var limit = Number(opts.limit) > 0 ? Math.floor(Number(opts.limit)) : 5;
    var words = q.length > 0 ? q.split(/[\s,_]+/) : [];
    for (var i = 0; i < TOOLS.length && out.tools.length < limit; i++) {
      var t = TOOLS[i];
      var hay = (t.function.name + " " + t.function.description).toLowerCase();
      var hit = words.length === 0;
      for (var j = 0; j < words.length; j++) if (words[j].length > 0 && hay.indexOf(words[j]) >= 0) hit = true;
      if (hit) out.tools.push(JSON.parse(JSON.stringify(t)));
    }
    out.total = out.tools.length;
    return out;
  } catch (e) { out.ok = false; return out; }
}
// 功能：生成精简菜单——进一步去掉工具描述，只留名称与参数类型，显著降低 Token。
function slimTools() {
  var out = [];
  try {
    for (var i = 0; i < TOOLS.length; i++) {
      var copy = JSON.parse(JSON.stringify(TOOLS[i]));
      delete copy.function.description;
      out.push(copy);
    }
  } catch (e) { return out; }
  return out;
}
// 功能：返回 search_tools 自身的 OpenAI 定义（纯英文）。
function searchToolDefinition() {
  return { type: "function", function: { name: SEARCH_TOOL_NAME,
    description: "Find available tools by keyword. Call this before requesting full schemas.",
    parameters: { type: "object", properties: {
      query: { type: "string" }, limit: { type: "integer" }
    }, required: ["query"] } } };
}
// 功能：按模式取菜单——search 模式只给检索工具 + 精简核心工具，不一次性塞全部 schema。
function getMenu(options) {
  var opts = options && typeof options === "object" ? options : {};
  if (opts.mode === "search") {
    var core = [];
    try {
      var names = opts.core || ["stop", "get_position"];
      for (var i = 0; i < names.length; i++) {
        var found = searchTools(names[i], { limit: 1 });
        if (found.tools.length > 0) core.push(found.tools[0]);
      }
    } catch (e) { /* 核心工具取不到就只给检索工具 */ }
    return [searchToolDefinition()].concat(core);
  }
  return slimTools();
}
// 功能：读统计（工具数 / 完整与精简 schema 的字符数，用于降 Token 对比）。
function stats() {
  var full = 0;
  var plain = 0;
  try {
    full = JSON.stringify(TOOLS).length;
    plain = JSON.stringify(slimTools()).length;
  } catch (e) { /* ignore */ }
  return { ok: true, tools: TOOLS.length, schemaChars: full, slimChars: plain,
    searchTool: SEARCH_TOOL_NAME, englishOnly: isEnglishOnly() };
}
// 判断所有描述是否为纯英文（自检用来钉死「纯英文重构」）。
function isEnglishOnly() {
  try {
    for (var i = 0; i < TOOLS.length; i++) {
      if (/[\u4e00-\u9fa5]/.test(TOOLS[i].function.description)) return false;
      var props = TOOLS[i].function.parameters.properties;
      for (var k in props) {
        if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
        if (props[k].description && /[\u4e00-\u9fa5]/.test(props[k].description)) return false;
      }
    }
  } catch (e) { return false; }
  return true;
}
// 对外导出。
module.exports = {
  TOOLS: TOOLS, TYPES: TYPES, REQUIRED: REQUIRED,
  validateToolArgs: validateToolArgs, searchTools: searchTools,
  slimTools: slimTools, searchToolDefinition: searchToolDefinition,
  getMenu: getMenu, stats: stats, SEARCH_TOOL_NAME: SEARCH_TOOL_NAME
};
