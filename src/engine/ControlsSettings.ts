// Persisted look sensitivity (mouse + touch drag). Values are multipliers on
// the engine defaults — 1.0 feels like the original game.

const KEY = 'voxelcraft-controls';

export interface ControlSettings {
  /** 0.5–2.0 multiplier on base mouse look speed */
  mouseSens: number;
  /** 0.6–2.2 multiplier on touch drag-to-look */
  touchLook: number;
}

const DEFAULTS: ControlSettings = { mouseSens: 1, touchLook: 1 };

let cached: ControlSettings | null = null;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function load(): ControlSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<ControlSettings>;
      return {
        mouseSens: clamp(p.mouseSens ?? DEFAULTS.mouseSens, 0.5, 2),
        touchLook: clamp(p.touchLook ?? DEFAULTS.touchLook, 0.6, 2.2),
      };
    }
  } catch { /* defaults */ }
  return { ...DEFAULTS };
}

export function getControls(): ControlSettings {
  if (!cached) cached = load();
  return cached;
}

export function setControls(partial: Partial<ControlSettings>): ControlSettings {
  const next = {
    mouseSens: clamp(partial.mouseSens ?? getControls().mouseSens, 0.5, 2),
    touchLook: clamp(partial.touchLook ?? getControls().touchLook, 0.6, 2.2),
  };
  cached = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
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
