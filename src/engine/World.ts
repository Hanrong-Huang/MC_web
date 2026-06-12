// World: chunk map + streaming, block get/set with dirty propagation,
// DDA voxel raycasting, skylight lookups, and furnace block-entities.

import { Chunk, chunkKey, CX, CZ, CY } from './Chunk';
import { WorldGenerator } from './WorldGenerator';
import { B, isSolid } from './Blocks';
import { BlockEntity } from './Inventory';
import { rleDecode, rleEncode } from './Persistence';

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
