// Vanilla door + trapdoor rules on the y=108 platform: hinge choice (same-kind
// neighbour mirrors, walls, click half), double-door leaves opening one at a
// time, iron doors/trapdoors ignoring hands but answering to plates, levers
// and buttons, trapdoor facing/half from the clicked face, thin collision
// (stand on a hatch, walk past an open one), raycasts through open trapdoors,
// doors popping off without a floor, and open trapdoors over ladders climbing.
// Screenshots (unless NO_SHOTS=1) go to $SHOT_DIR.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const PORT = +(process.env.PORT ?? 5261);
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
await page.locator('.mode-pick button', { hasText: 'Creative' }).click({ timeout: 120000 });
await page.locator('.create-btn').click({ timeout: 120000, noWaitAfter: true });
await page.waitForSelector('#loading.hidden', { timeout: 180000, state: 'attached' });
await page.waitForTimeout(2500);
await page.mouse.click(640, 360);
await page.waitForTimeout(300);

const failures = [];
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${info}`); if (!ok) failures.push(name); };

async function frame(tx, ty, tz, ex, ey, ez, r = 1) {
  await page.evaluate(({ tx, ty, tz, ex, ey, ez }) => {
    const p = window.__game.player;
    p.flying = true; p.vel = { x: 0, y: 0, z: 0 };
    p.pos.x = ex; p.pos.y = ey - p.eyeHeight(); p.pos.z = ez;
    const dx = tx - ex, dy = ty - ey, dz = tz - ez;
    p.yaw = Math.atan2(-dx, -dz);
    p.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  }, { tx, ty, tz, ex, ey, ez });
  await page.waitForTimeout(500);
  await page.waitForFunction(({ tx, tz, r }) => {
    const g = window.__game;
    const c0x = Math.floor(tx / 16), c0z = Math.floor(tz / 16);
    for (let cx = c0x - r; cx <= c0x + r; cx++) {
      for (let cz = c0z - r; cz <= c0z + r; cz++) {
        const k = `${cx},${cz}`;
        const c = g.world.getChunk(cx, cz);
        if (!c || !c.ready || g.world.dirtySet.has(k) || g.meshInFlight.has(k)) return false;
      }
    }
    return true;
  }, { tx, tz, r }, { timeout: 180000, polling: 300 }).catch(() => console.log('  (mesh wait timed out)'));
  await page.waitForTimeout(900);
}

// platform + a shared right-click helper that aims at a point on a block face
const s = await page.evaluate(() => {
  const g = window.__game, p = g.player, B = window.__B, w = g.world;
  const ox = Math.floor(p.pos.x), oy = 108, oz = Math.floor(p.pos.z);
  for (let dx = -6; dx <= 40; dx++) {
    for (let dz = -12; dz <= 12; dz++) {
      w.setBlock(ox + dx, oy - 1, oz + dz, B.STONE);
      for (let dy = 0; dy <= 8; dy++) w.setBlock(ox + dx, oy + dy, oz + dz, 0);
    }
  }
  for (const e of g.entities.entities) if (g.entities.isMob(e)) e.dead = true;
  /** Right-click with the selected item from the eye toward point (px,py,pz). */
  window.__click = (px, py, pz) => {
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
    return p.target && { x: p.target.x, y: p.target.y, z: p.target.z, ny: p.target.ny, id: p.target.id };
  };
  window.__stand = (x, y, z, yaw = 0) => { p.flying = false; p.mode = 'creative'; p.vel = { x: 0, y: 0, z: 0 }; p.pos.x = x; p.pos.y = y; p.pos.z = z; p.yaw = yaw; p.pitch = 0; };
  window.__hold = (id) => { p.inventory.slots[0] = id ? { id, count: 16 } : null; p.inventory.selected = 0; };
  return { ox, oy, oz };
});
const { ox, oy, oz } = s;

// --- hinges + double doors -----------------------------------------------------------
const hinge = await page.evaluate(({ ox, oy, oz }) => {
  const g = window.__game, B = window.__B, w = g.world, res = {};
  const x = ox + 2, z = oz - 4;
  const st = (dx) => w.doorStates.get(`${x + dx},${oy},${z}`);
  // facing -z (player south of the doorway): click the left half, then the right half
  window.__hold(window.__findId('oak_door'));
  window.__stand(x + 0.5, oy, z + 3.5);
  window.__click(x + 0.25, oy, z + 0.5); // top of the floor block, left quarter
  res.leftClickHinge = st(0)?.hingeRight;
  window.__stand(x + 6.5, oy, z + 3.5);
  window.__click(x + 6.75, oy, z + 0.5); // right quarter
  res.rightClickHinge = st(6)?.hingeRight;
  // a door of the same kind beside it mirrors, wherever the click lands
  window.__stand(x + 1.5, oy, z + 3.5);
  window.__click(x + 1.25, oy, z + 0.5);
  res.pairHinge = st(1)?.hingeRight;
  // a different kind (iron) beside an oak door does not pair: click rule decides
  window.__hold(window.__findId('iron_door'));
  window.__stand(x + 7.5, oy, z + 3.5);
  window.__click(x + 7.75, oy, z + 0.5); // right quarter, but oak door on its left
  res.mixedHinge = st(7)?.hingeRight;
  // a wall on the right pulls the hinge there
  w.setBlock(x + 13, oy, z, B.STONE); w.setBlock(x + 13, oy + 1, z, B.STONE);
  window.__hold(window.__findId('oak_door'));
  window.__stand(x + 12.5, oy, z + 3.5);
  window.__click(x + 12.25, oy, z + 0.5);
  res.wallHinge = st(12)?.hingeRight;
  // opening one leaf of the pair leaves the other shut
  window.__hold(0);
  window.__stand(x + 1, oy, z + 3.5);
  window.__click(x + 0.5, oy + 1, z + 0.95);
  res.leafA = st(0)?.open; res.leafB = st(1)?.open;
  // the iron door ignores a hand
  window.__stand(x + 7.5, oy, z + 3.5);
  window.__click(x + 7.5, oy + 1, z + 0.95);
  res.ironHand = st(7)?.open;
  return res;
}, s);
console.log(JSON.stringify(hinge));
check('door hinges on the clicked half (left)', hinge.leftClickHinge === false);
check('door hinges on the clicked half (right)', hinge.rightClickHinge === true);
check('a same-kind neighbour mirrors the hinge', hinge.pairHinge === true);
check('a different-kind neighbour does not pair', hinge.mixedHinge === true);
check('a wall on the right takes the hinge', hinge.wallHinge === true);
check('each leaf of a double door opens on its own', hinge.leafA === true && hinge.leafB === false);
check('iron door ignores a hand', hinge.ironHand === false);

// --- iron door/trapdoor + buttons, levers, plates ------------------------------------
const red = await page.evaluate(async ({ ox, oy, oz }) => {
  const g = window.__game, B = window.__B, w = g.world, res = {};
  const x = ox + 20, z = oz - 4;
  const sounds = [];
  const play = g.audio.play.bind(g.audio);
  g.audio.play = (n, v) => { sounds.push(n); return play(n, v); };
  const door = (dx, lo, up) => {
    w.setBlock(x + dx, oy, z, lo); w.setBlock(x + dx, oy + 1, z, up);
    w.doorStates.set(`${x + dx},${oy},${z}`, { facing: 0, open: false, hingeRight: false, swing: 0 });
  };
  door(0, B.IRON_DOOR_LOWER, B.IRON_DOOR_UPPER);
  // stone pressure plate in front
  w.setBlock(x, oy, z + 1, B.PRESSURE_PLATE);
  w.redstoneStates.set(`${x},${oy},${z + 1}`, { active: true, facing: 1 });
  g.triggerRedstoneUpdate(x, oy, z + 1);
  res.plateOpens = w.doorStates.get(`${x},${oy},${z}`).open;
  res.ironSound = sounds.includes('ironDoorOpen');
  w.redstoneStates.get(`${x},${oy},${z + 1}`).active = false;
  g.triggerRedstoneUpdate(x, oy, z + 1);
  res.plateCloses = !w.doorStates.get(`${x},${oy},${z}`).open;
  w.setBlock(x, oy, z + 1, 0);
  // a button beside the door's upper half
  w.setBlock(x + 1, oy + 1, z, B.STONE_BUTTON);
  w.redstoneStates.set(`${x + 1},${oy + 1},${z}`, { active: false, facing: 5 });
  g.player.placeCooldown = 0;
  g.player.target = { x: x + 1, y: oy + 1, z, nx: 1, ny: 0, nz: 0, id: B.STONE_BUTTON, dist: 2 };
  window.__stand(x + 3.5, oy, z + 0.5, Math.PI / 2);
  const inp = g.player.deps.input, orig = inp.takeRightClick;
  inp.takeRightClick = () => { inp.takeRightClick = orig; return true; };
  window.__hold(0);
  g.player.updateRightClick(0.05);
  res.buttonOpens = w.doorStates.get(`${x},${oy},${z}`).open;
  // iron trapdoor + lever
  w.setBlock(x + 4, oy, z, B.IRON_TRAPDOOR);
  w.doorStates.set(`${x + 4},${oy},${z}`, { facing: 0, open: false, top: false });
  w.setBlock(x + 5, oy, z, B.LEVER);
  w.redstoneStates.set(`${x + 5},${oy},${z}`, { active: true, facing: 1 });
  g.triggerRedstoneUpdate(x + 5, oy, z);
  res.leverTrap = w.doorStates.get(`${x + 4},${oy},${z}`).open;
  g.audio.play = play;
  return res;
}, s);
console.log(JSON.stringify(red));
check('pressure plate opens an iron door (iron sound)', red.plateOpens && red.ironSound);
check('stepping off closes it', red.plateCloses);
check('a button beside the door opens it', red.buttonOpens);
check('a lever opens an iron trapdoor', red.leverTrap);
// the button springs back after ~1 s and the door shuts
await page.waitForTimeout(2500);
const shut = await page.evaluate(({ ox, oy, oz }) => window.__game.world.doorStates.get(`${ox + 20},${oy},${oz - 4}`).open, s);
check('the door shuts when the button pops out', shut === false);

// --- trapdoor placement, collision, raycast ---------------------------------------------
const trap = await page.evaluate(({ ox, oy, oz }) => {
  const g = window.__game, B = window.__B, w = g.world, p = g.player, res = {};
  const x = ox + 2, z = oz + 4;
  const st = (dx, dy = 0, dz = 0) => { const v = w.doorStates.get(`${x + dx},${oy + dy},${z + dz}`); return v && { facing: v.facing, top: !!v.top, open: v.open }; };
  window.__hold(B.TRAPDOOR);
  // on a floor, looking -z: bottom half, hinged on the far edge (facing +z = 2)
  window.__stand(x + 0.5, oy, z + 3.5);
  window.__click(x + 0.5, oy, z + 0.5);
  res.floor = st(0);
  // on the upper half of a wall's side face (wall at z-1... face +z)
  w.setBlock(x + 3, oy, z - 1, B.STONE); w.setBlock(x + 3, oy + 1, z - 1, B.STONE);
  window.__stand(x + 3.5, oy, z + 2.5);
  window.__click(x + 3.5, oy + 1.8, z);
  res.wallTop = st(3, 1);
  window.__click(x + 3.5, oy + 0.2, z);
  res.wallBottom = st(3, 0);
  // on a ceiling underside: top half
  w.setBlock(x + 6, oy + 2, z, B.STONE);
  window.__stand(x + 6.5, oy, z + 2.5);
  window.__click(x + 6.5, oy + 2, z + 0.5);
  res.ceiling = st(6, 1);
  // collision: stand on a closed bottom trapdoor
  const tx = x + 10;
  w.setBlock(tx, oy, z, B.TRAPDOOR); w.doorStates.set(`${tx},${oy},${z}`, { facing: 2, open: false, top: false });
  w.setBlock(tx + 2, oy + 1, z, B.TRAPDOOR); w.doorStates.set(`${tx + 2},${oy + 1},${z}`, { facing: 2, open: false, top: true });
  res.boxBottom = w.doorShape(tx, oy, z);
  res.boxTopOpen = (() => { w.doorStates.get(`${tx + 2},${oy + 1},${z}`).open = true; const b = w.doorShape(tx + 2, oy + 1, z); w.doorStates.get(`${tx + 2},${oy + 1},${z}`).open = false; return b; })();
  // raycast straight down through an open trapdoor reaches the floor below
  w.setBlock(tx + 4, oy, z, B.TRAPDOOR); w.doorStates.set(`${tx + 4},${oy},${z}`, { facing: 0, open: true, top: false });
  const hit = w.raycast(tx + 4.5, oy + 2.5, z + 0.3, 0, -1, 0, 6);
  res.rayThrough = hit && hit.y === oy - 1 && hit.id === B.STONE;
  const hit2 = w.raycast(tx + 4.5, oy + 2.5, z + 0.95, 0, -1, 0, 6);
  res.rayHitsLeaf = hit2 && hit2.y === oy && hit2.id === B.TRAPDOOR;
  return res;
}, s);
console.log(JSON.stringify(trap));
check('floor trapdoor: bottom half, hinged on the far edge', trap.floor && !trap.floor.top && trap.floor.facing === 2);
check('side face, upper half: top trapdoor hinged on the wall', trap.wallTop && trap.wallTop.top && trap.wallTop.facing === 2);
check('side face, lower half: bottom trapdoor', trap.wallBottom && !trap.wallBottom.top && trap.wallBottom.facing === 2);
check('ceiling trapdoor: top half', trap.ceiling && trap.ceiling.top);
check('closed bottom hatch is a 3/16 slab', JSON.stringify(trap.boxBottom) === JSON.stringify([0, 0, 0, 1, 0.1875, 1]));
check('open hatch stands on its hinge edge', trap.boxTopOpen && trap.boxTopOpen[2] === 0 && trap.boxTopOpen[5] === 0.1875);
check('a ray passes through the open part of a trapdoor', trap.rayThrough);
check('a ray still hits the open leaf', trap.rayHitsLeaf);

// stand on a closed trapdoor (physics), then walk through a doorway with the door open
const phys = await page.evaluate(async ({ ox, oy, oz }) => {
  const g = window.__game, p = g.player, w = g.world;
  const tx = ox + 12, z = oz + 4;
  window.__stand(tx + 0.5, oy + 1, z + 0.5);
  await new Promise((r) => setTimeout(r, 1500));
  return { y: p.pos.y };
}, s);
check('the player stands on a closed trapdoor', Math.abs(phys.y - (oy + 0.1875)) < 0.05, phys.y.toFixed(3));

// --- door pops without a floor; open trapdoor over a ladder climbs --------------------------
const misc = await page.evaluate(async ({ ox, oy, oz }) => {
  const g = window.__game, B = window.__B, w = g.world, p = g.player, res = {};
  const x = ox + 30, z = oz + 4;
  w.setBlock(x, oy - 1, z, B.DIRT);
  w.setBlock(x, oy, z, B.DOOR_LOWER); w.setBlock(x, oy + 1, z, B.DOOR_UPPER);
  w.doorStates.set(`${x},${oy},${z}`, { facing: 0, open: false, swing: 0 });
  w.setBlock(x, oy - 1, z, 0);
  await new Promise((r) => setTimeout(r, 600));
  res.gone = w.getBlock(x, oy, z) === 0 && w.getBlock(x, oy + 1, z) === 0;
  res.drop = g.entities.entities.filter((e) => e.kind === 'drop' && Math.hypot(e.pos.x - x - 0.5, e.pos.z - z - 0.5) < 1.5).map((e) => e.itemId);
  // ladder column with an open trapdoor on top
  const lx = x + 3;
  for (let dy = 0; dy < 3; dy++) w.setBlock(lx, oy + dy, z - 1, B.STONE);
  w.setBlock(lx, oy, z, B.LADDER); w.setBlock(lx, oy + 1, z, B.LADDER);
  w.setBlock(lx, oy + 2, z, B.TRAPDOOR); w.doorStates.set(`${lx},${oy + 2},${z}`, { facing: 0, open: true, top: false });
  window.__stand(lx + 0.5, oy + 2.05, z + 0.5);
  // a frame has to run first (slow under a loaded headless browser)
  res.onLadder = false;
  for (let i = 0; i < 30 && !res.onLadder; i++) { await new Promise((r) => setTimeout(r, 100)); res.onLadder = p.onLadder && p.pos.y > oy + 1.5; }
  return res;
}, s);
console.log(JSON.stringify(misc));
check('a door pops off when its floor is removed', misc.gone);
check('...and drops one door', misc.drop.length === 1 && misc.drop[0] === await page.evaluate(() => window.__findId('oak_door')), JSON.stringify(misc.drop));
check('an open trapdoor over a ladder is climbable', misc.onLadder);

// --- screenshots ----------------------------------------------------------------------
if (SHOTS) {
  await page.evaluate(({ ox, oy, oz }) => {
    const g = window.__game, B = window.__B, w = g.world;
    const z = oz - 10;
    const door = (dx, lo, up, st) => {
      w.setBlock(ox + dx, oy, z, lo); w.setBlock(ox + dx, oy + 1, z, up);
      w.doorStates.set(`${ox + dx},${oy},${z}`, { facing: 0, swing: st.open ? 1 : 0, ...st });
    };
    door(0, B.IRON_DOOR_LOWER, B.IRON_DOOR_UPPER, { open: false, hingeRight: false });
    door(2, B.IRON_DOOR_LOWER, B.IRON_DOOR_UPPER, { open: true, hingeRight: false });
    door(4, B.DOOR_LOWER, B.DOOR_UPPER, { open: false, hingeRight: false });
    door(5, B.DOOR_LOWER, B.DOOR_UPPER, { open: true, hingeRight: true });
    const trapRow = [
      [B.IRON_TRAPDOOR, { facing: 2, open: false, top: false }, 0],
      [B.IRON_TRAPDOOR, { facing: 2, open: false, top: true }, 0],
      [B.IRON_TRAPDOOR, { facing: 2, open: true, top: false }, 0],
      [B.TRAPDOOR, { facing: 1, open: true, top: false }, 0],
      [B.TRAPDOOR, { facing: 3, open: true, top: false }, 0],
      [B.CRIMSON_TRAPDOOR, { facing: 0, open: true, top: true }, 0],
    ];
    trapRow.forEach(([id, st], i) => {
      w.setBlock(ox + 8 + i * 2, oy, z, id);
      w.doorStates.set(`${ox + 8 + i * 2},${oy},${z}`, st);
    });
    g.dayTime = 0.3;
  }, s);
  await frame(ox + 9, oy + 0.8, oz - 10, ox + 9, oy + 3.2, oz - 4.5);
  await page.screenshot({ path: `${DIR}/door-vanilla-row.png` });
  await frame(ox + 1.5, oy + 1, oz - 10, ox + 1.5, oy + 1.8, oz - 7);
  await page.screenshot({ path: `${DIR}/door-vanilla-iron.png` });
  await frame(ox + 13, oy + 0.3, oz - 10, ox + 13, oy + 2.5, oz - 7.5);
  await page.screenshot({ path: `${DIR}/door-vanilla-traps.png` });
  await page.evaluate(() => {
    const g = window.__game, B = window.__B;
    const ids = [B.IRON_DOOR_LOWER, B.IRON_TRAPDOOR, window.__findId('iron_door'), B.TRAPDOOR, window.__findId('oak_door')];
    const c = document.createElement('canvas'); c.width = ids.length * 36; c.height = 36;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#8b8b8b'; ctx.fillRect(0, 0, c.width, c.height);
    ids.forEach((id, i) => ctx.drawImage(g.atlas.icon(id), i * 36 + 2, 2));
    c.id = 'icon-sheet';
    Object.assign(c.style, { position: 'fixed', left: '10px', top: '10px', zIndex: 99999, transform: 'scale(4)', transformOrigin: '0 0', imageRendering: 'pixelated' });
    document.body.appendChild(c);
  });
  await page.waitForTimeout(200);
  await page.locator('#icon-sheet').screenshot({ path: `${DIR}/door-vanilla-icons.png` });
}

console.log('--- console errors ---');
console.log(errors.length ? errors.slice(0, 8).join('\n') : 'NONE');
console.log(errors.length || failures.length ? 'SOME CHECKS FAILED' : 'ALL CHECKS PASS');
await browser.close();
await server.close();
process.exit(errors.length || failures.length ? 1 : 0);
