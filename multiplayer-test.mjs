// Multiplayer end to end: builds the client + server, starts the real server
// (fresh world in a temp dir), and joins it from two separate browser profiles
// ("Alice" and "Bob"). Asserts: both see each other (player list + a model in
// the scene), a block + a door state + chest contents one player changes show
// up for the other, an edit in a chunk the other hasn't loaded is applied when
// they get there, chat arrives, the night only skips once both are in bed,
// and after a server restart the edits and a player's position come back.
// Screenshot (unless NO_SHOTS=1): $SHOT_DIR/mp-alice-sees-bob.png.
//
// MP_BACKEND=worker runs the same checks against the Cloudflare Worker
// (`wrangler dev`, local runtime + local SQLite) with the client served on its
// own port, as it is from GitHub Pages, joining by Server Address.
import { chromium } from 'playwright';
import { preview } from 'vite';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = +(process.env.PORT ?? 8123);
const WORKER = process.env.MP_BACKEND === 'worker';
const CLIENT_PORT = PORT + 1; // worker mode: the static client (like GitHub Pages)
const DIR = process.env.SHOT_DIR ?? '.';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-mp-'));
const failures = [];
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${info}`); if (!ok) failures.push(name); };

if (!process.env.SKIP_BUILD) {
  execSync('npx vite build', { stdio: 'ignore' });
  execSync('node scripts/build-server.mjs', { stdio: 'ignore' });
}

let server = null;
function startServer() {
  return new Promise((resolve, reject) => {
    server = WORKER
      ? spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', DATA,
        '--var', 'SEED:multiplayer-test', '--var', 'MODE:creative'], {
        env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
      })
      : spawn('node', ['dist-server/server.mjs'], {
        env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, STATIC_DIR: 'dist', SEED: 'multiplayer-test', MODE: 'creative' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    const ready = WORKER ? 'Ready on' : 'play:';
    server.stdout.on('data', (d) => { if (String(d).includes(ready)) resolve(); });
    server.stderr.on('data', (d) => { const t = String(d).trim(); if (t && !/WARNING|Proxy/.test(t)) console.log('[server]', t); });
    server.on('exit', (code) => { if (code) reject(new Error(`server exited ${code}`)); });
  });
}
function stopServer() {
  return new Promise((resolve) => {
    server.once('exit', resolve);
    // wrangler runs workerd as a child: signal the whole group
    if (WORKER) process.kill(-server.pid, 'SIGINT'); else server.kill('SIGINT');
  });
}
const client = WORKER ? await preview({ preview: { port: CLIENT_PORT, strictPort: true }, logLevel: 'error' }) : null;
const PAGE = WORKER ? `http://localhost:${CLIENT_PORT}/#dev` : `http://localhost:${PORT}/#dev`;
// MP_ADDRESS='' checks a client built with VITE_MP_SERVER (blank = the baked-in server)
const ADDRESS = process.env.MP_ADDRESS ?? (WORKER ? `ws://127.0.0.1:${PORT}` : '');

await startServer();
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors = [];

async function join(name) {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name} PAGEERROR: ${e.message}`));
  await page.goto(PAGE, { timeout: 180000 });
  await page.waitForSelector('#mp-name', { timeout: 120000 });
  await page.fill('#mp-address', ADDRESS);
  await page.fill('#mp-name', name);
  await page.locator('.mp-card .join-btn').click();
  await page.waitForFunction(() => !!window.__game, null, { timeout: 180000 });
  await page.waitForSelector('#loading.hidden', { timeout: 180000, state: 'attached' });
  await page.waitForTimeout(1500);
  return { ctx, page };
}

/** Wait for a condition in the page (polling), returning its final value. */
async function until(page, fn, arg, ms = 20000) {
  try {
    await page.waitForFunction(fn, arg, { timeout: ms, polling: 200 });
    return true;
  } catch { return false; }
}

let alice = await join('Alice');
let bob = await join('Bob');

// --- presence ---------------------------------------------------------------------
const seesBob = await until(alice.page, () => window.__game.remotes.list().some((r) => r.name === 'Bob' && r.pose));
const seesAlice = await until(bob.page, () => window.__game.remotes.list().some((r) => r.name === 'Alice' && r.pose));
check('Alice sees Bob', seesBob);
check('Bob sees Alice', seesAlice);

// stand them a few blocks apart on a stone pad, Alice facing Bob
const pad = await alice.page.evaluate(() => {
  const g = window.__game, B = window.__B, w = g.world, p = g.player;
  const x = Math.floor(p.pos.x), y = 120, z = Math.floor(p.pos.z);
  g.capture(() => {
    for (let dx = -3; dx <= 8; dx++) for (let dz = -3; dz <= 3; dz++) {
      w.setBlock(x + dx, y - 1, z + dz, B.STONE);
      for (let dy = 0; dy < 4; dy++) w.setBlock(x + dx, y + dy, z + dz, 0);
    }
  });
  p.flying = false; p.vel = { x: 0, y: 0, z: 0 };
  p.pos.x = x + 0.5; p.pos.y = y; p.pos.z = z + 0.5;
  p.yaw = -Math.PI / 2; p.pitch = -0.1; // look toward +x
  return { x, y, z };
});
await bob.page.evaluate((pad) => {
  const p = window.__game.player;
  p.flying = false; p.vel = { x: 0, y: 0, z: 0 };
  p.pos.x = pad.x + 4.5; p.pos.y = pad.y + 0.01; p.pos.z = pad.z + 0.5;
  p.yaw = Math.PI / 2; // face Alice
}, pad);
const padSynced = await until(bob.page, (pad) => window.__game.world.getBlock(pad.x + 6, pad.y - 1, pad.z) === window.__B.STONE, pad);
check('a stone pad Alice builds appears for Bob', padSynced);
await alice.page.waitForTimeout(1500);
const bobModel = await alice.page.evaluate(() => {
  const g = window.__game;
  let found = null;
  g.renderer.scene.traverse((o) => { if (o.isSprite && o.parent?.visible && o.parent.position.distanceTo(g.player.pos) < 8) found = o.parent.position.clone(); });
  return found ? { x: found.x, y: found.y, z: found.z } : null;
});
check("Bob's model stands where Bob is", !!bobModel && Math.abs(bobModel.x - (pad.x + 4.5)) < 0.6, JSON.stringify(bobModel));
if (!process.env.NO_SHOTS) await alice.page.screenshot({ path: `${DIR}/mp-alice-sees-bob.png` });

// --- blocks, door state, chest ----------------------------------------------------
await alice.page.evaluate((pad) => {
  const g = window.__game, B = window.__B, w = g.world;
  g.capture(() => {
    w.setBlock(pad.x + 2, pad.y, pad.z + 2, B.GOLD_BLOCK ?? B.STONE_BRICKS);
    // a door, opened
    w.doorStates.set(`${pad.x + 2},${pad.y},${pad.z - 2}`, { facing: 0, open: false, hingeRight: false, swing: 0 });
    w.setBlock(pad.x + 2, pad.y, pad.z - 2, B.DOOR_LOWER);
    w.setBlock(pad.x + 2, pad.y + 1, pad.z - 2, B.DOOR_UPPER);
  });
  g.capture(() => { const d = w.doorStates.get(`${pad.x + 2},${pad.y},${pad.z - 2}`); w.doorStates.set(`${pad.x + 2},${pad.y},${pad.z - 2}`, { ...d, open: true }); });
}, pad);
const want = await alice.page.evaluate((pad) => window.__game.world.getBlock(pad.x + 2, pad.y, pad.z + 2), pad);
check('Bob gets the placed block', await until(bob.page, ([pad, want]) => window.__game.world.getBlock(pad.x + 2, pad.y, pad.z + 2) === want, [pad, want]));
check('Bob gets the door, open', await until(bob.page, (pad) => {
  const w = window.__game.world;
  return w.getBlock(pad.x + 2, pad.y + 1, pad.z - 2) === window.__B.DOOR_UPPER && w.doorStates.get(`${pad.x + 2},${pad.y},${pad.z - 2}`)?.open === true;
}, pad));
// Bob breaks the block: Alice sees air
await bob.page.evaluate((pad) => { const g = window.__game; g.capture(() => g.world.setBlock(pad.x + 2, pad.y, pad.z + 2, 0)); }, pad);
check('Alice sees Bob break it', await until(alice.page, (pad) => window.__game.world.getBlock(pad.x + 2, pad.y, pad.z + 2) === 0, pad));

// chest contents travel when the chest is closed
const cobble = await alice.page.evaluate(() => window.__B.COBBLE);
await alice.page.evaluate(([pad, cobble]) => {
  const g = window.__game, B = window.__B, w = g.world;
  g.capture(() => w.setBlock(pad.x + 3, pad.y, pad.z, B.CHEST));
  g.openBlockContainer('chest', pad.x + 3, pad.y, pad.z);
  const be = w.blockEntities.get(`${pad.x + 3},${pad.y},${pad.z}`);
  be.slots[0] = { id: cobble, count: 7 };
  g.closeContainer();
}, [pad, cobble]);
check('Bob sees what Alice put in the chest', await until(bob.page, ([pad, cobble]) => {
  const be = window.__game.world.blockEntities.get(`${pad.x + 3},${pad.y},${pad.z}`);
  return !!be && be.slots?.[0]?.id === cobble && be.slots[0].count === 7;
}, [pad, cobble]));

// --- an edit in a chunk Bob hasn't loaded -----------------------------------------
const far = { x: pad.x + 400, z: pad.z + 400 };
await alice.page.evaluate((far) => {
  const g = window.__game, B = window.__B, w = g.world;
  w.ensureChunk(Math.floor(far.x / 16), Math.floor(far.z / 16));
  g.capture(() => w.setBlock(far.x, 150, far.z, B.GLASS));
}, far);
await bob.page.waitForTimeout(800);
const bobHadIt = await bob.page.evaluate((far) => !!window.__game.world.chunks.get(`${Math.floor(far.x / 16)},${Math.floor(far.z / 16)}`), far);
await bob.page.evaluate((far) => { window.__game.world.ensureChunk(Math.floor(far.x / 16), Math.floor(far.z / 16)); }, far);
check('an edit to a chunk Bob had not loaded is there when it loads', !bobHadIt && await until(bob.page, (far) => window.__game.world.getBlock(far.x, 150, far.z) === window.__B.GLASS, far));

// --- chat ---------------------------------------------------------------------------
await alice.page.evaluate(() => window.__game.net.send({ t: 'chat', text: 'hello bob' }));
check('chat reaches Bob', await until(bob.page, () => [...document.querySelectorAll('.chat-line')].some((l) => l.textContent.includes('<Alice> hello bob'))));

// --- sleeping: the night skips only when both are in bed ---------------------------
await alice.page.evaluate(() => window.__game.net.send({ t: 'chat', text: '/time set night' }));
check('/time set night reaches both clocks', await until(alice.page, () => window.__game.dayTime > 0.55 && window.__game.dayTime < 0.65) &&
  await until(bob.page, () => window.__game.dayTime > 0.55 && window.__game.dayTime < 0.65));
await alice.page.evaluate(() => window.__game.startSleep({ cx: window.__game.player.pos.x, cz: window.__game.player.pos.z, y: window.__game.player.pos.y, yaw: 0 }));
await alice.page.waitForTimeout(3500);
const aliceStillNight = await alice.page.evaluate(() => window.__game.state === 'sleeping' && window.__game.dayTime > 0.5);
console.log('  alice:', await alice.page.evaluate(() => ({ state: window.__game.state, t: window.__game.dayTime })));
check('one sleeper alone does not skip the night', aliceStillNight);
await bob.page.evaluate(() => window.__game.startSleep({ cx: window.__game.player.pos.x, cz: window.__game.player.pos.z, y: window.__game.player.pos.y, yaw: 0 }));
check('both in bed: morning for both', await until(alice.page, () => window.__game.state === 'playing' && window.__game.dayTime < 0.2, null, 20000) &&
  await until(bob.page, () => window.__game.dayTime < 0.2, null, 20000));

// --- persistence across a server restart ------------------------------------------
await bob.page.evaluate(() => { const p = window.__game.player; p.pos.x += 1.25; });
await bob.page.waitForTimeout(300);
const bobPos = await bob.page.evaluate(() => ({ x: window.__game.player.pos.x, z: window.__game.player.pos.z }));
await bob.page.evaluate(() => window.__game.saveAndQuit());
await bob.page.waitForTimeout(800);
await alice.page.evaluate(() => window.__game.saveAndQuit());
await alice.page.waitForTimeout(800);
await bob.ctx.close(); await alice.ctx.close();
await stopServer();
await startServer();
bob = await join('Bob');
const back = await bob.page.evaluate(() => ({ x: window.__game.player.pos.x, z: window.__game.player.pos.z }));
check("Bob comes back where he left", Math.abs(back.x - bobPos.x) < 0.5 && Math.abs(back.z - bobPos.z) < 0.5, `${JSON.stringify(back)} vs ${JSON.stringify(bobPos)}`);
check('the door survives a server restart', await until(bob.page, (pad) => window.__game.world.doorStates.get(`${pad.x + 2},${pad.y},${pad.z - 2}`)?.open === true &&
  window.__game.world.getBlock(pad.x + 2, pad.y, pad.z - 2) === window.__B.DOOR_LOWER, pad));

await browser.close();
await stopServer();
if (client) await new Promise((r) => client.httpServer.close(r));
fs.rmSync(DATA, { recursive: true, force: true });
console.log(errors.length ? `--- console errors ---\n${errors.slice(0, 12).join('\n')}` : 'no console errors');
console.log(failures.length ? `FAILED: ${failures.join(', ')}` : 'ALL PASS');
process.exit(failures.length || errors.length ? 1 : 0);
