// Nether atmosphere / items / portals pass: lights a 2x3 and a 4x4 obsidian
// frame, shows soul lights + the respawn anchor at night, travels through a
// portal (asserting 8:1 scaling, arrival inside the partner portal and that
// the way back links to the same portal), visits each Nether biome for a
// screenshot of its haze/particles, and checks the respawn anchor. Asserts,
// and fails on any console error. Env: PORT (default 5504), SHOT_DIR.
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdirSync } from 'fs';

const PORT = +(process.env.PORT ?? 5504);
const DIR = process.env.SHOT_DIR ?? '.';
mkdirSync(DIR, { recursive: true });
const server = await createServer({ root: process.cwd(), server: { port: PORT, watch: { ignored: ['**/.claude/**'] } } });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
const fails = [];
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails.push(msg); };

await page.goto(`http://localhost:${PORT}/#debugmobs`, { timeout: 180000 });
await page.waitForTimeout(1200);
await page.locator('.mode-pick button', { hasText: 'Creative' }).click();
await page.locator('.create-btn').click();
await page.waitForSelector('#loading.hidden', { timeout: 90000, state: 'attached' });
await page.waitForTimeout(1500);

/** wait until the chunks around the player are generated and meshed */
async function settle(maxMs = 150000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const n = await page.evaluate(() => {
      const g = window.__game, p = g.player.pos;
      let pending = 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const cx = Math.floor(p.x / 16) + dx, cz = Math.floor(p.z / 16) + dz, k = `${cx},${cz}`;
        const c = g.world.getChunk(cx, cz);
        if (!c || !c.ready || g.world.dirtySet.has(k) || g.meshInFlight.has(k)) pending++;
      }
      return pending;
    });
    if (n === 0) return;
    await page.waitForTimeout(300);
  }
  console.log('  (mesh wait timed out)');
}
const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: `${DIR}/${name}.png` }); };

// --- overworld arena: portals of two sizes, soul lights, anchor ------------
const arena = await page.evaluate(() => {
  const g = window.__game, B = window.__B, w = g.world;
  const Y = 108, ox = Math.round(g.player.pos.x), oz = Math.round(g.player.pos.z);
  for (let x = ox - 8; x <= ox + 12; x++) for (let z = oz - 10; z <= oz + 6; z++) {
    for (let y = Y; y <= Y + 8; y++) w.setBlock(x, y, z, B.AIR);
    w.setBlock(x, Y - 1, z, B.STONE);
  }
  const frame = (x0, z0, wd, ht) => {
    for (let a = -1; a <= wd; a++) for (let h = -1; h <= ht; h++) {
      const edge = a === -1 || a === wd || h === -1 || h === ht;
      if (edge) w.setBlock(x0 + a, Y + h, z0, B.OBSIDIAN);
    }
  };
  frame(ox - 4, oz - 6, 2, 3);
  frame(ox + 1, oz - 6, 4, 4);
  const lit1 = g.nether.tryLight(ox - 4, Y + 1, oz - 6);
  const lit2 = g.nether.tryLight(ox + 3, Y + 2, oz - 6);
  const open = g.nether.tryLight(ox + 9, Y + 1, oz - 6); // no frame there
  // soul lights, anchor (charged 3) and a netherite block on the floor
  w.setBlock(ox - 5, Y, oz - 2, B.SOUL_TORCH);
  w.setBlock(ox - 3, Y, oz - 2, B.SOUL_LANTERN);
  w.setBlock(ox - 1, Y, oz - 2, B.RESPAWN_ANCHOR); w.bedFacings.set(`${ox - 1},${Y},${oz - 2}`, 3);
  w.setBlock(ox + 1, Y, oz - 2, B.NETHERITE_BLOCK);
  w.setBlock(ox + 3, Y, oz - 2, B.TORCH);
  const p = g.player;
  p.flying = true;
  p.pos = { x: ox + 0.5, y: Y + 1.2, z: oz + 3.5 };
  p.yaw = 0; p.pitch = -0.12;
  g.dayTime = 0.25;
  return { ox, oz, Y, lit1, lit2, open };
});
check(arena.lit1 && arena.lit2, 'obsidian frames 2x3 and 4x4 light into portals');
check(!arena.open, 'no portal without a frame');
await settle();
await page.waitForTimeout(1200);
await shot('d-01-portals-day');
await page.evaluate(() => { window.__game.dayTime = 0.75; });
await page.waitForTimeout(600);
await shot('d-02-soul-lights-night');
const cells = await page.evaluate(() => window.__game.nether.debug().portalCells);
check(cells === 6 + 16, `portal sheets rendered (${cells} cells)`);

// breaking the frame collapses the big portal
const collapsed = await page.evaluate(({ ox, oz, Y }) => {
  const g = window.__game, B = window.__B;
  g.world.setBlock(ox + 1 + 4, Y + 1, oz - 6, B.AIR); // a side of the 4x4 frame
  let n = 0;
  for (let a = 0; a < 4; a++) for (let h = 0; h < 4; h++) if (g.world.getBlock(ox + 1 + a, Y + h, oz - 6) === B.PORTAL) n++;
  return n;
}, arena);
check(collapsed === 0, 'broken frame collapses its portal');

// --- travel: stand in the small portal ---------------------------------------
await page.evaluate(({ ox, oz, Y }) => {
  const g = window.__game, p = g.player;
  p.flying = false;
  p.pos = { x: ox - 4 + 1, y: Y, z: oz - 6 + 0.5 };
  p.vel = { x: 0, y: 0, z: 0 };
  p.portalCooldown = 0; p.portalTimer = 0; p.portalExitPending = false;
}, arena);
await page.waitForTimeout(350);
await shot('d-03-portal-swirl');
let dim = 'overworld';
for (let i = 0; i < 30 && dim === 'overworld'; i++) {
  await page.waitForTimeout(250);
  dim = await page.evaluate(() => window.__game.world.dimension);
}
check(dim === 'nether', 'standing in a portal takes you to the Nether');
const land = await page.evaluate(() => {
  const g = window.__game, p = g.player.pos, B = window.__B;
  const inPortal = g.world.getBlock(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) === B.PORTAL;
  return { x: p.x, y: p.y, z: p.z, inPortal };
});
check(Math.abs(land.x - arena.ox / 8) < 36 && Math.abs(land.z - arena.oz / 8) < 36, `landed near 1/8 coords (${land.x.toFixed(1)}, ${land.z.toFixed(1)})`);
check(land.inPortal, 'arrived standing in the partner portal');
check(land.y > 32, `not in the lava sea (y=${land.y.toFixed(1)})`);
await settle();
await page.waitForTimeout(1500);
await shot('d-04-nether-arrival');
// the arrival portal stays inert while you stand in it (no bounce-back)
check(await page.evaluate(() => window.__game.world.dimension) === 'nether', 'no bounce-back while still standing in the arrival portal');
// step out of the sheet and look back at it
const inside = await page.evaluate(() => {
  const g = window.__game, p = g.player, at = { ...p.pos };
  const d = { x: -Math.sin(p.yaw), z: -Math.cos(p.yaw) };
  p.flying = true; p.vel = { x: 0, y: 0, z: 0 };
  p.pos = { x: p.pos.x + d.x * 3.2, y: p.pos.y + 0.2, z: p.pos.z + d.z * 3.2 };
  p.yaw += Math.PI; p.pitch = -0.05;
  return at;
});
await page.waitForTimeout(2500);
await shot('d-04b-nether-portal-outside');
// walk back in: the way home links to the portal we came from
await page.evaluate((at) => { const p = window.__game.player; p.flying = false; p.vel = { x: 0, y: 0, z: 0 }; p.pos = { ...at }; }, inside);
let back = null;
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(250);
  back = await page.evaluate(() => ({ dim: window.__game.world.dimension, p: { ...window.__game.player.pos } }));
  if (back.dim === 'overworld') break;
}
check(back.dim === 'overworld', 'travelled back to the Overworld');
check(Math.hypot(back.p.x - (arena.ox - 3.5), back.p.z - (arena.oz - 5.5)) < 4,
  `linked back to the original portal (${back.p.x.toFixed(1)}, ${back.p.z.toFixed(1)})`);

// --- Nether biomes ------------------------------------------------------------
await page.waitForTimeout(1500); // arrival cooldown
await page.evaluate(() => {
  const p = window.__game.player;
  p.portalExitPending = false; p.portalCooldown = 0; p.portalTimer = 5; // straight back through
});
for (let i = 0; i < 20; i++) { await page.waitForTimeout(250); if (await page.evaluate(() => window.__game.world.dimension) === 'nether') break; }
check(await page.evaluate(() => window.__game.world.dimension) === 'nether', 'second trip lands in the Nether again');
const biomes = await page.evaluate(() => {
  const g = window.__game, gen = g.world.generator;
  const found = {};
  if (typeof gen.netherBiomeAt !== 'function') return found;
  const p = g.player.pos;
  for (let r = 0; r < 1200 && Object.keys(found).length < 5; r += 24) {
    for (let a = 0; a < 16; a++) {
      const x = Math.round(p.x + Math.cos(a * 0.39) * r), z = Math.round(p.z + Math.sin(a * 0.39) * r);
      const b = gen.netherBiomeAt(x, z);
      if (!found[b]) {
        // must sit deep inside the biome so the haze reads clearly
        let ok = true;
        for (const [dx, dz] of [[20, 0], [-20, 0], [0, 20], [0, -20]]) if (gen.netherBiomeAt(x + dx, z + dz) !== b) ok = false;
        if (ok) found[b] = { x, z };
      }
    }
  }
  return found;
});
console.log('biome sites:', JSON.stringify(biomes));
for (const [name, at] of Object.entries(biomes)) {
  await page.evaluate(({ at }) => {
    const g = window.__game, B = window.__B, w = g.world;
    const cx = Math.floor(at.x / 16), cz = Math.floor(at.z / 16);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) w.ensureChunk(cx + dx, cz + dz);
    // a standing spot: open air over solid ground, above the lava sea
    let y = 40;
    for (let yy = 40; yy < 110; yy++) {
      const f = w.getBlock(at.x, yy - 1, at.z);
      if (f !== B.AIR && f !== B.LAVA && w.getBlock(at.x, yy, at.z) === B.AIR && w.getBlock(at.x, yy + 1, at.z) === B.AIR && w.getBlock(at.x, yy + 2, at.z) === B.AIR) { y = yy; break; }
    }
    const p = g.player;
    p.flying = true; p.vel = { x: 0, y: 0, z: 0 };
    p.pos = { x: at.x + 0.5, y: y + 0.5, z: at.z + 0.5 };
    p.yaw = 0.6; p.pitch = -0.08;
    g.nether.atmo.snap(w, p.pos.x, p.pos.y + 1, p.pos.z);
  }, { at });
  await settle();
  await page.waitForTimeout(2500); // particles fill in
  const dbg = await page.evaluate(() => window.__game.nether.debug());
  console.log(`  ${name}: dominant=${dbg.biome} particles=${dbg.particles}`);
  check(dbg.biome === (name === 'soul_valley' ? 'soul' : name), `${name} reads as its own biome`);
  await shot(`d-05-biome-${name}`);
}

// --- respawn anchor ---------------------------------------------------------------
const items = await page.evaluate(() => {
  const g = window.__game, B = window.__B, w = g.world, p = g.player;
  const x = Math.floor(p.pos.x) + 2, y = Math.floor(p.pos.y), z = Math.floor(p.pos.z);
  w.setBlock(x, y - 1, z, B.STONE); w.setBlock(x, y, z, B.RESPAWN_ANCHOR);
  const charged = g.nether.useAnchor(x, y, z, B.GLOWSTONE, true);
  const meta = w.bedFacings.get(`${x},${y},${z}`);
  const set = g.nether.useAnchor(x, y, z, 0, true);
  const anchor = g.nether.debug().anchor;
  const spot = g.nether.respawnAtAnchor();
  const after = w.bedFacings.get(`${x},${y},${z}`);
  return { charged, meta, set, anchor, spot, after };
});
check(items.charged && items.meta === 1, 'glowstone charges the anchor');
check(items.set && !!items.anchor, 'using a charged anchor in the Nether sets the respawn point');
check(!!items.spot && items.after === 0, 'respawning at the anchor spends a charge');

// icon sheet of the new items
await page.evaluate(() => {
  const g = window.__game;
  const names = ['netherite_block', 'soul_torch', 'soul_lantern', 'respawn_anchor', 'netherite_scrap', 'netherite_ingot',
    'netherite_pickaxe', 'netherite_axe', 'netherite_shovel', 'netherite_sword', 'netherite_helmet', 'netherite_chestplate',
    'netherite_leggings', 'netherite_boots', 'fire_charge', 'blaze_powder', 'portal_compass'];
  const c = document.createElement('canvas');
  c.width = names.length * 72; c.height = 80;
  c.id = 'icon-sheet';
  Object.assign(c.style, { position: 'fixed', left: '0', top: '0', zIndex: 9999, background: '#3a3a44', imageRendering: 'pixelated' });
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  names.forEach((n, i) => { const id = window.__findId(n); if (id > 0) ctx.drawImage(g.atlas.icon(id), i * 72 + 4, 8, 64, 64); });
  document.body.appendChild(c);
});
await shot('d-06-icons');
await page.evaluate(() => document.getElementById('icon-sheet')?.remove());

console.log('--- console errors ---');
console.log(errors.length ? errors.slice(0, 8).join('\n') : 'NONE');
await browser.close();
await server.close();
process.exit(errors.length || fails.length ? 1 : 0);
