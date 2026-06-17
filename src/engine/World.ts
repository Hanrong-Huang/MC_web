// World: chunk map + streaming, block get/set with dirty propagation,
// DDA voxel raycasting, skylight lookups, and furnace block-entities.

import { Chunk, chunkKey, CX, CZ, CY } from './Chunk';
import { WorldGenerator } from './WorldGenerator';
import { B, isSolid, def, hasDef } from './Blocks';
import { BlockEntity } from './Inventory';
import { rleDecode, rleEncode } from './Persistence';

/** Cardinal facing for a placed door/trapdoor, in 90-degree steps.
 *  For doors this is the direction the player was looking when placed. */
export type DoorFacing = 0 | 1 | 2 | 3; // 0=-z, 1=-x, 2=+z, 3=+x
/** Persistent state for a door (lower-half keyed). open bit + facing. */
export interface DoorState {
  facing: DoorFacing;
  open: boolean;
  /** hinge on the player's right when the door was placed */
  hingeRight?: boolean;
  /** 0 = fully closed, 1 = fully open (animated swing) */
  swing?: number;
}

export interface RayHit {
  x: number; y: number; z: number;     // block coords
  nx: number; ny: number; nz: number;  // face normal
  id: number;
  dist: number;
}

export class World {
  readonly generator: WorldGenerator;
  readonly seed: number;
  chunks = new Map<string, Chunk>();
  viewDist = 8;
  /** chunk keys needing remesh */
  dirtySet = new Set<string>();
  /** RLE snapshots of edited chunks (from a save file and/or unloaded edits) */
  savedChunks = new Map<string, Uint8Array>();
  /** furnace/chest states keyed by "x,y,z" */
  blockEntities = new Map<string, BlockEntity>();
  /** door states keyed by the lower-half "x,y,z" */
  doorStates = new Map<string, DoorState>();
  /** wall-torch facings keyed by "x,y,z": 0=+x,1=-x,2=+z,3=-z. Floor torches
   *  are absent from this map. */
  torchFacings = new Map<string, number>();
  onChunkRemoved: (key: string) => void = () => {};
  /** fired after every successful setBlock (gravity blocks, torch supports, ...) */
  onBlockChanged: (x: number, y: number, z: number, oldId: number, newId: number) => void = () => {};

  private genQueue: { cx: number; cz: number; d: number }[] = [];
  private queued = new Set<string>();

  constructor(seed: number) {
    this.seed = seed | 0;
    this.generator = new WorldGenerator(this.seed);
  }

  getChunk(cx: number, cz: number): Chunk | undefined {
    return this.chunks.get(chunkKey(cx, cz));
  }

  getBlock(wx: number, wy: number, wz: number): number {
    if (wy < 0) return B.BEDROCK;
    if (wy >= CY) return B.AIR;
    const c = this.chunks.get(chunkKey(Math.floor(wx / CX), Math.floor(wz / CZ)));
    if (!c || !c.ready) return B.AIR;
    return c.data[(wx & 15) | ((wz & 15) << 4) | (wy << 8)];
  }

  /** For meshing at the frontier: unloaded chunks read as opaque to cull walls. */
  getBlockForMesh(wx: number, wy: number, wz: number): number {
    if (wy < 0) return B.BEDROCK;
    if (wy >= CY) return B.AIR;
    const c = this.chunks.get(chunkKey(Math.floor(wx / CX), Math.floor(wz / CZ)));
    if (!c || !c.ready) return B.STONE;
    return c.data[(wx & 15) | ((wz & 15) << 4) | (wy << 8)];
  }

  isSolidAt(wx: number, wy: number, wz: number): boolean {
    return isSolid(this.getBlock(wx, wy, wz));
  }

  skyLight(wx: number, wy: number, wz: number): number {
    if (wy >= CY) return 1;
    const c = this.chunks.get(chunkKey(Math.floor(wx / CX), Math.floor(wz / CZ)));
    if (!c || !c.ready) return 1;
    return c.skyLight(wx & 15, Math.max(0, wy), wz & 15);
  }

  setBlock(wx: number, wy: number, wz: number, id: number): boolean {
    if (wy < 0 || wy >= CY) return false;
    const cx = Math.floor(wx / CX), cz = Math.floor(wz / CZ);
    const c = this.chunks.get(chunkKey(cx, cz));
    if (!c || !c.ready) return false;
    const lx = wx & 15, lz = wz & 15;
    const oldId = c.get(lx, wy, lz);
    c.set(lx, wy, lz, id);
    c.modified = true;

    // torch light spans chunks: remesh the whole 3x3 neighborhood when the
    // edit involves a torch or happens near existing torch light
    if (id === B.TORCH || oldId === B.TORCH || this.torchesNear(cx, cz)) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) this.markDirty(cx + dx, cz + dz);
      }
    } else {
      this.markDirty(cx, cz);
      if (lx === 0) this.markDirty(cx - 1, cz);
      if (lx === 15) this.markDirty(cx + 1, cz);
      if (lz === 0) this.markDirty(cx, cz - 1);
      if (lz === 15) this.markDirty(cx, cz + 1);
    }
    this.onBlockChanged(wx, wy, wz, oldId, id);
    // water flow: re-check this cell + neighbors when the edit exposes air or
    // touches water (breaking a block under/next to water makes it flow in)
    if (id === B.AIR || id === B.WATER || oldId === B.WATER) this.scheduleAround(wx, wy, wz);
    return true;
  }

  private torchesNear(cx: number, cz: number): boolean {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const c = this.chunks.get(chunkKey(cx + dx, cz + dz));
        if (c && c.torches.size > 0) return true;
      }
    }
    return false;
  }

  /** Is any torch within `r` blocks (used to gate cave mob spawns)? */
  anyTorchNear(wx: number, wy: number, wz: number, r: number): boolean {
    const cx = Math.floor(wx / CX), cz = Math.floor(wz / CZ);
    const r2 = r * r;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const c = this.chunks.get(chunkKey(cx + dx, cz + dz));
        if (!c) continue;
        for (const idx of c.torches) {
          const tx = c.cx * CX + (idx & 15);
          const tz = c.cz * CZ + ((idx >> 4) & 15);
          const ty = idx >> 8;
          const d = (tx - wx) ** 2 + (ty - wy) ** 2 + (tz - wz) ** 2;
          if (d <= r2) return true;
        }
      }
    }
    return false;
  }

  // --- door state -----------------------------------------------------------

  /** Get door state for a block that is part of a door (lower or upper half). */
  doorStateAt(x: number, y: number, z: number): DoorState | undefined {
    const here = this.doorStates.get(`${x},${y},${z}`);
    if (here) return here;
    const id = this.getBlock(x, y, z);
    if (id === B.DOOR_UPPER) return this.doorStates.get(`${x},${y - 1},${z}`);
    if (id === B.DOOR_LOWER) return this.doorStates.get(`${x},${y + 1},${z}`);
    return undefined;
  }

  /** Toggle a door's or trapdoor's open state. Returns true if it toggled. */
  toggleDoor(x: number, y: number, z: number): boolean {
    let id = this.getBlock(x, y, z);
    // trapdoor: keyed by its own position
    if (id === B.TRAPDOOR) {
      const key = `${x},${y},${z}`;
      const st = this.doorStates.get(key) ?? { facing: 0 as DoorFacing, open: false };
      st.open = !st.open;
      this.doorStates.set(key, st);
      this.markDirty(Math.floor(x / CX), Math.floor(z / CZ));
      return true;
    }
    // tall door: lower half holds the state
    let ly = y;
    if (id === B.DOOR_UPPER) { ly = y - 1; id = this.getBlock(x, ly, z); }
    if (id !== B.DOOR_LOWER) return false;
    const key = `${x},${ly},${z}`;
    const st = this.doorStates.get(key) ?? { facing: 0 as DoorFacing, open: false, swing: 0 };
    st.open = !st.open;
    if (st.swing === undefined) st.swing = st.open ? 0 : 1;
    this.doorStates.set(key, st);
    this.markDirty(Math.floor(x / CX), Math.floor(z / CZ));
    // double doors swing together
    const partner = this.doorPartner(x, ly, z, st);
    if (partner && partner.st.open !== st.open) {
      partner.st.open = st.open;
      this.doorStates.set(partner.key, partner.st);
      this.markDirty(Math.floor(partner.x / CX), Math.floor(partner.z / CZ));
    }
    return true;
  }

  /** Adjacent door forming a pair: same facing, opposite hinge, along the
   *  door's width axis. Returns its lower-half key/state, or null. */
  doorPartner(lx: number, ly: number, lz: number, st: DoorState): { key: string; x: number; z: number; st: DoorState } | null {
    // width axis is perpendicular to the facing normal
    const along = st.facing % 2 === 0 ? [[1, 0], [-1, 0]] : [[0, 1], [0, -1]];
    for (const [dx, dz] of along) {
      const nx = lx + dx, nz = lz + dz;
      if (this.getBlock(nx, ly, nz) !== B.DOOR_LOWER) continue;
      const ns = this.doorStates.get(`${nx},${ly},${nz}`);
      if (ns && ns.facing === st.facing && !!ns.hingeRight !== !!st.hingeRight) {
        return { key: `${nx},${ly},${nz}`, x: nx, z: nz, st: ns };
      }
    }
    return null;
  }

  /** Animate door swings toward their open/closed target. Returns true if any moved. */
  updateDoorSwings(dt: number): boolean {
    const rate = 7; // ~0.14s for a full 90deg swing (MC-like snappy motion)
    let changed = false;
    for (const [key, st] of this.doorStates) {
      const [wx, wy, wz] = key.split(',').map(Number);
      if (this.getBlock(wx, wy, wz) !== B.DOOR_LOWER) continue;
      const target = st.open ? 1 : 0;
      const cur = st.swing ?? target;
      if (Math.abs(cur - target) < 0.001) {
        if (st.swing !== target) { st.swing = target; changed = true; }
        continue;
      }
      const step = rate * dt;
      const next = cur < target ? Math.min(target, cur + step) : Math.max(target, cur - step);
      st.swing = Math.abs(next - target) < 0.001 ? target : next;
      changed = true;
      this.markDirty(Math.floor(wx / CX), Math.floor(wz / CZ));
    }
    return changed;
  }

  /** Open state for any door/trapdoor block (false when not a door). */
  isTrapdoorOpen(x: number, y: number, z: number): boolean {
    if (this.getBlock(x, y, z) !== B.TRAPDOOR) return false;
    return this.doorStates.get(`${x},${y},${z}`)?.open ?? false;
  }

  /** Is this door block currently closed (i.e. should it block movement)? */
  isDoorClosed(x: number, y: number, z: number): boolean {
    const st = this.doorStateAt(x, y, z);
    if (!st) return false;
    const swing = st.swing ?? (st.open ? 1 : 0);
    return swing < 0.5;
  }

  // --- flowing water ---------------------------------------------------------
  // Levels: 0 = source (or fed from directly above), 1..7 = flowing (7 = thinnest,
  // farthest from a source). Generated ocean water is absent from the map and so
  // reads as a source. Flowing cells we create are tracked here and recede when
  // they lose their connection back to a source.
  waterLevels = new Map<string, number>();
  private waterQueue: string[] = [];
  private waterQueued = new Set<string>();
  private static readonly MAX_WATER_LEVEL = 7;

  /** Queue a cell for a water-flow re-evaluation on the next water tick. */
  scheduleWater(x: number, y: number, z: number): void {
    if (y < 0 || y >= CY) return;
    const key = `${x},${y},${z}`;
    if (this.waterQueued.has(key)) return;
    this.waterQueued.add(key);
    this.waterQueue.push(key);
  }

  private scheduleAround(x: number, y: number, z: number): void {
    this.scheduleWater(x, y, z);
    this.scheduleWater(x, y - 1, z); this.scheduleWater(x, y + 1, z);
    this.scheduleWater(x + 1, y, z); this.scheduleWater(x - 1, y, z);
    this.scheduleWater(x, y, z + 1); this.scheduleWater(x, y, z - 1);
  }

  /** Water level at a cell (0 = source/fed-from-above). Assumes water present. */
  waterLevel(x: number, y: number, z: number): number {
    if (this.getBlock(x, y + 1, z) === B.WATER) return 0; // fed from the column above
    return this.waterLevels.get(`${x},${y},${z}`) ?? 0; // absent = generated/placed source
  }

  /** Advance queued water cells with a per-tick op budget (rest carries over). */
  tickWater(maxOps = 800): void {
    let ops = 0;
    while (this.waterQueue.length && ops < maxOps) {
      const key = this.waterQueue.shift()!;
      this.waterQueued.delete(key);
      const c = key.split(',');
      this.updateWaterCell(+c[0], +c[1], +c[2]);
      ops++;
    }
  }

  /**
   * Re-derive one cell's water level purely from its neighbours (a "pull"
   * automaton): a permanent source or a cell fed from above stays at 0; any
   * other cell takes (best feeding neighbour + 1), or empties if nothing feeds
   * it. This converges cleanly for both spreading and receding.
   */
  private updateWaterCell(x: number, y: number, z: number): void {
    const key = `${x},${y},${z}`;
    const id = this.getBlock(x, y, z);
    const isWater = id === B.WATER;
    const permanent = isWater && !this.waterLevels.has(key); // generated ocean / bucket source

    let target: number;
    if (permanent || this.getBlock(x, y + 1, z) === B.WATER) {
      target = 0;
    } else {
      target = 8; // 8 = "no water here"
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, nz = z + dz;
        if (this.getBlock(nx, y, nz) !== B.WATER) continue;
        // a neighbour draining straight down (and not a source) can't feed sideways
        if (this.getBlock(nx, y - 1, nz) === B.AIR && this.waterLevels.has(`${nx},${y},${nz}`)) continue;
        target = Math.min(target, this.waterLevel(nx, y, nz) + 1);
      }
    }

    if (!permanent) {
      if (target > World.MAX_WATER_LEVEL) {
        if (isWater && this.setBlock(x, y, z, B.AIR)) {
          this.waterLevels.delete(key);
          this.scheduleAround(x, y, z);
        }
        return;
      }
      if (!isWater) {
        if (!this.setBlock(x, y, z, B.WATER)) return;
        this.waterLevels.set(key, target);
        this.scheduleAround(x, y, z);
      } else if (this.waterLevels.get(key) !== target) {
        this.waterLevels.set(key, target);
        this.scheduleAround(x, y, z);
      }
    }

    // propagate: fall straight down if possible, else spread to flat neighbours
    if (this.getBlock(x, y - 1, z) === B.AIR) {
      this.scheduleWater(x, y - 1, z);
      return;
    }
    if (target < World.MAX_WATER_LEVEL) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (this.getBlock(x + dx, y, z + dz) === B.AIR) this.scheduleWater(x + dx, y, z + dz);
      }
    }
  }

  markDirty(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    const c = this.chunks.get(key);
    if (c && c.ready) {
      c.dirty = true;
      this.dirtySet.add(key);
    }
  }

  /** A chunk is meshable when its 4 neighbors are generated. */
  neighborsReady(cx: number, cz: number): boolean {
    return !![
      this.getChunk(cx - 1, cz), this.getChunk(cx + 1, cz),
      this.getChunk(cx, cz - 1), this.getChunk(cx, cz + 1),
    ].every((c) => c && c.ready);
  }

  /** Stream chunks around the player; generate up to a small time budget. */
  update(px: number, pz: number, budgetMs: number): void {
    const pcx = Math.floor(px / CX), pcz = Math.floor(pz / CZ);
    const R = this.viewDist + 1;

    // queue missing chunks
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const d = dx * dx + dz * dz;
        if (d > R * R + 1) continue;
        const cx = pcx + dx, cz = pcz + dz;
        const key = chunkKey(cx, cz);
        if (this.chunks.has(key) || this.queued.has(key)) continue;
        this.queued.add(key);
        this.genQueue.push({ cx, cz, d });
      }
    }
    if (this.genQueue.length) {
      this.genQueue.sort((a, b) => a.d - b.d);
      const t0 = performance.now();
      while (this.genQueue.length && performance.now() - t0 < budgetMs) {
        const job = this.genQueue.shift()!;
        const key = chunkKey(job.cx, job.cz);
        this.queued.delete(key);
        const dx = job.cx - pcx, dz = job.cz - pcz;
        if (dx * dx + dz * dz > R * R + 1) continue; // player moved away
        const chunk = new Chunk(job.cx, job.cz);
        const saved = this.savedChunks.get(key);
        if (saved) {
          chunk.data = rleDecode(saved, chunk.data.length);
          chunk.computeHeightmap();
          chunk.scanTorches();
          chunk.ready = true;
          chunk.modified = true;
        } else {
          this.generator.generate(chunk);
        }
        this.chunks.set(key, chunk);
        this.dirtySet.add(key);
        // remesh neighbors so their frontier faces update; include diagonals
        // when this chunk carries torch light that may spill across borders
        if (chunk.torches.size > 0) {
          for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) this.markDirty(job.cx + dx, job.cz + dz);
          }
        } else {
          this.markDirty(job.cx - 1, job.cz);
          this.markDirty(job.cx + 1, job.cz);
          this.markDirty(job.cx, job.cz - 1);
          this.markDirty(job.cx, job.cz + 1);
        }
      }
    }

    // unload far chunks
    const U = this.viewDist + 3;
    for (const [key, c] of this.chunks) {
      const dx = c.cx - pcx, dz = c.cz - pcz;
      if (dx * dx + dz * dz > U * U) {
        if (c.modified) this.savedChunks.set(key, rleEncode(c.data));
        this.chunks.delete(key);
        this.dirtySet.delete(key);
        this.onChunkRemoved(key);
      }
    }
  }

  /** Snapshot all currently-modified chunks into savedChunks (for saving). */
  stashModified(): void {
    for (const [key, c] of this.chunks) {
      if (c.modified) this.savedChunks.set(key, rleEncode(c.data));
    }
  }

  /** Amanatides & Woo DDA voxel traversal. Water and air are skipped. */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): RayHit | null {
    let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
    const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;
    let tMaxX = dx !== 0 ? (dx > 0 ? (x + 1 - ox) : (ox - x)) * tDeltaX : Infinity;
    let tMaxY = dy !== 0 ? (dy > 0 ? (y + 1 - oy) : (oy - y)) * tDeltaY : Infinity;
    let tMaxZ = dz !== 0 ? (dz > 0 ? (z + 1 - oz) : (oz - z)) * tDeltaZ : Infinity;
    let nx = 0, ny = 0, nz = 0;
    let t = 0;

    for (let i = 0; i < 256; i++) {
      const id = this.getBlock(x, y, z);
      if (id !== B.AIR && id !== B.WATER && t <= maxDist) {
        return { x, y, z, nx, ny, nz, id, dist: t };
      }
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        x += stepX; t = tMaxX; tMaxX += tDeltaX; nx = -stepX; ny = 0; nz = 0;
      } else if (tMaxY < tMaxZ) {
        y += stepY; t = tMaxY; tMaxY += tDeltaY; nx = 0; ny = -stepY; nz = 0;
      } else {
        z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; nx = 0; ny = 0; nz = -stepZ;
      }
      if (t > maxDist) return null;
    }
    return null;
  }

  countLoaded(): number { return this.chunks.size; }
}
