// Nether structures: plans a fortress, a bastion and each small feature from
// the placement functions, asserts they generate (bricks, gold, chests, loot
// tables), then flies the camera to each one for outside + inside screenshots.
// PORT / SHOT_DIR env vars as in the other harnesses.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const PORT = +(process.env.PORT ?? 5502);
const DIR = process.env.SHOT_DIR ?? '.';
const ONLY = (process.env.ONLY ?? '').split(','); // only take shots whose name contains one of these
const server = await createServer({ root: process.cwd(), server: { port: PORT, watch: { ignored: ['**/.claude/**'] } } });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}\n${e.stack}`));

await page.goto(`http://localhost:${PORT}/#debugmobs`, { timeout: 180000 });
await page.waitForLoadState('networkidle', { timeout: 180000 });
await page.waitForTimeout(4000);
await page.waitForLoadState('networkidle', { timeout: 180000 });
await page.locator('.mode-pick button', { hasText: 'Creative' }).click({ timeout: 120000 });
await page.locator('.create-btn').click({ timeout: 120000, noWaitAfter: true });
await page.waitForSelector('#loading.hidden', { timeout: 180000, state: 'attached' });
await page.waitForTimeout(2000);
await page.mouse.click(640, 360);
await page.waitForTimeout(300);

const failures = [];
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${info}`); if (!ok) failures.push(name); };

await page.evaluate(() => { window.__game.teleportPlayerDimension(); });
await page.waitForTimeout(3000);

// --- plan + assert (pure generation in the page, no world side effects) --------
const info = await page.evaluate(async () => {
  const NS = await import('/src/engine/NetherStructures.ts');
  const WG = await import('/src/engine/WorldGenerator.ts');
  const CH = await import('/src/engine/Chunk.ts');
  const g = window.__game, B = window.__B;
  const seed = g.world.generator.seed;
  const gen = new WG.WorldGenerator(seed);
  gen.dimension = 'nether';
  const genChunk = (cx, cz) => { const c = new CH.Chunk(cx, cz); gen.generate(c); gen.drainStates({ doorStates: new Map(), torchFacings: new Map(), bedFacings: new Map() }); return c; };
  const count = (c, id) => { let n = 0; for (let i = 0; i < c.data.length; i++) if (c.data[i] === id) n++; return n; };
  const px = g.player.pos.x, pz = g.player.pos.z;
  const plans = NS.listNetherStructures(seed, px, pz, 1200)
    .map((p) => ({ p, d: Math.hypot((p.x0 + p.x1) / 2 - px, (p.z0 + p.z1) / 2 - pz) }))
    .sort((a, b) => a.d - b.d).map((e) => e.p);
  const fort = plans.find((p) => p.kind === 'fortress');
  const bast = plans.find((p) => p.kind === 'bastion');
  const out = { seed, fort: null, bast: null, small: {}, loot: {} };
  if (fort) {
    const o = fort.nodes.find((n) => n.i === 0 && n.j === 0);
    const c = genChunk(Math.floor(o.x / 16), Math.floor(o.z / 16));
    out.fort = {
      y: fort.y, box: [fort.x0, fort.z0, fort.x1, fort.z1],
      nodes: fort.nodes.map((n) => ({ x: n.x, z: n.z, h: n.h, type: n.type, conn: n.conn })),
      edges: fort.edges.map((e) => ({ kind: e.kind, alongX: e.alongX, c: e.c, lo: e.lo, hi: e.hi, stub: e.stub })),
      bricksAtOrigin: count(c, B.NETHER_BRICKS),
      deck: c.get(o.x & 15, fort.y, o.z & 15),
    };
    let chests = 0;
    for (let cx = Math.floor(fort.x0 / 16); cx <= Math.floor(fort.x1 / 16); cx++) {
      for (let cz = Math.floor(fort.z0 / 16); cz <= Math.floor(fort.z1 / 16); cz++) chests += count(genChunk(cx, cz), B.CHEST_LOOT);
    }
    out.fort.chests = chests;
  }
  if (bast) {
    let gold = 0, chests = 0;
    for (let cx = Math.floor(bast.x0 / 16); cx <= Math.floor(bast.x1 / 16); cx++) {
      for (let cz = Math.floor(bast.z0 / 16); cz <= Math.floor(bast.z1 / 16); cz++) {
        const c = genChunk(cx, cz); gold += count(c, B.GOLD_BLOCK); chests += count(c, B.CHEST_LOOT);
      }
    }
    out.bast = { y: bast.y, cx: bast.cx, cz: bast.cz, dir: bast.dir, box: [bast.x0, bast.z0, bast.x1, bast.z1],
      t: [bast.tx0, bast.tz0, bast.tx1, bast.tz1], gold, chests };
  }
  // small features: first chunk (spiralling out) where each kind actually built
  const pcx = Math.floor(px / 16), pcz = Math.floor(pz / 16);
  const marker = { ruined_portal: B.OBSIDIAN, camp: B.CAMPFIRE, outpost: B.CHEST_LOOT, fossil: -1 };
  let tries = 0;
  for (let r = 0; r <= 60 && Object.keys(out.small).length < 4; r++) {
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      const cx = pcx + dx, cz = pcz + dz;
      const kind = NS.smallFeatureAt(seed, cx, cz);
      if (!kind || out.small[kind] || NS.netherStructureAt(seed, cx * 16 + 8, cz * 16 + 8) !== kind) continue;
      if (tries++ > 400) continue;
      const before = new CH.Chunk(cx, cz);
      const c = genChunk(cx, cz);
      let hit = false;
      if (kind === 'fossil') {
        // bone (or its quartz fallback) standing above the soul sand
        const bone = window.__findId('bone_block') > 0 ? window.__findId('bone_block') : B.QUARTZ_BLOCK;
        hit = count(c, bone) > 12;
      } else hit = count(c, marker[kind]) > 0 && count(c, B.CHEST_LOOT) + count(c, B.CAMPFIRE) > 0;
      void before;
      if (!hit) continue;
      // locate the chest / campfire / skull for framing
      let fy = -1;
      for (let y = 1; y < 159 && fy < 0; y++) {
        const id = c.get(8, y, 8);
        if (kind === 'ruined_portal' && id === B.OBSIDIAN) fy = y;
        if (kind === 'camp' && id === B.CAMPFIRE) fy = y;
      }
      if (kind === 'outpost') {
        // the deck: highest nether brick standing over the lava at the centre column
        for (let y = 130; y > 1 && fy < 0; y--) if (c.get(8, y, 8) === B.NETHER_BRICKS && c.get(8, y + 1, 8) !== B.NETHER_BRICKS) fy = y;
      }
      if (kind === 'fossil') {
        const bone = window.__findId('bone_block') > 0 ? window.__findId('bone_block') : B.QUARTZ_BLOCK;
        for (let y = 1; y < 159 && fy < 0; y++) if (c.get(8, y, 8) === bone) fy = y;
      }
      out.small[kind] = { x: cx * 16 + 8, z: cz * 16 + 8, y: fy };
    }
  }
  // loot tables
  const slots = new Array(27).fill(null);
  if (bast) NS.fillNetherChest(slots, seed, (bast.tx0 + bast.tx1) >> 1, bast.y + 4, (bast.tz0 + bast.tz1) >> 1);
  out.loot.treasure = NS.netherLootKind(seed, (bast?.tx0 + bast?.tx1) >> 1, (bast?.y ?? 0) + 4, (bast?.tz0 + bast?.tz1) >> 1);
  out.loot.treasureItems = slots.filter(Boolean).map((s) => s.id);
  if (fort) out.loot.fort = NS.netherLootKind(seed, fort.nodes[0].x, fort.y + 1, fort.nodes[0].z);
  return out;
});
console.log(JSON.stringify({ seed: info.seed, fort: info.fort && { ...info.fort, edges: info.fort.edges.length, nodes: info.fort.nodes.map((n) => n.type).join(',') }, bast: info.bast, small: info.small, loot: info.loot }));
check('fortress planned', !!info.fort);
check('fortress deck is nether brick at origin', info.fort?.deck === 79, `deck=${info.fort?.deck}`);
check('fortress has spawner + garden + stairs', !!info.fort && ['spawner', 'garden', 'stairs'].every((t) => info.fort.nodes.some((n) => n.type === t)));
check('fortress has chests', (info.fort?.chests ?? 0) >= 2, `chests=${info.fort?.chests}`);
check('bastion planned', !!info.bast);
check('bastion has gold + chests', (info.bast?.gold ?? 0) >= 8 && (info.bast?.chests ?? 0) >= 6, `gold=${info.bast?.gold} chests=${info.bast?.chests}`);
check('treasure loot table', info.loot.treasure === 'bastion_treasure' && info.loot.treasureItems.length > 0);
check('fortress loot table', info.loot.fort === 'fortress');
for (const k of ['ruined_portal', 'camp', 'outpost', 'fossil']) check(`small feature ${k} found`, !!info.small[k], JSON.stringify(info.small[k] ?? null));

// --- screenshots ---------------------------------------------------------------
/** Teleport near a spot, wait for the chunks to stream in and mesh. */
async function goNear(x, y, z) {
  await page.evaluate(({ x, y, z }) => {
    const p = window.__game.player;
    p.flying = true; p.vel = { x: 0, y: 0, z: 0 };
    p.pos.x = x; p.pos.y = y; p.pos.z = z;
  }, { x, y, z });
  await page.waitForFunction(({ x, z }) => {
    const g = window.__game;
    const cx0 = Math.floor(x / 16), cz0 = Math.floor(z / 16);
    for (let cx = cx0 - 3; cx <= cx0 + 3; cx++) for (let cz = cz0 - 3; cz <= cz0 + 3; cz++) {
      const k = `${cx},${cz}`;
      const c = g.world.chunks.get(k);
      if (!c || !c.ready || g.world.dirtySet.has(k) || g.meshInFlight.has(k)) return false;
    }
    return true;
  }, { x, z }, { timeout: 180000, polling: 300 }).catch(() => console.log('chunk wait timed out'));
}

/** Frame (tx,ty,tz) from an open-air viewpoint roughly `dist` away. */
async function shootOutside(name, tx, ty, tz, dist, preferYaw = 0) {
  if (!ONLY.some((o) => name.includes(o))) return;
  await goNear(tx, ty + 6, tz);
  const eye = await page.evaluate(({ tx, ty, tz, dist, preferYaw }) => {
    const w = window.__game.world;
    const solid = (x, y, z) => { const id = w.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)); return id !== 0 && id !== 10 && id !== 60 && id !== 99; };
    let best = null, bestScore = 1e9;
    for (let k = 0; k < 16; k++) {
      const a = preferYaw + k / 16 * Math.PI * 2;
      for (const d of [dist, dist * 0.75, dist * 0.5]) {
        for (const dy of [d * 0.35, d * 0.15, d * 0.6]) {
          const ex = tx + Math.cos(a) * d, ey = ty + dy, ez = tz + Math.sin(a) * d;
          if (solid(ex, ey, ez) || solid(ex, ey - 1, ez)) continue;
          let blocked = 0;
          const n = Math.ceil(d);
          for (let i = 1; i < n - 3; i++) {
            const t = i / n;
            if (solid(ex + (tx - ex) * t, ey + (ty - ey) * t, ez + (tz - ez) * t)) blocked++;
          }
          const score = blocked * 10 + k * 0.05 + (dist - d) * 0.3;
          if (score < bestScore) { bestScore = score; best = [ex, ey, ez]; }
        }
      }
    }
    return best ? { eye: best, score: bestScore } : null;
  }, { tx, ty, tz, dist, preferYaw });
  if (!eye) { console.log(`${name}: no viewpoint`); return; }
  await shootFrom(name, eye.eye[0], eye.eye[1], eye.eye[2], tx, ty, tz);
}

async function shootFrom(name, ex, ey, ez, tx, ty, tz) {
  if (!ONLY.some((o) => name.includes(o))) return;
  await page.evaluate(({ ex, ey, ez, tx, ty, tz }) => {
    const p = window.__game.player;
    p.flying = true; p.vel = { x: 0, y: 0, z: 0 };
    p.pos.x = ex; p.pos.y = ey - p.eyeHeight(); p.pos.z = ez;
    const dx = tx - ex, dy = ty - ey, dz = tz - ez;
    p.yaw = Math.atan2(-dx, -dz);
    p.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    for (const e of window.__game.entities.entities) if (window.__game.entities.isMob(e)) e.dead = true;
  }, { ex, ey, ez, tx, ty, tz });
  await goNear(ex, ey, ez);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${DIR}/shot-ns-${name}.png` });
  console.log(`shot ${name}`);
}

if (info.fort) {
  const f = info.fort, Y = f.y;
  const o = f.nodes[0];
  await shootOutside('fortress-outside', o.x, Y + 2, o.z, 34);
  const far = f.nodes.find((n) => n.type === 'spawner');
  if (far) await shootOutside('fortress-spawner-out', far.x, Y + 3, far.z, 22, 1);
  // inside the spawner platform, looking at the cage
  if (far) await shootFrom('fortress-spawner-in', far.x + 3.5, Y + 4.8, far.z + 3.5, far.x + 0.5, Y + 3.8, far.z + 0.5);
  const corr = f.edges.find((e) => e.kind === 'corridor' && e.hi - e.lo > 6);
  if (corr) {
    const ex = corr.alongX ? corr.lo + 0.5 : corr.c + 0.5, ez = corr.alongX ? corr.c + 0.5 : corr.lo + 0.5;
    const tx = corr.alongX ? corr.hi + 0.5 : corr.c + 0.5, tz = corr.alongX ? corr.c + 0.5 : corr.hi + 0.5;
    await shootFrom('fortress-corridor', ex, Y + 2.6, ez, tx, Y + 2.2, tz);
  }
  const br = f.edges.find((e) => e.kind === 'bridge' && !e.stub && e.hi - e.lo > 10) ?? f.edges.find((e) => e.kind === 'bridge');
  if (br) {
    const ex = br.alongX ? br.lo + 0.5 : br.c + 0.5, ez = br.alongX ? br.c + 0.5 : br.lo + 0.5;
    const tx = br.alongX ? br.hi + 0.5 : br.c + 0.5, tz = br.alongX ? br.c + 0.5 : br.hi + 0.5;
    await shootFrom('fortress-bridge-deck', ex, Y + 2.8, ez, tx, Y + 1.5, tz);
    // from underneath/side to show piers and arches
    const mx = (ex + tx) / 2, mz = (ez + tz) / 2;
    await shootOutside('fortress-bridge-side', mx, Y - 4, mz, 20, br.alongX ? Math.PI / 2 : 0);
  }
  const gar = f.nodes.find((n) => n.type === 'garden');
  if (gar) await shootFrom('fortress-garden', gar.x - 4.5, Y + 2.5, gar.z - 4.5, gar.x + 1, Y - 1.5, gar.z + 1);
  const st = f.nodes.find((n) => n.type === 'stairs');
  if (st) {
    // stand in the doorway looking in at the wart beds and the flight up the wall
    const fd = [0, 1, 2, 3].find((s) => st.conn & (1 << s)) ?? 0;
    const ddx = [0, -1, 0, 1][fd], ddz = [-1, 0, 1, 0][fd];
    await shootFrom('fortress-stairs-in', st.x + 0.5 + ddx * 4.5, Y + 3.4, st.z + 0.5 + ddz * 4.5, st.x + 0.5 - ddx * 3, Y + 3, st.z + 0.5 - ddz * 3);
    await shootOutside('fortress-stairs-out', st.x, Y + 8, st.z, 24);
  }
}
if (info.bast) {
  const b = info.bast, Y = b.y;
  // the front faces world dir b.dir: 0=-z,1=-x,2=+z,3=+x
  const fx = [0, -1, 0, 1][b.dir], fz = [-1, 0, 1, 0][b.dir];
  await shootFrom('bastion-front', b.cx + fx * 44, Y + 14, b.cz + fz * 44, b.cx, Y + 6, b.cz);
  await shootOutside('bastion-outside', b.cx, Y + 8, b.cz, 40, 0.7);
  // in the courtyard, just inside the gate, looking at the treasure room
  await shootFrom('bastion-courtyard', b.cx + fx * 9, Y + 3, b.cz + fz * 9, b.cx - fx * 8, Y + 5, b.cz - fz * 8);
  const tx = (b.t[0] + b.t[2]) / 2 + 0.5, tz = (b.t[1] + b.t[3]) / 2 + 0.5;
  await shootFrom('bastion-treasure', tx + fx * 5, Y + 4, tz + fz * 5, tx - fx * 2, Y + 3, tz - fz * 2);
  await shootFrom('bastion-rampart', b.cx + fx * 22 + fz * 16, Y + 12.6, b.cz + fz * 22 - fx * 16, b.cx - fz * 10, Y + 9, b.cz + fx * 10);
}
for (const [k, s] of Object.entries(info.small)) {
  await shootOutside(`small-${k}`, s.x + 0.5, s.y + 2, s.z + 0.5, 13);
}

console.log('--- console errors ---');
console.log(errors.length ? errors.slice(0, 8).join('\n') : 'NONE');
await browser.close();
await server.close();
process.exit(errors.length || failures.length ? 1 : 0);
