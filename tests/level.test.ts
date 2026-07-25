import { describe, expect, it } from 'vitest';
import { createLevel, decodeLevel, encodeLevel, isPlayable, toSimSources } from '../src/sim/level';

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
