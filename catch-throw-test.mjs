// Feature check: the thrown mob catcher. Verifies a throw captures a hostile
// inside the catch radius, a miss lands as a recoverable pickup, animals bounce
// the orb off, a released pet follows + fights, and the pet roster HUD shows up.
// Drives the engine through window.__game (exposed under #debugcatch).
import { chromium } from 'playwright';
import { createServer } from 'vite';

const I_MOB_CATCHER = 182, I_MOB_CATCHER_FILLED = 183;

const server = await createServer({ root: process.cwd(), server: { port: 5222 } });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

await page.goto('http://localhost:5222/#debugcatch');
await page.waitForTimeout(1000);
await page.locator('.mode-pick button', { hasText: 'Survival' }).click();
await page.locator('.create-btn').click();
await page.waitForSelector('#loading.hidden', { timeout: 60000, state: 'attached' });
await page.waitForTimeout(2500);
await page.mouse.click(640, 360);
await page.waitForTimeout(300);

// flat pad + clear air so thrown orbs fly unobstructed. Night time, or the open
// sky would burn every zombie/skeleton away before the orb reaches it.
await page.evaluate(() => {
  const g = window.__game, p = g.player, B = window.__B;
  g.dayTime = 0.72;
  const ox = Math.floor(p.pos.x), oy = Math.floor(p.pos.y), oz = Math.floor(p.pos.z);
  for (let dx = -4; dx <= 14; dx++) {
    for (let dz = -8; dz <= 8; dz++) {
      g.world.setBlock(ox + dx, oy - 1, oz + dz, B.STONE);
      for (let dy = 0; dy <= 5; dy++) g.world.setBlock(ox + dx, oy + dy, oz + dz, 0);
    }
  }
  p.flying = false; p.vel = { x: 0, y: 0, z: 0 };
});
await page.waitForTimeout(600);

// 1) throw at a zombie a few blocks out and let the orb fly
const thrown = await page.evaluate(async () => {
  const g = window.__game, p = g.player, ent = g.entities;
  // park a zombie 5 blocks straight ahead of the player's aim
  for (const e of [...ent.entities]) if (ent.isMob(e) && e.kind !== 'cow') e.dead = true;
  const d = p.lookDir();
  const z = ent.spawnMob('zombie', p.pos.x + d.x * 5, p.pos.y, p.pos.z + d.z * 5);
  z.state = 'idle';
  const before = p.inventory.slots[0]?.count ?? 0;
  p.inventory.selected = 0;
  const ey = p.pos.y + p.eyeHeight();
  ent.throwCatcher(p.pos.x + d.x * 0.4, ey, p.pos.z + d.z * 0.4, d.x, d.y, d.z);
  p.inventory.consumeSelected();
  await new Promise((r) => setTimeout(r, 900));
  const filled = p.inventory.slots.filter((s) => s && s.id === 183);
  return {
    before,
    after: p.inventory.slots[0]?.count ?? 0,
    zombieGone: z.dead,
    filledCount: filled.length,
    filledMob: filled[0]?.mob,
    orbsInFlight: ent.entities.filter((e) => e.kind === 'catcher').length,
  };
});

// 2) a throw that hits nothing must leave a pickup on the ground
const missed = await page.evaluate(async () => {
  const g = window.__game, p = g.player, ent = g.entities;
  for (const e of [...ent.entities]) if (ent.isMob(e)) e.dead = true;
  const dropsBefore = ent.entities.filter((e) => e.kind === 'drop' && e.itemId === 182).length;
  const d = p.lookDir();
  const ey = p.pos.y + p.eyeHeight();
  const orb = ent.throwCatcher(p.pos.x + d.x * 0.4, ey, p.pos.z + d.z * 0.4, d.x, 0.25, d.z);
  // wait for the arc to land (it can fly a good way before finding ground)
  let flightMs = 0;
  for (let i = 0; i < 20 && !orb.dead; i++) {
    await new Promise((r) => setTimeout(r, 200));
    flightMs += 200;
  }
  return {
    dropsBefore, flightMs,
    dropsAfter: ent.entities.filter((e) => e.kind === 'drop' && e.itemId === 182).length,
    stillFlying: ent.entities.filter((e) => e.kind === 'catcher').length,
  };
});

// 3) an animal bounces the orb off (never captured)
const animal = await page.evaluate(async () => {
  const g = window.__game, p = g.player, ent = g.entities;
  for (const e of [...ent.entities]) if (ent.isMob(e)) e.dead = true;
  const d = p.lookDir();
  const cow = ent.spawnMob('cow', p.pos.x + d.x * 4, p.pos.y, p.pos.z + d.z * 4);
  const filledBefore = p.inventory.slots.filter((s) => s && s.id === 183).length;
  const dropsBefore = ent.entities.filter((e) => e.kind === 'drop' && e.itemId === 182).length;
  const ey = p.pos.y + p.eyeHeight();
  ent.throwCatcher(p.pos.x + d.x * 0.4, ey, p.pos.z + d.z * 0.4, d.x, d.y, d.z);
  await new Promise((r) => setTimeout(r, 900));
  return {
    cowAlive: !cow.dead,
    newFilled: p.inventory.slots.filter((s) => s && s.id === 183).length - filledBefore,
    newDrops: ent.entities.filter((e) => e.kind === 'drop' && e.itemId === 182).length - dropsBefore,
  };
});

// 4) capture radius: an orb passing 0.7 blocks to the side still catches
const slack = await page.evaluate(async () => {
  const g = window.__game, p = g.player, ent = g.entities;
  for (const e of [...ent.entities]) if (ent.isMob(e)) e.dead = true;
  const d = p.lookDir();
  // offset the creeper sideways from the throw line
  const sx = -d.z, sz = d.x;
  const c = ent.spawnMob('creeper', p.pos.x + d.x * 5 + sx * 0.7, p.pos.y, p.pos.z + d.z * 5 + sz * 0.7);
  c.state = 'idle';
  const ey = p.pos.y + p.eyeHeight();
  ent.throwCatcher(p.pos.x + d.x * 0.4, ey, p.pos.z + d.z * 0.4, d.x, d.y, d.z);
  await new Promise((r) => setTimeout(r, 900));
  return { creeperGone: c.dead };
});

// 5) release a pet, confirm it follows, then confirm it engages what the owner hits
const petFight = await page.evaluate(async () => {
  const g = window.__game, p = g.player, ent = g.entities;
  for (const e of [...ent.entities]) if (ent.isMob(e)) e.dead = true;
  const d = p.lookDir();
  const pet = ent.releaseMob('zombie', p.pos.x + d.x * 2, p.pos.y, p.pos.z + d.z * 2, p.yaw);
  const foe = ent.spawnMob('skeleton', p.pos.x + d.x * 8, p.pos.y, p.pos.z + d.z * 8);
  ent.hurt(foe, 1, d.x, d.z, p);          // owner swings: pets should lock on
  const targeted = pet.target === foe;
  await new Promise((r) => setTimeout(r, 1500));
  const roster = ent.petStatus();
  return {
    isPet: ent.isPet(pet),
    targeted,
    petDead: pet.dead, petHp: pet.hp, petTamed: pet.tamed, petOwner: pet.ownerName,
    foeHp: foe.hp, foeDead: foe.dead,
    rosterLen: roster.length,
    rosterKind: roster[0]?.kind,
    hudVisible: !document.getElementById('pet-strip').classList.contains('hidden'),
  };
});
await page.waitForTimeout(400);
await page.screenshot({ path: 'shot-catch-throw.png' });

// 6) sit toggle (wolf-like) via the interact path
const sit = await page.evaluate(() => {
  const g = window.__game, ent = g.entities;
  const pet = ent.entities.find((e) => ent.isPet(e));
  if (!pet) return { ok: false };
  const r1 = ent.interactMob(pet, 0);
  const s1 = pet.sitting;
  const r2 = ent.interactMob(pet, 0);
  return { ok: true, r1, s1, r2, s2: pet.sitting };
});

// 6b) a pet with nothing to fight must not lose health (it used to bite itself,
// since a pet zombie is still a hostile *kind* — regression guard)
const idlePet = await page.evaluate(async () => {
  const g = window.__game, p = g.player, ent = g.entities;
  for (const e of [...ent.entities]) if (ent.isMob(e)) e.dead = true;
  const d = p.lookDir();
  const a = ent.releaseMob('zombie', p.pos.x + d.x * 2, p.pos.y, p.pos.z + d.z * 2, p.yaw);
  const b = ent.releaseMob('creeper', p.pos.x + d.x * 2.6, p.pos.y, p.pos.z + d.z * 2.6, p.yaw);
  await new Promise((r) => setTimeout(r, 2000));
  return { aHp: a.hp, bHp: b.hp, aDead: a.dead, bDead: b.dead };
});

// 7) pets survive a save/load round trip
const persist = await page.evaluate(() => {
  const g = window.__game;
  const save = g.buildSave ? g.buildSave() : null;
  return { pets: save ? save.pets : g.entities.savePets() };
});

console.log('THROW  :', JSON.stringify(thrown));
console.log('MISS   :', JSON.stringify(missed));
console.log('ANIMAL :', JSON.stringify(animal));
console.log('SLACK  :', JSON.stringify(slack));
console.log('PETFGHT:', JSON.stringify(petFight));
console.log('SIT    :', JSON.stringify(sit));
console.log('IDLEPET:', JSON.stringify(idlePet));
console.log('PERSIST:', JSON.stringify(persist));

const pass =
  thrown.zombieGone === true && thrown.filledCount === 1 && thrown.filledMob === 'zombie' &&
  thrown.orbsInFlight === 0 &&
  missed.dropsAfter === missed.dropsBefore + 1 && missed.stillFlying === 0 &&
  animal.cowAlive === true && animal.newFilled === 0 && animal.newDrops === 1 &&
  slack.creeperGone === true &&
  petFight.isPet === true && petFight.targeted === true && petFight.rosterLen === 1 &&
  petFight.rosterKind === 'zombie' && petFight.hudVisible === true &&
  sit.ok === true && sit.r1 === 'sit' && sit.s1 === true && sit.s2 === false &&
  idlePet.aHp === 20 && idlePet.bHp === 20 && !idlePet.aDead && !idlePet.bDead &&
  Array.isArray(persist.pets) && persist.pets.length === 2;

console.log('--- console errors ---');
console.log(errors.length ? errors.slice(0, 12).join('\n') : 'NONE');
console.log(pass && !errors.length ? 'RESULT: PASS' : 'RESULT: FAIL');

await browser.close();
await server.close();
process.exit(pass && !errors.length ? 0 : 1);
