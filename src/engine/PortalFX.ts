// Nether portal sheets: the chunk mesher skips portal blocks and they are drawn
// here instead as thin two-faced panes with an animated, pixel-snapped purple
// swirl (domain-warped noise + drifting streaks + twinkles), self-lit and
// fogged like everything else. Portal cells are found cheaply from each
// chunk's glower index (portal blocks emit light), so the scan is a walk over
// a few small sets a few times a second; the mesh is rebuilt only when the
// set of nearby portal cells changes.

import * as THREE from 'three';
import { B } from './Blocks';
import { CX, CZ } from './Chunk';
import { portalAxisAt, PortalAxis } from './NetherPortal';

interface PortalWorldView {
  getChunk(cx: number, cz: number): { cx: number; cz: number; ready: boolean; data: Uint8Array; glowers: Set<number> } | undefined;
  getBlock(x: number, y: number, z: number): number;
}

/** One portal cell near the player. */
export interface PortalCell { x: number; y: number; z: number; axis: PortalAxis }

const VERT = /* glsl */ `
attribute float aAxis;
varying vec3 vW;
varying float vAxis;
#include <fog_pars_vertex>
void main() {
  vW = position;
  vAxis = aAxis;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
uniform float uTime;
varying vec3 vW;
varying float vAxis;
#include <fog_pars_fragment>
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) { return vnoise(p) * 0.55 + vnoise(p * 2.03 + 7.1) * 0.3 + vnoise(p * 4.1 - 3.3) * 0.15; }
void main() {
  // sheet coordinates, snapped to the 16px block grid like every other texture
  vec2 p = mix(vW.xy, vW.zy, vAxis);
  vec2 q = (floor(p * 16.0) + 0.5) / 16.0;
  float t = uTime;
  vec2 w = vec2(fbm(q * 0.9 + vec2(0.0, t * 0.32)), fbm(q * 0.9 + vec2(5.2, -t * 0.27)));
  float n = fbm(q * 1.4 + w * 2.4 + vec2(t * 0.1, -t * 0.18));
  // the vanilla sheet's swirling streaks, bent by the warp and flowing upward
  float band = 0.5 + 0.5 * sin(q.x * 2.1 - q.y * 1.3 + n * 7.0 + t * 1.7);
  float v = clamp(n * 0.7 + band * 0.42 - 0.08, 0.0, 1.0);
  vec3 deep = vec3(0.10, 0.012, 0.26);
  vec3 mid = vec3(0.34, 0.05, 0.72);
  vec3 hi = vec3(0.78, 0.42, 1.0);
  vec3 col = mix(deep, mid, smoothstep(0.18, 0.55, v));
  col = mix(col, hi, smoothstep(0.62, 0.95, v));
  // stray twinkles drifting through
  float tw = step(0.975, hash(floor(q * 16.0) + floor(t * 3.0 + hash(floor(q * 16.0)) * 3.0)));
  col += tw * vec3(0.55, 0.42, 0.75);
  gl_FragColor = vec4(col, 0.72 + 0.24 * v);
  #include <fog_fragment>
  #include <colorspace_fragment>
}
`;

const RADIUS = 3; // chunks scanned around the camera

export class PortalFX {
  cells: PortalCell[] = [];
  private mesh: THREE.Mesh | null = null;
  private mat: THREE.ShaderMaterial;
  private sig = '';
  private scanT = 0;
  private scene: THREE.Scene | null = null;

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 } }]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
    });
  }

  attach(scene: THREE.Scene): void {
    this.scene = scene;
    this.sig = '';
    this.cells = [];
    if (this.mesh) { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.mesh = null; }
  }

  /** Forget everything (dimension switch); the next update rescans. */
  reset(): void {
    this.sig = '';
    this.scanT = 0;
    this.cells = [];
    if (this.mesh) { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.mesh = null; }
  }

  /** Force a rescan on the next frame (a portal was lit or broken). */
  dirty(): void { this.scanT = 0; }

  update(dt: number, world: PortalWorldView, cx: number, cz: number, time: number): void {
    this.mat.uniforms.uTime.value = time;
    this.scanT -= dt;
    if (this.scanT > 0) return;
    this.scanT = 0.3;
    const pcx = Math.floor(cx / CX), pcz = Math.floor(cz / CZ);
    const found: PortalCell[] = [];
    const keys: number[] = [];
    for (let dz = -RADIUS; dz <= RADIUS; dz++) {
      for (let dx = -RADIUS; dx <= RADIUS; dx++) {
        const c = world.getChunk(pcx + dx, pcz + dz);
        if (!c || !c.ready || c.glowers.size === 0) continue;
        for (const idx of c.glowers) {
          if (c.data[idx] !== B.PORTAL) continue;
          const x = c.cx * CX + (idx & 15), z = c.cz * CZ + ((idx >> 4) & 15), y = idx >> 8;
          found.push({ x, y, z, axis: 'x' });
          keys.push(x * 73856093 ^ y * 19349663 ^ z * 83492791);
        }
      }
    }
    const sig = `${found.length}:${keys.reduce((s, k) => (s + k) | 0, 0)}`;
    if (sig === this.sig) return;
    this.sig = sig;
    const get = (x: number, y: number, z: number): number => world.getBlock(x, y, z);
    for (const c of found) c.axis = portalAxisAt(get, c.x, c.y, c.z);
    this.cells = found;
    this.rebuild();
  }

  private rebuild(): void {
    if (this.mesh) { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.mesh = null; }
    if (!this.scene || this.cells.length === 0) return;
    const pos: number[] = [], axis: number[] = [], idx: number[] = [];
    const T = 2 / 16; // the sheet is 4px thick, like vanilla's
    for (const c of this.cells) {
      const ax = c.axis === 'x';
      for (const off of [-T, T]) {
        const base = pos.length / 3;
        if (ax) {
          const z = c.z + 0.5 + off;
          pos.push(c.x, c.y, z, c.x + 1, c.y, z, c.x + 1, c.y + 1, z, c.x, c.y + 1, z);
        } else {
          const x = c.x + 0.5 + off;
          pos.push(x, c.y, c.z, x, c.y, c.z + 1, x, c.y + 1, c.z + 1, x, c.y + 1, c.z);
        }
        for (let i = 0; i < 4; i++) axis.push(ax ? 0 : 1);
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aAxis', new THREE.Float32BufferAttribute(axis, 1));
    g.setIndex(idx);
    g.computeBoundingSphere();
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.renderOrder = 3;
    this.scene.add(this.mesh);
  }

  /** Nearest portal cell to a point (for the hum and the compass), or null. */
  nearest(x: number, y: number, z: number): { cell: PortalCell; dist: number } | null {
    let best: PortalCell | null = null, bd = Infinity;
    for (const c of this.cells) {
      const d = (c.x + 0.5 - x) ** 2 + (c.y + 0.5 - y) ** 2 + (c.z + 0.5 - z) ** 2;
      if (d < bd) { bd = d; best = c; }
    }
    return best ? { cell: best, dist: Math.sqrt(bd) } : null;
  }
}

export const portalFX = new PortalFX();
