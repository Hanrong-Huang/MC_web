// Nether fixes: soul light on special models (plants, slabs, stairs, fences,
// torches, lanterns) beside warm lights at night; blaze fireballs (shooter-named
// death messages, setting the player and blocks alight, Fire Resistance); piglin
// bolts and emberghast fireballs named correctly; the Wither effect as a player
// status effect (badge, black hearts, damage, milk, persistence, death message).
// Asserts, and fails on any console error. Env: PORT (default 5602), SHOT_DIR.
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdirSync } from 'fs';

const PORT = +(process.env.PORT ?? 5602);
const DIR = process.env.SHOT_DIR ?? '.';
mkdirSync(DIR, { recursive: true });
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
const fails = [];
const check = (ok, msg, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg} ${info}`); if (!ok) fails.push(msg); };

await page.goto(`http://localhost:${PORT}/#debugmobs`, { timeout: 180000 });
await page.waitForLoadState('networkidle', { timeout: 180000 });
await page.waitForTimeout(1500);
await page.locator('.mode-pick button', { hasText: 'Creative' }).click({ timeout: 120000 });
await page.locator('.create-btn').click({ timeout: 120000, noWaitAfter: true });
await page.waitForSelector('#loading.hidden', { timeout: 180000, state: 'attached' });
await page.waitForTimeout(2000);
await page.mouse.click(640, 360);

/** wait until the arena's chunks are generated and meshed */
async function settle(ms = 500) {
  await page.waitForFunction(() => {
    const g = window.__game, a = window.__arena;
    for (let cx = Math.floor((a.ox - 12) / 16); cx <= Math.floor((a.ox + 12) / 16); cx++) {
      for (let cz = Math.floor((a.oz - 12) / 16); cz <= Math.floor((a.oz + 12) / 16); cz++) {
        const k = `${cx},${cz}`, c = g.world.getChunk(cx, cz);
        if (!c || !c.ready || g.world.dirtySet.has(k) || g.meshInFlight.has(k)) return false;
      }
    }
    return true;
  }, null, { timeout: 60000, polling: 250 }).catch(() => console.log('  (mesh wait timed out)'));
  await page.waitForTimeout(ms);
}
const shot = (name) => page.screenshot({ path: `${DIR}/${name}.png` });

// --- soul light on special models ----------------------------------------------
await page.evaluate(() => {
  const g = window.__game, B = window.__B, w = g.world;
  g.entities.mobsEnabled = false;
  for (const e of g.entities.entities) if (g.entities.isMob(e)) e.dead = true;
  const Y = 108, ox = Math.round(g.player.pos.x), oz = Math.round(g.player.pos.z);
  window.__arena = { ox, oy: Y, oz };
  for (let x = ox - 12; x <= ox + 12; x++) for (let z = oz - 12; z <= oz + 12; z++) {
    for (let y = Y; y <= Y + 10; y++) w.setBlock(x, y, z, B.AIR);
    w.setBlock(x, Y - 1, z, B.STONE);
    w.setBlock(x, Y - 2, z, B.STONE);
  }
  // a back wall and roof keep the sky out so the block light reads clearly
  for (let x = ox - 12; x <= ox + 12; x++) for (let y = Y; y <= Y + 5; y++) w.setBlock(x, y, oz - 9, B.STONE);
  // two matching vignettes: soul lantern (left) and a plain lantern (right)
  const vignette = (cx, light) => {
    w.setBlock(cx, Y, oz - 6, light);
    w.setBlock(cx - 1, Y, oz - 6, B.POPPY);
    w.setBlock(cx + 1, Y, oz - 6, B.TALL_GRASS);
    w.setBlock(cx - 1, Y, oz - 5, B.STONE_SLAB);
    w.setBlock(cx + 1, Y, oz - 5, B.OAK_STAIRS);
    w.setBlock(cx, Y, oz - 7, B.OAK_FENCE);
    w.setBlock(cx - 2, Y, oz - 7, B.TORCH);
    w.setBlock(cx + 2, Y, oz - 7, B.LADDER);
    w.setBlock(cx - 2, Y, oz - 5, B.DANDELION);
  };
  vignette(ox - 3, B.SOUL_LANTERN);
  vignette(ox + 4, B.LANTERN);
  w.setBlock(ox + 1, Y, oz - 4, B.SOUL_TORCH);
  g.dayTime = 0.75; // midnight
  const p = g.player;
  p.flying = true;
  p.pos.x = ox + 0.5; p.pos.y = Y + 1.2; p.pos.z = oz + 0.5;
  p.vel.x = p.vel.y = p.vel.z = 0; p.yaw = 0; p.pitch = -0.32;
});
await settle(1500);
await shot('soul-light-night');
await page.evaluate(() => {
  const g = window.__game, p = g.player, { ox, oy, oz } = window.__arena;
  p.pos.x = ox - 2.5; p.pos.y = oy + 0.6; p.pos.z = oz - 2.2; p.pitch = -0.25; p.yaw = 0;
});
await page.waitForTimeout(800);
await shot('soul-light-close');

// --- blaze fight -------------------------------------------------------------------
const blaze = await page.evaluate(async () => {
  const g = window.__game, em = g.entities, B = window.__B, w = g.world, { ox, oy, oz } = window.__arena;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const p = g.player;
  g.dayTime = 0.25;
  p.mode = 'survival'; p.flying = false;
  p.pos.x = ox + 0.5; p.pos.y = oy; p.pos.z = oz + 4.5; p.yaw = 0; p.pitch = 0.1;
  p.hp = 20; p.fireT = 0; p.clearEffects();
  const out = {};
  // a real blaze volley: one should land and set the player alight
  const bz = em.spawnMob('blaze', ox + 0.5, oy + 0.6, oz - 2.5);
  bz.state = 'chase'; bz.stateTime = 999; bz.shootCooldown = 0;
  window.__blaze = bz;
  for (let i = 0; i < 60 && p.fireT <= 0; i++) { p.hp = 20; await wait(150); }
  out.burning = p.fireT > 0;
  out.cause = p.lastDamageCause;
  out.fireballs = em.entities.filter((e) => e.kind === 'arrow' && e.proj === 'small_fireball').length;
  return out;
});
await page.waitForTimeout(250);
await shot('blaze-fight-burning');
check(blaze.burning, 'a blaze fireball sets the player on fire', JSON.stringify(blaze));
check(blaze.cause === 'Fireballed by a Blaze' || blaze.cause.startsWith('Burnt to a crisp whilst fighting a Blaze'),
  'blaze fireball death message names the blaze', blaze.cause);

const proj = await page.evaluate(async () => {
  const g = window.__game, em = g.entities, B = window.__B, w = g.world, { ox, oy, oz } = window.__arena;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const p = g.player;
  for (const e of em.entities) if (em.isMob(e) || e.kind === 'arrow') e.dead = true;
  await wait(200);
  const out = {};
  const reset = async () => { p.hp = 20; p.fireT = 0; p.lastDamageCause = ''; p.vel.x = p.vel.z = 0; await wait(700); };
  const at = () => ({ x: p.pos.x, y: p.pos.y + 1.2, z: p.pos.z });
  // piglin crossbow bolt
  await reset();
  let t = at();
  em.shootArrow('piglin', t.x - 5, t.y, t.z, 1, 0.05, 0, 28, 4);
  await wait(900);
  out.piglin = p.lastDamageCause;
  // skeleton arrow
  await reset();
  t = at();
  em.shootArrow('skeleton', t.x - 5, t.y, t.z, 1, 0.05, 0, 22, 3);
  await wait(900);
  out.skeleton = p.lastDamageCause;
  // emberghast fireball: named, and no fire
  await reset();
  t = at();
  em.spawnFireball(t.x - 4, t.y, t.z, 1, 0, 0);
  await wait(1300);
  out.ghast = p.lastDamageCause;
  out.ghastFire = p.fireT;
  // blaze fireball vs Fire Resistance: no damage, no flames
  await reset();
  p.addEffect('fire_resistance', 60);
  t = at();
  em.spawnBlazeCharge(t.x - 4, t.y, t.z, 1, 0, 0);
  await wait(900);
  out.fireResHp = p.hp; out.fireResFire = p.fireT;
  p.clearEffects();
  // blaze fireball into a netherrack wall: the open cell in front catches
  // (netherrack underfoot keeps it burning for the screenshot)
  const wx = ox + 8;
  for (let y = oy; y <= oy + 2; y++) for (let z = oz - 1; z <= oz + 1; z++) w.setBlock(wx, y, z, B.NETHERRACK);
  for (let z = oz - 1; z <= oz + 1; z++) w.setBlock(wx - 1, oy - 1, z, B.NETHERRACK);
  // stand off to the side of the shot's path, looking at the wall
  p.pos.x = ox + 3.5; p.pos.z = oz + 3.5; p.yaw = Math.atan2(-4.5, 3); p.pitch = 0.05; p.hp = 20; p.fireT = 0;
  await wait(600);
  em.spawnBlazeCharge(wx - 5, oy + 0.5, oz + 0.5, 1, 0, 0);
  for (let i = 0; i < 20 && w.getBlock(wx - 1, oy, oz) !== B.FIRE; i++) await wait(100);
  out.wallFire = w.getBlock(wx - 1, oy, oz) === B.FIRE;
  out.fires = g.fire.count;
  // blazes are fire-immune: a fire charge / fireball never leaves one burning
  const b2 = em.spawnMob('blaze', ox - 6.5, oy + 0.6, oz + 0.5);
  em.setMobOnFire(b2, 5);
  const z2 = em.spawnMob('zombie', ox - 8.5, oy, oz + 0.5);
  em.setMobOnFire(z2, 5);
  out.blazeBurn = b2.burnT; out.zombieBurn = z2.burnT;
  b2.dead = true; z2.dead = true;
  return out;
});
await settle(300);
await shot('blaze-fire-on-wall');
console.log('projectiles', JSON.stringify(proj));
check(proj.piglin === 'Shot by a Piglin', 'piglin bolt names the piglin', proj.piglin);
check(proj.skeleton === 'Shot by a Skeleton', 'skeleton arrow names the skeleton', proj.skeleton);
check(proj.ghast === 'Fireballed by an Emberghast' && proj.ghastFire === 0, 'emberghast fireball named, no flames', proj.ghast);
check(proj.fireResHp === 20 && proj.fireResFire === 0, 'Fire Resistance shrugs off blaze fireballs');
check(proj.wallFire && proj.fires > 0, 'blaze fireball lights the wall it hits (tracked fire)');
check(proj.blazeBurn === 0 && proj.zombieBurn > 0, 'blazes are fire-immune, zombies burn');

// the two fireballs side by side, slowed to a crawl: blaze (small sprite) vs emberghast
await page.evaluate(() => {
  const g = window.__game, em = g.entities, p = g.player, { ox, oy, oz } = window.__arena;
  p.mode = 'creative'; p.flying = true;
  p.pos.x = ox + 0.5; p.pos.y = oy + 0.2; p.pos.z = oz + 3.5; p.yaw = 0; p.pitch = 0;
  em.spawnBlazeCharge(ox - 0.3, oy + 1.6, oz + 0.5, 0, 0, -1);
  em.spawnFireball(ox + 1.5, oy + 1.6, oz + 0.5, 0, 0, -1);
  for (const e of em.entities) if (e.kind === 'arrow' && e.proj !== 'arrow') { e.vel.z *= 0.01; }
});
await page.waitForTimeout(400);
await shot('fireball-looks');
await page.evaluate(() => { const p = window.__game.player; p.mode = 'survival'; p.flying = false; });

// --- wither -------------------------------------------------------------------------------
const wither = await page.evaluate(async () => {
  const g = window.__game, em = g.entities, { ox, oy, oz } = window.__arena;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const p = g.player;
  for (const e of em.entities) if (em.isMob(e)) e.dead = true;
  p.pos.x = ox + 0.5; p.pos.y = oy; p.pos.z = oz + 2.5; p.yaw = 0; p.pitch = 0;
  p.hp = 20; p.fireT = 0; p.clearEffects();
  const out = {};
  const ws = em.spawnMob('wither_skeleton', ox + 0.5, oy, oz + 1.2);
  ws.state = 'chase'; ws.stateTime = 999; ws.attackCooldown = 0;
  for (let i = 0; i < 40 && !p.effects.has('wither'); i++) await wait(100);
  ws.dead = true;
  out.withered = p.effects.has('wither');
  out.badge = [...document.querySelectorAll('#effect-list span')].map((s) => s.textContent).join('|');
  p.hp = 16;
  return out;
});
await page.waitForTimeout(600);
await shot('withered-hud');
await page.locator('#stats').screenshot({ path: `${DIR}/withered-hearts.png` }).catch(() => {});
const wither2 = await page.evaluate(async () => {
  const g = window.__game, p = g.player;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  // 1 damage per 2 s
  p.hp = 16; p.regenT = -1e9; p.hunger = 10;
  await wait(4300);
  out.hpAfter4s = p.hp;
  // persistence
  const s = p.serialize();
  out.saved = (s.effects ?? []).some((e) => e.id === 'wither');
  p.clearEffects();
  p.load({ ...s, x: p.pos.x, y: p.pos.y, z: p.pos.z });
  out.reloaded = p.effects.has('wither');
  // milk clears it
  p.applyFoodEffects(window.__findId('milk_bucket'));
  out.milked = !p.effects.has('wither');
  // and it can kill: "Withered away"
  p.addEffect('wither', 10, 0);
  p.hp = 1;
  for (let i = 0; i < 40 && !p.dead; i++) await wait(100);
  out.dead = p.dead;
  out.cause = p.lastDamageCause;
  out.deathText = document.querySelector('.death-cause')?.textContent ?? '';
  return out;
});
console.log('wither', JSON.stringify({ ...wither, ...wither2 }));
check(wither.withered, 'a wither skeleton cut applies the Wither effect');
check(/Wither/.test(wither.badge), 'Wither badge shows in the effect list', wither.badge);
check(wither2.hpAfter4s >= 13 && wither2.hpAfter4s <= 15, 'Wither deals 1 damage per 2 s', `hp=${wither2.hpAfter4s}`);
check(wither2.saved && wither2.reloaded, 'Wither persists with the player save');
check(wither2.milked, 'milk clears Wither');
check(wither2.dead && wither2.cause === 'Withered away', 'Wither kills with "Withered away"', wither2.cause);
await page.waitForTimeout(1200);
await shot('withered-death');

console.log(errors.length ? `console errors:\n${errors.slice(0, 8).join('\n')}` : 'console errors: NONE');
await browser.close();
await server.close();
process.exit(fails.length || errors.length ? 1 : 0);
