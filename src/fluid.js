/*
 * Conatus — fluid.js
 * Copyright (C) 2026 Alfie Maskell. Licensed under the GNU AGPL v3 (see LICENSE).
 *
 * THE WATER. A grid-based ("Eulerian") fluid solver — Jos Stam's stable-fluids
 * method: advect, diffuse, and project a velocity field so it stays
 * incompressible (divergence-free), which is what gives believable currents,
 * eddies and wakes. The same machinery transports a scalar field (the dissolved
 * nutrient concentration) by letting the flow carry it around.
 *
 * This file is part of the simulation CORE: pure data + math, no DOM, no canvas.
 *
 * Conventions:
 *   - Square cells of side `h` pixels. The grid is Nx by Ny interior cells with
 *     a one-cell border (so arrays are (Nx+2)*(Ny+2)).
 *   - Velocity (u, v) is stored in PIXELS PER SECOND, so particles can sample it
 *     directly without unit juggling.
 *
 * A note on honesty: semi-Lagrangian advection is only approximately
 * conservative for the scalar field, so total dissolved nutrient can drift a
 * little. That is fine here — the water and its dissolved load are the MEDIUM.
 * The strictly-conserved matter of this world is the discrete particles; the
 * truly conserved nutrient pool arrives as particulate matter in a later step.
 */

(function (global) {
  "use strict";

  class Fluid {
    constructor(width, height, cellSize, opts) {
      opts = opts || {};
      this.h = cellSize;
      this.width = width;
      this.height = height;
      this.Nx = Math.max(1, Math.floor(width / cellSize));
      this.Ny = Math.max(1, Math.floor(height / cellSize));
      this.W = this.Nx + 2; // include borders
      this.H = this.Ny + 2;
      const size = this.W * this.H;

      this.u = new Float32Array(size);   // x velocity (px/s)
      this.v = new Float32Array(size);   // y velocity (px/s)
      this.u0 = new Float32Array(size);  // scratch / force source
      this.v0 = new Float32Array(size);
      this.dens = new Float32Array(size);  // dissolved nutrient concentration
      this.dens0 = new Float32Array(size); // scratch / source

      this.visc = opts.visc != null ? opts.visc : 0.00002; // velocity diffusion
      this.diff = opts.diff != null ? opts.diff : 0.00001; // scalar diffusion
      this.iters = opts.iters != null ? opts.iters : 16;   // linear-solver passes
    }

    IX(i, j) { return i + this.W * j; }

    // Convert a world position (px) to (clamped) interior grid coordinates.
    cellOf(x, y) {
      let ci = x / this.h + 0.5; // cell centres sit at integer indices
      let cj = y / this.h + 0.5;
      if (ci < 1) ci = 1; else if (ci > this.Nx) ci = this.Nx;
      if (cj < 1) cj = 1; else if (cj > this.Ny) cj = this.Ny;
      return { ci, cj };
    }

    // Bilinear sample of a field at a world position (px).
    _sample(field, x, y) {
      const { ci, cj } = this.cellOf(x, y);
      const i0 = Math.floor(ci), j0 = Math.floor(cj);
      const i1 = Math.min(i0 + 1, this.Nx), j1 = Math.min(j0 + 1, this.Ny);
      const s1 = ci - i0, s0 = 1 - s1, t1 = cj - j0, t0 = 1 - t1;
      const IX = (i, j) => i + this.W * j;
      return (
        s0 * (t0 * field[IX(i0, j0)] + t1 * field[IX(i0, j1)]) +
        s1 * (t0 * field[IX(i1, j0)] + t1 * field[IX(i1, j1)])
      );
    }

    sampleVelocity(x, y) {
      return { vx: this._sample(this.u, x, y), vy: this._sample(this.v, x, y) };
    }
    sampleNutrient(x, y) { return this._sample(this.dens, x, y); }

    // Add a velocity impulse (px/s of force-density) into the source buffers at
    // a world position. Particles use this to push the water (wakes); ambient
    // stirring uses it too.
    addVelocity(x, y, ax, ay) {
      const { ci, cj } = this.cellOf(x, y);
      const idx = this.IX(Math.round(ci), Math.round(cj));
      this.u0[idx] += ax;
      this.v0[idx] += ay;
    }

    addNutrient(x, y, amount) {
      const { ci, cj } = this.cellOf(x, y);
      this.dens0[this.IX(Math.round(ci), Math.round(cj))] += amount;
    }

    _addSource(x, s, dt) {
      for (let i = 0; i < x.length; i++) x[i] += dt * s[i];
    }

    // Boundary conditions. b=1 reflects x-velocity at left/right walls, b=2
    // reflects y-velocity at top/bottom, b=0 is a free scalar (zero-gradient).
    _setBnd(b, x) {
      const Nx = this.Nx, Ny = this.Ny, IX = (i, j) => i + this.W * j;
      for (let i = 1; i <= Nx; i++) {
        x[IX(i, 0)] = b === 2 ? -x[IX(i, 1)] : x[IX(i, 1)];
        x[IX(i, Ny + 1)] = b === 2 ? -x[IX(i, Ny)] : x[IX(i, Ny)];
      }
      for (let j = 1; j <= Ny; j++) {
        x[IX(0, j)] = b === 1 ? -x[IX(1, j)] : x[IX(1, j)];
        x[IX(Nx + 1, j)] = b === 1 ? -x[IX(Nx, j)] : x[IX(Nx, j)];
      }
      x[IX(0, 0)] = 0.5 * (x[IX(1, 0)] + x[IX(0, 1)]);
      x[IX(0, Ny + 1)] = 0.5 * (x[IX(1, Ny + 1)] + x[IX(0, Ny)]);
      x[IX(Nx + 1, 0)] = 0.5 * (x[IX(Nx, 0)] + x[IX(Nx + 1, 1)]);
      x[IX(Nx + 1, Ny + 1)] = 0.5 * (x[IX(Nx, Ny + 1)] + x[IX(Nx + 1, Ny)]);
    }

    _linSolve(b, x, x0, a, c) {
      const Nx = this.Nx, Ny = this.Ny, IX = (i, j) => i + this.W * j;
      const invC = 1 / c;
      for (let k = 0; k < this.iters; k++) {
        for (let j = 1; j <= Ny; j++) {
          for (let i = 1; i <= Nx; i++) {
            x[IX(i, j)] =
              (x0[IX(i, j)] +
                a * (x[IX(i - 1, j)] + x[IX(i + 1, j)] + x[IX(i, j - 1)] + x[IX(i, j + 1)])) *
              invC;
          }
        }
        this._setBnd(b, x);
      }
    }

    _diffuse(b, x, x0, diff, dt) {
      const a = dt * diff * this.Nx * this.Ny;
      this._linSolve(b, x, x0, a, 1 + 4 * a);
    }

    // Semi-Lagrangian advection: trace each cell centre backwards along the
    // velocity field and sample where it came from.
    _advect(b, d, d0, u, v, dt) {
      const Nx = this.Nx, Ny = this.Ny, IX = (i, j) => i + this.W * j;
      const dt0 = dt / this.h; // px/s * s / (px/cell) = cells moved
      for (let j = 1; j <= Ny; j++) {
        for (let i = 1; i <= Nx; i++) {
          let x = i - dt0 * u[IX(i, j)];
          let y = j - dt0 * v[IX(i, j)];
          if (x < 0.5) x = 0.5; else if (x > Nx + 0.5) x = Nx + 0.5;
          if (y < 0.5) y = 0.5; else if (y > Ny + 0.5) y = Ny + 0.5;
          const i0 = Math.floor(x), i1 = i0 + 1;
          const j0 = Math.floor(y), j1 = j0 + 1;
          const s1 = x - i0, s0 = 1 - s1, t1 = y - j0, t0 = 1 - t1;
          d[IX(i, j)] =
            s0 * (t0 * d0[IX(i0, j0)] + t1 * d0[IX(i0, j1)]) +
            s1 * (t0 * d0[IX(i1, j0)] + t1 * d0[IX(i1, j1)]);
        }
      }
      this._setBnd(b, d);
    }

    // Hodge projection: subtract the gradient of pressure so the velocity field
    // becomes (approximately) divergence-free — i.e. incompressible flow.
    _project(u, v, p, div) {
      const Nx = this.Nx, Ny = this.Ny, IX = (i, j) => i + this.W * j;
      const h = this.h;
      for (let j = 1; j <= Ny; j++) {
        for (let i = 1; i <= Nx; i++) {
          div[IX(i, j)] =
            -0.5 * h * (u[IX(i + 1, j)] - u[IX(i - 1, j)] + v[IX(i, j + 1)] - v[IX(i, j - 1)]);
          p[IX(i, j)] = 0;
        }
      }
      this._setBnd(0, div);
      this._setBnd(0, p);
      this._linSolve(0, p, div, 1, 4);
      for (let j = 1; j <= Ny; j++) {
        for (let i = 1; i <= Nx; i++) {
          u[IX(i, j)] -= (0.5 * (p[IX(i + 1, j)] - p[IX(i - 1, j)])) / h;
          v[IX(i, j)] -= (0.5 * (p[IX(i, j + 1)] - p[IX(i, j - 1)])) / h;
        }
      }
      this._setBnd(1, u);
      this._setBnd(2, v);
    }

    _swap(name) {
      const tmp = this[name];
      this[name] = this[name + "0"];
      this[name + "0"] = tmp;
    }

    // Advance velocity by dt. Sources accumulated in u0/v0 are injected, then
    // diffused, projected, advected, and projected again.
    velStep(dt) {
      this._addSource(this.u, this.u0, dt);
      this._addSource(this.v, this.v0, dt);
      this._swap("u"); this._diffuse(1, this.u, this.u0, this.visc, dt);
      this._swap("v"); this._diffuse(2, this.v, this.v0, this.visc, dt);
      this._project(this.u, this.v, this.u0, this.v0);
      this._swap("u"); this._swap("v");
      this._advect(1, this.u, this.u0, this.u0, this.v0, dt);
      this._advect(2, this.v, this.v0, this.u0, this.v0, dt);
      this._project(this.u, this.v, this.u0, this.v0);
      // u0/v0 are now scratch; clear them so next tick's forces start fresh.
      this.u0.fill(0);
      this.v0.fill(0);
    }

    // Advance the dissolved-nutrient scalar by dt.
    densStep(dt) {
      this._addSource(this.dens, this.dens0, dt);
      this._swap("dens"); this._diffuse(0, this.dens, this.dens0, this.diff, dt);
      this._swap("dens"); this._advect(0, this.dens, this.dens0, this.u, this.v, dt);
      this.dens0.fill(0);
    }

    // Diagnostics for the HUD / tests.
    totals() {
      let nutrient = 0, maxSpeed = 0, ke = 0;
      const Nx = this.Nx, Ny = this.Ny, IX = (i, j) => i + this.W * j;
      for (let j = 1; j <= Ny; j++) {
        for (let i = 1; i <= Nx; i++) {
          const idx = IX(i, j);
          nutrient += this.dens[idx];
          const sp = Math.hypot(this.u[idx], this.v[idx]);
          if (sp > maxSpeed) maxSpeed = sp;
          ke += sp * sp;
        }
      }
      return { nutrient, maxSpeed, flowEnergy: ke };
    }
  }

  global.Conatus = global.Conatus || {};
  global.Conatus.Fluid = Fluid;
  if (typeof module !== "undefined" && module.exports) module.exports = { Fluid };
})(typeof window !== "undefined" ? window : globalThis);
