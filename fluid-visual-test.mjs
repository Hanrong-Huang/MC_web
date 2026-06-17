// Browser visual check for the hash-gated fluid test scene.
import { chromium } from 'playwright';

const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors = [];

async function captureScene(hash, readyKey, path) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`${hash}: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`${hash}: PAGEERROR: ${err.message}`));

  await page.goto(`http://127.0.0.1:5207/#${hash}`);
  await page.locator('.mode-pick button', { hasText: 'Creative' }).click();
  await page.locator('.create-btn').click();
  await page.waitForFunction((key) => document.body.dataset[key] === 'ready', readyKey, { timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path });
  await page.close();
}

await captureScene('fluidtest', 'fluidtest', 'fluid-test.png');
await captureScene('bowtest', 'bowtest', 'bow-test.png');

console.log('visual captures: fluid-test.png, bow-test.png');
console.log('--- console errors ---');
console.log(errors.length ? errors.slice(0, 10).join('\n') : 'NONE');

await browser.close();
process.exit(errors.length ? 1 : 0);
