// World loading screen: a slowly turning isometric diorama of the real spawn
// terrain whose columns drop into place as their chunks finish generating,
// an animated progress bar with named stages, rotating tips and a "dive in"
// exit. Everything is painted from the procedural block atlas on a 2D canvas.

import type { Atlas } from '../engine/Textures';
import { B, I, def, hasDef, TINTED_TILES } from '../engine/Blocks';
import { pixelText, scaled } from './Pixel';

/** One sampled terrain column (world units). */
export interface LoadColumn {
  /** y of the topmost solid ground block */
  y: number;
  /** ground block id */
  id: number;
  /** water surface y above the ground, or -1 */
  water: number;
  /** leaves / log block ids of a tree standing here (0 = none) */
  leaf: number;
  log: number;
  /** biome grass tint 0..1 */
  tint: [number, number, number];
}

export type LoadSampler = (wx: number, wz: number) => LoadColumn | null;

interface Col {
  data: LoadColumn | null;
  /** performance.now() ms when the column starts dropping in */
  born: number;
  /** stacked cube tiles bottom→top: [tileTop, tileSide, alpha] */
  layers: { top: HTMLCanvasElement; side: HTMLCanvasElement; alpha: number }[];
  base: number;          // rel y of the lowest layer
  tree: { log: HTMLCanvasElement; logTop: HTMLCanvasElement; leaf: HTMLCanvasElement } | null;
  landed: boolean;
}

const N = 16;            // columns per side
const STEP = 5;          // world blocks per column
const BASE = -4;         // lowest rel layer
const V_SCALE = 2;       // world blocks per diorama layer

const STAGES: { label: string; icon: number }[] = [
  { label: 'Shaping terrain', icon: B.GRASS },
  { label: 'Carving caves', icon: B.COAL_ORE },
  { label: 'Growing trees', icon: B.LEAVES },
  { label: 'Building chunks', icon: B.TABLE },
  { label: 'Spawning mobs', icon: I.BONE },
];

const TIPS = [
  'Punch a tree to get wood, then craft planks and a crafting table.',
  'Hold Shift while clicking a slot to quick-move the whole stack.',
  'Hover a slot and press 1-9 to swap it with that hotbar slot.',
  'Sleep in a bed at night to skip to morning and set your spawn.',
  'Torches keep monsters from spawning nearby.',
  'Carry a compass to see the minimap; a clock shows the time.',
  'Right-click a wolf with a bone to tame it.',
  'Throw a mob catcher at a hostile mob to capture it as a pet.',
  'Double-tap W to sprint; sprinting drains hunger faster.',
  'Press F3 for coordinates, F1 to hide the HUD, F2 for a screenshot.',
  'The recipe book fills the crafting grid for you - just click a recipe.',
  'Water cancels fall damage. Jump in!',
  'Build a 4x5 obsidian frame and light it to reach the Nether.',
  'Press L to see your advancements.',
  'Press H any time for the controls reference.',
];

const easeOutBack = (t: number): number => {
  const c1 = 1.5, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  parent.appendChild(e);
  return e;
}

export class LoadingScreen {
  readonly el: HTMLElement;
  private atlas: Atlas;
  private canvas: HTMLCanvasElement;
  private cols: Col[] = [];
  private tileCache = new Map<string, HTMLCanvasElement>();
  private dust: { x: number; y: number; vx: number; vy: number; life: number; c: string }[] = [];
  private raf = 0;
  private t0 = 0;
  private lastDraw = 0;
  private reduced = false;
  private mode: 'world' | 'spinner' = 'world';
  private done = false;
  private doneAt = 0;
  // progress
  private target = 0;
  private shown = 0;
  private stage = 0;
  private fillEl: HTMLElement | null = null;
  private pctEl: HTMLElement | null = null;
  private stageEl: HTMLElement | null = null;
  private stepEls: HTMLElement[] = [];
  private tipEl: HTMLElement | null = null;
  private tipTimer: ReturnType<typeof setInterval> | null = null;
  // terrain source
  private cx = 0;
  private cz = 0;
  private h0 = 64;
  private sample: LoadSampler | null = null;
  private pending = N * N;

  constructor(atlas: Atlas) {
    this.atlas = atlas;
    this.el = document.createElement('div');
    this.el.className = 'load-box';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'load-diorama';
    this.canvas.setAttribute('aria-hidden', 'true');
    try { this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* old browser */ }
  }

  /** Build the screen. 'world' shows the diorama + stages; 'spinner' a lone
   *  turning block (saving, quitting). */
  mount(parent: HTMLElement, title: string, mode: 'world' | 'spinner'): void {
    this.mode = mode;
    this.done = false;
    this.target = 0; this.shown = 0; this.stage = 0;
    this.cols = [];
    this.dust = [];
    this.pending = N * N;
    this.sample = null;
    for (let i = 0; i < N * N; i++) this.cols.push({ data: null, born: 0, layers: [], base: BASE, tree: null, landed: false });
    const box = this.el;
    box.innerHTML = '';
    box.classList.toggle('spinner', mode === 'spinner');
    parent.appendChild(box);

    const head = el('div', 'load-title', box);
    const small = window.innerHeight < 520 || window.innerWidth < 520;
    head.appendChild(scaled(pixelText(title.replace(/\.+$/, ''), '#ffffff'), small ? 2 : 3));
    head.setAttribute('aria-label', title);

    const stageWrap = el('div', 'load-stage', box);
    stageWrap.appendChild(this.canvas);

    if (mode === 'spinner') {
      const bar = el('div', 'load-bar indeterminate', box);
      el('div', 'fill', bar);
      this.fillEl = null; this.pctEl = null; this.stageEl = null; this.stepEls = []; this.tipEl = null;
    } else {
      const steps = el('div', 'load-steps', box);
      this.stepEls = STAGES.map((s, i) => {
        const st = el('div', 'load-step', steps);
        st.title = s.label;
        st.style.setProperty('--i', String(i));
        let ic: HTMLCanvasElement | null = null;
        try { ic = hasDef(s.icon) ? this.atlas.icon(s.icon) : null; } catch { ic = null; }
        if (ic) {
          const c = document.createElement('canvas');
          c.width = 32; c.height = 32; c.className = 'pix';
          c.getContext('2d')!.drawImage(ic, 0, 0);
          st.appendChild(c);
        }
        el('span', 'load-check', st).textContent = '✓';
        return st;
      });
      const bar = el('div', 'load-bar', box);
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', '100');
      this.fillEl = el('div', 'fill', bar);
      el('div', 'shine', bar);
      const line = el('div', 'load-line', box);
      this.stageEl = el('span', 'load-stage-label', line);
      this.pctEl = el('span', 'load-pct', line);
      this.tipEl = el('div', 'load-tip', box);
      let ti = Math.floor(Math.random() * TIPS.length);
      const setTip = (): void => {
        const tip = this.tipEl;
        if (!tip) return;
        tip.classList.remove('in');
        void tip.offsetWidth;
        tip.textContent = `Tip: ${TIPS[ti % TIPS.length]}`;
        tip.classList.add('in');
        ti++;
      };
      setTip();
      if (this.tipTimer) clearInterval(this.tipTimer);
      this.tipTimer = setInterval(setTip, 4200);
      this.syncText();
    }

    this.t0 = performance.now();
    cancelAnimationFrame(this.raf);
    const frame = (now: number): void => {
      this.raf = requestAnimationFrame(frame);
      this.tickProgress();
      // ~30 fps is plenty for the diorama and leaves the main thread to meshing
      if (now - this.lastDraw < 30) return;
      this.lastDraw = now;
      this.draw(now);
    };
    this.raf = requestAnimationFrame(frame);
  }

  unmount(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.tipTimer) { clearInterval(this.tipTimer); this.tipTimer = null; }
    this.el.remove();
    this.sample = null;
  }

  /** Where to sample the preview: centre (world x/z), ground height, sampler. */
  setTerrain(cx: number, cz: number, h0: number, sample: LoadSampler): void {
    this.cx = cx; this.cz = cz; this.h0 = h0;
    this.sample = sample;
  }

  /** gen / mesh: fraction of spawn chunks generated / meshed (0..1). */
  setProgress(gen: number, mesh: number): void {
    if (this.done) return;
    this.target = Math.max(this.target, Math.min(0.97, gen * 0.55 + mesh * 0.42));
    const st = gen < 0.45 ? 0 : gen < 0.8 ? 1 : gen < 1 ? 2 : mesh < 1 ? 3 : 4;
    if (st !== this.stage) { this.stage = st; this.syncText(); }
    this.pollTerrain();
  }

  /** Everything's ready: fill the bar, tick every stage, drop any stragglers. */
  finish(): void {
    this.pollTerrain();
    this.done = true;
    this.doneAt = performance.now();
    this.target = 1;
    this.stage = STAGES.length;
    this.syncText();
  }

  private syncText(): void {
    this.stepEls.forEach((s, i) => {
      s.classList.toggle('done', i < this.stage);
      s.classList.toggle('active', i === this.stage);
    });
    if (this.stageEl) {
      this.stageEl.textContent = this.stage >= STAGES.length ? 'Ready!' : `${STAGES[this.stage].label}…`;
      this.stageEl.classList.toggle('ready', this.stage >= STAGES.length);
    }
  }

  private tickProgress(): void {
    if (!this.fillEl) return;
    // ease the visible bar toward the real progress (never jumps, never stalls)
    const k = this.done ? 0.25 : 0.08;
    this.shown += (this.target - this.shown) * k;
    if (this.target - this.shown < 0.002) this.shown = this.target;
    const pct = Math.round(this.shown * 100);
    this.fillEl.style.width = `${(this.shown * 100).toFixed(1)}%`;
    this.fillEl.parentElement?.setAttribute('aria-valuenow', String(pct));
    if (this.pctEl) this.pctEl.textContent = `${pct}%`;
  }

  // --- terrain columns ---------------------------------------------------------

  private pollTerrain(): void {
    if (!this.sample || this.pending === 0) return;
    const now = performance.now();
    for (let iz = 0; iz < N; iz++) {
      for (let ix = 0; ix < N; ix++) {
        const col = this.cols[iz * N + ix];
        if (col.data) continue;
        const wx = Math.floor(this.cx + (ix - N / 2 + 0.5) * STEP);
        const wz = Math.floor(this.cz + (iz - N / 2 + 0.5) * STEP);
        let d: LoadColumn | null = null;
        try { d = this.sample(wx, wz); } catch { d = null; }
        if (!d) continue;
        this.build(col, d);
        // stagger outward from the centre so the island assembles in a ripple
        const dist = Math.hypot(ix - N / 2 + 0.5, iz - N / 2 + 0.5);
        col.born = now + dist * 28 + Math.random() * 160;
        this.pending--;
      }
    }
  }

  private rel(y: number): number {
    return Math.max(BASE + 1, Math.min(7, Math.round((y - this.h0) / V_SCALE)));
  }

  /** Resolve a tile (optionally biome-tinted) once and cache it. */
  private tile(name: string, tint?: [number, number, number]): HTMLCanvasElement {
    const tinted = !!tint && TINTED_TILES.has(name);
    const key = tinted ? `${name}|${tint!.map((v) => Math.round(v * 12)).join(',')}` : name;
    let c = this.tileCache.get(key);
    if (c) return c;
    let src: HTMLCanvasElement | null = null;
    try { src = this.atlas.tileCanvas(name); } catch { src = null; }
    c = document.createElement('canvas');
    c.width = 16; c.height = 16;
    const ctx = c.getContext('2d')!;
    if (src) ctx.drawImage(src, 0, 0, 16, 16);
    else { ctx.fillStyle = '#777'; ctx.fillRect(0, 0, 16, 16); }
    if (tinted) {
      const [r, g, b] = tint!;
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
      ctx.fillRect(0, 0, 16, 16);
      ctx.globalCompositeOperation = 'destination-in';
      if (src) ctx.drawImage(src, 0, 0, 16, 16);
      ctx.globalCompositeOperation = 'source-over';
    }
    if (name.endsWith('leaves')) {
      // cut-out leaves need a dark canopy underlay to read as a solid bush
      const [r, g, b] = tint ?? [0.45, 0.65, 0.3];
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = `rgb(${Math.round(r * 90)},${Math.round(g * 110)},${Math.round(b * 70)})`;
      ctx.fillRect(0, 0, 16, 16);
      ctx.globalCompositeOperation = 'source-over';
    }
    this.tileCache.set(key, c);
    return c;
  }

  private faces(id: number): { top: string; sides: string } {
    const f = hasDef(id) ? def(id).faces : undefined;
    return f ? { top: f.top, sides: f.sides } : { top: 'stone', sides: 'stone' };
  }

  private build(col: Col, d: LoadColumn): void {
    col.data = d;
    const water = d.water >= 0;
    const topRel = water ? Math.min(this.rel(d.y), this.rel(d.water) - 1) : this.rel(d.y);
    const f = this.faces(d.id);
    const top = this.tile(f.top, d.tint);
    const side = this.tile(f.sides, d.tint);
    const soil = d.id === B.GRASS || d.id === B.SNOW_GRASS || d.id === B.DIRT || d.id === B.FARMLAND;
    const under = this.tile(soil ? 'dirt' : d.id === B.SAND ? 'sand' : f.sides, d.tint);
    const stone = this.tile('stone');
    const layers: Col['layers'] = [];
    for (let y = BASE; y <= topRel; y++) {
      const depth = topRel - y;
      if (depth === 0) layers.push({ top, side, alpha: 1 });
      else if (depth <= 2) layers.push({ top: under, side: under, alpha: 1 });
      else layers.push({ top: stone, side: stone, alpha: 1 });
    }
    if (water) {
      const wt = this.tile(this.faces(B.WATER).top);
      for (let y = topRel + 1; y <= this.rel(d.water); y++) layers.push({ top: wt, side: wt, alpha: 0.72 });
    }
    col.layers = layers;
    col.base = BASE;
    if (d.leaf && !water) {
      const lf = this.faces(d.leaf), lg = this.faces(d.log || B.LOG);
      col.tree = { log: this.tile(lg.sides), logTop: this.tile(lg.top), leaf: this.tile(lf.top, d.tint) };
    }
  }

  /** Column height (top rel y, inclusive) for face culling; -99 while unloaded. */
  private heightAt(ix: number, iz: number, now: number): number {
    if (ix < 0 || iz < 0 || ix >= N || iz >= N) return -99;
    const c = this.cols[iz * N + ix];
    if (!c.data || now < c.born + 450) return -99; // still falling: don't hide faces behind it
    return c.base + c.layers.length - 1;
  }

  // --- drawing -----------------------------------------------------------------

  private draw(now: number): void {
    const cv = this.canvas;
    const cssW = Math.max(1, cv.clientWidth), cssH = Math.max(1, cv.clientHeight);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(cssW * dpr), H = Math.round(cssH * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = false;
    const t = (now - this.t0) / 1000;
    const spin = this.reduced ? 0 : t;
    if (this.mode === 'spinner') { this.drawSpinner(ctx, W, H, spin); return; }

    const theta = Math.PI / 4 + spin * 0.22;
    const cos = Math.cos(theta), sin = Math.sin(theta);
    // fit the rotated square's diagonal to the canvas
    const a = Math.min(W / (N * 1.5), H / (N * 0.95));
    const hy = a * 0.8;                      // screen height of one layer
    const ox = W / 2, oy = H * 0.47;
    const P = (x: number, y: number, z: number): [number, number] => {
      const u = x - N / 2, w = z - N / 2;
      return [ox + (u * cos - w * sin) * a, oy + (u * sin + w * cos) * a * 0.5 - y * hy];
    };
    const ex: [number, number] = [cos * a, sin * a * 0.5];   // +x step on screen
    const ez: [number, number] = [-sin * a, cos * a * 0.5];  // +z step on screen

    // soft shadow under the island
    const [sx, sy] = P(N / 2, BASE, N / 2);
    const g = ctx.createRadialGradient(sx, sy + hy * 0.6, a, sx, sy + hy * 0.6, a * N * 0.8);
    g.addColorStop(0, 'rgba(0,0,0,0.45)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(sx, sy + hy * 0.9, a * N * 0.78, a * N * 0.34, 0, 0, Math.PI * 2);
    ctx.fill();

    // back-to-front: larger (x sin + z cos) is nearer the viewer
    const order: number[] = [];
    for (let i = 0; i < N * N; i++) order.push(i);
    const depth = (i: number): number => (i % N) * sin + Math.floor(i / N) * cos;
    order.sort((p, q) => depth(p) - depth(q));

    const quad = (img: HTMLCanvasElement, o: [number, number], u: [number, number], v: [number, number], shade: number, alpha: number): void => {
      ctx.setTransform(u[0] / 16, u[1] / 16, v[0] / 16, v[1] / 16, o[0], o[1]);
      ctx.globalAlpha = alpha;
      // a hair of overdraw hides the seams between neighbouring faces
      ctx.drawImage(img, -0.25, -0.25, 16.5, 16.5);
      if (shade > 0) {
        ctx.fillStyle = `rgba(0,0,0,${shade})`;
        ctx.fillRect(-0.25, -0.25, 16.5, 16.5);
      }
    };
    const down: [number, number] = [0, hy];
    // light from the upper left: shade each side by how it faces it
    const shadeX = sin > 0 ? 0.18 : 0.42, shadeZ = cos > 0 ? 0.3 : 0.5;
    const pulse = 0.05 + 0.04 * Math.sin(t * 3);

    for (const i of order) {
      const ix = i % N, iz = Math.floor(i / N);
      const col = this.cols[i];
      if (!col.data || now < col.born) {
        // not generated yet: a faint pulsing plot marker at the base
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        const p0 = P(ix, BASE + 0.02, iz), p1 = P(ix + 1, BASE + 0.02, iz), p2 = P(ix + 1, BASE + 0.02, iz + 1), p3 = P(ix, BASE + 0.02, iz + 1);
        ctx.fillStyle = `rgba(255,255,255,${pulse * (0.6 + 0.4 * ((ix + iz) & 1))})`;
        ctx.beginPath();
        ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.lineTo(p3[0], p3[1]);
        ctx.closePath(); ctx.fill();
        continue;
      }
      const age = (now - col.born) / 1000;
      const k = Math.min(1, age / 0.45);
      const drop = this.reduced ? 0 : (1 - easeOutBack(k)) * 9;
      const alpha = Math.min(1, age / 0.18);
      if (k >= 1 && !col.landed) { col.landed = true; this.puff(P(ix + 0.5, col.base + col.layers.length, iz + 0.5), a); }
      const nX = this.heightAt(ix + (sin > 0 ? 1 : -1), iz, now);
      const nZ = this.heightAt(ix, iz + (cos > 0 ? 1 : -1), now);
      const topY = col.base + col.layers.length - 1;
      for (let li = 0; li < col.layers.length; li++) {
        const y = col.base + li;
        const L = col.layers[li];
        const yy = y + drop;
        // side faces toward the viewer, skipped where a neighbour covers them
        if (y > nX || k < 1) {
          const fx = sin > 0 ? ix + 1 : ix;
          quad(L.side, P(fx, yy + 1, iz + (sin > 0 ? 0 : 1)), sin > 0 ? ez : [-ez[0], -ez[1]], down, shadeX, alpha * L.alpha);
        }
        if (y > nZ || k < 1) {
          const fz = cos > 0 ? iz + 1 : iz;
          quad(L.side, P(ix + (cos > 0 ? 0 : 1), yy + 1, fz), cos > 0 ? ex : [-ex[0], -ex[1]], down, shadeZ, alpha * L.alpha);
        }
        if (y === topY || L.alpha < 1 || col.layers[li + 1]?.alpha < 1) {
          quad(L.top, P(ix, yy + 1, iz), ex, ez, 0, alpha * L.alpha);
        }
      }
      if (col.tree) {
        const tr = col.tree;
        const cube = (img: HTMLCanvasElement, topImg: HTMLCanvasElement, y: number, s: number): void => {
          // a (possibly shrunken) cube centred in the column
          const o = (1 - s) / 2;
          const u: [number, number] = [ex[0] * s, ex[1] * s], v: [number, number] = [ez[0] * s, ez[1] * s];
          const dn: [number, number] = [0, hy * s];
          quad(img, P(ix + o + (sin > 0 ? s : 0), y + s, iz + o + (sin > 0 ? 0 : s)), sin > 0 ? v : [-v[0], -v[1]], dn, shadeX, alpha);
          quad(img, P(ix + o + (cos > 0 ? 0 : s), y + s, iz + o + (cos > 0 ? s : 0)), cos > 0 ? u : [-u[0], -u[1]], dn, shadeZ, alpha);
          quad(topImg, P(ix + o, y + s, iz + o), u, v, 0, alpha);
        };
        cube(tr.log, tr.logTop, topY + 1 + drop, 0.4);
        cube(tr.leaf, tr.leaf, topY + 1.4 + drop, 1);
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;

    // spawn beacon: a soft beam rising from the centre once the world is ready
    if (this.done) {
      const f = Math.min(1, (now - this.doneAt) / 500);
      const c = this.cols[(N / 2) * N + N / 2];
      const ty = c.data ? c.base + c.layers.length + (c.tree ? 1.4 : 0) : 0;
      const [bx, by] = P(N / 2 + 0.5, ty, N / 2 + 0.5);
      const beam = ctx.createLinearGradient(0, by, 0, by - H * 0.5);
      beam.addColorStop(0, `rgba(255,248,190,${0.55 * f})`);
      beam.addColorStop(1, 'rgba(255,248,190,0)');
      ctx.fillStyle = beam;
      ctx.fillRect(bx - a * 0.28, by - H * 0.5, a * 0.56, H * 0.5);
    }
    this.drawDust(ctx);
  }

  private puff(p: [number, number], a: number): void {
    if (this.reduced || this.dust.length > 120) return;
    for (let i = 0; i < 4; i++) {
      this.dust.push({
        x: p[0] + (Math.random() - 0.5) * a, y: p[1],
        vx: (Math.random() - 0.5) * a * 0.12, vy: -Math.random() * a * 0.06,
        life: 1, c: Math.random() < 0.5 ? '#d8cbb0' : '#a89a80',
      });
    }
  }

  private drawDust(ctx: CanvasRenderingContext2D): void {
    for (let i = this.dust.length - 1; i >= 0; i--) {
      const d = this.dust[i];
      d.x += d.vx; d.y += d.vy; d.vy += 0.05; d.life -= 0.06;
      if (d.life <= 0) { this.dust.splice(i, 1); continue; }
      ctx.globalAlpha = d.life * 0.8;
      ctx.fillStyle = d.c;
      const s = Math.max(2, Math.round(3 * d.life + 1));
      ctx.fillRect(Math.round(d.x), Math.round(d.y), s, s);
    }
    ctx.globalAlpha = 1;
  }

  /** A single grass block turning and bobbing (indeterminate progress). */
  private drawSpinner(ctx: CanvasRenderingContext2D, W: number, H: number, t: number): void {
    const theta = t * 1.4;
    const cos = Math.cos(theta), sin = Math.sin(theta);
    const a = Math.min(W, H) * 0.34;
    const hy = a * 0.8;
    const ox = W / 2, oy = H / 2 + hy * 0.3 + Math.sin(t * 3) * a * 0.06;
    const P = (x: number, y: number, z: number): [number, number] => {
      const u = x - 0.5, w = z - 0.5;
      return [ox + (u * cos - w * sin) * a, oy + (u * sin + w * cos) * a * 0.5 - y * hy];
    };
    const ex: [number, number] = [cos * a, sin * a * 0.5];
    const ez: [number, number] = [-sin * a, cos * a * 0.5];
    const top = this.tile('grass_top', [0.55, 0.74, 0.33]), side = this.tile('grass_side');
    const quad = (img: HTMLCanvasElement, o: [number, number], u: [number, number], v: [number, number], shade: number): void => {
      ctx.setTransform(u[0] / 16, u[1] / 16, v[0] / 16, v[1] / 16, o[0], o[1]);
      ctx.drawImage(img, -0.25, -0.25, 16.5, 16.5);
      if (shade > 0) { ctx.fillStyle = `rgba(0,0,0,${shade})`; ctx.fillRect(-0.25, -0.25, 16.5, 16.5); }
    };
    const down: [number, number] = [0, hy];
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(W / 2, H / 2 + hy * 1.05, a * 0.75, a * 0.2, 0, 0, Math.PI * 2);
    ctx.fill();
    quad(side, P(sin > 0 ? 1 : 0, 1, sin > 0 ? 0 : 1), sin > 0 ? ez : [-ez[0], -ez[1]], down, sin > 0 ? 0.18 : 0.42);
    quad(side, P(cos > 0 ? 0 : 1, 1, cos > 0 ? 1 : 0), cos > 0 ? ex : [-ex[0], -ex[1]], down, cos > 0 ? 0.3 : 0.5);
    quad(top, P(0, 1, 0), ex, ez, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}
