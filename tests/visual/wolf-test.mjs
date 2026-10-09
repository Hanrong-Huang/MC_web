// Visual check of the refined wolf/cat shapes — frames each mob directly via
// the #debugmobs window.__game hook so terrain/bed never occlude it.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { port: 5213 } });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

await page.goto('http://localhost:5213/#debugmobs');
await page.waitForTimeout(1000);
await page.locator('.mode-pick button', { hasText: 'Creative' }).click();
await page.locator('.create-btn').click();
await page.waitForSelector('#loading.hidden', { timeout: 60000, state: 'attached' });
await page.waitForTimeout(2000);
await page.mouse.click(640, 360);
await page.waitForTimeout(200);

async function frame(kind, dist, dy, pitch) {
  await page.evaluate(({ kind, dist, dy, pitch }) => {
    const g = window.__game;
    const m = g.entities.entities.find((e) => e.kind === kind);
    if (!m) return;
    const p = g.player;
    const Y = 110;                       // lift into open air, above all terrain
    m.pos.y = Y; m.vel.x = m.vel.y = m.vel.z = 0;
    m.tamed = false; m.sitting = false;  // natural standing pose
    m.yaw = -0.5;                         // 3/4 view so the snout reads
    p.pos.x = m.pos.x;
    p.pos.z = m.pos.z + dist;            // stand south, looking north (-z)
    p.pos.y = Y + dy;
    p.vel.x = p.vel.y = p.vel.z = 0;
    p.yaw = 0;
    p.pitch = pitch;
  }, { kind, dist, dy, pitch });
  await page.waitForTimeout(120);        // shoot before gravity matters
  await page.screenshot({ path: `shot-mob-${kind}.png` });
}

await frame('wolf', 1.8, -1.1, 0.18);
await frame('cat', 1.5, -1.2, 0.22);
await frame('pig', 2.0, -1.0, 0.18);
await frame('cow', 2.2, -0.9, 0.18);

console.log(errors.length ? errors.slice(0, 12).join('\n') : 'NONE');
await browser.close();
await server.close();
process.exit(errors.length ? 1 : 0);
