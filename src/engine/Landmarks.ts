// Landmark structures: the larger one-off builds (outposts, manors, windmill
// farms, lighthouses, fortified river bridges, camps, buried trail ruins,
// sunken ruins, an underground library and a deep "ancient city").
//
// The world is cut into LM_CELL squares; each square hosts at most one
// landmark, planned once from the height field (so it's a pure function of the
// seed) and kept entirely inside its square — landmarks can never overlap each
// other, and any chunk that intersects a landmark's box draws the part that
// falls inside it. All writes go through the generator's clipped put helpers,
// so doors/beds/wall torches reach the world via drainStates as usual.

import { B } from './Blocks';
import { Chunk, CX, CZ } from './Chunk';
import { hash2, hash3 } from './Noise';
import type { WorldGenerator } from './WorldGenerator';

export const LM_CELL = 112;
const SEA = 64;

export type LandmarkKind =
  'outpost' | 'mansion' | 'windmill' | 'lighthouse' | 'bridge' | 'camp' | 'trail_ruins' |
  'sunken_ruins' | 'library' | 'ancient_city';

export interface Landmark {
  kind: LandmarkKind;
  /** local-frame origin + size (see Frame) */
  ox: number; oz: number; w: number; d: number; dir: number;
  /** ground / floor level */
  y: number;
  v: number;
  /** world bounding box (inclusive), used for chunk overlap + clearances */
  x0: number; z0: number; x1: number; z1: number;
  /** below-ground builds don't clear trees or block surface structures */
  underground: boolean;
  /** bridge: axis + span */
  alongX?: boolean; span?: number;
}

const DX = [0, -1, 0, 1];
const DZ = [-1, 0, 1, 0];

/** A rotated local frame: u runs across the front, v runs front→back, and the
 *  front faces world direction `dir` (0=-z, 1=-x, 2=+z, 3=+x). */
class Frame {
  constructor(
    readonly g: WorldGenerator, readonly c: Chunk,
    readonly ox: number, readonly oz: number, readonly w: number, readonly d: number, readonly dir: number,
  ) {}
  x(u: number, v: number): number {
    switch (this.dir) {
      case 0: return this.ox + u;
      case 2: return this.ox + this.w - 1 - u;
      case 1: return this.ox + v;
      default: return this.ox + this.d - 1 - v;
    }
  }
  z(u: number, v: number): number {
    switch (this.dir) {
      case 0: return this.oz + v;
      case 2: return this.oz + this.d - 1 - v;
      case 1: return this.oz + this.w - 1 - u;
      default: return this.oz + u;
    }
  }
  /** local direction → world direction code: 'f' front (-v), 'b' back, 'l' (-u), 'r' (+u) */
  wd(l: 'f' | 'b' | 'l' | 'r'): number {
    const d = this.dir;
    return l === 'f' ? d : l === 'b' ? (d + 2) & 3 : l === 'l' ? (d + 1) & 3 : (d + 3) & 3;
  }
  set(u: number, y: number, v: number, id: number): void { this.g.put(this.c, this.x(u, v), y, this.z(u, v), id); }
  ifAir(u: number, y: number, v: number, id: number): void { this.g.putIfAir(this.c, this.x(u, v), y, this.z(u, v), id); }
  ground(u: number, v: number): number { return this.g.heightAt(this.x(u, v), this.z(u, v)); }
  pin(u: number, v: number, top: number, id: number): void { this.g.underpin(this.c, this.x(u, v), this.z(u, v), top, id); }
  clear(u: number, v: number, y0: number, y1: number): void { this.g.clearCol(this.c, this.x(u, v), this.z(u, v), y0, y1); }
  torch(u: number, y: number, v: number, l?: 'f' | 'b' | 'l' | 'r'): void {
    this.g.putTorch(this.c, this.x(u, v), y, this.z(u, v), l ? this.wd(l) : undefined);
  }
  door(u: number, y: number, v: number, l: 'f' | 'b' | 'l' | 'r', hingeRight = false): void {
    this.g.putDoor(this.c, this.x(u, v), y, this.z(u, v), this.wd(l), hingeRight);
  }
  bed(u: number, y: number, v: number, l: 'f' | 'b' | 'l' | 'r'): void {
    this.g.putBed(this.c, this.x(u, v), y, this.z(u, v), this.wd(l));
  }
  box(u0: number, y0: number, v0: number, u1: number, y1: number, v1: number, id: number): void {
    for (let u = u0; u <= u1; u++) for (let v = v0; v <= v1; v++) for (let y = y0; y <= y1; y++) this.set(u, y, v, id);
  }
}

// --- planning ---------------------------------------------------------------

/** Plan the landmark (if any) of LM_CELL square (rx, rz). */
export function planLandmark(g: WorldGenerator, rx: number, rz: number): Landmark | null {
  const S = g.seed ^ 0x1a4d;
  if (hash2(S, rx, rz) > 0.6) return null;
  const M = 26; // keep the anchor well inside the square
  const ax = rx * LM_CELL + M + Math.floor(hash2(S ^ 1, rx, rz) * (LM_CELL - 2 * M));
  const az = rz * LM_CELL + M + Math.floor(hash2(S ^ 2, rx, rz) * (LM_CELL - 2 * M));
  const v = hash2(S ^ 3, rx, rz);
  const dir = Math.floor(hash2(S ^ 4, rx, rz) * 4);
  const label = g.biomeLabel(ax, az);
  const h = g.heightAt(ax, az);
  const inCell = (lm: Landmark | null): Landmark | null => {
    if (!lm) return null;
    if (lm.x0 < rx * LM_CELL + 1 || lm.z0 < rz * LM_CELL + 1 || lm.x1 >= (rx + 1) * LM_CELL - 1 || lm.z1 >= (rz + 1) * LM_CELL - 1) return null;
    if (!lm.underground && g.inVillage((lm.x0 + lm.x1) >> 1, (lm.z0 + lm.z1) >> 1, Math.max(lm.x1 - lm.x0, lm.z1 - lm.z0) / 2 + 6)) return null;
    return lm;
  };
  const surface = (kind: LandmarkKind, w: number, d: number, flat: number): Landmark | null => {
    const ox = ax - (w >> 1), oz = az - (d >> 1);
    const sw = dir & 1 ? d : w, sd = dir & 1 ? w : d; // world footprint
    const [lo, hi] = g.groundRange(ox, oz, sw, sd);
    if (lo <= SEA || hi - lo > flat || hi > 118) return null;
    return inCell({ kind, ox, oz, w, d, dir, y: Math.round((lo + hi) / 2), v, x0: ox - 3, z0: oz - 3, x1: ox + sw + 2, z1: oz + sd + 2, underground: false });
  };
  const deep = (kind: LandmarkKind, w: number, d: number, y: number): Landmark | null => {
    const ox = ax - (w >> 1), oz = az - (d >> 1);
    const sw = dir & 1 ? d : w, sd = dir & 1 ? w : d;
    const [lo] = g.groundRange(ox, oz, sw, sd);
    if (lo < y + 16) return null;
    return inCell({ kind, ox, oz, w, d, dir, y, v, x0: ox, z0: oz, x1: ox + sw - 1, z1: oz + sd - 1, underground: true });
  };

  if (label === 'volcano' || label === 'impact_crater' || label === 'sinkhole') return null;
  if (label === 'ocean' || label === 'deep_ocean') {
    if (h <= SEA - 5 && h >= SEA - 22) {
      const [lo, hi] = g.groundRange(ax - 9, az - 9, 18, 18);
      if (hi < SEA - 2 && hi - lo <= 6) {
        return inCell({ kind: 'sunken_ruins', ox: ax - 9, oz: az - 9, w: 18, d: 18, dir, y: lo, v, x0: ax - 10, z0: az - 10, x1: ax + 10, z1: az + 10, underground: true });
      }
    }
    return null;
  }
  const br = planBridge(g, ax, az, v);
  if (br) return inCell(br);
  // coastlines: a lighthouse on low ground with open sea close by
  if (h >= SEA && h <= SEA + 7) {
    let sea = 0;
    for (let k = 0; k < 8; k++) {
      const a = k / 8 * Math.PI * 2;
      if (g.heightAt(ax + Math.round(Math.cos(a) * 14), az + Math.round(Math.sin(a) * 14)) < SEA - 5) sea++;
    }
    if (sea >= 2 && sea <= 5) {
      const lm = inCell({ kind: 'lighthouse', ox: ax - 6, oz: az - 6, w: 13, d: 13, dir, y: Math.max(h, SEA + 1), v, x0: ax - 8, z0: az - 8, x1: ax + 8, z1: az + 8, underground: false });
      if (lm) return lm;
    }
  }
  let lm: Landmark | null = null;
  switch (label) {
    case 'dark_forest': lm = surface('mansion', 24, 18, 7); break;
    case 'plains': case 'meadow': case 'flower_forest': case 'sunflower':
      lm = v < 0.6 ? surface('windmill', 22, 20, 5) : surface('outpost', 21, 21, 6); break;
    case 'savanna': case 'desert': case 'badlands': case 'snow': case 'snowy_taiga': case 'ice_spikes':
      lm = surface('outpost', 21, 21, 6); break;
    case 'forest': case 'birch_forest': case 'taiga': case 'old_growth_taiga':
      lm = v < 0.5 ? surface('camp', 15, 15, 4) : surface('trail_ruins', 13, 13, 5); break;
    case 'jungle': lm = surface('trail_ruins', 13, 13, 5); break;
  }
  if (lm) return lm;
  // nothing fits up top: the square may hide something underground instead
  const u = hash2(S ^ 5, rx, rz);
  if (u < 0.35) return deep('library', 17, 40, 18 + Math.floor(v * 8));
  if (u < 0.55) return deep('ancient_city', 44, 34, 11 + Math.floor(v * 5));
  return null;
}

/** A crossing over a river near (ax, az), or null. */
function planBridge(g: WorldGenerator, ax: number, az: number, v: number): Landmark | null {
  let rx = 0, rz = 0, found = false;
  for (let r = 0; r <= 18 && !found; r += 3) {
    for (let k = 0; k < 12 && !found; k++) {
      const x = ax + Math.round(Math.cos(k / 12 * Math.PI * 2) * r), z = az + Math.round(Math.sin(k / 12 * Math.PI * 2) * r);
      if (g.riverFactor(x, z) > 0.7 && g.heightAt(x, z) < SEA) { rx = x; rz = z; found = true; }
    }
  }
  if (!found) return null;
  const bank = (dx: number, dz: number): number => {
    for (let s = 1; s <= 20; s++) if (g.heightAt(rx + dx * s, rz + dz * s) >= SEA) return s;
    return -1;
  };
  const xa = bank(-1, 0), xb = bank(1, 0), za = bank(0, -1), zb = bank(0, 1);
  const spanX = xa > 0 && xb > 0 ? xa + xb : 99, spanZ = za > 0 && zb > 0 ? za + zb : 99;
  const alongX = spanX <= spanZ;
  const span = Math.min(spanX, spanZ);
  if (span > 30 || span < 6) return null;
  // endpoints: first dry column on each bank
  const sx = alongX ? rx - xa : rx, sz = alongX ? rz : rz - za;
  const ex = alongX ? rx + xb : rx, ez = alongX ? rz : rz + zb;
  const hy = Math.max(g.heightAt(sx, sz), g.heightAt(ex, ez));
  const y = Math.max(SEA + 3, hy + 1);
  if (y > SEA + 8) return null;
  const x0 = Math.min(sx, ex) - (alongX ? 8 : 4), x1 = Math.max(sx, ex) + (alongX ? 8 : 4);
  const z0 = Math.min(sz, ez) - (alongX ? 4 : 8), z1 = Math.max(sz, ez) + (alongX ? 4 : 8);
  return { kind: 'bridge', ox: sx, oz: sz, w: 5, d: span, dir: 0, y, v, x0, z0, x1, z1, underground: false, alongX, span };
}

// --- drawing ------------------------------------------------------------------

export function drawLandmark(g: WorldGenerator, c: Chunk, lm: Landmark): void {
  const bx = c.cx * CX, bz = c.cz * CZ;
  if (lm.x1 < bx || lm.x0 > bx + CX - 1 || lm.z1 < bz || lm.z0 > bz + CZ - 1) return;
  if (!lm.underground) g.clearTrees(c, lm.x0, lm.z0, lm.x1, lm.z1, lm.y - 2);
  switch (lm.kind) {
    case 'outpost': return outpost(g, c, lm);
    case 'mansion': return mansion(g, c, lm);
    case 'windmill': return windmill(g, c, lm);
    case 'lighthouse': return lighthouse(g, c, lm);
    case 'bridge': return bridge(g, c, lm);
    case 'camp': return camp(g, c, lm);
    case 'trail_ruins': return trailRuins(g, c, lm);
    case 'sunken_ruins': return sunkenRuins(g, c, lm);
    case 'library': return library(g, c, lm);
    case 'ancient_city': return ancientCity(g, c, lm);
  }
}

const frameOf = (g: WorldGenerator, c: Chunk, lm: Landmark): Frame => new Frame(g, c, lm.ox, lm.oz, lm.w, lm.d, lm.dir);

/** Wool A-frame tent lying along v, entrance facing -v, on local ground. */
function tent(f: Frame, u0: number, v0: number, len: number): void {
  for (let v = v0; v < v0 + len; v++) {
    const g = Math.max(f.ground(u0, v), f.ground(u0 - 1, v), f.ground(u0 + 1, v));
    for (let du = -1; du <= 1; du++) { f.pin(u0 + du, v, g, B.DIRT); f.clear(u0 + du, v, g + 1, g + 3); }
    f.set(u0 - 1, g + 1, v, B.WOOL); f.set(u0 + 1, g + 1, v, B.WOOL);
    f.set(u0, g + 2, v, v === v0 || v === v0 + len - 1 ? B.SPRUCE_LOG : B.WOOL); // ridge poles at the ends
    if (v === v0 + len - 1) f.set(u0, g + 1, v, B.WOOL); // closed back
  }
}

// --- outpost ------------------------------------------------------------------

/** Raider outpost: a four-storey timber watchtower on a cobble plinth with an
 *  overhanging lookout deck, plus tents, a log cage and supply hay around it. */
function outpost(g: WorldGenerator, c: Chunk, lm: Landmark): void {
  const f = frameOf(g, c, lm);
  const y = lm.y;
  const T0 = 7, T1 = 13; // tower spans u,v in [T0, T1]
  for (let u = 0; u < lm.w; u++) for (let v = 0; v < lm.d; v++) {
    const gy = f.ground(u, v);
    if (gy > y) f.clear(u, v, y + 1, gy + 1);
    f.clear(u, v, Math.max(gy, y) + 1, y + 20);
    if (u >= T0 - 1 && u <= T1 + 1 && v >= T0 - 1 && v <= T1 + 1) f.pin(u, v, y, B.COBBLE);
  }
  const top = 11;
  for (let u = T0; u <= T1; u++) {
    for (let v = T0; v <= T1; v++) {
      const eu = u === T0 || u === T1, ev = v === T0 || v === T1;
      const corner = eu && ev;
      for (let dy = 1; dy <= top; dy++) {
        let id = B.AIR;
        if (eu || ev) {
          if (corner) id = B.SPRUCE_LOG;
          else if (dy === 1) id = B.COBBLE;
          else if (dy === 5 || dy === 10) id = B.SPRUCE_LOG;
          else id = B.PLANKS;
          if (!corner && (u === 10 || v === 10) && (dy === 3 || dy === 7 || dy === 8)) id = B.GLASS;
        } else if (dy === 5 || dy === 10) id = B.PLANKS;
        f.set(u, y + dy, v, id);
      }
      f.set(u, y, v, B.PLANKS);
    }
  }
  // lookout deck: a 9x9 platform overhanging the walls, log rim + posts + roof
  for (let u = T0 - 1; u <= T1 + 1; u++) {
    for (let v = T0 - 1; v <= T1 + 1; v++) {
      const rim = u === T0 - 1 || u === T1 + 1 || v === T0 - 1 || v === T1 + 1;
      f.set(u, y + top, v, rim ? B.SPRUCE_LOG : B.PLANKS);
      const corner = (u === T0 - 1 || u === T1 + 1) && (v === T0 - 1 || v === T1 + 1);
      if (corner) for (let dy = 1; dy <= 3; dy++) f.set(u, y + top + dy, v, B.SPRUCE_LOG);
      else if (rim) f.set(u, y + top + 1, v, B.OAK_FENCE); // railing
      f.set(u, y + top + 4, v, rim ? B.SPRUCE_LOG : B.PLANKS);
    }
  }
  for (let k = 1; k <= 3; k++) {
    for (let u = T0 - 1 + k; u <= T1 + 1 - k; u++) for (let v = T0 - 1 + k; v <= T1 + 1 - k; v++) f.set(u, y + top + 4 + k, v, B.PLANKS);
  }
  // door, ladder shaft, loot, light
  f.door(10, y + 1, T0, 'f');
  for (let dy = 1; dy <= top; dy++) f.set(T1 - 1, y + dy, T1 - 1, B.LADDER);
  f.set(T0 + 1, y + 1, T1 - 1, B.CHEST_LOOT);
  f.set(T0 + 1, y + 6, T0 + 1, B.TABLE);
  f.set(T0 + 1, y + top + 1, T0 + 1, B.CHEST_LOOT);
  f.torch(10, y + 3, T1 - 1, 'f');
  f.torch(10, y + 8, T1 - 1, 'f');
  f.torch(9, y + 3, T0 - 1, 'f');
  f.torch(11, y + 3, T0 - 1, 'f');
  f.torch(T0, y + top + 2, T1 + 1);
  // camp around the tower
  tent(f, 2, 3, 4);
  tent(f, 18, 2, 4);
  // cage: log bars with gaps, a plank lid
  for (let u = 1; u <= 5; u++) {
    for (let v = 14; v <= 18; v++) {
      const gy = f.ground(u, v);
      const edge = u === 1 || u === 5 || v === 14 || v === 18;
      if (edge && (u + v) % 2 === 0) for (let dy = 1; dy <= 3; dy++) f.set(u, gy + dy, v, B.SPRUCE_LOG);
      f.set(u, gy + 4, v, B.PLANKS);
    }
  }
  for (const [u, v] of [[17, 15], [18, 15], [17, 16]]) f.set(u, f.ground(u, v) + 1, v, B.HAY_BALE);
  f.set(18, f.ground(18, 16) + 1, 16, B.CHEST_LOOT);
  f.set(17, f.ground(17, 15) + 2, 15, B.HAY_BALE);
}

// --- mansion ------------------------------------------------------------------

/** Woodland manor: cobble plinth, dark timber frame over plank (ground) and
 *  white plaster (upper) walls, a stone-slate gable roof, chimney, and rooms:
 *  hall, dining room, library, kitchen, store, bedrooms and a hidden vault. */
function mansion(g: WorldGenerator, c: Chunk, lm: Landmark): void {
  const f = frameOf(g, c, lm);
  const y = lm.y, W = lm.w, D = lm.d;
  const S = g.seed ^ 0x3a45;
  for (let u = -2; u < W + 2; u++) {
    for (let v = -2; v < D + 2; v++) {
      const inside = u >= 0 && u < W && v >= 0 && v < D;
      const gy = f.ground(u, v);
      f.clear(u, v, Math.min(gy, y) + 1, y + 22);
      if (inside) f.pin(u, v, y, B.COBBLE);
      else if (gy < y) f.pin(u, v, y - 1, B.DIRT);
      if (!inside) f.set(u, Math.min(gy, y), v, B.GRASS);
    }
  }
  const post = (u: number): boolean => u === 0 || u === W - 1 || u % 4 === 3;
  const postV = (v: number): boolean => v === 0 || v === D - 1 || v % 4 === 0;
  for (let u = 0; u < W; u++) {
    for (let v = 0; v < D; v++) {
      const eu = u === 0 || u === W - 1, ev = v === 0 || v === D - 1;
      f.set(u, y, v, (u + v) % 7 === 0 ? B.STONE_BRICKS : B.PLANKS);
      f.set(u, y + 5, v, B.PLANKS);
      f.set(u, y + 10, v, B.PLANKS);
      if (!(eu || ev)) continue;
      const frame = (eu && postV(v)) || (ev && post(u));
      for (let dy = 1; dy <= 9; dy++) {
        let id: number;
        if (frame || dy === 5) id = B.SPRUCE_LOG;
        else if (dy === 1) id = B.COBBLE;
        else id = dy < 5 ? B.PLANKS : B.WOOL;
        const winU = ev && !frame && (u % 4 === 1 || u % 4 === 2);
        const winV = eu && !frame && (v % 4 === 2);
        if ((winU || winV) && (dy === 2 || dy === 3 || dy === 7 || dy === 8)) id = B.GLASS;
        f.set(u, y + dy, v, id);
      }
    }
  }
  // stone-slate gable roof along u, with timber gable ends
  const half = Math.ceil(D / 2);
  for (let k = 0; k <= half; k++) {
    const yy = y + 10 + k;
    for (let u = -1; u <= W; u++) {
      for (const v of [k - 1, D - k]) f.set(u, yy, v, B.STONE_BRICKS);
      if (u === 0 || u === W - 1) for (let v = k; v < D - k; v++) f.set(u, yy, v, (v + k) % 3 === 0 ? B.SPRUCE_LOG : B.WOOL);
      else if (u > 0 && u < W - 1) for (let v = k; v < D - k; v++) f.set(u, yy, v, B.AIR);
    }
  }
  for (let u = -1; u <= W; u++) f.set(u, y + 10 + half, half - 1, B.SPRUCE_LOG); // ridge beam
  // chimney
  for (let dy = 1; dy <= 10 + half + 2; dy++) { f.set(W - 5, y + dy, D - 2, B.BRICKS); }
  f.set(W - 5, y + 1, D - 3, B.FURNACE_LIT);
  // interior partitions (ground + upper), with doorways
  const wallU = (u: number, y0: number, gapV: number[]): void => {
    for (let v = 1; v < D - 1; v++) for (let dy = 1; dy <= 4; dy++) {
      if (gapV.includes(v) && dy <= 2) continue;
      f.set(u, y0 + dy, v, B.PLANKS);
    }
  };
  const wallV = (v: number, u0: number, u1: number, y0: number, gapU: number[]): void => {
    for (let u = u0; u <= u1; u++) for (let dy = 1; dy <= 4; dy++) {
      if (gapU.includes(u) && dy <= 2) continue;
      f.set(u, y0 + dy, v, B.PLANKS);
    }
  };
  for (const y0 of [y, y + 5]) {
    wallU(8, y0, [4, 12]);
    wallU(15, y0, [4, 12]);
    wallV(8, 1, 7, y0, [4]);
    wallV(8, 16, W - 2, y0, [19]);
  }
  // front double door + steps
  f.door(11, y + 1, 0, 'f');
  f.door(12, y + 1, 0, 'f', true);
  for (const u of [10, 11, 12, 13]) { f.set(u, y, -1, B.COBBLE); f.clear(u, -1, y + 1, y + 4); }
  f.torch(10, y + 3, -1, 'f');
  f.torch(13, y + 3, -1, 'f');
  // hall: carpet runner, stairs (ladder) up, lamps
  for (let v = 1; v < D - 1; v++) { f.set(11, y, v, B.WOOL); f.set(12, y, v, B.WOOL); }
  for (let dy = 1; dy <= 5; dy++) f.set(9, y + dy, D - 2, B.LADDER);
  f.torch(11, y + 3, D - 2, 'f');
  f.torch(11, y + 8, D - 2, 'f');
  // dining room (front left): long table of crafting tables, chests
  for (let u = 2; u <= 5; u++) f.set(u, y + 1, 4, B.TABLE);
  f.torch(4, y + 3, 7, 'f');
  f.set(1, y + 1, 1, B.CHEST_LOOT);
  // library (back left): shelves round the walls
  for (let u = 1; u <= 7; u++) for (let dy = 1; dy <= 3; dy++) f.set(u, y + dy, D - 2, B.BOOKSHELF);
  for (let v = 9; v < D - 2; v++) for (let dy = 1; dy <= 3; dy++) f.set(1, y + dy, v, B.BOOKSHELF);
  f.set(4, y + 1, 12, B.TABLE);
  f.torch(7, y + 3, 12, 'l');
  // kitchen (front right) + store (back right)
  f.set(W - 2, y + 1, 1, B.FURNACE); f.set(W - 2, y + 1, 2, B.FURNACE); f.set(W - 3, y + 1, 1, B.TABLE);
  f.set(W - 2, y + 1, 5, B.HAY_BALE);
  f.torch(19, y + 3, 7, 'f');
  for (let u = 17; u <= W - 2; u += 2) f.set(u, y + 1, D - 2, B.CHEST_LOOT);
  f.set(W - 2, y + 1, 10, B.HAY_BALE); f.set(W - 2, y + 2, 10, B.HAY_BALE);
  f.torch(16, y + 3, 12, 'r');
  // upper floor: two bedrooms, a study, and a hidden vault behind shelves
  f.bed(3, y + 6, 2, 'f'); f.bed(5, y + 6, 2, 'f');
  f.set(2, y + 6, 6, B.CHEST_LOOT);
  f.torch(4, y + 8, 7, 'f');
  f.bed(18, y + 6, 2, 'f'); f.bed(20, y + 6, 2, 'f');
  f.torch(19, y + 8, 7, 'f');
  for (let u = 1; u <= 7; u++) for (let dy = 1; dy <= 2; dy++) f.set(u, y + 5 + dy, D - 2, B.BOOKSHELF);
  f.set(4, y + 6, 11, B.TABLE);
  f.torch(7, y + 8, 12, 'l');
  // vault: a sealed room (bookshelf "door") with treasure
  for (let u = 16; u <= W - 2; u++) for (let v = 9; v < D - 1; v++) for (let dy = 1; dy <= 4; dy++) {
    const edge = u === 16 || v === 9;
    f.set(u, y + 5 + dy, v, edge ? (u === 19 && v === 9 && dy <= 2 ? B.BOOKSHELF : B.PLANKS) : B.AIR);
  }
  f.set(20, y + 6, 13, B.CHEST_LOOT);
  f.set(21, y + 6, 13, hash2(S, lm.ox, lm.oz) < 0.5 ? B.DIAMOND_BLOCK : B.GOLD_BLOCK);
  f.set(18, y + 6, 14, B.CHEST_LOOT);
  f.torch(19, y + 8, 15, 'f');
  // attic store
  f.set(12, y + 11, half - 1, B.CHEST_LOOT);
  // garden: hedges, a path and lamp posts out front
  for (let v = -6; v <= -2; v++) {
    for (const u of [11, 12]) { const gy = f.ground(u, v); if (Math.abs(gy - y) <= 3) f.set(u, gy, v, B.GRAVEL); }
    for (const u of [9, 14]) {
      const gy = f.ground(u, v);
      if (Math.abs(gy - y) <= 3 && hash3(S, u, v, 1) < 0.8) f.set(u, gy + 1, v, B.LEAVES);
    }
  }
  for (const u of [8, 15]) {
    const gy = f.ground(u, -5);
    if (Math.abs(gy - y) <= 3) { f.set(u, gy + 1, -5, B.COBBLE); f.set(u, gy + 2, -5, B.OAK_FENCE); f.set(u, gy + 3, -5, B.LANTERN); }
  }
}

// --- windmill farm -----------------------------------------------------------

/** Windmill farmstead: a cobble-and-plank windmill with pinwheel wool sails,
 *  an irrigated crop field, hay stacks and a small farmhouse. */
function windmill(g: WorldGenerator, c: Chunk, lm: Landmark): void {
  const f = frameOf(g, c, lm);
  const y = lm.y;
  const S = g.seed ^ 0x3e11;
  for (let u = 0; u < lm.w; u++) for (let v = 0; v < lm.d; v++) {
    const gy = f.ground(u, v);
    f.clear(u, v, Math.min(gy, y) + 1, y + 20);
    f.pin(u, v, y - 1, B.DIRT);
    f.set(u, y, v, B.GRASS);
  }
  // tower centred at (3, 5): octagonal cobble base, plank upper, pyramid cap
  const cx = 3, cv = 5;
  for (let du = -3; du <= 3; du++) {
    for (let dv = -3; dv <= 3; dv++) {
      const u = cx + du, v = cv + dv;
      const oct = Math.abs(du) + Math.abs(dv) <= 4;
      if (!oct) continue;
      f.set(u, y, v, B.COBBLE);
      for (let dy = 1; dy <= 13; dy++) {
        const r = dy <= 6 ? 3 : 2;
        const inRing = Math.max(Math.abs(du), Math.abs(dv)) <= r && Math.abs(du) + Math.abs(dv) <= r + 1;
        const edge = inRing && (Math.max(Math.abs(du), Math.abs(dv)) === r || Math.abs(du) + Math.abs(dv) === r + 1);
        let id = B.AIR;
        if (edge) id = dy <= 6 ? B.COBBLE : dy === 7 || dy === 13 ? B.SPRUCE_LOG : B.PLANKS;
        if (edge && (dy === 4 || dy === 10) && (du === 0 || dv === 0)) id = B.GLASS;
        f.set(u, y + dy, v, id);
      }
    }
  }
  for (let k = 0; k <= 2; k++) {
    for (let du = -2 + k; du <= 2 - k; du++) for (let dv = -2 + k; dv <= 2 - k; dv++) f.set(cx + du, y + 14 + k, cv + dv, B.SPRUCE_LOG);
  }
  f.set(cx, y + 7, cv, B.PLANKS);
  for (let dy = 1; dy <= 7; dy++) f.set(cx + 1, y + dy, cv + 1, B.LADDER);
  f.door(cx, y + 1, cv - 3, 'f');
  f.torch(cx, y + 3, cv + 2, 'f');
  f.set(cx - 1, y + 8, cv + 1, B.CHEST_LOOT);
  f.set(cx - 2, y + 1, cv, B.HAY_BALE); f.set(cx - 2, y + 1, cv + 1, B.HAY_BALE);
  // hub + four sail arms in a pinwheel, standing proud of the front face
  const hy = y + 11, sv = cv - 4;
  f.set(cx, hy, cv - 3, B.SPRUCE_LOG);
  f.set(cx, hy, sv, B.SPRUCE_LOG);
  for (let k = 1; k <= 6; k++) {
    f.set(cx + k, hy, sv, B.SPRUCE_LOG); if (k >= 2) f.set(cx + k, hy + 1, sv, B.WOOL);
    f.set(cx - k, hy, sv, B.SPRUCE_LOG); if (k >= 2) f.set(cx - k, hy - 1, sv, B.WOOL);
    f.set(cx, hy + k, sv, B.SPRUCE_LOG); if (k >= 2) f.set(cx - 1, hy + k, sv, B.WOOL);
    if (hy - k > y + 1) { f.set(cx, hy - k, sv, B.SPRUCE_LOG); if (k >= 2) f.set(cx + 1, hy - k, sv, B.WOOL); }
  }
  // field: log-edged plots, an irrigation channel, mixed crops
  const crops = [B.WHEAT_2, B.WHEAT_2, B.CARROT_2, B.POTATO_2, B.BEETROOT_2, B.WHEAT_1];
  for (let u = 9; u <= 20; u++) {
    for (let v = 0; v <= 8; v++) {
      const edge = u === 9 || u === 20 || v === 0 || v === 8;
      if (edge) { f.set(u, y, v, B.LOG); continue; }
      if (v === 4) { f.set(u, y, v, B.WATER); continue; }
      f.set(u, y, v, B.FARMLAND);
      const r = hash3(S, lm.ox + u, y, lm.oz + v);
      f.set(u, y + 1, v, crops[Math.floor(((u - 10) / 2) % crops.length)] ?? (r < 0.5 ? B.WHEAT_2 : B.WHEAT_1));
    }
  }
  // hay stacks + a scarecrow-ish post
  for (const [u, v, h] of [[7, 11, 2], [8, 11, 1], [7, 12, 1]] as const) for (let k = 1; k <= h; k++) f.set(u, y + k, v, B.HAY_BALE);
  f.set(15, y + 1, 9, B.SPRUCE_LOG); f.set(15, y + 2, 9, B.HAY_BALE); f.torch(15, y + 3, 9);
  // farmhouse (u 12..18, v 12..18) with its door toward the field
  const U0 = 12, U1 = 18, V0 = 12, V1 = 18;
  for (let u = U0; u <= U1; u++) {
    for (let v = V0; v <= V1; v++) {
      f.set(u, y, v, B.PLANKS);
      const eu = u === U0 || u === U1, ev = v === V0 || v === V1;
      if (!(eu || ev)) continue;
      for (let dy = 1; dy <= 3; dy++) {
        let id = eu && ev ? B.LOG : dy === 1 ? B.BRICKS : B.PLANKS;
        if (!(eu && ev) && dy === 2 && (u === 15 || v === 15)) id = B.GLASS;
        f.set(u, y + dy, v, id);
      }
    }
  }
  for (let k = 0; k <= 4; k++) {
    for (let u = U0 - 1; u <= U1 + 1; u++) {
      f.set(u, y + 4 + k, V0 - 1 + k, B.PLANKS);
      f.set(u, y + 4 + k, V1 + 1 - k, B.PLANKS);
      if (u === U0 || u === U1) for (let v = V0 + k; v <= V1 - k; v++) f.set(u, y + 4 + k, v, B.PLANKS);
    }
  }
  for (let u = U0 - 1; u <= U1 + 1; u++) f.set(u, y + 8, 15, B.LOG);
  f.door(15, y + 1, V0, 'f');
  f.torch(14, y + 2, V0 - 1, 'f');
  f.bed(13, y + 1, 16, 'b');
  f.set(17, y + 1, 17, B.CHEST_LOOT);
  f.set(17, y + 1, 13, B.FURNACE);
  f.set(16, y + 1, 13, B.TABLE);
  f.torch(15, y + 3, V1 - 1, 'f');
  // gravel path from the mill to the house
  for (let u = 4; u <= 15; u++) f.set(u, y, 10, B.GRAVEL);
  for (let v = 10; v <= 11; v++) f.set(15, y, v, B.GRAVEL);
}

// --- lighthouse ---------------------------------------------------------------

/** Coastal lighthouse: a striped round tower on a rock plinth, ladder inside,
 *  a railed gallery and a glass lantern room with a glowstone beacon. */
function lighthouse(g: WorldGenerator, c: Chunk, lm: Landmark): void {
  const f = frameOf(g, c, lm);
  const y = lm.y;
  const cx = 6, cv = 6, H = 20;
  for (let du = -5; du <= 5; du++) {
    for (let dv = -5; dv <= 5; dv++) {
      const d = Math.hypot(du, dv);
      if (d > 5.4) continue;
      const u = cx + du, v = cv + dv;
      const gy = f.ground(u, v);
      f.pin(u, v, y, d > 4.2 ? B.COBBLE : B.STONE_BRICKS);
      for (let yy = Math.min(gy, y) + 1; yy <= Math.max(y, 64); yy++) if (yy <= y) f.set(u, yy, v, B.COBBLE);
      f.clear(u, v, y + 1, y + H + 8);
    }
  }
  for (let dy = 1; dy <= H; dy++) {
    const r = dy <= 10 ? 3 : 2.6;
    for (let du = -4; du <= 4; du++) {
      for (let dv = -4; dv <= 4; dv++) {
        const d = Math.hypot(du, dv);
        if (d > r + 0.35) continue;
        const wall = d > r - 0.75;
        let id = wall ? (((dy - 1) >> 2) & 1 ? B.RED_WOOL : B.WOOL) : B.AIR;
        if (wall && dy % 6 === 3 && du === 0) id = B.GLASS;
        f.set(cx + du, y + dy, cv + dv, id);
      }
    }
  }
  for (let dy = 1; dy <= H; dy++) f.set(cx, y + dy, cv + 1, B.LADDER);
  f.door(cx, y + 1, cv - 3, 'f');
  f.set(cx - 1, y + 1, cv, B.CHEST_LOOT);
  f.set(cx + 1, y + 1, cv, B.FURNACE);
  f.torch(cx, y + 3, cv - 4, 'f');
  f.torch(cx - 1, y + 8, cv + 1, 'f');
  f.torch(cx - 1, y + 15, cv + 1, 'f');
  // gallery deck + railing
  for (let du = -4; du <= 4; du++) {
    for (let dv = -4; dv <= 4; dv++) {
      const d = Math.hypot(du, dv);
      if (d > 4.3) continue;
      f.set(cx + du, y + H + 1, cv + dv, du === 0 && dv === 1 ? B.LADDER : B.STONE_BRICKS);
      if (d > 3.4 && (du + dv) % 2 === 0) f.set(cx + du, y + H + 2, cv + dv, B.COBBLE);
    }
  }
  // lantern room
  for (let du = -1; du <= 1; du++) {
    for (let dv = -1; dv <= 1; dv++) {
      const ring = du !== 0 || dv !== 0;
      for (let dy = 2; dy <= 4; dy++) f.set(cx + du, y + H + dy, cv + dv, ring ? (Math.abs(du) + Math.abs(dv) === 2 ? B.STONE_BRICKS : B.GLASS) : B.GLOWSTONE);
      f.set(cx + du, y + H + 5, cv + dv, B.STONE_BRICKS);
    }
  }
  f.set(cx, y + H + 3, cv + 1, B.GLOWSTONE);
  f.set(cx, y + H + 6, cv, B.STONE_BRICKS);
  f.set(cx, y + H + 7, cv, B.GLOWSTONE);
}

// --- bridge -------------------------------------------------------------------

/** Fortified stone bridge across a river: arched piers, a paved deck between
 *  crenellated parapets with lamps, and a gatehouse at one end. */
function bridge(g: WorldGenerator, c: Chunk, lm: Landmark): void {
  const alongX = !!lm.alongX, span = lm.span ?? 10, y = lm.y;
  const S = g.seed ^ 0xb21d;
  const at = (s: number, t: number, yy: number, id: number): void =>
    g.put(c, alongX ? lm.ox + s : lm.ox + t, yy, alongX ? lm.oz + t : lm.oz + s, id);
  const gnd = (s: number, t: number): number => g.heightAt(alongX ? lm.ox + s : lm.ox + t, alongX ? lm.oz + t : lm.oz + s);
  const s0 = -3, s1 = span + 3;
  for (let s = s0 - 4; s <= s1 + 4; s++) {
    for (let t = -2; t <= 2; t++) {
      const gy = gnd(s, t);
      const onDeck = s >= s0 && s <= s1;
      // approach ramps step down to the banks beyond the deck ends
      const ramp = s < s0 ? y - (s0 - s) : s > s1 ? y - (s - s1) : y;
      if (!onDeck && ramp <= gy) continue;
      const bed = Math.min(gy, SEA - 1);
      const pier = onDeck && s > 0 && s < span && (s % 5 === 0);
      // piers reach the riverbed; the deck otherwise rides on an arch course
      const low = pier || !onDeck ? bed + 1 : y - (s % 5 === 1 || s % 5 === 4 ? 2 : 1);
      for (let yy = Math.max(low, 1); yy < ramp; yy++) {
        if (yy <= bed) continue;
        at(s, t, yy, hash3(S, s, yy, t) < 0.2 ? B.COBBLE : B.STONE_BRICKS);
      }
      at(s, t, ramp, Math.abs(t) === 2 ? B.STONE_BRICKS : (s + t) % 3 === 0 ? B.SMOOTH_STONE : B.STONE_BRICKS);
      for (let yy = ramp + 1; yy <= ramp + 4; yy++) at(s, t, yy, B.AIR);
      if (Math.abs(t) === 2 && onDeck) {
        at(s, t, ramp + 1, B.COBBLE);
        if (s % 2 === 0) at(s, t, ramp + 2, B.COBBLE);
        if (s % 6 === 3) { at(s, t, ramp + 2, B.COBBLE); g.putTorch(c, alongX ? lm.ox + s : lm.ox + t, ramp + 3, alongX ? lm.oz + t : lm.oz + s); }
      }
    }
  }
  // gatehouse over the first bank end
  for (let s = s0 - 1; s <= s0 + 1; s++) {
    for (let t = -3; t <= 3; t++) {
      const edgeT = Math.abs(t) >= 2;
      const gy = gnd(s, t);
      if (Math.abs(t) === 3) for (let yy = Math.min(gy, SEA - 1) + 1; yy < y; yy++) at(s, t, yy, B.STONE_BRICKS);
      for (let dy = 0; dy <= 6; dy++) {
        const open = !edgeT && dy >= 1 && dy <= 3;
        if (open) continue;
        if (dy === 0 && !edgeT) continue;
        at(s, t, y + dy, dy === 6 ? ((s + t) % 2 === 0 ? B.STONE_BRICKS : B.AIR) : B.STONE_BRICKS);
      }
    }
  }
  const gx = (s: number, t: number): number => (alongX ? lm.ox + s : lm.ox + t);
  const gz = (s: number, t: number): number => (alongX ? lm.oz + t : lm.oz + s);
  at(s0, 2, y + 1, B.AIR); at(s0, 2, y + 2, B.AIR); // a guard alcove
  at(s0, 2, y + 1, B.CHEST_LOOT);
  const tdir = alongX ? 2 : 3; // lean toward the deck centre line
  g.putTorch(c, gx(s0 - 2, -1), y + 3, gz(s0 - 2, -1));
  g.putTorch(c, gx(s0 + 2, 1), y + 3, gz(s0 + 2, 1), tdir);
}

// --- camp ---------------------------------------------------------------------

/** Abandoned camp: a fire pit ringed by log seats, two tents, a work table,
 *  a supply chest and hay. */
function camp(g: WorldGenerator, c: Chunk, lm: Landmark): void {
  const f = frameOf(g, c, lm);
  const cx = 7, cv = 7;
  for (let u = 0; u < lm.w; u++) for (let v = 0; v < lm.d; v++) {
    const gy = f.ground(u, v);
    f.clear(u, v, gy + 1, gy + 3);
  }
  const gy = f.ground(cx, cv);
  for (let du = -1; du <= 1; du++) for (let dv = -1; dv <= 1; dv++) f.set(cx + du, f.ground(cx + du, cv + dv), cv + dv, B.COBBLE);
  f.set(cx, gy + 1, cv, B.CAMPFIRE);
  for (const [du, dv] of [[-3, 0], [3, 0], [0, 3]]) {
    const gyy = f.ground(cx + du, cv + dv);
    f.set(cx + du, gyy + 1, cv + dv, B.SPRUCE_LOG);
  }
  tent(f, 3, 1, 4);
  tent(f, 11, 1, 4);
  const tu = 12, tv = 10;
  f.set(tu, f.ground(tu, tv) + 1, tv, B.TABLE);
  f.set(tu + 1, f.ground(tu + 1, tv) + 1, tv, B.CHEST_LOOT);
  f.set(2, f.ground(2, 11) + 1, 11, B.HAY_BALE);
  f.set(3, f.ground(3, 11) + 1, 11, B.HAY_BALE);
  f.set(2, f.ground(2, 11) + 2, 11, B.HAY_BALE);
  f.set(6, f.ground(6, 12) + 1, 12, B.SPRUCE_LOG);
  f.torch(6, f.ground(6, 12) + 2, 12);
}

// --- trail ruins ----------------------------------------------------------------

/** Trail ruins: an old settlement mostly swallowed by the ground — wall tops
 *  and a broken tower poke out of the turf, rooms below are packed with
 *  gravel, and loot waits at the bottom. */
function trailRuins(g: WorldGenerator, c: Chunk, lm: Landmark): void {
  const f = frameOf(g, c, lm);
  const S = g.seed ^ 0x7a11;
  const y = lm.y, floor = y - 6;
  const W = lm.w, D = lm.d;
  const wall = (u: number, v: number): boolean =>
    u === 0 || u === W - 1 || v === 0 || v === D - 1 || u === 6 || (v === 6 && u < 6) || (v === 8 && u > 6);
  for (let u = 0; u < W; u++) {
    for (let v = 0; v < D; v++) {
      const gy = f.ground(u, v);
      const r = hash3(S, lm.ox + u, 0, lm.oz + v);
      if (wall(u, v)) {
        const top = gy + (r < 0.3 ? 1 : r < 0.45 ? 2 : r < 0.75 ? 0 : -1);
        for (let yy = floor; yy <= top; yy++) {
          const r2 = hash3(S ^ 1, lm.ox + u, yy, lm.oz + v);
          f.set(u, yy, v, r2 < 0.2 ? B.MOSSY_COBBLE : r2 < 0.35 ? B.COBBLE : r2 < 0.55 ? B.MOSSY_STONE_BRICKS
            : r2 < 0.7 ? B.CRACKED_STONE_BRICKS : B.STONE_BRICKS);
        }
        f.clear(u, v, top + 1, gy + 3);
      } else {
        f.set(u, floor, v, (u + v) % 2 ? B.STONE_BRICKS : B.SMOOTH_STONE);
        for (let yy = floor + 1; yy < gy; yy++) f.set(u, yy, v, hash3(S ^ 2, lm.ox + u, yy, lm.oz + v) < 0.85 ? B.GRAVEL : B.DIRT);
        f.set(u, gy, v, r < 0.4 ? B.GRAVEL : B.GRASS);
      }
    }
  }
  // collapsed tower
  const tg = f.ground(2, 2);
  for (let du = 0; du < 3; du++) for (let dv = 0; dv < 3; dv++) {
    const top = tg + 2 + Math.floor(hash3(S ^ 3, du, dv, lm.ox) * 4);
    for (let yy = floor; yy <= top; yy++) f.set(1 + du, yy, 1 + dv, du === 1 && dv === 1 && yy > tg ? B.AIR : B.STONE_BRICKS);
  }
  f.set(3, floor + 1, 3, B.CHEST_LOOT);
  f.set(W - 3, floor + 1, D - 3, B.CHEST_LOOT);
  f.set(9, floor + 1, 3, B.CHEST_LOOT);
  f.set(9, floor + 2, 3, B.GRAVEL);
}

// --- sunken ruins ---------------------------------------------------------------

/** Sunken ruins: broken sandstone-and-brick rooms and a toppled column on the
 *  sea floor, flooded, with a chest in the largest room. */
function sunkenRuins(g: WorldGenerator, c: Chunk, lm: Landmark): void {
  const f = frameOf(g, c, lm);
  const S = g.seed ^ 0x5c7e;
  const fillAt = (yy: number): number => (yy <= SEA ? B.WATER : B.AIR);
  const room = (u0: number, v0: number, w: number, d: number, hmax: number): void => {
    for (let u = u0; u < u0 + w; u++) {
      for (let v = v0; v < v0 + d; v++) {
        const gy = f.ground(u, v);
        const edge = u === u0 || u === u0 + w - 1 || v === v0 || v === v0 + d - 1;
        f.set(u, gy, v, (u + v) % 2 ? B.STONE_BRICKS : B.SANDSTONE);
        if (!edge) continue;
        const hgt = 1 + Math.floor(hash3(S, lm.ox + u, 0, lm.oz + v) * hmax);
        for (let dy = 1; dy <= hgt; dy++) {
          const r = hash3(S ^ 1, lm.ox + u, dy, lm.oz + v);
          f.set(u, gy + dy, v, r < 0.18 ? fillAt(gy + dy) : r < 0.4 ? B.MOSSY_STONE_BRICKS : r < 0.55 ? B.CRACKED_STONE_BRICKS
            : r < 0.8 ? B.SANDSTONE : B.MOSSY_COBBLE);
        }
      }
    }
  };
  room(2, 2, 8, 7, 4);
  room(11, 4, 5, 6, 3);
  room(4, 11, 6, 5, 3);
  // toppled column + gravel drifts
  for (let k = 0; k < 5; k++) { const gy = f.ground(12 + k, 13); f.set(12 + k, gy + 1, 13, k === 0 ? B.STONE_BRICKS : B.SANDSTONE); }
  for (let k = 0; k < 3; k++) { const gy = f.ground(13, 1); f.set(13, gy + 1 + k, 1, B.QUARTZ_BLOCK); }
  for (let u = 0; u < lm.w; u++) for (let v = 0; v < lm.d; v++) {
    if (hash2(S ^ 2, lm.ox + u, lm.oz + v) < 0.08) f.set(u, f.ground(u, v), v, B.GRAVEL);
  }
  f.set(5, f.ground(5, 5) + 1, 5, B.CHEST_LOOT);
  f.set(13, f.ground(13, 7) + 1, 7, B.CHEST_LOOT);
}

// --- underground library --------------------------------------------------------

/** Stronghold-lite: a ruined well on the surface drops a ladder shaft into a
 *  stone-brick corridor that runs to a two-storey library (shelves, gallery,
 *  reading tables) and on to an obsidian-framed shrine over a lava pool. */
function library(g: WorldGenerator, c: Chunk, lm: Landmark): void {
  const f = frameOf(g, c, lm);
  const S = g.seed ^ 0x11b7;
  const y = lm.y;
  const brick = (u: number, yy: number, v: number): number => {
    const r = hash3(S, lm.ox + u, yy, lm.oz + v);
    return r < 0.1 ? B.MOSSY_STONE_BRICKS : r < 0.2 ? B.CRACKED_STONE_BRICKS : r < 0.24 ? B.MOSSY_COBBLE : B.STONE_BRICKS;
  };
  const hollow = (u0: number, v0: number, u1: number, v1: number, y0: number, y1: number): void => {
    for (let u = u0; u <= u1; u++) for (let v = v0; v <= v1; v++) for (let yy = y0; yy <= y1; yy++) {
      const shell = u === u0 || u === u1 || v === v0 || v === v1 || yy === y0 || yy === y1;
      f.set(u, yy, v, shell ? brick(u, yy, v) : B.AIR);
    }
  };
  // library hall: u 0..16, v 12..28, floor y, ceiling y+10
  hollow(0, 12, 16, 28, y, y + 10);
  for (let u = 1; u <= 15; u++) for (let v = 13; v <= 27; v++) {
    const ring = u <= 3 || u >= 13 || v <= 15 || v >= 25;
    if (ring) f.set(u, y + 5, v, B.PLANKS); // gallery
    if (u === 1 || u === 15 || v === 13 || v === 27) {
      for (let dy = 1; dy <= 4; dy++) f.set(u, y + dy, v, B.BOOKSHELF);
      for (let dy = 6; dy <= 8; dy++) f.set(u, y + dy, v, B.BOOKSHELF);
    }
    if (ring && (u === 4 || u === 12 || v === 16 || v === 24) && !(u > 4 && u < 12 && v > 16 && v < 24)) {
      if ((u + v) % 2 === 0) f.set(u, y + 6, v, B.SPRUCE_LOG); // gallery rail posts
    }
  }
  // free-standing shelf stacks + reading tables in the middle
  for (const v of [18, 22]) for (let u = 6; u <= 10; u++) for (let dy = 1; dy <= 3; dy++) f.set(u, y + dy, v, B.BOOKSHELF);
  f.set(8, y + 1, 20, B.TABLE);
  f.set(9, y + 1, 20, B.LANTERN);
  f.set(7, y + 1, 20, B.CHEST_LOOT);
  f.set(2, y + 6, 26, B.CHEST_LOOT);
  for (let dy = 1; dy <= 5; dy++) f.set(3, y + dy, 14, B.LADDER);
  f.set(3, y + 5, 14, B.LADDER);
  // chandelier + wall lamps
  for (let dy = 7; dy <= 9; dy++) f.set(8, y + dy, 20, dy === 7 ? B.GLOWSTONE : B.SPRUCE_LOG);
  for (const [u, v, l] of [[2, 20, 'r'], [14, 20, 'l'], [8, 14, 'b'], [8, 26, 'f']] as const) f.torch(u, y + 3, v, l);
  for (const [u, v, l] of [[2, 18, 'r'], [14, 22, 'l']] as const) f.torch(u, y + 7, v, l);
  // entrance corridor from the shaft (v 0..12) through the front wall
  hollow(6, 0, 10, 12, y, y + 4);
  for (let dy = 1; dy <= 2; dy++) f.set(8, y + dy, 12, B.AIR);
  f.torch(7, y + 2, 6, 'r');
  f.torch(9, y + 2, 6, 'l');
  // shaft up to the surface at (8, 2), crowned by a ruined well
  const sg = f.ground(8, 2);
  for (let yy = y + 1; yy <= sg + 1; yy++) {
    for (let du = -1; du <= 1; du++) for (let dv = -1; dv <= 1; dv++) {
      if (yy > y + 4) f.set(8 + du, yy, 2 + dv, du === 0 && dv === 0 ? B.AIR : brick(8 + du, yy, 2 + dv));
    }
    f.set(8, yy, 2, B.LADDER);
  }
  for (let du = -1; du <= 1; du++) for (let dv = -1; dv <= 1; dv++) {
    if (du === 0 && dv === 0) continue;
    const gy = f.ground(8 + du, 2 + dv);
    f.set(8 + du, gy + 1, 2 + dv, brick(8 + du, gy + 1, 2 + dv));
    if ((du + dv) % 2 !== 0 && hash3(S ^ 4, du, dv, lm.ox) < 0.6) f.set(8 + du, gy + 2, 2 + dv, B.COBBLE);
  }
  f.set(8, sg + 2, 2, B.AIR);
  // shrine room beyond the library: u 3..13, v 29..39
  hollow(3, 29, 13, 39, y, y + 7);
  for (let dy = 1; dy <= 2; dy++) f.set(8, y + dy, 28, B.AIR);
  for (let u = 5; u <= 11; u++) for (let v = 31; v <= 37; v++) f.set(u, y, v, B.LAVA);
  for (let u = 6; u <= 10; u++) for (let v = 32; v <= 36; v++) f.set(u, y + 1, v, B.STONE_BRICKS);
  for (let u = 6; u <= 10; u++) for (let v = 32; v <= 36; v++) {
    const ring = (u === 6 || u === 10 || v === 32 || v === 36) && !((u === 6 || u === 10) && (v === 32 || v === 36));
    if (ring) f.set(u, y + 2, v, B.OBSIDIAN);
  }
  f.set(8, y + 2, 34, B.CHEST_LOOT);
  for (let v = 29; v <= 31; v++) f.set(8, y + 1, v, B.STONE_BRICKS); // walkway over the lava
  f.torch(4, y + 3, 34, 'r');
  f.torch(12, y + 3, 34, 'l');
}

// --- ancient city ----------------------------------------------------------------

/** Ancient city: a vast dark vault deep underground — tiled floor, colonnades
 *  topped with soul-fire braziers, ruined side houses holding loot, and a
 *  towering obsidian-lined gate at the far end. */
function ancientCity(g: WorldGenerator, c: Chunk, lm: Landmark): void {
  const f = frameOf(g, c, lm);
  const S = g.seed ^ 0xac17;
  const y = lm.y, W = lm.w, D = lm.d;
  const tile = (u: number, v: number): number => {
    const r = hash3(S, lm.ox + u, 0, lm.oz + v);
    return (u + v) % 4 === 0 ? B.SMOOTH_STONE : r < 0.55 ? B.COAL_BLOCK : r < 0.7 ? B.COBBLE : r < 0.85 ? B.CRACKED_STONE_BRICKS : B.STONE_BRICKS;
  };
  // carve the vault: an elliptical dome, 3..17 high
  for (let u = 0; u < W; u++) {
    for (let v = 0; v < D; v++) {
      const nu = (u - W / 2 + 0.5) / (W / 2), nv = (v - D / 2 + 0.5) / (D / 2);
      const e = nu * nu + nv * nv;
      if (e > 1) continue;
      const ceil = Math.floor(4 + (1 - e) * 13);
      f.set(u, y, v, tile(u, v));
      for (let dy = 1; dy <= ceil; dy++) f.set(u, y + dy, v, B.AIR);
      f.set(u, y + ceil + 1, v, e > 0.8 ? B.COBBLE : B.STONE);
    }
  }
  // central avenue + colonnades with braziers
  for (let v = 4; v < D - 8; v++) for (const u of [W / 2 - 1, W / 2]) f.set(u, y, v, B.STONE_BRICKS);
  for (let v = 6; v < D - 9; v += 5) {
    for (const u of [W / 2 - 5, W / 2 + 4]) {
      for (let dy = 1; dy <= 5; dy++) f.set(u, y + dy, v, dy === 5 ? B.STONE_BRICKS : B.COAL_BLOCK);
      f.set(u, y + 6, v, B.SOUL_SAND);
      f.set(u, y + 7, v, B.FIRE);
    }
  }
  // ruined side houses (two each side) with loot
  const house = (u0: number, v0: number, open: 'l' | 'r'): void => {
    for (let u = u0; u < u0 + 6; u++) for (let v = v0; v < v0 + 6; v++) {
      const edge = u === u0 || u === u0 + 5 || v === v0 || v === v0 + 5;
      f.set(u, y, v, B.SMOOTH_STONE);
      if (!edge) continue;
      const hgt = 2 + Math.floor(hash3(S ^ 1, lm.ox + u, 0, lm.oz + v) * 4);
      const door = (open === 'r' ? u === u0 + 5 : u === u0) && (v === v0 + 2 || v === v0 + 3);
      for (let dy = 1; dy <= hgt; dy++) if (!(door && dy <= 2)) f.set(u, y + dy, v, hash3(S ^ 2, u, dy, v) < 0.3 ? B.COBBLE : B.STONE_BRICKS);
    }
    f.set(u0 + 2, y + 1, v0 + 2, B.CHEST_LOOT);
    f.set(u0 + 3, y + 1, v0 + 3, B.SOUL_SAND);
    f.set(u0 + 3, y + 2, v0 + 3, B.FIRE);
  };
  house(6, 9, 'r');
  house(6, 17, 'r');
  house(W - 12, 9, 'l');
  house(W - 12, 17, 'l');
  // the gate: a massive frame of dark block lined with obsidian
  const gv = D - 6, gu0 = W / 2 - 7, gu1 = W / 2 + 6;
  for (let u = gu0; u <= gu1; u++) {
    for (let dy = 0; dy <= 12; dy++) {
      const side = u <= gu0 + 1 || u >= gu1 - 1;
      const topb = dy >= 11;
      if (!(side || topb)) { if (dy === 0) f.set(u, y, gv, B.SOUL_SAND); continue; }
      const inner = (u === gu0 + 1 || u === gu1 - 1 || dy === 11) && !(u <= gu0 || u >= gu1) ;
      for (const v of [gv, gv + 1]) f.set(u, y + dy, v, inner ? B.OBSIDIAN : dy % 4 === 0 ? B.STONE_BRICKS : B.COAL_BLOCK);
    }
  }
  for (let u = gu0 + 2; u <= gu1 - 2; u += 3) { f.set(u, y, gv - 1, B.SOUL_SAND); f.set(u, y + 1, gv - 1, B.FIRE); }
  f.set(W / 2 - 1, y + 1, gv - 2, B.CHEST_LOOT);
  f.set(W / 2, y + 1, gv - 2, B.CHEST_LOOT);
}
