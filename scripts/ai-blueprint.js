// ========================================
// 文件：scripts/ai-blueprint.js
// 功能：让 AI 现场生成建筑蓝图（支持大体量分段生成）——规划 → 分段出块 → 合并校验 → 落盘
// 依赖：fs / path（Node 内置）；axios；../modules/json-repair（可选）
// 导出：generate / generateLarge / plan / section / normalizeBlocks
// 说明：只读 state/ai-config.json，不打印密钥。大体量建筑拆成多段分别请求，避免单次输出被 token 截断。
// 作者：MineBots
// ========================================
var fs = require("fs");
var path = require("path");
var axios = require("axios");

var ROOT = path.resolve(__dirname, "..");
var OUT_DIR = path.join(ROOT, "state", "blueprints");

var PALETTE = [
  "quartz_block", "smooth_quartz", "quartz_pillar", "polished_deepslate", "deepslate_tiles",
  "gold_block", "sea_lantern", "glass", "light_blue_stained_glass", "red_terracotta",
  "yellow_terracotta", "oak_planks", "spruce_planks", "spruce_stairs", "dark_oak_planks",
  "stone_bricks", "chiseled_stone_bricks", "lantern", "red_wool", "white_concrete"
];

function say(m) {
  try { console.log("[ai-blueprint] " + m); } catch (e) { /* ignore */ }
}
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// 读本机 AI 配置。
function loadConfig() {
  try {
    var c = JSON.parse(fs.readFileSync(path.join(ROOT, "state", "ai-config.json"), "utf8"));
    return {
      baseUrl: String(c.baseUrl || "https://api.deepseek.com/v1").replace(/\/+$/, ""),
      apiKey: String(c.apiKey || ""),
      model: String(process.env.MINEBOTS_AI_MODEL || c.model || "deepseek-flash")
    };
  } catch (e) { return null; }
}

// 调 OpenAI 兼容接口，返回文本。
async function callModel(cfg, sys, user, maxTokens) {
  var body = {
    model: cfg.model,
    messages: [{ role: "system", content: sys }, { role: "user", content: user }],
    temperature: 0.2,
    max_tokens: maxTokens || 8000,
    response_format: { type: "json_object" }
  };
  var res = await axios.post(cfg.baseUrl + "/chat/completions", body, {
    headers: { Authorization: "Bearer " + cfg.apiKey, "Content-Type": "application/json" },
    timeout: 180000
  });
  var text = res && res.data && res.data.choices && res.data.choices[0] && res.data.choices[0].message
    ? res.data.choices[0].message.content : "";
  return { ok: !!text, text: String(text || ""), usage: res && res.data ? res.data.usage : null };
}

// 解析 JSON（先 repair 再原生）。
function safeJson(text) {
  var repair = null;
  try { repair = require(path.join(ROOT, "modules", "json-repair.js")); } catch (e) { repair = null; }
  var raw = null;
  if (repair && typeof repair.safeParse === "function") raw = repair.safeParse(text, null);
  if (!raw) { try { raw = JSON.parse(text); } catch (e2) { raw = null; } }
  return raw;
}

// 方块名归一化：短名补命名空间，非法名回退石英。
function normBlock(name) {
  var n = String(name || "").trim().toLowerCase().replace(/^minecraft:/, "");
  if (!n) return "minecraft:quartz_block";
  if (!/^[a-z_]+$/.test(n)) return "minecraft:quartz_block";
  return "minecraft:" + n;
}

// 把 [x,y,z,"name"] 或 {x,y,z,name} 统一成对象数组。
function normalizeBlocks(list, offset) {
  var out = [];
  var off = offset || { x: 0, y: 0, z: 0 };
  if (!Array.isArray(list)) return out;
  for (var i = 0; i < list.length; i++) {
    var it = list[i];
    if (Array.isArray(it) && it.length >= 4) {
      out.push({
        x: Math.round(Number(it[0]) || 0) + off.x,
        y: Math.round(Number(it[1]) || 0) + off.y,
        z: Math.round(Number(it[2]) || 0) + off.z,
        name: normBlock(it[3])
      });
    } else if (it && typeof it === "object") {
      out.push({
        x: Math.round(Number(it.x) || 0) + off.x,
        y: Math.round(Number(it.y) || 0) + off.y,
        z: Math.round(Number(it.z) || 0) + off.z,
        name: normBlock(it.name || it.block)
      });
    }
  }
  return out;
}

// 第一步：整体规划（尺寸 + 分段 + 配色）。
async function plan(cfg, desc) {
  var sys = [
    "你是 Minecraft 大型建筑总监，负责出施工规划。只输出 JSON，不要解释。",
    "输出结构：{\"name\":\"英文短名\",\"size\":{\"x\":整数,\"y\":整数,\"z\":整数},\"palette\":[\"方块短名\"],\"sections\":[{\"id\":\"英文id\",\"title\":\"中文名\",\"bbox\":{\"x0\":0,\"y0\":0,\"z0\":0,\"x1\":0,\"y1\":0,\"z1\":0},\"hint\":\"这一段怎么建\"}]}",
    "要求：分段 8-10 个，覆盖台基 / 墙身 / 门窗 / 屋檐 / 屋顶 / 角楼；bbox 用整数且整体拼成一座完整、左右对称的建筑。",
    "尺寸上限：x 与 z 不超过 44，y 不超过 36。可用方块：" + PALETTE.join(",")
  ].join("\n");
  var r = await callModel(cfg, sys, "建筑需求：" + desc + "\n只输出 json。", 8000);
  if (!r.ok) return { ok: false, message: "规划没有返回" };
  var j = safeJson(r.text);
  if (!j || !Array.isArray(j.sections) || !j.sections.length) return { ok: false, message: "规划 JSON 无效", text: r.text };
  return { ok: true, plan: j, usage: r.usage };
}

// 第二步：逐段出方块（独立请求，避免单次截断）。
async function section(cfg, p, sec, attempt) {
  var b = sec.bbox || {};
  var sys = [
    "你是 Minecraft 建筑细节生成器。只输出 json：{\"blocks\":[[x,y,z,\"短方块名\"], ...]}，不要解释。",
    "坐标从 0 开始，必须严格落在给定立方体内，越界块会被丢弃。",
    "结构要连续：墙体不留缝、楼板铺满、屋檐逐层外扩、屋顶逐层收口；门窗位置留空。",
    "可用方块：" + PALETTE.join(","),
    "本段块数 400-900。"
  ].join("\n");
  var user = [
    "建筑：" + (p.name || "building") + "，整体尺寸 x=" + (p.size && p.size.x) + " y=" + (p.size && p.size.y) + " z=" + (p.size && p.size.z),
    "本段：" + (sec.title || sec.id) + "，范围 x[" + b.x0 + "," + b.x1 + "] y[" + b.y0 + "," + b.y1 + "] z[" + b.z0 + "," + b.z1 + "]",
    "本段说明：" + (sec.hint || "按对称规则填满这段结构"),
    attempt > 1 ? "上次输出不合格：这次必须是合法 JSON，且只包含本段坐标。" : ""
  ].join("\n");
  var r = await callModel(cfg, sys, user + "\n只输出 json。", 16000);
  if (!r.ok) return { ok: false, message: "本段无返回" };
  var j = safeJson(r.text);
  var list = j && (j.blocks || (Array.isArray(j) ? j : null));
  if (!list || !list.length) return { ok: false, message: "本段 JSON 无效", text: r.text };
  return { ok: true, blocks: normalizeBlocks(list), usage: r.usage };
}

// 合并 + 去重 + 越界裁剪。
function merge(all, size) {
  var seen = {};
  var out = [];
  var clipped = 0;
  for (var i = 0; i < all.length; i++) {
    var b = all[i];
    if (b.x < 0 || b.y < 0 || b.z < 0 || b.x >= size.x || b.y >= size.y || b.z >= size.z) { clipped++; continue; }
    var k = b.x + "," + b.y + "," + b.z;
    if (seen[k]) continue;
    seen[k] = 1;
    out.push(b);
  }
  return { blocks: out, clipped: clipped };
}

// 统计材料。
function statsOf(blocks) {
  var counts = {};
  for (var i = 0; i < blocks.length; i++) {
    var n = String(blocks[i].name || "unknown").replace("minecraft:", "");
    counts[n] = (counts[n] || 0) + 1;
  }
  var keys = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
  return { total: blocks.length, kinds: keys.length, top: keys.slice(0, 8).map(function (k) { return k + "×" + counts[k]; }) };
}

// 主流程：规划 → 分段 → 合并 → 落盘。
async function generateLarge(desc, name) {
  var cfg = loadConfig();
  if (!cfg) return { ok: false, message: "读不到 AI 配置" };
  if (!cfg.apiKey) return { ok: false, message: "AI Key 为空" };
  say("模型 / model: " + cfg.model + " | 需求: " + desc);
  var t0 = Date.now();

  var p = await plan(cfg, desc);
  if (!p.ok) return { ok: false, message: "规划失败: " + p.message };
  var pl = p.plan;
  var size = pl.size || { x: 32, y: 24, z: 32 };
  size = {
    x: Math.min(44, Math.max(8, Number(size.x) || 32)),
    y: Math.min(36, Math.max(6, Number(size.y) || 24)),
    z: Math.min(44, Math.max(8, Number(size.z) || 32))
  };
  say("规划 / plan: " + (pl.name || name) + " size=" + size.x + "x" + size.y + "x" + size.z + " sections=" + pl.sections.length);

  var all = [];
  var failed = [];
  for (var i = 0; i < pl.sections.length; i++) {
    var sec = pl.sections[i];
    var r = await section(cfg, pl, sec, 1);
    if (!r.ok) r = await section(cfg, pl, sec, 2);
    if (r.ok && r.blocks.length) {
      all = all.concat(r.blocks);
      say("  段 " + (i + 1) + "/" + pl.sections.length + " " + (sec.id || "") + " -> " + r.blocks.length + " 块");
    } else {
      failed.push(sec.id || ("s" + i));
      say("  段 " + (i + 1) + "/" + pl.sections.length + " 失败 / failed: " + r.message);
    }
    await wait(250);
  }

  var m = merge(all, size);
  var stats = statsOf(m.blocks);
  var ms = Date.now() - t0;
  if (!m.blocks.length) return { ok: false, message: "没有任何可用方块" };

  try {
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    var out = path.join(OUT_DIR, String(name || "ai-large") + ".json");
    fs.writeFileSync(out, JSON.stringify({
      name: pl.name || name,
      desc: desc,
      model: cfg.model,
      ms: ms,
      size: size,
      palette: pl.palette || [],
      sections: pl.sections.map(function (s) { return { id: s.id, title: s.title, bbox: s.bbox }; }),
      blocks: m.blocks
    }), "utf8");
    say("已保存 / saved: " + out);
    say("统计 / stats: " + stats.total + " 块 / " + stats.kinds + " 种 | 裁剪越界 " + m.clipped + " | 失败段 " + (failed.length ? failed.join(",") : "无") + " | 耗时 " + ms + "ms");
    return { ok: true, file: out, stats: stats, ms: ms, size: size, sections: pl.sections.length, failed: failed, clipped: m.clipped };
  } catch (e) { return { ok: false, message: "写文件失败: " + (e && e.message) }; }
}

// 兼容旧接口：单次生成（小建筑）。
async function generate(desc, name) {
  return generateLarge(desc, name);
}

if (require.main === module) {
  var desc = process.argv[2] || "一座故宫太和殿风格的大殿，三层汉白玉台基，重檐屋顶，红墙金瓦，左右对称";
  var name = process.argv[3] || "ai-palace";
  generateLarge(desc, name).then(function (r) {
    say("结果 / result: " + JSON.stringify({ ok: r.ok, file: r.file, stats: r.stats, sections: r.sections, failed: r.failed, ms: r.ms, message: r.message }));
    process.exit(r.ok ? 0 : 1);
  }).catch(function (e) { say("致命 / fatal: " + (e && e.message)); process.exit(1); });
}

module.exports = { generate: generate, generateLarge: generateLarge, plan: plan, section: section, normalizeBlocks: normalizeBlocks };
