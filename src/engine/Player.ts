// Player: survival/creative movement with Minecraft's numbers, AABB physics,
// breaking with crack progress, placing, eating, attacking, health/hunger,
// fall damage, sneaking edge-guard, sprinting, and flight.

import { World } from './World';
import { Input } from './Input';
import { Renderer } from './Renderer';
import { AudioEngine } from './Audio';
import { moveEntity, hasSupport, inWater, eyeInWater, boxIntersectsBlock, Vec3 } from './Physics';
import { B, I, def, hasDef, breakTime, attackDamage, isSolid, canHarvest, FLOOR_BLOCKS, SELF_STACKING } from './Blocks';
import { DoorFacing } from './World';
import { Inventory } from './Inventory';
import type { EntityManager } from './EntityManager';
import type { Entity } from './EntityManager';
import type { RayHit } from './World';

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
  exhaustion = 0;
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
  private lavaT = 0;
  private swimSoundT = 0;

  portalTimer = 0;
  portalCooldown = 0;

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

    // mouse look (pointer-lock on desktop, touch-drag on mobile)
    if (input.active && !uiOpen) {
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

    // sprint upkeep
    if (this.sprinting) {
      const canSprint = fwd > 0 && !this.sneaking && (this.mode === 'creative' || this.hunger > 6);
      if (!canSprint) this.sprinting = false;
    }
    if ((input.down('ShiftLeft') || input.down('ShiftRight')) && fwd > 0 && !this.sneaking &&
      (this.mode === 'creative' || this.hunger > 6)) {
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

    const underFeet = world.getBlock(Math.floor(this.pos.x), Math.floor(this.pos.y - 0.1), Math.floor(this.pos.z));
    if (underFeet === B.SOUL_SAND && !this.flying) {
      speed *= 0.4;
    }
    // magma block scorches the feet (unless sneaking) — lighter than lava, and
    // shares the lava burn cooldown so you can't be double-burned
    if (underFeet === B.MAGMA && this.onGround && !this.flying && !this.sneaking &&
        this.mode === 'survival' && this.lavaT <= 0) {
      this.lavaT = 0.5;
      this.damage(1);
      this.deps.entities.spawnBlockParticles(
        Math.floor(this.pos.x), Math.floor(this.pos.y), Math.floor(this.pos.z), B.MAGMA, 2);
    }

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
        this.vel.y = JUMP_VELOCITY;
        this.onGround = false;
        this.addExhaustion(this.sprinting ? 0.2 : 0.05);
      }
    }

    // integrate with collision
    const wasOnGround = this.onGround;
    const res = moveEntity(world, this.pos, this.vel, dt, BOX, this.sneaking, wasOnGround);
    const inWaterNow = inWater(world, this.pos, BOX);
    // touching water cancels accumulated fall distance (no fall damage into water)
    if (inWaterNow) this.fallDist = 0;
    this.swimSoundT = Math.max(0, this.swimSoundT - dt);
    if (!wasInWater && inWaterNow) {
      this.deps.audio.play('splash');
      this.swimSoundT = 0.45;
    } else if (inWaterNow && this.swimSoundT <= 0 && Math.hypot(this.vel.x, this.vel.z) > 0.7) {
      this.deps.audio.play('splash');
      this.swimSoundT = 0.85;
    }
    // climb out of water: swimming into a 1-block ledge hops you up onto it (so you
    // don't get stuck bobbing), and holding jump against any wall pushes upward.
    if (wasInWater && (res.hitX || res.hitZ)) {
      if (this.canStepUp(world, wx, wz)) this.vel.y = Math.max(this.vel.y, JUMP_VELOCITY);
      else if (space) this.vel.y = Math.max(this.vel.y, 5.0);
    }
    this.onGround = res.onGround;

    // fall damage + landing dust on hard impacts
    if (!this.flying && !wasInWater && !inWaterNow) {
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

    // lava contact: heavy damage over time + fire particles
    this.lavaT -= dt;
    if (this.mode === 'survival' && this.lavaT <= 0) {
      const hw = BOX.w / 2;
      const x0 = Math.floor(this.pos.x - hw), x1 = Math.floor(this.pos.x + hw);
      const y0 = Math.floor(this.pos.y), y1 = Math.floor(this.pos.y + BOX.h);
      const z0 = Math.floor(this.pos.z - hw), z1 = Math.floor(this.pos.z + hw);
      let inLava = false;
      for (let by = y0; by <= y1 && !inLava; by++) {
        for (let bz = z0; bz <= z1 && !inLava; bz++) {
          for (let bx = x0; bx <= x1 && !inLava; bx++) {
            if (world.getBlock(bx, by, bz) === B.LAVA) inLava = true;
          }
        }
      }
      if (inLava) {
        this.lavaT = 0.5;
        this.damage(3);
        // rising embers around the player
        const px = this.pos.x, py = this.pos.y + 0.5, pz = this.pos.z;
        for (let i = 0; i < 4; i++) {
          this.deps.entities.spawnBlockParticles(
            Math.floor(px), Math.floor(py), Math.floor(pz), B.LAVA, 1,
          );
        }
      }
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
    if (horse.dead || horse.kind !== 'horse' || !horse.ridden) { this.dismount(false); return; }
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
    this.pos.y = horse.pos.y + 0.9;
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

    world.setBlock(x, y, z, B.AIR);
    audio.dig(def(id).sound, 1);
    entities.spawnBlockParticles(x, y, z, id, 12);
    this.deps.onBreak(id);

    if (doorDrop && withDrops && this.mode === 'survival') {
      entities.spawnDrop(x + 0.5, y + 0.5, z + 0.5, I.WOOD_DOOR, 1);
      return;
    }

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
        const r = Math.random();
        if (r < 0.14) entities.spawnDrop(x + 0.5, y + 0.5, z + 0.5, I.SEEDS, 1);
        else if (r < 0.17) entities.spawnDrop(x + 0.5, y + 0.5, z + 0.5, I.BEETROOT_SEEDS, 1);
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

  /** Equip the held armor piece, swapping any currently-worn piece back to the slot. */
  private equipArmor(): void {
    const sel = this.inventory.selected;
    const held = this.inventory.slots[sel];
    const a = held ? def(held.id).armor : null;
    if (!held || !a) return;
    const prev = this.inventory.armor[a.slot];
    this.inventory.armor[a.slot] = { id: held.id, count: 1, dur: held.dur };
    if (this.mode !== 'creative') this.inventory.slots[sel] = prev ?? null;
    this.placeCooldown = 0.35;
    this.deps.renderer.triggerSwing();
    this.deps.audio.play('level');
    this.inventory.onChange();
  }

  /** Wear down each worn armor piece by one point; pieces snap at zero. */
  private damageArmor(): void {
    let changed = false;
    for (let i = 0; i < this.inventory.armor.length; i++) {
      const s = this.inventory.armor[i];
      if (!s) continue;
      const max = def(s.id).durability ?? 0;
      if (!max) continue;
      s.dur = (s.dur ?? max) - 1;
      if (s.dur <= 0) { this.inventory.armor[i] = null; this.deps.audio.play('snap'); }
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

    // mob interaction: tame wolves / open villager trades (before generic use)
    if (!this.sneaking && this.placeCooldown <= 0) {
      const hit = this.deps.entities.raycastMobs(
        this.pos.x, this.pos.y + this.eyeHeight(), this.pos.z,
        this.lookDir().x, this.lookDir().y, this.lookDir().z, 3.5,
      );
      if (hit && hit.dist < (this.target?.dist ?? 4.5)) {
        const res = this.deps.entities.interactMob(hit.entity, held?.id ?? 0);
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

    // equip wearable armor onto the body (right-click swaps with the worn piece)
    if (heldDef?.armor && this.placeCooldown <= 0) {
      this.equipArmor();
      return;
    }

    // eating
    if (this.mode === 'survival' && heldDef?.food && this.hunger < 20) {
      this.eatT += dt;
      this.chewT -= dt;
      if (this.chewT <= 0) { this.chewT = 0.25; audio.play('eat'); }
      if (this.eatT >= 1.6) {
        const eaten = heldDef.id;
        this.hunger = Math.min(20, this.hunger + heldDef.food);
        this.inventory.consumeSelected();
        if (eaten === I.BEETROOT_SOUP || eaten === I.VEGETABLE_STEW) {
          const left = this.inventory.add(I.BOWL, 1);
          if (left > 0) this.deps.entities.spawnDrop(this.pos.x, this.pos.y + 1, this.pos.z, I.BOWL, left);
        }
        this.eatT = 0;
        audio.play('burp');
      }
      return;
    }
    this.eatT = 0;

    if (this.placeCooldown > 0) return;

    // bucket: scoop a water/lava source (empty) or pour a source (full)
    if (held?.id === I.BUCKET && this.tryScoopWater()) return;
    if (held?.id === I.BUCKET && this.tryScoopLava()) return;
    if (held?.id === I.WATER_BUCKET && this.tryPlaceWater()) return;
    if (held?.id === I.LAVA_BUCKET && this.tryPlaceLava()) return;

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

    // flint & steel: ignite an obsidian frame into a Nether portal
    if (this.target && held?.id === I.FLINT_AND_STEEL) {
      this.placeCooldown = 0.3;
      this.deps.renderer.triggerSwing();
      const t = this.target;
      if (this.tryIgnitePortal(t.x + t.nx, t.y + t.ny, t.z + t.nz)) {
        audio.play('fuse');
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
      this.placeCooldown = 0.3;
      this.deps.renderer.triggerSwing();
      audio.dig('wood', 0.8);
      this.deps.useDoor(px, py, pz);
      if (this.mode === 'survival') this.inventory.consumeSelected();
      return;
    }

    if (!heldDef?.block) return;
    const px = this.target.x + this.target.nx;
    const py = this.target.y + this.target.ny;
    const pz = this.target.z + this.target.nz;
    const existing = world.getBlock(px, py, pz);
    if (existing !== B.AIR && existing !== B.WATER) return;

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

    if (world.setBlock(px, py, pz, placeId)) {
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

  private plantedCropFor(id: number): number {
    if (id === I.SEEDS) return B.WHEAT_0;
    if (id === I.CARROT) return B.CARROT_0;
    if (id === I.POTATO) return B.POTATO_0;
    if (id === I.BEETROOT_SEEDS) return B.BEETROOT_0;
    return 0;
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
    if (hit && hit.entity !== this.riding && hit.dist < blockDist) {
      this.attackCooldown = 0.5;
      let dmg = attackDamage(this.heldId());
      // critical hit: striking while falling (mid-air, descending) deals +50%
      const crit = !this.onGround && this.vel.y < -0.15 && !this.flying && !this.onLadder;
      if (crit) {
        dmg = Math.ceil(dmg * 1.5);
        const en = hit.entity;
        this.deps.entities.spawnCritParticles(en.pos.x, en.pos.y + en.box.h * 0.6, en.pos.z);
      }
      this.deps.entities.hurt(hit.entity, dmg, d.x, d.z);
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
    // armor absorbs a share of the blow (MC: 4% per defense point, capped at 80%)
    // and each worn piece loses a point of durability.
    const ap = this.inventory.armorPoints();
    if (ap > 0) {
      amount = Math.max(0, Math.round(amount * (1 - Math.min(20, ap) * 0.04)));
      this.damageArmor();
    }
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
    if (this.riding) this.dismount(false);
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
