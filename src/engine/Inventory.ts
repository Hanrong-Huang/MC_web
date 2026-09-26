// Inventory slots, shaped crafting recipes (2x2 and 3x3), furnace smelting,
// and chest storage.

import { B, B2, I, def, hasDef, SLAB_KINDS, WOOL_COLORS, registryId } from './Blocks';
import { MaybeSlot, FurnaceSave, ChestSave } from './Persistence';

export type Slot = MaybeSlot;

export const HOTBAR_SIZE = 9;
export const INV_SIZE = 36; // 9 hotbar + 27 main

export class Inventory {
  slots: Slot[] = new Array(INV_SIZE).fill(null);
  /** worn armor by slot: 0 head, 1 chest, 2 legs, 3 feet */
  armor: Slot[] = new Array(4).fill(null);
  selected = 0;
  onChange: () => void = () => {};

  getSelected(): Slot { return this.slots[this.selected]; }

  /** Total armor defense points across worn pieces (2 points = one armor icon). */
  armorPoints(): number {
    let n = 0;
    for (const s of this.armor) if (s) n += def(s.id).armor?.points ?? 0;
    return n;
  }

  /** Add items; returns the count that did not fit. */
  add(id: number, count: number): number {
    const max = def(id).stack;
    // merge into existing stacks first
    for (let i = 0; i < INV_SIZE && count > 0; i++) {
      const s = this.slots[i];
      if (s && s.id === id && s.count < max) {
        const take = Math.min(max - s.count, count);
        s.count += take;
        count -= take;
      }
    }
    for (let i = 0; i < INV_SIZE && count > 0; i++) {
      if (!this.slots[i]) {
        const take = Math.min(max, count);
        this.slots[i] = { id, count: take };
        count -= take;
      }
    }
    this.onChange();
    return count;
  }

  /** Remove one item from the selected hotbar slot. */
  consumeSelected(): void {
    const s = this.slots[this.selected];
    if (!s) return;
    s.count--;
    if (s.count <= 0) this.slots[this.selected] = null;
    this.onChange();
  }

  /** Remove a single item of the given id from anywhere; false if absent. */
  removeOne(id: number): boolean {
    for (let i = 0; i < INV_SIZE; i++) {
      const s = this.slots[i];
      if (s && s.id === id) {
        s.count--;
        if (s.count <= 0) this.slots[i] = null;
        this.onChange();
        return true;
      }
    }
    return false;
  }

  count(id: number): number {
    let n = 0;
    for (const s of this.slots) if (s && s.id === id) n += s.count;
    return n;
  }

  /** Index of the first empty slot, or -1 if the inventory is full. */
  firstEmpty(): number {
    for (let i = 0; i < INV_SIZE; i++) if (!this.slots[i]) return i;
    return -1;
  }

  serialize(): { slots: Slot[]; selected: number; armor?: Slot[] } {
    return {
      slots: this.slots.map((s) => (s ? { ...s } : null)),
      armor: this.armor.map((s) => (s ? { ...s } : null)),
      selected: this.selected,
    };
  }

  load(data: { slots: Slot[]; selected: number; armor?: Slot[] } | undefined): void {
    if (!data) return;
    this.slots = new Array(INV_SIZE).fill(null);
    for (let i = 0; i < Math.min(INV_SIZE, data.slots.length); i++) {
      const s = data.slots[i];
      if (s && hasDef(s.id) && s.count > 0) {
        this.slots[i] = {
          id: s.id, count: s.count,
          ...(s.dur !== undefined ? { dur: s.dur } : {}),
          ...(s.mob !== undefined ? { mob: s.mob } : {}),
          ...(s.ench ? { ench: { ...s.ench } } : {}),
        };
      }
    }
    this.armor = new Array(4).fill(null);
    for (let i = 0; i < 4 && data.armor && i < data.armor.length; i++) {
      const s = data.armor[i];
      if (s && hasDef(s.id) && def(s.id).armor) {
        this.armor[i] = {
          id: s.id, count: 1, ...(s.dur !== undefined ? { dur: s.dur } : {}), ...(s.ench ? { ench: { ...s.ench } } : {}),
        };
      }
    }
    this.selected = Math.max(0, Math.min(8, data.selected | 0));
    this.onChange();
  }
}

// ---------------------------------------------------------------------------
// Crafting
// ---------------------------------------------------------------------------

interface Recipe { shape: number[][]; out: number; n: number }

export interface RecipeView {
  out: number;
  n: number;
  shape: number[][];
  ingredients: number[];
  counts: { id: number; count: number }[];
}

/** Read-only list of all recipes for the recipe-book UI. */
export function allRecipes(): RecipeView[] {
  return RECIPES.map((r) => {
    const counts = new Map<number, number>();
    for (const id of r.shape.flat()) {
      if (id !== 0) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return {
      out: r.out,
      n: r.n,
      shape: r.shape.map((row) => [...row]),
      ingredients: [...counts.keys()],
      counts: [...counts].map(([id, count]) => ({ id, count })),
    };
  });
}

const P = B.PLANKS, C = B.COBBLE, S = I.STICK;
const FE = I.IRON_INGOT, AU = I.GOLD_INGOT, DI = I.DIAMOND;
const W = B.WOOL, G = I.GUNPOWDER, SA = B.SAND, ST = I.STRING;
const CA = I.CARROT, PO = I.POTATO, BE = I.BEETROOT, BO = I.BOWL;
const LE = I.LEATHER;
const AM = I.AMETHYST;

function toolRecipes(mat: number, pick: number, axe: number, shovel: number, sword: number): Recipe[] {
  const M = mat;
  return [
    { shape: [[M, M, M], [0, S, 0], [0, S, 0]], out: pick, n: 1 },
    { shape: [[M, M], [M, S], [0, S]], out: axe, n: 1 },
    { shape: [[M], [S], [S]], out: shovel, n: 1 },
    { shape: [[M], [M], [S]], out: sword, n: 1 },
  ];
}

function armorRecipes(mat: number, helmet: number, chest: number, legs: number, boots: number): Recipe[] {
  const M = mat;
  return [
    { shape: [[M, M, M], [M, 0, M]], out: helmet, n: 1 },
    { shape: [[M, 0, M], [M, M, M], [M, M, M]], out: chest, n: 1 },
    { shape: [[M, M, M], [M, 0, M], [M, 0, M]], out: legs, n: 1 },
    { shape: [[M, 0, M], [M, 0, M]], out: boots, n: 1 },
  ];
}

// --- building + decoration pass ----------------------------------------------
const FG = B.GLASS, SU = I.SUGAR, WH = I.WHEAT, PA = I.PAPER, WB = I.WATER_BOTTLE;
const DECOR_RECIPES: Recipe[] = [
  // masonry
  { shape: [[I.CLAY_BALL, I.CLAY_BALL], [I.CLAY_BALL, I.CLAY_BALL]], out: B.CLAY, n: 1 },
  { shape: [[I.BRICK, I.BRICK], [I.BRICK, I.BRICK]], out: B.BRICKS, n: 1 },
  { shape: [[C, B.LEAVES]], out: B.MOSSY_COBBLE, n: 1 },
  { shape: [[B.STONE_BRICKS, B.LEAVES]], out: B.MOSSY_STONE_BRICKS, n: 1 },
  { shape: [[B.STONE_BRICK_SLAB], [B.STONE_BRICK_SLAB]], out: B.CHISELED_STONE_BRICKS, n: 1 },
  { shape: [[I.SNOWBALL, I.SNOWBALL], [I.SNOWBALL, I.SNOWBALL]], out: B.SNOW_BLOCK, n: 1 },
  { shape: [[B.ICE, B.ICE, B.ICE], [B.ICE, B.ICE, B.ICE], [B.ICE, B.ICE, B.ICE]], out: B.PACKED_ICE, n: 1 },
  // slabs (3 -> 6) and stairs (6 -> 4)
  ...SLAB_KINDS.flatMap(([slab, stairs, full]): Recipe[] => [
    { shape: [[full, full, full]], out: slab, n: 6 },
    ...(stairs ? [{ shape: [[full, 0, 0], [full, full, 0], [full, full, full]], out: stairs, n: 4 }] : []),
  ]),
  // fencing, glazing, lighting
  { shape: [[P, S, P], [P, S, P]], out: B.OAK_FENCE, n: 3 },
  { shape: [[S, P, S], [S, P, S]], out: B.FENCE_GATE, n: 1 },
  // Nether wood: stems saw into planks; fences/gates keep their colour
  { shape: [[B.CRIMSON_STEM]], out: B.CRIMSON_PLANKS, n: 4 },
  { shape: [[B.WARPED_STEM]], out: B.WARPED_PLANKS, n: 4 },
  ...([
    [B.CRIMSON_PLANKS, B.CRIMSON_FENCE, B.CRIMSON_FENCE_GATE, I.CRIMSON_DOOR, B.CRIMSON_TRAPDOOR],
    [B.WARPED_PLANKS, B.WARPED_FENCE, B.WARPED_FENCE_GATE, I.WARPED_DOOR, B.WARPED_TRAPDOOR],
  ] as const)
    .flatMap(([NP, fence, gate, door, trap]): Recipe[] => [
      { shape: [[NP, S, NP], [NP, S, NP]], out: fence, n: 3 },
      { shape: [[S, NP, S], [S, NP, S]], out: gate, n: 1 },
      { shape: [[NP, NP], [NP, NP], [NP, NP]], out: door, n: 3 },
      { shape: [[NP, NP, NP], [NP, NP, NP]], out: trap, n: 2 },
    ]),
  { shape: [[FG, FG, FG], [FG, FG, FG]], out: B.GLASS_PANE, n: 16 },
  { shape: [[0, FE, 0], [FE, B.TORCH, FE], [0, FE, 0]], out: B.LANTERN, n: 2 },
  { shape: [[B.PUMPKIN], [B.TORCH]], out: B.JACK_O_LANTERN, n: 1 },
  // workshop blocks
  { shape: [[B.IRON_BLOCK, B.IRON_BLOCK, B.IRON_BLOCK], [0, FE, 0], [FE, FE, FE]], out: B.ANVIL, n: 1 },
  { shape: [[0, I.BOOK, 0], [DI, B.OBSIDIAN, DI], [B.OBSIDIAN, B.OBSIDIAN, B.OBSIDIAN]], out: B.ENCHANTING_TABLE, n: 1 },
  { shape: [[P, B.OAK_SLAB, P], [P, 0, P], [P, B.OAK_SLAB, P]], out: B.BARREL, n: 1 },
  ...[B.LOG, B.BIRCH_LOG, B.SPRUCE_LOG, B.JUNGLE_LOG].map((log): Recipe =>
    ({ shape: [[0, S, 0], [S, I.COAL, S], [log, log, log]], out: B.CAMPFIRE, n: 1 })),
  { shape: [[I.BRICK, 0, I.BRICK], [0, I.BRICK, 0]], out: B.FLOWER_POT, n: 1 },
  { shape: [[B.OAK_SLAB, 0, B.OAK_SLAB], [B.OAK_SLAB, 0, B.OAK_SLAB], [B.OAK_SLAB, B.OAK_SLAB, B.OAK_SLAB]], out: B.COMPOSTER, n: 1 },
  // garden produce + kitchen
  { shape: [[B.PUMPKIN]], out: I.PUMPKIN_SEEDS, n: 4 },
  { shape: [[I.MELON_SLICE]], out: I.MELON_SEEDS, n: 1 },
  { shape: [[I.MELON_SLICE, I.MELON_SLICE, I.MELON_SLICE], [I.MELON_SLICE, I.MELON_SLICE, I.MELON_SLICE], [I.MELON_SLICE, I.MELON_SLICE, I.MELON_SLICE]], out: B.MELON, n: 1 },
  { shape: [[B.SUGAR_CANE]], out: I.SUGAR, n: 1 },
  { shape: [[WH, SU, WH]], out: I.COOKIE, n: 8 },
  { shape: [[B.PUMPKIN, SU, WH]], out: I.PUMPKIN_PIE, n: 1 },
  { shape: [[I.MILK_BUCKET, I.MILK_BUCKET, I.MILK_BUCKET], [SU, I.APPLE, SU], [WH, WH, WH]], out: B.CAKE, n: 1 },
  { shape: [[B.BROWN_MUSHROOM, B.RED_MUSHROOM], [BO, 0]], out: I.MUSHROOM_STEW, n: 1 },
  { shape: [[0, AU, 0], [AU, I.MELON_SLICE, AU], [0, AU, 0]], out: I.GLISTERING_MELON, n: 1 },
  // dyes + coloured wool
  { shape: [[B.POPPY]], out: I.RED_DYE, n: 1 },
  { shape: [[BE]], out: I.RED_DYE, n: 1 },
  { shape: [[B.DANDELION]], out: I.YELLOW_DYE, n: 1 },
  { shape: [[B.CORNFLOWER]], out: I.BLUE_DYE, n: 1 },
  { shape: [[B.ALLIUM]], out: I.PURPLE_DYE, n: 1 },
  { shape: [[I.COAL]], out: I.BLACK_DYE, n: 1 },
  { shape: [[I.RED_DYE, I.YELLOW_DYE]], out: I.ORANGE_DYE, n: 2 },
  { shape: [[I.RED_DYE, I.BLUE_DYE]], out: I.PURPLE_DYE, n: 2 },
  { shape: [[I.BLUE_DYE, I.LIME_DYE]], out: I.CYAN_DYE, n: 2 },
  ...WOOL_COLORS.map(([wool, dye]): Recipe => ({ shape: [[dye, W]], out: wool, n: 1 })),
  // brewing-lite: a water bottle plus one ingredient
  { shape: [[FG, 0, FG], [0, FG, 0]], out: I.GLASS_BOTTLE, n: 3 },
  { shape: [[WB, I.GLISTERING_MELON]], out: I.POTION_HEALING, n: 1 },
  { shape: [[WB, SU]], out: I.POTION_SWIFTNESS, n: 1 },
  { shape: [[WB, I.GOLDEN_CARROT]], out: I.POTION_NIGHT_VISION, n: 1 },
  { shape: [[WB, I.RAW_FISH]], out: I.POTION_WATER_BREATHING, n: 1 },
  { shape: [[WB, B.MAGMA]], out: I.POTION_FIRE_RESISTANCE, n: 1 },
  { shape: [[WB, I.QUARTZ]], out: I.POTION_STRENGTH, n: 1 },
  { shape: [[WB, I.FEATHER]], out: I.POTION_LEAPING, n: 1 },
  { shape: [[WB, AM]], out: I.POTION_REGENERATION, n: 1 },
  // exploration
  { shape: [[PA, PA, PA], [PA, I.COMPASS, PA], [PA, PA, PA]], out: I.MAP, n: 1 },
  { shape: [[AM, AM, AM], [AM, I.COMPASS, AM], [AM, AM, AM]], out: I.RECOVERY_COMPASS, n: 1 },
  { shape: [[LE, S, LE], [I.FEATHER, S, I.FEATHER], [I.FEATHER, 0, I.FEATHER]], out: I.GLIDER, n: 1 },
  { shape: [[PA, G]], out: I.FIREWORK_ROCKET, n: 3 },
  { shape: [[0, AM, 0], [AM, I.EMERALD, AM], [0, AM, 0]], out: I.WARP_PEARL, n: 2 },
];

// --- Nether utility pass: netherite, soul light, anchors, fire charges ----------
// Other tracks' items are looked up by registry name (0 = not in this build).
const NETHER_RECIPES: Recipe[] = ((): Recipe[] => {
  const SC = I.NETHERITE_SCRAP, NI = I.NETHERITE_INGOT, OB = B.OBSIDIAN;
  const out: Recipe[] = [
    // four scrap bound with four gold, as in vanilla (laid out as a ring here)
    { shape: [[SC, AU, SC], [AU, 0, AU], [SC, AU, SC]], out: NI, n: 1 },
    { shape: [[NI, NI, NI], [NI, NI, NI], [NI, NI, NI]], out: B.NETHERITE_BLOCK, n: 1 },
    { shape: [[B.NETHERITE_BLOCK]], out: NI, n: 9 },
    { shape: [[I.COAL], [S], [B.SOUL_SAND]], out: B.SOUL_TORCH, n: 4 },
    { shape: [[0, FE, 0], [FE, B.SOUL_TORCH, FE], [0, FE, 0]], out: B.SOUL_LANTERN, n: 2 },
    { shape: [[OB, OB, OB], [B.GLOWSTONE, B.GLOWSTONE, B.GLOWSTONE], [OB, OB, OB]], out: B.RESPAWN_ANCHOR, n: 1 },
    // without blazes, a pinch of magma lights the charge
    { shape: [[G, B.MAGMA, I.COAL]], out: I.FIRE_CHARGE, n: 3 },
    { shape: [[G, I.BLAZE_POWDER, I.COAL]], out: I.FIRE_CHARGE, n: 3 },
    { shape: [[I.WATER_BOTTLE, I.BLAZE_POWDER]], out: I.POTION_STRENGTH, n: 1 },
    { shape: [[0, OB, 0], [OB, I.COMPASS, OB], [0, OB, 0]], out: I.PORTAL_COMPASS, n: 1 },
  ];
  const soil = registryId('soul_soil');
  if (soil) out.push({ shape: [[I.COAL], [S], [soil]], out: B.SOUL_TORCH, n: 4 });
  // blaze rods grind to powder; nuggets pack into ingots and back
  out.push({ shape: [[I.BLAZE_ROD]], out: I.BLAZE_POWDER, n: 2 });
  const GN = I.GOLD_NUGGET;
  out.push({ shape: [[GN, GN, GN], [GN, GN, GN], [GN, GN, GN]], out: AU, n: 1 });
  out.push({ shape: [[AU]], out: GN, n: 9 });
  return out;
})();

/** Containers handed back when a recipe uses up their contents (milk -> bucket). */
export function craftRemainders(out: number): { id: number; count: number }[] {
  return out === B.CAKE ? [{ id: I.BUCKET, count: 3 }] : [];
}

const RECIPES: Recipe[] = [
  { shape: [[B.LOG]], out: B.PLANKS, n: 4 },
  { shape: [[B.BIRCH_LOG]], out: B.PLANKS, n: 4 },
  { shape: [[B.SPRUCE_LOG]], out: B.PLANKS, n: 4 },
  { shape: [[B.JUNGLE_LOG]], out: B.PLANKS, n: 4 },
  { shape: [[P], [P]], out: I.STICK, n: 4 },
  { shape: [[P, P], [P, P]], out: B.TABLE, n: 1 },
  { shape: [[C, C, C], [C, 0, C], [C, C, C]], out: B.FURNACE, n: 1 },
  { shape: [[P, P, P], [P, 0, P], [P, P, P]], out: B.CHEST, n: 1 },
  ...toolRecipes(P, I.WOOD_PICK, I.WOOD_AXE, I.WOOD_SHOVEL, I.WOOD_SWORD),
  ...toolRecipes(C, I.STONE_PICK, I.STONE_AXE, I.STONE_SHOVEL, I.STONE_SWORD),
  // blackstone stands in for cobblestone (as in vanilla)
  { shape: [[B.BLACKSTONE, B.BLACKSTONE, B.BLACKSTONE], [B.BLACKSTONE, 0, B.BLACKSTONE], [B.BLACKSTONE, B.BLACKSTONE, B.BLACKSTONE]], out: B.FURNACE, n: 1 },
  ...toolRecipes(B.BLACKSTONE, I.STONE_PICK, I.STONE_AXE, I.STONE_SHOVEL, I.STONE_SWORD),
  ...toolRecipes(FE, I.IRON_PICK, I.IRON_AXE, I.IRON_SHOVEL, I.IRON_SWORD),
  ...toolRecipes(DI, I.DIAMOND_PICK, I.DIAMOND_AXE, I.DIAMOND_SHOVEL, I.DIAMOND_SWORD),
  ...armorRecipes(LE, I.LEATHER_HELMET, I.LEATHER_CHEST, I.LEATHER_LEGS, I.LEATHER_BOOTS),
  ...armorRecipes(FE, I.IRON_HELMET, I.IRON_CHEST, I.IRON_LEGS, I.IRON_BOOTS),
  ...armorRecipes(DI, I.DIAMOND_HELMET, I.DIAMOND_CHEST, I.DIAMOND_LEGS, I.DIAMOND_BOOTS),
  ...toolRecipes(AU, I.GOLD_PICK, I.GOLD_AXE, I.GOLD_SHOVEL, I.GOLD_SWORD),
  ...armorRecipes(AU, I.GOLD_HELMET, I.GOLD_CHEST, I.GOLD_LEGS, I.GOLD_BOOTS),
  // shears: two ingots on a diagonal
  { shape: [[0, FE], [FE, 0]], out: I.SHEARS, n: 1 },
  // shield: a plank board with an iron boss
  { shape: [[P, FE, P], [P, P, P], [0, P, 0]], out: I.SHIELD, n: 1 },
  // spyglass: an amethyst lens on an iron tube
  { shape: [[AM], [FE], [FE]], out: I.SPYGLASS, n: 1 },
  // golden apples: an apple wrapped in gold (ingots, or whole blocks for the enchanted one)
  { shape: [[AU, AU, AU], [AU, I.APPLE, AU], [AU, AU, AU]], out: I.GOLDEN_APPLE, n: 1 },
  { shape: [[B.GOLD_BLOCK, B.GOLD_BLOCK, B.GOLD_BLOCK], [B.GOLD_BLOCK, I.APPLE, B.GOLD_BLOCK], [B.GOLD_BLOCK, B.GOLD_BLOCK, B.GOLD_BLOCK]], out: I.ENCHANTED_GOLDEN_APPLE, n: 1 },
  // redstone + nether utility
  { shape: [[FE, 0], [0, I.FLINT]], out: I.FLINT_AND_STEEL, n: 1 },
  { shape: [[P, P]], out: B.PRESSURE_PLATE, n: 1 },
  { shape: [[B.OBSIDIAN, B.OBSIDIAN, B.OBSIDIAN], [B.OBSIDIAN, 0, B.OBSIDIAN], [B.OBSIDIAN, B.OBSIDIAN, B.OBSIDIAN]], out: B.PORTAL, n: 1 },
  { shape: [[I.REDSTONE, B.GLOWSTONE, I.REDSTONE], [B.GLOWSTONE, I.REDSTONE, B.GLOWSTONE]], out: B.REDSTONE_LAMP, n: 1 },
  { shape: [[S], [C]], out: B.LEVER, n: 1 },
  { shape: [[P]], out: B.WOODEN_BUTTON, n: 1 },
  { shape: [[C]], out: B.STONE_BUTTON, n: 1 },
  { shape: [[P, P, P], [C, FE, C], [C, I.REDSTONE, C]], out: B.PISTON, n: 1 },
  { shape: [[B.SAPLING], [B.PISTON]], out: B.STICKY_PISTON, n: 1 },
  // light + utility
  { shape: [[I.COAL], [S]], out: B.TORCH, n: 4 },
  { shape: [[G, SA, G], [SA, G, SA], [G, SA, G]], out: B.TNT, n: 1 },
  { shape: [[W, W, W], [P, P, P]], out: B.BED, n: 1 },
  // ranged
  { shape: [[0, S, ST], [S, 0, ST], [0, S, ST]], out: I.BOW, n: 1 },
  { shape: [[I.FLINT], [S], [I.FEATHER]], out: I.ARROW, n: 4 },
  // farming
  { shape: [[P, P], [0, S], [0, S]], out: I.HOE, n: 1 },
  { shape: [[I.WHEAT, I.WHEAT, I.WHEAT]], out: I.BREAD, n: 1 },
  { shape: [[I.BONE]], out: I.BONE_MEAL, n: 3 },
  { shape: [[P, 0, P], [0, P, 0]], out: I.BOWL, n: 4 },
  { shape: [[BE, BE, BE], [0, BO, 0]], out: I.BEETROOT_SOUP, n: 1 },
  { shape: [[CA, PO, BE], [0, BO, 0]], out: I.VEGETABLE_STEW, n: 1 },
  { shape: [[AU, AU, AU], [AU, CA, AU], [AU, AU, AU]], out: I.GOLDEN_CARROT, n: 1 },
  // building materials
  { shape: [[SA, SA], [SA, SA]], out: B.SANDSTONE, n: 1 },
  { shape: [[B.STONE, B.STONE], [B.STONE, B.STONE]], out: B.STONE_BRICKS, n: 4 },
  { shape: [[I.NETHER_BRICK, I.NETHER_BRICK], [I.NETHER_BRICK, I.NETHER_BRICK]], out: B.NETHER_BRICKS, n: 1 },
  { shape: [[ST, ST], [ST, ST]], out: B.WOOL, n: 1 },
  // buildable interactivity
  { shape: [[P, P], [P, P], [P, P]], out: I.WOOD_DOOR, n: 3 },
  { shape: [[P, P, P], [0, S, 0], [0, S, 0]], out: B.LADDER, n: 3 },
  // 3x2 like vanilla (the old ring shape was the chest's, so it never crafted)
  { shape: [[P, P, P], [P, P, P]], out: B.TRAPDOOR, n: 2 },
  { shape: [[FE, FE], [FE, FE], [FE, FE]], out: I.IRON_DOOR, n: 3 },
  { shape: [[FE, FE], [FE, FE]], out: B.IRON_TRAPDOOR, n: 1 },
  // tools & utilities
  { shape: [[0, 0, S], [0, S, ST], [S, 0, 0]], out: I.FISHING_ROD, n: 1 },
  // compass: 4 iron in a diamond around a central iron (dial)
  { shape: [[0, FE, 0], [FE, FE, FE], [0, FE, 0]], out: I.COMPASS, n: 1 },
  // clock: gold ring with an iron core (redstone stand-in for the dial)
  { shape: [[0, AU, 0], [AU, FE, AU], [0, AU, 0]], out: I.CLOCK, n: 1 },
  // bucket: three iron in a V
  { shape: [[FE, 0, FE], [0, FE, 0]], out: I.BUCKET, n: 1 },
  // mob catcher: hollow amethyst frame (8 gems), like a chest shell
  { shape: [[AM, AM, AM], [AM, 0, AM], [AM, AM, AM]], out: I.MOB_CATCHER, n: 1 },
  // saddle: leather seat with iron buckles
  { shape: [[LE, LE, LE], [FE, 0, FE]], out: I.SADDLE, n: 1 },
  // iron horse armor: iron barding around a leather lining
  { shape: [[FE, 0, FE], [FE, LE, FE], [FE, FE, FE]], out: I.HORSE_ARMOR, n: 1 },
  // resource blocks (and back)
  { shape: [[FE, FE, FE], [FE, FE, FE], [FE, FE, FE]], out: B.IRON_BLOCK, n: 1 },
  { shape: [[AU, AU, AU], [AU, AU, AU], [AU, AU, AU]], out: B.GOLD_BLOCK, n: 1 },
  { shape: [[DI, DI, DI], [DI, DI, DI], [DI, DI, DI]], out: B.DIAMOND_BLOCK, n: 1 },
  { shape: [[B.IRON_BLOCK]], out: I.IRON_INGOT, n: 9 },
  { shape: [[B.GOLD_BLOCK]], out: I.GOLD_INGOT, n: 9 },
  { shape: [[B.DIAMOND_BLOCK]], out: I.DIAMOND, n: 9 },
  // storage + decorative blocks
  { shape: [[I.COAL, I.COAL, I.COAL], [I.COAL, I.COAL, I.COAL], [I.COAL, I.COAL, I.COAL]], out: B.COAL_BLOCK, n: 1 },
  { shape: [[B.COAL_BLOCK]], out: I.COAL, n: 9 },
  { shape: [[I.EMERALD, I.EMERALD, I.EMERALD], [I.EMERALD, I.EMERALD, I.EMERALD], [I.EMERALD, I.EMERALD, I.EMERALD]], out: B2.EMERALD_BLOCK, n: 1 },
  { shape: [[B2.EMERALD_BLOCK]], out: I.EMERALD, n: 9 },
  { shape: [[I.WHEAT, I.WHEAT, I.WHEAT], [I.WHEAT, I.WHEAT, I.WHEAT], [I.WHEAT, I.WHEAT, I.WHEAT]], out: B.HAY_BALE, n: 1 },
  { shape: [[B.HAY_BALE]], out: I.WHEAT, n: 9 },
  { shape: [[I.QUARTZ, I.QUARTZ], [I.QUARTZ, I.QUARTZ]], out: B.QUARTZ_BLOCK, n: 1 },
  // paper from cane, books from paper + leather, shelves from books
  { shape: [[B.SUGAR_CANE, B.SUGAR_CANE, B.SUGAR_CANE]], out: I.PAPER, n: 3 },
  { shape: [[I.PAPER, I.PAPER], [I.PAPER, LE]], out: I.BOOK, n: 1 },
  { shape: [[P, P, P], [I.BOOK, I.BOOK, I.BOOK], [P, P, P]], out: B.BOOKSHELF, n: 1 },
  ...DECOR_RECIPES,
  ...NETHER_RECIPES,
];

function mirror(shape: number[][]): number[][] {
  return shape.map((row) => [...row].reverse());
}

/** Crop a grid (given as Slot[] with width w) to its bounding box of ids. */
function cropGrid(grid: Slot[], w: number): number[][] | null {
  const h = grid.length / w;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (grid[y * w + x]) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < 0) return null;
  const out: number[][] = [];
  for (let y = minY; y <= maxY; y++) {
    const row: number[] = [];
    for (let x = minX; x <= maxX; x++) row.push(grid[y * w + x]?.id ?? 0);
    out.push(row);
  }
  return out;
}

function shapeEquals(a: number[][], b: number[][]): boolean {
  if (a.length !== b.length) return false;
  for (let y = 0; y < a.length; y++) {
    if (a[y].length !== b[y].length) return false;
    for (let x = 0; x < a[y].length; x++) if (a[y][x] !== b[y][x]) return false;
  }
  return true;
}

/** Ingredient tags: any plank works wherever oak planks do (tools, sticks,
 *  table, chest ...) and any wooden slab wherever oak slabs do (barrel,
 *  composter). Recipes name the oak id; exact matches (crimson planks ->
 *  crimson slab) still win because the tag pass only runs when they fail. */
const TAG_OF = new Map<number, number>([
  [B.CRIMSON_PLANKS, B.PLANKS], [B.WARPED_PLANKS, B.PLANKS],
  [B.CRIMSON_SLAB, B.OAK_SLAB], [B.WARPED_SLAB, B.OAK_SLAB],
]);

/** Outputs that belong to one wood (oak slab, crimson door ...). Their recipes
 *  need exactly that wood's planks, so the tag pass never applies to them:
 *  crimson planks make crimson stairs, never oak ones. */
const WOOD_SPECIFIC = new Set<number>([
  B.OAK_SLAB, B.OAK_STAIRS, B.OAK_FENCE, B.FENCE_GATE, I.WOOD_DOOR, B.TRAPDOOR,
  B.CRIMSON_SLAB, B.CRIMSON_STAIRS, B.CRIMSON_FENCE, B.CRIMSON_FENCE_GATE, I.CRIMSON_DOOR, B.CRIMSON_TRAPDOOR,
  B.WARPED_SLAB, B.WARPED_STAIRS, B.WARPED_FENCE, B.WARPED_FENCE_GATE, I.WARPED_DOOR, B.WARPED_TRAPDOOR,
]);

/** Is this recipe output a particular wood's own block (no plank substitution)? */
export function isWoodSpecific(out: number): boolean {
  return WOOD_SPECIFIC.has(out);
}

/** Every id a recipe ingredient accepts (itself first), for the recipe book.
 *  Pass the recipe's output: wood-specific recipes accept only their own wood. */
export function ingredientOptions(id: number, out?: number): number[] {
  const opts = [id];
  if (out !== undefined && WOOD_SPECIFIC.has(out)) return opts;
  for (const [alt, base] of TAG_OF) if (base === id) opts.push(alt);
  return opts;
}

function findRecipe(shape: number[][], tagged = false): Recipe | null {
  for (const r of RECIPES) {
    // the portal recipe exists only as a recipe-book hint; the real way to make
    // one is to ignite an obsidian frame with flint & steel (see Player).
    if (r.out === B.PORTAL) continue;
    if (tagged && WOOD_SPECIFIC.has(r.out)) continue;
    if (shapeEquals(shape, r.shape) || shapeEquals(shape, mirror(r.shape))) return r;
  }
  return null;
}

export function matchRecipe(grid: Slot[], w: number): { id: number; count: number } | null {
  const cropped = cropGrid(grid, w);
  if (!cropped) return null;
  let r = findRecipe(cropped);
  if (!r && cropped.some((row) => row.some((id) => TAG_OF.has(id)))) {
    r = findRecipe(cropped.map((row) => row.map((id) => TAG_OF.get(id) ?? id)), true);
  }
  return r ? { id: r.out, count: r.n } : null;
}

// ---------------------------------------------------------------------------
// Smelting
// ---------------------------------------------------------------------------

const SMELT = new Map<number, number>([
  [B.SAND, B.GLASS],
  [B.COBBLE, B.STONE],
  [B.LOG, I.COAL],
  [B.BIRCH_LOG, I.COAL],
  [B.SPRUCE_LOG, I.COAL],
  [B.JUNGLE_LOG, I.COAL],
  // ores smelt straight to their gem (a silk-touch-free shortcut, as in vanilla)
  [B.COAL_ORE, I.COAL],
  [B.DIAMOND_ORE, I.DIAMOND],
  [B.AMETHYST_ORE, I.AMETHYST],
  [B.QUARTZ_ORE, I.QUARTZ],
  [B.IRON_ORE, I.IRON_INGOT],
  [B.GOLD_ORE, I.GOLD_INGOT],
  [B.NETHER_GOLD_ORE, I.GOLD_INGOT],
  [I.PORKCHOP, I.COOKED_PORKCHOP],
  [I.CHICKEN, I.COOKED_CHICKEN],
  [I.MUTTON, I.COOKED_MUTTON],
  [I.BEEF, I.COOKED_BEEF],
  [I.RAW_FISH, I.COOKED_FISH],
  [I.POTATO, I.BAKED_POTATO],
  [B.NETHERRACK, I.NETHER_BRICK],
  [B.STONE, B.SMOOTH_STONE],
  [I.CLAY_BALL, I.BRICK],
  [B.CLAY, B.TERRACOTTA],
  [B.STONE_BRICKS, B.CRACKED_STONE_BRICKS],
  [B.CACTUS, I.LIME_DYE],
  // ancient debris (a Nether-biome block, when present) melts down to scrap
  ...(registryId('ancient_debris') ? [[registryId('ancient_debris'), I.NETHERITE_SCRAP] as [number, number]] : []),
]);

export function smeltResult(id: number): number | undefined { return SMELT.get(id); }

export function fuelSeconds(id: number): number {
  return hasDef(id) ? (def(id).fuel ?? 0) : 0;
}

/** Shift-click routing into a furnace: smeltables go to the input slot,
 *  pure fuels to the fuel slot (logs smelt first, like vanilla), else null. */
export function furnaceSlotFor(id: number): 'input' | 'fuel' | null {
  if (smeltResult(id) !== undefined) return 'input';
  if (fuelSeconds(id) > 0) return 'fuel';
  return null;
}

export const SMELT_TIME = 10; // seconds per item, per the spec

export class FurnaceState {
  readonly type = 'furnace';
  input: Slot = null;
  fuel: Slot = null;
  output: Slot = null;
  burn = 0;       // seconds of fuel remaining
  burnTotal = 0;  // total seconds of the current fuel item (for the flame bar)
  cook = 0;       // seconds into the current smelt

  get burning(): boolean { return this.burn > 0; }

  /** Advance by dt seconds. Returns true if the lit-state may have changed. */
  tick(dt: number): boolean {
    const wasLit = this.burning;
    const canSmelt = this.canSmelt();

    if (this.burn > 0) this.burn = Math.max(0, this.burn - dt);

    if (this.burn <= 0 && canSmelt && this.fuel) {
      const f = fuelSeconds(this.fuel.id);
      if (f > 0) {
        this.burn = f;
        this.burnTotal = f;
        // a lava bucket burns its lava and hands back the empty bucket
        if (this.fuel.id === I.LAVA_BUCKET) this.fuel = { id: I.BUCKET, count: 1 };
        else {
          this.fuel.count--;
          if (this.fuel.count <= 0) this.fuel = null;
        }
      }
    }

    if (this.burn > 0 && canSmelt) {
      this.cook += dt;
      if (this.cook >= SMELT_TIME) {
        this.cook = 0;
        const out = smeltResult(this.input!.id)!;
        if (!this.output) this.output = { id: out, count: 1 };
        else this.output.count++;
        this.input!.count--;
        if (this.input!.count <= 0) this.input = null;
      }
    } else {
      this.cook = Math.max(0, this.cook - dt * 2);
    }
    return wasLit !== this.burning;
  }

  private canSmelt(): boolean {
    if (!this.input) return false;
    const out = smeltResult(this.input.id);
    if (out === undefined) return false;
    if (this.output && (this.output.id !== out || this.output.count >= def(out).stack)) return false;
    return true;
  }

  isEmpty(): boolean { return !this.input && !this.fuel && !this.output && this.burn <= 0; }

  serialize(): FurnaceSave {
    return {
      type: 'furnace',
      input: this.input ? { ...this.input } : null,
      fuel: this.fuel ? { ...this.fuel } : null,
      output: this.output ? { ...this.output } : null,
      burn: this.burn, burnTotal: this.burnTotal, cook: this.cook,
    };
  }

  static from(s: FurnaceSave): FurnaceState {
    const f = new FurnaceState();
    f.input = s.input ? { ...s.input } : null;
    f.fuel = s.fuel ? { ...s.fuel } : null;
    f.output = s.output ? { ...s.output } : null;
    f.burn = s.burn; f.burnTotal = s.burnTotal; f.cook = s.cook;
    return f;
  }
}

// ---------------------------------------------------------------------------
// Chests
// ---------------------------------------------------------------------------

export const CHEST_SIZE = 27;

export class ChestState {
  readonly type = 'chest';
  slots: Slot[] = new Array(CHEST_SIZE).fill(null);

  isEmpty(): boolean { return this.slots.every((s) => !s); }

  serialize(): ChestSave {
    return { type: 'chest', slots: this.slots.map((s) => (s ? { ...s } : null)) };
  }

  static from(s: ChestSave): ChestState {
    const c = new ChestState();
    for (let i = 0; i < Math.min(CHEST_SIZE, s.slots.length); i++) {
      const v = s.slots[i];
      if (v && hasDef(v.id) && v.count > 0) c.slots[i] = { ...v };
    }
    return c;
  }
}

export type BlockEntity = FurnaceState | ChestState;
