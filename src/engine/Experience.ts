// Experience orbs: small glowing green spheres dropped by slain mobs, mined
// ores, smelting and fishing. They hop out, settle, then stream toward a
// nearby player and are absorbed for experience (see Player.addXp).

import * as THREE from 'three';
import type { World } from './World';
import { moveEntity, Vec3 } from './Physics';

interface Orb {
  sprite: THREE.Sprite;
  pos: Vec3;
  vel: Vec3;
  value: number;
  age: number;
  phase: number;
}

// vanilla orb split sizes (largest first)
const SIZES = [2477, 1237, 617, 307, 149, 73, 37, 17, 7, 3, 1];
const BOX = { w: 0.25, h: 0.25 };
const MAX_ORBS = 160;

/** Pixel orb textures, bigger + brighter for larger values. */
function orbTexture(size: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const ctx = c.getContext('2d')!;
  const r = 2.2 + size * 1.1;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const d = Math.hypot(x - 7.5, y - 7.5);
      if (d > r) continue;
      const lit = (7.5 - x) + (7.5 - y); // top-left highlight
      ctx.fillStyle = d > r - 1 ? '#2f5a08' : lit > r * 0.9 ? '#f4ffb0' : lit > 0 ? '#c8f23a' : '#7cc21a';
      ctx.fillRect(x, y, 1, 1);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class ExperienceOrbs {
  private orbs: Orb[] = [];
  private mats: THREE.SpriteMaterial[];

  constructor(private scene: THREE.Scene, private world: World) {
    this.mats = [0, 1, 2, 3].map((s) => new THREE.SpriteMaterial({
      map: orbTexture(s), transparent: true, alphaTest: 0.3, depthWrite: false, fog: true,
    }));
  }

  /** Scatter `points` of experience at a spot as a handful of orbs. */
  spawn(x: number, y: number, z: number, points: number): void {
    let left = Math.floor(points);
    while (left > 0 && this.orbs.length < MAX_ORBS) {
      const v = SIZES.find((s) => s <= left) ?? 1;
      left -= v;
      const tier = v >= 17 ? 3 : v >= 7 ? 2 : v >= 3 ? 1 : 0;
      const sprite = new THREE.Sprite(this.mats[tier].clone());
      sprite.scale.setScalar(0.3);
      this.scene.add(sprite);
      this.orbs.push({
        sprite, value: v, age: 0, phase: Math.random() * 6,
        pos: { x, y, z },
        vel: { x: (Math.random() - 0.5) * 3, y: 2.5 + Math.random() * 2.5, z: (Math.random() - 0.5) * 3 },
      });
    }
    // any remainder past the cap merges into the newest orb
    if (left > 0 && this.orbs.length) this.orbs[this.orbs.length - 1].value += left;
  }

  /** Move orbs; those within reach of `target` fly to it and are absorbed via `collect`. */
  update(dt: number, target: Vec3 | null, collect: (points: number) => void): void {
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const o = this.orbs[i];
      o.age += dt;
      let dead = o.age > 300;
      if (target && o.age > 0.5) {
        const dx = target.x - o.pos.x, dy = target.y + 0.8 - o.pos.y, dz = target.z - o.pos.z;
        const d = Math.hypot(dx, dy, dz);
        if (d < 0.7) {
          collect(o.value);
          dead = true;
        } else if (d < 8) {
          // pull harder the closer it gets (vanilla's 1 - d/8 squared falloff)
          const pull = (1 - d / 8) ** 2 * 60 * dt;
          o.vel.x += (dx / d) * pull; o.vel.y += (dy / d) * pull; o.vel.z += (dz / d) * pull;
        }
      }
      if (dead) {
        this.scene.remove(o.sprite);
        o.sprite.material.dispose();
        this.orbs.splice(i, 1);
        continue;
      }
      o.vel.y -= 12 * dt;
      const damp = Math.pow(0.4, dt);
      o.vel.x *= damp; o.vel.z *= damp;
      const res = moveEntity(this.world, o.pos, o.vel, dt, BOX);
      if (res.onGround && o.vel.y <= 0) { o.vel.x *= 0.7; o.vel.z *= 0.7; }
      // a gentle bob + a green-to-yellow shimmer
      o.phase += dt * 4;
      const s = 0.5 + 0.5 * Math.sin(o.phase);
      o.sprite.position.set(o.pos.x, o.pos.y + 0.14 + Math.sin(o.phase * 0.7) * 0.04, o.pos.z);
      o.sprite.material.color.setRGB(0.85 + 0.15 * s, 1, 0.55 + 0.45 * (1 - s));
    }
  }

  clear(): void {
    for (const o of this.orbs) { this.scene.remove(o.sprite); o.sprite.material.dispose(); }
    this.orbs = [];
  }
}

/** Experience bar + level number above the hotbar (survival only). */
export class XpBar {
  private el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private label: HTMLDivElement;
  private last = '';

  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'xp-bar';
    Object.assign(this.el.style, {
      position: 'relative', width: '100%', height: '12px', marginBottom: '3px', pointerEvents: 'none',
      display: 'none',
    } as CSSStyleDeclaration);
    this.canvas = document.createElement('canvas');
    this.canvas.width = 182; this.canvas.height = 5;
    Object.assign(this.canvas.style, {
      position: 'absolute', left: '2px', right: '2px', bottom: '0', width: 'calc(100% - 4px)', height: '10px',
      imageRendering: 'pixelated',
    } as CSSStyleDeclaration);
    this.label = document.createElement('div');
    Object.assign(this.label.style, {
      position: 'absolute', left: '50%', bottom: '4px', transform: 'translateX(-50%)',
      color: '#80ff20', fontSize: '15px', fontWeight: 'bold', lineHeight: '1',
      textShadow: '1px 0 #000, -1px 0 #000, 0 1px #000, 0 -1px #000, 1px 1px #000',
    } as CSSStyleDeclaration);
    this.el.append(this.canvas, this.label);
    this.attach();
  }

  /** Slot in just above the hotbar once the HUD exists (it's rebuilt per game). */
  private attach(): void {
    const hotbar = document.getElementById('hotbar');
    if (hotbar?.parentElement && this.el.parentElement !== hotbar.parentElement) {
      hotbar.parentElement.insertBefore(this.el, hotbar);
    }
  }

  update(visible: boolean, level: number, progress: number): void {
    if (!this.el.isConnected) this.attach();
    const key = `${visible}|${level}|${Math.round(progress * 182)}`;
    if (key === this.last) return;
    this.last = key;
    this.el.style.display = visible ? 'block' : 'none';
    if (!visible) return;
    const ctx = this.canvas.getContext('2d')!;
    ctx.clearRect(0, 0, 182, 5);
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, 182, 5);
    ctx.fillStyle = '#3a4a2a';
    ctx.fillRect(1, 1, 180, 3);
    const w = Math.round(progress * 180);
    if (w > 0) {
      ctx.fillStyle = '#80ff20'; ctx.fillRect(1, 1, w, 3);
      ctx.fillStyle = '#c8ff80'; ctx.fillRect(1, 1, w, 1);
    }
    // segment ticks like vanilla's bar
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    for (let i = 1; i < 18; i++) ctx.fillRect(1 + Math.round(i * 10.1), 1, 1, 3);
    this.label.textContent = level > 0 ? String(level) : '';
  }

  dispose(): void { this.el.remove(); }
}
