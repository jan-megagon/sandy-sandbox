import { type Level, createLevel } from '../sim/level';
import { defaultChannelCentre } from '../sim/terrain';

/**
 * The one level that ships with the app, so play mode isn't empty on a first
 * launch. Built from the same valley generator the editor starts from, with
 * everything placed on the channel the generator carved.
 */
export const DEMO_LEVEL_ID = 'demo-first-run';

export function createDemoLevel(): Level {
  const level = createLevel('First Run', 128, 128, 2);
  level.id = DEMO_LEVEL_ID;

  const world = level.width * level.cellSize;
  // Position on the channel at a given fraction of the way down the valley.
  const onChannel = (v: number) => ({
    x: defaultChannelCentre(v) * world,
    y: v * level.height * level.cellSize,
  });

  const spring = onChannel(0.03);
  level.sources = [{ x: spring.x, y: spring.y, rate: 0.25, radius: 10 }];

  const start = onChannel(0.1);
  const afterStart = onChannel(0.14);
  level.start = {
    x: start.x,
    y: start.y,
    // Point the bow the way the river runs.
    heading: Math.atan2(afterStart.y - start.y, afterStart.x - start.x),
  };

  const finish = onChannel(0.93);
  level.goal = { x: finish.x, y: finish.y, radius: 7 };

  // Rocks placed just off the channel centre, so the fast line is the risky one.
  const rocks: Array<[number, number, number]> = [
    [0.24, 0.35, 2.2],
    [0.32, -0.5, 1.8],
    [0.42, 0.1, 2.6],
    [0.52, -0.65, 2.0],
    [0.58, 0.55, 1.9],
    [0.67, -0.2, 2.4],
    [0.74, 0.62, 2.1],
    [0.83, -0.4, 2.3],
  ];
  level.obstacles = rocks.map(([v, offset, radius]) => {
    const p = onChannel(v);
    return { x: p.x + offset * 7, y: p.y, radius };
  });

  return level;
}
