/* worldz: click the country you're asked for. */
(() => {
  "use strict";

  const D = window.WORLDZ_DATA; // real Natural Earth outlines + country list (see scripts/build-data.mjs)
  const R = 6371.0088; // km
  const SMALL_KM2 = 100000; // "small" = under 100,000 km²
  const DOT_PX = 7; // countries drawn smaller than this on screen become clickable dots

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
  const svg = d3.select("#map");
  const cursorEl = $("#cursor");
  const pillEl = $("#pill");

  // ---------- settings (remembered, but the app works without storage) ----------
  const DEFAULTS = { mode: "world", size: "all", level: "easy" };
  let settings = { ...DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem("worldz-settings") || "null");
    if (saved && MODES.some((m) => m.id === saved.mode) && SIZES.some((s) => s.id === saved.size) && LEVELS.some((l) => l.id === saved.level)) settings = saved;
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

  // ---------- map ----------
  let W = 0,
    H = 0,
    proj = null,
    transform = d3.zoomIdentity,
    zoomBehavior = null;
  let items = new Map(); // country id -> { c, shape, dot, label, ax, ay, size, lw, pool }
  let poolIds = new Set();
  let zoomG, dotsG, labelsG;

  function buildMap() {
    const rect = stage.getBoundingClientRect();
    W = Math.max(280, rect.width);
    H = Math.max(280, rect.height);
    svg.attr("viewBox", `0 0 ${W} ${H}`);
    svg.selectAll("*").remove();
    items = new Map();

    const mode = modeOf(settings.mode);
    const [w, s, e, n] = mode.box;
    const pts = [];
    for (let x = w; x <= e; x += (e - w) / 24) for (const y of [s, n]) pts.push([x, y]);
    for (let y = s; y <= n; y += (n - s) / 12) for (const x of [w, e]) pts.push([x, y]);
    const top = screen === "menu" ? 20 : 76;
    const bottom = screen === "menu" ? 20 : 54;
    proj = d3.geoNaturalEarth1().rotate([-(w + e) / 2, 0]);
    proj.fitExtent(
      [
        [16, top],
        [W - 16, H - bottom],
      ],
      { type: "MultiPoint", coordinates: pts },
    );
    const path = d3.geoPath(proj);

    zoomG = svg.append("g");
    const ctxG = zoomG.append("g");
    const poolG = zoomG.append("g");
    dotsG = svg.append("g");
    labelsG = svg.append("g");

    const pool = new Set(poolFor(settings.mode, settings.size).map((c) => c.id));
    poolIds = pool;

    // Territories and non-country shapes: context only.
    for (const x of D.context) {
      const g = crop(x.geometry, mode);
      const d = g && path({ type: "Feature", geometry: g });
      if (d) ctxG.append("path").attr("class", "shape ctx").attr("d", d);
    }

    for (const c of D.countries) {
      const g = c.geometry ? crop(c.geometry, mode) : null;
      const it = { c, shape: null, dot: null, label: null, ax: 0, ay: 0, size: 0, lw: 0, pool: pool.has(c.id) };
      let d = null;
      if (g) {
        const feat = { type: "Feature", geometry: g };
        d = path(feat);
        if (d) {
          const b = path.bounds(feat);
          it.size = Math.max(b[1][0] - b[0][0], b[1][1] - b[0][1]);
          const big = polysOf(g).reduce((a, p) => (polyInfo(p).area > polyInfo(a).area ? p : a));
          const bigFeat = { type: "Feature", geometry: { type: "Polygon", coordinates: big } };
          const bb = path.bounds(bigFeat);
          it.lw = bb[1][0] - bb[0][0];
          const cen = path.centroid(bigFeat);
          it.ax = cen[0];
          it.ay = cen[1];
        }
      }
      if (!d) {
        // No outline (e.g. Tuvalu): place it from its listed coordinates.
        const p = proj([c.latlng[1], c.latlng[0]]);
        if (!p) continue;
        it.ax = p[0];
        it.ay = p[1];
      }
      if (d) {
        it.shape = (it.pool ? poolG : ctxG)
          .append("path")
          .attr("class", it.pool ? "shape pool" : "shape ctx")
          .attr("d", d);
        if (it.pool) it.shape.attr("data-id", c.id);
      }
      if (it.pool && (!d || it.size < DOT_PX * 6)) {
        it.dot = dotsG.append("g").attr("class", "dot-g").attr("data-id", c.id).style("display", "none");
        it.dot.append("circle").attr("class", "hit").attr("r", 10);
        it.dot.append("circle").attr("class", "vis").attr("r", 3.4);
      }
      if (it.pool) {
        it.label = labelsG.append("text").attr("class", "label").style("display", "none").text(c.name);
      }
      items.set(c.id, it);
    }

    zoomBehavior = d3
      .zoom()
      .scaleExtent([1, 80])
      .extent([
        [0, 0],
        [W, H],
      ])
      .translateExtent([
        [-W * 0.1, -H * 0.1],
        [W * 1.1, H * 1.1],
      ])
      .clickDistance(4)
      .filter((ev) => !ev.button && ev.type !== "dblclick")
      .on("zoom", (ev) => {
        transform = ev.transform;
        zoomG.attr("transform", transform);
        scheduleLayout();
      });
    svg.on(".zoom", null);
    svg.call(zoomBehavior).on("dblclick.zoom", null);
    transform = d3.zoomIdentity;
    applyState();
    layoutOverlay();
  }

  // Positions dots and labels in screen space (so they stay a constant size while zooming).
  let layoutQueued = false;
  function scheduleLayout() {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(() => {
      layoutQueued = false;
      layoutOverlay();
    });
  }
  function layoutOverlay() {
    const k = transform.k;
    for (const it of items.values()) {
      if (!it.pool) continue;
      const [x, y] = transform.apply([it.ax, it.ay]);
      const asDot = it.size * k < DOT_PX; // too small to click as a shape
      if (it.dot) {
        it.dot.style("display", asDot ? null : "none");
        if (asDot) it.dot.attr("transform", `translate(${x},${y})`);
      }
      if (it.labelOn) {
        const len = it.c.name.length;
        if (asDot) {
          it.label.classed("side", true).attr("transform", `translate(${x + 7},${y + 3})`).style("font-size", "8.5px");
        } else {
          const fs = Math.max(8.5, Math.min(14, (it.lw * k) / (len * 0.56)));
          it.label
            .classed("side", false)
            .attr("transform", `translate(${x},${y + fs * 0.35})`)
            .style("font-size", fs + "px");
        }
      }
    }
  }

  // Paint results (fill + labels) onto the map.
  function applyState() {
    const level = levelOf(settings.level);
    const reveal = screen === "end" || screen === "review";
    for (const it of items.values()) {
      if (!it.pool) continue;
      const r = game && game.results.get(it.c.id);
      const show = r && (level.fill || reveal);
      for (const el of [it.shape, it.dot]) {
        if (!el) continue;
        el.classed("correct", !!(show && r.ok)).classed("missed", !!(show && !r.ok));
      }
      it.labelOn = !!show;
      it.label.style("display", show ? null : "none");
    }
    layoutOverlay();
  }

  function flash(id, cls, ms) {
    const it = items.get(id);
    if (!it) return;
    for (const el of [it.shape, it.dot]) el && el.classed(cls, true);
    setTimeout(() => {
      for (const el of [it.shape, it.dot]) el && el.classed(cls, false);
    }, ms);
  }
  function ping(id) {
    const it = items.get(id);
    if (!it) return;
    const [x, y] = transform.apply([it.ax, it.ay]);
    const p = document.createElement("div");
    p.className = "ping";
    p.style.left = x + "px";
    p.style.top = y + "px";
    stage.appendChild(p);
    setTimeout(() => p.remove(), 1900);
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
    say(null);
    updateHud();
  }

  function pick(id) {
    if (screen !== "play" || game.busy) return;
    const it = items.get(id);
    if (!it || !it.pool) return;
    const level = levelOf(settings.level);
    if (level.fill && game.results.has(id)) {
      say("Already filled in", "bad", 800);
      return;
    }
    if (id === targetId()) onCorrect(id);
    else onWrong(id);
  }

  function onCorrect(id) {
    game.results.set(id, { ok: true, tries: game.tries - game.left + 1 });
    if (game.left === game.tries) game.firstTry++;
    applyState();
    say("✓ " + items.get(id).c.name, "good", 600);
    next();
  }

  function onWrong(id) {
    game.wrong++;
    game.left--;
    flash(id, "wrong", 650);
    if (game.left <= 0) {
      miss(false);
    } else {
      say(`Not ${items.get(id).c.name} · ${game.left} ${game.left === 1 ? "guess" : "guesses"} left`, "bad", 1300);
      updateHud();
    }
  }

  function miss(skipped) {
    const id = targetId();
    game.results.set(id, { ok: false, skipped });
    game.busy = true;
    applyState();
    flash(id, "reveal", 1700);
    ping(id);
    say(`It's ${items.get(id).c.name}, right here`, "bad", 1800);
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
    setTimeout(() => {
      if (screen !== "play") return;
      showEnd();
    }, 700);
    game.busy = true;
  }

  // ---------- pill under the cursor + HUD ----------
  let pillTimer = null;
  let pillBusy = false; // a temporary message is showing
  function say(text, kind, ms) {
    clearTimeout(pillTimer);
    pillBusy = !!(text && ms);
    pillEl.className = kind || "";
    if (text) {
      pillEl.innerHTML = `<b></b>`;
      pillEl.firstChild.textContent = text;
      if (ms) pillTimer = setTimeout(() => say(null), ms);
    } else if (game && game.i < game.queue.length) {
      pillEl.innerHTML = `<span class="k">Find</span><b></b>`;
      pillEl.querySelector("b").textContent = targetName();
    } else {
      pillEl.innerHTML = "";
    }
  }
  const fmt = (ms) => {
    const t = Math.floor(ms / 1000);
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
  };
  let timer = null;
  function updateHud() {
    if (!game) return;
    const total = game.queue.length;
    const ok = [...game.results.values()].filter((r) => r.ok).length;
    const miss = game.results.size - ok;
    $("#st-ok").textContent = ok;
    $("#st-miss").textContent = miss;
    $("#st-prog").textContent = `${Math.min(game.i + 1, total)} / ${total}`;
    if (game.i < total) {
      $("#target-name").textContent = targetName();
      $("#pips").innerHTML = Array.from({ length: game.tries }, (_, i) => `<i class="${i < game.left ? "" : "off"}"></i>`).join("");
      if (!pillBusy) say(null);
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
      mg.appendChild(opt(m.name, `${n} countries`, settings.mode === m.id, () => {
        settings.mode = m.id;
        if (!poolFor(settings.mode, settings.size).length) settings.size = "all";
        changed(true);
      }));
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
      lg.appendChild(opt(l.name, l.desc, settings.level === l.id, () => {
        settings.level = l.id;
        changed(false);
      }));
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
  svg.on("click", (ev) => {
    const el = ev.target.closest && ev.target.closest("[data-id]");
    if (el) pick(el.getAttribute("data-id"));
  });

  stage.addEventListener("pointermove", (ev) => {
    if (screen !== "play" || ev.pointerType === "touch") return;
    const r = stage.getBoundingClientRect();
    const x = ev.clientX - r.left,
      y = ev.clientY - r.top;
    cursorEl.hidden = false;
    // keep the label on screen near the edges
    const half = pillEl.offsetWidth / 2 + 8;
    const lx = Math.max(half, Math.min(r.width - half, x)) - x;
    pillEl.style.left = lx + "px";
    cursorEl.style.transform = `translate(${x}px,${y}px)`;
  });
  stage.addEventListener("pointerleave", () => (cursorEl.hidden = true));
  // Hide the crosshair over the HUD buttons, where a normal pointer is needed.
  for (const sel of ["#hud > *", "#hud-bottom > *"]) {
    document.querySelectorAll(sel).forEach((el) => {
      el.addEventListener("pointerenter", () => (cursorEl.hidden = true));
    });
  }

  const zoomBy = (f) => svg.transition().duration(220).call(zoomBehavior.scaleBy, f);
  $("#z-in").onclick = () => zoomBy(1.7);
  $("#z-out").onclick = () => zoomBy(1 / 1.7);
  $("#z-reset").onclick = () => svg.transition().duration(300).call(zoomBehavior.transform, d3.zoomIdentity);

  function toMenu() {
    clearInterval(timer);
    game = null;
    setScreen("menu");
    say(null);
    buildMap();
    renderMenu();
  }
  $("#btn-menu").onclick = toMenu;
  $("#e-menu").onclick = toMenu;
  $("#btn-start").onclick = startGame;
  $("#e-again").onclick = startGame;
  $("#e-map").onclick = () => {
    setScreen("review");
    applyState();
  };
  $("#btn-results").onclick = () => setScreen("end");
  $("#btn-skip").onclick = () => {
    if (screen === "play" && !game.busy) miss(true);
  };

  // theme
  function toggleTheme() {
    const dark = document.documentElement.classList.toggle("dark");
    try {
      localStorage.setItem("worldz-theme", dark ? "dark" : "light");
    } catch (e) {}
  }
  $("#btn-theme").onclick = toggleTheme;
  $("#m-theme").onclick = toggleTheme;

  // full screen
  const root = document.documentElement;
  const reqFs = root.requestFullscreen || root.webkitRequestFullscreen;
  function toggleFs() {
    if (!reqFs) return;
    if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else reqFs.call(root);
  }
  if (!reqFs) for (const b of ["#btn-fs", "#m-fs"]) $(b).hidden = true;
  $("#btn-fs").onclick = toggleFs;
  $("#m-fs").onclick = toggleFs;

  window.addEventListener("keydown", (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.key === "f" || ev.key === "F") toggleFs();
    else if ((ev.key === "s" || ev.key === "S") && screen === "play" && !game.busy) miss(true);
  });

  // re-fit the map when the window (or full screen) changes size
  let rt = null;
  new ResizeObserver(() => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      const r = stage.getBoundingClientRect();
      if (Math.abs(r.width - W) > 1 || Math.abs(r.height - H) > 1) buildMap();
    }, 120);
  }).observe(stage);

  // ---------- go ----------
  renderMenu();
  buildMap();
})();
