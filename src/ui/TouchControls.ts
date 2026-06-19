// On-screen touch controls for phones/tablets. Twin joysticks: the RIGHT stick
// walks (WASD + sprint), the LEFT stick turns the camera (held = continuous
// look). Action buttons sit within easy thumb reach. Everything drives the same
// Input fields the keyboard/mouse path uses, so the rest of the game is
// unchanged. Shown only on touch devices while playing.

import { Input } from '../engine/Input';

export interface TouchHooks {
  onInventory: () => void;
  onFly: () => void;
  onPause: () => void;
}

/** Best-effort touch-device detection. */
export function isTouchDevice(): boolean {
  return (typeof window !== 'undefined') &&
    (('ontouchstart' in window) || (navigator.maxTouchPoints ?? 0) > 0);
}

const JOY_RADIUS = 50;     // px throw of a joystick knob
const LOOK_RATE = 13;      // look-stick deflection → "mouse" pixels per frame

function el(tag: string, cls: string, parent: HTMLElement, text = ''): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  parent.appendChild(e);
  return e;
}

export class TouchControls {
  readonly el: HTMLElement;
  private input: Input;
  private camX = 0;          // current look-stick deflection (-1..1)
  private camY = 0;
  private visible = false;
  private disposed = false;
  private resets: Array<() => void> = [];

  constructor(root: HTMLElement, input: Input, hooks: TouchHooks) {
    this.input = input;
    const c = el('div', 'hidden', root); c.id = 'touch-controls';
    this.el = c;

    // LEFT stick: camera/look (held = keep turning). RIGHT stick: movement.
    this.makeStick('touch-stick stick-cam', (nx, ny) => { this.camX = nx; this.camY = ny; });
    this.makeStick('touch-stick stick-move', (nx, ny) => this.setMove(nx, ny));

    // action buttons (on top of everything)
    this.hold('tb tb-mine', '⛏', () => { input.leftDown = true; }, () => { input.leftDown = false; });
    this.hold('tb tb-place', '✋', () => { input.rightDown = true; input.queueRightClick(); }, () => { input.rightDown = false; });
    this.hold('tb tb-jump', '⏶', () => { input.keys.add('Space'); }, () => { input.keys.delete('Space'); });
    this.hold('tb tb-down', '⏷', () => { input.keys.add('ControlLeft'); }, () => { input.keys.delete('ControlLeft'); });
    this.tap('tb tb-inv', '🎒', hooks.onInventory);
    this.tap('tb tb-fly', '✈', hooks.onFly);
    this.tap('tb tb-pause', '⏸', hooks.onPause);

    requestAnimationFrame(this.lookLoop);
  }

  /** Apply the held look-stick each frame so the camera keeps turning. */
  private lookLoop = (): void => {
    if (this.disposed) return;
    requestAnimationFrame(this.lookLoop);
    if (this.visible && (this.camX !== 0 || this.camY !== 0)) {
      this.input.mouseDX += this.camX * LOOK_RATE;
      this.input.mouseDY += this.camY * LOOK_RATE * 0.85; // gentler vertical
    }
  };

  /** A fixed joystick: drag the knob, get a normalized (-1..1) vector. */
  private makeStick(cls: string, onVec: (nx: number, ny: number) => void): void {
    const base = el('div', cls, this.el);
    const knob = el('div', 'touch-knob', base);
    let id = -1, cx = 0, cy = 0;
    const apply = (e: PointerEvent): void => {
      let dx = e.clientX - cx, dy = e.clientY - cy;
      const d = Math.hypot(dx, dy);
      if (d > JOY_RADIUS) { dx = dx / d * JOY_RADIUS; dy = dy / d * JOY_RADIUS; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      onVec(dx / JOY_RADIUS, dy / JOY_RADIUS);
    };
    base.addEventListener('pointerdown', (e) => {
      if (id >= 0) return;
      e.preventDefault();
      id = e.pointerId; base.setPointerCapture(e.pointerId);
      const r = base.getBoundingClientRect();
      cx = r.left + r.width / 2; cy = r.top + r.height / 2;
      apply(e);
    });
    base.addEventListener('pointermove', (e) => { if (e.pointerId === id) apply(e); });
    const end = (e: PointerEvent): void => {
      if (e.pointerId !== id) return;
      id = -1; knob.style.transform = 'translate(0,0)'; onVec(0, 0);
    };
    base.addEventListener('pointerup', end);
    base.addEventListener('pointercancel', end);
    this.resets.push(() => { id = -1; knob.style.transform = 'translate(0,0)'; onVec(0, 0); });
  }

  /** Map the movement-stick vector to WASD (+ sprint on a full forward push). */
  private setMove(nx: number, ny: number): void {
    const k = this.input.keys;
    const set = (code: string, on: boolean): void => { if (on) k.add(code); else k.delete(code); };
    set('KeyW', ny < -0.35);
    set('KeyS', ny > 0.35);
    set('KeyA', nx < -0.35);
    set('KeyD', nx > 0.35);
    set('ShiftLeft', ny < -0.35 && Math.hypot(nx, ny) > 0.92);
  }

  private hold(cls: string, label: string, onDown: () => void, onUp: () => void): void {
    const b = el('div', cls, this.el, label);
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault(); b.setPointerCapture(e.pointerId); b.classList.add('held'); onDown();
    });
    const up = (): void => { b.classList.remove('held'); onUp(); };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    this.resets.push(up);
  }

  private tap(cls: string, label: string, onTap: () => void): void {
    const b = el('div', cls, this.el, label);
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault(); b.classList.add('held'); onTap();
    });
    const up = (): void => b.classList.remove('held');
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
  }

  /** Clear any held inputs (called when hiding / opening a menu). */
  private reset(): void {
    for (const r of this.resets) r();
    for (const c of ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'Space', 'ControlLeft', 'ShiftLeft']) this.input.keys.delete(c);
    this.input.leftDown = false;
    this.input.rightDown = false;
    this.camX = 0; this.camY = 0;
  }

  setVisible(on: boolean): void {
    this.visible = on;
    this.el.classList.toggle('hidden', !on);
    if (!on) this.reset();
  }
}
