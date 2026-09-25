// Water visual check: builds a floating lake (sloped seabed, sand shore, a
// cliff waterfall) and captures noon / sunset / waterfall / shore / underwater
// views, then drives the player into the lake from a height to exercise the
// splash + exit wiring. Screenshots go to $SHOT_DIR (default: cwd).
// Usage: node water-visual-test.mjs [port]
import { chromium } from 'playwright';
import { createServer } from 'vite';
import path from 'node:path';

const PORT = +(process.argv[2] ?? 5402);
const OUT = process.env.SHOT_DIR ?? process.cwd();
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

await page.goto(`http://localhost:${PORT}/#debugmobs`, { timeout: 180000 });
await page.locator('.mode-pick button', { hasText: 'Creative' }).click();
await page.locator('.create-btn').click();
await page.waitForSelector('#loading.hidden', { timeout: 90000, state: 'attached' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 30000 });
await page.waitForTimeout(1500);

// arena origin + water level, returned for camera placement
const A = await page.evaluate(() => {
  const g = window.__game, B = window.__B, w = g.world;
  // high above any terrain (world height is 160) so framing is seed-independent
  // (centred over spawn, where chunks are guaranteed loaded)
  const ox = Math.floor(g.player.pos.x) - 11, oz = Math.floor(g.player.pos.z) - 12, Y0 = 132;
  const yW = Y0 + 6;
  for (let x = -8; x < 30; x++) for (let z = -4; z < 30; z++) for (let y = Y0 - 1; y < 160; y++) w.setBlock(ox + x, y, oz + z, B.AIR);
  for (let x = 0; x < 26; x++) {
    for (let z = 0; z < 26; z++) {
      w.setBlock(ox + x, Y0, oz + z, B.STONE);
      const d = Math.hypot(x - 11.5, z - 12.5);
      // lake bowl: 5 deep in the middle, a 1-deep sandy shelf at the rim
      let depth = d < 3 ? 5 : d < 5 ? 4 : d < 6.5 ? 3 : d < 8 ? 2 : d < 9.5 ? 1 : 0;
      if (x >= 21) depth = 0;
      const top = yW - depth; // highest solid y
      for (let y = Y0 + 1; y <= top; y++) {
        const surf = y === top;
        w.setBlock(ox + x, y, oz + z, surf ? (depth <= 1 && d < 11 ? B.SAND : depth === 0 ? B.GRASS : B.SAND) : (y > top - 3 ? B.DIRT : B.STONE));
      }
      for (let y = top + 1; y <= yW; y++) { w.waterLevels.delete(`${ox + x},${y},${oz + z}`); w.setBlock(ox + x, y, oz + z, B.WATER); }
    }
  }
  // cliff on the east side with a channel feeding a waterfall into the lake
  for (let x = 21; x < 26; x++) for (let z = 0; z < 26; z++) for (let y = yW + 1; y <= yW + 5; y++) w.setBlock(ox + x, y, oz + z, B.STONE);
  for (let x = 21; x < 26; x++) { w.setBlock(ox + x, yW + 6, oz + 11, B.STONE); w.setBlock(ox + x, yW + 6, oz + 13, B.STONE); }
  w.setBlock(ox + 26, yW + 6, oz + 12, B.STONE); // cap the channel's far end
  // the lake reaches the cliff foot under the fall
  for (let z = 11; z <= 13; z++) for (let x = 17; x <= 20; x++) {
    w.setBlock(ox + x, yW, oz + z, B.WATER); w.waterLevels.delete(`${ox + x},${yW},${oz + z}`);
  }
  for (const x of [23, 24, 25]) { w.waterLevels.delete(`${ox + x},${yW + 6},${oz + 12}`); w.setBlock(ox + x, yW + 6, oz + 12, B.WATER); w.scheduleWater(ox + x, yW + 6, oz + 12); }
  for (let i = 0; i < 200; i++) w.tickWater();
  g.processMeshing(4000);
  g.player.flying = true;
  g.player.inventory.selected = 8;
  return { ox, oz, yW, probe: [w.getBlock(ox + 11, yW, oz + 12), w.getBlock(ox + 2, yW, oz + 2), w.getBlock(ox + 22, yW + 3, oz + 12), w.getBlock(ox + 20, yW + 3, oz + 12)] };
});
console.log('arena', JSON.stringify(A));
await page.waitForTimeout(3000);
console.log('after', await page.evaluate((A) => {
  const w = window.__game.world, B = window.__B;
  let water = 0, sand = 0, air = 0;
  for (let x = 0; x < 21; x++) for (let z = 0; z < 26; z++) {
    const id = w.getBlock(A.ox + x, A.yW, A.oz + z);
    if (id === B.WATER) water++; else if (id === B.AIR) air++; else sand++;
  }
  const ys = {};
  for (const k of w.waterLevels.keys()) { const y = k.split(',')[1]; ys[y] = (ys[y] ?? 0) + 1; }
  return { water, sand, air, lv: w.waterLevels.size, ys, c: w.getBlock(A.ox + 11, A.yW, A.oz + 12) };
}, A));

async function shot(name, { x, y, z, yaw, pitch, day }) {
  await page.evaluate(({ A, x, y, z, yaw, pitch, day }) => {
    const g = window.__game;
    g.dayTime = day;
    g.player.flying = true;
    g.player.pos = { x: A.ox + x, y: A.yW + y, z: A.oz + z };
    g.player.vel = { x: 0, y: 0, z: 0 };
    g.player.yaw = yaw; g.player.pitch = pitch;
  }, { A, x, y, z, yaw, pitch, day });
  await page.waitForTimeout(1600);
  await page.screenshot({ path: path.join(OUT, `water-${name}.png`) });
  console.log('shot', name);
}

const E = -Math.PI / 2, W = Math.PI / 2, N = 0, S = Math.PI;
await shot('top', { x: 12, y: 18, z: 12.5, yaw: E, pitch: -1.55, day: 0.2 });
await shot('noon', { x: -3, y: 5, z: 12.5, yaw: E, pitch: -0.32, day: 0.25 });
await shot('noon-down', { x: 8, y: 4, z: 3, yaw: S + 0.5, pitch: -0.75, day: 0.23 });
await shot('sunset', { x: 23.5, y: 1.6, z: 18.5, yaw: W + 0.25, pitch: -0.12, day: 0.47 });
await shot('waterfall', { x: 13, y: 1.6, z: 12.5, yaw: E, pitch: 0.1, day: 0.3 });
await shot('shore', { x: 11.5, y: 1.5, z: 22.5, yaw: N + 0.3, pitch: -0.55, day: 0.28 });
await shot('underwater', { x: 9, y: -3.2, z: 12.5, yaw: E, pitch: 0.25, day: 0.27 });
await shot('night', { x: -3, y: 5, z: 12.5, yaw: E, pitch: -0.3, day: 0.8 });

// drop into the lake from height (splash) then climb out
await page.evaluate((A) => {
  const g = window.__game;
  g.dayTime = 0.26;
  g.player.flying = false;
  g.player.pos = { x: A.ox + 11.5, y: A.yW + 12, z: A.oz + 12.5 };
  g.player.vel = { x: 0, y: 0, z: 0 };
  g.player.yaw = -Math.PI / 2; g.player.pitch = -0.6;
}, A);
await page.waitForTimeout(1150);
await page.screenshot({ path: path.join(OUT, 'water-splash.png') });
console.log('shot splash');
await page.waitForTimeout(1500);

console.log('--- console errors ---');
console.log(errors.length ? errors.slice(0, 12).join('\n') : 'NONE');
await browser.close();
await server.close();
process.exit(errors.length ? 1 : 0);
