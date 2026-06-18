// Chunk: 16x16x128 column of block ids packed in a flat Uint8Array,
// plus a heightmap used for the cheap skylight model.

import { B, CROSS_BLOCKS } from './Blocks';

/** Blocks that don't attenuate skylight (ignored by the heightmap). */
function lightTransparent(id: number): boolean {
  return id === B.AIR || id === B.TORCH || id === B.GLASS || CROSS_BLOCKS.has(id);
}

/** Full-block light emitters that feed the block-light flood-fill (alongside torches). */
export function isGlower(id: number): boolean {
  return id === B.GLOWSTONE || id === B.REDSTONE_LAMP_LIT || id === B.MAGMA;
}

export const CX = 16;
export const CZ = 16;
export const CY = 128;
export const CHUNK_VOLUME = CX * CZ * CY; // 32768 bytes

export function chunkKey(cx: number, cz: number): string {
  return `${cx},${cz}`;
}

export function blockIndex(x: number, y: number, z: number): number {
  return x | (z << 4) | (y << 8);
}

export class Chunk {
  readonly cx: number;
  readonly cz: number;
  data = new Uint8Array(CHUNK_VOLUME);
  /** heightmap[z*16+x] = y of first free block above the highest non-air block */
  heightmap = new Uint8Array(CX * CZ);
  /** packed local indices of torch blocks (light sources) */
  torches = new Set<number>();
  /** packed local indices of full-block light emitters (glowstone, lit lamp) */
  glowers = new Set<number>();
  /** needs remesh */
  dirty = true;
  /** edited since generation (must be persisted) */
  modified = false;
  /** generation finished */
  ready = false;

  constructor(cx: number, cz: number) {
    this.cx = cx;
    this.cz = cz;
  }

  get(x: number, y: number, z: number): number {
    if (y < 0) return B.BEDROCK;
    if (y >= CY) return B.AIR;
    return this.data[x | (z << 4) | (y << 8)];
  }

  set(x: number, y: number, z: number, id: number): void {
    if (y < 0 || y >= CY) return;
    const idx = x | (z << 4) | (y << 8);
    const old = this.data[idx];
    if (old === B.TORCH) this.torches.delete(idx);
    if (id === B.TORCH) this.torches.add(idx);
    if (isGlower(old)) this.glowers.delete(idx);
    if (isGlower(id)) this.glowers.add(idx);
    this.data[idx] = id;
    this.updateColumnHeight(x, z);
  }

  /** Raw write during generation (no heightmap upkeep; call computeHeightmap after). */
  setRaw(x: number, y: number, z: number, id: number): void {
    if (y < 0 || y >= CY) return;
    this.data[x | (z << 4) | (y << 8)] = id;
  }

  updateColumnHeight(x: number, z: number): void {
    let y = CY - 1;
    const colBase = x | (z << 4);
    while (y >= 0 && lightTransparent(this.data[colBase | (y << 8)])) y--;
    this.heightmap[z * CX + x] = y + 1;
  }

  computeHeightmap(): void {
    for (let z = 0; z < CZ; z++) {
      for (let x = 0; x < CX; x++) this.updateColumnHeight(x, z);
    }
  }

  /** Rebuild the torch + glower indices after bulk data writes (generation / save load). */
  scanTorches(): void {
    this.torches.clear();
    this.glowers.clear();
    for (let i = 0; i < this.data.length; i++) {
      const id = this.data[i];
      if (id === B.TORCH) this.torches.add(i);
      else if (isGlower(id)) this.glowers.add(i);
    }
  }

  /** Sky exposure factor in [0.25, 1] for the cheap smooth-lighting model. */
  skyLight(x: number, y: number, z: number): number {
    const h = this.heightmap[z * CX + x];
    if (y >= h) return 1;
    const depth = h - y;
    return Math.max(0.25, 1 - 0.1 * depth);
  }
}
