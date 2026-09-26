// Redstone engine: power sources, dust networks, torches, repeaters and the
// blocks they drive (lamps, pistons, doors, trapdoors, note blocks, TNT).
//
// Vanilla-like rules:
// - Sources: lever, stone button (20 ticks), wooden button (30 ticks), oak
//   pressure plate (anything: players, mobs, items, arrows), stone pressure
//   plate (players and mobs), redstone torch, block of redstone, repeater.
// - Levers/buttons strongly power the block they hang on, plates the block
//   under them, a torch the block above it, a repeater the block it faces.
//   Dust weakly powers the block under it and the blocks it points into.
// - Strongly powered blocks feed dust and components; weakly powered blocks
//   feed only components. Dust loses one level per block (15 -> 0).
// - A torch turns off when the block it hangs on is powered (1 redstone tick
//   later; it burns out if flipped 8 times within 3 s). A repeater copies its
//   back input to its front after 1-4 redstone ticks and always outputs 15.
//
// Updates are local: a change re-solves only the dust network(s) within two
// blocks of it and re-evaluates the components near what changed, instead of
// the old whole-world recompute. Torch/repeater delays run on a 20 Hz tick queue.

import {
  B, def, hasDef, H4, conducts, dustShape, dustPowerMask, PLATE_IDS, BUTTON_IDS, REDSTONE_TORCHES,
  DOOR_IDS, DOOR_UPPERS, TRAPDOOR_IDS, REDSTONE_ONLY_DOORS,
} from './Blocks';
import type { World, RedstoneState } from './World';
import type { SfxName } from './Audio';

export type NoteInst = 'harp' | 'bass' | 'basedrum' | 'snare' | 'hat' | 'bell' | 'flute' | 'chime' | 'guitar'
  | 'xylophone' | 'iron_xylophone' | 'cow_bell' | 'didgeridoo' | 'bit' | 'banjo' | 'pling';

export interface RedstoneHooks {
  extendPiston(x: number, y: number, z: number): void;
  retractPiston(x: number, y: number, z: number): void;
  isPistonExtended(x: number, y: number, z: number): boolean;
  /** unit step from a piston to its face */
  pistonFront(x: number, y: number, z: number): [number, number, number];
  igniteTnt(x: number, y: number, z: number): void;
  /** is something standing on the plate? (stone plates: players/mobs only) */
  plateOccupied(x: number, y: number, z: number, mobsOnly: boolean): boolean;
  sound(name: SfxName, x: number, y: number, z: number): void;
  note(x: number, y: number, z: number, inst: NoteInst, pitch: number): void;
  smoke(x: number, y: number, z: number): void;
}

const D6: readonly [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
/** lever/button facing (0..5, from the clicked face) -> the block it hangs on */
const ATTACH: readonly [number, number, number][] = [[0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0]];
/** wall torch facing (torchFacings 0..3) -> its wall */
const TORCH_WALL: readonly [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
/** cells within two steps (Manhattan): what a change can reach in one hop */
const NEAR2: [number, number, number][] = [];
for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
  if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) <= 2) NEAR2.push([dx, dy, dz]);
}
const COMPONENTS = new Set<number>([
  B.REDSTONE_LAMP, B.REDSTONE_LAMP_LIT, B.PISTON, B.STICKY_PISTON, B.NOTE_BLOCK, B.TNT,
  B.REDSTONE_TORCH, B.REDSTONE_TORCH_OFF, B.REPEATER, ...DOOR_IDS, ...TRAPDOOR_IDS,
]);
/** oak plate linger after the last thing steps off (vanilla ~1 s) */
const PLATE_RELEASE = 20;
const BURNOUT_WINDOW = 60, BURNOUT_FLIPS = 8, BURNOUT_TICKS = 160;

const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;
const unkey = (k: string): [number, number, number] => {
  const a = k.indexOf(','), b = k.indexOf(',', a + 1);
  return [+k.slice(0, a), +k.slice(a + 1, b), +k.slice(b + 1)];
};

/** How long a button stays pressed, in 20 Hz ticks. */
export function buttonTicks(id: number): number { return id === B.WOODEN_BUTTON ? 30 : 20; }

/** Vanilla note-block instrument from the block beneath it. */
export function noteInstrument(id: number): NoteInst {
  if (id === B.AIR || !hasDef(id)) return 'harp';
  const d = def(id), n = d.name;
  if (id === B.GOLD_BLOCK) return 'bell';
  if (id === B.IRON_BLOCK) return 'iron_xylophone';
  if (id === B.SOUL_SAND) return 'cow_bell';
  if (id === B.PUMPKIN || id === B.JACK_O_LANTERN) return 'didgeridoo';
  if (id === B.GLOWSTONE) return 'pling';
  if (id === B.CLAY) return 'flute';
  if (id === B.HAY_BALE) return 'banjo';
  if (n === 'emerald_block') return 'bit';
  if (n === 'bone_block') return 'xylophone';
  if (n.includes('ice')) return 'chime';
  if (n.includes('wool')) return 'guitar';
  if (n.includes('sand') || n.includes('gravel') || n.includes('concrete_powder')) return 'snare';
  if (n.includes('glass') || n === 'sea_lantern') return 'hat';
  if (d.sound === 'wood') return 'bass';
  if (d.sound === 'stone' || n.includes('netherrack') || n.includes('nylium')) return 'basedrum';
  return 'harp';
}

export class Redstone {
  private tickNo = 0;
  /** scheduled torch/repeater updates: key -> due tick */
  private sched = new Map<string, number>();
  private dirty = new Set<string>();
  private flushing = false;
  /** redstone torch flip ticks (burnout) and burnt-out-until tick */
  private flips = new Map<string, number[]>();
  private burnt = new Map<string, number>();

  constructor(private world: World, private hooks: RedstoneHooks) {}

  /** Forget pending delays (dimension switch / reload). */
  reset(): void { this.sched.clear(); this.dirty.clear(); this.flips.clear(); this.burnt.clear(); }

  // --- entry points -----------------------------------------------------------

  /** Something redstone-relevant changed at (x, y, z): re-solve around it now. */
  update(x: number, y: number, z: number): void {
    this.dirty.add(key(x, y, z));
    if (!this.flushing) this.flush();
  }

  /** World edit hook: react when the block or a neighbour is part of a circuit
   *  (placing a block can cut or carry power; breaking one can drop parts). */
  blockChanged(x: number, y: number, z: number, oldId: number, newId: number): void {
    const RS = this.world.redstoneBlocks;
    let near = RS.has(key(x, y, z)) || COMPONENTS.has(oldId) || COMPONENTS.has(newId) ||
      oldId === B.REDSTONE_WIRE || oldId === B.REDSTONE_BLOCK || PLATE_IDS.has(oldId) || BUTTON_IDS.has(oldId) || oldId === B.LEVER;
    if (!near) for (const [dx, dy, dz] of D6) if (RS.has(key(x + dx, y + dy, z + dz))) { near = true; break; }
    if (near) this.update(x, y, z);
  }

  /** Right-click on a part the engine owns. Returns true when it was used. */
  use(x: number, y: number, z: number, id: number): boolean {
    const k = key(x, y, z);
    if (id === B.REPEATER) {
      const st = this.state(k);
      st.delay = ((st.delay ?? 1) % 4) + 1;
      this.world.redstoneStates.set(k, st);
      this.world.markDirty(Math.floor(x / 16), Math.floor(z / 16));
      this.hooks.sound('click', x, y, z);
      return true;
    }
    if (id === B.NOTE_BLOCK) {
      const st = this.state(k);
      st.pitch = ((st.pitch ?? 0) + 1) % 25;
      this.world.redstoneStates.set(k, st);
      this.playNote(x, y, z);
      return true;
    }
    return false;
  }

  /** Sound a note block (a punch, a right-click tune or a rising signal). */
  playNote(x: number, y: number, z: number): void {
    if (this.world.getBlock(x, y, z) !== B.NOTE_BLOCK) return;
    if (this.world.getBlock(x, y + 1, z) !== B.AIR) return; // vanilla: muffled by a block on top
    const pitch = this.world.redstoneStates.get(key(x, y, z))?.pitch ?? 0;
    this.hooks.note(x, y, z, noteInstrument(this.world.getBlock(x, y - 1, z)), pitch);
  }

  /** 20 Hz: buttons spring back, plates sense, delayed parts fire. */
  tick(): void {
    this.tickNo++;
    const w = this.world;
    for (const [k, st] of w.redstoneStates) {
      if (st.ticksLeft === undefined || st.ticksLeft <= 0) continue;
      if (--st.ticksLeft > 0) continue;
      const [x, y, z] = unkey(k);
      if (!BUTTON_IDS.has(w.getBlock(x, y, z))) continue;
      st.active = false;
      this.hooks.sound('click', x, y, z);
      w.markDirty(Math.floor(x / 16), Math.floor(z / 16));
      this.dirty.add(k);
    }
    for (const k of w.plateBlocks) {
      const [x, y, z] = unkey(k);
      const id = w.getBlock(x, y, z);
      if (!PLATE_IDS.has(id)) continue;
      const st = w.redstoneStates.get(k);
      const on = this.hooks.plateOccupied(x, y, z, id === B.STONE_PRESSURE_PLATE);
      if (on) {
        const s = st ?? { active: false };
        s.releaseT = PLATE_RELEASE;
        if (!s.active) {
          s.active = true;
          this.hooks.sound('plateOn', x, y, z);
          w.markDirty(Math.floor(x / 16), Math.floor(z / 16));
          this.dirty.add(k);
        }
        w.redstoneStates.set(k, s);
      } else if (st?.active) {
        st.releaseT = (st.releaseT ?? 0) - 1;
        if (st.releaseT <= 0) {
          st.active = false;
          this.hooks.sound('plateOff', x, y, z);
          w.markDirty(Math.floor(x / 16), Math.floor(z / 16));
          this.dirty.add(k);
        }
      }
    }
    if (this.sched.size) {
      for (const [k, due] of this.sched) {
        if (due > this.tickNo) continue;
        this.sched.delete(k);
        this.fire(k);
      }
    }
    if (this.dirty.size && !this.flushing) this.flush();
  }

  /** Is the door/lamp/piston/... at (x, y, z) receiving power? */
  powered(x: number, y: number, z: number): boolean { return this.input(x, y, z) > 0; }

  // --- power queries --------------------------------------------------------------

  private state(k: string): RedstoneState {
    return this.world.redstoneStates.get(k) ?? { active: false };
  }

  private dust(x: number, y: number, z: number): number {
    return this.world.redstonePower.get(key(x, y, z)) ?? 0;
  }

  private shape(x: number, y: number, z: number): { mask: number; up: number } {
    const w = this.world;
    return dustShape((a, b, c) => w.getBlock(a, b, c), (a, b, c) => w.redstoneStates.get(key(a, b, c))?.facing, x, y, z);
  }

  /** The block a lever/button/torch hangs on, as an offset from it. */
  private attachOf(x: number, y: number, z: number, id: number): [number, number, number] {
    if (REDSTONE_TORCHES.has(id)) {
      const f = this.world.torchFacings.get(key(x, y, z));
      return f === undefined ? [0, -1, 0] : [TORCH_WALL[f][0], 0, TORCH_WALL[f][1]];
    }
    if (PLATE_IDS.has(id) || id === B.REPEATER || id === B.REDSTONE_WIRE) return [0, -1, 0];
    const f = this.world.redstoneStates.get(key(x, y, z))?.facing;
    return ATTACH[f ?? 1] ?? ATTACH[1];
  }

  /** Is a conductor strongly powered (feeds dust as well as components)? */
  private strong(x: number, y: number, z: number): boolean {
    const w = this.world;
    for (const [dx, dy, dz] of D6) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      const id = w.getBlock(nx, ny, nz);
      if (id === B.LEVER || BUTTON_IDS.has(id)) {
        if (!w.redstoneStates.get(key(nx, ny, nz))?.active) continue;
        const a = this.attachOf(nx, ny, nz, id);
        if (a[0] === -dx && a[1] === -dy && a[2] === -dz) return true;
      } else if (PLATE_IDS.has(id)) {
        if (dy === 1 && w.redstoneStates.get(key(nx, ny, nz))?.active) return true;
      } else if (id === B.REDSTONE_TORCH) {
        if (dy === -1) return true; // a torch powers the block above it
      } else if (id === B.REPEATER) {
        const st = w.redstoneStates.get(key(nx, ny, nz));
        if (st?.active && dy === 0) {
          const [fx, fz] = H4[(st.facing ?? 0) & 3];
          if (fx === -dx && fz === -dz) return true;
        }
      }
    }
    return false;
  }

  /** Is a conductor powered at all (strongly, or weakly by dust)? */
  private weak(x: number, y: number, z: number): boolean {
    if (this.strong(x, y, z)) return true;
    if (this.world.getBlock(x, y + 1, z) === B.REDSTONE_WIRE && this.dust(x, y + 1, z) > 0) return true;
    for (let i = 0; i < 4; i++) {
      const nx = x - H4[i][0], nz = z - H4[i][1]; // dust at nx that points +H4[i] into us
      if (this.world.getBlock(nx, y, nz) !== B.REDSTONE_WIRE || this.dust(nx, y, nz) <= 0) continue;
      if (dustPowerMask(this.shape(nx, y, nz).mask) & (1 << i)) return true;
    }
    return false;
  }

  /** Power the block at s sends into its neighbour s + d. Dust targets only
   *  take strong power (weakly powered blocks don't feed dust). */
  private emit(sx: number, sy: number, sz: number, dx: number, dy: number, dz: number, toDust: boolean): number {
    const w = this.world;
    const id = w.getBlock(sx, sy, sz);
    switch (id) {
      case B.AIR: return 0;
      case B.LEVER: case B.WOODEN_BUTTON: case B.STONE_BUTTON: case B.PRESSURE_PLATE: case B.STONE_PRESSURE_PLATE:
        return w.redstoneStates.get(key(sx, sy, sz))?.active ? 15 : 0;
      case B.REDSTONE_TORCH: {
        const a = this.attachOf(sx, sy, sz, id);
        return a[0] === dx && a[1] === dy && a[2] === dz ? 0 : 15;
      }
      case B.REDSTONE_BLOCK: return 15;
      case B.REPEATER: {
        const st = w.redstoneStates.get(key(sx, sy, sz));
        if (!st?.active || dy !== 0) return 0;
        const [fx, fz] = H4[(st.facing ?? 0) & 3];
        return fx === dx && fz === dz ? 15 : 0;
      }
      case B.REDSTONE_WIRE: {
        if (toDust || dy === 1) return 0; // dust-to-dust runs through the network solve
        const p = this.dust(sx, sy, sz);
        if (p <= 0 || dy === -1) return p;
        const i = H4.findIndex(([hx, hz]) => hx === dx && hz === dz);
        return dustPowerMask(this.shape(sx, sy, sz).mask) & (1 << i) ? p : 0;
      }
    }
    if (!conducts(id)) return 0;
    if (this.strong(sx, sy, sz)) return 15;
    return !toDust && this.weak(sx, sy, sz) ? 15 : 0;
  }

  /** Strongest power reaching a component from its six sides. */
  private input(x: number, y: number, z: number, skip?: [number, number, number]): number {
    let best = 0;
    for (const [dx, dy, dz] of D6) {
      if (skip && skip[0] === dx && skip[1] === dy && skip[2] === dz) continue;
      best = Math.max(best, this.emit(x + dx, y + dy, z + dz, -dx, -dy, -dz, false));
      if (best >= 15) break;
    }
    return best;
  }

  /** Is the block a redstone torch hangs on powered (so the torch goes out)? */
  private torchInput(x: number, y: number, z: number, id: number): boolean {
    const [ax, ay, az] = this.attachOf(x, y, z, id);
    const bx = x + ax, by = y + ay, bz = z + az;
    const b = this.world.getBlock(bx, by, bz);
    if (b === B.REDSTONE_BLOCK) return true;
    return conducts(b) && this.weak(bx, by, bz);
  }

  /** Signal at a repeater's back. */
  private repeaterInput(x: number, y: number, z: number, st: RedstoneState): boolean {
    const [fx, fz] = H4[(st.facing ?? 0) & 3];
    return this.emit(x - fx, y, z - fz, fx, 0, fz, false) > 0;
  }

  // --- dust networks -----------------------------------------------------------------

  /** Dust cells joined to (x, y, z): same level, or up/down a block step. */
  private links(x: number, y: number, z: number): [number, number, number][] {
    const w = this.world, out: [number, number, number][] = [];
    const capped = conducts(w.getBlock(x, y + 1, z));
    for (const [hx, hz] of H4) {
      const nx = x + hx, nz = z + hz;
      const n = w.getBlock(nx, y, nz);
      if (n === B.REDSTONE_WIRE) out.push([nx, y, nz]);
      else if (conducts(n)) { if (!capped && w.getBlock(nx, y + 1, nz) === B.REDSTONE_WIRE) out.push([nx, y + 1, nz]); }
      else if (w.getBlock(nx, y - 1, nz) === B.REDSTONE_WIRE) out.push([nx, y - 1, nz]);
    }
    return out;
  }

  /** Re-solve the networks holding these dust cells; returns cells whose level changed. */
  private solve(seeds: Iterable<string>): string[] {
    const w = this.world;
    const net = new Map<string, [number, number, number][]>();
    const stack: string[] = [];
    for (const s of seeds) if (!net.has(s)) { net.set(s, []); stack.push(s); }
    while (stack.length && net.size < 50000) {
      const k = stack.pop()!;
      const [x, y, z] = unkey(k);
      const ls = this.links(x, y, z);
      net.set(k, ls);
      for (const [a, b, c] of ls) {
        const nk = key(a, b, c);
        if (!net.has(nk)) { net.set(nk, []); stack.push(nk); }
      }
    }
    // each cell's feed from outside the dust (sources, strong blocks, repeaters)
    const level = new Map<string, number>();
    const buckets: string[][] = Array.from({ length: 16 }, () => []);
    for (const k of net.keys()) {
      const [x, y, z] = unkey(k);
      let feed = 0;
      for (const [dx, dy, dz] of D6) {
        if (w.getBlock(x + dx, y + dy, z + dz) === B.REDSTONE_WIRE) continue;
        feed = Math.max(feed, this.emit(x + dx, y + dy, z + dz, -dx, -dy, -dz, true));
        if (feed >= 15) break;
      }
      level.set(k, feed);
      if (feed > 0) buckets[feed].push(k);
    }
    for (let l = 15; l > 1; l--) {
      for (const k of buckets[l]) {
        if (level.get(k) !== l) continue;
        for (const [a, b, c] of net.get(k)!) {
          const nk = key(a, b, c);
          if ((level.get(nk) ?? 0) < l - 1) { level.set(nk, l - 1); buckets[l - 1].push(nk); }
        }
      }
    }
    const changed: string[] = [];
    for (const [k, l] of level) {
      if ((w.redstonePower.get(k) ?? 0) === l) continue;
      if (l > 0) w.redstonePower.set(k, l); else w.redstonePower.delete(k);
      changed.push(k);
    }
    return changed;
  }

  // --- update loop -------------------------------------------------------------------

  private flush(): void {
    this.flushing = true;
    const w = this.world;
    try {
      for (let round = 0; this.dirty.size && round < 64; round++) {
        const batch = [...this.dirty];
        this.dirty.clear();
        const seeds = new Set<string>(), parts = new Set<string>();
        const around = (k: string, collectDust: boolean): void => {
          const [x, y, z] = unkey(k);
          for (const [dx, dy, dz] of NEAR2) {
            const id = w.getBlock(x + dx, y + dy, z + dz);
            if (id === B.REDSTONE_WIRE) { if (collectDust) seeds.add(key(x + dx, y + dy, z + dz)); }
            else if (COMPONENTS.has(id)) parts.add(key(x + dx, y + dy, z + dz));
          }
        };
        for (const k of batch) around(k, true);
        for (const k of this.solve(seeds)) {
          const [x, , z] = unkey(k);
          w.markDirty(Math.floor(x / 16), Math.floor(z / 16));
          around(k, false);
        }
        for (const k of parts) this.evaluate(k);
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Bring one component in line with its input (torches/repeaters schedule). */
  private evaluate(k: string): void {
    const w = this.world;
    const [x, y, z] = unkey(k);
    const id = w.getBlock(x, y, z);
    switch (id) {
      case B.REDSTONE_LAMP: case B.REDSTONE_LAMP_LIT: {
        const want = this.input(x, y, z) > 0 ? B.REDSTONE_LAMP_LIT : B.REDSTONE_LAMP;
        if (want !== id) w.setBlock(x, y, z, want);
        return;
      }
      case B.PISTON: case B.STICKY_PISTON: {
        const front = this.hooks.pistonFront(x, y, z);
        const on = this.input(x, y, z, front) > 0;
        const out = this.hooks.isPistonExtended(x, y, z);
        if (on && !out) this.hooks.extendPiston(x, y, z);
        else if (!on && out) this.hooks.retractPiston(x, y, z);
        return;
      }
      case B.NOTE_BLOCK: {
        const st = this.state(k);
        const on = this.input(x, y, z) > 0;
        if (on === !!st.active) return;
        st.active = on;
        w.redstoneStates.set(k, st);
        if (on) this.playNote(x, y, z);
        return;
      }
      case B.TNT:
        if (this.input(x, y, z) > 0) this.hooks.igniteTnt(x, y, z);
        return;
      case B.REDSTONE_TORCH: case B.REDSTONE_TORCH_OFF: {
        const want = !this.torchInput(x, y, z, id);
        if (want !== (id === B.REDSTONE_TORCH)) this.schedule(k, 2);
        return;
      }
      case B.REPEATER: {
        const st = this.state(k);
        if (this.repeaterInput(x, y, z, st) !== !!st.active) this.schedule(k, (st.delay ?? 1) * 2);
        return;
      }
    }
    if (DOOR_IDS.has(id) || TRAPDOOR_IDS.has(id)) {
      const ly = DOOR_UPPERS.has(id) ? y - 1 : y;
      const on = TRAPDOOR_IDS.has(id) ? this.input(x, y, z) > 0 : this.input(x, ly, z) > 0 || this.input(x, ly + 1, z) > 0;
      const moved = w.applyDoorPower(x, y, z, on);
      if (!moved) return;
      const iron = REDSTONE_ONLY_DOORS.has(id);
      this.hooks.sound(moved === 'open' ? (iron ? 'ironDoorOpen' : 'doorOpen') : (iron ? 'ironDoorClose' : 'doorClose'), x, y, z);
    }
  }

  private schedule(k: string, ticks: number): void {
    if (!this.sched.has(k)) this.sched.set(k, this.tickNo + ticks);
  }

  /** A delayed torch/repeater update comes due. */
  private fire(k: string): void {
    const w = this.world;
    const [x, y, z] = unkey(k);
    const id = w.getBlock(x, y, z);
    if (REDSTONE_TORCHES.has(id)) {
      const want = !this.torchInput(x, y, z, id);
      const lit = id === B.REDSTONE_TORCH;
      if (want === lit) return;
      if (want) {
        const until = this.burnt.get(k) ?? 0;
        if (this.tickNo < until) { this.schedule(k, until - this.tickNo); return; }
      }
      // burnout: a torch flipped too fast (a 1-tick clock) goes dark for a while
      const recent = (this.flips.get(k) ?? []).filter((t) => this.tickNo - t < BURNOUT_WINDOW);
      recent.push(this.tickNo);
      this.flips.set(k, recent);
      if (recent.length >= BURNOUT_FLIPS) {
        this.flips.delete(k);
        this.burnt.set(k, this.tickNo + BURNOUT_TICKS);
        this.hooks.smoke(x, y, z);
        this.hooks.sound('fizz', x, y, z);
        if (lit) { w.setBlock(x, y, z, B.REDSTONE_TORCH_OFF); this.dirty.add(k); }
        this.schedule(k, BURNOUT_TICKS);
        return;
      }
      w.setBlock(x, y, z, want ? B.REDSTONE_TORCH : B.REDSTONE_TORCH_OFF);
      this.dirty.add(k);
      return;
    }
    if (id === B.REPEATER) {
      const st = this.state(k);
      const on = this.repeaterInput(x, y, z, st);
      if (on === !!st.active) return;
      st.active = on;
      w.redstoneStates.set(k, st);
      w.markDirty(Math.floor(x / 16), Math.floor(z / 16));
      const [fx, fz] = H4[(st.facing ?? 0) & 3];
      this.dirty.add(k);
      this.dirty.add(key(x + fx, y, z + fz));
    }
  }

  /** Can this part stay where it is? (levers/buttons need the block they hang
   *  on, plates/dust/repeaters/torches their floor or wall). null = not a part. */
  supported(x: number, y: number, z: number, id: number): boolean | null {
    if (!(id === B.LEVER || BUTTON_IDS.has(id) || PLATE_IDS.has(id) || REDSTONE_TORCHES.has(id) ||
      id === B.REPEATER || id === B.REDSTONE_WIRE)) return null;
    const [ax, ay, az] = this.attachOf(x, y, z, id);
    const b = this.world.getBlock(x + ax, y + ay, z + az);
    return b !== B.AIR && hasDef(b) && def(b).solid;
  }
}
