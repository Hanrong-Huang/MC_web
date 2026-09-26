// Sliding AABB collision for the player, mobs, and item drops.
// Entities are positioned by the center of their feet (pos.y = bottom of AABB).
// Full blocks collide as unit cells; shaped blocks (slabs, stairs, fences,
// panes, gates ...) collide with their own boxes, and a walker steps up any
// ledge up to STEP_HEIGHT (a slab or a stair) without jumping.

import { World } from './World';
import { B, def, hasDef, SHAPED, FENCE_IDS, GATE_IDS, shapeBoxes, connectsTo } from './Blocks';
import type { Box } from './Blocks';

export interface Vec3 { x: number; y: number; z: number }
export interface EntBox { w: number; h: number } // full width (x=z) and height

export interface MoveResult {
  onGround: boolean;
  hitX: boolean;
  hitY: boolean;
  hitZ: boolean;
}

const EPS = 0.001;
/** vanilla step height: walk straight up slabs and stairs */
const STEP_HEIGHT = 0.6;
const FULL: Box[] = [[0, 0, 0, 1, 1, 1]];
const NONE: Box[] = [];

/** Collision boxes of the cell (block-local), empty when it doesn't block.
 *  Includes closed doors (full cell) and shaped blocks' partial boxes. */
function cellBoxes(world: World, x: number, y: number, z: number): Box[] {
  const id = world.getBlock(x, y, z);
  if (id === B.AIR || id === B.WATER) return NONE;
  if (SHAPED.has(id)) {
    const key = `${x},${y},${z}`;
    if (GATE_IDS.has(id)) {
      const st = world.doorStates.get(key);
      return shapeBoxes(id, st?.facing ?? 0, 0, !!st?.open, true) ?? FULL;
    }
    let conn = 0;
    if (FENCE_IDS.has(id) || id === B.GLASS_PANE) {
      if (connectsTo(id, world.getBlock(x, y, z - 1))) conn |= 1;
      if (connectsTo(id, world.getBlock(x, y, z + 1))) conn |= 2;
      if (connectsTo(id, world.getBlock(x - 1, y, z))) conn |= 4;
      if (connectsTo(id, world.getBlock(x + 1, y, z))) conn |= 8;
      if (id === B.GLASS_PANE && conn === 0) conn = world.bedFacings.get(key) === 1 ? 1 | 2 : 4 | 8;
    }
    return hasDef(id) && def(id).solid ? shapeBoxes(id, world.bedFacings.get(key) ?? 0, conn, false, true) ?? FULL : NONE;
  }
  if (hasDef(id) && def(id).solid) return FULL;
  // doors block while closed
  if (id === B.DOOR_LOWER || id === B.DOOR_UPPER) return world.isDoorClosed(x, y, z) ? FULL : NONE;
  return NONE;
}

/** Does any block box overlap the entity AABB at `pos`? */
function overlapsAny(world: World, pos: Vec3, box: EntBox): boolean {
  const hw = box.w / 2;
  const minX = pos.x - hw, maxX = pos.x + hw, minY = pos.y, maxY = pos.y + box.h;
  const minZ = pos.z - hw, maxZ = pos.z + hw;
  for (let by = Math.floor(minY) - 1; by <= Math.floor(maxY - EPS / 2); by++) {
    for (let bz = Math.floor(minZ); bz <= Math.floor(maxZ - EPS / 2); bz++) {
      for (let bx = Math.floor(minX); bx <= Math.floor(maxX - EPS / 2); bx++) {
        for (const b of cellBoxes(world, bx, by, bz)) {
          if (bx + b[3] > minX + EPS && bx + b[0] < maxX - EPS &&
            by + b[4] > minY + EPS && by + b[1] < maxY - EPS &&
            bz + b[5] > minZ + EPS && bz + b[2] < maxZ - EPS) return true;
        }
      }
    }
  }
  return false;
}

function collideAxis(world: World, pos: Vec3, box: EntBox, axis: 'x' | 'y' | 'z', vel: Vec3): boolean {
  const hw = box.w / 2;
  const minX = pos.x - hw, maxX = pos.x + hw;
  const minY = pos.y, maxY = pos.y + box.h;
  const minZ = pos.z - hw, maxZ = pos.z + hw;

  const x0 = Math.floor(minX), x1 = Math.floor(maxX - EPS / 2);
  const y0 = Math.floor(minY) - 1, y1 = Math.floor(maxY - EPS / 2); // -1: fences stand 1.5 tall
  const z0 = Math.floor(minZ), z1 = Math.floor(maxZ - EPS / 2);

  // the most restrictive face among every overlapping box wins
  let hit = false;
  let limit = 0;
  const d = axis === 'x' ? vel.x : axis === 'y' ? vel.y : vel.z;
  for (let by = y0; by <= y1; by++) {
    for (let bz = z0; bz <= z1; bz++) {
      for (let bx = x0; bx <= x1; bx++) {
        const boxes = cellBoxes(world, bx, by, bz);
        for (const b of boxes) {
          const bx0 = bx + b[0], bx1 = bx + b[3], by0 = by + b[1], by1 = by + b[4], bz0 = bz + b[2], bz1 = bz + b[5];
          if (!(bx1 > minX && bx0 < maxX && by1 > minY && by0 < maxY && bz1 > minZ && bz0 < maxZ)) continue;
          const lo = axis === 'x' ? bx0 : axis === 'y' ? by0 : bz0;
          const hi = axis === 'x' ? bx1 : axis === 'y' ? by1 : bz1;
          if (d > 0) { if (!hit || lo < limit) limit = lo; }
          else if (!hit || hi > limit) limit = hi;
          hit = true;
        }
      }
    }
  }
  if (!hit) return false;
  // resolve along the moving axis (a still axis only reports the contact)
  if (axis === 'x') {
    if (d > 0) pos.x = limit - hw - EPS;
    else if (d < 0) pos.x = limit + hw + EPS;
    vel.x = 0;
  } else if (axis === 'y') {
    if (d > 0) pos.y = limit - box.h - EPS;
    else if (d < 0) pos.y = limit + EPS;
    vel.y = 0;
  } else {
    if (d > 0) pos.z = limit - hw - EPS;
    else if (d < 0) pos.z = limit + hw + EPS;
    vel.z = 0;
  }
  return true;
}

/** Try to walk `delta` along `axis` by first lifting up to STEP_HEIGHT onto a
 *  low ledge (slab, stair). Commits and returns true only if it fits. */
function tryStep(world: World, pos: Vec3, box: EntBox, axis: 'x' | 'z', delta: number): boolean {
  const start = { ...pos };
  pos.y += STEP_HEIGHT;
  if (overlapsAny(world, pos, box)) { Object.assign(pos, start); return false; }
  if (axis === 'x') pos.x += delta; else pos.z += delta;
  if (overlapsAny(world, pos, box)) { Object.assign(pos, start); return false; }
  // settle back down onto whatever we stepped up on
  const down = { x: 0, y: -STEP_HEIGHT - 0.01, z: 0 };
  pos.y += down.y;
  if (collideAxis(world, pos, box, 'y', down) && pos.y >= start.y + EPS) return true;
  Object.assign(pos, start); // nothing to climb onto
  return false;
}

/**
 * Move an entity with axis-separated sweeps + substepping against tunneling.
 * `sneak` keeps the entity from walking off edges (requires prior onGround).
 */
export function moveEntity(
  world: World, pos: Vec3, vel: Vec3, dt: number, box: EntBox,
  sneak = false, wasOnGround = false,
): MoveResult {
  const res: MoveResult = { onGround: false, hitX: false, hitY: false, hitZ: false };
  const maxStep = 0.4;
  const maxDelta = Math.max(Math.abs(vel.x), Math.abs(vel.y), Math.abs(vel.z)) * dt;
  const steps = Math.max(1, Math.ceil(maxDelta / maxStep));
  const sdt = dt / steps;

  for (let s = 0; s < steps; s++) {
    // Y
    const fallingBefore = vel.y;
    pos.y += vel.y * sdt;
    if (collideAxis(world, pos, box, 'y', vel)) {
      res.hitY = true;
      if (fallingBefore <= 0) res.onGround = true;
    }
    const grounded = wasOnGround || res.onGround;
    // X (with sneak edge guard + step-up onto low ledges)
    const oldX = pos.x, dx = vel.x * sdt;
    pos.x += dx;
    if (collideAxis(world, pos, box, 'x', vel)) {
      const blockedX = pos.x;
      pos.x = oldX;
      if (grounded && dx !== 0 && tryStep(world, pos, box, 'x', dx)) vel.x = dx / sdt;
      else { pos.x = blockedX; res.hitX = true; }
    }
    if (sneak && wasOnGround && !hasSupport(world, pos, box)) {
      pos.x = oldX;
      vel.x = 0;
    }
    // Z
    const oldZ = pos.z, dz = vel.z * sdt;
    pos.z += dz;
    if (collideAxis(world, pos, box, 'z', vel)) {
      const blockedZ = pos.z;
      pos.z = oldZ;
      if (grounded && dz !== 0 && tryStep(world, pos, box, 'z', dz)) vel.z = dz / sdt;
      else { pos.z = blockedZ; res.hitZ = true; }
    }
    if (sneak && wasOnGround && !hasSupport(world, pos, box)) {
      pos.z = oldZ;
      vel.z = 0;
    }
  }

  // settled-on-ground check (covers standing still)
  if (!res.onGround && vel.y === 0 && hasSupport(world, pos, box, 0.05)) {
    res.onGround = true;
  }
  return res;
}

/** Is there solid ground under the AABB within `depth` blocks? */
export function hasSupport(world: World, pos: Vec3, box: EntBox, depth = 0.6): boolean {
  const hw = box.w / 2;
  const minX = pos.x - hw, maxX = pos.x + hw, minZ = pos.z - hw, maxZ = pos.z + hw;
  const x0 = Math.floor(minX), x1 = Math.floor(maxX - EPS);
  const z0 = Math.floor(minZ), z1 = Math.floor(maxZ - EPS);
  const y0 = Math.floor(pos.y - depth) - 1, y1 = Math.floor(pos.y - EPS);
  for (let by = y0; by <= y1; by++) {
    for (let bz = z0; bz <= z1; bz++) {
      for (let bx = x0; bx <= x1; bx++) {
        for (const b of cellBoxes(world, bx, by, bz)) {
          if (bx + b[3] <= minX || bx + b[0] >= maxX || bz + b[5] <= minZ || bz + b[2] >= maxZ) continue;
          const top = by + b[4], bot = by + b[1];
          if (top > pos.y - depth && bot < pos.y - EPS) return true;
        }
      }
    }
  }
  return false;
}

/** Does the entity AABB overlap the given block cell? */
export function boxIntersectsBlock(pos: Vec3, box: EntBox, bx: number, by: number, bz: number): boolean {
  const hw = box.w / 2;
  return pos.x + hw > bx && pos.x - hw < bx + 1 &&
    pos.y + box.h > by && pos.y < by + 1 &&
    pos.z + hw > bz && pos.z - hw < bz + 1;
}

/** Center of the entity is inside water? */
export function inWater(world: World, pos: Vec3, box: EntBox): boolean {
  return world.getBlock(Math.floor(pos.x), Math.floor(pos.y + box.h * 0.5), Math.floor(pos.z)) === B.WATER;
}

export function eyeInWater(world: World, pos: Vec3, eyeHeight: number): boolean {
  return world.getBlock(Math.floor(pos.x), Math.floor(pos.y + eyeHeight), Math.floor(pos.z)) === B.WATER;
}

/** Slab-method ray vs AABB; returns entry distance or null. */
export function rayAABB(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
): number | null {
  let tmin = -Infinity, tmax = Infinity;
  const axes: [number, number, number, number][] = [
    [ox, dx, minX, maxX], [oy, dy, minY, maxY], [oz, dz, minZ, maxZ],
  ];
  for (const [o, d, mn, mx] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (o < mn || o > mx) return null;
    } else {
      let t1 = (mn - o) / d, t2 = (mx - o) / d;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  if (tmax < 0) return null;
  return Math.max(0, tmin);
}
