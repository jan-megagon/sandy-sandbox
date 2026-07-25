# River Kayak

A mobile-first web app in two halves: sculpt a river valley and watch the water
find its way down it, then get in a kayak and paddle the river you made.

The current is not authored. It falls out of a shallow-water simulation running
over the terrain you sculpted, and the same velocity field that draws the
ripples is the one pushing the boat around. Carve a channel differently and the
river — and the run — changes.

## Running it

```sh
npm install
npm run dev        # http://localhost:5173
```

Open it on a phone on the same network (`--host` is already on), or use a
browser's device emulation. It's built for touch; a mouse works for testing.

```sh
npm test           # simulation, physics and serialization tests
npm run typecheck
npm run build      # typecheck + production build into dist/
```

There's also a browser smoke test that drives the built app in a phone-sized
Chromium and captures screenshots of each screen:

```sh
npm run build && npx vite preview --port 4173 &
node scripts/smoke.mjs
```

It checks the things unit tests can't reach — that WebGL comes up, the river
actually renders, paddling moves the boat, the brush changes the terrain and
undo puts it back. Screenshots land in `screenshots/`.

## Playing

**Tap** the left or right half of the screen for a paddle stroke on that side.
A stroke drives you forward and turns the bow *away* from the side you paddled,
so alternating taps runs you straight.

**Hold** a side to plant the paddle. That brakes and pivots you towards that
side — it's how you hold a line across the current or swing around a rock.

Reach the goal ring. The clock is running, and rocks damage the hull.

## The editor

One finger sculpts, two fingers pan and zoom. The water simulation runs the
whole time you're editing, so you can see immediately whether the channel you
just carved actually carries water.

Tools: raise, lower and smooth terrain; place springs, a start, a goal and
rocks; erase. A level needs a spring, a start and a goal before it can be
played.

Levels are stored in the browser and can be shared as a link or a code —
terrain and all, no server involved.

## How it's put together

No frameworks, no runtime dependencies. The whole app is ~22 KB gzipped.

```
src/
  sim/        grid, shallow-water solver, brushes, level format
  game/       kayak rigid body, run rules and clock
  render/     WebGL2: one fullscreen pass for the world, SDF shapes on top
  input/      pointer-event gestures and paddle controls
  modes/      editor and play screens
  ui/         DOM helpers
  app.ts      screen router and fixed-timestep loop
```

**The water** is a virtual-pipe shallow-water model (Mei et al.). Each cell
holds a column of water connected to its neighbours by four pipes; the
difference in water *surface* height drives flow through them. Every cell's
outflow is scaled to at most the water it actually holds, so depth can never go
negative and volume is conserved exactly on a closed grid.

**The kayak** is a 2D rigid body whose handling comes almost entirely from
anisotropic hull drag — forward drag is an eighth of lateral drag. Strokes are
impulses applied off the centreline, so one tap produces both thrust and yaw.

**The renderer** composites terrain and water in a single fullscreen fragment
shader, so the world costs one draw call whatever the level size. Everything on
top of it — boat, rocks, goal, brush cursor — is an analytic distance field, so
there are no textures to load and nothing goes soft when you zoom in.

**Levels** serialise by quantising terrain to 12 bits, running it through a 2D
gradient predictor and zigzag varints, then deflate. A 128×128 level is 37 KB
raw and about 6 KB once sculpted, which is small enough to put in a URL.

See [TUNING.md](TUNING.md) for the constants that govern how the river and the
boat feel, and why they're set where they are.

## Known limits

- Levels are fixed at 128×128 cells (2 m each, so 256 m of river). The format
  carries the grid size, so this can grow, but the solver is CPU-side and
  larger grids will cost proportionally.
- Storage is `localStorage`, so levels are per-browser and subject to its quota.
  Roughly a thousand levels fit; there's no sync.
- Share codes for heavily-noised terrain approach 15 KB. Sculpted levels
  compress far better. Very large codes are better shared as text than as a URL.
- The water and paddle constants are tuned against measurements, not against
  hours of play. Expect to want a pass on `TUNING.md` after real use.
