// ========================================
// 文件：scripts/blueprint-preview.js
// 功能：把蓝图 JSON 渲染成等轴测预览图（不依赖游戏、不依赖显卡），用于文档与视频的证据图
// 依赖：fs / path / ../scripts/qa-env（PNG 编码）
// 导出：render / colorOf
// 说明：逐块画立方体顶面 + 左右侧面，按 x+z+y 排序保证遮挡正确；纯 CPU，几千块秒级。
// 作者：MineBots
// ========================================
var fs = require("fs");
var path = require("path");
var q = require("./qa-env");

var COLORS = {
  "quartz_block": [235, 232, 226],
  "smooth_quartz": [238, 236, 231],
  "quartz_pillar": [228, 224, 216],
  "polished_deepslate": [70, 70, 74],
  "deepslate_tiles": [58, 58, 62],
  "gold_block": [247, 208, 84],
  "sea_lantern": [196, 232, 226],
  "glass": [180, 220, 235],
  "light_blue_stained_glass": [140, 200, 230],
  "red_terracotta": [150, 66, 50],
  "yellow_terracotta": [186, 133, 60],
  "oak_planks": [176, 143, 92],
  "spruce_planks": [114, 84, 52],
  "spruce_stairs": [108, 80, 50],
  "dark_oak_planks": [66, 44, 24],
  "stone_bricks": [124, 124, 124],
  "chiseled_stone_bricks": [116, 116, 116],
  "lantern": [245, 214, 140],
  "red_wool": [160, 60, 55],
  "white_concrete": [207, 213, 214],
  "cobblestone": [128, 128, 128]
};

function colorOf(name) {
  var n = String(name || "").replace("minecraft:", "");
  return COLORS[n] || [200, 200, 200];
}

// 填充多边形（扫描线），pts 为 [[x,y],...]。
function fillPoly(buf, W, H, pts, c) {
  var minY = 1e9, maxY = -1e9, i;
  for (i = 0; i < pts.length; i++) { if (pts[i][1] < minY) minY = pts[i][1]; if (pts[i][1] > maxY) maxY = pts[i][1]; }
  minY = Math.max(0, Math.floor(minY)); maxY = Math.min(H - 1, Math.ceil(maxY));
  for (var y = minY; y <= maxY; y++) {
    var xs = [];
    for (i = 0; i < pts.length; i++) {
      var a = pts[i], b = pts[(i + 1) % pts.length];
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
        xs.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
      }
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

// 画一个等轴测立方体：顶面菱形 + 左右两侧面（真正的多边形填充）。
function cube(buf, W, H, sx, sy, s, rgb, shade) {
  var hw = s, hh = s * 0.5, bh = s * 0.95;
  var top = [rgb[0] * shade, rgb[1] * shade, rgb[2] * shade];
  var left = [rgb[0] * shade * 0.72, rgb[1] * shade * 0.72, rgb[2] * shade * 0.72];
  var right = [rgb[0] * shade * 0.54, rgb[1] * shade * 0.54, rgb[2] * shade * 0.54];
  fillPoly(buf, W, H, [[sx, sy - hh], [sx + hw, sy], [sx, sy + hh], [sx - hw, sy]], top);
  fillPoly(buf, W, H, [[sx - hw, sy], [sx, sy + hh], [sx, sy + hh + bh], [sx - hw, sy + bh]], left);
  fillPoly(buf, W, H, [[sx + hw, sy], [sx, sy + hh], [sx, sy + hh + bh], [sx + hw, sy + bh]], right);
}

// 渲染：返回 { ok, file, width, height }
function render(bpFile, outFile, opts) {
  var o = opts || {};
  var S = Number(o.scale) || 9;
  var W = Number(o.width) || 1600;
  var H = Number(o.height) || 900;
  var bg = o.bg || [11, 15, 20];
  try {
    var data = JSON.parse(fs.readFileSync(bpFile, "utf8"));
    var blocks = data.blocks || [];
    if (!blocks.length) return { ok: false, message: "蓝图没有方块" };
    var buf = Buffer.alloc(W * H * 4, 0);
    for (var i = 0; i < W * H; i++) {
      buf[i * 4] = bg[0]; buf[i * 4 + 1] = bg[1]; buf[i * 4 + 2] = bg[2]; buf[i * 4 + 3] = 255;
    }
    var minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9, minY = 1e9, maxY = -1e9;
    for (var b = 0; b < blocks.length; b++) {
      minX = Math.min(minX, blocks[b].x); maxX = Math.max(maxX, blocks[b].x);
      minZ = Math.min(minZ, blocks[b].z); maxZ = Math.max(maxZ, blocks[b].z);
      minY = Math.min(minY, blocks[b].y); maxY = Math.max(maxY, blocks[b].y);
    }
    var mx = (minX + maxX) / 2, mz = (minZ + maxZ) / 2;
    // 自适应：按投影包围盒求缩放，保证整栋楼都在画面里
    var bx0 = 1e9, bx1 = -1e9, by0 = 1e9, by1 = -1e9;
    for (var pi = 0; pi < blocks.length; pi++) {
      var pb = blocks[pi];
      var px1 = (pb.x - mx) - (pb.z - mz);
      var py1 = ((pb.x - mx) + (pb.z - mz)) * 0.5 - (pb.y - minY) * 0.95;
      if (px1 < bx0) bx0 = px1; if (px1 > bx1) bx1 = px1;
      if (py1 < by0) by0 = py1; if (py1 > by1) by1 = py1;
    }
    var bw = Math.max(1, bx1 - bx0), bh2 = Math.max(1, by1 - by0);
    S = Math.max(2, Math.min(Number(o.scale) || 11, Math.floor(Math.min(W * 0.9 / bw, H * 0.9 / bh2))));
    var ox = W / 2 - ((bx0 + bx1) / 2) * S;
    var oy = H / 2 - ((by0 + by1) / 2) * S;
    // 深到浅排序（x+z 小、y 大的先画）
    var order = blocks.slice().sort(function (a, c) {
      var da = (a.x - mx) + (a.z - mz) + (a.y - minY) * 0.001;
      var dc = (c.x - mx) + (c.z - mz) + (c.y - minY) * 0.001;
      return da - dc;
    });
    for (var k = 0; k < order.length; k++) {
      var blk = order[k];
      var sx = Math.round(ox + (blk.x - mx) * S - (blk.z - mz) * S);
      var sy = Math.round(oy + (blk.x - mx) * S * 0.5 + (blk.z - mz) * S * 0.5 - (blk.y - minY) * S * 0.95);
      var shade = 0.82 + 0.18 * ((blk.y - minY) / Math.max(1, maxY - minY));
      cube(buf, W, H, sx, sy, S, colorOf(blk.name), shade);
    }
    var png = q.encodePNG(W, H, buf);
    if (!fs.existsSync(path.dirname(outFile))) fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, png);
    return { ok: true, file: outFile, width: W, height: H, blocks: blocks.length };
  } catch (e) { return { ok: false, message: String(e && e.message) }; }
}

if (require.main === module) {
  var src = process.argv[2] || path.join(__dirname, "..", "state", "blueprints", "ai-palace.json");
  var out = process.argv[3] || path.join(__dirname, "..", "logs", "demo-report", "palace-preview.png");
  var r = render(src, out, { scale: 11, width: 1600, height: 900 });
  console.log(JSON.stringify(r));
}

module.exports = { render: render, colorOf: colorOf };
