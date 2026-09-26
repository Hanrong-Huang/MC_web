// Nether particles in one instanced draw: drifting crimson spores, rising
// warped spores, soul-valley ash and floating soul wisps, basalt-delta white
// ash, wastes embers, sparks spat from the lava sea, portal motes pulled into
// the sheet, blue soul-torch flames and one-off bursts (anchor charging,
// portal travel, fire charges). Fixed typed-array pools, no per-frame
// allocation; colours are authored in sRGB and blended premultiplied, so
// glows add and ash flakes cover in the same pass.

import * as THREE from 'three';
import { B, SOUL_LIGHTS, registryId } from './Blocks';
import { CX, CZ } from './Chunk';
import type { NetherWeights } from './NetherAtmosphere';
import type { PortalCell } from './PortalFX';

const MAX = 1400;
/** particle shapes */
const K_MOTE = 0, K_FLAKE = 1, K_WISP = 2, K_SPARK = 3;

const VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iCol;   // sRGB colour + alpha
attribute vec4 iParam; // size, kind, additive, spin
uniform vec2 uFog;
varying vec2 vC;
varying vec4 vCol;
varying float vK;
varying float vAdd;
void main() {
  vC = position.xy * 2.0;
  vK = iParam.y;
  vAdd = iParam.z;
  float d = distance(cameraPosition, iPos);
  // fade at the lens and into the haze
  vCol = vec4(iCol.rgb, iCol.a * smoothstep(0.25, 0.9, d) * (1.0 - smoothstep(uFog.x, uFog.y, d)));
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  float s = sin(iParam.w), c = cos(iParam.w);
  vec2 q = vec2(c * position.x - s * position.y, s * position.x + c * position.y);
  if (iParam.y > 1.5 && iParam.y < 2.5) q = position.xy * vec2(0.8, 1.35); // wisps stand upright
  vec3 wp = iPos + (right * q.x + up * q.y) * iParam.x;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;
const FRAG = /* glsl */ `
uniform float uLight;
varying vec2 vC;
varying vec4 vCol;
varying float vK;
varying float vAdd;
void main() {
  float a;
  vec3 col = vCol.rgb;
  float r = length(vC);
  if (vK < 0.5) {
    // mote: a soft glowing dot with a hot core
    a = smoothstep(1.0, 0.15, r);
    col = mix(col, vec3(1.0), smoothstep(0.35, 0.0, r) * 0.45);
  } else if (vK < 1.5) {
    // flake: a crisp square pixel, lit by the ambient light
    vec2 q = abs(vC);
    if (max(q.x, q.y) > 0.8) discard;
    a = 0.95;
    col *= uLight * (max(q.x, q.y) < 0.4 ? 1.1 : 0.9);
  } else if (vK < 2.5) {
    // wisp: a teardrop flame, bright core, cold rim
    vec2 q = vec2(vC.x * (1.25 + max(0.0, vC.y) * 0.9), vC.y);
    float rr = length(q);
    a = smoothstep(1.0, 0.25, rr);
    col = mix(col, vec3(0.92, 1.0, 1.0), smoothstep(0.55, 0.0, length(q + vec2(0.0, 0.3))) * 0.7);
  } else {
    // spark: a bright pixel with a small halo
    vec2 q = abs(vC);
    float m = max(q.x, q.y);
    a = m < 0.45 ? 1.0 : smoothstep(1.0, 0.45, r) * 0.45;
    col = mix(col, vec3(1.0, 0.97, 0.8), step(m, 0.3) * 0.6);
  }
  a *= vCol.a;
  if (a < 0.01) discard;
  gl_FragColor = vec4(col * a, a * (1.0 - vAdd));
}
`;

type RGB = [number, number, number];
const hex = (c: number): RGB => [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];

interface Spawn {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number; size: number; kind: number; col: RGB; alpha?: number; add?: boolean;
  grav?: number; drag?: number; swirl?: number; spin?: number; shrink?: boolean; flicker?: boolean;
}

const CRIMSON_SPORE: RGB[] = [hex(0xff5a3a), hex(0xd8321e), hex(0xff8a5a)];
const WARPED_SPORE: RGB[] = [hex(0x3ff0d8), hex(0x7dfcff), hex(0x21b8a8)];
const SOUL_ASH: RGB[] = [hex(0x8e969e), hex(0x6d747c), hex(0xa8aeb4)];
const BASALT_ASH: RGB[] = [hex(0xf0eeea), hex(0xd2d0cc), hex(0xffffff)];
const EMBER: RGB[] = [hex(0xffb24a), hex(0xff7a22), hex(0xffd27a)];
const PORTAL: RGB[] = [hex(0xb25cff), hex(0x7a2cd8), hex(0xe0a8ff)];
const SOUL_FIRE: RGB[] = [hex(0x5fe8ff), hex(0x33c4f0), hex(0x9ff6ff)];

const pick = <T>(a: T[]): T => a[(Math.random() * a.length) | 0];
const rnd = (a: number, b: number): number => a + Math.random() * (b - a);

interface FXWorld {
  getBlock(x: number, y: number, z: number): number;
  getChunk(cx: number, cz: number): { cx: number; cz: number; ready: boolean; data: Uint16Array; glowers: Set<number> } | undefined;
}

export class NetherFX {
  private mesh: THREE.Mesh | null = null;
  private mat: THREE.ShaderMaterial | null = null;
  private geo: THREE.InstancedBufferGeometry | null = null;
  private iPos = new Float32Array(MAX * 3);
  private iCol = new Float32Array(MAX * 4);
  private iParam = new Float32Array(MAX * 4);
  private aPos: THREE.InstancedBufferAttribute | null = null;
  private aCol: THREE.InstancedBufferAttribute | null = null;
  private aParam: THREE.InstancedBufferAttribute | null = null;
  // simulation pools
  private px = new Float32Array(MAX); private py = new Float32Array(MAX); private pz = new Float32Array(MAX);
  private vx = new Float32Array(MAX); private vy = new Float32Array(MAX); private vz = new Float32Array(MAX);
  private life = new Float32Array(MAX); private maxLife = new Float32Array(MAX);
  private size = new Float32Array(MAX); private kind = new Uint8Array(MAX);
  private cr = new Float32Array(MAX); private cg = new Float32Array(MAX); private cb = new Float32Array(MAX);
  private ca = new Float32Array(MAX); private add = new Uint8Array(MAX);
  private grav = new Float32Array(MAX); private drag = new Float32Array(MAX);
  private swirl = new Float32Array(MAX); private phase = new Float32Array(MAX);
  private spin = new Float32Array(MAX); private rot = new Float32Array(MAX);
  private flags = new Uint8Array(MAX); // 1 shrink, 2 flicker
  private n = 0;
  private frame = 0;
  private acc = { crimson: 0, warped: 0, ash: 0, basalt: 0, ember: 0, wisp: 0, lava: 0, portal: 0, soul: 0 };
  private soulScanT = 0;
  private soulSpots: number[] = []; // flat x,y,z of soul lights near the camera
  private ids: { soilA: number; soilB: number } | null = null;

  attach(scene: THREE.Scene): void {
    this.n = 0;
    if (this.mesh) { scene.add(this.mesh); return; }
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.aPos = new THREE.InstancedBufferAttribute(this.iPos, 3);
    this.aCol = new THREE.InstancedBufferAttribute(this.iCol, 4);
    this.aParam = new THREE.InstancedBufferAttribute(this.iParam, 4);
    for (const a of [this.aPos, this.aCol, this.aParam]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', this.aPos);
    g.setAttribute('iCol', this.aCol);
    g.setAttribute('iParam', this.aParam);
    g.instanceCount = 0;
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uLight: { value: 1 }, uFog: { value: new THREE.Vector2(20, 40) } },
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    scene.add(this.mesh);
  }

  clear(): void { this.n = 0; this.soulSpots.length = 0; }

  private spawn(s: Spawn): void {
    if (this.n >= MAX) return;
    const i = this.n++;
    this.px[i] = s.x; this.py[i] = s.y; this.pz[i] = s.z;
    this.vx[i] = s.vx; this.vy[i] = s.vy; this.vz[i] = s.vz;
    this.life[i] = this.maxLife[i] = s.life;
    this.size[i] = s.size; this.kind[i] = s.kind;
    this.cr[i] = s.col[0]; this.cg[i] = s.col[1]; this.cb[i] = s.col[2];
    this.ca[i] = s.alpha ?? 1; this.add[i] = s.add ? 1 : 0;
    this.grav[i] = s.grav ?? 0; this.drag[i] = s.drag ?? 0;
    this.swirl[i] = s.swirl ?? 0; this.phase[i] = Math.random() * 6.28;
    this.spin[i] = s.spin ?? 0; this.rot[i] = Math.random() * 6.28;
    this.flags[i] = (s.shrink ? 1 : 0) | (s.flicker ? 2 : 0);
  }

  // --- public bursts ------------------------------------------------------------

  /** Purple motes swirling out (portal travel, anchor charge). */
  portalBurst(x: number, y: number, z: number, n: number, spread = 1): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.28, sp = rnd(0.5, 2.2) * spread;
      this.spawn({
        x: x + rnd(-0.3, 0.3), y: y + rnd(-0.4, 0.8), z: z + rnd(-0.3, 0.3),
        vx: Math.cos(a) * sp, vy: rnd(-0.3, 1.8), vz: Math.sin(a) * sp,
        life: rnd(0.6, 1.4), size: rnd(0.07, 0.14), kind: K_MOTE, col: pick(PORTAL), add: true, drag: 1.6, swirl: 1.2, shrink: true,
      });
    }
  }

  /** A fire-charge / fireball trail puff and impact sparks. */
  fireBurst(x: number, y: number, z: number, n: number): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.28, sp = rnd(1, 4);
      this.spawn({
        x, y, z, vx: Math.cos(a) * sp, vy: rnd(0.5, 4), vz: Math.sin(a) * sp,
        life: rnd(0.3, 0.8), size: rnd(0.05, 0.1), kind: K_SPARK, col: pick(EMBER), add: true, grav: 9, drag: 0.8, shrink: true,
      });
    }
  }

  /** One soft ember left behind by a flying fire charge. */
  fireTrail(x: number, y: number, z: number): void {
    this.spawn({
      x: x + rnd(-0.1, 0.1), y: y + rnd(-0.1, 0.1), z: z + rnd(-0.1, 0.1), vx: rnd(-0.2, 0.2), vy: rnd(0.2, 0.7), vz: rnd(-0.2, 0.2),
      life: rnd(0.3, 0.6), size: rnd(0.12, 0.2), kind: K_MOTE, col: pick(EMBER), add: true, shrink: true,
    });
  }

  /** Blue soul-flame lick rising from a soul torch / lantern / soul fire. */
  soulFlame(x: number, y: number, z: number): void {
    this.spawn({
      x: x + rnd(-0.06, 0.06), y, z: z + rnd(-0.06, 0.06), vx: rnd(-0.05, 0.05), vy: rnd(0.25, 0.55), vz: rnd(-0.05, 0.05),
      life: rnd(0.4, 0.8), size: rnd(0.05, 0.08), kind: K_SPARK, col: pick(SOUL_FIRE), add: true, shrink: true,
    });
  }

  // --- per frame ------------------------------------------------------------------

  /**
   * Advance + emit. `w` are the Nether biome weights (null in the Overworld,
   * where only portal motes and soul flames appear).
   */
  update(dt: number, world: FXWorld, cam: THREE.Vector3, w: NetherWeights | null, portals: readonly PortalCell[],
    light: number, fogNear: number, fogFar: number): void {
    if (!this.mesh || !this.mat || !this.geo) return;
    dt = Math.min(dt, 0.1);
    this.frame++;
    this.mat.uniforms.uLight.value = light;
    (this.mat.uniforms.uFog.value as THREE.Vector2).set(Math.max(8, fogNear), Math.max(fogNear + 8, fogFar));
    if (w) this.emitAmbient(dt, world, cam, w);
    this.emitPortals(dt, cam, portals);
    this.emitSoulLights(dt, world, cam);
    this.simulate(dt, world);
    this.upload();
  }

  private emitAmbient(dt: number, world: FXWorld, cam: THREE.Vector3, w: NetherWeights): void {
    const R = 15;
    const air = (x: number, y: number, z: number): boolean => {
      const id = world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z));
      return id === B.AIR;
    };
    const around = (): [number, number, number] => [cam.x + rnd(-R, R), cam.y + rnd(-6, 9), cam.z + rnd(-R, R)];
    const a = this.acc;
    // crimson forest: spores drift down lazily, tumbling
    a.crimson += dt * 70 * w.crimson;
    for (; a.crimson >= 1; a.crimson--) {
      const [x, y, z] = around();
      if (!air(x, y, z)) continue;
      this.spawn({ x, y, z, vx: rnd(-0.25, 0.25), vy: rnd(-0.45, -0.1), vz: rnd(-0.25, 0.25), life: rnd(4, 8), size: rnd(0.035, 0.06),
        kind: K_MOTE, col: pick(CRIMSON_SPORE), add: true, alpha: 0.9, swirl: 0.35 });
    }
    // warped forest: spores float upward and wander
    a.warped += dt * 70 * w.warped;
    for (; a.warped >= 1; a.warped--) {
      const [x, y, z] = around();
      if (!air(x, y, z)) continue;
      this.spawn({ x, y, z, vx: rnd(-0.2, 0.2), vy: rnd(0.08, 0.35), vz: rnd(-0.2, 0.2), life: rnd(4, 8), size: rnd(0.035, 0.06),
        kind: K_MOTE, col: pick(WARPED_SPORE), add: true, alpha: 0.9, swirl: 0.5 });
    }
    // soul sand valley: grey ash sifting down
    a.ash += dt * 45 * w.soul;
    for (; a.ash >= 1; a.ash--) {
      const [x, y, z] = around();
      if (!air(x, y, z)) continue;
      this.spawn({ x, y, z, vx: rnd(0.2, 0.6), vy: rnd(-0.6, -0.25), vz: rnd(-0.2, 0.2), life: rnd(5, 9), size: rnd(0.045, 0.075),
        kind: K_FLAKE, col: pick(SOUL_ASH), alpha: 0.85, swirl: 0.6, spin: rnd(-2, 2) });
    }
    // ...and pale soul wisps rising off the sand
    a.wisp += dt * 3.5 * w.soul;
    for (; a.wisp >= 1; a.wisp--) {
      const g = this.groundNear(world, cam, 12);
      if (!g) continue;
      const [x, y, z, id] = g;
      if (!this.isSoulGround(id)) continue;
      this.spawn({ x: x + rnd(0.2, 0.8), y: y + 0.1, z: z + rnd(0.2, 0.8), vx: rnd(-0.08, 0.08), vy: rnd(0.35, 0.7), vz: rnd(-0.08, 0.08),
        life: rnd(1.6, 3), size: rnd(0.22, 0.34), kind: K_WISP, col: pick(SOUL_FIRE), add: true, alpha: 0.55, swirl: 0.25, flicker: true });
    }
    // basalt deltas: thick white ash swirling in the wind
    a.basalt += dt * 120 * w.basalt;
    for (; a.basalt >= 1; a.basalt--) {
      const [x, y, z] = around();
      if (!air(x, y, z)) continue;
      this.spawn({ x, y, z, vx: rnd(-0.9, -0.2), vy: rnd(-0.5, -0.1), vz: rnd(-0.3, 0.5), life: rnd(4, 7), size: rnd(0.04, 0.07),
        kind: K_FLAKE, col: pick(BASALT_ASH), alpha: 0.9, swirl: 1.1, spin: rnd(-3, 3) });
    }
    // nether wastes: embers riding the heat
    a.ember += dt * 14 * (w.wastes + 0.25 * w.crimson + 0.2 * w.basalt);
    for (; a.ember >= 1; a.ember--) {
      const [x, y, z] = around();
      if (!air(x, y, z)) continue;
      this.spawn({ x, y, z, vx: rnd(-0.2, 0.2), vy: rnd(0.4, 0.9), vz: rnd(-0.2, 0.2), life: rnd(1.5, 3), size: rnd(0.04, 0.07),
        kind: K_SPARK, col: pick(EMBER), add: true, swirl: 0.4, shrink: true, flicker: true });
    }
    // the lava sea spits sparks now and then
    a.lava += dt * 5;
    for (; a.lava >= 1; a.lava--) {
      const lx = Math.floor(cam.x + rnd(-20, 20)), lz = Math.floor(cam.z + rnd(-20, 20));
      let ly = -1;
      for (let y = Math.min(60, Math.floor(cam.y) + 4); y >= 20; y--) {
        const id = world.getBlock(lx, y, lz);
        if (id === B.LAVA) { if (world.getBlock(lx, y + 1, lz) === B.AIR) ly = y; break; }
        if (id !== B.AIR) break;
      }
      if (ly < 0) continue;
      const n = 3 + ((Math.random() * 4) | 0);
      for (let i = 0; i < n; i++) {
        const an = Math.random() * 6.28, sp = rnd(0.4, 1.6);
        this.spawn({ x: lx + 0.5, y: ly + 0.95, z: lz + 0.5, vx: Math.cos(an) * sp, vy: rnd(2.5, 5), vz: Math.sin(an) * sp,
          life: rnd(0.8, 1.6), size: rnd(0.06, 0.1), kind: K_SPARK, col: pick(EMBER), add: true, grav: 7, shrink: true });
      }
    }
  }

  /** Motes drawn into nearby portal sheets. */
  private emitPortals(dt: number, cam: THREE.Vector3, portals: readonly PortalCell[]): void {
    if (portals.length === 0) return;
    let near = 0;
    for (const c of portals) if (Math.abs(c.x - cam.x) < 20 && Math.abs(c.z - cam.z) < 20) near++;
    if (!near) return;
    this.acc.portal += dt * Math.min(60, near * 2.2);
    for (; this.acc.portal >= 1; this.acc.portal--) {
      const c = portals[(Math.random() * portals.length) | 0];
      if (Math.abs(c.x - cam.x) > 20 || Math.abs(c.z - cam.z) > 20) continue;
      const side = Math.random() < 0.5 ? -1 : 1, off = rnd(0.4, 1.3) * side;
      const ox = c.axis === 'z' ? off : 0, oz = c.axis === 'x' ? off : 0;
      const t = rnd(0.9, 1.6);
      // start off to one side and glide into the sheet (vanilla portal particles)
      this.spawn({ x: c.x + 0.5 + ox + (c.axis === 'x' ? rnd(-0.5, 0.5) : 0), y: c.y + rnd(0, 1), z: c.z + 0.5 + oz + (c.axis === 'z' ? rnd(-0.5, 0.5) : 0),
        vx: -ox / t, vy: rnd(-0.4, 0.4), vz: -oz / t, life: t, size: rnd(0.05, 0.1), kind: K_MOTE, col: pick(PORTAL), add: true, alpha: 0.95, shrink: true });
    }
  }

  /** Blue flames licking off soul torches and lanterns in view. */
  private emitSoulLights(dt: number, world: FXWorld, cam: THREE.Vector3): void {
    this.soulScanT -= dt;
    if (this.soulScanT <= 0) {
      this.soulScanT = 0.6;
      this.soulSpots.length = 0;
      const pcx = Math.floor(cam.x / CX), pcz = Math.floor(cam.z / CZ);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const c = world.getChunk(pcx + dx, pcz + dz);
          if (!c || !c.ready) continue;
          for (const idx of c.glowers) {
            const id = c.data[idx];
            if (!SOUL_LIGHTS.has(id)) continue;
            if (this.soulSpots.length > 180) break;
            this.soulSpots.push(c.cx * CX + (idx & 15), idx >> 8, c.cz * CZ + ((idx >> 4) & 15), id);
          }
        }
      }
    }
    const n = this.soulSpots.length / 4;
    if (!n) return;
    this.acc.soul += dt * Math.min(40, n * 2.5);
    for (; this.acc.soul >= 1; this.acc.soul--) {
      const i = ((Math.random() * n) | 0) * 4;
      const [x, y, z, id] = [this.soulSpots[i], this.soulSpots[i + 1], this.soulSpots[i + 2], this.soulSpots[i + 3]];
      if (id === B.SOUL_TORCH) {
        // wall torches lean out from their wall; the flame sits roughly at the tip
        this.soulFlame(x + 0.5, y + 0.66, z + 0.5);
      } else {
        this.soulFlame(x + 0.5, y + 0.45, z + 0.5);
      }
    }
  }

  private isSoulGround(id: number): boolean {
    if (!this.ids) this.ids = { soilA: B.SOUL_SAND, soilB: registryId('soul_soil', B.SOUL_SAND) };
    return id === this.ids.soilA || id === this.ids.soilB;
  }

  /** A random ground cell (solid with air above) near the camera, or null. */
  private groundNear(world: FXWorld, cam: THREE.Vector3, r: number): [number, number, number, number] | null {
    const x = Math.floor(cam.x + rnd(-r, r)), z = Math.floor(cam.z + rnd(-r, r));
    for (let y = Math.floor(cam.y) + 5; y > cam.y - 10; y--) {
      const id = world.getBlock(x, y, z);
      if (id !== B.AIR && world.getBlock(x, y + 1, z) === B.AIR) return [x, y + 1, z, id];
    }
    return null;
  }

  private simulate(dt: number, world: FXWorld): void {
    let i = 0;
    const t = this.frame * 0.016;
    while (i < this.n) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.kill(i); continue; }
      const sw = this.swirl[i];
      if (sw > 0) {
        const ph = this.phase[i];
        this.vx[i] += Math.sin(t * 1.3 + ph) * sw * dt;
        this.vz[i] += Math.cos(t * 1.1 + ph * 1.7) * sw * dt;
      }
      this.vy[i] -= this.grav[i] * dt;
      const dr = this.drag[i];
      if (dr > 0) { const k = Math.max(0, 1 - dr * dt); this.vx[i] *= k; this.vy[i] *= k; this.vz[i] *= k; }
      this.px[i] += this.vx[i] * dt; this.py[i] += this.vy[i] * dt; this.pz[i] += this.vz[i] * dt;
      this.rot[i] += this.spin[i] * dt;
      // settle out when drifting into rock (staggered: a quarter of them a frame)
      if (((i + this.frame) & 3) === 0) {
        const id = world.getBlock(Math.floor(this.px[i]), Math.floor(this.py[i]), Math.floor(this.pz[i]));
        if (id !== B.AIR && id !== B.PORTAL && id !== B.LAVA && id !== B.FIRE && !SOUL_LIGHTS.has(id) && id !== B.TORCH) { this.kill(i); continue; }
      }
      i++;
    }
  }

  private kill(i: number): void {
    const j = --this.n;
    if (i === j) return;
    this.px[i] = this.px[j]; this.py[i] = this.py[j]; this.pz[i] = this.pz[j];
    this.vx[i] = this.vx[j]; this.vy[i] = this.vy[j]; this.vz[i] = this.vz[j];
    this.life[i] = this.life[j]; this.maxLife[i] = this.maxLife[j];
    this.size[i] = this.size[j]; this.kind[i] = this.kind[j];
    this.cr[i] = this.cr[j]; this.cg[i] = this.cg[j]; this.cb[i] = this.cb[j];
    this.ca[i] = this.ca[j]; this.add[i] = this.add[j];
    this.grav[i] = this.grav[j]; this.drag[i] = this.drag[j];
    this.swirl[i] = this.swirl[j]; this.phase[i] = this.phase[j];
    this.spin[i] = this.spin[j]; this.rot[i] = this.rot[j]; this.flags[i] = this.flags[j];
  }

  private upload(): void {
    const n = this.n;
    const t = this.frame;
    for (let i = 0; i < n; i++) {
      const age = this.maxLife[i] - this.life[i];
      let a = this.ca[i] * Math.min(1, age / 0.35) * Math.min(1, this.life[i] / 0.7);
      let s = this.size[i];
      const f = this.flags[i];
      if (f & 1) s *= 0.35 + 0.65 * (this.life[i] / this.maxLife[i]);
      if (f & 2) a *= 0.7 + 0.3 * Math.sin(t * 0.9 + this.phase[i] * 7);
      this.iPos[i * 3] = this.px[i]; this.iPos[i * 3 + 1] = this.py[i]; this.iPos[i * 3 + 2] = this.pz[i];
      this.iCol[i * 4] = this.cr[i]; this.iCol[i * 4 + 1] = this.cg[i]; this.iCol[i * 4 + 2] = this.cb[i]; this.iCol[i * 4 + 3] = a;
      this.iParam[i * 4] = s; this.iParam[i * 4 + 1] = this.kind[i]; this.iParam[i * 4 + 2] = this.add[i]; this.iParam[i * 4 + 3] = this.rot[i];
    }
    this.geo!.instanceCount = n;
    if (n > 0) {
      for (const [attr, k] of [[this.aPos!, 3], [this.aCol!, 4], [this.aParam!, 4]] as [THREE.InstancedBufferAttribute, number][]) {
        attr.clearUpdateRanges();
        attr.addUpdateRange(0, n * k);
        attr.needsUpdate = true;
      }
    }
  }

  /** Live particle count (harness/debug). */
  get count(): number { return this.n; }
}

export const netherFX = new NetherFX();
