import { describe, expect, it } from 'vitest';
import { makeGrid } from '../src/sim/grid';
import { WaterSim } from '../src/sim/water';
import { Kayak } from '../src/game/kayak';

/**
 * The boat is drawn longer than it is wide and its drag is anisotropic too, so
 * "does it behave the same in every direction" is a fair question to ask of the
 * physics as well as of the renderer. It should: drag is resolved in the hull's
 * own frame, not the world's, so turning the whole problem should turn the
 * whole answer and change nothing else.
 */
describe('kayak rotational invariance', () => {
  const ROTATIONS = [Math.PI / 2, Math.PI, -Math.PI / 3, 2.4];
  const START = 64;

  function run(theta: number, strokes: 'left' | 'right' | 'none'): Kayak {
    const grid = makeGrid(64, 64, 2);
    const sim = new WaterSim(grid);
    sim.depth.fill(2);
    // A current of fixed strength, turned through the same angle as the boat.
    const speed = 1.4;
    const currentAngle = 0.7 + theta;
    sim.vx.fill(speed * Math.cos(currentAngle));
    sim.vy.fill(speed * Math.sin(currentAngle));

    const boat = new Kayak();
    boat.reset(START, START, theta);
    const dt = 1 / 60;
    for (let step = 0; step < 240; step++) {
      if (strokes !== 'none' && step % 20 === 0) boat.stroke(strokes);
      boat.update(dt, sim, [], grid);
    }
    return boat;
  }

  /** Express the outcome back in the frame it started in, so runs compare. */
  function inStartFrame(boat: Kayak, theta: number) {
    const c = Math.cos(-theta);
    const s = Math.sin(-theta);
    const dx = boat.x - START;
    const dy = boat.y - START;
    return {
      x: dx * c - dy * s,
      y: dx * s + dy * c,
      vx: boat.vx * c - boat.vy * s,
      vy: boat.vx * s + boat.vy * c,
      turn: boat.heading - theta,
    };
  }

  for (const strokes of ['none', 'left', 'right'] as const) {
    it(`drifts and turns the same in every direction (${strokes} strokes)`, () => {
      const reference = inStartFrame(run(0, strokes), 0);

      for (const theta of ROTATIONS) {
        const got = inStartFrame(run(theta, strokes), theta);
        expect(got.x).toBeCloseTo(reference.x, 3);
        expect(got.y).toBeCloseTo(reference.y, 3);
        expect(got.vx).toBeCloseTo(reference.vx, 3);
        expect(got.vy).toBeCloseTo(reference.vy, 3);
        expect(got.turn).toBeCloseTo(reference.turn, 3);
      }
    });
  }

  it('covers the same ground pointing up the screen as across it', () => {
    // The axis the renderer was getting wrong, stated as a claim about physics.
    const across = inStartFrame(run(0, 'left'), 0);
    const up = inStartFrame(run(Math.PI / 2, 'left'), Math.PI / 2);
    expect(Math.hypot(up.x, up.y)).toBeCloseTo(Math.hypot(across.x, across.y), 3);
  });
});
