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

## Deploying

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on every
push to `main`, and can be run by hand from the Actions tab. It types, tests and
builds, then uploads `dist/` as the Pages artifact — nothing is committed to a
`gh-pages` branch.

One-time setup: **Settings → Pages → Build and deployment → Source: GitHub
Actions**. The site then lands at `https://<owner>.github.io/<repo>/`.

The build needs no configuration for that subpath — `base: './'` in
`vite.config.ts` makes every asset reference relative, and share links are built
from `location.origin + location.pathname`, so they carry the subpath too.

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

A valley can need minutes of simulation to fill, which is not something to sit
and watch at 1x. **Fill ⏩** runs the water forward as fast as the device
allows, spending part of each frame on extra solver steps so the river fills in
front of you and the editor stays usable. It stops on its own once the water
settles — when the depth field stops changing, which is steady state for a
river that is still very much moving — and tells you how much river time that
took. The demo valley settles after about 200 s of simulation. Press it again
to stop early; editing anything cancels it, since the run is settling the
ground as it stood when it started.

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

## Performance

At the default 128×128 grid, one 1/60 s update — sources, solver and boat —
costs about **0.6 ms** on a desktop-class CPU, against a 16.7 ms frame budget,
with a 1.0 ms worst case. Packing the water field for upload adds 0.05 ms.
There's a lot of headroom for a phone, which is the point of keeping the grid
modest and the solver in flat typed arrays.

Opening a level costs ~400 ms, almost all of it priming the river.

The fragment shader is the part that hasn't been measured on real mobile
hardware — the only GPU available here is a software rasteriser, so its timings
say nothing useful. The water branch is the expensive one, and it only runs for
the few percent of pixels that are wet.

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
