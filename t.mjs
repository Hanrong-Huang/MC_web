// src/engine/Persistence.ts
function rleEncode(data2) {
  const out = [];
  let i = 0;
  while (i < data2.length) {
    const id = data2[i];
    let run = 1;
    while (i + run < data2.length && data2[i + run] === id && run < 65535) run++;
    out.push(run & 255, run >> 8 & 255, id);
    i += run;
  }
  return new Uint8Array(out);
}
function rleDecode(buf, outLen) {
  const out = new Uint8Array(outLen);
  let o = 0;
  for (let i = 0; i + 2 < buf.length + 1 && i + 2 <= buf.length; i += 3) {
    const run = buf[i] | buf[i + 1] << 8;
    const id = buf[i + 2];
    if (id !== 0) out.fill(id, o, Math.min(outLen, o + run));
    o += run;
    if (o >= outLen) break;
  }
  return out;
}

// src/engine/Blocks.ts
var DEFS = /* @__PURE__ */ new Map();
function blockDef(d) {
  DEFS.set(d.id, {
    block: true,
    solid: true,
    opaque: true,
    liquid: false,
    occludes: true,
    stack: 64,
    ...d
  });
}
function itemDef(d) {
  DEFS.set(d.id, {
    block: false,
    solid: false,
    opaque: false,
    liquid: false,
    occludes: false,
    hardness: 0,
    sound: "none",
    stack: 64,
    ...d
  });
}
blockDef({
  id: 1 /* GRASS */,
  name: "grass_block",
  label: "Grass Block",
  hardness: 0.6,
  tool: "shovel",
  sound: "grass",
  faces: { top: "grass_top", bottom: "dirt", sides: "grass_side" },
  drop: { id: 2 /* DIRT */, min: 1, max: 1 }
});
blockDef({
  id: 2 /* DIRT */,
  name: "dirt",
  label: "Dirt",
  hardness: 0.5,
  tool: "shovel",
  sound: "grass",
  faces: { top: "dirt", bottom: "dirt", sides: "dirt" }
});
blockDef({
  id: 3 /* STONE */,
  name: "stone",
  label: "Stone",
  hardness: 1.5,
  tool: "pickaxe",
  minTier: 2,
  sound: "stone",
  faces: { top: "stone", bottom: "stone", sides: "stone" },
  drop: { id: 4 /* COBBLE */, min: 1, max: 1 }
});
blockDef({
  id: 4 /* COBBLE */,
  name: "cobblestone",
  label: "Cobblestone",
  hardness: 2,
  tool: "pickaxe",
  minTier: 2,
  sound: "stone",
  faces: { top: "cobble", bottom: "cobble", sides: "cobble" }
});
blockDef({
  id: 5 /* SAND */,
  name: "sand",
  label: "Sand",
  hardness: 0.5,
  tool: "shovel",
  sound: "sand",
  faces: { top: "sand", bottom: "sand", sides: "sand" }
});
blockDef({
  id: 6 /* LOG */,
  name: "oak_log",
  label: "Oak Log",
  hardness: 2,
  tool: "axe",
  sound: "wood",
  fuel: 15,
  faces: { top: "log_top", bottom: "log_top", sides: "log_side" }
});
blockDef({
  id: 7 /* PLANKS */,
  name: "oak_planks",
  label: "Oak Planks",
  hardness: 2,
  tool: "axe",
  sound: "wood",
  fuel: 15,
  faces: { top: "planks", bottom: "planks", sides: "planks" }
});
blockDef({
  id: 8 /* LEAVES */,
  name: "oak_leaves",
  label: "Oak Leaves",
  hardness: 0.2,
  sound: "grass",
  opaque: false,
  occludes: true,
  faces: { top: "leaves", bottom: "leaves", sides: "leaves" },
  drop: null
  // handled specially: small chance of an apple
});
blockDef({
  id: 9 /* GLASS */,
  name: "glass",
  label: "Glass",
  hardness: 0.3,
  sound: "glass",
  opaque: false,
  occludes: false,
  faces: { top: "glass", bottom: "glass", sides: "glass" },
  drop: null
});
blockDef({
  id: 10 /* WATER */,
  name: "water",
  label: "Water",
  hardness: -1,
  sound: "none",
  solid: false,
  opaque: false,
  liquid: true,
  occludes: false,
  faces: { top: "water", bottom: "water", sides: "water" },
  drop: null
});
blockDef({
  id: 11 /* TABLE */,
  name: "crafting_table",
  label: "Crafting Table",
  hardness: 2.5,
  tool: "axe",
  sound: "wood",
  fuel: 15,
  faces: { top: "table_top", bottom: "planks", sides: "table_side", front: "table_front" }
});
blockDef({
  id: 12 /* FURNACE */,
  name: "furnace",
  label: "Furnace",
  hardness: 3.5,
  tool: "pickaxe",
  minTier: 2,
  sound: "stone",
  faces: { top: "furnace_top", bottom: "furnace_top", sides: "furnace_side", front: "furnace_front" }
});
blockDef({
  id: 13 /* FURNACE_LIT */,
  name: "furnace_lit",
  label: "Furnace",
  hardness: 3.5,
  tool: "pickaxe",
  minTier: 2,
  sound: "stone",
  faces: { top: "furnace_top", bottom: "furnace_top", sides: "furnace_side", front: "furnace_front_on" },
  drop: { id: 12 /* FURNACE */, min: 1, max: 1 }
});
blockDef({
  id: 14 /* SNOW_GRASS */,
  name: "snow_grass",
  label: "Snowy Grass",
  hardness: 0.6,
  tool: "shovel",
  sound: "grass",
  faces: { top: "snow_top", bottom: "dirt", sides: "snow_side" },
  drop: { id: 2 /* DIRT */, min: 1, max: 1 }
});
blockDef({
  id: 15 /* BEDROCK */,
  name: "bedrock",
  label: "Bedrock",
  hardness: -1,
  sound: "stone",
  faces: { top: "bedrock", bottom: "bedrock", sides: "bedrock" },
  drop: null
});
blockDef({
  id: 16 /* COAL_ORE */,
  name: "coal_ore",
  label: "Coal Ore",
  hardness: 3,
  tool: "pickaxe",
  minTier: 2,
  sound: "stone",
  faces: { top: "coal_ore", bottom: "coal_ore", sides: "coal_ore" },
  drop: { id: 101 /* COAL */, min: 1, max: 2 }
});
blockDef({
  id: 17 /* IRON_ORE */,
  name: "iron_ore",
  label: "Iron Ore",
  hardness: 3,
  tool: "pickaxe",
  minTier: 4,
  sound: "stone",
  faces: { top: "iron_ore", bottom: "iron_ore", sides: "iron_ore" }
});
blockDef({
  id: 18 /* GOLD_ORE */,
  name: "gold_ore",
  label: "Gold Ore",
  hardness: 3,
  tool: "pickaxe",
  minTier: 6,
  sound: "stone",
  faces: { top: "gold_ore", bottom: "gold_ore", sides: "gold_ore" }
});
blockDef({
  id: 19 /* DIAMOND_ORE */,
  name: "diamond_ore",
  label: "Diamond Ore",
  hardness: 3,
  tool: "pickaxe",
  minTier: 6,
  sound: "stone",
  faces: { top: "diamond_ore", bottom: "diamond_ore", sides: "diamond_ore" },
  drop: { id: 116 /* DIAMOND */, min: 1, max: 1 }
});
blockDef({
  id: 20 /* GRAVEL */,
  name: "gravel",
  label: "Gravel",
  hardness: 0.6,
  tool: "shovel",
  sound: "sand",
  faces: { top: "gravel", bottom: "gravel", sides: "gravel" }
  // drop handled specially: 25% flint
});
blockDef({
  id: 21 /* SANDSTONE */,
  name: "sandstone",
  label: "Sandstone",
  hardness: 0.8,
  tool: "pickaxe",
  minTier: 2,
  sound: "stone",
  faces: { top: "sandstone_top", bottom: "sandstone_top", sides: "sandstone_side" }
});
blockDef({
  id: 22 /* STONE_BRICKS */,
  name: "stone_bricks",
  label: "Stone Bricks",
  hardness: 1.5,
  tool: "pickaxe",
  minTier: 2,
  sound: "stone",
  faces: { top: "stone_bricks", bottom: "stone_bricks", sides: "stone_bricks" }
});
blockDef({
  id: 23 /* WOOL */,
  name: "white_wool",
  label: "Wool",
  hardness: 0.8,
  sound: "grass",
  faces: { top: "wool", bottom: "wool", sides: "wool" }
});
blockDef({
  id: 24 /* IRON_BLOCK */,
  name: "iron_block",
  label: "Block of Iron",
  hardness: 5,
  tool: "pickaxe",
  minTier: 4,
  sound: "stone",
  faces: { top: "iron_block", bottom: "iron_block", sides: "iron_block" }
});
blockDef({
  id: 25 /* GOLD_BLOCK */,
  name: "gold_block",
  label: "Block of Gold",
  hardness: 3,
  tool: "pickaxe",
  minTier: 6,
  sound: "stone",
  faces: { top: "gold_block", bottom: "gold_block", sides: "gold_block" }
});
blockDef({
  id: 26 /* DIAMOND_BLOCK */,
  name: "diamond_block",
  label: "Block of Diamond",
  hardness: 5,
  tool: "pickaxe",
  minTier: 6,
  sound: "stone",
  faces: { top: "diamond_block", bottom: "diamond_block", sides: "diamond_block" }
});
blockDef({
  id: 27 /* TNT */,
  name: "tnt",
  label: "TNT",
  hardness: 0,
  sound: "grass",
  faces: { top: "tnt_top", bottom: "tnt_top", sides: "tnt_side" }
});
blockDef({
  id: 28 /* BED */,
  name: "bed",
  label: "Bed",
  hardness: 0.3,
  sound: "wood",
  faces: { top: "bed_top", bottom: "planks", sides: "bed_side" }
});
blockDef({
  id: 29 /* TORCH */,
  name: "torch",
  label: "Torch",
  hardness: 0,
  sound: "wood",
  solid: false,
  opaque: false,
  occludes: false,
  faces: { top: "torch", bottom: "torch", sides: "torch" }
});
blockDef({
  id: 30 /* CHEST */,
  name: "chest",
  label: "Chest",
  hardness: 2.5,
  tool: "axe",
  sound: "wood",
  fuel: 15,
  faces: { top: "chest_top", bottom: "chest_top", sides: "chest_side", front: "chest_front" }
});
blockDef({
  id: 40 /* CHEST_LOOT */,
  name: "chest_loot",
  label: "Chest",
  hardness: 2.5,
  tool: "axe",
  sound: "wood",
  faces: { top: "chest_top", bottom: "chest_top", sides: "chest_side", front: "chest_front" },
  drop: { id: 30 /* CHEST */, min: 1, max: 1 }
});
blockDef({
  id: 31 /* BIRCH_LOG */,
  name: "birch_log",
  label: "Birch Log",
  hardness: 2,
  tool: "axe",
  sound: "wood",
  fuel: 15,
  faces: { top: "birch_log_top", bottom: "birch_log_top", sides: "birch_log_side" }
});
blockDef({
  id: 32 /* SPRUCE_LOG */,
  name: "spruce_log",
  label: "Spruce Log",
  hardness: 2,
  tool: "axe",
  sound: "wood",
  fuel: 15,
  faces: { top: "spruce_log_top", bottom: "spruce_log_top", sides: "spruce_log_side" }
});
blockDef({
  id: 33 /* BIRCH_LEAVES */,
  name: "birch_leaves",
  label: "Birch Leaves",
  hardness: 0.2,
  sound: "grass",
  opaque: false,
  occludes: true,
  faces: { top: "birch_leaves", bottom: "birch_leaves", sides: "birch_leaves" },
  drop: null
});
blockDef({
  id: 34 /* SPRUCE_LEAVES */,
  name: "spruce_leaves",
  label: "Spruce Leaves",
  hardness: 0.2,
  sound: "grass",
  opaque: false,
  occludes: true,
  faces: { top: "spruce_leaves", bottom: "spruce_leaves", sides: "spruce_leaves" },
  drop: null
});
blockDef({
  id: 35 /* POPPY */,
  name: "poppy",
  label: "Poppy",
  hardness: 0,
  sound: "grass",
  solid: false,
  opaque: false,
  occludes: false,
  faces: { top: "poppy", bottom: "poppy", sides: "poppy" }
});
blockDef({
  id: 36 /* DANDELION */,
  name: "dandelion",
  label: "Dandelion",
  hardness: 0,
  sound: "grass",
  solid: false,
  opaque: false,
  occludes: false,
  faces: { top: "dandelion", bottom: "dandelion", sides: "dandelion" }
});
blockDef({
  id: 37 /* TALL_GRASS */,
  name: "short_grass",
  label: "Grass",
  hardness: 0,
  sound: "grass",
  solid: false,
  opaque: false,
  occludes: false,
  faces: { top: "tall_grass", bottom: "tall_grass", sides: "tall_grass" },
  drop: null
});
blockDef({
  id: 38 /* CACTUS */,
  name: "cactus",
  label: "Cactus",
  hardness: 0.4,
  sound: "grass",
  opaque: false,
  occludes: true,
  faces: { top: "cactus_top", bottom: "cactus_top", sides: "cactus_side" }
});
blockDef({
  id: 39 /* SUGAR_CANE */,
  name: "sugar_cane",
  label: "Sugar Cane",
  hardness: 0,
  sound: "grass",
  solid: false,
  opaque: false,
  occludes: false,
  faces: { top: "sugar_cane", bottom: "sugar_cane", sides: "sugar_cane" }
});
blockDef({
  id: 41 /* FARMLAND */,
  name: "farmland",
  label: "Farmland",
  hardness: 0.5,
  tool: "shovel",
  sound: "grass",
  faces: { top: "farmland_top", bottom: "dirt", sides: "dirt" },
  drop: { id: 2 /* DIRT */, min: 1, max: 1 }
});
blockDef({
  id: 42 /* WHEAT_0 */,
  name: "wheat_stage0",
  label: "Wheat",
  hardness: 0,
  sound: "grass",
  solid: false,
  opaque: false,
  occludes: false,
  faces: { top: "wheat_0", bottom: "wheat_0", sides: "wheat_0" },
  drop: null
  // handled specially: seeds
});
blockDef({
  id: 43 /* WHEAT_1 */,
  name: "wheat_stage1",
  label: "Wheat",
  hardness: 0,
  sound: "grass",
  solid: false,
  opaque: false,
  occludes: false,
  faces: { top: "wheat_1", bottom: "wheat_1", sides: "wheat_1" },
  drop: null
});
blockDef({
  id: 44 /* WHEAT_2 */,
  name: "wheat_stage2",
  label: "Wheat",
  hardness: 0,
  sound: "grass",
  solid: false,
  opaque: false,
  occludes: false,
  faces: { top: "wheat_2", bottom: "wheat_2", sides: "wheat_2" },
  drop: null
  // handled specially: wheat + seeds
});
blockDef({
  id: 45 /* SAPLING */,
  name: "oak_sapling",
  label: "Sapling",
  hardness: 0,
  sound: "grass",
  solid: false,
  opaque: false,
  occludes: false,
  faces: { top: "sapling", bottom: "sapling", sides: "sapling" }
});
blockDef({
  id: 46 /* DOOR_LOWER */,
  name: "oak_door_bottom",
  label: "Wooden Door",
  hardness: 1,
  tool: "axe",
  sound: "wood",
  fuel: 10,
  solid: false,
  opaque: false,
  occludes: false,
  faces: { top: "door_top", bottom: "door_top", sides: "door_lower", front: "door_lower" }
});
blockDef({
  id: 47 /* DOOR_UPPER */,
  name: "oak_door_top",
  label: "Wooden Door",
  hardness: 1,
  tool: "axe",
  sound: "wood",
  fuel: 10,
  solid: false,
  opaque: false,
  occludes: false,
  faces: { top: "door_top", bottom: "door_top", sides: "door_upper", front: "door_upper" },
  drop: null
  // only the lower half drops a door item
});
blockDef({
  id: 48 /* LADDER */,
  name: "ladder",
  label: "Ladder",
  hardness: 0.4,
  tool: "axe",
  sound: "wood",
  fuel: 2,
  solid: false,
  opaque: false,
  occludes: false,
  faces: { top: "ladder", bottom: "ladder", sides: "ladder", front: "ladder" }
});
blockDef({
  id: 49 /* TRAPDOOR */,
  name: "oak_trapdoor",
  label: "Wooden Trapdoor",
  hardness: 1,
  tool: "axe",
  sound: "wood",
  fuel: 10,
  solid: false,
  opaque: false,
  occludes: false,
  faces: { top: "trapdoor", bottom: "trapdoor", sides: "trapdoor" }
});
itemDef({ id: 100 /* STICK */, name: "stick", label: "Stick", sprite: "stick", fuel: 5 });
itemDef({ id: 101 /* COAL */, name: "coal", label: "Coal", sprite: "coal", fuel: 80 });
itemDef({ id: 114 /* IRON_INGOT */, name: "iron_ingot", label: "Iron Ingot", sprite: "iron_ingot" });
itemDef({ id: 115 /* GOLD_INGOT */, name: "gold_ingot", label: "Gold Ingot", sprite: "gold_ingot" });
itemDef({ id: 116 /* DIAMOND */, name: "diamond", label: "Diamond", sprite: "diamond" });
itemDef({ id: 117 /* FLINT */, name: "flint", label: "Flint", sprite: "flint" });
itemDef({ id: 118 /* FEATHER */, name: "feather", label: "Feather", sprite: "feather" });
itemDef({ id: 119 /* STRING */, name: "string", label: "String", sprite: "string" });
itemDef({ id: 120 /* GUNPOWDER */, name: "gunpowder", label: "Gunpowder", sprite: "gunpowder" });
itemDef({ id: 127 /* ARROW */, name: "arrow", label: "Arrow", sprite: "arrow" });
itemDef({ id: 128 /* BOW */, name: "bow", label: "Bow", sprite: "bow", stack: 1, bow: true, durability: 385 });
var TIERS = { wood: { tier: 2, dur: 60 }, stone: { tier: 4, dur: 132 }, iron: { tier: 6, dur: 251 }, diamond: { tier: 8, dur: 1562 } };
function toolDef(id, mat, kind, damage) {
  const label = `${mat[0].toUpperCase()}${mat.slice(1)} ${kind[0].toUpperCase()}${kind.slice(1)}`;
  const matName = mat === "wood" ? "wooden" : mat;
  itemDef({
    id,
    name: `${matName}_${kind}`,
    label,
    sprite: `${mat}_${kind}`,
    stack: 1,
    toolInfo: { kind, tier: TIERS[mat].tier, damage },
    durability: TIERS[mat].dur
  });
}
toolDef(102 /* WOOD_PICK */, "wood", "pickaxe", 2);
toolDef(103 /* WOOD_AXE */, "wood", "axe", 3);
toolDef(104 /* WOOD_SHOVEL */, "wood", "shovel", 2);
toolDef(105 /* WOOD_SWORD */, "wood", "sword", 4);
toolDef(106 /* STONE_PICK */, "stone", "pickaxe", 3);
toolDef(107 /* STONE_AXE */, "stone", "axe", 4);
toolDef(108 /* STONE_SHOVEL */, "stone", "shovel", 3);
toolDef(109 /* STONE_SWORD */, "stone", "sword", 5);
toolDef(129 /* IRON_PICK */, "iron", "pickaxe", 4);
toolDef(130 /* IRON_AXE */, "iron", "axe", 5);
toolDef(131 /* IRON_SHOVEL */, "iron", "shovel", 4);
toolDef(132 /* IRON_SWORD */, "iron", "sword", 6);
toolDef(133 /* DIAMOND_PICK */, "diamond", "pickaxe", 5);
toolDef(134 /* DIAMOND_AXE */, "diamond", "axe", 6);
toolDef(135 /* DIAMOND_SHOVEL */, "diamond", "shovel", 5);
toolDef(136 /* DIAMOND_SWORD */, "diamond", "sword", 7);
itemDef({ id: 110 /* PORKCHOP */, name: "porkchop", label: "Raw Porkchop", sprite: "porkchop", food: 3 });
itemDef({ id: 111 /* COOKED_PORKCHOP */, name: "cooked_porkchop", label: "Cooked Porkchop", sprite: "cooked_porkchop", food: 8 });
itemDef({ id: 112 /* CHICKEN */, name: "chicken", label: "Raw Chicken", sprite: "chicken", food: 2 });
itemDef({ id: 113 /* COOKED_CHICKEN */, name: "cooked_chicken", label: "Cooked Chicken", sprite: "cooked_chicken", food: 6 });
itemDef({ id: 121 /* MUTTON */, name: "mutton", label: "Raw Mutton", sprite: "mutton", food: 2 });
itemDef({ id: 122 /* COOKED_MUTTON */, name: "cooked_mutton", label: "Cooked Mutton", sprite: "cooked_mutton", food: 6 });
itemDef({ id: 123 /* BEEF */, name: "beef", label: "Raw Beef", sprite: "beef", food: 3 });
itemDef({ id: 124 /* COOKED_BEEF */, name: "cooked_beef", label: "Steak", sprite: "cooked_beef", food: 8 });
itemDef({ id: 125 /* ROTTEN_FLESH */, name: "rotten_flesh", label: "Rotten Flesh", sprite: "rotten_flesh", food: 2 });
itemDef({ id: 126 /* APPLE */, name: "apple", label: "Apple", sprite: "apple", food: 4 });
itemDef({ id: 137 /* SEEDS */, name: "wheat_seeds", label: "Seeds", sprite: "seeds" });
itemDef({ id: 138 /* WHEAT */, name: "wheat", label: "Wheat", sprite: "wheat" });
itemDef({ id: 139 /* BREAD */, name: "bread", label: "Bread", sprite: "bread", food: 5 });
itemDef({
  id: 140 /* HOE */,
  name: "wooden_hoe",
  label: "Hoe",
  sprite: "hoe",
  stack: 1,
  toolInfo: { kind: "hoe", tier: 2, damage: 1 },
  durability: 120
});
itemDef({ id: 141 /* WOOD_DOOR */, name: "oak_door", label: "Wooden Door", sprite: "wood_door" });
function def(id) {
  const d = DEFS.get(id);
  if (!d) throw new Error(`Unknown id ${id}`);
  return d;
}
function hasDef(id) {
  return DEFS.has(id);
}
var OPAQUE_LUT = new Uint8Array(256);
for (const d of DEFS.values()) {
  if (d.block && d.opaque) OPAQUE_LUT[d.id] = 1;
}
function canHarvest(blockId, heldId) {
  const bd = def(blockId);
  if (!bd.minTier) return true;
  if (heldId && hasDef(heldId)) {
    const ti = def(heldId).toolInfo;
    if (ti && bd.tool && ti.kind === bd.tool && ti.tier >= bd.minTier) return true;
  }
  return false;
}
function breakTime(blockId, heldId) {
  const bd = def(blockId);
  if (bd.hardness < 0) return Infinity;
  if (!canHarvest(blockId, heldId)) return bd.hardness * 5;
  let mult = 1;
  if (heldId && hasDef(heldId)) {
    const ti = def(heldId).toolInfo;
    if (ti && bd.tool && ti.kind === bd.tool) mult = ti.tier;
  }
  return bd.hardness * 1.5 / mult;
}
var PLACEABLE = [
  1 /* GRASS */,
  2 /* DIRT */,
  3 /* STONE */,
  4 /* COBBLE */,
  5 /* SAND */,
  20 /* GRAVEL */,
  6 /* LOG */,
  31 /* BIRCH_LOG */,
  32 /* SPRUCE_LOG */,
  7 /* PLANKS */,
  8 /* LEAVES */,
  33 /* BIRCH_LEAVES */,
  34 /* SPRUCE_LEAVES */,
  9 /* GLASS */,
  11 /* TABLE */,
  12 /* FURNACE */,
  30 /* CHEST */,
  29 /* TORCH */,
  28 /* BED */,
  27 /* TNT */,
  21 /* SANDSTONE */,
  22 /* STONE_BRICKS */,
  23 /* WOOL */,
  14 /* SNOW_GRASS */,
  35 /* POPPY */,
  36 /* DANDELION */,
  37 /* TALL_GRASS */,
  38 /* CACTUS */,
  39 /* SUGAR_CANE */,
  45 /* SAPLING */,
  41 /* FARMLAND */,
  16 /* COAL_ORE */,
  17 /* IRON_ORE */,
  18 /* GOLD_ORE */,
  19 /* DIAMOND_ORE */,
  24 /* IRON_BLOCK */,
  25 /* GOLD_BLOCK */,
  26 /* DIAMOND_BLOCK */,
  15 /* BEDROCK */,
  48 /* LADDER */,
  49 /* TRAPDOOR */
];
var CREATIVE_ITEMS = [
  ...PLACEABLE,
  100 /* STICK */,
  101 /* COAL */,
  114 /* IRON_INGOT */,
  115 /* GOLD_INGOT */,
  116 /* DIAMOND */,
  117 /* FLINT */,
  118 /* FEATHER */,
  119 /* STRING */,
  120 /* GUNPOWDER */,
  127 /* ARROW */,
  128 /* BOW */,
  102 /* WOOD_PICK */,
  103 /* WOOD_AXE */,
  104 /* WOOD_SHOVEL */,
  105 /* WOOD_SWORD */,
  106 /* STONE_PICK */,
  107 /* STONE_AXE */,
  108 /* STONE_SHOVEL */,
  109 /* STONE_SWORD */,
  129 /* IRON_PICK */,
  130 /* IRON_AXE */,
  131 /* IRON_SHOVEL */,
  132 /* IRON_SWORD */,
  133 /* DIAMOND_PICK */,
  134 /* DIAMOND_AXE */,
  135 /* DIAMOND_SHOVEL */,
  136 /* DIAMOND_SWORD */,
  110 /* PORKCHOP */,
  111 /* COOKED_PORKCHOP */,
  112 /* CHICKEN */,
  113 /* COOKED_CHICKEN */,
  121 /* MUTTON */,
  122 /* COOKED_MUTTON */,
  123 /* BEEF */,
  124 /* COOKED_BEEF */,
  125 /* ROTTEN_FLESH */,
  126 /* APPLE */,
  137 /* SEEDS */,
  138 /* WHEAT */,
  139 /* BREAD */,
  140 /* HOE */,
  141 /* WOOD_DOOR */
];

// src/engine/Inventory.ts
var P = 7 /* PLANKS */;
var C = 4 /* COBBLE */;
var S = 100 /* STICK */;
var FE = 114 /* IRON_INGOT */;
var AU = 115 /* GOLD_INGOT */;
var DI = 116 /* DIAMOND */;
var W = 23 /* WOOL */;
var G = 120 /* GUNPOWDER */;
var SA = 5 /* SAND */;
var ST = 119 /* STRING */;
function toolRecipes(mat, pick, axe, shovel, sword) {
  const M = mat;
  return [
    { shape: [[M, M, M], [0, S, 0], [0, S, 0]], out: pick, n: 1 },
    { shape: [[M, M], [M, S], [0, S]], out: axe, n: 1 },
    { shape: [[M], [S], [S]], out: shovel, n: 1 },
    { shape: [[M], [M], [S]], out: sword, n: 1 }
  ];
}
var RECIPES = [
  { shape: [[6 /* LOG */]], out: 7 /* PLANKS */, n: 4 },
  { shape: [[31 /* BIRCH_LOG */]], out: 7 /* PLANKS */, n: 4 },
  { shape: [[32 /* SPRUCE_LOG */]], out: 7 /* PLANKS */, n: 4 },
  { shape: [[P], [P]], out: 100 /* STICK */, n: 4 },
  { shape: [[P, P], [P, P]], out: 11 /* TABLE */, n: 1 },
  { shape: [[C, C, C], [C, 0, C], [C, C, C]], out: 12 /* FURNACE */, n: 1 },
  { shape: [[P, P, P], [P, 0, P], [P, P, P]], out: 30 /* CHEST */, n: 1 },
  ...toolRecipes(P, 102 /* WOOD_PICK */, 103 /* WOOD_AXE */, 104 /* WOOD_SHOVEL */, 105 /* WOOD_SWORD */),
  ...toolRecipes(C, 106 /* STONE_PICK */, 107 /* STONE_AXE */, 108 /* STONE_SHOVEL */, 109 /* STONE_SWORD */),
  ...toolRecipes(FE, 129 /* IRON_PICK */, 130 /* IRON_AXE */, 131 /* IRON_SHOVEL */, 132 /* IRON_SWORD */),
  ...toolRecipes(DI, 133 /* DIAMOND_PICK */, 134 /* DIAMOND_AXE */, 135 /* DIAMOND_SHOVEL */, 136 /* DIAMOND_SWORD */),
  // light + utility
  { shape: [[101 /* COAL */], [S]], out: 29 /* TORCH */, n: 4 },
  { shape: [[G, SA, G], [SA, G, SA], [G, SA, G]], out: 27 /* TNT */, n: 1 },
  { shape: [[W, W, W], [P, P, P]], out: 28 /* BED */, n: 1 },
  // ranged
  { shape: [[0, S, ST], [S, 0, ST], [0, S, ST]], out: 128 /* BOW */, n: 1 },
  { shape: [[117 /* FLINT */], [S], [118 /* FEATHER */]], out: 127 /* ARROW */, n: 4 },
  // farming
  { shape: [[P, P], [0, S], [0, S]], out: 140 /* HOE */, n: 1 },
  { shape: [[138 /* WHEAT */, 138 /* WHEAT */, 138 /* WHEAT */]], out: 139 /* BREAD */, n: 1 },
  // building materials
  { shape: [[SA, SA], [SA, SA]], out: 21 /* SANDSTONE */, n: 1 },
  { shape: [[3 /* STONE */, 3 /* STONE */], [3 /* STONE */, 3 /* STONE */]], out: 22 /* STONE_BRICKS */, n: 4 },
  { shape: [[ST, ST], [ST, ST]], out: 23 /* WOOL */, n: 1 },
  // buildable interactivity
  { shape: [[P, P], [P, P], [P, P]], out: 141 /* WOOD_DOOR */, n: 3 },
  { shape: [[P, P, P], [P, P, P], [0, 0, 0]], out: 141 /* WOOD_DOOR */, n: 3 },
  { shape: [[P, P, P], [0, S, 0], [0, S, 0]], out: 48 /* LADDER */, n: 3 },
  { shape: [[P, P, P], [P, 0, P], [P, P, P]], out: 49 /* TRAPDOOR */, n: 2 },
  // resource blocks (and back)
  { shape: [[FE, FE, FE], [FE, FE, FE], [FE, FE, FE]], out: 24 /* IRON_BLOCK */, n: 1 },
  { shape: [[AU, AU, AU], [AU, AU, AU], [AU, AU, AU]], out: 25 /* GOLD_BLOCK */, n: 1 },
  { shape: [[DI, DI, DI], [DI, DI, DI], [DI, DI, DI]], out: 26 /* DIAMOND_BLOCK */, n: 1 },
  { shape: [[24 /* IRON_BLOCK */]], out: 114 /* IRON_INGOT */, n: 9 },
  { shape: [[25 /* GOLD_BLOCK */]], out: 115 /* GOLD_INGOT */, n: 9 },
  { shape: [[26 /* DIAMOND_BLOCK */]], out: 116 /* DIAMOND */, n: 9 }
];
function mirror(shape) {
  return shape.map((row) => [...row].reverse());
}
function cropGrid(grid, w) {
  const h = grid.length / w;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (grid[y * w + x]) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < 0) return null;
  const out = [];
  for (let y = minY; y <= maxY; y++) {
    const row = [];
    for (let x = minX; x <= maxX; x++) row.push(grid[y * w + x]?.id ?? 0);
    out.push(row);
  }
  return out;
}
function shapeEquals(a, b) {
  if (a.length !== b.length) return false;
  for (let y = 0; y < a.length; y++) {
    if (a[y].length !== b[y].length) return false;
    for (let x = 0; x < a[y].length; x++) if (a[y][x] !== b[y][x]) return false;
  }
  return true;
}
function matchRecipe(grid, w) {
  const cropped = cropGrid(grid, w);
  if (!cropped) return null;
  for (const r of RECIPES) {
    if (shapeEquals(cropped, r.shape) || shapeEquals(cropped, mirror(r.shape))) {
      return { id: r.out, count: r.n };
    }
  }
  return null;
}
var SMELT = /* @__PURE__ */ new Map([
  [5 /* SAND */, 9 /* GLASS */],
  [4 /* COBBLE */, 3 /* STONE */],
  [6 /* LOG */, 101 /* COAL */],
  [17 /* IRON_ORE */, 114 /* IRON_INGOT */],
  [18 /* GOLD_ORE */, 115 /* GOLD_INGOT */],
  [110 /* PORKCHOP */, 111 /* COOKED_PORKCHOP */],
  [112 /* CHICKEN */, 113 /* COOKED_CHICKEN */],
  [121 /* MUTTON */, 122 /* COOKED_MUTTON */],
  [123 /* BEEF */, 124 /* COOKED_BEEF */]
]);
function smeltResult(id) {
  return SMELT.get(id);
}
function fuelSeconds(id) {
  return hasDef(id) ? def(id).fuel ?? 0 : 0;
}
var SMELT_TIME = 10;
var FurnaceState = class _FurnaceState {
  type = "furnace";
  input = null;
  fuel = null;
  output = null;
  burn = 0;
  // seconds of fuel remaining
  burnTotal = 0;
  // total seconds of the current fuel item (for the flame bar)
  cook = 0;
  // seconds into the current smelt
  get burning() {
    return this.burn > 0;
  }
  /** Advance by dt seconds. Returns true if the lit-state may have changed. */
  tick(dt) {
    const wasLit = this.burning;
    const canSmelt = this.canSmelt();
    if (this.burn > 0) this.burn = Math.max(0, this.burn - dt);
    if (this.burn <= 0 && canSmelt && this.fuel) {
      const f2 = fuelSeconds(this.fuel.id);
      if (f2 > 0) {
        this.burn = f2;
        this.burnTotal = f2;
        this.fuel.count--;
        if (this.fuel.count <= 0) this.fuel = null;
      }
    }
    if (this.burn > 0 && canSmelt) {
      this.cook += dt;
      if (this.cook >= SMELT_TIME) {
        this.cook = 0;
        const out = smeltResult(this.input.id);
        if (!this.output) this.output = { id: out, count: 1 };
        else this.output.count++;
        this.input.count--;
        if (this.input.count <= 0) this.input = null;
      }
    } else {
      this.cook = Math.max(0, this.cook - dt * 2);
    }
    return wasLit !== this.burning;
  }
  canSmelt() {
    if (!this.input) return false;
    const out = smeltResult(this.input.id);
    if (out === void 0) return false;
    if (this.output && (this.output.id !== out || this.output.count >= def(out).stack)) return false;
    return true;
  }
  isEmpty() {
    return !this.input && !this.fuel && !this.output && this.burn <= 0;
  }
  serialize() {
    return {
      type: "furnace",
      input: this.input ? { ...this.input } : null,
      fuel: this.fuel ? { ...this.fuel } : null,
      output: this.output ? { ...this.output } : null,
      burn: this.burn,
      burnTotal: this.burnTotal,
      cook: this.cook
    };
  }
  static from(s) {
    const f2 = new _FurnaceState();
    f2.input = s.input ? { ...s.input } : null;
    f2.fuel = s.fuel ? { ...s.fuel } : null;
    f2.output = s.output ? { ...s.output } : null;
    f2.burn = s.burn;
    f2.burnTotal = s.burnTotal;
    f2.cook = s.cook;
    return f2;
  }
};
var CHEST_SIZE = 27;
var ChestState = class _ChestState {
  type = "chest";
  slots = new Array(CHEST_SIZE).fill(null);
  isEmpty() {
    return this.slots.every((s) => !s);
  }
  serialize() {
    return { type: "chest", slots: this.slots.map((s) => s ? { ...s } : null) };
  }
  static from(s) {
    const c = new _ChestState();
    for (let i = 0; i < Math.min(CHEST_SIZE, s.slots.length); i++) {
      const v = s.slots[i];
      if (v && hasDef(v.id) && v.count > 0) c.slots[i] = { ...v };
    }
    return c;
  }
};

// logic-test.ts
var failures = 0;
function check(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failures++;
}
var data = new Uint8Array(32768);
for (let i = 0; i < 5e3; i++) data[i] = 3;
for (let i = 5e3; i < 5100; i++) data[i] = i % 7 + 1;
data[32767] = 9;
var enc = rleEncode(data);
var dec = rleDecode(enc, data.length);
check("RLE roundtrip", dec.length === data.length && dec.every((v, i) => v === data[i]));
check("RLE compresses", enc.length < data.length / 10);
var g4 = (a, b, c, d) => [a, b, c, d].map((id) => id ? { id, count: 1 } : null);
check("log -> planks", matchRecipe(g4(6 /* LOG */, 0, 0, 0), 2)?.id === 7 /* PLANKS */);
check("log anywhere in grid", matchRecipe(g4(0, 0, 0, 6 /* LOG */), 2)?.id === 7 /* PLANKS */);
check("2 planks -> sticks", matchRecipe(g4(7 /* PLANKS */, 0, 7 /* PLANKS */, 0), 2)?.id === 100 /* STICK */);
check("4 planks -> table", matchRecipe(g4(7 /* PLANKS */, 7 /* PLANKS */, 7 /* PLANKS */, 7 /* PLANKS */), 2)?.id === 11 /* TABLE */);
check("coal + stick -> torches", matchRecipe(g4(101 /* COAL */, 0, 100 /* STICK */, 0), 2)?.id === 29 /* TORCH */);
check("4 sand -> sandstone", matchRecipe(g4(5 /* SAND */, 5 /* SAND */, 5 /* SAND */, 5 /* SAND */), 2)?.id === 21 /* SANDSTONE */);
check("4 string -> wool", matchRecipe(g4(119 /* STRING */, 119 /* STRING */, 119 /* STRING */, 119 /* STRING */), 2)?.id === 23 /* WOOL */);
check("2x2 cannot make pickaxe", matchRecipe(g4(7 /* PLANKS */, 7 /* PLANKS */, 7 /* PLANKS */, 0), 2) === null);
var g9 = (ids) => ids.map((id) => id ? { id, count: 1 } : null);
var P2 = 7 /* PLANKS */;
var S2 = 100 /* STICK */;
var C2 = 4 /* COBBLE */;
var FE2 = 114 /* IRON_INGOT */;
var DI2 = 116 /* DIAMOND */;
var G2 = 120 /* GUNPOWDER */;
var SA2 = 5 /* SAND */;
var ST2 = 119 /* STRING */;
var W2 = 23 /* WOOL */;
check("wood pickaxe", matchRecipe(g9([P2, P2, P2, 0, S2, 0, 0, S2, 0]), 3)?.id === 102 /* WOOD_PICK */);
check("stone pickaxe", matchRecipe(g9([C2, C2, C2, 0, S2, 0, 0, S2, 0]), 3)?.id === 106 /* STONE_PICK */);
check("iron pickaxe", matchRecipe(g9([FE2, FE2, FE2, 0, S2, 0, 0, S2, 0]), 3)?.id === 129 /* IRON_PICK */);
check("diamond sword", matchRecipe(g9([0, DI2, 0, 0, DI2, 0, 0, S2, 0]), 3)?.id === 136 /* DIAMOND_SWORD */);
check("axe mirrored", matchRecipe(g9([0, P2, P2, 0, S2, P2, 0, S2, 0]), 3)?.id === 103 /* WOOD_AXE */);
check("furnace", matchRecipe(g9([C2, C2, C2, C2, 0, C2, C2, C2, C2]), 3)?.id === 12 /* FURNACE */);
check("chest", matchRecipe(g9([P2, P2, P2, P2, 0, P2, P2, P2, P2]), 3)?.id === 30 /* CHEST */);
check("tnt", matchRecipe(g9([G2, SA2, G2, SA2, G2, SA2, G2, SA2, G2]), 3)?.id === 27 /* TNT */);
check("bed", matchRecipe(g9([W2, W2, W2, P2, P2, P2, 0, 0, 0]), 3)?.id === 28 /* BED */);
check("bow", matchRecipe(g9([0, S2, ST2, S2, 0, ST2, 0, S2, ST2]), 3)?.id === 128 /* BOW */);
check("bow mirrored", matchRecipe(g9([ST2, S2, 0, ST2, 0, S2, ST2, S2, 0]), 3)?.id === 128 /* BOW */);
check("arrows", matchRecipe(g9([0, 117 /* FLINT */, 0, 0, S2, 0, 0, 118 /* FEATHER */, 0]), 3)?.id === 127 /* ARROW */);
check("hoe", matchRecipe(g9([P2, P2, 0, 0, S2, 0, 0, S2, 0]), 3)?.id === 140 /* HOE */);
check("hoe mirrored", matchRecipe(g9([0, P2, P2, 0, S2, 0, 0, S2, 0]), 3)?.id === 140 /* HOE */);
check("bread", matchRecipe(g9([138 /* WHEAT */, 138 /* WHEAT */, 138 /* WHEAT */, 0, 0, 0, 0, 0, 0]), 3)?.id === 139 /* BREAD */);
check("iron block", matchRecipe(g9([FE2, FE2, FE2, FE2, FE2, FE2, FE2, FE2, FE2]), 3)?.id === 24 /* IRON_BLOCK */);
check("block -> 9 ingots", matchRecipe(g9([24 /* IRON_BLOCK */, 0, 0, 0, 0, 0, 0, 0, 0]), 3)?.count === 9);
check("junk no match", matchRecipe(g9([C2, 0, C2, 0, 0, 0, 0, 0, 0]), 3) === null);
check("iron ore -> ingot", smeltResult(17 /* IRON_ORE */) === 114 /* IRON_INGOT */);
check("beef -> steak", smeltResult(123 /* BEEF */) === 124 /* COOKED_BEEF */);
var f = new FurnaceState();
f.input = { id: 5 /* SAND */, count: 2 };
f.fuel = { id: 7 /* PLANKS */, count: 1 };
var litChanges = 0;
for (let t = 0; t < 15 / 0.05; t++) {
  if (f.tick(0.05)) litChanges++;
}
check("furnace lit toggled", litChanges >= 1);
check("sand smelted to glass", f.output?.id === 9 /* GLASS */ && f.output.count === 1);
check("fuel consumed", f.fuel === null);
for (let t = 0; t < 10 / 0.05; t++) f.tick(0.05);
check("burn limited by fuel", (f.output?.count ?? 0) === 1 && f.input?.count === 1);
var chest = new ChestState();
check("chest starts empty", chest.isEmpty());
chest.slots[3] = { id: 4 /* COBBLE */, count: 12 };
var restored = ChestState.from(chest.serialize());
check("chest roundtrip", restored.slots[3]?.id === 4 /* COBBLE */ && restored.slots[3]?.count === 12);
check("stone by hand 7.5s (no pick)", Math.abs(breakTime(3 /* STONE */, 0) - 7.5) < 1e-9);
check("stone w/ wood pick 1.125s", Math.abs(breakTime(3 /* STONE */, 102 /* WOOD_PICK */) - 1.125) < 1e-9);
check("stone w/ iron pick 0.375s", Math.abs(breakTime(3 /* STONE */, 129 /* IRON_PICK */) - 0.375) < 1e-9);
check("hand cannot harvest stone", !canHarvest(3 /* STONE */, 0));
check("wood pick harvests stone", canHarvest(3 /* STONE */, 102 /* WOOD_PICK */));
check("wood pick cannot harvest iron", !canHarvest(17 /* IRON_ORE */, 102 /* WOOD_PICK */));
check("stone pick harvests iron", canHarvest(17 /* IRON_ORE */, 106 /* STONE_PICK */));
check("stone pick cannot harvest diamond", !canHarvest(19 /* DIAMOND_ORE */, 106 /* STONE_PICK */));
check("iron pick harvests diamond", canHarvest(19 /* DIAMOND_ORE */, 129 /* IRON_PICK */));
check("dirt needs no tool", canHarvest(2 /* DIRT */, 0));
check("bedrock unbreakable", breakTime(15 /* BEDROCK */, 133 /* DIAMOND_PICK */) === Infinity);
console.log(failures ? `
${failures} FAILURES` : "\nALL PASS");
process.exit(failures ? 1 : 0);
