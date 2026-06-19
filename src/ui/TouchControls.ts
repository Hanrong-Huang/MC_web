// On-screen touch controls for phones/tablets: a floating movement joystick on
// the left, drag-to-look on the right, and hold/tap action buttons. Everything
// drives the same Input fields the keyboard/mouse path uses, so the rest of the
// game is unchanged. Shown only on touch devices while playing.

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

const LOOK_SCALE = 1.35;   // touch-drag pixels → look "mouse" pixels
const JOY_RADIUS = 56;     // px throw of the joystick knob

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
  private joyId = -1;
  private joyCx = 0;
  private joyCy = 0;
  private joyBase: HTMLElement;
  private joyKnob: HTMLElement;
  private lookId = -1;
  private lookX = 0;
  private lookY = 0;

  constructor(root: HTMLElement, input: Input, hooks: TouchHooks) {
    this.input = input;
    const c = el('div', 'hidden', root); c.id = 'touch-controls';
    this.el = c;

    // left half: floating joystick zone
    const moveZone = el('div', 'touch-zone touch-move', c);
    this.joyBase = el('div', 'touch-joy-base hidden', c);
    this.joyKnob = el('div', 'touch-joy-knob', this.joyBase);
    moveZone.addEventListener('pointerdown', (e) => {
      if (this.joyId >= 0) return;
      e.preventDefault();
      this.joyId = e.pointerId;
      moveZone.setPointerCapture(e.pointerId);
      this.joyCx = e.clientX; this.joyCy = e.clientY;
      this.joyBase.style.left = `${e.clientX}px`;
      this.joyBase.style.top = `${e.clientY}px`;
      this.joyBase.classList.remove('hidden');
      this.knob(0, 0);
    });
    moveZone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.joyId) return;
      let dx = e.clientX - this.joyCx, dy = e.clientY - this.joyCy;
      const d = Math.hypot(dx, dy);
      if (d > JOY_RADIUS) { dx = dx / d * JOY_RADIUS; dy = dy / d * JOY_RADIUS; }
      this.knob(dx, dy);
      this.setMove(dx / JOY_RADIUS, dy / JOY_RADIUS);
    });
    const endJoy = (e: PointerEvent): void => {
      if (e.pointerId !== this.joyId) return;
      this.joyId = -1;
      this.joyBase.classList.add('hidden');
      this.setMove(0, 0);
    };
    moveZone.addEventListener('pointerup', endJoy);
    moveZone.addEventListener('pointercancel', endJoy);

    // right half: drag to look
    const lookZone = el('div', 'touch-zone touch-look', c);
    lookZone.addEventListener('pointerdown', (e) => {
      if (this.lookId >= 0) return;
      e.preventDefault();
      this.lookId = e.pointerId;
      lookZone.setPointerCapture(e.pointerId);
      this.lookX = e.clientX; this.lookY = e.clientY;
    });
    lookZone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.lookId) return;
      this.input.mouseDX += (e.clientX - this.lookX) * LOOK_SCALE;
      this.input.mouseDY += (e.clientY - this.lookY) * LOOK_SCALE;
      this.lookX = e.clientX; this.lookY = e.clientY;
    });
    const endLook = (e: PointerEvent): void => { if (e.pointerId === this.lookId) this.lookId = -1; };
    lookZone.addEventListener('pointerup', endLook);
    lookZone.addEventListener('pointercancel', endLook);

    // action buttons (on top of the zones)
    this.hold('tb tb-mine', '⛏', () => { input.leftDown = true; }, () => { input.leftDown = false; });
    this.hold('tb tb-place', '✋', () => { input.rightDown = true; input.queueRightClick(); }, () => { input.rightDown = false; });
    this.hold('tb tb-jump', '⏶', () => { input.keys.add('Space'); }, () => { input.keys.delete('Space'); });
    this.hold('tb tb-down', '⏷', () => { input.keys.add('ControlLeft'); }, () => { input.keys.delete('ControlLeft'); });
    this.tap('tb tb-inv', '🎒', hooks.onInventory);
    this.tap('tb tb-fly', '✈', hooks.onFly);
    this.tap('tb tb-pause', '⏸', hooks.onPause);
  }

  private knob(dx: number, dy: number): void {
    this.joyKnob.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  /** Map the joystick vector to WASD (+ sprint when pushed fully forward). */
  private setMove(nx: number, ny: number): void {
    const k = this.input.keys;
    const set = (code: string, on: boolean): void => { if (on) k.add(code); else k.delete(code); };
    set('KeyW', ny < -0.35);
    set('KeyS', ny > 0.35);
    set('KeyA', nx < -0.35);
    set('KeyD', nx > 0.35);
    set('ShiftLeft', ny < -0.35 && Math.hypot(nx, ny) > 0.92); // full-forward = sprint
  }

  private hold(cls: string, label: string, onDown: () => void, onUp: () => void): HTMLElement {
    const b = el('div', cls, this.el, label);
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault(); b.setPointerCapture(e.pointerId); b.classList.add('held'); onDown();
    });
    const up = (): void => { b.classList.remove('held'); onUp(); };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    return b;
  }

  private tap(cls: string, label: string, onTap: () => void): HTMLElement {
    const b = el('div', cls, this.el, label);
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault(); b.classList.add('held'); onTap();
    });
    const up = (): void => b.classList.remove('held');
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    return b;
  }

  /** Clear any held inputs (called when hiding / opening a menu). */
  private reset(): void {
    for (const c of ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'Space', 'ControlLeft', 'ShiftLeft']) this.input.keys.delete(c);
    this.input.leftDown = false;
    this.input.rightDown = false;
    this.joyId = -1; this.lookId = -1;
    this.joyBase.classList.add('hidden');
  }

  setVisible(on: boolean): void {
    this.el.classList.toggle('hidden', !on);
    if (!on) this.reset();
  }
}
