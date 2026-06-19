// On-screen touch controls for phones/tablets, in the Minecraft Pocket Edition
// layout: a floating movement joystick on the LEFT, drag-to-look on the RIGHT,
// and action buttons on the right for the same thumb. Everything drives the same
// Input fields the keyboard/mouse path uses. Shown only on touch while playing.

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

const JOY_RADIUS = 52;     // px throw of the movement knob
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

    // LEFT: a floating movement joystick — touch anywhere on the left and the
    // stick appears under your thumb, drag to walk (full forward push = sprint).
    const moveZone = el('div', 'touch-move-zone', c);
    const base = el('div', 'touch-stick stick-move hidden', c);
    const knob = el('div', 'touch-knob', base);
    let mid = -1, mcx = 0, mcy = 0;
    moveZone.addEventListener('pointerdown', (e) => {
      if (mid >= 0) return;
      e.preventDefault();
      mid = e.pointerId; moveZone.setPointerCapture(e.pointerId);
      mcx = e.clientX; mcy = e.clientY;
      base.style.left = `${mcx}px`; base.style.top = `${mcy}px`;
      base.classList.remove('hidden');
      knob.style.transform = 'translate(0,0)';
      this.setMove(0, 0);
    });
    moveZone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== mid) return;
      let dx = e.clientX - mcx, dy = e.clientY - mcy;
      const d = Math.hypot(dx, dy);
      if (d > JOY_RADIUS) { dx = dx / d * JOY_RADIUS; dy = dy / d * JOY_RADIUS; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      this.setMove(dx / JOY_RADIUS, dy / JOY_RADIUS);
    });
    const endMove = (e: PointerEvent): void => {
      if (e.pointerId !== mid) return;
      mid = -1; base.classList.add('hidden'); this.setMove(0, 0);
    };
    moveZone.addEventListener('pointerup', endMove);
    moveZone.addEventListener('pointercancel', endMove);
    this.resets.push(() => { mid = -1; base.classList.add('hidden'); this.setMove(0, 0); });

    // RIGHT: drag to look
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

    // RIGHT action buttons (same thumb as look). Mine also fires a left-click so
    // it attacks mobs; place drives the right-click (place / use / eat / bow).
    this.hold('tb tb-mine', '⛏', () => { input.leftDown = true; input.onMouseDown(0); }, () => { input.leftDown = false; });
    this.hold('tb tb-place', '✋', () => { input.rightDown = true; input.queueRightClick(); }, () => { input.rightDown = false; });
    this.hold('tb tb-jump', '⏶', () => { input.keys.add('Space'); }, () => { input.keys.delete('Space'); });
    this.hold('tb tb-down', '⏷', () => { input.keys.add('ControlLeft'); }, () => { input.keys.delete('ControlLeft'); });
    // utility (top)
    this.tap('tb tb-inv', '🎒', hooks.onInventory);
    this.tap('tb tb-fly', '✈', hooks.onFly);
    this.tap('tb tb-pause', '⏸', hooks.onPause);
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
