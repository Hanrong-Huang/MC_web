// Sliding AABB collision for the player, mobs, and item drops.
// Entities are positioned by the center of their feet (pos.y = bottom of AABB).

import { World } from './World';
import { B } from './Blocks';

export interface Vec3 { x: number; y: number; z: number }
export interface EntBox { w: number; h: number } // full width (x=z) and height

export interface MoveResult {
  onGround: boolean;
  hitX: boolean;
  hitY: boolean;
  hitZ: boolean;
}

const EPS = 0.001;

function collideAxis(world: World, pos: Vec3, box: EntBox, axis: 'x' | 'y' | 'z', vel: Vec3): boolean {
  const hw = box.w / 2;
  const minX = pos.x - hw, maxX = pos.x + hw;
  const minY = pos.y, maxY = pos.y + box.h;
  const minZ = pos.z - hw, maxZ = pos.z + hw;

  const x0 = Math.floor(minX), x1 = Math.floor(maxX - EPS / 2);
  const y0 = Math.floor(minY), y1 = Math.floor(maxY - EPS / 2);
  const z0 = Math.floor(minZ), z1 = Math.floor(maxZ - EPS / 2);

  let hit = false;
  for (let by = y0; by <= y1; by++) {
    for (let bz = z0; bz <= z1; bz++) {
      for (let bx = x0; bx <= x1; bx++) {
        if (!world.isSolidAt(bx, by, bz)) continue;
        // resolve along the moving axis
        if (axis === 'x') {
          if (vel.x > 0) pos.x = bx - hw - EPS;
          else if (vel.x < 0) pos.x = bx + 1 + hw + EPS;
          vel.x = 0;
        } else if (axis === 'y') {
          if (vel.y > 0) pos.y = by - box.h - EPS;
          else if (vel.y < 0) pos.y = by + 1 + EPS;
          vel.y = 0;
        } else {
          if (vel.z > 0) pos.z = bz - hw - EPS;
          else if (vel.z < 0) pos.z = bz + 1 + hw + EPS;
          vel.z = 0;
        }
        hit = true;
        return hit; // re-test from the corrected position is unnecessary for unit cells
      }
    }
  }
  return hit;
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
    // X (with sneak edge guard)
    const oldX = pos.x;
    pos.x += vel.x * sdt;
    if (collideAxis(world, pos, box, 'x', vel)) res.hitX = true;
    if (sneak && wasOnGround && !hasSupport(world, pos, box)) {
      pos.x = oldX;
      vel.x = 0;
    }
    // Z
    const oldZ = pos.z;
    pos.z += vel.z * sdt;
    if (collideAxis(world, pos, box, 'z', vel)) res.hitZ = true;
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
  const x0 = Math.floor(pos.x - hw), x1 = Math.floor(pos.x + hw - EPS);
  const z0 = Math.floor(pos.z - hw), z1 = Math.floor(pos.z + hw - EPS);
  const y0 = Math.floor(pos.y - depth), y1 = Math.floor(pos.y - EPS);
  for (let by = y0; by <= y1; by++) {
    for (let bz = z0; bz <= z1; bz++) {
      for (let bx = x0; bx <= x1; bx++) {
        if (world.isSolidAt(bx, by, bz)) return true;
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
