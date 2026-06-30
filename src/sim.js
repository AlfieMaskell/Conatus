/*
 * Conatus — a soft-body artificial-life simulation.
 * Copyright (C) 2026 Alfie Maskell
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See the LICENSE file for details.
 *
 * ---------------------------------------------------------------------------
 * sim.js — THE SIMULATION CORE.
 *
 * This file is pure simulation: data + math that advances the world state by
 * one tick. It knows NOTHING about pixels, canvas, or the DOM. That separation
 * is deliberate and load-bearing — it is what lets us later swap the renderer
 * (Canvas -> WebGL -> WebGPU) or move the hot loop to WASM without ever
 * touching the physics. Do not import anything browser-specific into this file.
 *
 * STEP ONE scope (no biology yet):
 *   - particles (the conserved matter of the world)
 *   - spring bonds between particles (soft bodies; breakable)
 *   - buoyancy + gravity in a water medium
 *   - linear medium drag (an ENERGY sink — energy is NOT conserved, by design)
 *   - particle-particle collision via a spatial hash (no O(n^2) work)
 *   - semi-implicit Euler integration
 *
 * THE THESIS this step exists to demonstrate, visibly and numerically:
 *   matter is conserved (total mass is constant to the particle),
 *   energy is open (kinetic energy bleeds away through drag).
 * ---------------------------------------------------------------------------
 */

(function (global) {
  "use strict";

  // A single grain of matter. In later steps a particle gains a cell TYPE,
  // an energy store, and metabolic behaviour. For now it is just stuff.
  class Particle {
    constructor(x, y, mass, radius, density) {
      this.x = x;
      this.y = y;
      this.vx = 0;
      this.vy = 0;
      this.fx = 0; // force accumulator, cleared every tick
      this.fy = 0;
      this.mass = mass;
      this.radius = radius;
      // density is mass per unit (2D) area; it decides float vs sink relative
      // to the water. We store it explicitly so the renderer can shade by it
      // and so buoyancy reads cleanly.
      this.density = density;
    }
  }

  // A spring constraint holding two particles at a rest length. Past a strain
  // threshold the bond snaps — that is the seed of "rippable" bodies and, later,
  // predation. Bonds never create or destroy matter; they only hold it together.
  class Bond {
    constructor(a, b, rest, stiffness, damping, breakStrain) {
      this.a = a; // index into particles[]
      this.b = b;
      this.rest = rest;
      this.k = stiffness;
      this.damp = damping;
      // breakStrain is fractional: snap when |len - rest| / rest exceeds it.
      // Infinity => unbreakable (useful while debugging).
      this.breakStrain = breakStrain;
      this.broken = false;
    }
  }

  class Sim {
    constructor(width, height) {
      this.width = width;
      this.height = height;

      this.particles = [];
      this.bonds = [];

      // --- World parameters (tunable; these are the "physics constants") ---
      // Tuned for a calm, viscous, underwater feel: small organisms live at low
      // Reynolds number, where the medium dominates and there is almost no
      // coasting. Drag is therefore STRONG relative to gravity, so things drift
      // to a gentle terminal velocity instead of accelerating without bound.
      this.gravity = 110;        // downward accel (px/s^2). +y is down.
      this.waterDensity = 1.0;   // reference density of the medium
      this.dragK = 28;           // linear medium drag (the energy sink)
      this.restitution = 0.2;    // wall bounciness
      this.collisionK = 500;     // particle-particle repulsion stiffness
      this.collisionDamp = 6;    // damping along the contact normal (kills bounce energy)
      this.maxSpeed = 600;       // hard velocity clamp — a safety net against blow-ups

      // Spatial hash cell size is set when we know typical particle radius.
      this.cellSize = 24;
      this._grid = new Map();

      // Accumulated energy lost to drag this run — purely for the HUD, so we
      // can show energy LEAVING the system (the open half of "matter-closed,
      // energy-open").
      this.energyDissipated = 0;
    }

    addParticle(p) {
      this.particles.push(p);
      return this.particles.length - 1;
    }

    addBond(aIdx, bIdx, stiffness, damping, breakStrain) {
      const a = this.particles[aIdx];
      const b = this.particles[bIdx];
      const rest = Math.hypot(a.x - b.x, a.y - b.y);
      this.bonds.push(new Bond(aIdx, bIdx, rest, stiffness, damping, breakStrain));
      return this.bonds.length - 1;
    }

    // Conserved + diagnostic totals. mass MUST be invariant across ticks in
    // step one — that is the thing we are proving. ke trends downward.
    totals() {
      let mass = 0;
      let ke = 0;
      const parts = this.particles;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        mass += p.mass;
        ke += 0.5 * p.mass * (p.vx * p.vx + p.vy * p.vy);
      }
      return {
        count: parts.length,
        mass: mass,
        kineticEnergy: ke,
        energyDissipated: this.energyDissipated,
      };
    }

    // ---- the spatial hash: keeps neighbour-finding cheap ----
    _hashKey(cx, cy) {
      return cx + "," + cy;
    }

    _rebuildGrid() {
      const grid = this._grid;
      grid.clear();
      const cs = this.cellSize;
      const parts = this.particles;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const cx = Math.floor(p.x / cs);
        const cy = Math.floor(p.y / cs);
        const key = this._hashKey(cx, cy);
        let cell = grid.get(key);
        if (!cell) {
          cell = [];
          grid.set(key, cell);
        }
        cell.push(i);
      }
    }

    // Advance the world by dt seconds.
    step(dt) {
      const parts = this.particles;
      const n = parts.length;

      // 1) clear force accumulators
      for (let i = 0; i < n; i++) {
        parts[i].fx = 0;
        parts[i].fy = 0;
      }

      // 2) body forces: gravity + buoyancy, then medium drag.
      //    A particle displaces water equal to its area; if it is denser than
      //    water it sinks, if lighter it rises. Net vertical force:
      //        (mass - waterDensity * area) * gravity
      for (let i = 0; i < n; i++) {
        const p = parts[i];
        const area = Math.PI * p.radius * p.radius;
        const displaced = this.waterDensity * area;
        p.fy += (p.mass - displaced) * this.gravity;

        // Linear drag opposes motion. This is where kinetic energy LEAVES the
        // system as (notional) heat — the simulation's arrow of time.
        p.fx += -this.dragK * p.vx;
        p.fy += -this.dragK * p.vy;
      }

      // 3) bond spring forces (Hookean + along-bond damping)
      for (let bi = 0; bi < this.bonds.length; bi++) {
        const bond = this.bonds[bi];
        if (bond.broken) continue;
        const a = parts[bond.a];
        const b = parts[bond.b];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let len = Math.hypot(dx, dy) || 1e-6;
        const nx = dx / len;
        const ny = dy / len;

        const strain = (len - bond.rest) / bond.rest;
        if (Math.abs(strain) > bond.breakStrain) {
          bond.broken = true; // matter stays; the link does not
          continue;
        }

        // spring force magnitude
        const fs = bond.k * (len - bond.rest);
        // relative velocity along the bond, for damping
        const rvx = b.vx - a.vx;
        const rvy = b.vy - a.vy;
        const vrel = rvx * nx + rvy * ny;
        const fd = bond.damp * vrel;
        const f = fs + fd;

        a.fx += f * nx;
        a.fy += f * ny;
        b.fx -= f * nx;
        b.fy -= f * ny;
      }

      // 4) particle-particle collisions (soft repulsion on overlap)
      this._rebuildGrid();
      const cs = this.cellSize;
      const grid = this._grid;
      for (let i = 0; i < n; i++) {
        const p = parts[i];
        const cx = Math.floor(p.x / cs);
        const cy = Math.floor(p.y / cs);
        for (let ox = -1; ox <= 1; ox++) {
          for (let oy = -1; oy <= 1; oy++) {
            const cell = grid.get(this._hashKey(cx + ox, cy + oy));
            if (!cell) continue;
            for (let k = 0; k < cell.length; k++) {
              const j = cell[k];
              if (j <= i) continue; // each pair once
              const q = parts[j];
              const dx = q.x - p.x;
              const dy = q.y - p.y;
              const minDist = p.radius + q.radius;
              const d2 = dx * dx + dy * dy;
              if (d2 >= minDist * minDist) continue;
              const d = Math.sqrt(d2) || 1e-6;
              const overlap = minDist - d;
              const nx = dx / d;
              const ny = dy / d;
              // penalty repulsion + damping along the contact normal. The
              // damping term removes the relative approach velocity so deep
              // overlaps (e.g. at spawn) settle instead of springing apart.
              const vrel = (q.vx - p.vx) * nx + (q.vy - p.vy) * ny;
              const f = this.collisionK * overlap - this.collisionDamp * vrel;
              p.fx -= f * nx;
              p.fy -= f * ny;
              q.fx += f * nx;
              q.fy += f * ny;
            }
          }
        }
      }

      // 5) integrate (semi-implicit Euler) and measure drag losses
      for (let i = 0; i < n; i++) {
        const p = parts[i];
        const keBefore = 0.5 * p.mass * (p.vx * p.vx + p.vy * p.vy);

        const ax = p.fx / p.mass;
        const ay = p.fy / p.mass;
        p.vx += ax * dt;
        p.vy += ay * dt;

        // hard speed clamp: a safety net so a bad frame can never explode the
        // world. In normal operation drag keeps speeds well below this.
        const sp2 = p.vx * p.vx + p.vy * p.vy;
        if (sp2 > this.maxSpeed * this.maxSpeed) {
          const s = this.maxSpeed / Math.sqrt(sp2);
          p.vx *= s;
          p.vy *= s;
        }

        p.x += p.vx * dt;
        p.y += p.vy * dt;

        // 6) tank walls (clamp + restitution). Matter cannot leave the world.
        if (p.x < p.radius) { p.x = p.radius; p.vx = -p.vx * this.restitution; }
        if (p.x > this.width - p.radius) { p.x = this.width - p.radius; p.vx = -p.vx * this.restitution; }
        if (p.y < p.radius) { p.y = p.radius; p.vy = -p.vy * this.restitution; }
        if (p.y > this.height - p.radius) { p.y = this.height - p.radius; p.vy = -p.vy * this.restitution; }

        const keAfter = 0.5 * p.mass * (p.vx * p.vx + p.vy * p.vy);
        // Any drop attributable to drag/walls is energy that left the system.
        const lost = keBefore - keAfter;
        if (lost > 0) this.energyDissipated += lost;
      }
    }

    // Apply a radial impulse (used by the "poke" input) — still conserves mass,
    // it just injects momentum, exactly like stirring the water.
    poke(x, y, strength, radius) {
      const parts = this.particles;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const dx = p.x - x;
        const dy = p.y - y;
        const d = Math.hypot(dx, dy) || 1e-6;
        if (d > radius) continue;
        const falloff = (1 - d / radius) * strength;
        p.vx += (dx / d) * falloff;
        p.vy += (dy / d) * falloff;
      }
    }
  }

  // Export for either a browser global or Node (used by the headless tests),
  // without assuming a specific module system.
  const api = { Sim, Particle, Bond };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    global.Conatus = global.Conatus || {};
    global.Conatus.Sim = Sim;
    global.Conatus.Particle = Particle;
    global.Conatus.Bond = Bond;
  }
})(typeof window !== "undefined" ? window : globalThis);
