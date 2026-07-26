import { describe, expect, it } from 'vitest';
import { createDemoLevel } from '../src/levels/demo';
import {
  SETTLED_RATE,
  SettleRun,
  applySettledWater,
  decodeWater,
  encodeWater,
  waterFingerprint,
  buildSim,
  createLevel,
  decodeLevel,
  encodeLevel,
  isPlayable,
  primeByDescent,
  primeSim,
  toSimSources,
} from '../src/sim/level';

function sampleLevel() {
  const level = createLevel('Test Run', 64, 64, 2);
  level.sources = [{ x: 60, y: 8, rate: 3, radius: 10 }];
  level.start = { x: 60, y: 20, heading: Math.PI / 2 };
  level.goal = { x: 70, y: 110, radius: 6 };
  level.obstacles = [
    { x: 50, y: 60, radius: 3 },
    { x: 80, y: 90, radius: 4 },
  ];
  return level;
}

describe('level serialization', () => {
  it('round-trips a level through a share code', async () => {
    const level = sampleLevel();
    const code = await encodeLevel(level);
    const back = await decodeLevel(code);

    expect(back.name).toBe('Test Run');
    expect(back.width).toBe(64);
    expect(back.height).toBe(64);
    expect(back.cellSize).toBe(2);
    expect(back.sources).toEqual(level.sources);
    expect(back.start).toEqual(level.start);
    expect(back.goal).toEqual(level.goal);
    expect(back.obstacles).toEqual(level.obstacles);
  });

  it('preserves terrain to within quantisation error', async () => {
    const level = sampleLevel();
    const back = await decodeLevel(await encodeLevel(level));

    expect(back.terrain.length).toBe(level.terrain.length);
    let worst = 0;
    for (let i = 0; i < level.terrain.length; i++) {
      worst = Math.max(worst, Math.abs(level.terrain[i] - back.terrain[i]));
    }
    // 12 bits over a 40 m range: half a step is under 5 mm.
    expect(worst).toBeLessThan(0.01);
  });

  it('produces a share code small enough for a URL', async () => {
    const code = await encodeLevel(createLevel('Big', 128, 128, 2));
    expect(code.length).toBeLessThan(20000);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rejects corrupt codes rather than throwing something unhelpful', async () => {
    await expect(decodeLevel('not-a-real-code')).rejects.toThrow(/Invalid level/);
    await expect(decodeLevel('')).rejects.toThrow(/Invalid level/);
  });

  it('rejects a level claiming an absurd grid size', async () => {
    const level = createLevel('Evil', 64, 64, 2);
    const code = await encodeLevel(level);
    // Tamper with the decoded header to fake a huge grid.
    const evil = { ...level, width: 99999 };
    const evilCode = await encodeLevel(evil as never).catch(() => null);
    if (evilCode) {
      await expect(decodeLevel(evilCode)).rejects.toThrow(/Invalid level/);
    }
    // The untampered code must still be fine.
    await expect(decodeLevel(code)).resolves.toBeTruthy();
  });
});

describe('level helpers', () => {
  it('is only playable with both a start and a goal', () => {
    const level = createLevel('x', 32, 32, 2);
    expect(isPlayable(level)).toBe(false);
    level.start = { x: 1, y: 1, heading: 0 };
    expect(isPlayable(level)).toBe(false);
    level.goal = { x: 5, y: 5, radius: 4 };
    expect(isPlayable(level)).toBe(true);
  });

  it('converts world-space sources into cell space for the solver', () => {
    const level = createLevel('x', 32, 32, 2);
    level.sources = [{ x: 20, y: 40, rate: 3, radius: 8 }];
    expect(toSimSources(level)).toEqual([{ x: 10, y: 20, rate: 3, radius: 4 }]);
  });
});

describe('settling', () => {
  it('stops as soon as there is no water to settle', () => {
    const level = createLevel('Dry', 32, 32, 2);
    const report = primeSim(buildSim(level), toSimSources(level), { maxSeconds: 30 });

    // No springs means nothing will ever change, so spending the budget on it
    // would just be a slower way of arriving at the same dry level.
    expect(report.settled).toBe(true);
    expect(report.seconds).toBeLessThan(1);
  });

  it('does not call a river settled while it is still getting going', () => {
    // primeByDescent leaves water standing, so the residual is small on the
    // first check and climbs from there. Without the ramp guard this is
    // exactly the case that would report a dry-ish level as settled.
    const level = createDemoLevel();
    const report = primeSim(buildSim(level), toSimSources(level), { maxSeconds: 2 });

    expect(report.settled).toBe(false);
    expect(report.seconds).toBeGreaterThanOrEqual(2);
  });

  it('settles a basin that has nowhere left to go', () => {
    const level = createLevel('Basin', 32, 32, 2);
    const sim = buildSim(level);
    for (let y = 8; y < 24; y++) {
      for (let x = 8; x < 24; x++) sim.depth[y * 32 + x] = 1.5;
    }
    const run = new SettleRun(sim, [], { maxSeconds: 120 });
    while (!run.done) run.advance(1);

    expect(run.report.settled).toBe(true);
    expect(run.report.seconds).toBeLessThan(120);
    expect(run.report.rate).toBeLessThan(SETTLED_RATE);
  });

  it('gives up at the ceiling rather than running forever', () => {
    const level = createLevel('Endless', 48, 48, 2);
    // A spring feeding a closed bowl never reaches steady state - it just
    // keeps rising - so only the ceiling can end this one.
    level.sources = [{ x: 48, y: 48, rate: 0.4, radius: 4 }];
    const sim = buildSim(level);
    sim.params.openBorder = false;
    const run = new SettleRun(sim, toSimSources(level), { maxSeconds: 8 });
    while (!run.done) run.advance(1);

    expect(run.report.settled).toBe(false);
    expect(run.report.seconds).toBeGreaterThanOrEqual(8);
  });

  it('reaches the same place whether run in one go or spread over frames', () => {
    const level = createDemoLevel();
    const whole = buildSim(level);
    const sliced = buildSim(level);

    primeByDescent(whole, toSimSources(level));
    primeByDescent(sliced, toSimSources(level));

    const a = new SettleRun(whole, toSimSources(level), { maxSeconds: 6 });
    a.advance(6);
    const b = new SettleRun(sliced, toSimSources(level), { maxSeconds: 6 });
    // The editor advances in whatever slice the frame budget allows, so the
    // outcome must not depend on how the run was chopped up.
    while (!b.done) b.advance(0.1);

    let worst = 0;
    for (let i = 0; i < whole.depth.length; i++) {
      worst = Math.max(worst, Math.abs(whole.depth[i] - sliced.depth[i]));
    }
    expect(worst).toBeLessThan(1e-6);
  });
});

describe('settled water cache', () => {
  it('round-trips a depth field within the stored quantum', async () => {
    const level = createDemoLevel();
    const sim = buildSim(level);
    primeSim(sim, toSimSources(level), { maxSeconds: 4 });

    const back = await decodeWater(await encodeWater(sim.depth), sim.depth.length);
    expect(back).not.toBeNull();
    let worst = 0;
    for (let i = 0; i < sim.depth.length; i++) {
      worst = Math.max(worst, Math.abs((back as Float32Array)[i] - sim.depth[i]));
    }
    // Stored to the centimetre, so half of one is the most it can be out.
    expect(worst).toBeLessThanOrEqual(0.005);
  });

  it('compresses a river to something worth storing', async () => {
    const level = createDemoLevel();
    const sim = buildSim(level);
    primeSim(sim, toSimSources(level), { maxSeconds: 4 });

    const code = await encodeWater(sim.depth);
    // Raw would be two bytes a cell; most of a map is dry and deflates away.
    expect(code.length).toBeLessThan(sim.depth.length * 2 * 0.25);
  });

  it('treats an unusable cache as a miss rather than an error', async () => {
    expect(await decodeWater('not a real code', 16384)).toBeNull();
    const level = createDemoLevel();
    const sim = buildSim(level);
    // Right code, wrong grid: a level that was resized must not load old water.
    expect(await decodeWater(await encodeWater(sim.depth), 999)).toBeNull();
  });

  it('fingerprints terrain and springs, so an edit invalidates the water', () => {
    const level = createDemoLevel();
    const before = waterFingerprint(level);
    expect(waterFingerprint(createDemoLevel())).toBe(before);

    const sculpted = createDemoLevel();
    sculpted.terrain[4242] += 0.5;
    expect(waterFingerprint(sculpted)).not.toBe(before);

    const moved = createDemoLevel();
    moved.sources = moved.sources.map((s) => ({ ...s, rate: s.rate + 0.1 }));
    expect(waterFingerprint(moved)).not.toBe(before);
  });

  it('restores a field and gets the current moving again', () => {
    const level = createDemoLevel();
    const settled = buildSim(level);
    const sources = toSimSources(level);
    primeSim(settled, sources, { maxSeconds: 20 });
    const saved = new Float32Array(settled.depth);

    const fresh = buildSim(level);
    applySettledWater(fresh, sources, saved);

    let drift = 0;
    for (let i = 0; i < saved.length; i++) {
      drift = Math.max(drift, Math.abs(fresh.depth[i] - saved[i]));
    }
    // The river that was saved is the river you get back.
    expect(drift).toBeLessThan(0.5);

    // Only depth is stored, so the relax has to rebuild the flow the boat reads.
    let fastest = 0;
    for (let i = 0; i < fresh.vx.length; i++) {
      fastest = Math.max(fastest, Math.hypot(fresh.vx[i], fresh.vy[i]));
    }
    expect(fastest).toBeGreaterThan(0.1);
  });
});
