// Fluid effects: splash droplets, rising bubbles, expanding surface ripples,
// lava pops (embers flung off open lava) and water/lava drips under blocks
// with fluid above them (vanilla's dripping particles), all drawn as one
// instanced mesh (a single draw call, fixed-size typed-array pools, no
// per-frame allocation). Also watches entities for water entry (mobs / items
// / arrows splash too) and scans the neighbourhood for moving water (spray
// where falls plunge in), lava surfaces and drip spots.

import * as THREE from 'three';
import { B } from './Blocks';
import type { World } from './World';
import type { AudioEngine } from './Audio';

const MAX = 384;
const K_DROP = 0, K_BUBBLE = 1, K_RIPPLE = 2, K_LAVA = 3, K_DRIP_W = 4, K_DRIP_L = 5;
/** Resting height of the water surface inside its cell (matches the mesher + wave offset). */
const SURFACE = 8 / 9 - 0.045;
/** A drip hangs under its block this long (growing) before it lets go. */
const DRIP_HANG = 1.1;

const VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec3 iParam; // size, alpha, kind
varying vec2 vC;
varying float vA;
varying float vK;
void main() {
  vC = position.xy * 2.0;
  // fade out right at the lens so your own splash doesn't paste squares on it
  bool lying = iParam.z > 1.5 && iParam.z < 2.5;
  vA = iParam.y * (lying ? 1.0 : smoothstep(0.35, 1.3, distance(cameraPosition, iPos)));
  vK = iParam.z;
  vec3 wp;
  if (lying) {
    wp = iPos + vec3(position.x, 0.0, position.y) * iParam.x; // ripples lie on the surface
  } else {
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    wp = iPos + (right * position.x + up * position.y) * iParam.x;
  }
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;
const FRAG = /* glsl */ `
uniform vec3 uLight;
varying vec2 vC;
varying float vA;
varying float vK;
void main() {
  float r = length(vC);
  float a;
  vec3 col;
  if (vK < 0.5) {
    // droplet: a crisp pixel with a brighter core, like MC's splash particles
    vec2 q = abs(vC);
    if (max(q.x, q.y) > 1.0) discard;
    a = 0.9;
    col = mix(vec3(0.55, 0.72, 1.0), vec3(0.92, 0.97, 1.0), step(max(q.x, q.y), 0.5));
  } else if (vK < 1.5) {
    // bubble: clear body, bright rim and a highlight
    if (r > 1.0) discard;
    a = smoothstep(0.6, 0.88, r) * 0.85 + 0.12 + step(length(vC - vec2(-0.35, 0.35)), 0.22) * 0.6;
    col = vec3(0.85, 0.95, 1.0);
  } else if (vK < 2.5) {
    // ripple: a thin soft ring
    a = smoothstep(0.72, 0.88, r) * (1.0 - smoothstep(0.9, 1.0, r));
    if (a < 0.01) discard;
    col = vec3(0.9, 0.96, 1.0);
  } else {
    // pixel-square drips and embers; lava glows on its own
    vec2 q = abs(vC);
    if (max(q.x, q.y) > 1.0) discard;
    a = 1.0;
    float core = step(max(q.x, q.y), 0.5);
    if (vK < 3.95) {
      float life = fract(vK); // ember: yellow-hot, cooling to deep red
      col = mix(vec3(0.75, 0.12, 0.02), mix(vec3(1.0, 0.55, 0.1), vec3(1.0, 0.92, 0.5), core), life);
      gl_FragColor = vec4(col * 1.6, a * vA);
      #include <colorspace_fragment>
      return;
    } else if (vK < 4.5) {
      col = mix(vec3(0.25, 0.42, 0.95), vec3(0.6, 0.78, 1.0), core);
    } else {
      col = mix(vec3(0.95, 0.35, 0.05), vec3(1.0, 0.75, 0.3), core);
      gl_FragColor = vec4(col * 1.4, a * vA);
      #include <colorspace_fragment>
      return;
    }
  }
  gl_FragColor = vec4(col * uLight, a * vA);
  #include <colorspace_fragment>
}
`;

export class WaterFX {
  private mesh: THREE.Mesh | null = null;
  private geo: THREE.InstancedBufferGeometry | null = null;
  private mat: THREE.ShaderMaterial | null = null;
  private iPos = new Float32Array(MAX * 3);
  private iParam = new Float32Array(MAX * 3);
  private posAttr: THREE.InstancedBufferAttribute | null = null;
  private paramAttr: THREE.InstancedBufferAttribute | null = null;
  // simulation pools
  private px = new Float32Array(MAX); private py = new Float32Array(MAX); private pz = new Float32Array(MAX);
  private vx = new Float32Array(MAX); private vy = new Float32Array(MAX); private vz = new Float32Array(MAX);
  private life = new Float32Array(MAX); private maxLife = new Float32Array(MAX);
  private size0 = new Float32Array(MAX); private size1 = new Float32Array(MAX);
  private kind = new Uint8Array(MAX);
  private n = 0;
  private world: World | null = null;
  private audio: AudioEngine | null = null;
  // entity water-entry tracking (entity -> was in water)
  private wet = new WeakMap<object, boolean>();
  // ambience scan
  private scanT = 0;
  private falls: number[] = []; // flat x,y,z triples of waterfall plunge points
  private fallSprayT = 0;
  private lavaTops: number[] = []; // x,y,z of open lava surface cells nearby
  private dripSpots: number[] = []; // x,y,z,fluid of block undersides fluid seeps through
  private lavaAcc = 0;
  private dripAcc = 0;

  /** Hook into the scene once; the world/audio can be swapped any time. */
  attach(scene: THREE.Scene, world: World, audio: AudioEngine): void {
    this.world = world;
    this.audio = audio;
    this.n = 0;
    this.falls.length = 0;
    this.lavaTops.length = 0;
    this.dripSpots.length = 0;
    if (this.mesh) { scene.add(this.mesh); return; } // a new game's scene
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.posAttr = new THREE.InstancedBufferAttribute(this.iPos, 3);
    this.paramAttr = new THREE.InstancedBufferAttribute(this.iParam, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.paramAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', this.posAttr);
    g.setAttribute('iParam', this.paramAttr);
    g.instanceCount = 0;
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uLight: { value: new THREE.Color(1, 1, 1) } },
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);
  }

  private add(k: number, x: number, y: number, z: number, vx: number, vy: number, vz: number,
    life: number, s0: number, s1: number): void {
    if (this.n >= MAX) return;
    const i = this.n++;
    this.kind[i] = k;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.life[i] = this.maxLife[i] = life;
    this.size0[i] = s0; this.size1[i] = s1;
  }

  /** Height of the water surface above the water cell at (x, y, z), or NaN. */
  surfaceY(x: number, y: number, z: number): number {
    const w = this.world;
    if (!w) return NaN;
    let by = Math.floor(y);
    const bx = Math.floor(x), bz = Math.floor(z);
    if (w.getBlock(bx, by, bz) !== B.WATER) {
      if (w.getBlock(bx, by - 1, bz) !== B.WATER) return NaN;
      by--;
    }
    for (let i = 0; i < 6 && w.getBlock(bx, by + 1, bz) === B.WATER; i++) by++;
    return by + SURFACE;
  }

  /** Something hits the surface: `k` 0..1 scales droplets, rings and bubbles. */
  splash(x: number, y: number, z: number, k: number, width = 0.6): void {
    const sy = this.surfaceY(x, y, z);
    const s = Number.isNaN(sy) ? y : sy;
    const drops = Math.round(6 + 34 * k);
    for (let i = 0; i < drops; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * width * 0.6;
      const out = 0.6 + Math.random() * (1.2 + 2.2 * k);
      this.add(K_DROP, x + Math.cos(a) * r, s + 0.05, z + Math.sin(a) * r,
        Math.cos(a) * out, 2 + Math.random() * (2.5 + 5 * k), Math.sin(a) * out,
        0.6 + Math.random() * 0.6, 0.035 + Math.random() * 0.045, 0.03);
    }
    // concentric rings, the later ones wider
    const rings = 1 + Math.round(2 * k);
    for (let i = 0; i < rings; i++) {
      this.add(K_RIPPLE, x, s + 0.01, z, 0, 0, 0, 0.9 + i * 0.35 + k * 0.4, width * 0.8, width + 1.2 + i * 0.9 + k * 1.6);
    }
    const bub = Math.round(3 + 12 * k);
    for (let i = 0; i < bub; i++) {
      this.add(K_BUBBLE, x + (Math.random() - 0.5) * width, s - 0.3 - Math.random() * (0.4 + 1.2 * k), z + (Math.random() - 0.5) * width,
        0, 0.9 + Math.random() * 1.2, 0, 1.2 + Math.random() * 1.5, 0.07 + Math.random() * 0.07, 0.1);
    }
  }

  /** A gentle ring on the surface (wading, swimming). */
  ripple(x: number, y: number, z: number, size = 0.5): void {
    const sy = this.surfaceY(x, y, z);
    if (Number.isNaN(sy)) return;
    this.add(K_RIPPLE, x, sy + 0.01, z, 0, 0, 0, 0.9, size * 0.4, size * 2);
  }

  /** A few bubbles (breath, swimming under). */
  bubbles(x: number, y: number, z: number, n: number): void {
    for (let i = 0; i < n; i++) {
      this.add(K_BUBBLE, x + (Math.random() - 0.5) * 0.3, y + (Math.random() - 0.5) * 0.2, z + (Math.random() - 0.5) * 0.3,
        (Math.random() - 0.5) * 0.3, 0.8 + Math.random() * 0.8, (Math.random() - 0.5) * 0.3, 2 + Math.random(), 0.05 + Math.random() * 0.05, 0.08);
    }
  }

  /** Water streaming off a body that just climbed out. */
  drips(x: number, y: number, z: number, h: number, n: number): void {
    for (let i = 0; i < n; i++) {
      this.add(K_DROP, x + (Math.random() - 0.5) * 0.6, y + Math.random() * h, z + (Math.random() - 0.5) * 0.6,
        (Math.random() - 0.5) * 0.4, -Math.random() * 0.5, (Math.random() - 0.5) * 0.4, 0.8 + Math.random() * 0.6, 0.04, 0.04);
    }
  }

  /**
   * Per frame: simulate + upload particles, catch entities hitting the water,
   * and (twice a second) rescan nearby moving water for the ambience bed.
   */
  update(dt: number, world: World, cam: THREE.Vector3, light: number,
    ents: readonly { kind: string; pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number }; box: { w: number; h: number }; dead: boolean }[]): void {
    this.world = world;
    if (!this.mesh || !this.geo || !this.mat) return;
    this.trackEntities(world, cam, ents);
    this.scanT -= dt;
    if (this.scanT <= 0) { this.scanT = 0.5; this.scanAmbience(world, cam); }
    // waterfall spray: mist and droplets kicked up where falls plunge in
    this.fallSprayT -= dt;
    if (this.fallSprayT <= 0 && this.falls.length) {
      this.fallSprayT = 0.09;
      for (let i = 0; i < this.falls.length; i += 3) {
        const fx = this.falls[i] + 0.5, fy = this.falls[i + 1], fz = this.falls[i + 2] + 0.5;
        const a = Math.random() * Math.PI * 2;
        this.add(K_DROP, fx + Math.cos(a) * 0.5, fy - 0.1, fz + Math.sin(a) * 0.5,
          Math.cos(a) * (0.6 + Math.random()), 1.5 + Math.random() * 2.5, Math.sin(a) * (0.6 + Math.random()),
          0.5 + Math.random() * 0.4, 0.05 + Math.random() * 0.04, 0.05);
        if (Math.random() < 0.25) this.add(K_RIPPLE, fx, fy - 0.12, fz, 0, 0, 0, 1.1, 0.6, 1.8 + Math.random());
      }
    }
    // lava pops: vanilla flings an ember off each open lava cell about once
    // every 5 s (1/100 per tick)
    const nLava = this.lavaTops.length / 3;
    if (nLava) {
      this.lavaAcc += dt * nLava * 0.2;
      for (; this.lavaAcc >= 1; this.lavaAcc--) {
        const j = ((Math.random() * nLava) | 0) * 3;
        const a = Math.random() * Math.PI * 2, s = 0.3 + Math.random() * 0.9;
        this.add(K_LAVA, this.lavaTops[j] + 0.2 + Math.random() * 0.6, this.lavaTops[j + 1] + 0.95, this.lavaTops[j + 2] + 0.2 + Math.random() * 0.6,
          Math.cos(a) * s, 3 + Math.random() * 3.5, Math.sin(a) * s, 1.2 + Math.random() * 1.2, 0.09 + Math.random() * 0.05, 0.03);
      }
    }
    // drips under blocks with water/lava on top, each spot every ~3 s
    const nDrip = this.dripSpots.length / 4;
    if (nDrip) {
      this.dripAcc += dt * nDrip * 0.33;
      for (; this.dripAcc >= 1; this.dripAcc--) {
        const j = ((Math.random() * nDrip) | 0) * 4;
        const lava = this.dripSpots[j + 3] === 1;
        this.add(lava ? K_DRIP_L : K_DRIP_W, this.dripSpots[j] + 0.15 + Math.random() * 0.7, this.dripSpots[j + 1] - 0.02,
          this.dripSpots[j + 2] + 0.15 + Math.random() * 0.7, 0, 0, 0, DRIP_HANG + 3, 0.02, 0.07);
      }
    }

    const P = this.iPos, Q = this.iParam;
    let i = 0;
    while (i < this.n) {
      this.life[i] -= dt;
      let dead = this.life[i] <= 0;
      const k = this.kind[i];
      if (!dead && k === K_DROP) {
        this.vy[i] -= 16 * dt;
        this.px[i] += this.vx[i] * dt; this.py[i] += this.vy[i] * dt; this.pz[i] += this.vz[i] * dt;
        const id = world.getBlock(Math.floor(this.px[i]), Math.floor(this.py[i]), Math.floor(this.pz[i]));
        if (id === B.WATER && this.vy[i] < 0 && this.py[i] - Math.floor(this.py[i]) < SURFACE) dead = true;
        else if (id !== B.AIR && id !== B.WATER) dead = true;
      } else if (!dead && k === K_BUBBLE) {
        const t = this.life[i];
        this.px[i] += (this.vx[i] + Math.sin(t * 9 + i) * 0.25) * dt;
        this.py[i] += this.vy[i] * dt;
        this.pz[i] += (this.vz[i] + Math.cos(t * 7 + i) * 0.25) * dt;
        const bx = Math.floor(this.px[i]), by = Math.floor(this.py[i]), bz = Math.floor(this.pz[i]);
        const id = world.getBlock(bx, by, bz);
        const above = id === B.WATER && world.getBlock(bx, by + 1, bz) !== B.WATER && this.py[i] - by > SURFACE - 0.05;
        if (id !== B.WATER || above) {
          dead = true;
          // pop at the surface into a tiny ring
          if (id === B.WATER || world.getBlock(bx, by - 1, bz) === B.WATER) {
            const sy = id === B.WATER ? by + SURFACE : by - 1 + SURFACE;
            if (this.n < MAX - 8) this.add(K_RIPPLE, this.px[i], sy + 0.01, this.pz[i], 0, 0, 0, 0.5, 0.05, 0.35);
          }
        }
      } else if (!dead && k === K_LAVA) {
        this.vy[i] -= 12 * dt;
        this.px[i] += this.vx[i] * dt; this.py[i] += this.vy[i] * dt; this.pz[i] += this.vz[i] * dt;
        const id = world.getBlock(Math.floor(this.px[i]), Math.floor(this.py[i]), Math.floor(this.pz[i]));
        if (this.vy[i] < 0 && id !== B.AIR) dead = true; // lands back in the lava (or on rock)
      } else if (!dead && (k === K_DRIP_W || k === K_DRIP_L)) {
        const hung = this.maxLife[i] - this.life[i];
        if (hung > DRIP_HANG) {
          this.vy[i] -= 14 * dt;
          this.py[i] += this.vy[i] * dt;
          const bx = Math.floor(this.px[i]), by = Math.floor(this.py[i]), bz = Math.floor(this.pz[i]);
          const id = world.getBlock(bx, by, bz);
          if (id !== B.AIR) {
            dead = true;
            // landing: a ring on water, a couple of droplets/sparks on the ground
            if (id === B.WATER) { if (this.n < MAX - 4) this.add(K_RIPPLE, this.px[i], by + SURFACE + 0.01, this.pz[i], 0, 0, 0, 0.7, 0.05, 0.45); }
            else if (this.n < MAX - 4) {
              for (let s = 0; s < 2; s++) {
                this.add(k === K_DRIP_L ? K_LAVA : K_DROP, this.px[i], by + 1.02, this.pz[i], (Math.random() - 0.5) * 1.2, 1 + Math.random(), (Math.random() - 0.5) * 1.2,
                  0.3 + Math.random() * 0.2, 0.035, 0.02);
              }
            }
          }
        }
      }
      if (dead) {
        // swap-remove (the swapped-in particle is processed this iteration)
        const j = --this.n;
        if (i !== j) this.copy(j, i);
        continue;
      }
      const f = this.life[i] / this.maxLife[i]; // 1 -> 0
      let size = this.size1[i] + (this.size0[i] - this.size1[i]) * f;
      let alpha = k === K_RIPPLE ? f * f * 0.8 : k === K_BUBBLE ? Math.min(1, f * 3) : Math.min(1, f * 2.5);
      let kv: number = k;
      if (k === K_LAVA) kv = 3 + Math.min(0.9, f * 1.2); // life rides in the fraction
      else if (k === K_DRIP_W || k === K_DRIP_L) {
        // swells while it hangs, then a plain falling bead
        const hung = this.maxLife[i] - this.life[i];
        size = hung < DRIP_HANG ? 0.03 + 0.05 * (hung / DRIP_HANG) : 0.075;
        alpha = 1;
      }
      P[i * 3] = this.px[i]; P[i * 3 + 1] = this.py[i]; P[i * 3 + 2] = this.pz[i];
      Q[i * 3] = size; Q[i * 3 + 1] = alpha; Q[i * 3 + 2] = kv;
      i++;
    }
    this.geo.instanceCount = this.n;
    this.mesh.visible = this.n > 0;
    if (this.n > 0) {
      this.posAttr!.clearUpdateRanges(); this.posAttr!.addUpdateRange(0, this.n * 3); this.posAttr!.needsUpdate = true;
      this.paramAttr!.clearUpdateRanges(); this.paramAttr!.addUpdateRange(0, this.n * 3); this.paramAttr!.needsUpdate = true;
    }
    const l = 0.25 + 0.75 * light;
    (this.mat.uniforms.uLight.value as THREE.Color).setRGB(l, l, l);
  }

  private copy(from: number, to: number): void {
    this.kind[to] = this.kind[from];
    this.px[to] = this.px[from]; this.py[to] = this.py[from]; this.pz[to] = this.pz[from];
    this.vx[to] = this.vx[from]; this.vy[to] = this.vy[from]; this.vz[to] = this.vz[from];
    this.life[to] = this.life[from]; this.maxLife[to] = this.maxLife[from];
    this.size0[to] = this.size0[from]; this.size1[to] = this.size1[from];
  }

  /** Mobs, drops, arrows and TNT splash (and are heard) when they fall in. */
  private trackEntities(world: World, cam: THREE.Vector3,
    ents: readonly { kind: string; pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number }; box: { w: number; h: number }; dead: boolean }[]): void {
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (e.kind === 'particle' || e.dead) continue;
      const p = e.pos;
      const inW = world.getBlock(Math.floor(p.x), Math.floor(p.y + Math.min(0.3, e.box.h * 0.5)), Math.floor(p.z)) === B.WATER;
      const was = this.wet.get(e);
      this.wet.set(e, inW);
      if (was !== false || !inW) continue; // unknown (first sight) or not an entry
      const dx = p.x - cam.x, dy = p.y - cam.y, dz = p.z - cam.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > 48 * 48) continue;
      const heavy = e.kind !== 'drop' && e.kind !== 'arrow';
      const k = Math.min(1, Math.max(0, (-e.vel.y - 1) / 12)) * (heavy ? Math.min(1, 0.4 + e.box.w) : 0.35);
      this.splash(p.x, p.y + 0.3, p.z, k, Math.max(0.3, e.box.w));
      this.audio?.waterSplash(k * 0.8, Math.min(1, 14 / (8 + d2 * 0.25)));
    }
  }

  /** Count moving water near the listener (flowing surfaces, free-falling
   *  sheets), weighted by distance, for the ambience bed; remember where
   *  falls plunge in so they throw spray. */
  private scanAmbience(world: World, cam: THREE.Vector3): void {
    const cx = Math.floor(cam.x), cy = Math.floor(cam.y), cz = Math.floor(cam.z);
    const R = 10;
    let flow = 0, fall = 0;
    this.falls.length = 0;
    this.lavaTops.length = 0;
    this.dripSpots.length = 0;
    const W = B.WATER;
    for (let x = cx - R; x <= cx + R; x++) {
      for (let z = cz - R; z <= cz + R; z++) {
        const hd2 = (x - cx) * (x - cx) + (z - cz) * (z - cz);
        if (hd2 > R * R) continue;
        for (let y = cy - 7; y <= cy + 7; y++) {
          const id = world.getBlock(x, y, z);
          if (id !== W && id !== B.LAVA) continue;
          // fluid seeping through the block under it drips from its underside
          if (this.dripSpots.length < 24 * 4 && world.getBlock(x, y - 2, z) === B.AIR) {
            const under = world.getBlock(x, y - 1, z);
            if (under !== B.AIR && under !== W && under !== B.LAVA && world.isSolidAt(x, y - 1, z)) this.dripSpots.push(x, y - 1, z, id === B.LAVA ? 1 : 0);
          }
          if (id === B.LAVA) {
            if (this.lavaTops.length < 48 * 3 && world.getBlock(x, y + 1, z) === B.AIR) this.lavaTops.push(x, y, z);
            continue;
          }
          const d2 = hd2 + (y - cy) * (y - cy);
          const wgt = 1 / (1 + d2 / 25);
          const above = world.getBlock(x, y + 1, z) === W;
          if (!above) {
            // surface cell: flowing if it has a level
            if (world.waterLevels.has(`${x},${y},${z}`)) flow += wgt;
            continue;
          }
          // a column with open air beside it is a free-falling sheet
          const open = world.getBlock(x + 1, y, z) === B.AIR || world.getBlock(x - 1, y, z) === B.AIR ||
            world.getBlock(x, y, z + 1) === B.AIR || world.getBlock(x, y, z - 1) === B.AIR;
          if (!open) continue;
          fall += wgt;
          // bottom of the sheet: the cell below isn't part of it
          const bOpen = world.getBlock(x, y - 1, z) === W && !(world.getBlock(x + 1, y - 1, z) === B.AIR ||
            world.getBlock(x - 1, y - 1, z) === B.AIR || world.getBlock(x, y - 1, z + 1) === B.AIR ||
            world.getBlock(x, y - 1, z - 1) === B.AIR);
          if (bOpen && this.falls.length < 18) this.falls.push(x, y, z);
        }
      }
    }
    // the babble/roar is voiced by AudioScape's panned 'stream' bed (audio.listen);
    // voicing it here too doubled every river, so this scan only feeds the spray
    void flow;
  }
}

/** Shared instance: Player and main both talk to it. */
export const waterFX = new WaterFX();
