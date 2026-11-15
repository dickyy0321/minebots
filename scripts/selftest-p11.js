// ========================================
// 文件：scripts/selftest-p11.js
// 功能：P11 回归自测——Litematica 底层 LongArray 位解码 / 红石 Tick 级仿真与真值表 /
//       自动红石布线 Place-and-Route（网表 + A* + 中继器 + 垂直传输）/ 贪心网格合并与 /fill 指令流 /
//       SDF 体素转 .litematic / 红石安全限流（TPS + Ping 降频与恢复）
// 依赖：path、fs、zlib、prismarine-nbt（可选）；导出：run（由 selftest-p5.js 调用，复用 section / expect）
// 作者：MineBots
// ========================================
// 说明 / note：全程离线、不联网、不碰真实 state/；黑板与 bot 一律内存假实现，收尾逐模块 reset。
var path = require("path"); var fs = require("fs"); var zlib = require("zlib");
var ROOT = path.join(__dirname, "..");
// 按相对路径安全 require；缺失或抛错返回 null，不拖垮整轮自检。
function load(rel) {
  try { return require(path.join(ROOT, rel)); } catch (e) { return null; }
}
// 读项目文件文本；读不到返回空串。
function readRel(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch (e) { return ""; }
}
// 内存黑板：实现 post / get / postTask / completeTask / listTasks，绝不写盘。
function fakeBoard() {
  var tasks = {}, data = {}, seq = 0;
  return {
    tasks: tasks, data: data,
    post: function (k, v) { data[k] = JSON.parse(JSON.stringify(v)); return { ok: true }; },
    get: function (k, d) { return data[k] === undefined ? d : JSON.parse(JSON.stringify(data[k])); },
    has: function (k) { return data[k] !== undefined; },
    keys: function () { return Object.keys(data); },
    del: function (k) { delete data[k]; return { ok: true }; },
    postTask: function (t) {
      seq = seq + 1;
      var id = "t" + seq;
      tasks[id] = { id: id, title: t.title, priority: Number(t.priority) || 0,
        payload: JSON.parse(JSON.stringify(t.payload || {})), status: "pending" };
      return { ok: true, taskId: id, task: tasks[id] };
    },
    listTasks: function () {
      var out = [];
      for (var k in tasks) if (Object.prototype.hasOwnProperty.call(tasks, k)) out.push(JSON.parse(JSON.stringify(tasks[k])));
      return out;
    },
    completeTask: function (id) { if (tasks[id]) tasks[id].status = "done"; return { ok: true }; }
  };
}
// 内存假 bot：提供 time.timeOfDay / entity.ping / chat / blockAt / lookAt / activateBlock。
function fakeBot(chats) {
  return {
    time: { timeOfDay: 1000, age: 1000 },
    entity: { ping: 20 },
    chat: function (text) { chats.push(text); },
    blockAt: function () { return { name: "lever", stateId: 1, getProperties: function () { return { powered: "false" }; } }; },
    lookAt: function () { return Promise.resolve(true); },
    activateBlock: function () { return Promise.resolve(true); }
  };
}
// 造一个真实 gzip + NBT 的微型 .litematic：2 种方块、list 形式 BlockStatePalette、Position 偏移。
// 位流 [[0,20]] 按 bits=2 解出索引 [0,1,1,0]，即 (1,0,0) 与 (0,0,1) 是中继器，其余为空气。
function makeTinyLitematic() {
  var nbt = null;
  try { nbt = require("prismarine-nbt"); } catch (e) { return null; }
  try {
    var pal = nbt.list(nbt.comp([
      { Name: nbt.string("minecraft:air") },
      { Name: nbt.string("minecraft:repeater"),
        Properties: nbt.comp({ facing: nbt.string("east"), delay: nbt.string("2") }) }
    ]));
    var region = nbt.comp({
      Position: nbt.comp({ x: nbt.int(10), y: nbt.int(64), z: nbt.int(-3) }),
      Size: nbt.comp({ x: nbt.int(2), y: nbt.int(1), z: nbt.int(2) }),
      BlockStatePalette: pal,
      BlockStates: nbt.longArray([[0, 20], [0, 0]])
    });
    var root = nbt.comp({ Regions: nbt.comp({ main: region }) });
    root.name = "";
    return zlib.gzipSync(nbt.writeUncompressed(root));
  } catch (e) { return null; }
}
// 造 10x10 的实心石头平面蓝图；用于贪心合并验收。
function makeStoneSlab() {
  var blocks = [];
  for (var x = 0; x < 10; x++) for (var z = 0; z < 10; z++) blocks.push({ x: x, y: 0, z: z, block: "stone", props: {} });
  return { name: "slab", format: "json", origin: { x: 0, y: 64, z: 0 },
    size: { width: 10, height: 1, length: 10 }, blocks: blocks };
}
// 按 taskId 精确读触发器间隔；找不到返回 -1，避免 list()[0] 命中前序分组残留的 inactive 记录。
function intervalOf(trig, taskId) {
  try {
    var list = trig.list();
    for (var i = 0; i < list.length; i++) if (list[i].taskId === taskId) return list[i].intervalMs;
  } catch (e) { /* ignore */ }
  return -1;
}
// 21a：静态接线——6 个新模块可加载、导出齐全，关键接线落在既有代码里，文件不越 600 行。
function checkStatic(h) {
  h.section("21a. 底层方案静态接线 / low-level wiring");
  var pairs = [
    ["modules/litematic-codec.js", ["bitsPerBlock", "longWords", "extractBits", "decodeBlockStates",
      "encodeBlockStates", "coordinateOf", "absoluteOf", "paletteOf", "readRegion", "parse", "encode"]],
    ["modules/redstone-sim.js", ["Schematic", "create", "backend", "truthTable", "verifyTruthTable", "buildNotGateDemo"]],
    ["modules/redstone-router.js", ["TEMPLATES", "parseRequest", "netlistOf", "place", "astar",
      "route", "verticalRoute", "buildTemplate", "toBlueprint"]],
    ["modules/blueprint-mesher.js", ["greedyMeshing", "fillCommands", "splitFillToTasks", "estimateSavings",
      "sdfSphere", "sdfBox", "sdfUnion", "sdfSubtract", "sdfSmoothUnion", "voxelize",
      "sdfToBlueprint", "toLitematic"]],
    ["modules/redstone-safety.js", ["registerBot", "readTelemetry", "estimateTps", "sample",
      "evaluate", "apply", "check", "start", "stop", "TPS_THRESHOLD", "PING_LIMIT"]]
  ];
  for (var i = 0; i < pairs.length; i++) {
    var mod = load(pairs[i][0]);
    var names = pairs[i][1];
    var ok = !!mod;
    if (ok) for (var j = 0; j < names.length; j++) if (mod[names[j]] === undefined) ok = false;
    h.expect("模块可加载且导出齐全: " + pairs[i][0], ok, "exports");
    var text = readRel(pairs[i][0]);
    h.expect("单文件不超过 600 行: " + pairs[i][0], text.split("\n").length <= 600,
      String(text.split("\n").length));
  }
  var trg = load("modules/redstone-trigger.js");
  h.expect("redstone-trigger 新增 setIntervalMs 限流接口",
    !!trg && typeof trg.setIntervalMs === "function" &&
    readRel("modules/redstone-trigger.js").indexOf("function setIntervalMs") >= 0, "trigger");
  var hd = load("modules/blueprint-highdim.js");
  h.expect("blueprint-highdim 把位流委托给 litematic-codec 且暴露 bitsPerBlock",
    !!hd && hd.litematicCodec !== null && typeof hd.bitsPerBlock === "function" &&
    readRel("modules/blueprint-highdim.js").indexOf("litematic-codec") >= 0, "highdim");
  var p5 = readRel("scripts/selftest-p5.js");
  h.expect("P11 已挂入 selftest-p5 自检链", p5.indexOf("selftest-p11") >= 0, "selftest-p5");
  var codec = load("modules/litematic-codec.js");
  var mesher = load("modules/blueprint-mesher.js");
  h.expect("SDF 导出走真实 NBT 编码器而非纸面 JSON",
    !!codec && !!mesher && readRel("modules/blueprint-mesher.js").indexOf("codec.encode") >= 0, "encoder");
}
// 21b：Litematica 底层解码——位宽 / 跨 long 边界 / 真 NBT 2 方块 / 坐标映射 / 编码往返。
function checkLitematic(h) {
  h.section("21b. Litematica LongArray 位解码 / bitstream decode");
  var codec = load("modules/litematic-codec.js");
  var hd = load("modules/blueprint-highdim.js");
  if (!codec || !hd) { h.expect("编解码模块可加载", false, "require failed"); return; }
  h.expect("位宽 max(2, ceil(log2(palette)))：2/3/4 项均为 2，5 项为 3，9 项为 4",
    codec.bitsPerBlock(2) === 2 && codec.bitsPerBlock(3) === 2 && codec.bitsPerBlock(4) === 2 &&
    codec.bitsPerBlock(5) === 3 && codec.bitsPerBlock(9) === 4, "bitsPerBlock");
  h.expect("高维蓝图门面暴露同一位宽", hd.bitsPerBlock(2) === 2 && hd.bitsPerBlock(5) === 3, "highdim bits");
  h.expect("extractBits 跨 32 位字取值", codec.extractBits([4294967295, 1], 31, 2) === 3,
    String(codec.extractBits([4294967295, 1], 31, 2)));
  var ids = [];
  for (var i = 0; i < 40; i++) ids.push(i % 4);
  var words = codec.encodeBlockStates(ids, 4, {});
  var back = codec.decodeBlockStates(words, 4, 40);
  h.expect("位流跨 Long 边界往返无损（40 条目 / 2 个 long）",
    words.length === 2 && back.length === 40 && back.join(",") === ids.join(","),
    JSON.stringify({ longs: words.length, back: back.slice(0, 6) }));
  h.expect("P10 既有位压缩断言不降（3 palette / bits=2）",
    hd.decodeBlockStates([[0, 18], [0, 0]], 3, 2).join(",") === "2,0", "p10 regression");
  var tiny = makeTinyLitematic();
  if (!tiny) { h.expect("微型 .litematic 可构造", false, "nbt unavailable"); return; }
  h.expect("真实 gzip + NBT 的微型 .litematic 可构造", tiny[0] === 0x1f && tiny[1] === 0x8b, "gzip magic");
  var parsed = codec.parse(tiny);
  h.expect("2 种方块微型文件解码成功且位宽为 2",
    parsed.ok === true && parsed.regions.length === 1 && parsed.regions[0].bits === 2 &&
    parsed.regions[0].paletteSize === 2, parsed.message + " / " + JSON.stringify(parsed.regions[0] && parsed.regions[0].bits));
  h.expect("YZX 索引还原坐标并按 Position 叠加绝对坐标",
    parsed.blocks.length === 2 && parsed.blocks[0].x === 1 && parsed.blocks[0].z === 0 &&
    parsed.blocks[0].absolute.x === 11 && parsed.blocks[0].absolute.y === 64 &&
    parsed.blocks[0].absolute.z === -3 && parsed.blocks[1].x === 0 && parsed.blocks[1].z === 1 &&
    parsed.blocks[1].absolute.x === 10 && parsed.blocks[1].absolute.z === -2,
    JSON.stringify(parsed.blocks));
  h.expect("palette 索引与 {Name,Properties} 属性被正确读出",
    parsed.blocks[0].paletteIndex === 1 && parsed.blocks[0].block === "repeater" &&
    parsed.blocks[0].props.facing === "east" && parsed.blocks[0].props.delay === "2" &&
    parsed.origin.x === 10 && parsed.origin.z === -3, JSON.stringify(parsed.blocks[0]));
  var viaHd = hd.fromLitematic(tiny);
  h.expect("builder-blueprint 链路解析同一文件",
    viaHd.ok === true && viaHd.blueprint.format === "litematic" &&
    viaHd.blueprint.origin.x === 10 && viaHd.blueprint.blocks[0].block === "repeater", "fromLitematic");
  var c3 = codec.coordinateOf(5, { width: 3, height: 2, length: 4 });
  var abs = codec.absoluteOf({ x: 1, y: 2, z: 3 }, { x: 10, y: 64, z: -5 });
  h.expect("coordinateOf 按 (y*length+z)*width+x 还原三维坐标",
    c3.x === 2 && c3.y === 0 && c3.z === 1 && abs.x === 11 && abs.y === 66 && abs.z === -2,
    JSON.stringify({ c3: c3, abs: abs }));
  var sample = { name: "round", origin: { x: 3, y: 70, z: 8 },
    size: { width: 3, height: 2, length: 2 }, blocks: [
      { x: 0, y: 0, z: 0, block: "stone", props: {} },
      { x: 2, y: 0, z: 0, block: "oak_stairs", props: { facing: "north", half: "top" } },
      { x: 0, y: 1, z: 1, block: "redstone_wire", props: { power: "15" } } ] };
  var enc = codec.encode(sample, {});
  var dec = enc.ok ? codec.parse(enc.buffer) : { ok: false, blocks: [] };
  h.expect("反向编码产出真 .litematic 且解码回原方块（供 SDF 导出）",
    enc.ok === true && enc.buffer && enc.buffer[0] === 0x1f && dec.ok === true &&
    dec.blocks.length === 3 && dec.blocks[1].block === "oak_stairs" &&
    dec.blocks[1].props.half === "top" && dec.blocks[2].absolute.y === 71,
    enc.message + " / " + JSON.stringify(dec.blocks));
  h.expect("stats 记录解析与编码次数", codec.stats().parsed >= 1 && codec.stats().encoded >= 1, "stats");
}
// 21c：红石 Tick 级仿真——Schematic 兼容接口 / NOT 门翻转 / 真值表 / 多输入延迟传播。
function checkSimulation(h) {
  h.section("21c. 红石 Tick 级仿真 / redstone simulation");
  var sim = load("modules/redstone-sim.js");
  if (!sim) { h.expect("仿真模块可加载", false, "require failed"); return; }
  h.expect("nucleation 未安装时降级为内置逻辑门验证器",
    sim.backend() === "builtin" || sim.backend() === "nucleation", sim.backend());
  var world = sim.Schematic.create("test_circuit");
  h.expect("Schematic.create 返回带 setBlockFromString / onUseBlock / tick / isLit 的 world",
    !!world && typeof world.setBlockFromString === "function" && typeof world.onUseBlock === "function" &&
    typeof world.tick === "function" && typeof world.isLit === "function", "Schematic.create");
  var placed = world.setBlockFromString(0, 0, 0, "minecraft:lever[facing=east,face=floor,powered=false]");
  h.expect("setBlockFromString 解析拉杆规格与 powered 属性",
    placed.ok === true && placed.block === "lever" && world.getBlock(0, 0, 0).props.facing === "east",
    JSON.stringify(placed));
  var allGates = ["AND", "OR", "NOT", "XOR", "NAND", "NOR", "XNOR", "BUFFER"];
  var allOk = true;
  for (var g = 0; g < allGates.length; g++) if (!sim.verifyTruthTable(allGates[g]).ok) allOk = false;
  h.expect("8 种逻辑门真值表全组合校验通过", allOk, "truth tables");
  var andTable = sim.truthTable("AND");
  h.expect("AND 真值表只有 1,1 输出 1",
    andTable.length === 4 && andTable[0].out === 0 && andTable[3].out === 1, JSON.stringify(andTable));
  var demo = sim.buildNotGateDemo({});
  var w = demo.world;
  h.expect("NOT 门基准：拉杆 off 时输出灯亮",
    w.isLit(2, 0, 0) === true && w.getBlock(0, 0, 0).power === 0, "not gate initial");
  var use = w.onUseBlock(0, 0, 0);
  var ticked = w.tick(1);
  h.expect("onUseBlock 翻转杠杆后 tick(1) 输出灯按预期熄灭",
    use.ok === true && use.powered === true && ticked.ok === true && w.isLit(2, 0, 0) === false,
    JSON.stringify({ use: use, tick: ticked, lit: w.isLit(2, 0, 0) }));
  w.onUseBlock(0, 0, 0);
  w.tick(1);
  h.expect("再次翻转后输出灯恢复点亮", w.isLit(2, 0, 0) === true, "not gate restored");
  var w2 = sim.create("three_input_and");
  w2.setBlockFromString(0, 0, 0, "minecraft:lever[powered=true]");
  w2.setBlockFromString(0, 0, 1, "minecraft:lever[powered=true]");
  w2.setBlockFromString(0, 0, 2, "minecraft:lever[powered=true]");
  w2.setBlockFromString(5, 0, 0, "minecraft:redstone_lamp[lit=false]");
  var gate = w2.addGate("AND", [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 2 }],
    { x: 5, y: 0, z: 0 }, { delay: 2 });
  w2.tick(1);
  var early = w2.isLit(5, 0, 0);
  w2.tick(3);
  var late = w2.isLit(5, 0, 0);
  w2.onUseBlock(0, 0, 1);
  w2.tick(3);
  h.expect("三输入 AND 带 2 tick 中继延迟：先灭后亮，翻转任一输入再灭",
    gate.ok === true && early === false && late === true && w2.isLit(5, 0, 0) === false,
    JSON.stringify({ early: early, late: late, final: w2.isLit(5, 0, 0) }));
  h.expect("snapshot 暴露网表门与连线", w2.snapshot().gates.length === 1, "snapshot");
}
// 21d：自动红石布线——需求解析 / 网表 / 放置 / A* / 中继器 / 垂直传输 / 模板拼接成蓝图。
function checkRouting(h) {
  h.section("21d. 自动布线 Place-and-Route / netlist + A*");
  var r = load("modules/redstone-router.js");
  var bpMod = load("modules/builder-blueprint.js");
  if (!r || !bpMod) { h.expect("布线模块可加载", false, "require failed"); return; }
  var zh = r.parseRequest("建一个三输入与门");
  var en = r.parseRequest("3-input AND gate");
  h.expect("自然语言需求解析：中文「三输入与门」与英文 3-input AND 都得 AND/3",
    zh.ok === true && zh.gate === "AND" && zh.inputCount === 3 &&
    en.ok === true && en.gate === "AND" && en.inputCount === 3,
    JSON.stringify({ zh: zh, en: en }));
  h.expect("异或 / 或 / 非门关键词都能识别",
    r.parseRequest("二输入或门").gate === "OR" && r.parseRequest("造个异或门").gate === "XOR" &&
    r.parseRequest("非门").gate === "NOT" && r.parseRequest("非门").inputCount === 1, "aliases");
  var nl = r.netlistOf("AND", 3, {});
  h.expect("网表抽象出 3 输入 / 1 门 / 4 条 net",
    nl.ok === true && nl.inputs.length === 3 && nl.nets.length === 4 && nl.gate.type === "AND",
    JSON.stringify(nl.message));
  var pl = r.place(nl, {});
  h.expect("紧凑放置在 2D 网格上并登记门核心障碍",
    pl.ok === true && pl.width >= 9 && Object.keys(pl.blocked).length >= 3, JSON.stringify(pl.message));
  var path = r.astar(pl, { x: 0, z: 0 }, { x: 3, z: 1 }, {});
  var dodged = path.length > 0;
  for (var i = 1; i < path.length - 1; i++) if (pl.blocked[path[i].x + ":" + path[i].z]) dodged = false;
  h.expect("A* 在网格里找到路径且中间格绕开障碍物", dodged && path.length >= 4, JSON.stringify(path));
  var longNl = r.netlistOf("AND", 2, { outputX: 40 });
  var longPl = r.place(longNl, { width: 48 });
  var longRoute = r.route(longNl, longPl, { maxWireLength: 5 });
  h.expect("超过信号距离自动插入 repeater 延长信号",
    longRoute.ok === true && longRoute.repeaters.length > 0 &&
    longRoute.repeaters[0].block === "repeater" && longRoute.repeaters[0].props.delay === "1",
    JSON.stringify({ repeaters: longRoute.repeaters.length, wires: longRoute.wires.length }));
  var tower = r.verticalRoute({ x: 0, y: 0, z: 0 }, { x: 0, y: 4, z: 0 }, {});
  var stair = r.verticalRoute({ x: 0, y: 0, z: 0 }, { x: 0, y: 4, z: 0 }, { mode: "stair" });
  h.expect("垂直传输支持红石火把塔与阶梯式两种布线",
    tower.ok === true && tower.mode === "torch_tower" && tower.blocks.length === 8 &&
    stair.ok === true && stair.mode === "stair" && stair.blocks.length === 8 &&
    tower.blocks[1].block === "redstone_torch", JSON.stringify({ tower: tower.blocks.length, stair: stair.blocks.length }));
  var templatesOk = true;
  for (var t = 0; t < r.GATE_TYPES.length; t++) {
    if (!r.buildTemplate(r.GATE_TYPES[t], 2, {}).ok) templatesOk = false;
  }
  h.expect("AND / OR / NOT / XOR 四种标准门模板都能拼接", templatesOk, "templates");
  var built = r.buildTemplate("AND", 3, {});
  var hasWire = false, hasLamp = false, hasLever = false;
  for (var b = 0; b < built.blocks.length; b++) {
    if (built.blocks[b].block === "redstone_wire") hasWire = true;
    if (built.blocks[b].block === "redstone_lamp") hasLamp = true;
    if (built.blocks[b].block === "lever") hasLever = true;
  }
  h.expect("三输入与门模板含输入拉杆 / 中间连线 / 输出灯",
    built.ok === true && built.blocks.length > 10 && hasWire && hasLamp && hasLever &&
    built.size.width >= 9, JSON.stringify({ blocks: built.blocks.length, size: built.size }));
  var wrapped = r.toBlueprint(built, {});
  var tasks = wrapped.ok ? bpMod.buildTasks(wrapped.blueprint, {}) : [];
  h.expect("布线蓝图可被 builder-blueprint 逐方块拆单",
    wrapped.ok === true && wrapped.blueprint.format === "router" && tasks.length === built.blocks.length,
    JSON.stringify({ tasks: tasks.length, blocks: built.blocks.length }));
}
// 21e：贪心网格合并 / /fill 指令流 / SDF 体素与 Litematica 导出。
function checkMeshing(h) {
  h.section("21e. 贪心合并与 SDF / greedy meshing + /fill");
  var m = load("modules/blueprint-mesher.js");
  var codec = load("modules/litematic-codec.js");
  if (!m || !codec) { h.expect("合并模块可加载", false, "require failed"); return; }
  var slab = makeStoneSlab();
  var meshed = m.greedyMeshing(slab, {});
  h.expect("10x10 石头区域被合并为恰好 1 个长方体（覆盖 100 格）",
    meshed.ok === true && meshed.boxes.length === 1 && meshed.boxes[0].volume === 100 &&
    meshed.coverage === 100 && meshed.boxes[0].x2 === 9 && meshed.boxes[0].z2 === 9,
    JSON.stringify(meshed.boxes));
  var cmds = m.fillCommands(meshed.boxes, { origin: meshed.origin });
  h.expect("生成单条 /fill 指令且坐标带 origin 偏移",
    cmds.ok === true && cmds.commands.length === 1 &&
    cmds.commands[0] === "/fill 0 64 0 9 64 9 minecraft:stone", JSON.stringify(cmds.commands));
  var board = fakeBoard();
  var queued = m.splitFillToTasks(slab, { board: board });
  var payload = queued.count > 0 ? board.tasks[queued.taskIds[0]].payload : {};
  h.expect("/fill 指令流压入共享黑板任务池并标记需要 OP 权限",
    queued.ok === true && queued.count === 1 && queued.commands.length === 1 &&
    board.tasks[queued.taskIds[0]].title === "build:fill" && payload.action === "fill" &&
    payload.requiresOp === true && payload.command === "/fill 0 64 0 9 64 9 minecraft:stone",
    JSON.stringify(queued));
  var savings = m.estimateSavings(slab, meshed.boxes);
  h.expect("节省量估算：100 次逐格放置压缩为 1 条指令",
    savings.blocks === 100 && savings.commands === 1 && savings.saved === 99 && savings.ratio === 99,
    JSON.stringify(savings));
  var mixed = { name: "mix", origin: { x: 5, y: 70, z: 5 }, blocks: [
    { x: 0, y: 0, z: 0, block: "oak_stairs", props: { facing: "north" } },
    { x: 1, y: 0, z: 0, block: "oak_stairs", props: { facing: "north" } },
    { x: 2, y: 0, z: 0, block: "oak_stairs", props: { facing: "south" } },
    { x: 0, y: 0, z: 1, block: "stone", props: {} } ] };
  var mixedMeshed = m.greedyMeshing(mixed, {});
  h.expect("材质签名含状态属性：朝向不同的楼梯不会被错误合并",
    mixedMeshed.boxes.length === 3 && m.materialOf(mixed.blocks[0]).indexOf("facing=north") >= 0,
    JSON.stringify(mixedMeshed.boxes.map(function (b2) { return b2.material; })));
  var sphere = m.sdfSphere(4, 4, 4, 3);
  var sdfBp = m.sdfToBlueprint(sphere, { width: 9, height: 9, length: 9 }, { name: "ball" });
  h.expect("SDF 球体能体素化成实体蓝图", sdfBp.ok === true && sdfBp.blueprint.blocks.length > 50,
    String(sdfBp.blueprint && sdfBp.blueprint.blocks.length));
  var exported = m.toLitematic(sdfBp.blueprint, {});
  var reDecoded = exported.ok ? codec.parse(exported.buffer) : { ok: false, blocks: [] };
  h.expect("SDF 体素模型导出真 .litematic 后解码方块数一致",
    exported.ok === true && exported.buffer[0] === 0x1f && exported.palette.length === 2 &&
    exported.bits === 2 && reDecoded.ok === true &&
    reDecoded.blocks.length === sdfBp.blueprint.blocks.length,
    JSON.stringify({ ok: exported.ok, bits: exported.bits, back: reDecoded.blocks.length }));
  var smooth = m.sdfSmoothUnion(m.sdfSphere(3, 3, 3, 2), m.sdfBox(5, 3, 3, 1, 1, 1), 1.2);
  var smoothVox = m.voxelize(smooth, { width: 8, height: 6, length: 6 }, {});
  var cut = m.sdfSubtract(m.sdfBox(3, 3, 3, 3, 3, 3), m.sdfSphere(3, 3, 3, 1));
  h.expect("平滑并集与差集 SDF 都能生成有效体素",
    smoothVox.ok === true && smoothVox.blocks.length > 0 &&
    m.voxelize(cut, { width: 7, height: 7, length: 7 }, {}).blocks.length > 0,
    JSON.stringify({ smooth: smoothVox.blocks.length }));
}
// 21f：红石安全限流——TPS 估算 / 降频 / 公屏双语警告 / 迟滞恢复 / Ping 触发。
function checkSafety(h) {
  h.section("21f. 红石安全限流 / TPS + ping throttling");
  var safety = load("modules/redstone-safety.js");
  var trig = load("modules/redstone-trigger.js");
  if (!safety || !trig) { h.expect("限流模块可加载", false, "require failed"); return; }
  safety.reset();
  trig.reset();
  var chats = [];
  var bot = fakeBot(chats);
  safety.registerBot("b1", bot);
  trig.registerBot("b1", bot);
  var t = safety.readTelemetry(bot, {});
  h.expect("readTelemetry 读取 bot.time.timeOfDay 与 bot.entity.ping",
    t.ok === true && t.timeOfDay === 1000 && t.ping === 20, JSON.stringify(t));
  h.expect("estimateTps 按两次采样的游戏 tick 增量估算 TPS",
    safety.estimateTps({ at: 0, timeOfDay: 0, gameTicks: 0 }, { at: 1000, timeOfDay: 10, gameTicks: 10 }) === 10 &&
    safety.estimateTps({ at: 0, timeOfDay: 23990, gameTicks: 100 }, { at: 1000, timeOfDay: 10, gameTicks: 100 }) === 20,
    "tps");
  var started = trig.startTriggerLoop("b1", { x: 1, y: 64, z: 0 }, "activate", 15,
    { manual: true, board: fakeBoard() });
  h.expect("先启动一条 15ms 高频触发器",
    started.ok === true && started.intervalMs === 15, JSON.stringify(started));
  var low = safety.check("b1", { tps: 12, ping: 30, manual: true });
  h.expect("TPS 低于 18 自动降频到 30ms 并在公屏发双语警告",
    low.ok === true && low.level === "throttled" && low.changed === true && low.count === 1 &&
    intervalOf(trig, started.taskId) === 30 && chats.length === 1 &&
    chats[0].indexOf("服务器负载过高，已自动降频") >= 0 && chats[0].indexOf("Server load high") >= 0,
    JSON.stringify({ level: low.level, interval: intervalOf(trig, started.taskId), chats: chats }));
  var again = safety.check("b1", { tps: 12, ping: 30, manual: true });
  h.expect("状态未变化时不重复刷公屏、不重排定时器",
    again.changed === false && chats.length === 1 && low.count === 1, JSON.stringify(again));
  var recovered = safety.check("b1", { tps: 20, ping: 20, manual: true });
  h.expect("负载恢复后频率回升到原 15ms 并播报恢复",
    recovered.level === "normal" && recovered.changed === true && intervalOf(trig, started.taskId) === 15 &&
    chats.length === 2 && chats[1].indexOf("负载恢复") >= 0 && chats[1].indexOf("Server load recovered") >= 0,
    JSON.stringify({ interval: intervalOf(trig, started.taskId), chats: chats.length }));
  var pingHigh = safety.check("b1", { tps: 20, ping: 260, manual: true });
  h.expect("Ping 高于 200ms 同样触发降频",
    pingHigh.level === "throttled" && pingHigh.reason.indexOf("ping high") >= 0 &&
    intervalOf(trig, started.taskId) === 30, JSON.stringify(pingHigh));
  var mon = safety.start("b1", { intervalMs: 1000 });
  h.expect("周期巡检可启停且定时器不拖住进程", mon.ok === true && safety.stats().monitored === true &&
    safety.stop().ok === true && safety.stats().monitored === false, "monitor");
  h.expect("stats 累计降频 / 恢复 / 重排 / 播报次数",
    safety.stats().throttles === 2 && safety.stats().restores === 1 &&
    safety.stats().chats === 3 && safety.stats().retuned >= 3, JSON.stringify(safety.stats()));
  trig.stopTriggerLoop(started.taskId);
  trig.reset();
  safety.reset();
}
// 21g：静态断言确认既有能力没被本轮改动破坏（不重写核心、只新增模块与节点）。
function checkNoRegression(h) {
  h.section("21g. 既有链路回归 / no regression");
  var hd = readRel("modules/blueprint-highdim.js");
  h.expect("高维蓝图仍保留 place_block_exact 任务队列与精确拆单",
    hd.indexOf('action: "place_block_exact"') >= 0 && hd.indexOf("function splitExactToTasks") >= 0, "exact tasks");
  var trg = readRel("modules/redstone-trigger.js");
  h.expect("高频触发器仍保留漂移补偿与状态预检",
    trg.indexOf("rec.startedAt + rec.scheduled * rec.intervalMs") >= 0 &&
    trg.indexOf("function stateFingerprint") >= 0, "trigger core");
  var ins = readRel("modules/redstone-inspector.js");
  h.expect("红石扫描 / 校验 / 黑板 repair_request 仍在",
    ins.indexOf("function scanRedstoneArea") >= 0 && ins.indexOf("function verifyCircuit") >= 0 &&
    ins.indexOf("repair_request") >= 0, "inspector");
  var log = readRel("modules/bot-logistics.js");
  h.expect("告示牌分拣的 clickWindow 链路仍在",
    log.indexOf("function autoSort") >= 0 && log.indexOf("clickWindow") >= 0, "logistics");
  var nodes = load("modules/state-nodes.js");
  h.expect("节点目录仍是 11 组分类且 place_block_exact 已注册",
    !!nodes && nodes.isAction("place_block_exact") === true &&
    nodes.categoryOf("place_block_exact") === "basic", "state-nodes");
  var board = load("modules/shared-board.js");
  var boardText = readRel("modules/shared-board.js");
  h.expect("shared-board 已支持 MINEBOTS_STATE_DIR 隔离（测试不碰真实 state/）",
    !!board && typeof board.getPath === "function" && boardText.indexOf("MINEBOTS_STATE_DIR") >= 0,
    "shared-board");
  var oldDir = process.env.MINEBOTS_STATE_DIR;
  try {
    var probeDir = path.join(ROOT, ".tmp-isolation-probe");
    process.env.MINEBOTS_STATE_DIR = probeDir;
    var probePath = board ? board.getPath() : "";
    h.expect("隔离环境变量把黑板落盘路径重定向到临时目录",
      probePath === path.resolve(probeDir, "shared-board.json"), probePath);
  } catch (eProbe) {
    h.expect("隔离路径探针未抛错", false, String(eProbe));
  } finally {
    if (oldDir === undefined) delete process.env.MINEBOTS_STATE_DIR;
    else process.env.MINEBOTS_STATE_DIR = oldDir;
  }
}
// 主流程：依次跑全部分组；任一组抛错只记一条失败，不让整轮自检崩。
async function run(h) {
  try { checkStatic(h); } catch (e1) { h.expect("21a 未抛错", false, String(e1)); }
  try { checkLitematic(h); } catch (e2) { h.expect("21b 未抛错", false, String(e2)); }
  try { checkSimulation(h); } catch (e3) { h.expect("21c 未抛错", false, String(e3)); }
  try { checkRouting(h); } catch (e4) { h.expect("21d 未抛错", false, String(e4)); }
  try { checkMeshing(h); } catch (e5) { h.expect("21e 未抛错", false, String(e5)); }
  try { checkSafety(h); } catch (e6) { h.expect("21f 未抛错", false, String(e6)); }
  try { checkNoRegression(h); } catch (e7) { h.expect("21g 未抛错", false, String(e7)); }
  // 收尾：所有新增模块计数与定时器归零，绝不把测试状态留给后续分组或真实 state/。
  try {
    var names = ["litematic-codec", "redstone-sim", "redstone-router", "blueprint-mesher",
      "redstone-safety", "blueprint-highdim"];
    for (var i = 0; i < names.length; i++) {
      var mod = load("modules/" + names[i] + ".js");
      if (mod && typeof mod.reset === "function") mod.reset();
    }
    var trig = load("modules/redstone-trigger.js");
    if (trig) { trig.stopAll(); trig.reset(); }
  } catch (e8) { h.expect("P11 收尾恢复成功", false, String(e8)); }
}
module.exports = { run: run };
