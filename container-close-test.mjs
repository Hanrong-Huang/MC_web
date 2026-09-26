// Regression: closing a chest / crafting table (✕ button or Esc) must not
// reopen it. The right-click that opened it (and right-clicks spent on slots)
// used to stay queued and replay into the world as soon as the screen closed.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const PORT = Number(process.env.PORT ?? 5227);
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

await page.goto(`http://localhost:${PORT}/#debugmobs`, { timeout: 120000 });
await page.waitForTimeout(1000);
await page.locator('.mode-pick button', { hasText: 'Survival' }).click();
await page.locator('.create-btn').click();
await page.waitForSelector('#loading.hidden', { timeout: 90000, state: 'attached' });
await page.waitForTimeout(3000);

// a stone room at y=108 with the chest and a crafting table straight ahead
await page.evaluate(() => {
  const g = window.__game, B = window.__B, w = g.world;
  const px = Math.floor(g.player.pos.x), pz = Math.floor(g.player.pos.z);
  for (let x = px - 4; x <= px + 4; x++) for (let z = pz - 4; z <= pz + 4; z++) {
    w.setBlock(x, 108, z, B.STONE);
    for (let y = 109; y <= 112; y++) w.setBlock(x, y, z, B.AIR);
  }
  w.setBlock(px, 110, pz - 2, B.CHEST);
  w.setBlock(px + 2, 110, pz, B.TABLE);
  g.player.pos = { x: px + 0.5, y: 109.01, z: pz + 0.5 };
  g.player.vel = { x: 0, y: 0, z: 0 };
  g.entities.entities = g.entities.entities.filter((e) => e.kind === 'drop');
  window.__px = px; window.__pz = pz;
});

const state = () => page.evaluate(() => window.__game.state);
const look = (yaw) => page.evaluate((yaw) => { const p = window.__game.player; p.yaw = yaw; p.pitch = 0; }, yaw);
const lock = async () => {
  await page.mouse.click(640, 360);
  await page.waitForTimeout(400);
  return page.evaluate(() => window.__game.input.pointerLocked);
};

const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); };

async function openWithRightClick() {
  await page.mouse.down({ button: 'right' });
  await page.waitForTimeout(250);
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(300);
  return state();
}

console.log('pointer locked:', await lock());

for (const [label, yaw] of [['chest', 0], ['table', -Math.PI / 2]]) {
  await look(yaw);
  await page.waitForTimeout(300);
  // 1) open, close with ✕
  check(`${label} opens`, (await openWithRightClick()) === 'container');
  await page.locator('.ctr-close').dispatchEvent('pointerdown');
  await page.waitForTimeout(1200);
  check(`${label} stays closed after ✕`, (await state()) !== 'container', await state());

  // 2) open, right-click a slot (split stacks), close with Esc
  await lock();
  check(`${label} reopens on a fresh click`, (await openWithRightClick()) === 'container');
  const slot = page.locator('.mc-slot').first();
  await slot.click({ button: 'right' });
  await slot.click({ button: 'right' });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1200);
  check(`${label} stays closed after Esc`, (await state()) !== 'container', await state());
  await lock();
}

console.log('--- console errors ---');
console.log(errors.length ? errors.join('\n') : 'NONE');
const ok = results.every(Boolean) && errors.length === 0;
console.log(ok ? 'ALL CHECKS PASS' : 'SOME CHECKS FAILED');
await browser.close();
await server.close();
process.exit(ok ? 0 : 1);
