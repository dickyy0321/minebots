// 生存模式火柴盒：一只 Bot 在生存模式下用背包里的木板/玻璃真正放置方块（bot.placeBlock），
// 不是 setblock 命令。每放一排之前先把 Bot 传到墙外 2 格，保证目标在 4.5 格手臂范围内。
// 用法：MINEBOTS_HUT_ORIGIN=3700,72,2199 node scripts/survival-hut.js
"use strict";

var mineflayer = require("mineflayer");
var Vec3 = require("vec3");

function wait(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

function say(msg) {
  try { console.log("[survival-hut] " + msg); } catch (e) { /* ignore */ }
}

function parseOrigin() {
  var out = { x: 3700, y: 72, z: 2199 };
  try {
    var p = String(process.env.MINEBOTS_HUT_ORIGIN || "").split(",");
    if (p.length === 3) out = { x: Number(p[0]), y: Number(p[1]), z: Number(p[2]) };
  } catch (e) { /* 用默认 */ }
  return out;
}

async function main() {
  var o = parseOrigin();
  var size = 4;          // 4×4 火柴盒
  var wallH = 3;
  var bot = mineflayer.createBot({
    host: "127.0.0.1", port: 25565,
    username: String(process.env.MINEBOTS_HUT_BOT || "Carpenter"),
    version: "1.21.1", auth: "offline"
  });

  await new Promise(function (resolve, reject) {
    var done = false;
    bot.once("spawn", function () { if (!done) { done = true; resolve(); } });
    bot.once("error", function (e) { if (!done) { done = true; reject(e); } });
    setTimeout(function () { if (!done) { done = true; reject(new Error("spawn timeout")); } }, 40000);
  });
  say("bot spawned");

  var noCmd = String(process.env.MINEBOTS_HUT_NO_CMD || "") === "1";
  if (!noCmd) {
    bot.chat("/gamemode survival");
    await wait(300);
    bot.chat("/give " + bot.username + " minecraft:oak_planks 128");
    bot.chat("/give " + bot.username + " minecraft:glass 16");
    await wait(900);
  }

  var placed = 0;
  var failed = 0;

  async function stand(x, y, z) {
    try { bot.chat("/tp " + bot.username + " " + x.toFixed(2) + " " + y.toFixed(2) + " " + z.toFixed(2)); } catch (e) { /* ignore */ }
    await wait(320);
  }

  async function put(x, y, z, item) {
    var itemName = String(item).indexOf(":") >= 0 ? String(item).split(":")[1] : String(item);
    var it = bot.inventory.items().filter(function(v){ return v.name === itemName; })[0];
    if (!it) { failed += 1; if (failed === 1) say("no item " + itemName); return; }
    // 参考块：优先取目标正下方，其次四周任意实心块
    var dirs = [[0,-1,0,0,1,0],[0,0,1,0,0,-1],[0,0,-1,0,0,1],[1,0,0,-1,0,0],[-1,0,0,1,0,0]];
    var ref = null; var off = null;
    for (var d = 0; d < dirs.length; d++) {
      var dx = dirs[d][0], dy = dirs[d][1], dz = dirs[d][2];
      var b = bot.blockAt(new Vec3(x + dx, y + dy, z + dz));
      if (b && b.name !== "air" && b.name !== "cave_air" && b.name !== "water") { ref = b; off = new Vec3(dirs[d][3], dirs[d][4], dirs[d][5]); break; }
    }
    if (!ref) { failed += 1; if (failed === 1) say("no reference for " + x + "," + y + "," + z); return; }
    try {
      await bot.equip(it, "hand");
      await bot.placeBlock(ref, off);
      placed += 1;
    } catch (e) {
      failed += 1;
      if (failed === 1) say("place err: " + (e && e.message ? e.message : e) + " target=" + x + "," + y + "," + z);
    }
    await wait(80);
  }

  // 四面墙：每面先把 Bot 传到墙外 2.2 格，再放这一面的 4 格
  var sides = [
    { name: "south", stand: function (y) { return [o.x + size / 2, y, o.z - 2.2]; }, cell: function (i) { return [o.x + i, o.z]; } },
    { name: "north", stand: function (y) { return [o.x + size / 2, y, o.z + size - 1 + 2.2]; }, cell: function (i) { return [o.x + i, o.z + size - 1]; } },
    { name: "west", stand: function (y) { return [o.x - 2.2, y, o.z + size / 2]; }, cell: function (i) { return [o.x, o.z + i]; } },
    { name: "east", stand: function (y) { return [o.x + size - 1 + 2.2, y, o.z + size / 2]; }, cell: function (i) { return [o.x + size - 1, o.z + i]; } }
  ];

  for (var layer = 0; layer < wallH; layer++) {
    var y = o.y + layer;
    for (var s = 0; s < sides.length; s++) {
      var side = sides[s];
      var sp = side.stand(y);
      await stand(sp[0], sp[1], sp[2]);
      for (var i = 0; i < size; i++) {
        var c = side.cell(i);
        if (side.name === "south" && i === 1 && layer < 2) continue;         // 门洞
        var isWin = (side.name === "north" && layer === 1 && (i === 1 || i === 2));
        await put(c[0], y, c[1], isWin ? "minecraft:glass" : "minecraft:oak_planks");
      }
    }
    say("wall layer " + layer + " done: placed=" + placed + " failed=" + failed);
  }

  // 屋顶：同样从四面外侧各放一排
  for (var s2 = 0; s2 < sides.length; s2++) {
    var side2 = sides[s2];
    var sp2 = side2.stand(o.y + wallH - 1);
    await stand(sp2[0], sp2[1], sp2[2]);
    for (var j = 0; j < size; j++) {
      var c2 = side2.cell(j);
      await put(c2[0], o.y + wallH, c2[1], "minecraft:oak_planks");
    }
  }
  say("roof done: placed=" + placed + " failed=" + failed);

  bot.chat("火柴盒完工 / hut complete");
  var hold = Number(process.env.MINEBOTS_HUT_HOLD_MS || 0);
  if (hold > 0) await wait(hold);
  return { ok: failed === 0, placed: placed, failed: failed };
}

if (require.main === module) {
  main().then(function (r) {
    say("done: " + JSON.stringify(r));
    process.exit(0);
  }).catch(function (e) {
    say("failed: " + (e && e.message ? e.message : e));
    process.exit(1);
  });
}

module.exports = { main: main };
