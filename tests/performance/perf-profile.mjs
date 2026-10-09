// Frame-CPU profiling harness: boots a creative #debugmobs world and measures
// per-frame CPU (time inside Game.loop), per-system timers, long tasks (>50 ms),
// main-thread busy time and draw calls across scenarios. SwiftShader makes GPU
// numbers meaningless, so everything here is CPU-side.
//   PORT (default 5642), SCEN=idle,fly,mobs,drops,edit,rd12 (subset), PROFILE=1
//   (CDP sampling profile per scenario, top self-time functions), SECS (per scenario)
import { chromium } from 'playwright';
import { createServer } from 'vite';

const PORT = +(process.env.PORT ?? 5642);
const SECS = +(process.env.SECS ?? 6);
const PROFILE = process.env.PROFILE === '1';
const SCEN = (process.env.SCEN ?? 'idle,fly,mobs,drops,edit,rd12').split(',');

const server = await createServer({ root: process.cwd(), logLevel: 'error', server: { port: PORT, strictPort: true } });
await server.listen();
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');

await page.goto(`http://localhost:${PORT}/#debugmobs`);
await page.waitForTimeout(1000);
await page.locator('.mode-pick button', { hasText: 'Creative' }).click();
await page.locator('.create-btn').click();
await page.waitForSelector('#loading.hidden', { timeout: 90000, state: 'attached' });
await page.waitForFunction(() => window.__game, null, { timeout: 30000 });

// instrumentation: wrap the frame loop + per-system methods
await page.evaluate(() => {
  const g = window.__game;
  const P = (window.__perf = { frames: [], sys: {}, cur: {}, long: [], on: false, calls: [], tris: [] });
  const wrap = (obj, name, label) => {
    const orig = obj[name];
    if (typeof orig !== 'function') return;
    obj[name] = function (...a) {
      const t0 = performance.now();
      try { return orig.apply(this, a); } finally {
        const d = performance.now() - t0;
        P.cur[label] = (P.cur[label] ?? 0) + d;
      }
    };
  };
  wrap(g.world, 'update', 'world.update');
  wrap(g, 'processMeshing', 'processMeshing');
  wrap(g, 'onMeshDone', 'onMeshDone(msg)');
  wrap(g.world, 'onGenDone', 'onGenDone(msg)');
  wrap(g.entities, 'update', 'entities.update');
  wrap(g.entities, 'tick', 'entities.tick');
  wrap(g, 'tick20', 'tick20');
  wrap(g.player, 'update', 'player.update');
  wrap(g.player, 'tick', 'player.tick');
  wrap(g.audio, 'listen', 'audio.listen');
  wrap(g.audio, 'ambientTick', 'audio.ambientTick');
  wrap(g.renderer, 'render', 'renderer.render');
  wrap(g.renderer, 'updateEnvironment', 'renderer.updateEnv');
  wrap(g.renderer, 'updateHeld', 'renderer.updateHeld');
  wrap(g.nether, 'update', 'nether.update');
  wrap(g.weather, 'update', 'weather.update');
  wrap(g.hud, 'updateStats', 'hud.updateStats');
  wrap(g.hud, 'updateMinimap', 'hud.updateMinimap');
  wrap(g.hud, 'updatePets', 'hud.updatePets');
  wrap(g.status, 'update', 'status.update');
  wrap(g.world, 'updateDoorSwings', 'world.doorSwings');
  wrap(g.xpOrbs, 'update', 'xpOrbs.update');
  wrap(g.mapOverlay, 'update', 'mapOverlay.update');
  wrap(g.entities, 'raycastMobs', 'entities.raycastMobs');
  wrap(g, 'emitAmbientParticles', 'ambientParticles');
  wrap(g.world, 'tickWater', 'world.tickWater');
  wrap(g, 'randomTicks', 'randomTicks');
  const info = g.renderer.three.info;
  info.autoReset = false;
  const loop = g.loop;
  g.loop = (now) => {
    info.reset();
    const t0 = performance.now();
    loop(now);
    const d = performance.now() - t0;
    if (P.on) {
      P.frames.push(d);
      P.calls.push(info.render.calls); P.tris.push(info.render.triangles);
      for (const k in P.cur) (P.sys[k] ??= []).push(P.cur[k]);
    }
    P.cur = {};
  };
  // message-handler costs land outside loop: keep them in cur but flush per frame too
  new PerformanceObserver((l) => { if (P.on) for (const e of l.getEntries()) P.long.push(e.duration); }).observe({ entryTypes: ['longtask'] });
});

// let the initial area finish
async function settle(maxMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const q = await page.evaluate(() => window.__game.world.dirtySet.size + window.__game.meshInFlight.size);
    if (q === 0) break;
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(500);
}
await page.evaluate(() => { const g = window.__game; g.player.flying = true; g.player.pos.y += 30; g.player.vel.y = 0; g.player.pitch = 0.15; });
await settle();

const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const results = {};

async function measure(name, during) {
  await page.evaluate(() => { const P = window.__perf; P.frames = []; P.sys = {}; P.long = []; P.calls = []; P.tris = []; P.on = true; });
  const m0 = await cdp.send('Performance.getMetrics');
  if (PROFILE) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 250 }); await cdp.send('Profiler.start'); }
  const t0 = Date.now();
  await during();
  const wall = (Date.now() - t0) / 1000;
  let profile = null;
  if (PROFILE) { profile = (await cdp.send('Profiler.stop')).profile; }
  const m1 = await cdp.send('Performance.getMetrics');
  const r = await page.evaluate(() => { const P = window.__perf; P.on = false; return { frames: P.frames, sys: P.sys, long: P.long, calls: P.calls, tris: P.tris, mobs: window.__game.entities.counts(), chunks: window.__game.world.countLoaded() }; });
  const met = (m, k) => m.metrics.find((x) => x.name === k)?.value ?? 0;
  const busy = (met(m1, 'TaskDuration') - met(m0, 'TaskDuration')) / wall;
  const script = (met(m1, 'ScriptDuration') - met(m0, 'ScriptDuration')) / wall;
  const n = r.frames.length;
  const out = {
    frames: n, fps: +(n / wall).toFixed(1),
    med: +pct(r.frames, 0.5).toFixed(2), p95: +pct(r.frames, 0.95).toFixed(2), p99: +pct(r.frames, 0.99).toFixed(2), max: +Math.max(0, ...r.frames).toFixed(1),
    over16: r.frames.filter((f) => f > 16.7).length,
    long: r.long.length, longMax: +Math.max(0, ...r.long).toFixed(0),
    busyPct: +(busy * 100).toFixed(1), scriptPct: +(script * 100).toFixed(1),
    calls: pct(r.calls, 0.5), tris: pct(r.tris, 0.5), ents: r.mobs, chunks: r.chunks,
  };
  const sys = {};
  for (const k in r.sys) {
    const a = r.sys[k];
    const total = a.reduce((s, x) => s + x, 0);
    sys[k] = { perFrame: +(total / Math.max(1, n)).toFixed(3), p95: +pct(a, 0.95).toFixed(2), max: +Math.max(...a).toFixed(1) };
  }
  results[name] = out;
  console.log(`\n=== ${name} ===`);
  console.log(JSON.stringify(out));
  const top = Object.entries(sys).sort((a, b) => b[1].perFrame - a[1].perFrame);
  for (const [k, v] of top) console.log(`  ${k.padEnd(24)} avg ${v.perFrame.toFixed(3)} ms  p95 ${v.p95}  max ${v.max}`);
  if (profile) {
    const self = new Map();
    const byId = new Map(profile.nodes.map((nd) => [nd.id, nd]));
    const dts = profile.timeDeltas;
    const counts = new Map();
    for (let i = 0; i < profile.samples.length; i++) counts.set(profile.samples[i], (counts.get(profile.samples[i]) ?? 0) + (dts[i] ?? 0));
    let tot = 0;
    for (const [id, us] of counts) {
      const nd = byId.get(id); const cf = nd.callFrame;
      const key = `${cf.functionName || '(anon)'} ${cf.url.split('/').pop().split('?')[0]}:${cf.lineNumber + 1}`;
      self.set(key, (self.get(key) ?? 0) + us); tot += us;
    }
    const rows = [...self].sort((a, b) => b[1] - a[1]).slice(0, 28);
    console.log(`  -- top self time (total ${(tot / 1000).toFixed(0)} ms over ${wall.toFixed(1)} s)`);
    for (const [k, us] of rows) console.log(`    ${(us / 1000).toFixed(1).padStart(7)} ms  ${(100 * us / tot).toFixed(1).padStart(5)}%  ${k}`);
  }
}

if (SCEN.includes('idle')) {
  await measure('idle (rd8, 6 debug mobs)', () => page.waitForTimeout(SECS * 1000));
}

if (SCEN.includes('fly')) {
  // fly east at 20 m/s (stream new chunks continuously)
  await page.evaluate(() => {
    const g = window.__game; g.player.yaw = -Math.PI / 2;
    window.__fly = setInterval(() => { g.player.pos.x += 20 * 0.05; g.player.vel.x = 0; g.player.vel.y = 0; }, 50);
  });
  await measure('fly 20 m/s (rd8)', () => page.waitForTimeout(SECS * 1000 * 1.5));
  await page.evaluate(() => clearInterval(window.__fly));
  await settle();
}

if (SCEN.includes('mobs')) {
  await page.evaluate(() => {
    const g = window.__game; const p = g.player.pos;
    g.player.flying = false;
    const kinds = ['cow', 'pig', 'sheep', 'chicken', 'zombie', 'skeleton', 'villager', 'wolf', 'horse', 'spider'];
    for (let i = 0; i < 60; i++) {
      const a = Math.random() * Math.PI * 2, r = 4 + Math.random() * 14;
      const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
      const c = g.world.getChunk(Math.floor(x / 16), Math.floor(z / 16));
      const h = c ? c.heightmap[(Math.floor(z) & 15) * 16 + (Math.floor(x) & 15)] : p.y;
      try { g.entities.spawnMob(kinds[i % kinds.length], x, h + 0.1, z); } catch (e) { console.log('spawn fail', kinds[i % kinds.length]); }
    }
    g.dayTime = 0.25;
  });
  await page.waitForTimeout(1500);
  await measure('60 mobs nearby', () => page.waitForTimeout(SECS * 1000));
}

if (SCEN.includes('drops')) {
  await page.evaluate(() => {
    const g = window.__game; const p = g.player.pos;
    for (let i = 0; i < 150; i++) g.entities.spawnDrop(p.x + (Math.random() - 0.5) * 12, p.y + 3, p.z + 6 + (Math.random() - 0.5) * 12, window.__B.DIRT + (i % 5), 1);
    window.__fx = setInterval(() => {
      for (let i = 0; i < 4; i++) g.entities.spawnBlockParticles(Math.floor(p.x) + 3, Math.floor(p.y), Math.floor(p.z) + 3, window.__B.STONE, 8);
      g.entities.spawnPoof(p.x + 2, p.y + 1, p.z + 2);
    }, 100);
  });
  await page.waitForTimeout(800);
  await measure('150 drops + particles', () => page.waitForTimeout(SECS * 1000));
  await page.evaluate(() => clearInterval(window.__fx));
}

if (SCEN.includes('edit')) {
  // place/break blocks near the player 4x a second (remesh storm incl. torch light)
  await page.evaluate(() => {
    const g = window.__game; const p = g.player.pos; const B = window.__B;
    const bx = Math.floor(p.x) + 3, by = Math.floor(p.y) + 1, bz = Math.floor(p.z);
    let n = 0;
    g.world.setBlock(bx + 2, by, bz + 2, B.TORCH);
    window.__ed = setInterval(() => {
      const k = n++ % 8;
      const x = bx + (k % 4), z = bz + 3 + (k >> 2);
      const cur = g.world.getBlock(x, by, z);
      g.world.setBlock(x, by, z, cur === B.AIR ? B.STONE : B.AIR);
    }, 250);
  });
  await measure('edit 4/s near torch', () => page.waitForTimeout(SECS * 1000));
  await page.evaluate(() => clearInterval(window.__ed));
}

if (SCEN.includes('rd12')) {
  await page.evaluate(() => { const g = window.__game; g.world.viewDist = 12; g.renderer.setViewDistance(12); g.player.flying = true; });
  await settle(90000);
  await measure('idle rd12', () => page.waitForTimeout(SECS * 1000));
  await page.evaluate(() => {
    const g = window.__game; g.player.yaw = -Math.PI / 2;
    window.__fly = setInterval(() => { g.player.pos.x += 20 * 0.05; g.player.vel.x = 0; g.player.vel.y = 0; }, 50);
  });
  await measure('fly 20 m/s (rd12)', () => page.waitForTimeout(SECS * 1000 * 1.5));
  await page.evaluate(() => clearInterval(window.__fly));
}

console.log('\nSUMMARY');
for (const [k, v] of Object.entries(results)) console.log(`${k.padEnd(28)} med ${v.med}  p95 ${v.p95}  p99 ${v.p99}  max ${v.max}  long ${v.long} (max ${v.longMax})  busy ${v.busyPct}%  calls ${v.calls}  tris ${v.tris}  fps ${v.fps}`);
console.log('errors:', errors.length ? errors.slice(0, 5).join('\n') : 'NONE');
await browser.close(); await server.close(); process.exit(0);
