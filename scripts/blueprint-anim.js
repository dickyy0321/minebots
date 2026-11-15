// ========================================
// 文件：scripts/blueprint-anim.js
// 功能：把蓝图渲染成「建造过程 + 环绕运镜」动画帧序列（纯离线，不依赖游戏 / 不抢桌面）
// 依赖：fs / path；./qa-env（PNG 编码）
// 导出：renderFrames
// 说明：第 i 帧只画「进度阈值以下」的方块，同时相机水平角随时间旋转，形成建造 + 运镜效果。
// 作者：MineBots
// ========================================
var fs = require("fs");
var path = require("path");
var q = require("./qa-env");

var COLORS = {
  "quartz_block": [235, 232, 226], "smooth_quartz": [238, 236, 231], "quartz_pillar": [228, 224, 216],
  "polished_deepslate": [70, 70, 74], "deepslate_tiles": [58, 58, 62], "gold_block": [247, 208, 84],
  "sea_lantern": [196, 232, 226], "glass": [180, 220, 235], "light_blue_stained_glass": [120, 190, 225],
  "red_terracotta": [150, 66, 50], "yellow_terracotta": [186, 133, 60], "oak_planks": [176, 143, 92],
  "spruce_planks": [114, 84, 52], "spruce_stairs": [108, 80, 50], "dark_oak_planks": [66, 44, 24],
  "stone_bricks": [124, 124, 124], "chiseled_stone_bricks": [116, 116, 116], "lantern": [245, 214, 140],
  "red_wool": [160, 60, 55], "white_concrete": [207, 213, 214], "cobblestone": [128, 128, 128],
  "smooth_stone": [158, 158, 158]
};

function colorOf(name) { return COLORS[String(name || "").replace("minecraft:", "")] || [200, 200, 200]; }

function fillPoly(buf, W, H, pts, c) {
  var minY = 1e9, maxY = -1e9, i;
  for (i = 0; i < pts.length; i++) { if (pts[i][1] < minY) minY = pts[i][1]; if (pts[i][1] > maxY) maxY = pts[i][1]; }
  minY = Math.max(0, Math.floor(minY)); maxY = Math.min(H - 1, Math.ceil(maxY));
  for (var y = minY; y <= maxY; y++) {
    var xs = [];
    for (i = 0; i < pts.length; i++) {
      var a = pts[i], b = pts[(i + 1) % pts.length];
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) xs.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
    }
    if (xs.length < 2) continue;
    xs.sort(function (m, n) { return m - n; });
    for (var xi = 0; xi < xs.length - 1; xi += 2) {
      var x0 = Math.max(0, Math.round(xs[xi])), x1 = Math.min(W - 1, Math.round(xs[xi + 1]));
      for (var x = x0; x <= x1; x++) {
        var o = (y * W + x) * 4;
        buf[o] = Math.min(255, Math.round(c[0])); buf[o + 1] = Math.min(255, Math.round(c[1])); buf[o + 2] = Math.min(255, Math.round(c[2])); buf[o + 3] = 255;
      }
    }
  }
}

// 等轴测立方体：drawTop=false 时跳过顶面（上方有方块的情况）
function cube(buf, W, H, sx, sy, s, rgb, shade, drawTop) {
  var hw = s, hh = s * 0.5, bh = s * 0.95;
  if (drawTop !== false) fillPoly(buf, W, H, [[sx, sy - hh], [sx + hw, sy], [sx, sy + hh], [sx - hw, sy]], [rgb[0] * shade, rgb[1] * shade, rgb[2] * shade]);
  fillPoly(buf, W, H, [[sx - hw, sy], [sx, sy + hh], [sx, sy + hh + bh], [sx - hw, sy + bh]], [rgb[0] * shade * 0.72, rgb[1] * shade * 0.72, rgb[2] * shade * 0.72]);
  fillPoly(buf, W, H, [[sx + hw, sy], [sx, sy + hh], [sx, sy + hh + bh], [sx + hw, sy + bh]], [rgb[0] * shade * 0.54, rgb[1] * shade * 0.54, rgb[2] * shade * 0.54]);
}

// 主流程：frames 帧，进度从 minPct 到 1，相机转一圈
function renderFrames(bpFile, outDir, opts) {
  var o = opts || {};
  var frames = Number(o.frames) || 90;
  var W = Number(o.width) || 1280;
  var H = Number(o.height) || 720;
  var S = Number(o.scale) || 8;
  try {
    var data = JSON.parse(fs.readFileSync(bpFile, "utf8"));
    var blocks = data.blocks || [];
    if (!blocks.length) return { ok: false, message: "蓝图没有方块" };
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    var minY = 1e9, maxY = -1e9, minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9, i;
    for (i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (b.y < minY) minY = b.y; if (b.y > maxY) maxY = b.y;
      if (b.x < minX) minX = b.x; if (b.x > maxX) maxX = b.x;
      if (b.z < minZ) minZ = b.z; if (b.z > maxZ) maxZ = b.z;
    }
    var cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    var cxY = (minY + maxY) / 2;
    // 预排序：按高度分层，动画按 y 递增出现
    // 排序：先按高度，再让楼板排在墙体之后（这样每一层先立墙、后铺板，露出的顶面是墙体不是混凝土盖子）
    function isSlabName(n) { return String(n).indexOf("smooth_stone") >= 0 || String(n).indexOf("slab") >= 0; }
    var sorted = blocks.slice().sort(function (a, c) {
      return (a.y - c.y) || ((isSlabName(a.name) ? 1 : 0) - (isSlabName(c.name) ? 1 : 0)) || ((a.x + a.z) - (c.x + c.z));
    });
    var total = sorted.length;
    for (var f = 0; f < frames; f++) {
      var t = f / Math.max(1, frames - 1);
      var pct = 0.06 + 0.94 * t;              // 进度：6% → 100%
      var show = Math.max(1, Math.floor(total * pct));
      var ang = -0.8 + t * Math.PI * 1.15;     // 相机转一圈多一点
      var cosA = Math.cos(ang), sinA = Math.sin(ang);
      var buf = Buffer.alloc(W * H * 4, 0);
      // 天空渐变背景
      for (var y = 0; y < H; y++) {
        var k = y / H;
        var rr = Math.round(14 + 40 * k * 0.3), gg = Math.round(20 + 55 * k * 0.3), bb = Math.round(34 + 80 * k * 0.3);
        for (var x = 0; x < W; x++) {
          var oo = (y * W + x) * 4;
          buf[oo] = rr; buf[oo + 1] = gg; buf[oo + 2] = bb; buf[oo + 3] = 255;
        }
      }
      // 自适应缩放：保证整栋楼（含尖顶）在画面内，底部留 12% 余量
      var bH = (maxY - minY + 1) * 1.05 + Math.max(maxX - minX, maxZ - minZ) * 0.55;
      var fitS = Math.max(2, Math.min(S, Math.floor(H * 0.90 / Math.max(1, bH))));
      var solid = {};
      for (var si2 = 0; si2 < show; si2++) { var sb = sorted[si2]; solid[sb.x + "," + sb.y + "," + sb.z] = 1; }
      var solid = {};
      for (var si2 = 0; si2 < show; si2++) { var sb = sorted[si2]; solid[sb.x + "," + sb.y + "," + sb.z] = 1; }
      var ox = W / 2, oy = H * 0.88;
      S = fitS;
      for (var j = 0; j < show; j++) {
        var blk = sorted[j];
        var dx = blk.x - cx, dz = blk.z - cz;
        var rx = dx * cosA - dz * sinA;
        var rz = dx * sinA + dz * cosA;
        var sx = Math.round(ox + (rx - rz) * S);
        var sy = Math.round(oy + (rx + rz) * S * 0.5 - (blk.y - minY) * S * 1.05);
        var shade = 0.86 + 0.14 * ((blk.y - minY) / Math.max(1, maxY - minY));
        var above = solid[blk.x + "," + (blk.y + 1) + "," + blk.z] ? true : false;
        cube(buf, W, H, sx, sy, S, colorOf(blk.name), shade, !above);
      }
      var name = path.join(outDir, "frame-" + (f + 1 < 10 ? "00" : (f + 1 < 100 ? "0" : "")) + (f + 1) + ".png");
      fs.writeFileSync(name, q.encodePNG(W, H, buf));
    }
    return { ok: true, dir: outDir, frames: frames, blocks: total, height: (maxY - minY + 1) };
  } catch (e) { return { ok: false, message: String(e && e.message) }; }
}

if (require.main === module) {
  var src = process.argv[2] || path.join(__dirname, "..", "state", "blueprints", "jinmao2.json");
  var out = process.argv[3] || path.join(__dirname, "..", "logs", "anim", "tower");
  var r = renderFrames(src, out, { frames: Number(process.argv[4]) || 90, width: 1280, height: 720, scale: 9 });
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
}

module.exports = { renderFrames: renderFrames };
