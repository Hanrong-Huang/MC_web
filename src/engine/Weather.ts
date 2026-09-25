// Weather: a rain/snow particle field that follows the camera, a state machine
// (clear -> overcast -> rain -> thunder -> clear), and lightning strikes that
// flash the sky, ignite exposed TNT, and damage surface mobs/players.
// Snow falls in cold biomes, rain elsewhere; both are pure cosmetics except
// thunder, which interacts with the world via a strike callback.

import * as THREE from 'three';
import { World } from './World';
import { B } from './Blocks';

export type WeatherKind = 'clear' | 'rain' | 'thunder';

export interface WeatherHooks {
  /** called when a lightning bolt strikes the given world position */
  onStrike: (x: number, y: number, z: number) => void;
  /** biome check: true = cold (snow), false = temperate (rain) */
  isColdAt: (x: number, z: number) => boolean;
}

const MAX_DROPS = 1400;
const SPAN = 70;

/** Ground height (top of the highest light-blocking block) for columns
 *  around the camera, refreshed as the camera moves, so drops stop at roofs,
 *  tree canopies and overhangs instead of falling through them indoors. */
class RoofGrid {
  private h = new Int16Array(SPAN * SPAN);
  private ox = 1e9;
  private oz = 1e9;
  private age = 99;

  refresh(world: World, cx: number, cz: number, dt: number): void {
    this.age += dt;
    const nx = Math.floor(cx) - SPAN / 2, nz = Math.floor(cz) - SPAN / 2;
    if (this.age < 1 && Math.abs(nx - this.ox) < 4 && Math.abs(nz - this.oz) < 4) return;
    this.age = 0; this.ox = nx; this.oz = nz;
    for (let z = 0; z < SPAN; z++) {
      for (let x = 0; x < SPAN; x++) {
        const wx = nx + x, wz = nz + z;
        const c = world.getChunk(Math.floor(wx / 16), Math.floor(wz / 16));
        this.h[z * SPAN + x] = c && c.ready ? c.heightmap[(wz & 15) * 16 + (wx & 15)] : -999;
      }
    }
  }

  /** Height a drop at (x,z) lands on (-999 when unknown). */
  at(x: number, z: number): number {
    const gx = Math.floor(x) - this.ox, gz = Math.floor(z) - this.oz;
    if (gx < 0 || gz < 0 || gx >= SPAN || gz >= SPAN) return -999;
    return this.h[gz * SPAN + gx];
  }
}

/** Soft round flake sprite for snow. */
function flakeTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 16; c.height = 16;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(8, 8, 0, 8, 8, 8);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.85)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 16, 16);
  return new THREE.CanvasTexture(c);
}

class DropField {
  points: THREE.Object3D;
  protected pos: Float32Array;
  protected vel: Float32Array;
  /** rain: 2 vertices per drop (a short streak along its velocity) */
  protected verts: Float32Array;
  count = 0;
  protected geo: THREE.BufferGeometry;
  protected material: THREE.PointsMaterial | THREE.LineBasicMaterial;
  protected fallSpeed: number;
  protected drift: number;
  private streak: boolean;

  constructor(color: number, size: number, fallSpeed: number, drift: number, opacity: number, streak: boolean) {
    this.streak = streak;
    this.pos = new Float32Array(MAX_DROPS * 3);
    this.vel = new Float32Array(MAX_DROPS * 3);
    this.verts = streak ? new Float32Array(MAX_DROPS * 6) : this.pos;
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.verts, 3));
    if (streak) {
      this.material = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false, fog: false });
      this.points = new THREE.LineSegments(this.geo, this.material);
    } else {
      this.material = new THREE.PointsMaterial({
        color, size, transparent: true, opacity, depthWrite: false,
        fog: false, sizeAttenuation: true, map: flakeTexture(), alphaTest: 0.05,
      });
      this.points = new THREE.Points(this.geo, this.material);
    }
    this.points.frustumCulled = false;
    this.fallSpeed = fallSpeed;
    this.drift = drift;
  }

  /** Fill `n` drops in a box around the camera at the given height band. */
  seed(n: number, cx: number, cy: number, cz: number, span: number): void {
    this.count = n;
    for (let i = 0; i < n; i++) {
      this.pos[i * 3] = cx + (Math.random() - 0.5) * span;
      this.pos[i * 3 + 1] = cy + Math.random() * 24 - 4;
      this.pos[i * 3 + 2] = cz + (Math.random() - 0.5) * span;
      this.vel[i * 3] = (Math.random() - 0.5) * this.drift;
      this.vel[i * 3 + 1] = -this.fallSpeed * (0.8 + Math.random() * 0.4);
      this.vel[i * 3 + 2] = (Math.random() - 0.5) * this.drift;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.setDrawRange(0, this.streak ? n * 2 : n);
  }

  update(dt: number, cx: number, cy: number, cz: number, span: number, roof: RoofGrid, t: number): void {
    const half = span / 2;
    const P = this.pos, V = this.vel;
    for (let i = 0; i < this.count; i++) {
      const ix = i * 3;
      // snow flutters side to side as it falls
      const sway = this.streak ? 0 : Math.sin(t * 1.3 + i * 0.7) * 0.6;
      P[ix] += (V[ix] + sway) * dt;
      P[ix + 1] += V[ix + 1] * dt;
      P[ix + 2] += V[ix + 2] * dt;
      // recycle when below the camera feet, under a roof, or out of the box
      if (P[ix + 1] < cy - 4 || P[ix + 1] < roof.at(P[ix], P[ix + 2]) ||
        Math.abs(P[ix] - cx) > half || Math.abs(P[ix + 2] - cz) > half) {
        P[ix] = cx + (Math.random() - 0.5) * span;
        P[ix + 1] = cy + 18 + Math.random() * 6;
        P[ix + 2] = cz + (Math.random() - 0.5) * span;
      }
      if (this.streak) {
        const o = i * 6, k = 0.045; // streak length ~ velocity * 45 ms
        this.verts[o] = P[ix]; this.verts[o + 1] = P[ix + 1]; this.verts[o + 2] = P[ix + 2];
        this.verts[o + 3] = P[ix] - V[ix] * k; this.verts[o + 4] = P[ix + 1] - V[ix + 1] * k;
        this.verts[o + 5] = P[ix + 2] - V[ix + 2] * k;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
  }

  setVisible(v: boolean): void { this.points.visible = v; }
  setOpacity(o: number): void { this.material.opacity = o; }
  dispose(): void {
    this.geo.dispose();
    const m = this.material as THREE.PointsMaterial;
    if (m.map) m.map.dispose();
    this.material.dispose();
  }
}

export class Weather {
  kind: WeatherKind = 'clear';
  /** seconds until the next weather change is considered */
  private timer = 40 + Math.random() * 60;
  /** 0..1, how heavily it's precipitating right now (fades in/out) */
  intensity = 0;
  /** seconds of sky-flash remaining after a strike */
  private flashT = 0;
  /** seconds until the next strike attempt (only during thunder) */
  private nextStrike = 6 + Math.random() * 8;
  private rain: DropField;
  private roof = new RoofGrid();
  private t = 0;
  private snow: DropField;
  private scene: THREE.Scene;
  private world: World;
  private hooks: WeatherHooks;
  /** base sky color the renderer is using, darkened while raining */
  private darken = 0;
  /** when true (e.g. in the Nether), no precipitation, gloom, or lightning */
  private suppressed = false;

  constructor(scene: THREE.Scene, world: World, hooks: WeatherHooks) {
    this.scene = scene;
    this.world = world;
    this.hooks = hooks;
    // rain: small streaks; snow: slower, drifting dots
    this.rain = new DropField(0xa9bfdc, 0, 22, 1.4, 0.5, true);
    this.snow = new DropField(0xffffff, 0.12, 3.2, 0.9, 0.9, false);
    this.rain.setVisible(false);
    this.snow.setVisible(false);
    scene.add(this.rain.points);
    scene.add(this.snow.points);
  }

  /** seconds of daylight-ish level; renderer applies this as a darkening factor */
  darkening(): number { return this.darken; }
  /** 0..1 sky whiteout from a recent lightning strike */
  flashAmount(): number { return Math.max(0, this.flashT / 0.35); }

  /** Suppress all weather (Nether/other dimensions have no sky to rain from). */
  setSuppressed(on: boolean): void { this.suppressed = on; }

  /** Drive the state machine + particle motion. Call every frame. */
  update(dt: number, camX: number, camY: number, camZ: number): void {
    if (this.suppressed) {
      // force a fast fade to a clear, gloom-free sky with no drops or lightning
      this.kind = 'clear';
      this.intensity += (0 - this.intensity) * Math.min(1, dt * 1.2);
      this.darken += (0 - this.darken) * Math.min(1, dt * 1.2);
      this.flashT = Math.max(0, this.flashT - dt);
      this.rain.setVisible(false);
      this.snow.setVisible(false);
      return;
    }
    this.timer -= dt;
    if (this.timer <= 0) this.rollWeather();

    // fade intensity toward target
    const target = this.kind === 'clear' ? 0 : 1;
    this.intensity += (target - this.intensity) * Math.min(1, dt * 0.6);
    const active = this.intensity > 0.02;

    // darken factor ramps with intensity; thunder adds extra gloom
    const wantDark = active ? (this.kind === 'thunder' ? 0.42 : 0.28) : 0;
    this.darken += (wantDark - this.darken) * Math.min(1, dt * 0.6);

    // split drops between rain and snow by the biome under the camera
    if (active) {
      const cold = this.hooks.isColdAt(camX, camZ);
      const total = Math.floor(MAX_DROPS * this.intensity);
      const span = SPAN;
      this.t += dt;
      this.roof.refresh(this.world, camX, camZ, dt);
      const rainN = cold ? 0 : total;
      const snowN = cold ? total : 0;
      if (this.rain.count !== rainN) this.rain.seed(rainN, camX, camY + 6, camZ, span);
      if (this.snow.count !== snowN) this.snow.seed(snowN, camX, camY + 6, camZ, span);
      this.rain.setOpacity(0.5 * this.intensity);
      this.snow.setOpacity(0.9 * this.intensity);
      if (rainN > 0) this.rain.update(dt, camX, camY, camZ, span, this.roof, this.t); else this.rain.setVisible(false);
      if (snowN > 0) this.snow.update(dt, camX, camY, camZ, span, this.roof, this.t); else this.snow.setVisible(false);
      this.rain.setVisible(rainN > 0);
      this.snow.setVisible(snowN > 0);
    } else {
      this.rain.setVisible(false);
      this.snow.setVisible(false);
    }

    // lightning: only during thunder, attempt a strike on a timer
    this.flashT = Math.max(0, this.flashT - dt);
    if (this.kind === 'thunder') {
      this.nextStrike -= dt;
      if (this.nextStrike <= 0) {
        this.nextStrike = 5 + Math.random() * 12;
        this.attemptStrike(camX, camZ);
      }
    }
  }

  private rollWeather(): void {
    // 50% clear, ~35% rain, ~15% thunder; durations vary
    const r = Math.random();
    if (this.kind === 'clear') {
      if (r < 0.15) { this.kind = 'thunder'; this.timer = 60 + Math.random() * 80; }
      else { this.kind = 'rain'; this.timer = 80 + Math.random() * 120; }
    } else {
      // chance to escalate rain into a thunderstorm
      if (this.kind === 'rain' && r < 0.3) { this.kind = 'thunder'; this.timer = 50 + Math.random() * 70; }
      else { this.kind = 'clear'; this.timer = 100 + Math.random() * 160; }
    }
    this.nextStrike = 4 + Math.random() * 8;
  }

  /** Pick a column near the player, find its surface, and strike there. */
  private attemptStrike(camX: number, camZ: number): void {
    const ang = Math.random() * Math.PI * 2;
    const dist = 12 + Math.random() * 40;
    const x = Math.floor(camX + Math.cos(ang) * dist);
    const z = Math.floor(camZ + Math.sin(ang) * dist);
    // walk down from above to find the highest non-air block
    let y = 150;
    while (y > 1) {
      const id = this.world.getBlock(x, y, z);
      if (id !== B.AIR && id !== B.WATER) break;
      y--;
    }
    if (y <= 1) return;
    this.flashT = 0.35;
    this.hooks.onStrike(x, y + 1, z);
  }

  /** Force a specific weather (used by pause-menu toggle / dev). */
  setKind(k: WeatherKind): void {
    this.kind = k;
    this.timer = k === 'clear' ? 120 : 80;
    this.nextStrike = 4 + Math.random() * 6;
  }

  dispose(): void {
    this.scene.remove(this.rain.points);
    this.scene.remove(this.snow.points);
    this.rain.dispose();
    this.snow.dispose();
  }
}
