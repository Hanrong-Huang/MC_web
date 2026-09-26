// Nether structures: sprawling nether-brick fortresses, ruined blackstone
// bastions, ruined portals and a scatter of small features (soul-sand fossils,
// piglin hunting camps, abandoned lava outposts), plus their chest loot.
//
// The Nether is cut into NS_CELL squares; each square hosts at most one big
// structure (a fortress or a bastion) planned purely from the seed and kept
// inside its square, so big structures never overlap and every chunk that
// touches one draws the same thing. Big structures don't read the terrain:
// fortresses tunnel straight through netherrack and prop their bridges on
// piers that sink (column by column, so it stays chunk-local) to the first
// solid block below, even through the lava sea; bastions hollow out their own
// cavern and stand on a plateau filled down to solid. Small features fit inside
// a single chunk and read that chunk's own terrain to find a floor, so they sit
// on the ground whatever the terrain generator does.
//
// Everything is written through the chunk (clipped) or the generator's put
// helpers, so it is worker-safe; shaped-block meta (stairs, campfire) goes via
// WorldGenerator.putMeta and reaches the world through drainStates. Blocks
// added by other passes (blackstone, crying obsidian, nether brick fence, …)
// are looked up by registry name with a fallback to an existing block.

import { B, I, allDefs, OPAQUE_LUT } from './Blocks';
import { Chunk, CX, CZ, CY } from './Chunk';
import { hash2, hash3, mulberry32 } from './Noise';
import type { WorldGenerator } from './WorldGenerator';
import type { SlotData } from './Persistence';

/** Side of a big-structure square (world blocks). */
export const NS_CELL = 208;

/** unit steps for direction index 0=-z, 1=-x, 2=+z, 3=+x (the door/bed/stair facing codes) */
const DX = [0, -1, 0, 1];
const DZ = [-1, 0, 1, 0];

// --- registry lookups -------------------------------------------------------

let names: Map<string, number> | null = null;
let blockNames: Map<string, number> | null = null;

/** Any id (block or item) by registry name, or `fallback`. */
export function idByName(name: string, fallback: number): number {
  if (!names) {
    names = new Map();
    blockNames = new Map();
    for (const d of allDefs()) {
      names.set(d.name, d.id);
      // chunk storage is a Uint8Array: only real blocks below 256 can be placed
      if (d.block && d.id > 0 && d.id < 256) blockNames.set(d.name, d.id);
    }
  }
  return names.get(name) ?? fallback;
}

/** First placeable block among `list`, else `fallback`. */
function blockByName(list: string[], fallback: number): number {
  idByName('', 0); // build the tables
  for (const n of list) {
    const id = blockNames!.get(n);
    if (id !== undefined) return id;
  }
  return fallback;
}

interface Pal {
  brick: number; brickAlt: number; fence: number; stairs: number; wart: number; soulSoil: number;
  bs: number; bsBricks: number; bsCracked: number; bsPolished: number; bsStairs: number; gilded: number;
  basalt: number; crying: number; bone: number; stem: number; lantern: number; bars: number; spawner: number;
  shroom: number;
}
let PAL: Pal | null = null;

/** The block palette, resolved on first use (after every pass has registered its blocks). */
function pal(): Pal {
  if (PAL) return PAL;
  const brick = B.NETHER_BRICKS;
  const bs = blockByName(['blackstone'], blockByName(['basalt'], B.NETHER_BRICKS));
  const bsBricks = blockByName(['polished_blackstone_bricks', 'blackstone_bricks'], bs);
  const bsPolished = blockByName(['polished_blackstone'], bsBricks);
  PAL = {
    brick,
    brickAlt: blockByName(['red_nether_bricks', 'cracked_nether_bricks', 'chiseled_nether_bricks'], brick),
    fence: blockByName(['nether_brick_fence'], 0),
    stairs: blockByName(['nether_brick_stairs'], 0),
    wart: blockByName(['nether_wart', 'nether_wart_crop', 'nether_wart_plant', 'crimson_roots', 'crimson_fungus'], B.RED_MUSHROOM),
    soulSoil: blockByName(['soul_soil'], B.SOUL_SAND),
    bs, bsBricks, bsPolished,
    bsCracked: blockByName(['cracked_polished_blackstone_bricks', 'cracked_blackstone_bricks'], bsBricks),
    bsStairs: blockByName(['polished_blackstone_brick_stairs', 'blackstone_stairs', 'polished_blackstone_stairs'], 0),
    gilded: blockByName(['gilded_blackstone'], B.GOLD_BLOCK),
    basalt: blockByName(['polished_basalt', 'basalt'], bsPolished),
    crying: blockByName(['crying_obsidian'], B.OBSIDIAN),
    bone: blockByName(['bone_block'], B.QUARTZ_BLOCK),
    stem: blockByName(['crimson_stem', 'crimson_hyphae'], B.SPRUCE_LOG),
    lantern: blockByName(['soul_lantern'], B.LANTERN),
    bars: blockByName(['iron_bars', 'nether_brick_fence'], 0),
    spawner: blockByName(['spawner', 'monster_spawner', 'blaze_spawner'], 0),
    shroom: blockByName(['shroomlight'], B.GLOWSTONE),
  };
  return PAL;
}

const isOpaque = (id: number): boolean => OPAQUE_LUT[id] === 1;

/** Smooth 0..1 value noise on an `s`-block lattice (for organic cavern walls). */
function vnoise(seed: number, x: number, z: number, s: number): number {
  const fx = x / s, fz = z / s;
  const ix = Math.floor(fx), iz = Math.floor(fz);
  let tx = fx - ix, tz = fz - iz;
  tx = tx * tx * (3 - 2 * tx); tz = tz * tz * (3 - 2 * tz);
  const a = hash2(seed, ix, iz), b = hash2(seed, ix + 1, iz);
  const c = hash2(seed, ix, iz + 1), d = hash2(seed, ix + 1, iz + 1);
  return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
}

// --- chunk writer -----------------------------------------------------------

/** Clipped world-coordinate writes into one chunk. */
class Ctx {
  readonly bx: number;
  readonly bz: number;
  constructor(readonly g: WorldGenerator, readonly c: Chunk) {
    this.bx = c.cx * CX;
    this.bz = c.cz * CZ;
  }
  has(x: number, z: number): boolean {
    const lx = x - this.bx, lz = z - this.bz;
    return lx >= 0 && lx < CX && lz >= 0 && lz < CZ;
  }
  /** does the inclusive world rectangle touch this chunk? */
  hits(x0: number, z0: number, x1: number, z1: number): boolean {
    return x1 >= this.bx && x0 < this.bx + CX && z1 >= this.bz && z0 < this.bz + CZ;
  }
  get(x: number, y: number, z: number): number {
    if (!this.has(x, z) || y < 0 || y >= CY) return B.AIR;
    return this.c.get(x - this.bx, y, z - this.bz);
  }
  /** never touches the bedrock floor/roof layers */
  set(x: number, y: number, z: number, id: number): void {
    if (!this.has(x, z) || y < 1 || y >= CY - 1) return;
    this.c.setRaw(x - this.bx, y, z - this.bz, id);
  }
  meta(x: number, y: number, z: number, m: number): void {
    if (this.has(x, z)) this.g.putMeta(this.c, x, y, z, m);
  }
  /** Support column from `top` down to the first solid block (through air and lava). */
  pillar(x: number, z: number, top: number, id: number): void {
    if (!this.has(x, z)) return;
    for (let y = Math.min(top, CY - 2); y >= 1; y--) {
      if (isOpaque(this.get(x, y, z))) return;
      this.set(x, y, z, id);
    }
  }
  /** Stairs (full block when the stair id is missing) ascending toward `dir`. */
  stair(x: number, y: number, z: number, id: number, fallback: number, dir: number): void {
    if (id) { this.set(x, y, z, id); this.meta(x, y, z, dir); } else this.set(x, y, z, fallback);
  }
}

// --- plans ------------------------------------------------------------------

type FNodeType = 'crossing' | 'hall' | 'spawner' | 'garden' | 'stairs';
interface FNode {
  i: number; j: number; x: number; z: number;
  /** half-size of the square footprint */
  h: number;
  type: FNodeType;
  /** bitmask of connected sides (1 << dir) */
  conn: number;
  v: number;
  chest: boolean;
}
interface FEdge {
  kind: 'bridge' | 'corridor';
  alongX: boolean;
  /** cross-axis centre line and inclusive along-axis range */
  c: number; lo: number; hi: number;
  /** stub bridges end in a broken tip at the far end ('lo' or 'hi' is the root) */
  stub: '' | 'lo' | 'hi';
  /** along-axis position of a wall chest (NaN = none) and its wall side (±1) */
  chestAt: number; chestSide: number;
  /** span piers (pairs of along-axis positions) */
  piers: number[];
  seed: number;
}
export interface FortressPlan {
  kind: 'fortress';
  x0: number; z0: number; x1: number; z1: number;
  /** deck level of every bridge, corridor and room floor */
  y: number;
  nodes: FNode[];
  edges: FEdge[];
}
export interface BastionPlan {
  kind: 'bastion';
  x0: number; z0: number; x1: number; z1: number;
  /** ground level */
  y: number;
  /** local frame: origin, size, facing (front = v 0 looks toward world dir `dir`) */
  ox: number; oz: number; w: number; d: number; dir: number;
  /** cavern centre + radii */
  cx: number; cz: number; rx: number; rz: number; ry: number;
  /** treasure room world box */
  tx0: number; tz0: number; tx1: number; tz1: number;
  seed: number;
}
export type NetherPlan = FortressPlan | BastionPlan;

const planCache = new Map<string, NetherPlan | null>();

/** Plan the big structure (if any) of NS_CELL square (rx, rz). Pure function of the seed. */
export function planNetherCell(seed: number, rx: number, rz: number): NetherPlan | null {
  const key = `${seed},${rx},${rz}`;
  const hit = planCache.get(key);
  if (hit !== undefined) return hit;
  if (planCache.size > 512) planCache.clear();
  const S = (seed ^ 0x6e5f7a) | 0;
  const r = hash2(S, rx, rz);
  let plan: NetherPlan | null = null;
  if (r < 0.82) {
    const M = 88; // keep the anchor well inside the square
    const ax = rx * NS_CELL + M + Math.floor(hash2(S ^ 1, rx, rz) * (NS_CELL - 2 * M));
    const az = rz * NS_CELL + M + Math.floor(hash2(S ^ 2, rx, rz) * (NS_CELL - 2 * M));
    const rnd = mulberry32(Math.floor(hash2(S ^ 3, rx, rz) * 0x7fffffff) ^ rx * 7919 ^ rz * 104729);
    plan = r < 0.46 ? planFortress(ax, az, rnd) : planBastion(ax, az, rnd);
  }
  planCache.set(key, plan);
  return plan;
}

const bits = (m: number): number => (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1);
const outdoor = (t: FNodeType): boolean => t === 'crossing' || t === 'spawner';

/** A fortress: rooms and platforms on a coarse grid, joined by bridges and corridors. */
function planFortress(ax: number, az: number, rnd: () => number): FortressPlan {
  const SP = 26, R = 2;
  const Y = 50 + Math.floor(rnd() * 14);
  const nodes = new Map<string, FNode>();
  const reserved = new Set<string>(); // grid spots a long bridge jumps over
  const links: [FNode, FNode, number][] = [];
  const key = (i: number, j: number): string => `${i},${j}`;
  const mk = (i: number, j: number): FNode => {
    const n: FNode = { i, j, x: ax + i * SP, z: az + j * SP, h: 5, type: 'crossing', conn: 0, v: rnd(), chest: false };
    nodes.set(key(i, j), n);
    return n;
  };
  const linked = (a: FNode, b: FNode): boolean => links.some(([p, q]) => (p === a && q === b) || (p === b && q === a));
  const origin = mk(0, 0);
  const want = 9 + Math.floor(rnd() * 6);
  for (let guard = 0; nodes.size < want && guard < 400; guard++) {
    const list = [...nodes.values()];
    const a = list[Math.floor(rnd() * list.length)];
    const d = Math.floor(rnd() * 4);
    const jump = rnd() < 0.22 ? 2 : 1; // long bridges skip a grid spot
    const i = a.i + DX[d] * jump, j = a.j + DZ[d] * jump;
    if (Math.abs(i) > R || Math.abs(j) > R || reserved.has(key(i, j))) continue;
    const mid = key(a.i + DX[d], a.j + DZ[d]);
    if (jump === 2 && (nodes.has(mid) || reserved.has(mid))) continue;
    const b = nodes.get(key(i, j));
    if (b) {
      if (jump === 1 && !linked(a, b) && rnd() < 0.3) links.push([a, b, d]); // occasional loop
      continue;
    }
    if (jump === 2) reserved.add(mid);
    links.push([a, mk(i, j), d]);
  }
  for (const [a, b, d] of links) { a.conn |= 1 << d; b.conn |= 1 << ((d + 2) & 3); }
  // room types: the farthest dead end hosts the blaze platform, the next a stair tower
  const all = [...nodes.values()];
  for (const n of all) if (n !== origin) n.type = rnd() < 0.5 ? 'hall' : 'crossing';
  const far = (n: FNode): number => n.i * n.i + n.j * n.j;
  const leaves = all.filter((n) => n !== origin && bits(n.conn) === 1).sort((p, q) => far(q) - far(p));
  const grow = (type: FNodeType): void => {
    // no free dead end: sprout a new one off the edge of the grid
    for (const n of all) {
      for (let d = 0; d < 4; d++) {
        const i = n.i + DX[d], j = n.j + DZ[d];
        if (Math.abs(i) > R + 1 || Math.abs(j) > R + 1 || nodes.has(key(i, j)) || reserved.has(key(i, j))) continue;
        const m = mk(i, j);
        m.type = type;
        links.push([n, m, d]);
        n.conn |= 1 << d; m.conn |= 1 << ((d + 2) & 3);
        all.push(m);
        return;
      }
    }
  };
  if (leaves[0]) leaves[0].type = 'spawner'; else grow('spawner');
  if (leaves[1]) leaves[1].type = 'stairs'; else grow('stairs');
  const garden = all.find((n) => n.type === 'hall') ?? all.find((n) => n !== origin && n.type === 'crossing');
  if (garden) garden.type = 'garden';
  for (const n of all) {
    if (n.type === 'spawner' || n.type === 'garden') n.h = 6;
    n.chest = n.type === 'garden' || n.type === 'stairs' || (n.type === 'hall' && n.v < 0.6);
  }
  // edges
  const edges: FEdge[] = [];
  const edgeSeed = Math.floor(rnd() * 0x7fffffff);
  const addEdge = (kind: FEdge['kind'], alongX: boolean, c: number, lo: number, hi: number, stub: FEdge['stub']): FEdge => {
    const len = hi - lo + 1;
    const piers: number[] = [];
    const spans = Math.round(len / 11);
    if (kind === 'bridge' && spans >= 2) {
      for (let k = 1; k < spans; k++) {
        const p = lo + Math.round((k * len) / spans) - 1;
        piers.push(p, p + 1);
      }
    }
    const e: FEdge = { kind, alongX, c, lo, hi, stub, chestAt: NaN, chestSide: 1, piers, seed: edgeSeed + edges.length * 131 };
    edges.push(e);
    return e;
  };
  for (const [a, b, d] of links) {
    const alongX = d === 1 || d === 3;
    const s = DX[d] + DZ[d];
    const from = (alongX ? a.x : a.z) + s * (a.h + 1), to = (alongX ? b.x : b.z) - s * (b.h + 1);
    const lo = Math.min(from, to), hi = Math.max(from, to);
    const ia = !outdoor(a.type), ib = !outdoor(b.type);
    const kind = a.type === 'spawner' || b.type === 'spawner' || (!ia && !ib) ? 'bridge'
      : ia && ib ? 'corridor' : rnd() < 0.5 ? 'corridor' : 'bridge';
    const e = addEdge(kind, alongX, alongX ? a.z : a.x, lo, hi, '');
    if (kind === 'corridor' && hi - lo >= 8 && rnd() < 0.45) {
      e.chestAt = lo + ((hi - lo) >> 1);
      e.chestSide = rnd() < 0.5 ? -1 : 1;
    }
  }
  // stub bridges reaching out over the void from platforms, ending in a broken tip
  for (const n of all) {
    if (!outdoor(n.type)) continue;
    for (let d = 0; d < 4; d++) {
      if (n.conn & (1 << d) || rnd() > 0.32) continue;
      const ni = n.i + DX[d], nj = n.j + DZ[d];
      const open = Math.abs(ni) > R + 1 || Math.abs(nj) > R + 1 || (!nodes.has(key(ni, nj)) && !reserved.has(key(ni, nj)));
      const L = open ? 8 + Math.floor(rnd() * 11) : 6 + Math.floor(rnd() * 6);
      const alongX = d === 1 || d === 3;
      const s = DX[d] + DZ[d];
      const base = (alongX ? n.x : n.z) + s * (n.h + 1);
      const tip = base + s * (L - 1);
      addEdge('bridge', alongX, alongX ? n.z : n.x, Math.min(base, tip), Math.max(base, tip), s > 0 ? 'lo' : 'hi');
      n.conn |= 1 << d; // opens the rail
    }
  }
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const n of all) {
    x0 = Math.min(x0, n.x - n.h - 1); x1 = Math.max(x1, n.x + n.h + 1);
    z0 = Math.min(z0, n.z - n.h - 1); z1 = Math.max(z1, n.z + n.h + 1);
  }
  for (const e of edges) {
    const [ex0, ez0, ex1, ez1] = edgeBox(e);
    x0 = Math.min(x0, ex0); x1 = Math.max(x1, ex1); z0 = Math.min(z0, ez0); z1 = Math.max(z1, ez1);
  }
  return { kind: 'fortress', x0, z0, x1, z1, y: Y, nodes: all, edges };
}

function edgeBox(e: FEdge): [number, number, number, number] {
  return e.alongX ? [e.lo, e.c - 3, e.hi, e.c + 3] : [e.c - 3, e.lo, e.c + 3, e.hi];
}

const BW = 45, BD = 49; // bastion local footprint

function planBastion(ax: number, az: number, rnd: () => number): BastionPlan {
  const dir = Math.floor(rnd() * 4);
  const Y = 38 + Math.floor(rnd() * 14);
  const sw = dir & 1 ? BD : BW, sd = dir & 1 ? BW : BD; // world footprint
  const ox = ax - (sw >> 1), oz = az - (sd >> 1);
  const plan: BastionPlan = {
    kind: 'bastion', x0: 0, z0: 0, x1: 0, z1: 0, y: Y, ox, oz, w: BW, d: BD, dir,
    cx: 0, cz: 0, rx: sw / 2 + 9, rz: sd / 2 + 9, ry: 30,
    tx0: 0, tz0: 0, tx1: 0, tz1: 0, seed: Math.floor(rnd() * 0x7fffffff),
  };
  const f = new BFrame(plan);
  plan.cx = f.x(22, 24); plan.cz = f.z(22, 24);
  plan.x0 = Math.floor(plan.cx - plan.rx * 1.2) - 1; plan.x1 = Math.ceil(plan.cx + plan.rx * 1.2) + 1;
  plan.z0 = Math.floor(plan.cz - plan.rz * 1.2) - 1; plan.z1 = Math.ceil(plan.cz + plan.rz * 1.2) + 1;
  const ta = [f.x(17, 29), f.x(27, 44)], tb = [f.z(17, 29), f.z(27, 44)];
  plan.tx0 = Math.min(ta[0], ta[1]); plan.tx1 = Math.max(ta[0], ta[1]);
  plan.tz0 = Math.min(tb[0], tb[1]); plan.tz1 = Math.max(tb[0], tb[1]);
  return plan;
}

/** Rotated local frame (u across the front, v front→back, front faces world `dir`). */
class BFrame {
  constructor(readonly p: { ox: number; oz: number; w: number; d: number; dir: number }) {}
  x(u: number, v: number): number {
    const { ox, w, d, dir } = this.p;
    switch (dir) {
      case 0: return ox + u;
      case 2: return ox + w - 1 - u;
      case 1: return ox + v;
      default: return ox + d - 1 - v;
    }
  }
  z(u: number, v: number): number {
    const { oz, w, d, dir } = this.p;
    switch (dir) {
      case 0: return oz + v;
      case 2: return oz + d - 1 - v;
      case 1: return oz + w - 1 - u;
      default: return oz + u;
    }
  }
  /** local direction → world direction code: 'f' front (-v), 'b' back, 'l' (-u), 'r' (+u) */
  wd(l: 'f' | 'b' | 'l' | 'r'): number {
    const d = this.p.dir;
    return l === 'f' ? d : l === 'b' ? (d + 2) & 3 : l === 'l' ? (d + 1) & 3 : (d + 3) & 3;
  }
}

// --- small, single-chunk features -------------------------------------------

export type SmallKind = 'ruined_portal' | 'camp' | 'outpost' | 'fossil';

/** The small feature a chunk may host (it still needs suitable terrain to appear). */
export function smallFeatureAt(seed: number, cx: number, cz: number): SmallKind | null {
  const r = hash2((seed ^ 0x51a7e) | 0, cx, cz);
  if (r < 0.024) return 'ruined_portal';
  if (r < 0.04) return 'camp';
  if (r < 0.062) return 'outpost';
  if (r < 0.11) return 'fossil';
  return null;
}

/** Big structure whose box holds (x, z), or null. */
function bigAt(seed: number, x: number, z: number, pad = 0): NetherPlan | null {
  const p = planNetherCell(seed, Math.floor(x / NS_CELL), Math.floor(z / NS_CELL));
  return p && x >= p.x0 - pad && x <= p.x1 + pad && z >= p.z0 - pad && z <= p.z1 + pad ? p : null;
}

/** What (if anything) was built around a Nether position — for mob spawning and loot. */
export function netherStructureAt(seed: number, x: number, z: number): NetherPlan['kind'] | SmallKind | null {
  const big = bigAt(seed, x, z);
  if (big) return big.kind;
  return smallFeatureAt(seed, Math.floor(x / CX), Math.floor(z / CZ));
}

/** Every big structure whose square lies within `radius` of (x, z) (dev/test helper). */
export function listNetherStructures(seed: number, x: number, z: number, radius: number): NetherPlan[] {
  const out: NetherPlan[] = [];
  const r0 = Math.floor((x - radius) / NS_CELL), r1 = Math.floor((x + radius) / NS_CELL);
  const q0 = Math.floor((z - radius) / NS_CELL), q1 = Math.floor((z + radius) / NS_CELL);
  for (let rx = r0; rx <= r1; rx++) for (let rz = q0; rz <= q1; rz++) {
    const p = planNetherCell(seed, rx, rz);
    if (p) out.push(p);
  }
  return out;
}

// --- entry point ------------------------------------------------------------

/** Draw every Nether structure touching this chunk. Call after the terrain pass. */
export function drawNetherStructures(g: WorldGenerator, chunk: Chunk): void {
  const ctx = new Ctx(g, chunk);
  const seed = g.seed;
  let blocked = false;
  const r0 = Math.floor(ctx.bx / NS_CELL), r1 = Math.floor((ctx.bx + CX - 1) / NS_CELL);
  const q0 = Math.floor(ctx.bz / NS_CELL), q1 = Math.floor((ctx.bz + CZ - 1) / NS_CELL);
  for (let rx = r0; rx <= r1; rx++) {
    for (let rz = q0; rz <= q1; rz++) {
      const p = planNetherCell(seed, rx, rz);
      if (!p) continue;
      if (ctx.hits(p.x0 - 6, p.z0 - 6, p.x1 + 6, p.z1 + 6)) blocked = true;
      if (!ctx.hits(p.x0, p.z0, p.x1, p.z1)) continue;
      if (p.kind === 'fortress') drawFortress(ctx, p);
      else drawBastion(ctx, p);
    }
  }
  if (blocked) return;
  const kind = smallFeatureAt(seed, chunk.cx, chunk.cz);
  if (!kind) return;
  const rnd = mulberry32(Math.floor(hash2((seed ^ 0x5eed) | 0, chunk.cx, chunk.cz) * 0x7fffffff));
  switch (kind) {
    case 'ruined_portal': ruinedPortal(ctx, rnd); break;
    case 'camp': piglinCamp(ctx, rnd); break;
    case 'outpost': lavaOutpost(ctx, rnd); break;
    case 'fossil': fossil(ctx, rnd); break;
  }
}

// --- fortress ---------------------------------------------------------------

function drawFortress(ctx: Ctx, f: FortressPlan): void {
  const p = pal();
  for (const e of f.edges) {
    const [x0, z0, x1, z1] = edgeBox(e);
    if (!ctx.hits(x0, z0, x1, z1)) continue;
    if (e.kind === 'bridge') drawBridge(ctx, p, f.y, e);
    else drawCorridor(ctx, p, f.y, e);
  }
  for (const n of f.nodes) {
    if (!ctx.hits(n.x - n.h - 1, n.z - n.h - 1, n.x + n.h + 1, n.z + n.h + 1)) continue;
    switch (n.type) {
      case 'crossing': drawCrossing(ctx, p, f.y, n); break;
      case 'hall': drawHall(ctx, p, f.y, n); break;
      case 'spawner': drawSpawner(ctx, p, f.y, n); break;
      case 'garden': drawGarden(ctx, p, f.y, n); break;
      case 'stairs': drawStairTower(ctx, p, f.y, n); break;
    }
  }
}

/** A five-wide bridge: walled deck, arched underside, piers down to the ground. */
function drawBridge(ctx: Ctx, p: Pal, Y: number, e: FEdge): void {
  for (let a = e.lo; a <= e.hi; a++) {
    // distance to the nearest support (end rooms and piers) sets the arch depth
    let dist = 99;
    if (e.stub !== 'hi') dist = Math.min(dist, a - e.lo + 1);
    if (e.stub !== 'lo') dist = Math.min(dist, e.hi + 1 - a);
    for (const q of e.piers) dist = Math.min(dist, Math.abs(a - q));
    const pier = dist === 0;
    // a stub crumbles toward its free tip
    const fromTip = e.stub === 'lo' ? e.hi - a : e.stub === 'hi' ? a - e.lo : 99;
    const decay = fromTip < 5 ? (5 - fromTip) / 6 : 0;
    const depth = pier ? 0 : Math.max(1, 5 - dist);
    for (let w = -2; w <= 2; w++) {
      const x = e.alongX ? a : e.c + w, z = e.alongX ? e.c + w : a;
      const gone = decay > 0 && hash3(e.seed, a, w, 7) < decay + (Math.abs(w) === 2 ? 0.15 : 0);
      for (let y = Y + 1; y <= Y + 5; y++) ctx.set(x, y, z, B.AIR);
      if (gone) {
        ctx.set(x, Y, z, B.AIR);
        // near the break a ragged strip of the underside survives
        ctx.set(x, Y - 1, z, decay < 0.7 && hash3(e.seed, a, w, 9) < 0.5 ? p.brick : B.AIR);
        continue;
      }
      ctx.set(x, Y, z, p.brick);
      if (pier) ctx.pillar(x, z, Y - 1, p.brick);
      else for (let k = 1; k < depth; k++) ctx.set(x, Y - k, z, p.brick);
      if (Math.abs(w) === 2) {
        ctx.set(x, Y + 1, z, p.brick);
        // fence railing when the block exists, else a post over every pier and between
        if (p.fence) ctx.set(x, Y + 2, z, p.fence);
        else if (dist === 0 || (a - e.lo) % 6 === 3) ctx.set(x, Y + 2, z, p.brick);
      }
    }
  }
}

/** A five-wide enclosed corridor with arrow-slit windows, ceiling lights and piers. */
function drawCorridor(ctx: Ctx, p: Pal, Y: number, e: FEdge): void {
  for (let a = e.lo; a <= e.hi; a++) {
    const k = a - e.lo;
    const slit = k % 4 === 2;
    const pier = k % 8 === 0 || a === e.hi;
    for (let w = -2; w <= 2; w++) {
      const x = e.alongX ? a : e.c + w, z = e.alongX ? e.c + w : a;
      ctx.set(x, Y - 1, z, p.brick);
      ctx.set(x, Y, z, p.brick);
      const wall = Math.abs(w) === 2;
      for (let y = Y + 1; y <= Y + 4; y++) {
        if (!wall) { ctx.set(x, y, z, B.AIR); continue; }
        const window = slit && (y === Y + 2 || y === Y + 3);
        ctx.set(x, y, z, window ? (p.fence || B.AIR) : p.brick);
      }
      ctx.set(x, Y + 5, z, p.brick);
      if (pier) ctx.pillar(x, z, Y - 2, p.brick);
    }
    if (k % 8 === 4) {
      const x = e.alongX ? a : e.c, z = e.alongX ? e.c : a;
      ctx.set(x, Y + 5, z, B.GLOWSTONE);
    }
    if (a === e.chestAt) {
      const s = e.chestSide;
      const cx = e.alongX ? a : e.c + 2 * s, cz = e.alongX ? e.c + 2 * s : a;
      const bx = e.alongX ? a : e.c + 3 * s, bz = e.alongX ? e.c + 3 * s : a;
      ctx.set(cx, Y + 1, cz, B.CHEST_LOOT); // tucked into a niche in the wall
      ctx.set(bx, Y + 1, bz, p.brick);
      ctx.set(bx, Y + 2, bz, p.brick);
    }
  }
}

/** Which side (if any) of a square footprint a cell lies on, as a door code. */
function sideOf(dx: number, dz: number, h: number): number {
  if (dz === -h) return 0;
  if (dx === -h) return 1;
  if (dz === h) return 2;
  if (dx === h) return 3;
  return -1;
}
/** cell offset across the side it's on */
const perpOf = (dx: number, dz: number, side: number): number => (side === 0 || side === 2 ? dx : dz);

/** Open bridge crossing: a walled platform on corner piers with a brazier. */
function drawCrossing(ctx: Ctx, p: Pal, Y: number, n: FNode): void {
  const h = n.h;
  for (let dx = -h; dx <= h; dx++) {
    for (let dz = -h; dz <= h; dz++) {
      const x = n.x + dx, z = n.z + dz;
      if (!ctx.has(x, z)) continue;
      const side = Math.max(Math.abs(dx), Math.abs(dz)) === h ? sideOf(dx, dz, h) : -1;
      for (let y = Y + 1; y <= Y + 6; y++) ctx.set(x, y, z, B.AIR);
      ctx.set(x, Y, z, p.brick);
      ctx.set(x, Y - 1, z, p.brick);
      if (side >= 0) {
        ctx.set(x, Y - 2, z, p.brick);
        const door = (n.conn & (1 << side)) !== 0 && Math.abs(perpOf(dx, dz, side)) <= 1;
        if (!door) {
          ctx.set(x, Y + 1, z, p.brick);
          if (p.fence) ctx.set(x, Y + 2, z, p.fence);
        }
      }
      const corner = Math.abs(dx) >= h - 1 && Math.abs(dz) >= h - 1;
      if (corner || (Math.abs(dx) <= 1 && Math.abs(dz) <= 1)) ctx.pillar(x, z, Y - 2, p.brick);
      else if (Math.abs(dx) <= 2 && Math.abs(dz) <= 2) ctx.set(x, Y - 2, z, p.brick);
    }
  }
  // brazier: a raised ring round a magma heart with a flame on top
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const c = dx === 0 && dz === 0;
      if (!c && (dx === 0 || dz === 0)) continue; // leave the arms low: a cross-shaped plinth
      ctx.set(n.x + dx, Y + 1, n.z + dz, c ? B.MAGMA : p.brick);
    }
  }
  ctx.set(n.x, Y + 2, n.z, B.FIRE);
}

/** Enclosed junction room; some hold a lava well, many a chest. */
function drawHall(ctx: Ctx, p: Pal, Y: number, n: FNode): void {
  const h = n.h;
  for (let dx = -h; dx <= h; dx++) {
    for (let dz = -h; dz <= h; dz++) {
      const x = n.x + dx, z = n.z + dz;
      if (!ctx.has(x, z)) continue;
      const side = Math.max(Math.abs(dx), Math.abs(dz)) === h ? sideOf(dx, dz, h) : -1;
      ctx.set(x, Y - 1, z, p.brick);
      ctx.set(x, Y, z, p.brick);
      ctx.set(x, Y + 7, z, p.brick);
      if (side >= 0) {
        ctx.set(x, Y - 2, z, p.brick);
        const perp = perpOf(dx, dz, side);
        const door = (n.conn & (1 << side)) !== 0 && Math.abs(perp) <= 1;
        const slit = (n.conn & (1 << side)) === 0 && Math.abs(perp) === 2;
        for (let y = Y + 1; y <= Y + 6; y++) {
          if (door && y <= Y + 4) ctx.set(x, y, z, B.AIR);
          else if (slit && y >= Y + 2 && y <= Y + 4) ctx.set(x, y, z, p.fence || B.AIR);
          else ctx.set(x, y, z, p.brick);
        }
        if (Math.abs(perp) === h || perp === 0) ctx.pillar(x, z, Y - 3, p.brick);
      } else {
        const post = Math.abs(dx) === h - 1 && Math.abs(dz) === h - 1;
        for (let y = Y + 1; y <= Y + 6; y++) ctx.set(x, y, z, post ? p.brickAlt : B.AIR);
      }
    }
  }
  ctx.set(n.x - 2, Y + 7, n.z - 2, B.GLOWSTONE);
  ctx.set(n.x + 2, Y + 7, n.z + 2, B.GLOWSTONE);
  if (n.v < 0.35) {
    // lava well: a single source in a raised brick rim
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) ctx.set(n.x + dx, Y + 1, n.z + dz, p.brick);
    ctx.set(n.x, Y + 1, n.z, B.AIR);
    ctx.set(n.x, Y, n.z, B.LAVA);
  }
  if (n.chest) {
    // against the first windowed (door-free) wall, beside the corner post
    for (let s = 0; s < 4; s++) {
      if (n.conn & (1 << s)) continue;
      const along = h - 2, inset = h - 1;
      const dx = s === 0 || s === 2 ? along : s === 1 ? -inset : inset;
      const dz = s === 1 || s === 3 ? along : s === 0 ? -inset : inset;
      ctx.set(n.x + dx, Y + 1, n.z + dz, B.CHEST_LOOT);
      break;
    }
  }
}

/** Blaze platform: a raised dais reached by stairs, with a caged spawner in the middle. */
function drawSpawner(ctx: Ctx, p: Pal, Y: number, n: FNode): void {
  const h = n.h;
  const entry = [0, 1, 2, 3].filter((s) => n.conn & (1 << s));
  for (let dx = -h; dx <= h; dx++) {
    for (let dz = -h; dz <= h; dz++) {
      const x = n.x + dx, z = n.z + dz;
      if (!ctx.has(x, z)) continue;
      const m = Math.max(Math.abs(dx), Math.abs(dz));
      const side = m === h ? sideOf(dx, dz, h) : -1;
      for (let y = Y + 1; y <= Y + 8; y++) ctx.set(x, y, z, B.AIR);
      ctx.set(x, Y, z, p.brick);
      ctx.set(x, Y - 1, z, p.brick);
      ctx.set(x, Y - 2, z, p.brick);
      if (side >= 0) {
        const door = (n.conn & (1 << side)) !== 0 && Math.abs(perpOf(dx, dz, side)) <= 1;
        if (!door) {
          ctx.set(x, Y + 1, z, p.brick);
          ctx.set(x, Y + 2, z, p.fence || p.brick);
        }
      }
      if (m <= 3) {
        ctx.set(x, Y + 1, z, p.brick);
        ctx.set(x, Y + 2, z, m === 3 || m === 0 ? p.brickAlt : p.brick);
        // railing round the dais edge, open where the stairs arrive
        if (m === 3 && p.fence) {
          const s = sideOf(dx, dz, 3);
          const stairGap = entry.includes(s) && Math.abs(perpOf(dx, dz, s)) <= 1;
          if (!stairGap) ctx.set(x, Y + 3, z, p.fence);
        }
      }
      if ((Math.abs(dx) >= h - 1 && Math.abs(dz) >= h - 1) || m <= 1) ctx.pillar(x, z, Y - 3, p.brick);
    }
  }
  // stairs up onto the dais from each entrance
  for (const s of entry) {
    for (let t = -1; t <= 1; t++) {
      const x = n.x + DX[s] * 4 + (s === 0 || s === 2 ? t : 0);
      const z = n.z + DZ[s] * 4 + (s === 1 || s === 3 ? t : 0);
      ctx.stair(x, Y + 1, z, p.stairs, p.brick, (s + 2) & 3);
    }
  }
  // the caged spawner: a spawner block if one exists, else a burning magma core
  const cx = n.x, cz = n.z;
  if (p.spawner) ctx.set(cx, Y + 3, cz, p.spawner);
  else { ctx.set(cx, Y + 3, cz, B.MAGMA); ctx.set(cx, Y + 4, cz, B.FIRE); }
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue;
      const post = dx !== 0 && dz !== 0;
      for (let y = Y + 3; y <= Y + 4; y++) {
        if (p.bars) ctx.set(cx + dx, y, cz + dz, p.bars);
        else if (post) ctx.set(cx + dx, y, cz + dz, p.brick);
      }
      ctx.set(cx + dx, Y + 5, cz + dz, p.brick);
    }
  }
  ctx.set(cx, Y + 5, cz, p.brickAlt);
}

/** Sunken courtyard of soul-sand beds growing nether wart, walled with a lookout rim. */
function drawGarden(ctx: Ctx, p: Pal, Y: number, n: FNode): void {
  const h = n.h;
  for (let dx = -h; dx <= h; dx++) {
    for (let dz = -h; dz <= h; dz++) {
      const x = n.x + dx, z = n.z + dz;
      if (!ctx.has(x, z)) continue;
      const m = Math.max(Math.abs(dx), Math.abs(dz));
      if (m === h) {
        const side = sideOf(dx, dz, h);
        const perp = perpOf(dx, dz, side);
        const open = (n.conn & (1 << side)) !== 0;
        for (let y = Y - 3; y <= Y + 5; y++) {
          if (open && Math.abs(perp) <= 1 && y >= Y + 1 && y <= Y + 4) ctx.set(x, y, z, B.AIR);
          else if (!open && Math.abs(perp) === 3 && (y === Y + 2 || y === Y + 3)) ctx.set(x, y, z, p.fence || B.AIR);
          else if (!open && perp === 0 && y === Y + 3) ctx.set(x, y, z, B.GLOWSTONE);
          else ctx.set(x, y, z, p.brick);
        }
        ctx.set(x, Y + 6, z, ((dx + dz) & 1) === 0 ? p.brick : B.AIR); // crenellation
        if (Math.abs(perp) === h || perp === 0) ctx.pillar(x, z, Y - 4, p.brick);
        continue;
      }
      for (let y = Y + 1; y <= Y + 8; y++) ctx.set(x, y, z, B.AIR);
      if (m === h - 1) {
        // the walkway rim at deck level
        for (let y = Y - 3; y <= Y; y++) ctx.set(x, y, z, p.brick);
        continue;
      }
      ctx.set(x, Y - 3, z, p.brick);
      ctx.set(x, Y, z, B.AIR);
      ctx.set(x, Y - 1, z, B.AIR);
      const bed = Math.abs(dx) <= 3 && (Math.abs(dz) === 2 || Math.abs(dz) === 3);
      if (bed) {
        ctx.set(x, Y - 2, z, B.SOUL_SAND);
        if (hash3(n.x ^ 0x3a7, x, Y, z) < 0.85) ctx.set(x, Y - 1, z, p.wart);
      } else ctx.set(x, Y - 2, z, p.brick);
    }
  }
  // steps down into the courtyard from each doorway
  for (let s = 0; s < 4; s++) {
    if (!(n.conn & (1 << s))) continue;
    for (let t = -1; t <= 1; t++) {
      const x = n.x + DX[s] * 4 + (s === 0 || s === 2 ? t : 0);
      const z = n.z + DZ[s] * 4 + (s === 1 || s === 3 ? t : 0);
      ctx.set(x, Y - 2, z, p.brick);
      ctx.stair(x, Y - 1, z, p.stairs, p.brick, s);
    }
  }
  if (n.chest) ctx.set(n.x + 4, Y - 1, n.z + 4, B.CHEST_LOOT); // inner corner, clear of the steps
}

/** Stair tower: a walled well with a wart garden at its foot and an L-shaped
 *  flight up to a crenellated roof lookout. Always a dead end (one door). */
function drawStairTower(ctx: Ctx, p: Pal, Y: number, n: FNode): void {
  const h = n.h;
  const front = [0, 1, 2, 3].find((s) => n.conn & (1 << s)) ?? 0;
  const back = (front + 2) & 3, right = (front + 3) & 3;
  const wx = (u: number, v: number): number => n.x + u * DX[right] + v * DX[back];
  const wz = (u: number, v: number): number => n.z + u * DZ[right] + v * DZ[back];
  /** step height (above Y) of the flights at local (u, v), 0 = none */
  const step = (u: number, v: number): number => {
    if ((u === -4 || u === -3) && v >= -3 && v <= 4) return v + 4;          // up the left wall: 1..8
    if ((v === 3 || v === 4) && u >= -2 && u <= 1) return 9 + (u + 2);      // along the back: 9..12
    return 0;
  };
  for (let u = -h; u <= h; u++) {
    for (let v = -h; v <= h; v++) {
      const x = wx(u, v), z = wz(u, v);
      if (!ctx.has(x, z)) continue;
      const m = Math.max(Math.abs(u), Math.abs(v));
      ctx.set(x, Y - 1, z, p.brick);
      ctx.set(x, Y, z, p.brick);
      if (m === h) {
        const door = v === -h && Math.abs(u) <= 1;
        const winSide = (Math.abs(u) === h && (v === -1 || v === 2)) || (v === h && Math.abs(u) === 2);
        for (let y = Y + 1; y <= Y + 14; y++) {
          const winY = y === Y + 3 || y === Y + 4 || y === Y + 9 || y === Y + 10;
          if (door && y <= Y + 4) ctx.set(x, y, z, B.AIR);
          else if (winSide && winY) ctx.set(x, y, z, p.fence || B.AIR);
          else ctx.set(x, y, z, p.brick);
        }
        ctx.set(x, Y + 15, z, ((u + v) & 1) === 0 ? p.brick : B.AIR);
        if (Math.abs(u) === h && Math.abs(v) === h) ctx.set(x, Y + 14, z, B.GLOWSTONE);
        if ((Math.abs(u) === h && Math.abs(v) === h) || u === 0 || v === 0) ctx.pillar(x, z, Y - 2, p.brick);
        continue;
      }
      const k = step(u, v);
      for (let y = Y + 1; y <= Y + 12; y++) ctx.set(x, y, z, y < Y + k ? p.brick : B.AIR);
      if (k) {
        const up = k <= 8 ? back : right;
        ctx.stair(x, Y + k, z, p.stairs, p.brick, up);
      }
      // roof, open over the top of the stairs
      const hole = (v === 3 || v === 4) && u >= -4 && u <= 1;
      ctx.set(x, Y + 13, z, hole ? B.AIR : p.brick);
      // wart garden at the foot
      if (u >= -1 && u <= 3 && v >= -2 && v <= 1) {
        ctx.set(x, Y, z, B.SOUL_SAND);
        if (hash3(n.z ^ 0x51, x, Y, z) < 0.8) ctx.set(x, Y + 1, z, p.wart);
      }
    }
  }
  ctx.set(wx(5, 0), Y + 6, wz(5, 0), B.GLOWSTONE);
  ctx.set(wx(-5, -2), Y + 6, wz(-5, -2), B.GLOWSTONE);
  if (n.chest) ctx.set(wx(4, 4), Y + 1, wz(4, 4), B.CHEST_LOOT);
  ctx.set(wx(3, -3), Y + 14, wz(3, -3), B.CHEST_LOOT); // a lookout's stash on the roof
}

// --- bastion ------------------------------------------------------------------

function drawBastion(ctx: Ctx, b: BastionPlan): void {
  const p = pal();
  const f = new BFrame(b);
  const Y = b.y;
  const S = b.seed;
  carveCavern(ctx, b);

  /** crumbling: random holes plus whole column groups snapped off above a height */
  const ruined = (x: number, y: number, z: number): boolean => {
    if (y <= Y + 5) return false;
    if (hash3(S, x >> 1, y >> 1, z >> 1) < 0.045) return true;
    if (hash2(S ^ 7, x >> 2, z >> 2) < 0.38) {
      const cut = Y + 7 + Math.floor(hash2(S ^ 8, x >> 2, z >> 2) * 9) + (hash2(S ^ 9, x, z) < 0.5 ? 1 : 0);
      if (y > cut) return true;
    }
    return false;
  };
  const gildRate = p.gilded === B.GOLD_BLOCK ? 0.005 : 0.03;
  /** age a masonry block: cracked bricks, gilded (gold-veined) blackstone */
  const weather = (id: number, x: number, y: number, z: number): number => {
    if (id === p.bsBricks && hash3(S ^ 11, x, y, z) < 0.2) return p.bsCracked;
    if ((id === p.bs || id === p.bsBricks) && hash3(S ^ 12, x, y, z) < gildRate) return p.gilded;
    return id;
  };
  const has = (u: number, v: number): boolean => ctx.has(f.x(u, v), f.z(u, v));
  const put = (u: number, y: number, v: number, id: number): void => ctx.set(f.x(u, v), y, f.z(u, v), id);
  const wall = (u: number, y: number, v: number, id: number, ruin = true): void => {
    const x = f.x(u, v), z = f.z(u, v);
    if (!ctx.has(x, z)) return;
    ctx.set(x, y, z, ruin && ruined(x, y, z) ? B.AIR : weather(id, x, y, z));
  };
  const found = (u: number, v: number): void => ctx.pillar(f.x(u, v), f.z(u, v), Y, p.bs);

  // --- moat trench and the entrance bridge -----------------------------------
  for (let u = 4; u <= 40; u++) {
    for (let v = 2; v <= 8; v++) {
      if (!has(u, v)) continue;
      put(u, Y, v, B.AIR);
      put(u, Y - 1, v, B.AIR);
      put(u, Y - 2, v, B.LAVA);
      put(u, Y - 3, v, p.bs);
      put(u, Y - 4, v, p.bs);
    }
  }
  for (let v = 0; v <= 11; v++) {
    for (let u = 19; u <= 25; u++) {
      if (!has(u, v)) continue;
      const rail = u === 19 || u === 25;
      put(u, Y, v, rail ? p.bsBricks : p.bsPolished);
      put(u, Y - 1, v, p.bs);
      if (v >= 3 && v <= 7) put(u, Y - 2, v, v === 5 ? p.bs : B.AIR);
      if (v === 5) found(u, v);
      if (v === 4 || v === 6) put(u, Y - 2, v, p.bs);
      if (rail) {
        wall(u, Y + 1, v, p.bsBricks);
        if (v % 2 === 0) wall(u, Y + 2, v, p.bsBricks);
      }
    }
  }

  // --- courtyard floor -------------------------------------------------------
  for (let u = 4; u <= 40; u++) {
    for (let v = 14; v <= 44; v++) {
      if (!has(u, v)) continue;
      const x = f.x(u, v), z = f.z(u, v);
      const r = hash2(S ^ 21, x, z);
      const path = u >= 21 && u <= 23 && v <= 29;
      put(u, Y, v, path ? p.bsPolished : r < 0.35 ? p.bsPolished : r < 0.8 ? p.bs : r < 0.97 ? p.basalt : B.MAGMA);
      put(u, Y - 1, v, p.bs);
      // rubble fallen from the walls
      if (!path && hash2(S ^ 22, x, z) < 0.045) {
        put(u, Y + 1, v, weather(p.bs, x, Y + 1, z));
        if (hash2(S ^ 23, x, z) < 0.3) put(u, Y + 2, v, p.bsCracked);
      }
    }
  }

  // --- keep walls with a rampart walkway ------------------------------------
  const inKeep = (u: number, v: number): boolean => u >= 2 && u <= 42 && v >= 12 && v <= 46;
  const outer = (u: number, v: number): boolean => u === 2 || u === 42 || v === 12 || v === 46;
  const inner = (u: number, v: number): boolean => !outer(u, v) && (u === 3 || u === 41 || v === 13 || v === 45);
  const stairLane = (u: number, v: number): boolean => (v === 14 || v === 15) && ((u >= 9 && u <= 18) || (u >= 26 && u <= 35));
  for (let u = 2; u <= 42; u++) {
    for (let v = 12; v <= 46; v++) {
      if (!inKeep(u, v) || !has(u, v)) continue;
      if (outer(u, v) || inner(u, v)) {
        const gate = (v === 12 || v === 13) && u >= 20 && u <= 24;
        const along = u === 2 || u === 42 ? v : u;
        found(u, v);
        for (let y = Y + 1; y <= Y + 10; y++) {
          if (gate && (y <= Y + 6 || (y === Y + 7 && u >= 21 && u <= 23))) { put(u, y, v, B.AIR); continue; }
          const band = y === Y + 1 || y === Y + 6;
          const pilaster = outer(u, v) && along % 6 === 0;
          wall(u, y, v, pilaster ? p.basalt : band ? p.bsPolished : p.bsBricks);
        }
        if (outer(u, v)) {
          wall(u, Y + 11, v, p.bsBricks);
          if (along % 2 === 0) wall(u, Y + 12, v, p.bsBricks);
        }
        if (gate && v === 12 && u === 22) put(u, Y + 8, v, B.GOLD_BLOCK); // keystone
      } else if ((u === 4 || u === 40 || v === 14 || v === 44) && !stairLane(u, v)) {
        wall(u, Y + 10, v, p.bsPolished); // corbelled walkway
      }
    }
  }

  // --- corner towers -----------------------------------------------------------
  const towers: [number, number, boolean, boolean][] = [[0, 10, true, true], [36, 10, false, true], [0, 40, true, false], [36, 40, false, false]];
  for (let t = 0; t < towers.length; t++) {
    const [u0, v0, left, front] = towers[t];
    for (let u = u0; u <= u0 + 8; u++) {
      for (let v = v0; v <= v0 + 8; v++) {
        if (!has(u, v)) continue;
        const eu = u === u0 || u === u0 + 8, ev = v === v0 || v === v0 + 8;
        found(u, v);
        if (eu || ev) {
          // where the rampart walkway (wall top + corbel) runs into the tower
          const walkDoor = inKeep(u, v) && (outer(u, v) || inner(u, v) || u === 4 || u === 40 || v === 14 || v === 44);
          const groundDoor = (u === u0 + (left ? 5 : 3) && v === (front ? v0 + 8 : v0));
          for (let y = Y + 1; y <= Y + 16; y++) {
            if (groundDoor && y <= Y + 3) { put(u, y, v, B.AIR); continue; }
            if (walkDoor && !(eu && ev) && (y === Y + 11 || y === Y + 12)) { put(u, y, v, B.AIR); continue; }
            wall(u, y, v, eu && ev ? p.basalt : y === Y + 1 || y === Y + 10 ? p.bsPolished : p.bsBricks);
          }
          if (((u + v) & 1) === 0) wall(u, Y + 17, v, p.bsBricks);
        } else {
          for (let y = Y + 1; y <= Y + 15; y++) put(u, y, v, y === Y + 10 ? p.bsPolished : B.AIR);
          wall(u, Y + 16, v, p.bsBricks);
          put(u, Y, v, p.bsPolished);
        }
      }
    }
    if (has(u0 + 4, v0 + 4)) {
      if (t === 1 || t === 2) put(u0 + 4, Y + 1, v0 + 4, B.CHEST_LOOT);
      put(u0 + 1, Y, v0 + 1, B.MAGMA);
      put(u0 + 7, Y + 10, v0 + 7, B.MAGMA);
    }
  }

  // --- rampart stairs along the inside of the front wall -----------------------
  for (let u = 9; u <= 35; u++) {
    if (u > 18 && u < 26) continue;
    const k = u <= 18 ? 19 - u : u - 25; // 1..10, climbing away from the gate
    for (const v of [14, 15]) {
      if (!has(u, v)) continue;
      for (let y = Y + 1; y < Y + k; y++) put(u, y, v, p.bs);
      const x = f.x(u, v), z = f.z(u, v);
      ctx.stair(x, Y + k, z, p.bsStairs, p.bsPolished, f.wd(u <= 18 ? 'l' : 'r'));
      for (let y = Y + k + 1; y <= Y + k + 3; y++) put(u, y, v, B.AIR);
    }
  }

  // --- housing units -----------------------------------------------------------
  for (const [u0, v0, doorRight] of [[6, 20, true], [6, 31, true], [30, 20, false], [30, 31, false]] as [number, number, boolean][]) {
    house(u0, v0, doorRight);
  }
  function house(u0: number, v0: number, doorRight: boolean): void {
    const opp = doorRight ? 1 : 7;
    for (let a = 0; a <= 8; a++) {
      for (let c = 0; c <= 8; c++) {
        const u = u0 + a, v = v0 + c;
        if (!has(u, v)) continue;
        const ea = a === 0 || a === 8, ec = c === 0 || c === 8;
        if (ea || ec) {
          const doorFace = doorRight ? a === 8 : a === 0;
          const backFace = doorRight ? a === 0 : a === 8;
          for (let y = Y + 1; y <= Y + 12; y++) {
            if (doorFace && c === 4 && y <= Y + 3) { put(u, y, v, B.AIR); continue; }
            const win = backFace && (c === 2 || c === 6) && (y === Y + 3 || y === Y + 4 || y === Y + 8 || y === Y + 9);
            if (win) { put(u, y, v, B.AIR); continue; }
            wall(u, y, v, ea && ec ? p.basalt : y === Y + 6 ? p.bsPolished : p.bsBricks);
          }
          if (((a + c) & 1) === 0) wall(u, Y + 13, v, p.bsBricks);
          continue;
        }
        // stairs to the upper floor along the c = 1 wall, rising away from the door
        const k = doorRight ? 8 - a : a; // 1..7 from the door side
        const onStair = c === 1 && k >= 1 && k <= 5;
        for (let y = Y + 1; y <= Y + 11; y++) put(u, y, v, B.AIR);
        if (onStair) {
          for (let y = Y + 1; y < Y + k; y++) put(u, y, v, p.bs);
          ctx.stair(f.x(u, v), Y + k, f.z(u, v), p.bsStairs, p.bsPolished, f.wd(doorRight ? 'l' : 'r'));
        }
        const hole = c <= 2 && k >= 1 && k <= 5;
        if (!hole) wall(u, Y + 6, v, p.bsPolished);
        wall(u, Y + 12, v, p.bsBricks);
      }
    }
    put(u0 + 4, Y, v0 + 4, B.MAGMA);
    put(u0 + opp, Y + 1, v0 + 7, B.CHEST_LOOT);
    put(u0 + opp, Y + 1, v0 + 6, B.GOLD_BLOCK);
    put(u0 + 4, Y + 6, v0 + 5, B.MAGMA);
    if (hash2(S ^ 31, u0, v0) < 0.6) put(u0 + opp, Y + 7, v0 + 7, B.CHEST_LOOT);
    put(u0 + opp, Y + 7, v0 + 6, p.gilded);
  }

  // --- treasure room -----------------------------------------------------------
  const plinth = (u: number, v: number): boolean => u >= 20 && u <= 24 && v >= 36 && v <= 40;
  for (let u = 17; u <= 27; u++) {
    for (let v = 29; v <= 44; v++) {
      if (!has(u, v)) continue;
      const x = f.x(u, v), z = f.z(u, v);
      const edge = u === 17 || u === 27 || v === 29 || v === 44;
      if (edge) {
        found(u, v);
        const door = v === 29 && ((u >= 21 && u <= 23) || false);
        for (let y = Y + 1; y <= Y + 14; y++) {
          if (door && (y <= Y + 3 || (y === Y + 4 && u === 22))) { put(u, y, v, B.AIR); continue; }
          const band = y === Y + 1 || y === Y + 7;
          ctx.set(x, y, z, band ? p.bsPolished : weather(p.bsBricks, x, y, z));
        }
        if (((u + v) & 1) === 0) wall(u, Y + 15, v, p.bsBricks);
        continue;
      }
      for (let y = Y + 1; y <= Y + 13; y++) put(u, y, v, B.AIR);
      put(u, Y + 14, v, p.bsBricks);
      put(u, Y - 1, v, p.bs);
      put(u, Y - 2, v, p.bs);
      const moat = u >= 18 && u <= 26 && v >= 34 && v <= 42 && !plinth(u, v);
      if (moat) {
        const bridge = u === 22 && v <= 35;
        put(u, Y, v, bridge ? p.bs : B.LAVA);
        if (bridge) put(u, Y + 1, v, p.bsPolished);
      } else if (plinth(u, v)) {
        const side = u === 20 || u === 24 || v === 36 || v === 40;
        for (let y = Y; y <= Y + 3; y++) {
          const rich = side && y >= Y + 1 && y <= Y + 2 && hash3(S ^ 41, x, y, z) < 0.35;
          put(u, y, v, rich ? p.gilded : y === Y + 3 ? p.bsPolished : p.bs);
        }
      } else {
        put(u, Y, v, v === 43 || ((u === 18 || u === 26) && v <= 33) ? B.MAGMA : p.bsPolished);
      }
    }
  }
  if (has(22, 36)) put(22, Y + 3, 36, B.AIR); // the step up onto the plinth
  put(22, Y + 2, 36, p.bsPolished);
  for (const [u, v] of [[20, 36], [24, 36], [20, 40], [24, 40], [22, 40], [21, 40], [23, 40]]) put(u, Y + 4, v, B.GOLD_BLOCK);
  put(22, Y + 5, 40, B.GOLD_BLOCK);
  put(21, Y + 4, 38, B.CHEST_LOOT);
  put(23, Y + 4, 38, B.CHEST_LOOT);
  put(22, Y + 3, 38, B.MAGMA);
  // lavafalls pouring from the ceiling in the back corners
  for (const u of [18, 26]) for (let y = Y; y <= Y + 13; y++) put(u, y, 43, B.LAVA);
  for (const [u, v] of [[19, 32], [25, 32], [19, 41], [25, 41]]) put(u, Y + 14, v, B.MAGMA);
  put(22, Y + 6, 29, B.GOLD_BLOCK);

  // --- braziers flanking the processional path ---------------------------------
  for (const [u, v] of [[19, 18], [25, 18], [19, 25], [25, 25]]) {
    if (!has(u, v)) continue;
    for (let y = Y + 1; y <= Y + 4; y++) put(u, y, v, p.basalt);
    put(u, Y + 5, v, B.MAGMA);
    put(u, Y + 6, v, B.FIRE);
  }
}

/** Hollow out the bastion's cavern and level its floor into a plateau. */
function carveCavern(ctx: Ctx, b: BastionPlan): void {
  const Y = b.y;
  for (let lz = 0; lz < CZ; lz++) {
    for (let lx = 0; lx < CX; lx++) {
      const x = ctx.bx + lx, z = ctx.bz + lz;
      const dx = (x - b.cx) / b.rx, dz = (z - b.cz) / b.rz;
      const wob = 0.9 + 0.3 * vnoise(b.seed ^ 0x21, x, z, 9);
      const t = (dx * dx + dz * dz) / (wob * wob);
      if (t >= 1) continue;
      const roof = Y + Math.round(b.ry * Math.sqrt(1 - t) * (0.8 + 0.4 * vnoise(b.seed ^ 0x22, x, z, 6)));
      for (let y = Y + 1; y <= roof; y++) ctx.set(x, y, z, B.AIR);
      const r = hash2(b.seed ^ 0x23, x, z);
      ctx.set(x, Y, z, r < 0.62 ? B.NETHERRACK : r < 0.9 ? pal().bs : r < 0.97 ? B.SOUL_SAND : B.MAGMA);
      ctx.pillar(x, z, Y - 1, B.NETHERRACK);
    }
  }
}

// --- small features -----------------------------------------------------------

/** Lowest floor in [yLo, yHi] at a chunk column with `clear` open blocks above it. */
function findFloor(ctx: Ctx, x: number, z: number, yLo: number, yHi: number, clear: number): number {
  for (let y = yLo; y <= yHi; y++) {
    if (!isOpaque(ctx.get(x, y, z))) continue;
    let ok = true;
    for (let k = 1; k <= clear && ok; k++) {
      const id = ctx.get(x, y + k, z);
      if (isOpaque(id) || id === B.LAVA) ok = false;
    }
    if (ok) return y;
  }
  return -1;
}

/** Is there a floor within ±tol of y at this column? */
function floorNear(ctx: Ctx, x: number, z: number, y: number, tol: number): boolean {
  for (let k = y - tol; k <= y + tol; k++) {
    if (isOpaque(ctx.get(x, k, z)) && !isOpaque(ctx.get(x, k + 1, z)) && ctx.get(x, k + 1, z) !== B.LAVA) return true;
  }
  return false;
}

/** A floor at the chunk centre that's roughly level over a (2r+1)² footprint. */
function levelSite(ctx: Ctx, r: number, clear: number): number {
  const cx = ctx.bx + 8, cz = ctx.bz + 8;
  let y = 32;
  while (y < 110) {
    const f = findFloor(ctx, cx, cz, y, 110, clear);
    if (f < 0) return -1;
    if (floorNear(ctx, cx - r, cz - r, f, 3) && floorNear(ctx, cx + r, cz - r, f, 3) &&
      floorNear(ctx, cx - r, cz + r, f, 3) && floorNear(ctx, cx + r, cz + r, f, 3)) return f;
    y = f + 1;
  }
  return -1;
}

/** Ruined portal: a broken obsidian / crying-obsidian frame on a scorched pad
 *  of netherrack, blackstone and magma, with gold, a lava puddle and loot. Some
 *  are missing only a block or two and can be repaired and relit. */
function ruinedPortal(ctx: Ctx, rnd: () => number): void {
  const p = pal();
  const giant = rnd() < 0.2;
  const fw = giant ? 6 : 4, fh = giant ? 8 : 5;
  const R = giant ? 6 : 5;
  const y0 = levelSite(ctx, R - 2, fh + 2);
  if (y0 < 0) return;
  const alongX = rnd() < 0.5;
  const cx = ctx.bx + 8, cz = ctx.bz + 8;
  const S = Math.floor(rnd() * 0x7fffffff);
  // scorched pad, clearing the air above it
  for (let dx = -R; dx <= R; dx++) {
    for (let dz = -R; dz <= R; dz++) {
      const d = Math.hypot(dx, dz);
      if (d > R - 0.5 + hash2(S, dx, dz) * 1.2) continue;
      const x = cx + dx, z = cz + dz;
      const r = hash2(S ^ 1, x, z);
      ctx.set(x, y0, z, r < 0.45 ? B.NETHERRACK : r < 0.66 ? p.bs : r < 0.8 ? B.MAGMA : r < 0.87 ? p.crying : r < 0.9 ? B.OBSIDIAN : B.NETHERRACK);
      ctx.pillar(x, z, y0 - 1, B.NETHERRACK);
      const across = alongX ? dz : dx;
      const top = Math.abs(across) <= 1 ? y0 + fh + 1 : y0 + 3;
      for (let y = y0 + 1; y <= top; y++) ctx.set(x, y, z, B.AIR);
    }
  }
  // the frame
  const rebuildable = rnd() < 0.45;
  const edges: [number, number][] = [];
  for (let a = 0; a < fw; a++) for (let k = 0; k < fh; k++) if (a === 0 || a === fw - 1 || k === 0 || k === fh - 1) edges.push([a, k]);
  const missing = new Set<number>();
  if (rebuildable) {
    const n = 1 + Math.floor(rnd() * 2);
    for (let i = 0; i < n; i++) missing.add(Math.floor(rnd() * edges.length));
  } else {
    for (let i = 0; i < edges.length; i++) if (rnd() < 0.12 + edges[i][1] * 0.06) missing.add(i);
  }
  const at = (a: number, perp: number): [number, number] => {
    const off = a - (fw >> 1);
    return alongX ? [cx + off, cz + perp] : [cx + perp, cz + off];
  };
  for (let i = 0; i < edges.length; i++) {
    const [a, k] = edges[i];
    const [x, z] = at(a, 0);
    if (missing.has(i)) {
      // the fallen block lies on the pad nearby
      if (rnd() < 0.6) {
        const [fx, fz] = at(Math.floor(rnd() * (fw + 2)) - 1, (rnd() < 0.5 ? -1 : 1) * (2 + Math.floor(rnd() * 2)));
        ctx.set(fx, y0 + 1, fz, rnd() < 0.3 ? p.crying : B.OBSIDIAN);
      }
      continue;
    }
    ctx.set(x, y0 + 1 + k, z, rnd() < 0.2 ? p.crying : B.OBSIDIAN);
  }
  for (let a = 1; a < fw - 1; a++) for (let k = 1; k < fh - 1; k++) { const [x, z] = at(a, 0); ctx.set(x, y0 + 1 + k, z, B.AIR); }
  // loot, gold and a lava puddle
  const [chx, chz] = at(fw, 2);
  ctx.set(chx, y0 + 1, chz, B.CHEST_LOOT);
  const [gx, gz] = at(-1, -2);
  ctx.set(gx, y0, gz, B.GOLD_BLOCK);
  if (rnd() < 0.5) { const [g2x, g2z] = at(fw - 1, 3); ctx.set(g2x, y0 + 1, g2z, B.GOLD_BLOCK); }
  const [lx, lz] = at(1, -3);
  if (isOpaque(ctx.get(lx, y0 - 1, lz))) ctx.set(lx, y0, lz, B.LAVA);
}

/** Soul-sand-valley fossil: a half-buried spine, rib cage and skull of bone. */
function fossil(ctx: Ctx, rnd: () => number): void {
  const p = pal();
  const cx = ctx.bx + 8, cz = ctx.bz + 8;
  const y0 = findFloor(ctx, cx, cz, 30, 110, 7);
  if (y0 < 0) return;
  const ground = ctx.get(cx, y0, cz);
  if (ground !== B.SOUL_SAND && ground !== p.soulSoil) return;
  const alongX = rnd() < 0.5;
  const base = y0 + (rnd() < 0.5 ? 0 : 1); // spine half-sunk or lying on the sand
  const S = Math.floor(rnd() * 0x7fffffff);
  const put = (a: number, perp: number, dy: number): void => {
    const x = alongX ? cx + a : cx + perp, z = alongX ? cz + perp : cz + a;
    if (hash3(S, a, perp, dy) < 0.1) return; // weathered away
    ctx.set(x, base + dy, z, p.bone);
  };
  for (let a = -6; a <= 2; a++) put(a, 0, a === -6 ? -1 : 0); // spine, the tail dipping into the sand
  const RIB_BIG: [number, number][] = [[1, 0], [2, 1], [3, 2], [3, 3], [2, 4], [1, 5]];
  const RIB_SMALL: [number, number][] = [[1, 0], [2, 1], [2, 2], [1, 3]];
  for (let a = -4; a <= 2; a += 2) {
    const rib = a >= -2 ? RIB_BIG : RIB_SMALL;
    for (const [perp, dy] of rib) { put(a, perp, dy); put(a, -perp, dy); }
  }
  // skull: a 3x3x3 block with eye sockets and a hollow braincase
  for (let a = 3; a <= 5; a++) {
    for (let perp = -1; perp <= 1; perp++) {
      for (let dy = 0; dy <= 2; dy++) {
        const eye = a === 5 && dy === 1 && perp !== 0;
        const hollow = a === 4 && perp === 0 && dy === 1;
        if (eye || hollow) continue;
        const x = alongX ? cx + a : cx + perp, z = alongX ? cz + perp : cz + a;
        ctx.set(x, base + dy, z, p.bone);
      }
    }
  }
  // clear the sockets and braincase properly (they might sit in the sand)
  for (const [a, perp] of [[5, -1], [5, 1], [4, 0]]) {
    const x = alongX ? cx + a : cx + perp, z = alongX ? cz + perp : cz + a;
    ctx.set(x, base + 1, z, B.AIR);
  }
}

/** Piglin hunting camp: a campfire ringed by stem seats, two wool lean-tos, a
 *  gold hoard with a chest, a hoglin carcass and a banner pole with a lantern. */
function piglinCamp(ctx: Ctx, rnd: () => number): void {
  const p = pal();
  const y0 = levelSite(ctx, 5, 6);
  if (y0 < 0) return;
  const bx = ctx.bx, bz = ctx.bz;
  const S = Math.floor(rnd() * 0x7fffffff);
  // level the site
  for (let lx = 1; lx <= 14; lx++) {
    for (let lz = 1; lz <= 14; lz++) {
      const d = Math.hypot(lx - 7.5, lz - 7.5);
      if (d > 6.8 + hash2(S, lx, lz)) continue;
      const x = bx + lx, z = bz + lz;
      if (!isOpaque(ctx.get(x, y0, z)) || ctx.get(x, y0, z) === B.MAGMA) ctx.set(x, y0, z, B.NETHERRACK);
      ctx.pillar(x, z, y0 - 1, B.NETHERRACK);
      for (let y = y0 + 1; y <= y0 + 5; y++) ctx.set(x, y, z, B.AIR);
      if (d < 3.2 && hash2(S ^ 1, lx, lz) < 0.5) ctx.set(x, y0, z, p.soulSoil); // trampled, ashy ground
    }
  }
  const at = (lx: number, dy: number, lz: number, id: number): void => ctx.set(bx + lx, y0 + dy, bz + lz, id);
  at(8, 1, 8, B.CAMPFIRE);
  ctx.meta(bx + 8, y0 + 1, bz + 8, Math.floor(rnd() * 4));
  for (const [lx, lz] of [[5, 8], [11, 8], [8, 5], [8, 11]]) at(lx, 1, lz, p.stem);
  // lean-to tents (A-frames of dyed wool), entrances facing the fire
  const wool = [B.RED_WOOL, B.BLACK_WOOL, B.ORANGE_WOOL][Math.floor(rnd() * 3)];
  for (let lz = 2; lz <= 5; lz++) {
    at(2, 1, lz, wool); at(4, 1, lz, wool);
    at(3, 2, lz, lz === 2 || lz === 5 ? p.stem : wool);
    if (lz === 2) at(3, 1, lz, wool);
  }
  for (let lx = 10; lx <= 13; lx++) {
    at(lx, 1, 12, wool); at(lx, 1, 14, wool);
    at(lx, 2, 13, lx === 10 || lx === 13 ? p.stem : wool);
    if (lx === 13) at(lx, 1, 13, wool);
  }
  // gold hoard + chest
  at(12, 1, 3, B.GOLD_BLOCK);
  at(13, 1, 3, p.gilded);
  at(12, 2, 3, B.GOLD_BLOCK);
  at(12, 1, 4, B.CHEST_LOOT);
  // hoglin carcass: ribs and a skull
  at(3, 1, 11, p.bone); at(4, 1, 11, p.bone); at(5, 1, 11, p.bone);
  at(4, 2, 11, p.bone); at(5, 1, 12, p.bone);
  // banner pole with a hanging lantern
  for (let dy = 1; dy <= 4; dy++) at(13, dy, 9, p.stem);
  at(12, 4, 9, wool); at(12, 3, 9, wool);
  at(13, 5, 9, p.lantern);
}

/** Abandoned lava outpost: a nether-brick pier rising out of the lava sea with
 *  a railed deck, a roofless guard hut, braziers and broken bridge stubs. */
function lavaOutpost(ctx: Ctx, rnd: () => number): void {
  const p = pal();
  const cx = ctx.bx + 8, cz = ctx.bz + 8;
  let Ls = -1;
  for (let y = 5; y < 110; y++) {
    if (ctx.get(cx, y, cz) === B.LAVA && ctx.get(cx, y + 1, cz) === B.AIR) { Ls = y; break; }
  }
  if (Ls < 0) return;
  for (const [dx, dz] of [[-5, -5], [5, -5], [-5, 5], [5, 5]]) {
    if (ctx.get(cx + dx, Ls, cz + dz) !== B.LAVA) return; // needs open lava all round
  }
  const Y = Ls + 5;
  const S = Math.floor(rnd() * 0x7fffffff);
  const open = Math.floor(rnd() * 4); // the hut's open side
  const exits = [open, (open + 1 + Math.floor(rnd() * 3)) & 3];
  for (let dx = -4; dx <= 4; dx++) {
    for (let dz = -4; dz <= 4; dz++) {
      const x = cx + dx, z = cz + dz;
      const m = Math.max(Math.abs(dx), Math.abs(dz));
      for (let y = Y + 1; y <= Y + 7; y++) ctx.set(x, y, z, B.AIR);
      ctx.set(x, Y, z, p.brick);
      ctx.set(x, Y - 1, z, p.brick);
      if (m <= 2) ctx.pillar(x, z, Y - 2, p.brick);                 // the pier
      else if (m === 3) ctx.set(x, Y - 2, z, p.brick);
      if (m === 4) {
        const side = sideOf(dx, dz, 4);
        const gap = exits.includes(side) && Math.abs(perpOf(dx, dz, side)) <= 1;
        if (!gap && hash2(S, x, z) > 0.12) {
          ctx.set(x, Y + 1, z, p.brick);
          if (p.fence && hash2(S ^ 1, x, z) > 0.2) ctx.set(x, Y + 2, z, p.fence);
        }
      }
    }
  }
  // roofless guard hut: three walls, a half-fallen roof
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      const m = Math.max(Math.abs(dx), Math.abs(dz));
      const x = cx + dx, z = cz + dz;
      if (m === 2 && sideOf(dx, dz, 2) !== open) {
        for (let y = Y + 1; y <= Y + 3; y++) if (hash3(S ^ 2, x, y, z) > 0.1) ctx.set(x, y, z, y === Y + 3 ? p.brickAlt : p.brick);
      }
      if (hash2(S ^ 3, x, z) < 0.55) ctx.set(x, Y + 4, z, p.brick);
    }
  }
  const back = (open + 2) & 3;
  ctx.set(cx + DX[back], Y + 1, cz + DZ[back], B.CHEST_LOOT);
  // braziers on two corners
  for (const [dx, dz] of [[-4, -4], [4, 4]]) {
    ctx.set(cx + dx, Y + 1, cz + dz, B.MAGMA);
    ctx.set(cx + dx, Y + 2, cz + dz, B.FIRE);
  }
  // broken bridge stubs out to the chunk edge, crumbling into the lava
  for (const s of exits) {
    for (let t = 5; t <= 7; t++) {
      const decay = (t - 4) / 4;
      for (let w = -1; w <= 1; w++) {
        const x = cx + DX[s] * t + (s === 0 || s === 2 ? w : 0);
        const z = cz + DZ[s] * t + (s === 1 || s === 3 ? w : 0);
        if (hash3(S ^ 4, x, t, z) < decay) continue;
        ctx.set(x, Y, z, p.brick);
        if (w !== 0 && hash3(S ^ 5, x, t, z) > decay) ctx.set(x, Y + 1, z, p.brick);
        if (t === 6 && w === 0) {
          // a snapped pier standing in the lava below the gap
          for (let y = Y - 1; y >= Ls - 2; y--) ctx.set(x, y, z, p.brick);
        }
      }
    }
  }
}

// --- loot -------------------------------------------------------------------

export type NetherLootKind = 'fortress' | 'bastion' | 'bastion_treasure' | 'ruined_portal' | 'camp' | 'outpost';
type LootEntry = [id: number | string, min: number, max: number, weight: number, ench?: Record<string, number>];

const LOOT: Record<NetherLootKind, { rolls: [number, number]; pool: LootEntry[] }> = {
  fortress: {
    rolls: [3, 6],
    pool: [
      [I.GOLD_INGOT, 1, 3, 15], [I.IRON_INGOT, 1, 5, 5], [I.DIAMOND, 1, 3, 5], [I.GOLD_SWORD, 1, 1, 5],
      [I.GOLD_CHEST, 1, 1, 5], [I.FLINT_AND_STEEL, 1, 1, 5], ['nether_wart', 3, 7, 5], [I.SADDLE, 1, 1, 10],
      [I.HORSE_ARMOR, 1, 1, 8], [B.OBSIDIAN, 2, 4, 2], ['blaze_rod', 1, 2, 3], [I.QUARTZ, 2, 6, 4],
      [I.POTION_FIRE_RESISTANCE, 1, 1, 2], [I.GOLDEN_APPLE, 1, 1, 1],
    ],
  },
  outpost: {
    rolls: [2, 5],
    pool: [
      [I.GOLD_INGOT, 1, 3, 10], [I.IRON_INGOT, 1, 4, 6], [I.FLINT_AND_STEEL, 1, 1, 4], [B.OBSIDIAN, 1, 3, 3],
      ['nether_wart', 2, 5, 5], [I.QUARTZ, 2, 8, 6], [I.COAL, 2, 6, 5], [I.ARROW, 4, 10, 4], [I.SADDLE, 1, 1, 3],
      [I.DIAMOND, 1, 1, 1], [B.GLOWSTONE, 1, 3, 3],
    ],
  },
  bastion: {
    rolls: [4, 7],
    pool: [
      [I.GOLD_INGOT, 2, 6, 12], ['gold_nugget', 4, 12, 10], [I.IRON_INGOT, 2, 6, 8], [B.GOLD_BLOCK, 1, 1, 3],
      ['gilded_blackstone', 1, 5, 4], ['crying_obsidian', 1, 5, 4], [B.OBSIDIAN, 2, 6, 4], ['magma_cream', 2, 6, 3],
      [I.ARROW, 5, 17, 6], [I.STRING, 2, 6, 5], [I.LEATHER, 1, 3, 4], [I.COOKED_PORKCHOP, 2, 5, 6],
      [I.GOLDEN_CARROT, 2, 6, 4], [I.GOLD_PICK, 1, 1, 3, { efficiency: 2 }], [I.GOLD_BOOTS, 1, 1, 3, { protection: 2 }],
      [I.GOLD_HELMET, 1, 1, 3], [I.GOLD_AXE, 1, 1, 2], [I.IRON_SWORD, 1, 1, 3], [I.DIAMOND, 1, 2, 2],
      ['netherite_scrap', 1, 1, 1], ['blackstone', 4, 16, 4],
    ],
  },
  bastion_treasure: {
    rolls: [5, 8],
    pool: [
      [I.DIAMOND, 2, 6, 8], [B.GOLD_BLOCK, 2, 5, 8], [I.GOLD_INGOT, 3, 9, 10], ['netherite_ingot', 1, 1, 2],
      ['netherite_scrap', 1, 2, 4], ['ancient_debris', 1, 2, 4], [I.ENCHANTED_GOLDEN_APPLE, 1, 1, 2],
      [I.GOLDEN_APPLE, 1, 3, 5], [I.DIAMOND_SWORD, 1, 1, 3, { sharpness: 3, unbreaking: 2 }],
      [I.DIAMOND_PICK, 1, 1, 3, { efficiency: 3, fortune: 2 }], [I.DIAMOND_CHEST, 1, 1, 3, { protection: 3 }],
      [I.DIAMOND_HELMET, 1, 1, 2, { protection: 2 }], [I.DIAMOND_BOOTS, 1, 1, 2, { feather_falling: 3 }],
      ['crying_obsidian', 3, 8, 4], ['gilded_blackstone', 3, 9, 4], ['magma_cream', 2, 6, 3], [I.SPYGLASS, 1, 1, 1],
    ],
  },
  ruined_portal: {
    rolls: [3, 6],
    pool: [
      [B.OBSIDIAN, 1, 2, 30], [I.FLINT, 1, 4, 30], [I.FLINT_AND_STEEL, 1, 1, 30], ['gold_nugget', 4, 18, 30],
      [I.GOLD_INGOT, 2, 8, 5], [I.GOLDEN_CARROT, 4, 12, 5], [I.GOLD_SWORD, 1, 1, 15], [I.GOLD_AXE, 1, 1, 15],
      [I.GOLD_HELMET, 1, 1, 15], [I.GOLD_CHEST, 1, 1, 15], [I.GOLD_BOOTS, 1, 1, 15], [I.GOLD_PICK, 1, 1, 15],
      [I.GOLDEN_APPLE, 1, 1, 15], ['crying_obsidian', 1, 3, 10], [B.GOLD_BLOCK, 1, 2, 1],
      [I.ENCHANTED_GOLDEN_APPLE, 1, 1, 1], [I.CLOCK, 1, 1, 5],
    ],
  },
  camp: {
    rolls: [3, 5],
    pool: [
      [I.COOKED_PORKCHOP, 2, 6, 12], [I.PORKCHOP, 2, 5, 8], [I.LEATHER, 2, 5, 10], [I.GOLD_INGOT, 1, 4, 8],
      ['gold_nugget', 3, 10, 8], [I.ARROW, 4, 12, 8], [I.STRING, 1, 4, 5], [I.GOLD_SWORD, 1, 1, 4],
      [I.GOLD_AXE, 1, 1, 3], [I.BONE, 2, 6, 6], [I.SADDLE, 1, 1, 2], [I.GOLDEN_CARROT, 1, 3, 3],
    ],
  },
};

/** Which loot table a generated Nether chest at (x, y, z) belongs to. */
export function netherLootKind(seed: number, x: number, y: number, z: number): NetherLootKind {
  const big = bigAt(seed, x, z);
  if (big?.kind === 'bastion') {
    return x >= big.tx0 && x <= big.tx1 && z >= big.tz0 && z <= big.tz1 && y >= big.y + 3 ? 'bastion_treasure' : 'bastion';
  }
  if (big) return 'fortress';
  const small = smallFeatureAt(seed, Math.floor(x / CX), Math.floor(z / CZ));
  return small === 'ruined_portal' ? 'ruined_portal' : small === 'camp' ? 'camp' : small === 'outpost' ? 'outpost' : 'fortress';
}

/** Roll a Nether structure chest's loot into its slots (on first open). */
export function fillNetherChest(slots: (SlotData | null)[], seed: number, x: number, y: number, z: number): void {
  const table = LOOT[netherLootKind(seed, x, y, z)];
  const pool: [number, number, number, number, Record<string, number> | undefined][] = [];
  for (const [ref, min, max, w, ench] of table.pool) {
    const id = typeof ref === 'number' ? ref : idByName(ref, -1);
    if (id > 0) pool.push([id, min, max, w, ench]);
  }
  const total = pool.reduce((s, e) => s + e[3], 0);
  const [lo, hi] = table.rolls;
  const n = lo + Math.floor(Math.random() * (hi - lo + 1));
  for (let i = 0; i < n; i++) {
    let r = Math.random() * total;
    let e = pool[0];
    for (const c of pool) { r -= c[3]; if (r <= 0) { e = c; break; } }
    const count = e[1] + Math.floor(Math.random() * (e[2] - e[1] + 1));
    const slot = Math.floor(Math.random() * slots.length);
    if (slots[slot]) continue;
    slots[slot] = e[4] ? { id: e[0], count, ench: { ...e[4] } } : { id: e[0], count };
  }
}
