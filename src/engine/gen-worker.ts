// Web Worker: runs terrain generation off the main thread. Each worker owns its
// own WorldGenerator (generation is a pure function of seed + dimension +
// chunk coords), generates the chunk column, drains the generator's pending
// door/torch/bed states and any new village spawns, and transfers the block
// data back. World installs the result exactly like its synchronous path.

import { WorldGenerator } from './WorldGenerator';
import type { DoorState } from './World';
import { Chunk } from './Chunk';

export interface GenJob { id: number; cx: number; cz: number; dim: 'overworld' | 'nether'; }
export interface GenResult {
  id: number; cx: number; cz: number; dim: 'overworld' | 'nether'; ms: number;
  data: Uint8Array<ArrayBuffer>; heightmap: Uint8Array<ArrayBuffer>; torches: Uint32Array; glowers: Uint32Array;
  /** biome tint per column: the worker's column cache is warm, the main one isn't */
  tint: Float32Array;
  doors: [string, DoorState][]; torchFacings: [string, number][]; beds: [string, number][];
  spawns: { x: number; y: number; z: number }[];
}

let gen: WorldGenerator | null = null;
let spawnsSent = 0; // village spots are kept (for dedupe); only new ones are sent

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(m: unknown, transfer?: Transferable[]): void;
};

ctx.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === 'init') { gen = new WorldGenerator(msg.seed as number); return; }
  if (msg.type !== 'job' || !gen) return;
  const job = msg.job as GenJob;
  const t0 = performance.now();
  gen.dimension = job.dim;
  const chunk = new Chunk(job.cx, job.cz);
  gen.generate(chunk);
  // collect the generator's side effects through its own drain API
  const sink = { doorStates: new Map<string, DoorState>(), torchFacings: new Map<string, number>(), bedFacings: new Map<string, number>() };
  gen.drainStates(sink);
  const spawns = gen.villageSpawns.slice(spawnsSent);
  spawnsSent = gen.villageSpawns.length;
  const tint = new Float32Array(256 * 3);
  const out = { r: 1, g: 1, b: 1 };
  for (let i = 0; i < 256; i++) {
    gen.grassTint(job.cx * 16 + (i & 15), job.cz * 16 + (i >> 4), out);
    tint[i * 3] = out.r; tint[i * 3 + 1] = out.g; tint[i * 3 + 2] = out.b;
  }
  const torches = Uint32Array.from(chunk.torches);
  const glowers = Uint32Array.from(chunk.glowers);
  const res: GenResult = {
    id: job.id, cx: job.cx, cz: job.cz, dim: job.dim, ms: performance.now() - t0,
    data: chunk.data, heightmap: chunk.heightmap, torches, glowers, tint,
    doors: [...sink.doorStates], torchFacings: [...sink.torchFacings], beds: [...sink.bedFacings],
    spawns,
  };
  ctx.postMessage({ type: 'done', res }, [chunk.data.buffer, chunk.heightmap.buffer, torches.buffer, glowers.buffer, tint.buffer]);
};
