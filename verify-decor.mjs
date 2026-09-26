// Visual + behaviour check for the building/decoration pass: every new block
// placed on a stone platform at y=108 (day and night views), slabs/stairs/
// fences/panes/gates and the shaped utility blocks close up, the inventory
// icon sheet, a few held items, the explorer map, and asserts for slab
// step-up physics, XP levelling, enchanting, anvil repair and potions.
// Screenshots go to $SHOT_DIR (default: the repo root).
import { chromium } from 'playwright';
import { createServer } from 'vite';

const PORT = +(process.env.PORT ?? 5231);
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
// vite may re-optimise deps on a cold start and reload the page once: settle first
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
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failures.push(name); };

const built = await page.evaluate(() => {
  const g = window.__game, p = g.player, B = window.__B, w = g.world;
  const ox = Math.floor(p.pos.x), oy = 108, oz = Math.floor(p.pos.z);
  for (let dx = -4; dx <= 26; dx++) {
    for (let dz = -6; dz <= 14; dz++) {
      w.setBlock(ox + dx, oy - 1, oz + dz, B.STONE);
      for (let dy = 0; dy <= 8; dy++) w.setBlock(ox + dx, oy + dy, oz + dz, 0);
    }
  }
  for (const e of g.entities.entities) if (g.entities.isMob(e)) e.dead = true;
  const put = (x, y, z, id, meta) => {
    const k = `${ox + x},${oy + y},${oz + z}`;
    if (meta !== undefined) w.bedFacings.set(k, meta); else w.bedFacings.delete(k);
    w.setBlock(ox + x, oy + y, oz + z, id);
  };
  // row z=0: full cubes
  const cubes = [B.BRICKS, B.CLAY, B.MOSSY_COBBLE, B.MOSSY_STONE_BRICKS, B.CRACKED_STONE_BRICKS,
    B.CHISELED_STONE_BRICKS, B.SNOW_BLOCK, B.ICE, B.PACKED_ICE, B.TERRACOTTA, B.PUMPKIN, B.MELON, B.BARREL,
    B.RED_WOOL, B.ORANGE_WOOL, B.YELLOW_WOOL, B.LIME_WOOL, B.CYAN_WOOL, B.BLUE_WOOL, B.PURPLE_WOOL, B.BLACK_WOOL];
  cubes.forEach((id, i) => put(i, 0, 0, id));
  put(cubes.length, 0, 0, B.JACK_O_LANTERN, 4); // face toward +z (the camera)
  // row z=3: slabs + stairs
  [B.COBBLE_SLAB, B.STONE_SLAB, B.OAK_SLAB, B.STONE_BRICK_SLAB, B.BRICK_SLAB, B.SANDSTONE_SLAB].forEach((id, i) => {
    put(i, 0, 3, id, 0);
    put(i, 2, 3, id, 1); // top slabs hanging in the air
  });
  [B.OAK_STAIRS, B.COBBLE_STAIRS, B.STONE_BRICK_STAIRS, B.BRICK_STAIRS].forEach((id, i) => put(7 + i, 0, 3, id, i));
  put(11, 1, 3, B.OAK_STAIRS, 4 + 2); // upside-down
  put(11, 0, 3, B.STONE);
  // row z=6: fence run + gate + panes
  for (let i = 0; i < 4; i++) put(i, 0, 6, B.OAK_FENCE);
  put(4, 0, 6, B.FENCE_GATE); w.doorStates.set(`${ox + 4},${oy},${oz + 6}`, { facing: 0, open: false });
  put(5, 0, 6, B.OAK_FENCE);
  put(6, 0, 6, B.FENCE_GATE); w.doorStates.set(`${ox + 6},${oy},${oz + 6}`, { facing: 0, open: true });
  put(7, 0, 6, B.OAK_FENCE);
  for (let i = 9; i < 13; i++) { put(i, 0, 6, B.GLASS_PANE, 0); put(i, 1, 6, B.GLASS_PANE, 0); }
  put(14, 0, 6, B.GLASS_PANE, 1);
  // row z=9: utility blocks
  put(0, 0, 9, B.LANTERN, 0);
  put(1, 2, 9, B.STONE); put(1, 1, 9, B.LANTERN, 1);
  put(3, 0, 9, B.ANVIL, 0); put(5, 0, 9, B.ANVIL, 1);
  put(7, 0, 9, B.ENCHANTING_TABLE);
  for (const [dx, dz] of [[-2, -2], [-1, -2], [0, -2], [1, -2], [2, -2], [-2, -1], [2, -1]]) put(7 + dx, 0, 9 + dz, B.BOOKSHELF);
  put(10, 0, 9, B.CAMPFIRE, 0);
  put(12, 0, 9, B.CAKE, 2);
  put(14, 0, 9, B.FLOWER_POT, B.POPPY);
  put(15, 0, 9, B.FLOWER_POT, B.CORNFLOWER);
  put(17, 0, 9, B.COMPOSTER, 4);
  put(18, 0, 9, B.COMPOSTER, 8);
  // plants row z=12
  put(0, -1, 12, B.GRASS);
  [B.CORNFLOWER, B.ALLIUM, B.OXEYE_DAISY, B.BROWN_MUSHROOM, B.RED_MUSHROOM, B.PUMPKIN_STEM, B.MELON_STEM].forEach((id, i) => {
    put(i, -1, 12, B.GRASS); put(i, 0, 12, id);
  });
  p.flying = true; p.vel = { x: 0, y: 0, z: 0 };
  g.dayTime = 0.12;
  window.__built = { ox, oy, oz };
  return { ox, oy, oz };
});
await page.waitForTimeout(2500);

async function shoot(name, tx, ty, tz, offX, offY, offZ, extra = 400) {
  await page.evaluate(({ tx, ty, tz, offX, offY, offZ }) => {
    const p = window.__game.player;
    const eyeX = tx + offX, eyeY = ty + offY, eyeZ = tz + offZ;
    p.flying = true; p.vel = { x: 0, y: 0, z: 0 };
    p.pos.x = eyeX; p.pos.y = eyeY - p.eyeHeight(); p.pos.z = eyeZ;
    const dx = tx - eyeX, dy = ty - eyeY, dz = tz - eyeZ;
    p.yaw = Math.atan2(-dx, -dz);
    p.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  }, { tx, ty, tz, offX, offY, offZ });
  await page.waitForTimeout(extra);
  // wait for the arena's chunks to come out of the (possibly long) mesh queue
  await page.waitForFunction(() => {
    const g = window.__game, b = window.__built;
    for (let cx = Math.floor((b.ox - 4) / 16); cx <= Math.floor((b.ox + 26) / 16); cx++) {
      for (let cz = Math.floor((b.oz - 6) / 16); cz <= Math.floor((b.oz + 14) / 16); cz++) {
        const k = `${cx},${cz}`;
        if (g.world.dirtySet.has(k) || g.meshInFlight.has(k)) return false;
      }
    }
    return true;
  }, null, { timeout: 120000, polling: 250 }).catch(() => console.log('mesh wait timed out'));
  await page.waitForTimeout(600);
  if (process.env.DEBUG_SHOTS) {
    console.log(name, await page.evaluate(() => {
      const g = window.__game, p = g.player, c = g.renderer.camera.position;
      const b = window.__built; return JSON.stringify({ p: p.pos, pitch: p.pitch, yaw: p.yaw, rot: [g.renderer.camera.rotation.x, g.renderer.camera.rotation.y], blk: g.world.getBlock(b.ox, b.oy - 1, b.oz), blk2: g.world.getBlock(b.ox + 3, b.oy, b.oz), dirty: g.world.dirtySet.size, lock: g.input.pointerLocked, active: g.input.active });
    }));
  }
  await page.screenshot({ path: `${DIR}/${name}` });
}
const { ox, oy, oz } = built;
await page.evaluate(() => { const g = window.__game; g.player.inventory.selected = 8; g.player.inventory.slots[8] = null; g.onInventoryChange(); });
await shoot('decor-cubes.png', ox + 7, oy + 0.5, oz + 0.5, 0, 2.2, 7);
await shoot('decor-cubes2.png', ox + 17, oy + 0.5, oz + 0.5, 0, 2.2, 7);
await shoot('decor-slabs.png', ox + 5.5, oy + 0.8, oz + 3.5, -1.5, 2.6, 5.5);
await shoot('decor-fences.png', ox + 7, oy + 0.6, oz + 6.5, 0.5, 2.4, 5.5);
await shoot('decor-utility.png', ox + 9, oy + 0.6, oz + 9.5, 0, 2.8, 5.5);
await shoot('decor-plants.png', ox + 3, oy + 0.4, oz + 12.5, 0, 1.8, 4);
await page.evaluate(() => { window.__game.dayTime = 0.75; });
await shoot('decor-night.png', ox + 9, oy + 0.6, oz + 7, 0, 3.5, 8, 1500);
await page.evaluate(() => { window.__game.dayTime = 0.12; });

// --- step-up physics: walk into a slab / a stair / a full block -------------
const phys = await page.evaluate(async () => {
  const { moveEntity } = await import('/src/engine/Physics.ts');
  const g = window.__game, B = window.__B, w = g.world;
  const x = Math.floor(g.player.pos.x) + 30, y = 108, z = Math.floor(g.player.pos.z);
  for (let dx = -2; dx <= 6; dx++) { w.setBlock(x + dx, y - 1, z, B.STONE); for (let dy = 0; dy < 4; dy++) w.setBlock(x + dx, y + dy, z, 0); }
  const run = (id, meta) => {
    w.setBlock(x + 2, y, z, id);
    w.bedFacings.set(`${x + 2},${y},${z}`, meta); // after setBlock: replacing a block drops its old meta
    const pos = { x: x + 0.5, y, z: z + 0.5 }, vel = { x: 4, y: 0, z: 0 };
    let ground = true, peak = 0;
    for (let i = 0; i < 18; i++) { // ~3.6 blocks: stays on the platform
      vel.x = 4; vel.y -= 32 * 0.05;
      ground = moveEntity(w, pos, vel, 0.05, { w: 0.6, h: 1.8 }, false, ground).onGround;
      peak = Math.max(peak, pos.y - y);
    }
    return { x: pos.x - x, y: peak };
  };
  return { slab: run(B.OAK_SLAB, 0), stair: run(B.OAK_STAIRS, 3), full: run(B.STONE, 0), topSlab: run(B.OAK_SLAB, 1) };
});
console.log('physics', JSON.stringify(phys));
check('steps up onto a slab', phys.slab.x > 3 && Math.abs(phys.slab.y - 0.5) < 0.05);
check('climbs a stair step by step', phys.stair.x > 3 && Math.abs(phys.stair.y - 1) < 0.05);
check('a full block still blocks', phys.full.x < 2);
check('a top slab blocks like a wall at head height', phys.topSlab.x < 2);

// --- xp, enchanting, anvil, potions -----------------------------------------
const sys = await page.evaluate(() => {
  const g = window.__game, p = g.player, B = window.__B, I = window.__findId;
  p.mode = 'survival';
  p.xpLevel = 0; p.xpProgress = 0;
  p.addXp(100);
  const lvl = p.xpLevel;
  p.xpLevel = 30;
  const sword = I('iron_sword'), amethyst = I('amethyst');
  p.inventory.slots[0] = { id: sword, count: 1 };
  p.inventory.slots[1] = { id: amethyst, count: 5 };
  p.inventory.selected = 0;
  const { ox, oy, oz } = window.__built;
  p.enchantHeld(ox + 7, oy, oz + 9);
  const ench = p.inventory.slots[0]?.ench;
  const levelsAfter = p.xpLevel;
  // anvil: a worn pick + iron ingot
  const pick = I('iron_pickaxe');
  p.inventory.slots[0] = { id: pick, count: 1, dur: 40 };
  p.inventory.slots[2] = { id: I('iron_ingot'), count: 2 };
  p.repairHeld(ox + 3, oy, oz + 9);
  const mended = p.inventory.slots[0]?.dur;
  // potion of swiftness
  p.applyFoodEffects(I('potion_swiftness'));
  const speed = p.effects.has('speed');
  p.mode = 'creative';
  g.onInventoryChange();
  return { lvl, ench, levelsAfter, mended, speed };
}).catch((e) => ({ err: String(e) }));
console.log('systems', JSON.stringify(sys));
check('100 xp reaches level 7', sys.lvl === 7);
check('enchanting applied something', !!sys.ench && Object.keys(sys.ench).length > 0);
check('enchanting cost 3 levels at power 30', sys.levelsAfter === 27);
check('anvil mended a quarter', sys.mended === 40 + Math.ceil(251 * 0.25));
check('potion gives its effect', sys.speed === true);

// --- icon sheet of every new item + block ------------------------------------
await page.evaluate(() => {
  const g = window.__game;
  const ids = [];
  for (let id = 200; id < 300; id++) try { g.atlas.icon(id); ids.push(id); } catch { /* unused id */ }
  for (const id of [61, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93]) ids.push(id);
  for (let id = 300; id < 340; id++) try { g.atlas.icon(id); ids.push(id); } catch { /* unused id */ }
  const cols = 16;
  const c = document.createElement('canvas');
  c.width = cols * 36; c.height = Math.ceil(ids.length / cols) * 36;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#8b8b8b'; ctx.fillRect(0, 0, c.width, c.height);
  ids.forEach((id, i) => {
    ctx.fillStyle = '#6f6f6f'; ctx.fillRect((i % cols) * 36 + 1, Math.floor(i / cols) * 36 + 1, 34, 34);
    ctx.drawImage(g.atlas.icon(id), (i % cols) * 36 + 2, Math.floor(i / cols) * 36 + 2);
  });
  c.id = 'icon-sheet';
  Object.assign(c.style, { position: 'fixed', left: '10px', top: '10px', zIndex: 99999, transform: 'scale(2)', transformOrigin: '0 0', imageRendering: 'pixelated' });
  document.body.appendChild(c);
});
await page.waitForTimeout(200);
await page.locator('#icon-sheet').screenshot({ path: `${DIR}/decor-icons.png` });
await page.evaluate(() => document.getElementById('icon-sheet')?.remove());

// --- held items + map ------------------------------------------------------------
const held = [['oak_stairs', 'held-stairs.png'], ['cobblestone_slab', 'held-slab.png'], ['oak_fence', 'held-fence.png'],
  ['cake', 'held-cake.png'], ['potion_healing', 'held-potion.png'], ['glider', 'held-glider.png'], ['lantern', 'held-lantern.png']];
for (const [name, file] of held) {
  await page.evaluate((name) => {
    const g = window.__game, p = g.player;
    p.pitch = -0.1;
    p.inventory.slots[0] = { id: window.__findId(name), count: 1 };
    p.inventory.selected = 0; g.onInventoryChange();
  }, name);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${DIR}/${file}`, clip: { x: 640, y: 300, width: 640, height: 420 } });
}
await page.evaluate(() => {
  const g = window.__game, p = g.player;
  p.pos.y = 130; p.pitch = -0.2;
  p.lastDeath = { x: p.pos.x + 30, y: 70, z: p.pos.z - 20, dim: 'overworld' };
  p.inventory.slots[0] = { id: window.__findId('map'), count: 1 }; g.onInventoryChange();
});
await page.waitForTimeout(1500);
await page.screenshot({ path: `${DIR}/decor-map.png` });

console.log('--- console errors ---');
if (errors.length === 0) console.log('NONE');
else errors.slice(0, 12).forEach((e) => console.log(e));
console.log(failures.length ? `${failures.length} FAILURES` : 'ALL CHECKS PASS');
await browser.close();
await server.close();
process.exit(errors.length || failures.length ? 1 : 0);
