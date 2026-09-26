// Nether wood + vines (block ids 256+): crimson/warped planks, slabs, stairs,
// fences and gates plus weeping/twisting vines on the y=108 platform, the
// icon sheet and held models, climbing a vine, vines unravelling when their
// anchor breaks, bone-meal growth, generated vines in the crimson/warped
// forests, and an old-format (u8 RLE) save that must load and migrate its
// roots-as-vines. Screenshots go to $SHOT_DIR.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const PORT = +(process.env.PORT ?? 5251);
const DIR = process.env.SHOT_DIR ?? '.';
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
await page.waitForTimeout(2500);
await page.mouse.click(640, 360);
await page.waitForTimeout(300);

const failures = [];
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${info}`); if (!ok) failures.push(name); };

/** Park the camera at an eye position looking at a target and wait for the
 *  chunks around the target to be generated and meshed. */
async function frame(tx, ty, tz, ex, ey, ez, r = 1) {
  await page.evaluate(({ tx, ty, tz, ex, ey, ez }) => {
    const p = window.__game.player;
    p.flying = true; p.vel = { x: 0, y: 0, z: 0 };
    p.pos.x = ex; p.pos.y = ey - p.eyeHeight(); p.pos.z = ez;
    const dx = tx - ex, dy = ty - ey, dz = tz - ez;
    p.yaw = Math.atan2(-dx, -dz);
    p.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  }, { tx, ty, tz, ex, ey, ez });
  await page.waitForTimeout(500);
  await page.waitForFunction(({ tx, tz, r }) => {
    const g = window.__game;
    const c0x = Math.floor(tx / 16), c0z = Math.floor(tz / 16);
    for (let cx = c0x - r; cx <= c0x + r; cx++) {
      for (let cz = c0z - r; cz <= c0z + r; cz++) {
        const k = `${cx},${cz}`;
        const c = g.world.getChunk(cx, cz);
        if (!c || !c.ready || g.world.dirtySet.has(k) || g.meshInFlight.has(k)) return false;
      }
    }
    return true;
  }, { tx, tz, r }, { timeout: 180000, polling: 300 }).catch(() => console.log('  (mesh wait timed out)'));
  await page.waitForTimeout(900);
}

// --- 1. showcase on the platform -------------------------------------------------
const s = await page.evaluate(() => {
  const g = window.__game, p = g.player, B = window.__B, w = g.world;
  const ox = Math.floor(p.pos.x), oy = 108, oz = Math.floor(p.pos.z);
  for (let dx = -4; dx <= 26; dx++) {
    for (let dz = -8; dz <= 14; dz++) {
      w.setBlock(ox + dx, oy - 1, oz + dz, B.STONE);
      for (let dy = 0; dy <= 10; dy++) w.setBlock(ox + dx, oy + dy, oz + dz, 0);
    }
  }
  for (const e of g.entities.entities) if (g.entities.isMob(e)) e.dead = true;
  const put = (x, y, z, id, meta) => {
    const k = `${ox + x},${oy + y},${oz + z}`;
    w.setBlock(ox + x, oy + y, oz + z, id);
    if (meta !== undefined) w.bedFacings.set(k, meta);
  };
  // row z=0: planks next to their stems (and oak for scale)
  [B.CRIMSON_STEM, B.CRIMSON_PLANKS, B.CRIMSON_PLANKS, B.PLANKS, B.WARPED_PLANKS, B.WARPED_PLANKS, B.WARPED_STEM]
    .forEach((id, i) => put(i, 0, 0, id));
  put(1, 1, 0, B.CRIMSON_PLANKS); put(5, 1, 0, B.WARPED_PLANKS);
  // row z=3: slabs (bottom + floating top) and stairs in every facing
  put(0, 0, 3, B.CRIMSON_SLAB, 0); put(0, 2, 3, B.CRIMSON_SLAB, 1);
  put(1, 0, 3, B.WARPED_SLAB, 0); put(1, 2, 3, B.WARPED_SLAB, 1);
  for (let i = 0; i < 4; i++) { put(3 + i, 0, 3, B.CRIMSON_STAIRS, i); put(8 + i, 0, 3, B.WARPED_STAIRS, i); }
  put(12, 0, 3, B.CRIMSON_PLANKS); put(12, 1, 3, B.CRIMSON_STAIRS, 6); // upside-down under nothing
  // row z=6: fence runs with gates (closed + open)
  for (let i = 0; i < 3; i++) put(i, 0, 6, B.CRIMSON_FENCE);
  put(3, 0, 6, B.CRIMSON_FENCE_GATE); w.doorStates.set(`${ox + 3},${oy},${oz + 6}`, { facing: 0, open: false });
  put(4, 0, 6, B.CRIMSON_FENCE); put(5, 0, 6, B.OAK_FENCE);
  for (let i = 6; i < 9; i++) put(i, 0, 6, B.WARPED_FENCE);
  put(9, 0, 6, B.WARPED_FENCE_GATE); w.doorStates.set(`${ox + 9},${oy},${oz + 6}`, { facing: 0, open: true });
  put(10, 0, 6, B.WARPED_FENCE);
  // row z=9: weeping vines off a wart beam, twisting vines up from nylium
  for (let i = 0; i < 5; i++) {
    put(i, 6, 9, B.NETHER_WART_BLOCK);
    for (let k = 5; k >= 5 - i; k--) put(i, k, 9, B.WEEPING_VINES);
  }
  for (let i = 0; i < 5; i++) {
    put(7 + i, 0, 9, B.WARPED_NYLIUM);
    for (let k = 1; k <= 1 + i; k++) put(7 + i, k, 9, B.TWISTING_VINES);
  }
  p.flying = true; p.vel = { x: 0, y: 0, z: 0 };
  g.dayTime = 0.12;
  return { ox, oy, oz };
});
const { ox, oy, oz } = s;
await frame(ox + 6, oy + 1, oz + 4, ox + 6, oy + 5.5, oz - 7);
await page.screenshot({ path: `${DIR}/wood-overview.png` });
await frame(ox + 1.5, oy + 1, oz + 3.5, ox + 1.5, oy + 3.2, oz - 1.8);
await page.screenshot({ path: `${DIR}/wood-slabs-stairs.png` });
await frame(ox + 5, oy + 0.6, oz + 6.5, ox + 5, oy + 2.4, oz + 1.8);
await page.screenshot({ path: `${DIR}/wood-fences.png` });
await frame(ox + 6, oy + 3, oz + 9.5, ox + 6, oy + 3.6, oz + 2.5);
await page.screenshot({ path: `${DIR}/wood-vines.png` });

check('slabs/stairs/fences are real blocks', await page.evaluate(({ ox, oy, oz }) => {
  const w = window.__game.world, B = window.__B;
  return w.getBlock(ox + 3, oy, oz + 3) === B.CRIMSON_STAIRS && w.getBlock(ox, oy, oz + 6) === B.CRIMSON_FENCE &&
    w.getBlock(ox + 1, oy, oz) === B.CRIMSON_PLANKS && B.CRIMSON_PLANKS > 255;
}, s));

// --- 2. icons + held models ----------------------------------------------------------
await page.evaluate(() => {
  const g = window.__game;
  const ids = [];
  for (let id = 256; id < 300; id++) try { g.atlas.icon(id); ids.push(id); } catch { /* unused id */ }
  const cols = 8;
  const c = document.createElement('canvas');
  c.width = cols * 36; c.height = Math.ceil(ids.length / cols) * 36;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#8b8b8b'; ctx.fillRect(0, 0, c.width, c.height);
  ids.forEach((id, i) => {
    ctx.fillStyle = '#6f6f6f'; ctx.fillRect((i % cols) * 36 + 1, Math.floor(i / cols) * 36 + 1, 34, 34);
    ctx.drawImage(g.atlas.icon(id), (i % cols) * 36 + 2, Math.floor(i / cols) * 36 + 2);
  });
  c.id = 'icon-sheet';
  Object.assign(c.style, { position: 'fixed', left: '10px', top: '10px', zIndex: 99999, transform: 'scale(2)', transformOrigin: '0 0', imageRendering: 'pixelated' });
  document.body.appendChild(c);
});
await page.waitForTimeout(200);
await page.locator('#icon-sheet').screenshot({ path: `${DIR}/wood-icons.png` });
await page.evaluate(() => document.getElementById('icon-sheet')?.remove());
for (const name of ['crimson_stairs', 'warped_fence', 'weeping_vines']) {
  await page.evaluate((name) => {
    const g = window.__game, p = g.player;
    p.pitch = -0.1;
    p.inventory.slots[0] = { id: window.__findId(name), count: 1 };
    p.inventory.selected = 0; g.onInventoryChange();
  }, name);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${DIR}/wood-held-${name}.png`, clip: { x: 640, y: 300, width: 640, height: 420 } });
}

// --- 3. climbing ------------------------------------------------------------------------
const climb = await page.evaluate(({ ox, oy, oz }) => {
  const g = window.__game, p = g.player, B = window.__B, w = g.world;
  const x = ox + 20, z = oz + 2;
  w.setBlock(x, oy, z, B.WARPED_NYLIUM);
  for (let k = 1; k <= 9; k++) w.setBlock(x, oy + k, z, B.TWISTING_VINES);
  p.inventory.slots[0] = null; g.onInventoryChange();
  p.flying = false; p.vel = { x: 0, y: 0, z: 0 };
  p.pos.x = x + 0.5; p.pos.y = oy + 1; p.pos.z = z + 0.5;
  p.yaw = Math.PI; p.pitch = -0.9; // look down the vine being climbed
  return { x, z, y0: p.pos.y };
}, s);
await page.keyboard.down('Space');
// hold until it has climbed (or 6 s: a loaded machine runs the sim slower)
await page.waitForFunction((y0) => window.__game.player.pos.y - y0 > 1.6, climb.y0, { timeout: 6000, polling: 100 }).catch(() => {});
const climbed = await page.evaluate(() => ({ y: window.__game.player.pos.y, onLadder: window.__game.player.onLadder }));
await page.screenshot({ path: `${DIR}/wood-climb.png` });
await page.keyboard.up('Space');
check('climbs a twisting vine', climbed.y - climb.y0 > 1.5, `rose ${(climbed.y - climb.y0).toFixed(2)} (onLadder ${climbed.onLadder})`);
// letting go: clings and slides slowly instead of falling
await page.waitForTimeout(500);
const cling = await page.evaluate(() => ({ vy: window.__game.player.vel.y, fall: window.__game.player.fallDist }));
check('clings to the vine', cling.vy > -1.5 && cling.fall < 0.5, JSON.stringify(cling));
await page.evaluate(() => { window.__game.player.flying = true; });

// --- 4. unravelling + bone meal ---------------------------------------------------------------
const chain = await page.evaluate(async ({ ox, oy, oz }) => {
  const g = window.__game, B = window.__B, w = g.world;
  // weeping vine 4 long under the beam at (ox+4, oy+6): break the beam
  const before = [1, 2, 3, 4, 5].map((k) => w.getBlock(ox + 4, oy + 6 - k, oz + 9));
  w.setBlock(ox + 4, oy + 6, oz + 9, B.AIR);
  // twisting vine 5 tall at ox+11: cut the 2nd segment, the ones above must go
  w.setBlock(ox + 11, oy + 2, oz + 9, B.AIR);
  await new Promise((r) => setTimeout(r, 2500));
  const after = [1, 2, 3, 4, 5].map((k) => w.getBlock(ox + 4, oy + 6 - k, oz + 9));
  const twist = [1, 2, 3, 4, 5].map((k) => w.getBlock(ox + 11, oy + k, oz + 9));
  // bone meal on the 1-long weeping vine at ox+0 grows it
  const len = () => { let n = 0; while (w.getBlock(ox, oy + 5 - n, oz + 9) === B.WEEPING_VINES) n++; return n; };
  const l0 = len();
  const grew = g.applyBoneMeal(ox, oy + 5, oz + 9);
  return { before, after, twist, l0, l1: len(), grew, W: B.WEEPING_VINES, T: B.TWISTING_VINES };
}, s);
check('weeping vine chain before break', chain.before.slice(0, 5).every((id) => id === chain.W), JSON.stringify(chain.before));
check('weeping vine unravels when its anchor breaks', chain.after.every((id) => id === 0), JSON.stringify(chain.after));
check('twisting vine above a cut falls, below stays', chain.twist[0] === chain.T && chain.twist.slice(1).every((id) => id === 0), JSON.stringify(chain.twist));
check('bone meal grows a vine', chain.grew && chain.l1 > chain.l0, `${chain.l0} -> ${chain.l1}`);

// --- 5. generated vines in the forests ----------------------------------------------------------
await page.evaluate(() => window.__game.teleportPlayerDimension());
await page.waitForFunction(() => window.__game.world.dimension === 'nether', null, { timeout: 120000 });
await page.waitForTimeout(1500);
for (const [biome, name] of [['crimson', 'WEEPING_VINES'], ['warped', 'TWISTING_VINES']]) {
  const spot = await page.evaluate(({ biome }) => {
    const gen = window.__game.world.generator;
    for (let r = 0; r < 2400; r += 24) {
      const steps = Math.max(1, Math.round((2 * Math.PI * r) / 24));
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const x = Math.round(Math.cos(a) * r), z = Math.round(Math.sin(a) * r);
        if (gen.netherBiomeAt(x, z) !== biome) continue;
        if ([[20, 0], [-20, 0], [0, 20], [0, -20]].some(([dx, dz]) => gen.netherBiomeAt(x + dx, z + dz) !== biome)) continue;
        const fy = gen.nether.floorAt(x, z);
        if (fy < 0) continue;
        return { x, z, fy };
      }
    }
    return null;
  }, { biome });
  if (!spot) { check(`found ${biome}`, false); continue; }
  await frame(spot.x, spot.fy + 4, spot.z, spot.x + 8, spot.fy + 14, spot.z + 8, 2);
  // the longest vine near the spot, framed from the side
  const v = await page.evaluate(({ x, z, name }) => {
    const w = window.__game.world, B = window.__B, id = B[name];
    let best = null, count = 0;
    for (let dx = -24; dx <= 24; dx++) for (let dz = -24; dz <= 24; dz++) {
      let run = 0;
      for (let y = 20; y < 140; y++) {
        if (w.getBlock(x + dx, y, z + dz) === id) { count++; run++; if (!best || run > best.len) best = { x: x + dx, y, z: z + dz, len: run }; } else run = 0;
      }
    }
    return { best, count, roots: 0 };
  }, { x: spot.x, z: spot.z, name });
  check(`${biome} forest grows real ${name.toLowerCase()}`, v.count > 0, `${v.count} cells, longest ${v.best?.len}`);
  if (v.best) {
    const cy = name === 'WEEPING_VINES' ? v.best.y - v.best.len / 2 : v.best.y - v.best.len / 2;
    // find a clear camera spot 5-7 blocks away
    const eye = await page.evaluate(({ b, cy }) => {
      const w = window.__game.world;
      for (const d of [6, 5, 4, 7, 3]) for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const ex = b.x + 0.5 + Math.cos(a) * d, ez = b.z + 0.5 + Math.sin(a) * d;
        let clear = true;
        for (let t = 0.15; t <= 1; t += 0.05) {
          const px = Math.floor(ex + (b.x + 0.5 - ex) * t), pz = Math.floor(ez + (b.z + 0.5 - ez) * t);
          const id = w.getBlock(px, Math.floor(cy + 0.5), pz);
          if (id !== 0 && t < 0.8) { clear = false; break; }
        }
        if (clear && w.getBlock(Math.floor(ex), Math.floor(cy), Math.floor(ez)) === 0) return [ex, cy + 0.5, ez];
      }
      return [b.x + 5, cy + 1, b.z + 5];
    }, { b: v.best, cy });
    await frame(v.best.x + 0.5, cy, v.best.z + 0.5, eye[0], eye[1], eye[2], 1);
    await page.screenshot({ path: `${DIR}/wood-gen-${biome}.png` });
  }
}

// --- 6. an old-format save (u8 RLE) loads and migrates --------------------------------------
await page.evaluate(() => window.__game.teleportPlayerDimension());
await page.waitForFunction(() => window.__game.world.dimension === 'overworld', null, { timeout: 120000 });
await page.waitForTimeout(3000);
const legacy = await page.evaluate(async ({ ox, oz }) => {
  const g = window.__game, B = window.__B, w = g.world;
  // well away from the platform (whose chunks hold ids > 255 and stay v2)
  const x = ox - 40, z = oz + 3, y = 121;
  w.ensureChunk(Math.floor(x / 16), Math.floor(z / 16));
  w.setBlock(x, y, z, B.GOLD_BLOCK); // marks the chunk modified so it is saved
  const slot = g.slot;
  await g.saveAndQuit();
  const P = await import('/src/engine/Persistence.ts');
  const db = new P.SaveDB();
  const st = await db.load(slot);
  const key = `${Math.floor(x / 16)},${Math.floor(z / 16)}`;
  const ix = (lx, ly, lz) => lx | (lz << 4) | (ly << 8);
  const lx = ((x % 16) + 16) % 16, lz = ((z % 16) + 16) % 16;
  let maxId = 0, kept = 0;
  for (const k of Object.keys(st.world)) {
    const d = P.rleDecode(st.world[k], 40960);
    let m = 0;
    for (const v of d) if (v > m) m = v;
    // a chunk with ids past 255 can't be written the old way: it stays v2, so
    // this save mixes both formats (detection is per chunk)
    if (m > 255) { kept++; continue; }
    if (m > maxId) maxId = m;
    if (k === key) {
      // legacy shapes: roots hanging under netherrack (old weeping vines),
      // stacked warped roots (old twisting vines) and a plain floor tuft
      const lx1 = (lx + 1) & 15;
      d[ix(lx1, y, lz)] = B.NETHERRACK; d[ix(lx1, y - 1, lz)] = B.CRIMSON_ROOTS; d[ix(lx1, y - 2, lz)] = B.CRIMSON_ROOTS;
      d[ix(lx, y - 4, lz)] = B.WARPED_NYLIUM; d[ix(lx, y - 3, lz)] = B.WARPED_ROOTS; d[ix(lx, y - 2, lz)] = B.WARPED_ROOTS;
      const lz1 = (lz + 1) & 15;
      d[ix(lx, y - 4, lz1)] = B.CRIMSON_NYLIUM; d[ix(lx, y - 3, lz1)] = B.CRIMSON_ROOTS;
    }
    st.world[k] = P.rleEncodeLegacy(d);
  }
  const legacyOk = P.rleIsLegacy(st.world[key]);
  await db.save(slot, st);
  return { slot, key, x, y, z, lx, lz, maxId, kept, legacyOk, hasKey: key in st.world, savedDim: st.dimension ?? "overworld" };
}, s);
check('legacy save written', legacy.hasKey && legacy.legacyOk && legacy.maxId < 256 && legacy.savedDim === 'overworld', JSON.stringify(legacy));
await page.waitForTimeout(1500);
// #loading is still hidden from the last session: wait for the new Game instead
await page.evaluate(() => { window.__game.__stale = true; });
await page.locator('.world-row button', { hasText: 'Play' }).first().click();
await page.waitForFunction(() => window.__game && !window.__game.__stale, null, { timeout: 180000 });
await page.waitForSelector('#loading.hidden', { timeout: 180000, state: 'attached' });
await page.waitForTimeout(3000);
const loaded = await page.evaluate(async ({ x, y, z, lx, lz, ox, oy, oz }) => {
  const g = window.__game, B = window.__B, w = g.world;
  const x1 = x - lx + ((lx + 1) & 15), z1 = z - lz + ((lz + 1) & 15);
  const gb = (X, Y, Z) => { w.ensureChunk(Math.floor(X / 16), Math.floor(Z / 16)); return w.getBlock(X, Y, Z); };
  const r = {
    gold: gb(x, y, z) === B.GOLD_BLOCK,
    weeping: [gb(x1, y - 1, z), gb(x1, y - 2, z)].every((id) => id === B.WEEPING_VINES),
    twisting: [gb(x, y - 3, z), gb(x, y - 2, z)].every((id) => id === B.TWISTING_VINES),
    floorRoots: gb(x, y - 3, z1) === B.CRIMSON_ROOTS,
    platform: gb(ox + 1, oy, oz) === B.CRIMSON_PLANKS && gb(ox + 3, oy, oz + 3) === B.CRIMSON_STAIRS,
    dim: w.dimension, stale: !!g.__stale, slot: g.slot,
  };
  await g.saveGame();
  const P = await import('/src/engine/Persistence.ts');
  const st = await new P.SaveDB().load(g.slot);
  const key = `${Math.floor(x / 16)},${Math.floor(z / 16)}`;
  r.resavedV2 = !!st.world[key] && !P.rleIsLegacy(st.world[key]);
  return r;
}, { ...legacy, ox, oy, oz });
check('old save: blocks restored', loaded.gold, JSON.stringify(loaded));
check('old save: v2 chunks in the same save still load', loaded.platform);
check('old save: hanging roots became weeping vines', loaded.weeping);
check('old save: stacked warped roots became twisting vines', loaded.twisting);
check('old save: floor roots kept', loaded.floorRoots);
check('old save: re-saved in the v2 format', loaded.resavedV2);

console.log('--- console errors ---');
console.log(errors.length ? errors.slice(0, 8).join('\n') : 'NONE');
await browser.close();
await server.close();
process.exit(errors.length || failures.length ? 1 : 0);
