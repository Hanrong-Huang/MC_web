// Rebindable keys + sneak toggle + chat, through the real UI and keyboard:
// Options → Key Binds rebinds Jump to J (Space no longer jumps), the binding
// survives a reload, Sneak: Toggle latches sneaking on a Shift tap, the
// controls page shows the new key, T opens chat and Enter sends (single
// player echoes locally), Reset Keys restores the defaults. Asserts only.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const PORT = +(process.env.PORT ?? 5281);
const server = await createServer({ root: process.cwd(), logLevel: 'error', server: { port: PORT } });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
const failures = [];
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${info}`); if (!ok) failures.push(name); };

async function enterWorld() {
  await page.goto(`http://localhost:${PORT}/#dev`, { timeout: 180000 });
  await page.waitForLoadState('networkidle', { timeout: 180000 });
  await page.locator('.mode-pick button', { hasText: 'Creative' }).click({ timeout: 120000 });
  await page.locator('.create-btn').click({ timeout: 120000, noWaitAfter: true });
  await page.waitForFunction(() => !!window.__game, null, { timeout: 180000 });
  await page.waitForSelector('#loading.hidden', { timeout: 180000, state: 'attached' });
  await page.waitForTimeout(1500);
  await page.mouse.click(640, 360);
  await page.waitForTimeout(300);
}
const state = () => page.evaluate(() => window.__game.state);

await enterWorld();

// --- rebind Jump to J ---------------------------------------------------------------
await page.evaluate(() => window.__game.openPause());
await page.locator('.pause-screen button', { hasText: 'Options…' }).click();
await page.locator('button', { hasText: 'Key Binds…' }).click();
const jumpRow = page.locator('.kb-row', { hasText: 'Jump' });
check('Jump shows Space', (await jumpRow.locator('.kb-key').textContent()) === 'Space');
await jumpRow.locator('.kb-key').click();
check('the key waits for a press', (await jumpRow.locator('.kb-key').textContent()) === '> ? <');
await page.keyboard.press('KeyJ');
check('Jump is now J', (await jumpRow.locator('.kb-key').textContent()) === 'J');
// a clash shows red: bind Drop to J as well, then back
const dropRow = page.locator('.kb-row', { hasText: 'Drop Selected Item' });
await dropRow.locator('.kb-key').click();
await page.keyboard.press('KeyJ');
check('two actions on one key are flagged', await dropRow.locator('.kb-key.kb-clash').count() === 1);
await dropRow.locator('.kb-key').click();
await page.keyboard.press('KeyQ');
check('...and the flag clears', await page.locator('.kb-key.kb-clash').count() === 0);
// Escape cancels a capture without unbinding
await jumpRow.locator('.kb-key').click();
await page.keyboard.press('Escape');
check('Esc cancels a rebind', (await jumpRow.locator('.kb-key').textContent()) === 'J');
await page.locator('.keybinds button', { hasText: 'Done' }).click();

// --- sneak toggle option --------------------------------------------------------------
const sneakBtn = page.locator('button', { hasText: /^Sneak: / });
check('Sneak starts as Hold', (await sneakBtn.textContent()) === 'Sneak: Hold');
await sneakBtn.click();
check('Sneak switches to Toggle', (await sneakBtn.textContent()) === 'Sneak: Toggle');
await page.locator('.options button', { hasText: 'Done' }).click();
await page.locator('.pause-screen button', { hasText: 'Back to Game' }).click();
await page.waitForTimeout(300);
if (await state() !== 'playing') { await page.mouse.click(640, 360); await page.waitForTimeout(300); }
check('back in game', await state() === 'playing', await state());

// --- the bindings drive play ------------------------------------------------------------
await page.keyboard.down('Space');
const spaceJumps = await page.evaluate(() => window.__game.input.held('jump'));
await page.keyboard.up('Space');
await page.keyboard.down('KeyJ');
const jJumps = await page.evaluate(() => window.__game.input.held('jump'));
await page.keyboard.up('KeyJ');
check('Space no longer jumps, J does', !spaceJumps && jJumps);

await page.evaluate(() => { const p = window.__game.player; p.flying = false; });
await page.waitForTimeout(300);
// (headless frames are slow: wait for the next update to pick the latch up)
const sneakIs = (v) => page.waitForFunction((v) => window.__game.player.sneaking === v, v, { timeout: 5000, polling: 100 }).then(() => true, () => false);
await page.keyboard.press('ShiftLeft');
const latched = await sneakIs(true);
await page.waitForTimeout(500);
const stillLatched = await page.evaluate(() => window.__game.player.sneaking);
await page.keyboard.press('ShiftLeft');
const released = await sneakIs(false);
check('Sneak: Toggle — one tap crouches (and stays), the next stands', latched && stillLatched && released, `${latched} ${stillLatched} ${released}`);

// --- controls page shows the live keys --------------------------------------------------
await page.keyboard.press('KeyH');
await page.waitForTimeout(300);
const jumpRowHelp = await page.locator('.controls-row', { hasText: 'Jump' }).first().textContent();
check('the controls page lists J for jump', !!jumpRowHelp && jumpRowHelp.startsWith('J'), jumpRowHelp);
await page.keyboard.press('KeyH');
await page.waitForTimeout(300);

// --- chat ----------------------------------------------------------------------------------
if (await state() !== 'playing') { await page.mouse.click(640, 360); await page.waitForTimeout(300); }
await page.keyboard.press('KeyT');
await page.waitForTimeout(300);
check('T opens chat (and the game waits)', await state() === 'chat' && await page.evaluate(() => document.activeElement?.closest('.chat-input') !== null));
await page.keyboard.type('hello there');
check('typing in chat does not move the player', !(await page.evaluate(() => window.__game.input.held('forward') || window.__game.input.held('left'))));
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
check('Enter sends the line', await page.locator('.chat-line', { hasText: '<You> hello there' }).count() === 1);
check('...and closes chat', await state() !== 'chat', await state());

// single-player commands through the same chat line
async function slash(text) {
  if (await state() !== 'playing') { await page.mouse.click(640, 360); await page.waitForTimeout(300); }
  await page.keyboard.press('KeyT');
  await page.waitForTimeout(300);
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
}
await slash('/help');
check('/help lists the single-player commands', await page.locator('.chat-line', { hasText: '/sethome' }).count() >= 1);
await slash('/give diamond 2');
check('/give diamond 2', await page.evaluate(() => {
  const id = window.__findId('diamond');
  return window.__game.player.inventory.slots.some((s) => s && s.id === id && s.count >= 2);
}));
const homeAt = await page.evaluate(() => ({ x: window.__game.player.pos.x, z: window.__game.player.pos.z }));
await slash('/sethome');
await slash('/tp ~20 ~ ~');
const moved = await page.evaluate((h) => Math.abs(window.__game.player.pos.x - (h.x + 20)) < 1, homeAt);
await slash('/home');
const back = await page.evaluate((h) => Math.hypot(window.__game.player.pos.x - h.x, window.__game.player.pos.z - h.z) < 1, homeAt);
check('/tp ~20 ~ ~, then /home comes back', moved && back, `${moved} ${back}`);
await slash('/weather thunder');
check('/weather thunder', await page.evaluate(() => window.__game.weather.kind === 'thunder'));

// --- persistence + reset --------------------------------------------------------------------
await page.reload();
await page.waitForLoadState('networkidle', { timeout: 180000 });
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('voxelcraft-keybinds') ?? '{}'));
check('bindings persist across reloads', stored.binds?.jump === 'KeyJ' && stored.sneakToggle === true, JSON.stringify(stored));
await enterWorld();
await page.evaluate(() => window.__game.openPause());
await page.locator('.pause-screen button', { hasText: 'Options…' }).click();
await page.locator('button', { hasText: 'Key Binds…' }).click();
await page.locator('.keybinds button', { hasText: 'Reset Keys' }).click();
check('Reset Keys restores Space', (await page.locator('.kb-row', { hasText: 'Jump' }).locator('.kb-key').textContent()) === 'Space');
await page.evaluate(() => localStorage.removeItem('voxelcraft-keybinds'));

console.log(errors.length ? `--- console errors ---\n${errors.slice(0, 12).join('\n')}` : 'no console errors');
console.log(failures.length ? `FAILED: ${failures.join(', ')}` : 'ALL PASS');
await browser.close();
await server.close();
process.exit(failures.length || errors.length ? 1 : 0);
