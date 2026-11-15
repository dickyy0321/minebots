// ========================================
// 文件：scripts/skyscraper.js
// 功能：参数化超高层生成器——退台式塔楼（金茂 / 苹果园区那种现代玻璃幕墙风格）
// 依赖：fs / path；../scripts/qa-env（不需要，仅写 JSON）
// 导出：generate / buildFromSpec / defaultSpec
// 说明：塔楼是「壳」不是实心——四壁 + 每 N 层楼板 + 竖向幕墙竖梃 + 顶部收分塔冠 + 尖顶。
//       这样 1.3 万块就能做出 86 格高的塔，实心会到 10 万块，任何服务端都放不动。
// 作者：MineBots
// ========================================
var fs = require("fs");
var path = require("path");

var ROOT = path.resolve(__dirname, "..");
var OUT_DIR = path.join(ROOT, "state", "blueprints");

function say(m) { try { console.log("[skyscraper] " + m); } catch (e) { /* ignore */ } }

function defaultSpec() {
  return {
    name: "jinmao_tower",
    baseW: 26,
    podiumH: 8,
    sections: [
      { w: 22, h: 18 },
      { w: 18, h: 14 },
      { w: 10, h: 8 },
      { w: 14, h: 10 }
    ],
    slabEvery: 4,
    spireH: 10,
    palette: {
      glass: "light_blue_stained_glass",
      mullion: "quartz_pillar",
      frame: "polished_deepslate",
      slab: "polished_deepslate",
      podium: "polished_deepslate",
      crown: "gold_block",
      spire: "quartz_pillar",
      light: "sea_lantern"
    }
  };
}

// 生成几何：台基 → 退台塔身（幕墙 + 竖梃 + 楼板）→ 塔冠 → 尖顶。
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

  var Wmax = s.baseW;
  var cx = Math.floor(Wmax / 2);
  var y = 0;

  // 1) 裙楼：三层退台，深色石材，四面开落地窗
  var podW = Wmax;
  for (var ph = 0; ph < 3; ph++) {
    var x0 = cx - Math.floor(podW / 2), x1 = x0 + podW - 1;
    for (var h = 0; h < 3; h++) {
      var yy = y + ph * 3 + h;
      for (var i = x0; i <= x1; i++) {
        for (var j = x0; j <= x1; j++) {
          var edge = (i === x0 || i === x1 || j === x0 || j === x1);
          if (!edge) continue;
          var corner = (i === x0 || i === x1) && (j === x0 || j === x1);
          var isWindow = (h === 1) && !corner && ((i - x0) % 6 !== 0) && ((j - x0) % 6 !== 0);
          if (isWindow) put(i, yy, j, p.glass);
          else if (corner) put(i, yy, j, p.mullion);
          else put(i, yy, j, (h === 0) ? p.podium : p.frame);
        }
      }
    }
    // 裙楼楼板
    for (var si = x0 + 1; si < x1; si++) {
      for (var sj = x0 + 1; sj < x1; sj++) put(si, y + ph * 3 + 3, sj, p.slab);
    }
    podW -= 4;
  }
  y += 9;

  // 2) 塔身：逐段退台，每段幕墙 + 每 slabEvery 层楼板
  for (var k = 0; k < s.sections.length; k++) {
    var sec = s.sections[k];
    var w = sec.w, hh = sec.h;
    var sx0 = cx - Math.floor(w / 2), sx1 = sx0 + w - 1;
    for (var y2 = 0; y2 < hh; y2++) {
      var gy = y + y2;
      var isSlab = (y2 % s.slabEvery === 0);
      for (var a = sx0; a <= sx1; a++) {
        for (var b = sx0; b <= sx1; b++) {
          var onEdge = (a === sx0 || a === sx1 || b === sx0 || b === sx1);
          if (isSlab) { put(a, gy, b, p.slab); continue; }
          if (!onEdge) continue;
          var isCorner = (a === sx0 || a === sx1) && (b === sx0 || b === sx1);
          var vertical = ((a - sx0) % 6 === 0) || ((b - sx0) % 6 === 0);
          if (isCorner) put(a, gy, b, p.mullion);
          else if (vertical) put(a, gy, b, p.mullion);
          else put(a, gy, b, p.glass);
        }
      }
      // 每段顶部一圈装饰线
      if (y2 === hh - 1) {
        for (var c = sx0; c <= sx1; c++) { put(c, gy, sx0, p.crown); put(c, gy, sx1, p.crown); }
        for (var d = sx0; d <= sx1; d++) { put(sx0, gy, d, p.crown); put(sx1, gy, d, p.crown); }
      }
    }
    y += hh;
  }

  // 3) 塔冠：逐层收分的小平台 + 灯
  var crownW = 12;
  for (var t = 0; t < 4; t++) {
    var cw = crownW - t * 2;
    if (cw < 4) break;
    var cx0 = cx - Math.floor(cw / 2), cx1 = cx0 + cw - 1;
    for (var m = cx0; m <= cx1; m++) {
      for (var n = cx0; n <= cx1; n++) {
        var rim = (m === cx0 || m === cx1 || n === cx0 || n === cx1);
        if (!rim) continue;
        put(m, y + t * 2, n, p.crown);
        put(m, y + t * 2 + 1, n, (t === 3) ? p.light : p.frame);
      }
    }
    y += 2;
  }

  // 4) 尖顶
  for (var sp = 0; sp < s.spireH; sp++) {
    put(cx, y + sp, cx, (sp % 4 === 3) ? p.crown : p.spire);
    if (sp < 3) {
      put(cx + 1, y + sp, cx, p.spire);
      put(cx - 1, y + sp, cx, p.spire);
      put(cx, y + sp, cx + 1, p.spire);
      put(cx, y + sp, cx - 1, p.spire);
    }
  }
  y += s.spireH;

  return { spec: s, blocks: blocks, height: y };
}

// 主流程：落盘。
function generate(name, spec) {
  var s = spec || defaultSpec();
  var built = buildFromSpec(s);
  var counts = {};
  for (var i = 0; i < built.blocks.length; i++) {
    var n = built.blocks[i].name.replace("minecraft:", "");
    counts[n] = (counts[n] || 0) + 1;
  }
  var keys = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
  var out = {
    name: String(name || s.name),
    desc: "退台式超高层 / setback skyscraper",
    spec: s,
    ms: 0,
    blocks: built.blocks
  };
  try {
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    var file = path.join(OUT_DIR, out.name + ".json");
    fs.writeFileSync(file, JSON.stringify(out), "utf8");
    say("已保存 / saved: " + file);
    say("方块 / blocks: " + built.blocks.length + " | 高度 " + built.height + " | 种类 " + keys.length);
    say("材料 / materials: " + keys.slice(0, 6).map(function (k) { return k + "×" + counts[k]; }).join(" "));
    return { ok: true, file: file, blocks: built.blocks.length, height: built.height, kinds: keys.length };
  } catch (e) { return { ok: false, message: "写文件失败: " + (e && e.message) }; }
}

if (require.main === module) {
  var r = generate(process.argv[2] || "jinmao_tower");
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
}

module.exports = { generate: generate, buildFromSpec: buildFromSpec, defaultSpec: defaultSpec };
