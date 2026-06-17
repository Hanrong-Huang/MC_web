// Held-bow check: select the bow (debug kit slot 4), screenshot idle, then
// hold right-click to draw and screenshot the drawn pose.
import { chromium } from 'playwright';
import { createServer } from 'vite';

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
await page.waitForTimeout(2000);
await page.mouse.click(640, 360);
await page.waitForTimeout(300);
await page.keyboard.press('Digit4'); // bow slot in the debug kit
await page.waitForTimeout(500);
await page.screenshot({ path: 'shot-bow-idle.png' });

// draw the bow
await page.mouse.down({ button: 'right' });
await page.waitForTimeout(900);
await page.screenshot({ path: 'shot-bow-draw.png' });
await page.mouse.up({ button: 'right' });

console.log('console errors:', errors.length ? errors.slice(0, 8).join('\n') : 'NONE');
await browser.close();
await server.close();
process.exit(errors.length ? 1 : 0);
