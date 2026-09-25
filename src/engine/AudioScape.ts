// Soundscape probe: samples the blocks, mobs and weather around the listener a
// few times a second and boils them down to the numbers the ambience engine
// mixes by — how much foliage, water, fire and lava is near (and which side
// it's on), how big the space you're standing in is, what's over your head,
// and whether anything hostile is chasing you. Pure reads; no audio here.

import { B, LEAF_BLOCKS, isSolid } from './Blocks';

/** Minimal views of the game objects the probe reads (kept structural so the
 *  audio code doesn't pull in the world / entity modules). */
export interface ScapeWorld {
  dimension: string;
  getBlock(x: number, y: number, z: number): number;
  skyLight(x: number, y: number, z: number): number;
  waterLevels?: Map<string, number>;
  generator: { biomeAt(x: number, z: number): string };
}
export interface ScapePlayer {
  pos: { x: number; y: number; z: number };
  yaw: number;
  mode: string;
  hp: number;
  dead: boolean;
  eyeHeight(): number;
}
export interface ScapeMob { kind: string; pos: { x: number; y: number; z: number }; state: string; tamed: boolean; dead: boolean }
export interface ScapeWeather { kind: string; intensity: number }

/** What's where, as seen (heard) from the player's head. Pans are -1..1. */
export interface Scape {
  dim: 'overworld' | 'nether';
  y: number;
  biome: string;
  /** sky light at the head, 0 (buried) .. 1 (open sky) */
  sky: number;
  /** below the surface with no daylight reaching you */
  underground: boolean;
  /** what the rain lands on above you */
  roof: 'open' | 'leaves' | 'solid';
  /** mean free distance of probe rays (blocks) — the size of the space */
  room: number;
  /** fraction of probe rays that hit a wall within range */
  enclosed: number;
  leaves: number; leafPan: number;
  water: number; waterPan: number;
  ocean: boolean;
  flow: number; flowPan: number;
  fire: number; firePan: number;
  lava: number; lavaPan: number;
  villagers: number; villagePan: number;
  /** 0..1: hostiles currently chasing the player, weighted by closeness */
  threat: number;
  weather: string;
  intensity: number;
  cold: boolean;
  creative: boolean;
  hpFrac: number;
}

const HOSTILE = new Set(['zombie', 'skeleton', 'spider', 'creeper', 'phantom', 'cinderling', 'ashstalker', 'emberghast']);
const COLD = new Set(['snow', 'taiga']);
// 18 probe directions: 6 axes + 12 edge diagonals (normalised)
const RAYS: [number, number, number][] = [];
for (const [x, y, z] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1], [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1],
  [1, 0, 1], [1, 0, -1], [-1, 0, 1], [-1, 0, -1]]) {
  const l = Math.hypot(x, y, z);
  RAYS.push([x / l, y / l, z / l]);
}

export function probeScape(w: ScapeWorld, p: ScapePlayer, mobs: readonly ScapeMob[], weather: ScapeWeather | null): Scape {
  const hx = p.pos.x, hy = p.pos.y + p.eyeHeight(), hz = p.pos.z;
  const bx = Math.floor(hx), by = Math.floor(hy), bz = Math.floor(hz);
  const cy = Math.cos(p.yaw), sy = Math.sin(p.yaw);
  const panOf = (dx: number, dz: number): number => (dx * cy - dz * sy);
  const nether = w.dimension === 'nether';

  // --- block census: a strided box around the head ---------------------------
  const R = 14;
  let leaves = 0, lx = 0, water = 0, wxs = 0, flow = 0, fx = 0, fire = 0, frx = 0, lava = 0, lvx = 0;
  let seaWater = 0, seaCells = 0;
  const levels = w.waterLevels;
  for (let dx = -R; dx <= R; dx += 2) {
    for (let dz = -R; dz <= R; dz += 2) {
      const d2 = dx * dx + dz * dz;
      if (d2 > R * R) continue;
      const x = bx + dx, z = bz + dz;
      const wt = 1 / (1 + Math.sqrt(d2) * 0.22);
      const px = panOf(dx, dz) / (1 + Math.sqrt(d2));
      for (let dy = -6; dy <= 10; dy += 2) {
        const y = by + dy;
        if (y < 1 || y > 250) continue;
        const id = w.getBlock(x, y, z);
        if (id === B.AIR) continue;
        const ww = wt / (1 + Math.abs(dy) * 0.15);
        if (LEAF_BLOCKS.has(id)) { leaves += ww; lx += px * ww; }
        else if (id === B.WATER) {
          const flowing = levels?.has(`${x},${y},${z}`) || w.getBlock(x, y - 1, z) === B.AIR;
          if (flowing) { flow += ww; fx += px * ww; } else { water += ww; wxs += px * ww; }
        } else if (id === B.LAVA) { lava += ww; lvx += px * ww; }
        else if (id === B.FIRE || id === B.FURNACE_LIT) { fire += ww * 3; frx += px * ww * 3; }
      }
      // surface water sheet near sea level → ocean / beach
      if (!nether) {
        seaCells++;
        if (w.getBlock(x, 63, z) === B.WATER) seaWater++;
      }
    }
  }
  const pan = (v: number, s: number): number => (s > 0.01 ? Math.max(-1, Math.min(1, (v / s) * 2.5)) : 0);

  // --- probe rays: how big is this space? --------------------------------------
  const MAXR = 22;
  let sum = 0, hits = 0;
  for (const [rx, ry, rz] of RAYS) {
    let d = 1;
    for (; d <= MAXR; d++) {
      if (isSolid(w.getBlock(Math.floor(hx + rx * d), Math.floor(hy + ry * d), Math.floor(hz + rz * d)))) break;
    }
    if (d <= MAXR) hits++;
    sum += Math.min(d, MAXR);
  }

  // --- roof over the head -------------------------------------------------------
  let roof: Scape['roof'] = 'open';
  for (let d = 1; d <= 24; d++) {
    const id = w.getBlock(bx, by + d, bz);
    if (id === B.AIR) continue;
    if (LEAF_BLOCKS.has(id)) { roof = 'leaves'; break; }
    if (isSolid(id)) { roof = 'solid'; break; }
  }

  // --- mobs: villagers for the village bed, chasers for the combat layer -------
  let villagers = 0, vx = 0, threat = 0;
  for (const m of mobs) {
    if (m.dead) continue;
    const dx = m.pos.x - hx, dz = m.pos.z - hz;
    const d = Math.hypot(dx, dz, m.pos.y - hy);
    if (m.kind === 'villager' && d < 40) { villagers++; vx += panOf(dx, dz) / Math.max(1, d); }
    else if (HOSTILE.has(m.kind) && !m.tamed && (m.state === 'chase' || m.state === 'fuse') && d < 24) {
      threat += d < 8 ? 0.55 : 0.55 * (1 - (d - 8) / 16) + 0.12;
    }
  }

  const sky = w.skyLight(bx, by, bz);
  const biome = nether ? 'nether' : w.generator.biomeAt(bx, bz);
  const kind = weather?.kind ?? 'clear';
  return {
    dim: nether ? 'nether' : 'overworld',
    y: hy,
    biome,
    sky,
    underground: !nether && sky < 0.5 && hy < 60,
    roof,
    room: sum / RAYS.length,
    enclosed: hits / RAYS.length,
    leaves: Math.min(1, leaves / 18), leafPan: pan(lx, leaves),
    water: Math.min(1, water / 30), waterPan: pan(wxs, water),
    ocean: seaCells > 0 && seaWater / seaCells > 0.3 && hy < 90,
    flow: Math.min(1, flow / 5), flowPan: pan(fx, flow),
    fire: Math.min(1, fire / 3), firePan: pan(frx, fire),
    lava: Math.min(1, lava / 6), lavaPan: pan(lvx, lava),
    villagers, villagePan: villagers ? Math.max(-1, Math.min(1, vx / villagers * 3)) : 0,
    threat: p.mode === 'creative' || p.dead ? 0 : Math.min(1, threat),
    weather: nether ? 'clear' : kind,
    intensity: nether ? 0 : weather?.intensity ?? 0,
    cold: COLD.has(biome), // matches Weather's isColdAt: these biomes snow instead of rain
    creative: p.mode === 'creative',
    hpFrac: p.mode === 'survival' ? Math.max(0, p.hp / 20) : 1,
  };
}
