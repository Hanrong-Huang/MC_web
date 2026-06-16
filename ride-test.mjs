// Riding/mob check: spawn debug mobs, sweep view + right-click to mount a horse,
// then ride forward. Verifies the new mob/riding/animation code runs cleanly.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { port: 5198 } });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

await page.goto('http://localhost:5198/#debugmobs');
await page.waitForTimeout(1000);

// creative, World 3
await page.locator('.mode-pick button', { hasText: 'Creative' }).click();
await page.locator('.world-row', { hasText: 'World 3' }).locator('button', { hasText: 'Create' }).click();
await page.waitForSelector('#loading.hidden', { timeout: 60000, state: 'attached' });
await page.waitForTimeout(2500);

// capture mouse — player already faces the horse (dev hook)
await page.mouse.click(640, 360);
await page.waitForTimeout(500);
await page.screenshot({ path: 'shot-mobs.png' }); // horse/wolf/cat in view

// right-click to mount the horse ahead
await page.mouse.down({ button: 'right' });
await page.waitForTimeout(200);
await page.mouse.up({ button: 'right' });
await page.waitForTimeout(300);
await page.screenshot({ path: 'shot-ride-mounted.png' });

// try to ride forward + jump
await page.keyboard.down('KeyW');
await page.waitForTimeout(1200);
await page.keyboard.press('Space');
await page.waitForTimeout(800);
await page.keyboard.up('KeyW');
await page.screenshot({ path: 'shot-ride-move.png' });

// dismount
await page.keyboard.press('Shift');
await page.waitForTimeout(600);

// aerial top-down to reveal the mob models on the ground near spawn
await page.keyboard.press('KeyF'); // fly
await page.keyboard.down('Space');
await page.waitForTimeout(1600);
await page.keyboard.up('Space');
await page.mouse.move(640, 720); // pitch fully down
await page.waitForTimeout(800);
await page.screenshot({ path: 'shot-mobs-aerial.png' });

console.log('--- console errors ---');
console.log(errors.length ? errors.slice(0, 12).join('\n') : 'NONE');
await browser.close();
await server.close();
process.exit(errors.length ? 1 : 0);
