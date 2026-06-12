// Run-length chunk compression + promise-wrapped IndexedDB save-slot store.
// (localStorage is deliberately not used: its ~5MB cap is too small for worlds.)

export interface SlotData { id: number; count: number; dur?: number }
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
  inventory: { slots: MaybeSlot[]; selected: number };
  /** chunk key "cx,cz" -> RLE bytes */
  world: Record<string, Uint8Array>;
  blockEntities: Record<string, BlockEntitySave>;
  environment: { dayTime: number };
  /** bed spawn point, if set */
  spawn?: { x: number; y: number; z: number };
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
