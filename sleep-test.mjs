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
await page.locator('.create-btn').click();
await page.waitForSelector('#loading.hidden', { timeout: 60000, state: 'attached' });
await page.waitForTimeout(2000);
await page.mouse.click(640, 360);
await page.waitForTimeout(300);
await page.screenshot({ path: 'shot-sleep-night.png' });

// Clear the debug menagerie first: a right-click that lands on the horse mounts
// it instead of reaching the bed (mob interaction wins over block interaction).
const bedAt = await page.evaluate(() => {
  const g = window.__game, p = g.player, B = window.__B;
  for (const e of [...g.entities.entities]) if (g.entities.isMob(e)) e.dead = true;
  // find the debug bed's foot half near the player (it is placed at world init,
  // and the player has drifted since, so scan rather than recompute the offset)
  const px = Math.floor(p.pos.x), py = Math.floor(p.pos.y), pz = Math.floor(p.pos.z);
  let found = null;
  for (let dy = -2; dy <= 2 && !found; dy++) {
    for (let dx = -6; dx <= 6 && !found; dx++) {
      for (let dz = -6; dz <= 6 && !found; dz++) {
        if (g.world.getBlock(px + dx, py + dy, pz + dz) === B.BED) {
          found = { x: px + dx, y: py + dy, z: pz + dz };
        }
      }
    }
  }
  if (!found) return null;
  // stand just short of the bed's foot half and look down at it
  p.pos.x = found.x - 1.4; p.pos.y = found.y; p.pos.z = found.z + 0.5;
  p.yaw = -Math.PI / 2; // toward +x
  p.pitch = -0.6;
  p.flying = false;
  return found;
});
console.log('BED AT:', JSON.stringify(bedAt));
if (!bedAt) errors.push('no bed found near the player');
await page.waitForTimeout(400);
await page.mouse.down({ button: 'right' });
await page.waitForTimeout(120);
await page.mouse.up({ button: 'right' });
const inBed = await page.evaluate(() => window.__game.state);
if (inBed !== 'sleeping') {
  console.log('DIAG:', JSON.stringify(await page.evaluate(() => {
    const g = window.__game, p = g.player, B = window.__B;
    const bx = Math.floor(p.pos.x + 1.4), by = Math.floor(p.pos.y), bz = Math.floor(p.pos.z);
    return {
      target: p.target ? { x: p.target.x, y: p.target.y, z: p.target.z, id: p.target.id } : null,
      bedIdAtGuess: g.world.getBlock(bx, by, bz),
      BED: B.BED, BED_HEAD: B.BED_HEAD,
      dayTime: +g.dayTime.toFixed(3),
      weather: g.weather.kind,
      mode: p.mode,
      hostileNear: g.entities.hostileNear(p.pos.x, p.pos.y + 1, p.pos.z, 8),
      pos: [+p.pos.x.toFixed(2), +p.pos.y.toFixed(2), +p.pos.z.toFixed(2)],
    };
  })));
}
console.log('IN BED:', inBed);
if (inBed !== 'sleeping') errors.push(`right-clicking the bed did not start sleep (state=${inBed})`);
// lying in bed (Zzz banner + Leave Bed button, before the blackout)
await page.waitForTimeout(500);
await page.screenshot({ path: 'shot-sleep-lying.png' });
// mid-fade (black) capture — the blackout runs 1.2s..1.9s into the sleep
await page.waitForTimeout(1100);
await page.screenshot({ path: 'shot-sleep-fade.png' });
// after the full transition (wakes at 2.7s)
await page.waitForTimeout(1600);
await page.screenshot({ path: 'shot-sleep-morning.png' });
const woke = await page.evaluate(() => ({
  state: window.__game.state,
  dayTime: +window.__game.dayTime.toFixed(3),
}));
console.log('WOKE:', JSON.stringify(woke));
if (woke.state !== 'playing' || woke.dayTime > 0.2) errors.push(`sleep did not reach morning: ${JSON.stringify(woke)}`);

console.log(errors.length ? errors.slice(0, 12).join('\n') : 'NONE');
await browser.close();
await server.close();
process.exit(errors.length ? 1 : 0);
