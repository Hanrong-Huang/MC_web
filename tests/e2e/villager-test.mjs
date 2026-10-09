// Logic validation: a queued village spawn spot near the player produces a
// villager, and the spot persists (repopulates) rather than being consumed.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { port: 5223 } });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

await page.goto('http://localhost:5223/#debugmobs');
await page.waitForTimeout(1000);
await page.locator('.mode-pick button', { hasText: 'Creative' }).click();
await page.locator('.create-btn').click();
await page.waitForSelector('#loading.hidden', { timeout: 60000, state: 'attached' });
await page.waitForTimeout(2000);

// queue a village dwelling spot a few blocks from the player, on solid ground
await page.evaluate(() => {
  const g = window.__game;
  const w = g.world;
  const px = Math.round(g.player.pos.x), pz = Math.round(g.player.pos.z);
  const x = px + 3, z = pz + 3;
  // make sure there's solid ground under the spot
  const gy = w.surfaceY ? w.surfaceY(x, z) : Math.round(g.player.pos.y);
  let y = Math.round(g.player.pos.y);
  for (let yy = y + 4; yy > y - 6; yy--) {
    if (w.isSolidAt(x, yy, z)) { y = yy + 1; break; }
  }
  w.setBlock(x, y - 1, z, window.__B.STONE);
  w.generator.villageSpawns.length = 0;
  w.generator.villageSpawns.push({ x: x + 0.5, y, z: z + 0.5 });
});

// villager spawns run once per second; wait a few ticks
await page.waitForTimeout(3500);

const r = await page.evaluate(() => {
  const g = window.__game;
  let villagers = 0;
  for (const e of g.entities.entities) if (e.kind === 'villager') villagers++;
  return {
    villagers,
    spotsRemaining: g.world.generator.villageSpawns.length, // should persist (not consumed)
  };
});

console.log(JSON.stringify(r, null, 2));
// villager must spawn, and spots must persist (not be consumed on spawn)
const ok = r.villagers >= 1 && r.spotsRemaining >= 1;
console.log('PASS:', ok);
console.log('--- console errors ---');
console.log(errors.length ? errors.slice(0, 12).join('\n') : 'NONE');
await browser.close();
await server.close();
process.exit(ok && errors.length === 0 ? 0 : 1);
