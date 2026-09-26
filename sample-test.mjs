// Sampled-instrument harness (Tone.js Samplers over public/audio):
//  1. offline loudness match: each sampled instrument vs its synth voice, same
//     phrase, rendered in OfflineAudioContexts (prints RMS + brightness ratios)
//  2. live title screen: unlock audio, wait for the samples, check the title
//     theme is playing sampled voices, no console errors
//  3. fallback: with /audio/ returning 404 the music still plays (synth), and
//     nothing but the expected failed-resource messages hits the console
// PORT env (default 5505).
import { chromium } from 'playwright';
import { createServer } from 'vite';

const PORT = +(process.env.PORT ?? 5505);
const server = await createServer({
  root: process.cwd(), logLevel: 'silent',
  server: { port: PORT, watch: { ignored: ['**/.claude/**'] } },
});
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const fail = [];

// ---- 1. offline loudness match ------------------------------------------------
{
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('response', (r) => { if (r.url().includes('/audio/') && r.status() >= 400) errors.push('HTTP ' + r.status() + ' ' + r.url()); });
  await page.goto(`http://localhost:${PORT}/package.json`);
  const res = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/engine/Audio.ts');
    const SR = 32000, LEN = 7;
    // a representative phrase per instrument (MIDI, velocity, hold, start)
    const phrases = {
      piano: [[48, 0.45, 3, 0], [55, 0.3, 2.5, 0.4], [60, 0.3, 2, 0.8], [64, 0.35, 2, 1.2], [67, 0.4, 2, 1.6], [72, 0.45, 2, 2.4], [60, 0.3, 3, 3.2], [64, 0.3, 3, 3.2]],
      harp: [[43, 0.4, 3, 0], [50, 0.3, 2.5, 0.35], [55, 0.3, 2, 0.7], [59, 0.3, 2, 1.05], [62, 0.35, 2, 1.4], [67, 0.3, 2, 1.75], [71, 0.3, 2, 2.1], [74, 0.35, 3, 2.8]],
      flute: [[72, 0.5, 0.9, 0], [74, 0.5, 0.45, 1], [76, 0.5, 1.4, 1.5], [79, 0.5, 0.9, 3], [77, 0.5, 2, 4]],
      cello: [[48, 0.4, 3.5, 0], [55, 0.35, 1.8, 3.6], [52, 0.35, 1.2, 5.4]],
      strings: [[55, 0.42, 5, 0], [59, 0.42, 5, 0], [62, 0.42, 5, 0]],
    };
    const stats = (b, from = 0) => {
      let sum = 0, dsum = 0, n = 0, peak = 0;
      for (let ch = 0; ch < b.numberOfChannels; ch++) {
        const d = b.getChannelData(ch);
        let prev = 0;
        for (let i = Math.floor(from * b.sampleRate); i < d.length; i++) {
          const s = d[i]; peak = Math.max(peak, Math.abs(s));
          sum += s * s; dsum += (s - prev) * (s - prev); prev = s; n++;
        }
      }
      return { rms: Math.sqrt(sum / n), bright: Math.sqrt(dsum / Math.max(1e-12, sum)), peak };
    };
    const render = async (inst, sampled) => {
      const ctx = new OfflineAudioContext(2, SR * LEN, SR);
      const a = new AudioEngine();
      a.attachContext(ctx);
      let set = new Set();
      if (sampled) set = new Set(await a.loadSamples([inst]));
      if (sampled && !set.has(inst)) return null;
      for (const [m, v, d, t] of phrases[inst]) a.note({ t: 0, i: inst, m, v, d }, 0.05 + t, a.musicBus, set);
      const b = await ctx.startRendering();
      return stats(b);
    };
    const out = {};
    for (const inst of Object.keys(phrases)) {
      const syn = await render(inst, false);
      const smp = await render(inst, true);
      out[inst] = { syn, smp };
    }
    return out;
  });
  console.log('loudness (synth vs sampled, same phrase):');
  for (const [k, { syn, smp }] of Object.entries(res)) {
    if (!smp) { fail.push(`${k}: samples did not load offline`); continue; }
    const db = 20 * Math.log10(smp.rms / syn.rms);
    console.log(`  ${k.padEnd(8)} synth rms ${syn.rms.toFixed(4)} bright ${syn.bright.toFixed(3)} | sampled rms ${smp.rms.toFixed(4)} bright ${smp.bright.toFixed(3)} peak ${smp.peak.toFixed(3)} | ${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`);
    if (Math.abs(db) > 2.5) fail.push(`${k}: sampled level ${db.toFixed(1)} dB off the synth voice`);
    if (smp.peak >= 0.99) fail.push(`${k}: sampled clipping`);
  }
  if (errors.length) fail.push('offline errors: ' + errors.slice(0, 4).join(' | '));
  await page.close();
}

// ---- 2 + 3. live title screen, with and without the samples -------------------
async function titleRun(block) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  if (block) await page.route('**/audio/**', (r) => r.fulfill({ status: 404, body: 'nope' }));
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForTimeout(800);
  await page.mouse.click(10, 10); // user gesture: unlocks audio
  const st = await page.evaluate(async () => {
    const a = window.__audio;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const t0 = performance.now();
    // every instrument settles (decoding is slow on a loaded machine)
    while (performance.now() - t0 < 90000) {
      const s = a.debugStats();
      if (s.samples && !Object.values(s.samples).some((x) => x === 'loading' || x === 'idle')) break;
      await wait(250);
    }
    const settledMs = Math.round(performance.now() - t0);
    // a piece that began before the piano arrived stays synth; start a fresh one
    if (a.debugStats().sampledNotes === 0) { a.fadePiece(0.5); a.nextPieceAt = 0; a.menuCount = 0; }
    await wait(9000);
    return { ...a.debugStats(), settledMs, ctx: a.ctx?.state };
  });
  await page.close();
  return { st, errors };
}

{
  const { st, errors } = await titleRun(false);
  console.log('title (samples):', JSON.stringify({ piece: st.piece, samples: st.samples, sampledNotes: st.sampledNotes, sampleVoices: st.sampleVoices, live: st.live, settledMs: st.settledMs, ctx: st.ctx }));
  if (!st.piece || !st.piece.startsWith('Title')) fail.push('title theme not playing: ' + st.piece);
  if (!st.samples || st.samples.piano !== 'ready') fail.push('piano samples not ready: ' + JSON.stringify(st.samples));
  if (st.samples && Object.values(st.samples).some((x) => x !== 'ready')) fail.push('an instrument failed to load: ' + JSON.stringify(st.samples));
  if (st.sampledNotes < 5) fail.push('title theme is not using the sampled piano: ' + st.sampledNotes);
  if (errors.length) fail.push('title errors: ' + errors.slice(0, 4).join(' | '));
}
{
  const { st, errors } = await titleRun(true);
  console.log('title (404 fallback):', JSON.stringify({ piece: st.piece, samples: st.samples, sampledNotes: st.sampledNotes, live: st.live, settledMs: st.settledMs, ctx: st.ctx }));
  if (!st.piece || !st.piece.startsWith('Title')) fail.push('fallback: title theme not playing: ' + st.piece);
  if (st.sampledNotes) fail.push('fallback: sampled notes played with no samples');
  if (st.live.music < 1) fail.push('fallback: no synth voices sounding');
  const unexpected = errors.filter((e) => !/Failed to load resource|404/.test(e));
  if (unexpected.length) fail.push('fallback errors: ' + unexpected.slice(0, 4).join(' | '));
}

console.log(fail.length ? 'FAIL\n' + fail.join('\n') : 'PASS');
await browser.close();
await server.close();
process.exit(fail.length ? 1 : 0);
