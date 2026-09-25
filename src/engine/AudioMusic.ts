// Generative score for the Web Audio engine: turns a seed + mood into a list
// of timed notes (pure data — Audio.ts schedules them just ahead of the clock).
// The aim is C418's calm Minecraft sound: sparse felt piano, wide pads, long
// silences, small motifs that come back changed — inverted, sequenced,
// fragmented — over a long arc, with a palette (harp, flute, music box,
// strings, cello…) and a key/tempo that follow the place you're in.

export type MusicEnv = 'day' | 'night' | 'cave' | 'nether' | 'menu' | 'underwater' | 'creative';
export type MusicBiomeKey =
  'plains' | 'forest' | 'desert' | 'snow' | 'taiga' | 'swamp' | 'mountains' | 'jungle'
  | 'ocean' | 'beach' | 'village' | 'peak';

export type Inst = 'piano' | 'epiano' | 'bell' | 'celesta' | 'pad' | 'bass' | 'drone'
  | 'harp' | 'musicbox' | 'flute' | 'ocarina' | 'strings' | 'cello' | 'tom';

/** One scheduled note: time (s from piece start), instrument, MIDI pitch,
 *  velocity 0..1, hold time (s), optional stereo pan. */
export interface MNote { t: number; i: Inst; m: number; v: number; d: number; p?: number }

export interface Composition {
  name: string;
  notes: MNote[];
  len: number;     // seconds until the last note starts ringing out
  beat: number;    // seconds per beat (the delay line is synced to it)
  tonic: number;   // MIDI tonic (octave 3) — stingers + the combat layer play in key
  minor: boolean;  // the piece's third is flat
}

export interface ComposeOpts {
  /** it's raining: lean into the mellow, pedalled, slower pieces */
  rain?: boolean;
}

type Style = 'hymn' | 'flow' | 'lullaby' | 'ambient' | 'title' | 'cave' | 'nether'
  | 'pastoral' | 'waltz' | 'elegy' | 'tide' | 'deep';

export const TITLE_SEED = 0x5eed;

const MODES: Record<string, number[]> = {
  ionian: [0, 2, 4, 5, 7, 9, 11],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  phrygianDom: [0, 1, 4, 5, 7, 8, 10],
};

// chord-root movements in scale degrees (0 = tonic), per modal family
const PROGS: Record<string, number[][]> = {
  ionian: [[0, 4, 5, 3], [0, 3, 0, 4], [0, 5, 3, 4], [3, 0, 4, 5], [0, 2, 3, 0], [5, 3, 0, 4], [0, 3, 5, 4], [0, 4, 3, 3]],
  lydian: [[0, 1, 0, 1], [0, 1, 4, 0], [0, 1, 5, 4], [0, 4, 1, 0]],
  mixolydian: [[0, 6, 3, 0], [0, 3, 6, 0], [0, 6, 4, 3]],
  dorian: [[0, 3, 0, 3], [0, 6, 3, 0], [0, 3, 6, 4], [0, 2, 3, 0]],
  aeolian: [[0, 5, 2, 6], [0, 3, 5, 4], [0, 6, 5, 6], [5, 6, 0, 0], [0, 5, 3, 4], [0, 3, 6, 2]],
  phrygian: [[0, 1, 0, 1], [0, 1, 6, 0], [0, 5, 1, 0]],
  phrygianDom: [[0, 1, 0, 1], [0, 1, 6, 0], [0, 5, 1, 0]],
};

// two-bar melody rhythms in beats (negative = rest)
const RH4 = [[1, 1, 2, 4], [2, 1, 1, 2, -2], [1.5, 0.5, 2, 3, -1], [-1, 1, 1, 1, 4], [3, 1, 2, 2], [2, 2, 1, 1, 2], [-2, 1, 1, 2, 2], [1, 1, 1, 1, 2, -2], [2, -1, 1, 4]];
const RH3 = [[2, 1, 3], [1, 1, 1, 3], [-1, 1, 1, 2, 1], [3, 2, 1], [1.5, 0.5, 1, 3], [2, 1, 2, -1]];
const STEPS = [-1, 1, -1, 1, -2, 2, 0, 3, -3, 1, -1, 2];

type Rng = () => number;
interface Motif { rh: number[]; steps: number[]; start: number }

/** Small fast seeded PRNG (mulberry32) so a seed always yields the same piece. */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(r: Rng, a: readonly T[]): T { return a[(r() * a.length) | 0]; }

function weighted<T>(r: Rng, opts: [T, number][]): T {
  let sum = 0;
  for (const [, w] of opts) sum += w;
  let x = r() * sum;
  for (const [v, w] of opts) { x -= w; if (x <= 0) return v; }
  return opts[opts.length - 1][0];
}

export function mtof(m: number): number { return 440 * Math.pow(2, (m - 69) / 12); }

// ---- motif development (every transform keeps the two-bar length) ------------

/** the first bar's worth of a rhythm, trimmed to exactly one bar */
function firstBar(m: Motif, meter: number): Motif {
  const rh: number[] = [];
  const steps: number[] = [];
  let sum = 0;
  for (let k = 0; k < m.rh.length && sum < meter; k++) {
    const len = Math.min(Math.abs(m.rh[k]), meter - sum);
    rh.push(m.rh[k] < 0 ? -len : len);
    steps.push(m.steps[k]);
    sum += len;
  }
  return { rh, steps, start: m.start };
}
const invert = (m: Motif): Motif => ({ ...m, steps: m.steps.map((s) => -s) });
const sequence = (m: Motif, by: number): Motif => ({ ...m, start: m.start + by });
/** the head of the motif, stated twice — the second time a step higher */
function fragmentOf(m: Motif, meter: number): Motif {
  const h = firstBar(m, meter);
  return { rh: [...h.rh, ...h.rh], steps: [...h.steps, 1, ...h.steps.slice(1)], start: m.start };
}
/** the head of the motif at half speed */
function augment(m: Motif, meter: number): Motif {
  const h = firstBar(m, meter);
  return { ...h, rh: h.rh.map((x) => x * 2) };
}

/** Compose one piece for the given mood. Deterministic for a given seed. */
export function compose(env: MusicEnv, biome: MusicBiomeKey | undefined, seed: number, opts: ComposeOpts = {}): Composition {
  const r = rng(seed);
  const title = env === 'menu' && seed === TITLE_SEED;
  const rain = !!opts.rain && (env === 'day' || env === 'night' || env === 'creative');

  // ---- style, mode and tempo from the environment -------------------------
  let style: Style;
  let mode: string;
  if (env === 'menu') {
    // the title screen should feel like coming home: warm, unhurried major-key
    // pieces low on the keyboard — no floaty lydian, no minor, no sparkle
    style = title ? 'title' : weighted<Style>(r, [['title', 3], ['lullaby', 2], ['hymn', 2]]);
    mode = title ? 'ionian' : weighted(r, [['ionian', 5], ['lydian', 1]]);
  } else if (env === 'nether') {
    style = 'nether';
    mode = weighted(r, [['phrygian', 2], ['phrygianDom', 2], ['aeolian', 1]]);
  } else if (env === 'cave') {
    style = weighted<Style>(r, [['cave', 5], ['ambient', 1], ['elegy', 1]]);
    mode = weighted(r, [['aeolian', 2], ['phrygian', 2], ['dorian', 1]]);
  } else if (env === 'underwater') {
    style = 'deep';
    mode = weighted(r, [['lydian', 2], ['dorian', 1], ['ionian', 1]]);
  } else if (env === 'creative') {
    style = weighted<Style>(r, [['flow', 3], ['pastoral', 3], ['waltz', 2], ['tide', 2], ['hymn', 2], ['ambient', 1]]);
    mode = weighted(r, [['lydian', 3], ['ionian', 3], ['mixolydian', 1]]);
  } else if (env === 'night') {
    style = weighted<Style>(r, [['ambient', 4], ['elegy', 3], ['hymn', 2], ['flow', 2], ['lullaby', 1]]);
    mode = weighted(r, [['aeolian', 3], ['dorian', 3], ['ionian', 1]]);
  } else {
    style = weighted<Style>(r, [['hymn', 3], ['flow', 3], ['pastoral', 3], ['lullaby', 2], ['ambient', 2], ['waltz', 1]]);
    mode = weighted(r, [['ionian', 4], ['lydian', 2], ['mixolydian', 1]]);
  }

  // ---- palette: who plays what ---------------------------------------------------
  let tempoMul = 1;
  let bells = 0.25;          // chance of bell doublings / sparkles
  let bellInst: Inst = 'bell';
  let padLift = 1;           // pad loudness
  let lead: Inst = 'piano';
  let counter: Inst = env === 'night' ? 'cello' : 'strings';
  let padInst: Inst = 'pad';
  let arp: Inst = 'piano';
  let drone = false;         // a low drone under everything (desert heat, peaks)
  const surface = env === 'day' || env === 'night' || env === 'creative';
  if (surface) {
    const night = env === 'night';
    switch (biome) {
      case 'forest':
        if (r() < 0.45 && style !== 'elegy') style = 'pastoral';
        mode = night ? pick(r, ['dorian', 'aeolian']) : pick(r, ['ionian', 'mixolydian', 'dorian']);
        lead = pick(r, ['flute', 'ocarina', 'piano']); arp = 'harp';
        break;
      case 'plains':
        if (r() < 0.3) lead = pick(r, ['flute', 'harp']);
        break;
      case 'snow': case 'taiga':
        mode = night ? 'aeolian' : pick(r, ['dorian', 'aeolian', 'ionian']);
        tempoMul = 0.88; bells = 0.6; bellInst = 'celesta'; padLift = 0.9; padInst = 'strings';
        lead = pick(r, ['musicbox', 'celesta', 'piano']);
        if (style === 'flow' || style === 'pastoral') style = r() < 0.4 ? 'waltz' : 'ambient';
        break;
      case 'desert':
        mode = night ? 'phrygianDom' : pick(r, ['mixolydian', 'dorian', 'phrygianDom']);
        tempoMul = 0.92; padLift = 1.15; lead = pick(r, ['ocarina', 'ocarina', 'piano']); arp = 'harp'; drone = true;
        if (style === 'waltz') style = 'pastoral';
        break;
      case 'jungle':
        mode = night ? 'dorian' : 'lydian';
        tempoMul = 1.1; lead = pick(r, ['flute', 'epiano', 'harp']); arp = 'harp'; bells = 0.35;
        if (style === 'hymn') style = 'pastoral';
        break;
      case 'swamp':
        mode = 'dorian'; tempoMul = 0.9; padLift = 1.2; lead = pick(r, ['epiano', 'cello']); counter = 'cello';
        break;
      case 'mountains':
        padLift = 1.3; bells = 0.45; padInst = 'strings';
        if (!night) mode = pick(r, ['ionian', 'lydian']);
        break;
      case 'peak':
        padLift = 1.4; bells = 0.5; padInst = 'strings'; drone = true; tempoMul = 0.9;
        mode = night ? 'dorian' : 'lydian';
        if (style === 'flow' || style === 'waltz') style = 'hymn';
        break;
      case 'ocean': case 'beach':
        if (r() < 0.6) style = 'tide';
        mode = night ? pick(r, ['dorian', 'aeolian']) : pick(r, ['ionian', 'lydian', 'mixolydian']);
        arp = 'harp'; lead = pick(r, ['piano', 'flute', 'harp']); padLift = 1.1;
        break;
      case 'village':
        style = weighted<Style>(r, [['waltz', 3], ['pastoral', 3], ['hymn', 2], ['lullaby', 1]]);
        mode = night ? 'dorian' : pick(r, ['ionian', 'mixolydian']);
        lead = pick(r, ['flute', 'harp', 'musicbox', 'piano']); arp = 'harp'; counter = 'cello';
        break;
    }
    if (env === 'creative' && lead === 'piano') lead = pick(r, ['epiano', 'flute', 'musicbox', 'piano']);
  }
  if (rain) {
    // rain: mellow, pedalled piano and soft pads; no bright sparkle
    style = weighted<Style>(r, [['ambient', 3], ['lullaby', 2], ['elegy', 1], ['hymn', 1], [style, 1]]);
    if (style === 'waltz' || style === 'tide') style = 'lullaby';
    if (mode === 'lydian' || mode === 'mixolydian') mode = r() < 0.5 ? 'dorian' : 'ionian';
    tempoMul *= 0.9; bells = 0.08; lead = r() < 0.7 ? 'piano' : 'epiano'; padInst = 'pad'; arp = 'piano';
  }
  if (env === 'menu') {
    tempoMul = title ? 1 : 0.86; // companions stay as unhurried as the theme
    bells = title ? 0.05 : 0.1; bellInst = 'celesta'; padInst = 'pad'; arp = 'piano'; counter = 'cello';
    lead = style === 'lullaby' ? 'epiano' : 'piano';
  }
  if (style === 'lullaby' && lead === 'piano') lead = r() < 0.6 ? 'celesta' : 'epiano';
  if (style === 'waltz' && (lead === 'piano' || lead === 'epiano')) lead = pick(r, ['musicbox', 'flute', 'harp']);
  if (style === 'elegy') { counter = 'cello'; padInst = 'strings'; if (lead !== 'piano' && lead !== 'cello') lead = 'piano'; }
  if (style === 'deep') { lead = 'celesta'; bells = 0.2; bellInst = 'celesta'; }

  const meter = style === 'lullaby' || style === 'waltz' ? 3
    : (style === 'hymn' || style === 'flow' || style === 'pastoral' || style === 'tide') && r() < 0.3 ? 3 : 4;
  const baseBpm: Record<Style, [number, number]> = {
    hymn: [56, 68], flow: [64, 78], lullaby: [74, 88], ambient: [48, 58],
    title: [50, 56], cave: [44, 54], nether: [40, 50], pastoral: [62, 76], waltz: [84, 100],
    elegy: [50, 60], tide: [58, 70], deep: [42, 50],
  };
  const [lo, hi] = baseBpm[style];
  const bpm = (lo + r() * (hi - lo)) * tempoMul;
  const beat = 60 / bpm;
  const bar = beat * meter;

  const sc = MODES[mode];
  const tonic = title ? 51 : env === 'menu' ? 48 + ((r() * 5) | 0) : 50 + ((r() * 8) | 0); // D3..A3 (menu lower and warmer: C3..E3, title Eb3)
  /** scale degree → MIDI (degree 0 = tonic in octave 3; 7 = an octave up) */
  const dm = (d: number): number => tonic + sc[((d % 7) + 7) % 7] + 12 * Math.floor(d / 7);
  const isChordTone = (d: number, root: number): boolean => {
    const k = (((d - root) % 7) + 7) % 7;
    return k === 0 || k === 2 || k === 4;
  };
  const snap = (d: number, root: number): number => {
    for (const o of [0, -1, 1, -2, 2]) if (isChordTone(d + o, root)) return d + o;
    return d;
  };

  const notes: MNote[] = [];
  const add = (t: number, i: Inst, m: number, v: number, d: number, p?: number): void => {
    const jitter = i === 'pad' || i === 'drone' || i === 'strings' ? 0 : (r() - 0.5) * 0.02;
    notes.push({ t: Math.max(0, t + jitter), i, m, v: Math.min(1, v * (0.88 + r() * 0.2)), d, p });
  };
  /** close-position voicing of a chord (n tones from root in thirds), around a centre pitch */
  const voice = (root: number, n: number, center: number): number[] => {
    const degs = n >= 4 && r() < 0.4 ? [root, root + 2, root + 4, root + 8] : [root, root + 2, root + 4, root + 6].slice(0, n);
    return degs.map((d) => {
      let m = dm(d);
      while (m < center - 6) m += 12;
      while (m > center + 6) m -= 12;
      return m;
    }).sort((a, b) => a - b);
  };
  const bassM = (d: number): number => { let m = dm(d) - 12; while (m > 50) m -= 12; while (m < 36) m += 12; return m; };

  // ---- form: sections of bars, each with a chord root ------------------------
  const progs = PROGS[mode];
  const progA = pick(r, progs);
  let progB = pick(r, progs);
  if (progB === progA) progB = progs[(progs.indexOf(progA) + 1) % progs.length];
  const progC = [...progB].reverse();
  let form: string[];
  const slow = style === 'ambient' || style === 'cave' || style === 'nether' || style === 'deep';
  if (slow) {
    const n = 16 + (((r() * 3) | 0) * 4);
    form = new Array(n).fill('X');
  } else if (style === 'title') {
    // statement, gentle restatement, a warmer middle, and the theme coming home
    // over a cello line
    form = ['I', 'I', ...Array(4).fill('A'), ...Array(4).fill('A2'), ...Array(4).fill('B'), ...Array(4).fill('A3'), 'O', 'O'];
  } else {
    // long arc: statement, varied restatement, contrast, (development), recapitulation
    const withB = r() < 0.85;
    const withC = env !== 'menu' && r() < 0.6;
    form = ['I', 'I', ...Array(4).fill('A'), ...Array(4).fill('A2'),
      ...(withB ? Array(4).fill('B') : []), ...(withC ? Array(4).fill('C') : []), ...Array(4).fill('A3'), 'O', 'O'];
  }
  const nBars = form.length;
  const chordOf: number[] = [];
  const secStartOf: number[] = [];
  let secStart = 0;
  for (let b = 0; b < nBars; b++) {
    const sec = form[b];
    if (b > 0 && sec !== form[b - 1]) secStart = b;
    secStartOf.push(secStart);
    const pr = sec === 'B' ? progB : sec === 'C' ? progC : progA;
    const idx = slow ? Math.floor(b / 2) : sec === 'I' ? 0 : b - secStart;
    chordOf.push(sec === 'O' ? 0 : pr[idx % pr.length]);
  }
  const energy: Record<string, number> = { I: 0.8, A: 0.92, A2: 1, B: 1.08, C: 1.12, A3: 1, O: 0.85, X: 1 };

  // ---- melody motifs ----------------------------------------------------------
  const motif = (): Motif => {
    const rh = pick(r, meter === 3 ? RH3 : RH4);
    return { rh, steps: rh.map(() => pick(r, STEPS)), start: 9 + pick(r, [0, 2, 2, 4, -2]) };
  };
  const motA = motif();
  const motB = motif();
  motB.start = motA.start + pick(r, [2, 3, 4]);
  const leadOct = lead === 'musicbox' ? 1 : lead === 'cello' ? -1 : 0;
  /** play a two-bar motif from bar b; varied = small changes for the repeat */
  const phrase = (b: number, mot: Motif, inst: Inst, v: number, varied: boolean, resolve: boolean, octave = 0): void => {
    let d = snap(mot.start + (varied ? pick(r, [0, 0, 1, -1]) : 0), chordOf[b]);
    let t = b * bar;
    const t0 = t;
    const legato = inst === 'flute' || inst === 'ocarina' || inst === 'cello' || inst === 'strings';
    for (let k = 0; k < mot.rh.length; k++) {
      const len = mot.rh[k];
      if (len < 0) { t += -len * beat; continue; }
      if (k > 0) d += varied && r() < 0.3 ? pick(r, STEPS) : mot.steps[k];
      const barIdx = Math.min(nBars - 1, Math.floor(t / bar + 1e-6));
      const onDown = Math.abs(((t - t0) / beat) % meter) < 1e-3;
      if (onDown) d = snap(d, chordOf[barIdx]);
      const last = k === mot.rh.length - 1 || (k === mot.rh.length - 2 && mot.rh[k + 1] < 0);
      if (last && resolve) d = snap(d, chordOf[barIdx]);
      d = Math.max(7, Math.min(env === 'menu' ? 14 : 18, d)); // menu melodies stay in the mellow middle
      add(t, inst, dm(d) + 12 * octave, v, legato ? len * beat * 0.98 + (last ? 0.6 : 0) : len * beat * 1.7 + (last ? 1.5 : 0));
      if (bells > 0 && r() < bells * 0.35) add(t + 0.01, bellInst, dm(d) + 12 * (octave + 1), v * 0.28, 2);
      t += len * beat;
    }
  };
  // the development section walks the motif through its transformations
  const devel = [invert(motA), sequence(fragmentOf(motA, meter), 2), sequence(augment(motB, meter), -1), sequence(invert(motB), 1)];

  // ---- accompaniment per style ------------------------------------------------
  for (let b = 0; b < nBars; b++) {
    const tb = b * bar;
    const sec = form[b];
    const root = chordOf[b];
    const e = energy[sec] ?? 1;

    switch (style) {
      case 'hymn': {
        add(tb, 'piano', bassM(root), 0.5 * e, bar * 1.6);
        if (meter === 4 && r() < 0.5) add(tb + 2 * beat, 'piano', bassM(root + 4), 0.3 * e, bar);
        const vo = voice(root, r() < 0.35 ? 4 : 3, 58);
        vo.forEach((m, k) => add(tb + k * 0.035, 'piano', m, 0.3 * e, bar * 1.1));
        if (meter === 3) {
          for (const bt of [1, 2]) vo.forEach((m) => add(tb + bt * beat, 'piano', m, 0.17 * e, beat * 1.2));
        } else if (r() < 0.35) {
          vo.forEach((m, k) => add(tb + 2 * beat + k * 0.03, 'piano', m, 0.18 * e, bar * 0.6));
        }
        if (sec === 'A2' || sec === 'B' || sec === 'C' || sec === 'A3') {
          for (const m of voice(root, 3, 55)) add(tb, padInst, m, 0.45 * padLift, bar * 1.05);
        }
        break;
      }
      case 'flow': case 'pastoral': case 'tide': {
        // broken chords, pedalled: every note of the bar rings until the pedal
        // lifts at the next bar line
        const pat = style === 'tide'
          ? (meter === 4 ? [-7, -3, 0, 2, 4, 7, 4, 2] : [-7, 0, 4, 7, 4, 0])
          : meter === 4 ? [-7, -3, 0, 2, 4, 2, 0, -3] : [-7, -3, 0, 2, 4, 2];
        const step = bar / pat.length;
        const inst = style === 'flow' ? arp : 'harp';
        pat.forEach((o, k) => {
          const m = dm(root + o);
          const pedal = bar - k * step + 0.35;
          add(tb + k * step, inst, m, (k === 0 ? 0.42 : k % 2 ? 0.24 : 0.3) * e * (inst === 'harp' ? 0.9 : 1), pedal, (k / pat.length - 0.5) * 0.6);
        });
        if (style === 'tide' && b % 2 === 0) {
          // a slow swell every two bars, like a wave coming in
          for (const m of voice(root, 3, 57)) add(tb, padInst, m, 0.4 * padLift, bar * 2.05);
          add(tb, 'bass', bassM(root), 0.35, bar * 2);
        } else if (sec === 'B' || sec === 'C') {
          for (const m of voice(root, 3, 57)) add(tb, padInst, m, 0.35 * padLift, bar * 1.05);
        }
        if (style === 'pastoral' && b % 2 === 0 && sec !== 'I') add(tb, 'bass', bassM(root), 0.3, bar * 2);
        break;
      }
      case 'lullaby': {
        add(tb, 'piano', bassM(root), 0.45 * e, bar * 1.2);
        const vo = voice(root, 3, 60);
        for (const bt of [1, 2]) vo.forEach((m) => add(tb + bt * beat, 'epiano', m, 0.2 * e, beat * 1.1));
        if (sec !== 'I' && b % 2 === 0) for (const m of voice(root, 3, 55)) add(tb, 'pad', m, 0.3 * padLift, bar * 2.1);
        break;
      }
      case 'waltz': {
        // oom-pah-pah: a low note, then two light chords (music box / harp)
        add(tb, arp === 'harp' ? 'harp' : 'piano', bassM(root), 0.45 * e, bar);
        const vo = voice(root, 3, 64);
        const hit: Inst = lead === 'musicbox' ? 'harp' : 'musicbox';
        for (let bt = 1; bt < meter; bt++) vo.forEach((m, k) => add(tb + bt * beat + k * 0.012, hit, m, 0.16 * e, beat * 0.9));
        if ((sec === 'B' || sec === 'A3') && b % 2 === 0) for (const m of voice(root, 3, 55)) add(tb, padInst, m, 0.3 * padLift, bar * 2.05);
        break;
      }
      case 'elegy': {
        // sustained string chords over a slow walking cello
        for (const m of voice(root, 3, 57)) add(tb, 'strings', m, 0.42 * e, bar * 1.02);
        add(tb, 'cello', bassM(root), 0.5 * e, bar * 0.52);
        add(tb + bar * 0.5, 'cello', bassM(root + (r() < 0.5 ? 4 : 2)), 0.4 * e, bar * 0.48);
        break;
      }
      case 'title': {
        // a slow hand on a felt piano: pedalled broken chords in the warm middle
        // of the keyboard, a soft pad bed and a round bass every two bars
        const pat = meter === 4 ? [-7, 0, 2, 4, 7, 4] : [-7, 0, 4, 7, 4, 2];
        const step = bar / pat.length;
        pat.forEach((o, k) => {
          let m = dm(root + o);
          while (m < 40) m += 12;
          add(tb + k * step, 'piano', m, (k === 0 ? 0.32 : 0.19) * e, bar - k * step + 0.8, (k / pat.length - 0.5) * 0.4);
        });
        if (b % 2 === 0) {
          for (const m of voice(root, 3, 55)) add(tb, 'pad', m, 0.4, bar * 2.1);
          add(tb, 'bass', bassM(root), 0.3, bar * 2);
        }
        if (r() < bells) add(tb + beat * (meter - 1), 'celesta', dm(root + 9) + 12, 0.1, 3);
        break;
      }
      case 'ambient': {
        if (b % 2 === 0) {
          for (const m of voice(root, 4, 57)) add(tb, padInst, m, 0.55 * padLift * (padInst === 'strings' ? 0.8 : 1), bar * 2.15);
          add(tb, 'bass', bassM(root), 0.5, bar * 2.1);
        }
        // sparse chord-tone notes, like stones dropped into still water
        for (let bt = 0; bt < meter; bt++) {
          if (r() > 0.28) continue;
          const d = root + pick(r, [7, 9, 11, 14]);
          const inst: Inst = rain ? 'piano' : r() < 0.7 ? 'piano' : r() < 0.5 ? 'celesta' : 'harp';
          add(tb + bt * beat, inst, dm(d), 0.3 + r() * 0.15, rain ? 6 : 3.5, (r() - 0.5) * 0.6);
          if (r() < bells) add(tb + bt * beat + beat * 0.5, bellInst, dm(d) + 12, 0.18, 3);
        }
        break;
      }
      case 'deep': {
        // underwater: slow low pads, far celesta drops, no bass at all
        if (b % 4 === 0) for (const m of voice(root, 3, 52)) add(tb, 'pad', m, 0.75, bar * 4.1);
        for (let bt = 0; bt < meter; bt++) {
          if (r() > 0.16) continue;
          add(tb + bt * beat, r() < 0.6 ? 'celesta' : 'harp', dm(root + pick(r, [7, 9, 11, 14])), 0.5, 4, (r() - 0.5) * 0.8);
        }
        break;
      }
      case 'cave': {
        if (b === 0) add(0, 'drone', dm(0) - 12, 0.55, nBars * bar + 2);
        if (b % 4 === 0) {
          const cl = [dm(root), dm(root + 2), dm(root + 1) + 12];
          for (const m of cl) add(tb, 'pad', m - 12, 0.35, bar * 4.1);
        }
        if (b % 8 === 4 && r() < 0.6) add(tb, 'cello', bassM(root), 0.38, bar * 1.6);
        for (let bt = 0; bt < meter; bt++) {
          const x = r();
          if (x < 0.1) add(tb + bt * beat, 'piano', dm(root + pick(r, [0, 2, 4, 7])), 0.3 + r() * 0.15, 5, (r() - 0.5) * 0.8);
          else if (x < 0.14) {
            // a far-off detuned bell pair (tritone) — the unease of deep caves
            const m = dm(root + 14);
            add(tb + bt * beat, 'bell', m, 0.2, 4, -0.5);
            add(tb + bt * beat + beat * 0.75, 'bell', m + 6, 0.14, 4, 0.5);
          }
        }
        break;
      }
      case 'nether': {
        if (b === 0) {
          add(0, 'drone', dm(0) - 12, 0.65, nBars * bar + 2);
          add(0, 'drone', dm(0) - 24 + 7, 0.3, nBars * bar + 2);
        }
        if (b % 2 === 0 && r() < 0.65) {
          add(tb, 'piano', bassM(root) - 12, 0.6, bar * 2);
          add(tb + 0.02, 'piano', bassM(root), 0.45, bar * 2);
        }
        if (b % 4 === 0) {
          for (const m of [dm(root), dm(root + 1), dm(root + 4)]) add(tb, 'pad', m, 0.42, bar * 4.1);
          if (r() < 0.5) add(tb + bar, 'cello', bassM(root + 1), 0.4, bar * 1.5);
        }
        if (r() < 0.15) {
          const m = dm(root + 14);
          add(tb + beat, 'bell', m, 0.2, 4, 0.4);
          add(tb + beat * 2.5, 'bell', m + 6, 0.16, 4, -0.4);
        }
        break;
      }
    }
    if (drone && b === 0) add(0, 'drone', dm(0) - 12, 0.35, nBars * bar + 2);

    // ---- melody on top ----
    const melodic = !slow;
    if (melodic && b % 2 === 0 && b + 1 < nBars) {
      const mv = (env === 'menu' ? 0.42 : 0.55) * e * (lead === 'flute' || lead === 'ocarina' ? 0.9 : 1);
      const skipA = (style === 'flow' || style === 'tide' || style === 'title') && sec === 'A' && b < 8; // let the arpeggio breathe first
      const j = (b - secStartOf[b]) >> 1;
      if (sec === 'A' && !skipA) phrase(b, motA, lead, mv, b >= 12, (b % 4) === 2, leadOct);
      else if (sec === 'A2') phrase(b, motA, lead, mv, true, (b % 4) === 2, leadOct);
      else if (sec === 'B') phrase(b, motB, lead, mv * 1.05, (b % 4) === 2, (b % 4) === 2, leadOct);
      else if (sec === 'C') phrase(b, devel[j % devel.length], lead, mv * 1.05, false, j % 2 === 1, leadOct);
      else if (sec === 'A3') {
        // recapitulation: the theme returns, answered by a counter-line below
        phrase(b, motA, lead, mv, j === 1, true, leadOct);
      }
    }
    // counter-melody: slow chord-tone line under B and the recap
    if (melodic && (sec === 'A3' || (sec === 'B' && style !== 'waltz')) && style !== 'elegy') {
      const d = root + (b % 2 ? 4 : 2);
      let m = dm(d);
      const center = counter === 'cello' ? 50 : 57;
      while (m < center - 5) m += 12;
      while (m > center + 6) m -= 12;
      add(tb, counter, m, 0.32 * e, bar * 0.96);
    }
    // ambient pieces carry one motif statement through their middle
    if ((style === 'ambient' || style === 'nether') && b % 2 === 0 && b >= 4 && b < nBars - 4 && r() < 0.4) {
      phrase(b, b > 10 && r() < 0.5 ? invert(motA) : motA, style === 'nether' ? 'epiano' : lead, 0.42, b > 8, true,
        style === 'nether' ? -1 : leadOct);
    }
  }

  // ---- ending: a last tonic chord left to ring -----------------------------------
  const tEnd = nBars * bar;
  if (style !== 'cave' && style !== 'nether' && style !== 'deep') {
    const endInst: Inst = arp === 'harp' ? 'harp' : 'piano';
    add(tEnd, endInst, dm(0) - 12, 0.42, 7);
    voice(0, 3, 62).forEach((m, k) => add(tEnd + 0.05 + k * (endInst === 'harp' ? 0.09 : 0.06), endInst, m, 0.26, 7));
    if (r() < 0.6 && env !== 'menu') add(tEnd + beat * 1.5, lead === 'celesta' || lead === 'musicbox' ? lead : bellInst, dm(9) + 12, 0.2, 5);
  }

  notes.sort((a, b) => a.t - b.t);
  const names: Record<Style, string> = {
    hymn: 'Hymn', flow: 'Flow', lullaby: 'Lullaby', ambient: 'Drift', title: 'Title', cave: 'Hollow', nether: 'Ember',
    pastoral: 'Pastoral', waltz: 'Waltz', elegy: 'Elegy', tide: 'Tide', deep: 'Deep',
  };
  return {
    name: `${names[style]} in ${mode} (${Math.round(bpm)} bpm, ${lead})`,
    notes, len: tEnd + 2, beat, tonic, minor: sc[2] === 3,
  };
}

/** A few-note gesture for the long silences between pieces. */
export function fragment(env: MusicEnv, seed: number): Composition {
  const r = rng(seed);
  const dark = env !== 'day' && env !== 'creative';
  const sc = dark ? MODES.aeolian : MODES.ionian;
  const tonic = 55 + ((r() * 7) | 0);
  const dm = (d: number): number => tonic + sc[((d % 7) + 7) % 7] + 12 * Math.floor(d / 7);
  const notes: MNote[] = [];
  const beat = 60 / (52 + r() * 10);
  const root = pick(r, [0, 3, 5]);
  const padI: Inst = env === 'night' && r() < 0.4 ? 'strings' : 'pad';
  for (const d of [root, root + 2, root + 4]) notes.push({ t: 0, i: padI, m: dm(d) - 12, v: 0.4, d: beat * 9 });
  let d = root + 7 + pick(r, [0, 2, 4]);
  const n = 2 + ((r() * 3) | 0);
  let t = beat;
  const inst: Inst = env === 'cave' ? 'bell' : env === 'underwater' ? 'celesta'
    : env === 'night' ? pick(r, ['piano', 'piano', 'cello']) : pick(r, ['piano', 'harp', 'flute', 'musicbox']);
  for (let k = 0; k < n; k++) {
    notes.push({ t, i: inst, m: dm(d) - (inst === 'cello' ? 12 : 0), v: 0.35 + r() * 0.15, d: inst === 'flute' || inst === 'cello' ? beat * 1.4 : 3.5, p: (r() - 0.5) * 0.6 });
    t += beat * pick(r, [1, 1.5, 2]);
    d += pick(r, [-1, 1, -2, 2]);
  }
  return { name: 'fragment', notes, len: t + beat * 4, beat, tonic, minor: dark };
}

export type StingerKind = 'village' | 'peak' | 'cave' | 'sunrise' | 'nightfall' | 'nether' | 'discover';

/** A short situational cue (a few seconds): arriving somewhere, dawn, dusk.
 *  Plays in `tonic` when a piece is running so it sits inside the music. */
export function stinger(kind: StingerKind, seed: number, tonic?: number): Composition {
  const r = rng(seed);
  const k = tonic ?? 55 + ((r() * 5) | 0);
  const maj = MODES.ionian, min = MODES.aeolian, lyd = MODES.lydian;
  const deg = (sc: number[], d: number): number => k + sc[((d % 7) + 7) % 7] + 12 * Math.floor(d / 7);
  const notes: MNote[] = [];
  const n = (t: number, i: Inst, m: number, v: number, d: number, p?: number): void => { notes.push({ t, i, m, v, d, p }); };
  let beat = 0.42;
  switch (kind) {
    case 'village': {
      // a warm harp roll up the tonic chord, then a little flute "hello"
      [0, 2, 4, 7, 9, 11].forEach((d, i) => n(i * 0.07, 'harp', deg(maj, d), 0.4, 3, -0.3 + i * 0.1));
      for (const d of [0, 2, 4]) n(0, 'pad', deg(maj, d), 0.35, 5);
      [[4, 0.9, 0.5], [5, 1.4, 0.35], [7, 1.75, 1.6]].forEach(([d, t, len]) => n(t, 'flute', deg(maj, d) + 12, 0.42, len));
      break;
    }
    case 'peak': {
      // a wide lydian string swell with bells ringing out over the valley
      for (const d of [0, 4, 7, 9, 10]) n(0, 'strings', deg(lyd, d) - 12 + (d > 7 ? 0 : 12), 0.36, 5.5);
      n(0, 'bass', k - 12, 0.4, 5);
      [11, 9, 14].forEach((d, i) => n(1.2 + i * 0.55, 'bell', deg(lyd, d) + 12, 0.24, 4, (i - 1) * 0.5));
      break;
    }
    case 'cave': {
      // a low cello note and a far echoing bell pair
      n(0, 'cello', k - 12, 0.45, 3.2);
      n(0, 'pad', k - 12, 0.3, 5);
      n(1.4, 'bell', deg(min, 9) + 12, 0.18, 4, -0.5);
      n(2.3, 'bell', deg(min, 9) + 18, 0.12, 4, 0.5);
      break;
    }
    case 'sunrise': {
      // the music box winds up: a rising major arpeggio into a warm pad
      beat = 0.3;
      [0, 2, 4, 7, 9, 11, 14].forEach((d, i) => n(i * beat, 'musicbox', deg(maj, d) + 12, 0.35 - i * 0.02, 1.6, -0.4 + i * 0.12));
      for (const d of [0, 2, 4, 6]) n(0.4, 'pad', deg(maj, d), 0.35, 5.5);
      n(2.3, 'celesta', deg(maj, 16) + 12, 0.18, 3);
      break;
    }
    case 'nightfall': {
      // a slow falling minor figure on the piano over a dark pad
      [[9, 0], [7, 0.7], [5, 1.4], [2, 2.3]].forEach(([d, t]) => n(t, 'piano', deg(min, d) + 12, 0.36, 3));
      for (const d of [0, 2, 4]) n(0, 'pad', deg(min, d) - 12, 0.4, 6);
      n(0, 'cello', k - 12, 0.3, 4);
      break;
    }
    case 'nether': {
      n(0, 'drone', k - 24, 0.6, 7);
      n(0.5, 'cello', k - 12 + 1, 0.42, 3.4);
      n(2.4, 'bell', k + 18, 0.16, 4, 0.4);
      break;
    }
    case 'discover': {
      [0, 4, 7].forEach((d, i) => n(i * 0.12, 'celesta', deg(maj, d) + 12, 0.3, 2.5));
      n(0, 'strings', deg(maj, 2), 0.3, 3.5);
      n(0, 'strings', deg(maj, 4), 0.3, 3.5);
      break;
    }
  }
  notes.sort((a, b) => a.t - b.t);
  const len = notes.reduce((m, x) => Math.max(m, x.t + x.d), 0);
  return { name: `stinger:${kind}`, notes, len, beat, tonic: k, minor: kind === 'nightfall' || kind === 'cave' };
}
