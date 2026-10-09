// Visual check for the bed rework + catcher UI: the placed 2-block bed from
// several angles and all four facings, the bed/catcher hotbar icons, the held
// bed + held orb, and the sleeping (bed) screen.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const I_MOB_CATCHER = 182, I_MOB_CATCHER_FILLED = 183;

const server = await createServer({ root: process.cwd(), server: { port: 5221 } });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

await page.goto('http://localhost:5221/#debugmobs');
await page.waitForTimeout(1000);
await page.locator('.mode-pick button', { hasText: 'Creative' }).click();
await page.locator('.create-btn').click();
await page.waitForSelector('#loading.hidden', { timeout: 60000, state: 'attached' });
await page.waitForTimeout(2500);
await page.mouse.click(640, 360);
await page.waitForTimeout(300);

// Four beds (one per facing) on a stone platform high above the terrain, so the
// camera framing is identical whatever world the fresh profile rolled.
const built = await page.evaluate(({ I_MOB_CATCHER, I_MOB_CATCHER_FILLED }) => {
  const g = window.__game, p = g.player, B = window.__B;
  const ox = Math.floor(p.pos.x), oy = 108, oz = Math.floor(p.pos.z);
  for (let dx = -8; dx <= 14; dx++) {
    for (let dz = -8; dz <= 10; dz++) {
      g.world.setBlock(ox + dx, oy - 1, oz + dz, B.STONE);
      for (let dy = 0; dy <= 10; dy++) g.world.setBlock(ox + dx, oy + dy, oz + dz, 0);
    }
  }
  p.pos.x = ox + 0.5; p.pos.y = oy; p.pos.z = oz + 4.5;
  const bed = (fx, fz, facing) => {
    const dvx = facing === 1 ? -1 : facing === 3 ? 1 : 0;
    const dvz = facing === 0 ? -1 : facing === 2 ? 1 : 0;
    g.world.bedFacings.set(`${fx},${oy},${fz}`, facing);
    g.world.bedFacings.set(`${fx + dvx},${oy},${fz + dvz}`, facing);
    g.world.setBlock(fx, oy, fz, B.BED);
    g.world.setBlock(fx + dvx, oy, fz + dvz, B.BED_HEAD);
  };
  bed(ox, oz, 0);            // head toward -z
  bed(ox + 3, oz, 2);        // head toward +z
  bed(ox + 6, oz, 3);        // head toward +x
  bed(ox + 9, oz, 1);        // head toward -x
  p.flying = true; p.vel = { x: 0, y: 0, z: 0 };
  p.inventory.slots[0] = { id: B.BED, count: 1 };
  p.inventory.slots[1] = { id: I_MOB_CATCHER, count: 16 };
  p.inventory.slots[2] = { id: I_MOB_CATCHER_FILLED, count: 1, mob: 'creeper' };
  p.inventory.slots[3] = { id: I_MOB_CATCHER_FILLED, count: 1, mob: 'skeleton' };
  p.inventory.slots[4] = { id: I_MOB_CATCHER_FILLED, count: 1, mob: 'zombie' };
  p.inventory.slots[5] = { id: I_MOB_CATCHER_FILLED, count: 1, mob: 'spider' };
  p.inventory.slots[6] = { id: I_MOB_CATCHER_FILLED, count: 1, mob: 'phantom' };
  p.inventory.slots[7] = { id: I_MOB_CATCHER_FILLED, count: 1, mob: 'emberghast' };
  p.inventory.selected = 0;
  g.onInventoryChange();
  return { ox, oy, oz };
}, { I_MOB_CATCHER, I_MOB_CATCHER_FILLED });
await page.waitForTimeout(1800); // let the platform chunks re-mesh

// park the eye at an offset from a point and look at it
async function shoot(name, tx, ty, tz, offX, offY, offZ, extra = 300) {
  await page.evaluate(({ tx, ty, tz, offX, offY, offZ }) => {
    const p = window.__game.player;
    const eyeX = tx + offX, eyeY = ty + offY, eyeZ = tz + offZ;
    const eh = p.eyeHeight ? p.eyeHeight() : 1.62;
    p.flying = true; p.vel = { x: 0, y: 0, z: 0 };
    p.pos.x = eyeX; p.pos.y = eyeY - eh; p.pos.z = eyeZ;
    const dx = tx - eyeX, dy = ty - eyeY, dz = tz - eyeZ;
    p.yaw = Math.atan2(-dx, -dz);
    p.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  }, { tx, ty, tz, offX, offY, offZ });
  await page.waitForTimeout(extra);
  await page.screenshot({ path: name });
}

const { ox, oy, oz } = built;
// 1) 3/4 hero of the -z bed (pillow at the far end)
await shoot('shot-bed2-hero.png', ox + 0.5, oy + 0.35, oz - 0.5, -2.2, 2.0, 2.4);
// 2) low side-on profile: legs, mattress height, pillow puff
await shoot('shot-bed2-side.png', ox + 0.5, oy + 0.4, oz - 0.5, -3.0, 0.35, 0.2);
// 3) all four beds from above, checking the pillow always faces the head end
await shoot('shot-bed2-facings.png', ox + 5, oy + 0.3, oz - 0.5, 0.2, 7.5, 6.5);
// 4) foot-end view down the bed
await shoot('shot-bed2-foot.png', ox + 0.5, oy + 0.45, oz - 0.5, 0.1, 0.9, 3.4);

// 5) held bed in hand + hotbar icons
await page.evaluate(() => {
  const g = window.__game, p = g.player;
  p.pitch = -0.15; p.inventory.selected = 0; g.onInventoryChange();
});
await page.waitForTimeout(700);
await page.screenshot({ path: 'shot-bed2-held.png' });
await page.screenshot({ path: 'shot-icons-hotbar.png', clip: { x: 420, y: 655, width: 440, height: 62 } });

// 6) held empty orb, then a filled one
await page.evaluate(() => {
  const g = window.__game; g.player.inventory.selected = 1; g.onInventoryChange();
});
await page.waitForTimeout(700);
await page.screenshot({ path: 'shot-orb-empty.png' });
await page.evaluate(() => {
  const g = window.__game; g.player.inventory.selected = 2; g.onInventoryChange();
});
await page.waitForTimeout(700);
await page.screenshot({ path: 'shot-orb-filled.png' });

// 7) inventory screen: bed + catcher icons at 2x, plus the recipe book
await page.keyboard.press('KeyE');
await page.waitForTimeout(600);
await page.screenshot({ path: 'shot-icons-inventory.png' });
await page.keyboard.press('KeyE');
await page.waitForTimeout(400);

// 8) sleep: night, stand next to the bed, right-click it through the real path
const slept = await page.evaluate(() => {
  const g = window.__game, p = g.player, B = window.__B;
  g.dayTime = 0.72;
  p.flying = false;
  p.pos.x = g.__bedX ?? p.pos.x;
  return { state: g.state };
});
await page.evaluate(({ ox, oy, oz }) => {
  const g = window.__game, p = g.player;
  p.flying = false;
  p.pos.x = ox + 1.6; p.pos.y = oy; p.pos.z = oz + 0.5;
  p.yaw = Math.PI / 2; p.pitch = -0.1;
  g.useBed(ox, oy, oz);   // foot half
}, built);
await page.waitForTimeout(700);
await page.screenshot({ path: 'shot-sleep-lying.png' });
const sleepCam = await page.evaluate(({ oy }) => {
  const g = window.__game, cam = g.renderer.camera;
  return {
    bed: g.sleepBed,
    cam: [+cam.position.x.toFixed(2), +cam.position.y.toFixed(2), +cam.position.z.toFixed(2)],
    rot: [+cam.rotation.x.toFixed(2), +cam.rotation.y.toFixed(2)],
    heightAboveMattress: +(cam.position.y - (oy + 0.5625)).toFixed(2),
    camCell: g.world.getBlock(Math.floor(cam.position.x), Math.floor(cam.position.y), Math.floor(cam.position.z)),
  };
}, built);
await page.waitForTimeout(1400);
await page.screenshot({ path: 'shot-sleep-fade.png' });
await page.waitForTimeout(1800);
const afterSleep = await page.evaluate(() => ({
  state: window.__game.state,
  dayTime: +window.__game.dayTime.toFixed(3),
}));
await page.screenshot({ path: 'shot-sleep-morning.png' });

// 9) same bed-camera framing in daylight, so the model is readable in the shot
await page.evaluate(({ ox, oy, oz }) => {
  const g = window.__game;
  g.dayTime = 0.25;
  g.startSleep({ cx: ox + 0.5, cz: oz - 0.5, y: oy, yaw: Math.PI });
}, built);
await page.waitForTimeout(900);
await page.screenshot({ path: 'shot-sleep-daylight.png' });
await page.evaluate(() => window.__game.leaveBed());
await page.waitForTimeout(300);

// 10) pixel-art sheet: every new sprite blown up 8x so the art is judgeable
await page.evaluate(() => {
  const g = window.__game;
  const names = ['bed', 'mob_catcher', 'mob_catcher_filled_zombie', 'mob_catcher_filled_skeleton',
    'mob_catcher_filled_creeper', 'mob_catcher_filled_spider', 'mob_catcher_filled_cinderling',
    'mob_catcher_filled_ashstalker', 'mob_catcher_filled_phantom', 'mob_catcher_filled_emberghast'];
  const S = 8, pad = 6;
  const c = document.createElement('canvas');
  c.width = names.length * (16 * S + pad) + pad;
  c.height = 16 * S + pad * 2;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#3a3a44';
  ctx.fillRect(0, 0, c.width, c.height);
  names.forEach((n, i) => {
    const s = g.atlas.sprite(n);
    if (s) ctx.drawImage(s, 0, 0, 16, 16, pad + i * (16 * S + pad), pad, 16 * S, 16 * S);
  });
  const wrap = document.createElement('div');
  wrap.id = 'sprite-sheet';
  wrap.style.cssText = 'position:absolute;left:0;top:0;z-index:9999;';
  wrap.appendChild(c);
  document.body.appendChild(wrap);
});
await page.waitForTimeout(300);
const sheet = await page.locator('#sprite-sheet').boundingBox();
await page.screenshot({ path: 'shot-sprite-sheet.png', clip: sheet });
await page.evaluate(() => document.getElementById('sprite-sheet')?.remove());

// pixel probe: what is actually painted into the empty-orb sprite, row by row
const probe = await page.evaluate(() => {
  const s = window.__game.atlas.sprite('mob_catcher');
  if (!s) return ['NO SPRITE'];
  const d = s.getContext('2d').getImageData(0, 0, 16, 16).data;
  const hex = (n) => n.toString(16).padStart(2, '0');
  const out = [];
  for (let y = 0; y < 16; y++) {
    let row = '';
    for (let x = 0; x < 16; x++) {
      const o = (y * 16 + x) * 4;
      row += d[o + 3] < 8 ? '.......' : `#${hex(d[o])}${hex(d[o + 1])}${hex(d[o + 2])} `;
    }
    out.push(`${String(y).padStart(2)} ${row}`);
  }
  return out;
});
console.log('ORB PIXELS:\n' + probe.slice(6, 10).join('\n'));

console.log('BUILT :', JSON.stringify(built));
console.log('SLEPT :', JSON.stringify(slept), '->', JSON.stringify(afterSleep));
console.log('SLEEPCAM:', JSON.stringify(sleepCam));
console.log('--- console errors ---');
console.log(errors.length ? errors.slice(0, 12).join('\n') : 'NONE');
const pass = afterSleep.state === 'playing' && afterSleep.dayTime < 0.2 && errors.length === 0;
console.log(pass ? 'RESULT: PASS' : 'RESULT: FAIL');

await browser.close();
await server.close();
process.exit(pass ? 0 : 1);
