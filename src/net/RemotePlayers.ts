// Other players in a multiplayer world: a Steve-proportioned model per player
// (clothes coloured from their name), a floating name tag, and smooth motion.
// Poses arrive ~12 times a second; each model is drawn ~120 ms in the past,
// interpolating between the two snapshots around that moment, so movement
// stays smooth whatever the network jitter. Limbs swing with ground speed,
// the head follows their look pitch, sneaking crouches, an arm swing plays on
// every swing the pose counter reports, and the held item is shown in hand.

import * as THREE from 'three';
import { MobModels, LimbSet } from '../engine/MobModels';
import { Atlas, extrudeSpriteGeometry } from '../engine/Textures';
import { def, hasDef, spriteNameFor } from '../engine/Blocks';
import type { Pose, Dim } from './protocol';

const DELAY = 0.12; // seconds of interpolation delay
const SHIRTS = ['#2f9fa3', '#c0392b', '#2e86de', '#27ae60', '#8e44ad', '#e67e22', '#d4ac0d', '#16a085', '#e84393', '#6c5ce7'];
const PANTS = ['#3f3a96', '#2d3436', '#5d4037', '#1e3799', '#4a4a4a', '#6d214f'];
const HAIR = ['#3b2616', '#1b1b1b', '#6b4423', '#c49a45', '#8a3b1b', '#5a5a5a'];

interface Snap { t: number; p: Pose }

interface Remote {
  id: number;
  name: string;
  root: THREE.Group;
  body: THREE.Group;
  limbs: LimbSet;
  tag: THREE.Sprite;
  snaps: Snap[];
  walk: number;
  lastSwing: number;
  swingT: number;
  heldId: number;
  heldMesh: THREE.Object3D | null;
  prevX: number;
  prevZ: number;
}

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

function nameTag(name: string): THREE.Sprite {
  const c = document.createElement('canvas');
  const font = '28px monospace';
  const ctx = c.getContext('2d')!;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(name).width) + 16;
  c.width = w; c.height = 40;
  ctx.font = font;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, 0, w, 40);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, 8, 21);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const s = new THREE.Sprite(mat);
  s.scale.set(w / 40 * 0.3, 0.3, 1);
  s.renderOrder = 10;
  return s;
}

export class RemotePlayers {
  private models = new MobModels();
  private players = new Map<number, Remote>();
  private clock = 0;

  constructor(private scene: THREE.Scene, private atlas: Atlas) {}

  add(id: number, name: string, pose?: Pose): void {
    if (this.players.has(id)) this.remove(id);
    const h = hash(name);
    const built = this.models.player(SHIRTS[h % SHIRTS.length], PANTS[(h >>> 8) % PANTS.length], HAIR[(h >>> 16) % HAIR.length]);
    const root = new THREE.Group();
    const body = built.mesh;
    root.add(body);
    const tag = nameTag(name);
    tag.position.set(0, 2.15, 0);
    root.add(tag);
    root.visible = false;
    this.scene.add(root);
    const r: Remote = {
      id, name, root, body, limbs: built.limbs, tag, snaps: [], walk: 0,
      lastSwing: pose?.swing ?? 0, swingT: 1, heldId: 0, heldMesh: null, prevX: 0, prevZ: 0,
    };
    this.players.set(id, r);
    if (pose) this.pose(id, pose);
  }

  remove(id: number): void {
    const r = this.players.get(id);
    if (!r) return;
    this.scene.remove(r.root);
    r.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose();
    });
    this.players.delete(id);
  }

  clear(): void {
    for (const id of [...this.players.keys()]) this.remove(id);
  }

  pose(id: number, p: Pose): void {
    const r = this.players.get(id);
    if (!r) return;
    r.snaps.push({ t: this.clock, p });
    if (r.snaps.length > 30) r.snaps.splice(0, r.snaps.length - 30);
    if (p.swing !== r.lastSwing) { r.lastSwing = p.swing; r.swingT = 0; }
  }

  list(): { id: number; name: string; pose: Pose | null }[] {
    return [...this.players.values()].map((r) => ({ id: r.id, name: r.name, pose: r.snaps.at(-1)?.p ?? null }));
  }

  update(dt: number, dim: Dim): void {
    this.clock += dt;
    const renderT = this.clock - DELAY;
    for (const r of this.players.values()) {
      const s = r.snaps;
      if (!s.length) { r.root.visible = false; continue; }
      // the two snapshots around renderT (or the newest, held)
      let a = s[0], b = s[0];
      for (let i = s.length - 1; i >= 0; i--) {
        if (s[i].t <= renderT) { a = s[i]; b = s[Math.min(i + 1, s.length - 1)]; break; }
      }
      while (s.length > 2 && s[1].t < renderT - 1) s.shift();
      const span = b.t - a.t;
      const k = span > 1e-4 ? Math.min(1, Math.max(0, (renderT - a.t) / span)) : 1;
      const pa = a.p, pb = b.p;
      const x = pa.x + (pb.x - pa.x) * k, y = pa.y + (pb.y - pa.y) * k, z = pa.z + (pb.z - pa.z) * k;
      let dy = pb.yaw - pa.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      const yaw = pa.yaw + dy * k;
      const pitch = pa.pitch + (pb.pitch - pa.pitch) * k;
      const p = pb;
      r.root.visible = p.dim === dim && !p.dead;
      if (!r.root.visible) continue;
      r.root.position.set(x, y, z);
      // mob models face -z, the way a player's yaw 0 looks
      r.body.rotation.y = yaw;
      const sneak = p.sneak && !p.riding;
      r.body.position.y = sneak ? -0.12 : 0;
      r.tag.position.y = sneak ? 1.95 : 2.15;
      // lying in bed: tip over onto the back
      r.body.rotation.x = p.sleeping ? Math.PI / 2 : 0;
      if (p.sleeping) r.body.position.y = 0.55;

      // walk cycle from ground speed
      const speed = Math.hypot(x - r.prevX, z - r.prevZ) / Math.max(dt, 1e-3);
      r.prevX = x; r.prevZ = z;
      const moving = speed > 0.3 && !p.riding;
      r.walk += dt * Math.min(speed, 8) * 2.2;
      const amp = moving ? Math.min(0.9, speed * 0.2) : 0;
      const legs = r.limbs.legs, arms = r.limbs.arms ?? [];
      const sw = Math.sin(r.walk) * amp;
      if (legs[0]) legs[0].rotation.x = p.riding ? -1.3 : sw;
      if (legs[1]) legs[1].rotation.x = p.riding ? -1.3 : -sw;
      // arm swing (attack / use): a quick chop of the right arm
      if (r.swingT < 1) r.swingT = Math.min(1, r.swingT + dt / 0.3);
      const chop = Math.sin(Math.sqrt(r.swingT) * Math.PI);
      if (arms[0]) arms[0].rotation.x = -sw * 0.8;
      if (arms[1]) {
        arms[1].rotation.x = sw * 0.8 + chop * 1.6 + (r.heldId ? 0.25 : 0);
        arms[1].rotation.z = chop * 0.3;
      }
      if (sneak) r.body.rotation.x = -0.35; // lean forward
      const head = r.limbs.head;
      if (head) head.rotation.x = pitch * (sneak ? 0.6 : 1);
      if (p.held !== r.heldId) this.setHeld(r, p.held);
    }
  }

  /** Put the item in the right hand: an extruded sprite, or a small block. */
  private setHeld(r: Remote, id: number): void {
    r.heldId = id;
    const arm = r.limbs.arms?.[1];
    if (r.heldMesh) { r.heldMesh.parent?.remove(r.heldMesh); r.heldMesh = null; }
    if (!arm || !id || !hasDef(id)) return;
    const d = def(id);
    let mesh: THREE.Object3D | null = null;
    const spriteName = d.sprite ?? spriteNameFor(id);
    const sprite = spriteName ? this.atlas.sprite(spriteName) : null;
    if (sprite) {
      mesh = new THREE.Mesh(extrudeSpriteGeometry(sprite, 0.5), new THREE.MeshLambertMaterial({ vertexColors: true }));
      mesh.rotation.set(-Math.PI / 2, Math.PI / 2, -Math.PI / 4); // blade out ahead of the fist
      mesh.position.set(0, -0.66, -0.16);
    } else if (d.block && d.faces) {
      const r0 = this.atlas.rect(d.faces.sides);
      const geo = new THREE.BoxGeometry(0.25, 0.25, 0.25);
      const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) ? r0.u1 : r0.u0, uv.getY(i) ? r0.v1 : r0.v0);
      mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: this.atlas.texture, alphaTest: 0.35 }));
      mesh.position.set(0, -0.68, -0.1);
    }
    if (mesh) { arm.add(mesh); r.heldMesh = mesh; }
  }
}
