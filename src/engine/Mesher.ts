// Face-culled chunk meshing with Minecraft-style per-face shading, per-vertex
// ambient occlusion, heightmap skylight, and BFS flood-fill torch light.
// Each vertex carries a 2-channel "alight" attribute: x = sky-lit component
// (scaled by the day/night uniform in the shader), y = torch-lit component.

import * as THREE from 'three';
import { World } from './World';
import { Chunk, CX, CZ, CY } from './Chunk';
import { B, def, isOpaque, occludes, OPAQUE_LUT, CROSS_BLOCKS, TINTED_TILES } from './Blocks';
import { Atlas, UVRect } from './Textures';

// face order: +x, -x, +y, -y, +z, -z
const FACE_NORMALS = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
] as const;

// per-face shading: top 100%, bottom 50%, z (north/south) 80%, x (east/west) 60%
const FACE_SHADE = [0.6, 0.6, 1.0, 0.5, 0.8, 0.8];
const LIQUID_SOURCE_HEIGHT = 14 / 16;
const LIQUID_EDGE_HEIGHT = 8 / 16;

// origin + tangent axes with u x v = normal (CCW winding seen from outside)
const FACE_GEO: { o: number[]; u: number[]; v: number[] }[] = [
  { o: [1, 0, 1], u: [0, 0, -1], v: [0, 1, 0] }, // +x
  { o: [0, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },  // -x
  { o: [0, 1, 1], u: [1, 0, 0], v: [0, 0, -1] }, // +y
  { o: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1] },  // -y
  { o: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },  // +z
  { o: [1, 0, 0], u: [-1, 0, 0], v: [0, 1, 0] }, // -z
];

const AO_SHADE = [0.45, 0.65, 0.84, 1.0];

const TORCH_LEVEL = 14;
const MAX_LIGHT = 15;

// shared flood-fill region: chunk plus a 15-block margin on each side
const RX0 = -15, RX1 = 30;
const RW = RX1 - RX0 + 1; // 46
const REGION = new Uint8Array(RW * RW * CY);
const QUEUE = new Int32Array(RW * RW * 8);

function regionIdx(rx: number, rz: number, y: number): number {
  return (rx - RX0) + (rz - RX0) * RW + y * RW * RW;
}

function faceTile(id: number, face: number): string {
  const f = def(id).faces!;
  if (face === 2) return f.top;
  if (face === 3) return f.bottom;
  if ((face === 4 || face === 5) && f.front) return f.front;
  return f.sides;
}

class GeoBuilder {
  positions: number[] = [];
  lights: number[] = [];
  tints: number[] = [];
  uvs: number[] = [];
  indices: number[] = [];
  vertCount = 0;

  build(): THREE.BufferGeometry | null {
    if (this.vertCount === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('alight', new THREE.Float32BufferAttribute(this.lights, 2));
    g.setAttribute('atint', new THREE.Float32BufferAttribute(this.tints, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setIndex(this.indices);
    g.computeBoundingSphere();
    return g;
  }
}

// per-chunk column tint cache (biome grass/foliage color)
const TINT_CACHE = new Float32Array(256 * 3);
const TINT_SET = new Uint8Array(256);
const tintScratch = { r: 1, g: 1, b: 1 };

export interface ChunkGeometry {
  solid: THREE.BufferGeometry | null;
  water: THREE.BufferGeometry | null;
}

export function buildChunkGeometry(world: World, chunk: Chunk, atlas: Atlas): ChunkGeometry {
  const solid = new GeoBuilder();
  const water = new GeoBuilder();
  const bx = chunk.cx * CX, bz = chunk.cz * CZ;
  let maxY = 1;
  for (let i = 0; i < chunk.heightmap.length; i++) {
    if (chunk.heightmap[i] > maxY) maxY = chunk.heightmap[i];
  }
  maxY = Math.min(CY, maxY + 3);

  // cache the 3x3 chunk neighborhood for fast lookups
  const refs: (Chunk | undefined)[] = [];
  for (let cz = -1; cz <= 1; cz++) {
    for (let cx = -1; cx <= 1; cx++) {
      const c = world.getChunk(chunk.cx + cx, chunk.cz + cz);
      refs.push(c && c.ready ? c : undefined);
    }
  }
  const chunkAt = (rx: number, rz: number): Chunk | undefined =>
    refs[(rx >> 4) + 1 + ((rz >> 4) + 1) * 3];

  // local getter with cross-chunk fallback (region coords; outside region -> world)
  const get = (x: number, y: number, z: number): number => {
    if (y < 0) return B.BEDROCK;
    if (y >= CY) return B.AIR;
    if (x >= RX0 && x <= RX1 && z >= RX0 && z <= RX1) {
      const c = chunkAt(x, z);
      if (!c) return B.STONE; // unloaded frontier reads as opaque
      return c.data[(x & 15) | ((z & 15) << 4) | (y << 8)];
    }
    return world.getBlockForMesh(bx + x, y, bz + z);
  };
  const liquidCellHeight = (id: number, x: number, y: number, z: number): number => {
    if (get(x, y, z) !== id) return 0;
    if (get(x, y + 1, z) === id) return 1;
    const wx = bx + x, wz = bz + z;
    const level = id === B.LAVA ? world.lavaLevel(wx, y, wz) : world.waterLevel(wx, y, wz);
    const maxLevel = id === B.LAVA ? 3 : 7;
    if (level <= 0) return LIQUID_SOURCE_HEIGHT;
    return LIQUID_SOURCE_HEIGHT - (LIQUID_SOURCE_HEIGHT - LIQUID_EDGE_HEIGHT) * Math.min(1, level / maxLevel);
  };
  const liquidCornerHeight = (id: number, x: number, y: number, z: number, px: number, pz: number): number => {
    const sx = px < 0.5 ? -1 : 1;
    const sz = pz < 0.5 ? -1 : 1;
    let sum = 0;
    let n = 0;
    for (const [dx, dz] of [[0, 0], [sx, 0], [0, sz], [sx, sz]]) {
      const h = liquidCellHeight(id, x + dx, y, z + dz);
      if (h <= 0) continue;
      sum += h;
      n++;
    }
    return n > 0 ? sum / n : LIQUID_EDGE_HEIGHT;
  };
  const skyAt = (x: number, y: number, z: number): number => {
    if (y >= CY) return 1;
    const c = chunkAt(x, z);
    if (!c) return 1;
    return c.skyLight(x & 15, Math.max(0, y), z & 15);
  };
  const occ = (x: number, y: number, z: number): number => (occludes(get(x, y, z)) ? 1 : 0);

  // biome tint per column, computed lazily
  TINT_SET.fill(0);
  const tintAt = (x: number, z: number): Float32Array => {
    const ci = (x & 15) | ((z & 15) << 4);
    if (!TINT_SET[ci]) {
      TINT_SET[ci] = 1;
      world.generator.grassTint(bx + x, bz + z, tintScratch);
      TINT_CACHE[ci * 3] = tintScratch.r;
      TINT_CACHE[ci * 3 + 1] = tintScratch.g;
      TINT_CACHE[ci * 3 + 2] = tintScratch.b;
    }
    return TINT_CACHE.subarray(ci * 3, ci * 3 + 3);
  };

  // --- torch flood fill ------------------------------------------------------
  let hasTorches = false;
  for (const c of refs) if (c && c.torches.size > 0) { hasTorches = true; break; }
  if (hasTorches) {
    REGION.fill(0);
    let qHead = 0, qTail = 0;
    const push = (idx: number) => { QUEUE[qTail++ % QUEUE.length] = idx; };
    for (const c of refs) {
      if (!c || c.torches.size === 0) continue;
      const ox = c.cx * CX - bx, oz = c.cz * CZ - bz;
      for (const t of c.torches) {
        const rx = ox + (t & 15), rz = oz + ((t >> 4) & 15), ry = t >> 8;
        if (rx < RX0 || rx > RX1 || rz < RX0 || rz > RX1) continue;
        const ri = regionIdx(rx, rz, ry);
        if (REGION[ri] < TORCH_LEVEL) {
          REGION[ri] = TORCH_LEVEL;
          push(ri);
        }
      }
    }
    while (qHead < qTail) {
      const ri = QUEUE[qHead++ % QUEUE.length];
      const level = REGION[ri];
      if (level <= 1) continue;
      const y = (ri / (RW * RW)) | 0;
      const rem = ri - y * RW * RW;
      const rz = ((rem / RW) | 0) + RX0;
      const rx = (rem % RW) + RX0;
      const nl = level - 1;
      // 6-neighbor spread through non-opaque cells
      const tryCell = (nx: number, ny: number, nz: number): void => {
        if (nx < RX0 || nx > RX1 || nz < RX0 || nz > RX1 || ny < 0 || ny >= CY) return;
        const ni = regionIdx(nx, nz, ny);
        if (REGION[ni] >= nl) return;
        const c = chunkAt(nx, nz);
        if (!c) return;
        const id = c.data[(nx & 15) | ((nz & 15) << 4) | (ny << 8)];
        if (OPAQUE_LUT[id]) return;
        REGION[ni] = nl;
        if (qTail - qHead < QUEUE.length - 1) push(ni);
      };
      tryCell(rx + 1, y, rz); tryCell(rx - 1, y, rz);
      tryCell(rx, y + 1, rz); tryCell(rx, y - 1, rz);
      tryCell(rx, y, rz + 1); tryCell(rx, y, rz - 1);
    }
  }
  const torchAt = (x: number, y: number, z: number): number => {
    if (!hasTorches || y < 0 || y >= CY || x < RX0 || x > RX1 || z < RX0 || z > RX1) return 0;
    return REGION[regionIdx(x, z, y)] / MAX_LIGHT;
  };

  // --- geometry --------------------------------------------------------------
  for (let y = 0; y < maxY; y++) {
    for (let z = 0; z < CZ; z++) {
      for (let x = 0; x < CX; x++) {
        const id = chunk.data[x | (z << 4) | (y << 8)];
        if (id === B.AIR) continue;

        if (id === B.TORCH) {
          const facing = world.torchFacings.get(`${bx + x},${y},${bz + z}`);
          emitTorch(solid, atlas, x, y, z, skyAt(x, y, z), torchAt(x, y, z), facing);
          continue;
        }
        if (id === B.DOOR_LOWER || id === B.DOOR_UPPER) {
          const st = world.doorStateAt(bx + x, y, bz + z);
          const facing = st?.facing ?? 0;
          const hingeRight = !!st?.hingeRight;
          const swing = st?.swing ?? (st?.open ? 1 : 0);
          emitDoor(solid, atlas, id, x, y, z, facing, hingeRight, swing, skyAt(x, y, z), torchAt(x, y, z));
          continue;
        }
        if (id === B.LADDER) {
          emitLadder(solid, atlas, x, y, z, skyAt(x, y, z), torchAt(x, y, z));
          continue;
        }
        if (id === B.TRAPDOOR) {
          const open = !!world.doorStates.get(`${bx + x},${y},${bz + z}`)?.open;
          emitTrapdoor(solid, atlas, x, y, z, open, skyAt(x, y, z), torchAt(x, y, z));
          continue;
        }
        if (id === B.PRESSURE_PLATE) {
          const state = world.redstoneStates.get(`${bx + x},${y},${bz + z}`);
          const active = !!state?.active;
          emitPressurePlate(solid, atlas, x, y, z, skyAt(x, y, z), torchAt(x, y, z), active);
          continue;
        }
        if (id === B.LEVER) {
          const state = world.redstoneStates.get(`${bx + x},${y},${bz + z}`);
          const active = !!state?.active;
          const facing = state?.facing ?? 1;
          emitLever(solid, atlas, x, y, z, skyAt(x, y, z), torchAt(x, y, z), active, facing);
          continue;
        }
        if (id === B.WOODEN_BUTTON || id === B.STONE_BUTTON) {
          const state = world.redstoneStates.get(`${bx + x},${y},${bz + z}`);
          const active = !!state?.active;
          const facing = state?.facing ?? 1;
          emitButton(solid, atlas, id, x, y, z, skyAt(x, y, z), torchAt(x, y, z), active, facing);
          continue;
        }
        if (id === B.REDSTONE_WIRE) {
          const power = world.redstonePower.get(`${bx + x},${y},${bz + z}`) ?? 0;
          emitRedstoneWire(solid, atlas, x, y, z, skyAt(x, y, z), torchAt(x, y, z), power);
          continue;
        }
        if (CROSS_BLOCKS.has(id)) {
          const tileName = def(id).faces!.sides;
          const tint = TINTED_TILES.has(tileName) ? tintAt(x, z) : null;
          emitCross(solid, atlas, id, x, y, z, skyAt(x, y, z), torchAt(x, y, z), tint);
          continue;
        }

        const d = def(id);
        const isWater = id === B.WATER;
        const isLava = id === B.LAVA;
        const isLiquid = isWater || isLava;
        const target = isLiquid ? water : solid;
        const waterTopOpen = isLiquid && get(x, y + 1, z) !== id;

        for (let face = 0; face < 6; face++) {
          const n = FACE_NORMALS[face];
          const nb = get(x + n[0], y + n[1], z + n[2]);

          // culling rules
          if (isLiquid) {
            if (nb === id) continue;
            if (isOpaque(nb)) continue;
            if (nb !== B.AIR && nb !== B.LEAVES && nb !== B.TORCH && face !== 2) continue;
          } else if (d.opaque) {
            if (isOpaque(nb)) continue;
          } else {
            // cutout blocks (leaves, glass): cull against opaque and same type
            if (isOpaque(nb) || nb === id) continue;
          }

          const tileName = faceTile(id, face);
          const geo = FACE_GEO[face];
          const rect = atlas.rect(tileName);
          const shade = FACE_SHADE[face];
          const base = target.vertCount;
          const tint = TINTED_TILES.has(tileName) ? tintAt(x, z) : null;
          const aos: number[] = [];

          for (let corner = 0; corner < 4; corner++) {
            const a = corner === 1 || corner === 2 ? 1 : 0; // u coefficient
            const b = corner >= 2 ? 1 : 0;                  // v coefficient
            let px = geo.o[0] + a * geo.u[0] + b * geo.v[0];
            let py = geo.o[1] + a * geo.u[1] + b * geo.v[1];
            let pz = geo.o[2] + a * geo.u[2] + b * geo.v[2];
            if (waterTopOpen && py === 1) py = liquidCornerHeight(id, x, y, z, px, pz);

            // AO + smooth light sampled in the cell layer in front of the face
            const cx0 = x + n[0], cy0 = y + n[1], cz0 = z + n[2];
            const su = a ? geo.u : [-geo.u[0], -geo.u[1], -geo.u[2]];
            const sv = b ? geo.v : [-geo.v[0], -geo.v[1], -geo.v[2]];
            const s1 = occ(cx0 + su[0], cy0 + su[1], cz0 + su[2]);
            const s2 = occ(cx0 + sv[0], cy0 + sv[1], cz0 + sv[2]);
            const sc = occ(cx0 + su[0] + sv[0], cy0 + su[1] + sv[1], cz0 + su[2] + sv[2]);
            const aoLevel = isLiquid ? 3 : s1 && s2 ? 0 : 3 - (s1 + s2 + sc);
            aos.push(aoLevel);

            const sky = (
              skyAt(cx0, cy0, cz0) +
              skyAt(cx0 + su[0], cy0 + su[1], cz0 + su[2]) +
              skyAt(cx0 + sv[0], cy0 + sv[1], cz0 + sv[2]) +
              skyAt(cx0 + su[0] + sv[0], cy0 + su[1] + sv[1], cz0 + su[2] + sv[2])
            ) / 4;
            const torch = (
              torchAt(cx0, cy0, cz0) +
              torchAt(cx0 + su[0], cy0 + su[1], cz0 + su[2]) +
              torchAt(cx0 + sv[0], cy0 + sv[1], cz0 + sv[2]) +
              torchAt(cx0 + su[0] + sv[0], cy0 + su[1] + sv[1], cz0 + su[2] + sv[2])
            ) / 4;

            const k = shade * AO_SHADE[aoLevel];
            target.positions.push(x + px, y + py, z + pz);
            target.lights.push(k * sky, k * torch);
            if (tint) target.tints.push(tint[0], tint[1], tint[2]);
            else target.tints.push(1, 1, 1);
            target.uvs.push(
              a ? rect.u1 : rect.u0,
              b ? rect.v0 : rect.v1, // b=1 is the face top -> image top (flipY=false)
            );
          }

          // flip the quad diagonal when AO is anisotropic
          if (aos[0] + aos[2] >= aos[1] + aos[3]) {
            target.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
          } else {
            target.indices.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
          }
          target.vertCount += 4;
        }
      }
    }
  }

  return { solid: solid.build(), water: water.build() };
}

/** Crossed billboards for plants (flowers, grass, sugar cane). Both windings
 *  are emitted so the front-face-culled chunk material shows them from any side. */
function emitCross(g: GeoBuilder, atlas: Atlas, id: number, x: number, y: number, z: number, sky: number, torch: number, tint: Float32Array | null): void {
  const rect = atlas.rect(def(id).faces!.sides);
  const a = 0.146, b = 0.854; // ~ MC's sqrt(2)/2-inset diagonal
  const planes: [number, number, number, number][] = [
    [a, a, b, b],
    [a, b, b, a],
  ];
  for (const [x0, z0, x1, z1] of planes) {
    for (const flip of [false, true]) {
      const base = g.vertCount;
      const corners = flip
        ? [[x1, 0, z1], [x0, 0, z0], [x0, 1, z0], [x1, 1, z1]]
        : [[x0, 0, z0], [x1, 0, z1], [x1, 1, z1], [x0, 1, z0]];
      const us = [rect.u0, rect.u1, rect.u1, rect.u0];
      const vs = [rect.v1, rect.v1, rect.v0, rect.v0];
      for (let i = 0; i < 4; i++) {
        g.positions.push(x + corners[i][0], y + corners[i][1], z + corners[i][2]);
        g.lights.push(sky, torch);
        if (tint) g.tints.push(tint[0], tint[1], tint[2]);
        else g.tints.push(1, 1, 1);
        g.uvs.push(us[i], vs[i]);
      }
      g.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      g.vertCount += 4;
    }
  }
}

/** Small torch model: a 2/16-wide column, 10/16 tall. With `facing` (0=+x,
 *  1=-x, 2=+z, 3=-z) it becomes a wall torch — raised, leaned away from the
 *  wall, and offset so its base sits against that wall face. */
function emitTorch(
  g: GeoBuilder, atlas: Atlas, x: number, y: number, z: number,
  sky: number, torch: number, facing?: number,
): void {
  const rect = atlas.rect('torch');
  const du = rect.u1 - rect.u0, dv = rect.v1 - rect.v0;
  const lo = 7 / 16, hi = 9 / 16, top = 10 / 16;
  const u0 = rect.u0 + 7 / 16 * du, u1 = rect.u0 + 9 / 16 * du;
  const vTop = rect.v0 + 6 / 16 * dv, vBottom = rect.v1;

  // wall mounting: lean angle + anchor against the wall opposite `facing`
  let wallX = 0, wallZ = 0, ax = 0.5, ay = 0, az = 0.5, sinL = 0, cosL = 1;
  if (facing !== undefined) {
    wallX = facing === 0 ? 1 : facing === 1 ? -1 : 0;
    wallZ = facing === 2 ? 1 : facing === 3 ? -1 : 0;
    const lean = 0.42; // radians the top tilts out into the room
    sinL = Math.sin(lean); cosL = Math.cos(lean);
    ax = 0.5 - wallX * 0.42; // base near the wall face
    az = 0.5 - wallZ * 0.42;
    ay = 0.22;               // raised up the wall
  }
  // transform a local column point (centered on x/z, height py) by the lean
  const tx = (px: number, py: number): number => ax + (px - 0.5) + wallX * py * sinL;
  const ty = (py: number): number => ay + py * cosL;
  const tz = (pz: number, py: number): number => az + (pz - 0.5) + wallZ * py * sinL;

  const push = (px: number, py: number, pz: number, u: number, v: number): void => {
    g.positions.push(x + tx(px, py), y + ty(py), z + tz(pz, py));
    g.lights.push(sky, Math.max(torch, 0.9)); // a torch always glows itself
    g.tints.push(1, 1, 1);
    g.uvs.push(u, v);
  };
  const quads: number[][][] = [
    [[hi, 0, hi], [hi, 0, lo], [hi, top, lo], [hi, top, hi]],   // +x
    [[lo, 0, lo], [lo, 0, hi], [lo, top, hi], [lo, top, lo]],   // -x
    [[lo, 0, hi], [hi, 0, hi], [hi, top, hi], [lo, top, hi]],   // +z
    [[hi, 0, lo], [lo, 0, lo], [lo, top, lo], [hi, top, lo]],   // -z
  ];
  for (const q of quads) {
    const base = g.vertCount;
    push(q[0][0], q[0][1], q[0][2], u0, vBottom);
    push(q[1][0], q[1][1], q[1][2], u1, vBottom);
    push(q[2][0], q[2][1], q[2][2], u1, vTop);
    push(q[3][0], q[3][1], q[3][2], u0, vTop);
    g.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    g.vertCount += 4;
  }
  // tip (flame top)
  const base = g.vertCount;
  const tu0 = rect.u0 + 7 / 16 * du, tu1 = rect.u0 + 9 / 16 * du;
  const tv0 = rect.v0 + 6 / 16 * dv, tv1 = rect.v0 + 8 / 16 * dv;
  push(lo, top, hi, tu0, tv1);
  push(hi, top, hi, tu1, tv1);
  push(hi, top, lo, tu1, tv0);
  push(lo, top, lo, tu0, tv0);
  g.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  g.vertCount += 4;
}

/** Door panels are thin slabs; geometry is computed in doorFootprints below. */
const DOOR_INSET = 1 / 128; // keep the leaf off block walls to avoid z-fighting

/** Closed/open panel footprints (BL=hinge-outer, then around the rectangle).
 *  Closed: thin slab flush against the player-facing block edge, filling the
 *  doorway (vanilla MC). Open: swung 90deg flat against the perpendicular wall
 *  on the hinge side, thickness pointing into the room. Both stay in-bounds and
 *  share the outer hinge corner (footprint[0]) so the swing pivots there. */
function doorFootprints(
  facing: number, hingeRight: boolean, t: number,
): { closed: [number, number][]; open: [number, number][] } {
  const e = DOOR_INSET;
  const lo = e, hi = 1 - e;
  switch (facing) {
    case 0: // N=+z, flush at z=hi
      return hingeRight
        ? { closed: [[hi, hi], [lo, hi], [lo, hi - t], [hi, hi - t]],
            open: [[hi, hi], [hi, lo], [hi - t, lo], [hi - t, hi]] }
        : { closed: [[lo, hi], [hi, hi], [hi, hi - t], [lo, hi - t]],
            open: [[lo, hi], [lo, lo], [lo + t, lo], [lo + t, hi]] };
    case 2: // N=-z, flush at z=lo
      return hingeRight
        ? { closed: [[hi, lo], [lo, lo], [lo, lo + t], [hi, lo + t]],
            open: [[hi, lo], [hi, hi], [hi - t, hi], [hi - t, lo]] }
        : { closed: [[lo, lo], [hi, lo], [hi, lo + t], [lo, lo + t]],
            open: [[lo, lo], [lo, hi], [lo + t, hi], [lo + t, lo]] };
    case 1: // N=+x, flush at x=hi
      return hingeRight
        ? { closed: [[hi, lo], [hi, hi], [hi - t, hi], [hi - t, lo]],
            open: [[hi, lo], [lo, lo], [lo, lo + t], [hi, lo + t]] }
        : { closed: [[hi, hi], [hi, lo], [hi - t, lo], [hi - t, hi]],
            open: [[hi, hi], [lo, hi], [lo, hi - t], [hi, hi - t]] };
    default: // N=-x, flush at x=lo
      return hingeRight
        ? { closed: [[lo, hi], [lo, lo], [lo + t, lo], [lo + t, hi]],
            open: [[lo, hi], [hi, hi], [hi, hi - t], [lo, hi - t]] }
        : { closed: [[lo, lo], [lo, hi], [lo + t, hi], [lo + t, lo]],
            open: [[lo, lo], [hi, lo], [hi, lo + t], [lo, lo + t]] };
  }
}

/** Interpolate the leaf between closed and open. Corner-lerp with smoothstep:
 *  the outer hinge corner is fixed and the thin slab stays inside the cell at
 *  every angle, so it never clips neighbouring blocks. */
function doorSwingFootprint(
  facing: number, hingeRight: boolean, swing: number, t: number,
): [number, number][] {
  const { closed, open } = doorFootprints(facing, hingeRight, t);
  if (swing <= 0) return closed;
  if (swing >= 1) return open;
  const s = swing * swing * (3 - 2 * swing);
  return closed.map(([cx, cz], i) => {
    const [ox, oz] = open[i];
    return [cx + (ox - cx) * s, cz + (oz - cz) * s];
  });
}

/** Door leaf hinged on a vertical edge; swing 0..1 rotates it 90deg inward.
 *  Geometry stays inside the block cell so it never clips neighbours. */
function emitDoor(
  g: GeoBuilder, atlas: Atlas, id: number, x: number, y: number, z: number,
  facing: number, hingeRight: boolean, swing: number, sky: number, torch: number,
): void {
  const rect = atlas.rect(id === B.DOOR_UPPER ? 'door_upper' : 'door_lower');
  const t = 2 / 16;
  const foot = doorSwingFootprint(facing, hingeRight, swing, t);
  emitDoorPanel(g, x, y, z, foot, rect, sky, torch);
}

/** Textured door slab from four bottom xz corners (y spans 0..1 in the cell). */
function emitDoorPanel(
  g: GeoBuilder, bx: number, by: number, bz: number,
  foot: [number, number][],
  rect: { u0: number; u1: number; v0: number; v1: number },
  sky: number, torch: number,
): void {
  const { u0, u1, v0, v1 } = rect;
  const y0 = 0, y1 = 1;
  const bot = foot.map(([px, pz]) => [px, y0, pz]);
  const top = foot.map(([px, pz]) => [px, y1, pz]);
  const pushQuad = (corners: number[][], us: number[], vs: number[]): void => {
    const base = g.vertCount;
    for (let i = 0; i < 4; i++) {
      g.positions.push(bx + corners[i][0], by + corners[i][1], bz + corners[i][2]);
      g.lights.push(sky, torch);
      g.tints.push(1, 1, 1);
      g.uvs.push(us[i], vs[i]);
    }
    g.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    g.vertCount += 4;
  };
  const faceU = [u0, u1, u1, u0];
  const faceV = [v1, v1, v0, v0];
  const edgeU = [u0, u1, u1, u0];
  const edgeV = [v1, v1, v0, v0];

  // front/back: average the two side quads' winding from the footprint
  pushQuad([bot[0], bot[1], top[1], top[0]], faceU, faceV);
  pushQuad([bot[2], bot[3], top[3], top[2]], faceU, faceV);
  pushQuad([bot[1], bot[2], top[2], top[1]], edgeU, edgeV);
  pushQuad([bot[3], bot[0], top[0], top[3]], edgeU, edgeV);
  pushQuad([bot[0], bot[1], bot[2], bot[3]], edgeU, edgeV);
  pushQuad([top[2], top[1], top[0], top[3]], edgeU, edgeV);
}

/** Ladder: a flat panel against the back of the cell, 1/16 off the wall. */
function emitLadder(g: GeoBuilder, atlas: Atlas, x: number, y: number, z: number, sky: number, torch: number): void {
  const rect = atlas.rect('ladder');
  const off = 2 / 16;
  // emit against all four walls cheaply — the cull rules above already filter,
  // and double-sided chunk material shows it from any side
  const faces: number[][][] = [
    // +z wall (ladder facing -z, climber between)
    [[x + off, y, z + 1], [x + 1 - off, y, z + 1], [x + 1 - off, y + 1, z + 1], [x + off, y + 1, z + 1]],
    // -z wall
    [[x + 1 - off, y, z], [x + off, y, z], [x + off, y + 1, z], [x + 1 - off, y + 1, z]],
    // +x wall
    [[x + 1, y, z + 1 - off], [x + 1, y, z + off], [x + 1, y + 1, z + off], [x + 1, y + 1, z + 1 - off]],
    // -x wall
    [[x, y, z + off], [x, y, z + 1 - off], [x, y + 1, z + 1 - off], [x, y + 1, z + off]],
  ];
  for (const q of faces) {
    const base = g.vertCount;
    for (let i = 0; i < 4; i++) {
      g.positions.push(q[i][0], q[i][1], q[i][2]);
      g.lights.push(sky, torch);
      g.tints.push(1, 1, 1);
      g.uvs.push(i === 0 || i === 3 ? rect.u0 : rect.u1, i < 2 ? rect.v1 : rect.v0);
    }
    g.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    g.vertCount += 4;
  }
}

/** Trapdoor: flat panel flush with the floor when closed, upright when open. */
function emitTrapdoor(g: GeoBuilder, atlas: Atlas, x: number, y: number, z: number, open: boolean, sky: number, torch: number): void {
  const rect = atlas.rect('trapdoor');
  const thick = 3 / 16;
  const base = g.vertCount;
  let corners: number[][];
  if (open) {
    // standing upright along +z edge
    corners = [
      [x + 0, y + 0, z + 1 - thick], [x + 1, y + 0, z + 1 - thick],
      [x + 1, y + 1, z + 1 - thick], [x + 0, y + 1, z + 1 - thick],
    ];
  } else {
    // flush with the cell top
    corners = [
      [x + 0, y + 1 - thick, z + 0], [x + 1, y + 1 - thick, z + 0],
      [x + 1, y + 1 - thick, z + 1], [x + 0, y + 1 - thick, z + 1],
    ];
  }
  for (let i = 0; i < 4; i++) {
    g.positions.push(corners[i][0], corners[i][1], corners[i][2]);
    g.lights.push(sky, torch);
    g.tints.push(1, 1, 1);
    g.uvs.push(i === 0 || i === 3 ? rect.u0 : rect.u1, i < 2 ? rect.v1 : rect.v0);
  }
  g.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  g.vertCount += 4;
}

function emitBox(
  g: GeoBuilder, rect: UVRect, x: number, y: number, z: number,
  x0: number, x1: number, y0: number, y1: number, z0: number, z1: number,
  sky: number, torch: number, tint = [1, 1, 1]
): void {
  const push = (px: number, py: number, pz: number, u: number, v: number): void => {
    g.positions.push(x + px, y + py, z + pz);
    g.lights.push(sky, torch);
    g.tints.push(tint[0], tint[1], tint[2]);
    g.uvs.push(u, v);
  };

  // +y top
  let base = g.vertCount;
  push(x0, y1, z0, rect.u0, rect.v0);
  push(x1, y1, z0, rect.u1, rect.v0);
  push(x1, y1, z1, rect.u1, rect.v1);
  push(x0, y1, z1, rect.u0, rect.v1);
  g.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  g.vertCount += 4;

  // -y bottom
  base = g.vertCount;
  push(x0, y0, z0, rect.u0, rect.v0);
  push(x0, y0, z1, rect.u0, rect.v1);
  push(x1, y0, z1, rect.u1, rect.v1);
  push(x1, y0, z0, rect.u1, rect.v0);
  g.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  g.vertCount += 4;

  // +x side
  base = g.vertCount;
  push(x1, y0, z0, rect.u0, rect.v1);
  push(x1, y0, z1, rect.u1, rect.v1);
  push(x1, y1, z1, rect.u1, rect.v0);
  push(x1, y1, z0, rect.u0, rect.v0);
  g.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  g.vertCount += 4;

  // -x side
  base = g.vertCount;
  push(x0, y0, z1, rect.u0, rect.v1);
  push(x0, y0, z0, rect.u1, rect.v1);
  push(x0, y1, z0, rect.u1, rect.v0);
  push(x0, y1, z1, rect.u0, rect.v0);
  g.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  g.vertCount += 4;

  // +z side
  base = g.vertCount;
  push(x0, y0, z1, rect.u0, rect.v1);
  push(x0, y1, z1, rect.u0, rect.v0);
  push(x1, y1, z1, rect.u1, rect.v0);
  push(x1, y0, z1, rect.u1, rect.v1);
  g.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  g.vertCount += 4;

  // -z side
  base = g.vertCount;
  push(x1, y0, z0, rect.u0, rect.v1);
  push(x1, y1, z0, rect.u0, rect.v0);
  push(x0, y1, z0, rect.u1, rect.v0);
  push(x0, y0, z0, rect.u1, rect.v1);
  g.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  g.vertCount += 4;
}

function emitPressurePlate(g: GeoBuilder, atlas: Atlas, x: number, y: number, z: number, sky: number, torch: number, active: boolean): void {
  const rect = atlas.rect('planks');
  const h = active ? 0.03 : 0.08;
  emitBox(g, rect, x, y, z, 0.0625, 0.9375, 0, h, 0.0625, 0.9375, sky, torch);
}

function emitLever(g: GeoBuilder, atlas: Atlas, x: number, y: number, z: number, sky: number, torch: number, active: boolean, facing: number): void {
  const stoneRect = atlas.rect('cobble');
  let bx0 = 0.25, bx1 = 0.75, by0 = 0, by1 = 0.18, bz0 = 0.25, bz1 = 0.75;
  if (facing === 0) {
    by0 = 0.82; by1 = 1.0;
  } else if (facing === 2) {
    bz0 = 0.82; bz1 = 1.0; bx0 = 0.25; bx1 = 0.75; by0 = 0.25; by1 = 0.75;
  } else if (facing === 3) {
    bz0 = 0; bz1 = 0.18; bx0 = 0.25; bx1 = 0.75; by0 = 0.25; by1 = 0.75;
  } else if (facing === 4) {
    bx0 = 0.82; bx1 = 1.0; bz0 = 0.25; bz1 = 0.75; by0 = 0.25; by1 = 0.75;
  } else if (facing === 5) {
    bx0 = 0; bx1 = 0.18; bz0 = 0.25; bz1 = 0.75; by0 = 0.25; by1 = 0.75;
  }
  emitBox(g, stoneRect, x, y, z, bx0, bx1, by0, by1, bz0, bz1, sky, torch);

  const woodRect = atlas.rect('planks');
  let sx0 = 0.44, sx1 = 0.56, sy0 = 0.18, sy1 = 0.7, sz0 = active ? 0.52 : 0.32, sz1 = active ? 0.68 : 0.48;
  if (facing === 0) {
    sy0 = 0.3; sy1 = 0.82;
  } else if (facing === 2) {
    sz0 = 0.3; sz1 = 0.82; sy0 = active ? 0.52 : 0.32; sy1 = active ? 0.68 : 0.48;
  } else if (facing === 3) {
    sz0 = 0.18; sz1 = 0.7; sy0 = active ? 0.52 : 0.32; sy1 = active ? 0.68 : 0.48;
  } else if (facing === 4) {
    sx0 = 0.3; sx1 = 0.82; sy0 = active ? 0.52 : 0.32; sy1 = active ? 0.68 : 0.48;
  } else if (facing === 5) {
    sx0 = 0.18; sx1 = 0.7; sy0 = active ? 0.52 : 0.32; sy1 = active ? 0.68 : 0.48;
  }
  emitBox(g, woodRect, x, y, z, sx0, sx1, sy0, sy1, sz0, sz1, sky, torch);
}

function emitButton(g: GeoBuilder, atlas: Atlas, id: number, x: number, y: number, z: number, sky: number, torch: number, active: boolean, facing: number): void {
  const tileName = id === B.WOODEN_BUTTON ? 'planks' : 'stone';
  const rect = atlas.rect(tileName);
  const depth = active ? 0.08 : 0.16;
  let x0 = 0.375, x1 = 0.625, y0 = 0.375, y1 = 0.625, z0 = 0.375, z1 = 0.625;
  if (facing === 0) {
    y0 = 1 - depth; y1 = 1;
  } else if (facing === 1) {
    y0 = 0; y1 = depth;
  } else if (facing === 2) {
    z0 = 1 - depth; z1 = 1;
  } else if (facing === 3) {
    z0 = 0; z1 = depth;
  } else if (facing === 4) {
    x0 = 1 - depth; x1 = 1;
  } else if (facing === 5) {
    x0 = 0; x1 = depth;
  }
  emitBox(g, rect, x, y, z, x0, x1, y0, y1, z0, z1, sky, torch);
}

function emitRedstoneWire(g: GeoBuilder, atlas: Atlas, x: number, y: number, z: number, sky: number, torch: number, power: number): void {
  const rect = atlas.rect('redstone_dust');
  const base = g.vertCount;
  const r = 0.3 + 0.7 * (power / 15);
  const push = (px: number, py: number, pz: number, u: number, v: number): void => {
    g.positions.push(x + px, y + py, z + pz);
    g.lights.push(sky, Math.max(torch, power / 15));
    g.tints.push(r, 0, 0);
    g.uvs.push(u, v);
  };
  push(0, 0.01, 0, rect.u0, rect.v0);
  push(1, 0.01, 0, rect.u1, rect.v0);
  push(1, 0.01, 1, rect.u1, rect.v1);
  push(0, 0.01, 1, rect.u0, rect.v1);
  g.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  g.vertCount += 4;
}
