// All DOM UI: main menu with save slots, pause screen, crosshair, hotbar,
// hearts/hunger, F3 debug overlay, death screen, toasts, and the container
// screens (player 2x2 crafting, 3x3 crafting table, furnace, creative panel)
// with full cursor-stack slot interactions.

import { Atlas, drawHeart, drawShank, drawBubble } from '../engine/Textures';
import { Inventory, Slot, matchRecipe, FurnaceState, ChestState, SMELT_TIME } from '../engine/Inventory';
import { def, CREATIVE_ITEMS } from '../engine/Blocks';
import { SaveSummary, SlotData } from '../engine/Persistence';
import { AudioEngine } from '../engine/Audio';
import type { GameMode } from '../engine/Player';

export type ContainerKind = 'inventory' | 'table' | 'furnace' | 'chest' | 'creative';

export interface ContainerView {
  kind: ContainerKind;
  craftW: number;          // 2 or 3 (0 if none)
  craftGrid: Slot[];
  furnace: FurnaceState | null;
  chest: ChestState | null;
}

export interface MenuHandlers {
  onPlay: (slot: string, fresh: { seed: number; mode: GameMode } | null) => void;
  onDelete: (slot: string) => void;
  onPack: (files: File[]) => void;
}

export interface PauseHandlers {
  onResume: () => void;
  onSave: () => Promise<boolean>;
  onSaveQuit: () => void;
  onToggleMode: () => void;
  onViewDist: (n: number) => void;
  onPack: (files: File[]) => void;
}

const SLOTS = ['World_1', 'World_2', 'World_3'];

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
  private heartsEl: HTMLElement;
  private hungerEl: HTMLElement;
  private airEl!: HTMLElement;
  private itemNameEl!: HTMLElement;
  private itemNameTimer: ReturnType<typeof setTimeout> | null = null;
  private statsEl: HTMLElement;
  private debugEl: HTMLElement;
  private pauseEl: HTMLElement;
  private deathEl: HTMLElement;
  private containerEl: HTMLElement;
  private loadingEl: HTMLElement;
  private toastEl: HTMLElement;
  private cursorEl: HTMLElement;
  private vignette: HTMLElement;
  private packInput: HTMLInputElement;

  cursor: Slot = null;
  private view: ContainerView | null = null;
  private inv: Inventory | null = null;
  private furnaceSnapshot = '';
  private lastHearts = '';
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private packHandler: (files: File[]) => void = () => {};
  /** main sets this: leftover items that can't return to the inventory drop here */
  onDropLeftover: (id: number, count: number) => void = () => {};

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
    this.heartsEl = el('div', '', this.statsEl); this.heartsEl.id = 'hearts';
    this.hungerEl = el('div', '', this.statsEl); this.hungerEl.id = 'hunger';
    this.airEl = el('div', '', this.statsEl); this.airEl.id = 'air';
    this.itemNameEl = el('div', '', this.hud); this.itemNameEl.id = 'item-name';
    this.debugEl = el('div', 'hidden', this.hud); this.debugEl.id = 'debug';

    this.vignette = el('div', '', root); this.vignette.id = 'vignette';
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

    document.addEventListener('mousemove', (e) => {
      this.cursorEl.style.left = `${e.clientX - 18}px`;
      this.cursorEl.style.top = `${e.clientY - 18}px`;
    });
  }

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

    const byName = new Map(saves.map((s) => [s.slot, s]));
    const col = el('div', 'menu-col', this.menu);

    // new-world options
    let mode: GameMode = 'survival';
    const opts = el('div', 'menu-opts');
    opts.append('Seed:');
    const seedInput = el('input') as HTMLInputElement;
    seedInput.type = 'text';
    seedInput.placeholder = 'random';
    opts.appendChild(seedInput);
    const modePick = el('div', 'mode-pick', opts);
    const mkMode = (m: GameMode, label: string): HTMLButtonElement => {
      const b = el('button', `mc-btn small${m === mode ? ' on' : ''}`, modePick);
      b.textContent = label;
      b.onclick = () => {
        mode = m;
        this.audio.play('click');
        modePick.querySelectorAll('.mc-btn').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
      };
      return b;
    };
    mkMode('survival', 'Survival');
    mkMode('creative', 'Creative');

    for (const slot of SLOTS) {
      const row = el('div', 'world-row', col);
      const info = byName.get(slot);
      const name = el('div', 'wname', row);
      if (info) {
        name.textContent = slot.replace('_', ' ');
        const meta = el('span', 'wmeta', name);
        meta.textContent = `${info.gameMode} · seed ${info.seed} · ${new Date(info.lastPlayed).toLocaleString()}`;
        const play = el('button', 'mc-btn small', row);
        play.textContent = 'Play';
        play.onclick = () => { this.audio.ensure(); this.audio.play('click'); handlers.onPlay(slot, null); };
        const del = el('button', 'mc-btn small danger', row);
        del.textContent = 'Delete';
        del.onclick = () => {
          this.audio.play('click');
          if (confirm(`Delete ${slot}?`)) handlers.onDelete(slot);
        };
      } else {
        name.textContent = `${slot.replace('_', ' ')} — empty`;
        const create = el('button', 'mc-btn small', row);
        create.textContent = 'Create';
        create.onclick = () => {
          this.audio.ensure(); this.audio.play('click');
          const raw = seedInput.value.trim();
          let seed: number;
          if (!raw) seed = (Math.random() * 0x7fffffff) | 0;
          else if (/^-?\d+$/.test(raw)) seed = parseInt(raw, 10) | 0;
          else { seed = 0; for (const ch of raw) seed = (Math.imul(seed, 31) + ch.charCodeAt(0)) | 0; }
          handlers.onPlay(slot, { seed, mode });
        };
      }
    }

    col.appendChild(opts);

    const packRow = el('div', 'menu-row', this.menu);
    packRow.style.marginTop = '14px';
    const packBtn = el('button', 'mc-btn small', packRow);
    packBtn.textContent = 'Load Resource Pack (folder)';
    packBtn.onclick = () => { this.packHandler = handlers.onPack; this.packInput.click(); };

    const help = el('div', 'menu-help', this.menu);
    help.innerHTML =
      'WASD move · double-W / Ctrl sprint · Shift sneak · Space jump<br>' +
      'LMB break / attack · RMB place / use / eat · E inventory · 1-9 + scroll hotbar<br>' +
      'F or double-Space (creative) fly · F3 debug · Esc pause<br>' +
      'Resource packs: pick an <i>unzipped</i> pack folder containing assets/minecraft/textures';
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
  }

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
    }
  }

  updateStats(hp: number, hunger: number, air: number, mode: GameMode): void {
    if (mode === 'creative') {
      this.statsEl.style.visibility = 'hidden';
      return;
    }
    this.statsEl.style.visibility = 'visible';
    const key = `${hp}|${hunger}|${air}`;
    if (key === this.lastHearts) return;
    this.lastHearts = key;
    this.heartsEl.innerHTML = '';
    this.hungerEl.innerHTML = '';
    this.airEl.innerHTML = '';
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

  setDebugVisible(v: boolean): void { this.debugEl.classList.toggle('hidden', !v); }
  isDebugVisible(): boolean { return !this.debugEl.classList.contains('hidden'); }

  updateDebug(lines: string[]): void {
    this.debugEl.innerHTML = lines.map((l) => `<span>${l}</span>`).join('<br>');
  }

  toast(msg: string): void {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastEl.classList.remove('show'), 2600);
  }

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
    s.addEventListener('mousedown', (e) => {
      e.preventDefault();
      onClick(e.button);
    });
  }

  private renderContainer(mode: GameMode): void {
    if (!this.view || !this.inv) return;
    const view = this.view;
    const inv = this.inv;
    this.containerEl.innerHTML = '';
    const panel = el('div', 'mc-panel', this.containerEl);
    const rerender = (): void => { this.renderContainer(mode); this.renderCursor(); };

    const title = el('div', 'ctr-label', panel);
    title.style.fontSize = '14px';
    title.style.marginBottom = '10px';
    title.textContent =
      view.kind === 'table' ? 'Crafting Table' :
      view.kind === 'furnace' ? 'Furnace' :
      view.kind === 'chest' ? 'Chest' :
      view.kind === 'creative' ? 'Creative Inventory' : 'Inventory';

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
      const sec = el('div', 'ctr-section ctr-flex', panel);
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
        this.audio.play('level');
        rerender();
      });
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
