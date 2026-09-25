// All DOM UI: title screen (parallax backdrop, block logo, world cards), loading
// screen, pause + options menus, crosshair, hotbar, hearts/hunger/armor/air,
// F3 debug overlay, death screen, toasts, tooltips, and the container screens
// (player 2x2 crafting, 3x3 crafting table, furnace, chest, trades, creative)
// with full cursor-stack slot interactions and a side-panel recipe book.

import { Atlas } from '../engine/Textures';
import { Inventory, Slot, matchRecipe, FurnaceState, ChestState, SMELT_TIME, allRecipes, RecipeView } from '../engine/Inventory';
import { def, CREATIVE_ITEMS, I, B, spriteNameFor, mobLabel } from '../engine/Blocks';
import { SaveSummary, SlotData } from '../engine/Persistence';
import { AudioEngine, SfxName, MobVoice } from '../engine/Audio';
import type { GameMode } from '../engine/Player';
import { isTouchDevice } from './TouchControls';
import {
  pixelText, scaled, countCanvas, drawLogo, heartIcon, shankIcon, armorIcon, bubbleIcon,
  GUI_ICONS, drawPlayerFigure, Fill,
} from './Pixel';
import { TitleBackdrop } from './TitleBackdrop';

export type ContainerKind = 'inventory' | 'table' | 'furnace' | 'chest' | 'creative' | 'trade';

export interface TradeOffer {
  give: number; giveCount: number;
  get: number; getCount: number;
  uses: number; max: number;
}

export interface ContainerView {
  kind: ContainerKind;
  craftW: number;          // 2 or 3 (0 if none)
  craftGrid: Slot[];
  furnace: FurnaceState | null;
  chest: ChestState | null;
  /** villager trade offers (kind === 'trade') */
  trades: TradeOffer[];
}

export interface MenuHandlers {
  onPlay: (slot: string, fresh: { seed: number; mode: GameMode } | null) => void;
  onDelete: (slot: string) => void;
  onPack: (files: File[]) => void;
  /** download a saved world as a portable .json file */
  onExport: (slot: string) => void;
  /** import a previously exported world file */
  onImport: (file: File) => void;
}

export interface PauseHandlers {
  onResume: () => void;
  onSave: () => Promise<boolean>;
  onSaveQuit: () => void;
  onToggleMode: () => void;
  onViewDist: (n: number) => void;
  onToggleMusic: () => void;
  onToggleSound: () => void;
  musicOn: () => boolean;
  soundOn: () => boolean;
  onPack: (files: File[]) => void;
  onMouseSens: (mult: number) => void;
  onTouchLook: (mult: number) => void;
  mouseSens: () => number;
  touchLook: () => number;
}

/** Client-side display preferences (persisted in localStorage). */
export interface UiSettings {
  /** base field of view in degrees (sprinting adds ~10) */
  fov: number;
  /** 0 = auto, 1 = small, 2 = normal, 3 = large */
  gui: number;
  /** camera bob while walking */
  bob: boolean;
  /** small FPS readout in the corner */
  fps: boolean;
  /** recipe book panel open next to crafting grids */
  book: boolean;
  /** captions for sounds, bottom-right (accessibility) */
  subs: boolean;
}

const UI_KEY = 'voxelcraft.ui';
const UI_DEFAULTS: UiSettings = { fov: 70, gui: 0, bob: true, fps: false, book: true, subs: false };
const GUI_NAMES = ['Auto', 'Small', 'Normal', 'Large'];

function loadUiSettings(): UiSettings {
  try {
    const raw = localStorage.getItem(UI_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<UiSettings>;
      return {
        fov: typeof p.fov === 'number' ? Math.max(50, Math.min(110, p.fov)) : UI_DEFAULTS.fov,
        gui: typeof p.gui === 'number' ? Math.max(0, Math.min(3, p.gui | 0)) : UI_DEFAULTS.gui,
        bob: typeof p.bob === 'boolean' ? p.bob : UI_DEFAULTS.bob,
        fps: typeof p.fps === 'boolean' ? p.fps : UI_DEFAULTS.fps,
        book: typeof p.book === 'boolean' ? p.book : UI_DEFAULTS.book,
        subs: typeof p.subs === 'boolean' ? p.subs : UI_DEFAULTS.subs,
      };
    }
  } catch { /* private mode / corrupt value: fall back to defaults */ }
  return { ...UI_DEFAULTS };
}

type RecipeFilter = 'all' | 'ready' | 'tools' | 'blocks' | 'food' | 'utility';
type CreativeTab = 'all' | 'blocks' | 'tools' | 'food' | 'utility' | 'inventory';

const SPLASHES = [
  'Made in TypeScript!', 'Zero asset files!', '100% procedural!', 'Now with beds!', 'Punch a tree!',
  'Also try the Nether!', 'Creepers go boom!', 'Tame a wolf!', 'Every pixel is code!', 'Diamonds!',
  'Watch out for lava!', 'Sleep through the night!', 'Pets fight back!', 'Three.js powered!',
  'Now with water physics!', 'Built from scratch!', 'Craft away!', 'Don\'t dig straight down!',
  'Blocky and proud!', 'Mind the skeletons!', 'Chunk by chunk!', 'Moo!', 'Villagers trade!',
];

const TIPS = [
  'Punch a tree to get wood, then craft planks and a crafting table.',
  'Hold Shift while clicking a slot to quick-move the whole stack.',
  'Hover a slot and press 1-9 to swap it with that hotbar slot.',
  'Sleep in a bed at night to skip to morning and set your spawn.',
  'Torches keep monsters from spawning nearby.',
  'Carry a compass to see the minimap; a clock shows the time.',
  'Right-click a wolf with a bone to tame it.',
  'Throw a mob catcher at a hostile mob to capture it as a pet.',
  'Double-tap W to sprint; sprinting drains hunger faster.',
  'Press F3 for coordinates and debug info.',
  'The recipe book fills the crafting grid for you - just click a recipe.',
  'Water cancels fall damage. Jump in!',
  'Build a 4x5 obsidian frame and light it to reach the Nether.',
  'Press L to see your advancements.',
];

/** Subtitle captions per sound effect (UI clicks are deliberately silent). */
const SFX_CAPTIONS: Partial<Record<SfxName, string>> = {
  pop: 'Item picked up', hurt: 'Player hurts', hit: 'Something hit', eat: 'Eating', burp: 'Burp',
  doorOpen: 'Door creaks', doorClose: 'Door closes', plateOn: 'Pressure plate clicks', plateOff: 'Pressure plate clicks',
  explode: 'Explosion', bow: 'Bow fires', snap: 'Item breaks', fuse: 'Fuse hisses', arrowHit: 'Arrow hits',
  whoosh: 'Whoosh', lowdur: 'Tool is wearing out', thunder: 'Thunder roars', splash: 'Splash', hoof: 'Hooves clop',
  mount: 'Saddle equips', submerge: 'Splash', emerge: 'Splash', chestOpen: 'Chest opens', chestClose: 'Chest closes',
  advancement: 'Advancement made', equip: 'Gear equips', lavaPop: 'Lava pops', bubble: 'Bubbles',
};
const MOB_VERBS: Record<string, string> = {
  zombie: 'groans', skeleton: 'rattles', spider: 'hisses', creeper: 'hisses', cow: 'moos', pig: 'oinks',
  sheep: 'baas', chicken: 'clucks', wolf: 'pants', cat: 'meows', horse: 'neighs', villager: 'mumbles',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

/** "3 minutes ago"-style relative time for world cards. */
function timeAgo(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  const fmt = (n: number, u: string): string => `${n} ${u}${n === 1 ? '' : 's'} ago`;
  if (s < 60) return 'just now';
  if (s < 3600) return fmt(Math.floor(s / 60), 'minute');
  if (s < 86400) return fmt(Math.floor(s / 3600), 'hour');
  if (s < 86400 * 30) return fmt(Math.floor(s / 86400), 'day');
  return new Date(ms).toLocaleDateString();
}

/** Hovered player slot, for 1-9 hotbar swaps and Q drops. */
interface HoverSlot { arr: Slot[]; i: number }

export class HUD {
  private root: HTMLElement;
  private atlas: Atlas;
  private audio: AudioEngine;

  readonly settings: UiSettings = loadUiSettings();

  private menu: HTMLElement;
  private backdrop: TitleBackdrop | null = null;
  private splashEl: HTMLElement | null = null;
  private hud: HTMLElement;
  private bottomEl: HTMLElement;
  private hotbarEl: HTMLElement;
  private armorEl: HTMLElement;
  private heartsEl: HTMLElement;
  private hungerEl: HTMLElement;
  private airEl!: HTMLElement;
  private itemNameEl!: HTMLElement;
  private itemNameTimer: ReturnType<typeof setTimeout> | null = null;
  private statsEl: HTMLElement;
  private debugEl: HTMLElement;
  private fpsEl: HTMLElement;
  private minimapEl: HTMLElement;
  private minimapCanvas: HTMLCanvasElement;
  private compassEl: HTMLElement;
  private clockEl: HTMLElement;
  private pauseEl: HTMLElement;
  private deathEl: HTMLElement;
  private containerEl: HTMLElement;
  private loadingEl: HTMLElement;
  private loadFill: HTMLElement | null = null;
  private loadPct: HTMLElement | null = null;
  private loadCells: HTMLElement[] = [];
  private loadTipTimer: ReturnType<typeof setInterval> | null = null;
  private toastEl: HTMLElement;
  private cursorEl: HTMLElement;
  private tooltipEl!: HTMLElement;
  private vignette: HTMLElement;
  private lowhpEl!: HTMLElement;
  private crosshairEl!: HTMLElement;
  private hitmarkerEl!: HTMLElement;
  private dmgNums: HTMLElement[] = [];
  private sleepEl!: HTMLElement;
  private sleepPromptEl!: HTMLElement;
  private petsEl!: HTMLElement;
  /** last rendered pet roster signature (skips per-frame DOM rebuilds) */
  private petSig = '';
  private portalEl!: HTMLElement;
  private netherTintEl!: HTMLElement;
  private lowHealthEl!: HTMLElement;
  private packInput: HTMLInputElement;
  private worldInput: HTMLInputElement;

  cursor: Slot = null;
  private view: ContainerView | null = null;
  private inv: Inventory | null = null;
  private viewMode: GameMode = 'survival';
  private furnaceSnapshot = '';
  private lastHearts = '';
  private lastHp = -1;
  private hurtUntil = 0;
  private lastHotbarSel = -1;
  private hoverSlot: HoverSlot | null = null;
  private recipeFilter: RecipeFilter = 'all';
  private recipeSearchQuery = '';
  private recipeSearchFocused = false;
  private creativeFilter: CreativeTab = 'all';
  private creativeSearchQuery = '';
  private creativeSearchFocused = false;
  private confirmEl: HTMLElement;
  private confirmKey: ((e: KeyboardEvent) => void) | null = null;
  private pauseBuilt = false;
  private pauseH: PauseHandlers | null = null;
  private pauseMode: GameMode = 'survival';
  private pauseViewDist = 8;
  private pauseMainEl: HTMLElement | null = null;
  private pauseOptsEl: HTMLElement | null = null;
  private pauseSyncers: Array<() => void> = [];
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private subsEl: HTMLElement;
  private subRows = new Map<string, { el: HTMLElement; t: number }>();
  private fpsFrames = 0;
  private fpsT0 = 0;
  private deathTimer: ReturnType<typeof setTimeout> | null = null;
  private packHandler: (files: File[]) => void = () => {};
  private importHandler: (file: File) => void = () => {};
  /** main sets this: leftover items that can't return to the inventory drop here */
  onDropLeftover: (id: number, count: number) => void = () => {};
  /** fired when the player takes a crafting result */
  onCraft: (id: number) => void = () => {};
  /** fired when the player completes a villager trade */
  onTrade: () => void = () => {};

  constructor(root: HTMLElement, atlas: Atlas, audio: AudioEngine) {
    this.root = root;
    this.atlas = atlas;
    this.audio = audio;

    this.menu = el('div', 'hidden', root);
    this.menu.id = 'menu';

    this.hud = el('div', 'hidden', root);
    this.hud.id = 'hud';
    const cross = el('div', '', this.hud); cross.id = 'crosshair';
    this.crosshairEl = cross;
    const hm = el('div', '', this.hud); hm.id = 'hitmarker';
    this.hitmarkerEl = hm;
    // bottom-centre cluster (item name, stat rows, hotbar) scales as one unit
    this.bottomEl = el('div', '', this.hud); this.bottomEl.id = 'hud-bottom';
    this.itemNameEl = el('div', '', this.bottomEl); this.itemNameEl.id = 'item-name';
    this.statsEl = el('div', '', this.bottomEl); this.statsEl.id = 'stats';
    this.armorEl = el('div', 'stat-row', this.statsEl); this.armorEl.id = 'armor-bar';
    this.airEl = el('div', 'stat-row', this.statsEl); this.airEl.id = 'air';
    this.heartsEl = el('div', 'stat-row', this.statsEl); this.heartsEl.id = 'hearts';
    this.hungerEl = el('div', 'stat-row', this.statsEl); this.hungerEl.id = 'hunger';
    this.hotbarEl = el('div', '', this.bottomEl); this.hotbarEl.id = 'hotbar';
    this.debugEl = el('div', 'hidden', this.hud); this.debugEl.id = 'debug';
    this.fpsEl = el('div', 'hidden', this.hud); this.fpsEl.id = 'fps';
    this.subsEl = el('div', '', this.hud); this.subsEl.id = 'subtitles';
    this.subsEl.setAttribute('aria-live', 'polite');

    // minimap: small canvas top-right showing nearby terrain + facing arrow
    this.minimapEl = el('div', 'minimap', this.hud);
    this.minimapCanvas = el('canvas') as HTMLCanvasElement;
    this.minimapCanvas.width = 96; this.minimapCanvas.height = 96;
    this.minimapEl.appendChild(this.minimapCanvas);
    // compass + clock readouts below the minimap
    this.compassEl = el('div', 'compass-readout', this.minimapEl);
    this.clockEl = el('div', 'clock-readout', this.minimapEl);

    this.lowhpEl = el('div', '', root); this.lowhpEl.id = 'lowhp';
    this.vignette = el('div', '', root); this.vignette.id = 'vignette';
    this.sleepEl = el('div', '', root); this.sleepEl.id = 'sleep-fade';
    this.sleepPromptEl = el('div', 'hidden', root); this.sleepPromptEl.id = 'sleep-prompt';
    this.petsEl = el('div', 'hidden', root); this.petsEl.id = 'pet-strip';
    this.portalEl = el('div', '', root); this.portalEl.id = 'portal-fade';
    this.netherTintEl = el('div', '', root); this.netherTintEl.id = 'nether-tint';
    this.lowHealthEl = el('div', '', root); this.lowHealthEl.id = 'low-health';
    this.pauseEl = el('div', 'overlay hidden', root); this.pauseEl.id = 'pause-overlay';
    this.deathEl = el('div', 'overlay hidden', root); this.deathEl.id = 'death-overlay';
    this.containerEl = el('div', 'overlay hidden', root); this.containerEl.id = 'container-screen';
    this.loadingEl = el('div', 'overlay hidden', root); this.loadingEl.id = 'loading';
    this.toastEl = el('div', '', root); this.toastEl.id = 'toast';
    this.toastEl.setAttribute('role', 'status');
    this.toastEl.setAttribute('aria-live', 'polite');
    this.cursorEl = el('div', 'hidden', root); this.cursorEl.id = 'cursor-item';
    this.tooltipEl = el('div', 'hidden', root); this.tooltipEl.id = 'item-tooltip';

    this.confirmEl = el('div', 'overlay hidden', root);
    this.confirmEl.id = 'confirm-overlay';

    this.minimapEl.classList.add('hidden');

    this.packInput = el('input') as HTMLInputElement;
    this.packInput.type = 'file';
    this.packInput.multiple = true;
    this.packInput.setAttribute('webkitdirectory', '');
    this.packInput.style.display = 'none';
    root.appendChild(this.packInput);
    this.packInput.addEventListener('change', () => {
      const files = this.packInput.files ? [...this.packInput.files] : [];
      if (files.length) this.packHandler(files);
      this.packInput.value = '';
    });

    this.worldInput = el('input') as HTMLInputElement;
    this.worldInput.type = 'file';
    this.worldInput.accept = 'application/json,.json,.vcworld';
    this.worldInput.style.display = 'none';
    root.appendChild(this.worldInput);
    this.worldInput.addEventListener('change', () => {
      const file = this.worldInput.files?.[0];
      if (file) this.importHandler(file);
      this.worldInput.value = '';
    });

    // the held "cursor" item follows the pointer (pointermove covers touch-drag
    // too, so on a phone you can see the stack you've picked up)
    const followCursor = (x: number, y: number): void => {
      this.cursorEl.style.left = `${x - 18}px`;
      this.cursorEl.style.top = `${y - 18}px`;
    };
    document.addEventListener('mousemove', (e) => followCursor(e.clientX, e.clientY));
    document.addEventListener('pointermove', (e) => followCursor(e.clientX, e.clientY));
    this.followCursor = followCursor;

    // container hotkeys: 1-9 swaps the hovered slot with that hotbar slot, Q
    // drops one (Ctrl+Q the stack) — both straight out of vanilla
    document.addEventListener('keydown', (e) => this.containerKey(e));

    this.hookSubtitles();

    // procedural button grain (a faint stone noise) shared by every .mc-btn
    document.documentElement.style.setProperty('--btn-noise', `url(${this.noiseTile()})`);
    this.applyGuiScale();
    window.addEventListener('resize', () => this.applyGuiScale());
  }

  private followCursor: (x: number, y: number) => void = () => {};

  /** A 32x32 greyscale noise tile, used as a subtle texture on buttons. */
  private noiseTile(): string {
    const c = document.createElement('canvas');
    c.width = 32; c.height = 32;
    const ctx = c.getContext('2d')!;
    let s = 1234567;
    for (let y = 0; y < 32; y += 2) {
      for (let x = 0; x < 32; x += 2) {
        s = (Math.imul(s, 1103515245) + 12345) >>> 0;
        const v = (s >>> 24) / 255;
        ctx.fillStyle = v > 0.5 ? `rgba(255,255,255,${(v - 0.5) * 0.16})` : `rgba(0,0,0,${(0.5 - v) * 0.2})`;
        ctx.fillRect(x, y, 2, 2);
      }
    }
    return c.toDataURL();
  }

  // =========================================================================
  // Settings
  // =========================================================================

  private saveSettings(): void {
    try { localStorage.setItem(UI_KEY, JSON.stringify(this.settings)); } catch { /* storage blocked */ }
  }

  private guiScaleValue(): number {
    const g = this.settings.gui;
    if (g === 1) return 0.8;
    if (g === 2) return 1;
    if (g === 3) return 1.25;
    // auto: shrink on short screens (landscape phones), grow on big monitors
    const h = window.innerHeight, w = window.innerWidth;
    if (h < 460 || w < 420) return 0.8;
    if (h < 640) return 0.9;
    if (h > 1150 && w > 1700) return 1.25;
    return 1;
  }

  private applyGuiScale(): void {
    document.documentElement.style.setProperty('--gui', String(this.guiScaleValue()));
  }

  // =========================================================================
  // Main menu
  // =========================================================================

  showMenu(saves: SaveSummary[], handlers: MenuHandlers): void {
    this.menu.classList.remove('hidden');
    this.menu.innerHTML = '';
    // dirt fallback behind the live backdrop (and for reduced-motion users)
    const dirtURL = this.atlas.tileCanvas('dirt').toDataURL();
    this.menu.style.backgroundImage = `linear-gradient(rgba(0,0,0,0.62), rgba(0,0,0,0.62)), url(${dirtURL})`;
    this.menu.style.backgroundSize = 'auto, 64px 64px';
    if (!this.backdrop) this.backdrop = new TitleBackdrop(this.atlas);
    this.backdrop.mount(this.menu);

    const inner = el('div', 'menu-inner', this.menu);

    // --- logo + pulsing splash ---------------------------------------------
    const logoWrap = el('div', 'menu-logo-wrap', inner);
    let stone: HTMLCanvasElement | null = null;
    try { stone = this.atlas.tileCanvas('stone'); } catch { /* resource pack without stone */ }
    // integer block size keeps the logo's pixels even: bigger on big screens
    const big = window.innerWidth >= 1600 && window.innerHeight >= 950;
    const logo = drawLogo('Voxelcraft', stone, big ? 12 : 8);
    logo.style.width = `${logo.width}px`;
    logoWrap.appendChild(logo);
    const title = el('h1', 'menu-title sr-only', logoWrap);
    title.textContent = 'VOXELCRAFT';
    this.splashEl = el('div', 'menu-splash', logoWrap);
    this.splashEl.textContent = SPLASHES[Math.floor(Math.random() * SPLASHES.length)];
    const sub = el('div', 'menu-sub', inner);
    sub.textContent = 'TypeScript + Three.js, from scratch!';

    // attach UI sounds: a soft tick on hover, a click on press
    const wire = <T extends HTMLElement>(b: T): T => {
      b.addEventListener('mouseenter', () => this.audio.play('select'));
      b.addEventListener('mousedown', () => { this.audio.ensure(); this.audio.play('click'); });
      return b;
    };

    const col = el('div', `menu-col menu-grid${saves.length ? '' : ' no-worlds'}`, inner);

    // --- existing worlds ------------------------------------------------------
    const worldsCard = el('div', 'menu-card worlds-card', col);
    const listHead = el('div', 'card-head', worldsCard);
    listHead.textContent = `Select World${saves.length ? `  (${saves.length})` : ''}`;
    const list = el('div', 'world-list', worldsCard);
    list.setAttribute('role', 'list');
    const sorted = [...saves].sort((a, b) => b.lastPlayed - a.lastPlayed);
    if (sorted.length === 0) {
      const empty = el('div', 'world-empty', list);
      const ic = this.atlas.icon(B.GRASS);
      const c = document.createElement('canvas');
      c.width = 32; c.height = 32; c.className = 'pix';
      c.getContext('2d')!.drawImage(ic, 0, 0);
      empty.appendChild(c);
      el('div', '', empty).textContent = 'No worlds yet - create your first one!';
    }
    for (const info of sorted) {
      const row = el('div', 'world-row', list);
      row.tabIndex = 0;
      row.setAttribute('role', 'listitem');
      const creative = info.gameMode === 'creative';
      const icon = el('div', `wicon${creative ? ' creative' : ''}`, row);
      const ic = document.createElement('canvas');
      ic.width = 32; ic.height = 32; ic.className = 'pix';
      ic.getContext('2d')!.drawImage(this.atlas.icon(creative ? B.DIAMOND_BLOCK : B.GRASS), 0, 0);
      icon.appendChild(ic);
      const name = el('div', 'wname', row);
      name.textContent = info.slot;
      const meta = el('span', 'wmeta', name);
      const modeTag = el('span', `wmode ${creative ? 'creative' : 'survival'}`, meta);
      modeTag.textContent = creative ? 'Creative' : 'Survival';
      meta.append(` · ${timeAgo(info.lastPlayed)}`);
      const seedLine = el('span', 'wmeta wseed', name);
      seedLine.textContent = `Seed ${info.seed}`;
      const btns = el('div', 'wbtns', row);
      const play = wire(el('button', 'mc-btn small play-btn', btns));
      play.textContent = 'Play';
      play.onclick = () => { this.audio.ensure(); handlers.onPlay(info.slot, null); };
      const exp = wire(el('button', 'mc-btn small', btns));
      exp.textContent = 'Export';
      exp.title = 'Download this world as a .json file you can re-import elsewhere';
      exp.onclick = () => handlers.onExport(info.slot);
      const del = wire(el('button', 'mc-btn small danger', btns));
      del.textContent = 'Delete';
      const askDelete = (): void => {
        this.showConfirm(
          `Are you sure you want to delete "${info.slot}"?`,
          () => handlers.onDelete(info.slot),
          { title: 'Delete World', yes: 'Delete', detail: 'It will be lost forever! (A long time!)' },
        );
      };
      del.onclick = askDelete;
      // keyboard + double-click: Enter/double-click plays, Delete asks to delete
      row.addEventListener('dblclick', (e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        this.audio.ensure(); handlers.onPlay(info.slot, null);
      });
      row.addEventListener('keydown', (e) => {
        if (e.target !== row) return;
        if (e.key === 'Enter') { e.preventDefault(); this.audio.ensure(); handlers.onPlay(info.slot, null); }
        else if (e.key === 'Delete') { e.preventDefault(); askDelete(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); (row.nextElementSibling as HTMLElement | null)?.focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); (row.previousElementSibling as HTMLElement | null)?.focus(); }
      });
    }

    // --- create a new world ---------------------------------------------------
    let mode: GameMode = 'survival';
    const create = el('div', 'menu-card create-card', col);
    const ch = el('div', 'card-head', create); ch.textContent = 'Create New World';
    const used = new Set(saves.map((s) => s.slot));
    let next = 1; while (used.has(`World ${next}`)) next++;
    const nameLbl = el('label', 'field-label', create); nameLbl.textContent = 'World Name';
    const nameInput = el('input', 'menu-input', create) as HTMLInputElement;
    nameInput.type = 'text'; nameInput.maxLength = 32; nameInput.placeholder = `World ${next}`;
    nameInput.id = 'new-world-name'; nameLbl.htmlFor = nameInput.id;
    const seedLbl = el('label', 'field-label', create); seedLbl.textContent = 'Seed';
    const seedInput = el('input', 'menu-input', create) as HTMLInputElement;
    seedInput.type = 'text'; seedInput.placeholder = 'Leave blank for a random seed';
    seedInput.id = 'new-world-seed'; seedLbl.htmlFor = seedInput.id;
    const modeLbl = el('div', 'field-label', create); modeLbl.textContent = 'Game Mode';
    const modePick = el('div', 'mode-pick', create);
    modePick.setAttribute('role', 'radiogroup');
    const modeDesc = el('div', 'mode-desc', create);
    const describe = (): void => {
      modeDesc.textContent = mode === 'survival'
        ? 'Search for resources, craft, gain health and hunger. Mobs come out at night.'
        : 'Unlimited resources, free flying and instant breaking.';
    };
    const mkMode = (m: GameMode, label: string): HTMLButtonElement => {
      const b = wire(el('button', `mc-btn small${m === mode ? ' on' : ''}`, modePick));
      b.textContent = label;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(m === mode));
      b.onclick = () => {
        mode = m;
        modePick.querySelectorAll('.mc-btn').forEach((x) => { x.classList.remove('on'); x.setAttribute('aria-checked', 'false'); });
        b.classList.add('on');
        b.setAttribute('aria-checked', 'true');
        describe();
      };
      return b;
    };
    mkMode('survival', 'Survival');
    mkMode('creative', 'Creative');
    describe();
    const createBtn = wire(el('button', 'mc-btn create-btn', create));
    createBtn.textContent = 'Create New World';
    createBtn.onclick = () => {
      this.audio.ensure();
      let name = nameInput.value.trim() || `World ${next}`;
      if (used.has(name)) { let k = 2; while (used.has(`${name} (${k})`)) k++; name = `${name} (${k})`; }
      const raw = seedInput.value.trim();
      let seed: number;
      if (!raw) seed = (Math.random() * 0x7fffffff) | 0;
      else if (/^-?\d+$/.test(raw)) seed = parseInt(raw, 10) | 0;
      else { seed = 0; for (const ch of raw) seed = (Math.imul(seed, 31) + ch.charCodeAt(0)) | 0; }
      handlers.onPlay(name, { seed, mode });
    };
    for (const inp of [nameInput, seedInput]) {
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); createBtn.click(); } });
    }

    const toolRow = el('div', 'menu-row menu-tools', inner);
    const packBtn = wire(el('button', 'mc-btn small', toolRow));
    packBtn.textContent = 'Texture Pack…';
    packBtn.title = 'Apply an unzipped Minecraft Java texture-pack FOLDER (changes how blocks look — not a world or seed)';
    packBtn.onclick = () => { this.packHandler = handlers.onPack; this.packInput.click(); };
    const importBtn = wire(el('button', 'mc-btn small', toolRow));
    importBtn.textContent = 'Import World (.json)…';
    importBtn.title = 'Load a world .json FILE exported with the Export button (here or from another machine)';
    importBtn.onclick = () => { this.importHandler = handlers.onImport; this.worldInput.click(); };

    // concise control hints (full details live in F3 / tooltips)
    const help = el('div', 'menu-help', inner);
    if (isTouchDevice()) {
      help.innerHTML =
        '<b>Left stick</b> move · <b>Drag right</b> look · <b>Jump / Sneak</b> buttons<br>' +
        '<b>Dig</b> break · <b>Place</b> use · tap hotbar to switch · <b>Pause</b> top-left';
    } else {
      help.innerHTML =
        '<b>WASD</b> move · <b>Space</b> jump · <b>Shift</b> sprint · <b>F</b> fly · <b>E</b> inventory<br>' +
        '<b>LMB</b> break · <b>RMB</b> place / use · <b>1–9</b> + scroll hotbar · <b>Esc</b> pause';
    }

    const foot = el('div', 'menu-foot', this.menu);
    el('span', '', foot).textContent = 'Voxelcraft';
    el('span', '', foot).textContent = 'Every texture, sound & world is generated in code.';

    // retire the index.html boot splash once the real title screen exists
    const boot = document.getElementById('boot');
    if (boot) { boot.style.opacity = '0'; boot.style.pointerEvents = 'none'; setTimeout(() => boot.remove(), 350); }
  }

  hideMenu(): void {
    this.menu.classList.add('hidden');
    this.backdrop?.unmount();
  }

  // =========================================================================
  // In-game HUD
  // =========================================================================

  showGameUI(): void { this.hud.classList.remove('hidden'); }
  hideGameUI(): void {
    this.hud.classList.add('hidden');
    this.pauseEl.classList.add('hidden');
    this.deathEl.classList.add('hidden');
    this.containerEl.classList.add('hidden');
    this.cursorEl.classList.add('hidden');
    this.hideTooltip();
    this.hideAdvancements();
  }

  /** Tapping a hotbar slot selects it (mobile-friendly; harmless on desktop). */
  onHotbarSelect: (i: number) => void = () => {};
  /** Close button on a container panel (so touch devices can close it). */
  onCloseContainer: () => void = () => {};

  refreshHotbar(inv: Inventory, mode: GameMode): void {
    const selChanged = inv.selected !== this.lastHotbarSel;
    this.lastHotbarSel = inv.selected;
    this.hotbarEl.innerHTML = '';
    for (let i = 0; i < 9; i++) {
      const picked = selChanged && i === inv.selected;
      const s = el('div', `hotbar-slot${i === inv.selected ? ' selected' : ''}${picked ? ' picked' : ''}`, this.hotbarEl);
      const item = inv.slots[i];
      if (item) {
        s.appendChild(this.iconCanvas(item));
        if (item.count > 1 && mode !== 'creative') this.countEl(s, item.count);
      }
      s.addEventListener('pointerdown', (e) => { e.preventDefault(); this.onHotbarSelect(i); });
    }
  }

  private countEl(parent: HTMLElement, n: number): void {
    const c = el('span', 'slot-count', parent);
    c.setAttribute('aria-label', String(n));
    c.appendChild(countCanvas(n));
  }

  updateStats(hp: number, hunger: number, air: number, mode: GameMode, armor = 0): void {
    this.tickFps();
    this.tickSubtitles();
    this.hud.classList.toggle('creative', mode === 'creative');
    if (mode === 'creative') {
      this.statsEl.style.visibility = 'hidden';
      this.hungerEl.classList.remove('shake');
      this.lastHp = -1;
      return;
    }
    this.statsEl.style.visibility = 'visible';
    this.hungerEl.classList.toggle('shake', hunger > 0 && hunger <= 6);
    this.heartsEl.classList.toggle('low', hp > 0 && hp <= 4);
    const now = performance.now();
    // damage feedback: red edge flash + hearts blinking white (vanilla's hurt blink)
    if (this.lastHp >= 0 && hp < this.lastHp) {
      this.hurtUntil = now + 900;
      this.vignette.classList.remove('flash');
      void this.vignette.offsetWidth;
      this.vignette.classList.add('flash');
    }
    this.lastHp = hp;
    const blink = now < this.hurtUntil && Math.floor((this.hurtUntil - now) / 120) % 2 === 0;
    const key = `${hp}|${hunger}|${air}|${armor}|${blink}`;
    if (key === this.lastHearts) return;
    this.lastHearts = key;
    this.armorEl.innerHTML = '';
    this.heartsEl.innerHTML = '';
    this.hungerEl.innerHTML = '';
    this.airEl.innerHTML = '';
    const fill = (v: number): Fill => (v >= 2 ? 'full' : v === 1 ? 'half' : 'empty');
    // armor bar (only shown when wearing armor); each icon = 2 defense points
    if (armor > 0) {
      for (let i = 0; i < 10; i++) this.armorEl.appendChild(armorIcon(fill(armor - i * 2)));
    }
    for (let i = 0; i < 10; i++) {
      this.heartsEl.appendChild(heartIcon(fill(hp - i * 2), blink));
      this.hungerEl.appendChild(shankIcon(fill(hunger - i * 2)));
    }
    // air bubbles only while submerged / recovering (popped ones read as empty)
    if (air < 20) {
      const n = Math.ceil(air / 2);
      for (let i = 0; i < 10; i++) this.airEl.appendChild(bubbleIcon(i >= n));
    }
  }

  /** Rolling frames-per-second readout (only when enabled in Options). */
  private tickFps(): void {
    if (!this.settings.fps) {
      if (!this.fpsEl.classList.contains('hidden')) this.fpsEl.classList.add('hidden');
      return;
    }
    const now = performance.now();
    this.fpsFrames++;
    if (now - this.fpsT0 >= 500) {
      const fps = Math.round((this.fpsFrames * 1000) / Math.max(1, now - this.fpsT0));
      this.fpsEl.textContent = `${fps} fps`;
      this.fpsEl.classList.toggle('slow', fps < 30);
      this.fpsEl.classList.remove('hidden');
      this.fpsFrames = 0;
      this.fpsT0 = now;
    }
  }

  /** Wrap the audio engine's one-shot entry points so every audible effect can
   *  raise a caption (vanilla's Show Subtitles). The sound itself is untouched. */
  private hookSubtitles(): void {
    const a = this.audio;
    const play = a.play.bind(a);
    a.play = (name: SfxName, vol = 1): void => {
      play(name, vol);
      const cap = SFX_CAPTIONS[name];
      if (cap && this.settings.subs && a.soundOn) this.subtitle(cap, 0);
    };
    const mob = a.mobSound.bind(a);
    a.mobSound = (kind: string, vol: number, variant: MobVoice = 'idle', pan = 0): void => {
      mob(kind, vol, variant, pan);
      if (!this.settings.subs || !a.soundOn || vol <= 0.05) return;
      const verb = variant === 'hurt' ? 'hurts' : variant === 'death' ? 'dies' : (MOB_VERBS[kind] ?? 'makes a noise');
      const who = mobLabel(kind);
      this.subtitle(`${who.charAt(0).toUpperCase()}${who.slice(1)} ${verb}`, pan);
    };
  }

  /** Add or refresh a caption row; pan < 0 = left of you, > 0 = right. */
  private subtitle(text: string, pan: number): void {
    let row = this.subRows.get(text);
    if (!row) {
      if (this.subRows.size >= 6) {
        const oldest = [...this.subRows.entries()].sort((x, y) => x[1].t - y[1].t)[0];
        oldest[1].el.remove(); this.subRows.delete(oldest[0]);
      }
      const e = el('div', 'sub-row', this.subsEl);
      row = { el: e, t: 0 };
      this.subRows.set(text, row);
    }
    row.el.innerHTML = '';
    el('span', 'sub-dir', row.el).textContent = pan < -0.25 ? '<' : '';
    el('span', 'sub-text', row.el).textContent = text;
    el('span', 'sub-dir', row.el).textContent = pan > 0.25 ? '>' : '';
    row.t = performance.now();
    row.el.style.opacity = '1';
  }

  /** Age captions: fade over ~3 s, then drop them. */
  private tickSubtitles(): void {
    if (this.subRows.size === 0) return;
    const now = performance.now();
    for (const [k, r] of this.subRows) {
      const age = (now - r.t) / 1000;
      if (age > 3 || !this.settings.subs) { r.el.remove(); this.subRows.delete(k); continue; }
      r.el.style.opacity = String(age < 1.5 ? 1 : 1 - (age - 1.5) / 1.5 * 0.75);
    }
  }

  /** Vanilla-style rarity colour for an item's name. */
  private itemAccent(id: number): string {
    const d = def(id);
    const n = d.name;
    if (id === I.MOB_CATCHER_FILLED) return '#ff55ff';                       // epic
    if (n.includes('diamond') || n.includes('emerald') || id === I.MOB_CATCHER || id === I.AMETHYST ||
        n.includes('obsidian') || n.includes('beacon')) return '#55ffff';    // rare
    if (n.includes('gold') || id === I.GOLDEN_CARROT || n.includes('glowstone') ||
        n.includes('quartz')) return '#ffff55';                              // uncommon
    return '#ffffff';
  }

  /** Item-name popup shown above the hotbar when the selection changes. */
  showItemName(label: string, id?: number): void {
    this.itemNameEl.textContent = label;
    this.itemNameEl.style.color = id !== undefined ? this.itemAccent(id) : '#fff';
    this.itemNameEl.classList.remove('show');
    void this.itemNameEl.offsetWidth;
    this.itemNameEl.classList.add('show');
    if (this.itemNameTimer) clearTimeout(this.itemNameTimer);
    this.itemNameTimer = setTimeout(() => this.itemNameEl.classList.remove('show'), 1800);
  }

  /** Sleep blackout, driven frame-by-frame from the game loop so getting out of
   *  bed early can cancel it mid-fade. 0 = clear, 1 = fully black. */
  setSleepFade(amount: number): void {
    const a = Math.max(0, Math.min(1, amount));
    this.sleepEl.style.opacity = String(a);
    this.sleepEl.classList.toggle('instant', a > 0);
  }

  /** Hidden while lying in bed — nothing to aim at from the pillow. */
  setCrosshairVisible(v: boolean): void {
    this.crosshairEl.style.display = v ? '' : 'none';
  }

  /** Crosshair emphasis while aiming at a block, a mob, or mining. */
  updateCrosshair(mode: 'idle' | 'target' | 'breaking' | 'mob', breakFrac = 0): void {
    const cl = this.crosshairEl.classList;
    cl.toggle('on-target', mode !== 'idle');
    cl.toggle('breaking', mode === 'breaking');
    cl.toggle('on-mob', mode === 'mob');
    if (mode === 'breaking') {
      const s = 1 + Math.min(1, breakFrac) * 0.14;
      this.crosshairEl.style.transform = `translate(-50%, -50%) scale(${s})`;
      this.crosshairEl.style.setProperty('--break', `${Math.round(Math.min(1, breakFrac) * 100)}%`);
    } else {
      this.crosshairEl.style.transform = 'translate(-50%, -50%)';
      this.crosshairEl.style.setProperty('--break', '0%');
    }
  }

  /** "Sleeping…" banner with a Leave Bed button (vanilla's bed screen). */
  showSleepPrompt(onLeave: () => void): void {
    this.sleepPromptEl.innerHTML = '';
    el('div', 'sleep-zzz', this.sleepPromptEl).textContent = 'Zzz…';
    el('div', 'sleep-text', this.sleepPromptEl).textContent = 'Sleeping through the night';
    const btn = el('button', 'sleep-leave mc-btn', this.sleepPromptEl);
    btn.textContent = 'Leave Bed';
    btn.onclick = () => onLeave();
    this.sleepPromptEl.classList.remove('hidden');
  }

  hideSleepPrompt(): void {
    this.sleepPromptEl.classList.add('hidden');
    this.sleepPromptEl.innerHTML = '';
  }

  /** Roster strip for captured pets: icon + health pips + stay/fight state. */
  updatePets(pets: { kind: string; hp: number; maxHp: number; sitting: boolean; fighting: boolean }[]): void {
    if (pets.length === 0) {
      if (!this.petsEl.classList.contains('hidden')) {
        this.petsEl.classList.add('hidden');
        this.petsEl.innerHTML = '';
        this.petSig = '';
      }
      return;
    }
    const sig = pets.map((p) => `${p.kind}:${Math.ceil(p.hp)}/${p.maxHp}:${p.sitting}${p.fighting}`).join('|');
    if (sig === this.petSig) return;   // nothing changed: skip the DOM churn
    this.petSig = sig;
    this.petsEl.classList.remove('hidden');
    this.petsEl.innerHTML = '';
    for (const p of pets) {
      const row = el('div', `pet-row${p.fighting ? ' fighting' : ''}`, this.petsEl);
      const icon = el('div', 'pet-icon', row);
      const sprite = this.atlas.sprite(`mob_catcher_filled_${p.kind}`);
      if (sprite) {
        const c = document.createElement('canvas');
        c.width = 24; c.height = 24;
        const ctx = c.getContext('2d')!;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(sprite, 0, 0, 16, 16, 0, 0, 24, 24);
        icon.appendChild(c);
      }
      const meta = el('div', 'pet-meta', row);
      const label = el('div', 'pet-name', meta);
      label.textContent = mobLabel(p.kind) + (p.sitting ? ' · staying' : p.fighting ? ' · fighting' : '');
      const bar = el('div', 'pet-bar', meta);
      const fill = el('div', 'pet-bar-fill', bar);
      const frac = Math.max(0, Math.min(1, p.hp / p.maxHp));
      fill.style.width = `${Math.round(frac * 100)}%`;
      fill.style.background = frac > 0.5 ? '#4ad24a' : frac > 0.25 ? '#e0c341' : '#e34a4a';
    }
  }

  setPortalFade(amount: number): void {
    this.portalEl.style.opacity = String(Math.max(0, Math.min(1, amount)));
  }

  setNetherTint(on: boolean): void {
    this.netherTintEl.style.opacity = on ? '1' : '0';
  }

  /** hpFrac = health/maxHealth; a red vignette fades in below 30% health and
   *  pulses (heartbeat-style) once it gets critical. */
  setLowHealth(hpFrac: number): void {
    const a = hpFrac > 0.3 || hpFrac <= 0 ? 0 : (0.3 - hpFrac) / 0.3;
    this.lowHealthEl.style.opacity = String(a * 0.85);
    this.lowHealthEl.classList.toggle('pulse', hpFrac > 0 && hpFrac <= 0.2);
  }

  setDebugVisible(v: boolean): void { this.debugEl.classList.toggle('hidden', !v); }
  isDebugVisible(): boolean { return !this.debugEl.classList.contains('hidden'); }

  updateDebug(lines: string[]): void {
    this.debugEl.innerHTML = lines.map((l) => `<span>${l}</span>`).join('<br>');
  }

  /** Show the minimap chrome only while carrying a compass (or in creative). */
  setMinimapVisible(visible: boolean): void {
    this.minimapEl.classList.toggle('hidden', !visible);
    this.root.classList.toggle('has-minimap', visible);
  }

  /** Redraw the minimap: a top-down block sample around the player, a facing
   *  arrow, and compass/clock text readouts. */
  updateMinimap(
    px: number, pz: number, yaw: number,
    sample: (wx: number, wz: number) => number,
    dayTime: number,
    hasCompass: boolean, hasClock: boolean,
  ): void {
    const ctx = this.minimapCanvas.getContext('2d')!;
    const W = 96, RADIUS = 48, SCALE = 2; // 1 pixel per 2 blocks -> 96-block view
    ctx.clearRect(0, 0, W, W);
    // color map for block ids
    const color = (id: number): string => {
      switch (id) {
        case 0: return '#3a5a8a'; // air/water-ish (we sample surface, so treat as water)
        case 10: return '#2f52a5'; // water
        case 5: return '#dbd3a0'; // sand
        case 14: return '#f4fcfc'; // snow
        case 1: return '#5d9b3d'; // grass
        case 2: return '#866043'; // dirt
        case 3: case 4: return '#747474'; // stone/cobble
        case 6: case 31: case 32: return '#5d4222'; // logs
        case 8: case 33: case 34: return '#2f6b1e'; // leaves
        default: return '#5a5a5a';
      }
    };
    for (let py = 0; py < W; py++) {
      for (let pxx = 0; pxx < W; pxx++) {
        const wx = Math.floor(px + (pxx - RADIUS) * SCALE);
        const wz = Math.floor(pz + (py - RADIUS) * SCALE);
        ctx.fillStyle = color(sample(wx, wz));
        ctx.fillRect(pxx, py, 1, 1);
      }
    }
    // player arrow at center (pointing the look direction)
    const ang = yaw; // player yaw; 0 = -z (north)
    ctx.save();
    ctx.translate(RADIUS, RADIUS);
    ctx.rotate(-ang);
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.moveTo(0, -6); ctx.lineTo(4, 5); ctx.lineTo(-4, 5); ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(0, -5); ctx.lineTo(3, 4); ctx.lineTo(-3, 4); ctx.closePath();
    ctx.fill();
    ctx.restore();
    // north marker
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(RADIUS - 5, 1, 10, 10);
    ctx.fillStyle = '#ff5555';
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('N', RADIUS, 9);
    // frame
    ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, W - 2, W - 2);

    // compass + clock text
    if (hasCompass) {
      const yawDeg = ((yaw * 180 / Math.PI) % 360 + 360) % 360;
      const dirs = ['N', 'W', 'S', 'E'];
      this.compassEl.textContent = `Compass ${dirs[Math.round(yawDeg / 90) % 4]}`;
      this.compassEl.title = 'Compass: carry one to show your heading on the minimap';
      this.compassEl.style.display = 'block';
    } else {
      this.compassEl.style.display = 'none';
    }
    if (hasClock) {
      // dayTime: 0=sunrise, 0.25=noon, 0.5=sunset, 0.75=midnight
      const hours = (dayTime * 24 + 6) % 24; // shift so sunrise ~6am
      const h = Math.floor(hours);
      const m = Math.floor((hours - h) * 60);
      const night = hours < 6 || hours >= 18.5;
      this.clockEl.textContent = `${night ? '☾' : '☀'} ${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
      this.clockEl.title = 'Clock: carry one to show world time';
      this.clockEl.style.display = 'block';
    } else {
      this.clockEl.style.display = 'none';
    }
  }

  toast(msg: string): void {
    this.toastEl.textContent = msg;
    this.toastEl.className = 'plain';
    void this.toastEl.offsetWidth; // restart the pop-in when messages repeat
    this.toastEl.className = 'show plain';
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastEl.classList.remove('show'), 2600);
  }

  // --- advancement toasts + panel ------------------------------------------

  private advToastEl: HTMLElement | null = null;
  private advToastQueue: { icon: string; label: string }[] = [];
  private advToastTimer: ReturnType<typeof setTimeout> | null = null;
  private advPanel: HTMLElement | null = null;

  /** Queue an advancement unlock toast (slides in from the right). */
  showAdvancementToast(icon: string, label: string): void {
    this.advToastQueue.push({ icon, label });
    if (!this.advToastTimer) this.advanceAdvancementToast();
  }

  private advanceAdvancementToast(): void {
    const next = this.advToastQueue.shift();
    if (!next) {
      this.advToastTimer = null;
      if (this.advToastEl) this.advToastEl.classList.remove('show');
      return;
    }
    if (!this.advToastEl) {
      this.advToastEl = el('div', 'adv-toast', this.root);
      this.advToastEl.setAttribute('role', 'status');
    }
    this.advToastEl.innerHTML = '';
    const ic = el('span', 'adv-icon', this.advToastEl);
    ic.textContent = next.icon;
    const body = el('div', 'adv-body', this.advToastEl);
    const top = el('div', 'adv-top', body);
    top.textContent = 'Advancement Made!';
    const lbl = el('div', 'adv-label', body);
    lbl.textContent = next.label;
    this.advToastEl.classList.add('show');
    this.advToastTimer = setTimeout(() => {
      if (this.advToastEl) this.advToastEl.classList.remove('show');
      this.advToastTimer = setTimeout(() => this.advanceAdvancementToast(), 600);
    }, 4000);
  }

  /** Toggle the advancement list panel. */
  toggleAdvancements(list: { icon: string; label: string; desc: string; done: boolean }[]): void {
    if (this.advPanel) { this.hideAdvancements(); return; }
    this.advPanel = el('div', 'overlay', this.root);
    this.advPanel.id = 'adv-panel';
    const panel = el('div', 'mc-panel', this.advPanel);
    const head = el('div', 'ctr-header', panel);
    const title = el('div', 'ctr-label', head);
    title.style.fontSize = '16px';
    title.style.marginBottom = '0';
    const done = list.filter((a) => a.done).length;
    title.textContent = `Advancements  (${done}/${list.length})`;
    const close = el('button', 'ctr-close', head) as HTMLButtonElement;
    close.type = 'button';
    close.textContent = '✕';
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close');
    close.onclick = () => { this.audio.play('click'); this.hideAdvancements(); };
    const prog = el('div', 'adv-progress', panel);
    const pf = el('div', 'fill', prog);
    pf.style.width = `${list.length ? Math.round((done / list.length) * 100) : 0}%`;
    const listEl = el('div', 'adv-list', panel);
    for (const a of list) {
      const row = el('div', `adv-row${a.done ? ' done' : ''}`, listEl);
      const ic = el('span', 'adv-row-icon', row);
      if (a.done) ic.textContent = a.icon;
      else ic.appendChild(scaled(GUI_ICONS.lock(), 3));
      const text = el('div', 'adv-row-text', row);
      const name = el('div', 'adv-row-name', text);
      name.textContent = a.label;
      const desc = el('div', 'adv-row-desc', text);
      desc.textContent = a.desc;
    }
    const hint = el('div', 'adv-hint', panel);
    hint.textContent = 'Press L or ✕ to close';
  }

  /** In-menu confirm dialog (world delete, etc.). Enter confirms, Esc cancels. */
  showConfirm(message: string, onConfirm: () => void, opts: { title?: string; yes?: string; no?: string; detail?: string } = {}): void {
    this.confirmEl.classList.remove('hidden');
    this.confirmEl.innerHTML = '';
    const panel = el('div', 'mc-panel confirm-panel', this.confirmEl);
    panel.setAttribute('role', 'alertdialog');
    panel.setAttribute('aria-modal', 'true');
    if (opts.title) el('div', 'confirm-title', panel).appendChild(scaled(pixelText(opts.title, '#404040', false), 2));
    const msg = el('div', 'confirm-msg', panel);
    msg.textContent = message;
    if (opts.detail) el('div', 'confirm-detail', panel).textContent = opts.detail;
    const row = el('div', 'menu-row', panel);
    const close = (): void => {
      this.confirmEl.classList.add('hidden');
      if (this.confirmKey) { document.removeEventListener('keydown', this.confirmKey, true); this.confirmKey = null; }
    };
    const yes = el('button', 'mc-btn danger', row) as HTMLButtonElement;
    yes.textContent = opts.yes ?? 'Delete';
    yes.onclick = () => { this.audio.play('click'); close(); onConfirm(); };
    const no = el('button', 'mc-btn', row) as HTMLButtonElement;
    no.textContent = opts.no ?? 'Cancel';
    no.onclick = () => { this.audio.play('click'); close(); };
    if (this.confirmKey) document.removeEventListener('keydown', this.confirmKey, true);
    this.confirmKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); no.click(); }
    };
    document.addEventListener('keydown', this.confirmKey, true);
    setTimeout(() => no.focus(), 0);
  }

  hideAdvancements(): void {
    if (this.advPanel) { this.advPanel.remove(); this.advPanel = null; }
  }

  isAdvancementsOpen(): boolean { return this.advPanel !== null; }

  // =========================================================================
  // Loading screen
  // =========================================================================

  showLoading(text: string, progress = true): void {
    this.loadingEl.classList.remove('hidden');
    this.loadingEl.innerHTML = '';
    try {
      const dirt = this.atlas.tileCanvas('dirt').toDataURL();
      this.loadingEl.style.backgroundImage = `linear-gradient(rgba(0,0,0,0.7), rgba(0,0,0,0.7)), url(${dirt})`;
      this.loadingEl.style.backgroundSize = 'auto, 64px 64px';
    } catch { /* plain background */ }
    const box = el('div', 'load-box', this.loadingEl);
    const head = el('div', 'load-title', box);
    head.appendChild(scaled(pixelText(text.replace(/\.+$/, ''), '#ffffff'), 3));
    head.setAttribute('aria-label', text);
    if (!progress) {
      // indeterminate (e.g. saving on quit): a sweeping bar instead of the chunk grid
      const bar = el('div', 'load-bar indeterminate', box);
      el('div', 'fill', bar);
      this.loadFill = null; this.loadPct = null; this.loadCells = [];
      if (this.loadTipTimer) { clearInterval(this.loadTipTimer); this.loadTipTimer = null; }
      return;
    }
    // 5x5 chunk map that lights up as spawn chunks finish (vanilla's loading grid)
    const map = el('div', 'load-map', box);
    this.loadCells = [];
    for (let i = 0; i < 25; i++) this.loadCells.push(el('div', 'load-cell', map));
    const bar = el('div', 'load-bar', box);
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    this.loadFill = el('div', 'fill', bar);
    this.loadPct = el('div', 'load-pct', box);
    this.loadPct.textContent = 'Preparing spawn area: 0%';
    const tip = el('div', 'load-tip', box);
    let ti = Math.floor(Math.random() * TIPS.length);
    const setTip = (): void => { tip.textContent = `Tip: ${TIPS[ti % TIPS.length]}`; ti++; };
    setTip();
    if (this.loadTipTimer) clearInterval(this.loadTipTimer);
    this.loadTipTimer = setInterval(setTip, 3500);
  }

  /** Spawn-area generation progress: 0..1 plus optional per-chunk readiness. */
  setLoadingProgress(frac: number, cells?: boolean[]): void {
    const pct = Math.round(Math.max(0, Math.min(1, frac)) * 100);
    if (this.loadFill) this.loadFill.style.width = `${pct}%`;
    if (this.loadFill?.parentElement) this.loadFill.parentElement.setAttribute('aria-valuenow', String(pct));
    if (this.loadPct) this.loadPct.textContent = `Preparing spawn area: ${pct}%`;
    if (cells) cells.forEach((on, i) => this.loadCells[i]?.classList.toggle('on', on));
  }

  hideLoading(): void {
    this.loadingEl.classList.add('hidden');
    if (this.loadTipTimer) { clearInterval(this.loadTipTimer); this.loadTipTimer = null; }
  }

  // =========================================================================
  // Pause + Options
  // =========================================================================

  showPause(h: PauseHandlers, mode: GameMode, viewDist: number): void {
    const wasOpen = this.isPauseOpen();
    this.pauseH = h;
    this.pauseMode = mode;
    this.pauseViewDist = viewDist;
    this.pauseEl.classList.remove('hidden');
    if (!this.pauseBuilt) this.buildPauseMenu();
    if (!wasOpen) {
      // always reopen on the main page, with keyboard focus on "Back to Game"
      this.pauseMainEl?.classList.remove('hidden');
      this.pauseOptsEl?.classList.add('hidden');
      setTimeout(() => (this.pauseMainEl?.querySelector('button') as HTMLButtonElement | null)?.focus({ preventScroll: true }), 0);
    }
    this.syncPauseUi();
  }

  private pauseButton(parent: HTMLElement, label: string, onClick: () => void, cls = ''): HTMLButtonElement {
    const b = el('button', `mc-btn${cls ? ` ${cls}` : ''}`, parent) as HTMLButtonElement;
    b.textContent = label;
    b.addEventListener('mouseenter', () => this.audio.play('select'));
    b.onclick = () => { this.audio.play('click'); onClick(); };
    return b;
  }

  /** Vanilla-style slider: the label sits inside the bar, the thumb is a button. */
  private mcSlider(parent: HTMLElement, min: number, max: number, step: number,
    get: () => number, label: (v: number) => string, onInput: (v: number) => void, cls = ''): void {
    const wrap = el('div', `mc-slider${cls ? ` ${cls}` : ''}`, parent);
    const input = el('input', '', wrap) as HTMLInputElement;
    input.type = 'range';
    input.min = String(min); input.max = String(max); input.step = String(step);
    const lbl = el('span', 'mc-slider-label', wrap);
    const sync = (): void => {
      const v = get();
      input.value = String(v);
      lbl.textContent = label(v);
      input.setAttribute('aria-valuetext', lbl.textContent);
      wrap.style.setProperty('--pos', `${((v - min) / (max - min)) * 100}%`);
    };
    input.oninput = () => { onInput(parseFloat(input.value)); sync(); };
    input.onchange = () => this.audio.play('click');
    this.pauseSyncers.push(sync);
    sync();
  }

  private buildPauseMenu(): void {
    this.pauseEl.innerHTML = '';
    this.pauseSyncers = [];

    // --- main page ----------------------------------------------------------
    const main = el('div', 'pause-screen', this.pauseEl);
    this.pauseMainEl = main;
    const t1 = el('h2', 'pause-title', main);
    t1.appendChild(scaled(pixelText('Game Menu', '#ffffff'), 3));
    t1.setAttribute('aria-label', 'Game Menu');
    const col = el('div', 'menu-col pause-col', main);
    this.pauseButton(col, 'Back to Game', () => this.pauseH?.onResume(), 'wide');
    const opts = this.pauseButton(col, 'Options…', () => {
      main.classList.add('hidden');
      this.pauseOptsEl?.classList.remove('hidden');
      this.syncPauseUi();
      setTimeout(() => (this.pauseOptsEl?.querySelector('button, input') as HTMLElement | null)?.focus({ preventScroll: true }), 0);
    }, 'wide');
    void opts;
    const save = this.pauseButton(col, 'Save Game', () => {
      save.textContent = 'Saving...';
      save.disabled = true;
      void this.pauseH?.onSave().then((ok) => {
        save.textContent = ok ? 'Saved ✓' : 'Save failed';
        setTimeout(() => { save.textContent = 'Save Game'; save.disabled = false; }, 1200);
      });
    }, 'wide');
    const modeBtn = this.pauseButton(col, '', () => this.pauseH?.onToggleMode(), 'wide');
    this.pauseSyncers.push(() => { modeBtn.textContent = `Game Mode: ${this.pauseMode === 'survival' ? 'Survival' : 'Creative'}`; });
    const quit = this.pauseButton(col, 'Save and Quit to Title', () => {
      quit.textContent = 'Saving...';
      quit.disabled = true;
      this.showLoading('Saving world', false);
      this.pauseH?.onSaveQuit();
    }, 'wide quit-btn');

    // --- options page -------------------------------------------------------
    const optsEl = el('div', 'pause-screen options hidden', this.pauseEl);
    this.pauseOptsEl = optsEl;
    const t2 = el('h2', 'pause-title', optsEl);
    t2.appendChild(scaled(pixelText('Options', '#ffffff'), 3));
    t2.setAttribute('aria-label', 'Options');
    const grid = el('div', 'opt-grid', optsEl);
    const section = (name: string): void => { el('div', 'opt-section', grid).textContent = name; };

    section('Video');
    this.mcSlider(grid, 50, 110, 1, () => this.settings.fov,
      (v) => `FOV: ${v === 70 ? 'Normal' : v >= 110 ? 'Quake Pro' : v}`,
      (v) => { this.settings.fov = v; this.saveSettings(); });
    this.mcSlider(grid, 6, 12, 2, () => this.pauseViewDist,
      (v) => `Render Distance: ${v} chunks`,
      (v) => { this.pauseViewDist = v; this.pauseH?.onViewDist(v); });
    const guiBtn = this.pauseButton(grid, '', () => {
      this.settings.gui = (this.settings.gui + 1) % 4;
      this.saveSettings(); this.applyGuiScale(); this.syncPauseUi();
    });
    this.pauseSyncers.push(() => { guiBtn.textContent = `GUI Scale: ${GUI_NAMES[this.settings.gui]}`; });
    const bobBtn = this.pauseButton(grid, '', () => {
      this.settings.bob = !this.settings.bob; this.saveSettings(); this.syncPauseUi();
    });
    this.pauseSyncers.push(() => { bobBtn.textContent = `View Bobbing: ${this.settings.bob ? 'ON' : 'OFF'}`; });
    const fpsBtn = this.pauseButton(grid, '', () => {
      this.settings.fps = !this.settings.fps; this.fpsT0 = performance.now(); this.fpsFrames = 0;
      this.saveSettings(); this.syncPauseUi();
    });
    this.pauseSyncers.push(() => { fpsBtn.textContent = `Show FPS: ${this.settings.fps ? 'ON' : 'OFF'}`; });
    this.pauseButton(grid, 'Resource Pack…', () => { this.packHandler = this.pauseH!.onPack; this.packInput.click(); });

    section('Music & Sounds');
    this.mcSlider(grid, 0, 100, 5, () => Math.round(this.audio.volume * 100),
      (v) => `Master Volume: ${v === 0 ? 'OFF' : `${v}%`}`,
      (v) => this.audio.setVolume(v / 100), 'span2');
    // per-bus loudness (relative to master), each paired with its on/off toggle
    const pct = (label: string) => (v: number): string => `${label}: ${v === 0 ? 'OFF' : `${v}%`}`;
    this.mcSlider(grid, 0, 100, 5, () => Math.round(this.audio.musicVolume * 100),
      pct('Music Volume'), (v) => this.audio.setMusicVolume(v / 100));
    const musicBtn = this.pauseButton(grid, '', () => this.pauseH?.onToggleMusic());
    this.pauseSyncers.push(() => { musicBtn.textContent = `Music: ${this.pauseH?.musicOn() ? 'ON' : 'OFF'}`; });
    this.mcSlider(grid, 0, 100, 5, () => Math.round(this.audio.soundVolume * 100),
      pct('Sounds Volume'), (v) => this.audio.setSoundVolume(v / 100));
    const soundBtn = this.pauseButton(grid, '', () => this.pauseH?.onToggleSound());
    this.pauseSyncers.push(() => { soundBtn.textContent = `Sounds: ${this.pauseH?.soundOn() ? 'ON' : 'OFF'}`; });
    const subsBtn = this.pauseButton(grid, '', () => {
      this.settings.subs = !this.settings.subs; this.saveSettings(); this.syncPauseUi();
    }, 'span2');
    this.pauseSyncers.push(() => { subsBtn.textContent = `Show Subtitles: ${this.settings.subs ? 'ON' : 'OFF'}`; });

    section('Controls');
    this.mcSlider(grid, 50, 200, 5, () => Math.round((this.pauseH?.mouseSens() ?? 1) * 100),
      (v) => `Mouse Sensitivity: ${v}%`,
      (v) => this.pauseH?.onMouseSens(v / 100));
    this.mcSlider(grid, 60, 220, 5, () => Math.round((this.pauseH?.touchLook() ?? 1) * 100),
      (v) => `Touch Look: ${v}%`,
      (v) => this.pauseH?.onTouchLook(v / 100));

    const done = el('div', 'menu-col pause-col', optsEl);
    this.pauseButton(done, 'Done', () => {
      optsEl.classList.add('hidden');
      main.classList.remove('hidden');
      (main.querySelectorAll('button')[1] as HTMLButtonElement | undefined)?.focus({ preventScroll: true });
    }, 'wide');

    this.pauseBuilt = true;
  }

  private syncPauseUi(): void {
    for (const s of this.pauseSyncers) s();
  }

  hidePause(): void { this.pauseEl.classList.add('hidden'); }
  isPauseOpen(): boolean { return !this.pauseEl.classList.contains('hidden'); }

  // =========================================================================
  // Death
  // =========================================================================

  showDeath(onRespawn: () => void, onTitle: () => void, cause = '', at?: { x: number; y: number; z: number }): void {
    this.deathEl.classList.remove('hidden');
    this.deathEl.innerHTML = '';
    const box = el('div', 'death-box', this.deathEl);
    const t = el('div', 'death-title', box);
    t.appendChild(scaled(pixelText('You Died!', '#ffffff'), 6));
    t.setAttribute('aria-label', 'You died!');
    t.setAttribute('role', 'heading');
    if (cause) {
      const c = el('div', 'death-cause', box);
      c.textContent = cause;
    }
    if (at) {
      const p = el('div', 'death-pos', box);
      p.textContent = `Died at ${Math.floor(at.x)}, ${Math.floor(at.y)}, ${Math.floor(at.z)}`;
    }
    const col = el('div', 'menu-col death-col', box);
    const r = el('button', 'mc-btn wide', col) as HTMLButtonElement;
    r.textContent = 'Respawn';
    r.onclick = () => { this.audio.play('click'); onRespawn(); };
    const q = el('button', 'mc-btn wide', col) as HTMLButtonElement;
    q.textContent = 'Title Screen';
    q.onclick = () => { this.audio.play('click'); this.showLoading('Saving world', false); onTitle(); };
    // like vanilla, the buttons wake up after a beat so a panicked click
    // doesn't respawn you before you've read the screen
    r.disabled = true; q.disabled = true;
    if (this.deathTimer) clearTimeout(this.deathTimer);
    this.deathTimer = setTimeout(() => { r.disabled = false; q.disabled = false; r.focus({ preventScroll: true }); }, 1000);
  }
  hideDeath(): void { this.deathEl.classList.add('hidden'); }

  // =========================================================================
  // Combat feedback (hit marker + floating damage numbers)
  // =========================================================================

  /** brief crosshair tick when the player damages a mob (gold on crit, red on kill) */
  flashHitMarker(crit: boolean, killed: boolean): void {
    const hm = this.hitmarkerEl;
    hm.classList.remove('hit', 'crit', 'kill');
    void hm.offsetWidth; // restart the CSS animation
    hm.classList.add('hit');
    if (crit) hm.classList.add('crit');
    if (killed) hm.classList.add('kill');
  }

  /** floating damage number at screen coords (px); drifts up and fades out */
  showDamageNumber(sx: number, sy: number, dmg: number, crit: boolean): void {
    if (this.dmgNums.length > 14) this.dmgNums.shift()?.remove();
    const n = el('div', `dmg-num${crit ? ' crit' : ''}`, this.hud);
    n.textContent = String(dmg);
    n.style.left = `${sx}px`;
    n.style.top = `${sy}px`;
    this.dmgNums.push(n);
    n.addEventListener('animationend', () => {
      n.remove();
      const i = this.dmgNums.indexOf(n);
      if (i >= 0) this.dmgNums.splice(i, 1);
    });
  }

  // =========================================================================
  // Containers
  // =========================================================================

  isContainerOpen(): boolean { return this.view !== null; }

  openContainer(view: ContainerView, inv: Inventory, mode: GameMode): void {
    this.view = view;
    this.inv = inv;
    this.viewMode = mode;
    this.containerEl.classList.remove('hidden');
    this.renderContainer(mode);
  }

  /** Close, returning craft-grid + cursor contents to the inventory. */
  closeContainer(): void {
    if (!this.view || !this.inv) { this.view = null; return; }
    for (let i = 0; i < this.view.craftGrid.length; i++) {
      const s = this.view.craftGrid[i];
      if (s) {
        const left = this.inv.add(s.id, s.count);
        if (left > 0) this.onDropLeftover(s.id, left);
        this.view.craftGrid[i] = null;
      }
    }
    if (this.cursor && this.view.kind !== 'creative') {
      const left = this.inv.add(this.cursor.id, this.cursor.count);
      if (left > 0) this.onDropLeftover(this.cursor.id, left);
    }
    this.cursor = null;
    this.view = null;
    this.inv = null;
    this.hoverSlot = null;
    this.containerEl.classList.add('hidden');
    this.cursorEl.classList.add('hidden');
    this.hideTooltip();
    this.renderCursor();
  }

  /** Called every frame while a furnace is open to animate bars + sync slots. */
  updateFurnace(): void {
    if (!this.view || this.view.kind !== 'furnace' || !this.view.furnace) return;
    const f = this.view.furnace;
    const flame = this.containerEl.querySelector('.furnace-flame .fill') as HTMLElement | null;
    const arrow = this.containerEl.querySelector('.furnace-arrow .fill') as HTMLElement | null;
    if (flame) flame.style.height = `${f.burnTotal > 0 ? Math.min(100, (f.burn / f.burnTotal) * 100) : 0}%`;
    if (arrow) arrow.style.width = `${Math.min(100, (f.cook / SMELT_TIME) * 100)}%`;
    const snap = JSON.stringify([f.input, f.fuel, f.output]);
    if (snap !== this.furnaceSnapshot) {
      this.furnaceSnapshot = snap;
      this.renderContainer('survival');
    }
  }

  /** 1-9 over a slot swaps with the hotbar; Q drops one, Ctrl+Q the stack. */
  private containerKey(e: KeyboardEvent): void {
    if (!this.view || !this.inv || !this.hoverSlot) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    const { arr, i } = this.hoverSlot;
    const inv = this.inv;
    if (/^Digit[1-9]$/.test(e.code)) {
      const h = parseInt(e.code.slice(5), 10) - 1;
      if (arr === inv.slots && i === h) return;
      const a = arr[i], b = inv.slots[h];
      arr[i] = b; inv.slots[h] = a;
      this.audio.play('click');
      inv.onChange();
      this.renderContainer(this.viewMode);
    } else if (e.code === 'KeyQ' && !this.cursor) {
      const s = arr[i];
      if (!s) return;
      const n = e.ctrlKey || e.metaKey ? s.count : 1;
      if (this.view.kind !== 'creative' || arr === inv.slots) {
        this.onDropLeftover(s.id, n);
        s.count -= n;
        if (s.count <= 0) arr[i] = null;
        inv.onChange();
        this.renderContainer(this.viewMode);
      }
    }
  }

  // --- item tooltips --------------------------------------------------------

  /** A short category label, shown in blue-italic like vanilla's mod line. */
  private itemCategory(id: number): string {
    const d = def(id);
    if (d.armor) return `Armor · ${['Head', 'Chest', 'Legs', 'Feet'][d.armor.slot] ?? 'Body'}`;
    if (d.toolInfo) return d.toolInfo.kind === 'sword' ? 'Weapon' : 'Tool';
    if (d.bow) return 'Ranged Weapon';
    if (d.food) return 'Food';
    if (id === I.MOB_CATCHER || id === I.MOB_CATCHER_FILLED) return 'Pet Capture';
    if (d.block) return d.solid ? 'Building Block' : 'Decoration';
    return 'Material';
  }

  /** Build the rich tooltip body for a stack into `box`. */
  private fillTooltip(box: HTMLElement, item: SlotData): void {
    const d = def(item.id);
    const name = el('div', 'tt-name', box);
    name.textContent = item.mob ? `Captured ${mobLabel(item.mob)}` : d.label;
    name.style.color = this.itemAccent(item.id);
    el('div', 'tt-cat', box).textContent = this.itemCategory(item.id);
    const line = (text: string, cls = ''): HTMLElement => {
      const l = el('div', `tt-line${cls ? ` ${cls}` : ''}`, box);
      l.textContent = text;
      return l;
    };
    const tiers: Record<number, string> = { 2: 'Wood', 4: 'Stone', 6: 'Iron', 8: 'Diamond', 10: 'Netherite' };
    if (d.toolInfo) {
      line('When in Main Hand:', 'tt-gap tt-grey');
      line(` ${d.toolInfo.damage} Attack Damage`, 'tt-good');
      if (d.toolInfo.kind !== 'sword' && tiers[d.toolInfo.tier]) line(` ${tiers[d.toolInfo.tier]}-tier mining`, 'tt-good');
    }
    if (d.bow) { line('When drawn:', 'tt-gap tt-grey'); line(' Hold to charge, release to fire', 'tt-good'); }
    if (d.armor) {
      line(`When on ${['Head', 'Body', 'Legs', 'Feet'][d.armor.slot] ?? 'Body'}:`, 'tt-gap tt-grey');
      line(` +${d.armor.points} Armor`, 'tt-blue');
    }
    if (d.food) {
      const l = line(`Restores ${d.food} `, 'tt-gap tt-food');
      const shanks = Math.ceil(d.food / 2);
      for (let k = 0; k < shanks; k++) {
        const icon = shankIcon(k === shanks - 1 && d.food % 2 === 1 ? 'half' : 'full');
        icon.className = 'pix tt-shank';
        l.appendChild(icon);
      }
    }
    if (d.fuel) line(`Fuel: smelts ${+(d.fuel / SMELT_TIME).toFixed(1)} items`, 'tt-grey');
    if (item.mob) line(`Contains: ${mobLabel(item.mob)}`, 'tt-epic');
    if (d.durability) {
      const cur = item.dur ?? d.durability;
      line(`Durability: ${cur} / ${d.durability}`, 'tt-gap');
      const bar = el('div', 'tt-dur', box);
      const f = el('div', 'fill', bar);
      const ratio = Math.max(0, Math.min(1, cur / d.durability));
      f.style.width = `${Math.round(ratio * 100)}%`;
      f.style.background = `hsl(${Math.round(ratio * 120)}, 90%, 50%)`;
    }
    // advanced tooltip (vanilla's F3+H): shown while the debug overlay is up
    if (this.isDebugVisible()) line(`voxelcraft:${d.name} (#${item.id})`, 'tt-gap tt-id');
  }

  /** Show the rich tooltip for an item near (x, y); a no-op for empty slots. */
  showTooltip(item: Slot, x: number, y: number): void {
    if (!item) { this.hideTooltip(); return; }
    this.tooltipEl.innerHTML = '';
    this.fillTooltip(this.tooltipEl, item);
    this.tooltipEl.classList.remove('hidden');
    this.moveTooltip(x, y);
  }

  hideTooltip(): void {
    this.tooltipEl.classList.add('hidden');
    if (this.touchTipTimer) { clearTimeout(this.touchTipTimer); this.touchTipTimer = null; }
  }

  private touchTipTimer: ReturnType<typeof setTimeout> | null = null;

  /** Brief tooltip for a tapped stack on touch screens (placed above the finger). */
  private flashTouchTooltip(item: SlotData, x: number, y: number): void {
    this.showTooltip(item, x, y);
    const r = this.tooltipEl.getBoundingClientRect();
    this.tooltipEl.style.left = `${Math.max(4, Math.min(window.innerWidth - r.width - 4, x - r.width / 2))}px`;
    this.tooltipEl.style.top = `${Math.max(4, y - r.height - 36)}px`;
    this.touchTipTimer = setTimeout(() => { this.touchTipTimer = null; this.hideTooltip(); }, 1400);
  }

  private moveTooltip(x: number, y: number): void {
    // keep the box on screen: flip to the left/up near the right/bottom edges
    const r = this.tooltipEl.getBoundingClientRect();
    let left = x + 14, top = y - 14;
    if (left + r.width > window.innerWidth - 6) left = x - r.width - 14;
    if (top + r.height > window.innerHeight - 6) top = window.innerHeight - r.height - 6;
    this.tooltipEl.style.left = `${Math.max(4, left)}px`;
    this.tooltipEl.style.top = `${Math.max(4, top)}px`;
  }

  private iconCanvas(item: SlotData): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = 32; c.height = 32;
    const ctx = c.getContext('2d')!;
    // filled mob catchers show a per-mob sprite instead of the generic icon
    const mobSprite = spriteNameFor(item.id, item.mob);
    if (item.mob !== undefined && mobSprite && mobSprite !== def(item.id).sprite) {
      const s = this.atlas.sprite(mobSprite);
      if (s) { ctx.imageSmoothingEnabled = false; ctx.drawImage(s, 0, 0, 16, 16, 0, 0, 32, 32); }
    } else {
      const src = this.atlas.icon(item.id);
      ctx.drawImage(src, 0, 0);
    }
    // durability bar for worn tools (vanilla: 13px bar on a black track)
    const d = def(item.id);
    if (d.durability && item.dur !== undefined && item.dur < d.durability) {
      const ratio = Math.max(0, item.dur / d.durability);
      ctx.fillStyle = '#000000';
      ctx.fillRect(4, 26, 26, 4);
      ctx.fillStyle = `hsl(${Math.round(ratio * 120)}, 95%, 48%)`;
      ctx.fillRect(4, 26, Math.max(2, Math.round(26 * ratio)), 2);
    }
    return c;
  }

  private renderCursor(): void {
    this.cursorEl.innerHTML = '';
    if (!this.cursor) {
      this.cursorEl.classList.add('hidden');
      return;
    }
    this.cursorEl.classList.remove('hidden');
    this.cursorEl.appendChild(this.iconCanvas(this.cursor));
    if (this.cursor.count > 1) this.countEl(this.cursorEl, this.cursor.count);
  }

  /** Shift-click quick-move: shove src[i]'s whole stack into dst[lo..hi),
   *  merging into matching stacks first, then filling empty slots. */
  private transfer(src: Slot[], i: number, dst: Slot[], lo: number, hi: number): boolean {
    const s = src[i];
    if (!s) return false;
    const max = def(s.id).stack;
    let moved = false;
    for (let j = lo; j < hi && s.count > 0; j++) {
      const t = dst[j];
      if (t && t.id === s.id && t.count < max) {
        const give = Math.min(max - t.count, s.count);
        t.count += give; s.count -= give; moved = true;
      }
    }
    for (let j = lo; j < hi && s.count > 0; j++) {
      if (!dst[j]) {
        const give = Math.min(max, s.count);
        dst[j] = { id: s.id, count: give, ...(s.dur !== undefined ? { dur: s.dur } : {}), ...(s.mob !== undefined ? { mob: s.mob } : {}) };
        s.count -= give; moved = true;
      }
    }
    if (s.count <= 0) src[i] = null;
    if (moved) this.audio.play('click');
    return moved;
  }

  /** Shift-click from a player inventory/hotbar slot: into an open chest if any,
   *  otherwise shuffle between the hotbar row and the main grid (vanilla feel). */
  private quickMovePlayer(view: ContainerView, inv: Inventory, i: number): void {
    let moved: boolean;
    if (view.kind === 'chest' && view.chest) {
      moved = this.transfer(inv.slots, i, view.chest.slots, 0, view.chest.slots.length);
    } else if (i < 9) {
      moved = this.transfer(inv.slots, i, inv.slots, 9, 36);
    } else {
      moved = this.transfer(inv.slots, i, inv.slots, 0, 9);
    }
    if (moved) inv.onChange();
  }

  /** Generic slot click with cursor-stack semantics. */
  private clickSlot(arr: Slot[], i: number, button: number, takeOnly = false): void {
    const s = arr[i];
    this.audio.play('click');
    if (takeOnly) {
      if (!s) return;
      if (!this.cursor) { arr[i] = null; this.cursor = s; }
      else if (this.cursor.id === s.id && this.cursor.count + s.count <= def(s.id).stack) {
        this.cursor.count += s.count;
        arr[i] = null;
      }
      return;
    }
    if (button === 2) {
      // right click: pick half / place one
      if (!this.cursor && s) {
        const half = Math.ceil(s.count / 2);
        this.cursor = { id: s.id, count: half, ...(s.mob !== undefined ? { mob: s.mob } : {}) };
        s.count -= half;
        if (s.count <= 0) arr[i] = null;
      } else if (this.cursor) {
        if (!s) {
          arr[i] = { id: this.cursor.id, count: 1, ...(this.cursor.mob !== undefined ? { mob: this.cursor.mob } : {}) };
          this.cursor.count--;
        } else if (s.id === this.cursor.id && s.count < def(s.id).stack) {
          s.count++;
          this.cursor.count--;
        }
        if (this.cursor.count <= 0) this.cursor = null;
      }
      return;
    }
    // left click
    if (!this.cursor && s) { arr[i] = null; this.cursor = s; }
    else if (this.cursor && !s) { arr[i] = this.cursor; this.cursor = null; }
    else if (this.cursor && s) {
      if (s.id === this.cursor.id) {
        const max = def(s.id).stack;
        const take = Math.min(max - s.count, this.cursor.count);
        s.count += take;
        this.cursor.count -= take;
        if (this.cursor.count <= 0) this.cursor = null;
      } else {
        arr[i] = this.cursor;
        this.cursor = s;
      }
    }
  }

  /** Equip/unequip via the inventory armor column; only the matching piece fits. */
  private clickArmorSlot(inv: Inventory, i: number, btn: number): void {
    void btn;
    const cur = inv.armor[i];
    if (this.cursor) {
      const a = def(this.cursor.id).armor;
      if (!a || a.slot !== i || this.cursor.count !== 1) return;
      inv.armor[i] = { id: this.cursor.id, count: 1, ...(this.cursor.dur !== undefined ? { dur: this.cursor.dur } : {}) };
      this.cursor = cur ?? null;
    } else if (cur) {
      this.cursor = cur;
      inv.armor[i] = null;
    }
    inv.onChange();
  }

  private slotEl(parent: HTMLElement, item: Slot, onClick: (button: number, shift: boolean) => void,
    extra = '', hover?: HoverSlot): HTMLElement {
    const s = el('div', `mc-slot${extra ? ` ${extra}` : ''}`, parent);
    if (item) {
      s.appendChild(this.iconCanvas(item));
      if (item.count > 1) this.countEl(s, item.count);
      s.setAttribute('aria-label', `${item.mob ? `Captured ${mobLabel(item.mob)}` : def(item.id).label}${item.count > 1 ? ` x${item.count}` : ''}`);
      // styled tooltip on hover (mouse only; touch uses tap-to-pick)
      s.addEventListener('pointerenter', (e) => {
        if (e.pointerType !== 'touch' && !this.cursor) this.showTooltip(item, e.clientX, e.clientY);
      });
      s.addEventListener('pointermove', (e) => {
        if (e.pointerType !== 'touch' && !this.tooltipEl.classList.contains('hidden')) {
          this.moveTooltip(e.clientX, e.clientY);
        }
      });
      s.addEventListener('pointerleave', () => this.hideTooltip());
    }
    if (hover) {
      s.addEventListener('pointerenter', () => { this.hoverSlot = hover; });
      s.addEventListener('pointerleave', () => { if (this.hoverSlot === hover) this.hoverSlot = null; });
    }
    // pointerdown fires reliably on touch (a tap) and mouse; move the held-item
    // cursor to the tap point first so it's visible where the finger is
    let pressTimer: ReturnType<typeof setTimeout> | null = null;
    let longFired = false;
    let mouseLmbPending = false;
    let touchOx = 0;
    let touchOy = 0;
    const TOUCH_LONG_PRESS_CANCEL_PX = 12;
    const cancelPress = (): void => {
      if (pressTimer !== null) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    };
    s.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.hideTooltip();
      this.followCursor(e.clientX, e.clientY);
      if (e.button === 2) {
        onClick(2, e.shiftKey);
        return;
      }
      if (e.button !== 0) return;
      longFired = false;
      mouseLmbPending = false;
      if (e.pointerType === 'touch') {
        touchOx = e.clientX;
        touchOy = e.clientY;
        s.classList.add('pressing');
        // touch has no hover: flash the tooltip above the finger instead
        if (item) this.flashTouchTooltip(item, e.clientX, e.clientY);
        pressTimer = setTimeout(() => {
          pressTimer = null;
          longFired = true;
          s.classList.remove('pressing');
          onClick(2, e.shiftKey);
        }, 480);
      } else {
        mouseLmbPending = true;
      }
    });
    s.addEventListener('pointerup', (e) => {
      if (e.button !== 0) return;
      s.classList.remove('pressing');
      if (e.pointerType === 'touch') {
        cancelPress();
        if (!longFired) onClick(0, e.shiftKey);
        longFired = false;
        return;
      }
      if (mouseLmbPending && !longFired) onClick(0, e.shiftKey);
      mouseLmbPending = false;
    });
    s.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'touch' || pressTimer === null) return;
      if (Math.hypot(e.clientX - touchOx, e.clientY - touchOy) > TOUCH_LONG_PRESS_CANCEL_PX) {
        cancelPress();
        s.classList.remove('pressing');
      }
    });
    s.addEventListener('pointerleave', () => {
      cancelPress();
      s.classList.remove('pressing');
      mouseLmbPending = false;
    });
    s.addEventListener('pointercancel', () => {
      cancelPress();
      s.classList.remove('pressing');
      mouseLmbPending = false;
      longFired = false;
    });
    return s;
  }

  private recipeFitsGrid(r: RecipeView, craftW: number): boolean {
    const h = r.shape.length;
    const w = Math.max(...r.shape.map((row) => row.length));
    return w <= craftW && h <= craftW;
  }

  private canFillRecipe(r: RecipeView, inv: Inventory, craftW: number): boolean {
    if (r.out === B.PORTAL) return false;
    return this.recipeFitsGrid(r, craftW) && r.counts.every((need) => inv.count(need.id) >= need.count);
  }

  private recipeCategory(r: RecipeView): Exclude<RecipeFilter, 'all' | 'ready'> {
    const d = def(r.out);
    if (d.toolInfo || d.bow || r.out === I.FISHING_ROD) return 'tools';
    if (d.food) return 'food';
    if (d.block || r.out === I.WOOD_DOOR) return 'blocks';
    return 'utility';
  }

  private recipeVisible(r: RecipeView, inv: Inventory, craftW: number): boolean {
    if (this.recipeSearchQuery) {
      const label = def(r.out).label.toLowerCase();
      if (!label.includes(this.recipeSearchQuery)) return false;
    }
    // show every recipe regardless of the current grid size; ones that need a
    // crafting table are still listed (and explain themselves when clicked), so
    // the book is a complete catalogue. "ready" stays limited to craftable-now.
    if (this.recipeFilter === 'all') return true;
    if (this.recipeFilter === 'ready') return this.canFillRecipe(r, inv, craftW);
    return this.recipeCategory(r) === this.recipeFilter;
  }

  private recipeBlockedReason(r: RecipeView, inv: Inventory, craftW: number): string {
    if (r.out === B.PORTAL) return 'Build 4x5 Obsidian frame & ignite with Flint & Steel. Teleports to the Nether map. (1:8 coordinates)';
    if (!this.recipeFitsGrid(r, craftW)) return 'Requires crafting table';
    if (this.cursor) return 'Clear cursor first';
    const missing = r.counts
      .map((need) => ({ ...need, have: inv.count(need.id) }))
      .filter((need) => need.have < need.count);
    if (missing.length === 0) return 'Ready';
    return `Missing ${missing.map((need) => `${need.count - need.have} ${def(need.id).label}`).join(', ')}`;
  }

  private takeFromInventory(inv: Inventory, id: number, count: number): boolean {
    if (inv.count(id) < count) return false;
    let need = count;
    for (let i = 0; i < inv.slots.length && need > 0; i++) {
      const s = inv.slots[i];
      if (!s || s.id !== id) continue;
      const take = Math.min(need, s.count);
      s.count -= take;
      need -= take;
      if (s.count <= 0) inv.slots[i] = null;
    }
    return need === 0;
  }

  private returnCraftGrid(view: ContainerView, inv: Inventory): void {
    for (let i = 0; i < view.craftGrid.length; i++) {
      const s = view.craftGrid[i];
      if (!s) continue;
      const left = inv.add(s.id, s.count);
      if (left > 0) this.onDropLeftover(s.id, left);
      view.craftGrid[i] = null;
    }
  }

  private fillRecipe(r: RecipeView, view: ContainerView, inv: Inventory): boolean {
    if (r.out === B.PORTAL) return false;
    if (this.cursor || !this.canFillRecipe(r, inv, view.craftW)) return false;
    this.returnCraftGrid(view, inv);
    if (!this.canFillRecipe(r, inv, view.craftW)) return false;
    for (let y = 0; y < r.shape.length; y++) {
      for (let x = 0; x < r.shape[y].length; x++) {
        const id = r.shape[y][x];
        if (id === 0) continue;
        if (!this.takeFromInventory(inv, id, 1)) return false;
        view.craftGrid[y * view.craftW + x] = { id, count: 1 };
      }
    }
    inv.onChange();
    return true;
  }

  private recipePatternEl(r: RecipeView, parent: HTMLElement): void {
    const pattern = el('div', 'recipe-pattern', parent);
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 3; x++) {
        const id = r.shape[y]?.[x] ?? 0;
        const p = el('div', `recipe-pip${id ? ' filled' : ''}`, pattern);
        if (id) p.appendChild(this.iconCanvas({ id, count: 1 }));
      }
    }
  }

  private recipeNeedsEl(r: RecipeView, inv: Inventory, parent: HTMLElement): void {
    const needs = el('div', 'recipe-needs', parent);
    for (const need of r.counts) {
      const have = inv.count(need.id);
      const chip = el('span', have >= need.count ? 'need-ok' : 'need-miss', needs);
      chip.textContent = `${Math.min(have, need.count)}/${need.count} ${def(need.id).label}`;
    }
  }

  /** Detail readout at the foot of the recipe book for the hovered recipe. */
  private showRecipeDetail(box: HTMLElement, r: RecipeView | null, inv: Inventory, craftW: number): void {
    box.innerHTML = '';
    if (!r) {
      el('div', 'recipe-hint', box).textContent = 'Hover a recipe to see its ingredients. Click to fill the grid.';
      return;
    }
    const top = el('div', 'recipe-detail-top', box);
    this.recipePatternEl(r, top);
    const arrow = el('div', 'gui-arrow small', top);
    void arrow;
    const out = el('div', 'recipe-out', top);
    out.appendChild(this.iconCanvas({ id: r.out, count: r.n }));
    if (r.n > 1) this.countEl(out, r.n);
    const text = el('div', 'recipe-text', box);
    const name = el('div', 'recipe-title', text);
    name.textContent = def(r.out).label + (r.n > 1 ? ` x${r.n}` : '');
    name.style.color = this.itemAccent(r.out);
    this.recipeNeedsEl(r, inv, text);
    const why = this.recipeBlockedReason(r, inv, craftW);
    const st = el('div', `recipe-status${why === 'Ready' ? ' ok' : ''}`, text);
    st.textContent = why === 'Ready' ? 'Click to place in the grid' : why;
  }

  /** The recipe book: search, category tabs, an icon grid and a detail pane. */
  private renderRecipeBook(parent: HTMLElement, view: ContainerView, inv: Inventory, rerender: () => void): void {
    const book = el('div', 'mc-panel book-panel', parent);
    const head = el('div', 'book-head', book);
    head.appendChild(scaled(GUI_ICONS.book(), 2));
    el('div', 'ctr-label', head).textContent = 'Recipe Book';

    const searchBox = el('input', 'recipe-search menu-input', book) as HTMLInputElement;
    searchBox.type = 'search';
    searchBox.placeholder = 'Search recipes…';
    searchBox.setAttribute('aria-label', 'Search recipes');
    searchBox.value = this.recipeSearchQuery;
    searchBox.onfocus = () => { this.recipeSearchFocused = true; };
    searchBox.onblur = () => { this.recipeSearchFocused = false; };
    searchBox.oninput = () => {
      this.recipeSearchQuery = searchBox.value.toLowerCase();
      fillGrid();
    };
    this.guardTyping(searchBox);
    if (this.recipeSearchFocused) {
      setTimeout(() => {
        searchBox.focus();
        searchBox.selectionStart = searchBox.selectionEnd = searchBox.value.length;
      }, 0);
    }

    const filters = el('div', 'recipe-filters', book);
    filters.setAttribute('role', 'tablist');
    const filterLabels: { id: RecipeFilter; label: string }[] = [
      { id: 'all', label: 'All' },
      { id: 'ready', label: 'Craftable' },
      { id: 'tools', label: 'Tools' },
      { id: 'blocks', label: 'Blocks' },
      { id: 'food', label: 'Food' },
      { id: 'utility', label: 'Misc' },
    ];
    for (const f of filterLabels) {
      const b = el('button', `recipe-filter${this.recipeFilter === f.id ? ' on' : ''}`, filters);
      b.textContent = f.label;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(this.recipeFilter === f.id));
      b.onclick = () => {
        this.recipeFilter = f.id;
        this.audio.play('select');
        rerender();
      };
    }
    const bookGrid = el('div', 'recipe-grid', book);
    const detail = el('div', 'recipe-detail', book);
    const countLbl = el('div', 'recipe-count', head);
    // only the icon grid re-renders while typing, so the search box keeps focus
    const fillGrid = (): void => {
      bookGrid.innerHTML = '';
      const recipes = allRecipes()
        .filter((r) => this.recipeVisible(r, inv, view.craftW))
        .sort((a, b) => {
          const ar = this.canFillRecipe(a, inv, view.craftW) ? 0 : this.recipeFitsGrid(a, view.craftW) ? 1 : 2;
          const br = this.canFillRecipe(b, inv, view.craftW) ? 0 : this.recipeFitsGrid(b, view.craftW) ? 1 : 2;
          return ar - br || def(a.out).label.localeCompare(def(b.out).label);
        });
      if (recipes.length === 0) {
        const empty = el('div', 'recipe-empty', bookGrid);
        empty.textContent = this.recipeFilter === 'ready' ? 'Nothing craftable yet - gather more materials!' : 'No recipes match';
      }
      const ready = recipes.filter((r) => this.canFillRecipe(r, inv, view.craftW)).length;
      countLbl.textContent = `${ready} craftable`;
      for (const r of recipes) {
        const canMake = this.canFillRecipe(r, inv, view.craftW);
        const fits = this.recipeFitsGrid(r, view.craftW);
        const cell = el('button', `recipe-card${canMake ? ' avail' : fits ? ' missing' : ' locked'}`, bookGrid);
        cell.type = 'button';
        cell.appendChild(this.iconCanvas({ id: r.out, count: r.n }));
        if (r.n > 1) this.countEl(cell, r.n);
        if (!fits) {
          const badge = el('span', 'recipe-badge', cell);
          badge.appendChild(scaled(GUI_ICONS.table(), 1));
        }
        // screen-reader / harness friendly name (visually the icon speaks for it)
        const name = el('span', 'recipe-name sr-only', cell);
        name.textContent = def(r.out).label;
        cell.setAttribute('aria-label', `${def(r.out).label}: ${this.recipeBlockedReason(r, inv, view.craftW)}`);
        const show = (): void => this.showRecipeDetail(detail, r, inv, view.craftW);
        cell.addEventListener('pointerenter', show);
        cell.addEventListener('focus', show);
        cell.onclick = (): void => {
          if (this.fillRecipe(r, view, inv)) {
            this.audio.play('select');
          } else {
            this.audio.play('fail');
            this.toast(this.recipeBlockedReason(r, inv, view.craftW));
          }
          rerender();
        };
      }
    };
    fillGrid();
    this.showRecipeDetail(detail, null, inv, view.craftW);
  }

  /** Stop in-game hotkeys (E closes, digits swap…) firing while typing. */
  private guardTyping(input: HTMLInputElement): void {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { input.blur(); return; }
      e.stopPropagation();
    });
    input.addEventListener('keyup', (e) => e.stopPropagation());
  }

  private sectionLabel(parent: HTMLElement, text: string): HTMLElement {
    const l = el('div', 'ctr-label', parent);
    l.textContent = text;
    return l;
  }

  /** 3-column slot grid helper, column count via CSS var. */
  private grid(parent: HTMLElement, cols: number, cls = ''): HTMLElement {
    const g = el('div', `ctr-grid${cls ? ` ${cls}` : ''}`, parent);
    g.style.setProperty('--cols', String(cols));
    return g;
  }

  private renderContainer(mode: GameMode): void {
    if (!this.view || !this.inv) return;
    const view = this.view;
    const inv = this.inv;
    this.viewMode = mode;
    if (!this.touchTipTimer) this.hideTooltip(); // a tapped stack's tooltip outlives the re-render
    this.hoverSlot = null;
    const scroll = (this.containerEl.querySelector('.main-panel') as HTMLElement | null)?.scrollTop ?? 0;
    const bookScroll = (this.containerEl.querySelector('.book-panel .recipe-grid') as HTMLElement | null)?.scrollTop ?? 0;
    const creativeScroll = (this.containerEl.querySelector('.creative-grid') as HTMLElement | null)?.scrollTop ?? 0;
    this.containerEl.innerHTML = '';
    const wrap = el('div', `ctr-wrap kind-${view.kind}`, this.containerEl);
    const hasBook = view.kind === 'inventory' || view.kind === 'table';
    const rerender = (): void => { this.renderContainer(mode); this.renderCursor(); };
    if (hasBook && this.settings.book) this.renderRecipeBook(wrap, view, inv, rerender);
    const panel = el('div', 'mc-panel main-panel', wrap);
    panel.setAttribute('role', 'dialog');

    // sticky header with the title + a tap/click close button (the only way to
    // close on touch, where there's no E/Esc key)
    const header = el('div', 'ctr-header', panel);
    const title = el('div', 'ctr-label ctr-title', header);
    title.textContent =
      view.kind === 'table' ? 'Crafting Table' :
      view.kind === 'furnace' ? 'Furnace' :
      view.kind === 'chest' ? 'Chest' :
      view.kind === 'trade' ? 'Villager Trades' :
      view.kind === 'creative' ? 'Creative Inventory' : 'Inventory';
    panel.setAttribute('aria-label', title.textContent);
    const hbtns = el('div', 'ctr-hbtns', header);
    if (hasBook) {
      const bk = el('button', `ctr-book${this.settings.book ? ' on' : ''}`, hbtns);
      bk.type = 'button';
      bk.title = this.settings.book ? 'Hide recipe book' : 'Show recipe book';
      bk.setAttribute('aria-label', bk.title);
      bk.setAttribute('aria-pressed', String(this.settings.book));
      bk.appendChild(scaled(GUI_ICONS.book(), 2));
      bk.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.settings.book = !this.settings.book;
        this.saveSettings();
        this.audio.play('click');
        rerender();
      });
    }
    const close = el('button', 'ctr-close', hbtns);
    close.textContent = '✕';
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('pointerdown', (e) => { e.preventDefault(); this.onCloseContainer(); });

    const playerSlot = (parent: HTMLElement, i: number): void => {
      this.slotEl(parent, inv.slots[i], (btn, shift) => {
        if (shift) this.quickMovePlayer(view, inv, i);
        else { this.clickSlot(inv.slots, i, btn); inv.onChange(); }
        rerender();
      }, '', { arr: inv.slots, i });
    };

    // --- trade section (villager) -------------------------------------------
    if (view.kind === 'trade' && view.trades) {
      const sec = el('div', 'ctr-section', panel);
      const list = el('div', 'trade-list', sec);
      for (let i = 0; i < view.trades.length; i++) {
        const t = view.trades[i];
        const lockedOut = t.uses >= t.max;
        const canAfford = !lockedOut && inv.count(t.give) >= t.giveCount;
        const row = el('div', `trade-row${lockedOut ? ' locked' : canAfford ? ' ok' : ' poor'}`, list);
        // give slot
        const giveSlot = el('div', 'mc-slot', row);
        giveSlot.appendChild(this.iconCanvas({ id: t.give, count: t.giveCount }));
        if (t.giveCount > 1) this.countEl(giveSlot, t.giveCount);
        el('div', 'gui-arrow small', row);
        // get slot
        const getSlot = el('div', 'mc-slot', row);
        getSlot.appendChild(this.iconCanvas({ id: t.get, count: t.getCount }));
        if (t.getCount > 1) this.countEl(getSlot, t.getCount);
        const info = el('div', 'trade-info', row);
        el('div', 'trade-name', info).textContent = def(t.get).label;
        el('div', 'trade-uses', info).textContent = lockedOut ? 'Out of stock' : `${t.max - t.uses} trades left · you have ${inv.count(t.give)} ${def(t.give).label}`;
        if (canAfford) {
          row.style.cursor = 'pointer';
          row.tabIndex = 0;
          const doTrade = (): void => {
            // perform the trade: remove give, add get
            let need = t.giveCount;
            for (let s = 0; s < inv.slots.length && need > 0; s++) {
              const sl = inv.slots[s];
              if (sl && sl.id === t.give) {
                const take = Math.min(need, sl.count);
                sl.count -= take; need -= take;
                if (sl.count <= 0) inv.slots[s] = null;
              }
            }
            inv.add(t.get, t.getCount);
            t.uses++;
            this.audio.play('level');
            this.onTrade();
            inv.onChange();
            rerender();
          };
          row.onclick = doTrade;
          row.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doTrade(); } };
        }
      }
      // then fall through to render the player inventory below
    }

    // --- chest section --------------------------------------------------------
    if (view.kind === 'chest' && view.chest) {
      const chest = view.chest;
      const sec = el('div', 'ctr-section', panel);
      const grid = this.grid(sec, 9);
      for (let i = 0; i < chest.slots.length; i++) {
        this.slotEl(grid, chest.slots[i], (btn, shift) => {
          if (shift) this.transfer(chest.slots, i, inv.slots, 0, 36);
          else this.clickSlot(chest.slots, i, btn);
          inv.onChange();
          rerender();
        }, '', { arr: chest.slots, i });
      }
    }

    // --- crafting section ---------------------------------------------------
    if (view.kind === 'inventory' || view.kind === 'table') {
      const craftArea = el('div', 'craft-area', panel);
      // worn-armor column + player preview (player inventory only)
      if (view.kind === 'inventory') {
        const armorCol = el('div', 'armor-col', craftArea);
        const armorNames = ['Helmet', 'Chestplate', 'Leggings', 'Boots'];
        for (let i = 0; i < 4; i++) {
          const s = this.slotEl(armorCol, inv.armor[i], (btn, shift) => {
            if (shift) { if (this.transfer(inv.armor, i, inv.slots, 0, 36)) inv.onChange(); }
            else this.clickArmorSlot(inv, i, btn);
            rerender();
          }, `armor-slot${inv.armor[i] ? '' : ` empty-${i}`}`);
          if (!inv.armor[i]) s.title = `${armorNames[i]} slot`;
        }
        const preview = el('div', 'player-preview', craftArea);
        const names = inv.armor.map((a) => (a ? def(a.id).name : null));
        preview.appendChild(scaled(drawPlayerFigure(names), 3));
        const pts = inv.armorPoints();
        if (pts > 0) el('div', 'preview-armor', preview).textContent = `Armor ${pts}`;
      }
      const craftBlock = el('div', 'craft-block', craftArea);
      this.sectionLabel(craftBlock, 'Crafting');
      const sec = el('div', 'craft-main', craftBlock);
      const grid = this.grid(sec, view.craftW);
      for (let i = 0; i < view.craftGrid.length; i++) {
        this.slotEl(grid, view.craftGrid[i], (btn, shift) => {
          if (shift) { if (this.transfer(view.craftGrid, i, inv.slots, 0, 36)) inv.onChange(); }
          else this.clickSlot(view.craftGrid, i, btn);
          rerender();
        }, '', { arr: view.craftGrid, i });
      }
      el('div', 'gui-arrow', sec);
      const result = matchRecipe(view.craftGrid, view.craftW);
      const resWrap = el('div', 'result-wrap', sec);
      this.slotEl(resWrap, result ? { id: result.id, count: result.count } : null, (btn, shift) => {
        void btn;
        if (!result) return;
        // a single consume of the grid (one craft); returns the result count made
        const craftOnce = (): number => {
          for (let i = 0; i < view.craftGrid.length; i++) {
            const s = view.craftGrid[i];
            if (s) { s.count--; if (s.count <= 0) view.craftGrid[i] = null; }
          }
          this.onCraft(result.id);
          return result.count;
        };
        if (shift) {
          // craft straight into the inventory, repeating while the grid still
          // makes the same item and there's room — the classic bulk-craft
          let made = false;
          while (matchRecipe(view.craftGrid, view.craftW)?.id === result.id) {
            const n = craftOnce();
            if (inv.add(result.id, n) > 0) break; // inventory full
            made = true;
          }
          if (made) { this.audio.play('craft'); inv.onChange(); }
          rerender();
          return;
        }
        const fits = !this.cursor ||
          (this.cursor.id === result.id && this.cursor.count + result.count <= def(result.id).stack);
        if (!fits) return;
        const n = craftOnce();
        if (!this.cursor) this.cursor = { id: result.id, count: n };
        else this.cursor.count += n;
        this.audio.play('craft');
        rerender();
      }, `result${result ? ' ready' : ''}`);
    }

    // --- furnace section ------------------------------------------------------
    if (view.kind === 'furnace' && view.furnace) {
      const f = view.furnace;
      const sec = el('div', 'ctr-section furnace-area', panel);

      const left = el('div', 'furnace-col', sec);
      this.slotEl(left, f.input, (btn, shift) => {
        const arr: Slot[] = [f.input];
        if (shift) this.transfer(arr, 0, inv.slots, 0, 36);
        else this.clickSlot(arr, 0, btn);
        f.input = arr[0];
        inv.onChange();
        rerender();
      }).title = 'Item to smelt';
      const flame = el('div', 'furnace-flame', left);
      flame.appendChild(scaled(GUI_ICONS.flameOut(), 2));
      el('div', 'fill', flame).appendChild(scaled(GUI_ICONS.flameLit(), 2));
      this.slotEl(left, f.fuel, (btn, shift) => {
        const arr: Slot[] = [f.fuel];
        if (shift) this.transfer(arr, 0, inv.slots, 0, 36);
        else this.clickSlot(arr, 0, btn);
        f.fuel = arr[0];
        inv.onChange();
        rerender();
      }).title = 'Fuel';

      const mid = el('div', 'furnace-col', sec);
      const arrow = el('div', 'gui-arrow furnace-arrow', mid);
      el('div', 'fill', arrow);

      const right = el('div', 'furnace-col', sec);
      this.slotEl(right, f.output, (btn, shift) => {
        const arr: Slot[] = [f.output];
        if (shift) this.transfer(arr, 0, inv.slots, 0, 36);
        else this.clickSlot(arr, 0, btn, true);
        f.output = arr[0];
        inv.onChange();
        rerender();
      }, 'result');
      this.furnaceSnapshot = JSON.stringify([f.input, f.fuel, f.output]);
      // prime the bars so they don't flash empty for a frame
      const fl = flame.firstElementChild as HTMLElement;
      fl.style.height = `${f.burnTotal > 0 ? Math.min(100, (f.burn / f.burnTotal) * 100) : 0}%`;
      (arrow.firstElementChild as HTMLElement).style.width = `${Math.min(100, (f.cook / SMELT_TIME) * 100)}%`;
    }

    // --- creative panel ---------------------------------------------------------
    if (view.kind === 'creative') {
      const tabs = el('div', 'creative-tabs', panel);
      tabs.setAttribute('role', 'tablist');
      const ctabs: { id: CreativeTab; label: string; icon: number }[] = [
        { id: 'all', label: 'Search Items', icon: I.COMPASS },
        { id: 'blocks', label: 'Building Blocks', icon: B.STONE_BRICKS },
        { id: 'tools', label: 'Tools & Combat', icon: I.IRON_PICK },
        { id: 'food', label: 'Foodstuffs', icon: I.APPLE },
        { id: 'utility', label: 'Miscellaneous', icon: I.LAVA_BUCKET },
        { id: 'inventory', label: 'Survival Inventory', icon: B.CHEST },
      ];
      for (const t of ctabs) {
        const b = el('button', `creative-tab${this.creativeFilter === t.id ? ' on' : ''}`, tabs);
        b.type = 'button';
        b.title = t.label;
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-label', t.label);
        b.setAttribute('aria-selected', String(this.creativeFilter === t.id));
        b.appendChild(this.iconCanvas({ id: t.icon, count: 1 }));
        b.onclick = () => {
          this.audio.play('click');
          this.creativeFilter = t.id;
          rerender();
        };
      }
      const sec = el('div', 'ctr-section', panel);
      if (this.creativeFilter !== 'inventory') {
        const tabName = ctabs.find((t) => t.id === this.creativeFilter)?.label ?? '';
        const row = el('div', 'creative-head', sec);
        this.sectionLabel(row, tabName);
        const searchBox = el('input', 'recipe-search menu-input', row) as HTMLInputElement;
        searchBox.type = 'search';
        searchBox.placeholder = 'Search blocks & items…';
        searchBox.setAttribute('aria-label', 'Search blocks and items');
        searchBox.value = this.creativeSearchQuery;
        searchBox.onfocus = () => { this.creativeSearchFocused = true; };
        searchBox.onblur = () => { this.creativeSearchFocused = false; };
        searchBox.oninput = () => {
          this.creativeSearchQuery = searchBox.value;
          fillPalette();
        };
        this.guardTyping(searchBox);
        if (this.creativeSearchFocused) {
          setTimeout(() => {
            searchBox.focus();
            searchBox.selectionStart = searchBox.selectionEnd = searchBox.value.length;
          }, 0);
        }
        const grid = this.grid(sec, 9, 'creative-grid');
        // only the palette re-renders while typing, so the search box keeps focus
        const fillPalette = (): void => {
          grid.innerHTML = '';
          const q = this.creativeSearchQuery.trim().toLowerCase();
          let shown = 0;
          for (const id of CREATIVE_ITEMS) {
            const d = def(id);
            const label = d.label.toLowerCase();
            if (q && !label.includes(q) && !d.name.toLowerCase().includes(q)) continue;
            const cat = d.toolInfo || d.bow || d.armor || id === I.FISHING_ROD ? 'tools'
              : d.food ? 'food'
              : d.block || id === I.WOOD_DOOR ? 'blocks'
              : 'utility';
            if (this.creativeFilter !== 'all' && cat !== this.creativeFilter) continue;
            shown++;
            this.slotEl(grid, { id, count: 1 }, (btn, shift) => {
              this.audio.play('click');
              const d = def(id);
              if (shift) { inv.add(id, d.stack); inv.onChange(); rerender(); return; }
              // clicking the palette while holding something just deletes it (vanilla)
              if (this.cursor && this.cursor.id !== id) { this.cursor = null; this.renderCursor(); return; }
              this.cursor = { id, count: btn === 2 ? 1 : d.stack };
              this.renderCursor();
            });
          }
          if (shown === 0) el('div', 'recipe-empty', grid).textContent = 'No items match your search';
        };
        fillPalette();
        setTimeout(() => { grid.scrollTop = creativeScroll; }, 0);
      } else {
        // survival inventory tab: armor + the full 27-slot grid
        const top = el('div', 'craft-area', sec);
        const armorCol = el('div', 'armor-col horizontal', top);
        for (let i = 0; i < 4; i++) {
          this.slotEl(armorCol, inv.armor[i], (btn, shift) => {
            if (shift) { if (this.transfer(inv.armor, i, inv.slots, 0, 36)) inv.onChange(); }
            else this.clickArmorSlot(inv, i, btn);
            rerender();
          }, `armor-slot${inv.armor[i] ? '' : ` empty-${i}`}`);
        }
        this.sectionLabel(sec, 'Inventory');
        const mainGrid = this.grid(sec, 9);
        for (let i = 9; i < 36; i++) playerSlot(mainGrid, i);
      }
      // hotbar row + the destroy-item slot (vanilla bottom-right trash)
      // (trash comes first in the DOM, CSS order puts it on the right, so the
      // hotbar stays the panel's last nine slots like every other screen)
      const hotRow = el('div', 'creative-hotrow', panel);
      const trash = this.slotEl(hotRow, null, () => {
        if (this.cursor) this.audio.play('click');
        this.cursor = null;
        this.renderCursor();
      }, 'trash-slot');
      trash.title = 'Destroy Item';
      trash.setAttribute('aria-label', 'Destroy item');
      trash.appendChild(scaled(GUI_ICONS.trash(), 2));
      const hotGrid = this.grid(hotRow, 9, 'hotbar-grid');
      for (let i = 0; i < 9; i++) playerSlot(hotGrid, i);
      this.renderCursor();
      return;
    }

    // --- main inventory (27) + hotbar (9) ----------------------------------------
    const mainSec = el('div', 'ctr-section inv-section', panel);
    this.sectionLabel(mainSec, 'Inventory');
    const mainGrid = this.grid(mainSec, 9);
    for (let i = 9; i < 36; i++) playerSlot(mainGrid, i);
    const hotSec = el('div', 'ctr-section hot-section', panel);
    const hotGrid = this.grid(hotSec, 9, 'hotbar-grid');
    for (let i = 0; i < 9; i++) playerSlot(hotGrid, i);

    panel.scrollTop = scroll;
    const bg = this.containerEl.querySelector('.book-panel .recipe-grid') as HTMLElement | null;
    if (bg) bg.scrollTop = bookScroll;
    this.renderCursor();
  }
}
