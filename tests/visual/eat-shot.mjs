// Screenshot the eating animation: survival, hungry, holding an apple, right-click held.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { port: 5224 } });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://localhost:5224/#debugmobs');
await page.waitForTimeout(1000);
await page.locator('.mode-pick button', { hasText: 'Survival' }).click();
await page.locator('.create-btn').click();
await page.waitForSelector('#loading.hidden', { timeout: 60000, state: 'attached' });
await page.waitForTimeout(1500);

await page.evaluate(() => {
  const g = window.__game;
  g.player.flying = true;
  g.player.pos.y += 25;                         // rise above the debug bed
  g.player.pitch = 0.5;                         // look down at open ground
  g.player.yaw = 0;
  g.player.inventory.slots[4] = { id: g.player.inventory.slots[4].id, count: 64 };
  g.player.hunger = 4;                          // hungry so eating proceeds
});
await page.keyboard.press('Digit5');            // select the apple via the real path
const dbg = await page.evaluate(() => ({ heldId: window.__game.player.heldId() }));
console.log('debug:', JSON.stringify(dbg));
// keep the bite held and hunger low so eating stays active across frames
await page.evaluate(() => {
  const g = window.__game;
  window.__eatHold = setInterval(() => { g.input.touchActive = true; g.input.rightDown = true; g.player.hunger = 4; }, 16);
});
await page.waitForTimeout(450);                // mid-chew
const eating = await page.evaluate(() => ({ eating: window.__game.player.eating, held: window.__game.player.heldId() }));
console.log('eating:', JSON.stringify(eating));
await page.screenshot({ path: 'shot-eat.png' });
console.log('saved shot-eat.png');
await browser.close();
await server.close();
