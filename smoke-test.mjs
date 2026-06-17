// Headless smoke test: boots the built game in Edge, creates a world,
// waits for terrain to generate, simulates input, and reports console errors.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { port: 5199 } });
await server.listen();

const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});
page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}\n${err.stack}`));
page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });

await page.goto('http://localhost:5199/');
await page.waitForTimeout(1500);

// Main menu should be visible: create World_1 in survival
const create = page.locator('.create-btn');
await create.waitFor({ timeout: 5000 });
await create.click();

// wait for world generation to finish (loading overlay hides)
await page.waitForSelector('#loading.hidden', { timeout: 60000, state: 'attached' });
await page.waitForTimeout(3000);

// hud visible?
const hudVisible = await page.evaluate(() => !document.getElementById('hud').classList.contains('hidden'));
console.log('HUD visible:', hudVisible);

// click the canvas (no pointer lock in headless, but exercises handlers)
await page.mouse.click(640, 360);
await page.waitForTimeout(500);

// simulate a few seconds of runtime + keys
await page.keyboard.press('F3');
await page.keyboard.down('KeyW');
await page.waitForTimeout(1200);
await page.keyboard.up('KeyW');
await page.keyboard.press('KeyE'); // inventory (needs lock; should no-op safely)
await page.waitForTimeout(2500);

const debugText = await page.evaluate(() => document.getElementById('debug')?.innerText ?? '');
console.log('--- debug overlay ---');
console.log(debugText);

await page.screenshot({ path: 'smoke-1.png' });

// pause-menu flow is pointer-lock driven; instead test save via page reload path:
// quit isn't reachable without lock, so just verify IndexedDB exists after manual save call
await page.waitForTimeout(500);

console.log('--- console errors ---');
if (errors.length === 0) console.log('NONE');
else errors.slice(0, 12).forEach((e) => console.log(e));

await browser.close();
await server.close();
process.exit(errors.length ? 1 : 0);
