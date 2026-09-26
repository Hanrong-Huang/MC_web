// Redstone engine (src/engine/Redstone.ts) on the y=108 platform: a button on
// the wall beside a door (power through a block), button timing (stone 1 s /
// wood 1.5 s), a lever powering a lamp through a block, dust fall-off, torch
// inverters, repeater delay, stone vs oak pressure plates, note blocks (pitch,
// instrument, rising edge, muffled), parts popping off, a big dust grid's
// update time, the save carrying repeater delay + note pitch, comparators
// (container fill, reading through a block, compare vs subtract, side inputs),
// observers (a pulse per change, an observer clock) and daylight detectors
// (day/night, inverted). Screenshots
// (unless NO_SHOTS=1) of a small circuit by day and night go to $SHOT_DIR.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const PORT = +(process.env.PORT ?? 5271);
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

// platform + helpers on window
const s = await page.evaluate(() => {
  const g = window.__game, p = g.player, B = window.__B, w = g.world;
  const ox = Math.floor(p.pos.x), oy = 108, oz = Math.floor(p.pos.z);
  for (let dx = -6; dx <= 44; dx++) {
    for (let dz = -14; dz <= 62; dz++) {
      w.setBlock(ox + dx, oy - 1, oz + dz, B.STONE);
      for (let dy = 0; dy <= 6; dy++) w.setBlock(ox + dx, oy + dy, oz + dz, 0);
    }
  }
  for (const e of g.entities.entities) if (g.entities.isMob(e)) e.dead = true;
  p.flying = true; p.pos.x = ox - 4; p.pos.y = oy + 20; p.pos.z = oz - 10; // out of the way (and off every plate)
  const k = (x, y, z) => `${x},${y},${z}`;
  window.__rs = {
    k,
    set: (x, y, z, id, st) => { if (st) w.redstoneStates.set(k(x, y, z), st); w.setBlock(x, y, z, id); },
    state: (x, y, z) => w.redstoneStates.get(k(x, y, z)),
    tick: () => g.redstone.tickNo,
    /** press/flip a part the way the player's right-click does */
    press: (x, y, z) => {
      const id = w.getBlock(x, y, z);
      const st = w.redstoneStates.get(k(x, y, z)) ?? { active: false };
      if (id === B.LEVER) st.active = !st.active;
      else { st.active = true; st.ticksLeft = id === B.WOODEN_BUTTON ? 30 : 20; }
      w.redstoneStates.set(k(x, y, z), st);
      g.triggerRedstoneUpdate(x, y, z);
    },
  };
  return { ox, oy, oz };
});
const { ox, oy, oz } = s;
/** wait until fn() (evaluated in the page) is truthy or the timeout passes; returns engine ticks waited */
async function ticksUntil(fn, arg, timeout = 8000) {
  const t0 = await page.evaluate(() => window.__rs.tick());
  const t1 = await page.waitForFunction(fn, arg, { timeout, polling: 16 }).then(() => page.evaluate(() => window.__rs.tick())).catch(() => null);
  return t1 === null ? null : t1 - t0;
}

// --- 1. a button on the wall beside a door opens it (power through the wall block) ---------
const door = await page.evaluate(({ ox, oy, oz }) => {
  const g = window.__game, B = window.__B, w = g.world, rs = window.__rs;
  const res = {};
  for (const [i, btn] of [[0, B.STONE_BUTTON], [1, B.WOODEN_BUTTON]]) {
    const x = ox + i * 6, z = oz;
    for (const dx of [-1, 1]) for (let dy = 0; dy < 3; dy++) w.setBlock(x + dx, oy + dy, z, B.STONE);
    w.setBlock(x, oy + 2, z, B.STONE);
    rs.set(x, oy, z, B.DOOR_LOWER, null); w.setBlock(x, oy + 1, z, B.DOOR_UPPER);
    w.doorStates.set(rs.k(x, oy, z), { facing: 0, open: false, hingeRight: false, swing: 0 });
    // button on the front (+z) face of the wall block right of the door, at head height
    rs.set(x + 1, oy + 1, z + 1, btn, { active: false, facing: 3 });
    rs.press(x + 1, oy + 1, z + 1);
    res[`open${i}`] = w.doorStates.get(rs.k(x, oy, z)).open;
  }
  return res;
}, s);
check('stone button on the wall opens the door beside it', door.open0 === true);
check('wooden button on the wall opens the door beside it', door.open1 === true);
const stoneT = await ticksUntil(({ ox, oy, oz }) => !window.__game.world.doorStates.get(`${ox},${oy},${oz}`).open, s);
const woodT = await ticksUntil(({ ox, oy, oz }) => !window.__game.world.doorStates.get(`${ox + 6},${oy},${oz}`).open, s);
check('stone button: door shuts after ~1 s (20 ticks)', stoneT !== null && stoneT >= 15 && stoneT <= 24, `${stoneT}`);
// both were pressed together: the wooden one's wait continues from the stone one's
const woodTotal = stoneT !== null && woodT !== null ? stoneT + woodT : null;
check('wooden button: door shuts after ~1.5 s (30 ticks)', woodTotal !== null && woodTotal >= 25 && woodTotal <= 36, `${woodTotal}`);

// --- 2. lever through a block, dust fall-off, torch inverter, redstone block -----------------
const logic = await page.evaluate(({ ox, oy, oz }) => {
  const g = window.__game, B = window.__B, w = g.world, rs = window.__rs, res = {};
  // lever on the -x face of a stone block, lamp on its +x side
  let x = ox, z = oz + 6;
  w.setBlock(x + 1, oy, z, B.STONE);
  rs.set(x, oy, z, B.LEVER, { active: false, facing: 4 }); // hangs on the block at x+1
  w.setBlock(x + 2, oy, z, B.REDSTONE_LAMP);
  rs.press(x, oy, z);
  res.lampThroughBlock = w.getBlock(x + 2, oy, z) === B.REDSTONE_LAMP_LIT;
  rs.press(x, oy, z);
  res.lampOffAgain = w.getBlock(x + 2, oy, z) === B.REDSTONE_LAMP;
  // dust line of 16 from a lever
  z = oz + 9;
  rs.set(x, oy, z, B.LEVER, { active: false, facing: 1 });
  for (let i = 1; i <= 16; i++) w.setBlock(x + i, oy, z, B.REDSTONE_WIRE);
  w.setBlock(x + 17, oy, z, B.REDSTONE_LAMP); // after the 16th dust (power 0)
  // a second line of 15 ending in a lamp (the 15th dust carries power 1)
  rs.set(x, oy, z - 2, B.LEVER, { active: false, facing: 1 });
  for (let i = 1; i <= 15; i++) w.setBlock(x + i, oy, z - 2, B.REDSTONE_WIRE);
  w.setBlock(x + 16, oy, z - 2, B.REDSTONE_LAMP);
  rs.press(x, oy, z - 2);
  rs.press(x, oy, z);
  res.levels = [1, 2, 8, 14, 15, 16].map((i) => w.redstonePower.get(rs.k(x + i, oy, z)) ?? 0);
  res.lamp15 = w.getBlock(x + 16, oy, z - 2) === B.REDSTONE_LAMP_LIT;
  res.lamp16 = w.getBlock(x + 17, oy, z) === B.REDSTONE_LAMP;
  rs.press(x, oy, z);
  res.levelsOff = [1, 8, 15].map((i) => w.redstonePower.get(rs.k(x + i, oy, z)) ?? 0);
  // redstone block lights a lamp; dust climbs a block step
  z = oz + 12;
  w.setBlock(x, oy, z, B.REDSTONE_BLOCK); w.setBlock(x + 1, oy, z, B.REDSTONE_LAMP);
  res.blockLamp = w.getBlock(x + 1, oy, z) === B.REDSTONE_LAMP_LIT;
  w.setBlock(x + 3, oy, z, B.REDSTONE_BLOCK);
  w.setBlock(x + 4, oy, z, B.REDSTONE_WIRE);
  w.setBlock(x + 5, oy, z, B.STONE); w.setBlock(x + 5, oy + 1, z, B.REDSTONE_WIRE);
  w.setBlock(x + 6, oy + 1, z, B.STONE); w.setBlock(x + 6, oy + 2, z, B.REDSTONE_WIRE);
  res.climb = [w.redstonePower.get(rs.k(x + 4, oy, z)) ?? 0, w.redstonePower.get(rs.k(x + 5, oy + 1, z)) ?? 0, w.redstonePower.get(rs.k(x + 6, oy + 2, z)) ?? 0];
  return res;
}, s);
console.log(JSON.stringify(logic));
check('a lever on a block lights a lamp on its far side', logic.lampThroughBlock && logic.lampOffAgain);
check('dust falls off one level per block', JSON.stringify(logic.levels) === JSON.stringify([15, 14, 8, 2, 1, 0]), JSON.stringify(logic.levels));
check('the 15th dust still lights a lamp, the 16th does not', logic.lamp15 && logic.lamp16, `${logic.lamp15} ${logic.lamp16}`);
check('switching the lever off drains the line', logic.levelsOff.every((v) => v === 0));
check('a block of redstone powers a lamp', logic.blockLamp);
check('dust climbs block steps', JSON.stringify(logic.climb) === JSON.stringify([15, 14, 13]), JSON.stringify(logic.climb));

// torch inverter: lever on a block, a torch on the block's other side, lamp next to the torch
await page.evaluate(({ ox, oy, oz }) => {
  const g = window.__game, B = window.__B, w = g.world, rs = window.__rs;
  const x = ox + 20, z = oz + 6;
  w.setBlock(x + 1, oy, z, B.STONE);
  rs.set(x, oy, z, B.LEVER, { active: false, facing: 4 });
  w.torchFacings.set(rs.k(x + 2, oy, z), 0); // wall torch on the +x face of the stone (wall at x-1)
  w.setBlock(x + 2, oy, z, B.REDSTONE_TORCH);
  w.setBlock(x + 3, oy, z, B.REDSTONE_LAMP);
  g.triggerRedstoneUpdate(x + 2, oy, z);
}, s);
await page.waitForTimeout(300);
const inv0 = await page.evaluate(({ ox, oy, oz }) => window.__game.world.getBlock(ox + 23, oy, oz + 6), s);
check('a lit redstone torch powers the lamp beside it', inv0 === (await page.evaluate(() => window.__B.REDSTONE_LAMP_LIT)));
await page.evaluate(({ ox, oy, oz }) => window.__rs.press(ox + 20, oy, oz + 6), s);
const invT = await ticksUntil(({ ox, oy, oz }) => window.__game.world.getBlock(ox + 22, oy, oz + 6) === window.__B.REDSTONE_TORCH_OFF, s);
const lampOff = await page.evaluate(({ ox, oy, oz }) => window.__game.world.getBlock(ox + 23, oy, oz + 6) === window.__B.REDSTONE_LAMP, s);
check('powering the torch\'s block turns it off one redstone tick later', invT !== null && invT >= 1 && invT <= 5, `${invT}`);
check('...and its lamp goes dark', lampOff);

// repeater delay: lever -> dust -> repeater (4 ticks = 8 game ticks) -> lamp
await page.evaluate(({ ox, oy, oz }) => {
  const g = window.__game, B = window.__B, w = g.world, rs = window.__rs;
  const x = ox + 20, z = oz + 10;
  rs.set(x, oy, z, B.LEVER, { active: false, facing: 1 });
  w.setBlock(x + 1, oy, z, B.REDSTONE_WIRE);
  rs.set(x + 2, oy, z, B.REPEATER, { active: false, facing: 3, delay: 1 });
  for (let i = 0; i < 3; i++) g.redstone.use(x + 2, oy, z, B.REPEATER); // 1 -> 4
  w.setBlock(x + 3, oy, z, B.REDSTONE_LAMP);
  rs.press(x, oy, z);
}, s);
const repT = await ticksUntil(({ ox, oy, oz }) => window.__game.world.getBlock(ox + 23, oy, oz + 10) === window.__B.REDSTONE_LAMP_LIT, s);
const delay = await page.evaluate(({ ox, oy, oz }) => window.__rs.state(ox + 22, oy, oz + 10)?.delay, s);
check('right-clicking a repeater cycles its delay', delay === 4);
check('a 4-tick repeater lights its lamp 8 game ticks later', repT !== null && repT >= 7 && repT <= 11, `${repT}`);

// --- 3. plates: stone ignores items, oak takes them; mobs press both ---------------------------
await page.evaluate(({ ox, oy, oz }) => {
  const g = window.__game, B = window.__B, w = g.world, rs = window.__rs;
  const z = oz + 16;
  w.setBlock(ox, oy, z, B.PRESSURE_PLATE); w.setBlock(ox, oy, z + 1, B.REDSTONE_LAMP);
  w.setBlock(ox + 4, oy, z, B.STONE_PRESSURE_PLATE); w.setBlock(ox + 4, oy, z + 1, B.REDSTONE_LAMP);
  g.entities.spawnDrop(ox + 0.5, oy + 0.2, z + 0.5, B.DIRT, 1);
  g.entities.spawnDrop(ox + 4.5, oy + 0.2, z + 0.5, B.DIRT, 1);
}, s);
await page.waitForTimeout(1200);
const plates = await page.evaluate(({ ox, oy, oz }) => {
  const w = window.__game.world, rs = window.__rs;
  return { oak: !!rs.state(ox, oy, oz + 16)?.active, stone: !!rs.state(ox + 4, oy, oz + 16)?.active,
    oakLamp: w.getBlock(ox, oy, oz + 17) === window.__B.REDSTONE_LAMP_LIT };
}, s);
check('an item presses the oak plate (and lights its lamp)', plates.oak && plates.oakLamp);
check('an item does not press the stone plate', plates.stone === false);
await page.evaluate(({ ox, oy, oz }) => { const g = window.__game; g.entities.spawnMob('pig', ox + 4.5, oy, oz + 16.5); }, s);
await page.waitForTimeout(800);
const stoneMob = await page.evaluate(({ ox, oy, oz }) => !!window.__rs.state(ox + 4, oy, oz + 16)?.active, s);
check('a mob presses the stone plate', stoneMob);

// --- 4. note blocks ---------------------------------------------------------------------------
const notes = await page.evaluate(({ ox, oy, oz }) => {
  const g = window.__game, B = window.__B, w = g.world, rs = window.__rs, res = {};
  const heard = [];
  const orig = g.audio.noteBlock.bind(g.audio);
  g.audio.noteBlock = (inst, pitch, vol) => { heard.push([inst, pitch]); return orig(inst, pitch, vol); };
  const x = ox + 30, z = oz + 16;
  g.player.pos.x = x + 5; g.player.pos.y = oy + 3; g.player.pos.z = z - 5; // note blocks carry 48 blocks
  const under = [B.STONE, B.PLANKS, B.GOLD_BLOCK, B.SAND, B.GLASS, B.DIRT];
  under.forEach((b, i) => { w.setBlock(x + i * 2, oy - 1, z, b); w.setBlock(x + i * 2, oy, z, B.NOTE_BLOCK); });
  under.forEach((_, i) => g.redstone.use(x + i * 2, oy, z, B.NOTE_BLOCK));
  res.insts = heard.map((h) => h[0]);
  heard.length = 0;
  for (let i = 0; i < 26; i++) g.redstone.use(x, oy, z, B.NOTE_BLOCK);
  res.pitch = rs.state(x, oy, z)?.pitch; // 1 + 26 = 27 -> wraps to 2
  // rising edge: a lever beside it plays once, not again while held, again after release+press
  heard.length = 0;
  rs.set(x - 1, oy, z, B.LEVER, { active: false, facing: 1 });
  rs.press(x - 1, oy, z);
  g.triggerRedstoneUpdate(x, oy, z);
  res.onEdge = heard.length;
  rs.press(x - 1, oy, z); rs.press(x - 1, oy, z);
  res.twice = heard.length;
  // a block on top muffles it
  w.setBlock(x, oy + 1, z, B.STONE);
  heard.length = 0;
  g.redstone.playNote(x, oy, z);
  res.muffled = heard.length === 0;
  g.audio.noteBlock = orig;
  return res;
}, s);
console.log(JSON.stringify(notes));
check('note block instrument follows the block beneath', JSON.stringify(notes.insts) === JSON.stringify(['basedrum', 'bass', 'bell', 'snare', 'hat', 'harp']), JSON.stringify(notes.insts));
check('right-click steps the pitch and wraps at 25', notes.pitch === 2, `${notes.pitch}`);
check('a rising signal plays it once per pulse', notes.onEdge === 1 && notes.twice === 2, `${notes.onEdge} ${notes.twice}`);
check('a block on top muffles it', notes.muffled);

// --- 5. support + persistence + a big grid --------------------------------------------------
const misc = await page.evaluate(async ({ ox, oy, oz }) => {
  const g = window.__game, B = window.__B, w = g.world, rs = window.__rs, res = {};
  const x = ox + 30, z = oz + 6;
  w.setBlock(x, oy, z, B.STONE);
  rs.set(x, oy, z + 1, B.STONE_BUTTON, { active: false, facing: 3 }); // on the stone's +z face
  w.setBlock(x + 3, oy, z, B.STONE); w.setBlock(x + 3, oy + 1, z, B.REDSTONE_WIRE);
  w.setBlock(x, oy, z, 0); w.setBlock(x + 3, oy, z, 0);
  await new Promise((r) => setTimeout(r, 700));
  res.buttonGone = w.getBlock(x, oy, z + 1) === 0;
  res.dustGone = w.getBlock(x + 3, oy + 1, z) === 0;
  const save = g.buildSave();
  const rec = save.redstoneStates ?? {};
  res.savedDelay = rec[rs.k(ox + 22, oy, oz + 10)]?.delay;
  res.savedPitch = rec[rs.k(ox + 30, oy, oz + 16)]?.pitch;
  // a 24x24 dust grid fed by one lever: how long does a flip take?
  const gx = ox + 8, gz = oz + 22;
  for (let i = 0; i < 24; i++) for (let j = 0; j < 24; j++) w.setBlock(gx + i, oy, gz + j, B.REDSTONE_WIRE);
  rs.set(gx - 1, oy, gz, B.LEVER, { active: false, facing: 1 });
  const t0 = performance.now();
  rs.press(gx - 1, oy, gz);
  res.gridOnMs = performance.now() - t0;
  res.gridFar = w.redstonePower.get(rs.k(gx + 10, oy, gz + 3)) ?? 0; // 13 steps away
  const t1 = performance.now();
  rs.press(gx - 1, oy, gz);
  res.gridOffMs = performance.now() - t1;
  return res;
}, s);
console.log(JSON.stringify(misc));
check('a button pops off when its wall goes', misc.buttonGone);
check('dust pops off when its floor goes', misc.dustGone);
check('the save keeps repeater delay and note pitch', misc.savedDelay === 4 && misc.savedPitch === 2, `${misc.savedDelay} ${misc.savedPitch}`);
check('a 576-dust grid re-solves quickly', misc.gridOnMs < 250 && misc.gridOffMs < 250, `${misc.gridOnMs.toFixed(1)} / ${misc.gridOffMs.toFixed(1)} ms`);
check('grid power reaches 13 blocks away at level 2', misc.gridFar === 2, `${misc.gridFar}`);

// --- 6. comparators ---------------------------------------------------------------------------
const cmp = await page.evaluate(async ({ ox, oy, oz }) => {
  const g = window.__game, B = window.__B, w = g.world, rs = window.__rs, res = {};
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const z = oz + 50, x = ox + 30;
  // chest -> comparator (output +x) -> lamp; 14 full stacks of 27 slots = level 8
  w.setBlock(x, oy, z, B.CHEST);
  const chest = new (await import('/src/engine/Inventory.ts')).ChestState();
  for (let i = 0; i < 14; i++) chest.slots[i] = { id: B.COBBLE, count: 64 };
  w.blockEntities.set(rs.k(x, oy, z), chest);
  rs.set(x + 1, oy, z, B.COMPARATOR, { active: false, facing: 3, level: 0 });
  w.setBlock(x + 2, oy, z, B.REDSTONE_LAMP);
  await wait(900);
  res.chestLevel = rs.state(x + 1, oy, z)?.level;
  res.chestLamp = w.getBlock(x + 2, oy, z) === B.REDSTONE_LAMP_LIT;
  chest.slots.fill(null);
  await wait(900);
  res.emptyLevel = rs.state(x + 1, oy, z)?.level;
  res.emptyLamp = w.getBlock(x + 2, oy, z) === B.REDSTONE_LAMP;
  // read through a solid block: chest, stone, comparator
  const z2 = z + 2;
  w.setBlock(x, oy, z2, B.CHEST);
  const c2 = new (await import('/src/engine/Inventory.ts')).ChestState();
  c2.slots[0] = { id: B.COBBLE, count: 64 };
  w.blockEntities.set(rs.k(x, oy, z2), c2);
  w.setBlock(x + 1, oy, z2, B.STONE);
  rs.set(x + 2, oy, z2, B.COMPARATOR, { active: false, facing: 3, level: 0 });
  await wait(900);
  res.throughLevel = rs.state(x + 2, oy, z2)?.level; // 1/27 full -> 1
  // subtract: redstone block behind (15), dust at 11 on the side -> 4, which then
  // runs down a dust line (4, 3, 2, 1)
  const z3 = z + 4;
  w.setBlock(x, oy, z3, B.REDSTONE_BLOCK);
  rs.set(x + 1, oy, z3, B.COMPARATOR, { active: false, facing: 3, level: 0, sub: true });
  rs.set(x + 1, oy, z3 + 6, B.LEVER, { active: false, facing: 1 });
  for (let j = 1; j <= 5; j++) w.setBlock(x + 1, oy, z3 + j, B.REDSTONE_WIRE); // side dust: 15 at +5 ... 11 at +1
  for (let i = 2; i <= 6; i++) w.setBlock(x + i, oy, z3, B.REDSTONE_WIRE);
  rs.press(x + 1, oy, z3 + 6);
  await wait(900);
  res.sideDust = w.redstonePower.get(rs.k(x + 1, oy, z3 + 1)) ?? 0;
  res.subLevel = rs.state(x + 1, oy, z3)?.level;
  res.subLine = [2, 3, 4, 5, 6].map((i) => w.redstonePower.get(rs.k(x + i, oy, z3)) ?? 0);
  // compare mode with the same inputs: rear 15 >= side 11 -> 15
  g.redstone.use(x + 1, oy, z3, B.COMPARATOR);
  await wait(900);
  res.cmpLevel = rs.state(x + 1, oy, z3)?.level;
  return res;
}, s);
console.log(JSON.stringify(cmp));
check('comparator reads a chest (14 of 27 stacks = 8) and lights its lamp', cmp.chestLevel === 8 && cmp.chestLamp, `${cmp.chestLevel}`);
check('an emptied chest drops it to 0', cmp.emptyLevel === 0 && cmp.emptyLamp);
check('comparator reads a chest through a solid block', cmp.throughLevel === 1, `${cmp.throughLevel}`);
check('subtract mode: 15 - side 11 = 4', cmp.sideDust === 11 && cmp.subLevel === 4, `side ${cmp.sideDust} out ${cmp.subLevel}`);
check('comparator output runs down dust', JSON.stringify(cmp.subLine) === JSON.stringify([4, 3, 2, 1, 0]), JSON.stringify(cmp.subLine));
check('compare mode passes the back signal (15 >= 11)', cmp.cmpLevel === 15, `${cmp.cmpLevel}`);

// --- 7. observers ------------------------------------------------------------------------------
await page.evaluate(({ ox, oy, oz }) => {
  const g = window.__game, B = window.__B, w = g.world, rs = window.__rs;
  const x = ox + 38, z = oz + 50;
  // observer facing +x (face at x+1), output -x into a lamp
  rs.set(x, oy, z, B.OBSERVER, { active: false, facing: 0 });
  w.setBlock(x - 1, oy, z, B.REDSTONE_LAMP);
  // record the lamp in-page (a pulse is ~100 ms; polling from outside can miss it)
  window.__obsLit = 0; window.__obsLog = [];
  let last = w.getBlock(x - 1, oy, z);
  window.__obsPoll = setInterval(() => {
    const now = w.getBlock(x - 1, oy, z);
    if (now === B.REDSTONE_LAMP_LIT) window.__obsLit++;
    if (now !== last) { window.__obsLog.push([g.redstone.tickNo, now === B.REDSTONE_LAMP_LIT]); last = now; }
  }, 4);
  window.__obsT0 = g.redstone.tickNo;
  w.setBlock(x + 1, oy, z, B.STONE); // the change it watches
}, s);
await page.waitForTimeout(1000);
const obs = await page.evaluate(() => ({ t0: window.__obsT0, log: window.__obsLog }));
const on = obs.log.find((e) => e[1]), off = obs.log.find((e) => !e[1]);
const obsOn = on ? on[0] - obs.t0 : null, obsOff = on && off ? off[0] - on[0] : null;
check('observer pulses its back one redstone tick after the change', obsOn !== null && obsOn >= 1 && obsOn <= 5, `${obsOn}`);
check('...and the pulse ends a redstone tick later', obsOff !== null && obsOff >= 1 && obsOff <= 5, `${obsOff} ${JSON.stringify(obs.log)}`);
const quiet = await page.evaluate(async () => {
  const before = window.__obsLit;
  await new Promise((r) => setTimeout(r, 1200));
  clearInterval(window.__obsPoll);
  return window.__obsLit === before;
});
check('no change, no pulse', quiet);
// an observer clock: two observers watching each other keep ticking without runaway
const clock = await page.evaluate(async ({ ox, oy, oz }) => {
  const g = window.__game, B = window.__B, w = g.world, rs = window.__rs;
  const x = ox + 41, z = oz + 54; // clear of the comparator test's dust
  rs.set(x, oy, z, B.OBSERVER, { active: false, facing: 0 });     // watches x+1
  w.setBlock(x - 1, oy, z, B.REDSTONE_LAMP);
  rs.set(x + 1, oy, z, B.OBSERVER, { active: false, facing: 1 }); // watches x (placing it trips the first)
  let flips = 0, last = w.getBlock(x - 1, oy, z);
  const t0 = performance.now();
  await new Promise((resolve) => {
    const id = setInterval(() => {
      const now = w.getBlock(x - 1, oy, z);
      if (now !== last) { flips++; last = now; }
      if (performance.now() - t0 > 2500) { clearInterval(id); resolve(); }
    }, 5);
  });
  w.setBlock(x + 1, oy, z, 0); // stop it
  return { flips };
}, s);
check('an observer clock keeps pulsing', clock.flips >= 4, `${clock.flips} lamp flips in 2.5 s`);

// --- 8. daylight detectors -----------------------------------------------------------------------
await page.evaluate(({ ox, oy, oz }) => {
  const g = window.__game, B = window.__B, w = g.world;
  g.dayTime = 0.25; // noon
  w.setBlock(ox + 38, oy, oz + 58, B.DAYLIGHT_DETECTOR);
  w.setBlock(ox + 39, oy, oz + 58, B.REDSTONE_LAMP);
}, s);
await page.waitForTimeout(1500);
const day = await page.evaluate(({ ox, oy, oz }) => ({
  level: window.__rs.state(ox + 38, oy, oz + 58)?.level,
  lamp: window.__game.world.getBlock(ox + 39, oy, oz + 58) === window.__B.REDSTONE_LAMP_LIT,
}), s);
await page.evaluate(() => { window.__game.dayTime = 0.8; });
await page.waitForTimeout(1800);
const night = await page.evaluate(({ ox, oy, oz }) => ({
  level: window.__rs.state(ox + 38, oy, oz + 58)?.level,
  lamp: window.__game.world.getBlock(ox + 39, oy, oz + 58) === window.__B.REDSTONE_LAMP,
}), s);
await page.evaluate(({ ox, oy, oz }) => window.__game.redstone.use(ox + 38, oy, oz + 58, window.__B.DAYLIGHT_DETECTOR), s);
await page.waitForTimeout(300);
const inv = await page.evaluate(({ ox, oy, oz }) => ({
  level: window.__rs.state(ox + 38, oy, oz + 58)?.level,
  lamp: window.__game.world.getBlock(ox + 39, oy, oz + 58) === window.__B.REDSTONE_LAMP_LIT,
}), s);
await page.evaluate(() => { window.__game.dayTime = 0.3; });
check('daylight detector: full power at noon', day.level >= 14 && day.lamp, `${day.level}`);
check('daylight detector: dark at night', night.level === 0 && night.lamp, `${night.level}`);
check('inverted detector powers at night', inv.level === 15 && inv.lamp, `${inv.level}`);

// --- screenshots ---------------------------------------------------------------------------
async function frame(tx, ty, tz, ex, ey, ez) {
  await page.evaluate(({ tx, ty, tz, ex, ey, ez }) => {
    const p = window.__game.player;
    p.flying = true; p.vel = { x: 0, y: 0, z: 0 };
    p.pos.x = ex; p.pos.y = ey - p.eyeHeight(); p.pos.z = ez;
    const dx = tx - ex, dy = ty - ey, dz = tz - ez;
    p.yaw = Math.atan2(-dx, -dz);
    p.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  }, { tx, ty, tz, ex, ey, ez });
  await page.waitForTimeout(600);
  await page.waitForFunction(({ tx, tz }) => {
    const g = window.__game;
    const c0x = Math.floor(tx / 16), c0z = Math.floor(tz / 16);
    for (let cx = c0x - 1; cx <= c0x + 1; cx++) for (let cz = c0z - 1; cz <= c0z + 1; cz++) {
      const k = `${cx},${cz}`, c = g.world.getChunk(cx, cz);
      if (!c || !c.ready || g.world.dirtySet.has(k) || g.meshInFlight.has(k)) return false;
    }
    return true;
  }, { tx, tz }, { timeout: 180000, polling: 300 }).catch(() => console.log('  (mesh wait timed out)'));
  await page.waitForTimeout(900);
}
if (SHOTS) {
  await page.evaluate(({ ox, oy, oz }) => {
    const g = window.__game, B = window.__B, w = g.world, rs = window.__rs;
    const x = ox + 14, z = oz - 10;
    // lever -> dust (a bend + a climb) -> repeater -> lamp; torch inverter; note block; plates
    rs.set(x, oy, z, B.LEVER, { active: false, facing: 1 });
    for (let i = 1; i <= 4; i++) w.setBlock(x + i, oy, z, B.REDSTONE_WIRE);
    for (let j = 1; j <= 2; j++) w.setBlock(x + 4, oy, z + j, B.REDSTONE_WIRE);
    w.setBlock(x + 5, oy, z + 2, B.STONE); w.setBlock(x + 5, oy + 1, z + 2, B.REDSTONE_WIRE);
    rs.set(x + 1, oy, z + 3, B.REPEATER, { active: false, facing: 2, delay: 3 });
    w.setBlock(x + 1, oy, z + 1, B.REDSTONE_WIRE); w.setBlock(x + 1, oy, z + 2, B.REDSTONE_WIRE);
    w.setBlock(x + 1, oy, z + 4, B.REDSTONE_LAMP);
    w.setBlock(x + 7, oy, z, B.STONE); w.setBlock(x + 7, oy + 1, z, B.REDSTONE_TORCH);
    w.setBlock(x + 8, oy, z, B.REDSTONE_LAMP);
    w.setBlock(x + 9, oy, z + 3, B.NOTE_BLOCK);
    w.setBlock(x - 2, oy, z + 3, B.STONE_PRESSURE_PLATE); w.setBlock(x - 2, oy, z + 1, B.PRESSURE_PLATE);
    w.setBlock(x + 6, oy, z + 5, B.REDSTONE_BLOCK);
    rs.set(x + 7, oy, z + 5, B.COMPARATOR, { active: false, facing: 3, level: 0, sub: true });
    w.setBlock(x + 8, oy, z + 5, B.REDSTONE_WIRE); w.setBlock(x + 9, oy, z + 5, B.REDSTONE_WIRE);
    rs.set(x + 9, oy, z + 1, B.OBSERVER, { active: false, facing: 5 });
    w.setBlock(x + 11, oy, z + 3, B.DAYLIGHT_DETECTOR);
    rs.press(x, oy, z);
    g.dayTime = 0.3;
    window.__shotX = x; window.__shotZ = z;
  }, s);
  await page.waitForTimeout(1200);
  await frame(ox + 17, oy, oz - 8, ox + 17, oy + 5, oz - 1.5);
  await page.screenshot({ path: `${DIR}/redstone-day.png` });
  await page.evaluate(() => { window.__game.dayTime = 0.8; });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${DIR}/redstone-night.png` });
  await page.evaluate(() => { window.__game.dayTime = 0.3; });
  await frame(ox + 15.5, oy + 0.1, oz - 6.5, ox + 13.2, oy + 1.3, oz - 5.6);
  await page.screenshot({ path: `${DIR}/redstone-close.png` });
  await page.evaluate(() => {
    const g = window.__game, B = window.__B;
    const ids = [B.REDSTONE_TORCH, B.REPEATER, B.COMPARATOR, B.OBSERVER, B.DAYLIGHT_DETECTOR, B.REDSTONE_BLOCK, B.NOTE_BLOCK, B.STONE_PRESSURE_PLATE, B.PRESSURE_PLATE];
    const c = document.createElement('canvas'); c.width = ids.length * 36; c.height = 36;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#8b8b8b'; ctx.fillRect(0, 0, c.width, c.height);
    ids.forEach((id, i) => ctx.drawImage(g.atlas.icon(id), i * 36 + 2, 2));
    c.id = 'icon-sheet';
    Object.assign(c.style, { position: 'fixed', left: '10px', top: '10px', zIndex: 99999, transform: 'scale(4)', transformOrigin: '0 0', imageRendering: 'pixelated' });
    document.body.appendChild(c);
  });
  await page.waitForTimeout(200);
  await page.locator('#icon-sheet').screenshot({ path: `${DIR}/redstone-icons.png` });
}

console.log('--- console errors ---');
console.log(errors.length ? errors.slice(0, 8).join('\n') : 'NONE');
console.log(errors.length || failures.length ? 'SOME CHECKS FAILED' : 'ALL CHECKS PASS');
await browser.close();
await server.close();
process.exit(errors.length || failures.length ? 1 : 0);
