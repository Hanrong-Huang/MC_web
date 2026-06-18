// Inventory slots, shaped crafting recipes (2x2 and 3x3), furnace smelting,
// and chest storage.

import { B, I, def, hasDef } from './Blocks';
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
        this.slots[i] = { id: s.id, count: s.count, ...(s.dur !== undefined ? { dur: s.dur } : {}) };
      }
    }
    this.armor = new Array(4).fill(null);
    for (let i = 0; i < 4 && data.armor && i < data.armor.length; i++) {
      const s = data.armor[i];
      if (s && hasDef(s.id) && def(s.id).armor) {
        this.armor[i] = { id: s.id, count: 1, ...(s.dur !== undefined ? { dur: s.dur } : {}) };
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

const RECIPES: Recipe[] = [
  { shape: [[B.LOG]], out: B.PLANKS, n: 4 },
  { shape: [[B.BIRCH_LOG]], out: B.PLANKS, n: 4 },
  { shape: [[B.SPRUCE_LOG]], out: B.PLANKS, n: 4 },
  { shape: [[P], [P]], out: I.STICK, n: 4 },
  { shape: [[P, P], [P, P]], out: B.TABLE, n: 1 },
  { shape: [[C, C, C], [C, 0, C], [C, C, C]], out: B.FURNACE, n: 1 },
  { shape: [[P, P, P], [P, 0, P], [P, P, P]], out: B.CHEST, n: 1 },
  ...toolRecipes(P, I.WOOD_PICK, I.WOOD_AXE, I.WOOD_SHOVEL, I.WOOD_SWORD),
  ...toolRecipes(C, I.STONE_PICK, I.STONE_AXE, I.STONE_SHOVEL, I.STONE_SWORD),
  ...toolRecipes(FE, I.IRON_PICK, I.IRON_AXE, I.IRON_SHOVEL, I.IRON_SWORD),
  ...toolRecipes(DI, I.DIAMOND_PICK, I.DIAMOND_AXE, I.DIAMOND_SHOVEL, I.DIAMOND_SWORD),
  ...armorRecipes(LE, I.LEATHER_HELMET, I.LEATHER_CHEST, I.LEATHER_LEGS, I.LEATHER_BOOTS),
  ...armorRecipes(FE, I.IRON_HELMET, I.IRON_CHEST, I.IRON_LEGS, I.IRON_BOOTS),
  ...armorRecipes(DI, I.DIAMOND_HELMET, I.DIAMOND_CHEST, I.DIAMOND_LEGS, I.DIAMOND_BOOTS),
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
  { shape: [[ST, ST], [ST, ST]], out: B.WOOL, n: 1 },
  // buildable interactivity
  { shape: [[P, P], [P, P], [P, P]], out: I.WOOD_DOOR, n: 3 },
  { shape: [[P, P, P], [P, P, P], [0, 0, 0]], out: I.WOOD_DOOR, n: 3 },
  { shape: [[P, P, P], [0, S, 0], [0, S, 0]], out: B.LADDER, n: 3 },
  { shape: [[P, P, P], [P, 0, P], [P, P, P]], out: B.TRAPDOOR, n: 2 },
  // tools & utilities
  { shape: [[0, 0, S], [0, S, ST], [S, 0, 0]], out: I.FISHING_ROD, n: 1 },
  // compass: 4 iron in a diamond around a central iron (dial)
  { shape: [[0, FE, 0], [FE, FE, FE], [0, FE, 0]], out: I.COMPASS, n: 1 },
  // clock: gold ring with an iron core (redstone stand-in for the dial)
  { shape: [[0, AU, 0], [AU, FE, AU], [0, AU, 0]], out: I.CLOCK, n: 1 },
  // bucket: three iron in a V
  { shape: [[FE, 0, FE], [0, FE, 0]], out: I.BUCKET, n: 1 },
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

export function matchRecipe(grid: Slot[], w: number): { id: number; count: number } | null {
  const cropped = cropGrid(grid, w);
  if (!cropped) return null;
  for (const r of RECIPES) {
    // the portal recipe exists only as a recipe-book hint; the real way to make
    // one is to ignite an obsidian frame with flint & steel (see Player).
    if (r.out === B.PORTAL) continue;
    if (shapeEquals(cropped, r.shape) || shapeEquals(cropped, mirror(r.shape))) {
      return { id: r.out, count: r.n };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Smelting
// ---------------------------------------------------------------------------

const SMELT = new Map<number, number>([
  [B.SAND, B.GLASS],
  [B.COBBLE, B.STONE],
  [B.LOG, I.COAL],
  [B.IRON_ORE, I.IRON_INGOT],
  [B.GOLD_ORE, I.GOLD_INGOT],
  [I.PORKCHOP, I.COOKED_PORKCHOP],
  [I.CHICKEN, I.COOKED_CHICKEN],
  [I.MUTTON, I.COOKED_MUTTON],
  [I.BEEF, I.COOKED_BEEF],
  [I.RAW_FISH, I.COOKED_FISH],
  [I.POTATO, I.BAKED_POTATO],
]);

export function smeltResult(id: number): number | undefined { return SMELT.get(id); }

export function fuelSeconds(id: number): number {
  return hasDef(id) ? (def(id).fuel ?? 0) : 0;
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
        this.fuel.count--;
        if (this.fuel.count <= 0) this.fuel = null;
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
