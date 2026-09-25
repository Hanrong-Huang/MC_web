// Player: survival/creative movement with Minecraft's numbers, AABB physics,
// breaking with crack progress, placing, eating, attacking, health/hunger,
// fall damage, sneaking edge-guard, sprinting, and flight.

import { World } from './World';
import { Input } from './Input';
import { Renderer } from './Renderer';
import { AudioEngine } from './Audio';
import { moveEntity, hasSupport, inWater, eyeInWater, boxIntersectsBlock, Vec3 } from './Physics';
import { waterFX } from './WaterFX';
import {
  B, I, def, hasDef, breakTime, attackDamage, isSolid, canHarvest, FLOOR_BLOCKS, SELF_STACKING, mobLabel,
  attackCooldown, attackStrength, foodSaturation, pickItemFor, LEAF_BLOCKS,
  SLAB_IDS, STAIR_IDS, META_BLOCKS, slabFullBlock, isPotion, isDrink, enchLevel, enchantsFor, enchantLabel,
  repairMaterial, toolSpeed, ARMOR_CHEST, ARMOR_FEET, ARMOR_HEAD,
} from './Blocks';
import type { SlotData } from './Persistence';
import { DoorFacing } from './World';
import { Inventory } from './Inventory';
import type { EntityManager } from './EntityManager';
import type { Entity } from './EntityManager';
import type { RayHit } from './World';
import { mouseLookSens } from './ControlsSettings';
import type { PlayerSave } from './Persistence';

export type GameMode = 'survival' | 'creative';

const WALK_SPEED = 4.317;
const SPRINT_SPEED = 5.612;
const SNEAK_SPEED = 1.295;
const FLY_SPEED = WALK_SPEED * 2.5;     // creative flight: 2.5x multiplier
const FLY_VERT = 7.5;
const JUMP_VELOCITY = Math.sqrt(2 * 32 * 1.25); // exactly 1.25 blocks high
const LADDER_SPEED = 3.4;
const GRAVITY = 32;
const TERMINAL = 78;
const EYE_HEIGHT = 1.62;
const EYE_SNEAK = 1.54;
const REACH = 4.5;
const BOX = { w: 0.6, h: 1.8 };
/** a raised shield takes this long to come up before it starts blocking */
const SHIELD_RAISE = 0.25;
/** vanilla hurt-immunity window: repeat hits inside it only land the excess */
const MOB_IFRAMES = 0.5;
/** survival pause between finishing one block and starting to dig the next */
const BREAK_DELAY = 0.25;

/** Timed status effects (golden apples, potions, spoiled food; milk clears them). */
export type EffectId = 'regeneration' | 'absorption' | 'resistance' | 'fire_resistance' | 'hunger'
  | 'speed' | 'night_vision' | 'water_breathing' | 'strength' | 'jump_boost';
export interface ActiveEffect { amp: number; t: number; total: number }
export const EFFECT_LABELS: Record<EffectId, string> = {
  regeneration: 'Regeneration', absorption: 'Absorption', resistance: 'Resistance',
  fire_resistance: 'Fire Resistance', hunger: 'Hunger',
  speed: 'Speed', night_vision: 'Night Vision', water_breathing: 'Water Breathing',
  strength: 'Strength', jump_boost: 'Jump Boost',
};

/** What each potion does when drunk: an effect (seconds, level) or instant healing. */
const POTION_EFFECTS: Partial<Record<number, { id?: EffectId; t?: number; amp?: number; heal?: number }>> = {
  [I.POTION_HEALING]: { heal: 8 },
  [I.POTION_SWIFTNESS]: { id: 'speed', t: 180 },
  [I.POTION_NIGHT_VISION]: { id: 'night_vision', t: 180 },
  [I.POTION_WATER_BREATHING]: { id: 'water_breathing', t: 180 },
  [I.POTION_FIRE_RESISTANCE]: { id: 'fire_resistance', t: 180 },
  [I.POTION_STRENGTH]: { id: 'strength', t: 180 },
  [I.POTION_LEAPING]: { id: 'jump_boost', t: 180 },
  [I.POTION_REGENERATION]: { id: 'regeneration', t: 45 },
};

/** Experience points needed to go from `level` to the next (vanilla curve). */
export function xpForLevel(level: number): number {
  return level >= 31 ? 9 * level - 158 : level >= 16 ? 5 * level - 38 : 2 * level + 7;
}

/** Things a composter accepts, with the chance each raises its level (vanilla). */
const COMPOST_CHANCE = new Map<number, number>([
  [I.SEEDS, 0.3], [I.BEETROOT_SEEDS, 0.3], [I.PUMPKIN_SEEDS, 0.3], [I.MELON_SEEDS, 0.3],
  [B.LEAVES, 0.3], [B.BIRCH_LEAVES, 0.3], [B.SPRUCE_LEAVES, 0.3], [B.JUNGLE_LEAVES, 0.3],
  [B.SAPLING, 0.3], [B.TALL_GRASS, 0.3], [I.MELON_SLICE, 0.5], [B.SUGAR_CANE, 0.5], [B.CACTUS, 0.5],
  [I.WHEAT, 0.65], [I.APPLE, 0.65], [I.CARROT, 0.65], [I.POTATO, 0.65], [I.BEETROOT, 0.65],
  [B.POPPY, 0.65], [B.DANDELION, 0.65], [B.CORNFLOWER, 0.65], [B.ALLIUM, 0.65], [B.OXEYE_DAISY, 0.65],
  [B.BROWN_MUSHROOM, 0.65], [B.RED_MUSHROOM, 0.65], [B.PUMPKIN, 0.65], [B.MELON, 0.65],
  [I.BREAD, 0.85], [I.BAKED_POTATO, 0.85], [I.COOKIE, 0.85], [B.HAY_BALE, 0.85],
  [I.PUMPKIN_PIE, 1], [B.CAKE, 1],
]);

/** Plants that fit in a flower pot. */
const POTTABLE = new Set<number>([
  B.POPPY, B.DANDELION, B.CORNFLOWER, B.ALLIUM, B.OXEYE_DAISY, B.SAPLING,
  B.BROWN_MUSHROOM, B.RED_MUSHROOM, B.TALL_GRASS, B.CACTUS,
]);

export interface PlayerDeps {
  world: World;
  input: Input;
  renderer: Renderer;
  entities: EntityManager;
  audio: AudioEngine;
  isUIOpen: () => boolean;
  openContainer: (kind: 'table' | 'furnace' | 'chest', x: number, y: number, z: number) => void;
  openTrade: (villager: Entity) => void;
  useBed: (x: number, y: number, z: number) => void;
  igniteTnt: (x: number, y: number, z: number) => void;
  useDoor: (x: number, y: number, z: number) => void;
  onBreak: (blockId: number) => void;
  onPlantSeed: () => void;
  /** Apply bone meal at a block; returns true if something grew. */
  onBoneMeal: (x: number, y: number, z: number) => boolean;
  onFish: (itemId: number) => void;
  onTameWolf: () => void;
  onTrade: () => void;
  onDeath: () => void;
  onTeleport: () => void;
  onRedstoneUpdate: (x: number, y: number, z: number) => void;
  /** brief on-screen message (tool warnings, etc.) */
  toast: (msg: string) => void;
  /** a gameplay milestone happened (advancement id) */
  onAdvance?: (id: string) => void;
  /** light a fire in an air cell (flint & steel); false if it can't burn there */
  ignite?: (x: number, y: number, z: number) => boolean;
  /** experience earned at a spot (mined ore, smelting ...): spawn orbs there */
  onXp?: (x: number, y: number, z: number, points: number) => void;
  /** put a raw food item on a campfire; false if it's full or not cookable */
  cookOnCampfire?: (x: number, y: number, z: number, itemId: number) => boolean;
  /** throw a warp pearl / snowball along a direction */
  throwItem?: (itemId: number, x: number, y: number, z: number, dx: number, dy: number, dz: number) => void;
}

export class Player {
  pos: Vec3 = { x: 0, y: 80, z: 0 };
  vel: Vec3 = { x: 0, y: 0, z: 0 };
  yaw = 0;
  pitch = 0;
  mode: GameMode = 'survival';
  flying = false;
  sneaking = false;
  sprinting = false;
  onGround = false;
  swimming = false;
  /** true while the player's body overlaps a ladder block */
  onLadder = false;
  hp = 20;
  hunger = 20;
  /** hidden hunger buffer drained before the hunger bar (vanilla saturation) */
  saturation = 5;
  exhaustion = 0;
  /** extra golden hearts from Absorption, soaked up before real health */
  absorb = 0;
  effects = new Map<EffectId, ActiveEffect>();
  /** shield raised (right mouse held with a shield); blocking once fully up */
  blocking = false;
  /** looking through a spyglass (right mouse held) */
  scoping = false;
  /** seconds left on fire (set by fire/lava, put out by water or rain) */
  fireT = 0;
  private burnTickT = 0;
  /** remaining air bubbles (x2 half-bubbles like hearts), 20 = full */
  air = 20;
  dead = false;
  inventory = new Inventory();

  target: RayHit | null = null;
  breaking: { x: number; y: number; z: number; progress: number; time: number } | null = null;
  /** seconds the bow has been drawn; 0 = not drawing */
  bowCharge = 0;
  /** active fishing bobber, if cast */
  bobber: Entity | null = null;
  /** the horse currently being ridden, if any */
  riding: Entity | null = null;
  private prevSneak = false;

  private deps!: PlayerDeps;
  private fallDist = 0;
  /** seconds since the last swing: attack strength recharges over attackCooldown() */
  private attackTimer = 10;
  private placeCooldown = 0;
  private breakDelay = 0;
  private blockT = 0;
  private shieldKnockT = 0;
  private regenEffT = 0;
  /** running clock for per-mob hurt immunity */
  private clock = 0;
  private lastHits = new WeakMap<Entity, { t: number; dmg: number }>();
  private eatT = 0;
  private chewT = 0;
  /** true while actively consuming food — drives the held-item eating animation */
  eating = false;
  private stepDist = 0;
  private swingRepeat = 0;
  private regenT = 0;
  private starveT = 0;
  private hurtCooldown = 0;
  /** human-readable cause of the last damage taken (shown on the death screen) */
  lastDamageCause = '';
  /** camera shake: remaining time, total duration, and max offset in blocks */
  shakeT = 0;
  shakeDur = 0.3;
  shakeMag = 0;
  private airT = 0;
  private drownT = 0;
  private cactusT = 0;
  private lavaT = 0;
  private swimSoundT = 0;
  /** feet were in water last frame (splash on entry, drip on exit) */
  private feetWet = false;
  /** seconds the body has been in water (a quick dip doesn't count as climbing out) */
  private soakT = 0;
  private dripT = 0;
  private rippleT = 0;

  portalTimer = 0;
  portalCooldown = 0;

  /** experience level + progress (0..1) toward the next one */
  xpLevel = 0;
  xpProgress = 0;
  /** gliding on a worn glider (jump mid-fall to deploy) */
  gliding = false;
  private glideWearT = 0;
  /** seconds of firework thrust left while gliding */
  private rocketT = 0;
  private prevSpace = false;
  /** where the player last died (recovery compass), if ever */
  lastDeath: { x: number; y: number; z: number; dim: 'overworld' | 'nether' } | null = null;

  init(deps: PlayerDeps): void {
    this.deps = deps;
  }

  eyeHeight(): number {
    return this.sneaking ? EYE_SNEAK : EYE_HEIGHT;
  }

  lookDir(): Vec3 {
    const cp = Math.cos(this.pitch);
    return {
      x: -Math.sin(this.yaw) * cp,
      y: Math.sin(this.pitch),
      z: -Math.cos(this.yaw) * cp,
    };
  }

  heldId(): number {
    return this.inventory.getSelected()?.id ?? 0;
  }

  /** captured-mob kind on the held stack (filled catcher), else undefined. */
  heldMob(): string | undefined {
    return this.inventory.getSelected()?.mob;
  }

  /** Put a freshly filled catcher into the first empty slot, or drop it if full.
   *  Called by the player and by a thrown orb that found its mark. */
  giveFilledCatcher(kind: string): void {
    const idx = this.inventory.firstEmpty();
    if (idx >= 0) this.inventory.slots[idx] = { id: I.MOB_CATCHER_FILLED, count: 1, mob: kind };
    else this.deps.entities.spawnDrop(this.pos.x, this.pos.y + 1, this.pos.z, I.MOB_CATCHER_FILLED, 1, undefined, kind);
  }

  toggleFly(): void {
    this.flying = !this.flying;
    if (this.flying) this.vel.y = 0;
    this.fallDist = 0;
  }

  selectSlot(i: number): void {
    const next = ((i % 9) + 9) % 9;
    if (next !== this.inventory.selected) {
      this.deps.audio.play('select');
      this.attackTimer = 0; // switching weapons resets the swing charge (vanilla)
    }
    this.inventory.selected = next;
    this.inventory.onChange();
  }

  /** Swing strength 0..1 — how recharged the next attack is. */
  attackCharge(): number {
    return Math.min(1, this.attackTimer / attackCooldown(this.heldId()));
  }

  /** Shield fully raised and able to turn aside a blow. */
  isBlocking(): boolean {
    return this.blocking && this.blockT >= SHIELD_RAISE;
  }

  // --- status effects ---------------------------------------------------------

  /** Apply (or strengthen/extend) a status effect, vanilla-style: a stronger
   *  level replaces a weaker one; an equal level only ever extends. */
  addEffect(id: EffectId, seconds: number, amp = 0): void {
    const cur = this.effects.get(id);
    if (cur && (cur.amp > amp || (cur.amp === amp && cur.t >= seconds))) return;
    this.effects.set(id, { amp, t: seconds, total: seconds });
    if (id === 'absorption') this.absorb = Math.max(this.absorb, 4 * (amp + 1));
  }

  clearEffects(): void {
    this.effects.clear();
    this.absorb = 0;
    this.regenEffT = 0;
  }

  /** Active effects, longest-lived first, for the HUD. */
  effectList(): { id: EffectId; amp: number; t: number; total: number }[] {
    return [...this.effects].map(([id, e]) => ({ id, ...e })).sort((a, b) => b.t - a.t);
  }

  /** After-effects of finishing a food item. */
  private applyFoodEffects(id: number): void {
    if (id === I.GOLDEN_APPLE) {
      this.addEffect('regeneration', 5, 1);
      this.addEffect('absorption', 120, 0);
    } else if (id === I.ENCHANTED_GOLDEN_APPLE) {
      this.addEffect('regeneration', 20, 1);
      this.addEffect('absorption', 120, 3);
      this.addEffect('resistance', 300, 0);
      this.addEffect('fire_resistance', 300, 0);
    } else if (id === I.ROTTEN_FLESH && Math.random() < 0.8) {
      this.addEffect('hunger', 30, 0);
    } else if (id === I.CHICKEN && Math.random() < 0.3) {
      this.addEffect('hunger', 30, 0);
    } else if (id === I.MILK_BUCKET) {
      this.clearEffects();
    } else if (isPotion(id)) {
      const fx = POTION_EFFECTS[id];
      if (fx?.heal) this.hp = Math.min(20, this.hp + fx.heal);
      if (fx?.id) this.addEffect(fx.id, fx.t ?? 60, fx.amp ?? 0);
      this.deps.onAdvance?.('potion');
    } else if (id === I.EXPERIENCE_BOTTLE) {
      this.addXp(3 + Math.floor(Math.random() * 9));
    } else if (id === I.PUMPKIN_PIE || id === I.COOKIE || id === I.MUSHROOM_STEW) {
      this.deps.onAdvance?.('baker');
    }
  }

  // --- experience --------------------------------------------------------------

  /** Gain experience points; returns true if a level was reached. */
  addXp(points: number): boolean {
    if (points <= 0) return false;
    let p = this.xpProgress * xpForLevel(this.xpLevel) + points;
    let leveled = false;
    while (p >= xpForLevel(this.xpLevel)) {
      p -= xpForLevel(this.xpLevel);
      this.xpLevel++;
      leveled = true;
    }
    this.xpProgress = p / xpForLevel(this.xpLevel);
    if (leveled) {
      this.deps.audio.play(this.xpLevel % 5 === 0 ? 'advancement' : 'level', 0.7);
      if (this.xpLevel >= 10) this.deps.onAdvance?.('xp_10');
    }
    return leveled;
  }

  /** Spend whole levels (enchanting, anvil); false if the player lacks them. Creative is free. */
  spendLevels(n: number): boolean {
    if (this.mode === 'creative') return true;
    if (this.xpLevel < n) return false;
    this.xpLevel -= n;
    return true;
  }

  /** Points dropped on death (vanilla: 7 per level, capped at 100). */
  deathXp(): number {
    return Math.min(100, this.xpLevel * 7);
  }

  // --- item tossing + pick block ---------------------------------------------

  /** Q: toss one of the held item (or the whole stack) in the look direction. */
  dropSelected(all: boolean): void {
    if (this.dead) return;
    const inv = this.inventory;
    const s = inv.slots[inv.selected];
    if (!s) return;
    const n = all ? s.count : 1;
    const d = this.lookDir();
    const ey = this.pos.y + this.eyeHeight() - 0.3;
    const e = this.deps.entities.spawnDrop(
      this.pos.x + d.x * 0.3, ey, this.pos.z + d.z * 0.3, s.id, n, s.dur, s.mob, s.ench,
    );
    // thrown clear of the player, with a pickup delay so it isn't slurped straight back
    e.vel = { x: d.x * 7.5, y: d.y * 7.5 + 2.2, z: d.z * 7.5 };
    e.age = -1.4;
    s.count -= n;
    if (s.count <= 0) inv.slots[inv.selected] = null;
    this.deps.renderer.triggerSwing();
    this.deps.audio.play('whoosh');
    inv.onChange();
  }

  /** Middle click: select the targeted block's item in the hotbar. Creative
   *  conjures a stack; survival pulls it out of the backpack if it's there. */
  pickBlock(): void {
    if (this.dead || !this.target) return;
    const id = pickItemFor(this.target.id);
    if (!id) return;
    const inv = this.inventory;
    for (let i = 0; i < 9; i++) {
      if (inv.slots[i]?.id === id) { this.selectSlot(i); return; }
    }
    // hotbar destination: the selected slot if free, else the first free one,
    // else swap out whatever is selected
    let dst = inv.selected;
    if (inv.slots[dst]) {
      for (let i = 0; i < 9; i++) if (!inv.slots[i]) { dst = i; break; }
    }
    if (this.mode === 'creative') {
      if (inv.slots[dst]) {
        // keep the displaced stack by moving it into the backpack when there's room
        const free = inv.slots.findIndex((sl, i) => i >= 9 && !sl);
        if (free >= 0) inv.slots[free] = inv.slots[dst];
      }
      inv.slots[dst] = { id, count: def(id).stack };
    } else {
      const src = inv.slots.findIndex((sl, i) => i >= 9 && sl?.id === id);
      if (src < 0) return;
      const tmp = inv.slots[dst];
      inv.slots[dst] = inv.slots[src];
      inv.slots[src] = tmp;
    }
    this.selectSlot(dst);
    inv.onChange();
  }

  // -------------------------------------------------------------------------

  update(dt: number): void {
    const { input, world } = this.deps;
    const uiOpen = this.deps.isUIOpen() || this.dead;

    // mouse look (pointer-lock on desktop, touch-drag on mobile)
    if (input.active && !uiOpen) {
      const [dx, dy] = input.consumeMouse();
      const sens = mouseLookSens();
      this.yaw -= dx * sens;
      this.pitch -= dy * sens;
      const lim = Math.PI / 2 - 0.001;
      this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
    } else {
      input.consumeMouse();
    }

    this.attackTimer += dt;
    this.clock += dt;
    this.placeCooldown = Math.max(0, this.placeCooldown - dt);
    this.hurtCooldown = Math.max(0, this.hurtCooldown - dt);
    this.shieldKnockT = Math.max(0, this.shieldKnockT - dt);

    // held-use items: raise a shield / peer through a spyglass while right is held
    const useHeld = !uiOpen && input.active && input.rightDown && !this.riding;
    const heldNow = this.heldId();
    this.blocking = useHeld && heldNow === I.SHIELD;
    this.blockT = this.blocking ? this.blockT + dt : 0;
    this.scoping = useHeld && heldNow === I.SPYGLASS;

    // riding a horse: the horse is driven instead of the player's own body
    if (this.riding) { this.updateRiding(dt); return; }

    // movement intent
    let fwd = 0, strafe = 0;
    let space = false;
    this.sneaking = false;
    if (!uiOpen && input.active) {
      if (input.down('KeyW')) fwd += 1;
      if (input.down('KeyS')) fwd -= 1;
      if (input.down('KeyA')) strafe -= 1;
      if (input.down('KeyD')) strafe += 1;
      space = input.down('Space');
      this.sneaking = (input.down('ControlLeft') || input.down('ControlRight')) && !this.flying;
    }

    // sprint upkeep (a raised shield or spyglass slows you to a shuffle)
    if (this.sprinting) {
      const canSprint = fwd > 0 && !this.sneaking && !this.blocking && !this.scoping &&
        (this.mode === 'creative' || this.hunger > 6);
      if (!canSprint) this.sprinting = false;
    }
    if ((input.down('ShiftLeft') || input.down('ShiftRight')) && fwd > 0 && !this.sneaking &&
      !this.blocking && !this.scoping && (this.mode === 'creative' || this.hunger > 6)) {
      this.sprinting = true;
    }

    const wasInWater = inWater(world, this.pos, BOX);
    this.swimming = wasInWater;
    // ladder check: scan the body column for a ladder block
    this.onLadder = false;
    if (!this.flying) {
      const hw = BOX.w / 2;
      for (let by = Math.floor(this.pos.y); by <= Math.floor(this.pos.y + BOX.h); by++) {
        for (let bz = Math.floor(this.pos.z - hw); bz <= Math.floor(this.pos.z + hw); bz++) {
          for (let bx = Math.floor(this.pos.x - hw); bx <= Math.floor(this.pos.x + hw); bx++) {
            if (world.getBlock(bx, by, bz) === B.LADDER) { this.onLadder = true; break; }
          }
          if (this.onLadder) break;
        }
        if (this.onLadder) break;
      }
    }

    // wish velocity in world space
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    let wx = (-sin * fwd + cos * strafe);
    let wz = (-cos * fwd - sin * strafe);
    const len = Math.hypot(wx, wz);
    if (len > 1) { wx /= len; wz /= len; }

    let speed: number;
    if (this.flying) speed = this.sprinting ? FLY_SPEED * 2 : FLY_SPEED;
    else if (this.sneaking) speed = SNEAK_SPEED;
    else if (this.sprinting) speed = SPRINT_SPEED;
    else speed = WALK_SPEED;
    if (wasInWater && !this.flying) speed *= 0.5;
    if ((this.blocking || this.scoping) && !this.flying) speed *= 0.3;
    const swift = this.effects.get('speed');
    if (swift && !this.flying) speed *= 1 + 0.2 * (swift.amp + 1);

    const underFeet = world.getBlock(Math.floor(this.pos.x), Math.floor(this.pos.y - 0.1), Math.floor(this.pos.z));
    // ice: barely any grip, so you glide on and skid to a stop
    const onIce = this.onGround && !this.flying && (underFeet === B.ICE || underFeet === B.PACKED_ICE);
    if (onIce && this.sprinting) speed *= 1.3;

    // glider: a fresh jump press mid-fall deploys it; landing or water folds it
    const spaceEdge = space && !this.prevSpace;
    this.prevSpace = space;
    if (!this.gliding && spaceEdge && this.canGlide() && !this.onGround && !wasInWater && !this.onLadder && !this.flying && this.vel.y < -1) {
      this.gliding = true;
      this.glideWearT = 0;
      this.deps.audio.play('whoosh');
      this.deps.onAdvance?.('glide');
    }
    if (this.gliding && (this.onGround || wasInWater || this.flying || this.onLadder || !this.canGlide())) {
      this.gliding = false;
      this.rocketT = 0;
    }
    if (underFeet === B.SOUL_SAND && !this.flying) {
      speed *= 0.4;
    }
    // magma block scorches the feet (unless sneaking) — lighter than lava, and
    // shares the lava burn cooldown so you can't be double-burned
    if (underFeet === B.MAGMA && this.onGround && !this.flying && !this.sneaking &&
        this.mode === 'survival' && this.lavaT <= 0) {
      this.lavaT = 0.5;
      this.damage(1, undefined, 'Burned by a magma block');
      this.deps.entities.spawnBlockParticles(
        Math.floor(this.pos.x), Math.floor(this.pos.y), Math.floor(this.pos.z), B.MAGMA, 2);
    }

    // snappy acceleration with slight air control; a sprint-jumper keeps most of
    // the take-off boost through the air (that's what makes sprint-jumping fast)
    const accelK = this.flying ? 9 : this.onGround ? (onIce ? (underFeet === B.PACKED_ICE ? 0.8 : 1.3) : 16)
      : wasInWater ? 7 : this.sprinting ? 1.8 : 4.2;
    const blend = Math.min(1, accelK * dt);
    if (!this.gliding) {
      this.vel.x += (wx * speed - this.vel.x) * blend;
      this.vel.z += (wz * speed - this.vel.z) * blend;
    }

    // vertical
    if (this.gliding) {
      this.glidePhysics(dt);
      this.fallDist = 0;
    } else if (this.flying) {
      const upWish = (space ? FLY_VERT : 0) + (this.sneakKeyDown() ? -FLY_VERT : 0);
      this.vel.y += (upWish - this.vel.y) * Math.min(1, 10 * dt);
      this.fallDist = 0;
    } else if (wasInWater) {
      const targetVy = space ? 3.9 : -2.2;
      this.vel.y += (targetVy - this.vel.y) * Math.min(1, 5 * dt);
      this.fallDist = 0;
    } else if (this.onLadder) {
      // ladder: hold to climb up, sneak to descend, otherwise slow slide
      let targetVy: number;
      if (space) targetVy = LADDER_SPEED;
      else if (this.sneakKeyDown()) targetVy = -LADDER_SPEED * 0.6;
      else targetVy = Math.min(this.vel.y, -0.6); // gentle cling
      this.vel.y += (targetVy - this.vel.y) * Math.min(1, 10 * dt);
      this.fallDist = 0;
      // no fall damage while on a ladder
    } else {
      this.vel.y -= GRAVITY * dt;
      if (this.vel.y < -TERMINAL) this.vel.y = -TERMINAL;
      if (space && this.onGround) {
        const leap = this.effects.get('jump_boost');
        this.vel.y = leap ? Math.sqrt(2 * GRAVITY * (1.25 + 0.55 * (leap.amp + 1))) : JUMP_VELOCITY;
        this.deps.audio.play('jump');
        this.onGround = false;
        this.addExhaustion(this.sprinting ? 0.2 : 0.05);
        // sprint-jump: a forward shove along the facing direction (vanilla +0.2 b/tick)
        if (this.sprinting) {
          this.vel.x += -Math.sin(this.yaw) * 2.2;
          this.vel.z += -Math.cos(this.yaw) * 2.2;
        }
      }
    }

    // integrate with collision
    const wasOnGround = this.onGround;
    const glideSpeed = this.gliding ? Math.hypot(this.vel.x, this.vel.z) : 0;
    const preVy = this.vel.y; // impact speed for a splash (collision zeroes it)
    const res = moveEntity(world, this.pos, this.vel, dt, BOX, this.sneaking, wasOnGround);
    // flying into a wall on a glider hurts (vanilla "kinetic energy")
    if (this.gliding && (res.hitX || res.hitZ) && glideSpeed > 9 && this.mode === 'survival') {
      this.damage(Math.max(1, Math.floor((glideSpeed - 9) * 0.6)), undefined, 'Experienced kinetic energy');
    }
    const inWaterNow = inWater(world, this.pos, BOX);
    // touching water cancels accumulated fall distance (no fall damage into water)
    if (inWaterNow) this.fallDist = 0;
    this.updateWaterFx(dt, inWaterNow, preVy);
    // climb out of water: swimming into a 1-block ledge hops you up onto it (so you
    // don't get stuck bobbing), and holding jump against any wall pushes upward.
    if (wasInWater && (res.hitX || res.hitZ)) {
      if (this.canStepUp(world, wx, wz)) this.vel.y = Math.max(this.vel.y, JUMP_VELOCITY);
      else if (space) this.vel.y = Math.max(this.vel.y, 5.0);
    }
    this.onGround = res.onGround;

    // auto-jump on touch: hop a 1-block step while walking into it, so phone
    // players don't have to tap jump for every ledge (matches Minecraft mobile)
    if (input.touchActive && this.onGround && !this.flying && !this.sneaking &&
        (res.hitX || res.hitZ) && (wx !== 0 || wz !== 0) && this.canStepUp(world, wx, wz)) {
      this.vel.y = JUMP_VELOCITY;
      this.onGround = false;
    }

    // fall damage + landing dust on hard impacts
    if (!this.flying && !wasInWater && !inWaterNow) {
      if (this.vel.y < 0) this.fallDist += -this.vel.y * dt;
      if (this.onGround && this.fallDist > 0) {
        if (this.fallDist > 2.5) {
          const below = world.getBlock(Math.floor(this.pos.x), Math.floor(this.pos.y - 0.5), Math.floor(this.pos.z));
          if (below !== B.AIR && hasDef(below)) {
            this.deps.entities.spawnBlockParticles(
              Math.floor(this.pos.x), Math.floor(this.pos.y), Math.floor(this.pos.z), below, 6);
            this.deps.audio.land(def(below).sound, below, this.fallDist);
          }
        }
        const leap = this.effects.get('jump_boost');
        let dmg = Math.floor(this.fallDist - 3 - (leap ? leap.amp + 1 : 0));
        // a hay bale breaks the fall (80% less damage, like vanilla)
        const landedOn = world.getBlock(Math.floor(this.pos.x), Math.floor(this.pos.y - 0.5), Math.floor(this.pos.z));
        if (landedOn === B.HAY_BALE) dmg = Math.floor(dmg * 0.2);
        const feather = enchLevel(this.inventory.armor[ARMOR_FEET], 'feather_falling');
        if (feather > 0 && dmg > 0) dmg = Math.floor(dmg * (1 - 0.12 * feather));
        if (dmg > 0 && this.mode === 'survival') {
          this.damage(dmg, undefined, 'Fell from a high place');
          this.addExhaustion(0.3);
        }
        this.fallDist = 0;
      }
    } else {
      this.fallDist = 0;
    }

    // footsteps
    if (this.onGround && !this.flying) {
      this.stepDist += Math.hypot(this.vel.x, this.vel.z) * dt;
      if (this.stepDist > 2.1) {
        this.stepDist = 0;
        const below = world.getBlock(Math.floor(this.pos.x), Math.floor(this.pos.y - 0.5), Math.floor(this.pos.z));
        if (below !== B.AIR && hasDef(below)) this.deps.audio.step(def(below).sound, below, this.sprinting ? 'sprint' : this.sneaking ? 'sneak' : 'walk');
      }
      // vanilla: walking is free, sprinting costs 0.1 exhaustion per metre
      if (this.sprinting) this.addExhaustion(Math.hypot(this.vel.x, this.vel.z) * dt * 0.1);
    } else if (inWaterNow && !this.flying) {
      this.addExhaustion(Math.hypot(this.vel.x, this.vel.z) * dt * 0.01); // swimming
    }

    // cactus contact damage
    this.cactusT -= dt;
    if (this.mode === 'survival' && this.cactusT <= 0) {
      const hw = BOX.w / 2 + 0.08;
      const x0 = Math.floor(this.pos.x - hw), x1 = Math.floor(this.pos.x + hw);
      const y0 = Math.floor(this.pos.y - 0.08), y1 = Math.floor(this.pos.y + BOX.h);
      const z0 = Math.floor(this.pos.z - hw), z1 = Math.floor(this.pos.z + hw);
      outer:
      for (let by = y0; by <= y1; by++) {
        for (let bz = z0; bz <= z1; bz++) {
          for (let bx = x0; bx <= x1; bx++) {
            if (world.getBlock(bx, by, bz) === B.CACTUS) {
              this.cactusT = 0.8;
              this.damage(1, undefined, 'Pricked to death by a cactus');
              break outer;
            }
          }
        }
      }
    }

    // lava contact: heavy damage over time + fire particles
    this.lavaT -= dt;
    if (this.mode === 'survival' && this.lavaT <= 0) {
      const hw = BOX.w / 2;
      const x0 = Math.floor(this.pos.x - hw), x1 = Math.floor(this.pos.x + hw);
      const y0 = Math.floor(this.pos.y), y1 = Math.floor(this.pos.y + BOX.h);
      const z0 = Math.floor(this.pos.z - hw), z1 = Math.floor(this.pos.z + hw);
      let inLava = false, inFire = false;
      for (let by = y0; by <= y1 && !inLava; by++) {
        for (let bz = z0; bz <= z1 && !inLava; bz++) {
          for (let bx = x0; bx <= x1 && !inLava; bx++) {
            const id = world.getBlock(bx, by, bz);
            if (id === B.LAVA) inLava = true;
            else if (id === B.FIRE) inFire = true;
          }
        }
      }
      const fireProof = this.effects.has('fire_resistance');
      if (inFire && !inLava) {
        this.lavaT = 0.5;
        if (!fireProof) this.fireT = Math.max(this.fireT, 8);
        this.damage(1, undefined, 'Went up in flames');
      }
      if (inLava) {
        this.lavaT = 0.5;
        if (!fireProof) this.fireT = Math.max(this.fireT, 15);
        this.damage(3, undefined, 'Tried to swim in lava');
        // rising embers around the player
        const px = this.pos.x, py = this.pos.y + 0.5, pz = this.pos.z;
        for (let i = 0; i < 4; i++) {
          this.deps.entities.spawnBlockParticles(
            Math.floor(px), Math.floor(py), Math.floor(pz), B.LAVA, 1,
          );
        }
      }
    }

    // on fire: a point of damage a second until it burns out or water douses it
    if (inWaterNow || this.mode === 'creative') this.fireT = 0;
    if (this.fireT > 0) {
      this.fireT = Math.max(0, this.fireT - dt);
      this.burnTickT += dt;
      if (this.burnTickT >= 1) {
        this.burnTickT = 0;
        if (!this.effects.has('fire_resistance')) this.damage(1, undefined, 'Burned to death');
      }
    } else {
      this.burnTickT = 0;
    }

    // portal detection
    let inPortal = false;
    if (this.portalCooldown > 0) {
      this.portalCooldown -= dt;
    } else {
      const hw = BOX.w / 2;
      const x0 = Math.floor(this.pos.x - hw), x1 = Math.floor(this.pos.x + hw);
      const y0 = Math.floor(this.pos.y), y1 = Math.floor(this.pos.y + BOX.h);
      const z0 = Math.floor(this.pos.z - hw), z1 = Math.floor(this.pos.z + hw);
      for (let by = y0; by <= y1 && !inPortal; by++) {
        for (let bz = z0; bz <= z1 && !inPortal; bz++) {
          for (let bx = x0; bx <= x1 && !inPortal; bx++) {
            if (world.getBlock(bx, by, bz) === B.PORTAL) inPortal = true;
          }
        }
      }
    }

    if (inPortal) {
      this.portalTimer += dt;
      if (this.portalTimer >= 1.5) {
        this.portalTimer = 0;
        this.portalCooldown = 4.0;
        if (this.deps.onTeleport) this.deps.onTeleport();
      }
    } else {
      this.portalTimer = Math.max(0, this.portalTimer - dt * 2.0);
    }

    // void rescue: respawn-style safety net if the player escapes the world floor
    if (this.pos.y < -16) {
      if (this.mode === 'survival') this.damage(4, undefined, 'Fell out of the world');
      this.pos.y = 130;
      this.vel.y = 0;
    }

    // interaction
    if (!uiOpen && input.active) {
      this.updateTarget();
      this.updateBreaking(dt);
      this.updateRightClick(dt);
      // releasing a drawn bow fires
      if (!input.rightDown && this.bowCharge > 0) {
        this.fireBow();
        this.bowCharge = 0;
      }
    } else {
      this.target = null;
      this.cancelBreaking();
      this.eatT = 0;
      this.bowCharge = 0;
    }
    this.deps.renderer.setOutline(this.target ? { x: this.target.x, y: this.target.y, z: this.target.z } : null);
  }

  /** Wearing a glider with some life left in it? */
  private canGlide(): boolean {
    const s = this.inventory.armor[ARMOR_CHEST];
    return !!s && s.id === I.GLIDER && (s.dur ?? def(I.GLIDER).durability ?? 1) > 1;
  }

  /** Elytra-style flight, stepped in vanilla's per-tick units: looking down
   *  trades height for speed, looking up trades speed back for height, and a
   *  firework rocket shoves you along the view. */
  private glidePhysics(dt: number): void {
    const k = dt * 20; // ticks this frame
    const d = this.lookDir();
    const mcPitch = -this.pitch; // Minecraft pitch: positive looks down
    const cosP = Math.cos(mcPitch), sq = cosP * cosP;
    let vx = this.vel.x / 20, vy = this.vel.y / 20, vz = this.vel.z / 20;
    const hLook = Math.hypot(d.x, d.z);
    const hSpeed = Math.hypot(vx, vz);
    vy += (-0.08 + sq * 0.06) * k;
    if (vy < 0 && hLook > 0) {
      const lift = vy * -0.1 * sq * k;
      vy += lift; vx += (d.x / hLook) * lift; vz += (d.z / hLook) * lift;
    }
    if (mcPitch < 0 && hLook > 0) {
      const climb = hSpeed * -Math.sin(mcPitch) * 0.04 * k;
      vy += climb * 3.2; vx -= (d.x / hLook) * climb; vz -= (d.z / hLook) * climb;
    }
    if (hLook > 0) {
      vx += ((d.x / hLook) * hSpeed - vx) * 0.1 * k;
      vz += ((d.z / hLook) * hSpeed - vz) * 0.1 * k;
    }
    const dh = Math.pow(0.99, k), dv = Math.pow(0.98, k);
    vx *= dh; vz *= dh; vy *= dv;
    if (this.rocketT > 0) {
      this.rocketT -= dt;
      const kk = Math.min(1, k);
      vx += (d.x * 0.1 + (d.x * 1.5 - vx) * 0.5) * kk;
      vy += (d.y * 0.1 + (d.y * 1.5 - vy) * 0.5) * kk;
      vz += (d.z * 0.1 + (d.z * 1.5 - vz) * 0.5) * kk;
      if (Math.random() < 0.5) this.deps.entities.spawnTorchFlame(this.pos.x, this.pos.y + 0.2, this.pos.z);
    }
    this.vel.x = vx * 20; this.vel.y = vy * 20; this.vel.z = vz * 20;
    // the canvas wears a point per second aloft
    this.glideWearT += dt;
    if (this.glideWearT >= 1 && this.mode === 'survival') {
      this.glideWearT = 0;
      const s = this.inventory.armor[ARMOR_CHEST];
      if (s && !(Math.random() < this.unbreakingSkip(s))) {
        s.dur = (s.dur ?? def(s.id).durability ?? 1) - 1;
        if (s.dur <= 1) { this.deps.toast('Your Glider is worn out - mend it at an anvil'); this.deps.audio.play('lowdur'); }
        this.inventory.onChange();
      }
    }
  }

  /** Chance a use doesn't wear the item, from Unbreaking (vanilla: 1/(lvl+1) of uses cost). */
  private unbreakingSkip(s: SlotData | null): number {
    const lvl = enchLevel(s, 'unbreaking');
    return lvl > 0 ? 1 - 1 / (lvl + 1) : 0;
  }

  private sneakKeyDown(): boolean {
    return this.deps.input.down('ControlLeft') || this.deps.input.down('ControlRight');
  }

  /** Is there a single-block ledge in the wish direction we can hop onto? */
  private canStepUp(world: World, wx: number, wz: number): boolean {
    if (Math.hypot(wx, wz) < 0.1) return false;
    const solid = (id: number): boolean =>
      id !== B.AIR && id !== B.WATER && hasDef(id) && def(id).solid;
    const hw = BOX.w / 2;
    // sample the cell just ahead on the dominant axis at foot level
    const fx = Math.floor(this.pos.x + (Math.abs(wx) > Math.abs(wz) ? Math.sign(wx) * (hw + 0.3) : 0));
    const fz = Math.floor(this.pos.z + (Math.abs(wz) >= Math.abs(wx) ? Math.sign(wz) * (hw + 0.3) : 0));
    const feetY = Math.floor(this.pos.y + 0.1);
    return solid(world.getBlock(fx, feetY, fz)) &&
      !solid(world.getBlock(fx, feetY + 1, fz)) &&
      !solid(world.getBlock(fx, feetY + 2, fz));
  }

  // --- horse riding ----------------------------------------------------------

  /** Begin riding a horse (called from updateRightClick on a 'mount' result). */
  mount(horse: Entity): void {
    this.riding = horse;
    this.prevSneak = true; // ignore the shift that may still be held from sneaking
    this.deps.entities.mountHorse(horse);
    this.deps.audio.play('mount');
  }

  isRiding(): boolean { return this.riding !== null; }

  /** Drive the ridden horse from input and seat the camera on its back. */
  private updateRiding(dt: number): void {
    const { input, entities, renderer } = this.deps;
    const horse = this.riding!;
    if (horse.dead || !entities.isMount(horse) || !horse.ridden) { this.dismount(false); return; }
    this.target = null;
    renderer.setOutline(null);
    this.cancelBreaking();
    this.bowCharge = 0;
    const uiOpen = this.deps.isUIOpen() || this.dead;

    let fwd = 0, strafe = 0, jump = false, dismount = false;
    if (!uiOpen && input.active) {
      if (input.down('KeyW')) fwd += 1;
      if (input.down('KeyS')) fwd -= 1;
      if (input.down('KeyA')) strafe -= 1;
      if (input.down('KeyD')) strafe += 1;
      jump = input.down('Space');
      const sneak = this.sneakKeyDown();
      dismount = sneak && !this.prevSneak; // tap shift to dismount
      this.prevSneak = sneak;
    }

    const thrown = entities.rideHorse(horse, dt, fwd, strafe, this.yaw, jump);

    // seat the player on the horse's back so the camera rides along
    this.pos.x = horse.pos.x;
    this.pos.z = horse.pos.z;
    this.pos.y = horse.pos.y + entities.mountSeat(horse);
    this.vel.x = horse.vel.x; this.vel.y = horse.vel.y; this.vel.z = horse.vel.z;
    this.onGround = horse.onGround;
    this.sprinting = false;
    this.fallDist = 0; // the horse absorbs the fall

    if (thrown) { this.dismount(true); return; }
    if (dismount) this.dismount(true);
  }

  /** Stop riding; optionally step the player off to the side onto safe ground. */
  dismount(stepOff: boolean): void {
    const horse = this.riding;
    this.riding = null;
    this.prevSneak = false;
    if (!horse) return;
    this.deps.entities.dismountHorse(horse);
    if (stepOff) {
      // a side vector perpendicular to the look direction
      this.pos.x = horse.pos.x + Math.cos(this.yaw) * 1.0;
      this.pos.z = horse.pos.z - Math.sin(this.yaw) * 1.0;
      this.pos.y = horse.pos.y + 0.2;
      this.vel = { x: 0, y: 0, z: 0 };
    }
  }

  isMoving(): boolean {
    return Math.hypot(this.vel.x, this.vel.z) > 0.5 && this.onGround;
  }

  underwaterEye(): boolean {
    return eyeInWater(this.deps.world, this.pos, this.eyeHeight());
  }

  /** Water feedback: an impact splash sized by fall speed when the feet break
   *  the surface, strokes + a ripple wake while wading/swimming, breath
   *  bubbles under water, and a dripping exit after a proper soak. */
  private updateWaterFx(dt: number, bodyWet: boolean, vy: number): void {
    const world = this.deps.world, audio = this.deps.audio, p = this.pos;
    const feet = world.getBlock(Math.floor(p.x), Math.floor(p.y + 0.05), Math.floor(p.z)) === B.WATER;
    const under = this.underwaterEye();
    this.swimSoundT = Math.max(0, this.swimSoundT - dt);
    this.rippleT -= dt;
    if (feet && !this.feetWet) {
      // a hop in is a plop, a long drop a crash (running in adds a little)
      const k = Math.max(Math.min(1, Math.max(0, (-vy - 2) / 16)), Math.min(0.3, Math.hypot(this.vel.x, this.vel.z) * 0.05));
      audio.waterSplash(k);
      waterFX.splash(p.x, p.y + 0.3, p.z, k);
      this.swimSoundT = 0.5;
    }
    if (bodyWet) this.soakT += dt;
    if (this.feetWet && !feet && !this.flying && this.soakT > 0.5) {
      audio.waterExit();
      this.dripT = 1.5;
    }
    if (!feet) this.soakT = 0;
    this.feetWet = feet;

    const sp = Math.hypot(this.vel.x, this.vel.z);
    if ((feet || bodyWet) && !this.flying && sp > 0.7 && this.swimSoundT <= 0) {
      audio.swimStroke(under, bodyWet ? 1 : 0.6);
      this.swimSoundT = this.sprinting ? 0.45 : 0.62;
      if (under) waterFX.bubbles(p.x, p.y + this.eyeHeight() - 0.3, p.z, 2);
    }
    if (feet && !under && this.rippleT <= 0) {
      // wake while moving, a slow lazy ring while treading water
      waterFX.ripple(p.x, p.y + 0.5, p.z, sp > 0.4 ? 0.5 : 0.35);
      this.rippleT = sp > 0.4 ? 0.3 : 1.3;
    }
    if (under && Math.random() < dt * 0.6) waterFX.bubbles(p.x, p.y + this.eyeHeight() - 0.15, p.z, 2 + ((Math.random() * 3) | 0));
    if (this.dripT > 0) {
      this.dripT -= dt;
      if (Math.random() < dt * 16) waterFX.drips(p.x, p.y, p.z, 1.6, 1);
    }
  }

  // --- targeting / breaking --------------------------------------------------

  private updateTarget(): void {
    const d = this.lookDir();
    const ey = this.pos.y + this.eyeHeight();
    this.target = this.deps.world.raycast(this.pos.x, ey, this.pos.z, d.x, d.y, d.z, REACH);
  }

  private updateBreaking(dt: number): void {
    const { input, world, renderer, audio } = this.deps;
    if (!input.leftDown || !this.target) {
      this.cancelBreaking();
      return;
    }
    const t = this.target;

    if (this.mode === 'creative') {
      // instant break; throttle only by "new target" so a held click sweeps
      if (!this.breaking || this.breaking.x !== t.x || this.breaking.y !== t.y || this.breaking.z !== t.z) {
        this.breaking = { x: t.x, y: t.y, z: t.z, progress: 0, time: 0 };
        this.breakBlock(t.x, t.y, t.z, false);
        renderer.triggerSwing();
      }
      return;
    }

    // a short beat between finished blocks, like vanilla's 5-tick dig delay
    if (this.breakDelay > 0) {
      this.breakDelay -= dt;
      return;
    }
    let total = breakTime(t.id, this.heldId());
    if (!isFinite(total)) {
      this.cancelBreaking();
      return;
    }
    // Efficiency: vanilla adds lvl^2 + 1 to the right tool's mining speed
    const eff = enchLevel(this.inventory.getSelected(), 'efficiency');
    const ts = toolSpeed(t.id, this.heldId());
    if (eff > 0 && ts > 1 && canHarvest(t.id, this.heldId())) total *= ts / (ts + eff * eff + 1);
    // vanilla penalties: digging with your head underwater or while airborne
    // (jumping, swimming, clinging to a ladder) is five times slower
    if (this.underwaterEye()) total *= 5;
    if (!this.onGround && !this.flying) total *= 5;
    if (!this.breaking || this.breaking.x !== t.x || this.breaking.y !== t.y || this.breaking.z !== t.z) {
      this.breaking = { x: t.x, y: t.y, z: t.z, progress: 0, time: total };
    }
    this.breaking.progress += dt / total;

    this.swingRepeat -= dt;
    if (this.swingRepeat <= 0) {
      this.swingRepeat = 0.26;
      renderer.triggerSwing();
      audio.dig(def(t.id).sound, 0.25, 1, t.id);
      this.deps.entities.spawnHitParticles(t.x, t.y, t.z, t.nx, t.ny, t.nz, t.id);
    }

    if (this.breaking.progress >= 1) {
      this.breakBlock(t.x, t.y, t.z, true);
      this.breaking = null;
      renderer.setCrack(null, -1);
      this.addExhaustion(0.005);
      if (total > 0.05) this.breakDelay = BREAK_DELAY;
    } else {
      renderer.setCrack(this.breaking, Math.floor(this.breaking.progress * 10));
    }
  }

  private cancelBreaking(): void {
    if (this.breaking) {
      this.breaking = null;
      this.deps.renderer.setCrack(null, -1);
    }
    this.swingRepeat = 0;
  }

  private breakBlock(x: number, y: number, z: number, withDrops: boolean): void {
    const { world, entities, audio } = this.deps;
    const id = world.getBlock(x, y, z);
    if (id === B.AIR || def(id).hardness < 0) return;
    if (id === B.TORCH) world.torchFacings.delete(`${x},${y},${z}`);

    // container contents spill out
    const beKey = `${x},${y},${z}`;
    const be = world.blockEntities.get(beKey);
    if (be) {
      const spill = be.type === 'furnace' ? [be.input, be.fuel, be.output] : be.slots;
      for (const s of spill) {
        if (s) entities.spawnDrop(x + 0.5, y + 0.5, z + 0.5, s.id, s.count);
      }
      world.blockEntities.delete(beKey);
    }

    // doors: removing one half removes the other; drop a single door item
    let doorDrop = false;
    if (id === B.DOOR_LOWER) {
      world.setBlock(x, y + 1, z, B.AIR);
      world.doorStates.delete(`${x},${y},${z}`);
      doorDrop = true;
    } else if (id === B.DOOR_UPPER) {
      world.setBlock(x, y - 1, z, B.AIR);
      world.doorStates.delete(`${x},${y - 1},${z}`);
      doorDrop = true;
    } else if (id === B.TRAPDOOR) {
      world.doorStates.delete(`${x},${y},${z}`);
    }

    // beds: removing one half removes the other; drop a single bed item
    let bedDrop = false;
    if (id === B.BED || id === B.BED_HEAD) {
      const facing = world.bedFacings.get(`${x},${y},${z}`) ?? 0;
      const dvx = facing === 1 ? -1 : facing === 3 ? 1 : 0;
      const dvz = facing === 0 ? -1 : facing === 2 ? 1 : 0;
      const sign = id === B.BED_HEAD ? -1 : 1; // head's partner is back toward the foot
      const ox = x + dvx * sign, oz = z + dvz * sign;
      world.setBlock(ox, y, oz, B.AIR);
      world.bedFacings.delete(`${ox},${y},${oz}`);
      world.bedFacings.delete(`${x},${y},${z}`);
      bedDrop = true;
    }

    // shaped blocks keep a small state value (facing, slab half, pot plant ...)
    const meta = world.bedFacings.get(beKey) ?? 0;
    if (META_BLOCKS.has(id)) world.bedFacings.delete(beKey);
    if (id === B.FENCE_GATE) world.doorStates.delete(beKey);

    world.setBlock(x, y, z, B.AIR);
    audio.dig(def(id).sound, 1, 1, id);
    entities.spawnBlockParticles(x, y, z, id, 12);
    this.deps.onBreak(id);
    // ice melts back into water when broken (unless it sat over nothing, or in the Nether)
    if (id === B.ICE && this.mode === 'survival' && world.dimension !== 'nether' && world.getBlock(x, y - 1, z) !== B.AIR) {
      world.waterLevels.delete(beKey);
      if (world.setBlock(x, y, z, B.WATER)) world.scheduleWater(x, y, z);
    }
    if (withDrops && this.mode === 'survival') {
      // what the block was holding comes out with it
      if (id === B.FLOWER_POT && meta && hasDef(meta)) entities.spawnDrop(x + 0.5, y + 0.6, z + 0.5, meta, 1);
      if (id === B.COMPOSTER && meta >= 8) entities.spawnDrop(x + 0.5, y + 0.6, z + 0.5, I.BONE_MEAL, 1);
      if (id === B.SNOW_GRASS) entities.spawnDrop(x + 0.5, y + 0.6, z + 0.5, I.SNOWBALL, 1 + (Math.random() < 0.5 ? 1 : 0));
    }

    if (doorDrop && withDrops && this.mode === 'survival') {
      entities.spawnDrop(x + 0.5, y + 0.5, z + 0.5, I.WOOD_DOOR, 1);
      return;
    }
    if (bedDrop) {
      if (withDrops && this.mode === 'survival') entities.spawnDrop(x + 0.5, y + 0.5, z + 0.5, B.BED, 1);
      return;
    }

    if (withDrops && this.mode === 'survival') {
      if (def(id).hardness > 0) {
        // vanilla wear: a sword used as a pick loses two points per block
        this.damageHeldTool(true);
        if (this.inventory.getSelected() && def(this.heldId()).toolInfo?.kind === 'sword') this.damageHeldTool(true);
      }
      if (!canHarvest(id, this.heldId())) return; // wrong tool tier: no drops
      // special drop tables
      if (id === B.GRAVEL) {
        entities.spawnDrop(x + 0.5, y + 0.5, z + 0.5, Math.random() < 0.25 ? I.FLINT : B.GRAVEL, 1);
        return;
      }
      // shears clip leaves and grass tufts off whole instead of shredding them
      const shears = this.heldId() === I.SHEARS;
      if (shears && (LEAF_BLOCKS.has(id) || id === B.TALL_GRASS)) {
        entities.spawnDrop(x + 0.5, y + 0.5, z + 0.5, id, 1);
        return;
      }
      if (LEAF_BLOCKS.has(id)) {
        const r = Math.random();
        if (r < 0.06) entities.spawnDrop(x + 0.5, y + 0.5, z + 0.5, B.SAPLING, 1);
        else if (id === B.LEAVES && r < 0.1) entities.spawnDrop(x + 0.5, y + 0.5, z + 0.5, I.APPLE, 1);
        return;
      }
      if (id === B.TALL_GRASS) {
        const r = Math.random();
        if (r < 0.14) entities.spawnDrop(x + 0.5, y + 0.5, z + 0.5, I.SEEDS, 1);
        else if (r < 0.17) entities.spawnDrop(x + 0.5, y + 0.5, z + 0.5, I.BEETROOT_SEEDS, 1);
        else if (r < 0.19) entities.spawnDrop(x + 0.5, y + 0.5, z + 0.5, I.PUMPKIN_SEEDS, 1);
        else if (r < 0.205) entities.spawnDrop(x + 0.5, y + 0.5, z + 0.5, I.MELON_SEEDS, 1);
        return;
      }
      if (id === B.WHEAT_0 || id === B.WHEAT_1) {
        entities.spawnDrop(x + 0.5, y + 0.5, z + 0.5, I.SEEDS, 1);
        return;
      }
      if (id === B.WHEAT_2) {
        entities.spawnDrop(x + 0.5, y + 0.5, z + 0.5, I.WHEAT, 1);
        entities.spawnDrop(x + 0.5, y + 0.5, z + 0.5, I.SEEDS, 1 + Math.floor(Math.random() * 2));
        return;
      }
      if (id === B.CARROT_0 || id === B.CARROT_1) {
        entities.spawnDrop(x + 0.5, y + 0.5, z + 0.5, I.CARROT, 1);
        return;
      }
      if (id === B.CARROT_2) {
        entities.spawnDrop(x + 0.5, y + 0.5, z + 0.5, I.CARROT, 2 + Math.floor(Math.random() * 3));
        return;
      }
      if (id === B.POTATO_0 || id === B.POTATO_1) {
        entities.spawnDrop(x + 0.5, y + 0.5, z + 0.5, I.POTATO, 1);
        return;
      }
      if (id === B.POTATO_2) {
        entities.spawnDrop(x + 0.5, y + 0.5, z + 0.5, I.POTATO, 2 + Math.floor(Math.random() * 3));
        return;
      }
      if (id === B.BEETROOT_0 || id === B.BEETROOT_1) {
        entities.spawnDrop(x + 0.5, y + 0.5, z + 0.5, I.BEETROOT_SEEDS, 1);
        return;
      }
      if (id === B.BEETROOT_2) {
        entities.spawnDrop(x + 0.5, y + 0.5, z + 0.5, I.BEETROOT, 1);
        entities.spawnDrop(x + 0.5, y + 0.5, z + 0.5, I.BEETROOT_SEEDS, 1 + Math.floor(Math.random() * 2));
        return;
      }
      const d = def(id);
      // ores give up a little experience when mined
      const oreXp = id === B.COAL_ORE ? [0, 2] : id === B.DIAMOND_ORE ? [3, 7]
        : id === B.AMETHYST_ORE || id === B.QUARTZ_ORE ? [2, 5] : null;
      if (oreXp) {
        const n = oreXp[0] + Math.floor(Math.random() * (oreXp[1] - oreXp[0] + 1));
        if (n > 0) this.deps.onXp?.(x + 0.5, y + 0.5, z + 0.5, n);
      }
      if (d.drop === null) return;
      const drop = d.drop ?? { id, min: 1, max: 1 };
      let count = drop.min + Math.floor(Math.random() * (drop.max - drop.min + 1));
      // Fortune multiplies gem drops (never a block dropping itself)
      const fortune = enchLevel(this.inventory.getSelected(), 'fortune');
      if (fortune > 0 && drop.id !== id && !def(drop.id).block) {
        count *= 1 + Math.max(0, Math.floor(Math.random() * (fortune + 2)) - 1);
      }
      if (count > 0) entities.spawnDrop(x + 0.5, y + 0.5, z + 0.5, drop.id, count);
    }
  }

  /** Wear down the held tool/bow by one use; it snaps at zero durability. */
  private damageHeldTool(miningOnly = false): void {
    if (this.mode !== 'survival') return;
    const slot = this.inventory.getSelected();
    if (!slot) return;
    const d = def(slot.id);
    if (!d.durability) return;
    if (miningOnly && !d.toolInfo) return; // bows don't wear from punching blocks
    if (Math.random() < this.unbreakingSkip(slot)) return;
    const prev = slot.dur ?? d.durability;
    slot.dur = prev - 1;
    if (slot.dur <= 0) {
      this.inventory.slots[this.inventory.selected] = null;
      this.deps.audio.play('snap');
      this.deps.toast(`Your ${d.label} broke!`);
    } else {
      // one-shot warning the moment durability dips under 10% — gives the player
      // time to craft a replacement before it snaps mid-task
      const warn = Math.max(1, Math.ceil(d.durability * 0.1));
      if (prev > warn && slot.dur <= warn) {
        this.deps.audio.play('lowdur');
        this.deps.toast(`${d.label} is almost broken!`);
      }
    }
    this.inventory.onChange();
  }

  /** Equip the held armor piece, swapping any currently-worn piece back to the slot. */
  private equipArmor(): void {
    const sel = this.inventory.selected;
    const held = this.inventory.slots[sel];
    const a = held ? def(held.id).armor : null;
    if (!held || !a) return;
    const prev = this.inventory.armor[a.slot];
    this.inventory.armor[a.slot] = { id: held.id, count: 1, dur: held.dur, ...(held.ench ? { ench: held.ench } : {}) };
    if (this.mode !== 'creative') this.inventory.slots[sel] = prev ?? null;
    this.placeCooldown = 0.35;
    this.deps.renderer.triggerSwing();
    this.deps.audio.play('equip');
    this.inventory.onChange();
  }

  /** Wear down each worn armor piece by one point; pieces snap at zero. */
  private damageArmor(): void {
    let changed = false;
    for (let i = 0; i < this.inventory.armor.length; i++) {
      const s = this.inventory.armor[i];
      if (!s || s.id === I.GLIDER) continue; // the glider wears from flight, not blows
      const max = def(s.id).durability ?? 0;
      if (!max) continue;
      // Unbreaking on armor: vanilla keeps 60% of hits wearing it, less the rest
      const ub = enchLevel(s, 'unbreaking');
      if (ub > 0 && Math.random() > 0.6 + 0.4 / (ub + 1)) continue;
      s.dur = (s.dur ?? max) - 1;
      if (s.dur <= 0) {
        this.deps.toast(`Your ${def(s.id).label} broke!`);
        this.inventory.armor[i] = null;
        this.deps.audio.play('snap');
      }
      changed = true;
    }
    if (changed) this.inventory.onChange();
  }

  /** Replace one held bucket with its filled/empty counterpart. */
  private swapHeldBucket(toId: number): void {
    if (this.mode === 'creative') return; // creative keeps an endless supply
    const sel = this.inventory.selected;
    const s = this.inventory.slots[sel];
    if (!s) return;
    if (s.count <= 1) {
      this.inventory.slots[sel] = { id: toId, count: 1 };
    } else {
      s.count--;
      const left = this.inventory.add(toId, 1);
      if (left > 0) this.deps.entities.spawnDrop(this.pos.x, this.pos.y + 1, this.pos.z, toId, left);
    }
    this.inventory.onChange();
  }

  /** Empty bucket: scoop the first full water source along the view ray. */
  private tryScoopWater(): boolean {
    const world = this.deps.world;
    const d = this.lookDir();
    const ex = this.pos.x, ey = this.pos.y + this.eyeHeight(), ez = this.pos.z;
    for (let t = 0; t <= 5; t += 0.1) {
      const bx = Math.floor(ex + d.x * t), by = Math.floor(ey + d.y * t), bz = Math.floor(ez + d.z * t);
      const id = world.getBlock(bx, by, bz);
      if (id === B.WATER) {
        if (world.waterLevel(bx, by, bz) !== 0) continue; // only full sources scoop
        world.setBlock(bx, by, bz, B.AIR);
        world.waterLevels.delete(`${bx},${by},${bz}`);
        this.swapHeldBucket(I.WATER_BUCKET);
        this.placeCooldown = 0.3;
        this.deps.renderer.triggerSwing();
        this.deps.audio.play('splash');
        return true;
      }
      if (id !== B.AIR) return false; // hit something solid first
    }
    return false;
  }

  /** Water bucket: pour a source against the targeted face. */
  private tryPlaceWater(): boolean {
    if (!this.target) return false;
    const world = this.deps.world;
    const t = this.target;
    const px = t.x + t.nx, py = t.y + t.ny, pz = t.z + t.nz;
    const dst = world.getBlock(px, py, pz);
    if (dst !== B.AIR && dst !== B.WATER) return false;
    world.waterLevels.delete(`${px},${py},${pz}`); // absent = a permanent source
    if (!world.setBlock(px, py, pz, B.WATER)) return false;
    world.scheduleWater(px, py, pz);
    this.swapHeldBucket(I.BUCKET);
    this.placeCooldown = 0.3;
    this.deps.renderer.triggerSwing();
    this.deps.audio.play('splash');
    return true;
  }

  /** Empty bucket: scoop a lava source block. */
  private tryScoopLava(): boolean {
    const world = this.deps.world;
    const d = this.lookDir();
    const ex = this.pos.x, ey = this.pos.y + this.eyeHeight(), ez = this.pos.z;
    for (let t = 0; t <= 5; t += 0.1) {
      const bx = Math.floor(ex + d.x * t), by = Math.floor(ey + d.y * t), bz = Math.floor(ez + d.z * t);
      const id = world.getBlock(bx, by, bz);
      if (id === B.LAVA) {
        if (world.lavaLevel(bx, by, bz) !== 0) continue; // only full sources scoop
        world.setBlock(bx, by, bz, B.AIR);
        world.lavaLevels.delete(`${bx},${by},${bz}`);
        this.swapHeldBucket(I.LAVA_BUCKET);
        this.deps.onAdvance?.('hot_stuff');
        this.placeCooldown = 0.3;
        this.deps.renderer.triggerSwing();
        this.deps.audio.play('splash');
        return true;
      }
      if (id !== B.AIR && id !== B.WATER) return false;
    }
    return false;
  }

  /** Lava bucket: pour a source against the targeted face. */
  private tryPlaceLava(): boolean {
    if (!this.target) return false;
    const world = this.deps.world;
    const t = this.target;
    const px = t.x + t.nx, py = t.y + t.ny, pz = t.z + t.nz;
    const dst = world.getBlock(px, py, pz);
    if (dst !== B.AIR && dst !== B.LAVA) return false;
    world.lavaLevels.delete(`${px},${py},${pz}`); // absent = a permanent source
    if (!world.setBlock(px, py, pz, B.LAVA)) return false;
    world.scheduleLava(px, py, pz);
    // setBlock already fired the water+lava reaction via onBlockChanged
    this.swapHeldBucket(I.BUCKET);
    this.placeCooldown = 0.3;
    this.deps.renderer.triggerSwing();
    this.deps.audio.play('splash');
    return true;
  }

  /** Glass bottle: fill from any water along the view ray (the water stays). */
  private tryFillBottle(): boolean {
    const world = this.deps.world;
    const d = this.lookDir();
    const ex = this.pos.x, ey = this.pos.y + this.eyeHeight(), ez = this.pos.z;
    for (let t = 0; t <= 5; t += 0.1) {
      const id = world.getBlock(Math.floor(ex + d.x * t), Math.floor(ey + d.y * t), Math.floor(ez + d.z * t));
      if (id === B.WATER) {
        this.swapHeldBucket(I.WATER_BOTTLE);
        if (this.mode === 'creative') this.inventory.add(I.WATER_BOTTLE, 1);
        this.placeCooldown = 0.3;
        this.deps.renderer.triggerSwing();
        this.deps.audio.play('bubble');
        return true;
      }
      if (id !== B.AIR) return false;
    }
    return false;
  }

  /**
   * Right-click on a workshop/decoration block. Returns true when the click was
   * used (so it isn't also a placement or a bite of the held food).
   */
  private useDecorBlock(x: number, y: number, z: number, id: number): boolean {
    const { world, audio, entities } = this.deps;
    const DECOR = id === B.FENCE_GATE || id === B.BARREL || id === B.CAKE || id === B.FLOWER_POT ||
      id === B.COMPOSTER || id === B.ANVIL || id === B.ENCHANTING_TABLE || id === B.CAMPFIRE;
    if (!DECOR) return false;
    if (this.placeCooldown > 0) return true;
    const key = `${x},${y},${z}`;
    const held = this.inventory.getSelected();
    const meta = world.bedFacings.get(key) ?? 0;
    const dirty = (): void => world.markDirty(Math.floor(x / 16), Math.floor(z / 16));
    switch (id) {
      case B.FENCE_GATE: {
        const st = world.doorStates.get(key) ?? { facing: 0 as const, open: false };
        st.open = !st.open;
        world.doorStates.set(key, st);
        this.placeCooldown = 0.3;
        this.deps.renderer.triggerSwing();
        audio.play(st.open ? 'doorOpen' : 'doorClose');
        dirty();
        return true;
      }
      case B.BARREL:
        this.placeCooldown = 0.3;
        this.deps.openContainer('chest', x, y, z);
        return true;
      case B.CAKE: {
        if (this.mode !== 'survival' || this.hunger >= 20) return false;
        this.hunger = Math.min(20, this.hunger + 2);
        this.saturation = Math.min(this.hunger, this.saturation + 0.4);
        audio.play('eat');
        entities.spawnBlockParticles(x, y, z, B.CAKE, 6);
        if (meta >= 6) { world.bedFacings.delete(key); world.setBlock(x, y, z, B.AIR); audio.play('burp'); }
        else { world.bedFacings.set(key, meta + 1); dirty(); }
        this.placeCooldown = 0.35;
        this.deps.onAdvance?.('cake');
        return true;
      }
      case B.FLOWER_POT: {
        if (meta && (!held || !POTTABLE.has(held.id))) {
          // take the plant back out
          if (this.mode === 'survival' && this.inventory.add(meta, 1) > 0) entities.spawnDrop(x + 0.5, y + 0.6, z + 0.5, meta, 1);
          world.bedFacings.set(key, 0);
        } else if (!meta && held && POTTABLE.has(held.id)) {
          world.bedFacings.set(key, held.id);
          if (this.mode === 'survival') this.inventory.consumeSelected();
          this.deps.onAdvance?.('flower_pot');
        } else {
          return false;
        }
        audio.dig('grass', 0.7);
        this.deps.renderer.triggerSwing();
        this.placeCooldown = 0.25;
        dirty();
        return true;
      }
      case B.COMPOSTER: {
        if (meta >= 8) {
          world.bedFacings.set(key, 0);
          entities.spawnDrop(x + 0.5, y + 1.05, z + 0.5, I.BONE_MEAL, 1);
          audio.play('pop');
        } else {
          const chance = held ? COMPOST_CHANCE.get(held.id) : undefined;
          if (chance === undefined) return false;
          if (this.mode === 'survival') this.inventory.consumeSelected();
          if (Math.random() < chance) {
            const next = meta + 1 >= 7 ? 8 : meta + 1; // the seventh layer ripens straight to bone meal
            world.bedFacings.set(key, next);
            if (next === 8) { audio.play('level', 0.5); this.deps.onAdvance?.('compost'); }
          }
          audio.dig('grass', 0.6);
          entities.spawnBlockParticles(x, y, z, B.LEAVES, 5);
        }
        this.deps.renderer.triggerSwing();
        this.placeCooldown = 0.2;
        dirty();
        return true;
      }
      case B.CAMPFIRE: {
        if (!held || !this.deps.cookOnCampfire?.(x, y, z, held.id)) return false;
        if (this.mode === 'survival') this.inventory.consumeSelected();
        this.deps.renderer.triggerSwing();
        audio.play('fuse', 0.5);
        this.placeCooldown = 0.25;
        return true;
      }
      case B.ANVIL:
        this.placeCooldown = 0.4;
        this.repairHeld(x, y, z);
        return true;
      case B.ENCHANTING_TABLE:
        this.placeCooldown = 0.5;
        this.enchantHeld(x, y, z);
        return true;
    }
    return false;
  }

  /** Anvil: mend the held tool/armor by a quarter with one unit of its material + a level. */
  private repairHeld(x: number, y: number, z: number): void {
    const { audio, entities, toast } = this.deps;
    const s = this.inventory.getSelected();
    const d = s ? def(s.id) : null;
    if (!s || !d?.durability) { toast('Hold a worn tool, weapon or armor piece to mend it on the anvil'); return; }
    const cur = s.dur ?? d.durability;
    if (cur >= d.durability) { toast(`Your ${d.label} is already in top shape`); return; }
    const mat = repairMaterial(s.id);
    if (!mat) { toast(`A ${d.label} can't be mended on an anvil`); return; }
    if (this.mode === 'survival' && this.inventory.count(mat) < 1) { toast(`Mending needs ${def(mat).label}`); audio.play('fail'); return; }
    if (!this.spendLevels(1)) { toast('Mending costs 1 experience level'); audio.play('fail'); return; }
    if (this.mode === 'survival') this.inventory.removeOne(mat);
    const next = Math.min(d.durability, cur + Math.ceil(d.durability * 0.25));
    if (next >= d.durability) delete s.dur; else s.dur = next;
    audio.dig('stone', 1, 1.3, B.IRON_BLOCK);
    entities.spawnCritParticles(x + 0.5, y + 1.1, z + 0.5);
    this.deps.renderer.triggerSwing();
    toast(`Mended ${d.label} (${next} / ${d.durability})`);
    this.deps.onAdvance?.('anvil');
    this.inventory.onChange();
  }

  /**
   * Enchanting table: turn levels + amethyst into enchantments on the held
   * item. Bookshelves around the table (two blocks out) raise the power ceiling;
   * the power used is capped by your level, and the cost is 1-3 levels and
   * 1-3 amethyst depending on how strong the roll is.
   */
  private enchantHeld(x: number, y: number, z: number): void {
    const { world, audio, entities, toast } = this.deps;
    const s = this.inventory.getSelected();
    const opts = s ? enchantsFor(s.id) : [];
    if (!s || opts.length === 0) { toast('Hold a tool, weapon, bow or armor piece to enchant it'); return; }
    if (s.ench) { toast('That item already carries an enchantment'); return; }
    let shelves = 0;
    for (let dy = 0; dy <= 1; dy++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== 2) continue;
          if (world.getBlock(x + dx, y + dy, z + dz) === B.BOOKSHELF) shelves++;
        }
      }
    }
    const ceiling = Math.min(30, 8 + Math.min(15, shelves) * 2);
    const power = this.mode === 'creative' ? ceiling : Math.min(ceiling, this.xpLevel);
    if (power < 1) { toast('Enchanting needs experience - mine ores, smelt and fight to earn levels'); audio.play('fail'); return; }
    const tier = power >= 20 ? 3 : power >= 10 ? 2 : 1;
    if (this.mode === 'survival' && this.inventory.count(I.AMETHYST) < tier) {
      toast(`Enchanting at power ${power} needs ${tier} amethyst`);
      audio.play('fail');
      return;
    }
    // roll: one primary enchantment scaled to the power, maybe a bonus or two
    const pool = [...opts];
    const ench: Record<string, number> = {};
    let chance = 1;
    while (pool.length && Math.random() < chance) {
      const e = pool.splice((Math.random() * pool.length) | 0, 1)[0];
      const lvl = Math.max(1, Math.min(e.max, Math.round((power / 30) * e.max + (Math.random() - 0.4))));
      ench[e.id] = lvl;
      chance = chance === 1 ? (power + 1) / 50 : chance / 2;
    }
    this.spendLevels(tier);
    if (this.mode === 'survival') for (let i = 0; i < tier; i++) this.inventory.removeOne(I.AMETHYST);
    s.ench = ench;
    audio.play('level');
    audio.dig('stone', 1, 1.2, B.AMETHYST_ORE);
    for (let i = 0; i < 3; i++) entities.spawnCritParticles(x + 0.5, y + 1.2 + i * 0.2, z + 0.5);
    this.deps.renderer.triggerSwing();
    toast(`Enchanted: ${Object.entries(ench).map(([k, v]) => enchantLabel(k, v)).join(', ')}`);
    this.deps.onAdvance?.('enchant');
    this.inventory.onChange();
  }

  /** Light a Nether portal: from the air block where ignition starts, flood the
   *  enclosed air pocket within a vertical obsidian frame (either the XY or ZY
   *  plane) and fill it with portal blocks. Returns false if no valid frame. */
  private tryIgnitePortal(sx: number, sy: number, sz: number): boolean {
    const world = this.deps.world;
    if (world.getBlock(sx, sy, sz) !== B.AIR) return false;
    // a portal lies in one vertical plane; try axis-along-X (constant z) then
    // axis-along-Z (constant x). The first plane that forms a closed obsidian
    // frame around the seed air pocket wins.
    for (const plane of ['x', 'z'] as const) {
      const cells = this.collectPortalInterior(sx, sy, sz, plane);
      if (cells) {
        for (const [cx, cy, cz] of cells) world.setBlock(cx, cy, cz, B.PORTAL);
        return true;
      }
    }
    return false;
  }

  /** Flood-fill the air pocket containing (sx,sy,sz) restricted to one vertical
   *  plane. Valid only if the pocket is small and every planar edge neighbour is
   *  obsidian (a sealed frame). Returns the interior cells, or null. */
  private collectPortalInterior(
    sx: number, sy: number, sz: number, plane: 'x' | 'z',
  ): [number, number, number][] | null {
    const world = this.deps.world;
    const seen = new Set<string>();
    const cells: [number, number, number][] = [];
    const stack: [number, number, number][] = [[sx, sy, sz]];
    // planar neighbour offsets: vertical + one horizontal axis
    const offs: [number, number, number][] = plane === 'x'
      ? [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]]
      : [[0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]];
    while (stack.length) {
      const [x, y, z] = stack.pop()!;
      const key = `${x},${y},${z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (cells.length > 30) return null; // bigger than any sane frame -> not enclosed
      cells.push([x, y, z]);
      for (const [dx, dy, dz] of offs) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        const nid = world.getBlock(nx, ny, nz);
        if (nid === B.AIR) {
          stack.push([nx, ny, nz]);
        } else if (nid !== B.OBSIDIAN) {
          return null; // leaked into a non-obsidian boundary -> open frame
        }
      }
    }
    return cells.length > 0 ? cells : null;
  }

  // --- right click: interact / eat / place ------------------------------------

  private updateRightClick(dt: number): void {
    const { input, world, audio } = this.deps;
    if (!input.rightDown && !input.takeRightClick()) {
      this.eatT = 0;
      this.eating = false;
      return;
    }

    const held = this.inventory.getSelected();
    const heldDef = held ? def(held.id) : null;

    // shield / spyglass are "hold to use" items driven from update()
    if (held?.id === I.SHIELD || held?.id === I.SPYGLASS) return;

    // firework rocket: a burst of thrust while gliding
    if (held?.id === I.FIREWORK_ROCKET && this.placeCooldown <= 0) {
      this.placeCooldown = 0.5;
      if (this.gliding) {
        this.rocketT = 1.4;
        this.deps.renderer.triggerSwing();
        audio.play('fuse');
        audio.play('whoosh');
        if (this.mode === 'survival') this.inventory.consumeSelected();
      } else {
        this.deps.toast('Fire a rocket while gliding for a boost');
      }
      return;
    }

    // drawing a bow takes priority while held
    if (heldDef?.bow) {
      const hasAmmo = this.mode === 'creative' || this.inventory.count(I.ARROW) > 0;
      if (hasAmmo) this.bowCharge += dt;
      return;
    }

    // fishing rod: right-click casts (or reels if already out)
    if (heldDef?.id === I.FISHING_ROD) {
      if (this.bobber && !this.bobber.dead) {
        // reel in
        const caught = this.deps.entities.reelBobber(this.bobber);
        this.bobber = null;
        this.placeCooldown = 0.3;
        this.deps.renderer.triggerSwing();
        if (caught) { this.damageHeldTool(); this.deps.onFish(caught); }
      } else if (this.placeCooldown <= 0) {
        // cast toward where the player is looking
        const d = this.lookDir();
        const ey = this.pos.y + this.eyeHeight();
        this.bobber = this.deps.entities.castBobber(
          this.pos.x + d.x * 0.4, ey + d.y * 0.4 - 0.05, this.pos.z + d.z * 0.4,
          d.x, d.y, d.z,
        );
        this.placeCooldown = 0.3;
        this.deps.renderer.triggerSwing();
        audio.play('bow');
      }
      return;
    }

    // mob catcher: point-blank recall of your own pet, otherwise throw the orb
    // at whatever you are aiming at (see EntityManager.throwCatcher)
    if (heldDef?.id === I.MOB_CATCHER && !this.sneaking && this.placeCooldown <= 0) {
      const ent = this.deps.entities;
      const d = this.lookDir();
      const hit = ent.raycastMobs(
        this.pos.x, this.pos.y + this.eyeHeight(), this.pos.z, d.x, d.y, d.z, 3.5,
      );
      // recalling a pet you are looking straight at doesn't need a throw
      if (hit && hit.dist < (this.target?.dist ?? 4.5) && ent.isPet(hit.entity)) {
        const kind = ent.recallPet(hit.entity);
        if (kind) {
          this.giveFilledCatcher(kind);
          this.placeCooldown = 0.4;
          this.deps.renderer.triggerSwing();
          this.deps.toast(`Recalled ${mobLabel(kind)}`);
          this.inventory.onChange();
          return;
        }
      }
      // throw: the orb arcs out and captures the first hostile it brushes past;
      // a miss lands on the ground as a pickup, so nothing is wasted
      const ey = this.pos.y + this.eyeHeight();
      ent.throwCatcher(this.pos.x + d.x * 0.4, ey + d.y * 0.4 - 0.1, this.pos.z + d.z * 0.4, d.x, d.y, d.z);
      this.placeCooldown = 0.35;
      this.deps.renderer.triggerOrbThrow();
      if (this.mode === 'survival') this.inventory.consumeSelected();
      this.inventory.onChange();
      return;
    }

    // bucket on a cow -> milk (shearing lives in EntityManager.interactMob)
    if (held?.id === I.BUCKET && this.placeCooldown <= 0) {
      const d = this.lookDir();
      const hit = this.deps.entities.raycastMobs(
        this.pos.x, this.pos.y + this.eyeHeight(), this.pos.z, d.x, d.y, d.z, 3.5,
      );
      if (hit && hit.dist < (this.target?.dist ?? 4.5) && !hit.entity.baby) {
        if (hit.entity.kind === 'cow') {
          this.swapHeldBucket(I.MILK_BUCKET);
          this.deps.onAdvance?.('milk');
          this.placeCooldown = 0.4;
          this.deps.renderer.triggerSwing();
          audio.play('splash');
          return;
        }
      }
    }

    // mob interaction: tame wolves / open villager trades (before generic use)
    if (!this.sneaking && this.placeCooldown <= 0) {
      const hit = this.deps.entities.raycastMobs(
        this.pos.x, this.pos.y + this.eyeHeight(), this.pos.z,
        this.lookDir().x, this.lookDir().y, this.lookDir().z, 3.5,
      );
      if (hit && hit.dist < (this.target?.dist ?? 4.5)) {
        const woolly = hit.entity.kind === 'sheep' && !hit.entity.sheared;
        const res = this.deps.entities.interactMob(hit.entity, held?.id ?? 0);
        // shears clipped the fleece: wear the shears and count the milestone
        if (woolly && hit.entity.sheared) {
          this.placeCooldown = 0.4;
          this.deps.renderer.triggerSwing();
          this.damageHeldTool();
          this.deps.onAdvance?.('shear');
          return;
        }
        if (res === 'tamed') {
          this.placeCooldown = 0.4;
          if (this.mode === 'survival') this.inventory.consumeSelected(); // consume the bone
          audio.play('level');
          this.deps.onTameWolf();
          return;
        }
        if (res === 'sit') { this.placeCooldown = 0.3; audio.play('click'); return; }
        if (res === 'love') {
          this.placeCooldown = 0.4;
          if (this.mode === 'survival') this.inventory.consumeSelected(); // eat the food
          audio.play('eat');
          return;
        }
        if (res === 'saddle' || res === 'armor') {
          this.placeCooldown = 0.4;
          if (this.mode === 'survival') this.inventory.consumeSelected();
          audio.play('level');
          return;
        }
        if (res === 'mount') {
          this.placeCooldown = 0.4;
          this.mount(hit.entity);
          return;
        }
        if (res === 'trade') {
          this.placeCooldown = 0.4;
          this.deps.openTrade(hit.entity);
          return;
        }
      }
    }

    // workshop + decoration blocks (campfire, composter, anvil, enchanting table,
    // cake ...) take the click before held armor is worn or food is eaten
    if (this.target && !this.sneaking && this.useDecorBlock(this.target.x, this.target.y, this.target.z, this.target.id)) {
      this.eatT = 0;
      this.eating = false;
      return;
    }

    // equip wearable armor onto the body (right-click swaps with the worn piece)
    if (heldDef?.armor && this.placeCooldown <= 0) {
      this.equipArmor();
      return;
    }

    // eating / drinking (golden apples and milk go down even on a full stomach)
    if (this.mode === 'survival' && heldDef && (heldDef.food || heldDef.alwaysEdible) &&
      (this.hunger < 20 || heldDef.alwaysEdible)) {
      this.eatT += dt;
      this.eating = true;
      this.chewT -= dt;
      if (this.chewT <= 0) { this.chewT = 0.25; audio.play(isDrink(heldDef.id) ? 'drink' : 'eat'); }
      if (this.eatT >= 1.6) {
        const eaten = heldDef.id;
        if (heldDef.food) {
          this.hunger = Math.min(20, this.hunger + heldDef.food);
          this.saturation = Math.min(this.hunger, this.saturation + foodSaturation(eaten));
        }
        if (eaten === I.MILK_BUCKET) {
          this.inventory.slots[this.inventory.selected] = { id: I.BUCKET, count: 1 };
          this.inventory.onChange();
        } else {
          this.inventory.consumeSelected();
        }
        // containers come back: bowls from stews, bottles from potions + water
        const empty = eaten === I.BEETROOT_SOUP || eaten === I.VEGETABLE_STEW || eaten === I.MUSHROOM_STEW ? I.BOWL
          : isPotion(eaten) || eaten === I.WATER_BOTTLE ? I.GLASS_BOTTLE : 0;
        if (empty) {
          const left = this.inventory.add(empty, 1);
          if (left > 0) this.deps.entities.spawnDrop(this.pos.x, this.pos.y + 1, this.pos.z, empty, left);
        }
        this.applyFoodEffects(eaten);
        if (eaten === I.GOLDEN_APPLE || eaten === I.ENCHANTED_GOLDEN_APPLE) this.deps.onAdvance?.('golden_apple');
        this.eatT = 0;
        if (!isDrink(eaten)) audio.play('burp');
      }
      return;
    }
    this.eatT = 0;
    this.eating = false;

    if (this.placeCooldown > 0) return;

    // bucket: scoop a water/lava source (empty) or pour a source (full)
    if (held?.id === I.BUCKET && this.tryScoopWater()) return;
    if (held?.id === I.BUCKET && this.tryScoopLava()) return;
    if (held?.id === I.WATER_BUCKET && this.tryPlaceWater()) return;
    if (held?.id === I.LAVA_BUCKET && this.tryPlaceLava()) return;
    if (held?.id === I.GLASS_BOTTLE && this.tryFillBottle()) return;

    // filled mob catcher: release the captured pet in front of the player. Step
    // the spot back toward the player if the far one is inside terrain, so a pet
    // never pops out stuck in a wall.
    if (held?.id === I.MOB_CATCHER_FILLED && held.mob) {
      const kind = held.mob;
      const d = this.lookDir();
      let fx = this.pos.x, fz = this.pos.z;
      for (const reach of [2, 1.4, 0.8, 0]) {
        const tx = this.pos.x + d.x * reach, tz = this.pos.z + d.z * reach;
        const clear = !isSolid(world.getBlock(Math.floor(tx), Math.floor(this.pos.y), Math.floor(tz)))
          && !isSolid(world.getBlock(Math.floor(tx), Math.floor(this.pos.y) + 1, Math.floor(tz)));
        if (clear) { fx = tx; fz = tz; break; }
      }
      this.deps.entities.releaseMob(kind as never, fx, this.pos.y, fz, this.yaw);
      this.placeCooldown = 0.4;
      this.deps.renderer.triggerSwing();
      if (this.mode === 'survival') this.inventory.consumeSelected();
      this.deps.toast(`Released ${mobLabel(kind)} — it will fight for you`);
      this.inventory.onChange();
      return;
    }

    // interactive blocks
    if (this.target && !this.sneaking) {
      const t = this.target;
      if (t.id === B.TABLE) {
        this.placeCooldown = 0.3;
        this.deps.openContainer('table', t.x, t.y, t.z);
        return;
      }
      if (t.id === B.FURNACE || t.id === B.FURNACE_LIT) {
        this.placeCooldown = 0.3;
        this.deps.openContainer('furnace', t.x, t.y, t.z);
        return;
      }
      if (t.id === B.CHEST || t.id === B.CHEST_LOOT) {
        this.placeCooldown = 0.3;
        this.deps.openContainer('chest', t.x, t.y, t.z);
        return;
      }
      if (t.id === B.BED || t.id === B.BED_HEAD) {
        this.placeCooldown = 0.4;
        this.deps.useBed(t.x, t.y, t.z);
        return;
      }
      if (t.id === B.LEVER) {
        const key = `${t.x},${t.y},${t.z}`;
        const state = world.redstoneStates.get(key) ?? { active: false };
        state.active = !state.active;
        world.redstoneStates.set(key, state);
        this.placeCooldown = 0.25;
        this.deps.renderer.triggerSwing();
        audio.play('click');
        this.deps.onRedstoneUpdate(t.x, t.y, t.z);
        world.markDirty(Math.floor(t.x / 16), Math.floor(t.z / 16));
        return;
      }
      if (t.id === B.WOODEN_BUTTON || t.id === B.STONE_BUTTON) {
        const key = `${t.x},${t.y},${t.z}`;
        const state = world.redstoneStates.get(key) ?? { active: false };
        if (!state.active) {
          state.active = true;
          state.ticksLeft = 20;
          world.redstoneStates.set(key, state);
          this.placeCooldown = 0.25;
          this.deps.renderer.triggerSwing();
          audio.play('click');
          this.deps.onRedstoneUpdate(t.x, t.y, t.z);
          world.markDirty(Math.floor(t.x / 16), Math.floor(t.z / 16));
        }
        return;
      }
      if (t.id === B.TNT) {
        this.placeCooldown = 0.4;
        this.deps.igniteTnt(t.x, t.y, t.z);
        return;
      }
      // doors + trapdoors toggle on use
      if (t.id === B.DOOR_LOWER || t.id === B.DOOR_UPPER || t.id === B.TRAPDOOR) {
        const wasOpen = t.id === B.TRAPDOOR
          ? world.isTrapdoorOpen(t.x, t.y, t.z)
          : !!world.doorStateAt(t.x, t.y, t.z)?.open;
        if (world.toggleDoor(t.x, t.y, t.z) || t.id === B.TRAPDOOR) {
          this.placeCooldown = 0.3;
          this.deps.renderer.triggerSwing();
          audio.play(wasOpen ? 'doorClose' : 'doorOpen');
          this.deps.useDoor(t.x, t.y, t.z);
          return;
        }
      }
    }

    // throwables: warp pearls teleport you where they land, snowballs knock mobs back
    if (held && (held.id === I.WARP_PEARL || held.id === I.SNOWBALL) && this.deps.throwItem) {
      const d = this.lookDir();
      const ey = this.pos.y + this.eyeHeight();
      this.deps.throwItem(held.id, this.pos.x + d.x * 0.4, ey + d.y * 0.4 - 0.1, this.pos.z + d.z * 0.4, d.x, d.y, d.z);
      this.placeCooldown = held.id === I.WARP_PEARL ? 1 : 0.25;
      this.deps.renderer.triggerSwing();
      audio.play('whoosh');
      if (this.mode === 'survival') this.inventory.consumeSelected();
      return;
    }

    // flint & steel: ignite an obsidian frame into a Nether portal
    if (this.target && held?.id === I.FLINT_AND_STEEL) {
      this.placeCooldown = 0.3;
      this.deps.renderer.triggerSwing();
      const t = this.target;
      if (this.tryIgnitePortal(t.x + t.nx, t.y + t.ny, t.z + t.nz)) {
        audio.play('fuse');
        this.damageHeldTool();
        return;
      }
      // otherwise strike a flame: TNT is lit directly, anything else catches
      // fire on the clicked face
      if (t.id === B.TNT) {
        this.deps.igniteTnt(t.x, t.y, t.z);
        this.damageHeldTool();
        return;
      }
      if (this.deps.ignite?.(t.x + t.nx, t.y + t.ny, t.z + t.nz)) {
        audio.play('ignite');
        this.damageHeldTool();
      } else {
        audio.play('fail');
      }
      return;
    }

    // hoe: till grass/dirt into farmland
    if (this.target && heldDef?.toolInfo?.kind === 'hoe' &&
      (this.target.id === B.GRASS || this.target.id === B.DIRT) &&
      world.getBlock(this.target.x, this.target.y + 1, this.target.z) === B.AIR) {
      world.setBlock(this.target.x, this.target.y, this.target.z, B.FARMLAND);
      this.placeCooldown = 0.25;
      this.deps.renderer.triggerSwing();
      audio.dig('grass', 0.9);
      this.damageHeldTool();
      return;
    }

    // bone meal: instantly grow the targeted crop, sapling, or grass tuft
    if (this.target && held?.id === I.BONE_MEAL) {
      if (this.deps.onBoneMeal(this.target.x, this.target.y, this.target.z)) {
        this.placeCooldown = 0.2;
        this.deps.renderer.triggerSwing();
        audio.dig('grass', 0.5);
        // green sparkle from the foliage tile
        this.deps.entities.spawnBlockParticles(this.target.x, this.target.y, this.target.z, B.LEAVES, 8);
        if (this.mode === 'survival') this.inventory.consumeSelected();
      }
      return;
    }

    // crops: plant wheat, carrots, potatoes, and beetroots on farmland
    if (this.target && held && this.plantedCropFor(held.id) !== 0) {
      const crop = this.plantedCropFor(held.id);
      if (this.target.id === B.FARMLAND && this.target.ny === 1 &&
        world.getBlock(this.target.x, this.target.y + 1, this.target.z) === B.AIR) {
        world.setBlock(this.target.x, this.target.y + 1, this.target.z, crop);
        this.placeCooldown = 0.22;
        this.deps.renderer.triggerSwing();
        audio.dig('grass', 0.6);
        if (this.mode === 'survival') this.inventory.consumeSelected();
        this.deps.onPlantSeed();
      }
      return;
    }

    // placement
    if (!this.target || !held) return;

    // door item: place a 2-tall door; broad face points back toward the player
    if (held.id === I.WOOD_DOOR) {
      const px = this.target.x + this.target.nx;
      const py = this.target.y + this.target.ny;
      const pz = this.target.z + this.target.nz;
      if (world.getBlock(px, py, pz) !== B.AIR) return;
      if (world.getBlock(px, py + 1, pz) !== B.AIR) return; // need headroom
      if (!isSolid(world.getBlock(px, py - 1, pz))) return; // needs a floor
      // facing: 0=-z,1=-x,2=+z,3=+x — derived from the closest cardinal yaw
      const yawDeg = ((this.yaw * 180 / Math.PI) % 360 + 360) % 360;
      const facing = (Math.round(yawDeg / 90) % 4) as DoorFacing;
      const rightX = Math.cos(this.yaw);
      const rightZ = -Math.sin(this.yaw);
      const offX = this.pos.x - (px + 0.5);
      const offZ = this.pos.z - (pz + 0.5);
      let hingeRight = offX * rightX + offZ * rightZ > 0;
      // mirror an adjacent same-facing door so the two form a double door
      const along = facing % 2 === 0 ? [[1, 0], [-1, 0]] : [[0, 1], [0, -1]];
      for (const [dx, dz] of along) {
        if (world.getBlock(px + dx, py, pz + dz) !== B.DOOR_LOWER) continue;
        const ns = world.doorStates.get(`${px + dx},${py},${pz + dz}`);
        if (ns && ns.facing === facing) { hingeRight = !ns.hingeRight; break; }
      }
      world.setBlock(px, py, pz, B.DOOR_LOWER);
      world.setBlock(px, py + 1, pz, B.DOOR_UPPER);
      world.doorStates.set(`${px},${py},${pz}`, { facing, open: false, hingeRight, swing: 0 });
      // reflect an already-powered plate/lever beside the freshly placed door
      this.deps.onRedstoneUpdate(px, py, pz);
      this.placeCooldown = 0.3;
      this.deps.renderer.triggerSwing();
      audio.dig('wood', 0.8);
      this.deps.useDoor(px, py, pz);
      if (this.mode === 'survival') this.inventory.consumeSelected();
      return;
    }

    // bed item: place a 2-block bed — foot at the clicked cell, head extends in
    // the direction the player is facing
    if (held.id === B.BED) {
      const fx = this.target.x + this.target.nx;
      const fy = this.target.y + this.target.ny;
      const fz = this.target.z + this.target.nz;
      const yawDeg = ((this.yaw * 180 / Math.PI) % 360 + 360) % 360;
      const facing = Math.round(yawDeg / 90) % 4; // 0=-z,1=-x,2=+z,3=+x
      const dvx = facing === 1 ? -1 : facing === 3 ? 1 : 0;
      const dvz = facing === 0 ? -1 : facing === 2 ? 1 : 0;
      const hx = fx + dvx, hz = fz + dvz;
      const freeCell = (bx: number, by: number, bz: number): boolean => {
        const e = world.getBlock(bx, by, bz);
        return (e === B.AIR || e === B.WATER) && isSolid(world.getBlock(bx, by - 1, bz));
      };
      if (!freeCell(fx, fy, fz) || !freeCell(hx, fy, hz)) return;
      if (boxIntersectsBlock(this.pos, BOX, fx, fy, fz) || boxIntersectsBlock(this.pos, BOX, hx, fy, hz)) return;
      world.setBlock(fx, fy, fz, B.BED);
      world.setBlock(hx, fy, hz, B.BED_HEAD);
      world.bedFacings.set(`${fx},${fy},${fz}`, facing);
      world.bedFacings.set(`${hx},${fy},${hz}`, facing);
      this.placeCooldown = 0.3;
      this.deps.renderer.triggerSwing();
      audio.dig('wood', 0.8);
      if (this.mode === 'survival') this.inventory.consumeSelected();
      return;
    }

    if (!heldDef?.block) return;
    // a slab laid onto the open half of the same slab fills out the whole block
    if (SLAB_IDS.has(held.id) && this.target.id === held.id) {
      const tm = world.bedFacings.get(`${this.target.x},${this.target.y},${this.target.z}`) ?? 0;
      if ((this.target.ny === 1 && tm !== 1) || (this.target.ny === -1 && tm === 1)) {
        this.mergeSlab(this.target.x, this.target.y, this.target.z, held.id);
        return;
      }
    }
    const px = this.target.x + this.target.nx;
    const py = this.target.y + this.target.ny;
    const pz = this.target.z + this.target.nz;
    const existing = world.getBlock(px, py, pz);
    if (SLAB_IDS.has(held.id) && existing === held.id) { this.mergeSlab(px, py, pz, held.id); return; }
    if (existing !== B.AIR && existing !== B.WATER) return;
    // orientation for shaped blocks: which way the player faces, and whether the
    // click landed on the upper half of a side face (or a block's underside)
    const yawDeg = ((this.yaw * 180 / Math.PI) % 360 + 360) % 360;
    const facing = Math.round(yawDeg / 90) % 4; // 0=-z, 1=-x, 2=+z, 3=+x
    const hitY = this.pos.y + this.eyeHeight() + this.lookDir().y * this.target.dist;
    const upper = this.target.ny === -1 || (this.target.ny === 0 && hitY - this.target.y > 0.5);
    let meta = -1; // -1: no meta entry
    if (SLAB_IDS.has(held.id)) meta = upper ? 1 : 0;
    else if (STAIR_IDS.has(held.id)) meta = facing + (upper ? 4 : 0);
    else if (held.id === B.GLASS_PANE) meta = facing % 2;
    else if (held.id === B.ANVIL || held.id === B.CAMPFIRE) meta = facing & 1;
    else if (held.id === B.JACK_O_LANTERN) meta = [4, 0, 5, 1][facing];
    else if (held.id === B.LANTERN) {
      // hangs from a ceiling (clicked underside), otherwise stands on the floor
      const floor = isSolid(world.getBlock(px, py - 1, pz)), ceil = isSolid(world.getBlock(px, py + 1, pz));
      if (this.target.ny === -1 ? !ceil : !floor && !ceil) return;
      meta = this.target.ny === -1 || !floor ? 1 : 0;
    }

    // torch: attach to a floor (clicked top face) or to a block wall (side face)
    if (held.id === B.TORCH) {
      const { nx, ny, nz } = this.target;
      if (ny === 1 && isSolid(world.getBlock(px, py - 1, pz))) {
        world.torchFacings.delete(`${px},${py},${pz}`); // floor torch
      } else if ((nx !== 0 || nz !== 0) && isSolid(world.getBlock(this.target.x, this.target.y, this.target.z))) {
        const facing = nx === 1 ? 0 : nx === -1 ? 1 : nz === 1 ? 2 : 3; // wall torch
        world.torchFacings.set(`${px},${py},${pz}`, facing);
      } else {
        return; // no valid surface (e.g. a ceiling)
      }
      if (world.setBlock(px, py, pz, B.TORCH)) {
        this.placeCooldown = 0.22;
        this.deps.renderer.triggerSwing();
        audio.dig('wood', 0.7);
        if (this.mode === 'survival') this.inventory.consumeSelected();
        else this.inventory.onChange();
      } else {
        world.torchFacings.delete(`${px},${py},${pz}`);
      }
      return;
    }

    let placeId = held.id;
    if (held.id === I.REDSTONE) placeId = B.REDSTONE_WIRE;

    // plants/torches need a floor (cane and cactus may stack on themselves)
    if (FLOOR_BLOCKS.has(placeId)) {
      const below = world.getBlock(px, py - 1, pz);
      const supported = isSolid(below) || (SELF_STACKING.has(placeId) && below === placeId);
      if (!supported) return;
    }
    // ladders must attach to a solid block on the targeted face
    if (placeId === B.LADDER) {
      const ax = this.target.x, ay = this.target.y, az = this.target.z;
      if (!isSolid(world.getBlock(ax, ay, az))) return;
    }
    // trapdoors need solid ground or a solid neighbor to hinge on
    if (placeId === B.TRAPDOOR) {
      if (!isSolid(world.getBlock(px, py - 1, pz)) &&
        !isSolid(world.getBlock(px - 1, py, pz)) && !isSolid(world.getBlock(px + 1, py, pz)) &&
        !isSolid(world.getBlock(px, py, pz - 1)) && !isSolid(world.getBlock(px, py, pz + 1))) return;
      world.doorStates.set(`${px},${py},${pz}`, { facing: 0, open: false });
    }
    // never place inside the player's own hitbox (solid blocks only)
    if (isSolid(placeId) && boxIntersectsBlock(this.pos, BOX, px, py, pz)) return;
    if (isSolid(placeId) && this.deps.entities.anyMobIntersecting(px, py, pz)) return;

    const pkey = `${px},${py},${pz}`;
    if (META_BLOCKS.has(placeId)) { if (meta >= 0) world.bedFacings.set(pkey, meta); else world.bedFacings.delete(pkey); }
    if (world.setBlock(px, py, pz, placeId)) {
      if (placeId === B.FENCE_GATE) world.doorStates.set(pkey, { facing: facing as DoorFacing, open: false });
      if (placeId === B.LEVER || placeId === B.WOODEN_BUTTON || placeId === B.STONE_BUTTON || placeId === B.PRESSURE_PLATE) {
        const facing = this.target.ny === -1 ? 0 : this.target.ny === 1 ? 1 : this.target.nz === -1 ? 2 : this.target.nz === 1 ? 3 : this.target.nx === -1 ? 4 : 5;
        world.redstoneStates.set(`${px},${py},${pz}`, { active: false, facing });
        this.deps.onRedstoneUpdate(px, py, pz);
      } else if (placeId === B.PISTON || placeId === B.STICKY_PISTON) {
        const d = this.lookDir();
        let facing = 2;
        if (Math.abs(d.y) > 0.7) {
          facing = d.y > 0 ? 1 : 0;
        } else {
          if (Math.abs(d.x) > Math.abs(d.z)) {
            facing = d.x > 0 ? 5 : 4;
          } else {
            facing = d.z > 0 ? 3 : 2;
          }
        }
        world.pistonFacings.set(`${px},${py},${pz}`, facing);
        this.deps.onRedstoneUpdate(px, py, pz);
      } else if (placeId === B.REDSTONE_WIRE || placeId === B.REDSTONE_LAMP) {
        this.deps.onRedstoneUpdate(px, py, pz);
      }
      this.placeCooldown = 0.22;
      this.deps.renderer.triggerSwing();
      audio.dig(heldDef.sound, 0.8, 1, placeId);
      if (this.mode === 'survival') this.inventory.consumeSelected();
      else this.inventory.onChange();
    }
  }

  /** Loose an arrow based on how long the bow was drawn. */
  private fireBow(): void {
    const charge = Math.min(1, this.bowCharge / 0.9);
    if (charge < 0.15) return;
    if (this.mode === 'survival' && !this.inventory.removeOne(I.ARROW)) return;
    const d = this.lookDir();
    const ey = this.pos.y + this.eyeHeight();
    const power = enchLevel(this.inventory.getSelected(), 'power');
    this.deps.entities.shootArrow(
      'player',
      this.pos.x + d.x * 0.4, ey + d.y * 0.4 - 0.05, this.pos.z + d.z * 0.4,
      d.x, d.y, d.z,
      14 + 36 * charge,
      Math.ceil((2 + 7 * charge) * (power > 0 ? 1 + 0.25 * (power + 1) : 1)),
    );
    this.deps.renderer.triggerSwing();
    this.damageHeldTool();
  }

  /** Two halves of the same slab make the full block. */
  private mergeSlab(x: number, y: number, z: number, slab: number): void {
    const world = this.deps.world;
    const full = slabFullBlock(slab);
    if (isSolid(full) && boxIntersectsBlock(this.pos, BOX, x, y, z)) return;
    world.bedFacings.delete(`${x},${y},${z}`);
    if (!world.setBlock(x, y, z, full)) return;
    this.placeCooldown = 0.22;
    this.deps.renderer.triggerSwing();
    this.deps.audio.dig(def(slab).sound, 0.8, 1, full);
    if (this.mode === 'survival') this.inventory.consumeSelected();
    else this.inventory.onChange();
  }

  private plantedCropFor(id: number): number {
    if (id === I.PUMPKIN_SEEDS) return B.PUMPKIN_STEM;
    if (id === I.MELON_SEEDS) return B.MELON_STEM;
    if (id === I.SEEDS) return B.WHEAT_0;
    if (id === I.CARROT) return B.CARROT_0;
    if (id === I.POTATO) return B.POTATO_0;
    if (id === I.BEETROOT_SEEDS) return B.BEETROOT_0;
    return 0;
  }

  /** Left mouse press: try attacking an entity first; swing regardless.
   *  Vanilla 1.9 combat: a swing's strength recharges over the held item's
   *  attack cooldown, crits need a charged swing, a charged sword sweeps
   *  nearby mobs, and a sprinting hit knocks harder. */
  onLeftClick(): void {
    if (this.deps.isUIOpen() || this.dead || !this.deps.input.active) return;
    this.deps.renderer.triggerSwing();
    const charge = this.attackCharge();
    this.attackTimer = 0;
    const d = this.lookDir();
    const ey = this.pos.y + this.eyeHeight();
    const blockDist = this.target?.dist ?? Infinity;
    const ent = this.deps.entities;
    const hit = ent.raycastMobs(this.pos.x, ey, this.pos.z, d.x, d.y, d.z, 3.5);
    if (hit && hit.entity !== this.riding && hit.dist < blockDist) {
      const target = hit.entity;
      const heldId = this.heldId();
      // Sharpness (+0.5 per level +0.5) and Strength (+3 per level) add to the base hit
      const sharp = enchLevel(this.inventory.getSelected(), 'sharpness');
      const might = this.effects.get('strength');
      let dmg = (attackDamage(heldId) + (sharp > 0 ? 0.5 * sharp + 0.5 : 0) + (might ? 3 * (might.amp + 1) : 0)) * attackStrength(charge);
      // critical hit: a charged swing while falling (mid-air, descending) deals +50%
      const crit = charge > 0.9 && !this.onGround && this.vel.y < -0.15 && !this.flying &&
        !this.onLadder && !this.swimming;
      if (crit) dmg *= 1.5;
      dmg = Math.max(1, Math.round(dmg));
      // hurt immunity: a repeat hit inside the window only deals what it exceeds
      const last = this.lastHits.get(target);
      if (last && this.clock - last.t < MOB_IFRAMES) {
        if (dmg <= last.dmg) { this.deps.audio.play('whoosh'); return; }
        const extra = dmg - last.dmg;
        last.dmg = dmg;
        dmg = extra;
      } else {
        this.lastHits.set(target, { t: this.clock, dmg });
      }
      if (crit) {
        ent.spawnCritParticles(target.pos.x, target.pos.y + target.box.h * 0.6, target.pos.z);
        this.deps.onAdvance?.('critical');
      }
      ent.hurt(target, dmg, d.x, d.z, this, crit);
      // sprint-hit: extra knockback, and the sprint ends (vanilla)
      const kb = Math.hypot(d.x, d.z) || 1;
      const knock = enchLevel(this.inventory.getSelected(), 'knockback');
      if (knock > 0 && charge > 0.5) {
        target.vel.x += (d.x / kb) * 4 * knock;
        target.vel.z += (d.z / kb) * 4 * knock;
      }
      if (this.sprinting && charge > 0.9) {
        target.vel.x += (d.x / kb) * 5;
        target.vel.z += (d.z / kb) * 5;
        this.sprinting = false;
      } else if (charge > 0.9 && !crit && this.onGround && heldId !== 0 && hasDef(heldId) && def(heldId).toolInfo?.kind === 'sword') {
        this.sweep(target, d.x / kb, d.z / kb);
      }
      this.addExhaustion(0.1);
      // weapons wear one point per hit; tools swung as weapons wear two
      const kind = heldId && hasDef(heldId) ? def(heldId).toolInfo?.kind : undefined;
      this.damageHeldTool();
      if (kind && kind !== 'sword' && this.heldId() === heldId) this.damageHeldTool();
    } else if (!this.target && (!hit || hit.entity === this.riding)) {
      // swung at empty air (nothing to break, nothing to hit) — a soft swish
      this.deps.audio.play('whoosh');
    }
  }

  /** Sword sweep: brush the mobs crowding the one you struck. Pets, tamed
   *  animals and villagers are spared. */
  private sweep(primary: Entity, dx: number, dz: number): void {
    const ent = this.deps.entities;
    let swept = false;
    for (const m of ent.entities) {
      if (m === primary || m.dead || !ent.isMob(m) || m.tamed || m.kind === 'villager' || m === this.riding) continue;
      const ox = m.pos.x - primary.pos.x, oz = m.pos.z - primary.pos.z;
      if (Math.hypot(ox, oz) > 1.6 || Math.abs(m.pos.y - primary.pos.y) > 1) continue;
      if (Math.hypot(m.pos.x - this.pos.x, m.pos.z - this.pos.z) > 4) continue;
      ent.hurt(m, 1, dx + ox * 0.5, dz + oz * 0.5, this);
      swept = true;
    }
    if (swept) this.deps.audio.play('whoosh');
  }

  // --- health & hunger (20 Hz tick) -------------------------------------------

  tick(dts: number): void {
    this.shakeT = Math.max(0, this.shakeT - dts);
    if (this.mode === 'creative') {
      this.hp = 20;
      this.hunger = 20;
      this.air = 20;
      return;
    }
    if (this.dead) return;

    // drowning: lose a half-bubble every 0.75s underwater, then 1 dmg/s
    // (Water Breathing stops it; Respiration stretches each breath)
    if (this.underwaterEye() && !this.effects.has('water_breathing')) {
      this.airT += dts;
      if (this.airT >= 0.75 * (1 + enchLevel(this.inventory.armor[ARMOR_HEAD], 'respiration'))) {
        this.airT = 0;
        if (this.air > 0) this.air--;
      }
      if (this.air <= 0) {
        this.drownT += dts;
        if (this.drownT >= 1) {
          this.drownT = 0;
          this.damage(2, undefined, 'Drowned');
        }
      }
    } else {
      this.air = 20;
      this.airT = 0;
      this.drownT = 0;
    }

    // status effects count down; Regeneration heals, Hunger burns exhaustion
    for (const [id, ef] of this.effects) {
      ef.t -= dts;
      if (ef.t <= 0) {
        this.effects.delete(id);
        if (id === 'absorption') this.absorb = 0;
      }
    }
    const regen = this.effects.get('regeneration');
    if (regen) {
      this.regenEffT += dts;
      const period = 2.5 / (1 << Math.min(4, regen.amp)); // II heals twice as often
      if (this.regenEffT >= period) {
        this.regenEffT = 0;
        if (this.hp < 20) this.hp = Math.min(20, this.hp + 1);
      }
    } else {
      this.regenEffT = 0;
    }
    const hungerFx = this.effects.get('hunger');
    if (hungerFx) this.addExhaustion(0.1 * (hungerFx.amp + 1) * dts);

    // exhaustion drains the hidden saturation buffer before the hunger bar
    while (this.exhaustion >= 4) {
      this.exhaustion -= 4;
      if (this.saturation > 0) this.saturation = Math.max(0, this.saturation - 1);
      else this.hunger = Math.max(0, this.hunger - 1);
    }

    // natural regeneration (vanilla 1.11+): a full, well-fed bar heals fast
    // (every half second, paid from saturation); 18+ hunger heals slowly
    if (this.hp < 20 && this.hunger >= 20 && this.saturation > 0) {
      this.regenT += dts;
      if (this.regenT >= 0.5) {
        this.regenT = 0;
        this.hp = Math.min(20, this.hp + 1);
        this.addExhaustion(Math.min(this.saturation, 6));
      }
    } else if (this.hp < 20 && this.hunger >= 18) {
      this.regenT += dts;
      if (this.regenT >= 4) {
        this.regenT = 0;
        this.hp = Math.min(20, this.hp + 1);
        this.addExhaustion(6);
      }
    } else {
      this.regenT = 0;
    }


    if (this.hunger <= 0) {
      this.starveT += dts;
      if (this.starveT >= 4) {
        this.starveT = 0;
        if (this.hp > 2) this.damage(1, undefined, 'Starved to death');
      }
    } else {
      this.starveT = 0;
    }
  }

  addExhaustion(amount: number): void {
    if (this.mode === 'survival') this.exhaustion += amount;
  }

  damage(amount: number, source?: Entity, cause?: string): void {
    if (this.mode === 'creative' || this.dead) return;
    if (this.hurtCooldown > 0) return;
    // Fire Resistance shrugs off lava, magma and fireballs entirely
    if (this.effects.has('fire_resistance') && cause && /lava|magma|fireball|flames|burn/i.test(cause)) return;
    // a raised shield turns aside melee from the front, projectiles and blasts
    if (this.isBlocking() && this.shieldCovers(source, cause)) {
      this.hurtCooldown = 0.5;
      this.shieldKnockT = 0.15;
      this.wearShield(amount);
      this.deps.onAdvance?.('shield_block');
      this.deps.audio.play('arrowHit');
      if (source) this.deps.entities.onOwnerHurt(source);
      return;
    }
    this.hurtCooldown = 0.5;
    if (cause) this.lastDamageCause = cause;
    // pets retaliate against whatever just hurt their owner
    if (source) this.deps.entities.onOwnerHurt(source);
    // armor absorbs a share of the blow (MC: 4% per defense point, capped at 80%)
    // and each worn piece loses a point of durability.
    const ap = this.inventory.armorPoints();
    if (ap > 0) {
      amount = Math.max(0, Math.round(amount * (1 - Math.min(20, ap) * 0.04)));
      this.damageArmor();
    }
    // Protection: each level on each worn piece shaves another 4% (cap 80%)
    let prot = 0;
    for (const s of this.inventory.armor) prot += enchLevel(s, 'protection');
    if (prot > 0 && cause !== 'Starved to death' && cause !== 'Fell out of the world') {
      amount = Math.max(0, Math.round(amount * (1 - Math.min(20, prot) * 0.04)));
    }
    // Resistance: 20% less per level
    const res = this.effects.get('resistance');
    if (res) amount = Math.max(0, Math.round(amount * (1 - Math.min(1, 0.2 * (res.amp + 1)))));
    // Absorption hearts soak up damage before real health
    if (this.absorb > 0 && amount > 0) {
      const soak = Math.min(this.absorb, amount);
      this.absorb -= soak;
      amount -= soak;
    }
    this.addExhaustion(0.1);
    this.hp = Math.max(0, this.hp - amount);
    this.deps.audio.play('hurt');
    // screen shake scaled by the blow (capped so explosions don't nauseate)
    this.shakeT = this.shakeDur = 0.3;
    this.shakeMag = Math.min(0.5, 0.14 + amount * 0.04);
    document.getElementById('vignette')?.classList.remove('flash');
    void document.getElementById('vignette')?.offsetWidth;
    document.getElementById('vignette')?.classList.add('flash');
    if (this.hp <= 0) {
      this.dead = true;
      this.deps.audio.play('death');
      this.cancelBreaking();
      this.deps.onDeath();
    }
  }

  /** Does the raised shield cover this hit? Melee must come from in front;
   *  arrows, fireballs and explosions are met head-on and always blocked. */
  private shieldCovers(source: Entity | undefined, cause: string | undefined): boolean {
    if (source) {
      const d = this.lookDir();
      const tx = source.pos.x - this.pos.x, tz = source.pos.z - this.pos.z;
      return d.x * tx + d.z * tz > 0;
    }
    return !!cause && /shot|fireball|blown|phantom/i.test(cause);
  }

  /** A blocked blow chips the shield: 1 + the damage it stopped. */
  private wearShield(amount: number): void {
    const sel = this.inventory.selected;
    const s = this.inventory.slots[sel];
    if (!s || s.id !== I.SHIELD) return;
    const max = def(I.SHIELD).durability ?? 336;
    s.dur = (s.dur ?? max) - (amount >= 3 ? 1 + Math.floor(amount) : 1);
    if (s.dur <= 0) {
      this.inventory.slots[sel] = null;
      this.deps.audio.play('snap');
      this.deps.toast('Your Shield broke!');
    }
    this.inventory.onChange();
  }

  applyKnockback(dx: number, dz: number, power: number): void {
    if (this.shieldKnockT > 0) power *= 0.3; // the shield took the brunt
    const len = Math.hypot(dx, dz) || 1;
    this.vel.x += (dx / len) * power;
    this.vel.z += (dz / len) * power;
    this.vel.y = Math.max(this.vel.y, 4.5);
  }

  respawn(spawn: Vec3): void {
    if (this.riding) this.dismount(false);
    this.pos = { ...spawn };
    this.vel = { x: 0, y: 0, z: 0 };
    this.hp = 20;
    this.hunger = 20;
    this.saturation = 5;
    this.air = 20;
    this.exhaustion = 0;
    this.fireT = 0;
    this.clearEffects();
    this.fallDist = 0;
    this.gliding = false;
    this.rocketT = 0;
    this.dead = false;
    this.flying = false;
    this.lastDamageCause = '';
    this.shakeT = 0;
  }

  serialize(): PlayerSave {
    return {
      x: this.pos.x, y: this.pos.y, z: this.pos.z,
      pitch: this.pitch, yaw: this.yaw,
      health: this.hp, hunger: this.hunger,
      flying: this.flying,
      saturation: this.saturation,
      absorb: this.absorb,
      effects: this.effectList().map(({ id, amp, t, total }) => ({ id, amp, t, total })),
      xpLevel: this.xpLevel,
      xpProgress: this.xpProgress,
      ...(this.lastDeath ? { lastDeath: { ...this.lastDeath } } : {}),
    };
  }

  load(p: PlayerSave): void {
    this.pos = { x: p.x, y: p.y, z: p.z };
    this.pitch = p.pitch;
    this.yaw = p.yaw;
    this.hp = p.health;
    this.hunger = p.hunger;
    this.flying = !!p.flying;
    // older saves predate saturation/effects: start with vanilla's spawn buffer
    this.saturation = Math.max(0, Math.min(this.hunger, p.saturation ?? 5));
    this.effects.clear();
    for (const e of p.effects ?? []) {
      if (e.id in EFFECT_LABELS && e.t > 0) {
        this.effects.set(e.id as EffectId, { amp: e.amp | 0, t: e.t, total: e.total || e.t });
      }
    }
    this.absorb = this.effects.has('absorption') ? Math.max(0, p.absorb ?? 0) : 0;
    this.xpLevel = Math.max(0, p.xpLevel ?? 0) | 0;
    this.xpProgress = Math.max(0, Math.min(0.999, p.xpProgress ?? 0));
    this.lastDeath = p.lastDeath ? { ...p.lastDeath } : null;
  }
}
