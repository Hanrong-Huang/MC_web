// Entities: item drops (hover + magnetize + pickup), mobs (pig, chicken,
// sheep, cow, zombie, skeleton, spider, creeper) with hierarchical box limbs,
// sine-wave walk cycles and state-tree AI, plus arrows, primed TNT, falling
// sand/gravel, block-break particles, and the shared explosion routine.

import * as THREE from 'three';
import { World } from './World';
import { moveEntity, inWater, rayAABB, Vec3, MoveResult } from './Physics';
import { B, I, def, hasDef, allDefs, CROSS_BLOCKS, spriteNameFor, CAPTURABLE, mobLabel } from './Blocks';
import { Atlas, extrudeSpriteGeometry, shapedItemGeometry, BLOCK_SPRITE_ICONS } from './Textures';
import { AudioEngine } from './Audio';
import { SEA_LEVEL } from './WorldGenerator';
import type { Player } from './Player';
import { MobModels, LimbSet, MOB_EXPOSURE, MAGMA_SIZES, rollVariant } from './MobModels';
import { buildOrbRig, setOrbOpen, disposeOrb, orbGlowTexture, orbStarTexture, ORB_GLOW, ORB_IDLE_GLOW, OrbRig } from './CatcherOrb';

// capture-orb glow for the nether mobs (button, inner light, beams)
Object.assign(ORB_GLOW, {
  piglin: 0xf7cf45, zombified_piglin: 0x9ccf6a, hoglin: 0xe0906a,
  blaze: 0xffc030, wither_skeleton: 0x8a8a9a, magma_cube: 0xff6a18,
});

export type MobKind =
  | 'pig' | 'chicken' | 'sheep' | 'cow'
  | 'zombie' | 'skeleton' | 'spider' | 'creeper'
  | 'wolf' | 'villager' | 'phantom' | 'horse' | 'cat'
  | 'cinderling' | 'ashstalker' | 'emberghast'
  | 'rabbit' | 'bat'
  | 'piglin' | 'zombified_piglin' | 'hoglin' | 'strider' | 'blaze' | 'wither_skeleton' | 'magma_cube';
export type EntityKind = 'drop' | MobKind | 'arrow' | 'tnt' | 'falling' | 'particle' | 'bobber' | 'catcher' | 'orbfx';

const MOB_KINDS = new Set<EntityKind>([
  'pig', 'chicken', 'sheep', 'cow',
  'zombie', 'skeleton', 'spider', 'creeper',
  'wolf', 'villager', 'phantom', 'horse', 'cat',
  'cinderling', 'ashstalker', 'emberghast',
  'rabbit', 'bat',
  'piglin', 'zombified_piglin', 'hoglin', 'strider', 'blaze', 'wither_skeleton', 'magma_cube',
]);

/** Nether regions a spawn attempt can land in. */
type NetherRegion = 'wastes' | 'crimson' | 'warped' | 'soul' | 'basalt' | 'fortress';
/** Per-region spawn tables: [kind, weight, min pack, max pack] (vanilla-ish). */
const NETHER_TABLES: Record<NetherRegion, [MobKind, number, number, number][]> = {
  wastes: [['zombified_piglin', 40, 2, 4], ['cinderling', 16, 1, 2], ['piglin', 10, 1, 3],
    ['ashstalker', 8, 1, 1], ['magma_cube', 6, 1, 2], ['emberghast', 5, 1, 1]],
  crimson: [['hoglin', 30, 2, 4], ['piglin', 25, 2, 4], ['zombified_piglin', 6, 1, 2], ['cinderling', 5, 1, 1]],
  warped: [['cinderling', 5, 1, 1], ['ashstalker', 4, 1, 1], ['strider', 1, 1, 1]],
  soul: [['skeleton', 30, 2, 4], ['emberghast', 12, 1, 1], ['ashstalker', 6, 1, 2], ['wither_skeleton', 4, 1, 1]],
  basalt: [['magma_cube', 40, 1, 3], ['emberghast', 8, 1, 1], ['cinderling', 5, 1, 1]],
  fortress: [['blaze', 20, 1, 3], ['wither_skeleton', 16, 1, 3], ['zombified_piglin', 5, 1, 2],
    ['magma_cube', 4, 1, 1], ['skeleton', 3, 1, 1]],
};
const GOLD_ARMOR = new Set<number>([I.GOLD_HELMET, I.GOLD_CHEST, I.GOLD_LEGS, I.GOLD_BOOTS]);

let NAME_IDS: Map<string, number> | null = null;
/** Registry id by name, for blocks/items other modules add (crimson fungus,
 *  blackstone ...): the fallback (-1) when this build doesn't have it. */
function idByName(name: string, fallback = -1): number {
  if (!NAME_IDS) {
    NAME_IDS = new Map();
    for (const d of allDefs()) NAME_IDS.set(d.name, d.id);
  }
  return NAME_IDS.get(name) ?? fallback;
}
/** First registered id among the names (or -1). */
function firstId(...names: string[]): number {
  for (const n of names) { const id = idByName(n); if (id >= 0) return id; }
  return -1;
}
let BRICK_IDS: Set<number> | null = null;
/** Every nether-brick flavoured block: fortresses are built from them. */
function brickIds(): Set<number> {
  if (!BRICK_IDS) {
    BRICK_IDS = new Set([B.NETHER_BRICKS]);
    for (const d of allDefs()) if (d.block && d.name.includes('nether_brick')) BRICK_IDS.add(d.id);
  }
  return BRICK_IDS;
}
/** Nether region implied by the block a mob would stand on. */
function regionOfBlock(name: string): NetherRegion {
  if (name.startsWith('crimson') || name === 'nether_wart_block') return 'crimson';
  if (name.startsWith('warped')) return 'warped';
  if (name === 'soul_sand' || name === 'soul_soil') return 'soul';
  if (name.includes('basalt') || name.includes('blackstone') || name === 'magma') return 'basalt';
  return 'wastes';
}
/** Nether region from a biome label (the generator's netherBiomeAt, when present). */
function regionOfBiome(label: string): NetherRegion {
  const l = label.toLowerCase();
  if (l.includes('crimson')) return 'crimson';
  if (l.includes('warped')) return 'warped';
  if (l.includes('soul')) return 'soul';
  if (l.includes('basalt') || l.includes('delta')) return 'basalt';
  return 'wastes';
}
const JUMP_V = Math.sqrt(2 * 32 * 1.25); // same 1.25-block hop as the player
const GRAVITY = 32;

/** Foods that put each animal into "love mode". Wolf/cat/horse must be tamed. */
const BREED_FOOD: Partial<Record<MobKind, number[]>> = {
  pig: [I.WHEAT, I.CARROT, I.POTATO, I.BEETROOT],
  cow: [I.WHEAT],
  sheep: [I.WHEAT],
  chicken: [I.SEEDS, I.BEETROOT_SEEDS],
  horse: [I.GOLDEN_CARROT, I.APPLE],
  wolf: [I.BEEF, I.COOKED_BEEF, I.PORKCHOP, I.COOKED_PORKCHOP, I.CHICKEN, I.COOKED_CHICKEN, I.MUTTON, I.COOKED_MUTTON],
  cat: [I.RAW_FISH, I.COOKED_FISH],
  rabbit: [I.CARROT, I.GOLDEN_CARROT, B.DANDELION],
};
const BREED_NEEDS_TAME = new Set<MobKind>(['wolf', 'cat', 'horse']);

/** Held items that lure an animal into facing + walking toward the player
 *  ("follow the food"). Bone tempts an untamed dog; fish a cat; wheat cows &
 *  pigs; seeds chickens. Used for the approach behaviour, not consumption. */
const LURE_FOOD: Partial<Record<MobKind, number[]>> = {
  wolf: [I.BONE],
  cat: [I.RAW_FISH, I.COOKED_FISH],
  cow: [I.WHEAT],
  sheep: [I.WHEAT],
  pig: [I.WHEAT, I.CARROT, I.POTATO, I.BEETROOT],
  chicken: [I.SEEDS, I.BEETROOT_SEEDS],
  horse: [I.GOLDEN_CARROT, I.APPLE],
  rabbit: [I.CARROT, I.GOLDEN_CARROT, B.DANDELION],
};
/** Animals that drift back toward their own kind when picking a wander heading. */
const HERD_KINDS = new Set<MobKind>(['cow', 'sheep', 'pig', 'chicken', 'horse']);
/** How long the death topple plays before the smoke poof. */
const DEATH_TIME = 0.9;

interface MobStats {
  box: { w: number; h: number };
  hp: number;
  speed: number;
  hostile: boolean;
}

const MOB_STATS: Record<MobKind, MobStats> = {
  pig: { box: { w: 0.9, h: 0.9 }, hp: 10, speed: 1.2, hostile: false },
  chicken: { box: { w: 0.4, h: 0.72 }, hp: 4, speed: 1.1, hostile: false },
  sheep: { box: { w: 0.9, h: 1.15 }, hp: 8, speed: 1.1, hostile: false },
  cow: { box: { w: 0.9, h: 1.3 }, hp: 10, speed: 1.0, hostile: false },
  zombie: { box: { w: 0.6, h: 1.95 }, hp: 20, speed: 2.2, hostile: true },
  skeleton: { box: { w: 0.6, h: 1.95 }, hp: 20, speed: 2.4, hostile: true },
  spider: { box: { w: 1.1, h: 0.72 }, hp: 16, speed: 2.8, hostile: true },
  creeper: { box: { w: 0.6, h: 1.62 }, hp: 20, speed: 1.9, hostile: true },
  wolf: { box: { w: 0.8, h: 0.85 }, hp: 8, speed: 1.6, hostile: false },
  villager: { box: { w: 0.6, h: 1.95 }, hp: 20, speed: 0.9, hostile: false },
  phantom: { box: { w: 0.9, h: 0.5 }, hp: 12, speed: 2.4, hostile: true },
  horse: { box: { w: 1.0, h: 1.6 }, hp: 22, speed: 2.1, hostile: false },
  cat: { box: { w: 0.5, h: 0.6 }, hp: 8, speed: 1.7, hostile: false },
  // nether: a small fast ember imp, a heavier charred beast, and a floating
  // fireball-spitting ghast
  cinderling: { box: { w: 0.5, h: 0.85 }, hp: 8, speed: 2.7, hostile: true },
  ashstalker: { box: { w: 0.8, h: 0.9 }, hp: 16, speed: 3.0, hostile: true },
  emberghast: { box: { w: 1.0, h: 1.0 }, hp: 10, speed: 1.8, hostile: true },
  // ambient critters: a skittish hopping rabbit and a cave bat
  rabbit: { box: { w: 0.4, h: 0.5 }, hp: 3, speed: 2.3, hostile: false },
  bat: { box: { w: 0.5, h: 0.5 }, hp: 6, speed: 2.4, hostile: false },
  // nether denizens (vanilla sizes; magma cubes scale with their size variant)
  piglin: { box: { w: 0.6, h: 1.95 }, hp: 16, speed: 2.3, hostile: true },
  zombified_piglin: { box: { w: 0.6, h: 1.95 }, hp: 20, speed: 1.9, hostile: true },
  hoglin: { box: { w: 1.3, h: 1.4 }, hp: 40, speed: 2.1, hostile: true },
  strider: { box: { w: 0.9, h: 1.7 }, hp: 20, speed: 1.4, hostile: false },
  blaze: { box: { w: 0.6, h: 1.8 }, hp: 20, speed: 2.0, hostile: true },
  wither_skeleton: { box: { w: 0.7, h: 2.4 }, hp: 20, speed: 2.5, hostile: true },
  magma_cube: { box: { w: 1.04, h: 1.04 }, hp: 4, speed: 2.2, hostile: true },
};
/** Melee mobs that deal contact damage while chasing. */
const MELEE_MOBS = new Set<MobKind>(['zombie', 'spider', 'cinderling', 'ashstalker',
  'piglin', 'zombified_piglin', 'hoglin', 'wither_skeleton', 'magma_cube']);
/** Contact hit [damage, reach, cooldown] per melee mob (zombie-ish default). */
const MELEE: Partial<Record<MobKind, [number, number, number]>> = {
  spider: [2, 1.4, 1], cinderling: [2, 1.1, 0.7], ashstalker: [4, 1.3, 1],
  piglin: [5, 1.3, 1], zombified_piglin: [5, 1.3, 1], hoglin: [6, 1.7, 1.3],
  wither_skeleton: [5, 1.5, 1],
};

/** Hitbox + health for a mob of this kind/variant (magma cubes by size). */
function mobBody(kind: MobKind, variant: number): { box: { w: number; h: number }; hp: number } {
  const st = MOB_STATS[kind];
  if (kind === 'magma_cube') {
    const s = MAGMA_SIZES[variant] ?? 1;
    return { box: { w: 0.52 * s, h: 0.52 * s }, hp: s * s };
  }
  return { box: { ...st.box }, hp: st.hp };
}

export class Entity {
  kind: EntityKind;
  pos: Vec3;
  vel: Vec3 = { x: 0, y: 0, z: 0 };
  yaw = 0;
  box: { w: number; h: number };
  mesh: THREE.Group;
  hp = 1;
  age = 0;
  onGround = false;
  dead = false;
  // drop / falling fields
  itemId = 0;
  count = 0;
  /** captured-mob kind for dropped filled catchers (mirrors SlotData.mob) */
  mob?: string;
  /** enchantments carried by a dropped item (mirrors SlotData.ench) */
  ench?: Record<string, number>;
  // mob fields
  state: 'idle' | 'wander' | 'flee' | 'chase' | 'fuse' = 'idle';
  stateTime = 0;
  moveSpeed = 0;
  walkCycle = 0;
  limbs: LimbSet | null = null;
  hurtFlash = 0;
  attackCooldown = 0;
  angryT = 0;        // spiders stay aggressive a while after being hit
  fuseT = 0;         // creeper / tnt
  shootCooldown = 0; // skeleton
  materials: THREE.MeshLambertMaterial[] = [];
  // arrow fields ('pet'/'petghast' = fired by a captured pet: hurts hostiles,
  // never the owner or another pet)
  owner: 'player' | 'skeleton' | 'emberghast' | 'pet' | 'petghast' = 'player';
  dmg = 0;
  /** arrow embedded in a block: seconds since it struck (-1 = in flight) */
  stuckT = -1;
  // particle fields
  life = 0;
  maxLife = 0;
  pGrav = 18;
  // wolf / cat / horse taming fields
  tamed = false;
  ownerName: string | null = null;
  sitting = false;
  /** coat/breed variant index (horse, cat) */
  variant = 0;
  // horse riding fields
  ridden = false;
  /** seconds left in a buck-off (untamed mount attempt); >0 = bucking */
  bucking = 0;
  /** restCooldown before the player can be bucked again, etc. */
  restT = 0;
  saddled = false;
  /** 0 = none, 1 = iron barding */
  armorTier = 0;
  // breeding fields
  /** seconds left in "love mode" (looking for a mate) */
  loveT = 0;
  /** cooldown before this animal can breed again */
  breedCooldown = 0;
  /** baby animals are scaled down and grow up after growT seconds */
  baby = false;
  growT = 0;
  // villager fields
  trades: { give: number; giveCount: number; get: number; getCount: number; uses: number; max: number }[] = [];
  // phantom fields
  circling = 0;
  // bobber (fishing) fields
  hooked: Entity | null = null;
  inWaterT = 0;
  biteT = 0;
  // captured-pet fields
  /** the enemy a pet is currently focused on (null = follow owner) */
  target: Entity | null = null;
  /** a wild hostile's non-player quarry (a pet it is trading blows with) */
  foe: Entity | null = null;
  /** seconds until the next auto-regen tick (pets heal slowly) */
  regenT = 0;
  /** scratch steering output from petChase (consumed by the caller) */
  _wishX = 0;
  _wishZ = 0;
  // animation state (render-only)
  /** eased body yaw the mesh actually shows (AI yaw changes snap; this turns) */
  visYaw = 0;
  /** eased 0..1 stride amplitude (so legs settle instead of freezing mid-step) */
  limbAmt = 0;
  /** idle glance: seconds until the next look-around, and its target */
  lookT = 0;
  lookYaw = 0;
  lookPitch = 0;
  /** true while this mob is taking an interest in the player */
  watching = false;
  /** seconds until the next blink (negative = eyes shut) */
  blinkT = 3;
  /** sheep: seconds left in a grass-munching bout */
  grazeT = 0;
  /** sheep: fleece shorn off (regrows by grazing) */
  sheared = false;
  /** seconds left on fire (undead in daylight) */
  burnT = 0;
  /** direction of the last knockback, for the hurt tilt */
  kbX = 0;
  kbZ = 0;
  /** ticks toward the next point of fire damage */
  burnTick = 0;
  /** contact shadow (stays on the ground under a jumping/falling mob) */
  shadow: THREE.Mesh | null = null;
  /** mesh handed to the death-topple animation; don't dispose on removal */
  corpse = false;
  /** thrown-catcher / capture-effect state ('catcher' and 'orbfx' kinds) */
  orb: OrbState | null = null;
  // nether mob fields
  /** piglin: seconds left admiring a gold ingot before bartering it */
  admireT = 0;
  /** piglin: a dropped gold ingot it is heading for */
  lure: Entity | null = null;
  /** seconds left in a weapon swing / head toss (render + hit timing) */
  swingT = 0;
  /** blaze: seconds left charging a volley; magma cube: landing squash */
  chargeT = 0;
  /** blaze: fireballs left in the current volley */
  burst = 0;
  /** strider: off the lava (purple, shivering, slow) */
  cold = false;
  /** piglin out of the Nether: seconds shaking before it zombifies */
  convertT = 0;

  constructor(kind: EntityKind, pos: Vec3, box: { w: number; h: number }, mesh: THREE.Group) {
    this.kind = kind;
    this.pos = pos;
    this.box = box;
    this.mesh = mesh;
  }
}

export class EntityManager {
  entities: Entity[] = [];
  private scene: THREE.Scene;
  private world: World;
  private atlas: Atlas;
  private audio: AudioEngine;
  private player: Player | null = null;
  /** fired when any mob dies (mobKind string) */
  onKill: ((mobKind: string) => void) | null = null;
  /** HUD toast hook (thrown-catcher feedback happens outside the input path) */
  onToast: ((msg: string) => void) | null = null;
  /** fired when a mob is captured into a catcher (mobKind string) */
  onCapture: ((mobKind: string) => void) | null = null;
  /** fired when the player damages a mob (hit marker + damage number feedback) */
  onPlayerHit: ((pos: Vec3, dmg: number, crit: boolean, killed: boolean) => void) | null = null;
  private models = new MobModels();
  /** dying mobs' meshes playing the topple-over before their poof */
  private corpses: { mesh: THREE.Group; mats: THREE.MeshLambertMaterial[]; t: number; w: number; x: number; y: number; z: number }[] = [];
  private shadowTex: THREE.CanvasTexture | null = null;
  private particleMats = new Map<string, THREE.MeshBasicMaterial>();
  private arrowSprite: HTMLCanvasElement | null = null;
  private spawnTick = 0;
  mobsEnabled = true;
  /** seconds of wither left on the player (wither skeleton hits) */
  witherT = 0;
  private witherTick = 0;

  constructor(scene: THREE.Scene, world: World, atlas: Atlas, audio: AudioEngine) {
    this.scene = scene;
    this.world = world;
    this.atlas = atlas;
    this.audio = audio;
  }

  setPlayer(p: Player): void { this.player = p; }

  isMob(e: Entity): boolean { return MOB_KINDS.has(e.kind); }

  // --- spawning ---------------------------------------------------------------

  spawnDrop(x: number, y: number, z: number, itemId: number, count: number, dur?: number, mob?: string, ench?: Record<string, number>): Entity {
    const mesh = this.buildDropMesh(itemId, mob);
    const e = new Entity('drop', { x, y, z }, { w: 0.25, h: 0.25 }, mesh);
    e.itemId = itemId;
    e.count = count;
    if (dur !== undefined) e.dmg = dur; // reuse field for tool durability passthrough
    if (mob !== undefined) e.mob = mob;
    if (ench) e.ench = ench;
    e.vel = { x: (Math.random() - 0.5) * 2.4, y: 3.2, z: (Math.random() - 0.5) * 2.4 };
    this.entities.push(e);
    this.scene.add(mesh);
    return e;
  }

  /** Spawn a mob. `variant` picks a coat/outfit (random when omitted). */
  spawnMob(kind: MobKind, x: number, y: number, z: number, variant = rollVariant(kind)): Entity {
    const { mesh, limbs, mats } = this.models.build(kind, variant);
    // yaw first, then local pitch/roll: knockback tilt + the death topple ride
    // on the mob's own axes
    mesh.rotation.order = 'YXZ';
    const stats = MOB_STATS[kind];
    const body = mobBody(kind, variant);
    const e = new Entity(kind, { x, y, z }, body.box, mesh);
    e.limbs = limbs;
    e.hp = body.hp;
    e.moveSpeed = stats.speed;
    e.materials = mats;
    e.variant = variant;
    e.yaw = Math.random() * Math.PI * 2;
    e.visYaw = e.yaw;
    e.blinkT = 1 + Math.random() * 4;
    e.lookT = Math.random() * 3;
    mesh.position.set(x, y, z);
    mesh.rotation.y = e.yaw;
    // soft contact shadow under grounded mobs (flyers get none)
    if (kind !== 'phantom' && kind !== 'emberghast' && kind !== 'bat') {
      e.shadow = this.makeShadow(Math.min(1.6, body.box.w));
      mesh.add(e.shadow);
    }
    this.entities.push(e);
    this.scene.add(mesh);
    return e;
  }

  /** Is this entity a captured pet belonging to the player? (Excludes tamed
   *  wolves/cats/horses, which have their own mechanics.) */
  isPet(e: Entity): boolean {
    return this.isMob(e) && e.tamed && e.ownerName === 'player'
      && e.kind !== 'wolf' && e.kind !== 'cat' && e.kind !== 'horse';
  }

  /** Save shape for the player's pets (wild mobs are not persisted). */
  savePets(): { kind: string; x: number; y: number; z: number; hp: number; sitting: boolean }[] {
    const out: { kind: string; x: number; y: number; z: number; hp: number; sitting: boolean }[] = [];
    for (const e of this.entities) {
      if (!this.isPet(e) || e.dead) continue;
      out.push({
        kind: e.kind as string, x: e.pos.x, y: e.pos.y, z: e.pos.z,
        hp: e.hp, sitting: e.sitting,
      });
    }
    return out;
  }

  /** Re-create pets from a save. Unknown kinds are skipped. */
  loadPets(pets: { kind: string; x: number; y: number; z: number; hp: number; sitting: boolean }[]): void {
    for (const s of pets) {
      if (!MOB_KINDS.has(s.kind as MobKind)) continue;
      const e = this.spawnMob(s.kind as MobKind, s.x, s.y, s.z);
      e.tamed = true;
      e.ownerName = 'player';
      e.sitting = s.sitting;
      e.hp = Math.max(1, Math.min(MOB_STATS[s.kind as MobKind].hp, s.hp));
      e.target = null;
    }
  }

  /** Live roster of the player's captured pets, for the HUD strip. */
  petStatus(): { kind: string; hp: number; maxHp: number; sitting: boolean; fighting: boolean }[] {
    const out: { kind: string; hp: number; maxHp: number; sitting: boolean; fighting: boolean }[] = [];
    for (const e of this.entities) {
      if (!this.isPet(e) || e.dead) continue;
      out.push({
        kind: e.kind as string,
        hp: Math.max(0, e.hp),
        maxHp: MOB_STATS[e.kind as MobKind].hp,
        sitting: e.sitting,
        fighting: !!(e.target && !e.target.dead),
      });
    }
    return out;
  }

  /** Capture a wild capturable mob into a catcher. Returns the mob kind, or
   *  null if this mob can't be captured. Marks the mob dead without loot.
   *  `fx` false leaves the mesh + effects to the caller (the thrown orb draws
   *  the mob in itself). */
  captureMob(e: Entity, fx = true): string | null {
    if (!this.isMob(e) || e.dead) return null;
    if (!CAPTURABLE.has(e.kind)) return null;
    const kind = e.kind;
    e.dead = true;                 // removed by the update loop; skips loot/poof
    e.target = null;
    this.clearFoe(e);
    if (fx) {
      const cy = e.pos.y + e.box.h * 0.5;
      this.orbBurst(e.pos.x, cy, e.pos.z, ORB_GLOW[kind as string] ?? ORB_IDLE_GLOW, 14);
      this.audio.play('orbClick', this.orbVol(e.pos.x, cy, e.pos.z));
    }
    this.onCapture?.(kind as string);
    return kind;
  }

  /** Recall an owned pet back into a catcher. Returns its kind (or null). The
   *  pet dissolves into a beam that streams back to the player's hand. */
  recallPet(e: Entity): string | null {
    if (!this.isPet(e) || e.dead) return null;
    const kind = e.kind;
    e.dead = true;
    e.target = null;
    this.clearFoe(e);
    this.startRecallFx(e);
    this.audio.play('orbRecall', this.orbVol(e.pos.x, e.pos.y, e.pos.z));
    return kind;
  }

  /** Drop any references to a removed entity so nothing chases a ghost. */
  private clearFoe(gone: Entity): void {
    for (const o of this.entities) {
      if (o.foe === gone) o.foe = null;
      if (o.target === gone) o.target = null;
    }
  }

  /** Release a captured mob as a pet at the given spot. Returns the new entity
   *  (live at once); an orb tossed from the hand pops open there in a flash and
   *  the pet grows out of it. */
  releaseMob(kind: MobKind, x: number, y: number, z: number, yaw: number): Entity {
    const e = this.spawnMob(kind, x, y, z);
    e.tamed = true;
    e.ownerName = 'player';
    e.sitting = false;
    e.target = null;
    e.hp = MOB_STATS[kind].hp;     // release at full health
    e.yaw = yaw;
    e.visYaw = yaw;
    this.startReleaseFx(e);
    return e;
  }

  // --- thrown capture orb -------------------------------------------------------
  //
  // A throw winds up for CATCHER_WINDUP s (matching the held orb's wind-up),
  // then flies spinning with a sparkle trail. On a capturable mob the orb pops
  // open, a beam draws the shrinking mob inside, the dome snaps shut, and the
  // orb drops to the ground, wobbles 1-3 times and clicks shut in a burst of
  // stars — then lies there as a filled-catcher pickup. The mob is captured
  // (dead, onCapture fired) the moment the orb touches it.

  /** How far off-centre a thrown orb may pass a mob and still catch it. Generous
   *  on purpose: the orb arcs, so a strict hitbox made every throw a coin flip. */
  private static readonly CATCH_SLACK = 0.85;
  /** seconds between the throw input and the orb leaving the hand */
  static readonly CATCHER_WINDUP = 0.12;
  private static readonly ORB_R = 0.16;
  private static readonly ABSORB_TIME = 0.78;
  private static readonly WOBBLE_TIME = 0.64;

  /** Throw a capture orb along a direction. Captures the first capturable mob it
   *  brushes past, recalls an owned pet, and drops back as a pickup on a miss. */
  throwCatcher(x: number, y: number, z: number, dx: number, dy: number, dz: number): Entity {
    const { wrap, rig, pivot } = this.buildThrownOrb();
    const e = new Entity('catcher', { x, y, z }, { w: 0.3, h: 0.3 }, wrap);
    const len = Math.hypot(dx, dy, dz) || 1;
    const speed = 17;
    e.vel = { x: (dx / len) * speed, y: (dy / len) * speed + 1.2, z: (dz / len) * speed };
    e.orb = { phase: 'windup', t: 0, rig, pivot, wobbles: 0 };
    wrap.visible = false;
    wrap.position.set(x, y, z);
    this.entities.push(e);
    this.scene.add(wrap);
    this.audio.play('orbThrow');
    return e;
  }

  /** The thrown orb: wrapper at the orb's centre -> pivot at its ground contact
   *  (so wobbles rock on the floor) -> the orb rig. */
  private buildThrownOrb(): { wrap: THREE.Group; rig: OrbRig; pivot: THREE.Group } {
    const R = EntityManager.ORB_R;
    const wrap = new THREE.Group();
    const pivot = new THREE.Group();
    pivot.position.y = -R;
    wrap.add(pivot);
    const rig = buildOrbRig(R);
    rig.root.position.y = R;
    pivot.add(rig.root);
    return { wrap, rig, pivot };
  }

  /** The mob a flying orb should act on, or null. Capturable mobs and owned pets
   *  win over animals standing in the way, so a stray cow can't body-block. */
  private catcherTarget(e: Entity): Entity | null {
    const slack = EntityManager.CATCH_SLACK;
    let best: Entity | null = null, bestD = Infinity, bestOk = false;
    for (const m of this.entities) {
      if (!this.isMob(m) || m.dead) continue;
      const hw = m.box.w / 2 + slack;
      const dx = e.pos.x - m.pos.x, dz = e.pos.z - m.pos.z;
      if (Math.hypot(dx, dz) > hw) continue;
      if (e.pos.y < m.pos.y - slack || e.pos.y > m.pos.y + m.box.h + slack) continue;
      const ok = this.isPet(m) || CAPTURABLE.has(m.kind);
      const d = Math.hypot(dx, e.pos.y - (m.pos.y + m.box.h * 0.5), dz);
      // prefer a valid catch; among equals, the closest
      if ((ok && !bestOk) || ((ok === bestOk) && d < bestD)) { best = m; bestD = d; bestOk = ok; }
    }
    return best;
  }

  private updateCatcher(e: Entity, dt: number): void {
    const o = e.orb;
    if (!o) { e.dead = true; return; }
    o.t += dt;
    switch (o.phase) {
      case 'windup':
        // the held orb is still being cocked back: the thrown one isn't out yet
        if (o.t >= EntityManager.CATCHER_WINDUP) { o.phase = 'fly'; o.t = 0; e.mesh.visible = true; }
        return;
      case 'fly': this.flyCatcher(e, o, dt); return;
      case 'absorb': this.absorbCatcher(e, o, dt); return;
      case 'fall': this.fallCatcher(e, o, dt); return;
      case 'wobble': this.wobbleCatcher(e, o); return;
      default: this.killOrbEntity(e);
    }
  }

  /** In flight: arc under gravity, test mobs + blocks along the path, spin and
   *  shed a two-tone sparkle trail. */
  private flyCatcher(e: Entity, o: OrbState, dt: number): void {
    const speed = Math.hypot(e.vel.x, e.vel.y, e.vel.z);
    const steps = Math.max(1, Math.ceil(speed * dt / 0.25));
    const sdt = dt / steps;
    for (let s = 0; s < steps; s++) {
      e.vel.y -= 13 * sdt;
      const px = e.pos.x, py = e.pos.y, pz = e.pos.z;
      e.pos.x += e.vel.x * sdt;
      e.pos.y += e.vel.y * sdt;
      e.pos.z += e.vel.z * sdt;
      const mob = this.catcherTarget(e);
      if (mob) { this.resolveCatcherHit(e, mob); return; }
      const id = this.world.getBlock(Math.floor(e.pos.x), Math.floor(e.pos.y), Math.floor(e.pos.z));
      if (id !== B.AIR && id !== B.WATER && id !== B.TORCH && def(id).solid) {
        // clanged off the terrain: the orb survives and lands as a pickup
        this.audio.play('orbWobble', this.orbVol(px, py, pz) * 0.8);
        this.orbBurst(px, py, pz, ORB_IDLE_GLOW, 5);
        this.spawnDrop(px, py, pz, I.MOB_CATCHER, 1);
        this.killOrbEntity(e);
        return;
      }
    }
    // spin along the flight path + a sparkle trail so the arc is easy to read
    e.mesh.position.set(e.pos.x, e.pos.y, e.pos.z);
    if (o.rig) {
      o.rig.spin.rotation.y += dt * 14;
      o.rig.root.rotation.x += dt * 9;
    }
    o.trail = (o.trail ?? 0) + dt;
    while (o.trail > 0.018) {
      o.trail -= 0.018;
      const white = Math.random() < 0.4;
      this.spawnOrbSpark(
        e.pos.x + (Math.random() - 0.5) * 0.12, e.pos.y + (Math.random() - 0.5) * 0.12, e.pos.z + (Math.random() - 0.5) * 0.12, {
          vel: { x: (Math.random() - 0.5) * 0.5, y: (Math.random() - 0.3) * 0.5, z: (Math.random() - 0.5) * 0.5 },
          life: 0.3 + Math.random() * 0.25, size: white ? 0.14 : 0.2,
          color: white ? 0xffffff : 0xb98cff, star: white,
        });
    }
    if (e.age > 8 || e.pos.y < -8) {
      if (e.pos.y > -8) this.spawnDrop(e.pos.x, e.pos.y, e.pos.z, I.MOB_CATCHER, 1);
      this.killOrbEntity(e);
    }
  }

  /** A thrown orb reached a mob: recall a pet, capture a hostile, or bounce off
   *  a peaceful animal (which keeps the orb, dropped at its feet). */
  private resolveCatcherHit(e: Entity, m: Entity): void {
    const p = this.player;
    const o = e.orb!;
    if (this.isPet(m)) {
      // your own pet: it streams back to your hand along a beam
      const kind = this.recallPet(m);
      this.orbBurst(e.pos.x, e.pos.y, e.pos.z, ORB_IDLE_GLOW, 8);
      this.killOrbEntity(e);
      if (kind && p) {
        p.giveFilledCatcher(kind);
        p.inventory.onChange();
        this.onToast?.(`Recalled ${mobLabel(kind)}`);
      }
      return;
    }
    // the victim's mesh outlives it: the orb draws it in (see absorbCatcher)
    const mesh = m.mesh, mats = m.materials;
    const kind = this.captureMob(m, false);
    if (kind) {
      m.corpse = true;             // keep the mesh; the orb owns it now
      if (m.shadow) m.shadow.visible = false;
      o.phase = 'absorb';
      o.t = 0;
      o.mob = kind as string;
      o.victim = mesh;
      o.victimMats = mats;
      o.vFrom = { x: m.pos.x, y: m.pos.y, z: m.pos.z };
      o.vH = m.box.h;
      o.hover = { x: e.pos.x, y: e.pos.y, z: e.pos.z };
      // bounce back off the mob a little and hang there while it opens
      const hl = Math.hypot(e.vel.x, e.vel.z) || 1;
      o.back = { x: -e.vel.x / hl, y: 0, z: -e.vel.z / hl };
      e.vel = { x: 0, y: 0, z: 0 };
      // face the open dome at the mob
      if (o.rig) {
        o.rig.root.rotation.set(0, Math.atan2(m.pos.x - e.pos.x, m.pos.z - e.pos.z), 0);
        o.rig.spin.rotation.set(0, 0, 0);
      }
      e.mesh.add(mesh);            // reparent: offsets are set each frame
      this.audio.play('orbOpen', this.orbVol(e.pos.x, e.pos.y, e.pos.z));
      return;
    }
    // peaceful mob: bounces off, orb recoverable on the ground
    this.audio.play('fail');
    this.orbBurst(e.pos.x, e.pos.y, e.pos.z, ORB_IDLE_GLOW, 5);
    this.spawnDrop(m.pos.x, m.pos.y + m.box.h * 0.5, m.pos.z, I.MOB_CATCHER, 1);
    this.killOrbEntity(e);
    this.onToast?.('Catchers only work on hostile mobs');
  }

  /** The dome swings open, a beam locks on and draws the shrinking, glowing
   *  mob inside, then the dome snaps shut and the orb starts to fall. */
  private absorbCatcher(e: Entity, o: OrbState, dt: number): void {
    const T = EntityManager.ABSORB_TIME;
    const t = o.t;
    const rig = o.rig!;
    const glow = new THREE.Color(ORB_GLOW[o.mob ?? ''] ?? ORB_IDLE_GLOW);
    // hover: drift back off the mob and up a touch, settling
    const h = o.hover!, b = o.back!;
    const drift = 1 - Math.exp(-t * 7);
    e.pos.x = h.x + b.x * 0.45 * drift;
    e.pos.y = h.y + 0.35 * drift;
    e.pos.z = h.z + b.z * 0.45 * drift;
    e.mesh.position.set(e.pos.x, e.pos.y, e.pos.z);
    // dome: open over 0.12 s, hold, shut over the last 0.12 s
    const open = t < 0.12 ? t / 0.12 : t < T - 0.14 ? 1 : Math.max(0, (T - 0.02 - t) / 0.12);
    setOrbOpen(rig, open * open * (3 - 2 * open));
    rig.floor.color.copy(glow).multiplyScalar(0.3 + open * 0.7);
    // the mob: pulled from where it stood into the orb, shrinking and glowing
    const k = Math.max(0, Math.min(1, (t - 0.08) / (T - 0.26)));
    const pull = k * k;
    const v = o.victim;
    if (v) {
      if (k >= 1) {
        e.mesh.remove(v);
        disposeGroup(v);
        o.victim = undefined;
      } else {
        const f = o.vFrom!;
        const s = Math.max(0.02, 1 - k * 0.98);
        const vh = (o.vH ?? 1) * s;
        // feet position that puts the mob's middle on the orb centre at the end
        const tx = e.pos.x, ty = e.pos.y - vh * 0.5, tz = e.pos.z;
        v.position.set(
          f.x + (tx - f.x) * pull - e.pos.x,
          f.y + (ty - f.y) * pull - e.pos.y,
          f.z + (tz - f.z) * pull - e.pos.z);
        v.scale.setScalar(s);
        v.rotation.y += dt * k * 12; // swirl as it's drawn in
        for (const m of o.victimMats ?? []) m.emissive.copy(glow).multiplyScalar(0.25 + k * 0.9);
        this.orbBeam(e, o, v.position.x, v.position.y + vh * 0.5, v.position.z, 1 - k * 0.6);
        // motes stream along the beam into the orb
        if (Math.random() < 0.9) {
          const wx = v.position.x + e.pos.x, wy = v.position.y + vh * 0.5 + e.pos.y, wz = v.position.z + e.pos.z;
          this.spawnOrbSpark(wx + (Math.random() - 0.5) * 0.5 * s, wy + (Math.random() - 0.5) * 0.6 * s, wz + (Math.random() - 0.5) * 0.5 * s, {
            life: 0.3, size: 0.16, color: Math.random() < 0.5 ? glow.getHex() : 0xffffff, star: true,
            home: { x: e.pos.x, y: e.pos.y, z: e.pos.z },
          });
        }
      }
    }
    if (!o.victim) this.orbBeam(e, o, 0, 0, 0, 0);
    // the button glows with the captive's colour once it's inside
    rig.button.color.copy(glow).lerp(new THREE.Color(0xffffff), 0.5 * (1 - k));
    (rig.halo.material as THREE.SpriteMaterial).color.copy(glow);
    (rig.halo.material as THREE.SpriteMaterial).opacity = 0.5 + k * 0.5;
    rig.halo.scale.setScalar(rig.R * (1.1 + k * 1.6));
    if (t >= T) {
      setOrbOpen(rig, 0);
      if (o.beam) { e.mesh.remove(o.beam); disposeOrb(o.beam); o.beam = undefined; }
      if (o.victim) { e.mesh.remove(o.victim); disposeGroup(o.victim); o.victim = undefined; }
      o.phase = 'fall';
      o.t = 0;
      e.vel = { x: 0, y: 0.6, z: 0 };
      rig.floor.color.setHex(0x2a1c44);
      this.orbBurst(e.pos.x, e.pos.y, e.pos.z, glow.getHex(), 6);
    }
  }

  /** Stretch the capture beam from the orb (wrapper origin) to a local point;
   *  `a` <= 0 hides it. */
  private orbBeam(e: Entity, o: OrbState, x: number, y: number, z: number, a: number): void {
    if (a <= 0) { if (o.beam) o.beam.visible = false; return; }
    if (!o.beam) {
      const glow = ORB_GLOW[o.mob ?? ''] ?? ORB_IDLE_GLOW;
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(1, 1, 1, 10, 1, true),
        new THREE.MeshBasicMaterial({ color: glow, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
      );
      const core = new THREE.Mesh(
        new THREE.CylinderGeometry(0.4, 0.4, 1, 8, 1, true),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
      );
      beam.add(core);
      o.beam = beam;
      e.mesh.add(beam);
    }
    const beam = o.beam;
    const len = Math.hypot(x, y, z);
    if (len < 0.05) { beam.visible = false; return; }
    beam.visible = true;
    beam.position.set(x / 2, y / 2, z / 2);
    beam.quaternion.setFromUnitVectors(UP, TMP_V.set(x / len, y / len, z / len));
    const r = 0.05 + 0.025 * Math.sin(o.t * 40);
    beam.scale.set(r, len, r);
    (beam.material as THREE.MeshBasicMaterial).opacity = 0.45 * a;
  }

  /** Closed orb drops to the ground (one small bounce), then starts wobbling. */
  private fallCatcher(e: Entity, o: OrbState, dt: number): void {
    const R = EntityManager.ORB_R;
    e.vel.y -= 16 * dt;
    let ny = e.pos.y + e.vel.y * dt;
    const bx = Math.floor(e.pos.x), bz = Math.floor(e.pos.z);
    const under = this.world.getBlock(bx, Math.floor(ny - R), bz);
    const floorHit = under !== B.AIR && under !== B.TORCH && (def(under).solid || def(under).liquid);
    let landed = false;
    if (floorHit && e.vel.y < 0) {
      ny = Math.floor(ny - R) + 1 + R;
      if (def(under).liquid) ny -= 0.12; // bob half-sunk on water/lava
      if (e.vel.y < -3.2 && !o.bounced) {
        o.bounced = true;
        e.vel.y = -e.vel.y * 0.28;
        this.audio.play('orbWobble', this.orbVol(e.pos.x, ny, e.pos.z) * 0.6);
      } else {
        e.vel.y = 0;
        landed = true;
      }
    }
    e.pos.y = ny;
    if (o.rig) o.rig.root.rotation.x *= 1 - Math.min(1, dt * 8);
    e.mesh.position.set(e.pos.x, e.pos.y, e.pos.z);
    if (landed || o.t > 5 || e.pos.y < -8) {
      o.phase = 'wobble';
      o.t = 0;
      // 1-3 suspenseful wobbles (Pokemon-style), then the click
      o.wobbles = 1 + Math.floor(Math.random() * 3);
    }
  }

  /** Rock side to side on the floor, the button blinking; after the last one
   *  the latch clicks, stars burst out and the orb lies there as a pickup. */
  private wobbleCatcher(e: Entity, o: OrbState): void {
    const W = EntityManager.WOBBLE_TIME;
    const rig = o.rig!;
    const idx = Math.floor(o.t / W);
    const glow = ORB_GLOW[o.mob ?? ''] ?? ORB_IDLE_GLOW;
    const halo = rig.halo.material as THREE.SpriteMaterial;
    if (idx < o.wobbles) {
      const u = (o.t - idx * W) / (W * 0.66); // rock for 2/3 of the slot, then rest
      if ((o.lastWob ?? -1) !== idx) {
        o.lastWob = idx;
        this.audio.play('orbWobble', this.orbVol(e.pos.x, e.pos.y, e.pos.z));
      }
      const rock = u < 1 ? Math.sin(u * Math.PI * 2) * 0.42 * (1 - u * 0.35) : 0;
      if (o.pivot) o.pivot.rotation.z = rock;
      // the button blinks a warning red while the captive struggles
      const on = u < 1 && Math.sin(u * Math.PI * 6) > 0;
      rig.button.color.setHex(on ? 0xff4a5a : glow);
      halo.color.setHex(on ? 0xff4a5a : glow);
      halo.opacity = on ? 0.9 : 0.4;
      return;
    }
    if (o.pivot) o.pivot.rotation.z = 0;
    if (o.t < o.wobbles * W + 0.1) return;
    // click: latched shut
    const kind = o.mob ?? 'zombie';
    this.audio.play('orbClick', this.orbVol(e.pos.x, e.pos.y, e.pos.z));
    this.orbStarBurst(e.pos.x, e.pos.y + 0.1, e.pos.z, glow);
    const d = this.spawnDrop(e.pos.x, e.pos.y, e.pos.z, I.MOB_CATCHER_FILLED, 1, undefined, kind);
    d.vel = { x: 0, y: 2.6, z: 0 };
    this.onToast?.(`Captured ${mobLabel(kind)}!`);
    this.killOrbEntity(e);
  }

  /** Remove an orb entity now, freeing its rig + any held victim/beam. */
  private killOrbEntity(e: Entity): void {
    if (e.dead) return;
    e.dead = true;
    e.corpse = true;               // removal loop leaves the mesh to us
    this.scene.remove(e.mesh);
    const o = e.orb;
    if (o?.victim) { e.mesh.remove(o.victim); disposeGroup(o.victim); }
    if (o?.pet && !o.pet.dead && !o.grown) this.finishReleaseGrow(o.pet);
    disposeOrb(e.mesh);
    e.orb = null;
  }

  // --- capture / release / recall effects ('orbfx' entities) ------------------

  private orbVol(x: number, y: number, z: number): number {
    const p = this.player;
    if (!p) return 1;
    return Math.max(0.12, 1 - Math.hypot(p.pos.x - x, p.pos.y - y, p.pos.z - z) / 32);
  }

  /** Where the player's hand is in the world (recall beams + release tosses end/start there). */
  private handPos(): Vec3 | null {
    const p = this.player;
    if (!p) return null;
    const d = p.lookDir();
    const rx = -d.z, rz = d.x; // right of the view
    const rl = Math.hypot(rx, rz) || 1;
    return {
      x: p.pos.x + d.x * 0.5 + (rx / rl) * 0.28,
      y: p.pos.y + p.eyeHeight() - 0.35 + d.y * 0.5,
      z: p.pos.z + d.z * 0.5 + (rz / rl) * 0.28,
    };
  }

  private orbFxCount(): number {
    let n = 0;
    for (const e of this.entities) if (e.kind === 'orbfx') n++;
    return n;
  }

  /** One additive glow/star sprite: drifts on `vel` under `grav`, or homes in
   *  on `home` (motes streaming along a beam). */
  private spawnOrbSpark(x: number, y: number, z: number, s: {
    vel?: Vec3; grav?: number; life: number; size: number; color: number; star?: boolean; home?: Vec3;
  }): void {
    if (this.orbFxCount() > 220) return;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: s.star ? orbStarTexture() : orbGlowTexture(), color: s.color,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    sprite.scale.setScalar(s.size);
    const g = new THREE.Group();
    g.add(sprite);
    g.position.set(x, y, z);
    const e = new Entity('orbfx', { x, y, z }, { w: 0.05, h: 0.05 }, g);
    e.vel = s.vel ? { ...s.vel } : { x: 0, y: 0, z: 0 };
    e.pGrav = s.grav ?? 0;
    e.maxLife = e.life = s.life;
    e.orb = { phase: 'spark', t: 0, rig: null, wobbles: 0, size: s.size, home: s.home, spin: (Math.random() - 0.5) * 8 };
    this.entities.push(e);
    this.scene.add(g);
  }

  /** A soft ring of glow motes (capture flash, bounce puff, block clang). */
  private orbBurst(x: number, y: number, z: number, color: number, n: number): void {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
      const sp = 1.4 + Math.random() * 1.2;
      this.spawnOrbSpark(x, y, z, {
        vel: { x: Math.cos(a) * sp, y: 0.6 + Math.random() * 1.6, z: Math.sin(a) * sp },
        grav: 2, life: 0.4 + Math.random() * 0.3, size: 0.18 + Math.random() * 0.1,
        color: i % 3 === 0 ? 0xffffff : color, star: i % 2 === 0,
      });
    }
  }

  /** The capture "click": a fountain of gold-white stars plus a captive-coloured ring. */
  private orbStarBurst(x: number, y: number, z: number, color: number): void {
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const sp = 1.6 + Math.random() * 0.8;
      this.spawnOrbSpark(x, y, z, {
        vel: { x: Math.cos(a) * sp, y: 3 + Math.random() * 1.5, z: Math.sin(a) * sp },
        grav: 7, life: 0.7 + Math.random() * 0.3, size: 0.26, color: i % 2 ? 0xfff2a0 : 0xffffff, star: true,
      });
    }
    this.orbBurst(x, y, z, color, 10);
    this.spawnOrbSpark(x, y, z, { life: 0.35, size: 1.4, color });
  }

  /** Per-frame update for the capture effects. */
  private updateOrbFx(e: Entity, dt: number): void {
    const o = e.orb;
    if (!o) { e.dead = true; return; }
    o.t += dt;
    if (o.phase === 'spark') this.updateOrbSpark(e, o, dt);
    else if (o.phase === 'recall') this.updateRecallFx(e, o, dt);
    else if (o.phase === 'release') this.updateReleaseFx(e, o, dt);
    else this.killOrbEntity(e);
  }

  private updateOrbSpark(e: Entity, o: OrbState, dt: number): void {
    e.life -= dt;
    if (e.life <= 0) { this.killOrbEntity(e); return; }
    const k = e.life / e.maxLife;
    if (o.home) {
      // accelerate into the target along a slight swirl
      const h = o.home, pull = Math.min(1, dt * (5 + (1 - k) * 18));
      e.pos.x += (h.x - e.pos.x) * pull;
      e.pos.y += (h.y - e.pos.y) * pull;
      e.pos.z += (h.z - e.pos.z) * pull;
    } else {
      e.vel.y -= e.pGrav * dt;
      const damp = 1 - Math.min(1, 2.2 * dt);
      e.vel.x *= damp; e.vel.z *= damp;
      e.pos.x += e.vel.x * dt;
      e.pos.y += e.vel.y * dt;
      e.pos.z += e.vel.z * dt;
    }
    e.mesh.position.set(e.pos.x, e.pos.y, e.pos.z);
    const sprite = e.mesh.children[0] as THREE.Sprite;
    const tw = 0.75 + 0.25 * Math.sin(o.t * 30 + e.maxLife * 50); // twinkle
    sprite.scale.setScalar((o.size ?? 0.2) * Math.max(0.05, Math.min(1, k * 1.6)) * tw);
    sprite.material.rotation += dt * (o.spin ?? 0);
    sprite.material.opacity = Math.min(1, k * 2);
  }

  /** Recall: the pet's mesh dissolves into a glowing beam that streams back
   *  to the player's hand. */
  private startRecallFx(pet: Entity): void {
    const wrap = new THREE.Group();
    wrap.position.set(pet.pos.x, pet.pos.y, pet.pos.z);
    const fx = new Entity('orbfx', { ...pet.pos }, { w: 0.1, h: 0.1 }, wrap);
    pet.corpse = true;
    if (pet.shadow) pet.shadow.visible = false;
    const mesh = pet.mesh;
    this.scene.remove(mesh);
    mesh.position.set(0, 0, 0);
    wrap.add(mesh);
    fx.orb = {
      phase: 'recall', t: 0, rig: null, wobbles: 0,
      mob: pet.kind as string, victim: mesh, victimMats: pet.materials, vH: pet.box.h,
    };
    this.entities.push(fx);
    this.scene.add(wrap);
  }

  private updateRecallFx(e: Entity, o: OrbState, dt: number): void {
    const T = 0.5;
    const hand = this.handPos() ?? { x: e.pos.x, y: e.pos.y + 1.5, z: e.pos.z };
    const hx = hand.x - e.pos.x, hy = hand.y - e.pos.y, hz = hand.z - e.pos.z;
    const k = Math.min(1, o.t / T);
    const glow = new THREE.Color(ORB_GLOW[o.mob ?? ''] ?? ORB_IDLE_GLOW);
    const v = o.victim;
    if (v) {
      const s = Math.max(0.02, 1 - k);
      const pull = k * k;
      const vh = (o.vH ?? 1) * s;
      v.scale.setScalar(s);
      v.position.set(hx * pull, hy * pull - vh * 0.5 * pull, hz * pull);
      v.rotation.y += dt * 10 * k;
      for (const m of o.victimMats ?? []) m.emissive.copy(glow).multiplyScalar(0.3 + k);
      // the beam runs from the pet to the hand
      this.orbBeamBetween(e, o, v.position.x, v.position.y + vh * 0.5, v.position.z, hx, hy, hz, 1 - k * 0.5);
      if (Math.random() < 0.9) {
        this.spawnOrbSpark(e.pos.x + v.position.x + (Math.random() - 0.5) * 0.5 * s,
          e.pos.y + v.position.y + vh * Math.random(), e.pos.z + v.position.z + (Math.random() - 0.5) * 0.5 * s, {
            life: 0.3, size: 0.15, color: Math.random() < 0.5 ? glow.getHex() : 0xffffff, star: true, home: hand,
          });
      }
    }
    if (o.t >= T) this.killOrbEntity(e);
  }

  /** Beam between two local points of an fx wrapper. */
  private orbBeamBetween(e: Entity, o: OrbState, ax: number, ay: number, az: number,
    bx: number, by: number, bz: number, a: number): void {
    this.orbBeam(e, o, bx - ax, by - ay, bz - az, a);
    if (o.beam) o.beam.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  }

  /** Release: an orb tossed from the hand lands at the spot, pops open in a
   *  flash and the pet grows up out of it. */
  private startReleaseFx(pet: Entity): void {
    const R = EntityManager.ORB_R;
    const { wrap, rig, pivot } = this.buildThrownOrb();
    const glow = ORB_GLOW[pet.kind as string] ?? ORB_IDLE_GLOW;
    rig.button.color.setHex(glow);
    (rig.halo.material as THREE.SpriteMaterial).color.setHex(glow);
    const to = { x: pet.pos.x, y: pet.pos.y + R, z: pet.pos.z };
    const from = this.handPos() ?? { x: to.x, y: to.y + 1, z: to.z };
    const fx = new Entity('orbfx', { ...from }, { w: 0.1, h: 0.1 }, wrap);
    wrap.position.set(from.x, from.y, from.z);
    rig.root.rotation.y = Math.atan2(from.x - to.x, from.z - to.z); // button toward the player
    fx.orb = { phase: 'release', t: 0, rig, pivot, wobbles: 0, mob: pet.kind as string, pet, from, to };
    pet.mesh.scale.setScalar(0.001);
    this.entities.push(fx);
    this.scene.add(wrap);
    this.audio.play('orbThrow', 0.7);
  }

  private updateReleaseFx(e: Entity, o: OrbState, dt: number): void {
    const TOSS = 0.28, POP = 0.36, GROW = 0.5, END = 1.15;
    const t = o.t, rig = o.rig!, pet = o.pet;
    const from = o.from!, to = o.to!;
    const glow = ORB_GLOW[o.mob ?? ''] ?? ORB_IDLE_GLOW;
    if (t < TOSS) {
      // a short lob from the hand to the spot
      const k = t / TOSS;
      e.pos.x = from.x + (to.x - from.x) * k;
      e.pos.y = from.y + (to.y - from.y) * k + Math.sin(k * Math.PI) * 0.5;
      e.pos.z = from.z + (to.z - from.z) * k;
      rig.spin.rotation.y += dt * 16;
    } else {
      e.pos.x = to.x; e.pos.y = to.y; e.pos.z = to.z;
      rig.spin.rotation.y *= 1 - Math.min(1, dt * 12);
      if (!o.popped) {
        o.popped = true;
        this.audio.play('orbRelease', this.orbVol(to.x, to.y, to.z));
        // the flash: a big soft bloom + a ring of motes and stars
        this.spawnOrbSpark(to.x, to.y + 0.3, to.z, { life: 0.4, size: 2.2, color: 0xffffff });
        this.spawnOrbSpark(to.x, to.y + 0.3, to.z, { life: 0.55, size: 1.5, color: glow });
        this.orbBurst(to.x, to.y + 0.2, to.z, glow, 14);
      }
    }
    e.mesh.position.set(e.pos.x, e.pos.y, e.pos.z);
    // dome: pops open at TOSS, shuts again as the orb fades
    const open = t < TOSS ? 0 : t < POP ? (t - TOSS) / (POP - TOSS) : t < END - 0.3 ? 1 : Math.max(0, (END - 0.15 - t) / 0.15);
    setOrbOpen(rig, open);
    rig.floor.color.setHex(glow).multiplyScalar(0.2 + open * 0.8);
    // the pet grows out of the orb with a little overshoot, glowing white-hot first
    if (pet && !pet.dead) {
      const g = Math.max(0, Math.min(1, (t - TOSS) / GROW));
      const back = g >= 1 ? 1 : 1 + 2.2 * Math.pow(g - 1, 3) + 1.2 * Math.pow(g - 1, 2); // ease-out-back
      pet.mesh.scale.setScalar(Math.max(0.001, g <= 0 ? 0.001 : back));
      const heat = 1 - g;
      for (const m of pet.materials) m.emissive.setRGB(heat * 0.9, heat * 0.85, heat);
      if (g >= 1 && !o.grown) { o.grown = true; this.finishReleaseGrow(pet); }
    }
    // then the empty orb shrinks away in a few sparkles
    const fade = t > END - 0.25 ? Math.max(0, (END - t) / 0.25) : Math.min(1, t / 0.08);
    rig.root.scale.setScalar(Math.max(0.001, fade));
    if (t >= END) {
      this.orbBurst(e.pos.x, e.pos.y, e.pos.z, ORB_IDLE_GLOW, 5);
      this.killOrbEntity(e);
    }
  }

  /** Settle a released pet at full size with its normal shading. */
  private finishReleaseGrow(pet: Entity): void {
    pet.mesh.scale.setScalar(1);
    for (const m of pet.materials) m.emissive.setRGB(0, 0, 0);
    this.spawnHearts(pet.pos.x, pet.pos.y + pet.box.h + 0.2, pet.pos.z);
  }

  /** A soft round contact shadow plane, parented under a mob. */
  private makeShadow(w: number): THREE.Mesh {
    if (!this.shadowTex) {
      const c = document.createElement('canvas');
      c.width = 32; c.height = 32;
      const ctx = c.getContext('2d')!;
      const grad = ctx.createRadialGradient(16, 16, 1, 16, 16, 16);
      grad.addColorStop(0, 'rgba(0,0,0,0.5)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 32, 32);
      this.shadowTex = new THREE.CanvasTexture(c);
    }
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w * 1.6, w * 1.6),
      new THREE.MeshBasicMaterial({ map: this.shadowTex, transparent: true, depthWrite: false, opacity: 0.5 }),
    );
    m.rotation.x = -Math.PI / 2;
    m.position.y = 0.02;
    m.renderOrder = 1;
    m.userData.shadow = true;
    return m;
  }

  /** Spawn a phantom above the player (called when sleep has been skipped). */
  spawnPhantom(x: number, y: number, z: number): void {
    const e = this.spawnMob('phantom', x, y, z);
    e.circling = Math.random() * 4;
  }

  spawnFallingBlock(x: number, y: number, z: number, blockId: number): void {
    const mesh = new THREE.Group();
    mesh.add(this.makeBlockMesh(blockId, 0.98));
    const e = new Entity('falling', { x: x + 0.5, y, z: z + 0.5 }, { w: 0.98, h: 0.98 }, mesh);
    e.itemId = blockId;
    this.entities.push(e);
    this.scene.add(mesh);
  }

  spawnTnt(x: number, y: number, z: number, fuse = 2.5): void {
    const mesh = new THREE.Group();
    const inner = this.makeBlockMesh(B.TNT, 0.96);
    mesh.add(inner);
    const e = new Entity('tnt', { x: x + 0.5, y, z: z + 0.5 }, { w: 0.96, h: 0.96 }, mesh);
    e.fuseT = fuse;
    e.vel.y = 3;
    // collect materials for the white flash
    inner.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.material) {
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mm of mats) {
          if ((mm as THREE.MeshLambertMaterial).isMeshLambertMaterial) {
            e.materials.push(mm as THREE.MeshLambertMaterial);
          }
        }
      }
    });
    this.entities.push(e);
    this.scene.add(mesh);
    this.audio.play('fuse');
  }

  /** Cast a fishing bobber from the player; returns the new bobber entity. */
  castBobber(x: number, y: number, z: number, dx: number, dy: number, dz: number): Entity {
    const mesh = new THREE.Group();
    // bobber: small cork + line implied
    const cork = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 6, 6),
      new THREE.MeshLambertMaterial({ color: 0xd8d8c8 }),
    );
    mesh.add(cork);
    const e = new Entity('bobber', { x, y, z }, { w: 0.1, h: 0.1 }, mesh);
    const len = Math.hypot(dx, dy, dz) || 1;
    e.vel = { x: (dx / len) * 14, y: (dy / len) * 14 + 2, z: (dz / len) * 14 };
    this.entities.push(e);
    this.scene.add(mesh);
    return e;
  }

  /** Reel in a bobber: if it was sitting in water long enough to get a bite,
   *  roll the fishing loot table and spawn the drop. Returns the caught item id (0 = nothing). */
  reelBobber(e: Entity): number {
    if (e.kind !== 'bobber') return 0;
    e.dead = true;
    if (e.biteT <= 0) return 0; // no bite yet
    // weighted loot: mostly fish, sometimes junk/treasure
    const pool: [id: number, weight: number][] = [
      [I.RAW_FISH, 60],
      [I.RAW_FISH, 60], // double weight for fish
      [I.EMERALD, 3],
      [I.BONE, 6],
      [I.ARROW, 4],
      [I.STRING, 5],
      [B.SAND, 8],
      [I.FEATHER, 5],
    ];
    const total = pool.reduce((s, p) => s + p[1], 0);
    let r = Math.random() * total;
    let id = I.RAW_FISH;
    for (const p of pool) { r -= p[1]; if (r <= 0) { id = p[0]; break; } }
    if (id) this.spawnDrop(e.pos.x, e.pos.y + 0.3, e.pos.z, id, 1);
    this.audio.play('pop');
    return id;
  }

  /** Update a fishing bobber: arc into the water, then wait for a random bite. */
  private updateBobber(e: Entity, dt: number): void {
    const inWaterNow = this.world.getBlock(Math.floor(e.pos.x), Math.floor(e.pos.y), Math.floor(e.pos.z)) === B.WATER;
    if (inWaterNow) {
      if (e.inWaterT === 0) this.audio.play('splash');
      // floats + waits for a bite
      e.vel.y = 0;
      e.vel.x *= 0.8; e.vel.z *= 0.8;
      e.inWaterT += dt;
      // bite after 2-8s in water
      if (e.biteT <= 0 && e.inWaterT > 2 && Math.random() < dt * 0.25) {
        e.biteT = 1.0; // 1s window to reel
        this.audio.play('pop');
      }
      if (e.biteT > 0) {
        e.biteT -= dt;
        // splash wiggle while biting
        e.vel.y = Math.sin(e.age * 20) * 0.5;
      }
    } else {
      e.vel.y -= GRAVITY * dt;
      const res = moveEntity(this.world, e.pos, e.vel, dt, e.box);
      if (res.onGround) { e.vel.x *= 0.5; e.vel.z *= 0.5; }
    }
    e.mesh.position.set(e.pos.x, e.pos.y, e.pos.z);
    if (e.age > 60) e.dead = true;
  }

  /** Minecraft's arrow entity: two identical side-view arrows crossed along
   *  the shaft (an X seen from behind), each extruded one pixel thick. The
   *  item sprite's dark outline turned the shaft black at this scale, so the
   *  entity gets its own unoutlined horizontal profile. Tip points down +z,
   *  which is what lookAt aims along the flight path. */
  private buildArrowMesh(): THREE.Group {
    if (!this.arrowSprite) {
      const c = document.createElement('canvas');
      c.width = 16; c.height = 16;
      const ctx = c.getContext('2d')!;
      const rows = [
        '................',
        '..W.............',
        '.WWw.........L..',
        '.WwwHhHhHhHhLLL.',
        '.WwwhHhHhHhHmmmL',
        '.WWw.........m..',
        '..W.............',
      ];
      const pal: Record<string, string> = {
        W: '#f4f4f4', w: '#c8c8cc',   // goose-feather fletching
        H: '#9c7440', h: '#6e4e28',   // oak shaft
        L: '#e0e0e0', m: '#9a9a9a',   // flint head
      };
      rows.forEach((row, y) => {
        for (let x = 0; x < 16; x++) {
          const col = pal[row[x]];
          if (!col) continue;
          ctx.fillStyle = col;
          ctx.fillRect(x, y + 5, 1, 1);
        }
      });
      this.arrowSprite = c;
    }
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    for (let i = 0; i < 2; i++) {
      const geo = extrudeSpriteGeometry(this.arrowSprite, 0.5);
      geo.rotateY(-Math.PI / 2); // tip (+x) onto +z
      if (i) geo.rotateZ(Math.PI / 2);
      g.add(new THREE.Mesh(geo, mat));
    }
    return g;
  }

  shootArrow(owner: 'player' | 'skeleton', x: number, y: number, z: number,
    dx: number, dy: number, dz: number, speed: number, dmg: number): void {
    const mesh = this.buildArrowMesh();
    const len = Math.hypot(dx, dy, dz) || 1;
    const e = new Entity('arrow', { x, y, z }, { w: 0.1, h: 0.1 }, mesh);
    e.vel = { x: (dx / len) * speed, y: (dy / len) * speed, z: (dz / len) * speed };
    e.owner = owner;
    e.dmg = dmg;
    this.entities.push(e);
    this.scene.add(mesh);
    this.audio.play('bow');
  }

  /** One textured fleck sampled from the block's tile. */
  private makeParticle(tile: string, x: number, y: number, z: number,
    vel: { x: number; y: number; z: number }, life: number, grav = 18): void {
    let mat = this.particleMats.get(tile);
    if (!mat) {
      mat = new THREE.MeshBasicMaterial({ map: this.atlas.texture, side: THREE.DoubleSide });
      this.particleMats.set(tile, mat);
    }
    const rect = this.atlas.rect(tile);
    const geo = new THREE.PlaneGeometry(0.13, 0.13);
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    const u = rect.u0 + Math.random() * (rect.u1 - rect.u0) * 0.75;
    const v = rect.v0 + Math.random() * (rect.v1 - rect.v0) * 0.75;
    const du = (rect.u1 - rect.u0) * 0.25, dv = (rect.v1 - rect.v0) * 0.25;
    uv.setXY(0, u, v); uv.setXY(1, u + du, v); uv.setXY(2, u, v + dv); uv.setXY(3, u + du, v + dv);
    const mesh = new THREE.Group();
    mesh.add(new THREE.Mesh(geo, mat));
    const e = new Entity('particle', { x, y, z }, { w: 0.08, h: 0.08 }, mesh);
    e.vel = vel;
    e.maxLife = e.life = life;
    e.pGrav = grav;
    this.entities.push(e);
    this.scene.add(mesh);
  }

  /** MC-style block-break particles: textured flecks from the block's tile. */
  spawnBlockParticles(x: number, y: number, z: number, blockId: number, count: number): void {
    if (!hasDef(blockId) || !def(blockId).faces) return;
    if (this.particleCount() >= 64) return;
    const tile = def(blockId).faces!.sides;
    const n = Math.min(count, 64 - this.particleCount());
    for (let i = 0; i < n; i++) {
      this.makeParticle(tile,
        x + 0.2 + Math.random() * 0.6,
        y + 0.15 + Math.random() * 0.35,
        z + 0.2 + Math.random() * 0.6,
        {
          x: (Math.random() - 0.5) * 2.2,
          y: 0.4 + Math.random() * 1.2,
          z: (Math.random() - 0.5) * 2.2,
        },
        0.28 + Math.random() * 0.3);
    }
  }

  private particleCount(): number {
    let n = 0;
    for (const e of this.entities) if (e.kind === 'particle') n++;
    return n;
  }

  /** Small puffs at the mined face while a block is being broken. */
  spawnHitParticles(x: number, y: number, z: number, nx: number, ny: number, nz: number, blockId: number): void {
    if (!hasDef(blockId) || !def(blockId).faces) return;
    const tile = def(blockId).faces!.sides;
    for (let i = 0; i < 2; i++) {
      const jx = (Math.random() - 0.5) * 0.7 * (1 - Math.abs(nx));
      const jy = (Math.random() - 0.5) * 0.7 * (1 - Math.abs(ny));
      const jz = (Math.random() - 0.5) * 0.7 * (1 - Math.abs(nz));
      this.makeParticle(tile,
        x + 0.5 + nx * 0.56 + jx,
        y + 0.5 + ny * 0.56 + jy,
        z + 0.5 + nz * 0.56 + jz,
        {
          x: nx * (1 + Math.random()) + (Math.random() - 0.5) * 1.2,
          y: Math.abs(ny) * 1.5 + 0.8 + Math.random(),
          z: nz * (1 + Math.random()) + (Math.random() - 0.5) * 1.2,
        },
        0.25 + Math.random() * 0.25);
    }
  }

  /** White smoke poof (mob deaths). */
  spawnPoof(x: number, y: number, z: number): void {
    for (let i = 0; i < 9; i++) {
      this.makeParticle('wool',
        x + (Math.random() - 0.5) * 0.7,
        y + Math.random() * 1.2,
        z + (Math.random() - 0.5) * 0.7,
        {
          x: (Math.random() - 0.5) * 1.2,
          y: 0.8 + Math.random() * 1.4,
          z: (Math.random() - 0.5) * 1.2,
        },
        0.5 + Math.random() * 0.4,
        -1.5); // smoke drifts upward
    }
  }

  /** A rising ember from a torch flame. */
  spawnTorchFlame(x: number, y: number, z: number): void {
    if (this.particleCount() >= 80) return;
    let mat = this.particleMats.get('ember');
    if (!mat) {
      const c = document.createElement('canvas');
      c.width = 4; c.height = 4;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#ffb24a';
      ctx.fillRect(0, 0, 4, 4);
      const tex = new THREE.CanvasTexture(c);
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      mat = new THREE.MeshBasicMaterial({
        map: tex, color: 0xffc05a, transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      this.particleMats.set('ember', mat);
    }
    const mesh = new THREE.Group();
    mesh.add(new THREE.Mesh(new THREE.PlaneGeometry(0.07, 0.07), mat));
    const e = new Entity('particle',
      { x: x + (Math.random() - 0.5) * 0.12, y, z: z + (Math.random() - 0.5) * 0.12 },
      { w: 0.03, h: 0.03 }, mesh);
    e.vel = { x: (Math.random() - 0.5) * 0.15, y: 0.4 + Math.random() * 0.35, z: (Math.random() - 0.5) * 0.15 };
    e.maxLife = e.life = 0.5 + Math.random() * 0.4;
    e.pGrav = -0.5; // drifts upward
    this.entities.push(e);
    this.scene.add(mesh);
  }

  /** A single glowing firefly mote — warm pixel that drifts + fades. */
  spawnFirefly(x: number, y: number, z: number): void {
    let mat = this.particleMats.get('firefly');
    if (!mat) {
      // bright yellow-green emissive fleck
      const c = document.createElement('canvas');
      c.width = 4; c.height = 4;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#d8f08a';
      ctx.fillRect(0, 0, 4, 4);
      const tex = new THREE.CanvasTexture(c);
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      mat = new THREE.MeshBasicMaterial({ map: tex, color: 0xd8f08a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
      this.particleMats.set('firefly', mat);
    }
    const geo = new THREE.PlaneGeometry(0.08, 0.08);
    const mesh = new THREE.Group();
    mesh.add(new THREE.Mesh(geo, mat));
    const e = new Entity('particle', { x, y, z }, { w: 0.05, h: 0.05 }, mesh);
    e.vel = {
      x: (Math.random() - 0.5) * 0.5,
      y: 0.2 + Math.random() * 0.4,
      z: (Math.random() - 0.5) * 0.5,
    };
    e.maxLife = e.life = 2.5 + Math.random() * 2;
    e.pGrav = -0.4; // drifts upward gently
    this.entities.push(e);
    this.scene.add(mesh);
  }

  /** A single falling leaf — drifts down with a side-to-side sway. */
  spawnLeaf(x: number, y: number, z: number): void {
    this.makeParticle('birch_leaves',
      x, y, z,
      { x: (Math.random() - 0.5) * 1.2, y: -0.8 - Math.random() * 0.6, z: (Math.random() - 0.5) * 1.2 },
      3 + Math.random() * 2,
      0.8);
  }

  // --- explosions -----------------------------------------------------------------

  explode(x: number, y: number, z: number, power: number, cause = 'Blown up by TNT'): void {
    this.audio.play('explode', this.player ? Math.max(0.2, 1 - Math.hypot(this.player.pos.x - x, this.player.pos.y - y, this.player.pos.z - z) / 60) : 1);
    const r = Math.ceil(power);
    const cx = Math.floor(x), cy = Math.floor(y), cz = Math.floor(z);
    for (let dy = -r; dy <= r; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d > power) continue;
          if (d > power - 0.7 && Math.random() < 0.45) continue; // ragged crater edge
          const bxp = cx + dx, byp = cy + dy, bzp = cz + dz;
          const id = this.world.getBlock(bxp, byp, bzp);
          if (id === B.AIR || id === B.WATER || id === B.BEDROCK) continue;
          if (id === B.TNT) {
            this.world.setBlock(bxp, byp, bzp, B.AIR);
            this.spawnTnt(bxp, byp, bzp, 0.3 + Math.random() * 0.6);
            continue;
          }
          // spill container contents
          const beKey = `${bxp},${byp},${bzp}`;
          const be = this.world.blockEntities.get(beKey);
          if (be) {
            const spill = be.type === 'furnace' ? [be.input, be.fuel, be.output] : be.slots;
            for (const s of spill) {
              if (s) this.spawnDrop(bxp + 0.5, byp + 0.5, bzp + 0.5, s.id, s.count);
            }
            this.world.blockEntities.delete(beKey);
          }
          this.world.setBlock(bxp, byp, bzp, B.AIR);
          if (Math.random() < 0.3) {
            const dDef = def(id);
            if (dDef.drop !== null) {
              const drop = dDef.drop ?? { id, min: 1, max: 1 };
              this.spawnDrop(bxp + 0.5, byp + 0.5, bzp + 0.5, drop.id, drop.min);
            }
          }
        }
      }
    }
    this.spawnBlockParticles(cx, cy, cz, B.STONE, 26);

    // entity + player damage with distance falloff
    const range = power * 2;
    const p = this.player;
    if (p && !p.dead) {
      const d = Math.hypot(p.pos.x - x, p.pos.y + 0.9 - y, p.pos.z - z);
      if (d < range) {
        p.damage(Math.ceil((1 - d / range) * power * 7), undefined, cause);
        p.applyKnockback(p.pos.x - x, p.pos.z - z, (1 - d / range) * 14);
      }
    }
    for (const e of this.entities) {
      if (!this.isMob(e) || e.dead) continue;
      const d = Math.hypot(e.pos.x - x, e.pos.y + e.box.h / 2 - y, e.pos.z - z);
      if (d < range) {
        this.hurt(e, Math.ceil((1 - d / range) * power * 7), e.pos.x - x, e.pos.z - z);
      }
    }
  }

  /** Lightning strike: heavy damage to entities in a small radius + a flash. */
  lightningDamage(x: number, y: number, z: number): void {
    const range = 4;
    const p = this.player;
    if (p && !p.dead && p.mode === 'survival') {
      const d = Math.hypot(p.pos.x - x, p.pos.y + 0.9 - y, p.pos.z - z);
      if (d < range) {
        p.damage(5, undefined, 'Struck by lightning');
        p.applyKnockback(p.pos.x - x, p.pos.z - z, 6);
      }
    }
    for (const e of this.entities) {
      if (!this.isMob(e) || e.dead) continue;
      const d = Math.hypot(e.pos.x - x, e.pos.y + e.box.h / 2 - y, e.pos.z - z);
      if (d < range) this.hurt(e, 8, e.pos.x - x, e.pos.z - z);
    }
    // a quick flash poof
    for (let i = 0; i < 14; i++) {
      this.makeParticle('wool',
        x + (Math.random() - 0.5) * 1.2, y + Math.random() * 2, z + (Math.random() - 0.5) * 1.2,
        { x: (Math.random() - 0.5) * 3, y: 1 + Math.random() * 3, z: (Math.random() - 0.5) * 3 },
        0.4 + Math.random() * 0.3, -2);
    }
  }

  // --- per-frame update ---------------------------------------------------------

  update(dt: number, elapsed: number, camQ: THREE.Quaternion): void {
    for (const e of this.entities) {
      e.age += dt;
      switch (e.kind) {
        case 'drop': this.updateDrop(e, dt, elapsed); break;
        case 'arrow': this.updateArrow(e, dt); break;
        case 'tnt': this.updateTnt(e, dt); break;
        case 'falling': this.updateFalling(e, dt); break;
        case 'particle': this.updateParticle(e, dt, camQ); break;
        case 'bobber': this.updateBobber(e, dt); break;
        case 'catcher': this.updateCatcher(e, dt); break;
        case 'orbfx': this.updateOrbFx(e, dt); break;
        default: this.updateMob(e, dt); break;
      }
    }
    for (let i = this.entities.length - 1; i >= 0; i--) {
      const e = this.entities[i];
      if (e.dead) {
        if (!e.corpse) {
          this.scene.remove(e.mesh);
          disposeGroup(e.mesh);
        }
        this.entities.splice(i, 1);
      }
    }
    this.updateCorpses(dt);
  }

  /** Vanilla death: the body tips onto its side, flushed red, then vanishes in a
   *  puff of smoke. The mesh outlives its (already dead) entity for DEATH_TIME. */
  private updateCorpses(dt: number): void {
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i];
      c.t += dt;
      const f = Math.min(1, Math.sqrt(c.t / (DEATH_TIME * 0.6)));
      const ang = f * Math.PI / 2;
      c.mesh.rotation.x = 0;
      c.mesh.rotation.z = ang;
      // lift by the half-width so the body lies on the ground instead of in it
      c.mesh.position.y = c.y + Math.sin(ang) * c.w * 0.5;
      for (const m of c.mats) {
        m.color.setRGB(MOB_EXPOSURE, MOB_EXPOSURE * 0.45, MOB_EXPOSURE * 0.45);
        m.emissive.setRGB(0.25, 0, 0);
      }
      if (c.t >= DEATH_TIME) {
        this.spawnPoof(c.x, c.y, c.z);
        this.audio.play('pop');
        this.scene.remove(c.mesh);
        disposeGroup(c.mesh);
        this.corpses.splice(i, 1);
      }
    }
  }

  private updateDrop(e: Entity, dt: number, elapsed: number): void {
    const p = this.player!;
    const dx = p.pos.x - e.pos.x;
    const dy = (p.pos.y + 0.9) - e.pos.y;
    const dz = p.pos.z - e.pos.z;
    const dist = Math.hypot(dx, dy, dz);
    if (e.age > 0.6 && dist < 2.5 && !p.dead) {
      const pull = 26 * dt / Math.max(0.4, dist);
      e.vel.x += dx * pull;
      e.vel.y += dy * pull;
      e.vel.z += dz * pull;
      if (dist < 0.6) {
        const leftover = this.pickupDrop(e);
        if (leftover <= 0) {
          e.dead = true;
          this.audio.play('pop');
          return;
        }
        e.count = leftover;
      }
    } else {
      e.vel.y -= GRAVITY * 0.55 * dt;
    }
    if (inWater(this.world, e.pos, e.box)) e.vel.y = Math.max(e.vel.y, 1.2);
    e.vel.x *= 1 - Math.min(1, 6 * dt);
    e.vel.z *= 1 - Math.min(1, 6 * dt);
    moveEntity(this.world, e.pos, e.vel, dt, e.box);
    if (e.age > 300) e.dead = true; // 5-minute despawn

    e.mesh.position.set(e.pos.x, e.pos.y + 0.12 + Math.sin(elapsed * 2 + e.age) * 0.05, e.pos.z);
    e.mesh.rotation.y = elapsed * 1.4;
  }

  private pickupDrop(e: Entity): number {
    const inv = this.player!.inventory;
    if (e.dmg > 0 || e.ench) {
      let left = e.count;
      for (let i = 0; i < inv.slots.length && left > 0; i++) {
        if (!inv.slots[i]) {
          inv.slots[i] = { id: e.itemId, count: 1, ...(e.dmg > 0 ? { dur: e.dmg } : {}), ...(e.ench ? { ench: e.ench } : {}) };
          left--;
        }
      }
      if (left !== e.count) inv.onChange();
      return left;
    }
    // filled mob catchers carry a captured-mob field that add() would drop
    if (e.mob !== undefined) {
      let left = e.count;
      for (let i = 0; i < inv.slots.length && left > 0; i++) {
        if (!inv.slots[i]) {
          inv.slots[i] = { id: e.itemId, count: 1, mob: e.mob };
          left--;
        }
      }
      if (left !== e.count) inv.onChange();
      return left;
    }
    return inv.add(e.itemId, e.count);
  }

  private updateArrow(e: Entity, dt: number): void {
    if (e.stuckT >= 0) { this.updateStuckArrow(e, dt); return; }
    const speed = Math.hypot(e.vel.x, e.vel.y, e.vel.z);
    const steps = Math.max(1, Math.ceil(speed * dt / 0.45));
    const sdt = dt / steps;
    const fireball = e.owner === 'emberghast' || e.owner === 'petghast';
    const hurtsPlayer = e.owner === 'skeleton' || e.owner === 'emberghast';
    const fromPet = e.owner === 'pet' || e.owner === 'petghast';
    for (let s = 0; s < steps && !e.dead; s++) {
      if (!fireball) e.vel.y -= 16 * sdt; // fireballs fly flat
      e.pos.x += e.vel.x * sdt;
      e.pos.y += e.vel.y * sdt;
      e.pos.z += e.vel.z * sdt;
      // block hit
      const id = this.world.getBlock(Math.floor(e.pos.x), Math.floor(e.pos.y), Math.floor(e.pos.z));
      if (id !== B.AIR && id !== B.WATER && id !== B.TORCH && def(id).solid) {
        e.dead = true;
        if (fireball) { this.fireballBurst(e.pos.x, e.pos.y, e.pos.z); return; }
        this.audio.play('arrowHit');
        if (e.owner === 'player' || e.owner === 'skeleton') {
          // arrows bury their tip in the block and quiver (vanilla), staying
          // put until picked up or the block under them is broken
          const len = Math.hypot(e.vel.x, e.vel.y, e.vel.z) || 1;
          const ux = e.vel.x / len, uy = e.vel.y / len, uz = e.vel.z / len;
          // walk back to where the shaft entered the block, then sit the
          // 0.5-long arrow so only its flint tip (~0.1) is buried
          for (let k = 0; k < 24; k++) {
            const bid = this.world.getBlock(Math.floor(e.pos.x), Math.floor(e.pos.y), Math.floor(e.pos.z));
            if (bid === B.AIR || !def(bid).solid) break;
            e.pos.x -= ux * 0.03; e.pos.y -= uy * 0.03; e.pos.z -= uz * 0.03;
          }
          e.pos.x -= ux * 0.14; e.pos.y -= uy * 0.14; e.pos.z -= uz * 0.14;
          e.dead = false;
          e.stuckT = 0;
          e.mesh.position.set(e.pos.x, e.pos.y, e.pos.z);
          e.mesh.lookAt(e.pos.x + e.vel.x, e.pos.y + e.vel.y, e.pos.z + e.vel.z);
          e.mesh.userData.rest = e.mesh.quaternion.clone();
          e.vel = { x: e.vel.x / len, y: e.vel.y / len, z: e.vel.z / len }; // keep the heading for the wobble
          e.age = 0;
        }
        return;
      }
      // entity hit
      if (hurtsPlayer) {
        const p = this.player!;
        const hw = 0.3;
        if (!p.dead && p.mode === 'survival' &&
          e.pos.x > p.pos.x - hw && e.pos.x < p.pos.x + hw &&
          e.pos.y > p.pos.y && e.pos.y < p.pos.y + 1.8 &&
          e.pos.z > p.pos.z - hw && e.pos.z < p.pos.z + hw) {
          p.damage(e.dmg, undefined, fireball ? 'Fireballed by an Emberghast' : 'Shot by a Skeleton');
          p.applyKnockback(e.vel.x, e.vel.z, 5);
          e.dead = true;
          if (fireball) this.fireballBurst(e.pos.x, e.pos.y, e.pos.z);
          return;
        }
        // pets fight on the player's side, so hostile shots wound them too
        for (const m of this.entities) {
          if (!this.isPet(m) || m.dead) continue;
          const mw = m.box.w / 2;
          if (e.pos.x > m.pos.x - mw && e.pos.x < m.pos.x + mw &&
            e.pos.y > m.pos.y && e.pos.y < m.pos.y + m.box.h &&
            e.pos.z > m.pos.z - mw && e.pos.z < m.pos.z + mw) {
            this.hurt(m, e.dmg, e.vel.x, e.vel.z);
            e.dead = true;
            if (fireball) this.fireballBurst(e.pos.x, e.pos.y, e.pos.z);
            return;
          }
        }
      } else {
        for (const m of this.entities) {
          if (!this.isMob(m) || m.dead) continue;
          if (fromPet && this.isPet(m)) continue; // pets don't shoot each other
          const hw = m.box.w / 2;
          if (e.pos.x > m.pos.x - hw && e.pos.x < m.pos.x + hw &&
            e.pos.y > m.pos.y && e.pos.y < m.pos.y + m.box.h &&
            e.pos.z > m.pos.z - hw && e.pos.z < m.pos.z + hw) {
            this.hurt(m, e.dmg, e.vel.x, e.vel.z, fromPet ? undefined : this.player ?? undefined);
            e.dead = true;
            if (fireball) this.fireballBurst(e.pos.x, e.pos.y, e.pos.z);
            return;
          }
        }
      }
    }
    if (e.age > 30 || e.pos.y < -8) e.dead = true;
    e.mesh.position.set(e.pos.x, e.pos.y, e.pos.z);
    e.mesh.lookAt(e.pos.x + e.vel.x, e.pos.y + e.vel.y, e.pos.z + e.vel.z);
  }

  /** An arrow embedded in a block: quivers briefly, can be walked over to pick
   *  up (the player's own), and drops out if its block is mined away. */
  private updateStuckArrow(e: Entity, dt: number): void {
    e.stuckT += dt;
    // the block the tip is buried in: a little ahead along the heading
    const tx = Math.floor(e.pos.x + e.vel.x * 0.3);
    const ty = Math.floor(e.pos.y + e.vel.y * 0.3);
    const tz = Math.floor(e.pos.z + e.vel.z * 0.3);
    const id = this.world.getBlock(tx, ty, tz);
    if (id === B.AIR || id === B.WATER || !def(id).solid) {
      // support gone: fall out of the hole
      e.stuckT = -1;
      e.vel = { x: e.vel.x * 0.5, y: 0, z: e.vel.z * 0.5 };
      return;
    }
    const rest = e.mesh.userData.rest as THREE.Quaternion | undefined;
    if (rest) {
      e.mesh.quaternion.copy(rest);
      if (e.stuckT < 0.4) {
        // damped quiver about the shaft's pivot
        const k = (1 - e.stuckT / 0.4);
        e.mesh.rotateX(Math.sin(e.stuckT * 70) * 0.12 * k);
        e.mesh.rotateY(Math.cos(e.stuckT * 55) * 0.06 * k);
      }
    }
    const p = this.player;
    if (e.owner === 'player' && p && !p.dead &&
      Math.abs(p.pos.x - e.pos.x) < 1.1 && Math.abs(p.pos.z - e.pos.z) < 1.1 &&
      e.pos.y > p.pos.y - 0.6 && e.pos.y < p.pos.y + 2.2) {
      e.dead = true;
      this.spawnDrop(p.pos.x, p.pos.y + 0.5, p.pos.z, I.ARROW, 1);
      return;
    }
    // vanilla despawns grounded arrows after a minute
    if (e.stuckT > (e.owner === 'player' ? 60 : 20)) e.dead = true;
  }

  private updateTnt(e: Entity, dt: number): void {
    e.vel.y -= GRAVITY * dt;
    e.vel.x *= 1 - Math.min(1, 4 * dt);
    e.vel.z *= 1 - Math.min(1, 4 * dt);
    moveEntity(this.world, e.pos, e.vel, dt, e.box);
    e.fuseT -= dt;
    const flash = Math.sin(e.age * 16) > 0;
    for (const m of e.materials) m.emissive.setScalar(flash ? 0.7 : 0);
    const pulse = 1 + Math.max(0, 0.5 - e.fuseT) * 0.25;
    e.mesh.scale.setScalar(pulse);
    e.mesh.position.set(e.pos.x, e.pos.y + 0.48, e.pos.z);
    if (e.fuseT <= 0) {
      e.dead = true;
      this.explode(e.pos.x, e.pos.y + 0.5, e.pos.z, 3.2, 'Blown up by TNT');
    }
  }

  private updateFalling(e: Entity, dt: number): void {
    e.vel.y -= GRAVITY * dt;
    const res = moveEntity(this.world, e.pos, e.vel, dt, e.box);
    e.mesh.position.set(e.pos.x, e.pos.y + 0.49, e.pos.z);
    if (res.onGround) {
      e.dead = true;
      const bx = Math.floor(e.pos.x), by = Math.floor(e.pos.y + 0.01), bz = Math.floor(e.pos.z);
      const cur = this.world.getBlock(bx, by, bz);
      if (cur === B.AIR || cur === B.WATER) this.world.setBlock(bx, by, bz, e.itemId);
      else this.spawnDrop(bx + 0.5, by + 0.5, bz + 0.5, e.itemId, 1);
    }
    if (e.pos.y < -8) e.dead = true;
  }

  private updateParticle(e: Entity, dt: number, camQ: THREE.Quaternion): void {
    e.life -= dt;
    if (e.life <= 0) { e.dead = true; return; }
    e.vel.y -= e.pGrav * dt;
    e.vel.x *= 1 - Math.min(1, 3 * dt);
    e.vel.z *= 1 - Math.min(1, 3 * dt);
    moveEntity(this.world, e.pos, e.vel, dt, e.box);
    e.mesh.position.set(e.pos.x, e.pos.y, e.pos.z);
    e.mesh.quaternion.copy(camQ);
    const s = Math.min(1, e.life / (e.maxLife * 0.5));
    e.mesh.scale.setScalar(Math.max(0.05, s));
  }

  private updateMob(e: Entity, dt: number): void {
    const p = this.player!;
    e.attackCooldown = Math.max(0, e.attackCooldown - dt);
    e.hurtFlash = Math.max(0, e.hurtFlash - dt);
    e.angryT = Math.max(0, e.angryT - dt);
    e.swingT = Math.max(0, e.swingT - dt);

    // captured flyers escort their owner instead of hunting them
    if ((e.kind === 'phantom' || e.kind === 'emberghast' || e.kind === 'blaze') && this.isPet(e)) {
      this.updateFlyingPet(e, dt);
      return;
    }
    // phantom: flying mob, circles + swoops the player
    if (e.kind === 'phantom') { this.updatePhantom(e, dt); return; }
    // emberghast: floats at range and spits fireballs
    if (e.kind === 'emberghast') { this.updateEmberghast(e, dt); return; }
    if (e.kind === 'bat') { this.updateBat(e, dt); return; }
    // blaze: hovers, spins its rods and looses fireball volleys
    if (e.kind === 'blaze') { this.updateBlaze(e, dt); return; }
    // a ridden horse is driven by the player (see Player.updateRiding)
    if (e.ridden) return;

    this.tintMob(e);
    // nether mobs trail a few embers while hunting the player
    if ((e.kind === 'cinderling' || e.kind === 'ashstalker') && e.state === 'chase' && Math.random() < 0.18) {
      this.spawnFirefly(e.pos.x + (Math.random() - 0.5) * 0.4, e.pos.y + e.box.h * 0.5, e.pos.z + (Math.random() - 0.5) * 0.4);
    }

    // steering by state
    let wishX = 0, wishZ = 0;
    const distToPlayer = Math.hypot(p.pos.x - e.pos.x, p.pos.z - e.pos.z);

    // tamed wolf/cat + captured pets: follow the owner (sit = stay put)
    const petFollow = (e.kind === 'wolf' || e.kind === 'cat') ? e.tamed : this.isPet(e);
    if (petFollow) {
      if (this.isPet(e)) this.retargetPet(e);
      // a pet with a live (wild) target chases it instead of sticking to the owner
      if (this.isPet(e) && e.target && !e.target.dead && this.isMob(e.target)
        && !e.target.tamed && !e.sitting) {
        this.petChase(e, dt);
        if (e.kind === 'magma_cube' && this.magmaHop(e, dt, true)) { e._wishX = 0; e._wishZ = 0; }
        const res2 = this.applyGroundMove(e, dt, e._wishX, e._wishZ, e.moveSpeed * 1.6);
        if ((res2.hitX || res2.hitZ) && e.onGround && (e._wishX !== 0 || e._wishZ !== 0)) e.vel.y = JUMP_V;
        this.animateMob(e, dt, p);
        this.placeMob(e, dt);
        return;
      }
      if (e.sitting) {
        wishX = 0; wishZ = 0;
      } else if (distToPlayer > 24) {
        // teleport to the owner if left far behind (MC pet behavior)
        e.pos.x = p.pos.x + (Math.random() - 0.5) * 2;
        e.pos.z = p.pos.z + (Math.random() - 0.5) * 2;
        e.pos.y = p.pos.y;
      } else if (distToPlayer > 2.6) {
        const dx = p.pos.x - e.pos.x, dz = p.pos.z - e.pos.z;
        const d = Math.hypot(dx, dz) || 1;
        wishX = dx / d; wishZ = dz / d;
        e.yaw = Math.atan2(-dx, -dz);
      }
      if (e.kind === 'wolf') this.wWolfCombat(e, dt); // cats don't fight
      else if (this.isPet(e)) this.petCombat(e, dt);
      const fspeed = e.moveSpeed * (distToPlayer > 8 ? 2.2 : 1);
      if (e.kind === 'magma_cube' && (wishX !== 0 || wishZ !== 0) && this.magmaHop(e, dt, false)) { wishX = 0; wishZ = 0; }
      const res = this.applyGroundMove(e, dt, wishX, wishZ, fspeed);
      if ((res.hitX || res.hitZ) && e.onGround && (wishX !== 0 || wishZ !== 0)) e.vel.y = JUMP_V;
      this.animateMob(e, dt, p);
      this.placeMob(e, dt, e.sitting ? -0.12 * e.mesh.scale.y : 0);
      return;
    }

    // Lure: while the player holds this animal's food it turns to face them and
    // trots over (an untamed dog tempted by a bone, a cat by fish, cows/sheep by
    // wheat, pigs by carrots, chickens by seed). Overrides the idle wander.
    let lured = false;
    if (e.state !== 'flee' && e.state !== 'chase' && !p.dead
      && this.isLureFood(e.kind as MobKind, p.heldId()) && distToPlayer < 10) {
      lured = true;
      e.grazeT = 0; // food beats grass
      const dx = p.pos.x - e.pos.x, dz = p.pos.z - e.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      e.yaw = Math.atan2(-dx, -dz); // look at the player
      if (distToPlayer > 2.2) { wishX = dx / d; wishZ = dz / d; }
    }

    // a hostile trading blows with a pet chases the pet instead of the player
    const foe = e.foe && !e.foe.dead ? e.foe : null;
    const qx = foe ? foe.pos.x : p.pos.x, qz = foe ? foe.pos.z : p.pos.z;
    const qy = foe ? foe.pos.y : p.pos.y;

    if (lured) {
      // steering handled above
    } else if (e.state === 'wander' || e.state === 'flee') {
      wishX = -Math.sin(e.yaw);
      wishZ = -Math.cos(e.yaw);
      // wandering animals shy away from cliff edges, water and lava instead of
      // strolling off them; a turn-and-pause reads as the mob noticing the drop
      if (e.state === 'wander' && e.onGround && !inWater(this.world, e.pos, e.box)
        && this.hazardAhead(e, wishX, wishZ)) {
        wishX = 0; wishZ = 0;
        e.state = 'idle';
        e.stateTime = 0.6 + Math.random() * 1.2;
        e.yaw += Math.PI * (0.6 + Math.random() * 0.8);
      }
    } else if (e.state === 'chase') {
      const dx = qx - e.pos.x, dz = qz - e.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      let dir = 1;
      if (e.kind === 'skeleton') {
        // keep bow range: retreat when close, hold at mid range
        if (d < 6) dir = -1;
        else if (d < 13) dir = 0;
      } else if (e.kind === 'piglin' && (e.variant & 1)) {
        // crossbow piglins hold a firing line a little closer in
        if (d < 4) dir = -1;
        else if (d < 9) dir = 0;
      }
      wishX = (dx / d) * dir;
      wishZ = (dz / d) * dir;
      e.yaw = Math.atan2(-(dx / d), -(dz / d));
    } else if (e.state === 'fuse') {
      // creeper stands its ground while hissing
      const dx = qx - e.pos.x, dz = qz - e.pos.z;
      e.yaw = Math.atan2(-dx, -dz);
      e.fuseT -= dt;
      if (Math.hypot(dx, dz) > 5) {
        e.state = 'chase'; // quarry escaped: cancel
      } else if (e.fuseT <= 0) {
        e.dead = true;
        this.explode(e.pos.x, e.pos.y + 0.6, e.pos.z, 2.6, 'Blown up by a Creeper');
        return;
      }
    }
    // a grazing sheep stands still with its head in the grass; an admiring
    // piglin stands turning its gold over
    if (e.grazeT > 0 || e.admireT > 0) { wishX = 0; wishZ = 0; }

    const angryWolf = e.kind === 'wolf' && e.angryT > 0 && e.state === 'chase';
    let speed = lured ? e.moveSpeed * 1.4
      : e.state === 'flee' ? e.moveSpeed * 2.2 : angryWolf ? e.moveSpeed * 2.4 : e.moveSpeed;
    // nether gaits: provoked zombified piglins and hunting hoglins charge;
    // a strider off the lava shuffles; magma cubes cover ground mid-leap
    if (e.state === 'chase' && (e.kind === 'zombified_piglin' || e.kind === 'hoglin')) speed *= 1.35;
    if (e.kind === 'strider' && e.cold) speed *= 0.5;
    if (e.kind === 'magma_cube') {
      speed *= 1 + (MAGMA_SIZES[e.variant] ?? 1) * 0.15;
      if ((wishX !== 0 || wishZ !== 0) && this.magmaHop(e, dt, e.state === 'chase')) { wishX = 0; wishZ = 0; }
    }
    // rabbits bound: they only cover ground mid-hop, pausing between leaps
    if (e.kind === 'rabbit' && (wishX !== 0 || wishZ !== 0)) {
      e.shootCooldown -= dt;
      if (e.onGround) {
        if (e.shootCooldown <= 0) {
          e.vel.y = e.state === 'flee' ? 6.2 : 5.2;
          e.shootCooldown = e.state === 'flee' ? 0.05 : 0.25 + Math.random() * 0.35;
        } else { wishX = 0; wishZ = 0; }
      }
    }
    const airborne = !e.onGround;
    const res = this.applyGroundMove(e, dt, wishX, wishZ, speed);
    // a magma cube lands with a squash and a wet slap
    if (e.kind === 'magma_cube') {
      e.chargeT = Math.max(0, e.chargeT - dt);
      if (airborne && e.onGround) {
        e.chargeT = 0.28;
        const d = Math.hypot(p.pos.x - e.pos.x, p.pos.z - e.pos.z);
        if (d < 20) this.audio.mobSound('magma_cube', (1 - d / 20) * 0.8, 'idle');
      }
    }
    // hop single-block barriers; spiders just climb straight up walls
    if ((res.hitX || res.hitZ) && (wishX !== 0 || wishZ !== 0)) {
      if (e.kind === 'spider') e.vel.y = Math.max(e.vel.y, 3.2);
      else if (e.onGround) e.vel.y = JUMP_V;
    }
    // chickens flutter down instead of dropping like a stone
    if (e.kind === 'chicken' && !e.onGround && e.vel.y < -2.2) e.vel.y = -2.2;

    // melee contact attacks — on the pet it is fighting, else on the player
    // (crossbow piglins shoot instead; babies only play)
    const shooter = e.kind === 'piglin' && (e.variant & 1) !== 0;
    if ((MELEE_MOBS.has(e.kind as MobKind) || angryWolf) && !shooter && !e.baby && e.attackCooldown <= 0 && e.state === 'chase'
      && (foe || !p.dead)) {
      const dx = qx - e.pos.x, dz = qz - e.pos.z;
      const dy = qy - e.pos.y;
      let [dmg, reach, cd] = MELEE[e.kind as MobKind] ?? [3, 1.1, 1];
      if (e.kind === 'magma_cube') {
        // cube size sets both its reach and its bite
        const sz = MAGMA_SIZES[e.variant] ?? 1;
        dmg = sz === 1 ? 3 : sz === 2 ? 4 : 6; reach = e.box.w * 0.5 + 0.55; cd = 0.8;
      }
      if (Math.hypot(dx, dz) < reach + (foe ? foe.box.w * 0.5 : 0) && Math.abs(dy) < 2) {
        e.attackCooldown = cd;
        e.swingT = e.kind === 'hoglin' ? 0.45 : 0.3;
        if (foe) {
          this.hurt(foe, dmg, dx, dz, e);
        } else if (p.mode === 'survival') {
          p.damage(dmg, e, `Slain by ${mobLabel(e.kind as string)}`);
          p.applyKnockback(dx, dz, e.kind === 'ashstalker' ? 7 : e.kind === 'hoglin' ? 11 : 5);
          // a hoglin tosses you skyward with its tusks; wither skeletons wither
          if (e.kind === 'hoglin') p.vel.y = Math.max(p.vel.y, 9.5);
          if (e.kind === 'wither_skeleton') this.witherT = Math.max(this.witherT, 10);
        }
        if (e.kind === 'hoglin' || e.kind === 'piglin' || e.kind === 'zombified_piglin') {
          this.audio.mobSound(e.kind, 0.7, 'idle');
        }
      }
    }
    // creeper trigger (a creeper mobbed by pets blows up on them just the same)
    const fuseDist = foe ? Math.hypot(foe.pos.x - e.pos.x, foe.pos.z - e.pos.z) : distToPlayer;
    if (e.kind === 'creeper' && e.state === 'chase' && fuseDist < 2.6
      && (foe || (!p.dead && p.mode === 'survival'))) {
      e.state = 'fuse';
      e.fuseT = 1.5;
      this.audio.play('fuse');
      this.spawnSmoke(e.pos.x, e.pos.y + e.box.h, e.pos.z, 4);
    }

    // animation
    this.animateMob(e, dt, p);
    this.placeMob(e, dt);
  }

  /** Colour state for a ground mob: red hurt flash, burning flicker, creeper
   *  fuse strobe, and the nether mobs' ember smoulder. */
  private tintMob(e: Entity): void {
    const hurt = e.hurtFlash > 0;
    let er = hurt ? 0.2 : 0, eg = 0, eb = 0;
    if (!hurt && e.burnT > 0) {
      const f = 0.07 + Math.random() * 0.08; // a flicker; the flames carry the look
      er = f; eg = f * 0.45;
    }
    if (e.kind === 'creeper' && e.state === 'fuse' && Math.sin(e.age * 22) > 0) {
      er = 0.8; eg = 0.8; eb = 0.8;
    }
    // nether mobs smoulder: bright ember accents over a dark charred hide. The
    // hide glows only faintly so it stays recognizably charcoal instead of washing
    // the whole mob to flat lava-orange (ember materials are tagged at build time).
    const netherGlow = (e.kind === 'cinderling' || e.kind === 'ashstalker') && !hurt;
    if (netherGlow) {
      const pulse = 0.34 + 0.14 * Math.sin(e.age * 4 + (e.kind === 'ashstalker' ? 1 : 0));
      er = pulse; eg = pulse * 0.4; eb = 0.02;
    }
    // molten mobs: a blaze burns bright (brighter still while charging a
    // volley); a magma cube's cracks throb and its core blazes
    let ember = -1;
    if (!hurt && e.kind === 'blaze') ember = 0.3 + 0.06 * Math.sin(e.age * 7) + (e.chargeT > 0 || e.burst > 0 ? 0.3 : 0);
    if (!hurt && e.kind === 'magma_cube') ember = 0.05 + 0.025 * Math.sin(e.age * 3.2 + e.variant);
    // hurt = vanilla's red overlay: tint the albedo as well as glowing a little
    const gb = hurt ? MOB_EXPOSURE * 0.5 : MOB_EXPOSURE;
    for (const m of e.materials) {
      m.color.setRGB(MOB_EXPOSURE, gb, gb);
      if (ember >= 0) {
        const k = m.userData.ember ? (m.userData.core ? Math.min(1, ember * 14) : ember) : 0.03;
        m.emissive.setRGB(k, k * (m.userData.core ? 0.55 : 0.42), k * 0.05);
      } else if (netherGlow && !m.userData.ember) m.emissive.setRGB(er * 0.22, eg * 0.22, eb);
      else m.emissive.setRGB(er, eg, eb);
    }
  }

  /** Push a ground mob's transform to its mesh: the shown body yaw eases toward
   *  the AI's (so turns read as turns, not snaps) and a fresh hit tips the mob
   *  away from the blow while the red flash lasts. */
  private placeMob(e: Entity, dt: number, yOff = 0): void {
    let d = e.yaw - e.visYaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const rate = e.state === 'chase' || e.state === 'flee' || e.ridden ? 14 : 7;
    e.visYaw += d * Math.min(1, rate * dt);
    const m = e.mesh;
    m.position.set(e.pos.x, e.pos.y + yOff, e.pos.z);
    m.rotation.y = e.visYaw;
    const k = e.hurtFlash > 0 ? (e.hurtFlash / 0.35) * 0.32 : 0;
    // knockback direction in the mob's own frame (forward = -z)
    const c = Math.cos(e.visYaw), s = Math.sin(e.visYaw);
    const lx = e.kbX * c - e.kbZ * s, lz = e.kbX * s + e.kbZ * c;
    m.rotation.x = lz * k;
    m.rotation.z = -lx * k;
    // a piglin stranded out of the Nether trembles as it zombifies
    if (e.convertT > 0) m.rotation.z += Math.sin(e.age * 47) * 0.05 * Math.min(1, e.convertT / 3);
    // airborne: the shadow stays on the ground below and fades with height
    const sh = e.shadow;
    if (sh) {
      let drop = 0;
      if (!e.onGround) {
        const x = Math.floor(e.pos.x), z = Math.floor(e.pos.z);
        let y = Math.floor(e.pos.y);
        while (drop < 6 && !this.world.isSolidAt(x, y - 1, z)) { y--; drop++; }
        drop = Math.min(6, e.pos.y - y);
      }
      sh.position.y = 0.02 - drop / m.scale.y;
      (sh.material as THREE.MeshBasicMaterial).opacity = 0.5 * Math.max(0, 1 - drop / 6);
    }
  }

  /** Would a wandering mob stepping along (dx,dz) walk off a >3-block drop, or
   *  into water, lava or a cactus? Walls are fine (it hops or bumps them). */
  private hazardAhead(e: Entity, dx: number, dz: number): boolean {
    const reach = e.box.w * 0.5 + 0.4;
    const x = Math.floor(e.pos.x + dx * reach), z = Math.floor(e.pos.z + dz * reach);
    const y = Math.floor(e.pos.y + 0.05);
    for (let dy = 0; dy >= -4; dy--) {
      const id = this.world.getBlock(x, y + dy, z);
      if (id === B.LAVA && e.kind === 'strider') return dy < -3; // lava is a strider's floor
      if (id === B.WATER || id === B.LAVA || id === B.CACTUS) return true;
      if (id !== B.AIR && hasDef(id) && def(id).solid) return dy < -3; // floor found
    }
    return true;
  }

  /** Shared ground-movement integration (gravity, water buoyancy, collision,
   *  barrier hop). Returns the collision result for caller-specific hops. */
  private applyGroundMove(e: Entity, dt: number, wishX: number, wishZ: number, speed: number): MoveResult {
    const swimming = inWater(this.world, e.pos, e.box);
    const blend = Math.min(1, (e.onGround ? 10 : 3) * dt);
    e.vel.x += (wishX * speed - e.vel.x) * blend;
    e.vel.z += (wishZ * speed - e.vel.z) * blend;
    if (swimming) {
      e.vel.y += (1.8 - e.vel.y) * Math.min(1, 4 * dt);
    } else {
      e.vel.y -= GRAVITY * dt;
      if (e.vel.y < -70) e.vel.y = -70;
    }
    const res = moveEntity(this.world, e.pos, e.vel, dt, e.box);
    // striders walk on lava: its surface is a floor, and one that sank bobs up
    if (e.kind === 'strider') {
      const x = Math.floor(e.pos.x), z = Math.floor(e.pos.z), fy = Math.floor(e.pos.y - 0.02);
      if (this.world.getBlock(x, fy, z) === B.LAVA) {
        if (this.world.getBlock(x, fy + 1, z) === B.LAVA) e.vel.y = Math.max(e.vel.y, 4);
        else if (e.vel.y <= 0) { e.pos.y = fy + 1; e.vel.y = 0; res.onGround = true; }
      }
    }
    e.onGround = res.onGround;
    return res;
  }

  /** Magma cubes (like slimes) only cover ground in leaps: sit, then spring
   *  (higher when hunting, bigger cubes higher still). Returns true while it
   *  is sitting between hops (the caller zeroes its steering). */
  private magmaHop(e: Entity, dt: number, hunting: boolean): boolean {
    e.shootCooldown -= dt;
    if (!e.onGround) return false;
    if (e.shootCooldown > 0) return true;
    const sz = MAGMA_SIZES[e.variant] ?? 1;
    e.vel.y = hunting ? 8.5 + sz * 1.2 : 6.5 + sz * 0.4;
    e.shootCooldown = hunting ? 0.5 + Math.random() * 0.6 : 1.2 + Math.random() * 1.6;
    return false;
  }

  /** Shared mob animation: stride-matched walk cycle, head tracking + idle
   *  glances, blinking, tails/ears/wings, grazing, creeper swell. */
  private animateMob(e: Entity, dt: number, p: Player): void {
    const limbs = e.limbs;
    if (!limbs) return;
    const hSpeed = Math.hypot(e.vel.x, e.vel.z);
    const L = limbs.legs;
    const sitting = (e.kind === 'wolf' || e.kind === 'cat') && e.sitting;

    if (limbs.collar) limbs.collar.visible = e.tamed;
    if (limbs.wool) for (const w of limbs.wool) w.visible = !e.sheared;

    // blink: eyes shut for ~0.14 s every few seconds
    if (limbs.faces) {
      e.blinkT -= dt;
      if (e.blinkT < -0.14) e.blinkT = 2 + Math.random() * 4.5;
      const shut = e.blinkT < 0;
      const angry = e.angryT > 0 && e.state === 'chase';
      for (const f of limbs.faces) {
        const want = angry && f.angry ? f.angry : shut ? f.closed : f.open;
        if (f.mat.map !== want) f.mat.map = want;
      }
    }

    // stride: the leg phase advances with ground covered (short legs step
    // faster), and the swing amplitude eases with speed so legs settle
    const ref = Math.max(0.8, e.moveSpeed * 0.9);
    const target = e.onGround || e.kind === 'spider' ? Math.min(1, hSpeed / ref) : e.limbAmt * 0.9;
    e.limbAmt += (target - e.limbAmt) * Math.min(1, 8 * dt);
    e.walkCycle += hSpeed * dt * (1.9 / limbs.legLen);
    const maxSwing = e.kind === 'chicken' ? 1.0 : L.length === 2 ? 0.75 : 0.65;
    const swing = Math.sin(e.walkCycle) * e.limbAmt * maxSwing;

    if (sitting) {
      // fold the rear legs, keep the front legs planted
      if (L[0]) L[0].rotation.x = -0.15;
      if (L[1]) L[1].rotation.x = -0.15;
      if (L[2]) L[2].rotation.x = 1.25;
      if (L[3]) L[3].rotation.x = 1.25;
    } else if (e.kind === 'spider') {
      // vanilla spider gait: legs sweep fore/aft in yaw and lift in roll,
      // alternating pairs down each side
      for (let i = 0; i < L.length; i++) {
        const lg = L[i];
        const side = lg.userData.side as number;
        const ph = e.walkCycle * 1.4 + ((i >> 1) % 2 ? Math.PI : 0) + (side > 0 ? Math.PI : 0);
        lg.rotation.y = (lg.userData.baseY as number) + Math.sin(ph) * 0.38 * e.limbAmt;
        lg.rotation.z = (lg.userData.baseZ as number) + side * Math.max(0, Math.cos(ph)) * 0.35 * e.limbAmt;
      }
    } else if (e.kind === 'rabbit') {
      // mid-hop the hind feet kick out behind and the forepaws reach ahead
      const air = e.onGround ? 0 : Math.max(-1, Math.min(1, e.vel.y / 5));
      const k = Math.min(1, 14 * dt);
      const hind = e.onGround ? 0 : 0.9 - air * 0.4, fore = e.onGround ? 0 : -0.7;
      L[0].rotation.x += (fore - L[0].rotation.x) * k; L[1].rotation.x = L[0].rotation.x;
      L[2].rotation.x += (hind - L[2].rotation.x) * k; L[3].rotation.x = L[2].rotation.x;
    } else {
      for (let i = 0; i < L.length; i++) L[i].rotation.x = i % 2 === 0 ? swing : -swing;
    }

    if (limbs.arms) {
      // zombies stalk with arms out (+π/2 points them where the face looks) and
      // lunge them down on a hit; skeletons raise the bow only while aiming
      const aiming = e.kind === 'skeleton' && e.state === 'chase';
      const lunge = e.kind === 'zombie' ? Math.max(0, e.attackCooldown - 0.7) / 0.3 : 0;
      // nether bipeds: arms 1 (right) wields, 0 (left) holds the admired gold
      const armed = e.kind === 'piglin' || e.kind === 'zombified_piglin' || e.kind === 'wither_skeleton';
      const xbow = e.kind === 'piglin' && (e.variant & 1) !== 0;
      const slash = e.swingT > 0 ? Math.sin((1 - e.swingT / 0.3) * Math.PI) : 0;
      for (let i = 0; i < limbs.arms.length; i++) {
        const arm = limbs.arms[i];
        let tx: number, ty = 0;
        if (armed) {
          const walk = (i % 2 === 0 ? -swing : swing) * 0.9 + Math.sin(e.age * 1.1 + i * 2) * 0.04;
          const hunting = e.state === 'chase';
          if (e.kind === 'zombified_piglin' && hunting) {
            // a provoked zombified piglin reaches out like any zombie
            tx = Math.PI / 2 - 0.1 + Math.sin(e.age * 1.3 + i) * 0.06;
          } else if (xbow && hunting) {
            // crossbow levelled: the left hand reaches across to steady the stock
            tx = Math.PI / 2 - (i === 0 ? 0.2 : 0);
            ty = i === 0 ? -0.55 : 0.05;
          } else if (i === 0 && e.admireT > 0) {
            // hold the gold up to the snout and turn it over
            tx = 1.15 + Math.sin(e.age * 2.4) * 0.08; ty = -0.45;
          } else {
            tx = walk + (i === 1 && hunting ? 0.45 : 0);
          }
          // a sword chop: raise, then hack down across the body
          if (i === 1 && slash > 0) { tx += slash * 1.3; ty -= slash * 0.35; }
        } else if (e.kind === 'zombie') {
          tx = Math.PI / 2 - 0.08 + Math.sin(e.age * 1.3 + i) * 0.06 - lunge * 0.55;
        } else if (aiming) {
          tx = Math.PI / 2 - (i === 0 ? 0.08 : 0);
          ty = i === 0 ? -0.4 : 0.08; // draw hand crosses in to the string
        } else {
          tx = (i % 2 === 0 ? -swing : swing) * 0.9 + Math.sin(e.age * 1.1 + i * 2) * 0.04;
        }
        const k = Math.min(1, 10 * dt);
        arm.rotation.x += (tx - arm.rotation.x) * k;
        arm.rotation.y += (ty - arm.rotation.y) * k;
        arm.rotation.z = (i === 0 ? 1 : -1) * 0.05;
      }
      // keep the bow upright whether the arm hangs or aims
      if (limbs.bow && limbs.arms[1]) limbs.bow.rotation.x = limbs.arms[1].rotation.x - Math.PI / 2;
      if (limbs.offhand) limbs.offhand.visible = e.admireT > 0;
      // a crossbow shows its bolt once cocked, ready for the next shot
      if (xbow && limbs.weapon) {
        const bolt = limbs.weapon.getObjectByName('bolt');
        if (bolt) bolt.visible = e.state === 'chase' && e.shootCooldown < 1.4;
      }
    }

    // blaze rods: three rings wheel round the core in alternating directions
    // (faster while it charges) and each rod bobs on its own beat
    if (limbs.rods) {
      const fast = e.chargeT > 0 || e.burst > 0 ? 2.6 : 1;
      for (let i = 0; i < limbs.rods.length; i++) {
        const ring = limbs.rods[i];
        ring.rotation.y += dt * (i % 2 ? -1.7 : 1.25) * fast;
        for (let j = 0; j < ring.children.length; j++) {
          ring.children[j].position.y = Math.sin(e.age * 2.6 + j * 1.9 + i * 0.8) * 0.07;
        }
      }
    }
    // magma cube: the slices spring apart mid-leap (the molten core shows
    // between them) and the whole cube squashes on landing
    if (limbs.slices && limbs.body) {
      const u = (MAGMA_SIZES[e.variant] ?? 1) / 16;
      const want = e.onGround ? 0 : Math.min(1.4, 0.3 + Math.abs(e.vel.y) * 0.1) * u;
      const b = limbs.body;
      const gap = (b.userData.gap as number | undefined) ?? 0;
      const g2 = gap + (want - gap) * Math.min(1, 12 * dt);
      b.userData.gap = g2;
      for (let i = 0; i < limbs.slices.length; i++) {
        const sl = limbs.slices[i];
        sl.position.y = (sl.userData.baseY as number) + i * g2;
      }
      const sq = e.chargeT > 0 ? Math.sin((e.chargeT / 0.28) * Math.PI) : 0;
      b.scale.set(1 + sq * 0.22, 1 - sq * 0.3, 1 + sq * 0.22);
    }
    // strider: warm red on lava, purple and shivering off it; bristles waggle
    if (limbs.chill) {
      for (const c of limbs.chill) {
        const want = e.cold ? c.cold : c.warm;
        if (c.mat.map !== want) c.mat.map = want;
      }
      if (limbs.body) limbs.body.rotation.z = e.cold ? Math.sin(e.age * 38) * 0.035 : 0;
    }
    if (limbs.hair) {
      for (let i = 0; i < limbs.hair.length; i++) {
        const h = limbs.hair[i];
        const side = h.userData.side as number;
        const droop = e.cold ? -side * 0.35 : 0;
        h.rotation.z = (h.userData.baseZ as number) + droop
          + side * (Math.sin(e.walkCycle * 1.5 + i) * 0.18 * e.limbAmt + Math.sin(e.age * 2.2 + i * 1.3) * 0.05);
      }
    }

    // chicken wings flap hard while airborne (it flutters down) and give the
    // odd idle ruffle on the ground
    if (limbs.wings) {
      const ruffle = Math.max(0, Math.sin(e.age * 0.9 + e.variant) - 0.97) * 30;
      const a = !e.onGround ? 0.25 + Math.abs(Math.sin(e.age * 26)) * 1.0
        : Math.abs(Math.sin(e.age * 20)) * ruffle * 0.5;
      limbs.wings[0].rotation.z = -a;
      limbs.wings[1].rotation.z = a;
    }

    // Head: hostiles in pursuit lock on; a mob with its food in the player's hand
    // stares at it; otherwise mobs take turns glancing at a nearby player or
    // looking idly around. Pitch and yaw are both eased.
    if (limbs.head) {
      const head = limbs.head;
      const dx = p.pos.x - e.pos.x, dz = p.pos.z - e.pos.z;
      const distH = Math.hypot(dx, dz);
      e.lookT -= dt;
      if (e.lookT <= 0) {
        e.lookT = 1.8 + Math.random() * 3.5;
        e.watching = Math.random() < 0.6;
        const idle = Math.random() < 0.3;
        e.lookYaw = idle ? 0 : (Math.random() - 0.5) * 1.5;
        e.lookPitch = idle ? 0 : (Math.random() - 0.6) * 0.5;
      }
      const aggro = e.state === 'chase' || e.state === 'fuse';
      const tempted = !aggro && this.isLureFood(e.kind as MobKind, p.heldId()) && distH < 10;
      // villagers and pets always meet the eye of a player standing close by
      const close = distH < 4 && (e.kind === 'villager' || e.tamed);
      const watch = !p.dead && !e.ridden && (aggro || tempted || close
        || (e.watching && distH < 8 && e.state !== 'flee' && e.grazeT <= 0));
      let tx = e.lookPitch, ty = e.lookYaw, tz = 0;
      if (hSpeed > 0.5 && !watch) { tx = 0; ty = 0; } // walking: eyes on the path
      if (e.ridden) { tx = -0.3; ty = 0; }             // under a rider: head low, out of the view
      if (watch) {
        const dy = (p.pos.y + 1.6) - (e.pos.y + e.box.h * 0.9);
        tx = Math.atan2(dy, distH) * 0.7;
        ty = Math.atan2(-dx, -dz) - e.visYaw;
        ty = Math.atan2(Math.sin(ty), Math.cos(ty));      // wrap to [-π,π]
        ty = Math.max(-0.8, Math.min(0.8, ty));            // no head-spinning past the shoulder
        // a wolf eyeing a bone cocks its head, begging
        if (e.kind === 'wolf' && tempted) tz = 0.32;
      }
      let drop = 0;
      if (e.grazeT > 0) {
        // munching: nose down in the turf, jaw working
        tx = (e.kind === 'horse' ? -1.7 : -1.05) + Math.sin(e.age * 16) * 0.08; ty = 0;
        drop = e.kind === 'sheep' ? 0.34 : 0;
      } else if (e.kind === 'chicken' && !watch && hSpeed < 0.3 && e.lookYaw === 0) {
        // a chicken with nothing to look at pecks at the ground
        tx = -(Math.max(0, Math.sin(e.age * 7)) ** 3) * 1.1;
      }
      // an admiring piglin studies the gold in its left hand
      if (e.admireT > 0) { tx = -0.55 + Math.sin(e.age * 1.7) * 0.06; ty = 0.3; }
      // a hoglin's attack is an upward head toss
      if (e.kind === 'hoglin' && e.swingT > 0) tx = Math.sin((1 - e.swingT / 0.45) * Math.PI) * 0.95;
      const k = Math.min(1, (watch ? 6 : 3) * dt);
      head.rotation.x += (tx - head.rotation.x) * k;
      head.rotation.y += (ty - head.rotation.y) * k;
      head.rotation.z += (tz - head.rotation.z) * k;
      if (head.userData.baseY === undefined) head.userData.baseY = head.position.y;
      const hy = (head.userData.baseY as number) - drop;
      head.position.y += (hy - head.position.y) * Math.min(1, 6 * dt);
    }

    // sparse ear flicks for wolves/cats — small life-signs while idle
    if (limbs.ears) {
      const f = Math.sin(e.age * 2.3 + e.variant) * Math.sin(e.age * 0.71 + 1.3);
      const tw = Math.max(0, f - 0.82) * 2.4;
      // an angry wolf pins its ears back
      const pin = e.kind === 'wolf' && e.angryT > 0 && e.state === 'chase' ? 0.55 : 0;
      for (const ear of limbs.ears) ear.rotation.x = pin || -tw;
    }
    // tails: a happy tamed wolf wags fast; hanging tails (horse, cat) swish side
    // to side; everything picks up a little of the stride
    if (limbs.tail) {
      const t = limbs.tail;
      if (limbs.tailAxis === 'z') {
        const swish = e.kind === 'horse'
          ? Math.sin(e.age * 1.6) * 0.1 + Math.max(0, Math.sin(e.age * 0.45) - 0.9) * 4 * Math.sin(e.age * 14)
          : Math.sin(e.age * 2.1) * (sitting ? 0.08 : 0.18);
        t.rotation.z = swish + swing * 0.2;
      } else {
        let amp = 0.22, rate = 3.5;
        if (e.kind === 'wolf' && e.tamed) { amp = 0.6; rate = 14; }
        t.rotation.y = Math.sin(e.age * rate) * amp * (sitting ? 0.3 : 1) + swing * 0.35;
      }
      // a wolf's tail height shows its mood: tamed ones carry it high, lower
      // as they get hurt (vanilla's health gauge); wild ones keep it low
      if (e.kind === 'wolf') {
        const hpF = Math.max(0, Math.min(1, e.hp / MOB_STATS.wolf.hp));
        const raised = sitting ? 1.2 : e.tamed ? 0.9 - hpF * 1.3 : e.angryT > 0 ? -0.5 : 0.9;
        t.rotation.x += (raised - t.rotation.x) * Math.min(1, 4 * dt);
      }
    }
    // idle breathing: subtle body bob that fades out once moving. Bob *around*
    // the body's rest height — an absolute set slammed bodies whose limb sits at
    // its true height (wolf/cinderling/ashstalker) down onto the feet.
    if (limbs.body) {
      const b = limbs.body;
      if (b.userData.baseY === undefined) b.userData.baseY = b.position.y;
      b.position.y = (b.userData.baseY as number) + (sitting ? 0 : Math.sin(e.age * 2.2) * 0.015 * Math.max(0, 1 - hSpeed));
    }
    // creeper swell: puffs out (and trembles) as the fuse burns down
    if (e.kind === 'creeper') {
      const f = e.state === 'fuse' ? Math.max(0, Math.min(1, 1 - e.fuseT / 1.5)) : 0;
      const wob = 1 + Math.sin(f * 100) * f * 0.01;
      const sx = (1 + f * 0.4) * wob, sy = (1 + f * 0.1) / wob;
      e.mesh.scale.set(sx, sy, sx);
    }
  }

  /** In love mode: find a nearby same-kind mate, spawn a baby, set cooldowns. */
  private tryBreed(e: Entity): void {
    if (e.loveT <= 0) return;
    for (const m of this.entities) {
      if (m === e || m.kind !== e.kind || m.baby || m.loveT <= 0) continue;
      const dx = m.pos.x - e.pos.x, dz = m.pos.z - e.pos.z;
      if (dx * dx + dz * dz > 6.25) continue; // within 2.5 blocks
      e.loveT = 0; m.loveT = 0;
      e.breedCooldown = 60; m.breedCooldown = 60;
      const bx = (e.pos.x + m.pos.x) / 2, bz = (e.pos.z + m.pos.z) / 2;
      const by = Math.max(e.pos.y, m.pos.y);
      const baby = this.spawnBaby(e.kind as MobKind, bx, by, bz);
      if (e.tamed && m.tamed) { baby.tamed = true; baby.ownerName = 'player'; }
      this.spawnHearts(bx, by + 0.4, bz);
      this.audio.play('pop');
      this.audio.mobSound(e.kind as string, 0.8);
      return;
    }
  }

  /** Tamed wolf: bite nearby hostile mobs. */
  private wWolfCombat(e: Entity, dt: number): void {
    e.attackCooldown = Math.max(0, e.attackCooldown - dt);
    if (e.attackCooldown > 0 || e.sitting) return;
    for (const m of this.entities) {
      if (m === e || !this.isMob(m) || m.dead || m.tamed) continue; // never the owner's own
      const stats = MOB_STATS[m.kind as MobKind];
      if (!stats.hostile) continue;
      const dx = m.pos.x - e.pos.x, dz = m.pos.z - e.pos.z;
      const dy = m.pos.y - e.pos.y;
      if (Math.hypot(dx, dz) < 1.5 && Math.abs(dy) < 1.5) {
        e.attackCooldown = 0.6;
        this.hurt(m, 4, dx, dz);
        return;
      }
    }
  }

  /** Per-pet melee damage (reuses the wild-mob contact-damage table). */
  private petDamage(kind: MobKind): number {
    if (kind === 'spider') return 2;
    if (kind === 'cinderling') return 2;
    if (kind === 'ashstalker') return 4;
    if (kind === 'phantom') return 3;
    if (kind === 'emberghast') return 4;
    if (kind === 'hoglin') return 6;
    if (kind === 'piglin' || kind === 'zombified_piglin' || kind === 'wither_skeleton') return 5;
    if (kind === 'magma_cube') return 4;
    return 3;
  }

  /** Keep a pet's quarry sane: forget dead/captured/far-away targets so it
   *  trots back to the owner, and fight back at whatever picked a fight. */
  private retargetPet(e: Entity): void {
    const p = this.player!;
    const t = e.target;
    if (t) {
      const strayed = Math.hypot(t.pos.x - p.pos.x, t.pos.z - p.pos.z) > 22;
      if (t.dead || !this.isMob(t) || t.tamed || strayed) e.target = null;
    }
    // a wild mob that singled this pet out is fair game even if the owner
    // hasn't swung yet (it is already being attacked)
    if (!e.target) {
      for (const m of this.entities) {
        if (m.foe === e && !m.dead && this.isMob(m)) { e.target = m; break; }
      }
    }
  }

  /** A captured phantom / emberghast: escorts the owner overhead, dives (or
   *  lobs fireballs) at its locked target, and never turns on the owner. */
  private updateFlyingPet(e: Entity, dt: number): void {
    const p = this.player!;
    this.retargetPet(e);
    const t = e.sitting ? null : e.target;
    e.attackCooldown = Math.max(0, e.attackCooldown - dt);
    for (const m of e.materials) m.emissive.setRGB(e.hurtFlash > 0 ? 0.55 : 0.06, 0.02, 0.01);

    // escort slot: hover above and slightly behind the owner; in combat, close
    // on the target (the ghast keeps a shooting stand-off)
    const standoff = e.kind === 'emberghast' ? 6 : e.kind === 'blaze' ? 4.5 : 0.8;
    const ax = t ? t.pos.x : p.pos.x, az = t ? t.pos.z : p.pos.z;
    const ay = t ? t.pos.y + t.box.h * 0.6 + 1.2 : p.pos.y + 3.4 + Math.sin(e.age * 1.2) * 0.4;
    const dx = ax - e.pos.x, dz = az - e.pos.z;
    const distH = Math.hypot(dx, dz) || 1;
    // approach until `want` blocks out, then hold station
    const want = t ? standoff : 2.2;
    const radial = distH > want + 1 ? 1 : distH < want - 1 ? -1 : 0;
    const speed = e.moveSpeed * (t ? 1.4 : 1.1);
    const wishX = (dx / distH) * radial, wishZ = (dz / distH) * radial;
    e.vel.x += (wishX * speed - e.vel.x) * Math.min(1, 3 * dt);
    e.vel.z += (wishZ * speed - e.vel.z) * Math.min(1, 3 * dt);
    e.vel.y += ((ay - e.pos.y) * 0.9 - e.vel.y) * Math.min(1, 2 * dt);
    if (Math.hypot(p.pos.x - e.pos.x, p.pos.z - e.pos.z) > 26) {
      e.pos.x = p.pos.x + (Math.random() - 0.5) * 2;   // left behind: catch up
      e.pos.z = p.pos.z + (Math.random() - 0.5) * 2;
      e.pos.y = p.pos.y + 3;
    }
    e.pos.x += e.vel.x * dt;
    e.pos.y += e.vel.y * dt;
    e.pos.z += e.vel.z * dt;
    e.yaw = Math.atan2(-dx, -dz);

    if (t && e.attackCooldown <= 0) {
      if (e.kind === 'blaze' && distH < 14) {
        e.attackCooldown = 1.3;
        this.spawnBlazeCharge(e.pos.x, e.pos.y + 1.2, e.pos.z,
          t.pos.x - e.pos.x, (t.pos.y + t.box.h * 0.5) - (e.pos.y + 1.2), t.pos.z - e.pos.z, 'petghast');
      } else if (e.kind === 'emberghast' && distH < 16) {
        e.attackCooldown = 2.4;
        this.spawnFireball(e.pos.x, e.pos.y, e.pos.z,
          t.pos.x - e.pos.x, (t.pos.y + t.box.h * 0.5) - e.pos.y, t.pos.z - e.pos.z, 'petghast');
      } else if (e.kind === 'phantom' && distH < 1.8
        && Math.abs(t.pos.y + t.box.h * 0.5 - e.pos.y) < 2.2) {
        e.attackCooldown = 1.1;
        this.hurt(t, this.petDamage(e.kind as MobKind), dx, dz, e);
      }
    }
    // wing flap (a blaze spins its rods instead)
    if (e.limbs) {
      for (let i = 0; i < e.limbs.legs.length; i++) {
        e.limbs.legs[i].rotation.z = (i % 2 === 0 ? 1 : -1) * (Math.sin(e.age * 12) * 0.4 - 0.2);
      }
      if (e.limbs.rods) e.limbs.rods.forEach((r, i) => { r.rotation.y += dt * (i % 2 ? -1.7 : 1.25); });
    }
    e.mesh.position.set(e.pos.x, e.pos.y, e.pos.z);
    e.mesh.rotation.y = e.yaw;
  }

  /** Blaze: drifts a couple of blocks off the ground (lower, bobbing, while
   *  idle), closes to a firing range when it has a quarry, and fights in
   *  volleys — a one-second flare-up with smoke, then three small fireballs a
   *  third of a second apart, then a rest. Collides with blocks; wreathed in
   *  embers and smoke. */
  private updateBlaze(e: Entity, dt: number): void {
    const p = this.player!;
    this.tintMob(e);
    const foe = e.foe && !e.foe.dead ? e.foe : null;
    const hunting = e.state === 'chase';
    const tx = foe ? foe.pos.x : p.pos.x, tz = foe ? foe.pos.z : p.pos.z;
    const ty = foe ? foe.pos.y + foe.box.h * 0.5 : p.pos.y + 1.2;
    const dx = tx - e.pos.x, dz = tz - e.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    // floor below (within 8 blocks) to hover over
    const bx = Math.floor(e.pos.x), bz = Math.floor(e.pos.z);
    let ground = Math.floor(e.pos.y);
    for (let i = 0; i < 8 && !this.world.isSolidAt(bx, ground - 1, bz); i++) ground--;
    let wishX = 0, wishZ = 0, wantY: number;
    if (hunting) {
      const radial = d > 10 ? 1 : d < 5 ? -1 : 0;
      const side = Math.sin(e.age * 0.7) * 0.5; // weave sideways
      wishX = (dx / d) * radial - (dz / d) * side;
      wishZ = (dz / d) * radial + (dx / d) * side;
      wantY = Math.max(ground + 1.2, ty + 0.8 + Math.sin(e.age * 1.4) * 0.6);
      e.yaw = Math.atan2(-dx, -dz);
    } else {
      if (e.state === 'wander') { wishX = -Math.sin(e.yaw) * 0.6; wishZ = -Math.cos(e.yaw) * 0.6; }
      wantY = ground + 1.3 + Math.sin(e.age * 1.3) * 0.45;
    }
    const k = Math.min(1, 3 * dt);
    e.vel.x += (wishX * e.moveSpeed - e.vel.x) * k;
    e.vel.z += (wishZ * e.moveSpeed - e.vel.z) * k;
    e.vel.y += ((wantY - e.pos.y) * 1.4 - e.vel.y) * Math.min(1, 2.5 * dt);
    const res = moveEntity(this.world, e.pos, e.vel, dt, e.box);
    e.onGround = res.onGround;
    if ((res.hitX || res.hitZ) && !hunting) e.yaw += Math.PI * (0.5 + Math.random());

    // volley cycle
    const armed = hunting && d < 16 && (foe !== null || (!p.dead && p.mode === 'survival'));
    if (armed) {
      e.shootCooldown -= dt;
      if (e.burst > 0) {
        if (e.shootCooldown <= 0) {
          const ex = e.pos.x, ey = e.pos.y + 1.3, ez = e.pos.z;
          const dist3 = Math.hypot(tx - ex, ty - ey, tz - ez) || 1;
          if (!this.world.raycast(ex, ey, ez, (tx - ex) / dist3, (ty - ey) / dist3, (tz - ez) / dist3, dist3)) {
            const spread = () => (Math.random() - 0.5) * 0.12 * dist3;
            this.spawnBlazeCharge(ex, ey, ez, tx - ex + spread(), ty - ey + spread() * 0.5, tz - ez + spread());
          }
          e.burst--;
          e.shootCooldown = e.burst > 0 ? 0.3 : 3 + Math.random() * 2;
        }
      } else if (e.shootCooldown <= 0 && e.chargeT <= 0) {
        e.chargeT = 1;
        this.audio.mobSound('blaze', Math.max(0.2, 1 - d / 24), 'idle');
      }
      if (e.chargeT > 0) {
        e.chargeT -= dt;
        if (Math.random() < dt * 14) this.spawnSmoke(e.pos.x + (Math.random() - 0.5) * 0.7, e.pos.y + 0.4 + Math.random() * 1.2, e.pos.z + (Math.random() - 0.5) * 0.7, 1);
        if (e.chargeT <= 0) { e.burst = 3; e.shootCooldown = 0; }
      }
      // brushing against a blaze scorches (and ignites)
      if (!foe && e.attackCooldown <= 0 && Math.hypot(p.pos.x - e.pos.x, p.pos.z - e.pos.z) < 0.9
        && Math.abs(p.pos.y - e.pos.y) < 1.6) {
        e.attackCooldown = 1;
        p.damage(4, e, 'Burned by a Blaze');
        p.fireT = Math.max(p.fireT, 4);
        p.applyKnockback(p.pos.x - e.pos.x, p.pos.z - e.pos.z, 4);
      }
    } else {
      e.chargeT = 0; e.burst = 0;
      e.shootCooldown = Math.max(e.shootCooldown, 1);
    }
    // embers + a smoky core
    if (Math.random() < dt * 9) {
      this.spawnTorchFlame(e.pos.x + (Math.random() - 0.5) * 0.8, e.pos.y + 0.2 + Math.random() * 1.2, e.pos.z + (Math.random() - 0.5) * 0.8);
    }
    if (Math.random() < dt * 2) this.spawnSmoke(e.pos.x, e.pos.y + 0.5 + Math.random() * 0.6, e.pos.z, 1);
    this.animateMob(e, dt, p);
    this.placeMob(e, dt);
  }

  /** A blaze's small fireball: flies flat and fast, 5 damage, sets the
   *  player alight on a hit (burst handled by the shared projectile code). */
  spawnBlazeCharge(x: number, y: number, z: number, dx: number, dy: number, dz: number,
    owner: 'emberghast' | 'petghast' = 'emberghast'): void {
    const mesh = new THREE.Group();
    mesh.add(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), new THREE.MeshBasicMaterial({ color: 0xffe070 })));
    mesh.add(new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.34),
      new THREE.MeshBasicMaterial({ color: 0xff7a18, transparent: true, opacity: 0.5 })));
    const len = Math.hypot(dx, dy, dz) || 1;
    const speed = 13;
    const e = new Entity('arrow', { x, y, z }, { w: 0.2, h: 0.2 }, mesh);
    e.vel = { x: (dx / len) * speed, y: (dy / len) * speed, z: (dz / len) * speed };
    e.owner = owner;
    e.dmg = 5;
    this.entities.push(e);
    this.scene.add(mesh);
    const p = this.player;
    const dist = p ? Math.hypot(p.pos.x - x, p.pos.z - z) : 0;
    this.audio.mobSound('blaze_shoot', Math.max(0.15, 1 - dist / 28), 'idle');
  }

  /** The player is withering (a wither skeleton's cut): 1 damage every
   *  2 seconds with dark wisps, until it runs out. */
  private tickWither(): void {
    const p = this.player;
    if (!p || this.witherT <= 0) return;
    if (p.dead) { this.witherT = 0; return; }
    this.witherT -= 0.05;
    this.witherTick += 0.05;
    if (this.witherTick >= 2) {
      this.witherTick = 0;
      if (p.mode === 'survival') p.damage(1, undefined, 'Withered away');
    }
    if (Math.random() < 0.35) {
      this.spriteParticles('wither', (ctx) => {
        ctx.fillStyle = 'rgba(20,16,20,0.9)';
        ctx.fillRect(2, 1, 4, 6); ctx.fillRect(1, 2, 6, 4);
        ctx.fillStyle = 'rgba(60,50,60,0.9)'; ctx.fillRect(2, 2, 2, 2);
      }, 1, p.pos.x + (Math.random() - 0.5) * 0.8, p.pos.y + 0.2 + Math.random(), p.pos.z + (Math.random() - 0.5) * 0.8,
      0.3, 0.2, 0.6, 0.8, -1);
    }
  }

  /** Captured pet: steer toward its locked target and bite when in reach. */
  private petChase(e: Entity, _dt: number): void {
    const t = e.target!;
    const dx = t.pos.x - e.pos.x, dz = t.pos.z - e.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    e._wishX = dx / d; e._wishZ = dz / d;
    e.yaw = Math.atan2(-dx, -dz);
    // bite when close enough (reach matches the wild mob contact range)
    const reach = e.kind === 'spider' ? 1.4 : e.kind === 'ashstalker' ? 1.3 : 1.2;
    if (d < reach && Math.abs(t.pos.y - e.pos.y) < 2 && e.attackCooldown <= 0) {
      e.attackCooldown = e.kind === 'cinderling' ? 0.7 : 1;
      this.hurt(t, this.petDamage(e.kind as MobKind), dx, dz, e);
    }
  }

  /** Captured pet with no target: opportunistically bite adjacent hostiles
   *  that are attacking the owner (kept as a fallback alongside targeting). */
  private petCombat(e: Entity, dt: number): void {
    e.attackCooldown = Math.max(0, e.attackCooldown - dt);
    if (e.attackCooldown > 0 || e.sitting) return;
    if (e.target) return; // handled by petChase when a target is set
    for (const m of this.entities) {
      // skip itself and every other tamed mob: a pet is a hostile *kind*, so
      // without this a released pet chewed on itself (3 dmg/0.7s) until it died
      if (m === e || !this.isMob(m) || m.dead || m.tamed) continue;
      const stats = MOB_STATS[m.kind as MobKind];
      if (!stats.hostile) continue;
      const dx = m.pos.x - e.pos.x, dz = m.pos.z - e.pos.z;
      const dy = m.pos.y - e.pos.y;
      if (Math.hypot(dx, dz) < 1.5 && Math.abs(dy) < 1.5) {
        e.attackCooldown = 0.7;
        this.hurt(m, this.petDamage(e.kind as MobKind), dx, dz, e);
        return;
      }
    }
  }

  /** Phantom: flies in circles above the player and periodically swoops. */
  /** Cave bat: an erratic flutter between nearby open spots, shy of light
   *  and of players, with its wings beating fast. Collides with blocks. */
  private updateBat(e: Entity, dt: number): void {
    const p = this.player!;
    this.tintMob(e);
    e.stateTime -= dt;
    if (e.stateTime <= 0) {
      // pick a new heading: mostly level darts, bias away from a close player
      e.stateTime = 0.4 + Math.random() * 1.1;
      let a = Math.random() * Math.PI * 2;
      const dx = e.pos.x - p.pos.x, dz = e.pos.z - p.pos.z;
      if (Math.hypot(dx, dz) < 4 && Math.random() < 0.7) a = Math.atan2(dz, dx) + (Math.random() - 0.5);
      e._wishX = Math.cos(a);
      e._wishZ = Math.sin(a);
      e.lookPitch = (Math.random() - 0.45) * 2.2; // vertical drift
      const ceil = this.world.isSolidAt(Math.floor(e.pos.x), Math.floor(e.pos.y + 1.2), Math.floor(e.pos.z));
      const floor = this.world.isSolidAt(Math.floor(e.pos.x), Math.floor(e.pos.y - 0.8), Math.floor(e.pos.z));
      if (ceil) e.lookPitch = -Math.abs(e.lookPitch);
      else if (floor) e.lookPitch = Math.abs(e.lookPitch) + 0.5;
    }
    const sp = e.moveSpeed;
    const k = Math.min(1, 4 * dt);
    e.vel.x += (e._wishX * sp - e.vel.x) * k;
    e.vel.z += (e._wishZ * sp - e.vel.z) * k;
    e.vel.y += (e.lookPitch + Math.sin(e.age * 9) * 0.8 - e.vel.y) * k;
    const res = moveEntity(this.world, e.pos, e.vel, dt, e.box);
    if (res.hitX || res.hitZ) e.stateTime = 0; // bounce off walls into a new dart
    e.yaw = Math.atan2(-e.vel.x, -e.vel.z);
    if (e.limbs?.wings) {
      const f = Math.sin(e.age * 34) * 0.9;
      e.limbs.wings[0].rotation.y = f;
      e.limbs.wings[1].rotation.y = -f;
      const t0 = e.limbs.wings[0].children[1], t1 = e.limbs.wings[1].children[1];
      if (t0) t0.rotation.y = f * 0.6;
      if (t1) t1.rotation.y = -f * 0.6;
    }
    if (e.limbs?.faces) {
      e.blinkT -= dt;
      if (e.blinkT < -0.14) e.blinkT = 2 + Math.random() * 4;
      for (const fc of e.limbs.faces) fc.mat.map = e.blinkT < 0 ? fc.closed : fc.open;
    }
    this.placeMob(e, dt);
  }

  private updatePhantom(e: Entity, dt: number): void {
    const p = this.player!;
    this.tintMob(e);
    e.circling += dt;
    const dx = p.pos.x - e.pos.x, dz = p.pos.z - e.pos.z;
    const dy = (p.pos.y + 2) - e.pos.y;
    const distH = Math.hypot(dx, dz);
    // orbit then dive
    const dive = e.circling > 4 && distH < 6;
    const ang = Math.atan2(dz, dx);
    let wishX: number, wishZ: number;
    if (dive) {
      wishX = dx / (distH || 1);
      wishZ = dz / (distH || 1);
      e.vel.y += (dy * 0.6 - e.vel.y) * Math.min(1, 2 * dt);
      if (e.circling > 5.5) e.circling = 0;
    } else {
      // circle: perpendicular to the player direction
      wishX = -Math.sin(ang);
      wishZ = Math.cos(ang);
      // hold altitude ~5 blocks above the player
      e.vel.y += ((p.pos.y + 5 - e.pos.y) * 0.5 - e.vel.y) * Math.min(1, 1.5 * dt);
    }
    const speed = e.moveSpeed;
    e.vel.x += (wishX * speed - e.vel.x) * Math.min(1, 3 * dt);
    e.vel.z += (wishZ * speed - e.vel.z) * Math.min(1, 3 * dt);
    e.yaw = Math.atan2(-wishX, -wishZ);
    // phantoms ignore block collision (they fly) but despawn in daylight
    e.pos.x += e.vel.x * dt;
    e.pos.y += e.vel.y * dt;
    e.pos.z += e.vel.z * dt;
    // contact damage during a dive
    if (dive && distH < 1.4 && Math.abs(dy) < 2 && !p.dead && p.mode === 'survival' && e.attackCooldown <= 0) {
      e.attackCooldown = 1.2;
      p.damage(3, undefined, 'Slain by a Phantom');
      p.applyKnockback(dx, dz, 5);
    }
    e.attackCooldown = Math.max(0, e.attackCooldown - dt);
    // flap animation
    if (e.limbs) {
      for (let i = 0; i < e.limbs.legs.length; i++) {
        e.limbs.legs[i].rotation.z = (i % 2 === 0 ? 1 : -1) * (Math.sin(e.age * 12) * 0.4 - 0.2);
      }
    }
    e.mesh.position.set(e.pos.x, e.pos.y, e.pos.z);
    e.mesh.rotation.y = e.yaw;
  }

  /** Emberghast: hovers above the player at a stand-off range, bobbing, and
   *  lobs slow fireballs on a cooldown. Flies, so it ignores block collision. */
  private updateEmberghast(e: Entity, dt: number): void {
    const p = this.player!;
    e.circling += dt;
    const dx = p.pos.x - e.pos.x, dz = p.pos.z - e.pos.z;
    const distH = Math.hypot(dx, dz);
    const ang = Math.atan2(dz, dx);
    // hold ~9 blocks horizontal range: close in if far, back off if near, while
    // always drifting sideways so it weaves rather than sitting still
    const ideal = 9;
    const radial = distH > ideal + 2 ? 1 : distH < ideal - 2 ? -1 : 0;
    const wishX = Math.cos(ang) * radial - Math.sin(ang) * 0.55;
    const wishZ = Math.sin(ang) * radial + Math.cos(ang) * 0.55;
    const speed = e.moveSpeed;
    e.vel.x += (wishX * speed - e.vel.x) * Math.min(1, 2 * dt);
    e.vel.z += (wishZ * speed - e.vel.z) * Math.min(1, 2 * dt);
    const targetY = p.pos.y + 4.5 + Math.sin(e.age * 1.5) * 0.7;
    e.vel.y += ((targetY - e.pos.y) * 0.6 - e.vel.y) * Math.min(1, 1.5 * dt);
    e.pos.x += e.vel.x * dt;
    e.pos.y += e.vel.y * dt;
    e.pos.z += e.vel.z * dt;
    e.yaw = Math.atan2(-dx, -dz);
    e.attackCooldown = Math.max(0, e.attackCooldown - dt);
    if (e.attackCooldown <= 0 && distH < 18 && !p.dead && p.mode === 'survival') {
      e.attackCooldown = 2.6 + Math.random() * 1.4;
      this.spawnFireball(e.pos.x, e.pos.y, e.pos.z, p.pos.x - e.pos.x, (p.pos.y + 1) - e.pos.y, p.pos.z - e.pos.z);
    }
    // gently pulsing ember tips over a near-dark charcoal hide (kept low so the
    // tips read as distinct glints rather than blooming into one orange mass)
    const pulse = 0.32 + 0.16 * Math.sin(e.age * 5);
    const hurt = e.hurtFlash > 0;
    for (const m of e.materials) {
      m.color.setRGB(MOB_EXPOSURE, hurt ? MOB_EXPOSURE * 0.5 : MOB_EXPOSURE, hurt ? MOB_EXPOSURE * 0.5 : MOB_EXPOSURE);
      if (hurt) m.emissive.setRGB(0.3, 0.02, 0.02);
      else if (m.userData.ember) m.emissive.setRGB(pulse, pulse * 0.38, 0.02);
      else m.emissive.setRGB(0.04, 0.015, 0.005);
    }
    if (e.limbs) {
      for (let i = 0; i < e.limbs.legs.length; i++) {
        e.limbs.legs[i].rotation.x = Math.sin(e.age * 3 + i) * 0.4;
      }
    }
    e.mesh.position.set(e.pos.x, e.pos.y, e.pos.z);
    e.mesh.rotation.y = e.yaw;
  }

  /** Launch a slow, flat-flying fireball toward a direction. `owner` decides who
   *  it can hurt: 'emberghast' burns the player, 'petghast' burns hostile mobs. */
  spawnFireball(x: number, y: number, z: number, dx: number, dy: number, dz: number,
    owner: 'emberghast' | 'petghast' = 'emberghast'): void {
    const mesh = new THREE.Group();
    const core = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 0.3, 0.3),
      new THREE.MeshBasicMaterial({ color: 0xffb030 }),
    );
    const glow = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.5, 0.5),
      new THREE.MeshBasicMaterial({ color: 0xff5010, transparent: true, opacity: 0.4 }),
    );
    mesh.add(core, glow);
    const len = Math.hypot(dx, dy, dz) || 1;
    const speed = 8;
    const e = new Entity('arrow', { x, y, z }, { w: 0.3, h: 0.3 }, mesh);
    e.vel = { x: (dx / len) * speed, y: (dy / len) * speed, z: (dz / len) * speed };
    e.owner = owner;
    e.dmg = 4;
    this.entities.push(e);
    this.scene.add(mesh);
    this.audio.play('bow');
  }

  /** A small fiery puff where a fireball lands. */
  private fireballBurst(x: number, y: number, z: number): void {
    this.audio.play('arrowHit');
    for (let i = 0; i < 8; i++) {
      this.spawnFirefly(x + (Math.random() - 0.5) * 0.8, y + (Math.random() - 0.5) * 0.8, z + (Math.random() - 0.5) * 0.8);
    }
  }

  // --- 20 Hz AI tick --------------------------------------------------------------

  tick(isNight: boolean): void {
    const p = this.player;
    if (!p) return;
    this.tickWither();

    for (const e of this.entities) {
      if (!this.isMob(e)) continue;
      const stats = MOB_STATS[e.kind as MobKind];
      if (e.dead) continue;
      this.tickNether(e);
      if (e.dead) continue;
      // captured pets slowly auto-heal back to full (unless killed outright)
      if (this.isPet(e)) {
        e.attackCooldown = Math.max(0, e.attackCooldown - 0.05);
        if (e.regenT > 0) e.regenT -= 0.05;
        if (e.regenT <= 0 && e.hp < stats.hp) {
          e.hp = Math.min(stats.hp, e.hp + 1);
          e.regenT = 4;
        }
      }
      // breeding + baby growth bookkeeping
      if (e.breedCooldown > 0) e.breedCooldown = Math.max(0, e.breedCooldown - 0.05);
      if (e.loveT > 0) {
        e.loveT -= 0.05;
        if (Math.random() < 0.25) this.spawnHearts(e.pos.x, e.pos.y + e.box.h, e.pos.z);
        this.tryBreed(e);
      }
      if (e.baby && (e.growT -= 0.05) <= 0) {
        e.baby = false;
        e.mesh.scale.setScalar(1);
        e.limbs?.head?.scale.setScalar(1);
        e.box = { ...MOB_STATS[e.kind as MobKind].box };
      }
      e.stateTime -= 0.05;
      const d = Math.hypot(p.pos.x - e.pos.x, p.pos.z - e.pos.z);

      // idle voices, attenuated by distance
      if (d < 24 && Math.random() < (e.state === 'chase' ? 0.008 : 0.0035)) {
        this.audio.mobSound(e.kind, (1 - d / 24) * 0.9, 'idle', ((e.pos.x - p.pos.x) * Math.cos(p.yaw) - (e.pos.z - p.pos.z) * Math.sin(p.yaw)) / Math.max(1, d) * 0.7);
      }

      if (stats.hostile && e.state !== 'fuse' && !this.isPet(e)) {
        // undead catch fire at dawn when the sky can see them (water puts it out)
        if (!isNight && (e.kind === 'zombie' || e.kind === 'skeleton' || e.kind === 'phantom')) {
          const sky = this.world.skyLight(Math.floor(e.pos.x), Math.floor(e.pos.y + 1), Math.floor(e.pos.z));
          if (sky >= 0.95 && !inWater(this.world, e.pos, e.box)) e.burnT = Math.max(e.burnT, 3);
        }
        const dark = this.world.skyLight(Math.floor(e.pos.x), Math.floor(e.pos.y + 1), Math.floor(e.pos.z)) < 0.7;
        const aggressive = this.wantsPlayer(e, isNight, dark);
        // a pet that has engaged this mob becomes its quarry (they brawl while
        // the owner keeps their distance); dropped when it dies or runs off
        if (e.foe && (e.foe.dead || !this.isPet(e.foe)
          || Math.hypot(e.foe.pos.x - e.pos.x, e.foe.pos.z - e.pos.z) > 18)) e.foe = null;
        if (!e.foe) {
          for (const pet of this.entities) {
            if (!this.isPet(pet) || pet.dead || pet.target !== e) continue;
            e.foe = pet;
            break;
          }
        }
        const foeD = e.foe ? Math.hypot(e.foe.pos.x - e.pos.x, e.foe.pos.z - e.pos.z) : Infinity;
        if (e.foe && foeD < 20) {
          e.state = 'chase';
        } else if (aggressive && d < 16 && !p.dead && p.mode === 'survival') {
          e.state = 'chase';
        } else if (e.state === 'chase') {
          e.state = 'wander';
          e.stateTime = 3;
        }
        // creepers are terrified of cats (vanilla): bolt away from one within 6
        if (e.kind === 'creeper') {
          const cat = this.nearestOf(e, 'cat', 6);
          if (cat) this.fleeFrom(e, cat);
        }

        // skeleton archery (at its pet quarry if it has one, else the player)
        if (e.kind === 'skeleton' && e.state === 'chase') {
          const aim = e.foe && !e.foe.dead ? e.foe : null;
          const aimD = aim ? foeD : d;
          e.shootCooldown -= 0.05;
          if (e.shootCooldown <= 0 && aimD > 3.5 && aimD < 15) {
            const ex = e.pos.x, ey = e.pos.y + 1.5, ez = e.pos.z;
            const tx = aim ? aim.pos.x : p.pos.x;
            const ty = aim ? aim.pos.y + aim.box.h * 0.6 : p.pos.y + 1.4;
            const tz = aim ? aim.pos.z : p.pos.z;
            const dist3 = Math.hypot(tx - ex, ty - ey, tz - ez);
            const hit = this.world.raycast(ex, ey, ez, (tx - ex) / dist3, (ty - ey) / dist3, (tz - ez) / dist3, dist3);
            if (!hit) {
              e.shootCooldown = 2.2;
              const spread = () => (Math.random() - 0.5) * 0.06;
              this.shootArrow('skeleton', ex, ey, ez,
                (tx - ex) / dist3 + spread(),
                (ty - ey) / dist3 + 0.035 * dist3 / 15 + spread(),
                (tz - ez) / dist3 + spread(),
                22, 3);
            }
          }
        }
        // crossbow piglins: cock (bolt shows), then loose a bolt when in range
        if (e.kind === 'piglin' && (e.variant & 1) && e.state === 'chase' && !e.baby) {
          const aim = e.foe && !e.foe.dead ? e.foe : null;
          const aimD = aim ? foeD : d;
          if (aimD > 2.5 && aimD < 16) {
            e.shootCooldown -= 0.05;
            if (e.shootCooldown <= 0) {
              const ex = e.pos.x, ey = e.pos.y + 1.45, ez = e.pos.z;
              const tx = aim ? aim.pos.x : p.pos.x;
              const ty = aim ? aim.pos.y + aim.box.h * 0.6 : p.pos.y + 1.4;
              const tz = aim ? aim.pos.z : p.pos.z;
              const dist3 = Math.hypot(tx - ex, ty - ey, tz - ez);
              if (!this.world.raycast(ex, ey, ez, (tx - ex) / dist3, (ty - ey) / dist3, (tz - ez) / dist3, dist3)) {
                e.shootCooldown = 2.4 + Math.random() * 0.8;
                const spread = () => (Math.random() - 0.5) * 0.04;
                this.shootArrow('skeleton', ex, ey, ez,
                  (tx - ex) / dist3 + spread(), (ty - ey) / dist3 + 0.02 * dist3 / 15 + spread(), (tz - ez) / dist3 + spread(),
                  28, 4);
              } else e.shootCooldown = 0.4;
            }
          } else if (e.shootCooldown < 1.5) e.shootCooldown = 1.5;
        }
      }

      // burning: flames + 2 damage a second until it dies, finds water or shade
      if (e.burnT > 0) {
        e.burnT -= 0.05;
        if (inWater(this.world, e.pos, e.box)) e.burnT = 0;
        if (Math.random() < 0.5) {
          this.spawnTorchFlame(e.pos.x + (Math.random() - 0.5) * e.box.w, e.pos.y + Math.random() * e.box.h,
            e.pos.z + (Math.random() - 0.5) * e.box.w);
        }
        if (++e.burnTick >= 20) {
          e.burnTick = 0;
          e.hp -= 2;
          e.hurtFlash = 0.3;
          this.audio.play('hit');
          if (e.hp <= 0) { this.killMob(e); continue; }
        }
      }

      // an angered wild wolf hunts the player until it calms down
      if (e.kind === 'wolf' && !e.tamed) {
        if (e.angryT > 0 && d < 20 && !p.dead && p.mode === 'survival') e.state = 'chase';
        else if (e.state === 'chase') { e.state = 'wander'; e.stateTime = 2; e.angryT = 0; }
      }

      // rabbits bolt from a player who comes close without a carrot in hand
      if (e.kind === 'rabbit' && !e.tamed && d < 5 && !p.dead && e.state !== 'flee'
        && !this.isLureFood('rabbit', p.heldId()) && !p.sneaking) {
        e.state = 'flee';
        e.stateTime = 1.2 + Math.random();
        e.yaw = Math.atan2(-(e.pos.x - p.pos.x), -(e.pos.z - p.pos.z)) + (Math.random() - 0.5) * 0.8;
      }
      // villagers scatter from zombies
      if (e.kind === 'villager') {
        const z = this.nearestOf(e, 'zombie', 8);
        if (z) this.fleeFrom(e, z);
      }

      // grazing: sheep put their head down in the turf for two seconds, then the
      // grass is eaten (grass block -> dirt, or a tuft cleared) and a shorn fleece
      // regrows; idle horses crop the grass too, just for show
      if ((e.kind === 'sheep' || e.kind === 'horse') && !e.tamed && !e.ridden) {
        if (e.grazeT > 0) {
          const before = e.grazeT;
          e.grazeT = Math.max(0, e.grazeT - 0.05);
          if (e.kind === 'sheep' && before > 0.7 && e.grazeT <= 0.7) this.eatGrass(e);
        } else if (e.state === 'idle' && e.onGround && this.grassUnder(e) && Math.random()
          < (e.kind === 'horse' ? 1 / 300 : e.sheared || e.baby ? 1 / 120 : 1 / 500)) {
          e.grazeT = e.kind === 'horse' ? 3 : 2;
          e.stateTime = Math.max(e.stateTime, e.grazeT);
        }
      }
      // a baby trots after the nearest grown-up of its kind
      if (e.baby && !e.tamed && e.state !== 'flee' && e.stateTime <= 0) {
        const parent = this.nearestAdult(e);
        if (parent && Math.hypot(parent.pos.x - e.pos.x, parent.pos.z - e.pos.z) > 3) {
          e.state = 'wander';
          e.yaw = Math.atan2(-(parent.pos.x - e.pos.x), -(parent.pos.z - e.pos.z));
          e.stateTime = 1 + Math.random();
        }
      }

      if (e.state !== 'chase' && e.state !== 'fuse' && e.stateTime <= 0 && e.grazeT <= 0) {
        if (e.state === 'flee') e.state = 'idle';
        if (Math.random() < 0.55) {
          e.state = 'idle';
          e.stateTime = 1.5 + Math.random() * 3;
        } else {
          e.state = 'wander';
          e.yaw = Math.random() * Math.PI * 2;
          e.stateTime = 2 + Math.random() * 4;
          // herd animals drift back toward their own kind instead of scattering
          if (HERD_KINDS.has(e.kind as MobKind) && !e.tamed) {
            const c = this.herdCentre(e);
            if (c && Math.random() < 0.7) {
              e.yaw = Math.atan2(-(c.x - e.pos.x), -(c.z - e.pos.z)) + (Math.random() - 0.5) * 1.2;
            }
          }
        }
      }

      if (d > 72 && !e.tamed && !e.ridden) { e.dead = true; this.clearFoe(e); }
    }

    // spawn attempts once per second
    if (++this.spawnTick >= 20) {
      this.spawnTick = 0;
      this.trySpawns(isNight);
    }
  }

  // --- nether mob behaviour (20 Hz) ------------------------------------------------

  /** Does a wild hostile want the player right now? Spiders only in the dark;
   *  piglins unless the player wears gold (or angered them); zombified
   *  piglins only once provoked; babies and busy piglins never. */
  private wantsPlayer(e: Entity, isNight: boolean, dark: boolean): boolean {
    switch (e.kind) {
      case 'spider': return isNight || dark || e.angryT > 0;
      case 'piglin': return !e.baby && e.admireT <= 0 && !e.lure && (e.angryT > 0 || !this.wearsGold());
      case 'zombified_piglin': return e.angryT > 0;
      case 'hoglin': return !e.baby;
      default: return true;
    }
  }

  /** Any piece of golden armor on the player (piglins leave them be). */
  private wearsGold(): boolean {
    const inv = this.player?.inventory;
    return !!inv && inv.armor.some((s) => s !== null && GOLD_ARMOR.has(s.id));
  }

  /** Per-mob nether behaviour: piglin gold greed + bartering + overworld
   *  zombification, hoglins shying from warped fungus and portals, striders
   *  going cold off the lava and heading back to it. */
  private tickNether(e: Entity): void {
    switch (e.kind) {
      case 'piglin': this.tickPiglin(e); break;
      case 'hoglin':
        if (!e.tamed && Math.random() < 0.05) this.hoglinRepel(e);
        break;
      case 'strider': this.tickStrider(e); break;
    }
  }

  private tickPiglin(e: Entity): void {
    if (e.tamed) return;
    // out of the Nether a piglin shakes for 15 s, then turns zombified
    if (this.world.dimension !== 'nether') {
      e.convertT += 0.05;
      if (e.convertT >= 15) { this.zombify(e); return; }
    } else e.convertT = 0;
    if (e.admireT > 0) {
      e.admireT -= 0.05;
      if (Math.random() < 0.02) this.audio.mobSound('piglin_admire', this.voiceVol(e), 'idle');
      if (e.admireT <= 0) this.barter(e);
      return;
    }
    // a gold ingot on the ground: go and get it (babies too, and even mid-fight)
    const l = e.lure;
    if (l && (l.dead || l.itemId !== I.GOLD_INGOT)) e.lure = null;
    if (!e.lure && Math.random() < 0.25) {
      let best: Entity | null = null, bestD = 64;
      for (const o of this.entities) {
        if (o.kind !== 'drop' || o.dead || o.itemId !== I.GOLD_INGOT || o.age < 0.8) continue;
        const dd = (o.pos.x - e.pos.x) ** 2 + (o.pos.z - e.pos.z) ** 2;
        if (dd < bestD && Math.abs(o.pos.y - e.pos.y) < 3) { bestD = dd; best = o; }
      }
      e.lure = best;
    }
    if (e.lure) {
      const o = e.lure;
      const dx = o.pos.x - e.pos.x, dz = o.pos.z - e.pos.z;
      if (Math.hypot(dx, dz) < 1.2 && Math.abs(o.pos.y - e.pos.y) < 1.5) {
        if (--o.count <= 0) o.dead = true;
        this.audio.play('pop');
        e.lure = null;
        if (e.baby) return; // babies just run off with it
        this.startAdmire(e);
        return;
      }
      e.state = 'wander';
      e.stateTime = 1;
      e.yaw = Math.atan2(-dx, -dz);
    }
  }

  /** A piglin takes a gold ingot and turns it over for six seconds. */
  private startAdmire(e: Entity): void {
    e.admireT = 6;
    e.state = 'idle';
    e.stateTime = 6;
    e.lure = null;
    e.vel.x = 0; e.vel.z = 0;
    this.audio.mobSound('piglin_admire', Math.max(0.4, this.voiceVol(e)), 'idle');
  }

  /** Done admiring: the piglin tosses a piece of its barter loot toward the
   *  player (vanilla weights; other modules' blocks by registry name). */
  private barter(e: Entity): void {
    const table: [number, number, number, number][] = [
      [I.POTION_FIRE_RESISTANCE, 8, 1, 1], [I.WATER_BOTTLE, 10, 1, 1], [I.IRON_BOOTS, 8, 1, 1],
      [I.WARP_PEARL, 10, 2, 4], [I.STRING, 20, 3, 9], [I.QUARTZ, 20, 5, 12],
      [B.OBSIDIAN, 40, 1, 1], [idByName('crying_obsidian', B.OBSIDIAN), 40, 1, 3],
      [idByName('fire_charge'), 40, 1, 1], [I.LEATHER, 40, 2, 4], [B.SOUL_SAND, 40, 2, 8],
      [I.NETHER_BRICK, 40, 2, 8], [I.ARROW, 40, 6, 12], [B.GRAVEL, 40, 8, 16],
      [idByName('blackstone', B.NETHERRACK), 40, 8, 16],
    ];
    const rows = table.filter((r) => r[0] >= 0);
    let r = Math.random() * rows.reduce((s, x) => s + x[1], 0);
    let pick = rows[0];
    for (const row of rows) { r -= row[1]; if (r <= 0) { pick = row; break; } }
    const [id, , min, max] = pick;
    const n = min + Math.floor(Math.random() * (max - min + 1));
    const hx = e.pos.x - Math.cos(e.yaw) * 0.35, hz = e.pos.z + Math.sin(e.yaw) * 0.35;
    const drop = this.spawnDrop(hx, e.pos.y + 1.1, hz, id, n);
    const p = this.player;
    if (p) {
      const dx = p.pos.x - e.pos.x, dz = p.pos.z - e.pos.z, len = Math.hypot(dx, dz) || 1;
      drop.vel = { x: (dx / len) * 3.2, y: 3.6, z: (dz / len) * 3.2 };
      e.yaw = Math.atan2(-dx, -dz);
    }
    e.swingT = 0.3;
    this.audio.mobSound('piglin', this.voiceVol(e), 'idle');
  }

  /** A piglin out of its home dimension turns into a zombified piglin. */
  private zombify(e: Entity): void {
    e.dead = true;
    this.clearFoe(e);
    const z = e.baby ? this.spawnBaby('zombified_piglin', e.pos.x, e.pos.y, e.pos.z)
      : this.spawnMob('zombified_piglin', e.pos.x, e.pos.y, e.pos.z);
    z.yaw = z.visYaw = e.yaw;
    this.spawnSmoke(e.pos.x, e.pos.y + 1, e.pos.z, 8);
    this.audio.mobSound('zombified_piglin', this.voiceVol(e), 'hurt');
  }

  /** Hoglins give warped fungus (and nether portals) a wide berth. */
  private hoglinRepel(e: Entity): void {
    const fungus = firstId('warped_fungus', 'warped_roots');
    const x0 = Math.floor(e.pos.x), y0 = Math.floor(e.pos.y), z0 = Math.floor(e.pos.z);
    for (let dy = -1; dy <= 2; dy++) {
      for (let dz = -6; dz <= 6; dz++) {
        for (let dx = -6; dx <= 6; dx++) {
          const id = this.world.getBlock(x0 + dx, y0 + dy, z0 + dz);
          if (id !== B.PORTAL && (fungus < 0 || id !== fungus)) continue;
          e.state = 'flee';
          e.stateTime = 2.5;
          e.yaw = Math.atan2(dx, dz); // straight away from it
          return;
        }
      }
    }
  }

  /** Striders: cold off the lava; a cold strider picks a heading back to it. */
  private tickStrider(e: Entity): void {
    const x = Math.floor(e.pos.x), z = Math.floor(e.pos.z);
    const fy = Math.floor(e.pos.y - 0.05);
    e.cold = this.world.getBlock(x, fy, z) !== B.LAVA && this.world.getBlock(x, fy + 1, z) !== B.LAVA;
    if (!e.cold || e.ridden || e.state === 'flee' || e.stateTime > 0 || Math.random() > 0.5) return;
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * Math.PI * 2, r = 2 + Math.random() * 10;
      const lx = Math.floor(e.pos.x + Math.cos(a) * r), lz = Math.floor(e.pos.z + Math.sin(a) * r);
      for (let dy = 0; dy >= -3; dy--) {
        if (this.world.getBlock(lx, fy + dy, lz) !== B.LAVA) continue;
        e.state = 'wander';
        e.stateTime = 2 + r / 2;
        e.yaw = Math.atan2(-(lx + 0.5 - e.pos.x), -(lz + 0.5 - e.pos.z));
        return;
      }
    }
  }

  /** Distance-attenuated voice volume for a mob. */
  private voiceVol(e: Entity): number {
    const p = this.player;
    if (!p) return 0.5;
    return Math.max(0, 1 - Math.hypot(p.pos.x - e.pos.x, p.pos.z - e.pos.z) / 24) * 0.9;
  }

  /** Wake a piglin (or a zombified piglin horde) against the player: every
   *  one of its kind nearby turns hostile, clouding over angrily. */
  private provoke(e: Entity): void {
    const r = e.kind === 'zombified_piglin' ? 24 : 16;
    for (const o of this.entities) {
      if (o.kind !== e.kind || o.tamed || o.dead) continue;
      if (o !== e && Math.hypot(o.pos.x - e.pos.x, o.pos.z - e.pos.z) > r) continue;
      if (o.angryT <= 0) this.spawnAngry(o.pos.x, o.pos.y + o.box.h + 0.2, o.pos.z);
      o.angryT = 30;
      o.admireT = 0;
      o.lure = null;
      if (o.limbs?.offhand) o.limbs.offhand.visible = false;
    }
  }

  /** Centre of this animal's herd (same kind within 16 blocks), when the mob has
   *  strayed more than 5 blocks from it; null when it is already among them. */
  private herdCentre(e: Entity): { x: number; z: number } | null {
    let sx = 0, sz = 0, n = 0;
    for (const o of this.entities) {
      if (o === e || o.kind !== e.kind || o.dead) continue;
      const dx = o.pos.x - e.pos.x, dz = o.pos.z - e.pos.z;
      if (dx * dx + dz * dz > 256) continue;
      sx += o.pos.x; sz += o.pos.z; n++;
    }
    if (!n) return null;
    const cx = sx / n, cz = sz / n;
    return Math.hypot(cx - e.pos.x, cz - e.pos.z) > 5 ? { x: cx, z: cz } : null;
  }

  /** Nearest wild mob of `kind` within `r` blocks of `e` (pets don't count). */
  private nearestOf(e: Entity, kind: MobKind, r: number): Entity | null {
    let best: Entity | null = null, bestD = r * r;
    for (const o of this.entities) {
      if (o === e || o.kind !== kind || o.dead || (o.tamed && kind !== 'cat')) continue;
      const d = (o.pos.x - e.pos.x) ** 2 + (o.pos.z - e.pos.z) ** 2;
      if (d < bestD) { bestD = d; best = o; }
    }
    return best;
  }

  /** Run directly away from `threat` for a couple of seconds. */
  private fleeFrom(e: Entity, threat: Entity): void {
    e.state = 'flee';
    e.stateTime = 1.5;
    e.grazeT = 0;
    e.yaw = Math.atan2(-(e.pos.x - threat.pos.x), -(e.pos.z - threat.pos.z));
  }

  private nearestAdult(e: Entity): Entity | null {
    let best: Entity | null = null, bestD = 16 * 16;
    for (const o of this.entities) {
      if (o === e || o.kind !== e.kind || o.baby || o.dead) continue;
      const d = (o.pos.x - e.pos.x) ** 2 + (o.pos.z - e.pos.z) ** 2;
      if (d < bestD) { bestD = d; best = o; }
    }
    return best;
  }

  /** Is there grass (a tuft at the feet, or a grass block below) for a sheep to eat? */
  private grassUnder(e: Entity): boolean {
    const x = Math.floor(e.pos.x), y = Math.floor(e.pos.y + 0.05), z = Math.floor(e.pos.z);
    return this.world.getBlock(x, y, z) === B.TALL_GRASS || this.world.getBlock(x, y - 1, z) === B.GRASS;
  }

  private eatGrass(e: Entity): void {
    const x = Math.floor(e.pos.x), y = Math.floor(e.pos.y + 0.05), z = Math.floor(e.pos.z);
    if (this.world.getBlock(x, y, z) === B.TALL_GRASS) {
      this.world.setBlock(x, y, z, B.AIR);
      this.spawnBlockParticles(x, y, z, B.TALL_GRASS, 6);
    } else if (this.world.getBlock(x, y - 1, z) === B.GRASS) {
      this.world.setBlock(x, y - 1, z, B.DIRT);
      this.spawnBlockParticles(x, y - 1, z, B.GRASS, 6);
    } else return;
    this.audio.play('eat');
    e.sheared = false;
    if (e.baby) e.growT = Math.max(0, e.growT - 10); // lambs grow up faster on grass
  }

  private trySpawns(isNight: boolean): void {
    if (!this.mobsEnabled) return;
    const p = this.player!;
    let passive = 0, hostile = 0;
    for (const e of this.entities) {
      if (!this.isMob(e)) continue;
      if (MOB_STATS[e.kind as MobKind].hostile) hostile++;
      else passive++;
    }

    // Repopulate village dwelling spots near the player. Spots are kept (not
    // consumed) and persisted, so a village keeps its villagers after they
    // despawn or after a save/reload — it just won't double up on an occupied one.
    const vs = this.world.generator.villageSpawns;
    if (vs.length) {
      let villagerCount = 0;
      for (const e of this.entities) if (e.kind === 'villager') villagerCount++;
      for (const s of vs) {
        if (villagerCount >= 12) break;
        const d = Math.hypot(s.x - p.pos.x, s.z - p.pos.z);
        if (d >= 44) continue;
        // skip if a villager already lives near this spot
        let occupied = false;
        for (const e of this.entities) {
          if (e.kind !== 'villager') continue;
          if (Math.hypot(e.pos.x - s.x, e.pos.z - s.z) < 7) { occupied = true; break; }
        }
        if (occupied) continue;
        // only spawn once the chunk is loaded + has ground beneath the spot
        const chunk = this.world.getChunk(Math.floor(s.x / 16), Math.floor(s.z / 16));
        if (chunk && chunk.ready && this.world.isSolidAt(Math.floor(s.x), Math.floor(s.y) - 1, Math.floor(s.z))) {
          this.spawnMob('villager', s.x, s.y, s.z);
          villagerCount++;
        }
      }
    }

    const surfaceSpawn = (kinds: MobKind[], minR: number, maxR: number): void => {
      const ang = Math.random() * Math.PI * 2;
      const r = minR + Math.random() * (maxR - minR);
      const wx = Math.floor(p.pos.x + Math.cos(ang) * r);
      const wz = Math.floor(p.pos.z + Math.sin(ang) * r);
      const chunk = this.world.getChunk(Math.floor(wx / 16), Math.floor(wz / 16));
      if (!chunk || !chunk.ready) return;
      const h = chunk.heightmap[(wz & 15) * 16 + (wx & 15)];
      if (h <= SEA_LEVEL || h >= 150) return;
      const ground = this.world.getBlock(wx, h - 1, wz);
      if (ground !== B.GRASS && ground !== B.SNOW_GRASS && ground !== B.SAND) return;
      if (this.world.getBlock(wx, h, wz) !== B.AIR || this.world.getBlock(wx, h + 1, wz) !== B.AIR) return;
      const label = this.world.generator.biomeLabel(wx, wz);
      const pool = this.spawnPool(kinds, label);
      if (!pool.length) return;
      const kind = pool[Math.floor(Math.random() * pool.length)];
      const variant = this.climateVariant(kind, wx, wz, label);
      // farm animals and rabbits arrive as a small group
      const group = kind === 'rabbit' ? 1 + Math.floor(Math.random() * 3)
        : HERD_KINDS.has(kind) && kind !== 'horse' ? 1 + Math.floor(Math.random() * 3) : 1;
      for (let i = 0; i < group; i++) {
        const gx = i === 0 ? wx : wx + Math.floor((Math.random() - 0.5) * 5);
        const gz = i === 0 ? wz : wz + Math.floor((Math.random() - 0.5) * 5);
        const gc = this.world.getChunk(Math.floor(gx / 16), Math.floor(gz / 16));
        if (!gc || !gc.ready) continue;
        const gh = gc.heightmap[(gz & 15) * 16 + (gx & 15)];
        if (Math.abs(gh - h) > 2 || this.world.getBlock(gx, gh, gz) !== B.AIR) continue;
        const g = this.world.getBlock(gx, gh - 1, gz);
        if (g !== B.GRASS && g !== B.SNOW_GRASS && g !== B.SAND) continue;
        this.spawnMob(kind, gx + 0.5, gh, gz + 0.5, variant ?? undefined);
      }
    };

    const caveSpawn = (): void => {
      const ang = Math.random() * Math.PI * 2;
      const r = 10 + Math.random() * 18;
      const wx = Math.floor(p.pos.x + Math.cos(ang) * r);
      const wz = Math.floor(p.pos.z + Math.sin(ang) * r);
      const chunk = this.world.getChunk(Math.floor(wx / 16), Math.floor(wz / 16));
      if (!chunk || !chunk.ready) return;
      const h = chunk.heightmap[(wz & 15) * 16 + (wx & 15)];
      const wy = 6 + Math.floor(Math.random() * Math.max(4, h - 12));
      if (this.world.getBlock(wx, wy, wz) !== B.AIR || this.world.getBlock(wx, wy + 1, wz) !== B.AIR) return;
      if (!this.world.isSolidAt(wx, wy - 1, wz)) return;
      if (this.world.skyLight(wx, wy, wz) >= 0.6) return;       // too bright (near surface)
      if (this.world.anyTorchNear(wx, wy, wz, 9)) return;       // torch-lit areas are safe
      const kinds: MobKind[] = ['zombie', 'skeleton', 'spider'];
      this.spawnMob(kinds[Math.floor(Math.random() * kinds.length)], wx + 0.5, wy, wz + 0.5);
    };

    // Nether: only nether mobs spawn here, by region (fortress bricks, the
    // ground block or the generator's nether biome), and the overworld spawns
    // are skipped. It stays populated in both modes (its mobs can't hurt a
    // creative player anyway) — two attempts per tick so pockets fill reliably.
    if (this.world.dimension === 'nether') {
      if (hostile + passive < 24 && Math.random() < 0.8) {
        for (let attempt = 0; attempt < 2; attempt++) this.netherSpawn();
      }
      return;
    }

    if (!isNight && passive < 10 && Math.random() < 0.5) {
      surfaceSpawn(['pig', 'chicken', 'sheep', 'cow'], 12, 36);
    }
    // rabbits: snowfields, deserts, badlands, meadows and taiga
    if (passive < 12 && Math.random() < 0.18) surfaceSpawn(['rabbit'], 12, 36);
    // bats: flutter out of dark caves day or night
    if (Math.random() < 0.25) {
      let bats = 0;
      for (const e of this.entities) if (e.kind === 'bat') bats++;
      if (bats < 5) this.batSpawn();
    }
    // wolves: rarer, prefer forests/taiga
    if (!isNight && passive < 8 && Math.random() < 0.12) {
      surfaceSpawn(['wolf'], 16, 40);
    }
    // horses: open grassland, spawn as a small herd
    if (!isNight && passive < 7 && Math.random() < 0.1) {
      surfaceSpawn(['horse'], 18, 42);
      if (Math.random() < 0.6) surfaceSpawn(['horse'], 18, 42);
    }
    // cats: rare daytime wanderers
    if (!isNight && passive < 9 && Math.random() < 0.05) {
      surfaceSpawn(['cat'], 14, 34);
    }
    if (this.player!.mode === 'survival' && hostile < 10) {
      if (isNight && Math.random() < 0.7) surfaceSpawn(['zombie', 'skeleton', 'spider', 'creeper'], 14, 32);
      if (Math.random() < 0.5) caveSpawn();
    }
  }

  /** One nether spawn attempt: a standing spot (or a lava surface, for
   *  striders) near the player's altitude, 12-36 blocks out. */
  private netherSpawn(): void {
    const p = this.player!;
    const ang = Math.random() * Math.PI * 2;
    const r = 12 + Math.random() * 24;
    const wx = Math.floor(p.pos.x + Math.cos(ang) * r);
    const wz = Math.floor(p.pos.z + Math.sin(ang) * r);
    const chunk = this.world.getChunk(Math.floor(wx / 16), Math.floor(wz / 16));
    if (!chunk || !chunk.ready) return;
    const py = Math.floor(p.pos.y);
    for (let tries = 0; tries < 12; tries++) {
      const wy = py - 12 + Math.floor(Math.random() * 26);
      if (wy < 5 || wy > 150) continue;
      if (this.world.getBlock(wx, wy, wz) !== B.AIR || this.world.getBlock(wx, wy + 1, wz) !== B.AIR) continue;
      const below = this.world.getBlock(wx, wy - 1, wz);
      if (below === B.LAVA) {
        // lava seas: striders wander the surface
        if (Math.random() < 0.3) this.spawnPack('strider', wx, wy, wz, 1, 2);
        return;
      }
      if (!this.world.isSolidAt(wx, wy - 1, wz)) continue;
      const region = this.netherRegion(wx, wy, wz, below);
      if (region === 'warped' && Math.random() < 0.75) return; // the warped forest is eerily empty
      const table = NETHER_TABLES[region];
      let roll = Math.random() * table.reduce((s, t) => s + t[1], 0);
      let pick = table[0];
      for (const t of table) { roll -= t[1]; if (roll <= 0) { pick = t; break; } }
      this.spawnPack(pick[0], wx, wy, wz, pick[2], pick[3]);
      return;
    }
  }

  /** Which nether region a spot belongs to: fortress bricks nearby win, then
   *  the ground block, then the generator's nether biome if it has one. */
  private netherRegion(wx: number, wy: number, wz: number, ground: number): NetherRegion {
    const bricks = brickIds();
    let n = 0;
    for (let dy = -3; dy <= 4; dy++) {
      for (let dz = -5; dz <= 5; dz++) {
        for (let dx = -5; dx <= 5; dx++) {
          if (bricks.has(this.world.getBlock(wx + dx, wy + dy, wz + dz)) && ++n >= 4) return 'fortress';
        }
      }
    }
    const byBlock = regionOfBlock(hasDef(ground) ? def(ground).name : '');
    if (byBlock !== 'wastes') return byBlock;
    const gen = this.world.generator as unknown as { netherBiomeAt?: (x: number, z: number, y?: number) => unknown };
    if (typeof gen.netherBiomeAt === 'function') {
      const b = gen.netherBiomeAt(wx, wz, wy);
      const label = typeof b === 'string' ? b : (b && typeof b === 'object' && 'name' in b) ? String((b as { name: unknown }).name) : '';
      if (label) return regionOfBiome(label);
    }
    return 'wastes';
  }

  /** Spawn a pack of `kind` around (wx,wy,wz): each member needs a clear
   *  2-high spot within 2 blocks of the anchor height; flyers need open air.
   *  Some piglins and hoglins arrive as babies. */
  private spawnPack(kind: MobKind, wx: number, wy: number, wz: number, min: number, max: number): void {
    const n = min + Math.floor(Math.random() * (max - min + 1));
    const air = (x: number, y: number, z: number): boolean => this.world.getBlock(x, y, z) === B.AIR;
    for (let i = 0; i < n; i++) {
      const gx = i === 0 ? wx : wx + Math.round((Math.random() - 0.5) * 6);
      const gz = i === 0 ? wz : wz + Math.round((Math.random() - 0.5) * 6);
      let gy = -1;
      for (const dy of [0, 1, -1, 2, -2]) {
        const y = wy + dy;
        if (!air(gx, y, gz) || !air(gx, y + 1, gz)) continue;
        const under = this.world.getBlock(gx, y - 1, gz);
        if (kind === 'strider' ? under === B.LAVA : this.world.isSolidAt(gx, y - 1, gz)) { gy = y; break; }
      }
      if (gy < 0) continue;
      if (kind === 'emberghast') {
        // a ghast needs a real cavern: a clear 3×3×3 pocket above the floor
        let open = true;
        for (let y = gy + 2; y <= gy + 4 && open; y++) {
          for (let z = gz - 1; z <= gz + 1 && open; z++) for (let x = gx - 1; x <= gx + 1; x++) if (!air(x, y, z)) { open = false; break; }
        }
        if (!open) continue;
        this.spawnMob(kind, gx + 0.5, gy + 3, gz + 0.5);
        continue;
      }
      if (kind === 'wither_skeleton' && !air(gx, gy + 2, gz)) continue; // 2.4 tall
      const baby = (kind === 'piglin' && Math.random() < 0.2) || (kind === 'hoglin' && Math.random() < 0.15);
      const y = kind === 'blaze' ? gy + 0.5 : gy;
      if (baby) this.spawnBaby(kind, gx + 0.5, y, gz + 0.5);
      else this.spawnMob(kind, gx + 0.5, y, gz + 0.5);
    }
  }

  /** Which of `kinds` suit the biome a spawn attempt landed in. */
  private spawnPool(kinds: MobKind[], label: string): MobKind[] {
    const snowy = label === 'snow' || label === 'ice_spikes' || label === 'snowy_taiga';
    const arid = label === 'desert' || label === 'badlands';
    return kinds.filter((k) => {
      switch (k) {
        case 'rabbit': return snowy || arid || label === 'meadow' || label === 'flower_forest' || label === 'taiga'
          || label === 'old_growth_taiga' || label === 'birch_forest' || label === 'savanna';
        case 'pig': case 'sheep': return !arid && label !== 'jungle' && label !== 'dark_forest';
        case 'cow': case 'chicken': return !arid && label !== 'ice_spikes';
        case 'wolf': return label.includes('taiga') || label === 'forest' || label === 'birch_forest' || snowy;
        case 'horse': return label === 'plains' || label === 'savanna' || label === 'meadow';
        default: return true;
      }
    });
  }

  /** Biome-matched coat: warm/cold farm-animal variants, rabbit fur by terrain. */
  private climateVariant(kind: MobKind, wx: number, wz: number, label: string): number | null {
    if (kind === 'rabbit') {
      if (label === 'snow' || label === 'ice_spikes' || label === 'snowy_taiga') return Math.random() < 0.8 ? 1 : 3;
      if (label === 'desert' || label === 'badlands') return 2;
      return Math.random() < 0.6 ? 0 : Math.random() < 0.5 ? 4 : 3;
    }
    if (kind !== 'pig' && kind !== 'cow' && kind !== 'chicken') return null;
    const t = this.world.generator.temperatureAt(wx, wz);
    return t > 0.6 ? 1 : t < 0.36 ? 2 : 0;
  }

  /** A bat in a dark open cave pocket near the player. */
  private batSpawn(): void {
    const p = this.player!;
    const ang = Math.random() * Math.PI * 2, r = 8 + Math.random() * 20;
    const wx = Math.floor(p.pos.x + Math.cos(ang) * r), wz = Math.floor(p.pos.z + Math.sin(ang) * r);
    const chunk = this.world.getChunk(Math.floor(wx / 16), Math.floor(wz / 16));
    if (!chunk || !chunk.ready) return;
    const h = chunk.heightmap[(wz & 15) * 16 + (wx & 15)];
    const wy = 12 + Math.floor(Math.random() * Math.max(4, h - 20));
    for (let dy = 0; dy < 3; dy++) if (this.world.getBlock(wx, wy + dy, wz) !== B.AIR) return;
    if (this.world.skyLight(wx, wy, wz) >= 0.3 || this.world.anyTorchNear(wx, wy, wz, 6)) return;
    this.spawnMob('bat', wx + 0.5, wy + 1, wz + 0.5);
  }

  // --- combat -----------------------------------------------------------------

  raycastMobs(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number):
    { entity: Entity; dist: number } | null {
    let best: { entity: Entity; dist: number } | null = null;
    for (const e of this.entities) {
      if (!this.isMob(e) || e.dead) continue;
      const hw = e.box.w / 2 + 0.1;
      const t = rayAABB(
        ox, oy, oz, dx, dy, dz,
        e.pos.x - hw, e.pos.y - 0.1, e.pos.z - hw,
        e.pos.x + hw, e.pos.y + e.box.h + 0.1, e.pos.z + hw,
      );
      if (t !== null && t <= maxDist && (!best || t < best.dist)) {
        best = { entity: e, dist: t };
      }
    }
    return best;
  }

  hurt(e: Entity, dmg: number, kbX: number, kbZ: number, attacker?: Entity | Player, crit = false): void {
    if (e.dead || !this.isMob(e)) return;
    if (e.armorTier > 0) dmg *= 0.5; // iron horse barding halves damage
    e.hp -= dmg;
    e.hurtFlash = 0.35;
    if (e.kind === 'spider') {
      if (e.angryT <= 0) this.spawnAngry(e.pos.x, e.pos.y + e.box.h + 0.2, e.pos.z);
      e.angryT = 12;
    }
    // a hit pet pauses regen briefly before healing again
    if (this.isPet(e)) e.regenT = 6;
    const len = Math.hypot(kbX, kbZ) || 1;
    e.vel.x += (kbX / len) * 7;
    e.vel.z += (kbZ / len) * 7;
    e.vel.y = Math.max(e.vel.y, 5);
    e.kbX = kbX / len; e.kbZ = kbZ / len;
    e.grazeT = 0;
    this.audio.play('hit');
    this.audio.mobSound(e.kind as string, 0.85, e.hp <= 0 ? 'death' : 'hurt');
    if (e.kind === 'wolf' && !e.tamed && attacker === this.player) {
      // strike a wild wolf and the whole pack turns on you (vanilla)
      for (const o of this.entities) {
        if (o.kind !== 'wolf' || o.tamed || o.dead) continue;
        if (o !== e && Math.hypot(o.pos.x - e.pos.x, o.pos.z - e.pos.z) > 16) continue;
        if (o.angryT <= 0) this.spawnAngry(o.pos.x, o.pos.y + o.box.h + 0.2, o.pos.z);
        o.angryT = 25;
        o.state = 'chase';
        o.sitting = false;
      }
    } else if (!MOB_STATS[e.kind as MobKind].hostile || e.baby) {
      e.state = 'flee';
      e.stateTime = 5;
      e.yaw = Math.atan2(-kbX, -kbZ); // run along the knockback direction
    }
    // strike a piglin or a zombified piglin and its whole crowd turns on you
    if ((e.kind === 'piglin' || e.kind === 'zombified_piglin') && !e.tamed && !this.isPet(e)
      && (attacker === this.player || (attacker !== undefined && this.isMob(attacker as Entity) && (attacker as Entity).tamed))) {
      this.provoke(e);
    }
    // owner (or an owned pet) hit this mob -> all idle pets lock onto it
    const byOwner = attacker === this.player
      || (attacker !== undefined && this.isMob(attacker as Entity) && (attacker as Entity).tamed);
    if (byOwner && !this.isPet(e)) {
      for (const pet of this.entities) {
        if (this.isPet(pet) && !pet.target && !pet.sitting) pet.target = e;
      }
    }
    // a wild mob mauled a pet -> the pet fights back and the pair lock on
    if (this.isPet(e) && attacker !== undefined && attacker !== this.player
      && this.isMob(attacker as Entity) && !(attacker as Entity).tamed) {
      const wild = attacker as Entity;
      if (!e.sitting) e.target = wild;
      wild.foe = e;
    }
    if (e.hp <= 0) this.killMob(e);
    if (attacker === this.player) this.onPlayerHit?.(e.pos, dmg, crit, e.dead);
  }

  /** A mob's health hit zero: loot, forget it as anyone's quarry, and hand its
   *  mesh to the death topple (the poof comes when that finishes). */
  private killMob(e: Entity): void {
    const wasPet = this.isPet(e);
    e.dead = true;
    this.dropLoot(e);
    // a slain magma cube bursts into two to four of the next size down
    if (e.kind === 'magma_cube' && e.variant > 0) {
      const n = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + Math.random();
        const c = this.spawnMob('magma_cube', e.pos.x + Math.cos(a) * e.box.w * 0.25, e.pos.y + 0.2,
          e.pos.z + Math.sin(a) * e.box.w * 0.25, e.variant - 1);
        c.vel = { x: Math.cos(a) * 2.5, y: 5, z: Math.sin(a) * 2.5 };
        c.shootCooldown = 0.6 + Math.random() * 0.6;
        if (e.tamed) { c.tamed = true; c.ownerName = e.ownerName; }
      }
    }
    this.clearFoe(e);
    e.corpse = true;
    e.mesh.traverse((o) => { if (o.userData.shadow) o.visible = false; });
    this.corpses.push({ mesh: e.mesh, mats: e.materials, t: 0, w: e.box.w, x: e.pos.x, y: e.pos.y, z: e.pos.z });
    if (wasPet) this.onToast?.(`Your ${mobLabel(e.kind as string)} was slain`);
    this.onKill?.(e.kind as string);
  }

  /** The player was hurt by `source` -> all idle pets retaliate against it. */
  onOwnerHurt(source: Entity): void {
    if (!this.isMob(source)) return;
    for (const pet of this.entities) {
      if (this.isPet(pet) && !pet.target && !pet.sitting) pet.target = source;
    }
  }

  private dropLoot(e: Entity): void {
    const at = (id: number, min: number, max: number): void => {
      const n = min + Math.floor(Math.random() * (max - min + 1));
      if (n > 0) this.spawnDrop(e.pos.x, e.pos.y + 0.4, e.pos.z, id, n);
    };
    switch (e.kind) {
      case 'pig': at(I.PORKCHOP, 1, 2); break;
      case 'chicken': at(I.CHICKEN, 1, 1); at(I.FEATHER, 0, 2); break;
      case 'sheep': at(I.MUTTON, 1, 2); at(B.WOOL, 1, 1); break;
      case 'cow': at(I.BEEF, 1, 2); at(I.LEATHER, 0, 2); break;
      case 'horse': at(I.LEATHER, 0, 2); break;
      case 'zombie': at(I.ROTTEN_FLESH, 0, 2); break;
      case 'skeleton': at(I.ARROW, 0, 2); at(I.BONE, 0, 2); break;
      case 'spider': at(I.STRING, 0, 2); break;
      case 'creeper': at(I.GUNPOWDER, 1, 2); break;
      case 'wolf': if (!e.tamed) at(I.BONE, 1, 2); break;
      case 'villager': break; // villagers drop nothing
      case 'phantom': at(I.ROTTEN_FLESH, 0, 1); break;
      case 'cinderling': at(I.QUARTZ, 0, 1); at(I.COAL, 0, 1); break;
      case 'ashstalker': at(I.COAL, 1, 2); at(I.BONE, 0, 1); break;
      case 'emberghast': at(I.QUARTZ, 1, 2); at(B.GLOWSTONE, 0, 1); at(I.GHAST_TEAR, 0, 1); break;
      // nether denizens (vanilla tables; babies drop nothing)
      case 'piglin':
        if (e.baby) break;
        if (!(e.variant & 1) && Math.random() < 0.085) at(I.GOLD_SWORD, 1, 1);
        if ((e.variant & 2) && Math.random() < 0.085) at(I.GOLD_HELMET, 1, 1);
        break;
      case 'zombified_piglin':
        if (e.baby) break;
        at(I.ROTTEN_FLESH, 0, 1); at(I.GOLD_NUGGET, 0, 1);
        if (Math.random() < 0.025) at(I.GOLD_INGOT, 1, 1);
        if (Math.random() < 0.085) at(I.GOLD_SWORD, 1, 1);
        break;
      case 'hoglin': if (!e.baby) { at(I.PORKCHOP, 2, 4); at(I.LEATHER, 0, 1); } break;
      case 'strider': if (!e.baby) at(I.STRING, 2, 5); if (e.saddled) at(I.SADDLE, 1, 1); break;
      case 'blaze': at(I.BLAZE_ROD, 0, 1); break;
      case 'wither_skeleton':
        at(I.COAL, 0, 1); at(I.BONE, 0, 2);
        if (Math.random() < 0.025) at(I.WITHER_SKULL, 1, 1);
        if (Math.random() < 0.085) at(I.STONE_SWORD, 1, 1);
        break;
      case 'magma_cube': if (e.variant > 0) at(I.MAGMA_CREAM, 0, 1); break;
      case 'rabbit': at(I.LEATHER, 0, 1); break; // rabbit hide
      case 'bat': break;
      default: break;
    }
  }

  /** Any living hostile mob within `r` blocks of (x,y,z)? Gates sleeping. */
  hostileNear(x: number, y: number, z: number, r: number): boolean {
    const r2 = r * r;
    for (const e of this.entities) {
      if (!this.isMob(e) || e.dead) continue;
      if (!MOB_STATS[e.kind as MobKind].hostile) continue;
      const dx = e.pos.x - x, dy = e.pos.y - y, dz = e.pos.z - z;
      if (dx * dx + dy * dy + dz * dz <= r2) return true;
    }
    return false;
  }

  /** Used to block placement inside mobs. */
  anyMobIntersecting(bx: number, by: number, bz: number): boolean {
    for (const e of this.entities) {
      if (!this.isMob(e)) continue;
      const hw = e.box.w / 2;
      if (e.pos.x + hw > bx && e.pos.x - hw < bx + 1 &&
        e.pos.y + e.box.h > by && e.pos.y < by + 1 &&
        e.pos.z + hw > bz && e.pos.z - hw < bz + 1) return true;
    }
    return false;
  }

  /** Mobs OR dropped items overlapping a block — used by pressure plates, which
   *  (like wooden plates) are tripped by entities resting on them, not just by
   *  the player. */
  anyEntityOnBlock(bx: number, by: number, bz: number): boolean {
    for (const e of this.entities) {
      if (!this.isMob(e) && e.kind !== 'drop') continue;
      const hw = e.box.w / 2;
      if (e.pos.x + hw > bx && e.pos.x - hw < bx + 1 &&
        e.pos.y + e.box.h > by && e.pos.y < by + 0.5 &&
        e.pos.z + hw > bz && e.pos.z - hw < bz + 1) return true;
    }
    return false;
  }

  /** Right-click interaction with the targeted mob.
   *  Returns the interaction kind (the player consumes items / opens UI). */
  interactMob(e: Entity, heldId: number):
    'tamed' | 'sit' | 'trade' | 'mount' | 'love' | 'saddle' | 'armor' | null {
    // a captured pet obeys stay/follow like a tamed wolf does
    if (this.isPet(e)) {
      e.sitting = !e.sitting;
      if (e.sitting) e.target = null;
      return 'sit';
    }
    // shears (whenever the item registry has them) clip a sheep's fleece for
    // 1-3 wool; it grows back after the sheep grazes
    // hand a piglin gold: it admires it, then barters something back
    if (e.kind === 'piglin' && heldId === I.GOLD_INGOT && !e.baby && e.admireT <= 0 && !e.tamed) {
      this.startAdmire(e);
      return 'saddle'; // consumes the ingot, same feedback as fitting tack
    }
    // striders take a saddle, then carry you across the lava
    if (e.kind === 'strider' && !e.baby) {
      if (heldId === I.SADDLE && !e.saddled) { this.saddleStrider(e); return 'saddle'; }
      if (e.saddled && !this.canBreed(e, heldId)) return 'mount';
    }
    const shears = (I as unknown as Record<string, number | undefined>).SHEARS;
    if (e.kind === 'sheep' && shears !== undefined && heldId === shears && !e.sheared && !e.baby) {
      e.sheared = true;
      this.spawnDrop(e.pos.x, e.pos.y + 1, e.pos.z, B.WOOL, 1 + Math.floor(Math.random() * 3));
      this.audio.play('snap');
      return 'sit'; // same feedback as sit/stay: a click and a short use cooldown
    }
    // feeding an adult its breeding food puts it into love mode
    if (this.canBreed(e, heldId)) {
      e.loveT = 22;
      this.spawnHearts(e.pos.x, e.pos.y + e.box.h * 0.7, e.pos.z);
      return 'love';
    }
    if (e.kind === 'wolf') {
      if (heldId === I.BONE && !e.tamed) {
        if (Math.random() < 0.34) {
          e.tamed = true; e.ownerName = 'player';
          this.spawnHearts(e.pos.x, e.pos.y + 0.7, e.pos.z);
          return 'tamed';
        }
        this.spawnSmoke(e.pos.x, e.pos.y + 0.8, e.pos.z, 3); // not this time
        return null;
      }
      if (e.tamed) { e.sitting = !e.sitting; return 'sit'; }
      return null;
    }
    if (e.kind === 'cat') {
      if ((heldId === I.RAW_FISH || heldId === I.COOKED_FISH) && !e.tamed) {
        if (Math.random() < 0.4) {
          e.tamed = true; e.ownerName = 'player';
          this.spawnHearts(e.pos.x, e.pos.y + 0.5, e.pos.z);
          return 'tamed';
        }
        this.spawnSmoke(e.pos.x, e.pos.y + 0.6, e.pos.z, 3);
        return null;
      }
      if (e.tamed) { e.sitting = !e.sitting; return 'sit'; }
      return null;
    }
    if (e.kind === 'horse') {
      // a tamed horse can be saddled / armored; otherwise right-click mounts
      if (e.tamed && heldId === I.SADDLE && !e.saddled) { this.saddleHorse(e); return 'saddle'; }
      if (e.tamed && heldId === I.HORSE_ARMOR && e.armorTier === 0) { this.armorHorse(e, 1); return 'armor'; }
      return 'mount';
    }
    if (e.kind === 'villager') {
      if (e.trades.length === 0) this.rollVillagerTrades(e);
      return 'trade';
    }
    return null;
  }

  /** Breeding food: the fixed table, plus the nether fungi (registered by the
   *  nether-biome blocks, so looked up by name) for hoglins and striders. */
  private foodsFor(kind: MobKind): number[] | undefined {
    if (kind === 'hoglin') { const id = firstId('crimson_fungus', 'crimson_roots'); return id >= 0 ? [id] : undefined; }
    if (kind === 'strider') { const id = firstId('warped_fungus', 'warped_roots'); return id >= 0 ? [id] : undefined; }
    return BREED_FOOD[kind];
  }

  /** Does the player's held item tempt this animal into following? */
  private isLureFood(kind: MobKind, heldId: number): boolean {
    if (!heldId) return false;
    const foods = kind === 'strider' || kind === 'hoglin' ? this.foodsFor(kind)
      : kind === 'piglin' ? [I.GOLD_INGOT] : LURE_FOOD[kind];
    return !!foods && foods.includes(heldId);
  }

  /** Is this animal a breedable adult and is `heldId` its food? */
  private canBreed(e: Entity, heldId: number): boolean {
    if (e.baby || e.loveT > 0 || e.breedCooldown > 0) return false;
    const foods = this.foodsFor(e.kind as MobKind);
    if (!foods || !foods.includes(heldId)) return false;
    if (BREED_NEEDS_TAME.has(e.kind as MobKind) && !e.tamed) return false;
    return true;
  }

  /** Put a saddle on a tamed horse (visual + handled flag for a speed boost). */
  private saddleHorse(e: Entity): void {
    e.saddled = true;
    // rides on the barrel group so it rears with the horse
    const host = e.limbs?.body ?? e.mesh;
    const leather = new THREE.MeshLambertMaterial({ color: 0x6a4526 });
    const dark = new THREE.MeshLambertMaterial({ color: 0x3a2614 });
    const metal = new THREE.MeshLambertMaterial({ color: 0xb8b8c0 });
    const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      b.position.set(x, y, z);
      host.add(b);
    };
    box(0.66, 0.08, 0.62, leather, 0, 1.4, 0.1);    // seat pad
    box(0.3, 0.12, 0.12, dark, 0, 1.48, -0.18);     // pommel
    box(0.3, 0.1, 0.08, dark, 0, 1.47, 0.38);       // cantle
    box(0.68, 0.62, 0.1, dark, 0, 1.1, 0.02);       // girth strap
    for (const sx of [-1, 1]) box(0.04, 0.1, 0.1, metal, sx * 0.36, 0.86, 0.02); // stirrups
    this.spawnHearts(e.pos.x, e.pos.y + 1.6, e.pos.z);
  }

  /** Saddle a strider: a leather seat strapped on its back. It needs no
   *  taming (tamed with no owner: kept from despawning, never a pet). */
  private saddleStrider(e: Entity): void {
    e.saddled = true;
    e.tamed = true;
    e.ownerName = null;
    const host = e.limbs?.body ?? e.mesh;
    const leather = new THREE.MeshLambertMaterial({ color: 0x6a4526 });
    const dark = new THREE.MeshLambertMaterial({ color: 0x3a2614 });
    const metal = new THREE.MeshLambertMaterial({ color: 0xb8b8c0 });
    const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number): void => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      b.position.set(x, y, z);
      host.add(b);
    };
    box(0.62, 0.08, 0.66, leather, 0, 1.9, 0.05);   // seat pad
    box(0.3, 0.12, 0.1, dark, 0, 1.98, -0.24);      // pommel
    box(0.3, 0.1, 0.08, dark, 0, 1.97, 0.34);       // cantle
    box(1.04, 0.5, 0.1, dark, 0, 1.66, 0.05);       // girth strap
    for (const sx of [-1, 1]) box(0.05, 0.1, 0.1, metal, sx * 0.53, 1.42, 0.05); // stirrups
    this.spawnHearts(e.pos.x, e.pos.y + 2, e.pos.z);
  }

  /** Can the player ride this mob (horse, or a saddled strider)? */
  isMount(e: Entity): boolean {
    return e.kind === 'horse' || (e.kind === 'strider' && e.saddled);
  }

  /** Rider seat height above the mount's feet. */
  mountSeat(e: Entity): number {
    return e.kind === 'strider' ? 1.62 * e.mesh.scale.y : 0.9;
  }

  /** Fit iron barding on a tamed horse (visual + damage-resist flag). */
  private armorHorse(e: Entity, tier: number): void {
    e.armorTier = tier;
    const iron = new THREE.MeshLambertMaterial({ color: 0xcfcfd6 });
    const host = e.limbs?.body ?? e.mesh;
    const chest = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.68, 0.72), iron);
    chest.position.set(0, 1.06, -0.26);
    host.add(chest);
    // neck plate rides the neck group so it follows head turns
    const neckGroup = e.limbs?.head?.children[0] ?? host;
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.78, 0.48), iron);
    plate.position.set(0, 0.31, -0.06);
    neckGroup.add(plate);
    this.spawnHearts(e.pos.x, e.pos.y + 1.6, e.pos.z);
  }

  /** Spawn a baby animal (scaled down, grows up after a delay). */
  spawnBaby(kind: MobKind, x: number, y: number, z: number): Entity {
    const e = this.spawnMob(kind, x, y, z);
    e.baby = true;
    e.growT = 45;
    e.mesh.scale.setScalar(0.55);
    // babies are mostly head: a big noggin on a small body reads as "young"
    if (e.limbs?.head) e.limbs.head.scale.setScalar(kind === 'horse' ? 1.25 : 1.6);
    e.box = { w: e.box.w * 0.6, h: e.box.h * 0.6 };
    return e;
  }

  // --- horse riding -----------------------------------------------------------

  /** Player mounts a horse. Untamed horses start a buck-off. */
  mountHorse(e: Entity): void {
    e.ridden = true;
    e.sitting = false;
    e.vel.x = 0; e.vel.z = 0;
    if (!e.tamed) e.bucking = 1.5 + Math.random() * 1.3;
  }

  /** Player dismounts; clears the rider state and any rear pose. */
  dismountHorse(e: Entity): void {
    e.ridden = false;
    e.bucking = 0;
    if (e.limbs?.body) e.limbs.body.rotation.x = 0;
  }

  /** Drive a ridden horse from player input. Returns true if the rider was
   *  bucked off (an untamed horse that finished its buck without taming). */
  rideHorse(e: Entity, dt: number, fwd: number, strafe: number, lookYaw: number, jump: boolean): boolean {
    const p = this.player!;
    // untamed: rear + hop in place, then either tame or throw the rider
    if (e.bucking > 0) {
      e.bucking -= dt;
      if (e.onGround && Math.random() < dt * 6) e.vel.y = JUMP_V * 0.7;
      this.applyGroundMove(e, dt, 0, 0, 0);
      if (e.limbs?.body) e.limbs.body.rotation.x = -0.4 + Math.sin(e.age * 20) * 0.18;
      this.placeMob(e, dt);
      if (e.bucking <= 0) {
        if (e.limbs?.body) e.limbs.body.rotation.x = 0;
        if (Math.random() < 0.4) {
          e.tamed = true; e.ownerName = 'player';
          this.spawnHearts(e.pos.x, e.pos.y + 1.6, e.pos.z);
          this.audio.play('level');
          return false; // tamed: stay mounted
        }
        this.spawnPoof(e.pos.x, e.pos.y + 1, e.pos.z);
        return true; // thrown off
      }
      return false;
    }

    // tamed: steer relative to where the player looks
    const sin = Math.sin(lookYaw), cos = Math.cos(lookYaw);
    let wishX = -sin * fwd + cos * strafe;
    let wishZ = -cos * fwd - sin * strafe;
    const len = Math.hypot(wishX, wishZ);
    if (len > 1) { wishX /= len; wishZ /= len; }
    if (len > 0.01) e.yaw = lookYaw;
    const speed = e.kind === 'strider'
      ? e.moveSpeed * (fwd > 0 ? 1.9 : 1.2) * (e.cold ? 0.45 : 1) // a strider plods; lava is its road
      : e.moveSpeed * (fwd > 0 ? 2.4 : 1.5) * (e.saddled ? 1.18 : 1); // saddle = faster gallop
    const res = this.applyGroundMove(e, dt, wishX, wishZ, speed);
    if (jump && e.onGround) e.vel.y = JUMP_V * 1.15;
    else if ((res.hitX || res.hitZ) && e.onGround && (wishX !== 0 || wishZ !== 0)) e.vel.y = JUMP_V;
    this.animateMob(e, dt, p);
    // hoofbeats while galloping on the ground
    if (e.kind === 'horse' && e.onGround && Math.hypot(e.vel.x, e.vel.z) > 1.5) {
      e.restT -= dt;
      if (e.restT <= 0) { e.restT = 0.3; this.audio.play('hoof'); }
    }
    e.visYaw = e.yaw; // the rider's view drives the horse: no easing lag
    this.placeMob(e, dt);
    return false;
  }

  /** Floating heart particles shown when an animal is tamed. */
  spawnHearts(x: number, y: number, z: number): void {
    let mat = this.particleMats.get('heart');
    if (!mat) {
      const c = document.createElement('canvas');
      c.width = 8; c.height = 8;
      const ctx = c.getContext('2d')!;
      ctx.clearRect(0, 0, 8, 8);
      ctx.fillStyle = '#e23a4a';
      const rows = ['01101100', '11111110', '11111110', '11111110', '01111100', '00111000', '00010000', '00000000'];
      for (let yy = 0; yy < 8; yy++) {
        for (let xx = 0; xx < 8; xx++) if (rows[yy][xx] === '1') ctx.fillRect(xx, yy, 1, 1);
      }
      const tex = new THREE.CanvasTexture(c);
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
      this.particleMats.set('heart', mat);
    }
    for (let i = 0; i < 5; i++) {
      const mesh = new THREE.Group();
      mesh.add(new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.22), mat));
      const e = new Entity('particle',
        { x: x + (Math.random() - 0.5) * 0.5, y: y + Math.random() * 0.4, z: z + (Math.random() - 0.5) * 0.5 },
        { w: 0.05, h: 0.05 }, mesh);
      e.vel = { x: (Math.random() - 0.5) * 0.4, y: 0.7 + Math.random() * 0.5, z: (Math.random() - 0.5) * 0.4 };
      e.maxLife = e.life = 0.9 + Math.random() * 0.4;
      e.pGrav = -1.4; // float upward
      this.entities.push(e);
      this.scene.add(mesh);
    }
  }

  /** Billboard particles from a small painted sprite (cached per key). */
  private spriteParticles(key: string, paint: (ctx: CanvasRenderingContext2D) => void, n: number,
    x: number, y: number, z: number, spread: number, size: number, vy: number, life: number, grav: number): void {
    let mat = this.particleMats.get(key);
    if (!mat) {
      const c = document.createElement('canvas');
      c.width = 8; c.height = 8;
      const ctx = c.getContext('2d')!;
      ctx.clearRect(0, 0, 8, 8);
      paint(ctx);
      const tex = new THREE.CanvasTexture(c);
      tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter;
      mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
      this.particleMats.set(key, mat);
    }
    for (let i = 0; i < n; i++) {
      const mesh = new THREE.Group();
      const sz = size * (0.8 + Math.random() * 0.4);
      mesh.add(new THREE.Mesh(new THREE.PlaneGeometry(sz, sz), mat));
      const e = new Entity('particle',
        { x: x + (Math.random() - 0.5) * spread, y: y + Math.random() * spread * 0.5, z: z + (Math.random() - 0.5) * spread },
        { w: 0.05, h: 0.05 }, mesh);
      e.vel = { x: (Math.random() - 0.5) * 0.5, y: vy * (0.7 + Math.random() * 0.6), z: (Math.random() - 0.5) * 0.5 };
      e.maxLife = e.life = life * (0.8 + Math.random() * 0.4);
      e.pGrav = grav;
      this.entities.push(e);
      this.scene.add(mesh);
    }
  }

  /** Angry storm-cloud puffs over a mob that has turned on the player. */
  spawnAngry(x: number, y: number, z: number): void {
    this.spriteParticles('angry', (ctx) => {
      ctx.fillStyle = '#3a3a40';
      ctx.fillRect(1, 2, 6, 3); ctx.fillRect(2, 1, 4, 5); ctx.fillRect(0, 3, 8, 1);
      ctx.fillStyle = '#56565e'; ctx.fillRect(2, 1, 2, 1); ctx.fillRect(1, 2, 2, 1);
      ctx.fillStyle = '#e8322a'; ctx.fillRect(3, 5, 1, 1); ctx.fillRect(4, 6, 1, 1); ctx.fillRect(3, 7, 1, 1); // lightning jag
    }, 3, x, y, z, 0.6, 0.3, 0.5, 1.1, -0.6);
  }

  /** Grey smoke puffs (creeper hiss, snuffed flames). */
  spawnSmoke(x: number, y: number, z: number, n = 5): void {
    this.spriteParticles('smoke', (ctx) => {
      ctx.fillStyle = 'rgba(90,90,90,0.85)';
      ctx.fillRect(2, 1, 4, 6); ctx.fillRect(1, 2, 6, 4);
      ctx.fillStyle = 'rgba(140,140,140,0.9)'; ctx.fillRect(2, 2, 2, 2);
    }, n, x, y, z, 0.5, 0.26, 0.9, 0.9, -1.2);
  }

  /** Gold sparkle burst for a critical hit. */
  spawnCritParticles(x: number, y: number, z: number): void {
    let mat = this.particleMats.get('crit');
    if (!mat) {
      const c = document.createElement('canvas');
      c.width = 6; c.height = 6;
      const ctx = c.getContext('2d')!;
      ctx.clearRect(0, 0, 6, 6);
      ctx.fillStyle = '#ffd24a';
      ctx.fillRect(2, 0, 2, 6); ctx.fillRect(0, 2, 6, 2); // a small spark/plus
      const tex = new THREE.CanvasTexture(c);
      tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter;
      mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
      this.particleMats.set('crit', mat);
    }
    for (let i = 0; i < 8; i++) {
      const mesh = new THREE.Group();
      mesh.add(new THREE.Mesh(new THREE.PlaneGeometry(0.14, 0.14), mat));
      const e = new Entity('particle',
        { x: x + (Math.random() - 0.5) * 0.4, y: y + (Math.random() - 0.5) * 0.4, z: z + (Math.random() - 0.5) * 0.4 },
        { w: 0.04, h: 0.04 }, mesh);
      const a = Math.random() * Math.PI * 2, sp = 0.7 + Math.random() * 0.9;
      e.vel = { x: Math.cos(a) * sp, y: 0.5 + Math.random() * 0.6, z: Math.sin(a) * sp };
      e.maxLife = e.life = 0.4 + Math.random() * 0.25;
      e.pGrav = 8; // arc up then fall back
      this.entities.push(e);
      this.scene.add(mesh);
    }
  }

  /** Amethyst swirl burst for capturing / recalling a mob into a catcher.
   *  `n` trades burst size for trail sparkles (a thrown orb emits 1 at a time). */
  spawnCaptureSparkle(x: number, y: number, z: number, n = 12): void {
    let mat = this.particleMats.get('capture');
    if (!mat) {
      const c = document.createElement('canvas');
      c.width = 6; c.height = 6;
      const ctx = c.getContext('2d')!;
      ctx.clearRect(0, 0, 6, 6);
      ctx.fillStyle = '#c9a4ff';
      ctx.fillRect(2, 0, 2, 6); ctx.fillRect(0, 2, 6, 2); // amethyst spark
      ctx.fillStyle = '#f3ecff'; ctx.fillRect(2, 2, 2, 2);
      const tex = new THREE.CanvasTexture(c);
      tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter;
      mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
      this.particleMats.set('capture', mat);
    }
    // particles spiral up out of the capture point in a tight amethyst ring
    for (let i = 0; i < n; i++) {
      const mesh = new THREE.Group();
      mesh.add(new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.16), mat));
      const a = n === 1 ? Math.random() * Math.PI * 2 : (i / n) * Math.PI * 2;
      const sp = 1.2 + Math.random() * 0.6;
      const rad = n === 1 ? 0.12 : 0.5; // trail sparks hug the orb
      const e = new Entity('particle',
        { x: x + Math.cos(a) * rad, y: y + Math.random() * 0.3, z: z + Math.sin(a) * rad },
        { w: 0.04, h: 0.04 }, mesh);
      e.vel = { x: -Math.cos(a) * sp, y: 1.1 + Math.random() * 0.5, z: -Math.sin(a) * sp };
      e.maxLife = e.life = 0.45 + Math.random() * 0.25;
      e.pGrav = -3; // drift upward as they converge
      this.entities.push(e);
      this.scene.add(mesh);
    }
  }

  /** Generate 3–4 randomized emerald trades for a villager. */
  private rollVillagerTrades(e: Entity): void {
    // [give item/count] -> [get item/count]
    const offers: { give: number; giveCount: number; get: number; getCount: number; weight: number }[] = [
      { give: I.EMERALD, giveCount: 1, get: I.BREAD, getCount: 3, weight: 3 },
      { give: I.EMERALD, giveCount: 1, get: I.ARROW, getCount: 8, weight: 2 },
      { give: I.EMERALD, giveCount: 2, get: I.IRON_INGOT, getCount: 4, weight: 2 },
      { give: I.EMERALD, giveCount: 3, get: I.DIAMOND, getCount: 1, weight: 1 },
      { give: I.EMERALD, giveCount: 1, get: I.COOKED_BEEF, getCount: 2, weight: 3 },
      { give: I.EMERALD, giveCount: 1, get: I.CARROT, getCount: 6, weight: 2 },
      { give: I.EMERALD, giveCount: 1, get: I.POTATO, getCount: 6, weight: 2 },
      { give: I.EMERALD, giveCount: 1, get: I.BEETROOT_SEEDS, getCount: 5, weight: 2 },
      { give: I.EMERALD, giveCount: 2, get: I.BOW, getCount: 1, weight: 1 },
      { give: I.WHEAT, giveCount: 20, get: I.EMERALD, getCount: 1, weight: 2 },
      { give: I.CARROT, giveCount: 18, get: I.EMERALD, getCount: 1, weight: 2 },
      { give: I.POTATO, giveCount: 18, get: I.EMERALD, getCount: 1, weight: 2 },
      { give: I.BEETROOT, giveCount: 15, get: I.EMERALD, getCount: 1, weight: 2 },
      { give: I.COAL, giveCount: 10, get: I.EMERALD, getCount: 1, weight: 2 },
      { give: I.IRON_INGOT, giveCount: 4, get: I.EMERALD, getCount: 1, weight: 2 },
    ];
    const total = offers.reduce((s, o) => s + o.weight, 0);
    const n = 3 + Math.floor(Math.random() * 2);
    const picked = new Set<number>();
    e.trades = [];
    for (let i = 0; i < n; i++) {
      let r = Math.random() * total;
      let idx = 0;
      for (let j = 0; j < offers.length; j++) { r -= offers[j].weight; if (r <= 0) { idx = j; break; } }
      if (picked.has(idx)) { i--; continue; }
      picked.add(idx);
      const o = offers[idx];
      e.trades.push({ give: o.give, giveCount: o.giveCount, get: o.get, getCount: o.getCount, uses: 0, max: 12 });
    }
  }

  counts(): { mobs: number; drops: number; other: number } {
    let mobs = 0, drops = 0, other = 0;
    for (const e of this.entities) {
      if (this.isMob(e)) mobs++;
      else if (e.kind === 'drop') drops++;
      else other++;
    }
    return { mobs, drops, other };
  }

  clear(): void {
    for (const e of this.entities) {
      this.scene.remove(e.mesh);
      disposeGroup(e.mesh);
    }
    this.entities = [];
    for (const c of this.corpses) {
      this.scene.remove(c.mesh);
      disposeGroup(c.mesh);
    }
    this.corpses = [];
  }

  // --- mesh building --------------------------------------------------------------

  /** Textured cube for drops, falling blocks, and primed TNT. */
  private makeBlockMesh(blockId: number, size: number): THREE.Mesh {
    const shaped = shapedItemGeometry(blockId, this.atlas, size); // slabs, stairs, fences ...
    if (shaped) return new THREE.Mesh(shaped, new THREE.MeshLambertMaterial({ map: this.atlas.texture, alphaTest: 0.35, vertexColors: true }));
    const d = def(blockId);
    const geo = new THREE.BoxGeometry(size, size, size);
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    const names = [
      d.faces!.sides, d.faces!.sides, d.faces!.top,
      d.faces!.bottom, d.faces!.front ?? d.faces!.sides, d.faces!.sides,
    ];
    for (let f = 0; f < 6; f++) {
      const r = this.atlas.rect(names[f]);
      const us = [r.u0, r.u1, r.u0, r.u1];
      const vs = [r.v0, r.v0, r.v1, r.v1];
      for (let v = 0; v < 4; v++) uv.setXY(f * 4 + v, us[v], vs[v]);
    }
    uv.needsUpdate = true;
    return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: this.atlas.texture, alphaTest: 0.35 }));
  }

  private buildDropMesh(itemId: number, mob?: string): THREE.Group {
    const g = new THREE.Group();
    const d = def(itemId);
    if (d.block && BLOCK_SPRITE_ICONS.has(d.name)) {
      // cake, flower pot, campfire: tumble as their item sprite
      const sprite = this.atlas.sprite(d.name);
      if (sprite) g.add(new THREE.Mesh(extrudeSpriteGeometry(sprite, 0.34), new THREE.MeshLambertMaterial({ vertexColors: true })));
    } else if (d.block && (CROSS_BLOCKS.has(itemId) || itemId === B.TORCH || itemId === B.LANTERN)) {
      // plants and torches drop as flat sprites of their tile
      const tex = new THREE.CanvasTexture(this.atlas.tileCanvas(d.faces!.sides));
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      g.add(new THREE.Mesh(
        new THREE.PlaneGeometry(0.35, 0.35),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.1, side: THREE.DoubleSide }),
      ));
    } else if (d.block && d.faces) {
      g.add(this.makeBlockMesh(itemId, 0.25));
    } else if (d.sprite || spriteNameFor(itemId, mob)) {
      // dropped items tumble as real 3D voxel models
      const sprite = this.atlas.sprite(spriteNameFor(itemId, mob) ?? d.sprite!);
      if (sprite) {
        g.add(new THREE.Mesh(
          extrudeSpriteGeometry(sprite, 0.34),
          new THREE.MeshLambertMaterial({ vertexColors: true }),
        ));
      }
    }
    return g;
  }
}

function disposeGroup(g: THREE.Object3D): void {
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
  });
}

/** Thrown-catcher phases + the capture/release/recall effects' state. */
interface OrbState {
  phase: 'windup' | 'fly' | 'absorb' | 'fall' | 'wobble' | 'spark' | 'recall' | 'release';
  t: number;
  rig: OrbRig | null;
  /** ground-contact pivot the wobble rocks on */
  pivot?: THREE.Group;
  wobbles: number;
  lastWob?: number;
  trail?: number;
  bounced?: boolean;
  /** captured / recalled / released mob kind */
  mob?: string;
  /** a captured or recalled mob's mesh, parented under the effect while it's drawn in */
  victim?: THREE.Object3D;
  victimMats?: THREE.MeshLambertMaterial[];
  vFrom?: Vec3;
  vH?: number;
  hover?: Vec3;
  back?: Vec3;
  beam?: THREE.Mesh;
  // sparks
  size?: number;
  home?: Vec3;
  spin?: number;
  // release
  pet?: Entity;
  from?: Vec3;
  to?: Vec3;
  popped?: boolean;
  grown?: boolean;
}

const UP = new THREE.Vector3(0, 1, 0);
const TMP_V = new THREE.Vector3();
