// Persisted control settings: look sensitivity (mouse + touch drag) and the
// touch layout options (Options → Touch Controls). Sensitivities are
// multipliers on the engine defaults — 1.0 feels like the original game.

const KEY = 'voxelcraft-controls';

/** Touch movement control: a floating analog stick or Pocket Edition's D-pad. */
export type TouchScheme = 'joystick' | 'dpad';
/** Where a touch acts: at the finger (Bedrock default) or at the crosshair (split controls). */
export type TouchAim = 'tap' | 'crosshair';

export interface ControlSettings {
  /** 0.5–2.0 multiplier on base mouse look speed */
  mouseSens: number;
  /** 0.6–2.2 multiplier on touch drag-to-look */
  touchLook: number;
  touchScheme: TouchScheme;
  touchAim: TouchAim;
  /** 0.7–1.5 size of the on-screen buttons */
  touchSize: number;
  /** 0.25–1 opacity of the on-screen buttons */
  touchOpacity: number;
  /** hop single-block steps while walking into them (touch) */
  autoJump: boolean;
  /** go fullscreen (and lock landscape where allowed) on the first touch in a world */
  fullscreen: boolean;
}

const DEFAULTS: ControlSettings = {
  mouseSens: 1, touchLook: 1,
  touchScheme: 'joystick', touchAim: 'tap', touchSize: 1, touchOpacity: 0.7,
  autoJump: true, fullscreen: true,
};

let cached: ControlSettings | null = null;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function sanitize(p: Partial<ControlSettings>, base: ControlSettings): ControlSettings {
  const num = (v: unknown, d: number): number => (typeof v === 'number' && isFinite(v) ? v : d);
  return {
    mouseSens: clamp(num(p.mouseSens, base.mouseSens), 0.5, 2),
    touchLook: clamp(num(p.touchLook, base.touchLook), 0.6, 2.2),
    touchScheme: p.touchScheme === 'dpad' || p.touchScheme === 'joystick' ? p.touchScheme : base.touchScheme,
    touchAim: p.touchAim === 'crosshair' || p.touchAim === 'tap' ? p.touchAim : base.touchAim,
    touchSize: clamp(num(p.touchSize, base.touchSize), 0.7, 1.5),
    touchOpacity: clamp(num(p.touchOpacity, base.touchOpacity), 0.25, 1),
    autoJump: typeof p.autoJump === 'boolean' ? p.autoJump : base.autoJump,
    fullscreen: typeof p.fullscreen === 'boolean' ? p.fullscreen : base.fullscreen,
  };
}

function load(): ControlSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return sanitize(JSON.parse(raw) as Partial<ControlSettings>, DEFAULTS);
  } catch { /* defaults */ }
  return { ...DEFAULTS };
}

export function getControls(): ControlSettings {
  if (!cached) cached = load();
  return cached;
}

/** Listeners re-applied when a setting changes (the touch overlay restyles itself). */
const listeners: Array<(s: ControlSettings) => void> = [];
export function onControlsChange(fn: (s: ControlSettings) => void): () => void {
  listeners.push(fn);
  return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
}

export function setControls(partial: Partial<ControlSettings>): ControlSettings {
  const next = sanitize(partial, getControls());
  cached = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
  for (const fn of [...listeners]) fn(next);
  return next;
}

export const BASE_MOUSE_SENS = 0.0023;
export const BASE_TOUCH_LOOK = 1.3;

export function mouseLookSens(): number {
  return BASE_MOUSE_SENS * getControls().mouseSens;
}

export function touchLookSens(): number {
  return BASE_TOUCH_LOOK * getControls().touchLook;
}
