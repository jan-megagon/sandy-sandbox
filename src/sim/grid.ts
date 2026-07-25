/**
 * Grid geometry shared by the terrain heightmap and the water simulation.
 *
 * World space is metres. Cell (i, j) covers the square
 * [i*cellSize, (i+1)*cellSize) x [j*cellSize, (j+1)*cellSize) and its centre
 * sits at ((i + 0.5) * cellSize, (j + 0.5) * cellSize).
 */
export interface Grid {
  readonly width: number;
  readonly height: number;
  readonly cellSize: number;
}

export function makeGrid(width: number, height: number, cellSize: number): Grid {
  return { width, height, cellSize };
}

export function cellCount(g: Grid): number {
  return g.width * g.height;
}

export function worldWidth(g: Grid): number {
  return g.width * g.cellSize;
}

export function worldHeight(g: Grid): number {
  return g.height * g.cellSize;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Nearest cell containing a world position, clamped to the grid. */
export function worldToCell(g: Grid, wx: number, wy: number): { x: number; y: number } {
  return {
    x: clamp(Math.floor(wx / g.cellSize), 0, g.width - 1),
    y: clamp(Math.floor(wy / g.cellSize), 0, g.height - 1),
  };
}

/**
 * Bilinear sample of a cell-centred field at a world position. Positions
 * outside the grid clamp to the edge rather than wrapping, so the kayak
 * never reads garbage when it drifts against a bank.
 */
export function sampleBilinear(field: Float32Array, g: Grid, wx: number, wy: number): number {
  const fx = wx / g.cellSize - 0.5;
  const fy = wy / g.cellSize - 0.5;

  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;

  const x0c = clamp(x0, 0, g.width - 1);
  const x1c = clamp(x0 + 1, 0, g.width - 1);
  const y0c = clamp(y0, 0, g.height - 1);
  const y1c = clamp(y0 + 1, 0, g.height - 1);

  const row0 = y0c * g.width;
  const row1 = y1c * g.width;

  const a = field[row0 + x0c];
  const b = field[row0 + x1c];
  const c = field[row1 + x0c];
  const d = field[row1 + x1c];

  const top = a + (b - a) * tx;
  const bottom = c + (d - c) * tx;
  return top + (bottom - top) * ty;
}
