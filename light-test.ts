// Deterministic check of the torch flood-fill: generate terrain, place a
// torch, mesh the chunk, and verify nearby vertices carry block light.
import { World } from './src/engine/World.ts';
import { buildChunkGeometry } from './src/engine/Mesher.ts';
import { B } from './src/engine/Blocks.ts';
import type { Atlas } from './src/engine/Textures.ts';

const mockAtlas = {
  rect: () => ({ u0: 0, v0: 0, u1: 1, v1: 1 }),
} as unknown as Atlas;

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) failures++;
}

const world = new World(1234);
world.viewDist = 2;
for (let i = 0; i < 50; i++) world.update(8, 8, 50);
check('chunks generated', world.countLoaded() >= 25);

// find the surface at (8, 8)
const chunk = world.getChunk(0, 0)!;
const h = chunk.heightmap[8 * 16 + 8]; // first free y at local (8,8)
check('surface found', h > 1 && h < 120);

// generated terrain can hold its own glowers (lava, glowstone, magma, lush
// caves), so light far from the torch is measured against this baseline
const lit = (L: Float32Array | number[], i: number): number => (L[i * 2 + 1] >= 4 ? 0 : L[i * 2 + 1] % 2);
const geo0 = buildChunkGeometry(world, chunk, mockAtlas);
const P0 = geo0.solid!.positions, L0 = geo0.solid!.lights;
let baseFar = 0, baseAny = 0;
for (let i = 0; i < P0.length / 3; i++) {
  const d = Math.hypot(P0[i * 3] - 8.5, P0[i * 3 + 1] - h, P0[i * 3 + 2] - 8.5);
  if (lit(L0, i) > 0.05) { baseAny++; if (d > 20) baseFar++; }
}

// place a torch on the surface
const ok = world.setBlock(8, h, 8, B.TORCH);
check('torch placed', ok && world.getBlock(8, h, 8) === B.TORCH);
check('torch tracked', chunk.torches.size === 1);

const geo = buildChunkGeometry(world, chunk, mockAtlas);
check('solid mesh built', !!geo.solid);

// the mesher returns raw arrays; the torch channel carries flag bits (+2 sway,
// +4 lava) above the 0..1 light value, so strip them with % 2
const P = geo.solid!.positions, L = geo.solid!.lights;
check('alight pairs present', L.length === (P.length / 3) * 2);
const pos = { count: P.length / 3, getX: (i: number) => P[i * 3], getY: (i: number) => P[i * 3 + 1], getZ: (i: number) => P[i * 3 + 2] };
const light = { getY: (i: number) => (L[i * 2 + 1] >= 4 ? 0 : L[i * 2 + 1] % 2) }; // lava is self-lit

// scan vertices: those near the torch should carry block light
let nearLit = 0, nearTotal = 0, farLit = 0, maxNear = 0;
for (let i = 0; i < pos.count; i++) {
  const dx = pos.getX(i) - 8.5, dy = pos.getY(i) - h, dz = pos.getZ(i) - 8.5;
  const d = Math.hypot(dx, dy, dz);
  const bl = light.getY(i);
  if (d < 3) {
    nearTotal++;
    if (bl > 0.02) nearLit++; // any block light (it is curved + face-shaded)
    maxNear = Math.max(maxNear, bl);
  } else if (d > 20 && bl > 0.05) {
    farLit++;
  }
}
console.log(`  near torch: ${nearLit}/${nearTotal} lit, max block light ${maxNear.toFixed(2)}`);
check('vertices near torch are lit', nearLit >= 20); // d<3 also catches unconnected cave faces
check('strong light at the torch', maxNear > 0.6);
check('light attenuates with distance', farLit === baseFar);

// breaking the torch clears the light
world.setBlock(8, h, 8, B.AIR);
const geo2 = buildChunkGeometry(world, chunk, mockAtlas);
const L2 = geo2.solid!.lights;
let anyLit = 0;
for (let i = 0; i < L2.length / 2; i++) if (lit(L2, i) > 0.05) anyLit++;
check('light removed with torch', anyLit === baseAny);

// soul light reaches the special emitters too: a soul lantern beside a flower,
// a slab and a plain torch tints their vertices (FLAG_SOUL eighths above the
// sway/lava bits: soul share = floor(L / 8) / 7)
const soulShare = (v: number): number => Math.floor(v / 8) / 7;
world.setBlock(8, h, 8, B.SOUL_LANTERN);
world.setBlock(9, h, 8, B.POPPY);
world.setBlock(8, h, 9, B.STONE_SLAB);
world.setBlock(7, h, 8, B.TORCH);
const geo3 = buildChunkGeometry(world, chunk, mockAtlas);
const P3 = geo3.solid!.positions, L3 = geo3.solid!.lights;
const inCell = (i: number, cx: number, cz: number, y0 = 0, y1 = 1): boolean =>
  P3[i * 3] >= cx - 0.001 && P3[i * 3] <= cx + 1.001 && P3[i * 3 + 2] >= cz - 0.001 && P3[i * 3 + 2] <= cz + 1.001
  && P3[i * 3 + 1] >= h + y0 - 0.001 && P3[i * 3 + 1] <= h + y1 + 0.001;
let flowerSoul = 0, slabSoul = 0, lanternSoul = 0, torchSoul = 1;
for (let i = 0; i < P3.length / 3; i++) {
  const s = soulShare(L3[i * 2 + 1]);
  // the poppy's cross quads sit strictly inside its cell (x 9.146..9.854)
  if (P3[i * 3] > 9.1 && P3[i * 3] < 9.9 && P3[i * 3 + 2] > 8.1 && P3[i * 3 + 2] < 8.9 && inCell(i, 9, 8)) flowerSoul = Math.max(flowerSoul, s);
  if (inCell(i, 8, 9, 0, 0.5) && P3[i * 3 + 1] > h + 0.4) slabSoul = Math.max(slabSoul, s);
  if (P3[i * 3] > 8.3 && P3[i * 3] < 8.7 && P3[i * 3 + 2] > 8.3 && P3[i * 3 + 2] < 8.7 && inCell(i, 8, 8)) lanternSoul = Math.max(lanternSoul, s);
  // plain torch column: 7/16..9/16 of its cell
  if (P3[i * 3] > 7.4 && P3[i * 3] < 7.6 && P3[i * 3 + 2] > 8.4 && P3[i * 3 + 2] < 8.6 && inCell(i, 7, 8)) torchSoul = Math.min(torchSoul, s);
}
console.log(`  soul share: flower ${flowerSoul.toFixed(2)} slab ${slabSoul.toFixed(2)} lantern ${lanternSoul.toFixed(2)} torch ${torchSoul.toFixed(2)}`);
check('flower beside a soul lantern carries soul light', flowerSoul > 0.3);
check('slab beside a soul lantern carries soul light', slabSoul > 0.3);
check('soul lantern glows fully soul', lanternSoul > 0.99);
check('a plain torch keeps its warm flame', torchSoul === 0);

// mixed light: a stone beam high in the air with a torch at one end and a soul
// lantern at the other. The tint follows how much light each source actually
// delivers, so it runs warm -> balanced -> cyan along the beam instead of
// snapping to cyan wherever the soul light merely matches the torch.
const Y = Math.min(h + 24, 110);
for (let x = 0; x < 16; x++) for (let z = 2; z <= 6; z++) for (let y = Y; y <= Y + 4; y++) world.setBlock(x, y, z, B.AIR);
for (let x = 1; x <= 14; x++) world.setBlock(x, Y, 4, B.STONE);
world.setBlock(2, Y + 1, 4, B.TORCH);
world.setBlock(13, Y + 1, 4, B.SOUL_LANTERN);
const geo4 = buildChunkGeometry(world, chunk, mockAtlas);
const P4 = geo4.solid!.positions, L4 = geo4.solid!.lights;
/** average soul share of the beam's upper vertices over stone cell x */
const beamSoul = (cx: number): number => {
  let sum = 0, n = 0;
  for (let i = 0; i < P4.length / 3; i++) {
    const px = P4[i * 3], py = P4[i * 3 + 1], pz = P4[i * 3 + 2];
    if (Math.abs(py - (Y + 1)) > 0.001 || px < cx - 0.001 || px > cx + 1.001 || pz < 3.999 || pz > 5.001) continue;
    sum += soulShare(L4[i * 2 + 1]); n++;
  }
  return n ? sum / n : -1;
};
const beam = Array.from({ length: 10 }, (_, k) => beamSoul(3 + k));
console.log(`  beam soul share x=3..12: ${beam.map((s) => s.toFixed(2)).join(' ')}`);
check('beside the torch (soul lantern 10 away) stays warm', beam[0] >= 0 && beam[0] <= 1 / 7 + 0.001);
check('torch-dominant side is mostly warm', beam[2] < 0.35);
check('halfway between equal sources is a balanced mix', beam[5] > 0.3 && beam[5] < 0.7 && beam[4] > 0.25 && beam[4] < 0.65);
check('soul-dominant side is mostly cyan', beam[7] > 0.55 && beam[8] > 0.7);
check('beside the soul lantern is nearly all cyan', beam[9] >= 6 / 7 - 0.001);
let rising = true;
for (let k = 1; k < beam.length; k++) if (beam[k] < beam[k - 1] - 0.001) rising = false;
check('tint shifts steadily from warm to cyan', rising);
// a pure soul area stays fully cyan
world.setBlock(2, Y + 1, 4, B.AIR);
const geo5 = buildChunkGeometry(world, chunk, mockAtlas);
const P5 = geo5.solid!.positions, L5 = geo5.solid!.lights;
let pureMin = 1;
for (let i = 0; i < P5.length / 3; i++) {
  const px = P5[i * 3], py = P5[i * 3 + 1], pz = P5[i * 3 + 2];
  if (Math.abs(py - (Y + 1)) < 0.001 && px >= 3 && px <= 13 && pz >= 3.999 && pz <= 5.001 && L5[i * 2 + 1] % 8 % 2 > 0.02) pureMin = Math.min(pureMin, soulShare(L5[i * 2 + 1]));
}
console.log(`  soul lantern alone: min soul share ${pureMin.toFixed(2)}`);
check('soul light alone is fully cyan', pureMin > 0.99);

console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
process.exit(failures ? 1 : 0);
