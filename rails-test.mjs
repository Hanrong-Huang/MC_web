// Rails + minecarts on the y=108 platform: rails laid through the player join
// up (straights, a corner, a slope onto a block), a cart kicked off a powered
// rail by a wall runs down the line, trips a detector rail (lamp), stops on an
// unpowered powered rail, takes a corner, rolls down a slope; riding (get in,
// W to push, shift to get out onto free ground), an activator rail throwing
// the rider out, breaking a cart (drops the item), placing one from the item,
// and the save carrying carts. Screenshots (unless NO_SHOTS=1) go to $SHOT_DIR.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const PORT = +(process.env.PORT ?? 5285);
const DIR = process.env.SHOT_DIR ?? '.';
const SHOTS = process.env.NO_SHOTS !== '1';
const server = await createServer({ root: process.cwd(), server: { port: PORT, watch: { ignored: ['**/.claude/**'] } } });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}\n${e.stack}`));

await page.goto(`http://localhost:${PORT}/#debugmobs`, { timeout: 180000 });
await page.waitForLoadState('networkidle', { timeout: 180000 });
await page.waitForTimeout(3000);
await page.locator('.mode-pick button', { hasText: 'Survival' }).click({ timeout: 120000 });
await page.locator('.create-btn').click({ timeout: 120000, noWaitAfter: true });
await page.waitForSelector('#loading.hidden', { timeout: 180000, state: 'attached' });
await page.waitForTimeout(2500);
await page.mouse.click(640, 360);
await page.waitForTimeout(300);

const failures = [];
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${info}`); if (!ok) failures.push(name); };
const sleep = (ms) => page.waitForTimeout(ms);
/** the headless sim runs slower than the wall clock: wait for the named carts to come to rest */
const settle = (names) => page.waitForFunction((names) => names.every((n) => {
  const c = window[n];
  return c && (c.dead || (c.age > 1 && Math.hypot(c.vel.x, c.vel.z) < 0.05));
}), names, { timeout: 90000, polling: 200 }).catch(() => console.log('  (carts still moving)'));

const s = await page.evaluate(() => {
  const g = window.__game, p = g.player, B = window.__B, w = g.world;
  const ox = Math.floor(p.pos.x), oy = 108, oz = Math.floor(p.pos.z);
  for (let dx = -6; dx <= 40; dx++) {
    for (let dz = -12; dz <= 24; dz++) {
      w.setBlock(ox + dx, oy - 1, oz + dz, B.STONE);
      for (let dy = 0; dy <= 6; dy++) w.setBlock(ox + dx, oy + dy, oz + dz, 0);
    }
  }
  for (const e of g.entities.entities) if (g.entities.isMob(e)) e.dead = true;
  p.mode = 'creative'; p.flying = false;
  const k = (x, y, z) => `${x},${y},${z}`;
  window.__rl = {
    k,
    shape: (x, y, z) => w.bedFacings.get(k(x, y, z)),
    /** lay a rail programmatically */
    rail: (x, y, z, id, shape) => { w.bedFacings.set(k(x, y, z), shape); w.setBlock(x, y, z, id); },
    /** right-click with the selected item toward a point */
    click: (px, py, pz) => {
      const ey = p.pos.y + p.eyeHeight();
      const dx = px - p.pos.x, dy = py - ey, dz = pz - p.pos.z;
      const len = Math.hypot(dx, dy, dz);
      p.yaw = Math.atan2(-dx, -dz); p.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      p.target = w.raycast(p.pos.x, ey, p.pos.z, dx / len, dy / len, dz / len, 6);
      const inp = p.deps.input, orig = inp.takeRightClick;
      inp.takeRightClick = () => { inp.takeRightClick = orig; return true; };
      p.placeCooldown = 0;
      p.updateRightClick(0.05);
      inp.takeRightClick = orig;
    },
    stand: (x, y, z) => { p.flying = false; p.vel = { x: 0, y: 0, z: 0 }; p.pos.x = x; p.pos.y = y; p.pos.z = z; },
    hold: (id, n = 16) => { p.inventory.slots[0] = id ? { id, count: n } : null; p.inventory.selected = 0; },
    carts: () => g.entities.entities.filter((e) => e.kind === 'minecart' && !e.dead),
  };
  return { ox, oy, oz };
});
const { ox, oy, oz } = s;

// --- 1. laying rails: straights, a corner, a slope ------------------------------------------
const lay = await page.evaluate(({ ox, oy, oz }) => {
  const B = window.__B, w = window.__game.world, rl = window.__rl, res = {};
  const x = ox, z = oz;
  rl.hold(B.RAIL, 64);
  // a line going +z, then a turn to +x
  rl.stand(x + 0.5, oy, z - 2.5);
  for (const dz of [0, 1, 2]) rl.click(x + 0.5, oy, z + dz + 0.5);
  rl.stand(x + 3.5, oy, z + 2.5);
  rl.click(x + 1.5, oy, z + 2.5);
  res.shapes = [rl.shape(x, oy, z), rl.shape(x, oy, z + 1), rl.shape(x, oy, z + 2), rl.shape(x + 1, oy, z + 2)];
  // a stone step at x+2 with a rail on top: the rail below slopes up to it
  w.setBlock(x + 2, oy, z + 2, B.STONE);
  rl.stand(x + 3.5, oy + 1, z + 4.5);
  rl.click(x + 2.5, oy + 1, z + 2.5);
  res.slope = rl.shape(x + 1, oy, z + 2);
  res.top = rl.shape(x + 2, oy + 1, z + 2);
  return res;
}, s);
console.log(JSON.stringify(lay));
check('rails join: straight, straight, corner (N-E), straight', JSON.stringify(lay.shapes) === JSON.stringify([0, 0, 9, 1]), JSON.stringify(lay.shapes));
check('a rail below a raised one slopes up to it', lay.slope === 2 && lay.top === 1, `${lay.slope} ${lay.top}`);

// --- 2. a powered run: kick-off, detector rail, stopping on an unpowered booster ---------------
await page.evaluate(({ ox, oy, oz }) => {
  const g = window.__game, B = window.__B, w = g.world, rl = window.__rl;
  const z = oz + 8, x0 = ox + 4;
  w.setBlock(x0 - 1, oy, z, B.STONE); // the wall the cart is pushed away from
  // special rails are laid straight in (laying one over a rail would drop its shape)
  for (let i = 3; i <= 16; i++) if (i !== 6 && i !== 10) rl.rail(x0 + i, oy, z, B.RAIL, 1);
  for (let i = 0; i < 3; i++) { w.setBlock(x0 + i, oy - 1, z, B.REDSTONE_BLOCK); rl.rail(x0 + i, oy, z, B.POWERED_RAIL, 1); } // three boosters, powered from below
  rl.rail(x0 + 6, oy, z, B.DETECTOR_RAIL, 1);
  w.setBlock(x0 + 6, oy, z + 1, B.REDSTONE_LAMP);
  rl.rail(x0 + 10, oy, z, B.POWERED_RAIL, 1); // unpowered: a brake
  for (let i = 0; i <= 16; i++) g.triggerRedstoneUpdate(x0 + i, oy, z);
  window.__lampSeen = false;
  window.__lampPoll = setInterval(() => { if (w.getBlock(x0 + 6, oy, z + 1) === B.REDSTONE_LAMP_LIT) window.__lampSeen = true; }, 5);
  window.__cart = g.entities.spawnMinecart(x0, oy, z);
}, s);
await settle(['__cart']);
await sleep(1500); // let the detector rail release
const run = await page.evaluate(({ ox, oy, oz }) => {
  const g = window.__game, c = window.__cart, w = g.world;
  clearInterval(window.__lampPoll);
  return {
    boosterOn: !!w.redstoneStates.get(`${ox + 4},${oy},${oz + 8}`)?.active,
    x: c.pos.x - (ox + 4), y: c.pos.y - oy, speed: Math.hypot(c.vel.x, c.vel.z),
    lampSeen: window.__lampSeen,
    lampNow: w.getBlock(ox + 10, oy, oz + 9) === window.__B.REDSTONE_LAMP_LIT,
  };
}, s);
console.log(JSON.stringify(run));
check('the booster with a redstone block under it is powered', run.boosterOn);
check('a cart by a wall is kicked off down the line', run.x > 6, run.x.toFixed(2));
check('the detector rail lit its lamp as the cart passed', run.lampSeen);
check('...and let go once it had gone', !run.lampNow);
check('an unpowered booster stops the cart on it', run.x > 9.4 && run.x < 11.2 && run.speed < 0.05, `${run.x.toFixed(2)} v=${run.speed.toFixed(2)}`);
check('the cart rides the rail surface', Math.abs(run.y - 1 / 16) < 0.02, run.y.toFixed(3));

// --- 3. a corner and a slope -----------------------------------------------------------------------
await page.evaluate(({ ox, oy, oz }) => {
  const g = window.__game, B = window.__B, w = g.world, rl = window.__rl;
  // west->east run turning north at x+5: shapes 1 x4, corner S-W? (joins -x and -z) = N-W (8), then N-S
  const x = ox + 22, z = oz + 16;
  for (let i = 0; i < 5; i++) rl.rail(x + i, oy, z, B.RAIL, 1);
  rl.rail(x + 5, oy, z, B.RAIL, 8);
  for (let j = 1; j <= 6; j++) rl.rail(x + 5, oy, z - j, B.RAIL, 0);
  window.__cc = g.entities.spawnMinecart(x, oy, z);
  window.__cc.vel.x = 5;
  // a slope: flat top at y+1 on a stone step, slope down to the west, flat run west
  const sx = ox + 22, sz = oz + 20;
  w.setBlock(sx + 3, oy, sz, B.STONE); w.setBlock(sx + 4, oy, sz, B.STONE);
  rl.rail(sx + 4, oy + 1, sz, B.RAIL, 1);
  rl.rail(sx + 3, oy + 1, sz, B.RAIL, 1);
  rl.rail(sx + 2, oy, sz, B.RAIL, 2); // up to the east
  for (let i = -6; i < 2; i++) rl.rail(sx + i, oy, sz, B.RAIL, 1);
  window.__cs = g.entities.spawnMinecart(sx + 4, oy + 1, sz);
  window.__cs.vel.x = -3;
}, s);
await settle(['__cc', '__cs']);
const bend = await page.evaluate(({ ox, oy, oz }) => {
  const cc = window.__cc, cs = window.__cs;
  return { cx: cc.pos.x - (ox + 22), cz: cc.pos.z - (oz + 16), sx: cs.pos.x - (ox + 22), sy: cs.pos.y - oy, sdead: cs.dead };
}, s);
console.log(JSON.stringify(bend));
check('a cart takes the corner and heads north', Math.abs(bend.cx - 5.5) < 0.3 && bend.cz < -0.5, `${bend.cx.toFixed(2)}, ${bend.cz.toFixed(2)}`);
check('a cart rolls down the slope to the lower run', bend.sx < 2.5 && Math.abs(bend.sy - 1 / 16) < 0.05, `${bend.sx.toFixed(2)}, y ${bend.sy.toFixed(2)}`);

// --- 4. riding, activator rail, breaking, placing, saving ------------------------------------------
const ride = await page.evaluate(async ({ ox, oy, oz }) => {
  const g = window.__game, B = window.__B, I = { MINECART: window.__findId('minecart') }, w = g.world, rl = window.__rl, p = g.player, res = {};
  const x = ox + 2, z = oz + 14;
  for (let i = 0; i < 12; i++) rl.rail(x + i, oy, z, B.RAIL, 1);
  // place a cart from the item
  rl.hold(I.MINECART, 1);
  p.mode = 'survival';
  rl.stand(x + 0.5, oy, z + 2.5);
  const before = rl.carts().length;
  rl.click(x + 0.5, oy + 0.05, z + 0.5);
  res.placed = rl.carts().length === before + 1;
  res.itemUsed = !p.inventory.slots[0];
  const cart = rl.carts().find((c) => Math.floor(c.pos.x) === x && Math.floor(c.pos.z) === z);
  // get in
  rl.hold(0);
  rl.click(cart.pos.x, cart.pos.y + 0.4, cart.pos.z);
  res.riding = p.riding === cart;
  // W pushes it along +x (look east)
  p.yaw = -Math.PI / 2; p.pitch = 0;
  // hold W until it has rolled a couple of blocks (the headless sim runs slow)
  p.deps.input.keys.add('KeyW');
  for (let i = 0; i < 100 && cart.pos.x - (x + 0.5) < 2; i++) await new Promise((r) => setTimeout(r, 100));
  p.deps.input.keys.delete('KeyW');
  res.pushed = cart.pos.x - (x + 0.5);
  res.seated = Math.abs(p.pos.x - cart.pos.x) < 0.35 && Math.abs(p.pos.y - (cart.pos.y + 0.25)) < 0.05; // (one frame apart)
  // shift gets you out onto free ground beside the cart
  p.prevSneak = false;
  p.deps.input.keys.add('ControlLeft');
  await new Promise((r) => setTimeout(r, 300));
  p.deps.input.keys.delete('ControlLeft');
  res.out = p.riding === null;
  const fx = Math.floor(p.pos.x), fy = Math.floor(p.pos.y), fz = Math.floor(p.pos.z);
  res.freeSpot = w.getBlock(fx, fy, fz) === 0 || !window.__B || !g.world.isSolidAt(fx, fy, fz);
  // an activator rail (powered by a lever) throws the rider out
  const ax = x + 9;
  rl.rail(ax, oy, z, B.ACTIVATOR_RAIL, 1);
  w.redstoneStates.set(rl.k(ax, oy, z + 1), { active: true, facing: 1 });
  w.setBlock(ax, oy, z + 1, B.LEVER);
  g.triggerRedstoneUpdate(ax, oy, z + 1);
  res.activatorOn = !!w.redstoneStates.get(rl.k(ax, oy, z))?.active;
  cart.pos.x = x + 6.5; cart.vel.x = 4;
  p.mount(cart);
  await new Promise((r) => setTimeout(r, 1500));
  res.ejected = p.riding === null;
  // break it (survival: a few punches, drops the item)
  const t = rl.carts().find((c) => c === cart);
  for (let i = 0; i < 3; i++) g.entities.hitCart(cart, false);
  res.broken = cart.dead;
  await new Promise((r) => setTimeout(r, 100));
  res.dropped = g.entities.entities.some((e) => e.kind === 'drop' && e.itemId === I.MINECART && Math.hypot(e.pos.x - cart.pos.x, e.pos.z - cart.pos.z) < 2);
  res.saved = (g.buildSave().carts ?? []).length === rl.carts().length && rl.carts().length >= 3;
  return res;
}, s);
console.log(JSON.stringify(ride));
check('a minecart item puts a cart on the rail (and is used up)', ride.placed && ride.itemUsed);
check('right-click gets you in', ride.riding);
check('W pushes the cart along, rider seated in it', ride.pushed > 1.5 && ride.seated, ride.pushed.toFixed(2));
check('shift gets you out onto free ground', ride.out && ride.freeSpot);
check('a powered activator rail throws the rider out', ride.activatorOn && ride.ejected);
check('three punches break a cart and drop it', ride.broken && ride.dropped);
check('the save keeps every cart', ride.saved);

// --- screenshots ------------------------------------------------------------------------------------
async function frame(tx, ty, tz, ex, ey, ez) {
  await page.evaluate(({ tx, ty, tz, ex, ey, ez }) => {
    const p = window.__game.player;
    if (p.riding) p.dismount(false);
    p.flying = true; p.vel = { x: 0, y: 0, z: 0 };
    p.pos.x = ex; p.pos.y = ey - p.eyeHeight(); p.pos.z = ez;
    const dx = tx - ex, dy = ty - ey, dz = tz - ez;
    p.yaw = Math.atan2(-dx, -dz);
    p.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  }, { tx, ty, tz, ex, ey, ez });
  await sleep(600);
  await page.waitForFunction(({ tx, tz }) => {
    const g = window.__game;
    const c0x = Math.floor(tx / 16), c0z = Math.floor(tz / 16);
    for (let cx = c0x - 1; cx <= c0x + 1; cx++) for (let cz = c0z - 1; cz <= c0z + 1; cz++) {
      const k = `${cx},${cz}`, c = g.world.getChunk(cx, cz);
      if (!c || !c.ready || g.world.dirtySet.has(k) || g.meshInFlight.has(k)) return false;
    }
    return true;
  }, { tx, tz }, { timeout: 180000, polling: 300 }).catch(() => console.log('  (mesh wait timed out)'));
  await sleep(900);
}
if (SHOTS) {
  await page.evaluate(() => { window.__game.dayTime = 0.3; });
  await frame(ox + 1, oy, oz + 2, ox + 4.5, oy + 3.5, oz + 6);
  await page.screenshot({ path: `${DIR}/rails-lay.png` });
  await frame(ox + 12, oy, oz + 8, ox + 9, oy + 3, oz + 12);
  await page.screenshot({ path: `${DIR}/rails-run.png` });
  await frame(ox + 26, oy, oz + 18, ox + 30, oy + 4, oz + 23);
  await page.screenshot({ path: `${DIR}/rails-bend.png` });
  await page.evaluate(() => {
    const g = window.__game, B = window.__B;
    const ids = [B.RAIL, B.POWERED_RAIL, B.DETECTOR_RAIL, B.ACTIVATOR_RAIL, window.__findId('minecart')];
    const c = document.createElement('canvas'); c.width = ids.length * 36; c.height = 36;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#8b8b8b'; ctx.fillRect(0, 0, c.width, c.height);
    ids.forEach((id, i) => ctx.drawImage(g.atlas.icon(id), i * 36 + 2, 2));
    c.id = 'icon-sheet';
    Object.assign(c.style, { position: 'fixed', left: '10px', top: '10px', zIndex: 99999, transform: 'scale(4)', transformOrigin: '0 0', imageRendering: 'pixelated' });
    document.body.appendChild(c);
  });
  await sleep(200);
  await page.locator('#icon-sheet').screenshot({ path: `${DIR}/rails-icons.png` });
}

console.log('--- console errors ---');
console.log(errors.length ? errors.slice(0, 8).join('\n') : 'NONE');
console.log(errors.length || failures.length ? 'SOME CHECKS FAILED' : 'ALL CHECKS PASS');
await browser.close();
await server.close();
process.exit(errors.length || failures.length ? 1 : 0);
