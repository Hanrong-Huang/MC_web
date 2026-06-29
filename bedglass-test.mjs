// Visual check: a placed bed (legs + mattress + pillow) and a glass structure,
// viewed from a 3/4 angle in daylight.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { port: 5214 } });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

await page.goto('http://localhost:5214/#debugmobs');
await page.waitForTimeout(1000);
await page.locator('.mode-pick button', { hasText: 'Creative' }).click();
await page.locator('.create-btn').click();
await page.waitForSelector('#loading.hidden', { timeout: 60000, state: 'attached' });
await page.waitForTimeout(2500);
await page.mouse.click(640, 360);
await page.waitForTimeout(300);

// build a clean platform with a bed (both halves) and a glass wall in front,
// then frame it from a raised 3/4 angle.
const built = await page.evaluate(() => {
  const g = window.__game; const p = g.player; const B = window.__B;
  const ox = Math.floor(p.pos.x), oy = Math.floor(p.pos.y), oz = Math.floor(p.pos.z);
  // carve a big open bubble so terrain doesn't box the camera in
  for (let dx = -6; dx <= 8; dx++)
    for (let dz = -6; dz <= 8; dz++) {
      g.world.setBlock(ox + dx, oy - 1, oz + dz, B.STONE);
      for (let dy = 0; dy <= 9; dy++) g.world.setBlock(ox + dx, oy + dy, oz + dz, B.AIR);
    }
  // bed: foot + head along +x (facing 3 = +x). bedFacings maps each cell.
  const fx = ox + 1, fz = oz + 1;
  g.world.bedFacings.set(`${fx},${oy},${fz}`, 3);
  g.world.bedFacings.set(`${fx + 1},${oy},${fz}`, 3);
  g.world.setBlock(fx, oy, fz, B.BED);
  g.world.setBlock(fx + 1, oy, fz, B.BED_HEAD);
  // a 3x3 glass wall a couple blocks behind the bed
  for (let dy = 0; dy <= 2; dy++)
    for (let dx = 0; dx <= 2; dx++)
      g.world.setBlock(ox + 1 + dx, oy + dy, oz + 4, B.GLASS);
  g.world.setBlock(ox + 4, oy, oz + 1, B.GLASS); // a lone glass block on the floor
  return { ox, oy, oz, fx, fz };
});
// viewpoint: raised 3/4 angle aimed at the bed
await page.evaluate(({ fx, fz, oy }) => {
  const p = window.__game.player;
  const cx = fx - 2.5, cy = oy + 3, cz = fz - 2.5;
  p.pos.x = cx; p.pos.y = cy; p.pos.z = cz;
  const bx = fx + 0.5, by = oy + 0.4, bz = fz;
  const dx = bx - cx, dy = by - cy, dz = bz - cz;
  p.yaw = Math.atan2(-dx, -dz);
  p.pitch = Math.atan2(dy, Math.hypot(dx, dz)); // positive = up in this engine
}, built);
await page.waitForTimeout(800);
await page.screenshot({ path: 'shot-bedglass.png' });

// a closer, level look at the glass wall (backlit by sky)
await page.evaluate(({ ox, oy, oz }) => {
  const p = window.__game.player;
  p.pos.x = ox + 2; p.pos.y = oy + 1; p.pos.z = oz + 1.5;
  p.yaw = Math.PI; // face +z toward the glass wall
  p.pitch = 0.1;
}, built);
await page.waitForTimeout(500);
await page.screenshot({ path: 'shot-bedglass-2.png' });

console.log('--- console errors ---');
console.log(errors.length ? errors.slice(0, 12).join('\n') : 'NONE');
await browser.close();
await server.close();
process.exit(errors.length ? 1 : 0);
