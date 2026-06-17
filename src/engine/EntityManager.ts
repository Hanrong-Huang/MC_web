// Entities: item drops (hover + magnetize + pickup), mobs (pig, chicken,
// sheep, cow, zombie, skeleton, spider, creeper) with hierarchical box limbs,
// sine-wave walk cycles and state-tree AI, plus arrows, primed TNT, falling
// sand/gravel, block-break particles, and the shared explosion routine.

import * as THREE from 'three';
import { World } from './World';
import { moveEntity, inWater, rayAABB, Vec3, MoveResult } from './Physics';
import { B, I, def, hasDef, CROSS_BLOCKS } from './Blocks';
import { Atlas, extrudeSpriteGeometry } from './Textures';
import { AudioEngine } from './Audio';
import { SEA_LEVEL } from './WorldGenerator';
import type { Player } from './Player';

export type MobKind =
  | 'pig' | 'chicken' | 'sheep' | 'cow'
  | 'zombie' | 'skeleton' | 'spider' | 'creeper'
  | 'wolf' | 'villager' | 'phantom' | 'horse' | 'cat';
export type EntityKind = 'drop' | MobKind | 'arrow' | 'tnt' | 'falling' | 'particle' | 'bobber';

const MOB_KINDS = new Set<EntityKind>([
  'pig', 'chicken', 'sheep', 'cow',
  'zombie', 'skeleton', 'spider', 'creeper',
  'wolf', 'villager', 'phantom', 'horse', 'cat',
]);
const JUMP_V = Math.sqrt(2 * 32 * 1.25); // same 1.25-block hop as the player
const GRAVITY = 32;

/** "#rrggbb" -> [r,g,b]. */
function hexRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const clamp255 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

/** Horse coat palettes: [body, speckle, mane/tail]. */
const HORSE_COATS: [string, string, string][] = [
  ['#6b4a2b', '#5a3d22', '#2a1a0e'], // brown
  ['#d8c8a8', '#c8b894', '#8a6a44'], // creamy
  ['#3a2c22', '#2c2018', '#161009'], // black
  ['#a06038', '#8a4f2c', '#e8d8b0'], // chestnut, flaxen mane
  ['#cfcfcf', '#bcbcbc', '#9a9a9a'], // white/grey
];
/** Foods that put each animal into "love mode". Wolf/cat/horse must be tamed. */
const BREED_FOOD: Partial<Record<MobKind, number[]>> = {
  pig: [I.CARROT, I.POTATO, I.BEETROOT],
  cow: [I.WHEAT],
  sheep: [I.WHEAT],
  chicken: [I.SEEDS, I.BEETROOT_SEEDS],
  horse: [I.GOLDEN_CARROT, I.APPLE],
  wolf: [I.BEEF, I.COOKED_BEEF, I.PORKCHOP, I.COOKED_PORKCHOP, I.CHICKEN, I.COOKED_CHICKEN, I.MUTTON, I.COOKED_MUTTON],
  cat: [I.RAW_FISH, I.COOKED_FISH],
};
const BREED_NEEDS_TAME = new Set<MobKind>(['wolf', 'cat', 'horse']);

/** Cat coat palettes: [body, speckle, belly]. */
const CAT_COATS: [string, string, string][] = [
  ['#3a3530', '#2a2520', '#cfcabf'], // tuxedo
  ['#d88a3a', '#c2762c', '#f0d8a8'], // ginger tabby
  ['#cfcfcf', '#b8b8b8', '#ffffff'], // siamese-ish
  ['#2a2a2a', '#1c1c1c', '#3a3a3a'], // black
];

interface LimbSet {
  legs: THREE.Group[];
  arms?: THREE.Group[];
  head?: THREE.Group;
  /** swaying tail (wolf, horse, cat) */
  tail?: THREE.Object3D;
  /** group bobbed gently while idle (body breathing) */
  body?: THREE.Object3D;
}

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
};

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
  // arrow fields
  owner: 'player' | 'skeleton' = 'player';
  dmg = 0;
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
  private skinCache = new Map<string, THREE.Texture>();
  private shadowTex: THREE.CanvasTexture | null = null;
  private particleMats = new Map<string, THREE.MeshBasicMaterial>();
  private spawnTick = 0;
  mobsEnabled = true;

  constructor(scene: THREE.Scene, world: World, atlas: Atlas, audio: AudioEngine) {
    this.scene = scene;
    this.world = world;
    this.atlas = atlas;
    this.audio = audio;
  }

  setPlayer(p: Player): void { this.player = p; }

  private isMob(e: Entity): boolean { return MOB_KINDS.has(e.kind); }

  // --- spawning ---------------------------------------------------------------

  spawnDrop(x: number, y: number, z: number, itemId: number, count: number, dur?: number): void {
    const mesh = this.buildDropMesh(itemId);
    const e = new Entity('drop', { x, y, z }, { w: 0.25, h: 0.25 }, mesh);
    e.itemId = itemId;
    e.count = count;
    if (dur !== undefined) e.dmg = dur; // reuse field for tool durability passthrough
    e.vel = { x: (Math.random() - 0.5) * 2.4, y: 3.2, z: (Math.random() - 0.5) * 2.4 };
    this.entities.push(e);
    this.scene.add(mesh);
  }

  spawnMob(kind: MobKind, x: number, y: number, z: number): Entity {
    const variant = kind === 'horse' ? (Math.random() * HORSE_COATS.length) | 0
      : kind === 'cat' ? (Math.random() * CAT_COATS.length) | 0 : 0;
    const { mesh, limbs, mats } = this.buildMobMesh(kind, variant);
    const stats = MOB_STATS[kind];
    const e = new Entity(kind, { x, y, z }, { ...stats.box }, mesh);
    e.limbs = limbs;
    e.hp = stats.hp;
    e.moveSpeed = stats.speed;
    e.materials = mats;
    e.variant = variant;
    e.yaw = Math.random() * Math.PI * 2;
    // soft contact shadow under grounded mobs (phantoms fly, so they get none)
    if (kind !== 'phantom') mesh.add(this.makeShadow(stats.box.w));
    this.entities.push(e);
    this.scene.add(mesh);
    return e;
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

  shootArrow(owner: 'player' | 'skeleton', x: number, y: number, z: number,
    dx: number, dy: number, dz: number, speed: number, dmg: number): void {
    const mesh = new THREE.Group();
    const shaft = new THREE.Mesh(
      new THREE.BoxGeometry(0.05, 0.05, 0.5),
      new THREE.MeshLambertMaterial({ color: 0x8a6232 }),
    );
    const tip = new THREE.Mesh(
      new THREE.BoxGeometry(0.07, 0.07, 0.1),
      new THREE.MeshLambertMaterial({ color: 0xc8c8d0 }),
    );
    tip.position.z = 0.28;
    mesh.add(shaft, tip);
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

  explode(x: number, y: number, z: number, power: number): void {
    this.audio.play('explode');
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
        p.damage(Math.ceil((1 - d / range) * power * 7));
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
        p.damage(5);
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
        default: this.updateMob(e, dt); break;
      }
    }
    for (let i = this.entities.length - 1; i >= 0; i--) {
      const e = this.entities[i];
      if (e.dead) {
        this.scene.remove(e.mesh);
        disposeGroup(e.mesh);
        this.entities.splice(i, 1);
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
        const leftover = p.inventory.add(e.itemId, e.count);
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

  private updateArrow(e: Entity, dt: number): void {
    const speed = Math.hypot(e.vel.x, e.vel.y, e.vel.z);
    const steps = Math.max(1, Math.ceil(speed * dt / 0.45));
    const sdt = dt / steps;
    for (let s = 0; s < steps && !e.dead; s++) {
      e.vel.y -= 16 * sdt;
      e.pos.x += e.vel.x * sdt;
      e.pos.y += e.vel.y * sdt;
      e.pos.z += e.vel.z * sdt;
      // block hit
      const id = this.world.getBlock(Math.floor(e.pos.x), Math.floor(e.pos.y), Math.floor(e.pos.z));
      if (id !== B.AIR && id !== B.WATER && id !== B.TORCH && def(id).solid) {
        e.dead = true;
        this.audio.play('arrowHit');
        if (e.owner === 'player' && Math.random() < 0.7) {
          this.spawnDrop(e.pos.x - e.vel.x * sdt, e.pos.y - e.vel.y * sdt, e.pos.z - e.vel.z * sdt, I.ARROW, 1);
        }
        return;
      }
      // entity hit
      if (e.owner === 'skeleton') {
        const p = this.player!;
        const hw = 0.3;
        if (!p.dead && p.mode === 'survival' &&
          e.pos.x > p.pos.x - hw && e.pos.x < p.pos.x + hw &&
          e.pos.y > p.pos.y && e.pos.y < p.pos.y + 1.8 &&
          e.pos.z > p.pos.z - hw && e.pos.z < p.pos.z + hw) {
          p.damage(e.dmg);
          p.applyKnockback(e.vel.x, e.vel.z, 5);
          e.dead = true;
          return;
        }
      } else {
        for (const m of this.entities) {
          if (!this.isMob(m) || m.dead) continue;
          const hw = m.box.w / 2;
          if (e.pos.x > m.pos.x - hw && e.pos.x < m.pos.x + hw &&
            e.pos.y > m.pos.y && e.pos.y < m.pos.y + m.box.h &&
            e.pos.z > m.pos.z - hw && e.pos.z < m.pos.z + hw) {
            this.hurt(m, e.dmg, e.vel.x, e.vel.z);
            e.dead = true;
            return;
          }
        }
      }
    }
    if (e.age > 30 || e.pos.y < -8) e.dead = true;
    e.mesh.position.set(e.pos.x, e.pos.y, e.pos.z);
    e.mesh.lookAt(e.pos.x + e.vel.x, e.pos.y + e.vel.y, e.pos.z + e.vel.z);
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
      this.explode(e.pos.x, e.pos.y + 0.5, e.pos.z, 3.2);
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

    // phantom: flying mob, circles + swoops the player
    if (e.kind === 'phantom') { this.updatePhantom(e, dt); return; }
    // a ridden horse is driven by the player (see Player.updateRiding)
    if (e.ridden) return;

    // emissive: hurt = red; creeper fuse = white strobe
    let er = e.hurtFlash > 0 ? 0.55 : 0, eg = 0, eb = 0;
    if (e.kind === 'creeper' && e.state === 'fuse' && Math.sin(e.age * 22) > 0) {
      er = 0.8; eg = 0.8; eb = 0.8;
    }
    // tamed wolf collar glow
    if (e.kind === 'wolf' && e.tamed) { er = 0.15; eg = 0.1; eb = 0.05; }
    for (const m of e.materials) m.emissive.setRGB(er, eg, eb);

    // steering by state
    let wishX = 0, wishZ = 0;
    const distToPlayer = Math.hypot(p.pos.x - e.pos.x, p.pos.z - e.pos.z);

    // tamed wolf/cat: follow the owner (sit = stay put)
    if ((e.kind === 'wolf' || e.kind === 'cat') && e.tamed) {
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
      const fspeed = e.moveSpeed * (distToPlayer > 8 ? 2.2 : 1);
      const res = this.applyGroundMove(e, dt, wishX, wishZ, fspeed);
      if ((res.hitX || res.hitZ) && e.onGround && (wishX !== 0 || wishZ !== 0)) e.vel.y = JUMP_V;
      this.animateMob(e, dt, p);
      e.mesh.position.set(e.pos.x, e.pos.y + (e.sitting ? -0.12 : 0), e.pos.z);
      e.mesh.rotation.y = e.yaw;
      return;
    }

    if (e.state === 'wander' || e.state === 'flee') {
      wishX = -Math.sin(e.yaw);
      wishZ = -Math.cos(e.yaw);
    } else if (e.state === 'chase') {
      const dx = p.pos.x - e.pos.x, dz = p.pos.z - e.pos.z;
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
      const dx = p.pos.x - e.pos.x, dz = p.pos.z - e.pos.z;
      e.yaw = Math.atan2(-dx, -dz);
      e.fuseT -= dt;
      if (distToPlayer > 5) {
        e.state = 'chase'; // player escaped: cancel
      } else if (e.fuseT <= 0) {
        e.dead = true;
        this.explode(e.pos.x, e.pos.y + 0.6, e.pos.z, 2.6);
        return;
      }
    }

    const speed = e.state === 'flee' ? e.moveSpeed * 2.2 : e.moveSpeed;
    const res = this.applyGroundMove(e, dt, wishX, wishZ, speed);
    // hop single-block barriers
    if ((res.hitX || res.hitZ) && e.onGround && (wishX !== 0 || wishZ !== 0)) {
      e.vel.y = JUMP_V;
    }

    // melee contact attacks
    if ((e.kind === 'zombie' || e.kind === 'spider') && !p.dead && e.attackCooldown <= 0 && e.state === 'chase') {
      const dx = p.pos.x - e.pos.x, dz = p.pos.z - e.pos.z;
      const dy = p.pos.y - e.pos.y;
      if (Math.hypot(dx, dz) < (e.kind === 'spider' ? 1.4 : 1.1) && Math.abs(dy) < 2) {
        e.attackCooldown = 1;
        if (p.mode === 'survival') {
          p.damage(e.kind === 'spider' ? 2 : 3);
          p.applyKnockback(dx, dz, 6);
        }
      }
    }
    // creeper trigger
    if (e.kind === 'creeper' && e.state === 'chase' && distToPlayer < 2.6 && !p.dead && p.mode === 'survival') {
      e.state = 'fuse';
      e.fuseT = 1.5;
      this.audio.play('fuse');
    }

    // animation
    this.animateMob(e, dt, p);
    e.mesh.position.set(e.pos.x, e.pos.y, e.pos.z);
    e.mesh.rotation.y = e.yaw;
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

  /** Shared walk-cycle + head-tracking animation. */
  private animateMob(e: Entity, dt: number, p: Player): void {
    const hSpeed = Math.hypot(e.vel.x, e.vel.z);
    if (!e.limbs) return;
    const L = e.limbs.legs;

    // sitting wolf/cat: fold the rear legs, keep front legs planted, tail down
    if ((e.kind === 'wolf' || e.kind === 'cat') && e.sitting) {
      if (L[0]) L[0].rotation.x = -0.15;
      if (L[1]) L[1].rotation.x = -0.15;
      if (L[2]) L[2].rotation.x = 1.25;
      if (L[3]) L[3].rotation.x = 1.25;
      if (e.limbs.tail) e.limbs.tail.rotation.y = Math.sin(e.age * 2) * 0.12;
      if (e.limbs.body) e.limbs.body.position.y = 0;
      return;
    }

    e.walkCycle += hSpeed * dt * 3.2;
    const swing = Math.sin(e.walkCycle) * Math.min(1, hSpeed / 1.5) * 0.75;
    for (let i = 0; i < L.length; i++) {
      L[i].rotation.x = i % 2 === 0 ? swing : -swing;
    }
    if (e.limbs.arms) {
      for (const a of e.limbs.arms) a.rotation.x = -Math.PI / 2 + Math.sin(e.walkCycle * 0.5) * 0.1;
    }
    if (e.limbs.head && (e.state === 'chase' || e.state === 'fuse' || e.kind === 'wolf' || e.kind === 'cat')) {
      const dx = p.pos.x - e.pos.x, dz = p.pos.z - e.pos.z;
      const dy = (p.pos.y + 1.6) - (e.pos.y + e.box.h * 0.9);
      e.limbs.head.rotation.x = Math.atan2(dy, Math.hypot(dx, dz)) * 0.7;
    }
    // tail sway: a happy tamed wolf wags fast; others drift gently + with stride
    if (e.limbs.tail) {
      let amp = 0.22, rate = 3.5;
      if (e.kind === 'wolf' && e.tamed) { amp = 0.6; rate = 14; }
      e.limbs.tail.rotation.y = Math.sin(e.age * rate) * amp + swing * 0.35;
    }
    // idle breathing: subtle body bob that fades out once moving
    if (e.limbs.body) {
      e.limbs.body.position.y = Math.sin(e.age * 2.2) * 0.02 * Math.max(0, 1 - hSpeed);
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
      return;
    }
  }

  /** Tamed wolf: bite nearby hostile mobs. */
  private wWolfCombat(e: Entity, dt: number): void {
    e.attackCooldown = Math.max(0, e.attackCooldown - dt);
    if (e.attackCooldown > 0 || e.sitting) return;
    for (const m of this.entities) {
      if (!this.isMob(m) || m.dead) continue;
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

  /** Phantom: flies in circles above the player and periodically swoops. */
  private updatePhantom(e: Entity, dt: number): void {
    const p = this.player!;
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
      p.damage(3);
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

  // --- 20 Hz AI tick --------------------------------------------------------------

  tick(isNight: boolean): void {
    const p = this.player;
    if (!p) return;

    for (const e of this.entities) {
      if (!this.isMob(e)) continue;
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
        e.box = { ...MOB_STATS[e.kind as MobKind].box };
      }
      e.stateTime -= 0.05;
      const stats = MOB_STATS[e.kind as MobKind];
      const d = Math.hypot(p.pos.x - e.pos.x, p.pos.z - e.pos.z);

      // idle voices, attenuated by distance
      if (d < 24 && Math.random() < (e.state === 'chase' ? 0.008 : 0.0035)) {
        this.audio.mobSound(e.kind, (1 - d / 24) * 0.9);
      }

      if (stats.hostile && e.state !== 'fuse') {
        // undead mobs burn off at dawn when the sky can see them
        if (!isNight && (e.kind === 'zombie' || e.kind === 'skeleton' || e.kind === 'phantom')) {
          const sky = this.world.skyLight(Math.floor(e.pos.x), Math.floor(e.pos.y + 1), Math.floor(e.pos.z));
          if (sky >= 0.95) {
            this.spawnBlockParticles(Math.floor(e.pos.x), Math.floor(e.pos.y + 1), Math.floor(e.pos.z), B.LOG, 6);
            e.dead = true;
            continue;
          }
        }
        const dark = this.world.skyLight(Math.floor(e.pos.x), Math.floor(e.pos.y + 1), Math.floor(e.pos.z)) < 0.7;
        const aggressive = e.kind === 'spider' ? (isNight || dark || e.angryT > 0) : true;
        if (aggressive && d < 16 && !p.dead && p.mode === 'survival') {
          e.state = 'chase';
        } else if (e.state === 'chase') {
          e.state = 'wander';
          e.stateTime = 3;
        }

        // skeleton archery
        if (e.kind === 'skeleton' && e.state === 'chase') {
          e.shootCooldown -= 0.05;
          if (e.shootCooldown <= 0 && d > 3.5 && d < 15) {
            const ex = e.pos.x, ey = e.pos.y + 1.5, ez = e.pos.z;
            const tx = p.pos.x, ty = p.pos.y + 1.4, tz = p.pos.z;
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

      if (e.state !== 'chase' && e.state !== 'fuse' && e.stateTime <= 0) {
        if (e.state === 'flee') e.state = 'idle';
        if (Math.random() < 0.55) {
          e.state = 'idle';
          e.stateTime = 1.5 + Math.random() * 3;
        } else {
          e.state = 'wander';
          e.yaw = Math.random() * Math.PI * 2;
          e.stateTime = 2 + Math.random() * 4;
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

  private trySpawns(isNight: boolean): void {
    if (!this.mobsEnabled) return;
    const p = this.player!;
    let passive = 0, hostile = 0;
    for (const e of this.entities) {
      if (!this.isMob(e)) continue;
      if (MOB_STATS[e.kind as MobKind].hostile) hostile++;
      else passive++;
    }

    // consume village villager spawns near the player (once each)
    const vs = this.world.generator.villageSpawns;
    if (vs.length) {
      let villagerCount = 0;
      for (const e of this.entities) if (e.kind === 'villager') villagerCount++;
      for (let i = vs.length - 1; i >= 0; i--) {
        const s = vs[i];
        const d = Math.hypot(s.x - p.pos.x, s.z - p.pos.z);
        if (d < 40 && villagerCount < 12) {
          // only spawn if the chunk is loaded + has ground
          const chunk = this.world.getChunk(Math.floor(s.x / 16), Math.floor(s.z / 16));
          if (chunk && chunk.ready && this.world.isSolidAt(Math.floor(s.x), Math.floor(s.y) - 1, Math.floor(s.z))) {
            this.spawnMob('villager', s.x, s.y, s.z);
            villagerCount++;
          }
        }
        if (d < 60) vs.splice(i, 1); // consumed (or out of range, drop it)
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
      if (h <= SEA_LEVEL || h >= 120) return;
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

  hurt(e: Entity, dmg: number, kbX: number, kbZ: number): void {
    if (e.dead || !this.isMob(e)) return;
    if (e.armorTier > 0) dmg *= 0.5; // iron horse barding halves damage
    e.hp -= dmg;
    e.hurtFlash = 0.35;
    if (e.kind === 'spider') e.angryT = 12;
    const len = Math.hypot(kbX, kbZ) || 1;
    e.vel.x += (kbX / len) * 7;
    e.vel.z += (kbZ / len) * 7;
    e.vel.y = Math.max(e.vel.y, 5);
    this.audio.play('hit');
    if (!MOB_STATS[e.kind as MobKind].hostile) {
      e.state = 'flee';
      e.stateTime = 5;
      e.yaw = Math.atan2(-kbX, -kbZ); // run along the knockback direction
    }
    if (e.hp <= 0) {
      e.dead = true;
      this.audio.play('pop');
      this.spawnPoof(e.pos.x, e.pos.y, e.pos.z);
      this.dropLoot(e);
      this.onKill?.(e.kind as string);
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

  /** Right-click interaction with the targeted mob.
   *  Returns the interaction kind (the player consumes items / opens UI). */
  interactMob(e: Entity, heldId: number):
    'tamed' | 'sit' | 'trade' | 'mount' | 'love' | 'saddle' | 'armor' | null {
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
    const leather = new THREE.MeshLambertMaterial({ color: 0x5a3d22 });
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.14, 0.6), leather);
    seat.position.set(0, 1.52, 0.15);
    const knob = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.12), leather);
    knob.position.set(0, 1.62, -0.12);
    e.mesh.add(seat, knob);
    this.spawnHearts(e.pos.x, e.pos.y + 1.6, e.pos.z);
  }

  /** Fit iron barding on a tamed horse (visual + damage-resist flag). */
  private armorHorse(e: Entity, tier: number): void {
    e.armorTier = tier;
    const iron = new THREE.MeshLambertMaterial({ color: 0xcfcfd6 });
    const chest = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.5, 0.7), iron);
    chest.position.set(0, 1.15, 0.18);
    const neck = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.78, 0.42), iron);
    neck.position.set(0, 1.46, -0.5); neck.rotation.x = 0.5;
    e.mesh.add(chest, neck);
    this.spawnHearts(e.pos.x, e.pos.y + 1.6, e.pos.z);
  }

  /** Spawn a baby animal (scaled down, grows up after a delay). */
  spawnBaby(kind: MobKind, x: number, y: number, z: number): Entity {
    const e = this.spawnMob(kind, x, y, z);
    e.baby = true;
    e.growT = 45;
    e.mesh.scale.setScalar(0.55);
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
      e.mesh.position.set(e.pos.x, e.pos.y, e.pos.z);
      e.mesh.rotation.y = e.yaw;
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
    e.mesh.position.set(e.pos.x, e.pos.y, e.pos.z);
    e.mesh.rotation.y = e.yaw;
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
  }

  // --- mesh building --------------------------------------------------------------

  private skin(key: string, base: string, speckle: string, face?: (ctx: CanvasRenderingContext2D) => void): THREE.Texture {
    const cached = this.skinCache.get(key);
    if (cached) return cached;
    const c = document.createElement('canvas');
    c.width = 8; c.height = 8;
    const ctx = c.getContext('2d')!;
    const [br, bg, bb] = hexRgb(base);
    const [sr, sg, sb] = hexRgb(speckle);
    let s = key.length * 1337 + 7;
    const rng = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    // Clean Minecraft-style skin: a flat base colour with gentle top-lit
    // vertical shading and only sparse, low-contrast speckle for grain. This
    // reads as a solid recognisable creature instead of TV-static noise.
    for (let y = 0; y < 8; y++) {
      const shade = 1 + (3.5 - y) / 3.5 * 0.13; // lighter up top, darker low
      for (let x = 0; x < 8; x++) {
        const speck = rng() < 0.12;
        const f = shade * (1 + (rng() - 0.5) * 0.07);
        const r = speck ? sr : br, gg = speck ? sg : bg, b = speck ? sb : bb;
        ctx.fillStyle = `rgb(${clamp255(r * f)},${clamp255(gg * f)},${clamp255(b * f)})`;
        ctx.fillRect(x, y, 1, 1);
      }
    }
    if (face) face(ctx);
    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    this.skinCache.set(key, tex);
    return tex;
  }

  private mat(tex: THREE.Texture, mats: THREE.MeshLambertMaterial[]): THREE.MeshLambertMaterial {
    const m = new THREE.MeshLambertMaterial({ map: tex });
    mats.push(m);
    return m;
  }

  private boxMesh(w: number, h: number, d: number, mat: THREE.Material | THREE.Material[]): THREE.Mesh {
    return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  }

  /** Leg pivot at the hip so sine swings look right. */
  private leg(w: number, len: number, mat: THREE.Material, x: number, hipY: number, z: number): THREE.Group {
    const g = new THREE.Group();
    g.position.set(x, hipY, z);
    const m = this.boxMesh(w, len, w, mat);
    m.position.y = -len / 2;
    g.add(m);
    return g;
  }

  private buildMobMesh(kind: MobKind, variant = 0): {
    mesh: THREE.Group; limbs: LimbSet; mats: THREE.MeshLambertMaterial[];
  } {
    const g = new THREE.Group();
    const mats: THREE.MeshLambertMaterial[] = [];

    if (kind === 'pig') {
      const skin = this.skin('pig', '#eda0a7', '#d98a92');
      const faceTex = this.skin('pig_face', '#eda0a7', '#d98a92', (ctx) => {
        ctx.fillStyle = '#3b3b4a'; ctx.fillRect(1, 2, 1, 1); ctx.fillRect(6, 2, 1, 1);
        ctx.fillStyle = '#c76b75'; ctx.fillRect(3, 4, 2, 2);
        ctx.fillStyle = '#8f4a52'; ctx.fillRect(3, 5, 1, 1); ctx.fillRect(4, 5, 1, 1);
      });
      const bodyM = this.mat(skin, mats);
      const faceM = this.mat(faceTex, mats);
      const body = this.boxMesh(0.62, 0.5, 0.95, bodyM);
      body.position.set(0, 0.55, 0.05);
      const head = new THREE.Group();
      head.position.set(0, 0.62, -0.5);
      head.add(this.boxMesh(0.5, 0.5, 0.42, [bodyM, bodyM, bodyM, bodyM, bodyM, faceM]));
      // protruding snout reads instantly as a pig
      const pigSnoutM = this.mat(this.skin('pig_snout', '#c76b75', '#b85b65'), mats);
      const pigSnout = this.boxMesh(0.26, 0.18, 0.1, pigSnoutM);
      pigSnout.position.set(0, -0.05, -0.26);
      head.add(pigSnout);
      const legs = [
        this.leg(0.18, 0.32, bodyM, -0.2, 0.32, -0.32),
        this.leg(0.18, 0.32, bodyM, 0.2, 0.32, -0.32),
        this.leg(0.18, 0.32, bodyM, 0.2, 0.32, 0.38),
        this.leg(0.18, 0.32, bodyM, -0.2, 0.32, 0.38),
      ];
      g.add(body, head, ...legs);
      return { mesh: g, limbs: { legs, head }, mats };
    }

    if (kind === 'chicken') {
      const skin = this.skin('chicken', '#f4f0e8', '#ddd6c8');
      const faceTex = this.skin('chicken_face', '#f4f0e8', '#ddd6c8', (ctx) => {
        ctx.fillStyle = '#2a2a36'; ctx.fillRect(2, 2, 1, 1); ctx.fillRect(5, 2, 1, 1);
        ctx.fillStyle = '#e8a33d'; ctx.fillRect(3, 4, 2, 2);
      });
      const bodyM = this.mat(skin, mats);
      const faceM = this.mat(faceTex, mats);
      const legM = this.mat(this.skin('chicken_leg', '#e8a33d', '#cf8f30'), mats);
      const body = this.boxMesh(0.36, 0.36, 0.5, bodyM);
      body.position.set(0, 0.42, 0);
      const head = new THREE.Group();
      head.position.set(0, 0.72, -0.22);
      head.add(this.boxMesh(0.24, 0.32, 0.22, [bodyM, bodyM, bodyM, bodyM, bodyM, faceM]));
      // beak (orange), comb + wattle (red) — classic chicken silhouette
      const beakM = this.mat(this.skin('chk_beak', '#e8a33d', '#cf8f30'), mats);
      const combM = this.mat(this.skin('chk_comb', '#c43030', '#a82424'), mats);
      const beak = this.boxMesh(0.1, 0.08, 0.14, beakM); beak.position.set(0, -0.03, -0.16);
      const comb = this.boxMesh(0.05, 0.1, 0.2, combM); comb.position.set(0, 0.2, 0.02);
      const wattle = this.boxMesh(0.05, 0.09, 0.05, combM); wattle.position.set(0, -0.13, -0.11);
      head.add(beak, comb, wattle);
      const legs = [
        this.leg(0.07, 0.26, legM, -0.09, 0.26, 0.02),
        this.leg(0.07, 0.26, legM, 0.09, 0.26, 0.02),
      ];
      const wingL = this.boxMesh(0.06, 0.22, 0.34, bodyM);
      wingL.position.set(-0.21, 0.48, 0);
      const wingR = wingL.clone();
      wingR.position.x = 0.21;
      // upright tail feathers
      const tail = this.boxMesh(0.18, 0.24, 0.12, bodyM);
      tail.position.set(0, 0.54, 0.28); tail.rotation.x = 0.6;
      g.add(body, head, wingL, wingR, tail, ...legs);
      return { mesh: g, limbs: { legs, head }, mats };
    }

    if (kind === 'sheep') {
      const wool = this.skin('sheep_wool', '#e8e8e8', '#d4d4d4');
      const faceTex = this.skin('sheep_face', '#cfb89c', '#bfa88c', (ctx) => {
        ctx.fillStyle = '#2a2a36'; ctx.fillRect(1, 3, 1, 1); ctx.fillRect(6, 3, 1, 1);
        ctx.fillStyle = '#a8907a'; ctx.fillRect(3, 5, 2, 2);
      });
      const skinM = this.mat(this.skin('sheep_skin', '#cfb89c', '#bfa88c'), mats);
      const woolM = this.mat(wool, mats);
      const faceM = this.mat(faceTex, mats);
      const body = this.boxMesh(0.7, 0.6, 1.0, woolM);
      body.position.set(0, 0.78, 0.05);
      const head = new THREE.Group();
      head.position.set(0, 0.95, -0.55);
      head.add(this.boxMesh(0.4, 0.4, 0.36, [skinM, skinM, woolM, skinM, skinM, faceM]));
      const legs = [
        this.leg(0.16, 0.5, skinM, -0.2, 0.5, -0.32),
        this.leg(0.16, 0.5, skinM, 0.2, 0.5, -0.32),
        this.leg(0.16, 0.5, skinM, 0.2, 0.5, 0.38),
        this.leg(0.16, 0.5, skinM, -0.2, 0.5, 0.38),
      ];
      g.add(body, head, ...legs);
      return { mesh: g, limbs: { legs, head }, mats };
    }

    if (kind === 'cow') {
      const hide = this.skin('cow', '#5d4231', '#ece6dc');
      const faceTex = this.skin('cow_face', '#5d4231', '#4d3628', (ctx) => {
        ctx.fillStyle = '#2a2a36'; ctx.fillRect(1, 3, 1, 1); ctx.fillRect(6, 3, 1, 1);
        ctx.fillStyle = '#d8c8b8'; ctx.fillRect(2, 5, 4, 3);
      });
      const bodyM = this.mat(hide, mats);
      const faceM = this.mat(faceTex, mats);
      const hornM = this.mat(this.skin('cow_horn', '#e8e0d0', '#d4ccb8'), mats);
      const body = this.boxMesh(0.7, 0.65, 1.1, bodyM);
      body.position.set(0, 0.92, 0.05);
      // white Holstein patches wrap the torso so it reads unmistakably as a cow
      const patchM = this.mat(this.skin('cow_patch', '#ece6dc', '#dcd4c6'), mats);
      const patchA = this.boxMesh(0.72, 0.36, 0.46, patchM); patchA.position.set(0, 1.04, -0.15);
      const patchB = this.boxMesh(0.72, 0.3, 0.34, patchM); patchB.position.set(0, 0.74, 0.4);
      g.add(patchA, patchB);
      const head = new THREE.Group();
      head.position.set(0, 1.1, -0.62);
      head.add(this.boxMesh(0.44, 0.44, 0.4, [bodyM, bodyM, bodyM, bodyM, bodyM, faceM]));
      const hornL = this.boxMesh(0.08, 0.08, 0.12, hornM);
      hornL.position.set(-0.26, 0.18, -0.05);
      const hornR = hornL.clone();
      hornR.position.x = 0.26;
      // pale muzzle on the face
      const muzzleM = this.mat(this.skin('cow_muzzle', '#d8c8b8', '#c8b6a4'), mats);
      const muzzle = this.boxMesh(0.3, 0.2, 0.1, muzzleM);
      muzzle.position.set(0, -0.08, -0.22);
      head.add(hornL, hornR, muzzle);
      // small udder under the belly
      const udderM = this.mat(this.skin('cow_udder', '#e8a0a8', '#d89098'), mats);
      const udder = this.boxMesh(0.26, 0.14, 0.3, udderM);
      udder.position.set(0, 0.5, 0.34);
      g.add(udder);
      const legs = [
        this.leg(0.18, 0.6, bodyM, -0.22, 0.6, -0.32),
        this.leg(0.18, 0.6, bodyM, 0.22, 0.6, -0.32),
        this.leg(0.18, 0.6, bodyM, 0.22, 0.6, 0.42),
        this.leg(0.18, 0.6, bodyM, -0.22, 0.6, 0.42),
      ];
      g.add(body, head, ...legs);
      return { mesh: g, limbs: { legs, head }, mats };
    }

    if (kind === 'spider') {
      const skin = this.skin('spider', '#2a2125', '#3a2e33');
      const faceTex = this.skin('spider_face', '#2a2125', '#3a2e33', (ctx) => {
        ctx.fillStyle = '#c43030';
        ctx.fillRect(1, 2, 1, 1); ctx.fillRect(3, 2, 1, 1); ctx.fillRect(4, 2, 1, 1); ctx.fillRect(6, 2, 1, 1);
        ctx.fillRect(2, 4, 1, 1); ctx.fillRect(5, 4, 1, 1);
      });
      const bodyM = this.mat(skin, mats);
      const faceM = this.mat(faceTex, mats);
      const abdomen = this.boxMesh(0.7, 0.45, 0.8, bodyM);
      abdomen.position.set(0, 0.42, 0.35);
      const thorax = this.boxMesh(0.42, 0.4, 0.42, bodyM);
      thorax.position.set(0, 0.4, -0.15);
      const head = new THREE.Group();
      head.position.set(0, 0.42, -0.42);
      head.add(this.boxMesh(0.36, 0.36, 0.3, [bodyM, bodyM, bodyM, bodyM, bodyM, faceM]));
      const legs: THREE.Group[] = [];
      for (let i = 0; i < 4; i++) {
        for (const side of [-1, 1]) {
          const lg = new THREE.Group();
          lg.position.set(side * 0.22, 0.45, -0.3 + i * 0.22);
          const lm = this.boxMesh(0.55, 0.07, 0.07, bodyM);
          lm.position.x = side * 0.28;
          lg.add(lm);
          lg.rotation.z = side * -0.5;
          legs.push(lg);
        }
      }
      g.add(abdomen, thorax, head, ...legs);
      return { mesh: g, limbs: { legs, head }, mats };
    }

    if (kind === 'creeper') {
      const skin = this.skin('creeper', '#58a84a', '#3f8a36');
      const faceTex = this.skin('creeper_face', '#58a84a', '#3f8a36', (ctx) => {
        ctx.fillStyle = '#0a0a0a';
        ctx.fillRect(1, 1, 2, 2); ctx.fillRect(5, 1, 2, 2);   // eyes
        ctx.fillRect(3, 3, 2, 3);                              // mouth
        ctx.fillRect(2, 4, 1, 3); ctx.fillRect(5, 4, 1, 3);   // mouth flares
      });
      const bodyM = this.mat(skin, mats);
      const faceM = this.mat(faceTex, mats);
      const body = this.boxMesh(0.42, 0.85, 0.28, bodyM);
      body.position.set(0, 0.78, 0);
      const head = new THREE.Group();
      head.position.set(0, 1.2, 0);
      const hb = this.boxMesh(0.46, 0.46, 0.46, [bodyM, bodyM, bodyM, bodyM, bodyM, faceM]);
      hb.position.y = 0.23;
      head.add(hb);
      const legs = [
        this.leg(0.18, 0.34, bodyM, -0.12, 0.34, -0.2),
        this.leg(0.18, 0.34, bodyM, 0.12, 0.34, -0.2),
        this.leg(0.18, 0.34, bodyM, 0.12, 0.34, 0.2),
        this.leg(0.18, 0.34, bodyM, -0.12, 0.34, 0.2),
      ];
      g.add(body, head, ...legs);
      return { mesh: g, limbs: { legs, head }, mats };
    }

    if (kind === 'skeleton') {
      const bone = this.skin('skeleton', '#d8d8d0', '#bfbfb5');
      const faceTex = this.skin('skeleton_face', '#d8d8d0', '#bfbfb5', (ctx) => {
        ctx.fillStyle = '#1a1a1a'; ctx.fillRect(1, 3, 2, 1); ctx.fillRect(5, 3, 2, 1);
        ctx.fillStyle = '#4a4a44'; ctx.fillRect(3, 5, 2, 2);
      });
      const boneM = this.mat(bone, mats);
      const faceM = this.mat(faceTex, mats);
      const torso = this.boxMesh(0.42, 0.72, 0.18, boneM);
      torso.position.set(0, 1.12, 0);
      const head = new THREE.Group();
      head.position.set(0, 1.72, 0);
      const hb = this.boxMesh(0.46, 0.46, 0.46, [boneM, boneM, boneM, boneM, boneM, faceM]);
      hb.position.y = 0.23;
      head.add(hb);
      const legs = [
        this.leg(0.14, 0.76, boneM, -0.11, 0.76, 0),
        this.leg(0.14, 0.76, boneM, 0.11, 0.76, 0),
      ];
      const arms: THREE.Group[] = [];
      for (const side of [-1, 1]) {
        const a = new THREE.Group();
        a.position.set(side * 0.3, 1.42, 0);
        const am = this.boxMesh(0.13, 0.7, 0.13, boneM);
        am.position.y = -0.35;
        a.add(am);
        a.rotation.x = -Math.PI / 2;
        arms.push(a);
      }
      // simple held bow
      const bowM = this.mat(this.skin('skel_bow', '#8a6232', '#5d4222'), mats);
      const bow = this.boxMesh(0.06, 0.5, 0.06, bowM);
      bow.position.set(-0.3, 1.42, -0.6);
      g.add(torso, head, ...legs, ...arms, bow);
      return { mesh: g, limbs: { legs, arms, head }, mats };
    }

    if (kind === 'zombie') {
      const skin = this.skin('zombie', '#4f7d4a', '#3f6a3c');
      const shirt = this.skin('zombie_shirt', '#3f6e8f', '#34597a');
      const pants = this.skin('zombie_pants', '#3a4d8f', '#2e3c70');
      const faceTex = this.skin('zombie_face', '#4f7d4a', '#3f6a3c', (ctx) => {
        ctx.fillStyle = '#1a1a1a'; ctx.fillRect(1, 3, 2, 1); ctx.fillRect(5, 3, 2, 1);
        ctx.fillStyle = '#2a3a28'; ctx.fillRect(3, 5, 2, 2);
      });
      const skinM = this.mat(skin, mats);
      const faceM = this.mat(faceTex, mats);
      const shirtM = this.mat(shirt, mats);
      const pantsM = this.mat(pants, mats);
      const torso = this.boxMesh(0.5, 0.72, 0.26, shirtM);
      torso.position.set(0, 1.12, 0);
      const head = new THREE.Group();
      head.position.set(0, 1.72, 0);
      const headBox = this.boxMesh(0.46, 0.46, 0.46, [skinM, skinM, skinM, skinM, skinM, faceM]);
      headBox.position.y = 0.23;
      head.add(headBox);
      const legs = [
        this.leg(0.22, 0.76, pantsM, -0.13, 0.76, 0),
        this.leg(0.22, 0.76, pantsM, 0.13, 0.76, 0),
      ];
      const arms: THREE.Group[] = [];
      for (const side of [-1, 1]) {
        const a = new THREE.Group();
        a.position.set(side * 0.36, 1.42, 0);
        const am = this.boxMesh(0.2, 0.7, 0.2, skinM);
        am.position.y = -0.35;
        a.add(am);
        a.rotation.x = -Math.PI / 2;
        arms.push(a);
      }
      g.add(torso, head, ...legs, ...arms);
      return { mesh: g, limbs: { legs, arms, head }, mats };
    }

  if (kind === 'wolf') {
    const fur = this.skin('wolf', '#a8a8a8', '#8c8c8c');
    const faceTex = this.skin('wolf_face', '#a8a8a8', '#8c8c8c', (ctx) => {
      ctx.fillStyle = '#d85a2a'; ctx.fillRect(2, 2, 1, 1); ctx.fillRect(5, 2, 1, 1);
      ctx.fillStyle = '#1a1a1a'; ctx.fillRect(3, 4, 2, 1);
    });
    const bodyM = this.mat(fur, mats);
    const faceM = this.mat(faceTex, mats);
    const whiteM = this.mat(this.skin('wolf_white', '#eceae4', '#dcd9d0'), mats);
    const body = this.boxMesh(0.55, 0.42, 0.95, bodyM);
    body.position.set(0, 0.5, 0.05);
    // pale chest/underside — the classic two-tone wolf coat
    const chest = this.boxMesh(0.5, 0.26, 0.5, whiteM);
    chest.position.set(0, 0.42, -0.18);
    const head = new THREE.Group();
    head.position.set(0, 0.55, -0.5);
    head.add(this.boxMesh(0.36, 0.36, 0.36, [bodyM, bodyM, bodyM, bodyM, bodyM, faceM]));
    // white snout reads instantly as a dog/wolf
    const snout = this.boxMesh(0.18, 0.16, 0.16, [whiteM, whiteM, whiteM, whiteM, whiteM, faceM]);
    snout.position.set(0, -0.07, -0.2);
    head.add(snout);
    // upright pointed ears (angled outward)
    const earL = this.boxMesh(0.09, 0.18, 0.06, bodyM);
    earL.position.set(-0.11, 0.24, 0.02); earL.rotation.z = 0.2;
    const earR = earL.clone(); earR.position.x = 0.11; earR.rotation.z = -0.2;
    head.add(earL, earR);
    const legs = [
      this.leg(0.14, 0.32, whiteM, -0.18, 0.32, -0.3),
      this.leg(0.14, 0.32, whiteM, 0.18, 0.32, -0.3),
      this.leg(0.14, 0.32, whiteM, 0.18, 0.32, 0.35),
      this.leg(0.14, 0.32, whiteM, -0.18, 0.32, 0.35),
    ];
    // tail pivots at its base so it can wag; pale tip
    const tail = new THREE.Group();
    tail.position.set(0, 0.56, 0.46);
    const tailM = this.boxMesh(0.12, 0.12, 0.4, bodyM);
    tailM.position.z = 0.2;
    const tailTip = this.boxMesh(0.13, 0.13, 0.14, whiteM);
    tailTip.position.z = 0.4;
    tail.add(tailM, tailTip);
    tail.rotation.x = -0.5;
    g.add(body, head, chest, tail, ...legs);
    return { mesh: g, limbs: { legs, head, tail, body }, mats };
  }

  if (kind === 'villager') {
    const robe = this.skin('villager', '#7a5a3a', '#6a4d30');
    const faceTex = this.skin('villager_face', '#c8a878', '#b89868', (ctx) => {
      ctx.fillStyle = '#4a3a2a'; ctx.fillRect(1, 1, 6, 2); // brow/unibrow
      ctx.fillStyle = '#1a1a1a'; ctx.fillRect(2, 3, 1, 1); ctx.fillRect(5, 3, 1, 1); // eyes
      ctx.fillStyle = '#8a6a4a'; ctx.fillRect(3, 5, 2, 1); // mouth
    });
    const robeM = this.mat(robe, mats);
    const faceM = this.mat(faceTex, mats);
    const torso = this.boxMesh(0.5, 0.8, 0.28, robeM);
    torso.position.set(0, 1.1, 0);
    const head = new THREE.Group();
    head.position.set(0, 1.72, 0);
    const hb = this.boxMesh(0.46, 0.46, 0.46, [faceM, faceM, faceM, faceM, faceM, faceM]);
    hb.position.y = 0.23;
    head.add(hb);
    const legs = [
      this.leg(0.2, 0.76, robeM, -0.13, 0.76, 0),
      this.leg(0.2, 0.76, robeM, 0.13, 0.76, 0),
    ];
    const arms: THREE.Group[] = [];
    for (const side of [-1, 1]) {
      const a = new THREE.Group();
      a.position.set(side * 0.32, 1.5, 0);
      const am = this.boxMesh(0.16, 0.72, 0.18, robeM);
      am.position.y = -0.36;
      a.add(am);
      arms.push(a);
    }
    g.add(torso, head, ...legs, ...arms);
    return { mesh: g, limbs: { legs, arms, head }, mats };
  }

  if (kind === 'horse') {
    const [coat, speck, mane] = HORSE_COATS[variant] ?? HORSE_COATS[0];
    const hide = this.skin(`horse_${variant}`, coat, speck);
    const faceTex = this.skin(`horse_face_${variant}`, coat, speck, (ctx) => {
      ctx.fillStyle = '#16110c'; ctx.fillRect(1, 2, 1, 2); ctx.fillRect(6, 2, 1, 2); // eyes
      ctx.fillStyle = '#000000'; ctx.fillRect(2, 6, 1, 1); ctx.fillRect(5, 6, 1, 1); // nostrils
    });
    const bodyM = this.mat(hide, mats);
    const faceM = this.mat(faceTex, mats);
    const maneM = this.mat(this.skin(`horse_mane_${variant}`, mane, mane), mats);

    // body group (bobs gently while idle); holds torso + neck + mane
    const body = new THREE.Group();
    const torso = this.boxMesh(0.7, 0.6, 1.25, bodyM);
    torso.position.set(0, 1.15, 0.1);
    const neck = this.boxMesh(0.34, 0.72, 0.36, bodyM);
    neck.position.set(0, 1.46, -0.5); neck.rotation.x = 0.5;
    const maneStrip = this.boxMesh(0.1, 0.74, 0.16, maneM);
    maneStrip.position.set(0, 1.5, -0.42); maneStrip.rotation.x = 0.5;
    body.add(torso, neck, maneStrip);

    // head pivots for look-tracking; snout + ears + forelock
    const head = new THREE.Group();
    head.position.set(0, 1.82, -0.66);
    const headBox = this.boxMesh(0.3, 0.44, 0.34, [bodyM, bodyM, bodyM, bodyM, bodyM, faceM]);
    headBox.position.y = 0.02;
    const snout = this.boxMesh(0.26, 0.26, 0.28, [bodyM, bodyM, bodyM, bodyM, bodyM, faceM]);
    snout.position.set(0, -0.08, -0.28);
    const earL = this.boxMesh(0.08, 0.16, 0.06, bodyM); earL.position.set(-0.1, 0.32, 0.05);
    const earR = earL.clone(); earR.position.x = 0.1;
    const forelock = this.boxMesh(0.16, 0.12, 0.1, maneM); forelock.position.set(0, 0.26, -0.02);
    head.add(headBox, snout, earL, earR, forelock);

    const legs = [
      this.leg(0.18, 0.9, bodyM, -0.26, 0.9, -0.42),
      this.leg(0.18, 0.9, bodyM, 0.26, 0.9, -0.42),
      this.leg(0.18, 0.9, bodyM, 0.26, 0.9, 0.52),
      this.leg(0.18, 0.9, bodyM, -0.26, 0.9, 0.52),
    ];

    const tail = new THREE.Group();
    tail.position.set(0, 1.32, 0.72);
    const tailM = this.boxMesh(0.13, 0.6, 0.13, maneM);
    tailM.position.y = -0.28;
    tail.add(tailM);
    tail.rotation.x = -0.35;

    g.add(body, head, tail, ...legs);
    return { mesh: g, limbs: { legs, head, tail, body }, mats };
  }

  if (kind === 'cat') {
    const [coat, speck, belly] = CAT_COATS[variant] ?? CAT_COATS[0];
    const fur = this.skin(`cat_${variant}`, coat, speck);
    const faceTex = this.skin(`cat_face_${variant}`, coat, speck, (ctx) => {
      ctx.fillStyle = '#7cd24a'; ctx.fillRect(2, 3, 1, 1); ctx.fillRect(5, 3, 1, 1); // green eyes
      ctx.fillStyle = '#d88a8a'; ctx.fillRect(3, 5, 2, 1); // nose
    });
    const bodyM = this.mat(fur, mats);
    const faceM = this.mat(faceTex, mats);
    const legM = this.mat(this.skin(`cat_paw_${variant}`, belly, belly), mats);

    const body = new THREE.Group();
    const torso = this.boxMesh(0.3, 0.28, 0.62, bodyM);
    torso.position.set(0, 0.36, 0.05);
    body.add(torso);

    const head = new THREE.Group();
    head.position.set(0, 0.44, -0.32);
    head.add(this.boxMesh(0.27, 0.25, 0.24, [bodyM, bodyM, bodyM, bodyM, bodyM, faceM]));
    const earL = this.boxMesh(0.08, 0.1, 0.05, bodyM); earL.position.set(-0.08, 0.17, 0.02);
    const earR = earL.clone(); earR.position.x = 0.08;
    head.add(earL, earR);

    const legs = [
      this.leg(0.08, 0.3, legM, -0.1, 0.3, -0.18),
      this.leg(0.08, 0.3, legM, 0.1, 0.3, -0.18),
      this.leg(0.08, 0.3, legM, 0.1, 0.3, 0.24),
      this.leg(0.08, 0.3, legM, -0.1, 0.3, 0.24),
    ];

    // upright tail with a slight curl
    const tail = new THREE.Group();
    tail.position.set(0, 0.42, 0.34);
    const tailM = this.boxMesh(0.08, 0.42, 0.08, bodyM);
    tailM.position.y = 0.18;
    tail.add(tailM);
    tail.rotation.x = 0.5;

    g.add(body, head, tail, ...legs);
    return { mesh: g, limbs: { legs, head, tail, body }, mats };
  }

  // phantom: a small flying mob with two angular wings
  {
    const skin = this.skin('phantom', '#4a4a5a', '#3a3a48');
    const faceTex = this.skin('phantom_face', '#4a4a5a', '#3a3a48', (ctx) => {
      ctx.fillStyle = '#c43030'; ctx.fillRect(2, 2, 1, 1); ctx.fillRect(5, 2, 1, 1);
      ctx.fillStyle = '#1a1a1a'; ctx.fillRect(3, 4, 2, 2);
    });
    const bodyM = this.mat(skin, mats);
    const faceM = this.mat(faceTex, mats);
    const body = this.boxMesh(0.5, 0.3, 0.9, bodyM);
    body.position.set(0, 0.2, 0);
    const head = new THREE.Group();
    head.position.set(0, 0.25, -0.55);
    head.add(this.boxMesh(0.34, 0.3, 0.34, [bodyM, bodyM, bodyM, bodyM, bodyM, faceM]));
    // wings as flat angled planes attached at the shoulders
    const wings: THREE.Group[] = [];
    for (const side of [-1, 1]) {
      const w = new THREE.Group();
      w.position.set(side * 0.3, 0.25, 0);
      const wm = this.boxMesh(0.06, 0.5, 0.7, bodyM);
      wm.position.set(side * 0.35, 0.1, 0.1);
      wm.rotation.z = side * -0.3;
      w.add(wm);
      wings.push(w);
    }
    g.add(body, head, ...wings);
    return { mesh: g, limbs: { legs: wings, head }, mats };
  }
}

  /** Textured cube for drops, falling blocks, and primed TNT. */
  private makeBlockMesh(blockId: number, size: number): THREE.Mesh {
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

  private buildDropMesh(itemId: number): THREE.Group {
    const g = new THREE.Group();
    const d = def(itemId);
    if (d.block && (CROSS_BLOCKS.has(itemId) || itemId === B.TORCH)) {
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
    } else if (d.sprite) {
      // dropped items tumble as real 3D voxel models
      const sprite = this.atlas.sprite(d.sprite);
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
