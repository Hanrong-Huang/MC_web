// Nether terrain. A vast cavern carved from a coarse 3D density lattice (floor
// and ceiling slides, craggy noise for ledges and overhangs, floating islands,
// hourglass pillars) over a lava sea at y=31, split into five vanilla-style
// biomes picked from a 2D climate (heat, wet): nether wastes, crimson forest,
// warped forest, soul sand valley and basalt deltas. Terrain parameters blend
// smoothly across biome borders; surfaces and features follow each column's
// biome. Everything is a pure function of seed + position (features that span
// chunks are planned from their origin cell and clipped per chunk), so it runs
// unchanged in the gen worker and neighbouring chunks always agree.

import { Simplex2, Simplex3, hash2, hash3, mulberry32, smoothstep } from './Noise';
import { Chunk, CX, CZ, CY } from './Chunk';
import { B, idByName } from './Blocks';

export type NetherBiome = 'wastes' | 'crimson' | 'warped' | 'soul_valley' | 'basalt';
export const NETHER_BIOMES: readonly NetherBiome[] = ['wastes', 'crimson', 'warped', 'soul_valley', 'basalt'];
/** vanilla names, for the debug screen */
const LABELS = ['nether_wastes', 'crimson_forest', 'warped_forest', 'soul_sand_valley', 'basalt_deltas'];
const WASTES = 0, CRIMSON = 1, WARPED = 2, SOUL = 3, BASALT = 4;

/** climate points (heat, wet), after vanilla's multi-noise Nether */
const PT_H = [0, 0.4, 0, 0, -0.42];
const PT_W = [0, 0, 0.45, -0.45, 0];
/** squared-distance handicap: widens the wastes' share around the centre */
const PT_BIAS = [-0.06, 0, 0, 0, 0];
// per-biome terrain shape (blended by climate weight)
const FLOOR = [35, 41, 41, 38, 40];         // mean floor height
const FLOOR_AMP = [13, 6, 6, 5, 7];         // broad floor undulation
const CEIL = [118, 124, 124, 128, 112];     // mean ceiling height
const CRAG = [1.25, 0.7, 0.7, 0.65, 0.95];  // 3D noise: ledges, overhangs, arches
const ISLES = [1, 0.45, 0.45, 0.5, 0.8];    // floating islands

/** lava fills every open cell at or below this height */
export const LAVA_SEA = 31;
/** density lattice: one sample every 4 blocks on each axis */
const LY = (CY >> 2) + 1;
const PILLAR_CELL = 48;

/** a column of the density lattice (x/z multiples of 4) */
type LatticeCol = Float32Array;

export class NetherGen {
  private readonly seed: number;
  private heatN: Simplex2;
  private wetN: Simplex2;
  private warpN: Simplex2;
  private jitN: Simplex2;
  private floorN: Simplex2;
  private ceilN: Simplex2;
  private oceanN: Simplex2;
  private patchN: Simplex2;
  private deltaN: Simplex2;
  private spikeN: Simplex2;
  private d1: Simplex3;
  private d2: Simplex3;
  private isleN: Simplex3;
  private cols = new Map<number, LatticeCol>();
  private readonly bone: number;
  // climate scratch (see climate())
  private ch = 0;
  private cw = 0;
  private wts = new Float32Array(5);
  // per-chunk scratch
  private colBiome = new Uint8Array(CX * CZ);

  constructor(seed: number) {
    this.seed = seed | 0;
    const s = this.seed;
    this.heatN = new Simplex2(s ^ 0x4e01);
    this.wetN = new Simplex2(s ^ 0x4e02);
    this.warpN = new Simplex2(s ^ 0x4e03);
    this.jitN = new Simplex2(s ^ 0x4e04);
    this.floorN = new Simplex2(s ^ 0x4e05);
    this.ceilN = new Simplex2(s ^ 0x4e06);
    this.oceanN = new Simplex2(s ^ 0x4e07);
    this.patchN = new Simplex2(s ^ 0x4e08);
    this.deltaN = new Simplex2(s ^ 0x4e09);
    this.spikeN = new Simplex2(s ^ 0x4e0a);
    this.d1 = new Simplex3(s ^ 0x4e11);
    this.d2 = new Simplex3(s ^ 0x4e12);
    this.isleN = new Simplex3(s ^ 0x4e13);
    // fossils are bone where a bone block exists, else quartz
    this.bone = idByName('bone_block') || B.QUARTZ_BLOCK;
  }

  // --- biomes -------------------------------------------------------------------

  /** Domain-warped heat/wetness at a column (into ch/cw). */
  private climate(x: number, z: number): void {
    const wx = x + this.warpN.noise(x * 0.011, z * 0.011) * 26;
    const wz = z + this.warpN.noise(x * 0.011 + 71.3, z * 0.011 - 13.7) * 26;
    this.ch = this.heatN.noise(wx * 0.0052, wz * 0.0052) * 0.85 + this.heatN.noise(wx * 0.019 + 40, wz * 0.019) * 0.15;
    this.cw = this.wetN.noise(wx * 0.0052, wz * 0.0052) * 0.85 + this.wetN.noise(wx * 0.019, wz * 0.019 + 40) * 0.15;
  }

  /** Biome index at a column: nearest climate point, with a little fine
   *  jitter so borders read as ragged drifts rather than smooth curves. */
  private biomeIndex(x: number, z: number): number {
    this.climate(x, z);
    const j = this.jitN.noise(x * 0.19, z * 0.19) * 0.03;
    const h = this.ch + j, w = this.cw - j;
    let best = 0, bd = 1e9;
    for (let b = 0; b < 5; b++) {
      const d = (h - PT_H[b]) * (h - PT_H[b]) + (w - PT_W[b]) * (w - PT_W[b]) + PT_BIAS[b];
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  /** Nether biome at a world column. Pure: safe to call from any system. */
  biomeAt(wx: number, wz: number): NetherBiome {
    return NETHER_BIOMES[this.biomeIndex(Math.floor(wx), Math.floor(wz))];
  }

  /** Vanilla-style biome name for the debug screen. */
  label(wx: number, wz: number): string {
    return LABELS[this.biomeIndex(Math.floor(wx), Math.floor(wz))];
  }

  /** Soft biome weights (into wts): smooth terrain blending across borders. */
  private weights(x: number, z: number): Float32Array {
    this.climate(x, z);
    const w = this.wts;
    let dmin = 1e9;
    for (let b = 0; b < 5; b++) {
      const d = (this.ch - PT_H[b]) ** 2 + (this.cw - PT_W[b]) ** 2 + PT_BIAS[b];
      w[b] = d;
      if (d < dmin) dmin = d;
    }
    let sum = 0;
    for (let b = 0; b < 5; b++) { w[b] = Math.exp(-(w[b] - dmin) / 0.016); sum += w[b]; }
    for (let b = 0; b < 5; b++) w[b] /= sum;
    return w;
  }

  // --- density ------------------------------------------------------------------

  /** Nearest hourglass pillar to a column: [distance, base radius] (radius 0 = none). */
  private pillar(x: number, z: number): [number, number] {
    const gx = Math.floor(x / PILLAR_CELL), gz = Math.floor(z / PILLAR_CELL);
    let bestD = 1e9, bestR = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = gx + dx, cz = gz + dz;
        if (hash2(this.seed ^ 0x9111, cx, cz) > 0.3) continue;
        const px = cx * PILLAR_CELL + 8 + hash2(this.seed ^ 0x9112, cx, cz) * (PILLAR_CELL - 16);
        const pz = cz * PILLAR_CELL + 8 + hash2(this.seed ^ 0x9113, cx, cz) * (PILLAR_CELL - 16);
        const r = 2.8 + hash2(this.seed ^ 0x9114, cx, cz) * 3.4;
        const d = Math.hypot(x - px, z - pz);
        if (d - r < bestD - bestR) { bestD = d; bestR = r; }
      }
    }
    return [bestD, bestR];
  }

  /** Density samples (>0 = solid) for the lattice column at world (x, z). */
  private buildCol(x: number, z: number): LatticeCol {
    const w = this.weights(x, z);
    let floor = 0, famp = 0, ceil = 0, crag = 0, isles = 0;
    for (let b = 0; b < 5; b++) {
      floor += w[b] * FLOOR[b]; famp += w[b] * FLOOR_AMP[b]; ceil += w[b] * CEIL[b];
      crag += w[b] * CRAG[b]; isles += w[b] * ISLES[b];
    }
    floor += famp * this.floorN.noise(x * 0.011, z * 0.011) + 3 * this.floorN.noise(x * 0.043 + 31, z * 0.043 - 17);
    // lava oceans: broad lowlands drowned under the lava sea, crossed by pillars
    floor -= smoothstep(0.14, 0.46, this.oceanN.noise(x * 0.0034, z * 0.0034)) * 27;
    ceil += 9 * this.ceilN.noise(x * 0.014, z * 0.014);
    const isleY = 76 + 14 * this.ceilN.noise(x * 0.006 + 90, z * 0.006 - 40);
    const [pd, pr] = this.pillar(x, z);
    const mid = (floor + ceil) * 0.5, half = Math.max(8, (ceil - floor) * 0.5);
    const out = new Float32Array(LY);
    for (let j = 0; j < LY; j++) {
      const y = j * 4;
      let d = Math.max((floor - y) / 7, (y - ceil) / 9);
      // craggy noise only where it can flip the sign (near floor/ceiling)
      if (d > -crag - 0.1 && d < crag + 0.1) {
        d += (this.d1.noise(x * 0.017, y * 0.03, z * 0.017) * 0.7 + this.d2.noise(x * 0.05, y * 0.075, z * 0.05) * 0.3) * crag;
      }
      if (y > isleY - 16 && y < isleY + 10) {
        const t = (y - isleY) / (y < isleY ? 9 : 4.5);
        const ni = this.isleN.noise(x * 0.021, y * 0.04, z * 0.021);
        d = Math.max(d, ((ni - 0.4) * 5 - t * t) * isles);
      }
      if (pr > 0 && pd < pr * 2 + 6) {
        const k = (y - mid) / half;
        d = Math.max(d, (pr * (0.6 + 0.55 * k * k) - pd) / 3);
      }
      if (y < 5) d = Math.max(d, (5 - y) * 0.6);
      if (y > CY - 7) d = Math.max(d, (y - (CY - 7)) * 0.6);
      out[j] = d;
    }
    return out;
  }

  private col(ix: number, iz: number): LatticeCol {
    const key = ix * 4194304 + iz;
    let c = this.cols.get(key);
    if (!c) {
      if (this.cols.size > 8000) this.cols.clear();
      c = this.buildCol(ix * 4, iz * 4);
      this.cols.set(key, c);
    }
    return c;
  }

  /** Terrain density at a voxel (>0 = solid rock), before surface dressing. */
  densityAt(wx: number, y: number, wz: number): number {
    if (y <= 0 || y >= CY - 1) return 1;
    const ix = wx >> 2, iz = wz >> 2;
    return tri(this.col(ix, iz), this.col(ix + 1, iz), this.col(ix, iz + 1), this.col(ix + 1, iz + 1),
      (wx & 3) * 0.25, (wz & 3) * 0.25, y);
  }

  /** Air cell resting on the first solid floor above the lava sea, or -1. */
  floorAt(wx: number, wz: number, maxY = 104): number {
    let solidBelow = this.densityAt(wx, LAVA_SEA + 1, wz) > 0;
    for (let y = LAVA_SEA + 2; y < maxY; y++) {
      const solid = this.densityAt(wx, y, wz) > 0;
      if (solidBelow && !solid) return y;
      solidBelow = solid;
    }
    return -1;
  }

  // --- generation ---------------------------------------------------------------

  generate(chunk: Chunk): void {
    const bx = chunk.cx * CX, bz = chunk.cz * CZ;
    this.fill(chunk, bx, bz);
    const rand = mulberry32((hash2(this.seed ^ 0x4e20, chunk.cx, chunk.cz) * 4294967296) | 0);
    this.ores(chunk, rand);
    const floors: number[] = [], ceils: number[] = [];
    this.surface(chunk, bx, bz, floors, ceils);
    this.floorDecor(chunk, bx, bz, floors);
    this.ceilingDecor(chunk, bx, bz, ceils);
    this.pillars(chunk, bx, bz);
    this.fossils(chunk, bx, bz);
    this.fungi(chunk, bx, bz);
    const mid = this.colBiome[8 * CX + 8];
    this.glowstone(chunk, rand, mid === WASTES ? 3 : mid === SOUL ? 1 : 2);
    this.stalactites(chunk, rand, mid === BASALT ? 6 : 3, mid);
    this.lavaFalls(chunk, rand, mid === WASTES ? 4 : mid === BASALT ? 3 : 1);
  }

  /** Bedrock shell, rock and the lava sea from the density lattice. */
  private fill(chunk: Chunk, bx: number, bz: number): void {
    const ix0 = bx >> 2, iz0 = bz >> 2;
    const L: LatticeCol[] = [];
    for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) L.push(this.col(ix0 + i, iz0 + j));
    for (let z = 0; z < CZ; z++) {
      for (let x = 0; x < CX; x++) {
        const wx = bx + x, wz = bz + z;
        this.colBiome[z * CX + x] = this.biomeIndex(wx, wz);
        const k = (z >> 2) * 5 + (x >> 2);
        const a = L[k], b = L[k + 1], c = L[k + 5], d = L[k + 6];
        const fx = (x & 3) * 0.25, fz = (z & 3) * 0.25;
        chunk.setRaw(x, 0, z, B.BEDROCK);
        chunk.setRaw(x, CY - 1, z, B.BEDROCK);
        for (let y = 1; y < CY - 1; y++) {
          // ragged bedrock floor and roof
          if ((y <= 4 && hash3(this.seed ^ 0xbed1, wx, y, wz) < 0.85 - y * 0.2) ||
            (y >= CY - 5 && hash3(this.seed ^ 0xbed2, wx, y, wz) < 0.85 - (CY - 1 - y) * 0.2)) {
            chunk.setRaw(x, y, z, B.BEDROCK);
            continue;
          }
          const solid = tri(a, b, c, d, fx, fz, y) > 0;
          chunk.setRaw(x, y, z, solid ? B.NETHERRACK : y <= LAVA_SEA ? B.LAVA : B.AIR);
        }
      }
    }
  }

  /** Ore veins (random walks through netherrack) and hidden ancient debris. */
  private ores(chunk: Chunk, rand: () => number): void {
    const vein = (id: number, count: number, size: number, y0: number, y1: number, host: number): void => {
      for (let i = 0; i < count; i++) {
        let x = (rand() * 16) | 0, y = y0 + ((rand() * (y1 - y0)) | 0), z = (rand() * 16) | 0;
        for (let s = 0; s < size; s++) {
          if (x >= 0 && x < CX && z >= 0 && z < CZ && y > 0 && y < CY - 1 && chunk.get(x, y, z) === host) chunk.setRaw(x, y, z, id);
          const r = rand();
          if (r < 0.34) x += r < 0.17 ? 1 : -1;
          else if (r < 0.67) z += r < 0.5 ? 1 : -1;
          else y += r < 0.85 ? 1 : -1;
        }
      }
    };
    vein(B.QUARTZ_ORE, 16, 7, 10, 140, B.NETHERRACK);
    vein(B.NETHER_GOLD_ORE, 10, 5, 10, 130, B.NETHERRACK);
    vein(B.MAGMA, 4, 8, 26, 38, B.NETHERRACK);
    vein(B.GRAVEL, 2, 12, 5, 45, B.NETHERRACK);
    vein(B.BLACKSTONE, 2, 10, 5, 35, B.NETHERRACK);
    // ancient debris: deep, rare and never exposed to air or lava
    const buried = (x: number, y: number, z: number): boolean => {
      for (const [dx, dy, dz] of NB6) {
        const id = chunk.get(x + dx, y + dy, z + dz);
        if (id === B.AIR || id === B.LAVA) return false;
      }
      return true;
    };
    const debris = (y0: number, y1: number, n: number): void => {
      let x = 1 + ((rand() * 14) | 0), y = y0 + ((rand() * (y1 - y0)) | 0), z = 1 + ((rand() * 14) | 0);
      for (let s = 0; s < n; s++) {
        if (x >= 1 && x < CX - 1 && z >= 1 && z < CZ - 1 && chunk.get(x, y, z) === B.NETHERRACK && buried(x, y, z)) {
          chunk.setRaw(x, y, z, B.ANCIENT_DEBRIS);
        }
        const r = rand();
        if (r < 0.5) x += r < 0.25 ? 1 : -1; else z += r < 0.75 ? 1 : -1;
      }
    };
    debris(8, 23, 1 + ((rand() * 3) | 0));
    if (rand() < 0.4) debris(8, 119, 1);
  }

  /** Dress every column's exposed surfaces for its biome, and collect the
   *  floor tops (solid under air) and ceiling bottoms (solid over air). */
  private surface(chunk: Chunk, bx: number, bz: number, floors: number[], ceils: number[]): void {
    for (let z = 0; z < CZ; z++) {
      for (let x = 0; x < CX; x++) {
        const wx = bx + x, wz = bz + z;
        const b = this.colBiome[z * CX + x];
        const patch = this.patchN.noise(wx * 0.06, wz * 0.06);
        let run = 0;       // solid cells since the last open cell above
        let open = 0;      // what lies above this solid run: 0 none, 1 air, 2 lava
        let inSolid = true;
        for (let y = CY - 2; y >= 1; y--) {
          const id = chunk.get(x, y, z);
          if (id === B.AIR || id === B.LAVA) {
            if (inSolid && id === B.AIR && y < CY - 7) {
              const cy = y + 1; // bottom face of a ceiling or overhang
              if (chunk.get(x, cy, z) !== B.BEDROCK) {
                ceils.push(x | (z << 4) | (cy << 8));
                if (b === BASALT) {
                  for (let k = 0; k < 3; k++) {
                    const cid = chunk.get(x, cy + k, z);
                    if (cid === B.NETHERRACK) chunk.setRaw(x, cy + k, z, k === 2 ? B.BLACKSTONE : B.BASALT);
                  }
                }
              }
            }
            inSolid = false; open = id === B.AIR ? 1 : 2; run = 0;
            continue;
          }
          if (id === B.BEDROCK) { inSolid = true; open = 0; run = 99; continue; }
          if (!inSolid) { inSolid = true; run = 0; } else run++;
          if (open === 0 || run > 4) continue;
          if (run === 0 && open === 1) floors.push(x | (z << 4) | (y << 8));
          if (id !== B.NETHERRACK && !(run === 0 && id !== B.ANCIENT_DEBRIS)) continue; // keep ores below the skin
          const m = this.surfaceBlock(b, run, open, y, patch, wx, wz);
          if (m) chunk.setRaw(x, y, z, m);
        }
      }
    }
  }

  private surfaceBlock(b: number, run: number, open: number, y: number, patch: number, wx: number, wz: number): number {
    const h = hash3(this.seed ^ 0x5f1, wx, y, wz);
    if (open === 2) {
      // lava beds: magma crusts, basalt under the delta pools
      if (run > 0) return b === BASALT ? B.BLACKSTONE : 0;
      if (b === BASALT) return h < 0.4 ? B.MAGMA : B.BASALT;
      if (b === SOUL) return B.SOUL_SOIL;
      return h < 0.25 ? B.MAGMA : 0;
    }
    switch (b) {
      case CRIMSON: return run === 0 ? B.CRIMSON_NYLIUM : 0;
      case WARPED: return run === 0 ? B.WARPED_NYLIUM : 0;
      case SOUL:
        if (run === 0) return patch + (h - 0.5) * 0.3 > -0.05 ? B.SOUL_SAND : B.SOUL_SOIL;
        return run <= 3 ? B.SOUL_SOIL : 0;
      case BASALT: {
        if (run === 0) return patch + (h - 0.5) * 0.4 > -0.25 ? B.BASALT : B.BLACKSTONE;
        return run === 1 ? B.BASALT : run <= 3 ? B.BLACKSTONE : 0;
      }
      default: {
        // wastes: soul sand and gravel beaches down by the lava sea, magma at the shore
        if (y > LAVA_SEA + 5) return 0;
        if (patch > 0.42 && run <= 1) return B.SOUL_SAND;
        if (patch < -0.5 && run <= 2) return B.GRAVEL;
        if (run === 0 && y <= LAVA_SEA + 2 && h < 0.3) return B.MAGMA;
        return 0;
      }
    }
  }

  /** Is (x,y,z) inside this chunk (local coords)? */
  private static inside(x: number, y: number, z: number): boolean {
    return x >= 0 && x < CX && z >= 0 && z < CZ && y > 0 && y < CY - 1;
  }

  /** Write a world-space block if it lands in this chunk and the cell is open
   *  (air, a plant, fire) — or, with `force`, anything but bedrock/lava. */
  private put(chunk: Chunk, wx: number, y: number, wz: number, id: number, force = false): void {
    const x = wx - chunk.cx * CX, z = wz - chunk.cz * CZ;
    if (!NetherGen.inside(x, y, z)) return;
    const cur = chunk.get(x, y, z);
    if (force ? cur === B.BEDROCK || cur === B.LAVA : !SOFT.has(cur)) return;
    chunk.setRaw(x, y, z, id);
  }

  /** Floor plants, fire, basalt spikes and delta lava pools. */
  private floorDecor(chunk: Chunk, bx: number, bz: number, floors: number[]): void {
    for (const p of floors) {
      const x = p & 15, z = (p >> 4) & 15, y = p >> 8;
      if (y + 1 >= CY - 1 || chunk.get(x, y + 1, z) !== B.AIR) continue;
      const wx = bx + x, wz = bz + z;
      const b = this.colBiome[z * CX + x];
      const h = hash3(this.seed ^ 0xf10, wx, y, wz);
      const top = chunk.get(x, y, z);
      switch (b) {
        case CRIMSON:
          if (top === B.CRIMSON_NYLIUM && h < 0.16) chunk.setRaw(x, y + 1, z, B.CRIMSON_ROOTS);
          break;
        case WARPED:
          if (top !== B.WARPED_NYLIUM) break;
          if (h < 0.12) chunk.setRaw(x, y + 1, z, B.WARPED_ROOTS);
          else if (h < 0.145) {
            // twisting vines climb from the floor
            const h2 = hash3(this.seed ^ 0xf11, wx, y, wz);
            const len = h2 < 0.25 ? 6 + ((h2 * 40) | 0) : 2 + ((h2 * 5) | 0);
            for (let k = 1; k <= len && y + k < CY - 1 && chunk.get(x, y + k, z) === B.AIR; k++) chunk.setRaw(x, y + k, z, B.TWISTING_VINES);
          }
          break;
        case SOUL: {
          // patches of blue soul fire over the sand
          const f = this.patchN.noise(wx * 0.11 + 300, wz * 0.11 - 300);
          if (f > 0.5 && h < 0.16 && (top === B.SOUL_SAND || top === B.SOUL_SOIL)) chunk.setRaw(x, y + 1, z, B.FIRE);
          break;
        }
        case BASALT: {
          const dn = this.deltaN.noise(wx * 0.085, wz * 0.085) + this.deltaN.noise(wx * 0.31, wz * 0.31) * 0.25;
          if (dn > 0.42 && this.contained(wx, y, wz)) {
            // a delta: lava pool sunk into the basalt, deeper toward the middle
            chunk.setRaw(x, y, z, B.LAVA);
            if (dn > 0.62 && this.contained(wx, y - 1, wz)) chunk.setRaw(x, y - 1, z, B.LAVA);
          } else if (dn > 0.3) {
            chunk.setRaw(x, y, z, B.MAGMA);
          } else {
            // jagged columns: short basalt stacks everywhere, the odd tall spire
            let n = Math.floor((this.spikeN.noise(wx * 0.29, wz * 0.29) - 0.05) * 7);
            if (h < 0.012) n = 6 + ((hash3(this.seed ^ 0xf12, wx, y, wz) * 14) | 0);
            for (let k = 1; k <= n && y + k < CY - 1 && chunk.get(x, y + k, z) === B.AIR; k++) chunk.setRaw(x, y + k, z, B.BASALT);
          }
          break;
        }
        default:
          if (h < 0.005 && (top === B.NETHERRACK || top === B.MAGMA)) chunk.setRaw(x, y + 1, z, B.FIRE);
      }
    }
  }

  /** Is a floor cell walled in at its own level on all four sides (so lava
   *  poured into it stays put)? Uses raw terrain density, chunk-independent. */
  private contained(wx: number, y: number, wz: number): boolean {
    return this.densityAt(wx + 1, y, wz) > 0 && this.densityAt(wx - 1, y, wz) > 0 &&
      this.densityAt(wx, y, wz + 1) > 0 && this.densityAt(wx, y, wz - 1) > 0;
  }

  /** Weeping vines from crimson ceilings. */
  private ceilingDecor(chunk: Chunk, bx: number, bz: number, ceils: number[]): void {
    for (const p of ceils) {
      const x = p & 15, z = (p >> 4) & 15, y = p >> 8;
      if (this.colBiome[z * CX + x] !== CRIMSON) continue;
      const wx = bx + x, wz = bz + z;
      const h = hash3(this.seed ^ 0xc10, wx, y, wz);
      if (h > 0.07) continue;
      const len = h < 0.025 ? 7 + ((h * 400) | 0) : 2 + ((h * 60) | 0);
      for (let k = 1; k <= len && y - k > LAVA_SEA && chunk.get(x, y - k, z) === B.AIR; k++) chunk.setRaw(x, y - k, z, B.WEEPING_VINES);
    }
  }

  /** Basalt pillars: floor-to-ceiling columns in soul valleys and deltas
   *  (stumps where the ceiling is out of reach). */
  private pillars(chunk: Chunk, bx: number, bz: number): void {
    const C = 13;
    for (let gz = Math.floor((bz - 2) / C); gz <= Math.floor((bz + CZ + 1) / C); gz++) {
      for (let gx = Math.floor((bx - 2) / C); gx <= Math.floor((bx + CX + 1) / C); gx++) {
        const h = hash2(this.seed ^ 0xba51, gx, gz);
        if (h > 0.36) continue;
        const ox = gx * C + 2 + Math.floor(hash2(this.seed ^ 0xba52, gx, gz) * (C - 4));
        const oz = gz * C + 2 + Math.floor(hash2(this.seed ^ 0xba53, gx, gz) * (C - 4));
        const b = this.biomeIndex(ox, oz);
        if (b !== SOUL && b !== BASALT) continue;
        if (b === SOUL && h > 0.2) continue;
        const fy = this.floorAt(ox, oz);
        if (fy < 0) continue;
        let top = fy;
        while (top < fy + 72 && this.densityAt(ox, top, oz) <= 0) top++;
        const height = top < fy + 72 ? top - fy + 2 : 5 + Math.floor(hash2(this.seed ^ 0xba54, gx, gz) * 14);
        const thick = hash2(this.seed ^ 0xba55, gx, gz) < 0.55;
        for (let y = fy - 3; y < fy + height; y++) {
          this.put(chunk, ox, y, oz, B.BASALT, true);
          if (thick) {
            this.put(chunk, ox + 1, y, oz, B.BASALT, true); this.put(chunk, ox - 1, y, oz, B.BASALT, true);
            this.put(chunk, ox, y, oz + 1, B.BASALT, true); this.put(chunk, ox, y, oz - 1, B.BASALT, true);
          }
        }
      }
    }
  }

  /** Soul sand valley fossils: great bone rib cages arching out of the sand. */
  private fossils(chunk: Chunk, bx: number, bz: number): void {
    const C = 44, M = 16;
    for (let gz = Math.floor((bz - M) / C); gz <= Math.floor((bz + CZ + M) / C); gz++) {
      for (let gx = Math.floor((bx - M) / C); gx <= Math.floor((bx + CX + M) / C); gx++) {
        if (hash2(this.seed ^ 0xf055, gx, gz) > 0.5) continue;
        const ox = gx * C + 10 + Math.floor(hash2(this.seed ^ 0xf056, gx, gz) * (C - 20));
        const oz = gz * C + 10 + Math.floor(hash2(this.seed ^ 0xf057, gx, gz) * (C - 20));
        if (this.biomeIndex(ox, oz) !== SOUL) continue;
        const fy = this.floorAt(ox, oz);
        if (fy < 0) continue;
        const r = mulberry32((hash2(this.seed ^ 0xf058, gx, gz) * 4294967296) | 0);
        const alongX = r() < 0.5;
        const len = 8 + ((r() * 9) | 0);
        const tall = 6 + ((r() * 9) | 0);
        const wide = 3 + ((r() * 3) | 0);
        const base = fy - 2 - ((r() * 3) | 0); // partly buried
        for (let a = 0; a <= len; a++) {
          const s = a / len;
          const sh = Math.round(tall * Math.pow(Math.sin(Math.PI * (0.08 + 0.84 * s)), 0.6));
          const along = a - (len >> 1);
          const at = (p: number, hgt: number): void => {
            this.put(chunk, alongX ? ox + along : ox + p, base + hgt, alongX ? oz + p : oz + along, this.bone, true);
          };
          at(0, sh); // spine
          if (a % 2 === 0 && a > 1 && a < len - 1) {
            // a rib: a half-ellipse from the spine down to the ground each side
            const w = Math.max(2, Math.round(wide * (0.7 + 0.3 * Math.sin(s * Math.PI))));
            for (let t = 0; t <= Math.PI; t += 0.04) at(Math.round(Math.cos(t) * w), Math.round(Math.sin(t) * sh));
          }
        }
        // a skull-ish knot at the head end
        const hx = alongX ? ox - (len >> 1) - 1 : ox, hz = alongX ? oz : oz - (len >> 1) - 1;
        const hy = base + Math.round(tall * 0.45);
        for (let dy = 0; dy < 2; dy++) for (let d = -1; d <= 1; d++) {
          this.put(chunk, alongX ? hx : hx + d, hy + dy, alongX ? hz + d : hz, this.bone, true);
        }
      }
    }
  }

  /** Huge crimson/warped fungi: a stem under a dome of wart blocks with
   *  shroomlights glowing inside and (crimson) weeping vines under the rim. */
  private fungi(chunk: Chunk, bx: number, bz: number): void {
    const C = 6, M = 6;
    for (let gz = Math.floor((bz - M) / C); gz <= Math.floor((bz + CZ + M) / C); gz++) {
      for (let gx = Math.floor((bx - M) / C); gx <= Math.floor((bx + CX + M) / C); gx++) {
        if (hash2(this.seed ^ 0xf001, gx, gz) > 0.26) continue;
        const ox = gx * C + Math.floor(hash2(this.seed ^ 0xf002, gx, gz) * C);
        const oz = gz * C + Math.floor(hash2(this.seed ^ 0xf003, gx, gz) * C);
        const b = this.biomeIndex(ox, oz);
        if (b !== CRIMSON && b !== WARPED) continue;
        const fy = this.floorAt(ox, oz);
        if (fy < 0) continue;
        this.hugeFungus(chunk, ox, fy, oz, b === WARPED, mulberry32((hash2(this.seed ^ 0xf004, gx, gz) * 4294967296) | 0));
      }
    }
  }

  private hugeFungus(chunk: Chunk, ox: number, oy: number, oz: number, warped: boolean, r: () => number): void {
    const stem = warped ? B.WARPED_STEM : B.CRIMSON_STEM;
    const wart = warped ? B.WARPED_WART_BLOCK : B.NETHER_WART_BLOCK;
    let hgt = 4 + ((r() * 9) | 0);
    if (r() < 0.07) hgt *= 2;
    // fit under the ceiling
    let gap = 0;
    while (gap < 32 && this.densityAt(ox, oy + gap, oz) <= 0) gap++;
    hgt = Math.min(hgt, gap - 3);
    if (hgt < 4) return;
    const R = hgt >= 11 ? 3 : hgt >= 7 ? 2 + (r() < 0.5 ? 1 : 0) : 2;
    const top = oy + hgt;
    const capH = Math.min(hgt - 1, R + 1 + ((r() * 2) | 0));
    const thick = hgt >= 10 && r() < 0.4;
    for (let y = oy; y < top; y++) {
      this.put(chunk, ox, y, oz, stem);
      if (thick && y < top - capH) for (const [dx, dz] of NB4) this.put(chunk, ox + dx, y, oz + dz, stem);
    }
    for (let k = 0; k <= capH; k++) {
      const y = top - k;
      const rr = k === 0 ? R - 1 : R;
      const bottom = k >= capH - 1;
      for (let dz = -rr; dz <= rr; dz++) {
        for (let dx = -rr; dx <= rr; dx++) {
          const wx = ox + dx, wz = oz + dz;
          const edge = Math.abs(dx) === rr || Math.abs(dz) === rr;
          const corner = Math.abs(dx) === rr && Math.abs(dz) === rr;
          const h = hash3(this.seed ^ 0xf0a, wx, y, wz);
          if (k === capH) {
            // ragged lower rim: only some edge cells hang this low
            if (!edge || corner || h > 0.45) continue;
          } else if (corner && (k === 0 || h < 0.6)) continue;
          if (k <= 1 || edge) {
            if (edge && bottom && k < capH && h < 0.12) continue;
            this.put(chunk, wx, y, wz, h < 0.05 && k > 0 ? B.SHROOMLIGHT : wart);
            if (!warped && edge && bottom && h > 0.72) this.vine(chunk, wx, y - 1, wz, 1 + ((h * 30) % 5 | 0));
          } else if (k === 2 && h < 0.16) {
            // shroomlights nestle under the dome's crown
            this.put(chunk, wx, y, wz, B.SHROOMLIGHT);
          }
        }
      }
    }
  }

  /** Weeping vine hanging down from (wx, y, wz) while the cells are open. */
  private vine(chunk: Chunk, wx: number, y: number, wz: number, len: number): void {
    const x = wx - chunk.cx * CX, z = wz - chunk.cz * CZ;
    if (x < 0 || x >= CX || z < 0 || z >= CZ) return;
    for (let k = 0; k < len && y - k > LAVA_SEA && chunk.get(x, y - k, z) === B.AIR; k++) chunk.setRaw(x, y - k, z, B.WEEPING_VINES);
  }

  /** Lowest air cell under a ceiling in a local column (scanning down from the
   *  roof), or -1 when that ceiling is too low to decorate. */
  private ceilingCell(chunk: Chunk, x: number, z: number, minY: number): number {
    let y = CY - 6;
    while (y > minY && chunk.get(x, y, z) !== B.AIR) y--;
    if (y <= minY) return -1;
    const above = chunk.get(x, y + 1, z);
    return above === B.AIR || above === B.BEDROCK ? -1 : y;
  }

  /** Glowstone clusters dangling from the ceiling, grown like vanilla's: a
   *  random walk that only adds cells touching exactly one existing crystal. */
  private glowstone(chunk: Chunk, rand: () => number, attempts: number): void {
    for (let i = 0; i < attempts; i++) {
      const x0 = 3 + ((rand() * 10) | 0), z0 = 3 + ((rand() * 10) | 0);
      const y0 = this.ceilingCell(chunk, x0, z0, 56);
      if (y0 < 0 || rand() < 0.25) continue;
      chunk.setRaw(x0, y0, z0, B.GLOWSTONE);
      for (let t = 0; t < 200; t++) {
        const x = x0 + ((rand() * 7) | 0) - 3, y = y0 - ((rand() * 8) | 0), z = z0 + ((rand() * 7) | 0) - 3;
        if (!NetherGen.inside(x, y, z) || chunk.get(x, y, z) !== B.AIR) continue;
        let n = 0;
        for (const [dx, dy, dz] of NB6) if (chunk.get(x + dx, y + dy, z + dz) === B.GLOWSTONE) n++;
        if (n === 1) chunk.setRaw(x, y, z, B.GLOWSTONE);
      }
    }
  }

  /** Stalactites: tapering netherrack (basalt in the deltas) spikes hanging
   *  from the roof, some tipped with glowstone. */
  private stalactites(chunk: Chunk, rand: () => number, attempts: number, biome: number): void {
    const mat = biome === BASALT ? B.BASALT : B.NETHERRACK;
    for (let i = 0; i < attempts; i++) {
      const x = 1 + ((rand() * 14) | 0), z = 1 + ((rand() * 14) | 0);
      const y0 = this.ceilingCell(chunk, x, z, 50);
      const len = 3 + ((rand() * 11) | 0);
      const glow = biome !== BASALT && rand() < 0.3;
      if (y0 < 0) continue;
      for (let k = 0; k < len; k++) {
        const y = y0 - k;
        if (y <= LAVA_SEA + 4 || chunk.get(x, y, z) !== B.AIR) break;
        chunk.setRaw(x, y, z, glow && k === len - 1 ? B.GLOWSTONE : mat);
        if (len >= 7 && k < len * 0.4) {
          for (const [dx, dz] of NB4) if (chunk.get(x + dx, y, z + dz) === B.AIR) chunk.setRaw(x + dx, y, z + dz, mat);
        }
      }
    }
  }

  /** Lava falls: a spring in a cliff face pouring a column down to the floor. */
  private lavaFalls(chunk: Chunk, rand: () => number, attempts: number): void {
    for (let i = 0; i < attempts; i++) {
      const x = 1 + ((rand() * 14) | 0), z = 1 + ((rand() * 14) | 0), y = 42 + ((rand() * 64) | 0);
      const [dx, dz] = NB4[(rand() * 4) | 0];
      const id = chunk.get(x, y, z);
      if (id === B.AIR || id === B.LAVA || id === B.BEDROCK || chunk.get(x, y + 1, z) === B.AIR) continue;
      if (chunk.get(x + dx, y, z + dz) !== B.AIR || chunk.get(x + dx, y - 1, z + dz) !== B.AIR) continue;
      chunk.setRaw(x, y, z, B.LAVA);
      let yy = y;
      while (yy > 0 && chunk.get(x + dx, yy, z + dz) === B.AIR) chunk.setRaw(x + dx, yy--, z + dz, B.LAVA);
      // scorch the landing
      const land = chunk.get(x + dx, yy, z + dz);
      if (land !== B.LAVA && land !== B.BEDROCK) chunk.setRaw(x + dx, yy, z + dz, B.MAGMA);
    }
  }
}

const NB4: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const NB6: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
/** cells a feature may grow into without `force` */
const SOFT = new Set<number>([B.AIR, B.FIRE, B.CRIMSON_ROOTS, B.WARPED_ROOTS, B.WEEPING_VINES, B.TWISTING_VINES]);

/** Trilinear density from four lattice columns (x0z0, x1z0, x0z1, x1z1). */
function tri(a: LatticeCol, b: LatticeCol, c: LatticeCol, d: LatticeCol, fx: number, fz: number, y: number): number {
  const iy = y >> 2, fy = (y & 3) * 0.25;
  const lo = bil(a[iy], b[iy], c[iy], d[iy], fx, fz);
  const hi = bil(a[iy + 1], b[iy + 1], c[iy + 1], d[iy + 1], fx, fz);
  return lo + (hi - lo) * fy;
}
function bil(a: number, b: number, c: number, d: number, fx: number, fz: number): number {
  const ab = a + (b - a) * fx, cd = c + (d - c) * fx;
  return ab + (cd - ab) * fz;
}
