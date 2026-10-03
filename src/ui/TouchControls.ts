// On-screen touch controls for phones/tablets, laid out like Minecraft Bedrock
// on a phone:
//   - LEFT: a floating analog stick (or the classic D-pad). Push it to the rim
//     to sprint; on the D-pad double-tap forward.
//   - Everywhere else: drag to look. Tap = use / place (or hit the mob you
//     tapped), press-and-hold = break / attack (or eat, draw a bow, raise a
//     shield). In "tap" aim mode the action lands where the finger is; in
//     "crosshair" mode (Bedrock's split controls) it lands on the crosshair.
//   - RIGHT: jump (double-tap toggles creative flight) and sneak (a toggle).
//     Flying or swimming turns them into up/down; riding makes sneak dismount.
//     A context button ("Ride", "Trade", "Feed"…) shows when a mob is centred.
//   - TOP-LEFT: pause, chat, flight (and the player list in multiplayer).
// Everything drives the same Input fields the keyboard/mouse path uses, via
// '@action' virtual keys, so rebinding the keyboard never touches touch play.

import { Input } from '../engine/Input';
import { touchLookSens, getControls, onControlsChange, ControlSettings } from '../engine/ControlsSettings';

export interface TouchHooks {
  onInventory: () => void;
  onPause: () => void;
  onChat: () => void;
  onFly: () => void;
  onPlayers: () => void;
  /** double-tap jump (creative flight toggle, like double-tapping Space) */
  onJumpDouble: () => void;
  /** contextual button pressed (interact with the centred mob) */
  onContext: () => void;
  /** pick block (desktop middle click) at the aim — finger or crosshair */
  onPick: () => void;
  /** the eye button while the HUD is hidden (desktop F1) brings it back */
  onShowHud: () => void;
  /** a tap on the world: hit the mob under the finger, or use / place */
  tapAction: () => 'attack' | 'use';
  /** a press-and-hold: keep using the held item (eat, bow, shield) or break */
  holdAction: () => 'use' | 'mine';
}

/** Per-frame state from the game, so buttons can change role. */
export interface TouchFrame {
  flying: boolean;
  swimming: boolean;
  riding: boolean;
  /** 0..1 progress of the block being broken, < 0 when not breaking */
  breaking: number;
  /** label of the contextual mob action, or null to hide the button */
  context: string | null;
  multiplayer: boolean;
}

/** Can this device do touch at all? (The UI itself follows the last input used.) */
export function isTouchDevice(): boolean {
  return (typeof window !== 'undefined') &&
    (('ontouchstart' in window) || (navigator.maxTouchPoints ?? 0) > 0);
}

/** Is the touch interface what the player is using right now? Phones start in
 *  it; a touch laptop switches with whichever of mouse or finger was last used. */
export function touchUI(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('touch-ui');
}

/** Should a fresh page start in touch mode? (A coarse primary pointer.) */
export function prefersTouch(): boolean {
  if (!isTouchDevice()) return false;
  try {
    return matchMedia('(pointer: coarse)').matches || !matchMedia('(any-pointer: fine)').matches;
  } catch { return true; }
}

const modeListeners = new Set<(touch: boolean) => void>();
let modeWatching = false;

function setTouchUI(on: boolean): void {
  const root = document.documentElement;
  if (root.classList.contains('touch-ui') === on) return;
  root.classList.toggle('touch-ui', on);
  for (const fn of [...modeListeners]) fn(on);
}

/** Start following the input in use (once, at boot): a phone starts in touch
 *  mode; on a touch-screen laptop a finger switches to the touch layout and a
 *  mouse click back to mouse + keyboard (like Bedrock on a Surface). */
export function initInputMode(): void {
  if (modeWatching) return;
  modeWatching = true;
  setTouchUI(prefersTouch());
  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' || e.pointerType === 'pen') setTouchUI(true);
    else if (e.pointerType === 'mouse') setTouchUI(false);
  }, { capture: true });
  // auto-fullscreen on a lifted finger: per the HTML spec a touch pointerdown
  // grants no user activation (pointerup / touchend do), so asking on the
  // press is refused on real phones
  window.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'mouse' || !fsArmed || !getControls().fullscreen) return;
    fsArmed = false;
    enterFullscreen();
  }, { capture: true });
  document.addEventListener('fullscreenchange', () => { if (!isFullscreen()) fsArmed = false; });
}

// --- fullscreen ---------------------------------------------------------------------

type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitFullscreenEnabled?: boolean; webkitExitFullscreen?: () => void };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => void };

/** Auto-fullscreen waits for the next lifted finger: armed at boot and when a
 *  world starts, dropped once used — so leaving fullscreen on purpose (back
 *  gesture) isn't undone on the next tap; the ⛶ button brings it back. */
let fsArmed = true;
export function armFullscreen(): void { fsArmed = true; }

/** Launched from the home screen as an installed web app (no browser bars). */
export function isStandalone(): boolean {
  try {
    return matchMedia('(display-mode: fullscreen)').matches || matchMedia('(display-mode: standalone)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch { return false; }
}

export function isFullscreen(): boolean {
  const d = document as FsDoc;
  return !!(d.fullscreenElement || d.webkitFullscreenElement);
}

/** Does this browser let a page go fullscreen? (iPhone Safari doesn't.) */
export function canFullscreen(): boolean {
  const d = document as FsDoc;
  return !!(d.fullscreenEnabled || d.webkitFullscreenEnabled);
}

/** iPhone Safari outside a home-screen app: the only way to lose the browser
 *  bars is Share → Add to Home Screen (the manifest makes that fullscreen). */
export function needsHomeScreen(): boolean {
  return !canFullscreen() && !isStandalone() && /iPhone|iPod/.test(navigator.userAgent);
}

/** Go fullscreen and hold landscape (Android allows the lock only when
 *  fullscreen). Must run inside a user gesture. */
export function enterFullscreen(): void {
  if (isFullscreen() || !canFullscreen()) return;
  const de = document.documentElement as FsEl;
  const lock = (): void => {
    const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    try { o?.lock?.('landscape').catch(() => { /* not allowed here */ }); } catch { /* unsupported */ }
  };
  try {
    if (de.requestFullscreen) de.requestFullscreen({ navigationUI: 'hide' }).then(lock, () => { /* refused */ });
    else { de.webkitRequestFullscreen?.(); lock(); }
  } catch { /* unsupported */ }
}

export function exitFullscreen(): void {
  const d = document as FsDoc;
  if (!isFullscreen()) return;
  try {
    if (d.exitFullscreen) void d.exitFullscreen().catch(() => { /* already out */ });
    else d.webkitExitFullscreen?.();
  } catch { /* unsupported */ }
}

/** Be told when the touch layout turns on or off. */
export function onInputMode(fn: (touch: boolean) => void): () => void {
  modeListeners.add(fn);
  return () => { modeListeners.delete(fn); };
}

const HOLD_MS = 280;        // press this long without dragging = hold (break / use)
const SLOP_PX = 10;         // finger travel that turns a press into a look-drag
const DOUBLE_MS = 300;      // double-tap window (jump → fly, forward → sprint)
const DEAD = 0.16;          // stick dead zone (fraction of its throw)

function el(tag: string, cls: string, parent: HTMLElement): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent.appendChild(e);
  return e;
}

/** 16×16 procedural button icon (one char per pixel, '.' = transparent). */
function touchPix(rows: string[], pal: Record<string, string>): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 16; c.height = 16;
  c.className = 'touch-pix';
  const ctx = c.getContext('2d')!;
  let minY = 16; let maxY = -1;
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      if (!pal[row[x]]) continue;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const dy = maxY >= minY ? Math.floor((16 - (maxY - minY + 1)) / 2) - minY : 0;
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      const col = pal[row[x]];
      if (!col) continue;
      ctx.fillStyle = col;
      ctx.fillRect(x, y + dy, 1, 1);
    }
  }
  return c;
}

const W = '#ece6d2';
const D = '#3a3226';
const I = '#c8c8d0';
const B = '#7fb8ff';

const UP = [
  '.......ww.......',
  '......wwww......',
  '.....wwwwww.....',
  '....wwwwwwww....',
  '...wwwwwwwwww...',
  '..wwwwwwwwwwww..',
  '......wwww......',
  '......wwww......',
  '......wwww......',
  '......wwww......',
];
const DOWN = [...UP].reverse();

function icons() {
  return {
    jump: touchPix(UP, { w: W }),
    up: touchPix(UP, { w: B }),
    down: touchPix(DOWN, { w: B }),
    // a crouching figure
    sneak: touchPix([
      '................',
      '.....wwww.......',
      '.....wwww.......',
      '.....wwww.......',
      '......ww........',
      '....wwwwww......',
      '...wwwwwwww.....',
      '...ww.wwww......',
      '......wwww......',
      '.....wwwwww.....',
      '....ww....ww....',
      '...ww......ww...',
    ], { w: W }),
    // stepping off a mount: an arrow out of a saddle
    dismount: touchPix([
      '..........ww....',
      '..........www...',
      '.wwwwwwwwwwwww..',
      '.wwwwwwwwwwwwww.',
      '.wwwwwwwwwwwww..',
      '..........www...',
      '..........ww....',
      '................',
      '..dddddddddd....',
      '.dddddddddddd...',
      '.dd........dd...',
    ], { w: W, d: '#a0703a' }),
    pause: touchPix([
      '...ww....ww.....',
      '...ww....ww.....',
      '...ww....ww.....',
      '...ww....ww.....',
      '...ww....ww.....',
      '...ww....ww.....',
      '...ww....ww.....',
      '...ww....ww.....',
    ], { w: W }),
    chat: touchPix([
      '.wwwwwwwwwwwww..',
      'wwwwwwwwwwwwwww.',
      'wwddwwddwwddwww.',
      'wwddwwddwwddwww.',
      'wwwwwwwwwwwwwww.',
      '.wwwwwwwwwwwww..',
      '...www..........',
      '..ww............',
    ], { w: W, d: D }),
    fly: touchPix([
      '..ii........ii..',
      '.iiii......iiii.',
      'iiiiii.ww.iiiiii',
      '.iiiiiwwwwiiiii.',
      '..iii.wwww.iii..',
      '.......ww.......',
    ], { i: I, w: W }),
    // pick block: a block with an arrow down into a hotbar slot
    pick: touchPix([
      '...gggggggg.....',
      '...gggggggg.....',
      '...dddddddd.....',
      '...dddddddd.....',
      '...dddddddd.....',
      '.......w........',
      '.....wwwww......',
      '......www.......',
      '.......w........',
      '..wwwwwwwwwww...',
      '..w.........w...',
      '..wwwwwwwwwww...',
    ], { g: '#6aa84f', d: '#8b5a2b', w: W }),
    // fullscreen: four corners
    fs: touchPix([
      'wwwww....wwwww..',
      'w............w..',
      'w............w..',
      'w............w..',
      '................',
      '................',
      'w............w..',
      'w............w..',
      'w............w..',
      'wwwww....wwwww..',
    ], { w: W }),
    // show the HUD again: an eye
    eye: touchPix([
      '.....wwwwww.....',
      '...ww......ww...',
      '.ww....dd....ww.',
      'w.....dddd.....w',
      '.ww....dd....ww.',
      '...ww......ww...',
      '.....wwwwww.....',
    ], { w: W, d: B }),
    players: touchPix([
      '...ww......ww...',
      '..wwww....wwww..',
      '..wwww....wwww..',
      '...ww......ww...',
      '.wwwwww..wwwwww.',
      'wwwwwwwwwwwwwwww',
      'wwwwwwwwwwwwwwww',
      'wwwwwwwwwwwwwwww',
    ], { w: W }),
  };
}

type HoldMode = 'pending' | 'look' | 'mine' | 'use';

export class TouchControls {
  readonly el: HTMLElement;
  private input: Input;
  private hooks: TouchHooks;
  private resets: Array<() => void> = [];
  private ico = icons();
  private visible = false;
  /** frames left before a lifted finger's aim is dropped (the tap's click
   *  must be consumed with it first) */
  private aimRelease = 0;
  private frameState: TouchFrame = { flying: false, swimming: false, riding: false, breaking: -1, context: null, multiplayer: false };

  // sneak button: a latch on the ground, a hold while flying / swimming / riding
  private sneakLatched = false;
  private sneakHeld = false;
  private sneakBtn!: HTMLElement;
  private jumpBtn!: HTMLElement;
  private ctxBtn!: HTMLElement;
  private playersBtn!: HTMLElement;
  private fsBtn!: HTMLElement;
  private pickBtn!: HTMLElement;
  /** tap-aim pick block: the next tap on the world picks instead of using */
  private pickArmed = false;
  private ring: HTMLElement;
  private ringFill: HTMLElement;
  /** primary look pointer: where it is, and what its press turned into */
  private primary: { id: number; x: number; y: number; mode: HoldMode; t0: number } | null = null;
  private unsub: () => void;

  constructor(root: HTMLElement, input: Input, hooks: TouchHooks) {
    this.input = input;
    this.hooks = hooks;
    const c = el('div', 'hidden', root); c.id = 'touch-controls';
    this.el = c;

    this.buildLook();
    this.ring = el('div', 'touch-ring hidden', c);
    this.ringFill = el('div', 'touch-ring-fill', this.ring);
    this.buildStick();
    this.buildDpad();
    this.buildButtons();

    // portrait phones: Bedrock is landscape-only, so ask to rotate (dismissable)
    const rot = el('div', 'touch-rotate', c);
    el('div', 'touch-rotate-icon', rot);
    el('div', 'touch-rotate-text', rot).textContent = 'Turn your device sideways for the best controls';
    const keep = el('button', 'mc-btn small', rot) as HTMLButtonElement;
    keep.type = 'button';
    keep.textContent = 'Play in portrait';
    keep.addEventListener('click', () => c.classList.add('rotate-ok'));

    this.applySettings(getControls());
    this.unsub = onControlsChange((s) => this.applySettings(s));
  }

  // --- settings -------------------------------------------------------------------

  private applySettings(s: ControlSettings): void {
    const c = this.el;
    c.classList.toggle('scheme-dpad', s.touchScheme === 'dpad');
    c.classList.toggle('scheme-joystick', s.touchScheme === 'joystick');
    c.style.setProperty('--tb-s', String(s.touchSize));
    c.style.setProperty('--tb-a', String(s.touchOpacity));
    document.documentElement.classList.toggle('aim-tap', s.touchAim === 'tap');
    this.syncAim();
  }

  private tapAim(): boolean { return getControls().touchAim === 'tap'; }

  /** Idle aim: tap-mode aims at nothing between touches; crosshair mode at the centre. */
  private syncAim(): void {
    if (this.primary && this.primary.mode !== 'look') return;
    if (!this.visible) { this.input.aimNDC = null; this.input.aimOff = false; return; }
    if (!this.tapAim()) { this.input.aimNDC = null; this.input.aimOff = false; }
  }

  // --- look + act (the whole screen behind the buttons) ---------------------------------

  private buildLook(): void {
    const look = el('div', 'touch-look', this.el);
    const input = this.input;
    const others = new Map<number, { x: number; y: number }>(); // extra fingers just look
    let sx = 0, sy = 0;

    const setAim = (x: number, y: number): void => {
      if (!this.tapAim()) return;
      this.aimRelease = 0;
      input.aimOff = false;
      input.aimNDC = { x: (x / window.innerWidth) * 2 - 1, y: 1 - (y / window.innerHeight) * 2 };
    };
    // after a tap the queued click still needs the aim: frame() drops it
    // once the player has had a frame to act on the click
    const releaseAim = (): void => { if (this.tapAim()) this.aimRelease = 2; };
    const endAction = (): void => this.endHold();

    look.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      look.setPointerCapture(e.pointerId);
      if (this.primary) { others.set(e.pointerId, { x: e.clientX, y: e.clientY }); return; }
      this.primary = { id: e.pointerId, x: e.clientX, y: e.clientY, mode: 'pending', t0: e.timeStamp };
      sx = e.clientX; sy = e.clientY;
      setAim(e.clientX, e.clientY);
      // the press becomes a hold in frame(), not on a timer: a frame runs only
      // after the browser has handed over any lift or drag already queued
    });
    look.addEventListener('pointermove', (e) => {
      const o = others.get(e.pointerId);
      const scale = touchLookSens();
      if (o) {
        input.mouseDX += (e.clientX - o.x) * scale;
        input.mouseDY += (e.clientY - o.y) * scale;
        o.x = e.clientX; o.y = e.clientY;
        return;
      }
      const p = this.primary;
      if (!p || e.pointerId !== p.id) return;
      const far = Math.hypot(e.clientX - sx, e.clientY - sy) > SLOP_PX;
      // a drag that began inside the hold window is a look, even if a stalled
      // compositor delivered it after the hold began (by event timestamps)
      if (far && p.mode !== 'pending' && p.mode !== 'look' && e.timeStamp - p.t0 < HOLD_MS) {
        endAction();
        p.mode = 'pending';
      }
      if (p.mode === 'pending' && far) p.mode = 'look';
      // the camera turns with the drag even mid-hold, as on Bedrock; the
      // pending press only starts turning once it is clearly a drag
      if (p.mode !== 'pending') {
        input.mouseDX += (e.clientX - p.x) * scale;
        input.mouseDY += (e.clientY - p.y) * scale;
      }
      p.x = e.clientX; p.y = e.clientY;
      if (p.mode !== 'look') setAim(e.clientX, e.clientY);
      else if (this.tapAim()) { input.aimNDC = null; input.aimOff = true; }
    });
    const up = (e: PointerEvent): void => {
      if (others.delete(e.pointerId)) return;
      const p = this.primary;
      if (!p || e.pointerId !== p.id) return;
      // likewise a lift stamped inside the hold window was a tap
      const quick = e.timeStamp - p.t0 < HOLD_MS;
      if (e.type === 'pointerup' && quick && (p.mode === 'mine' || p.mode === 'use')) {
        endAction();
        p.mode = 'pending';
      }
      if (p.mode === 'pending' && e.type === 'pointerup') {
        // a tap: hit the mob under the finger, otherwise use / place
        setAim(p.x, p.y);
        if (this.pickArmed) {
          this.pickArmed = false;
          this.pickBtn.classList.remove('on');
          this.hooks.onPick();
        } else if (this.hooks.tapAction() === 'attack') input.onMouseDown(0);
        else input.queueRightClick();
      }
      endAction();
      this.primary = null;
      this.ring.classList.add('hidden');
      releaseAim();
    };
    look.addEventListener('pointerup', up);
    look.addEventListener('pointercancel', up);
    this.resets.push(() => {
      endAction();
      this.primary = null;
      others.clear();
      this.ring.classList.add('hidden');
    });
  }

  /** A press held still past HOLD_MS turns into breaking / attacking, or —
   *  with something to eat, a bow or a shield — into using it. */
  private startHold(): void {
    const p = this.primary;
    if (!p || p.mode !== 'pending') return;
    if (this.hooks.holdAction() === 'use') {
      p.mode = 'use';
      this.input.rightDown = true;
      this.input.queueRightClick();
    } else {
      p.mode = 'mine';
      this.input.leftDown = true;
      this.input.onMouseDown(0); // the swing / attack a left press makes
    }
    this.buzz(12);
  }

  private endHold(): void {
    const p = this.primary;
    if (!p) return;
    if (p.mode === 'mine') this.input.leftDown = false;
    if (p.mode === 'use') this.input.rightDown = false;
  }

  // --- movement: floating analog stick ---------------------------------------------

  private buildStick(): void {
    const zone = el('div', 'touch-move-zone', this.el);
    const base = el('div', 'touch-stick', zone);
    const knob = el('div', 'touch-knob', base);
    let id = -1, cx = 0, cy = 0;
    const radius = (): number => base.offsetWidth * 0.42 || 52;
    const rest = (): void => {
      base.classList.remove('active', 'sprint');
      base.style.left = ''; base.style.top = '';
      knob.style.transform = 'translate(0,0)';
    };
    zone.addEventListener('pointerdown', (e) => {
      if (id >= 0) return;
      e.preventDefault();
      id = e.pointerId; zone.setPointerCapture(e.pointerId);
      const zr = zone.getBoundingClientRect();
      cx = e.clientX; cy = e.clientY;
      // the stick jumps under the thumb (kept fully on screen)
      const r = base.offsetWidth / 2;
      cx = Math.max(zr.left + r, cx); cy = Math.min(zr.bottom - r, cy);
      base.style.left = `${cx - zr.left - r}px`;
      base.style.top = `${cy - zr.top - r}px`;
      base.classList.add('active');
      this.setStick(0, 0);
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      let dx = e.clientX - cx, dy = e.clientY - cy;
      const R = radius();
      const d = Math.hypot(dx, dy);
      if (d > R) { dx = dx / d * R; dy = dy / d * R; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      const sprint = this.setStick(dx / R, dy / R, d / R);
      base.classList.toggle('sprint', sprint);
    });
    const end = (e: PointerEvent): void => {
      if (e.pointerId !== id) return;
      id = -1; rest(); this.setStick(0, 0);
    };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
    this.resets.push(() => { id = -1; rest(); this.setStick(0, 0); });
  }

  /** Stick vector (screen axes, -1..1) → analog movement + direction keys.
   *  Returns true when it is pushed past the rim, which sprints. */
  private setStick(nx: number, ny: number, reach = Math.hypot(nx, ny)): boolean {
    const k = this.input.keys;
    const set = (code: string, on: boolean): void => { if (on) k.add(code); else k.delete(code); };
    const m = Math.hypot(nx, ny);
    if (m < DEAD) {
      this.input.moveAxis = null;
      for (const c of ['@forward', '@back', '@left', '@right', '@sprint']) k.delete(c);
      return false;
    }
    // rescale past the dead zone so a light push still creeps
    const s = Math.min(1, (m - DEAD) / (1 - DEAD)) / m;
    this.input.moveAxis = { x: nx * s, y: -ny * s };
    set('@forward', ny < -0.35);
    set('@back', ny > 0.35);
    set('@left', nx < -0.35);
    set('@right', nx > 0.35);
    // past the rim and mostly forward: sprint
    const sprint = reach > 0.94 && -ny > Math.abs(nx) * 0.9;
    set('@sprint', sprint);
    return sprint;
  }

  // --- movement: classic D-pad ---------------------------------------------------------

  private buildDpad(): void {
    const pad = el('div', 'touch-dpad', this.el);
    // 3×3 grid; the forward diagonals appear while forward is held (Bedrock)
    const names = ['ul', 'u', 'ur', 'l', 'c', 'r', '', 'd', ''];
    const cells = names.map((n) => {
      const cell = el('div', `dp-cell${n ? ` dp-${n}` : ''}`, pad);
      if (n && n !== 'c') el('div', 'dp-arrow', cell);
      return cell;
    });
    let id = -1, lastFwdDown = -1e9, sprintLatch = false;
    const keys = this.input.keys;
    const apply = (cell: number): void => {
      const n = names[cell] ?? '';
      const fwd = n === 'u' || n === 'ul' || n === 'ur';
      const set = (code: string, on: boolean): void => { if (on) keys.add(code); else keys.delete(code); };
      set('@forward', fwd);
      set('@back', n === 'd');
      set('@left', n === 'l' || n === 'ul');
      set('@right', n === 'r' || n === 'ur');
      if (!fwd) sprintLatch = false;
      set('@sprint', fwd && sprintLatch);
      pad.classList.toggle('fwd', fwd);
      cells.forEach((c, i) => c.classList.toggle('held', i === cell && !!n && n !== 'c'));
    };
    const cellAt = (x: number, y: number): number => {
      const r = pad.getBoundingClientRect();
      const col = Math.floor(((x - r.left) / r.width) * 3);
      const row = Math.floor(((y - r.top) / r.height) * 3);
      if (col < 0 || col > 2 || row < 0 || row > 2) return 4;
      const i = row * 3 + col;
      // diagonals only exist while walking forward
      if ((i === 0 || i === 2) && !pad.classList.contains('fwd')) return 1;
      return i;
    };
    pad.addEventListener('pointerdown', (e) => {
      if (id >= 0) return;
      e.preventDefault();
      id = e.pointerId; pad.setPointerCapture(e.pointerId);
      const cell = cellAt(e.clientX, e.clientY);
      if (cell === 1) {
        if (e.timeStamp - lastFwdDown < DOUBLE_MS) sprintLatch = true; // double-tap forward sprints
        lastFwdDown = e.timeStamp;
      }
      apply(cell);
      this.buzz(6);
    });
    pad.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      apply(cellAt(e.clientX, e.clientY));
    });
    const end = (e: PointerEvent): void => {
      if (e.pointerId !== id) return;
      id = -1; sprintLatch = false; apply(4);
    };
    pad.addEventListener('pointerup', end);
    pad.addEventListener('pointercancel', end);
    this.resets.push(() => { id = -1; sprintLatch = false; apply(4); });
  }

  // --- buttons -------------------------------------------------------------------------

  private buildButtons(): void {
    const keys = this.input.keys;
    const top = el('div', 'touch-top', this.el);
    this.tap(top, 'tb tb-pause', this.ico.pause, () => this.hooks.onPause(), 'Pause');
    // chat and fullscreen act on the lift: the phone keyboard and the
    // fullscreen request both need a user activation, which a touch press lacks
    this.tap(top, 'tb tb-chat', this.ico.chat, () => this.hooks.onChat(), 'Chat', true);
    this.tap(top, 'tb tb-fly', this.ico.fly, () => this.hooks.onFly(), 'Toggle flight');
    this.pickBtn = this.tap(top, 'tb tb-pick', this.ico.pick, () => this.pressPick(), 'Pick block');
    this.playersBtn = this.tap(top, 'tb tb-players hidden', this.ico.players, () => this.hooks.onPlayers(), 'Player list');
    this.fsBtn = this.tap(top, 'tb tb-fs hidden', this.ico.fs, () => enterFullscreen(), 'Fullscreen', true);
    this.tap(top, 'tb tb-showhud', this.ico.eye, () => this.hooks.onShowHud(), 'Show HUD');

    // jump: hold to jump / swim up / fly up; double-tap toggles creative flight
    let lastJump = -1e9;
    this.jumpBtn = this.hold('tb tb-jump', this.ico.jump, (e) => {
      keys.add('@jump');
      if (e.timeStamp - lastJump < DOUBLE_MS) { lastJump = -1e9; this.hooks.onJumpDouble(); } else lastJump = e.timeStamp;
    }, () => keys.delete('@jump'), 'Jump');

    // sneak: toggles on the ground, held while flying / swimming / riding
    this.sneakBtn = this.hold('tb tb-sneak', this.ico.sneak, () => {
      if (this.sneakHoldMode()) { this.sneakHeld = true; keys.add('@sneak'); return; }
      this.sneakLatched = !this.sneakLatched;
      this.syncSneakKey();
    }, () => {
      if (!this.sneakHeld) return;
      this.sneakHeld = false;
      this.syncSneakKey();
    }, 'Sneak');

    // contextual mob action ("Ride", "Trade", "Feed"…) — text, Bedrock-style
    this.ctxBtn = el('div', 'tb tb-ctx hidden', this.el);
    this.ctxBtn.setAttribute('role', 'button');
    this.ctxBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault(); this.ctxBtn.classList.add('held'); this.buzz(8);
      // it acts on the centred mob, whatever the finger last aimed at
      this.aimRelease = 0;
      this.input.aimNDC = null; this.input.aimOff = false;
      this.hooks.onContext();
    });
    const ctxUp = (): void => this.ctxBtn.classList.remove('held');
    this.ctxBtn.addEventListener('pointerup', ctxUp);
    this.ctxBtn.addEventListener('pointercancel', ctxUp);
  }

  private sneakHoldMode(): boolean {
    const f = this.frameState;
    return f.flying || f.swimming || f.riding;
  }

  private syncSneakKey(): void {
    const on = this.sneakHeld || (this.sneakLatched && !this.sneakHoldMode());
    if (on) this.input.keys.add('@sneak'); else this.input.keys.delete('@sneak');
    this.sneakBtn.classList.toggle('on', this.sneakLatched && !this.sneakHoldMode());
  }

  private buzz(ms = 8): void { try { navigator.vibrate?.(ms); } catch { /* unsupported */ } }

  private hold(cls: string, icon: HTMLCanvasElement, onDown: (e: PointerEvent) => void, onUp: () => void, tip: string): HTMLElement {
    const b = el('div', cls, this.el);
    b.appendChild(icon);
    b.title = tip; b.setAttribute('aria-label', tip); b.setAttribute('role', 'button');
    let id = -1;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (id >= 0) return;
      id = e.pointerId;
      b.setPointerCapture(e.pointerId); b.classList.add('held'); this.buzz(); onDown(e);
    });
    const up = (e?: PointerEvent): void => {
      if (e && e.pointerId !== id) return;
      if (id < 0 && e) return;
      id = -1;
      b.classList.remove('held'); onUp();
    };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    this.resets.push(() => { if (id >= 0) up(); });
    return b;
  }

  /** A press button; `onLift` fires it when the finger lifts (inside the
   *  button) instead of on the press — for actions needing user activation. */
  private tap(parent: HTMLElement, cls: string, icon: HTMLCanvasElement, onTap: () => void, tip: string, onLift = false): HTMLElement {
    const b = el('div', cls, parent);
    b.appendChild(icon);
    b.title = tip; b.setAttribute('aria-label', tip); b.setAttribute('role', 'button');
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault(); b.setPointerCapture(e.pointerId); b.classList.add('held'); this.buzz();
      if (!onLift) onTap();
    });
    b.addEventListener('pointerup', (e) => {
      if (!b.classList.contains('held')) return;
      b.classList.remove('held');
      const r = b.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (onLift && inside) onTap();
    });
    b.addEventListener('pointercancel', () => b.classList.remove('held'));
    return b;
  }

  /** Pick block: at the crosshair right away, or — tap aim — on the next
   *  tap on the world (press again to cancel). */
  private pressPick(): void {
    if (!this.tapAim()) { this.hooks.onPick(); return; }
    this.pickArmed = !this.pickArmed;
    this.pickBtn.classList.toggle('on', this.pickArmed);
  }

  private swapIcon(b: HTMLElement, icon: HTMLCanvasElement): void {
    const cur = b.querySelector('canvas');
    if (cur !== icon) { cur?.remove(); b.insertBefore(icon, b.firstChild); }
  }

  // --- per frame ------------------------------------------------------------------------

  /** Called every rendered frame while playing: buttons follow the player's state. */
  frame(f: TouchFrame): void {
    const pr = this.primary;
    if (pr && pr.mode === 'pending' && performance.now() - pr.t0 >= HOLD_MS) this.startHold();
    // a lifted finger stops aiming once its click has been used (tap aim)
    if (!pr && this.aimRelease > 0 && !this.input.rightClickPending && --this.aimRelease === 0 && this.tapAim()) {
      this.input.aimNDC = null;
      this.input.aimOff = true;
    }
    const was = this.frameState;
    this.frameState = f;
    const vertical = f.flying || f.swimming;
    // entering flight / water / a mount drops the sneak latch (it means "down" now)
    if ((f.flying && !was.flying) || (f.riding && !was.riding) || (f.swimming && !was.swimming)) {
      this.sneakLatched = false;
      this.syncSneakKey();
    }
    this.swapIcon(this.jumpBtn, vertical ? this.ico.up : this.ico.jump);
    this.swapIcon(this.sneakBtn, f.riding ? this.ico.dismount : vertical ? this.ico.down : this.ico.sneak);
    const sneakTip = f.riding ? 'Dismount' : vertical ? 'Descend' : 'Sneak';
    if (this.sneakBtn.title !== sneakTip) { this.sneakBtn.title = sneakTip; this.sneakBtn.setAttribute('aria-label', sneakTip); }
    this.playersBtn.classList.toggle('hidden', !f.multiplayer);
    this.fsBtn.classList.toggle('hidden', !canFullscreen() || isFullscreen());

    // contextual mob button
    const label = f.context;
    this.ctxBtn.classList.toggle('hidden', !label);
    if (label && this.ctxBtn.textContent !== label) this.ctxBtn.textContent = label;

    // breaking progress ring under the finger (tap aim; the crosshair shows it otherwise)
    const p = this.primary;
    const showRing = !!p && p.mode === 'mine' && f.breaking > 0 && this.tapAim();
    this.ring.classList.toggle('hidden', !showRing);
    if (showRing && p) {
      this.ring.style.transform = `translate(${p.x}px, ${p.y}px)`;
      this.ringFill.style.setProperty('--p', `${Math.round(f.breaking * 360)}deg`);
    }
  }

  /** The finger is held on the world, breaking / attacking (main repeats hits on mobs). */
  get mining(): boolean { return this.primary?.mode === 'mine'; }

  /** Clear any held inputs (called when hiding / opening a menu). */
  private reset(): void {
    for (const r of this.resets) r();
    for (const c of ['@forward', '@back', '@left', '@right', '@jump', '@sprint']) this.input.keys.delete(c);
    this.input.moveAxis = null;
    this.input.leftDown = false;
    this.input.rightDown = false;
    this.sneakHeld = false;
    this.syncSneakKey();
    this.pickArmed = false;
    this.pickBtn?.classList.remove('on');
    this.aimRelease = 0;
  }

  setVisible(on: boolean): void {
    this.visible = on;
    this.el.classList.toggle('hidden', !on);
    if (!on) this.reset();
    // idle aim: tap-mode aims at nothing until a finger lands
    this.input.aimNDC = null;
    this.input.aimOff = on && this.tapAim();
  }

  /** Forget the sneak latch (death, new world). */
  clearSneak(): void { this.sneakLatched = false; this.syncSneakKey(); }

  dispose(): void {
    this.setVisible(false);
    this.unsub();
    this.el.remove();
  }
}
