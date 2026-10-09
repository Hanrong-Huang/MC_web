// Sneak edge-guard: on a 1-block-wide stone walkway at y=108, walking toward
// the drop while holding Shift stops you at the edge; without it you walk
// off and fall. Also checks Shift no longer sprints and Ctrl is no longer a
// movement key (Ctrl+W closes the browser tab). Asserts only.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const PORT = +(process.env.PORT ?? 5271);
const server = await createServer({ root: process.cwd(), logLevel: 'error', server: { port: PORT } });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
await page.goto(`http://localhost:${PORT}/#debugmobs`, { timeout: 180000 });
await page.waitForLoadState('networkidle', { timeout: 180000 });
await page.waitForTimeout(3000);
await page.locator('.mode-pick button', { hasText: 'Survival' }).click({ timeout: 120000 });
await page.locator('.create-btn').click({ timeout: 120000, noWaitAfter: true });
await page.waitForSelector('#loading.hidden', { timeout: 180000, state: 'attached' });
await page.waitForTimeout(2500);
await page.mouse.click(480, 270);
await page.waitForTimeout(300);

const failures = [];
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${info}`); if (!ok) failures.push(name); };

// a walkway along +x with a sheer drop on both sides; face -z (off the side)
const base = await page.evaluate(() => {
  const g = window.__game, p = g.player, B = window.__B, w = g.world;
  const ox = Math.floor(p.pos.x), oy = 108, oz = Math.floor(p.pos.z);
  for (let dx = -3; dx <= 12; dx++) for (let dz = -4; dz <= 4; dz++) for (let dy = -12; dy <= 4; dy++) w.setBlock(ox + dx, oy + dy, oz + dz, 0);
  for (let dx = -3; dx <= 12; dx++) w.setBlock(ox + dx, oy - 1, oz, B.STONE);
  for (const e of g.entities.entities) if (g.entities.isMob(e)) e.dead = true;
  return { ox, oy, oz };
});

/** Stand mid-walkway, hold `keys` walking toward -z for `ms`, report the end state. */
async function walk(keys, ms, x) {
  await page.evaluate(({ base, x }) => {
    const g = window.__game, p = g.player;
    p.flying = false; p.sprinting = false; p.vel = { x: 0, y: 0, z: 0 };
    p.pos.x = base.ox + x + 0.5; p.pos.y = base.oy; p.pos.z = base.oz + 0.5;
    p.yaw = 0; p.pitch = 0; // yaw 0 looks toward -z
    p.fallDist = 0; p.health = 20;
    g.input.keys.clear();
  }, { base, x });
  await page.waitForTimeout(700); // settle on the walkway
  await page.evaluate((keys) => { for (const k of keys) window.__game.input.keys.add(k); }, keys);
  await page.waitForTimeout(ms);
  const r = await page.evaluate(() => {
    const p = window.__game.player;
    return { y: p.pos.y, z: p.pos.z, sprinting: p.sprinting, sneaking: p.sneaking };
  });
  await page.evaluate(() => window.__game.input.keys.clear());
  return r;
}

const shift = await walk(['ShiftLeft', 'KeyW'], 2500, 0);
check('shift sneaks', shift.sneaking, JSON.stringify(shift));
check('shift does not sprint', !shift.sprinting);
check('shift holds you on the edge', shift.y > base.oy - 0.05, `y=${shift.y.toFixed(2)}`);
check('you hang over the edge (vanilla overhang)', shift.z < base.oz + 0.2 && shift.z > base.oz - 0.35, `z-oz=${(shift.z - base.oz).toFixed(2)}`);

const ctrl = await walk(['ControlLeft'], 400, 4);
check('ctrl is not sneak', !ctrl.sneaking, JSON.stringify(ctrl));

const plain = await walk(['KeyW'], 2500, 8);
check('without sneak you walk off', plain.y < base.oy - 1, `y=${plain.y.toFixed(2)}`);

console.log(errors.length ? errors.slice(0, 12).join('\n') : 'no console errors');
await browser.close();
await server.close();
process.exit(failures.length || errors.length ? 1 : 0);
