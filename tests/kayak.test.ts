import { describe, expect, it } from 'vitest';
import { makeGrid } from '../src/sim/grid';
import { WaterSim } from '../src/sim/water';
import { Kayak } from '../src/game/kayak';

/** A pond of uniform depth with a uniform current, for isolating boat physics. */
function pond(currentX = 0, currentY = 0, depth = 2) {
  const grid = makeGrid(64, 64, 2);
  const sim = new WaterSim(grid);
  sim.depth.fill(depth);
  sim.vx.fill(currentX);
  sim.vy.fill(currentY);
  return { grid, sim };
}

function advance(kayak: Kayak, sim: WaterSim, grid: ReturnType<typeof makeGrid>, seconds: number) {
  const dt = 1 / 60;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    kayak.update(dt, sim, [], grid);
  }
}

describe('Kayak', () => {
  it('coasts to a stop in still water', () => {
    const { grid, sim } = pond();
    const kayak = new Kayak();
    kayak.reset(60, 60, 0);
    kayak.vx = 3;

    advance(kayak, sim, grid, 10);
    expect(kayak.speed).toBeLessThan(0.05);
  });

  it('is carried downstream by a current', () => {
    const { grid, sim } = pond(1.5, 0);
    const kayak = new Kayak();
    kayak.reset(30, 60, 0);

    advance(kayak, sim, grid, 15);
    // With no paddling the boat ends up matching the water.
    expect(kayak.vx).toBeCloseTo(1.5, 1);
    expect(kayak.x).toBeGreaterThan(40);
  });

  it('gains forward speed and yaws away from the paddled side', () => {
    const { grid, sim } = pond();
    const kayak = new Kayak();
    kayak.reset(60, 60, 0);

    kayak.stroke('left');
    advance(kayak, sim, grid, 0.5);

    // Heading 0 is +x, so forward progress is +x.
    expect(kayak.vx).toBeGreaterThan(0.2);
    // Paddling on the left turns the boat to the right (+y in screen space).
    expect(kayak.angularVelocity).toBeGreaterThan(0);
    expect(kayak.heading).toBeGreaterThan(0);
  });

  it('tracks roughly straight when strokes alternate', () => {
    const { grid, sim } = pond();
    const kayak = new Kayak();
    kayak.reset(60, 60, 0);

    let side: 'left' | 'right' = 'left';
    for (let i = 0; i < 20; i++) {
      kayak.stroke(side);
      side = side === 'left' ? 'right' : 'left';
      advance(kayak, sim, grid, 0.3);
    }

    expect(Math.abs(kayak.heading)).toBeLessThan(0.35);
    expect(kayak.x).toBeGreaterThan(65);
  });

  it('resists sideways motion far more than forward motion', () => {
    const { grid, sim } = pond();

    const forward = new Kayak();
    forward.reset(60, 60, 0);
    forward.vx = 2;

    const sideways = new Kayak();
    sideways.reset(60, 60, 0);
    sideways.vy = 2;

    advance(forward, sim, grid, 1);
    advance(sideways, sim, grid, 1);

    // This anisotropy is what makes the hull behave like a boat.
    expect(forward.speed).toBeGreaterThan(sideways.speed * 3);
  });

  it('turns towards the braced side', () => {
    const { grid, sim } = pond();
    const kayak = new Kayak();
    kayak.reset(60, 60, 0);
    kayak.setBrace('left', true);

    advance(kayak, sim, grid, 1);
    expect(kayak.heading).toBeGreaterThan(0.2);
  });

  it('slows down when it runs aground', () => {
    const { grid, sim } = pond(0, 0, 2);
    const shallow = pond(0, 0, 0.02);

    const floating = new Kayak();
    floating.reset(60, 60, 0);
    floating.vx = 2;
    const grounded = new Kayak();
    grounded.reset(60, 60, 0);
    grounded.vx = 2;

    advance(floating, sim, grid, 0.5);
    advance(grounded, shallow.sim, shallow.grid, 0.5);

    expect(grounded.speed).toBeLessThan(floating.speed * 0.5);
  });

  it('bounces off a rock and takes damage proportional to the impact', () => {
    const { grid, sim } = pond();
    const kayak = new Kayak();
    kayak.reset(50, 60, 0);
    kayak.vx = 4;

    const rocks = [{ x: 56, y: 60, radius: 2 }];
    let totalDamage = 0;
    for (let i = 0; i < 180; i++) {
      totalDamage += kayak.update(1 / 60, sim, rocks, grid).damage;
    }

    expect(totalDamage).toBeGreaterThan(0);
    expect(kayak.health).toBeLessThan(100);
    // Pushed back out of the rock, not left inside it.
    expect(Math.hypot(kayak.x - 56, kayak.y - 60)).toBeGreaterThanOrEqual(2 + kayak.params.radius - 1e-6);
  });

  it('does no damage in a gentle nudge', () => {
    const { grid, sim } = pond();
    const kayak = new Kayak();
    kayak.reset(50, 60, 0);
    kayak.vx = 0.4;

    const rocks = [{ x: 53, y: 60, radius: 1.5 }];
    let totalDamage = 0;
    for (let i = 0; i < 120; i++) {
      totalDamage += kayak.update(1 / 60, sim, rocks, grid).damage;
    }
    expect(totalDamage).toBe(0);
    expect(kayak.health).toBe(100);
  });

  it('stays inside the level bounds', () => {
    const { grid, sim } = pond(0, 0);
    const kayak = new Kayak();
    kayak.reset(5, 5, Math.PI);
    kayak.vx = -8;
    kayak.vy = -8;

    advance(kayak, sim, grid, 3);
    expect(kayak.x).toBeGreaterThanOrEqual(0);
    expect(kayak.y).toBeGreaterThanOrEqual(0);
    expect(kayak.x).toBeLessThanOrEqual(grid.width * grid.cellSize);
    expect(kayak.y).toBeLessThanOrEqual(grid.height * grid.cellSize);
  });

  it('respects the stroke cooldown', () => {
    const { grid, sim } = pond();
    const kayak = new Kayak();
    kayak.reset(60, 60, 0);

    expect(kayak.stroke('left')).toBe(true);
    expect(kayak.stroke('left')).toBe(false);
    // The other side is independent, so you can paddle in quick alternation.
    expect(kayak.stroke('right')).toBe(true);

    advance(kayak, sim, grid, 0.4);
    expect(kayak.stroke('left')).toBe(true);
  });
});
