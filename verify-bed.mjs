// Look at the #debugmobs bed (one block east, foot level) to confirm it now
// renders as a flat mattress rather than a full cube.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { port: 5205 } });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

await page.goto('http://localhost:5205/#debugmobs');
await page.waitForTimeout(1200);
await page.locator('.create-btn').click();
await page.waitForSelector('#loading.hidden', { timeout: 60000, state: 'attached' });
await page.waitForTimeout(2500);

// back off west + up and look at the bed obliquely to judge its height/profile
await page.evaluate(() => {
  const p = window.__game.player;
  const bedX = Math.floor(p.pos.x) + 1, bedY = Math.floor(p.pos.y), bedZ = Math.floor(p.pos.z);
  p.flying = true; p.vel = { x: 0, y: 0, z: 0 };
  p.pos.x = bedX - 2.0; p.pos.y = bedY + 1.4; p.pos.z = bedZ + 0.5;
  p.yaw = -Math.PI / 2;   // look east (+x) at the bed
  p.pitch = -0.45;        // steeper downward tilt for a close oblique profile
});
await page.waitForTimeout(1000);
await page.screenshot({ path: 'bed-shape.png' });

console.log('--- console errors ---');
console.log(errors.length ? errors.slice(0, 8).join('\n') : 'NONE');
await browser.close();
await server.close();
process.exit(errors.length ? 1 : 0);
