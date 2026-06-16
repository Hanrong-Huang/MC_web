// Sleep test: at night (no monsters), right-click the bed and confirm the fade
// transition skips to a bright morning with no errors.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { port: 5200 } });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

// night + debug spawns (mobs are passive here so sleep is allowed)
await page.goto('http://localhost:5200/#night-debugmobs');
await page.waitForTimeout(1000);
await page.locator('.mode-pick button', { hasText: 'Creative' }).click();
await page.locator('.world-row', { hasText: 'World 2' }).locator('button', { hasText: 'Create' }).click();
await page.waitForSelector('#loading.hidden', { timeout: 60000, state: 'attached' });
await page.waitForTimeout(2000);
await page.mouse.click(640, 360);
await page.waitForTimeout(300);
await page.screenshot({ path: 'shot-sleep-night.png' });

// pitch down to the bed in front, then right-click to sleep
await page.mouse.move(640, 620);
await page.waitForTimeout(200);
for (let i = 0; i < 4; i++) {
  await page.mouse.down({ button: 'right' });
  await page.waitForTimeout(120);
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(150);
}
// mid-fade (black) capture
await page.waitForTimeout(700);
await page.screenshot({ path: 'shot-sleep-fade.png' });
// after the full transition
await page.waitForTimeout(1600);
await page.screenshot({ path: 'shot-sleep-morning.png' });

console.log(errors.length ? errors.slice(0, 12).join('\n') : 'NONE');
await browser.close();
await server.close();
process.exit(errors.length ? 1 : 0);
