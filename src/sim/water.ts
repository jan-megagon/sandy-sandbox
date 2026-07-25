import { type Grid, cellCount } from './grid';

/**
 * Shallow-water simulation using the virtual-pipe model (Mei et al., "Fast
 * Hydraulic Erosion Simulation and Visualization on GPU").
 *
 * Each cell holds a column of water. Neighbouring columns are connected by
 * four virtual pipes; the pressure difference between the two water *surfaces*
 * accelerates flow through each pipe. Water is then moved according to those
 * flows. Because every cell's outflow is scaled down to at most the water it
 * actually holds, depth can never go negative and volume is conserved exactly
 * (up to float rounding) on a closed grid.
 *
 * The velocity field this produces is what both the water shader and the kayak
 * physics read, so the current the player fights is the same current you see.
 */

/**
 * Tuning constants for the water. These are the knobs most likely to want
 * adjustment after playing on a real device — see TUNING.md.
 */
export interface WaterParams {
  /** Gravity. Higher = water accelerates harder down slopes. */
  gravity: number;
  /** Virtual pipe cross-section. Scales overall flow rate; the main "speed" knob. */
  pipeArea: number;
  /**
   * Bed friction, as a fraction of flow shed per second.
   *
   * Without this the solver is energy-conserving: a lake sloshes forever and
   * water on a slope accelerates until it hits `maxVelocity`, so every river
   * runs at exactly one speed. Damping gives flow a terminal velocity set by
   * the local gradient, which is what makes steep sections read as rapids and
   * flat sections as pools.
   */
  flowDamping: number;
  /** Fraction of depth removed per second. 0 keeps volume exactly constant. */
  evaporation: number;
  /** Depth below which a cell counts as dry for gameplay and rendering. */
  minDepth: number;
  /** Hard cap on current speed (m/s), for stability and playability. */
  maxVelocity: number;
  /**
   * Depth floor used when converting flux to velocity. Without it a film of
   * water one micron deep would report an enormous velocity.
   */
  velocityDepthFloor: number;
  /** Water reaching the grid border runs off the map instead of pooling. */
  openBorder: boolean;
}

export const DEFAULT_WATER_PARAMS: WaterParams = {
  gravity: 9.81,
  pipeArea: 1.0,
  flowDamping: 1.5,
  evaporation: 0,
  minDepth: 0.02,
  // Only a safety net: on real terrain the current settles at 0.5-2 m/s under
  // friction, so this clamp catches pathological cells rather than governing
  // the river's speed.
  maxVelocity: 6,
  velocityDepthFloor: 0.15,
  openBorder: true,
};

/** A point that injects water, e.g. a spring at the head of the river. */
export interface WaterSource {
  /** Cell coordinates. */
  x: number;
  y: number;
  /** Metres of depth added per second at the centre. */
  rate: number;
  /** Radius in cells over which the injection falls off. */
  radius: number;
}

export class WaterSim {
  readonly grid: Grid;
  params: WaterParams;

  /** Ground height per cell (metres). Owned by the editor, read by the sim. */
  readonly terrain: Float32Array;
  /** Water depth above the ground per cell (metres). */
  readonly depth: Float32Array;

  /** Outflow through each virtual pipe (m^3/s), indexed by cell. */
  readonly fluxL: Float32Array;
  readonly fluxR: Float32Array;
  readonly fluxT: Float32Array;
  readonly fluxB: Float32Array;

  /** Derived velocity field (m/s). */
  readonly vx: Float32Array;
  readonly vy: Float32Array;

  /** Deepest cell seen last step, used to pick a stable substep count. */
  maxDepth = 0;

  constructor(grid: Grid, params: Partial<WaterParams> = {}) {
    this.grid = grid;
    this.params = { ...DEFAULT_WATER_PARAMS, ...params };

    const n = cellCount(grid);
    this.terrain = new Float32Array(n);
    this.depth = new Float32Array(n);
    this.fluxL = new Float32Array(n);
    this.fluxR = new Float32Array(n);
    this.fluxT = new Float32Array(n);
    this.fluxB = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
  }

  /** Total water volume in cubic metres. Used by tests and the editor HUD. */
  totalVolume(): number {
    const area = this.grid.cellSize * this.grid.cellSize;
    let sum = 0;
    for (let i = 0; i < this.depth.length; i++) sum += this.depth[i];
    return sum * area;
  }

  clearWater(): void {
    this.depth.fill(0);
    this.fluxL.fill(0);
    this.fluxR.fill(0);
    this.fluxT.fill(0);
    this.fluxB.fill(0);
    this.vx.fill(0);
    this.vy.fill(0);
    this.maxDepth = 0;
  }

  /**
   * Inject water from every source for `dt` seconds. Kept separate from
   * `step` so tests can run the solver in isolation.
   */
  applySources(sources: readonly WaterSource[], dt: number): void {
    const { width, height } = this.grid;
    for (const s of sources) {
      const r = Math.max(s.radius, 0.5);
      const x0 = Math.max(0, Math.floor(s.x - r));
      const x1 = Math.min(width - 1, Math.ceil(s.x + r));
      const y0 = Math.max(0, Math.floor(s.y - r));
      const y1 = Math.min(height - 1, Math.ceil(s.y + r));
      const r2 = r * r;

      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x + 0.5 - s.x;
          const dy = y + 0.5 - s.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > r2) continue;
          // Smooth falloff so a source doesn't produce a hard-edged column.
          const t = 1 - d2 / r2;
          this.depth[y * width + x] += s.rate * t * t * dt;
        }
      }
    }
  }

  /**
   * Number of substeps needed to stay inside the CFL limit for the current
   * water depth. A fast-moving shallow-water wave must not cross a whole cell
   * in one step or the solver oscillates and explodes.
   */
  substepsFor(dt: number): number {
    const waveSpeed = Math.sqrt(this.params.gravity * Math.max(this.maxDepth, 0.01));
    const dtMax = (0.4 * this.grid.cellSize) / Math.max(waveSpeed, 1e-3);
    return Math.min(8, Math.max(1, Math.ceil(dt / dtMax)));
  }

  /** Advance the simulation by `dt` seconds, substepping as needed. */
  step(dt: number): void {
    const n = this.substepsFor(dt);
    const sub = dt / n;
    for (let i = 0; i < n; i++) this.substep(sub);
  }

  /** One raw solver iteration. Assumes `dt` already satisfies the CFL limit. */
  substep(dt: number): void {
    this.updateFlux(dt);
    this.updateDepthAndVelocity(dt);
  }

  private updateFlux(dt: number): void {
    const { width, height, cellSize } = this.grid;
    const { gravity, pipeArea, openBorder, flowDamping } = this.params;
    const { terrain, depth, fluxL, fluxR, fluxT, fluxB } = this;

    // Acceleration coefficient for a pipe: dt * A * g / l
    const k = (dt * pipeArea * gravity) / cellSize;
    const cellArea = cellSize * cellSize;
    // Bed friction: flow retained after this step.
    const damp = flowDamping > 0 ? Math.max(0, 1 - flowDamping * dt) : 1;

    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const i = row + x;
        const d = depth[i];

        // A dry cell has nothing to push anywhere.
        if (d <= 0) {
          fluxL[i] = 0;
          fluxR[i] = 0;
          fluxT[i] = 0;
          fluxB[i] = 0;
          continue;
        }

        const h = terrain[i] + d;

        // Outside the grid the water surface is taken to be the local ground
        // height, so a border cell drains off the map at a rate set by its own
        // depth. With a closed border the pipe is simply shut.
        const hL = x > 0 ? terrain[i - 1] + depth[i - 1] : openBorder ? terrain[i] : h;
        const hR = x < width - 1 ? terrain[i + 1] + depth[i + 1] : openBorder ? terrain[i] : h;
        const hT = y > 0 ? terrain[i - width] + depth[i - width] : openBorder ? terrain[i] : h;
        const hB =
          y < height - 1 ? terrain[i + width] + depth[i + width] : openBorder ? terrain[i] : h;

        let fL = Math.max(0, fluxL[i] * damp + k * (h - hL));
        let fR = Math.max(0, fluxR[i] * damp + k * (h - hR));
        let fT = Math.max(0, fluxT[i] * damp + k * (h - hT));
        let fB = Math.max(0, fluxB[i] * damp + k * (h - hB));

        // Scale outflow down so a cell can never send away more water than it
        // holds. This is what makes the scheme unconditionally non-negative.
        const total = fL + fR + fT + fB;
        if (total > 0) {
          const available = (d * cellArea) / dt;
          if (total > available) {
            const scale = available / total;
            fL *= scale;
            fR *= scale;
            fT *= scale;
            fB *= scale;
          }
        }

        fluxL[i] = fL;
        fluxR[i] = fR;
        fluxT[i] = fT;
        fluxB[i] = fB;
      }
    }
  }

  private updateDepthAndVelocity(dt: number): void {
    const { width, height, cellSize } = this.grid;
    const { evaporation, maxVelocity, velocityDepthFloor } = this.params;
    const { depth, fluxL, fluxR, fluxT, fluxB, vx, vy } = this;

    const cellArea = cellSize * cellSize;
    const evapFactor = evaporation > 0 ? Math.max(0, 1 - evaporation * dt) : 1;
    let maxDepth = 0;

    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const i = row + x;

        // Inflow is whatever the neighbours are pushing towards this cell.
        const inL = x > 0 ? fluxR[i - 1] : 0;
        const inR = x < width - 1 ? fluxL[i + 1] : 0;
        const inT = y > 0 ? fluxB[i - width] : 0;
        const inB = y < height - 1 ? fluxT[i + width] : 0;

        const outL = fluxL[i];
        const outR = fluxR[i];
        const outT = fluxT[i];
        const outB = fluxB[i];

        const dBefore = depth[i];
        const net = inL + inR + inT + inB - (outL + outR + outT + outB);
        let dAfter = dBefore + (net * dt) / cellArea;
        if (dAfter < 0) dAfter = 0;
        if (evapFactor !== 1) dAfter *= evapFactor;
        depth[i] = dAfter;
        if (dAfter > maxDepth) maxDepth = dAfter;

        // Velocity comes from the net flow crossing the cell, averaged over the
        // step, divided by the cross-section that flow passes through.
        const dWx = (inL - outL + outR - inR) * 0.5;
        const dWy = (inT - outT + outB - inB) * 0.5;
        const dBar = Math.max((dBefore + dAfter) * 0.5, velocityDepthFloor);
        const denom = cellSize * dBar;

        let u = dWx / denom;
        let v = dWy / denom;

        const speed = Math.hypot(u, v);
        if (speed > maxVelocity) {
          const s = maxVelocity / speed;
          u *= s;
          v *= s;
        }

        vx[i] = u;
        vy[i] = v;
      }
    }

    this.maxDepth = maxDepth;
  }
}
