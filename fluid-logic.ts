// Headless logic test for Minecraft-like fluids: spread, recede, infinite
// water sources (2-source rule), and the lava+water -> rock reaction.
import { World } from './src/engine/World';
import { B } from './src/engine/Blocks';

const w = new World(4242);
w.update(8, 8, 5000);
const Y = 80;
const isW = (x: number, y: number, z: number) => w.getBlock(x, y, z) === B.WATER;
const settle = (n: number) => { for (let i = 0; i < n; i++) { w.tickWater(); w.tickLava(); } };

// flat 9x9 stone platform with clear air above
for (let x = 0; x < 9; x++) for (let z = 0; z < 9; z++) {
  w.setBlock(x, Y, z, B.STONE);
  w.setBlock(x, Y + 1, z, B.AIR);
  w.setBlock(x, Y + 2, z, B.AIR);
}

// 1) spread + recede
w.waterLevels.delete(`4,${Y + 1},4`);
w.setBlock(4, Y + 1, 4, B.WATER);
settle(60);
const spread = isW(5, Y + 1, 4) && isW(3, Y + 1, 4) && isW(4, Y + 1, 5) && isW(4, Y + 1, 3);
w.setBlock(4, Y + 1, 4, B.AIR);
w.waterLevels.delete(`4,${Y + 1},4`);
settle(120);
const receded = !isW(5, Y + 1, 4) && !isW(3, Y + 1, 4);

// 2) infinite source: two sources one cell apart -> the gap becomes a source
for (let x = 0; x < 9; x++) for (let z = 0; z < 9; z++) { w.setBlock(x, Y + 1, z, B.AIR); w.waterLevels.delete(`${x},${Y + 1},${z}`); }
w.setBlock(2, Y + 1, 4, B.WATER); w.waterLevels.delete(`2,${Y + 1},4`);
w.setBlock(4, Y + 1, 4, B.WATER); w.waterLevels.delete(`4,${Y + 1},4`);
settle(60);
const gapIsSource = isW(3, Y + 1, 4) && !w.waterLevels.has(`3,${Y + 1},4`);

// 3) lava + water reaction: a lava source next to water becomes obsidian
for (let x = 0; x < 9; x++) for (let z = 0; z < 9; z++) { w.setBlock(x, Y + 1, z, B.AIR); w.waterLevels.delete(`${x},${Y + 1},${z}`); w.lavaLevels.delete(`${x},${Y + 1},${z}`); }
w.setBlock(6, Y + 1, 4, B.LAVA); w.lavaLevels.delete(`6,${Y + 1},4`); // lava source
w.setBlock(7, Y + 1, 4, B.WATER); w.waterLevels.delete(`7,${Y + 1},4`); // adjacent water source
settle(40);
const obsidian = w.getBlock(6, Y + 1, 4) === B.OBSIDIAN;

console.log('spread to neighbours:', spread ? 'OK' : 'FAIL');
console.log('receded after removal:', receded ? 'OK' : 'FAIL');
console.log('infinite water source:', gapIsSource ? 'OK' : 'FAIL');
console.log('lava+water -> obsidian:', obsidian ? 'OK' : 'FAIL');
process.exit(spread && receded && gapIsSource && obsidian ? 0 : 1);
