// The Nether pass's game-side glue, kept out of main.ts: biome air (haze,
// light, particles, ambience + music flavour), portal sheets and their hum,
// lighting frames of any size, portal travel with a swirl/nausea transition
// and proper 8:1 linking (remembered portals, then a scan, then a new portal
// on a safe ledge), the respawn anchor, the Portal Compass and persistence.

import { B, I, isSolid, emitLevel } from './Blocks';
import { CX, CZ } from './Chunk';
import type { World } from './World';
import type { Player } from './Player';
import type { Renderer } from './Renderer';
import type { AudioEngine } from './Audio';
import type { EntityManager } from './EntityManager';
import { NetherAtmosphere, NetherBiome } from './NetherAtmosphere';
import { netherFX } from './NetherFX';
import { portalFX } from './PortalFX';
import {
  Dim, PortalRec, findFrame, lightFrame, portalSheet, collapseIfBroken, scaleToDim, portalStands,
  findPortalSite, buildPortal, scanForPortal, nearestRec, remember, NETHER_MIN_Y, NETHER_MAX_Y,
  PORTAL_TIME_SURVIVAL, PORTAL_TIME_CREATIVE,
} from './NetherPortal';
import { NetherOverlay } from '../ui/NetherOverlay';

/** Persisted Nether-pass state (SaveState.nether). */
export interface NetherSave {
  portals?: { overworld: PortalRec[]; nether: PortalRec[] };
  anchor?: { x: number; y: number; z: number };
  owEntry?: { x: number; z: number };
}

export interface NetherHost {
  world: World;
  player: Player;
  renderer: Renderer;
  audio: AudioEngine;
  entities: EntityManager;
  toast(msg: string): void;
  unlock(id: string): void;
  /** the bed spawn is replaced when an anchor is set */
  clearBedSpawn(): void;
}

export class NetherController {
  readonly atmo = new NetherAtmosphere();
  private overlay: NetherOverlay;
  private portals: Record<Dim, PortalRec[]> = { overworld: [], nether: [] };
  anchor: { x: number; y: number; z: number } | null = null;
  private owEntry: { x: number; z: number } | null = null;
  /** 1 right after a trip, fading: the swirl clears and the wobble settles */
  private travelFade = 0;
  private wobbleT = 0;
  private roll = 0;
  private fovOff = 0;
  private wasInPortal = false;
  private audioT = 0;
  private collapsing = false;

  constructor(private host: NetherHost, root: HTMLElement) {
    this.overlay = new NetherOverlay(root);
    netherFX.attach(host.renderer.scene);
    portalFX.attach(host.renderer.scene);
  }

  dispose(): void {
    this.overlay.dispose();
    netherFX.clear();
    portalFX.reset();
  }

  // --- persistence ------------------------------------------------------------

  serialize(): NetherSave {
    return {
      portals: { overworld: this.portals.overworld.map((r) => ({ ...r })), nether: this.portals.nether.map((r) => ({ ...r })) },
      ...(this.anchor ? { anchor: { ...this.anchor } } : {}),
      ...(this.owEntry ? { owEntry: { ...this.owEntry } } : {}),
    };
  }

  load(s: NetherSave | undefined): void {
    if (!s) return;
    if (s.portals) {
      this.portals.overworld = (s.portals.overworld ?? []).map((r) => ({ ...r }));
      this.portals.nether = (s.portals.nether ?? []).map((r) => ({ ...r }));
    }
    this.anchor = s.anchor ? { ...s.anchor } : null;
    this.owEntry = s.owEntry ? { ...s.owEntry } : null;
  }

  /** Biome flavour for the Nether music (undefined outside the Nether). */
  musicBiome(): NetherBiome | undefined {
    return this.host.world.dimension === 'nether' ? this.atmo.dominant() : undefined;
  }

  // --- per frame ----------------------------------------------------------------

  update(dt: number, elapsed: number, playing: boolean): void {
    const { world, player, renderer, audio } = this.host;
    const nether = world.dimension === 'nether';
    const cam = renderer.camera.position;
    const p = player.pos;
    if (nether) {
      this.atmo.update(dt, world, p.x, p.y + 1, p.z);
      this.atmo.apply(renderer.netherAir);
      this.overlay.setVignette(this.atmo.vignette());
    } else {
      this.overlay.setVignette(null);
    }
    portalFX.update(dt, world, cam.x, cam.z, elapsed);
    const air = renderer.netherAir;
    netherFX.update(dt, world, cam, nether ? this.atmo.w : null, portalFX.cells,
      nether ? 0.55 + air.ambient.r * 2 : Math.max(0.35, renderer.daylight),
      nether ? air.near : 40, nether ? air.far : 70);

    // portal charge-up: swirl creeps in, the view wobbles, a rising whoosh
    const need = player.mode === 'creative' ? PORTAL_TIME_CREATIVE : PORTAL_TIME_SURVIVAL;
    const charge = Math.min(1, player.portalTimer / need);
    const inPortal = player.portalTimer > 0.01;
    if (inPortal && !this.wasInPortal) audio.portalTrigger();
    this.wasInPortal = inPortal;
    this.travelFade = Math.max(0, this.travelFade - dt / 1.6);
    const swirl = Math.max(charge * charge * 0.95, this.travelFade);
    this.overlay.setSwirl(dt, playing ? swirl : 0);
    this.wobbleT += dt;
    const k = Math.max(charge, this.travelFade * 0.8);
    this.roll = Math.sin(this.wobbleT * 1.9) * 0.1 * k + Math.sin(this.wobbleT * 3.3) * 0.03 * k;
    this.fovOff = Math.sin(this.wobbleT * 1.3) * 7 * k + 6 * k;

    // compass readout
    const held = player.heldId();
    const target = this.compassTarget();
    this.overlay.setCompass(playing && held === I.PORTAL_COMPASS, p.x, p.z, player.yaw, target);

    // ambience: biome beds, the portal hum and the charge swell (5 Hz)
    this.audioT -= dt;
    if (this.audioT <= 0) {
      this.audioT = 0.2;
      const near = portalFX.nearest(cam.x, cam.y, cam.z);
      let hum = 0, pan = 0;
      if (near && near.dist < 14) {
        hum = Math.pow(1 - near.dist / 14, 1.6);
        const dx = near.cell.x + 0.5 - cam.x, dz = near.cell.z + 0.5 - cam.z;
        const cy = Math.cos(player.yaw), sy = Math.sin(player.yaw);
        pan = Math.max(-1, Math.min(1, (dx * cy - dz * sy) / Math.max(1, near.dist)));
      }
      audio.netherScape(nether && playing ? this.atmo.w : null, playing ? hum : 0, pan, playing ? charge : 0);
    }
  }

  /** Camera roll (radians) from the portal nausea. */
  cameraRoll(): number { return this.roll; }
  /** Extra field of view (degrees) from the portal nausea. */
  fovOffset(): number { return this.fovOff; }

  /** Where the Portal Compass points: the remembered portal nearest you in this dimension. */
  private compassTarget(): { x: number; z: number } | null {
    const { world, player } = this.host;
    const list = this.portals[world.dimension as Dim];
    const r = nearestRec(list, player.pos.x, player.pos.y, player.pos.z, 1e6);
    if (!r) return null;
    const [ax, az] = r.axis === 'x' ? [1, 0] : [0, 1];
    return { x: r.x + ax * r.w / 2 + (r.axis === 'z' ? 0.5 : 0), z: r.z + az * r.w / 2 + (r.axis === 'x' ? 0.5 : 0) };
  }

  // --- block hooks ----------------------------------------------------------------

  /** World.onBlockChanged tap: a broken frame or sheet collapses its portal. */
  onBlockChanged(x: number, y: number, z: number, oldId: number, newId: number): void {
    if (oldId === B.PORTAL || newId === B.PORTAL) portalFX.dirty();
    if (this.collapsing || oldId === newId) return;
    if (oldId !== B.OBSIDIAN && oldId !== B.PORTAL) return;
    if (newId === B.PORTAL || newId === B.OBSIDIAN) return;
    const w = this.host.world;
    this.collapsing = true;
    try {
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        if (w.getBlock(x + dx, y + dy, z + dz) !== B.PORTAL) continue;
        if (collapseIfBroken(w, x + dx, y + dy, z + dz) > 0) {
          this.host.audio.play('portalFizz');
          netherFX.portalBurst(x + 0.5, y + 0.5, z + 0.5, 18);
        }
      }
    } finally {
      this.collapsing = false;
    }
  }

  /** Flint & steel / fire charge at an air cell: light the frame around it. */
  tryLight(x: number, y: number, z: number): boolean {
    const w = this.host.world;
    const rec = findFrame(w, x, y, z);
    if (!rec) return false;
    lightFrame(w, rec);
    remember(this.portals[w.dimension as Dim], rec);
    this.host.audio.play('portalLight');
    const [ax, az] = rec.axis === 'x' ? [1, 0] : [0, 1];
    netherFX.portalBurst(rec.x + ax * rec.w / 2 + 0.5 * az, rec.y + rec.h / 2, rec.z + az * rec.w / 2 + 0.5 * ax, 40, 1.4);
    portalFX.dirty();
    return true;
  }

  // --- travel -----------------------------------------------------------------------

  /** Take the player through the portal they're standing in. */
  travel(): void {
    const { world, player, audio } = this.host;
    const from = world.dimension as Dim;
    const to: Dim = from === 'overworld' ? 'nether' : 'overworld';
    const p = player.pos;

    // the sheet we're leaving: remember it so the way back finds it
    let src: PortalRec | null = null;
    for (let dy = 0; dy <= 1 && !src; dy++) {
      for (let dz = -1; dz <= 1 && !src; dz++) {
        for (let dx = -1; dx <= 1 && !src; dx++) {
          const s = portalSheet(world, Math.floor(p.x) + dx, Math.floor(p.y) + dy, Math.floor(p.z) + dz);
          if (s) src = s.rec;
        }
      }
    }
    if (src) remember(this.portals[from], src);
    const same = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): boolean => a.x === b.x && a.y === b.y && a.z === b.z;
    const srcRec = src ? this.portals[from].find((o) => same(o, src!)) : undefined;
    if (from === 'overworld') this.owEntry = { x: p.x, z: p.z };

    const t = scaleToDim(to, p.x, p.y, p.z);
    audio.play('portalTravel');
    world.switchDimension(to);
    portalFX.reset();
    netherFX.clear();
    const ensure = (x: number, z: number, r = 1): void => {
      const cx = Math.floor(x / CX), cz = Math.floor(z / CZ);
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) world.ensureChunk(cx + dx, cz + dz);
    };
    ensure(t.x, t.z);

    // 1. a portal we remember on the other side (vanilla search: 128 blocks in
    //    the Overworld, 16 in the Nether)
    const list = this.portals[to];
    const radius = to === 'overworld' ? 128 : 16;
    let rec: PortalRec | null = null;
    // 0. the portal this one was paired with on an earlier trip (round trips
    //    always come home, even when the partner was built far from 1/8 coords)
    if (srcRec?.link) {
      const l = srcRec.link;
      ensure(l.x, l.z);
      if (world.getBlock(l.x, l.y, l.z) === B.PORTAL) rec = list.find((o) => same(o, l)) ?? portalSheet(world, l.x, l.y, l.z)?.rec ?? null;
    }
    for (let tries = 0; tries < 6 && !rec; tries++) {
      const cand = nearestRec(list, t.x, t.y, t.z, radius);
      if (!cand) break;
      ensure(cand.x, cand.z);
      if (portalStands(world, cand)) rec = cand;
      else list.splice(list.indexOf(cand), 1);
    }
    // 2. any portal standing in the landing area (older saves, creative builds)
    if (!rec) {
      const lo = to === 'nether' ? NETHER_MIN_Y - 2 : 2, hi = to === 'nether' ? NETHER_MAX_Y + 8 : 150;
      const hit = scanForPortal(world, t.x, t.y, t.z, 14, lo, hi);
      if (hit) rec = portalSheet(world, hit[0], hit[1], hit[2])?.rec ?? null;
    }
    // 3. build one: on a natural ledge nearby, or carved out on an obsidian lip
    let built = false;
    if (!rec) {
      const ty = to === 'overworld' ? this.overworldY(t.x, t.z, t.y) : t.y;
      let site = findPortalSite(world, to, t.x, ty, t.z, 12);
      if (!site) {
        // nothing close (the lava sea, solid rock): look further afield for real ground
        ensure(t.x, t.z, 2);
        site = findPortalSite(world, to, t.x, ty, t.z, 30);
      }
      // last resort: carve a ledge, well above the Nether's lava sea
      rec = site ? buildPortal(world, site.x, site.y, site.z, site.axis, false)
        : buildPortal(world, t.x, to === 'nether' ? Math.max(ty, 64) : ty, t.z, 'x', true);
      built = true;
    }
    if (srcRec) { srcRec.link = { x: rec.x, y: rec.y, z: rec.z }; rec.link = { x: srcRec.x, y: srcRec.y, z: srcRec.z }; }
    remember(list, rec);

    // stand in the middle of the sheet, facing out of it toward open air
    const [ax, az] = rec.axis === 'x' ? [1, 0] : [0, 1];
    const mid = Math.floor((rec.w - 1) / 2);
    const sx = rec.x + ax * mid, sz = rec.z + az * mid;
    const open = (dir: number): boolean => {
      const ox = rec!.axis === 'z' ? dir : 0, oz = rec!.axis === 'x' ? dir : 0;
      return !isSolid(world.getBlock(sx + ox, rec!.y, sz + oz)) && !isSolid(world.getBlock(sx + ox, rec!.y + 1, sz + oz));
    };
    const dir = open(1) || !open(-1) ? 1 : -1;
    player.pos = { x: sx + 0.5 + (rec.w % 2 === 0 ? ax * 0.5 : 0), y: rec.y + 0.01, z: sz + 0.5 + (rec.w % 2 === 0 ? az * 0.5 : 0) };
    player.vel = { x: 0, y: 0, z: 0 };
    // yaw 0 looks toward -z; face along +dir on the sheet's normal
    player.yaw = rec.axis === 'x' ? (dir > 0 ? Math.PI : 0) : (dir > 0 ? -Math.PI / 2 : Math.PI / 2);
    player.portalTimer = 0;
    player.portalCooldown = 1.0;
    player.portalExitPending = true; // no bouncing back until they step out
    this.travelFade = 1;
    this.wasInPortal = true;
    netherFX.portalBurst(player.pos.x, player.pos.y + 1, player.pos.z, 50, 1.6);
    portalFX.dirty();
    if (to === 'nether') this.atmo.snap(world, player.pos.x, player.pos.y + 1, player.pos.z);

    if (to === 'nether') this.host.unlock('nether');
    if (to === 'overworld' && this.owEntry && Math.hypot(player.pos.x - this.owEntry.x, player.pos.z - this.owEntry.z) >= 7000) {
      this.host.unlock('subspace');
    }
    this.host.toast(to === 'nether'
      ? (built ? 'Entered the Nether — a new portal formed' : 'Entered the Nether')
      : (built ? 'Back in the Overworld — a new portal formed' : 'Back in the Overworld'));
  }

  /** Landing height in the Overworld: stay near the scaled height, never buried in the sky. */
  private overworldY(x: number, z: number, y: number): number {
    const c = this.host.world.getChunk(Math.floor(x / CX), Math.floor(z / CZ));
    if (!c || !c.ready) return Math.max(64, y);
    const h = c.heightmap[(((z % 16) + 16) % 16) * 16 + (((x % 16) + 16) % 16)];
    return Math.max(4, Math.min(150, h));
  }

  // --- respawn anchor -------------------------------------------------------------------

  /** Right-click on an anchor. Returns true when the click was used. */
  useAnchor(x: number, y: number, z: number, heldId: number, creative: boolean): boolean {
    const { world, audio, player, entities } = this.host;
    const key = `${x},${y},${z}`;
    const charge = world.bedFacings.get(key) ?? 0;
    if (heldId === B.GLOWSTONE && charge < 4) {
      world.bedFacings.set(key, charge + 1);
      if (!creative) player.inventory.consumeSelected();
      this.remeshAround(x, z);
      audio.play('anchorCharge');
      netherFX.portalBurst(x + 0.5, y + 1.05, z + 0.5, 16, 0.8);
      if (charge + 1 >= 4) this.host.unlock('anchor_full');
      return true;
    }
    if (charge <= 0) return false;
    if (world.dimension !== 'nether') {
      // vanilla "intentional game design": it detonates anywhere but the Nether
      world.setBlock(x, y, z, B.AIR);
      entities.explode(x + 0.5, y + 0.5, z + 0.5, 5, 'Killed by [Intentional Game Design]');
      return true;
    }
    const was = this.anchor;
    this.anchor = { x, y, z };
    this.host.clearBedSpawn();
    audio.play('anchorSet');
    netherFX.portalBurst(x + 0.5, y + 1.1, z + 0.5, 24, 0.6);
    if (!was || was.x !== x || was.y !== y || was.z !== z) this.host.toast('Respawn point set');
    return true;
  }

  /** A bed spawn replaces the anchor spawn (one spawn point, as in vanilla). */
  clearAnchor(): void { this.anchor = null; }

  /**
   * On respawn: if an anchor spawn is set and still charged, switch to the
   * Nether, spend a charge and return a standing spot beside it. Otherwise
   * forget it and return null (the caller falls back to bed / world spawn).
   */
  respawnAtAnchor(): { x: number; y: number; z: number } | null {
    const a = this.anchor;
    if (!a) return null;
    const { world } = this.host;
    if (world.dimension !== 'nether') { world.switchDimension('nether'); portalFX.reset(); netherFX.clear(); }
    const cx = Math.floor(a.x / CX), cz = Math.floor(a.z / CZ);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) world.ensureChunk(cx + dx, cz + dz);
    const key = `${a.x},${a.y},${a.z}`;
    const charge = world.bedFacings.get(key) ?? 0;
    let spot: { x: number; y: number; z: number } | null = null;
    if (world.getBlock(a.x, a.y, a.z) === B.RESPAWN_ANCHOR && charge > 0) {
      // the nearest free two-high gap on solid ground around the anchor
      search:
      for (let r = 1; r <= 2; r++) {
        for (let dy = 0; dy >= -1; dy--) {
          for (let dz = -r; dz <= r; dz++) {
            for (let dx = -r; dx <= r; dx++) {
              if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
              const x = a.x + dx, y = a.y + dy, z = a.z + dz;
              if (!isSolid(world.getBlock(x, y - 1, z)) || world.getBlock(x, y - 1, z) === B.LAVA) continue;
              if (isSolid(world.getBlock(x, y, z)) || isSolid(world.getBlock(x, y + 1, z))) continue;
              if (world.getBlock(x, y, z) === B.LAVA) continue;
              spot = { x: x + 0.5, y, z: z + 0.5 };
              break search;
            }
          }
        }
      }
      if (!spot) spot = { x: a.x + 0.5, y: a.y + 1, z: a.z + 0.5 }; // on top, as a last resort
    }
    if (!spot) {
      this.anchor = null;
      this.host.toast('Your respawn anchor was out of charges, missing or obstructed');
      if (world.dimension !== 'overworld') { world.switchDimension('overworld'); portalFX.reset(); netherFX.clear(); }
      return null;
    }
    world.bedFacings.set(key, charge - 1);
    this.remeshAround(a.x, a.z);
    this.host.audio.play('anchorDeplete');
    this.atmo.snap(world, spot.x, spot.y + 1, spot.z);
    return spot;
  }

  private remeshAround(x: number, z: number): void {
    const cx = Math.floor(x / CX), cz = Math.floor(z / CZ);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) this.host.world.markDirty(cx + dx, cz + dz);
  }

  // --- dev / harness helpers ----------------------------------------------------------

  /** Live numbers for harnesses. */
  debug(): Record<string, unknown> {
    return {
      biome: this.atmo.dominant(),
      weights: { ...this.atmo.w },
      particles: netherFX.count,
      portalCells: portalFX.cells.length,
      portals: { overworld: this.portals.overworld.length, nether: this.portals.nether.length },
      anchor: this.anchor,
      light: emitLevel(B.RESPAWN_ANCHOR, 4),
    };
  }
}
