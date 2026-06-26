// Visual + movement check for the emberghast: clean world (no #debugmobs bed),
// spawn it in front of the player, aim the camera at it, screenshot the shape,
// and sample its position over time to confirm the flight AI actually moves it.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { port: 5204 } });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

// #debugmobs exposes window.__game (and drops some mobs/a bed near spawn)
await page.goto('http://localhost:5204/#debugmobs');
await page.waitForTimeout(1200);
await page.locator('.create-btn').click();
await page.waitForSelector('#loading.hidden', { timeout: 60000, state: 'attached' });
await page.waitForTimeout(2500);

// lift the player high into open air (clear of the spawn bed/clutter), then
// spawn the ghast straight ahead (-Z, yaw 0) at eye level and aim at it
await page.evaluate(() => {
  const g = window.__game;
  const p = g.player;
  p.pos.y += 25; p.flying = true;
  p.yaw = 0; p.pitch = 0;
  window.__ghast = g.entities.spawnMob('emberghast', p.pos.x, p.pos.y + 1.4, p.pos.z - 7);
});
await page.waitForTimeout(800);
await page.screenshot({ path: 'ghast-shape.png' });

// sample position + the fireball count over 3 seconds to prove it moves & shoots
const samples = [];
for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(500);
  const s = await page.evaluate(() => {
    const g = window.__game;
    const e = g.entities.entities.find((x) => x.kind === 'emberghast');
    const fb = g.entities.entities.filter((x) => x.kind === 'arrow' && x.owner === 'emberghast').length;
    return e ? { x: +e.pos.x.toFixed(2), y: +e.pos.y.toFixed(2), z: +e.pos.z.toFixed(2), fb } : null;
  });
  samples.push(s);
}
await page.screenshot({ path: 'ghast-later.png' });

console.log('position samples (0.5s apart):');
for (const s of samples) console.log('  ', JSON.stringify(s));
// movement check: did x/y/z change between first and last sample?
const a = samples[0], b = samples[samples.length - 1];
const moved = a && b && (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z)) > 0.5;
console.log('moved over 3s:', moved);
console.log('--- console errors ---');
console.log(errors.length ? errors.slice(0, 8).join('\n') : 'NONE');

await browser.close();
await server.close();
process.exit(errors.length ? 1 : 0);
