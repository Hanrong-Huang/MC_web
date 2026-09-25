// Procedural 16x16 texture atlas (Minecraft-style palette, original pixel art),
// item sprites, isometric block icons, and a resource-pack loader that reads the
// standard assets/minecraft/textures/{block,item}/*.png layout.

import * as THREE from 'three';
import { mulberry32 } from './Noise';
import { def, TINTED_TILES } from './Blocks';

const TILE = 16;
const COLS = 8;
const ROWS = 16;

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
    // still water: soft horizontal swells with a few bright ripple glints
    const ramp = pal(['#2a4ea6', '#2f55b0', '#345cba', '#3a64c4', '#416dcd', '#4a78d6']);
    const f = fbm(107, [[4, 0.6, 8], [8, 0.4, 16]], 1.8);
    const p = rampFill(new Px(), ramp, f, 108, 0.25);
    const r = mulberry32(2107);
    for (let i = 0; i < 6; i++) {
      const gx = (r() * 16) | 0, gy = (r() * 16) | 0, len = 2 + ((r() * 3) | 0);
      for (let k = 0; k < len; k++) p.set(gx + k, gy, k === 0 || k === len - 1 ? '#5c86de' : '#7ea0ea');
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
    const cols = ['#3f7a2a', '#4c8c32', '#5a9e3a', '#68ae44'];
    for (let i = 0; i < 13; i++) {
      const bx = 1 + ((rand() * 14) | 0);
      const h = 4 + ((rand() * 10) | 0);
      const lean = rand() < 0.5 ? -1 : 1;
      for (let j = 0; j < h; j++) {
        const px = bx + (j > h * 0.6 ? lean : 0) + (j > h * 0.85 ? lean : 0);
        c.fillStyle = cols[Math.min(3, ((j / h) * 3.5) | 0)];
        c.fillRect(x + Math.max(0, Math.min(15, px)), y + 15 - j, 1, 1);
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
type ToolMat = { L: string; M: string; m: string; d: string; H: string; h: string };
const HANDLE = { H: '#9c7440', h: '#664722' };
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
  coal: (c) => pixmap(c, 0, 0, [
    '................', '................', '................', '.....OOOO.......',
    '...OOKKKKO......', '..OKKkKKKKO.....', '..OKkKKKKKKO....', '.OKKKKKkKKKO....',
    '.OKKkKKKKKKO....', '.OKKKKKKkKO.....', '..OKkKKKKKO.....', '...OOKKKOO......',
    '.....OOO........', '................', '................', '................',
  ], { O: '#0c0c0c', K: '#2b2b2b', k: '#4a4a4a' }),
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
  string: (c) => outlinePx(spritePx([
    '................', '................', '...........WW...', '..........W..W..',
    '.........W...W..', '....WW..W...W...', '...W..WW...W....', '...W......W.....',
    '....W....W......', '.....W..W.......', '......WW........', '.....W..........',
    '....W...........', '...W............', '................', '................',
  ], { W: '#f4f4f4' }), 0.55).put(c, 0, 0),
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
  bow: (c) => pixmap(c, 0, 0, [
    '................', '......OHHO......', '....OHHhhHO.....', '...OHhO..OHO....',
    '..OHhO....OHO...', '..OHO......OW...', '.OHhO......W....', '.OHO......W.....',
    '.OHO.....W......', '.OHhO...W.......', '..OHO..W........', '..OHhOW.........',
    '...OWW..........', '....W...........', '................', '................',
  ], { O: '#241b10', H: '#8a6232', h: '#a87c46', W: '#e8e8e8' }),
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
  hoe: (c) => pixmap(c, 0, 0, [
    '................', '....OOOOOO......', '...OMMMMMMO.....', '...OOOOOMMO.....',
    '........OHhO....', '.......OHhO.....', '......OHhO......', '.....OHhO.......',
    '....OHhO........', '...OHhO.........', '..OHhO..........', '.OHhO...........',
    '.OhO............', '................', '................', '................',
  ], WOOD),
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
  leather: (c) => pixmap(c, 0, 0, [
    '................', '................', '....OOOOOO......', '...OLLLLLLO.....',
    '..OLLlLLLlLO....', '..OLLLLLLLLO....', '..OLlLLLLlLO....', '..OLLLLLLLLO....',
    '..OLLlLLLLLO....', '...OLLLLLlO.....', '....OOOOOO......', '................',
    '................', '................', '................', '................',
  ], { O: '#5a3a1e', L: '#a06a3a', l: '#8a5a2e' }),
  saddle: (c) => pixmap(c, 0, 0, [
    '................', '................', '................', '.....OOOOOO.....',
    '....OBBBBBBO....', '...OBBBBBBBBO...', '..OBKBBBBKBBO...', '..OBBBBBBBBBO...',
    '...OOBBBBBOO...', '.....O.OO.O.....', '....O...O..O....', '................',
    '................', '................', '................', '................',
  ], { O: '#3a2410', B: '#7a4a22', K: '#caa84a' }),
  horse_armor: (c) => pixmap(c, 0, 0, [
    '................', '......OOOO......', '.....OMMMMO.....', '....OMMmMMMO....',
    '...OMMMMMMMO....', '...OMmMMMmMO....', '...OMMMMMMMO....', '....OMMMMMO....',
    '....O.OMMO.O....', '......OMMO......', '.....OMMMMO.....', '......OOOO......',
    '................', '................', '................', '................',
  ], { O: '#3f3f47', M: '#cfcfd6', m: '#a8a8b0' }),
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

// A capture orb on a clean 14px circle: clear glass dome up top (so whatever is
// inside reads at hotbar size), a dark metal equator band with a round glowing
// button, and a polished amethyst base. Shared by the empty + filled sprites.
const ORB_ROWS = [
  '................',
  '.....kkkkkk.....',
  '...kkhhaaaakk...',
  '..khhhaaaaaask..',
  '..khhaaaaaassk..',
  '.khaaaaaaaassck.',
  '.kaaaaappaaassk.',
  '.kBBBBpwwpBBBBk.',
  '.kBBBBpwwpBBBBk.',
  '.kAAAAAppAAAAAk.',
  '.kAAAAAADDDDDDk.',
  '..kAAAADDDDDDk..',
  '..kADDDDDDDEEk..',
  '...kkDDDEEEkk...',
  '.....kkkkkk.....',
  '................',
];
const ORB_PAL: Record<string, string> = {
  k: '#20142e', h: '#ffffff', a: '#e3d5fa', s: '#c2a9e4', c: '#a98fd0',
  B: '#241b30', p: '#a97fe0', w: '#fff4ff',
  A: '#8f63cf', D: '#5f4189', E: '#43305f',
};

/** Empty mob catcher: the bare capture orb. */
function catcherShell(c: Ctx): void {
  pixmap(c, 0, 0, ORB_ROWS, ORB_PAL);
}

/** Per-mob occupant drawn inside the glass dome (8 wide x 4 tall, placed at
 *  x=4,y=2). 'B' body, 'A' shade, 'e' dark eye, 'g' glowing eye. */
const ORB_OCCUPANTS: Record<string, { rows: string[]; base: string; accent: string; glow: string }> = {
  zombie: {
    rows: ['..BBBB..', '.BBBBBB.', '.BeBBeB.', '.BBAABB.'],
    base: '#5c9455', accent: '#3f6b3b', glow: '#8fd67e',
  },
  skeleton: {
    rows: ['..BBBB..', '.BBBBBB.', '.BeBBeB.', '..BAAB..'],
    base: '#e2e2d8', accent: '#a8a89e', glow: '#ffffff',
  },
  spider: {
    rows: ['.BBBBBB.', 'BBgBBgBB', '.BBBBBB.', '..BAAB..'],
    base: '#4a3a41', accent: '#251d21', glow: '#e2564a',
  },
  creeper: {
    rows: ['.BBBBBB.', '.BeBBeB.', '.BBeeBB.', '.BeeeeB.'],
    base: '#62b552', accent: '#2f6b2a', glow: '#8ede78',
  },
  cinderling: {
    rows: ['.B.BB.B.', '.BBBBBB.', '.BgBBgB.', '.BBAABB.'],
    base: '#df6a1f', accent: '#8a3a10', glow: '#ffd777',
  },
  ashstalker: {
    rows: ['..BBBB..', '.BBBBBB.', '.BgBBgB.', '.BAAAAB.'],
    base: '#c25a1f', accent: '#5f2a10', glow: '#ffb44a',
  },
  emberghast: {
    rows: ['.BBBBBB.', '.BeBBeB.', '.BBBBBB.', '.BeeeeB.'],
    base: '#ece6e0', accent: '#b5aca4', glow: '#ff9040',
  },
  phantom: {
    rows: ['A.BBBB.A', '.BBBBBB.', '.BgBBgB.', '..BBBB..'],
    base: '#5b8b9b', accent: '#315764', glow: '#a6f2ff',
  },
};

/** Filled mob catcher: the orb with its captive showing through the glass dome,
 *  plus a colored haze so the ball reads as "occupied" at a glance. */
function filledCatcher(c: Ctx, kind: string): void {
  const occ = ORB_OCCUPANTS[kind] ?? ORB_OCCUPANTS.zombie;
  pixmap(c, 0, 0, ORB_ROWS, ORB_PAL);
  // faint tint of the captive's color across the dome interior (glass haze)
  c.save();
  c.globalAlpha = 0.3;
  c.fillStyle = occ.base;
  c.fillRect(2, 2, 12, 5);
  c.restore();
  pixmap(c, 4, 2, occ.rows, {
    B: occ.base, A: occ.accent, g: occ.glow, e: '#161318',
  });
  // glass specular back on top so the dome still reads as glass over the mob
  c.save();
  c.globalAlpha = 0.6;
  c.fillStyle = '#f7f2ff';
  c.fillRect(3, 3, 2, 1);
  c.fillRect(3, 4, 1, 1);
  c.restore();
}

/** Bed item sprite: a 3/4 view with two wooden legs, a red mattress and a
 *  white pillow at the head end — the vanilla bed item silhouette. */
function bedSprite(c: Ctx): void {
  pixmap(c, 0, 0, [
    '................',
    '................',
    '...WWWWWkkkkkk..',
    '..WwwwwWRRRRRRk.',
    '..WwwwwWRrRRrRk.',
    '..kWWWWkRRRRRRk.',
    '..kSSSSkSSSSSSk.',
    '..kssssksssssSk.',
    '..kkkkkkkkkkkkk.',
    '..kLLk......kLk.',
    '..kllk......klk.',
    '..kllk......klk.',
    '...kk........kk.',
    '................',
    '................',
    '................',
  ], {
    k: '#241a12',              // dark outline
    W: '#d8d8d2', w: '#f2f2ee', // pillow (shade + lit)
    R: '#b02e2e', r: '#c64141', // blanket top (quilt seams brighter)
    S: '#8e2323', s: '#7a1e1e', // mattress side in shadow
    L: '#7a5a30', l: '#5e4524', // oak legs
  });
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
    if (d.name === 'bed') {
      // hand-drawn 3/4-view bed sprite (legs + mattress + pillow); an isometric
      // slice of the block tiles never read as a bed at hotbar size
      const s = this.itemSprites.get('bed');
      ctx.imageSmoothingEnabled = false;
      if (s) ctx.drawImage(s, 0, 0, 16, 16, 0, 0, 32, 32);
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
          if (name === 'water') {
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
