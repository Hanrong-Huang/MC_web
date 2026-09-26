// Sampled acoustic instruments for the music: Tone.js Samplers over real
// recordings in public/audio/ (sources + licenses in CREDITS.md). This module
// (and Tone.js with it) is imported lazily once the audio context runs, so it
// never touches startup. Audio.ts keeps its synth voice for every instrument
// that isn't ready yet (still loading, offline, 404) — decided per piece, so a
// piece never changes timbre halfway through.
//
// What is sampled and why: the acoustic instruments whose synth versions
// sounded thin — piano, harp, flute, cello and the string ensemble. The pads,
// sub bass, drones, the FM e-piano / bell / celesta / music box, the ocarina
// (a near-sine anyway) and the tense combat layer stay procedural, as do all
// SFX and ambience (they're parameter-driven and react to the world).
//
// Routing: one Sampler per (instrument, destination, pan bucket) sharing the
// decoded buffers, so a piece's own output gain (crossfades, the title-screen
// warmth filter) and per-note panning still apply. Everything lands on the
// same native music nodes as the synths, so volume, ducking, reverb, delay,
// the underwater filter and the limiter all still work.

import type { Sampler } from 'tone/build/esm/instrument/Sampler.js';
import type { ToneAudioBuffer } from 'tone/build/esm/core/context/ToneAudioBuffer.js';
import type { Inst } from './AudioMusic';

export type SampledInst = 'piano' | 'harp' | 'cello' | 'strings' | 'flute';
type State = 'idle' | 'loading' | 'ready' | 'failed';

interface Spec {
  notes: number[];   // MIDI pitches that have a <Note>.mp3
  gain: number;      // velocity → level, matched to the synth voice by offline RMS (sample-test.mjs)
  lp: number;        // voice-group lowpass (Hz): a warmer, felt-hammer top end
  bowed?: boolean;   // sustained: swell in / out, re-bowed past the sample's length
}

const SPECS: Record<SampledInst, Spec> = {
  piano: { notes: [24, 30, 36, 39, 42, 45, 48, 51, 54, 57, 60, 63, 66, 69, 72, 75, 78, 81, 84, 90, 96], gain: 0.5, lp: 5200 },
  harp: { notes: [38, 45, 52, 55, 59, 62, 65, 69, 72, 76, 79, 83, 86], gain: 0.37, lp: 6000 },
  flute: { notes: [60, 64, 69, 72, 76, 81, 84, 88], gain: 0.8, lp: 4200, bowed: true },
  cello: { notes: [36, 40, 43, 47, 50, 53, 57, 60, 64], gain: 0.47, lp: 2600, bowed: true },
  strings: { notes: [43, 47, 50, 52, 55, 59, 62, 65, 69, 72, 76, 79], gain: 0.15, lp: 2500, bowed: true },
};
/** load order: the title theme's piano first */
export const SAMPLED_ORDER: readonly SampledInst[] = ['piano', 'harp', 'flute', 'cello', 'strings'];
const MAX_VOICES = 40;
const NAMES = ['C', 'Cs', 'D', 'Ds', 'E', 'F', 'Fs', 'G', 'Gs', 'A', 'As', 'B'];
const noteName = (m: number): string => NAMES[m % 12] + (Math.floor(m / 12) - 1);
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

interface Group { s: Sampler; nodes: AudioNode[] }
type ToneMods = {
  Sampler: typeof Sampler;
  ToneAudioBuffer: typeof ToneAudioBuffer;
};

export class SampleBank {
  private tone: ToneMods | null = null;
  private state: Record<SampledInst, State> = { piano: 'idle', harp: 'idle', flute: 'idle', cello: 'idle', strings: 'idle' };
  private bufs: Partial<Record<SampledInst, Record<number, ToneAudioBuffer>>> = {};
  private groups = new Map<AudioNode, Map<string, Group>>();
  private ends: number[] = [];   // end times of the voices in flight (polyphony cap)
  played = 0;                    // sampled notes triggered (harness stat)

  constructor(private ctx: BaseAudioContext, private base: string) {}

  /** Fetch + decode every instrument (piano first). Resolves when all settle;
   *  failures leave that instrument on its synth voice. */
  async load(only: readonly SampledInst[] = SAMPLED_ORDER): Promise<void> {
    try {
      const w = globalThis as { TONE_SILENCE_LOGGING?: boolean };
      w.TONE_SILENCE_LOGGING = true;
      const [g, s, b] = await Promise.all([
        import('tone/build/esm/core/Global.js'),
        import('tone/build/esm/instrument/Sampler.js'),
        import('tone/build/esm/core/context/ToneAudioBuffer.js'),
      ]);
      // Tone runs on the game's own context (never a second AudioContext)
      g.setContext(this.ctx as AudioContext);
      this.tone = { Sampler: s.Sampler, ToneAudioBuffer: b.ToneAudioBuffer };
    } catch {
      for (const k of only) this.state[k] = 'failed';
      return;
    }
    for (const k of only) this.state[k] = 'loading';
    const first = only.includes('piano') ? this.loadInst('piano') : Promise.resolve();
    await first;
    await Promise.all(only.filter((k) => k !== 'piano').map((k) => this.loadInst(k)));
  }

  private async loadInst(k: SampledInst): Promise<void> {
    const T = this.tone!;
    const got: Record<number, ToneAudioBuffer> = {};
    const res = await Promise.allSettled(SPECS[k].notes.map(async (m) => {
      const r = await fetch(`${this.base}${k}/${noteName(m)}.mp3`);
      if (!r.ok) throw new Error(`${r.status}`);
      const ab = await this.ctx.decodeAudioData(await r.arrayBuffer());
      const tb = new T.ToneAudioBuffer();
      tb.set(this.trim(ab));
      got[m] = tb;
    }));
    const ok = res.filter((x) => x.status === 'fulfilled').length;
    // a few missing files just widen the repitch; most missing → synth fallback
    if (ok >= Math.ceil(SPECS[k].notes.length * 0.75)) { this.bufs[k] = got; this.state[k] = 'ready'; }
    else this.state[k] = 'failed';
  }

  /** Cut decoder padding / leading silence so sampled notes speak on time. */
  private trim(ab: AudioBuffer): AudioBuffer {
    const d0 = ab.getChannelData(0);
    let peak = 0;
    const scan = Math.min(d0.length, Math.floor(ab.sampleRate * 0.5));
    for (let i = 0; i < scan; i++) peak = Math.max(peak, Math.abs(d0[i]));
    let on = 0;
    while (on < scan && Math.abs(d0[on]) < peak * 0.02) on++;
    on = Math.max(0, on - Math.floor(ab.sampleRate * 0.002));
    if (on < 8) return ab;
    const out = this.ctx.createBuffer(ab.numberOfChannels, ab.length - on, ab.sampleRate);
    for (let c = 0; c < ab.numberOfChannels; c++) out.copyToChannel(ab.getChannelData(c).subarray(on), c);
    return out;
  }

  status(): Record<SampledInst, State> { return { ...this.state }; }
  /** still worth waiting for (loading or not started) */
  pending(k: SampledInst): boolean { return this.state[k] === 'idle' || this.state[k] === 'loading'; }
  /** the instruments that play sampled right now (snapshotted per piece) */
  ready(): Set<Inst> {
    const s = new Set<Inst>();
    for (const k of SAMPLED_ORDER) if (this.state[k] === 'ready') s.add(k);
    return s;
  }
  voices(now: number): number { this.ends = this.ends.filter((t) => t > now); return this.ends.length; }

  private group(k: SampledInst, dest: AudioNode, pan: number): Group {
    let byDest = this.groups.get(dest);
    if (!byDest) { byDest = new Map(); this.groups.set(dest, byDest); }
    const key = `${k}:${pan}`;
    let g = byDest.get(key);
    if (g) return g;
    const T = this.tone!;
    const urls: Record<number, ToneAudioBuffer> = {};
    for (const [m, b] of Object.entries(this.bufs[k]!)) urls[+m] = b;
    const s = new T.Sampler({ urls, curve: 'exponential' });
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = SPECS[k].lp;
    lp.Q.value = 0.5;
    const pn = this.ctx.createStereoPanner();
    pn.pan.value = pan;
    s.connect(lp);
    lp.connect(pn).connect(dest);
    g = { s, nodes: [lp, pn] };
    byDest.set(key, g);
    return g;
  }

  /** Play one scored note. Returns false when the caller should use its synth
   *  voice instead; true when handled (or dropped at the polyphony cap). */
  play(k: SampledInst, at: number, midi: number, v: number, hold: number, pan: number, dest: AudioNode): boolean {
    if (this.state[k] !== 'ready' || !this.tone) return false;
    const now = this.ctx.currentTime;
    if (this.voices(now) >= MAX_VOICES) return true;
    const spec = SPECS[k];
    const g = this.group(k, dest, Math.round(clamp(pan, -0.6, 0.6) * 5) / 5);
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    const vel = spec.gain * v * (0.96 + Math.random() * 0.08); // a touch of human unevenness
    const s = g.s;
    if (!spec.bowed) {
      // struck/plucked: ring for the hold like a pedalled note, then damp smoothly
      const ring = k === 'harp' ? hold + 0.9 : hold + 0.25;
      s.attack = 0;
      s.release = k === 'harp' ? 0.7 : clamp(0.25 + hold * 0.06, 0.3, 0.8);
      s.triggerAttackRelease(f, ring, at, vel);
      this.ends.push(at + ring + s.release * 3);
    } else {
      // bowed / blown: swell in, hold, fade — re-bow if longer than the sample
      const short = hold < 0.5;
      const atk = k === 'strings' ? clamp(hold * 0.3, 0.12, 1.1) : k === 'flute' ? 0.05 : short ? 0.02 : 0.1;
      const rel = k === 'strings' ? clamp(hold * 0.3, 0.15, 1.2) : k === 'flute' ? 0.2 : short ? 0.12 : 0.35;
      // the sample the Sampler will pick (nearest loaded; ties go up, like Tone)
      const bufs = this.bufs[k]!;
      const nearest = Object.keys(bufs).map(Number).reduce((a, b) => (Math.abs(b - midi) <= Math.abs(a - midi) ? b : a));
      const rate = Math.pow(2, (midi - nearest) / 12);
      const usable = Math.max(1.5, (bufs[nearest].duration - 1.6) / rate);
      const xf = 0.9;
      let t = at;
      let left = Math.max(0.12, hold);
      let first = true;
      while (left > 0) {
        const seg = left + rel <= usable ? left : usable - xf;
        s.attack = first ? atk : xf;
        s.release = left === seg ? rel : xf;
        s.triggerAttackRelease(f, seg, t, vel);
        this.ends.push(t + seg + s.release * 3);
        // the next bow swells in while this one fades out
        first = false;
        t += seg;
        left -= seg;
        if (t - at > 60) break;
      }
    }
    this.played++;
    return true;
  }

  /** A destination (a finished piece's output) is going away: free its voices. */
  drop(dest: AudioNode): void {
    const byDest = this.groups.get(dest);
    if (!byDest) return;
    for (const g of byDest.values()) {
      g.s.dispose();
      for (const n of g.nodes) n.disconnect();
    }
    this.groups.delete(dest);
  }
}
