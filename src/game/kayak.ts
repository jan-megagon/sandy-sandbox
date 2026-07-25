import { type Grid, sampleBilinear } from '../sim/grid';
import type { WaterSim } from '../sim/water';

/**
 * Kayak rigid body.
 *
 * The boat is a 2D body with position, heading, linear and angular velocity.
 * Everything interesting comes out of one idea: drag against the water is
 * strongly anisotropic. A hull slips forward easily and resists sideways
 * motion hard, which is why a kayak tracks straight, carves when turned, and
 * gets carried bodily downstream by a current it is not aligned with.
 */

/**
 * Handling constants. These are the knobs most likely to want adjustment after
 * playing on a real device - see TUNING.md.
 */
export interface KayakParams {
  mass: number;
  /** Rotational inertia. Higher = slower to start and stop turning. */
  inertia: number;
  /** Drag along the hull's long axis (low - the boat glides). */
  dragForward: number;
  /** Drag across the hull (high - the boat refuses to slide sideways). */
  dragLateral: number;
  /** Resistance to spinning. */
  dragAngular: number;
  /** Forward impulse from one paddle stroke (N*s). */
  strokeImpulse: number;
  /** How far off the centreline a stroke is planted (m). Sets stroke turn rate. */
  strokeOffset: number;
  /** Extra drag on the braced side while a paddle is planted. */
  braceDrag: number;
  /** Turning torque while bracing (N*m). */
  braceTorque: number;
  /** Seconds between strokes on the same side. */
  strokeCooldown: number;
  /** Hull draft (m). Shallower water than this and the boat grounds out. */
  draft: number;
  /** Collision radius (m). */
  radius: number;
  /** Friction applied when grounded. */
  groundFriction: number;
  /** Bounce factor off rocks and banks. */
  restitution: number;
  /** Impact speed (m/s) below which a collision does no damage. */
  damageThreshold: number;
  /** Damage per m/s of impact above the threshold. */
  damagePerSpeed: number;
}

/**
 * Tuned against measured targets rather than by eye: a stroke gives a 0.55 m/s
 * kick and about 10 degrees of yaw, sustained paddling cruises at 2.75 m/s,
 * the boat couples to a current with a ~1.7 s time constant (so the river
 * grabs you rather than politely suggesting a direction), a held brace pivots
 * at roughly 65 deg/s, and twenty alternating strokes drift about 4 degrees
 * off straight.
 */
export const DEFAULT_KAYAK_PARAMS: KayakParams = {
  mass: 100,
  inertia: 110,
  dragForward: 60,
  dragLateral: 480,
  dragAngular: 130,
  strokeImpulse: 55,
  strokeOffset: 0.42,
  braceDrag: 280,
  braceTorque: 170,
  strokeCooldown: 0.28,
  draft: 0.12,
  radius: 0.85,
  groundFriction: 5.5,
  restitution: 0.35,
  damageThreshold: 1.6,
  damagePerSpeed: 16,
};

export type PaddleSide = 'left' | 'right';

export interface Obstacle {
  x: number;
  y: number;
  radius: number;
}

/** Something that happened this step and the presentation layer may want to react to. */
export interface KayakEvents {
  /** Impact speed of a collision this step, or 0. */
  impactSpeed: number;
  /** Damage dealt this step. */
  damage: number;
  /** True while the hull is dragging on the riverbed. */
  grounded: boolean;
}

export class Kayak {
  params: KayakParams;

  x = 0;
  y = 0;
  /** Radians; 0 points along +x. */
  heading = 0;

  vx = 0;
  vy = 0;
  angularVelocity = 0;

  health = 100;

  /** Seconds until each side can stroke again. */
  private cooldown: Record<PaddleSide, number> = { left: 0, right: 0 };
  /** Sides currently held down as a brace. */
  private bracing: Record<PaddleSide, boolean> = { left: false, right: false };

  /** Set for one step after a stroke, so the renderer can animate the paddle. */
  strokeFlash: Record<PaddleSide, number> = { left: 0, right: 0 };

  constructor(params: Partial<KayakParams> = {}) {
    this.params = { ...DEFAULT_KAYAK_PARAMS, ...params };
  }

  reset(x: number, y: number, heading: number): void {
    this.x = x;
    this.y = y;
    this.heading = heading;
    this.vx = 0;
    this.vy = 0;
    this.angularVelocity = 0;
    this.health = 100;
    this.cooldown.left = 0;
    this.cooldown.right = 0;
    this.bracing.left = false;
    this.bracing.right = false;
    this.strokeFlash.left = 0;
    this.strokeFlash.right = 0;
  }

  get speed(): number {
    return Math.hypot(this.vx, this.vy);
  }

  /**
   * Take a stroke on one side. A stroke is an impulse applied off the
   * centreline, so it produces forward thrust *and* yaw from one action:
   * paddling on the left pushes the bow to the right. Alternating sides
   * therefore tracks straight, which is how a real kayak works.
   *
   * Returns false if that side is still on cooldown.
   */
  stroke(side: PaddleSide): boolean {
    if (this.cooldown[side] > 0) return false;

    const { strokeImpulse, strokeOffset, mass, inertia } = this.params;
    const fx = Math.cos(this.heading);
    const fy = Math.sin(this.heading);

    this.vx += (fx * strokeImpulse) / mass;
    this.vy += (fy * strokeImpulse) / mass;

    // Torque = r x F, with r the paddle's offset perpendicular to the hull.
    const lever = side === 'left' ? strokeOffset : -strokeOffset;
    this.angularVelocity += (lever * strokeImpulse) / inertia;

    this.cooldown[side] = this.params.strokeCooldown;
    this.strokeFlash[side] = 1;
    return true;
  }

  setBrace(side: PaddleSide, active: boolean): void {
    this.bracing[side] = active;
  }

  isBracing(side: PaddleSide): boolean {
    return this.bracing[side];
  }

  /** Advance the boat by `dt` seconds within `sim`, colliding against `obstacles`. */
  update(dt: number, sim: WaterSim, obstacles: readonly Obstacle[], grid: Grid): KayakEvents {
    const p = this.params;
    const events: KayakEvents = { impactSpeed: 0, damage: 0, grounded: false };

    this.cooldown.left = Math.max(0, this.cooldown.left - dt);
    this.cooldown.right = Math.max(0, this.cooldown.right - dt);
    this.strokeFlash.left = Math.max(0, this.strokeFlash.left - dt * 6);
    this.strokeFlash.right = Math.max(0, this.strokeFlash.right - dt * 6);

    // What the water under the hull is doing.
    const depth = sampleBilinear(sim.depth, grid, this.x, this.y);
    const waterVx = sampleBilinear(sim.vx, grid, this.x, this.y);
    const waterVy = sampleBilinear(sim.vy, grid, this.x, this.y);
    const afloat = depth > p.draft;
    events.grounded = !afloat;

    // Velocity of the hull relative to the water is what drag acts on. In still
    // water this is just the boat's velocity; in a current it is what pulls the
    // boat downstream even when it is pointing elsewhere.
    const relVx = this.vx - waterVx;
    const relVy = this.vy - waterVy;

    const fx = Math.cos(this.heading);
    const fy = Math.sin(this.heading);
    // Left-hand normal to the heading.
    const lx = -fy;
    const ly = fx;

    const relForward = relVx * fx + relVy * fy;
    const relLateral = relVx * lx + relVy * ly;

    let dragForward = p.dragForward;
    let dragLateral = p.dragLateral;
    let torque = 0;

    // A planted paddle bites the water: it drags that side back and pivots the
    // boat towards it, which is what lets you hold a line across a current.
    if (this.bracing.left || this.bracing.right) {
      dragForward += p.braceDrag * 0.5;
      dragLateral += p.braceDrag;
      if (this.bracing.left) torque += p.braceTorque;
      if (this.bracing.right) torque -= p.braceTorque;
      // Bracing on both sides is a pure brake, and the torques cancel.
    }

    // Out of the water the hull scrapes rather than flows.
    if (!afloat) {
      const scrape = p.groundFriction * p.mass;
      dragForward += scrape;
      dragLateral += scrape;
    }

    const forceForward = -dragForward * relForward;
    const forceLateral = -dragLateral * relLateral;

    const ax = (forceForward * fx + forceLateral * lx) / p.mass;
    const ay = (forceForward * fy + forceLateral * ly) / p.mass;

    this.vx += ax * dt;
    this.vy += ay * dt;

    const angularAccel = (torque - p.dragAngular * this.angularVelocity) / p.inertia;
    this.angularVelocity += angularAccel * dt;
    this.heading += this.angularVelocity * dt;

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    this.collide(obstacles, grid, events);
    return events;
  }

  private collide(obstacles: readonly Obstacle[], grid: Grid, events: KayakEvents): void {
    const p = this.params;

    for (const o of obstacles) {
      const dx = this.x - o.x;
      const dy = this.y - o.y;
      const minDist = o.radius + p.radius;
      const dist = Math.hypot(dx, dy);
      if (dist >= minDist || dist === 0) continue;

      const nx = dx / dist;
      const ny = dy / dist;

      // Push out of the rock, then reflect the component of velocity going into it.
      this.x = o.x + nx * minDist;
      this.y = o.y + ny * minDist;

      const into = this.vx * nx + this.vy * ny;
      if (into < 0) {
        const impact = -into;
        this.vx -= (1 + p.restitution) * into * nx;
        this.vy -= (1 + p.restitution) * into * ny;
        // Glancing blows spin the boat.
        this.angularVelocity += (this.vx * ny - this.vy * nx) * 0.12;

        events.impactSpeed = Math.max(events.impactSpeed, impact);
        if (impact > p.damageThreshold) {
          const dmg = (impact - p.damageThreshold) * p.damagePerSpeed;
          this.health = Math.max(0, this.health - dmg);
          events.damage += dmg;
        }
      }
    }

    // The level edge is a hard wall.
    const w = grid.width * grid.cellSize;
    const h = grid.height * grid.cellSize;
    const r = p.radius;
    if (this.x < r) {
      this.x = r;
      this.vx = Math.abs(this.vx) * p.restitution;
    } else if (this.x > w - r) {
      this.x = w - r;
      this.vx = -Math.abs(this.vx) * p.restitution;
    }
    if (this.y < r) {
      this.y = r;
      this.vy = Math.abs(this.vy) * p.restitution;
    } else if (this.y > h - r) {
      this.y = h - r;
      this.vy = -Math.abs(this.vy) * p.restitution;
    }
  }
}
