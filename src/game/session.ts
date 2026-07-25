import { type Level, buildSim, levelGrid, primeSim, toSimSources } from '../sim/level';
import type { Grid } from '../sim/grid';
import type { WaterSim } from '../sim/water';
import { Kayak, type PaddleSide } from './kayak';

/**
 * One attempt at a level: owns the water, the boat, the clock and the rules.
 *
 * The simulation keeps running while the run is over so the river doesn't
 * freeze behind the results panel.
 */

export type RunState = 'running' | 'won' | 'capsized';

export interface SessionEvents {
  /** Impact speed of the worst collision this frame, 0 if none. */
  impact: number;
  /** True on the frame the run was won. */
  won: boolean;
  /** True on the frame the boat capsized. */
  capsized: boolean;
}

const NO_EVENTS: SessionEvents = { impact: 0, won: false, capsized: false };

export class Session {
  readonly level: Level;
  readonly grid: Grid;
  readonly sim: WaterSim;
  readonly kayak: Kayak;

  state: RunState = 'running';
  /** Elapsed run time in milliseconds. */
  elapsedMs = 0;

  private sources;

  constructor(level: Level) {
    this.level = level;
    this.grid = levelGrid(level);
    this.sim = buildSim(level);
    this.sources = toSimSources(level);
    this.kayak = new Kayak();

    // Fill the riverbed before the player takes control, so a run starts on a
    // flowing river rather than watching the water arrive.
    primeSim(this.sim, this.sources);
    this.resetBoat();
  }

  private resetBoat(): void {
    const start = this.level.start;
    if (start) {
      this.kayak.reset(start.x, start.y, start.heading);
    } else {
      this.kayak.reset(
        (this.grid.width * this.grid.cellSize) / 2,
        (this.grid.height * this.grid.cellSize) / 2,
        Math.PI / 2,
      );
    }
  }

  /** Start again on the same level without re-priming the water. */
  restart(): void {
    this.state = 'running';
    this.elapsedMs = 0;
    this.resetBoat();
  }

  stroke(side: PaddleSide): void {
    if (this.state === 'running') this.kayak.stroke(side);
  }

  setBrace(side: PaddleSide, active: boolean): void {
    if (this.state === 'running' || !active) this.kayak.setBrace(side, active);
  }

  get health(): number {
    return this.kayak.health;
  }

  /** Distance to the goal in metres, or null if the level has no goal. */
  distanceToGoal(): number | null {
    const goal = this.level.goal;
    if (!goal) return null;
    return Math.hypot(this.kayak.x - goal.x, this.kayak.y - goal.y);
  }

  update(dt: number): SessionEvents {
    this.sim.applySources(this.sources, dt);
    this.sim.step(dt);

    if (this.state !== 'running') {
      // Keep the river alive under the results panel, but stop the boat.
      this.kayak.setBrace('left', false);
      this.kayak.setBrace('right', false);
      this.kayak.update(dt, this.sim, this.level.obstacles, this.grid);
      return NO_EVENTS;
    }

    this.elapsedMs += dt * 1000;
    const events = this.kayak.update(dt, this.sim, this.level.obstacles, this.grid);

    let won = false;
    let capsized = false;

    const goal = this.level.goal;
    if (goal) {
      const dist = Math.hypot(this.kayak.x - goal.x, this.kayak.y - goal.y);
      if (dist <= goal.radius) {
        this.state = 'won';
        won = true;
      }
    }

    if (!won && this.kayak.health <= 0) {
      this.state = 'capsized';
      capsized = true;
    }

    return { impact: events.impactSpeed, won, capsized };
  }
}

export function formatTime(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;
  return `${minutes}:${seconds.toFixed(2).padStart(5, '0')}`;
}
