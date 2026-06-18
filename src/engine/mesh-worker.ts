// Web Worker: runs the pure-logic chunk mesher off the main thread. It rebuilds
// lightweight World/Chunk/Atlas shims from a serialized snapshot and calls the
// exact same buildChunkGeometry the main thread's sync fallback would, then
// transfers the raw geometry arrays back.

import { buildChunkGeometry } from './Mesher';
import type { MeshWorld, MeshChunk, MeshDoor, MeshRedstone, GeoArrays } from './Mesher';
import { B } from './Blocks';
import { CX, CY, chunkKey } from './Chunk';

export interface MeshChunkSnap {
  cx: number; cz: number;
  data: Uint8Array; heightmap: Uint8Array;
  torches: Uint32Array; glowers: Uint32Array;
}
export interface MeshJob {
  id: number; key: string; cx: number; cz: number;
  chunks: (MeshChunkSnap | null)[]; // 9, index (dz+1)*3+(dx+1)
  tint: Float32Array;               // 256*3
  torchFacings: [string, number][];
  doorStates: [string, MeshDoor][];
  redstoneStates: [string, MeshRedstone][];
  redstonePower: [string, number][];
  waterLevels: [string, number][];
  lavaLevels: [string, number][];
}

type Rects = Record<string, { u0: number; v0: number; u1: number; v1: number }>;
let RECTS: Rects = {};
const atlasShim = { rect: (name: string) => RECTS[name] };

function makeChunk(s: MeshChunkSnap): MeshChunk {
  return {
    cx: s.cx, cz: s.cz, ready: true,
    data: s.data, heightmap: s.heightmap,
    torches: new Set<number>(s.torches), glowers: new Set<number>(s.glowers),
    skyLight(lx: number, y: number, lz: number): number {
      const h = s.heightmap[lz * CX + lx];
      if (y >= h) return 1;
      return Math.max(0.25, 1 - 0.1 * (h - y));
    },
  };
}

function makeWorld(job: MeshJob): MeshWorld {
  const byKey = new Map<string, MeshChunk>();
  for (const snap of job.chunks) if (snap) byKey.set(chunkKey(snap.cx, snap.cz), makeChunk(snap));
  const bx = job.cx * CX, bz = job.cz * CX;
  const torchFacings = new Map(job.torchFacings);
  const doorStates = new Map(job.doorStates);
  const redstoneStates = new Map(job.redstoneStates);
  const redstonePower = new Map(job.redstonePower);
  const waterLevels = new Map(job.waterLevels);
  const lavaLevels = new Map(job.lavaLevels);
  const getChunk = (cx: number, cz: number) => byKey.get(chunkKey(cx, cz));
  const getBlock = (wx: number, y: number, wz: number): number => {
    if (y < 0) return B.BEDROCK;
    if (y >= CY) return B.AIR;
    const c = getChunk(Math.floor(wx / CX), Math.floor(wz / CX));
    if (!c) return B.STONE;
    return c.data[(wx & 15) | ((wz & 15) << 4) | (y << 8)];
  };
  const fluid = (m: Map<string, number>, f: number, wx: number, y: number, wz: number) =>
    getBlock(wx, y + 1, wz) === f ? 0 : (m.get(`${wx},${y},${wz}`) ?? 0);
  return {
    getChunk,
    getBlockForMesh: getBlock,
    waterLevel: (wx, y, wz) => fluid(waterLevels, B.WATER, wx, y, wz),
    lavaLevel: (wx, y, wz) => fluid(lavaLevels, B.LAVA, wx, y, wz),
    doorStateAt: (wx, y, wz) => {
      const here = doorStates.get(`${wx},${y},${wz}`);
      if (here) return here;
      const id = getBlock(wx, y, wz);
      if (id === B.DOOR_UPPER) return doorStates.get(`${wx},${y - 1},${wz}`);
      if (id === B.DOOR_LOWER) return doorStates.get(`${wx},${y + 1},${wz}`);
      return undefined;
    },
    doorStates, torchFacings, redstoneStates, redstonePower,
    generator: {
      grassTint: (wx, wz, out) => {
        const i = ((wz - bz) * CX + (wx - bx)) * 3;
        out.r = job.tint[i]; out.g = job.tint[i + 1]; out.b = job.tint[i + 2];
      },
    },
  };
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(m: unknown, transfer?: Transferable[]): void;
};

ctx.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === 'init') { RECTS = msg.rects as Rects; return; }
  if (msg.type !== 'job') return;
  const job: MeshJob = msg.job;
  const t0 = performance.now();
  const center = makeChunk(job.chunks[4]!); // index 4 = local (0,0)
  const out = buildChunkGeometry(makeWorld(job), center, atlasShim);
  const transfers: Transferable[] = [];
  const pack = (g: GeoArrays | null): GeoArrays | null => {
    if (!g) return null;
    transfers.push(g.positions.buffer, g.lights.buffer, g.tints.buffer, g.uvs.buffer, g.indices.buffer);
    return g;
  };
  ctx.postMessage(
    { type: 'done', id: job.id, key: job.key, cx: job.cx, cz: job.cz, ms: performance.now() - t0, solid: pack(out.solid), water: pack(out.water) },
    transfers,
  );
};
