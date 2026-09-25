// Headless audio harness: boots the game, unlocks Web Audio with a click, then
// fires every sound effect, block material (per gait), mob voice
// (idle/hurt/death), the weather beds (rain / snow / blizzard), every
// soundscape bed (wind, leaves, surf, streams, fire, lava, cave air), the
// stingers, the combat layer and a burst of music. Asserts no console errors,
// that the voice caps hold, and that every one-shot event and bed tears itself
// down afterwards (no node leaks).
// Also renders sounds, beds and every music palette in OfflineAudioContexts to
// check for NaNs, clipping and silence, and measures how dark the rain is.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const PORT = 5405;
const server = await createServer({
  root: process.cwd(), logLevel: 'silent',
  server: { port: PORT, watch: { ignored: ['**/.claude/**'] } },
});
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
await page.locator('.mode-pick button', { hasText: 'Creative' }).click({ timeout: 120000 });
await page.locator('.create-btn').click({ timeout: 120000 });
await page.waitForSelector('#loading.hidden', { timeout: 180000, state: 'attached' });
await page.waitForTimeout(1500);
await page.mouse.click(640, 360);

// a synthetic soundscape probe result, overridden per case
const SCAPE = {
  dim: 'overworld', y: 70, biome: 'plains', sky: 1, underground: false, roof: 'open', room: 20, enclosed: 0.2,
  leaves: 0, leafPan: 0, water: 0, waterPan: 0, ocean: false, flow: 0, flowPan: 0, fire: 0, firePan: 0,
  lava: 0, lavaPan: 0, villagers: 0, villagePan: 0, threat: 0, weather: 'clear', intensity: 0, cold: false,
  creative: false, hpFrac: 1,
};

const fired = await page.evaluate(async (SCAPE) => {
  const a = window.__game.audio;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  a.ensure();
  await wait(300);
  const out = { state: a.ctx ? a.ctx.state : 'no-ctx' };
  const sfx = ['pop', 'hurt', 'hit', 'eat', 'burp', 'click', 'select', 'fail', 'craft', 'level', 'doorOpen', 'doorClose',
    'plateOn', 'plateOff', 'explode', 'bow', 'snap', 'fuse', 'arrowHit', 'whoosh', 'lowdur', 'thunder', 'splash', 'hoof',
    'mount', 'submerge', 'emerge', 'chestOpen', 'chestClose', 'advancement', 'equip', 'lavaPop', 'bubble',
    'jump', 'death', 'drink', 'ignite', 'bell', 'crackle'];
  for (const n of sfx) { a.play(n); await wait(15); }
  a.thunder(20); a.thunder(150);
  // every block id as a step (all gaits), a landing, a mining hit and a break
  for (let id = 1; id < 120; id++) {
    a.step('stone', id, ['walk', 'sprint', 'sneak'][id % 3]); a.dig('stone', 0.25, 1, id); a.dig('grass', 1, 1, id);
    if (id % 10 === 0) a.land('stone', id, 6);
    if (id % 8 === 0) await wait(30);
  }
  const mobs = ['pig', 'sheep', 'cow', 'chicken', 'zombie', 'skeleton', 'spider', 'creeper', 'wolf', 'villager', 'phantom',
    'horse', 'cat', 'cinderling', 'ashstalker', 'emberghast'];
  for (const k of mobs) for (const v of ['idle', 'hurt', 'death']) { a.mobSound(k, 0.8, v); await wait(10); }
  // flood: the caps must hold
  for (let i = 0; i < 200; i++) a.dig('stone', 1, 1, 3);
  out.peakAfterFlood = a.debugStats().peak;
  // soundscapes: walk through a set of places and check the right beds come up
  const places = {
    forest: { biome: 'forest', leaves: 0.9, leafPan: -0.5, roof: 'leaves' },
    coast: { biome: 'plains', ocean: true, water: 1, waterPan: 0.6 },
    stream: { flow: 0.9, flowPan: -0.4 },
    peak: { biome: 'mountains', y: 125 },
    cave: { underground: true, sky: 0, y: 30, room: 12, enclosed: 1, roof: 'solid', lava: 0.6, lavaPan: 0.3 },
    hearth: { fire: 0.8, firePan: 0.2, roof: 'solid', enclosed: 0.9 },
    village: { villagers: 5, villagePan: 0.3 },
    rainOpen: { weather: 'rain', intensity: 0.8 },
    rainRoof: { weather: 'thunder', intensity: 0.9, roof: 'solid' },
    snow: { biome: 'snow', cold: true, weather: 'rain', intensity: 0.8 },
    blizzard: { biome: 'snow', cold: true, weather: 'thunder', intensity: 1, y: 110 },
    chase: { threat: 0.9 },
  };
  out.places = {};
  const realListen = a.listen;
  a.listen = () => {}; // the live game loop would overwrite the synthetic places
  for (const [name, o] of Object.entries(places)) {
    for (let i = 0; i < 4; i++) { a.applyScape({ ...SCAPE, ...o }, 0.33); a.ambientTick(0.33, o.underground ? 'cave' : 'day', o.biome ?? 'plains'); }
    await wait(250);
    const st = a.debugStats();
    out.places[name] = { beds: Object.keys(st.beds).sort().join(','), rain: st.rain, threat: st.threat };
  }
  a.listen = realListen;
  // stingers + the combat layer
  a.lastAt.clear();
  out.stingers = ['village', 'peak', 'cave', 'sunrise', 'nightfall', 'nether', 'discover'].map((k) => { a.lastAt.delete('sting'); return a.playStinger(k, 0); });
  a.setRain('thunder', 0.9); a.setUnderwater(true); a.weatherLoop('snow', 0.8, true);
  for (const env of ['day', 'night', 'cave', 'nether']) {
    for (let i = 0; i < 8; i++) { a.atmosphereT = 0; a.ambientTick(0.016, env, 'plains'); }
  }
  for (const b of ['snow', 'desert', 'jungle', 'swamp', 'mountains']) { a.atmosphereT = 0; a.ambientTick(0.016, 'day', b); }
  for (let i = 0; i < 5; i++) a.heartbeatTick(0.6, 0.1);
  // music: force a piece now
  a.setUnderwater(false);
  a.nextPieceAt = 0; a.ambientTick(0.016, 'day', 'plains');
  out.piece = a.debugStats().piece;
  await wait(2500);
  out.duringPiece = a.debugStats();
  // back to calm: everything must wind down
  for (let i = 0; i < 30; i++) { a.applyScape({ ...SCAPE }, 0.33); a.heartbeatTick(0.5, 1); a.ambientTick(0.016, 'day', 'plains'); }
  a.setRain('off'); a.setSnow(0); a.setUnderwater(false);
  // menu music path (pause the game loop's ambientTick, as disposing the game would)
  const tick = a.ambientTick;
  const listen = a.listen;
  a.ambientTick = () => {};
  a.listen = () => {};
  a.setMenuMusic(true);
  await wait(1800);
  out.menuPiece = a.debugStats().piece;
  out.bedsAfterMenu = Object.keys(a.debugStats().beds).length;
  a.ambientTick = tick;
  a.listen = listen;
  a.setMenuMusic(false);
  return out;
}, SCAPE);
console.log('live:', JSON.stringify(fired, null, 1));
if (fired.state !== 'running') fail.push('audio context not running: ' + fired.state);
if (!fired.piece) fail.push('no in-game piece started');
if (!fired.menuPiece || !fired.menuPiece.startsWith('Title')) fail.push('title theme did not start: ' + fired.menuPiece);
if (fired.peakAfterFlood.sfx > 36) fail.push('sfx voice cap exceeded');
if (fired.bedsAfterMenu) fail.push('beds still running on the title screen: ' + fired.bedsAfterMenu);
const expect = {
  forest: ['leaves'], coast: ['surf'], stream: ['stream'], peak: ['wind'], cave: ['caveAir', 'lava'], hearth: ['fire'],
  rainOpen: ['rain', 'rainLow'], rainRoof: ['rain', 'rainLow'], snow: ['snow'], blizzard: ['snow', 'wind'],
};
for (const [k, beds] of Object.entries(expect)) {
  const got = fired.places[k].beds.split(',');
  for (const b of beds) if (!got.includes(b)) fail.push(`${k}: bed '${b}' missing (got ${fired.places[k].beds})`);
}
if (fired.places.chase.threat < 0.3) fail.push('chase did not raise the combat layer');
if (fired.stingers.some((x) => !x)) fail.push('a stinger refused to play: ' + fired.stingers);

/// offline renders: no NaN, no clipping, not silent. Rendered on a bare page
// (no game running) one case per evaluate so progress is visible.
const off = await browser.newPage();
off.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push('offline: ' + m.text()); });
off.on('pageerror', (e) => errors.push('offline PAGEERROR: ' + e.message));
await off.goto(`http://localhost:${PORT}/package.json`);
const caseNames = await off.evaluate(async (SCAPE) => {
  const { AudioEngine } = await import('/src/engine/Audio.ts');
  const SR = 16000;
  const cbErrors = [];
  /** run fn at render time t (each time only once), always resuming */
  const at = (ctx, t, fn) => {
    const q = Math.round(t * SR / 128) * 128 / SR;
    ctx.__used ??= new Set();
    if (ctx.__used.has(q)) return;
    ctx.__used.add(q);
    ctx.suspend(q).then(() => {
      try { fn(); } catch (e) { cbErrors.push(String(e && e.stack || e)); }
      ctx.resume();
    });
  };
  const pumpFor = (a, ctx, secs) => {
    a.pumpMusic(0, 0.9);
    for (let t = 0.5; t < secs; t += 0.5) { const tt = t; at(ctx, tt, () => a.pumpMusic(tt, 0.9)); }
  };
  const scapeFor = (a, ctx, s, secs = 8) => {
    a.musicMode = 'game';
    for (let t = 0; t < secs; t += 0.33) at(ctx, t, () => a.applyScape(s, 0.33));
  };
  const stats = (b) => {
    let peak = 0, nan = 0, sum = 0, dsum = 0, n = 0;
    for (let ch = 0; ch < b.numberOfChannels; ch++) {
      const d = b.getChannelData(ch);
      let prev = 0;
      for (const s of d) {
        if (Number.isNaN(s)) { nan++; continue; }
        peak = Math.max(peak, Math.abs(s));
        sum += s * s; dsum += (s - prev) * (s - prev); prev = s; n++;
      }
    }
    // brightness: rms of the first difference / rms (grows with the spectral centroid)
    return { peak: +peak.toFixed(3), rms: +Math.sqrt(sum / n).toFixed(4), bright: +(Math.sqrt(dsum / Math.max(1e-12, sum))).toFixed(3), nan };
  };
  const cases = {
    explode: (a) => a.play('explode'),
    thunder: (a) => a.thunder(40),
    stoneBreak: (a) => a.dig('stone', 1, 1, 3),
    zombie: (a) => a.mobSound('zombie', 1),
    land: (a) => a.land('grass', 2, 8),
    death: (a) => a.play('death'),
    title: (a, ctx) => { a.musicMode = 'menu'; a.startPiece(0); pumpFor(a, ctx, 8); },
    rainOpen: (a, ctx) => scapeFor(a, ctx, { ...SCAPE, weather: 'rain', intensity: 0.8 }),
    rainLeaves: (a, ctx) => scapeFor(a, ctx, { ...SCAPE, weather: 'rain', intensity: 0.8, roof: 'leaves', leaves: 0.8 }),
    rainRoof: (a, ctx) => scapeFor(a, ctx, { ...SCAPE, weather: 'rain', intensity: 0.8, roof: 'solid' }),
    storm: (a, ctx) => scapeFor(a, ctx, { ...SCAPE, weather: 'thunder', intensity: 1 }),
    snow: (a, ctx) => scapeFor(a, ctx, { ...SCAPE, biome: 'snow', cold: true, weather: 'rain', intensity: 0.8 }),
    blizzard: (a, ctx) => scapeFor(a, ctx, { ...SCAPE, biome: 'snow', cold: true, weather: 'thunder', intensity: 1, y: 110 }),
    blizzardIndoors: (a, ctx) => scapeFor(a, ctx, { ...SCAPE, biome: 'snow', cold: true, weather: 'thunder', intensity: 1, y: 110, roof: 'solid' }),
    forestWind: (a, ctx) => scapeFor(a, ctx, { ...SCAPE, biome: 'forest', leaves: 1, y: 100 }),
    coast: (a, ctx) => scapeFor(a, ctx, { ...SCAPE, ocean: true, water: 1 }),
    stream: (a, ctx) => scapeFor(a, ctx, { ...SCAPE, flow: 1 }),
    hearth: (a, ctx) => scapeFor(a, ctx, { ...SCAPE, fire: 1, roof: 'solid' }),
    caveLava: (a, ctx) => scapeFor(a, ctx, { ...SCAPE, underground: true, sky: 0, y: 30, enclosed: 1, room: 12, lava: 0.7 }),
    combat: (a, ctx) => { a.musicMode = 'game'; a.threat = 0.9; pumpFor(a, ctx, 8); },
  };
  const palettes = [['day', 'forest'], ['day', 'plains'], ['day', 'desert'], ['day', 'snow'], ['day', 'ocean'], ['day', 'village'],
    ['day', 'jungle'], ['day', 'peak'], ['night', 'swamp'], ['night', 'plains'], ['cave'], ['nether'], ['underwater'], ['creative', 'plains'],
    ['day', 'plains', 'rain']];
  palettes.forEach(([env, biome, rain], pi) => {
    cases[`music:${env}/${biome ?? ''}${rain ? '/rain' : ''}`] = (a, ctx, res) => {
      a.musicMode = 'game';
      a.env = env === 'creative' || env === 'underwater' ? 'day' : env;
      a.musicCtx = env === 'underwater' ? 'underwater' : env === 'cave' ? 'cave' : env === 'nether' ? 'nether' : 'surface';
      a.biome = biome;
      a.scape = { ...SCAPE, creative: env === 'creative' };
      if (rain) a.rainState = 'rain';
      res.name = a.startPiece(0, 1234 + pi * 77);
      a.piece.t0 = -14; // start mid-piece so the melody is sounding
      pumpFor(a, ctx, 8);
    };
  });
  for (const k of ['village', 'peak', 'sunrise', 'nightfall', 'cave']) cases['sting:' + k] = (a) => { a.musicMode = 'game'; a.playStinger(k, 0); };

  window.__runCase = async (k) => {
    const ctx = new OfflineAudioContext(2, SR * 8, SR);
    const a = new AudioEngine();
    a.attachContext(ctx);
    const res = {};
    cases[k](a, ctx, res);
    const b = await ctx.startRendering();
    return { ...res, ...stats(b), voices: a.debugStats().peak.music, cbErrors: cbErrors.splice(0) };
  };
  // leak check: fire everything into one offline context; once rendered, every
  // event must have torn itself down and every bed must have been reaped
  window.__leak = async () => {
    const ctx = new OfflineAudioContext(2, SR * 18, SR);
    const a = new AudioEngine();
    a.attachContext(ctx);
    a.musicMode = 'game';
    const sfx = ['pop', 'hurt', 'hit', 'eat', 'burp', 'click', 'craft', 'level', 'doorOpen', 'doorClose', 'explode', 'bow',
      'snap', 'fuse', 'arrowHit', 'thunder', 'splash', 'mount', 'chestOpen', 'chestClose', 'advancement', 'equip',
      'jump', 'death', 'drink', 'ignite', 'bell', 'crackle'];
    sfx.forEach((n, i) => at(ctx, 0.1 + i * 0.05, () => a.play(n)));
    for (let id = 1; id < 90; id += 3) at(ctx, 1.6 + id * 0.01, () => { a.dig('stone', 1, 1, id); a.step('grass', id, 'sprint'); });
    ['pig', 'cow', 'zombie', 'skeleton', 'wolf', 'cat', 'horse', 'villager'].forEach((k, i) =>
      at(ctx, 3 + i * 0.1, () => a.mobSound(k, 1, i % 2 ? 'hurt' : 'idle')));
    ['day', 'night', 'cave', 'nether'].forEach((env, i) => at(ctx, 4.05 + i * 0.2, () => { a.atmosphereT = 0; a.ambientTick(0.01, env, 'plains'); }));
    const busy = { ...SCAPE, leaves: 1, ocean: true, water: 1, flow: 1, fire: 1, lava: 1, villagers: 4, weather: 'thunder', intensity: 1, y: 110, threat: 0.8, underground: false };
    for (let t = 5; t < 8; t += 0.33) at(ctx, t, () => { a.applyScape(busy, 0.33); a.heartbeatTick(0.33, 0.1); a.pumpMusic(ctx.currentTime, 0.9); });
    at(ctx, 6.1, () => { a.setUnderwater(true); a.thunder(30); });
    at(ctx, 8.1, () => a.setUnderwater(false));
    for (let t = 8.2; t < 16.4; t += 0.33) at(ctx, t, () => { a.applyScape({ ...SCAPE }, 0.33); a.heartbeatTick(0.33, 1); a.threat = 0; a.pumpMusic(ctx.currentTime, 0.9); });
    await ctx.startRendering();
    await new Promise((r) => setTimeout(r, 300)); // let queued 'ended' events dispatch
    const st = a.debugStats();
    return { ...st.live, beds: Object.keys(st.beds), cbErrors: cbErrors.splice(0) };
  };
  return Object.keys(cases);
}, SCAPE);

const lk = await off.evaluate(() => window.__leak());
console.log('leak check:', JSON.stringify(lk));
const offline = {};
for (const k of caseNames) {
  const t0 = Date.now();
  offline[k] = await off.evaluate((k) => window.__runCase(k), k);
  const r = offline[k];
  console.log(`  ${k.padEnd(26)} peak ${String(r.peak).padEnd(6)} rms ${String(r.rms).padEnd(7)} bright ${String(r.bright).padEnd(6)} voices ${String(r.voices).padEnd(3)} ${r.name ?? ''} (${Date.now() - t0} ms)`);
}
if (lk.sfx || lk.amb) fail.push(`events leaked after offline render: sfx ${lk.sfx}, amb ${lk.amb}`);
// a faint open-air breeze is meant to stay; everything else must have been reaped
if (lk.beds.some((b) => b !== 'wind')) fail.push('beds not reaped after calm: ' + lk.beds.join(','));
if (lk.cbErrors.length) fail.push('leak-check callbacks threw: ' + lk.cbErrors[0]);
for (const [k, r] of Object.entries(offline)) {
  if (r.cbErrors.length) fail.push(`${k}: callback threw: ${r.cbErrors[0]}`);
  if (r.nan) fail.push(`${k}: NaN samples`);
  if (r.peak >= 0.99) fail.push(`${k}: clipping`);
  if (r.peak < 0.005) fail.push(`${k}: silent`);
  if (r.voices >= 80) fail.push(`${k}: music voice cap hit`);
}
// the rain must stay dark and soft (no hiss), quieter than before, and muffle under a roof
if (offline.rainOpen.bright > 0.35) fail.push('rain too bright/hissy: ' + offline.rainOpen.bright);
if (offline.rainOpen.rms > 0.06) fail.push('rain too loud: ' + offline.rainOpen.rms);
if (offline.rainRoof.bright >= offline.rainOpen.bright) fail.push('roof rain not muffled');
if (offline.blizzard.rms <= offline.snow.rms * 1.5) fail.push('blizzard wind not clearly louder than calm snowfall');
if (offline.blizzardIndoors.rms >= offline.blizzard.rms) fail.push('blizzard not muffled indoors');
console.log('errors:', errors.length ? errors.slice(0, 8).join('\n') : 'NONE');
console.log(fail.length ? 'FAIL\n' + fail.join('\n') : 'PASS');
await browser.close();
await server.close();
process.exit(fail.length || errors.length ? 1 : 0);
