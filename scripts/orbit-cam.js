// 轨道相机：把 tp 指令按固定间隔写进服务端控制台通道，实现环绕 + 升降运镜。
// 用法：node scripts/orbit-cam.js --cx=1600 --cz=900 --r0=95 --r1=70 --y0=100 --y1=175 --ty0=80 --ty1=140 --dur=240000
// 说明：只写文件、不发按键，因此不会把输入打到别的窗口（这是之前踩过的坑）。
"use strict";

var fs = require("fs");
var path = require("path");

function argOf(name, def) {
  var pre = "--" + name + "=";
  for (var i = 2; i < process.argv.length; i++) {
    if (process.argv[i].indexOf(pre) === 0) return process.argv[i].slice(pre.length);
  }
  return def;
}

var cmdFile = String(argOf("file", path.join("state", "qa-server", "cmd.txt")));
var player = String(argOf("player", "Steve"));
var cx = Number(argOf("cx", 0));
var cz = Number(argOf("cz", 0));
var r0 = Number(argOf("r0", 90));
var r1 = Number(argOf("r1", 90));
var y0 = Number(argOf("y0", 110));
var y1 = Number(argOf("y1", 110));
var ty0 = Number(argOf("ty0", 90));
var ty1 = Number(argOf("ty1", 90));
var dur = Number(argOf("dur", 240000));
var tick = Number(argOf("tick", 120));
var turns = Number(argOf("turns", 1));
var a0 = Number(argOf("a0", 0));

function line(msg) {
  try { fs.appendFileSync(cmdFile, msg + "\n"); } catch (e) { /* 通道不存在就跳过这一帧 */ }
}

function deg(d) { return d; }

function one(t01) {
  var ang = (a0 + turns * 360 * t01) * Math.PI / 180;
  var r = r0 + (r1 - r0) * t01;
  var y = y0 + (y1 - y0) * t01;
  var ty = ty0 + (ty1 - ty0) * t01;
  var x = cx + r * Math.cos(ang);
  var z = cz + r * Math.sin(ang);
  var dx = cx - x;
  var dz = cz - z;
  var hlen = Math.sqrt(dx * dx + dz * dz);
  var yaw = Math.atan2(-dx, dz) * 180 / Math.PI;
  var pitch = Math.atan2(-(ty - y), hlen) * 180 / Math.PI;
  line("tp " + player + " " + x.toFixed(2) + " " + y.toFixed(2) + " " + z.toFixed(2) +
    " " + deg(yaw).toFixed(1) + " " + deg(pitch).toFixed(1));
}

var t0 = Date.now();
var timer = setInterval(function () {
  var t = (Date.now() - t0) / dur;
  if (t >= 1) {
    one(1);
    clearInterval(timer);
    console.log("[orbit] done");
    return;
  }
  one(t);
}, tick);

console.log("[orbit] start cx=" + cx + " cz=" + cz + " r " + r0 + "->" + r1 + " dur=" + dur + " tick=" + tick);
