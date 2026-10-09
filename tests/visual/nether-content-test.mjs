// Visual check of the new Nether content: the two mobs (cinderling, ashstalker)
// and the new blocks (magma, nether bricks), framed on a lit platform.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { port: 5220 } });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

await page.goto('http://localhost:5220/#debugmobs');
await page.waitForTimeout(1000);
await page.locator('.mode-pick button', { hasText: 'Creative' }).click();
await page.locator('.create-btn').click();
await page.waitForSelector('#loading.hidden', { timeout: 60000, state: 'attached' });
await page.waitForTimeout(2000);
await page.mouse.click(640, 360);
await page.waitForTimeout(200);

await page.evaluate(() => { window.__game.teleportPlayerDimension(); });
await page.waitForTimeout(3500);

const info = await page.evaluate(() => {
  const g = window.__game, B = window.__B, w = g.world;
  const Y = 80, cx = Math.round(g.player.pos.x), cz = Math.round(g.player.pos.z);
  const x0 = cx - 4, rowZ = cz - 4;
  // clear + floor a stage
  for (let x = x0 - 2; x <= x0 + 10; x++)
    for (let y = Y - 1; y <= Y + 6; y++)
      for (let z = rowZ - 2; z <= cz + 3; z++) w.setBlock(x, y, z, B.AIR);
  for (let x = x0 - 2; x <= x0 + 10; x++)
    for (let z = rowZ - 2; z <= cz + 3; z++) w.setBlock(x, Y - 1, z, B.NETHERRACK);
  // block showcase row + glowstone lights
  w.setBlock(x0 + 1, Y - 1, rowZ + 1, B.MAGMA);
  w.setBlock(x0 + 2, Y - 1, rowZ + 1, B.MAGMA);
  w.setBlock(x0 + 5, Y, rowZ - 1, B.NETHER_BRICKS);
  w.setBlock(x0 + 6, Y, rowZ - 1, B.NETHER_BRICKS);
  w.setBlock(x0 + 5, Y + 1, rowZ - 1, B.NETHER_BRICKS);
  w.setBlock(x0 + 6, Y + 1, rowZ - 1, B.NETHER_BRICKS);
  w.setBlock(x0 - 1, Y + 3, rowZ - 1, B.GLOWSTONE);
  w.setBlock(x0 + 9, Y + 3, rowZ - 1, B.GLOWSTONE);

  // spawn the two nether mobs on the stage
  const a = g.entities.spawnMob('cinderling', x0 + 4, Y, rowZ + 1.5);
  const b = g.entities.spawnMob('ashstalker', x0 + 6, Y, rowZ + 2);
  a.yaw = 0.5; b.yaw = -0.5;

  const p = g.player;
  p.pos.x = x0 + 5; p.pos.y = Y + 0.9; p.pos.z = rowZ + 6;
  p.vel.x = p.vel.y = p.vel.z = 0; p.yaw = 0; p.pitch = -0.14;
  return { mobs: g.entities.entities.filter((e) => e.kind === 'cinderling' || e.kind === 'ashstalker').length };
});
console.log('nether mobs spawned:', JSON.stringify(info));
await page.waitForTimeout(800);
await page.screenshot({ path: 'shot-nether-content.png' });

console.log(errors.length ? errors.slice(0, 10).join('\n') : 'NONE');
await browser.close();
await server.close();
process.exit(errors.length ? 1 : 0);
