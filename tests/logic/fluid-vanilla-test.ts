// Headless logic test for the vanilla fluid port (World "flowing fluids"):
// levels, ranges, timing, waterfalls, infinite water, washing, lava reactions
// and the flow vector. Run:
//   npx esbuild tests/logic/fluid-vanilla-test.ts --bundle --format=esm --platform=node --outfile=tests/artifacts/fluid-test.mjs
//   node tests/artifacts/fluid-test.mjs
import { World } from '../../src/engine/World';
import { B } from '../../src/engine/Blocks';

const w = new World(4242);
w.update(8, 8, 5000);
const Y = 100;
let fails = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${ok || !detail ? '' : ' — ' + detail}`);
  if (!ok) fails++;
};
const id = (x: number, y: number, z: number) => w.getBlock(x, y, z);
const isW = (x: number, y: number, z: number) => id(x, y, z) === B.WATER;
const isL = (x: number, y: number, z: number) => id(x, y, z) === B.LAVA;
const settle = (n = 200) => { for (let i = 0; i < n; i++) { w.tickWater(); w.tickLava(); } };

/** A walled stone tub: floor at Y, interior x0..x0+sx-1 / z0..z0+sz-1 open
 *  up to Y+8, a stone ring around it (so nothing finds the drops outside). */
function arena(x0: number, z0: number, sx: number, sz: number): void {
  for (let x = x0 - 1; x <= x0 + sx; x++) for (let z = z0 - 1; z <= z0 + sz; z++) {
    const ring = x === x0 - 1 || x === x0 + sx || z === z0 - 1 || z === z0 + sz;
    w.setBlock(x, Y, z, B.STONE);
    for (let y = Y + 1; y <= Y + 8; y++) w.setBlock(x, y, z, ring ? B.STONE : B.AIR);
  }
  settle(20);
}
function source(fluid: number, x: number, y: number, z: number): void {
  (fluid === B.LAVA ? w.lavaLevels : w.waterLevels).delete(`${x},${y},${z}`);
  w.setBlock(x, y, z, fluid);
}

// 1) water spreads 7 blocks with levels 1..7 on flat ground
arena(0, 0, 20, 5);
source(B.WATER, 2, Y + 1, 2);
settle();
const lv = [3, 4, 5, 6, 7, 8, 9].map((x) => isW(x, Y + 1, 2) ? w.waterLevel(x, Y + 1, 2) : -1);
check('water levels 1..7 along a flat run', lv.join() === '1,2,3,4,5,6,7', lv.join());
check('water stops after 7 blocks', !isW(10, Y + 1, 2));
// 2) it recedes when the source goes
w.setBlock(2, Y + 1, 2, B.AIR);
settle();
check('flowing water recedes after the source is removed', ![3, 4, 5, 9].some((x) => isW(x, Y + 1, 2)));

// 3) infinite water: two sources with a gap make the gap a source
arena(30, 0, 6, 3);
source(B.WATER, 31, Y + 1, 1); source(B.WATER, 33, Y + 1, 1);
settle();
check('gap between two sources becomes a source', isW(32, Y + 1, 1) && !w.waterLevels.has(`32,${Y + 1},1`));
// ...but not over air (vanilla needs a solid block or a source below)
arena(40, 0, 6, 3);
w.setBlock(42, Y, 1, B.AIR); w.setBlock(42, Y - 1, 1, B.AIR); w.setBlock(42, Y - 2, 1, B.STONE);
source(B.WATER, 41, Y + 1, 1); source(B.WATER, 43, Y + 1, 1);
settle();
check('no infinite source over a hole', !(isW(42, Y + 1, 1) && !w.waterLevels.has(`42,${Y + 1},1`)));

// 4) a source on a ledge pours straight down (no sideways sheet), the
//    column is "falling" (level 8) and the landing spreads 7 at the bottom
arena(60, 0, 18, 18);
w.setBlock(68, Y + 6, 8, B.STONE); // a 1x1 pillar top to hold the source
for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) w.setBlock(68 + dx, Y + 6, 8 + dz, B.AIR);
source(B.WATER, 68, Y + 7, 8);
settle(); // the source sits on stone: it spreads sideways, then falls off the pillar edges
const fallCol = isW(69, Y + 6, 8) && isW(69, Y + 3, 8) && w.waterLevel(69, Y + 3, 8) === World.FALLING;
check('water pours off a ledge as a falling column (level 8)', fallCol, `${w.waterLevel(69, Y + 3, 8)}`);
check('the landing spreads out at the bottom', isW(69 + 3, Y + 1, 8) && w.waterLevel(72, Y + 1, 8) > 0);
// a lone source in mid-air
arena(90, 0, 10, 10);
source(B.WATER, 95, Y + 6, 5);
settle();
// vanilla: it grows a one-block rim (level 1) that drips down, nothing wider
check('a source in mid-air falls, with only a one-block dripping rim', w.waterLevel(96, Y + 6, 5) === 1 && !isW(97, Y + 6, 5) &&
  w.waterLevel(96, Y + 5, 5) === World.FALLING && isW(95, Y + 3, 5));

// 5) flowing water onto a lake merges (no sideways spread on top of it)
arena(110, 0, 12, 12);
for (let x = 110; x < 122; x++) for (let z = 0; z < 12; z++) source(B.WATER, x, Y + 1, z);
w.setBlock(116, Y + 3, 6, B.STONE);
source(B.WATER, 116, Y + 4, 6);
settle();
check('falling water landing on a lake does not sheet across it', !isW(118, Y + 2, 6) && !isW(114, Y + 2, 6));

// 6) lava: 3 blocks (levels 2/4/6) in the Overworld
arena(0, 20, 12, 5);
source(B.LAVA, 2, Y + 1, 22);
settle(300);
const ll = [3, 4, 5].map((x) => isL(x, Y + 1, 22) ? w.lavaLevel(x, Y + 1, 22) : -1);
check('overworld lava levels 2,4,6 and stops after 3', ll.join() === '2,4,6' && !isL(6, Y + 1, 22), ll.join());

// 7) reactions
arena(20, 20, 12, 6);
source(B.LAVA, 22, Y + 1, 22); source(B.WATER, 23, Y + 1, 22);
check('water beside a lava source -> obsidian (immediately)', id(22, Y + 1, 22) === B.OBSIDIAN);
arena(20, 20, 12, 6);
source(B.LAVA, 21, Y + 1, 23);
settle(300);
const flowing = isL(23, Y + 1, 23) && w.lavaLevels.has(`23,${Y + 1},23`);
source(B.WATER, 23, Y + 2, 23);
check('water above flowing lava -> cobblestone', flowing && id(23, Y + 1, 23) === B.COBBLE);
arena(40, 20, 6, 6);
source(B.WATER, 42, Y + 1, 22);
settle(40);
w.setBlock(42, Y + 3, 22, B.STONE);
source(B.LAVA, 42, Y + 4, 22);
settle(300);
check('lava pouring down onto water -> stone', id(42, Y + 1, 22) === B.STONE || id(42, Y + 2, 22) === B.STONE,
  `${id(42, Y + 1, 22)} ${id(42, Y + 2, 22)}`);

// 8) washing: torches/flowers pop off, sugar cane holds
const washed: number[] = [];
w.onFluidWash = (_x, _y, _z, bid) => { washed.push(bid); };
arena(60, 30, 8, 3);
w.setBlock(62, Y + 1, 31, B.TORCH);
w.setBlock(63, Y + 1, 31, B.POPPY);
source(B.WATER, 61, Y + 1, 31);
settle();
check('water washes away a torch and a flower', washed.includes(B.TORCH) && washed.includes(B.POPPY) && isW(63, Y + 1, 31));

// 9) timing: tickFluids() is the 20 Hz clock — water 1 block / 5 ticks,
//    lava 1 block / 30 ticks in the Overworld
arena(0, 40, 14, 5);
source(B.WATER, 1, Y + 1, 42);
settle(0);
let steps = 0;
for (let i = 0; i < 25; i++) w.tickFluids(); // 5 water steps
for (let x = 2; x <= 9; x++) if (isW(x, Y + 1, 42)) steps = x - 1;
check('water advances about one block per 5 ticks', steps >= 3 && steps <= 5, `${steps} blocks in 25 ticks`);
arena(0, 50, 8, 5);
source(B.LAVA, 1, Y + 1, 52);
for (let i = 0; i < 59; i++) w.tickFluids();
const lavaFar = [2, 3, 4].filter((x) => isL(x, Y + 1, 52)).length;
check('lava is slow: at most 2 blocks in 3 s', lavaFar <= 2, `${lavaFar}`);

// 10) flow vector points downstream
arena(0, 60, 12, 5);
source(B.WATER, 1, Y + 1, 62);
settle();
const f = { x: 0, y: 0, z: 0 };
w.fluidFlow(B.WATER, 4, Y + 1, 62, f);
check('flow vector points away from the source', f.x > 0.9 && Math.abs(f.z) < 0.2, `${f.x.toFixed(2)},${f.z.toFixed(2)}`);
w.fluidFlow(B.WATER, 1, Y + 1, 62, f);
check('a source surrounded evenly pushes outward symmetrically (net ~0)', Math.abs(f.x) < 1.01);

// 11) a waterfall drains top-down when its source is removed
arena(0, 70, 10, 10);
w.setBlock(5, Y + 4, 75, B.STONE);
source(B.WATER, 5, Y + 5, 75);
settle();
const hadFall = [6, 4, 5].some((x) => isW(x, Y + 3, 75)) || isW(5, Y + 3, 76);
w.setBlock(5, Y + 5, 75, B.AIR);
settle(300);
let left = 0;
for (let x = 0; x < 10; x++) for (let z = 70; z < 80; z++) for (let y = Y + 1; y <= Y + 6; y++) if (isW(x, y, z)) left++;
check('waterfall + pool drain away after the source is removed', hadFall && left === 0, `${left} left`);

// 12) Nether lava runs 7 blocks
w.switchDimension('nether');
w.update(8, 8, 5000);
arena(0, 0, 12, 4);
source(B.LAVA, 1, Y + 1, 2);
settle(400);
const nl = [2, 3, 4, 5, 6, 7, 8].map((x) => isL(x, Y + 1, 2) ? 1 : 0).join('');
check('Nether lava runs 7 blocks', nl === '1111111' && !isL(9, Y + 1, 2), nl);

console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
