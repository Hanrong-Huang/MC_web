// Screen overlays for the Nether pass: the biome-tinted edge vignette, the
// portal swirl (a low-res animated purple vortex that thickens while you stand
// in a portal and washes over the screen as you travel), and the Portal
// Compass readout (a needle + distance to the portal you last used).

const SW = 128, SH = 72; // swirl canvas; CSS scales it smoothly to the screen

export class NetherOverlay {
  private vignette: HTMLDivElement;
  private swirl: HTMLCanvasElement;
  private swirlCtx: CanvasRenderingContext2D;
  private img: ImageData;
  private compassEl: HTMLDivElement;
  private needle: HTMLCanvasElement;
  private compassText: HTMLDivElement;
  private t = 0;
  private shown = 0;

  constructor(root: HTMLElement) {
    this.vignette = document.createElement('div');
    this.vignette.id = 'nether-air';
    Object.assign(this.vignette.style, {
      position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '50', opacity: '0',
      transition: 'opacity 1.2s ease, background 2.5s ease',
    } as CSSStyleDeclaration);
    root.appendChild(this.vignette);

    this.swirl = document.createElement('canvas');
    this.swirl.id = 'portal-swirl';
    this.swirl.width = SW; this.swirl.height = SH;
    Object.assign(this.swirl.style, {
      position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '56',
      opacity: '0', display: 'none',
    } as CSSStyleDeclaration);
    root.appendChild(this.swirl);
    this.swirlCtx = this.swirl.getContext('2d')!;
    this.img = this.swirlCtx.createImageData(SW, SH);

    this.compassEl = document.createElement('div');
    this.compassEl.id = 'portal-compass';
    Object.assign(this.compassEl.style, {
      position: 'absolute', left: '50%', top: '18px', transform: 'translateX(-50%)', display: 'none',
      alignItems: 'center', gap: '8px', padding: '4px 10px 4px 4px', background: 'rgba(26,8,38,0.66)',
      border: '1px solid #b25cff', color: '#ead2ff', font: 'bold 14px monospace', pointerEvents: 'none', zIndex: '12',
    } as CSSStyleDeclaration);
    this.needle = document.createElement('canvas');
    this.needle.width = 32; this.needle.height = 32;
    this.compassText = document.createElement('div');
    this.compassEl.append(this.needle, this.compassText);
    root.appendChild(this.compassEl);
  }

  /** Edge tint: `css` is an rgba() for the rim, or null to fade it away. */
  setVignette(css: string | null): void {
    if (!css) { this.vignette.style.opacity = '0'; return; }
    this.vignette.style.background = `radial-gradient(circle, rgba(0,0,0,0) 46%, ${css} 100%)`;
    this.vignette.style.opacity = '1';
  }

  /**
   * Portal swirl: `amount` 0..1 (0 hides it). The vortex turns faster and
   * closes in from the rim toward the centre as it rises.
   */
  setSwirl(dt: number, amount: number): void {
    this.t += dt;
    const a = Math.max(0, Math.min(1, amount));
    if (a <= 0.001) {
      if (this.shown) { this.swirl.style.display = 'none'; this.swirl.style.opacity = '0'; this.shown = 0; }
      return;
    }
    if (!this.shown) this.swirl.style.display = 'block';
    this.shown = a;
    this.swirl.style.opacity = String(Math.min(0.85, a * 1.1)); // the world stays faintly visible through it
    const d = this.img.data;
    const t = this.t;
    const reach = 1.25 - a * 1.1; // radius where the swirl starts (closes in as a rises)
    for (let y = 0; y < SH; y++) {
      for (let x = 0; x < SW; x++) {
        const nx = (x - SW / 2) / (SH / 2), ny = (y - SH / 2) / (SH / 2);
        const r = Math.sqrt(nx * nx + ny * ny);
        const ang = Math.atan2(ny, nx);
        const tw = ang + r * 2.6 - t * (1.2 + a * 2.2);
        const v = 0.5 + 0.5 * Math.sin(tw * 3 + Math.sin(r * 5 - t * 2) * 1.2);
        const v2 = 0.5 + 0.5 * Math.sin(tw * 5 - r * 7 + t * 1.3);
        const edge = Math.max(0, Math.min(1, (r - reach) * 2.2 + a * 0.45));
        const k = v * 0.7 + v2 * 0.3;
        const o = (y * SW + x) * 4;
        d[o] = 60 + 150 * k;
        d[o + 1] = 10 + 60 * k * k;
        d[o + 2] = 120 + 135 * k;
        d[o + 3] = 255 * Math.min(1, edge * (0.55 + 0.45 * k));
      }
    }
    this.swirlCtx.putImageData(this.img, 0, 0);
  }

  /** Portal Compass readout; `target` null = no portal remembered here (needle spins). */
  setCompass(show: boolean, px: number, pz: number, yaw: number, target: { x: number; z: number } | null): void {
    this.compassEl.style.display = show ? 'flex' : 'none';
    if (!show) return;
    const ctx = this.needle.getContext('2d')!;
    ctx.clearRect(0, 0, 32, 32);
    ctx.fillStyle = '#2a1238';
    ctx.beginPath(); ctx.arc(16, 16, 14, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#8a4ac0'; ctx.lineWidth = 2; ctx.stroke();
    let angle: number;
    if (!target) {
      angle = performance.now() / 160;
      this.compassText.textContent = 'No portal remembered here';
    } else {
      const dx = target.x - px, dz = target.z - pz;
      const bearing = Math.atan2(dx, -dz);
      const heading = Math.atan2(-Math.sin(yaw), Math.cos(yaw));
      angle = bearing - heading;
      this.compassText.textContent = `${Math.round(Math.hypot(dx, dz))} m to portal`;
    }
    ctx.save();
    ctx.translate(16, 16);
    ctx.rotate(angle);
    ctx.fillStyle = '#d58cff';
    ctx.beginPath(); ctx.moveTo(0, -11); ctx.lineTo(4, 1); ctx.lineTo(-4, 1); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#5a2488';
    ctx.beginPath(); ctx.moveTo(0, 11); ctx.lineTo(4, 1); ctx.lineTo(-4, 1); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  dispose(): void { this.vignette.remove(); this.swirl.remove(); this.compassEl.remove(); }
}
