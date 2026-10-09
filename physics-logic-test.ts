// Lightweight Node-side collision regressions. Bundle with esbuild, then run
// the resulting module under Node; no DOM, renderer, or browser is required.
import { B } from './src/engine/Blocks.ts';
import { canHopUp, moveEntity } from './src/engine/Physics.ts';
import type { World } from './src/engine/World.ts';

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) failures++;
}

function testWorld(cells: Array<[number, number, number, number]>, meta: Array<[number, number, number, number]> = []): World {
  const blocks = new Map(cells.map(([x, y, z, id]) => [`${x},${y},${z}`, id]));
  const bedFacings = new Map(meta.map(([x, y, z, value]) => [`${x},${y},${z}`, value]));
  return {
    getBlock: (x: number, y: number, z: number): number => blocks.get(`${x},${y},${z}`) ?? B.AIR,
    bedFacings,
    doorStates: new Map(),
    doorShape: (): null => null,
  } as unknown as World;
}

const playerBox = { w: 0.6, h: 1.8 };

// A sub-EPS overlap with the side of a tall wall must not turn that wall into
// ground during the following downward collision pass.
const wall = testWorld([
  [0, 0, 0, B.STONE],
  [1, 1, 0, B.STONE], [1, 2, 0, B.STONE],
  [1, 3, 0, B.STONE], [1, 4, 0, B.STONE],
]);
const wallPos = { x: 0.70075, y: 1.001, z: 0.5 };
const wallVel = { x: 0, y: -0.1, z: 0 };
moveEntity(wall, wallPos, wallVel, 0.1, playerBox, false, true);
check('shallow wall overlap does not lift entity', wallPos.y < 1.01);

// Normal low-ledge stepping must remain intact.
const slab = testWorld([
  [0, 0, 0, B.STONE],
  [1, 1, 0, B.COBBLE_SLAB],
]);
const slabPos = { x: 0.6, y: 1.001, z: 0.5 };
const slabVel = { x: 2, y: 0, z: 0 };
moveEntity(slab, slabPos, slabVel, 0.1, playerBox, false, true);
check('slab still steps to its top', Math.abs(slabPos.y - 1.501) < 1e-6 && slabPos.x > 0.6);

// A stair is two successive half-block ledges. Facing +x puts its raised half
// at x >= 1.5, so walking through the cell should climb both levels.
const stair = testWorld([
  [0, 0, 0, B.STONE],
  [1, 1, 0, B.COBBLE_STAIRS],
], [[1, 1, 0, 3]]);
const stairPos = { x: 0.6, y: 1.001, z: 0.5 };
const stairVel = { x: 2, y: 0, z: 0 };
moveEntity(stair, stairPos, stairVel, 0.4, playerBox, false, true);
check('stair still climbs both half-block levels', Math.abs(stairPos.y - 2.001) < 1e-6);

const hopPos = { x: 0.6, y: 1.001, z: 0.5 };
const fullLedge = testWorld([
  [0, 0, 0, B.STONE],
  [1, 1, 0, B.STONE],
]);
check('one-block ledge is a valid auto-jump target', canHopUp(fullLedge, hopPos, playerBox, 1, 0, 1.25));

const fence = testWorld([
  [0, 0, 0, B.STONE],
  [1, 1, 0, B.OAK_FENCE],
]);
check('1.5-block fence is not an auto-jump target', !canHopUp(fence, hopPos, playerBox, 1, 0, 1.25));

const stackedWall = testWorld([
  [0, 0, 0, B.STONE],
  [1, 1, 0, B.STONE], [1, 2, 0, B.STONE],
]);
check('blocked headroom is not an auto-jump target', !canHopUp(stackedWall, hopPos, playerBox, 1, 0, 1.25));

if (failures) process.exitCode = 1;
