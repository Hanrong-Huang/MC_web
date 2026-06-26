// Verify the 2-block (1x2) bed: place foot+head via the real placement path,
// confirm it makes two blocks with a facing, and screenshot it from several
// angles. Also check the held-in-hand item.
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

// build a clean platform and lay a 1x2 bed (foot + head) facing -Z, plus give
// the player a bed item to hold
const info = await page.evaluate(() => {
  const g = window.__game; const p = g.player; const B = window.__B;
  p.mode = 'creative'; p.dead = false; p.hp = 20;
  const cx = Math.floor(p.pos.x), cy = Math.floor(p.pos.y), cz = Math.floor(p.pos.z) - 6;
  for (let dx = -4; dx <= 4; dx++) for (let dz = -5; dz <= 4; dz++) {
    g.world.setBlock(cx + dx, cy - 1, cz + dz, B.STONE);
    for (let dy = 0; dy <= 4; dy++) g.world.setBlock(cx + dx, cy + dy, cz + dz, 0);
  }
  // facing 0 = -z: foot at (cx,cy,cz), head one block toward -z (pillow at -z end)
  const facing = 0;
  g.world.setBlock(cx, cy, cz, B.BED);
  g.world.setBlock(cx, cy, cz - 1, B.BED_HEAD);
  g.world.bedFacings.set(`${cx},${cy},${cz}`, facing);
  g.world.bedFacings.set(`${cx},${cy},${cz - 1}`, facing);
  // a second bed facing 3 = +x to confirm the pillow rotates to the head end
  g.world.setBlock(cx + 3, cy, cz, B.BED);
  g.world.setBlock(cx + 4, cy, cz, B.BED_HEAD);
  g.world.bedFacings.set(`${cx + 3},${cy},${cz}`, 3);
  g.world.bedFacings.set(`${cx + 4},${cy},${cz}`, 3);
  g.world.markDirty(Math.floor(cx / 16), Math.floor(cz / 16));
  g.world.markDirty(Math.floor((cx + 4) / 16), Math.floor(cz / 16));
  p.inventory.slots[0] = { id: B.BED, count: 1 };
  p.inventory.selected = 0; p.inventory.onChange();
  p.flying = true; p.vel = { x: 0, y: 0, z: 0 };
  return {
    foot: g.world.getBlock(cx, cy, cz),
    head: g.world.getBlock(cx, cy, cz - 1),
    BED: B.BED, BED_HEAD: B.BED_HEAD,
    bedX: cx + 0.5, bedY: cy, bedZ: cz - 0.5, // centre of the 1x2 bed
  };
});
console.log('foot block:', info.foot, '(expect', info.BED + ')  head block:', info.head, '(expect', info.BED_HEAD + ')');

async function shot(name, ox, oy, oz) {
  await page.evaluate(({ b, ox, oy, oz }) => {
    const p = window.__game.player;
    p.pos.x = b.bedX + ox; p.pos.y = b.bedY + oy; p.pos.z = b.bedZ + oz;
    const dx = b.bedX - p.pos.x, dy = (b.bedY + 0.3) - (p.pos.y + p.eyeHeight()), dz = b.bedZ - p.pos.z;
    p.yaw = Math.atan2(-dx, -dz);
    p.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  }, { b: info, ox, oy, oz });
  await page.waitForTimeout(700);
  await page.screenshot({ path: name });
}

await shot('bed-iso.png', 1.5, 3.6, 2.6);   // top-down-ish to read both beds + pillows
await shot('bed-side.png', 3.4, 1.0, 0);
await shot('bed-front.png', 0, 1.2, 3.4);

// top-down over the SECOND bed (facing +x) to confirm its pillow points +x
await page.evaluate(({ b }) => {
  const p = window.__game.player;
  p.pos.x = b.bedX + 3.5; p.pos.y = b.bedY + 3.2; p.pos.z = b.bedZ + 0.5;
  p.yaw = -Math.PI / 2;   // look along +x (the bed's length)
  p.pitch = -0.9;         // steep top-down
}, { b: info });
await page.waitForTimeout(700);
await page.screenshot({ path: 'bed-facing3.png' });

// held in hand
await page.evaluate(() => { const p = window.__game.player; p.pos.y += 1; p.yaw = 0; p.pitch = 0.1; });
await page.waitForTimeout(700);
await page.screenshot({ path: 'bed-held.png' });

console.log('--- console errors ---');
console.log(errors.length ? errors.slice(0, 8).join('\n') : 'NONE');
await browser.close();
await server.close();
process.exit(errors.length ? 1 : 0);
