// Persistence test: create a world, move, pause via pointer-lock exit,
// Save & Quit, then re-enter the world and confirm the position was restored.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { port: 5195 } });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}\n${e.stack}`));

await page.goto('http://localhost:5195/');
await page.waitForTimeout(1200);
await page.locator('.world-row button', { hasText: 'Create' }).first().click();
await page.waitForSelector('#loading.hidden', { timeout: 60000, state: 'attached' });
await page.waitForTimeout(2000);

await page.mouse.click(640, 360);
await page.waitForTimeout(400);
// walk to a new spot
await page.keyboard.down('KeyW');
await page.waitForTimeout(2000);
await page.keyboard.up('KeyW');
await page.keyboard.press('F3');
await page.waitForTimeout(600);
const posBefore = await page.evaluate(() => document.getElementById('debug')?.innerText.split('\n')[1]);
console.log('pos before save:', posBefore);

// open pause by exiting pointer lock, then Save & Quit
await page.evaluate(() => document.exitPointerLock());
await page.waitForTimeout(600);
const paused = await page.evaluate(() => !document.getElementById('pause-overlay').classList.contains('hidden'));
console.log('pause menu open:', paused);
await page.locator('#pause-overlay button', { hasText: 'Save and Quit' }).click();
await page.waitForTimeout(2500);

const menuVisible = await page.evaluate(() => !document.getElementById('menu').classList.contains('hidden'));
console.log('back at menu:', menuVisible);
const hasPlay = await page.locator('.world-row button', { hasText: 'Play' }).count();
console.log('saved world rows with Play:', hasPlay);

// re-enter
await page.locator('.world-row button', { hasText: 'Play' }).first().click();
await page.waitForSelector('#loading.hidden', { timeout: 60000, state: 'attached' });
await page.waitForTimeout(2000);
// debug overlay visibility persists across sessions; it is already on
const posAfter = await page.evaluate(() => document.getElementById('debug')?.innerText.split('\n')[1]);
console.log('pos after load: ', posAfter);

console.log('--- console errors ---');
console.log(errors.length ? errors.slice(0, 10).join('\n') : 'NONE');
await browser.close();
await server.close();
process.exit(errors.length ? 1 : 0);
