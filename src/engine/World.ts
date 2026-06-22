// World: chunk map + streaming, block get/set with dirty propagation,
// DDA voxel raycasting, skylight lookups, and furnace block-entities.

import { Chunk, chunkKey, CX, CZ, CY, isGlower } from './Chunk';
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
  /** last redstone power state seen — lets a manual open survive unrelated
   *  redstone updates (only a real powered↔unpowered transition moves the door) */
  poweredBy?: boolean;
}

export interface RedstoneState {
  active: boolean;
  ticksLeft?: number;
  facing?: number;
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
  
  redstonePower = new Map<string, number>();
  redstoneStates = new Map<string, RedstoneState>();
  pistonFacings = new Map<string, number>();
  redstoneBlocks = new Set<string>();
  onChunkRemoved: (key: string) => void = () => {};
  /** fired after every successful setBlock (gravity blocks, torch supports, ...) */
  onBlockChanged: (x: number, y: number, z: number, oldId: number, newId: number) => void = () => {};

  private genQueue: { cx: number; cz: number; d: number }[] = [];
  private queued = new Set<string>();

  dimension: 'overworld' | 'nether' = 'overworld';
  dimData: {
    overworld: {
      savedChunks: Map<string, Uint8Array>;
      blockEntities: Map<string, BlockEntity>;
      doorStates: Map<string, DoorState>;
      torchFacings: Map<string, number>;
      waterLevels: Map<string, number>;
      lavaLevels: Map<string, number>;
      redstonePower: Map<string, number>;
      redstoneStates: Map<string, RedstoneState>;
      pistonFacings: Map<string, number>;
      redstoneBlocks: Set<string>;
    };
    nether: {
      savedChunks: Map<string, Uint8Array>;
      blockEntities: Map<string, BlockEntity>;
      doorStates: Map<string, DoorState>;
      torchFacings: Map<string, number>;
      waterLevels: Map<string, number>;
      lavaLevels: Map<string, number>;
      redstonePower: Map<string, number>;
      redstoneStates: Map<string, RedstoneState>;
      pistonFacings: Map<string, number>;
      redstoneBlocks: Set<string>;
    };
  };

  constructor(seed: number) {
    this.seed = seed | 0;
    this.generator = new WorldGenerator(this.seed);
    this.dimData = {
      overworld: {
        savedChunks: this.savedChunks,
        blockEntities: this.blockEntities,
        doorStates: this.doorStates,
        torchFacings: this.torchFacings,
        waterLevels: this.waterLevels,
        lavaLevels: this.lavaLevels,
        redstonePower: this.redstonePower,
        redstoneStates: this.redstoneStates,
        pistonFacings: this.pistonFacings,
        redstoneBlocks: this.redstoneBlocks,
      },
      nether: {
        savedChunks: new Map(),
        blockEntities: new Map(),
        doorStates: new Map(),
        torchFacings: new Map(),
        waterLevels: new Map(),
        lavaLevels: new Map(),
        redstonePower: new Map(),
        redstoneStates: new Map(),
        pistonFacings: new Map(),
        redstoneBlocks: new Set(),
      }
    };
  }

  getChunk(cx: number, cz: number): Chunk | undefined {
    return this.chunks.get(chunkKey(cx, cz));
  }

  /** Force a chunk into existence synchronously. The async streamer normally
   *  generates chunks over several frames, but teleporting needs the
   *  destination ready *now* so we can build a landing platform and place the
   *  player on solid ground (otherwise setBlock no-ops and the player falls). */
  ensureChunk(cx: number, cz: number): Chunk {
    const key = chunkKey(cx, cz);
    const existing = this.chunks.get(key);
    if (existing) return existing;
    this.queued.delete(key);
    const chunk = new Chunk(cx, cz);
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
    this.scanRedstoneInChunk(chunk);
    this.markDirty(cx - 1, cz); this.markDirty(cx + 1, cz);
    this.markDirty(cx, cz - 1); this.markDirty(cx, cz + 1);
    return chunk;
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
    if (id === B.TORCH || oldId === B.TORCH || isGlower(id) || isGlower(oldId) || this.lightsNear(cx, cz)) {
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
    const REDSTONE_IDS = new Set<number>([
      B.REDSTONE_WIRE, B.LEVER, B.WOODEN_BUTTON, B.STONE_BUTTON,
      B.PRESSURE_PLATE, B.REDSTONE_LAMP, B.REDSTONE_LAMP_LIT,
      B.PISTON, B.STICKY_PISTON, B.PISTON_HEAD,
      // doors/trapdoors are redstone sinks: tracked so power can open/close them
      B.DOOR_LOWER, B.DOOR_UPPER, B.TRAPDOOR
    ]);
    const posKey = `${wx},${wy},${wz}`;
    if (REDSTONE_IDS.has(oldId)) {
      this.redstoneBlocks.delete(posKey);
      this.redstonePower.delete(posKey);
      this.redstoneStates.delete(posKey);
      this.pistonFacings.delete(posKey);
    }
    if (REDSTONE_IDS.has(id)) {
      this.redstoneBlocks.add(posKey);
    }

    if (oldId === B.WATER && id !== B.WATER) this.waterLevels.delete(posKey);
    if (oldId === B.LAVA && id !== B.LAVA) this.lavaLevels.delete(posKey);
    this.onBlockChanged(wx, wy, wz, oldId, id);
    // Fluid flow: re-check this cell + neighbors when an edit exposes air or
    // touches a fluid. Breaking a block beside/under fluid should start flow;
    // placing a solid in fluid should make the old flow recede.
    if (id === B.AIR || oldId === B.AIR || id === B.WATER || oldId === B.WATER) this.scheduleAroundFluid(B.WATER, wx, wy, wz);
    if (id === B.AIR || oldId === B.AIR || id === B.LAVA || oldId === B.LAVA) this.scheduleAroundFluid(B.LAVA, wx, wy, wz);
    return true;
  }

  private lightsNear(cx: number, cz: number): boolean {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const c = this.chunks.get(chunkKey(cx + dx, cz + dz));
        if (c && (c.torches.size > 0 || c.glowers.size > 0)) return true;
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

  // --- flowing fluids --------------------------------------------------------
  // Levels: 0 = source (or fed from directly above), 1..N = flowing. Generated
  // ocean/lava and bucket sources are absent from their maps and read as source.
  // Flowing cells are tracked and recede when they lose connection to a source.
  waterLevels = new Map<string, number>();
  lavaLevels = new Map<string, number>();
  private waterQueue: string[] = [];
  private waterQueued = new Set<string>();
  private lavaQueue: string[] = [];
  private lavaQueued = new Set<string>();
  private static readonly MAX_WATER_LEVEL = 7;
  private static readonly MAX_LAVA_LEVEL = 3;
  private static readonly NO_FLUID = 99;
  private static readonly DIRS: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  /** Queue a cell for a water-flow re-evaluation on the next water tick. */
  scheduleWater(x: number, y: number, z: number): void {
    this.scheduleFluid(B.WATER, x, y, z);
  }

  /** Queue a cell for a lava-flow re-evaluation on the next lava tick. */
  scheduleLava(x: number, y: number, z: number): void {
    this.scheduleFluid(B.LAVA, x, y, z);
  }

  private scheduleFluid(fluid: number, x: number, y: number, z: number): void {
    if (y < 0 || y >= CY) return;
    const key = `${x},${y},${z}`;
    const queue = fluid === B.LAVA ? this.lavaQueue : this.waterQueue;
    const queued = fluid === B.LAVA ? this.lavaQueued : this.waterQueued;
    if (queued.has(key)) return;
    queued.add(key);
    queue.push(key);
  }

  private scheduleAroundFluid(fluid: number, x: number, y: number, z: number): void {
    this.scheduleFluid(fluid, x, y, z);
    this.scheduleFluid(fluid, x, y - 1, z); this.scheduleFluid(fluid, x, y + 1, z);
    this.scheduleFluid(fluid, x + 1, y, z); this.scheduleFluid(fluid, x - 1, y, z);
    this.scheduleFluid(fluid, x, y, z + 1); this.scheduleFluid(fluid, x, y, z - 1);
  }

  /** Water level at a cell (0 = source/fed-from-above). Assumes water present. */
  waterLevel(x: number, y: number, z: number): number {
    return this.fluidLevel(B.WATER, x, y, z);
  }

  /** Lava level at a cell (0 = source/fed-from-above). Assumes lava present. */
  lavaLevel(x: number, y: number, z: number): number {
    return this.fluidLevel(B.LAVA, x, y, z);
  }

  private fluidLevel(fluid: number, x: number, y: number, z: number): number {
    if (this.getBlock(x, y + 1, z) === fluid) return 0; // fed from the column above
    return this.levelsFor(fluid).get(`${x},${y},${z}`) ?? 0;
  }

  /** Advance queued water cells with a per-tick op budget (rest carries over). */
  tickWater(maxOps = 800): void {
    this.tickFluid(B.WATER, maxOps);
  }

  /** Advance queued lava cells with a per-tick op budget (rest carries over). */
  tickLava(maxOps = 300): void {
    this.tickFluid(B.LAVA, maxOps);
  }

  private tickFluid(fluid: number, maxOps: number): void {
    const queue = fluid === B.LAVA ? this.lavaQueue : this.waterQueue;
    const queued = fluid === B.LAVA ? this.lavaQueued : this.waterQueued;
    let ops = 0;
    while (queue.length && ops < maxOps) {
      const key = queue.shift()!;
      queued.delete(key);
      const c = key.split(',');
      this.updateFluidCell(fluid, +c[0], +c[1], +c[2]);
      ops++;
    }
  }

  /**
   * Re-derive one cell's water level purely from its neighbours (a "pull"
   * automaton): a permanent source or a cell fed from above stays at 0; any
   * other cell takes (best feeding neighbour + 1), or empties if nothing feeds
   * it. This converges cleanly for both spreading and receding.
   */
  private updateFluidCell(fluid: number, x: number, y: number, z: number): void {
    const key = `${x},${y},${z}`;
    const levels = this.levelsFor(fluid);
    const maxLevel = fluid === B.LAVA ? World.MAX_LAVA_LEVEL : World.MAX_WATER_LEVEL;
    const id = this.getBlock(x, y, z);
    const isFluid = id === fluid;
    let permanent = isFluid && !levels.has(key); // generated / bucket source

    // Minecraft contact reaction: lava meeting water hardens into rock — a lava
    // source becomes obsidian, flowing lava becomes cobblestone.
    if (fluid === B.LAVA && isFluid && this.touchesBlock(B.WATER, x, y, z)) {
      this.setBlock(x, y, z, permanent ? B.OBSIDIAN : B.COBBLE);
      return;
    }

    // Minecraft infinite water: a cell flanked by 2+ source blocks turns into a
    // source itself (the 2x2 water-bucket trick).
    if (fluid === B.WATER && !permanent && (isFluid || id === B.AIR) &&
      this.countSourceNeighbours(x, y, z) >= 2) {
      if (id === B.AIR && !this.setBlock(x, y, z, B.WATER)) return;
      levels.delete(key); // absent from the map = permanent source
      permanent = true;
      this.scheduleAroundFluid(B.WATER, x, y, z);
    }

    let target: number;
    if (permanent || this.getBlock(x, y + 1, z) === fluid) {
      target = 0;
    } else {
      target = World.NO_FLUID;
      for (const [dx, dz] of World.DIRS) {
        const nx = x + dx, nz = z + dz;
        if (this.getBlock(nx, y, nz) !== fluid) continue;
        if (!this.canFeedFrom(fluid, nx, y, nz, x, z, levels)) continue;
        target = Math.min(target, this.fluidLevel(fluid, nx, y, nz) + 1);
      }
    }

    if (!permanent) {
      if (target > maxLevel) {
        if (isFluid && this.setBlock(x, y, z, B.AIR)) {
          levels.delete(key);
          this.scheduleAroundFluid(fluid, x, y, z);
        }
        return;
      }
      if (!isFluid) {
        if (id !== B.AIR) return;
        if (!this.setBlock(x, y, z, fluid)) return;
        levels.set(key, target);
        this.scheduleAroundFluid(fluid, x, y, z);
      } else if (levels.get(key) !== target) {
        levels.set(key, target);
        this.scheduleAroundFluid(fluid, x, y, z);
      }
    }

    // Minecraft-like flow priority: fall straight down first. Otherwise, if any
    // horizontal direction reaches a drop within the search range, feed only the
    // shortest downhill direction(s) instead of fanning across flat ground.
    if (this.getBlock(x, y - 1, z) === B.AIR) {
      this.scheduleFluid(fluid, x, y - 1, z);
      return;
    }
    if (target < maxLevel) {
      const preferred = this.preferredFlowDirs(fluid, x, y, z);
      if (preferred) {
        for (const [dx, dz] of preferred) {
          this.scheduleFluid(fluid, x + dx, y, z + dz);
        }
        return;
      }
      for (const [dx, dz] of World.DIRS) {
        if (this.getBlock(x + dx, y, z + dz) === B.AIR) this.scheduleFluid(fluid, x + dx, y, z + dz);
      }
    }
  }

  private levelsFor(fluid: number): Map<string, number> {
    return fluid === B.LAVA ? this.lavaLevels : this.waterLevels;
  }

  /** Is any of the 6 neighbouring cells the given block? */
  private touchesBlock(target: number, x: number, y: number, z: number): boolean {
    return this.getBlock(x + 1, y, z) === target || this.getBlock(x - 1, y, z) === target ||
      this.getBlock(x, y, z + 1) === target || this.getBlock(x, y, z - 1) === target ||
      this.getBlock(x, y + 1, z) === target || this.getBlock(x, y - 1, z) === target;
  }

  /** Count horizontally-adjacent water *source* blocks (for infinite sources). */
  private countSourceNeighbours(x: number, y: number, z: number): number {
    let n = 0;
    for (const [dx, dz] of World.DIRS) {
      const nx = x + dx, nz = z + dz;
      if (this.getBlock(nx, y, nz) === B.WATER && !this.waterLevels.has(`${nx},${y},${nz}`) &&
        this.getBlock(nx, y + 1, nz) !== B.WATER) n++;
    }
    return n;
  }

  private canFeedFrom(fluid: number, fromX: number, y: number, fromZ: number, toX: number, toZ: number,
    levels: Map<string, number>): boolean {
    // A falling non-source column feeds downward only.
    if (this.getBlock(fromX, y - 1, fromZ) === B.AIR && levels.has(`${fromX},${y},${fromZ}`)) return false;

    const preferred = this.preferredFlowDirs(fluid, fromX, y, fromZ);
    if (preferred) return preferred.some(([dx, dz]) => fromX + dx === toX && fromZ + dz === toZ);
    return this.getBlock(toX, y, toZ) === B.AIR || this.getBlock(toX, y, toZ) === fluid;
  }

  private preferredFlowDirs(fluid: number, x: number, y: number, z: number): (readonly [number, number])[] | null {
    const maxDepth = fluid === B.LAVA ? 2 : 4;
    let best = World.NO_FLUID;
    const dirs: (readonly [number, number])[] = [];
    for (const [dx, dz] of World.DIRS) {
      const nx = x + dx, nz = z + dz;
      if (!this.canFluidOccupy(fluid, nx, y, nz)) continue;
      const dist = this.flowDistanceToDrop(fluid, nx, y, nz, -dx, -dz, 0, maxDepth);
      if (dist >= best) {
        if (dist === best && dist < World.NO_FLUID) dirs.push([dx, dz]);
        continue;
      }
      best = dist;
      dirs.length = 0;
      if (dist < World.NO_FLUID) dirs.push([dx, dz]);
    }
    return dirs.length ? dirs : null;
  }

  private flowDistanceToDrop(fluid: number, x: number, y: number, z: number, backX: number, backZ: number,
    depth: number, maxDepth: number): number {
    if (this.canFluidFallInto(fluid, x, y - 1, z)) return depth;
    if (depth >= maxDepth) return World.NO_FLUID;

    let best = World.NO_FLUID;
    for (const [dx, dz] of World.DIRS) {
      if (dx === backX && dz === backZ) continue;
      const nx = x + dx, nz = z + dz;
      if (!this.canFluidOccupy(fluid, nx, y, nz)) continue;
      best = Math.min(best, this.flowDistanceToDrop(fluid, nx, y, nz, -dx, -dz, depth + 1, maxDepth));
    }
    return best;
  }

  private canFluidOccupy(fluid: number, x: number, y: number, z: number): boolean {
    const id = this.getBlock(x, y, z);
    return id === B.AIR || id === fluid;
  }

  private canFluidFallInto(fluid: number, x: number, y: number, z: number): boolean {
    const id = this.getBlock(x, y, z);
    return id === B.AIR || id === fluid;
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
        this.scanRedstoneInChunk(chunk);
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
        this.forgetRedstoneInChunk(c.cx, c.cz);
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

  switchDimension(dim: 'overworld' | 'nether'): void {
    if (this.dimension === dim) return;
    this.stashModified();
    for (const key of this.chunks.keys()) {
      this.onChunkRemoved(key);
    }
    this.chunks.clear();
    this.dirtySet.clear();
    this.genQueue.length = 0;
    this.queued.clear();

    this.dimension = dim;
    this.generator.dimension = dim;
    this.savedChunks = this.dimData[dim].savedChunks;
    this.blockEntities = this.dimData[dim].blockEntities;
    this.doorStates = this.dimData[dim].doorStates;
    this.torchFacings = this.dimData[dim].torchFacings;
    this.waterLevels = this.dimData[dim].waterLevels;
    this.lavaLevels = this.dimData[dim].lavaLevels;
    this.redstonePower = this.dimData[dim].redstonePower;
    this.redstoneStates = this.dimData[dim].redstoneStates;
    this.pistonFacings = this.dimData[dim].pistonFacings;
    this.redstoneBlocks = this.dimData[dim].redstoneBlocks;
  }

  scanRedstoneInChunk(chunk: Chunk): void {
    const REDSTONE_IDS = new Set<number>([
      B.REDSTONE_WIRE, B.LEVER, B.WOODEN_BUTTON, B.STONE_BUTTON,
      B.PRESSURE_PLATE, B.REDSTONE_LAMP, B.REDSTONE_LAMP_LIT,
      B.PISTON, B.STICKY_PISTON, B.PISTON_HEAD,
      // doors/trapdoors are redstone sinks: tracked so power can open/close them
      B.DOOR_LOWER, B.DOOR_UPPER, B.TRAPDOOR
    ]);
    const bx = chunk.cx * CX, bz = chunk.cz * CZ;
    for (let y = 0; y < CY; y++) {
      for (let z = 0; z < CZ; z++) {
        for (let x = 0; x < CX; x++) {
          const id = chunk.data[x | (z << 4) | (y << 8)];
          if (REDSTONE_IDS.has(id)) {
            this.redstoneBlocks.add(`${bx + x},${y},${bz + z}`);
          }
        }
      }
    }
  }

  forgetRedstoneInChunk(cx: number, cz: number): void {
    const bx0 = cx * CX, bx1 = bx0 + CX;
    const bz0 = cz * CZ, bz1 = bz0 + CZ;
    for (const key of this.redstoneBlocks) {
      const [x, y, z] = key.split(',').map(Number);
      if (x >= bx0 && x < bx1 && z >= bz0 && z < bz1) {
        this.redstoneBlocks.delete(key);
      }
    }
  }

  countLoaded(): number { return this.chunks.size; }
}
