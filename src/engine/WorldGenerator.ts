// Procedural terrain: multi-octave simplex heightfield with temperature/humidity
// biomes (plains, forest, desert, snow mountains), beaches, water level, coal
// pockets, deterministic cross-chunk trees, and a structure pass (lone huts)
// written directly into chunk byte arrays with clipping.

import { Simplex2, Simplex3, hash2, hash3 } from './Noise';
import { Chunk, CX, CZ, CY } from './Chunk';
import { B } from './Blocks';

export const SEA_LEVEL = 32;

export type BiomeId = 'plains' | 'forest' | 'desert' | 'snow';

export class WorldGenerator {
  readonly seed: number;
  private hills: Simplex2;
  private continent: Simplex2;
  private ridge: Simplex2;
  private temp: Simplex2;
  private humid: Simplex2;
  private cave1: Simplex3;
  private cave2: Simplex3;
  private river: Simplex2;

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
    return this.temp.fbm(wx * 0.0016, wz * 0.0016, 2) * 0.5 + 0.5;
  }

  humidityAt(wx: number, wz: number): number {
    return this.humid.fbm(wx * 0.0019, wz * 0.0019, 2) * 0.5 + 0.5;
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
    let h = 34 + cont * 13 + hills * 7 + Math.pow(m, 2.2) * 52;
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
    const t = this.temperatureAt(wx, wz);
    const m = this.humidityAt(wx, wz);
    const h = this.heightAt(wx, wz);
    if (t < 0.3 || h > 80) return 'snow';
    if (t > 0.62 && m < 0.42 && h < 64) return 'desert';
    if (m > 0.52) return 'forest';
    return 'plains';
  }

  /** Surface y (top non-air) at world column — generator view, ignores edits. */
  surfaceY(wx: number, wz: number): number {
    return Math.max(this.heightAt(wx, wz), SEA_LEVEL);
  }

  findSpawn(): { x: number; y: number; z: number } {
    for (let r = 0; r < 64; r++) {
      const wx = r * 7, wz = (r % 3) * 11;
      const h = this.heightAt(wx, wz);
      if (h >= SEA_LEVEL + 1 && this.biomeAt(wx, wz) !== 'snow') {
        return { x: wx + 0.5, y: h + 2, z: wz + 0.5 };
      }
    }
    return { x: 0.5, y: this.heightAt(0, 0) + 2, z: 0.5 };
  }

  generate(chunk: Chunk): void {
    const bx = chunk.cx * CX;
    const bz = chunk.cz * CZ;

    // --- terrain columns -------------------------------------------------
    for (let z = 0; z < CZ; z++) {
      for (let x = 0; x < CX; x++) {
        const wx = bx + x, wz = bz + z;
        const h = this.heightAt(wx, wz);
        const biome = this.biomeAt(wx, wz);
        const beach = h >= SEA_LEVEL - 2 && h <= SEA_LEVEL + 1;
        // caves may breach the surface, but never near/under water
        const caveCeil = h < SEA_LEVEL + 2 ? h - 8 : h;

        for (let y = 0; y <= h; y++) {
          let id: number;
          if (y === 0) id = B.BEDROCK;
          else if (y > 3 && y <= caveCeil && this.isCave(wx, y, wz)) {
            chunk.setRaw(x, y, z, B.AIR);
            continue;
          } else if (y < h - 3) {
            id = B.STONE;
            const r = hash3(this.seed, wx, y, wz);
            const blob = hash3(this.seed ^ 0xabc, wx >> 2, y >> 2, wz >> 2);
            if (blob < 0.012 && r < 0.8) id = B.GRAVEL;
            else if (y <= 14 && r < 0.0035) id = B.DIAMOND_ORE;
            else if (y <= 30 && r >= 0.01 && r < 0.0135) id = B.GOLD_ORE;
            else if (y <= 54 && r >= 0.02 && r < 0.028) id = B.IRON_ORE;
            else if (y <= 96 && r >= 0.03 && r < 0.04) id = B.COAL_ORE;
          } else if (y < h) {
            id = biome === 'desert' || beach ? B.SAND : B.DIRT;
          } else {
            // surface block
            if (biome === 'desert' || beach) id = B.SAND;
            else if (h < SEA_LEVEL) id = B.DIRT;
            else if (biome === 'snow') id = h > 92 ? B.STONE : B.SNOW_GRASS;
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
        if (r >= chance) continue;
        const h = this.heightAt(wx, wz);
        if (h < SEA_LEVEL + 1 || h > 95) continue;
        if (biome === 'snow' && h > 82) continue;
        const variant = hash2(this.seed ^ 0x8888, wx, wz);
        if (biome === 'snow') {
          this.placeSpruce(chunk, wx, h + 1, wz, 6 + Math.floor(variant * 4));
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
        if (surface === B.GRASS && chunk.get(x, h + 1, z) === B.AIR) {
          const biome = this.biomeAt(wx, wz);
          const grassChance = biome === 'plains' ? 0.09 : biome === 'forest' ? 0.05 : 0.02;
          if (r < grassChance) chunk.setRaw(x, h + 1, z, B.TALL_GRASS);
          else if (r < grassChance + 0.012 && biome !== 'snow') {
            chunk.setRaw(x, h + 1, z, r * 1e4 % 1 < 0.5 ? B.POPPY : B.DANDELION);
          }
        } else if (surface === B.SAND && chunk.get(x, h + 1, z) === B.AIR) {
          const biome = this.biomeAt(wx, wz);
          if (biome === 'desert' && r < 0.008) {
            const tall = 1 + Math.floor(hash2(this.seed ^ 0xcac7, wx, wz) * 3);
            for (let dy = 1; dy <= tall; dy++) chunk.setRaw(x, h + dy, z, B.CACTUS);
          }
        }
        // sugar cane on banks: low ground with adjacent water
        if ((surface === B.GRASS || surface === B.SAND) &&
          h >= SEA_LEVEL && h <= SEA_LEVEL + 1 &&
          chunk.get(x, h + 1, z) === B.AIR &&
          hash2(this.seed ^ 0xca9e, wx, wz) < 0.07) {
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

  private putIfAir(chunk: Chunk, wx: number, wy: number, wz: number, id: number): void {
    const x = wx - chunk.cx * CX;
    const z = wz - chunk.cz * CZ;
    if (x < 0 || x >= CX || z < 0 || z >= CZ || wy < 0 || wy >= CY) return;
    if (chunk.get(x, wy, z) !== B.AIR) return;
    chunk.setRaw(x, wy, z, id);
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
