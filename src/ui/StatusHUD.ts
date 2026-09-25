// Gameplay status overlays that sit on top of the main HUD: golden Absorption
// hearts, active status-effect badges with countdowns, the attack-recharge
// meter under the crosshair, and the spyglass scope vignette. Everything is
// procedural canvas pixel art; the elements are self-positioned so the main
// HUD layout doesn't need to know about them.

import { drawHeart } from '../engine/Textures';
import type { EffectId } from '../engine/Player';

export interface StatusView {
  visible: boolean;
  survival: boolean;
  absorb: number;
  armor: number;
  effects: { id: EffectId; amp: number; t: number; total: number }[];
  /** 0..1 swing recharge; the meter only shows while recharging */
  attackCharge: number;
  scoping: boolean;
  /** player is burning: flames lick up the bottom of the view */
  onFire: boolean;
}

const ROMAN = ['', ' II', ' III', ' IV', ' V'];
const EFFECT_NAMES: Record<EffectId, string> = {
  regeneration: 'Regeneration', absorption: 'Absorption', resistance: 'Resistance',
  fire_resistance: 'Fire Resistance', hunger: 'Hunger',
};
/** badge accent per effect (vanilla potion colours) */
const EFFECT_COLORS: Record<EffectId, string> = {
  regeneration: '#cd5cab', absorption: '#2552a5', resistance: '#99453a',
  fire_resistance: '#e49a3a', hunger: '#587653',
};

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')!];
}

/** Draw a tiny pixel map ('.' = transparent). */
function pix(ctx: CanvasRenderingContext2D, rows: string[], pal: Record<string, string>): void {
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      const col = pal[rows[y][x]];
      if (!col) continue;
      ctx.fillStyle = col;
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

const HEART_ICON = [
  '.OO.OO.',
  'OLROORO',
  'OLRRRRO',
  'ORRRRRO',
  '.ORRRO.',
  '..ORO..',
  '...O...',
];
const SHIELD_ICON = [
  'OOOOOOO',
  'OLMMMMO',
  'OLMMMMO',
  'OMMMMmO',
  '.OMMmO.',
  '.OMmmO.',
  '..OOO..',
];
const FLAME_ICON = [
  '...O...',
  '..OYO..',
  '.OYO.O.',
  '.OYROYO',
  'OYRRRYO',
  'OYRRRYO',
  '.OOOOO.',
];
const SHANK_ICON = [
  '....OO.',
  '...OBBO',
  '..OMMBO',
  '.OMMMO.',
  'OWOMO..',
  'OWWO...',
  '.OO....',
];

/** 7x7 pixel icon for an effect badge. */
function effectIcon(id: EffectId): HTMLCanvasElement {
  const [c, ctx] = canvas(7, 7);
  switch (id) {
    case 'regeneration': pix(ctx, HEART_ICON, { O: '#2a0c1c', R: '#e050a8', L: '#ffc2ec' }); break;
    case 'absorption': pix(ctx, HEART_ICON, { O: '#2a1a04', R: '#f2c22c', L: '#fff4a8' }); break;
    case 'resistance': pix(ctx, SHIELD_ICON, { O: '#1e1010', M: '#b0584a', m: '#7a3a30', L: '#e89a8a' }); break;
    case 'fire_resistance': pix(ctx, FLAME_ICON, { O: '#3a1204', Y: '#ffd23d', R: '#ff7a1a' }); break;
    case 'hunger': pix(ctx, SHANK_ICON, { O: '#101a0c', M: '#6f8a4a', B: '#4c6534', W: '#dcdcc8' }); break;
  }
  return c;
}

/** A heart recoloured gold for Absorption (reuses the HUD heart shape). */
function goldHeart(half: boolean): HTMLCanvasElement {
  const src = drawHeart(half ? 'half' : 'full');
  const [c, ctx] = canvas(src.width, src.height);
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 8) continue;
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (r > 150 && r - g > 50) {
      // bright red body/highlight -> gold, keeping the highlight lighter
      const hi = g > 100;
      d[i] = hi ? 255 : 236; d[i + 1] = hi ? 240 : 186; d[i + 2] = hi ? 150 : 38;
    } else if (r < 90 && g < 60 && b < 60 && r > 45) {
      // empty (dark red) container half -> dark bronze
      d[i] = 70; d[i + 1] = 52; d[i + 2] = 20;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Redraw a strip of pixel flames (white-hot base, red tips) into `c`. */
function paintFlames(c: HTMLCanvasElement, phase: number): void {
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, c.width, c.height);
  const ramp = ['#fff3b8', '#ffd84a', '#ffab24', '#ff7b1c', '#e24a17', '#a92c10'];
  for (let x = 0; x < c.width; x++) {
    // taller tongues toward the screen edges, like vanilla's first-person fire
    const edge = Math.abs(x / (c.width - 1) - 0.5) * 2;
    const wave = Math.sin(x * 0.9 + phase * 7) * 0.5 + Math.sin(x * 0.37 - phase * 11) * 0.5;
    const h = Math.max(2, Math.round(c.height * (0.28 + edge * 0.55 + wave * 0.16)));
    for (let y = c.height - 1; y >= c.height - h; y--) {
      const t = (c.height - 1 - y) / h;
      if (t > 0.6 && Math.random() < (t - 0.6) * 1.4) continue;
      ctx.fillStyle = ramp[Math.min(ramp.length - 1, Math.floor(t * ramp.length))];
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

function fmtTime(t: number): string {
  const s = Math.max(0, Math.ceil(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export class StatusHUD {
  private absorbEl: HTMLDivElement;
  private effectsEl: HTMLDivElement;
  private attackEl: HTMLDivElement;
  private attackFill: HTMLDivElement;
  private scopeEl: HTMLDivElement;
  private fireEl: HTMLCanvasElement;
  private firePhase = 0;
  private fireRedrawAt = 0;
  private lastAbsorbKey = '';
  private absorbFrames = 0;
  private lastEffectsKey = '';
  private iconCache = new Map<string, HTMLCanvasElement>();

  constructor(root: HTMLElement) {
    // golden hearts row, parked above the health bar (and above armor if worn)
    this.absorbEl = document.createElement('div');
    this.absorbEl.id = 'absorb-bar';
    Object.assign(this.absorbEl.style, {
      position: 'absolute', left: '0', display: 'flex', gap: '1px', pointerEvents: 'none',
    });

    this.effectsEl = document.createElement('div');
    this.effectsEl.id = 'effect-list';
    Object.assign(this.effectsEl.style, {
      position: 'absolute', left: '10px', top: '10px', zIndex: '12',
      display: 'flex', flexDirection: 'column', gap: '4px', pointerEvents: 'none',
    });
    root.appendChild(this.effectsEl);

    // attack recharge meter: a thin bar under the crosshair, vanilla-style
    this.attackEl = document.createElement('div');
    this.attackEl.id = 'attack-meter';
    Object.assign(this.attackEl.style, {
      position: 'absolute', left: '50%', top: 'calc(50% + 14px)', width: '18px', height: '4px',
      transform: 'translateX(-50%)', background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(0,0,0,0.7)',
      pointerEvents: 'none', zIndex: '6', display: 'none',
    });
    this.attackFill = document.createElement('div');
    Object.assign(this.attackFill.style, { height: '100%', width: '0%', background: '#e8e8e8' });
    this.attackEl.appendChild(this.attackFill);
    root.appendChild(this.attackEl);

    // spyglass: black surround with a round lens and a faint rim
    this.scopeEl = document.createElement('div');
    this.scopeEl.id = 'spyglass-scope';
    Object.assign(this.scopeEl.style, {
      position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '5', display: 'none',
      background: 'radial-gradient(circle at 50% 50%, rgba(0,0,0,0) 0, rgba(0,0,0,0) 34vmin,'
        + ' rgba(40,30,20,0.9) 34.4vmin, #050403 36vmin, #000 100%)',
    });
    root.appendChild(this.scopeEl);

    // burning: a band of animated pixel flames along the bottom of the view
    this.fireEl = document.createElement('canvas');
    this.fireEl.id = 'burn-overlay';
    this.fireEl.width = 64; this.fireEl.height = 22;
    Object.assign(this.fireEl.style, {
      position: 'absolute', left: '0', bottom: '0', width: '100%', height: '46vh',
      imageRendering: 'pixelated', pointerEvents: 'none', zIndex: '4', opacity: '0.82', display: 'none',
    });
    root.appendChild(this.fireEl);
  }

  private icon(id: EffectId): HTMLCanvasElement {
    let c = this.iconCache.get(id);
    if (!c) { c = effectIcon(id); this.iconCache.set(id, c); }
    return c;
  }

  update(v: StatusView): void {
    const show = v.visible;
    // --- absorption hearts ---------------------------------------------------
    const stats = document.getElementById('stats');
    if (stats && this.absorbEl.parentElement !== stats) stats.appendChild(this.absorbEl);
    const absorb = show && v.survival ? Math.ceil(v.absorb) : 0;
    const aKey = `${absorb}|${v.armor > 0}`;
    // re-anchor now and then too: the HUD bars can shift after they first draw
    if (absorb > 0 && ++this.absorbFrames % 30 === 0) this.lastAbsorbKey = '';
    if (aKey !== this.lastAbsorbKey) {
      this.lastAbsorbKey = aKey;
      this.absorbEl.innerHTML = '';
      // sit one row above the topmost bar on the left (armor if worn, else hearts)
      const hearts = document.getElementById('hearts');
      const armorBar = document.getElementById('armor-bar');
      const anchor = v.armor > 0 && armorBar && armorBar.offsetHeight > 0 ? armorBar : hearts;
      if (stats && anchor) {
        // measure the icons themselves: the bar containers may carry padding
        const icon = (anchor.firstElementChild ?? anchor) as HTMLElement;
        // offsets are relative to whichever ancestor actually positions us
        const base = (this.absorbEl.offsetParent as HTMLElement | null) ?? stats;
        const sr = base.getBoundingClientRect(), ar = icon.getBoundingClientRect();
        const rowH = (hearts?.firstElementChild as HTMLElement | null)?.getBoundingClientRect().height || 16;
        this.absorbEl.style.top = `${Math.round(ar.top - sr.top - rowH - 3)}px`;
        this.absorbEl.style.left = `${Math.round(ar.left - sr.left)}px`;
      } else {
        this.absorbEl.style.top = v.armor > 0 ? '-38px' : '-19px';
      }
      for (let i = 0; i < Math.ceil(absorb / 2); i++) {
        const h = goldHeart(absorb - i * 2 === 1);
        h.className = 'stat-icon';
        this.absorbEl.appendChild(h);
      }
    }

    // --- effect badges ---------------------------------------------------------
    const effects = show && v.survival ? v.effects : [];
    const eKey = effects.map((e) => `${e.id}${e.amp}:${Math.ceil(e.t)}`).join(',');
    if (eKey !== this.lastEffectsKey) {
      this.lastEffectsKey = eKey;
      this.effectsEl.innerHTML = '';
      for (const e of effects) {
        const row = document.createElement('div');
        Object.assign(row.style, {
          display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 8px 3px 4px',
          background: 'rgba(16,14,20,0.62)', border: `1px solid ${EFFECT_COLORS[e.id]}`,
          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.06)',
          // the last few seconds blink, like vanilla's expiring icon
          opacity: e.t < 5 && Math.ceil(e.t * 2) % 2 === 0 ? '0.55' : '1',
        });
        const [ic, ictx] = canvas(7, 7);
        ictx.drawImage(this.icon(e.id), 0, 0);
        Object.assign(ic.style, { width: '21px', height: '21px', imageRendering: 'pixelated' });
        row.appendChild(ic);
        const txt = document.createElement('div');
        Object.assign(txt.style, {
          display: 'flex', flexDirection: 'column', lineHeight: '1.15',
          fontSize: '10px', color: '#fff', textShadow: '1px 1px 0 rgba(0,0,0,0.85)',
        });
        const name = document.createElement('span');
        name.textContent = EFFECT_NAMES[e.id] + (ROMAN[e.amp] ?? ` ${e.amp + 1}`);
        const time = document.createElement('span');
        time.textContent = fmtTime(e.t);
        time.style.color = '#bdb8c8';
        txt.append(name, time);
        row.appendChild(txt);
        this.effectsEl.appendChild(row);
      }
    }

    // --- attack meter ----------------------------------------------------------
    const charging = show && v.survival && v.attackCharge < 1 && !v.scoping;
    this.attackEl.style.display = charging ? 'block' : 'none';
    if (charging) this.attackFill.style.width = `${Math.round(v.attackCharge * 100)}%`;

    // --- spyglass vignette -----------------------------------------------------
    this.scopeEl.style.display = show && v.scoping ? 'block' : 'none';

    // --- on-fire flames (redrawn ~12x a second for the flicker) ------------------
    const burning = show && v.onFire;
    this.fireEl.style.display = burning ? 'block' : 'none';
    if (burning) {
      const now = performance.now();
      if (now >= this.fireRedrawAt) {
        this.fireRedrawAt = now + 80;
        this.firePhase += 0.08;
        paintFlames(this.fireEl, this.firePhase);
      }
    }
  }

  dispose(): void {
    this.absorbEl.remove();
    this.effectsEl.remove();
    this.attackEl.remove();
    this.scopeEl.remove();
    this.fireEl.remove();
  }
}
