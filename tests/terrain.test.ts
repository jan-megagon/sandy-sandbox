import { describe, expect, it } from 'vitest';
import { makeGrid } from '../src/sim/grid';
import { TERRAIN_MAX, TERRAIN_MIN, generateFractalTerrain } from '../src/sim/terrain';

const GRID = makeGrid(64, 64, 2);

function rowMean(t: Float32Array, y: number, width: number): number {
  let sum = 0;
  for (let x = 0; x < width; x++) sum += t[y * width + x];
  return sum / width;
}

describe('generateFractalTerrain', () => {
  it('stays inside the range the format can store', () => {
    const t = generateFractalTerrain(GRID, { seed: 7, relief: 36, fall: 30 });
    for (let i = 0; i < t.length; i++) {
      expect(t[i]).toBeGreaterThanOrEqual(TERRAIN_MIN);
      expect(t[i]).toBeLessThanOrEqual(TERRAIN_MAX);
    }
  });

  it('is reproducible from its seed, and different between seeds', () => {
    const a = generateFractalTerrain(GRID, { seed: 42 });
    const b = generateFractalTerrain(GRID, { seed: 42 });
    const c = generateFractalTerrain(GRID, { seed: 43 });
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(c));
  });

  it('tilts downhill, so water has somewhere to go', () => {
    const t = generateFractalTerrain(GRID, { seed: 3, relief: 12, fall: 14 });
    // Averaged across the map the head has to sit above the mouth, whatever the
    // noise is doing locally - otherwise a generated level is a swamp.
    expect(rowMean(t, 2, GRID.width)).toBeGreaterThan(rowMean(t, GRID.height - 3, GRID.width));
  });

  it('actually varies - relief of zero is flat, relief turns it up', () => {
    const flat = generateFractalTerrain(GRID, { seed: 5, relief: 0, fall: 0 });
    expect(Math.max(...flat)).toBeCloseTo(Math.min(...flat), 6);

    const rough = generateFractalTerrain(GRID, { seed: 5, relief: 20, fall: 0 });
    expect(Math.max(...rough) - Math.min(...rough)).toBeGreaterThan(4);
  });

  it('makes bigger features at a bigger scale', () => {
    /** Mean absolute difference between neighbours: high means fine detail. */
    const roughness = (t: Float32Array): number => {
      let sum = 0;
      let n = 0;
      for (let y = 0; y < GRID.height; y++) {
        for (let x = 1; x < GRID.width; x++) {
          sum += Math.abs(t[y * GRID.width + x] - t[y * GRID.width + x - 1]);
          n++;
        }
      }
      return sum / n;
    };

    const fine = generateFractalTerrain(GRID, { seed: 9, scale: 0.08, fall: 0 });
    const broad = generateFractalTerrain(GRID, { seed: 9, scale: 0.8, fall: 0 });
    expect(roughness(broad)).toBeLessThan(roughness(fine));
  });
});
