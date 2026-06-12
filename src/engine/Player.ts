// Player: survival/creative movement with Minecraft's numbers, AABB physics,
// breaking with crack progress, placing, eating, attacking, health/hunger,
// fall damage, sneaking edge-guard, sprinting, and flight.

import { World } from './World';
import { Input } from './Input';
import { Renderer } from './Renderer';
import { AudioEngine } from './Audio';
import { moveEntity, hasSupport, inWater, eyeInWater, boxIntersectsBlock, Vec3 } from './Physics';
import { B, I, def, hasDef, breakTime, attackDamage, isSolid, canHarvest, FLOOR_BLOCKS, SELF_STACKING } from './Blocks';
import { Inventory } from './Inventory';
import type { EntityManager } from './EntityManager';
import type { RayHit } from './World';

export type GameMode = 'survival' | 'creative';

const WALK_SPEED = 4.317;
const SPRINT_SPEED = 5.612;
const SNEAK_SPEED = 1.295;
const FLY_SPEED = WALK_SPEED * 2.5;     // creative flight: 2.5x multiplier
const FLY_VERT = 7.5;
const JUMP_VELOCITY = Math.sqrt(2 * 32 * 1.25); // exactly 1.25 blocks high
const GRAVITY = 32;
const TERMINAL = 78;
const EYE_HEIGHT = 1.62;
const EYE_SNEAK = 1.54;
const REACH = 4.5;
const BOX = { w: 0.6, h: 1.8 };

export interface PlayerDeps {
  world: World;
  input: Input;
  renderer: Renderer;
  entities: EntityManager;
  audio: AudioEngine;
  isUIOpen: () => boolean;
  openContainer: (kind: 'table' | 'furnace' | 'chest', x: number, y: number, z: number) => void;
  useBed: (x: number, y: number, z: number) => void;
  igniteTnt: (x: number, y: number, z: number) => void;
  onDeath: () => void;
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
  hp = 20;
  hunger = 20;
  exhaustion = 0;
  /** remaining air bubbles (x2 half-bubbles like hearts), 20 = full */
  air = 20;
  dead = false;
  inventory = new Inventory();

  target: RayHit | null = null;
  breaking: { x: number; y: number; z: number; progress: number; time: number } | null = null;
  /** seconds the bow has been drawn; 0 = not drawing */
  bowCharge = 0;

  private deps!: PlayerDeps;
  private fallDist = 0;
  private attackCooldown = 0;
  private placeCooldown = 0;
  private eatT = 0;
  private chewT = 0;
  private stepDist = 0;
  private swingRepeat = 0;
  private regenT = 0;
  private starveT = 0;
  private hurtCooldown = 0;
  private airT = 0;
  private drownT = 0;
  private cactusT = 0;

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

  toggleFly(): void {
    this.flying = !this.flying;
    if (this.flying) this.vel.y = 0;
    this.fallDist = 0;
  }

  selectSlot(i: number): void {
    this.inventory.selected = ((i % 9) + 9) % 9;
    this.inventory.onChange();
  }

  // -------------------------------------------------------------------------

  update(dt: number): void {
    const { input, world } = this.deps;
    const uiOpen = this.deps.isUIOpen() || this.dead;

    // mouse look
    if (input.pointerLocked && !uiOpen) {
      const [dx, dy] = input.consumeMouse();
      const sens = 0.0023;
      this.yaw -= dx * sens;
      this.pitch -= dy * sens;
      const lim = Math.PI / 2 - 0.001;
      this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
    } else {
      input.consumeMouse();
    }

    this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    this.placeCooldown = Math.max(0, this.placeCooldown - dt);
    this.hurtCooldown = Math.max(0, this.hurtCooldown - dt);

    // movement intent
    let fwd = 0, strafe = 0;
    let space = false;
    this.sneaking = false;
    if (!uiOpen && input.pointerLocked) {
      if (input.down('KeyW')) fwd += 1;
      if (input.down('KeyS')) fwd -= 1;
      if (input.down('KeyA')) strafe -= 1;
      if (input.down('KeyD')) strafe += 1;
      space = input.down('Space');
      this.sneaking = (input.down('ShiftLeft') || input.down('ShiftRight')) && !this.flying;
    }

    // sprint upkeep
    if (this.sprinting) {
      const canSprint = fwd > 0 && !this.sneaking && (this.mode === 'creative' || this.hunger > 6);
      if (!canSprint) this.sprinting = false;
    }
    if ((input.down('ControlLeft') || input.down('ControlRight')) && fwd > 0 && !this.sneaking &&
      (this.mode === 'creative' || this.hunger > 6)) {
      this.sprinting = true;
    }

    const wasInWater = inWater(world, this.pos, BOX);
    this.swimming = wasInWater;

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

    // snappy acceleration with slight air control
    const accelK = this.flying ? 9 : this.onGround ? 16 : wasInWater ? 7 : 4.2;
    const blend = Math.min(1, accelK * dt);
    this.vel.x += (wx * speed - this.vel.x) * blend;
    this.vel.z += (wz * speed - this.vel.z) * blend;

    // vertical
    if (this.flying) {
      const upWish = (space ? FLY_VERT : 0) + (this.sneakKeyDown() ? -FLY_VERT : 0);
      this.vel.y += (upWish - this.vel.y) * Math.min(1, 10 * dt);
      this.fallDist = 0;
    } else if (wasInWater) {
      const targetVy = space ? 3.9 : -2.2;
      this.vel.y += (targetVy - this.vel.y) * Math.min(1, 5 * dt);
      this.fallDist = 0;
    } else {
      this.vel.y -= GRAVITY * dt;
      if (this.vel.y < -TERMINAL) this.vel.y = -TERMINAL;
      if (space && this.onGround) {
        this.vel.y = JUMP_VELOCITY;
        this.onGround = false;
        this.addExhaustion(this.sprinting ? 0.2 : 0.05);
      }
    }

    // integrate with collision
    const wasOnGround = this.onGround;
    const res = moveEntity(world, this.pos, this.vel, dt, BOX, this.sneaking, wasOnGround);
    // climb out of water against a wall
    if (wasInWater && (res.hitX || res.hitZ) && space) this.vel.y = Math.max(this.vel.y, 4.5);
    this.onGround = res.onGround;

    // fall damage + landing dust on hard impacts
    if (!this.flying && !wasInWater) {
      if (this.vel.y < 0) this.fallDist += -this.vel.y * dt;
      if (this.onGround && this.fallDist > 0) {
        if (this.fallDist > 2.5) {
          const below = world.getBlock(Math.floor(this.pos.x), Math.floor(this.pos.y - 0.5), Math.floor(this.pos.z));
          if (below !== B.AIR && hasDef(below)) {
            this.deps.entities.spawnBlockParticles(
              Math.floor(this.pos.x), Math.floor(this.pos.y), Math.floor(this.pos.z), below, 6);
            this.deps.audio.step(def(below).sound);
          }
        }
        const dmg = Math.floor(this.fallDist - 3);
        if (dmg > 0 && this.mode === 'survival') {
          this.damage(dmg);
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
        if (below !== B.AIR && hasDef(below)) this.deps.audio.step(def(below).sound);
      }
      this.addExhaustion(Math.hypot(this.vel.x, this.vel.z) * dt * (this.sprinting ? 0.02 : 0.002));
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
              this.damage(1);
              break outer;
            }
          }
        }
      }
    }

    // void rescue: respawn-style safety net if the player escapes the world floor
    if (this.pos.y < -16) {
      if (this.mode === 'survival') this.damage(4);
      this.pos.y = 130;
      this.vel.y = 0;
    }

    // interaction
    if (!uiOpen && input.pointerLocked) {
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

  private sneakKeyDown(): boolean {
    return this.deps.input.down('ShiftLeft') || this.deps.input.down('ShiftRight');
  }

  isMoving(): boolean {
    return Math.hypot(this.vel.x, this.vel.z) > 0.5 && this.onGround;
  }

  underwaterEye(): boolean {
    return eyeInWater(this.deps.world, this.pos, this.eyeHeight());
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

    const total = breakTime(t.id, this.heldId());
    if (!isFinite(total)) {
      this.cancelBreaking();
      return;
    }
    if (!this.breaking || this.breaking.x !== t.x || this.breaking.y !== t.y || this.breaking.z !== t.z) {
      this.breaking = { x: t.x, y: t.y, z: t.z, progress: 0, time: total };
    }
    this.breaking.progress += dt / total;

    this.swingRepeat -= dt;
    if (this.swingRepeat <= 0) {
      this.swingRepeat = 0.26;
      renderer.triggerSwing();
      audio.dig(def(t.id).sound, 0.25);
      this.deps.entities.spawnHitParticles(t.x, t.y, t.z, t.nx, t.ny, t.nz, t.id);
    }

    if (this.breaking.progress >= 1) {
      this.breakBlock(t.x, t.y, t.z, true);
      this.breaking = null;
      renderer.setCrack(null, -1);
      this.addExhaustion(0.03);
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

    world.setBlock(x, y, z, B.AIR);
    audio.dig(def(id).sound, 1);
    entities.spawnBlockParticles(x, y, z, id, 12);

    if (withDrops && this.mode === 'survival') {
      if (def(id).hardness > 0) this.damageHeldTool(true);
      if (!canHarvest(id, this.heldId())) return; // wrong tool tier: no drops
      // special drop tables
      if (id === B.GRAVEL) {
        entities.spawnDrop(x + 0.5, y + 0.5, z + 0.5, Math.random() < 0.25 ? I.FLINT : B.GRAVEL, 1);
        return;
      }
      if (id === B.LEAVES || id === B.BIRCH_LEAVES || id === B.SPRUCE_LEAVES) {
        const r = Math.random();
        if (r < 0.06) entities.spawnDrop(x + 0.5, y + 0.5, z + 0.5, B.SAPLING, 1);
        else if (id === B.LEAVES && r < 0.1) entities.spawnDrop(x + 0.5, y + 0.5, z + 0.5, I.APPLE, 1);
        return;
      }
      if (id === B.TALL_GRASS) {
        if (Math.random() < 0.18) entities.spawnDrop(x + 0.5, y + 0.5, z + 0.5, I.SEEDS, 1);
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
      const d = def(id);
      if (d.drop === null) return;
      const drop = d.drop ?? { id, min: 1, max: 1 };
      const count = drop.min + Math.floor(Math.random() * (drop.max - drop.min + 1));
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
    slot.dur = (slot.dur ?? d.durability) - 1;
    if (slot.dur <= 0) {
      this.inventory.slots[this.inventory.selected] = null;
      this.deps.audio.play('snap');
    }
    this.inventory.onChange();
  }

  // --- right click: interact / eat / place ------------------------------------

  private updateRightClick(dt: number): void {
    const { input, world, audio } = this.deps;
    if (!input.rightDown && !input.takeRightClick()) {
      this.eatT = 0;
      return;
    }

    const held = this.inventory.getSelected();
    const heldDef = held ? def(held.id) : null;

    // drawing a bow takes priority while held
    if (heldDef?.bow) {
      const hasAmmo = this.mode === 'creative' || this.inventory.count(I.ARROW) > 0;
      if (hasAmmo) this.bowCharge += dt;
      return;
    }

    // eating
    if (this.mode === 'survival' && heldDef?.food && this.hunger < 20) {
      this.eatT += dt;
      this.chewT -= dt;
      if (this.chewT <= 0) { this.chewT = 0.25; audio.play('eat'); }
      if (this.eatT >= 1.6) {
        this.hunger = Math.min(20, this.hunger + heldDef.food);
        this.inventory.consumeSelected();
        this.eatT = 0;
        audio.play('burp');
      }
      return;
    }
    this.eatT = 0;

    if (this.placeCooldown > 0) return;

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
      if (t.id === B.BED) {
        this.placeCooldown = 0.4;
        this.deps.useBed(t.x, t.y, t.z);
        return;
      }
      if (t.id === B.TNT) {
        this.placeCooldown = 0.4;
        this.deps.igniteTnt(t.x, t.y, t.z);
        return;
      }
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

    // seeds: plant wheat on farmland
    if (this.target && held?.id === I.SEEDS) {
      if (this.target.id === B.FARMLAND && this.target.ny === 1 &&
        world.getBlock(this.target.x, this.target.y + 1, this.target.z) === B.AIR) {
        world.setBlock(this.target.x, this.target.y + 1, this.target.z, B.WHEAT_0);
        this.placeCooldown = 0.22;
        this.deps.renderer.triggerSwing();
        audio.dig('grass', 0.6);
        if (this.mode === 'survival') this.inventory.consumeSelected();
      }
      return;
    }

    // placement
    if (!this.target || !held || !heldDef?.block) return;
    const px = this.target.x + this.target.nx;
    const py = this.target.y + this.target.ny;
    const pz = this.target.z + this.target.nz;
    const existing = world.getBlock(px, py, pz);
    if (existing !== B.AIR && existing !== B.WATER) return;
    // plants/torches need a floor (cane and cactus may stack on themselves)
    if (FLOOR_BLOCKS.has(held.id)) {
      const below = world.getBlock(px, py - 1, pz);
      const supported = isSolid(below) || (SELF_STACKING.has(held.id) && below === held.id);
      if (!supported) return;
    }
    // never place inside the player's own hitbox (solid blocks only)
    if (isSolid(held.id) && boxIntersectsBlock(this.pos, BOX, px, py, pz)) return;
    if (isSolid(held.id) && this.deps.entities.anyMobIntersecting(px, py, pz)) return;

    if (world.setBlock(px, py, pz, held.id)) {
      this.placeCooldown = 0.22;
      this.deps.renderer.triggerSwing();
      audio.dig(heldDef.sound, 0.8);
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
    this.deps.entities.shootArrow(
      'player',
      this.pos.x + d.x * 0.4, ey + d.y * 0.4 - 0.05, this.pos.z + d.z * 0.4,
      d.x, d.y, d.z,
      14 + 36 * charge,
      Math.ceil(2 + 7 * charge),
    );
    this.deps.renderer.triggerSwing();
    this.damageHeldTool();
  }

  /** Left mouse press: try attacking an entity first; swing regardless. */
  onLeftClick(): void {
    if (this.deps.isUIOpen() || this.dead || !this.deps.input.pointerLocked) return;
    this.deps.renderer.triggerSwing();
    if (this.attackCooldown > 0) return;
    const d = this.lookDir();
    const ey = this.pos.y + this.eyeHeight();
    const blockDist = this.target?.dist ?? Infinity;
    const hit = this.deps.entities.raycastMobs(this.pos.x, ey, this.pos.z, d.x, d.y, d.z, 3.5);
    if (hit && hit.dist < blockDist) {
      this.attackCooldown = 0.5;
      this.deps.entities.hurt(hit.entity, attackDamage(this.heldId()), d.x, d.z);
      this.addExhaustion(0.1);
      this.damageHeldTool();
    }
  }

  // --- health & hunger (20 Hz tick) -------------------------------------------

  tick(dts: number): void {
    if (this.mode === 'creative') {
      this.hp = 20;
      this.hunger = 20;
      this.air = 20;
      return;
    }
    if (this.dead) return;

    // drowning: lose a half-bubble every 0.75s underwater, then 1 dmg/s
    if (this.underwaterEye()) {
      this.airT += dts;
      if (this.airT >= 0.75) {
        this.airT = 0;
        if (this.air > 0) this.air--;
      }
      if (this.air <= 0) {
        this.drownT += dts;
        if (this.drownT >= 1) {
          this.drownT = 0;
          this.damage(2);
        }
      }
    } else {
      this.air = 20;
      this.airT = 0;
      this.drownT = 0;
    }

    while (this.exhaustion >= 4) {
      this.exhaustion -= 4;
      this.hunger = Math.max(0, this.hunger - 1);
    }

    if (this.hunger >= 18 && this.hp < 20) {
      this.regenT += dts;
      if (this.regenT >= 2) {
        this.regenT = 0;
        this.hp = Math.min(20, this.hp + 1);
        this.addExhaustion(1.5);
      }
    } else {
      this.regenT = 0;
    }

    if (this.hunger <= 0) {
      this.starveT += dts;
      if (this.starveT >= 4) {
        this.starveT = 0;
        if (this.hp > 2) this.damage(1);
      }
    } else {
      this.starveT = 0;
    }
  }

  addExhaustion(amount: number): void {
    if (this.mode === 'survival') this.exhaustion += amount;
  }

  damage(amount: number): void {
    if (this.mode === 'creative' || this.dead) return;
    if (this.hurtCooldown > 0) return;
    this.hurtCooldown = 0.5;
    this.hp = Math.max(0, this.hp - amount);
    this.deps.audio.play('hurt');
    document.getElementById('vignette')?.classList.remove('flash');
    void document.getElementById('vignette')?.offsetWidth;
    document.getElementById('vignette')?.classList.add('flash');
    if (this.hp <= 0) {
      this.dead = true;
      this.cancelBreaking();
      this.deps.onDeath();
    }
  }

  applyKnockback(dx: number, dz: number, power: number): void {
    const len = Math.hypot(dx, dz) || 1;
    this.vel.x += (dx / len) * power;
    this.vel.z += (dz / len) * power;
    this.vel.y = Math.max(this.vel.y, 4.5);
  }

  respawn(spawn: Vec3): void {
    this.pos = { ...spawn };
    this.vel = { x: 0, y: 0, z: 0 };
    this.hp = 20;
    this.hunger = 20;
    this.air = 20;
    this.exhaustion = 0;
    this.fallDist = 0;
    this.dead = false;
    this.flying = false;
  }

  serialize() {
    return {
      x: this.pos.x, y: this.pos.y, z: this.pos.z,
      pitch: this.pitch, yaw: this.yaw,
      health: this.hp, hunger: this.hunger,
      flying: this.flying,
    };
  }

  load(p: { x: number; y: number; z: number; pitch: number; yaw: number; health: number; hunger: number; flying: boolean }): void {
    this.pos = { x: p.x, y: p.y, z: p.z };
    this.pitch = p.pitch;
    this.yaw = p.yaw;
    this.hp = p.health;
    this.hunger = p.hunger;
    this.flying = !!p.flying;
  }
}
