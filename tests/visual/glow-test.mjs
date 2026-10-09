// Verify glowstone + lit redstone lamp emit block light into the world. Builds
// a dark scene in the Nether (no skylight) with the two emitters flanked by
// plain stone/netherrack so their glow falloff is visible.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { port: 5218 } });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

await page.goto('http://localhost:5218/#debugmobs');
await page.waitForTimeout(1000);
await page.locator('.mode-pick button', { hasText: 'Creative' }).click();
await page.locator('.create-btn').click();
await page.waitForSelector('#loading.hidden', { timeout: 60000, state: 'attached' });
await page.waitForTimeout(2000);
await page.mouse.click(640, 360);
await page.waitForTimeout(200);

// go to the (dark) Nether, then build a lit scene
await page.evaluate(() => { window.__game.teleportPlayerDimension(); });
await page.waitForTimeout(3500);

await page.evaluate(() => {
  const g = window.__game, B = window.__B, w = g.world;
  const px = Math.floor(g.player.pos.x), pz = Math.floor(g.player.pos.z);
  const Y = 70, x0 = px - 22, z0 = pz - 6;
  const W = 44, D = 12, H = 9;
  // hollow out a big dark room, fully enclosed (roof kills skylight so block
  // light dominates and falloff is visible)
  for (let x = x0 - 1; x <= x0 + W; x++)
    for (let y = Y - 1; y <= Y + H; y++)
      for (let z = z0 - 1; z <= z0 + D; z++) w.setBlock(x, y, z, B.AIR);
  for (let x = x0 - 1; x <= x0 + W; x++)
    for (let z = z0 - 1; z <= z0 + D; z++) { w.setBlock(x, Y - 1, z, B.STONE); w.setBlock(x, Y + H, z, B.STONE); }
  const wallZ = z0;
  for (let x = x0 - 1; x <= x0 + W; x++)
    for (let y = Y; y <= Y + H - 1; y++) { w.setBlock(x, y, wallZ, B.STONE); w.setBlock(x, y, z0 + D, B.STONE); }
  // emitters far apart on the back wall so their halos don't overlap
  w.setBlock(x0 + 10, Y + 3, wallZ, B.GLOWSTONE);
  w.setBlock(x0 + 34, Y + 3, wallZ, B.REDSTONE_LAMP_LIT);

  const p = g.player;
  p.pos.x = x0 + 22; p.pos.y = Y + 3; p.pos.z = wallZ + 11;
  p.vel.x = p.vel.y = p.vel.z = 0; p.yaw = 0; p.pitch = -0.02;
});
await page.waitForTimeout(1200);
await page.screenshot({ path: 'shot-glow.png' });

console.log(errors.length ? errors.slice(0, 8).join('\n') : 'NONE');
await browser.close();
await server.close();
process.exit(errors.length ? 1 : 0);
