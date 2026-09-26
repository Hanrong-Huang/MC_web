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
  /** is it raining on this column (open sky)? */
  rainingAt: (x: number, y: number, z: number) => boolean;
  /** flames reached a TNT block */
  igniteTnt: (x: number, y: number, z: number) => void;
}

export class FireSystem {
  /** "dim|x,y,z" -> seconds of burn left */
  private fires = new Map<string, number>();

  constructor(private world: World, private hooks: FireHooks) {}

  get count(): number { return this.fires.size; }

  private key(x: number, y: number, z: number): string {
    return `${this.world.dimension}|${x},${y},${z}`;
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
    if (this.world.getBlock(x, y, z) !== B.AIR || !this.canBurnAt(x, y, z)) return false;
    if (this.fires.size >= MAX_FIRES) return false;
    if (!this.world.setBlock(x, y, z, B.FIRE)) return false;
    this.fires.set(this.key(x, y, z), 3 + Math.random() * 5);
    return true;
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
        w.setBlock(nx, ny, nz, B.AIR);
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
