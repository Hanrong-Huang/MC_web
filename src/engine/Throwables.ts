// Thrown items: warp pearls (teleport the thrower to where they land),
// snowballs (a harmless knock-back, but they sting fiery Nether mobs) and fire
// charges (a small flat-flying fireball that burns what it hits and sets the
// spot it lands on alight).

import * as THREE from 'three';
import type { World } from './World';
import type { Atlas } from './Textures';
import type { EntityManager } from './EntityManager';
import { B, I, def, hasDef } from './Blocks';
import { netherFX } from './NetherFX';

interface Shot {
  id: number;
  sprite: THREE.Sprite;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  age: number;
}

const GRAVITY = 18;
const SPEED = 22;

export class Throwables {
  private shots: Shot[] = [];
  private mats = new Map<number, THREE.SpriteMaterial>();
  /** a warp pearl came down here: move the thrower */
  onWarp: (x: number, y: number, z: number) => void = () => {};
  /** a fire charge burst here: light a fire in this air cell */
  onIgnite: (x: number, y: number, z: number) => void = () => {};

  constructor(private scene: THREE.Scene, private world: World, private atlas: Atlas, private entities: EntityManager) {}

  private material(id: number): THREE.SpriteMaterial {
    let m = this.mats.get(id);
    if (!m) {
      const src = this.atlas.sprite(def(id).sprite!);
      const tex = new THREE.CanvasTexture(src ?? document.createElement('canvas'));
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.colorSpace = THREE.SRGBColorSpace;
      m = new THREE.SpriteMaterial({ map: tex, transparent: true, alphaTest: 0.3 });
      this.mats.set(id, m);
    }
    return m;
  }

  throw(id: number, x: number, y: number, z: number, dx: number, dy: number, dz: number): void {
    const sprite = new THREE.Sprite(this.material(id));
    const fire = id === I.FIRE_CHARGE;
    sprite.scale.setScalar(fire ? 0.42 : 0.32);
    sprite.position.set(x, y, z);
    this.scene.add(sprite);
    const sp = fire ? 17 : SPEED;
    this.shots.push({ id, sprite, x, y, z, vx: dx * sp, vy: dy * sp + (fire ? 0 : 1.5), vz: dz * sp, age: 0 });
  }

  update(dt: number): void {
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i];
      s.age += dt;
      const fire = s.id === I.FIRE_CHARGE;
      s.vy -= (fire ? 1.5 : GRAVITY) * dt; // fire charges fly nearly flat
      if (fire) netherFX.fireTrail(s.x, s.y, s.z);
      const sp = Math.hypot(s.vx, s.vy, s.vz);
      const steps = Math.max(1, Math.ceil(sp * dt / 0.3));
      const sdt = dt / steps;
      let landed = false;
      for (let k = 0; k < steps && !landed; k++) {
        // mobs first (a short ray over this sub-step)
        const len = sp * sdt;
        if (len > 0 && s.age > 0.05) {
          const hit = this.entities.raycastMobs(s.x, s.y, s.z, s.vx / sp, s.vy / sp, s.vz / sp, len + 0.2);
          if (hit) {
            if (s.id === I.SNOWBALL) {
              const fiery = ['cinderling', 'emberghast', 'ashstalker'].includes(hit.entity.kind as string);
              this.entities.hurt(hit.entity, fiery ? 3 : 0, s.vx, s.vz);
            } else if (s.id === I.FIRE_CHARGE) {
              this.entities.hurt(hit.entity, 5, s.vx * 0.3, s.vz * 0.3);
              hit.entity.burnT = Math.max(hit.entity.burnT, 5);
            }
            landed = true;
            break;
          }
        }
        const nx = s.x + s.vx * sdt, ny = s.y + s.vy * sdt, nz = s.z + s.vz * sdt;
        const id = this.world.getBlock(Math.floor(nx), Math.floor(ny), Math.floor(nz));
        if (id !== B.AIR && hasDef(id) && (def(id).solid || id === B.WATER || id === B.LAVA)) { landed = true; break; }
        s.x = nx; s.y = ny; s.z = nz;
      }
      if (landed || s.age > 8 || s.y < -20) {
        if (landed || s.id === I.WARP_PEARL) this.impact(s);
        this.scene.remove(s.sprite);
        this.shots.splice(i, 1);
        continue;
      }
      s.sprite.position.set(s.x, s.y, s.z);
    }
  }

  private impact(s: Shot): void {
    const bx = Math.floor(s.x), by = Math.floor(s.y), bz = Math.floor(s.z);
    if (s.id === I.WARP_PEARL) {
      this.entities.spawnPoof(s.x, s.y, s.z);
      this.entities.spawnBlockParticles(bx, by, bz, B.PORTAL, 10);
      if (s.y > -16) this.onWarp(s.x, s.y, s.z);
    } else if (s.id === I.FIRE_CHARGE) {
      netherFX.fireBurst(s.x, s.y, s.z, 16);
      // the flame takes in the open cell it flew through (the shot's current
      // position is still on the air side of whatever it struck)
      if (this.world.getBlock(bx, by, bz) === B.AIR) this.onIgnite(bx, by, bz);
    } else {
      this.entities.spawnBlockParticles(bx, by, bz, B.SNOW_BLOCK, 8);
    }
  }

  clear(): void {
    for (const s of this.shots) this.scene.remove(s.sprite);
    this.shots = [];
  }
}
