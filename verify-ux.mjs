// Headless check for the new item UX: hover tooltips, shift-click quick-move,
// and that the audio volume API exists. Boots with #debugmobs (stocks tools).
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { port: 5202 } });
await server.listen();

const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

await page.goto('http://localhost:5202/#debugmobs');
await page.waitForTimeout(1200);
await page.locator('.create-btn').waitFor({ timeout: 5000 });
await page.locator('.create-btn').click();
await page.waitForSelector('#loading.hidden', { timeout: 60000, state: 'attached' });
await page.waitForTimeout(2500);

// Open the inventory via the dev hook (E needs pointer lock, unavailable headless)
await page.evaluate(() => window.__game.openInventory());
await page.waitForTimeout(400);

// dump hotbar slots so we can target a real item
const slots = await page.evaluate(() => window.__game.player.inventory.slots.map((s) => s && s.id));
console.log('hotbar/main slot ids:', slots.slice(0, 12).join(','));

// hover the first non-empty hotbar slot → tooltip should appear with a name
const firstFilled = slots.findIndex((s, i) => s != null && i < 9);
let tipOk = false, tipText = '';
if (firstFilled >= 0) {
  const box = await page.locator('#hotbar .hotbar-slot').nth(firstFilled).boundingBox()
    .catch(() => null);
  // hotbar isn't in the container; the container has its own hotbar row at the bottom.
  const ctrSlots = page.locator('#container-screen .mc-slot');
  const n = await ctrSlots.count();
  // the last 9 slots in the panel are the hotbar row
  const target = await ctrSlots.nth(Math.max(0, n - 9 + firstFilled)).boundingBox();
  if (target) {
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
    await page.waitForTimeout(200);
    tipOk = await page.evaluate(() => !document.getElementById('item-tooltip').classList.contains('hidden'));
    tipText = await page.evaluate(() => document.getElementById('item-tooltip').innerText);
  }
}
console.log('tooltip visible:', tipOk, '| text:', JSON.stringify(tipText));

// shift-click quick-move: take inventory snapshot, shift-click a filled hotbar
// slot (should jump to the main grid), confirm the array changed
const before = await page.evaluate(() => JSON.stringify(window.__game.player.inventory.slots.map((s) => s && [s.id, s.count])));
if (firstFilled >= 0) {
  const ctrSlots = page.locator('#container-screen .mc-slot');
  const n = await ctrSlots.count();
  const target = await ctrSlots.nth(n - 9 + firstFilled).boundingBox();
  if (target) {
    await page.keyboard.down('Shift');
    await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
    await page.keyboard.up('Shift');
    await page.waitForTimeout(200);
  }
}
const after = await page.evaluate(() => JSON.stringify(window.__game.player.inventory.slots.map((s) => s && [s.id, s.count])));
console.log('shift-move changed inventory:', before !== after);

// volume API
const volOk = await page.evaluate(() => {
  const a = window.__game.audio; const v0 = a.volume; a.setVolume(0.4);
  const ok = Math.abs(a.volume - 0.4) < 1e-6; a.setVolume(v0); return ok;
});
console.log('volume API works:', volOk);

await page.screenshot({ path: 'verify-ux.png' });
console.log('--- console errors ---');
console.log(errors.length ? errors.slice(0, 8).join('\n') : 'NONE');

await browser.close();
await server.close();
process.exit(errors.length || !tipOk ? 1 : 0);
