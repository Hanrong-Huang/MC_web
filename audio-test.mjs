// Headless audio harness: boots the game, unlocks Web Audio with a click, then
// fires every sound effect, block material, mob voice (idle/hurt/death), the
// weather/underwater/Nether beds, every ambience environment and a burst of
// music. Asserts no console errors, that the voice caps hold, and that every
// one-shot event tears itself down afterwards (no node leaks).
// Also renders a few sounds in an OfflineAudioContext to check for NaNs,
// clipping and silence.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const PORT = 5242;
const server = await createServer({ root: process.cwd(), server: { port: PORT }, logLevel: 'silent' });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
const fail = [];

await page.goto(`http://localhost:${PORT}/#debugmobs`);
await page.waitForTimeout(1000);
await page.mouse.click(10, 10); // user gesture: unlocks audio on the title screen
await page.waitForTimeout(1500);
await page.locator('.mode-pick button', { hasText: 'Creative' }).click();
await page.locator('.create-btn').click();
await page.waitForSelector('#loading.hidden', { timeout: 60000, state: 'attached' });
await page.waitForTimeout(1500);
await page.mouse.click(640, 360);

const fired = await page.evaluate(async () => {
  const a = window.__game.audio;
  a.ensure();
  await new Promise((r) => setTimeout(r, 300));
  const out = { state: a.ctx ? a.ctx.state : 'no-ctx' };
  const sfx = ['pop', 'hurt', 'hit', 'eat', 'burp', 'click', 'select', 'fail', 'craft', 'level', 'doorOpen', 'doorClose',
    'plateOn', 'plateOff', 'explode', 'bow', 'snap', 'fuse', 'arrowHit', 'whoosh', 'lowdur', 'thunder', 'splash', 'hoof',
    'mount', 'submerge', 'emerge', 'chestOpen', 'chestClose', 'advancement', 'equip', 'lavaPop', 'bubble'];
  for (const n of sfx) { a.play(n); await new Promise((r) => setTimeout(r, 15)); }
  // every block id as a step, a mining hit and a break
  for (let id = 1; id < 120; id++) {
    a.step('stone', id); a.dig('stone', 0.25, 1, id); a.dig('grass', 1, 1, id);
    if (id % 8 === 0) await new Promise((r) => setTimeout(r, 30));
  }
  const mobs = ['pig', 'sheep', 'cow', 'chicken', 'zombie', 'skeleton', 'spider', 'creeper', 'wolf', 'villager', 'phantom',
    'horse', 'cat', 'cinderling', 'ashstalker', 'emberghast'];
  for (const k of mobs) for (const v of ['idle', 'hurt', 'death']) { a.mobSound(k, 0.8, v); await new Promise((r) => setTimeout(r, 10)); }
  // flood: the caps must hold
  for (let i = 0; i < 200; i++) a.dig('stone', 1, 1, 3);
  out.peakAfterFlood = a.debugStats().peak;
  // beds
  a.setRain('thunder', 0.9); a.setUnderwater(true); a.weatherLoop('snow', 0.8, true);
  for (const env of ['day', 'night', 'cave', 'nether']) {
    for (let i = 0; i < 8; i++) { a.atmosphereT = 0; a.ambientTick(0.016, env, 'plains'); }
  }
  for (const b of ['snow', 'desert', 'jungle', 'swamp', 'mountains']) { a.atmosphereT = 0; a.ambientTick(0.016, 'day', b); }
  for (let i = 0; i < 5; i++) a.heartbeatTick(0.6, 0.1);
  // music: force a piece now
  a.nextPieceAt = 0; a.ambientTick(0.016, 'day', 'plains');
  out.piece = a.debugStats().piece;
  await new Promise((r) => setTimeout(r, 2500));
  out.duringPiece = a.debugStats();
  a.setRain('off'); a.setUnderwater(false); a.ambientTick(0.016, 'day', 'plains');
  // menu music path (pause the game loop's ambientTick, as disposing the game would)
  const tick = a.ambientTick;
  a.ambientTick = () => {};
  a.setMenuMusic(true);
  await new Promise((r) => setTimeout(r, 1800));
  out.menuPiece = a.debugStats().piece;
  a.ambientTick = tick;
  a.setMenuMusic(false);
  return out;
});
console.log('live:', JSON.stringify(fired));
if (fired.state !== 'running') fail.push('audio context not running: ' + fired.state);
if (!fired.piece) fail.push('no in-game piece started');
if (!fired.menuPiece || !fired.menuPiece.startsWith('Title')) fail.push('title theme did not start: ' + fired.menuPiece);
if (fired.peakAfterFlood.sfx > 36) fail.push('sfx voice cap exceeded');

// offline renders: no NaN, no clipping, not silent
const offline = await page.evaluate(async () => {
  const { AudioEngine } = await import('/src/engine/Audio.ts');
  const res = {};
  const cases = {
    explode: (a) => a.play('explode'),
    thunder: (a) => a.play('thunder'),
    stoneBreak: (a) => a.dig('stone', 1, 1, 3),
    zombie: (a) => a.mobSound('zombie', 1),
    title: (a, ctx) => {
      a.musicMode = 'menu'; a.startPiece(0);
      for (let t = 0.5; t < 11; t += 0.5) ctx.suspend(t).then(() => { a.pumpMusic(t, 0.9); ctx.resume(); });
      a.pumpMusic(0, 0.9);
    },
  };
  // leak check: fire everything into one offline context; once rendered, every
  // event must have torn itself down
  {
    const ctx = new OfflineAudioContext(2, 44100 * 14, 44100);
    const a = new AudioEngine();
    a.attachContext(ctx);
    const sfx = ['pop', 'hurt', 'hit', 'eat', 'burp', 'click', 'craft', 'level', 'doorOpen', 'doorClose', 'explode', 'bow',
      'snap', 'fuse', 'arrowHit', 'thunder', 'splash', 'mount', 'chestOpen', 'chestClose', 'advancement', 'equip'];
    sfx.forEach((n, i) => ctx.suspend(0.1 + i * 0.05).then(() => { a.play(n); ctx.resume(); }));
    for (let id = 1; id < 90; id += 3) ctx.suspend(1.5 + id * 0.01).then(() => { a.dig('stone', 1, 1, id); a.step('grass', id); ctx.resume(); });
    ['pig', 'cow', 'zombie', 'skeleton', 'wolf', 'cat', 'horse', 'villager'].forEach((k, i) =>
      ctx.suspend(3 + i * 0.1).then(() => { a.mobSound(k, 1, i % 2 ? 'hurt' : 'idle'); ctx.resume(); }));
    ['day', 'night', 'cave', 'nether'].forEach((env, i) => ctx.suspend(4 + i * 0.2).then(() => { a.atmosphereT = 0; a.ambientTick(0.01, env, 'plains'); ctx.resume(); }));
    ctx.suspend(5).then(() => { a.ambientTick(0.01, 'day', 'plains'); a.setRain('rain', 0.7); a.setUnderwater(true); ctx.resume(); });
    ctx.suspend(7).then(() => { a.setRain('off'); a.setUnderwater(false); ctx.resume(); });
    await ctx.startRendering();
    await new Promise((r) => setTimeout(r, 200)); // let queued 'ended' events dispatch
    res.leak = { ...a.debugStats().live, peak: 1 };
  }
  for (const [k, fn] of Object.entries(cases)) {
    const ctx = new OfflineAudioContext(2, 44100 * 12, 44100);
    const a = new AudioEngine();
    a.attachContext(ctx);
    fn(a, ctx);
    const b = await ctx.startRendering();
    let peak = 0, nan = 0;
    for (let ch = 0; ch < 2; ch++) for (const s of b.getChannelData(ch)) { if (Number.isNaN(s)) nan++; else peak = Math.max(peak, Math.abs(s)); }
    res[k] = { peak: +peak.toFixed(3), nan };
  }
  return res;
});
console.log('offline:', JSON.stringify(offline));
const lk = offline.leak;
delete offline.leak;
if (lk.sfx || lk.amb) fail.push(`events leaked after offline render: sfx ${lk.sfx}, amb ${lk.amb}`);
for (const [k, r] of Object.entries(offline)) {
  if (r.nan) fail.push(`${k}: NaN samples`);
  if (r.peak >= 0.99) fail.push(`${k}: clipping`);
  if (r.peak < 0.005) fail.push(`${k}: silent`);
}

console.log('errors:', errors.length ? errors.slice(0, 8).join('\n') : 'NONE');
console.log(fail.length ? 'FAIL\n' + fail.join('\n') : 'PASS');
await browser.close();
await server.close();
process.exit(fail.length || errors.length ? 1 : 0);
