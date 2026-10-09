// Fire: flames lit by flint & steel or lightning. Each fire burns for a few
// seconds (forever on netherrack/magma/soul blocks), creeps into neighbouring flammable
// blocks, consumes them, and is doused by rain. Ticked a few times a second
// from the main logic loop; live fires persist with the save.

import { B, FLAMMABLE, isSolid } from './Blocks';
import type { World } from './World';

/** hard cap so a forest fire can't bog the tick down */
const MAX_FIRES = 320;
const NEIGHBOURS: [number, number, number][] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

export interface FireHooks {
  /** In multiplayer, exactly one client advances each loaded fire cell. */
  canAdvance?: (x: number, z: number) => boolean;
  /** is it raining on this column (open sky)? */
  rainingAt: (x: number, y: number, z: number) => boolean;
  /** flames reached a TNT block */
  igniteTnt: (x: number, y: number, z: number) => void;
  /** Consume a flammable block, including any block-entity cleanup. */
  burnBlock: (x: number, y: number, z: number, id: number) => void;
}

export class FireSystem {
  /** "dim|x,y,z" -> seconds of burn left */
  private fires = new Map<string, number>();

  constructor(private world: World, private hooks: FireHooks) {}

  get count(): number { return this.fires.size; }

  /** Forget a flame removed by a remote cell update or another block action. */
  forget(x: number, y: number, z: number): void {
    this.fires.delete(this.key(x, y, z));
  }

  private key(x: number, y: number, z: number): string {
    return `${this.world.dimension}|${x},${y},${z}`;
  }

  /** Every client derives the same initial lifetime for a fire cell. This keeps
   *  a later simulation-authority handoff from restarting it with a new roll. */
  private initialLife(x: number, y: number, z: number): number {
    let h = (this.world.seed | 0) ^ Math.imul(x, 0x45d9f3b) ^ Math.imul(y, 0x119de1f3) ^ Math.imul(z, 0x27d4eb2d);
    if (this.world.dimension === 'nether') h ^= 0x6d2b79f5;
    h ^= h >>> 16;
    h = Math.imul(h, 0x7feb352d);
    h ^= h >>> 15;
    return 3 + ((h >>> 0) / 0x100000000) * 5;
  }

  private flammableNear(x: number, y: number, z: number): boolean {
    for (const [dx, dy, dz] of NEIGHBOURS) {
      if (FLAMMABLE.has(this.world.getBlock(x + dx, y + dy, z + dz))) return true;
    }
    return false;
  }

  /** A flame needs a solid floor or something flammable to cling to. */
  canBurnAt(x: number, y: number, z: number): boolean {
    return isSolid(this.world.getBlock(x, y - 1, z)) || this.flammableNear(x, y, z);
  }

  /** Light a fire in an air cell; false if it can't burn there. */
  ignite(x: number, y: number, z: number): boolean {
    const current = this.world.getBlock(x, y, z);
    // A remote authoritative cell may install FIRE before asking us to track
    // it. Register that existing block without rewriting it or echoing a cell.
    if (current === B.FIRE) {
      const k = this.key(x, y, z);
      if (!this.fires.has(k) && this.fires.size < MAX_FIRES) this.fires.set(k, this.initialLife(x, y, z));
      return true;
    }
    if (current !== B.AIR || !this.canBurnAt(x, y, z)) return false;
    if (this.fires.size >= MAX_FIRES) return false;
    if (!this.world.setBlock(x, y, z, B.FIRE)) return false;
    this.fires.set(this.key(x, y, z), this.initialLife(x, y, z));
    return true;
  }

  /** Vanilla LavaFluid.randomTick: lava sets the air above it alight when
   *  something flammable is beside that air — up to 3 cells up a random
   *  walk — or, failing that, the top of a flammable block next to it. */
  lavaTick(x: number, y: number, z: number): void {
    const w = this.world;
    const r3 = (): number => ((Math.random() * 3) | 0) - 1;
    const n = (Math.random() * 3) | 0;
    if (n > 0) {
      let px = x, py = y, pz = z;
      for (let i = 0; i < n; i++) {
        px += r3(); py += 1; pz += r3();
        if (!this.loaded(px, pz)) return;
        const id = w.getBlock(px, py, pz);
        if (id === B.AIR) {
          if (this.flammableNear(px, py, pz)) { this.ignite(px, py, pz); return; }
        } else if (isSolid(id)) return;
      }
    } else {
      for (let i = 0; i < 3; i++) {
        const px = x + r3(), pz = z + r3();
        if (!this.loaded(px, pz)) return;
        if (w.getBlock(px, y + 1, pz) === B.AIR && FLAMMABLE.has(w.getBlock(px, y, pz))) this.ignite(px, y + 1, pz);
      }
    }
  }

  /** Is this flame fed forever (netherrack / magma underneath)? */
  private eternal(x: number, y: number, z: number): boolean {
    const below = this.world.getBlock(x, y - 1, z);
    return below === B.NETHERRACK || below === B.MAGMA || below === B.SOUL_SAND || below === B.SOUL_SOIL;
  }

  private loaded(x: number, z: number): boolean {
    const c = this.world.getChunk(Math.floor(x / 16), Math.floor(z / 16));
    return !!c && c.ready;
  }

  private extinguish(k: string, x: number, y: number, z: number): void {
    this.fires.delete(k);
    if (this.world.getBlock(x, y, z) === B.FIRE) this.world.setBlock(x, y, z, B.AIR);
  }

  /** Advance every fire in the current dimension by dt seconds. */
  tick(dt: number): void {
    const dim = this.world.dimension;
    const w = this.world;
    for (const [k, left] of [...this.fires]) {
      const bar = k.indexOf('|');
      if (k.slice(0, bar) !== dim) continue;
      const [x, y, z] = k.slice(bar + 1).split(',').map(Number);
      if (!this.loaded(x, z)) continue; // frozen until its chunk streams back in
      if (w.getBlock(x, y, z) !== B.FIRE) { this.fires.delete(k); continue; }
      if (this.hooks.canAdvance && !this.hooks.canAdvance(x, z)) {
        // Keep passive clocks near the authority's value without performing
        // random spread, block destruction, or world writes. Clamp at zero so
        // the tracker survives until an authoritative AIR update arrives.
        if (!this.eternal(x, y, z)) {
          const next = left - (this.flammableNear(x, y, z) ? dt * 0.35 : dt);
          this.fires.set(k, Math.max(0.001, next));
        }
        continue;
      }
      if (!this.canBurnAt(x, y, z)) { this.extinguish(k, x, y, z); continue; }
      if (this.hooks.rainingAt(x, y, z) && Math.random() < 0.35) { this.extinguish(k, x, y, z); continue; }
      const eternal = this.eternal(x, y, z);

      // consume adjacent fuel: the burnt block becomes flame (or TNT goes off)
      for (const [dx, dy, dz] of NEIGHBOURS) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        const id = w.getBlock(nx, ny, nz);
        const f = FLAMMABLE.get(id);
        if (!f || Math.random() >= (f.burn / 100) * dt) continue;
        if (id === B.TNT) {
          w.setBlock(nx, ny, nz, B.AIR);
          this.hooks.igniteTnt(nx, ny, nz);
          continue;
        }
        this.hooks.burnBlock(nx, ny, nz, id);
        if (Math.random() < 0.6) this.ignite(nx, ny, nz);
      }

      // creep: flames leap into a nearby air cell that touches fuel
      if (this.fires.size < MAX_FIRES) {
        const sx = x + ((Math.random() * 3) | 0) - 1;
        const sy = y + ((Math.random() * 4) | 0) - 1; // fire climbs more than it sinks
        const sz = z + ((Math.random() * 3) | 0) - 1;
        if (w.getBlock(sx, sy, sz) === B.AIR) {
          let best = 0;
          for (const [dx, dy, dz] of NEIGHBOURS) {
            best = Math.max(best, FLAMMABLE.get(w.getBlock(sx + dx, sy + dy, sz + dz))?.catch ?? 0);
          }
          if (best > 0 && Math.random() < (best / 100) * 6 * dt) this.ignite(sx, sy, sz);
        }
      }

      if (eternal) continue;
      // a flame lingers (burns down ~3x slower) while there's fuel beside it
      const next = left - (this.flammableNear(x, y, z) ? dt * 0.35 : dt);
      if (next <= 0) this.extinguish(k, x, y, z);
      else this.fires.set(k, next);
    }
  }

  serialize(): { k: string; t: number }[] {
    return [...this.fires].map(([k, t]) => ({ k, t }));
  }

  load(list: { k: string; t: number }[] | undefined): void {
    this.fires.clear();
    for (const f of list ?? []) {
      if (typeof f.k === 'string' && /^(overworld|nether)\|-?\d+,-?\d+,-?\d+$/.test(f.k)) {
        this.fires.set(f.k, Math.max(0.5, +f.t || 3));
      }
    }
  }
}
