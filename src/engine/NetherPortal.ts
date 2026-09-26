// Nether portals as structures: frame detection for lighting (any obsidian
// rectangle from 2x3 to 21x21 inside), the plane a portal block lies in,
// collapsing a portal whose frame was broken, and the travel link — the 8:1
// coordinate scale, finding the partner portal on the other side (remembered
// ones first, then a scan of the landing area) or building a new one on a
// safe ledge. Pure world reads/writes, no rendering or UI.

import { B, def, hasDef, isSolid } from './Blocks';

export type Dim = 'overworld' | 'nether';
/** 'x' = the sheet spans x (constant z), 'z' = it spans z (constant x). */
export type PortalAxis = 'x' | 'z';

/** A portal's interior: bottom-left cell, extent along its axis, height. */
export interface PortalRec { x: number; y: number; z: number; axis: PortalAxis; w: number; h: number }

export interface PortalWorld {
  getBlock(x: number, y: number, z: number): number;
  setBlock(x: number, y: number, z: number, id: number): boolean | void;
}

const MAX_SIDE = 21;
/** Seconds standing in a portal before it takes you (vanilla: 4 s survival, near-instant creative). */
export const PORTAL_TIME_SURVIVAL = 2.4;
export const PORTAL_TIME_CREATIVE = 0.6;
/** Nether world height band a portal may be built in (above the lava sea, below the roof). */
export const NETHER_MIN_Y = 34, NETHER_MAX_Y = 120;

const along = (axis: PortalAxis): [number, number] => (axis === 'x' ? [1, 0] : [0, 1]);

/** Which vertical plane a portal block lies in, read from its neighbours. */
export function portalAxisAt(get: (x: number, y: number, z: number) => number, x: number, y: number, z: number): PortalAxis {
  const px = +(get(x - 1, y, z) === B.PORTAL) + +(get(x + 1, y, z) === B.PORTAL);
  const pz = +(get(x, y, z - 1) === B.PORTAL) + +(get(x, y, z + 1) === B.PORTAL);
  if (px !== pz) return px > pz ? 'x' : 'z';
  const ox = +(get(x - 1, y, z) === B.OBSIDIAN) + +(get(x + 1, y, z) === B.OBSIDIAN);
  const oz = +(get(x, y, z - 1) === B.OBSIDIAN) + +(get(x, y, z + 1) === B.OBSIDIAN);
  return oz > ox ? 'z' : 'x';
}

/** Cells a portal may be lit through (air, or flames already burning in it). */
const litThrough = (id: number): boolean => id === B.AIR || id === B.FIRE;

/**
 * The obsidian frame enclosing (sx,sy,sz), or null. Like vanilla: from the
 * seed walk down to the floor and back to the near edge, measure the opening,
 * then require a clean rectangle of air (2..21 wide, 3..21 tall) bounded by
 * obsidian on all four sides (corners optional).
 */
export function findFrame(w: PortalWorld, sx: number, sy: number, sz: number): PortalRec | null {
  if (!litThrough(w.getBlock(sx, sy, sz))) return null;
  for (const axis of ['x', 'z'] as PortalAxis[]) {
    const [ax, az] = along(axis);
    let x = sx, y = sy, z = sz;
    for (let i = 0; i < MAX_SIDE && litThrough(w.getBlock(x, y - 1, z)); i++) y--;
    if (w.getBlock(x, y - 1, z) !== B.OBSIDIAN) continue;
    for (let i = 0; i < MAX_SIDE && litThrough(w.getBlock(x - ax, y, z - az)); i++) { x -= ax; z -= az; }
    if (w.getBlock(x - ax, y, z - az) !== B.OBSIDIAN) continue;
    let wd = 0;
    while (wd <= MAX_SIDE && litThrough(w.getBlock(x + ax * wd, y, z + az * wd))) wd++;
    let ht = 0;
    while (ht <= MAX_SIDE && litThrough(w.getBlock(x, y + ht, z))) ht++;
    if (wd < 2 || wd > MAX_SIDE || ht < 3 || ht > MAX_SIDE) continue;
    const rec: PortalRec = { x, y, z, axis, w: wd, h: ht };
    if (frameIntact(w, rec, true)) return rec;
  }
  return null;
}

/** Interior all `interior` (air/fire, or portal once lit) and every edge cell obsidian. */
function frameIntact(w: PortalWorld, r: PortalRec, unlit: boolean): boolean {
  const [ax, az] = along(r.axis);
  for (let a = -1; a <= r.w; a++) {
    for (let h = -1; h <= r.h; h++) {
      const edgeA = a === -1 || a === r.w, edgeH = h === -1 || h === r.h;
      if (edgeA && edgeH) continue; // corners are optional
      const id = w.getBlock(r.x + ax * a, r.y + h, r.z + az * a);
      if (edgeA || edgeH) { if (id !== B.OBSIDIAN) return false; }
      else if (unlit ? !litThrough(id) : id !== B.PORTAL) return false;
    }
  }
  return true;
}

/** Fill a detected frame with portal blocks. */
export function lightFrame(w: PortalWorld, r: PortalRec): void {
  const [ax, az] = along(r.axis);
  for (let a = 0; a < r.w; a++) for (let h = 0; h < r.h; h++) w.setBlock(r.x + ax * a, r.y + h, r.z + az * a, B.PORTAL);
}

/** The whole portal sheet containing a portal block (flood fill in its plane). */
export function portalSheet(w: PortalWorld, x: number, y: number, z: number): { cells: [number, number, number][]; rec: PortalRec } | null {
  if (w.getBlock(x, y, z) !== B.PORTAL) return null;
  const axis = portalAxisAt((a, b, c) => w.getBlock(a, b, c), x, y, z);
  const [ax, az] = along(axis);
  const seen = new Set<string>();
  const cells: [number, number, number][] = [];
  const stack: [number, number, number][] = [[x, y, z]];
  let minA = Infinity, minY = Infinity, maxA = -Infinity, maxY = -Infinity;
  while (stack.length && cells.length < MAX_SIDE * MAX_SIDE) {
    const [cx, cy, cz] = stack.pop()!;
    const k = `${cx},${cy},${cz}`;
    if (seen.has(k) || w.getBlock(cx, cy, cz) !== B.PORTAL) continue;
    seen.add(k);
    cells.push([cx, cy, cz]);
    const a = cx * ax + cz * az;
    if (a < minA) minA = a; if (a > maxA) maxA = a;
    if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
    stack.push([cx + ax, cy, cz + az], [cx - ax, cy, cz - az], [cx, cy + 1, cz], [cx, cy - 1, cz]);
  }
  const rec: PortalRec = axis === 'x'
    ? { x: minA, y: minY, z, axis, w: maxA - minA + 1, h: maxY - minY + 1 }
    : { x, y: minY, z: minA, axis, w: maxA - minA + 1, h: maxY - minY + 1 };
  return { cells, rec };
}

/**
 * A portal block lost support (its frame or a neighbour sheet cell was
 * removed): if the sheet is no longer sealed by obsidian, it all winks out.
 * Returns the number of portal blocks removed.
 */
export function collapseIfBroken(w: PortalWorld, x: number, y: number, z: number): number {
  const sheet = portalSheet(w, x, y, z);
  if (!sheet) return 0;
  const axis = sheet.rec.axis;
  const [ax, az] = along(axis);
  let sealed = true;
  for (const [cx, cy, cz] of sheet.cells) {
    for (const [dx, dy, dz] of [[ax, 0, az], [-ax, 0, -az], [0, 1, 0], [0, -1, 0]]) {
      const id = w.getBlock(cx + dx, cy + dy, cz + dz);
      if (id !== B.PORTAL && id !== B.OBSIDIAN) { sealed = false; break; }
    }
    if (!sealed) break;
  }
  if (sealed) return 0;
  for (const [cx, cy, cz] of sheet.cells) w.setBlock(cx, cy, cz, B.AIR);
  return sheet.cells.length;
}

/** Where a point lands in the other dimension (vanilla 8:1, y clamped to the Nether band). */
export function scaleToDim(to: Dim, x: number, y: number, z: number): { x: number; y: number; z: number } {
  if (to === 'nether') return { x: Math.floor(x / 8), y: Math.max(NETHER_MIN_Y, Math.min(NETHER_MAX_Y, Math.floor(y))), z: Math.floor(z / 8) };
  return { x: Math.floor(x * 8), y: Math.floor(y), z: Math.floor(z * 8) };
}

/** Is a remembered portal still standing? (its bottom-left cell is portal) */
export function portalStands(w: PortalWorld, r: PortalRec): boolean {
  return w.getBlock(r.x, r.y, r.z) === B.PORTAL;
}

/** Blocks a new portal may be carved through (never another structure's walls). */
function clearable(id: number): boolean {
  if (id === B.AIR || id === B.FIRE || id === B.LAVA || id === B.WATER) return true;
  if (!hasDef(id)) return false;
  const d = def(id);
  // soft natural terrain (netherrack, soul sand, dirt, plants ...) but not
  // chests, beds, doors or anything that holds state
  return !d.solid || (d.hardness >= 0 && d.hardness <= 2.5 && id !== B.CHEST && id !== B.CHEST_LOOT &&
    id !== B.FURNACE && id !== B.OBSIDIAN && id !== B.NETHER_BRICKS && id !== B.PORTAL);
}

/** Can a 4x5 frame with a standing strip on both sides go here, as is? */
function fitsNatural(w: PortalWorld, x: number, y: number, z: number, axis: PortalAxis): boolean {
  const [ax, az] = along(axis);
  const px = az, pz = ax; // perpendicular (out of the sheet)
  for (let a = -1; a <= 2; a++) {
    for (let p = -1; p <= 1; p++) {
      const fx = x + ax * a + px * p, fz = z + az * a + pz * p;
      const floor = w.getBlock(fx, y - 1, fz);
      if (!isSolid(floor) || floor === B.LAVA) return false;
      for (let h = 0; h <= 3; h++) if (w.getBlock(fx, y + h, fz) !== B.AIR) return false;
    }
  }
  // headroom for the lintel
  for (let a = -1; a <= 2; a++) if (w.getBlock(x + ax * a, y + 4, z + az * a) !== B.AIR && !clearable(w.getBlock(x + ax * a, y + 4, z + az * a))) return false;
  return true;
}

/**
 * Find a natural ledge for a new portal near (tx,ty,tz): columns spiral out to
 * `radius`, and within each column heights are tried nearest-first. Falls back
 * to null (the caller then forces a platform).
 */
export function findPortalSite(w: PortalWorld, dim: Dim, tx: number, ty: number, tz: number, radius = 12): { x: number; y: number; z: number; axis: PortalAxis } | null {
  const lo = dim === 'nether' ? NETHER_MIN_Y : 4;
  const hi = dim === 'nether' ? NETHER_MAX_Y : 150;
  const cols: [number, number][] = [];
  for (let dz = -radius; dz <= radius; dz++) for (let dx = -radius; dx <= radius; dx++) if (dx * dx + dz * dz <= radius * radius) cols.push([dx, dz]);
  cols.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]));
  const span = dim === 'nether' ? 40 : 48;
  for (const [dx, dz] of cols) {
    const x = tx + dx, z = tz + dz;
    for (let k = 0; k <= span * 2; k++) {
      const y = ty + (k & 1 ? -((k + 1) >> 1) : k >> 1);
      if (y < lo || y > hi) continue;
      // cheap reject: needs a solid floor under open air
      if (w.getBlock(x, y, z) !== B.AIR || !isSolid(w.getBlock(x, y - 1, z))) continue;
      for (const axis of ['x', 'z'] as PortalAxis[]) if (fitsNatural(w, x, y, z, axis)) return { x, y, z, axis };
    }
  }
  return null;
}

/**
 * Build a 4x5 obsidian frame with a lit 2x3 sheet whose bottom-left interior
 * cell is (x,y,z). `force` also lays an obsidian ledge (both sides) and clears
 * the space, for sites carved out of rock or hanging over the lava sea.
 */
export function buildPortal(w: PortalWorld, x: number, y: number, z: number, axis: PortalAxis, force: boolean): PortalRec {
  const [ax, az] = along(axis);
  const px = az, pz = ax;
  if (force) {
    for (let a = -1; a <= 2; a++) {
      for (let p = -1; p <= 1; p++) {
        const fx = x + ax * a + px * p, fz = z + az * a + pz * p;
        if (p !== 0) {
          for (let h = 0; h <= 3; h++) if (clearable(w.getBlock(fx, y + h, fz))) w.setBlock(fx, y + h, fz, B.AIR);
          const floor = w.getBlock(fx, y - 1, fz);
          if (!isSolid(floor) || floor === B.LAVA) w.setBlock(fx, y - 1, fz, B.OBSIDIAN);
        }
      }
    }
  }
  for (let a = -1; a <= 2; a++) {
    for (let h = -1; h <= 3; h++) {
      const cx = x + ax * a, cz = z + az * a;
      const edge = a === -1 || a === 2 || h === -1 || h === 3;
      w.setBlock(cx, y + h, cz, edge ? B.OBSIDIAN : B.AIR);
    }
  }
  const rec: PortalRec = { x, y, z, axis, w: 2, h: 3 };
  lightFrame(w, rec);
  return rec;
}

/** Scan a box for any portal block (used for portals the registry doesn't know). */
export function scanForPortal(w: PortalWorld, tx: number, ty: number, tz: number, r: number, lo: number, hi: number): [number, number, number] | null {
  let best: [number, number, number] | null = null, bd = Infinity;
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let y = lo; y <= hi; y++) {
        if (w.getBlock(tx + dx, y, tz + dz) !== B.PORTAL) continue;
        const d = dx * dx + dz * dz + (y - ty) * (y - ty) * 0.25;
        if (d < bd) { bd = d; best = [tx + dx, y, tz + dz]; }
      }
    }
  }
  return best;
}

/** Nearest remembered portal to (x,z) within `radius`, or null. */
export function nearestRec(list: PortalRec[], x: number, y: number, z: number, radius: number): PortalRec | null {
  let best: PortalRec | null = null, bd = radius * radius;
  for (const r of list) {
    const d = (r.x - x) ** 2 + (r.z - z) ** 2 + ((r.y - y) * 0.5) ** 2;
    if (d <= bd) { bd = d; best = r; }
  }
  return best;
}

/** Remember a portal (replacing any record for the same sheet). */
export function remember(list: PortalRec[], r: PortalRec): void {
  const i = list.findIndex((o) => o.x === r.x && o.y === r.y && o.z === r.z);
  if (i >= 0) list.splice(i, 1);
  list.push({ ...r });
  if (list.length > 64) list.shift();
}
