// Nether biomes + blocks: a daylight showcase of every new Nether block on the
// y=108 stone platform (with roots, vines and soul fire in place), then a trip
// to the Nether to frame each of the five biomes (wastes, crimson forest,
// warped forest, soul sand valley, basalt deltas) and assert the F3 biome
// label and the biome's signature blocks. Screenshots go to $SHOT_DIR.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const PORT = +(process.env.PORT ?? 5241);
const DIR = process.env.SHOT_DIR ?? '.';
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
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

/** Park the camera at an eye position looking at a target, then wait for the
 *  chunks within `r` of the target to be generated and meshed. */
async function frame(tx, ty, tz, ex, ey, ez, r = 2) {
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

const tiles = await page.evaluate(() => window.__game.atlas.tiles.size);
check('atlas has room for every tile', tiles <= 8 * 32, `${tiles} tiles`);

// --- 1. block showcase in daylight ----------------------------------------------
if (!ONLY || ONLY.includes('showcase')) {
  const s = await page.evaluate(() => {
    const g = window.__game, p = g.player, B = window.__B, w = g.world;
    const ox = Math.floor(p.pos.x), oy = 108, oz = Math.floor(p.pos.z);
    for (let dx = -3; dx <= 18; dx++) {
      for (let dz = -10; dz <= 10; dz++) {
        w.setBlock(ox + dx, oy - 1, oz + dz, B.STONE);
        for (let dy = 0; dy <= 9; dy++) w.setBlock(ox + dx, oy + dy, oz + dz, 0);
      }
    }
    for (const e of g.entities.entities) if (g.entities.isMob(e)) e.dead = true;
    const cubes = [B.CRIMSON_NYLIUM, B.WARPED_NYLIUM, B.CRIMSON_STEM, B.WARPED_STEM, B.NETHER_WART_BLOCK,
      B.WARPED_WART_BLOCK, B.SHROOMLIGHT, B.BASALT, B.BLACKSTONE, B.SOUL_SOIL, B.NETHER_GOLD_ORE, B.ANCIENT_DEBRIS,
      B.NETHERRACK, B.SOUL_SAND];
    cubes.forEach((id, i) => w.setBlock(ox + i, oy, oz, id));
    // plant row: roots on nylium, soul fire on soul soil/sand, a twisting vine
    // column and weeping vines hanging off a wart-block beam
    const put = (x, y, z, id) => w.setBlock(ox + x, oy + y, oz + z, id);
    for (let i = 0; i < 12; i++) put(i, 0, 4, [B.CRIMSON_NYLIUM, B.WARPED_NYLIUM, B.SOUL_SOIL, B.SOUL_SAND][i >> 2 & 3]);
    put(0, 1, 4, B.CRIMSON_ROOTS); put(1, 1, 4, B.CRIMSON_ROOTS);
    put(4, 1, 4, B.WARPED_ROOTS); put(5, 1, 4, B.WARPED_ROOTS);
    for (let k = 1; k <= 4; k++) put(6, k, 4, B.TWISTING_VINES);
    put(8, 1, 4, B.FIRE); put(9, 1, 4, B.FIRE); put(10, 1, 4, B.FIRE); put(11, 1, 4, B.FIRE);
    for (let i = 0; i < 4; i++) {
      put(i, 5, 4, B.NETHER_WART_BLOCK);
      for (let k = 4; k >= 5 - (2 + i); k--) put(i, k, 4, B.WEEPING_VINES);
    }
    p.flying = true; p.vel = { x: 0, y: 0, z: 0 };
    g.dayTime = 0.12;
    return { ox, oy, oz };
  });
  await frame(s.ox + 6.5, s.oy + 0.5, s.oz + 0.5, s.ox + 6.5, s.oy + 3.2, s.oz - 8, 1);
  await page.screenshot({ path: `${DIR}/nether-blocks.png` });
  await frame(s.ox + 5.5, s.oy + 2, s.oz + 4.5, s.ox + 5.5, s.oy + 3.2, s.oz + 10, 1);
  await page.screenshot({ path: `${DIR}/nether-plants.png` });
}

// --- 2. the Nether biomes ------------------------------------------------------
await page.evaluate(() => window.__game.teleportPlayerDimension());
await page.waitForTimeout(3000);
check('in the nether', await page.evaluate(() => window.__game.world.dimension === 'nether'));

const LABEL = { wastes: 'nether_wastes', crimson: 'crimson_forest', warped: 'warped_forest', soul_valley: 'soul_sand_valley', basalt: 'basalt_deltas' };
const SIGNATURE = { wastes: ['NETHERRACK'], crimson: ['CRIMSON_NYLIUM', 'CRIMSON_STEM', 'NETHER_WART_BLOCK', 'WEEPING_VINES'], warped: ['WARPED_NYLIUM', 'WARPED_STEM', 'WARPED_WART_BLOCK', 'TWISTING_VINES'], soul_valley: ['SOUL_SOIL', 'SOUL_SAND'], basalt: ['BASALT', 'BLACKSTONE'] };
for (const biome of Object.keys(LABEL)) {
  if (ONLY && !ONLY.includes(biome)) continue;
  // find a spot well inside the biome (same biome 24 blocks around), with a floor
  const spot = await page.evaluate(({ biome }) => {
    const gen = window.__game.world.generator;
    const at = (x, z) => gen.netherBiomeAt(x, z);
    for (let r = 0; r < 2400; r += 24) {
      const steps = Math.max(1, Math.round((2 * Math.PI * r) / 24));
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const x = Math.round(Math.cos(a) * r), z = Math.round(Math.sin(a) * r);
        if (at(x, z) !== biome) continue;
        if ([[24, 0], [-24, 0], [0, 24], [0, -24], [0, 34]].some(([dx, dz]) => at(x + dx, z + dz) !== biome)) continue;
        const fy = gen.nether.floorAt(x, z);
        if (fy < 0) continue;
        return { x, z, fy };
      }
    }
    return null;
  }, { biome });
  if (!spot) { check(`found ${biome}`, false); continue; }
  const { x, z, fy } = spot;
  // camera spots with a clear line of sight to the target (raw terrain density)
  const views = await page.evaluate(({ x, z, fy }) => {
    const n = window.__game.world.generator.nether;
    const clear = (ax, ay, az, bx, by, bz) => {
      for (let t = 0; t <= 1; t += 0.05) {
        if (n.densityAt(Math.floor(ax + (bx - ax) * t), Math.floor(ay + (by - ay) * t), Math.floor(az + (bz - az) * t)) > 0) return false;
      }
      return true;
    };
    const pick = (tx, ty, tz, dist, lift) => {
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        for (const d of [dist, dist * 0.7, dist * 0.45]) {
          for (const up of [lift, lift * 0.6, lift * 1.5]) {
            const ex = tx + Math.cos(a) * d, ey = ty + up, ez = tz + Math.sin(a) * d;
            if (clear(ex, ey, ez, tx, ty, tz) && clear(ex, ey + 1, ez, ex, ey + 1, ez)) return [tx, ty, tz, ex, ey, ez];
          }
        }
      }
      return [tx, ty, tz, tx + 3, ty + 8, tz + 16];
    };
    return [pick(x, fy + 3, z, 22, 9), pick(x, fy + 8, z, 34, 2)];
  }, { x, z, fy });
  await frame(...views[0], 2);
  await page.screenshot({ path: `${DIR}/nether-${biome}.png` });
  // a second, level view across the cavern
  await frame(...views[1], 2);
  await page.screenshot({ path: `${DIR}/nether-${biome}-wide.png` });
  const info = await page.evaluate(({ x, z, sig }) => {
    const g = window.__game, B = window.__B, w = g.world;
    const found = {};
    for (const name of sig) found[name] = 0;
    for (let dx = -20; dx <= 20; dx++) for (let dz = -20; dz <= 20; dz++) {
      for (let y = 20; y < 140; y++) {
        const id = w.getBlock(x + dx, y, z + dz);
        for (const name of sig) if (id === B[name]) found[name]++;
      }
    }
    const dbg = document.querySelector('#debug')?.textContent ?? '';
    return { label: w.generator.biomeLabel(x, z), found, dbg };
  }, { x, z, sig: SIGNATURE[biome] });
  check(`${biome} F3 label`, info.label === LABEL[biome], info.label);
  check(`${biome} signature blocks`, Object.values(info.found).every((n) => n > 0), JSON.stringify(info.found));
}

console.log('--- console errors ---');
console.log(errors.length ? errors.slice(0, 8).join('\n') : 'NONE');
await browser.close();
await server.close();
process.exit(errors.length || failures.length ? 1 : 0);
