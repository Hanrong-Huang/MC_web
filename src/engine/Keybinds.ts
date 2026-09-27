// Rebindable controls: named actions mapped to KeyboardEvent codes, persisted
// in localStorage. Input.held(action) / actionsFor(code) read through here, so
// no gameplay code hard-codes a key. Left/right modifiers are folded together
// by Input (ShiftRight arrives as ShiftLeft), so bindings store the Left code.

const KEY = 'voxelcraft-keybinds';

export type Action =
  | 'forward' | 'back' | 'left' | 'right' | 'jump' | 'sneak' | 'sprint'
  | 'inventory' | 'drop' | 'fly' | 'chat' | 'players' | 'advancements' | 'controls';

export interface ActionInfo { id: Action; label: string; def: string; group: 'Movement' | 'Gameplay' | 'Screens' }

/** Every rebindable action, in the order the Key Binds screen lists them.
 *  Sprint is unbound by default (double-tap forward sprints): vanilla's Ctrl
 *  would make Ctrl+W, which the browser reserves to close the tab. */
export const ACTIONS: ActionInfo[] = [
  { id: 'forward', label: 'Walk Forwards', def: 'KeyW', group: 'Movement' },
  { id: 'back', label: 'Walk Backwards', def: 'KeyS', group: 'Movement' },
  { id: 'left', label: 'Strafe Left', def: 'KeyA', group: 'Movement' },
  { id: 'right', label: 'Strafe Right', def: 'KeyD', group: 'Movement' },
  { id: 'jump', label: 'Jump', def: 'Space', group: 'Movement' },
  { id: 'sneak', label: 'Sneak', def: 'ShiftLeft', group: 'Movement' },
  { id: 'sprint', label: 'Sprint', def: '', group: 'Movement' },
  { id: 'fly', label: 'Toggle Flight', def: 'KeyF', group: 'Movement' },
  { id: 'drop', label: 'Drop Selected Item', def: 'KeyQ', group: 'Gameplay' },
  { id: 'chat', label: 'Open Chat', def: 'KeyT', group: 'Gameplay' },
  { id: 'players', label: 'List Players', def: 'Tab', group: 'Gameplay' },
  { id: 'inventory', label: 'Open Inventory', def: 'KeyE', group: 'Screens' },
  { id: 'advancements', label: 'Advancements', def: 'KeyL', group: 'Screens' },
  { id: 'controls', label: 'Controls Help', def: 'KeyH', group: 'Screens' },
];

/** Keys the game keeps for itself (menus, hotbar, debug) — not bindable. */
export const RESERVED = new Set(['Escape', 'F1', 'F2', 'F3', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9']);

export interface KeySettings {
  binds: Record<Action, string>;
  /** Sneak key toggles sneaking instead of having to be held (vanilla "Sneak: Toggle"). */
  sneakToggle: boolean;
}

function defaults(): KeySettings {
  const binds = {} as Record<Action, string>;
  for (const a of ACTIONS) binds[a.id] = a.def;
  return { binds, sneakToggle: false };
}

let cached: KeySettings | null = null;

function load(): KeySettings {
  const s = defaults();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<KeySettings>;
      for (const a of ACTIONS) {
        const c = p.binds?.[a.id];
        if (typeof c === 'string' && !RESERVED.has(c)) s.binds[a.id] = c;
      }
      s.sneakToggle = !!p.sneakToggle;
    }
  } catch { /* defaults */ }
  return s;
}

function save(): void {
  try { localStorage.setItem(KEY, JSON.stringify(keySettings())); } catch { /* storage blocked */ }
}

export function keySettings(): KeySettings {
  if (!cached) cached = load();
  return cached;
}

export function bindingFor(a: Action): string {
  return keySettings().binds[a];
}

/** Bind `a` to `code` ('' unbinds). Returns the actions that now share the key. */
export function setBinding(a: Action, code: string): Action[] {
  if (RESERVED.has(code)) return [];
  keySettings().binds[a] = code;
  save();
  return code ? ACTIONS.filter((x) => x.id !== a && bindingFor(x.id) === code).map((x) => x.id) : [];
}

export function resetBindings(): void {
  const d = defaults();
  keySettings().binds = d.binds;
  save();
}

export function setSneakToggle(on: boolean): void {
  keySettings().sneakToggle = on;
  save();
}

/** Actions bound to a key code (several if the player doubled a key up). */
export function actionsFor(code: string): Action[] {
  const b = keySettings().binds;
  return ACTIONS.filter((a) => b[a.id] === code).map((a) => a.id);
}

/** Short on-screen name for a key code: 'KeyW' → 'W', 'ShiftLeft' → 'Shift'. */
export function keyLabel(code: string): string {
  if (!code) return 'Not bound';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  if (code.startsWith('Arrow')) return `${code.slice(5)} Arrow`;
  const named: Record<string, string> = {
    ShiftLeft: 'Shift', ControlLeft: 'Ctrl', AltLeft: 'Alt', MetaLeft: 'Meta', Space: 'Space',
    CapsLock: 'Caps Lock', Tab: 'Tab', Enter: 'Enter', Backspace: 'Backspace', Backquote: '`',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';',
    Quote: "'", Comma: ',', Period: '.', Slash: '/',
  };
  return named[code] ?? code;
}

/** Fold right-hand modifiers onto the left code so one binding covers both. */
export function normalizeCode(code: string): string {
  switch (code) {
    case 'ShiftRight': return 'ShiftLeft';
    case 'ControlRight': return 'ControlLeft';
    case 'AltRight': return 'AltLeft';
    case 'MetaRight': return 'MetaLeft';
    default: return code;
  }
}
