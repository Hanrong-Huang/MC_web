// Visual check: spawn the debug mobs in daylight and capture the scene, then
// cycle the hotbar to view held tools/weapons.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { port: 5211 } });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

await page.goto('http://localhost:5211/#debugmobs');
await page.waitForTimeout(1000);
await page.locator('.mode-pick button', { hasText: 'Creative' }).click();
await page.locator('.create-btn').click();
await page.waitForSelector('#loading.hidden', { timeout: 60000, state: 'attached' });
await page.waitForTimeout(2500);
await page.mouse.click(640, 360);
await page.waitForTimeout(300);
// no walking (avoids terrain). pan the view across the mobs spread out at +x.
await page.mouse.move(520, 430); // pan left + slight down: pig / wolf
await page.waitForTimeout(300);
await page.screenshot({ path: 'shot-mobs-left.png' });
await page.mouse.move(760, 430); // pan right: cow / cat / chicken
await page.waitForTimeout(300);
await page.screenshot({ path: 'shot-mobs-right.png' });

// held tools: slots are diamond sword/pick/axe/bow
for (let slot = 1; slot <= 3; slot++) {
  await page.keyboard.press(String(slot));
  await page.waitForTimeout(450);
  await page.screenshot({ path: `shot-held-${slot}.png` });
}

console.log(errors.length ? errors.slice(0, 12).join('\n') : 'NONE');
await browser.close();
await server.close();
process.exit(errors.length ? 1 : 0);
