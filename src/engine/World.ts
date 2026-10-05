// World: chunk map + streaming, block get/set with dirty propagation,
// DDA voxel raycasting, skylight lookups, and furnace block-entities.

import { Chunk, chunkKey, CX, CZ, CY, isGlower, nextChunkVersion } from './Chunk';
import { WorldGenerator } from './WorldGenerator';
import { B, isSolid, def, hasDef, DOOR_IDS, DOOR_LOWERS, DOOR_UPPERS, TRAPDOOR_IDS, doorBox, trapdoorBox, REDSTONE_IDS, PLATE_IDS, POLL_IDS, RAIL_IDS } from './Blocks';
import { CROSS_BLOCKS, CLIMBABLE } from './Blocks';
import type { Box } from './Blocks';
import { BlockEntity } from './Inventory';
import { rleDecode, rleEncode, rleIsLegacy } from './Persistence';
import type { GenResult } from './gen-worker';
import type { BlockData } from './Chunk';

/** Old (u8-id) saves predate the vine blocks: hanging crimson roots were drawn
 *  as weeping vines and stacked warped roots as twisting vines. Turn those into
 *  the real (climbable) vines; floor tufts stay roots. */
export function migrateLegacyChunk(data: BlockData): void {
  const at = (i: number): number => (i >= 0 && i < data.length ? data[i] : B.AIR);
  const weep: number[] = [], twist: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const id = data[i];
    if (id === B.CRIMSON_ROOTS && !isSolid(at(i - 256))) weep.push(i);
    else if (id === B.WARPED_ROOTS && (at(i + 256) === B.WARPED_ROOTS || at(i - 256) === B.WARPED_ROOTS)) twist.push(i);
  }
  for (const i of weep) data[i] = B.WEEPING_VINES;
  for (const i of twist) data[i] = B.TWISTING_VINES;
}

/** Decode a saved chunk blob (either RLE version), upgrading legacy content. */
function decodeSaved(saved: Uint8Array, len: number): BlockData {
  const data = rleDecode(saved, len);
  if (rleIsLegacy(saved)) migrateLegacyChunk(data);
  return data;
}

/** Cardinal facing for a placed door/trapdoor, in 90-degree steps.
 *  For doors this is the direction the player was looking when placed; for a
 *  trapdoor it points away from the edge it hinges on (vanilla FACING). */
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
  /** trapdoors: closed hatch sits in the top half of the cell */
  top?: boolean;
}

export interface RedstoneState {
  active: boolean;
  ticksLeft?: number;
  facing?: number;
  /** pressure plates: ticks remaining before releasing after the last step-off */
  releaseT?: number;
  /** repeaters: delay in redstone ticks (1..4) */
  delay?: number;
  /** note blocks: pitch step 0..24 */
  pitch?: number;
  /** comparators: subtract mode */
  sub?: boolean;
  /** comparators / daylight detectors: output level 0..15 */
  level?: number;
}

/** Slab test of a ray (origin relative to the box's block) against a
 *  block-local box: entry distance and the entered face's normal, or null. */
function rayBox(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, b: Box): { t: number; nx: number; ny: number; nz: number } | null {
  let tMin = 0, tMax = Infinity, axis = -1, sign = 0;
  const o = [ox, oy, oz], d = [dx, dy, dz];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < b[i] || o[i] > b[i + 3]) return null;
      continue;
    }
    let t0 = (b[i] - o[i]) / d[i], t1 = (b[i + 3] - o[i]) / d[i];
    let s = -1;
    if (t0 > t1) { const tt = t0; t0 = t1; t1 = tt; s = 1; }
    if (t0 > tMin) { tMin = t0; axis = i; sign = s; }
    if (t1 < tMax) tMax = t1;
    if (tMin > tMax) return null;
  }
  // origin inside the box: report the face the ray is heading out of
  if (axis < 0) { axis = 1; sign = dy > 0 ? -1 : 1; }
  return { t: tMin, nx: axis === 0 ? sign : 0, ny: axis === 1 ? sign : 0, nz: axis === 2 ? sign : 0 };
}

export interface RayHit {
  x: number; y: number; z: number;     // block coords
  nx: number; ny: number; nz: number;  // face normal
  id: number;
  dist: number;
}

/** Blocks flowing fluid washes away (vanilla canHoldFluid: no collision, not
 *  a door/sign/ladder/sugar cane/portal): plants, crops, torches, dust, fire. */
const FLUID_WASHABLE = new Set<number>([
  ...[...CROSS_BLOCKS].filter((id) => id !== B.SUGAR_CANE && !CLIMBABLE.has(id)),
  B.TORCH, B.SOUL_TORCH, B.REDSTONE_TORCH, B.REDSTONE_TORCH_OFF, B.REDSTONE_WIRE,
]);

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
  /** 2-block bed facing keyed by "x,y,z" (both halves): 0=-z,1=-x,2=+z,3=+x,
   *  the direction from the foot half toward the head half */
  bedFacings = new Map<string, number>();

  redstonePower = new Map<string, number>();
  redstoneStates = new Map<string, RedstoneState>();
  pistonFacings = new Map<string, number>();
  redstoneBlocks = new Set<string>();
  /** loaded pressure plates (the per-tick "is anyone standing on it" scan) */
  plateBlocks = new Set<string>();
  /** loaded comparators + daylight detectors (re-read on a timer) */
  pollBlocks = new Set<string>();
  onChunkRemoved: (key: string) => void = () => {};
  /** a chunk was generated / reloaded and is ready (multiplayer replays its edits) */
  onChunkInstalled: (cx: number, cz: number) => void = () => {};
  /** fired after every successful setBlock (gravity blocks, torch supports, ...) */
  onBlockChanged: (x: number, y: number, z: number, oldId: number, newId: number) => void = () => {};

  private genQueue: { cx: number; cz: number; d: number }[] = [];
  private queued = new Set<string>();
  // Terrain generation runs in Web Workers when available (the sync path
  // below stays as the fallback for node tests / no-Worker environments).
  private genWorkers: Worker[] | null = null;
  private genWorkersTried = false;
  private genInFlight = new Map<string, number>(); // key -> job id
  private genJobId = 0;
  private genRR = 0;
  private lastPcx = 0;
  private lastPcz = 0;
  /** EMA of worker generation time per chunk (ms), for the debug overlay */
  genMs = 0;

  dimension: 'overworld' | 'nether' = 'overworld';
  dimData: {
    overworld: {
      savedChunks: Map<string, Uint8Array>;
      blockEntities: Map<string, BlockEntity>;
      doorStates: Map<string, DoorState>;
      torchFacings: Map<string, number>;
      bedFacings: Map<string, number>;
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
      bedFacings: Map<string, number>;
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
        bedFacings: this.bedFacings,
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
        bedFacings: new Map(),
        waterLevels: new Map(),
        lavaLevels: new Map(),
        redstonePower: new Map(),
        redstoneStates: new Map(),
        pistonFacings: new Map(),
        redstoneBlocks: new Set(),
      }
    };
  }

  // one-chunk lookup cache: block reads cluster (physics boxes, fluid and
  // light scans, raycasts), and building the string key for every read was a
  // top cost — and garbage — in profiles. Reset on every change to the map.
  private cacheCx = NaN;
  private cacheCz = NaN;
  private cacheChunk: Chunk | undefined;
  private chunksChanged(): void { this.cacheCx = NaN; this.cacheChunk = undefined; }

  getChunk(cx: number, cz: number): Chunk | undefined {
    if (cx === this.cacheCx && cz === this.cacheCz) return this.cacheChunk;
    const c = this.chunks.get(chunkKey(cx, cz));
    this.cacheCx = cx; this.cacheCz = cz; this.cacheChunk = c;
    return c;
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
    this.genInFlight.delete(key); // a pending worker result for it is now stale
    const chunk = new Chunk(cx, cz);
    const saved = this.savedChunks.get(key);
    if (saved) {
      chunk.data = decodeSaved(saved, chunk.data.length);
      chunk.version = nextChunkVersion();
      chunk.computeHeightmap();
      chunk.scanTorches();
      chunk.ready = true;
      chunk.modified = true;
    } else {
      this.generator.generate(chunk);
      this.generator.drainStates(this);
    }
    this.chunks.set(key, chunk);
    this.chunksChanged();
    this.dirtySet.add(key);
    this.scanRedstoneInChunk(chunk);
    this.markDirty(cx - 1, cz); this.markDirty(cx + 1, cz);
    this.markDirty(cx, cz - 1); this.markDirty(cx, cz + 1);
    this.onChunkInstalled(cx, cz);
    return chunk;
  }

  getBlock(wx: number, wy: number, wz: number): number {
    if (wy < 0) return B.BEDROCK;
    if (wy >= CY) return B.AIR;
    const c = this.getChunk(Math.floor(wx / CX), Math.floor(wz / CZ));
    if (!c || !c.ready) return B.AIR;
    return c.data[(wx & 15) | ((wz & 15) << 4) | (wy << 8)];
  }

  /** For meshing at the frontier: unloaded chunks read as opaque to cull walls. */
  getBlockForMesh(wx: number, wy: number, wz: number): number {
    if (wy < 0) return B.BEDROCK;
    if (wy >= CY) return B.AIR;
    const c = this.getChunk(Math.floor(wx / CX), Math.floor(wz / CZ));
    if (!c || !c.ready) return B.STONE;
    return c.data[(wx & 15) | ((wz & 15) << 4) | (wy << 8)];
  }

  isSolidAt(wx: number, wy: number, wz: number): boolean {
    return isSolid(this.getBlock(wx, wy, wz));
  }

  skyLight(wx: number, wy: number, wz: number): number {
    if (wy >= CY) return 1;
    const c = this.getChunk(Math.floor(wx / CX), Math.floor(wz / CZ));
    if (!c || !c.ready) return 1;
    return c.skyLight(wx & 15, Math.max(0, wy), wz & 15);
  }

  setBlock(wx: number, wy: number, wz: number, id: number): boolean {
    if (wy < 0 || wy >= CY) return false;
    const cx = Math.floor(wx / CX), cz = Math.floor(wz / CZ);
    const c = this.getChunk(cx, cz);
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
    if (PLATE_IDS.has(oldId)) this.plateBlocks.delete(posKey);
    if (PLATE_IDS.has(id)) this.plateBlocks.add(posKey);
    if (POLL_IDS.has(oldId)) this.pollBlocks.delete(posKey);
    if (POLL_IDS.has(id)) this.pollBlocks.add(posKey);

    if (oldId === B.WATER && id !== B.WATER) this.waterLevels.delete(posKey);
    if (oldId === B.LAVA && id !== B.LAVA) this.lavaLevels.delete(posKey);
    this.onBlockChanged(wx, wy, wz, oldId, id);
    // fluids around the edit re-check themselves (breaking a block beside or
    // under fluid starts a flow; placing one in it makes the flow recede)
    this.fluidNeighbourChanged(wx, wy, wz);
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
    if (DOOR_UPPERS.has(id)) return this.doorStates.get(`${x},${y - 1},${z}`);
    if (DOOR_LOWERS.has(id)) return this.doorStates.get(`${x},${y + 1},${z}`);
    return undefined;
  }

  /** Toggle a door's or trapdoor's open state. Returns true if it toggled. */
  toggleDoor(x: number, y: number, z: number): boolean {
    let id = this.getBlock(x, y, z);
    // trapdoor: keyed by its own position
    if (TRAPDOOR_IDS.has(id)) {
      const key = `${x},${y},${z}`;
      const st = this.doorStates.get(key) ?? { facing: 0 as DoorFacing, open: false };
      st.open = !st.open;
      this.doorStates.set(key, st);
      this.markDirty(Math.floor(x / CX), Math.floor(z / CZ));
      return true;
    }
    // tall door: lower half holds the state
    let ly = y;
    if (DOOR_UPPERS.has(id)) { ly = y - 1; id = this.getBlock(x, ly, z); }
    if (!DOOR_LOWERS.has(id)) return false;
    const key = `${x},${ly},${z}`;
    const st = this.doorStates.get(key) ?? { facing: 0 as DoorFacing, open: false, swing: 0 };
    st.open = !st.open;
    if (st.swing === undefined) st.swing = st.open ? 0 : 1;
    this.doorStates.set(key, st);
    this.markDirty(Math.floor(x / CX), Math.floor(z / CZ));
    // vanilla: each leaf of a double door opens on its own (the pair only
    // mirrors hinges); redstone between them opens both
    return true;
  }

  /** Redstone input for the door/trapdoor at (x, y, z) (either door half).
   *  Only a real unpowered↔powered transition moves it, so a hand-opened door
   *  isn't slammed by an unrelated redstone update. Returns 'open' / 'close'
   *  when it moved (for the sound), else null. */
  applyDoorPower(x: number, y: number, z: number, powered: boolean): 'open' | 'close' | null {
    const id = this.getBlock(x, y, z);
    const isTrap = TRAPDOOR_IDS.has(id);
    if (!isTrap && !DOOR_IDS.has(id)) return null;
    const ly = DOOR_UPPERS.has(id) ? y - 1 : y;
    const key = `${x},${ly},${z}`;
    const st = this.doorStates.get(key);
    if (!st || powered === !!st.poweredBy) return null;
    st.poweredBy = powered;
    this.doorStates.set(key, st);
    if (st.open === powered) return null;
    st.open = powered;
    if (!isTrap && st.swing === undefined) st.swing = powered ? 0 : 1;
    this.markDirty(Math.floor(x / CX), Math.floor(z / CZ));
    return powered ? 'open' : 'close';
  }

  /** Adjacent door forming a pair: same facing, opposite hinge, along the
   *  door's width axis. Returns its lower-half key/state, or null. */
  doorPartner(lx: number, ly: number, lz: number, st: DoorState): { key: string; x: number; z: number; st: DoorState } | null {
    // width axis is perpendicular to the facing normal
    const along = st.facing % 2 === 0 ? [[1, 0], [-1, 0]] : [[0, 1], [0, -1]];
    for (const [dx, dz] of along) {
      const nx = lx + dx, nz = lz + dz;
      if (!DOOR_LOWERS.has(this.getBlock(nx, ly, nz))) continue;
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
      if (!DOOR_LOWERS.has(this.getBlock(wx, wy, wz))) continue;
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
    if (!TRAPDOOR_IDS.has(this.getBlock(x, y, z))) return false;
    return this.doorStates.get(`${x},${y},${z}`)?.open ?? false;
  }

  /** Collision/selection box of a door half or trapdoor (block-local), or
   *  null for any other block. A swinging door counts as open past halfway. */
  doorShape(x: number, y: number, z: number, id = this.getBlock(x, y, z)): Box | null {
    if (TRAPDOOR_IDS.has(id)) {
      const st = this.doorStates.get(`${x},${y},${z}`);
      return trapdoorBox(st?.facing ?? 0, !!st?.open, !!st?.top);
    }
    if (!DOOR_IDS.has(id)) return null;
    const st = this.doorStateAt(x, y, z);
    const swing = st?.swing ?? (st?.open ? 1 : 0);
    return doorBox(st?.facing ?? 0, !!st?.hingeRight, swing >= 0.5);
  }

  /** Aiming box of a rail (a flat strip, half a block for a slope), or null.
   *  Only raycasts use it: rails never collide. */
  railShape(x: number, y: number, z: number, id = this.getBlock(x, y, z)): Box | null {
    if (!RAIL_IDS.has(id)) return null;
    const s = this.bedFacings.get(`${x},${y},${z}`) ?? 0;
    return [0, 0, 0, 1, s >= 2 && s <= 5 ? 0.5 : 0.125, 1];
  }

  /** Is this door block currently closed (i.e. should it block movement)? */
  isDoorClosed(x: number, y: number, z: number): boolean {
    const st = this.doorStateAt(x, y, z);
    if (!st) return false;
    const swing = st.swing ?? (st.open ? 1 : 0);
    return swing < 0.5;
  }

  // --- flowing fluids --------------------------------------------------------
  // A port of vanilla FlowingFluid. Levels (the per-dimension maps): absent =
  // source, 1..7 = flowing (vanilla block level; amount = 8 - level), 8 =
  // falling (fed from the cell above; amount 8). Water drops 1 per block (7
  // out), overworld lava 2 (levels 2/4/6 → 3 out), Nether lava 1 (7 out).
  // A cell re-derives its level from its neighbours when it ticks (vanilla
  // getNewLiquid), then pushes into free cells (spread): straight down first,
  // otherwise sideways toward the nearest drop within 4 blocks (2 for
  // overworld lava), or evenly when there is none. Steps run every 5 game
  // ticks for water, 30 (overworld) / 10 (Nether) for lava; `tickFluids()` is
  // called from the 20 Hz logic tick, `tickWater()`/`tickLava()` run one step.
  waterLevels = new Map<string, number>();
  lavaLevels = new Map<string, number>();
  private waterQueue: string[] = [];
  private waterQueued = new Set<string>();
  private lavaQueue: string[] = [];
  private lavaQueued = new Set<string>();
  private fluidClock = 0;
  /** Fluid washed a block away (water drops it, lava burns it). */
  onFluidWash: (x: number, y: number, z: number, id: number, fluid: number) => void = () => {};
  /** Lava met water and hardened (fizz + smoke). */
  onFluidFizz: (x: number, y: number, z: number) => void = () => {};
  private static readonly DIRS: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  static readonly FALLING = 8;

  /** Queue a cell for a water-flow re-evaluation on the next water step. */
  scheduleWater(x: number, y: number, z: number): void {
    this.scheduleFluid(B.WATER, x, y, z);
  }

  /** Queue a cell for a lava-flow re-evaluation on the next lava step. */
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

  /** A block changed: wake the fluid cells around it (vanilla neighborChanged)
   *  and harden any lava that now touches water — that reaction is immediate,
   *  not a scheduled tick. */
  private fluidNeighbourChanged(x: number, y: number, z: number): void {
    for (let i = 0; i < 7; i++) {
      const nx = x + (i === 1 ? 1 : i === 2 ? -1 : 0);
      const ny = y + (i === 3 ? 1 : i === 4 ? -1 : 0);
      const nz = z + (i === 5 ? 1 : i === 6 ? -1 : 0);
      const id = this.getBlock(nx, ny, nz);
      if (id === B.WATER) this.scheduleFluid(B.WATER, nx, ny, nz);
      else if (id === B.LAVA && !this.hardenLava(nx, ny, nz)) this.scheduleFluid(B.LAVA, nx, ny, nz);
    }
  }

  /** Vanilla LiquidBlock.shouldSpreadLiquid: lava with water beside or above
   *  it turns to obsidian (source) or cobblestone (flowing). */
  private hardenLava(x: number, y: number, z: number): boolean {
    const W = B.WATER;
    if (this.getBlock(x + 1, y, z) !== W && this.getBlock(x - 1, y, z) !== W &&
      this.getBlock(x, y, z + 1) !== W && this.getBlock(x, y, z - 1) !== W &&
      this.getBlock(x, y + 1, z) !== W) return false;
    const source = !this.lavaLevels.has(`${x},${y},${z}`);
    if (!this.setBlock(x, y, z, source ? B.OBSIDIAN : B.COBBLE)) return false;
    this.onFluidFizz(x, y, z);
    return true;
  }

  /** Raw level of a fluid cell: 0 source, 1..7 flowing, 8 falling. Assumes
   *  the fluid is present. */
  waterLevel(x: number, y: number, z: number): number {
    return this.waterLevels.get(`${x},${y},${z}`) ?? 0;
  }

  lavaLevel(x: number, y: number, z: number): number {
    return this.lavaLevels.get(`${x},${y},${z}`) ?? 0;
  }

  /** Lava level lost per block: 2 in the Overworld (3 blocks), 1 in the Nether. */
  private dropOff(fluid: number): number {
    return fluid === B.LAVA && this.dimension !== 'nether' ? 2 : 1;
  }

  private slopeFindDistance(fluid: number): number {
    return fluid === B.LAVA && this.dimension !== 'nether' ? 2 : 4;
  }

  /** Steps between fluid updates, in 20 Hz ticks (vanilla tick delays). */
  private fluidDelay(fluid: number): number {
    return fluid === B.WATER ? 5 : this.dimension === 'nether' ? 10 : 30;
  }

  /** Called every 20 Hz logic tick: runs the water/lava steps that are due. */
  tickFluids(): void {
    this.fluidClock++;
    if (this.fluidClock % this.fluidDelay(B.WATER) === 0) this.tickWater();
    if (this.fluidClock % this.fluidDelay(B.LAVA) === 0) this.tickLava();
  }

  /** One water step (op budget per step; the rest carries over). */
  tickWater(maxOps = 1500): void {
    this.tickFluid(B.WATER, maxOps);
  }

  /** One lava step. */
  tickLava(maxOps = 600): void {
    this.tickFluid(B.LAVA, maxOps);
  }

  /** Are fluid updates still pending (harnesses wait on this)? */
  fluidsBusy(): boolean {
    return this.waterQueue.length > 0 || this.lavaQueue.length > 0;
  }

  private tickFluid(fluid: number, maxOps: number): void {
    const queue = fluid === B.LAVA ? this.lavaQueue : this.waterQueue;
    const queued = fluid === B.LAVA ? this.lavaQueued : this.waterQueued;
    // walk a snapshot of the queue by index (Array.shift is O(n) per pop);
    // cells scheduled meanwhile append behind it and wait for the next step,
    // so a flood advances one block per step like vanilla's scheduled ticks
    const n = Math.min(queue.length, maxOps);
    for (let i = 0; i < n; i++) {
      const key = queue[i];
      queued.delete(key);
      const c1 = key.indexOf(','), c2 = key.indexOf(',', c1 + 1);
      this.updateFluidCell(fluid, +key.slice(0, c1), +key.slice(c1 + 1, c2), +key.slice(c2 + 1));
    }
    queue.splice(0, n);
  }

  /** Forget pending updates (dimension switch: the keys belong to the old one). */
  private clearFluidQueues(): void {
    this.waterQueue.length = 0; this.waterQueued.clear();
    this.lavaQueue.length = 0; this.lavaQueued.clear();
  }

  private levelsFor(fluid: number): Map<string, number> {
    return fluid === B.LAVA ? this.lavaLevels : this.waterLevels;
  }

  /** Vanilla amount: 8 for a source or a falling cell, 8 - level when
   *  flowing, 0 when the fluid isn't there. */
  private fluidAmount(fluid: number, x: number, y: number, z: number): number {
    if (this.getBlock(x, y, z) !== fluid) return 0;
    const l = this.levelsFor(fluid).get(`${x},${y},${z}`);
    return l === undefined || l >= World.FALLING ? 8 : 8 - l;
  }

  private isFluidSource(fluid: number, x: number, y: number, z: number): boolean {
    return this.getBlock(x, y, z) === fluid && !this.levelsFor(fluid).has(`${x},${y},${z}`);
  }

  /** Can fluid flow into a cell holding `id` (air or a block it washes away)? */
  private canHoldFluid(id: number): boolean {
    return id === B.AIR || FLUID_WASHABLE.has(id);
  }

  /**
   * Vanilla getNewLiquid: what this cell's fluid should be from its
   * neighbours. -1 = none, 0 = source (2+ water sources beside it over a
   * solid block or a source: infinite water), 8 = falling, else 1..7.
   */
  private newLiquid(fluid: number, x: number, y: number, z: number): number {
    let maxAmt = 0, sources = 0;
    for (const [dx, dz] of World.DIRS) {
      const a = this.fluidAmount(fluid, x + dx, y, z + dz);
      if (a === 0) continue;
      if (this.isFluidSource(fluid, x + dx, y, z + dz)) sources++;
      if (a > maxAmt) maxAmt = a;
    }
    if (fluid === B.WATER && sources >= 2) {
      const below = this.getBlock(x, y - 1, z);
      if (isSolid(below) || this.isFluidSource(B.WATER, x, y - 1, z)) return 0;
    }
    if (this.getBlock(x, y + 1, z) === fluid) return World.FALLING;
    const k = maxAmt - this.dropOff(fluid);
    return k <= 0 ? -1 : 8 - k;
  }

  /** One scheduled fluid tick at a cell (vanilla FlowingFluid.tick). */
  private updateFluidCell(fluid: number, x: number, y: number, z: number): void {
    if (this.getBlock(x, y, z) !== fluid) return;
    if (fluid === B.LAVA && this.hardenLava(x, y, z)) return;
    const key = `${x},${y},${z}`;
    const levels = this.levelsFor(fluid);
    let level = levels.get(key) ?? 0;
    if (level !== 0) {
      const nl = this.newLiquid(fluid, x, y, z);
      if (nl < 0) { this.setBlock(x, y, z, B.AIR); return; } // dries up; setBlock wakes the neighbours
      if (nl !== level) {
        if (nl === 0) levels.delete(key); else levels.set(key, nl);
        this.fluidLevelChanged(x, y, z);
        level = nl;
      }
    }
    this.spreadFluid(fluid, x, y, z, level);
  }

  /** A fluid cell's level changed in place: remesh it and wake its neighbours. */
  private fluidLevelChanged(x: number, y: number, z: number): void {
    const cx = Math.floor(x / CX), cz = Math.floor(z / CZ);
    const lx = x - cx * CX, lz = z - cz * CZ;
    this.markDirty(cx, cz);
    // the surface corners average the neighbouring columns
    if (lx === 0) this.markDirty(cx - 1, cz);
    if (lx === 15) this.markDirty(cx + 1, cz);
    if (lz === 0) this.markDirty(cx, cz - 1);
    if (lz === 15) this.markDirty(cx, cz + 1);
    const id = this.getBlock(x, y, z);
    this.onBlockChanged(x, y, z, id, id); // multiplayer: the cell's new level goes out
    this.fluidNeighbourChanged(x, y, z);
  }

  /** Vanilla spread: down if it can, else (sources, or anything not resting
   *  on more of itself) sideways toward the nearest drop. */
  private spreadFluid(fluid: number, x: number, y: number, z: number, level: number): void {
    const below = this.getBlock(x, y - 1, z);
    if (this.canHoldFluid(below) || (fluid === B.LAVA && below === B.WATER)) {
      this.spreadTo(fluid, x, y - 1, z, World.FALLING, true);
      // a source with 3+ source neighbours also feeds its sides (lake edges)
      if (this.sourceNeighbours(fluid, x, y, z) >= 3) this.spreadToSides(fluid, x, y, z, level);
    } else if (level === 0 || below !== fluid) {
      this.spreadToSides(fluid, x, y, z, level);
    }
  }

  private sourceNeighbours(fluid: number, x: number, y: number, z: number): number {
    let n = 0;
    for (const [dx, dz] of World.DIRS) if (this.isFluidSource(fluid, x + dx, y, z + dz)) n++;
    return n;
  }

  private spreadToSides(fluid: number, x: number, y: number, z: number, level: number): void {
    const amt = level === 0 || level >= World.FALLING ? 8 : 8 - level;
    const k = level >= World.FALLING ? 7 : amt - this.dropOff(fluid);
    if (k <= 0) return;
    // candidates: every side the fluid can pass into (not a source of its
    // own); keep only those with the shortest path to a drop
    let best = 1000;
    let dirs = 0; // bitmask over DIRS
    for (let d = 0; d < 4; d++) {
      const [dx, dz] = World.DIRS[d];
      const nx = x + dx, nz = z + dz;
      if (!this.canPassThrough(fluid, nx, y, nz)) continue;
      const dist = this.isHole(fluid, nx, y - 1, nz) ? 0 : this.slopeDistance(fluid, nx, y, nz, 1, -dx, -dz);
      if (dist < best) { best = dist; dirs = 0; }
      if (dist <= best) dirs |= 1 << d;
    }
    for (let d = 0; d < 4; d++) {
      if (!(dirs & (1 << d))) continue;
      const nx = x + World.DIRS[d][0], nz = z + World.DIRS[d][1];
      const id = this.getBlock(nx, y, nz);
      if (id === fluid || !this.canHoldFluid(id)) continue; // existing fluid re-derives itself
      const nl = this.newLiquid(fluid, nx, y, nz);
      if (nl >= 0) this.spreadTo(fluid, nx, y, nz, nl, false);
    }
  }

  /** Can the fluid pass into this cell at all (free, or flowing — not a
   *  source — of the same fluid)? */
  private canPassThrough(fluid: number, x: number, y: number, z: number): boolean {
    const id = this.getBlock(x, y, z);
    if (id === fluid) return this.levelsFor(fluid).has(`${x},${y},${z}`);
    return this.canHoldFluid(id);
  }

  /** Would fluid standing above this cell fall into it? */
  private isHole(fluid: number, x: number, y: number, z: number): boolean {
    const id = this.getBlock(x, y, z);
    return id === fluid || this.canHoldFluid(id);
  }

  /** Vanilla getSlopeDistance: steps to the nearest drop, searching up to the
   *  fluid's slope-find distance (1000 = none in range). */
  private slopeDistance(fluid: number, x: number, y: number, z: number, depth: number, backX: number, backZ: number): number {
    let best = 1000;
    for (const [dx, dz] of World.DIRS) {
      if (dx === backX && dz === backZ) continue;
      const nx = x + dx, nz = z + dz;
      if (!this.canPassThrough(fluid, nx, y, nz)) continue;
      if (this.isHole(fluid, nx, y - 1, nz)) return depth;
      if (depth < this.slopeFindDistance(fluid)) {
        const d = this.slopeDistance(fluid, nx, y, nz, depth + 1, -dx, -dz);
        if (d < best) best = d;
      }
    }
    return best;
  }

  /** Put fluid into a free cell (washing away what's there). Lava pouring
   *  down onto water turns it to stone. */
  private spreadTo(fluid: number, x: number, y: number, z: number, level: number, down: boolean): void {
    const id = this.getBlock(x, y, z);
    if (fluid === B.LAVA && id === B.WATER) {
      if (down && this.setBlock(x, y, z, B.STONE)) this.onFluidFizz(x, y, z);
      return;
    }
    if (!this.canHoldFluid(id)) return;
    if (id !== B.AIR) this.onFluidWash(x, y, z, id, fluid);
    const levels = this.levelsFor(fluid);
    const key = `${x},${y},${z}`;
    if (level === 0) levels.delete(key); else levels.set(key, level);
    if (!this.setBlock(x, y, z, fluid)) levels.delete(key);
  }

  /** Vanilla FlowingFluid.getFlow: the direction the surface runs at this
   *  fluid cell (unit-ish xz, plus a downward pull in a falling column
   *  pressed against a wall). Zero for still water. */
  fluidFlow(fluid: number, x: number, y: number, z: number, out: { x: number; y: number; z: number }): void {
    out.x = 0; out.y = 0; out.z = 0;
    if (this.getBlock(x, y, z) !== fluid) return;
    const own = this.fluidHeight(fluid, x, y, z);
    for (const [dx, dz] of World.DIRS) {
      const nx = x + dx, nz = z + dz;
      const nid = this.getBlock(nx, y, nz);
      let diff = 0;
      if (nid === fluid) diff = own - this.fluidHeight(fluid, nx, y, nz);
      else if (nid === B.AIR || FLUID_WASHABLE.has(nid)) {
        // open neighbour: water runs toward it if it pours off a ledge there
        if (this.getBlock(nx, y - 1, nz) === fluid) diff = own - (this.fluidHeight(fluid, nx, y - 1, nz) - 8 / 9);
      }
      out.x += dx * diff; out.z += dz * diff;
    }
    const lvl = this.levelsFor(fluid).get(`${x},${y},${z}`);
    if (lvl !== undefined && lvl >= World.FALLING) {
      for (const [dx, dz] of World.DIRS) {
        if (isSolid(this.getBlock(x + dx, y, z + dz)) || isSolid(this.getBlock(x + dx, y + 1, z + dz))) { out.y = -6; break; }
      }
    }
    const len = Math.hypot(out.x, out.y, out.z);
    if (len > 1e-6) { out.x /= len; out.y /= len; out.z /= len; }
  }

  /** Surface height of a fluid cell (vanilla getOwnHeight: amount / 9). */
  private fluidHeight(fluid: number, x: number, y: number, z: number): number {
    return this.fluidAmount(fluid, x, y, z) / 9;
  }

  markDirty(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    const c = this.chunks.get(key);
    if (c && c.ready) {
      c.dirty = true;
      this.dirtySet.add(key);
    }
  }

  /** A chunk is meshable when all 8 neighbours are generated: the mesher
   *  reads the whole 3x3 block (AO at the corners, sky/torch light spilling
   *  diagonally), so meshing earlier would bake wrong corners and need a
   *  remesh when the diagonal arrives. */
  neighborsReady(cx: number, cz: number): boolean {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const c = this.chunks.get(chunkKey(cx + dx, cz + dz));
        if (!c || !c.ready) return false;
      }
    }
    return true;
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
    this.lastPcx = pcx; this.lastPcz = pcz;
    if (this.genQueue.length) {
      // re-prioritise by the current distance (entries go stale as you move)
      for (const j of this.genQueue) {
        const dx = j.cx - pcx, dz = j.cz - pcz;
        j.d = dx * dx + dz * dz;
      }
      this.genQueue.sort((a, b) => a.d - b.d);
      const pool = this.ensureGenWorkers();
      const maxInFlight = pool ? pool.length * 2 : 0;
      const t0 = performance.now();
      while (this.genQueue.length && performance.now() - t0 < budgetMs) {
        if (pool && this.genInFlight.size >= maxInFlight) break;
        const job = this.genQueue.shift()!;
        const key = chunkKey(job.cx, job.cz);
        if (job.d > R * R + 1) { this.queued.delete(key); continue; } // player moved away
        const saved = this.savedChunks.get(key);
        if (!saved && pool) {
          // off-thread: stays in `queued` until the result is installed
          const id = ++this.genJobId;
          this.genInFlight.set(key, id);
          pool[this.genRR++ % pool.length].postMessage({ type: 'job', job: { id, cx: job.cx, cz: job.cz, dim: this.dimension } });
          continue;
        }
        this.queued.delete(key);
        const chunk = new Chunk(job.cx, job.cz);
        if (saved) {
          chunk.data = decodeSaved(saved, chunk.data.length);
      chunk.version = nextChunkVersion();
          chunk.computeHeightmap();
          chunk.scanTorches();
          chunk.ready = true;
          chunk.modified = true;
        } else {
          this.generator.generate(chunk);
          this.generator.drainStates(this);
        }
        this.installChunk(key, chunk);
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
        this.chunksChanged();
        this.dirtySet.delete(key);
        this.onChunkRemoved(key);
      }
    }
  }

  /** Register a freshly generated/loaded chunk. Its neighbours need no
   *  remesh: a chunk only meshes once all 8 neighbours exist (see
   *  neighborsReady), so none of them was meshed without this one — they are
   *  either still waiting in dirtySet or were meshed while an identical copy
   *  of it was loaded. */
  private installChunk(key: string, chunk: Chunk): void {
    this.chunks.set(key, chunk);
    this.chunksChanged();
    this.dirtySet.add(key);
    this.scanRedstoneInChunk(chunk);
    this.onChunkInstalled(chunk.cx, chunk.cz);
  }

  /** Lazily start the generation workers (null when Workers are unavailable). */
  private ensureGenWorkers(): Worker[] | null {
    if (this.genWorkersTried) return this.genWorkers;
    this.genWorkersTried = true;
    if (typeof Worker === 'undefined' || typeof window === 'undefined') return null;
    try {
      const n = (navigator.hardwareConcurrency ?? 2) >= 6 ? 2 : 1;
      const pool: Worker[] = [];
      for (let i = 0; i < n; i++) {
        const w = new Worker(new URL('./gen-worker.ts', import.meta.url), { type: 'module' });
        w.postMessage({ type: 'init', seed: this.seed });
        w.onmessage = (e: MessageEvent) => { if (e.data?.type === 'done') this.onGenDone(e.data.res as GenResult); };
        w.onerror = () => this.dropGenWorkers();
        pool.push(w);
      }
      this.genWorkers = pool;
    } catch {
      this.genWorkers = null;
    }
    return this.genWorkers;
  }

  /** Worker failure: fall back to synchronous generation and requeue the
   *  in-flight chunks. */
  private dropGenWorkers(): void {
    if (this.genWorkers) for (const w of this.genWorkers) w.terminate();
    this.genWorkers = null;
    for (const key of this.genInFlight.keys()) this.queued.delete(key);
    this.genInFlight.clear();
  }

  private onGenDone(res: GenResult): void {
    const key = chunkKey(res.cx, res.cz);
    if (this.genInFlight.get(key) !== res.id) return; // stale (dimension switch)
    this.genInFlight.delete(key);
    this.queued.delete(key);
    this.genMs = this.genMs * 0.9 + res.ms * 0.1;
    if (res.dim !== this.dimension || this.chunks.has(key)) return; // ensureChunk won the race
    const dx = res.cx - this.lastPcx, dz = res.cz - this.lastPcz;
    const R = this.viewDist + 1;
    if (dx * dx + dz * dz > R * R + 1) return;
    const chunk = new Chunk(res.cx, res.cz);
    chunk.data = res.data;
    chunk.version = nextChunkVersion();
    chunk.heightmap = res.heightmap;
    for (const t of res.torches) chunk.torches.add(t);
    for (const t of res.glowers) chunk.glowers.add(t);
    chunk.tint = res.tint;
    chunk.ready = true;
    // the worker generator's door/torch/bed states + new village spots
    for (const [k, v] of res.doors) if (!this.doorStates.has(k)) this.doorStates.set(k, v);
    for (const [k, v] of res.torchFacings) if (!this.torchFacings.has(k)) this.torchFacings.set(k, v);
    for (const [k, v] of res.beds) if (!this.bedFacings.has(k)) this.bedFacings.set(k, v);
    const vs = this.generator.villageSpawns;
    for (const s of res.spawns) {
      if (!vs.some((o) => o.x === s.x && o.y === s.y && o.z === s.z)) vs.push(s);
    }
    this.installChunk(key, chunk);
  }

  /** A fresh copy of a chunk's per-column biome tint (256 x rgb, index
   *  lz*16+lx), cached on the chunk: tints never change, and computing them
   *  on the main thread costs noise evaluations for every column. */
  columnTints(cx: number, cz: number): Float32Array {
    const c = this.getChunk(cx, cz);
    if (c?.tint) return c.tint.slice();
    const tint = new Float32Array(256 * 3);
    const out = { r: 1, g: 1, b: 1 };
    for (let i = 0; i < 256; i++) {
      this.generator.grassTint(cx * CX + (i & 15), cz * CZ + (i >> 4), out);
      tint[i * 3] = out.r; tint[i * 3 + 1] = out.g; tint[i * 3 + 2] = out.b;
    }
    if (c) c.tint = tint.slice();
    return tint;
  }

  /** Stop background workers (world is being discarded). */
  dispose(): void {
    if (this.genWorkers) for (const w of this.genWorkers) w.terminate();
    this.genWorkers = null;
    this.genInFlight.clear();
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
        // thin blocks are hit by their shape (aim past an open door, at a cart on a rail)
        const shape = this.doorShape(x, y, z, id) ?? this.railShape(x, y, z, id);
        if (!shape) return { x, y, z, nx, ny, nz, id, dist: t };
        // a door leaf / trapdoor only fills part of the cell: aim past it
        // through the open part (vanilla — reach through an open trapdoor)
        const hit = rayBox(ox - x, oy - y, oz - z, dx, dy, dz, shape);
        if (hit && hit.t <= maxDist) return { x, y, z, nx: hit.nx, ny: hit.ny, nz: hit.nz, id, dist: hit.t };
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
    this.chunksChanged();
    this.dirtySet.clear();
    this.genQueue.length = 0;
    this.queued.clear();
    this.genInFlight.clear(); // late worker results for the old dimension are dropped
    this.clearFluidQueues();

    this.dimension = dim;
    this.generator.dimension = dim;
    this.savedChunks = this.dimData[dim].savedChunks;
    this.blockEntities = this.dimData[dim].blockEntities;
    this.doorStates = this.dimData[dim].doorStates;
    this.torchFacings = this.dimData[dim].torchFacings;
    this.bedFacings = this.dimData[dim].bedFacings;
    this.waterLevels = this.dimData[dim].waterLevels;
    this.lavaLevels = this.dimData[dim].lavaLevels;
    this.redstonePower = this.dimData[dim].redstonePower;
    this.redstoneStates = this.dimData[dim].redstoneStates;
    this.pistonFacings = this.dimData[dim].pistonFacings;
    this.redstoneBlocks = this.dimData[dim].redstoneBlocks;
    this.plateBlocks.clear(); // refilled as the new dimension's chunks load
    this.pollBlocks.clear();
  }

  scanRedstoneInChunk(chunk: Chunk): void {
    const bx = chunk.cx * CX, bz = chunk.cz * CZ;
    for (let y = 0; y < CY; y++) {
      for (let z = 0; z < CZ; z++) {
        for (let x = 0; x < CX; x++) {
          const id = chunk.data[x | (z << 4) | (y << 8)];
          if (REDSTONE_IDS.has(id)) {
            this.redstoneBlocks.add(`${bx + x},${y},${bz + z}`);
            if (PLATE_IDS.has(id)) this.plateBlocks.add(`${bx + x},${y},${bz + z}`);
            if (POLL_IDS.has(id)) this.pollBlocks.add(`${bx + x},${y},${bz + z}`);
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
        this.plateBlocks.delete(key);
        this.pollBlocks.delete(key);
      }
    }
  }

  countLoaded(): number { return this.chunks.size; }
}
