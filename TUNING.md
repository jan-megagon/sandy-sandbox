# Tuning

Everything that governs how the river and the boat *feel* lives in two constant
blocks. Both were tuned against measurements rather than by eye, so the numbers
below say what each one buys you — change them knowing what you're trading.

Play on a real phone before adjusting. These are the parts most likely to want
a second opinion.

## Water — `DEFAULT_WATER_PARAMS` in `src/sim/water.ts`

| Constant | Default | What it does |
|---|---|---|
| `gravity` | 9.81 | Pressure behind the flow. Rarely worth changing; use `pipeArea` instead. |
| `pipeArea` | 1.0 | Overall flow rate, per metre of depth. The main "how fast is this river" knob. |
| `flowDamping` | 0.15 | Bed friction, as fraction of flow shed per second. **The most sensitive constant in the project.** |
| `evaporation` | 0 | Depth lost per second. Non-zero breaks exact volume conservation. |
| `minDepth` | 0.02 | Below this a cell is dry, for both gameplay and rendering. |
| `maxVelocity` | 6 | Safety clamp only — real flow settles at 0.5–2 m/s. If levels routinely hit this, something else is wrong. |
| `velocityDepthFloor` | 0.15 | Stops a micron-deep film reporting an enormous velocity. |
| `openBorder` | true | Water runs off the edge of the map instead of filling it up. |

Two things about this solver are worth knowing before you touch it.

**Friction is not optional.** With `flowDamping: 0` the scheme is
energy-conserving: a lake sloshes forever and water on any slope accelerates
until it hits `maxVelocity`, so every river in the game runs at exactly one
speed. Friction is what gives flow a terminal velocity set by the local
gradient, which is what separates a rapid from a pool. Raising it towards 1.5
makes the river sluggish and settles basins in ~40 s instead of ~80 s; dropping
it towards 0.05 makes everything a torrent.

**Flux scales with depth.** `pipeArea` is a cross-section *per metre of depth*,
so discharge behaves like `q = h·u`. With a constant cross-section a brimming
channel and a shallow trickle push the same volume per second, which makes
velocity fall as depth rises — deep channels turn into stagnant ponds and a
river never reaches the end of the map. There's a test pinning this
(`carries more water down a deeper channel, not less`).

### Source rates

`rate` on a water source is **metres of depth added per second**, and it is
much smaller than it looks like it should be. Sensible values are 0.1–0.5; the
bundled demo uses 0.25. A rate of 3 injects hundreds of cubic metres a second
into a channel that can carry a few dozen, and the surplus piles into a lake at
the spring instead of running downstream.

### Priming

Filling a 256 m valley by running the springs takes over three minutes of
simulated time, because water advances roughly as fast as it flows. `primeSim`
therefore traces the descent path analytically first (`primeByDescent`) and then
runs the solver for a few seconds to turn the traced channel into moving water.
That takes ~200 ms instead of ~200 s. If a level opens dry, this is the code to
look at.

Priming stops early if the water settles, but on anything valley-sized it won't:
the budget a load screen can afford is 4–12 s and the demo needs about 200. What
that early exit really buys is levels with no springs, or a small pool that is
done in a second, not paying for a budget they don't need. Filling the rest is
the editor's **Fill ⏩** button, which is the same `SettleRun` given 300 s and
spread across frames.

### Settling — `SETTLED_RATE` in `src/sim/level.ts`

Water counts as settled when the mean change in depth across the wet cells falls
below **1e-3 m/s**. Measured on the bundled demo, sampling every 0.25 s:

| Simulated time | Residual | Volume | Share of final |
|---|---|---|---|
| 2 s | 1.8e-1 | 714 | 58% |
| 20 s | 2.1e-2 | 758 | 62% |
| 60 s | 9.2e-3 | 839 | 68% |
| 120 s | 3.3e-3 | 984 | 80% |
| 200 s | 1.2e-3 | 1150 | 94% |
| 300 s | 2.4e-4 | 1223 | 100% |

Two things about that curve are worth knowing before changing the constant.

**The residual climbs before it falls.** `primeByDescent` leaves water standing
where it was traced, so the first checks see a nearly static field and read
*low* — 2.5e-2 at t=0.25 s, against a peak of 1.8e-1 at t≈2 s. Any threshold
above ~2e-2 would pass on the first check, on a river that hasn't started
moving. `SETTLE_RAMP_SECONDS` (3 s) is what stops that, and it is why the check
is not simply "residual below threshold".

### Fast-forward cost — `SETTLE_DT`, `BOOST_FRAME_BUDGET_MS`, `BOOST_RENDER_EVERY`

Settling runs at **dt = 0.1 s**, not the 1/60 the game uses. Nothing watches a
fast-forward frame by frame, so the only limit is stability, and `substepsFor`
puts that at `0.4 · cellSize / waveSpeed` — about 0.127 s on 2 m cells under
4 m of water. Measured on the demo, to the same settled state:

| dt | steps | solver time | final volume | substeps |
|---|---|---|---|---|
| 1/60 | 12416 | 14.8 s | 1159 | 1 |
| 0.05 | 4130 | 4.6 s | 1158 | 1 |
| **0.10** | **2058** | **2.4 s** | 1157 | 1 |
| 0.20 | 1024 | 2.3 s | 1156 | 2 |

0.2 is where it stops paying: the substep guard splits it in two and hands back
everything it gained. Deeper water lowers the ceiling, and the guard handles
that on its own — a lake over ~6.5 m makes `step` substep without being asked.

Past that the solver is no longer what costs. A fill needs a fixed amount of
work, so at `BOOST_FRAME_BUDGET_MS` per frame it needs *work / budget* frames
whatever the hardware — the budget, not the solver, sets how long it takes. It
is set above one frame's 16.7 ms because `BOOST_RENDER_EVERY` skips three
redraws in four, and those frames have nothing else to do. End to end on the
demo, against this box's software rasteriser: 25.3 s originally, 9.8 s at
dt = 0.1, 5.4 s once the budget went to 20 ms. A device with a real GPU spends
far less of that on drawing, so expect the balance to differ.

**Total volume is the tempting measure and the wrong one.** It stalls whenever
the water finishes one basin and climbs again when that basin spills into the
next — on the demo it drops to 1.26 m³/s at t=20 s, then rises back to 2.88 at
t=70 s. A threshold on volume reads as settled several times on the way down a
valley. Depth residual decays monotonically after its peak; volume does not.

## Kayak — `DEFAULT_KAYAK_PARAMS` in `src/game/kayak.ts`

Tuned to these targets, measured on flat water:

| Behaviour | Target |
|---|---|
| One stroke | +0.55 m/s, ~10° of yaw |
| Sustained paddling (~3 taps/s) | 2.75 m/s cruise |
| Coupling to a current | ~1.7 s time constant |
| Held brace | ~65 °/s pivot |
| Twenty alternating strokes | ~4° drift off straight |
| Coast from 3 m/s to rest | ~5.6 s |

The single most important relationship is `dragLateral / dragForward` — 8:1 by
default. That ratio *is* the boat: it's why the hull tracks straight, why it
carves instead of sliding when you turn it, and why a current carries it bodily
sideways when it isn't pointing along the flow. Flatten the ratio and the kayak
starts behaving like a hovercraft.

`dragForward` alone sets how strongly the river grabs you: the coupling time
constant is `mass / dragForward`. Raising it makes the current more
authoritative and the boat twitchier; lowering it makes the river feel like a
suggestion.

## Terrain generation — `generateDefaultTerrain` in `src/sim/terrain.ts`

The generated valley has one hard constraint: **the riverbed must descend
monotonically**. Noise large enough to make hillsides interesting is measured in
metres, while the bed only falls ~0.16 m between adjacent cells, so subtracting
a channel from noisy ground leaves a chain of disconnected basins and the water
pools rather than runs. The generator instead defines the bed explicitly as a
decreasing function and interpolates the terrain *towards* it, and damps the
noise near the river so water that wanders a few cells off centre doesn't drop
into a pit.

If you raise the noise amplitude, check the river still reaches the goal.
