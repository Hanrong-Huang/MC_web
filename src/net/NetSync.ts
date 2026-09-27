// Block-level world sync for multiplayer (see protocol.ts for the model).
//
// Capturing: Game wraps the code paths where *this* player changes the world
// (player update, clicks, their entities' explosions, closing a container) in
// capture(). While a capture is open, every block change (World.onBlockChanged
// → touch) and every write to the per-block state maps (doors, torches, meta,
// redstone, pistons, chests/furnaces, fluid levels — their set/delete are
// wrapped once at start-up) marks that cell. When the outermost capture ends
// the final state of each marked cell is sent. Automata (water, fire spread,
// redstone ticks, crops) run on every client from the same inputs, outside
// any capture, so they never echo.
//
// Applying: remote cells are written back with capture suppressed. The latest
// state of every edited cell is also remembered per chunk and re-applied when
// that chunk (re)loads, which covers edits to chunks this client hadn't
// generated yet and the full edit log the server sends on joining.

import { World } from '../engine/World';
import type { DoorState } from '../engine/World';
import { chunkKey } from '../engine/Chunk';
import { B } from '../engine/Blocks';
import { ChestState, FurnaceState } from '../engine/Inventory';
import type { ChestSave, FurnaceSave } from '../engine/Persistence';
import type { NetClient } from './NetClient';
import type { CellState, Dim } from './protocol';

export interface SyncHooks {
  /** light a tracked fire (so it burns out like a local one); false = not possible */
  ignite(x: number, y: number, z: number): boolean;
  /** re-evaluate redstone around a cell whose state (not id) changed */
  redstoneUpdate(x: number, y: number, z: number): void;
}

type StateMapName = 'doorStates' | 'torchFacings' | 'bedFacings' | 'redstoneStates' | 'pistonFacings' |
  'blockEntities' | 'waterLevels' | 'lavaLevels';
const STATE_MAPS: StateMapName[] = ['doorStates', 'torchFacings', 'bedFacings', 'redstoneStates', 'pistonFacings',
  'blockEntities', 'waterLevels', 'lavaLevels'];

const chunkOf = (k: string): string => {
  const [x, , z] = k.split(',').map(Number);
  return chunkKey(Math.floor(x / 16), Math.floor(z / 16));
};

export class NetSync {
  private depth = 0;
  private applying = false;
  private touched = new Map<string, { d: Dim; k: string }>();
  /** latest known state per cell: dim → chunk key → cell key → state */
  private known: Record<Dim, Map<string, Map<string, CellState>>> = { overworld: new Map(), nether: new Map() };
  /** cells sent / received (debug overlay) */
  sent = 0;
  received = 0;

  constructor(private world: World, private client: NetClient, private hooks: SyncHooks) {
    for (const dim of ['overworld', 'nether'] as const) {
      const data = world.dimData[dim] as unknown as Record<StateMapName, Map<string, unknown>>;
      for (const name of STATE_MAPS) this.wrap(data[name], dim);
    }
  }

  /** Wrap a state map's set/delete so writes inside a capture mark the cell. */
  private wrap(map: Map<string, unknown>, dim: Dim): void {
    const set = map.set.bind(map), del = map.delete.bind(map);
    map.set = (k: string, v: unknown) => { this.mark(dim, k); return set(k, v); };
    map.delete = (k: string) => { this.mark(dim, k); return del(k); };
  }

  private mark(d: Dim, k: string): void {
    if (this.depth > 0 && !this.applying) this.touched.set(`${d}|${k}`, { d, k });
  }

  /** A block changed (World.onBlockChanged). */
  touch(x: number, y: number, z: number): void {
    this.mark(this.world.dimension, `${x},${y},${z}`);
  }

  /** Mark a cell whose contents changed without a map write (a chest's slots). */
  touchKey(k: string): void {
    this.mark(this.world.dimension, k);
  }

  /** Run `fn` as a player-caused change; its touched cells go out at the end. */
  capture<T>(fn: () => T): T {
    this.depth++;
    try { return fn(); } finally {
      this.depth--;
      if (this.depth === 0) this.flush();
    }
  }

  private flush(): void {
    if (!this.touched.size) return;
    const cells: CellState[] = [];
    for (const { d, k } of this.touched.values()) {
      if (d !== this.world.dimension) continue; // crossed a portal mid-action: rare, skipped
      const c = this.snapshot(d, k);
      if (!c) continue;
      cells.push(c);
      this.remember(c);
    }
    this.touched.clear();
    // batches keep each frame well under hosted WebSocket message limits (~1 MiB)
    for (let i = 0; i < cells.length; i += 3000) this.client.send({ t: 'cells', cells: cells.slice(i, i + 3000) });
    this.sent += cells.length;
  }

  /** The full current state of one cell (null if its chunk isn't loaded). */
  private snapshot(d: Dim, k: string): CellState | null {
    const [x, y, z] = k.split(',').map(Number);
    const ch = this.world.chunks.get(chunkKey(Math.floor(x / 16), Math.floor(z / 16)));
    if (!ch || !ch.ready) return null;
    const w = this.world;
    const c: CellState = { d, k, id: w.getBlock(x, y, z) };
    const door = w.doorStates.get(k);
    if (door) c.door = { facing: door.facing, open: !!door.open, hingeRight: !!door.hingeRight, ...(door.top !== undefined ? { top: !!door.top } : {}) };
    const torch = w.torchFacings.get(k);
    if (torch !== undefined) c.torch = torch;
    const meta = w.bedFacings.get(k);
    if (meta !== undefined) c.meta = meta;
    const rs = w.redstoneStates.get(k);
    if (rs) c.rs = JSON.parse(JSON.stringify(rs)) as Record<string, unknown>;
    const piston = w.pistonFacings.get(k);
    if (piston !== undefined) c.piston = piston;
    const be = w.blockEntities.get(k);
    if (be) c.be = be.serialize() as unknown as Record<string, unknown>;
    const water = w.waterLevels.get(k);
    if (water !== undefined) c.water = water;
    const lava = w.lavaLevels.get(k);
    if (lava !== undefined) c.lava = lava;
    return c;
  }

  private remember(c: CellState): void {
    const byChunk = this.known[c.d];
    const ck = chunkOf(c.k);
    let m = byChunk.get(ck);
    if (!m) { m = new Map(); byChunk.set(ck, m); }
    m.set(c.k, c);
  }

  /** Cells from the server (a peer's edits, or the whole log on joining). */
  applyRemote(cells: CellState[]): void {
    for (const c of cells) {
      this.remember(c);
      if (c.d === this.world.dimension) this.applyCell(c);
    }
    this.received += cells.length;
  }

  /** A chunk finished loading: bring its edited cells up to date. */
  onChunkInstalled(cx: number, cz: number): void {
    const m = this.known[this.world.dimension].get(chunkKey(cx, cz));
    if (m) for (const c of m.values()) this.applyCell(c);
  }

  private applyCell(c: CellState): void {
    const [x, y, z] = c.k.split(',').map(Number);
    const w = this.world;
    const ch = w.chunks.get(chunkKey(Math.floor(x / 16), Math.floor(z / 16)));
    const loaded = !!ch && ch.ready;
    this.applying = true;
    try {
      this.setMaps(c);
      if (!loaded) return; // replayed by onChunkInstalled when it loads
      const cur = w.getBlock(x, y, z);
      if (cur !== c.id) {
        if (!(c.id === B.FIRE && this.hooks.ignite(x, y, z))) w.setBlock(x, y, z, c.id);
        // the block-change hook drops stale meta for the replaced block: restore ours
        this.setMaps(c);
      } else {
        // state-only change (door opened, lever flipped, chest filled): remesh + re-power
        w.markDirty(Math.floor(x / 16), Math.floor(z / 16));
        this.hooks.redstoneUpdate(x, y, z);
      }
    } finally {
      this.applying = false;
    }
  }

  private setMaps(c: CellState): void {
    const w = this.world, k = c.k;
    if (c.door) {
      const prev = w.doorStates.get(k);
      const st: DoorState = {
        facing: (c.door.facing & 3) as DoorState['facing'], open: c.door.open, hingeRight: c.door.hingeRight,
        swing: prev?.swing ?? (c.door.open ? 1 : 0),
        ...(prev?.poweredBy !== undefined ? { poweredBy: prev.poweredBy } : {}),
        ...(c.door.top !== undefined ? { top: c.door.top } : {}),
      };
      w.doorStates.set(k, st);
    } else w.doorStates.delete(k);
    if (c.torch !== undefined) w.torchFacings.set(k, c.torch); else w.torchFacings.delete(k);
    if (c.meta !== undefined) w.bedFacings.set(k, c.meta); else w.bedFacings.delete(k);
    if (c.rs) w.redstoneStates.set(k, JSON.parse(JSON.stringify(c.rs))); else w.redstoneStates.delete(k);
    if (c.piston !== undefined) w.pistonFacings.set(k, c.piston); else w.pistonFacings.delete(k);
    if (c.be) {
      const be = c.be as unknown as ChestSave | FurnaceSave;
      w.blockEntities.set(k, be.type === 'chest' ? ChestState.from(be as ChestSave) : FurnaceState.from(be as FurnaceSave));
    } else w.blockEntities.delete(k);
    if (c.water !== undefined) w.waterLevels.set(k, c.water); else w.waterLevels.delete(k);
    if (c.lava !== undefined) w.lavaLevels.set(k, c.lava); else w.lavaLevels.delete(k);
  }
}
