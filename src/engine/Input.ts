// Pointer-lock mouse look + keyboard state with double-tap detection.

export class Input {
  keys = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  leftDown = false;
  rightDown = false;
  pointerLocked = false;
  /** touch devices drive movement/look without pointer lock (see TouchControls) */
  touchActive = false;
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
  }

  private keydown = (e: KeyboardEvent): void => {
    if (this.disposed) return;
    if (e.code === 'Tab' || (e.code === 'KeyW' && e.ctrlKey)) e.preventDefault();
    if (e.repeat) return;
    const now = performance.now();
    const last = this.lastTap.get(e.code) ?? -1e9;
    const doubleTap = now - last < 280;
    this.lastTap.set(e.code, doubleTap ? -1e9 : now);
    this.keys.add(e.code);
    this.onKeyDown(e.code, doubleTap);
  };

  private keyup = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private mousemove = (e: MouseEvent): void => {
    if (!this.pointerLocked) return;
    this.mouseDX += e.movementX;
    this.mouseDY += e.movementY;
  };

  private mousedown = (e: MouseEvent): void => {
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
  }
}
