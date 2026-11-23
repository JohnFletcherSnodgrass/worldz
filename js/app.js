/* worldz: click the country you're asked for.
 *
 * Rendering: two stacked <canvas> layers.
 *   #base  the map itself (country fills + orange outlines). Redrawn only when you zoom/pan,
 *          resize, or a country changes colour.
 *   #top   everything that moves or flashes: hover tint, wrong/reveal flashes, dots for tiny
 *          countries, labels, ping rings. Cheap to redraw every frame.
 */
(() => {
  "use strict";

  const D = window.WORLDZ_DATA; // real Natural Earth outlines + country list (see scripts/build-data.mjs)
  const R = 6371.0088; // km
  const SMALL_KM2 = 100000; // "small" = under 100,000 km²
  const DOT_PX = 10; // countries drawn smaller than this on screen become clickable dots
  const LO_K = 2.5; // below this zoom the simplified outlines are used
  const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';

  const MODES = [
    { id: "world", name: "World", box: [-179.9, -56, 179.9, 84] },
    { id: "Africa", name: "Africa", box: [-26, -36, 56, 38] },
    { id: "Asia", name: "Asia", box: [25, -12, 146, 77] },
    { id: "Europe", name: "Europe", box: [-25, 34, 45, 72] },
    { id: "North America", name: "North America", box: [-168, 6, -50, 80] },
    { id: "South America", name: "South America", box: [-82, -56, -34, 13] },
    { id: "Oceania", name: "Oceania", box: [110, -50, 208, 22] },
  ];
  const SIZES = [
    { id: "all", name: "All", sub: "every country" },
    { id: "small", name: "Small", sub: "under 100,000 km²" },
    { id: "big", name: "Big", sub: "100,000 km² and up" },
  ];
  const LEVELS = [
    { id: "easy", name: "Easy", fill: true, tries: 3, desc: "Found countries fill in and are labelled. 3 guesses each." },
    { id: "medium", name: "Medium", fill: true, tries: 1, desc: "Found countries fill in and are labelled. 1 guess each." },
    { id: "hard", name: "Hard", fill: false, tries: 3, desc: "Nothing fills in, so remember what you've done. 3 guesses each." },
    { id: "expert", name: "Expert", fill: false, tries: 1, desc: "Nothing fills in. 1 guess each." },
  ];

  const $ = (s) => document.querySelector(s);
  const stage = $("#stage");
  const baseCv = $("#base");
  const topCv = $("#top");
  const bctx = baseCv.getContext("2d");
  const tctx = topCv.getContext("2d");
  const hitCtx = document.createElement("canvas").getContext("2d");
  const cursorEl = $("#cursor");
  const pillEl = $("#pill");

  // ---------- settings (remembered, but the app works without storage) ----------
  const DEFAULTS = { mode: "world", size: "all", level: "easy", dots: true };
  let settings = { ...DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem("worldz-settings") || "null");
    if (saved && MODES.some((m) => m.id === saved.mode) && SIZES.some((s) => s.id === saved.size) && LEVELS.some((l) => l.id === saved.level)) settings = { ...DEFAULTS, ...saved, dots: saved.dots !== false };
  } catch (e) {}
  const saveSettings = () => {
    try {
      localStorage.setItem("worldz-settings", JSON.stringify(settings));
    } catch (e) {}
  };

  // ---------- data helpers ----------
  const modeOf = (id) => MODES.find((m) => m.id === id);
  const levelOf = (id) => LEVELS.find((l) => l.id === id);
  const inMode = (c, mode) => mode.id === "world" || c.continents.includes(mode.id);
  const sizeOk = (c, size) => size === "all" || (size === "small" ? c.area < SMALL_KM2 : c.area >= SMALL_KM2);
  const poolFor = (modeId, size) => D.countries.filter((c) => inMode(c, modeOf(modeId)) && sizeOk(c, size));

  const polyCache = new WeakMap();
  function polyInfo(coords) {
    let i = polyCache.get(coords);
    if (!i) {
      const poly = { type: "Polygon", coordinates: coords };
      i = { poly, area: d3.geoArea(poly) * R * R, centroid: null };
      polyCache.set(coords, i);
    }
    return i;
  }
  const polysOf = (g) => (g.type === "Polygon" ? [g.coordinates] : g.coordinates);

  // Drop far-flung overseas bits of a country (e.g. French Guiana on the Europe map)
  // while always keeping big landmasses (Russia, Greenland ...).
  function crop(geom, mode) {
    if (mode.id === "world") return geom;
    const [w, s, e, n] = mode.box;
    const cx = (w + e) / 2;
    const hw = (e - w) / 2 + 15;
    const keep = polysOf(geom).filter((p) => {
      const info = polyInfo(p);
      if (info.area > 400000) return true;
      if (!info.centroid) info.centroid = d3.geoCentroid(info.poly);
      const [lo, la] = info.centroid;
      const dl = ((((lo - cx + 540) % 360) + 360) % 360) - 180;
      return Math.abs(dl) <= hw && la >= s - 15 && la <= n + 15;
    });
    return keep.length ? { type: "MultiPolygon", coordinates: keep } : null;
  }

  // ---------- colours (read from the CSS tokens so light/dark and the Pebblez palette stay in one place) ----------
  let colors = {};
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const g = (n) => cs.getPropertyValue(n).trim();
    colors = {
      land: g("--land"),
      ctx: g("--land-ctx"),
      stroke: g("--land-stroke"),
      ocean: g("--ocean"),
      t1: g("--yooper-1"),
      t2: g("--yooper-2"),
      t3: g("--yooper-3"),
      missed: g("--bad"),
      wrong: g("--destructive"),
      accent: g("--accent"),
      dot: g("--dot"),
      dotHover: g("--foreground"),
      tint: g("--hover-tint"),
    };
  }
  const resultColor = (r) => (r.ok ? colors["t" + Math.min(3, r.tries)] : colors.missed);

  // ---------- map ----------
  let W = 0,
    H = 0,
    dpr = 1,
    proj = null,
    transform = d3.zoomIdentity,
    zoomBehavior = null;
  let items = new Map(); // country id -> item
  let poolItems = []; // clickable countries
  let dotItems = []; // pool countries that can show as a dot
  let ctxShapes = []; // territories etc, drawn dim and not clickable
  const active = new Set(); // items with a running flash / label / shake
  let pings = []; // { id, t0 }
  let stageRect = { left: 0, top: 0, width: 0, height: 0 };
  let hover = null;

  // Outline simplifier for the zoomed-out view: drops points closer than `tol` px to the last kept one.
  function lowRes(projection, tol) {
    let s = "",
      lx = 0,
      ly = 0;
    const t2 = tol * tol;
    const sink = {
      moveTo(x, y) {
        s += "M" + x.toFixed(1) + " " + y.toFixed(1);
        lx = x;
        ly = y;
      },
      lineTo(x, y) {
        const dx = x - lx,
          dy = y - ly;
        if (dx * dx + dy * dy >= t2) {
          s += "L" + x.toFixed(1) + " " + y.toFixed(1);
          lx = x;
          ly = y;
        }
      },
      closePath() {
        s += "Z";
      },
      arc() {},
      rect() {},
    };
    const gp = d3.geoPath(projection, sink);
    return (feat) => {
      s = "";
      gp(feat);
      return s;
    };
  }

  // Drawing resolution. Starts at the screen's pixel density (max 2) and steps down automatically
  // if frames come out slow while panning/zooming, so slower machines stay smooth.
  let dprCap = Math.min(2, window.devicePixelRatio || 1);
  function sizeCanvases() {
    dpr = dprCap;
    for (const c of [baseCv, topCv]) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
  }
  let lastFrame = 0,
    slowFrames = 0;
  function watchFrameRate(now) {
    const dt = now - lastFrame;
    lastFrame = now;
    if (dt > 120 || dt <= 0) return; // idle gap, not a gesture
    slowFrames = dt > 30 ? slowFrames + 1 : Math.max(0, slowFrames - 1);
    if (slowFrames >= 10 && dprCap > 1) {
      slowFrames = 0;
      dprCap = Math.max(1, dprCap - 0.5);
      sizeCanvases();
      dirtyBase = true;
    }
  }

  function buildMap() {
    const rect = topCv.getBoundingClientRect(); // the canvas sits inside the stage's 1px border
    stageRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    W = Math.max(280, rect.width);
    H = Math.max(280, rect.height);
    sizeCanvases();
    items = new Map();
    poolItems = [];
    dotItems = [];
    ctxShapes = [];
    active.clear();
    pings = [];
    hover = null;

    const mode = modeOf(settings.mode);
    const [w, s, e, n] = mode.box;
    const pts = [];
    for (let x = w; x <= e; x += (e - w) / 24) for (const y of [s, n]) pts.push([x, y]);
    for (let y = s; y <= n; y += (n - s) / 12) for (const x of [w, e]) pts.push([x, y]);
    const outline = { type: "MultiPoint", coordinates: pts };
    const top = screen === "menu" ? 20 : 76;
    const bottom = top; // equal margins keep the map centred, so the pan limit matches its starting position
    proj = d3.geoNaturalEarth1().rotate([-(w + e) / 2, 0]);
    proj.fitExtent(
      [
        [16, top],
        [W - 16, H - bottom],
      ],
      outline,
    );
    const hiPath = d3.geoPath(proj).digits(2);
    const loPath = lowRes(proj, 0.5);
    const bounds = d3.geoPath(proj);
    // The map's own outline: panning is not allowed past it.
    const outlineBox = bounds.bounds(outline);

    const pool = new Set(poolFor(settings.mode, settings.size).map((c) => c.id));

    const mkShape = (feat) => {
      const hiStr = hiPath(feat);
      if (!hiStr) return null;
      const bb = bounds.bounds(feat);
      return { hi: new Path2D(hiStr), lo: new Path2D(loPath(feat) || hiStr), bb: [bb[0][0], bb[0][1], bb[1][0], bb[1][1]] };
    };

    // Territories and non-country shapes: context only.
    for (const x of D.context) {
      const g = crop(x.geometry, mode);
      const sh = g && mkShape({ type: "Feature", geometry: g });
      if (sh) ctxShapes.push(sh);
    }

    for (const c of D.countries) {
      const g = c.geometry ? crop(c.geometry, mode) : null;
      const it = { c, hi: null, lo: null, bb: null, ax: 0, ay: 0, size: 0, lw: 0, pool: pool.has(c.id), dotCapable: false, shown: null, labelOn: false, flash: null, pulse: null, tmp: null, shake: null };
      let ok = false;
      if (g) {
        const feat = { type: "Feature", geometry: g };
        const sh = mkShape(feat);
        if (sh) {
          ok = true;
          it.hi = sh.hi;
          it.lo = sh.lo;
          it.bb = sh.bb;
          it.size = Math.max(sh.bb[2] - sh.bb[0], sh.bb[3] - sh.bb[1]);
          const big = polysOf(g).reduce((a, p) => (polyInfo(p).area > polyInfo(a).area ? p : a));
          const bigFeat = { type: "Feature", geometry: { type: "Polygon", coordinates: big } };
          const bb = bounds.bounds(bigFeat);
          it.lw = bb[1][0] - bb[0][0];
          const cen = bounds.centroid(bigFeat);
          it.ax = cen[0];
          it.ay = cen[1];
        }
      }
      if (!ok) {
        // No outline (e.g. Tuvalu): place it from its listed coordinates.
        const p = proj([c.latlng[1], c.latlng[0]]);
        if (!p) continue;
        it.ax = p[0];
        it.ay = p[1];
      }
      it.dotCapable = it.pool && (!ok || it.size < DOT_PX * 6);
      items.set(c.id, it);
      if (it.pool) poolItems.push(it);
      if (it.dotCapable) dotItems.push(it);
    }

    zoomBehavior = d3
      .zoom()
      .scaleExtent([1, 80])
      .extent([
        [0, 0],
        [W, H],
      ])
      // Can't be dragged past the edge of the map: the pan limit is the map's own outline.
      .translateExtent([
        [outlineBox[0][0], outlineBox[0][1]],
        [outlineBox[1][0], outlineBox[1][1]],
      ])
      .clickDistance(4)
      .filter((ev) => !ev.button && ev.type !== "dblclick")
      .on("zoom", (ev) => {
        transform = ev.transform;
        request(true);
      });
    const sel = d3.select(topCv);
    sel.on(".zoom", null);
    sel.call(zoomBehavior).on("dblclick.zoom", null);
    transform = d3.zoomIdentity;
    // d3 centres the map when it's smaller than the window; apply that starting position.
    sel.call(zoomBehavior.transform, d3.zoomIdentity);
    applyState();
  }

  // ---------- drawing ----------
  let dirtyBase = true,
    dirtyTop = true,
    raf = 0,
    ptr = null,
    ptrDirty = false;

  function request(base) {
    if (base) dirtyBase = true;
    dirtyTop = true;
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function frame(now) {
    raf = 0;
    watchFrameRate(now || performance.now());
    if (ptrDirty) {
      ptrDirty = false;
      moveCursor();
    }
    if (dirtyBase) {
      dirtyBase = false;
      drawBase();
    }
    dirtyTop = false;
    if (drawTop(performance.now())) request(false);
  }

  const onScreen = (bb, k, pad) => {
    const x0 = bb[0] * k + transform.x,
      x1 = bb[2] * k + transform.x,
      y0 = bb[1] * k + transform.y,
      y1 = bb[3] * k + transform.y;
    return x1 > -pad && x0 < W + pad && y1 > -pad && y0 < H + pad;
  };

  function drawBase() {
    const k = transform.k;
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.clearRect(0, 0, baseCv.width, baseCv.height);
    bctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * transform.x, dpr * transform.y);
    bctx.lineJoin = "round";
    bctx.lineWidth = 0.8 / k; // constant on-screen thickness
    bctx.strokeStyle = colors.stroke;
    const lo = k < LO_K;
    for (const sh of ctxShapes) {
      if (!onScreen(sh.bb, k, 2)) continue;
      const p = lo ? sh.lo : sh.hi;
      bctx.fillStyle = colors.ctx;
      bctx.fill(p, "evenodd");
      bctx.stroke(p);
    }
    for (const it of items.values()) {
      if (!it.hi || !onScreen(it.bb, k, 2)) continue;
      const p = lo ? it.lo : it.hi;
      bctx.fillStyle = it.pool ? (it.shown ? resultColor(it.shown) : colors.land) : colors.ctx;
      bctx.fill(p, "evenodd");
      bctx.stroke(p);
    }
  }

  // Countries with no outline at all (Tuvalu) are always a dot; others only when dots are switched on.
  const isDot = (it, k) => it.dotCapable && (!it.hi || (settings.dots && it.size * k < DOT_PX));

  function drawTop(now) {
    const k = transform.k;
    let anim = false;
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.clearRect(0, 0, topCv.width, topCv.height);

    // highlights drawn in map space
    tctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * transform.x, dpr * transform.y);
    if (hover && screen === "play" && hover.hi && !hover.shown) {
      tctx.fillStyle = colors.tint;
      tctx.fill(k < LO_K ? hover.lo : hover.hi, "evenodd");
    }
    for (const it of active) {
      if (it.flash) {
        const a = 1 - (now - it.flash.t0) / it.flash.dur;
        if (a <= 0) it.flash = null;
        else {
          anim = true;
          if (it.hi) {
            tctx.globalAlpha = Math.min(1, a * 1.1);
            tctx.fillStyle = it.flash.color;
            tctx.fill(k < LO_K ? it.lo : it.hi, "evenodd");
          }
        }
      }
      if (it.pulse) {
        const e = now - it.pulse.t0;
        if (e > it.pulse.dur) it.pulse = null;
        else {
          anim = true;
          if (it.hi) {
            tctx.globalAlpha = 0.25 + 0.75 * Math.abs(Math.sin((e / 550) * Math.PI));
            tctx.fillStyle = colors.accent;
            tctx.fill(k < LO_K ? it.lo : it.hi, "evenodd");
          }
        }
      }
      tctx.globalAlpha = 1;
    }

    // dots, labels, pings in screen space
    tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const it of dotItems) {
      if (!isDot(it, k)) continue;
      const x = it.ax * k + transform.x,
        y = it.ay * k + transform.y;
      if (x < -12 || x > W + 12 || y < -12 || y > H + 12) continue;
      let col = it === hover && screen === "play" ? colors.dotHover : colors.dot;
      if (it.shown) col = resultColor(it.shown);
      if (it.flash) col = it.flash.color;
      if (it.pulse && Math.sin(((now - it.pulse.t0) / 550) * Math.PI) > 0) col = colors.accent;
      tctx.beginPath();
      tctx.arc(x, y, 3.4, 0, 6.2832);
      tctx.fillStyle = col;
      tctx.fill();
      tctx.lineWidth = 1;
      tctx.strokeStyle = colors.ocean;
      tctx.stroke();
    }

    tctx.lineJoin = "round";
    tctx.textBaseline = "alphabetic";
    for (const it of poolItems) {
      const tmp = it.tmp && it.tmp.until > now ? it.tmp : null;
      if (it.tmp && !tmp) it.tmp = null;
      if (!it.labelOn && !tmp) continue;
      let x = it.ax * k + transform.x,
        y = it.ay * k + transform.y;
      if (x < -80 || x > W + 80 || y < -30 || y > H + 30) continue;
      const asDot = isDot(it, k);
      const name = it.c.name;
      let fs;
      if (asDot) {
        fs = 9;
        x += 7;
        y += 3;
      } else {
        fs = Math.max(9, Math.min(14, (it.lw * k) / (name.length * 0.56)));
        y += fs * 0.35;
      }
      if (tmp && tmp.kind === "wrong") fs = Math.max(fs, 12);
      // a wrong guess: the label appears and shakes
      if (it.shake) {
        const e = now - it.shake.t0;
        if (e > it.shake.dur) it.shake = null;
        else {
          anim = true;
          x += Math.sin(e / 38) * 7 * (1 - e / it.shake.dur);
        }
      }
      if (tmp) anim = true;
      tctx.font = "700 " + fs + "px " + FONT;
      tctx.textAlign = asDot ? "left" : "center";
      tctx.lineWidth = 3;
      tctx.strokeStyle = tmp && tmp.kind === "wrong" ? "rgb(150 30 22 / 92%)" : "rgb(10 10 10 / 72%)";
      tctx.strokeText(name, x, y);
      tctx.fillStyle = "#fff";
      tctx.fillText(name, x, y);
    }

    if (pings.length) {
      tctx.lineWidth = 3;
      tctx.strokeStyle = colors.accent;
      pings = pings.filter((p) => now - p.t0 < 1800);
      for (const p of pings) {
        const it = items.get(p.id);
        if (!it) continue;
        anim = true;
        const ph = ((now - p.t0) % 900) / 900;
        tctx.globalAlpha = 1 - ph;
        tctx.beginPath();
        tctx.arc(it.ax * k + transform.x, it.ay * k + transform.y, 5 + ph * 34, 0, 6.2832);
        tctx.stroke();
      }
      tctx.globalAlpha = 1;
    }

    // forget items whose effects ended
    for (const it of active) if (!it.flash && !it.pulse && !it.shake && !(it.tmp && it.tmp.until > now)) active.delete(it);
    return anim || active.size > 0;
  }

  // Paint results (fill + labels) onto the map.
  function applyState() {
    const level = levelOf(settings.level);
    const reveal = screen === "end" || screen === "review";
    for (const it of poolItems) {
      const r = game && game.results.get(it.c.id);
      it.shown = r && (level.fill || reveal) ? r : null;
      it.labelOn = !!it.shown;
    }
    request(true);
  }

  const touch = (it) => active.add(it);

  // ---------- hit testing ----------
  function hit(px, py) {
    const k = transform.k;
    let best = null,
      bd = 100; // 10px radius for dots
    for (const it of dotItems) {
      if (!isDot(it, k)) continue;
      const dx = it.ax * k + transform.x - px,
        dy = it.ay * k + transform.y - py;
      const d = dx * dx + dy * dy;
      if (d < bd) {
        bd = d;
        best = it;
      }
    }
    if (best) return best;
    const mx = (px - transform.x) / k,
      my = (py - transform.y) / k;
    for (const it of poolItems) {
      if (!it.hi) continue;
      const b = it.bb;
      if (mx < b[0] || mx > b[2] || my < b[1] || my > b[3]) continue;
      if (hitCtx.isPointInPath(it.hi, mx, my, "evenodd")) return it;
    }
    // Nothing exactly under the pointer: allow a few pixels of slack so thin or tiny
    // countries (Gambia, Sao Tome ...) can still be clicked.
    const slack = 5 / k;
    hitCtx.lineWidth = slack * 2;
    let near = null,
      nearSize = Infinity;
    for (const it of poolItems) {
      if (!it.hi) continue;
      const b = it.bb;
      if (mx < b[0] - slack || mx > b[2] + slack || my < b[1] - slack || my > b[3] + slack) continue;
      if (it.size < nearSize && hitCtx.isPointInStroke(it.hi, mx, my)) {
        near = it;
        nearSize = it.size;
      }
    }
    return near;
  }

  // ---------- game ----------
  let screen = "menu"; // menu | play | end | review
  let game = null;

  const shuffle = (a) => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const targetId = () => game.queue[game.i];
  const targetName = () => items.get(targetId()).c.name;

  function setScreen(s) {
    screen = s;
    stage.dataset.screen = s;
    $("#menu").hidden = s !== "menu";
    $("#end").hidden = s !== "end";
    $("#btn-results").hidden = s !== "review";
    if (s !== "play") cursorEl.hidden = true;
  }

  function startGame() {
    const pool = poolFor(settings.mode, settings.size);
    if (!pool.length) return;
    const level = levelOf(settings.level);
    game = {
      queue: shuffle(pool.map((c) => c.id)),
      i: 0,
      tries: level.tries,
      left: level.tries,
      results: new Map(),
      wrong: 0,
      firstTry: 0,
      busy: false,
      t0: performance.now(),
      t1: null,
    };
    setScreen("play");
    buildMap(); // re-fit with room for the HUD
    updateHud();
  }

  function pick(it) {
    if (screen !== "play" || game.busy || !it || !it.pool) return;
    const level = levelOf(settings.level);
    if (level.fill && game.results.has(it.c.id)) {
      // already filled in: its label shakes, no penalty
      it.shake = { t0: performance.now(), dur: 450 };
      touch(it);
      request(false);
      return;
    }
    if (it.c.id === targetId()) onCorrect(it);
    else onWrong(it);
  }

  function onCorrect(it) {
    const tries = game.tries - game.left + 1;
    game.results.set(it.c.id, { ok: true, tries });
    if (tries === 1) game.firstTry++;
    if (!levelOf(settings.level).fill) {
      // nothing fills in on Hard/Expert, so give a brief glow to confirm
      it.flash = { color: resultColor({ ok: true, tries }), t0: performance.now(), dur: 700 };
      touch(it);
    }
    applyState();
    next();
  }

  function onWrong(it) {
    game.wrong++;
    game.left--;
    const now = performance.now();
    // The label under the cursor does not change. The clicked country shows its own name and shakes.
    it.flash = { color: colors.wrong, t0: now, dur: 700 };
    it.tmp = { until: now + 1200, kind: "wrong" };
    it.shake = { t0: now, dur: 600 };
    touch(it);
    if (game.left <= 0) miss(false);
    else {
      updateHud();
      request(false);
    }
  }

  function miss(skipped) {
    const it = items.get(targetId());
    game.results.set(it.c.id, { ok: false, skipped });
    game.busy = true;
    const now = performance.now();
    it.pulse = { t0: now, dur: 1650 };
    it.tmp = { until: now + 1800, kind: "reveal" };
    pings.push({ id: it.c.id, t0: now });
    touch(it);
    applyState();
    updateHud();
    setTimeout(() => {
      game.busy = false;
      next();
    }, 1800);
  }

  function next() {
    game.i++;
    if (game.i >= game.queue.length) return finish();
    game.left = game.tries;
    updateHud();
  }

  function finish() {
    game.t1 = performance.now();
    clearInterval(timer);
    game.busy = true;
    setTimeout(() => {
      if (screen === "play") showEnd();
    }, 700);
  }

  // ---------- label under the cursor + HUD ----------
  let pillW = 80;
  function setPill() {
    if (game && game.i < game.queue.length) {
      pillEl.innerHTML = `<span class="k">Find</span><b></b>`;
      pillEl.querySelector("b").textContent = targetName();
      pillW = pillEl.offsetWidth; // measured once per country, not on every mouse move
    } else pillEl.innerHTML = "";
  }
  const fmt = (ms) => {
    const t = Math.floor(ms / 1000);
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
  };
  let timer = null;
  let shownTarget = -1;
  function updateHud() {
    if (!game) return;
    const total = game.queue.length;
    const ok = [...game.results.values()].filter((r) => r.ok).length;
    $("#st-ok").textContent = ok;
    $("#st-miss").textContent = game.results.size - ok;
    $("#st-prog").textContent = `${Math.min(game.i + 1, total)} / ${total}`;
    if (game.i < total) {
      $("#pips").innerHTML = Array.from({ length: game.tries }, (_, i) => `<i class="${i < game.left ? "" : "off"}"></i>`).join("");
      if (shownTarget !== game.i) {
        shownTarget = game.i;
        $("#target-name").textContent = targetName();
        setPill();
      }
    }
    clearInterval(timer);
    timer = setInterval(() => {
      $("#st-time").textContent = fmt((game.t1 || performance.now()) - game.t0);
    }, 250);
    $("#st-time").textContent = fmt((game.t1 || performance.now()) - game.t0);
  }

  // ---------- end screen ----------
  function showEnd() {
    const total = game.queue.length;
    const ok = [...game.results.values()].filter((r) => r.ok).length;
    const missed = game.queue.filter((id) => !game.results.get(id).ok).map((id) => items.get(id).c.name);
    const pct = Math.round((ok / total) * 100);
    $("#end-score").textContent = `${ok} / ${total}`;
    $("#end-hand").textContent = pct === 100 ? "flawless!" : pct >= 80 ? "great run" : pct >= 50 ? "not bad at all" : "keep exploring";
    $("#end-sub").textContent = `${modeOf(settings.mode).name} · ${SIZES.find((s) => s.id === settings.size).name} countries · ${levelOf(settings.level).name}`;
    $("#end-stats").innerHTML = [
      [pct + "%", "found"],
      [Math.round((game.firstTry / total) * 100) + "%", "first try"],
      [fmt(game.t1 - game.t0), "time"],
    ]
      .map(([b, s]) => `<div><b>${b}</b><span>${s}</span></div>`)
      .join("");
    $("#end-missed-wrap").hidden = !missed.length;
    const chips = $("#end-missed");
    chips.textContent = "";
    for (const name of missed.sort()) {
      const s = document.createElement("span");
      s.textContent = name;
      chips.appendChild(s);
    }
    setScreen("end");
    applyState();
  }

  // ---------- menu ----------
  function renderMenu() {
    const mg = $("#mode-grid");
    mg.innerHTML = "";
    for (const m of MODES) {
      const n = poolFor(m.id, "all").length;
      mg.appendChild(
        opt(m.name, `${n} countries`, settings.mode === m.id, () => {
          settings.mode = m.id;
          if (!poolFor(settings.mode, settings.size).length) settings.size = "all";
          changed(true);
        }),
      );
    }
    const sg = $("#size-seg");
    sg.innerHTML = "";
    for (const s of SIZES) {
      const n = poolFor(settings.mode, s.id).length;
      const b = document.createElement("button");
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(settings.size === s.id));
      b.disabled = n === 0;
      b.innerHTML = `${s.name}<small>${n ? n + " · " : ""}${s.sub}</small>`;
      b.onclick = () => {
        settings.size = s.id;
        changed(true);
      };
      sg.appendChild(b);
    }
    const lg = $("#level-grid");
    lg.innerHTML = "";
    for (const l of LEVELS) {
      lg.appendChild(
        opt(l.name, l.desc, settings.level === l.id, () => {
          settings.level = l.id;
          changed(false);
        }),
      );
    }
    const n = poolFor(settings.mode, settings.size).length;
    $("#start-count").textContent = `· ${n} ${n === 1 ? "country" : "countries"}`;
  }
  function opt(title, sub, checked, onclick) {
    const b = document.createElement("button");
    b.className = "opt";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(checked));
    b.innerHTML = `<span class="t"></span><span class="s"></span>`;
    b.querySelector(".t").textContent = title;
    b.querySelector(".s").textContent = sub;
    b.onclick = onclick;
    return b;
  }
  function changed(rebuild) {
    saveSettings();
    renderMenu();
    if (rebuild && screen === "menu") buildMap();
  }

  // ---------- input ----------
  topCv.addEventListener("click", (ev) => {
    if (screen !== "play") return;
    const r = topCv.getBoundingClientRect();
    pick(hit(ev.clientX - r.left, ev.clientY - r.top));
  });

  function moveCursor() {
    if (!ptr) return;
    if (screen === "play" && ptr.type !== "touch") {
      cursorEl.hidden = false;
      // keep the label on screen near the edges
      const half = pillW / 2 + 8;
      const lx = Math.max(half, Math.min(stageRect.width - half, ptr.x)) - ptr.x;
      pillEl.style.transform = `translateX(calc(-50% + ${lx}px))`;
      cursorEl.style.transform = `translate3d(${ptr.x}px,${ptr.y}px,0)`;
      const h = hit(ptr.x, ptr.y);
      if (h !== hover) {
        hover = h;
        dirtyTop = true;
        if (!raf) raf = requestAnimationFrame(frame);
      }
    }
  }
  stage.addEventListener("pointermove", (ev) => {
    if (screen !== "play" || ev.pointerType === "touch") return;
    ptr = { x: ev.clientX - stageRect.left, y: ev.clientY - stageRect.top, type: ev.pointerType };
    ptrDirty = true;
    if (!raf) raf = requestAnimationFrame(frame);
  });
  stage.addEventListener("pointerleave", () => {
    cursorEl.hidden = true;
    if (hover) {
      hover = null;
      request(false);
    }
  });
  // Hide the label over the HUD buttons.
  for (const sel of ["#hud > *", "#hud-bottom > *"]) {
    document.querySelectorAll(sel).forEach((el) => {
      el.addEventListener("pointerenter", () => (cursorEl.hidden = true));
    });
  }

  const zoomBy = (f) => d3.select(topCv).transition().duration(220).call(zoomBehavior.scaleBy, f);
  $("#z-in").onclick = () => zoomBy(1.7);
  $("#z-out").onclick = () => zoomBy(1 / 1.7);
  $("#z-reset").onclick = () => d3.select(topCv).transition().duration(300).call(zoomBehavior.transform, d3.zoomIdentity);

  function toMenu() {
    clearInterval(timer);
    game = null;
    shownTarget = -1;
    setScreen("menu");
    buildMap();
    renderMenu();
  }
  $("#btn-menu").onclick = toMenu;
  $("#e-menu").onclick = toMenu;
  $("#btn-start").onclick = () => {
    shownTarget = -1;
    startGame();
  };
  $("#e-again").onclick = () => {
    shownTarget = -1;
    startGame();
  };
  $("#e-map").onclick = () => {
    setScreen("review");
    applyState();
  };
  $("#btn-results").onclick = () => setScreen("end");
  $("#btn-skip").onclick = () => {
    if (screen === "play" && !game.busy) miss(true);
  };

  // dots for small countries
  function renderDots() {
    $("#btn-dots").setAttribute("aria-pressed", String(settings.dots));
    $("#m-dots").setAttribute("aria-checked", String(settings.dots));
  }
  function toggleDots() {
    settings.dots = !settings.dots;
    saveSettings();
    renderDots();
    hover = null;
    request(true);
  }
  $("#btn-dots").onclick = toggleDots;
  $("#m-dots").onclick = toggleDots;
  renderDots();

  // theme
  function toggleTheme() {
    const dark = document.documentElement.classList.toggle("dark");
    try {
      localStorage.setItem("worldz-theme", dark ? "dark" : "light");
    } catch (e) {}
    readColors();
    request(true);
  }
  $("#btn-theme").onclick = toggleTheme;
  $("#m-theme").onclick = toggleTheme;

  // full screen
  const root = document.documentElement;
  const reqFs = root.requestFullscreen || root.webkitRequestFullscreen;
  function toggleFs() {
    if (!reqFs) return;
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else {
        const r = reqFs.call(root);
        if (r && r.catch) r.catch(() => {});
      }
    } catch (e) {}
  }
  if (!reqFs) for (const b of ["#btn-fs", "#m-fs"]) $(b).hidden = true;
  $("#btn-fs").onclick = toggleFs;
  $("#m-fs").onclick = toggleFs;

  window.addEventListener("keydown", (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.key === "f" || ev.key === "F") toggleFs();
    else if ((ev.key === "s" || ev.key === "S") && screen === "play" && !game.busy) miss(true);
    else if (ev.key === "d" || ev.key === "D") toggleDots();
  });

  // re-fit the map when the window (or full screen) changes size
  let rt = null;
  new ResizeObserver(() => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      const r = topCv.getBoundingClientRect();
      stageRect = { left: r.left, top: r.top, width: r.width, height: r.height };
      if (Math.abs(r.width - W) > 1 || Math.abs(r.height - H) > 1) buildMap();
    }, 120);
  }).observe(stage);

  // Test hook, only present when the page is opened with #debug.
  if (location.hash === "#debug") {
    window.__worldz = {
      // client coordinates of a point that really hits the country
      screenPoint(id) {
        const it = items.get(id);
        if (!it) return null;
        const k = transform.k;
        const tryPt = (x, y) => (hit(x, y) === it ? [x + stageRect.left, y + stageRect.top] : null);
        let r = tryPt(it.ax * k + transform.x, it.ay * k + transform.y);
        if (r || !it.bb) return r;
        for (let a = 0; a <= 20 && !r; a++) for (let b = 0; b <= 20 && !r; b++) r = tryPt((it.bb[0] + ((it.bb[2] - it.bb[0]) * a) / 20) * k + transform.x, (it.bb[1] + ((it.bb[3] - it.bb[1]) * b) / 20) * k + transform.y);
        return r;
      },
      target: () => (game ? targetId() : null),
      // average ms to draw one full frame (map + overlay) at zoom k, in software rendering
      bench(k, n = 40) {
        const save = transform;
        transform = d3.zoomIdentity.translate(W / 2 - (W / 2) * k, H / 2 - (H / 2) * k).scale(k);
        const t0 = performance.now();
        for (let i = 0; i < n; i++) {
          drawBase();
          drawTop(performance.now());
          bctx.getImageData(0, 0, 1, 1); // force each frame to really render
          tctx.getImageData(0, 0, 1, 1);
        }
        const ms = (performance.now() - t0) / n;
        transform = save;
        request(true);
        return ms;
      },
      hitAt(cx, cy) {
        const r = topCv.getBoundingClientRect();
        const h = hit(cx - r.left, cy - r.top);
        return h ? h.c.id : null;
      },
    };
  }

  // ---------- go ----------
  readColors();
  renderMenu();
  buildMap();
})();
