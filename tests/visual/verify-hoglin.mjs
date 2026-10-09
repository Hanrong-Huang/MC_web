// Hoglin model: an adult + a baby on a stone platform at y=108, frozen idle,
// shot from the front, side, 3/4 and above, then on a netherrack / crimson
// nylium floor at dusk so the hide's contrast against the Nether can be judged,
// plus the attack toss. Screenshots go to $SHOT_DIR (default: the repo root).
import { chromium } from 'playwright';
import { createServer } from 'vite';

const PORT = +(process.env.PORT ?? 5395);
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

// arena: a floor at y=108 (stone, then netherrack / nylium), open air above
await page.evaluate(() => {
  const g = window.__game, p = g.player, B = window.__B, w = g.world;
  g.entities.mobsEnabled = false;
  g.dayTime = 0.25;
  p.inventory.slots[0] = null; p.inventory.selected = 0; g.onInventoryChange();
  const ox = Math.floor(p.pos.x), oy = 108, oz = Math.floor(p.pos.z);
  window.__arena = { ox, oy, oz };
  window.__floor = (id, id2) => {
    for (let dx = -12; dx <= 12; dx++) {
      for (let dz = -12; dz <= 12; dz++) {
        w.setBlock(ox + dx, oy - 1, oz + dz, id2 && (dx + dz) % 3 === 0 ? id2 : id);
        w.setBlock(ox + dx, oy - 2, oz + dz, B.STONE);
        for (let dy = 0; dy <= 8; dy++) w.setBlock(ox + dx, oy + dy, oz + dz, 0);
      }
    }
  };
  window.__floor(B.STONE);
  // hold every hoglin still each frame (no AI drift, no glances, no gait)
  const hold = () => {
    for (const m of window.__row ?? []) {
      if (m.dead) continue;
      m.pos.x = m.__x; m.pos.z = m.__z; m.yaw = m.visYaw = m.__yaw;
      m.vel.x = 0; m.vel.z = 0; m.state = 'idle'; m.stateTime = 999;
      m.lookT = 999; m.lookYaw = 0; m.lookPitch = 0; m.watching = false; m.convertT = -1e9;
      if (!m.__toss) m.swingT = 0;
    }
    requestAnimationFrame(hold);
  };
  requestAnimationFrame(hold);
});
const settle = async (ms = 600) => {
  await page.waitForFunction(() => {
    const g = window.__game, b = window.__arena;
    for (let cx = Math.floor((b.ox - 12) / 16); cx <= Math.floor((b.ox + 12) / 16); cx++) {
      for (let cz = Math.floor((b.oz - 12) / 16); cz <= Math.floor((b.oz + 12) / 16); cz++) {
        const k = `${cx},${cz}`;
        if (g.world.dirtySet.has(k) || g.meshInFlight.has(k)) return false;
      }
    }
    return true;
  }, null, { timeout: 60000, polling: 250 }).catch(() => console.log('mesh wait timed out'));
  await page.waitForTimeout(ms);
};
await settle(1500);

/** Spawn hoglins in a row (x spacing `gap`) and frame them from z+`back`.
 *  Mob yaw π faces the camera; extra yaw turns it to show a side. */
async function shot(name, specs, { gap = 3, back = 6, camY = 1.4, pitch = -0.12, toss = false } = {}) {
  await page.evaluate(({ specs, gap, back, camY, pitch, toss }) => {
    const g = window.__game, { ox, oy, oz } = window.__arena;
    for (const e of g.entities.entities) if (g.entities.isMob(e)) e.dead = true;
    const w = (specs.length - 1) * gap;
    window.__row = specs.map((s, i) => {
      const x = ox - 0.6 - w / 2 + i * gap, z = oz + 0.5 + (s.dz ?? 0);
      const m = s.baby ? g.entities.spawnBaby(s.kind ?? 'hoglin', x, oy, z)
        : g.entities.spawnMob(s.kind ?? 'hoglin', x, oy, z, 0);
      m.__x = x; m.__z = z; m.__yaw = Math.PI + (s.yaw ?? 0);
      m.__toss = toss;
      if (toss) m.swingT = 0.24;
      return m;
    });
    const p = g.player;
    p.flying = true;
    p.pos.x = ox + 0.5; p.pos.y = oy + camY; p.pos.z = oz + 0.5 + back;
    p.vel.x = p.vel.y = p.vel.z = 0; p.yaw = 0; p.pitch = pitch;
  }, { specs, gap, back, camY, pitch, toss });
  await settle(900);
  await page.screenshot({ path: `${DIR}/hoglin-${name}.png` });
}

const pair = (yaw) => [{ yaw }, { baby: true, yaw }];
await shot('front', pair(0), { back: 5.5 });
await shot('side', pair(Math.PI / 2), { back: 5.5 });
await shot('threequarter', pair(0.75), { back: 5.5 });
await shot('back', pair(Math.PI - 0.6), { back: 5.5 });
await shot('above', pair(0.6), { back: 3.2, camY: 4.2, pitch: -0.95 });
await shot('closeup', [{ yaw: 0.45 }], { back: 3.8, camY: 0, pitch: -0.2 });
await shot('toss', [{ yaw: 0.9 }], { back: 3.8, camY: 0, pitch: -0.15, toss: true });

// Nether contrast: a crimson nylium / netherrack floor inside a real crimson
// forest, under the Nether's own light and fog
await page.evaluate(() => window.__game.teleportPlayerDimension());
await page.waitForFunction(() => window.__game.world.dimension === 'nether', null, { timeout: 120000 });
await page.waitForTimeout(3000);
const spot = await page.evaluate(() => {
  const gen = window.__game.world.generator;
  for (let r = 0; r < 2400; r += 24) {
    const steps = Math.max(1, Math.round((2 * Math.PI * r) / 24));
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const x = Math.round(Math.cos(a) * r), z = Math.round(Math.sin(a) * r);
      if (gen.netherBiomeAt(x, z) !== 'crimson') continue;
      if ([[20, 0], [-20, 0], [0, 20], [0, -20]].some(([dx, dz]) => gen.netherBiomeAt(x + dx, z + dz) !== 'crimson')) continue;
      const fy = gen.nether.floorAt(x, z);
      if (fy > 0) return { x, z, fy };
    }
  }
  return null;
});
if (!spot) console.log('no crimson forest found');
else {
  await page.evaluate(({ x, z, fy }) => {
    const g = window.__game, p = g.player;
    p.flying = true; p.vel = { x: 0, y: 0, z: 0 };
    p.pos.x = x + 0.5; p.pos.y = fy + 3; p.pos.z = z + 7;
    window.__arena = { ox: x, oy: fy + 1, oz: z };
  }, spot);
  // wait for the spot's chunks to generate before paving it
  await page.waitForFunction(({ x, z }) => {
    const w = window.__game.world;
    for (let cx = Math.floor((x - 12) / 16); cx <= Math.floor((x + 12) / 16); cx++) {
      for (let cz = Math.floor((z - 12) / 16); cz <= Math.floor((z + 12) / 16); cz++) {
        const c = w.getChunk(cx, cz);
        if (!c || !c.ready) return false;
      }
    }
    return true;
  }, spot, { timeout: 120000, polling: 250 }).catch(() => console.log('nether chunk wait timed out'));
  await page.evaluate(() => {
    const B = window.__B, w = window.__game.world, { ox, oy, oz } = window.__arena;
    for (let dx = -7; dx <= 7; dx++) {
      for (let dz = -6; dz <= 9; dz++) {
        w.setBlock(ox + dx, oy - 1, oz + dz, (dx * 7 + dz * 3) % 5 === 0 ? B.NETHERRACK : B.CRIMSON_NYLIUM);
        w.setBlock(ox + dx, oy - 2, oz + dz, B.NETHERRACK);
        for (let dy = 0; dy <= 6; dy++) w.setBlock(ox + dx, oy + dy, oz + dz, 0);
      }
    }
    for (let dz = -6; dz <= -3; dz++) for (let dx = 3; dx <= 7; dx++) w.setBlock(ox + dx, oy - 1, oz + dz, B.NETHERRACK);
  });
  await settle(1500);
  await shot('nether', [{ yaw: 0.7 }, { baby: true, yaw: -0.5 }, { yaw: -1.3, dz: -3 }], { gap: 3, back: 7, camY: 1.8, pitch: -0.18 });
  await shot('nether-front', [{ yaw: 0.15 }], { back: 4, camY: 0, pitch: -0.2 });
}

const bad = errors.filter((e) => !/favicon|404/.test(e));
if (bad.length) console.log('CONSOLE ERRORS:\n' + bad.join('\n'));
console.log(bad.length ? 'FAIL' : 'OK', 'shots in', DIR);
await browser.close();
await server.close();
process.exit(bad.length ? 1 : 0);
