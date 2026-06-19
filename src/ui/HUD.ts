// All DOM UI: main menu with save slots, pause screen, crosshair, hotbar,
// hearts/hunger, F3 debug overlay, death screen, toasts, and the container
// screens (player 2x2 crafting, 3x3 crafting table, furnace, creative panel)
// with full cursor-stack slot interactions.

import { Atlas, drawHeart, drawShank, drawBubble, drawArmor } from '../engine/Textures';
import { Inventory, Slot, matchRecipe, FurnaceState, ChestState, SMELT_TIME, allRecipes, RecipeView } from '../engine/Inventory';
import { def, CREATIVE_ITEMS, I, B } from '../engine/Blocks';
import { SaveSummary, SlotData } from '../engine/Persistence';
import { AudioEngine } from '../engine/Audio';
import type { GameMode } from '../engine/Player';

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
}

type RecipeFilter = 'all' | 'ready' | 'tools' | 'blocks' | 'food' | 'utility';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

export class HUD {
  private root: HTMLElement;
  private atlas: Atlas;
  private audio: AudioEngine;

  private menu: HTMLElement;
  private hud: HTMLElement;
  private hotbarEl: HTMLElement;
  private armorEl: HTMLElement;
  private heartsEl: HTMLElement;
  private hungerEl: HTMLElement;
  private airEl!: HTMLElement;
  private itemNameEl!: HTMLElement;
  private itemNameTimer: ReturnType<typeof setTimeout> | null = null;
  private statsEl: HTMLElement;
  private debugEl: HTMLElement;
  private minimapEl: HTMLElement;
  private minimapCanvas: HTMLCanvasElement;
  private compassEl: HTMLElement;
  private clockEl: HTMLElement;
  private pauseEl: HTMLElement;
  private deathEl: HTMLElement;
  private containerEl: HTMLElement;
  private loadingEl: HTMLElement;
  private toastEl: HTMLElement;
  private cursorEl: HTMLElement;
  private vignette: HTMLElement;
  private lowhpEl!: HTMLElement;
  private sleepEl!: HTMLElement;
  private portalEl!: HTMLElement;
  private netherTintEl!: HTMLElement;
  private lowHealthEl!: HTMLElement;
  private packInput: HTMLInputElement;
  private worldInput: HTMLInputElement;

  cursor: Slot = null;
  private view: ContainerView | null = null;
  private inv: Inventory | null = null;
  private furnaceSnapshot = '';
  private lastHearts = '';
  private recipeFilter: RecipeFilter = 'all';
  private recipeSearchQuery = '';
  private recipeSearchFocused = false;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.hotbarEl = el('div', '', this.hud); this.hotbarEl.id = 'hotbar';
    this.statsEl = el('div', '', this.hud); this.statsEl.id = 'stats';
    this.armorEl = el('div', '', this.statsEl); this.armorEl.id = 'armor-bar';
    this.heartsEl = el('div', '', this.statsEl); this.heartsEl.id = 'hearts';
    this.hungerEl = el('div', '', this.statsEl); this.hungerEl.id = 'hunger';
    this.airEl = el('div', '', this.statsEl); this.airEl.id = 'air';
    this.itemNameEl = el('div', '', this.hud); this.itemNameEl.id = 'item-name';
    this.debugEl = el('div', 'hidden', this.hud); this.debugEl.id = 'debug';

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
    this.portalEl = el('div', '', root); this.portalEl.id = 'portal-fade';
    this.netherTintEl = el('div', '', root); this.netherTintEl.id = 'nether-tint';
    this.lowHealthEl = el('div', '', root); this.lowHealthEl.id = 'low-health';
    this.pauseEl = el('div', 'overlay hidden', root); this.pauseEl.id = 'pause-overlay';
    this.deathEl = el('div', 'overlay hidden', root); this.deathEl.id = 'death-overlay';
    this.containerEl = el('div', 'overlay hidden', root); this.containerEl.id = 'container-screen';
    this.loadingEl = el('div', 'overlay hidden', root); this.loadingEl.id = 'loading';
    this.toastEl = el('div', '', root); this.toastEl.id = 'toast';
    this.cursorEl = el('div', 'hidden', root); this.cursorEl.id = 'cursor-item';

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
  }

  private followCursor: (x: number, y: number) => void = () => {};

  // =========================================================================
  // Main menu
  // =========================================================================

  showMenu(saves: SaveSummary[], handlers: MenuHandlers): void {
    this.menu.classList.remove('hidden');
    this.menu.innerHTML = '';
    // dirt-texture backdrop from our generated tile
    const dirtURL = this.atlas.tileCanvas('dirt').toDataURL();
    this.menu.style.backgroundImage = `linear-gradient(rgba(0,0,0,0.62), rgba(0,0,0,0.62)), url(${dirtURL})`;
    this.menu.style.backgroundSize = 'auto, 64px 64px';

    const title = el('div', 'menu-title', this.menu);
    title.textContent = 'VOXELCRAFT';
    const sub = el('div', 'menu-sub', this.menu);
    sub.textContent = 'TypeScript + Three.js, from scratch!';

    const col = el('div', 'menu-col', this.menu);

    // attach UI sounds: a soft tick on hover, a click on press
    const wire = <T extends HTMLElement>(b: T): T => {
      b.addEventListener('mouseenter', () => this.audio.play('select'));
      b.addEventListener('mousedown', () => { this.audio.ensure(); this.audio.play('click'); });
      return b;
    };

    // --- create a new world ---------------------------------------------------
    let mode: GameMode = 'survival';
    const create = el('div', 'menu-card', col);
    const ch = el('div', 'card-head', create); ch.textContent = 'Create New World';
    const used = new Set(saves.map((s) => s.slot));
    let next = 1; while (used.has(`World ${next}`)) next++;
    const nameInput = el('input', 'menu-input', create) as HTMLInputElement;
    nameInput.type = 'text'; nameInput.maxLength = 32; nameInput.placeholder = `World name (e.g. World ${next})`;
    const seedInput = el('input', 'menu-input', create) as HTMLInputElement;
    seedInput.type = 'text'; seedInput.placeholder = 'Seed (leave blank for random)';
    const modePick = el('div', 'mode-pick', create);
    const mkMode = (m: GameMode, label: string): HTMLButtonElement => {
      const b = wire(el('button', `mc-btn small${m === mode ? ' on' : ''}`, modePick));
      b.textContent = label;
      b.onclick = () => {
        mode = m;
        modePick.querySelectorAll('.mc-btn').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
      };
      return b;
    };
    mkMode('survival', 'Survival');
    mkMode('creative', 'Creative');
    const createBtn = wire(el('button', 'mc-btn create-btn', create));
    createBtn.textContent = 'Create World';
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

    // --- existing worlds ------------------------------------------------------
    const listHead = el('div', 'card-head', col); listHead.textContent = 'Your Worlds';
    const list = el('div', 'world-list', col);
    const sorted = [...saves].sort((a, b) => b.lastPlayed - a.lastPlayed);
    if (sorted.length === 0) {
      el('div', 'world-empty', list).textContent = 'No worlds yet — create one above.';
    }
    for (const info of sorted) {
      const row = el('div', 'world-row', list);
      const name = el('div', 'wname', row);
      name.textContent = info.slot;
      const meta = el('span', 'wmeta', name);
      meta.textContent = `${info.gameMode} · seed ${info.seed} · ${new Date(info.lastPlayed).toLocaleDateString()}`;
      const play = wire(el('button', 'mc-btn small', row));
      play.textContent = 'Play';
      play.onclick = () => { this.audio.ensure(); handlers.onPlay(info.slot, null); };
      const exp = wire(el('button', 'mc-btn small', row));
      exp.textContent = 'Export';
      exp.title = 'Download this world as a .json file you can re-import elsewhere';
      exp.onclick = () => handlers.onExport(info.slot);
      const del = wire(el('button', 'mc-btn small danger', row));
      del.textContent = 'Delete';
      del.onclick = () => { if (confirm(`Delete "${info.slot}"? This cannot be undone.`)) handlers.onDelete(info.slot); };
    }

    const toolRow = el('div', 'menu-row', this.menu);
    toolRow.style.marginTop = '14px';
    const packBtn = wire(el('button', 'mc-btn small', toolRow));
    packBtn.textContent = 'Texture Pack…';
    packBtn.title = 'Apply an unzipped Minecraft Java texture-pack FOLDER (changes how blocks look — not a world or seed)';
    packBtn.onclick = () => { this.packHandler = handlers.onPack; this.packInput.click(); };
    const importBtn = wire(el('button', 'mc-btn small', toolRow));
    importBtn.textContent = 'Import World (.json)…';
    importBtn.title = 'Load a world .json FILE exported with the Export button (here or from another machine)';
    importBtn.onclick = () => { this.importHandler = handlers.onImport; this.worldInput.click(); };

    // concise control hints (full details live in F3 / tooltips)
    const help = el('div', 'menu-help', this.menu);
    help.innerHTML =
      '<b>WASD</b> move · <b>Space</b> jump · <b>Shift</b> sprint · <b>F</b> fly · <b>E</b> inventory<br>' +
      '<b>LMB</b> break · <b>RMB</b> place / use · <b>1–9</b> + scroll hotbar · <b>Esc</b> pause';

    const foot = el('div', 'menu-foot', this.menu);
    foot.textContent = 'Voxelcraft — a from-scratch Minecraft in TypeScript + Three.js. Every texture, sound & world is generated in code.';
  }

  hideMenu(): void { this.menu.classList.add('hidden'); }

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
    this.hideAdvancements();
  }

  /** Tapping a hotbar slot selects it (mobile-friendly; harmless on desktop). */
  onHotbarSelect: (i: number) => void = () => {};
  /** Close button on a container panel (so touch devices can close it). */
  onCloseContainer: () => void = () => {};

  refreshHotbar(inv: Inventory, mode: GameMode): void {
    this.hotbarEl.innerHTML = '';
    for (let i = 0; i < 9; i++) {
      const s = el('div', `hotbar-slot${i === inv.selected ? ' selected' : ''}`, this.hotbarEl);
      const item = inv.slots[i];
      if (item) {
        s.appendChild(this.iconCanvas(item));
        if (item.count > 1 && mode !== 'creative') {
          const c = el('span', 'slot-count', s);
          c.textContent = String(item.count);
        }
      }
      s.addEventListener('pointerdown', (e) => { e.preventDefault(); this.onHotbarSelect(i); });
    }
  }

  updateStats(hp: number, hunger: number, air: number, mode: GameMode, armor = 0): void {
    if (mode === 'creative') {
      this.statsEl.style.visibility = 'hidden';
      this.lowhpEl.classList.remove('on');
      this.hungerEl.classList.remove('shake');
      return;
    }
    this.statsEl.style.visibility = 'visible';
    // low-health red pulse + starving hunger shake
    this.lowhpEl.classList.toggle('on', hp > 0 && hp <= 6);
    this.hungerEl.classList.toggle('shake', hunger > 0 && hunger <= 6);
    const key = `${hp}|${hunger}|${air}|${armor}`;
    if (key === this.lastHearts) return;
    this.lastHearts = key;
    this.armorEl.innerHTML = '';
    this.heartsEl.innerHTML = '';
    this.hungerEl.innerHTML = '';
    this.airEl.innerHTML = '';
    // armor bar (only shown when wearing armor); each icon = 2 defense points
    if (armor > 0) {
      for (let i = 0; i < 10; i++) {
        const av = armor - i * 2;
        const icon = drawArmor(av >= 2 ? 'full' : av === 1 ? 'half' : 'empty');
        icon.className = 'stat-icon';
        this.armorEl.appendChild(icon);
      }
    }
    for (let i = 0; i < 10; i++) {
      const hv = hp - i * 2;
      const heart = drawHeart(hv >= 2 ? 'full' : hv === 1 ? 'half' : 'empty');
      heart.className = 'stat-icon';
      this.heartsEl.appendChild(heart);
      const fv = hunger - i * 2;
      const shank = drawShank(fv >= 2 ? 'full' : fv === 1 ? 'half' : 'empty');
      shank.className = 'stat-icon';
      this.hungerEl.appendChild(shank);
    }
    // air bubbles only while submerged / recovering
    if (air < 20) {
      for (let i = 0; i < Math.ceil(air / 2); i++) {
        const bubble = drawBubble();
        bubble.className = 'stat-icon';
        this.airEl.appendChild(bubble);
      }
    }
  }

  /** Item-name popup shown above the hotbar when the selection changes. */
  showItemName(label: string): void {
    this.itemNameEl.textContent = label;
    this.itemNameEl.classList.add('show');
    if (this.itemNameTimer) clearTimeout(this.itemNameTimer);
    this.itemNameTimer = setTimeout(() => this.itemNameEl.classList.remove('show'), 1400);
  }

  /** Black-screen sleep transition: fade to black, run `onDark` (skip to
   *  morning) at the darkest point, then fade back in and run `onWake`. */
  sleepFade(onDark: () => void, onWake: () => void): void {
    this.sleepEl.classList.add('on');
    window.setTimeout(() => {
      onDark();
      window.setTimeout(() => {
        this.sleepEl.classList.remove('on');
        window.setTimeout(onWake, 700);
      }, 400);
    }, 700);
  }

  setPortalFade(amount: number): void {
    this.portalEl.style.opacity = String(Math.max(0, Math.min(1, amount)));
  }

  setNetherTint(on: boolean): void {
    this.netherTintEl.style.opacity = on ? '1' : '0';
  }

  /** hpFrac = health/maxHealth; a red vignette fades in below 30% health. */
  setLowHealth(hpFrac: number): void {
    const a = hpFrac > 0.3 || hpFrac <= 0 ? 0 : (0.3 - hpFrac) / 0.3;
    this.lowHealthEl.style.opacity = String(a * 0.85);
  }

  setDebugVisible(v: boolean): void { this.debugEl.classList.toggle('hidden', !v); }
  isDebugVisible(): boolean { return !this.debugEl.classList.contains('hidden'); }

  updateDebug(lines: string[]): void {
    this.debugEl.innerHTML = lines.map((l) => `<span>${l}</span>`).join('<br>');
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
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(0, -5); ctx.lineTo(3, 4); ctx.lineTo(-3, 4); ctx.closePath();
    ctx.fill();
    ctx.restore();
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
      this.clockEl.textContent = `Clock ${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
      this.clockEl.title = 'Clock: carry one to show world time';
      this.clockEl.style.display = 'block';
    } else {
      this.clockEl.style.display = 'none';
    }
  }

  toast(msg: string): void {
    this.toastEl.textContent = msg;
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
    }
    this.advToastEl.innerHTML = '';
    const top = el('div', 'adv-top', this.advToastEl);
    top.textContent = 'Advancement Made!';
    const body = el('div', 'adv-body', this.advToastEl);
    const ic = el('span', 'adv-icon', body);
    ic.textContent = next.icon;
    const lbl = el('span', 'adv-label', body);
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
    const title = el('div', 'ctr-label', panel);
    title.style.fontSize = '16px';
    title.style.marginBottom = '12px';
    const done = list.filter((a) => a.done).length;
    title.textContent = `Advancements  (${done}/${list.length})`;
    const listEl = el('div', 'adv-list', panel);
    for (const a of list) {
      const row = el('div', `adv-row${a.done ? ' done' : ''}`, listEl);
      const ic = el('span', 'adv-row-icon', row);
      ic.textContent = a.done ? a.icon : '🔒';
      const text = el('div', 'adv-row-text', row);
      const name = el('div', 'adv-row-name', text);
      name.textContent = a.label;
      const desc = el('div', 'adv-row-desc', text);
      desc.textContent = a.desc;
    }
    const hint = el('div', 'adv-hint', panel);
    hint.textContent = 'Press L to close';
  }

  hideAdvancements(): void {
    if (this.advPanel) { this.advPanel.remove(); this.advPanel = null; }
  }

  isAdvancementsOpen(): boolean { return this.advPanel !== null; }

  showLoading(text: string): void {
    this.loadingEl.classList.remove('hidden');
    this.loadingEl.textContent = text;
  }
  hideLoading(): void { this.loadingEl.classList.add('hidden'); }

  // =========================================================================
  // Pause
  // =========================================================================

  showPause(h: PauseHandlers, mode: GameMode, viewDist: number): void {
    this.pauseEl.classList.remove('hidden');
    this.pauseEl.innerHTML = '';
    const title = el('h2', '', this.pauseEl);
    title.textContent = 'Game Paused';
    const col = el('div', 'menu-col', this.pauseEl);

    const resume = el('button', 'mc-btn', col);
    resume.textContent = 'Back to Game';
    resume.onclick = () => { this.audio.play('click'); h.onResume(); };

    const save = el('button', 'mc-btn', col) as HTMLButtonElement;
    save.textContent = 'Save Game';
    save.onclick = async () => {
      this.audio.play('click');
      save.textContent = 'Saving...';
      save.disabled = true;
      const ok = await h.onSave();
      save.textContent = ok ? 'Saved ✓' : 'Save failed';
      setTimeout(() => { save.textContent = 'Save Game'; save.disabled = false; }, 1200);
    };

    const modeBtn = el('button', 'mc-btn', col);
    modeBtn.textContent = `Mode: ${mode === 'survival' ? 'Survival' : 'Creative'}`;
    modeBtn.onclick = () => { this.audio.play('click'); h.onToggleMode(); };

    const vd = el('div', 'menu-row', col);
    vd.append('Render distance: ');
    for (const n of [6, 8, 10, 12]) {
      const b = el('button', `mc-btn small${n === viewDist ? ' on' : ''}`, vd);
      b.textContent = String(n);
      b.onclick = () => { this.audio.play('click'); h.onViewDist(n); };
      if (n === viewDist) b.style.background = 'linear-gradient(#5f8f5f, #4d7a4d)';
    }

    const av = el('div', 'menu-row', col);
    const music = el('button', 'mc-btn small', av);
    music.textContent = `Music: ${h.musicOn() ? 'On' : 'Off'}`;
    music.onclick = () => { this.audio.play('click'); h.onToggleMusic(); };
    const sound = el('button', 'mc-btn small', av);
    sound.textContent = `Sounds: ${h.soundOn() ? 'On' : 'Off'}`;
    sound.onclick = () => { this.audio.play('click'); h.onToggleSound(); };

    const pack = el('button', 'mc-btn', col);
    pack.textContent = 'Load Resource Pack';
    pack.onclick = () => { this.packHandler = h.onPack; this.packInput.click(); };

    const quit = el('button', 'mc-btn', col);
    quit.textContent = 'Save and Quit to Title';
    quit.onclick = () => {
      this.audio.play('click');
      quit.textContent = 'Saving...';
      (quit as HTMLButtonElement).disabled = true;
      h.onSaveQuit();
    };
  }

  hidePause(): void { this.pauseEl.classList.add('hidden'); }
  isPauseOpen(): boolean { return !this.pauseEl.classList.contains('hidden'); }

  // =========================================================================
  // Death
  // =========================================================================

  showDeath(onRespawn: () => void, onTitle: () => void): void {
    this.deathEl.classList.remove('hidden');
    this.deathEl.innerHTML = '';
    const t = el('div', 'death-title', this.deathEl);
    t.textContent = 'You died!';
    const col = el('div', 'menu-col', this.deathEl);
    const r = el('button', 'mc-btn', col);
    r.textContent = 'Respawn';
    r.onclick = () => { this.audio.play('click'); onRespawn(); };
    const q = el('button', 'mc-btn', col);
    q.textContent = 'Title Screen';
    q.onclick = () => { this.audio.play('click'); onTitle(); };
  }
  hideDeath(): void { this.deathEl.classList.add('hidden'); }

  // =========================================================================
  // Containers
  // =========================================================================

  isContainerOpen(): boolean { return this.view !== null; }

  openContainer(view: ContainerView, inv: Inventory, mode: GameMode): void {
    this.view = view;
    this.inv = inv;
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
    this.containerEl.classList.add('hidden');
    this.cursorEl.classList.add('hidden');
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

  private iconCanvas(item: SlotData): HTMLCanvasElement {
    const src = this.atlas.icon(item.id);
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(src, 0, 0);
    // durability bar for worn tools
    const d = def(item.id);
    if (d.durability && item.dur !== undefined && item.dur < d.durability) {
      const ratio = Math.max(0, item.dur / d.durability);
      ctx.fillStyle = '#000000';
      ctx.fillRect(2, 28, 28, 4);
      ctx.fillStyle = `hsl(${Math.round(ratio * 120)}, 95%, 48%)`;
      ctx.fillRect(2, 28, Math.max(1, Math.round(28 * ratio)), 3);
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
    if (this.cursor.count > 1) {
      const c = el('span', 'slot-count', this.cursorEl);
      c.textContent = String(this.cursor.count);
    }
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
        this.cursor = { id: s.id, count: half };
        s.count -= half;
        if (s.count <= 0) arr[i] = null;
      } else if (this.cursor) {
        if (!s) {
          arr[i] = { id: this.cursor.id, count: 1 };
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

  private slotEl(parent: HTMLElement, item: Slot, onClick: (button: number) => void): void {
    const s = el('div', 'mc-slot', parent);
    if (item) {
      s.appendChild(this.iconCanvas(item));
      s.title = def(item.id).label;
      if (item.count > 1) {
        const c = el('span', 'slot-count', s);
        c.textContent = String(item.count);
      }
    }
    // pointerdown fires reliably on touch (a tap) and mouse; move the held-item
    // cursor to the tap point first so it's visible where the finger is
    s.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.followCursor(e.clientX, e.clientY);
      onClick(e.button);
    });
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
      chip.textContent = `${have}/${need.count} ${def(need.id).label}`;
    }
  }

  private renderContainer(mode: GameMode): void {
    if (!this.view || !this.inv) return;
    const view = this.view;
    const inv = this.inv;
    this.containerEl.innerHTML = '';
    const panel = el('div', 'mc-panel', this.containerEl);
    const rerender = (): void => { this.renderContainer(mode); this.renderCursor(); };

    // sticky header with the title + a tap/click close button (the only way to
    // close on touch, where there's no E/Esc key)
    const header = el('div', 'ctr-header', panel);
    const title = el('div', 'ctr-label', header);
    title.style.fontSize = '14px';
    title.textContent =
      view.kind === 'table' ? 'Crafting Table' :
      view.kind === 'furnace' ? 'Furnace' :
      view.kind === 'chest' ? 'Chest' :
      view.kind === 'trade' ? 'Villager Trades' :
      view.kind === 'creative' ? 'Creative Inventory' : 'Inventory';
    const close = el('button', 'ctr-close', header);
    close.textContent = '✕';
    close.title = 'Close';
    close.addEventListener('pointerdown', (e) => { e.preventDefault(); this.onCloseContainer(); });

    // --- trade section (villager) -------------------------------------------
    if (view.kind === 'trade' && view.trades) {
      const sec = el('div', 'ctr-section', panel);
      const list = el('div', 'trade-list', sec);
      for (let i = 0; i < view.trades.length; i++) {
        const t = view.trades[i];
        const lockedOut = t.uses >= t.max;
        const canAfford = !lockedOut && inv.count(t.give) >= t.giveCount;
        const row = el('div', `trade-row${lockedOut ? ' locked' : canAfford ? '' : ' poor'}`, list);
        // give slot
        const giveSlot = el('div', 'mc-slot', row);
        giveSlot.appendChild(this.iconCanvas({ id: t.give, count: t.giveCount }));
        const arrow = el('div', 'trade-arrow', row);
        arrow.textContent = '→';
        // get slot
        const getSlot = el('div', 'mc-slot', row);
        getSlot.appendChild(this.iconCanvas({ id: t.get, count: t.getCount }));
        if (canAfford) {
          row.style.cursor = 'pointer';
          row.onclick = () => {
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
        }
      }
      // then fall through to render the player inventory below
    }

    // --- chest section --------------------------------------------------------
    if (view.kind === 'chest' && view.chest) {
      const chest = view.chest;
      const sec = el('div', 'ctr-section', panel);
      const grid = el('div', 'ctr-grid', sec);
      grid.style.gridTemplateColumns = 'repeat(9, 48px)';
      for (let i = 0; i < chest.slots.length; i++) {
        this.slotEl(grid, chest.slots[i], (btn) => {
          this.clickSlot(chest.slots, i, btn);
          rerender();
        });
      }
    }

    // --- crafting section ---------------------------------------------------
    if (view.kind === 'inventory' || view.kind === 'table') {
      const craftArea = el('div', 'craft-area', panel);
      // worn-armor column (player inventory only): click to equip/unequip
      if (view.kind === 'inventory') {
        const armorCol = el('div', 'ctr-section armor-col', craftArea);
        for (let i = 0; i < 4; i++) {
          this.slotEl(armorCol, inv.armor[i], (btn) => {
            this.clickArmorSlot(inv, i, btn);
            rerender();
          });
        }
      }
      const sec = el('div', 'ctr-section ctr-flex craft-main', craftArea);
      const grid = el('div', 'ctr-grid', sec);
      grid.style.gridTemplateColumns = `repeat(${view.craftW}, 48px)`;
      for (let i = 0; i < view.craftGrid.length; i++) {
        this.slotEl(grid, view.craftGrid[i], (btn) => {
          this.clickSlot(view.craftGrid, i, btn);
          rerender();
        });
      }
      const arrow = el('div', 'craft-arrow', sec);
      arrow.textContent = '→';
      const result = matchRecipe(view.craftGrid, view.craftW);
      const resWrap = el('div', '', sec);
      this.slotEl(resWrap, result ? { id: result.id, count: result.count } : null, (btn) => {
        void btn;
        if (!result) return;
        const fits = !this.cursor ||
          (this.cursor.id === result.id && this.cursor.count + result.count <= def(result.id).stack);
        if (!fits) return;
        if (!this.cursor) this.cursor = { id: result.id, count: result.count };
        else this.cursor.count += result.count;
        for (let i = 0; i < view.craftGrid.length; i++) {
          const s = view.craftGrid[i];
          if (s) {
            s.count--;
            if (s.count <= 0) view.craftGrid[i] = null;
          }
        }
        this.audio.play('craft');
        this.onCraft(result.id);
        rerender();
      });

      // --- recipe book sidebar: click a recipe to auto-fill the grid --------
      const bookWrap = el('div', 'recipe-book', craftArea);
      const bookTitle = el('div', 'ctr-label', bookWrap);
      bookTitle.textContent = 'Recipe Book';

      const searchBox = el('input', 'recipe-search', bookWrap) as HTMLInputElement;
      searchBox.type = 'text';
      searchBox.placeholder = 'Search...';
      searchBox.value = this.recipeSearchQuery;
      searchBox.onfocus = () => { this.recipeSearchFocused = true; };
      searchBox.onblur = () => { this.recipeSearchFocused = false; };
      searchBox.oninput = () => {
        this.recipeSearchQuery = searchBox.value.toLowerCase();
        rerender();
      };
      if (this.recipeSearchFocused) {
        setTimeout(() => {
          searchBox.focus();
          searchBox.selectionStart = searchBox.selectionEnd = searchBox.value.length;
        }, 0);
      }

      const filters = el('div', 'recipe-filters', bookWrap);
      const filterLabels: { id: RecipeFilter; label: string }[] = [
        { id: 'all', label: 'All' },
        { id: 'ready', label: 'Ready' },
        { id: 'tools', label: 'Tools' },
        { id: 'blocks', label: 'Blocks' },
        { id: 'food', label: 'Food' },
        { id: 'utility', label: 'Utility' },
      ];
      for (const f of filterLabels) {
        const b = el('button', `recipe-filter${this.recipeFilter === f.id ? ' on' : ''}`, filters);
        b.textContent = f.label;
        b.onclick = () => {
          this.recipeFilter = f.id;
          this.audio.play('select');
          rerender();
        };
      }
      const bookGrid = el('div', 'recipe-grid', bookWrap);
      const recipes = allRecipes()
        .filter((r) => this.recipeVisible(r, inv, view.craftW))
        .sort((a, b) => {
          const ar = this.canFillRecipe(a, inv, view.craftW) ? 0 : 1;
          const br = this.canFillRecipe(b, inv, view.craftW) ? 0 : 1;
          return ar - br || def(a.out).label.localeCompare(def(b.out).label);
        });
      if (recipes.length === 0) {
        const empty = el('div', 'recipe-empty', bookGrid);
        empty.textContent = this.recipeFilter === 'ready' ? 'No craftable recipes yet' : 'No recipes in this view';
      }
      for (const r of recipes) {
        const canMake = this.canFillRecipe(r, inv, view.craftW);
        const fits = this.recipeFitsGrid(r, view.craftW);
        const cell = el('div', `recipe-card${canMake ? ' avail' : fits ? '' : ' locked'}`, bookGrid);
        const out = el('div', 'recipe-out', cell);
        out.appendChild(this.iconCanvas({ id: r.out, count: r.n }));
        if (r.n > 1) {
          const c = el('span', 'slot-count', out);
          c.textContent = String(r.n);
        }
        this.recipePatternEl(r, cell);
        const text = el('div', 'recipe-text', cell);
        const name = el('div', 'recipe-name', text);
        name.textContent = def(r.out).label;
        this.recipeNeedsEl(r, inv, text);
        cell.title = this.recipeBlockedReason(r, inv, view.craftW);
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
    }

    // --- furnace section ------------------------------------------------------
    if (view.kind === 'furnace' && view.furnace) {
      const f = view.furnace;
      const sec = el('div', 'ctr-section ctr-flex', panel);

      const left = el('div', 'furnace-col', sec);
      this.slotEl(left, f.input, (btn) => {
        const arr: Slot[] = [f.input];
        this.clickSlot(arr, 0, btn);
        f.input = arr[0];
        rerender();
      });
      const flame = el('div', 'furnace-flame', left);
      el('div', 'fill', flame);
      this.slotEl(left, f.fuel, (btn) => {
        const arr: Slot[] = [f.fuel];
        this.clickSlot(arr, 0, btn);
        f.fuel = arr[0];
        rerender();
      });

      const mid = el('div', 'furnace-col', sec);
      const arrow = el('div', 'furnace-arrow', mid);
      el('div', 'fill', arrow);

      const right = el('div', 'furnace-col', sec);
      this.slotEl(right, f.output, (btn) => {
        const arr: Slot[] = [f.output];
        this.clickSlot(arr, 0, btn, true);
        f.output = arr[0];
        rerender();
      });
      this.furnaceSnapshot = JSON.stringify([f.input, f.fuel, f.output]);
    }

    // --- creative panel ---------------------------------------------------------
    if (view.kind === 'creative') {
      const sec = el('div', 'ctr-section', panel);
      const grid = el('div', 'creative-grid', sec);
      for (const id of CREATIVE_ITEMS) {
        this.slotEl(grid, { id, count: 1 }, (btn) => {
          this.audio.play('click');
          const d = def(id);
          this.cursor = { id, count: btn === 2 ? 1 : d.stack };
          this.renderCursor();
        });
      }
      const trashRow = el('div', 'ctr-flex', sec);
      trashRow.style.marginTop = '8px';
      const lbl = el('div', 'ctr-label', trashRow);
      lbl.textContent = 'Clear cursor:';
      this.slotEl(trashRow, null, () => {
        this.cursor = null;
        this.renderCursor();
      });
    }

    // --- main inventory (27) + hotbar (9) ----------------------------------------
    const mainSec = el('div', 'ctr-section', panel);
    const mainGrid = el('div', 'ctr-grid', mainSec);
    mainGrid.style.gridTemplateColumns = 'repeat(9, 48px)';
    for (let i = 9; i < 36; i++) {
      this.slotEl(mainGrid, inv.slots[i], (btn) => {
        this.clickSlot(inv.slots, i, btn);
        inv.onChange();
        rerender();
      });
    }
    const hotSec = el('div', 'ctr-section', panel);
    hotSec.style.marginTop = '10px';
    const hotGrid = el('div', 'ctr-grid', hotSec);
    hotGrid.style.gridTemplateColumns = 'repeat(9, 48px)';
    for (let i = 0; i < 9; i++) {
      this.slotEl(hotGrid, inv.slots[i], (btn) => {
        this.clickSlot(inv.slots, i, btn);
        inv.onChange();
        rerender();
      });
    }

    this.renderCursor();
  }
}
