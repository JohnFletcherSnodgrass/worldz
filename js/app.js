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
  const HD_K = 4; // from this zoom on, the detailed 1:10m outlines are used (once they have loaded)
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

  // Everything in the Hints dropdown. Each one can be switched on or off.
  const HINTS = [
    { group: "Help while you play" },
    { id: "label", t: "Name under the pointer", s: "The country to find follows your mouse. It's always shown at the top as well." },
    { id: "arrow", t: "Direction arrow", s: "After a wrong guess, an arrow points toward the answer and shows how far off you were (3-guess levels)." },
    { id: "neighbours", t: "Neighbour outline", s: "On your last guess, outlines the countries that border the answer. Islands have none (3-guess levels)." },
    { id: "fly", t: "Fly to the answer", s: "When you miss, the map zooms to the country, then back." },
    { id: "retry", t: "Missed countries come back", s: "They're asked again later in the round. Your score keeps the first try." },
    { id: "tints", t: "Region tints", s: "A faint colour per region, like West Africa or the Caribbean." },
    { id: "dots", t: "Dots for small countries", s: "Tiny countries show as a clickable dot until you zoom in. Key: D." },
    { group: "Extras" },
    { id: "streak", t: "Streak and best scores", s: "Your streak while playing, and your best score and time on each map." },
    { id: "pop", t: "Pop when you get one right", s: "" },
    { id: "grain", t: "Paper grain", s: "A light paper texture on the map." },
    { id: "flags", t: "Flags on the results screen", s: "" },
  ];
  const HINT_DEFAULTS = { label: true, arrow: true, neighbours: true, fly: true, retry: false, tints: false, dots: true, streak: true, pop: true, grain: true, flags: true };

  // ---------- settings (remembered, but the app works without storage) ----------
  const CONTINENTS = MODES.filter((m) => m.id !== "world").map((m) => m.id);
  const DEFAULTS = { continents: [...CONTINENTS], size: "all", level: "easy", view: "flat" };
  let settings = { ...DEFAULTS, hints: { ...HINT_DEFAULTS } };
  try {
    const saved = JSON.parse(localStorage.getItem("worldz-settings") || "null");
    if (saved && SIZES.some((s) => s.id === saved.size) && LEVELS.some((l) => l.id === saved.level)) {
      const hints = { ...HINT_DEFAULTS, ...(saved.hints || {}) };
      if (saved.dots === false) hints.dots = false; // older saved setting
      let continents = Array.isArray(saved.continents) ? saved.continents.filter((c) => CONTINENTS.includes(c)) : saved.mode && saved.mode !== "world" && CONTINENTS.includes(saved.mode) ? [saved.mode] : [...CONTINENTS];
      if (!continents.length) continents = [...CONTINENTS];
      settings = { continents, size: saved.size, level: saved.level, view: saved.view === "globe" ? "globe" : "flat", hints };
    }
  } catch (e) {}
  const isGlobe = () => settings.view === "globe";
  const hint = (id) => !!settings.hints[id];
  const saveSettings = () => {
    try {
      localStorage.setItem("worldz-settings", JSON.stringify(settings));
    } catch (e) {}
  };

  // ---------- data helpers ----------
  const modeOf = (id) => MODES.find((m) => m.id === id);
  const levelOf = (id) => LEVELS.find((l) => l.id === id);
  // A selection is any set of continents; all of them is "World".
  const isWorld = (list) => list.length === CONTINENTS.length;
  const sizeOk = (c, size) => size === "all" || (size === "small" ? c.area < SMALL_KM2 : c.area >= SMALL_KM2);
  const poolFor = (list, size) => D.countries.filter((c) => (isWorld(list) || c.continents.some((x) => list.includes(x))) && sizeOk(c, size));
  const selectionName = (list) => (isWorld(list) ? "World" : CONTINENTS.filter((c) => list.includes(c)).map((c) => modeOf(c).name).join(" + "));
  const selectionKey = (list) => (isWorld(list) ? "world" : [...list].sort().join("+"));
  // The area to start on: the smallest lon/lat box around every chosen continent.
  function selectionBox(list) {
    if (isWorld(list) || !list.length) return MODES[0].box;
    if (list.length === 1) return modeOf(list[0]).box;
    const covered = new Array(360).fill(false);
    let s = 90,
      n = -90;
    for (const id of list) {
      const [w, bs, e, bn] = modeOf(id).box;
      s = Math.min(s, bs);
      n = Math.max(n, bn);
      for (let x = Math.floor(w); x < Math.ceil(e); x++) covered[(((x + 180) % 360) + 360) % 360] = true;
    }
    // the widest stretch of longitude nobody uses is where the map gets cut
    let best = 0,
      bestEnd = 0;
    for (let i = 0; i < 720; i++) {
      let len = 0;
      while (len < 360 && !covered[(i + len) % 360]) len++;
      if (len > best) {
        best = len;
        bestEnd = i + len;
      }
      i += len;
    }
    if (best < 40) return MODES[0].box; // the choice wraps almost all the way round
    const start = (bestEnd % 360) - 180;
    return [start, s, start + (360 - best), n];
  }

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

  // Real-world centre of each country's main landmass, for "how far off" distances.
  const geoAnchor = new Map();
  for (const c of D.countries) {
    if (c.geometry) {
      const big = polysOf(c.geometry).reduce((a, p) => (polyInfo(p).area > polyInfo(a).area ? p : a));
      geoAnchor.set(c.id, d3.geoCentroid(polyInfo(big).poly));
    } else geoAnchor.set(c.id, [c.latlng[1], c.latlng[0]]);
  }
  const distanceKm = (a, b) => d3.geoDistance(geoAnchor.get(a), geoAnchor.get(b)) * R;

  // One soft colour per sub-region (from the country list), for the region tints.
  const TINTS = ["#ff5e3a", "#4e6bff", "#2e9e72", "#e2b100", "#7a5cff", "#14a3b8", "#d6447f", "#b0492e", "#8fbf3a", "#c77dff"];
  const regionTint = new Map([...new Set(D.countries.map((c) => c.subregion))].sort().map((r, i) => [r, TINTS[i % TINTS.length]]));

  // Four soft shades of land, spread so countries that share a border get different ones
  // (greedy colouring over the real border list). Same for everyone, so it gives nothing away.
  const shadeOf = new Map();
  for (const c of [...D.countries].sort((a, b) => (b.neighbors || []).length - (a.neighbors || []).length)) {
    const taken = new Set((c.neighbors || []).map((n) => shadeOf.get(n)));
    let i = 0;
    while (taken.has(i) && i < 3) i++;
    shadeOf.set(c.id, i);
  }

  // ---------- detailed outlines (data/world-hi.js, ~1 MB gzipped), fetched in the background ----------
  let HD = null;
  function loadScript(src) {
    return new Promise((ok, fail) => {
      const el = document.createElement("script");
      el.src = src;
      el.onload = ok;
      el.onerror = fail;
      document.head.appendChild(el);
    });
  }
  function loadHd() {
    if (loadHd.started) return;
    loadHd.started = true;
    Promise.all([window.topojson ? null : loadScript("vendor/topojson-client.min.js"), loadScript("data/world-hi.js")])
      .then(() => {
        const h = window.WORLDZ_HI;
        const geoms = h.topo.objects.countries.geometries;
        const geomOf = (idx) => fixWinding(idx.length > 1 ? topojson.merge(h.topo, idx.map((i) => geoms[i])) : topojson.feature(h.topo, geoms[idx[0]]).geometry);
        HD = { countries: h.countries, context: h.context, geomOf };
        warmHd();
        glBuildHd();
        request(true);
      })
      .catch(() => {}); // no detailed outlines: the 1:50m ones carry on
  }
  // d3 reads a polygon wound the wrong way as "the whole globe except this shape"; a few
  // 1:10m pieces (in the Maldives) come out like that, which painted the whole sea grey.
  function fixWinding(g) {
    if (!g) return g;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    for (const p of polys) if (d3.geoArea({ type: "Polygon", coordinates: p }) > 2 * Math.PI) p.forEach((ring) => ring.reverse());
    return g;
  }
  function buildHd(it) {
    const idx = HD.countries[it.c.id];
    it.hd = idx ? new Path2D(hdPath({ type: "Feature", geometry: HD.geomOf(idx) }) || "") : null;
  }
  // Build the detailed outlines a few at a time while the browser is idle, so zooming in
  // never stalls on them.
  function warmHd() {
    if (!HD || !proj || gl) return; // the WebGL map builds its own; outlines for clicks are made when needed
    const gen = ++warmHd.gen;
    const todo = [...items.values()].filter((it) => it.hi && it.hd === undefined);
    const idle = window.requestIdleCallback || ((f) => setTimeout(() => f({ timeRemaining: () => 8 }), 16));
    const step = (dl) => {
      if (gen !== warmHd.gen) return; // the map was rebuilt
      while (todo.length && dl.timeRemaining() > 2) {
        const it = todo.pop();
        if (it.hd === undefined) buildHd(it);
      }
      if (todo.length) idle(step);
      else if (transform.k >= HD_K) request(true);
    };
    idle(step);
  }
  warmHd.gen = 0;
  // While you're zooming or dragging, the lighter 1:50m outlines are drawn; the detailed ones
  // come in once the map stops moving.
  let moving = false,
    settleTimer = 0;
  // The outline to draw or hit-test for a country at zoom k.
  function pathFor(it, k) {
    if (k < LO_K) return it.lo;
    if (k >= HD_K && HD && !moving) {
      if (it.hd === undefined) buildHd(it);
      if (it.hd) return it.hd;
    }
    return it.hi;
  }
  let hdCtx = null;
  function hdContext() {
    if (!hdCtx) {
      hdCtx = [];
      for (const i of HD.context) {
        const feat = { type: "Feature", geometry: HD.geomOf([i]) };
        const str = hdPath(feat);
        if (!str) continue;
        const bb = d3.geoPath(proj).bounds(feat);
        hdCtx.push({ hd: new Path2D(str), bb: [bb[0][0], bb[0][1], bb[1][0], bb[1][1]] });
      }
    }
    return hdCtx;
  }

  // ---------- colours (read from the CSS tokens so light/dark and the Pebblez palette stay in one place) ----------
  let colors = {};
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const g = (n) => cs.getPropertyValue(n).trim();
    colors = {
      land: g("--land"),
      shades: [g("--land"), g("--land-2"), g("--land-3"), g("--land-4")],
      ctx: g("--land-ctx"),
      stroke: g("--land-stroke"),
      ocean: g("--ocean"),
      t1: g("--good-1"),
      t2: g("--good-2"),
      t3: g("--good-3"),
      missed: g("--bad"),
      wrong: g("--destructive"),
      accent: g("--accent"),
      dot: g("--dot"),
      dotHover: g("--foreground"),
      tint: g("--hover-tint"),
      coral: g("--coral"),
      dark: document.documentElement.classList.contains("dark"),
    };
  }
  const resultColor = (r) => (r.ok ? colors["t" + Math.min(3, r.tries)] : colors.missed);

  // ---------- map ----------
  let W = 0,
    H = 0,
    dpr = 1,
    proj = null,
    hdPath = null,
    transform = d3.zoomIdentity,
    zoomBehavior = null;
  let items = new Map(); // country id -> item
  let poolItems = []; // clickable countries
  let dotItems = []; // pool countries that can show as a dot
  let ctxShapes = []; // territories etc, not clickable
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
    for (const c of [baseCv, topCv, glCv]) {
      if (!c) continue;
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

  const millerRaw = (l, p) => [l, 1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * p))];
  millerRaw.invert = (x, y) => [x, 2.5 * Math.atan(Math.exp(0.8 * y)) - 0.625 * Math.PI];

  // ---------- globe ----------
  let globeView = null, // { rot: [λ, φ], zoom } where you are now
    globeSpawn = null, // where this map started (the reset button goes back here)
    globeR = 200,
    globeMoving = false;
  const clampN = (v, a, b) => Math.max(a, Math.min(b, v));
  function spawnGlobe(w, s, e, n) {
    const cx = (w + e) / 2,
      cy = clampN((s + n) / 2, -60, 60);
    const world = e - w > 300;
    let r = 0;
    for (const p of [
      [w, s],
      [w, n],
      [e, s],
      [e, n],
      [cx, s],
      [cx, n],
      [w, cy],
      [e, cy],
    ])
      r = Math.max(r, d3.geoDistance([cx, cy], p));
    const zoom = world ? 1 : clampN(0.95 / Math.sin(Math.min(r, Math.PI / 2)), 1, 6);
    return { rot: [-cx, world ? -15 : -cy], zoom };
  }
  const sea = $("#sea");
  function placeSea() {
    const r = proj.scale();
    sea.style.width = sea.style.height = 2 * r + "px";
    sea.style.transform = `translate(${W / 2 - r}px, ${H / 2 - r}px)`;
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

    const [w, s, e, n] = selectionBox(settings.continents);
    const globe = isGlobe();
    stage.classList.toggle("globe", globe);
    const zh = document.querySelector("#hud-bottom .hint");
    if (zh) zh.textContent = globe ? "Scroll to zoom · drag to spin" : "Scroll to zoom · drag to pan";
    const pts = [];
    for (let x = w; x <= e; x += (e - w) / 24) for (const y of [s, n]) pts.push([x, y]);
    for (let y = s; y <= n; y += (n - s) / 12) for (const x of [w, e]) pts.push([x, y]);
    const outline = { type: "MultiPoint", coordinates: pts };
    const top = screen === "menu" ? 20 : 76;
    const bottom = top; // equal margins keep the map centred, so the pan limit matches its starting position
    if (globe) {
      // Globe: orthographic, centred on the chosen area. Dragging spins it (see "globe" below).
      if (!globeView) globeView = globeSpawn = spawnGlobe(w, s, e, n);
      globeR = Math.min(W - 32, H - top - bottom) / 2;
      proj = d3.geoOrthographic().clipAngle(90).precision(0.2).rotate(globeView.rot).scale(globeR * globeView.zoom).translate([W / 2, H / 2]);
      placeSea();
    } else {
      // Flat map: Miller cylindrical (a rectangle, like Mercator but less stretched near the poles).
      proj = d3.geoProjection(millerRaw).rotate([-(w + e) / 2, 0]);
      proj.fitExtent(
        [
          [16, top],
          [W - 16, H - bottom],
        ],
        outline,
      );
    }
    const hiPath = d3.geoPath(proj).digits(2);
    hdPath = d3.geoPath(proj).digits(3);
    hdCtx = null;
    const loPath = lowRes(proj, 0.5);
    const bounds = d3.geoPath(proj);
    // You start locked on the chosen map, but can zoom out and pan over the whole world.
    // Panning stops at the world's own outline (Antarctica isn't drawn, so the bottom edge stops at 58°S).
    const cx = (w + e) / 2;
    const worldPts = [];
    for (let i = 0; i <= 72; i++) for (const y of [-58, 85]) worldPts.push([cx - 179.9 + (359.8 * i) / 72, y]);
    for (let y = -58; y <= 85; y += 11) for (const x of [cx - 179.9, cx + 179.9]) worldPts.push([x, y]);
    const outlineBox = bounds.bounds({ type: "MultiPoint", coordinates: worldPts });
    const kMin = Math.min(1, (W - 32) / (outlineBox[1][0] - outlineBox[0][0]), (H - top - bottom) / (outlineBox[1][1] - outlineBox[0][1]));

    const pool = new Set(poolFor(settings.continents, settings.size).map((c) => c.id));

    const mkShape = (feat) => {
      const hiStr = hiPath(feat);
      if (!hiStr) return null;
      const bb = bounds.bounds(feat);
      return { hi: new Path2D(hiStr), lo: new Path2D(loPath(feat) || hiStr), bb: [bb[0][0], bb[0][1], bb[1][0], bb[1][1]] };
    };

    // Territories and non-country shapes: context only.
    for (const x of D.context) {
      const sh = mkShape({ type: "Feature", geometry: x.geometry });
      if (sh) {
        sh.geom = x.geometry;
        ctxShapes.push(sh);
      }
    }

    for (const c of D.countries) {
      const g = c.geometry;
      const it = { c, hi: null, lo: null, bb: null, ax: 0, ay: 0, size: 0, lw: 0, hd: undefined, pool: pool.has(c.id), dotCapable: false, shown: null, labelOn: false, flash: null, pulse: null, tmp: null, shake: null };
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
        // No outline (e.g. Tuvalu, or anything on the far side of the globe): place it from its coordinates.
        const ll = [c.latlng[1], c.latlng[0]];
        const p = proj(ll);
        if (!p) continue;
        it.ax = p[0];
        it.ay = p[1];
        if (globe && d3.geoDistance(ll, [-globeView.rot[0], -globeView.rot[1]]) > Math.PI / 2 - 0.02) it.hidden = true;
      }
      it.dotCapable = it.pool && !it.hidden && (!ok || it.size < DOT_PX * 6);
      items.set(c.id, it);
      if (it.pool) poolItems.push(it);
      if (it.dotCapable) dotItems.push(it);
    }

    zoomBehavior = d3
      .zoom()
      .scaleExtent([kMin, 80])
      .extent([
        [0, 0],
        [W, H],
      ])
      // Can't be dragged past the edge of the world map.
      .translateExtent([
        [outlineBox[0][0], outlineBox[0][1]],
        [outlineBox[1][0], outlineBox[1][1]],
      ])
      .clickDistance(4)
      .filter((ev) => !ev.button && ev.type !== "dblclick")
      .on("zoom", (ev) => {
        transform = ev.transform;
        if (ev.sourceEvent) {
          // Your own drag / scroll / pinch: slide the last drawing (cheap), redraw once you pause.
          moving = true;
          clearTimeout(settleTimer);
          settleTimer = setTimeout(() => {
            moving = false;
            request(true);
          }, 140);
          request(!!gl); // WebGL redraws every frame; the 2D canvas slides its last picture
        } else request(true); // fly-to and button zooms animate with real redraws
      });
    const sel = d3.select(topCv);
    sel.on(".zoom", null);
    transform = d3.zoomIdentity;
    if (!globe) {
      sel.call(zoomBehavior).on("dblclick.zoom", null);
      // d3 centres the map when it's smaller than the window; apply that starting position.
      sel.call(zoomBehavior.transform, d3.zoomIdentity);
    }
    moving = false;
    glBuildMd();
    warmHd();
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
    if (globeMoving) return; // the spinning globe draws its own quick picture
    if (ptrDirty) {
      ptrDirty = false;
      moveCursor();
    }
    if (!gl && !dirtyBase && moving && !slideBase()) dirtyBase = true;
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

  // ---------- WebGL map ----------
  // The map is drawn on the graphics card: every outline is turned into triangles once, and
  // zooming or panning only changes two numbers in the shader, so it stays smooth at any zoom,
  // with nothing left to "fill in" afterwards. Countries are filled with the stencil trick
  // (fan triangles flip a stencil bit, then a box is painted where the bit is set), which gives
  // the same even-odd result as the 2D canvas without a triangulation library. Borders are thin
  // quads, one per outline segment, drawn in a single instanced call.
  // Without WebGL2 the 2D canvas renderer below carries on as before.
  let gl = null,
    glCv = null;
  let glMd = null, // 1:50m geometry for the current projection
    glHd = null; // 1:10m, built in idle time once world-hi.js has loaded
  const GL_FILL_VS = `#version 300 es
    in vec2 p; uniform vec3 xf; uniform vec2 res;
    void main() { vec2 s = p * xf.x + xf.yz; gl_Position = vec4(s / res * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0); }`;
  const GL_LINE_VS = `#version 300 es
    in vec4 seg; in vec2 corner; uniform vec3 xf; uniform vec2 res; uniform float hw;
    void main() {
      vec2 a = seg.xy * xf.x + xf.yz, b = seg.zw * xf.x + xf.yz, d = b - a;
      float l = length(d);
      vec2 u = l > 0.0 ? d / l : vec2(1.0, 0.0), n = vec2(-u.y, u.x);
      vec2 s = mix(a, b, corner.x) + n * corner.y * hw + u * (corner.x * 2.0 - 1.0) * hw;
      gl_Position = vec4(s / res * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
    }`;
  const GL_FS = `#version 300 es
    precision mediump float; uniform vec4 color; out vec4 o;
    void main() { o = color; }`;
  let glFill = null,
    glLine = null,
    glCorner = null;

  function glProgram(vs, fs) {
    const mk = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      return sh;
    };
    const pr = gl.createProgram();
    gl.attachShader(pr, mk(gl.VERTEX_SHADER, vs));
    gl.attachShader(pr, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
    const u = (n) => gl.getUniformLocation(pr, n);
    return { pr, xf: u("xf"), res: u("res"), color: u("color"), hw: u("hw") };
  }

  function initGL() {
    try {
      glCv = document.createElement("canvas");
      glCv.id = "base-gl";
      glCv.setAttribute("aria-hidden", "true");
      gl = glCv.getContext("webgl2", { antialias: true, stencil: true, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: false });
      if (!gl) throw new Error("no webgl2");
      // Software WebGL (no usable graphics card) is slower than the 2D canvas: use that instead.
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
      if (/swiftshader|llvmpipe|software|basic render/i.test(renderer)) throw new Error("software webgl");
      glFill = glProgram(GL_FILL_VS, GL_FS);
      glLine = glProgram(GL_LINE_VS, GL_FS);
      glCorner = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, glCorner);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      baseCv.parentNode.insertBefore(glCv, baseCv);
      baseCv.style.display = "none";
      glCv.addEventListener("webglcontextlost", (e) => {
        // fall back to the 2D canvas for the rest of the session
        e.preventDefault();
        gl = null;
        glCv.remove();
        baseCv.style.display = "";
        request(true);
      });
    } catch (e) {
      gl = null;
      glCv = null;
    }
  }

  // Projected outline rings (in map pixels at zoom 1) for one geometry.
  function ringsOf(geometry) {
    const rings = [];
    let cur = null;
    const sink = {
      moveTo(x, y) {
        cur = [x, y];
        rings.push(cur);
      },
      lineTo(x, y) {
        cur.push(x, y);
      },
      closePath() {},
      arc() {},
      rect() {},
    };
    d3.geoPath(proj, sink)({ type: "Feature", geometry });
    return rings;
  }

  // Collects shapes into one triangle buffer (fans + cover boxes) and one segment buffer.
  function glBuilder() {
    const tri = [],
      seg = [];
    return {
      add(geometry, bb) {
        const rings = ringsOf(geometry);
        if (!rings.length) return null;
        const start = tri.length / 2;
        for (const r of rings) {
          const n = r.length / 2;
          for (let i = 1; i + 1 < n; i++) tri.push(r[0], r[1], r[2 * i], r[2 * i + 1], r[2 * i + 2], r[2 * i + 3]);
          for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            if (r[2 * i] !== r[2 * j] || r[2 * i + 1] !== r[2 * j + 1]) seg.push(r[2 * i], r[2 * i + 1], r[2 * j], r[2 * j + 1]);
          }
        }
        const count = tri.length / 2 - start;
        if (!count) return null;
        const [x0, y0, x1, y1] = [bb[0] - 1, bb[1] - 1, bb[2] + 1, bb[3] + 1];
        const cover = tri.length / 2;
        tri.push(x0, y0, x1, y0, x0, y1, x0, y1, x1, y0, x1, y1);
        return { start, count, cover };
      },
      upload() {
        const L = { fillVao: gl.createVertexArray(), lineVao: gl.createVertexArray(), nSeg: seg.length / 4, bufs: [] };
        const triBuf = gl.createBuffer();
        gl.bindVertexArray(L.fillVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, triBuf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(tri), gl.STATIC_DRAW);
        const pLoc = gl.getAttribLocation(glFill.pr, "p");
        gl.enableVertexAttribArray(pLoc);
        gl.vertexAttribPointer(pLoc, 2, gl.FLOAT, false, 0, 0);
        const segBuf = gl.createBuffer();
        gl.bindVertexArray(L.lineVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, segBuf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(seg), gl.STATIC_DRAW);
        const sLoc = gl.getAttribLocation(glLine.pr, "seg");
        gl.enableVertexAttribArray(sLoc);
        gl.vertexAttribPointer(sLoc, 4, gl.FLOAT, false, 0, 0);
        gl.vertexAttribDivisor(sLoc, 1);
        gl.bindBuffer(gl.ARRAY_BUFFER, glCorner);
        const cLoc = gl.getAttribLocation(glLine.pr, "corner");
        gl.enableVertexAttribArray(cLoc);
        gl.vertexAttribPointer(cLoc, 2, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
        L.bufs = [triBuf, segBuf];
        tri.length = 0;
        seg.length = 0;
        return L;
      },
    };
  }
  function glFree(L) {
    if (!L || !gl) return;
    gl.deleteVertexArray(L.fillVao);
    gl.deleteVertexArray(L.lineVao);
    L.bufs.forEach((b) => gl.deleteBuffer(b));
  }

  // 1:50m, right after the map is (re)built for a new size or map.
  function glBuildMd() {
    if (!gl) return;
    glFree(glMd);
    glFree(glHd);
    glMd = glHd = null;
    const b = glBuilder();
    const ctx = [];
    for (const sh of ctxShapes) {
      const g = sh.geom && b.add(sh.geom, sh.bb);
      if (g) ctx.push({ g, bb: sh.bb });
    }
    const its = [];
    for (const it of items.values()) {
      const g = it.hi && it.c.geometry && b.add(it.c.geometry, it.bb);
      if (g) its.push({ it, g });
    }
    glMd = { ...b.upload(), ctx, its };
    glBuildHd();
  }

  // 1:10m, a few shapes per idle slice so it never blocks the page.
  function glBuildHd() {
    if (!gl || !HD || !proj || !glMd) return;
    const gen = ++glBuildHd.gen;
    const b = glBuilder();
    const ctx = [],
      its = [];
    const todo = [];
    for (const i of HD.context) todo.push(() => {
      const geom = HD.geomOf([i]);
      const bbx = d3.geoPath(proj).bounds({ type: "Feature", geometry: geom });
      const bb = [bbx[0][0], bbx[0][1], bbx[1][0], bbx[1][1]];
      if (!isFinite(bb[0])) return;
      const g = b.add(geom, bb);
      if (g) ctx.push({ g, bb });
    });
    for (const it of items.values())
      if (it.hi && HD.countries[it.c.id])
        todo.push(() => {
          const g = b.add(HD.geomOf(HD.countries[it.c.id]), it.bb);
          if (g) its.push({ it, g });
        });
    const idle = window.requestIdleCallback || ((f) => setTimeout(() => f({ timeRemaining: () => 8 }), 16));
    const step = (dl) => {
      if (gen !== glBuildHd.gen || !gl) return; // the map was rebuilt
      while (todo.length && dl.timeRemaining() > 2) todo.shift()();
      if (todo.length) return idle(step);
      glHd = { ...b.upload(), ctx, its };
      request(true);
    };
    idle(step);
  }
  glBuildHd.gen = 0;

  // CSS colour -> [r, g, b, a] (0..1), cached.
  const rgbaCache = new Map();
  const parseCtx = document.createElement("canvas").getContext("2d");
  function rgba(css) {
    let v = rgbaCache.get(css);
    if (!v) {
      parseCtx.fillStyle = "#000";
      parseCtx.fillStyle = css;
      const s = parseCtx.fillStyle;
      if (s[0] === "#") v = [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16) / 255).concat(1);
      else {
        const m = s.match(/[\d.]+/g).map(Number);
        v = [m[0] / 255, m[1] / 255, m[2] / 255, m.length > 3 ? m[3] : 1];
      }
      rgbaCache.set(css, v);
    }
    return v;
  }
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, 1];

  function drawGL() {
    const k = transform.k;
    const L = k >= LO_K && glHd ? glHd : glMd;
    gl.viewport(0, 0, glCv.width, glCv.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    if (!L) return;
    const xf = [k, transform.x, transform.y];

    gl.useProgram(glFill.pr);
    gl.uniform3fv(glFill.xf, xf);
    gl.uniform2f(glFill.res, W, H);
    gl.bindVertexArray(L.fillVao);
    gl.enable(gl.STENCIL_TEST);
    gl.stencilMask(1);
    const fill = (g, col) => {
      gl.colorMask(false, false, false, false);
      gl.stencilFunc(gl.ALWAYS, 0, 1);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
      gl.drawArrays(gl.TRIANGLES, g.start, g.count);
      gl.colorMask(true, true, true, true);
      gl.stencilFunc(gl.EQUAL, 1, 1);
      gl.stencilOp(gl.ZERO, gl.ZERO, gl.ZERO);
      gl.uniform4fv(glFill.color, col);
      gl.drawArrays(gl.TRIANGLES, g.cover, 6);
    };
    const ctxCol = rgba(colors.ctx);
    for (const s of L.ctx) if (onScreen(s.bb, k, 2)) fill(s.g, ctxCol);
    const tints = hint("tints");
    const tintA = colors.dark ? 0.07 : 0.08;
    for (const { it, g } of L.its) {
      if (!onScreen(it.bb, k, 2)) continue;
      let col;
      if (it.shown) col = rgba(resultColor(it.shown));
      else {
        col = rgba(colors.shades[shadeOf.get(it.c.id)]);
        if (tints) col = mix(col, rgba(regionTint.get(it.c.subregion)), tintA);
      }
      fill(g, col);
    }
    gl.disable(gl.STENCIL_TEST);

    gl.useProgram(glLine.pr);
    gl.uniform3fv(glLine.xf, xf);
    gl.uniform2f(glLine.res, W, H);
    gl.uniform1f(glLine.hw, 0.55);
    gl.uniform4fv(glLine.color, rgba(colors.stroke));
    gl.bindVertexArray(L.lineVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, L.nSeg);
    gl.bindVertexArray(null);
  }

  // (2D canvas fallback) While the map moves under your fingers the base canvas isn't redrawn: its last picture is
  // moved with a CSS transform, which the GPU does almost for free. Returns false when too much
  // of the screen would be left uncovered, so a real redraw is needed.
  let drawnAt = d3.zoomIdentity;
  function slideBase() {
    const s = transform.k / drawnAt.k;
    const tx = transform.x - s * drawnAt.x,
      ty = transform.y - s * drawnAt.y;
    const ox = Math.max(0, Math.min(W, tx + s * W) - Math.max(0, tx)),
      oy = Math.max(0, Math.min(H, ty + s * H) - Math.max(0, ty));
    if ((ox * oy) / (W * H) < 0.7 || s > 4) return false;
    baseCv.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    return true;
  }

  function drawBase() {
    if (gl) drawGL();
    else drawBase2D();
  }
  function drawBase2D() {
    const k = transform.k;
    drawnAt = transform;
    baseCv.style.transform = "";
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.clearRect(0, 0, baseCv.width, baseCv.height);
    bctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * transform.x, dpr * transform.y);
    bctx.lineJoin = "round";
    bctx.lineWidth = 1.1 / k; // constant on-screen thickness
    bctx.strokeStyle = colors.stroke;
    const lo = k < LO_K;
    const hd = k >= HD_K && HD && !moving;
    const tints = hint("tints");
    for (const sh of hd ? hdContext() : ctxShapes) {
      if (!onScreen(sh.bb, k, 2)) continue;
      const p = hd ? sh.hd : lo ? sh.lo : sh.hi;
      bctx.fillStyle = colors.ctx;
      bctx.fill(p, "evenodd");
      bctx.stroke(p);
    }
    for (const it of items.values()) {
      if (!it.hi || !onScreen(it.bb, k, 2)) continue;
      const p = pathFor(it, k);
      bctx.fillStyle = it.shown ? resultColor(it.shown) : colors.shades[shadeOf.get(it.c.id)];
      bctx.fill(p, "evenodd");
      if (tints && !it.shown) {
        bctx.globalAlpha = colors.dark ? 0.07 : 0.08;
        bctx.fillStyle = regionTint.get(it.c.subregion);
        bctx.fill(p, "evenodd");
        bctx.globalAlpha = 1;
      }
      bctx.stroke(p);
    }
  }

  // Countries with no outline at all (Tuvalu) are always a dot; others only when dots are switched on.
  const isDot = (it, k) => it.dotCapable && (!it.hi || (hint("dots") && it.size * k < DOT_PX));

  function drawTop(now) {
    const k = transform.k;
    let anim = false;
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.clearRect(0, 0, topCv.width, topCv.height);

    // highlights drawn in map space
    tctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * transform.x, dpr * transform.y);
    if (hover && screen === "play" && hover.hi && !hover.shown) {
      tctx.fillStyle = colors.tint;
      tctx.fill(pathFor(hover, k), "evenodd");
    }
    // neighbour outline on the last guess
    if (hint("neighbours") && screen === "play" && game && !game.busy && game.tries > 1 && game.left === 1 && game.i < game.queue.length) {
      const t = items.get(targetId());
      tctx.lineWidth = 2 / k;
      tctx.lineJoin = "round";
      for (const nid of t.c.neighbors) {
        const n = items.get(nid);
        if (!n || !n.hi) continue;
        const p = pathFor(n, k);
        tctx.fillStyle = "rgb(255 94 58 / 16%)";
        tctx.fill(p, "evenodd");
        tctx.strokeStyle = colors.coral;
        tctx.stroke(p);
      }
    }
    for (const it of active) {
      if (it.pop) {
        const e = now - it.pop.t0;
        if (e > 380) it.pop = null;
        else if (it.hi) {
          anim = true;
          const sc = 1 + 0.16 * Math.sin((Math.PI * e) / 380);
          tctx.save();
          tctx.translate(it.ax, it.ay);
          tctx.scale(sc, sc);
          tctx.translate(-it.ax, -it.ay);
          tctx.shadowColor = "rgb(0 0 0 / 35%)";
          tctx.shadowBlur = 10;
          tctx.fillStyle = it.pop.color;
          tctx.fill(pathFor(it, k), "evenodd");
          tctx.restore();
        } else anim = true;
      }
      if (it.flash) {
        const a = 1 - (now - it.flash.t0) / it.flash.dur;
        if (a <= 0) it.flash = null;
        else {
          anim = true;
          if (it.hi) {
            tctx.globalAlpha = Math.min(1, a * 1.1);
            tctx.fillStyle = it.flash.color;
            tctx.fill(pathFor(it, k), "evenodd");
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
            tctx.fill(pathFor(it, k), "evenodd");
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
      let r = 3.4;
      if (it.pop) {
        const e = now - it.pop.t0;
        if (e < 380) {
          r *= 1 + 0.8 * Math.sin((Math.PI * e) / 380);
          col = it.pop.color;
        }
      }
      tctx.beginPath();
      tctx.arc(x, y, r, 0, 6.2832);
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
      if ((!it.labelOn && !tmp) || it.hidden) continue;
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
        if (now < p.t0) continue; // starts after the fly-in
        const ph = ((now - p.t0) % 900) / 900;
        tctx.globalAlpha = 1 - ph;
        tctx.beginPath();
        tctx.arc(it.ax * k + transform.x, it.ay * k + transform.y, 5 + ph * 34, 0, 6.2832);
        tctx.stroke();
      }
      tctx.globalAlpha = 1;
    }

    // direction arrow after a wrong guess
    if (game && game.arrow && hint("arrow") && screen === "play") {
      const A = game.arrow;
      const e = now - A.t0;
      if (e > 2700) game.arrow = null;
      else {
        anim = true;
        const f = items.get(A.from),
          t = items.get(A.to);
        tctx.globalAlpha = e < 2200 ? 1 : 1 - (e - 2200) / 500;
        drawArrow(f.ax * k + transform.x, f.ay * k + transform.y, t.ax * k + transform.x, t.ay * k + transform.y, A.km);
        tctx.globalAlpha = 1;
      }
    }

    // forget items whose effects ended
    for (const it of active) if (!it.flash && !it.pulse && !it.shake && !it.pop && !(it.tmp && it.tmp.until > now)) active.delete(it);
    return anim || active.size > 0;
  }

  const kmText = (km) => (km < 50 ? "next door" : Math.round(km / 10) * 10 + " km").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  function arrowHead(x, y, ux, uy, size) {
    tctx.beginPath();
    tctx.moveTo(x + ux * size, y + uy * size);
    tctx.lineTo(x - ux * size * 0.3 - uy * size * 0.8, y - uy * size * 0.3 + ux * size * 0.8);
    tctx.lineTo(x - ux * size * 0.3 + uy * size * 0.8, y - uy * size * 0.3 - ux * size * 0.8);
    tctx.closePath();
  }
  // Arrow from the country you clicked toward the answer, with the distance at its tip.
  // If the answer is off screen, a marker on the screen edge points to it as well.
  function drawArrow(fx, fy, tx, ty, km) {
    const dx = tx - fx,
      dy = ty - fy,
      d = Math.hypot(dx, dy) || 1;
    const ux = dx / d,
      uy = dy / d;
    const len = Math.max(26, Math.min(80, d - 18));
    const sx = fx + ux * 8,
      sy = fy + uy * 8,
      ex = sx + ux * len,
      ey = sy + uy * len;
    tctx.lineCap = "round";
    for (const [w, c] of [
      [7.5, "rgb(10 10 10 / 55%)"],
      [3.5, colors.coral],
    ]) {
      tctx.lineWidth = w;
      tctx.strokeStyle = c;
      tctx.beginPath();
      tctx.moveTo(sx, sy);
      tctx.lineTo(ex, ey);
      tctx.stroke();
      arrowHead(ex, ey, ux, uy, w > 4 ? 12 : 9.5);
      tctx.fillStyle = c;
      tctx.fill();
    }
    const label = kmText(km);
    tctx.font = "700 12px " + FONT;
    tctx.textAlign = "center";
    tctx.lineWidth = 3;
    tctx.strokeStyle = "rgb(10 10 10 / 75%)";
    const lx = ex + ux * 26,
      ly = ey + uy * 26 + 4;
    tctx.strokeText(label, lx, ly);
    tctx.fillStyle = "#fff";
    tctx.fillText(label, lx, ly);
    // edge marker when the answer is off screen
    const m = 26;
    if (tx < m || tx > W - m || ty < m || ty > H - m) {
      const cx = W / 2,
        cy = H / 2;
      const vx = tx - cx,
        vy = ty - cy;
      const s = Math.min(vx ? (vx > 0 ? W - m - cx : m - cx) / vx : Infinity, vy ? (vy > 0 ? H - m - cy : m - cy) / vy : Infinity);
      const px = cx + vx * s,
        py = cy + vy * s,
        vl = Math.hypot(vx, vy) || 1;
      arrowHead(px, py, vx / vl, vy / vl, 14);
      tctx.fillStyle = "rgb(10 10 10 / 55%)";
      tctx.fill();
      arrowHead(px, py, vx / vl, vy / vl, 11);
      tctx.fillStyle = colors.coral;
      tctx.fill();
    }
  }

  // Paint results (fill + labels) onto the map.
  function applyState() {
    const level = levelOf(settings.level);
    const reveal = screen === "end" || screen === "review";
    for (const it of poolItems) {
      const r = game && game.results.get(it.c.id);
      // a missed country that will be asked again stays blank until then
      const waiting = game && !reveal && game.pendingRetry.has(it.c.id);
      it.shown = r && !waiting && (level.fill || reveal) ? r : null;
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
      if (hitCtx.isPointInPath(pathFor(it, k), mx, my, "evenodd")) return it;
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
      if (it.size < nearSize && hitCtx.isPointInStroke(pathFor(it, k), mx, my)) {
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

  // ids: play just these countries (practice); otherwise the whole map
  function startGame(ids) {
    loadHd();
    const pool = ids || poolFor(settings.continents, settings.size).map((c) => c.id);
    if (!pool.length) return;
    const level = levelOf(settings.level);
    shownTarget = -1;
    globeView = null;
    game = {
      queue: shuffle(pool.slice()),
      total: pool.length,
      practice: !!ids,
      pendingRetry: new Set(), // missed, will be asked again
      retried: new Set(),
      streak: 0,
      bestStreak: 0,
      arrow: null,
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
    if (level.fill && game.results.has(it.c.id) && !game.pendingRetry.has(it.c.id)) {
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
    const id = it.c.id;
    const tries = game.tries - game.left + 1;
    const isRetry = game.pendingRetry.has(id);
    if (isRetry) game.pendingRetry.delete(id); // score keeps the first try
    else {
      game.results.set(id, { ok: true, tries });
      if (tries === 1) game.firstTry++;
    }
    game.streak++;
    game.bestStreak = Math.max(game.bestStreak, game.streak);
    game.arrow = null;
    const col = isRetry ? colors.t1 : resultColor({ ok: true, tries });
    const now = performance.now();
    if (!levelOf(settings.level).fill || isRetry) {
      // nothing fills in on Hard/Expert, so give a brief glow to confirm
      it.flash = { color: col, t0: now, dur: 700 };
      touch(it);
    }
    if (hint("pop")) {
      it.pop = { t0: now, color: col };
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
    if (game.left > 0) game.arrow = { from: it.c.id, to: targetId(), t0: now, km: distanceKm(it.c.id, targetId()) };
    if (game.left <= 0) miss(false);
    else {
      updateHud();
      request(false);
    }
  }

  function miss(skipped) {
    const it = items.get(targetId());
    const id = it.c.id;
    if (game.pendingRetry.has(id)) game.pendingRetry.delete(id);
    else game.results.set(id, { ok: false, skipped });
    game.busy = true;
    game.streak = 0;
    game.arrow = null;
    let requeue = null;
    if (hint("retry") && !game.retried.has(id)) {
      game.retried.add(id);
      requeue = id;
    }
    const now = performance.now();
    const back = hint("fly") ? flyTo(it) : null;
    const hold = back ? 2700 : 1800;
    const lead = back ? 650 : 0; // let the map arrive first
    it.pulse = { t0: now + lead, dur: hold - lead - 150 };
    it.tmp = { until: now + hold, kind: "reveal" };
    pings.push({ id, t0: now + lead });
    touch(it);
    applyState();
    updateHud();
    const g = game;
    if (back) setTimeout(() => game === g && flyBack(back), hold - 560);
    setTimeout(() => {
      if (game !== g) return; // left this round meanwhile
      game.busy = false;
      if (requeue) {
        // ask it again a few countries later
        game.queue.splice(Math.min(game.queue.length, game.i + 5), 0, requeue);
        game.pendingRetry.add(requeue);
        applyState();
      }
      next();
    }, hold);
  }

  // Zoom to a country for the reveal. Returns where to fly back to, or null if it's already in view.
  function flyTo(it) {
    if (isGlobe()) return globeFlyTo(it);
    const k0 = transform.k;
    const kMin = zoomBehavior.scaleExtent()[0];
    const k2 = Math.max(kMin, Math.min(5, (Math.min(W, H) * 0.3) / Math.max(it.size, 2))); // capped so you still see the surroundings
    const x = it.ax * k0 + transform.x,
      y = it.ay * k0 + transform.y;
    const inView = it.bb ? onScreen(it.bb, k0, -40) && it.bb[0] * k0 + transform.x > 40 && it.bb[2] * k0 + transform.x < W - 40 && it.bb[1] * k0 + transform.y > 40 && it.bb[3] * k0 + transform.y < H - 40 : x > 40 && x < W - 40 && y > 40 && y < H - 40;
    if (inView && k0 >= k2 * 0.6) return null;
    const back = transform;
    const t = d3.zoomIdentity.translate(W / 2 - it.ax * k2, H / 2 - it.ay * k2).scale(k2);
    d3.select(topCv).transition("fly").duration(650).call(zoomBehavior.transform, t);
    return back;
  }

  function next() {
    game.arrow = null;
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
    $("#st-streak-n").textContent = game.streak;
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
  let lastMissed = [];
  function readBest() {
    try {
      return JSON.parse(localStorage.getItem("worldz-best") || "{}") || {};
    } catch (e) {
      return {};
    }
  }
  function showEnd() {
    const total = game.total;
    const ok = [...game.results.values()].filter((r) => r.ok).length;
    const ids = [...new Set(game.queue)];
    lastMissed = ids.filter((id) => !game.results.get(id).ok);
    const missed = lastMissed.map((id) => items.get(id).c).sort((a, b) => a.name.localeCompare(b.name));
    const pct = Math.round((ok / total) * 100);
    const time = game.t1 - game.t0;
    // best score per map (found first, then time), kept in this browser
    let bestLine = "",
      newBest = false;
    if (!game.practice) {
      const key = `${selectionKey(settings.continents)}|${settings.size}|${settings.level}`;
      const all = readBest();
      const prev = all[key];
      newBest = !prev || ok > prev.found || (ok === prev.found && time < prev.time);
      if (newBest) {
        all[key] = { found: ok, total, time };
        try {
          localStorage.setItem("worldz-best", JSON.stringify(all));
        } catch (e) {}
      }
      bestLine = newBest ? (prev ? `<b>New best on this map.</b> Previous: ${prev.found} / ${prev.total} in ${fmt(prev.time)}.` : "<b>First score on this map.</b>") : `Best on this map: <b>${prev.found} / ${prev.total} in ${fmt(prev.time)}</b>.`;
    }
    if (hint("streak")) bestLine += ` Longest streak: <b>${game.bestStreak}</b>.`;
    $("#end-best").innerHTML = hint("streak") ? bestLine.trim() : "";
    $("#end-score").textContent = `${ok} / ${total}`;
    $("#end-hand").textContent = hint("streak") && newBest && ok > 0 ? "new best!" : pct === 100 ? "flawless!" : pct >= 80 ? "great run" : pct >= 50 ? "not bad at all" : "keep exploring";
    $("#end-sub").textContent = `${game.practice ? "Practice · " : ""}${selectionName(settings.continents)} · ${SIZES.find((s) => s.id === settings.size).name} countries · ${levelOf(settings.level).name}`;
    $("#end-stats").innerHTML = [
      [pct + "%", "found"],
      [Math.round((game.firstTry / total) * 100) + "%", "first try"],
      [fmt(time), "time"],
    ]
      .map(([b, s]) => `<div><b>${b}</b><span>${s}</span></div>`)
      .join("");
    $("#end-missed-wrap").hidden = !missed.length;
    const chips = $("#end-missed");
    chips.textContent = "";
    for (const c of missed) {
      const s = document.createElement("span");
      s.textContent = (hint("flags") && c.flag ? c.flag + " " : "") + c.name;
      chips.appendChild(s);
    }
    $("#e-practice").textContent = `Practice ${missed.length === 1 ? "this one" : "these " + missed.length}`;
    setScreen("end");
    applyState();
  }

  // ---------- menu ----------
  function renderMenu() {
    const mg = $("#mode-grid");
    mg.innerHTML = "";
    const sel = settings.continents;
    // "World" picks every continent; each continent toggles on its own (at least one stays on)
    const all = opt("World", `${poolFor(CONTINENTS, "all").length} countries · everything`, isWorld(sel), () => {
      settings.continents = [...CONTINENTS];
      if (!poolFor(settings.continents, settings.size).length) settings.size = "all";
      changed(true);
    });
    all.setAttribute("role", "button");
    mg.appendChild(all);
    for (const id of CONTINENTS) {
      const n = poolFor([id], "all").length;
      const on = sel.includes(id) && !isWorld(sel);
      const b = opt(modeOf(id).name, `${n} countries`, on, () => {
        let next;
        if (isWorld(sel)) next = [id]; // from World, tapping a continent picks just that one
        else if (sel.includes(id)) next = sel.filter((x) => x !== id);
        else next = [...sel, id];
        if (!next.length) return; // keep at least one
        settings.continents = CONTINENTS.filter((c) => next.includes(c));
        if (!poolFor(settings.continents, settings.size).length) settings.size = "all";
        changed(true);
      });
      b.setAttribute("role", "checkbox");
      mg.appendChild(b);
    }
    $("#mode-note").textContent = isWorld(sel) ? "" : sel.length > 1 ? `· ${selectionName(sel)}` : "· pick more to combine";
    const vs = $("#view-seg");
    vs.innerHTML = "";
    for (const [v, name, sub] of [
      ["flat", "Flat map", "pan and zoom"],
      ["globe", "Globe", "drag to spin"],
    ]) {
      const b = document.createElement("button");
      b.setAttribute("role", "radio");
      b.dataset.view = v;
      b.setAttribute("aria-checked", String(settings.view === v));
      b.innerHTML = `${name}<small>${sub}</small>`;
      b.onclick = () => {
        setView(v);
        renderMenu();
      };
      vs.appendChild(b);
    }
    const sg = $("#size-seg");
    sg.innerHTML = "";
    for (const s of SIZES) {
      const n = poolFor(settings.continents, s.id).length;
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
    const n = poolFor(settings.continents, settings.size).length;
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
    if (rebuild) globeView = null;
    renderMenu();
    if (rebuild && screen === "menu") buildMap();
  }

  // ---------- input ----------
  let swallowClick = false,
    dragEndedAt = -1e9;
  topCv.addEventListener("click", (ev) => {
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    if (performance.now() - dragEndedAt < 120) return;
    if (screen !== "play") return;
    const r = topCv.getBoundingClientRect();
    pick(hit(ev.clientX - r.left, ev.clientY - r.top));
  });

  function moveCursor() {
    if (!ptr) return;
    if (screen === "play" && ptr.type !== "touch") {
      cursorEl.hidden = !hint("label");
      // keep the label on screen near the edges
      const half = pillW / 2 + 8;
      const lx = Math.max(half, Math.min(stageRect.width - half, ptr.x)) - ptr.x;
      pillEl.style.transform = `translateX(calc(-50% + ${lx}px))`;
      cursorEl.style.transform = `translate3d(${ptr.x}px,${ptr.y}px,0)`;
      if (globeMoving) return;
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
    // only over the map itself, not over the buttons or the Hints panel
    if (ev.target !== topCv) {
      cursorEl.hidden = true;
      ptr = null;
      return;
    }
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

  function flyBack(back) {
    if (isGlobe()) animateGlobe(back, 550);
    else d3.select(topCv).transition("fly").duration(550).call(zoomBehavior.transform, back);
  }
  const zoomBy = (f) => (isGlobe() ? animateGlobe({ rot: globeView.rot.slice(), zoom: clampN(globeView.zoom * f, 0.8, 40) }, 220) : d3.select(topCv).transition().duration(220).call(zoomBehavior.scaleBy, f));
  $("#z-in").onclick = () => zoomBy(1.7);
  $("#z-out").onclick = () => zoomBy(1 / 1.7);
  $("#z-reset").onclick = () => (isGlobe() ? animateGlobe(globeSpawn, 400) : d3.select(topCv).transition().duration(300).call(zoomBehavior.transform, d3.zoomIdentity));

  // ---------- globe: drag to spin, scroll to zoom ----------
  // While it moves, a quick picture is drawn from lighter outlines; when it stops, the full map
  // (detailed outlines, labels, dots, clicks) is rebuilt for the new angle.
  let quickGeo = null;
  function simplifyGeo(g, tol) {
    const polys = (g.type === "Polygon" ? [g.coordinates] : g.coordinates)
      .map((poly) =>
        poly
          .map((ring) => {
            const out = [ring[0]];
            for (let i = 1; i < ring.length - 1; i++) {
              const a = out[out.length - 1],
                b = ring[i];
              if (Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]) >= tol) out.push(b);
            }
            out.push(ring[ring.length - 1]);
            return out;
          })
          .filter((r) => r.length >= 4),
      )
      .filter((p) => p.length);
    return polys.length ? fixWinding({ type: "MultiPolygon", coordinates: polys }) : null;
  }
  function quickShapes() {
    if (!quickGeo) {
      quickGeo = [];
      for (const x of D.context) {
        const g = simplifyGeo(x.geometry, 0.3);
        if (g) quickGeo.push({ id: null, f: { type: "Feature", geometry: g } });
      }
      for (const c of D.countries)
        if (c.geometry) {
          const g = simplifyGeo(c.geometry, 0.3);
          if (g) quickGeo.push({ id: c.id, f: { type: "Feature", geometry: g } });
        }
    }
    return quickGeo;
  }
  function globeQuick() {
    globeMoving = true;
    proj.rotate(globeView.rot).scale(globeR * globeView.zoom);
    placeSea();
    if (glCv) glCv.style.visibility = "hidden";
    baseCv.style.display = "";
    baseCv.style.transform = "";
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.clearRect(0, 0, baseCv.width, baseCv.height);
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.clearRect(0, 0, topCv.width, topCv.height);
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx.lineWidth = 0.8;
    bctx.lineJoin = "round";
    bctx.strokeStyle = colors.stroke;
    const path = d3.geoPath(proj, bctx);
    for (const q of quickShapes()) {
      const it = q.id && items.get(q.id);
      bctx.beginPath();
      path(q.f);
      bctx.fillStyle = !q.id ? colors.ctx : it && it.shown ? resultColor(it.shown) : colors.shades[shadeOf.get(q.id)];
      bctx.fill("evenodd");
      bctx.stroke();
    }
  }
  let settleTimerG = 0;
  function globeSettleSoon() {
    clearTimeout(settleTimerG);
    settleTimerG = setTimeout(globeSettle, 160);
  }
  // Rebuild the full map for the new angle, keeping any flashes / labels that are still running.
  function globeSettle() {
    clearTimeout(settleTimerG);
    if (!isGlobe()) return;
    const old = items,
      keepPings = pings;
    globeMoving = false;
    buildMap();
    for (const [id, it] of old) {
      const nu = items.get(id);
      if (!nu) continue;
      let any = false;
      for (const f of ["flash", "pulse", "tmp", "shake", "pop"])
        if (it[f]) {
          nu[f] = it[f];
          any = true;
        }
      if (any) active.add(nu);
    }
    pings = keepPings;
    if (glCv) glCv.style.visibility = "";
    if (gl) baseCv.style.display = "none";
    request(true);
  }
  let globeAnim = 0;
  function animateGlobe(to, dur) {
    if (!to) return;
    cancelAnimationFrame(globeAnim);
    const from = { rot: globeView.rot.slice(), zoom: globeView.zoom };
    const dl = ((((to.rot[0] - from.rot[0] + 540) % 360) + 360) % 360) - 180; // the short way round
    const t0 = performance.now();
    const step = (now) => {
      const e = Math.min(1, (now - t0) / dur),
        q = d3.easeCubicInOut(e);
      globeView = { rot: [from.rot[0] + dl * q, from.rot[1] + (to.rot[1] - from.rot[1]) * q], zoom: from.zoom * Math.pow(to.zoom / from.zoom, q) };
      globeQuick();
      if (e < 1) globeAnim = requestAnimationFrame(step);
      else globeSettle();
    };
    globeAnim = requestAnimationFrame(step);
  }
  function globeFlyTo(it) {
    const g = geoAnchor.get(it.c.id);
    const centre = [-globeView.rot[0], -globeView.rot[1]];
    if (!it.hidden && d3.geoDistance(g, centre) < 0.5 && it.size > 24) return null; // already in front of you
    const back = { rot: globeView.rot.slice(), zoom: globeView.zoom };
    const zoom = clampN(Math.max(globeView.zoom, it.c.area < 200000 ? 2.4 : 1.4), 1, 5);
    animateGlobe({ rot: [-g[0], -clampN(g[1], -75, 75)], zoom }, 650);
    return back;
  }
  let gDrag = null;
  topCv.addEventListener("pointerdown", (ev) => {
    if (!isGlobe() || ev.button) return;
    cancelAnimationFrame(globeAnim);
    gDrag = { x: ev.clientX, y: ev.clientY, rot: globeView.rot.slice(), moved: false, id: ev.pointerId };
  });
  topCv.addEventListener("pointermove", (ev) => {
    if (!gDrag || ev.pointerId !== gDrag.id) return;
    const dx = ev.clientX - gDrag.x,
      dy = ev.clientY - gDrag.y;
    if (!gDrag.moved && dx * dx + dy * dy < 16) return;
    if (!gDrag.moved) {
      gDrag.moved = true;
      try {
        topCv.setPointerCapture(ev.pointerId);
      } catch (e) {}
    }
    const f = 180 / Math.PI / (globeR * globeView.zoom); // degrees per pixel at the globe's surface
    globeView = { rot: [gDrag.rot[0] + dx * f, clampN(gDrag.rot[1] - dy * f, -80, 80)], zoom: globeView.zoom };
    globeQuick();
  });
  const endDrag = () => {
    if (!gDrag) return;
    if (gDrag.moved) {
      dragEndedAt = performance.now(); // a drag isn't a guess (the click it may produce is ignored)
      globeSettleSoon();
    }
    gDrag = null;
  };
  topCv.addEventListener("pointerup", endDrag);
  topCv.addEventListener("pointercancel", endDrag);
  topCv.addEventListener(
    "wheel",
    (ev) => {
      if (!isGlobe()) return;
      ev.preventDefault();
      cancelAnimationFrame(globeAnim);
      globeView = { rot: globeView.rot.slice(), zoom: clampN(globeView.zoom * Math.exp(-ev.deltaY * 0.0015), 0.8, 40) };
      globeQuick();
      globeSettleSoon();
    },
    { passive: false },
  );

  // flat map or globe
  function setView(v) {
    if (settings.view === v) return;
    settings.view = v;
    saveSettings();
    globeView = null;
    cancelAnimationFrame(globeAnim);
    globeMoving = false;
    buildMap();
    if (glCv) glCv.style.visibility = "";
    if (gl) baseCv.style.display = "none";
    renderView();
  }
  function renderView() {
    const g = isGlobe();
    $("#btn-view").setAttribute("aria-pressed", String(g));
    $("#btn-view").title = g ? "Switch to the flat map (G)" : "Switch to the globe (G)";
    document.querySelectorAll("#view-seg button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.view === settings.view)));
  }
  $("#btn-view").onclick = () => setView(isGlobe() ? "flat" : "globe");

  function toMenu() {
    clearInterval(timer);
    game = null;
    shownTarget = -1;
    globeView = null;
    setScreen("menu");
    buildMap();
    renderMenu();
  }
  $("#btn-menu").onclick = toMenu;
  $("#e-menu").onclick = toMenu;
  $("#btn-start").onclick = () => startGame();
  $("#e-again").onclick = () => startGame();
  $("#e-practice").onclick = () => startGame(lastMissed.slice());
  $("#e-map").onclick = () => {
    setScreen("review");
    applyState();
  };
  $("#btn-results").onclick = () => setScreen("end");
  $("#btn-skip").onclick = () => {
    if (screen === "play" && !game.busy) miss(true);
  };

  // ---------- Hints dropdown (same switches in the menu and in the game) ----------
  const hintPanels = [$("#m-hints"), $("#g-hints")];
  function buildHintPanels() {
    for (const dd of hintPanels) {
      const panel = dd.querySelector(".hints-panel");
      panel.textContent = "";
      for (const h of HINTS) {
        if (h.group) {
          const g = document.createElement("h3");
          g.textContent = h.group;
          panel.appendChild(g);
          continue;
        }
        const b = document.createElement("button");
        b.className = "switch-row";
        b.setAttribute("role", "switch");
        b.dataset.hint = h.id;
        b.innerHTML = `<span><b></b><small></small></span><i class="switch" aria-hidden="true"></i>`;
        b.querySelector("b").textContent = h.t;
        b.querySelector("small").textContent = h.s;
        b.onclick = () => setHint(h.id, !hint(h.id));
        panel.appendChild(b);
      }
    }
    renderHints();
  }
  function renderHints() {
    const on = HINTS.filter((h) => h.id && hint(h.id)).length;
    const total = HINTS.filter((h) => h.id).length;
    for (const dd of hintPanels) {
      dd.querySelector(".hd-n").textContent = `${on} of ${total} on`;
      dd.querySelectorAll("[data-hint]").forEach((b) => b.setAttribute("aria-checked", String(hint(b.dataset.hint))));
    }
    stage.classList.toggle("grain", hint("grain"));
    if (!hint("label")) cursorEl.hidden = true;
    $("#st-streak").hidden = !hint("streak");
  }
  function setHint(id, on) {
    settings.hints[id] = on;
    saveSettings();
    renderHints();
    hover = null;
    request(true);
  }
  const toggleDots = () => setHint("dots", !hint("dots"));
  buildHintPanels();
  // Close the in-game dropdown when you click elsewhere (and don't count that click as a guess).
  document.addEventListener(
    "pointerdown",
    (ev) => {
      const dd = $("#g-hints");
      if (dd.open && !dd.contains(ev.target)) {
        dd.open = false;
        if (ev.target === topCv) swallowClick = true;
      }
    },
    true,
  );

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
    else if (ev.key === "g" || ev.key === "G") setView(isGlobe() ? "flat" : "globe");
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
        const tryPt = (x, y) => (x > 2 && y > 2 && x < W - 2 && y < H - 2 && hit(x, y) === it && document.elementFromPoint(x + stageRect.left, y + stageRect.top) === topCv ? [x + stageRect.left, y + stageRect.top] : null);
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

  renderView();
  // ---------- go ----------
  initGL();
  readColors();
  renderMenu();
  buildMap();
})();
