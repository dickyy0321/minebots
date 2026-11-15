// 红石门蓝图：石砖墙 + 石英门框 + 铁门 + 门边拉杆 + 门楣红石灯。
// 用法：node scripts/redstone-door.js [输出文件]
// 铁门上下两半必须同一 tick 放置，否则会弹掉；这里只出墙体，门由调用方用控制台补。
"use strict";

var fs = require("fs");
var path = require("path");

var BASE_Y = 72;
var WALL_Z = 2206;
var DOOR_X = 3705;
var WALL_X0 = 3702;
var WALL_X1 = 3708;

function blk(x, y, z, name) {
  return { x: x, y: y, z: z, name: name };
}

function build() {
  var out = [];
  var x;
  var y;
  for (x = WALL_X0; x <= WALL_X1; x++) {
    for (y = BASE_Y; y <= BASE_Y + 3; y++) {
      if (x === DOOR_X && (y === BASE_Y || y === BASE_Y + 1)) continue;   // 门洞
      if (x === DOOR_X + 1 && y === BASE_Y + 1) continue;                 // 拉杆位
      if (x === DOOR_X + 1 && y === BASE_Y + 2) continue;                 // 灯位
      out.push(blk(x, y, WALL_Z, "minecraft:stone_bricks"));
    }
  }
  // 门框立柱
  for (y = BASE_Y; y <= BASE_Y + 3; y++) {
    out.push(blk(WALL_X0, y, WALL_Z, "minecraft:chiseled_quartz_block"));
    out.push(blk(WALL_X1, y, WALL_Z, "minecraft:chiseled_quartz_block"));
  }
  // 门楣
  for (x = WALL_X0; x <= WALL_X1; x++) {
    out.push(blk(x, BASE_Y + 4, WALL_Z, "minecraft:polished_deepslate"));
  }
  // 拉杆（贴墙）+ 门楣上的红石灯
  out.push(blk(DOOR_X + 1, BASE_Y + 1, WALL_Z, "minecraft:lever[face=wall,facing=west,powered=false]"));
  out.push(blk(DOOR_X + 1, BASE_Y + 2, WALL_Z, "minecraft:redstone_lamp"));
  // 门口地砖，便于取景
  for (x = WALL_X0; x <= WALL_X1; x++) {
    out.push(blk(x, BASE_Y - 1, WALL_Z - 1, "minecraft:smooth_stone"));
  }
  return {
    name: "redstone-door",
    description: "石砖墙 + 铁门 + 墙边拉杆 + 红石灯",
    origin: { x: 0, y: 0, z: 0 },
    blocks: out
  };
}

var bp = build();
var outFile = process.argv[2] || path.join("state", "blueprints", "redstone-door.json");
try { fs.mkdirSync(path.dirname(outFile), { recursive: true }); } catch (e) { /* 已存在 */ }
fs.writeFileSync(outFile, JSON.stringify(bp, null, 1), "utf8");
console.log("[redstone-door] blocks=" + bp.blocks.length + " -> " + outFile);

module.exports = { build: build, BASE_Y: BASE_Y, WALL_Z: WALL_Z, DOOR_X: DOOR_X };
