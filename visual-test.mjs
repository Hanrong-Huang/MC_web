// Visual check: creative world at daytime, look around, place/break, screenshots.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { port: 5197 } });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

await page.goto('http://localhost:5197/');
await page.waitForTimeout(1200);
await page.screenshot({ path: 'shot-menu.png' });

// creative mode, World_2
await page.locator('.mode-pick button', { hasText: 'Creative' }).click();
await page.locator('.world-row', { hasText: 'World 2' }).locator('button', { hasText: 'Create' }).click();
await page.waitForSelector('#loading.hidden', { timeout: 60000, state: 'attached' });
await page.waitForTimeout(2500);

// capture mouse, look slightly down, walk forward
await page.mouse.click(640, 360);
await page.waitForTimeout(400);
await page.mouse.move(640, 360);
await page.mouse.move(700, 480); // pitch down + yaw a bit (pointer-locked: deltas)
await page.waitForTimeout(300);
await page.keyboard.down('KeyW');
await page.waitForTimeout(1500);
await page.keyboard.up('KeyW');
await page.waitForTimeout(1500);
await page.screenshot({ path: 'shot-world.png' });

// fly up for an aerial view
await page.keyboard.press('KeyF');
await page.keyboard.down('Space');
await page.waitForTimeout(2300);
await page.keyboard.up('Space');
await page.mouse.move(640, 500); // look further down
await page.waitForTimeout(1200);
await page.screenshot({ path: 'shot-aerial.png' });

// break a block (creative instant) while aimed down
await page.mouse.move(640, 100);
await page.keyboard.press('KeyF'); // stop flying, fall
await page.waitForTimeout(1500);
await page.mouse.down();
await page.waitForTimeout(300);
await page.mouse.up();
await page.waitForTimeout(800);
await page.screenshot({ path: 'shot-interact.png' });

console.log('--- console errors ---');
console.log(errors.length ? errors.slice(0, 10).join('\n') : 'NONE');
await browser.close();
await server.close();
process.exit(errors.length ? 1 : 0);
