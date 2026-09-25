// Procedural pixel-art helpers for the DOM UI: a hand-drawn bitmap font (screen
// titles, stack counts), the 3D block logo, crisp 9x9 HUD icons and small GUI
// glyphs. Everything is painted at 1 art-pixel = 1 canvas pixel and scaled up in
// CSS with image-rendering: pixelated, so it stays razor sharp at any size.

type Pal = Record<string, string>;

/** Paint a char-grid ('.' = transparent) into a fresh canvas. */
export function pixelCanvas(rows: string[], pal: Pal, cls = 'pix'): HTMLCanvasElement {
  const w = Math.max(...rows.map((r) => r.length));
  const c = document.createElement('canvas');
  c.width = w; c.height = rows.length;
  c.className = cls;
  const ctx = c.getContext('2d')!;
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      const col = pal[rows[y][x]];
      if (!col) continue;
      ctx.fillStyle = col;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return c;
}

/** Show a pixel canvas at an integer scale. */
export function scaled<T extends HTMLCanvasElement>(c: T, s: number): T {
  c.style.width = `${c.width * s}px`;
  c.style.height = `${c.height * s}px`;
  return c;
}

// ---------------------------------------------------------------------------
// Bitmap font: 7-row cap height, 2-row descenders, proportional widths
// ---------------------------------------------------------------------------

const GLYPHS: Record<string, string[]> = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.####', '#....', '#....', '#..##', '#...#', '#...#', '.####'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['###', '.#.', '.#.', '.#.', '.#.', '.#.', '###'],
  J: ['....#', '....#', '....#', '....#', '#...#', '#...#', '.###.'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#...#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#..#.', '#...#', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '.#.#.', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#...#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  a: ['.....', '.....', '.###.', '....#', '.####', '#...#', '.####'],
  b: ['#....', '#....', '#.##.', '##..#', '#...#', '#...#', '####.'],
  c: ['.....', '.....', '.###.', '#...#', '#....', '#...#', '.###.'],
  d: ['....#', '....#', '.##.#', '#..##', '#...#', '#...#', '.####'],
  e: ['.....', '.....', '.###.', '#...#', '#####', '#....', '.####'],
  f: ['..##', '.#..', '####', '.#..', '.#..', '.#..', '.#..'],
  g: ['.....', '.....', '.####', '#...#', '#...#', '.####', '....#', '####.'],
  h: ['#....', '#....', '#.##.', '##..#', '#...#', '#...#', '#...#'],
  i: ['#', '.', '#', '#', '#', '#', '#'],
  j: ['...#', '....', '...#', '...#', '...#', '...#', '#..#', '.##.'],
  k: ['#...', '#...', '#..#', '#.#.', '##..', '#.#.', '#..#'],
  l: ['#.', '#.', '#.', '#.', '#.', '#.', '.#'],
  m: ['.....', '.....', '##.#.', '#.#.#', '#.#.#', '#...#', '#...#'],
  n: ['.....', '.....', '####.', '#...#', '#...#', '#...#', '#...#'],
  o: ['.....', '.....', '.###.', '#...#', '#...#', '#...#', '.###.'],
  p: ['.....', '.....', '#.##.', '##..#', '#...#', '####.', '#....', '#....'],
  q: ['.....', '.....', '.##.#', '#..##', '#...#', '.####', '....#', '....#'],
  r: ['.....', '.....', '#.##.', '##..#', '#....', '#....', '#....'],
  s: ['.....', '.....', '.####', '#....', '.###.', '....#', '####.'],
  t: ['.#.', '.#.', '###', '.#.', '.#.', '.#.', '..#'],
  u: ['.....', '.....', '#...#', '#...#', '#...#', '#...#', '.####'],
  v: ['.....', '.....', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  w: ['.....', '.....', '#...#', '#...#', '#.#.#', '#.#.#', '.####'],
  x: ['.....', '.....', '#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
  y: ['.....', '.....', '#...#', '#...#', '#...#', '.####', '....#', '####.'],
  z: ['.....', '.....', '#####', '...#.', '..#..', '.#...', '#####'],
  0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '#####'],
  2: ['.###.', '#...#', '....#', '..##.', '.#...', '#....', '#####'],
  3: ['.###.', '#...#', '....#', '..##.', '....#', '#...#', '.###.'],
  4: ['...##', '..#.#', '.#..#', '#...#', '#####', '....#', '....#'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '#...#', '....#', '...#.', '..#..', '..#..', '..#..'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  '!': ['#', '#', '#', '#', '#', '.', '#'],
  '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
  '.': ['.', '.', '.', '.', '.', '.', '#'],
  ',': ['.', '.', '.', '.', '.', '#', '#', '#'],
  ':': ['.', '#', '.', '.', '.', '#', '.'],
  "'": ['#', '#', '.', '.', '.', '.', '.'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  '/': ['....#', '...#.', '...#.', '..#..', '.#...', '.#...', '#....'],
  '%': ['#...#', '#..#.', '...#.', '..#..', '.#...', '.#..#', '#...#'],
  '(': ['..#', '.#.', '#..', '#..', '#..', '.#.', '..#'],
  ')': ['#..', '.#.', '..#', '..#', '..#', '.#.', '#..'],
  ' ': ['...', '...', '...', '...', '...', '...', '...'],
};

const GLYPH_H = 9; // 7 cap rows + 2 descender rows

function glyph(ch: string): string[] {
  return GLYPHS[ch] ?? GLYPHS[ch.toUpperCase()] ?? GLYPHS['?'];
}

/** Width in art pixels of a string (1px tracking, no trailing gap). */
export function textWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += glyph(ch)[0].length + 1;
  return Math.max(0, w - 1);
}

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * k), g = Math.round(((n >> 8) & 255) * k), b = Math.round((n & 255) * k);
  return `rgb(${r},${g},${b})`;
}

/** Render text in the bitmap font with the classic 1px drop shadow (at 25%
 *  brightness, like vanilla). Returns a 1x canvas; scale it with `scaled()`. */
export function pixelText(text: string, color = '#ffffff', shadow = true): HTMLCanvasElement {
  const w = textWidth(text) + (shadow ? 1 : 0);
  const c = document.createElement('canvas');
  c.width = Math.max(1, w); c.height = GLYPH_H + (shadow ? 1 : 0);
  c.className = 'pix ptext';
  const ctx = c.getContext('2d')!;
  const paint = (ox: number, oy: number, col: string): void => {
    ctx.fillStyle = col;
    let x = ox;
    for (const ch of text) {
      const g = glyph(ch);
      for (let y = 0; y < g.length; y++) {
        for (let gx = 0; gx < g[y].length; gx++) if (g[y][gx] === '#') ctx.fillRect(x + gx, oy + y, 1, 1);
      }
      x += g[0].length + 1;
    }
  };
  if (shadow) paint(1, 1, color.startsWith('#') ? shade(color, 0.25) : 'rgba(0,0,0,0.6)');
  paint(0, 0, color);
  c.setAttribute('role', 'img');
  c.setAttribute('aria-label', text);
  return c;
}

const countCache = new Map<number, HTMLCanvasElement>();
/** Stack-count numeral (white, shadowed) shown bottom-right of a slot. */
export function countCanvas(n: number): HTMLCanvasElement {
  let base = countCache.get(n);
  if (!base) { base = pixelText(String(n), '#ffffff'); countCache.set(n, base); }
  const c = document.createElement('canvas');
  c.width = base.width; c.height = base.height;
  c.className = 'pix ptext';
  c.getContext('2d')!.drawImage(base, 0, 0);
  return scaled(c, 2);
}

// ---------------------------------------------------------------------------
// Title logo: every font pixel becomes a little stone cube with depth
// ---------------------------------------------------------------------------

/** "VOXELCRAFT" as extruded stone blocks. `tex` is a 16x16 tile to sample. */
export function drawLogo(text: string, tex: HTMLCanvasElement | null, P = 8): HTMLCanvasElement {
  const up = text.toUpperCase();
  const tw = textWidth(up);
  const depth = Math.round(P * 0.75);
  const c = document.createElement('canvas');
  c.width = tw * P + depth + 4; c.height = 7 * P + depth + 4;
  c.className = 'menu-logo';
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const cells: [number, number][] = [];
  let x0 = 0;
  for (const ch of up) {
    const g = glyph(ch);
    for (let y = 0; y < 7; y++) for (let x = 0; x < g[y].length; x++) if (g[y][x] === '#') cells.push([x0 + x, y]);
    x0 += g[0].length + 1;
  }
  const px = (x: number): number => 2 + x * P;
  // extrusion: stacked dark copies stepping down-right, darkest furthest back
  for (let k = depth; k >= 1; k--) {
    const t = k / depth;
    ctx.fillStyle = `rgb(${Math.round(58 - 30 * t)},${Math.round(58 - 30 * t)},${Math.round(64 - 30 * t)})`;
    for (const [x, y] of cells) ctx.fillRect(px(x) + k, px(y) + k, P, P);
  }
  // faces: stone texture (sampled per cube), top-lit gradient + bevel edges
  const set = new Set(cells.map(([x, y]) => `${x},${y}`));
  for (const [x, y] of cells) {
    const X = px(x), Y = px(y);
    if (tex) {
      const sx = (x * 5) % Math.max(1, 16 - P), sy = (y * 3) % Math.max(1, 16 - P);
      ctx.drawImage(tex, sx, sy, Math.min(P, 16), Math.min(P, 16), X, Y, P, P);
    } else {
      ctx.fillStyle = '#8a8a8a'; ctx.fillRect(X, Y, P, P);
    }
    // gentle vertical light falloff across the whole word
    ctx.fillStyle = `rgba(255,255,255,${0.2 - y * 0.035})`;
    if (y < 3) ctx.fillRect(X, Y, P, P);
    else { ctx.fillStyle = `rgba(0,0,0,${(y - 3) * 0.06})`; ctx.fillRect(X, Y, P, P); }
    // bevel only on exposed edges so each letter reads as one carved slab
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    if (!set.has(`${x},${y - 1}`)) ctx.fillRect(X, Y, P, 1);
    if (!set.has(`${x - 1},${y}`)) ctx.fillRect(X, Y, 1, P);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    if (!set.has(`${x},${y + 1}`)) ctx.fillRect(X, Y + P - 1, P, 1);
    if (!set.has(`${x + 1},${y}`)) ctx.fillRect(X + P - 1, Y, 1, P);
  }
  c.setAttribute('role', 'img');
  c.setAttribute('aria-label', text);
  return c;
}

// ---------------------------------------------------------------------------
// HUD status icons (9x9, vanilla proportions)
// ---------------------------------------------------------------------------

const HEART = [
  '.OOO.OOO.',
  'OWWROrRRO',
  'OWRRRRRRO',
  'ORRRRRRRO',
  'ORRRRRRdO',
  '.ORRRRdO.',
  '..ORRdO..',
  '...OdO...',
  '....O....',
];
const SHANK = [
  '...OOOO..',
  '..OBBBbO.',
  '.OBBBBBbO',
  '.OBBBBBbO',
  '.OBBBBbbO',
  '.OOBBbbO.',
  'OWOOOOO..',
  'OWWO.....',
  '.OO......',
];
const ARMOR = [
  'OO.OOO.OO',
  'OMOMMMOMO',
  'OMMMMMMmO',
  '.OMMMMmO.',
  '.OMMMMmO.',
  '.OMMMMmO.',
  '.OMMMMmO.',
  '..OMMmO..',
  '...OOO...',
];
const BUBBLE = [
  '..OOOO...',
  '.OLLBBO..',
  'OLBBBBBO.',
  'OBBBBBBO.',
  'OBBBBBdO.',
  'OBBBBBdO.',
  '.OBBddO..',
  '..OOOO...',
  '.........',
];

export type Fill = 'full' | 'half' | 'empty';
const iconCache = new Map<string, HTMLCanvasElement>();

/** A 9x9 HUD icon; `half` keeps the filled half on `halfSide`. `flash` draws the
 *  white damage-blink outline vanilla uses when you get hurt. */
function statIcon(key: string, map: string[], full: Pal, empty: Pal, fill: Fill, halfSide: 'left' | 'right', flash: boolean): HTMLCanvasElement {
  const ck = `${key}:${fill}:${halfSide}:${flash}`;
  let src = iconCache.get(ck);
  if (!src) {
    const o: Pal = flash ? { O: '#ffffff' } : {};
    src = pixelCanvas(map, { ...(fill === 'empty' ? empty : full), ...o });
    if (fill === 'half') {
      const e = pixelCanvas(map, { ...empty, ...o });
      const ctx = src.getContext('2d')!;
      const x = halfSide === 'left' ? 5 : 0, w = halfSide === 'left' ? 4 : 5;
      ctx.clearRect(x, 0, w, 9);
      ctx.drawImage(e, x, 0, w, 9, x, 0, w, 9);
    }
    iconCache.set(ck, src);
  }
  const c = document.createElement('canvas');
  c.width = 9; c.height = 9;
  c.className = 'stat-icon';
  c.getContext('2d')!.drawImage(src, 0, 0);
  return c;
}

export function heartIcon(fill: Fill, flash = false): HTMLCanvasElement {
  return statIcon('heart', HEART,
    { O: '#1a0606', R: '#e3232d', r: '#ff6a6a', W: '#ffd0d0', d: '#a8141c' },
    { O: '#1a0606', R: '#3a1616', r: '#3a1616', W: '#4a2222', d: '#2c1010' }, fill, 'left', flash);
}
export function shankIcon(fill: Fill, flash = false): HTMLCanvasElement {
  return statIcon('shank', SHANK,
    { O: '#2a1206', B: '#c0702e', b: '#8c4a1c', W: '#efe6d4' },
    { O: '#2a1206', B: '#3b2717', b: '#33200f', W: '#4a3622' }, fill, 'right', flash);
}
export function armorIcon(fill: Fill): HTMLCanvasElement {
  return statIcon('armor', ARMOR,
    { O: '#0c0c14', M: '#d8d8e6', m: '#8e8ea8' },
    { O: '#0c0c14', M: '#26262f', m: '#1c1c24' }, fill, 'left', false);
}
export function bubbleIcon(popping = false): HTMLCanvasElement {
  return statIcon('bubble', BUBBLE,
    { O: '#1d3a63', B: '#3f8ee0', L: '#cfe8ff', d: '#2a64b0' },
    { O: '#1d3a63', B: 'rgba(63,142,224,0.3)', L: 'rgba(207,232,255,0.4)', d: 'rgba(42,100,176,0.3)' },
    popping ? 'empty' : 'full', 'left', false);
}

// ---------------------------------------------------------------------------
// Small GUI glyphs
// ---------------------------------------------------------------------------

const FLAME = [
  '......F.......',
  '.....FF.......',
  '.....FFF..F...',
  '....FFYF..FF..',
  '...FFYYFF.FF..',
  '...FYYYFFFFF..',
  '..FFYWYYFYFF..',
  '..FYYWWYYYYF..',
  '.FFYWWWWYYYFF.',
  '.FYYWWWWWYYYF.',
  '.FYWWWWWWWYYF.',
  '.FFYWWWWWYYFF.',
  '..FFYYYYYYFF..',
  '...FFFFFFFF...',
];

export const GUI_ICONS = {
  flameLit: (): HTMLCanvasElement => pixelCanvas(FLAME, { F: '#d8471a', Y: '#ffab2a', W: '#fff27a' }),
  flameOut: (): HTMLCanvasElement => pixelCanvas(FLAME, { F: '#6c6c6c', Y: '#747474', W: '#7a7a7a' }),
  book: (): HTMLCanvasElement => pixelCanvas([
    '..KKKKKKKKK.',
    '.KGGGGGGGGgK',
    '.KGgGGGGGGgK',
    'KGGGGGGGGgK.',
    'KGGYYYYGGgK.',
    'KGGGGGGGgK..',
    'KGGGGGGGgK..',
    'KWWWWWWWK...',
    '.KKKKKKKK...',
  ], { K: '#1c2a12', G: '#4f8a2a', g: '#2f5a18', Y: '#e7c64a', W: '#f0ead6' }),
  trash: (): HTMLCanvasElement => pixelCanvas([
    '....OOOO....',
    'OOOOOOOOOOOO',
    'OLLLLLLLLLLO',
    '.OLLDLLDLLO.',
    '.OLLDLLDLLO.',
    '.OLLDLLDLLO.',
    '.OLLDLLDLLO.',
    '.OLLDLLDLLO.',
    '..OOOOOOOO..',
  ], { O: '#2a2a2a', L: '#bdbdbd', D: '#7a7a7a' }),
  lock: (): HTMLCanvasElement => pixelCanvas([
    '..OOO..',
    '.O...O.',
    '.O...O.',
    'OOOOOOO',
    'OYYYYYO',
    'OYYOYYO',
    'OYYYYYO',
    'OOOOOOO',
  ], { O: '#2a2208', Y: '#e0b43a' }),
  table: (): HTMLCanvasElement => pixelCanvas([
    'OOOOOOOOO',
    'OBbBbBbBO',
    'OOOOOOOOO',
    'OP.O.O.PO',
    'OP.OOO.PO',
    'OPPPPPPPO',
    'OOOOOOOOO',
  ], { O: '#3a2410', B: '#b08050', b: '#8a6038', P: '#9a6c3c' }),
};

// ---------------------------------------------------------------------------
// Player preview figure (inventory screen)
// ---------------------------------------------------------------------------

const ARMOR_TINT: Record<string, [string, string]> = {
  leather: ['#8a5530', '#6a3f22'],
  iron: ['#d4d4dc', '#9c9ca8'],
  gold: ['#f2d54a', '#c9a526'],
  diamond: ['#5fe3d6', '#2fa9a0'],
  chain: ['#9aa0a8', '#6a7078'],
};

/** A front-facing blocky adventurer (16x32 art px) wearing whatever armor is
 *  equipped; `armorNames` holds item names per slot (head, chest, legs, feet). */
export function drawPlayerFigure(armorNames: (string | null)[], blink = false): HTMLCanvasElement {
  const rows = [
    '....HHHHHHHH....',
    '....HHHHHHHH....',
    '....HSSSSSSH....',
    '....SSSSSSSS....',
    '....SWESSEWS....',
    '....SSSNNSSS....',
    '....SSMMMMSS....',
    '....SSSSSSSS....',
    'AAAATTTTTTTTAAAA',
    'AAAATTTTTTTTAAAA',
    'AAAATTTttTTTAAAA',
    'AAAATTTTTTTTAAAA',
    'SSSSTTTTTTTTSSSS',
    'SSSSTTTTTTTTSSSS',
    'SSSSTTTTTTTTSSSS',
    'SSSSTTTTTTTTSSSS',
    'SSSSTTTTTTTTSSSS',
    'SSSSTTTTTTTTSSSS',
    'SSSSTTTTTTTTSSSS',
    'SSSSTTTTTTTTSSSS',
    '....PPPPPPPP....',
    '....PPPPPPPP....',
    '....PPPPpPPP....',
    '....PPPPpPPP....',
    '....PPPPpPPP....',
    '....PPPPpPPP....',
    '....PPPPpPPP....',
    '....PPPPpPPP....',
    '....GGGGpGGG....',
    '....GGGGpGGG....',
    '....GGGGpGGG....',
    '....GGGGpGGG....',
  ];
  const pal: Pal = {
    H: '#3b2413', S: '#c89878', W: '#ffffff', E: blink ? '#b58868' : '#4a3a8a', N: '#a8785a', M: '#8a5a44',
    T: '#2fa0a4', t: '#258085', A: '#2fa0a4', P: '#3a3a9a', p: '#2c2c7a', G: '#5a5a5a',
  };
  const c = pixelCanvas(rows, pal, 'pix player-fig');
  const ctx = c.getContext('2d')!;
  const tintOf = (name: string | null): [string, string] | null => {
    if (!name) return null;
    for (const k of Object.keys(ARMOR_TINT)) if (name.includes(k)) return ARMOR_TINT[k];
    return ARMOR_TINT.iron;
  };
  const paint = (t: [string, string] | null, rects: [number, number, number, number][]): void => {
    if (!t) return;
    for (const [x, y, w, h] of rects) {
      ctx.fillStyle = t[0]; ctx.fillRect(x, y, w, h);
      ctx.fillStyle = t[1]; ctx.fillRect(x, y + h - 1, w, 1); ctx.fillRect(x + w - 1, y, 1, h);
    }
  };
  // helmet: cap + cheek guards, chest: torso + shoulders, legs: pants, feet: boots
  paint(tintOf(armorNames[0]), [[4, 0, 8, 2], [4, 2, 1, 4], [11, 2, 1, 4]]);
  paint(tintOf(armorNames[1]), [[4, 8, 8, 12], [0, 8, 4, 4], [12, 8, 4, 4]]);
  paint(tintOf(armorNames[2]), [[4, 20, 8, 2], [4, 22, 4, 6], [8, 22, 4, 6]]);
  paint(tintOf(armorNames[3]), [[4, 28, 4, 4], [8, 28, 4, 4]]);
  return c;
}
