// Logic validation: a pressure plate in front of a door opens/closes it, and a
// hand-opened door survives an unrelated redstone update. Drives the world via
// the #debugmobs window.__game / window.__B hooks.
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

const r = await page.evaluate(() => {
  const g = window.__game;
  const B = window.__B;
  const w = g.world;
  const res = {};
  const base = { x: Math.round(g.player.pos.x) + 5, y: Math.round(g.player.pos.y) + 2, z: Math.round(g.player.pos.z) };
  const clear = (cx, cy, cz, r = 3) => {
    for (let x = cx - r; x <= cx + r; x++)
      for (let y = cy - r; y <= cy + r; y++)
        for (let z = cz - r; z <= cz + r; z++) w.setBlock(x, y, z, B.AIR);
  };

  // Test 1: pressure plate beside a door opens it when pressed, closes when released
  {
    const x = base.x, y = base.y, z = base.z;
    clear(x, y, z, 4);
    w.setBlock(x, y - 1, z, B.STONE);           // floor under door
    w.setBlock(x, y, z, B.DOOR_LOWER);
    w.setBlock(x, y + 1, z, B.DOOR_UPPER);
    w.doorStates.set(`${x},${y},${z}`, { facing: 0, open: false, swing: 0 });
    w.setBlock(x + 1, y - 1, z, B.STONE);       // floor under plate
    w.setBlock(x + 1, y, z, B.PRESSURE_PLATE);  // plate directly beside the door foot
    w.redstoneStates.set(`${x + 1},${y},${z}`, { active: false, facing: 1 });

    // press
    w.redstoneStates.get(`${x + 1},${y},${z}`).active = true;
    g.triggerRedstoneUpdate(x + 1, y, z);
    res.openOnPress = w.doorStates.get(`${x},${y},${z}`).open === true;

    // release
    w.redstoneStates.get(`${x + 1},${y},${z}`).active = false;
    g.triggerRedstoneUpdate(x + 1, y, z);
    res.closeOnRelease = w.doorStates.get(`${x},${y},${z}`).open === false;
  }

  // Test 2: a hand-opened door (no redstone) is NOT slammed shut by an unrelated update
  {
    const x = base.x, y = base.y, z = base.z + 8;
    clear(x, y, z, 4);
    w.setBlock(x, y - 1, z, B.STONE);
    w.setBlock(x, y, z, B.DOOR_LOWER);
    w.setBlock(x, y + 1, z, B.DOOR_UPPER);
    w.doorStates.set(`${x},${y},${z}`, { facing: 0, open: false, swing: 0 });
    w.toggleDoor(x, y, z);                       // open by hand
    res.handOpened = w.doorStates.get(`${x},${y},${z}`).open === true;
    g.triggerRedstoneUpdate(0, 0, 0);            // unrelated global update
    res.stillOpenAfterUpdate = w.doorStates.get(`${x},${y},${z}`).open === true;
  }

  // Test 3: trapdoor driven by an adjacent plate
  {
    const x = base.x, y = base.y, z = base.z + 16;
    clear(x, y, z, 4);
    w.setBlock(x, y - 1, z, B.STONE);
    w.setBlock(x, y, z, B.TRAPDOOR);
    w.doorStates.set(`${x},${y},${z}`, { facing: 0, open: false });
    w.setBlock(x + 1, y - 1, z, B.STONE);
    w.setBlock(x + 1, y, z, B.PRESSURE_PLATE);
    w.redstoneStates.set(`${x + 1},${y},${z}`, { active: true, facing: 1 });
    g.triggerRedstoneUpdate(x + 1, y, z);
    res.trapOpenOnPress = w.doorStates.get(`${x},${y},${z}`).open === true;
  }

  return res;
});

console.log(JSON.stringify(r, null, 2));
const ok = r.openOnPress && r.closeOnRelease && r.handOpened && r.stillOpenAfterUpdate && r.trapOpenOnPress;
console.log('ALL PASS:', ok);
console.log('--- console errors ---');
console.log(errors.length ? errors.slice(0, 12).join('\n') : 'NONE');
await browser.close();
await server.close();
process.exit(ok && errors.length === 0 ? 0 : 1);
