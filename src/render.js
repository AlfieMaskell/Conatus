/*
 * Conatus — render.js
 * Copyright (C) 2026 Alfie Maskell. Licensed under the GNU AGPL v3 (see LICENSE).
 *
 * THE RENDERER. It only ever READS simulation state and draws it. It must not
 * mutate the sim, and the sim must not know it exists. If you ever find the
 * renderer changing particle data, stop — that coupling is the thing we are
 * protecting against, because it is what would turn a future Canvas->WebGL
 * swap into a rewrite.
 */

(function (global) {
  "use strict";

  class Renderer {
    constructor(canvas, sim) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.sim = sim;
      this.showBonds = true;
    }

    // Map a particle's density (relative to water) to a colour:
    // lighter-than-water (buoyant) -> warm/pale, denser (sinks) -> cool/dark.
    _densityColor(density, water) {
      const ratio = density / water; // <1 floats, >1 sinks
      // clamp ratio to a sensible range for colouring
      const t = Math.max(0, Math.min(1, (ratio - 0.5) / 1.5));
      // interpolate from warm pale (buoyant) to deep teal (heavy)
      const r = Math.round(235 * (1 - t) + 40 * t);
      const g = Math.round(225 * (1 - t) + 150 * t);
      const b = Math.round(190 * (1 - t) + 175 * t);
      return `rgb(${r},${g},${b})`;
    }

    draw() {
      const ctx = this.ctx;
      const sim = this.sim;
      const w = sim.width;
      const h = sim.height;

      // --- water column: a depth gradient. Brighter near the surface, darker
      // with depth. This is purely cosmetic now, but it foreshadows the light
      // field that will drive photosynthesis in a later step. ---
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, "#0d3b54");   // sunlit surface
      grad.addColorStop(0.5, "#08293c");
      grad.addColorStop(1, "#04141f");   // dark deep
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      // --- bonds ---
      if (this.showBonds) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = "rgba(180,210,220,0.35)";
        ctx.beginPath();
        for (let i = 0; i < sim.bonds.length; i++) {
          const bond = sim.bonds[i];
          if (bond.broken) continue;
          const a = sim.particles[bond.a];
          const b = sim.particles[bond.b];
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
        }
        ctx.stroke();
      }

      // --- particles ---
      const parts = sim.particles;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fillStyle = this._densityColor(p.density, sim.waterDensity);
        ctx.fill();
        // subtle rim so overlapping grains read separately
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(0,0,0,0.25)";
        ctx.stroke();
      }
    }
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { Renderer };
  } else {
    global.Conatus = global.Conatus || {};
    global.Conatus.Renderer = Renderer;
  }
})(typeof window !== "undefined" ? window : globalThis);
