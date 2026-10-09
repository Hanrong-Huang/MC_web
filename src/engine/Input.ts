// Pointer-lock mouse look + keyboard state with double-tap detection.

import { Action, bindingFor, normalizeCode } from './Keybinds';

export class Input {
  keys = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  leftDown = false;
  rightDown = false;
  pointerLocked = false;
  /** touch devices drive movement/look without pointer lock (see TouchControls) */
  touchActive = false;
  /** Touch: aim through this screen point (NDC, -1..1, y up) instead of the
   *  crosshair — Bedrock's "act where you touch". null = aim at the centre. */
  aimNDC: { x: number; y: number } | null = null;
  /** Touch tap-mode with no finger down: nothing is targeted (no outline). */
  aimOff = false;
  /** Touch: analog movement stick (x = strafe right, y = forward), each -1..1.
   *  null while the stick is idle, so the keys drive movement. */
  moveAxis: { x: number; y: number } | null = null;
  /** edge-triggered click queues so brief clicks survive slow frames */
  private rightClickQueued = false;

  /** True when input should drive the player: pointer-locked OR touch controls. */
  get active(): boolean { return this.pointerLocked || this.touchActive; }

  /** Queue a single right-click (used by the touch "use" button). */
  queueRightClick(): void { this.rightClickQueued = true; }

  onKeyDown: (code: string, doubleTap: boolean) => void = () => {};
  onMouseDown: (button: number) => void = () => {};
  onWheel: (delta: number) => void = () => {};
  onPointerLockChange: (locked: boolean) => void = () => {};

  private lastTap = new Map<string, number>();
  private el: HTMLElement;
  private disposed = false;

  constructor(el: HTMLElement) {
    this.el = el;
    document.addEventListener('keydown', this.keydown);
    document.addEventListener('keyup', this.keyup);
    document.addEventListener('mousemove', this.mousemove);
    document.addEventListener('mousedown', this.mousedown);
    document.addEventListener('mouseup', this.mouseup);
    document.addEventListener('wheel', this.wheel, { passive: false });
    document.addEventListener('pointerlockchange', this.plc);
    document.addEventListener('contextmenu', this.ctxmenu);
    window.addEventListener('blur', this.clearHeld);
    document.addEventListener('visibilitychange', this.visibilityChange);
  }

  private keydown = (e: KeyboardEvent): void => {
    if (this.disposed) return;
    // typing into a text field (chat, world name, server address) never drives the game
    if (isTextField(e.target)) return;
    // Tab is the player list; Ctrl+Q tosses a stack. (Ctrl+W can't be caught —
    // the browser keeps it to close the tab — so no movement key uses Ctrl.)
    if (e.code === 'Tab' || (e.ctrlKey && e.code === 'KeyQ')) e.preventDefault();
    if (e.repeat) return;
    const code = normalizeCode(e.code);
    const now = performance.now();
    const last = this.lastTap.get(code) ?? -1e9;
    const doubleTap = now - last < 280;
    this.lastTap.set(code, doubleTap ? -1e9 : now);
    this.keys.add(code);
    this.onKeyDown(code, doubleTap);
  };

  private keyup = (e: KeyboardEvent): void => {
    this.keys.delete(normalizeCode(e.code));
  };

  private mousemove = (e: MouseEvent): void => {
    if (!this.pointerLocked) return;
    this.mouseDX += e.movementX;
    this.mouseDY += e.movementY;
  };

  private mousedown = (e: MouseEvent): void => {
    if (e.button === 1 && this.pointerLocked) e.preventDefault(); // no autoscroll on pick-block
    if (e.button === 0) this.leftDown = true;
    if (e.button === 2) { this.rightDown = true; this.rightClickQueued = true; }
    this.onMouseDown(e.button);
  };

  /** Consume a queued right click (fires even if the button was released between frames). */
  takeRightClick(): boolean {
    const v = this.rightClickQueued;
    this.rightClickQueued = false;
    return v;
  }

  /** Forget held buttons and queued clicks — called when a screen opens or
   *  closes, so a click spent on the UI (or the right-click that opened a chest)
   *  isn't replayed into the world and reopens the chest you're looking at. */
  clearClicks(): void {
    this.leftDown = false;
    this.rightDown = false;
    this.rightClickQueued = false;
  }

  /** Is a click pending that the next player update hasn't consumed yet? */
  get rightClickPending(): boolean { return this.rightClickQueued; }

  private mouseup = (e: MouseEvent): void => {
    if (e.button === 0) this.leftDown = false;
    if (e.button === 2) this.rightDown = false;
  };

  private wheel = (e: WheelEvent): void => {
    if (this.pointerLocked) {
      e.preventDefault();
      this.onWheel(Math.sign(e.deltaY));
    }
  };

  private plc = (): void => {
    this.pointerLocked = document.pointerLockElement === this.el;
    this.onPointerLockChange(this.pointerLocked);
  };

  private ctxmenu = (e: Event): void => e.preventDefault();

  /** A key/button released while this tab is unfocused never sends us its
   *  keyup/pointerup. Forget every held input so returning to the game cannot
   *  leave the player walking, mining, or using an item on its own. */
  private clearHeld = (): void => {
    this.keys.clear();
    this.lastTap.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.moveAxis = null;
    this.clearClicks();
  };

  private visibilityChange = (): void => {
    if (document.hidden) this.clearHeld();
  };

  /** Returns accumulated mouse deltas and clears them. */
  consumeMouse(): [number, number] {
    const d: [number, number] = [this.mouseDX, this.mouseDY];
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }

  requestLock(): void {
    if (this.touchActive) return; // no pointer lock on touch devices
    if (!this.pointerLocked) {
      this.el.requestPointerLock?.();
    }
  }

  exitLock(): void {
    if (this.pointerLocked) document.exitPointerLock();
  }

  down(code: string): boolean { return this.keys.has(code); }

  /** Is a rebindable action held — its bound key, or the '@action' virtual
   *  key the touch controls press? */
  held(a: Action): boolean {
    const code = bindingFor(a);
    return (!!code && this.keys.has(code)) || this.keys.has(`@${a}`);
  }

  dispose(): void {
    this.disposed = true;
    document.removeEventListener('keydown', this.keydown);
    document.removeEventListener('keyup', this.keyup);
    document.removeEventListener('mousemove', this.mousemove);
    document.removeEventListener('mousedown', this.mousedown);
    document.removeEventListener('mouseup', this.mouseup);
    document.removeEventListener('wheel', this.wheel);
    document.removeEventListener('pointerlockchange', this.plc);
    document.removeEventListener('contextmenu', this.ctxmenu);
    window.removeEventListener('blur', this.clearHeld);
    document.removeEventListener('visibilitychange', this.visibilityChange);
  }
}

function isTextField(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName !== 'INPUT') return false;
  const type = (el as HTMLInputElement).type;
  return type === 'text' || type === 'search' || type === 'url' || type === 'number' || type === 'password' || type === '';
}
