// Entities: item drops (hover + magnetize + pickup), mobs (pig, chicken,
// sheep, cow, zombie, skeleton, spider, creeper) with hierarchical box limbs,
// sine-wave walk cycles and state-tree AI, plus arrows, primed TNT, falling
// sand/gravel, block-break particles, and the shared explosion routine.

import * as THREE from 'three';
import { World } from './World';
import { moveEntity, inWater, rayAABB, Vec3, MoveResult } from './Physics';
import { B, I, def, hasDef, CROSS_BLOCKS, spriteNameFor, CAPTURABLE, mobLabel } from './Blocks';
import { Atlas, extrudeSpriteGeometry, shapedItemGeometry, BLOCK_SPRITE_ICONS } from './Textures';
import { AudioEngine } from './Audio';
import { SEA_LEVEL } from './WorldGenerator';
import type { Player } from './Player';
import { MobModels, LimbSet, MOB_EXPOSURE, rollVariant } from './MobModels';

export type MobKind =
  | 'pig' | 'chicken' | 'sheep' | 'cow'
  | 'zombie' | 'skeleton' | 'spider' | 'creeper'
  | 'wolf' | 'villager' | 'phantom' | 'horse' | 'cat'
  | 'cinderling' | 'ashstalker' | 'emberghast';
export type EntityKind = 'drop' | MobKind | 'arrow' | 'tnt' | 'falling' | 'particle' | 'bobber' | 'catcher';

const MOB_KINDS = new Set<EntityKind>([
  'pig', 'chicken', 'sheep', 'cow',
  'zombie', 'skeleton', 'spider', 'creeper',
  'wolf', 'villager', 'phantom', 'horse', 'cat',
  'cinderling', 'ashstalker', 'emberghast',
]);
/** Nether-only hostile mobs. */
const NETHER_MOBS: MobKind[] = ['cinderling', 'ashstalker', 'emberghast'];
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
};
/** Melee mobs that deal contact damage while chasing. */
const MELEE_MOBS = new Set<MobKind>(['zombie', 'spider', 'cinderling', 'ashstalker']);

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
    const e = new Entity(kind, { x, y, z }, { ...stats.box }, mesh);
    e.limbs = limbs;
    e.hp = stats.hp;
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
    if (kind !== 'phantom' && kind !== 'emberghast') {
      e.shadow = this.makeShadow(stats.box.w);
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
   *  null if this mob can't be captured. Marks the mob dead without loot. */
  captureMob(e: Entity): string | null {
    if (!this.isMob(e) || e.dead) return null;
    if (!CAPTURABLE.has(e.kind)) return null;
    const kind = e.kind;
    e.dead = true;                 // removed by the update loop; skips loot/poof
    e.target = null;
    this.clearFoe(e);
    this.spawnCaptureSparkle(e.pos.x, e.pos.y + e.box.h * 0.5, e.pos.z);
    this.audio.play('snap');
    this.onCapture?.(kind as string);
    return kind;
  }

  /** Recall an owned pet back into a catcher. Returns its kind (or null). */
  recallPet(e: Entity): string | null {
    if (!this.isPet(e) || e.dead) return null;
    const kind = e.kind;
    e.dead = true;
    e.target = null;
    this.clearFoe(e);
    this.spawnCaptureSparkle(e.pos.x, e.pos.y + e.box.h * 0.5, e.pos.z);
    this.audio.play('snap');
    return kind;
  }

  /** Drop any references to a removed entity so nothing chases a ghost. */
  private clearFoe(gone: Entity): void {
    for (const o of this.entities) {
      if (o.foe === gone) o.foe = null;
      if (o.target === gone) o.target = null;
    }
  }

  /** Release a captured mob as a pet at the given spot. Returns the new entity. */
  releaseMob(kind: MobKind, x: number, y: number, z: number, yaw: number): Entity {
    const e = this.spawnMob(kind, x, y, z);
    e.tamed = true;
    e.ownerName = 'player';
    e.sitting = false;
    e.target = null;
    e.hp = MOB_STATS[kind].hp;     // release at full health
    e.yaw = yaw;
    this.spawnCaptureSparkle(x, y + 0.4, z);
    this.spawnHearts(x, y + 0.7, z);
    this.audio.play('pop');
    return e;
  }

  // --- thrown capture orb -------------------------------------------------------

  /** How far off-centre a thrown orb may pass a mob and still catch it. Generous
   *  on purpose: the orb arcs, so a strict hitbox made every throw a coin flip. */
  private static readonly CATCH_SLACK = 0.85;

  /** Throw a capture orb along a direction. Captures the first capturable mob it
   *  brushes past, recalls an owned pet, and drops back as a pickup on a miss. */
  throwCatcher(x: number, y: number, z: number, dx: number, dy: number, dz: number): Entity {
    const mesh = this.buildThrownOrb();
    const e = new Entity('catcher', { x, y, z }, { w: 0.3, h: 0.3 }, mesh);
    const len = Math.hypot(dx, dy, dz) || 1;
    const speed = 17;
    e.vel = { x: (dx / len) * speed, y: (dy / len) * speed + 1.2, z: (dz / len) * speed };
    this.entities.push(e);
    this.scene.add(mesh);
    this.audio.play('bow');
    return e;
  }

  /** Small amethyst orb model for the thrown ball (glass shell + metal band). */
  private buildThrownOrb(): THREE.Group {
    const g = new THREE.Group();
    const R = 0.15;
    g.add(new THREE.Mesh(
      new THREE.SphereGeometry(R, 12, 10),
      new THREE.MeshLambertMaterial({ color: 0xb794ec, emissive: 0x5a3f86, transparent: true, opacity: 0.9 }),
    ));
    const band = new THREE.Mesh(
      new THREE.TorusGeometry(R * 1.02, R * 0.16, 6, 16),
      new THREE.MeshLambertMaterial({ color: 0x2b2138 }),
    );
    band.rotation.x = Math.PI / 2;
    g.add(band);
    return g;
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
    const speed = Math.hypot(e.vel.x, e.vel.y, e.vel.z);
    const steps = Math.max(1, Math.ceil(speed * dt / 0.25));
    const sdt = dt / steps;
    for (let s = 0; s < steps && !e.dead; s++) {
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
        e.dead = true;
        this.audio.play('click');
        this.spawnDrop(px, py, pz, I.MOB_CATCHER, 1);
        return;
      }
    }
    // amethyst sparkle trail so the arc is easy to read in flight
    if (Math.random() < 0.5) this.spawnCaptureSparkle(e.pos.x, e.pos.y, e.pos.z, 1);
    e.mesh.position.set(e.pos.x, e.pos.y, e.pos.z);
    e.mesh.rotation.x += dt * 9;
    e.mesh.rotation.y += dt * 5;
    if (e.age > 8 || e.pos.y < -8) {
      e.dead = true;
      if (e.pos.y > -8) this.spawnDrop(e.pos.x, e.pos.y, e.pos.z, I.MOB_CATCHER, 1);
    }
  }

  /** A thrown orb reached a mob: recall a pet, capture a hostile, or bounce off
   *  a peaceful animal (which keeps the orb, dropped at its feet). */
  private resolveCatcherHit(e: Entity, m: Entity): void {
    e.dead = true;
    const p = this.player;
    if (this.isPet(m)) {
      const kind = this.recallPet(m);
      if (kind && p) {
        p.giveFilledCatcher(kind);
        this.onToast?.(`Recalled ${mobLabel(kind)}`);
      }
      return;
    }
    const kind = this.captureMob(m);
    if (kind && p) {
      p.giveFilledCatcher(kind);
      this.onToast?.(`Captured ${mobLabel(kind)}!`);
      return;
    }
    // peaceful mob: bounces off, orb recoverable on the ground
    this.audio.play('fail');
    this.spawnDrop(m.pos.x, m.pos.y + m.box.h * 0.5, m.pos.z, I.MOB_CATCHER, 1);
    this.onToast?.('Catchers only work on hostile mobs');
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

    // captured flyers escort their owner instead of hunting them
    if ((e.kind === 'phantom' || e.kind === 'emberghast') && this.isPet(e)) {
      this.updateFlyingPet(e, dt);
      return;
    }
    // phantom: flying mob, circles + swoops the player
    if (e.kind === 'phantom') { this.updatePhantom(e, dt); return; }
    // emberghast: floats at range and spits fireballs
    if (e.kind === 'emberghast') { this.updateEmberghast(e, dt); return; }
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
    // a grazing sheep stands still with its head in the grass
    if (e.grazeT > 0) { wishX = 0; wishZ = 0; }

    const angryWolf = e.kind === 'wolf' && e.angryT > 0 && e.state === 'chase';
    const speed = lured ? e.moveSpeed * 1.4
      : e.state === 'flee' ? e.moveSpeed * 2.2 : angryWolf ? e.moveSpeed * 2.4 : e.moveSpeed;
    const res = this.applyGroundMove(e, dt, wishX, wishZ, speed);
    // hop single-block barriers; spiders just climb straight up walls
    if ((res.hitX || res.hitZ) && (wishX !== 0 || wishZ !== 0)) {
      if (e.kind === 'spider') e.vel.y = Math.max(e.vel.y, 3.2);
      else if (e.onGround) e.vel.y = JUMP_V;
    }
    // chickens flutter down instead of dropping like a stone
    if (e.kind === 'chicken' && !e.onGround && e.vel.y < -2.2) e.vel.y = -2.2;

    // melee contact attacks — on the pet it is fighting, else on the player
    if ((MELEE_MOBS.has(e.kind as MobKind) || angryWolf) && e.attackCooldown <= 0 && e.state === 'chase'
      && (foe || !p.dead)) {
      const dx = qx - e.pos.x, dz = qz - e.pos.z;
      const dy = qy - e.pos.y;
      const reach = e.kind === 'spider' ? 1.4 : e.kind === 'ashstalker' ? 1.3 : 1.1;
      const dmg = e.kind === 'spider' ? 2 : e.kind === 'cinderling' ? 2
        : e.kind === 'ashstalker' ? 4 : 3;
      if (Math.hypot(dx, dz) < reach + (foe ? foe.box.w * 0.5 : 0) && Math.abs(dy) < 2) {
        e.attackCooldown = e.kind === 'cinderling' ? 0.7 : 1;
        if (foe) {
          this.hurt(foe, dmg, dx, dz, e);
        } else if (p.mode === 'survival') {
          p.damage(dmg, e, `Slain by ${mobLabel(e.kind as string)}`);
          p.applyKnockback(dx, dz, e.kind === 'ashstalker' ? 7 : 5);
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
    // hurt = vanilla's red overlay: tint the albedo as well as glowing a little
    const gb = hurt ? MOB_EXPOSURE * 0.5 : MOB_EXPOSURE;
    for (const m of e.materials) {
      m.color.setRGB(MOB_EXPOSURE, gb, gb);
      if (netherGlow && !m.userData.ember) m.emissive.setRGB(er * 0.22, eg * 0.22, eb);
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
    e.onGround = res.onGround;
    return res;
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
    } else {
      for (let i = 0; i < L.length; i++) L[i].rotation.x = i % 2 === 0 ? swing : -swing;
    }

    if (limbs.arms) {
      // zombies stalk with arms out (+π/2 points them where the face looks) and
      // lunge them down on a hit; skeletons raise the bow only while aiming
      const aiming = e.kind === 'skeleton' && e.state === 'chase';
      const lunge = e.kind === 'zombie' ? Math.max(0, e.attackCooldown - 0.7) / 0.3 : 0;
      for (let i = 0; i < limbs.arms.length; i++) {
        const arm = limbs.arms[i];
        let tx: number, ty = 0;
        if (e.kind === 'zombie') {
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
    const standoff = e.kind === 'emberghast' ? 6 : 0.8;
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
      if (e.kind === 'emberghast' && distH < 16) {
        e.attackCooldown = 2.4;
        this.spawnFireball(e.pos.x, e.pos.y, e.pos.z,
          t.pos.x - e.pos.x, (t.pos.y + t.box.h * 0.5) - e.pos.y, t.pos.z - e.pos.z, 'petghast');
      } else if (e.kind === 'phantom' && distH < 1.8
        && Math.abs(t.pos.y + t.box.h * 0.5 - e.pos.y) < 2.2) {
        e.attackCooldown = 1.1;
        this.hurt(t, this.petDamage(e.kind as MobKind), dx, dz, e);
      }
    }
    // wing flap
    if (e.limbs) {
      for (let i = 0; i < e.limbs.legs.length; i++) {
        e.limbs.legs[i].rotation.z = (i % 2 === 0 ? 1 : -1) * (Math.sin(e.age * 12) * 0.4 - 0.2);
      }
    }
    e.mesh.position.set(e.pos.x, e.pos.y, e.pos.z);
    e.mesh.rotation.y = e.yaw;
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

    for (const e of this.entities) {
      if (!this.isMob(e)) continue;
      const stats = MOB_STATS[e.kind as MobKind];
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
        const aggressive = e.kind === 'spider' ? (isNight || dark || e.angryT > 0) : true;
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

      if (d > 72 && !e.tamed && !e.ridden) e.dead = true;
    }

    // spawn attempts once per second
    if (++this.spawnTick >= 20) {
      this.spawnTick = 0;
      this.trySpawns(isNight);
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
      const kind = kinds[Math.floor(Math.random() * kinds.length)];
      this.spawnMob(kind, wx + 0.5, h, wz + 0.5);
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

    // Nether: only nether mobs spawn here (in air pockets on netherrack/solid
    // ground near the player's altitude), and the overworld spawns are skipped.
    if (this.world.dimension === 'nether') {
      // the nether stays populated in both modes (its mobs can't hurt a creative
      // player anyway) — two attempts per tick so air pockets fill more reliably
      if (hostile < 18 && Math.random() < 0.8) {
        for (let attempt = 0; attempt < 2; attempt++) {
          const ang = Math.random() * Math.PI * 2;
          const r = 12 + Math.random() * 22;
          const wx = Math.floor(p.pos.x + Math.cos(ang) * r);
          const wz = Math.floor(p.pos.z + Math.sin(ang) * r);
          const chunk = this.world.getChunk(Math.floor(wx / 16), Math.floor(wz / 16));
          if (!chunk || !chunk.ready) continue;
          const py = Math.floor(p.pos.y);
          for (let tries = 0; tries < 10; tries++) {
            const wy = py - 10 + Math.floor(Math.random() * 22);
            if (wy < 5 || wy > 150) continue;
            if (this.world.getBlock(wx, wy, wz) !== B.AIR) continue;
            if (this.world.getBlock(wx, wy + 1, wz) !== B.AIR) continue;
            if (!this.world.isSolidAt(wx, wy - 1, wz)) continue;
            const kind = Math.random() < 0.62 ? NETHER_MOBS[0] : NETHER_MOBS[1];
            this.spawnMob(kind, wx + 0.5, wy, wz + 0.5);
            break;
          }
        }
      }
      return;
    }

    if (!isNight && passive < 10 && Math.random() < 0.5) {
      surfaceSpawn(['pig', 'chicken', 'sheep', 'cow'], 12, 36);
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
    if (e.kind === 'spider') e.angryT = 12;
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
        o.angryT = 25;
        o.state = 'chase';
        o.sitting = false;
      }
    } else if (!MOB_STATS[e.kind as MobKind].hostile) {
      e.state = 'flee';
      e.stateTime = 5;
      e.yaw = Math.atan2(-kbX, -kbZ); // run along the knockback direction
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
      case 'emberghast': at(I.QUARTZ, 1, 2); at(B.GLOWSTONE, 0, 1); break;
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

  /** Does the player's held item tempt this animal into following? */
  private isLureFood(kind: MobKind, heldId: number): boolean {
    if (!heldId) return false;
    const foods = LURE_FOOD[kind];
    return !!foods && foods.includes(heldId);
  }

  /** Is this animal a breedable adult and is `heldId` its food? */
  private canBreed(e: Entity, heldId: number): boolean {
    if (e.baby || e.loveT > 0 || e.breedCooldown > 0) return false;
    const foods = BREED_FOOD[e.kind as MobKind];
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
    const speed = e.moveSpeed * (fwd > 0 ? 2.4 : 1.5) * (e.saddled ? 1.18 : 1); // saddle = faster gallop
    const res = this.applyGroundMove(e, dt, wishX, wishZ, speed);
    if (jump && e.onGround) e.vel.y = JUMP_V * 1.15;
    else if ((res.hitX || res.hitZ) && e.onGround && (wishX !== 0 || wishZ !== 0)) e.vel.y = JUMP_V;
    this.animateMob(e, dt, p);
    // hoofbeats while galloping on the ground
    if (e.onGround && Math.hypot(e.vel.x, e.vel.z) > 1.5) {
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
