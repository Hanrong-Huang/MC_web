// Sampled acoustic instruments for the music: real recordings in
// public/audio/ (sources + licenses in CREDITS.md), played with plain Web
// Audio nodes. This module is imported lazily once the audio context runs, so
// it never touches startup. Audio.ts keeps its synth voice for every
// instrument that isn't ready yet (still loading, offline, 404) — decided per
// piece, so a piece never changes timbre halfway through.
//
// What is sampled and why: the acoustic instruments whose synth versions
// sounded thin — piano, harp, flute, cello and the string ensemble. The pads,
// sub bass, drones, the FM e-piano / bell / celesta / music box, the ocarina
// (a near-sine anyway) and the tense combat layer stay procedural, as do all
// SFX and ambience (they're parameter-driven and react to the world).
//
// Routing: one voice group (lowpass → panner) per (instrument, destination,
// pan bucket); each note is a buffer source + an envelope gain feeding it, so
// a piece's own output gain (crossfades, the title-screen warmth filter) and
// per-note panning still apply. Everything lands on the same native music
// nodes as the synths, so volume, ducking, reverb, delay, the underwater
// filter and the limiter all still work.
//
// (This used to sit on Tone.js Samplers. Their per-note option merging and
// the Sampler objects built and disposed with every piece cost tens of ms on
// the main thread — visible hitches when a new piece started — so the few
// things Tone did here are done directly: nearest-sample repitch, a linear
// velocity gain, an instant or linear attack and an exponential release.)

import type { Inst } from './AudioMusic';

export type SampledInst = 'piano' | 'harp' | 'cello' | 'strings' | 'flute';
type State = 'idle' | 'loading' | 'ready' | 'failed';

interface Spec {
  notes: number[];   // MIDI pitches that have a <Note>.mp3
  gain: number;      // velocity → level, matched by tests/e2e/sample-test.mjs
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

interface Group { input: AudioNode; nodes: AudioNode[] }
/** loaded samples of one instrument, sorted by pitch */
interface Bank { midi: number[]; buf: AudioBuffer[] }

export class SampleBank {
  private state: Record<SampledInst, State> = { piano: 'idle', harp: 'idle', flute: 'idle', cello: 'idle', strings: 'idle' };
  private banks: Partial<Record<SampledInst, Bank>> = {};
  private groups = new Map<AudioNode, Map<string, Group>>();
  private ends: number[] = [];   // end times of the voices in flight (polyphony cap)
  played = 0;                    // sampled notes triggered (harness stat)

  constructor(private ctx: BaseAudioContext, private base: string) {}

  /** Fetch + decode every instrument (piano first). Resolves when all settle;
   *  failures leave that instrument on its synth voice. */
  async load(only: readonly SampledInst[] = SAMPLED_ORDER): Promise<void> {
    for (const k of only) this.state[k] = 'loading';
    const first = only.includes('piano') ? this.loadInst('piano') : Promise.resolve();
    await first;
    await Promise.all(only.filter((k) => k !== 'piano').map((k) => this.loadInst(k)));
  }

  private async loadInst(k: SampledInst): Promise<void> {
    const got: [number, AudioBuffer][] = [];
    const res = await Promise.allSettled(SPECS[k].notes.map(async (m) => {
      const r = await fetch(`${this.base}${k}/${noteName(m)}.mp3`);
      if (!r.ok) throw new Error(`${r.status}`);
      const ab = await this.ctx.decodeAudioData(await r.arrayBuffer());
      got.push([m, this.trim(ab)]);
    }));
    const ok = res.filter((x) => x.status === 'fulfilled').length;
    // a few missing files just widen the repitch; most missing → synth fallback
    if (ok >= Math.ceil(SPECS[k].notes.length * 0.75)) {
      got.sort((a, b) => a[0] - b[0]);
      this.banks[k] = { midi: got.map((g) => g[0]), buf: got.map((g) => g[1]) };
      this.state[k] = 'ready';
    } else this.state[k] = 'failed';
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
  voices(now: number): number {
    // drop finished voices in place (no new array per call)
    let n = 0;
    for (let i = 0; i < this.ends.length; i++) if (this.ends[i] > now) this.ends[n++] = this.ends[i];
    this.ends.length = n;
    return n;
  }

  private group(k: SampledInst, dest: AudioNode, pan: number): Group {
    let byDest = this.groups.get(dest);
    if (!byDest) { byDest = new Map(); this.groups.set(dest, byDest); }
    const key = `${k}:${pan}`;
    let g = byDest.get(key);
    if (g) return g;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = SPECS[k].lp;
    lp.Q.value = 0.5;
    const pn = this.ctx.createStereoPanner();
    pn.pan.value = pan;
    lp.connect(pn).connect(dest);
    g = { input: lp, nodes: [lp, pn] };
    byDest.set(key, g);
    return g;
  }

  /** The loaded sample nearest a pitch (ties go up) and its playback rate. */
  private pick(k: SampledInst, midi: number): { buf: AudioBuffer; rate: number } {
    const b = this.banks[k]!;
    let best = 0;
    for (let i = 1; i < b.midi.length; i++) if (Math.abs(b.midi[i] - midi) <= Math.abs(b.midi[best] - midi)) best = i;
    return { buf: b.buf[best], rate: Math.pow(2, (midi - b.midi[best]) / 12) };
  }

  /** One voice: the sample from \`at\`, rising to \`vel\` over \`atk\` (0 =
   *  struck), held for \`dur\`, then an exponential release. Returns its end. */
  private voice(buf: AudioBuffer, rate: number, input: AudioNode, at: number, vel: number, atk: number, dur: number, rel: number): number {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    const p = g.gain;
    if (atk > 0) { p.setValueAtTime(0, at); p.linearRampToValueAtTime(vel, at + atk); } else p.setValueAtTime(vel, at);
    const off = at + Math.max(dur, atk);
    p.setValueAtTime(vel, off);
    p.setTargetAtTime(0, off, Math.max(0.01, rel / 3)); // ~exponential decay, -60 dB by ~2 rel
    const end = Math.min(off + rel * 2.5, at + buf.duration / rate);
    src.connect(g).connect(input);
    src.start(at);
    src.stop(end + 0.02);
    src.onended = () => g.disconnect();
    return end;
  }

  /** Play one scored note. Returns false when the caller should use its synth
   *  voice instead; true when handled (or dropped at the polyphony cap). */
  play(k: SampledInst, at: number, midi: number, v: number, hold: number, pan: number, dest: AudioNode): boolean {
    if (this.state[k] !== 'ready') return false;
    const now = this.ctx.currentTime;
    if (this.voices(now) >= MAX_VOICES) return true;
    const spec = SPECS[k];
    const g = this.group(k, dest, Math.round(clamp(pan, -0.6, 0.6) * 5) / 5);
    const vel = spec.gain * v * (0.96 + Math.random() * 0.08); // a touch of human unevenness
    const { buf, rate } = this.pick(k, midi);
    if (!spec.bowed) {
      // struck/plucked: ring for the hold like a pedalled note, then damp smoothly
      const ring = k === 'harp' ? hold + 0.9 : hold + 0.25;
      const rel = k === 'harp' ? 0.7 : clamp(0.25 + hold * 0.06, 0.3, 0.8);
      this.ends.push(this.voice(buf, rate, g.input, at, vel, 0, ring, rel));
    } else {
      // bowed / blown: swell in, hold, fade — re-bow if longer than the sample
      const short = hold < 0.5;
      const atk = k === 'strings' ? clamp(hold * 0.3, 0.12, 1.1) : k === 'flute' ? 0.05 : short ? 0.02 : 0.1;
      const rel = k === 'strings' ? clamp(hold * 0.3, 0.15, 1.2) : k === 'flute' ? 0.2 : short ? 0.12 : 0.35;
      const usable = Math.max(1.5, (buf.duration - 1.6) / rate);
      const xf = 0.9;
      let t = at;
      let left = Math.max(0.12, hold);
      let first = true;
      while (left > 0) {
        const seg = left + rel <= usable ? left : usable - xf;
        // the next bow swells in while this one fades out
        this.ends.push(this.voice(buf, rate, g.input, t, vel, first ? atk : xf, seg, left === seg ? rel : xf));
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
    for (const g of byDest.values()) for (const n of g.nodes) n.disconnect();
    this.groups.delete(dest);
  }
}
