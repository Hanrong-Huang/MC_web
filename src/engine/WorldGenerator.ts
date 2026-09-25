// Procedural terrain. Heights come from a few layered climate-style fields:
// continentalness (ocean → coast → inland), erosion (flat plains vs rugged
// massifs), ridge lines (mountain peaks), a terraced plateau mask, meandering
// river valleys and lowland lakes. Temperature/humidity pick the biome; the
// surface is chosen per column from biome + altitude + local slope (snow line,
// bare rock on cliffs, beaches, gravelly riverbeds). Caves are interpolated
// from a coarse 3D lattice, ores come in small vein clusters, and a
// vegetation + structure pass decorates the chunk with deterministic,
// cross-chunk-safe writes.

import { Simplex2, Simplex3, hash2, hash3, mulberry32, smoothstep, spline } from './Noise';
import { Chunk, CX, CZ, CY } from './Chunk';
import { B } from './Blocks';
import type { DoorState } from './World';

// Raised well above bedrock (y=0) so there's a deep stone column to mine through.
export const SEA_LEVEL = 64;

export type BiomeId = 'plains' | 'forest' | 'desert' | 'snow' | 'taiga' | 'swamp' | 'mountains' | 'jungle';
const BIOMES: readonly BiomeId[] = ['plains', 'forest', 'desert', 'snow', 'taiga', 'swamp', 'mountains', 'jungle'];
const PLAINS = 0, FOREST = 1, DESERT = 2, SNOW = 3, TAIGA = 4, SWAMP = 5, MOUNTAINS = 6, JUNGLE = 7;

/** continentalness → base land height (deep ocean … coast … high inland) */
const CONT_KNOTS: ReadonlyArray<readonly [number, number]> = [
  [-1, SEA_LEVEL - 26], [-0.55, SEA_LEVEL - 20], [-0.36, SEA_LEVEL - 9], [-0.27, SEA_LEVEL - 2],
  [-0.2, SEA_LEVEL + 1], [-0.1, SEA_LEVEL + 3], [0.1, SEA_LEVEL + 6], [0.35, SEA_LEVEL + 11], [1, SEA_LEVEL + 22],
];

/** Side-data (door/torch/bed state) a structure wants attached to a block it wrote. */
export interface GenStateSink {
  doorStates: Map<string, DoorState>;
  torchFacings: Map<string, number>;
  bedFacings: Map<string, number>;
}

// Column cache: a direct-mapped 256x256 window keyed by world x/z. Structure,
// tree and slope lookups hit neighbouring columns many times per chunk.
const CACHE_N = 256 * 256;

// --- structure layout ------------------------------------------------------
const VILLAGE_CELL = 176;
/** unit steps for direction/side index 0=-z, 1=-x, 2=+z, 3=+x (door/bed facing codes) */
const DIR_X = [0, -1, 0, 1];
const DIR_Z = [-1, 0, 1, 0];
/** direction index → World.torchFacings code (0=+x, 1=-x, 2=+z, 3=-z) */
const TORCH_FACING = [3, 1, 2, 0];

type PieceKind = 'well' | 'plaza' | 'house' | 'smithy' | 'farm' | 'lamp';
interface Piece {
  kind: PieceKind;
  x0: number; z0: number; sx: number; sz: number; // world footprint
  y: number;    // floor / ground level
  side: number; // door side (0=-z,1=-x,2=+z,3=+x)
  v: number;    // 0..1 variant roll
}
interface Style {
  found: number; floor: number; wall: number; wallAlt: number; base: number; post: number;
  roof: number; ridge: number; path: number; pathAlt: number; farmEdge: number; flat: boolean;
  /** lintel / sill trim around doors and windows (0 = none) */
  accent: number;
}
interface Village {
  cx: number; cz: number; style: Style; pieces: Piece[];
  roads: number[][]; // x0, z0, x1, z1 (inclusive)
  minX: number; maxX: number; minZ: number; maxZ: number;
}
const STYLE_OAK: Style = {
  found: B.COBBLE, floor: B.PLANKS, wall: B.PLANKS, wallAlt: B.WOOL, base: B.COBBLE, post: B.LOG,
  roof: B.PLANKS, ridge: B.LOG, path: B.GRAVEL, pathAlt: B.DIRT, farmEdge: B.LOG, flat: false, accent: 0,
};
const STYLE_SPRUCE: Style = {
  found: B.COBBLE, floor: B.PLANKS, wall: B.SPRUCE_LOG, wallAlt: B.PLANKS, base: B.COBBLE, post: B.LOG,
  roof: B.PLANKS, ridge: B.SPRUCE_LOG, path: B.GRAVEL, pathAlt: B.COBBLE, farmEdge: B.SPRUCE_LOG, flat: false, accent: 0,
};
const STYLE_DESERT: Style = {
  found: B.SANDSTONE, floor: B.SANDSTONE, wall: B.SANDSTONE, wallAlt: B.SANDSTONE, base: B.SANDSTONE, post: B.SANDSTONE,
  roof: B.SANDSTONE, ridge: B.SANDSTONE, path: B.SANDSTONE, pathAlt: B.GRAVEL, farmEdge: B.SANDSTONE, flat: true,
  accent: B.JUNGLE_LOG,
};

export class WorldGenerator {
  readonly seed: number;
  dimension: 'overworld' | 'nether' = 'overworld';
  private hills: Simplex2;
  private continent: Simplex2;
  private ridge: Simplex2;
  private temp: Simplex2;
  private humid: Simplex2;
  private cave1: Simplex3;
  private cave2: Simplex3;
  private river: Simplex2;
  private erosion: Simplex2;
  private detail: Simplex2;
  private ravine: Simplex2;
  private plateau: Simplex2;
  private lake: Simplex2;
  private patch: Simplex2;
  private flora: Simplex2;
  /** villager spawn positions queued by village generation (consumed by EntityManager) */
  villageSpawns: { x: number; y: number; z: number }[] = [];
  /** door/torch/bed side-state written by the last generate(); World drains it */
  private pendingDoors: [string, DoorState][] = [];
  private pendingTorches: [string, number][] = [];
  private pendingBeds: [string, number][] = [];

  // column cache (see CACHE_N)
  private cKx = new Int32Array(CACHE_N).fill(0x7fffffff);
  private cKz = new Int32Array(CACHE_N);
  private cH = new Int16Array(CACHE_N);
  private cB = new Uint8Array(CACHE_N);
  private cT = new Float32Array(CACHE_N);
  private cM = new Float32Array(CACHE_N);
  private cP = new Float32Array(CACHE_N);
  private cR = new Float32Array(CACHE_N);

  constructor(seed: number) {
    this.seed = seed | 0;
    this.hills = new Simplex2(this.seed ^ 0x1357);
    this.continent = new Simplex2(this.seed ^ 0x2468);
    this.ridge = new Simplex2(this.seed ^ 0x9bdf);
    this.temp = new Simplex2(this.seed ^ 0x55aa);
    this.humid = new Simplex2(this.seed ^ 0x33cc);
    this.cave1 = new Simplex3(this.seed ^ 0x7e57);
    this.cave2 = new Simplex3(this.seed ^ 0x1ce5);
    this.river = new Simplex2(this.seed ^ 0x4afe);
    this.erosion = new Simplex2(this.seed ^ 0xe705);
    this.detail = new Simplex2(this.seed ^ 0xd37a);
    this.ravine = new Simplex2(this.seed ^ 0x5a17);
    this.plateau = new Simplex2(this.seed ^ 0x91a7);
    this.lake = new Simplex2(this.seed ^ 0x1a4e);
    this.patch = new Simplex2(this.seed ^ 0x9a7c);
    this.flora = new Simplex2(this.seed ^ 0xf102);
  }

  /** Move the door/torch/bed state written by generate() into the world's maps.
   *  Existing entries win (a door the player already opened stays open). */
  drainStates(sink: GenStateSink): void {
    for (const [k, v] of this.pendingDoors) if (!sink.doorStates.has(k)) sink.doorStates.set(k, v);
    for (const [k, v] of this.pendingTorches) if (!sink.torchFacings.has(k)) sink.torchFacings.set(k, v);
    for (const [k, v] of this.pendingBeds) if (!sink.bedFacings.has(k)) sink.bedFacings.set(k, v);
    this.pendingDoors.length = 0;
    this.pendingTorches.length = 0;
    this.pendingBeds.length = 0;
  }

  /** 0..1 strength of a rare, deep, meandering ravine slot at this column
   *  (1 = canyon centre, 0 = outside). Like rivers but far rarer and carved
   *  down into bedrock-deep stone rather than filled with water. */
  ravineMask(wx: number, wz: number): number {
    // gated by a second, coarser field so ravines come in rare stretches
    // instead of endless straight cuts across the map
    const gate = smoothstep(0.15, 0.45, this.ravine.noise(wx * 0.0021 + 71.3, wz * 0.0021 - 12.9));
    if (gate <= 0) return 0;
    const n = Math.abs(this.ravine.fbm(wx * 0.0016, wz * 0.0016, 3));
    const HALF_WIDTH = 0.011 * gate;
    if (n >= HALF_WIDTH) return 0;
    const t = 1 - n / HALF_WIDTH;
    return t * t * (3 - 2 * t); // smoothstep: steep walls, flat floor
  }

  temperatureAt(wx: number, wz: number): number {
    // biomes stay fairly small so a single trek crosses several of them
    // broad climate zones (so snow and desert come as regions, not blobs)
    // with a finer regional wobble on top
    const n = this.temp.fbm(wx * 0.0009, wz * 0.0009, 3) * 0.68 + this.temp.noise(wx * 0.0035 + 170.3, wz * 0.0035 - 88.1) * 0.38;
    return Math.max(0, Math.min(1, n * 0.62 + 0.5));
  }

  humidityAt(wx: number, wz: number): number {
    const n = this.humid.fbm(wx * 0.001, wz * 0.001, 3) * 0.75 + this.humid.noise(wx * 0.004 - 61.7, wz * 0.004 + 23.9) * 0.3;
    return Math.max(0, Math.min(1, n * 0.62 + 0.5));
  }

  /** 0..1 mountain-ness (massif × ridge line) at a column. */
  mountainFactor(wx: number, wz: number): number {
    return this.cP[this.slot(wx, wz)];
  }

  /** 0..1, how strongly this column lies inside a meandering river channel. */
  riverFactor(wx: number, wz: number): number {
    return this.cR[this.slot(wx, wz)];
  }

  heightAt(wx: number, wz: number): number {
    return this.cH[this.slot(wx, wz)];
  }

  private slot(wx: number, wz: number): number {
    const i = (wx & 255) | ((wz & 255) << 8);
    if (this.cKx[i] !== wx || this.cKz[i] !== wz) this.fillColumn(i, wx, wz);
    return i;
  }

  /** Compute height, climate, mountain + river factors and biome of a column. */
  private fillColumn(i: number, wx: number, wz: number): void {
    const cont = this.continent.fbm(wx * 0.0011, wz * 0.0011, 4);
    const ero = this.erosion.fbm(wx * 0.0021, wz * 0.0021, 3) * 0.5 + 0.5;
    const pv = 1 - Math.abs(this.ridge.fbm(wx * 0.0024, wz * 0.0024, 4));
    const hills = this.hills.fbm(wx * 0.0068, wz * 0.0068, 4);
    const detail = this.detail.fbm(wx * 0.03, wz * 0.03, 2);
    const t = this.temperatureAt(wx, wz);
    const m = this.humidityAt(wx, wz);

    const inland = smoothstep(-0.24, 0.02, cont);
    let h = spline(CONT_KNOTS, cont);
    // rolling hills: gentle where erosion is high, rugged where it's low
    h += hills * (2.2 + (1 - ero) * 9 * (0.35 + 0.65 * inland)) + detail * 1.1;
    // mountain massifs sit in low-erosion country; ridge lines carry the peaks
    const massif = smoothstep(0.5, 0.78, 1 - ero) * inland;
    const peak = massif * (0.25 + 0.75 * pv * pv);
    h += Math.pow(peak, 1.4) * 66;
    // crags: ridged mid-frequency relief so massifs aren't smooth domes
    if (peak > 0.05) {
      const crag = 1 - Math.abs(this.hills.noise(wx * 0.019 + 311.7, wz * 0.019 - 57.1));
      h += (crag * crag - 0.45) * 13 * smoothstep(0.05, 0.5, peak) + detail * 3 * peak;
      // alpine ledges: high slopes break into 3-block shelves where snow can settle
      const alp = smoothstep(94, 108, h);
      if (alp > 0) {
        const s = h / 3, f = s - Math.floor(s);
        h += ((Math.floor(s) + smoothstep(0.25, 0.75, f)) * 3 - h) * alp * 0.85;
      }
    }

    // terraced plateaus: flat-topped uplands with stepped cliff edges
    const plat = smoothstep(0.46, 0.6, this.plateau.fbm(wx * 0.0028, wz * 0.0028, 2)) * inland *
      (1 - smoothstep(0.15, 0.4, peak));
    if (plat > 0) {
      const s = (h + 17 + hills * 3) / 7;
      const f = s - Math.floor(s);
      const terraced = (Math.floor(s) + smoothstep(0.4, 0.85, f)) * 7;
      h += (terraced - h) * plat;
    }

    // hot + dry: broad, low dunes instead of noisy grassy hills
    const dry = smoothstep(0.56, 0.66, t) * smoothstep(0.46, 0.38, m) * (1 - smoothstep(0.1, 0.3, peak));
    if (dry > 0) {
      const dune = Math.sin(wx * 0.07 + this.seed) * Math.cos(wz * 0.045 - this.seed * 0.5);
      const duneH = h * 0.85 + (SEA_LEVEL + 5 + inland * 4) * 0.15 + dune * 2.6;
      h += (duneH - h) * dry * (1 - plat);
    }
    // swamp basins sit near sea level with shallow, flat waterlogged ground
    const swampK = smoothstep(0.38, 0.44, t) * smoothstep(0.68, 0.76, m) * smoothstep(0.35, 0.1, cont) *
      (1 - smoothstep(0.05, 0.2, peak));
    if (swampK > 0) {
      // hovering right at sea level: roughly half the ground floods into
      // shallow, irregular pools between muddy hummocks
      const swampH = SEA_LEVEL - 0.2 + hills * 2.2 + detail * 1.4;
      h += (swampH - h) * swampK * 0.8;
    }

    // lowland lakes: noise basins carved below sea level wherever the ground is low
    const lk = smoothstep(0.5, 0.64, this.lake.fbm(wx * 0.0055, wz * 0.0055, 2)) *
      (1 - smoothstep(0.08, 0.25, peak)) * smoothstep(SEA_LEVEL + 18, SEA_LEVEL + 9, h);
    if (lk > 0) h += (SEA_LEVEL - 2 - lk * 4 - h) * lk;

    // rivers: a broad valley that pulls the banks down, then the channel itself
    const rn = Math.abs(this.river.fbm(wx * 0.0011, wz * 0.0011, 2));
    const tame = 1 - smoothstep(0.3, 0.55, peak); // rivers peter out in high massifs
    const valley = (1 - smoothstep(0.03, 0.1, rn)) * tame;
    if (valley > 0 && h > SEA_LEVEL + 2) {
      const bank = SEA_LEVEL + 2 + (h - SEA_LEVEL - 2) * 0.35;
      h += (bank - h) * valley * 0.75;
    }
    let rv = 0;
    const HALF_WIDTH = 0.032;
    if (rn < HALF_WIDTH) {
      const k = 1 - rn / HALF_WIDTH;
      rv = k * k * (3 - 2 * k) * tame;
      const bed = SEA_LEVEL - 1 - rv * 3;
      h += (Math.min(h, bed) - h) * rv;
    }

    const hi = Math.max(4, Math.min(CY - 10, Math.floor(h)));
    this.cKx[i] = wx; this.cKz[i] = wz;
    this.cH[i] = hi;
    this.cT[i] = t; this.cM[i] = m;
    this.cP[i] = peak; this.cR[i] = rv;
    this.cB[i] = this.pickBiome(hi, t + detail * 0.012, m - detail * 0.012, peak);
  }

  private pickBiome(h: number, t: number, m: number, peak: number): number {
    if (peak > 0.42 || h > 98) return h > 118 || t < 0.32 ? SNOW : MOUNTAINS;
    if (t < 0.3) return SNOW;
    if (t < 0.43 && m > 0.45) return TAIGA;
    if (t > 0.6 && m < 0.42 && h < SEA_LEVEL + 30) return DESERT;
    if (t > 0.4 && m > 0.72 && h <= SEA_LEVEL + 6) return SWAMP;
    if (t > 0.56 && m > 0.62 && h < SEA_LEVEL + 24) return JUNGLE; // hot + very humid lowlands
    if (m > 0.52) return FOREST;
    return PLAINS;
  }

  /** Per-column grass/foliage tint multiplier (warm-dry, lush, cold-pale). */
  grassTint(wx: number, wz: number, out: { r: number; g: number; b: number }): void {
    const i = this.slot(wx, wz);
    const t = this.cT[i];
    const m = this.cM[i];
    // dry climates push yellow, humidity pushes deep green, cold washes pale-blue
    out.r = Math.min(1.15, 0.78 + (1 - m) * 0.34);
    out.g = 1.0;
    out.b = 0.55 + (1 - t) * 0.4;
    if (t < 0.32) { // cold fade
      const k = (0.32 - t) / 0.32;
      out.r = out.r * (1 - k) + 0.85 * k;
      out.b = Math.min(1, out.b + k * 0.15);
    }
    // swamps read murky olive
    if (this.cB[i] === SWAMP) { out.r *= 0.86; out.g *= 0.92; out.b *= 0.72; }
  }

  biomeAt(wx: number, wz: number): BiomeId {
    return BIOMES[this.cB[this.slot(wx, wz)]];
  }

  private biomeIdx(wx: number, wz: number): number {
    return this.cB[this.slot(wx, wz)];
  }

  /** Surface y (top non-air) at world column — generator view, ignores edits. */
  surfaceY(wx: number, wz: number): number {
    return Math.max(this.heightAt(wx, wz), SEA_LEVEL);
  }

  /** Largest height step to a 4-neighbour (0 = flat). */
  private slopeAt(wx: number, wz: number, h: number): number {
    const a = this.heightAt(wx + 1, wz), b = this.heightAt(wx - 1, wz);
    const c = this.heightAt(wx, wz + 1), d = this.heightAt(wx, wz - 1);
    this.sDrop = h - Math.min(a, b, c, d);
    return Math.max(Math.abs(h - a), Math.abs(h - b), Math.abs(h - c), Math.abs(h - d));
  }
  /** set by slopeAt: how far the lowest 4-neighbour sits below the column */
  private sDrop = 0;

  // surface-rule outputs (scratch, avoids allocating per column)
  private sTop = 0;
  private sFill = 0;
  private sDepth = 0;
  private sUnder = 0;
  private sUnderDepth = 0;

  /** Pick top / filler / under-layer blocks for a column from biome, altitude,
   *  slope and a couple of patch noises. Pure function of the column. */
  private surfaceRule(wx: number, wz: number): void {
    const i = this.slot(wx, wz);
    const h = this.cH[i], b = this.cB[i], t = this.cT[i], peak = this.cP[i];
    const slope = this.slopeAt(wx, wz, h);
    const pat = this.patch.noise(wx * 0.07, wz * 0.07);
    const r = hash2(this.seed ^ 0x5e0d, wx, wz);
    this.sDepth = 3 + (pat > 0.2 ? 1 : 0) + (r < 0.35 ? 1 : 0);
    this.sUnder = B.STONE; this.sUnderDepth = 0;

    if (h < SEA_LEVEL) { // lake, river and sea floors
      if (b === SWAMP) { this.sTop = B.DIRT; this.sFill = B.DIRT; }
      else if (pat > 0.3 || (h < SEA_LEVEL - 9 && pat > -0.1)) { this.sTop = B.GRAVEL; this.sFill = B.GRAVEL; this.sDepth = 2; }
      else if (pat < -0.45 && h >= SEA_LEVEL - 3) { this.sTop = B.DIRT; this.sFill = B.DIRT; }
      else { this.sTop = B.SAND; this.sFill = B.SAND; this.sUnder = B.SANDSTONE; this.sUnderDepth = 2; }
      return;
    }
    const snowLine = 104 + (t - 0.5) * 60 + this.detail.noise(wx * 0.05, wz * 0.05) * 4;
    const steep = slope >= 4 || (slope >= 3 && h > SEA_LEVEL + 22);
    if (b === DESERT) {
      if (steep) { this.sTop = B.SANDSTONE; this.sFill = B.SANDSTONE; this.sDepth = 6; return; }
      this.sTop = B.SAND; this.sFill = B.SAND; this.sUnder = B.SANDSTONE; this.sUnderDepth = 3;
      return;
    }
    const beach = h <= SEA_LEVEL + 2 && slope <= 2 && b !== SWAMP && peak < 0.3 && pat > -0.35;
    if (beach) {
      if (pat > 0.5) { this.sTop = B.GRAVEL; this.sFill = B.GRAVEL; this.sDepth = 3; return; }
      this.sTop = B.SAND; this.sFill = B.SAND; this.sUnder = B.SANDSTONE; this.sUnderDepth = 2;
      return;
    }
    const rocky = peak > 0.3;
    if (steep) { this.sTop = B.STONE; this.sFill = B.STONE; return; }
    if (h >= snowLine || b === SNOW) {
      // on rock, snow only settles where no side face is exposed — a snowy
      // grass block's dirt flank on every step reads as brown stripes
      const settles = rocky ? this.sDrop <= 0 || (this.sDrop <= 1 && pat > -0.1) : slope <= 2;
      this.sTop = settles ? B.SNOW_GRASS : B.STONE;
      this.sFill = rocky ? B.STONE : B.DIRT;
      return;
    }
    const rockLine = 88 + (t - 0.5) * 12 + pat * 5;
    if (rocky && h >= rockLine) {
      this.sTop = pat > 0.4 && slope <= 1 ? B.GRAVEL : B.STONE;
      this.sFill = B.STONE;
      return;
    }
    this.sTop = B.GRASS; this.sFill = B.DIRT;
    if (b === TAIGA && pat > 0.55 && slope <= 1) this.sTop = B.DIRT; // bare needle-litter patches
    if (b === SWAMP && h <= SEA_LEVEL) this.sTop = B.DIRT;
    // highland soil is a thin skin: where a step face is exposed, show rock
    // under the turf instead of brown dirt bands
    if (rocky || h > SEA_LEVEL + 24) {
      this.sDepth = 2;
      if (slope >= 2) this.sFill = B.STONE;
    }
  }

  findSpawn(): { x: number; y: number; z: number } {
    const isGood = (wx: number, wz: number): number | null => {
      const h = this.heightAt(wx, wz);
      const biome = this.biomeAt(wx, wz);
      if (h < SEA_LEVEL + 2 || h > 80 || biome === 'snow' || biome === 'forest' || biome === 'swamp' ||
        biome === 'jungle') return null;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nh = this.heightAt(wx + dx, wz + dz);
          if (Math.abs(nh - h) > 1 || nh < SEA_LEVEL + 1) return null;
        }
      }
      return h;
    };

    for (let r = 0; r <= 160; r += 4) {
      for (let dz = -r; dz <= r; dz += 4) {
        for (let dx = -r; dx <= r; dx += 4) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          const h = isGood(dx, dz);
          if (h !== null) return { x: dx + 0.5, y: h + 2, z: dz + 0.5 };
        }
      }
    }
    for (let r = 0; r < 64; r++) {
      const wx = r * 7, wz = (r % 3) * 11;
      const h = this.heightAt(wx, wz);
      if (h >= SEA_LEVEL + 1 && this.biomeAt(wx, wz) !== 'snow') return { x: wx + 0.5, y: h + 2, z: wz + 0.5 };
    }
    return { x: 0.5, y: this.heightAt(0, 0) + 2, z: 0.5 };
  }

  // --- caves ----------------------------------------------------------------
  // Three 3D fields sampled on a 4-block lattice and trilinearly interpolated:
  // two ridged "spaghetti" fields whose intersection forms tunnels, plus a
  // low-frequency "cheese" field for caverns. ~20x cheaper than per-voxel noise.
  private caveGrid = new Float32Array(5 * 5 * 41 * 3);
  private caveCol = new Float32Array(41 * 3);

  private buildCaveGrid(bx: number, bz: number, maxY: number): number {
    const ny = Math.min(40, (maxY >> 2) + 1);
    const g = this.caveGrid;
    for (let gz = 0; gz < 5; gz++) {
      for (let gx = 0; gx < 5; gx++) {
        const wx = bx + gx * 4, wz = bz + gz * 4;
        for (let gy = 0; gy <= ny; gy++) {
          const wy = gy * 4;
          const o = ((gz * 5 + gx) * 41 + gy) * 3;
          g[o] = this.cave1.noise(wx * 0.034, wy * 0.052, wz * 0.034);
          g[o + 1] = this.cave2.noise(wx * 0.027, wy * 0.045, wz * 0.027);
          g[o + 2] = this.cave1.noise(wx * 0.015, wy * 0.028, wz * 0.015);
        }
      }
    }
    return ny;
  }

  /** Bilinear column of the cave lattice at local x/z into caveCol. */
  private caveColumn(x: number, z: number, ny: number): void {
    const gx = x >> 2, gz = z >> 2, fx = (x & 3) / 4, fz = (z & 3) / 4;
    const g = this.caveGrid, c = this.caveCol;
    const o00 = (gz * 5 + gx) * 41 * 3, o10 = (gz * 5 + gx + 1) * 41 * 3;
    const o01 = ((gz + 1) * 5 + gx) * 41 * 3, o11 = ((gz + 1) * 5 + gx + 1) * 41 * 3;
    const w00 = (1 - fx) * (1 - fz), w10 = fx * (1 - fz), w01 = (1 - fx) * fz, w11 = fx * fz;
    for (let k = 0; k <= ny * 3 + 2; k++) {
      c[k] = g[o00 + k] * w00 + g[o10 + k] * w10 + g[o01 + k] * w01 + g[o11 + k] * w11;
    }
  }

  /** 0 = solid, 1 = tunnel, 2 = cavern at height y of the current caveCol. */
  private caveAt(y: number): number {
    const gy = y >> 2, f = (y & 3) / 4;
    const c = this.caveCol, o = gy * 3;
    const n1 = c[o] + (c[o + 3] - c[o]) * f;
    if (Math.abs(n1) < 0.085) {
      const n2 = c[o + 1] + (c[o + 4] - c[o + 1]) * f;
      if (Math.abs(n2) < 0.085) return 1;
    }
    const n3 = c[o + 2] + (c[o + 5] - c[o + 2]) * f;
    return n3 > 0.62 ? 2 : 0;
  }

  // --- ores -----------------------------------------------------------------
  private oreCx = 0x7fffffff;
  private oreCy = 0;
  private oreCz = 0;
  private oreId = 0;

  /** Which ore (if any) a 4x4x4 cell hosts, banded by the cell's mid height;
   *  rarer and deeper toward the top of the list. */
  private pickOre(cx: number, cy: number, cz: number): number {
    const y = cy * 4 + 2;
    const roll = hash3(this.seed ^ 0x0e51, cx, cy, cz);
    let acc = 0;
    if (y <= 30 && roll < (acc += 0.022)) return B.DIAMOND_ORE;
    if (y >= 4 && y <= 56 && roll < (acc += 0.03)) return B.GOLD_ORE;
    if (y >= 8 && y <= 64 && roll < (acc += 0.07)) return B.AMETHYST_ORE;
    if (y >= 6 && y <= 92 && roll < (acc += 0.085)) return B.IRON_ORE;
    if (y >= 20 && y <= 140 && roll < (acc += 0.11)) return B.COAL_ORE;
    return 0;
  }

  /** Ore (or 0) for a stone voxel. Each 4x4x4 cell may host one vein: a small
   *  randomly stretched ellipsoid of a depth-banded ore type. */
  private oreAt(wx: number, y: number, wz: number): number {
    const cx = wx >> 2, cy = y >> 2, cz = wz >> 2;
    // consecutive voxels of a column share a cell: memoize its ore pick
    if (cx !== this.oreCx || cy !== this.oreCy || cz !== this.oreCz) {
      this.oreCx = cx; this.oreCy = cy; this.oreCz = cz;
      this.oreId = this.pickOre(cx, cy, cz);
    }
    const id = this.oreId;
    if (!id) return 0;
    // vein ellipsoid inside the cell (bigger for common ores)
    const big = id === B.COAL_ORE ? 1.35 : id === B.IRON_ORE ? 1.15 : 1;
    const ex = cx * 4 + 0.5 + hash3(this.seed ^ 0x0e52, cx, cy, cz) * 3;
    const ey = cy * 4 + 0.5 + hash3(this.seed ^ 0x0e53, cx, cy, cz) * 3;
    const ez = cz * 4 + 0.5 + hash3(this.seed ^ 0x0e54, cx, cy, cz) * 3;
    const s = hash3(this.seed ^ 0x0e55, cx, cy, cz);
    const rx = (0.8 + s * 1.5) * big, ry = (0.7 + (1 - s) * 0.9) * big, rz = (0.8 + (1 - s) * 1.4) * big;
    const dx = (wx + 0.5 - ex) / rx, dy = (y + 0.5 - ey) / ry, dz = (wz + 0.5 - ez) / rz;
    if (dx * dx + dy * dy + dz * dz > 1) return 0;
    return hash3(this.seed ^ 0x0e56, wx, y, wz) < 0.88 ? id : 0;
  }

  generate(chunk: Chunk): void {
    const bx = chunk.cx * CX;
    const bz = chunk.cz * CZ;

    if (this.dimension === 'nether') {
      const randSeed = this.seed ^ 0x6e74;
      for (let z = 0; z < CZ; z++) {
        for (let x = 0; x < CX; x++) {
          const wx = bx + x, wz = bz + z;
          
          chunk.setRaw(x, 0, z, B.BEDROCK);
          chunk.setRaw(x, CY - 1, z, B.BEDROCK);

          for (let y = 1; y < CY - 1; y++) {
            const n = this.cave1.noise(wx * 0.024, y * 0.04, wz * 0.024) +
                      this.cave2.noise(wx * 0.04, y * 0.024, wz * 0.04) * 0.5;

            // centre the open cavern on the taller world so it fills the new height
            const distToCenter = Math.abs(y - CY / 2) / (CY / 2);
            const threshold = -0.1 + distToCenter * 0.6;
            
            let id = B.AIR;
            if (n > threshold) {
              id = B.NETHERRACK;
              const r = hash3(this.seed ^ 0x111, wx, y, wz);
              if (r < 0.012) {
                id = B.QUARTZ_ORE;
              } else if (chunk.get(x, y - 1, z) === B.LAVA && r > 0.6) {
                id = B.MAGMA; // crusts the lava surface
              }
            } else {
              if (y <= 32) {
                id = B.LAVA;
              } else if (y >= 33 && y <= 36) {
                const sandNoise = this.hills.noise(wx * 0.05, wz * 0.05);
                if (sandNoise > 0.35) {
                  id = B.SOUL_SAND;
                }
              }
            }
            chunk.setRaw(x, y, z, id);
          }
        }
      }
      
      const rand = mulberry32(chunk.cx * 1000 + chunk.cz + this.seed);
      for (let z = 1; z < CZ - 1; z++) {
        for (let x = 1; x < CX - 1; x++) {
          if (rand() < 0.025) {
            for (let y = CY - 13; y >= 70; y--) {
              if (chunk.get(x, y, z) === B.NETHERRACK && chunk.get(x, y - 1, z) === B.AIR) {
                chunk.setRaw(x, y - 1, z, B.GLOWSTONE);
                if (rand() < 0.5) chunk.setRaw(x - 1, y - 1, z, B.GLOWSTONE);
                if (rand() < 0.5) chunk.setRaw(x + 1, y - 1, z, B.GLOWSTONE);
                if (rand() < 0.5) chunk.setRaw(x, y - 1, z + 1, B.GLOWSTONE);
                if (rand() < 0.5) chunk.setRaw(x, y - 2, z, B.GLOWSTONE);
                break;
              }
            }
          }
        }
      }
      chunk.computeHeightmap(); // mark ready like the overworld path does at the end
      chunk.scanTorches();
      chunk.ready = true;
      chunk.dirty = true;
      return;
    }

    // --- terrain columns -------------------------------------------------
    let maxH = SEA_LEVEL;
    for (let z = 0; z < CZ; z++) {
      for (let x = 0; x < CX; x++) maxH = Math.max(maxH, this.heightAt(bx + x, bz + z));
    }
    const ny = this.buildCaveGrid(bx, bz, maxH + 1);
    for (let z = 0; z < CZ; z++) {
      for (let x = 0; x < CX; x++) {
        const wx = bx + x, wz = bz + z;
        const h = this.heightAt(wx, wz);
        this.surfaceRule(wx, wz);
        const top = this.sTop, fill = this.sFill;
        const fillFrom = h - this.sDepth; // fill occupies (fillFrom, h)
        const underFrom = fillFrom - this.sUnderDepth, under = this.sUnder;
        // caves may breach dry surface (hillside entrances) but never near water;
        // big caverns stay a few blocks down so they don't swallow meadows
        const tunnelCeil = h < SEA_LEVEL + 2 ? h - 8 : h;
        const cavernCeil = h - 7;
        // ravine: a deep open slot. Only on dry land; the floor rises toward the
        // rim (high rvFloor at the edges) so the walls step down into a canyon.
        const rv = h >= SEA_LEVEL + 3 ? this.ravineMask(wx, wz) : 0;
        const rvFloor = rv > 0 ? 11 + Math.round((1 - rv) * 24) : CY;
        this.caveColumn(x, z, ny);

        chunk.setRaw(x, 0, z, B.BEDROCK);
        for (let y = 1; y <= h; y++) {
          // ragged bedrock floor
          if (y <= 3 && hash3(this.seed ^ 0xbed, wx, y, wz) < 0.62 - y * 0.18) { chunk.setRaw(x, y, z, B.BEDROCK); continue; }
          if (y > 3 && y <= tunnelCeil) {
            const cave = y >= rvFloor ? 1 : this.caveAt(y);
            if (cave === 1 || (cave === 2 && y <= cavernCeil)) {
              // deep caves/ravines below y=8 flood with lava; above that they stay airy
              if (y <= 8) chunk.setRaw(x, y, z, B.LAVA);
              continue;
            }
          }
          let id: number;
          if (y === h) id = top;
          else if (y > fillFrom) id = fill;
          else if (y > underFrom) id = under;
          else {
            id = B.STONE;
            const ore = this.oreAt(wx, y, wz);
            if (ore) id = ore;
            else {
              const blob = hash3(this.seed ^ 0xabc, wx >> 2, y >> 2, wz >> 2);
              if (blob < 0.014) {
                if (hash3(this.seed, wx, y, wz) < 0.8) id = y > 40 && blob < 0.006 ? B.DIRT : B.GRAVEL;
              } else if (y <= 16 && hash3(this.seed ^ 0x1a7a, wx, y, wz) < 0.003) id = B.LAVA; // rare deep lava pockets
            }
          }
          chunk.setRaw(x, y, z, id);
        }
        for (let y = h + 1; y <= SEA_LEVEL; y++) chunk.setRaw(x, y, z, B.WATER);
      }
    }

    // --- vegetation: trees, bushes, fallen logs ---------------------------
    // Candidates within a 6-block margin are visited in world order, so a
    // crown that straddles a border is written identically by both chunks.
    const TM = 6;
    for (let z = -TM; z < CZ + TM; z++) {
      for (let x = -TM; x < CX + TM; x++) {
        const wx = bx + x, wz = bz + z;
        const r = hash2(this.seed ^ 0x7777, wx, wz);
        if (r >= 0.09) continue; // above every biome's density: cheap early out
        this.plantAt(chunk, wx, wz, r);
      }
    }

    // --- ground cover: grass, flower meadows, cactus, dry shrubs, sugar cane --
    for (let z = 0; z < CZ; z++) {
      for (let x = 0; x < CX; x++) {
        const wx = bx + x, wz = bz + z;
        const h = this.heightAt(wx, wz);
        if (h < SEA_LEVEL || h > CY - 12) continue;
        if (chunk.get(x, h + 1, z) !== B.AIR) continue;
        const surface = chunk.get(x, h, z);
        const b = this.biomeIdx(wx, wz);
        const r = hash2(this.seed ^ 0xf10a, wx, wz);
        if (surface === B.GRASS) {
          // meadows: dense drifts of one flower colour, mixing at the edges
          const meadow = this.flora.noise(wx * 0.035 + 91.7, wz * 0.035 - 13.3);
          const lush = smoothstep(-0.5, 0.6, this.flora.noise(wx * 0.06 - 40.1, wz * 0.06 + 7.7));
          if ((b === PLAINS || b === FOREST) && meadow > 0.42 && r < (meadow - 0.42) * 0.9) {
            const tint = this.flora.noise(wx * 0.02 - 300, wz * 0.02 + 300) + (hash2(this.seed ^ 0xf10b, wx, wz) - 0.5) * 0.5;
            chunk.setRaw(x, h + 1, z, tint > 0 ? B.POPPY : B.DANDELION);
            continue;
          }
          const grass =
            b === PLAINS ? 0.1 + lush * 0.2 :
            b === JUNGLE ? 0.28 :
            b === FOREST || b === SWAMP ? 0.06 + lush * 0.12 :
            b === TAIGA ? 0.05 + lush * 0.1 : 0.03 + lush * 0.05;
          if (r < grass) chunk.setRaw(x, h + 1, z, B.TALL_GRASS);
          else if (b === JUNGLE && r < grass + 0.025) chunk.setRaw(x, h + 1, z, B.JUNGLE_LEAVES); // understory
          else if (r < grass + 0.008 && b !== TAIGA && b !== SWAMP && b !== MOUNTAINS) {
            chunk.setRaw(x, h + 1, z, hash2(this.seed ^ 0xf10c, wx, wz) < 0.5 ? B.POPPY : B.DANDELION);
          }
        } else if (surface === B.SAND && b === DESERT) {
          if (r < 0.0065 && this.cactusRoom(chunk, x, h, z)) {
            const tall = 1 + Math.floor(hash2(this.seed ^ 0xcac7, wx, wz) * 3);
            for (let dy = 1; dy <= tall; dy++) chunk.setRaw(x, h + dy, z, B.CACTUS);
          } else if (r > 0.985) {
            chunk.setRaw(x, h + 1, z, B.TALL_GRASS); // sun-bleached scrub (dry tint)
          }
        } else if (surface === B.SNOW_GRASS && b === TAIGA && r < 0.03) {
          chunk.setRaw(x, h + 1, z, B.TALL_GRASS);
        }
        // sugar cane on banks: low ground with adjacent water
        if ((surface === B.GRASS || surface === B.SAND || surface === B.DIRT) &&
          h >= SEA_LEVEL && h <= SEA_LEVEL + 1 && chunk.get(x, h + 1, z) === B.AIR &&
          hash2(this.seed ^ 0xca9e, wx, wz) < (b === SWAMP ? 0.16 : b === DESERT ? 0.12 : 0.07)) {
          const nearWater =
            this.heightAt(wx + 1, wz) < SEA_LEVEL || this.heightAt(wx - 1, wz) < SEA_LEVEL ||
            this.heightAt(wx, wz + 1) < SEA_LEVEL || this.heightAt(wx, wz - 1) < SEA_LEVEL;
          if (nearWater) {
            const tall = 2 + Math.floor(hash2(this.seed ^ 0xca9f, wx, wz) * 2);
            for (let dy = 1; dy <= tall; dy++) chunk.setRaw(x, h + dy, z, B.SUGAR_CANE);
          }
        }
      }
    }

    // --- structure pass: every structure whose origin chunk is within ±1 is
    // drawn (clipped to this chunk), so pieces up to ~16 blocks past their
    // origin chunk come out whole on both sides of a border.
    for (let scz = chunk.cz - 1; scz <= chunk.cz + 1; scz++) {
      for (let scx = chunk.cx - 1; scx <= chunk.cx + 1; scx++) this.structuresFrom(chunk, scx, scz);
    }
    this.placeVillages(chunk, bx, bz);


    chunk.computeHeightmap();
    chunk.scanTorches();
    chunk.ready = true;
    chunk.dirty = true;
  }

  /** Write a voxel into this chunk if the world position lands inside it. */
  private put(chunk: Chunk, wx: number, wy: number, wz: number, id: number, keepSolid = false): void {
    const x = wx - chunk.cx * CX;
    const z = wz - chunk.cz * CZ;
    if (x < 0 || x >= CX || z < 0 || z >= CZ || wy < 0 || wy >= CY) return;
    if (keepSolid && chunk.get(x, wy, z) !== B.AIR && chunk.get(x, wy, z) !== B.LEAVES) return;
    chunk.setRaw(x, wy, z, id);
  }

  /** No cactus touching another cactus (orthogonally) — keeps them readable. */
  private cactusRoom(chunk: Chunk, x: number, h: number, z: number): boolean {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (nx < 0 || nx >= CX || nz < 0 || nz >= CZ) continue;
      if (chunk.get(nx, h + 1, nz) === B.CACTUS) return false;
    }
    return true;
  }

  /** Decide whether a tree/bush/log grows from this column and place it. */
  private plantAt(chunk: Chunk, wx: number, wz: number, r: number): void {
    const i = this.slot(wx, wz);
    const b = this.cB[i], h = this.cH[i];
    if (b === DESERT) return;
    if (h < (b === SWAMP ? SEA_LEVEL - 1 : SEA_LEVEL) || h > 118) return;
    // groves and clearings: density swings across a forest instead of a uniform fuzz
    const dens = smoothstep(-0.55, 0.55, this.flora.noise(wx * 0.011, wz * 0.011));
    let chance: number;
    switch (b) {
      case FOREST: chance = 0.036 * (0.3 + 1.3 * dens); break;
      case PLAINS: chance = 0.0022 + 0.024 * smoothstep(0.62, 0.9, dens); break;
      case TAIGA: chance = 0.032 * (0.4 + dens); break;
      case SNOW: chance = 0.009 * (0.3 + dens); break;
      case SWAMP: chance = 0.017; break;
      case JUNGLE: chance = 0.088; break;
      default: chance = this.cP[i] < 0.45 ? 0.012 : 0; // mountains: scattered firs low down
    }
    if (r >= chance) return;
    this.surfaceRule(wx, wz);
    const ground = this.sTop;
    if (h < SEA_LEVEL && b === SWAMP) { /* swamp oaks root in shallow water */ }
    else if (ground !== B.GRASS && ground !== B.SNOW_GRASS && ground !== B.DIRT) return;
    if (this.inVillage(wx, wz, 4)) return;
    const v = hash2(this.seed ^ 0x8888, wx, wz);
    const v2 = hash2(this.seed ^ 0x8889, wx, wz);
    const y = h + 1;
    switch (b) {
      case FOREST: {
        // birch groves: a low-frequency patch where pale birches dominate
        const birchy = this.flora.noise(wx * 0.006 + 555, wz * 0.006 - 555) > 0.25;
        if (v < 0.07) this.placeFallenLog(chunk, wx, y, wz, birchy ? B.BIRCH_LOG : B.LOG, v2);
        else if (v < 0.16) this.placeBush(chunk, wx, y, wz, B.LOG, birchy ? B.BIRCH_LEAVES : B.LEAVES, v2);
        else if (birchy ? v < 0.85 : v < 0.3) this.placeTree(chunk, wx, y, wz, 5 + Math.floor(v2 * 3), B.BIRCH_LOG, B.BIRCH_LEAVES);
        else if (v > 0.86 && !birchy) this.placeBigOak(chunk, wx, y, wz, v2);
        else this.placeTree(chunk, wx, y, wz, 4 + Math.floor(v2 * 3), B.LOG, B.LEAVES);
        break;
      }
      case PLAINS:
        if (v < 0.35) this.placeBush(chunk, wx, y, wz, B.LOG, B.LEAVES, v2);
        else if (v < 0.58) this.placeBigOak(chunk, wx, y, wz, v2);
        else if (v < 0.68) this.placeTree(chunk, wx, y, wz, 5 + Math.floor(v2 * 3), B.BIRCH_LOG, B.BIRCH_LEAVES);
        else this.placeTree(chunk, wx, y, wz, 4 + Math.floor(v2 * 3), B.LOG, B.LEAVES);
        break;
      case TAIGA:
      case SNOW:
      case MOUNTAINS:
        if (v < 0.08 && b === TAIGA) this.placeFallenLog(chunk, wx, y, wz, B.SPRUCE_LOG, v2);
        else if (v < 0.18) this.placeBush(chunk, wx, y, wz, B.SPRUCE_LOG, B.SPRUCE_LEAVES, v2);
        else if (v > 0.8 && b === TAIGA) this.placeSpruce(chunk, wx, y, wz, 11 + Math.floor(v2 * 5), true);
        else this.placeSpruce(chunk, wx, y, wz, 6 + Math.floor(v2 * 4), false);
        break;
      case SWAMP:
        this.placeSwampTree(chunk, wx, y, wz, 5 + Math.floor(v2 * 3));
        break;
      case JUNGLE:
        if (v < 0.07) this.placeGiantJungleTree(chunk, wx, y, wz, 18 + Math.floor(v2 * 9));
        else if (v < 0.34) this.placeBush(chunk, wx, y, wz, B.JUNGLE_LOG, B.JUNGLE_LEAVES, v2);
        else this.placeJungleTree(chunk, wx, y, wz, 7 + Math.floor(v2 * 8));
        break;
    }
  }

  /** Classic round oak/birch: two wide layers, two narrow layers, cross on top. */
  private placeTree(chunk: Chunk, wx: number, wy: number, wz: number, height: number, log: number, leaves: number): void {
    for (let dy = height - 3; dy <= height; dy++) {
      const rad = dy >= height - 1 ? 1 : 2;
      for (let dx = -rad; dx <= rad; dx++) {
        for (let dz = -rad; dz <= rad; dz++) {
          if (dx === 0 && dz === 0 && dy < height) continue;
          if (Math.abs(dx) === rad && Math.abs(dz) === rad) {
            // top layer is a plus; lower corners are randomly nibbled
            if (dy === height || hash3(this.seed ^ 0x4242, wx + dx, wy + dy, wz + dz) < 0.5) continue;
          }
          this.putIfAir(chunk, wx + dx, wy + dy, wz + dz, leaves);
        }
      }
    }
    for (let dy = 0; dy < height; dy++) this.put(chunk, wx, wy + dy, wz, log);
  }

  /** Leaf ellipsoid with a ragged edge. */
  private leafBlob(chunk: Chunk, cx: number, cy: number, cz: number, rh: number, rv: number, leaves: number): void {
    const R = Math.ceil(rh), V = Math.ceil(rv);
    for (let dy = -V; dy <= V; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        for (let dz = -R; dz <= R; dz++) {
          const d = (dx * dx + dz * dz) / (rh * rh) + (dy * dy) / (rv * rv);
          if (d > 1) continue;
          if (d > 0.62 && hash3(this.seed ^ 0x1eaf, cx + dx, cy + dy, cz + dz) < 0.4) continue;
          this.putIfAir(chunk, cx + dx, cy + dy, cz + dz, leaves);
        }
      }
    }
  }

  /** Big oak: tall trunk, 2-4 rising branches, each ending in a leaf cloud. */
  private placeBigOak(chunk: Chunk, wx: number, wy: number, wz: number, v: number): void {
    const height = 7 + Math.floor(v * 4);
    const branches = 2 + Math.floor(hash2(this.seed ^ 0xb1a0, wx, wz) * 3);
    for (let k = 0; k < branches; k++) {
      const a = (hash3(this.seed ^ 0xb1a1, wx, k, wz) + k / branches) * Math.PI * 2;
      const len = 2 + Math.floor(hash3(this.seed ^ 0xb1a2, wx, k, wz) * 2.5);
      const by = wy + Math.floor(height * 0.5) + Math.floor(hash3(this.seed ^ 0xb1a3, wx, k, wz) * (height * 0.35));
      let ex = wx, ez = wz, ey = by;
      for (let s = 1; s <= len; s++) {
        ex = wx + Math.round(Math.cos(a) * s);
        ez = wz + Math.round(Math.sin(a) * s);
        ey = by + (s >> 1);
        this.put(chunk, ex, ey, ez, B.LOG);
      }
      this.leafBlob(chunk, ex, ey + 1, ez, 2.4, 1.6, B.LEAVES);
    }
    this.leafBlob(chunk, wx, wy + height, wz, 2.9, 2.1, B.LEAVES);
    for (let dy = 0; dy < height; dy++) this.put(chunk, wx, wy + dy, wz, B.LOG);
    // root flare
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (hash2(this.seed ^ 0xb1a4, wx + dx, wz + dz) < 0.3 && this.heightAt(wx + dx, wz + dz) === wy - 1) {
        this.put(chunk, wx + dx, wy, wz + dz, B.LOG);
      }
    }
  }

  /** Low shrub: a stub of log under a squat leaf mound. */
  private placeBush(chunk: Chunk, wx: number, wy: number, wz: number, log: number, leaves: number, v: number): void {
    this.put(chunk, wx, wy, wz, log);
    const rh = 1.3 + v * 0.9;
    this.leafBlob(chunk, wx, wy, wz, rh, 1.25, leaves);
    this.putIfAir(chunk, wx, wy + 1, wz, leaves);
  }

  /** A toppled trunk lying along x or z beside its stump (stops at uneven ground). */
  private placeFallenLog(chunk: Chunk, wx: number, wy: number, wz: number, log: number, v: number): void {
    const alongX = v < 0.5;
    const len = 3 + Math.floor(hash2(this.seed ^ 0xfa11, wx, wz) * 3);
    this.put(chunk, wx, wy, wz, log); // stump
    for (let s = 2; s < 2 + len; s++) {
      const x = alongX ? wx + s : wx, z = alongX ? wz : wz + s;
      if (this.heightAt(x, z) !== wy - 1) break;
      this.put(chunk, x, wy, z, log);
    }
  }

  /** Conical spruce; `tall` makes a lanky one with a bare lower trunk. */
  private placeSpruce(chunk: Chunk, wx: number, wy: number, wz: number, height: number, tall: boolean): void {
    const start = tall ? Math.floor(height * 0.35) : 2;
    for (let dy = start; dy <= height + 1; dy++) {
      let rad: number;
      if (dy === height + 1) rad = 0;
      else if (dy >= height - 1) rad = 1;
      else if (tall) rad = (height - dy) % 3 === 0 ? 1 : dy < height * 0.6 ? 2 : 1;
      else rad = (height - dy) % 2 === 0 ? 2 : 1;
      if (!tall && dy === start && height >= 8) rad = 3; // wide bottom skirt
      for (let dx = -rad; dx <= rad; dx++) {
        for (let dz = -rad; dz <= rad; dz++) {
          if (dx === 0 && dz === 0 && dy <= height) continue;
          if (rad >= 2 && Math.abs(dx) === rad && Math.abs(dz) === rad) continue;
          if (rad === 3 && Math.abs(dx) + Math.abs(dz) > 4) continue;
          if (rad >= 2 && Math.abs(dx) + Math.abs(dz) === rad + 1 &&
            hash3(this.seed ^ 0x5b8c, wx + dx, wy + dy, wz + dz) < 0.35) continue;
          this.putIfAir(chunk, wx + dx, wy + dy, wz + dz, B.SPRUCE_LEAVES);
        }
      }
    }
    for (let dy = 0; dy < height; dy++) this.put(chunk, wx, wy + dy, wz, B.SPRUCE_LOG);
  }

  /** Tall jungle tree: a high JUNGLE_LOG trunk, a broad crown, and a couple of
   *  mid-height leaf clusters for that layered-canopy look. */
  private placeJungleTree(chunk: Chunk, wx: number, wy: number, wz: number, height: number): void {
    for (let dy = 0; dy < height; dy++) this.put(chunk, wx, wy + dy, wz, B.JUNGLE_LOG);
    for (let dy = height - 3; dy <= height; dy++) {
      const rad = dy >= height ? 1 : dy >= height - 1 ? 2 : 3;
      for (let dx = -rad; dx <= rad; dx++) {
        for (let dz = -rad; dz <= rad; dz++) {
          if (dx === 0 && dz === 0 && dy < height) continue;
          if (Math.abs(dx) + Math.abs(dz) > rad + 1) continue;
          if (Math.abs(dx) === rad && Math.abs(dz) === rad &&
            hash3(this.seed ^ 0x3c1a, wx + dx, wy + dy, wz + dz) < 0.5) continue;
          this.putIfAir(chunk, wx + dx, wy + dy, wz + dz, B.JUNGLE_LEAVES);
        }
      }
    }
    const midY = wy + Math.floor(height * 0.55);
    for (const [dx, dz] of [[1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      if (hash2(this.seed ^ 0x3c1b, wx + dx, wz + dz) < 0.55) {
        this.putIfAir(chunk, wx + dx, midY, wz + dz, B.JUNGLE_LEAVES);
        this.putIfAir(chunk, wx + dx, midY + 1, wz + dz, B.JUNGLE_LEAVES);
      }
    }
  }

  /** Emergent 2x2 jungle giant: thick trunk, side boughs, a wide flat crown. */
  private placeGiantJungleTree(chunk: Chunk, wx: number, wy: number, wz: number, height: number): void {
    for (let dy = -1; dy < height; dy++) {
      for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) this.put(chunk, wx + dx, wy + dy, wz + dz, B.JUNGLE_LOG);
    }
    // buttress roots
    for (const [dx, dz] of [[-1, 0], [2, 1], [0, 2], [1, -1]]) {
      if (hash2(this.seed ^ 0x61a7, wx + dx, wz + dz) < 0.6) {
        this.put(chunk, wx + dx, wy, wz + dz, B.JUNGLE_LOG);
        this.put(chunk, wx + dx, wy - 1, wz + dz, B.JUNGLE_LOG);
      }
    }
    const top = wy + height;
    this.leafBlob(chunk, wx, top - 1, wz, 5.2, 1.7, B.JUNGLE_LEAVES);
    this.leafBlob(chunk, wx + 1, top + 1, wz + 1, 3.2, 1.3, B.JUNGLE_LEAVES);
    for (let k = 0; k < 3; k++) {
      const a = (hash3(this.seed ^ 0x61a8, wx, k, wz) + k / 3) * Math.PI * 2;
      const by = wy + Math.floor(height * (0.45 + k * 0.12));
      const ex = wx + Math.round(Math.cos(a) * 3.5), ez = wz + Math.round(Math.sin(a) * 3.5);
      for (let s = 1; s <= 3; s++) {
        this.put(chunk, wx + Math.round(Math.cos(a) * s), by + (s >> 1), wz + Math.round(Math.sin(a) * s), B.JUNGLE_LOG);
      }
      this.leafBlob(chunk, ex, by + 2, ez, 2.2, 1.2, B.JUNGLE_LEAVES);
    }
  }

  /** Short, wide oak with drooping leaves for swamp edges. */
  private placeSwampTree(chunk: Chunk, wx: number, wy: number, wz: number, height: number): void {
    for (let dy = 0; dy < height; dy++) this.put(chunk, wx, wy + dy, wz, B.LOG);
    for (let dy = height - 2; dy <= height + 1; dy++) {
      const rad = dy >= height ? 2 : 3;
      for (let dx = -rad; dx <= rad; dx++) {
        for (let dz = -rad; dz <= rad; dz++) {
          const dist = Math.abs(dx) + Math.abs(dz);
          if (dist > rad + 1) continue;
          if (dist === rad + 1 && hash3(this.seed ^ 0x5a3f, wx + dx, wy + dy, wz + dz) < 0.45) continue;
          this.putIfAir(chunk, wx + dx, wy + dy, wz + dz, B.LEAVES);
        }
      }
    }
    // drooping curtains of leaves hanging off the canopy rim
    for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3], [0, -3], [2, 2], [-2, -2], [2, -2], [-2, 2]]) {
      const hang = Math.floor(hash2(this.seed ^ 0x5a40, wx + dx, wz + dz) * 4);
      for (let k = 1; k <= hang; k++) this.putIfAir(chunk, wx + dx, wy + height - 2 - k, wz + dz, B.LEAVES);
    }
  }

  // --- block + side-state helpers ------------------------------------------

  private inChunk(chunk: Chunk, wx: number, wz: number): boolean {
    const x = wx - chunk.cx * CX, z = wz - chunk.cz * CZ;
    return x >= 0 && x < CX && z >= 0 && z < CZ;
  }

  /** Closed wooden door (both halves) facing `side` (0=-z,1=-x,2=+z,3=+x). */
  private putDoor(chunk: Chunk, wx: number, wy: number, wz: number, side: number, hingeRight = false): void {
    if (!this.inChunk(chunk, wx, wz)) return;
    this.put(chunk, wx, wy, wz, B.DOOR_LOWER);
    this.put(chunk, wx, wy + 1, wz, B.DOOR_UPPER);
    this.pendingDoors.push([`${wx},${wy},${wz}`, { facing: side as 0 | 1 | 2 | 3, open: false, hingeRight, swing: 0 }]);
  }

  /** Torch; `dir` (0=-z,1=-x,2=+z,3=+x) is the way a wall torch leans out,
   *  omitted for a floor torch. */
  private putTorch(chunk: Chunk, wx: number, wy: number, wz: number, dir?: number): void {
    if (!this.inChunk(chunk, wx, wz)) return;
    this.put(chunk, wx, wy, wz, B.TORCH);
    if (dir !== undefined) this.pendingTorches.push([`${wx},${wy},${wz}`, TORCH_FACING[dir]]);
  }

  /** Two-block bed: foot at (wx, wz), head one step toward `dir`. */
  private putBed(chunk: Chunk, wx: number, wy: number, wz: number, dir: number): void {
    const hx = wx + DIR_X[dir], hz = wz + DIR_Z[dir];
    if (this.inChunk(chunk, wx, wz)) {
      this.put(chunk, wx, wy, wz, B.BED);
      this.pendingBeds.push([`${wx},${wy},${wz}`, dir]);
    }
    if (this.inChunk(chunk, hx, hz)) {
      this.put(chunk, hx, wy, hz, B.BED_HEAD);
      this.pendingBeds.push([`${hx},${wy},${hz}`, dir]);
    }
  }

  /** Fill a column with `id` from just above the natural ground up to `topY`
   *  (inclusive) so a structure never floats over a dip. */
  private underpin(chunk: Chunk, wx: number, wz: number, topY: number, id: number): void {
    const g = this.heightAt(wx, wz);
    for (let y = Math.max(1, g - 1); y <= topY; y++) this.put(chunk, wx, y, wz, id);
  }

  private clearCol(chunk: Chunk, wx: number, wz: number, fromY: number, toY: number): void {
    for (let y = fromY; y <= toY; y++) this.put(chunk, wx, y, wz, B.AIR);
  }

  /** Min/max natural ground over a rectangle (sampled every 2 blocks + far edges). */
  private groundRange(x0: number, z0: number, sx: number, sz: number): [number, number] {
    let lo = 9999, hi = -9999;
    for (let dz = 0; dz < sz; dz += 2) {
      for (let dx = 0; dx < sx; dx += 2) {
        const h = this.heightAt(x0 + dx, z0 + dz);
        lo = Math.min(lo, h); hi = Math.max(hi, h);
      }
    }
    for (const [dx, dz] of [[sx - 1, 0], [0, sz - 1], [sx - 1, sz - 1]]) {
      const h = this.heightAt(x0 + dx, z0 + dz);
      lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
    return [lo, hi];
  }

  // --- villages -------------------------------------------------------------
  // One candidate village per VILLAGE_CELL square. The layout (roads, plots,
  // floor heights) is computed once from the height field and cached, then
  // every chunk overlapping the village draws the pieces that touch it.

  private villages = new Map<string, Village | null>();

  private villageAt(gx: number, gz: number): Village | null {
    const key = `${gx},${gz}`;
    let v = this.villages.get(key);
    if (v === undefined) {
      if (this.villages.size > 512) this.villages.clear();
      v = this.layoutVillage(gx, gz);
      this.villages.set(key, v);
    }
    return v;
  }

  /** Villages whose bounds (+pad) touch the given world rectangle. */
  private villagesNear(x0: number, z0: number, x1: number, z1: number, pad: number): Village[] {
    const out: Village[] = [];
    const g0x = Math.floor((x0 - pad) / VILLAGE_CELL), g1x = Math.floor((x1 + pad) / VILLAGE_CELL);
    const g0z = Math.floor((z0 - pad) / VILLAGE_CELL), g1z = Math.floor((z1 + pad) / VILLAGE_CELL);
    for (let gz = g0z; gz <= g1z; gz++) {
      for (let gx = g0x; gx <= g1x; gx++) {
        const v = this.villageAt(gx, gz);
        if (v && v.maxX + pad >= x0 && v.minX - pad <= x1 && v.maxZ + pad >= z0 && v.minZ - pad <= z1) out.push(v);
      }
    }
    return out;
  }

  /** True when (wx, wz) lies inside a village footprint (+pad). */
  private inVillage(wx: number, wz: number, pad: number): boolean {
    return this.villagesNear(wx, wz, wx, wz, pad).length > 0;
  }

  private layoutVillage(gx: number, gz: number): Village | null {
    const S = this.seed ^ 0x7111;
    if (hash2(S, gx, gz) > 0.72) return null;
    const cx = gx * VILLAGE_CELL + 48 + Math.floor(hash2(S ^ 1, gx, gz) * (VILLAGE_CELL - 96));
    const cz = gz * VILLAGE_CELL + 48 + Math.floor(hash2(S ^ 2, gx, gz) * (VILLAGE_CELL - 96));
    const b = this.biomeIdx(cx, cz);
    if (b !== PLAINS && b !== FOREST && b !== DESERT && b !== TAIGA && b !== SNOW) return null;
    const h0 = this.heightAt(cx, cz);
    if (h0 <= SEA_LEVEL + 1 || h0 > SEA_LEVEL + 30) return null;
    // the plaza needs gentle ground
    const [plo, phi] = this.groundRange(cx - 5, cz - 5, 11, 11);
    if (phi - plo > 4 || plo <= SEA_LEVEL) return null;
    const style = b === DESERT ? STYLE_DESERT : b === TAIGA || b === SNOW ? STYLE_SPRUCE : STYLE_OAK;
    const rnd = mulberry32((S ^ Math.imul(gx, 73856093) ^ Math.imul(gz, 19349663)) | 0);
    const v: Village = { cx, cz, style, pieces: [], roads: [], minX: cx - 5, maxX: cx + 5, minZ: cz - 5, maxZ: cz + 5 };
    const taken: number[][] = [[cx - 4, cz - 4, cx + 4, cz + 4]]; // occupied rects x0,z0,x1,z1
    const free = (x0: number, z0: number, x1: number, z1: number, roadPad = 1): boolean => {
      for (const r of taken) if (x0 <= r[2] + 2 && x1 >= r[0] - 2 && z0 <= r[3] + 2 && z1 >= r[1] - 2) return false;
      // keep plots off every road (their front step row may touch the verge)
      for (const r of v.roads) if (x0 <= r[2] + roadPad && x1 >= r[0] - roadPad && z0 <= r[3] + roadPad && z1 >= r[1] - roadPad) return false;
      return true;
    };
    const plazaY = Math.round((plo + phi) / 2);
    v.pieces.push({ kind: 'plaza', x0: cx - 4, z0: cz - 4, sx: 9, sz: 9, y: plazaY, side: 0, v: 0 });
    v.pieces.push({ kind: 'well', x0: cx - 2, z0: cz - 2, sx: 4, sz: 4, y: plazaY, side: 0, v: rnd() });

    // 2-4 roads radiate from the plaza, lined with plots on both sides
    const arms = [0, 1, 2, 3].filter((d) => rnd() < 0.8);
    if (arms.length < 2) arms.push(...[0, 2].filter((d) => !arms.includes(d)));
    let houses = 0;
    for (const dir of arms) {
      const ux = DIR_X[dir], uz = DIR_Z[dir];
      const px = -uz, pz = ux; // perpendicular (left/right of the road)
      const len = 18 + Math.floor(rnd() * 16);
      // road rectangle (3 wide), clipped where it runs into deep water or cliffs
      let end = 5;
      for (let s = 5; s <= len; s++) {
        const h = this.heightAt(cx + ux * s, cz + uz * s);
        if (Math.abs(h - plazaY) > 9 || h < SEA_LEVEL - 3) break;
        end = s;
      }
      if (end < 10) continue;
      const rx0 = Math.min(cx + ux * 5 - px, cx + ux * end + px), rx1 = Math.max(cx + ux * 5 - px, cx + ux * end + px);
      const rz0 = Math.min(cz + uz * 5 - pz, cz + uz * end + pz), rz1 = Math.max(cz + uz * 5 - pz, cz + uz * end + pz);
      v.roads.push([rx0, rz0, rx1, rz1]);
      // plots on each side
      for (const sideSign of [1, -1]) {
        let s = 5 + Math.floor(rnd() * 2);
        while (s < end - 3) {
          const roll = rnd();
          let kind: PieceKind = 'house', along = 5, deep = 5;
          if (roll < 0.28) { along = 5; deep = 5; }
          else if (roll < 0.52) { along = 7; deep = 5; }
          else if (roll < 0.66) { along = 9; deep = 6; }
          else if (roll < 0.78) { kind = 'smithy'; along = 7; deep = 6; }
          else if (roll < 0.94) { kind = 'farm'; along = 9; deep = 7 + Math.floor(rnd() * 3); }
          else { kind = 'lamp'; along = 1; deep = 1; }
          if (s + along - 1 > end + 1) break;
          const t0 = kind === 'lamp' ? 2 : 3, t1 = t0 + deep - 1;
          // local (s, t) rectangle → world rectangle
          const ax = cx + ux * s + px * t0 * sideSign, az = cz + uz * s + pz * t0 * sideSign;
          const bx2 = cx + ux * (s + along - 1) + px * t1 * sideSign, bz2 = cz + uz * (s + along - 1) + pz * t1 * sideSign;
          const x0 = Math.min(ax, bx2), x1 = Math.max(ax, bx2), z0 = Math.min(az, bz2), z1 = Math.max(az, bz2);
          const sx = x1 - x0 + 1, sz = z1 - z0 + 1;
          // door faces back toward the road: the direction of -perp*sideSign
          const fx = -px * sideSign, fz = -pz * sideSign;
          const side = fz < 0 ? 0 : fx < 0 ? 1 : fz > 0 ? 2 : 3;
          const [lo, hi] = this.groundRange(x0, z0, sx, sz);
          const ok = free(x0, z0, x1, z1, kind === 'lamp' ? 0 : 1) && lo > SEA_LEVEL && hi - lo <= (kind === 'farm' ? 3 : 5);
          if (ok) {
            const y = kind === 'farm' ? Math.round((lo + hi) / 2) : Math.ceil((lo + hi) / 2);
            v.pieces.push({ kind, x0, z0, sx, sz, y, side, v: rnd() });
            taken.push([x0, z0, x1, z1]);
            if (kind === 'house' || kind === 'smithy') houses++;
            v.minX = Math.min(v.minX, x0 - 2); v.maxX = Math.max(v.maxX, x1 + 2);
            v.minZ = Math.min(v.minZ, z0 - 2); v.maxZ = Math.max(v.maxZ, z1 + 2);
            s += along + 3 + Math.floor(rnd() * 3);
          } else {
            s += 2;
          }
        }
      }
      // a lamp post where the road ends
      const lx = cx + ux * end + px * 2, lz = cz + uz * end + pz * 2;
      if (free(lx, lz, lx, lz, 0)) {
        v.pieces.push({ kind: 'lamp', x0: lx, z0: lz, sx: 1, sz: 1, y: this.heightAt(lx, lz), side: 0, v: 0 });
        taken.push([lx, lz, lx, lz]);
      }
      v.minX = Math.min(v.minX, rx0 - 2); v.maxX = Math.max(v.maxX, rx1 + 2);
      v.minZ = Math.min(v.minZ, rz0 - 2); v.maxZ = Math.max(v.maxZ, rz1 + 2);
    }
    if (houses < 2) return null;
    // lamps flanking the plaza
    for (const [dx, dz] of [[-4, -4], [4, 4]]) {
      v.pieces.push({ kind: 'lamp', x0: cx + dx, z0: cz + dz, sx: 1, sz: 1, y: this.heightAt(cx + dx, cz + dz), side: 0, v: 0 });
    }
    return v;
  }

  /** Draw every piece of every village that overlaps this chunk. */
  private placeVillages(chunk: Chunk, bx: number, bz: number): void {
    for (const v of this.villagesNear(bx, bz, bx + CX - 1, bz + CZ - 1, 2)) {
      // roads first (terrain-following gravel, plank bridges over water)
      for (const [x0, z0, x1, z1] of v.roads) {
        for (let wz = Math.max(z0, bz); wz <= Math.min(z1, bz + CZ - 1); wz++) {
          for (let wx = Math.max(x0, bx); wx <= Math.min(x1, bx + CX - 1); wx++) this.pathBlock(chunk, wx, wz, v.style);
        }
      }
      for (const p of v.pieces) {
        if (p.x0 + p.sx + 2 < bx || p.x0 - 2 > bx + CX - 1 || p.z0 + p.sz + 2 < bz || p.z0 - 2 > bz + CZ - 1) continue;
        switch (p.kind) {
          case 'plaza':
            for (let dz = 0; dz < p.sz; dz++) {
              for (let dx = 0; dx < p.sx; dx++) {
                if ((dx === 0 || dx === p.sx - 1) && (dz === 0 || dz === p.sz - 1)) continue;
                this.pathBlock(chunk, p.x0 + dx, p.z0 + dz, v.style, p.y);
              }
            }
            break;
          case 'well': this.buildWell(chunk, p, v.style); break;
          case 'lamp': this.buildLamp(chunk, p.x0, p.y, p.z0, v.style); break;
          case 'farm': this.buildFarm(chunk, p, v.style); break;
          default: this.buildHouse(chunk, p, v.style); break;
        }
      }
    }
  }

  /** A path cell: gravel/dirt (or sandstone in the desert) at ground level,
   *  clearing grass above; a plank deck where it crosses water. */
  private pathBlock(chunk: Chunk, wx: number, wz: number, style: Style, atY?: number): void {
    if (!this.inChunk(chunk, wx, wz)) return;
    const g = this.heightAt(wx, wz);
    if (g < SEA_LEVEL) {
      this.put(chunk, wx, SEA_LEVEL, wz, B.PLANKS);
      this.clearCol(chunk, wx, wz, SEA_LEVEL + 1, SEA_LEVEL + 3);
      return;
    }
    let y = g;
    if (atY !== undefined) { // plaza: level it
      y = atY;
      if (g < y) this.underpin(chunk, wx, wz, y - 1, B.DIRT);
    }
    const r = hash2(this.seed ^ 0x9a70, wx, wz);
    const id = r < 0.72 ? style.path : r < 0.9 ? style.pathAlt : style.found;
    this.put(chunk, wx, y, wz, id);
    this.clearCol(chunk, wx, wz, y + 1, y + 4);
  }

  private buildWell(chunk: Chunk, p: Piece, st: Style): void {
    const y = p.y;
    for (let dz = 0; dz < 4; dz++) {
      for (let dx = 0; dx < 4; dx++) {
        const wx = p.x0 + dx, wz = p.z0 + dz;
        const inner = dx >= 1 && dx <= 2 && dz >= 1 && dz <= 2;
        this.underpin(chunk, wx, wz, y - 1, st.found);
        this.clearCol(chunk, wx, wz, y + 1, y + 5);
        if (inner) {
          for (let k = 0; k <= 4; k++) this.put(chunk, wx, y - k, wz, B.WATER);
          this.put(chunk, wx, y - 5, wz, st.found);
        } else {
          for (let k = 1; k <= 5; k++) this.put(chunk, wx, y - k, wz, st.found);
          this.put(chunk, wx, y, wz, st.found);
          this.put(chunk, wx, y + 1, wz, st.found); // rim
        }
        const corner = (dx === 0 || dx === 3) && (dz === 0 || dz === 3);
        if (corner) { this.put(chunk, wx, y + 2, wz, st.post); this.put(chunk, wx, y + 3, wz, st.post); }
        this.put(chunk, wx, y + 4, wz, st.roof);
        if (inner) this.put(chunk, wx, y + 5, wz, st.roof);
      }
    }
  }

  /** Street lamp: stone base, post, cap block with torches on its four faces. */
  private buildLamp(chunk: Chunk, wx: number, g: number, wz: number, st: Style): void {
    if (g < SEA_LEVEL) return;
    this.put(chunk, wx, g + 1, wz, st.found);
    this.put(chunk, wx, g + 2, wz, st.post);
    this.put(chunk, wx, g + 3, wz, st.post);
    this.put(chunk, wx, g + 4, wz, st.found);
    for (let d = 0; d < 4; d++) this.putTorch(chunk, wx + DIR_X[d], g + 4, wz + DIR_Z[d], d);
    this.putTorch(chunk, wx, g + 5, wz);
  }

  /** Crop field: log border, a water channel down the long axis, rows of crops. */
  private buildFarm(chunk: Chunk, p: Piece, st: Style): void {
    const y = p.y;
    const alongX = p.sx >= p.sz;
    const mid = alongX ? p.z0 + (p.sz >> 1) : p.x0 + (p.sx >> 1);
    const cropRoll = p.v;
    for (let dz = 0; dz < p.sz; dz++) {
      for (let dx = 0; dx < p.sx; dx++) {
        const wx = p.x0 + dx, wz = p.z0 + dz;
        if (!this.inChunk(chunk, wx, wz)) continue;
        this.underpin(chunk, wx, wz, y - 1, B.DIRT);
        this.clearCol(chunk, wx, wz, y + 1, y + 6);
        const edge = dx === 0 || dx === p.sx - 1 || dz === 0 || dz === p.sz - 1;
        if (edge) { this.put(chunk, wx, y, wz, st.farmEdge); continue; }
        if ((alongX ? wz : wx) === mid) { this.put(chunk, wx, y, wz, B.WATER); continue; }
        this.put(chunk, wx, y, wz, B.FARMLAND);
        // one or two crop types per field, planted in rows
        const row = alongX ? wz : wx;
        const r = hash2(this.seed ^ 0xfae1, wx, wz);
        const pick = (row & 1) === 0 ? cropRoll : (cropRoll * 7.31) % 1;
        const mature = r > 0.3;
        let crop: number;
        if (st === STYLE_DESERT && pick < 0.5) crop = mature ? B.WHEAT_2 : B.WHEAT_1;
        else if (pick < 0.3) crop = mature ? B.CARROT_2 : B.CARROT_1;
        else if (pick < 0.5) crop = mature ? B.POTATO_2 : B.POTATO_1;
        else if (pick < 0.62) crop = mature ? B.BEETROOT_2 : B.BEETROOT_1;
        else crop = mature ? B.WHEAT_2 : B.WHEAT_1;
        this.put(chunk, wx, y + 1, wz, crop);
      }
    }
  }

  /** Houses and the smithy. Built in a local frame (u across the front, v
   *  from the front wall inward) so furniture placement is orientation-free. */
  private buildHouse(chunk: Chunk, p: Piece, st: Style): void {
    const side = p.side, y = p.y;
    const W = side % 2 === 0 ? p.sx : p.sz, D = side % 2 === 0 ? p.sz : p.sx;
    const toX = (u: number, v: number): number =>
      side === 0 ? p.x0 + u : side === 2 ? p.x0 + W - 1 - u : side === 1 ? p.x0 + v : p.x0 + D - 1 - v;
    const toZ = (u: number, v: number): number =>
      side === 0 ? p.z0 + v : side === 2 ? p.z0 + D - 1 - v : side === 1 ? p.z0 + W - 1 - u : p.z0 + u;
    const inward = (side + 2) % 4;
    const smithy = p.kind === 'smithy';
    const tudor = !smithy && st.wallAlt !== st.wall && p.v > 0.55;
    const wall = smithy && !st.flat ? B.COBBLE : tudor ? st.wallAlt : st.wall;
    const wallH = W * D >= 50 ? 4 : 3;
    const top = y + wallH; // highest wall course
    const doorU = W >> 1;

    // foundation + clearing
    for (let v = -1; v <= D; v++) {
      for (let u = -1; u <= W; u++) {
        const wx = toX(u, v), wz = toZ(u, v);
        const inside = u >= 0 && u < W && v >= 0 && v < D;
        if (inside) {
          this.underpin(chunk, wx, wz, y - 1, st.found);
          this.clearCol(chunk, wx, wz, y + 1, top + 8);
        } else if (v === -1 && Math.abs(u - doorU) <= 1) {
          // front step: level the ground at the door so it is always usable
          const g = this.heightAt(wx, wz);
          if (g < y) this.underpin(chunk, wx, wz, y, u === doorU ? st.found : B.DIRT);
          else this.put(chunk, wx, y, wz, u === doorU ? st.path : B.GRASS);
          this.clearCol(chunk, wx, wz, y + 1, y + 3);
        }
      }
    }
    // floor, walls, windows
    for (let v = 0; v < D; v++) {
      for (let u = 0; u < W; u++) {
        const wx = toX(u, v), wz = toZ(u, v);
        const edgeU = u === 0 || u === W - 1, edgeV = v === 0 || v === D - 1;
        this.put(chunk, wx, y, wz, edgeU || edgeV ? st.found : smithy ? B.COBBLE : st.floor);
        if (!edgeU && !edgeV) continue;
        for (let yy = y + 1; yy <= top; yy++) {
          let id = edgeU && edgeV ? st.post : yy === y + 1 && !tudor ? st.base : wall;
          if (tudor && yy === top && !(edgeU && edgeV)) id = st.post; // timber beam
          // windows: every other wall cell, clear of corners and the door
          const along = edgeV ? u : v, span = edgeV ? W : D;
          if (!(edgeU && edgeV) && yy === y + 2 && along >= 1 && along <= span - 2 && (along & 1) === (span & 1 ? 0 : 1) &&
            !(v === 0 && u === doorU)) id = B.GLASS;
          if (wallH === 4 && yy === y + 3 && id === B.GLASS) id = wall;
          // timber lintels over the door and windows (desert)
          if (st.accent && yy === y + 3 && !(edgeU && edgeV) && along >= 1 && along <= span - 2 &&
            ((v === 0 && u === doorU) || (along & 1) === (span & 1 ? 0 : 1))) id = st.accent;
          this.put(chunk, wx, yy, wz, id);
        }
      }
    }
    // door + porch light
    this.putDoor(chunk, toX(doorU, 0), y + 1, toZ(doorU, 0), side, false);
    this.putTorch(chunk, toX(doorU + 1, -1), y + 3, toZ(doorU + 1, -1), side);
    // roof
    if (st.flat) this.flatRoof(chunk, p, top + 1, st);
    else this.gableRoof(chunk, p, top + 1, st, tudor ? st.wallAlt : wall);

    // interior
    const iu = W - 2, iv = D - 2; // far interior corner
    if (smithy) {
      this.put(chunk, toX(1, iv), y + 1, toZ(1, iv), B.FURNACE);
      this.put(chunk, toX(2, iv), y + 1, toZ(2, iv), B.FURNACE);
      this.put(chunk, toX(iu, iv), y + 1, toZ(iu, iv), B.CHEST_LOOT);
      this.put(chunk, toX(iu, 1), y + 1, toZ(iu, 1), B.TABLE);
      this.put(chunk, toX(1, 1), y + 1, toZ(1, 1), B.STONE_BRICKS); // anvil-ish block
      // chimney over the furnaces
      for (let yy = y + 2; yy <= top + Math.ceil(Math.min(W, D) / 2) + 2; yy++) {
        this.put(chunk, toX(1, D - 1), yy, toZ(1, D - 1), B.COBBLE);
      }
    } else {
      this.putBed(chunk, toX(1, iv - 1), y + 1, toZ(1, iv - 1), inward);
      this.put(chunk, toX(iu, iv), y + 1, toZ(iu, iv), B.TABLE);
      if (W >= 7) this.put(chunk, toX(iu - 1, iv), y + 1, toZ(iu - 1, iv), p.v < 0.3 ? B.FURNACE : B.CHEST_LOOT);
      else if (p.v < 0.4) this.put(chunk, toX(iu, iv - 1), y + 1, toZ(iu, iv - 1), B.CHEST_LOOT);
    }
    this.putTorch(chunk, toX(doorU, D - 2), y + 2, toZ(doorU, D - 2), side);
    // villagers live here
    const sx = toX(doorU, D >> 1), sz = toZ(doorU, D >> 1);
    if (this.inChunk(chunk, sx, sz)) this.addVillager(sx + 0.5, y + 1, sz + 0.5);
  }

  /** Stepped gable roof: each course steps in one block and up one, doubled
   *  underneath so it reads solid from inside; overhangs the walls by one. */
  private gableRoof(chunk: Chunk, p: Piece, y0: number, st: Style, gable: number): void {
    const alongX = p.sx >= p.sz;
    const len = alongX ? p.sx : p.sz, span = alongX ? p.sz : p.sx;
    const a0 = alongX ? p.x0 : p.z0, s0 = alongX ? p.z0 : p.x0;
    const at = (a: number, s: number, yy: number, id: number): void =>
      this.put(chunk, alongX ? a : s, yy, alongX ? s : a, id);
    for (let k = 0; ; k++) {
      const lo = s0 - 1 + k, hi = s0 + span - k, yy = y0 + k;
      if (lo > hi) break;
      const ridge = hi - lo <= 1;
      for (let a = a0 - 1; a <= a0 + len; a++) {
        const eave = a === a0 - 1 || a === a0 + len;
        // gable walls close the ends; the attic stays hollow
        if (a === a0 || a === a0 + len - 1) {
          for (let s = lo + 1; s <= hi - 1; s++) {
            at(a, s, yy, s === s0 + (span >> 1) && k === 1 && span >= 5 ? B.GLASS : gable);
          }
        } else if (!eave) {
          for (let s = lo + 2; s <= hi - 2; s++) at(a, s, yy, B.AIR);
        }
        const id = ridge || (eave && k === 0) ? st.ridge : st.roof;
        at(a, lo, yy, id); at(a, hi, yy, id);
        if (lo + 1 < hi - 1) { at(a, lo + 1, yy, st.roof); at(a, hi - 1, yy, st.roof); }
      }
      if (ridge) break;
    }
  }

  /** Desert flat roof: a low parapet with raised corners, a jutting timber
   *  beam course, and on some houses a white canvas shade over the terrace. */
  private flatRoof(chunk: Chunk, p: Piece, y0: number, st: Style): void {
    for (let dz = 0; dz < p.sz; dz++) {
      for (let dx = 0; dx < p.sx; dx++) {
        const wx = p.x0 + dx, wz = p.z0 + dz;
        const ex = dx === 0 || dx === p.sx - 1, ez = dz === 0 || dz === p.sz - 1;
        this.put(chunk, wx, y0, wz, st.roof);
        if (ex && ez) { this.put(chunk, wx, y0 + 1, wz, st.roof); this.put(chunk, wx, y0 + 2, wz, st.roof); }
        else if (ex || ez) this.put(chunk, wx, y0 + 1, wz, st.roof);
      }
    }
    // beam ends poking out under the roof line
    for (let dx = 2; dx < p.sx - 2; dx += 2) {
      this.put(chunk, p.x0 + dx, y0 - 1, p.z0 - 1, st.accent || st.post);
      this.put(chunk, p.x0 + dx, y0 - 1, p.z0 + p.sz, st.accent || st.post);
    }
    if (p.v > 0.5 && p.sx >= 5 && p.sz >= 5) {
      // canvas shade on four posts
      const x0 = p.x0 + 1, z0 = p.z0 + 1, x1 = p.x0 + 3, z1 = p.z0 + 3;
      for (const [px, pz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) this.put(chunk, px, y0 + 1, pz, st.accent || st.post);
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) this.put(chunk, x, y0 + 2, z, B.WOOL);
    }
  }

  private addVillager(x: number, y: number, z: number): void {
    for (const s of this.villageSpawns) if (s.x === x && s.y === y && s.z === z) return;
    this.villageSpawns.push({ x, y, z });
  }

  /** Roll and draw the structures anchored in origin chunk (scx, scz). */
  private structuresFrom(chunk: Chunk, scx: number, scz: number): void {
    const S = this.seed;
    const at = (salt: number, span: number, base: number): number => base + Math.floor(hash2(S ^ salt, scx, scz) * span);
    const roll = (salt: number): number => hash2(S ^ salt, scx, scz);

    // lone cottage (a hermit's house in the local style)
    if (roll(0xbeef) < 0.022) {
      const side = Math.floor(roll(0xbef0) * 4);
      const sx = side % 2 === 0 ? 7 : 5, sz = side % 2 === 0 ? 5 : 7;
      const ox = at(0xcafe, 6, scx * CX + 2), oz = at(0xfade, 6, scz * CZ + 2);
      const b = this.biomeIdx(ox + 3, oz + 3);
      const [lo, hi] = this.groundRange(ox, oz, sx, sz);
      if (lo > SEA_LEVEL && hi - lo <= 4 && hi <= SEA_LEVEL + 34 && b !== SWAMP && b !== MOUNTAINS &&
        !this.inVillage(ox, oz, 12)) {
        const st = b === DESERT ? STYLE_DESERT : b === TAIGA || b === SNOW ? STYLE_SPRUCE : STYLE_OAK;
        this.buildHouse(chunk, { kind: 'house', x0: ox, z0: oz, sx, sz, y: Math.ceil((lo + hi) / 2), side, v: roll(0xbef1) }, st);
      }
    }
    // buried dungeon
    if (roll(0xd11e) < 0.07) {
      const ox = at(0xd22e, 7, scx * CX + 2), oz = at(0xd33e, 7, scz * CZ + 2);
      const surface = this.heightAt(ox + 3, oz + 3);
      const oy = 7 + Math.floor(roll(0xd44e) * Math.max(4, surface - 22));
      if (oy + 7 < surface - 4) this.placeDungeon(chunk, ox, oy, oz);
    }
    // deeper multi-room crypts: rarer than dungeons, but more rewarding
    if (roll(0xc11e) < 0.032) {
      const ox = at(0xc22e, 8, scx * CX), oz = at(0xc33e, 8, scz * CZ);
      const surface = this.heightAt(ox + 7, oz + 7);
      const oy = 9 + Math.floor(roll(0xc44e) * Math.max(5, surface - 30));
      if (oy + 8 < surface - 6) this.placeCrypt(chunk, ox, oy, oz);
    }
    // abandoned mineshaft crossing: timbered tunnels deep underground
    if (roll(0x3a1e) < 0.03) {
      const ox = at(0x3a1f, 12, scx * CX + 2), oz = at(0x3a20, 12, scz * CZ + 2);
      const surface = this.heightAt(ox, oz);
      const oy = 14 + Math.floor(roll(0x3a21) * Math.max(4, surface - 40));
      if (oy + 6 < surface - 12) this.placeMineshaft(chunk, ox, oy, oz);
    }
    // overgrown ruins: common low broken-wall remnants on temperate land
    if (roll(0x2ec5) < 0.03) {
      const ox = at(0x2ec6, 6, scx * CX + 3), oz = at(0x2ec7, 6, scz * CZ + 3);
      const oy = this.heightAt(ox + 3, oz + 2);
      const b = this.biomeIdx(ox + 3, oz + 2);
      if ((b === PLAINS || b === FOREST || b === TAIGA || b === JUNGLE) && oy > SEA_LEVEL && oy <= 96 &&
        !this.inVillage(ox, oz, 10)) {
        this.placeRuin(chunk, ox, oy, oz);
      }
    }
    // desert pyramid
    if (roll(0x7eab) < 0.024) {
      const ox = at(0x7eac, 5, scx * CX + 2), oz = at(0x7ead, 5, scz * CZ + 2);
      const [lo, hi] = this.groundRange(ox, oz, 13, 13);
      if (this.biomeIdx(ox + 6, oz + 6) === DESERT && lo > SEA_LEVEL && hi - lo <= 8 && hi <= SEA_LEVEL + 26 &&
        !this.inVillage(ox, oz, 14)) {
        this.placeTemple(chunk, ox, Math.round((lo + hi) / 2), oz);
      }
    }
    // desert well: a small sandstone shrine over a water shaft
    if (roll(0xd3e1) < 0.02) {
      const ox = at(0xd3e2, 10, scx * CX + 3), oz = at(0xd3e3, 10, scz * CZ + 3);
      const [lo, hi] = this.groundRange(ox - 2, oz - 2, 5, 5);
      if (this.biomeIdx(ox, oz) === DESERT && lo > SEA_LEVEL && hi - lo <= 2 && !this.inVillage(ox, oz, 8)) {
        this.placeDesertWell(chunk, ox, hi, oz);
      }
    }
    // igloo: rare, only on snow surface
    if (roll(0x191e) < 0.016) {
      const ox = at(0x191f, 6, scx * CX + 3), oz = at(0x1920, 6, scz * CZ + 3);
      const [lo, hi] = this.groundRange(ox + 1, oz + 1, 7, 7);
      if (this.biomeIdx(ox + 4, oz + 4) === SNOW && lo > SEA_LEVEL && hi - lo <= 3 && hi <= 110) {
        this.placeIgloo(chunk, ox, hi, oz);
      }
    }
    // swamp hut: compact witch-style shelter on stilts
    if (roll(0x5eab) < 0.02) {
      const ox = at(0x5eac, 8, scx * CX + 2), oz = at(0x5ead, 8, scz * CZ + 2);
      const oy = this.heightAt(ox + 4, oz + 4);
      if (this.biomeIdx(ox + 4, oz + 4) === SWAMP && oy >= SEA_LEVEL - 2 && oy <= SEA_LEVEL + 8) {
        this.placeSwampHut(chunk, ox, Math.max(oy, SEA_LEVEL), oz);
      }
    }
    // watchtowers: above-ground landmarks with loot and a high view
    if (roll(0x70ab) < 0.009) {
      const ox = at(0x70ac, 7, scx * CX + 3), oz = at(0x70ad, 7, scz * CZ + 3);
      const [lo, hi] = this.groundRange(ox, oz, 7, 7);
      const b = this.biomeIdx(ox + 3, oz + 3);
      if ((b === PLAINS || b === FOREST || b === TAIGA || b === DESERT || b === SNOW) && lo > SEA_LEVEL &&
        hi - lo <= 5 && hi <= 100 && !this.inVillage(ox, oz, 12)) {
        this.placeWatchtower(chunk, ox, Math.round((lo + hi) / 2), oz, b === DESERT);
      }
    }
    // mountain keep / small palace: rare larger landmark on flatter ground
    if (roll(0xca57) < 0.005) {
      const ox = at(0xca58, 5, scx * CX + 1), oz = at(0xca59, 5, scz * CZ + 1);
      const [lo, hi] = this.groundRange(ox, oz, 13, 13);
      const b = this.biomeIdx(ox + 6, oz + 6);
      if ((b === MOUNTAINS || b === PLAINS || b === TAIGA || b === SNOW) && lo > SEA_LEVEL + 3 && hi <= 112 &&
        hi - lo <= 7 && !this.inVillage(ox, oz, 16)) {
        this.placeKeep(chunk, ox, Math.round((lo + hi) / 2) + 1, oz);
      }
    }
    // small ponds break up plains/forest/swamp travel and create fishing spots
    if (roll(0xa417) < 0.028) {
      const ox = at(0xa418, 8, scx * CX + 3), oz = at(0xa419, 8, scz * CZ + 3);
      const oy = this.heightAt(ox + 3, oz + 3);
      const b = this.biomeIdx(ox + 3, oz + 3);
      if ((b === PLAINS || b === FOREST || b === SWAMP || b === JUNGLE) && oy >= SEA_LEVEL && oy <= SEA_LEVEL + 12 &&
        this.slopeAt(ox + 3, oz + 3, oy) <= 1 && !this.inVillage(ox + 3, oz + 3, 8)) {
        this.placePond(chunk, ox, oy, oz);
      }
    }
    // boulders and stone outcrops make taiga, plains and mountain terrain easier to read
    if (roll(0xb011) < 0.045) {
      const ox = at(0xb012, 10, scx * CX + 2), oz = at(0xb013, 10, scz * CZ + 2);
      const oy = this.heightAt(ox, oz);
      const b = this.biomeIdx(ox, oz);
      if ((b === TAIGA || b === MOUNTAINS || b === PLAINS || b === SNOW) && oy > SEA_LEVEL && oy <= 112 &&
        !this.inVillage(ox, oz, 6)) {
        this.placeBoulder(chunk, ox, oy + 1, oz, 1 + Math.floor(hash2(S ^ 0xb014, ox, oz) * 2.4));
      }
    }
  }

  private placeBoulder(chunk: Chunk, wx: number, wy: number, wz: number, radius: number): void {
    const mossy = this.biomeIdx(wx, wz) !== MOUNTAINS;
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const g = this.heightAt(wx + dx, wz + dz);
        for (let dy = -1; dy <= radius + 1; dy++) {
          const d = Math.sqrt(dx * dx + dz * dz + (dy * 1.25) ** 2);
          if (d > radius + 0.55) continue;
          const r = hash3(this.seed ^ 0xb015, wx + dx, wy + dy, wz + dz);
          const id = r < 0.4 ? B.COBBLE : mossy && r > 0.93 && dy > 0 ? B.GRAVEL : B.STONE;
          this.put(chunk, wx + dx, wy + dy, wz + dz, id, true);
          // sink the rock into lower ground so it never hangs over a dip
          if (dy <= 0) for (let y = g + 1; y < wy + dy; y++) this.put(chunk, wx + dx, y, wz + dz, B.STONE, true);
        }
      }
    }
  }

  private placePond(chunk: Chunk, ox: number, oy: number, oz: number): void {
    const cx = ox + 3, cz = oz + 3;
    const rx = 3 + Math.floor(hash2(this.seed ^ 0xa41a, ox, oz) * 2);
    const rz = 3 + Math.floor(hash2(this.seed ^ 0xa41b, ox, oz) * 2);
    const topWater = Math.min(oy, SEA_LEVEL + 12);
    for (let dx = -rx; dx <= rx; dx++) {
      for (let dz = -rz; dz <= rz; dz++) {
        const n = hash2(this.seed ^ 0xa41c, cx + dx, cz + dz) * 0.35;
        const d = (dx * dx) / (rx * rx) + (dz * dz) / (rz * rz) + n;
        if (d > 1.05) continue;
        const edge = d > 0.72;
        const groundY = this.heightAt(cx + dx, cz + dz);
        if (groundY < topWater) continue; // bank lower than the pond surface: would spill
        const floorY = Math.min(topWater - 1, groundY - (edge ? 1 : 2));
        for (let y = groundY + 2; y >= floorY + 1; y--) this.put(chunk, cx + dx, y, cz + dz, B.AIR);
        this.put(chunk, cx + dx, floorY, cz + dz, edge ? B.SAND : hash2(this.seed ^ 0xa41e, cx + dx, cz + dz) < 0.3 ? B.GRAVEL : B.DIRT);
        for (let y = floorY + 1; y <= topWater; y++) this.put(chunk, cx + dx, y, cz + dz, B.WATER);
        if (edge && hash2(this.seed ^ 0xa41d, cx + dx, cz + dz) < 0.25) {
          this.putIfAir(chunk, cx + dx, topWater + 1, cz + dz, B.SUGAR_CANE);
        }
      }
    }
  }

  /** Buried cobblestone room with a loot chest; caves often breach them. */
  private placeDungeon(chunk: Chunk, ox: number, oy: number, oz: number): void {
    const W = 7, H = 5, D = 7;
    for (let dx = 0; dx < W; dx++) {
      for (let dz = 0; dz < D; dz++) {
        for (let dy = 0; dy < H; dy++) {
          const edge = dx === 0 || dx === W - 1 || dz === 0 || dz === D - 1 || dy === 0 || dy === H - 1;
          const r = hash3(this.seed ^ 0xd0e1, ox + dx, oy + dy, oz + dz);
          const id = !edge ? B.AIR : dy === 0 && r < 0.3 ? B.GRAVEL : r < 0.22 ? B.STONE_BRICKS : B.COBBLE;
          this.put(chunk, ox + dx, oy + dy, oz + dz, id);
        }
      }
    }
    this.put(chunk, ox + 3, oy + 1, oz + 1, B.CHEST_LOOT);
    if (hash2(this.seed ^ 0xd0e2, ox, oz) < 0.5) this.put(chunk, ox + 5, oy + 1, oz + 5, B.CHEST_LOOT);
    this.putTorch(chunk, ox + 3, oy + 2, oz + D - 2, 0);
  }

  /** Multi-room underground crypt with corridors, sarcophagi, torches, and two loot chests. */
  private placeCrypt(chunk: Chunk, ox: number, oy: number, oz: number): void {
    const room = (rx: number, rz: number, w: number, d: number): void => {
      for (let dx = 0; dx < w; dx++) {
        for (let dz = 0; dz < d; dz++) {
          for (let dy = 0; dy < 5; dy++) {
            const edge = dx === 0 || dx === w - 1 || dz === 0 || dz === d - 1 || dy === 0 || dy === 4;
            const id = edge ? (dy === 0 || dy === 4 ? B.STONE_BRICKS : B.COBBLE) : B.AIR;
            this.put(chunk, ox + rx + dx, oy + dy, oz + rz + dz, id);
          }
        }
      }
    };
    room(0, 0, 7, 7);
    room(8, 0, 7, 7);
    room(4, 7, 7, 7);
    // corridors and door openings
    for (let x = ox + 6; x <= ox + 8; x++) {
      for (let y = oy + 1; y <= oy + 3; y++) this.put(chunk, x, y, oz + 3, B.AIR);
    }
    for (let z = oz + 6; z <= oz + 8; z++) {
      for (let y = oy + 1; y <= oy + 3; y++) this.put(chunk, ox + 7, y, z, B.AIR);
    }
    // pillars / sarcophagi
    for (const [px, pz] of [[2, 2], [4, 4], [10, 2], [12, 4], [6, 10], [8, 12]]) {
      this.put(chunk, ox + px, oy + 1, oz + pz, B.STONE_BRICKS);
      this.put(chunk, ox + px, oy + 2, oz + pz, B.COBBLE);
    }
    this.put(chunk, ox + 2, oy + 1, oz + 4, B.CHEST_LOOT);
    this.put(chunk, ox + 12, oy + 1, oz + 2, B.CHEST_LOOT);
    this.putTorch(chunk, ox + 7, oy + 2, oz + 12, 0);
    this.putTorch(chunk, ox + 1, oy + 2, oz + 3, 3);
    this.putTorch(chunk, ox + 13, oy + 2, oz + 3, 1);
  }

  /** Abandoned mineshaft: two crossing 3x3 tunnels with timber frames every
   *  four blocks, plank decking over cave gaps, torches and a supply chest. */
  private placeMineshaft(chunk: Chunk, ox: number, oy: number, oz: number): void {
    const L = 12;
    for (const alongX of [true, false]) {
      for (let s = -L; s <= L; s++) {
        for (let t = -1; t <= 1; t++) {
          const wx = alongX ? ox + s : ox + t, wz = alongX ? oz + t : oz + s;
          if (!this.inChunk(chunk, wx, wz)) continue;
          for (let dy = 1; dy <= 3; dy++) this.put(chunk, wx, oy + dy, wz, B.AIR);
          const floor = chunk.get(wx - chunk.cx * CX, oy, wz - chunk.cz * CZ);
          if (floor === B.AIR || floor === B.WATER || floor === B.LAVA) this.put(chunk, wx, oy, wz, B.PLANKS);
          else if (hash3(this.seed ^ 0x3a22, wx, oy, wz) < 0.15) this.put(chunk, wx, oy, wz, B.GRAVEL);
        }
        if (s % 4 === 0 && Math.abs(s) >= 2) {
          // support frame: two posts and a cross beam
          for (const t of [-1, 1]) {
            const wx = alongX ? ox + s : ox + t, wz = alongX ? oz + t : oz + s;
            this.put(chunk, wx, oy + 1, wz, B.LOG);
            this.put(chunk, wx, oy + 2, wz, B.LOG);
          }
          for (let t = -1; t <= 1; t++) {
            this.put(chunk, alongX ? ox + s : ox + t, oy + 3, alongX ? oz + t : oz + s, B.PLANKS);
          }
          if (s % 8 === 0) {
            // lantern hung off the post, leaning into the tunnel
            this.putTorch(chunk, alongX ? ox + s : ox, oy + 2, alongX ? oz : oz + s, alongX ? 2 : 3);
          }
        }
      }
    }
    this.put(chunk, ox + L - 1, oy + 1, oz + 1, B.CHEST_LOOT);
    if (hash2(this.seed ^ 0x3a23, ox, oz) < 0.5) this.put(chunk, ox - 1, oy + 1, oz - L + 1, B.CHEST_LOOT);
  }

  private putIfAir(chunk: Chunk, wx: number, wy: number, wz: number, id: number): void {
    const x = wx - chunk.cx * CX;
    const z = wz - chunk.cz * CZ;
    if (x < 0 || x >= CX || z < 0 || z >= CZ || wy < 0 || wy >= CY) return;
    if (chunk.get(x, wy, z) !== B.AIR) return;
    chunk.setRaw(x, wy, z, id);
  }

  /** Desert pyramid: a stepped sandstone pyramid on a levelled plinth with two
   *  front towers, a pillared hall inside, and a shaft down to a treasure
   *  chamber — four loot chests around a pressure plate over hidden TNT. */
  private placeTemple(chunk: Chunk, ox: number, oy: number, oz: number): void {
    const R = 6, cx = ox + R, cz = oz + R;
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        this.underpin(chunk, cx + dx, cz + dz, oy - 1, B.SANDSTONE);
        this.clearCol(chunk, cx + dx, cz + dz, oy + 1, oy + 12);
      }
    }
    for (let level = 0; level <= R; level++) {
      const r = R - level;
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) this.put(chunk, cx + dx, oy + level, cz + dz, B.SANDSTONE);
      }
    }
    // hall
    for (let level = 1; level <= 4; level++) {
      const r = level <= 2 ? 3 : level === 3 ? 2 : 1;
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) this.put(chunk, cx + dx, oy + level, cz + dz, B.AIR);
      }
    }
    for (const [px, pz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) {
      this.put(chunk, cx + px, oy + 1, cz + pz, B.SANDSTONE);
      this.put(chunk, cx + px, oy + 2, cz + pz, B.SANDSTONE);
      this.putTorch(chunk, cx + px, oy + 3, cz + pz);
    }
    // gatehouse facade on the front (-z) face with a tunnel into the hall
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -R - 1; dz <= -R + 1; dz++) {
        this.underpin(chunk, cx + dx, cz + dz, oy, B.SANDSTONE);
        for (let y = oy + 1; y <= oy + 4; y++) this.put(chunk, cx + dx, y, cz + dz, B.SANDSTONE);
        if (Math.abs(dx) === 2 && dz === -R - 1) this.put(chunk, cx + dx, oy + 5, cz + dz, B.SANDSTONE);
      }
    }
    for (let dz = -R - 1; dz <= -3; dz++) {
      this.put(chunk, cx, oy + 1, cz + dz, B.AIR);
      this.put(chunk, cx, oy + 2, cz + dz, B.AIR);
    }
    for (const sx of [-1, 1]) {
      const tx = cx + sx * (R - 1);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const wx = tx + dx, wz = cz - (R - 1) + dz;
          for (let y = oy + 1; y <= oy + 8; y++) this.put(chunk, wx, y, wz, B.SANDSTONE);
          if ((dx + dz) % 2 === 0 && dx !== 0) this.put(chunk, wx, oy + 9, wz, B.SANDSTONE);
        }
      }
      this.put(chunk, tx, oy + 6, cz - R, B.GLASS);
      this.putTorch(chunk, cx + sx, oy + 3, cz - R - 2, 0);
    }
    // treasure shaft + chamber
    const cy = oy - 9;
    for (let y = cy + 1; y <= oy; y++) this.put(chunk, cx, y, cz, B.AIR);
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dy = 0; dy < 4; dy++) {
          const edge = Math.abs(dx) === 2 || Math.abs(dz) === 2 || dy === 0 || dy === 3;
          this.put(chunk, cx + dx, cy + dy, cz + dz, edge ? B.SANDSTONE : B.AIR);
        }
      }
    }
    this.put(chunk, cx, cy + 3, cz, B.AIR);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) this.put(chunk, cx + dx, cy - 1, cz + dz, B.TNT);
    }
    this.put(chunk, cx, cy + 1, cz, B.PRESSURE_PLATE);
    for (const [dx, dz] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) this.put(chunk, cx + dx * 2, cy + 1, cz + dz * 2, B.CHEST_LOOT);
  }

  /** Oasis-style desert well: sandstone basin, four pillars and a canopy. */
  private placeDesertWell(chunk: Chunk, cx: number, g: number, cz: number): void {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const wx = cx + dx, wz = cz + dz;
        this.underpin(chunk, wx, wz, g, B.SANDSTONE);
        this.clearCol(chunk, wx, wz, g + 1, g + 6);
        const plus = Math.abs(dx) + Math.abs(dz) <= 1;
        if (plus) {
          for (let y = g - 4; y <= g; y++) this.put(chunk, wx, y, wz, B.WATER);
          this.put(chunk, wx, g - 5, wz, B.SANDSTONE);
        } else if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1) {
          for (let y = g + 1; y <= g + 3; y++) this.put(chunk, wx, y, wz, B.SANDSTONE); // pillars
        } else if (Math.abs(dx) === 2 || Math.abs(dz) === 2) {
          if (Math.abs(dx) + Math.abs(dz) <= 2) this.put(chunk, wx, g + 1, wz, B.SANDSTONE); // rim
        }
        if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1) this.put(chunk, wx, g + 4, wz, B.SANDSTONE);
      }
    }
    this.put(chunk, cx, g + 5, cz, B.SANDSTONE);
  }

  /** Snow igloo: a white-wool dome with a ladder down to a small basement
   *  holding a furnace, bed, and a loot chest. */
  private placeIgloo(chunk: Chunk, ox: number, oy: number, oz: number): void {
    const cx = ox + 4, cz = oz + 4;
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        this.underpin(chunk, cx + dx, cz + dz, oy - 1, B.DIRT);
        this.clearCol(chunk, cx + dx, cz + dz, oy + 1, oy + 5);
        const r = Math.hypot(dx, dz);
        if (r > 3.3) continue;
        this.put(chunk, cx + dx, oy, cz + dz, B.SNOW_GRASS);
        // dome: two-high ring wall, a stepped-in roof course, then the cap
        if (r > 2.3) { this.put(chunk, cx + dx, oy + 1, cz + dz, B.WOOL); this.put(chunk, cx + dx, oy + 2, cz + dz, B.WOOL); }
        if (r > 1.5 && r <= 2.9) this.put(chunk, cx + dx, oy + 3, cz + dz, B.WOOL);
        if (r <= 1.5) this.put(chunk, cx + dx, oy + 4, cz + dz, B.WOOL);
      }
    }
    // doorway tunnel on the -z side
    for (let dz = -4; dz <= -2; dz++) {
      this.put(chunk, cx, oy + 1, cz + dz, B.AIR);
      this.put(chunk, cx, oy + 2, cz + dz, B.AIR);
      if (dz <= -3) {
        this.put(chunk, cx - 1, oy + 1, cz + dz, B.WOOL); this.put(chunk, cx + 1, oy + 1, cz + dz, B.WOOL);
        this.put(chunk, cx - 1, oy + 2, cz + dz, B.WOOL); this.put(chunk, cx + 1, oy + 2, cz + dz, B.WOOL);
        this.put(chunk, cx, oy + 3, cz + dz, B.WOOL);
      }
    }
    this.putTorch(chunk, cx + 2, oy + 2, cz, 1);
    this.put(chunk, cx - 2, oy + 1, cz + 1, B.TABLE);
    // basement shaft with ladder
    const by = oy - 6;
    for (let dy = 0; dy <= 5; dy++) {
      this.put(chunk, cx, oy - dy, cz, B.AIR);
      this.put(chunk, cx, oy - dy, cz, B.LADDER);
    }
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dy = 0; dy <= 3; dy++) {
          const edge = Math.abs(dx) === 2 || Math.abs(dz) === 2 || dy === 0 || dy === 3;
          if (edge && dx === 0 && dz === 0 && dy === 3) continue; // shaft opening
          this.put(chunk, cx + dx, by + dy, cz + dz, edge ? B.STONE_BRICKS : B.AIR);
        }
      }
    }
    this.put(chunk, cx, by + 1, cz, B.LADDER);
    this.put(chunk, cx, by + 2, cz, B.LADDER);
    this.put(chunk, cx - 1, by + 1, cz + 1, B.FURNACE);
    this.putBed(chunk, cx + 1, by + 1, cz, 2);
    this.putTorch(chunk, cx, by + 2, cz - 1, 2);
    this.put(chunk, cx - 1, by + 1, cz - 1, B.CHEST_LOOT);
  }

  /** Witch hut on spruce stilts driven down to the swamp floor, with a
   *  pitched spruce roof, a door and a ladder down to the water. */
  private placeSwampHut(chunk: Chunk, ox: number, oy: number, oz: number): void {
    const W = 7, D = 6, floorY = oy + 3;
    for (const [dx, dz] of [[0, 0], [W - 1, 0], [0, D - 1], [W - 1, D - 1], [3, 0], [3, D - 1]]) {
      const g = Math.min(this.heightAt(ox + dx, oz + dz), SEA_LEVEL - 1);
      for (let y = g; y <= floorY; y++) this.put(chunk, ox + dx, y, oz + dz, B.SPRUCE_LOG);
    }
    for (let dx = 0; dx < W; dx++) {
      for (let dz = 0; dz < D; dz++) {
        this.put(chunk, ox + dx, floorY, oz + dz, B.PLANKS);
        this.clearCol(chunk, ox + dx, oz + dz, floorY + 1, floorY + 7);
        const edgeX = dx === 0 || dx === W - 1, edgeZ = dz === 0 || dz === D - 1;
        if (edgeX || edgeZ) {
          for (let y = floorY + 1; y <= floorY + 3; y++) {
            this.put(chunk, ox + dx, y, oz + dz, edgeX && edgeZ ? B.SPRUCE_LOG : B.PLANKS);
          }
        }
      }
    }
    this.gableRoof(chunk, { kind: 'house', x0: ox, z0: oz, sx: W, sz: D, y: floorY, side: 0, v: 0 }, floorY + 4,
      STYLE_SPRUCE, B.PLANKS);
    // porch landing + ladder down the front
    for (let dx = 2; dx <= 4; dx++) this.put(chunk, ox + dx, floorY, oz - 1, B.PLANKS);
    for (let y = oy; y < floorY; y++) this.put(chunk, ox + 3, y, oz - 2, B.LADDER);
    this.putDoor(chunk, ox + 3, floorY + 1, oz, 0);
    this.put(chunk, ox, floorY + 2, oz + 2, B.GLASS);
    this.put(chunk, ox + W - 1, floorY + 2, oz + 3, B.GLASS);
    this.put(chunk, ox + 1, floorY + 2, oz, B.GLASS);
    this.put(chunk, ox + 5, floorY + 2, oz, B.GLASS);
    this.put(chunk, ox + 2, floorY + 1, oz + 4, B.TABLE);
    this.put(chunk, ox + 4, floorY + 1, oz + 4, B.CHEST_LOOT);
    this.put(chunk, ox + 5, floorY + 1, oz + 4, B.FURNACE);
    this.putTorch(chunk, ox + 3, floorY + 2, oz + D - 2, 0);
    this.putTorch(chunk, ox + 4, floorY + 2, oz - 1, 0);
  }

  /** Stone watchtower on a stepped plinth: door, arrow-slit windows, two floors
   *  joined by a ladder, crenellated roof with torches, loot at base and top. */
  private placeWatchtower(chunk: Chunk, ox: number, oy: number, oz: number, desert: boolean): void {
    const wall = desert ? B.SANDSTONE : B.COBBLE;
    const trim = desert ? B.SANDSTONE : B.STONE_BRICKS;
    const H = 11;
    for (let dx = -1; dx <= 7; dx++) {
      for (let dz = -1; dz <= 7; dz++) {
        const plinth = dx === -1 || dx === 7 || dz === -1 || dz === 7;
        this.underpin(chunk, ox + dx, oz + dz, oy, trim);
        if (plinth) { this.clearCol(chunk, ox + dx, oz + dz, oy + 1, oy + 3); continue; }
        const edge = dx === 0 || dx === 6 || dz === 0 || dz === 6;
        const corner = (dx === 0 || dx === 6) && (dz === 0 || dz === 6);
        for (let dy = 1; dy <= H; dy++) {
          let id = edge ? (corner || dy === 5 || dy === H ? trim : wall) : B.AIR;
          // arrow slits in each face
          if (edge && !corner && (dx === 3 || dz === 3) && (dy === 3 || dy === 8)) id = B.GLASS;
          this.put(chunk, ox + dx, oy + dy, oz + dz, id);
        }
      }
    }
    // crenellations + corner turrets
    for (let dx = 0; dx < 7; dx++) {
      for (let dz = 0; dz < 7; dz++) {
        const edge = dx === 0 || dx === 6 || dz === 0 || dz === 6;
        const corner = (dx === 0 || dx === 6) && (dz === 0 || dz === 6);
        if (corner) { this.put(chunk, ox + dx, oy + H + 1, oz + dz, wall); this.put(chunk, ox + dx, oy + H + 2, oz + dz, trim); }
        else if (edge && (dx + dz) % 2 === 0) this.put(chunk, ox + dx, oy + H + 1, oz + dz, wall);
      }
    }
    // door, floors, ladder, loot, lights
    this.putDoor(chunk, ox + 3, oy + 1, oz, 0);
    for (let dx = 1; dx <= 5; dx++) {
      for (let dz = 1; dz <= 5; dz++) {
        if (dx === 5 && dz === 5) continue;
        this.put(chunk, ox + dx, oy + 5, oz + dz, desert ? B.SANDSTONE : B.PLANKS);
        this.put(chunk, ox + dx, oy + H, oz + dz, desert ? B.SANDSTONE : B.PLANKS);
      }
    }
    for (let dy = 1; dy <= H; dy++) this.put(chunk, ox + 5, oy + dy, oz + 5, B.LADDER);
    this.put(chunk, ox + 1, oy + 1, oz + 5, B.CHEST_LOOT);
    this.put(chunk, ox + 1, oy + 6, oz + 1, B.CHEST_LOOT);
    this.putTorch(chunk, ox + 3, oy + 3, oz + 5, 0);
    this.putTorch(chunk, ox + 3, oy + 7, oz + 5, 0);
    this.putTorch(chunk, ox + 2, oy + 3, oz - 1, 0);
    this.putTorch(chunk, ox + 4, oy + 3, oz - 1, 0);
    for (const [tx, tz] of [[1, 1], [5, 1], [1, 5]]) this.putTorch(chunk, ox + tx, oy + H + 1, oz + tz);
  }

  /** Overgrown ruin: a small footprint of broken cobble/stone-brick walls that
   *  follows the terrain, a toppled column, gravel rubble and sometimes loot. */
  private placeRuin(chunk: Chunk, ox: number, oy: number, oz: number): void {
    const W = 5 + Math.floor(hash2(this.seed ^ 0x2ed0, ox, oz) * 4); // 5-8
    const D = 4 + Math.floor(hash2(this.seed ^ 0x2ed1, oz, ox) * 3); // 4-6
    for (let dx = 0; dx < W; dx++) {
      for (let dz = 0; dz < D; dz++) {
        const wx = ox + dx, wz = oz + dz;
        const gy = this.heightAt(wx, wz);
        if (gy <= SEA_LEVEL || Math.abs(gy - oy) > 3) continue; // skip cliffs/water
        // foundation flush with the ground, some of it crumbled to gravel
        this.put(chunk, wx, gy, wz, hash3(this.seed ^ 0x2ed2, wx, gy, wz) < 0.32 ? B.GRAVEL : B.COBBLE);
        this.clearCol(chunk, wx, wz, gy + 1, gy + 4); // clear scrub
        const edge = dx === 0 || dx === W - 1 || dz === 0 || dz === D - 1;
        if (!edge) continue;
        const corner = (dx === 0 || dx === W - 1) && (dz === 0 || dz === D - 1);
        const base = corner ? 3 + Math.floor(hash3(this.seed ^ 0x2ed7, wx, 1, wz) * 2) : 1 + Math.floor(hash3(this.seed ^ 0x2ed3, wx, 0, wz) * 3);
        for (let dy = 1; dy <= base; dy++) {
          // upper courses crumble away for a ruined silhouette (corners hold)
          if (!corner && hash3(this.seed ^ 0x2ed4, wx, dy, wz) < (dy / (base + 1)) * 0.7) continue;
          const mat = hash3(this.seed ^ 0x2ed5, wx, dy, wz) < 0.3 ? B.STONE_BRICKS : B.COBBLE;
          this.put(chunk, wx, gy + dy, wz, mat);
        }
      }
    }
    // a toppled column lying beside the ruin
    const alongX = hash2(this.seed ^ 0x2ed8, ox, oz) < 0.5;
    for (let s = 0; s < 3; s++) {
      const wx = alongX ? ox + 1 + s : ox + W + 1, wz = alongX ? oz + D + 1 : oz + 1 + s;
      const gy = this.heightAt(wx, wz);
      if (gy > SEA_LEVEL && Math.abs(gy - oy) <= 2) this.put(chunk, wx, gy + 1, wz, s === 0 ? B.STONE_BRICKS : B.COBBLE);
    }
    // half the time, a loot chest sits among the rubble in the centre
    if (hash2(this.seed ^ 0x2ed6, ox, oz) < 0.5) {
      const cx = ox + (W >> 1), cz = oz + (D >> 1);
      const gy = this.heightAt(cx, cz);
      if (gy > SEA_LEVEL && Math.abs(gy - oy) <= 3) this.put(chunk, cx, gy + 1, cz, B.CHEST_LOOT);
    }
  }

  /** Small stone keep: curtain walls on a levelled plinth, four corner towers
   *  with battlements, a gatehouse double door, a timber-floored hall. */
  private placeKeep(chunk: Chunk, ox: number, oy: number, oz: number): void {
    const W = 13, D = 13, H = 7;
    for (let dx = 0; dx < W; dx++) {
      for (let dz = 0; dz < D; dz++) {
        this.underpin(chunk, ox + dx, oz + dz, oy, B.STONE_BRICKS);
        const edge = dx === 0 || dx === W - 1 || dz === 0 || dz === D - 1;
        const tower = (dx <= 2 || dx >= W - 3) && (dz <= 2 || dz >= D - 3);
        const maxH = tower ? H + 4 : H;
        for (let dy = 1; dy <= maxH + 3; dy++) {
          let id = B.AIR;
          if (dy <= maxH && (edge || tower)) id = dy % 4 === 0 ? B.COBBLE : B.STONE_BRICKS;
          this.put(chunk, ox + dx, oy + dy, oz + dz, id);
        }
        if (!edge && !tower) this.put(chunk, ox + dx, oy + H, oz + dz, B.PLANKS);
        if (!edge && !tower) this.put(chunk, ox + dx, oy, oz + dz, B.PLANKS);
      }
    }
    // wall-walk crenellations on the curtain walls
    for (let dx = 0; dx < W; dx++) {
      for (let dz = 0; dz < D; dz++) {
        const edge = dx === 0 || dx === W - 1 || dz === 0 || dz === D - 1;
        const tower = (dx <= 2 || dx >= W - 3) && (dz <= 2 || dz >= D - 3);
        if (edge && !tower && (dx + dz) % 2 === 0) this.put(chunk, ox + dx, oy + H + 1, oz + dz, B.COBBLE);
      }
    }
    // gate (double door), windows
    this.putDoor(chunk, ox + 5, oy + 1, oz, 0, false);
    this.putDoor(chunk, ox + 6, oy + 1, oz, 0, true);
    this.put(chunk, ox + 5, oy + 3, oz, B.STONE_BRICKS);
    this.put(chunk, ox + 6, oy + 3, oz, B.STONE_BRICKS);
    this.putTorch(chunk, ox + 4, oy + 3, oz - 1, 0);
    this.putTorch(chunk, ox + 7, oy + 3, oz - 1, 0);
    for (const [wx, wz] of [[0, 6], [12, 6], [6, 12]]) {
      this.put(chunk, ox + wx, oy + 3, oz + wz, B.GLASS);
      this.put(chunk, ox + wx, oy + 4, oz + wz, B.GLASS);
    }
    // tower battlements
    for (const [tx, tz] of [[0, 0], [10, 0], [0, 10], [10, 10]]) {
      for (let dx = 0; dx < 3; dx++) {
        for (let dz = 0; dz < 3; dz++) {
          if ((dx + dz) % 2 === 0) this.put(chunk, ox + tx + dx, oy + H + 5, oz + tz + dz, B.STONE_BRICKS);
        }
      }
      this.putTorch(chunk, ox + tx + 1, oy + H + 5, oz + tz + 1);
    }
    this.put(chunk, ox + 3, oy + 1, oz + 3, B.TABLE);
    this.put(chunk, ox + 9, oy + 1, oz + 3, B.FURNACE);
    this.put(chunk, ox + 3, oy + 1, oz + 9, B.CHEST_LOOT);
    this.put(chunk, ox + 9, oy + 1, oz + 9, B.CHEST_LOOT);
    this.putBed(chunk, ox + 6, oy + 1, oz + 10, 2);
    this.putTorch(chunk, ox + 6, oy + 3, oz + 11, 0);
    this.putTorch(chunk, ox + 1, oy + 3, oz + 5, 3);
    this.putTorch(chunk, ox + 11, oy + 3, oz + 5, 1);
    // hollow the towers' ground floor + a ladder up to the roof
    for (let dy = 1; dy <= H + 4; dy++) {
      this.put(chunk, ox + 1, oy + dy, oz + 1, B.LADDER);
      this.put(chunk, ox + 1, oy + dy, oz + 2, B.AIR);
      this.put(chunk, ox + 2, oy + dy, oz + 1, B.AIR);
      this.put(chunk, ox + 2, oy + dy, oz + 2, B.AIR);
    }
    this.put(chunk, ox + 2, oy + 1, oz + 3, B.AIR); this.put(chunk, ox + 2, oy + 2, oz + 3, B.AIR); // tower door
  }
}
