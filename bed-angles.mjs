// Capture the placed bed from several angles to inspect the model (legs,
// mattress, pillow, underside).
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { port: 5216 } });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

await page.goto('http://localhost:5216/#debugmobs');
await page.waitForTimeout(1000);
await page.locator('.mode-pick button', { hasText: 'Creative' }).click();
await page.locator('.create-btn').click();
await page.waitForSelector('#loading.hidden', { timeout: 60000, state: 'attached' });
await page.waitForTimeout(2500);
await page.mouse.click(640, 360);
await page.waitForTimeout(300);

const built = await page.evaluate(() => {
  const g = window.__game; const p = g.player; const B = window.__B;
  const ox = Math.floor(p.pos.x), oy = Math.floor(p.pos.y), oz = Math.floor(p.pos.z);
  // big open grass bubble so terrain doesn't box the camera in
  for (let dx = -8; dx <= 10; dx++)
    for (let dz = -8; dz <= 10; dz++) {
      g.world.setBlock(ox + dx, oy - 1, oz + dz, B.GRASS);
      for (let dy = 0; dy <= 10; dy++) g.world.setBlock(ox + dx, oy + dy, oz + dz, B.AIR);
    }
  // bed: foot + head along +x (facing 3 = +x)
  const fx = ox + 1, fz = oz + 1;
  g.world.bedFacings.set(`${fx},${oy},${fz}`, 3);
  g.world.bedFacings.set(`${fx + 1},${oy},${fz}`, 3);
  g.world.setBlock(fx, oy, fz, B.BED);
  g.world.setBlock(fx + 1, oy, fz, B.BED_HEAD);
  // fly (no gravity) + empty hand so nothing blocks the view
  p.flying = true; p.vel = { x: 0, y: 0, z: 0 };
  p.inventory.slots[8] = null; p.inventory.selected = 8;
  g.onInventoryChange();
  return { ox, oy, oz, fx, fz };
});

// aim the camera EYE at the bed centre from an offset (blocks away)
async function shoot(name, offX, offY, offZ) {
  await page.evaluate(({ fx, fz, oy, offX, offY, offZ }) => {
    const p = window.__game.player;
    const bx = fx + 0.5, by = oy + 0.3, bz = fz;          // bed centre (between halves)
    const eyeX = bx + offX, eyeY = by + offY, eyeZ = bz + offZ;
    const eh = p.eyeHeight ? p.eyeHeight() : 1.62;
    p.flying = true; p.vel = { x: 0, y: 0, z: 0 };
    p.pos.x = eyeX; p.pos.y = eyeY - eh; p.pos.z = eyeZ;   // feet so the eye lands at eyeY
    const dx = bx - eyeX, dy = by - eyeY, dz = bz - eyeZ;
    p.yaw = Math.atan2(-dx, -dz);
    p.pitch = Math.atan2(dy, Math.hypot(dx, dz)); // positive = up
  }, { ...built, offX, offY, offZ });
  await page.waitForTimeout(400);
  await page.screenshot({ path: name });
}

// 1) low side-on: legs + mattress profile at near eye level
await shoot('shot-bed-side.png', 0.2, 0.2, -3.2);
// 2) head-on from the foot end: pillow at the far end
await shoot('shot-bed-foot.png', -3.4, 0.6, 0.2);
// 3) high 3/4 hero angle
await shoot('shot-bed-hero.png', -2.6, 2.6, -2.6);
// 4) very low, looking up slightly to read the legs + open underside
await shoot('shot-bed-low.png', -1.0, -0.15, -2.8);

console.log('--- console errors ---');
console.log(errors.length ? errors.slice(0, 12).join('\n') : 'NONE');
await browser.close();
await server.close();
process.exit(errors.length ? 1 : 0);
