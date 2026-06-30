# Conatus

> *conatus* (n.) — the innate striving of a thing to persevere in its own being.
> — Spinoza

A soft-body artificial-life simulation. Organisms are not shapes dropped onto a
world; they are made of the same conserved matter as the world around them, and
they stay alive only by capturing enough energy to hold themselves together
against the pull of entropy. Eat, maintain, resist dissolution, divide. That
striving-to-persist is the rule the whole simulation runs on — hence the name.

This is a long project built deliberately, one provable step at a time.

## The principles (these don't change)

- **Matter is conserved.** Particles are never created or destroyed — only moved,
  bonded, and rebonded. Food is particles. Bodies are particles. A corpse is
  particles. Death returns matter to the world for something else to use.
- **Energy is open.** Energy enters from an external source (eventually: light),
  is captured and spent, and continuously leaks away as heat through drag and
  metabolism. Matter cycles; energy flows downhill. That gradient is what life
  climbs.
- **Reproduction is fission, not cloning.** An organism cannot conjure mass; it
  must accrete enough matter to roughly double, then divide — sacrificing its own
  particles to make two closed bodies. No magic instantiation.
- **Bodies are breakable.** Bonds snap under strain, so organisms can be torn
  into and their matter eaten or recycled.
- **Simulate at the level where selection can see function.** Everything below
  that altitude (e.g. protein synthesis) is folded into the genome→body rule, not
  modelled directly.

## Architecture

Plain JavaScript, Canvas 2D, no framework, no build step. The one load-bearing
rule: **the simulation core (`src/sim.js`) is completely decoupled from
rendering.** The sim is pure data + math that advances state by one tick and
knows nothing about pixels; the renderer only reads state and draws. That
separation is what will let the hot loop later move to WebGL/WebGPU or WASM
without touching the physics or the biology.

```
index.html      page + HUD + styling
src/sim.js      simulation core — pure physics, no DOM (the real code)
src/render.js   Canvas renderer — reads sim state only
src/main.js     wiring: world seeding, fixed-timestep loop, HUD, input
```

## Run it

No build, no dependencies. Either:

- **Open `index.html` directly** in a browser, or
- Serve the folder: `python -m http.server` then visit `http://localhost:8000`.

Controls: **click** to stir the water · **Space** pause · **R** reset · **B**
toggle bonds.

## Status — Step two: the water

Still **no biology** — but the tank is now an environment. A grid-based
stable-fluids solver gives the water real currents, eddies and wakes; bodies are
dragged relative to the *local* flow and push back on it, so a moving organism
leaves a trail and a passive grain gets carried along. Riding on the same grid
are a **dissolved-nutrient field** (welling up from the floor, swept around by
the currents) and a depth-based **light field** (bright at the surface, dark in
the deep) — the two resources the first organism will live on. Matter is still
conserved to the particle; the fluid stays stable and real-time.

Controls: **click** to stir · **Space** pause · **R** reset · **B** bonds ·
**N** nutrient field · **F** flow streaks · **H** show/hide stats.

### Roadmap (rough order of payoff)

1. ✅ Conserved-physics sandbox
2. ✅ Grid fluid field (currents) + dissolved-nutrient and light fields on the same grid
3. First organism: membrane-bounded photoautotroph — eats light + dissolved matter, grows, divides by fission
4. Sensor cells + tiny neural controllers → emergent steering, feeding, fleeing
5. Predation and a real food web; decomposition closes the matter loop
6. Sexual reproduction + genetic crossover → speciation
7. Memory / prediction in the brains
8. Performance: level-of-detail body representation; GPU (WebGL/WebGPU) compute

## License

[GNU AGPL v3](LICENSE). Copyleft with the network clause: anyone who runs a
modified version as a network service must also release their source. Chosen
deliberately to keep the project — and any future hosted, shared-world version —
open for everyone.
