// Procedural terrain: multi-octave simplex heightfield with temperature/humidity
// biomes (plains, forest, desert, snow mountains), beaches, water level, coal
// pockets, deterministic cross-chunk trees, and a structure pass (lone huts)
// written directly into chunk byte arrays with clipping.

import { Simplex2, Simplex3, hash2, hash3, mulberry32 } from './Noise';
import { Chunk, CX, CZ, CY } from './Chunk';
import { B } from './Blocks';

// Raised well above bedrock (y=0) so there's a deep stone column to mine through.
export const SEA_LEVEL = 64;

export type BiomeId = 'plains' | 'forest' | 'desert' | 'snow' | 'taiga' | 'swamp' | 'mountains' | 'jungle';

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
  /** villager spawn positions queued by village generation (consumed by EntityManager) */
  villageSpawns: { x: number; y: number; z: number }[] = [];

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
  }

  /** 0..1 strength of a rare, deep, meandering ravine slot at this column
   *  (1 = canyon centre, 0 = outside). Like rivers but far rarer and carved
   *  down into bedrock-deep stone rather than filled with water. */
  ravineMask(wx: number, wz: number): number {
    const n = Math.abs(this.ravine.fbm(wx * 0.0014, wz * 0.0014, 2));
    const HALF_WIDTH = 0.013;
    if (n >= HALF_WIDTH) return 0;
    const t = 1 - n / HALF_WIDTH;
    return t * t * (3 - 2 * t); // smoothstep: steep walls, flat floor
  }

  /** Spaghetti tunnels (two intersecting ridges) + cheese caverns. */
  private isCave(wx: number, wy: number, wz: number): boolean {
    const n1 = this.cave1.noise(wx * 0.034, wy * 0.052, wz * 0.034);
    if (Math.abs(n1) < 0.085) {
      const n2 = this.cave2.noise(wx * 0.027, wy * 0.045, wz * 0.027);
      if (Math.abs(n2) < 0.085) return true;
    }
    return this.cave1.noise(wx * 0.015, wy * 0.028, wz * 0.015) > 0.62;
  }

  temperatureAt(wx: number, wz: number): number {
    // higher frequency than before: biomes are smaller so a single trek crosses
    // several of them (the old ~0.0016 scale made each world feel single-biome)
    return this.temp.fbm(wx * 0.0042, wz * 0.0042, 2) * 0.5 + 0.5;
  }

  humidityAt(wx: number, wz: number): number {
    return this.humid.fbm(wx * 0.0047, wz * 0.0047, 2) * 0.5 + 0.5;
  }

  mountainFactor(wx: number, wz: number): number {
    const r = 1 - Math.abs(this.ridge.fbm(wx * 0.0028, wz * 0.0028, 3));
    return Math.max(0, r - 0.45) / 0.55; // 0..1, sparse peaks
  }

  /** 0..1, how strongly this column lies inside a meandering river channel. */
  riverFactor(wx: number, wz: number): number {
    const n = Math.abs(this.river.fbm(wx * 0.0011, wz * 0.0011, 2));
    const HALF_WIDTH = 0.035;
    if (n >= HALF_WIDTH) return 0;
    const t = 1 - n / HALF_WIDTH;
    return t * t * (3 - 2 * t); // smoothstep
  }

  heightAt(wx: number, wz: number): number {
    const cont = this.continent.fbm(wx * 0.0015, wz * 0.0015, 3);
    const hills = this.hills.fbm(wx * 0.008, wz * 0.008, 4);
    const m = this.mountainFactor(wx, wz);
    const t = this.temperatureAt(wx, wz);
    const humid = this.humidityAt(wx, wz);
    const erosion = this.erosion.fbm(wx * 0.0035, wz * 0.0035, 3) * 0.5 + 0.5;
    const detail = this.detail.fbm(wx * 0.027, wz * 0.027, 2);
    let h = 66 + cont * 13 + hills * 7 + detail * 1.8 + Math.pow(m, 2.2) * (42 + erosion * 20);
    // dry hot regions get broad, low dunes instead of noisy grassy hills
    if (t > 0.62 && humid < 0.45) {
      const dune = Math.sin(wx * 0.07 + this.seed) * Math.cos(wz * 0.045 - this.seed * 0.5);
      h += dune * 2.8;
      h = h * 0.92 + (SEA_LEVEL + 5 + cont * 5) * 0.08;
    }
    // swamp basins sit near sea level with shallow, flat waterlogged ground
    if (t > 0.38 && humid > 0.72 && cont < 0.25) {
      const swampK = Math.min(1, (humid - 0.72) / 0.2 + Math.max(0, 0.25 - cont));
      const swampH = SEA_LEVEL + 1 + hills * 2 + detail * 0.7;
      h = h * (1 - swampK * 0.65) + swampH * swampK * 0.65;
    }
    // windswept mountain ridges gain sharper shoulders.
    if (m > 0.5) h += Math.pow((m - 0.5) / 0.5, 1.6) * erosion * 14;
    // rivers carve down to just below sea level, cutting through hills
    const rv = this.riverFactor(wx, wz);
    if (rv > 0) {
      const bed = SEA_LEVEL - 1 - rv * 2;
      h = h * (1 - rv) + Math.min(h, bed) * rv;
    }
    return Math.max(4, Math.min(CY - 10, Math.floor(h)));
  }

  /** Per-column grass/foliage tint multiplier (warm-dry, lush, cold-pale). */
  grassTint(wx: number, wz: number, out: { r: number; g: number; b: number }): void {
    const t = this.temperatureAt(wx, wz);
    const m = this.humidityAt(wx, wz);
    // dry climates push yellow, humidity pushes deep green, cold washes pale-blue
    out.r = Math.min(1.15, 0.78 + (1 - m) * 0.34);
    out.g = 1.0;
    out.b = 0.55 + (1 - t) * 0.4;
    if (t < 0.32) { // cold fade
      const k = (0.32 - t) / 0.32;
      out.r = out.r * (1 - k) + 0.85 * k;
      out.b = Math.min(1, out.b + k * 0.15);
    }
  }

  biomeAt(wx: number, wz: number): BiomeId {
    return this.biomeAtHeight(wx, wz, this.heightAt(wx, wz));
  }

  private biomeAtHeight(wx: number, wz: number, h: number): BiomeId {
    const t = this.temperatureAt(wx, wz);
    const m = this.humidityAt(wx, wz);
    const peak = this.mountainFactor(wx, wz);
    if (h > 86 || peak > 0.72) return h > 98 || t < 0.38 ? 'snow' : 'mountains';
    if (t < 0.28) return 'snow';
    if (t < 0.42 && m > 0.45) return 'taiga';
    if (t > 0.62 && m < 0.42 && h < 64) return 'desert';
    if (t > 0.38 && m > 0.72 && h <= SEA_LEVEL + 8) return 'swamp';
    if (t > 0.55 && m > 0.64 && h < 78) return 'jungle'; // hot + very humid uplands
    if (m > 0.52) return 'forest';
    return 'plains';
  }

  /** Surface y (top non-air) at world column — generator view, ignores edits. */
  surfaceY(wx: number, wz: number): number {
    return Math.max(this.heightAt(wx, wz), SEA_LEVEL);
  }

  findSpawn(): { x: number; y: number; z: number } {
    const isGood = (wx: number, wz: number): number | null => {
      const h = this.heightAt(wx, wz);
      const biome = this.biomeAt(wx, wz);
      if (h < SEA_LEVEL + 2 || h > 76 || biome === 'snow' || biome === 'forest' || biome === 'swamp') return null;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nh = this.heightAt(wx + dx, wz + dz);
          if (Math.abs(nh - h) > 1 || nh < SEA_LEVEL + 1) return null;
        }
      }
      return h;
    };

    for (let r = 0; r <= 96; r += 4) {
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
    for (let z = 0; z < CZ; z++) {
      for (let x = 0; x < CX; x++) {
        const wx = bx + x, wz = bz + z;
        const h = this.heightAt(wx, wz);
        const biome = this.biomeAtHeight(wx, wz, h);
        const beach = h >= SEA_LEVEL - 2 && h <= SEA_LEVEL + 1 && biome !== 'swamp';
        // caves may breach the surface, but never near/under water
        const caveCeil = h < SEA_LEVEL + 2 ? h - 8 : h;
        // ravine: a deep open slot. Only on dry land; the floor rises toward the
        // rim (high rvFloor at the edges) so the walls step down into a canyon.
        const rv = h >= SEA_LEVEL + 3 ? this.ravineMask(wx, wz) : 0;
        const rvFloor = rv > 0 ? 11 + Math.round((1 - rv) * 24) : CY;

        for (let y = 0; y <= h; y++) {
          let id: number;
          if (y === 0) id = B.BEDROCK;
          else if (y > 3 && y <= caveCeil && (this.isCave(wx, y, wz) || y >= rvFloor)) {
            // deep caves/ravines below y=8 flood with lava; above that they stay airy
            if (y <= 8) chunk.setRaw(x, y, z, B.LAVA);
            else chunk.setRaw(x, y, z, B.AIR);
            continue;
          } else if (y < h - 3) {
            id = B.STONE;
            const r = hash3(this.seed, wx, y, wz);
            const blob = hash3(this.seed ^ 0xabc, wx >> 2, y >> 2, wz >> 2);
            if (blob < 0.012 && r < 0.8) id = B.GRAVEL;
            // ore depth bands raised with the terrain (+32) so they stay the same
            // distance below the surface as before the world got deeper
            else if (y <= 46 && r < 0.0035) id = B.DIAMOND_ORE;
            else if (y <= 62 && r >= 0.01 && r < 0.0135) id = B.GOLD_ORE;
            // amethyst (mob-catcher gem) is as common as iron in its band, so
            // catchers stay craftable without a dedicated mining expedition
            else if (y <= 62 && r >= 0.04 && r < 0.048) id = B.AMETHYST_ORE;
            else if (y <= 86 && r >= 0.02 && r < 0.028) id = B.IRON_ORE;
            else if (y <= 128 && r >= 0.03 && r < 0.04) id = B.COAL_ORE;
            // rare isolated lava pockets in the deep stone
            else if (y <= 16 && hash3(this.seed ^ 0x1a7a, wx, y, wz) < 0.004) id = B.LAVA;
          } else if (y < h) {
            id = biome === 'desert' || beach ? B.SAND : B.DIRT;
            if (biome === 'mountains' && y > h - 3 && h > 74) id = B.STONE;
          } else {
            // surface block
            if (biome === 'desert' || beach) id = B.SAND;
            else if (h < SEA_LEVEL) id = B.DIRT;
            else if (biome === 'snow') id = h > 92 ? B.STONE : B.SNOW_GRASS;
            else if (biome === 'taiga') id = h > 70 ? B.SNOW_GRASS : B.GRASS;
            else if (biome === 'mountains') id = h > 78 ? (h > 100 ? B.SNOW_GRASS : B.STONE) : B.GRASS;
            else if (biome === 'swamp') id = h <= SEA_LEVEL ? B.DIRT : B.GRASS;
            else id = B.GRASS;
          }
          chunk.setRaw(x, y, z, id);
        }
        for (let y = h + 1; y <= SEA_LEVEL; y++) chunk.setRaw(x, y, z, B.WATER);
      }
    }

    // --- tree pass (checks a 2-block margin so canopies cross borders) ----
    for (let z = -2; z < CZ + 2; z++) {
      for (let x = -2; x < CX + 2; x++) {
        const wx = bx + x, wz = bz + z;
        const r = hash2(this.seed ^ 0x7777, wx, wz);
        const biome = this.biomeAt(wx, wz);
        let chance = 0;
        if (biome === 'forest') chance = 0.024;
        else if (biome === 'plains') chance = 0.004;
        else if (biome === 'snow') chance = 0.015;
        else if (biome === 'taiga') chance = 0.022;
        else if (biome === 'swamp') chance = 0.014;
        else if (biome === 'jungle') chance = 0.05; // dense canopy
        if (r >= chance) continue;
        const h = this.heightAt(wx, wz);
        if (h < SEA_LEVEL || h > 95) continue;
        if (biome === 'snow' && h > 82) continue;
        const variant = hash2(this.seed ^ 0x8888, wx, wz);
        if (biome === 'snow' || biome === 'taiga') {
          this.placeSpruce(chunk, wx, h + 1, wz, 6 + Math.floor(variant * 4));
        } else if (biome === 'swamp') {
          this.placeSwampTree(chunk, wx, h + 1, wz, 5 + Math.floor(variant * 3));
        } else if (biome === 'jungle') {
          this.placeJungleTree(chunk, wx, h + 1, wz, 8 + Math.floor(variant * 8));
        } else if ((biome === 'forest' && variant < 0.3) || (biome === 'plains' && variant < 0.15)) {
          this.placeTree(chunk, wx, h + 1, wz, 5 + Math.floor(variant * 10) % 3, B.BIRCH_LOG, B.BIRCH_LEAVES);
        } else {
          this.placeTree(chunk, wx, h + 1, wz, 4 + Math.floor(variant * 3), B.LOG, B.LEAVES);
        }
      }
    }

    // --- surface decorations: flowers, tall grass, cactus, sugar cane -----
    for (let z = 0; z < CZ; z++) {
      for (let x = 0; x < CX; x++) {
        const wx = bx + x, wz = bz + z;
        const h = this.heightAt(wx, wz);
        if (h < SEA_LEVEL || h > 100) continue;
        const surface = chunk.get(x, h, z);
        const r = hash2(this.seed ^ 0xf10a, wx, wz);
        const biome = this.biomeAtHeight(wx, wz, h);
        if (surface === B.GRASS && chunk.get(x, h + 1, z) === B.AIR) {
          const grassChance =
            biome === 'plains' ? 0.09 :
            biome === 'forest' || biome === 'swamp' ? 0.06 :
            biome === 'taiga' ? 0.035 : 0.02;
          if (r < grassChance) chunk.setRaw(x, h + 1, z, B.TALL_GRASS);
          else if (r < grassChance + 0.012 && biome !== 'snow' && biome !== 'taiga') {
            chunk.setRaw(x, h + 1, z, r * 1e4 % 1 < 0.5 ? B.POPPY : B.DANDELION);
          }
        } else if (surface === B.SAND && chunk.get(x, h + 1, z) === B.AIR) {
          if (biome === 'desert' && r < 0.008) {
            const tall = 1 + Math.floor(hash2(this.seed ^ 0xcac7, wx, wz) * 3);
            for (let dy = 1; dy <= tall; dy++) chunk.setRaw(x, h + dy, z, B.CACTUS);
          }
        }
        // sugar cane on banks: low ground with adjacent water
        if ((surface === B.GRASS || surface === B.SAND || surface === B.DIRT) &&
          h >= SEA_LEVEL && h <= SEA_LEVEL + 1 &&
          chunk.get(x, h + 1, z) === B.AIR &&
          hash2(this.seed ^ 0xca9e, wx, wz) < (biome === 'swamp' ? 0.16 : 0.07)) {
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

    // --- structure pass: huts + buried dungeons, over a 3x3 neighborhood --
    for (let scz = chunk.cz - 1; scz <= chunk.cz + 1; scz++) {
      for (let scx = chunk.cx - 1; scx <= chunk.cx + 1; scx++) {
        if (hash2(this.seed ^ 0xbeef, scx, scz) < 0.035) {
          const ox = scx * CX + 2 + Math.floor(hash2(this.seed ^ 0xcafe, scx, scz) * 7);
          const oz = scz * CZ + 2 + Math.floor(hash2(this.seed ^ 0xfade, scx, scz) * 9);
          const oy = this.heightAt(ox + 3, oz + 2);
          if (oy > SEA_LEVEL && oy <= 88) this.placeHut(chunk, ox, oy, oz);
        }
        if (hash2(this.seed ^ 0xd11e, scx, scz) < 0.07) {
          const ox = scx * CX + 2 + Math.floor(hash2(this.seed ^ 0xd22e, scx, scz) * 7);
          const oz = scz * CZ + 2 + Math.floor(hash2(this.seed ^ 0xd33e, scx, scz) * 7);
          const surface = this.heightAt(ox + 3, oz + 3);
          const oy = 7 + Math.floor(hash2(this.seed ^ 0xd44e, scx, scz) * Math.max(4, surface - 22));
          if (oy + 7 < surface - 4) this.placeDungeon(chunk, ox, oy, oz);
        }
        // deeper multi-room crypts: rarer than dungeons, but more rewarding
        if (hash2(this.seed ^ 0xc11e, scx, scz) < 0.032) {
          const ox = scx * CX + Math.floor(hash2(this.seed ^ 0xc22e, scx, scz) * 8);
          const oz = scz * CZ + Math.floor(hash2(this.seed ^ 0xc33e, scx, scz) * 8);
          const surface = this.heightAt(ox + 7, oz + 7);
          const oy = 9 + Math.floor(hash2(this.seed ^ 0xc44e, scx, scz) * Math.max(5, surface - 30));
          if (oy + 8 < surface - 6) this.placeCrypt(chunk, ox, oy, oz);
        }
        // overgrown ruins: common low broken-wall remnants on temperate land
        if (hash2(this.seed ^ 0x2ec5, scx, scz) < 0.03) {
          const ox = scx * CX + 3 + Math.floor(hash2(this.seed ^ 0x2ec6, scx, scz) * 6);
          const oz = scz * CZ + 3 + Math.floor(hash2(this.seed ^ 0x2ec7, scx, scz) * 6);
          const oy = this.heightAt(ox + 3, oz + 2);
          const biome = this.biomeAtHeight(ox + 3, oz + 2, oy);
          if ((biome === 'plains' || biome === 'forest' || biome === 'taiga' || biome === 'jungle') &&
            oy > SEA_LEVEL && oy <= 88) {
            this.placeRuin(chunk, ox, oy, oz);
          }
        }
        // desert temple: rare, only on desert surface
        if (hash2(this.seed ^ 0x7eab, scx, scz) < 0.012) {
          const ox = scx * CX + 3 + Math.floor(hash2(this.seed ^ 0x7eac, scx, scz) * 6);
          const oz = scz * CZ + 3 + Math.floor(hash2(this.seed ^ 0x7ead, scx, scz) * 6);
          const oy = this.heightAt(ox + 5, oz + 5);
          if (this.biomeAt(ox + 5, oz + 5) === 'desert' && oy > SEA_LEVEL && oy <= 80) {
            this.placeTemple(chunk, ox, oy, oz);
          }
        }
        // igloo: rare, only on snow surface
        if (hash2(this.seed ^ 0x191e, scx, scz) < 0.014) {
          const ox = scx * CX + 3 + Math.floor(hash2(this.seed ^ 0x191f, scx, scz) * 6);
          const oz = scz * CZ + 3 + Math.floor(hash2(this.seed ^ 0x1920, scx, scz) * 6);
          const oy = this.heightAt(ox + 4, oz + 4);
          if (this.biomeAt(ox + 4, oz + 4) === 'snow' && oy > SEA_LEVEL && oy <= 80) {
            this.placeIgloo(chunk, ox, oy, oz);
          }
        }
        // swamp hut: compact witch-style shelter on stilts
        if (hash2(this.seed ^ 0x5eab, scx, scz) < 0.018) {
          const ox = scx * CX + 2 + Math.floor(hash2(this.seed ^ 0x5eac, scx, scz) * 8);
          const oz = scz * CZ + 2 + Math.floor(hash2(this.seed ^ 0x5ead, scx, scz) * 8);
          const oy = this.heightAt(ox + 4, oz + 4);
          if (this.biomeAtHeight(ox + 4, oz + 4, oy) === 'swamp' && oy >= SEA_LEVEL && oy <= SEA_LEVEL + 8) {
            this.placeSwampHut(chunk, ox, oy, oz);
          }
        }
        // watchtowers: small above-ground landmarks with loot and a high view
        if (hash2(this.seed ^ 0x70ab, scx, scz) < 0.024) {
          const ox = scx * CX + 3 + Math.floor(hash2(this.seed ^ 0x70ac, scx, scz) * 7);
          const oz = scz * CZ + 3 + Math.floor(hash2(this.seed ^ 0x70ad, scx, scz) * 7);
          const oy = this.heightAt(ox + 3, oz + 3);
          const biome = this.biomeAtHeight(ox + 3, oz + 3, oy);
          if ((biome === 'plains' || biome === 'forest' || biome === 'taiga' || biome === 'desert') && oy > SEA_LEVEL && oy <= 86) {
            this.placeWatchtower(chunk, ox, oy, oz, biome === 'desert');
          }
        }
        // mountain keep / small palace: rare larger landmark on flatter ridges
        if (hash2(this.seed ^ 0xca57, scx, scz) < 0.01) {
          const ox = scx * CX + 1 + Math.floor(hash2(this.seed ^ 0xca58, scx, scz) * 6);
          const oz = scz * CZ + 1 + Math.floor(hash2(this.seed ^ 0xca59, scx, scz) * 6);
          const oy = this.heightAt(ox + 6, oz + 6);
          const biome = this.biomeAtHeight(ox + 6, oz + 6, oy);
          if ((biome === 'mountains' || biome === 'plains' || biome === 'taiga') && oy > SEA_LEVEL + 5 && oy <= 96 &&
            this.isFlatEnough(ox + 6, oz + 6, 5, 4)) {
            this.placeKeep(chunk, ox, oy, oz);
          }
        }
        // village: cluster of houses on plains/forest — villagers spawn here
        // (tracked in world.villageSpawns so the entity manager can place NPCs).
        // Bumped up so villages stay findable now that biomes are smaller.
        if (hash2(this.seed ^ 0xb1b0, scx, scz) < 0.032) {
          const ox = scx * CX + 4 + Math.floor(hash2(this.seed ^ 0xb1b1, scx, scz) * 4);
          const oz = scz * CZ + 4 + Math.floor(hash2(this.seed ^ 0xb1b2, scx, scz) * 4);
          const oy = this.heightAt(ox + 6, oz + 6);
          const biome = this.biomeAt(ox + 6, oz + 6);
          if ((biome === 'plains' || biome === 'forest') && oy > SEA_LEVEL && oy <= 78) {
            this.placeVillage(chunk, ox, oy, oz);
          }
        }
        // small ponds break up plains/forest/swamp travel and create fishing spots
        if (hash2(this.seed ^ 0xa417, scx, scz) < 0.028) {
          const ox = scx * CX + 3 + Math.floor(hash2(this.seed ^ 0xa418, scx, scz) * 8);
          const oz = scz * CZ + 3 + Math.floor(hash2(this.seed ^ 0xa419, scx, scz) * 8);
          const oy = this.heightAt(ox + 3, oz + 3);
          const biome = this.biomeAt(ox + 3, oz + 3);
          if ((biome === 'plains' || biome === 'forest' || biome === 'swamp') && oy >= SEA_LEVEL && oy <= SEA_LEVEL + 8) {
            this.placePond(chunk, ox, oy, oz);
          }
        }
        // exposed stone/cobble boulders make taiga and mountain terrain easier to read
        if (hash2(this.seed ^ 0xb011, scx, scz) < 0.035) {
          const ox = scx * CX + 2 + Math.floor(hash2(this.seed ^ 0xb012, scx, scz) * 10);
          const oz = scz * CZ + 2 + Math.floor(hash2(this.seed ^ 0xb013, scx, scz) * 10);
          const oy = this.heightAt(ox, oz);
          const biome = this.biomeAt(ox, oz);
          if ((biome === 'taiga' || biome === 'mountains' || biome === 'plains') && oy > SEA_LEVEL && oy <= 104) {
            this.placeBoulder(chunk, ox, oy + 1, oz, 1 + Math.floor(hash2(this.seed ^ 0xb014, ox, oz) * 2));
          }
        }
      }
    }

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

  private placeTree(chunk: Chunk, wx: number, wy: number, wz: number, height: number, log: number, leaves: number): void {
    // round canopy
    for (let dy = height - 3; dy <= height; dy++) {
      const rad = dy >= height - 1 ? 1 : 2;
      for (let dx = -rad; dx <= rad; dx++) {
        for (let dz = -rad; dz <= rad; dz++) {
          if (dx === 0 && dz === 0 && dy < height) continue;
          if (Math.abs(dx) === rad && Math.abs(dz) === rad) {
            if (hash3(this.seed ^ 0x4242, wx + dx, wy + dy, wz + dz) < 0.55) continue;
          }
          this.putIfAir(chunk, wx + dx, wy + dy, wz + dz, leaves);
        }
      }
    }
    for (let dy = 0; dy < height; dy++) this.put(chunk, wx, wy + dy, wz, log);
  }

  /** Conical spruce/taiga tree. */
  private placeSpruce(chunk: Chunk, wx: number, wy: number, wz: number, height: number): void {
    for (let dy = 2; dy <= height + 1; dy++) {
      let rad: number;
      if (dy === height + 1) rad = 0;
      else if (dy >= height - 1) rad = 1;
      else rad = (height - dy) % 2 === 0 ? 2 : 1;
      for (let dx = -rad; dx <= rad; dx++) {
        for (let dz = -rad; dz <= rad; dz++) {
          if (dx === 0 && dz === 0 && dy <= height) continue;
          if (rad === 2 && Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
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
    for (let dy = height - 4; dy <= height; dy++) {
      const rad = dy >= height ? 1 : dy >= height - 1 ? 2 : 3;
      for (let dx = -rad; dx <= rad; dx++) {
        for (let dz = -rad; dz <= rad; dz++) {
          if (dx === 0 && dz === 0 && dy < height) continue;
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
    for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2], [1, 2], [-1, -2]]) {
      if (hash2(this.seed ^ 0x5a40, wx + dx, wz + dz) < 0.75) {
        this.putIfAir(chunk, wx + dx, wy + height - 2, wz + dz, B.LEAVES);
        this.putIfAir(chunk, wx + dx, wy + height - 3, wz + dz, B.LEAVES);
      }
    }
  }

  private placeBoulder(chunk: Chunk, wx: number, wy: number, wz: number, radius: number): void {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dy = 0; dy <= radius + 1; dy++) {
          const d = Math.sqrt(dx * dx + dz * dz + (dy * 1.25) ** 2);
          if (d > radius + 0.55) continue;
          const id = hash3(this.seed ^ 0xb015, wx + dx, wy + dy, wz + dz) < 0.45 ? B.COBBLE : B.STONE;
          this.put(chunk, wx + dx, wy + dy, wz + dz, id, true);
        }
      }
    }
  }

  private placePond(chunk: Chunk, ox: number, oy: number, oz: number): void {
    const cx = ox + 3, cz = oz + 3;
    const rx = 3 + Math.floor(hash2(this.seed ^ 0xa41a, ox, oz) * 2);
    const rz = 3 + Math.floor(hash2(this.seed ^ 0xa41b, ox, oz) * 2);
    for (let dx = -rx; dx <= rx; dx++) {
      for (let dz = -rz; dz <= rz; dz++) {
        const n = hash2(this.seed ^ 0xa41c, cx + dx, cz + dz) * 0.35;
        const d = (dx * dx) / (rx * rx) + (dz * dz) / (rz * rz) + n;
        if (d > 1.05) continue;
        const edge = d > 0.72;
        const groundY = this.heightAt(cx + dx, cz + dz);
        const floorY = Math.min(oy - 1, groundY - (edge ? 1 : 2));
        for (let y = groundY + 2; y >= floorY + 1; y--) this.put(chunk, cx + dx, y, cz + dz, B.AIR);
        this.put(chunk, cx + dx, floorY, cz + dz, edge ? B.SAND : B.DIRT);
        const topWater = Math.min(oy, SEA_LEVEL + 1);
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
          this.put(chunk, ox + dx, oy + dy, oz + dz, edge ? B.COBBLE : B.AIR);
        }
      }
    }
    this.put(chunk, ox + 3, oy + 1, oz + 3, B.CHEST_LOOT);
  }

  /** Multi-room underground crypt with corridors, cells, torches, and two loot chests. */
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
    this.put(chunk, ox + 7, oy + 1, oz + 11, B.TORCH);
    this.put(chunk, ox + 3, oy + 1, oz + 3, B.TORCH);
    this.put(chunk, ox + 11, oy + 1, oz + 3, B.TORCH);
  }

  private putIfAir(chunk: Chunk, wx: number, wy: number, wz: number, id: number): void {
    const x = wx - chunk.cx * CX;
    const z = wz - chunk.cz * CZ;
    if (x < 0 || x >= CX || z < 0 || z >= CZ || wy < 0 || wy >= CY) return;
    if (chunk.get(x, wy, z) !== B.AIR) return;
    chunk.setRaw(x, wy, z, id);
  }

  /** Pyramid desert temple: sandstone shell with a TNT pressure-plate trap
   *  guarding two buried loot chests. */
  private placeTemple(chunk: Chunk, ox: number, oy: number, oz: number): void {
    const R = 5; // half-width of the pyramid base
    // stepped pyramid: each level shrinks by 1, made of sandstone
    for (let level = 0; level < 5; level++) {
      const r = R - level;
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          this.put(chunk, ox + 5 + dx, oy + level, oz + 5 + dz, B.SANDSTONE);
        }
      }
    }
    // hollow chamber under the apex
    const cx = ox + 5, cy = oy - 2, cz = oz + 5;
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dy = 0; dy < 4; dy++) {
          const edge = Math.abs(dx) === 2 || Math.abs(dz) === 2 || dy === 0 || dy === 3;
          this.put(chunk, cx + dx, cy + dy, cz + dz, edge ? B.SANDSTONE : B.AIR);
        }
      }
    }
    // TNT trap: a 3x3 floor of TNT under a sandstone plate, with a stone
    // pressure-plate-style block on top (we reuse cobble as the trigger tile)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        this.put(chunk, cx + dx, cy - 1, cz + dz, B.TNT);
      }
    }
    this.put(chunk, cx, cy, cz, B.COBBLE); // the "pressure plate" (ignitable)
    // two loot chests flanking the trap
    this.put(chunk, cx - 2, cy, cz + 2, B.CHEST_LOOT);
    this.put(chunk, cx + 2, cy, cz + 2, B.CHEST_LOOT);
    // entrance shaft down through the apex
    this.put(chunk, cx, oy, cz, B.AIR);
    this.put(chunk, cx, oy - 1, cz, B.AIR);
  }

  /** Snow igloo: a white-wool dome with a ladder down to a small basement
   *  holding a furnace, bed, and a loot chest. */
  private placeIgloo(chunk: Chunk, ox: number, oy: number, oz: number): void {
    const cx = ox + 4, cz = oz + 4;
    // dome of wool over a 7x7 footprint
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        for (let dy = 0; dy < 4; dy++) {
          const r = Math.hypot(dx, dz);
          const domeEdge = r > 3 - dy * 0.7;
          if (dy === 0) this.put(chunk, cx + dx, oy, cz + dz, B.SNOW_GRASS);
          if (dy > 0 && domeEdge) this.put(chunk, cx + dx, oy + dy, cz + dz, B.WOOL);
        }
      }
    }
    // hollow interior + doorway
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dy = 1; dy <= 3; dy++) this.put(chunk, cx + dx, oy + dy, cz + dz, B.AIR);
      }
    }
    // basement shaft with ladder
    for (let dy = 1; dy <= 5; dy++) {
      this.put(chunk, cx, oy - dy, cz, B.AIR);
      this.put(chunk, cx + 1, oy - dy, cz, B.LADDER);
    }
    // basement room (5x3x5)
    const by = oy - 6;
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dy = 0; dy <= 3; dy++) {
          const edge = Math.abs(dx) === 2 || Math.abs(dz) === 2 || dy === 0 || dy === 3;
          this.put(chunk, cx + dx, by + dy, cz + dz, edge ? B.STONE_BRICKS : B.AIR);
        }
      }
    }
    this.put(chunk, cx, by + 1, cz, B.LADDER);
    this.put(chunk, cx - 1, by + 1, cz + 1, B.FURNACE);
    this.put(chunk, cx + 1, by + 1, cz + 1, B.BED);
    this.put(chunk, cx, by + 1, cz - 1, B.TORCH);
    this.put(chunk, cx - 1, by + 1, cz - 1, B.CHEST_LOOT);
  }

  private placeSwampHut(chunk: Chunk, ox: number, oy: number, oz: number): void {
    const W = 7, D = 6, floorY = oy + 2;
    // stilts to ground/water
    for (const [dx, dz] of [[0, 0], [W - 1, 0], [0, D - 1], [W - 1, D - 1]]) {
      for (let y = oy - 2; y <= floorY; y++) this.put(chunk, ox + dx, y, oz + dz, B.SPRUCE_LOG);
    }
    for (let dx = 0; dx < W; dx++) {
      for (let dz = 0; dz < D; dz++) {
        this.put(chunk, ox + dx, floorY, oz + dz, B.PLANKS);
        for (let y = floorY + 1; y <= floorY + 4; y++) this.put(chunk, ox + dx, y, oz + dz, B.AIR);
        const edge = dx === 0 || dx === W - 1 || dz === 0 || dz === D - 1;
        if (edge) {
          for (let y = floorY + 1; y <= floorY + 3; y++) this.put(chunk, ox + dx, y, oz + dz, B.PLANKS);
        }
        if (dx >= 1 && dx <= W - 2 && dz >= 1 && dz <= D - 2) this.put(chunk, ox + dx, floorY + 4, oz + dz, B.SPRUCE_LOG);
      }
    }
    this.put(chunk, ox + 3, floorY + 1, oz, B.AIR);
    this.put(chunk, ox + 3, floorY + 2, oz, B.AIR);
    this.put(chunk, ox + 1, floorY + 2, oz + 2, B.GLASS);
    this.put(chunk, ox + 5, floorY + 2, oz + 2, B.GLASS);
    this.put(chunk, ox + 2, floorY + 1, oz + 4, B.TABLE);
    this.put(chunk, ox + 4, floorY + 1, oz + 4, B.CHEST_LOOT);
    this.put(chunk, ox + 3, floorY + 1, oz + 3, B.TORCH);
    this.put(chunk, ox + 3, floorY - 1, oz, B.LADDER);
    this.put(chunk, ox + 3, floorY, oz, B.LADDER);
  }

  private placeWatchtower(chunk: Chunk, ox: number, oy: number, oz: number, desert: boolean): void {
    const wall = desert ? B.SANDSTONE : B.COBBLE;
    const trim = desert ? B.SANDSTONE : B.STONE_BRICKS;
    const H = 9;
    for (let dx = 0; dx < 7; dx++) {
      for (let dz = 0; dz < 7; dz++) {
        for (let y = oy - 1; y <= oy; y++) this.put(chunk, ox + dx, y, oz + dz, trim);
        const edge = dx === 0 || dx === 6 || dz === 0 || dz === 6;
        for (let dy = 1; dy <= H; dy++) {
          if (edge) this.put(chunk, ox + dx, oy + dy, oz + dz, wall);
          else this.put(chunk, ox + dx, oy + dy, oz + dz, B.AIR);
        }
      }
    }
    // battlements
    for (let dx = 0; dx < 7; dx++) {
      for (let dz = 0; dz < 7; dz++) {
        const edge = dx === 0 || dx === 6 || dz === 0 || dz === 6;
        if (edge && (dx + dz) % 2 === 0) this.put(chunk, ox + dx, oy + H + 1, oz + dz, wall);
      }
    }
    // door, floors, ladder, loot
    this.put(chunk, ox + 3, oy + 1, oz, B.AIR);
    this.put(chunk, ox + 3, oy + 2, oz, B.AIR);
    for (let dx = 1; dx <= 5; dx++) {
      for (let dz = 1; dz <= 5; dz++) {
        if (dx === 3 && dz === 3) continue;
        this.put(chunk, ox + dx, oy + 5, oz + dz, B.PLANKS);
      }
    }
    for (let dy = 1; dy <= H; dy++) this.put(chunk, ox + 5, oy + dy, oz + 5, B.LADDER);
    this.put(chunk, ox + 2, oy + 1, oz + 4, B.CHEST_LOOT);
    this.put(chunk, ox + 4, oy + 6, oz + 2, B.TORCH);
  }

  /** Overgrown ruin: a small footprint of broken cobble/stone-brick walls that
   *  follows the terrain, with gravel rubble and an occasional loot chest. */
  private placeRuin(chunk: Chunk, ox: number, oy: number, oz: number): void {
    const W = 5 + Math.floor(hash2(this.seed ^ 0x2ed0, ox, oz) * 3); // 5-7
    const D = 4 + Math.floor(hash2(this.seed ^ 0x2ed1, oz, ox) * 3); // 4-6
    for (let dx = 0; dx < W; dx++) {
      for (let dz = 0; dz < D; dz++) {
        const wx = ox + dx, wz = oz + dz;
        const gy = this.heightAt(wx, wz);
        if (gy <= SEA_LEVEL || Math.abs(gy - oy) > 3) continue; // skip cliffs/water
        // foundation flush with the ground, some of it crumbled to gravel
        this.put(chunk, wx, gy, wz, hash3(this.seed ^ 0x2ed2, wx, gy, wz) < 0.32 ? B.GRAVEL : B.COBBLE);
        for (let dy = 1; dy <= 4; dy++) this.put(chunk, wx, gy + dy, wz, B.AIR); // clear scrub
        const edge = dx === 0 || dx === W - 1 || dz === 0 || dz === D - 1;
        if (!edge) continue;
        const corner = (dx === 0 || dx === W - 1) && (dz === 0 || dz === D - 1);
        const base = corner ? 3 : 1 + Math.floor(hash3(this.seed ^ 0x2ed3, wx, 0, wz) * 3);
        for (let dy = 1; dy <= base; dy++) {
          // upper courses crumble away for a ruined silhouette (corners hold)
          if (!corner && hash3(this.seed ^ 0x2ed4, wx, dy, wz) < (dy / (base + 1)) * 0.7) continue;
          const mat = hash3(this.seed ^ 0x2ed5, wx, dy, wz) < 0.3 ? B.STONE_BRICKS : B.COBBLE;
          this.put(chunk, wx, gy + dy, wz, mat);
        }
      }
    }
    // a half the time, a loot chest sits among the rubble in the centre
    if (hash2(this.seed ^ 0x2ed6, ox, oz) < 0.5) {
      const cx = ox + (W >> 1), cz = oz + (D >> 1);
      const gy = this.heightAt(cx, cz);
      if (gy > SEA_LEVEL && Math.abs(gy - oy) <= 3) this.put(chunk, cx, gy + 1, cz, B.CHEST_LOOT);
    }
  }

  private placeKeep(chunk: Chunk, ox: number, oy: number, oz: number): void {
    const W = 13, D = 13, H = 7;
    for (let dx = 0; dx < W; dx++) {
      for (let dz = 0; dz < D; dz++) {
        for (let y = oy - 2; y <= oy; y++) this.put(chunk, ox + dx, y, oz + dz, B.STONE_BRICKS);
        const edge = dx === 0 || dx === W - 1 || dz === 0 || dz === D - 1;
        const tower = (dx <= 2 || dx >= W - 3) && (dz <= 2 || dz >= D - 3);
        const maxH = tower ? H + 4 : H;
        for (let dy = 1; dy <= maxH; dy++) {
          if (edge || tower) this.put(chunk, ox + dx, oy + dy, oz + dz, dy % 3 === 0 ? B.COBBLE : B.STONE_BRICKS);
          else this.put(chunk, ox + dx, oy + dy, oz + dz, B.AIR);
        }
        if (!edge && !tower) this.put(chunk, ox + dx, oy + H, oz + dz, B.PLANKS);
      }
    }
    // inner hall, gate, windows
    this.put(chunk, ox + 6, oy + 1, oz, B.AIR);
    this.put(chunk, ox + 6, oy + 2, oz, B.AIR);
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
    }
    this.put(chunk, ox + 3, oy + 1, oz + 3, B.TABLE);
    this.put(chunk, ox + 9, oy + 1, oz + 3, B.FURNACE);
    this.put(chunk, ox + 3, oy + 1, oz + 9, B.CHEST_LOOT);
    this.put(chunk, ox + 9, oy + 1, oz + 9, B.CHEST_LOOT);
    this.put(chunk, ox + 6, oy + 1, oz + 6, B.TORCH);
    for (let dy = 1; dy <= H + 4; dy++) this.put(chunk, ox + 1, oy + dy, oz + 1, B.LADDER);
  }

  private isFlatEnough(cx: number, cz: number, radius: number, maxDelta: number): boolean {
    const h0 = this.heightAt(cx, cz);
    for (let dz = -radius; dz <= radius; dz += 2) {
      for (let dx = -radius; dx <= radius; dx += 2) {
        const h = this.heightAt(cx + dx, cz + dz);
        if (Math.abs(h - h0) > maxDelta || h <= SEA_LEVEL) return false;
      }
    }
    return true;
  }

  /** Village: a 3x3 cluster of small houses around a central well + paths,
   *  with 3-5 villagers queued for the entity manager to spawn. */
  private placeVillage(chunk: Chunk, ox: number, oy: number, oz: number): void {
    const placed: { x: number; z: number }[] = [];
    for (let hz = 0; hz < 3; hz++) {
      for (let hx = 0; hx < 3; hx++) {
        // skip some cells for an organic layout; center cell is the well
        const isCenter = hx === 1 && hz === 1;
        if (!isCenter && hash2(this.seed ^ 0xb1b3, ox + hx, oz + hz) < 0.35) continue;
        const hxw = ox + hx * 7;
        const hzw = oz + hz * 7;
        const hy = this.heightAt(hxw + 3, hzw + 2);
        if (hy <= SEA_LEVEL || hy > oy + 4) continue;
        if (isCenter) {
          // cobble well
          for (let dy = 0; dy < 4; dy++) {
            this.put(chunk, hxw + 3, hy + dy, hzw + 2, B.COBBLE);
            this.put(chunk, hxw + 4, hy + dy, hzw + 2, B.COBBLE);
            this.put(chunk, hxw + 3, hy + dy, hzw + 3, B.COBBLE);
            this.put(chunk, hxw + 4, hy + dy, hzw + 3, B.COBBLE);
          }
          // hollow + water
          this.put(chunk, hxw + 3, hy + 1, hzw + 2, B.WATER);
          this.put(chunk, hxw + 4, hy + 1, hzw + 2, B.WATER);
          this.put(chunk, hxw + 3, hy + 1, hzw + 3, B.WATER);
          this.put(chunk, hxw + 4, hy + 1, hzw + 3, B.WATER);
          this.put(chunk, hxw + 3, hy + 4, hzw + 2, B.PLANKS);
          this.put(chunk, hxw + 4, hy + 4, hzw + 2, B.PLANKS);
          this.put(chunk, hxw + 3, hy + 4, hzw + 3, B.PLANKS);
          this.put(chunk, hxw + 4, hy + 4, hzw + 3, B.PLANKS);
          this.placeFarmPlot(chunk, hxw - 5, hy, hzw + 6);
          this.placeFarmPlot(chunk, hxw + 7, hy, hzw + 6);
        } else {
          this.placeHut(chunk, hxw, hy, hzw);
          placed.push({ x: hxw + 3, z: hzw + 3 });
        }
      }
    }
    // queue 3-5 villagers at hut doorways (entity manager consumes these once)
    const n = 3 + Math.floor(hash2(this.seed ^ 0xb1b4, ox, oz) * 3);
    for (let i = 0; i < n && placed.length; i++) {
      const spot = placed[Math.floor(hash2(this.seed ^ 0xb1b5, ox + i, oz) * placed.length)];
      const vy = this.heightAt(spot.x, spot.z);
      this.villageSpawns.push({ x: spot.x + 0.5, y: vy + 1, z: spot.z + 0.5 });
    }
  }

  private placeFarmPlot(chunk: Chunk, ox: number, oy: number, oz: number): void {
    for (let dx = 0; dx < 5; dx++) {
      for (let dz = 0; dz < 7; dz++) {
        const wx = ox + dx, wz = oz + dz;
        const hy = this.heightAt(wx, wz);
        if (Math.abs(hy - oy) > 2 || hy <= SEA_LEVEL) continue;
        if (dx === 2) {
          this.put(chunk, wx, hy, wz, B.WATER);
          continue;
        }
        this.put(chunk, wx, hy, wz, B.FARMLAND);
        const r = hash2(this.seed ^ 0xfae1, wx, wz);
        const mature = r > 0.22;
        let crop = B.WHEAT_2;
        if (r < 0.25) crop = mature ? B.CARROT_2 : B.CARROT_1;
        else if (r < 0.48) crop = mature ? B.POTATO_2 : B.POTATO_1;
        else if (r < 0.62) crop = mature ? B.BEETROOT_2 : B.BEETROOT_1;
        else crop = mature ? B.WHEAT_2 : B.WHEAT_1;
        this.putIfAir(chunk, wx, hy + 1, wz, crop);
      }
    }
  }

  /** 7x5 plank hut with log corners, glass windows, a door gap, and a workshop. */
  private placeHut(chunk: Chunk, ox: number, oy: number, oz: number): void {
    const W = 7, D = 5, H = 4;
    for (let dx = 0; dx < W; dx++) {
      for (let dz = 0; dz < D; dz++) {
        // foundation down to terrain + floor
        for (let y = oy - 2; y <= oy; y++) this.put(chunk, ox + dx, y, oz + dz, B.PLANKS);
        // clear interior + space above roof line
        for (let y = oy + 1; y <= oy + H + 1; y++) this.put(chunk, ox + dx, y, oz + dz, B.AIR);
        // roof
        this.put(chunk, ox + dx, oy + H, oz + dz, B.PLANKS);
        const edgeX = dx === 0 || dx === W - 1;
        const edgeZ = dz === 0 || dz === D - 1;
        if (edgeX || edgeZ) {
          for (let y = oy + 1; y < oy + H; y++) {
            const corner = edgeX && edgeZ;
            this.put(chunk, ox + dx, y, oz + dz, corner ? B.LOG : B.PLANKS);
          }
        }
      }
    }
    // door gap on the front (south) wall
    const doorX = ox + 3;
    this.put(chunk, doorX, oy + 1, oz, B.AIR);
    this.put(chunk, doorX, oy + 2, oz, B.AIR);
    // windows
    this.put(chunk, ox + 1, oy + 2, oz, B.GLASS);
    this.put(chunk, ox + 5, oy + 2, oz, B.GLASS);
    this.put(chunk, ox, oy + 2, oz + 2, B.GLASS);
    this.put(chunk, ox + 6, oy + 2, oz + 2, B.GLASS);
    // furnishing
    this.put(chunk, ox + 1, oy + 1, oz + 3, B.TABLE);
    this.put(chunk, ox + 5, oy + 1, oz + 3, B.FURNACE);
    this.put(chunk, ox + 3, oy + 1, oz + 3, B.TORCH);
    this.put(chunk, ox + 1, oy + 1, oz + 1, B.CHEST_LOOT);
  }
}
