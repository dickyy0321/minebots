// ========================================
// 文件：scripts/palace.js
// 功能：参数化大型宫殿生成器——AI 只出「方案 JSON」（尺寸/台基层数/开间/配色），几何由引擎按方案展开
// 依赖：fs / path / axios（Node 内置 + 已装）；无第三方图形库
// 导出：generate / specOf / buildFromSpec
// 说明：为什么不让模型直接吐上万块坐标——单次回复会被 token 截断，且越界/重叠无法保证。
//       方案层交给模型（几 KB），几何层交给确定性代码，才能稳定产出 44×28 的对称大殿。
// 作者：MineBots
// ========================================
var fs = require("fs");
var path = require("path");
var axios = require("axios");

var ROOT = path.resolve(__dirname, "..");
var OUT_DIR = path.join(ROOT, "state", "blueprints");

function say(m) { try { console.log("[palace] " + m); } catch (e) { /* ignore */ } }

// 读 AI 配置（只取字段，不打印密钥）。
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

// 默认方案：模型不可用时也能出图（会在日志里标明）。
function defaultSpec() {
  return {
    name: "taihe_hall",
    width: 44,
    depth: 28,
    terraceTiers: 3,
    tierHeight: 2,
    wallHeight: 9,
    bays: 7,
    roofTiers: 2,
    palette: {
      terrace: "quartz_block",
      terraceEdge: "smooth_quartz",
      wall: "red_terracotta",
      pillar: "gold_block",
      beam: "dark_oak_planks",
      roof: "yellow_terracotta",
      roofEdge: "gold_block",
      floor: "smooth_quartz",
      light: "lantern"
    }
  };
}

// 让模型给方案（小 JSON，快且稳）。
async function specOf(desc) {
  var cfg = loadConfig();
  if (!cfg || !cfg.apiKey) return { ok: false, spec: defaultSpec(), message: "无 AI 配置，用内置方案" };
  var sys = [
    "你是中国古建设计师。只输出 json，不要解释。",
    "输出：{\"name\":\"英文名\",\"width\":整数,\"depth\":整数,\"terraceTiers\":1-3,\"tierHeight\":2-3,\"wallHeight\":7-11,\"bays\":5-9,\"roofTiers\":1-2,",
    "\"palette\":{\"terrace\":\"\",\"terraceEdge\":\"\",\"wall\":\"\",\"pillar\":\"\",\"beam\":\"\",\"roof\":\"\",\"roofEdge\":\"\",\"floor\":\"\",\"light\":\"\"}}",
    "width 28-44，depth 20-30；方块只能用常见方块短名（如 quartz_block / red_terracotta / gold_block / yellow_terracotta / dark_oak_planks / lantern）。"
  ].join("\n");
  try {
    var r = await axios.post(cfg.baseUrl + "/chat/completions", {
      model: cfg.model,
      messages: [{ role: "system", content: sys }, { role: "user", content: "建筑需求：" + desc + "\n只输出 json。" }],
      temperature: 0.3, max_tokens: 6000, response_format: { type: "json_object" }
    }, { headers: { Authorization: "Bearer " + cfg.apiKey }, timeout: 120000 });
    var txt = r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message
      ? String(r.data.choices[0].message.content || "") : "";
    var j = null;
    try { j = JSON.parse(txt); } catch (e1) { j = null; }
    if (!j || !j.width) return { ok: false, spec: defaultSpec(), message: "模型方案无效，用内置方案" };
    var base = defaultSpec();
    var out = {
      name: String(j.name || base.name), width: Number(j.width) || base.width, depth: Number(j.depth) || base.depth,
      terraceTiers: Math.max(1, Math.min(3, Number(j.terraceTiers) || 3)),
      tierHeight: Math.max(2, Math.min(3, Number(j.tierHeight) || 2)),
      wallHeight: Math.max(7, Math.min(11, Number(j.wallHeight) || 9)),
      bays: Math.max(5, Math.min(9, Number(j.bays) || 7)),
      roofTiers: Math.max(1, Math.min(2, Number(j.roofTiers) || 2)),
      palette: {}
    };
    var keys = ["terrace", "terraceEdge", "wall", "pillar", "beam", "roof", "roofEdge", "floor", "light"];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var v = j.palette && j.palette[k] ? String(j.palette[k]).replace(/^minecraft:/, "") : base.palette[k];
      out.palette[k] = /^[a-z_]+$/.test(v) ? v : base.palette[k];
    }
    return { ok: true, spec: out, model: cfg.model, ms: r.data && r.data.usage ? "ok" : "ok" };
  } catch (e) {
    return { ok: false, spec: defaultSpec(), message: "模型调用失败，用内置方案: " + (e && e.message) };
  }
}

// 几何展开：台基 → 柱网 → 墙 → 斗拱层 → 重檐屋顶 → 屋脊。全部对称。
function buildFromSpec(spec) {
  var s = spec || defaultSpec();
  var p = s.palette;
  var blocks = [];
  var seen = {};
  function put(x, y, z, name) {
    var k = x + "," + y + "," + z;
    if (seen[k]) return;
    seen[k] = 1;
    blocks.push({ x: x, y: y, z: z, name: "minecraft:" + name });
  }
  var W = s.width, D = s.depth;
  var cx = Math.floor(W / 2), cz = Math.floor(D / 2);
  var y = 0;
  var i, j, t;

  // 1) 台基：逐层内收，边缘用亮色，顶层铺地
  for (t = 0; t < s.terraceTiers; t++) {
    var inset = t * 2;
    var x0 = inset, x1 = W - 1 - inset, z0 = inset, z1 = D - 1 - inset;
    for (var yy = 0; yy < s.tierHeight; yy++) {
      for (i = x0; i <= x1; i++) {
        for (j = z0; j <= z1; j++) {
          var edge = (i === x0 || i === x1 || j === z0 || j === z1);
          put(i, y + yy, j, edge ? p.terraceEdge : p.terrace);
        }
      }
    }
    y += s.tierHeight;
  }
  // 顶层铺地
  var topInset = (s.terraceTiers - 1) * 2;
  for (i = topInset; i < W - topInset; i++) {
    for (j = topInset; j < D - topInset; j++) put(i, y, j, p.floor);
  }
  y += 1;

  // 2) 柱网 + 墙：面阔 bays 间，柱子落在开间缝上
  var bx0 = 4, bx1 = W - 5, bz0 = 4, bz1 = D - 5;
  var bodyTop = y + s.wallHeight;
  var stepX = Math.max(3, Math.floor((bx1 - bx0) / s.bays));
  for (i = bx0; i <= bx1; i++) {
    for (j = bz0; j <= bz1; j++) {
      var onWall = (i === bx0 || i === bx1 || j === bz0 || j === bz1);
      if (!onWall) continue;
      for (var w = y; w < bodyTop; w++) {
        var isPillarX = ((i - bx0) % stepX === 0) && (j === bz0 || j === bz1);
        var isPillarZ = ((j - bz0) % stepX === 0) && (i === bx0 || i === bx1);
        if (isPillarX || isPillarZ) { put(i, w, j, p.pillar); continue; }
        // 门窗洞口：中间三间、离地 2 格高处开 3x4 的洞
        var inDoorBay = Math.abs(i - cx) <= Math.floor(stepX / 2) && (j === bz0 || j === bz1);
        var opening = inDoorBay && (w >= y + 1 && w < y + 5);
        if (opening) continue;
        put(i, w, j, p.wall);
      }
    }
  }
  // 3) 斗拱层：外扩一圈横梁
  for (i = bx0 - 1; i <= bx1 + 1; i++) {
    for (j = bz0 - 1; j <= bz1 + 1; j++) {
      if (i > bx0 - 1 && i < bx1 + 1 && j > bz0 - 1 && j < bz1 + 1) continue;
      put(i, bodyTop, j, p.beam);
      put(i, bodyTop + 1, j, p.roofEdge);
    }
  }

  // 4) 重檐：每层屋檐逐层内收，形成坡面
  var roofY = bodyTop + 2;
  for (t = 0; t < s.roofTiers; t++) {
    var shrink = t * 4;
    var rx0 = 1 + shrink, rx1 = W - 2 - shrink, rz0 = 1 + shrink, rz1 = D - 2 - shrink;
    var layers = 4;
    for (var L = 0; L < layers; L++) {
      var ix0 = rx0 + L, ix1 = rx1 - L, iz0 = rz0 + L, iz1 = rz1 - L;
      if (ix1 <= ix0 || iz1 <= iz0) break;
      for (i = ix0; i <= ix1; i++) {
        for (j = iz0; j <= iz1; j++) {
          var rim = (i === ix0 || i === ix1 || j === iz0 || j === iz1);
          if (!rim) continue;
          put(i, roofY + L, j, (L === 2) ? p.roofEdge : p.roof);
        }
      }
    }
    roofY += layers;
    // 层间腰线
    for (i = rx0; i <= rx1; i++) { put(i, roofY, rz0, p.roof); put(i, roofY, rz1, p.roof); }
    for (j = rz0; j <= rz1; j++) { put(rx0, roofY, j, p.roof); put(rx1, roofY, j, p.roof); }
    roofY += 1;
  }

  // 5) 正脊 + 宝顶
  for (i = 4; i < W - 4; i++) put(i, roofY, cz, p.roofEdge);
  for (j = cz - 2; j <= cz + 2; j++) {
    for (i = cx - 2; i <= cx + 2; i++) {
      if (Math.abs(i - cx) + Math.abs(j - cz) > 2) continue;
      put(i, roofY + 1, j, p.roofEdge);
    }
  }
  put(cx, roofY + 2, cz, p.pillar);
  put(cx, roofY + 3, cz, p.light);

  // 6) 四角灯
  var corners = [[bx0, bz0], [bx0, bz1], [bx1, bz0], [bx1, bz1]];
  for (t = 0; t < corners.length; t++) put(corners[t][0], bodyTop + 1, corners[t][1], p.light);

  return { spec: s, blocks: blocks };
}

// 主流程：方案（模型/内置）→ 几何 → 落盘。
async function generate(desc, name) {
  var t0 = Date.now();
  var sp = await specOf(desc);
  say("方案来源 / spec: " + (sp.ok ? "model(" + sp.model + ")" : "builtin") + " | " + (sp.message || "ok"));
  var built = buildFromSpec(sp.spec);
  var ms = Date.now() - t0;
  var counts = {};
  for (var i = 0; i < built.blocks.length; i++) {
    var n = built.blocks[i].name.replace("minecraft:", "");
    counts[n] = (counts[n] || 0) + 1;
  }
  var keys = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
  var out = {
    name: String(name || sp.spec.name || "palace"),
    desc: desc,
    spec: sp.spec,
    specFrom: sp.ok ? "model" : "builtin",
    model: sp.model || "",
    ms: ms,
    blocks: built.blocks
  };
  try {
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    var file = path.join(OUT_DIR, out.name + ".json");
    fs.writeFileSync(file, JSON.stringify(out), "utf8");
    say("已保存 / saved: " + file);
    say("方块 / blocks: " + built.blocks.length + " | 种类 " + keys.length + " | " + keys.slice(0, 6).join(" "));
    return { ok: true, file: file, blocks: built.blocks.length, kinds: keys.length, ms: ms, spec: sp.spec };
  } catch (e) { return { ok: false, message: "写文件失败: " + (e && e.message) }; }
}

if (require.main === module) {
  var desc = process.argv[2] || "故宫太和殿风格大殿，三层汉白玉台基，重檐歇山顶，红墙金瓦";
  var name = process.argv[3] || "ai-palace";
  generate(desc, name).then(function (r) {
    say("结果 / result: " + JSON.stringify({ ok: r.ok, file: r.file, blocks: r.blocks, kinds: r.kinds, ms: r.ms, message: r.message }));
    process.exit(r.ok ? 0 : 1);
  }).catch(function (e) { say("致命 / fatal: " + (e && e.message)); process.exit(1); });
}

module.exports = { generate: generate, specOf: specOf, buildFromSpec: buildFromSpec, defaultSpec: defaultSpec };
