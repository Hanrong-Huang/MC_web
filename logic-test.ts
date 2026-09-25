// Node-side logic tests (no DOM): RLE codec, crafting matcher, furnace, break times.
import { rleEncode, rleDecode } from './src/engine/Persistence.ts';
import { matchRecipe, FurnaceState, ChestState, Slot, smeltResult, furnaceSlotFor } from './src/engine/Inventory.ts';
import {
  B, I, breakTime, canHarvest, attackCooldown, attackStrength, foodSaturation, pickItemFor, def,
} from './src/engine/Blocks.ts';

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
check('hoe', matchRecipe(g9([P, P, 0, 0, S, 0, 0, S, 0]), 3)?.id === I.HOE);
check('hoe mirrored', matchRecipe(g9([0, P, P, 0, S, 0, 0, S, 0]), 3)?.id === I.HOE);
check('bread', matchRecipe(g9([I.WHEAT, I.WHEAT, I.WHEAT, 0, 0, 0, 0, 0, 0]), 3)?.id === I.BREAD);
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

// --- gameplay-track items: gold gear, shears, shield, spyglass, golden apples ---
const AU = I.GOLD_INGOT, GB = B.GOLD_BLOCK, AP = I.APPLE, AM = I.AMETHYST;
check('golden pickaxe', matchRecipe(g9([AU, AU, AU, 0, S, 0, 0, S, 0]), 3)?.id === I.GOLD_PICK);
check('golden sword', matchRecipe(g9([0, AU, 0, 0, AU, 0, 0, S, 0]), 3)?.id === I.GOLD_SWORD);
check('golden helmet', matchRecipe(g9([AU, AU, AU, AU, 0, AU, 0, 0, 0]), 3)?.id === I.GOLD_HELMET);
check('golden chestplate', matchRecipe(g9([AU, 0, AU, AU, AU, AU, AU, AU, AU]), 3)?.id === I.GOLD_CHEST);
check('golden boots', matchRecipe(g9([0, 0, 0, AU, 0, AU, AU, 0, AU]), 3)?.id === I.GOLD_BOOTS);
check('shears (2x2)', matchRecipe(g4(0, FE, FE, 0), 2)?.id === I.SHEARS);
check('shears mirrored', matchRecipe(g4(FE, 0, 0, FE), 2)?.id === I.SHEARS);
check('shield', matchRecipe(g9([P, FE, P, P, P, P, 0, P, 0]), 3)?.id === I.SHIELD);
check('spyglass', matchRecipe(g9([0, AM, 0, 0, FE, 0, 0, FE, 0]), 3)?.id === I.SPYGLASS);
check('golden apple', matchRecipe(g9([AU, AU, AU, AU, AP, AU, AU, AU, AU]), 3)?.id === I.GOLDEN_APPLE);
check('enchanted golden apple', matchRecipe(g9([GB, GB, GB, GB, AP, GB, GB, GB, GB]), 3)?.id === I.ENCHANTED_GOLDEN_APPLE);
check('gold ring w/o apple is not an apple', matchRecipe(g9([AU, AU, AU, AU, 0, AU, AU, AU, AU]), 3)?.id !== I.GOLDEN_APPLE);
check('clock still matches', matchRecipe(g9([0, AU, 0, AU, FE, AU, 0, AU, 0]), 3)?.id === I.CLOCK);

// --- extra smelting + lava-bucket fuel ---
check('birch log -> charcoal', smeltResult(B.BIRCH_LOG) === I.COAL);
check('jungle log -> charcoal', smeltResult(B.JUNGLE_LOG) === I.COAL);
check('diamond ore -> diamond', smeltResult(B.DIAMOND_ORE) === I.DIAMOND);
const lf = new FurnaceState();
lf.input = { id: B.COBBLE, count: 64 };
lf.fuel = { id: I.LAVA_BUCKET, count: 1 };
lf.tick(0.05);
check('lava bucket burns and leaves the bucket', lf.fuel?.id === I.BUCKET && lf.burn > 900);

// --- tool speeds: gold is fastest but harvests like wood; shears + swords on leaves ---
check('gold pick beats diamond on stone', breakTime(B.STONE, I.GOLD_PICK) < breakTime(B.STONE, I.DIAMOND_PICK));
check('gold pick harvests stone', canHarvest(B.STONE, I.GOLD_PICK));
check('gold pick cannot harvest iron', !canHarvest(B.IRON_ORE, I.GOLD_PICK));
check('shears shred leaves 15x', Math.abs(breakTime(B.LEAVES, I.SHEARS) - breakTime(B.LEAVES, 0) / 15) < 1e-9);
check('shears cut wool 5x', Math.abs(breakTime(B.WOOL, I.SHEARS) - breakTime(B.WOOL, 0) / 5) < 1e-9);
check('sword on leaves 1.5x', Math.abs(breakTime(B.JUNGLE_LEAVES, I.IRON_SWORD) - breakTime(B.JUNGLE_LEAVES, 0) / 1.5) < 1e-9);
check('shears no help on dirt', breakTime(B.DIRT, I.SHEARS) === breakTime(B.DIRT, 0));

// --- combat + food helpers ---
check('fist recharges in 0.25s', attackCooldown(0) === 0.25);
check('sword recharges in 0.625s', attackCooldown(I.DIAMOND_SWORD) === 0.625);
check('axes swing slower than swords', attackCooldown(I.WOOD_AXE) > attackCooldown(I.WOOD_SWORD));
check('uncharged swing = 20%', Math.abs(attackStrength(0) - 0.2) < 1e-9);
check('full swing = 100%', attackStrength(1) === 1 && attackStrength(5) === 1);
check('golden carrot saturation 14.4', Math.abs(foodSaturation(I.GOLDEN_CARROT) - 14.4) < 1e-9);
check('steak saturation 12.8', Math.abs(foodSaturation(I.COOKED_BEEF) - 12.8) < 1e-9);
check('golden apples always edible', !!def(I.GOLDEN_APPLE).alwaysEdible && !!def(I.MILK_BUCKET).alwaysEdible);
check('bread is not always edible', !def(I.BREAD).alwaysEdible);

// --- shift-click routing into a furnace ---
check('ore shift-clicks to furnace input', furnaceSlotFor(B.IRON_ORE) === 'input');
check('logs smelt before they burn', furnaceSlotFor(B.LOG) === 'input');
check('coal shift-clicks to fuel', furnaceSlotFor(I.COAL) === 'fuel');
check('lava bucket shift-clicks to fuel', furnaceSlotFor(I.LAVA_BUCKET) === 'fuel');
check('diamond sword stays put', furnaceSlotFor(I.DIAMOND_SWORD) === null);

// --- pick block ---
check('pick lit furnace -> furnace', pickItemFor(B.FURNACE_LIT) === B.FURNACE);
check('pick door half -> door item', pickItemFor(B.DOOR_UPPER) === I.WOOD_DOOR);
check('pick wheat -> seeds', pickItemFor(B.WHEAT_2) === I.SEEDS);
check('pick redstone wire -> dust', pickItemFor(B.REDSTONE_WIRE) === I.REDSTONE);
check('pick water -> nothing', pickItemFor(B.WATER) === 0);
check('pick stone -> stone', pickItemFor(B.STONE) === B.STONE);

console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
process.exit(failures ? 1 : 0);
