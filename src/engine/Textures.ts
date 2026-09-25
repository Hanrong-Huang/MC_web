// Procedural 16x16 texture atlas (Minecraft-style palette, original pixel art),
// item sprites, isometric block icons, and a resource-pack loader that reads the
// standard assets/minecraft/textures/{block,item}/*.png layout.

import * as THREE from 'three';
import { mulberry32 } from './Noise';
import { def, TINTED_TILES } from './Blocks';
import { B, hasDef, SHAPED, shapeBoxes, SLAB_KINDS, WOOL_COLORS, POTIONS } from './Blocks';

const TILE = 16;
const COLS = 8;
const ROWS = 32;

type Ctx = CanvasRenderingContext2D;

function makeCanvas(w: number, h: number): [HTMLCanvasElement, Ctx] {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  return [c, ctx];
}

function hex(c: string): [number, number, number] {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Fill a 16x16 region with per-pixel picks from a palette using value-ish noise. */
function noiseFill(ctx: Ctx, x0: number, y0: number, palette: string[], seed: number, blockiness = 0): void {
  const rand = mulberry32(seed);
  const img = ctx.createImageData(TILE, TILE);
  const cells: number[] = [];
  if (blockiness > 0) {
    for (let i = 0; i < 64; i++) cells.push(rand() * palette.length);
  }
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      let pick: number;
      if (blockiness > 0) {
        const base = cells[((y >> 1) & 7) * 8 + ((x >> 1) & 7)];
        pick = Math.min(palette.length - 1, Math.floor(base + (rand() - 0.5) * 1.2));
        pick = Math.max(0, pick);
      } else {
        pick = (rand() * palette.length) | 0;
      }
      const [r, g, b] = hex(palette[pick]);
      const o = (y * TILE + x) * 4;
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, x0, y0);
}

/** Draw a pixel map; keys in palette map chars to colors, '.' = transparent. */
function pixmap(ctx: Ctx, x0: number, y0: number, rows: string[], palette: Record<string, string>): void {
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      const ch = rows[y][x];
      if (ch === '.' || ch === ' ') continue;
      const col = palette[ch];
      if (!col) continue;
      ctx.fillStyle = col;
      ctx.fillRect(x0 + x, y0 + y, 1, 1);
    }
  }
}

/**
 * Extrude a pixel sprite (any NxM canvas) into a thin voxel slab with per-pixel
 * vertex colors. Interior side faces are culled, so only the silhouette gets
 * edges — the chunky Minecraft held-item / dropped-item look. Colors are
 * linearized so MeshLambertMaterial output matches the source sprite.
 */
export function extrudeSpriteGeometry(sprite: HTMLCanvasElement, sizeAcross = 0.5): THREE.BufferGeometry {
  const W = sprite.width, H = sprite.height;
  const data = sprite.getContext('2d')!.getImageData(0, 0, W, H).data;
  const solid = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < W && y < H && data[(y * W + x) * 4 + 3] > 40;

  const pos: number[] = [], norm: number[] = [], col: number[] = [];
  const depth = 1.4;
  const quad = (
    a: number[], b: number[], c: number[], d: number[],
    n: number[], r: number, g: number, bl: number,
  ): void => {
    for (const v of [a, b, c, a, c, d]) {
      pos.push(v[0], v[1], v[2]); norm.push(n[0], n[1], n[2]); col.push(r, g, bl);
    }
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!solid(x, y)) continue;
      const i = (y * W + x) * 4;
      const r = (data[i] / 255) ** 2.2, g = (data[i + 1] / 255) ** 2.2, b = (data[i + 2] / 255) ** 2.2;
      const x0 = x, x1 = x + 1;
      const Y = H - 1 - y, y0 = Y, y1 = Y + 1;
      const z0 = 0, z1 = depth;
      quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], r, g, b);
      quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], r, g, b);
      if (!solid(x - 1, y)) quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], r, g, b);
      if (!solid(x + 1, y)) quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], r, g, b);
      if (!solid(x, y - 1)) quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], r, g, b);
      if (!solid(x, y + 1)) quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], r, g, b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.translate(-W / 2, -H / 2, -depth / 2);
  const s = sizeAcross / W;
  geo.scale(s, s, s);
  return geo;
}

// ---------------------------------------------------------------------------
// Pixel toolkit: tileable noise, a 16x16 RGBA scratch buffer and a few
// shading helpers (bevels, ore clusters, auto-outline) shared by the painters.
// ---------------------------------------------------------------------------

type RGB = [number, number, number];

const shade = (c: RGB, f: number): RGB => [c[0] * f, c[1] * f, c[2] * f];
const mixC = (a: RGB, b: RGB, t: number): RGB =>
  [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const pal = (cols: string[]): RGB[] => cols.map(hex);
const clampI = (v: number, n: number): number => (v < 0 ? 0 : v >= n ? n - 1 : v | 0);

/** 16x16 RGBA scratch buffer; coordinates wrap so every stamp stays tileable. */
class Px {
  d = new Uint8ClampedArray(TILE * TILE * 4);
  private o(x: number, y: number): number { return (((y & 15) * TILE) + (x & 15)) * 4; }
  set(x: number, y: number, c: RGB | string, a = 255): void {
    const col = typeof c === 'string' ? hex(c) : c;
    const o = this.o(x, y);
    this.d[o] = col[0]; this.d[o + 1] = col[1]; this.d[o + 2] = col[2]; this.d[o + 3] = a;
  }
  get(x: number, y: number): RGB { const o = this.o(x, y); return [this.d[o], this.d[o + 1], this.d[o + 2]]; }
  a(x: number, y: number): number { return this.d[this.o(x, y) + 3]; }
  mul(x: number, y: number, f: number): void {
    const o = this.o(x, y);
    this.d[o] *= f; this.d[o + 1] *= f; this.d[o + 2] *= f;
  }
  clear(x: number, y: number): void { this.d[this.o(x, y) + 3] = 0; }
  fill(fn: (x: number, y: number) => RGB | string): this {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) this.set(x, y, fn(x, y));
    return this;
  }
  copy(): Px { const p = new Px(); p.d.set(this.d); return p; }
  put(ctx: Ctx, x0: number, y0: number): void {
    const img = ctx.createImageData(TILE, TILE);
    img.data.set(this.d);
    ctx.putImageData(img, x0, y0);
  }
}

/** Smooth value noise that tiles over 16px, with `cx` x `cy` lattice cells. */
function tileNoise(seed: number, cx: number, cy = cx): (x: number, y: number) => number {
  const r = mulberry32(seed);
  const g = new Float32Array(cx * cy);
  for (let i = 0; i < g.length; i++) g[i] = r();
  const sx = TILE / cx, sy = TILE / cy;
  const at = (i: number, j: number): number => g[(((j % cy) + cy) % cy) * cx + (((i % cx) + cx) % cx)];
  return (x, y) => {
    const fx = (x + 0.5) / sx, fy = (y + 0.5) / sy;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    let tx = fx - ix, ty = fy - iy;
    tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
    const a = at(ix, iy), b = at(ix + 1, iy), c = at(ix, iy + 1), d = at(ix + 1, iy + 1);
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };
}

/** Weighted octave sum of tileNoise, stretched back out to roughly 0..1. */
function fbm(seed: number, octaves: [number, number, number?][], contrast = 1.8): (x: number, y: number) => number {
  const ns = octaves.map(([cx, , cy], i) => tileNoise(seed + i * 131, cx, cy ?? cx));
  const tw = octaves.reduce((s, o) => s + o[1], 0);
  return (x, y) => {
    let v = 0;
    for (let i = 0; i < ns.length; i++) v += ns[i](x, y) * octaves[i][1];
    return 0.5 + (v / tw - 0.5) * contrast;
  };
}

/** Fill `p` from a dark->light ramp indexed by f(x,y) plus per-pixel grain. */
function rampFill(p: Px, ramp: RGB[], f: (x: number, y: number) => number, seed: number, grain = 0.12): Px {
  const r = mulberry32(seed);
  return p.fill((x, y) => ramp[clampI((f(x, y) + (r() - 0.5) * grain) * ramp.length, ramp.length)]);
}

/** Tileable Voronoi: nearest-seed index for every pixel (wrap-aware). */
function voronoi(seed: number, n: number, jitter = 1): Int16Array {
  const r = mulberry32(seed);
  const pts: [number, number, number][] = [];
  for (let i = 0; i < n; i++) pts.push([r() * 16, r() * 16, 1 + (r() - 0.5) * jitter * 0.6]);
  const out = new Int16Array(TILE * TILE);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      let best = 0, bd = 1e9;
      for (let i = 0; i < n; i++) {
        let dx = Math.abs(x + 0.5 - pts[i][0]); if (dx > 8) dx = 16 - dx;
        let dy = Math.abs(y + 0.5 - pts[i][1]); if (dy > 8) dy = 16 - dy;
        const d = (dx * dx + dy * dy) * pts[i][2];
        if (d < bd) { bd = d; best = i; }
      }
      out[y * TILE + x] = best;
    }
  }
  return out;
}
const cellAt = (v: Int16Array, x: number, y: number): number => v[((y & 15) * TILE) + (x & 15)];

/**
 * Bevel a region map: pixels on a region's top/left rim get `hi`, the
 * bottom/right rim gets `lo`, and the seam (right/bottom neighbour differs)
 * becomes `gap` — the chiselled look of cobble, bricks and gravel.
 */
function bevelRegions(p: Px, v: Int16Array, hi: number, lo: number, gap: RGB | null, wide = true): void {
  const src = p.copy();
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const me = cellAt(v, x, y);
      const edgeR = cellAt(v, x + 1, y) !== me, edgeD = cellAt(v, x, y + 1) !== me;
      const edgeL = cellAt(v, x - 1, y) !== me, edgeU = cellAt(v, x, y - 1) !== me;
      if (gap && (edgeR || edgeD)) { p.set(x, y, gap); continue; }
      if (edgeU || edgeL) p.set(x, y, shade(src.get(x, y), hi));
      else if (cellAt(v, x + 1, y + 1) !== me || (wide && (cellAt(v, x + 2, y) !== me || cellAt(v, x, y + 2) !== me))) {
        p.set(x, y, shade(src.get(x, y), lo));
      }
    }
  }
}

/** One ore cluster: lit top-left, shaded bottom-right, darkened stone rim. */
function oreBlob(p: Px, bx: number, by: number, shape: string[], hi: RGB, mid: RGB, lo: RGB, rim = 0.72): void {
  const on = (x: number, y: number): boolean => y >= 0 && y < shape.length && x >= 0 && x < shape[y].length && shape[y][x] !== '.';
  // darken the stone just below/right of the ore so it sits *in* the rock
  for (let y = 0; y <= shape.length; y++) {
    for (let x = 0; x <= shape[0].length; x++) {
      if (!on(x, y) && (on(x - 1, y) || on(x, y - 1) || on(x - 1, y - 1))) p.mul(bx + x, by + y, rim);
    }
  }
  for (let y = 0; y < shape.length; y++) {
    for (let x = 0; x < shape[y].length; x++) {
      if (!on(x, y)) continue;
      const ch = shape[y][x];
      let col = mid;
      if (ch === 'h' || (!on(x - 1, y) && !on(x, y - 1))) col = hi;
      else if (ch === 'l' || (!on(x + 1, y) && !on(x, y + 1)) || (!on(x, y + 1) && !on(x + 1, y + 1))) col = lo;
      p.set(bx + x, by + y, col);
    }
  }
}

const BLOB_SHAPES: string[][] = [
  ['.##', '###', '##.'],
  ['##', '##'],
  ['.#.', '###', '.#.'],
  ['###', '.##'],
  ['##.', '###', '.#.'],
  ['#.', '##'],
];
// chunkier seams for common ores (coal, iron) — vanilla packs those denser
const BIG_BLOBS: string[][] = [
  ['.##.', '####', '.##.'],
  ['###', '###', '.#.'],
  ['.##', '###', '##.'],
  ['##.', '###', '.##'],
];

// ---- shared palettes (dark -> light ramps) --------------------------------

const STONE_R = pal(['#5c5c5c', '#686868', '#737373', '#7c7c7c', '#858585', '#8f8f8f', '#9a9a9a']);
const DIRT_R = pal(['#5a3e2b', '#684832', '#76533a', '#835d41', '#8f6848', '#9b7352']);
const GRASS_R = pal(['#4a8a2c', '#529533', '#5a9f39', '#63a940', '#6cb247', '#78bc50']);
const SAND_R = pal(['#cbbf88', '#d3c892', '#dad09b', '#e0d7a5', '#e6deaf', '#ece5b9']);
const SNOW_R = pal(['#dfe8ec', '#e8f0f2', '#f0f6f7', '#f7fbfb', '#ffffff']);
const NETHERRACK_R = pal(['#3c0f0f', '#4d1414', '#5e1b1a', '#6e2321', '#7d2c29', '#8d3a35', '#9c4640']);
// average biome tint applied to the untinted grass-side lip so it matches the tinted top
const SIDE_TINT: RGB = [0.94, 1, 0.74];

const stoneCache = new Map<number, Px>();
/** Base stone (shared by every overworld ore so they sit flush with plain stone). */
function stonePx(seed = 101): Px {
  let p = stoneCache.get(seed);
  if (!p) { p = paintStone(seed); stoneCache.set(seed, p); }
  return p.copy();
}

function paintStone(seed: number): Px {
  const f = fbm(seed, [[4, 0.22], [8, 0.46], [16, 0.32]], 2.0);
  const p = rampFill(new Px(), STONE_R, f, seed + 1, 0.22);
  // vanilla stone's faint horizontal chisel strokes: dark dash, lit pixel above
  const r = mulberry32(seed + 2);
  for (let i = 0; i < 7; i++) {
    const x = (r() * 16) | 0, y = (r() * 16) | 0, len = 2 + ((r() * 3) | 0);
    for (let k = 0; k < len; k++) {
      p.set(x + k, y, STONE_R[1]);
      if (r() < 0.7) p.set(x + k, y - 1, STONE_R[5]);
    }
  }
  return p;
}

function dirtPx(seed = 102): Px {
  const f = fbm(seed, [[4, 0.45], [8, 0.35], [16, 0.2]], 1.9);
  const p = rampFill(new Px(), DIRT_R, f, seed + 1, 0.3);
  const r = mulberry32(seed + 2);
  // little buried pebbles + clods, each lit on top
  for (let i = 0; i < 7; i++) {
    const x = (r() * 16) | 0, y = (r() * 16) | 0;
    p.set(x, y, DIRT_R[0]);
    if (r() < 0.5) p.set(x + 1, y, DIRT_R[1]);
    p.set(x, y - 1, DIRT_R[5]);
  }
  // one small buried stone
  const x = (r() * 16) | 0, y = (r() * 16) | 0;
  p.set(x, y, '#7a6e60'); p.set(x + 1, y, '#665a4c'); p.set(x, y - 1, '#8c806f');
  return p;
}

function grassTopPx(): Px {
  const f = fbm(103, [[8, 0.5], [16, 0.5]], 1.6);
  return rampFill(new Px(), GRASS_R, f, 104, 0.55);
}

/** Dirt with a hanging lip of `lip` colours (grass/snow) on the top edge. */
function lipSidePx(seed: number, lip: RGB[], edge: RGB, minDepth: number): Px {
  const p = dirtPx(109);
  const r = mulberry32(seed);
  // lip edge wanders smoothly along the block, with the odd single drip
  const wave = tileNoise(seed + 3, 4, 1);
  const depth: number[] = [];
  for (let x = 0; x < 16; x++) depth.push(minDepth + Math.round(wave(x, 0) * 1.6 - 0.3) + (r() < 0.14 ? 1 : 0));
  const f = fbm(seed + 5, [[8, 0.5], [16, 0.5]], 1.6);
  for (let x = 0; x < 16; x++) {
    for (let y = 0; y < depth[x]; y++) {
      const idx = clampI((f(x, y) + (r() - 0.5) * 0.5) * lip.length, lip.length);
      p.set(x, y, y === depth[x] - 1 ? edge : lip[idx]);
    }
    p.mul(x, depth[x], 0.8); // soft shadow just under the overhang
  }
  return p;
}

function sandPx(seed = 104, ramp = SAND_R): Px {
  const f = fbm(seed, [[8, 0.4], [16, 0.6]], 1.5);
  const p = rampFill(new Px(), ramp, f, seed + 1, 0.45);
  const r = mulberry32(seed + 2);
  for (let i = 0; i < 6; i++) p.set((r() * 16) | 0, (r() * 16) | 0, shade(ramp[0], 0.94));
  return p;
}

const COBBLE_R = pal(['#666666', '#727272', '#7e7e7e', '#8a8a8a', '#969696', '#a3a3a3', '#b0b0b0']);
function cobblePx(seed = 111, ramp = COBBLE_R, gap: RGB = hex('#505050')): Px {
  const v = voronoi(seed, 11, 1);
  const r = mulberry32(seed + 1);
  const base = Array.from({ length: 11 }, () => 2 + ((r() * 3.5) | 0));
  const f = fbm(seed + 2, [[8, 0.5], [16, 0.5]], 1.2);
  const p = new Px().fill((x, y) => ramp[clampI(base[cellAt(v, x, y)] + (f(x, y) - 0.5) * 2.2, ramp.length)]);
  bevelRegions(p, v, 1.14, 0.84, gap, false);
  return p;
}

/** Oak-style planks: four boards, dark seams, staggered butt joints, grain. */
function planksPx(ramp: RGB[], seam: RGB, seed = 112): Px {
  const r = mulberry32(seed);
  const f = fbm(seed + 1, [[4, 0.5, 16], [8, 0.5, 16]], 1.3);
  const p = new Px();
  const boardShift = [0, 1, -1, 0];
  const joints = [[5], [12], [2, 10], [7]];
  for (let y = 0; y < 16; y++) {
    const b = y >> 2, row = y & 3;
    for (let x = 0; x < 16; x++) {
      let i = 2 + boardShift[b] + (f(x + b * 4, y) - 0.5) * 2.4;
      if (row === 0) i += 1;            // lit top edge of each board
      if (row === 3) { p.set(x, y, seam); continue; }
      p.set(x, y, ramp[clampI(i, ramp.length)]);
    }
    for (const jx of joints[y >> 2]) if ((y & 3) !== 3) p.set(jx, y, seam);
  }
  // grain streaks
  for (let i = 0; i < 9; i++) {
    const y = ((r() * 4) | 0) * 4 + 1 + ((r() * 2) | 0);
    const x = (r() * 16) | 0, len = 2 + ((r() * 4) | 0);
    for (let k = 0; k < len; k++) p.set(x + k, y, ramp[0]);
  }
  return p;
}
const OAK_R = pal(['#7e6337', '#8d7042', '#9c7f4e', '#a88b57', '#b49660', '#bfa26b']);
const OAK_SEAM = hex('#5f4a28');

/** Vertical bark: furrowed columns that drift a little down the log. */
function barkPx(ramp: RGB[], seed: number): Px {
  const f = fbm(seed, [[8, 0.6, 1], [16, 0.4, 4]], 2.0);
  const p = rampFill(new Px(), ramp, f, seed + 1, 0.25);
  const r = mulberry32(seed + 2);
  // deep furrows with a lit ridge beside them
  for (let i = 0; i < 5; i++) {
    let x = (r() * 16) | 0;
    const y0 = (r() * 16) | 0, len = 4 + ((r() * 8) | 0);
    for (let k = 0; k < len; k++) {
      p.set(x, y0 + k, ramp[0]);
      p.set(x + 1, y0 + k, ramp[ramp.length - 2]);
      if (r() < 0.15) x += r() < 0.5 ? -1 : 1;
    }
  }
  return p;
}

/** Log end grain: bark rim, rounded-square growth rings, dark pith. */
function ringsPx(bark: RGB[], wood: RGB[], seed: number): Px {
  const n = tileNoise(seed, 4);
  const r = mulberry32(seed + 1);
  const p = new Px();
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const dx = Math.abs(x - 7.5), dy = Math.abs(y - 7.5);
      if (dx > 6.5 || dy > 6.5) { p.set(x, y, bark[clampI(1 + r() * (bark.length - 2), bark.length)]); continue; }
      const d = Math.max(dx, dy) * 0.6 + Math.hypot(dx, dy) * 0.4 + (n(x, y) - 0.5) * 0.5;
      const ring = Math.floor(d / 2);
      let col = wood[ring % 2 === 0 ? 2 : 1];
      if (d / 2 - ring > 0.72) col = wood[0];                     // thin dark ring line
      else if (r() < 0.08) col = wood[3];
      p.set(x, y, col);
    }
  }
  // inner lip of the bark catches light on top/left, shadow bottom/right
  for (let i = 1; i < 15; i++) {
    p.set(i, 1, shade(p.get(i, 1), 0.85)); p.set(1, i, shade(p.get(1, i), 0.85));
  }
  p.set(7, 7, wood[0]); p.set(8, 8, wood[0]); p.set(8, 7, shade(wood[0], 0.85));
  return p;
}

/**
 * Leaves: a dark canopy stamped with lit leaf clumps; the darkest gaps
 * become see-through holes (the alpha cutout keeps the rest).
 */
function leavesPx(ramp: RGB[], seed: number, clumps: number, holeFrac: number, needles = false): Px {
  const r = mulberry32(seed);
  const p = new Px().fill(() => ramp[0]);
  const depth = new Uint8Array(TILE * TILE);
  const put = (x: number, y: number, i: number): void => {
    const k = ((y & 15) * TILE) + (x & 15);
    if (i >= depth[k]) { depth[k] = i; p.set(x, y, ramp[i]); }
  };
  for (let c = 0; c < clumps; c++) {
    const x = (r() * 16) | 0, y = (r() * 16) | 0;
    const tone = 2 + ((r() * (ramp.length - 3)) | 0);
    if (needles) {
      // a short diagonal sprig of needles
      const dir = r() < 0.5 ? 1 : -1;
      for (let k = 0; k < 3; k++) put(x + k * dir, y + k, k === 0 ? Math.min(ramp.length - 1, tone + 1) : tone);
      put(x + dir, y, tone - 1);
    } else {
      put(x, y, Math.min(ramp.length - 1, tone + 1)); // lit crown
      put(x + 1, y, tone);
      put(x - 1, y + 1, tone); put(x, y + 1, tone); put(x + 1, y + 1, tone - 1);
      put(x, y + 2, tone - 1);
    }
  }
  // shade pixels directly under a brighter one (self-shadowing clumps)
  for (let y = 15; y >= 0; y--) {
    for (let x = 0; x < 16; x++) {
      const k = y * TILE + x, up = ((y - 1) & 15) * TILE + x;
      if (depth[k] === 0 && depth[up] >= 2) { depth[k] = 1; p.set(x, y, ramp[1]); }
    }
  }
  for (let k = 0; k < TILE * TILE; k++) {
    if (depth[k] === 0 && r() < holeFrac) p.clear(k & 15, k >> 4);
  }
  return p;
}

/** Brick courses: `h`-tall rows of `w`-wide bricks, alternate rows offset. */
function bricksPx(ramp: RGB[], mortar: RGB, w: number, h: number, seed: number, hi = 1.16, lo = 0.82): Px {
  const r = mulberry32(seed);
  const tone = new Map<number, number>();
  const f = fbm(seed + 1, [[8, 0.5], [16, 0.5]], 1.2);
  const p = new Px();
  for (let y = 0; y < 16; y++) {
    const row = Math.floor(y / h), ry = y % h, off = row % 2 === 0 ? 0 : w / 2;
    for (let x = 0; x < 16; x++) {
      const bx = ((x + off) % 16) % w, id = row * 16 + Math.floor(((x + off) % 16) / w);
      if (!tone.has(id)) tone.set(id, 1.5 + r() * (ramp.length - 3));
      let col = ramp[clampI(tone.get(id)! + (f(x, y) - 0.5) * 2, ramp.length)];
      if (ry === h - 1 || bx === w - 1) col = mortar;
      else if (ry === 0 || bx === 0) col = shade(col, hi);
      else if (ry === h - 2 || bx === w - 2) col = shade(col, lo);
      p.set(x, y, col);
    }
  }
  return p;
}

function metalPx(ramp: RGB[], seed: number): Px {
  // vanilla metal blocks: bright bevelled plate, faint brushed noise, rivet-ish corners
  const f = fbm(seed, [[8, 0.5, 4], [16, 0.5, 8]], 1.1);
  const n = ramp.length;
  const p = rampFill(new Px(), ramp.slice(2, n - 1), f, seed + 1, 0.2);
  for (let i = 0; i < 16; i++) {
    p.set(i, 0, ramp[n - 1]); p.set(0, i, ramp[n - 1]);
    p.set(i, 15, ramp[0]); p.set(15, i, ramp[0]);
  }
  for (let i = 1; i < 15; i++) {
    p.set(i, 1, ramp[n - 2]); p.set(1, i, ramp[n - 2]);
    p.set(i, 14, ramp[1]); p.set(14, i, ramp[1]);
  }
  p.set(0, 15, ramp[1]); p.set(15, 0, ramp[1]);
  const r = mulberry32(seed + 2);
  for (let i = 0; i < 3; i++) {
    const x = 3 + ((r() * 10) | 0), y = 3 + ((r() * 10) | 0);
    p.set(x, y, ramp[n - 2]); p.set(x + 1, y + 1, ramp[2]);
  }
  return p;
}

function oreTile(c: Ctx, x: number, y: number, seed: number, cols: string[], big = false): void {
  const p = stonePx(101);
  const [hi, mid, lo] = pal(cols);
  const r = mulberry32(seed);
  const spots: [number, number][] = [[2, 2], [9, 1], [5, 7], [12, 7], [1, 11], [8, 12]];
  for (const [sx, sy] of spots) {
    if (r() < 0.12) continue;
    const shapes = big ? BIG_BLOBS : BLOB_SHAPES;
    const shape = shapes[(r() * shapes.length) | 0];
    oreBlob(p, sx + ((r() * 2) | 0), sy + ((r() * 2) | 0), shape, hi, mid, lo);
  }
  p.put(c, x, y);
}

function cropTile(c: Ctx, x: number, y: number, seed: number, leaf: string, light: string, root: string, stage: 0 | 1 | 2): void {
  c.clearRect(x, y, 16, 16);
  const rand = mulberry32(seed);
  const stems = stage === 0 ? [4, 8, 12] : [2, 5, 8, 11, 14];
  const dark = `#${hex(leaf).map((v) => Math.round(v * 0.72).toString(16).padStart(2, '0')).join('')}`;
  for (const bx of stems) {
    const h = (stage === 0 ? 3 : stage === 1 ? 6 : 9) + ((rand() * 3) | 0);
    for (let j = 0; j < h; j++) {
      c.fillStyle = j > h - 3 ? light : j < 2 ? dark : leaf;
      c.fillRect(x + bx, y + 15 - j, 1, 1);
      if (stage > 0 && j === ((h * 0.55) | 0)) { c.fillStyle = light; c.fillRect(x + bx + 1, y + 15 - j, 1, 1); }
      if (stage > 0 && j === ((h * 0.3) | 0)) { c.fillStyle = leaf; c.fillRect(x + bx - 1, y + 15 - j, 1, 1); }
    }
    if (stage === 2) {
      c.fillStyle = root;
      c.fillRect(x + bx - 1, y + 14, 2, 2);
      c.fillStyle = light;
      c.fillRect(x + bx - 1, y + 14, 1, 1);
      if (rand() < 0.45) { c.fillStyle = root; c.fillRect(x + bx + 1, y + 13, 1, 2); }
    }
  }
}

// ---------------------------------------------------------------------------
// Tile painters
// ---------------------------------------------------------------------------

const TILE_PAINTERS: Record<string, (ctx: Ctx, x: number, y: number) => void> = {
  stone: (c, x, y) => stonePx().put(c, x, y),
  dirt: (c, x, y) => dirtPx().put(c, x, y),
  grass_top: (c, x, y) => grassTopPx().put(c, x, y),
  sand: (c, x, y) => sandPx().put(c, x, y),
  snow_top: (c, x, y) => {
    const f = fbm(105, [[4, 0.5], [16, 0.5]], 1.4);
    rampFill(new Px(), SNOW_R, f, 106, 0.35).put(c, x, y);
  },
  leaves: (c, x, y) => leavesPx(pal(['#1d4a12', '#265c18', '#306e1f', '#3a7f26', '#458f2e', '#52a038']), 206, 46, 0.55).put(c, x, y),
  water: (c, x, y) => {
    // still water: soft swells crossed by a wobbly web of lighter wave crests
    // (tileable; the water shader drifts two copies of it against each other)
    const ramp = pal(['#284a9e', '#2d52aa', '#325ab5', '#3862bf', '#3f6bc9', '#4775d2']);
    const f = fbm(107, [[4, 0.6, 4], [8, 0.4, 8]], 1.6);
    const p = rampFill(new Px(), ramp, f, 108, 0.18);
    const cells = voronoi(2107, 6, 1);
    for (let py = 0; py < 16; py++) {
      for (let px = 0; px < 16; px++) {
        const k = cellAt(cells, px, py);
        const edge = k !== cellAt(cells, px + 1, py) || k !== cellAt(cells, px, py + 1);
        if (!edge) continue;
        const bright = f(px, py) > 0.5;
        p.set(px, py, bright ? '#86a8ee' : '#5f86dc');
      }
    }
    for (let i = 3; i < p.d.length; i += 4) p.d[i] = 200;
    p.put(c, x, y);
  },
  water_flow: (c, x, y) => {
    // flowing water: streaks stretched along the tile's v axis, which the
    // shader turns to face downstream / downhill
    const ramp = pal(['#26479a', '#2c50a8', '#3259b4', '#3a63c0', '#436fcb', '#4f7bd5']);
    const f = fbm(1107, [[8, 0.6, 2], [16, 0.4, 4]], 1.9);
    const p = rampFill(new Px(), ramp, f, 1108, 0.12);
    const r = mulberry32(3107);
    for (let i = 0; i < 9; i++) {
      const gx = (r() * 16) | 0, gy = (r() * 16) | 0, len = 3 + ((r() * 5) | 0);
      for (let k = 0; k < len; k++) p.set(gx, gy + k, k === 0 || k === len - 1 ? '#6a8fe0' : '#93b1f0');
    }
    for (let i = 3; i < p.d.length; i += 4) p.d[i] = 200;
    p.put(c, x, y);
  },
  lava: (c, x, y) => {
    const ramp = pal(['#8a1f06', '#b3300a', '#d2450d', '#e86214', '#f5831e', '#fba62c', '#ffc93f', '#ffe36a']);
    const f = fbm(1099, [[4, 0.55], [8, 0.3], [16, 0.15]], 2.2);
    const p = rampFill(new Px(), ramp, f, 1100, 0.2);
    // cooling crust flecks drifting on the surface
    const r = mulberry32(2199);
    for (let i = 0; i < 7; i++) {
      const bx = (r() * 16) | 0, by = (r() * 16) | 0;
      p.set(bx, by, ramp[0]); p.set(bx + 1, by, ramp[1]); p.set(bx, by - 1, ramp[6]);
    }
    p.put(c, x, y);
  },
  obsidian: (c, x, y) => {
    const ramp = pal(['#08060d', '#0f0b17', '#151020', '#1c1529', '#241b35', '#2f2244', '#3b2c55']);
    const f = fbm(1199, [[4, 0.5], [8, 0.3], [16, 0.2]], 2.0);
    const p = rampFill(new Px(), ramp, f, 1200, 0.2);
    const r = mulberry32(2299);
    for (let i = 0; i < 6; i++) {
      // glassy purple sheen streaks
      const bx = (r() * 16) | 0, by = (r() * 16) | 0;
      p.set(bx, by, '#5d4088'); p.set(bx + 1, by + 1, '#46306a'); if (r() < 0.5) p.set(bx + 2, by + 2, '#35264f');
    }
    p.put(c, x, y);
  },
  portal: (c, x, y) => {
    const ramp = pal(['#2d0858', '#40107a', '#56189a', '#6d24b8', '#8836d2', '#a452ea', '#c07af8']);
    const n = tileNoise(7001, 4);
    const p = new Px().fill((px, py) => {
      const t = Math.sin((px + py * 0.5) * 0.9 + n(px, py) * 7) * 0.5 + 0.5;
      return ramp[clampI(t * ramp.length, ramp.length)];
    });
    for (let i = 3; i < p.d.length; i += 4) p.d[i] = 170;
    p.put(c, x, y);
  },
  netherrack: (c, x, y) => {
    const f = fbm(7002, [[4, 0.4], [8, 0.35], [16, 0.25]], 2.0);
    const p = rampFill(new Px(), NETHERRACK_R, f, 7003, 0.35);
    const r = mulberry32(7004);
    for (let i = 0; i < 6; i++) {
      let cx = (r() * 16) | 0, cy = (r() * 16) | 0;
      for (let k = 0; k < 4; k++) {
        p.set(cx, cy, '#2c0909');
        p.set(cx, cy - 1, NETHERRACK_R[6]);
        cx += 1; if (r() < 0.4) cy += r() < 0.5 ? 1 : -1;
      }
    }
    p.put(c, x, y);
  },
  glowstone: (c, x, y) => {
    const ramp = pal(['#b07a32', '#d19a4a', '#e8b764', '#f6d283', '#fde6a6', '#fff6d2']);
    const v = voronoi(7005, 12, 1);
    const r = mulberry32(7006);
    const tone = Array.from({ length: 12 }, () => 1 + ((r() * 5) | 0));
    const p = new Px().fill((px, py) => ramp[clampI(tone[cellAt(v, px, py)] + (r() - 0.5) * 1.2, ramp.length)]);
    bevelRegions(p, v, 1.12, 0.8, hex('#6e4618'));
    p.put(c, x, y);
  },
  soul_sand: (c, x, y) => {
    const ramp = pal(['#2e2016', '#382719', '#432f1f', '#4e3826', '#59412d', '#644a34']);
    const f = fbm(7006, [[8, 0.5], [16, 0.5]], 1.6);
    const p = rampFill(new Px(), ramp, f, 7007, 0.4);
    // the trapped faces: two hollow eyes over a gaping mouth, rimmed with light
    const face = (fx: number, fy: number): void => {
      for (const [ex, ey, w, h] of [[0, 0, 2, 2], [4, 0, 2, 2], [1, 3, 4, 2]] as const) {
        for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) p.set(fx + ex + i, fy + ey + j, '#1b120b');
        for (let i = 0; i < w; i++) p.set(fx + ex + i, fy + ey - 1, ramp[5]);
        for (let i = 0; i < w; i++) p.set(fx + ex + i, fy + ey + h, ramp[1]);
      }
    };
    face(1, 2); face(9, 9);
    p.put(c, x, y);
  },
  nether_quartz_ore: (c, x, y) => {
    const f = fbm(7002, [[4, 0.4], [8, 0.35], [16, 0.25]], 2.0);
    const p = rampFill(new Px(), NETHERRACK_R, f, 7003, 0.35);
    const hi = hex('#fffdf8'), mid = hex('#e6dfd6'), lo = hex('#b5a89f');
    oreBlob(p, 2, 2, ['###.', '.###'], hi, mid, lo, 0.7);
    oreBlob(p, 10, 3, ['#', '#', '#'], hi, mid, lo, 0.7);
    oreBlob(p, 5, 8, ['##', '.##', '..#'], hi, mid, lo, 0.7);
    oreBlob(p, 11, 11, ['###'], hi, mid, lo, 0.7);
    oreBlob(p, 1, 12, ['#.', '##'], hi, mid, lo, 0.7);
    p.put(c, x, y);
  },
  magma: (c, x, y) => {
    const v = voronoi(7050, 9, 1);
    const r = mulberry32(7051);
    const ramp = pal(['#2a0e06', '#3a1508', '#4a1c0a', '#5a240d']);
    const tone = Array.from({ length: 9 }, () => (r() * 4) | 0);
    const p = new Px().fill((px, py) => ramp[clampI(tone[cellAt(v, px, py)] + (r() - 0.5), 4)]);
    for (let py = 0; py < 16; py++) {
      for (let px = 0; px < 16; px++) {
        const me = cellAt(v, px, py);
        const e = cellAt(v, px + 1, py) !== me || cellAt(v, px, py + 1) !== me;
        const junction = e && cellAt(v, px + 1, py + 1) !== me && cellAt(v, px + 1, py) !== cellAt(v, px, py + 1);
        if (junction) p.set(px, py, '#ffd24a');
        else if (e) p.set(px, py, r() < 0.5 ? '#ff8a1e' : '#f06a14');
      }
    }
    p.put(c, x, y);
  },
  nether_bricks: (c, x, y) => bricksPx(pal(['#241014', '#2c1418', '#34181d', '#3c1d22', '#452227']), hex('#12070a'), 8, 4, 7052, 1.3, 0.8).put(c, x, y),
  redstone_dust: (c, x, y) => {
    // cross of dust reaching every edge; red channel carries the brightness
    // because the mesher tints wire by (power, 0, 0)
    const p = new Px();
    for (let i = 0; i < p.d.length; i += 4) p.d[i + 3] = 0;
    const r = mulberry32(7009);
    const cols = ['#ff4a3a', '#e02a20', '#b81610', '#ff7060'];
    const dot = (px: number, py: number): void => p.set(px, py, cols[(r() * 3) | 0]);
    for (let i = 0; i < 16; i++) {
      for (const o of [7, 8]) { if (r() < 0.85) dot(i, o); if (r() < 0.85) dot(o, i); }
      if (r() < 0.3) dot(i, r() < 0.5 ? 6 : 9);
      if (r() < 0.3) dot(r() < 0.5 ? 6 : 9, i);
    }
    for (let j = 5; j <= 10; j++) for (let i = 5; i <= 10; i++) if (r() < 0.8 && Math.abs(i - 7.5) + Math.abs(j - 7.5) < 4.5) dot(i, j);
    p.set(7, 7, cols[3]); p.set(8, 8, cols[3]);
    p.put(c, x, y);
  },
  redstone_lamp: (c, x, y) => lampPx(false).put(c, x, y),
  redstone_lamp_lit: (c, x, y) => lampPx(true).put(c, x, y),
  lever: (c, x, y) => {
    c.clearRect(x, y, 16, 16);
    pixmap(c, x, y, [
      '................', '.......oo.......', '......oHho......', '......oHho......',
      '.......oHo......', '.......oHo......', '.......oHo......', '.......oHo......',
      '.......oHo......', '.......oHo......', '....oooHhooo....', '...oLLLLLLMmo...',
      '...oLMMMMMMmo...', '...oMMMMMMmmo...', '....oooooooo....', '................',
    ], { o: '#2a2016', H: '#a07a44', h: '#6e5230', L: '#a8a8a8', M: '#858585', m: '#5e5e5e' });
  },
  piston_top: (c, x, y) => {
    const p = planksPx(OAK_R, OAK_SEAM, 7012);
    for (let i = 0; i < 16; i++) { p.set(i, 0, '#4a3a22'); p.set(0, i, '#4a3a22'); p.set(i, 15, '#3a2c18'); p.set(15, i, '#3a2c18'); }
    // iron push plate in the middle
    for (let j = 5; j <= 10; j++) for (let i = 5; i <= 10; i++) p.set(i, j, j === 5 || i === 5 ? '#d8d8d8' : j === 10 || i === 10 ? '#7a7a7a' : '#b4b4b4');
    p.put(c, x, y);
  },
  piston_top_sticky: (c, x, y) => {
    const p = planksPx(OAK_R, OAK_SEAM, 7012);
    for (let i = 0; i < 16; i++) { p.set(i, 0, '#4a3a22'); p.set(0, i, '#4a3a22'); p.set(i, 15, '#3a2c18'); p.set(15, i, '#3a2c18'); }
    const slime = pal(['#4f8f36', '#62a846', '#7cc05a', '#a0dc7e']);
    const r = mulberry32(7013);
    for (let j = 2; j <= 13; j++) {
      for (let i = 2; i <= 13; i++) {
        const d = Math.hypot(i - 7.5, j - 7.5);
        if (d < 5.5 + r() * 1.2) p.set(i, j, slime[clampI(3 - d / 2 + r() * 0.8, 4)]);
      }
    }
    p.put(c, x, y);
  },
  piston_bottom: (c, x, y) => {
    const p = cobblePx(7014);
    for (let j = 5; j <= 10; j++) for (let i = 5; i <= 10; i++) p.set(i, j, j === 5 || i === 5 ? '#2a2a2a' : '#3c3c3c');
    p.put(c, x, y);
  },
  piston_side: (c, x, y) => {
    const p = cobblePx(7015);
    const wood = planksPx(OAK_R, OAK_SEAM, 7012);
    for (let j = 0; j < 4; j++) for (let i = 0; i < 16; i++) p.set(i, j, wood.get(i, j + 4));
    for (let i = 0; i < 16; i++) { p.set(i, 4, '#3a2c18'); p.mul(i, 5, 0.75); }
    // the shaft groove down the middle
    for (let j = 6; j < 16; j++) { p.set(7, j, '#4a4a4a'); p.set(8, j, '#5e5e5e'); }
    p.put(c, x, y);
  },
  bedrock: (c, x, y) => {
    const ramp = pal(['#161616', '#262626', '#3a3a3a', '#505050', '#686868', '#828282', '#9a9a9a']);
    const f = fbm(108, [[8, 0.6], [16, 0.4]], 2.4);
    rampFill(new Px(), ramp, f, 109, 0.6).put(c, x, y);
  },
  grass_side: (c, x, y) => lipSidePx(209, GRASS_R.map((g) => [g[0] * SIDE_TINT[0], g[1], g[2] * SIDE_TINT[2]] as RGB),
    hex('#3f7424'), 3).put(c, x, y),
  snow_side: (c, x, y) => lipSidePx(210, SNOW_R, hex('#c9d6db'), 3).put(c, x, y),
  cobble: (c, x, y) => cobblePx().put(c, x, y),
  planks: (c, x, y) => planksPx(OAK_R, OAK_SEAM).put(c, x, y),
  log_side: (c, x, y) => barkPx(pal(['#3a2a16', '#48351d', '#554026', '#634b2d', '#705634', '#7d623c']), 113).put(c, x, y),
  log_top: (c, x, y) => ringsPx(pal(['#3a2a16', '#554026', '#634b2d', '#705634']),
    pal(['#8a6b3e', '#a4844f', '#b5935c', '#c2a169']), 114).put(c, x, y),
  // Minecraft-style glass: a light blue-white border frame around a fully
  // transparent pane (the alpha-test pass keeps the opaque frame, drops the
  // clear centre), with the signature corner glint + diagonal reflection.
  glass: (c, x, y) => {
    c.clearRect(x, y, 16, 16);
    // border frame (opaque so it survives the alpha cutout)
    c.fillStyle = '#a7c9d4';
    c.fillRect(x, y, 16, 1); c.fillRect(x, y + 15, 16, 1);
    c.fillRect(x, y, 1, 16); c.fillRect(x + 15, y, 1, 16);
    // top + left edges read brighter (top-lit pane)
    c.fillStyle = '#dcecf2';
    c.fillRect(x, y, 16, 1); c.fillRect(x, y, 1, 16);
    // a couple of broken inner-border ticks, like the real texture
    c.fillStyle = '#c2dee6';
    c.fillRect(x + 4, y + 1, 1, 1); c.fillRect(x + 11, y + 14, 1, 1);
    c.fillRect(x + 1, y + 9, 1, 1); c.fillRect(x + 14, y + 5, 1, 1);
    // bright top-left corner glint
    c.fillStyle = '#ffffff';
    c.fillRect(x + 1, y + 1, 3, 1); c.fillRect(x + 1, y + 1, 1, 3);
    // signature diagonal reflection streak across the pane
    for (let i = 0; i < 5; i++) c.fillRect(x + 11 - i, y + 3 + i, 1, 1);
    c.fillStyle = '#cfe8ef';
    for (let i = 0; i < 3; i++) c.fillRect(x + 12 - i, y + 4 + i, 1, 1);
  },
  table_top: (c, x, y) => {
    const p = planksPx(OAK_R, OAK_SEAM, 115);
    const frame = hex('#5a4225'), lit = hex('#c9ab74');
    for (let i = 0; i < 16; i++) { p.set(i, 0, frame); p.set(0, i, frame); p.set(i, 15, frame); p.set(15, i, frame); }
    for (let i = 1; i < 15; i++) { p.set(i, 1, lit); p.set(1, i, lit); }
    // 3x3 crafting grid scored into the top
    for (let i = 2; i < 14; i++) for (const g of [5, 10]) { p.set(i, g, frame); p.set(g, i, frame); }
    p.put(c, x, y);
  },
  table_side: (c, x, y) => {
    const p = planksPx(OAK_R, OAK_SEAM, 116);
    for (let j = 0; j < 3; j++) for (let i = 0; i < 16; i++) p.set(i, j, j === 0 ? '#c9ab74' : j === 2 ? '#4a3620' : '#7a5c34');
    // hanging saw + hammer
    const tools = [
      '................', '................', '................', '................',
      '..ss.......hh...', '..sS......hHHh..', '..sS.......Wh...', '..sS.......W....',
      '..sS.......W....', '..sS.......W....', '..sS.......W....', '..ww.......W....',
      '..ww............', '................', '................', '................',
    ];
    const tp: Record<string, string> = { s: '#8a8a8a', S: '#c8c8c8', w: '#5e4020', h: '#4a4a4a', H: '#9a9a9a', W: '#6e4c26' };
    for (let j = 0; j < 16; j++) for (let i = 0; i < 16; i++) { const ch = tools[j][i]; if (ch !== '.' && tp[ch]) p.set(i, j, tp[ch]); }
    p.put(c, x, y);
  },
  table_front: (c, x, y) => {
    const p = planksPx(OAK_R, OAK_SEAM, 117);
    for (let j = 0; j < 3; j++) for (let i = 0; i < 16; i++) p.set(i, j, j === 0 ? '#c9ab74' : j === 2 ? '#4a3620' : '#7a5c34');
    const tools = [
      '................', '................', '................', '................',
      '...ccc......p...', '..c...c....pPp..', '..c...c.....W...', '...ccc......W...',
      '....W.......W...', '....W......pPp..', '....W.......W...', '....W.......W...',
      '...WW...........', '................', '................', '................',
    ];
    const tp: Record<string, string> = { c: '#9a9a9a', W: '#6e4c26', p: '#5e5e5e', P: '#b0b0b0' };
    for (let j = 0; j < 16; j++) for (let i = 0; i < 16; i++) { const ch = tools[j][i]; if (ch !== '.' && tp[ch]) p.set(i, j, tp[ch]); }
    p.put(c, x, y);
  },
  furnace_top: (c, x, y) => furnaceStonePx(118, true).put(c, x, y),
  furnace_side: (c, x, y) => furnaceStonePx(119, false).put(c, x, y),
  furnace_front: (c, x, y) => furnaceFrontPx(false).put(c, x, y),
  furnace_front_on: (c, x, y) => furnaceFrontPx(true).put(c, x, y),
  coal_ore: (c, x, y) => oreTile(c, x, y, 218, ['#4c4c4c', '#2a2a2a', '#141414'], true),
  iron_ore: (c, x, y) => oreTile(c, x, y, 318, ['#f1d9c4', '#d8af93', '#a4775a'], true),
  gold_ore: (c, x, y) => oreTile(c, x, y, 418, ['#fffab0', '#fcdd3a', '#c4901a']),
  diamond_ore: (c, x, y) => oreTile(c, x, y, 518, ['#d6fff8', '#4aedd9', '#1d9f96']),
  amethyst_ore: (c, x, y) => {
    const p = stonePx(101);
    // small faceted amethyst crystals embedded in the stone (highlight -> shadow)
    const hi = hex('#e2cbff'), mid = hex('#a97ee6'), lo = hex('#5f3f92');
    for (const [gx, gy, s] of [[3, 3, 0], [10, 2, 1], [6, 8, 2], [12, 9, 1], [2, 12, 3], [10, 13, 0]] as const) {
      oreBlob(p, gx, gy, [['.#', '##'], ['#', '#'], ['#.', '##', '.#'], ['##']][s], hi, mid, lo);
    }
    p.put(c, x, y);
  },
  gravel: (c, x, y) => {
    const v = voronoi(119, 15, 1);
    const cols = pal(['#8c8784', '#7a7571', '#9d9894', '#827d79', '#a39e99', '#877468', '#78797a', '#95908b']);
    const r = mulberry32(219);
    const tone = Array.from({ length: 15 }, () => cols[(r() * cols.length) | 0]);
    const p = new Px().fill((px, py) => shade(tone[cellAt(v, px, py)], 0.95 + r() * 0.1));
    bevelRegions(p, v, 1.12, 0.86, hex('#5a5652'));
    p.put(c, x, y);
  },
  sandstone_top: (c, x, y) => sandPx(120, pal(['#cdbf86', '#d5c891', '#dbcf9a', '#e0d5a2', '#e5dba9'])).put(c, x, y),
  sandstone_side: (c, x, y) => {
    const ramp = pal(['#bdb07a', '#cbbe86', '#d4c790', '#dbcf99', '#e1d6a2', '#e8dfae']);
    const p = sandPx(121, ramp);
    // smooth cap band on top, layered strata below, rough foot at the base
    for (let i = 0; i < 16; i++) {
      p.set(i, 0, ramp[5]); p.set(i, 1, ramp[4]); p.set(i, 2, ramp[4]); p.set(i, 3, ramp[1]);
      p.mul(i, 4, 0.92);
      if ((i * 7) % 5 < 2) p.set(i, 8, ramp[2]);
      p.set(i, 12, ramp[1]); p.set(i, 13, ramp[3]);
      p.set(i, 15, ramp[0]);
    }
    p.put(c, x, y);
  },
  stone_bricks: (c, x, y) => bricksPx(STONE_R, hex('#4a4a4a'), 16, 8, 122, 1.14, 0.84).put(c, x, y),
  wool: (c, x, y) => {
    // woven fibres: a diagonal weave pattern in soft whites
    const ramp = pal(['#cfcfcf', '#dadada', '#e3e3e3', '#ececec', '#f5f5f5']);
    const n = tileNoise(123, 8);
    const r = mulberry32(223);
    new Px().fill((px, py) => {
      const weave = ((px + (py >> 1) * 2) & 3) < 2 ? 0.14 : -0.06;
      return ramp[clampI((n(px, py) * 0.7 + 0.15 + weave + (r() - 0.5) * 0.3) * ramp.length, ramp.length)];
    }).put(c, x, y);
  },
  iron_block: (c, x, y) => metalPx(pal(['#8e8e8e', '#a8a8a8', '#c6c6c6', '#d6d6d6', '#e2e2e2', '#f2f2f2', '#ffffff']), 124).put(c, x, y),
  gold_block: (c, x, y) => metalPx(pal(['#b07e12', '#d19c1c', '#f0c22c', '#f8d43c', '#fde154', '#fff08a', '#fffbd0']), 125).put(c, x, y),
  diamond_block: (c, x, y) => metalPx(pal(['#1b9d94', '#2fc2b6', '#50dccf', '#62e9d8', '#7ff0e2', '#b0f8ee', '#e6fffb']), 126).put(c, x, y),
  tnt_top: (c, x, y) => {
    const p = new Px().fill((px, py) => ((px + py) & 3) === 0 ? '#8e2418' : '#b3382b');
    for (let j = 3; j <= 12; j++) for (let i = 3; i <= 12; i++) p.set(i, j, j === 3 || i === 3 ? '#efe6c8' : j === 12 || i === 12 ? '#a89c7a' : '#d8cba3');
    for (let j = 6; j <= 9; j++) for (let i = 6; i <= 9; i++) p.set(i, j, '#3a2a1a');
    p.set(6, 6, '#1e140a'); p.set(9, 9, '#5a4a36');
    p.put(c, x, y);
  },
  tnt_side: (c, x, y) => {
    // bundle of red sticks (vertical banding) with the paper wrapper
    const p = new Px().fill((px) => {
      const s = px % 4;
      return s === 0 ? '#e0584a' : s === 3 ? '#8a2016' : '#b3382b';
    });
    for (let j = 5; j <= 10; j++) for (let i = 0; i < 16; i++) p.set(i, j, j === 5 ? '#f2ead0' : j === 10 ? '#b0a37e' : '#ddd0aa');
    p.put(c, x, y);
    c.fillStyle = '#1f1f1f';
    c.fillRect(x + 2, y + 6, 3, 1); c.fillRect(x + 3, y + 6, 1, 4);
    c.fillRect(x + 6, y + 6, 1, 4); c.fillRect(x + 9, y + 6, 1, 4); c.fillRect(x + 7, y + 7, 1, 1); c.fillRect(x + 8, y + 8, 1, 1);
    c.fillRect(x + 11, y + 6, 3, 1); c.fillRect(x + 12, y + 6, 1, 4);
  },
  // full bed top (icon / held item): red blanket with a white pillow at one end
  bed_top: (c, x, y) => {
    noiseFill(c, x, y, ['#b02e2e', '#a02828', '#bd3737'], 126, 0);
    c.fillStyle = '#ededed'; c.fillRect(x + 2, y + 1, 12, 5);
    c.fillStyle = '#cfcfcf'; c.fillRect(x + 2, y + 5, 12, 1);
  },
  // foot half top: red quilted blanket, seams in a 2x2 quilt grid
  bed_foot_top: (c, x, y) => {
    noiseFill(c, x, y, ['#b02e2e', '#a02828', '#bd3737'], 126, 0);
    c.fillStyle = 'rgba(122,26,26,0.55)';
    c.fillRect(x + 7, y, 2, 16); c.fillRect(x, y + 7, 16, 2);
    c.fillStyle = 'rgba(214,96,96,0.30)';                     // lit side of each seam
    c.fillRect(x + 6, y, 1, 16); c.fillRect(x, y + 6, 16, 1);
  },
  // head half top: the white pillow over the outer 11/16 (low v) at full bed
  // width, matching the raised pillow box in Mesher.emitBed exactly. The mesher
  // rotates this by `facing` so the pillow always points away from the foot half.
  bed_head_top: (c, x, y) => {
    noiseFill(c, x, y, ['#b02e2e', '#a02828', '#bd3737'], 126, 0);
    c.fillStyle = 'rgba(122,26,26,0.55)'; c.fillRect(x, y + 13, 16, 1); // blanket seam
    noiseFill(c, x, y, ['#ededed', '#e7e7e7', '#f4f4f4'], 134, 0);      // pillow body
    c.fillStyle = '#b02e2e'; c.fillRect(x, y + 11, 16, 5);              // blanket below it
    c.fillStyle = 'rgba(122,26,26,0.55)'; c.fillRect(x, y + 13, 16, 1);
    c.fillStyle = '#f8f8f6'; c.fillRect(x + 1, y, 14, 4);               // top-lit crown
    c.fillStyle = '#cdcdc8'; c.fillRect(x, y + 9, 16, 2);               // shaded fold
    c.fillStyle = 'rgba(198,198,192,0.5)'; c.fillRect(x + 7, y + 1, 1, 9); // centre crease
  },
  // bed leg: a small solid oak post (cleaner than plank lines at leg scale)
  bed_leg: (c, x, y) => {
    noiseFill(c, x, y, ['#6b4f2a', '#5e4524', '#735730'], 131, 0);
    c.fillStyle = 'rgba(255,236,194,0.20)'; c.fillRect(x, y, 16, 3);
    c.fillStyle = 'rgba(0,0,0,0.24)'; c.fillRect(x, y + 13, 16, 3);
  },
  // soft white pillow: top-lit with a faint seam, for the bed's head end
  pillow: (c, x, y) => {
    noiseFill(c, x, y, ['#ededed', '#e6e6e6', '#f4f4f4'], 134, 0);
    c.fillStyle = '#f8f8f8'; c.fillRect(x, y, 16, 2);
    c.fillStyle = '#d6d6d6'; c.fillRect(x, y + 14, 16, 2);
    c.fillStyle = 'rgba(200,200,200,0.5)'; c.fillRect(x + 7, y, 1, 16); // centre crease
  },
  // mattress side: red blanket with a brighter top edge and a darker base seam
  bed_side: (c, x, y) => {
    noiseFill(c, x, y, ['#b02e2e', '#a02828', '#bd3737'], 126, 0);
    c.fillStyle = '#c64141'; c.fillRect(x, y, 16, 2);       // lit top edge
    c.fillStyle = '#7e1f1f'; c.fillRect(x, y + 14, 16, 2);  // shaded lower seam
  },
  torch: (c, x, y) => {
    // stick lives in columns 7-8 from row 6 down; the mesher crops exactly that
    c.clearRect(x, y, 16, 16);
    for (let py = 8; py < 16; py++) {
      c.fillStyle = py % 3 === 0 ? '#7a5a2e' : '#a07a44'; c.fillRect(x + 7, y + py, 1, 1);
      c.fillStyle = py % 3 === 1 ? '#4a3418' : '#6e4f28'; c.fillRect(x + 8, y + py, 1, 1);
    }
    c.fillStyle = '#ffe98a'; c.fillRect(x + 7, y + 6, 2, 2);
    c.fillStyle = '#fffbe0'; c.fillRect(x + 7, y + 6, 1, 1);
    c.fillStyle = '#ffb030'; c.fillRect(x + 8, y + 7, 1, 1);
    c.fillStyle = '#e0701c'; c.fillRect(x + 7, y + 8, 2, 1);
  },
  chest_top: (c, x, y) => chestPx('top').put(c, x, y),
  chest_side: (c, x, y) => chestPx('side').put(c, x, y),
  chest_front: (c, x, y) => chestPx('front').put(c, x, y),
  birch_log_side: (c, x, y) => {
    const p = barkPx(pal(['#b8b5a8', '#c6c3b6', '#d0cdc1', '#d9d6cb', '#e2e0d6', '#eceae2']), 331);
    // black lenticel scars, lit edge above, soft grey fringe at the ends
    const r = mulberry32(431);
    for (let i = 0; i < 9; i++) {
      const sx = (r() * 16) | 0, sy = (r() * 16) | 0, w = 2 + ((r() * 4) | 0), h = r() < 0.3 ? 2 : 1;
      for (let j = 0; j < h; j++) for (let k = 0; k < w; k++) p.set(sx + k, sy + j, j === 0 && (k === 0 || k === w - 1) ? '#5a5850' : '#2c2b26');
      p.set(sx - 1, sy, '#8f8c82'); p.set(sx + w, sy, '#8f8c82');
    }
    p.put(c, x, y);
  },
  birch_log_top: (c, x, y) => ringsPx(pal(['#8f8c82', '#d0cdc1', '#dcd9ce', '#e6e4db']),
    pal(['#a8966a', '#c6b584', '#d4c392', '#e0d1a2']), 332).put(c, x, y),
  spruce_log_side: (c, x, y) => barkPx(pal(['#22170b', '#2c1e0f', '#362613', '#402e18', '#4b371d', '#564023']), 333).put(c, x, y),
  spruce_log_top: (c, x, y) => ringsPx(pal(['#22170b', '#362613', '#402e18', '#4b371d']),
    pal(['#5e4527', '#765a35', '#84663d', '#907246']), 334).put(c, x, y),
  birch_leaves: (c, x, y) => leavesPx(pal(['#3e6a28', '#4b7a31', '#588a3a', '#669a44', '#75aa50', '#85b95e']), 435, 48, 0.5).put(c, x, y),
  spruce_leaves: (c, x, y) => leavesPx(pal(['#152a1a', '#1d3824', '#26462d', '#2f5436', '#3a6240', '#46704b']), 436, 44, 0.5).put(c, x, y),
  jungle_log_side: (c, x, y) => {
    const p = barkPx(pal(['#3c2c12', '#4a3717', '#57421d', '#644d23', '#71582a', '#7e6431']), 337);
    // mossy flecks climbing the trunk
    const r = mulberry32(437);
    for (let i = 0; i < 8; i++) p.set((r() * 16) | 0, (r() * 16) | 0, r() < 0.5 ? '#4e6b24' : '#5f7d2c');
    p.put(c, x, y);
  },
  jungle_log_top: (c, x, y) => ringsPx(pal(['#3c2c12', '#57421d', '#644d23', '#71582a']),
    pal(['#8f6a3a', '#a57c47', '#b48a52', '#c0975d']), 338).put(c, x, y),
  jungle_leaves: (c, x, y) => {
    const p = leavesPx(pal(['#164a14', '#1d5b1a', '#246c20', '#2d7e27', '#38902f', '#46a23a']), 439, 58, 0.35);
    // a few broad sunlit leaves
    const r = mulberry32(539);
    for (let i = 0; i < 4; i++) { const lx = (r() * 16) | 0, ly = (r() * 16) | 0; p.set(lx, ly, '#62b84a'); p.set(lx + 1, ly, '#52a83e'); }
    p.put(c, x, y);
  },
  poppy: (c, x, y) => {
    c.clearRect(x, y, 16, 16);
    pixmap(c, x, y, [
      '................', '................', '......rRR.......', '.....rRLRR......',
      '.....RRRRr......', '.....rRdRr......', '......rrr.......', '.......G........',
      '.......G.g......', '.......GGg......', '......gG........', '.....gGG........',
      '.......G........', '.......g........', '................', '................',
    ], { R: '#d43a2a', r: '#a8221a', L: '#ff7a5e', d: '#3a1410', G: '#4f8f2e', g: '#2f6a1e' });
  },
  dandelion: (c, x, y) => {
    c.clearRect(x, y, 16, 16);
    pixmap(c, x, y, [
      '................', '................', '................', '......yYY.......',
      '.....yYLLY......', '.....YLLYy......', '......yYy.......', '.......G........',
      '.......G........', '.......G.g......', '......gGG.......', '.......G........',
      '......gG........', '.......g........', '................', '................',
    ], { Y: '#f2d23a', y: '#c9a41c', L: '#fff38a', G: '#4f8f2e', g: '#2f6a1e' });
  },
  tall_grass: (c, x, y) => {
    c.clearRect(x, y, 16, 16);
    const rand = mulberry32(337);
    const cols = ['#2f5e20', '#3f7a2a', '#4c8c32', '#5a9e3a', '#68ae44', '#7cc052'];
    // a tuft: short blades behind, tall arching ones in front, shaded dark at
    // the root and catching light toward the tips
    for (let pass = 0; pass < 2; pass++) {
      const n = pass === 0 ? 8 : 11;
      for (let i = 0; i < n; i++) {
        const bx = 1 + ((rand() * 14) | 0);
        const h = pass === 0 ? 3 + ((rand() * 6) | 0) : 6 + ((rand() * 9) | 0);
        const lean = rand() < 0.5 ? -1 : 1;
        const bend = 0.45 + rand() * 0.35; // where the blade starts to arch over
        for (let j = 0; j < h; j++) {
          const t = j / h;
          const px = bx + (t > bend ? lean : 0) + (t > bend + 0.3 ? lean : 0);
          const k = Math.min(cols.length - 1, ((t * 4.2) | 0) + pass);
          c.fillStyle = cols[k];
          c.fillRect(x + Math.max(0, Math.min(15, px)), y + 15 - j, 1, 1);
        }
      }
    }
  },
  cactus_side: (c, x, y) => {
    const rand = mulberry32(338);
    for (let px = 0; px < 16; px++) {
      for (let py = 0; py < 16; py++) {
        const rib = px % 4 === 1;
        const r = rand();
        c.fillStyle = px === 0 || px === 15 ? '#0c5418'
          : rib ? (r < 0.7 ? '#0f6420' : '#1a7a2e')
          : px % 4 === 2 ? (r < 0.75 ? '#27a344' : '#35b552')
          : (r < 0.75 ? '#1a8a35' : r < 0.9 ? '#27a344' : '#0f6420');
        c.fillRect(x + px, y + py, 1, 1);
      }
    }
    // paired spines with a dark socket
    c.fillStyle = '#0a3a12';
    for (const [sx, sy] of [[3, 2], [9, 6], [5, 11], [13, 13], [11, 1]]) c.fillRect(x + sx, y + sy + 1, 1, 1);
    c.fillStyle = '#e8f0d8';
    for (const [sx, sy] of [[3, 2], [9, 6], [5, 11], [13, 13], [11, 1]]) c.fillRect(x + sx, y + sy, 1, 1);
  },
  cactus_top: (c, x, y) => {
    const p = new Px().fill((px, py) => {
      const d = Math.max(Math.abs(px - 7.5), Math.abs(py - 7.5));
      return d > 6.5 ? '#0c5418' : d > 5.5 ? '#1a8a35' : (px + py) % 3 === 0 ? '#35b552' : '#27a344';
    });
    for (const [sx, sy] of [[4, 4], [11, 4], [4, 11], [11, 11], [7, 7]]) p.set(sx, sy, '#e8f0d8');
    p.put(c, x, y);
  },
  sugar_cane: (c, x, y) => {
    c.clearRect(x, y, 16, 16);
    const rand = mulberry32(340);
    for (const [bx, off] of [[3, 0], [7, 2], [11, 1]]) {
      for (let py = 0; py < 16; py++) {
        const joint = (py + off) % 5 === 4;
        c.fillStyle = joint ? '#6b8a42' : rand() < 0.7 ? '#a4c872' : '#b4d884';
        c.fillRect(x + bx, y + py, 1, 1);
        c.fillStyle = joint ? '#5a7636' : '#86ab58';
        c.fillRect(x + bx + 1, y + py, 1, 1);
        if (joint && rand() < 0.5) { c.fillStyle = '#7fae4a'; c.fillRect(x + bx + 2, y + py - 1, 1, 1); }
      }
    }
  },
  farmland_top: (c, x, y) => {
    // tilled, moist soil: dark furrows with lit ridges
    const ramp = pal(['#2e1d0e', '#3b2614', '#48301b', '#553a22', '#62452a']);
    const f = fbm(341, [[8, 0.5], [16, 0.5]], 1.4);
    const p = rampFill(new Px(), ramp, f, 342, 0.4);
    for (const row of [0, 4, 8, 12]) {
      for (let i = 0; i < 16; i++) { p.set(i, row, ramp[4]); p.set(i, row + 3, ramp[0]); }
    }
    for (let i = 0; i < 16; i++) { p.set(0, i, shade(p.get(0, i), 1.15)); p.set(15, i, shade(p.get(15, i), 0.8)); }
    p.put(c, x, y);
  },
  wheat_0: (c, x, y) => {
    c.clearRect(x, y, 16, 16);
    const rand = mulberry32(342);
    for (const bx of [2, 5, 8, 11, 14]) {
      const h = 3 + ((rand() * 3) | 0);
      for (let j = 0; j < h; j++) {
        c.fillStyle = j === h - 1 ? '#7ab84a' : j < 1 ? '#3a6a22' : '#4f8a2e';
        c.fillRect(x + bx, y + 15 - j, 1, 1);
      }
    }
  },
  wheat_1: (c, x, y) => {
    c.clearRect(x, y, 16, 16);
    const rand = mulberry32(343);
    for (const bx of [1, 4, 7, 10, 13]) {
      const h = 7 + ((rand() * 4) | 0);
      for (let j = 0; j < h; j++) {
        c.fillStyle = j > h - 3 ? '#9ab84a' : j < 2 ? '#3f7a26' : '#5d9b33';
        c.fillRect(x + bx, y + 15 - j, 1, 1);
      }
      c.fillStyle = '#6fa838';
      c.fillRect(x + bx + 1, y + 15 - ((h * 0.6) | 0), 1, 2);
    }
  },
  wheat_2: (c, x, y) => {
    c.clearRect(x, y, 16, 16);
    const rand = mulberry32(344);
    for (const bx of [1, 4, 7, 10, 13]) {
      const h = 11 + ((rand() * 4) | 0);
      for (let j = 0; j < h; j++) {
        c.fillStyle = j > h - 5 ? '#d8b649' : j < 3 ? '#8a7a30' : '#b09a3a';
        c.fillRect(x + bx, y + 15 - j, 1, 1);
      }
      // plump grain head: lit kernels on the left, shaded on the right
      const hx = x + bx - 1 + ((rand() * 2) | 0), hy = y + 16 - h;
      c.fillStyle = '#f0d872'; c.fillRect(hx, hy, 1, 4);
      c.fillStyle = '#d4ae42'; c.fillRect(hx + 1, hy, 1, 4);
      c.fillStyle = '#a8842a'; c.fillRect(hx + 1, hy + 3, 1, 1);
    }
  },
  carrot_0: (c, x, y) => cropTile(c, x, y, 472, '#4f8a2e', '#6fa838', '#d87825', 0),
  carrot_1: (c, x, y) => cropTile(c, x, y, 473, '#4f8a2e', '#6fa838', '#d87825', 1),
  carrot_2: (c, x, y) => cropTile(c, x, y, 474, '#5d9b33', '#7abf45', '#e8952f', 2),
  potato_0: (c, x, y) => cropTile(c, x, y, 475, '#4d8a38', '#6aa84f', '#b68a45', 0),
  potato_1: (c, x, y) => cropTile(c, x, y, 476, '#4d8a38', '#6aa84f', '#b68a45', 1),
  potato_2: (c, x, y) => cropTile(c, x, y, 477, '#5a9a3a', '#7abf45', '#c9a05a', 2),
  beetroot_0: (c, x, y) => cropTile(c, x, y, 478, '#4f8a33', '#6aa84f', '#8a1f45', 0),
  beetroot_1: (c, x, y) => cropTile(c, x, y, 479, '#4f8a33', '#6aa84f', '#a42a55', 1),
  beetroot_2: (c, x, y) => cropTile(c, x, y, 480, '#5d9b3d', '#7abf45', '#c03060', 2),
  sapling: (c, x, y) => {
    c.clearRect(x, y, 16, 16);
    pixmap(c, x, y, [
      '................', '.......l........', '.....lLLl.......', '....lLLDLLl.....',
      '...dLLLLDLLd....', '...LLDLLLLLL....', '....dLLDLLd.....', '.....dLLLd......',
      '......dTLd......', '.......T........', '.......Tt.......', '......tT........',
      '.......Tt.......', '.......T........', '................', '................',
    ], { L: '#4a962e', l: '#6cb848', D: '#2f6b1e', d: '#285a18', T: '#7a5a30', t: '#5a4020' });
  },
  ladder: (c, x, y) => {
    c.clearRect(x, y, 16, 16);
    // two side rails + rungs, each lit on top and shaded underneath
    for (let py = 0; py < 16; py++) {
      c.fillStyle = '#8a6a3a'; c.fillRect(x + 1, y + py, 1, 1); c.fillRect(x + 13, y + py, 1, 1);
      c.fillStyle = '#5e4524'; c.fillRect(x + 2, y + py, 1, 1); c.fillRect(x + 14, y + py, 1, 1);
    }
    for (const ry of [1, 5, 9, 13]) {
      c.fillStyle = '#b08a52'; c.fillRect(x + 1, y + ry, 14, 1);
      c.fillStyle = '#8a6a3a'; c.fillRect(x + 3, y + ry + 1, 10, 1);
      c.fillStyle = '#4a361e'; c.fillRect(x + 3, y + ry + 2, 10, 1);
    }
  },
  door_lower: (c, x, y) => doorPx(false).put(c, x, y),
  door_upper: (c, x, y) => doorPx(true).put(c, x, y),
  door_top: (c, x, y) => {
    // thin cap shown at the seam between halves
    c.fillStyle = '#6e5230'; c.fillRect(x, y, 16, 16);
    c.fillStyle = '#8a6a3e'; c.fillRect(x, y, 16, 1);
    c.fillStyle = '#4a3620'; c.fillRect(x, y + 15, 16, 1);
  },
  trapdoor: (c, x, y) => {
    const p = planksPx(OAK_R, OAK_SEAM, 346);
    const frame = hex('#5a4225');
    for (let i = 0; i < 16; i++) { p.set(i, 0, frame); p.set(0, i, frame); p.set(i, 15, frame); p.set(15, i, frame); }
    // two hatch windows
    for (const [wx, wy] of [[3, 3], [9, 3], [3, 9], [9, 9]]) {
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) p.clear(wx + i, wy + j);
      for (let i = 0; i < 4; i++) { p.set(wx + i, wy - 1, '#4a3620'); p.set(wx - 1, wy + i, '#4a3620'); }
    }
    for (const [bx, by] of [[1, 1], [14, 1], [1, 14], [14, 14]]) p.set(bx, by, '#3f3f3f');
    p.put(c, x, y);
  },
};

/** Furnace shell: smooth stone plate with a lit rim (top has a darker inner ring). */
function furnaceStonePx(seed: number, top: boolean): Px {
  const ramp = pal(['#5a5a5a', '#686868', '#747474', '#7e7e7e', '#888888', '#949494']);
  const f = fbm(seed, [[8, 0.5], [16, 0.5]], 1.4);
  const p = rampFill(new Px(), ramp, f, seed + 1, 0.4);
  for (let i = 0; i < 16; i++) {
    p.set(i, 0, ramp[5]); p.set(0, i, ramp[5]); p.set(i, 15, ramp[0]); p.set(15, i, ramp[0]);
  }
  if (top) {
    for (let i = 3; i < 13; i++) { p.set(i, 3, ramp[0]); p.set(3, i, ramp[0]); p.set(i, 12, ramp[5]); p.set(12, i, ramp[5]); }
  } else {
    for (let i = 1; i < 15; i++) { p.set(i, 5, ramp[1]); p.set(i, 6, ramp[4]); }
  }
  return p;
}

function furnaceFrontPx(lit: boolean): Px {
  const p = furnaceStonePx(120, false);
  // the firebox mouth: dark recess, iron lintel, grate bars
  for (let j = 8; j <= 13; j++) for (let i = 3; i <= 12; i++) p.set(i, j, '#141414');
  for (let i = 3; i <= 12; i++) { p.set(i, 7, '#3a3a3a'); p.set(i, 14, '#9a9a9a'); }
  for (let j = 7; j <= 14; j++) { p.set(2, j, '#3a3a3a'); p.set(13, j, '#9a9a9a'); }
  // small smoke vent up top
  for (let i = 5; i <= 10; i++) { p.set(i, 2, '#2a2a2a'); p.set(i, 3, '#1a1a1a'); }
  if (lit) {
    const r = mulberry32(117);
    for (let i = 4; i <= 11; i++) {
      const h = 2 + ((r() * 4) | 0);
      for (let k = 0; k < h; k++) p.set(i, 13 - k, k === h - 1 ? '#ffe070' : k === h - 2 ? '#ffae2e' : '#e0621a');
    }
    for (let i = 4; i <= 11; i++) p.set(i, 13, '#fff0a0');
  } else {
    for (let i = 4; i <= 11; i += 2) p.set(i, 13, '#2a2a2a');
  }
  return p;
}

function lampPx(lit: boolean): Px {
  const frame = lit ? pal(['#5a3418', '#7a4c24', '#9a6632']) : pal(['#2a1a0e', '#3e2816', '#523620']);
  const glow = lit ? pal(['#d8822a', '#f0a840', '#fcca62', '#ffe6a0', '#fff8dc']) : pal(['#4a3018', '#5a3c20', '#6a4828', '#7a5430', '#8a6038']);
  const f = fbm(lit ? 7011 : 7010, [[4, 0.5], [8, 0.5]], 1.8);
  const p = rampFill(new Px(), glow, f, 7012, 0.3);
  // wooden-framed lamp: outer frame and a cross of mullions dividing four panes
  for (let i = 0; i < 16; i++) {
    for (const k of [0, 15]) { p.set(i, k, frame[1]); p.set(k, i, frame[1]); }
    for (const k of [7, 8]) { p.set(i, k, frame[k === 7 ? 2 : 0]); p.set(k, i, frame[k === 7 ? 2 : 0]); }
  }
  for (let i = 1; i < 15; i++) { p.set(i, 1, frame[0]); p.set(1, i, frame[0]); p.set(i, 14, frame[2]); p.set(14, i, frame[2]); }
  return p;
}

function chestPx(face: 'top' | 'side' | 'front'): Px {
  const ramp = pal(['#6e4a22', '#7e5628', '#8e6230', '#9c6e38', '#a87a40', '#b48648']);
  const f = fbm(face === 'top' ? 130 : 131, [[4, 0.5, 16], [8, 0.5, 16]], 1.5);
  const p = rampFill(new Px(), ramp, f, 132, 0.3);
  const rim = hex('#3a2610');
  for (let i = 0; i < 16; i++) { p.set(i, 0, rim); p.set(0, i, rim); p.set(i, 15, rim); p.set(15, i, rim); }
  for (let i = 1; i < 15; i++) { p.set(i, 1, ramp[5]); p.set(1, i, ramp[4]); p.set(14, i, ramp[0]); }
  if (face !== 'top') {
    // lid seam
    for (let i = 1; i < 15; i++) { p.set(i, 5, rim); p.set(i, 6, ramp[5]); }
  }
  if (face === 'front') {
    // iron latch hanging from the lid
    for (let j = 3; j <= 8; j++) for (let i = 7; i <= 8; i++) p.set(i, j, j === 3 ? '#e4e4e4' : j === 8 ? '#5e5e5e' : '#b8b8b8');
    p.set(6, 4, '#2a2a2a'); p.set(9, 4, '#2a2a2a'); for (let j = 4; j <= 8; j++) { p.set(6, j, '#2a2a2a'); p.set(9, j, '#2a2a2a'); }
    p.set(7, 9, '#2a2a2a'); p.set(8, 9, '#2a2a2a');
  }
  return p;
}

function doorPx(upper: boolean): Px {
  const p = planksPx(OAK_R, OAK_SEAM, 345);
  const frame = hex('#5a4225'), lit = hex('#c2a36c'), dark = hex('#4a3620');
  for (let j = 0; j < 16; j++) { p.set(0, j, frame); p.set(15, j, frame); p.set(1, j, lit); p.set(14, j, dark); }
  if (upper) {
    for (let i = 0; i < 16; i++) p.set(i, 0, frame);
    // two small glass panes
    for (const wx of [3, 9]) {
      for (let j = 3; j <= 8; j++) for (let i = 0; i < 4; i++) p.set(wx + i, j, j === 3 ? '#e2f0f4' : i === 0 ? '#c4dde6' : '#a7c9d4');
      for (let i = -1; i < 5; i++) { p.set(wx + i, 2, dark); p.set(wx + i, 9, lit); }
      p.set(wx - 1, 5, dark);
    }
  } else {
    for (let i = 0; i < 16; i++) p.set(i, 15, frame);
    // raised panel
    for (let j = 3; j <= 12; j++) for (let i = 3; i <= 12; i++) {
      if (j === 3 || i === 3) p.set(i, j, lit); else if (j === 12 || i === 12) p.set(i, j, dark);
    }
    // iron handle near the top of the lower half (waist height)
    p.set(12, 0, '#b0b0b0'); p.set(12, 1, '#6a6a6a'); p.set(11, 1, '#2a2a2a'); p.set(13, 1, '#2a2a2a');
  }
  return p;
}

// crack_0 .. crack_9: a fracture web spreading out from the centre, like the
// vanilla destroy stages. Every stage replays the same branches and reveals
// pixels in order of their distance along the crack, so cracks only grow.
const CRACK_PTS: [number, number, number][] = (() => {
  const rand = mulberry32(900);
  const pts: [number, number, number][] = []; // x, y, reveal order (0..1)
  const seen = new Set<number>();
  const walk = (x: number, y: number, ang: number, len: number, t0: number, depth: number): void => {
    for (let i = 0; i < len; i++) {
      ang += (rand() - 0.5) * 0.6;
      x += Math.cos(ang); y += Math.sin(ang);
      const px = Math.round(x), py = Math.round(y);
      if (px < 0 || py < 0 || px > 15 || py > 15) return;
      const t = t0 + (i / len) * (1 - t0) * (depth ? 0.9 : 1);
      if (!seen.has(py * 16 + px)) { seen.add(py * 16 + px); pts.push([px, py, t]); }
      if (depth < 2 && rand() < 0.22) walk(x, y, ang + (rand() < 0.5 ? 1 : -1) * (0.7 + rand() * 0.6), 3 + ((rand() * 5) | 0), t, depth + 1);
    }
  };
  const arms = 6;
  for (let k = 0; k < arms; k++) {
    const ang = (k / arms) * Math.PI * 2 + (rand() - 0.5) * 0.6;
    walk(7.5, 7.5, ang, 10 + ((rand() * 4) | 0), 0, 0);
  }
  return pts;
})();
for (let stage = 0; stage < 10; stage++) {
  TILE_PAINTERS[`crack_${stage}`] = (c, x, y) => {
    c.clearRect(x, y, 16, 16);
    const reach = (stage + 1) / 10;
    for (const [px, py, t] of CRACK_PTS) {
      if (t > reach) continue;
      c.fillStyle = t < reach - 0.25 ? 'rgba(12,10,8,0.8)' : 'rgba(12,10,8,0.55)';
      c.fillRect(x + px, y + py, 1, 1);
    }
  };
}

// ---------------------------------------------------------------------------
// Item sprites (16x16 pixel maps)
// ---------------------------------------------------------------------------

/** Paint rows + palette into a Px ('.' / ' ' / unknown chars stay clear). */
function spritePx(rows: string[], colors: Record<string, string>, into = new Px()): Px {
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      const col = colors[rows[y][x]];
      if (col) into.set(x, y, col);
    }
  }
  return into;
}

/**
 * Vanilla-style item outline: every clear pixel touching paint (4-way) takes
 * a deep shade of the paint it borders, so outlines keep the item's hue
 * (dark teal round diamond, dark brown round wood) instead of flat black.
 */
function outlinePx(p: Px, k = 0.3): Px {
  const src = p.copy();
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      if (src.a(x, y) > 0) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx > 15 || ny > 15 || src.a(nx, ny) === 0) continue;
        const c = src.get(nx, ny); r += c[0]; g += c[1]; b += c[2]; n++;
      }
      if (n) p.set(x, y, [r / n * k, g / n * k, b / n * k]);
    }
  }
  return p;
}

/**
 * Build a sprite in diagonal tool space: a = x - y runs along the handle
 * (bottom-left -> top-right), c = x + y runs across it (15 = centre line).
 * `fn` returns a palette key or null for each pixel.
 */
function diagPx(fn: (a: number, c: number) => string | null, colors: Record<string, string>): Px {
  const p = new Px();
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const k = fn(x - y, x + y);
      if (k && colors[k]) p.set(x, y, colors[k]);
    }
  }
  return p;
}

// Tool tiers: L highlight, M body, m shade, d deep shade; H/h handle wood.
// (O = legacy dark outline, kept so older hand-outlined pixmaps still paint)
type ToolMat = { L: string; M: string; m: string; d: string; H: string; h: string; O: string };
const HANDLE = { H: '#9c7440', h: '#664722', O: '#241b10' };
const WOOD: ToolMat = { L: '#caa870', M: '#a8864e', m: '#846638', d: '#634a26', ...HANDLE };
const STONEC: ToolMat = { L: '#b4b4b4', M: '#929292', m: '#727272', d: '#555555', ...HANDLE };
const IRONC: ToolMat = { L: '#ffffff', M: '#dcdcdc', m: '#aeaeae', d: '#828282', ...HANDLE };
const DIAMONDC: ToolMat = { L: '#c4fff6', M: '#52efdb', m: '#2cbcb0', d: '#1a8c84', ...HANDLE };

/** Diagonal stick from the bottom-left corner up to `top` along the axis. */
const stick = (a: number, c: number, top: number): string | null =>
  a >= -13 && a <= top ? (c === 15 ? 'H' : c === 16 ? 'h' : null) : null;

/** Tool = diagonal haft up to `top` along the axis, with a head map laid over it. */
function toolPx(m: ToolMat, top: number, head: string[]): Px {
  const p = diagPx((a, c) => stick(a, c, top), { ...m });
  return outlinePx(spritePx(head, { ...m }, p));
}

// crescent head bowed back toward the grip, tips at top-left + bottom-right
const PICK_HEAD = [
  '................', '...MLLLLL.......', '..dMMMMMMLL.....', '.........MMLL...',
  '...........mL...', '............mM..', '............mM..', '.............mM.',
  '.............mM.', '.............mM.', '.............mM.', '.............mM.',
  '.............md.', '.............d..', '................', '................',
];
// broad bit on the upper-left of the haft, keen edge lit
const AXE_HEAD = [
  '................', '......LLLL......', '.....LMMMMmm....', '....LMMMMMmm....',
  '....LMMMMmm.....', '.....LMMmm......', '......Lmm.......', '................',
];
// rounded spade capping the haft
const SHOVEL_HEAD = [
  '................', '...........LL...', '..........LMMM..', '.........LMMMmm.',
  '.........LMMmm..', '..........Mmm...', '................',
];
// flat blade jutting left from the haft top, hooked down at its tip
const HOE_HEAD = [
  '................', '.......LLLLLL...', '......LMMMMMMm..', '......Mm........',
  '......m.........', '................',
];
const pickaxePx = (m: ToolMat): Px => toolPx(m, 6, PICK_HEAD);
const axePx = (m: ToolMat): Px => toolPx(m, 10, AXE_HEAD);
const shovelPx = (m: ToolMat): Px => toolPx(m, 4, SHOVEL_HEAD);
const hoePx = (m: ToolMat): Px => toolPx(m, 10, HOE_HEAD);

function swordPx(m: ToolMat): Px {
  return outlinePx(diagPx((a, c) => {
    // blade: lit edge, bright ridge, shaded edge; tapers to a point
    if (a >= -1 && a <= 13 && c >= 14 && c <= 16) {
      if (a >= 12 && c !== 15) return null;
      return c === 14 ? 'L' : c === 15 ? (a > 10 ? 'L' : 'M') : 'm';
    }
    if (a >= -3 && a <= -2 && c >= 11 && c <= 20) return c <= 12 || c >= 19 ? 'd' : 'm'; // crossguard
    if (a >= -10 && a <= -4 && (c === 15 || c === 16)) return c === 15 ? 'H' : 'h';     // grip
    if (a >= -12 && a <= -11 && c >= 14 && c <= 17) return 'd';                          // pommel
    return null;
  }, { ...m }));
}

// Armor: O = outline, L = highlight, M = main metal/leather, m = shade
const LEATHERAC = { O: '#2e1a0c', L: '#b0744a', M: '#8e5a34', m: '#6a4024' };
const IRONAC = { O: '#3a3a3a', L: '#f4f4f4', M: '#cfcfcf', m: '#9a9a9a' };
const DIAMONDAC = { O: '#12433f', L: '#b0fff2', M: '#5be0d4', m: '#2fa89e' };
const HELMET_MAP = [
  '................',
  '................',
  '.....OOOOOO.....',
  '...OOLLLLLMOO...',
  '..OLLMMMMMMMmO..',
  '..OLMMMMMMMMmO..',
  '..OLMmMMMMMmmO..',
  '..OLMMMMMMMMmO..',
  '..OLMOOOOOOMmO..',
  '..OLmO....OMmO..',
  '..OOO......OOO..',
  '................',
  '................',
  '................',
  '................',
  '................',
];
const CHEST_MAP = [
  '................',
  '..OOO......OOO..',
  '.OLLMO....OMMmO.',
  '.OLMMMOOOOMMMmO.',
  '.OLMMMLLLLMMMmO.',
  '.OOLMMMMMMMMmOO.',
  '..OLMMMMMMMMmO..',
  '..OLMMmMMmMMmO..',
  '..OLMMMMMMMMmO..',
  '..OLMMMMMMMMmO..',
  '..OLMMMMMMMMmO..',
  '..OLmmmmmmmmmO..',
  '..OOOOOOOOOOOO..',
  '................',
  '................',
  '................',
];
const LEGS_MAP = [
  '................',
  '................',
  '..OOOOOOOOOOOO..',
  '..OLLLLLLLLLMO..',
  '..OLMmMMMMmMmO..',
  '..OLMMOOOOMMmO..',
  '..OLMMO..OLMmO..',
  '..OLMMO..OLMmO..',
  '..OLMMO..OLMmO..',
  '..OLMMO..OLMmO..',
  '..OLMMO..OLMmO..',
  '..OLmmO..OLmmO..',
  '..OOOOO..OOOOO..',
  '................',
  '................',
  '................',
];
const BOOTS_MAP = [
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '..OOOO..OOOO....',
  '..OLMO..OLMO....',
  '..OLMO..OLMO....',
  '..OLMO..OLMO....',
  '..OLMOOO.OLMOOO.',
  '..OLMMMMOOLMMMMO',
  '..OmmmmmO.OmmmmO',
  '..OOOOOOO.OOOOOO',
  '................',
];

// Bucket: lit rim ellipse over a tapered pail; `k` is whatever it holds.
const BUCKET_ROWS = [
  '................',
  '................',
  '................',
  '....LLLLLLLL....',
  '...LkkkkkkkkL...',
  '...MLkkkkkkLm...',
  '...MMLLLLLLmm...',
  '...LMMMMMMMMm...',
  '....LMMMMMMm....',
  '....LMMmMMMm....',
  '....LMMMMMMm....',
  '.....MMMMMm.....',
  '.....mmmmmm.....',
  '................',
  '................',
  '................',
];
const BUCKET_METAL = { L: '#ececec', M: '#bcbcbc', m: '#838383' };
function bucketPx(inner: string[], glint?: string): Px {
  const p = spritePx(BUCKET_ROWS, { ...BUCKET_METAL, k: inner[0] });
  // a little surface shading in the bucket mouth
  for (let x = 5; x <= 10; x++) p.set(x, 4, inner[1] ?? inner[0]);
  if (glint) { p.set(6, 4, glint); p.set(7, 4, glint); p.set(9, 5, glint); }
  return outlinePx(p, 0.32);
}

const ITEM_PAINTERS: Record<string, (ctx: Ctx) => void> = {
  bucket: (c) => bucketPx(['#3c3c3c', '#2a2a2a']).put(c, 0, 0),
  water_bucket: (c) => bucketPx(['#2f5fd8', '#4a7ae8'], '#9ab8ff').put(c, 0, 0),
  lava_bucket: (c) => bucketPx(['#e0561a', '#f8962a'], '#ffe070').put(c, 0, 0),
  leather_helmet: (c) => pixmap(c, 0, 0, HELMET_MAP, LEATHERAC),
  leather_chest: (c) => pixmap(c, 0, 0, CHEST_MAP, LEATHERAC),
  leather_legs: (c) => pixmap(c, 0, 0, LEGS_MAP, LEATHERAC),
  leather_boots: (c) => pixmap(c, 0, 0, BOOTS_MAP, LEATHERAC),
  iron_helmet: (c) => pixmap(c, 0, 0, HELMET_MAP, IRONAC),
  iron_chest: (c) => pixmap(c, 0, 0, CHEST_MAP, IRONAC),
  iron_legs: (c) => pixmap(c, 0, 0, LEGS_MAP, IRONAC),
  iron_boots: (c) => pixmap(c, 0, 0, BOOTS_MAP, IRONAC),
  diamond_helmet: (c) => pixmap(c, 0, 0, HELMET_MAP, DIAMONDAC),
  diamond_chest: (c) => pixmap(c, 0, 0, CHEST_MAP, DIAMONDAC),
  diamond_legs: (c) => pixmap(c, 0, 0, LEGS_MAP, DIAMONDAC),
  diamond_boots: (c) => pixmap(c, 0, 0, BOOTS_MAP, DIAMONDAC),
  stick: (c) => outlinePx(diagPx((a, cc) => (a >= -11 && a <= 11 ? (cc === 15 ? 'H' : cc === 16 ? 'h' : null) : null), HANDLE)).put(c, 0, 0),
  // a faceted lump: lit upper-left facets, a glassy glint, shadowed underside
  coal: (c) => outlinePx(spritePx([
    '................', '................', '......hhh.......', '....hhwhKKK.....',
    '...hwhKKKKKK....', '..hhKKKKKKKKK...', '..hKKKhKKKKKk...', '.hKKKhwhKKKKk...',
    '.hKKKKhKKKKkk...', '.KKKKKKKKKkkk...', '..KKKKKKkkkk....', '...kKKkkkkk.....',
    '.....kkkk.......', '................', '................', '................',
  ], { h: '#565656', w: '#8c8c8c', K: '#303030', k: '#1c1c1c' }), 0.45).put(c, 0, 0),
  wood_pickaxe: (c) => pickaxePx(WOOD).put(c, 0, 0),
  wood_axe: (c) => axePx(WOOD).put(c, 0, 0),
  wood_shovel: (c) => shovelPx(WOOD).put(c, 0, 0),
  wood_sword: (c) => swordPx(WOOD).put(c, 0, 0),
  stone_pickaxe: (c) => pickaxePx(STONEC).put(c, 0, 0),
  stone_axe: (c) => axePx(STONEC).put(c, 0, 0),
  stone_shovel: (c) => shovelPx(STONEC).put(c, 0, 0),
  stone_sword: (c) => swordPx(STONEC).put(c, 0, 0),
  iron_pickaxe: (c) => pickaxePx(IRONC).put(c, 0, 0),
  iron_axe: (c) => axePx(IRONC).put(c, 0, 0),
  iron_shovel: (c) => shovelPx(IRONC).put(c, 0, 0),
  iron_sword: (c) => swordPx(IRONC).put(c, 0, 0),
  diamond_pickaxe: (c) => pickaxePx(DIAMONDC).put(c, 0, 0),
  diamond_axe: (c) => axePx(DIAMONDC).put(c, 0, 0),
  diamond_shovel: (c) => shovelPx(DIAMONDC).put(c, 0, 0),
  diamond_sword: (c) => swordPx(DIAMONDC).put(c, 0, 0),
  flint_and_steel: (c) => outlinePx(spritePx([
    '................', '................', '.........SSSS...', '........Sssss S.',
    '........S....sS.', '.............sS.', '.............sS.', '............sS..',
    '..FFF...........', '.FfFFF..........', '.FFFfFF.........', '.FFFFFg.........',
    '..FFFgg.........', '...ggg..........', '................', '................',
  ], { S: '#e4e4e4', s: '#9a9a9a', F: '#4e4e56', f: '#74747e', g: '#34343a' })).put(c, 0, 0),
  quartz: (c) => outlinePx(spritePx([
    '................', '................', '................', '.........LW.....',
    '........LWQq....', '.......LWQQq....', '......LWQQqq....', '.....LQQQQq.....',
    '....LQQQQqq.....', '....QQQQqq......', '...QQQqqq.......', '...QQqq.........',
    '....qq..........', '................', '................', '................',
  ], { W: '#ffffff', L: '#f4efea', Q: '#ddd4cd', q: '#b3a69e' }), 0.45).put(c, 0, 0),
  nether_brick: (c) => outlinePx(spritePx([
    '................', '................', '................', '................',
    '.....TTTTTTTTT..', '....TTLTTTTTTSs.', '...FFFFFFFFFFss.', '...FlFFFFFFfFs..',
    '...FFFFFfFFFFs..', '...FFfFFFFFFs...', '...ddddddddd....', '................',
    '................', '................', '................', '................',
  ], { T: '#6a2e36', L: '#84404a', F: '#4c1e25', f: '#3a151b', l: '#5e2a31', S: '#2e1014', s: '#240c10', d: '#2a0e12' })).put(c, 0, 0),
  redstone: (c) => outlinePx(spritePx([
    '................', '................', '................', '.......r........',
    '......rRr.......', '....r.RLR.r.....', '...rRRRRRRRr....', '..rRRLRRRRRRr...',
    '..RRRRRRRLRRR...', '.rRRRRRRRRRRRr..', '.RRLRRRRRRRRRR..', '..RRRRRRRRRRr...',
    '...rrRRRRRrr....', '................', '................', '................',
  ], { R: '#e8201a', L: '#ff8870', r: '#a8100c' }), 0.35).put(c, 0, 0),
  iron_ingot: (c) => pixmap(c, 0, 0, [
    '................', '................', '................', '................',
    '................', '....OOOOOOO.....', '...OLLLLLLMO....', '..OLLMMMMMMMO...',
    '..OLMMMMMMMmO...', '.OMMMMMMMmmO....', '.OMmmmmmmmmO....', '..OOOOOOOOO.....',
    '................', '................', '................', '................',
  ], { O: '#3f3f3f', M: '#d8d8d8', m: '#a8a8a8', L: '#efefef' }),
  gold_ingot: (c) => pixmap(c, 0, 0, [
    '................', '................', '................', '................',
    '................', '....OOOOOOO.....', '...OLLLLLLMO....', '..OLLMMMMMMMO...',
    '..OLMMMMMMMmO...', '.OMMMMMMMmmO....', '.OMmmmmmmmmO....', '..OOOOOOOOO.....',
    '................', '................', '................', '................',
  ], { O: '#5d4a10', M: '#f5d93f', m: '#c7a51e', L: '#fcee8a' }),
  diamond: (c) => pixmap(c, 0, 0, [
    '................', '................', '................', '.....OOOOO......',
    '....OLLLLDO.....', '...OLLMMMDDO....', '...OLMMMMMDO....', '...ODMMMMMDO....',
    '....ODMMMDO.....', '.....ODMDO......', '......ODO.......', '.......O........',
    '................', '................', '................', '................',
  ], { O: '#1f5f5a', M: '#4aedd9', D: '#33c7c2', L: '#a5f4ea' }),
  flint: (c) => pixmap(c, 0, 0, [
    '................', '................', '................', '.....OOOO.......',
    '....OGGGGO......', '...OGGgGGGO.....', '...OGGGGGGGO....', '....OGGgGGGO....',
    '.....OGGGGO.....', '......OGGO......', '.......OO.......', '................',
    '................', '................', '................', '................',
  ], { O: '#1a1a1a', G: '#3f3f44', g: '#5a5a60' }),
  feather: (c) => pixmap(c, 0, 0, [
    '................', '..........OO....', '........OOWWO...', '.......OWWWWO...',
    '......OWWWWWO...', '.....OWWWWWO....', '....OWWWWWWO....', '....OWWWWWO.....',
    '...OWWWWWO......', '...OWWWWO.......', '..OWWWWO........', '..OHWWO.........',
    '..OHO...........', '.OHO............', '................', '................',
  ], { O: '#5d5d6a', W: '#f4f4f8', H: '#c8a868' }),
  // a loose coil of string: a doubled strand with a lit and a shaded side
  string: (c) => outlinePx(spritePx([
    '................', '...........WW...', '..........Ws.W..', '.........Ws..Ws.',
    '....WWs..Ws..Ws.', '...Ws.sWWs..Ws..', '...Ws..sW..Ws...', '....Ws..sWWs....',
    '.....WWs..Ws....', '.........Ws.....', '........Ws......', '.......Ws.......',
    '......Ws........', '.....Ws.........', '....Ws..........', '................',
  ], { W: '#f6f6f6', s: '#bdbdc4' }), 0.4).put(c, 0, 0),
  gunpowder: (c) => outlinePx(spritePx([
    '................', '................', '................', '......g.g.......',
    '.....gKgKg......', '....KKgKKKgK....', '...KKKKgKKKKK...', '...KgKKKKKKgK...',
    '..KKKKKgKKKKKK..', '..KKgKKKKKgKKK..', '...KKKKKKKKKK...', '....kkkkkkkk....',
    '................', '................', '................', '................',
  ], { K: '#4a4a4a', g: '#7e7e7e', k: '#303030' }), 0.4).put(c, 0, 0),
  arrow: (c) => outlinePx(diagPx((a, cc) => {
    if (a >= 7 && a <= 12 && Math.abs(cc - 15.5) <= (12.5 - a) * 0.75) return cc <= 15 ? 'L' : 'm'; // flint head
    if (a >= -12 && a <= -7 && (cc === 13 || cc === 14 || cc === 17 || cc === 18)) return cc < 15 ? 'F' : 'f'; // fletching
    if (a >= -13 && a <= 6 && (cc === 15 || cc === 16)) return cc === 15 ? 'H' : 'h';
    return null;
  }, { L: '#d8d8d8', m: '#8a8a8a', F: '#ffffff', f: '#cfcfcf', ...HANDLE })).put(c, 0, 0),
  bow: (c) => bowSprite(c, -1),
  // Minecraft's three draw frames: the string pulls back toward the lower right
  // and the nocked arrow slides with it (swapped in by the held-bow draw pose)
  bow_pulling_0: (c) => bowSprite(c, 0),
  bow_pulling_1: (c) => bowSprite(c, 1),
  bow_pulling_2: (c) => bowSprite(c, 2),
  mutton: (c) => meatSprite(c, '#d8555f', '#e88a92'),
  cooked_mutton: (c) => meatSprite(c, '#8a4a28', '#b5713f'),
  beef: (c) => steakPx(false).put(c, 0, 0),
  cooked_beef: (c) => steakPx(true).put(c, 0, 0),
  seeds: (c) => seedsPx('#6fa33a', '#a4d45e', '#3f6a1c').put(c, 0, 0),
  wheat: (c) => outlinePx(spritePx([
    '................', '............gG..', '..........gGGg..', '.........GgGg...',
    '........GGgG....', '.......gGGg.....', '......GgGs......', '.....gGgs.......',
    '....sgss........', '...sss..........', '..sss...........', '.ss.............',
    '.s..............', '................', '................', '................',
  ], { G: '#e8c85a', g: '#c09a32', s: '#a88a3a' }), 0.4).put(c, 0, 0),
  bread: (c) => outlinePx(spritePx([
    '................', '................', '................', '..........LLL...',
    '........LLCLLL..', '......LLCLLCLb..', '....LLCLLCLLbb..', '...LCLLCLLLbbB..',
    '..LLLLCLLLbbBB..', '..LLCLLLbbBBB...', '..LLLLbbbBBB....', '..bbbbbBBB......',
    '...BBBBB........', '................', '................', '................',
  ], { L: '#d8a458', C: '#f0cc86', b: '#a8702e', B: '#7a4e1e' }), 0.35).put(c, 0, 0),
  carrot: (c) => pixmap(c, 0, 0, [
    '................', '......GG.G......', '.....GGGG.......', '......GG........',
    '......OO........', '.....OLLO.......', '.....OLLO.......', '....OLLLO.......',
    '....OLLLO.......', '...OLLLLO.......', '...OLLLLO.......', '..OLLLLO........',
    '..OLLOO.........', '...OO...........', '................', '................',
  ], { O: '#7a3a10', L: '#e88724', G: '#4f9a38' }),
  golden_carrot: (c) => pixmap(c, 0, 0, [
    '................', '......GG.G......', '.....GGGG.......', '......GG........',
    '......OO........', '.....OLLO.......', '.....OLLO.......', '....OLLLO.......',
    '....OLLLO.......', '...OLLLLO.......', '...OLLLLO.......', '..OLLLLO........',
    '..OLLOO.........', '...OO...........', '................', '................',
  ], { O: '#8a5a10', L: '#ffd83d', G: '#6fa838' }),
  potato: (c) => pixmap(c, 0, 0, [
    '................', '................', '................', '.....OOOO.......',
    '....OBBBBO......', '...OBBbBBBO.....', '...OBBBBBBO.....', '..OBBBbBBBBO....',
    '..OBBBBBBBBO....', '...OBBBbBBO.....', '....OBBBBO......', '.....OOOO.......',
    '................', '................', '................', '................',
  ], { O: '#5d3a1f', B: '#b88a4a', b: '#8f6839' }),
  baked_potato: (c) => pixmap(c, 0, 0, [
    '................', '................', '................', '.....OOOO.......',
    '....OCCCCO......', '...OCCcCCCO.....', '...OCCCCCCO.....', '..OCCCcCCCCO....',
    '..OCCCCCCCCO....', '...OCCCcCCO.....', '....OCCCCO......', '.....OOOO.......',
    '................', '................', '................', '................',
  ], { O: '#3a2010', C: '#d0a05a', c: '#f0c06a' }),
  beetroot: (c) => pixmap(c, 0, 0, [
    '................', '......GG........', '.....GGGG.......', '......GG........',
    '.....ORRO.......', '....ORRRRO......', '...ORRLRRO......', '...ORRRRRO......',
    '....ORRRO.......', '.....ORO........', '......O.........', '................',
    '................', '................', '................', '................',
  ], { O: '#3a0a18', R: '#a82048', L: '#d84a70', G: '#4f9a38' }),
  beetroot_seeds: (c) => seedsPx('#c8ab78', '#ecd6a4', '#8a6e44').put(c, 0, 0),
  bowl: (c) => pixmap(c, 0, 0, [
    '................', '................', '................', '................',
    '................', '..OOOOOOOOOO....', '..OHHHHHHHHO....', '...OHHHHHHO.....',
    '...OHHHHHHO.....', '....OHHHHO......', '.....OOOO.......', '................',
    '................', '................', '................', '................',
  ], { O: '#4a2f14', H: '#9c6f3a' }),
  beetroot_soup: (c) => pixmap(c, 0, 0, [
    '................', '................', '................', '................',
    '..OOOOOOOOOO....', '..ORRRLRRRRO....', '..ORRRRRRRRO....', '...OHHHHHHO.....',
    '...OHHHHHHO.....', '....OHHHHO......', '.....OOOO.......', '................',
    '................', '................', '................', '................',
  ], { O: '#4a2f14', H: '#9c6f3a', R: '#a82048', L: '#d84a70' }),
  vegetable_stew: (c) => pixmap(c, 0, 0, [
    '................', '................', '................', '................',
    '..OOOOOOOOOO....', '..OSCGCSPSSO....', '..OPSSBCSSSO....', '...OHHHHHHO.....',
    '...OHHHHHHO.....', '....OHHHHO......', '.....OOOO.......', '................',
    '................', '................', '................', '................',
  ], { O: '#4a2f14', H: '#9c6f3a', S: '#b86a32', C: '#e88724', P: '#d0a05a', B: '#a82048', G: '#4f9a38' }),
  hoe: (c) => hoePx(WOOD).put(c, 0, 0),
  rotten_flesh: (c) => pixmap(c, 0, 0, [
    '................', '................', '...OOO..OOO.....', '..ORRROORGRO....',
    '..ORGRRRRRRO....', '.ORRRRGRRRRRO...', '.ORRGRRRRGRRO...', '.ORRRRRGRRRO....',
    '..ORGRRRRRO.....', '...OORRGROO.....', '.....OOOO.......', '................',
    '................', '................', '................', '................',
  ], { O: '#2a1a10', R: '#9c5a3a', G: '#6b8a3a' }),
  apple: (c) => outlinePx(spritePx([
    '................', '........s.......', '.......s.gG.....', '.......sgGG.....',
    '....rRRsRRr.....', '...rRLLRRRRr....', '..rRLWLRRRRRr...', '..rRLLRRRRRRr...',
    '..rRRRRRRRRdr...', '..rRRRRRRRRdr...', '..rRRRRRRRddr...', '...rRRRRRRdr....',
    '....rRRdRRdr....', '.....rr.rrr.....', '................', '................',
  ], { R: '#d62c28', r: '#a81c1a', L: '#f26a5c', W: '#ffd2c8', d: '#86121a', s: '#5a3a1a', g: '#4f9a30', G: '#7cc44c' }), 0.35).put(c, 0, 0),
  wood_door: (c) => {
    // tall door icon: draw two stacked panels
    const rail = '#9c7f4e', dark = '#5d4222', light = '#b8945f', iron = '#3f3f3f';
    const rows: string[] = [];
    const map = 'OOOOOOOOOOOO....|OdddddddddO.....|.dmmmmmmd.O.....|.dmmmmmmd.O.....|.dmmmmmmd.O.....|.dmmmmmmd.O.....|.dmmmmmmd.O.....|OdddddddddO.....|.dmmmmmmd.O.....|.dmmmmmmd.O.....|.dmmmmmmd.O.....|.dmmmmmmd.O.....|.dmmmmmmd.O.....|Oddddddddd.O....|..........OO....|................';
    const pal: Record<string, string> = { O: dark, d: rail, m: light };
    for (const row of map.split('|')) {
      rows.push(row.padEnd(16, '.'));
    }
    pixmap(c, 0, 0, rows, pal);
    c.fillStyle = iron; c.fillRect(12, 8, 1, 1);
  },
  bone: (c) => outlinePx(diagPx((a, cc) => {
    const knob = Math.abs(a) >= 9 && Math.abs(a) <= 12 && cc >= 13 && cc <= 18 &&
      !(Math.abs(a) >= 11 && (cc === 15 || cc === 16));
    if (knob || (Math.abs(a) <= 10 && (cc === 15 || cc === 16))) return cc <= 14 ? 'L' : cc >= 17 ? 'd' : cc === 15 ? 'W' : 'w';
    return null;
  }, { L: '#ffffff', W: '#f0ead6', w: '#d4ccb2', d: '#b8ae94' }), 0.4).put(c, 0, 0),
  bone_meal: (c) => outlinePx(spritePx([
    '................', '................', '................', '................',
    '......W.W.......', '....W.WLW.W.....', '...WWWwWWWW.....', '..WWwWWLWwWW....',
    '..WLWWwWWWWW....', '..WWWWWWWwWWW...', '...wwWWWWWww....', '................',
    '................', '................', '................', '................',
  ], { W: '#ececec', w: '#c4c4c4', L: '#ffffff' }), 0.45).put(c, 0, 0),
  // a tanned hide: four splayed corners, lighter grain and a darker belly
  leather: (c) => outlinePx(spritePx([
    '................', '................', '..LL........LL..', '..LlLLLLLLLLlL..',
    '...LLlLLLlLLLL..', '...LLLLLLLLlL...', '..LLlLLdLLLLLL..', '..LLLLLddLLlLL..',
    '...LLLLdLLLLL...', '...LlLLLLLlLL...', '..LLLLLLLLLLLL..', '..LlLLLLLLLLlL..',
    '..LL........LL..', '................', '................', '................',
  ], { L: '#a8693a', l: '#c98a54', d: '#84512a' }), 0.4).put(c, 0, 0),
  // a leather riding saddle: raised pommel + cantle, dished seat, girth
  // straps and two iron stirrups hanging below
  saddle: (c) => outlinePx(spritePx([
    '................', '................', '................', '..BB........BB..',
    '..BbB......BbB..', '...BbBBBBBBbB...', '...BbbbbbbbbB...', '....BBBBBBBB....',
    '.....S....S.....', '.....S....S.....', '....MMM..MMM....', '....M.M..M.M....',
    '....MmM..MmM....', '................', '................', '................',
  ], { B: '#6e4222', b: '#9a6234', S: '#4a2c16', M: '#c4c4cc', m: '#8e8e98' }), 0.4).put(c, 0, 0),
  // iron horse armor: a plated horse head in profile (snout left, ear up,
  // neck guard sweeping down the right) with a dark eye slit
  horse_armor: (c) => outlinePx(spritePx([
    '................', '.........hh.....', '........hMhh....', '.......hMMMMh...',
    '.....hhMMMMMMh..', '...hhMMMKMMMMMh.', '..hMMMMMMMMMMMM.', '.hMMmMMMMMMMMMM.',
    '.MMmmMMMM.MMMMm.', '..mmmm....MMMMm.', '..........MMMMm.', '..........MMMMm.',
    '.........MMMMmm.', '.........mmmmm..', '................', '................',
  ], { h: '#eeeef2', M: '#c9c9d0', m: '#9a9aa4', K: '#2a2a30' }), 0.4).put(c, 0, 0),
  emerald: (c) => outlinePx(spritePx([
    '................', '................', '................', '.......L........',
    '......LWG.......', '.....LLGGG......', '....LGGGGgg.....', '....LGGGGgg.....',
    '....LGGGGgg.....', '....LGGGggg.....', '.....GGggg......', '......Ggg.......',
    '.......g........', '................', '................', '................',
  ], { L: '#8ff5b0', W: '#e4ffec', G: '#3fd878', g: '#1f9e4e' }), 0.3).put(c, 0, 0),
  fishing_rod: (c) => {
    const p = outlinePx(diagPx((a, cc) => {
      if (a < -13 || a > 12) return null;
      if (cc === 15) return a < -5 ? 'h' : 'H';
      if (cc === 16) return a < -5 ? 'd' : 'h';
      return null;
    }, { H: '#a07a44', h: '#6e4f28', d: '#4a3418' }));
    // line hangs from the tip to a little hook
    for (let y = 3; y <= 11; y++) p.set(14, y, '#dcdcdc');
    p.set(13, 12, '#9a9a9a'); p.set(13, 13, '#9a9a9a'); p.set(14, 13, '#9a9a9a'); p.set(15, 12, '#9a9a9a');
    p.put(c, 0, 0);
  },
  raw_fish: (c) => fishPx(false).put(c, 0, 0),
  cooked_fish: (c) => fishPx(true).put(c, 0, 0),
  compass: (c) => dialPx(pal(['#6e6e6e', '#a8a8a8', '#e0e0e0']), (p) => {
    // red north needle up-right, pale tail down-left, on a dark glass face
    for (const [x, y] of [[8, 7], [9, 6], [10, 5]]) p.set(x, y, '#e8322a');
    p.set(10, 4, '#ff7a60');
    for (const [x, y] of [[7, 8], [6, 9], [5, 10]]) p.set(x, y, '#d8d8d8');
    p.set(7, 7, '#2a2a2a'); p.set(8, 8, '#1a1a1a');
  }).put(c, 0, 0),
  clock: (c) => dialPx(pal(['#9c7414', '#e8c02c', '#fff08a']), (p) => {
    // day sky over the horizon, night below, sun + moon on the rotating dial
    for (let y = 3; y <= 12; y++) {
      for (let x = 3; x <= 12; x++) {
        if (Math.hypot(x - 7.5, y - 7.5) > 4.7) continue;
        p.set(x, y, y < 8 ? (y < 5 ? '#6aaaf0' : '#8cc4ff') : y < 10 ? '#26325a' : '#161e3a');
      }
    }
    p.set(6, 4, '#fff27a'); p.set(7, 4, '#ffd23a'); p.set(6, 5, '#ffd23a'); p.set(7, 5, '#e8a820');
    p.set(9, 10, '#f0f0f0'); p.set(10, 10, '#c8c8d8');
    for (let x = 3; x <= 12; x++) if (Math.hypot(x - 7.5, 0.5) <= 4.7) p.set(x, 8, '#4a7a2a');
  }).put(c, 0, 0),
  porkchop: (c) => chopPx(false).put(c, 0, 0),
  cooked_porkchop: (c) => chopPx(true).put(c, 0, 0),
  chicken: (c) => pixmap(c, 0, 0, [
    '................', '................', '.....OOOO.......', '....OPPPPO......',
    '...OPpppPPO.....', '...OPpppppO.....', '...OPpppppO.....', '....OPpppO......',
    '.....OPPOO......', '......OWO.......', '......OWO.......', '.....OWWWO......',
    '......OOO.......', '................', '................', '................',
  ], { O: '#5d3a2a', P: '#e8c8b8', p: '#f6e0d4', W: '#f2e3d5' }),
  cooked_chicken: (c) => pixmap(c, 0, 0, [
    '................', '................', '.....OOOO.......', '....OPPPPO......',
    '...OPpppPPO.....', '...OPpppppO.....', '...OPpppppO.....', '....OPpppO......',
    '.....OPPOO......', '......OWO.......', '......OWO.......', '.....OWWWO......',
    '......OOO.......', '................', '................', '................',
  ], { O: '#4a2a14', P: '#b5773a', p: '#d8a05a', W: '#f2e3d5' }),
  amethyst: (c) => pixmap(c, 0, 0, [
    '.......k........', '......khk.......', '......kahk......', '.....kaaAk......',
    '.....kaaAAk.....', '....kaaAAADk....', '....kaaAADDk....', '....kaaAADDk....',
    '....kaaAADDk....', '....kaAAADDk....', '.....kAADDk.....', '.....kADDDk.....',
    '......kDDk......', '.......kk.......', '................', '................',
  ], { k: '#2a1d44', h: '#f3ecff', a: '#c9a4ff', A: '#9a6fd6', D: '#5a3f86' }),
  mob_catcher: (c) => catcherShell(c),
  // generic fallback (a filled catcher always carries a mob kind in practice)
  mob_catcher_filled: (c) => filledCatcher(c, 'zombie'),
  mob_catcher_filled_zombie: (c) => filledCatcher(c, 'zombie'),
  mob_catcher_filled_skeleton: (c) => filledCatcher(c, 'skeleton'),
  mob_catcher_filled_spider: (c) => filledCatcher(c, 'spider'),
  mob_catcher_filled_creeper: (c) => filledCatcher(c, 'creeper'),
  mob_catcher_filled_cinderling: (c) => filledCatcher(c, 'cinderling'),
  mob_catcher_filled_ashstalker: (c) => filledCatcher(c, 'ashstalker'),
  mob_catcher_filled_emberghast: (c) => filledCatcher(c, 'emberghast'),
  mob_catcher_filled_phantom: (c) => filledCatcher(c, 'phantom'),
  // bed: a 3/4-view pixel bed (legs, red mattress, white pillow) — reads far
  // better in the hotbar than an isometric slice of the block tiles
  bed: (c) => bedSprite(c),
};

/** Generic meat chop sprite with palette colors. */
function meatSprite(c: Ctx, dark: string, light: string): void {
  pixmap(c, 0, 0, [
    '................', '................', '....OOOO........', '...OPPPPO.......',
    '..OPPpppPO......', '..OPpppppPO.....', '..OPpppppPO.....', '...OPpppPPO.....',
    '....OPPPPPO.....', '.....OPPPOO.....', '......OOOWO.....', '.........OWO....',
    '..........OWO...', '...........O....', '................', '................',
  ], { O: '#2a1410', P: dark, p: light, W: '#f2e3d5' });
}

/** Steak slab with a fat rim: raw marbled red, or seared brown with grill marks. */
function steakPx(cooked: boolean): Px {
  const rows = [
    '................', '................', '................', '.......FFFF.....',
    '.....FFRRRRFF...', '....FRRRWRRRRF..', '...FRRrRRRRRRF..', '...FRRRRRRWRRRF.',
    '..FRWRRRRRRRrRF.', '..FRRRRrRRRRRF..', '..FRRRRRRWRRF...', '...FRRRRRRRF....',
    '....FFRRRFFF....', '......FFF.......', '................', '................',
  ];
  const p = spritePx(rows, cooked
    ? { F: '#9c6a3a', R: '#6e3a1c', r: '#562a12', W: '#8a4c26' }
    : { F: '#f0d0c4', R: '#c83838', r: '#9c2222', W: '#f2a8a0' });
  if (cooked) {
    // diagonal grill marks seared across the meat (not the fat)
    for (let i = 0; i < 16; i++) {
      for (const k of [0, 5]) {
        const x = i, y = 15 - i + k - 4;
        if (p.a(x, y) && p.get(x, y)[0] < 130) p.set(x, y, '#3e1c0a');
      }
    }
  }
  return outlinePx(p, 0.35);
}

/** Cod: tapered body facing left, forked tail, lit back, pale belly and an eye. */
function fishPx(cooked: boolean): Px {
  const rows = [
    '................', '................', '................', '................',
    '.....bbbbb......', '...bbBBBBBbb..tt', '..bBeBBBBBBBbtTt', '.bBBBBBBBBBBBTTt',
    '.bLLLLLLLLLLbTTt', '..bLLLLLLLLbbtTt', '...bbLLLLbb...tt', '.....bbbb.......',
    '................', '................', '................', '................',
  ];
  return outlinePx(spritePx(rows, cooked
    ? { B: '#c08a4c', b: '#946430', L: '#e8c286', T: '#a8743e', t: '#7e5226', e: '#2a1a0e' }
    : { B: '#98b0c0', b: '#6e8898', L: '#e0dcc8', T: '#8098a8', t: '#5e7888', e: '#101418' }), 0.35);
}

/** Pork chop: teardrop cut with a fat rim and a round bone at the narrow end. */
function chopPx(cooked: boolean): Px {
  return outlinePx(spritePx([
    '................', '................', '................', '....FFFFF.......',
    '...FWWPPPFF.....', '..FWwWPPPPPF....', '..FWWPPpPPPPF...', '..FPPPPPPPpPF...',
    '...FPPpPPPPPPF..', '....FPPPPPPPPF..', '.....FPPPpPPF...', '......FFPPPF....',
    '........FFF.....', '................', '................', '................',
  ], cooked
    ? { F: '#c89a5a', P: '#a4643a', p: '#c4824c', W: '#ece0c4', w: '#c8b894' }
    : { F: '#f6dcd0', P: '#e27880', p: '#f4a4aa', W: '#f6eedc', w: '#d6c8aa' }), 0.35);
}

/** Round instrument (compass/clock): lit metal ring, dark face, then `face` paints the dial. */
function dialPx(ring: RGB[], face: (p: Px) => void): Px {
  const p = new Px();
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const d = Math.hypot(x - 7.5, y - 7.5);
      if (d > 6.3) continue;
      if (d > 4.9) {
        const lit = (7.5 - x) + (7.5 - y); // top-left catches the light
        p.set(x, y, ring[lit > 2 ? 2 : lit < -2 ? 0 : 1]);
      } else p.set(x, y, d > 4.2 ? '#2e2e36' : '#44444e');
    }
  }
  face(p);
  return outlinePx(p, 0.35);
}

/** A small scatter of two-tone seeds (light tip, dark base). */
function seedsPx(mid: string, hi: string, lo: string): Px {
  const p = new Px();
  for (const [x, y] of [[7, 3], [11, 5], [4, 7], [8, 9], [12, 10], [5, 12]]) {
    p.set(x, y, hi); p.set(x, y + 1, mid); p.set(x + 1, y + 1, lo);
  }
  return outlinePx(p, 0.4);
}

// A capture orb on a clean 14px disc, seen a little from above and lit from the
// upper left: a big clear glass dome (fresnel-dark rim, bright spec arc) over a
// dark metal band that curves down across the front to a round glowing button,
// and a polished amethyst base with a reflected-light rim. Filled orbs show the
// captive's face through the glass, tint the glass toward its colour and light
// the button to match. Shared by the empty + filled sprites.
const ORB_R = 7;
const ORB_L: RGB = [-0.5, -0.62, 0.6];
const ORB_OUT = '#1a1030';

/** Captive drawn through the dome: rows start at y=2, centred on x=7.5 (so a
 *  6-wide face covers x 5..10); only glass pixels take paint, so wider rows
 *  (legs, wings, a ghast's bulk) clip to the dome. `haze` tints the glass and
 *  lights the button. */
interface OrbOccupant { rows: string[]; pal: Record<string, string>; haze: string }
const ORB_OCCUPANTS: Record<string, OrbOccupant> = {
  // green head under dark hair, black eyes, the teal shirt collar at the chin
  zombie: {
    rows: ['hhhhhh', 'hGhGGh', 'GGGGGG', 'eeGGee', 'GgnngG', 'cccccc'],
    pal: { h: '#35592c', G: '#5f9e4e', g: '#4d8a3e', e: '#141414', n: '#3c6d31', c: '#2f9fa8' },
    haze: '#8fdc76',
  },
  // bone-white skull, hollow sockets, nose hole, a grin of teeth
  skeleton: {
    rows: ['sSSSSs', 'SSSSSS', 'eeSSee', 'SSnnSS', 'tStStS', '.ssss.'],
    pal: { S: '#e2dfd4', s: '#b4b1a8', e: '#1e1e1e', n: '#4c4a46', t: '#6e6c64' },
    haze: '#6a5c94',
  },
  // the creeper's black frown on mottled green
  creeper: {
    rows: ['cCCcCC', 'kkCCkk', 'kkCckk', 'CCkkCC', 'CkkkkC', 'CkCCkC'],
    pal: { C: '#5fc44c', c: '#48a53a', k: '#141414' },
    haze: '#9ae884',
  },
  // dark head, big red eyes, fangs, legs splayed out to the glass edge
  spider: {
    rows: ['..ssssss..', 'k.SrSSrS.k', 'kkRRSSRRkk', 'k.RRSSRR.k', 'kkSSSSSSkk', '..sfssfs..'],
    pal: { s: '#2e2429', S: '#43363d', k: '#231b1f', r: '#c8301e', R: '#ff4a30', f: '#d9c8aa' },
    haze: '#e0604a',
  },
  // grey-blue head with glowing green eyes, wings swept out to both sides
  phantom: {
    rows: ['...pPPp...', '.ppPPPPpp.', 'ppPPPPPPpp', '.pggPPggp.', '..PkkkkP..', '...pPPp...'],
    pal: { P: '#5a6e94', p: '#3d4c6a', g: '#a6ff80', k: '#161a24' },
    haze: '#a6f28e',
  },
  // charcoal imp: glowing ember horns, blazing eyes, molten grin
  cinderling: {
    rows: ['o....o', 'oCCCCo', 'CCCCCC', 'yyCCyy', 'CCCCCC', 'CooooC'],
    pal: { C: '#352b26', y: '#ffd24a', o: '#ff7a1a' },
    haze: '#ffa050',
  },
  // charred beast: pricked ears, ember-lit eyes, a wide glowing maw
  ashstalker: {
    rows: ['C....C', 'CCCCCC', 'CcCCcC', 'CyCCyC', 'cCCCCc', 'oooooo'],
    pal: { C: '#2b221e', c: '#6a2e14', y: '#ffc23a', o: '#ff6a10' },
    haze: '#ff8a3a',
  },
  // a hulking charcoal cube: blazing eyes, a big molten mouth, ember tendrils
  emberghast: {
    rows: ['CCCCCCCC', 'CCCCCCCC', 'CyyCCyyC', 'CCCCCCCC', 'CCoOOoCC', 'o.o..o.o'],
    pal: { C: '#2e2622', y: '#ffd24a', o: '#ff5a10', O: '#ffb040' },
    haze: '#ff7a30',
  },
};

function orbPx(occ?: OrbOccupant): Px {
  const p = new Px();
  const inDisc = (x: number, y: number): boolean => Math.hypot(x - 7.5, y - 7.5) <= ORB_R;
  const edge = (x: number, y: number): boolean =>
    !inDisc(x + 1, y) || !inDisc(x - 1, y) || !inDisc(x, y + 1) || !inDisc(x, y - 1);
  // the band sags toward the viewer: rows 7 at the rim down to 9 mid-front
  const bandTop = (x: number): number => {
    const u = (x - 7.5) / ORB_R;
    return Math.round(6 + 3 * Math.sqrt(Math.max(0, 1 - u * u)));
  };
  const ll = Math.hypot(ORB_L[0], ORB_L[1], ORB_L[2]);
  const haze = occ ? hex(occ.haze) : null;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      if (!inDisc(x, y)) continue;
      if (edge(x, y)) { p.set(x, y, ORB_OUT); continue; }
      const nx = (x - 7.5) / ORB_R, ny = (y - 7.5) / ORB_R;
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      const lam = Math.max(0, (nx * ORB_L[0] + ny * ORB_L[1] + nz * ORB_L[2]) / ll);
      const rim = 1 - nz;
      const bt = bandTop(x);
      if (y < bt) {
        // glass: bright where it faces the light, darker toward the thick rim
        let c: RGB = hex(lam > 0.78 ? '#f1ebff' : lam > 0.5 ? '#d7c9f4' : '#b7a0e2');
        if (rim > 0.55) c = hex('#9579cc');
        // the far half of the band, seen faintly through the clear glass
        const u = (x - 7.5) / ORB_R;
        if (y === Math.round(8.2 - 2.4 * Math.sqrt(Math.max(0, 1 - u * u)))) c = mixC(c, hex('#4f4066'), 0.3);
        // a full orb's glass is smokier, so the captive stands out against it
        if (haze) c = mixC(shade(c, 0.78), haze, 0.3);
        p.set(x, y, c);
      } else if (y < bt + 2) {
        // band: lit top edge, shadowed lower edge, fading to the right
        const base = hex(y === bt ? '#4f4066' : '#261d34');
        p.set(x, y, shade(base, x < 5 ? 1.15 : x > 10 ? 0.8 : 1));
      } else {
        // amethyst base: four tones + a reflected-light rim at the lower right
        let c = hex(lam > 0.72 ? '#b58cf0' : lam > 0.5 ? '#8f63cf' : lam > 0.28 ? '#6a48a4' : '#4a3278');
        if (rim > 0.6 && nx + ny > 0.7) c = hex('#7a58b6');
        p.set(x, y, c);
      }
    }
  }
  // the captive's face through the glass (never over the outline or band)
  if (occ) {
    occ.rows.forEach((row, r) => {
      const x0 = Math.round(8 - row.length / 2);
      for (let i = 0; i < row.length; i++) {
        const col = occ.pal[row[i]];
        const x = x0 + i, y = 2 + r;
        if (col && y < bandTop(x) && inDisc(x, y) && !edge(x, y)) p.set(x, y, col);
      }
    });
  }
  // glass specular arc at the upper left (+ a far glint on the empty orb)
  p.set(4, 3, '#ffffff'); p.set(3, 4, '#ffffff'); p.set(3, 5, '#e9e2fb');
  if (!occ) { p.set(5, 2, '#ffffff'); p.set(11, 4, '#f6f2ff'); }
  // amethyst base gloss
  p.set(3, 11, '#d9c4ff'); p.set(4, 12, '#c7a8fa');
  // button: a dark ring set into the band, glowing core (captive-coloured when full)
  for (const y of [9, 10]) { p.set(6, y, '#120a1c'); p.set(9, y, '#120a1c'); }
  for (const x of [7, 8]) { p.set(x, 8, '#120a1c'); p.set(x, 11, '#120a1c'); }
  const glow = haze ?? hex('#e8dcff');
  p.set(7, 9, mixC(glow, [255, 255, 255], 0.75));
  p.set(8, 9, mixC(glow, [255, 255, 255], 0.35));
  p.set(7, 10, glow);
  p.set(8, 10, shade(glow, 0.72));
  return p;
}

/** Empty mob catcher: the bare capture orb. */
function catcherShell(c: Ctx): void {
  orbPx().put(c, 0, 0);
}

/** Filled mob catcher: the orb with its captive's face showing through the dome. */
function filledCatcher(c: Ctx, kind: string): void {
  orbPx(ORB_OCCUPANTS[kind] ?? ORB_OCCUPANTS.zombie).put(c, 0, 0);
}

/** Bed item sprite: a 3/4 view — the quilted top recedes as a parallelogram
 *  over a red blanket side, a plump white pillow at the head end, the oak
 *  frame rail and four stubby legs (the far two peek out behind). */
function bedSprite(c: Ctx): void {
  pixmap(c, 0, 0, [
    '................',
    '................',
    '................',
    '.....kkkkkkkkkk.',
    '....kWWkRRRRRRRk',
    '...kWwwkRrRRRrRk',
    '..kWwwWkRRRrRRk.',
    '.kWWWWkRRRRRRRk.',
    '.kPPPPkBSSSSSSk.',
    '.kppppkbsssssSk.',
    '.kFFFFFFFFFFFFk.',
    '.kffffffffffffk.',
    '.kLkkk.....kLkk.',
    '.kLLk......kLLk.',
    '..kk........kk..',
    '................',
  ], {
    k: '#2a1a12',               // dark outline
    W: '#e4e4de', w: '#fbfbf7', // pillow top (shade + lit)
    P: '#cfcfc8', p: '#b4b4ae', // pillow side
    R: '#c23a3a', r: '#dc5454', // blanket top with brighter quilt stitches
    B: '#9c2828', b: '#842020', // blanket fold where it meets the pillow
    S: '#a62c2c', s: '#8a2222', // blanket side in shadow
    F: '#9a7444', f: '#76562e', // oak frame rail
    L: '#6a4c28',               // legs
  });
}

/** Bow sprite: the stave arcs around the upper left with the string on the
 *  anti-diagonal. `stage` -1 is the idle bow; 0..2 are the draw frames, where
 *  the string is pulled to a point toward the lower right and a nocked arrow
 *  lies along the draw line with its flint head just past the grip. */
function bowSprite(c: Ctx, stage: number): void {
  pixmap(c, 0, 0, [
    '................', '......OHHO......', '....OHHhhHO.....', '...OHhO..OHO....',
    '..OHhO....OHO...', '..OHO......O....', '.OHhO...........', '.OHO............',
    '.OHO............', '.OHhO...........', '..OHO...........', '..OHhO..........',
    '...OO...........', '................', '................', '................',
  ], { O: '#241b10', H: '#8a6232', h: '#a87c46' });
  const px = (x: number, y: number, col: string): void => {
    if (x < 0 || y < 0 || x > 15 || y > 15) return;
    c.fillStyle = col;
    c.fillRect(x, y, 1, 1);
  };
  const line = (x0: number, y0: number, x1: number, y1: number, col: string): void => {
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      px(x0, y0, col);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  };
  const STRING = '#e8e8e8';
  if (stage < 0) { line(12, 5, 4, 13, STRING); return; }
  // pull point slides down the diagonal as the draw deepens
  const P = [[9, 10], [10, 11], [11, 12]][stage];
  line(12, 5, P[0], P[1], STRING);
  line(4, 13, P[0], P[1], STRING);
  // arrow: nock at the string, 8px shaft up-left, flint head, white fletching
  for (let k = 1; k <= 8; k++) {
    const x = P[0] - k, y = P[1] - k;
    if (k >= 7) {
      px(x, y, k === 8 ? '#e2e2e2' : '#b8b8b8');
      if (k === 7) { px(x + 1, y - 1, '#8a8a8a'); px(x - 1, y + 1, '#8a8a8a'); }
    } else {
      px(x, y, k % 2 ? '#9a7040' : '#6b4a26');
    }
    if (k <= 2) { px(x + 1, y - 1, k === 1 ? '#ffffff' : '#d6d6d6'); px(x - 1, y + 1, k === 1 ? '#d6d6d6' : '#ffffff'); }
  }
}

// ---------------------------------------------------------------------------
// HUD pixel sprites (hearts / hunger shanks)
// ---------------------------------------------------------------------------

const HEART_MAP = [
  '.OO..OO.',
  'ORRLORRO',
  'ORRRRRRO',
  'ORRRRRRO',
  '.ORRRRO.',
  '..ORRO..',
  '...OO...',
];
const SHANK_MAP = [
  '...OOO..',
  '..OBBbO.',
  '..OBbbO.',
  '.OBBBO..',
  'OWOBO...',
  'OWWO....',
  '.OO.....',
];

export function drawHeart(kind: 'full' | 'half' | 'empty'): HTMLCanvasElement {
  const [c, ctx] = makeCanvas(8, 7);
  const full = { O: '#1b0b0b', R: '#e3313b', L: '#ff8a8a' };
  const empty = { O: '#1b0b0b', R: '#3b2222', L: '#4a2c2c' };
  pixmap(ctx, 0, 0, HEART_MAP, kind === 'empty' ? empty : full);
  if (kind === 'half') {
    // right half shows the empty container
    const [h, hctx] = makeCanvas(8, 7);
    pixmap(hctx, 0, 0, HEART_MAP, empty);
    ctx.clearRect(4, 0, 4, 7);
    ctx.drawImage(h, 4, 0, 4, 7, 4, 0, 4, 7);
  }
  return c;
}

const ARMOR_ICON_MAP = [
  'OO.....OO',
  'OMOOOOOMO',
  'OMMMMMMMO',
  'OMMMMMMMO',
  '.OMMMMMO.',
  '.OMMMMMO.',
  '.OMMMMMO.',
  '..OMMMO..',
  '...OOO...',
];
export function drawArmor(kind: 'full' | 'half' | 'empty'): HTMLCanvasElement {
  const [c, ctx] = makeCanvas(9, 9);
  const full = { O: '#0a0a14', M: '#dadae8', m: '#9a9ab0' };
  const empty = { O: '#0a0a14', M: '#23232e', m: '#191922' };
  pixmap(ctx, 0, 0, ARMOR_ICON_MAP, kind === 'empty' ? empty : full);
  if (kind === 'half') {
    const [h, hctx] = makeCanvas(9, 9);
    pixmap(hctx, 0, 0, ARMOR_ICON_MAP, empty);
    ctx.clearRect(5, 0, 4, 9);
    ctx.drawImage(h, 5, 0, 4, 9, 5, 0, 4, 9);
  }
  return c;
}

export function drawBubble(): HTMLCanvasElement {
  const [c, ctx] = makeCanvas(8, 7);
  pixmap(ctx, 0, 0, [
    '..OOO...',
    '.OBLBO..',
    'OBLBBBO.',
    'OBBBBBO.',
    'OBBBBBO.',
    '.OBBBO..',
    '..OOO...',
  ], { O: '#1f3f66', B: '#4f9be8', L: '#aad4ff' });
  return c;
}

export function drawShank(kind: 'full' | 'half' | 'empty'): HTMLCanvasElement {
  const [c, ctx] = makeCanvas(8, 7);
  const full = { O: '#2a1408', B: '#b5773a', b: '#d8a05a', W: '#e8e0d0' };
  const empty = { O: '#2a1408', B: '#3a2a1a', b: '#473322', W: '#473322' };
  pixmap(ctx, 0, 0, SHANK_MAP, kind === 'empty' ? empty : full);
  if (kind === 'half') {
    const [h, hctx] = makeCanvas(8, 7);
    pixmap(hctx, 0, 0, SHANK_MAP, empty);
    ctx.clearRect(4, 0, 4, 7);
    ctx.drawImage(h, 4, 0, 4, 7, 4, 0, 4, 7);
  }
  return c;
}

// ---------------------------------------------------------------------------
// Resource pack mapping: our tile name -> candidate vanilla texture stems
// ---------------------------------------------------------------------------

interface PackEntry { paths: string[]; tint?: string; kind: 'tile' | 'item' | 'crack' }

const PACK_MAP: Record<string, PackEntry> = {
  grass_top: { paths: ['block/grass_block_top', 'block/grass_top'], tint: '#7cbd6b', kind: 'tile' },
  grass_side: { paths: ['block/grass_block_side', 'block/grass_side'], kind: 'tile' },
  dirt: { paths: ['block/dirt'], kind: 'tile' },
  stone: { paths: ['block/stone'], kind: 'tile' },
  cobble: { paths: ['block/cobblestone'], kind: 'tile' },
  sand: { paths: ['block/sand'], kind: 'tile' },
  log_side: { paths: ['block/oak_log', 'block/log_oak'], kind: 'tile' },
  log_top: { paths: ['block/oak_log_top', 'block/log_oak_top'], kind: 'tile' },
  planks: { paths: ['block/oak_planks', 'block/planks_oak'], kind: 'tile' },
  leaves: { paths: ['block/oak_leaves', 'block/leaves_oak'], tint: '#59ae30', kind: 'tile' },
  glass: { paths: ['block/glass'], kind: 'tile' },
  water: { paths: ['block/water_still'], tint: '#3f76e4', kind: 'tile' },
  water_flow: { paths: ['block/water_flow'], tint: '#3f76e4', kind: 'tile' },
  lava: { paths: ['block/lava_still', 'block/lava'], kind: 'tile' },
  obsidian: { paths: ['block/obsidian'], kind: 'tile' },
  table_top: { paths: ['block/crafting_table_top'], kind: 'tile' },
  table_side: { paths: ['block/crafting_table_side'], kind: 'tile' },
  table_front: { paths: ['block/crafting_table_front'], kind: 'tile' },
  furnace_top: { paths: ['block/furnace_top'], kind: 'tile' },
  furnace_side: { paths: ['block/furnace_side'], kind: 'tile' },
  furnace_front: { paths: ['block/furnace_front'], kind: 'tile' },
  furnace_front_on: { paths: ['block/furnace_front_on'], kind: 'tile' },
  snow_top: { paths: ['block/snow'], kind: 'tile' },
  snow_side: { paths: ['block/grass_block_snow', 'block/grass_side_snowed'], kind: 'tile' },
  bedrock: { paths: ['block/bedrock'], kind: 'tile' },
  coal_ore: { paths: ['block/coal_ore'], kind: 'tile' },
  iron_ore: { paths: ['block/iron_ore'], kind: 'tile' },
  gold_ore: { paths: ['block/gold_ore'], kind: 'tile' },
  diamond_ore: { paths: ['block/diamond_ore'], kind: 'tile' },
  amethyst_ore: { paths: ['block/amethyst_ore'], kind: 'tile' },
  gravel: { paths: ['block/gravel'], kind: 'tile' },
  sandstone_top: { paths: ['block/sandstone_top'], kind: 'tile' },
  sandstone_side: { paths: ['block/sandstone', 'block/sandstone_normal'], kind: 'tile' },
  stone_bricks: { paths: ['block/stone_bricks', 'block/stonebrick'], kind: 'tile' },
  wool: { paths: ['block/white_wool', 'block/wool_colored_white'], kind: 'tile' },
  iron_block: { paths: ['block/iron_block'], kind: 'tile' },
  gold_block: { paths: ['block/gold_block'], kind: 'tile' },
  diamond_block: { paths: ['block/diamond_block'], kind: 'tile' },
  tnt_top: { paths: ['block/tnt_top'], kind: 'tile' },
  tnt_side: { paths: ['block/tnt_side'], kind: 'tile' },
  torch: { paths: ['block/torch', 'block/torch_on'], kind: 'tile' },
  birch_log_side: { paths: ['block/birch_log', 'block/log_birch'], kind: 'tile' },
  birch_log_top: { paths: ['block/birch_log_top', 'block/log_birch_top'], kind: 'tile' },
  spruce_log_side: { paths: ['block/spruce_log', 'block/log_spruce'], kind: 'tile' },
  spruce_log_top: { paths: ['block/spruce_log_top', 'block/log_spruce_top'], kind: 'tile' },
  birch_leaves: { paths: ['block/birch_leaves', 'block/leaves_birch'], tint: '#80a755', kind: 'tile' },
  spruce_leaves: { paths: ['block/spruce_leaves', 'block/leaves_spruce'], tint: '#619961', kind: 'tile' },
  jungle_log_side: { paths: ['block/jungle_log', 'block/log_jungle'], kind: 'tile' },
  jungle_log_top: { paths: ['block/jungle_log_top', 'block/log_jungle_top'], kind: 'tile' },
  jungle_leaves: { paths: ['block/jungle_leaves', 'block/leaves_jungle'], tint: '#48b13a', kind: 'tile' },
  poppy: { paths: ['block/poppy', 'block/flower_rose'], kind: 'tile' },
  dandelion: { paths: ['block/dandelion', 'block/flower_dandelion'], kind: 'tile' },
  tall_grass: { paths: ['block/short_grass', 'block/grass', 'block/tallgrass'], tint: '#7cbd6b', kind: 'tile' },
  cactus_side: { paths: ['block/cactus_side'], kind: 'tile' },
  cactus_top: { paths: ['block/cactus_top'], kind: 'tile' },
  sugar_cane: { paths: ['block/sugar_cane', 'block/reeds'], kind: 'tile' },
  farmland_top: { paths: ['block/farmland_moist', 'block/farmland'], kind: 'tile' },
  wheat_0: { paths: ['block/wheat_stage1', 'block/wheat_stage_1'], kind: 'tile' },
  wheat_1: { paths: ['block/wheat_stage4', 'block/wheat_stage_4'], kind: 'tile' },
  wheat_2: { paths: ['block/wheat_stage7', 'block/wheat_stage_7'], kind: 'tile' },
  carrot_0: { paths: ['block/carrots_stage1', 'block/carrots_stage_1'], kind: 'tile' },
  carrot_1: { paths: ['block/carrots_stage4', 'block/carrots_stage_4'], kind: 'tile' },
  carrot_2: { paths: ['block/carrots_stage7', 'block/carrots_stage_7'], kind: 'tile' },
  potato_0: { paths: ['block/potatoes_stage1', 'block/potatoes_stage_1'], kind: 'tile' },
  potato_1: { paths: ['block/potatoes_stage4', 'block/potatoes_stage_4'], kind: 'tile' },
  potato_2: { paths: ['block/potatoes_stage7', 'block/potatoes_stage_7'], kind: 'tile' },
  beetroot_0: { paths: ['block/beetroots_stage1', 'block/beetroots_stage_1'], kind: 'tile' },
  beetroot_1: { paths: ['block/beetroots_stage2', 'block/beetroots_stage_2'], kind: 'tile' },
  beetroot_2: { paths: ['block/beetroots_stage3', 'block/beetroots_stage_3'], kind: 'tile' },
  sapling: { paths: ['block/oak_sapling', 'block/sapling_oak'], kind: 'tile' },
  portal: { paths: ['block/nether_portal'], kind: 'tile' },
  netherrack: { paths: ['block/netherrack'], kind: 'tile' },
  glowstone: { paths: ['block/glowstone'], kind: 'tile' },
  soul_sand: { paths: ['block/soul_sand'], kind: 'tile' },
  nether_quartz_ore: { paths: ['block/nether_quartz_ore'], kind: 'tile' },
  magma: { paths: ['block/magma'], kind: 'tile' },
  nether_bricks: { paths: ['block/nether_bricks'], kind: 'tile' },
  redstone_dust: { paths: ['block/redstone_dust_line'], kind: 'tile' },
  redstone_lamp: { paths: ['block/redstone_lamp'], kind: 'tile' },
  lever: { paths: ['block/lever'], kind: 'tile' },
  piston_top: { paths: ['block/piston_top'], kind: 'tile' },
  piston_top_sticky: { paths: ['block/piston_top_sticky'], kind: 'tile' },
  piston_bottom: { paths: ['block/piston_bottom'], kind: 'tile' },
  piston_side: { paths: ['block/piston_side'], kind: 'tile' },
  pressure_plate: { paths: ['block/oak_pressure_plate'], kind: 'tile' },
  stick: { paths: ['item/stick'], kind: 'item' },
  coal: { paths: ['item/coal'], kind: 'item' },
  wood_pickaxe: { paths: ['item/wooden_pickaxe', 'item/wood_pickaxe'], kind: 'item' },
  wood_axe: { paths: ['item/wooden_axe', 'item/wood_axe'], kind: 'item' },
  wood_shovel: { paths: ['item/wooden_shovel', 'item/wood_shovel'], kind: 'item' },
  wood_sword: { paths: ['item/wooden_sword', 'item/wood_sword'], kind: 'item' },
  stone_pickaxe: { paths: ['item/stone_pickaxe'], kind: 'item' },
  stone_axe: { paths: ['item/stone_axe'], kind: 'item' },
  stone_shovel: { paths: ['item/stone_shovel'], kind: 'item' },
  stone_sword: { paths: ['item/stone_sword'], kind: 'item' },
  porkchop: { paths: ['item/porkchop'], kind: 'item' },
  cooked_porkchop: { paths: ['item/cooked_porkchop'], kind: 'item' },
  chicken: { paths: ['item/chicken'], kind: 'item' },
  cooked_chicken: { paths: ['item/cooked_chicken'], kind: 'item' },
  iron_pickaxe: { paths: ['item/iron_pickaxe'], kind: 'item' },
  iron_axe: { paths: ['item/iron_axe'], kind: 'item' },
  iron_shovel: { paths: ['item/iron_shovel'], kind: 'item' },
  iron_sword: { paths: ['item/iron_sword'], kind: 'item' },
  diamond_pickaxe: { paths: ['item/diamond_pickaxe'], kind: 'item' },
  diamond_axe: { paths: ['item/diamond_axe'], kind: 'item' },
  diamond_shovel: { paths: ['item/diamond_shovel'], kind: 'item' },
  diamond_sword: { paths: ['item/diamond_sword'], kind: 'item' },
  iron_ingot: { paths: ['item/iron_ingot'], kind: 'item' },
  gold_ingot: { paths: ['item/gold_ingot'], kind: 'item' },
  diamond: { paths: ['item/diamond'], kind: 'item' },
  flint: { paths: ['item/flint'], kind: 'item' },
  feather: { paths: ['item/feather'], kind: 'item' },
  string: { paths: ['item/string'], kind: 'item' },
  gunpowder: { paths: ['item/gunpowder'], kind: 'item' },
  arrow: { paths: ['item/arrow'], kind: 'item' },
  bow: { paths: ['item/bow'], kind: 'item' },
  bow_pulling_0: { paths: ['item/bow_pulling_0'], kind: 'item' },
  bow_pulling_1: { paths: ['item/bow_pulling_1'], kind: 'item' },
  bow_pulling_2: { paths: ['item/bow_pulling_2'], kind: 'item' },
  mutton: { paths: ['item/mutton'], kind: 'item' },
  cooked_mutton: { paths: ['item/cooked_mutton'], kind: 'item' },
  beef: { paths: ['item/beef'], kind: 'item' },
  cooked_beef: { paths: ['item/cooked_beef'], kind: 'item' },
  rotten_flesh: { paths: ['item/rotten_flesh'], kind: 'item' },
  apple: { paths: ['item/apple'], kind: 'item' },
  seeds: { paths: ['item/wheat_seeds', 'item/seeds_wheat'], kind: 'item' },
  wheat: { paths: ['item/wheat'], kind: 'item' },
  bread: { paths: ['item/bread'], kind: 'item' },
  carrot: { paths: ['item/carrot'], kind: 'item' },
  golden_carrot: { paths: ['item/golden_carrot'], kind: 'item' },
  potato: { paths: ['item/potato'], kind: 'item' },
  baked_potato: { paths: ['item/baked_potato'], kind: 'item' },
  beetroot: { paths: ['item/beetroot'], kind: 'item' },
  beetroot_seeds: { paths: ['item/beetroot_seeds'], kind: 'item' },
  bowl: { paths: ['item/bowl'], kind: 'item' },
  beetroot_soup: { paths: ['item/beetroot_soup'], kind: 'item' },
  vegetable_stew: { paths: ['item/suspicious_stew', 'item/mushroom_stew'], kind: 'item' },
  hoe: { paths: ['item/wooden_hoe', 'item/wood_hoe'], kind: 'item' },
  flint_and_steel: { paths: ['item/flint_and_steel'], kind: 'item' },
  quartz: { paths: ['item/quartz'], kind: 'item' },
  nether_brick: { paths: ['item/netherbrick', 'item/nether_brick'], kind: 'item' },
  redstone: { paths: ['item/redstone_dust', 'item/redstone'], kind: 'item' },
  amethyst: { paths: ['item/amethyst_shard', 'item/amethyst'], kind: 'item' },
  mob_catcher: { paths: ['item/mob_catcher'], kind: 'item' },
  mob_catcher_filled: { paths: ['item/mob_catcher_filled'], kind: 'item' },
};
for (let i = 0; i < 10; i++) {
  PACK_MAP[`crack_${i}`] = { paths: [`block/destroy_stage_${i}`], kind: 'crack' };
}

// ---------------------------------------------------------------------------
// Atlas
// ---------------------------------------------------------------------------

// Partial blocks drawn as small iso boxes in the inventory: [p0,p1,q0,q1,h0,h1]
const ICON_BOXES: Record<string, number[]> = {
  pressure_plate: [1 / 16, 15 / 16, 1 / 16, 15 / 16, 0.3, 0.3 + 2 / 16],
  wooden_button: [4 / 16, 12 / 16, 5 / 16, 11 / 16, 0.3, 0.3 + 5 / 16],
  stone_button: [4 / 16, 12 / 16, 5 / 16, 11 / 16, 0.3, 0.3 + 5 / 16],
};

export interface UVRect { u0: number; v0: number; u1: number; v1: number }

export class Atlas {
  canvas: HTMLCanvasElement;
  private ctx: Ctx;
  texture: THREE.CanvasTexture;
  cracks: HTMLCanvasElement[] = [];
  crackTextures: THREE.CanvasTexture[] = [];
  private tiles = new Map<string, number>(); // name -> slot index
  private itemSprites = new Map<string, HTMLCanvasElement>();
  private iconCache = new Map<number, HTMLCanvasElement>();
  /** bumped whenever textures change so UI can refresh icons */
  generation = 0;

  constructor() {
    [this.canvas, this.ctx] = makeCanvas(COLS * TILE, ROWS * TILE);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.magFilter = THREE.NearestFilter;
    // hand-built per-tile mip chain (see buildMipmaps): crisp up close, no
    // shimmering "static" on distant leaves/gravel, and no cross-tile bleeding
    this.texture.minFilter = THREE.NearestMipmapLinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.flipY = false;
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.generateAll();
  }

  private slotXY(idx: number): [number, number] {
    return [(idx % COLS) * TILE, Math.floor(idx / COLS) * TILE];
  }

  private generateAll(): void {
    let idx = 0;
    for (const name of Object.keys(TILE_PAINTERS)) {
      if (name.startsWith('crack_')) continue;
      this.tiles.set(name, idx);
      const [x, y] = this.slotXY(idx);
      TILE_PAINTERS[name](this.ctx, x, y);
      idx++;
    }
    for (let i = 0; i < 10; i++) {
      const [c, cctx] = makeCanvas(TILE, TILE);
      TILE_PAINTERS[`crack_${i}`](cctx, 0, 0);
      this.cracks.push(c);
      const t = new THREE.CanvasTexture(c);
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      this.crackTextures.push(t);
    }
    for (const name of Object.keys(ITEM_PAINTERS)) {
      const [c, cctx] = makeCanvas(TILE, TILE);
      ITEM_PAINTERS[name](cctx);
      this.itemSprites.set(name, c);
    }
    this.buildMipmaps();
    this.texture.needsUpdate = true;
  }

  /**
   * Mip levels down to 1px per tile. Each level halves the previous one with
   * an alpha-weighted box filter in linear light; tiles are power-of-two
   * aligned so a texel never mixes two tiles. Cutout tiles (leaves, glass)
   * then get their alpha re-thresholded to keep their level-0 coverage, so
   * foliage neither dissolves nor turns into solid blobs at distance; very
   * sparse ones (torch, flowers, crop stems) are dilated instead so their
   * 1px strokes stay unbroken.
   */
  private buildMipmaps(): void {
    const W = this.canvas.width, H = this.canvas.height;
    const base = this.ctx.getImageData(0, 0, W, H).data;
    // per-tile level-0 coverage for binary-alpha (cutout) tiles, -1 otherwise
    const tilesX = W / TILE, tilesY = H / TILE;
    const coverage = new Float32Array(tilesX * tilesY).fill(-1);
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        let on = 0, partial = 0;
        for (let y = 0; y < TILE; y++) {
          for (let x = 0; x < TILE; x++) {
            const a = base[((ty * TILE + y) * W + tx * TILE + x) * 4 + 3];
            if (a >= 128) on++;
            if (a > 8 && a < 247) partial++;
          }
        }
        if (partial === 0 && on > 0 && on < TILE * TILE) coverage[ty * tilesX + tx] = on / (TILE * TILE);
      }
    }
    const toLin = new Float32Array(256);
    for (let i = 0; i < 256; i++) toLin[i] = (i / 255) ** 2.2;
    const levels: HTMLCanvasElement[] = [this.canvas];
    let src = base, sw = W, sh = H, tile = TILE;
    while (tile > 1) {
      const dw = sw >> 1, dh = sh >> 1;
      tile >>= 1;
      const [c, cctx] = makeCanvas(dw, dh);
      const img = cctx.createImageData(dw, dh);
      const d = img.data;
      for (let y = 0; y < dh; y++) {
        for (let x = 0; x < dw; x++) {
          let r = 0, g = 0, b = 0, a = 0;
          for (let k = 0; k < 4; k++) {
            const o = (((y * 2 + (k >> 1)) * sw) + x * 2 + (k & 1)) * 4;
            const al = src[o + 3] / 255;
            r += toLin[src[o]] * al; g += toLin[src[o + 1]] * al; b += toLin[src[o + 2]] * al; a += al;
          }
          const o = (y * dw + x) * 4;
          if (a > 0) {
            d[o] = 255 * (r / a) ** (1 / 2.2); d[o + 1] = 255 * (g / a) ** (1 / 2.2); d[o + 2] = 255 * (b / a) ** (1 / 2.2);
          }
          d[o + 3] = 255 * a / 4;
        }
      }
      // coverage-preserving alpha for cutout tiles
      for (let ty = 0; ty < tilesY; ty++) {
        for (let tx = 0; tx < tilesX; tx++) {
          const cov = coverage[ty * tilesX + tx];
          if (cov < 0) continue;
          const idx: number[] = [];
          for (let y = 0; y < tile; y++) for (let x = 0; x < tile; x++) idx.push(((ty * tile + y) * dw + tx * tile + x) * 4 + 3);
          if (cov < 0.2) {
            // thin sprites (torch, flowers, crop stems): dilate so they never break up
            for (const o of idx) d[o] = d[o] > 0 ? 255 : 0;
            continue;
          }
          idx.sort((p, q) => d[q] - d[p]);
          const keep = Math.round(cov * idx.length);
          idx.forEach((o, i) => { d[o] = i < keep && d[o] > 0 ? 255 : 0; });
        }
      }
      cctx.putImageData(img, 0, 0);
      levels.push(c);
      src = d; sw = dw; sh = dh;
    }
    this.texture.mipmaps = levels;
  }

  /** Every tile's UV rect, keyed by name — sent to the mesh worker once at init. */
  allRects(): Record<string, UVRect> {
    const out: Record<string, UVRect> = {};
    for (const name of this.tiles.keys()) out[name] = this.rect(name);
    return out;
  }

  // The mesher calls rect() once per face; cache the (immutable) UVRect per tile
  // so the hot path does a single Map.get and no per-call object allocation.
  private rectCache = new Map<string, UVRect>();

  rect(name: string): UVRect {
    const cached = this.rectCache.get(name);
    if (cached) return cached;
    const idx = this.tiles.get(name);
    if (idx === undefined) throw new Error(`Unknown tile ${name}`);
    const [x, y] = this.slotXY(idx);
    const W = this.canvas.width, H = this.canvas.height;
    const e = 0.02; // half-ish texel inset against bleeding
    const r: UVRect = {
      u0: (x + e) / W, v0: (y + e) / H,
      u1: (x + TILE - e) / W, v1: (y + TILE - e) / H,
    };
    this.rectCache.set(name, r);
    return r;
  }

  tileCanvas(name: string): HTMLCanvasElement {
    const idx = this.tiles.get(name);
    if (idx === undefined) throw new Error(`Unknown tile ${name}`);
    const [x, y] = this.slotXY(idx);
    const [c, ctx] = makeCanvas(TILE, TILE);
    ctx.drawImage(this.canvas, x, y, TILE, TILE, 0, 0, TILE, TILE);
    return c;
  }

  sprite(name: string): HTMLCanvasElement | undefined {
    return this.itemSprites.get(name);
  }

  /** 32x32 icon for a block (isometric) or item (flat sprite). */
  icon(id: number): HTMLCanvasElement {
    const cached = this.iconCache.get(id);
    if (cached) return cached;
    const d = def(id);
    const [c, ctx] = makeCanvas(32, 32);
    if (d.name === 'bed' || BLOCK_SPRITE_ICONS.has(d.name)) {
      // hand-drawn 3/4-view bed sprite (legs + mattress + pillow); an isometric
      // slice of the block tiles never read as a bed at hotbar size
      const s = this.itemSprites.get(d.name);
      ctx.imageSmoothingEnabled = false;
      if (s) ctx.drawImage(s, 0, 0, 16, 16, 0, 0, 32, 32);
    } else if (d.block && d.faces && ICON_SHAPES[d.name]) {
      // partial blocks (slabs, stairs, fences, anvil ...) as little iso models
      const top = this.tileCanvas(d.faces.top), side = this.tileCanvas(d.faces.sides);
      ICON_SHAPES[d.name].forEach((b, i) => this.drawIsoBox(ctx, top, side, side, b, i === 0));
    } else if (d.block && d.faces && ICON_BOXES[d.name]) {
      // thin/small redstone parts: a true little isometric box, not a full tile
      const t = this.tileCanvas(d.faces.top);
      this.drawIsoBox(ctx, t, t, t, ICON_BOXES[d.name], false);
    } else if (d.block && d.faces && !d.solid) {
      // non-cube decorations (torch, flowers, crops, cane, sapling, ladder,
      // doors, water) read better as a flat tile than as an isometric cube
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.tileCanvas(d.faces.sides), 0, 0, 16, 16, 0, 0, 32, 32);
    } else if (d.block && d.faces) {
      const tint = (name: string): HTMLCanvasElement => {
        const t = this.tileCanvas(name);
        // biome-tinted tiles show at an average in-world tint so icons match the world
        if (TINTED_TILES.has(name)) {
          const tc = t.getContext('2d')!;
          tc.globalCompositeOperation = 'multiply';
          tc.fillStyle = '#f0ffbd';
          tc.fillRect(0, 0, 16, 16);
          tc.globalCompositeOperation = 'destination-in';
          tc.drawImage(this.tileCanvas(name), 0, 0);
          tc.globalCompositeOperation = 'source-over';
        }
        return t;
      };
      this.drawIsoBox(ctx, tint(d.faces.top), tint(d.faces.front ?? d.faces.sides), tint(d.faces.sides), [0, 1, 0, 1, 0, 1], true);
    } else if (d.sprite) {
      const s = this.itemSprites.get(d.sprite);
      if (s) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(s, 0, 0, 16, 16, 0, 0, 32, 32);
      }
    }
    // fallback: if nothing was drawn (transparent canvas), stamp a visible
    // placeholder so the slot is never mysteriously blank in the creative panel
    const img = ctx.getImageData(0, 0, 32, 32).data;
    let anyPixel = false;
    for (let i = 3; i < img.length; i += 4) { if (img[i] > 8) { anyPixel = true; break; } }
    if (!anyPixel) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.filter = 'none';
      ctx.fillStyle = '#3a3a3a';
      ctx.fillRect(2, 2, 28, 28);
      ctx.fillStyle = '#8a8a8a';
      ctx.fillRect(8, 8, 16, 16);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 20px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('?', 16, 17);
    }
    this.iconCache.set(id, c);
    return c;
  }

  /**
   * Isometric box [p0,p1]x[q0,q1]x[h0,h1] (block units) in the 32px icon:
   * p runs left corner -> front corner, q front -> right corner, h up.
   * Top face full brightness, left (front) face ~80%, right face ~60%, the
   * vanilla inventory lighting. Shading is composited (no ctx.filter, which
   * Safari ignores) so every browser gets lit icons.
   */
  private drawIsoBox(ctx: Ctx, top: HTMLCanvasElement, left: HTMLCanvasElement, right: HTMLCanvasElement,
    box: number[], shadow: boolean): void {
    const [p0, p1, q0, q1, h0, h1] = box;
    const ox = 1.1, oy = 24.96, ax = 14.9, ay = 7.5, hy = 16.96;
    const S = (p: number, q: number, h: number): [number, number] => [ox + ax * (p + q), oy + ay * (p - q) - hy * h];
    const shaded = (src: HTMLCanvasElement, dark: number): HTMLCanvasElement => {
      const [c, cx] = makeCanvas(16, 16);
      cx.drawImage(src, 0, 0);
      cx.globalCompositeOperation = 'source-atop';
      cx.fillStyle = `rgba(0,0,0,${dark})`;
      cx.fillRect(0, 0, 16, 16);
      return c;
    };
    ctx.imageSmoothingEnabled = false;
    if (shadow) {
      const pts = [S(p0, q0, h0), S(p1, q0, h0), S(p1, q1, h0), S(p0, q1, h0)];
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x + 1.5, y + 1.5) : ctx.moveTo(x + 1.5, y + 1.5)));
      ctx.closePath();
      ctx.fill();
    }
    const T = 16;
    // top face: u -> +p, v -> -q, origin at (p=0, q=1)
    let [ex, ey] = S(0, 1, h1);
    ctx.setTransform(ax / T, ay / T, -ax / T, ay / T, ex, ey);
    ctx.drawImage(top, T * p0, T * (1 - q1), T * (p1 - p0), T * (q1 - q0), T * p0, T * (1 - q1), T * (p1 - p0), T * (q1 - q0));
    // left (front) face on q = q0: u -> +p, v -> down
    [ex, ey] = S(0, q0, 1);
    ctx.setTransform(ax / T, ay / T, 0, hy / T, ex, ey);
    ctx.drawImage(shaded(left, 0.2), T * p0, T * (1 - h1), T * (p1 - p0), T * (h1 - h0), T * p0, T * (1 - h1), T * (p1 - p0), T * (h1 - h0));
    // right face on p = p1: u -> +q, v -> down
    [ex, ey] = S(p1, 0, 1);
    ctx.setTransform(ax / T, -ay / T, 0, hy / T, ex, ey);
    ctx.drawImage(shaded(right, 0.4), T * q0, T * (1 - h1), T * (q1 - q0), T * (h1 - h0), T * q0, T * (1 - h1), T * (q1 - q0), T * (h1 - h0));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /**
   * Apply a resource pack chosen as a folder (assets/minecraft/textures/... layout).
   * Returns the number of textures replaced.
   */
  async loadResourcePack(files: File[]): Promise<number> {
    // index files by their normalized tail path
    const byTail = new Map<string, File>();
    for (const f of files) {
      const rel = ((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name)
        .replace(/\\/g, '/').toLowerCase();
      const m = rel.match(/textures\/((?:block|blocks|item|items)\/[a-z0-9_]+)\.png$/);
      if (m) {
        let tail = m[1].replace(/^blocks\//, 'block/').replace(/^items\//, 'item/');
        if (!byTail.has(tail)) byTail.set(tail, f);
      }
    }
    if (byTail.size === 0) return 0;

    let replaced = 0;
    for (const [name, entry] of Object.entries(PACK_MAP)) {
      let file: File | undefined;
      for (const p of entry.paths) { file = byTail.get(p); if (file) break; }
      if (!file) continue;
      try {
        const img = await loadImage(file);
        const [tmp, tctx] = makeCanvas(TILE, TILE);
        // animated strips (e.g. water_still) are 16 wide, N*16 tall: take frame 0
        tctx.drawImage(img, 0, 0, 16, 16, 0, 0, 16, 16);
        if (entry.tint) {
          tctx.globalCompositeOperation = 'multiply';
          tctx.fillStyle = entry.tint;
          tctx.fillRect(0, 0, 16, 16);
          tctx.globalCompositeOperation = 'destination-in';
          tctx.drawImage(img, 0, 0, 16, 16, 0, 0, 16, 16);
          tctx.globalCompositeOperation = 'source-over';
        }
        if (entry.kind === 'tile') {
          const idx = this.tiles.get(name);
          if (idx === undefined) continue;
          const [x, y] = this.slotXY(idx);
          this.ctx.clearRect(x, y, TILE, TILE);
          this.ctx.drawImage(tmp, x, y);
          if (name === 'water' || name === 'water_flow') {
            // ensure water stays translucent
            const img2 = this.ctx.getImageData(x, y, TILE, TILE);
            for (let i = 3; i < img2.data.length; i += 4) {
              if (img2.data[i] > 200) img2.data[i] = 200;
            }
            this.ctx.putImageData(img2, x, y);
          }
        } else if (entry.kind === 'crack') {
          const i = parseInt(name.slice(6), 10);
          const cctx = this.cracks[i].getContext('2d')!;
          cctx.clearRect(0, 0, TILE, TILE);
          cctx.drawImage(tmp, 0, 0);
          this.crackTextures[i].needsUpdate = true;
        } else {
          const sctx = this.itemSprites.get(name)?.getContext('2d');
          if (!sctx) continue;
          sctx.clearRect(0, 0, TILE, TILE);
          sctx.drawImage(tmp, 0, 0);
        }
        replaced++;
      } catch {
        // unreadable file: keep procedural texture
      }
    }
    this.buildMipmaps();
    this.texture.needsUpdate = true;
    this.iconCache.clear();
    this.generation++;
    return replaced;
  }
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
    img.src = url;
  });
}

// =============================================================================
// Gameplay-track item sprites (gold gear, golden apples, milk, shears, shield,
// spyglass). Self-contained: variants are recoloured from the base painters
// at atlas build time, so they follow any rework of the iron/apple/bucket art.
// =============================================================================

/** Paint `base` into a fresh 16x16 canvas and remap each pixel's colour. */
function recolorSprite(ctx: Ctx, base: string, map: (r: number, g: number, b: number) => [number, number, number] | null): void {
  const paint = ITEM_PAINTERS[base];
  if (!paint) return;
  const [tmp, tctx] = makeCanvas(TILE, TILE);
  paint(tctx);
  const img = tctx.getImageData(0, 0, TILE, TILE);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const out = map(d[i], d[i + 1], d[i + 2]);
    if (out) { d[i] = out[0]; d[i + 1] = out[1]; d[i + 2] = out[2]; }
  }
  tctx.putImageData(img, 0, 0);
  ctx.drawImage(tmp, 0, 0);
}

/** Luminance -> warm gold ramp (dark bronze outline up to a pale glint). */
function goldRamp(l: number): [number, number, number] {
  const stops: [number, [number, number, number]][] = [
    [0, [58, 36, 6]], [0.3, [150, 98, 14]], [0.6, [232, 180, 34]], [0.82, [252, 226, 92]], [1, [255, 250, 206]],
  ];
  for (let i = 1; i < stops.length; i++) {
    const [t1, c1] = stops[i];
    const [t0, c0] = stops[i - 1];
    if (l <= t1) {
      const k = (l - t0) / (t1 - t0);
      return [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k].map(Math.round) as [number, number, number];
    }
  }
  return stops[stops.length - 1][1];
}

/** Grey (metal) pixels -> gold; warm wood/leather pixels are left alone. */
const toGold = (r: number, g: number, b: number): [number, number, number] | null => {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx - mn > 28) return null; // saturated: a wooden handle, keep it
  return goldRamp(Math.min(1, (0.3 * r + 0.59 * g + 0.11 * b) / 245));
};

/** Red apple flesh -> gold; the green leaf + stem stay. */
const appleToGold = (r: number, g: number, b: number): [number, number, number] | null => {
  if (r > g + 40 && r > b + 40) return goldRamp(Math.min(1, (r * 0.55 + g * 0.45) / 230 + 0.12));
  return null;
};

const SHIELD_MAP = [
  '................',
  '..OOOOOOOOOOOO..',
  '..OIIIIIIIIIIO..',
  '..OIPPpPPpPPIO..',
  '..OIPPpPPpPPIO..',
  '..OIPPpIIpPPIO..',
  '..OIPPIiiIPPIO..',
  '..OIPPIiiIPPIO..',
  '..OIPPpIIpPPIO..',
  '..OIPPpPPpPPIO..',
  '...OIPpPPpPIO...',
  '...OIPpPPpPIO...',
  '....OIPPPPIO....',
  '.....OIIIIO.....',
  '......OOOO......',
  '................',
];
const SPYGLASS_MAP = [
  '................',
  '...........OOO..',
  '..........OAAaO.',
  '.........OGAAAO.',
  '........OGGaAO..',
  '.......OGgGOO...',
  '......OGgGO.....',
  '.....ODdDO......',
  '....ODdDO.......',
  '...OGgGO........',
  '..OGgGO.........',
  '.OGgGO..........',
  '.OggO...........',
  '..OO............',
  '................',
  '................',
];

const GAMEPLAY_ITEM_PAINTERS: Record<string, (ctx: Ctx) => void> = {
  gold_pickaxe: (c) => recolorSprite(c, 'iron_pickaxe', toGold),
  gold_axe: (c) => recolorSprite(c, 'iron_axe', toGold),
  gold_shovel: (c) => recolorSprite(c, 'iron_shovel', toGold),
  gold_sword: (c) => recolorSprite(c, 'iron_sword', toGold),
  gold_helmet: (c) => recolorSprite(c, 'iron_helmet', toGold),
  gold_chest: (c) => recolorSprite(c, 'iron_chest', toGold),
  gold_legs: (c) => recolorSprite(c, 'iron_legs', toGold),
  gold_boots: (c) => recolorSprite(c, 'iron_boots', toGold),
  golden_apple: (c) => recolorSprite(c, 'apple', appleToGold),
  enchanted_golden_apple: (c) => {
    recolorSprite(c, 'apple', appleToGold);
    // a baked-in enchantment glint: violet diagonal streaks over the gold
    const img = c.getImageData(0, 0, TILE, TILE);
    const d = img.data;
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const o = (y * TILE + x) * 4;
        if (d[o + 3] === 0) continue;
        // a soft violet sheen in wide diagonal bands, gold still showing through
        const band = (x + y) % 8;
        const k = band === 0 ? 0.34 : band === 1 || band === 7 ? 0.2 : 0.07;
        d[o] = Math.round(d[o] * (1 - k) + 178 * k);
        d[o + 1] = Math.round(d[o + 1] * (1 - k) + 96 * k);
        d[o + 2] = Math.round(d[o + 2] * (1 - k) + 255 * k);
      }
    }
    c.putImageData(img, 0, 0);
  },
  // the water bucket with its water turned to milk
  milk_bucket: (c) => recolorSprite(c, 'water_bucket', (r, g, b) =>
    b > r + 50 ? (b > 220 || g > 90 ? [246, 246, 240] : [214, 214, 204]) : null),
  shears: (c) => {
    // two parallel blades opening toward the top-right, a pivot rivet, and a
    // pair of red finger loops; the outline is traced around whatever is drawn
    const px = new Map<number, string>();
    const put = (x: number, y: number, col: string): void => { px.set(y * TILE + x, col); };
    for (let i = 0; i < 6; i++) {
      put(6 + i, 8 - i, '#f4f4f4'); put(7 + i, 8 - i, '#c4c4c4');          // upper blade
    }
    for (let i = 0; i < 7; i++) {
      const y = 9 - Math.floor((i + 1) / 2);                               // lower blade, shallower
      put(8 + i, y, '#d4d4d4'); put(8 + i, y + 1, '#8e8e8e');
    }
    put(7, 9, '#6e6e6e'); put(6, 9, '#8a8a8a'); put(7, 10, '#8a8a8a');      // pivot
    const ring = (cx: number, cy: number): void => {
      for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) {
        put(cx + dx, cy + dy, dy < 0 || dx < 0 ? '#d24a3a' : '#96281c');
      }
    };
    put(5, 10, '#b8b8b8'); put(6, 11, '#b8b8b8');                             // shanks
    ring(3, 12); ring(6, 13);
    const outline = '#1e1e1e';
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        if (px.has(y * TILE + x)) continue;
        let edge = false;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < TILE && ny < TILE && px.has(ny * TILE + nx)) {
            const col = px.get(ny * TILE + nx)!;
            if (col !== outline) edge = true;
          }
        }
        if (edge && !(x === 3 && y === 12) && !(x === 6 && y === 13)) {
          c.fillStyle = outline;
          c.fillRect(x, y, 1, 1);
        }
      }
    }
    for (const [k, col] of px) { c.fillStyle = col; c.fillRect(k % TILE, Math.floor(k / TILE), 1, 1); }
  },
  shield: (c) => pixmap(c, 0, 0, SHIELD_MAP, {
    O: '#241b10', I: '#b9b9b9', i: '#7c7c7c', P: '#a8834e', p: '#7d5f35',
  }),
  spyglass: (c) => pixmap(c, 0, 0, SPYGLASS_MAP, {
    O: '#2a1c0a', G: '#d9a441', g: '#9c6a1e', D: '#6a4520', d: '#3f2912', A: '#c7a2ff', a: '#8a5ad8',
  }),
};
Object.assign(ITEM_PAINTERS, GAMEPLAY_ITEM_PAINTERS);
Object.assign(PACK_MAP, {
  gold_pickaxe: { paths: ['item/golden_pickaxe'], kind: 'item' },
  gold_axe: { paths: ['item/golden_axe'], kind: 'item' },
  gold_shovel: { paths: ['item/golden_shovel'], kind: 'item' },
  gold_sword: { paths: ['item/golden_sword'], kind: 'item' },
  gold_helmet: { paths: ['item/golden_helmet'], kind: 'item' },
  gold_chest: { paths: ['item/golden_chestplate'], kind: 'item' },
  gold_legs: { paths: ['item/golden_leggings'], kind: 'item' },
  gold_boots: { paths: ['item/golden_boots'], kind: 'item' },
  golden_apple: { paths: ['item/golden_apple'], kind: 'item' },
  enchanted_golden_apple: { paths: ['item/enchanted_golden_apple', 'item/golden_apple'], kind: 'item' },
  milk_bucket: { paths: ['item/milk_bucket'], kind: 'item' },
  shears: { paths: ['item/shears'], kind: 'item' },
  spyglass: { paths: ['item/spyglass'], kind: 'item' },
} satisfies Record<string, PackEntry>);

/** Fire tile: licking flame tongues, white-hot at the base, red at the tips. */
function paintFire(ctx: Ctx, x0: number, y0: number): void {
  let seed = 1723;
  const rand = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const heights = [9, 12, 15, 11, 8, 11, 14, 16, 12, 9, 12, 15, 13, 9, 11, 13];
  const ramp = ['#fff6c4', '#ffe066', '#ffc12a', '#ff9420', '#f2651a', '#c93a14'];
  for (let x = 0; x < TILE; x++) {
    const h = Math.max(4, heights[x] - ((rand() * 3) | 0));
    for (let y = TILE - 1; y >= TILE - h; y--) {
      const t = (TILE - 1 - y) / h; // 0 at the base, ~1 at the tip
      // the upper half frays into separate tongues
      if (t > 0.55 && rand() < (t - 0.55) * 0.9) continue;
      const i = Math.min(ramp.length - 1, Math.floor(t * ramp.length + (rand() - 0.5) * 1.2));
      ctx.fillStyle = ramp[Math.max(0, i)];
      ctx.fillRect(x0 + x, y0 + y, 1, 1);
    }
  }
}
Object.assign(TILE_PAINTERS, { fire: paintFire });
Object.assign(PACK_MAP, {
  fire: { paths: ['block/fire_0', 'block/fire_layer_0'], kind: 'tile' },
} satisfies Record<string, PackEntry>);

// --- decorative / storage block tiles (bookshelf, hay, coal/quartz/emerald
// blocks, smooth stone) and the paper + book sprites ------------------------

/** Fill a tile from a per-pixel colour function. */
function tileFrom(ctx: Ctx, x0: number, y0: number, px: (x: number, y: number) => string | null): void {
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const col = px(x, y);
      if (!col) continue;
      ctx.fillStyle = col;
      ctx.fillRect(x0 + x, y0 + y, 1, 1);
    }
  }
}

function shadeHex(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number): number => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

function paintBookshelf(ctx: Ctx, x0: number, y0: number): void {
  const rnd = mulberry32(4411);
  const spines = ['#8e2b24', '#2f4f8a', '#3f6e2f', '#7a5a1c', '#6a2e6e', '#a8742a', '#2d6a6a', '#b23c2c'];
  // per shelf row: a run of book spines of random widths/heights
  const books: { col: string; top: number }[][] = [[], []];
  for (let r = 0; r < 2; r++) {
    let x = 1;
    while (x < 15) {
      const w = 1 + ((rnd() * 2.4) | 0);
      const col = spines[(rnd() * spines.length) | 0];
      const top = (rnd() * 2.2) | 0;
      for (let i = 0; i < w && x < 15; i++, x++) books[r][x] = { col, top };
      if (x < 15 && rnd() < 0.18) { books[r][x] = { col: '', top: 9 }; x++; } // a gap
    }
  }
  tileFrom(ctx, x0, y0, (x, y) => {
    const wood = (k: number): string => shadeHex('#9c7a48', k + (rnd() - 0.5) * 0.08);
    if (y === 0 || y === 15) return wood(0.78);
    if (y === 1 || y === 7 || y === 8) return wood(y === 8 ? 0.72 : 1);
    if (x === 0 || x === 15) return wood(0.85);
    const r = y < 7 ? 0 : 1;
    const rowTop = r === 0 ? 2 : 9;
    const b = books[r][x];
    if (!b || !b.col || y < rowTop + b.top) return '#2a1c10'; // shadowed shelf back
    const edge = x > 1 && books[r][x - 1]?.col !== b.col ? 1.18 : 1;
    const band = y === rowTop + b.top + 1 || y === rowTop + 4 ? 0.7 : 1; // spine bands
    return shadeHex(b.col, edge * band * (1 - (y - rowTop) * 0.03));
  });
}

function paintHaySide(ctx: Ctx, x0: number, y0: number): void {
  const rnd = mulberry32(7823);
  tileFrom(ctx, x0, y0, (x, y) => {
    if (y === 3 || y === 4 || y === 11 || y === 12) {
      return shadeHex('#8a3e1c', y === 4 || y === 12 ? 0.8 : 1.05 + (rnd() - 0.5) * 0.1); // binding twine
    }
    const strand = ((x * 7 + (y >> 2) * 3) % 5) === 0 ? 0.8 : 1;
    return shadeHex('#c9a62c', strand * (0.9 + rnd() * 0.22));
  });
}

function paintHayTop(ctx: Ctx, x0: number, y0: number): void {
  const rnd = mulberry32(9127);
  tileFrom(ctx, x0, y0, (x, y) => {
    const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
    const ring = (Math.floor(d) % 3 === 0) ? 0.82 : 1;
    return shadeHex('#c4a02c', ring * (0.88 + rnd() * 0.24));
  });
}

function paintCoalBlock(ctx: Ctx, x0: number, y0: number): void {
  const rnd = mulberry32(3301);
  tileFrom(ctx, x0, y0, (x, y) => {
    const facet = ((x + y * 3) % 7 === 0 || (x * 5 + y) % 11 === 0) ? 1.9 : 1;
    const edge = x === 0 || y === 0 ? 1.3 : x === 15 || y === 15 ? 0.7 : 1;
    return shadeHex('#1e1e22', facet * edge * (0.85 + rnd() * 0.35));
  });
}

function paintQuartzBlock(ctx: Ctx, x0: number, y0: number): void {
  const rnd = mulberry32(5519);
  tileFrom(ctx, x0, y0, (x, y) => {
    const edge = x === 0 || y === 0 ? 1.03 : x === 15 || y === 15 ? 0.9 : 1;
    const vein = ((x + y) % 9 === 0 && rnd() < 0.5) ? 0.94 : 1;
    return shadeHex('#ece6dc', edge * vein * (0.97 + rnd() * 0.05));
  });
}

function paintEmeraldBlock(ctx: Ctx, x0: number, y0: number): void {
  const rnd = mulberry32(6143);
  tileFrom(ctx, x0, y0, (x, y) => {
    if (x === 0 || y === 0) return '#7df0a6';
    if (x === 15 || y === 15) return '#0f7a3c';
    // a cut-gem lattice of diamond facets
    const u = (x + y) % 8, v = (x - y + 16) % 8;
    const k = u === 0 || v === 0 ? 0.72 : (u < 4) === (v < 4) ? 1.12 : 0.95;
    return shadeHex('#2fc865', k * (0.95 + rnd() * 0.1));
  });
}

function paintSmoothStone(ctx: Ctx, x0: number, y0: number): void {
  const rnd = mulberry32(2203);
  tileFrom(ctx, x0, y0, (x, y) => {
    if (x === 0 || x === 15 || y === 0 || y === 15) return shadeHex('#8e8e8e', 0.92 + rnd() * 0.06);
    return shadeHex('#a9a9a9', 0.96 + rnd() * 0.07);
  });
}

Object.assign(TILE_PAINTERS, {
  bookshelf: paintBookshelf,
  hay_side: paintHaySide,
  hay_top: paintHayTop,
  coal_block: paintCoalBlock,
  quartz_block: paintQuartzBlock,
  emerald_block: paintEmeraldBlock,
  smooth_stone: paintSmoothStone,
});

const PAPER_MAP = [
  '................',
  '................',
  '...OOOOOOOOO....',
  '...OWWWWWWWWO...',
  '...OWwwwwwWWO...',
  '..OWWWWWWWWWO...',
  '..OWwwwwwwWWO...',
  '..OWWWWWWWWO....',
  '..OWwwwwwWWO....',
  '.OWWWWWWWWWO....',
  '.OWwwwwwwWWO....',
  '.OWWWWWWWWO.....',
  '.OOOOOOOOOO.....',
  '................',
  '................',
  '................',
];
const BOOK_MAP = [
  '................',
  '................',
  '....OOOOOOOOO...',
  '...OLLLLLLLLPO..',
  '...OLGGGGGLLPO..',
  '..OLLLLLLLLPPO..',
  '..OLLLLLLLLPO...',
  '..OLLLLLLLPPO...',
  '.OLLLLLLLLPO....',
  '.OLLLLLLLPPO....',
  '.ODLLLLLLPO.....',
  '.ODDDDDDDPO.....',
  '..OOOOOOOOO.....',
  '................',
  '................',
  '................',
];
Object.assign(ITEM_PAINTERS, {
  paper: (c: Ctx) => pixmap(c, 0, 0, PAPER_MAP, { O: '#6f6a5c', W: '#f4f1e6', w: '#cfcab8' }),
  book: (c: Ctx) => pixmap(c, 0, 0, BOOK_MAP, { O: '#2a1408', L: '#7a3c1c', D: '#4c220e', G: '#d8b24a', P: '#efe9d6' }),
});
Object.assign(PACK_MAP, {
  bookshelf: { paths: ['block/bookshelf'], kind: 'tile' },
  hay_side: { paths: ['block/hay_block_side'], kind: 'tile' },
  hay_top: { paths: ['block/hay_block_top'], kind: 'tile' },
  coal_block: { paths: ['block/coal_block'], kind: 'tile' },
  quartz_block: { paths: ['block/quartz_block_side'], kind: 'tile' },
  emerald_block: { paths: ['block/emerald_block'], kind: 'tile' },
  smooth_stone: { paths: ['block/smooth_stone'], kind: 'tile' },
  paper: { paths: ['item/paper'], kind: 'item' },
  book: { paths: ['item/book'], kind: 'item' },
} satisfies Record<string, PackEntry>);

// =============================================================================
// Building + decoration pass: tiles for masonry, ice, pumpkins/melons, coloured
// wool, garden plants and the shaped utility blocks (lantern, anvil, cake ...),
// item sprites for the new foods, potions, dyes and exploration gear, the
// inventory icon shapes for partial blocks, and the in-hand/dropped geometry
// of shaped blocks. Self-contained: it only reads the shared pixel toolkit.
// =============================================================================

/** `col` scaled by k as an RGB triple (Px.set wants hex or RGB, not shadeHex's rgb() string). */
const shadeRGB = (col: string, k: number): RGB => shade(hex(col), k).map((v) => Math.max(0, Math.min(255, v))) as RGB;

/** Speckle moss over a tile (mossy cobble / stone bricks). */
function mossOver(p: Px, seed: number, amount: number): Px {
  const f = fbm(seed, [[4, 0.55], [8, 0.3], [16, 0.15]], 1.9);
  const r = mulberry32(seed + 7);
  const moss = pal(['#3c5a1e', '#4a6b24', '#58802c', '#679334', '#78a43e']);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const v = f(x, y) + (r() - 0.5) * 0.28 + (y / 15) * 0.12; // moss pools low
      if (v < 1 - amount) continue;
      const k = (v - (1 - amount)) / amount;
      p.set(x, y, moss[clampI(k * moss.length + (r() - 0.5) * 1.4, moss.length)]);
    }
  }
  return p;
}

/** Random-walk cracks: a dark fissure with a lit lip above it. */
function cracksOver(p: Px, seed: number, n: number, dark: RGB, lip: RGB): Px {
  const r = mulberry32(seed);
  for (let i = 0; i < n; i++) {
    let x = (r() * 16) | 0, y = (r() * 16) | 0;
    const len = 5 + ((r() * 6) | 0);
    const dx = r() < 0.5 ? 1 : -1;
    for (let k = 0; k < len; k++) {
      p.set(x, y, dark);
      if (r() < 0.6) p.set(x, y - 1, lip);
      if (r() < 0.55) x += dx; else y += 1;
    }
  }
  return p;
}

const BRICK_R = pal(['#6e2c1e', '#7d3424', '#8c3c2a', '#994630', '#a55037', '#b05b40']);
const PUMPKIN_R = pal(['#8e470a', '#a4560d', '#bb6710', '#cf7815', '#df8b1d', '#eca028']);
const MELON_R = pal(['#3f6612', '#4d7a17', '#5b8c1c', '#6b9e22', '#7eb02a']);
const ICE_R = pal(['#7fa8f0', '#8db3f3', '#9bbdf5', '#a9c7f7', '#b8d2fa', '#cadefc']);
const IRON_DARK = pal(['#23262b', '#2f3338', '#3b4046', '#4a5058', '#5c636c', '#737b85']);

function pumpkinSidePx(seed: number): Px {
  const r = mulberry32(seed);
  const n = tileNoise(seed + 1, 4, 8);
  return new Px().fill((x, y) => {
    const k = x & 3; // four ribs across the face, a groove between each
    let i = k === 0 ? 0.6 : k === 1 ? 2.6 : k === 2 ? 3.6 : 2.2;
    i += (n(x, y) - 0.5) * 1.4 + (r() - 0.5) * 0.6;
    if (y === 0 || y === 15) i -= 1.2; // rounded top/bottom shade
    else if (y === 1 || y === 14) i -= 0.5;
    return PUMPKIN_R[clampI(i, PUMPKIN_R.length)];
  });
}

function pumpkinTopPx(): Px {
  const r = mulberry32(8811);
  const p = new Px().fill((x, y) => {
    const a = Math.atan2(y - 7.5, x - 7.5), d = Math.hypot(x - 7.5, y - 7.5);
    const rib = ((a / (Math.PI * 2) + 1) * 8) % 1; // eight segments meeting at the stem
    let i = 1.5 + Math.sin(rib * Math.PI) * 2.6 - d * 0.08 + (r() - 0.5) * 0.7;
    if (rib < 0.12 || rib > 0.88) i -= 1.4;
    return PUMPKIN_R[clampI(i, PUMPKIN_R.length)];
  });
  // woody stem in the middle
  for (const [x, y, c] of [[7, 7, '#5b6b1c'], [8, 7, '#4a5816'], [7, 8, '#6f7f22'], [8, 8, '#3c4712'],
    [6, 7, '#73481c'], [9, 8, '#73481c'], [7, 6, '#73481c'], [8, 9, '#5a3814']] as [number, number, string][]) p.set(x, y, c);
  return p;
}

function jackFacePx(): Px {
  const p = pumpkinSidePx(8812);
  const face = [
    '................', '................', '................', '....#......#....',
    '...###....###...', '..#####..#####..', '................', '.......##.......',
    '................', '.##..######..##.', '.##############.', '..############..',
    '...##.####.##...', '................', '................', '................',
  ];
  // carve: bright candle-lit interior, darker rind at the cut edge
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      if (face[y][x] !== '#') continue;
      const edge = face[y - 1]?.[x] !== '#' || face[y + 1]?.[x] !== '#' || face[y][x - 1] !== '#' || face[y][x + 1] !== '#';
      p.set(x, y, edge ? '#f7a823' : y > 8 ? '#ffe36b' : '#ffd24a');
    }
  }
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      if (face[y][x] === '#') continue;
      if (face[y - 1]?.[x] === '#') p.set(x, y, '#6a3206'); // shadow under the cut
    }
  }
  return p;
}

function melonSidePx(): Px {
  const r = mulberry32(8813);
  const wob = tileNoise(8814, 1, 4);
  return new Px().fill((x, y) => {
    const s = (x + Math.round((wob(0, y) - 0.5) * 3) + 16) % 5;
    if (s === 0) return mixC(MELON_R[4], hex('#c9d964'), 0.55 + r() * 0.2);
    if (s === 1) return MELON_R[3];
    return MELON_R[clampI(1 + r() * 2.2, MELON_R.length)];
  });
}

function melonTopPx(): Px {
  const r = mulberry32(8815);
  const p = new Px().fill((x, y) => {
    const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
    const ring = Math.floor(d) % 3 === 0;
    return ring ? mixC(MELON_R[4], hex('#c9d964'), 0.4) : MELON_R[clampI(1 + r() * 2.4, MELON_R.length)];
  });
  p.set(7, 7, '#6b5a1c'); p.set(8, 8, '#4f4214'); p.set(8, 7, '#7d6a24'); p.set(7, 8, '#5a4b18');
  return p;
}

/** Recolour the white wool tile to `col`, keeping its weave. */
function dyedWool(ctx: Ctx, x0: number, y0: number, col: string): void {
  const [tmp, tctx] = makeCanvas(16, 16);
  TILE_PAINTERS.wool(tctx, 0, 0);
  const img = tctx.getImageData(0, 0, 16, 16);
  const d = img.data;
  const [cr, cg, cb] = hex(col);
  for (let i = 0; i < d.length; i += 4) {
    const t = Math.max(0, Math.min(1, (d[i] / 255 - 0.79) / 0.18)); // weave brightness 0..1
    const k = 0.78 + t * 0.36;
    d[i] = Math.min(255, cr * k + t * 10);
    d[i + 1] = Math.min(255, cg * k + t * 10);
    d[i + 2] = Math.min(255, cb * k + t * 10);
  }
  tctx.putImageData(img, 0, 0);
  ctx.drawImage(tmp, x0, y0);
}

/** Crossed-billboard plant from a pixel map (transparent background). */
function plantTile(rows: string[], colors: Record<string, string>): (c: Ctx, x: number, y: number) => void {
  return (c, x, y) => { c.clearRect(x, y, 16, 16); pixmap(c, x, y, rows, colors); };
}
const STEM_G = { G: '#4f8f2e', g: '#2f6a1e', l: '#78b43e' };

/** Log with horizontal grain (the long faces of a campfire log). */
function campLogPx(): Px {
  const ramp = pal(['#2e2012', '#3d2b18', '#4b361e', '#5a4326', '#6a502e']);
  const f = fbm(8820, [[1, 0.5, 8], [2, 0.5, 16]], 2);
  const r = mulberry32(8821);
  return new Px().fill((x, y) => ramp[clampI(f(x, y) * ramp.length + (r() - 0.5) * 0.8 - ((y & 3) === 3 ? 1.4 : 0), ramp.length)]);
}

const DECOR_TILE_PAINTERS: Record<string, (ctx: Ctx, x: number, y: number) => void> = {
  bricks: (c, x, y) => bricksPx(BRICK_R, hex('#a9a095'), 8, 4, 8801, 1.14, 0.84).put(c, x, y),
  clay: (c, x, y) => {
    const ramp = pal(['#8b91a0', '#939aa8', '#9aa1ae', '#a1a7b4', '#a8aeba', '#afb5c1']);
    const p = rampFill(new Px(), ramp, fbm(8802, [[4, 0.5], [8, 0.3], [16, 0.2]], 1.3), 8803, 0.3);
    const r = mulberry32(8804);
    for (let i = 0; i < 6; i++) { const px = (r() * 16) | 0, py = (r() * 16) | 0; p.set(px, py, ramp[0]); p.set(px, py - 1, ramp[5]); }
    p.put(c, x, y);
  },
  mossy_cobble: (c, x, y) => mossOver(cobblePx(8805), 8806, 0.42).put(c, x, y),
  mossy_stone_bricks: (c, x, y) => mossOver(bricksPx(STONE_R, hex('#4a4a4a'), 16, 8, 122, 1.14, 0.84), 8807, 0.36).put(c, x, y),
  cracked_stone_bricks: (c, x, y) => cracksOver(bricksPx(STONE_R, hex('#4a4a4a'), 16, 8, 122, 1.14, 0.84), 8808, 4,
    hex('#3a3a3a'), hex('#9c9c9c')).put(c, x, y),
  chiseled_stone_bricks: (c, x, y) => {
    const p = stonePx(8809);
    for (let i = 0; i < 16; i++) {
      p.set(i, 0, STONE_R[6]); p.set(0, i, STONE_R[6]); p.set(i, 15, '#4a4a4a'); p.set(15, i, '#4a4a4a');
      p.set(i, 1, STONE_R[5]); p.set(1, i, STONE_R[5]); p.set(i, 14, STONE_R[1]); p.set(14, i, STONE_R[1]);
    }
    // a carved roundel: dark groove, lit on the lower-right lip
    for (let yy = 2; yy < 14; yy++) {
      for (let xx = 2; xx < 14; xx++) {
        const d = Math.hypot(xx - 7.5, yy - 7.5);
        if (d > 4.3 && d < 5.4) p.set(xx, yy, xx + yy > 15 ? STONE_R[6] : STONE_R[0]);
        else if (d < 1.6) p.set(xx, yy, xx + yy > 15 ? STONE_R[1] : STONE_R[6]);
      }
    }
    p.put(c, x, y);
  },
  ice: (c, x, y) => {
    const f = fbm(8830, [[2, 0.5, 4], [4, 0.3], [16, 0.2]], 1.4);
    const p = rampFill(new Px(), ICE_R, f, 8831, 0.18);
    // long diagonal glints + a few frozen bubbles
    for (let i = 0; i < 6; i++) { p.set(3 + i, 12 - i, '#e6f0ff'); p.set(9 + i, 14 - i, '#dce9fe'); }
    for (let i = 0; i < 3; i++) p.set(10 + i, 4 - i, '#eef5ff');
    cracksOver(p, 8832, 2, hex('#6b93dc'), hex('#d7e6fd'));
    p.put(c, x, y);
  },
  packed_ice: (c, x, y) => {
    const ramp = pal(['#7c9fe0', '#86a8e6', '#90b1eb', '#9abaef', '#a4c2f2']);
    const p = rampFill(new Px(), ramp, fbm(8833, [[8, 0.5], [16, 0.5]], 1.1), 8834, 0.5);
    const r = mulberry32(8835);
    for (let i = 0; i < 9; i++) p.set((r() * 16) | 0, (r() * 16) | 0, '#c4d8f8');
    p.put(c, x, y);
  },
  terracotta: (c, x, y) => {
    const ramp = pal(['#8a4a31', '#935036', '#99563a', '#9f5c3f', '#a66343']);
    rampFill(new Px(), ramp, fbm(8836, [[4, 0.5], [16, 0.5]], 1.1), 8837, 0.4).put(c, x, y);
  },
  pumpkin_side: (c, x, y) => pumpkinSidePx(8810).put(c, x, y),
  pumpkin_top: (c, x, y) => pumpkinTopPx().put(c, x, y),
  jack_o_lantern: (c, x, y) => jackFacePx().put(c, x, y),
  melon_side: (c, x, y) => melonSidePx().put(c, x, y),
  melon_top: (c, x, y) => melonTopPx().put(c, x, y),
  pumpkin_stem: plantTile([
    '................', '................', '................', '........ll......',
    '.......lGGl.....', '......lGg..l....', '.......G..G.....', '.......G...Gg...',
    '.......Gg..gG...', '......gG........', '...GG.G.........', '..GlgGG.........',
    '....gG..........', '.....G..........', '.....Gg.........', '.....Gg.........',
  ], STEM_G),
  melon_stem: plantTile([
    '................', '................', '................', '.......ll.......',
    '......lGGl......', '.....lG..gl.....', '......G...G.....', '......Gg...G....',
    '.......G...gG...', '.......Gg.......', '..GG....G.......', '.GlgGG..G.......',
    '....gGG.G.......', '.......GG.......', '.......Gg.......', '.......Gg.......',
  ], { G: '#5f9b2c', g: '#3b7420', l: '#9cc84c' }),
  cornflower: plantTile([
    '................', '................', '......B.b.......', '.....bBLBb......',
    '....BLBwBLB.....', '.....bBLBb......', '......b.B.......', '.......G........',
    '......gG........', '.......G.g......', '.....g.GGg......', '.....gGG........',
    '.......G........', '.......G........', '.......g........', '................',
  ], { B: '#4a6ee0', b: '#2f47a8', L: '#8fb0ff', w: '#e8f0ff', G: '#4f8f2e', g: '#2f6a1e' }),
  allium: plantTile([
    '................', '......pPp.......', '.....pPLPp......', '....pPLPPPp.....',
    '....PPPPPLP.....', '....pPLPPPp.....', '.....pPPPp......', '......pGp.......',
    '.......G........', '.......G........', '.......G........', '.....g.G........',
    '.....gGG.g......', '.......GGg......', '.......G........', '.......g........',
  ], { P: '#b35fe0', p: '#7d3aa8', L: '#e0a8ff', G: '#4f8f2e', g: '#2f6a1e' }),
  oxeye_daisy: plantTile([
    '................', '................', '.......W........', '....W.WwW.W.....',
    '.....WwYYwW.....', '....WwYyYYwW....', '.....WwYYwW.....', '....W.WwW.W.....',
    '.......G........', '.......G.g......', '......gGGg......', '.......G........',
    '......gG........', '.......G........', '.......g........', '................',
  ], { W: '#f4f4f0', w: '#cfd0c8', Y: '#f2c82a', y: '#c99a14', G: '#4f8f2e', g: '#2f6a1e' }),
  brown_mushroom: plantTile([
    '................', '................', '................', '................',
    '................', '................', '................', '.....bbbbbb.....',
    '...bBBLLBBBBb...', '..bBBBBBBBBBBb..', '..dddddddddddd..', '......sSs.......',
    '......sSs.......', '......sSs.......', '......sSs.......', '................',
  ], { B: '#9a6a48', b: '#7a5034', L: '#c09070', d: '#5c3a26', s: '#c8bca4', S: '#e4dac4' }),
  red_mushroom: plantTile([
    '................', '................', '................', '................',
    '................', '......rrrr......', '....rRWRRWRr....', '...rRRRRRRRWr...',
    '...RWRRRWRRRR...', '...dddddddddd...', '......sSs.......', '......sSs.......',
    '......sSs.......', '......sSs.......', '......sSs.......', '................',
  ], { R: '#d2261e', r: '#a31a14', W: '#f2ecec', d: '#7a120e', s: '#c8bca4', S: '#e4dac4' }),
  // flat lantern (inventory icon + held model): hook, cap, glowing glass, base
  lantern: plantTile([
    '................', '.......oo.......', '......o..o......', '.......oo.......',
    '......OOOO......', '.....OMMMMO.....', '....OmmmmmmO....', '....OyGGGGyO....',
    '....OyGWWGyO....', '....OyGWWGyO....', '....OyGGGGyO....', '....OmmmmmmO....',
    '....OOOOOOOO....', '................', '................', '................',
  ], { o: '#3b4046', O: '#23262b', M: '#5c636c', m: '#4a5058', y: '#f2b53a', G: '#ffe58a', W: '#fff7cf' }),
  // lantern model faces (UVs follow the model's pixel positions)
  lantern_model: (c, x, y) => {
    const p = new Px(); // starts fully transparent
    for (let yy = 0; yy <= 6; yy++) { p.set(7, yy, yy % 3 === 2 ? IRON_DARK[1] : IRON_DARK[3]); p.set(8, yy, yy % 3 === 0 ? IRON_DARK[1] : IRON_DARK[4]); }
    for (let xx = 6; xx <= 9; xx++) { p.set(xx, 7, IRON_DARK[4]); p.set(xx, 8, IRON_DARK[2]); }
    for (let xx = 5; xx <= 10; xx++) { p.set(xx, 9, IRON_DARK[3]); p.set(xx, 15, IRON_DARK[2]); }
    for (let yy = 10; yy <= 14; yy++) {
      p.set(5, yy, IRON_DARK[1]); p.set(10, yy, IRON_DARK[1]);
      for (let xx = 6; xx <= 9; xx++) p.set(xx, yy, (xx === 7 || xx === 8) && yy >= 11 && yy <= 13 ? '#fff7cf' : xx === 6 || xx === 9 ? '#f2b53a' : '#ffe58a');
    }
    p.put(c, x, y);
  },
  lantern_model_top: (c, x, y) => new Px().fill((xx, yy) => {
    const e = xx === 5 || xx === 10 || yy === 5 || yy === 10;
    return e ? IRON_DARK[2] : (xx === 7 || xx === 8) && (yy === 7 || yy === 8) ? IRON_DARK[0] : IRON_DARK[4];
  }).put(c, x, y),
  glass_pane_top: (c, x, y) => new Px().fill((xx, yy) =>
    (xx === 7 || xx === 8 || yy === 7 || yy === 8) ? (xx === 7 || yy === 7 ? '#e8f4f8' : '#bcd8e0') : '#a7c9d4').put(c, x, y),
  smooth_stone_slab_side: (c, x, y) => {
    const r = mulberry32(8840);
    new Px().fill((xx, yy) => {
      const h = yy & 7; // two stacked half-height plates
      if (h === 0) return shadeRGB('#b8b8b8', 0.98 + r() * 0.04);
      if (h === 7) return shadeRGB('#7c7c7c', 0.96 + r() * 0.06);
      if (xx === 0) return shadeRGB('#b0b0b0', 1);
      if (xx === 15) return shadeRGB('#8a8a8a', 1);
      return shadeRGB('#a4a4a4', 0.96 + r() * 0.07);
    }).put(c, x, y);
  },
  anvil: (c, x, y) => {
    const f = fbm(8841, [[4, 0.5], [8, 0.5]], 1.2);
    const p = rampFill(new Px(), IRON_DARK.slice(1), f, 8842, 0.35);
    for (let i = 0; i < 16; i++) { p.set(i, 0, IRON_DARK[5]); p.set(i, 15, IRON_DARK[0]); }
    p.put(c, x, y);
  },
  anvil_top: (c, x, y) => {
    const f = fbm(8843, [[8, 0.5], [16, 0.5]], 1.1);
    const p = rampFill(new Px(), IRON_DARK.slice(2), f, 8844, 0.3);
    for (let yy = 4; yy <= 11; yy++) for (let xx = 2; xx <= 13; xx++) p.set(xx, yy, yy === 4 ? IRON_DARK[1] : yy === 11 ? IRON_DARK[5] : IRON_DARK[3]);
    p.put(c, x, y);
  },
  enchanting_table_top: (c, x, y) => {
    const p = new Px().fill((xx, yy) => ((xx + yy) & 1 ? '#a32b2b' : '#b53434'));
    for (let i = 0; i < 16; i++) {
      p.set(i, 0, '#6e1a1a'); p.set(0, i, '#6e1a1a'); p.set(i, 15, '#4d1010'); p.set(15, i, '#4d1010');
    }
    for (const [cx, cy] of [[2, 2], [13, 2], [2, 13], [13, 13]]) { // diamond corners
      p.set(cx, cy, '#6ef3e0'); p.set(cx + 1, cy, '#2ec0b0'); p.set(cx, cy + 1, '#2ec0b0'); p.set(cx - 1, cy, '#b8fff4'); p.set(cx, cy - 1, '#b8fff4');
    }
    for (let i = 5; i <= 10; i++) { p.set(i, 5, '#d8b24a'); p.set(i, 10, '#a8842a'); p.set(5, i, '#d8b24a'); p.set(10, i, '#a8842a'); }
    p.put(c, x, y);
  },
  enchanting_table_side: (c, x, y) => {
    const ob = pal(['#0c0913', '#141020', '#1c162a', '#241d36', '#2f2544']);
    const p = rampFill(new Px(), ob, fbm(8845, [[4, 0.5], [8, 0.5]], 1.8), 8846, 0.25);
    // the red cloth drapes over the top quarter, with a gold hem
    for (let yy = 4; yy <= 7; yy++) for (let xx = 0; xx < 16; xx++) p.set(xx, yy, yy === 7 ? '#d8b24a' : (xx + yy) & 1 ? '#a32b2b' : '#b53434');
    for (const xx of [1, 5, 10, 14]) { p.set(xx, 8, '#8a2020'); p.set(xx, 9, '#6e1a1a'); }
    p.set(3, 12, '#6ef3e0'); p.set(12, 12, '#6ef3e0'); p.set(4, 12, '#2ec0b0'); p.set(13, 12, '#2ec0b0');
    p.put(c, x, y);
  },
  ench_book: (c, x, y) => new Px().fill((xx, yy) => {
    if (xx === 7 || xx === 8) return '#5a1a10';
    const edge = xx === 0 || xx === 15 || yy === 0 || yy === 15;
    return edge ? '#7a2a18' : (yy % 3 === 1 ? '#c9c2a8' : '#efe9d6');
  }).put(c, x, y),
  barrel_side: (c, x, y) => {
    const p = planksPx(pal(['#6b4a24', '#7a552a', '#886031', '#946a38', '#a0743f', '#aa7e46']), hex('#4c3418'), 8847);
    // rotate the boards upright: vertical staves read as a cask
    const q = new Px();
    for (let yy = 0; yy < 16; yy++) for (let xx = 0; xx < 16; xx++) q.set(xx, yy, p.get(yy, xx));
    for (const band of [2, 13]) for (let xx = 0; xx < 16; xx++) { q.set(xx, band, IRON_DARK[3]); q.set(xx, band + 1, IRON_DARK[1]); }
    q.put(c, x, y);
  },
  barrel_top: (c, x, y) => {
    const p = planksPx(pal(['#7a552a', '#886031', '#946a38', '#a0743f', '#aa7e46', '#b4884e']), hex('#5a3e1e'), 8848);
    for (let i = 0; i < 16; i++) { p.set(i, 0, IRON_DARK[2]); p.set(0, i, IRON_DARK[2]); p.set(i, 15, IRON_DARK[1]); p.set(15, i, IRON_DARK[1]); }
    for (let yy = 6; yy <= 9; yy++) for (let xx = 6; xx <= 9; xx++) p.set(xx, yy, yy === 6 || xx === 6 ? '#2a1c0c' : '#3a2812');
    p.put(c, x, y);
  },
  barrel_bottom: (c, x, y) => {
    const p = planksPx(pal(['#6b4a24', '#7a552a', '#886031', '#946a38', '#a0743f', '#aa7e46']), hex('#4c3418'), 8849);
    for (let i = 0; i < 16; i++) { p.set(i, 0, IRON_DARK[2]); p.set(0, i, IRON_DARK[2]); p.set(i, 15, IRON_DARK[1]); p.set(15, i, IRON_DARK[1]); }
    p.put(c, x, y);
  },
  campfire_log: (c, x, y) => campLogPx().put(c, x, y),
  campfire_log_end: (c, x, y) => ringsPx(pal(['#2e2012', '#3d2b18', '#4b361e', '#5a4326']),
    pal(['#6a4a26', '#8a6436', '#9c7442', '#a8804c']), 8822).put(c, x, y),
  campfire_ash: (c, x, y) => {
    const r = mulberry32(8823);
    new Px().fill(() => {
      const v = r();
      return v < 0.12 ? '#ff8a1e' : v < 0.2 ? '#c24a12' : v < 0.55 ? '#3a3533' : '#57504c';
    }).put(c, x, y);
  },
  cake_top: (c, x, y) => {
    const r = mulberry32(8850);
    const p = new Px().fill(() => (r() < 0.2 ? '#e9e3de' : '#f7f3ef'));
    for (const [cx, cy] of [[3, 4], [8, 3], [12, 6], [5, 9], [10, 11], [3, 13], [13, 13]]) { p.set(cx, cy, '#d8232a'); p.set(cx + 1, cy, '#a3161b'); }
    p.put(c, x, y);
  },
  cake_side: (c, x, y) => {
    const r = mulberry32(8851);
    new Px().fill((xx, yy) => {
      const h = yy & 7; // icing band + drips over sponge (both half-heights)
      const drip = h === 2 && (xx % 5 === 1 || xx % 7 === 3);
      if (h <= 1 || drip) return h === 0 ? '#fbf8f5' : '#e6e0da';
      return shadeRGB(r() < 0.25 ? '#b0703a' : '#c27d44', h === 7 ? 0.8 : 1);
    }).put(c, x, y);
  },
  cake_inner: (c, x, y) => {
    const r = mulberry32(8852);
    new Px().fill((xx, yy) => {
      const h = yy & 7;
      if (h <= 1) return h === 0 ? '#fbf8f5' : '#e6e0da';
      if (h === 4) return '#d8232a'; // jam layer
      return r() < 0.3 ? '#e6c28a' : '#f0d09c';
    }).put(c, x, y);
  },
  cake_bottom: (c, x, y) => new Px().fill(() => '#a8683a').put(c, x, y),
  flower_pot: (c, x, y) => {
    const r = mulberry32(8853);
    new Px().fill((xx, yy) => {
      if (yy === 10) return '#8a4028'; // rim lip
      if (yy === 11) return '#6a2e1c';
      const lit = xx <= 6 ? 1.1 : xx >= 9 ? 0.86 : 1;
      return shadeRGB(r() < 0.2 ? '#8e4a30' : '#9c5236', lit);
    }).put(c, x, y);
  },
  flower_pot_top: (c, x, y) => new Px().fill((xx, yy) => {
    const rim = xx === 5 || xx === 10 || yy === 5 || yy === 10;
    return rim ? '#8a4028' : ((xx * 7 + yy * 3) % 5 === 0 ? '#3a2616' : '#4b3220');
  }).put(c, x, y),
  composter_side: (c, x, y) => {
    const p = planksPx(pal(['#6b4a24', '#7a552a', '#886031', '#946a38', '#a0743f', '#aa7e46']), hex('#4c3418'), 8854);
    for (let i = 0; i < 16; i++) { p.set(i, 0, '#5a3e1e'); p.set(0, i, '#5a3e1e'); p.set(i, 15, '#3e2a12'); p.set(15, i, '#3e2a12'); }
    p.put(c, x, y);
  },
  composter_top: (c, x, y) => new Px().fill((xx, yy) => {
    const rim = xx < 2 || xx > 13 || yy < 2 || yy > 13;
    return rim ? ((xx + yy) & 1 ? '#946a38' : '#886031') : '#2a1c0c';
  }).put(c, x, y),
  composter_bottom: (c, x, y) => planksPx(pal(['#6b4a24', '#7a552a', '#886031', '#946a38', '#a0743f', '#aa7e46']), hex('#4c3418'), 8855).put(c, x, y),
  compost: (c, x, y) => {
    const r = mulberry32(8856);
    new Px().fill(() => {
      const v = r();
      return v < 0.15 ? '#6a8a2a' : v < 0.3 ? '#4f6a1e' : v < 0.65 ? '#4a3420' : '#5c4228';
    }).put(c, x, y);
  },
  compost_ready: (c, x, y) => {
    const r = mulberry32(8857);
    new Px().fill(() => {
      const v = r();
      return v < 0.28 ? '#ecebe4' : v < 0.4 ? '#c8c6bc' : v < 0.7 ? '#4a3420' : '#5c4228';
    }).put(c, x, y);
  },
};
for (const [, , stem, , col] of WOOL_COLORS) {
  DECOR_TILE_PAINTERS[`${stem}_wool`] = (c, x, y) => dyedWool(c, x, y, col);
}
Object.assign(TILE_PAINTERS, DECOR_TILE_PAINTERS);

// --- item sprites -------------------------------------------------------------

/** Glass bottle with liquid `liq` (null = empty); `glint` adds sparkles. */
function bottlePx(liq: string | null, glint = false): Px {
  const rows = [
    '................', '.......cc.......', '.......CC.......', '......gCCg......',
    '......gnng......', '.....gnnnng.....', '....giiiiiig....', '...giiiiiiiig...',
    '...giiiiiiiig...', '...giiiiiiiig...', '...giiiiiiiig...', '....giiiiiig....',
    '.....gggggg.....', '................', '................', '................',
  ];
  const p = spritePx(rows, { c: '#8a6038', C: '#b88a58', g: '#d4e6f0' });
  const [lr, lg, lb] = liq ? hex(liq) : [0, 0, 0];
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const ch = rows[y][x];
      if (ch === 'n' || (ch === 'i' && !liq)) p.set(x, y, '#eef6fa', 90);
      else if (ch === 'i') {
        const k = y === 6 ? 1.3 : x <= 5 ? 1.12 : x >= 10 ? 0.74 : 1;
        p.set(x, y, [Math.min(255, lr * k + (y === 6 ? 20 : 0)), Math.min(255, lg * k + (y === 6 ? 20 : 0)), Math.min(255, lb * k + (y === 6 ? 20 : 0))]);
      }
    }
  }
  p.set(5, 7, '#ffffff'); p.set(5, 8, '#ffffff'); p.set(6, 8, liq ? '#ffffff' : '#f4fbff');
  if (glint) { p.set(12, 3, '#fff7a0'); p.set(13, 6, '#fff7a0'); p.set(2, 4, '#d8ff8a'); }
  return outlinePx(p, 0.4);
}

/** Round dye blob in a colour (a soft pile of powder). */
function dyePx(col: string): Px {
  const [r, g, b] = hex(col);
  const c = (k: number): RGB => [Math.min(255, r * k + 18 * Math.max(0, k - 1)), Math.min(255, g * k + 18 * Math.max(0, k - 1)), Math.min(255, b * k + 18 * Math.max(0, k - 1))];
  const rows = [
    '................', '................', '................', '................',
    '.......hh.......', '.....hhHHm......', '....hHHHHHm.....', '...hHHHMMMMm....',
    '...hHHMMMMMm....', '..hHHMMMMMMmm...', '..HHMMMMMMMmm...', '..mMMMMMMMmmm...',
    '...mmmmmmmmm....', '................', '................', '................',
  ];
  const p = spritePx(rows, {});
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const ch = rows[y][x];
      if (ch === 'h') p.set(x, y, c(1.35)); else if (ch === 'H') p.set(x, y, c(1.12));
      else if (ch === 'M') p.set(x, y, c(1)); else if (ch === 'm') p.set(x, y, c(0.72));
    }
  }
  return outlinePx(p, 0.4);
}

const DECOR_ITEM_PAINTERS: Record<string, (ctx: Ctx) => void> = {
  clay_ball: (c) => outlinePx(spritePx([
    '................', '................', '................', '................',
    '.......hhh......', '.....hhHHHm.....', '....hHHHHHHm....', '....hHHHMHHm....',
    '....HHHMMMHm....', '....mHMMMMmm....', '.....mmMMmm.....', '.......mm.......',
    '................', '................', '................', '................',
  ], { h: '#c4c9d4', H: '#a9afbc', M: '#949aa8', m: '#7c8290' }), 0.4).put(c, 0, 0),
  brick: (c) => pixmap(c, 0, 0, [
    '................', '................', '................', '................',
    '................', '....OOOOOOO.....', '...OLLLLLLMO....', '..OLLMMMMMMMO...',
    '..OLMMMMMMMmO...', '.OMMMMMMMmmO....', '.OMmmmmmmmmO....', '..OOOOOOOOO.....',
    '................', '................', '................', '................',
  ], { O: '#3e160c', M: '#a8492e', m: '#7c3220', L: '#c8664a' }),
  snowball: (c) => outlinePx(spritePx([
    '................', '................', '................', '................',
    '......hhhh......', '.....hWWWWs.....', '....hWWWWWWs....', '....hWWWWWWs....',
    '....WWWWWWss....', '....sWWWWsss....', '.....sssss......', '................',
    '................', '................', '................', '................',
  ], { h: '#ffffff', W: '#eef4fb', s: '#b9cde4' }), 0.5).put(c, 0, 0),
  sugar: (c) => outlinePx(spritePx([
    '................', '................', '................', '................',
    '................', '.......w........', '.....w.W.w......', '....wWWWWWw.....',
    '...wWWsWWWWw....', '...WWWWWWsWW....', '..wWsWWWWWWWw...', '..sssssssssss...',
    '................', '................', '................', '................',
  ], { W: '#fbfbfb', w: '#e4e4e8', s: '#c4c4cc' }), 0.45).put(c, 0, 0),
  cookie: (c) => outlinePx(spritePx([
    '................', '................', '................', '.....hhhhh......',
    '....hCCCCCc.....', '...hCCdCCCCc....', '...CCCCCCdCc....', '..hCdCCCCCCCc...',
    '..CCCCCdCCCCc...', '..CCCCCCCCdCc...', '...CdCCCCCCc....', '...cCCCdCCcc....',
    '....cccccccc....', '................', '................', '................',
  ], { h: '#e0a45c', C: '#c98442', c: '#9a5e2a', d: '#4a2410' }), 0.4).put(c, 0, 0),
  pumpkin_pie: (c) => outlinePx(spritePx([
    '................', '................', '................', '................',
    '................', '.....cccccc.....', '....cFFFFFFc....', '...cFFfFFfFFc...',
    '..cFFFFFFFFFFc..', '..CFFFFfFFFFFC..', '..CCcccccccCCC..', '...CCCCCCCCCC...',
    '....bbbbbbbb....', '................', '................', '................',
  ], { F: '#e08a2a', f: '#f2b04e', c: '#e2b774', C: '#c68e48', b: '#8e5a24' }), 0.4).put(c, 0, 0),
  melon_slice: (c) => outlinePx(spritePx([
    '................', '................', '................', '................',
    '................', '..g..........g..', '..gR........Rg..', '..gRR.K..K.RRg..',
    '..glRRRRRRRRlg..', '...glRRKRRRlg...', '....glRRRRlg....', '.....gllllg.....',
    '......gggg......', '................', '................', '................',
  ], { g: '#3f7a1a', l: '#b6d46a', R: '#e4413a', K: '#24120e' }), 0.4).put(c, 0, 0),
  glistering_melon: (c) => {
    const p = outlinePx(spritePx([
      '................', '................', '................', '................',
      '................', '..y..........y..', '..yR........Ry..', '..yRR.Y..Y.RRy..',
      '..ylRRRRRRRRly..', '...ylRRYRRRly...', '....ylRRRRly....', '.....yllllly....',
      '......yyyy......', '................', '................', '................',
    ], { y: '#d8a822', l: '#fff08a', R: '#f0645a', Y: '#fff6c0' }), 0.4);
    p.set(3, 3, '#fffbe0'); p.set(12, 2, '#fffbe0'); p.set(13, 4, '#ffe066');
    p.put(c, 0, 0);
  },
  pumpkin_seeds: (c) => seedsPx('#e8dcb0', '#fff6d6', '#b8a878').put(c, 0, 0),
  melon_seeds: (c) => seedsPx('#2a2018', '#5a4a34', '#120c08').put(c, 0, 0),
  mushroom_stew: (c) => pixmap(c, 0, 0, [
    '................', '................', '................', '................',
    '..OOOOOOOOOO....', '..OSSbSSrSSO....', '..OSbSSSSSbO....', '...OHHHHHHO.....',
    '...OHHHHHHO.....', '....OHHHHO......', '.....OOOO.......', '................',
    '................', '................', '................', '................',
  ], { O: '#4a2f14', H: '#9c6f3a', S: '#c9a071', b: '#8a6446', r: '#c43a2a' }),
  glass_bottle: (c) => bottlePx(null).put(c, 0, 0),
  water_bottle: (c) => bottlePx('#3f66d8').put(c, 0, 0),
  experience_bottle: (c) => bottlePx('#8ad83a', true).put(c, 0, 0),
  map: (c) => {
    const p = spritePx([
      '................', '.OOOOOOOOOOOOOO.', '.OppppppppppppO.', '.OpGGGgBBBBGGpO.',
      '.OpGgGGBBBbGGpO.', '.OpGGssBBBGGgpO.', '.OpgGsssBGGGGpO.', '.OpGGGsBBBGgGpO.',
      '.OpGgGGBBrGGGpO.', '.OpGGGBBBGGsspO.', '.OpBBBBBGGGsspO.', '.OpBbBBGgGGGspO.',
      '.OpBBBGGGGgGGpO.', '.OppppppppppppO.', '.OOOOOOOOOOOOOO.', '................',
    ], { O: '#6f5a3a', p: '#e8dcb8', G: '#7fa84e', g: '#5c8a34', B: '#5a86d8', b: '#7ea4ea', s: '#d6c894', r: '#c8323a' });
    p.put(c, 0, 0);
  },
  recovery_compass: (c) => dialPx(pal(['#1f3a44', '#2f6070', '#58a8b8']), (p) => {
    for (const [x, y] of [[8, 7], [9, 6], [10, 5]]) p.set(x, y, '#3de8e0');
    p.set(10, 4, '#b8fff8');
    for (const [x, y] of [[7, 8], [6, 9], [5, 10]]) p.set(x, y, '#1a6e78');
    p.set(7, 7, '#0e2a30'); p.set(8, 8, '#0a1e22');
  }).put(c, 0, 0),
  glider: (c) => outlinePx(spritePx([
    '................', '..mMMMm..mMMMm..', '.mMLLMMmmMMLLMm.', '.MLLMMMMMMMMLLM.',
    '.MLMMMMMMMMMMLM.', '.MMMdMMMMMMdMMM.', '..MMdMMMMMMdMM..', '..MMdMM..MMdMM..',
    '..mMdMm..mMdMm..', '...MdM....MdM...', '...mdM....Mdm...', '....dm....md....',
    '....m......m....', '................', '................', '................',
  ], { M: '#8b86a8', L: '#c4c0dc', m: '#625e80', d: '#4c486a' }), 0.4).put(c, 0, 0),
  firework_rocket: (c) => outlinePx(diagPx((a, cc) => {
    if (a >= 3 && a <= 9 && cc >= 14 && cc <= 17) return a === 9 ? (cc <= 15 ? 'T' : 't') : cc <= 14 ? 'L' : cc === 17 ? 'd' : (a & 1) ? 'R' : 'W';
    if (a >= 10 && a <= 11 && cc >= 15 && cc <= 16) return a === 11 ? 'T' : 't';
    if (a >= -11 && a <= 2 && (cc === 15 || cc === 16)) return cc === 15 ? 'H' : 'h';
    return null;
  }, { L: '#ff8a80', R: '#d8322a', W: '#f4f4f4', d: '#8a1a14', T: '#6a6a6a', t: '#3a3a3a', ...HANDLE }), 0.35).put(c, 0, 0),
  warp_pearl: (c) => outlinePx(spritePx([
    '................', '................', '................', '................',
    '......dddd......', '....dTTttTd.....', '...dTLLTtTTd....', '...dTLGgTTtd....',
    '...dTTggGTTd....', '...dtTTGTTtd....', '....dttTTtd.....', '.....dddd.......',
    '................', '................', '................', '................',
  ], { d: '#0c3a36', T: '#1f7a6e', t: '#155a52', L: '#7ef0d8', G: '#62d86a', g: '#2e9a4a' }), 0.4).put(c, 0, 0),
  // block item sprites (shown in hand/hotbar instead of an isometric slice)
  cake: (c) => outlinePx(spritePx([
    '................', '................', '................', '................',
    '.....WWWWWW.....', '...WWWrWWWWWW...', '..WWWWWWWrWWWW..', '..wWWWWWWWWWWw..',
    '..SwWwWWwWWwWS..', '..SSwSSwSSwSSS..', '..SSSSSSSSSSSS..', '..sSSSSSSSSSSs..',
    '...ssssssssss...', '................', '................', '................',
  ], { W: '#f7f3ef', w: '#dcd6d0', r: '#d8232a', S: '#c27d44', s: '#8e5428' }), 0.4).put(c, 0, 0),
  flower_pot: (c) => outlinePx(spritePx([
    '................', '................', '................', '................',
    '................', '................', '......g.G.......', '.....gGGgG......',
    '...RRRRRRRRR....', '...rDDDDDDDr....', '....PPPPPPp.....', '....PPPPPPp.....',
    '....PPPPPPp.....', '.....PPPPp......', '................', '................',
  ], { R: '#a8583a', r: '#7a3a24', D: '#3a2616', P: '#9c5236', p: '#6e3420', G: '#4f8f2e', g: '#2f6a1e' }), 0.4).put(c, 0, 0),
  campfire: (c) => outlinePx(spritePx([
    '................', '.......y........', '......yY........', '......YOy.......',
    '.....yOOYy......', '.....YORROy.....', '....yORRROY.....', '....YORRRROy....',
    '...LLLLLLLLLLl..', '..lLLLLLLLLLLl..', '..EllllllllllE..', '...aAaAaAaAaA...',
    '................', '................', '................', '................',
  ], { y: '#ffd24a', Y: '#ffb41e', O: '#ff7a1a', R: '#e2431a', L: '#6a502e', l: '#4b361e', E: '#9c7442', a: '#3a3533', A: '#ff8a1e' }), 0.35).put(c, 0, 0),
};
for (const [, , stem, , col] of WOOL_COLORS) {
  DECOR_ITEM_PAINTERS[`${stem}_dye`] = (c) => dyePx(col).put(c, 0, 0);
}
for (const [, stem, , col] of POTIONS) {
  DECOR_ITEM_PAINTERS[`potion_${stem}`] = (c) => bottlePx(col).put(c, 0, 0);
}
Object.assign(ITEM_PAINTERS, DECOR_ITEM_PAINTERS);
Object.assign(PACK_MAP, {
  bricks: { paths: ['block/bricks'], kind: 'tile' },
  clay: { paths: ['block/clay'], kind: 'tile' },
  mossy_cobble: { paths: ['block/mossy_cobblestone'], kind: 'tile' },
  mossy_stone_bricks: { paths: ['block/mossy_stone_bricks'], kind: 'tile' },
  cracked_stone_bricks: { paths: ['block/cracked_stone_bricks'], kind: 'tile' },
  chiseled_stone_bricks: { paths: ['block/chiseled_stone_bricks'], kind: 'tile' },
  ice: { paths: ['block/ice'], kind: 'tile' },
  packed_ice: { paths: ['block/packed_ice'], kind: 'tile' },
  terracotta: { paths: ['block/terracotta'], kind: 'tile' },
  pumpkin_side: { paths: ['block/pumpkin_side'], kind: 'tile' },
  pumpkin_top: { paths: ['block/pumpkin_top'], kind: 'tile' },
  jack_o_lantern: { paths: ['block/jack_o_lantern'], kind: 'tile' },
  melon_side: { paths: ['block/melon_side'], kind: 'tile' },
  melon_top: { paths: ['block/melon_top'], kind: 'tile' },
  cornflower: { paths: ['block/cornflower'], kind: 'tile' },
  allium: { paths: ['block/allium'], kind: 'tile' },
  oxeye_daisy: { paths: ['block/oxeye_daisy'], kind: 'tile' },
  brown_mushroom: { paths: ['block/brown_mushroom'], kind: 'tile' },
  red_mushroom: { paths: ['block/red_mushroom'], kind: 'tile' },
  barrel_side: { paths: ['block/barrel_side'], kind: 'tile' },
  barrel_top: { paths: ['block/barrel_top'], kind: 'tile' },
  barrel_bottom: { paths: ['block/barrel_bottom'], kind: 'tile' },
  cake_top: { paths: ['block/cake_top'], kind: 'tile' },
  cake_side: { paths: ['block/cake_side'], kind: 'tile' },
  cake_inner: { paths: ['block/cake_inner'], kind: 'tile' },
  cake_bottom: { paths: ['block/cake_bottom'], kind: 'tile' },
  clay_ball: { paths: ['item/clay_ball'], kind: 'item' },
  brick: { paths: ['item/brick'], kind: 'item' },
  snowball: { paths: ['item/snowball'], kind: 'item' },
  sugar: { paths: ['item/sugar'], kind: 'item' },
  cookie: { paths: ['item/cookie'], kind: 'item' },
  pumpkin_pie: { paths: ['item/pumpkin_pie'], kind: 'item' },
  melon_slice: { paths: ['item/melon_slice'], kind: 'item' },
  glass_bottle: { paths: ['item/glass_bottle'], kind: 'item' },
  map: { paths: ['item/map'], kind: 'item' },
} satisfies Record<string, PackEntry>);
for (const [, , stem] of WOOL_COLORS) {
  PACK_MAP[`${stem}_wool`] = { paths: [`block/${stem}_wool`], kind: 'tile' };
}

// --- inventory icons + held/dropped geometry for shaped blocks ------------------

/** Blocks shown in the inventory by their hand-drawn item sprite (like the bed). */
export const BLOCK_SPRITE_ICONS = new Set<string>(['cake', 'flower_pot', 'campfire']);

/** Isometric icon shapes for partial blocks: boxes [p0,p1,q0,q1,h0,h1], drawn in order. */
export const ICON_SHAPES: Record<string, number[][]> = {
  anvil: [[0.19, 0.81, 0.12, 0.88, 0, 0.25], [0.31, 0.69, 0.25, 0.75, 0.25, 0.62], [0, 1, 0.19, 0.81, 0.62, 1]],
  enchanting_table: [[0, 1, 0, 1, 0, 0.75]],
  oak_fence: [[0.06, 0.31, 0.38, 0.62, 0, 1], [0, 1, 0.44, 0.56, 0.38, 0.56], [0, 1, 0.44, 0.56, 0.75, 0.94], [0.69, 0.94, 0.38, 0.62, 0, 1]],
  oak_fence_gate: [[0, 0.12, 0.44, 0.56, 0.31, 1], [0.12, 0.88, 0.44, 0.56, 0.38, 0.56], [0.12, 0.88, 0.44, 0.56, 0.75, 0.94],
    [0.38, 0.62, 0.44, 0.56, 0.38, 0.94], [0.88, 1, 0.44, 0.56, 0.31, 1]],
  composter: [[0, 1, 0, 1, 0, 1]],
  glass_pane: [[0, 1, 0.44, 0.56, 0, 1]],
};
for (const [slab, stairs] of SLAB_KINDS) {
  ICON_SHAPES[def(slab).name] = [[0, 1, 0, 1, 0, 0.5]];
  if (stairs) ICON_SHAPES[def(stairs).name] = [[0, 1, 0, 1, 0, 0.5], [0, 1, 0.5, 1, 0.5, 1]];
}

/** Does this block hold/drop as its own little model (slab, stairs, fence ...)? */
export function hasShapedItemModel(id: number): boolean {
  return SHAPED.has(id) && hasDef(id) && def(id).solid && !BLOCK_SPRITE_ICONS.has(def(id).name);
}

/**
 * Geometry for a shaped block held in hand or dropped, or null for a plain
 * cube: its model boxes with atlas UVs cropped to each box, and Minecraft face
 * shading baked into vertex colours. Centred on the origin like BoxGeometry.
 */
export function shapedItemGeometry(id: number, atlas: Atlas, size = 1): THREE.BufferGeometry | null {
  if (!hasShapedItemModel(id)) return null;
  const d = def(id);
  let boxes = shapeBoxes(id, 0, 4 | 8, false, false);
  if (id === B.OAK_FENCE) boxes = [[6 / 16, 0, 6 / 16, 10 / 16, 1, 10 / 16], [0, 6 / 16, 7 / 16, 1, 9 / 16, 9 / 16], [0, 12 / 16, 7 / 16, 1, 15 / 16, 9 / 16]];
  if (id === B.FENCE_GATE) boxes = [[0, 5 / 16, 7 / 16, 2 / 16, 1, 9 / 16], [14 / 16, 5 / 16, 7 / 16, 1, 1, 9 / 16],
    [2 / 16, 6 / 16, 7 / 16, 14 / 16, 9 / 16, 9 / 16], [2 / 16, 12 / 16, 7 / 16, 14 / 16, 15 / 16, 9 / 16]];
  if (id === B.ANVIL) boxes = [[2 / 16, 0, 2 / 16, 14 / 16, 4 / 16, 14 / 16], [6 / 16, 4 / 16, 4 / 16, 10 / 16, 10 / 16, 12 / 16], [0, 10 / 16, 3 / 16, 1, 1, 13 / 16]];
  if (id === B.COMPOSTER || id === B.JACK_O_LANTERN) boxes = [[0, 0, 0, 1, 1, 1]];
  if (!boxes || boxes.length === 0) return null;
  const pos: number[] = [], uvs: number[] = [], cols: number[] = [], idx: number[] = [];
  const shadeOf = [0.64, 0.64, 1, 0.5, 0.82, 0.82];
  const faces = d.faces!;
  for (const [x0, y0, z0, x1, y1, z1] of boxes) {
    // face corner lists (+x,-x,+y,-y,+z,-z) + uv mappers, counter-clockwise from outside
    const F: [number[][], (p: number[]) => [number, number], string][] = [
      [[[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], (p) => [1 - p[2], 1 - p[1]], faces.sides],
      [[[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], (p) => [p[2], 1 - p[1]], faces.sides],
      [[[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], (p) => [p[0], p[2]], faces.top],
      [[[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], (p) => [p[0], p[2]], faces.bottom],
      [[[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], (p) => [p[0], 1 - p[1]], faces.front ?? faces.sides],
      [[[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], (p) => [1 - p[0], 1 - p[1]], faces.sides],
    ];
    F.forEach(([corners, uvOf, tile], f) => {
      const r = atlas.rect(tile);
      const base = pos.length / 3;
      for (const p of corners) {
        pos.push((p[0] - 0.5) * size, (p[1] - 0.5) * size, (p[2] - 0.5) * size);
        const [u, v] = uvOf(p);
        uvs.push(r.u0 + u * (r.u1 - r.u0), r.v0 + v * (r.v1 - r.v0));
        cols.push(shadeOf[f], shadeOf[f], shadeOf[f]);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    });
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}
