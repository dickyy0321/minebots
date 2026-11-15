// ========================================
// 文件：gui/renderer/ui-map.js
// 功能：纯 Canvas 2D 高性能雷达——实时绘制周围 64 格的玩家(蓝) / 怪物(红) / 掉落物(白)
// 依赖：无（数据由 window.uiTelemetry 的快照传入，或外部 feed；渲染层禁止 require）
// 导出：window.uiMap（render / feed / clear / stats）
// 说明：3D 视角已废弃，本雷达是唯一的地图视图；底盘离屏缓存 + rAF 合帧，避免每帧重画网格。
// 作者：MineBots
// ========================================

(function () {
  // 常量：默认画布边长 / 雷达覆盖半径（格）/ 三色实体 + 自机配色。
  var DEFAULT_SIZE = 256;
  var RADIUS_BLOCKS = 64;
  var COLORS = {
    player: "#4aa3ff",
    mob: "#ff4d4f",
    drop: "#f5f7fb",
    self: "#6ee7a8",
    grid: "rgba(120, 170, 220, 0.22)",
    sweep: "rgba(110, 231, 168, 0.16)",
    text: "#8896a6"
  };

  // 状态：离屏底盘缓存 / 合帧句柄 / 最近一次实体与元信息 / 帧统计。
  var baseCanvas = null;
  var baseSize = 0;
  var frameReq = null;
  var lastEntities = [];
  var lastMeta = {};
  var frames = 0;
  var drawn = 0;
  var lastAt = 0;

  // 内部：按 id 取元素，取不到返回 null。
  function byId(id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  }

  // 内部：双语文案（i18n 缺失时退回字面量）。
  function t(key, fallback) {
    try {
      if (window.t) {
        var text = window.t(key);
        if (text && text !== key) return text;
      }
    } catch (e) { /* 退回兜底文案 */ }
    return fallback;
  }

  // 内部：按 id 写文字，元素不存在静默返回 false。
  function setText(id, text) {
    var el = byId(id);
    if (!el) return false;
    try { el.textContent = text; return true; } catch (e) { return false; }
  }

  // 内部：取画布边长，读不到用默认值；同时把 canvas 的位图尺寸对齐，避免拉伸模糊。
  function sizeOf(canvas) {
    var n = DEFAULT_SIZE;
    try {
      var w = Number(canvas.width);
      var h = Number(canvas.height);
      if (!isNaN(w) && w >= 120 && w <= 1024) n = w;
      if (!isNaN(h) && h >= 120 && h <= 1024 && h !== n) n = Math.min(w, h);
      if (canvas.width !== n) canvas.width = n;
      if (canvas.height !== n) canvas.height = n;
    } catch (e) { n = DEFAULT_SIZE; }
    return n;
  }

  // 内部：世界相对坐标 → 画布坐标；把 bot 朝向旋到正上方，超出 64 格的点直接丢弃。
  function project(dx, dz, yaw, scale, center) {
    var y = Number(yaw) || 0;
    var fx = -Math.sin(y);
    var fz = Math.cos(y);
    var rx = -Math.cos(y);
    var rz = -Math.sin(y);
    var sx = dx * rx + dz * rz;
    var sy = -(dx * fx + dz * fz);
    return { x: center + sx * scale, y: center + sy * scale };
  }

  // 内部：判定实体分类，兼容 radar.scan 的 type 与旧 telemetry.nearby 的 player 布尔。
  function kindOf(ent) {
    try {
      if (!ent) return "";
      var type = String(ent.type || "").toLowerCase();
      if (type === "player" || type === "mob" || type === "drop") return type;
      if (ent.player === true || ent.username) return "player";
      if (ent.kind === "drop" || ent.name === "item" || ent.objectType === "Item") return "drop";
      return "mob";
    } catch (e) { return "mob"; }
  }

  // 内部：从遥测快照里抽实体数组，优先级 radar.entities > nearby > 数组本身。
  function pickEntities(row) {
    try {
      if (Array.isArray(row)) return row;
      if (!row || typeof row !== "object") return [];
      if (row.radar && Array.isArray(row.radar.entities)) return row.radar.entities;
      if (Array.isArray(row.nearby)) return row.nearby;
      if (Array.isArray(row.entities)) return row.entities;
    } catch (e) { /* 返回空盘 */ }
    return [];
  }

  // 内部：从快照里抽元信息（坐标 / 朝向 / 维度 / 半径）。
  function pickMeta(row) {
    var out = { position: null, yaw: 0, dimension: "-", radius: RADIUS_BLOCKS };
    try {
      if (!row || typeof row !== "object" || Array.isArray(row)) return out;
      if (row.position) out.position = row.position;
      if (row.radar && row.radar.position) out.position = row.radar.position;
      var view = row.view || {};
      var yaw = Number(view.yaw);
      if (!isNaN(yaw)) out.yaw = yaw;
      out.dimension = String(row.dimension || out.dimension);
      if (row.radar && Number(row.radar.radius) > 0) out.radius = Number(row.radar.radius);
    } catch (e) { /* 用默认元信息 */ }
    return out;
  }

  // 内部：画离屏底盘（背景 / 4 圈距离环 / 十字线 / 刻度），只在尺寸变化时重画一次。
  function buildBase(size) {
    if (baseCanvas && baseSize === size) return baseCanvas;
    try {
      baseCanvas = document.createElement("canvas");
      baseCanvas.width = size;
      baseCanvas.height = size;
      baseSize = size;
      var g = baseCanvas.getContext("2d");
      if (!g) return baseCanvas;
      var center = size / 2;
      var outer = center - 6;
      g.fillStyle = "#0d1014";
      g.fillRect(0, 0, size, size);
      g.strokeStyle = COLORS.grid;
      g.lineWidth = 1;
      for (var ring = 1; ring <= 4; ring++) {
        g.beginPath();
        g.arc(center, center, (outer * ring) / 4, 0, Math.PI * 2);
        g.stroke();
      }
      g.beginPath();
      g.moveTo(center, 6);
      g.lineTo(center, size - 6);
      g.moveTo(6, center);
      g.lineTo(size - 6, center);
      g.stroke();
      g.fillStyle = COLORS.text;
      g.font = "10px monospace";
      g.fillText(String(outRadius(size)) + "b", 8, 14);
      g.fillText("N", center - 3, 12);
    } catch (e) { baseCanvas = null; }
    return baseCanvas;
  }

  // 内部：底盘刻度用的半径值，异常时回退 64。
  function outRadius(size) {
    try { return size > 0 ? RADIUS_BLOCKS : RADIUS_BLOCKS; } catch (e) { return RADIUS_BLOCKS; }
  }

  // 内部：画旋转扫描扇形，制造实时雷达的动感（仅一帧一个扇形，成本极低）。
  function drawSweep(ctx, size, center) {
    try {
      var angle = (Date.now() / 1600) % (Math.PI * 2);
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(center, center);
      ctx.arc(center, center, center - 6, angle - 0.45, angle);
      ctx.closePath();
      ctx.fillStyle = COLORS.sweep;
      ctx.fill();
      ctx.restore();
    } catch (e) { /* 扫描线画不出不影响实体 */ }
  }

  // 内部：画一个实体点（实心圆 + 淡光环），颜色按分类取。
  function drawDot(ctx, p, color) {
    try {
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.6, 0, Math.PI * 2);
      ctx.fill();
    } catch (e) { /* 单点失败不影响整帧 */ }
  }

  // 内部：画中心自机（朝上的绿色三角）。
  function drawSelf(ctx, center) {
    try {
      ctx.fillStyle = COLORS.self;
      ctx.beginPath();
      ctx.moveTo(center, center - 9);
      ctx.lineTo(center - 6, center + 7);
      ctx.lineTo(center + 6, center + 7);
      ctx.closePath();
      ctx.fill();
    } catch (e) { /* ignore */ }
  }

  // 内部：真正画一帧；返回画出的实体数。
  function paint() {
    frameReq = null;
    var canvas = byId("miniMap");
    if (!canvas || typeof canvas.getContext !== "function") return 0;
    var ctx = null;
    try { ctx = canvas.getContext("2d"); } catch (e) { ctx = null; }
    if (!ctx) return 0;
    try {
      var size = sizeOf(canvas);
      var center = size / 2;
      var radius = Number(lastMeta.radius) > 0 ? Number(lastMeta.radius) : RADIUS_BLOCKS;
      var scale = (center - 6) / radius;
      var base = buildBase(size);
      if (base) ctx.drawImage(base, 0, 0);
      else { ctx.clearRect(0, 0, size, size); ctx.fillStyle = "#0d1014"; ctx.fillRect(0, 0, size, size); }
      drawSweep(ctx, size, center);
      var counts = { player: 0, mob: 0, drop: 0 };
      var list = Array.isArray(lastEntities) ? lastEntities : [];
      for (var i = 0; i < list.length; i++) {
        var ent = list[i] || {};
        var dx = Number(ent.dx) || 0;
        var dz = Number(ent.dz) || 0;
        if (dx * dx + dz * dz > radius * radius) continue;
        var kind = kindOf(ent);
        if (counts[kind] === undefined) kind = "mob";
        var p = project(dx, dz, lastMeta.yaw, scale, center);
        drawDot(ctx, p, COLORS[kind]);
        counts[kind] = counts[kind] + 1;
        drawn = drawn + 1;
      }
      drawSelf(ctx, center);
      frames = frames + 1;
      lastAt = Date.now();
      var pos = lastMeta.position;
      var where = pos ? ("x " + Math.round(Number(pos.x) || 0) + " y " + Math.round(Number(pos.y) || 0) +
        " z " + Math.round(Number(pos.z) || 0)) : t("telemetryEmpty", "(暂无数据)");
      setText("miniMapInfo", t("radarInfo", "雷达") + " " + radius + "b · " + where +
        " · " + t("radarLegend", "蓝玩家 / 红怪物 / 白掉落") + " · P " + counts.player +
        " M " + counts.mob + " D " + counts.drop);
      return counts.player + counts.mob + counts.drop;
    } catch (e) {
      try { setText("miniMapInfo", "radar error / 雷达绘制异常"); } catch (e2) { /* ignore */ }
      return 0;
    }
  }

  // 内部：用 requestAnimationFrame 合帧，同一帧内多次 render 只画一次；不支持时立即画。
  function schedule() {
    if (frameReq !== null) return true;
    try {
      if (typeof window.requestAnimationFrame === "function") {
        frameReq = window.requestAnimationFrame(function () { paint(); });
        return true;
      }
    } catch (e) { frameReq = null; }
    paint();
    return true;
  }

  window.uiMap = {
    // 渲染一帧：row 是遥测快照（可能为 null）；返回是否成功调度绘制。
    render: function (row) {
      try {
        lastEntities = pickEntities(row);
        lastMeta = pickMeta(row);
        return schedule();
      } catch (e) { return false; }
    },

    // 直接喂实体数组（外部雷达数据源用），meta 可带 position / yaw / radius。
    feed: function (list, meta) {
      try {
        lastEntities = Array.isArray(list) ? list : [];
        var base = pickMeta(meta || {});
        if (meta && meta.radius) base.radius = Number(meta.radius) || RADIUS_BLOCKS;
        lastMeta = base;
        return schedule();
      } catch (e) { return false; }
    },

    // 清空画布（bot 全停 / 面板关闭时调），只留底盘与自机。
    clear: function () {
      try {
        lastEntities = [];
        lastMeta = { position: null, yaw: 0, dimension: "-", radius: RADIUS_BLOCKS };
        setText("miniMapInfo", "");
        return schedule();
      } catch (e) { return false; }
    },

    // 读雷达运行统计（自测与实机验证用）：帧数 / 累计点数 / 半径 / 最后绘制时间。
    stats: function () {
      return { frames: frames, points: drawn, radius: RADIUS_BLOCKS, lastAt: lastAt, pending: frameReq !== null };
    }
  };

  // 启动：先画一次空盘，保证窗口打开时雷达画布不是全黑空白。
  try {
    var boot = function () { window.uiMap.clear(); };
    if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", boot);
    else boot();
  } catch (e) { /* 启动画不出也不影响后续遥测渲染 */ }
})();
