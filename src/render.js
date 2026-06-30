/*
 * Conatus — render.js
 * Copyright (C) 2026 Alfie Maskell. Licensed under the GNU AGPL v3 (see LICENSE).
 *
 * THE RENDERER. It only ever READS simulation state and draws it. It must not
 * mutate the sim, and the sim must not know it exists.
 *
 * Layers (back to front): light-field water column, dissolved-nutrient field,
 * (optional) flow streaks, bonds, particles.
 */

(function (global) {
  "use strict";

  class Renderer {
    constructor(canvas, sim) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.sim = sim;
      this.showBonds = true;
      this.showNutrient = true;
      this.showFlow = false;
    }

    _densityColor(density, water) {
      const ratio = density / water;
      const t = Math.max(0, Math.min(1, (ratio - 0.5) / 1.5));
      const r = Math.round(235 * (1 - t) + 40 * t);
      const g = Math.round(225 * (1 - t) + 150 * t);
      const b = Math.round(190 * (1 - t) + 175 * t);
      return `rgb(${r},${g},${b})`;
    }

    // Water column shaded by the actual light field (bright surface -> dark deep).
    _drawWater(w, h) {
      const ctx = this.ctx;
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      const stops = 6;
      for (let i = 0; i <= stops; i++) {
        const y = (i / stops) * h;
        const L = this.sim.lightAt ? this.sim.lightAt(w * 0.5, y) : 1 - y / h;
        // mix deep (#04141f) -> lit surface (#0f4a66) by light level
        const r = Math.round(4 + (15 - 4) * L);
        const g = Math.round(20 + (74 - 20) * L);
        const b = Math.round(31 + (102 - 31) * L);
        grad.addColorStop(i / stops, `rgb(${r},${g},${b})`);
      }
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    }

    // Dissolved-nutrient concentration as a soft green haze, cell by cell.
    _drawNutrient() {
      const f = this.sim.fluid;
      if (!f) return;
      const ctx = this.ctx;
      const hh = f.h;
      for (let j = 1; j <= f.Ny; j++) {
        for (let i = 1; i <= f.Nx; i++) {
          const d = f.dens[f.IX(i, j)];
          if (d <= 0.01) continue;
          const a = Math.min(0.45, d * 0.4);
          ctx.fillStyle = `rgba(120,210,150,${a})`;
          ctx.fillRect((i - 1) * hh, (j - 1) * hh, hh + 1, hh + 1);
        }
      }
    }

    // Flow field as faint streaks from each cell centre.
    _drawFlow() {
      const f = this.sim.fluid;
      if (!f) return;
      const ctx = this.ctx;
      const hh = f.h;
      ctx.strokeStyle = "rgba(150,200,220,0.25)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      const step = 1;
      for (let j = 1; j <= f.Ny; j += step) {
        for (let i = 1; i <= f.Nx; i += step) {
          const cx = (i - 0.5) * hh, cy = (j - 0.5) * hh;
          const u = f.u[f.IX(i, j)], v = f.v[f.IX(i, j)];
          const sc = 0.08;
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + u * sc, cy + v * sc);
        }
      }
      ctx.stroke();
    }

    draw() {
      const ctx = this.ctx;
      const sim = this.sim;
      const w = sim.width, h = sim.height;

      this._drawWater(w, h);
      if (this.showNutrient) this._drawNutrient();
      if (this.showFlow) this._drawFlow();

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

      const parts = sim.particles;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fillStyle = this._densityColor(p.density, sim.waterDensity);
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(0,0,0,0.25)";
        ctx.stroke();
      }
    }
  }

  global.Conatus = global.Conatus || {};
  global.Conatus.Renderer = Renderer;
  if (typeof module !== "undefined" && module.exports) module.exports = { Renderer };
})(typeof window !== "undefined" ? window : globalThis);
