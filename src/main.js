/*
 * Conatus — main.js
 * Copyright (C) 2026 Alfie Maskell. Licensed under the GNU AGPL v3 (see LICENSE).
 *
 * Wiring only: build a world, seed it with soft-body blobs, run a fixed-timestep
 * loop, draw, and update the HUD. The interesting code lives in sim.js; this
 * file just turns it into something you can watch and prod.
 */

(function () {
  "use strict";

  const { Sim, Particle, Renderer } = window.Conatus;

  const canvas = document.getElementById("tank");
  const hudEl = document.getElementById("hud");
  const hudOpenBtn = document.getElementById("hud-open");
  const hud = {
    mass: document.getElementById("hud-mass"),
    count: document.getElementById("hud-count"),
    ke: document.getElementById("hud-ke"),
    diss: document.getElementById("hud-diss"),
    flow: document.getElementById("hud-flow"),
    nut: document.getElementById("hud-nut"),
    fps: document.getElementById("hud-fps"),
    state: document.getElementById("hud-state"),
  };

  function setHud(visible) {
    hudEl.classList.toggle("hidden", !visible);
    hudOpenBtn.classList.toggle("show", !visible);
  }
  document.getElementById("hud-close").addEventListener("click", () => setHud(false));
  hudOpenBtn.addEventListener("click", () => setHud(true));

  let sim, renderer;
  let paused = false;

  function fitCanvas() {
    // size the drawing buffer to the element's CSS size for crisp pixels
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.floor(rect.width);
    canvas.height = Math.floor(rect.height);
  }

  // Build a small soft body: a ring of particles around a centre, all bonded
  // to their neighbours and to the centre, so it holds a shape but jiggles.
  function spawnBlob(sim, cx, cy, n, ringRadius, density) {
    const centreMass = density * Math.PI * 6 * 6;
    const centreIdx = sim.addParticle(new Particle(cx, cy, centreMass, 6, density));
    const ringIdx = [];
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2;
      const px = cx + Math.cos(ang) * ringRadius;
      const py = cy + Math.sin(ang) * ringRadius;
      const r = 5;
      const mass = density * Math.PI * r * r;
      ringIdx.push(sim.addParticle(new Particle(px, py, mass, r, density)));
    }
    // breakStrain 1.5 => a bond only snaps when stretched past 2.5x its rest
    // length, so gentle settling and squashing never tear a body, but a hard
    // stir (click) still can. (Compression can't break a bond — min strain is
    // -1 at zero length — so pancaking on the floor is now safe.)
    const k = 600, damp = 8, breakStrain = 1.5;
    // spokes to centre
    for (let i = 0; i < n; i++) sim.addBond(centreIdx, ringIdx[i], k, damp, breakStrain);
    // ring neighbours
    for (let i = 0; i < n; i++) sim.addBond(ringIdx[i], ringIdx[(i + 1) % n], k, damp, breakStrain);
    // cross-bracing (skip-one) so the body resists shearing flat
    for (let i = 0; i < n; i++) sim.addBond(ringIdx[i], ringIdx[(i + 2) % n], k * 0.5, damp, breakStrain);
  }

  function seed() {
    sim = new Sim(canvas.width, canvas.height);
    renderer = new Renderer(canvas, sim);

    const W = canvas.width, H = canvas.height;

    // A few soft bodies of varying density. < waterDensity (1.0) => floats up,
    // > 1.0 => sinks. Watch them sort themselves vertically by density.
    spawnBlob(sim, W * 0.25, H * 0.35, 9, 22, 0.55);  // very buoyant
    spawnBlob(sim, W * 0.50, H * 0.30, 11, 26, 0.85); // slightly buoyant
    spawnBlob(sim, W * 0.72, H * 0.40, 8, 20, 1.25);  // sinks
    spawnBlob(sim, W * 0.40, H * 0.55, 10, 24, 1.6);  // sinks fast

    // A scatter of loose grains (unbonded matter) to drift and settle.
    // Rejection-sample positions so nothing spawns overlapping — a clean start
    // avoids a violent frame-one separation impulse (which would tear bonds).
    let placed = 0, attempts = 0;
    while (placed < 60 && attempts < 4000) {
      attempts++;
      const r = 3 + Math.random() * 2;
      const x = 20 + Math.random() * (W - 40);
      const y = 20 + Math.random() * (H - 40);
      if (!fits(sim, x, y, r)) continue;
      const density = 0.5 + Math.random() * 1.4;
      sim.addParticle(new Particle(x, y, density * Math.PI * r * r, r, density));
      placed++;
    }
  }

  // True if a circle at (x,y,r) does not overlap any existing particle.
  function fits(sim, x, y, r) {
    const parts = sim.particles;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const minD = p.radius + r + 1;
      const dx = p.x - x, dy = p.y - y;
      if (dx * dx + dy * dy < minD * minD) return false;
    }
    return true;
  }

  // ---- fixed-timestep loop with accumulator ----
  const DT = 1 / 120;          // physics step
  const MAX_STEPS = 8;         // avoid spiral-of-death after a tab stall
  let last = performance.now();
  let acc = 0;
  let fpsEMA = 60;

  function frame(now) {
    const elapsed = Math.min(0.25, (now - last) / 1000);
    last = now;
    fpsEMA = fpsEMA * 0.9 + (1 / Math.max(1e-6, elapsed)) * 0.1;

    if (!paused) {
      acc += elapsed;
      let steps = 0;
      while (acc >= DT && steps < MAX_STEPS) {
        sim.step(DT);
        acc -= DT;
        steps++;
      }
    }

    renderer.draw();
    updateHud();
    requestAnimationFrame(frame);
  }

  function updateHud() {
    const t = sim.totals();
    hud.mass.textContent = t.mass.toFixed(2);
    hud.count.textContent = t.count;
    hud.ke.textContent = t.kineticEnergy.toFixed(0);
    hud.diss.textContent = t.energyDissipated.toFixed(0);
    hud.fps.textContent = fpsEMA.toFixed(0);
    hud.state.textContent = paused ? "paused" : "running";
    if (sim.fluid) {
      const ft = sim.fluid.totals();
      hud.flow.textContent = ft.maxSpeed.toFixed(0) + " px/s";
      hud.nut.textContent = ft.nutrient.toFixed(1);
    }
  }

  // ---- input ----
  window.addEventListener("resize", () => { fitCanvas(); seed(); });

  document.addEventListener("keydown", (e) => {
    if (e.code === "Space") { paused = !paused; e.preventDefault(); }
    if (e.key === "r" || e.key === "R") { seed(); }
    if (e.key === "b" || e.key === "B") { renderer.showBonds = !renderer.showBonds; }
    if (e.key === "n" || e.key === "N") { renderer.showNutrient = !renderer.showNutrient; }
    if (e.key === "f" || e.key === "F") { renderer.showFlow = !renderer.showFlow; }
    if (e.key === "h" || e.key === "H") { setHud(hudEl.classList.contains("hidden")); }
  });

  canvas.addEventListener("pointerdown", (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    sim.poke(x, y, 600, 90); // stir the water — injects momentum, conserves mass
  });

  // ---- boot ----
  fitCanvas();
  seed();
  requestAnimationFrame(frame);
})();
