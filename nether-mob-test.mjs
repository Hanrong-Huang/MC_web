// Nether mobs: a lineup of every nether mob on a netherrack platform at y=108
// (piglins, hoglins + striders, fortress mobs, magma cube sizes, the older
// cinderling/ashstalker/emberghast), action shots (admiring piglin, crossbow
// aim, magma cube mid-leap, blaze volley, hoglin toss) and asserts for the
// behaviours: barter, zombified-piglin group anger, magma cube split, strider
// lava walking + cold, fortress/biome region detection, capture + sprites.
// Screenshots go to $SHOT_DIR (default: the repo root).
import { chromium } from 'playwright';
import { createServer } from 'vite';

const PORT = +(process.env.PORT ?? 5235);
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

// arena: a netherrack floor at y=108 with a lava pool at one end, day, no spawns
const arena = await page.evaluate(() => {
  const g = window.__game, p = g.player, B = window.__B, w = g.world;
  g.entities.mobsEnabled = false;
  g.dayTime = 0.25;
  p.inventory.slots[0] = null; p.inventory.selected = 0; g.onInventoryChange();
  const ox = Math.floor(p.pos.x), oy = 108, oz = Math.floor(p.pos.z);
  for (let dx = -12; dx <= 12; dx++) {
    for (let dz = -10; dz <= 10; dz++) {
      w.setBlock(ox + dx, oy - 1, oz + dz, B.NETHERRACK);
      w.setBlock(ox + dx, oy - 2, oz + dz, B.NETHERRACK);
      for (let dy = 0; dy <= 7; dy++) w.setBlock(ox + dx, oy + dy, oz + dz, 0);
    }
  }
  // lava pool (x 6..11, z -8..-3) one block deep
  for (let dx = 6; dx <= 11; dx++) for (let dz = -8; dz <= -3; dz++) w.setBlock(ox + dx, oy - 1, oz + dz, B.LAVA);
  window.__arena = { ox, oy, oz };
  return { ox, oy, oz };
});
const settle = async (ms = 600) => {
  // let the arena's chunks leave the mesh queue so shots aren't half-built
  await page.waitForFunction(() => {
    const g = window.__game, b = window.__arena;
    for (let cx = Math.floor((b.ox - 12) / 16); cx <= Math.floor((b.ox + 12) / 16); cx++) {
      for (let cz = Math.floor((b.oz - 10) / 16); cz <= Math.floor((b.oz + 10) / 16); cz++) {
        const k = `${cx},${cz}`;
        if (g.world.dirtySet.has(k) || g.meshInFlight.has(k)) return false;
      }
    }
    return true;
  }, null, { timeout: 20000, polling: 250 }).catch(() => console.log('mesh wait timed out'));
  await page.waitForTimeout(ms);
};
await settle(1500);

/** Spawn a row of mobs across the platform (x spacing `gap`), frozen idle,
 *  facing the camera, and frame them from z+`back`. */
async function lineup(specs, name, { gap = 2.2, back = 6, camY = 1.2, pitch = -0.1, z = 0, post } = {}) {
  await page.evaluate(({ specs, gap, back, camY, pitch, z }) => {
    const g = window.__game, { ox, oy, oz } = window.__arena;
    for (const e of g.entities.entities) if (g.entities.isMob(e)) e.dead = true;
    const w = (specs.length - 1) * gap;
    window.__row = specs.map((s, i) => {
      const x = ox + 0.5 - w / 2 + i * gap;
      const m = s.baby ? g.entities.spawnBaby(s.kind, x, oy + (s.dy ?? 0), oz + z + 0.5)
        : g.entities.spawnMob(s.kind, x, oy + (s.dy ?? 0), oz + z + 0.5, s.variant ?? 0);
      // the camera looks down -z: yaw π faces the mob back at it
      m.yaw = m.visYaw = Math.PI + (s.yaw ?? 0.35 * (i % 2 ? -1 : 1));
      m.convertT = -1e9; // no overworld zombification mid-shoot
      m.state = 'idle'; m.stateTime = 999; m.vel = { x: 0, y: 0, z: 0 };
      m.lookT = 999; m.lookYaw = 0; m.lookPitch = 0; m.watching = false;
      return m;
    });
    const p = g.player;
    p.flying = true;
    p.pos.x = ox + 0.5; p.pos.y = oy + camY; p.pos.z = oz + z + 0.5 + back;
    p.vel.x = p.vel.y = p.vel.z = 0; p.yaw = 0; p.pitch = pitch;
  }, { specs, gap, back, camY, pitch, z });
  if (post) await page.evaluate(post);
  await settle(700);
  await page.screenshot({ path: `${DIR}/nether-${name}.png` });
  if (process.env.DEBUG_SHOTS) console.log(name, await page.evaluate(() => {
    const g = window.__game, { ox, oy, oz } = window.__arena, c = g.renderer.camera.position;
    return JSON.stringify({ p: g.player.pos, cam: [c.x, c.y, c.z], floor: g.world.getBlock(ox, oy - 1, oz),
      mobs: window.__row.map((m) => [m.kind, +m.pos.x.toFixed(1), +m.pos.y.toFixed(1), +m.pos.z.toFixed(1), m.dead]) });
  }));
}

await lineup([
  { kind: 'piglin', variant: 0 }, { kind: 'piglin', variant: 1 }, { kind: 'piglin', variant: 2 },
  { kind: 'piglin', baby: true }, { kind: 'zombified_piglin' }, { kind: 'zombified_piglin', baby: true },
], 'piglins', { gap: 1.7, back: 5.2 });
await lineup([
  { kind: 'hoglin', yaw: 0.6 }, { kind: 'hoglin', baby: true, yaw: -0.4 }, { kind: 'strider', yaw: 0.3 },
], 'beasts', { gap: 3, back: 7, camY: 1.6 });
await lineup([
  { kind: 'blaze', dy: 0.6 }, { kind: 'wither_skeleton' },
  { kind: 'magma_cube', variant: 0 }, { kind: 'magma_cube', variant: 1 }, { kind: 'magma_cube', variant: 2 },
], 'fortress', { gap: 2.2, back: 7, camY: 1.5 });
await lineup([
  { kind: 'cinderling' }, { kind: 'ashstalker' }, { kind: 'emberghast', dy: 1 },
], 'classic', { gap: 2.4, back: 5.5, camY: 1.3 });
// all together
await lineup([
  { kind: 'piglin' }, { kind: 'zombified_piglin' }, { kind: 'hoglin' }, { kind: 'strider' },
  { kind: 'blaze', dy: 0.6 }, { kind: 'wither_skeleton' }, { kind: 'magma_cube', variant: 2 },
], 'all', { gap: 2.5, back: 11, camY: 2.4, pitch: -0.12 });

// --- action shots --------------------------------------------------------------
await lineup([{ kind: 'piglin', variant: 0, yaw: 0 }], 'admire', {
  back: 2.6, camY: 0.9, post: () => {
    const g = window.__game, m = window.__row[0];
    g.entities.interactMob(m, window.__findId('gold_ingot'));
  },
});
// strider: warm on lava, then cold on land (turns purple)
await lineup([{ kind: 'strider', yaw: 0.4 }, { kind: 'strider', yaw: -0.4 }], 'striders', {
  gap: 3, back: 7, camY: 1.8, post: () => {
    const { ox, oy, oz } = window.__arena;
    const s = window.__row[0];
    s.pos = { x: ox + 8.5, y: oy - 0.5, z: oz - 5 }; // into the lava pool
    window.__game.player.pos.x = ox + 5; window.__game.player.pos.z = oz + 3;
    window.__game.player.yaw = 0.35;
  },
});
const striderInfo = await page.evaluate(() => {
  const [a, b] = window.__row;
  return { lavaY: a.pos.y, lavaCold: a.cold, landCold: b.cold, oy: window.__arena.oy };
});
check('strider stands on the lava surface', Math.abs(striderInfo.lavaY - striderInfo.oy) < 0.1, JSON.stringify(striderInfo));
check('strider warm on lava, cold on land', !striderInfo.lavaCold && striderInfo.landCold);

// magma cube mid-leap: slices spread
await lineup([{ kind: 'magma_cube', variant: 2, yaw: 0.3 }], 'magma-leap', {
  back: 6, camY: 1.8, post: () => { const m = window.__row[0]; m.vel.y = 12; m.onGround = false; },
});
// survival: hostile AI live (the player is healed each shot)
await page.evaluate(() => { const p = window.__game.player; p.mode = 'survival'; p.flying = false; });
await lineup([{ kind: 'piglin', variant: 1, yaw: 0 }, { kind: 'blaze', dy: 1, yaw: 0 }], 'aim', {
  gap: 3, back: 8, camY: 0, pitch: 0.05, post: () => {
    const [pg, bz] = window.__row;
    for (const m of [pg, bz]) { m.stateTime = 0; m.state = 'chase'; }
    bz.shootCooldown = 0;
    window.__game.player.hp = 20;
    const em = window.__game.entities;
    window.__shots = 0;
    for (const f of ['shootArrow', 'spawnBlazeCharge']) {
      const orig = em[f].bind(em);
      em[f] = (...a) => { window.__shots++; return orig(...a); };
    }
  },
});
await page.waitForTimeout(1300);
await page.screenshot({ path: `${DIR}/nether-volley.png` });
const shots = await page.evaluate(() => {
  const g = window.__game;
  const arrows = g.entities.entities.filter((e) => e.kind === 'arrow');
  return { n: window.__shots, flying: arrows.length, hp: g.player.hp };
});
check('blaze + crossbow piglin shoot in survival', shots.n > 0, JSON.stringify(shots));
await page.evaluate(() => { window.__game.player.hp = 20; });
await page.evaluate(() => { const p = window.__game.player; p.mode = 'creative'; p.hp = 20; });
await lineup([{ kind: 'hoglin', yaw: 0.5 }], 'hoglin-toss', {
  back: 4.5, camY: 0.6, pitch: 0.05, post: () => { window.__row[0].swingT = 0.3; },
});

// --- behaviour asserts -------------------------------------------------------------
const beh = await page.evaluate(async () => {
  const g = window.__game, em = g.entities, B = window.__B, { ox, oy, oz } = window.__arena;
  for (const e of em.entities) if (em.isMob(e)) e.dead = true;
  const out = {};
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // barter: gold ingot -> admire -> loot
  const pg = em.spawnMob('piglin', ox + 0.5, oy, oz + 0.5, 0);
  out.interact = em.interactMob(pg, window.__findId('gold_ingot'));
  out.admiring = pg.admireT > 0;
  const before = em.entities.filter((e) => e.kind === 'drop').length;
  pg.admireT = 0.05;
  await wait(400);
  out.bartered = em.entities.filter((e) => e.kind === 'drop').length > before;
  // zombified piglins: one hit angers the group
  const zs = [0, 1, 2].map((i) => em.spawnMob('zombified_piglin', ox + 3 + i, oy, oz + 3, 0));
  out.calm = zs.every((z) => z.angryT <= 0);
  em.hurt(zs[0], 1, 1, 0, g.player);
  out.allAngry = zs.every((z) => z.angryT > 0);
  // magma cube split
  const mc = em.spawnMob('magma_cube', ox - 4.5, oy, oz + 0.5, 2);
  const n0 = em.entities.filter((e) => e.kind === 'magma_cube' && !e.dead).length;
  em.hurt(mc, 999, 0, 1, g.player);
  const kids = em.entities.filter((e) => e.kind === 'magma_cube' && !e.dead);
  out.split = kids.length - (n0 - 1);
  out.kidVariant = kids.every((k) => k.variant === 1);
  // fortress detection: bricks around a spot
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) g.world.setBlock(ox - 8 + dx, oy - 1, oz + 6 + dz, B.NETHER_BRICKS);
  out.fortress = em.netherRegion(ox - 8, oy, oz + 6, B.NETHER_BRICKS);
  out.soul = em.netherRegion(ox + 8, oy, oz + 8, B.SOUL_SAND);
  out.wastes = em.netherRegion(ox + 8, oy, oz + 8, B.NETHERRACK);
  // capture every new hostile kind
  out.capt = ['piglin', 'zombified_piglin', 'hoglin', 'blaze', 'wither_skeleton', 'magma_cube'].map((k) => {
    const m = em.spawnMob(k, ox + 0.5, oy + 3, oz - 6);
    return em.captureMob(m, false) === k;
  });
  // strider: saddle + mount
  const st = em.spawnMob('strider', ox + 8.5, oy, oz - 5);
  out.saddle = em.interactMob(st, window.__findId('saddle'));
  out.mount = em.interactMob(st, 0);
  out.isMount = em.isMount(st);
  return out;
});
console.log('behaviour', JSON.stringify(beh));
check('piglin takes gold and admires it', beh.interact === 'saddle' && beh.admiring);
check('piglin barters loot', beh.bartered);
check('zombified piglins start calm, anger together', beh.calm && beh.allAngry);
check('big magma cube splits into 2-4 medium', beh.split >= 2 && beh.split <= 4 && beh.kidVariant, `split=${beh.split}`);
check('fortress bricks -> fortress region', beh.fortress === 'fortress', beh.fortress);
check('soul sand -> soul region', beh.soul === 'soul', beh.soul);
check('netherrack -> wastes', beh.wastes === 'wastes', beh.wastes);
check('all new hostiles capturable', beh.capt.every(Boolean), JSON.stringify(beh.capt));
check('strider saddles + mounts', beh.saddle === 'saddle' && beh.mount === 'mount' && beh.isMount);

// --- icon sheet: drops + filled catchers ------------------------------------------------
await page.evaluate(() => {
  const g = window.__game;
  const names = ['blaze_rod', 'blaze_powder', 'magma_cream', 'gold_nugget', 'ghast_tear', 'wither_skull',
    'mob_catcher_filled_piglin', 'mob_catcher_filled_zombified_piglin', 'mob_catcher_filled_hoglin',
    'mob_catcher_filled_blaze', 'mob_catcher_filled_wither_skeleton', 'mob_catcher_filled_magma_cube'];
  const c = document.createElement('canvas');
  c.width = names.length * 36; c.height = 36;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#8b8b8b'; ctx.fillRect(0, 0, c.width, c.height);
  names.forEach((n, i) => {
    ctx.fillStyle = '#6f6f6f'; ctx.fillRect(i * 36 + 1, 1, 34, 34);
    const s = g.atlas.sprite(n);
    if (s) ctx.drawImage(s, i * 36 + 2, 2, 32, 32);
  });
  c.id = 'icon-sheet';
  Object.assign(c.style, { position: 'fixed', left: '10px', top: '10px', zIndex: 99999, transform: 'scale(2.5)', transformOrigin: '0 0', imageRendering: 'pixelated' });
  document.body.appendChild(c);
});
await page.waitForTimeout(200);
await page.locator('#icon-sheet').screenshot({ path: `${DIR}/nether-icons.png` });
await page.evaluate(() => document.getElementById('icon-sheet')?.remove());

console.log(errors.length ? `console errors:\n${errors.slice(0, 8).join('\n')}` : 'console errors: NONE');
await browser.close();
await server.close();
process.exit(failures.length || errors.length ? 1 : 0);
