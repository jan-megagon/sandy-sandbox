import {
  type Level,
  decodeLevel,
  decodeWater,
  encodeLevel,
  encodeWater,
  isPlayable,
  waterFingerprint,
} from './sim/level';

/**
 * Level persistence in localStorage.
 *
 * Levels are stored as their share codes, so saving and sharing use exactly
 * the same bytes and there is only one format to keep working. An index entry
 * per level keeps the level-select screen fast - listing never has to inflate
 * and decode every level just to show a name.
 */

const INDEX_KEY = 'river.index.v1';
const LEVEL_PREFIX = 'river.level.v1.';
const BEST_KEY = 'river.best.v1';
const WATER_PREFIX = 'river.water.v1.';

export interface LevelSummary {
  id: string;
  name: string;
  updatedAt: number;
  playable: boolean;
  /** Best completion time in milliseconds, if the level has ever been beaten. */
  bestMs?: number;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    // Quota is the realistic failure here, and it must not take down the editor.
    console.warn('Could not write to local storage', err);
  }
}

function readIndex(): LevelSummary[] {
  const list = readJson<LevelSummary[]>(INDEX_KEY, []);
  return Array.isArray(list) ? list : [];
}

export function listLevels(): LevelSummary[] {
  const best = readJson<Record<string, number>>(BEST_KEY, {});
  return readIndex()
    .map((entry) => ({ ...entry, bestMs: best[entry.id] }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function hasLevel(id: string): boolean {
  return localStorage.getItem(LEVEL_PREFIX + id) !== null;
}

export async function saveLevel(level: Level): Promise<void> {
  const code = await encodeLevel(level);
  try {
    localStorage.setItem(LEVEL_PREFIX + level.id, code);
  } catch (err) {
    throw new Error(
      'Could not save: browser storage is full. Delete a level and try again.',
      { cause: err },
    );
  }

  const index = readIndex().filter((e) => e.id !== level.id);
  index.push({
    id: level.id,
    name: level.name,
    updatedAt: level.updatedAt,
    playable: isPlayable(level),
  });
  writeJson(INDEX_KEY, index);
}

export async function loadLevel(id: string): Promise<Level | null> {
  const code = localStorage.getItem(LEVEL_PREFIX + id);
  if (!code) return null;
  try {
    return await decodeLevel(code);
  } catch (err) {
    console.warn(`Stored level ${id} could not be read`, err);
    return null;
  }
}

export function deleteLevel(id: string): void {
  localStorage.removeItem(LEVEL_PREFIX + id);
  clearSettledWater(id);
  writeJson(
    INDEX_KEY,
    readIndex().filter((e) => e.id !== id),
  );
}

// --- settled water ---------------------------------------------------------
//
// Filling a river costs seconds of solver; storing the result costs a few KB.
// This is a cache, so every path through it treats a miss as normal and never
// as an error - the fallback is priming the level, which is what the app did
// before this existed.

interface WaterEntry {
  /** Terrain and springs the field was settled for. */
  fp: string;
  /** Deflated, base64url depth field. */
  data: string;
}

/** Remember a settled river so opening this level again doesn't re-run it. */
export async function saveSettledWater(level: Level, depth: Float32Array): Promise<void> {
  try {
    const entry: WaterEntry = {
      fp: waterFingerprint(level),
      data: await encodeWater(depth),
    };
    writeJson(WATER_PREFIX + level.id, entry);
  } catch (err) {
    // A full quota is the likely cause, and a level that opens slowly is a
    // much smaller problem than one that won't open.
    console.warn(`Settled water for ${level.id} could not be stored`, err);
  }
}

/** The settled river for this level, or null if there isn't a usable one. */
export async function loadSettledWater(level: Level): Promise<Float32Array | null> {
  const entry = readJson<WaterEntry | null>(WATER_PREFIX + level.id, null);
  if (!entry || entry.fp !== waterFingerprint(level)) return null;
  return decodeWater(entry.data, level.width * level.height);
}

export function clearSettledWater(id: string): void {
  localStorage.removeItem(WATER_PREFIX + id);
}

export function getBestTime(id: string): number | undefined {
  return readJson<Record<string, number>>(BEST_KEY, {})[id];
}

/** Record a completion time, keeping it only if it beats the existing best. */
export function recordTime(id: string, ms: number): boolean {
  const best = readJson<Record<string, number>>(BEST_KEY, {});
  if (best[id] !== undefined && best[id] <= ms) return false;
  best[id] = ms;
  writeJson(BEST_KEY, best);
  return true;
}
