// Headless logic test for flowing water: a source spreads to neighbours and
// recedes when removed. No browser/Three needed.
import { World } from './src/engine/World';
import { B } from './src/engine/Blocks';

const w = new World(4242);
w.update(8, 8, 5000); // generate chunks around the origin

const Y = 80;
// a flat 7x7 stone platform with clear air above
for (let x = 0; x < 7; x++) {
  for (let z = 0; z < 7; z++) {
    w.setBlock(x, Y, z, B.STONE);
    w.setBlock(x, Y + 1, z, B.AIR);
    w.setBlock(x, Y + 2, z, B.AIR);
  }
}

const isW = (x: number, y: number, z: number) => w.getBlock(x, y, z) === B.WATER;

// place a source in the centre (absent from the level map = permanent) and settle
w.waterLevels.delete(`3,${Y + 1},3`);
w.setBlock(3, Y + 1, 3, B.WATER);
for (let i = 0; i < 40; i++) w.tickWater();

const spread = isW(4, Y + 1, 3) && isW(2, Y + 1, 3) && isW(3, Y + 1, 4) && isW(3, Y + 1, 2);

// remove the source; flowing water should recede
w.setBlock(3, Y + 1, 3, B.AIR);
w.waterLevels.delete(`3,${Y + 1},3`);
for (let i = 0; i < 80; i++) w.tickWater();

const receded = !isW(4, Y + 1, 3) && !isW(2, Y + 1, 3) && !isW(3, Y + 1, 4);

console.log('spread to neighbours:', spread ? 'OK' : 'FAIL');
console.log('receded after removal:', receded ? 'OK' : 'FAIL');
process.exit(spread && receded ? 0 : 1);
