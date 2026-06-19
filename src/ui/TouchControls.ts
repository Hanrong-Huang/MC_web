// On-screen touch controls for phones/tablets. Movement is the RIGHT joystick;
// looking is drag-anywhere on the screen (like Minecraft Pocket Edition). Action
// buttons sit on the left for the free thumb. Everything drives the same Input
// fields the keyboard/mouse path uses, so the rest of the game is unchanged.
// Shown only on touch devices while playing.

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

const JOY_RADIUS = 50;     // px throw of the movement knob
const LOOK_SCALE = 1.3;    // drag pixels → look "mouse" pixels

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
  private resets: Array<() => void> = [];

  constructor(root: HTMLElement, input: Input, hooks: TouchHooks) {
    this.input = input;
    const c = el('div', 'hidden', root); c.id = 'touch-controls';
    this.el = c;

    // full-screen LOOK layer (drag to turn the camera). It sits beneath the
    // joystick + buttons, so touches on those go to them and only empty-area
    // drags rotate the view.
    const look = el('div', 'touch-look', c);
    let lookId = -1, lx = 0, ly = 0;
    look.addEventListener('pointerdown', (e) => {
      if (lookId >= 0) return;
      e.preventDefault();
      lookId = e.pointerId; look.setPointerCapture(e.pointerId);
      lx = e.clientX; ly = e.clientY;
    });
    look.addEventListener('pointermove', (e) => {
      if (e.pointerId !== lookId) return;
      input.mouseDX += (e.clientX - lx) * LOOK_SCALE;
      input.mouseDY += (e.clientY - ly) * LOOK_SCALE;
      lx = e.clientX; ly = e.clientY;
    });
    const endLook = (e: PointerEvent): void => { if (e.pointerId === lookId) lookId = -1; };
    look.addEventListener('pointerup', endLook);
    look.addEventListener('pointercancel', endLook);
    this.resets.push(() => { lookId = -1; });

    // RIGHT movement joystick
    this.makeStick('touch-stick stick-move', (nx, ny) => this.setMove(nx, ny));

    // action buttons. Mine also fires a left-click so it attacks mobs (not just
    // breaks blocks); place drives the right-click (place / use / eat / draw bow).
    this.hold('tb tb-mine', '⛏', () => { input.leftDown = true; input.onMouseDown(0); }, () => { input.leftDown = false; });
    this.hold('tb tb-place', '✋', () => { input.rightDown = true; input.queueRightClick(); }, () => { input.rightDown = false; });
    this.hold('tb tb-jump', '⏶', () => { input.keys.add('Space'); }, () => { input.keys.delete('Space'); });
    this.hold('tb tb-down', '⏷', () => { input.keys.add('ControlLeft'); }, () => { input.keys.delete('ControlLeft'); });
    this.tap('tb tb-inv', '🎒', hooks.onInventory);
    this.tap('tb tb-fly', '✈', hooks.onFly);
    this.tap('tb tb-pause', '⏸', hooks.onPause);
  }

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

  private buzz(): void { try { navigator.vibrate?.(8); } catch { /* unsupported */ } }

  private hold(cls: string, label: string, onDown: () => void, onUp: () => void): void {
    const b = el('div', cls, this.el, label);
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault(); b.setPointerCapture(e.pointerId); b.classList.add('held'); this.buzz(); onDown();
    });
    const up = (): void => { b.classList.remove('held'); onUp(); };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    this.resets.push(up);
  }

  private tap(cls: string, label: string, onTap: () => void): void {
    const b = el('div', cls, this.el, label);
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault(); b.classList.add('held'); this.buzz(); onTap();
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
  }

  setVisible(on: boolean): void {
    this.el.classList.toggle('hidden', !on);
    if (!on) this.reset();
  }
}
