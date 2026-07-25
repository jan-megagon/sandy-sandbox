import { type Grid, clamp } from './grid';

export type BrushMode = 'raise' | 'lower' | 'smooth';

/** Region of the heightmap a brush stroke touched, for partial texture upload. */
export interface DirtyRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const TERRAIN_MIN = 0;
export const TERRAIN_MAX = 40;

/**
 * Apply one brush dab to the heightmap.
 *
 * `cx`/`cy` are in cell coordinates, `radius` in cells, `strength` in metres
 * per dab at the centre. Falloff is a squared cosine-ish curve so repeated
 * dabs build up a smooth mound rather than a cone with a visible rim.
 *
 * Returns the affected rect, or null if the dab fell entirely off the grid.
 */
export function applyBrush(
  terrain: Float32Array,
  g: Grid,
  cx: number,
  cy: number,
  radius: number,
  strength: number,
  mode: BrushMode,
): DirtyRect | null {
  const r = Math.max(radius, 0.5);
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(g.width - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(g.height - 1, Math.ceil(cy + r));
  if (x1 < x0 || y1 < y0) return null;

  const r2 = r * r;

  if (mode === 'smooth') {
    // Smoothing has to read the pre-stroke heights, so work from a snapshot of
    // the affected region plus a one-cell apron.
    const sx0 = Math.max(0, x0 - 1);
    const sy0 = Math.max(0, y0 - 1);
    const sx1 = Math.min(g.width - 1, x1 + 1);
    const sy1 = Math.min(g.height - 1, y1 + 1);
    const sw = sx1 - sx0 + 1;
    const snapshot = new Float32Array(sw * (sy1 - sy0 + 1));
    for (let y = sy0; y <= sy1; y++) {
      for (let x = sx0; x <= sx1; x++) {
        snapshot[(y - sy0) * sw + (x - sx0)] = terrain[y * g.width + x];
      }
    }
    const at = (x: number, y: number): number => {
      const cxx = clamp(x, sx0, sx1);
      const cyy = clamp(y, sy0, sy1);
      return snapshot[(cyy - sy0) * sw + (cxx - sx0)];
    };

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const t = 1 - d2 / r2;
        const w = t * t * Math.min(1, Math.abs(strength));
        const avg =
          (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1) + at(x, y) * 4) / 8;
        const i = y * g.width + x;
        terrain[i] += (avg - terrain[i]) * w;
      }
    }
  } else {
    const sign = mode === 'raise' ? 1 : -1;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const t = 1 - d2 / r2;
        const i = y * g.width + x;
        terrain[i] = clamp(terrain[i] + sign * strength * t * t, TERRAIN_MIN, TERRAIN_MAX);
      }
    }
  }

  return { x0, y0, x1, y1 };
}

export function unionRect(a: DirtyRect | null, b: DirtyRect | null): DirtyRect | null {
  if (!a) return b;
  if (!b) return a;
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

/** Deterministic value noise, so generated terrain is reproducible. */
function hash2(x: number, y: number, seed: number): number {
  let h = x * 374761393 + y * 668265263 + seed * 2147483647;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return (h ^ (h >>> 16)) / 4294967296;
}

function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const tx = x - xi;
  const ty = y - yi;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

function fbm(x: number, y: number, seed: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x * freq, y * freq, seed + o * 17) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/**
 * Where the default valley's channel runs, as a fraction of the map width, for
 * a position `v` (0 at the head, 1 at the mouth) down the valley.
 *
 * Exported so anything placing objects on the river - the bundled demo level,
 * for instance - can find the water without having to search the heightmap.
 */
export function defaultChannelCentre(v: number): number {
  return 0.5 + 0.22 * Math.sin(v * Math.PI * 2.2) + 0.08 * Math.sin(v * Math.PI * 5.1);
}

/**
 * Terrain for a brand-new level: a noisy valley draining from the top of the
 * map to the bottom, with a meandering channel already cut into it. A blank
 * flat plane would be a miserable starting point — this gives the player a
 * river that already flows, to sculpt from.
 */
export function generateDefaultTerrain(g: Grid, seed = 1337): Float32Array {
  const t = new Float32Array(g.width * g.height);
  const { width, height } = g;

  for (let y = 0; y < height; y++) {
    const v = y / (height - 1);
    // Overall drop from head to mouth.
    const fall = 20 * (1 - v);

    // Channel centre wanders left and right as it descends.
    const channelX = defaultChannelCentre(v) * (width - 1);

    // The riverbed is an explicit, strictly decreasing function of distance
    // down the valley, and the channel blends *to* it rather than being
    // subtracted from noisy ground.
    //
    // Two things matter here, and both were learned the hard way. The bed must
    // be monotonic, because noise big enough to make hillsides interesting
    // (metres) dwarfs the bed's fall between adjacent cells (~0.16 m), so
    // notching a channel out of noisy terrain leaves a chain of disconnected
    // basins and the water never reaches the far end. And the noise must be
    // damped down near the river, or water wandering a few cells off centre
    // drops into a pit and pools there instead of running downhill.
    const bed = fall - 1.2;

    for (let x = 0; x < width; x++) {
      // Distance from the channel, in units of roughly half the channel width.
      const dx = (x - channelX) / (width * 0.06);
      const inChannel = Math.exp(-dx * dx);
      // A wider, gentler skirt over which the terrain settles down to a
      // floodplain, so the banks are calm and drain back towards the water.
      const floodplain = Math.exp(-(dx * dx) / 16);

      const noiseAmp = 4 * (1 - 0.9 * floodplain);
      const n = (fbm(x / 22, y / 22, seed) * 0.8 + fbm(x / 7, y / 7, seed + 99) * 0.2) * noiseAmp;

      // Valley walls rise away from the channel.
      const dist = Math.abs(x - channelX) / (width * 0.5);
      const walls = 24 * dist * dist;
      const ground = fall + 2.5 + walls + n;

      t[y * width + x] = clamp(ground + (bed - ground) * inChannel, TERRAIN_MIN, TERRAIN_MAX);
    }
  }
  return t;
}
