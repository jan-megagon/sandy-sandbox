import { type Grid, makeGrid } from './grid';
import { TERRAIN_MAX, generateDefaultTerrain } from './terrain';
import { type WaterSource, WaterSim } from './water';

/**
 * Level data model and its wire format.
 *
 * All positions and radii in a Level are in world metres, not cells, so the
 * editor can place things at sub-cell precision and levels stay meaningful if
 * the grid resolution ever changes. The one exception is inside the solver,
 * which works in cells; `buildSim` does the conversion.
 */

export const LEVEL_VERSION = 1;

export const MAX_GRID_DIM = 512;
export const MAX_ENTITIES = 512;

export interface LevelSource {
  /** World metres. */
  x: number;
  y: number;
  /** Depth added per second at the centre, in metres. */
  rate: number;
  /** World metres. */
  radius: number;
}

export interface LevelStart {
  x: number;
  y: number;
  /** Radians; 0 points along +x. */
  heading: number;
}

export interface LevelGoal {
  x: number;
  y: number;
  radius: number;
}

export interface LevelObstacle {
  x: number;
  y: number;
  radius: number;
}

export interface Level {
  version: number;
  id: string;
  name: string;
  width: number;
  height: number;
  cellSize: number;
  terrain: Float32Array;
  sources: LevelSource[];
  start: LevelStart | null;
  goal: LevelGoal | null;
  obstacles: LevelObstacle[];
  createdAt: number;
  updatedAt: number;
}

export function levelGrid(level: Level): Grid {
  return makeGrid(level.width, level.height, level.cellSize);
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function createLevel(name = 'Untitled', width = 128, height = 128, cellSize = 2): Level {
  const grid = makeGrid(width, height, cellSize);
  const now = Date.now();
  return {
    version: LEVEL_VERSION,
    id: newId(),
    name,
    width,
    height,
    cellSize,
    terrain: generateDefaultTerrain(grid),
    sources: [],
    start: null,
    goal: null,
    obstacles: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function cloneLevel(level: Level): Level {
  return {
    ...level,
    terrain: new Float32Array(level.terrain),
    sources: level.sources.map((s) => ({ ...s })),
    start: level.start ? { ...level.start } : null,
    goal: level.goal ? { ...level.goal } : null,
    obstacles: level.obstacles.map((o) => ({ ...o })),
  };
}

/** A level can only be played once it has somewhere to start and somewhere to go. */
export function isPlayable(level: Level): boolean {
  return level.start !== null && level.goal !== null;
}

/** Convert a level's world-space sources into the cell-space the solver wants. */
export function toSimSources(level: Level): WaterSource[] {
  return level.sources.map((s) => ({
    x: s.x / level.cellSize,
    y: s.y / level.cellSize,
    rate: s.rate,
    radius: Math.max(s.radius / level.cellSize, 0.5),
  }));
}

/** Build a simulation seeded with this level's terrain. */
export function buildSim(level: Level): WaterSim {
  const sim = new WaterSim(levelGrid(level));
  sim.terrain.set(level.terrain);
  return sim;
}

/** Eight-neighbour offsets, so the traced channel can run diagonally. */
const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];

/**
 * Lay water down the path it would eventually take, by walking downhill from
 * each source.
 *
 * Simulating a river into existence is honest but far too slow to load a
 * level on: water advances roughly as fast as it flows, so filling a 256 m
 * valley takes over three minutes of simulated time. Tracing the descent gets
 * the same channel wet in a single pass over the path, after which a few
 * seconds of solver is enough to turn it into a moving river.
 *
 * Pits are handled the way water handles them - fill until it spills, then
 * carry on from the low point of the rim - so this works on whatever the
 * player has sculpted, not just on generated valleys.
 */
export function primeByDescent(
  sim: WaterSim,
  sources: readonly WaterSource[],
  targetDepth = 0.7,
): void {
  const { width, height } = sim.grid;
  const { terrain, depth } = sim;
  const surfaceAt = (i: number): number => terrain[i] + depth[i];

  // Wet a small disc so the channel has some width from the outset.
  const wet = (cx: number, cy: number, radius: number): void => {
    const r = Math.ceil(radius);
    for (let y = Math.max(0, cy - r); y <= Math.min(height - 1, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(width - 1, cx + r); x++) {
        const dx = x - cx;
        const dy = y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > radius * radius) continue;
        const i = y * width + x;
        // Fill towards the local low point rather than stacking a slab on a
        // slope, so a wide brush stroke doesn't leave water clinging to banks.
        const fill = targetDepth * (1 - Math.sqrt(d2) / (radius + 1));
        if (depth[i] < fill) depth[i] = fill;
      }
    }
  };

  for (const source of sources) {
    let x = Math.min(width - 1, Math.max(0, Math.round(source.x)));
    let y = Math.min(height - 1, Math.max(0, Math.round(source.y)));
    const maxSteps = (width + height) * 4;

    for (let step = 0; step < maxSteps; step++) {
      const i = y * width + x;
      wet(x, y, Math.max(1.5, Math.min(source.radius, 4)));

      let downX = -1;
      let downY = -1;
      let downSurface = surfaceAt(i);
      let rimX = -1;
      let rimY = -1;
      let rimSurface = Infinity;
      let atEdge = false;

      for (const [dx, dy] of NEIGHBOURS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
          atEdge = true;
          continue;
        }
        const ns = surfaceAt(ny * width + nx);
        if (ns < rimSurface) {
          rimSurface = ns;
          rimX = nx;
          rimY = ny;
        }
        if (ns < downSurface) {
          downSurface = ns;
          downX = nx;
          downY = ny;
        }
      }

      // Running off the map is the outlet - the river has found its mouth.
      if (atEdge) break;

      if (downX >= 0) {
        x = downX;
        y = downY;
        continue;
      }

      // Nowhere lower: this is a pit. Raise the water until it tops the lowest
      // point of the rim, then continue from there.
      if (rimX < 0) break;
      depth[i] = Math.max(depth[i], rimSurface - terrain[i] + 0.02);
      x = rimX;
      y = rimY;
    }
  }
}

/**
 * Get the river running, so play mode starts on flowing water rather than a
 * dry bed: trace the channel, then let the solver settle it into real flow.
 */
export function primeSim(sim: WaterSim, sources: readonly WaterSource[], seconds = 10): void {
  primeByDescent(sim, sources);
  const dt = 1 / 60;
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    sim.applySources(sources, dt);
    sim.step(dt);
  }
}

// ---------------------------------------------------------------------------
// Wire format
//
// [ "RVR1" | u32 jsonLength | utf8 JSON metadata | predicted terrain varints ]
//
// compressed with deflate-raw and base64url encoded.
//
// Terrain quantises to 12 bits over the fixed 0..TERRAIN_MAX range - about
// 1 cm of vertical precision, finer than the sim's minimum water depth - then
// goes through a gradient predictor (left + up - upleft, as used by PNG) and
// zigzag varints. A heightmap is smooth in both axes, so predicting each
// sample from its neighbours leaves near-zero residuals for deflate to pack.
// Measured on a 128x128 level: 37 KB raw u16, 21 KB with row deltas alone,
// 15 KB with the 2D predictor, and under 6 KB once a level has been sculpted.
// ---------------------------------------------------------------------------

const MAGIC = 'RVR1';
const TERRAIN_BITS = 12;
const TERRAIN_LEVELS = (1 << TERRAIN_BITS) - 1;

interface LevelMeta {
  version: number;
  id: string;
  name: string;
  width: number;
  height: number;
  cellSize: number;
  sources: LevelSource[];
  start: LevelStart | null;
  goal: LevelGoal | null;
  obstacles: LevelObstacle[];
  createdAt: number;
  updatedAt: number;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Predict each sample from its already-decoded neighbours and emit only the
 * error, as a zigzag varint. On smooth terrain most residuals are 0 or +/-1
 * and pack into a single byte.
 */
function encodeTerrain(
  terrain: Float32Array,
  width: number,
  height: number,
): Uint8Array<ArrayBuffer> {
  const scale = TERRAIN_LEVELS / TERRAIN_MAX;
  const q = new Int32Array(width * height);
  for (let i = 0; i < q.length; i++) {
    q[i] = Math.round(Math.min(TERRAIN_MAX, Math.max(0, terrain[i])) * scale);
  }

  // Worst case for a varint of a 12-bit residual is 3 bytes.
  const out = new Uint8Array(q.length * 3);
  let n = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const left = x > 0 ? q[i - 1] : 0;
      const up = y > 0 ? q[i - width] : 0;
      const upLeft = x > 0 && y > 0 ? q[i - width - 1] : 0;
      const residual = q[i] - (left + up - upLeft);

      let zig = (residual << 1) ^ (residual >> 31);
      while (zig >= 0x80) {
        out[n++] = (zig & 0x7f) | 0x80;
        zig >>>= 7;
      }
      out[n++] = zig;
    }
  }
  return out.subarray(0, n);
}

function decodeTerrain(
  bytes: Uint8Array<ArrayBuffer>,
  width: number,
  height: number,
): Float32Array {
  const cells = width * height;
  const q = new Int32Array(cells);
  const inv = TERRAIN_MAX / TERRAIN_LEVELS;
  const terrain = new Float32Array(cells);

  let p = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let zig = 0;
      let shift = 0;
      for (;;) {
        if (p >= bytes.length) fail('terrain block truncated');
        const b = bytes[p++];
        zig |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
        if (shift > 28) fail('malformed terrain varint');
      }
      const residual = (zig >>> 1) ^ -(zig & 1);

      const i = y * width + x;
      const left = x > 0 ? q[i - 1] : 0;
      const up = y > 0 ? q[i - width] : 0;
      const upLeft = x > 0 && y > 0 ? q[i - width - 1] : 0;
      const value = residual + (left + up - upLeft);

      // A hostile code could predict its way outside the valid range.
      q[i] = value < 0 ? 0 : value > TERRAIN_LEVELS ? TERRAIN_LEVELS : value;
      terrain[i] = q[i] * inv;
    }
  }
  if (p !== bytes.length) fail('trailing bytes after terrain block');
  return terrain;
}

async function deflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Encode a level to a compact, URL-safe share code. */
export async function encodeLevel(level: Level): Promise<string> {
  const meta: LevelMeta = {
    version: LEVEL_VERSION,
    id: level.id,
    name: level.name,
    width: level.width,
    height: level.height,
    cellSize: level.cellSize,
    sources: level.sources,
    start: level.start,
    goal: level.goal,
    obstacles: level.obstacles,
    createdAt: level.createdAt,
    updatedAt: level.updatedAt,
  };

  const json = new TextEncoder().encode(JSON.stringify(meta));
  const terrainBytes = encodeTerrain(level.terrain, level.width, level.height);

  const payload = new Uint8Array(8 + json.length + terrainBytes.length);
  const view = new DataView(payload.buffer);
  for (let i = 0; i < 4; i++) payload[i] = MAGIC.charCodeAt(i);
  view.setUint32(4, json.length, true);
  payload.set(json, 8);
  payload.set(terrainBytes, 8 + json.length);

  return toBase64Url(await deflate(payload));
}

function fail(reason: string): never {
  throw new Error(`Invalid level: ${reason}`);
}

function finite(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${name} is not a finite number`);
  return v;
}

function sanitiseEntities<T extends { x: number; y: number; radius: number }>(
  raw: unknown,
  name: string,
  extra?: (item: Record<string, unknown>) => Record<string, number>,
): T[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail(`${name} is not an array`);
  if (raw.length > MAX_ENTITIES) fail(`too many ${name}`);
  return raw.map((item) => {
    if (typeof item !== 'object' || item === null) fail(`${name} entry is not an object`);
    const o = item as Record<string, unknown>;
    return {
      x: finite(o.x, `${name}.x`),
      y: finite(o.y, `${name}.y`),
      radius: Math.max(0.1, finite(o.radius, `${name}.radius`)),
      ...(extra ? extra(o) : {}),
    } as T;
  });
}

/**
 * Decode a share code back into a Level.
 *
 * Share codes arrive from other people, so everything here is treated as
 * untrusted: dimensions are bounded, every number is checked for finiteness,
 * and the terrain block must be exactly the length the header claims.
 */
export async function decodeLevel(code: string): Promise<Level> {
  let payload: Uint8Array<ArrayBuffer>;
  try {
    payload = await inflate(fromBase64Url(code.trim()));
  } catch {
    fail('not a readable share code');
  }

  if (payload.length < 8) fail('truncated');
  if (String.fromCharCode(...payload.subarray(0, 4)) !== MAGIC) fail('bad magic');

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const jsonLength = view.getUint32(4, true);
  if (jsonLength > payload.length - 8) fail('header length out of range');

  let meta: LevelMeta;
  try {
    meta = JSON.parse(new TextDecoder().decode(payload.subarray(8, 8 + jsonLength)));
  } catch {
    fail('unreadable header');
  }

  if (meta.version !== LEVEL_VERSION) fail(`unsupported version ${meta.version}`);

  const width = finite(meta.width, 'width');
  const height = finite(meta.height, 'height');
  const cellSize = finite(meta.cellSize, 'cellSize');
  if (!Number.isInteger(width) || width < 8 || width > MAX_GRID_DIM) fail('width out of range');
  if (!Number.isInteger(height) || height < 8 || height > MAX_GRID_DIM) fail('height out of range');
  if (cellSize <= 0 || cellSize > 32) fail('cellSize out of range');

  const terrain = decodeTerrain(payload.subarray(8 + jsonLength), width, height);

  const sources = sanitiseEntities<LevelSource>(meta.sources, 'sources', (o) => ({
    rate: Math.max(0, Math.min(50, finite(o.rate, 'sources.rate'))),
  }));

  let start: LevelStart | null = null;
  if (meta.start) {
    start = {
      x: finite(meta.start.x, 'start.x'),
      y: finite(meta.start.y, 'start.y'),
      heading: finite(meta.start.heading, 'start.heading'),
    };
  }

  let goal: LevelGoal | null = null;
  if (meta.goal) {
    goal = {
      x: finite(meta.goal.x, 'goal.x'),
      y: finite(meta.goal.y, 'goal.y'),
      radius: Math.max(0.5, finite(meta.goal.radius, 'goal.radius')),
    };
  }

  const obstacles = sanitiseEntities<LevelObstacle>(meta.obstacles, 'obstacles');

  return {
    version: LEVEL_VERSION,
    id: typeof meta.id === 'string' && meta.id ? meta.id.slice(0, 64) : newId(),
    name: typeof meta.name === 'string' ? meta.name.slice(0, 64) : 'Shared level',
    width,
    height,
    cellSize,
    terrain,
    sources,
    start,
    goal,
    obstacles,
    createdAt: typeof meta.createdAt === 'number' ? meta.createdAt : Date.now(),
    updatedAt: typeof meta.updatedAt === 'number' ? meta.updatedAt : Date.now(),
  };
}
