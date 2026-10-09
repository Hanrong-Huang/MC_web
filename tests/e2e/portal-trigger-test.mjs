// Tests the REAL teleport trigger path: place the player standing inside a
// portal block and let the normal 20 Hz tick run — the portalTimer should
// reach 1.5s, fire onTeleport, and switch dimensions. No direct method call.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { port: 5219 } });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

await page.goto('http://localhost:5219/#debugmobs');
await page.waitForTimeout(1000);
await page.locator('.mode-pick button', { hasText: 'Creative' }).click();
await page.locator('.create-btn').click();
await page.waitForSelector('#loading.hidden', { timeout: 60000, state: 'attached' });
await page.waitForTimeout(2000);

// Stand the player inside a portal block on a solid floor; do NOT call teleport.
const setup = await page.evaluate(() => {
  const g = window.__game, B = window.__B, w = g.world;
  const x = Math.round(g.player.pos.x), z = Math.round(g.player.pos.z);
  const y = Math.round(g.player.pos.y) + 2; // up in clear air
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 3; dy++) w.setBlock(x + dx, y + dy, z + dz, B.AIR);
    w.setBlock(x + dx, y - 1, z + dz, B.STONE); // floor
  }
  w.setBlock(x, y, z, B.PORTAL);       // player's feet block
  w.setBlock(x, y + 1, z, B.PORTAL);   // player's head block
  const p = g.player;
  p.pos.x = x + 0.5; p.pos.y = y; p.pos.z = z + 0.5;
  p.vel.x = p.vel.y = p.vel.z = 0;
  p.portalCooldown = 0; p.portalTimer = 0;
  return { dimBefore: w.dimension, startY: p.pos.y };
});

// poll dimension over ~3.5s of real (≈game) time
let dimAfter = setup.dimBefore;
let timerSeen = 0;
for (let i = 0; i < 8; i++) {
  await page.waitForTimeout(500);
  const s = await page.evaluate(() => ({
    dim: window.__game.world.dimension,
    timer: window.__game.player.portalTimer,
    cooldown: window.__game.player.portalCooldown,
  }));
  timerSeen = Math.max(timerSeen, s.timer);
  if (s.dim !== setup.dimBefore) { dimAfter = s.dim; break; }
}

console.log(JSON.stringify({
  dimBefore: setup.dimBefore,
  dimAfter,
  teleported: dimAfter !== setup.dimBefore,
  maxTimerSeen: Number(timerSeen.toFixed(2)),
}, null, 2));
console.log('--- console errors ---');
console.log(errors.length ? errors.slice(0, 8).join('\n') : 'NONE');
await browser.close();
await server.close();
process.exit(errors.length ? 1 : 0);
