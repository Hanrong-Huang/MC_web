// Face-culled chunk meshing with Minecraft-style per-face shading, per-vertex
// ambient occlusion, flood-filled skylight (15 levels, spilling under overhangs
// and into cave mouths) and BFS flood-fill torch light.
// Each vertex carries a 2-channel "alight" attribute: x = sky-lit component
// (scaled by the day/night uniform in the shader), y = torch-lit component.
// The torch channel also smuggles a small per-vertex flag (+2 = sway in the
// wind, +4 = self-lit animated lava) that the vertex shader strips off, so the
// light model stays 2-channel without another attribute.

import { CX, CZ, CY } from './Chunk';
import { B, def, hasDef, OPAQUE_LUT, OCCLUDE_LUT, CROSS_BLOCKS, TINTED_TILES } from './Blocks';
import type { UVRect } from './Textures';

// Minimal structural views of world/chunk/atlas so the mesher is pure logic and
// can run either on the main thread (real World/Chunk/Atlas) or in a Web Worker
// (lightweight shims rebuilt from a serialized snapshot). No THREE here, so the
// worker bundle stays small.
interface ReadMap<T> { get(key: string): T | undefined; }
export interface MeshChunk {
  cx: number; cz: number;
  ready: boolean;
  data: Uint8Array;
  heightmap: ArrayLike<number>;
  skyLight(lx: number, y: number, lz: number): number;
  torches: Set<number>;
  glowers: Set<number>;
}
export interface MeshDoor { facing: number; hingeRight?: boolean; swing?: number; open?: boolean; }
export interface MeshRedstone { active?: boolean; facing?: number; }
export interface MeshWorld {
  getChunk(cx: number, cz: number): MeshChunk | undefined;
  getBlockForMesh(wx: number, wy: number, wz: number): number;
  lavaLevel(wx: number, wy: number, wz: number): number;
  waterLevel(wx: number, wy: number, wz: number): number;
  doorStateAt(wx: number, wy: number, wz: number): MeshDoor | undefined;
  doorStates: ReadMap<MeshDoor>;
  torchFacings: ReadMap<number>;
  bedFacings: ReadMap<number>;
  redstoneStates: ReadMap<MeshRedstone>;
  redstonePower: ReadMap<number>;
  generator: { grassTint(wx: number, wz: number, out: { r: number; g: number; b: number }): void };
}
export interface MeshAtlas { rect(name: string): UVRect; }

/** Raw geometry arrays for one material (solid or water) — transferable to/from a worker. */
export interface GeoArrays {
  positions: Float32Array; lights: Float32Array; tints: Float32Array;
  uvs: Float32Array; indices: Uint32Array | Uint16Array;
  /** vertical extent of the vertices, for a tight culling volume */
  minY?: number; maxY?: number;
}
export interface ChunkMeshData { solid: GeoArrays | null; water: GeoArrays | null; }

/** Vertex flags packed into the torch channel (see header). */
export const FLAG_SWAY = 2;
export const FLAG_LAVA = 4;

// face order: +x, -x, +y, -y, +z, -z
const FACE_NORMALS = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
] as const;

// per-face shading: top 100%, bottom 50%, z (north/south) 80%, x (east/west) 60%.
// Squared-ish because the shader lights in linear space: a 0.6 multiplier in
// linear reads as ~0.8 on screen, which flattened every hillside.
const FACE_SHADE = [0.6, 0.6, 1.0, 0.5, 0.8, 0.8].map((s) => Math.pow(s, 1.7));
const LIQUID_SOURCE_HEIGHT = 14 / 16;
const LIQUID_EDGE_HEIGHT = 8 / 16;

// origin + tangent axes with u x v = normal (CCW winding seen from outside)
const FACE_GEO: { o: number[]; u: number[]; v: number[] }[] = [
  { o: [1, 0, 1], u: [0, 0, -1], v: [0, 1, 0] }, // +x
  { o: [0, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },  // -x
  { o: [0, 1, 1], u: [1, 0, 0], v: [0, 0, -1] }, // +y
  { o: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1] },  // -y
  { o: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },  // +z
  { o: [1, 0, 0], u: [-1, 0, 0], v: [0, 1, 0] }, // -z
];

const AO_SHADE = [0.36, 0.56, 0.78, 1.0];

/** Light level (0..15) -> brightness, a softened version of Minecraft's
 *  l / (3(1-l) + 1) table so light fades quickly away from torches and into
 *  shade instead of staying flat. */
const LIGHT_CURVE = new Float32Array(16);
for (let i = 0; i < 16; i++) { const l = i / 15; LIGHT_CURVE[i] = l / ((1 - l) * 2.2 + 1); }

// reusable 3x3 per-face light/occlusion sample grids (index (i+1)*3+(j+1)),
// so each face samples the front layer once instead of re-sampling per corner
const SKY9 = new Float32Array(9);
const TORCH9 = new Float32Array(9);
const OCC9 = new Uint8Array(9);
const SOLID9 = new Uint8Array(9);

/** AO level (0..3) for a face corner, read from the shared 3x3 OCC9 grid. */
function aoCorner(a: number, b: number, isLiquid: boolean): number {
  if (isLiquid) return 3;
  const si = a ? 1 : -1, sj = b ? 1 : -1;
  const s1 = OCC9[(si + 1) * 3 + 1];        // along u
  const s2 = OCC9[3 + (sj + 1)];            // along v
  const sc = OCC9[(si + 1) * 3 + (sj + 1)]; // diagonal
  return s1 && s2 ? 0 : 3 - (s1 + s2 + sc);
}

/** Smooth light for one face corner: average the brightness of the non-opaque
 *  cells among the 4 touching it (MC smooth lighting — walls don't count as
 *  dark samples, AO handles the corner darkening). */
function cornerLight(grid: Float32Array, a: number, b: number): number {
  const si = a ? 1 : -1, sj = b ? 1 : -1;
  const iu = (si + 1) * 3 + 1, iv = 3 + (sj + 1), ic = (si + 1) * 3 + (sj + 1);
  let sum = grid[4], n = 1;
  if (!SOLID9[iu]) { sum += grid[iu]; n++; }
  if (!SOLID9[iv]) { sum += grid[iv]; n++; }
  if (!SOLID9[ic] && !(SOLID9[iu] && SOLID9[iv])) { sum += grid[ic]; n++; }
  return sum / n;
}

const TORCH_LEVEL = 14;
const GLOW_LEVEL = 15; // glowstone / lit redstone lamp: full-strength block light
const SKY_LEVEL = 15;

// Shared flood-fill region: the chunk plus a 15-block margin on each side, laid
// out column-major (y innermost) so a column's open sky is one fill() call.
const RX0 = -15, RX1 = 30;
const RW = RX1 - RX0 + 1; // 46
const TORCHR = new Uint8Array(RW * RW * CY);
const SKYR = new Uint8Array(RW * RW * CY);
const QLEN = 1 << 17;
const QUEUE = new Int32Array(QLEN);
const QMASK = QLEN - 1;

function regionIdx(rx: number, rz: number, y: number): number {
  return ((rz - RX0) * RW + (rx - RX0)) * CY + y;
}

// Padded block copy of the chunk + a 1-block rim (18x18 columns, y from -1 to
// CY), so the hot face/AO loop is plain array reads instead of closure calls.
const PW = 18;
const PH = CY + 2;
const PAD = new Uint8Array(PW * PW * PH);
function padIdx(x: number, y: number, z: number): number {
  return ((z + 1) * PW + (x + 1)) * PH + (y + 1);
}

/** Leaf blocks sway gently in the wind. */
const LEAF_LUT = new Uint8Array(256);
for (let id = 1; id < 256; id++) if (hasDef(id) && def(id).name.endsWith('leaves')) LEAF_LUT[id] = 1;

function faceTile(f: NonNullable<ReturnType<typeof def>['faces']>, face: number): string {
  if (face === 2) return f.top;
  if (face === 3) return f.bottom;
  if ((face === 4 || face === 5) && f.front) return f.front;
  return f.sides;
}

// Two reusable growable typed-array pools (solid + water). Meshing is
// synchronous and single-threaded, so the builders keep their grown capacity
// between chunks (no per-chunk number[] churn, no GC spikes) and only the
// final exact-size slices are allocated (and transferred by the worker).
interface Pool { pos: Float32Array; lit: Float32Array; tint: Float32Array; uv: Float32Array; idx: Uint32Array; }
const GEO_POOLS: Pool[] = [0, 1].map(() => ({
  pos: new Float32Array(3 * 8192), lit: new Float32Array(2 * 8192), tint: new Float32Array(3 * 8192),
  uv: new Float32Array(2 * 8192), idx: new Uint32Array(12288),
}));

export class GeoBuilder {
  private p: Pool;
  vertCount = 0;
  idxCount = 0;

  constructor(poolIdx: number) {
    this.p = GEO_POOLS[poolIdx];
  }

  private growVerts(): void {
    const p = this.p;
    const grow = <T extends Float32Array>(a: T, k: number): T => {
      const n = new Float32Array(a.length * 2) as T;
      n.set(a.subarray(0, this.vertCount * k));
      return n;
    };
    p.pos = grow(p.pos, 3); p.lit = grow(p.lit, 2); p.tint = grow(p.tint, 3); p.uv = grow(p.uv, 2);
  }

  /** Append one vertex: position, sky/torch light, rgb tint, uv. */
  v(px: number, py: number, pz: number, sky: number, torch: number,
    r: number, g: number, b: number, u: number, vv: number): void {
    const p = this.p;
    const n = this.vertCount;
    if ((n + 1) * 3 > p.pos.length) this.growVerts();
    const P = this.p;
    P.pos[n * 3] = px; P.pos[n * 3 + 1] = py; P.pos[n * 3 + 2] = pz;
    P.lit[n * 2] = sky; P.lit[n * 2 + 1] = torch;
    P.tint[n * 3] = r; P.tint[n * 3 + 1] = g; P.tint[n * 3 + 2] = b;
    P.uv[n * 2] = u; P.uv[n * 2 + 1] = vv;
    this.vertCount = n + 1;
  }

  /** Append two triangles (6 indices). */
  tri2(a: number, b: number, c: number, d: number, e: number, f: number): void {
    const p = this.p;
    if (this.idxCount + 6 > p.idx.length) {
      const n = new Uint32Array(p.idx.length * 2);
      n.set(p.idx.subarray(0, this.idxCount));
      p.idx = n;
    }
    const i = this.idxCount, I = p.idx;
    I[i] = a; I[i + 1] = b; I[i + 2] = c; I[i + 3] = d; I[i + 4] = e; I[i + 5] = f;
    this.idxCount = i + 6;
  }

  build(): GeoArrays | null {
    if (this.vertCount === 0) return null;
    const p = this.p, n = this.vertCount;
    // 16-bit indices whenever they fit: half the index upload for most chunks
    const indices = n <= 65535 ? Uint16Array.from(p.idx.subarray(0, this.idxCount)) : p.idx.slice(0, this.idxCount);
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < n * 3; i += 3) { const y = p.pos[i]; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    return {
      minY, maxY,
      positions: p.pos.slice(0, n * 3),
      lights: p.lit.slice(0, n * 2),
      tints: p.tint.slice(0, n * 3),
      uvs: p.uv.slice(0, n * 2),
      indices,
    };
  }
}

// Per-id block kind: 0 = air, 1 = plain cube (opaque / cutout / liquid), 2 =
// special model (torch, door, bed, plants, ...) handled by its own emitter.
const KIND = new Int8Array(256).fill(-1);
function kindOf(id: number): number {
  let k = KIND[id];
  if (k < 0) {
    k = id === B.AIR ? 0
      : (id === B.TORCH || id === B.DOOR_LOWER || id === B.DOOR_UPPER || id === B.LADDER ||
        id === B.BED || id === B.BED_HEAD || id === B.TRAPDOOR || id === B.PRESSURE_PLATE ||
        id === B.LEVER || id === B.WOODEN_BUTTON || id === B.STONE_BUTTON ||
        id === B.REDSTONE_WIRE || CROSS_BLOCKS.has(id)) ? 2 : 1;
    KIND[id] = k;
  }
  return k;
}

// per (block, face) atlas rect + biome-tint flag, rebuilt if the atlas changes
let rectAtlas: MeshAtlas | null = null;
const FACE_RECT: (UVRect | undefined)[] = new Array(256 * 6);
const FACE_TINTED = new Uint8Array(256 * 6);
function faceRect(atlas: MeshAtlas, id: number, face: number): UVRect {
  if (atlas !== rectAtlas) { rectAtlas = atlas; FACE_RECT.fill(undefined); }
  const k = id * 6 + face;
  let r = FACE_RECT[k];
  if (!r) {
    const tile = faceTile(def(id).faces!, face);
    r = atlas.rect(tile);
    FACE_RECT[k] = r;
    FACE_TINTED[k] = TINTED_TILES.has(tile) ? 1 : 0;
  }
  return r;
}

// pad-array offsets for the six face neighbours (+x, -x, +y, -y, +z, -z)
const PAD_STEP = [PH, -PH, 1, -1, PW * PH, -PW * PH];

// per-chunk column tint cache (biome grass/foliage color)
const TINT_CACHE = new Float32Array(256 * 3);
const TINT_SET = new Uint8Array(256);
const tintScratch = { r: 1, g: 1, b: 1 };
const WHITE = new Float32Array([1, 1, 1]);

/** BFS-propagate levels already seeded in `arr` (queue holds the seeds). */
function floodFill(arr: Uint8Array, refs: (MeshChunk | undefined)[], qTail: number, waterCost: number): void {
  let qHead = 0;
  const chunkAt = (rx: number, rz: number): MeshChunk | undefined =>
    refs[(rx >> 4) + 1 + ((rz >> 4) + 1) * 3];
  while (qHead !== qTail) {
    const ri = QUEUE[qHead]; qHead = (qHead + 1) & QMASK;
    const level = arr[ri];
    if (level <= 1) continue;
    const y = ri % CY;
    const col = (ri - y) / CY;
    const rx = (col % RW) + RX0;
    const rz = ((col / RW) | 0) + RX0;
    for (let d = 0; d < 6; d++) {
      let nx = rx, ny = y, nz = rz;
      if (d === 0) nx++; else if (d === 1) nx--; else if (d === 2) ny++;
      else if (d === 3) ny--; else if (d === 4) nz++; else nz--;
      if (nx < RX0 || nx > RX1 || nz < RX0 || nz > RX1 || ny < 0 || ny >= CY) continue;
      const c = chunkAt(nx, nz);
      if (!c) continue;
      const id = c.data[(nx & 15) | ((nz & 15) << 4) | (ny << 8)];
      if (OPAQUE_LUT[id]) continue;
      const nl = level - 1 - (id === B.WATER ? waterCost : 0);
      // prune: light that can no longer reach the meshed box (chunk + 1-block
      // rim) by manhattan distance can't affect any sampled cell
      const ox = nx < -1 ? -1 - nx : nx > 16 ? nx - 16 : 0;
      const oz = nz < -1 ? -1 - nz : nz > 16 ? nz - 16 : 0;
      if (nl <= ox + oz) continue;
      const ni = ri + (nx - rx) * CY + (nz - rz) * RW * CY + (ny - y);
      if (arr[ni] >= nl) continue;
      arr[ni] = nl;
      if (((qTail + 1) & QMASK) !== qHead) { QUEUE[qTail] = ni; qTail = (qTail + 1) & QMASK; }
    }
  }
}

export function buildChunkGeometry(world: MeshWorld, chunk: MeshChunk, atlas: MeshAtlas): ChunkMeshData {
  const solid = new GeoBuilder(0);
  const water = new GeoBuilder(1);
  const bx = chunk.cx * CX, bz = chunk.cz * CZ;
  // top of the tallest non-air block: the heightmap ignores light-transparent
  // blocks (glass, torches, plants), so it can't bound the mesh on its own
  let maxY = 1;
  for (let y = CY - 1; y > 0; y--) {
    const row = y << 8;
    let any = false;
    for (let i = 0; i < 256; i++) if (chunk.data[row | i] !== B.AIR) { any = true; break; }
    if (any) { maxY = y + 1; break; }
  }
  maxY = Math.min(CY, maxY + 1);

  // cache the 3x3 chunk neighborhood for fast lookups
  const refs: (MeshChunk | undefined)[] = [];
  for (let cz = -1; cz <= 1; cz++) {
    for (let cx = -1; cx <= 1; cx++) {
      const c = world.getChunk(chunk.cx + cx, chunk.cz + cz);
      refs.push(c && c.ready ? c : undefined);
    }
  }
  const chunkAt = (rx: number, rz: number): MeshChunk | undefined =>
    refs[(rx >> 4) + 1 + ((rz >> 4) + 1) * 3];

  // --- padded block copy (chunk + 1-block rim) --------------------------------
  const padTop = Math.min(CY, maxY + 1);
  for (let z = -1; z <= 16; z++) {
    for (let x = -1; x <= 16; x++) {
      const c = chunkAt(x, z);
      const base = padIdx(x, 0, z);
      PAD[base - 1] = B.BEDROCK; // y = -1
      if (!c) { PAD.fill(B.STONE, base, base + padTop); } // unloaded frontier reads as opaque
      else {
        const col = (x & 15) | ((z & 15) << 4);
        const d = c.data;
        for (let y = 0; y < padTop; y++) PAD[base + y] = d[col | (y << 8)];
      }
      PAD.fill(B.AIR, base + padTop, base + CY + 1);
    }
  }
  const get = (x: number, y: number, z: number): number => {
    if (x >= -1 && x <= 16 && z >= -1 && z <= 16) {
      if (y < -1) return B.BEDROCK;
      if (y > CY) return B.AIR;
      return PAD[padIdx(x, y, z)];
    }
    if (y < 0) return B.BEDROCK;
    if (y >= CY) return B.AIR;
    return world.getBlockForMesh(bx + x, y, bz + z);
  };
  const liquidCellHeight = (id: number, x: number, y: number, z: number): number => {
    if (get(x, y, z) !== id) return 0;
    if (get(x, y + 1, z) === id) return 1;
    const wx = bx + x, wz = bz + z;
    const level = id === B.LAVA ? world.lavaLevel(wx, y, wz) : world.waterLevel(wx, y, wz);
    const maxLevel = id === B.LAVA ? 3 : 7;
    if (level <= 0) return LIQUID_SOURCE_HEIGHT;
    return LIQUID_SOURCE_HEIGHT - (LIQUID_SOURCE_HEIGHT - LIQUID_EDGE_HEIGHT) * Math.min(1, level / maxLevel);
  };
  const liquidCornerHeight = (id: number, x: number, y: number, z: number, px: number, pz: number): number => {
    const sx = px < 0.5 ? -1 : 1;
    const sz = pz < 0.5 ? -1 : 1;
    let sum = 0;
    let n = 0;
    for (let k = 0; k < 4; k++) {
      const dx = k === 1 || k === 3 ? sx : 0, dz = k >= 2 ? sz : 0;
      const h = liquidCellHeight(id, x + dx, y, z + dz);
      if (h <= 0) continue;
      sum += h;
      n++;
    }
    return n > 0 ? sum / n : LIQUID_EDGE_HEIGHT;
  };
  /** Water column depth from this cell down (cells of water, capped). */
  const waterDepth = (x: number, y: number, z: number): number => {
    let d = 0;
    while (d < 12 && get(x, y - d, z) === B.WATER) d++;
    return d;
  };

  // biome tint per column, computed lazily
  TINT_SET.fill(0);
  const tintAt = (x: number, z: number): Float32Array => {
    const ci = (x & 15) | ((z & 15) << 4);
    if (!TINT_SET[ci]) {
      TINT_SET[ci] = 1;
      world.generator.grassTint(bx + x, bz + z, tintScratch);
      TINT_CACHE[ci * 3] = tintScratch.r;
      TINT_CACHE[ci * 3 + 1] = tintScratch.g;
      TINT_CACHE[ci * 3 + 2] = tintScratch.b;
    }
    return TINT_CACHE.subarray(ci * 3, ci * 3 + 3);
  };

  // --- skylight flood fill ------------------------------------------------------
  // Every cell at/above a column's heightmap sees the sky (15). Light then spills
  // sideways and down through non-opaque cells, losing a level per block (two in
  // water), so overhangs get soft shade, tree canopies cast a light shadow and
  // caves go dark a few blocks past their mouth.
  SKYR.fill(0);
  let qTail = 0;
  const push = (ri: number): void => { if (qTail < QLEN - 1) QUEUE[qTail++] = ri; };
  const colH = (rx: number, rz: number): number => {
    const c = chunkAt(rx, rz);
    return c ? c.heightmap[(rz & 15) * CX + (rx & 15)] : CY;
  };
  for (let rz = RX0; rz <= RX1; rz++) {
    for (let rx = RX0; rx <= RX1; rx++) {
      if (!chunkAt(rx, rz)) continue;
      const h = colH(rx, rz);
      if (h >= CY) continue;
      const base = regionIdx(rx, rz, 0);
      SKYR.fill(SKY_LEVEL, base + h, base + CY);
      // seed the sky cells that can spill: the lowest one (down into leaves /
      // water) and those beside a taller neighbour column (under its overhang)
      let top = h;
      if (rx > RX0) top = Math.max(top, colH(rx - 1, rz));
      if (rx < RX1) top = Math.max(top, colH(rx + 1, rz));
      if (rz > RX0) top = Math.max(top, colH(rx, rz - 1));
      if (rz < RX1) top = Math.max(top, colH(rx, rz + 1));
      top = Math.min(top, CY);
      for (let y = h; y < top || y === h; y++) push(base + y);
    }
  }
  floodFill(SKYR, refs, qTail, 0);

  // --- block-light flood fill (torches + glowstone/lit lamps) ----------------
  let hasLights = false;
  for (const c of refs) if (c && (c.torches.size > 0 || c.glowers.size > 0)) { hasLights = true; break; }
  if (hasLights) {
    TORCHR.fill(0);
    qTail = 0;
    const seed = (c: MeshChunk, packed: number, level: number): void => {
      const ox = c.cx * CX - bx, oz = c.cz * CZ - bz;
      const rx = ox + (packed & 15), rz = oz + ((packed >> 4) & 15), ry = packed >> 8;
      if (rx < RX0 || rx > RX1 || rz < RX0 || rz > RX1) return;
      const ri = regionIdx(rx, rz, ry);
      if (TORCHR[ri] < level) { TORCHR[ri] = level; push(ri); }
    };
    for (const c of refs) {
      if (!c || (c.torches.size === 0 && c.glowers.size === 0)) continue;
      for (const t of c.torches) seed(c, t, TORCH_LEVEL);
      for (const t of c.glowers) seed(c, t, GLOW_LEVEL); // glowstone/lamp burn a touch brighter
    }
    floodFill(TORCHR, refs, qTail, 0);
  }

  const skyAt = (x: number, y: number, z: number): number => {
    if (y >= CY) return 1;
    if (y < 0 || x < RX0 || x > RX1 || z < RX0 || z > RX1) return 0;
    return LIGHT_CURVE[SKYR[regionIdx(x, z, y)]];
  };
  const torchAt = (x: number, y: number, z: number): number => {
    if (!hasLights || y < 0 || y >= CY || x < RX0 || x > RX1 || z < RX0 || z > RX1) return 0;
    return LIGHT_CURVE[TORCHR[regionIdx(x, z, y)]];
  };

  // --- geometry --------------------------------------------------------------
  for (let y = 0; y < maxY; y++) {
    for (let z = 0; z < CZ; z++) {
      for (let x = 0; x < CX; x++) {
        const pi = padIdx(x, y, z);
        const id = PAD[pi];
        if (id === B.AIR) continue;
        const kind = kindOf(id);
        // buried opaque cube: nothing to draw (the common case, so bail early)
        if (kind === 1 && OPAQUE_LUT[id] &&
          OPAQUE_LUT[PAD[pi + 1]] && OPAQUE_LUT[PAD[pi - 1]] &&
          OPAQUE_LUT[PAD[pi + PH]] && OPAQUE_LUT[PAD[pi - PH]] &&
          OPAQUE_LUT[PAD[pi + PW * PH]] && OPAQUE_LUT[PAD[pi - PW * PH]]) continue;

        if (kind === 2) {

        if (id === B.TORCH) {
          const facing = world.torchFacings.get(`${bx + x},${y},${bz + z}`);
          emitTorch(solid, atlas, x, y, z, skyAt(x, y, z), torchAt(x, y, z), facing);
          continue;
        }
        if (id === B.DOOR_LOWER || id === B.DOOR_UPPER) {
          const st = world.doorStateAt(bx + x, y, bz + z);
          const facing = st?.facing ?? 0;
          const hingeRight = !!st?.hingeRight;
          const swing = st?.swing ?? (st?.open ? 1 : 0);
          emitDoor(solid, atlas, id, x, y, z, facing, hingeRight, swing, skyAt(x, y, z), torchAt(x, y, z));
          continue;
        }
        if (id === B.LADDER) {
          emitLadder(solid, atlas, x, y, z, skyAt(x, y, z), torchAt(x, y, z));
          continue;
        }
        if (id === B.BED || id === B.BED_HEAD) {
          const facing = world.bedFacings.get(`${bx + x},${y},${bz + z}`) ?? 0;
          emitBed(solid, atlas, x, y, z, id === B.BED_HEAD, facing, skyAt(x, y, z), torchAt(x, y, z));
          continue;
        }
        if (id === B.TRAPDOOR) {
          const open = !!world.doorStates.get(`${bx + x},${y},${bz + z}`)?.open;
          emitTrapdoor(solid, atlas, x, y, z, open, skyAt(x, y, z), torchAt(x, y, z));
          continue;
        }
        if (id === B.PRESSURE_PLATE) {
          const state = world.redstoneStates.get(`${bx + x},${y},${bz + z}`);
          const active = !!state?.active;
          emitPressurePlate(solid, atlas, x, y, z, skyAt(x, y, z), torchAt(x, y, z), active);
          continue;
        }
        if (id === B.LEVER) {
          const state = world.redstoneStates.get(`${bx + x},${y},${bz + z}`);
          const active = !!state?.active;
          const facing = state?.facing ?? 1;
          emitLever(solid, atlas, x, y, z, skyAt(x, y, z), torchAt(x, y, z), active, facing);
          continue;
        }
        if (id === B.WOODEN_BUTTON || id === B.STONE_BUTTON) {
          const state = world.redstoneStates.get(`${bx + x},${y},${bz + z}`);
          const active = !!state?.active;
          const facing = state?.facing ?? 1;
          emitButton(solid, atlas, id, x, y, z, skyAt(x, y, z), torchAt(x, y, z), active, facing);
          continue;
        }
        if (id === B.REDSTONE_WIRE) {
          const power = world.redstonePower.get(`${bx + x},${y},${bz + z}`) ?? 0;
          emitRedstoneWire(solid, atlas, x, y, z, skyAt(x, y, z), torchAt(x, y, z), power);
          continue;
        }
        if (CROSS_BLOCKS.has(id)) {
          const tileName = def(id).faces!.sides;
          const tint = TINTED_TILES.has(tileName) ? tintAt(x, z) : null;
          emitCross(solid, atlas, id, x, y, z, skyAt(x, y, z), torchAt(x, y, z), tint);
          continue;
        }
        }

        const opaque = OPAQUE_LUT[id] === 1;
        const isWater = id === B.WATER;
        const isLava = id === B.LAVA;
        const isLiquid = isWater || isLava;
        const isLeaf = LEAF_LUT[id] === 1;
        // lava is opaque-looking and self-lit, so it rides the solid pass; only
        // water goes to the translucent pass
        const target = isWater ? water : solid;
        const waterTopOpen = isLiquid && get(x, y + 1, z) !== id;
        // flag bits packed onto the torch channel (stripped in the shader)
        const flag = isLava ? FLAG_LAVA : isLeaf ? FLAG_SWAY : 0;
        // water carries its own vertex data (see WATER VERTEX below): surface
        // flow / fall speed in atint, depth + shoreline in uv
        let flowX = 0, flowZ = 0, fall = 0, selfDepth = 0;
        if (isWater) {
          selfDepth = waterDepth(x, y, z);
          fall = get(x, y + 1, z) === id || get(x, y - 1, z) === B.AIR ? 1 : 0;
          if (waterTopOpen) {
            // downhill gradient of the surface: toward lower neighbours and
            // (strongly) toward open drops
            const hs = liquidCellHeight(id, x, y, z);
            for (let d = 0; d < 4; d++) {
              const dx = d === 0 ? 1 : d === 1 ? -1 : 0, dz = d === 2 ? 1 : d === 3 ? -1 : 0;
              const nb = get(x + dx, y, z + dz);
              let diff: number;
              if (nb === id) diff = hs - liquidCellHeight(id, x + dx, y, z + dz);
              else if (nb === B.AIR) {
                const under = get(x + dx, y - 1, z + dz);
                diff = under === B.AIR || under === id ? hs * 2 : hs * 0.5;
              } else continue;
              flowX += dx * diff; flowZ += dz * diff;
            }
            const fl = Math.hypot(flowX, flowZ);
            if (fl > 1e-4) { const k = Math.min(1, fl * 16) / fl; flowX *= k; flowZ *= k; } else { flowX = 0; flowZ = 0; }
          }
        }

        for (let face = 0; face < 6; face++) {
          const n = FACE_NORMALS[face];
          const nb = PAD[pi + PAD_STEP[face]];

          // culling rules
          if (isLiquid) {
            if (nb === id) continue;
            if (OPAQUE_LUT[nb]) continue;
            if (nb !== B.AIR && !LEAF_LUT[nb] && nb !== B.TORCH && nb !== B.GLASS && face !== 2) continue;
          } else if (opaque) {
            if (OPAQUE_LUT[nb]) continue;
          } else {
            // cutout blocks (leaves, glass): cull against opaque and same type.
            // (Fancy leaf-to-leaf faces were tried: +37% vertices in forests
            // and heavy overdraw for little gain with these dense leaf tiles.)
            if (OPAQUE_LUT[nb] || nb === id) continue;
          }

          const geo = FACE_GEO[face];
          const rect = faceRect(atlas, id, face);
          const shade = FACE_SHADE[face];
          const base = target.vertCount;
          const tint = FACE_TINTED[id * 6 + face] ? tintAt(x, z) : WHITE;

          // Sample the 3x3 grid of cells in the layer in front of this face ONCE,
          // then each corner reads from it (the 4 corners share these samples).
          const cx0 = x + n[0], cy0 = y + n[1], cz0 = z + n[2];
          const ux = geo.u[0], uy = geo.u[1], uz = geo.u[2];
          const vx = geo.v[0], vy = geo.v[1], vz = geo.v[2];
          for (let i = -1; i <= 1; i++) {
            for (let j = -1; j <= 1; j++) {
              const gx = cx0 + i * ux + j * vx;
              const gy = cy0 + i * uy + j * vy;
              const gz = cz0 + i * uz + j * vz;
              const gi = (i + 1) * 3 + (j + 1);
              const gid = PAD[padIdx(gx, gy, gz)];
              OCC9[gi] = OCCLUDE_LUT[gid];
              SOLID9[gi] = OPAQUE_LUT[gid];
              // inline skyAt/torchAt: gx/gz are always inside the light region
              if (gy >= CY) { SKY9[gi] = 1; TORCH9[gi] = 0; }
              else if (gy < 0) { SKY9[gi] = 0; TORCH9[gi] = 0; }
              else {
                const ri = ((gz - RX0) * RW + (gx - RX0)) * CY + gy;
                SKY9[gi] = LIGHT_CURVE[SKYR[ri]];
                TORCH9[gi] = hasLights ? LIGHT_CURVE[TORCHR[ri]] : 0;
              }
            }
          }

          const ao0 = aoCorner(0, 0, isLiquid), ao1 = aoCorner(1, 0, isLiquid);
          const ao2 = aoCorner(1, 1, isLiquid), ao3 = aoCorner(0, 1, isLiquid);

          for (let corner = 0; corner < 4; corner++) {
            const a = corner === 1 || corner === 2 ? 1 : 0; // u coefficient
            const b = corner >= 2 ? 1 : 0;                  // v coefficient
            const px = geo.o[0] + a * ux + b * vx;
            let py = geo.o[1] + a * uy + b * vy;
            const pz = geo.o[2] + a * uz + b * vz;
            if (waterTopOpen && py === 1) py = liquidCornerHeight(id, x, y, z, px, pz);

            const sky = cornerLight(SKY9, a, b);
            let torch = cornerLight(TORCH9, a, b);
            const aoc = corner === 0 ? ao0 : corner === 1 ? ao1 : corner === 2 ? ao2 : ao3;
            const k = shade * AO_SHADE[aoc];
            if (isLava) torch = 1 / k; // self-lit: full brightness after shading
            if (isWater) {
              // WATER VERTEX: atint = (flow x, flow z | fall speed, face kind
              // 0 top / 1 side / 2 underside), uv = (depth below, shoreline)
              let wr = flowX, wg = flowZ, wu = selfDepth, wv = 0;
              const kindF = face === 2 ? 0 : face === 3 ? 2 : 1;
              if (face === 2) {
                // corner depth/shore: average the 4 columns sharing the corner;
                // solid ones count as zero depth and mark a shoreline
                let sum = 0, cnt = 0, shore = 0;
                for (let q = 0; q < 4; q++) {
                  const qx = x + px - 1 + (q & 1), qz = z + pz - 1 + (q >> 1);
                  const qid = get(qx, y, qz);
                  if (qid === id) {
                    sum += waterDepth(qx, y, qz); cnt++;
                    if (get(qx, y + 1, qz) === id) shore = 1; // whitewater where a fall plunges in
                  } else if (qid !== B.AIR) { cnt++; shore = 1; }
                }
                wu = cnt ? sum / cnt : selfDepth; wv = shore;
              } else if (kindF === 1) {
                wr = 0; wg = fall ? 1 : Math.hypot(flowX, flowZ) * 0.5;
              }
              target.v(x + px, y + py, z + pz, k * sky, k * torch, wr, wg, kindF, wu, wv);
              continue;
            }
            target.v(x + px, y + py, z + pz, k * sky, k * torch + flag,
              tint[0], tint[1], tint[2],
              a ? rect.u1 : rect.u0,
              b ? rect.v0 : rect.v1); // b=1 is the face top -> image top (flipY=false)
          }

          // flip the quad diagonal when AO is anisotropic
          if (ao0 + ao2 >= ao1 + ao3) target.tri2(base, base + 1, base + 2, base, base + 2, base + 3);
          else target.tri2(base + 1, base + 2, base + 3, base + 1, base + 3, base);
        }
      }
    }
  }

  return { solid: solid.build(), water: water.build() };
}

/** Crossed billboards for plants (flowers, grass, sugar cane). Both windings
 *  are emitted so the front-face-culled chunk material shows them from any side. */
function emitCross(g: GeoBuilder, atlas: MeshAtlas, id: number, x: number, y: number, z: number, sky: number, torch: number, tint: Float32Array | null): void {
  const rect = atlas.rect(def(id).faces!.sides);
  const a = 0.146, b = 0.854; // ~ MC's sqrt(2)/2-inset diagonal
  const tr = tint ? tint[0] : 1, tg = tint ? tint[1] : 1, tb = tint ? tint[2] : 1;
  const planes: [number, number, number, number][] = [
    [a, a, b, b],
    [a, b, b, a],
  ];
  for (const [x0, z0, x1, z1] of planes) {
    for (const flip of [false, true]) {
      const base = g.vertCount;
      const corners = flip
        ? [[x1, 0, z1], [x0, 0, z0], [x0, 1, z0], [x1, 1, z1]]
        : [[x0, 0, z0], [x1, 0, z1], [x1, 1, z1], [x0, 1, z0]];
      const us = [rect.u0, rect.u1, rect.u1, rect.u0];
      const vs = [rect.v1, rect.v1, rect.v0, rect.v0];
      for (let i = 0; i < 4; i++) {
        // the top edge sways in the wind (flag stripped by the vertex shader)
        const sway = corners[i][1] > 0 ? FLAG_SWAY : 0;
        g.v(x + corners[i][0], y + corners[i][1], z + corners[i][2], sky, torch + sway,
          tr, tg, tb, us[i], vs[i]);
      }
      g.tri2(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
}

/** Small torch model: a 2/16-wide column, 10/16 tall. With `facing` (0=+x,
 *  1=-x, 2=+z, 3=-z) it becomes a wall torch — raised, leaned away from the
 *  wall, and offset so its base sits against that wall face. */
function emitTorch(
  g: GeoBuilder, atlas: MeshAtlas, x: number, y: number, z: number,
  sky: number, torch: number, facing?: number,
): void {
  const rect = atlas.rect('torch');
  const du = rect.u1 - rect.u0, dv = rect.v1 - rect.v0;
  const lo = 7 / 16, hi = 9 / 16, top = 10 / 16;
  const u0 = rect.u0 + 7 / 16 * du, u1 = rect.u0 + 9 / 16 * du;
  const vTop = rect.v0 + 6 / 16 * dv, vBottom = rect.v1;

  // wall mounting: lean angle + anchor against the wall opposite `facing`
  let wallX = 0, wallZ = 0, ax = 0.5, ay = 0, az = 0.5, sinL = 0, cosL = 1;
  if (facing !== undefined) {
    wallX = facing === 0 ? 1 : facing === 1 ? -1 : 0;
    wallZ = facing === 2 ? 1 : facing === 3 ? -1 : 0;
    const lean = 0.42; // radians the top tilts out into the room
    sinL = Math.sin(lean); cosL = Math.cos(lean);
    ax = 0.5 - wallX * 0.42; // base near the wall face
    az = 0.5 - wallZ * 0.42;
    ay = 0.22;               // raised up the wall
  }
  // transform a local column point (centered on x/z, height py) by the lean
  const tx = (px: number, py: number): number => ax + (px - 0.5) + wallX * py * sinL;
  const ty = (py: number): number => ay + py * cosL;
  const tz = (pz: number, py: number): number => az + (pz - 0.5) + wallZ * py * sinL;

  const push = (px: number, py: number, pz: number, u: number, v: number): void => {
    // a torch always glows itself
    g.v(x + tx(px, py), y + ty(py), z + tz(pz, py), sky, Math.max(torch, 0.9), 1, 1, 1, u, v);
  };
  const quads: number[][][] = [
    [[hi, 0, hi], [hi, 0, lo], [hi, top, lo], [hi, top, hi]],   // +x
    [[lo, 0, lo], [lo, 0, hi], [lo, top, hi], [lo, top, lo]],   // -x
    [[lo, 0, hi], [hi, 0, hi], [hi, top, hi], [lo, top, hi]],   // +z
    [[hi, 0, lo], [lo, 0, lo], [lo, top, lo], [hi, top, lo]],   // -z
  ];
  for (const q of quads) {
    const base = g.vertCount;
    push(q[0][0], q[0][1], q[0][2], u0, vBottom);
    push(q[1][0], q[1][1], q[1][2], u1, vBottom);
    push(q[2][0], q[2][1], q[2][2], u1, vTop);
    push(q[3][0], q[3][1], q[3][2], u0, vTop);
    g.tri2(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  // tip (flame top)
  const base = g.vertCount;
  const tu0 = rect.u0 + 7 / 16 * du, tu1 = rect.u0 + 9 / 16 * du;
  const tv0 = rect.v0 + 6 / 16 * dv, tv1 = rect.v0 + 8 / 16 * dv;
  push(lo, top, hi, tu0, tv1);
  push(hi, top, hi, tu1, tv1);
  push(hi, top, lo, tu1, tv0);
  push(lo, top, lo, tu0, tv0);
  g.tri2(base, base + 1, base + 2, base, base + 2, base + 3);
}

/** Door panels are thin slabs; geometry is computed in doorFootprints below. */
const DOOR_INSET = 1 / 128; // keep the leaf off block walls to avoid z-fighting

/** Closed/open panel footprints (BL=hinge-outer, then around the rectangle).
 *  Closed: thin slab flush against the player-facing block edge, filling the
 *  doorway (vanilla MC). Open: swung 90deg flat against the perpendicular wall
 *  on the hinge side, thickness pointing into the room. Both stay in-bounds and
 *  share the outer hinge corner (footprint[0]) so the swing pivots there. */
function doorFootprints(
  facing: number, hingeRight: boolean, t: number,
): { closed: [number, number][]; open: [number, number][] } {
  const e = DOOR_INSET;
  const lo = e, hi = 1 - e;
  switch (facing) {
    case 0: // N=+z, flush at z=hi
      return hingeRight
        ? { closed: [[hi, hi], [lo, hi], [lo, hi - t], [hi, hi - t]],
            open: [[hi, hi], [hi, lo], [hi - t, lo], [hi - t, hi]] }
        : { closed: [[lo, hi], [hi, hi], [hi, hi - t], [lo, hi - t]],
            open: [[lo, hi], [lo, lo], [lo + t, lo], [lo + t, hi]] };
    case 2: // N=-z, flush at z=lo
      return hingeRight
        ? { closed: [[hi, lo], [lo, lo], [lo, lo + t], [hi, lo + t]],
            open: [[hi, lo], [hi, hi], [hi - t, hi], [hi - t, lo]] }
        : { closed: [[lo, lo], [hi, lo], [hi, lo + t], [lo, lo + t]],
            open: [[lo, lo], [lo, hi], [lo + t, hi], [lo + t, lo]] };
    case 1: // N=+x, flush at x=hi
      return hingeRight
        ? { closed: [[hi, lo], [hi, hi], [hi - t, hi], [hi - t, lo]],
            open: [[hi, lo], [lo, lo], [lo, lo + t], [hi, lo + t]] }
        : { closed: [[hi, hi], [hi, lo], [hi - t, lo], [hi - t, hi]],
            open: [[hi, hi], [lo, hi], [lo, hi - t], [hi, hi - t]] };
    default: // N=-x, flush at x=lo
      return hingeRight
        ? { closed: [[lo, hi], [lo, lo], [lo + t, lo], [lo + t, hi]],
            open: [[lo, hi], [hi, hi], [hi, hi - t], [lo, hi - t]] }
        : { closed: [[lo, lo], [lo, hi], [lo + t, hi], [lo + t, lo]],
            open: [[lo, lo], [hi, lo], [hi, lo + t], [lo, lo + t]] };
  }
}

/** Interpolate the leaf between closed and open. Corner-lerp with smoothstep:
 *  the outer hinge corner is fixed and the thin slab stays inside the cell at
 *  every angle, so it never clips neighbouring blocks. */
function doorSwingFootprint(
  facing: number, hingeRight: boolean, swing: number, t: number,
): [number, number][] {
  const { closed, open } = doorFootprints(facing, hingeRight, t);
  if (swing <= 0) return closed;
  if (swing >= 1) return open;
  const s = swing * swing * (3 - 2 * swing);
  return closed.map(([cx, cz], i) => {
    const [ox, oz] = open[i];
    return [cx + (ox - cx) * s, cz + (oz - cz) * s];
  });
}

/** Door leaf hinged on a vertical edge; swing 0..1 rotates it 90deg inward.
 *  Geometry stays inside the block cell so it never clips neighbours. */
function emitDoor(
  g: GeoBuilder, atlas: MeshAtlas, id: number, x: number, y: number, z: number,
  facing: number, hingeRight: boolean, swing: number, sky: number, torch: number,
): void {
  const rect = atlas.rect(id === B.DOOR_UPPER ? 'door_upper' : 'door_lower');
  const t = 2 / 16;
  const foot = doorSwingFootprint(facing, hingeRight, swing, t);
  emitDoorPanel(g, x, y, z, foot, rect, sky, torch);
}

/** Textured door slab from four bottom xz corners (y spans 0..1 in the cell). */
function emitDoorPanel(
  g: GeoBuilder, bx: number, by: number, bz: number,
  foot: [number, number][],
  rect: { u0: number; u1: number; v0: number; v1: number },
  sky: number, torch: number,
): void {
  const { u0, u1, v0, v1 } = rect;
  const y0 = 0, y1 = 1;
  const bot = foot.map(([px, pz]) => [px, y0, pz]);
  const top = foot.map(([px, pz]) => [px, y1, pz]);
  const pushQuad = (corners: number[][], us: number[], vs: number[]): void => {
    const base = g.vertCount;
    for (let i = 0; i < 4; i++) {
      g.v(bx + corners[i][0], by + corners[i][1], bz + corners[i][2], sky, torch, 1, 1, 1, us[i], vs[i]);
    }
    g.tri2(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const faceU = [u0, u1, u1, u0];
  const faceV = [v1, v1, v0, v0];
  const edgeU = [u0, u1, u1, u0];
  const edgeV = [v1, v1, v0, v0];

  // front/back: average the two side quads' winding from the footprint
  pushQuad([bot[0], bot[1], top[1], top[0]], faceU, faceV);
  pushQuad([bot[2], bot[3], top[3], top[2]], faceU, faceV);
  pushQuad([bot[1], bot[2], top[2], top[1]], edgeU, edgeV);
  pushQuad([bot[3], bot[0], top[0], top[3]], edgeU, edgeV);
  pushQuad([bot[0], bot[1], bot[2], bot[3]], edgeU, edgeV);
  pushQuad([top[2], top[1], top[0], top[3]], edgeU, edgeV);
}

/** Ladder: a flat panel against the back of the cell, 1/16 off the wall. */
function emitLadder(g: GeoBuilder, atlas: MeshAtlas, x: number, y: number, z: number, sky: number, torch: number): void {
  const rect = atlas.rect('ladder');
  const off = 2 / 16;
  // emit against all four walls cheaply — the cull rules above already filter,
  // and double-sided chunk material shows it from any side
  const faces: number[][][] = [
    // +z wall (ladder facing -z, climber between)
    [[x + off, y, z + 1], [x + 1 - off, y, z + 1], [x + 1 - off, y + 1, z + 1], [x + off, y + 1, z + 1]],
    // -z wall
    [[x + 1 - off, y, z], [x + off, y, z], [x + off, y + 1, z], [x + 1 - off, y + 1, z]],
    // +x wall
    [[x + 1, y, z + 1 - off], [x + 1, y, z + off], [x + 1, y + 1, z + off], [x + 1, y + 1, z + 1 - off]],
    // -x wall
    [[x, y, z + off], [x, y, z + 1 - off], [x, y + 1, z + 1 - off], [x, y + 1, z + off]],
  ];
  for (const q of faces) {
    const base = g.vertCount;
    for (let i = 0; i < 4; i++) {
      g.v(q[i][0], q[i][1], q[i][2], sky, torch, 1, 1, 1,
        i === 0 || i === 3 ? rect.u0 : rect.u1, i < 2 ? rect.v1 : rect.v0);
    }
    g.tri2(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

/** Trapdoor: flat panel flush with the floor when closed, upright when open. */
function emitTrapdoor(g: GeoBuilder, atlas: MeshAtlas, x: number, y: number, z: number, open: boolean, sky: number, torch: number): void {
  const rect = atlas.rect('trapdoor');
  const thick = 3 / 16;
  const base = g.vertCount;
  let corners: number[][];
  if (open) {
    // standing upright along +z edge
    corners = [
      [x + 0, y + 0, z + 1 - thick], [x + 1, y + 0, z + 1 - thick],
      [x + 1, y + 1, z + 1 - thick], [x + 0, y + 1, z + 1 - thick],
    ];
  } else {
    // flush with the cell top
    corners = [
      [x + 0, y + 1 - thick, z + 0], [x + 1, y + 1 - thick, z + 0],
      [x + 1, y + 1 - thick, z + 1], [x + 0, y + 1 - thick, z + 1],
    ];
  }
  for (let i = 0; i < 4; i++) {
    g.v(corners[i][0], corners[i][1], corners[i][2], sky, torch, 1, 1, 1,
      i === 0 || i === 3 ? rect.u0 : rect.u1, i < 2 ? rect.v1 : rect.v0);
  }
  g.tri2(base, base + 1, base + 2, base, base + 2, base + 3);
}

function emitBox(
  g: GeoBuilder, rect: UVRect, x: number, y: number, z: number,
  x0: number, x1: number, y0: number, y1: number, z0: number, z1: number,
  sky: number, torch: number, tint = [1, 1, 1], topRect: UVRect = rect, topRot = 0
): void {
  const push = (px: number, py: number, pz: number, u: number, v: number): void => {
    g.v(x + px, y + py, z + pz, sky, torch, tint[0], tint[1], tint[2], u, v);
  };
  // Each face pushes its 4 corners in clockwise order as seen from outside the
  // box, so the triangles are wound 0,2,1 / 0,3,2 to face outward. (Winding them
  // the other way renders every partial block inside-out: the top face gets
  // culled and you see the bottom plate through it, which reads as a hollow
  // trough — that was the long-standing look of the bed and pressure plate.)
  const quad = (b: number): void => {
    g.tri2(b, b + 2, b + 1, b, b + 3, b + 2);
  };

  // +y top (may use a distinct texture, e.g. a bed's blanket, rotated 90*topRot
  // so an oriented texture like a pillow points the right way)
  let base = g.vertCount;
  const tc: [number, number][] = [
    [topRect.u0, topRect.v0], [topRect.u1, topRect.v0],
    [topRect.u1, topRect.v1], [topRect.u0, topRect.v1],
  ];
  const tr = (i: number): [number, number] => tc[(i + topRot) & 3];
  push(x0, y1, z0, ...tr(0));
  push(x1, y1, z0, ...tr(1));
  push(x1, y1, z1, ...tr(2));
  push(x0, y1, z1, ...tr(3));
  quad(base);

  // -y bottom
  base = g.vertCount;
  push(x0, y0, z0, rect.u0, rect.v0);
  push(x0, y0, z1, rect.u0, rect.v1);
  push(x1, y0, z1, rect.u1, rect.v1);
  push(x1, y0, z0, rect.u1, rect.v0);
  quad(base);

  // +x side
  base = g.vertCount;
  push(x1, y0, z0, rect.u0, rect.v1);
  push(x1, y0, z1, rect.u1, rect.v1);
  push(x1, y1, z1, rect.u1, rect.v0);
  push(x1, y1, z0, rect.u0, rect.v0);
  quad(base);

  // -x side
  base = g.vertCount;
  push(x0, y0, z1, rect.u0, rect.v1);
  push(x0, y0, z0, rect.u1, rect.v1);
  push(x0, y1, z0, rect.u1, rect.v0);
  push(x0, y1, z1, rect.u0, rect.v0);
  quad(base);

  // +z side
  base = g.vertCount;
  push(x0, y0, z1, rect.u0, rect.v1);
  push(x0, y1, z1, rect.u0, rect.v0);
  push(x1, y1, z1, rect.u1, rect.v0);
  push(x1, y0, z1, rect.u1, rect.v1);
  quad(base);

  // -z side
  base = g.vertCount;
  push(x1, y0, z0, rect.u0, rect.v1);
  push(x1, y1, z0, rect.u0, rect.v0);
  push(x0, y1, z0, rect.u1, rect.v0);
  push(x0, y0, z0, rect.u1, rect.v1);
  quad(base);
}

function emitPressurePlate(g: GeoBuilder, atlas: MeshAtlas, x: number, y: number, z: number, sky: number, torch: number, active: boolean): void {
  const rect = atlas.rect('planks');
  const h = active ? 0.03 : 0.08;
  emitBox(g, rect, x, y, z, 0.0625, 0.9375, 0, h, 0.0625, 0.9375, sky, torch);
}

/** One half of a 2-block bed (Minecraft-style): a wooden base, a red mattress on
 *  top, and — on the head half — a white pillow that the topRot rotation keeps
 *  pointing away from the foot. `facing` is the foot->head direction
 *  (0=-z,1=-x,2=+z,3=+x). */
function emitBed(g: GeoBuilder, atlas: MeshAtlas, x: number, y: number, z: number, isHead: boolean, facing: number, sky: number, torch: number): void {
  const red = atlas.rect('bed_side');        // red blanket on the mattress sides
  const footTop = atlas.rect('bed_foot_top'); // quilted blanket (foot half)
  const headTop = atlas.rect('bed_head_top'); // blanket + painted pillow (head half)
  const wood = atlas.rect('bed_leg');        // wooden corner legs
  const white = atlas.rect('pillow');        // white pillow on the head end
  const L = 0.1875;                          // 3/16 legs (height + thickness)
  const mattTop = 0.5625;                    // 9/16 mattress top (vanilla height)
  const axisIsZ = facing === 0 || facing === 2;
  // does this half's outer end sit at coordinate 1 (vs 0) along the bed axis?
  const high = (facing === 0 || facing === 1) ? !isHead : isHead;
  // flat red mattress slab floating above the legs (open underside = MC look).
  // topRot = facing keeps the painted pillow pointing at the head end for all
  // four orientations (see the tile comment in Textures.ts).
  emitBox(g, red, x, y, z, 0, 1, L, mattTop, 0, 1, sky, torch, [1, 1, 1],
    isHead ? headTop : footTop, isHead ? facing : 0);
  // two wooden legs at this half's outer end, so the whole bed has 4 corner legs
  const la0 = high ? 1 - L : 0, la1 = high ? 1 : L;
  const leg = (cMin: number): void => {
    if (axisIsZ) emitBox(g, wood, x, y, z, cMin, cMin + L, 0, L, la0, la1, sky, torch);
    else emitBox(g, wood, x, y, z, la0, la1, 0, L, cMin, cMin + L, sky, torch);
  };
  leg(0); leg(1 - L);
  // head half: the pillow puffs 1.5/16 above the blanket over the outer 11/16 of
  // the half, full bed width — the same area bed_head_top paints white, so the
  // raised box and the texture read as one cushion
  if (isHead) {
    const pa0 = high ? 0.3125 : 0, pa1 = high ? 1 : 0.6875; // along bed axis
    const py0 = mattTop, py1 = mattTop + 0.09375;           // +1.5/16
    if (axisIsZ) emitBox(g, white, x, y, z, 0, 1, py0, py1, pa0, pa1, sky, torch);
    else emitBox(g, white, x, y, z, pa0, pa1, py0, py1, 0, 1, sky, torch);
  }
}

function emitLever(g: GeoBuilder, atlas: MeshAtlas, x: number, y: number, z: number, sky: number, torch: number, active: boolean, facing: number): void {
  const stoneRect = atlas.rect('cobble');
  let bx0 = 0.25, bx1 = 0.75, by0 = 0, by1 = 0.18, bz0 = 0.25, bz1 = 0.75;
  if (facing === 0) {
    by0 = 0.82; by1 = 1.0;
  } else if (facing === 2) {
    bz0 = 0.82; bz1 = 1.0; bx0 = 0.25; bx1 = 0.75; by0 = 0.25; by1 = 0.75;
  } else if (facing === 3) {
    bz0 = 0; bz1 = 0.18; bx0 = 0.25; bx1 = 0.75; by0 = 0.25; by1 = 0.75;
  } else if (facing === 4) {
    bx0 = 0.82; bx1 = 1.0; bz0 = 0.25; bz1 = 0.75; by0 = 0.25; by1 = 0.75;
  } else if (facing === 5) {
    bx0 = 0; bx1 = 0.18; bz0 = 0.25; bz1 = 0.75; by0 = 0.25; by1 = 0.75;
  }
  emitBox(g, stoneRect, x, y, z, bx0, bx1, by0, by1, bz0, bz1, sky, torch);

  const woodRect = atlas.rect('planks');
  let sx0 = 0.44, sx1 = 0.56, sy0 = 0.18, sy1 = 0.7, sz0 = active ? 0.52 : 0.32, sz1 = active ? 0.68 : 0.48;
  if (facing === 0) {
    sy0 = 0.3; sy1 = 0.82;
  } else if (facing === 2) {
    sz0 = 0.3; sz1 = 0.82; sy0 = active ? 0.52 : 0.32; sy1 = active ? 0.68 : 0.48;
  } else if (facing === 3) {
    sz0 = 0.18; sz1 = 0.7; sy0 = active ? 0.52 : 0.32; sy1 = active ? 0.68 : 0.48;
  } else if (facing === 4) {
    sx0 = 0.3; sx1 = 0.82; sy0 = active ? 0.52 : 0.32; sy1 = active ? 0.68 : 0.48;
  } else if (facing === 5) {
    sx0 = 0.18; sx1 = 0.7; sy0 = active ? 0.52 : 0.32; sy1 = active ? 0.68 : 0.48;
  }
  emitBox(g, woodRect, x, y, z, sx0, sx1, sy0, sy1, sz0, sz1, sky, torch);
}

function emitButton(g: GeoBuilder, atlas: MeshAtlas, id: number, x: number, y: number, z: number, sky: number, torch: number, active: boolean, facing: number): void {
  const tileName = id === B.WOODEN_BUTTON ? 'planks' : 'stone';
  const rect = atlas.rect(tileName);
  const depth = active ? 0.08 : 0.16;
  let x0 = 0.375, x1 = 0.625, y0 = 0.375, y1 = 0.625, z0 = 0.375, z1 = 0.625;
  if (facing === 0) {
    y0 = 1 - depth; y1 = 1;
  } else if (facing === 1) {
    y0 = 0; y1 = depth;
  } else if (facing === 2) {
    z0 = 1 - depth; z1 = 1;
  } else if (facing === 3) {
    z0 = 0; z1 = depth;
  } else if (facing === 4) {
    x0 = 1 - depth; x1 = 1;
  } else if (facing === 5) {
    x0 = 0; x1 = depth;
  }
  emitBox(g, rect, x, y, z, x0, x1, y0, y1, z0, z1, sky, torch);
}

function emitRedstoneWire(g: GeoBuilder, atlas: MeshAtlas, x: number, y: number, z: number, sky: number, torch: number, power: number): void {
  const rect = atlas.rect('redstone_dust');
  const base = g.vertCount;
  const r = 0.3 + 0.7 * (power / 15);
  const push = (px: number, py: number, pz: number, u: number, v: number): void => {
    g.v(x + px, y + py, z + pz, sky, Math.max(torch, power / 15), r, 0, 0, u, v);
  };
  push(0, 0.01, 0, rect.u0, rect.v0);
  push(1, 0.01, 0, rect.u1, rect.v0);
  push(1, 0.01, 1, rect.u1, rect.v1);
  push(0, 0.01, 1, rect.u0, rect.v1);
  g.tri2(base, base + 1, base + 2, base, base + 2, base + 3);
}
