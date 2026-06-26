// Thorough bed check: place a real bed on a cleared platform, view it from
// several angles, then hold it in hand to confirm it's a flat slab, not a cube.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { port: 5205 } });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

await page.goto('http://localhost:5205/#debugmobs');
await page.waitForTimeout(1200);
await page.locator('.create-btn').click();
await page.waitForSelector('#loading.hidden', { timeout: 60000, state: 'attached' });
await page.waitForTimeout(2500);

// build a clean platform and place a bed at its centre; remember the bed coords
const bed = await page.evaluate(() => {
  const g = window.__game; const p = g.player; const B = window.__B;
  p.mode = 'creative'; p.dead = false; p.hp = 20; // can't die / fall-damage while posing
  const cx = Math.floor(p.pos.x), cy = Math.floor(p.pos.y), cz = Math.floor(p.pos.z) - 6;
  for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
    g.world.setBlock(cx + dx, cy - 1, cz + dz, B.STONE);
    for (let dy = 0; dy <= 4; dy++) g.world.setBlock(cx + dx, cy + dy, cz + dz, 0);
  }
  g.world.setBlock(cx, cy, cz, B.BED);
  p.inventory.slots[0] = { id: B.BED, count: 1 };
  p.inventory.selected = 0; p.inventory.onChange();
  p.flying = true; p.vel = { x: 0, y: 0, z: 0 };
  return { x: cx + 0.5, y: cy, z: cz + 0.5 };
});

// helper: place the camera at an offset and aim it at the bed
async function shot(name, ox, oy, oz) {
  await page.evaluate(({ bed, ox, oy, oz }) => {
    const p = window.__game.player;
    p.pos.x = bed.x + ox; p.pos.y = bed.y + oy; p.pos.z = bed.z + oz;
    const dx = bed.x - p.pos.x, dy = (bed.y + 0.3) - (p.pos.y + p.eyeHeight()), dz = bed.z - p.pos.z;
    p.yaw = Math.atan2(-dx, -dz);
    p.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  }, { bed, ox, oy, oz });
  await page.waitForTimeout(700);
  await page.screenshot({ path: name });
}

await shot('bed-front.png', 0, 1.2, 3.0);   // looking from the foot
await shot('bed-side.png', 3.0, 1.2, 0.2);   // looking from the side
await shot('bed-iso.png', 2.4, 2.2, 2.4);    // 3/4 isometric-ish

// held in hand: look flat ahead at the sky so the held bed shows in the corner
await page.evaluate(() => {
  const p = window.__game.player;
  p.pos.y = p.pos.y + 1; p.pitch = 0.1; p.yaw = 0;
});
await page.waitForTimeout(700);
await page.screenshot({ path: 'bed-held.png' });

console.log('--- console errors ---');
console.log(errors.length ? errors.slice(0, 8).join('\n') : 'NONE');
await browser.close();
await server.close();
process.exit(errors.length ? 1 : 0);
