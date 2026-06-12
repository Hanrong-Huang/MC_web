// Deterministic check of the torch flood-fill: generate terrain, place a
// torch, mesh the chunk, and verify nearby vertices carry block light.
import { World } from './src/engine/World.ts';
import { buildChunkGeometry } from './src/engine/Mesher.ts';
import { B } from './src/engine/Blocks.ts';
import type { Atlas } from './src/engine/Textures.ts';

const mockAtlas = {
  rect: () => ({ u0: 0, v0: 0, u1: 1, v1: 1 }),
} as unknown as Atlas;

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) failures++;
}

const world = new World(1234);
world.viewDist = 2;
for (let i = 0; i < 50; i++) world.update(8, 8, 50);
check('chunks generated', world.countLoaded() >= 25);

// find the surface at (8, 8)
const chunk = world.getChunk(0, 0)!;
const h = chunk.heightmap[8 * 16 + 8]; // first free y at local (8,8)
check('surface found', h > 1 && h < 120);

// place a torch on the surface
const ok = world.setBlock(8, h, 8, B.TORCH);
check('torch placed', ok && world.getBlock(8, h, 8) === B.TORCH);
check('torch tracked', chunk.torches.size === 1);

const geo = buildChunkGeometry(world, chunk, mockAtlas);
check('solid mesh built', !!geo.solid);

const pos = geo.solid!.getAttribute('position');
const light = geo.solid!.getAttribute('alight');
check('alight attribute present', !!light && light.itemSize === 2);

// scan vertices: those near the torch should carry block light
let nearLit = 0, nearTotal = 0, farLit = 0, maxNear = 0;
for (let i = 0; i < pos.count; i++) {
  const dx = pos.getX(i) - 8.5, dy = pos.getY(i) - h, dz = pos.getZ(i) - 8.5;
  const d = Math.hypot(dx, dy, dz);
  const bl = light.getY(i);
  if (d < 3) {
    nearTotal++;
    if (bl > 0.3) nearLit++;
    maxNear = Math.max(maxNear, bl);
  } else if (d > 20 && bl > 0.05) {
    farLit++;
  }
}
console.log(`  near torch: ${nearLit}/${nearTotal} lit, max block light ${maxNear.toFixed(2)}`);
check('vertices near torch are lit', nearTotal > 0 && nearLit > nearTotal * 0.5);
check('strong light at the torch', maxNear > 0.6);
check('light attenuates with distance', farLit === 0);

// breaking the torch clears the light
world.setBlock(8, h, 8, B.AIR);
const geo2 = buildChunkGeometry(world, chunk, mockAtlas);
const light2 = geo2.solid!.getAttribute('alight');
let anyLit = 0;
for (let i = 0; i < light2.count; i++) if (light2.getY(i) > 0.05) anyLit++;
check('light removed with torch', anyLit === 0);

console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
process.exit(failures ? 1 : 0);
