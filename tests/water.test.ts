import { describe, expect, it } from 'vitest';
import { makeGrid, sampleBilinear } from '../src/sim/grid';
import { DEFAULT_WATER_PARAMS, WaterSim } from '../src/sim/water';

function flatSim(size = 16, terrainHeight = 5) {
  const grid = makeGrid(size, size, 1);
  const sim = new WaterSim(grid, { openBorder: false, evaporation: 0 });
  sim.terrain.fill(terrainHeight);
  return sim;
}

function run(sim: WaterSim, seconds: number, dt = 1 / 60) {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) sim.step(dt);
}

describe('WaterSim', () => {
  it('conserves volume on a closed grid', () => {
    const sim = flatSim();
    // A blob of water off to one side, which will slosh across the basin.
    for (let y = 2; y < 6; y++) {
      for (let x = 2; x < 6; x++) sim.depth[y * 16 + x] = 2;
    }
    const before = sim.totalVolume();
    run(sim, 5);
    const after = sim.totalVolume();

    expect(after).toBeCloseTo(before, 3);
  });

  it('never produces negative depth', () => {
    const sim = flatSim();
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) sim.depth[y * 16 + x] = 3;
    }
    run(sim, 8);
    for (let i = 0; i < sim.depth.length; i++) {
      expect(sim.depth[i]).toBeGreaterThanOrEqual(0);
    }
  });

  it('settles to a level surface in a flat closed basin', () => {
    const sim = flatSim();
    for (let y = 4; y < 12; y++) {
      for (let x = 4; x < 12; x++) sim.depth[y * 16 + x] = 1.5;
    }
    run(sim, 60);

    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < sim.depth.length; i++) {
      const surface = sim.terrain[i] + sim.depth[i];
      if (surface < min) min = surface;
      if (surface > max) max = surface;
    }
    // Every cell should end up at nearly the same water surface height.
    expect(max - min).toBeLessThan(0.05);
  });

  it('moves water downhill on a slope', () => {
    const grid = makeGrid(32, 32, 1);
    const sim = new WaterSim(grid, { openBorder: false });
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) sim.terrain[y * 32 + x] = 20 - y * 0.5;
    }
    // Start all the water at the high end.
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 32; x++) sim.depth[y * 32 + x] = 1;
    }

    const centroidY = () => {
      let sum = 0;
      let mass = 0;
      for (let y = 0; y < 32; y++) {
        for (let x = 0; x < 32; x++) {
          const d = sim.depth[y * 32 + x];
          sum += d * y;
          mass += d;
        }
      }
      return sum / mass;
    };

    const before = centroidY();
    run(sim, 10);
    expect(centroidY()).toBeGreaterThan(before + 5);
  });

  it('produces a downhill velocity field on a fed ramp', () => {
    const grid = makeGrid(32, 32, 1);
    const sim = new WaterSim(grid, { openBorder: true });
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) sim.terrain[y * 32 + x] = 20 - y * 0.5;
    }
    // The ramp drains off the open bottom edge, so keep a spring running at the
    // top; otherwise we'd be measuring the velocity of a dry cell.
    const source = [{ x: 16, y: 1, rate: 6, radius: 6 }];
    for (let i = 0; i < 60 * 10; i++) {
      sim.applySources(source, 1 / 60);
      sim.step(1 / 60);
    }

    // Terrain descends in +y, so the current should run in +y.
    const i = 16 * 32 + 16;
    expect(sim.depth[i]).toBeGreaterThan(0.05);
    expect(sim.vy[i]).toBeGreaterThan(0.2);
    expect(Math.abs(sim.vx[i])).toBeLessThan(Math.abs(sim.vy[i]));
  });

  it('damps flow so a disturbed basin comes to rest', () => {
    const sim = flatSim();
    for (let y = 4; y < 12; y++) {
      for (let x = 4; x < 12; x++) sim.depth[y * 16 + x] = 1.5;
    }
    // Bed friction is light, so settling takes a while - but it must actually
    // finish, or a lake in the editor would ripple forever.
    run(sim, 90);

    let maxSpeed = 0;
    for (let i = 0; i < sim.depth.length; i++) {
      maxSpeed = Math.max(maxSpeed, Math.hypot(sim.vx[i], sim.vy[i]));
    }
    expect(maxSpeed).toBeLessThan(0.02);
  });

  it('runs faster on a steeper slope', () => {
    const speedFor = (dropPerCell: number) => {
      const grid = makeGrid(32, 32, 2);
      const sim = new WaterSim(grid, { openBorder: true });
      for (let y = 0; y < 32; y++) {
        for (let x = 0; x < 32; x++) sim.terrain[y * 32 + x] = 25 - y * dropPerCell;
      }
      const source = [{ x: 16, y: 1, rate: 0.6, radius: 6 }];
      for (let i = 0; i < 60 * 20; i++) {
        sim.applySources(source, 1 / 60);
        sim.step(1 / 60);
      }
      const i = 16 * 32 + 16;
      return Math.hypot(sim.vx[i], sim.vy[i]);
    };

    const gentle = speedFor(0.02);
    const steep = speedFor(0.2);

    // Friction, not the velocity clamp, must be what sets these apart - so both
    // have to sit clear of maxVelocity for the comparison to mean anything.
    expect(steep).toBeGreaterThan(gentle * 1.5);
    expect(steep).toBeLessThan(DEFAULT_WATER_PARAMS.maxVelocity * 0.95);
  });

  it('carries more water down a deeper channel, not less', () => {
    // Discharge should rise with depth (q = h*u). A constant pipe area makes
    // velocity fall as depth grows, which turns deep channels into stagnant
    // ponds - the bug that kept the demo river from ever reaching its goal.
    const dischargeFor = (depth: number) => {
      const grid = makeGrid(24, 24, 2);
      const sim = new WaterSim(grid, { openBorder: true });
      for (let y = 0; y < 24; y++) {
        for (let x = 0; x < 24; x++) sim.terrain[y * 24 + x] = 20 - y * 0.1;
      }
      sim.depth.fill(depth);
      for (let i = 0; i < 60; i++) sim.step(1 / 60);
      const i = 12 * 24 + 12;
      return Math.hypot(sim.vx[i], sim.vy[i]) * sim.depth[i];
    };

    expect(dischargeFor(1.0)).toBeGreaterThan(dischargeFor(0.25));
  });

  it('drains off an open border but pools behind a closed one', () => {
    const open = flatSim(16, 0);
    open.params.openBorder = true;
    open.depth.fill(1);
    run(open, 10);

    const closed = flatSim(16, 0);
    closed.depth.fill(1);
    run(closed, 10);

    expect(open.totalVolume()).toBeLessThan(closed.totalVolume() * 0.5);
    expect(closed.totalVolume()).toBeCloseTo(16 * 16, 2);
  });

  it('accumulates water from a source', () => {
    const sim = flatSim();
    const sources = [{ x: 8, y: 8, rate: 2, radius: 2 }];
    for (let i = 0; i < 120; i++) {
      sim.applySources(sources, 1 / 60);
      sim.step(1 / 60);
    }
    expect(sim.totalVolume()).toBeGreaterThan(1);
    expect(Number.isFinite(sim.totalVolume())).toBe(true);
  });

  it('stays finite under a violent initial condition', () => {
    const sim = flatSim(32, 0);
    // A 20 m column dropped onto a dry basin - worst case for the solver.
    sim.depth[16 * 32 + 16] = 20;
    run(sim, 20);
    for (let i = 0; i < sim.depth.length; i++) {
      expect(Number.isFinite(sim.depth[i])).toBe(true);
      expect(Number.isFinite(sim.vx[i])).toBe(true);
      expect(Number.isFinite(sim.vy[i])).toBe(true);
    }
  });
});

describe('sampleBilinear', () => {
  it('reproduces cell values at cell centres', () => {
    const g = makeGrid(4, 4, 2);
    const f = new Float32Array(16);
    for (let i = 0; i < 16; i++) f[i] = i;
    expect(sampleBilinear(f, g, 2 * 0.5, 2 * 0.5)).toBeCloseTo(0, 5);
    expect(sampleBilinear(f, g, 2 * 2.5, 2 * 1.5)).toBeCloseTo(6, 5);
  });

  it('interpolates halfway between neighbours', () => {
    const g = makeGrid(4, 4, 1);
    const f = new Float32Array(16);
    f[0] = 0;
    f[1] = 10;
    expect(sampleBilinear(f, g, 1.0, 0.5)).toBeCloseTo(5, 5);
  });

  it('clamps outside the grid instead of wrapping', () => {
    const g = makeGrid(4, 4, 1);
    const f = new Float32Array(16);
    f.fill(3);
    expect(sampleBilinear(f, g, -50, -50)).toBeCloseTo(3, 5);
    expect(sampleBilinear(f, g, 500, 500)).toBeCloseTo(3, 5);
  });
});
