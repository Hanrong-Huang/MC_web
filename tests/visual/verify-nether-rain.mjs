// Confirm weather is suppressed in the Nether: force a thunderstorm in the
// overworld, then flip the dimension and verify the weather clears out.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { port: 5206 } });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

await page.goto('http://localhost:5206/#debugmobs');
await page.waitForTimeout(1200);
await page.locator('.create-btn').click();
await page.waitForSelector('#loading.hidden', { timeout: 60000, state: 'attached' });
await page.waitForTimeout(2500);

// force a thunderstorm and let it ramp up in the overworld
await page.evaluate(() => window.__game.weather.setKind('thunder'));
await page.waitForTimeout(2500);
const storm = await page.evaluate(() => ({
  kind: window.__game.weather.kind,
  intensity: +window.__game.weather.intensity.toFixed(2),
}));
console.log('overworld storm:', JSON.stringify(storm));

// switch to the Nether dimension; the render loop suppresses weather each frame
await page.evaluate(() => { window.__game.world.dimension = 'nether'; });
await page.waitForTimeout(2500);
const nether = await page.evaluate(() => ({
  kind: window.__game.weather.kind,
  intensity: +window.__game.weather.intensity.toFixed(2),
  rainVisible: window.__game.weather.rain?.points?.visible ?? null,
  snowVisible: window.__game.weather.snow?.points?.visible ?? null,
}));
console.log('nether weather:', JSON.stringify(nether));
console.log('suppressed OK:', nether.kind === 'clear' && nether.intensity < 0.05 &&
  nether.rainVisible === false && nether.snowVisible === false);

console.log('--- console errors ---');
console.log(errors.length ? errors.slice(0, 8).join('\n') : 'NONE');
await browser.close();
await server.close();
process.exit(0);
