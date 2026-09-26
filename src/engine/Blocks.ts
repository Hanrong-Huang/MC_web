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
  LAVA = 60,
  OBSIDIAN = 62,
  PORTAL = 63,
  NETHERRACK = 64,
  GLOWSTONE = 65,
  SOUL_SAND = 66,
  QUARTZ_ORE = 67,
  REDSTONE_WIRE = 68,
  REDSTONE_LAMP = 69,
  REDSTONE_LAMP_LIT = 70,
  LEVER = 71,
  WOODEN_BUTTON = 72,
  STONE_BUTTON = 73,
  PISTON = 74,
  STICKY_PISTON = 75,
  PRESSURE_PLATE = 76,
  PISTON_HEAD = 77,
  MAGMA = 78,
  NETHER_BRICKS = 79,
  JUNGLE_LOG = 80,
  JUNGLE_LEAVES = 81,
  /** head half of a 2-block bed (foot half is B.BED) */
  BED_HEAD = 82,
  AMETHYST_ORE = 83,
  /** open flame from flint & steel / lightning; spreads over flammable blocks */
  FIRE = 99,
  BOOKSHELF = 98,
  /** cushions falls (80% less damage) */
  HAY_BALE = 97,
  COAL_BLOCK = 96,
  QUARTZ_BLOCK = 95,
  SMOOTH_STONE = 94,
  // --- building + decoration pass (ids 61, 84-93, 200+; chunk data is u8) ---
  /** carved pumpkin with a candle: a glowing block with a face (meta = facing) */
  JACK_O_LANTERN = 61,
  BRICKS = 84,
  CLAY = 85,
  MOSSY_COBBLE = 86,
  MOSSY_STONE_BRICKS = 87,
  CRACKED_STONE_BRICKS = 88,
  SNOW_BLOCK = 89,
  /** slippery; melts back to water when broken */
  ICE = 90,
  PACKED_ICE = 91,
  TERRACOTTA = 92,
  PUMPKIN = 93,
  MELON = 200,
  /** stems sprout a fruit on a free neighbouring cell once mature */
  PUMPKIN_STEM = 201,
  MELON_STEM = 202,
  RED_WOOL = 203,
  ORANGE_WOOL = 204,
  YELLOW_WOOL = 205,
  LIME_WOOL = 206,
  CYAN_WOOL = 207,
  BLUE_WOOL = 208,
  PURPLE_WOOL = 209,
  BLACK_WOOL = 210,
  CORNFLOWER = 211,
  ALLIUM = 212,
  OXEYE_DAISY = 213,
  BROWN_MUSHROOM = 214,
  RED_MUSHROOM = 215,
  /** hanging (meta 1) or standing iron lantern; a light source */
  LANTERN = 216,
  GLASS_PANE = 217,
  OAK_FENCE = 218,
  /** open/facing live in world.doorStates, like trapdoors */
  FENCE_GATE = 219,
  COBBLE_SLAB = 220,
  STONE_SLAB = 221,
  OAK_SLAB = 222,
  STONE_BRICK_SLAB = 223,
  BRICK_SLAB = 224,
  SANDSTONE_SLAB = 225,
  OAK_STAIRS = 226,
  COBBLE_STAIRS = 227,
  STONE_BRICK_STAIRS = 228,
  BRICK_STAIRS = 229,
  /** right-click with a worn tool: repair it with its material for a level */
  ANVIL = 230,
  /** right-click with a tool/armor/bow: spend levels + amethyst to enchant */
  ENCHANTING_TABLE = 231,
  /** a wooden storage cask (chest inventory) */
  BARREL = 232,
  /** cooks raw food placed on it; lights the area; hurts to stand in */
  CAMPFIRE = 233,
  /** placeable cake eaten a slice at a time (meta = slices eaten) */
  CAKE = 234,
  /** holds a flower/sapling/mushroom (meta = plant id) */
  FLOWER_POT = 235,
  /** turns plant matter into bone meal (meta = fill level 0..8) */
  COMPOSTER = 236,
  CHISELED_STONE_BRICKS = 237,
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
  BUCKET = 174,
  WATER_BUCKET = 175,
  LAVA_BUCKET = 176,
  FLINT_AND_STEEL = 177,
  QUARTZ = 178,
  REDSTONE = 179,
  NETHER_BRICK = 180,
  AMETHYST = 181,
  MOB_CATCHER = 182,
  MOB_CATCHER_FILLED = 183,
  SHEARS = 184,
  GOLD_PICK = 185,
  GOLD_AXE = 186,
  GOLD_SHOVEL = 187,
  GOLD_SWORD = 188,
  GOLD_HELMET = 189,
  GOLD_CHEST = 190,
  GOLD_LEGS = 191,
  GOLD_BOOTS = 192,
  GOLDEN_APPLE = 193,
  ENCHANTED_GOLDEN_APPLE = 194,
  MILK_BUCKET = 195,
  SHIELD = 196,
  SPYGLASS = 197,
  PAPER = 198,
  BOOK = 199,
  // --- items from the building + decoration pass (ids 300+) ---------------
  CLAY_BALL = 300,
  BRICK = 301,
  SNOWBALL = 302,
  SUGAR = 303,
  COOKIE = 304,
  PUMPKIN_PIE = 305,
  MELON_SLICE = 306,
  PUMPKIN_SEEDS = 307,
  MELON_SEEDS = 308,
  MUSHROOM_STEW = 309,
  GLASS_BOTTLE = 310,
  WATER_BOTTLE = 311,
  POTION_HEALING = 312,
  POTION_SWIFTNESS = 313,
  POTION_NIGHT_VISION = 314,
  POTION_WATER_BREATHING = 315,
  POTION_FIRE_RESISTANCE = 316,
  POTION_STRENGTH = 317,
  POTION_LEAPING = 318,
  POTION_REGENERATION = 319,
  RED_DYE = 320,
  ORANGE_DYE = 321,
  YELLOW_DYE = 322,
  LIME_DYE = 323,
  CYAN_DYE = 324,
  BLUE_DYE = 325,
  PURPLE_DYE = 326,
  BLACK_DYE = 327,
  /** held: shows an explorer map of the surrounding terrain */
  MAP = 328,
  /** points back to where you last died */
  RECOVERY_COMPASS = 329,
  /** worn in the chest slot: jump mid-fall to glide */
  GLIDER = 330,
  /** right-click while gliding for a boost */
  FIREWORK_ROCKET = 331,
  /** thrown: teleports you to where it lands */
  WARP_PEARL = 332,
  GLISTERING_MELON = 333,
  /** drink for a burst of experience */
  EXPERIENCE_BOTTLE = 334,
}

/** Wearable-armor slot index: 0 head, 1 chest, 2 legs, 3 feet. */
export const ARMOR_HEAD = 0, ARMOR_CHEST = 1, ARMOR_LEGS = 2, ARMOR_FEET = 3;

/** extra block ids beyond the base range */
export enum B2 {
  EMERALD_BLOCK = 50,
}

export type SoundClass = 'stone' | 'wood' | 'grass' | 'sand' | 'glass' | 'none';
export type ToolKind = 'pickaxe' | 'axe' | 'shovel' | 'sword' | 'hoe' | 'shears';

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
  tool?: Exclude<ToolKind, 'sword' | 'shears'>; // effective tool class
  /** minimum tool tier (2=wood, 4=stone, 6=iron, 8=diamond) required for drops */
  minTier?: number;
  sound: SoundClass;
  faces?: { top: string; bottom: string; sides: string; front?: string };
  /** undefined = drops itself; null = drops nothing */
  drop?: { id: number; min: number; max: number } | null;
  /** tier = harvest level (2 wood … 8 diamond); speed = mining multiplier
   *  (defaults to tier; gold mines fastest but only harvests like wood) */
  toolInfo?: { kind: ToolKind; tier: number; damage: number; speed?: number };
  durability?: number;   // for tools and bows
  bow?: boolean;
  /** wearable armor: slot index (0 head … 3 feet) + defense points (2 = one armor icon) */
  armor?: { slot: number; points: number };
  food?: number;         // hunger points restored
  /** saturation restored on eating (MC values); defaults to food * 0.6 */
  sat?: number;
  /** edible even on a full hunger bar (golden apples) */
  alwaysEdible?: boolean;
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
  id: B.LAVA, name: 'lava', label: 'Lava', hardness: -1, sound: 'none',
  solid: false, opaque: false, liquid: true, occludes: false,
  faces: { top: 'lava', bottom: 'lava', sides: 'lava' },
  drop: null,
});
blockDef({
  id: B.OBSIDIAN, name: 'obsidian', label: 'Obsidian', hardness: 9, tool: 'pickaxe', minTier: 8, sound: 'stone',
  faces: { top: 'obsidian', bottom: 'obsidian', sides: 'obsidian' },
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
  id: B.AMETHYST_ORE, name: 'amethyst_ore', label: 'Amethyst Ore', hardness: 3, tool: 'pickaxe', minTier: 4, sound: 'stone',
  faces: { top: 'amethyst_ore', bottom: 'amethyst_ore', sides: 'amethyst_ore' },
  drop: { id: I.AMETHYST, min: 1, max: 2 },
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
  // foot half of a 2-block bed; the head half (B.BED_HEAD) is placed alongside it
  id: B.BED, name: 'bed', label: 'Bed', hardness: 0.3, sound: 'wood',
  // a flat partial model (see Mesher emitBed): don't occlude neighbours or it
  // would punch holes in the blocks around its empty upper half
  opaque: false, occludes: false,
  faces: { top: 'bed_foot_top', bottom: 'planks', sides: 'bed_side' },
});
blockDef({
  id: B.BED_HEAD, name: 'bed_head', label: 'Bed', hardness: 0.3, sound: 'wood',
  opaque: false, occludes: false,
  drop: null, // breaking either half drops a single bed item (handled in Player)
  faces: { top: 'bed_head_top', bottom: 'planks', sides: 'bed_side' },
});
// decorative / storage blocks
blockDef({
  id: B.BOOKSHELF, name: 'bookshelf', label: 'Bookshelf', hardness: 1.5, tool: 'axe', sound: 'wood', fuel: 15,
  faces: { top: 'planks', bottom: 'planks', sides: 'bookshelf' },
  drop: { id: I.BOOK, min: 3, max: 3 },
});
blockDef({
  id: B.HAY_BALE, name: 'hay_block', label: 'Hay Bale', hardness: 0.5, tool: 'hoe', sound: 'grass',
  faces: { top: 'hay_top', bottom: 'hay_top', sides: 'hay_side' },
});
blockDef({
  id: B.COAL_BLOCK, name: 'coal_block', label: 'Block of Coal', hardness: 5, tool: 'pickaxe', minTier: 2, sound: 'stone', fuel: 800,
  faces: { top: 'coal_block', bottom: 'coal_block', sides: 'coal_block' },
});
blockDef({
  id: B.QUARTZ_BLOCK, name: 'quartz_block', label: 'Block of Quartz', hardness: 0.8, tool: 'pickaxe', minTier: 2, sound: 'stone',
  faces: { top: 'quartz_block', bottom: 'quartz_block', sides: 'quartz_block' },
});
blockDef({
  id: B.SMOOTH_STONE, name: 'smooth_stone', label: 'Smooth Stone', hardness: 2, tool: 'pickaxe', minTier: 2, sound: 'stone',
  faces: { top: 'smooth_stone', bottom: 'smooth_stone', sides: 'smooth_stone' },
});
blockDef({
  id: B2.EMERALD_BLOCK, name: 'emerald_block', label: 'Block of Emerald', hardness: 5, tool: 'pickaxe', minTier: 6, sound: 'stone',
  faces: { top: 'emerald_block', bottom: 'emerald_block', sides: 'emerald_block' },
});
blockDef({
  // a light-emitting crossed-flame billboard; burns out unless it sits on netherrack
  id: B.FIRE, name: 'fire', label: 'Fire', hardness: 0, sound: 'none',
  solid: false, opaque: false, occludes: false,
  faces: { top: 'fire', bottom: 'fire', sides: 'fire' },
  drop: null,
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
  id: B.JUNGLE_LOG, name: 'jungle_log', label: 'Jungle Log', hardness: 2, tool: 'axe', sound: 'wood', fuel: 15,
  faces: { top: 'jungle_log_top', bottom: 'jungle_log_top', sides: 'jungle_log_side' },
});
blockDef({
  id: B.JUNGLE_LEAVES, name: 'jungle_leaves', label: 'Jungle Leaves', hardness: 0.2, sound: 'grass',
  opaque: false, occludes: true,
  faces: { top: 'jungle_leaves', bottom: 'jungle_leaves', sides: 'jungle_leaves' },
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

// gold: harvests like wood but mines faster than diamond, and wears out fast
const TIERS = {
  wood: { tier: 2, dur: 60, speed: 2 }, stone: { tier: 4, dur: 132, speed: 4 },
  iron: { tier: 6, dur: 251, speed: 6 }, diamond: { tier: 8, dur: 1562, speed: 8 },
  gold: { tier: 2, dur: 33, speed: 12 },
} as const;
function toolDef(id: number, mat: keyof typeof TIERS, kind: ToolKind, damage: number): void {
  const matLabel = mat === 'gold' ? 'Golden' : `${mat[0].toUpperCase()}${mat.slice(1)}`;
  const label = `${matLabel} ${kind[0].toUpperCase()}${kind.slice(1)}`;
  const matName = mat === 'wood' ? 'wooden' : mat === 'gold' ? 'golden' : mat;
  itemDef({
    id, name: `${matName}_${kind}`, label, sprite: `${mat}_${kind}`, stack: 1,
    toolInfo: { kind, tier: TIERS[mat].tier, damage, speed: TIERS[mat].speed }, durability: TIERS[mat].dur,
  });
}
toolDef(I.WOOD_PICK, 'wood', 'pickaxe', 2);
toolDef(I.WOOD_AXE, 'wood', 'axe', 5);
toolDef(I.WOOD_SHOVEL, 'wood', 'shovel', 2);
toolDef(I.WOOD_SWORD, 'wood', 'sword', 4);
toolDef(I.STONE_PICK, 'stone', 'pickaxe', 3);
toolDef(I.STONE_AXE, 'stone', 'axe', 6);
toolDef(I.STONE_SHOVEL, 'stone', 'shovel', 3);
toolDef(I.STONE_SWORD, 'stone', 'sword', 5);
toolDef(I.IRON_PICK, 'iron', 'pickaxe', 4);
toolDef(I.IRON_AXE, 'iron', 'axe', 7);
toolDef(I.IRON_SHOVEL, 'iron', 'shovel', 4);
toolDef(I.IRON_SWORD, 'iron', 'sword', 6);
toolDef(I.DIAMOND_PICK, 'diamond', 'pickaxe', 5);
toolDef(I.DIAMOND_AXE, 'diamond', 'axe', 8);
toolDef(I.DIAMOND_SHOVEL, 'diamond', 'shovel', 5);
toolDef(I.DIAMOND_SWORD, 'diamond', 'sword', 7);
toolDef(I.GOLD_PICK, 'gold', 'pickaxe', 2);
toolDef(I.GOLD_AXE, 'gold', 'axe', 5);
toolDef(I.GOLD_SHOVEL, 'gold', 'shovel', 2);
toolDef(I.GOLD_SWORD, 'gold', 'sword', 4);
itemDef({
  id: I.SHEARS, name: 'shears', label: 'Shears', sprite: 'shears', stack: 1,
  toolInfo: { kind: 'shears', tier: 2, damage: 1 }, durability: 238,
});
// shield: hold right-click to raise it and turn aside blows from the front
itemDef({ id: I.SHIELD, name: 'shield', label: 'Shield', sprite: 'shield', stack: 1, durability: 336, fuel: 15 });
// spyglass: hold right-click to zoom
itemDef({ id: I.SPYGLASS, name: 'spyglass', label: 'Spyglass', sprite: 'spyglass', stack: 1 });
itemDef({ id: I.PAPER, name: 'paper', label: 'Paper', sprite: 'paper' });
itemDef({ id: I.BOOK, name: 'book', label: 'Book', sprite: 'book' });

itemDef({ id: I.PORKCHOP, name: 'porkchop', label: 'Raw Porkchop', sprite: 'porkchop', food: 3, sat: 1.8 });
itemDef({ id: I.COOKED_PORKCHOP, name: 'cooked_porkchop', label: 'Cooked Porkchop', sprite: 'cooked_porkchop', food: 8, sat: 12.8 });
itemDef({ id: I.CHICKEN, name: 'chicken', label: 'Raw Chicken', sprite: 'chicken', food: 2, sat: 1.2 });
itemDef({ id: I.COOKED_CHICKEN, name: 'cooked_chicken', label: 'Cooked Chicken', sprite: 'cooked_chicken', food: 6, sat: 7.2 });
itemDef({ id: I.MUTTON, name: 'mutton', label: 'Raw Mutton', sprite: 'mutton', food: 2, sat: 1.2 });
itemDef({ id: I.COOKED_MUTTON, name: 'cooked_mutton', label: 'Cooked Mutton', sprite: 'cooked_mutton', food: 6, sat: 9.6 });
itemDef({ id: I.BEEF, name: 'beef', label: 'Raw Beef', sprite: 'beef', food: 3, sat: 1.8 });
itemDef({ id: I.COOKED_BEEF, name: 'cooked_beef', label: 'Steak', sprite: 'cooked_beef', food: 8, sat: 12.8 });
itemDef({ id: I.ROTTEN_FLESH, name: 'rotten_flesh', label: 'Rotten Flesh', sprite: 'rotten_flesh', food: 2, sat: 0.4 });
itemDef({ id: I.APPLE, name: 'apple', label: 'Apple', sprite: 'apple', food: 4, sat: 2.4 });
itemDef({ id: I.SEEDS, name: 'wheat_seeds', label: 'Seeds', sprite: 'seeds' });
itemDef({ id: I.WHEAT, name: 'wheat', label: 'Wheat', sprite: 'wheat' });
itemDef({ id: I.BREAD, name: 'bread', label: 'Bread', sprite: 'bread', food: 5, sat: 6 });
itemDef({ id: I.CARROT, name: 'carrot', label: 'Carrot', sprite: 'carrot', food: 3, sat: 3.6 });
itemDef({ id: I.POTATO, name: 'potato', label: 'Potato', sprite: 'potato', food: 1, sat: 0.6 });
itemDef({ id: I.BAKED_POTATO, name: 'baked_potato', label: 'Baked Potato', sprite: 'baked_potato', food: 5, sat: 6 });
itemDef({ id: I.BEETROOT, name: 'beetroot', label: 'Beetroot', sprite: 'beetroot', food: 1, sat: 1.2 });
itemDef({ id: I.BEETROOT_SEEDS, name: 'beetroot_seeds', label: 'Beetroot Seeds', sprite: 'beetroot_seeds' });
itemDef({ id: I.BOWL, name: 'bowl', label: 'Bowl', sprite: 'bowl', stack: 16, fuel: 2 });
itemDef({ id: I.BEETROOT_SOUP, name: 'beetroot_soup', label: 'Beetroot Soup', sprite: 'beetroot_soup', food: 6, sat: 7.2, stack: 1 });
itemDef({ id: I.VEGETABLE_STEW, name: 'vegetable_stew', label: 'Vegetable Stew', sprite: 'vegetable_stew', food: 8, sat: 9.6, stack: 1 });
itemDef({ id: I.GOLDEN_CARROT, name: 'golden_carrot', label: 'Golden Carrot', sprite: 'golden_carrot', food: 6, sat: 14.4 });
itemDef({
  id: I.GOLDEN_APPLE, name: 'golden_apple', label: 'Golden Apple', sprite: 'golden_apple',
  food: 4, sat: 9.6, alwaysEdible: true,
});
itemDef({
  id: I.ENCHANTED_GOLDEN_APPLE, name: 'enchanted_golden_apple', label: 'Enchanted Golden Apple',
  sprite: 'enchanted_golden_apple', food: 4, sat: 9.6, alwaysEdible: true,
});
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
itemDef({ id: I.RAW_FISH, name: 'cod', label: 'Raw Fish', sprite: 'raw_fish', food: 2, sat: 0.4 });
itemDef({ id: I.COOKED_FISH, name: 'cooked_cod', label: 'Cooked Fish', sprite: 'cooked_fish', food: 5, sat: 6 });
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
armorDef(I.GOLD_HELMET, 'golden_helmet', 'Golden Helmet', 'gold_helmet', ARMOR_HEAD, 2, 77);
armorDef(I.GOLD_CHEST, 'golden_chestplate', 'Golden Chestplate', 'gold_chest', ARMOR_CHEST, 5, 112);
armorDef(I.GOLD_LEGS, 'golden_leggings', 'Golden Leggings', 'gold_legs', ARMOR_LEGS, 3, 105);
armorDef(I.GOLD_BOOTS, 'golden_boots', 'Golden Boots', 'gold_boots', ARMOR_FEET, 1, 91);

itemDef({ id: I.BUCKET, name: 'bucket', label: 'Bucket', sprite: 'bucket', stack: 16 });
itemDef({ id: I.WATER_BUCKET, name: 'water_bucket', label: 'Water Bucket', sprite: 'water_bucket', stack: 1 });
itemDef({ id: I.LAVA_BUCKET, name: 'lava_bucket', label: 'Lava Bucket', sprite: 'lava_bucket', stack: 1, fuel: 1000 });
// milk: drink to clear every status effect (fill a bucket from a cow)
itemDef({ id: I.MILK_BUCKET, name: 'milk_bucket', label: 'Milk Bucket', sprite: 'milk_bucket', stack: 1, alwaysEdible: true });

blockDef({
  id: B.PORTAL, name: 'portal', label: 'Nether Portal', hardness: -1, sound: 'glass',
  faces: { top: 'portal', bottom: 'portal', sides: 'portal' },
  solid: false, opaque: false, occludes: false
});
blockDef({
  id: B.NETHERRACK, name: 'netherrack', label: 'Netherrack', hardness: 0.4, tool: 'pickaxe', minTier: 2, sound: 'stone',
  faces: { top: 'netherrack', bottom: 'netherrack', sides: 'netherrack' }
});
blockDef({
  id: B.GLOWSTONE, name: 'glowstone', label: 'Glowstone', hardness: 0.3, sound: 'glass',
  faces: { top: 'glowstone', bottom: 'glowstone', sides: 'glowstone' }
});
blockDef({
  id: B.SOUL_SAND, name: 'soul_sand', label: 'Soul Sand', hardness: 0.5, tool: 'shovel', sound: 'sand',
  faces: { top: 'soul_sand', bottom: 'soul_sand', sides: 'soul_sand' }
});
blockDef({
  id: B.QUARTZ_ORE, name: 'nether_quartz_ore', label: 'Nether Quartz Ore', hardness: 2.0, tool: 'pickaxe', minTier: 4, sound: 'stone',
  faces: { top: 'nether_quartz_ore', bottom: 'nether_quartz_ore', sides: 'nether_quartz_ore' },
  drop: { id: I.QUARTZ, min: 1, max: 1 }
});
blockDef({
  id: B.MAGMA, name: 'magma', label: 'Magma Block', hardness: 0.5, tool: 'pickaxe', minTier: 2, sound: 'stone',
  faces: { top: 'magma', bottom: 'magma', sides: 'magma' }
});
blockDef({
  id: B.NETHER_BRICKS, name: 'nether_bricks', label: 'Nether Bricks', hardness: 2.0, tool: 'pickaxe', minTier: 2, sound: 'stone',
  faces: { top: 'nether_bricks', bottom: 'nether_bricks', sides: 'nether_bricks' }
});
blockDef({
  id: B.REDSTONE_WIRE, name: 'redstone_dust', label: 'Redstone Dust', hardness: 0, sound: 'stone',
  faces: { top: 'redstone_dust', bottom: 'redstone_dust', sides: 'redstone_dust' },
  solid: false, opaque: false, occludes: false
});
blockDef({
  id: B.REDSTONE_LAMP, name: 'redstone_lamp', label: 'Redstone Lamp', hardness: 0.3, sound: 'glass',
  faces: { top: 'redstone_lamp', bottom: 'redstone_lamp', sides: 'redstone_lamp' }
});
blockDef({
  id: B.REDSTONE_LAMP_LIT, name: 'redstone_lamp_lit', label: 'Redstone Lamp Lit', hardness: 0.3, sound: 'glass',
  faces: { top: 'redstone_lamp_lit', bottom: 'redstone_lamp_lit', sides: 'redstone_lamp_lit' }
});
blockDef({
  id: B.LEVER, name: 'lever', label: 'Lever', hardness: 0.5, sound: 'wood',
  faces: { top: 'lever', bottom: 'lever', sides: 'lever' },
  solid: false, opaque: false, occludes: false
});
blockDef({
  id: B.WOODEN_BUTTON, name: 'wooden_button', label: 'Wooden Button', hardness: 0.5, sound: 'wood',
  faces: { top: 'planks', bottom: 'planks', sides: 'planks' },
  solid: false, opaque: false, occludes: false
});
blockDef({
  id: B.STONE_BUTTON, name: 'stone_button', label: 'Stone Button', hardness: 0.5, sound: 'stone',
  faces: { top: 'stone', bottom: 'stone', sides: 'stone' },
  solid: false, opaque: false, occludes: false
});
blockDef({
  id: B.PISTON, name: 'piston', label: 'Piston', hardness: 1.5, tool: 'pickaxe', sound: 'stone',
  faces: { top: 'piston_top', bottom: 'piston_bottom', sides: 'piston_side' }
});
blockDef({
  id: B.STICKY_PISTON, name: 'sticky_piston', label: 'Sticky Piston', hardness: 1.5, tool: 'pickaxe', sound: 'stone',
  faces: { top: 'piston_top_sticky', bottom: 'piston_bottom', sides: 'piston_side' }
});
blockDef({
  id: B.PRESSURE_PLATE, name: 'pressure_plate', label: 'Pressure Plate', hardness: 0.5, sound: 'wood',
  faces: { top: 'planks', bottom: 'planks', sides: 'planks' },
  solid: false, opaque: false, occludes: false
});
blockDef({
  id: B.PISTON_HEAD, name: 'piston_head', label: 'Piston Head', hardness: 1.5, sound: 'stone',
  faces: { top: 'piston_top', bottom: 'piston_bottom', sides: 'piston_side' },
  solid: true, opaque: false, occludes: false
});

itemDef({ id: I.FLINT_AND_STEEL, name: 'flint_and_steel', label: 'Flint and Steel', sprite: 'flint_and_steel', stack: 1, durability: 64 });
itemDef({ id: I.QUARTZ, name: 'quartz', label: 'Nether Quartz', sprite: 'quartz', stack: 64 });
itemDef({ id: I.REDSTONE, name: 'redstone', label: 'Redstone Dust', sprite: 'redstone', stack: 64 });
itemDef({ id: I.NETHER_BRICK, name: 'nether_brick', label: 'Nether Brick', sprite: 'nether_brick', stack: 64 });
itemDef({ id: I.AMETHYST, name: 'amethyst', label: 'Amethyst', sprite: 'amethyst', stack: 64 });
itemDef({ id: I.MOB_CATCHER, name: 'mob_catcher', label: 'Mob Catcher', sprite: 'mob_catcher', stack: 16 });
itemDef({ id: I.MOB_CATCHER_FILLED, name: 'mob_catcher_filled', label: 'Captured Mob', sprite: 'mob_catcher_filled', stack: 1 });

// =============================================================================
// Building + decoration pass: masonry, ice, colored wool, garden plants,
// shaped blocks (slabs, stairs, fences, panes, lanterns ...), utility blocks,
// foods, potions, dyes and exploration gear.
// =============================================================================

function cube(id: number, name: string, label: string, tile: string, extra: Partial<Def> = {}): void {
  blockDef({
    id, name, label, hardness: 1.5, tool: 'pickaxe', minTier: 2, sound: 'stone',
    faces: { top: tile, bottom: tile, sides: tile }, ...extra,
  });
}
cube(B.BRICKS, 'bricks', 'Bricks', 'bricks', { hardness: 2 });
cube(B.CLAY, 'clay', 'Clay', 'clay', {
  hardness: 0.6, tool: 'shovel', minTier: undefined, sound: 'sand',
  drop: { id: I.CLAY_BALL, min: 4, max: 4 },
});
cube(B.MOSSY_COBBLE, 'mossy_cobblestone', 'Mossy Cobblestone', 'mossy_cobble', { hardness: 2 });
cube(B.MOSSY_STONE_BRICKS, 'mossy_stone_bricks', 'Mossy Stone Bricks', 'mossy_stone_bricks');
cube(B.CRACKED_STONE_BRICKS, 'cracked_stone_bricks', 'Cracked Stone Bricks', 'cracked_stone_bricks');
cube(B.CHISELED_STONE_BRICKS, 'chiseled_stone_bricks', 'Chiseled Stone Bricks', 'chiseled_stone_bricks');
cube(B.SNOW_BLOCK, 'snow_block', 'Snow Block', 'snow_top', {
  hardness: 0.2, tool: 'shovel', minTier: undefined, sound: 'sand',
  drop: { id: I.SNOWBALL, min: 4, max: 4 },
});
cube(B.ICE, 'ice', 'Ice', 'ice', {
  hardness: 0.5, minTier: undefined, sound: 'glass',
  drop: null, // melts to water (handled in Player)
});
cube(B.PACKED_ICE, 'packed_ice', 'Packed Ice', 'packed_ice', { hardness: 0.5, minTier: undefined, sound: 'glass' });
cube(B.TERRACOTTA, 'terracotta', 'Terracotta', 'terracotta', { hardness: 1.25 });
blockDef({
  id: B.PUMPKIN, name: 'pumpkin', label: 'Pumpkin', hardness: 1, tool: 'axe', sound: 'wood',
  faces: { top: 'pumpkin_top', bottom: 'pumpkin_top', sides: 'pumpkin_side' },
});
blockDef({
  id: B.JACK_O_LANTERN, name: 'jack_o_lantern', label: "Jack o'Lantern", hardness: 1, tool: 'axe', sound: 'wood',
  faces: { top: 'pumpkin_top', bottom: 'pumpkin_top', sides: 'pumpkin_side', front: 'jack_o_lantern' },
});
blockDef({
  id: B.MELON, name: 'melon', label: 'Melon', hardness: 1, tool: 'axe', sound: 'wood',
  faces: { top: 'melon_top', bottom: 'melon_top', sides: 'melon_side' },
  drop: { id: I.MELON_SLICE, min: 3, max: 7 },
});
for (const [id, name, label, tile, seeds] of [
  [B.PUMPKIN_STEM, 'pumpkin_stem', 'Pumpkin Stem', 'pumpkin_stem', I.PUMPKIN_SEEDS],
  [B.MELON_STEM, 'melon_stem', 'Melon Stem', 'melon_stem', I.MELON_SEEDS],
] as [number, string, string, string, number][]) {
  blockDef({
    id, name, label, hardness: 0, sound: 'grass', solid: false, opaque: false, occludes: false,
    faces: { top: tile, bottom: tile, sides: tile }, drop: { id: seeds, min: 1, max: 1 },
  });
}

/** Wool colours: [block, dye, name stem, label, tint]. */
export const WOOL_COLORS: [number, number, string, string, string][] = [
  [B.RED_WOOL, I.RED_DYE, 'red', 'Red', '#b02e26'],
  [B.ORANGE_WOOL, I.ORANGE_DYE, 'orange', 'Orange', '#f9801d'],
  [B.YELLOW_WOOL, I.YELLOW_DYE, 'yellow', 'Yellow', '#fed83d'],
  [B.LIME_WOOL, I.LIME_DYE, 'lime', 'Lime', '#80c71f'],
  [B.CYAN_WOOL, I.CYAN_DYE, 'cyan', 'Cyan', '#169c9c'],
  [B.BLUE_WOOL, I.BLUE_DYE, 'blue', 'Blue', '#3c44aa'],
  [B.PURPLE_WOOL, I.PURPLE_DYE, 'purple', 'Purple', '#8932b8'],
  [B.BLACK_WOOL, I.BLACK_DYE, 'black', 'Black', '#1d1d21'],
];
for (const [id, dye, stem, label] of WOOL_COLORS) {
  blockDef({
    id, name: `${stem}_wool`, label: `${label} Wool`, hardness: 0.8, sound: 'grass',
    faces: { top: `${stem}_wool`, bottom: `${stem}_wool`, sides: `${stem}_wool` },
  });
  itemDef({ id: dye, name: `${stem}_dye`, label: `${label} Dye`, sprite: `${stem}_dye` });
}

// garden plants (crossed billboards)
for (const [id, name, label] of [
  [B.CORNFLOWER, 'cornflower', 'Cornflower'], [B.ALLIUM, 'allium', 'Allium'],
  [B.OXEYE_DAISY, 'oxeye_daisy', 'Oxeye Daisy'],
  [B.BROWN_MUSHROOM, 'brown_mushroom', 'Brown Mushroom'], [B.RED_MUSHROOM, 'red_mushroom', 'Red Mushroom'],
] as [number, string, string][]) {
  blockDef({
    id, name, label, hardness: 0, sound: 'grass', solid: false, opaque: false, occludes: false,
    faces: { top: name, bottom: name, sides: name },
  });
}

// --- shaped blocks (see shapeBoxes + Mesher.emitShaped) -----------------------
blockDef({
  id: B.LANTERN, name: 'lantern', label: 'Lantern', hardness: 1.5, tool: 'pickaxe', sound: 'stone',
  solid: false, opaque: false, occludes: false,
  faces: { top: 'lantern', bottom: 'lantern', sides: 'lantern' },
});
blockDef({
  id: B.GLASS_PANE, name: 'glass_pane', label: 'Glass Pane', hardness: 0.3, sound: 'glass',
  opaque: false, occludes: false, drop: null,
  faces: { top: 'glass_pane_top', bottom: 'glass_pane_top', sides: 'glass' },
});
blockDef({
  id: B.OAK_FENCE, name: 'oak_fence', label: 'Oak Fence', hardness: 2, tool: 'axe', sound: 'wood', fuel: 15,
  opaque: false, occludes: false,
  faces: { top: 'planks', bottom: 'planks', sides: 'planks' },
});
blockDef({
  id: B.FENCE_GATE, name: 'oak_fence_gate', label: 'Oak Fence Gate', hardness: 2, tool: 'axe', sound: 'wood', fuel: 15,
  opaque: false, occludes: false,
  faces: { top: 'planks', bottom: 'planks', sides: 'planks' },
});

/** Slab/stair material table: [slab, stairs | 0, full block, tile top, tile side, label, tool]. */
export const SLAB_KINDS: [number, number, number, string, string, string, 'pickaxe' | 'axe'][] = [
  [B.COBBLE_SLAB, B.COBBLE_STAIRS, B.COBBLE, 'cobble', 'cobble', 'Cobblestone', 'pickaxe'],
  [B.STONE_SLAB, 0, B.SMOOTH_STONE, 'smooth_stone', 'smooth_stone_slab_side', 'Smooth Stone', 'pickaxe'],
  [B.OAK_SLAB, B.OAK_STAIRS, B.PLANKS, 'planks', 'planks', 'Oak', 'axe'],
  [B.STONE_BRICK_SLAB, B.STONE_BRICK_STAIRS, B.STONE_BRICKS, 'stone_bricks', 'stone_bricks', 'Stone Brick', 'pickaxe'],
  [B.BRICK_SLAB, B.BRICK_STAIRS, B.BRICKS, 'bricks', 'bricks', 'Brick', 'pickaxe'],
  [B.SANDSTONE_SLAB, 0, B.SANDSTONE, 'sandstone_top', 'sandstone_side', 'Sandstone', 'pickaxe'],
];
for (const [slab, stairs, , top, side, label, tool] of SLAB_KINDS) {
  const wood = tool === 'axe';
  const common = {
    hardness: 2, tool, minTier: wood ? undefined : 2, sound: (wood ? 'wood' : 'stone') as SoundClass,
    opaque: false, occludes: false, ...(wood ? { fuel: 7 } : {}),
  };
  blockDef({
    id: slab, name: `${label.toLowerCase().replace(/ /g, '_')}_slab`, label: `${label} Slab`, ...common,
    faces: { top, bottom: top, sides: side },
  });
  if (stairs) {
    blockDef({
      id: stairs, name: `${label.toLowerCase().replace(/ /g, '_')}_stairs`, label: `${label} Stairs`, ...common,
      faces: { top, bottom: top, sides: side },
    });
  }
}

blockDef({
  id: B.ANVIL, name: 'anvil', label: 'Anvil', hardness: 5, tool: 'pickaxe', minTier: 2, sound: 'stone',
  opaque: false, occludes: false,
  faces: { top: 'anvil_top', bottom: 'anvil', sides: 'anvil' },
});
blockDef({
  id: B.ENCHANTING_TABLE, name: 'enchanting_table', label: 'Enchanting Table', hardness: 5, tool: 'pickaxe', minTier: 2,
  sound: 'stone', opaque: false, occludes: false,
  faces: { top: 'enchanting_table_top', bottom: 'obsidian', sides: 'enchanting_table_side' },
});
blockDef({
  id: B.BARREL, name: 'barrel', label: 'Barrel', hardness: 2.5, tool: 'axe', sound: 'wood', fuel: 15,
  faces: { top: 'barrel_top', bottom: 'barrel_bottom', sides: 'barrel_side' },
});
blockDef({
  id: B.CAMPFIRE, name: 'campfire', label: 'Campfire', hardness: 2, tool: 'axe', sound: 'wood',
  opaque: false, occludes: false,
  faces: { top: 'campfire_log', bottom: 'campfire_log', sides: 'campfire_log' },
  drop: { id: I.COAL, min: 1, max: 2 },
});
blockDef({
  id: B.CAKE, name: 'cake', label: 'Cake', hardness: 0.5, sound: 'grass', stack: 1,
  opaque: false, occludes: false, drop: null,
  faces: { top: 'cake_top', bottom: 'cake_bottom', sides: 'cake_side' },
});
blockDef({
  id: B.FLOWER_POT, name: 'flower_pot', label: 'Flower Pot', hardness: 0, sound: 'stone',
  opaque: false, occludes: false,
  faces: { top: 'flower_pot', bottom: 'flower_pot', sides: 'flower_pot' },
});
blockDef({
  id: B.COMPOSTER, name: 'composter', label: 'Composter', hardness: 0.6, tool: 'axe', sound: 'wood', fuel: 15,
  opaque: false, occludes: false,
  faces: { top: 'composter_top', bottom: 'composter_bottom', sides: 'composter_side' },
});

// --- items --------------------------------------------------------------------
itemDef({ id: I.CLAY_BALL, name: 'clay_ball', label: 'Clay Ball', sprite: 'clay_ball' });
itemDef({ id: I.BRICK, name: 'brick', label: 'Brick', sprite: 'brick' });
itemDef({ id: I.SNOWBALL, name: 'snowball', label: 'Snowball', sprite: 'snowball', stack: 16 });
itemDef({ id: I.SUGAR, name: 'sugar', label: 'Sugar', sprite: 'sugar' });
itemDef({ id: I.COOKIE, name: 'cookie', label: 'Cookie', sprite: 'cookie', food: 2, sat: 0.4 });
itemDef({ id: I.PUMPKIN_PIE, name: 'pumpkin_pie', label: 'Pumpkin Pie', sprite: 'pumpkin_pie', food: 8, sat: 4.8 });
itemDef({ id: I.MELON_SLICE, name: 'melon_slice', label: 'Melon Slice', sprite: 'melon_slice', food: 2, sat: 1.2 });
itemDef({ id: I.PUMPKIN_SEEDS, name: 'pumpkin_seeds', label: 'Pumpkin Seeds', sprite: 'pumpkin_seeds' });
itemDef({ id: I.MELON_SEEDS, name: 'melon_seeds', label: 'Melon Seeds', sprite: 'melon_seeds' });
itemDef({ id: I.MUSHROOM_STEW, name: 'mushroom_stew', label: 'Mushroom Stew', sprite: 'mushroom_stew', food: 6, sat: 7.2, stack: 1 });
itemDef({ id: I.GLISTERING_MELON, name: 'glistering_melon_slice', label: 'Glistering Melon Slice', sprite: 'glistering_melon' });
itemDef({ id: I.GLASS_BOTTLE, name: 'glass_bottle', label: 'Glass Bottle', sprite: 'glass_bottle', stack: 16 });
itemDef({ id: I.WATER_BOTTLE, name: 'water_bottle', label: 'Water Bottle', sprite: 'water_bottle', stack: 1, alwaysEdible: true });
itemDef({ id: I.EXPERIENCE_BOTTLE, name: 'experience_bottle', label: "Bottle o' Enchanting", sprite: 'experience_bottle', alwaysEdible: true });

/** Potions: drink (hold right-click) for a timed effect. [id, stem, label, colour]. */
export const POTIONS: [number, string, string, string][] = [
  [I.POTION_HEALING, 'healing', 'Potion of Healing', '#f82423'],
  [I.POTION_SWIFTNESS, 'swiftness', 'Potion of Swiftness', '#7cafc6'],
  [I.POTION_NIGHT_VISION, 'night_vision', 'Potion of Night Vision', '#1f1fa1'],
  [I.POTION_WATER_BREATHING, 'water_breathing', 'Potion of Water Breathing', '#2e5299'],
  [I.POTION_FIRE_RESISTANCE, 'fire_resistance', 'Potion of Fire Resistance', '#e49a3a'],
  [I.POTION_STRENGTH, 'strength', 'Potion of Strength', '#932423'],
  [I.POTION_LEAPING, 'leaping', 'Potion of Leaping', '#22ff4c'],
  [I.POTION_REGENERATION, 'regeneration', 'Potion of Regeneration', '#cd5cab'],
];
for (const [id, stem, label] of POTIONS) {
  itemDef({ id, name: `potion_${stem}`, label, sprite: `potion_${stem}`, stack: 1, alwaysEdible: true });
}
export function isPotion(id: number): boolean { return id >= I.POTION_HEALING && id <= I.POTION_REGENERATION; }
/** Drinkables (potions, bottles, milk) are sipped rather than chewed. */
export function isDrink(id: number): boolean {
  return isPotion(id) || id === I.WATER_BOTTLE || id === I.EXPERIENCE_BOTTLE || id === I.MILK_BUCKET;
}

itemDef({ id: I.MAP, name: 'map', label: 'Explorer Map', sprite: 'map', stack: 1 });
itemDef({ id: I.RECOVERY_COMPASS, name: 'recovery_compass', label: 'Recovery Compass', sprite: 'recovery_compass', stack: 1 });
itemDef({
  id: I.GLIDER, name: 'glider', label: 'Glider', sprite: 'glider', stack: 1, durability: 432,
  armor: { slot: ARMOR_CHEST, points: 0 },
});
itemDef({ id: I.FIREWORK_ROCKET, name: 'firework_rocket', label: 'Firework Rocket', sprite: 'firework_rocket' });
itemDef({ id: I.WARP_PEARL, name: 'warp_pearl', label: 'Warp Pearl', sprite: 'warp_pearl', stack: 16 });

// --- block metadata + shapes ---------------------------------------------------
// Shaped blocks keep a small per-block value in world.bedFacings (the generic
// "facing/meta" map that is already persisted per dimension and shipped to the
// mesh worker): stair facing (+4 = upside down), slab half (1 = top), lantern
// hanging (1), cake slices eaten, flower-pot plant id, composter level, jack
// o'lantern / anvil / campfire facing. Fence gates keep open+facing in doorStates.

export const SLAB_IDS = new Set<number>(SLAB_KINDS.map((k) => k[0]));
export const STAIR_IDS = new Set<number>(SLAB_KINDS.map((k) => k[1]).filter((id) => id !== 0));
/** Full block a slab doubles into when a second slab is laid on it. */
export function slabFullBlock(slab: number): number {
  return SLAB_KINDS.find((k) => k[0] === slab)?.[2] ?? slab;
}

/** Non-cube blocks drawn by Mesher.emitShaped (with collision from shapeBoxes). */
export const SHAPED = new Set<number>([
  ...SLAB_IDS, ...STAIR_IDS,
  B.LANTERN, B.GLASS_PANE, B.OAK_FENCE, B.FENCE_GATE, B.ANVIL, B.ENCHANTING_TABLE,
  B.CAMPFIRE, B.CAKE, B.FLOWER_POT, B.COMPOSTER, B.JACK_O_LANTERN,
]);
/** Blocks whose meta entry must be dropped when they are removed. */
export const META_BLOCKS = new Set<number>([...SHAPED]);

/** Fences join fences, gates and full solid blocks; panes join panes, glass and full solid blocks. */
export function connectsTo(self: number, other: number): boolean {
  if (other === B.AIR || !hasDef(other)) return false;
  if (self === B.GLASS_PANE) return other === B.GLASS_PANE || other === B.GLASS || (def(other).opaque && def(other).solid);
  return other === B.OAK_FENCE || other === B.FENCE_GATE || (def(other).opaque && def(other).solid);
}

/** Axis-aligned box in block-local units: x0, y0, z0, x1, y1, z1. */
export type Box = [number, number, number, number, number, number];
const P16 = 1 / 16;

/** Stair boxes: the lower (or upper, upside-down) slab plus the raised step
 *  on the `facing` side (0 = -z, 1 = -x, 2 = +z, 3 = +x). */
function stairBoxes(meta: number): Box[] {
  const f = meta & 3, flip = (meta & 4) !== 0;
  const base: Box = flip ? [0, 0.5, 0, 1, 1, 1] : [0, 0, 0, 1, 0.5, 1];
  const y0 = flip ? 0 : 0.5, y1 = flip ? 0.5 : 1;
  const step: Box =
    f === 0 ? [0, y0, 0, 1, y1, 0.5] :
    f === 1 ? [0, y0, 0, 0.5, y1, 1] :
    f === 2 ? [0, y0, 0.5, 1, y1, 1] : [0.5, y0, 0, 1, y1, 1];
  return [base, step];
}

/** Fence/pane: a centre post plus an arm toward each connected side
 *  (conn bits: 1 = -z, 2 = +z, 4 = -x, 8 = +x). */
function postBoxes(r: number, h: number, conn: number): Box[] {
  const a = 0.5 - r, b = 0.5 + r;
  const out: Box[] = [[a, 0, a, b, h, b]];
  if (conn & 1) out.push([a, 0, 0, b, h, a]);
  if (conn & 2) out.push([a, 0, b, b, h, 1]);
  if (conn & 4) out.push([0, 0, a, a, h, b]);
  if (conn & 8) out.push([b, 0, a, 1, h, b]);
  return out;
}

/**
 * Collision boxes of a shaped block, or null for a plain full cube. `meta` is
 * the block's bedFacings value, `conn` the fence/pane connection mask and
 * `open` whether a fence gate stands open. `collide` = physics boxes (fences
 * stand 1.5 tall there); otherwise the visual/outline extent.
 */
export function shapeBoxes(id: number, meta: number, conn: number, open: boolean, collide: boolean): Box[] | null {
  if (SLAB_IDS.has(id)) return [meta === 1 ? [0, 0.5, 0, 1, 1, 1] : [0, 0, 0, 1, 0.5, 1]];
  if (STAIR_IDS.has(id)) return stairBoxes(meta);
  switch (id) {
    case B.OAK_FENCE: return postBoxes(2 * P16, collide ? 1.5 : 1, conn);
    case B.GLASS_PANE: return postBoxes(P16, 1, conn);
    case B.FENCE_GATE: {
      if (open && collide) return [];
      const alongX = (meta & 1) === 0; // facing north/south: the gate spans x
      const h = collide ? 1.5 : 1;
      return [alongX ? [0, 0, 7 * P16, 1, h, 9 * P16] : [7 * P16, 0, 0, 9 * P16, h, 1]];
    }
    case B.LANTERN: case B.SOUL_LANTERN: return meta === 1
      ? [[5 * P16, 1 * P16, 5 * P16, 11 * P16, 10 * P16, 11 * P16]]
      : [[5 * P16, 0, 5 * P16, 11 * P16, 9 * P16, 11 * P16]];
    case B.ANVIL: return (meta & 1) === 0
      ? [[0, 0, 3 * P16, 1, 1, 13 * P16]]
      : [[3 * P16, 0, 0, 13 * P16, 1, 1]];
    case B.ENCHANTING_TABLE: return [[0, 0, 0, 1, 0.75, 1]];
    case B.CAMPFIRE: return [[0, 0, 0, 1, 7 * P16, 1]];
    case B.CAKE: return [[(1 + 2 * Math.min(6, meta)) * P16, 0, P16, 15 * P16, 0.5, 15 * P16]];
    case B.FLOWER_POT: return [[5 * P16, 0, 5 * P16, 11 * P16, 6 * P16, 11 * P16]];
    default: return null;
  }
}

export function def(id: number): Def {
  const d = DEFS.get(id);
  if (!d) throw new Error(`Unknown id ${id}`);
  return d;
}
export function hasDef(id: number): boolean { return DEFS.has(id); }
export function allDefs(): Def[] { return [...DEFS.values()]; }

/** Mobs a catcher can capture: every hostile mob. Peaceful animals are tamed
 *  or bred instead, so throwing a catcher at one just bounces off. */
export const CAPTURABLE = new Set<string>([
  'zombie', 'skeleton', 'spider', 'creeper',
  'cinderling', 'ashstalker', 'emberghast', 'phantom',
]);

/** Friendly label for a captured mob kind. */
export function mobLabel(kind: string): string {
  const m: Record<string, string> = {
    zombie: 'Zombie', skeleton: 'Skeleton', spider: 'Spider', creeper: 'Creeper',
    cinderling: 'Cinderling', ashstalker: 'Ashstalker',
    emberghast: 'Emberghast', phantom: 'Phantom',
  };
  return m[kind] ?? kind;
}

/** Resolve the sprite name for a stack: filled catchers show a per-mob sprite. */
export function spriteNameFor(id: number, mob?: string): string | undefined {
  const d = def(id);
  if (id === I.MOB_CATCHER_FILLED && mob && CAPTURABLE.has(mob)) return `mob_catcher_filled_${mob}`;
  return d.sprite;
}

export function isSolid(id: number): boolean { return id !== B.AIR && def(id).solid; }
export function isOpaque(id: number): boolean { return id !== B.AIR && def(id).opaque; }
export function isLiquid(id: number): boolean { return id === B.WATER || id === B.LAVA; }
export function occludes(id: number): boolean { return id !== B.AIR && def(id).occludes; }

/** Fast lookup tables for the mesher hot path (avoid per-face def() Map.gets). */
export const OPAQUE_LUT = new Uint8Array(256);
export const OCCLUDE_LUT = new Uint8Array(256);
for (const d of DEFS.values()) {
  if (d.block && d.opaque) OPAQUE_LUT[d.id] = 1;
  if (d.id !== B.AIR && d.occludes) OCCLUDE_LUT[d.id] = 1;
}

export const GRAVITY_BLOCKS = new Set<number>([B.SAND, B.GRAVEL]);

/** Rendered as two crossed billboards instead of a cube. */
export const CROSS_BLOCKS = new Set<number>([
  B.POPPY, B.DANDELION, B.TALL_GRASS, B.SUGAR_CANE,
  B.WHEAT_0, B.WHEAT_1, B.WHEAT_2, B.SAPLING,
  B.CARROT_0, B.CARROT_1, B.CARROT_2,
  B.POTATO_0, B.POTATO_1, B.POTATO_2,
  B.BEETROOT_0, B.BEETROOT_1, B.BEETROOT_2,
  B.FIRE,
  B.CORNFLOWER, B.ALLIUM, B.OXEYE_DAISY, B.BROWN_MUSHROOM, B.RED_MUSHROOM,
  B.PUMPKIN_STEM, B.MELON_STEM,
]);

/** How readily a block burns: `burn` = chance of being consumed by adjacent
 *  fire, `catch` = how eagerly flames leap into the air next to it (vanilla's
 *  flammability / encouragement, scaled 0..100). */
export const FLAMMABLE = new Map<number, { burn: number; catch: number }>([
  [B.PLANKS, { burn: 20, catch: 5 }],
  [B.LOG, { burn: 5, catch: 5 }], [B.BIRCH_LOG, { burn: 5, catch: 5 }],
  [B.SPRUCE_LOG, { burn: 5, catch: 5 }], [B.JUNGLE_LOG, { burn: 5, catch: 5 }],
  [B.LEAVES, { burn: 60, catch: 30 }], [B.BIRCH_LEAVES, { burn: 60, catch: 30 }],
  [B.SPRUCE_LEAVES, { burn: 60, catch: 30 }], [B.JUNGLE_LEAVES, { burn: 60, catch: 30 }],
  [B.WOOL, { burn: 60, catch: 30 }],
  [B.TABLE, { burn: 20, catch: 5 }], [B.LADDER, { burn: 20, catch: 5 }], [B.TRAPDOOR, { burn: 20, catch: 5 }],
  [B.TNT, { burn: 100, catch: 15 }],
  [B.TALL_GRASS, { burn: 100, catch: 60 }], [B.POPPY, { burn: 100, catch: 60 }],
  [B.DANDELION, { burn: 100, catch: 60 }], [B.SAPLING, { burn: 100, catch: 60 }],
  [B.BOOKSHELF, { burn: 30, catch: 20 }], [B.HAY_BALE, { burn: 60, catch: 20 }],
  [B.COAL_BLOCK, { burn: 5, catch: 5 }],
  [B.OAK_FENCE, { burn: 20, catch: 5 }], [B.FENCE_GATE, { burn: 20, catch: 5 }],
  [B.OAK_SLAB, { burn: 20, catch: 5 }], [B.OAK_STAIRS, { burn: 20, catch: 5 }],
  [B.BARREL, { burn: 20, catch: 5 }], [B.COMPOSTER, { burn: 20, catch: 5 }],
  [B.CORNFLOWER, { burn: 100, catch: 60 }], [B.ALLIUM, { burn: 100, catch: 60 }],
  [B.OXEYE_DAISY, { burn: 100, catch: 60 }],
  ...WOOL_COLORS.map(([id]) => [id, { burn: 60, catch: 30 }] as [number, { burn: number; catch: number }]),
]);

/** Blocks that pop off when the block under them is removed.
 *  Sugar cane and cactus may also stack on themselves. */
export const FLOOR_BLOCKS = new Set<number>([
  B.TORCH, B.POPPY, B.DANDELION, B.TALL_GRASS, B.SUGAR_CANE, B.CACTUS,
  B.WHEAT_0, B.WHEAT_1, B.WHEAT_2, B.SAPLING,
  B.CARROT_0, B.CARROT_1, B.CARROT_2,
  B.POTATO_0, B.POTATO_1, B.POTATO_2,
  B.BEETROOT_0, B.BEETROOT_1, B.BEETROOT_2,
  B.REDSTONE_WIRE, B.PRESSURE_PLATE, B.LEVER, B.WOODEN_BUTTON, B.STONE_BUTTON,
  B.CORNFLOWER, B.ALLIUM, B.OXEYE_DAISY, B.BROWN_MUSHROOM, B.RED_MUSHROOM,
  B.PUMPKIN_STEM, B.MELON_STEM, B.CAKE, B.FLOWER_POT,
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

/** Every leaf block: shears and swords cut through these quickly. */
export const LEAF_BLOCKS = new Set<number>([B.LEAVES, B.BIRCH_LEAVES, B.SPRUCE_LEAVES, B.JUNGLE_LEAVES]);

/** Mining-speed multiplier a held item applies to a block (1 = bare hand). */
export function toolSpeed(blockId: number, heldId: number): number {
  if (!heldId || !hasDef(heldId)) return 1;
  const ti = def(heldId).toolInfo;
  if (!ti) return 1;
  // shears: leaves in a snap, wool quickly (vanilla 15x / 5x)
  if (ti.kind === 'shears') return LEAF_BLOCKS.has(blockId) ? 15 : def(blockId).name.endsWith('_wool') ? 5 : 1;
  // a sword hacks through foliage a little faster than a fist
  if (ti.kind === 'sword') return LEAF_BLOCKS.has(blockId) ? 1.5 : 1;
  const bd = def(blockId);
  return bd.tool && ti.kind === bd.tool ? ti.speed ?? ti.tier : 1;
}

/** Seconds to break `blockId` while holding `heldId` (0 = empty hand). */
export function breakTime(blockId: number, heldId: number): number {
  const bd = def(blockId);
  if (bd.hardness < 0) return Infinity;
  if (!canHarvest(blockId, heldId)) return bd.hardness * 5; // wrong tool tier
  return (bd.hardness * 1.5) / toolSpeed(blockId, heldId);
}

export function attackDamage(heldId: number): number {
  if (heldId && hasDef(heldId)) {
    const ti = def(heldId).toolInfo;
    if (ti) return ti.damage;
  }
  return 1;
}

/** Seconds for a swing to recharge to full strength (vanilla 1.9 attack speed):
 *  fists are quick, swords brisk, axes slow and heavy. */
export function attackCooldown(heldId: number): number {
  if (!heldId || !hasDef(heldId)) return 0.25;
  const ti = def(heldId).toolInfo;
  if (!ti) return 0.25;
  switch (ti.kind) {
    case 'sword': return 0.625;
    case 'axe': return ti.tier >= 8 ? 1.0 : ti.tier >= 6 ? 1.1 : 1.25;
    case 'pickaxe': return 0.83;
    case 'shovel': return 1.0;
    case 'hoe': return 1.0;
    default: return 0.25;
  }
}

/** Swing strength multiplier for a swing charged to `charge` (0..1). */
export function attackStrength(charge: number): number {
  const c = Math.max(0, Math.min(1, charge));
  return 0.2 + c * c * 0.8;
}

// --- enchantments ------------------------------------------------------------

/** Enchantments an enchanting table can roll: id, label, max level and what
 *  item it can go on. Stored per stack as SlotData.ench ({ id: level }). */
export interface EnchantDef { id: string; label: string; max: number; fits: (d: Def) => boolean }
const TOOLS_DIG = new Set<ToolKind>(['pickaxe', 'axe', 'shovel', 'hoe', 'shears']);
export const ENCHANTS: EnchantDef[] = [
  { id: 'sharpness', label: 'Sharpness', max: 5, fits: (d) => d.toolInfo?.kind === 'sword' || d.toolInfo?.kind === 'axe' },
  { id: 'knockback', label: 'Knockback', max: 2, fits: (d) => d.toolInfo?.kind === 'sword' },
  { id: 'efficiency', label: 'Efficiency', max: 5, fits: (d) => !!d.toolInfo && TOOLS_DIG.has(d.toolInfo.kind) },
  { id: 'fortune', label: 'Fortune', max: 3, fits: (d) => d.toolInfo?.kind === 'pickaxe' },
  { id: 'power', label: 'Power', max: 5, fits: (d) => !!d.bow },
  { id: 'protection', label: 'Protection', max: 4, fits: (d) => !!d.armor && d.armor.points > 0 },
  { id: 'feather_falling', label: 'Feather Falling', max: 4, fits: (d) => d.armor?.slot === ARMOR_FEET },
  { id: 'respiration', label: 'Respiration', max: 3, fits: (d) => d.armor?.slot === ARMOR_HEAD },
  { id: 'unbreaking', label: 'Unbreaking', max: 3, fits: (d) => !!d.durability },
];
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];
export function enchantLabel(id: string, level: number): string {
  const e = ENCHANTS.find((x) => x.id === id);
  return `${e?.label ?? id} ${ROMAN[level] ?? level}`;
}
/** Enchantments that can go on this item (empty = not enchantable). */
export function enchantsFor(itemId: number): EnchantDef[] {
  if (!hasDef(itemId)) return [];
  const d = def(itemId);
  return ENCHANTS.filter((e) => e.fits(d));
}
/** Level of `ench` on a stack (0 if absent). */
export function enchLevel(slot: { ench?: Record<string, number> } | null | undefined, ench: string): number {
  return slot?.ench?.[ench] ?? 0;
}

/** What an anvil mends an item with (one unit restores a quarter of it). */
export function repairMaterial(itemId: number): number {
  if (!hasDef(itemId)) return 0;
  const n = def(itemId).name;
  if (n.startsWith('wooden_') || n === 'bow' || n === 'shield' || n === 'fishing_rod') return B.PLANKS;
  if (n.startsWith('stone_')) return B.COBBLE;
  if (n.startsWith('iron_') || n === 'shears' || n === 'flint_and_steel') return I.IRON_INGOT;
  if (n.startsWith('golden_')) return I.GOLD_INGOT;
  if (n.startsWith('diamond_')) return I.DIAMOND;
  if (n.startsWith('netherite_')) return I.NETHERITE_INGOT;
  if (n.startsWith('leather_')) return I.LEATHER;
  if (n === 'glider') return I.FEATHER;
  return 0;
}

/** Saturation a food restores (vanilla values; defaults to food * 0.6). */
export function foodSaturation(id: number): number {
  const d = def(id);
  return d.sat ?? (d.food ?? 0) * 0.6;
}

/** The item a "pick block" (middle click) on this block should grab, or 0. */
export function pickItemFor(blockId: number): number {
  switch (blockId) {
    case B.AIR: case B.WATER: case B.LAVA: case B.PORTAL: case B.PISTON_HEAD: return 0;
    case B.FURNACE_LIT: return B.FURNACE;
    case B.CHEST_LOOT: return B.CHEST;
    case B.DOOR_LOWER: case B.DOOR_UPPER: return I.WOOD_DOOR;
    case B.BED_HEAD: return B.BED;
    case B.REDSTONE_WIRE: return I.REDSTONE;
    case B.REDSTONE_LAMP_LIT: return B.REDSTONE_LAMP;
    case B.WHEAT_0: case B.WHEAT_1: case B.WHEAT_2: return I.SEEDS;
    case B.CARROT_0: case B.CARROT_1: case B.CARROT_2: return I.CARROT;
    case B.POTATO_0: case B.POTATO_1: case B.POTATO_2: return I.POTATO;
    case B.BEETROOT_0: case B.BEETROOT_1: case B.BEETROOT_2: return I.BEETROOT_SEEDS;
    case B.PUMPKIN_STEM: return I.PUMPKIN_SEEDS;
    case B.MELON_STEM: return I.MELON_SEEDS;
    default: return hasDef(blockId) ? blockId : 0;
  }
}

/** Blocks the player can place / that show in the creative panel. */
export const PLACEABLE: number[] = [
  B.GRASS, B.DIRT, B.STONE, B.COBBLE, B.SAND, B.GRAVEL, B.LOG, B.BIRCH_LOG, B.SPRUCE_LOG, B.JUNGLE_LOG,
  B.PLANKS, B.LEAVES, B.BIRCH_LEAVES, B.SPRUCE_LEAVES, B.JUNGLE_LEAVES,
  B.GLASS, B.TABLE, B.FURNACE, B.CHEST, B.TORCH, B.BED, B.TNT,
  B.SANDSTONE, B.STONE_BRICKS, B.WOOL, B.SNOW_GRASS,
  B.POPPY, B.DANDELION, B.TALL_GRASS, B.CACTUS, B.SUGAR_CANE, B.SAPLING, B.FARMLAND,
  B.COAL_ORE, B.IRON_ORE, B.GOLD_ORE, B.DIAMOND_ORE, B.AMETHYST_ORE,
  B.IRON_BLOCK, B.GOLD_BLOCK, B.DIAMOND_BLOCK, B.BEDROCK,
  B.LADDER, B.TRAPDOOR, B.OBSIDIAN,
  B.PORTAL, B.NETHERRACK, B.GLOWSTONE, B.SOUL_SAND, B.QUARTZ_ORE,
  B.MAGMA, B.NETHER_BRICKS,
  B.REDSTONE_WIRE, B.REDSTONE_LAMP, B.LEVER, B.WOODEN_BUTTON, B.STONE_BUTTON,
  B.PISTON, B.STICKY_PISTON, B.PRESSURE_PLATE,
  B.BOOKSHELF, B.HAY_BALE, B.COAL_BLOCK, B.QUARTZ_BLOCK, B.SMOOTH_STONE, B2.EMERALD_BLOCK,
  // building + decoration pass
  B.BRICKS, B.CLAY, B.MOSSY_COBBLE, B.MOSSY_STONE_BRICKS, B.CRACKED_STONE_BRICKS, B.CHISELED_STONE_BRICKS,
  B.TERRACOTTA, B.SNOW_BLOCK, B.ICE, B.PACKED_ICE,
  B.COBBLE_SLAB, B.STONE_SLAB, B.OAK_SLAB, B.STONE_BRICK_SLAB, B.BRICK_SLAB, B.SANDSTONE_SLAB,
  B.OAK_STAIRS, B.COBBLE_STAIRS, B.STONE_BRICK_STAIRS, B.BRICK_STAIRS,
  B.OAK_FENCE, B.FENCE_GATE, B.GLASS_PANE, B.LANTERN,
  B.RED_WOOL, B.ORANGE_WOOL, B.YELLOW_WOOL, B.LIME_WOOL, B.CYAN_WOOL, B.BLUE_WOOL, B.PURPLE_WOOL, B.BLACK_WOOL,
  B.PUMPKIN, B.JACK_O_LANTERN, B.MELON,
  B.CORNFLOWER, B.ALLIUM, B.OXEYE_DAISY, B.BROWN_MUSHROOM, B.RED_MUSHROOM,
  B.BARREL, B.CAMPFIRE, B.ANVIL, B.ENCHANTING_TABLE, B.COMPOSTER, B.FLOWER_POT, B.CAKE,
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
  I.BUCKET, I.WATER_BUCKET, I.LAVA_BUCKET,
  I.FLINT_AND_STEEL, I.QUARTZ, I.REDSTONE, I.NETHER_BRICK,
  I.AMETHYST, I.MOB_CATCHER,
  I.GOLD_PICK, I.GOLD_AXE, I.GOLD_SHOVEL, I.GOLD_SWORD,
  I.GOLD_HELMET, I.GOLD_CHEST, I.GOLD_LEGS, I.GOLD_BOOTS,
  I.SHEARS, I.SHIELD, I.SPYGLASS, I.MILK_BUCKET,
  I.GOLDEN_APPLE, I.ENCHANTED_GOLDEN_APPLE, I.PAPER, I.BOOK,
  // building + decoration pass
  I.CLAY_BALL, I.BRICK, I.SNOWBALL, I.SUGAR, I.COOKIE, I.PUMPKIN_PIE, I.MELON_SLICE, I.GLISTERING_MELON,
  I.PUMPKIN_SEEDS, I.MELON_SEEDS, I.MUSHROOM_STEW,
  I.RED_DYE, I.ORANGE_DYE, I.YELLOW_DYE, I.LIME_DYE, I.CYAN_DYE, I.BLUE_DYE, I.PURPLE_DYE, I.BLACK_DYE,
  I.GLASS_BOTTLE, I.WATER_BOTTLE,
  I.POTION_HEALING, I.POTION_SWIFTNESS, I.POTION_NIGHT_VISION, I.POTION_WATER_BREATHING,
  I.POTION_FIRE_RESISTANCE, I.POTION_STRENGTH, I.POTION_LEAPING, I.POTION_REGENERATION,
  I.EXPERIENCE_BOTTLE, I.MAP, I.RECOVERY_COMPASS, I.GLIDER, I.FIREWORK_ROCKET, I.WARP_PEARL,
];

// =============================================================================
// Nether utility pass: netherite, soul light, the respawn anchor, fire charges
// and the portal compass (block ids 252-255, item ids 365-389). Self-contained:
// the enums merge into B / I, and the shared sets/LUTs are extended in place.
// =============================================================================

export enum B {
  NETHERITE_BLOCK = 252,
  /** blue-flamed torch: a dimmer, cold light (wall facing lives in torchFacings) */
  SOUL_TORCH = 253,
  /** hanging (meta 1) or standing lantern with a soul flame */
  SOUL_LANTERN = 254,
  /** charged with glowstone (meta = charge 0..4); sets a Nether respawn point, explodes elsewhere */
  RESPAWN_ANCHOR = 255,
}

export enum I {
  NETHERITE_SCRAP = 365,
  NETHERITE_INGOT = 366,
  NETHERITE_PICK = 367,
  NETHERITE_AXE = 368,
  NETHERITE_SHOVEL = 369,
  NETHERITE_SWORD = 370,
  NETHERITE_HELMET = 371,
  NETHERITE_CHEST = 372,
  NETHERITE_LEGS = 373,
  NETHERITE_BOOTS = 374,
  /** lights fires/portals on a block, or is thrown as a small fireball */
  FIRE_CHARGE = 375,
  BLAZE_POWDER = 376,
  /** needle points at the Nether portal you last used in this dimension */
  PORTAL_COMPASS = 377,
}

let REG_NAMES: Map<string, number> | null = null;
/** Item/block id for a registry name (other tracks' blocks are looked up this
 *  way), or `fallback` when no such name is registered. */
export function registryId(name: string, fallback = 0): number {
  if (!REG_NAMES || !REG_NAMES.has(name)) {
    REG_NAMES = new Map();
    for (const d of DEFS.values()) if (!REG_NAMES.has(d.name)) REG_NAMES.set(d.name, d.id);
  }
  return REG_NAMES.get(name) ?? fallback;
}

blockDef({
  id: B.NETHERITE_BLOCK, name: 'netherite_block', label: 'Block of Netherite', hardness: 12, tool: 'pickaxe', minTier: 8, sound: 'stone',
  faces: { top: 'netherite_block', bottom: 'netherite_block', sides: 'netherite_block' },
});
blockDef({
  id: B.SOUL_TORCH, name: 'soul_torch', label: 'Soul Torch', hardness: 0, sound: 'wood',
  solid: false, opaque: false, occludes: false,
  faces: { top: 'soul_torch', bottom: 'soul_torch', sides: 'soul_torch' },
});
blockDef({
  id: B.SOUL_LANTERN, name: 'soul_lantern', label: 'Soul Lantern', hardness: 1.5, tool: 'pickaxe', sound: 'stone',
  solid: false, opaque: false, occludes: false,
  faces: { top: 'soul_lantern', bottom: 'soul_lantern', sides: 'soul_lantern' },
});
blockDef({
  id: B.RESPAWN_ANCHOR, name: 'respawn_anchor', label: 'Respawn Anchor', hardness: 9, tool: 'pickaxe', minTier: 8, sound: 'stone',
  faces: { top: 'respawn_anchor_top', bottom: 'respawn_anchor_bottom', sides: 'respawn_anchor_side_0' },
});

itemDef({ id: I.NETHERITE_SCRAP, name: 'netherite_scrap', label: 'Netherite Scrap', sprite: 'netherite_scrap' });
itemDef({ id: I.NETHERITE_INGOT, name: 'netherite_ingot', label: 'Netherite Ingot', sprite: 'netherite_ingot' });
for (const [id, kind, damage] of [
  [I.NETHERITE_PICK, 'pickaxe', 6], [I.NETHERITE_AXE, 'axe', 10],
  [I.NETHERITE_SHOVEL, 'shovel', 6], [I.NETHERITE_SWORD, 'sword', 8],
] as [number, ToolKind, number][]) {
  itemDef({
    id, name: `netherite_${kind}`, label: `Netherite ${kind[0].toUpperCase()}${kind.slice(1)}`, sprite: `netherite_${kind}`,
    stack: 1, toolInfo: { kind, tier: 9, damage, speed: 9 }, durability: 2031,
  });
}
armorDef(I.NETHERITE_HELMET, 'netherite_helmet', 'Netherite Helmet', 'netherite_helmet', ARMOR_HEAD, 3, 407);
armorDef(I.NETHERITE_CHEST, 'netherite_chestplate', 'Netherite Chestplate', 'netherite_chest', ARMOR_CHEST, 8, 592);
armorDef(I.NETHERITE_LEGS, 'netherite_leggings', 'Netherite Leggings', 'netherite_legs', ARMOR_LEGS, 6, 555);
armorDef(I.NETHERITE_BOOTS, 'netherite_boots', 'Netherite Boots', 'netherite_boots', ARMOR_FEET, 3, 481);
itemDef({ id: I.FIRE_CHARGE, name: 'fire_charge', label: 'Fire Charge', sprite: 'fire_charge' });
itemDef({ id: I.BLAZE_POWDER, name: 'blaze_powder', label: 'Blaze Powder', sprite: 'blaze_powder' });
itemDef({ id: I.PORTAL_COMPASS, name: 'portal_compass', label: 'Portal Compass', sprite: 'portal_compass', stack: 1 });

/** Netherite gear (and ancient debris) shrugs off fire: its drops float on lava. */
export function isFireproof(id: number): boolean {
  if (!hasDef(id)) return false;
  const n = def(id).name;
  return n.startsWith('netherite_') || n === 'ancient_debris';
}
/** Diamond piece -> its netherite upgrade (anvil smithing), or 0. */
export function netheriteUpgrade(id: number): number {
  switch (id) {
    case I.DIAMOND_PICK: return I.NETHERITE_PICK;
    case I.DIAMOND_AXE: return I.NETHERITE_AXE;
    case I.DIAMOND_SHOVEL: return I.NETHERITE_SHOVEL;
    case I.DIAMOND_SWORD: return I.NETHERITE_SWORD;
    case I.DIAMOND_HELMET: return I.NETHERITE_HELMET;
    case I.DIAMOND_CHEST: return I.NETHERITE_CHEST;
    case I.DIAMOND_LEGS: return I.NETHERITE_LEGS;
    case I.DIAMOND_BOOTS: return I.NETHERITE_BOOTS;
    default: return 0;
  }
}
/** Soul-fire light sources: their block light is tinted a cold cyan. */
export const SOUL_LIGHTS = new Set<number>([B.SOUL_TORCH, B.SOUL_LANTERN]);
/** Block-light level (0..15) of an emitter; the respawn anchor glows by charge. */
export function emitLevel(id: number, meta = 0): number {
  switch (id) {
    case B.SOUL_TORCH: return 11;
    case B.SOUL_LANTERN: return 12;
    case B.PORTAL: return 11;
    case B.RESPAWN_ANCHOR: return [0, 6, 9, 12, 15][Math.max(0, Math.min(4, meta))];
    default: return 15;
  }
}

SHAPED.add(B.SOUL_LANTERN); SHAPED.add(B.RESPAWN_ANCHOR);
META_BLOCKS.add(B.SOUL_LANTERN); META_BLOCKS.add(B.RESPAWN_ANCHOR);
FLOOR_BLOCKS.add(B.SOUL_TORCH);
for (const id of [B.NETHERITE_BLOCK, B.RESPAWN_ANCHOR]) { OPAQUE_LUT[id] = 1; OCCLUDE_LUT[id] = 1; }
PLACEABLE.push(B.NETHERITE_BLOCK, B.SOUL_TORCH, B.SOUL_LANTERN, B.RESPAWN_ANCHOR);
CREATIVE_ITEMS.push(
  B.NETHERITE_BLOCK, B.SOUL_TORCH, B.SOUL_LANTERN, B.RESPAWN_ANCHOR,
  I.NETHERITE_SCRAP, I.NETHERITE_INGOT,
  I.NETHERITE_PICK, I.NETHERITE_AXE, I.NETHERITE_SHOVEL, I.NETHERITE_SWORD,
  I.NETHERITE_HELMET, I.NETHERITE_CHEST, I.NETHERITE_LEGS, I.NETHERITE_BOOTS,
  I.FIRE_CHARGE, I.BLAZE_POWDER, I.PORTAL_COMPASS,
);
