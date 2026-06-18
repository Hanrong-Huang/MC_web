// Visual pass for the new Nether + redstone blocks: builds a showcase row in
// open air, lights a portal, and teleports to the Nether — screenshotting each.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { port: 5217 } });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

await page.goto('http://localhost:5217/#debugmobs');
await page.waitForTimeout(1000);
await page.locator('.mode-pick button', { hasText: 'Creative' }).click();
await page.locator('.create-btn').click();
await page.waitForSelector('#loading.hidden', { timeout: 60000, state: 'attached' });
await page.waitForTimeout(2000);
await page.mouse.click(640, 360);
await page.waitForTimeout(200);

// Build a showcase row in open air and frame it.
await page.evaluate(() => {
  const g = window.__game;
  const B = window.__B;
  const w = g.world;
  const Y = 110;
  const cx = Math.round(g.player.pos.x);
  const cz = Math.round(g.player.pos.z);
  const rowZ = cz - 4;
  const x0 = cx - 4;

  // clear a big air pocket
  for (let x = x0 - 2; x <= x0 + 12; x++)
    for (let y = Y - 2; y <= Y + 4; y++)
      for (let z = rowZ - 3; z <= cz + 2; z++) w.setBlock(x, y, z, B.AIR);
  // stone floor
  for (let x = x0 - 2; x <= x0 + 12; x++)
    for (let z = rowZ - 2; z <= cz + 2; z++) w.setBlock(x, Y - 1, z, B.STONE);

  const row = [
    B.NETHERRACK, B.GLOWSTONE, B.SOUL_SAND, B.QUARTZ_ORE,
    B.REDSTONE_LAMP_LIT, B.REDSTONE_LAMP, B.PISTON, B.STICKY_PISTON,
  ];
  for (let i = 0; i < row.length; i++) w.setBlock(x0 + i, Y, rowZ, row[i]);

  // pistons face up and extend
  w.pistonFacings.set(`${x0 + 6},${Y},${rowZ}`, 1);
  w.pistonFacings.set(`${x0 + 7},${Y},${rowZ}`, 1);
  g.extendPiston(x0 + 6, Y, rowZ);
  g.extendPiston(x0 + 7, Y, rowZ);

  // lever + button + wire on the floor in front of the row
  w.setBlock(x0 + 0, Y, rowZ + 1, B.LEVER);
  w.redstoneStates.set(`${x0 + 0},${Y},${rowZ + 1}`, { active: true, facing: 1 });
  w.setBlock(x0 + 1, Y, rowZ + 1, B.WOODEN_BUTTON);
  w.setBlock(x0 + 2, Y, rowZ + 1, B.STONE_BUTTON);
  for (let i = 3; i <= 7; i++) w.setBlock(x0 + i, Y, rowZ + 1, B.REDSTONE_WIRE);
  g.triggerRedstoneUpdate(x0 + 3, Y, rowZ + 1);

  // camera: stand back and above, look down at the row
  const p = g.player;
  p.pos.x = x0 + 3.5; p.pos.y = Y + 1.0; p.pos.z = rowZ + 4.5;
  p.vel.x = p.vel.y = p.vel.z = 0;
  p.yaw = 0; p.pitch = -0.32;
});
await page.waitForTimeout(300);
await page.screenshot({ path: 'shot-nv-row.png' });

// Build + ignite a portal, then screenshot it.
await page.evaluate(() => {
  const g = window.__game;
  const B = window.__B;
  const w = g.world;
  const Y = 110;
  const x = Math.round(g.player.pos.x) - 2;
  const z = Math.round(g.player.pos.z) - 6;
  for (let dx = -2; dx <= 3; dx++)
    for (let dy = -2; dy <= 6; dy++)
      for (let dz = -2; dz <= 2; dz++) w.setBlock(x + dx, Y + dy, z + dz, B.AIR);
  for (let dx = -1; dx <= 2; dx++) { w.setBlock(x + dx, Y - 1, z, B.OBSIDIAN); w.setBlock(x + dx, Y + 3, z, B.OBSIDIAN); }
  for (let dy = 0; dy <= 2; dy++) { w.setBlock(x - 1, Y + dy, z, B.OBSIDIAN); w.setBlock(x + 2, Y + dy, z, B.OBSIDIAN); }
  for (let x2 = x - 2; x2 <= x + 3; x2++) for (let z2 = z - 1; z2 <= z + 1; z2++) w.setBlock(x2, Y - 2, z2, B.STONE);
  g.player.tryIgnitePortal(x, Y, z);
  const p = g.player;
  p.pos.x = x + 0.5; p.pos.y = Y; p.pos.z = z + 4;
  p.vel.x = p.vel.y = p.vel.z = 0; p.yaw = 0; p.pitch = -0.05;
});
await page.waitForTimeout(300);
await page.screenshot({ path: 'shot-nv-portal.png' });

// Teleport to the Nether, let chunks stream in, then frame a netherrack surface.
await page.evaluate(() => { window.__game.teleportPlayerDimension(); });
await page.waitForTimeout(6000); // nether chunks need fresh generation + meshing
const netherDiag = await page.evaluate(() => {
  const g = window.__game, B = window.__B, w = g.world;
  const px = Math.floor(g.player.pos.x), pz = Math.floor(g.player.pos.z);
  // count netherrack nearby + find a surface block (netherrack with air above)
  let count = 0, found = null;
  for (let dx = -8; dx <= 8; dx++) for (let dz = -8; dz <= 8; dz++) {
    for (let y = 90; y > 10; y--) {
      const id = w.getBlock(px + dx, y, pz + dz);
      if (id === B.NETHERRACK) count++;
      if (!found && id === B.NETHERRACK && w.getBlock(px + dx, y + 1, pz + dz) === B.AIR) {
        found = [px + dx, y, pz + dz];
      }
    }
  }
  if (found) {
    const [fx, fy, fz] = found;
    w.setBlock(fx, fy + 4, fz, B.GLOWSTONE);      // a light source so faces are lit
    const p = g.player;
    p.pos.x = fx + 0.5; p.pos.y = fy + 1.5; p.pos.z = fz + 5;
    p.vel.x = p.vel.y = p.vel.z = 0; p.yaw = 0; p.pitch = -0.18;
  }
  return { dim: w.dimension, netherrackNearby: count, found };
});
console.log('nether diag:', JSON.stringify(netherDiag));
await page.waitForTimeout(1500);
await page.screenshot({ path: 'shot-nv-nether.png' });

console.log(errors.length ? errors.slice(0, 12).join('\n') : 'NONE');
await browser.close();
await server.close();
process.exit(errors.length ? 1 : 0);
