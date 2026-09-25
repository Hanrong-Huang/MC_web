// Held-item overlays for exploration gear: the Explorer Map (a parchment map
// of the terrain around you, drawn from the loaded chunks, with markers for
// your bed and your last death) and the Recovery Compass (a needle + distance
// pointing back to where you last died).

import type { Atlas } from '../engine/Textures';
import { B, def, hasDef } from '../engine/Blocks';

export interface MapMarkers {
  x: number; z: number; yaw: number;
  death: { x: number; z: number } | null;
  home: { x: number; z: number } | null;
}

const SPAN = 128; // blocks across the map (1 px per block)

export class MapOverlay {
  private mapEl: HTMLDivElement;
  private mapCanvas: HTMLCanvasElement;
  private compassEl: HTMLDivElement;
  private needle: HTMLCanvasElement;
  private compassText: HTMLDivElement;
  private redrawT = 0;
  private colors = new Map<number, [number, number, number]>();

  constructor(root: HTMLElement, private atlas: Atlas) {
    this.mapEl = document.createElement('div');
    this.mapEl.id = 'explorer-map';
    Object.assign(this.mapEl.style, {
      // sits under the compass minimap in the top-right corner
      position: 'absolute', right: '12px', top: '160px', width: '236px', height: '236px', padding: '10px',
      background: '#d9c89c', border: '3px solid #6f5a3a', boxShadow: 'inset 0 0 0 2px #efe2bd, 0 4px 14px rgba(0,0,0,0.45)',
      display: 'none', pointerEvents: 'none', zIndex: '12', boxSizing: 'border-box',
    } as CSSStyleDeclaration);
    this.mapCanvas = document.createElement('canvas');
    this.mapCanvas.width = SPAN; this.mapCanvas.height = SPAN;
    Object.assign(this.mapCanvas.style, { width: '100%', height: '100%', imageRendering: 'pixelated', display: 'block' } as CSSStyleDeclaration);
    this.mapEl.appendChild(this.mapCanvas);
    root.appendChild(this.mapEl);

    this.compassEl = document.createElement('div');
    this.compassEl.id = 'recovery-compass';
    Object.assign(this.compassEl.style, {
      position: 'absolute', left: '50%', top: '18px', transform: 'translateX(-50%)', display: 'none',
      alignItems: 'center', gap: '8px', padding: '4px 10px 4px 4px', background: 'rgba(8,24,28,0.62)',
      border: '1px solid #3de8e0', color: '#bff8f4', font: 'bold 14px monospace', pointerEvents: 'none', zIndex: '12',
    } as CSSStyleDeclaration);
    this.needle = document.createElement('canvas');
    this.needle.width = 32; this.needle.height = 32;
    this.compassText = document.createElement('div');
    this.compassEl.append(this.needle, this.compassText);
    root.appendChild(this.compassEl);
  }

  /** Average colour of a block's top tile (cached). */
  private colorOf(id: number): [number, number, number] {
    let c = this.colors.get(id);
    if (c) return c;
    c = [217, 200, 156];
    if (id === B.WATER) c = [64, 104, 200];
    else if (id === B.LAVA) c = [230, 110, 30];
    else if (id !== B.AIR && hasDef(id) && def(id).faces) {
      const t = this.atlas.tileCanvas(def(id).faces!.top);
      const d = t.getContext('2d')!.getImageData(0, 0, 16, 16).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 100) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
      if (n) c = [r / n, g / n, b / n];
      if (id === B.GRASS || def(id).name.endsWith('leaves')) c = [c[0] * 0.85, c[1] * 1.02, c[2] * 0.7];
    }
    this.colors.set(id, c);
    return c;
  }

  update(dt: number, showMap: boolean, showCompass: boolean, m: MapMarkers,
    sample: (wx: number, wz: number) => { id: number; h: number } | null): void {
    this.mapEl.style.display = showMap ? 'block' : 'none';
    this.compassEl.style.display = showCompass ? 'flex' : 'none';
    if (showMap) {
      this.redrawT -= dt;
      if (this.redrawT <= 0) { this.redrawT = 0.5; this.drawMap(m, sample); }
    }
    if (showCompass) this.drawCompass(m);
  }

  private drawMap(m: MapMarkers, sample: (wx: number, wz: number) => { id: number; h: number } | null): void {
    const ctx = this.mapCanvas.getContext('2d')!;
    const img = ctx.createImageData(SPAN, SPAN);
    const d = img.data;
    const x0 = Math.floor(m.x) - SPAN / 2, z0 = Math.floor(m.z) - SPAN / 2;
    let prevRow: number[] = [];
    for (let j = 0; j < SPAN; j++) {
      const row: number[] = [];
      for (let i = 0; i < SPAN; i++) {
        const s = sample(x0 + i, z0 + j);
        const o = (j * SPAN + i) * 4;
        row.push(s ? s.h : -1);
        if (!s) { // unexplored: blank parchment with a faint grain
          const g = ((i * 7 + j * 13) % 5 === 0) ? 206 : 217;
          d[o] = g; d[o + 1] = g - 17; d[o + 2] = g - 61; d[o + 3] = 255;
          continue;
        }
        const c = this.colorOf(s.id);
        // vanilla-style relief: brighter where the ground rises to the north-west
        const up = prevRow[i] ?? -1;
        const k = up < 0 ? 1 : s.h > up ? 1.12 : s.h < up ? 0.84 : 1;
        // blend toward parchment so it reads as a drawn map
        d[o] = Math.min(255, c[0] * k * 0.82 + 217 * 0.18);
        d[o + 1] = Math.min(255, c[1] * k * 0.82 + 200 * 0.18);
        d[o + 2] = Math.min(255, c[2] * k * 0.82 + 156 * 0.18);
        d[o + 3] = 255;
      }
      prevRow = row;
    }
    ctx.putImageData(img, 0, 0);
    const mark = (wx: number, wz: number, col: string, cross: boolean): void => {
      const px = Math.max(2, Math.min(SPAN - 3, wx - x0)), pz = Math.max(2, Math.min(SPAN - 3, wz - z0));
      ctx.fillStyle = '#2a1c0c';
      ctx.fillRect(px - 2, pz - 2, 5, 5);
      ctx.fillStyle = col;
      if (cross) { for (let q = -2; q <= 2; q++) { ctx.fillRect(px + q, pz + q, 1, 1); ctx.fillRect(px + q, pz - q, 1, 1); } }
      else ctx.fillRect(px - 1, pz - 1, 3, 3);
    };
    if (m.home) mark(m.home.x, m.home.z, '#f2f2f2', false);
    if (m.death) mark(m.death.x, m.death.z, '#e8322a', true);
    // player arrow pointing along the view
    const cx = SPAN / 2, cz = SPAN / 2;
    const fx = -Math.sin(m.yaw), fz = -Math.cos(m.yaw);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#2a1c0c';
    ctx.beginPath();
    ctx.moveTo(cx + fx * 5, cz + fz * 5);
    ctx.lineTo(cx - fx * 3 + fz * 3, cz - fz * 3 - fx * 3);
    ctx.lineTo(cx - fx * 1.5, cz - fz * 1.5);
    ctx.lineTo(cx - fx * 3 - fz * 3, cz - fz * 3 + fx * 3);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  private drawCompass(m: MapMarkers): void {
    const ctx = this.needle.getContext('2d')!;
    ctx.clearRect(0, 0, 32, 32);
    ctx.fillStyle = '#1f3a44';
    ctx.beginPath(); ctx.arc(16, 16, 14, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#58a8b8'; ctx.lineWidth = 2; ctx.stroke();
    if (!m.death) {
      // no death recorded: the needle spins aimlessly
      const a = performance.now() / 180;
      this.drawNeedle(ctx, a);
      this.compassText.textContent = 'No death point';
      return;
    }
    const dx = m.death.x - m.x, dz = m.death.z - m.z;
    // bearings clockwise from north (-z); the needle turns relative to the view
    const bearing = Math.atan2(dx, -dz);
    const heading = Math.atan2(-Math.sin(m.yaw), Math.cos(m.yaw));
    this.drawNeedle(ctx, bearing - heading);
    this.compassText.textContent = `${Math.round(Math.hypot(dx, dz))} m to last death`;
  }

  private drawNeedle(ctx: CanvasRenderingContext2D, angle: number): void {
    ctx.save();
    ctx.translate(16, 16);
    ctx.rotate(angle);
    ctx.fillStyle = '#3de8e0';
    ctx.beginPath(); ctx.moveTo(0, -11); ctx.lineTo(4, 1); ctx.lineTo(-4, 1); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#1a6e78';
    ctx.beginPath(); ctx.moveTo(0, 11); ctx.lineTo(4, 1); ctx.lineTo(-4, 1); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  dispose(): void { this.mapEl.remove(); this.compassEl.remove(); }
}
