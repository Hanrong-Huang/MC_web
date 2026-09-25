// Campfire cooking: up to four raw foods sit on a campfire and pop off cooked
// after 30 seconds (vanilla), trailing smoke while they sizzle.

import { B, I } from './Blocks';
import { smeltResult } from './Inventory';
import type { World } from './World';

const COOK_TIME = 30;

/** Raw foods a campfire accepts (anything the furnace turns into food). */
export function campfireCooks(id: number): number | undefined {
  const out = smeltResult(id);
  return out !== undefined && [I.COOKED_PORKCHOP, I.COOKED_CHICKEN, I.COOKED_MUTTON, I.COOKED_BEEF,
    I.COOKED_FISH, I.BAKED_POTATO].includes(out) ? out : undefined;
}

interface Fire { items: number[]; t: number[] }

export class Campfires {
  /** "dimension|x,y,z" -> the four cooking slots (0 = empty) */
  private fires = new Map<string, Fire>();

  /** Put a raw food on the campfire; false when full or not cookable. */
  add(dim: string, x: number, y: number, z: number, itemId: number): boolean {
    if (campfireCooks(itemId) === undefined) return false;
    const k = `${dim}|${x},${y},${z}`;
    let f = this.fires.get(k);
    if (!f) { f = { items: [0, 0, 0, 0], t: [0, 0, 0, 0] }; this.fires.set(k, f); }
    const slot = f.items.indexOf(0);
    if (slot < 0) return false;
    f.items[slot] = itemId;
    f.t[slot] = 0;
    return true;
  }

  /** Advance cooking in the current dimension; finished food goes to `pop`,
   *  and `smoke` is called for fires with something on them. */
  tick(dt: number, dim: string, world: World,
    pop: (x: number, y: number, z: number, id: number) => void,
    smoke: (x: number, y: number, z: number) => void): void {
    for (const [k, f] of this.fires) {
      const [d, pos] = k.split('|');
      if (d !== dim) continue;
      const [x, y, z] = pos.split(',').map(Number);
      if (!world.getChunk(Math.floor(x / 16), Math.floor(z / 16))?.ready) continue; // unloaded: paused
      if (world.getBlock(x, y, z) !== B.CAMPFIRE) {
        // the fire went out from under the food: spill it raw
        for (const id of f.items) if (id) pop(x, y, z, id);
        this.fires.delete(k);
        continue;
      }
      let any = false;
      for (let i = 0; i < 4; i++) {
        if (!f.items[i]) continue;
        any = true;
        f.t[i] += dt;
        if (f.t[i] >= COOK_TIME) {
          pop(x, y, z, campfireCooks(f.items[i]) ?? f.items[i]);
          f.items[i] = 0;
          f.t[i] = 0;
        }
      }
      if (!any) this.fires.delete(k);
      else if (Math.random() < dt * 3) smoke(x, y, z);
    }
  }

  serialize(): { k: string; items: number[]; t: number[] }[] {
    return [...this.fires].map(([k, f]) => ({ k, items: [...f.items], t: [...f.t] }));
  }

  load(list: { k: string; items: number[]; t: number[] }[] | undefined): void {
    this.fires.clear();
    for (const e of list ?? []) {
      if (!e || typeof e.k !== 'string' || !Array.isArray(e.items)) continue;
      this.fires.set(e.k, { items: [0, 1, 2, 3].map((i) => e.items[i] | 0), t: [0, 1, 2, 3].map((i) => +e.t?.[i] || 0) });
    }
  }
}
