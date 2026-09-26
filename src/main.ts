// Application boot: main menu <-> game session orchestration, the render loop
// with a uniform 20 Hz logic tick, day/night cycle, chunk meshing budget,
// pointer-lock state machine, and save/load via IndexedDB.

import './style.css';
import * as THREE from 'three';
import { Atlas } from './engine/Textures';
import { World } from './engine/World';
import type { DoorState } from './engine/World';
import { Renderer } from './engine/Renderer';
import { Player, GameMode } from './engine/Player';
import { Input } from './engine/Input';
import { EntityManager } from './engine/EntityManager';
import { AudioEngine } from './engine/Audio';
import type { AmbientEnv } from './engine/Audio';
import { TouchControls, isTouchDevice } from './ui/TouchControls';
import { HUD, ContainerView, recordWorldMeta, readWorldMeta } from './ui/HUD';
import { StatusHUD } from './ui/StatusHUD';
import type { LoadColumn } from './ui/LoadingScreen';
import { SaveDB, SaveState, ChestSave, FurnaceSave, exportWorld, importWorld } from './engine/Persistence';
import type { BlockEntitySave } from './engine/Persistence';
import { FurnaceState, ChestState } from './engine/Inventory';
import type { BlockEntity } from './engine/Inventory';
import type { Slot } from './engine/Inventory';
import { buildChunkGeometry } from './engine/Mesher';
import type { GeoArrays, MeshDoor, MeshRedstone } from './engine/Mesher';
import { chunkGeometryFromArrays } from './engine/Renderer';
import type { MeshJob, MeshChunkSnap } from './engine/mesh-worker';
import { chunkKey, CX, CZ } from './engine/Chunk';
import { B, I, GRAVITY_BLOCKS, FLOOR_BLOCKS, SELF_STACKING, HANGING_PLANTS, def, hasDef, isSolid, mobLabel } from './engine/Blocks';
import { SHAPED, META_BLOCKS, shapeBoxes, connectsTo, enchantLabel } from './engine/Blocks';
import { craftRemainders } from './engine/Inventory';
import { ExperienceOrbs, XpBar } from './engine/Experience';
import { Throwables } from './engine/Throwables';
import { Campfires } from './engine/Campfires';
import { fillNetherChest } from './engine/NetherStructures';
import { MapOverlay } from './ui/MapOverlay';
import { Weather } from './engine/Weather';
import { getControls, setControls } from './engine/ControlsSettings';
import { AdvancementTracker } from './engine/Advancements';
import { FireSystem } from './engine/Fire';
import { waterFX } from './engine/WaterFX';
import { NetherController } from './engine/NetherController';
import type { Entity } from './engine/EntityManager';

const DAY_LENGTH = 1200; // 20 real minutes
const SAVE_VERSION = 2;
const AUTOSAVE_SECONDS = 60;
const INTRO_TIME = 1.9; // camera sweep from above into the player's eyes after loading
// pressure plates stay powered this many 20 Hz ticks after the last step-off,
// so walking across one doesn't flicker the plate (and slam wired doors)
const PLATE_RELEASE_TICKS = 8;

type GameUIState = 'loading' | 'playing' | 'paused' | 'container' | 'dead' | 'sleeping';

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
  private tradeVillager: Entity | null = null;
  private dayTime = 0.1; // mid-morning, fully lit
  private tickAcc = 0;
  private waterTickAcc = 0;
  private lavaTickAcc = 0;
  private elapsed = 0;
  private lastFrame = 0;
  private fps = 60;
  private meshMs = 0;       // EMA of meshing cost per chunk (ms), for the debug overlay
  private meshPerFrame = 0; // chunks meshed in the last frame
  private meshWorker: Worker | null = null;
  private meshWorkerTried = false;
  private meshJobId = 0;
  private meshInFlight = new Set<string>(); // chunk keys being meshed off-thread
  private raf = 0;
  private disposed = false;
  /** bed respawn point, if set */
  private spawnPoint: { x: number; y: number; z: number } | null = null;
  /** bed the player is lying in (drives the sleeping camera), else null */
  private sleepBed: { cx: number; cz: number; y: number; yaw: number } | null = null;
  private sleepT = 0;
  private sleepSkipped = false;
  private camBob = 0;
  private lastSelected = -1;
  private lastHeldId = -1;
  private lastHeldMob: string | undefined = undefined;
  /** block positions whose supports must be re-checked (sand falls, torches pop) */
  private supportQueue = new Set<string>();
  private autosaveT = 0;
  private saving = false;
  private weather!: Weather;
  private adv = new AdvancementTracker();
  private survivedNight = false;
  private nightsAwake = 0;
  private phantomSpawnT = 0;
  private wasNight = false;
  private minimapT = 0;
  private wasRiding = false;
  private wasUnderwater = false;
  private touch: TouchControls | null = null;
  private touchVisible = false;
  private ambientPT = 0;
  /** golden hearts, effect badges, attack meter, spyglass vignette */
  private status: StatusHUD;
  private wasScoping = false;
  /** spreading fires (flint & steel, lightning) */
  private fire!: FireSystem;
  private fireAcc = 0;
  private mobBurnAcc = 0;
  /** seconds into the post-loading camera sweep (>= INTRO_TIME: done) */
  private introT = 99;
  /** play time banked in earlier sessions (title-card stat) */
  private playSecBase = 0;
  /** whole days elapsed, counted as dayTime wraps (title-card stat) */
  private worldDays = 0;
  /** experience orbs + the bar above the hotbar */
  private xpOrbs!: ExperienceOrbs;
  private xpBar = new XpBar();
  private lastKilledKind = '';
  /** warp pearls + snowballs in flight */
  private throwables!: Throwables;
  /** food cooking on campfires */
  private campfires = new Campfires();
  /** Nether pass: biome air, portal sheets + travel, respawn anchor, portal compass */
  private nether!: NetherController;
  private campfireHurtT = 0;
  /** explorer map + recovery compass overlays */
  private mapOverlay: MapOverlay;

  constructor(app: App, slot: string, save: SaveState | null, fresh: { seed: number; mode: GameMode } | null) {
    this.app = app;
    this.slot = slot;
    this.hud = app.hud;
    this.audio = app.audio;
    this.atlas = app.atlas;
    this.status = new StatusHUD(app.root);
    this.mapOverlay = new MapOverlay(app.root, app.atlas);

    const seed = save ? save.seed : fresh!.seed;
    this.world = new World(seed);
    this.renderer = new Renderer(app.root, this.atlas);
    this.renderer.setViewDistance(this.world.viewDist);
    this.renderer.blockAt = (x, y, z) => this.world.getBlock(x, y, z); // outline shape
    this.input = new Input(this.renderer.canvas);
    this.entities = new EntityManager(this.renderer.scene, this.world, this.atlas, this.audio);
    this.entities.setPlayer(this.player);
    waterFX.attach(this.renderer.scene, this.world, this.audio);
    this.entities.onKill = (kind) => {
      if (['zombie', 'skeleton', 'spider', 'creeper'].includes(kind)) this.adv.unlock('kill_mob');
      this.lastKilledKind = kind;
    };
    this.xpOrbs = new ExperienceOrbs(this.renderer.scene, this.world);
    this.throwables = new Throwables(this.renderer.scene, this.world, this.atlas, this.entities);
    this.throwables.onWarp = (x, y, z) => this.warpPlayer(x, y, z);
    this.throwables.onIgnite = (x, y, z) => { this.fire.ignite(x, y, z); };
    this.entities.onIgnite = (x, y, z) => { this.fire.ignite(x, y, z); }; // blaze fireballs
    this.nether = new NetherController({
      world: this.world, player: this.player, renderer: this.renderer, audio: this.audio, entities: this.entities,
      toast: (m) => this.hud.toast(m), unlock: (id) => this.adv.unlock(id), clearBedSpawn: () => { this.spawnPoint = null; },
    }, app.root);
    // outline hugs slabs, stairs, fences and other shaped blocks
    this.renderer.outlineShape = (x, y, z) => this.outlineBoxFor(x, y, z);
    // thrown catchers resolve inside the entity update, away from the input path
    this.entities.onToast = (msg) => this.hud.toast(msg);
    this.entities.onCapture = () => this.adv.unlock('catch');
    // combat feedback: hit marker + a damage number projected at the mob's screen position
    this.entities.onPlayerHit = (pos, dmg, crit, killed) => {
      if (this.state !== 'playing') return;
      this.hud.flashHitMarker(crit, killed);
      if (killed) this.xpOrbs.spawn(pos.x, pos.y + 0.5, pos.z, this.killXp(this.lastKilledKind));
      const v = new THREE.Vector3(pos.x, pos.y + 0.9, pos.z).project(this.renderer.camera);
      if (v.z < 1) { // in front of the camera
        const canvas = this.renderer.canvas;
        this.hud.showDamageNumber(
          (v.x * 0.5 + 0.5) * canvas.clientWidth + (Math.random() * 14 - 7),
          (-v.y * 0.5 + 0.5) * canvas.clientHeight + (Math.random() * 10 - 5),
          dmg, crit,
        );
      }
    };

    this.weather = new Weather(this.renderer.scene, this.world, {
      onStrike: (x, y, z) => this.onLightning(x, y, z),
      isColdAt: (wx, wz) => {
        const biome = this.world.generator.biomeAt(Math.floor(wx), Math.floor(wz));
        return biome === 'snow' || biome === 'taiga';
      },
    });
    this.fire = new FireSystem(this.world, {
      rainingAt: (x, y, z) => this.isRainingOn(x, y, z),
      igniteTnt: (x, y, z) => this.entities.spawnTnt(x, y, z),
    });
    this.adv.onChange = () => {
      let t: { id: string; label: string; icon: string } | null;
      while ((t = this.adv.popToast())) { this.hud.showAdvancementToast(t.icon, t.label); this.audio.play('advancement'); }
    };

    this.world.onChunkRemoved = (key) => this.renderer.removeChunk(key);
    this.world.onBlockChanged = (x, y, z, _oldId, newId) => {
      this.nether.onBlockChanged(x, y, z, _oldId, newId); // broken frames collapse their portal
      // a removed block exposes whatever sat on it; a placed gravity block may drop
      if (newId === B.AIR) {
        this.supportQueue.add(`${x},${y + 1},${z}`);
        // wall torches attached to the removed block must re-check support
        this.supportQueue.add(`${x + 1},${y},${z}`);
        this.supportQueue.add(`${x - 1},${y},${z}`);
        this.supportQueue.add(`${x},${y},${z + 1}`);
        this.supportQueue.add(`${x},${y},${z - 1}`);
        this.supportQueue.add(`${x},${y - 1},${z}`); // hanging lanterns
      }
      // a shaped block's facing/state entry goes with it (explosions, pistons, fire ...)
      if (_oldId !== newId && META_BLOCKS.has(_oldId)) this.world.bedFacings.delete(`${x},${y},${z}`);
      if (_oldId === B.FENCE_GATE && newId !== B.FENCE_GATE) this.world.doorStates.delete(`${x},${y},${z}`);
      if (GRAVITY_BLOCKS.has(newId)) this.supportQueue.add(`${x},${y},${z}`);
      // covering grass smothers it
      if (newId !== B.AIR && def(newId).opaque) this.supportQueue.add(`${x},${y - 1},${z}`);
      // fluid reaction: water + lava neighbors -> obsidian / cobblestone
      if (newId === B.WATER || newId === B.LAVA) {
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
          const nb = this.world.getBlock(x + dx, y + dy, z + dz);
          if (newId === B.WATER && nb === B.LAVA) {
            // flowing water hitting lava: deep (y<11) -> obsidian, else cobble
            this.world.setBlock(x + dx, y + dy, z + dz, y + dy < 11 ? B.OBSIDIAN : B.COBBLE);
          } else if (newId === B.LAVA && nb === B.WATER) {
            this.world.setBlock(x, y, z, y < 11 ? B.OBSIDIAN : B.COBBLE);
          }
        }
      }

      const REDSTONE_IDS = new Set<number>([
        B.REDSTONE_WIRE, B.LEVER, B.WOODEN_BUTTON, B.STONE_BUTTON,
        B.PRESSURE_PLATE, B.REDSTONE_LAMP, B.REDSTONE_LAMP_LIT,
        B.PISTON, B.STICKY_PISTON, B.PISTON_HEAD,
        B.DOOR_LOWER, B.DOOR_UPPER, B.TRAPDOOR
      ]);
      const isRedstoneRelated = (bx: number, by: number, bz: number) => {
        if (REDSTONE_IDS.has(this.world.getBlock(bx, by, bz))) return true;
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
          if (REDSTONE_IDS.has(this.world.getBlock(bx + dx, by + dy, bz + dz))) return true;
        }
        return false;
      };
      if ((_oldId === B.PISTON || _oldId === B.STICKY_PISTON) && newId === B.AIR) {
        const facing = this.world.pistonFacings.get(`${x},${y},${z}`);
        if (facing !== undefined) {
          const [dx, dy, dz] = this.getFacingVector(facing);
          if (this.world.getBlock(x + dx, y + dy, z + dz) === B.PISTON_HEAD) {
            this.world.setBlock(x + dx, y + dy, z + dz, B.AIR);
          }
        }
      }

      if (isRedstoneRelated(x, y, z)) {
        this.triggerRedstoneUpdate(x, y, z);
      }
    };

    this.player.init({
      world: this.world,
      input: this.input,
      onRedstoneUpdate: (x, y, z) => this.triggerRedstoneUpdate(x, y, z),
      renderer: this.renderer,
      entities: this.entities,
      audio: this.audio,
      isUIOpen: () => this.state !== 'playing',
      openContainer: (kind, x, y, z) => this.openBlockContainer(kind, x, y, z),
      openTrade: (villager) => this.openTrade(villager),
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
      onBoneMeal: (x, y, z) => this.applyBoneMeal(x, y, z),
      onFish: (id) => {
        if (id === I.RAW_FISH) this.adv.unlock('fish');
        const p = this.player.pos;
        this.xpOrbs.spawn(p.x, p.y + 1, p.z, 1 + Math.floor(Math.random() * 6));
      },
      onTameWolf: () => this.adv.unlock('wolf'),
      onTrade: () => this.adv.unlock('trade'),
      onDeath: () => this.onDeath(),
      onTeleport: () => this.teleportPlayerDimension(),
      toast: (msg) => this.hud.toast(msg),
      onAdvance: (id) => this.adv.unlock(id),
      ignite: (x, y, z) => this.fire.ignite(x, y, z),
      onXp: (x, y, z, n) => this.xpOrbs.spawn(x, y, z, n),
      cookOnCampfire: (x, y, z, id) => {
        const ok = this.campfires.add(this.world.dimension, x, y, z, id);
        if (ok) this.adv.unlock('campfire');
        return ok;
      },
      throwItem: (id, x, y, z, dx, dy, dz) => this.throwables.throw(id, x, y, z, dx, dy, dz),
      lightPortal: (x, y, z) => this.nether.tryLight(x, y, z),
      useAnchor: (x, y, z, held) => this.nether.useAnchor(x, y, z, held, this.player.mode === 'creative'),
    });

    if (save) {
      this.player.mode = save.gameMode;
      this.player.load(save.player);
      this.player.inventory.load(save.inventory);
      this.dayTime = save.environment?.dayTime ?? 0.1;
      this.spawnPoint = save.spawn ?? null;
      if (save.advancements) this.adv.load(save.advancements);
      this.fire.load(save.fires);
      this.campfires.load(save.campfires);
      this.nether.load(save.nether);

      const ow = this.world.dimData.overworld;
      for (const [k, v] of Object.entries(save.world ?? {})) ow.savedChunks.set(k, v);
      for (const [k, v] of Object.entries(save.blockEntities ?? {})) {
        if ((v as ChestSave).type === 'chest') {
          ow.blockEntities.set(k, ChestState.from(v as ChestSave));
        } else {
          ow.blockEntities.set(k, FurnaceState.from(v as FurnaceSave));
        }
      }
      for (const [k, v] of Object.entries(save.doors ?? {})) {
        ow.doorStates.set(k, {
          facing: (v.facing & 3) as 0 | 1 | 2 | 3,
          open: !!v.open,
          hingeRight: !!v.hingeRight,
          swing: v.open ? 1 : 0,
        });
      }
      for (const [k, v] of Object.entries(save.torches ?? {})) ow.torchFacings.set(k, v as number);
      for (const [k, v] of Object.entries(save.beds ?? {})) ow.bedFacings.set(k, v as number);
      for (const [k, v] of Object.entries(save.water ?? {})) ow.waterLevels.set(k, v as number);
      for (const [k, v] of Object.entries(save.lava ?? {})) ow.lavaLevels.set(k, v as number);
      for (const [k, v] of Object.entries(save.redstonePower ?? {})) ow.redstonePower.set(k, v as number);
      for (const [k, v] of Object.entries(save.redstoneStates ?? {})) ow.redstoneStates.set(k, v as any);
      for (const [k, v] of Object.entries(save.pistonFacings ?? {})) ow.pistonFacings.set(k, v as number);

      const ne = this.world.dimData.nether;
      for (const [k, v] of Object.entries(save.worldNether ?? {})) ne.savedChunks.set(k, v);
      for (const [k, v] of Object.entries(save.blockEntitiesNether ?? {})) {
        if ((v as ChestSave).type === 'chest') {
          ne.blockEntities.set(k, ChestState.from(v as ChestSave));
        } else {
          ne.blockEntities.set(k, FurnaceState.from(v as FurnaceSave));
        }
      }
      for (const [k, v] of Object.entries(save.doorsNether ?? {})) {
        ne.doorStates.set(k, {
          facing: (v.facing & 3) as 0 | 1 | 2 | 3,
          open: !!v.open,
          hingeRight: !!v.hingeRight,
          swing: v.open ? 1 : 0,
        });
      }
      for (const [k, v] of Object.entries(save.torchesNether ?? {})) ne.torchFacings.set(k, v as number);
      for (const [k, v] of Object.entries(save.bedsNether ?? {})) ne.bedFacings.set(k, v as number);
      for (const [k, v] of Object.entries(save.waterNether ?? {})) ne.waterLevels.set(k, v as number);
      for (const [k, v] of Object.entries(save.lavaNether ?? {})) ne.lavaLevels.set(k, v as number);
      for (const [k, v] of Object.entries(save.redstonePowerNether ?? {})) ne.redstonePower.set(k, v as number);
      for (const [k, v] of Object.entries(save.redstoneStatesNether ?? {})) ne.redstoneStates.set(k, v as any);
      for (const [k, v] of Object.entries(save.pistonFacingsNether ?? {})) ne.pistonFacings.set(k, v as number);

      if (save.dimension === 'nether') {
        this.world.dimension = 'nether';
        this.world.generator.dimension = 'nether';
        this.world.savedChunks = ne.savedChunks;
        this.world.blockEntities = ne.blockEntities;
        this.world.doorStates = ne.doorStates;
        this.world.torchFacings = ne.torchFacings;
        this.world.bedFacings = ne.bedFacings;
        this.world.waterLevels = ne.waterLevels;
        this.world.lavaLevels = ne.lavaLevels;
        this.world.redstonePower = ne.redstonePower;
        this.world.redstoneStates = ne.redstoneStates;
        this.world.pistonFacings = ne.pistonFacings;
        this.world.redstoneBlocks = ne.redstoneBlocks;
      }
      // restore known village dwelling spots so villagers repopulate on revisit
      if (save.villageSpawns) this.world.generator.villageSpawns = save.villageSpawns.map((s) => ({ ...s }));
      // captured pets come back with the player (wild mobs respawn naturally)
      if (save.pets?.length) this.entities.loadPets(save.pets);
    } else {
      this.player.mode = fresh!.mode;
      const spawn = this.world.generator.findSpawn();
      this.player.pos = spawn;
      if (this.player.mode === 'creative') {
        const starter = [B.GRASS, B.DIRT, B.STONE, B.COBBLE, B.PLANKS, B.LOG, B.GLASS, B.TORCH, B.TNT];
        for (let i = 0; i < starter.length; i++) this.player.inventory.slots[i] = { id: starter[i], count: 64 };
      }
    }

    // title-card stats carry over between sessions
    const meta = readWorldMeta(slot);
    this.playSecBase = save ? meta.playSec ?? 0 : 0;
    this.worldDays = save ? Math.max(0, (meta.day ?? 1) - 1) : 0;

    // dev helper: open the page with #night to start after sundown
    if (location.hash.includes('night')) this.dayTime = 0.62;

    this.player.inventory.onChange = () => this.onInventoryChange();
    this.onInventoryChange();
    this.adv.unlock('root');

    this.hud.onCraft = (id) => {
      if (id === B.TABLE) this.adv.unlock('planks');
      if (id === I.STONE_PICK) this.adv.unlock('stone_age');
      if (id === I.IRON_PICK) this.adv.unlock('iron_pick');
      if (id === I.BOW) this.adv.unlock('bow');
      if (id === I.BREAD) this.adv.unlock('bread');
      if (hasDef(id) && (def(id).name.endsWith('_slab') || def(id).name.endsWith('_stairs'))) this.adv.unlock('builder');
      if (id === B.ENCHANTING_TABLE) this.adv.unlock('ench_table');
      if (id === I.MAP) this.adv.unlock('cartographer');
      if (id === B.CAKE) this.adv.unlock('bake_cake');
      if (id === B.LANTERN || id === B.JACK_O_LANTERN) this.adv.unlock('lantern');
      if (id === B.SOUL_TORCH || id === B.SOUL_LANTERN) this.adv.unlock('soul_light');
      if (hasDef(id) && def(id).name.endsWith('_wool') && id !== B.WOOL) this.adv.unlock('dye');
      // containers handed back by the recipe (the cake's milk buckets)
      for (const r of craftRemainders(id)) {
        const left = this.player.inventory.add(r.id, r.count);
        if (left > 0) { const p = this.player.pos; this.entities.spawnDrop(p.x, p.y + 1, p.z, r.id, left); }
      }
    };
    this.hud.onTrade = () => { this.adv.unlock('trade'); this.adv.unlock('village'); };

    this.wireInput();
    this.hud.onDropLeftover = (id, count, dur, mob, ench) => {
      const p = this.player.pos;
      this.entities.spawnDrop(p.x, p.y + 1, p.z, id, count, dur, mob, ench);
    };

    void this.pregenerate();
  }

  // --- boot -------------------------------------------------------------------

  private async pregenerate(): Promise<void> {
    this.hud.showLoading(this.world.dimension === 'nether' ? 'Entering the Nether' : 'Generating world');
    const px = this.player.pos.x, pz = this.player.pos.z;
    // the loading diorama samples real spawn terrain as each chunk arrives
    this.hud.setLoadingTerrain(px, pz, Math.floor(this.player.pos.y) - 1, (wx, wz) => this.sampleLoadColumn(wx, wz));
    for (let i = 0; i < 400 && !this.disposed; i++) {
      this.world.update(px, pz, 14);
      this.processMeshing(14);
      const pcx = Math.floor(px / CX), pcz = Math.floor(pz / CZ);
      let gen = 0, meshed = 0;
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          const c = this.world.getChunk(pcx + dx, pcz + dz);
          if (!c || !c.ready) continue;
          gen++;
          if (!this.world.dirtySet.has(chunkKey(pcx + dx, pcz + dz))) meshed++;
        }
      }
      this.hud.setLoadingDetail(gen / 25, meshed / 25);
      if (meshed === 25) break;
      await new Promise((r) => requestAnimationFrame(r));
    }
    if (this.disposed) return;
    await this.hud.finishLoading();
    if (this.disposed) return;
    this.hud.showGameUI();
    this.state = 'playing';
    // sweep the camera down into the player's eyes (dev/test hooks skip it so
    // harness screenshots keep their framing)
    this.introT = /nointro|debug|test/.test(location.hash) ? INTRO_TIME : 0;
    // dev helper: #debugmobs drops a few tameable/rideable mobs at spawn and
    // faces the player east toward the horse for screenshot testing
    if (location.hash.includes('debugmobs')) {
      (window as unknown as { __game: unknown; __B: unknown }).__game = this; // dev: lets screenshot harnesses frame mobs
      (window as unknown as { __B: unknown }).__B = B; // dev: block-id enum for headless feature tests
      (window as unknown as { __findId: unknown }).__findId = (name: string): number => {
        for (let i = 1; i < 512; i++) if (hasDef(i) && def(i).name === name) return i;
        return -1;
      }; // dev: item id by registry name, for held-item/icon harnesses
      const p = this.player.pos;
      this.entities.spawnMob('horse', p.x + 3, p.y + 1, p.z);
      this.entities.spawnMob('wolf', p.x + 3, p.y + 1, p.z - 1.5);
      this.entities.spawnMob('cat', p.x + 3, p.y + 1, p.z + 1.5);
      this.entities.spawnMob('pig', p.x + 2, p.y + 1, p.z - 2);
      this.entities.spawnMob('chicken', p.x + 2, p.y + 1, p.z + 2);
      this.entities.spawnMob('cow', p.x + 4, p.y + 1, p.z + 2);
      this.player.yaw = -Math.PI / 2; // look toward +x
      this.player.pitch = 0.2;
      // stock the hotbar with held-item test pieces
      const kit = [I.DIAMOND_SWORD, I.DIAMOND_PICK, I.DIAMOND_AXE, I.BOW, I.APPLE, I.BONE, I.FISHING_ROD];
      for (let i = 0; i < kit.length; i++) this.player.inventory.slots[i] = { id: kit[i], count: 1 };
      this.onInventoryChange();
      // wall + floor torch demo on a stone pillar
      const bx = Math.floor(p.x) + 6, by = Math.floor(p.y), bz = Math.floor(p.z);
      this.world.setBlock(bx, by, bz, B.STONE);
      this.world.setBlock(bx, by + 1, bz, B.STONE);
      const wall = (wx: number, wy: number, wz: number, facing: number): void => {
        this.world.torchFacings.set(`${wx},${wy},${wz}`, facing);
        this.world.setBlock(wx, wy, wz, B.TORCH);
      };
      wall(bx - 1, by + 1, bz, 1);
      wall(bx, by + 1, bz + 1, 2);
      wall(bx, by + 1, bz - 1, 3);
      this.world.setBlock(bx, by + 2, bz, B.TORCH); // floor torch on top
      // a reachable, complete 2-block bed right in front for sleep testing
      const bedX = Math.floor(p.x) + 1, bedY = Math.floor(p.y), bedZ = Math.floor(p.z);
      for (const dz of [0, -1]) {
        this.world.setBlock(bedX, bedY - 1, bedZ + dz, B.STONE);
        this.world.setBlock(bedX, bedY + 1, bedZ + dz, B.AIR);
        this.world.setBlock(bedX, bedY + 2, bedZ + dz, B.AIR);
        this.world.bedFacings.set(`${bedX},${bedY},${bedZ + dz}`, 0); // head toward -z
      }
      this.world.setBlock(bedX, bedY, bedZ, B.BED);
      this.world.setBlock(bedX, bedY, bedZ - 1, B.BED_HEAD);
    }
    // dev helper: #debugcatch stocks catchers and lines up throwable targets
    if (location.hash.includes('debugcatch')) {
      (window as unknown as { __game: unknown; __B: unknown }).__game = this;
      (window as unknown as { __B: unknown }).__B = B;
      const p = this.player.pos;
      this.player.inventory.slots[0] = { id: I.MOB_CATCHER, count: 16 };
      this.player.inventory.slots[1] = { id: I.AMETHYST, count: 64 };
      this.player.inventory.slots[2] = { id: I.DIAMOND_SWORD, count: 1 };
      this.player.inventory.selected = 0;
      this.onInventoryChange();
      this.player.yaw = -Math.PI / 2; // look toward +x, down the target line
      this.player.pitch = 0;
      const line: [string, number, number][] = [
        ['zombie', 7, -2], ['creeper', 8, 0], ['skeleton', 9, 2], ['spider', 6, 3], ['cow', 6, -4],
      ];
      for (const [kind, dx, dz] of line) {
        this.entities.spawnMob(kind as never, p.x + dx, p.y + 1, p.z + dz);
      }
    }
    if (location.hash.includes('fluidtest')) this.setupFluidTestScene();
    if (location.hash.includes('bowtest')) this.setupBowTest();
    this.hud.toast('Click to capture the mouse');
    this.lastFrame = performance.now();
    this.loop(this.lastFrame);
  }

  /** After loading, the view starts high behind the player looking down at the
   *  spawn and eases into first person (skipped for reduced-motion users). */
  private applyIntroSweep(cam: THREE.PerspectiveCamera, dt: number): void {
    this.introT += dt;
    let reduced = false;
    try { reduced = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* old browser */ }
    if (reduced || this.player.mode === 'creative' && this.player.flying) { this.introT = INTRO_TIME; return; }
    const x = Math.min(1, this.introT / INTRO_TIME);
    const k = 1 - x * x * x * (x * (x * 6 - 15) + 10); // 1 → 0, smootherstep
    if (k <= 0) return;
    const yaw = this.player.yaw + k * 0.9;
    let back = 8 * k, up = 7 * k;
    const px = cam.position.x, py = cam.position.y, pz = cam.position.z;
    // keep the sweep out of hillsides: rise until the camera sits in air
    for (let i = 0; i < 12 && k > 0.05; i++) {
      const id = this.world.getBlock(Math.floor(px + Math.sin(yaw) * back), Math.floor(py + up), Math.floor(pz + Math.cos(yaw) * back));
      if (id === B.AIR || !def(id).solid) break;
      up += 1;
    }
    cam.position.set(px + Math.sin(yaw) * back, py + up, pz + Math.cos(yaw) * back);
    cam.rotation.set(this.player.pitch * (1 - k) - 0.62 * k, yaw, 0);
  }

  /** One terrain column for the loading diorama: ground block + height, any
   *  water above it, a tree standing on it, and the biome grass tint. */
  private sampleLoadColumn(wx: number, wz: number): LoadColumn | null {
    const c = this.world.getChunk(Math.floor(wx / CX), Math.floor(wz / CZ));
    if (!c || !c.ready) return null;
    let y = c.heightmap[(wz & 15) * 16 + (wx & 15)] - 1;
    // the Nether has a roof: start just above spawn height and dig down to open air
    if (this.world.dimension === 'nether') {
      y = Math.min(y, Math.floor(this.player.pos.y) + 6);
      while (y > 1 && this.world.getBlock(wx, y, wz) !== B.AIR) y--;
    }
    let water = -1, leaf = 0, log = 0;
    for (; y > 0; y--) {
      const id = this.world.getBlock(wx, y, wz);
      if (id === B.AIR) continue;
      if (id === B.LEAVES || id === B.BIRCH_LEAVES || id === B.SPRUCE_LEAVES) { if (!leaf) leaf = id; continue; }
      if (id === B.LOG || id === B.BIRCH_LOG || id === B.SPRUCE_LOG) { log = id; continue; }
      const d = def(id);
      if (d.liquid) { if (water < 0 && id === B.WATER) water = y; continue; }
      if (!d.solid) continue;
      // the worker-computed biome tint rides on the chunk (no main-thread noise)
      const ti = ((wz & 15) * 16 + (wx & 15)) * 3;
      const t = c.tint;
      const tint: [number, number, number] = t ? [Math.min(1, t[ti]), Math.min(1, t[ti + 1]), Math.min(1, t[ti + 2])] : [0.9, 1, 0.7];
      return { y, id, water, leaf, log, tint };
    }
    return null;
  }

  private setupFluidTestScene(): void {
    this.dayTime = 0.25;
    const ox = Math.floor(this.player.pos.x) + 4;
    const oz = Math.floor(this.player.pos.z) - 6;
    const y = Math.floor(this.player.pos.y) + 14;

    for (let dx = -1; dx <= 15; dx++) {
      for (let dz = -1; dz <= 11; dz++) {
        for (let dy = -2; dy <= 8; dy++) this.world.setBlock(ox + dx, y + dy, oz + dz, B.AIR);
      }
    }
    for (let dx = 0; dx <= 14; dx++) {
      for (let dz = 0; dz <= 10; dz++) this.world.setBlock(ox + dx, y, oz + dz, B.STONE);
    }

    this.world.setBlock(ox + 4, y, oz + 5, B.AIR);
    this.world.waterLevels.delete(`${ox + 3},${y + 1},${oz + 5}`);
    this.world.setBlock(ox + 3, y + 1, oz + 5, B.WATER);

    this.world.lavaLevels.delete(`${ox + 9},${y + 1},${oz + 3}`);
    this.world.setBlock(ox + 9, y + 1, oz + 3, B.LAVA);

    for (let i = 0; i < 120; i++) this.world.tickWater();
    for (let i = 0; i < 120; i++) this.world.tickLava();
    this.processMeshing(1000);

    this.player.pos = { x: ox + 7.5, y: y + 6.2, z: oz + 13.5 };
    this.player.vel = { x: 0, y: 0, z: 0 };
    this.player.yaw = 0;
    this.player.pitch = -0.48;
    this.player.flying = true;
    this.player.inventory.selected = 0;
    this.player.inventory.slots[0] = null;
    this.onInventoryChange();
    document.body.dataset.fluidtest = 'ready';
  }

  private setupBowTest(): void {
    this.player.mode = 'creative';
    this.player.inventory.selected = 0;
    this.player.inventory.slots[0] = { id: I.BOW, count: 1 };
    this.player.inventory.slots[1] = { id: I.ARROW, count: 64 };
    this.player.yaw = 0;
    this.player.pitch = 0;
    this.onInventoryChange();
    document.body.dataset.bowtest = 'ready';
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
        if (this.hud.isControlsOpen()) return; // the controls page freed the mouse
        if (this.state === 'playing') this.openPause();
      }
    };

    this.input.onMouseDown = (button) => {
      if (button === 0) this.player.onLeftClick();
      // middle click: pick block
      if (button === 1 && this.state === 'playing' && this.input.active) this.player.pickBlock();
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
        case 'KeyQ':
          // Q tosses one of the held item; Ctrl+Q (sneak+Q) tosses the stack
          if (this.state === 'playing' && this.input.active) {
            this.player.dropSelected(this.input.down('ControlLeft') || this.input.down('ControlRight'));
          }
          break;
        case 'KeyE':
          if (this.state === 'playing' && this.input.active) this.openInventory();
          else if (this.state === 'container') this.closeContainer();
          break;
        case 'F3':
          this.hud.setDebugVisible(!this.hud.isDebugVisible());
          break;
        case 'F1':
          // hide the whole HUD (and the hand) for clean views
          if (this.state === 'playing' || this.state === 'paused') {
            const off = !this.hud.isHudHidden();
            this.hud.setHudHidden(off);
            this.renderer.setHeldVisible(!off);
          }
          break;
        case 'F2':
          if (this.state !== 'loading') this.takeScreenshot();
          break;
        case 'KeyH':
          if (this.hud.isControlsOpen()) this.closeControls();
          else if (this.state === 'playing') {
            this.input.exitLock();
            this.hud.toggleControls(() => { if (this.state === 'playing') this.input.requestLock(); });
          }
          break;
        case 'Escape':
          // with pointer lock active the browser eats Esc; this handles menus
          if (this.hud.isControlsOpen()) this.closeControls();
          else if (this.state === 'container') this.closeContainer();
          else if (this.hud.isAdvancementsOpen()) this.hud.hideAdvancements();
          else if (this.state === 'sleeping') this.leaveBed();
          else if (this.state === 'paused') this.resume();
          break;
      }
    };

    // tapping a hotbar slot selects it (touch + a convenience on desktop)
    this.hud.onHotbarSelect = (i) => { if (this.state === 'playing') this.player.selectSlot(i); };
    // the container panel's ✕ button closes it (essential on touch — no Esc key)
    this.hud.onCloseContainer = () => this.closeContainer();

    // on phones/tablets: on-screen joystick + look + action buttons, no pointer lock
    if (isTouchDevice()) {
      this.input.touchActive = true;
      this.touch = new TouchControls(this.app.root, this.input, {
        onInventory: () => {
          if (this.state === 'playing') this.openInventory();
          else if (this.state === 'container') this.closeContainer();
        },
        onFly: () => {
          if (this.state !== 'playing') return;
          this.player.toggleFly();
          this.hud.toast(this.player.flying ? 'Flying enabled' : 'Flying disabled');
        },
        onPause: () => {
          if (this.state === 'playing') this.openPause();
          else if (this.state === 'paused') this.resume();
        },
      });
    }
  }

  // --- UI state machine ---------------------------------------------------------------

  private closeControls(): void {
    this.hud.toggleControls(); // closes it
    if (this.state === 'playing') this.input.requestLock();
  }

  /** Render one frame and hand the canvas to `use` in the same task (the
   *  WebGL buffer is only readable right after it was drawn). */
  private withFreshFrame<T>(use: (c: HTMLCanvasElement) => T): T | null {
    try {
      const eye = this.renderer.camera.position;
      const inLava = this.world.getBlock(Math.floor(eye.x), Math.floor(eye.y), Math.floor(eye.z)) === B.LAVA;
      this.renderer.render(this.player.underwaterEye() ? 'water' : inLava ? 'lava' : 'air');
      return use(this.renderer.canvas);
    } catch {
      return null;
    }
  }

  /** F2: save the current view as a PNG download. */
  private takeScreenshot(): void {
    const url = this.withFreshFrame((c) => c.toDataURL('image/png'));
    if (!url) { this.hud.toast('Screenshot failed'); return; }
    const d = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    const name = `voxelcraft_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}.png`;
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    this.hud.screenshotFlash(name);
  }

  /** Title-card extras: a small thumbnail of the current view, play time, dimension. */
  private recordWorldCard(): void {
    // a card-sized JPEG of the current view (small enough for localStorage)
    const thumb = this.withFreshFrame((src) => {
      const c = document.createElement('canvas');
      c.width = 128; c.height = 72;
      const ar = src.width / src.height, tr = 128 / 72;
      const sw = ar > tr ? src.height * tr : src.width, sh = ar > tr ? src.height : src.width / tr;
      c.getContext('2d')!.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, 0, 0, 128, 72);
      return c.toDataURL('image/jpeg', 0.72);
    });
    if (thumb) recordWorldMeta(this.slot, { thumb });
    recordWorldMeta(this.slot, {
      playSec: (this.playSecBase ?? 0) + this.elapsed,
      dim: this.world.dimension,
      day: Math.floor(this.worldDays) + 1,
    });
  }

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
      mouseSens: () => getControls().mouseSens,
      touchLook: () => getControls().touchLook,
      onMouseSens: (mult: number) => { setControls({ mouseSens: mult }); },
      onTouchLook: (mult: number) => { setControls({ touchLook: mult }); },
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
      trades: [],
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
          if (this.world.dimension === 'nether') fillNetherChest((st as ChestState).slots, this.world.generator.seed, x, y, z);
          else this.rollLoot(st as ChestState);
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
        trades: [],
      };
      this.containerPos = key;
    } else {
      this.container = { kind: 'table', craftW: 3, craftGrid: new Array(9).fill(null), furnace: null, chest: null, trades: [] };
      this.containerPos = null;
    }
    this.state = 'container';
    if (kind === 'chest') this.audio.play('chestOpen');
    this.input.exitLock();
    this.hud.openContainer(this.container, this.player.inventory, this.player.mode);
  }

  /** Open the villager trade screen. Trades mutate the villager entity directly. */
  private openTrade(villager: Entity): void {
    this.container = {
      kind: 'trade',
      craftW: 0,
      craftGrid: [],
      furnace: null,
      chest: null,
      trades: villager.trades,
    };
    this.containerPos = null;
    this.tradeVillager = villager;
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
      [I.CARROT, 2, 5, 3],
      [I.POTATO, 2, 5, 3],
      [I.BEETROOT_SEEDS, 1, 4, 2],
      [I.BREAD, 1, 2, 2],
      [I.STRING, 1, 3, 2],
      [I.GUNPOWDER, 1, 3, 2],
      [I.ARROW, 2, 6, 3],
      [I.COAL, 2, 5, 4],
      [I.BOW, 1, 1, 1],
      [B.TORCH, 2, 6, 3],
      [B.PLANKS, 2, 8, 2],
      [I.PUMPKIN_SEEDS, 1, 3, 2],
      [I.MELON_SEEDS, 1, 3, 2],
      [I.EXPERIENCE_BOTTLE, 1, 3, 2],
      [I.GLASS_BOTTLE, 1, 3, 1],
      [I.WARP_PEARL, 1, 2, 1],
      [I.FIREWORK_ROCKET, 2, 5, 1],
      [I.GLIDER, 1, 1, 1],
      [I.MAP, 1, 1, 1],
      [I.AMETHYST, 1, 3, 2],
      [I.BOOK, 1, 3, 2],
      [I.POTION_HEALING, 1, 1, 1],
      [I.POTION_NIGHT_VISION, 1, 1, 1],
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

  /** Both cells of the bed the given half belongs to, plus its facing. */
  private bedHalves(x: number, y: number, z: number): {
    foot: { x: number; z: number }; head: { x: number; z: number }; facing: number;
  } {
    const facing = this.world.bedFacings.get(`${x},${y},${z}`) ?? 0;
    const dvx = facing === 1 ? -1 : facing === 3 ? 1 : 0;
    const dvz = facing === 0 ? -1 : facing === 2 ? 1 : 0;
    const isHead = this.world.getBlock(x, y, z) === B.BED_HEAD;
    return {
      foot: isHead ? { x: x - dvx, z: z - dvz } : { x, z },
      head: isHead ? { x, z } : { x: x + dvx, z: z + dvz },
      facing,
    };
  }

  /** Right-clicking a bed, following vanilla's rules: beds detonate outside the
   *  Overworld, you may only sleep from dusk until just before dawn (or through
   *  a thunderstorm), the bed must be unobstructed, and no monster may be within
   *  8 blocks. Using a bed always sets the respawn point. */
  private useBed(x: number, y: number, z: number): void {
    // Nether: no sleeping — the bed explodes in your face (vanilla behaviour)
    if (this.world.dimension !== 'overworld') {
      const { foot, head } = this.bedHalves(x, y, z);
      this.world.setBlock(foot.x, y, foot.z, B.AIR);
      this.world.setBlock(head.x, y, head.z, B.AIR);
      this.world.bedFacings.delete(`${foot.x},${y},${foot.z}`);
      this.world.bedFacings.delete(`${head.x},${y},${head.z}`);
      this.entities.explode(x + 0.5, y + 0.5, z + 0.5, 3.2);
      this.hud.toast('The bed exploded!');
      return;
    }
    // using a bed claims it as the respawn point (announced once per bed)
    const { foot: spawnFoot } = this.bedHalves(x, y, z);
    const prev = this.spawnPoint;
    const newSpawn = { x: spawnFoot.x + 0.5, y: y + 1, z: spawnFoot.z + 0.5 };
    const spawnChanged = !prev || prev.x !== newSpawn.x || prev.y !== newSpawn.y || prev.z !== newSpawn.z;
    this.spawnPoint = newSpawn;
    this.nether.clearAnchor(); // one spawn point: the bed replaces an anchor
    this.adv.unlock('bed');
    // sleep window: dusk (0.52) until just before dawn (0.98), or any time in a
    // thunderstorm — mirrors Minecraft's 12542..23459 tick window
    const storming = this.weather.kind === 'thunder' && this.weather.intensity > 0.2;
    const canSleep = (this.dayTime > 0.52 && this.dayTime < 0.98) || storming;
    if (!canSleep) {
      this.hud.toast(spawnChanged
        ? 'Respawn point set - you can only sleep at night or during a thunderstorm'
        : 'You can only sleep at night or during a thunderstorm');
      this.audio.play('fail');
      return;
    }
    const { foot, head, facing } = this.bedHalves(x, y, z);
    if (isSolid(this.world.getBlock(foot.x, y + 1, foot.z))
      || isSolid(this.world.getBlock(head.x, y + 1, head.z))) {
      this.hud.toast('This bed is obstructed');
      this.audio.play('fail');
      return;
    }
    const p = this.player.pos;
    if (this.entities.hostileNear(p.x, p.y + 1, p.z, 8)) {
      this.hud.toast('You may not rest now; there are monsters nearby');
      this.audio.play('fail');
      return;
    }
    // camera hovers over the pillow looking down the bed. It stays inside the
    // bed's own column so a headboard wall can never clip into view.
    const dvx = facing === 1 ? -1 : facing === 3 ? 1 : 0;
    const dvz = facing === 0 ? -1 : facing === 2 ? 1 : 0;
    this.startSleep({ cx: head.x + 0.5, cz: head.z + 0.5, y, yaw: Math.atan2(dvx, dvz) });
    if (spawnChanged) this.hud.toast('Respawn point set');
  }

  /** Get into bed: lie down, then fade out, skip to dawn and fade back in. The
   *  whole sequence is driven from the frame loop so Leave Bed can cancel it. */
  private startSleep(bed: { cx: number; cz: number; y: number; yaw: number }): void {
    if (this.state !== 'playing') return;
    this.state = 'sleeping';
    this.sleepBed = bed;
    this.sleepT = 0;
    this.sleepSkipped = false;
    this.input.exitLock();
    this.player.vel.x = 0; this.player.vel.z = 0;
    this.audio.play('click');
    this.hud.showSleepPrompt(() => this.leaveBed());
    this.hud.setCrosshairVisible(false);
    this.renderer.setHeldVisible(false);
  }

  /** Out of bed — either by choice (Leave Bed / Esc) or after waking at dawn. */
  private leaveBed(): void {
    if (this.state !== 'sleeping') return;
    this.state = 'playing';
    this.sleepBed = null;
    this.hud.hideSleepPrompt();
    this.hud.setSleepFade(0);
    this.hud.setCrosshairVisible(true);
    this.renderer.setHeldVisible(true);
    this.input.requestLock();
  }

  /** Sleep timeline (seconds): 0–1.2 lying awake, 1.2–1.9 fade to black, the
   *  night skips at 1.9, 1.9–2.7 fade back in, wake at 2.7. */
  private updateSleep(dt: number): void {
    if (!this.sleepBed) return;
    this.sleepT += dt;
    const t = this.sleepT;
    this.player.vel.x = 0; this.player.vel.z = 0;
    if (t < 1.2) {
      this.hud.setSleepFade(0);
      return;
    }
    if (t < 1.9) {
      this.hud.setSleepFade((t - 1.2) / 0.7);
      return;
    }
    if (!this.sleepSkipped) {
      this.sleepSkipped = true;
      this.dayTime = 0.0;       // sunrise
      this.nightsAwake = 0;     // sleeping clears phantom insomnia
      this.wasNight = false;
      this.survivedNight = false;
      this.weather.setKind('clear'); // vanilla: sleeping clears rain/thunder
      this.hud.hideSleepPrompt();
      this.audio.play('level');
    }
    if (t < 2.7) {
      this.hud.setSleepFade(1 - (t - 1.9) / 0.8);
      return;
    }
    this.leaveBed();
    this.hud.toast('Good morning');
  }

  /** Is rain falling on this spot right now (Overworld, open sky, not snow)? */
  private isRainingOn(x: number, y: number, z: number): boolean {
    const w = this.weather;
    if (this.world.dimension !== 'overworld' || w.kind === 'clear' || w.intensity < 0.3) return false;
    const biome = this.world.generator.biomeAt(Math.floor(x), Math.floor(z));
    if (biome === 'desert') return false;
    return this.world.skyLight(Math.floor(x), Math.floor(y) + 1, Math.floor(z)) >= 0.99;
  }

  /** Fire upkeep at 20 Hz: flames spread/burn out, mobs standing in fire
   *  scorch, and rain puts out a burning player. */
  private tickFire(dt: number): void {
    this.fireAcc += dt;
    if (this.fireAcc >= 0.25) {
      this.fire.tick(this.fireAcc);
      this.fireAcc = 0;
    }
    const p = this.player;
    if (p.fireT > 0 && this.isRainingOn(p.pos.x, p.pos.y + 1, p.pos.z)) p.fireT = 0;
    this.mobBurnAcc += dt;
    if (this.mobBurnAcc < 0.5 || this.fire.count === 0) return;
    this.mobBurnAcc = 0;
    for (const e of this.entities.entities) {
      if (e.dead || !this.entities.isMob(e)) continue;
      const bx = Math.floor(e.pos.x), bz = Math.floor(e.pos.z);
      const by = Math.floor(e.pos.y);
      if (this.world.getBlock(bx, by, bz) === B.FIRE || this.world.getBlock(bx, by + 1, bz) === B.FIRE) {
        this.entities.hurt(e, 1, Math.random() - 0.5, Math.random() - 0.5);
      }
    }
  }

  /** Lightning struck at (x,y,z): ignite TNT, scorch mobs, flash + thunder. */
  private onLightning(x: number, y: number, z: number): void {
    this.audio.thunder(Math.hypot(x - this.player.pos.x, z - this.player.pos.z));
    this.adv.unlock('thunder');
    // the bolt can set the strike point alight
    if (Math.random() < 0.6) this.fire.ignite(x, y, z);
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
    if (this.container?.kind === 'chest') this.audio.play('chestClose');
    this.container = null;
    this.containerPos = null;
    this.state = 'playing';
    this.input.requestLock();
  }

  private onDeath(): void {
    const deathPos = { ...this.player.pos };
    this.dropPlayerInventory(deathPos);
    // experience spills out as orbs; the recovery compass remembers the spot
    this.xpOrbs.spawn(deathPos.x, deathPos.y + 0.5, deathPos.z, this.player.deathXp());
    this.player.xpLevel = 0;
    this.player.xpProgress = 0;
    this.player.lastDeath = { x: deathPos.x, y: deathPos.y, z: deathPos.z, dim: this.world.dimension };
    this.player.gliding = false;
    this.state = 'dead';
    this.input.exitLock();
    this.hud.showDeath(
      () => {
        // a charged respawn anchor brings you back in the Nether
        const anchorSpot = this.nether.respawnAtAnchor();
        if (anchorSpot) {
          this.player.respawn(anchorSpot);
          this.hud.hideDeath();
          this.state = 'playing';
          this.input.requestLock();
          return;
        }
        // otherwise dying returns you to the Overworld (the Nether is a one-way
        // trip on death, like Minecraft)
        if (this.world.dimension !== 'overworld') {
          this.world.switchDimension('overworld');
          this.hud.setNetherTint(false);
        }
        let spawn = this.spawnPoint ?? this.world.generator.findSpawn();
        // force-generate the landing chunks so the player doesn't free-fall
        const ensureAround = (p: { x: number; z: number }): void => {
          const scx = Math.floor(p.x / CX), scz = Math.floor(p.z / CZ);
          for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) this.world.ensureChunk(scx + dx, scz + dz);
        };
        ensureAround(spawn);
        // a bed spawn only holds while the bed survives and isn't walled in
        if (this.spawnPoint) {
          const bx = Math.floor(spawn.x), by = Math.floor(spawn.y), bz = Math.floor(spawn.z);
          const bed = this.world.getBlock(bx, by - 1, bz);
          const blocked = isSolid(this.world.getBlock(bx, by, bz)) || isSolid(this.world.getBlock(bx, by + 1, bz));
          if ((bed !== B.BED && bed !== B.BED_HEAD) || blocked) {
            this.spawnPoint = null;
            spawn = this.world.generator.findSpawn();
            ensureAround(spawn);
            this.hud.toast('You have no home bed, or it was obstructed');
          }
        }
        this.player.respawn({ ...spawn });
        this.hud.hideDeath();
        this.state = 'playing';
        this.input.requestLock();
      },
      () => void this.saveAndQuit(),
      this.player.lastDamageCause,
      deathPos,
    );
  }

  /** Portal travel: linking, landing and the transition live in NetherController. */
  private teleportPlayerDimension(): void {
    this.nether.travel();
  }

  private dropPlayerInventory(pos: { x: number; y: number; z: number }): void {
    const inv = this.player.inventory;
    const dropSlot = (s: Slot): void => {
      if (!s) return;
      this.entities.spawnDrop(
        pos.x + (Math.random() - 0.5) * 0.7,
        pos.y + 0.8,
        pos.z + (Math.random() - 0.5) * 0.7,
        s.id,
        s.count,
        s.dur,
        s.mob,
        s.ench,
      );
    };
    for (let i = 0; i < inv.slots.length; i++) {
      dropSlot(inv.slots[i]);
      inv.slots[i] = null;
    }
    for (let i = 0; i < inv.armor.length; i++) {
      dropSlot(inv.armor[i]);
      inv.armor[i] = null;
    }
    inv.onChange();
  }

  private async applyPack(files: File[]): Promise<void> {
    const n = await this.atlas.loadResourcePack(files);
    if (n > 0) {
      // held item + hotbar use cached canvases; force a rebuild
      const held = this.player.heldId();
      const mob = this.player.heldMob();
      this.renderer.setHeldItem(-2 as number);
      this.renderer.setHeldItem(held, mob);
      this.onInventoryChange();
      this.hud.toast(`Resource pack applied (${n} textures)`);
    } else {
      this.hud.toast('No matching textures found in that folder');
    }
  }

  private onInventoryChange(): void {
    this.hud.refreshHotbar(this.player.inventory, this.player.mode);
    const worn = this.player.inventory.armor;
    if (worn.some((a) => a)) this.adv.unlock('suit_up');
    if (worn.some((a) => a && def(a.id).name.startsWith('diamond_'))) this.adv.unlock('diamond_armor');
    if (worn.every((a) => a && def(a.id).name.startsWith('netherite_'))) this.adv.unlock('netherite_armor');
    if (this.player.inventory.slots.some((s) => s && hasDef(s.id) && def(s.id).name === 'ancient_debris')) this.adv.unlock('hidden_depths');
    this.renderer.setHeldItem(this.player.heldId(), this.player.heldMob());
    // item-name popup when the hotbar selection (or its item) changes
    const sel = this.player.inventory.selected;
    const heldId = this.player.heldId();
    const heldMob = this.player.heldMob();
    if (sel !== this.lastSelected || (heldId !== this.lastHeldId && heldId !== 0) || heldMob !== this.lastHeldMob) {
      if (heldId !== 0 && hasDef(heldId) && this.state !== 'container') {
        const hint =
          heldId === I.MOB_CATCHER ? 'Mob Catcher - right-click to throw it at a hostile mob' :
          heldId === I.MOB_CATCHER_FILLED && heldMob ? `Captured ${mobLabel(heldMob)} - right-click to release your pet` :
          heldId === I.COMPASS ? 'Compass - carry it to show heading on the minimap' :
          heldId === I.CLOCK ? 'Clock - carry it to show world time' :
          heldId === I.HOE ? 'Hoe - right-click dirt or grass to make farmland' :
          heldId === I.SHIELD ? 'Shield - hold right-click to block attacks from the front' :
          heldId === I.SPYGLASS ? 'Spyglass - hold right-click to zoom in' :
          heldId === I.SHEARS ? 'Shears - right-click a sheep for wool, or snip leaves whole' :
          heldId === I.BUCKET ? 'Bucket - scoop water or lava, or milk a cow' :
          heldId === I.MILK_BUCKET ? 'Milk Bucket - drink to clear all status effects' :
          heldId === I.MAP ? 'Explorer Map - hold it to see the land around you' :
          heldId === I.RECOVERY_COMPASS ? 'Recovery Compass - points to where you last died' :
          heldId === I.GLIDER ? 'Glider - wear it, then press jump while falling to glide' :
          heldId === I.FIREWORK_ROCKET ? 'Firework Rocket - right-click while gliding for a boost' :
          heldId === I.WARP_PEARL ? 'Warp Pearl - throw it to teleport where it lands' :
          heldId === I.GLASS_BOTTLE ? 'Glass Bottle - right-click water to fill it, then brew at a crafting table' :
          heldId === I.PUMPKIN_SEEDS || heldId === I.MELON_SEEDS ? `${def(heldId).label} - plant on farmland; fruit grows beside the stem` :
          heldId === B.ENCHANTING_TABLE ? 'Enchanting Table - right-click it holding a tool; bookshelves make it stronger' :
          heldId === B.ANVIL ? 'Anvil - right-click it holding a worn tool to mend it' :
          heldId === B.CAMPFIRE ? 'Campfire - right-click it with raw food to cook' :
          heldId === B.COMPOSTER ? 'Composter - fill it with plants to make bone meal' :
          (this.player.inventory.getSelected()?.ench) ? `${def(heldId).label} - ${Object.entries(this.player.inventory.getSelected()!.ench!).map(([k, v]) => enchantLabel(k, v)).join(', ')}` :
          heldId === I.SEEDS || heldId === I.CARROT || heldId === I.POTATO || heldId === I.BEETROOT_SEEDS
            ? `${def(heldId).label} - plant on farmland` :
            def(heldId).label;
        this.hud.showItemName(hint, heldId);
      }
      this.lastSelected = sel;
      this.lastHeldId = heldId;
      this.lastHeldMob = heldMob;
    }
  }

  // --- save ----------------------------------------------------------------------

  private buildSave(): SaveState {
    this.world.stashModified();

    const serializeBEs = (beMap: Map<string, BlockEntity>) => {
      const rec: Record<string, BlockEntitySave> = {};
      for (const [k, v] of beMap) {
        if (!v.isEmpty()) rec[k] = v.serialize();
      }
      return rec;
    };

    const serializeDoors = (doorMap: Map<string, DoorState>) => {
      const rec: Record<string, { facing: number; open: boolean; hingeRight: boolean }> = {};
      for (const [k, v] of doorMap) {
        rec[k] = { facing: v.facing, open: v.open, hingeRight: !!v.hingeRight };
      }
      return rec;
    };

    const mapToRecord = <T>(m: Map<string, T>) => {
      const rec: Record<string, T> = {};
      for (const [k, v] of m) rec[k] = v;
      return rec;
    };

    const ow = this.world.dimData.overworld;
    const ne = this.world.dimData.nether;

    return {
      version: SAVE_VERSION,
      seed: this.world.seed,
      gameMode: this.player.mode,
      player: this.player.serialize(),
      inventory: this.player.inventory.serialize(),
      dimension: this.world.dimension,
      
      world: mapToRecord(ow.savedChunks),
      blockEntities: serializeBEs(ow.blockEntities),
      doors: serializeDoors(ow.doorStates),
      torches: mapToRecord(ow.torchFacings),
      beds: mapToRecord(ow.bedFacings),
      water: mapToRecord(ow.waterLevels),
      lava: mapToRecord(ow.lavaLevels),
      redstonePower: mapToRecord(ow.redstonePower),
      redstoneStates: mapToRecord(ow.redstoneStates),
      pistonFacings: mapToRecord(ow.pistonFacings),
      
      worldNether: mapToRecord(ne.savedChunks),
      blockEntitiesNether: serializeBEs(ne.blockEntities),
      doorsNether: serializeDoors(ne.doorStates),
      torchesNether: mapToRecord(ne.torchFacings),
      bedsNether: mapToRecord(ne.bedFacings),
      waterNether: mapToRecord(ne.waterLevels),
      lavaNether: mapToRecord(ne.lavaLevels),
      redstonePowerNether: mapToRecord(ne.redstonePower),
      redstoneStatesNether: mapToRecord(ne.redstoneStates),
      pistonFacingsNether: mapToRecord(ne.pistonFacings),
      
      environment: { dayTime: this.dayTime },
      villageSpawns: this.world.generator.villageSpawns.map((s) => ({ ...s })),
      pets: this.entities.savePets(),
      advancements: this.adv.serialize(),
      ...(this.fire.count > 0 ? { fires: this.fire.serialize() } : {}),
      campfires: this.campfires.serialize(),
      nether: this.nether.serialize(),
      ...(this.spawnPoint ? { spawn: { ...this.spawnPoint } } : {}),
      lastPlayed: Date.now(),
    };
  }

  /** Save without quitting (pause-menu Save button + autosave). */
  async saveGame(): Promise<boolean> {
    if (this.saving) return true;
    this.saving = true;
    if (this.state !== 'loading') this.recordWorldCard();
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
    // a rAF timestamp can predate the performance.now() the loop was seeded
    // with (long frames, e.g. right after loading): negative dt tunnels physics
    if (dt < 0) dt = 0;
    this.elapsed += dt;
    this.fps = this.fps * 0.95 + (1 / Math.max(dt, 1e-4)) * 0.05;

    // show the touch overlay only while actually playing
    if (this.touch) {
      const tv = this.state === 'playing';
      if (tv !== this.touchVisible) { this.touchVisible = tv; this.touch.setVisible(tv); }
    }

    const paused = this.state === 'paused';
    if (!paused) {
      const prevDay = this.dayTime;
      this.dayTime = (this.dayTime + dt / DAY_LENGTH) % 1;
      if (this.dayTime < prevDay) this.worldDays++;

      if (this.state === 'sleeping') this.updateSleep(dt);
      this.player.update(dt);
      if (location.hash.includes('bowtest')) this.player.bowCharge = 0.9;
      const devBow = (window as unknown as { __bowCharge?: number }).__bowCharge;
      if (devBow !== undefined) this.player.bowCharge = devBow; // dev: harnesses hold a bow draw
      // mounting hint when the player climbs onto a horse
      if (this.player.isRiding() !== this.wasRiding) {
        this.wasRiding = this.player.isRiding();
        if (this.wasRiding) this.hud.toast('Mounted — WASD to ride, Space to jump, Shift to dismount');
      }
      this.world.update(this.player.pos.x, this.player.pos.z, 5);
      this.world.updateDoorSwings(dt);
      this.processMeshing(8);
      this.entities.update(dt, this.elapsed, this.renderer.camera.quaternion);
      waterFX.update(dt, this.world, this.renderer.camera.position, this.renderer.daylight, this.entities.entities);
      this.throwables.update(dt);
      this.xpOrbs.update(dt, this.player.dead || this.player.mode !== 'survival' ? null : this.player.pos, (n) => {
        this.player.addXp(n);
        this.audio.play('pop', 0.6);
      });

      // weather follows the player; the Nether has no sky, so no weather there
      const pp = this.player.pos;
      this.weather.setSuppressed(this.world.dimension !== 'overworld');
      this.weather.update(dt, pp.x, pp.y + this.player.eyeHeight(), pp.z);

      // weather beds (rain / snow / blizzard wind), wind, foliage, surf,
      // streams, fire, cave echo, village life and the chase music all follow
      // a probe of the player's surroundings (Audio.listen → AudioScape)
      const biome = this.world.generator.biomeAt(Math.floor(pp.x), Math.floor(pp.z));
      this.audio.listen(dt, this.world, this.player, this.entities.entities, this.weather);

      this.tickAcc += dt;
      while (this.tickAcc >= 0.05) {
        this.tickAcc -= 0.05;
        this.tick20();
      }
      // pick the ambient mood: nether > underground cave > night > lively day
      const pgx = Math.floor(this.player.pos.x), pgy = Math.floor(this.player.pos.y), pgz = Math.floor(this.player.pos.z);
      let env: AmbientEnv;
      if (this.world.dimension === 'nether') env = 'nether';
      else if (pgy < 52 && this.world.skyLight(pgx, pgy + 1, pgz) < 0.5) env = 'cave';
      else env = Math.sin(this.dayTime * Math.PI * 2) < -0.06 ? 'night' : 'day';
      // the surface biome (already computed above for weather) flavours the
      // generative music as you cross terrains
      this.audio.ambientTick(dt, env, this.world.dimension === 'nether' ? this.nether.musicBiome() : biome);

      // muffle the mix while the head is under; play a splash on crossing the surface
      const uw = this.player.underwaterEye();
      this.audio.setUnderwater(uw); // idempotent — also clears a stale muffle
      if (uw !== this.wasUnderwater) {
        this.wasUnderwater = uw;
        this.audio.play(uw ? 'submerge' : 'emerge');
      }
      // heartbeat + red vignette rise as health gets low (survival only)
      const hpFrac = this.player.mode === 'survival' ? this.player.hp / 20 : 1;
      this.audio.heartbeatTick(dt, hpFrac);
      this.hud.setLowHealth(hpFrac);

      // ambient particles: torch embers + night fireflies near the player
      this.ambientPT -= dt;
      if (this.ambientPT <= 0) {
        this.ambientPT = 0.12;
        this.emitAmbientParticles();
      }

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
    if (this.hud.settings.bob && this.player.onGround && !this.player.flying && hSpeed > 0.5) {
      this.camBob += hSpeed * dt * 1.7;
      bobY = Math.sin(this.camBob * 2) * 0.045 * Math.min(1, hSpeed / 4.3);
    }
    if (this.sleepBed) {
      // lying on the pillow: the view sits above the bed looking down its length
      const b = this.sleepBed;
      cam.position.set(b.cx, b.y + 1.45, b.cz);
      cam.rotation.set(-0.38, b.yaw, 0);
    } else {
      cam.position.set(this.player.pos.x, this.player.pos.y + this.player.eyeHeight() + bobY, this.player.pos.z);
      cam.rotation.set(this.player.pitch, this.player.yaw, 0);
      if (this.introT < INTRO_TIME) this.applyIntroSweep(cam, dt);
      cam.rotation.z += this.nether.cameraRoll(); // portal nausea
    }
    // damage screen shake: a decaying random offset while shakeT counts down
    if (this.player.shakeT > 0) {
      const k = this.player.shakeT / this.player.shakeDur;
      const m = this.player.shakeMag * k;
      cam.position.x += (Math.random() - 0.5) * m;
      cam.position.y += (Math.random() - 0.5) * m;
      cam.position.z += (Math.random() - 0.5) * m;
    }
    const baseFov = this.hud.settings.fov;
    let targetFov = this.player.sprinting ? baseFov + 10.5 : baseFov;
    targetFov += this.nether.fovOffset();
    targetFov -= 12 * Math.min(1, this.player.bowCharge / 0.9); // bow-draw zoom
    // spyglass: a hard 10x-ish zoom with the hand tucked away
    const scoping = this.player.scoping && this.state === 'playing';
    if (scoping) targetFov = 9;
    if (scoping !== this.wasScoping) {
      this.wasScoping = scoping;
      this.renderer.setHeldVisible(!scoping);
      if (scoping) { this.audio.play('click'); this.adv.unlock('spyglass'); }
    }
    if (Math.abs(cam.fov - targetFov) > 0.1) {
      cam.fov += (targetFov - cam.fov) * Math.min(1, (scoping ? 18 : 10) * dt);
      cam.updateProjectionMatrix();
    }

    this.renderer.updateEnvironment(
      this.dayTime, cam.position.x, cam.position.z, this.elapsed,
      this.weather.darkening() * this.weather.intensity,
      this.weather.flashAmount(),
      this.world.dimension === 'nether',
    );
    // biome haze, particles, portal sheets + swirl + hum, compass (the old
    // flat portal fade and red tint are superseded by NetherController)
    this.nether.update(dt, this.elapsed, this.state === 'playing' || this.state === 'container' || this.state === 'paused');
    this.renderer.setBowCharge(Math.min(1, this.player.bowCharge / 0.9));
    this.renderer.setEating(this.player.eating);
    this.renderer.setBlocking(this.player.blocking && this.state === 'playing');
    this.renderer.updateChunkFades(dt);
    this.renderer.updateHeld(dt, this.player.isMoving());
    if (this.state === 'playing') {
      const br = this.player.breaking;
      const t = this.player.target;
      const ld = this.player.lookDir();
      const mh = this.entities.raycastMobs(this.player.pos.x, this.player.pos.y + this.player.eyeHeight(), this.player.pos.z, ld.x, ld.y, ld.z, 3.5);
      if (br) this.hud.updateCrosshair('breaking', br.progress);
      else if (mh && mh.dist < (t?.dist ?? 4.5)) this.hud.updateCrosshair('mob');
      else if (t && t.id !== B.AIR && def(t.id).hardness >= 0) this.hud.updateCrosshair('target');
      else this.hud.updateCrosshair('idle');
    }
    this.hud.updateStats(this.player.hp, this.player.hunger, this.player.air, this.player.mode, this.player.inventory.armorPoints(),
      this.player.effects.has('wither'));
    this.status.update({
      visible: this.state === 'playing' || this.state === 'container' || this.state === 'paused',
      survival: this.player.mode === 'survival',
      absorb: this.player.absorb,
      armor: this.player.inventory.armorPoints(),
      effects: this.player.effectList(),
      attackCharge: this.player.attackCharge(),
      scoping,
      onFire: this.player.fireT > 0 && this.player.mode === 'survival',
    });
    this.hud.updatePets(this.entities.petStatus());
    const inGame = this.state === 'playing' || this.state === 'container' || this.state === 'paused';
    this.xpBar.update(inGame && this.player.mode === 'survival', this.player.xpLevel, this.player.xpProgress);
    // Night Vision lifts the darkness floor (and brightens caves)
    const nv = this.player.effects.get('night_vision');
    this.renderer.minAmbient = nv ? (nv.t < 10 ? 0.45 * (0.5 + 0.5 * Math.sin(nv.t * 6)) : 0.45) : 0;
    {
      const held = this.player.heldId();
      const pd = this.player.lastDeath;
      const p = this.player.pos;
      this.mapOverlay.update(dt, this.state === 'playing' && held === I.MAP,
        this.state === 'playing' && held === I.RECOVERY_COMPASS,
        {
          x: p.x, z: p.z, yaw: this.player.yaw,
          death: pd && pd.dim === this.world.dimension ? { x: pd.x, z: pd.z } : null,
          home: this.spawnPoint && this.world.dimension === 'overworld' ? { x: this.spawnPoint.x, z: this.spawnPoint.z } : null,
        },
        (wx, wz) => {
          const c = this.world.getChunk(Math.floor(wx / 16), Math.floor(wz / 16));
          if (!c || !c.ready) return null;
          const h = c.heightmap[(wz & 15) * 16 + (wx & 15)];
          return { id: this.world.getBlock(wx, h - 1, wz), h };
        });
    }
    if (this.state === 'container' && this.container?.kind === 'furnace') this.hud.updateFurnace();
    const showMinimap = this.player.inventory.count(I.COMPASS) > 0 || this.player.mode === 'creative';
    this.hud.setMinimapVisible(showMinimap);
    // minimap redraw (throttled; block sampling is relatively expensive)
    this.minimapT -= dt;
    if (showMinimap && this.minimapT <= 0) {
      this.minimapT = 0.22;
      const p = this.player.pos;
      this.hud.updateMinimap(
        p.x, p.z, this.player.yaw,
        (wx, wz) => {
          // sample the highest non-air block at this column
          const c = this.world.getChunk(Math.floor(wx / 16), Math.floor(wz / 16));
          if (!c || !c.ready) return 0;
          const h = c.heightmap[(wz & 15) * 16 + (wx & 15)];
          return this.world.getBlock(wx, h - 1, wz);
        },
        this.dayTime,
        this.player.inventory.count(I.COMPASS) > 0 || this.player.mode === 'creative',
        this.player.inventory.count(I.CLOCK) > 0 || this.player.mode === 'creative',
      );
    }
    if (this.hud.isDebugVisible()) this.updateDebug();

    const eye = this.renderer.camera.position;
    const inLava = this.world.getBlock(Math.floor(eye.x), Math.floor(eye.y), Math.floor(eye.z)) === B.LAVA;
    this.renderer.render(this.player.underwaterEye() ? 'water' : inLava ? 'lava' : 'air');
  };

  private tick20(): void {
    const isNight = Math.sin(this.dayTime * Math.PI * 2) < -0.06;
    // track surviving a full night
    if (isNight) this.survivedNight = true;
    else if (this.survivedNight) { this.survivedNight = false; this.adv.unlock('survive_night'); }
    // phantom insomnia: count a "night awake" on each dawn the player skipped sleep
    if (this.wasNight && !isNight) {
      this.nightsAwake++;
      this.wasNight = false;
    } else if (isNight) {
      this.wasNight = true;
    }
    this.player.tick(0.05);
    this.entities.tick(isNight);
    this.tickFire(0.05);

    // phantom spawns: 3+ nights without sleep, at night, survival mode
    if (isNight && this.player.mode === 'survival' && this.nightsAwake >= 3) {
      this.phantomSpawnT -= 0.05;
      if (this.phantomSpawnT <= 0) {
        this.phantomSpawnT = 30 + Math.random() * 30;
        let phantoms = 0;
        for (const e of this.entities.entities) if (e.kind === 'phantom') phantoms++;
        if (phantoms < 4) {
          const p = this.player.pos;
          const ang = Math.random() * Math.PI * 2;
          const r = 16 + Math.random() * 10;
          this.entities.spawnPhantom(
            p.x + Math.cos(ang) * r, p.y + 12 + Math.random() * 4, p.z + Math.sin(ang) * r,
          );
        }
      }
    }

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
      // every finished smelt leaves a little experience by the furnace
      if (st.output && st.output.count > outBefore && Math.random() < 0.7) {
        const hot = st.output.id === I.GOLD_INGOT || st.output.id === I.DIAMOND ? 2 : 1;
        this.xpOrbs.spawn(x + 0.5, y + 1.1, z + 0.5, hot);
      }
      const want = st.burning ? B.FURNACE_LIT : B.FURNACE;
      if (cur !== want) this.world.setBlock(x, y, z, want);
    }

    // campfires: cook what's on them, smoke, and scorch anyone standing in them
    this.campfires.tick(0.05, this.world.dimension, this.world,
      (x, y, z, id) => {
        const e = this.entities.spawnDrop(x + 0.5, y + 0.6, z + 0.5, id, 1);
        e.vel.y = 3;
        this.audio.play('pop', 0.5);
      },
      (x, y, z) => this.entities.spawnTorchFlame(x + 0.3 + Math.random() * 0.4, y + 0.7, z + 0.3 + Math.random() * 0.4));
    this.campfireHurtT -= 0.05;
    if (this.campfireHurtT <= 0 && this.player.mode === 'survival') {
      const p = this.player.pos;
      if (this.world.getBlock(Math.floor(p.x), Math.floor(p.y + 0.05), Math.floor(p.z)) === B.CAMPFIRE && !this.player.sneaking) {
        this.campfireHurtT = 0.5;
        if (!this.player.effects.has('fire_resistance')) this.player.damage(1, undefined, 'Walked into a campfire');
      }
    }

    // redstone ticks: buttons tick down, pressure plates check collision
    let redstoneDirty = false;
    for (const [key, state] of this.world.redstoneStates) {
      if (state.ticksLeft !== undefined && state.ticksLeft > 0) {
        state.ticksLeft--;
        if (state.ticksLeft === 0) {
          state.active = false;
          redstoneDirty = true;
          const [bx, by, bz] = key.split(',').map(Number);
          this.audio.play('click');
          this.world.markDirty(Math.floor(bx / 16), Math.floor(bz / 16));
        }
      }
    }

    for (const key of this.world.redstoneBlocks) {
      const [bx, by, bz] = key.split(',').map(Number);
      const bid = this.world.getBlock(bx, by, bz);
      if (bid === B.PRESSURE_PLATE) {
        const playerPos = this.player.pos;
        const playerOn = (
          playerPos.x + 0.3 > bx && playerPos.x - 0.3 < bx + 1 &&
          playerPos.y + 1.8 > by && playerPos.y < by + 0.5 &&
          playerPos.z + 0.3 > bz && playerPos.z - 0.3 < bz + 1
        );
        const occupied = playerOn || this.entities.anyEntityOnBlock(bx, by, bz);
        const state = this.world.redstoneStates.get(key) ?? { active: false };
        if (occupied) {
          // press immediately; refresh the release timer while anything stays on
          state.releaseT = PLATE_RELEASE_TICKS;
          if (!state.active) {
            state.active = true;
            this.audio.play('plateOn');
            redstoneDirty = true;
            this.world.markDirty(Math.floor(bx / 16), Math.floor(bz / 16));
          }
          this.world.redstoneStates.set(key, state);
        } else if (state.active) {
          // linger briefly after step-off so walking across doesn't slam doors
          state.releaseT = (state.releaseT ?? 0) - 1;
          if (state.releaseT <= 0) {
            state.active = false;
            this.audio.play('plateOff');
            redstoneDirty = true;
            this.world.markDirty(Math.floor(bx / 16), Math.floor(bz / 16));
          }
          this.world.redstoneStates.set(key, state);
        }
      }
    }

    if (redstoneDirty) {
      this.triggerRedstoneUpdate(0, 0, 0);
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
          // wall torches are held by the block behind them; everything else
          // (incl. floor torches) needs solid support directly below
          const facing = id === B.TORCH || id === B.SOUL_TORCH ? this.world.torchFacings.get(key) : undefined;
          let supported: boolean;
          if (facing !== undefined) {
            const wx = facing === 0 ? x - 1 : facing === 1 ? x + 1 : x;
            const wz = facing === 2 ? z - 1 : facing === 3 ? z + 1 : z;
            supported = this.world.isSolidAt(wx, y, wz);
          } else {
            const below = this.world.getBlock(x, y - 1, z);
            supported = (hasDef(below) && below !== B.AIR && def(below).solid) ||
              (SELF_STACKING.has(id) && below === id);
            // weeping vines hang from a ceiling (or from more vine)
            if (!supported && HANGING_PLANTS.has(id)) {
              const above = this.world.getBlock(x, y + 1, z);
              supported = above === id || this.world.isSolidAt(x, y + 1, z);
            }
          }
          if (!supported) {
            this.world.setBlock(x, y, z, B.AIR);
            if (facing !== undefined) this.world.torchFacings.delete(key);
            const d = def(id);
            if (d.drop !== null) {
              const drop = d.drop ?? { id, min: 1, max: 1 };
              this.entities.spawnDrop(x + 0.5, y + 0.3, z + 0.5, drop.id, drop.min);
            }
          }
        } else if (id === B.LANTERN || id === B.SOUL_LANTERN) {
          // a hanging lantern needs its ceiling, a standing one its floor
          const hang = this.world.bedFacings.get(key) === 1;
          if (!this.world.isSolidAt(x, hang ? y + 1 : y - 1, z)) {
            this.world.setBlock(x, y, z, B.AIR);
            this.entities.spawnDrop(x + 0.5, y + 0.3, z + 0.5, id, 1);
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
    // Water settles at ~5 Hz; lava uses the same rules but moves slower.
    if (++this.waterTickAcc >= 4) { this.waterTickAcc = 0; this.world.tickWater(); }
    if (++this.lavaTickAcc >= 12) { this.lavaTickAcc = 0; this.world.tickLava(); }
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
          if (plant === B.PUMPKIN_STEM || plant === B.MELON_STEM) {
            if (Math.random() < 0.12) this.growFruit(wx, hm, wz, plant === B.PUMPKIN_STEM ? B.PUMPKIN : B.MELON);
            continue;
          }
          // still water freezes over in snowy biomes
          if (hm > 0 && this.world.dimension === 'overworld' && this.world.getBlock(wx, hm - 1, wz) === B.WATER &&
            Math.random() < 0.05 && this.world.waterLevel(wx, hm - 1, wz) === 0) {
            const biome = this.world.generator.biomeAt(wx, wz);
            if (biome === 'snow' || biome === 'taiga') this.world.setBlock(wx, hm - 1, wz, B.ICE);
            continue;
          }
          if (plant === B.WHEAT_0 || plant === B.WHEAT_1 ||
            plant === B.CARROT_0 || plant === B.CARROT_1 ||
            plant === B.POTATO_0 || plant === B.POTATO_1 ||
            plant === B.BEETROOT_0 || plant === B.BEETROOT_1) {
            if (Math.random() < 0.2 && this.world.getBlock(wx, hm - 1, wz) === B.FARMLAND) {
              this.world.setBlock(wx, hm, wz, this.nextCropStage(plant));
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

  private nextCropStage(id: number): number {
    switch (id) {
      case B.WHEAT_0: return B.WHEAT_1;
      case B.WHEAT_1: return B.WHEAT_2;
      case B.CARROT_0: return B.CARROT_1;
      case B.CARROT_1: return B.CARROT_2;
      case B.POTATO_0: return B.POTATO_1;
      case B.POTATO_1: return B.POTATO_2;
      case B.BEETROOT_0: return B.BEETROOT_1;
      case B.BEETROOT_1: return B.BEETROOT_2;
      default: return id;
    }
  }

  /** Light ambient life: torch embers and night fireflies near the player. */
  private emitAmbientParticles(): void {
    const p = this.player.pos;
    // (Nether embers, spores, ash and wisps come from NetherFX)
    const pcx = Math.floor(p.x / CX), pcz = Math.floor(p.z / CZ);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const c = this.world.getChunk(pcx + dx, pcz + dz);
        if (!c || c.torches.size === 0 || Math.random() > 0.5) continue;
        const arr = [...c.torches];
        const idx = arr[(Math.random() * arr.length) | 0];
        const tx = c.cx * CX + (idx & 15);
        const tz = c.cz * CZ + ((idx >> 4) & 15);
        const ty = idx >> 8;
        if (Math.hypot(tx + 0.5 - p.x, tz + 0.5 - p.z) < 18) {
          this.entities.spawnTorchFlame(tx + 0.5, ty + 0.62, tz + 0.5);
        }
      }
    }
    if (Math.sin(this.dayTime * Math.PI * 2) < -0.12 && Math.random() < 0.4) {
      const fx = Math.floor(p.x + (Math.random() - 0.5) * 14);
      const fz = Math.floor(p.z + (Math.random() - 0.5) * 14);
      const c = this.world.getChunk(Math.floor(fx / CX), Math.floor(fz / CZ));
      if (c && c.ready) {
        const h = c.heightmap[(fz & 15) * 16 + (fx & 15)];
        if (this.world.getBlock(fx, h - 1, fz) === B.GRASS) {
          this.entities.spawnFirefly(fx + 0.5, h + 0.4 + Math.random() * 1.2, fz + 0.5);
        }
      }
    }
  }

  /** Bone meal: instantly mature a crop, grow a sapling into a tree, or
   *  scatter foliage on nearby grass. Returns true if anything changed. */
  private applyBoneMeal(x: number, y: number, z: number): boolean {
    const id = this.world.getBlock(x, y, z);
    const grown: Record<number, number> = {
      [B.WHEAT_0]: B.WHEAT_2, [B.WHEAT_1]: B.WHEAT_2,
      [B.CARROT_0]: B.CARROT_2, [B.CARROT_1]: B.CARROT_2,
      [B.POTATO_0]: B.POTATO_2, [B.POTATO_1]: B.POTATO_2,
      [B.BEETROOT_0]: B.BEETROOT_2, [B.BEETROOT_1]: B.BEETROOT_2,
    };
    if (id in grown) {
      this.world.setBlock(x, y, z, grown[id]);
      return true;
    }
    if (id === B.SAPLING) { this.growTree(x, y, z); return true; }
    if (id === B.PUMPKIN_STEM || id === B.MELON_STEM) {
      return this.growFruit(x, y, z, id === B.PUMPKIN_STEM ? B.PUMPKIN : B.MELON);
    }
    // on a grass block: sprout tall grass + the occasional flower nearby
    if (id === B.GRASS) {
      let placed = 0;
      for (let i = 0; i < 9; i++) {
        const gx = x + ((Math.random() * 5) | 0) - 2;
        const gz = z + ((Math.random() * 5) | 0) - 2;
        if (this.world.getBlock(gx, y, gz) !== B.GRASS) continue;
        if (this.world.getBlock(gx, y + 1, gz) !== B.AIR) continue;
        const r = Math.random();
        const plant = r < 0.66 ? B.TALL_GRASS : r < 0.76 ? B.POPPY : r < 0.84 ? B.DANDELION
          : r < 0.89 ? B.CORNFLOWER : r < 0.93 ? B.ALLIUM : r < 0.97 ? B.OXEYE_DAISY
            : r < 0.985 ? B.BROWN_MUSHROOM : B.RED_MUSHROOM;
        this.world.setBlock(gx, y + 1, gz, plant);
        placed++;
      }
      return placed > 0;
    }
    return false;
  }

  /** A ripe pumpkin/melon stem puts a fruit on a free neighbouring patch of
   *  earth (one fruit per stem at a time). Returns true if one grew. */
  private growFruit(x: number, y: number, z: number, fruit: number): boolean {
    const sides: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dz] of sides) if (this.world.getBlock(x + dx, y, z + dz) === fruit) return false;
    const [dx, dz] = sides[(Math.random() * 4) | 0];
    const ground = this.world.getBlock(x + dx, y - 1, z + dz);
    if (this.world.getBlock(x + dx, y, z + dz) !== B.AIR) return false;
    if (ground !== B.GRASS && ground !== B.DIRT && ground !== B.FARMLAND) return false;
    this.world.setBlock(x + dx, y, z + dz, fruit);
    this.audio.dig('wood', 0.6);
    return true;
  }

  /** Experience a slain mob leaves behind (vanilla: 5 for monsters, 1-3 animals). */
  private killXp(kind: string): number {
    if (kind === 'emberghast') return 10;
    if (kind === 'blaze') return 10;
    if (['zombie', 'skeleton', 'spider', 'creeper', 'cinderling', 'ashstalker', 'phantom',
      'piglin', 'zombified_piglin', 'hoglin', 'wither_skeleton', 'magma_cube'].includes(kind)) return 5;
    return 1 + Math.floor(Math.random() * 3);
  }

  /** A warp pearl landed: blink the player there (a small toll on survival). */
  private warpPlayer(x: number, y: number, z: number): void {
    if (this.player.dead) return;
    const p = this.player;
    // stand on top of whatever it hit, nudged out of solid cells
    let ty = Math.floor(y);
    for (let i = 0; i < 4 && (isSolid(this.world.getBlock(Math.floor(x), ty, Math.floor(z))) ||
      isSolid(this.world.getBlock(Math.floor(x), ty + 1, Math.floor(z)))); i++) ty++;
    if (p.isRiding()) p.dismount(false);
    this.entities.spawnPoof(p.pos.x, p.pos.y + 1, p.pos.z);
    p.pos = { x: Math.floor(x) + 0.5, y: ty + 0.01, z: Math.floor(z) + 0.5 };
    p.vel = { x: 0, y: 0, z: 0 };
    this.audio.play('whoosh');
    this.audio.play('emerge');
    if (p.mode === 'survival') p.damage(2, undefined, 'Fell victim to a warp pearl');
    this.adv.unlock('warp');
  }

  /** Outline extent of a shaped block (union of its boxes), or null for a cube. */
  private outlineBoxFor(x: number, y: number, z: number): number[] | null {
    const id = this.world.getBlock(x, y, z);
    if (!SHAPED.has(id)) return null;
    const key = `${x},${y},${z}`;
    const gate = id === B.FENCE_GATE ? this.world.doorStates.get(key) : undefined;
    let conn = 0;
    if (id === B.OAK_FENCE || id === B.GLASS_PANE) {
      if (connectsTo(id, this.world.getBlock(x, y, z - 1))) conn |= 1;
      if (connectsTo(id, this.world.getBlock(x, y, z + 1))) conn |= 2;
      if (connectsTo(id, this.world.getBlock(x - 1, y, z))) conn |= 4;
      if (connectsTo(id, this.world.getBlock(x + 1, y, z))) conn |= 8;
      if (id === B.GLASS_PANE && conn === 0) conn = this.world.bedFacings.get(key) === 1 ? 3 : 12;
    }
    const meta = gate ? gate.facing : this.world.bedFacings.get(key) ?? 0;
    const boxes = shapeBoxes(id, meta, conn, false, false);
    if (!boxes || boxes.length === 0) return null;
    const u = [1, 1, 1, 0, 0, 0];
    for (const b of boxes) for (let i = 0; i < 3; i++) { u[i] = Math.min(u[i], b[i]); u[i + 3] = Math.max(u[i + 3], b[i + 3]); }
    return u;
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
    // bias toward chunks the player is looking at, so moving forward fills in
    // ahead first (any meshing lag shows up behind you, not in your path)
    const fx = -Math.sin(this.player.yaw), fz = -Math.cos(this.player.yaw);
    const jobs: { key: string; d: number }[] = [];
    for (const key of this.world.dirtySet) {
      const [cx, cz] = key.split(',').map(Number);
      const dx = cx - pcx, dz = cz - pcz;
      const dist2 = dx * dx + dz * dz;
      const front = (dx * fx + dz * fz) / (Math.hypot(dx, dz) || 1); // -1..1
      jobs.push({ key, d: dist2 - front * 6 });
    }
    jobs.sort((a, b) => a.d - b.d);

    const worker = this.ensureMeshWorker();
    if (worker) {
      // off-thread: keep a few jobs in flight; the worker meshes without ever
      // blocking the render frame. Snapshots are posted with transferable buffers.
      const MAX_INFLIGHT = 4;
      for (const job of jobs) {
        if (this.meshInFlight.size >= MAX_INFLIGHT) break;
        if (this.meshInFlight.has(job.key)) continue;
        const [cx, cz] = job.key.split(',').map(Number);
        const chunk = this.world.getChunk(cx, cz);
        if (!chunk || !chunk.ready) { this.world.dirtySet.delete(job.key); continue; }
        if (!this.world.neighborsReady(cx, cz)) continue;
        const { job: msg, transfers } = this.buildMeshJob(cx, cz, ++this.meshJobId);
        worker.postMessage({ type: 'job', job: msg }, transfers);
        this.meshInFlight.add(job.key);
        this.world.dirtySet.delete(job.key); // re-added by markDirty if edited mid-flight
      }
      this.meshPerFrame = this.meshInFlight.size;
      return;
    }

    // synchronous fallback (no Worker support)
    const t0 = performance.now();
    let meshed = 0;
    for (const job of jobs) {
      if (performance.now() - t0 > budgetMs) break;
      const [cx, cz] = job.key.split(',').map(Number);
      const chunk = this.world.getChunk(cx, cz);
      if (!chunk || !chunk.ready) {
        this.world.dirtySet.delete(job.key);
        continue;
      }
      if (!this.world.neighborsReady(cx, cz)) continue; // wait for neighbors
      const m0 = performance.now();
      const arrays = buildChunkGeometry(this.world, chunk, this.atlas);
      this.meshMs = this.meshMs * 0.9 + (performance.now() - m0) * 0.1;
      this.renderer.setChunkGeometry(job.key, cx, cz, chunkGeometryFromArrays(arrays));
      chunk.dirty = false;
      this.world.dirtySet.delete(job.key);
      meshed++;
    }
    this.meshPerFrame = meshed;
  }

  /** Lazily spin up the mesh worker; returns null if Workers are unavailable. */
  private ensureMeshWorker(): Worker | null {
    if (this.meshWorkerTried) return this.meshWorker;
    this.meshWorkerTried = true;
    try {
      const w = new Worker(new URL('./engine/mesh-worker.ts', import.meta.url), { type: 'module' });
      w.postMessage({ type: 'init', rects: this.atlas.allRects() });
      w.onmessage = (e: MessageEvent) => this.onMeshDone(e.data);
      w.onerror = () => {
        // fall back to synchronous meshing; requeue anything in flight
        this.meshWorker = null;
        for (const k of this.meshInFlight) this.world.dirtySet.add(k);
        this.meshInFlight.clear();
      };
      this.meshWorker = w;
    } catch {
      this.meshWorker = null;
    }
    return this.meshWorker;
  }

  private onMeshDone(data: { key: string; cx: number; cz: number; ms: number; solid: GeoArrays | null; water: GeoArrays | null }): void {
    this.meshInFlight.delete(data.key);
    this.meshMs = this.meshMs * 0.9 + data.ms * 0.1;
    // edited mid-flight (re-dirtied) or unloaded -> discard this (now stale) result
    if (this.world.dirtySet.has(data.key)) return;
    const chunk = this.world.getChunk(data.cx, data.cz);
    if (!chunk || !chunk.ready) return;
    chunk.dirty = false;
    this.renderer.setChunkGeometry(data.key, data.cx, data.cz,
      chunkGeometryFromArrays({ solid: data.solid, water: data.water }));
  }

  /** Snapshot the 3x3 chunk region + the world state the mesher reads, with
   *  transferable buffers, for the worker to mesh off-thread. */
  private buildMeshJob(cx: number, cz: number, id: number): { job: MeshJob; transfers: Transferable[] } {
    const chunks: (MeshChunkSnap | null)[] = [];
    const transfers: Transferable[] = [];
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const c = this.world.getChunk(cx + dx, cz + dz);
        if (c && c.ready) {
          const data = c.data.slice();
          const heightmap = c.heightmap.slice();
          const torches = Uint32Array.from(c.torches);
          const glowers = Uint32Array.from(c.glowers);
          chunks.push({ cx: cx + dx, cz: cz + dz, data, heightmap, torches, glowers });
          transfers.push(data.buffer, heightmap.buffer, torches.buffer, glowers.buffer);
        } else {
          chunks.push(null);
        }
      }
    }
    const bx = cx * CX, bz = cz * CZ;
    const tint = this.world.columnTints(cx, cz); // cached per chunk (worker-computed)
    transfers.push(tint.buffer);
    // only the state entries within the center chunk (+1 block for door/liquid edges)
    const inRange = (k: string): boolean => {
      const ci = k.indexOf(','), cj = k.indexOf(',', ci + 1);
      const x = +k.slice(0, ci), z = +k.slice(cj + 1);
      return x >= bx - 1 && x <= bx + 16 && z >= bz - 1 && z <= bz + 16;
    };
    const filt = <T>(m: Map<string, T>): [string, T][] => {
      const o: [string, T][] = [];
      for (const e of m) if (inRange(e[0])) o.push(e);
      return o;
    };
    const job: MeshJob = {
      id, key: chunkKey(cx, cz), cx, cz, chunks, tint,
      torchFacings: filt(this.world.torchFacings),
      bedFacings: filt(this.world.bedFacings),
      doorStates: filt(this.world.doorStates) as [string, MeshDoor][],
      redstoneStates: filt(this.world.redstoneStates) as [string, MeshRedstone][],
      redstonePower: filt(this.world.redstonePower),
      waterLevels: filt(this.world.waterLevels),
      lavaLevels: filt(this.world.lavaLevels),
    };
    return { job, transfers };
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
      `Biome: ${this.world.generator.biomeLabel(Math.floor(p.x), Math.floor(p.z))}  Day: ${(this.dayTime * 100).toFixed(0)}%`,
      `Chunks: ${this.world.countLoaded()} loaded, ${this.world.dirtySet.size} dirty`,
      `Mesh: ${this.meshMs.toFixed(2)} ms/chunk (${this.meshPerFrame}/frame)  Gen: ${this.world.genMs.toFixed(1)} ms/chunk`,
      `Entities: ${c.mobs} mobs, ${c.drops} drops, ${c.other} fx`,
      `Mode: ${this.player.mode}${this.player.flying ? ' (flying)' : ''}${this.player.onGround ? ' on ground' : ''}`,
    ]);
  }

  triggerRedstoneUpdate(x: number, y: number, z: number): void {
    this.world.redstonePower.clear();
    const queue: [number, number, number, number][] = [];

    for (const [key, state] of this.world.redstoneStates) {
      if (state.active) {
        const [sx, sy, sz] = key.split(',').map(Number);
        const bid = this.world.getBlock(sx, sy, sz);
        if (bid === B.LEVER || bid === B.WOODEN_BUTTON || bid === B.STONE_BUTTON || bid === B.PRESSURE_PLATE) {
          queue.push([sx, sy, sz, 15]);
          this.world.redstonePower.set(key, 15);
        }
      }
    }

    while (queue.length > 0) {
      const [cx, cy, cz, power] = queue.shift()!;
      if (power <= 0) continue;

      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const nx = cx + dx, ny = cy + dy, nz = cz + dz;
        const nkey = `${nx},${ny},${nz}`;
        const nid = this.world.getBlock(nx, ny, nz);

        if (nid === B.REDSTONE_WIRE) {
          const newPower = power - 1;
          if (newPower > (this.world.redstonePower.get(nkey) ?? 0)) {
            this.world.redstonePower.set(nkey, newPower);
            queue.push([nx, ny, nz, newPower]);
          }
        }
      }

      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ux = cx + dx, uy = cy + 1, uz = cz + dz;
        const ukey = `${ux},${uy},${uz}`;
        if (this.world.getBlock(ux, uy, uz) === B.REDSTONE_WIRE) {
          const newPower = power - 1;
          if (newPower > (this.world.redstonePower.get(ukey) ?? 0)) {
            this.world.redstonePower.set(ukey, newPower);
            queue.push([ux, uy, uz, newPower]);
          }
        }

        const dxCoord = cx + dx, dyCoord = cy - 1, dzCoord = cz + dz;
        const dkey = `${dxCoord},${dyCoord},${dzCoord}`;
        if (this.world.getBlock(dxCoord, dyCoord, dzCoord) === B.REDSTONE_WIRE) {
          const newPower = power - 1;
          if (newPower > (this.world.redstonePower.get(dkey) ?? 0)) {
            this.world.redstonePower.set(dkey, newPower);
            queue.push([dxCoord, dyCoord, dzCoord, newPower]);
          }
        }
      }
    }

    const remeshChunks = new Set<string>();
    for (const key of this.world.redstoneBlocks) {
      const [rx, ry, rz] = key.split(',').map(Number);
      const rid = this.world.getBlock(rx, ry, rz);

      if (rid === B.REDSTONE_LAMP || rid === B.REDSTONE_LAMP_LIT) {
        const powered = this.isPowered(rx, ry, rz);
        const targetId = powered ? B.REDSTONE_LAMP_LIT : B.REDSTONE_LAMP;
        if (rid !== targetId) {
          this.world.setBlock(rx, ry, rz, targetId);
          remeshChunks.add(chunkKey(Math.floor(rx / 16), Math.floor(rz / 16)));
        }
      } else if (rid === B.PISTON || rid === B.STICKY_PISTON) {
        const powered = this.isPowered(rx, ry, rz);
        const extended = this.isPistonExtended(rx, ry, rz);
        if (powered && !extended) {
          this.extendPiston(rx, ry, rz);
        } else if (!powered && extended) {
          this.retractPiston(rx, ry, rz);
        }
      } else if (rid === B.DOOR_LOWER || rid === B.DOOR_UPPER || rid === B.TRAPDOOR) {
        // Power any block of the door: check the lower half and both halves so a
        // plate beside either the foot or head of the door still drives it.
        const ly = rid === B.DOOR_UPPER ? ry - 1 : ry;
        const lx = rx, lz = rz;
        const isTrap = rid === B.TRAPDOOR;
        const dkey = isTrap ? `${rx},${ry},${rz}` : `${lx},${ly},${lz}`;
        const st = this.world.doorStates.get(dkey);
        if (st) {
          const powered = isTrap
            ? this.isPowered(rx, ry, rz)
            : this.isPowered(lx, ly, lz) || this.isPowered(lx, ly + 1, lz);
          const wasPowered = !!st.poweredBy;
          // Only a genuine power transition moves the door, so a hand-opened door
          // isn't slammed by an unrelated redstone update elsewhere in the world.
          if (powered !== wasPowered) {
            st.poweredBy = powered;
            if (st.open !== powered) {
              st.open = powered;
              if (st.swing === undefined) st.swing = powered ? 0 : 1;
              this.world.doorStates.set(dkey, st);
              this.audio.play(powered ? 'doorOpen' : 'doorClose');
              this.world.markDirty(Math.floor(rx / 16), Math.floor(rz / 16));
              // double doors swing as a pair
              if (!isTrap) {
                const partner = this.world.doorPartner(lx, ly, lz, st);
                if (partner && partner.st.open !== st.open) {
                  partner.st.open = st.open;
                  partner.st.poweredBy = powered;
                  partner.st.swing = partner.st.swing ?? (powered ? 0 : 1);
                  this.world.doorStates.set(partner.key, partner.st);
                  this.world.markDirty(Math.floor(partner.x / 16), Math.floor(partner.z / 16));
                }
              }
            } else {
              this.world.doorStates.set(dkey, st);
            }
          }
        }
      } else if (rid === B.REDSTONE_WIRE) {
        this.world.markDirty(Math.floor(rx / 16), Math.floor(rz / 16));
      }
    }
  }

  isPowered(x: number, y: number, z: number): boolean {
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      const nkey = `${nx},${ny},${nz}`;
      const nid = this.world.getBlock(nx, ny, nz);
      if (nid === B.REDSTONE_WIRE) {
        const p = this.world.redstonePower.get(nkey) ?? 0;
        if (p > 0) return true;
      }
      if (nid === B.LEVER || nid === B.WOODEN_BUTTON || nid === B.STONE_BUTTON || nid === B.PRESSURE_PLATE) {
        const state = this.world.redstoneStates.get(nkey);
        if (state && state.active) return true;
      }
    }
    return false;
  }

  isPistonExtended(x: number, y: number, z: number): boolean {
    const facing = this.world.pistonFacings.get(`${x},${y},${z}`) ?? 2;
    const [dx, dy, dz] = this.getFacingVector(facing);
    return this.world.getBlock(x + dx, y + dy, z + dz) === B.PISTON_HEAD;
  }

  getFacingVector(facing: number): [number, number, number] {
    switch (facing) {
      case 0: return [0, -1, 0];
      case 1: return [0, 1, 0];
      case 2: return [0, 0, -1];
      case 3: return [0, 0, 1];
      case 4: return [-1, 0, 0];
      case 5: return [1, 0, 0];
      default: return [0, 0, 1];
    }
  }

  extendPiston(x: number, y: number, z: number): void {
    const facing = this.world.pistonFacings.get(`${x},${y},${z}`) ?? 2;
    const [dx, dy, dz] = this.getFacingVector(facing);

    const line: [number, number, number, number][] = [];
    let pushable = true;
    let limit = 13;
    let count = 0;
    for (let i = 1; i < limit; i++) {
      const bx = x + i * dx;
      const by = y + i * dy;
      const bz = z + i * dz;
      const id = this.world.getBlock(bx, by, bz);
      if (id === B.AIR || id === B.WATER || id === B.LAVA) {
        break;
      }
      if (id === B.BEDROCK || id === B.OBSIDIAN || id === B.PORTAL || id === B.FURNACE || id === B.FURNACE_LIT || id === B.CHEST || id === B.CHEST_LOOT) {
        pushable = false;
        break;
      }
      line.push([bx, by, bz, id]);
      count++;
    }

    if (!pushable || count >= 12) return;

    const pushPos = (px: number, py: number, pz: number) => {
      const p = this.player.pos;
      if (p.x + 0.3 > px && p.x - 0.3 < px + 1 &&
          p.y + 1.8 > py && p.y < py + 1 &&
          p.z + 0.3 > pz && p.z - 0.3 < pz + 1) {
        this.player.pos.x += dx;
        this.player.pos.y += dy;
        this.player.pos.z += dz;
      }
      for (const mob of this.entities.entities) {
        if (!this.entities.isMob(mob)) continue;
        const hw = mob.box.w / 2;
        if (mob.pos.x + hw > px && mob.pos.x - hw < px + 1 &&
            mob.pos.y + mob.box.h > py && mob.pos.y < py + 1 &&
            mob.pos.z + hw > pz && mob.pos.z - hw < pz + 1) {
          mob.pos.x += dx;
          mob.pos.y += dy;
          mob.pos.z += dz;
        }
      }
    };

    for (let i = line.length - 1; i >= 0; i--) {
      const [bx, by, bz, id] = line[i];
      pushPos(bx, by, bz);
      this.world.setBlock(bx + dx, by + dy, bz + dz, id);
    }

    const headX = x + dx, headY = y + dy, headZ = z + dz;
    pushPos(headX, headY, headZ);
    this.world.setBlock(headX, headY, headZ, B.PISTON_HEAD);
    this.world.pistonFacings.set(`${headX},${headY},${headZ}`, facing);
    this.audio.play('doorOpen');
  }

  retractPiston(x: number, y: number, z: number): void {
    const facing = this.world.pistonFacings.get(`${x},${y},${z}`) ?? 2;
    const [dx, dy, dz] = this.getFacingVector(facing);
    const headX = x + dx, headY = y + dy, headZ = z + dz;

    if (this.world.getBlock(headX, headY, headZ) === B.PISTON_HEAD) {
      this.world.setBlock(headX, headY, headZ, B.AIR);
      this.world.pistonFacings.delete(`${headX},${headY},${headZ}`);

      const baseId = this.world.getBlock(x, y, z);
      if (baseId === B.STICKY_PISTON) {
        const pullX = x + 2 * dx, pullY = y + 2 * dy, pullZ = z + 2 * dz;
        const pullId = this.world.getBlock(pullX, pullY, pullZ);
        if (pullId !== B.AIR && pullId !== B.BEDROCK && pullId !== B.OBSIDIAN && pullId !== B.PORTAL && pullId !== B.FURNACE && pullId !== B.FURNACE_LIT && pullId !== B.CHEST && pullId !== B.CHEST_LOOT) {
          const p = this.player.pos;
          if (p.x + 0.3 > pullX && p.x - 0.3 < pullX + 1 &&
              p.y + 1.8 > pullY && p.y < pullY + 1 &&
              p.z + 0.3 > pullZ && p.z - 0.3 < pullZ + 1) {
            this.player.pos.x -= dx;
            this.player.pos.y -= dy;
            this.player.pos.z -= dz;
          }
          this.world.setBlock(headX, headY, headZ, pullId);
          this.world.setBlock(pullX, pullY, pullZ, B.AIR);
        }
      }
      this.audio.play('doorClose');
    }
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.meshWorker?.terminate();
    this.meshWorker = null;
    this.world.dispose(); // stop the terrain-generation workers
    this.input.exitLock();
    this.input.dispose();
    this.touch?.el.remove();
    this.audio.setRain('off');
    this.entities.clear();
    this.xpOrbs.clear();
    this.throwables.clear();
    this.nether.dispose();
    this.xpBar.dispose();
    this.mapOverlay.dispose();
    this.weather.dispose();
    this.status.dispose();
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
    // resume audio on the first user gesture (mobile needs a touch to unlock the
    // AudioContext; the menu buttons help, but this guarantees it everywhere)
    const unlock = (): void => { this.audio.ensure(); };
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
    window.addEventListener('touchend', unlock, { capture: true });
    // resume audio when returning to the tab (mobile suspends it in the background)
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.audio.ensure(); });
    (window as unknown as { __audio: AudioEngine }).__audio = this.audio; // dev: title-screen music harnesses
    void this.showMenu();
  }

  async showMenu(): Promise<void> {
    this.game = null;
    this.audio.setMenuMusic(true);
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
        void this.atlas.loadResourcePack(files).then(async (n) => {
          if (n > 0) { this.hud.toast(`Resource pack applied (${n} textures)`); return; }
          // a world file slipped into the texture-pack picker? import it instead
          // of the unhelpful "no textures" dead-end (a common mix-up).
          const worldFile = files.find((f) => /\.(vcworld|json)$/i.test(f.name));
          if (worldFile) {
            try { importWorld(await worldFile.text()); await this.uploadWorld(worldFile); return; }
            catch { /* not actually a world file */ }
          }
          this.hud.toast('No textures found. To load a saved world, use “Import World”.');
        });
      },
      onExport: (slot) => void this.downloadWorld(slot),
      onImport: (file) => void this.uploadWorld(file),
    });
  }

  /** Download a saved world as a portable .json file. */
  private async downloadWorld(slot: string): Promise<void> {
    try {
      const state = await this.db.load(slot);
      if (!state) { this.hud.toast('World not found'); return; }
      const blob = exportWorld(slot, state);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${slot.replace(/[^a-z0-9 _-]+/gi, '_')}.vcworld.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.hud.toast(`Exported "${slot}"`);
    } catch (err) {
      console.error('export failed', err);
      this.hud.toast('Export failed');
    }
  }

  /** Load a world file (from this or another machine) into a new save slot. */
  private async uploadWorld(file: File): Promise<void> {
    try {
      const text = await file.text();
      const { slot, state } = importWorld(text);
      // avoid clobbering an existing world of the same name
      const existing = new Set((await this.db.list()).map((s) => s.slot));
      let name = slot;
      if (existing.has(name)) { let k = 2; while (existing.has(`${name} (${k})`)) k++; name = `${name} (${k})`; }
      state.lastPlayed = Date.now();
      await this.db.save(name, state);
      this.hud.toast(`Imported "${name}"`);
      await this.showMenu();
    } catch (err) {
      console.error('import failed', err);
      this.hud.toast('Import failed — not a valid world file');
    }
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
    this.audio.setMenuMusic(false);
    this.game = new Game(this, slot, save, fresh);
    void this.game;
  }
}

new App();
