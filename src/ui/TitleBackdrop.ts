// Title-screen backdrop: a slowly panning, parallax side-view landscape built
// from the procedural block atlas (distant hazy mountains, a near strip of grass
// hills with trees, ores and a lake, drifting blocky clouds). It stands in for
// vanilla's rotating panorama without needing a second WebGL context.

import type { Atlas } from '../engine/Textures';

const T = 16; // art pixels per tile

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class TitleBackdrop {
  readonly canvas: HTMLCanvasElement;
  private atlas: Atlas;
  private near: HTMLCanvasElement | null = null;
  private far: HTMLCanvasElement | null = null;
  private clouds: HTMLCanvasElement | null = null;
  private raf = 0;
  private start = 0;
  private reduced = false;

  constructor(atlas: Atlas) {
    this.atlas = atlas;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'menu-backdrop';
    this.canvas.setAttribute('aria-hidden', 'true');
    try { this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* old browser */ }
  }

  private tile(name: string, fallback: string): HTMLCanvasElement {
    try {
      return this.atlas.tileCanvas(name);
    } catch {
      const c = document.createElement('canvas');
      c.width = T; c.height = T;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = fallback; ctx.fillRect(0, 0, T, T);
      return c;
    }
  }

  /** Periodic height field so each strip wraps seamlessly as it scrolls. */
  private heights(w: number, base: number, amps: [number, number, number][]): number[] {
    const out: number[] = [];
    for (let x = 0; x < w; x++) {
      let h = base;
      for (const [a, f, p] of amps) h += a * Math.sin((x / w) * Math.PI * 2 * f + p);
      out.push(Math.round(h));
    }
    return out;
  }

  private buildNear(): HTMLCanvasElement {
    const W = 128, H = 26, SEA = 17;
    const c = document.createElement('canvas');
    c.width = W * T; c.height = H * T;
    const ctx = c.getContext('2d')!;
    const tl = {
      grass: this.tile('grass_side', '#5d9b3d'), dirt: this.tile('dirt', '#866043'),
      stone: this.tile('stone', '#7a7a7a'), sand: this.tile('sand', '#dbd3a0'),
      coal: this.tile('coal_ore', '#555'), iron: this.tile('iron_ore', '#a88'),
      log: this.tile('log_side', '#6b4f2e'), leaves: this.tile('leaves', '#3f7a2a'),
      water: this.tile('water', '#2f52a5'), gravel: this.tile('gravel', '#888'),
      birch: this.tile('birch_log_side', '#ddd'), birchLeaves: this.tile('birch_leaves', '#5a8a3a'),
    };
    const hs = this.heights(W, 13, [[2.6, 2, 0.4], [1.6, 5, 1.9], [0.8, 11, 3.1]]);
    const r = rng(7);
    const put = (t: HTMLCanvasElement, x: number, y: number): void => { ctx.drawImage(t, x * T, y * T); };
    for (let x = 0; x < W; x++) {
      const top = hs[x];
      const beach = top >= SEA - 1;
      for (let y = top; y < H; y++) {
        const d = y - top;
        let t = tl.stone;
        if (d === 0) t = beach ? tl.sand : tl.grass;
        else if (d < 3) t = beach ? (d < 2 ? tl.sand : tl.gravel) : tl.dirt;
        else if (r() < 0.05) t = r() < 0.7 ? tl.coal : tl.iron;
        put(t, x, y);
      }
      // lake water sits on low ground
      for (let y = SEA; y < top; y++) {
        ctx.globalAlpha = 0.85;
        put(tl.water, x, y);
        ctx.globalAlpha = 1;
      }
    }
    // cave-ish darkening with depth so the strip reads as a cross-section
    const g = ctx.createLinearGradient(0, 10 * T, 0, H * T);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = g;
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.globalCompositeOperation = 'source-over';
    // trees on dry ground (kept a few tiles from the wrap seam)
    for (let x = 3; x < W - 3; x += 7 + Math.floor(r() * 7)) {
      const top = hs[x];
      if (top >= SEA - 1 || Math.abs(hs[x - 1] - top) > 1 || Math.abs(hs[x + 1] - top) > 1) continue;
      const birch = r() < 0.3;
      const trunk = 4 + Math.floor(r() * 2);
      const lt = birch ? tl.birchLeaves : tl.leaves;
      // leaf canopy underlay keeps the cut-out leaf texture dense
      ctx.fillStyle = birch ? '#3d6a28' : '#2c5a1c';
      const cy = top - trunk - 1;
      ctx.fillRect((x - 2) * T, (cy + 1) * T, 5 * T, 2 * T);
      ctx.fillRect((x - 1) * T, cy * T, 3 * T, T);
      for (let lx = -2; lx <= 2; lx++) for (let ly = 1; ly <= 2; ly++) put(lt, x + lx, cy + ly);
      for (let lx = -1; lx <= 1; lx++) put(lt, x + lx, cy);
      ctx.fillRect(x * T, (cy - 1) * T, T, T);
      put(lt, x, cy - 1);
      for (let y = top - trunk; y < top; y++) if (y > cy + 2 || y >= top - 2) put(birch ? tl.birch : tl.log, x, y);
    }
    return c;
  }

  private buildFar(): HTMLCanvasElement {
    const W = 96, H = 26;
    const c = document.createElement('canvas');
    c.width = W * T; c.height = H * T;
    const ctx = c.getContext('2d')!;
    const stone = this.tile('stone', '#7a7a7a');
    const snow = this.tile('snow_top', '#f4fcfc');
    const grass = this.tile('grass_top', '#5d9b3d');
    const hs = this.heights(W, 12, [[4.5, 2, 1.1], [2.5, 4, 0.2], [1.2, 9, 2.4]]);
    for (let x = 0; x < W; x++) {
      for (let y = hs[x]; y < H; y++) {
        const t = hs[x] < 9 && y - hs[x] < 2 ? snow : hs[x] > 13 && y === hs[x] ? grass : stone;
        ctx.drawImage(t, x * T, y * T);
      }
    }
    // atmospheric haze: fade toward the sky colour
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = 'rgba(150,186,228,0.62)';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.globalCompositeOperation = 'source-over';
    return c;
  }

  private buildClouds(): HTMLCanvasElement {
    const W = 80, H = 8;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d')!;
    const r = rng(31);
    for (let i = 0; i < 9; i++) {
      const x = Math.floor(r() * W), y = Math.floor(r() * (H - 2));
      const w = 4 + Math.floor(r() * 8), h = 1 + Math.floor(r() * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      for (const ox of [0, -W]) ctx.fillRect(x + ox, y, w, h);
      for (const ox of [0, -W]) ctx.fillRect(x + ox + 1, y + h, Math.max(1, w - 2), 1);
    }
    return c;
  }

  mount(parent: HTMLElement): void {
    if (!this.near) { this.near = this.buildNear(); this.far = this.buildFar(); this.clouds = this.buildClouds(); }
    parent.prepend(this.canvas);
    this.start = performance.now();
    cancelAnimationFrame(this.raf);
    const frame = (now: number): void => {
      this.draw((now - this.start) / 1000);
      if (!this.reduced) this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  unmount(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.canvas.remove();
  }

  private draw(t: number): void {
    const cv = this.canvas;
    const W = Math.max(1, cv.clientWidth), H = Math.max(1, cv.clientHeight);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const ctx = cv.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    // sky
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#5b8fe6');
    sky.addColorStop(0.55, '#9cc3f5');
    sky.addColorStop(1, '#c8def7');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    // blocky sun with a soft glow
    const sun = Math.round(Math.min(W, H) * 0.09);
    const sx = Math.round(W * 0.78), sy = Math.round(H * 0.14);
    const glow = ctx.createRadialGradient(sx + sun / 2, sy + sun / 2, sun * 0.2, sx + sun / 2, sy + sun / 2, sun * 2.4);
    glow.addColorStop(0, 'rgba(255,250,210,0.75)');
    glow.addColorStop(1, 'rgba(255,250,210,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(sx - sun * 2, sy - sun * 2, sun * 5, sun * 5);
    ctx.fillStyle = '#fff8d8';
    ctx.fillRect(sx, sy, sun, sun);
    ctx.fillStyle = '#fffdf0';
    ctx.fillRect(sx + sun * 0.2, sy + sun * 0.2, sun * 0.6, sun * 0.6);
    // clouds
    const drawStrip = (img: HTMLCanvasElement, speed: number, y: number, h: number, alpha = 1): void => {
      const s = h / img.height;
      const w = img.width * s;
      const off = ((t * speed) % w + w) % w;
      ctx.globalAlpha = alpha;
      for (let x = -off; x < W; x += w) ctx.drawImage(img, Math.floor(x), Math.floor(y), Math.ceil(w) + 1, Math.ceil(h));
      ctx.globalAlpha = 1;
    };
    if (this.clouds) drawStrip(this.clouds, 7, H * 0.06, Math.max(48, H * 0.2), 0.85);
    if (this.far) {
      const fh = H * 0.78;
      drawStrip(this.far, 5, H - fh, fh);
    }
    if (this.near) {
      const nh = H * 0.9;
      drawStrip(this.near, 16, H - nh + H * 0.08, nh);
    }
    // readability: darken edges + bottom, keep the middle calm
    const v = ctx.createRadialGradient(W / 2, H * 0.45, Math.min(W, H) * 0.25, W / 2, H * 0.5, Math.max(W, H) * 0.75);
    v.addColorStop(0, 'rgba(0,0,0,0.18)');
    v.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);
  }
}
