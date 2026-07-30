// Run-length chunk compression + promise-wrapped IndexedDB save-slot store.
// (localStorage is deliberately not used: its ~5MB cap is too small for worlds.)

export interface SlotData { id: number; count: number; dur?: number; mob?: string }
export type MaybeSlot = SlotData | null;

export interface FurnaceSave {
  type?: 'furnace';
  input: MaybeSlot; fuel: MaybeSlot; output: MaybeSlot;
  burn: number; burnTotal: number; cook: number;
}

export interface ChestSave {
  type: 'chest';
  slots: MaybeSlot[];
}

export type BlockEntitySave = FurnaceSave | ChestSave;

export interface SaveState {
  version: number;
  seed: number;
  gameMode: 'survival' | 'creative';
  player: {
    x: number; y: number; z: number;
    pitch: number; yaw: number;
    health: number; hunger: number;
    flying: boolean;
  };
  inventory: { slots: MaybeSlot[]; selected: number; armor?: MaybeSlot[] };
  dimension?: 'overworld' | 'nether';
  /** chunk key "cx,cz" -> RLE bytes */
  world: Record<string, Uint8Array>;
  blockEntities: Record<string, BlockEntitySave>;
  doors?: Record<string, { facing: number; open: boolean; hingeRight: boolean }>;
  torches?: Record<string, number>;
  beds?: Record<string, number>;
  water?: Record<string, number>;
  lava?: Record<string, number>;
  redstonePower?: Record<string, number>;
  redstoneStates?: Record<string, { active: boolean; ticksLeft?: number; facing?: number }>;
  pistonFacings?: Record<string, number>;
  
  worldNether?: Record<string, Uint8Array>;
  blockEntitiesNether?: Record<string, BlockEntitySave>;
  doorsNether?: Record<string, { facing: number; open: boolean; hingeRight: boolean }>;
  torchesNether?: Record<string, number>;
  bedsNether?: Record<string, number>;
  waterNether?: Record<string, number>;
  lavaNether?: Record<string, number>;
  redstonePowerNether?: Record<string, number>;
  redstoneStatesNether?: Record<string, { active: boolean; ticksLeft?: number; facing?: number }>;
  pistonFacingsNether?: Record<string, number>;
  
  environment: { dayTime: number };
  /** queued/known village dwelling spots so villagers repopulate after reload */
  villageSpawns?: { x: number; y: number; z: number }[];
  /** bed spawn point, if set */
  spawn?: { x: number; y: number; z: number };
  /** captured pets following the player (wild mobs are not persisted) */
  pets?: { kind: string; x: number; y: number; z: number; hp: number; sitting: boolean }[];
  /** unlocked advancement ids */
  advancements?: string[];
  lastPlayed: number;
}

// --- RLE codec: stream of [count u16 LE, blockId u8] runs ------------------

export function rleEncode(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const id = data[i];
    let run = 1;
    while (i + run < data.length && data[i + run] === id && run < 0xffff) run++;
    out.push(run & 0xff, (run >> 8) & 0xff, id);
    i += run;
  }
  return new Uint8Array(out);
}

export function rleDecode(buf: Uint8Array, outLen: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(outLen);
  let o = 0;
  for (let i = 0; i + 2 < buf.length + 1 && i + 2 <= buf.length; i += 3) {
    const run = buf[i] | (buf[i + 1] << 8);
    const id = buf[i + 2];
    if (id !== 0) out.fill(id, o, Math.min(outLen, o + run));
    o += run;
    if (o >= outLen) break;
  }
  return out;
}

// --- World file export / import ----------------------------------------------
// A SaveState holds binary RLE chunk blobs (Uint8Array) which JSON can't carry,
// so the per-dimension chunk maps are base64-encoded into a portable .json file
// that can be downloaded and re-imported on another machine/server.

const WORLD_FILE_FORMAT = 'voxelcraft-world';

function u8ToB64(u: Uint8Array): string {
  let s = '';
  const CH = 0x8000; // chunk the String.fromCharCode args to avoid arg-count limits
  for (let i = 0; i < u.length; i += CH) {
    s += String.fromCharCode(...u.subarray(i, i + CH));
  }
  return btoa(s);
}
function b64ToU8(b: string): Uint8Array {
  const s = atob(b);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
function encodeChunks(rec?: Record<string, Uint8Array>): Record<string, string> | undefined {
  if (!rec) return undefined;
  const out: Record<string, string> = {};
  for (const k in rec) out[k] = u8ToB64(rec[k]);
  return out;
}
function decodeChunks(rec?: Record<string, string>): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  if (rec) for (const k in rec) out[k] = b64ToU8(rec[k]);
  return out;
}

/** Serialize a saved world to a downloadable Blob (JSON with base64 chunks). */
export function exportWorld(slot: string, state: SaveState): Blob {
  const envelope = {
    format: WORLD_FILE_FORMAT,
    fileVersion: 1,
    slot,
    state: {
      ...state,
      world: encodeChunks(state.world),
      worldNether: encodeChunks(state.worldNether),
    },
  };
  return new Blob([JSON.stringify(envelope)], { type: 'application/json' });
}

/** Parse a world file produced by exportWorld back into a slot name + SaveState. */
export function importWorld(text: string): { slot: string; state: SaveState } {
  const env = JSON.parse(text) as {
    format?: string; slot?: string;
    state?: SaveState & { world?: Record<string, string>; worldNether?: Record<string, string> };
  };
  if (!env || env.format !== WORLD_FILE_FORMAT || !env.state) {
    throw new Error('Not a Voxelcraft world file');
  }
  const s = env.state;
  const state: SaveState = {
    ...(s as unknown as SaveState),
    world: decodeChunks(s.world as unknown as Record<string, string>),
    worldNether: s.worldNether
      ? decodeChunks(s.worldNether as unknown as Record<string, string>)
      : undefined,
  };
  return { slot: typeof env.slot === 'string' && env.slot ? env.slot : 'Imported World', state };
}

// --- IndexedDB ---------------------------------------------------------------

const DB_NAME = 'voxelcraft';
const STORE = 'saves';

export interface SaveSummary {
  slot: string;
  lastPlayed: number;
  gameMode: string;
  seed: number;
}

export class SaveDB {
  private db: IDBDatabase | null = null;

  private open(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => { this.db = req.result; resolve(req.result); };
      req.onerror = () => reject(req.error);
    });
  }

  async save(slot: string, state: SaveState): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(state, slot);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async load(slot: string): Promise<SaveState | null> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(slot);
      req.onsuccess = () => resolve((req.result as SaveState) ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async delete(slot: string): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(slot);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async list(): Promise<SaveSummary[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const store = db.transaction(STORE, 'readonly').objectStore(STORE);
      const keysReq = store.getAllKeys();
      const valsReq = store.getAll();
      let keys: IDBValidKey[] | null = null;
      let vals: SaveState[] | null = null;
      const done = () => {
        if (keys && vals) {
          resolve(keys.map((k, i) => ({
            slot: String(k),
            lastPlayed: vals![i]?.lastPlayed ?? 0,
            gameMode: vals![i]?.gameMode ?? 'survival',
            seed: vals![i]?.seed ?? 0,
          })));
        }
      };
      keysReq.onsuccess = () => { keys = keysReq.result; done(); };
      valsReq.onsuccess = () => { vals = valsReq.result; done(); };
      keysReq.onerror = () => reject(keysReq.error);
      valsReq.onerror = () => reject(valsReq.error);
    });
  }
}
