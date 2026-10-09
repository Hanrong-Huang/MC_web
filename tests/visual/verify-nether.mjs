// Exercise the new emberghast: spawn it near the player, run a few seconds so
// its flight AI + a fireball volley execute, and assert no console errors.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { port: 5203 } });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

await page.goto('http://localhost:5203/#debugmobs');
await page.waitForTimeout(1200);
await page.locator('.create-btn').click();
await page.waitForSelector('#loading.hidden', { timeout: 60000, state: 'attached' });
await page.waitForTimeout(2500);

// spawn an emberghast a few blocks from the player and force it to attack
const spawned = await page.evaluate(() => {
  const g = window.__game;
  const p = g.player;
  const e = g.entities.spawnMob('emberghast', p.pos.x + 6, p.pos.y + 5, p.pos.z);
  // force an immediate fireball so the projectile path runs this session
  g.entities.spawnFireball(p.pos.x + 6, p.pos.y + 5, p.pos.z, -6, 0, 0);
  return !!e;
});
console.log('emberghast spawned:', spawned);

await page.waitForTimeout(4000);
const count = await page.evaluate(() =>
  window.__game.entities.entities.filter((e) => e.kind === 'emberghast').length);
console.log('emberghast alive after 4s:', count);

await page.screenshot({ path: 'verify-nether.png' });
console.log('--- console errors ---');
console.log(errors.length ? errors.slice(0, 8).join('\n') : 'NONE');

await browser.close();
await server.close();
process.exit(errors.length || !spawned ? 1 : 0);
