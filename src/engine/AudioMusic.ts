// Generative score for the Web Audio engine: turns a seed + mood into a list
// of timed notes (pure data — Audio.ts schedules them just ahead of the clock).
// The aim is C418's calm Minecraft sound: sparse felt piano, wide pads, long
// silences, small motifs that come back slightly changed.

export type MusicEnv = 'day' | 'night' | 'cave' | 'nether' | 'menu';
export type MusicBiomeKey =
  'plains' | 'forest' | 'desert' | 'snow' | 'taiga' | 'swamp' | 'mountains' | 'jungle';

export type Inst = 'piano' | 'epiano' | 'bell' | 'celesta' | 'pad' | 'bass' | 'drone';

/** One scheduled note: time (s from piece start), instrument, MIDI pitch,
 *  velocity 0..1, hold time (s), optional stereo pan. */
export interface MNote { t: number; i: Inst; m: number; v: number; d: number; p?: number }

export interface Composition {
  name: string;
  notes: MNote[];
  len: number;   // seconds until the last note starts ringing out
  beat: number;  // seconds per beat (the delay line is synced to it)
}

type Style = 'hymn' | 'flow' | 'lullaby' | 'ambient' | 'title' | 'cave' | 'nether';

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

/** Compose one piece for the given mood. Deterministic for a given seed. */
export function compose(env: MusicEnv, biome: MusicBiomeKey | undefined, seed: number): Composition {
  const r = rng(seed);
  const title = env === 'menu' && seed === TITLE_SEED;

  // ---- style, mode and tempo from the environment -------------------------
  let style: Style;
  let mode: string;
  let bpm: number;
  if (env === 'menu') {
    style = title ? 'title' : weighted<Style>(r, [['title', 3], ['ambient', 2], ['lullaby', 2], ['hymn', 2]]);
    mode = title ? 'lydian' : weighted(r, [['ionian', 3], ['lydian', 2], ['dorian', 1], ['aeolian', 1]]);
  } else if (env === 'nether') {
    style = 'nether';
    mode = weighted(r, [['phrygian', 2], ['phrygianDom', 2], ['aeolian', 1]]);
  } else if (env === 'cave') {
    style = weighted<Style>(r, [['cave', 4], ['ambient', 1]]);
    mode = weighted(r, [['aeolian', 2], ['phrygian', 2], ['dorian', 1]]);
  } else if (env === 'night') {
    style = weighted<Style>(r, [['ambient', 4], ['hymn', 3], ['flow', 2], ['lullaby', 1]]);
    mode = weighted(r, [['aeolian', 3], ['dorian', 3], ['ionian', 1]]);
  } else {
    style = weighted<Style>(r, [['hymn', 3], ['flow', 3], ['lullaby', 2], ['ambient', 2]]);
    mode = weighted(r, [['ionian', 4], ['lydian', 2], ['mixolydian', 1]]);
  }
  // biome colour on the surface: key family + a little tempo push/pull
  let tempoMul = 1;
  let bells = 0.25;      // chance of bell doublings / sparkles
  let padLift = 1;       // pad loudness
  let lead: Inst = 'piano';
  if (env === 'day' || env === 'night') {
    switch (biome) {
      case 'snow': case 'taiga':
        mode = env === 'night' ? 'aeolian' : pick(r, ['dorian', 'aeolian', 'ionian']);
        tempoMul = 0.88; bells = 0.6; padLift = 0.9;
        if (style === 'flow') style = 'ambient';
        break;
      case 'desert':
        mode = env === 'night' ? 'phrygianDom' : pick(r, ['mixolydian', 'dorian']);
        tempoMul = 0.92; padLift = 1.15;
        break;
      case 'jungle':
        mode = env === 'night' ? 'dorian' : 'lydian';
        tempoMul = 1.1; lead = r() < 0.5 ? 'epiano' : 'piano'; bells = 0.35;
        break;
      case 'swamp':
        mode = 'dorian'; tempoMul = 0.9; padLift = 1.2; lead = 'epiano';
        break;
      case 'mountains':
        padLift = 1.3; bells = 0.45;
        if (env === 'day') mode = pick(r, ['ionian', 'lydian']);
        break;
    }
  }
  if (style === 'lullaby') lead = r() < 0.6 ? 'celesta' : 'epiano';

  const meter = style === 'lullaby' ? 3 : (style === 'hymn' || style === 'flow') && r() < 0.3 ? 3 : 4;
  const baseBpm: Record<Style, [number, number]> = {
    hymn: [56, 68], flow: [64, 78], lullaby: [74, 88], ambient: [48, 58],
    title: [58, 62], cave: [44, 54], nether: [40, 50],
  };
  const [lo, hi] = baseBpm[style];
  bpm = (lo + r() * (hi - lo)) * tempoMul;
  const beat = 60 / bpm;
  const bar = beat * meter;

  const sc = MODES[mode];
  const tonic = title ? 53 : 50 + ((r() * 8) | 0); // D3..A3 (title: F3)
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
    const jitter = i === 'pad' || i === 'drone' ? 0 : (r() - 0.5) * 0.02;
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

  // ---- form: sections of bars, each with a chord root ------------------------
  const progs = PROGS[mode];
  const progA = pick(r, progs);
  let progB = pick(r, progs);
  if (progB === progA) progB = progs[(progs.indexOf(progA) + 1) % progs.length];
  let form: string[];
  if (style === 'ambient' || style === 'cave' || style === 'nether') {
    const n = 16 + (((r() * 3) | 0) * 4);
    form = new Array(n).fill('X');
  } else if (style === 'title') {
    form = ['I', 'I', ...Array(4).fill('A'), ...Array(4).fill('A2'), ...Array(4).fill('B'), ...Array(4).fill('A'), 'O', 'O'];
  } else {
    const withB = r() < 0.8;
    form = ['I', 'I', ...Array(4).fill('A'), ...Array(4).fill('A2'),
      ...(withB ? Array(4).fill('B') : []), ...Array(4).fill('A'), 'O'];
  }
  const nBars = form.length;
  // chord per bar: slow harmony for the ambient styles (2 bars per chord)
  const slow = style === 'ambient' || style === 'cave' || style === 'nether';
  const chordOf: number[] = [];
  let secStart = 0;
  for (let b = 0; b < nBars; b++) {
    const sec = form[b];
    if (b > 0 && sec !== form[b - 1]) secStart = b;
    const pr = sec === 'B' ? progB : progA;
    const idx = slow ? Math.floor(b / 2) : sec === 'I' ? 0 : b - secStart;
    chordOf.push(sec === 'O' ? 0 : pr[idx % pr.length]);
  }
  const energy: Record<string, number> = { I: 0.8, A: 0.92, A2: 1, B: 1.08, O: 0.85, X: 1 };

  // ---- melody motifs ----------------------------------------------------------
  const motif = (): { rh: number[]; steps: number[]; start: number } => {
    const rh = pick(r, meter === 3 ? RH3 : RH4);
    return { rh, steps: rh.map(() => pick(r, STEPS)), start: 9 + pick(r, [0, 2, 2, 4, -2]) };
  };
  const motA = motif();
  const motB = motif();
  motB.start = motA.start + pick(r, [2, 3, 4]);
  /** play a two-bar motif from bar b; varied = small changes for the repeat */
  const phrase = (b: number, mot: { rh: number[]; steps: number[]; start: number }, inst: Inst,
    v: number, varied: boolean, resolve: boolean, octave = 0): void => {
    let d = snap(mot.start + (varied ? pick(r, [0, 0, 1, -1]) : 0), chordOf[b]);
    let t = b * bar;
    const t0 = t;
    for (let k = 0; k < mot.rh.length; k++) {
      const len = mot.rh[k];
      if (len < 0) { t += -len * beat; continue; }
      if (k > 0) d += varied && r() < 0.3 ? pick(r, STEPS) : mot.steps[k];
      const barIdx = Math.min(nBars - 1, Math.floor(t / bar + 1e-6));
      const onDown = Math.abs(((t - t0) / beat) % meter) < 1e-3;
      if (onDown) d = snap(d, chordOf[barIdx]);
      const last = k === mot.rh.length - 1 || (k === mot.rh.length - 2 && mot.rh[k + 1] < 0);
      if (last && resolve) d = snap(d, chordOf[barIdx]);
      d = Math.max(7, Math.min(18, d));
      add(t, inst, dm(d) + 12 * octave, v, len * beat * 1.7 + (last ? 1.5 : 0));
      if (bells > 0 && r() < bells * 0.35) add(t + 0.01, 'bell', dm(d) + 12 * (octave + 1), v * 0.28, 2);
      t += len * beat;
    }
  };

  // ---- accompaniment per style ------------------------------------------------
  for (let b = 0; b < nBars; b++) {
    const tb = b * bar;
    const sec = form[b];
    const root = chordOf[b];
    const e = energy[sec] ?? 1;
    const bassM = (d: number): number => { let m = dm(d) - 12; while (m > 50) m -= 12; while (m < 36) m += 12; return m; };

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
        if (sec === 'A2' || sec === 'B') {
          for (const m of voice(root, 3, 55)) add(tb, 'pad', m, 0.45 * padLift, bar * 1.05);
        }
        break;
      }
      case 'flow': {
        const pat = meter === 4 ? [-7, -3, 0, 2, 4, 2, 0, -3] : [-7, -3, 0, 2, 4, 2];
        const step = bar / pat.length;
        pat.forEach((o, k) => {
          const m = dm(root + o);
          add(tb + k * step, 'piano', m, (k === 0 ? 0.42 : k % 2 ? 0.24 : 0.3) * e, bar * 1.15, (k / pat.length - 0.5) * 0.5);
        });
        if (sec === 'B') for (const m of voice(root, 3, 57)) add(tb, 'pad', m, 0.35 * padLift, bar * 1.05);
        break;
      }
      case 'lullaby': {
        add(tb, 'piano', bassM(root), 0.45 * e, bar * 1.2);
        const vo = voice(root, 3, 60);
        for (const bt of [1, 2]) vo.forEach((m) => add(tb + bt * beat, 'epiano', m, 0.2 * e, beat * 1.1));
        if (sec !== 'I' && b % 2 === 0) for (const m of voice(root, 3, 55)) add(tb, 'pad', m, 0.3 * padLift, bar * 2.1);
        break;
      }
      case 'title':
      case 'ambient': {
        if (b % 2 === 0) {
          for (const m of voice(root, 4, 57)) add(tb, 'pad', m, 0.55 * padLift, bar * 2.15);
          add(tb, 'bass', bassM(root), 0.5, bar * 2.1);
        }
        // sparse chord-tone notes, like stones dropped into still water
        for (let bt = 0; bt < meter; bt++) {
          if (r() > (style === 'title' ? 0.2 : 0.28)) continue;
          const d = root + pick(r, [7, 9, 11, 14]);
          add(tb + bt * beat, r() < 0.8 ? 'piano' : 'celesta', dm(d), 0.3 + r() * 0.15, 3.5, (r() - 0.5) * 0.6);
          if (r() < bells) add(tb + bt * beat + beat * 0.5, 'bell', dm(d) + 12, 0.18, 3);
        }
        break;
      }
      case 'cave': {
        if (b === 0) add(0, 'drone', dm(0) - 12, 0.55, nBars * bar + 2);
        if (b % 4 === 0) {
          const cl = [dm(root), dm(root + 2), dm(root + 1) + 12];
          for (const m of cl) add(tb, 'pad', m - 12, 0.35, bar * 4.1);
        }
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
        }
        if (r() < 0.15) {
          const m = dm(root + 14);
          add(tb + beat, 'bell', m, 0.2, 4, 0.4);
          add(tb + beat * 2.5, 'bell', m + 6, 0.16, 4, -0.4);
        }
        break;
      }
    }

    // ---- melody on top ----
    const melodic = style === 'hymn' || style === 'flow' || style === 'lullaby' || style === 'title';
    if (melodic && b % 2 === 0 && b + 1 < nBars) {
      const octave = 0;
      const mv = (style === 'title' ? 0.5 : 0.55) * e;
      const skipA = style === 'flow' && sec === 'A' && b < 8; // let the arpeggio breathe first
      if (sec === 'A' && !skipA) phrase(b, motA, lead, mv, b >= 12, (b % 4) === 2, octave);
      else if (sec === 'A2') phrase(b, motA, lead, mv, true, (b % 4) === 2, octave);
      else if (sec === 'B') phrase(b, motB, lead, mv * 1.05, (b % 4) === 2, (b % 4) === 2, octave);
    }
    // ambient pieces carry one motif statement through their middle
    if ((style === 'ambient' || style === 'nether') && b % 2 === 0 && b >= 4 && b < nBars - 4 && r() < 0.4) {
      phrase(b, motA, style === 'nether' ? 'epiano' : lead, 0.42, b > 8, true, style === 'nether' ? -1 : 0);
    }
  }

  // ---- ending: a last tonic chord left to ring -----------------------------------
  const tEnd = nBars * bar;
  if (style !== 'cave' && style !== 'nether') {
    add(tEnd, 'piano', dm(0) - 12, 0.42, 7);
    voice(0, 3, 62).forEach((m, k) => add(tEnd + 0.05 + k * 0.06, 'piano', m, 0.26, 7));
    if (r() < 0.6) add(tEnd + beat * 1.5, lead === 'celesta' ? 'celesta' : 'bell', dm(9) + 12, 0.2, 5);
  }

  notes.sort((a, b) => a.t - b.t);
  const names: Record<Style, string> = {
    hymn: 'Hymn', flow: 'Flow', lullaby: 'Lullaby', ambient: 'Drift', title: 'Title', cave: 'Hollow', nether: 'Ember',
  };
  return { name: `${names[style]} in ${mode} (${Math.round(bpm)} bpm)`, notes, len: tEnd + 2, beat };
}

/** A few-note gesture for the long silences between pieces. */
export function fragment(env: MusicEnv, seed: number): Composition {
  const r = rng(seed);
  const dark = env !== 'day';
  const sc = dark ? MODES.aeolian : MODES.ionian;
  const tonic = 55 + ((r() * 7) | 0);
  const dm = (d: number): number => tonic + sc[((d % 7) + 7) % 7] + 12 * Math.floor(d / 7);
  const notes: MNote[] = [];
  const beat = 60 / (52 + r() * 10);
  const root = pick(r, [0, 3, 5]);
  for (const d of [root, root + 2, root + 4]) notes.push({ t: 0, i: 'pad', m: dm(d) - 12, v: 0.4, d: beat * 9 });
  let d = root + 7 + pick(r, [0, 2, 4]);
  const n = 2 + ((r() * 3) | 0);
  let t = beat;
  for (let k = 0; k < n; k++) {
    notes.push({ t, i: env === 'cave' ? 'bell' : 'piano', m: dm(d), v: 0.35 + r() * 0.15, d: 3.5, p: (r() - 0.5) * 0.6 });
    t += beat * pick(r, [1, 1.5, 2]);
    d += pick(r, [-1, 1, -2, 2]);
  }
  return { name: 'fragment', notes, len: t + beat * 4, beat };
}
