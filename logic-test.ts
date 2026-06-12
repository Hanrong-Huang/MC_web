// Node-side logic tests (no DOM): RLE codec, crafting matcher, furnace, break times.
import { rleEncode, rleDecode } from './src/engine/Persistence.ts';
import { matchRecipe, FurnaceState, ChestState, Slot, smeltResult } from './src/engine/Inventory.ts';
import { B, I, breakTime, canHarvest } from './src/engine/Blocks.ts';

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) failures++;
}

// --- RLE roundtrip ---
const data = new Uint8Array(32768);
for (let i = 0; i < 5000; i++) data[i] = 3;
for (let i = 5000; i < 5100; i++) data[i] = (i % 7) + 1;
data[32767] = 9;
const enc = rleEncode(data);
const dec = rleDecode(enc, data.length);
check('RLE roundtrip', dec.length === data.length && dec.every((v, i) => v === data[i]));
check('RLE compresses', enc.length < data.length / 10);

// --- crafting ---
const g4 = (a: number, b: number, c: number, d: number): Slot[] =>
  [a, b, c, d].map((id) => (id ? { id, count: 1 } : null));
check('log -> planks', matchRecipe(g4(B.LOG, 0, 0, 0), 2)?.id === B.PLANKS);
check('log anywhere in grid', matchRecipe(g4(0, 0, 0, B.LOG), 2)?.id === B.PLANKS);
check('2 planks -> sticks', matchRecipe(g4(B.PLANKS, 0, B.PLANKS, 0), 2)?.id === I.STICK);
check('4 planks -> table', matchRecipe(g4(B.PLANKS, B.PLANKS, B.PLANKS, B.PLANKS), 2)?.id === B.TABLE);
check('coal + stick -> torches', matchRecipe(g4(I.COAL, 0, I.STICK, 0), 2)?.id === B.TORCH);
check('4 sand -> sandstone', matchRecipe(g4(B.SAND, B.SAND, B.SAND, B.SAND), 2)?.id === B.SANDSTONE);
check('4 string -> wool', matchRecipe(g4(I.STRING, I.STRING, I.STRING, I.STRING), 2)?.id === B.WOOL);
check('2x2 cannot make pickaxe', matchRecipe(g4(B.PLANKS, B.PLANKS, B.PLANKS, 0), 2) === null);

const g9 = (ids: number[]): Slot[] => ids.map((id) => (id ? { id, count: 1 } : null));
const P = B.PLANKS, S = I.STICK, C = B.COBBLE, FE = I.IRON_INGOT, DI = I.DIAMOND;
const G = I.GUNPOWDER, SA = B.SAND, ST = I.STRING, W = B.WOOL;
check('wood pickaxe', matchRecipe(g9([P, P, P, 0, S, 0, 0, S, 0]), 3)?.id === I.WOOD_PICK);
check('stone pickaxe', matchRecipe(g9([C, C, C, 0, S, 0, 0, S, 0]), 3)?.id === I.STONE_PICK);
check('iron pickaxe', matchRecipe(g9([FE, FE, FE, 0, S, 0, 0, S, 0]), 3)?.id === I.IRON_PICK);
check('diamond sword', matchRecipe(g9([0, DI, 0, 0, DI, 0, 0, S, 0]), 3)?.id === I.DIAMOND_SWORD);
check('axe mirrored', matchRecipe(g9([0, P, P, 0, S, P, 0, S, 0]), 3)?.id === I.WOOD_AXE);
check('furnace', matchRecipe(g9([C, C, C, C, 0, C, C, C, C]), 3)?.id === B.FURNACE);
check('chest', matchRecipe(g9([P, P, P, P, 0, P, P, P, P]), 3)?.id === B.CHEST);
check('tnt', matchRecipe(g9([G, SA, G, SA, G, SA, G, SA, G]), 3)?.id === B.TNT);
check('bed', matchRecipe(g9([W, W, W, P, P, P, 0, 0, 0]), 3)?.id === B.BED);
check('bow', matchRecipe(g9([0, S, ST, S, 0, ST, 0, S, ST]), 3)?.id === I.BOW);
check('bow mirrored', matchRecipe(g9([ST, S, 0, ST, 0, S, ST, S, 0]), 3)?.id === I.BOW);
check('arrows', matchRecipe(g9([0, I.FLINT, 0, 0, S, 0, 0, I.FEATHER, 0]), 3)?.id === I.ARROW);
check('iron block', matchRecipe(g9([FE, FE, FE, FE, FE, FE, FE, FE, FE]), 3)?.id === B.IRON_BLOCK);
check('block -> 9 ingots', matchRecipe(g9([B.IRON_BLOCK, 0, 0, 0, 0, 0, 0, 0, 0]), 3)?.count === 9);
check('junk no match', matchRecipe(g9([C, 0, C, 0, 0, 0, 0, 0, 0]), 3) === null);

// --- smelting ---
check('iron ore -> ingot', smeltResult(B.IRON_ORE) === I.IRON_INGOT);
check('beef -> steak', smeltResult(I.BEEF) === I.COOKED_BEEF);
const f = new FurnaceState();
f.input = { id: B.SAND, count: 2 };
f.fuel = { id: B.PLANKS, count: 1 };
let litChanges = 0;
for (let t = 0; t < 15 / 0.05; t++) {
  if (f.tick(0.05)) litChanges++;
}
check('furnace lit toggled', litChanges >= 1);
check('sand smelted to glass', f.output?.id === B.GLASS && f.output.count === 1);
check('fuel consumed', f.fuel === null);
for (let t = 0; t < 10 / 0.05; t++) f.tick(0.05);
check('burn limited by fuel', (f.output?.count ?? 0) === 1 && f.input?.count === 1);

// --- chest ---
const chest = new ChestState();
check('chest starts empty', chest.isEmpty());
chest.slots[3] = { id: B.COBBLE, count: 12 };
const restored = ChestState.from(chest.serialize());
check('chest roundtrip', restored.slots[3]?.id === B.COBBLE && restored.slots[3]?.count === 12);

// --- break times & harvest gates ---
check('stone by hand 7.5s (no pick)', Math.abs(breakTime(B.STONE, 0) - 7.5) < 1e-9);
check('stone w/ wood pick 1.125s', Math.abs(breakTime(B.STONE, I.WOOD_PICK) - 1.125) < 1e-9);
check('stone w/ iron pick 0.375s', Math.abs(breakTime(B.STONE, I.IRON_PICK) - 0.375) < 1e-9);
check('hand cannot harvest stone', !canHarvest(B.STONE, 0));
check('wood pick harvests stone', canHarvest(B.STONE, I.WOOD_PICK));
check('wood pick cannot harvest iron', !canHarvest(B.IRON_ORE, I.WOOD_PICK));
check('stone pick harvests iron', canHarvest(B.IRON_ORE, I.STONE_PICK));
check('stone pick cannot harvest diamond', !canHarvest(B.DIAMOND_ORE, I.STONE_PICK));
check('iron pick harvests diamond', canHarvest(B.DIAMOND_ORE, I.IRON_PICK));
check('dirt needs no tool', canHarvest(B.DIRT, 0));
check('bedrock unbreakable', breakTime(B.BEDROCK, I.DIAMOND_PICK) === Infinity);

console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
process.exit(failures ? 1 : 0);
