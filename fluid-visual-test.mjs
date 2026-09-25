// Browser visual check for the hash-gated fluid test scene.
// Usage: node fluid-visual-test.mjs [port]   (screenshots go to $SHOT_DIR or cwd)
import { chromium } from 'playwright';
import { createServer } from 'vite';
import path from 'node:path';

const PORT = +(process.argv[2] ?? 5207);
const OUT = process.env.SHOT_DIR ?? process.cwd();
const server = await createServer({ root: process.cwd(), server: { port: PORT, watch: { ignored: ['**/.claude/**'] } } });
await server.listen();

const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors = [];

async function captureScene(hash, readyKey, file) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`${hash}: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`${hash}: PAGEERROR: ${err.message}`));

  await page.goto(`http://127.0.0.1:${PORT}/#${hash}`, { timeout: 180000 });
  await page.locator('.mode-pick button', { hasText: 'Creative' }).click();
  await page.locator('.create-btn').click();
  await page.waitForFunction((key) => document.body.dataset[key] === 'ready', readyKey, { timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, file) });
  await page.close();
}

await captureScene('fluidtest', 'fluidtest', 'fluid-test.png');
await captureScene('bowtest', 'bowtest', 'bow-test.png');

console.log('visual captures: fluid-test.png, bow-test.png');
console.log('--- console errors ---');
console.log(errors.length ? errors.slice(0, 10).join('\n') : 'NONE');

await browser.close();
await server.close();
process.exit(errors.length ? 1 : 0);
