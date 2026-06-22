// Screenshot the first-person bow draw to inspect arrow/bow orientation.
// #debugmobs stocks a BOW at hotbar slot 3; #bowtest forces a full draw.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { port: 5221 } });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://localhost:5221/#debugmobs,bowtest');
await page.waitForTimeout(1000);
await page.locator('.mode-pick button', { hasText: 'Creative' }).click();
await page.locator('.create-btn').click();
await page.waitForSelector('#loading.hidden', { timeout: 60000, state: 'attached' });
await page.waitForTimeout(1500);
await page.evaluate(() => { window.__game.player.inventory.selected = 3; }); // bow
await page.waitForTimeout(1200);
await page.screenshot({ path: 'shot-bow.png' });
console.log('saved shot-bow.png');
await browser.close();
await server.close();
