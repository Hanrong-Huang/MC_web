// Procedural 16x16 texture atlas (Minecraft-style palette, original pixel art),
// item sprites, isometric block icons, and a resource-pack loader that reads the
// standard assets/minecraft/textures/{block,item}/*.png layout.

import * as THREE from 'three';
import { mulberry32 } from './Noise';
import { def } from './Blocks';

const TILE = 16;
const COLS = 8;
const ROWS = 8;

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

const STONE_PAL = ['#747474', '#7d7d7d', '#868686', '#6b6b6b', '#909090'];
const DIRT_PAL = ['#866043', '#79553a', '#96714f', '#6f4d34', '#8d6849'];
const GRASS_PAL = ['#5d9b3d', '#65a843', '#549335', '#6fb04a', '#588f3a'];
const SAND_PAL = ['#dbd3a0', '#d7cf9c', '#e2daa8', '#cfc795', '#e8e0b3'];
const SNOW_PAL = ['#f4fcfc', '#eef7f7', '#fdffff', '#e8f2f2'];
const LEAF_PAL = ['#2f6b1e', '#3f8a26', '#357a20', '#48962c'];
const WATER_PAL = ['#2f52a5', '#3a61bf', '#345aae', '#3f6ad4'];
const BEDROCK_PAL = ['#222222', '#393939', '#575757', '#777777', '#2e2e2e'];

function cropTile(c: Ctx, x: number, y: number, seed: number, leaf: string, light: string, root: string, stage: 0 | 1 | 2): void {
  c.clearRect(x, y, 16, 16);
  const rand = mulberry32(seed);
  const stems = stage === 0 ? [4, 8, 12] : [2, 5, 8, 11, 14];
  for (const bx of stems) {
    const h = (stage === 0 ? 3 : stage === 1 ? 6 : 9) + ((rand() * 3) | 0);
    for (let j = 0; j < h; j++) {
      c.fillStyle = j > h - 3 ? light : leaf;
      c.fillRect(x + bx, y + 15 - j, 1, 1);
      if (stage > 0 && j === ((h * 0.55) | 0)) c.fillRect(x + bx + 1, y + 15 - j, 1, 1);
    }
    if (stage === 2) {
      c.fillStyle = root;
      c.fillRect(x + bx - 1, y + 14, 2, 2);
      if (rand() < 0.45) c.fillRect(x + bx + 1, y + 13, 1, 2);
    }
  }
}

// ---------------------------------------------------------------------------
// Tile painters
// ---------------------------------------------------------------------------

const TILE_PAINTERS: Record<string, (ctx: Ctx, x: number, y: number) => void> = {
  stone: (c, x, y) => noiseFill(c, x, y, STONE_PAL, 101, 1),
  dirt: (c, x, y) => noiseFill(c, x, y, DIRT_PAL, 102, 1),
  grass_top: (c, x, y) => noiseFill(c, x, y, GRASS_PAL, 103, 1),
  sand: (c, x, y) => noiseFill(c, x, y, SAND_PAL, 104, 1),
  snow_top: (c, x, y) => noiseFill(c, x, y, SNOW_PAL, 105, 0),
  leaves: (c, x, y) => {
    noiseFill(c, x, y, LEAF_PAL, 106, 0);
    const rand = mulberry32(206);
    for (let i = 0; i < 60; i++) {
      c.clearRect(x + ((rand() * 16) | 0), y + ((rand() * 16) | 0), 1, 1);
    }
  },
  water: (c, x, y) => {
    noiseFill(c, x, y, WATER_PAL, 107, 1);
    const img = c.getImageData(x, y, TILE, TILE);
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 200;
    c.putImageData(img, x, y);
  },
  bedrock: (c, x, y) => noiseFill(c, x, y, BEDROCK_PAL, 108, 1),
  grass_side: (c, x, y) => {
    noiseFill(c, x, y, DIRT_PAL, 109, 1);
    const rand = mulberry32(209);
    for (let px = 0; px < 16; px++) {
      const depth = 2 + ((rand() * 3) | 0);
      for (let py = 0; py < depth; py++) {
        c.fillStyle = GRASS_PAL[(rand() * GRASS_PAL.length) | 0];
        c.fillRect(x + px, y + py, 1, 1);
      }
      c.fillStyle = '#4a7a30';
      c.fillRect(x + px, y + depth - 1, 1, 1);
    }
  },
  snow_side: (c, x, y) => {
    noiseFill(c, x, y, DIRT_PAL, 110, 1);
    const rand = mulberry32(210);
    for (let px = 0; px < 16; px++) {
      const depth = 2 + ((rand() * 3) | 0);
      for (let py = 0; py < depth; py++) {
        c.fillStyle = SNOW_PAL[(rand() * SNOW_PAL.length) | 0];
        c.fillRect(x + px, y + py, 1, 1);
      }
    }
  },
  cobble: (c, x, y) => {
    // Cellular stones with dark mortar between them.
    const rand = mulberry32(111);
    const pts: [number, number, number][] = [];
    for (let i = 0; i < 9; i++) pts.push([rand() * 16, rand() * 16, 0.55 + rand() * 0.5]);
    const cellOf = (px: number, py: number): number => {
      let best = 0, bd = 1e9;
      for (let i = 0; i < pts.length; i++) {
        // wrap distances for a tileable pattern
        let dx = Math.abs(px - pts[i][0]); if (dx > 8) dx = 16 - dx;
        let dy = Math.abs(py - pts[i][1]); if (dy > 8) dy = 16 - dy;
        const d = (dx * dx + dy * dy) * pts[i][2];
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    };
    const shades = ['#828282', '#7a7a7a', '#8c8c8c', '#757575', '#888888', '#7f7f7f', '#909090', '#787878', '#858585'];
    for (let py = 0; py < 16; py++) {
      for (let px = 0; px < 16; px++) {
        const me = cellOf(px, py);
        const edge = cellOf(px + 1, py) !== me || cellOf(px, py + 1) !== me;
        c.fillStyle = edge ? '#4f4f4f' : shades[me % shades.length];
        if (!edge && rand() < 0.15) c.fillStyle = '#959595';
        c.fillRect(x + px, y + py, 1, 1);
      }
    }
  },
  planks: (c, x, y) => {
    const rand = mulberry32(112);
    const base = ['#9c7f4e', '#a08350', '#967a4a', '#a4874f'];
    for (let py = 0; py < 16; py++) {
      for (let px = 0; px < 16; px++) {
        c.fillStyle = base[((py >> 2) + ((rand() * 2) | 0)) % base.length];
        if (py % 4 === 3) c.fillStyle = '#6b5532';
        c.fillRect(x + px, y + py, 1, 1);
      }
    }
    // vertical seams between boards
    c.fillStyle = '#6b5532';
    c.fillRect(x + 4, y + 0, 1, 3); c.fillRect(x + 12, y + 4, 1, 3);
    c.fillRect(x + 7, y + 8, 1, 3); c.fillRect(x + 2, y + 12, 1, 3);
  },
  log_side: (c, x, y) => {
    const rand = mulberry32(113);
    for (let px = 0; px < 16; px++) {
      const dark = rand() < 0.35;
      for (let py = 0; py < 16; py++) {
        const r = rand();
        c.fillStyle = dark
          ? (r < 0.85 ? '#523f24' : '#6b522f')
          : (r < 0.8 ? '#6b522f' : r < 0.92 ? '#75592f' : '#523f24');
        c.fillRect(x + px, y + py, 1, 1);
      }
    }
  },
  log_top: (c, x, y) => {
    const rand = mulberry32(114);
    for (let py = 0; py < 16; py++) {
      for (let px = 0; px < 16; px++) {
        const d = Math.max(Math.abs(px - 7.5), Math.abs(py - 7.5));
        let col: string;
        if (d > 6.5) col = rand() < 0.8 ? '#6b522f' : '#523f24';
        else col = (d | 0) % 2 === 0 ? '#b8945f' : '#9c7f4e';
        c.fillStyle = col;
        c.fillRect(x + px, y + py, 1, 1);
      }
    }
  },
  glass: (c, x, y) => {
    c.clearRect(x, y, 16, 16);
    c.fillStyle = '#dbe9ec';
    c.fillRect(x, y, 16, 1); c.fillRect(x, y + 15, 16, 1);
    c.fillRect(x, y, 1, 16); c.fillRect(x + 15, y, 1, 16);
    c.fillStyle = '#ffffff';
    for (let i = 0; i < 5; i++) c.fillRect(x + 10 - i, y + 2 + i, 1, 1);
    for (let i = 0; i < 3; i++) c.fillRect(x + 13 - i, y + 2 + i, 1, 1);
    c.fillStyle = 'rgba(200,225,235,0.25)';
    c.fillRect(x + 1, y + 1, 14, 14);
  },
  table_top: (c, x, y) => {
    TILE_PAINTERS.planks(c, x, y);
    c.fillStyle = '#6b5532';
    c.fillRect(x, y, 16, 1); c.fillRect(x, y + 15, 16, 1);
    c.fillRect(x, y, 1, 16); c.fillRect(x + 15, y, 1, 16);
    c.fillStyle = '#7a6238';
    c.fillRect(x + 1, y + 7, 14, 2); c.fillRect(x + 7, y + 1, 2, 14);
  },
  table_side: (c, x, y) => {
    TILE_PAINTERS.planks(c, x, y);
    c.fillStyle = '#7a6238'; c.fillRect(x, y, 16, 2);
    c.fillStyle = '#5d4a2c'; c.fillRect(x + 3, y + 5, 10, 8);
    c.fillStyle = '#6b5532'; c.fillRect(x + 4, y + 6, 8, 6);
  },
  table_front: (c, x, y) => {
    TILE_PAINTERS.planks(c, x, y);
    c.fillStyle = '#7a6238'; c.fillRect(x, y, 16, 2);
    // simple saw + hammer marks
    c.fillStyle = '#8c8c8c';
    c.fillRect(x + 3, y + 5, 4, 2); c.fillRect(x + 9, y + 8, 2, 4);
    c.fillStyle = '#5d4a2c';
    c.fillRect(x + 4, y + 7, 2, 4); c.fillRect(x + 9, y + 5, 2, 3);
  },
  furnace_top: (c, x, y) => noiseFill(c, x, y, ['#7d7d7d', '#747474', '#868686', '#6f6f6f'], 115, 1),
  furnace_side: (c, x, y) => {
    noiseFill(c, x, y, ['#7d7d7d', '#747474', '#868686'], 116, 1);
    c.fillStyle = '#4f4f4f';
    c.fillRect(x, y, 16, 1); c.fillRect(x, y + 15, 16, 1);
    c.fillRect(x, y, 1, 16); c.fillRect(x + 15, y, 1, 16);
    c.fillStyle = '#5a5a5a'; c.fillRect(x + 1, y + 8, 14, 1);
  },
  furnace_front: (c, x, y) => {
    TILE_PAINTERS.furnace_side(c, x, y);
    c.fillStyle = '#1a1a1a'; c.fillRect(x + 4, y + 8, 8, 6);
    c.fillStyle = '#000000'; c.fillRect(x + 5, y + 9, 6, 5);
  },
  furnace_front_on: (c, x, y) => {
    TILE_PAINTERS.furnace_side(c, x, y);
    c.fillStyle = '#1a1a1a'; c.fillRect(x + 4, y + 8, 8, 6);
    const rand = mulberry32(117);
    for (let px = 5; px < 11; px++) {
      const h = 2 + ((rand() * 3) | 0);
      for (let py = 0; py < h; py++) {
        c.fillStyle = py === h - 1 ? '#ffd83d' : '#d87f33';
        c.fillRect(x + px, y + 13 - py, 1, 1);
      }
    }
  },
  coal_ore: (c, x, y) => {
    noiseFill(c, x, y, STONE_PAL, 118, 1);
    const rand = mulberry32(218);
    for (let i = 0; i < 5; i++) {
      const bx = 1 + ((rand() * 12) | 0), by = 1 + ((rand() * 12) | 0);
      for (let j = 0; j < 6; j++) {
        const px = bx + ((rand() * 3) | 0), py = by + ((rand() * 3) | 0);
        c.fillStyle = rand() < 0.5 ? '#1f1f1f' : '#2f2f2f';
        c.fillRect(x + Math.min(15, px), y + Math.min(15, py), 1, 1);
      }
    }
  },
  iron_ore: (c, x, y) => oreTile(c, x, y, 318, '#d8af93', '#b08a6e'),
  gold_ore: (c, x, y) => oreTile(c, x, y, 418, '#fcee4b', '#d9c52e'),
  diamond_ore: (c, x, y) => oreTile(c, x, y, 518, '#4aedd9', '#33c7c2'),
  gravel: (c, x, y) => {
    noiseFill(c, x, y, ['#7f7c78', '#8c8782', '#6e6a66', '#999390', '#5d5a57'], 119, 1);
    const rand = mulberry32(219);
    for (let i = 0; i < 10; i++) {
      c.fillStyle = rand() < 0.5 ? '#4d4a47' : '#a5a09b';
      c.fillRect(x + ((rand() * 15) | 0), y + ((rand() * 15) | 0), 2, 1);
    }
  },
  sandstone_top: (c, x, y) => noiseFill(c, x, y, ['#dbd3a0', '#e2daa8', '#d2ca96'], 120, 1),
  sandstone_side: (c, x, y) => {
    noiseFill(c, x, y, ['#dbd3a0', '#e2daa8', '#d2ca96'], 121, 1);
    c.fillStyle = '#c4bc8a';
    c.fillRect(x, y, 16, 1); c.fillRect(x, y + 4, 16, 1); c.fillRect(x, y + 11, 16, 1); c.fillRect(x, y + 15, 16, 1);
    c.fillStyle = '#b5ad7c';
    c.fillRect(x + 2, y + 6, 3, 2); c.fillRect(x + 9, y + 7, 4, 2);
  },
  stone_bricks: (c, x, y) => {
    noiseFill(c, x, y, STONE_PAL, 122, 1);
    c.fillStyle = '#4f4f4f';
    for (const by of [0, 4, 8, 12]) c.fillRect(x, y + by + 3, 16, 1);
    c.fillRect(x + 7, y, 1, 4); c.fillRect(x + 3, y + 4, 1, 4);
    c.fillRect(x + 11, y + 4, 1, 4); c.fillRect(x + 7, y + 8, 1, 4); c.fillRect(x + 3, y + 12, 1, 4);
    c.fillRect(x + 12, y + 12, 1, 4);
  },
  wool: (c, x, y) => {
    noiseFill(c, x, y, ['#e8e8e8', '#f2f2f2', '#dcdcdc', '#ffffff'], 123, 1);
    const rand = mulberry32(223);
    c.fillStyle = '#cfcfcf';
    for (let i = 0; i < 9; i++) c.fillRect(x + ((rand() * 14) | 0), y + ((rand() * 14) | 0), 2, 1);
  },
  iron_block: (c, x, y) => metalBlock(c, x, y, '#d8d8d8', '#efefef', '#a8a8a8'),
  gold_block: (c, x, y) => metalBlock(c, x, y, '#f5d93f', '#fcee8a', '#c7a51e'),
  diamond_block: (c, x, y) => metalBlock(c, x, y, '#62e9d8', '#a5f4ea', '#36b3aa'),
  tnt_top: (c, x, y) => {
    noiseFill(c, x, y, ['#a52f23', '#b3382b', '#992a1e'], 124, 0);
    c.fillStyle = '#d8cba3'; c.fillRect(x + 4, y + 4, 8, 8);
    c.fillStyle = '#3a2a1a'; c.fillRect(x + 7, y + 7, 2, 2);
  },
  tnt_side: (c, x, y) => {
    noiseFill(c, x, y, ['#a52f23', '#b3382b', '#992a1e'], 125, 0);
    c.fillStyle = '#d8cba3'; c.fillRect(x, y + 5, 16, 6);
    // "TNT"
    c.fillStyle = '#1f1f1f';
    c.fillRect(x + 2, y + 6, 3, 1); c.fillRect(x + 3, y + 6, 1, 4);
    c.fillRect(x + 6, y + 6, 1, 4); c.fillRect(x + 9, y + 6, 1, 4); c.fillRect(x + 7, y + 7, 1, 1); c.fillRect(x + 8, y + 8, 1, 1);
    c.fillRect(x + 11, y + 6, 3, 1); c.fillRect(x + 12, y + 6, 1, 4);
  },
  bed_top: (c, x, y) => {
    noiseFill(c, x, y, ['#b02e2e', '#a02828', '#bd3737'], 126, 0);
    c.fillStyle = '#efefef'; c.fillRect(x + 2, y + 1, 12, 4);
    c.fillStyle = '#d8d8d8'; c.fillRect(x + 2, y + 4, 12, 1);
    c.fillStyle = '#8a2222'; c.fillRect(x, y + 6, 16, 1);
    c.fillStyle = '#6b5532';
    c.fillRect(x, y, 1, 16); c.fillRect(x + 15, y, 1, 16); c.fillRect(x, y + 15, 16, 1);
  },
  bed_side: (c, x, y) => {
    TILE_PAINTERS.planks(c, x, y);
    c.fillStyle = '#b02e2e'; c.fillRect(x, y + 2, 16, 5);
    c.fillStyle = '#efefef'; c.fillRect(x + 1, y + 2, 4, 3);
    c.fillStyle = '#8a2222'; c.fillRect(x, y + 6, 16, 1);
  },
  torch: (c, x, y) => {
    c.clearRect(x, y, 16, 16);
    const rand = mulberry32(229);
    for (let py = 8; py < 16; py++) {
      c.fillStyle = rand() < 0.4 ? '#5d4222' : '#8a6232';
      c.fillRect(x + 7, y + py, 1, 1);
      c.fillStyle = rand() < 0.4 ? '#5d4222' : '#8a6232';
      c.fillRect(x + 8, y + py, 1, 1);
    }
    c.fillStyle = '#ffd83d'; c.fillRect(x + 7, y + 6, 2, 2);
    c.fillStyle = '#fff0a8'; c.fillRect(x + 7, y + 6, 1, 1);
    c.fillStyle = '#d87f33'; c.fillRect(x + 7, y + 8, 2, 1);
  },
  chest_top: (c, x, y) => {
    noiseFill(c, x, y, ['#9c7240', '#a87c46', '#8f6839'], 130, 1);
    c.fillStyle = '#5d4222';
    c.fillRect(x, y, 16, 1); c.fillRect(x, y + 15, 16, 1);
    c.fillRect(x, y, 1, 16); c.fillRect(x + 15, y, 1, 16);
  },
  chest_side: (c, x, y) => {
    noiseFill(c, x, y, ['#9c7240', '#a87c46', '#8f6839'], 131, 1);
    c.fillStyle = '#5d4222';
    c.fillRect(x, y, 16, 1); c.fillRect(x, y + 15, 16, 1);
    c.fillRect(x, y, 1, 16); c.fillRect(x + 15, y, 1, 16);
    c.fillStyle = '#7a5a32'; c.fillRect(x + 1, y + 6, 14, 1);
  },
  chest_front: (c, x, y) => {
    TILE_PAINTERS.chest_side(c, x, y);
    c.fillStyle = '#8c8c8c'; c.fillRect(x + 7, y + 5, 2, 4);
    c.fillStyle = '#4f4f4f'; c.fillRect(x + 7, y + 7, 2, 1);
  },
  birch_log_side: (c, x, y) => {
    const rand = mulberry32(331);
    for (let px = 0; px < 16; px++) {
      for (let py = 0; py < 16; py++) {
        const r = rand();
        c.fillStyle = r < 0.82 ? '#d7d3c5' : r < 0.93 ? '#e5e1d3' : '#c5c1b3';
        c.fillRect(x + px, y + py, 1, 1);
      }
    }
    // black birch scars
    c.fillStyle = '#2e2e28';
    c.fillRect(x + 2, y + 2, 3, 1); c.fillRect(x + 10, y + 5, 4, 1);
    c.fillRect(x + 5, y + 9, 2, 2); c.fillRect(x + 12, y + 12, 3, 1);
    c.fillRect(x + 1, y + 13, 2, 1); c.fillRect(x + 8, y + 1, 1, 1);
  },
  birch_log_top: (c, x, y) => {
    const rand = mulberry32(332);
    for (let py = 0; py < 16; py++) {
      for (let px = 0; px < 16; px++) {
        const d = Math.max(Math.abs(px - 7.5), Math.abs(py - 7.5));
        let col: string;
        if (d > 6.5) col = rand() < 0.8 ? '#d7d3c5' : '#c5c1b3';
        else col = (d | 0) % 2 === 0 ? '#c8b77a' : '#b3a266';
        c.fillStyle = col;
        c.fillRect(x + px, y + py, 1, 1);
      }
    }
  },
  spruce_log_side: (c, x, y) => {
    const rand = mulberry32(333);
    for (let px = 0; px < 16; px++) {
      const dark = rand() < 0.35;
      for (let py = 0; py < 16; py++) {
        const r = rand();
        c.fillStyle = dark
          ? (r < 0.85 ? '#2e1f0e' : '#3d2a14')
          : (r < 0.8 ? '#3d2a14' : r < 0.92 ? '#4a3419' : '#2e1f0e');
        c.fillRect(x + px, y + py, 1, 1);
      }
    }
  },
  spruce_log_top: (c, x, y) => {
    const rand = mulberry32(334);
    for (let py = 0; py < 16; py++) {
      for (let px = 0; px < 16; px++) {
        const d = Math.max(Math.abs(px - 7.5), Math.abs(py - 7.5));
        let col: string;
        if (d > 6.5) col = rand() < 0.8 ? '#3d2a14' : '#2e1f0e';
        else col = (d | 0) % 2 === 0 ? '#8a6f43' : '#705a35';
        c.fillStyle = col;
        c.fillRect(x + px, y + py, 1, 1);
      }
    }
  },
  birch_leaves: (c, x, y) => {
    noiseFill(c, x, y, ['#6aa84f', '#7fbf61', '#5d9344', '#8cc972'], 335, 0);
    const rand = mulberry32(435);
    for (let i = 0; i < 60; i++) {
      c.clearRect(x + ((rand() * 16) | 0), y + ((rand() * 16) | 0), 1, 1);
    }
  },
  spruce_leaves: (c, x, y) => {
    noiseFill(c, x, y, ['#2d5d3a', '#27513a', '#356a44', '#1f4730'], 336, 0);
    const rand = mulberry32(436);
    for (let i = 0; i < 50; i++) {
      c.clearRect(x + ((rand() * 16) | 0), y + ((rand() * 16) | 0), 1, 1);
    }
  },
  poppy: (c, x, y) => {
    c.clearRect(x, y, 16, 16);
    pixmap(c, x, y, [
      '................', '................', '......RR........', '.....RLRR.......',
      '.....RRRR.......', '......RR........', '.......G........', '.......G........',
      '.......G........', '......GG.G......', '.......GG.......', '.......G........',
      '.......G........', '......GG........', '................', '................',
    ], { R: '#c43030', L: '#e85a5a', G: '#3f7a28' });
  },
  dandelion: (c, x, y) => {
    c.clearRect(x, y, 16, 16);
    pixmap(c, x, y, [
      '................', '................', '................', '......YY........',
      '.....YLLY.......', '.....YLLY.......', '......YY........', '.......G........',
      '.......G........', '.......G.G......', '.......GG.......', '.......G........',
      '......GG........', '................', '................', '................',
    ], { Y: '#e8c633', L: '#f7e26b', G: '#3f7a28' });
  },
  tall_grass: (c, x, y) => {
    c.clearRect(x, y, 16, 16);
    const rand = mulberry32(337);
    for (let i = 0; i < 9; i++) {
      const bx = 1 + ((rand() * 13) | 0);
      const h = 5 + ((rand() * 8) | 0);
      const lean = rand() < 0.5 ? -1 : 1;
      for (let j = 0; j < h; j++) {
        const px = bx + (j > h - 3 ? lean : 0);
        c.fillStyle = rand() < 0.4 ? '#4f8a33' : '#5d9b3d';
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
        c.fillStyle = rib
          ? (r < 0.7 ? '#0f6420' : '#1a7a2e')
          : (r < 0.75 ? '#1a8a35' : r < 0.9 ? '#27a344' : '#0f6420');
        c.fillRect(x + px, y + py, 1, 1);
      }
    }
    c.fillStyle = '#d8e8c8';
    c.fillRect(x + 3, y + 2, 1, 1); c.fillRect(x + 9, y + 6, 1, 1);
    c.fillRect(x + 6, y + 11, 1, 1); c.fillRect(x + 13, y + 13, 1, 1);
  },
  cactus_top: (c, x, y) => {
    noiseFill(c, x, y, ['#1a8a35', '#27a344', '#15942f'], 339, 0);
    c.fillStyle = '#0f6420';
    c.fillRect(x, y, 16, 1); c.fillRect(x, y + 15, 16, 1);
    c.fillRect(x, y, 1, 16); c.fillRect(x + 15, y, 1, 16);
  },
  sugar_cane: (c, x, y) => {
    c.clearRect(x, y, 16, 16);
    const rand = mulberry32(340);
    for (const bx of [3, 7, 11]) {
      for (let py = 0; py < 16; py++) {
        const joint = py % 5 === 4;
        c.fillStyle = joint ? '#7a9c4f' : rand() < 0.7 ? '#9cc06a' : '#aacf7a';
        c.fillRect(x + bx, y + py, 1, 1);
        c.fillStyle = joint ? '#6b8a42' : '#8ab05a';
        c.fillRect(x + bx + 1, y + py, 1, 1);
      }
    }
  },
  farmland_top: (c, x, y) => {
    noiseFill(c, x, y, ['#5d4228', '#52391f', '#694c30'], 341, 1);
    c.fillStyle = '#3a2814';
    for (const row of [1, 5, 9, 13]) c.fillRect(x, y + row, 16, 2);
    const rand = mulberry32(441);
    c.fillStyle = '#2e1f0e';
    for (let i = 0; i < 8; i++) c.fillRect(x + ((rand() * 16) | 0), y + ((rand() * 16) | 0), 1, 1);
  },
  wheat_0: (c, x, y) => {
    c.clearRect(x, y, 16, 16);
    const rand = mulberry32(342);
    c.fillStyle = '#4f8a2e';
    for (const bx of [2, 5, 8, 11, 14]) {
      const h = 3 + ((rand() * 3) | 0);
      for (let j = 0; j < h; j++) c.fillRect(x + bx, y + 15 - j, 1, 1);
    }
  },
  wheat_1: (c, x, y) => {
    c.clearRect(x, y, 16, 16);
    const rand = mulberry32(343);
    for (const bx of [1, 4, 7, 10, 13]) {
      const h = 7 + ((rand() * 4) | 0);
      for (let j = 0; j < h; j++) {
        c.fillStyle = j > h - 3 ? '#8aa83d' : '#5d9b33';
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
        c.fillStyle = j > h - 5 ? '#d8b649' : '#bda23e';
        c.fillRect(x + bx, y + 15 - j, 1, 1);
      }
      // grain head
      c.fillStyle = '#e8cb62';
      c.fillRect(x + bx - 1 + ((rand() * 2) | 0), y + 16 - h, 2, 3);
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
      '................', '................', '......LL........', '....LLLLLL......',
      '...LLLDLLLL.....', '...LLLLLLLL.....', '....LLDLLL......', '.....LLLL.......',
      '.......T........', '.......T........', '.......T........', '......TT........',
      '.......T........', '................', '................', '................',
    ], { L: '#3f8a26', D: '#2f6b1e', T: '#6b522f' });
  },
  ladder: (c, x, y) => {
    c.clearRect(x, y, 16, 16);
    // two side rails + rungs
    const rail = '#6b522f', railDark = '#4a361e', rung = '#8a6a3a';
    for (let py = 0; py < 16; py++) {
      c.fillStyle = py % 2 === 0 ? rail : railDark;
      c.fillRect(x, y + py, 2, 1); c.fillRect(x + 14, y + py, 2, 1);
    }
    for (const ry of [2, 7, 12]) {
      c.fillStyle = rung; c.fillRect(x + 2, y + ry, 12, 2);
      c.fillStyle = railDark; c.fillRect(x + 2, y + ry + 1, 12, 1);
    }
  },
  door_lower: (c, x, y) => {
    const rand = mulberry32(345);
    for (let px = 0; px < 16; px++) {
      for (let py = 0; py < 16; py++) {
        const r = rand();
        c.fillStyle = r < 0.8 ? '#9c7f4e' : r < 0.92 ? '#a88c57' : '#8a703f';
        c.fillRect(x + px, y + py, 1, 1);
      }
    }
    // frame + inset panels
    c.fillStyle = '#5d4222';
    c.fillRect(x, y, 16, 1); c.fillRect(x, y + 15, 16, 1);
    c.fillRect(x + 1, y + 1, 1, 14); c.fillRect(x + 14, y + 1, 1, 14);
    c.fillStyle = '#7a6238';
    c.fillRect(x + 3, y + 3, 10, 4); c.fillRect(x + 3, y + 9, 10, 4);
    c.fillStyle = '#b8945f';
    c.fillRect(x + 3, y + 3, 10, 1); c.fillRect(x + 3, y + 9, 10, 1);
    // iron handle
    c.fillStyle = '#3f3f3f'; c.fillRect(x + 12, y + 8, 2, 2);
  },
  door_upper: (c, x, y) => {
    const rand = mulberry32(345);
    for (let px = 0; px < 16; px++) {
      for (let py = 0; py < 16; py++) {
        const r = rand();
        c.fillStyle = r < 0.8 ? '#9c7f4e' : r < 0.92 ? '#a88c57' : '#8a703f';
        c.fillRect(x + px, y + py, 1, 1);
      }
    }
    c.fillStyle = '#5d4222';
    c.fillRect(x, y, 16, 1); c.fillRect(x, y + 15, 16, 1);
    c.fillRect(x + 1, y, 1, 16); c.fillRect(x + 14, y, 1, 16);
    c.fillStyle = '#7a6238';
    c.fillRect(x + 3, y + 2, 10, 4); c.fillRect(x + 3, y + 8, 10, 5);
    c.fillStyle = '#b8945f';
    c.fillRect(x + 3, y + 2, 10, 1); c.fillRect(x + 3, y + 8, 10, 1);
    // glass pane
    c.fillStyle = 'rgba(200,225,235,0.35)'; c.fillRect(x + 4, y + 9, 8, 3);
  },
  door_top: (c, x, y) => {
    // thin cap shown at the seam between halves
    c.fillStyle = '#5d4222'; c.fillRect(x, y, 16, 16);
    c.fillStyle = '#3a2814'; c.fillRect(x, y, 16, 1);
  },
  trapdoor: (c, x, y) => {
    const rand = mulberry32(346);
    for (let px = 0; px < 16; px++) {
      for (let py = 0; py < 16; py++) {
        const r = rand();
        c.fillStyle = r < 0.8 ? '#8a703f' : '#9c7f4e';
        c.fillRect(x + px, y + py, 1, 1);
      }
    }
    c.fillStyle = '#5d4222';
    c.fillRect(x, y, 16, 1); c.fillRect(x, y + 15, 16, 1);
    c.fillRect(x, y, 1, 16); c.fillRect(x + 15, y, 1, 16);
    c.fillStyle = '#7a6238';
    c.fillRect(x + 1, y + 4, 14, 1); c.fillRect(x + 1, y + 11, 14, 1);
    // iron bolts
    c.fillStyle = '#3f3f3f';
    c.fillRect(x + 2, y + 2, 1, 1); c.fillRect(x + 13, y + 2, 1, 1);
    c.fillRect(x + 2, y + 13, 1, 1); c.fillRect(x + 13, y + 13, 1, 1);
  },
};

/** Stone base with colored ore blobs. */
function oreTile(c: Ctx, x: number, y: number, seed: number, bright: string, dark: string): void {
  noiseFill(c, x, y, STONE_PAL, seed, 1);
  const rand = mulberry32(seed + 100);
  for (let i = 0; i < 5; i++) {
    const bx = 1 + ((rand() * 12) | 0), by = 1 + ((rand() * 12) | 0);
    for (let j = 0; j < 6; j++) {
      const px = Math.min(15, bx + ((rand() * 3) | 0)), py = Math.min(15, by + ((rand() * 3) | 0));
      c.fillStyle = rand() < 0.5 ? bright : dark;
      c.fillRect(x + px, y + py, 1, 1);
    }
  }
}

function metalBlock(c: Ctx, x: number, y: number, base: string, light: string, dark: string): void {
  c.fillStyle = base; c.fillRect(x, y, 16, 16);
  c.fillStyle = light; c.fillRect(x + 1, y + 1, 14, 2); c.fillRect(x + 1, y + 1, 2, 14);
  c.fillStyle = dark; c.fillRect(x + 1, y + 13, 14, 2); c.fillRect(x + 13, y + 3, 2, 12);
  c.fillStyle = base; c.fillRect(x + 3, y + 3, 10, 10);
}

// crack_0 .. crack_9 : growing random-walk fractures, transparent background
for (let stage = 0; stage < 10; stage++) {
  TILE_PAINTERS[`crack_${stage}`] = (c, x, y) => {
    c.clearRect(x, y, 16, 16);
    const rand = mulberry32(900); // same walks every stage; reveal more per stage
    const pts: [number, number][] = [];
    for (let w = 0; w < 7; w++) {
      let px = 3 + ((rand() * 10) | 0), py = 3 + ((rand() * 10) | 0);
      for (let s = 0; s < 26; s++) {
        pts.push([px, py]);
        px = Math.max(0, Math.min(15, px + ((rand() * 3) | 0) - 1));
        py = Math.max(0, Math.min(15, py + ((rand() * 3) | 0) - 1));
      }
    }
    const n = Math.floor(pts.length * ((stage + 1) / 10));
    c.fillStyle = 'rgba(10,10,10,0.75)';
    for (let i = 0; i < n; i++) c.fillRect(x + pts[i][0], y + pts[i][1], 1, 1);
  };
}

// ---------------------------------------------------------------------------
// Item sprites (16x16 pixel maps)
// ---------------------------------------------------------------------------

const WOOD = { M: '#9c7f4e', m: '#7a6238', H: '#8a6232', h: '#5d4222', O: '#241b10' };
const STONEC = { M: '#8c8c8c', m: '#6b6b6b', H: '#8a6232', h: '#5d4222', O: '#241b10' };
const IRONC = { M: '#d8d8d8', m: '#a8a8a8', H: '#8a6232', h: '#5d4222', O: '#241b10' };
const DIAMONDC = { M: '#4aedd9', m: '#33c7c2', H: '#8a6232', h: '#5d4222', O: '#241b10' };

const PICK_MAP = [
  '................',
  '....OOOOOOOO....',
  '...OMMMMMMMMO...',
  '..OMMMm..mMMMO..',
  '..OMO......OMO..',
  '........OHhO....',
  '.......OHhO.....',
  '......OHhO......',
  '.....OHhO.......',
  '....OHhO........',
  '...OHhO.........',
  '..OHhO..........',
  '.OHhO...........',
  '.OhO............',
  '................',
  '................',
];
const AXE_MAP = [
  '................',
  '.....OOOOO......',
  '...OOMMMMMO.....',
  '..OMMMMMMMMO....',
  '..OMMMmMMMOO....',
  '...OMMMOOHhO....',
  '....OO..OHhO....',
  '.......OHhO.....',
  '......OHhO......',
  '.....OHhO.......',
  '....OHhO........',
  '...OHhO.........',
  '..OHhO..........',
  '.OhO............',
  '................',
  '................',
];
const SHOVEL_MAP = [
  '................',
  '......OOOO......',
  '.....OMMMMO.....',
  '.....OMmMMO.....',
  '.....OMmMMO.....',
  '......OmOO......',
  '......OHhO......',
  '.....OHhO.......',
  '....OHhO........',
  '...OHhO.........',
  '..OHhO..........',
  '.OHhO...........',
  '.OhO............',
  '................',
  '................',
  '................',
];
const SWORD_MAP = [
  '................',
  '.......OO.......',
  '......OMMO......',
  '......OMmO......',
  '......OMmO......',
  '......OMmO......',
  '......OMmO......',
  '......OMmO......',
  '....OOOMmOOO....',
  '.....OOHhOO.....',
  '......OHhO......',
  '......OHhO......',
  '.......OO.......',
  '................',
  '................',
  '................',
];

const ITEM_PAINTERS: Record<string, (ctx: Ctx) => void> = {
  stick: (c) => pixmap(c, 0, 0, [
    '................', '................', '..........OO....', '.........OHhO...',
    '........OHhO....', '.......OHhO.....', '......OHhO......', '.....OHhO.......',
    '....OHhO........', '...OHhO.........', '..OHhO..........', '..OhO...........',
    '..OO............', '................', '................', '................',
  ], WOOD),
  coal: (c) => pixmap(c, 0, 0, [
    '................', '................', '................', '.....OOOO.......',
    '...OOKKKKO......', '..OKKkKKKKO.....', '..OKkKKKKKKO....', '.OKKKKKkKKKO....',
    '.OKKkKKKKKKO....', '.OKKKKKKkKO.....', '..OKkKKKKKO.....', '...OOKKKOO......',
    '.....OOO........', '................', '................', '................',
  ], { O: '#0c0c0c', K: '#2b2b2b', k: '#4a4a4a' }),
  wood_pickaxe: (c) => pixmap(c, 0, 0, PICK_MAP, WOOD),
  wood_axe: (c) => pixmap(c, 0, 0, AXE_MAP, WOOD),
  wood_shovel: (c) => pixmap(c, 0, 0, SHOVEL_MAP, WOOD),
  wood_sword: (c) => pixmap(c, 0, 0, SWORD_MAP, WOOD),
  stone_pickaxe: (c) => pixmap(c, 0, 0, PICK_MAP, STONEC),
  stone_axe: (c) => pixmap(c, 0, 0, AXE_MAP, STONEC),
  stone_shovel: (c) => pixmap(c, 0, 0, SHOVEL_MAP, STONEC),
  stone_sword: (c) => pixmap(c, 0, 0, SWORD_MAP, STONEC),
  iron_pickaxe: (c) => pixmap(c, 0, 0, PICK_MAP, IRONC),
  iron_axe: (c) => pixmap(c, 0, 0, AXE_MAP, IRONC),
  iron_shovel: (c) => pixmap(c, 0, 0, SHOVEL_MAP, IRONC),
  iron_sword: (c) => pixmap(c, 0, 0, SWORD_MAP, IRONC),
  diamond_pickaxe: (c) => pixmap(c, 0, 0, PICK_MAP, DIAMONDC),
  diamond_axe: (c) => pixmap(c, 0, 0, AXE_MAP, DIAMONDC),
  diamond_shovel: (c) => pixmap(c, 0, 0, SHOVEL_MAP, DIAMONDC),
  diamond_sword: (c) => pixmap(c, 0, 0, SWORD_MAP, DIAMONDC),
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
  string: (c) => pixmap(c, 0, 0, [
    '................', '................', '.....wWWw.......', '....W....W......',
    '...W.wWw..W.....', '...W.W.W..W.....', '...W.W.W..W.....', '...W.wWw..W.....',
    '....W....W......', '.....wWWw.......', '......W.W.......', '.....W...W......',
    '....W.....W.....', '................', '................', '................',
  ], { W: '#eeeeee', w: '#bcbcbc' }),
  gunpowder: (c) => pixmap(c, 0, 0, [
    '................', '................', '................', '................',
    '......G.G.......', '....G.GGG.G.....', '...GGGgGGGG.....', '..GGgGGGGgGG....',
    '..GGGGgGGGGG....', '...GGGGGgGG.....', '....GGGGGG......', '................',
    '................', '................', '................', '................',
  ], { G: '#5a5a5a', g: '#8a8a8a' }),
  arrow: (c) => pixmap(c, 0, 0, [
    '............OO..', '...........OWWO.', '..........OWWWO.', '..........OWWO..',
    '.........OHO....', '........OHO.....', '.......OHO......', '......OHO.......',
    '.....OHO........', '....OHO.........', '...FFO..........', '..FFF...........',
    '..FFF...........', '.F.F............', '................', '................',
  ], { O: '#3f3f3f', W: '#c8c8d0', H: '#8a6232', F: '#e8e8e8' }),
  bow: (c) => pixmap(c, 0, 0, [
    '................', '......OHHO......', '....OHHhhHO.....', '...OHhO..OHO....',
    '..OHhO....OHO...', '..OHO......OW...', '.OHhO......W....', '.OHO......W.....',
    '.OHO.....W......', '.OHhO...W.......', '..OHO..W........', '..OHhOW.........',
    '...OWW..........', '....W...........', '................', '................',
  ], { O: '#241b10', H: '#8a6232', h: '#a87c46', W: '#e8e8e8' }),
  mutton: (c) => meatSprite(c, '#d8555f', '#e88a92'),
  cooked_mutton: (c) => meatSprite(c, '#8a4a28', '#b5713f'),
  beef: (c) => meatSprite(c, '#b03a3a', '#d06868'),
  cooked_beef: (c) => meatSprite(c, '#6b3a1f', '#9c5a32'),
  seeds: (c) => pixmap(c, 0, 0, [
    '................', '................', '................', '.......g........',
    '......gSg.......', '.....OSSO.......', '....OSSSSO......', '...OSsSSsSO.....',
    '...OSSSSSSO.....', '....OSSSSO......', '.....OOOO.......', '................',
    '................', '................', '................', '................',
  ], { O: '#6b4a1e', S: '#d8c07a', s: '#b89a52', g: '#7aa83d' }),
  wheat: (c) => pixmap(c, 0, 0, [
    '................', '..........WW....', '.........WWW....', '........WWW.....',
    '.......WWWW.....', '......WWWW......', '......WWW.......', '.....WWWH.......',
    '....WWWH........', '....WWH.........', '...WWH..........', '...WH...........',
    '..HH............', '..H.............', '................', '................',
  ], { W: '#d8b649', H: '#a8862e' }),
  bread: (c) => pixmap(c, 0, 0, [
    '................', '................', '................', '................',
    '......OOOOO.....', '....OOLLLLLO....', '...OLLLLLLLLO...', '..OLLBBBBBLLO...',
    '..OBBBBBBBBBO...', '..OBBBBBBBBO....', '...OBBBBBBO.....', '....OOOOOO......',
    '................', '................', '................', '................',
  ], { O: '#4a2f14', B: '#9c6f3a', L: '#d8b070' }),
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
  beetroot_seeds: (c) => pixmap(c, 0, 0, [
    '................', '................', '................', '.......g........',
    '......gSg.......', '.....OSSO.......', '....OSSSSO......', '...OSsSSsSO.....',
    '...OSSSSSSO.....', '....OSSSSO......', '.....OOOO.......', '................',
    '................', '................', '................', '................',
  ], { O: '#5a1028', S: '#c83a5a', s: '#9c2848', g: '#7aa83d' }),
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
  apple: (c) => pixmap(c, 0, 0, [
    '................', '.......HH.......', '......HH........', '....OOHOO.......',
    '...ORRLRRRO.....', '..ORLRRRRRRO....', '..ORLRRRRRRO....', '..ORRRRRRRRO....',
    '..ORRRRRRRO.....', '...ORRRRRRO.....', '....ORROORO.....', '.....OO..O......',
    '................', '................', '................', '................',
  ], { O: '#4a1010', R: '#d83030', L: '#f4a0a0', H: '#5d8a2a' }),
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
  bone: (c) => pixmap(c, 0, 0, [
    '................', '............OO..', '...........OWWO.', '..........OWWWO.',
    '.........OWWWWO.', '........OWWWWO..', '..OO..OOOWWWWO..', '.OWWOOOWWWWWO...',
    '.OWWWWWWWWWO....', '..OWWWWWWWO.....', '...OWWWWWO......', '....OWWWO.......',
    '....OWWO........', '.....OO.........', '................', '................',
  ], { O: '#8a7a5a', W: '#e8e0c8' }),
  bone_meal: (c) => pixmap(c, 0, 0, [
    '................', '................', '................', '................',
    '......W.W.......', '....W.WWW.W.....', '...WWWwWWWW.....', '..WWwWWWWwWW....',
    '..WWWWwWWWWW....', '...WWWWWwWW.....', '....WWWWWW......', '................',
    '................', '................', '................', '................',
  ], { W: '#ececec', w: '#c4c4c4' }),
  emerald: (c) => pixmap(c, 0, 0, [
    '................', '................', '................', '.......O........',
    '......OGO.......', '.....OGGGO......', '....OGGGGGO.....', '....OGGGGGO.....',
    '....OGGGGGO.....', '.....OGGGGO.....', '......OGGO......', '.......OO.......',
    '................', '................', '................', '................',
  ], { O: '#0a3a2a', G: '#3fd878' }),
  fishing_rod: (c) => pixmap(c, 0, 0, [
    '............OO..', '...........OSO..', '..........OSSO..', '.........OSSSO..',
    '........OSSSO...', '.......OSSSO....', '......OSSSO.....', '.....OSSSO......',
    '....OSSSO.......', '...OSSSO........', '..OSSSO.........', '.OSSSO..........',
    'OSSSO...........', 'OOO.............', '................', '................',
  ], { O: '#5d4222', S: '#c8c8c8' }),
  raw_fish: (c) => meatSprite(c, '#9ab8d8', '#c8dcef'),
  cooked_fish: (c) => meatSprite(c, '#b5854a', '#d8a868'),
  compass: (c) => pixmap(c, 0, 0, [
    '................', '................', '.....OOOOO......', '....OBBBBBO.....',
    '...OBeBBBBeO....', '..OBBPPPPPBBO...', '..OBePPRRPPeO...', '..OBBPRRRRPBO...',
    '..OBPPRRRPPBO...', '..OBePPRRPPeO...', '..OBBPPPPPBeO...', '...OBeBBBBeO....',
    '....OBBBBBO.....', '.....OOOOO......', '................', '................',
  ], { O: '#5d4222', B: '#d8c898', e: '#b8a878', P: '#f0e8c8', R: '#d83030' }),
  clock: (c) => pixmap(c, 0, 0, [
    '................', '................', '.....OOOOO......', '....OGGGGGO.....',
    '...OGWWWWWGO....', '..OGWWWWWWWGO...', '..OGWWNNNWWGO...', '..OGWWNWNWWGO...',
    '..OGWWNNNWWGO...', '..OGWWWWWWWGO...', '...OGWWWWWGO....', '....OGGGGGO.....',
    '.....OOOOO......', '................', '................', '................',
  ], { O: '#5d4222', G: '#d8c898', W: '#f0e8c8', N: '#1a1a1a' }),
  porkchop: (c) => pixmap(c, 0, 0, [
    '................', '................', '....OOOO........', '...OPPPPO.......',
    '..OPPpppPO......', '..OPpppppPO.....', '..OPpppppPO.....', '...OPpppPPO.....',
    '....OPPPPPO.....', '.....OPPPOO.....', '......OOOWO.....', '.........OWO....',
    '..........OWO...', '...........O....', '................', '................',
  ], { O: '#3d1f17', P: '#e2747c', p: '#f4a3a8', W: '#f2e3d5' }),
  cooked_porkchop: (c) => pixmap(c, 0, 0, [
    '................', '................', '....OOOO........', '...OPPPPO.......',
    '..OPPpppPO......', '..OPpppppPO.....', '..OPpppppPO.....', '...OPpppPPO.....',
    '....OPPPPPO.....', '.....OPPPOO.....', '......OOOWO.....', '.........OWO....',
    '..........OWO...', '...........O....', '................', '................',
  ], { O: '#3d1f17', P: '#9c6a3a', p: '#c98f54', W: '#f2e3d5' }),
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
};
for (let i = 0; i < 10; i++) {
  PACK_MAP[`crack_${i}`] = { paths: [`block/destroy_stage_${i}`], kind: 'crack' };
}

// ---------------------------------------------------------------------------
// Atlas
// ---------------------------------------------------------------------------

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
    this.texture.minFilter = THREE.NearestFilter;
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
    this.texture.needsUpdate = true;
  }

  rect(name: string): UVRect {
    const idx = this.tiles.get(name);
    if (idx === undefined) throw new Error(`Unknown tile ${name}`);
    const [x, y] = this.slotXY(idx);
    const W = this.canvas.width, H = this.canvas.height;
    const e = 0.02; // half-ish texel inset against bleeding
    return {
      u0: (x + e) / W, v0: (y + e) / H,
      u1: (x + TILE - e) / W, v1: (y + TILE - e) / H,
    };
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
    if (d.block && d.faces) {
      const top = this.tileCanvas(d.faces.top);
      const side = this.tileCanvas(d.faces.front ?? d.faces.sides);
      const side2 = this.tileCanvas(d.faces.sides);
      // top face
      ctx.setTransform(0.93, 0.47, -0.93, 0.47, 16, 0.6);
      ctx.drawImage(top, 0, 0, 16, 16, 0, 0, 16, 16);
      // left face (front texture), darkened
      ctx.setTransform(0.93, 0.47, 0, 1.06, 1.1, 8);
      ctx.filter = 'brightness(78%)';
      ctx.drawImage(side, 0, 0, 16, 16, 0, 0, 16, 16);
      // right face, darker
      ctx.setTransform(0.93, -0.47, 0, 1.06, 16, 15.5);
      ctx.filter = 'brightness(58%)';
      ctx.drawImage(side2, 0, 0, 16, 16, 0, 0, 16, 16);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.filter = 'none';
    } else if (d.sprite) {
      const s = this.itemSprites.get(d.sprite);
      if (s) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(s, 0, 0, 16, 16, 0, 0, 32, 32);
      }
    }
    this.iconCache.set(id, c);
    return c;
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
