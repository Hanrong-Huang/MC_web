// Headless logic test for Minecraft-like fluid flow. No browser/Three needed.
import { World } from './src/engine/World';
import { B } from './src/engine/Blocks';

const w = new World(4242);
w.update(8, 8, 5000); // generate chunks around the origin

const Y = 80;
// a flat 17x17 stone platform with clear air above
for (let x = 0; x < 17; x++) {
  for (let z = 0; z < 17; z++) {
    w.setBlock(x, Y, z, B.STONE);
    w.setBlock(x, Y + 1, z, B.AIR);
    w.setBlock(x, Y + 2, z, B.AIR);
  }
}

const isW = (x: number, y: number, z: number) => w.getBlock(x, y, z) === B.WATER;
const isL = (x: number, y: number, z: number) => w.getBlock(x, y, z) === B.LAVA;

// scheduled fluids may touch solids, but must not replace them
w.setBlock(2, Y + 1, 3, B.STONE);

// place a source in the centre (absent from the level map = permanent) and settle
w.waterLevels.delete(`8,${Y + 1},8`);
w.setBlock(8, Y + 1, 8, B.WATER);
for (let i = 0; i < 120; i++) w.tickWater();

const spread = isW(9, Y + 1, 8) && isW(7, Y + 1, 8) && isW(8, Y + 1, 9) && isW(8, Y + 1, 7);
const finiteRange = isW(15, Y + 1, 8) && !isW(16, Y + 1, 8);
const didNotEatStone = w.getBlock(2, Y + 1, 3) === B.STONE;

// remove the source; flowing water should recede
w.setBlock(8, Y + 1, 8, B.AIR);
w.waterLevels.delete(`8,${Y + 1},8`);
for (let i = 0; i < 160; i++) w.tickWater();

const receded = !isW(9, Y + 1, 8) && !isW(7, Y + 1, 8) && !isW(8, Y + 1, 9);

// downhill priority: with an immediate drop-off, water should feed the drop
// instead of fanning across every flat neighbor first.
for (let x = 20; x < 28; x++) {
  for (let z = 0; z < 7; z++) {
    w.setBlock(x, Y, z, B.STONE);
    w.setBlock(x, Y + 1, z, B.AIR);
    w.setBlock(x, Y + 2, z, B.AIR);
  }
}
w.setBlock(24, Y, 3, B.AIR);
w.waterLevels.delete(`23,${Y + 1},3`);
w.setBlock(23, Y + 1, 3, B.WATER);
for (let i = 0; i < 60; i++) w.tickWater();
const downhillPriority = isW(24, Y + 1, 3) && isW(24, Y, 3) && !isW(22, Y + 1, 3) && !isW(23, Y + 1, 4);

// downhill lookahead: water should seek a nearby drop even when it is not
// immediately adjacent, instead of spreading evenly in all directions.
for (let x = 28; x < 42; x++) {
  for (let z = 0; z < 7; z++) {
    w.setBlock(x, Y, z, B.STONE);
    w.setBlock(x, Y + 1, z, B.AIR);
    w.setBlock(x, Y + 2, z, B.AIR);
  }
}
w.setBlock(37, Y, 3, B.AIR);
w.waterLevels.delete(`34,${Y + 1},3`);
w.setBlock(34, Y + 1, 3, B.WATER);
for (let i = 0; i < 80; i++) w.tickWater();
const downhillLookahead =
  isW(35, Y + 1, 3) &&
  isW(36, Y + 1, 3) &&
  isW(37, Y + 1, 3) &&
  isW(37, Y, 3) &&
  !isW(33, Y + 1, 3) &&
  !isW(34, Y + 1, 2) &&
  !isW(34, Y + 1, 4);

// lava uses the same logic, but with a short horizontal range.
w.lavaLevels.delete(`4,${Y + 1},13`);
w.setBlock(4, Y + 1, 13, B.LAVA);
for (let i = 0; i < 120; i++) w.tickLava();
const lavaShortRange = isL(7, Y + 1, 13) && !isL(8, Y + 1, 13);

console.log('spread to neighbours:', spread ? 'OK' : 'FAIL');
console.log('finite water range:', finiteRange ? 'OK' : 'FAIL');
console.log('does not replace stone:', didNotEatStone ? 'OK' : 'FAIL');
console.log('receded after removal:', receded ? 'OK' : 'FAIL');
console.log('downhill priority:', downhillPriority ? 'OK' : 'FAIL');
if (!downhillPriority) {
  console.log('downhill detail:', {
    edge: isW(24, Y + 1, 3),
    below: isW(24, Y, 3),
    back: isW(22, Y + 1, 3),
    side: isW(23, Y + 1, 4),
  });
}
console.log('downhill lookahead:', downhillLookahead ? 'OK' : 'FAIL');
if (!downhillLookahead) {
  console.log('lookahead detail:', {
    path1: isW(35, Y + 1, 3),
    path2: isW(36, Y + 1, 3),
    edge: isW(37, Y + 1, 3),
    below: isW(37, Y, 3),
    back: isW(33, Y + 1, 3),
    sideA: isW(34, Y + 1, 2),
    sideB: isW(34, Y + 1, 4),
  });
}
console.log('short lava range:', lavaShortRange ? 'OK' : 'FAIL');
process.exit(
  spread &&
  finiteRange &&
  didNotEatStone &&
  receded &&
  downhillPriority &&
  downhillLookahead &&
  lavaShortRange ? 0 : 1,
);
