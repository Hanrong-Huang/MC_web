// Drive the REAL bed placement path (Player.updateRightClick) and confirm it
// lays two blocks (foot + head) with a facing, and that breaking one half
// removes the other.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { port: 5208 } });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

await page.goto('http://localhost:5208/#debugmobs');
await page.waitForTimeout(1200);
await page.locator('.create-btn').click();
await page.waitForSelector('#loading.hidden', { timeout: 60000, state: 'attached' });
await page.waitForTimeout(2500);

const res = await page.evaluate(() => {
  const g = window.__game; const p = g.player; const B = window.__B;
  p.mode = 'survival';
  const cx = Math.floor(p.pos.x) + 3, cy = Math.floor(p.pos.y), cz = Math.floor(p.pos.z);
  // a clear stone platform
  for (let dx = -1; dx <= 1; dx++) for (let dz = -3; dz <= 1; dz++) {
    g.world.setBlock(cx + dx, cy - 1, cz + dz, B.STONE);
    for (let dy = 0; dy <= 3; dy++) g.world.setBlock(cx + dx, cy + dy, cz + dz, 0);
  }
  p.yaw = 0; // face -Z, so the bed head extends toward -Z
  p.inventory.slots[p.inventory.selected] = { id: B.BED, count: 1 };
  p.placeCooldown = 0;
  // aim at the floor block two cells ahead (top face), so the foot lands on top
  const tx = cx, tz = cz - 2, ty = cy - 1;
  p.target = { x: tx, y: ty, z: tz, nx: 0, ny: 1, nz: 0, dist: 2, id: B.STONE };
  g.input.rightDown = true;
  p.updateRightClick(0.05);
  g.input.rightDown = false;

  const footX = tx, footY = ty + 1, footZ = tz;
  const headZ = footZ - 1; // facing 0 (-z)
  const placed = {
    foot: g.world.getBlock(footX, footY, footZ),
    head: g.world.getBlock(footX, footY, headZ),
    facing: g.world.bedFacings.get(`${footX},${footY},${footZ}`),
    itemConsumed: g.player.inventory.slots[g.player.inventory.selected] == null,
  };

  // now break the HEAD half and confirm the foot is removed too (breakBlock is
  // private in TS but callable at runtime)
  p.breakBlock(footX, footY, headZ, false);
  const afterBreak = {
    foot: g.world.getBlock(footX, footY, footZ),
    head: g.world.getBlock(footX, footY, headZ),
  };
  return { placed, afterBreak, BED: B.BED, BED_HEAD: B.BED_HEAD };
});

console.log('placement:', JSON.stringify(res.placed));
console.log('expect foot=' + res.BED + ' head=' + res.BED_HEAD + ' facing=0');
console.log('after breaking head half:', JSON.stringify(res.afterBreak), '(both should be 0/air)');
const ok = res.placed.foot === res.BED && res.placed.head === res.BED_HEAD &&
  res.placed.facing === 0 && res.afterBreak.foot === 0 && res.afterBreak.head === 0;
console.log('PLACEMENT + BREAK OK:', ok);

console.log('--- console errors ---');
console.log(errors.length ? errors.slice(0, 8).join('\n') : 'NONE');
await browser.close();
await server.close();
process.exit(ok && !errors.length ? 0 : 1);
