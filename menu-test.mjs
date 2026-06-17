// Title-screen test: create a named world, return to menu, confirm it lists,
// and that a second world can be created (unlimited) + deleted.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { port: 5212 } });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on('dialog', (d) => d.accept()); // auto-confirm the delete prompt

await page.goto('http://localhost:5212/');
await page.waitForTimeout(1200);
await page.screenshot({ path: 'shot-title.png' });

// create a named world
await page.fill('.menu-input', 'My Base');
await page.locator('.create-btn').click();
await page.waitForSelector('#loading.hidden', { timeout: 60000, state: 'attached' });
await page.waitForTimeout(1500);
// back to menu: lock the pointer then exit it (pause), Save and Quit
await page.mouse.click(640, 360);
await page.waitForTimeout(300);
await page.evaluate(() => document.exitPointerLock());
await page.waitForTimeout(500);
await page.locator('#pause-overlay button', { hasText: 'Save and Quit' }).click();
await page.waitForTimeout(2000);
await page.screenshot({ path: 'shot-title-listed.png' });
const listed = await page.locator('.world-row .wname', { hasText: 'My Base' }).count();
console.log('named world listed:', listed > 0 ? 'OK' : 'FAIL');

// delete it
await page.locator('.world-row', { hasText: 'My Base' }).locator('button', { hasText: 'Delete' }).click();
await page.waitForTimeout(1200);
const afterDelete = await page.locator('.world-row .wname', { hasText: 'My Base' }).count();
console.log('world removed after delete:', afterDelete === 0 ? 'OK' : 'FAIL');

console.log('console errors:', errors.length ? errors.slice(0, 8).join('\n') : 'NONE');
await browser.close();
await server.close();
process.exit(listed > 0 && afterDelete === 0 && errors.length === 0 ? 0 : 1);
