// Logic validation for the Nether + redstone features. Drives the world
// directly via the #debugmobs window.__game / window.__B hooks: builds
// contraptions, triggers updates, and asserts resulting block state.
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
await page.waitForTimeout(2000);

const r = await page.evaluate(() => {
  const g = window.__game;
  const B = window.__B;
  const w = g.world;
  const res = {};

  const base = { x: Math.round(g.player.pos.x) + 4, y: Math.round(g.player.pos.y) + 2, z: Math.round(g.player.pos.z) };
  const clear = (cx, cy, cz, r = 3) => {
    for (let x = cx - r; x <= cx + r; x++)
      for (let y = cy - r; y <= cy + r; y++)
        for (let z = cz - r; z <= cz + r; z++) w.setBlock(x, y, z, B.AIR);
  };

  // --- Test 1: lever -> adjacent lamp lights ---
  {
    const x = base.x, y = base.y, z = base.z;
    clear(x, y, z);
    w.setBlock(x, y, z, B.REDSTONE_LAMP);
    w.setBlock(x + 1, y, z, B.LEVER);
    w.redstoneStates.set(`${x + 1},${y},${z}`, { active: true, facing: 5 });
    g.triggerRedstoneUpdate(x + 1, y, z);
    res.lampLitOn = w.getBlock(x, y, z) === B.REDSTONE_LAMP_LIT;
    w.redstoneStates.set(`${x + 1},${y},${z}`, { active: false, facing: 5 });
    g.triggerRedstoneUpdate(x + 1, y, z);
    res.lampLitOff = w.getBlock(x, y, z) === B.REDSTONE_LAMP;
  }

  // --- Test 2: lever -> wire -> wire -> lamp (propagation) ---
  {
    const x = base.x, y = base.y, z = base.z + 8;
    clear(x, y, z);
    w.setBlock(x, y, z, B.LEVER);
    w.setBlock(x + 1, y, z, B.REDSTONE_WIRE);
    w.setBlock(x + 2, y, z, B.REDSTONE_WIRE);
    w.setBlock(x + 3, y, z, B.REDSTONE_LAMP);
    w.redstoneStates.set(`${x},${y},${z}`, { active: true, facing: 5 });
    g.triggerRedstoneUpdate(x, y, z);
    res.wirePower1 = w.redstonePower.get(`${x + 1},${y},${z}`) ?? 0;
    res.wirePower2 = w.redstonePower.get(`${x + 2},${y},${z}`) ?? 0;
    res.wireLampLit = w.getBlock(x + 3, y, z) === B.REDSTONE_LAMP_LIT;
  }

  // --- Test 3: piston extends and pushes a block ---
  {
    const x = base.x, y = base.y, z = base.z + 16;
    clear(x, y, z, 4);
    w.setBlock(x, y, z, B.PISTON);
    w.pistonFacings.set(`${x},${y},${z}`, 5); // facing +x
    w.setBlock(x + 1, y, z, B.STONE);          // block to push
    w.setBlock(x, y + 1, z, B.LEVER);
    w.redstoneStates.set(`${x},${y + 1},${z}`, { active: true, facing: 1 });
    g.triggerRedstoneUpdate(x, y, z);
    res.pistonHead = w.getBlock(x + 1, y, z) === B.PISTON_HEAD;
    res.pistonPushed = w.getBlock(x + 2, y, z) === B.STONE;
  }

  // --- Test 4: portal ignite + dimension teleport ---
  {
    const x = base.x, y = base.y, z = base.z + 24;
    clear(x, y, z, 5);
    // obsidian frame: interior 2 wide (x..x+1) x 3 tall (y..y+2), plane constant z
    for (let dx = -1; dx <= 2; dx++) {
      w.setBlock(x + dx, y - 1, z, B.OBSIDIAN);
      w.setBlock(x + dx, y + 3, z, B.OBSIDIAN);
    }
    for (let dy = 0; dy <= 2; dy++) {
      w.setBlock(x - 1, y + dy, z, B.OBSIDIAN);
      w.setBlock(x + 2, y + dy, z, B.OBSIDIAN);
    }
    const lit = g.player.tryIgnitePortal(x, y, z);
    res.portalLit = lit;
    res.portalCells =
      (w.getBlock(x, y, z) === B.PORTAL) &&
      (w.getBlock(x + 1, y, z) === B.PORTAL) &&
      (w.getBlock(x, y + 2, z) === B.PORTAL);
    // teleport
    g.teleportPlayerDimension();
    res.dimAfterTp = w.dimension;
    res.netherGround = w.getBlock(Math.floor(g.player.pos.x), Math.floor(g.player.pos.y) - 1, Math.floor(g.player.pos.z));
    res.NETHERRACK = B.NETHERRACK;
    res.OBSIDIAN = B.OBSIDIAN;
  }

  return res;
});

console.log(JSON.stringify(r, null, 2));
console.log('--- console errors ---');
console.log(errors.length ? errors.slice(0, 12).join('\n') : 'NONE');
await browser.close();
await server.close();
process.exit(errors.length ? 1 : 0);
