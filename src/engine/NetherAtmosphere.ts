// Nether air: works out which Nether biome surrounds the player — from the
// generator's netherBiomeAt() when it has one, otherwise by reading the ground
// and ceiling blocks around them (crimson/warped nylium and wart, soul sand and
// soil, basalt and blackstone, netherrack) — and blends a smooth set of weights
// that steer the haze colour and depth, the ambient light, the lava-sea glow
// and heat shimmer, the particles and the ambience/music crossfades.

import * as THREE from 'three';
import { B, registryId } from './Blocks';

export type NetherBiome = 'wastes' | 'crimson' | 'warped' | 'soul' | 'basalt';
export type NetherWeights = Record<NetherBiome, number>;
export const NETHER_BIOMES: NetherBiome[] = ['wastes', 'crimson', 'warped', 'soul', 'basalt'];

/** Per-biome air: haze colour + depth, ambient floor, lava-glow tint and strength, heat haze. */
interface Air { fog: THREE.Color; ambient: THREE.Color; glow: THREE.Color; glowK: number; near: number; far: number; heat: number; tint: string }
const AIR: Record<NetherBiome, Air> = {
  // a smoky red cavern
  wastes: { fog: new THREE.Color(0x3a0f0b), ambient: new THREE.Color(0.1, 0.062, 0.05), glow: new THREE.Color(1.0, 0.36, 0.1), glowK: 0.5, near: 14, far: 78, heat: 1, tint: 'rgba(110,18,8,0.5)' },
  // a deep crimson haze under the wart canopy
  crimson: { fog: new THREE.Color(0x4a0a0a), ambient: new THREE.Color(0.12, 0.05, 0.045), glow: new THREE.Color(1.0, 0.28, 0.12), glowK: 0.42, near: 11, far: 68, heat: 0.8, tint: 'rgba(120,6,10,0.52)' },
  // cold teal fog among the warped stems
  warped: { fog: new THREE.Color(0x0f3a3c), ambient: new THREE.Color(0.045, 0.085, 0.09), glow: new THREE.Color(0.9, 0.4, 0.2), glowK: 0.26, near: 11, far: 70, heat: 0.5, tint: 'rgba(8,70,72,0.5)' },
  // pale blue-grey desolation over the soul sand
  soul: { fog: new THREE.Color(0x2a4552), ambient: new THREE.Color(0.06, 0.078, 0.095), glow: new THREE.Color(0.55, 0.62, 0.8), glowK: 0.2, near: 10, far: 66, heat: 0.3, tint: 'rgba(30,62,80,0.5)' },
  // thick grey-violet ash haze in the deltas
  basalt: { fog: new THREE.Color(0x5b5263), ambient: new THREE.Color(0.1, 0.094, 0.11), glow: new THREE.Color(1.0, 0.42, 0.16), glowK: 0.36, near: 5, far: 52, heat: 1.2, tint: 'rgba(70,60,82,0.5)' },
};

/** The renderer's Nether air block (Renderer.netherAir), written each frame. */
export interface NetherAirOut { fog: THREE.Color; ambient: THREE.Color; glow: THREE.Color; glowK: number; heat: number; near: number; far: number; lavaY: number }

interface AtmoWorld {
  getBlock(x: number, y: number, z: number): number;
  generator: unknown;
}

export class NetherAtmosphere {
  /** smoothed weights (sum 1) */
  readonly w: NetherWeights = { wastes: 1, crimson: 0, warped: 0, soul: 0, basalt: 0 };
  private target: NetherWeights = { wastes: 1, crimson: 0, warped: 0, soul: 0, basalt: 0 };
  private sampleT = 0;
  private byId: Map<number, NetherBiome> | null = null;
  private tc = new THREE.Color();

  /** Jump straight to the current surroundings (after a teleport or load). */
  snap(world: AtmoWorld, x: number, y: number, z: number): void {
    this.sample(world, x, y, z);
    for (const b of NETHER_BIOMES) this.w[b] = this.target[b];
    this.sampleT = 0.5;
  }

  update(dt: number, world: AtmoWorld, x: number, y: number, z: number): void {
    this.sampleT -= dt;
    if (this.sampleT <= 0) { this.sampleT = 0.5; this.sample(world, x, y, z); }
    // ~3 s crossfade between biomes
    const k = Math.min(1, dt * 0.45);
    for (const b of NETHER_BIOMES) this.w[b] += (this.target[b] - this.w[b]) * k;
  }

  dominant(): NetherBiome {
    let best: NetherBiome = 'wastes', bw = -1;
    for (const b of NETHER_BIOMES) if (this.w[b] > bw) { bw = this.w[b]; best = b; }
    return best;
  }

  /** Blend the per-biome air into the renderer's Nether settings. */
  apply(out: NetherAirOut): void {
    out.fog.setRGB(0, 0, 0); out.ambient.setRGB(0, 0, 0); out.glow.setRGB(0, 0, 0);
    out.glowK = 0; out.near = 0; out.far = 0; out.heat = 0;
    for (const b of NETHER_BIOMES) {
      const k = this.w[b];
      if (k <= 0.0001) continue;
      const a = AIR[b];
      out.fog.add(this.tc.copy(a.fog).multiplyScalar(k));
      out.ambient.add(this.tc.copy(a.ambient).multiplyScalar(k));
      out.glow.add(this.tc.copy(a.glow).multiplyScalar(k));
      out.glowK += a.glowK * k; out.near += a.near * k; out.far += a.far * k; out.heat += a.heat * k;
    }
  }

  /** CSS vignette colour for the screen-edge tint (dominant biome). */
  vignette(): string { return AIR[this.dominant()].tint; }

  private ids(): Map<number, NetherBiome> {
    if (this.byId) return this.byId;
    const m = new Map<number, NetherBiome>();
    const put = (names: string[], b: NetherBiome): void => {
      for (const n of names) { const id = registryId(n); if (id > 0) m.set(id, b); }
    };
    put(['crimson_nylium', 'crimson_stem', 'nether_wart_block', 'crimson_roots', 'crimson_fungus', 'weeping_vines', 'crimson_planks'], 'crimson');
    put(['warped_nylium', 'warped_stem', 'warped_wart_block', 'warped_roots', 'warped_fungus', 'twisting_vines', 'nether_sprouts', 'warped_planks'], 'warped');
    put(['soul_soil', 'bone_block'], 'soul');
    put(['basalt', 'polished_basalt', 'blackstone', 'smooth_basalt'], 'basalt');
    m.set(B.SOUL_SAND, 'soul');
    for (const id of [B.NETHERRACK, B.QUARTZ_ORE, B.MAGMA, B.GLOWSTONE]) m.set(id, 'wastes');
    const gold = registryId('nether_gold_ore');
    if (gold > 0) m.set(gold, 'wastes');
    this.byId = m;
    return m;
  }

  private sample(world: AtmoWorld, px: number, py: number, pz: number): void {
    const t = this.target;
    for (const b of NETHER_BIOMES) t[b] = 0;
    const gen = world.generator as { netherBiomeAt?: (x: number, z: number, y?: number) => string };
    const bx = Math.floor(px), by = Math.floor(py), bz = Math.floor(pz);
    let total = 0;
    if (typeof gen.netherBiomeAt === 'function') {
      // the generator knows its own biome map: sample a small disc
      for (let i = 0; i < 13; i++) {
        const a = i * 2.4, r = i === 0 ? 0 : 3 + (i % 3) * 5;
        const sx = bx + Math.round(Math.cos(a) * r), sz = bz + Math.round(Math.sin(a) * r);
        const name = String(gen.netherBiomeAt(sx, sz, by)).toLowerCase();
        const b: NetherBiome = name.includes('crimson') ? 'crimson' : name.includes('warped') ? 'warped'
          : name.includes('soul') ? 'soul' : name.includes('basalt') || name.includes('delta') ? 'basalt' : 'wastes';
        const k = 1 / (1 + r * 0.12);
        t[b] += k; total += k;
      }
    } else {
      const ids = this.ids();
      // read the floor under (and roof over) a spread of columns
      for (let i = 0; i < 25; i++) {
        const a = i * 2.39996, r = i === 0 ? 0 : 1.5 + Math.sqrt(i) * 2.6;
        const sx = bx + Math.round(Math.cos(a) * r), sz = bz + Math.round(Math.sin(a) * r);
        const k = 1 / (1 + r * 0.1);
        for (let y = by + 2; y >= by - 14; y--) {
          const id = world.getBlock(sx, y, sz);
          if (id === B.AIR || id === B.LAVA || id === B.FIRE) continue;
          const b = ids.get(id);
          if (b) { t[b] += k; total += k; }
          break;
        }
        for (let y = by + 3; y <= by + 16; y++) {
          const id = world.getBlock(sx, y, sz);
          if (id === B.AIR) continue;
          const b = ids.get(id);
          // a wart canopy overhead says "forest" even where the floor is bare
          if (b === 'crimson' || b === 'warped') { t[b] += k * 0.6; total += k * 0.6; }
          break;
        }
      }
    }
    if (total <= 0) { t.wastes = 1; return; }
    for (const b of NETHER_BIOMES) t[b] /= total;
  }
}
