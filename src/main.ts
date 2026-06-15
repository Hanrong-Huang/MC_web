// Application boot: main menu <-> game session orchestration, the render loop
// with a uniform 20 Hz logic tick, day/night cycle, chunk meshing budget,
// pointer-lock state machine, and save/load via IndexedDB.

import './style.css';
import { Atlas } from './engine/Textures';
import { World } from './engine/World';
import { Renderer } from './engine/Renderer';
import { Player, GameMode } from './engine/Player';
import { Input } from './engine/Input';
import { EntityManager } from './engine/EntityManager';
import { AudioEngine } from './engine/Audio';
import { HUD, ContainerView } from './ui/HUD';
import { SaveDB, SaveState, ChestSave, FurnaceSave } from './engine/Persistence';
import { FurnaceState, ChestState } from './engine/Inventory';
import { buildChunkGeometry } from './engine/Mesher';
import { chunkKey, CX, CZ } from './engine/Chunk';
import { B, I, GRAVITY_BLOCKS, FLOOR_BLOCKS, SELF_STACKING, def, hasDef } from './engine/Blocks';
import { Weather } from './engine/Weather';
import { AdvancementTracker } from './engine/Advancements';

const DAY_LENGTH = 1200; // 20 real minutes
const SAVE_VERSION = 2;
const AUTOSAVE_SECONDS = 60;

type GameUIState = 'loading' | 'playing' | 'paused' | 'container' | 'dead';

class Game {
  private app: App;
  private slot: string;
  private world: World;
  private renderer: Renderer;
  private player = new Player();
  private input: Input;
  private entities: EntityManager;
  private hud: HUD;
  private audio: AudioEngine;
  private atlas: Atlas;

  private state: GameUIState = 'loading';
  private container: ContainerView | null = null;
  private containerPos: string | null = null;
  private dayTime = 0.1; // mid-morning, fully lit
  private tickAcc = 0;
  private elapsed = 0;
  private lastFrame = 0;
  private fps = 60;
  private raf = 0;
  private disposed = false;
  /** bed respawn point, if set */
  private spawnPoint: { x: number; y: number; z: number } | null = null;
  private camBob = 0;
  private lastSelected = -1;
  private lastHeldId = -1;
  /** block positions whose supports must be re-checked (sand falls, torches pop) */
  private supportQueue = new Set<string>();
  private autosaveT = 0;
  private saving = false;
  private weather!: Weather;
  private adv = new AdvancementTracker();
  private rainSoundT = 0;
  private survivedNight = false;

  constructor(app: App, slot: string, save: SaveState | null, fresh: { seed: number; mode: GameMode } | null) {
    this.app = app;
    this.slot = slot;
    this.hud = app.hud;
    this.audio = app.audio;
    this.atlas = app.atlas;

    const seed = save ? save.seed : fresh!.seed;
    this.world = new World(seed);
    this.renderer = new Renderer(app.root, this.atlas);
    this.renderer.setViewDistance(this.world.viewDist);
    this.input = new Input(this.renderer.canvas);
    this.entities = new EntityManager(this.renderer.scene, this.world, this.atlas, this.audio);
    this.entities.setPlayer(this.player);
    this.entities.onKill = (kind) => {
      if (['zombie', 'skeleton', 'spider', 'creeper'].includes(kind)) this.adv.unlock('kill_mob');
    };

    this.weather = new Weather(this.renderer.scene, this.world, {
      onStrike: (x, y, z) => this.onLightning(x, y, z),
      isColdAt: (wx, wz) => this.world.generator.biomeAt(Math.floor(wx), Math.floor(wz)) === 'snow',
    });
    this.adv.onChange = () => {
      let t: { id: string; label: string; icon: string } | null;
      while ((t = this.adv.popToast())) this.hud.showAdvancementToast(t.icon, t.label);
    };

    this.world.onChunkRemoved = (key) => this.renderer.removeChunk(key);
    this.world.onBlockChanged = (x, y, z, _oldId, newId) => {
      // a removed block exposes whatever sat on it; a placed gravity block may drop
      if (newId === B.AIR) this.supportQueue.add(`${x},${y + 1},${z}`);
      if (GRAVITY_BLOCKS.has(newId)) this.supportQueue.add(`${x},${y},${z}`);
      // covering grass smothers it
      if (newId !== B.AIR && def(newId).opaque) this.supportQueue.add(`${x},${y - 1},${z}`);
    };

    this.player.init({
      world: this.world,
      input: this.input,
      renderer: this.renderer,
      entities: this.entities,
      audio: this.audio,
      isUIOpen: () => this.state !== 'playing',
      openContainer: (kind, x, y, z) => this.openBlockContainer(kind, x, y, z),
      useBed: (x, y, z) => this.useBed(x, y, z),
      igniteTnt: (x, y, z) => {
        this.world.setBlock(x, y, z, B.AIR);
        this.entities.spawnTnt(x, y, z);
        this.adv.unlock('creeper');
      },
      useDoor: (_x, _y, _z) => this.adv.unlock('door'),
      onBreak: (id) => {
        if (id === B.LOG || id === B.BIRCH_LOG || id === B.SPRUCE_LOG) this.adv.unlock('punch_wood');
        if (id === B.DIAMOND_ORE) this.adv.unlock('diamonds');
      },
      onPlantSeed: () => this.adv.unlock('farm'),
      onDeath: () => this.onDeath(),
    });

    if (save) {
      this.player.mode = save.gameMode;
      this.player.load(save.player);
      this.player.inventory.load(save.inventory);
      this.dayTime = save.environment?.dayTime ?? 0.1;
      this.spawnPoint = save.spawn ?? null;
      if (save.advancements) this.adv.load(save.advancements);
      for (const [k, v] of Object.entries(save.world ?? {})) {
        this.world.savedChunks.set(k, v);
      }
      for (const [k, v] of Object.entries(save.blockEntities ?? {})) {
        // v1 saves had untagged furnace states
        if ((v as ChestSave).type === 'chest') {
          this.world.blockEntities.set(k, ChestState.from(v as ChestSave));
        } else {
          this.world.blockEntities.set(k, FurnaceState.from(v as FurnaceSave));
        }
      }
      for (const [k, v] of Object.entries(save.doors ?? {})) {
        this.world.doorStates.set(k, {
          facing: (v.facing & 3) as 0 | 1 | 2 | 3,
          open: !!v.open,
          hingeRight: !!v.hingeRight,
          swing: v.open ? 1 : 0,
        });
      }
    } else {
      this.player.mode = fresh!.mode;
      const spawn = this.world.generator.findSpawn();
      this.player.pos = spawn;
      if (this.player.mode === 'creative') {
        const starter = [B.GRASS, B.DIRT, B.STONE, B.COBBLE, B.PLANKS, B.LOG, B.GLASS, B.TORCH, B.TNT];
        for (let i = 0; i < starter.length; i++) this.player.inventory.slots[i] = { id: starter[i], count: 64 };
      }
    }

    // dev helper: open the page with #night to start after sundown
    if (location.hash.includes('night')) this.dayTime = 0.62;

    this.player.inventory.onChange = () => this.onInventoryChange();
    this.onInventoryChange();
    this.adv.unlock('root');

    this.hud.onCraft = (id) => {
      if (id === B.TABLE) this.adv.unlock('planks');
      if (id === I.STONE_PICK) this.adv.unlock('stone_age');
      if (id === I.BOW) this.adv.unlock('bow');
      if (id === I.BREAD) this.adv.unlock('bread');
    };

    this.wireInput();
    this.hud.onDropLeftover = (id, count) => {
      const p = this.player.pos;
      this.entities.spawnDrop(p.x, p.y + 1, p.z, id, count);
    };

    void this.pregenerate();
  }

  // --- boot -------------------------------------------------------------------

  private async pregenerate(): Promise<void> {
    this.hud.showLoading('Generating world...');
    const px = this.player.pos.x, pz = this.player.pos.z;
    for (let i = 0; i < 400 && !this.disposed; i++) {
      this.world.update(px, pz, 14);
      this.processMeshing(14);
      let ready = true;
      const pcx = Math.floor(px / CX), pcz = Math.floor(pz / CZ);
      outer:
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          const c = this.world.getChunk(pcx + dx, pcz + dz);
          if (!c || !c.ready || this.world.dirtySet.has(chunkKey(pcx + dx, pcz + dz))) {
            ready = false;
            break outer;
          }
        }
      }
      if (ready) break;
      await new Promise((r) => requestAnimationFrame(r));
    }
    if (this.disposed) return;
    this.hud.hideLoading();
    this.hud.showGameUI();
    this.state = 'playing';
    this.hud.toast('Click to capture the mouse');
    this.lastFrame = performance.now();
    this.loop(this.lastFrame);
  }

  // --- input wiring --------------------------------------------------------------

  private wireInput(): void {
    this.renderer.canvas.addEventListener('mousedown', () => {
      this.audio.ensure();
      if (this.state === 'playing' && !this.input.pointerLocked) this.input.requestLock();
    });

    this.input.onPointerLockChange = (locked) => {
      if (!locked) {
        if (this.hud.isAdvancementsOpen()) {
          this.hud.hideAdvancements();
          this.input.requestLock();
          return;
        }
        if (this.state === 'playing') this.openPause();
      }
    };

    this.input.onMouseDown = (button) => {
      if (button === 0) this.player.onLeftClick();
    };

    this.input.onWheel = (delta) => {
      if (this.state !== 'playing') return;
      this.player.selectSlot(this.player.inventory.selected + delta);
    };

    this.input.onKeyDown = (code, doubleTap) => {
      if (this.disposed) return;
      if (code.startsWith('Digit')) {
        const n = parseInt(code.slice(5), 10);
        if (n >= 1 && n <= 9 && this.state === 'playing') this.player.selectSlot(n - 1);
        return;
      }
      switch (code) {
        case 'KeyW':
          if (doubleTap && this.state === 'playing') this.player.sprinting = true;
          break;
        case 'Space':
          if (doubleTap && this.state === 'playing' && this.player.mode === 'creative') this.player.toggleFly();
          break;
        case 'KeyF':
          if (this.state === 'playing') {
            this.player.toggleFly();
            this.hud.toast(this.player.flying ? 'Flying enabled' : 'Flying disabled');
          }
          break;
        case 'KeyL':
          // advancement panel toggle
          if (this.hud.isAdvancementsOpen()) this.hud.hideAdvancements();
          else if (this.state === 'playing' || this.hud.isAdvancementsOpen()) {
            this.input.exitLock();
            this.hud.toggleAdvancements(this.adv.list());
          }
          break;
        case 'KeyE':
          if (this.state === 'playing' && this.input.pointerLocked) this.openInventory();
          else if (this.state === 'container') this.closeContainer();
          break;
        case 'F3':
          this.hud.setDebugVisible(!this.hud.isDebugVisible());
          break;
        case 'Escape':
          // with pointer lock active the browser eats Esc; this handles menus
          if (this.state === 'container') this.closeContainer();
          else if (this.hud.isAdvancementsOpen()) this.hud.hideAdvancements();
          else if (this.state === 'paused') this.resume();
          break;
      }
    };
  }

  // --- UI state machine ---------------------------------------------------------------

  private openPause(): void {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.input.exitLock();
    this.hud.showPause(this.pauseHandlers(), this.player.mode, this.world.viewDist);
  }

  private pauseHandlers() {
    return {
      onResume: () => this.resume(),
      onSave: () => this.saveGame(),
      onSaveQuit: () => void this.saveAndQuit(),
      onToggleMode: () => {
        this.player.mode = this.player.mode === 'survival' ? 'creative' : 'survival';
        if (this.player.mode === 'survival') this.player.flying = false;
        this.onInventoryChange();
        this.hud.showPause(this.pauseHandlers(), this.player.mode, this.world.viewDist);
      },
      onViewDist: (n: number) => {
        this.world.viewDist = n;
        this.renderer.setViewDistance(n);
        this.hud.showPause(this.pauseHandlers(), this.player.mode, this.world.viewDist);
      },
      onToggleMusic: () => {
        this.audio.setMusic(!this.audio.musicOn);
        this.hud.showPause(this.pauseHandlers(), this.player.mode, this.world.viewDist);
      },
      onToggleSound: () => {
        this.audio.setSound(!this.audio.soundOn);
        this.hud.showPause(this.pauseHandlers(), this.player.mode, this.world.viewDist);
      },
      musicOn: () => this.audio.musicOn,
      soundOn: () => this.audio.soundOn,
      onPack: (files: File[]) => void this.applyPack(files),
    };
  }

  private resume(): void {
    if (this.state !== 'paused') return;
    this.hud.hidePause();
    this.state = 'playing';
    this.input.requestLock();
  }

  private openInventory(): void {
    const kind = this.player.mode === 'creative' ? 'creative' : 'inventory';
    this.container = {
      kind,
      craftW: kind === 'inventory' ? 2 : 0,
      craftGrid: kind === 'inventory' ? new Array(4).fill(null) : [],
      furnace: null,
      chest: null,
    };
    this.containerPos = null;
    this.state = 'container';
    this.input.exitLock();
    this.hud.openContainer(this.container, this.player.inventory, this.player.mode);
  }

  private openBlockContainer(kind: 'table' | 'furnace' | 'chest', x: number, y: number, z: number): void {
    if (kind === 'furnace' || kind === 'chest') {
      const key = `${x},${y},${z}`;
      let st = this.world.blockEntities.get(key);
      if (!st || (kind === 'furnace' ? st.type !== 'furnace' : st.type !== 'chest')) {
        st = kind === 'furnace' ? new FurnaceState() : new ChestState();
        // generated chests roll loot on first open, then become normal chests
        if (kind === 'chest' && this.world.getBlock(x, y, z) === B.CHEST_LOOT) {
          this.rollLoot(st as ChestState);
          this.world.setBlock(x, y, z, B.CHEST);
          this.audio.play('level');
          this.adv.unlock('dungeon');
        }
        this.world.blockEntities.set(key, st);
      }
      this.container = {
        kind,
        craftW: 0,
        craftGrid: [],
        furnace: st.type === 'furnace' ? st : null,
        chest: st.type === 'chest' ? st : null,
      };
      this.containerPos = key;
    } else {
      this.container = { kind: 'table', craftW: 3, craftGrid: new Array(9).fill(null), furnace: null, chest: null };
      this.containerPos = null;
    }
    this.state = 'container';
    this.input.exitLock();
    this.hud.openContainer(this.container, this.player.inventory, this.player.mode);
  }

  /** Treasure tables for generated chests (huts + dungeons). */
  private rollLoot(chest: ChestState): void {
    const pool: [id: number, min: number, max: number, weight: number][] = [
      [I.IRON_INGOT, 1, 4, 4],
      [I.GOLD_INGOT, 1, 3, 2],
      [I.DIAMOND, 1, 1, 1],
      [I.APPLE, 1, 3, 4],
      [I.COOKED_BEEF, 1, 2, 2],
      [I.STRING, 1, 3, 2],
      [I.GUNPOWDER, 1, 3, 2],
      [I.ARROW, 2, 6, 3],
      [I.COAL, 2, 5, 4],
      [I.BOW, 1, 1, 1],
      [B.TORCH, 2, 6, 3],
      [B.PLANKS, 2, 8, 2],
    ];
    const totalWeight = pool.reduce((s, e) => s + e[3], 0);
    const stacks = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < stacks; i++) {
      let r = Math.random() * totalWeight;
      let entry = pool[0];
      for (const e of pool) { r -= e[3]; if (r <= 0) { entry = e; break; } }
      const count = entry[1] + Math.floor(Math.random() * (entry[2] - entry[1] + 1));
      const slot = Math.floor(Math.random() * chest.slots.length);
      if (!chest.slots[slot]) chest.slots[slot] = { id: entry[0], count };
    }
  }

  /** Right-clicking a bed: set the respawn point and skip the night. */
  private useBed(x: number, y: number, z: number): void {
    this.spawnPoint = { x: x + 0.5, y: y + 1, z: z + 0.5 };
    const sunHeight = Math.sin(this.dayTime * Math.PI * 2);
    if (sunHeight < 0.05) {
      this.dayTime = 0.02; // sleep through to sunrise
      this.hud.toast('Good morning! Spawn point set.');
      this.audio.play('level');
    } else {
      this.hud.toast('Spawn point set');
    }
    this.adv.unlock('bed');
  }

  /** Lightning struck at (x,y,z): ignite TNT, scorch mobs, flash + thunder. */
  private onLightning(x: number, y: number, z: number): void {
    this.audio.play('thunder');
    this.adv.unlock('thunder');
    // ignite exposed TNT
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const bx = x + dx, by = y + dy, bz = z + dz;
          if (this.world.getBlock(bx, by, bz) === B.TNT) {
            this.world.setBlock(bx, by, bz, B.AIR);
            this.entities.spawnTnt(bx, by, bz);
          }
        }
      }
    }
    // visual: spark particles + a small flash burst at the strike point
    this.entities.spawnBlockParticles(x, y - 1, z, B.TORCH, 14);
    // damage surface entities caught in the bolt
    this.entities.lightningDamage(x, y, z);
  }

  private closeContainer(): void {
    if (this.state !== 'container') return;
    this.hud.closeContainer();
    this.container = null;
    this.containerPos = null;
    this.state = 'playing';
    this.input.requestLock();
  }

  private onDeath(): void {
    this.state = 'dead';
    this.input.exitLock();
    this.hud.showDeath(
      () => {
        const spawn = this.spawnPoint ?? this.world.generator.findSpawn();
        this.player.respawn({ ...spawn });
        this.hud.hideDeath();
        this.state = 'playing';
        this.input.requestLock();
      },
      () => void this.saveAndQuit(),
    );
  }

  private async applyPack(files: File[]): Promise<void> {
    const n = await this.atlas.loadResourcePack(files);
    if (n > 0) {
      // held item + hotbar use cached canvases; force a rebuild
      const held = this.player.heldId();
      this.renderer.setHeldItem(-2 as number);
      this.renderer.setHeldItem(held);
      this.onInventoryChange();
      this.hud.toast(`Resource pack applied (${n} textures)`);
    } else {
      this.hud.toast('No matching textures found in that folder');
    }
  }

  private onInventoryChange(): void {
    this.hud.refreshHotbar(this.player.inventory, this.player.mode);
    this.renderer.setHeldItem(this.player.heldId());
    // item-name popup when the hotbar selection (or its item) changes
    const sel = this.player.inventory.selected;
    const heldId = this.player.heldId();
    if (sel !== this.lastSelected || (heldId !== this.lastHeldId && heldId !== 0)) {
      if (heldId !== 0 && hasDef(heldId) && this.state !== 'container') {
        this.hud.showItemName(def(heldId).label);
      }
      this.lastSelected = sel;
      this.lastHeldId = heldId;
    }
  }

  // --- save ----------------------------------------------------------------------

  private buildSave(): SaveState {
    this.world.stashModified();
    const worldRec: Record<string, Uint8Array> = {};
    for (const [k, v] of this.world.savedChunks) worldRec[k] = v;
    const beRec: SaveState['blockEntities'] = {};
    for (const [k, v] of this.world.blockEntities) {
      if (!v.isEmpty()) beRec[k] = v.serialize();
    }
    const doorRec: NonNullable<SaveState['doors']> = {};
    for (const [k, v] of this.world.doorStates) {
      doorRec[k] = { facing: v.facing, open: v.open, hingeRight: !!v.hingeRight };
    }
    return {
      version: SAVE_VERSION,
      seed: this.world.seed,
      gameMode: this.player.mode,
      player: this.player.serialize(),
      inventory: this.player.inventory.serialize(),
      world: worldRec,
      blockEntities: beRec,
      doors: doorRec,
      environment: { dayTime: this.dayTime },
      advancements: this.adv.serialize(),
      ...(this.spawnPoint ? { spawn: { ...this.spawnPoint } } : {}),
      lastPlayed: Date.now(),
    };
  }

  /** Save without quitting (pause-menu Save button + autosave). */
  async saveGame(): Promise<boolean> {
    if (this.saving) return true;
    this.saving = true;
    try {
      await this.app.db.save(this.slot, this.buildSave());
      return true;
    } catch (err) {
      console.error('Save failed', err);
      return false;
    } finally {
      this.saving = false;
    }
  }

  private async saveAndQuit(): Promise<void> {
    if (this.state === 'container') this.hud.closeContainer();
    const ok = await this.saveGame();
    if (!ok) this.hud.toast('Save failed — see console');
    this.dispose();
    void this.app.showMenu();
  }

  // --- per-frame ---------------------------------------------------------------------

  private loop = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    let dt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    if (dt > 0.1) dt = 0.1;
    this.elapsed += dt;
    this.fps = this.fps * 0.95 + (1 / Math.max(dt, 1e-4)) * 0.05;

    const paused = this.state === 'paused';
    if (!paused) {
      this.dayTime = (this.dayTime + dt / DAY_LENGTH) % 1;

      this.player.update(dt);
      this.world.update(this.player.pos.x, this.player.pos.z, 5);
      this.world.updateDoorSwings(dt);
      this.processMeshing(6);
      this.entities.update(dt, this.elapsed, this.renderer.camera.quaternion);

      // weather follows the player
      const pp = this.player.pos;
      this.weather.update(dt, pp.x, pp.y + this.player.eyeHeight(), pp.z);

      // soft rain hiss loop while precipitating
      const w = this.weather;
      if (w.kind !== 'clear' && w.intensity > 0.3) {
        this.rainSoundT -= dt;
        if (this.rainSoundT <= 0) { this.rainSoundT = 1.6; this.audio.play('rain'); }
      }

      this.tickAcc += dt;
      while (this.tickAcc >= 0.05) {
        this.tickAcc -= 0.05;
        this.tick20();
      }
      this.audio.ambientTick(dt, Math.sin(this.dayTime * Math.PI * 2) < -0.06);

      this.autosaveT += dt;
      if (this.autosaveT >= AUTOSAVE_SECONDS) {
        this.autosaveT = 0;
        void this.saveGame().then((ok) => { if (ok) this.hud.toast('Autosaved'); });
      }
    }

    // camera (with subtle view bobbing while walking)
    const cam = this.renderer.camera;
    const hSpeed = Math.hypot(this.player.vel.x, this.player.vel.z);
    let bobY = 0;
    if (this.player.onGround && !this.player.flying && hSpeed > 0.5) {
      this.camBob += hSpeed * dt * 1.7;
      bobY = Math.sin(this.camBob * 2) * 0.045 * Math.min(1, hSpeed / 4.3);
    }
    cam.position.set(this.player.pos.x, this.player.pos.y + this.player.eyeHeight() + bobY, this.player.pos.z);
    cam.rotation.set(this.player.pitch, this.player.yaw, 0);
    let targetFov = this.player.sprinting ? 80.5 : 70;
    targetFov -= 12 * Math.min(1, this.player.bowCharge / 0.9); // bow-draw zoom
    if (Math.abs(cam.fov - targetFov) > 0.1) {
      cam.fov += (targetFov - cam.fov) * Math.min(1, 10 * dt);
      cam.updateProjectionMatrix();
    }

    this.renderer.updateEnvironment(
      this.dayTime, cam.position.x, cam.position.z, this.elapsed,
      this.weather.darkening() * this.weather.intensity,
      this.weather.flashAmount(),
    );
    this.renderer.updateHeld(dt, this.player.isMoving());
    this.hud.updateStats(this.player.hp, this.player.hunger, this.player.air, this.player.mode);
    if (this.state === 'container' && this.container?.kind === 'furnace') this.hud.updateFurnace();
    if (this.hud.isDebugVisible()) this.updateDebug();

    this.renderer.render(this.player.underwaterEye());
  };

  private tick20(): void {
    const isNight = Math.sin(this.dayTime * Math.PI * 2) < -0.06;
    // track surviving a full night
    if (isNight) this.survivedNight = true;
    else if (this.survivedNight) { this.survivedNight = false; this.adv.unlock('survive_night'); }
    this.player.tick(0.05);
    this.entities.tick(isNight);

    // furnaces tick wherever their chunk is loaded
    for (const [key, st] of this.world.blockEntities) {
      if (st.type !== 'furnace') continue;
      const [x, y, z] = key.split(',').map(Number);
      const cur = this.world.getBlock(x, y, z);
      if (cur !== B.FURNACE && cur !== B.FURNACE_LIT) continue;
      const outBefore = st.output?.count ?? 0;
      st.tick(0.05);
      // advancement: first iron ingot smelted
      if (st.output && st.output.id === I.IRON_INGOT && st.output.count > outBefore) {
        this.adv.unlock('iron_age');
      }
      const want = st.burning ? B.FURNACE_LIT : B.FURNACE;
      if (cur !== want) this.world.setBlock(x, y, z, want);
    }

    // support checks: sand/gravel fall, unsupported plants/torches pop off
    if (this.supportQueue.size > 0) {
      const batch = [...this.supportQueue];
      this.supportQueue.clear();
      for (const key of batch) {
        const [x, y, z] = key.split(',').map(Number);
        const id = this.world.getBlock(x, y, z);
        if (GRAVITY_BLOCKS.has(id)) {
          const below = this.world.getBlock(x, y - 1, z);
          if (below === B.AIR || below === B.WATER) {
            this.world.setBlock(x, y, z, B.AIR);
            this.entities.spawnFallingBlock(x, y, z, id);
          }
        } else if (FLOOR_BLOCKS.has(id)) {
          const below = this.world.getBlock(x, y - 1, z);
          const supported = (hasDef(below) && below !== B.AIR && def(below).solid) ||
            (SELF_STACKING.has(id) && below === id);
          if (!supported) {
            this.world.setBlock(x, y, z, B.AIR);
            const d = def(id);
            if (d.drop !== null) {
              const drop = d.drop ?? { id, min: 1, max: 1 };
              this.entities.spawnDrop(x + 0.5, y + 0.3, z + 0.5, drop.id, drop.min);
            }
          }
        } else if (id === B.GRASS) {
          const above = this.world.getBlock(x, y + 1, z);
          if (above !== B.AIR && hasDef(above) && def(above).opaque) {
            this.world.setBlock(x, y, z, B.DIRT);
          }
        }
      }
    }

    this.randomTicks();
  }

  /** MC-style random ticks at the surface: saplings grow, wheat advances,
   *  and grass creeps onto exposed dirt. */
  private randomTicks(): void {
    const pcx = Math.floor(this.player.pos.x / CX);
    const pcz = Math.floor(this.player.pos.z / CZ);
    for (let dz = -3; dz <= 3; dz++) {
      for (let dx = -3; dx <= 3; dx++) {
        const chunk = this.world.getChunk(pcx + dx, pcz + dz);
        if (!chunk || !chunk.ready) continue;
        for (let n = 0; n < 3; n++) {
          const lx = (Math.random() * 16) | 0;
          const lz = (Math.random() * 16) | 0;
          const hm = chunk.heightmap[lz * 16 + lx];
          const wx = chunk.cx * CX + lx, wz = chunk.cz * CZ + lz;

          // plant layer sits just above the heightmap surface
          const plant = this.world.getBlock(wx, hm, wz);
          if (plant === B.SAPLING) {
            if (Math.random() < 0.06) this.growTree(wx, hm, wz);
            continue;
          }
          if (plant === B.WHEAT_0 || plant === B.WHEAT_1) {
            if (Math.random() < 0.2 && this.world.getBlock(wx, hm - 1, wz) === B.FARMLAND) {
              this.world.setBlock(wx, hm, wz, plant === B.WHEAT_0 ? B.WHEAT_1 : B.WHEAT_2);
            }
            continue;
          }
          // grass spread onto exposed dirt
          const ground = this.world.getBlock(wx, hm - 1, wz);
          if (ground === B.DIRT && Math.random() < 0.3) {
            let nearGrass = false;
            scan:
            for (let gy = -1; gy <= 1; gy++) {
              for (let gz = -1; gz <= 1; gz++) {
                for (let gx = -1; gx <= 1; gx++) {
                  if (this.world.getBlock(wx + gx, hm - 1 + gy, wz + gz) === B.GRASS) {
                    nearGrass = true;
                    break scan;
                  }
                }
              }
            }
            if (nearGrass) this.world.setBlock(wx, hm - 1, wz, B.GRASS);
          }
        }
      }
    }
  }

  /** Grow a sapling into a biome-appropriate tree using live block writes. */
  private growTree(x: number, y: number, z: number): void {
    const biome = this.world.generator.biomeAt(x, z);
    const variant = Math.random();
    let log = B.LOG, leaves = B.LEAVES;
    if (biome === 'snow') { log = B.SPRUCE_LOG; leaves = B.SPRUCE_LEAVES; }
    else if (variant < 0.25) { log = B.BIRCH_LOG; leaves = B.BIRCH_LEAVES; }
    const h = 4 + ((Math.random() * 3) | 0);

    this.world.setBlock(x, y, z, B.AIR);
    const leafAt = (lx: number, ly: number, lz: number): void => {
      const cur = this.world.getBlock(lx, ly, lz);
      if (cur === B.AIR || cur === B.LEAVES || cur === B.BIRCH_LEAVES || cur === B.SPRUCE_LEAVES) {
        this.world.setBlock(lx, ly, lz, leaves);
      }
    };
    for (let dy = h - 3; dy <= h; dy++) {
      const rad = dy >= h - 1 ? 1 : 2;
      for (let lx = -rad; lx <= rad; lx++) {
        for (let lz = -rad; lz <= rad; lz++) {
          if (lx === 0 && lz === 0 && dy < h) continue;
          if (Math.abs(lx) === rad && Math.abs(lz) === rad && Math.random() < 0.5) continue;
          leafAt(x + lx, y + dy, z + lz);
        }
      }
    }
    for (let dy = 0; dy < h; dy++) this.world.setBlock(x, y + dy, z, log);
    this.audio.dig('grass', 0.7);
  }

  private processMeshing(budgetMs: number): void {
    if (this.world.dirtySet.size === 0) return;
    const pcx = Math.floor(this.player.pos.x / CX);
    const pcz = Math.floor(this.player.pos.z / CZ);
    const jobs: { key: string; d: number }[] = [];
    for (const key of this.world.dirtySet) {
      const [cx, cz] = key.split(',').map(Number);
      jobs.push({ key, d: (cx - pcx) ** 2 + (cz - pcz) ** 2 });
    }
    jobs.sort((a, b) => a.d - b.d);
    const t0 = performance.now();
    for (const job of jobs) {
      if (performance.now() - t0 > budgetMs) break;
      const [cx, cz] = job.key.split(',').map(Number);
      const chunk = this.world.getChunk(cx, cz);
      if (!chunk || !chunk.ready) {
        this.world.dirtySet.delete(job.key);
        continue;
      }
      if (!this.world.neighborsReady(cx, cz)) continue; // wait for neighbors
      const geo = buildChunkGeometry(this.world, chunk, this.atlas);
      this.renderer.setChunkGeometry(job.key, cx, cz, geo);
      chunk.dirty = false;
      this.world.dirtySet.delete(job.key);
    }
  }

  private updateDebug(): void {
    const p = this.player.pos;
    const yawDeg = ((this.player.yaw * 180 / Math.PI) % 360 + 360) % 360;
    const dirs = ['North (-Z)', 'West (-X)', 'South (+Z)', 'East (+X)'];
    const facing = dirs[Math.round(yawDeg / 90) % 4];
    const c = this.entities.counts();
    const biome = this.world.generator.biomeAt(Math.floor(p.x), Math.floor(p.z));
    this.hud.updateDebug([
      `Voxelcraft (${this.fps.toFixed(0)} fps)`,
      `XYZ: ${p.x.toFixed(3)} / ${p.y.toFixed(3)} / ${p.z.toFixed(3)}`,
      `Chunk: ${Math.floor(p.x / 16)} ${Math.floor(p.z / 16)}  in ${Math.floor(p.x) & 15} ${Math.floor(p.z) & 15}`,
      `Facing: ${facing} (yaw ${yawDeg.toFixed(1)})`,
      `Biome: ${biome}  Day: ${(this.dayTime * 100).toFixed(0)}%`,
      `Chunks: ${this.world.countLoaded()} loaded, ${this.world.dirtySet.size} dirty`,
      `Entities: ${c.mobs} mobs, ${c.drops} drops, ${c.other} fx`,
      `Mode: ${this.player.mode}${this.player.flying ? ' (flying)' : ''}${this.player.onGround ? ' on ground' : ''}`,
    ]);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.input.exitLock();
    this.input.dispose();
    this.entities.clear();
    this.weather.dispose();
    this.hud.hideGameUI();
    this.hud.hideLoading();
    this.renderer.dispose();
  }
}

// =============================================================================

class App {
  root: HTMLElement;
  atlas = new Atlas();
  audio = new AudioEngine();
  db = new SaveDB();
  hud: HUD;
  private game: Game | null = null;

  constructor() {
    this.root = document.getElementById('app')!;
    this.hud = new HUD(this.root, this.atlas, this.audio);
    void this.showMenu();
  }

  async showMenu(): Promise<void> {
    this.game = null;
    let saves: Awaited<ReturnType<SaveDB['list']>> = [];
    try {
      saves = await this.db.list();
    } catch (err) {
      console.error('IndexedDB unavailable', err);
    }
    this.hud.showMenu(saves, {
      onPlay: (slot, fresh) => void this.startGame(slot, fresh),
      onDelete: (slot) => {
        void this.db.delete(slot).then(() => this.showMenu());
      },
      onPack: (files) => {
        void this.atlas.loadResourcePack(files).then((n) => {
          this.hud.toast(n > 0 ? `Resource pack applied (${n} textures)` : 'No matching textures found');
        });
      },
    });
  }

  private async startGame(slot: string, fresh: { seed: number; mode: GameMode } | null): Promise<void> {
    let save: SaveState | null = null;
    if (!fresh) {
      try {
        save = await this.db.load(slot);
      } catch (err) {
        console.error('Load failed', err);
        this.hud.toast('Load failed — see console');
        return;
      }
      if (!save) return;
    }
    this.hud.hideMenu();
    this.game = new Game(this, slot, save, fresh);
    void this.game;
  }
}

new App();
