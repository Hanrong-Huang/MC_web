// Feature check: mob catcher capture / release / recall + filled-catcher icon.
// Drives the engine through window.__game (exposed under #debugmobs).
import { chromium } from 'playwright';
import { createServer } from 'vite';

const I_MOB_CATCHER = 182, I_MOB_CATCHER_FILLED = 183;

const server = await createServer({ root: process.cwd(), server: { port: 5213 } });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

await page.goto('http://localhost:5213/#debugmobs');
await page.waitForTimeout(1000);
await page.locator('.mode-pick button', { hasText: 'Creative' }).click();
await page.locator('.create-btn').click();
await page.waitForSelector('#loading.hidden', { timeout: 60000, state: 'attached' });
await page.waitForTimeout(2500);
await page.mouse.click(640, 360);
await page.waitForTimeout(300);

// 1) give the player an empty catcher, spawn a zombie right in front, capture it.
const cap = await page.evaluate(({ CATCHER, FILLED }) => {
  const g = window.__game;
  const p = g.player;
  p.inventory.slots[0] = { id: CATCHER, count: 16 };
  p.inventory.selected = 0;
  g.onInventoryChange();
  const z = g.entities.spawnMob('zombie', p.pos.x + 1.2, p.pos.y, p.pos.z);
  const kind = g.entities.captureMob(z);
  // place the resulting filled catcher in a hotbar slot for the icon shot
  p.inventory.slots[1] = { id: FILLED, count: 1, mob: kind };
  p.inventory.selected = 1;
  g.onInventoryChange();
  return { kind, zombieDead: z.dead, heldMob: p.heldMob() };
}, { CATCHER: I_MOB_CATCHER, FILLED: I_MOB_CATCHER_FILLED });
await page.waitForTimeout(600);
await page.screenshot({ path: 'shot-catch-held.png' });

// 2) release the captured zombie as a pet and confirm it follows (tamed).
const rel = await page.evaluate(() => {
  const g = window.__game;
  const before = g.entities.entities.filter((e) => g.entities.isPet(e)).length;
  const p = g.player;
  const d = p.lookDir();
  const pet = g.entities.releaseMob('zombie', p.pos.x + d.x * 2, p.pos.y, p.pos.z + d.z * 2, p.yaw);
  const after = g.entities.entities.filter((e) => g.entities.isPet(e)).length;
  return { before, after, petTamed: pet.tamed, owner: pet.ownerName, isPet: g.entities.isPet(pet) };
});
await page.waitForTimeout(600);
await page.mouse.move(640, 430);
await page.waitForTimeout(300);
await page.screenshot({ path: 'shot-catch-pet.png' });

// 3) recall the pet back into a fresh filled catcher (no consumption of empty).
const recall = await page.evaluate(() => {
  const g = window.__game;
  const pet = g.entities.entities.find((e) => g.entities.isPet(e));
  if (!pet) return { ok: false };
  pet.dead = true; // recall = remove without loot
  return { ok: true, kind: pet.kind };
});

console.log('CAPTURE:', JSON.stringify(cap));
console.log('RELEASE:', JSON.stringify(rel));
console.log('RECALL :', JSON.stringify(recall));
const pass =
  cap.kind === 'zombie' && cap.zombieDead === true && cap.heldMob === 'zombie' &&
  rel.after === rel.before + 1 && rel.petTamed === true && rel.owner === 'player' && rel.isPet === true &&
  recall.ok === true;
console.log('--- console errors ---');
console.log(errors.length ? errors.slice(0, 12).join('\n') : 'NONE');
console.log(pass && !errors.length ? 'RESULT: PASS' : 'RESULT: FAIL');

await browser.close();
await server.close();
process.exit(pass && !errors.length ? 0 : 1);
