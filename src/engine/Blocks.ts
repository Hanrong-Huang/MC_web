// Block + item registry: the single source of truth for every id in the game.

export enum B {
  AIR = 0,
  GRASS = 1,
  DIRT = 2,
  STONE = 3,
  COBBLE = 4,
  SAND = 5,
  LOG = 6,
  PLANKS = 7,
  LEAVES = 8,
  GLASS = 9,
  WATER = 10,
  TABLE = 11,
  FURNACE = 12,
  FURNACE_LIT = 13,
  SNOW_GRASS = 14,
  BEDROCK = 15,
  COAL_ORE = 16,
  IRON_ORE = 17,
  GOLD_ORE = 18,
  DIAMOND_ORE = 19,
  GRAVEL = 20,
  SANDSTONE = 21,
  STONE_BRICKS = 22,
  WOOL = 23,
  IRON_BLOCK = 24,
  GOLD_BLOCK = 25,
  DIAMOND_BLOCK = 26,
  TNT = 27,
  BED = 28,
  TORCH = 29,
  CHEST = 30,
  BIRCH_LOG = 31,
  SPRUCE_LOG = 32,
  BIRCH_LEAVES = 33,
  SPRUCE_LEAVES = 34,
  POPPY = 35,
  DANDELION = 36,
  TALL_GRASS = 37,
  CACTUS = 38,
  SUGAR_CANE = 39,
  /** generated chest that rolls loot the first time it is opened */
  CHEST_LOOT = 40,
  FARMLAND = 41,
  WHEAT_0 = 42,
  WHEAT_1 = 43,
  WHEAT_2 = 44,
  SAPLING = 45,
  /** closed wooden door (lower half) */
  DOOR_LOWER = 46,
  /** closed wooden door (upper half) */
  DOOR_UPPER = 47,
  LADDER = 48,
  TRAPDOOR = 49,
  CARROT_0 = 51,
  CARROT_1 = 52,
  CARROT_2 = 53,
  POTATO_0 = 54,
  POTATO_1 = 55,
  POTATO_2 = 56,
  BEETROOT_0 = 57,
  BEETROOT_1 = 58,
  BEETROOT_2 = 59,
}

export enum I {
  STICK = 100,
  COAL = 101,
  WOOD_PICK = 102,
  WOOD_AXE = 103,
  WOOD_SHOVEL = 104,
  WOOD_SWORD = 105,
  STONE_PICK = 106,
  STONE_AXE = 107,
  STONE_SHOVEL = 108,
  STONE_SWORD = 109,
  PORKCHOP = 110,
  COOKED_PORKCHOP = 111,
  CHICKEN = 112,
  COOKED_CHICKEN = 113,
  IRON_INGOT = 114,
  GOLD_INGOT = 115,
  DIAMOND = 116,
  FLINT = 117,
  FEATHER = 118,
  STRING = 119,
  GUNPOWDER = 120,
  MUTTON = 121,
  COOKED_MUTTON = 122,
  BEEF = 123,
  COOKED_BEEF = 124,
  ROTTEN_FLESH = 125,
  APPLE = 126,
  ARROW = 127,
  BOW = 128,
  IRON_PICK = 129,
  IRON_AXE = 130,
  IRON_SHOVEL = 131,
  IRON_SWORD = 132,
  DIAMOND_PICK = 133,
  DIAMOND_AXE = 134,
  DIAMOND_SHOVEL = 135,
  DIAMOND_SWORD = 136,
  SEEDS = 137,
  WHEAT = 138,
  BREAD = 139,
  HOE = 140,
  WOOD_DOOR = 141,
  BONE = 142,
  EMERALD = 143,
  FISHING_ROD = 144,
  RAW_FISH = 145,
  COOKED_FISH = 146,
  COMPASS = 147,
  CLOCK = 148,
  CARROT = 149,
  POTATO = 150,
  BAKED_POTATO = 151,
  BEETROOT = 152,
  BEETROOT_SEEDS = 153,
  BOWL = 154,
  BEETROOT_SOUP = 155,
  VEGETABLE_STEW = 156,
  GOLDEN_CARROT = 157,
  BONE_MEAL = 158,
  LEATHER = 159,
  SADDLE = 160,
  HORSE_ARMOR = 161,
  LEATHER_HELMET = 162,
  LEATHER_CHEST = 163,
  LEATHER_LEGS = 164,
  LEATHER_BOOTS = 165,
  IRON_HELMET = 166,
  IRON_CHEST = 167,
  IRON_LEGS = 168,
  IRON_BOOTS = 169,
  DIAMOND_HELMET = 170,
  DIAMOND_CHEST = 171,
  DIAMOND_LEGS = 172,
  DIAMOND_BOOTS = 173,
}

/** Wearable-armor slot index: 0 head, 1 chest, 2 legs, 3 feet. */
export const ARMOR_HEAD = 0, ARMOR_CHEST = 1, ARMOR_LEGS = 2, ARMOR_FEET = 3;

/** extra block ids beyond the base range */
export enum B2 {
  EMERALD_BLOCK = 50,
}

export type SoundClass = 'stone' | 'wood' | 'grass' | 'sand' | 'glass' | 'none';
export type ToolKind = 'pickaxe' | 'axe' | 'shovel' | 'sword' | 'hoe';

export interface Def {
  id: number;
  name: string;          // internal + resource-pack texture stem
  label: string;         // display name
  block: boolean;
  solid: boolean;        // collides
  opaque: boolean;       // fully hides faces behind it
  liquid: boolean;
  occludes: boolean;     // contributes to ambient occlusion
  hardness: number;      // seconds-ish base; -1 = unbreakable
  tool?: Exclude<ToolKind, 'sword'>; // effective tool class
  /** minimum tool tier (2=wood, 4=stone, 6=iron, 8=diamond) required for drops */
  minTier?: number;
  sound: SoundClass;
  faces?: { top: string; bottom: string; sides: string; front?: string };
  /** undefined = drops itself; null = drops nothing */
  drop?: { id: number; min: number; max: number } | null;
  toolInfo?: { kind: ToolKind; tier: number; damage: number };
  durability?: number;   // for tools and bows
  bow?: boolean;
  /** wearable armor: slot index (0 head … 3 feet) + defense points (2 = one armor icon) */
  armor?: { slot: number; points: number };
  food?: number;         // hunger points restored
  fuel?: number;         // burn seconds in a furnace
  stack: number;
  sprite?: string;       // 16x16 item sprite name (non-block items)
}

const DEFS = new Map<number, Def>();

function blockDef(d: Partial<Def> & { id: number; name: string; label: string; hardness: number; sound: SoundClass; faces: Def['faces'] }): void {
  DEFS.set(d.id, {
    block: true, solid: true, opaque: true, liquid: false, occludes: true,
    stack: 64, ...d,
  } as Def);
}

function itemDef(d: Partial<Def> & { id: number; name: string; label: string; sprite: string }): void {
  DEFS.set(d.id, {
    block: false, solid: false, opaque: false, liquid: false, occludes: false,
    hardness: 0, sound: 'none', stack: 64, ...d,
  } as Def);
}

blockDef({
  id: B.GRASS, name: 'grass_block', label: 'Grass Block', hardness: 0.6, tool: 'shovel', sound: 'grass',
  faces: { top: 'grass_top', bottom: 'dirt', sides: 'grass_side' },
  drop: { id: B.DIRT, min: 1, max: 1 },
});
blockDef({
  id: B.DIRT, name: 'dirt', label: 'Dirt', hardness: 0.5, tool: 'shovel', sound: 'grass',
  faces: { top: 'dirt', bottom: 'dirt', sides: 'dirt' },
});
blockDef({
  id: B.STONE, name: 'stone', label: 'Stone', hardness: 1.5, tool: 'pickaxe', minTier: 2, sound: 'stone',
  faces: { top: 'stone', bottom: 'stone', sides: 'stone' },
  drop: { id: B.COBBLE, min: 1, max: 1 },
});
blockDef({
  id: B.COBBLE, name: 'cobblestone', label: 'Cobblestone', hardness: 2, tool: 'pickaxe', minTier: 2, sound: 'stone',
  faces: { top: 'cobble', bottom: 'cobble', sides: 'cobble' },
});
blockDef({
  id: B.SAND, name: 'sand', label: 'Sand', hardness: 0.5, tool: 'shovel', sound: 'sand',
  faces: { top: 'sand', bottom: 'sand', sides: 'sand' },
});
blockDef({
  id: B.LOG, name: 'oak_log', label: 'Oak Log', hardness: 2, tool: 'axe', sound: 'wood', fuel: 15,
  faces: { top: 'log_top', bottom: 'log_top', sides: 'log_side' },
});
blockDef({
  id: B.PLANKS, name: 'oak_planks', label: 'Oak Planks', hardness: 2, tool: 'axe', sound: 'wood', fuel: 15,
  faces: { top: 'planks', bottom: 'planks', sides: 'planks' },
});
blockDef({
  id: B.LEAVES, name: 'oak_leaves', label: 'Oak Leaves', hardness: 0.2, sound: 'grass',
  opaque: false, occludes: true,
  faces: { top: 'leaves', bottom: 'leaves', sides: 'leaves' },
  drop: null, // handled specially: small chance of an apple
});
blockDef({
  id: B.GLASS, name: 'glass', label: 'Glass', hardness: 0.3, sound: 'glass',
  opaque: false, occludes: false,
  faces: { top: 'glass', bottom: 'glass', sides: 'glass' },
  drop: null,
});
blockDef({
  id: B.WATER, name: 'water', label: 'Water', hardness: -1, sound: 'none',
  solid: false, opaque: false, liquid: true, occludes: false,
  faces: { top: 'water', bottom: 'water', sides: 'water' },
  drop: null,
});
blockDef({
  id: B.TABLE, name: 'crafting_table', label: 'Crafting Table', hardness: 2.5, tool: 'axe', sound: 'wood', fuel: 15,
  faces: { top: 'table_top', bottom: 'planks', sides: 'table_side', front: 'table_front' },
});
blockDef({
  id: B.FURNACE, name: 'furnace', label: 'Furnace', hardness: 3.5, tool: 'pickaxe', minTier: 2, sound: 'stone',
  faces: { top: 'furnace_top', bottom: 'furnace_top', sides: 'furnace_side', front: 'furnace_front' },
});
blockDef({
  id: B.FURNACE_LIT, name: 'furnace_lit', label: 'Furnace', hardness: 3.5, tool: 'pickaxe', minTier: 2, sound: 'stone',
  faces: { top: 'furnace_top', bottom: 'furnace_top', sides: 'furnace_side', front: 'furnace_front_on' },
  drop: { id: B.FURNACE, min: 1, max: 1 },
});
blockDef({
  id: B.SNOW_GRASS, name: 'snow_grass', label: 'Snowy Grass', hardness: 0.6, tool: 'shovel', sound: 'grass',
  faces: { top: 'snow_top', bottom: 'dirt', sides: 'snow_side' },
  drop: { id: B.DIRT, min: 1, max: 1 },
});
blockDef({
  id: B.BEDROCK, name: 'bedrock', label: 'Bedrock', hardness: -1, sound: 'stone',
  faces: { top: 'bedrock', bottom: 'bedrock', sides: 'bedrock' },
  drop: null,
});
blockDef({
  id: B.COAL_ORE, name: 'coal_ore', label: 'Coal Ore', hardness: 3, tool: 'pickaxe', minTier: 2, sound: 'stone',
  faces: { top: 'coal_ore', bottom: 'coal_ore', sides: 'coal_ore' },
  drop: { id: I.COAL, min: 1, max: 2 },
});
blockDef({
  id: B.IRON_ORE, name: 'iron_ore', label: 'Iron Ore', hardness: 3, tool: 'pickaxe', minTier: 4, sound: 'stone',
  faces: { top: 'iron_ore', bottom: 'iron_ore', sides: 'iron_ore' },
});
blockDef({
  id: B.GOLD_ORE, name: 'gold_ore', label: 'Gold Ore', hardness: 3, tool: 'pickaxe', minTier: 6, sound: 'stone',
  faces: { top: 'gold_ore', bottom: 'gold_ore', sides: 'gold_ore' },
});
blockDef({
  id: B.DIAMOND_ORE, name: 'diamond_ore', label: 'Diamond Ore', hardness: 3, tool: 'pickaxe', minTier: 6, sound: 'stone',
  faces: { top: 'diamond_ore', bottom: 'diamond_ore', sides: 'diamond_ore' },
  drop: { id: I.DIAMOND, min: 1, max: 1 },
});
blockDef({
  id: B.GRAVEL, name: 'gravel', label: 'Gravel', hardness: 0.6, tool: 'shovel', sound: 'sand',
  faces: { top: 'gravel', bottom: 'gravel', sides: 'gravel' },
  // drop handled specially: 25% flint
});
blockDef({
  id: B.SANDSTONE, name: 'sandstone', label: 'Sandstone', hardness: 0.8, tool: 'pickaxe', minTier: 2, sound: 'stone',
  faces: { top: 'sandstone_top', bottom: 'sandstone_top', sides: 'sandstone_side' },
});
blockDef({
  id: B.STONE_BRICKS, name: 'stone_bricks', label: 'Stone Bricks', hardness: 1.5, tool: 'pickaxe', minTier: 2, sound: 'stone',
  faces: { top: 'stone_bricks', bottom: 'stone_bricks', sides: 'stone_bricks' },
});
blockDef({
  id: B.WOOL, name: 'white_wool', label: 'Wool', hardness: 0.8, sound: 'grass',
  faces: { top: 'wool', bottom: 'wool', sides: 'wool' },
});
blockDef({
  id: B.IRON_BLOCK, name: 'iron_block', label: 'Block of Iron', hardness: 5, tool: 'pickaxe', minTier: 4, sound: 'stone',
  faces: { top: 'iron_block', bottom: 'iron_block', sides: 'iron_block' },
});
blockDef({
  id: B.GOLD_BLOCK, name: 'gold_block', label: 'Block of Gold', hardness: 3, tool: 'pickaxe', minTier: 6, sound: 'stone',
  faces: { top: 'gold_block', bottom: 'gold_block', sides: 'gold_block' },
});
blockDef({
  id: B.DIAMOND_BLOCK, name: 'diamond_block', label: 'Block of Diamond', hardness: 5, tool: 'pickaxe', minTier: 6, sound: 'stone',
  faces: { top: 'diamond_block', bottom: 'diamond_block', sides: 'diamond_block' },
});
blockDef({
  id: B.TNT, name: 'tnt', label: 'TNT', hardness: 0, sound: 'grass',
  faces: { top: 'tnt_top', bottom: 'tnt_top', sides: 'tnt_side' },
});
blockDef({
  id: B.BED, name: 'bed', label: 'Bed', hardness: 0.3, sound: 'wood',
  faces: { top: 'bed_top', bottom: 'planks', sides: 'bed_side' },
});
blockDef({
  id: B.TORCH, name: 'torch', label: 'Torch', hardness: 0, sound: 'wood',
  solid: false, opaque: false, occludes: false,
  faces: { top: 'torch', bottom: 'torch', sides: 'torch' },
});
blockDef({
  id: B.CHEST, name: 'chest', label: 'Chest', hardness: 2.5, tool: 'axe', sound: 'wood', fuel: 15,
  faces: { top: 'chest_top', bottom: 'chest_top', sides: 'chest_side', front: 'chest_front' },
});
blockDef({
  id: B.CHEST_LOOT, name: 'chest_loot', label: 'Chest', hardness: 2.5, tool: 'axe', sound: 'wood',
  faces: { top: 'chest_top', bottom: 'chest_top', sides: 'chest_side', front: 'chest_front' },
  drop: { id: B.CHEST, min: 1, max: 1 },
});
blockDef({
  id: B.BIRCH_LOG, name: 'birch_log', label: 'Birch Log', hardness: 2, tool: 'axe', sound: 'wood', fuel: 15,
  faces: { top: 'birch_log_top', bottom: 'birch_log_top', sides: 'birch_log_side' },
});
blockDef({
  id: B.SPRUCE_LOG, name: 'spruce_log', label: 'Spruce Log', hardness: 2, tool: 'axe', sound: 'wood', fuel: 15,
  faces: { top: 'spruce_log_top', bottom: 'spruce_log_top', sides: 'spruce_log_side' },
});
blockDef({
  id: B.BIRCH_LEAVES, name: 'birch_leaves', label: 'Birch Leaves', hardness: 0.2, sound: 'grass',
  opaque: false, occludes: true,
  faces: { top: 'birch_leaves', bottom: 'birch_leaves', sides: 'birch_leaves' },
  drop: null,
});
blockDef({
  id: B.SPRUCE_LEAVES, name: 'spruce_leaves', label: 'Spruce Leaves', hardness: 0.2, sound: 'grass',
  opaque: false, occludes: true,
  faces: { top: 'spruce_leaves', bottom: 'spruce_leaves', sides: 'spruce_leaves' },
  drop: null,
});
blockDef({
  id: B.POPPY, name: 'poppy', label: 'Poppy', hardness: 0, sound: 'grass',
  solid: false, opaque: false, occludes: false,
  faces: { top: 'poppy', bottom: 'poppy', sides: 'poppy' },
});
blockDef({
  id: B.DANDELION, name: 'dandelion', label: 'Dandelion', hardness: 0, sound: 'grass',
  solid: false, opaque: false, occludes: false,
  faces: { top: 'dandelion', bottom: 'dandelion', sides: 'dandelion' },
});
blockDef({
  id: B.TALL_GRASS, name: 'short_grass', label: 'Grass', hardness: 0, sound: 'grass',
  solid: false, opaque: false, occludes: false,
  faces: { top: 'tall_grass', bottom: 'tall_grass', sides: 'tall_grass' },
  drop: null,
});
blockDef({
  id: B.CACTUS, name: 'cactus', label: 'Cactus', hardness: 0.4, sound: 'grass',
  opaque: false, occludes: true,
  faces: { top: 'cactus_top', bottom: 'cactus_top', sides: 'cactus_side' },
});
blockDef({
  id: B.SUGAR_CANE, name: 'sugar_cane', label: 'Sugar Cane', hardness: 0, sound: 'grass',
  solid: false, opaque: false, occludes: false,
  faces: { top: 'sugar_cane', bottom: 'sugar_cane', sides: 'sugar_cane' },
});
blockDef({
  id: B.FARMLAND, name: 'farmland', label: 'Farmland', hardness: 0.5, tool: 'shovel', sound: 'grass',
  faces: { top: 'farmland_top', bottom: 'dirt', sides: 'dirt' },
  drop: { id: B.DIRT, min: 1, max: 1 },
});
blockDef({
  id: B.WHEAT_0, name: 'wheat_stage0', label: 'Wheat', hardness: 0, sound: 'grass',
  solid: false, opaque: false, occludes: false,
  faces: { top: 'wheat_0', bottom: 'wheat_0', sides: 'wheat_0' },
  drop: null, // handled specially: seeds
});
blockDef({
  id: B.WHEAT_1, name: 'wheat_stage1', label: 'Wheat', hardness: 0, sound: 'grass',
  solid: false, opaque: false, occludes: false,
  faces: { top: 'wheat_1', bottom: 'wheat_1', sides: 'wheat_1' },
  drop: null,
});
blockDef({
  id: B.WHEAT_2, name: 'wheat_stage2', label: 'Wheat', hardness: 0, sound: 'grass',
  solid: false, opaque: false, occludes: false,
  faces: { top: 'wheat_2', bottom: 'wheat_2', sides: 'wheat_2' },
  drop: null, // handled specially: wheat + seeds
});
blockDef({
  id: B.CARROT_0, name: 'carrots_stage0', label: 'Carrots', hardness: 0, sound: 'grass',
  solid: false, opaque: false, occludes: false,
  faces: { top: 'carrot_0', bottom: 'carrot_0', sides: 'carrot_0' },
  drop: null,
});
blockDef({
  id: B.CARROT_1, name: 'carrots_stage1', label: 'Carrots', hardness: 0, sound: 'grass',
  solid: false, opaque: false, occludes: false,
  faces: { top: 'carrot_1', bottom: 'carrot_1', sides: 'carrot_1' },
  drop: null,
});
blockDef({
  id: B.CARROT_2, name: 'carrots_stage2', label: 'Carrots', hardness: 0, sound: 'grass',
  solid: false, opaque: false, occludes: false,
  faces: { top: 'carrot_2', bottom: 'carrot_2', sides: 'carrot_2' },
  drop: null,
});
blockDef({
  id: B.POTATO_0, name: 'potatoes_stage0', label: 'Potatoes', hardness: 0, sound: 'grass',
  solid: false, opaque: false, occludes: false,
  faces: { top: 'potato_0', bottom: 'potato_0', sides: 'potato_0' },
  drop: null,
});
blockDef({
  id: B.POTATO_1, name: 'potatoes_stage1', label: 'Potatoes', hardness: 0, sound: 'grass',
  solid: false, opaque: false, occludes: false,
  faces: { top: 'potato_1', bottom: 'potato_1', sides: 'potato_1' },
  drop: null,
});
blockDef({
  id: B.POTATO_2, name: 'potatoes_stage2', label: 'Potatoes', hardness: 0, sound: 'grass',
  solid: false, opaque: false, occludes: false,
  faces: { top: 'potato_2', bottom: 'potato_2', sides: 'potato_2' },
  drop: null,
});
blockDef({
  id: B.BEETROOT_0, name: 'beetroots_stage0', label: 'Beetroots', hardness: 0, sound: 'grass',
  solid: false, opaque: false, occludes: false,
  faces: { top: 'beetroot_0', bottom: 'beetroot_0', sides: 'beetroot_0' },
  drop: null,
});
blockDef({
  id: B.BEETROOT_1, name: 'beetroots_stage1', label: 'Beetroots', hardness: 0, sound: 'grass',
  solid: false, opaque: false, occludes: false,
  faces: { top: 'beetroot_1', bottom: 'beetroot_1', sides: 'beetroot_1' },
  drop: null,
});
blockDef({
  id: B.BEETROOT_2, name: 'beetroots_stage2', label: 'Beetroots', hardness: 0, sound: 'grass',
  solid: false, opaque: false, occludes: false,
  faces: { top: 'beetroot_2', bottom: 'beetroot_2', sides: 'beetroot_2' },
  drop: null,
});
blockDef({
  id: B.SAPLING, name: 'oak_sapling', label: 'Sapling', hardness: 0, sound: 'grass',
  solid: false, opaque: false, occludes: false,
  faces: { top: 'sapling', bottom: 'sapling', sides: 'sapling' },
});
// door halves (lower + upper); collision is conditional on the open bit, handled in Physics
blockDef({
  id: B.DOOR_LOWER, name: 'oak_door_bottom', label: 'Wooden Door', hardness: 1, tool: 'axe', sound: 'wood', fuel: 10,
  solid: false, opaque: false, occludes: false,
  faces: { top: 'door_top', bottom: 'door_top', sides: 'door_lower', front: 'door_lower' },
});
blockDef({
  id: B.DOOR_UPPER, name: 'oak_door_top', label: 'Wooden Door', hardness: 1, tool: 'axe', sound: 'wood', fuel: 10,
  solid: false, opaque: false, occludes: false,
  faces: { top: 'door_top', bottom: 'door_top', sides: 'door_upper', front: 'door_upper' },
  drop: null, // only the lower half drops a door item
});
blockDef({
  id: B.LADDER, name: 'ladder', label: 'Ladder', hardness: 0.4, tool: 'axe', sound: 'wood', fuel: 2,
  solid: false, opaque: false, occludes: false,
  faces: { top: 'ladder', bottom: 'ladder', sides: 'ladder', front: 'ladder' },
});
blockDef({
  id: B.TRAPDOOR, name: 'oak_trapdoor', label: 'Wooden Trapdoor', hardness: 1, tool: 'axe', sound: 'wood', fuel: 10,
  solid: false, opaque: false, occludes: false,
  faces: { top: 'trapdoor', bottom: 'trapdoor', sides: 'trapdoor' },
});

// --- items -------------------------------------------------------------------

itemDef({ id: I.STICK, name: 'stick', label: 'Stick', sprite: 'stick', fuel: 5 });
itemDef({ id: I.COAL, name: 'coal', label: 'Coal', sprite: 'coal', fuel: 80 });
itemDef({ id: I.IRON_INGOT, name: 'iron_ingot', label: 'Iron Ingot', sprite: 'iron_ingot' });
itemDef({ id: I.GOLD_INGOT, name: 'gold_ingot', label: 'Gold Ingot', sprite: 'gold_ingot' });
itemDef({ id: I.DIAMOND, name: 'diamond', label: 'Diamond', sprite: 'diamond' });
itemDef({ id: I.FLINT, name: 'flint', label: 'Flint', sprite: 'flint' });
itemDef({ id: I.FEATHER, name: 'feather', label: 'Feather', sprite: 'feather' });
itemDef({ id: I.STRING, name: 'string', label: 'String', sprite: 'string' });
itemDef({ id: I.GUNPOWDER, name: 'gunpowder', label: 'Gunpowder', sprite: 'gunpowder' });
itemDef({ id: I.ARROW, name: 'arrow', label: 'Arrow', sprite: 'arrow' });
itemDef({ id: I.BOW, name: 'bow', label: 'Bow', sprite: 'bow', stack: 1, bow: true, durability: 385 });

const TIERS = { wood: { tier: 2, dur: 60 }, stone: { tier: 4, dur: 132 }, iron: { tier: 6, dur: 251 }, diamond: { tier: 8, dur: 1562 } } as const;
function toolDef(id: number, mat: keyof typeof TIERS, kind: ToolKind, damage: number): void {
  const label = `${mat[0].toUpperCase()}${mat.slice(1)} ${kind[0].toUpperCase()}${kind.slice(1)}`;
  const matName = mat === 'wood' ? 'wooden' : mat;
  itemDef({
    id, name: `${matName}_${kind}`, label, sprite: `${mat}_${kind}`, stack: 1,
    toolInfo: { kind, tier: TIERS[mat].tier, damage }, durability: TIERS[mat].dur,
  });
}
toolDef(I.WOOD_PICK, 'wood', 'pickaxe', 2);
toolDef(I.WOOD_AXE, 'wood', 'axe', 3);
toolDef(I.WOOD_SHOVEL, 'wood', 'shovel', 2);
toolDef(I.WOOD_SWORD, 'wood', 'sword', 4);
toolDef(I.STONE_PICK, 'stone', 'pickaxe', 3);
toolDef(I.STONE_AXE, 'stone', 'axe', 4);
toolDef(I.STONE_SHOVEL, 'stone', 'shovel', 3);
toolDef(I.STONE_SWORD, 'stone', 'sword', 5);
toolDef(I.IRON_PICK, 'iron', 'pickaxe', 4);
toolDef(I.IRON_AXE, 'iron', 'axe', 5);
toolDef(I.IRON_SHOVEL, 'iron', 'shovel', 4);
toolDef(I.IRON_SWORD, 'iron', 'sword', 6);
toolDef(I.DIAMOND_PICK, 'diamond', 'pickaxe', 5);
toolDef(I.DIAMOND_AXE, 'diamond', 'axe', 6);
toolDef(I.DIAMOND_SHOVEL, 'diamond', 'shovel', 5);
toolDef(I.DIAMOND_SWORD, 'diamond', 'sword', 7);

itemDef({ id: I.PORKCHOP, name: 'porkchop', label: 'Raw Porkchop', sprite: 'porkchop', food: 3 });
itemDef({ id: I.COOKED_PORKCHOP, name: 'cooked_porkchop', label: 'Cooked Porkchop', sprite: 'cooked_porkchop', food: 8 });
itemDef({ id: I.CHICKEN, name: 'chicken', label: 'Raw Chicken', sprite: 'chicken', food: 2 });
itemDef({ id: I.COOKED_CHICKEN, name: 'cooked_chicken', label: 'Cooked Chicken', sprite: 'cooked_chicken', food: 6 });
itemDef({ id: I.MUTTON, name: 'mutton', label: 'Raw Mutton', sprite: 'mutton', food: 2 });
itemDef({ id: I.COOKED_MUTTON, name: 'cooked_mutton', label: 'Cooked Mutton', sprite: 'cooked_mutton', food: 6 });
itemDef({ id: I.BEEF, name: 'beef', label: 'Raw Beef', sprite: 'beef', food: 3 });
itemDef({ id: I.COOKED_BEEF, name: 'cooked_beef', label: 'Steak', sprite: 'cooked_beef', food: 8 });
itemDef({ id: I.ROTTEN_FLESH, name: 'rotten_flesh', label: 'Rotten Flesh', sprite: 'rotten_flesh', food: 2 });
itemDef({ id: I.APPLE, name: 'apple', label: 'Apple', sprite: 'apple', food: 4 });
itemDef({ id: I.SEEDS, name: 'wheat_seeds', label: 'Seeds', sprite: 'seeds' });
itemDef({ id: I.WHEAT, name: 'wheat', label: 'Wheat', sprite: 'wheat' });
itemDef({ id: I.BREAD, name: 'bread', label: 'Bread', sprite: 'bread', food: 5 });
itemDef({ id: I.CARROT, name: 'carrot', label: 'Carrot', sprite: 'carrot', food: 3 });
itemDef({ id: I.POTATO, name: 'potato', label: 'Potato', sprite: 'potato', food: 1 });
itemDef({ id: I.BAKED_POTATO, name: 'baked_potato', label: 'Baked Potato', sprite: 'baked_potato', food: 5 });
itemDef({ id: I.BEETROOT, name: 'beetroot', label: 'Beetroot', sprite: 'beetroot', food: 1 });
itemDef({ id: I.BEETROOT_SEEDS, name: 'beetroot_seeds', label: 'Beetroot Seeds', sprite: 'beetroot_seeds' });
itemDef({ id: I.BOWL, name: 'bowl', label: 'Bowl', sprite: 'bowl', stack: 16, fuel: 2 });
itemDef({ id: I.BEETROOT_SOUP, name: 'beetroot_soup', label: 'Beetroot Soup', sprite: 'beetroot_soup', food: 6, stack: 1 });
itemDef({ id: I.VEGETABLE_STEW, name: 'vegetable_stew', label: 'Vegetable Stew', sprite: 'vegetable_stew', food: 8, stack: 1 });
itemDef({ id: I.GOLDEN_CARROT, name: 'golden_carrot', label: 'Golden Carrot', sprite: 'golden_carrot', food: 6 });
itemDef({
  id: I.HOE, name: 'wooden_hoe', label: 'Hoe', sprite: 'hoe', stack: 1,
  toolInfo: { kind: 'hoe', tier: 2, damage: 1 }, durability: 120,
});
// A door "item" places the lower half; the engine spawns the upper half above it.
itemDef({ id: I.WOOD_DOOR, name: 'oak_door', label: 'Wooden Door', sprite: 'wood_door' });
// new items
itemDef({ id: I.BONE, name: 'bone', label: 'Bone', sprite: 'bone' });
itemDef({ id: I.BONE_MEAL, name: 'bone_meal', label: 'Bone Meal', sprite: 'bone_meal' });
itemDef({ id: I.LEATHER, name: 'leather', label: 'Leather', sprite: 'leather' });
itemDef({ id: I.SADDLE, name: 'saddle', label: 'Saddle', sprite: 'saddle', stack: 1 });
itemDef({ id: I.HORSE_ARMOR, name: 'iron_horse_armor', label: 'Iron Horse Armor', sprite: 'horse_armor', stack: 1 });
itemDef({ id: I.EMERALD, name: 'emerald', label: 'Emerald', sprite: 'emerald' });
itemDef({
  id: I.FISHING_ROD, name: 'fishing_rod', label: 'Fishing Rod', sprite: 'fishing_rod', stack: 1,
  durability: 64,
});
itemDef({ id: I.RAW_FISH, name: 'cod', label: 'Raw Fish', sprite: 'raw_fish', food: 2 });
itemDef({ id: I.COOKED_FISH, name: 'cooked_cod', label: 'Cooked Fish', sprite: 'cooked_fish', food: 5 });
itemDef({ id: I.COMPASS, name: 'compass', label: 'Compass', sprite: 'compass', stack: 1 });
itemDef({ id: I.CLOCK, name: 'clock', label: 'Clock', sprite: 'clock', stack: 1 });

// wearable armor — points are MC values (2 points = one armor icon)
function armorDef(id: number, name: string, label: string, sprite: string, slot: number, points: number, durability: number): void {
  itemDef({ id, name, label, sprite, stack: 1, durability, armor: { slot, points } });
}
armorDef(I.LEATHER_HELMET, 'leather_helmet', 'Leather Cap', 'leather_helmet', ARMOR_HEAD, 1, 55);
armorDef(I.LEATHER_CHEST, 'leather_chestplate', 'Leather Tunic', 'leather_chest', ARMOR_CHEST, 3, 80);
armorDef(I.LEATHER_LEGS, 'leather_leggings', 'Leather Pants', 'leather_legs', ARMOR_LEGS, 2, 75);
armorDef(I.LEATHER_BOOTS, 'leather_boots', 'Leather Boots', 'leather_boots', ARMOR_FEET, 1, 65);
armorDef(I.IRON_HELMET, 'iron_helmet', 'Iron Helmet', 'iron_helmet', ARMOR_HEAD, 2, 165);
armorDef(I.IRON_CHEST, 'iron_chestplate', 'Iron Chestplate', 'iron_chest', ARMOR_CHEST, 6, 240);
armorDef(I.IRON_LEGS, 'iron_leggings', 'Iron Leggings', 'iron_legs', ARMOR_LEGS, 5, 225);
armorDef(I.IRON_BOOTS, 'iron_boots', 'Iron Boots', 'iron_boots', ARMOR_FEET, 2, 195);
armorDef(I.DIAMOND_HELMET, 'diamond_helmet', 'Diamond Helmet', 'diamond_helmet', ARMOR_HEAD, 3, 363);
armorDef(I.DIAMOND_CHEST, 'diamond_chestplate', 'Diamond Chestplate', 'diamond_chest', ARMOR_CHEST, 8, 528);
armorDef(I.DIAMOND_LEGS, 'diamond_leggings', 'Diamond Leggings', 'diamond_legs', ARMOR_LEGS, 6, 495);
armorDef(I.DIAMOND_BOOTS, 'diamond_boots', 'Diamond Boots', 'diamond_boots', ARMOR_FEET, 3, 429);

export function def(id: number): Def {
  const d = DEFS.get(id);
  if (!d) throw new Error(`Unknown id ${id}`);
  return d;
}
export function hasDef(id: number): boolean { return DEFS.has(id); }
export function allDefs(): Def[] { return [...DEFS.values()]; }

export function isSolid(id: number): boolean { return id !== B.AIR && def(id).solid; }
export function isOpaque(id: number): boolean { return id !== B.AIR && def(id).opaque; }
export function isLiquid(id: number): boolean { return id === B.WATER; }
export function occludes(id: number): boolean { return id !== B.AIR && def(id).occludes; }

/** Fast lookup table for the light flood fill (1 = blocks light). */
export const OPAQUE_LUT = new Uint8Array(256);
for (const d of DEFS.values()) {
  if (d.block && d.opaque) OPAQUE_LUT[d.id] = 1;
}

export const GRAVITY_BLOCKS = new Set<number>([B.SAND, B.GRAVEL]);

/** Rendered as two crossed billboards instead of a cube. */
export const CROSS_BLOCKS = new Set<number>([
  B.POPPY, B.DANDELION, B.TALL_GRASS, B.SUGAR_CANE,
  B.WHEAT_0, B.WHEAT_1, B.WHEAT_2, B.SAPLING,
  B.CARROT_0, B.CARROT_1, B.CARROT_2,
  B.POTATO_0, B.POTATO_1, B.POTATO_2,
  B.BEETROOT_0, B.BEETROOT_1, B.BEETROOT_2,
]);

/** Blocks that pop off when the block under them is removed.
 *  Sugar cane and cactus may also stack on themselves. */
export const FLOOR_BLOCKS = new Set<number>([
  B.TORCH, B.POPPY, B.DANDELION, B.TALL_GRASS, B.SUGAR_CANE, B.CACTUS,
  B.WHEAT_0, B.WHEAT_1, B.WHEAT_2, B.SAPLING,
  B.CARROT_0, B.CARROT_1, B.CARROT_2,
  B.POTATO_0, B.POTATO_1, B.POTATO_2,
  B.BEETROOT_0, B.BEETROOT_1, B.BEETROOT_2,
]);
export const SELF_STACKING = new Set<number>([B.SUGAR_CANE, B.CACTUS]);

/** Atlas tiles whose faces take the per-biome grass/foliage tint. */
export const TINTED_TILES = new Set<string>([
  'grass_top', 'leaves', 'birch_leaves', 'tall_grass',
  'carrot_0', 'carrot_1', 'potato_0', 'potato_1',
]);

/** Can the held item harvest drops from this block (tool-tier gate)? */
export function canHarvest(blockId: number, heldId: number): boolean {
  const bd = def(blockId);
  if (!bd.minTier) return true;
  if (heldId && hasDef(heldId)) {
    const ti = def(heldId).toolInfo;
    if (ti && bd.tool && ti.kind === bd.tool && ti.tier >= bd.minTier) return true;
  }
  return false;
}

/** Seconds to break `blockId` while holding `heldId` (0 = empty hand). */
export function breakTime(blockId: number, heldId: number): number {
  const bd = def(blockId);
  if (bd.hardness < 0) return Infinity;
  if (!canHarvest(blockId, heldId)) return bd.hardness * 5; // wrong tool tier
  let mult = 1;
  if (heldId && hasDef(heldId)) {
    const ti = def(heldId).toolInfo;
    if (ti && bd.tool && ti.kind === bd.tool) mult = ti.tier;
  }
  return (bd.hardness * 1.5) / mult;
}

export function attackDamage(heldId: number): number {
  if (heldId && hasDef(heldId)) {
    const ti = def(heldId).toolInfo;
    if (ti) return ti.damage;
  }
  return 1;
}

/** Blocks the player can place / that show in the creative panel. */
export const PLACEABLE: number[] = [
  B.GRASS, B.DIRT, B.STONE, B.COBBLE, B.SAND, B.GRAVEL, B.LOG, B.BIRCH_LOG, B.SPRUCE_LOG,
  B.PLANKS, B.LEAVES, B.BIRCH_LEAVES, B.SPRUCE_LEAVES,
  B.GLASS, B.TABLE, B.FURNACE, B.CHEST, B.TORCH, B.BED, B.TNT,
  B.SANDSTONE, B.STONE_BRICKS, B.WOOL, B.SNOW_GRASS,
  B.POPPY, B.DANDELION, B.TALL_GRASS, B.CACTUS, B.SUGAR_CANE, B.SAPLING, B.FARMLAND,
  B.COAL_ORE, B.IRON_ORE, B.GOLD_ORE, B.DIAMOND_ORE,
  B.IRON_BLOCK, B.GOLD_BLOCK, B.DIAMOND_BLOCK, B.BEDROCK,
  B.LADDER, B.TRAPDOOR,
];

export const CREATIVE_ITEMS: number[] = [
  ...PLACEABLE,
  I.STICK, I.COAL, I.IRON_INGOT, I.GOLD_INGOT, I.DIAMOND,
  I.FLINT, I.FEATHER, I.STRING, I.GUNPOWDER, I.ARROW, I.BOW,
  I.WOOD_PICK, I.WOOD_AXE, I.WOOD_SHOVEL, I.WOOD_SWORD,
  I.STONE_PICK, I.STONE_AXE, I.STONE_SHOVEL, I.STONE_SWORD,
  I.IRON_PICK, I.IRON_AXE, I.IRON_SHOVEL, I.IRON_SWORD,
  I.DIAMOND_PICK, I.DIAMOND_AXE, I.DIAMOND_SHOVEL, I.DIAMOND_SWORD,
  I.PORKCHOP, I.COOKED_PORKCHOP, I.CHICKEN, I.COOKED_CHICKEN,
  I.MUTTON, I.COOKED_MUTTON, I.BEEF, I.COOKED_BEEF, I.ROTTEN_FLESH, I.APPLE,
  I.SEEDS, I.WHEAT, I.BREAD, I.CARROT, I.POTATO, I.BAKED_POTATO,
  I.BEETROOT, I.BEETROOT_SEEDS, I.BOWL, I.BEETROOT_SOUP, I.VEGETABLE_STEW, I.GOLDEN_CARROT,
  I.HOE, I.WOOD_DOOR,
  I.BONE, I.BONE_MEAL, I.EMERALD, I.FISHING_ROD, I.RAW_FISH, I.COOKED_FISH, I.COMPASS, I.CLOCK,
  I.LEATHER, I.SADDLE, I.HORSE_ARMOR,
  I.LEATHER_HELMET, I.LEATHER_CHEST, I.LEATHER_LEGS, I.LEATHER_BOOTS,
  I.IRON_HELMET, I.IRON_CHEST, I.IRON_LEGS, I.IRON_BOOTS,
  I.DIAMOND_HELMET, I.DIAMOND_CHEST, I.DIAMOND_LEGS, I.DIAMOND_BOOTS,
];
