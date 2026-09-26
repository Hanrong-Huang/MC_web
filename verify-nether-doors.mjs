// Crimson/warped doors + trapdoors next to the oak ones on the y=108 platform:
// closed/open, both hinges, a double door, trapdoors closed/open (day + night
// shots), the icon sheet and held models; then asserts for placing a door from
// the item (both halves + state), opening it by hand, double doors swinging
// together, collision, a pressure plate driving a nether door + trapdoor,
// breaking one (drops its own item), and the recipe book filling each wood's
// recipe only from that wood's planks. Screenshots go to $SHOT_DIR.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const PORT = +(process.env.PORT ?? 5253);
const DIR = process.env.SHOT_DIR ?? '.';
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
await page.waitForTimeout(4000);
await page.waitForLoadState('networkidle', { timeout: 180000 });
await page.locator('.mode-pick button', { hasText: 'Creative' }).click({ timeout: 120000 });
await page.locator('.create-btn').click({ timeout: 120000, noWaitAfter: true });
await page.waitForSelector('#loading.hidden', { timeout: 180000, state: 'attached' });
await page.waitForTimeout(2500);
await page.mouse.click(640, 360);
await page.waitForTimeout(300);

const failures = [];
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${info}`); if (!ok) failures.push(name); };

/** Park the camera at an eye position looking at a target and wait for the
 *  chunks around the target to be generated and meshed. */
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

// --- 1. showcase ------------------------------------------------------------------
// z=0 row: per wood, closed hinge-left / closed hinge-right / open hinge-left /
// open hinge-right, then a double door (open); z=5 row: trapdoors closed + open.
const s = await page.evaluate(() => {
  const g = window.__game, p = g.player, B = window.__B, w = g.world;
  const ox = Math.floor(p.pos.x), oy = 108, oz = Math.floor(p.pos.z);
  for (let dx = -4; dx <= 40; dx++) {
    for (let dz = -10; dz <= 12; dz++) {
      w.setBlock(ox + dx, oy - 1, oz + dz, B.STONE);
      for (let dy = 0; dy <= 8; dy++) w.setBlock(ox + dx, oy + dy, oz + dz, 0);
    }
  }
  for (const e of g.entities.entities) if (g.entities.isMob(e)) e.dead = true;
  const door = (x, z, lower, upper, st) => {
    w.setBlock(ox + x, oy, oz + z, lower);
    w.setBlock(ox + x, oy + 1, oz + z, upper);
    w.doorStates.set(`${ox + x},${oy},${oz + z}`, { facing: 0, swing: st.open ? 1 : 0, ...st });
  };
  const woods = [
    [B.DOOR_LOWER, B.DOOR_UPPER, B.TRAPDOOR],
    [B.CRIMSON_DOOR_LOWER, B.CRIMSON_DOOR_UPPER, B.CRIMSON_TRAPDOOR],
    [B.WARPED_DOOR_LOWER, B.WARPED_DOOR_UPPER, B.WARPED_TRAPDOOR],
  ];
  woods.forEach(([lo, up, trap], i) => {
    const x0 = i * 11;
    door(x0, 0, lo, up, { open: false, hingeRight: false });
    door(x0 + 2, 0, lo, up, { open: false, hingeRight: true });
    door(x0 + 4, 0, lo, up, { open: true, hingeRight: false });
    door(x0 + 6, 0, lo, up, { open: true, hingeRight: true });
    // double door: left leaf hinge-left, right leaf hinge-right, both open
    door(x0 + 8, 0, lo, up, { open: true, hingeRight: false });
    door(x0 + 9, 0, lo, up, { open: true, hingeRight: true });
    // stone wall behind the doors so the cut-outs read
    for (let dx = -1; dx <= 10; dx++) for (let dy = 0; dy <= 3; dy++) w.setBlock(ox + x0 + dx, oy + dy, oz + 3, B.STONE_BRICKS);
    // trapdoors: two closed on the floor, two open
    for (let k = 0; k < 4; k++) {
      w.setBlock(ox + x0 + k * 2, oy, oz + 6, trap);
      w.doorStates.set(`${ox + x0 + k * 2},${oy},${oz + 6}`, { facing: 0, open: k >= 2 });
    }
  });
  p.flying = true; p.vel = { x: 0, y: 0, z: 0 };
  g.dayTime = 0.12;
  return { ox, oy, oz };
});
const { ox, oy, oz } = s;
if (!process.env.NO_SHOTS) { // NO_SHOTS=1 runs only the asserts
await frame(ox + 15, oy + 1, oz + 1, ox + 15, oy + 6, oz - 13, 2);
await page.screenshot({ path: `${DIR}/doors-overview.png` });
for (const [i, name] of [[0, 'oak'], [1, 'crimson'], [2, 'warped']]) {
  const x0 = ox + i * 11;
  await frame(x0 + 5, oy + 1, oz + 0.5, x0 + 5, oy + 2.2, oz - 6.5);
  await page.screenshot({ path: `${DIR}/doors-${name}.png` });
}
// close-ups of the nether leaves (holes show the wall behind)
for (const [i, name] of [[1, 'crimson'], [2, 'warped']]) {
  const x0 = ox + i * 11;
  await frame(x0 + 1.5, oy + 1, oz + 0.5, x0 + 1.5, oy + 1.6, oz - 3.2);
  await page.screenshot({ path: `${DIR}/doors-${name}-close.png` });
}
// trapdoors (closed pair + open pair per wood) from behind the wall
await frame(ox + 15, oy + 0.5, oz + 6.5, ox + 15, oy + 5, oz + 12.5, 2);
await page.screenshot({ path: `${DIR}/doors-trapdoors.png` });
await frame(ox + 14, oy + 0.5, oz + 6.5, ox + 12.5, oy + 2.4, oz + 9.5, 1);
await page.screenshot({ path: `${DIR}/doors-trapdoors-close.png` });
await frame(ox + 14, oy + 0.5, oz + 6.5, ox + 14, oy + 2.2, oz + 4.2, 1);
await page.screenshot({ path: `${DIR}/doors-trapdoors-front.png` });
await frame(ox + 14, oy, oz + 6.5, ox + 14, oy + 7, oz + 8, 1);
await page.screenshot({ path: `${DIR}/doors-trapdoors-top.png` });
// night: torch-lit
await page.evaluate(({ ox, oy, oz }) => {
  const g = window.__game, B = window.__B;
  g.dayTime = 0.62;
  for (const x of [3, 14, 25]) g.world.setBlock(ox + x, oy, oz - 2, B.TORCH);
}, s);
await frame(ox + 15, oy + 1, oz + 1, ox + 15, oy + 6, oz - 13, 2);
await page.screenshot({ path: `${DIR}/doors-night.png` });
await page.evaluate(() => { window.__game.dayTime = 0.12; });

// --- 2. icons + held models ----------------------------------------------------------
await page.evaluate(() => {
  const g = window.__game, B = window.__B, I = { WOOD: window.__findId('oak_door'), C: window.__findId('crimson_door'), W: window.__findId('warped_door') };
  const ids = [I.WOOD, I.C, I.W, B.TRAPDOOR, B.CRIMSON_TRAPDOOR, B.WARPED_TRAPDOOR, B.CRIMSON_PLANKS, B.WARPED_PLANKS];
  const cols = 8;
  const c = document.createElement('canvas');
  c.width = cols * 36; c.height = Math.ceil(ids.length / cols) * 36;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#8b8b8b'; ctx.fillRect(0, 0, c.width, c.height);
  ids.forEach((id, i) => {
    ctx.fillStyle = '#6f6f6f'; ctx.fillRect((i % cols) * 36 + 1, Math.floor(i / cols) * 36 + 1, 34, 34);
    ctx.drawImage(g.atlas.icon(id), (i % cols) * 36 + 2, Math.floor(i / cols) * 36 + 2);
  });
  c.id = 'icon-sheet';
  Object.assign(c.style, { position: 'fixed', left: '10px', top: '10px', zIndex: 99999, transform: 'scale(3)', transformOrigin: '0 0', imageRendering: 'pixelated' });
  document.body.appendChild(c);
});
await page.waitForTimeout(200);
await page.locator('#icon-sheet').screenshot({ path: `${DIR}/doors-icons.png` });
await page.evaluate(() => document.getElementById('icon-sheet')?.remove());
await frame(ox + 15, oy + 6, oz - 30, ox + 15, oy + 7, oz - 20);
for (const name of ['crimson_door', 'warped_door', 'crimson_trapdoor', 'warped_trapdoor']) {
  await page.evaluate((name) => {
    const g = window.__game, p = g.player;
    p.inventory.slots[0] = { id: window.__findId(name), count: 1 };
    p.inventory.selected = 0; g.onInventoryChange();
  }, name);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${DIR}/doors-held-${name}.png`, clip: { x: 640, y: 300, width: 640, height: 420 } });
}
}

// --- 3. behaviour through the player ---------------------------------------------------
const beh = await page.evaluate(({ ox, oy, oz }) => {
  const g = window.__game, p = g.player, B = window.__B, w = g.world;
  const res = {};
  const x = ox + 36, z = oz - 6; // clear floor, away from the showcase
  /** Right-click with the selected item, aiming at the centre of one face of
   *  a block (n = face normal; default the top face, for placing on a floor). */
  const rightClick = (tx, ty, tz, n = [0, 1, 0]) => {
    const ey = p.pos.y + p.eyeHeight();
    const dx = tx + 0.5 + n[0] * 0.49 - p.pos.x, dy = ty + 0.5 + n[1] * 0.49 - ey, dz = tz + 0.5 + n[2] * 0.49 - p.pos.z;
    const len = Math.hypot(dx, dy, dz);
    p.target = w.raycast(p.pos.x, ey, p.pos.z, dx / len, dy / len, dz / len, 6);
    const inp = p.deps.input, orig = inp.takeRightClick;
    inp.takeRightClick = () => { inp.takeRightClick = orig; return true; };
    p.placeCooldown = 0;
    p.updateRightClick(0.05);
    inp.takeRightClick = orig;
    return p.target && [p.target.x, p.target.y, p.target.z];
  };
  p.flying = false; p.mode = 'creative';
  p.pos.x = x + 0.5; p.pos.y = oy; p.pos.z = z + 3.5; p.yaw = 0; p.pitch = -0.4; // facing -z
  p.inventory.slots[0] = { id: window.__findId('crimson_door'), count: 4 }; p.inventory.selected = 0;
  res.target = rightClick(x, oy - 1, z); // top face of the floor at (x, z)
  res.placedLower = w.getBlock(x, oy, z) === B.CRIMSON_DOOR_LOWER;
  res.placedUpper = w.getBlock(x, oy + 1, z) === B.CRIMSON_DOOR_UPPER;
  const st = w.doorStates.get(`${x},${oy},${z}`);
  res.state = st ? { facing: st.facing, open: st.open, hingeRight: !!st.hingeRight } : null;
  res.closedBlocks = w.isDoorClosed(x, oy, z) && w.isDoorClosed(x, oy + 1, z);
  // second door beside it pairs up (opposite hinge)
  rightClick(x + 1, oy - 1, z);
  const st2 = w.doorStates.get(`${x + 1},${oy},${z}`);
  res.pairHinge = !!st && !!st2 && !!st2.hingeRight !== !!st.hingeRight;
  res.partner = !!st && !!w.doorPartner(x, oy, z, st);
  // open by hand on the UPPER half: both leaves swing open
  p.inventory.slots[0] = null;
  rightClick(x, oy + 1, z, [0, 0, 0]);
  res.openedByHand = w.doorStates.get(`${x},${oy},${z}`)?.open === true;
  res.pairOpened = w.doorStates.get(`${x + 1},${oy},${z}`)?.open === true;
  // warped trapdoor: place on the floor, toggle
  p.inventory.slots[0] = { id: B.WARPED_TRAPDOOR, count: 4 };
  rightClick(x + 3, oy - 1, z);
  res.trapPlaced = w.getBlock(x + 3, oy, z) === B.WARPED_TRAPDOOR && !!w.doorStates.get(`${x + 3},${oy},${z}`);
  p.inventory.slots[0] = null;
  rightClick(x + 3, oy, z);
  res.trapOpened = w.isTrapdoorOpen(x + 3, oy, z);
  // break the crimson door's upper half in survival: both halves go, one crimson door drops
  const before = g.entities.entities.length;
  p.mode = 'survival';
  p.breakBlock(x, oy + 1, z, true);
  p.mode = 'creative';
  const drops = g.entities.entities.slice(before).filter((e) => e.kind === 'drop').map((e) => e.itemId);
  res.brokeBoth = w.getBlock(x, oy, z) === 0 && w.getBlock(x, oy + 1, z) === 0 && !w.doorStates.has(`${x},${oy},${z}`);
  res.drops = drops;
  res.dropOk = drops.length === 1 && drops[0] === window.__findId('crimson_door');
  // redstone: a pressure plate beside a warped door and a crimson trapdoor
  const dx = x + 6;
  w.setBlock(dx, oy, z, B.WARPED_DOOR_LOWER); w.setBlock(dx, oy + 1, z, B.WARPED_DOOR_UPPER);
  w.doorStates.set(`${dx},${oy},${z}`, { facing: 0, open: false, swing: 0 });
  w.setBlock(dx + 2, oy, z, B.CRIMSON_TRAPDOOR);
  w.doorStates.set(`${dx + 2},${oy},${z}`, { facing: 0, open: false });
  w.setBlock(dx + 1, oy, z, B.PRESSURE_PLATE);
  w.redstoneStates.set(`${dx + 1},${oy},${z}`, { active: true, facing: 1 });
  g.triggerRedstoneUpdate(dx + 1, oy, z);
  res.plateOpensDoor = w.doorStates.get(`${dx},${oy},${z}`).open === true;
  res.plateOpensTrap = w.doorStates.get(`${dx + 2},${oy},${z}`).open === true;
  w.redstoneStates.get(`${dx + 1},${oy},${z}`).active = false;
  g.triggerRedstoneUpdate(dx + 1, oy, z);
  res.plateClosesDoor = w.doorStates.get(`${dx},${oy},${z}`).open === false;
  res.plateClosesTrap = w.doorStates.get(`${dx + 2},${oy},${z}`).open === false;
  p.flying = true;
  return res;
}, s);
console.log(JSON.stringify(beh));
check('crimson door item places both crimson halves', beh.placedLower && beh.placedUpper);
check('placed door has state (closed, facing player)', !!beh.state && beh.state.open === false, JSON.stringify(beh.state));
check('closed nether door blocks movement', beh.closedBlocks);
check('second door pairs with opposite hinge', beh.pairHinge && beh.partner);
check('opening the upper half opens the door', beh.openedByHand);
check('double nether doors swing together', beh.pairOpened);
check('warped trapdoor places + toggles', beh.trapPlaced && beh.trapOpened);
check('breaking a nether door removes both halves', beh.brokeBoth);
check('broken crimson door drops one crimson door', beh.dropOk, JSON.stringify(beh.drops));
check('pressure plate opens a warped door + crimson trapdoor', beh.plateOpensDoor && beh.plateOpensTrap);
check('releasing the plate closes them', beh.plateClosesDoor && beh.plateClosesTrap);

// walk into a closed crimson door: blocked; open: passes
const walk = await page.evaluate(async ({ ox, oy, oz }) => {
  const g = window.__game, p = g.player, B = window.__B, w = g.world;
  const x = ox + 36, z = oz + 6;
  w.setBlock(x, oy, z, B.CRIMSON_DOOR_LOWER); w.setBlock(x, oy + 1, z, B.CRIMSON_DOOR_UPPER);
  w.doorStates.set(`${x},${oy},${z}`, { facing: 0, open: false, swing: 0 });
  for (let dx = -2; dx <= 2; dx++) if (dx) for (let dy = 0; dy < 3; dy++) w.setBlock(x + dx, oy + dy, z, B.STONE);
  // walk -z for up to 6 s (a loaded machine runs the sim slowly), stopping early once through
  const run = async () => {
    p.flying = false; p.vel = { x: 0, y: 0, z: 0 };
    p.pos.x = x + 0.5; p.pos.y = oy; p.pos.z = z + 2.5; p.yaw = 0; p.pitch = 0;
    const inp = p.deps.input;
    const was = inp.keys ? new Set(inp.keys) : null;
    inp.keys?.add?.('KeyW');
    for (let t = 0; t < 60 && p.pos.z > z - 0.5; t++) await new Promise((r) => setTimeout(r, 100));
    if (was) { inp.keys.clear(); for (const k of was) inp.keys.add(k); }
    return p.pos.z;
  };
  const zClosed = await run();
  w.toggleDoor(x, oy, z);
  await new Promise((r) => setTimeout(r, 400));
  const zOpen = await run();
  p.flying = true;
  return { z, zClosed, zOpen, hasKeys: !!p.deps.input.keys };
}, s);
console.log(JSON.stringify(walk));
if (walk.hasKeys) {
  check('closed crimson door stops the player', walk.zClosed > walk.z + 0.9, `${walk.zClosed.toFixed(2)} vs door z ${walk.z}`);
  check('open crimson door lets the player through', walk.zOpen < walk.z + 0.9, walk.zOpen.toFixed(2));
}

// --- 4. recipe book: each wood's recipe fills only from its own planks -------------------------
const book = await page.evaluate(async () => {
  const g = window.__game, p = g.player, B = window.__B, hud = g.hud;
  const Inv = await import('/src/engine/Inventory.ts');
  const recipes = Inv.allRecipes();
  const view = () => ({ kind: 'table', craftW: 3, craftGrid: new Array(9).fill(null), furnace: null, chest: null, trades: [] });
  const inv = p.inventory;
  const stock = (list) => { inv.slots.fill(null); list.forEach(([id, n], i) => { inv.slots[i] = { id, count: n }; }); };
  const find = (out) => recipes.find((r) => r.out === out);
  const tryFill = (out) => {
    const v = view();
    const r = find(out);
    const ok = hud.fillRecipe(r, v, inv);
    const m = Inv.matchRecipe(v.craftGrid, 3);
    const grid = v.craftGrid.filter(Boolean).map((sl) => sl.id);
    hud.returnCraftGrid(v, inv);
    return { ok, made: m?.id ?? 0, grid: [...new Set(grid)] };
  };
  const res = {};
  stock([[B.CRIMSON_PLANKS, 64], [window.__findId('stick'), 16]]);
  res.oakSlabReady = hud.canFillRecipe(find(B.OAK_SLAB), inv, 3);
  res.oakSlab = tryFill(B.OAK_SLAB);
  res.oakStairs = tryFill(B.OAK_STAIRS);
  res.oakDoor = tryFill(window.__findId('oak_door'));
  res.oakFence = tryFill(B.OAK_FENCE);
  res.crimsonSlab = tryFill(B.CRIMSON_SLAB);
  res.crimsonDoor = tryFill(window.__findId('crimson_door'));
  res.crimsonTrap = tryFill(B.CRIMSON_TRAPDOOR);
  res.chest = tryFill(B.CHEST);
  res.sticks = tryFill(window.__findId('stick'));
  // oak planks only: the crimson recipe is not craftable, oak is
  stock([[B.PLANKS, 64], [window.__findId('stick'), 16]]);
  res.crimsonReadyWithOak = hud.canFillRecipe(find(B.CRIMSON_SLAB), inv, 3);
  res.oakSlabWithOak = tryFill(B.OAK_SLAB);
  // a chest from 5 oak + 3 warped still crafts (mixed planks are fine for generic recipes)
  stock([[B.PLANKS, 5], [B.WARPED_PLANKS, 3]]);
  res.mixedChest = tryFill(B.CHEST);
  // plenty of each: a chest comes out of a single wood
  stock([[B.PLANKS, 5], [B.WARPED_PLANKS, 8]]);
  res.singleWoodChest = tryFill(B.CHEST);
  inv.slots.fill(null); g.onInventoryChange();
  return res;
});
console.log(JSON.stringify(book));
check('book: oak slab not craftable from crimson planks', book.oakSlabReady === false && !book.oakSlab.ok);
check('book: oak stairs/door/fence not filled from crimson planks', !book.oakStairs.ok && !book.oakDoor.ok && !book.oakFence.ok);
check('book: crimson slab/door/trapdoor fill with crimson planks', book.crimsonSlab.ok && book.crimsonSlab.made === 260 &&
  book.crimsonDoor.ok && book.crimsonTrap.ok && book.crimsonTrap.made === 272);
check('book: generic recipes take crimson planks', book.chest.ok && book.sticks.ok);
check('book: crimson recipe needs crimson planks', book.crimsonReadyWithOak === false);
check('book: oak slab from oak planks', book.oakSlabWithOak.ok && book.oakSlabWithOak.made === 222);
check('book: mixed-plank chest', book.mixedChest.ok && book.mixedChest.grid.length === 2);
check('book: chest prefers one wood', book.singleWoodChest.ok && book.singleWoodChest.grid.length === 1);

console.log('--- console errors ---');
console.log(errors.length ? errors.slice(0, 8).join('\n') : 'NONE');
await browser.close();
await server.close();
process.exit(errors.length || failures.length ? 1 : 0);
