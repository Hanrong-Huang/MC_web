// Confirm the Nether generates correctly at the new world height: bedrock floor
// + ceiling, netherrack body, lava near the bottom, no errors.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { port: 5207 } });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

await page.goto('http://localhost:5207/#debugmobs');
await page.waitForTimeout(1200);
await page.locator('.create-btn').click();
await page.waitForSelector('#loading.hidden', { timeout: 60000, state: 'attached' });
await page.waitForTimeout(2000);

const res = await page.evaluate(() => {
  const g = window.__game; const B = window.__B;
  g.world.generator.dimension = 'nether';
  // generate a far, fresh nether chunk and sample a column
  const c = g.world.ensureChunk(40, 40);
  const sample = (y) => c.get(3, y, 3);
  const CY = c.data.length / 256; // CHUNK_VOLUME / (16*16)
  let netherrack = 0, lava = 0;
  for (let y = 1; y < CY - 1; y++) {
    const id = c.get(3, y, 3);
    if (id === B.NETHERRACK) netherrack++;
    if (id === B.LAVA) lava++;
  }
  return {
    CY,
    floor: sample(0) === B.BEDROCK,
    ceiling: sample(CY - 1) === B.BEDROCK,
    netherrack, lava,
  };
});
console.log('nether gen:', JSON.stringify(res));
console.log('--- console errors ---');
console.log(errors.length ? errors.slice(0, 8).join('\n') : 'NONE');
await browser.close();
await server.close();
process.exit(errors.length ? 1 : 0);
