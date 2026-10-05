// Fluid showcase + checks: builds a stone stage at y=108 with a water ledge
// pouring into a pool, a lava ledge pouring onto the floor, a lava/water
// meeting point (obsidian/cobble), and a roof with fluid on top (drips), lets
// the fluids settle, then screenshots day and night views.
// Usage: node fluid-shots.mjs   (PORT, SHOT_DIR env; NO_SHOTS=1 for asserts only)
import { chromium } from 'playwright';
import { createServer } from 'vite';
import path from 'node:path';

const PORT = +(process.env.PORT ?? 5231);
const DIR = process.env.SHOT_DIR ?? process.cwd();
const SHOTS = !process.env.NO_SHOTS;
const server = await createServer({ root: process.cwd(), server: { port: PORT, strictPort: true, watch: { ignored: ['**/.claude/**'] } }, logLevel: 'warn' });
await server.listen();
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${ok || !detail ? '' : ' — ' + detail}`); if (!ok) fails++; };
const g = (fn, arg) => page.evaluate(fn, arg);
const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(DIR, `shot-fluid-${name}.png`) }); };

await page.goto(`http://localhost:${PORT}/#dev-nointro`, { timeout: 180000 });
await page.locator('.mode-pick button', { hasText: 'Creative' }).click();
await page.locator('.create-btn').click();
await page.waitForSelector('#loading.hidden', { timeout: 120000, state: 'attached' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 30000 });
await page.waitForTimeout(1500);

// --- stage: 32x32 stone floor at y=108 (2x2 chunks), air above
await g(() => {
  const gm = window.__game, B = window.__B, w = gm.world, p = gm.player;
  const ox = Math.floor(p.pos.x / 16) * 16 - 8, oz = Math.floor(p.pos.z / 16) * 16 - 8;
  window.__st = { ox, oz };
  const S = (x, y, z, id) => w.setBlock(ox + x, y, oz + z, id);
  for (let x = -2; x < 34; x++) for (let z = -2; z < 34; z++) {
    for (let y = 102; y <= 107; y++) S(x, y, z, B.STONE); // solid foundations (caves below would drain the pool)
    S(x, 108, z, B.GRASS);
    for (let y = 109; y <= 124; y++) S(x, y, z, B.AIR);
  }
  // pool in front of the water ledge
  for (let x = 3; x < 15; x++) for (let z = 11; z < 19; z++) { S(x, 108, z, B.AIR); S(x, 107, z, B.AIR); S(x, 106, z, B.SAND); }
  // water ledge (x 4..13, z 19..27, top y=113) with a source on top
  for (let x = 4; x < 14; x++) for (let z = 19; z < 28; z++) for (let y = 109; y <= 113; y++) S(x, y, z, B.STONE);
  // lava ledge (x 18..27, z 19..27, top y=113)
  for (let x = 18; x < 28; x++) for (let z = 19; z < 28; z++) for (let y = 109; y <= 113; y++) S(x, y, z, B.STONE);
  // flowers + a torch in the water's path (washed away), a log for lava to light
  S(8, 109, 9, B.POPPY); S(10, 109, 9, B.DANDELION); S(6, 109, 9, B.TORCH);
  // roof with fluid on top (drips) at the back-left
  for (let x = 26; x < 31; x++) for (let z = 4; z < 9; z++) { S(x, 112, z, B.STONE); S(x, 113, z, (x === 26 || x === 30 || z === 4 || z === 8) ? B.STONE : B.AIR); }
  for (let z = 4; z < 9; z++) for (let y = 109; y < 112; y++) { S(26, y, z, B.STONE); }
  p.mode = 'creative'; p.flying = true;
});
// let the chunks remesh before fluids go in
await page.waitForTimeout(1500);
await g(() => {
  const gm = window.__game, B = window.__B, w = gm.world, { ox, oz } = window.__st;
  const S = (x, y, z, id) => w.setBlock(ox + x, y, oz + z, id);
  const src = (fluid, x, y, z) => { (fluid === B.LAVA ? w.lavaLevels : w.waterLevels).delete(`${ox + x},${y},${oz + z}`); S(x, y, z, fluid); };
  // a flower and a torch in the water's path on the ledge top
  S(8, 114, 20, B.POPPY); S(9, 114, 20, B.TORCH);
  // sources near the front edges: vanilla fluid heads for the nearest drop
  src(B.WATER, 7, 114, 21); src(B.WATER, 8, 114, 21); src(B.WATER, 9, 114, 21);
  src(B.LAVA, 22, 114, 21);
  src(B.WATER, 28, 113, 6); src(B.LAVA, 29, 113, 7);
  // water spreading across the floor into a lava source
  src(B.LAVA, 22, 109, 10);
  src(B.WATER, 22, 109, 4);
});
// settle quickly (each call is one vanilla step)
await g(() => {
  const w = window.__game.world;
  for (let i = 0; i < 160; i++) { w.tickWater(); if (i % 2 === 0) w.tickLava(); }
});
await page.waitForTimeout(500);

// --- asserts on the settled scene
const r = await g(() => {
  const gm = window.__game, B = window.__B, w = gm.world, { ox, oz } = window.__st;
  const at = (x, y, z) => w.getBlock(ox + x, y, oz + z);
  let poolWater = 0;
  for (let x = 3; x < 15; x++) for (let z = 11; z < 19; z++) if (at(x, 107, z) === B.WATER) poolWater++;
  let fallCells = 0;
  for (let x = 3; x < 15; x++) for (let y = 109; y <= 113; y++) if (at(x, y, 18) === B.WATER) fallCells++;
  let lavaFloor = 0;
  for (let x = 16; x < 30; x++) for (let z = 12; z < 19; z++) if (at(x, 109, z) === B.LAVA) lavaFloor++;
  let rock = 0;
  for (let x = 16; x < 29; x++) for (let z = 2; z < 15; z++) { const id = at(x, 109, z); if (id === B.OBSIDIAN || id === B.COBBLE) rock++; }
  return {
    poolWater, fallCells, lavaFloor, rock,
    flowerGone: at(8, 114, 20) !== B.POPPY, torchGone: at(9, 114, 20) !== B.TORCH,
  };
});
check('water pours off its ledge as a waterfall', r.fallCells >= 5, JSON.stringify(r));
check('the waterfall fills the pool below', r.poolWater >= 20, `${r.poolWater}`);
check('lava pours off its ledge and spreads on the floor', r.lavaFloor >= 3, `${r.lavaFloor}`);
check('water meeting lava hardened it (obsidian / cobblestone)', r.rock >= 1, `${r.rock}`);
check('flowing water washed the flower and torch away', r.flowerGone && r.torchGone);

// --- current pushes the player: stand in the flowing sheet on the ledge top
const drift = await g(async () => {
  const gm = window.__game, w = gm.world, { ox, oz } = window.__st, p = gm.player;
  p.flying = false; p.mode = 'creative';
  p.pos = { x: ox + 8.5, y: 114.05, z: oz + 20.5 }; p.vel = { x: 0, y: 0, z: 0 };
  const z0 = p.pos.z;
  await new Promise((res) => setTimeout(res, 2500));
  return { dz: p.pos.z - z0, inWater: w.getBlock(Math.floor(p.pos.x), Math.floor(p.pos.y + 0.5), Math.floor(p.pos.z)) };
});
check('the current carries the player downstream (toward the edge)', drift.dz < -0.5, JSON.stringify(drift));

// --- screenshots
const view = async (name, x, y, z, yaw, pitch, dayTime) => {
  await g(([x, y, z, yaw, pitch, dayTime]) => {
    const gm = window.__game, { ox, oz } = window.__st, p = gm.player;
    p.flying = true; p.pos = { x: ox + x, y, z: oz + z }; p.vel = { x: 0, y: 0, z: 0 };
    p.yaw = yaw; p.pitch = pitch;
    gm.dayTime = dayTime;
  }, [x, y, z, yaw, pitch, dayTime]);
  await page.waitForTimeout(1800);
  await shot(name);
};
// yaw: 0 looks toward -z, PI toward +z
await view('overview', 16, 119, 0, Math.PI, -0.45, 0.2);
await view('waterfall', 8.5, 112, 8, Math.PI, -0.15, 0.2);
await view('lava', 22.5, 114, 12, Math.PI, -0.45, 0.2);
await view('lava-night', 22.5, 114, 12, Math.PI, -0.45, 0.62);
await view('drips', 24, 110.2, 6.5, -Math.PI / 2, 0.25, 0.62);
await view('meet', 22.5, 113, 1, Math.PI, -0.7, 0.2);

console.log('console errors:', errors.length ? errors.slice(0, 8).join('\n') : 'NONE');
console.log(fails || errors.length ? `${fails} FAILED` : 'ALL PASSED');
await browser.close();
await server.close();
process.exit(fails || errors.length ? 1 : 0);
