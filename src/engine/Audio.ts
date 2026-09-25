// Web Audio synthesis — every footstep, creak, mob voice and note of music is
// generated in code (no audio assets).
//
//   sfx events ───► sfxBus ─► comp ──┐
//   ambience ─────► ambBus ──────────┼─► master ─► underwater LP ─► limiter ─► out
//   music notes ─► piece ─► musicBus ─► duck ─┘        ▲
//             (sends from all three) ─► reverb ────────┘   (+ tempo delay on music)
//
// Every sound is a short-lived "event": one gain node plus its sources and
// filters. The chain disconnects itself when its last source ends, and each
// bus has a voice cap so a TNT chain or a mob crowd can't swamp the CPU.

import { SoundClass, def, hasDef } from './Blocks';
import { compose, fragment, mtof, MNote, TITLE_SEED } from './AudioMusic';

export type SfxName =
  | 'pop' | 'hurt' | 'hit' | 'eat' | 'burp' | 'click' | 'select' | 'fail' | 'craft' | 'level'
  | 'doorOpen' | 'doorClose' | 'plateOn' | 'plateOff'
  | 'explode' | 'bow' | 'snap' | 'fuse' | 'arrowHit' | 'whoosh' | 'lowdur'
  | 'thunder' | 'rain' | 'splash' | 'hoof' | 'mount'
  | 'submerge' | 'emerge'
  | 'chestOpen' | 'chestClose' | 'advancement' | 'equip' | 'lavaPop' | 'bubble';

/** Ambient mood selector for ambientTick. */
export type AmbientEnv = 'day' | 'night' | 'cave' | 'nether';

/** Overworld biome flavour for the generative music (key/tempo/colour shifts). */
export type MusicBiome =
  'plains' | 'forest' | 'desert' | 'snow' | 'taiga' | 'swamp' | 'mountains' | 'jungle';

/** Mob vocalisation kind. */
export type MobVoice = 'idle' | 'hurt' | 'death';

interface AudioSettings { music: boolean; sound: boolean; volume: number; musicVol: number; soundVol: number }

type Pool = 'sfx' | 'amb' | 'music';
/** One live sound: an output gain, its helper nodes, and a count of running sources. */
interface Ev { t: number; out: GainNode; nodes: AudioNode[]; live: number; pool: Pool }

/** Finer material than Blocks' SoundClass, resolved per block id. */
type Mat = 'grass' | 'plant' | 'gravel' | 'sand' | 'snow' | 'wood' | 'stone' | 'metal' | 'glass'
  | 'wool' | 'nether' | 'soul' | 'amethyst' | 'none';
type Act = 'step' | 'hit' | 'break' | 'place';

interface Piece { notes: MNote[]; i: number; t0: number; end: number; out: GainNode; env: string; fading: boolean; name: string }

const SETTINGS_KEY = 'voxelcraft-audio';
const CAP: Record<Pool, number> = { sfx: 36, amb: 14, music: 80 };

// per-sound loudness trims, balanced against each other by offline renders
const SFX_GAIN: Partial<Record<SfxName, number>> = {
  pop: 4.5, hit: 1.7, click: 3.5, select: 5, fail: 0.7, plateOn: 1.4, plateOff: 1.4, bow: 1.9,
  snap: 1.8, arrowHit: 1.8, hoof: 1.2, doorOpen: 0.6, doorClose: 0.4, chestClose: 0.35, mount: 0.35,
  submerge: 1.6, emerge: 1.6, splash: 0.6, whoosh: 0.6, lavaPop: 3, bubble: 5, hurt: 1.6,
};
// material trims: [break/hit, step] — evens out how loud each texture reads
const MAT_GAIN: Record<Mat, [number, number]> = {
  stone: [0.9, 1.7], wood: [1.25, 1.6], grass: [0.56, 0.9], plant: [1, 1], gravel: [1, 1],
  sand: [0.4, 0.63], soul: [0.45, 0.63], snow: [1.4, 1.25], wool: [1, 1.4], metal: [0.8, 1.4],
  glass: [0.63, 1.7], nether: [0.8, 1], amethyst: [0.56, 1.25], none: [0, 0],
};

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
const rand = (a: number, b: number): number => a + Math.random() * (b - a);
const chance = (p: number): boolean => Math.random() < p;

// ------------------------------------------------------------------------------
// primitive option bags
// ------------------------------------------------------------------------------
interface NzOpt {
  at?: number; dur: number; vol: number;
  color?: 'white' | 'pink' | 'brown';
  type?: BiquadFilterType; f?: number; f1?: number; q?: number;
  type2?: BiquadFilterType; f2?: number; q2?: number;
  attack?: number; curve?: Float32Array; rate?: number; to?: AudioNode;
}
interface TnOpt {
  at?: number; dur: number; f: number; f1?: number; vol: number;
  type?: OscillatorType; wave?: PeriodicWave; attack?: number; detune?: number;
  glide?: number; to?: AudioNode; lp?: number;
}
interface VoxOpt {
  at?: number; dur: number; vol: number;
  pitch: number[];                    // f0 contour, points spread evenly over dur
  formants: [number[], number, number][]; // [freq contour, Q, gain]
  type?: OscillatorType; attack?: number; release?: number;
  vib?: [number, number];             // [rate Hz, depth cents]
  rough?: [number, number];           // fast pitch jitter: [rate Hz, depth cents]
  breath?: number; direct?: number; to?: AudioNode;
}

export class AudioEngine {
  private ctx: BaseAudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private amb: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private musicDuck: GainNode | null = null;
  private uwFilter: BiquadFilterNode | null = null;
  private sfxVerb: GainNode | null = null;
  private reverbIn: GainNode | null = null;
  private delay: DelayNode | null = null;
  private white: AudioBuffer | null = null;
  private pink: AudioBuffer | null = null;
  private brown: AudioBuffer | null = null;
  private rainBuf: AudioBuffer | null = null;
  private pianoWave: PeriodicWave | null = null;
  private padWave: PeriodicWave | null = null;
  private live: Record<Pool, number> = { sfx: 0, amb: 0, music: 0 };
  private livePeak: Record<Pool, number> = { sfx: 0, amb: 0, music: 0 };
  private lastAt = new Map<string, number>();
  private settings: AudioSettings = { music: true, sound: true, volume: 0.7, musicVol: 1, soundVol: 1 };
  // held so the effect graph isn't garbage-collected mid-session
  private fx: AudioNode[] = [];
  private pumpTimer = 0;

  // generative music state
  private musicMode: 'menu' | 'game' = 'game';
  private piece: Piece | null = null;
  private nextPieceAt = 6;
  private menuCount = 0;
  private env: AmbientEnv = 'day';
  private biome: MusicBiome | undefined;
  private envAt = -99;         // ctx time of the last ambientTick (game is live)
  private fragT = 40;          // seconds until a short musical fragment between pieces

  // ambience
  private atmosphereT = 8;
  private heartT = 0;
  private bubbleT = 2;
  private rain: { src: AudioBufferSourceNode; g: GainNode; lp: BiquadFilterNode; roar: GainNode; nodes: AudioNode[] } | null = null;
  private rainState: 'off' | 'rain' | 'thunder' = 'off';
  private uw: { src: AudioBufferSourceNode; g: GainNode; nodes: AudioNode[] } | null = null;
  private underwater = false;
  private netherBed: { src: AudioBufferSourceNode; g: GainNode; nodes: AudioNode[] } | null = null;
  private unlocked = false;
  private resuming = false;

  constructor() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) this.settings = { ...this.settings, ...JSON.parse(raw) };
    } catch { /* default settings */ }
  }

  // ==========================================================================
  // settings
  // ==========================================================================

  get musicOn(): boolean { return this.settings.music; }
  get soundOn(): boolean { return this.settings.sound; }
  get volume(): number { return this.settings.volume; }
  get musicVolume(): number { return this.settings.musicVol; }
  get soundVolume(): number { return this.settings.soundVol; }

  // perceptual (squared) taper; 0.7 lands on the old fixed 0.35 master gain
  private masterFor(v: number): number { const c = clamp(v, 0, 1); return 0.72 * c * c; }

  /** Smoothly glide an AudioParam to a value (no zipper clicks). */
  private glide(p: AudioParam, v: number, time = 0.12): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
    p.linearRampToValueAtTime(v, t + time);
  }

  /** Master loudness 0..1; ramps smoothly and persists. */
  setVolume(v: number): void {
    this.settings.volume = clamp(v, 0, 1);
    if (this.master) this.glide(this.master.gain, this.masterFor(this.settings.volume), 0.1);
    this.persist();
  }

  /** Music loudness 0..1 (relative to master). */
  setMusicVolume(v: number): void {
    this.settings.musicVol = clamp(v, 0, 1);
    this.applyBusGains();
    this.persist();
  }

  /** Sound-effect + ambience loudness 0..1 (relative to master). */
  setSoundVolume(v: number): void {
    this.settings.soundVol = clamp(v, 0, 1);
    this.applyBusGains();
    this.persist();
  }

  setMusic(on: boolean): void {
    this.settings.music = on;
    this.applyBusGains();
    if (!on) this.fadePiece(0.6);
    else if (this.ctx) this.nextPieceAt = this.ctx.currentTime + rand(1.5, 4);
    this.persist();
  }

  setSound(on: boolean): void {
    this.settings.sound = on;
    this.applyBusGains();
    this.persist();
  }

  private applyBusGains(): void {
    const s = this.settings;
    if (this.musicBus) this.glide(this.musicBus.gain, s.music ? s.musicVol : 0, 0.5);
    if (this.sfx) this.glide(this.sfx.gain, s.sound ? s.soundVol : 0, 0.08);
    if (this.amb) this.glide(this.amb.gain, s.sound ? s.soundVol : 0, 0.4);
  }

  private persist(): void {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch { /* ignore */ }
  }

  // ==========================================================================
  // context lifecycle
  // ==========================================================================

  /** Must be called from a user gesture at least once (safe to call repeatedly). */
  ensure(): void {
    const ctx = this.ctx;
    if (ctx && ctx.state === 'running' && this.unlocked) return;
    // resume synchronously too, so a call inside a user gesture always counts
    if (ctx instanceof AudioContext && ctx.state !== 'running') ctx.resume().catch(() => { /* needs a gesture */ });
    void this.ensureRunning();
  }

  /** True once the Web Audio context is running (unlocked after a user gesture). */
  get isRunning(): boolean {
    return this.ctx?.state === 'running';
  }

  private async ensureRunning(): Promise<void> {
    if (!this.ctx) {
      let ctx: AudioContext;
      try { ctx = new AudioContext({ latencyHint: 'interactive' }); } catch { return; }
      if (!this.attachContext(ctx)) return;
    }
    const ctx = this.ctx;
    if (!(ctx instanceof AudioContext)) return; // offline test contexts render on demand
    if (ctx.state !== 'running') this.unlocked = false;
    // one resume loop at a time — play() may be called many times per frame
    if (this.resuming) return;
    this.resuming = true;
    try {
      for (let i = 0; i < 24 && ctx.state !== 'running'; i++) {
        try { await ctx.resume(); } catch { /* gesture may be required */ }
        if ((ctx.state as string) === 'running') break;
        await new Promise<void>((r) => setTimeout(r, 25));
      }
    } finally {
      this.resuming = false;
    }
    if (ctx.state === 'running') this.unlock();
  }

  /** iOS/Safari unlock trick: play a one-sample silent buffer while the context
   *  is running inside a user gesture. Only marked done when state is 'running'. */
  private unlock(): void {
    const ctx = this.ctx;
    if (this.unlocked || !ctx || ctx.state !== 'running') return;
    try {
      const b = ctx.createBufferSource();
      b.buffer = ctx.createBuffer(1, 1, 22050);
      b.connect(ctx.destination);
      b.start(0);
      this.unlocked = true;
      if (this.nextPieceAt < ctx.currentTime) this.nextPieceAt = ctx.currentTime + (this.musicMode === 'menu' ? 0.6 : 6);
    } catch { /* ignore — ensure() will retry on the next gesture */ }
  }

  /** Build the mixing graph on a context. Public so a test harness can render
   *  the engine into an OfflineAudioContext. */
  attachContext(ctx: BaseAudioContext): boolean {
    try {
      this.ctx = ctx;
      const s = this.settings;
      this.master = ctx.createGain();
      this.master.gain.value = this.masterFor(s.volume);
      // master → underwater lowpass (transparent until submerged) → limiter → out
      this.uwFilter = ctx.createBiquadFilter();
      this.uwFilter.type = 'lowpass';
      this.uwFilter.frequency.value = 20000;
      this.uwFilter.Q.value = 0.7;
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -5;
      limiter.knee.value = 3;
      limiter.ratio.value = 16;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.18;
      this.master.connect(this.uwFilter).connect(limiter).connect(ctx.destination);

      // shared reverb: procedural stereo impulse with damped (darker) tail
      const reverb = ctx.createConvolver();
      reverb.buffer = this.makeImpulse(3.2, 2.6);
      this.reverbIn = ctx.createGain();
      const verbOut = ctx.createGain();
      verbOut.gain.value = 0.85;
      this.reverbIn.connect(reverb).connect(verbOut).connect(this.master);

      // sound effects: gentle glue compression, small room send (grows in caves)
      this.sfx = ctx.createGain();
      this.sfx.gain.value = s.sound ? s.soundVol : 0;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.knee.value = 10;
      comp.ratio.value = 3;
      comp.attack.value = 0.003;
      comp.release.value = 0.12;
      this.sfx.connect(comp).connect(this.master);
      this.sfxVerb = ctx.createGain();
      this.sfxVerb.gain.value = 0.035;
      this.sfx.connect(this.sfxVerb).connect(this.reverbIn);

      // ambience (birds, wind, cave cues, rain): its own bus, generous reverb
      this.amb = ctx.createGain();
      this.amb.gain.value = s.sound ? s.soundVol : 0;
      this.amb.connect(this.master);
      const ambVerb = ctx.createGain();
      ambVerb.gain.value = 0.3;
      this.amb.connect(ambVerb).connect(this.reverbIn);

      // music: bus (on/off × volume) → duck → master, plus reverb + tempo delay
      this.musicBus = ctx.createGain();
      this.musicBus.gain.value = s.music ? s.musicVol : 0;
      this.musicDuck = ctx.createGain();
      this.musicBus.connect(this.musicDuck).connect(this.master);
      const musicVerb = ctx.createGain();
      musicVerb.gain.value = 0.42;
      this.musicDuck.connect(musicVerb).connect(this.reverbIn);
      // soft feedback delay, darkened each repeat so echoes melt into the reverb
      this.delay = ctx.createDelay(2.0);
      this.delay.delayTime.value = 0.6;
      const fb = ctx.createGain();
      fb.gain.value = 0.28;
      const fbLp = ctx.createBiquadFilter();
      fbLp.type = 'lowpass';
      fbLp.frequency.value = 2600;
      const delayWet = ctx.createGain();
      delayWet.gain.value = 0.14;
      this.musicDuck.connect(this.delay);
      this.delay.connect(fbLp).connect(fb).connect(this.delay);
      this.delay.connect(delayWet).connect(this.master);
      delayWet.connect(this.reverbIn);
      this.fx = [limiter, reverb, verbOut, comp, ambVerb, musicVerb, fb, fbLp, delayWet];

      // shared noise sources: generated once, played from random offsets
      this.white = this.makeNoise('white');
      this.pink = this.makeNoise('pink');
      this.brown = this.makeNoise('brown');
      this.pianoWave = this.makeWave([1, 0.42, 0.26, 0.19, 0.1, 0.07, 0.055, 0.03, 0.022, 0.012, 0.008]);
      this.padWave = this.makeWave([1, 0.5, 0.33, 0.22, 0.14, 0.09, 0.06, 0.04]);

      if (typeof window !== 'undefined' && ctx instanceof AudioContext) {
        this.pumpTimer = window.setInterval(this.pump, 120);
      }
      this.nextPieceAt = ctx.currentTime + (this.musicMode === 'menu' ? 0.6 : 6);
      return true;
    } catch {
      this.ctx = null;
      return false;
    }
  }

  /** Voice / scheduler counters (for harnesses and debugging). */
  debugStats(): { live: Record<Pool, number>; peak: Record<Pool, number>; piece: string | null; rain: string; nether: boolean } {
    return { live: { ...this.live }, peak: { ...this.livePeak }, piece: this.piece?.name ?? null, rain: this.rainState, nether: !!this.netherBed };
  }

  private makeNoise(color: 'white' | 'pink' | 'brown'): AudioBuffer {
    const ctx = this.ctx!;
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (color === 'white') d[i] = w;
      else if (color === 'pink') {
        // Paul Kellet's economy pink filter
        b0 = 0.99765 * b0 + w * 0.099;
        b1 = 0.963 * b1 + w * 0.2965;
        b2 = 0.57 * b2 + w * 1.0527;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
      } else {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      }
    }
    return buf;
  }

  private makeWave(harm: number[]): PeriodicWave {
    const ctx = this.ctx!;
    const real = new Float32Array(harm.length + 1);
    const imag = new Float32Array(harm.length + 1);
    harm.forEach((a, i) => { imag[i + 1] = a; });
    return ctx.createPeriodicWave(real, imag);
  }

  /** Procedural reverb impulse: pre-delay, a few early reflections, then a
   *  decorrelated stereo tail whose highs die away faster than its lows. */
  private makeImpulse(dur: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * dur);
    const buf = ctx.createBuffer(2, len, sr);
    const pre = Math.floor(sr * 0.018);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = pre; i < len; i++) {
        const x = i / len;
        const k = 0.75 - 0.68 * x; // lowpass coefficient: bright start, dark tail
        lp += (Math.random() * 2 - 1 - lp) * k;
        d[i] = lp * Math.pow(1 - x, decay);
      }
      for (let r = 0; r < 7; r++) {
        const at = pre + Math.floor(sr * (0.006 + Math.random() * 0.07));
        if (at < len) d[at] += (Math.random() < 0.5 ? -1 : 1) * (0.7 - r * 0.07);
      }
    }
    return buf;
  }

  // ==========================================================================
  // event plumbing
  // ==========================================================================

  /** Open a one-shot event on a pool's bus. Returns null when the pool is full —
   *  the extra sound is simply skipped. `at` is an absolute context time. */
  private open(pool: Pool, vol: number, o: { pan?: number; at?: number; to?: AudioNode } = {}): Ev | null {
    const ctx = this.ctx;
    const bus = o.to ?? (pool === 'sfx' ? this.sfx : pool === 'amb' ? this.amb : this.musicBus);
    if (!ctx || !bus || vol <= 0.0003) return null;
    if (this.live[pool] >= CAP[pool]) return null;
    const out = ctx.createGain();
    out.gain.value = vol;
    const e: Ev = { t: o.at ?? ctx.currentTime + 0.005, out, nodes: [], live: 0, pool };
    if (o.pan) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(o.pan, -1, 1);
      out.connect(p).connect(bus);
      e.nodes.push(p);
    } else {
      out.connect(bus);
    }
    if (++this.live[pool] > this.livePeak[pool]) this.livePeak[pool] = this.live[pool];
    return e;
  }

  /** Start a source inside an event; the event tears itself down after the last one ends. */
  private run(e: Ev, src: AudioScheduledSourceNode, start: number, stop: number, offset?: number): void {
    e.live++;
    src.onended = () => {
      src.disconnect();
      if (--e.live <= 0) this.close(e);
    };
    if (offset !== undefined && src instanceof AudioBufferSourceNode) src.start(start, offset);
    else src.start(start);
    src.stop(stop);
  }

  private close(e: Ev): void {
    for (const n of e.nodes) n.disconnect();
    e.out.disconnect();
    e.nodes.length = 0;
    this.live[e.pool] = Math.max(0, this.live[e.pool] - 1);
  }

  /** Release an event that ended up with no sources. */
  private seal(e: Ev | null): void { if (e && e.live === 0) this.close(e); }

  /** Rate-limit a named sound so stacked triggers (a pile of pickups) don't phase. */
  private gate(key: string, gap: number): boolean {
    const now = this.ctx?.currentTime ?? 0;
    const last = this.lastAt.get(key) ?? -1;
    if (now - last < gap) return false;
    this.lastAt.set(key, now);
    return true;
  }

  /** Temporarily lower the music under a loud event, then recover smoothly. */
  private duck(depth: number, hold: number, release = 1.8): void {
    const g = this.musicDuck?.gain;
    if (!g || !this.ctx) return;
    const t = this.ctx.currentTime;
    const target = Math.min(g.value, 1 - depth);
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(target, t + 0.05);
    g.setValueAtTime(target, t + 0.05 + hold);
    g.linearRampToValueAtTime(1, t + 0.05 + hold + release);
  }

  // ==========================================================================
  // synthesis primitives
  // ==========================================================================

  /** Random crackle envelope: `count` grains, sharper with `sharp`→1, weighted
   *  toward the start by `skew`, over a faint decaying floor. */
  private grains(count: number, sharp: number, skew = 1.5, floor = 0.08): Float32Array {
    const n = 192;
    const c = new Float32Array(n);
    const w = 1 + (1 - sharp) * 8;
    for (let k = 0; k < count; k++) {
      const p = Math.floor(Math.pow(Math.random(), skew) * (n - 6));
      const a = 0.3 + Math.random() * 0.7;
      for (let j = 0; j < w * 4 && p + j < n; j++) c[p + j] = Math.max(c[p + j], a * Math.exp(-j / w));
    }
    for (let i = 0; i < n; i++) {
      const fade = 1 - i / n;
      c[i] = Math.min(1, c[i] + floor * fade) * Math.sqrt(fade);
    }
    c[0] = 0;
    c[n - 1] = 0;
    return c;
  }

  /** Filtered noise layer with either a decay envelope or a grain curve. */
  private nz(e: Ev, o: NzOpt): void {
    const ctx = this.ctx!;
    const t = e.t + (o.at ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = o.color === 'pink' ? this.pink : o.color === 'brown' ? this.brown : this.white;
    src.loop = true;
    src.playbackRate.value = o.rate ?? 1;
    let head: AudioNode = src;
    if (o.type) {
      const f = ctx.createBiquadFilter();
      f.type = o.type;
      f.frequency.setValueAtTime(o.f ?? 1000, t);
      if (o.f1) f.frequency.exponentialRampToValueAtTime(Math.max(30, o.f1), t + o.dur);
      f.Q.value = o.q ?? (o.type === 'bandpass' ? 1 : 0.7);
      head.connect(f);
      head = f;
      e.nodes.push(f);
    }
    if (o.type2) {
      const f = ctx.createBiquadFilter();
      f.type = o.type2;
      f.frequency.value = o.f2 ?? 1000;
      f.Q.value = o.q2 ?? 0.7;
      head.connect(f);
      head = f;
      e.nodes.push(f);
    }
    const g = ctx.createGain();
    if (o.curve) {
      const c = new Float32Array(o.curve.length);
      for (let i = 0; i < c.length; i++) c[i] = o.curve[i] * o.vol;
      g.gain.value = 0;
      g.gain.setValueCurveAtTime(c, t, o.dur);
    } else {
      const a = o.attack ?? 0.003;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(o.vol, t + a);
      g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(a + 0.005, o.dur));
    }
    head.connect(g).connect(o.to ?? e.out);
    e.nodes.push(g);
    this.run(e, src, t, t + o.dur + 0.03, Math.random() * 1.5);
  }

  /** Oscillator layer with a pitch sweep and a fast-attack exponential decay. */
  private tn(e: Ev, o: TnOpt): OscillatorNode {
    const ctx = this.ctx!;
    const t = e.t + (o.at ?? 0);
    const osc = ctx.createOscillator();
    if (o.wave) osc.setPeriodicWave(o.wave); else osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.f, t);
    if (o.f1 !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t + (o.glide ?? o.dur));
    if (o.detune) osc.detune.value = o.detune;
    const g = ctx.createGain();
    const a = o.attack ?? 0.004;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(o.vol, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(a + 0.005, o.dur));
    let head: AudioNode = osc;
    if (o.lp) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = o.lp;
      head.connect(f);
      head = f;
      e.nodes.push(f);
    }
    head.connect(g).connect(o.to ?? e.out);
    e.nodes.push(g);
    this.run(e, osc, t, t + o.dur + 0.03);
    return osc;
  }

  /** Two-operator FM voice: bells, chimes, e-piano tines. */
  private fm(e: Ev, o: { at?: number; f: number; ratio: number; index: number; dur: number; vol: number; idxDur?: number; attack?: number; to?: AudioNode }): void {
    const ctx = this.ctx!;
    const t = e.t + (o.at ?? 0);
    const car = ctx.createOscillator();
    car.frequency.value = o.f;
    const mod = ctx.createOscillator();
    mod.frequency.value = o.f * o.ratio;
    const mg = ctx.createGain();
    mg.gain.setValueAtTime(o.f * o.index, t);
    mg.gain.exponentialRampToValueAtTime(Math.max(0.01, o.f * o.index * 0.04), t + (o.idxDur ?? o.dur * 0.4));
    mod.connect(mg).connect(car.frequency);
    const g = ctx.createGain();
    const a = o.attack ?? 0.003;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(o.vol, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    car.connect(g).connect(o.to ?? e.out);
    e.nodes.push(mg, g);
    this.run(e, car, t, t + o.dur + 0.03);
    this.run(e, mod, t, t + o.dur + 0.03);
  }

  /** Formant voice: a buzzy glottal source through vowel-like bandpass
   *  resonances, with pitch contour, vibrato, roughness and breath. */
  private vox(e: Ev, o: VoxOpt): void {
    const ctx = this.ctx!;
    const t = e.t + (o.at ?? 0);
    const d = o.dur;
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sawtooth';
    const pts = o.pitch;
    osc.frequency.setValueAtTime(pts[0], t);
    for (let i = 1; i < pts.length; i++) osc.frequency.linearRampToValueAtTime(pts[i], t + (d * i) / (pts.length - 1));
    const env = ctx.createGain();
    const a = o.attack ?? 0.02;
    const rel = Math.min(o.release ?? d * 0.4, d - a);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(o.vol, t + a);
    env.gain.setValueAtTime(o.vol, t + d - rel);
    env.gain.exponentialRampToValueAtTime(0.0001, t + d);
    env.connect(o.to ?? e.out);
    e.nodes.push(env);
    let breath: AudioBufferSourceNode | null = null;
    let bg: GainNode | null = null;
    if (o.breath) {
      breath = ctx.createBufferSource();
      breath.buffer = this.pink;
      breath.loop = true;
      bg = ctx.createGain();
      bg.gain.value = o.breath * 4;
      breath.connect(bg);
      e.nodes.push(bg);
    }
    for (const [fs, q, gain] of o.formants) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = q;
      bp.frequency.setValueAtTime(fs[0], t);
      for (let i = 1; i < fs.length; i++) bp.frequency.linearRampToValueAtTime(fs[i], t + (d * i) / (fs.length - 1));
      const fg = ctx.createGain();
      fg.gain.value = gain * Math.sqrt(q) * 0.4; // narrow bands pass less energy — compensate
      osc.connect(bp);
      if (bg) bg.connect(bp);
      bp.connect(fg).connect(env);
      e.nodes.push(bp, fg);
    }
    if (o.direct) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = pts[0] * 3;
      const dg = ctx.createGain();
      dg.gain.value = o.direct;
      osc.connect(lp).connect(dg).connect(env);
      e.nodes.push(lp, dg);
    }
    const mod = (rate: number, cents: number, shape: OscillatorType): void => {
      const l = ctx.createOscillator();
      l.type = shape;
      l.frequency.value = rate;
      const lg = ctx.createGain();
      lg.gain.value = cents;
      l.connect(lg).connect(osc.detune);
      e.nodes.push(lg);
      this.run(e, l, t, t + d + 0.03);
    };
    if (o.vib) mod(o.vib[0], o.vib[1], 'sine');
    if (o.rough) mod(o.rough[0], o.rough[1], 'triangle');
    this.run(e, osc, t, t + d + 0.03);
    if (breath) this.run(e, breath, t, t + d + 0.03, Math.random() * 1.5);
  }

  /** Stick-slip friction creak (doors, chests, saddles): a jittery low pulse
   *  train rung through wood-like resonances. */
  private creak(e: Ev, at: number, dur: number, r0: number, r1: number, vol: number, body = 1): void {
    const ctx = this.ctx!;
    const t = e.t + at;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    const n = 24;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) curve[i] = (r0 + (r1 - r0) * (i / (n - 1))) * (0.8 + Math.random() * 0.4);
    osc.frequency.setValueCurveAtTime(curve, t, dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + dur * 0.2);
    g.gain.setValueAtTime(vol, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    for (const [f, q, gg] of [[720 * body, 7, 1], [1500 * body, 9, 0.7], [2900 * body, 10, 0.35]] as [number, number, number][]) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f * rand(0.92, 1.08);
      bp.Q.value = q;
      const bg = ctx.createGain();
      bg.gain.value = gg * 2.4;
      osc.connect(bp).connect(bg).connect(g);
      e.nodes.push(bp, bg);
    }
    g.connect(e.out);
    e.nodes.push(g);
    this.run(e, osc, t, t + dur + 0.03);
  }

  /** Resonant wooden knock: two body modes + a click. */
  private knock(e: Ev, at: number, f: number, vol: number, dur = 0.12): void {
    this.tn(e, { at, dur, f, f1: f * 0.92, vol: vol * 0.7 });
    this.tn(e, { at, dur: dur * 0.6, f: f * 2.37, f1: f * 2.2, vol: vol * 0.32 });
    this.nz(e, { at, dur: 0.025, vol: vol * 0.5, type: 'bandpass', f: f * 4, q: 1.2 });
  }

  // ==========================================================================
  // block materials: dig / break / place / step
  // ==========================================================================

  /** Refine a SoundClass into a material using the block's name. */
  private matFor(cls: SoundClass, id?: number): Mat {
    if (id !== undefined && hasDef(id)) {
      const n = def(id).name;
      if (n === 'dirt' || n === 'farmland' || n === 'gravel') return 'gravel';
      if (n === 'snow_grass') return 'snow';
      if (n.endsWith('_leaves')) return 'grass';
      if (n === 'white_wool' || n === 'cactus' || n.startsWith('bed')) return 'wool';
      if (n === 'iron_block' || n === 'gold_block' || n === 'diamond_block' || n === 'emerald_block') return 'metal';
      if (n === 'netherrack' || n === 'nether_quartz_ore' || n === 'magma' || n === 'nether_bricks') return 'nether';
      if (n === 'soul_sand') return 'soul';
      if (n === 'amethyst_ore') return 'amethyst';
      if (cls === 'grass' && n !== 'grass_block' && n !== 'tnt') return 'plant';
    }
    return cls === 'none' ? 'none' : cls;
  }

  /** Dig/place sound for a block sound class. vol ≤ 0.3 reads as a mining hit,
   *  otherwise a break/place; pass the block id for finer materials. */
  dig(cls: SoundClass, vol: number, pitch = 1, id?: number): void {
    this.ensure();
    const act: Act = vol <= 0.3 ? 'hit' : vol < 0.95 ? 'place' : 'break';
    if (act === 'hit' && !this.gate('dighit', 0.05)) return;
    this.material(this.matFor(cls, id), act, vol, pitch);
  }

  /** Footstep on a block. */
  step(cls: SoundClass, id?: number): void {
    if (!this.gate('step', 0.06)) return;
    this.ensure();
    const m = this.matFor(cls, id);
    this.material(m === 'none' ? 'stone' : m, 'step', 0.16, rand(0.9, 1.1));
  }

  private material(mat: Mat, act: Act, vol: number, pitch: number): void {
    if (mat === 'none' || !this.ctx) return;
    const [gBreak, gStep] = MAT_GAIN[mat];
    const trim = act === 'step' || (mat === 'glass' && act !== 'break') ? gStep : gBreak;
    const e = this.open('sfx', vol * trim * (act === 'hit' ? 3.4 : 1), { pan: rand(-0.06, 0.06) });
    if (!e) return;
    const p = pitch * rand(0.92, 1.08);
    const big = act === 'break' || act === 'place';
    const len = act === 'step' ? 0.7 : act === 'hit' ? 0.6 : 1;
    switch (mat) {
      case 'stone': {
        this.nz(e, { dur: 0.03, vol: 0.5, type: 'bandpass', f: 2600 * p, q: 1.3 });
        this.nz(e, { dur: 0.17 * len, vol: 0.9, color: 'pink', type: 'bandpass', f: 2100 * p, f1: 900, q: 0.6, curve: this.grains(big ? 8 : 3, 0.85) });
        this.tn(e, { dur: 0.07, f: 170 * p, f1: 70, vol: big ? 0.25 : 0.15 });
        break;
      }
      case 'nether': {
        this.nz(e, { dur: 0.2 * len, vol: 0.8, color: 'pink', type: 'lowpass', f: 1100 * p, f1: 380, curve: this.grains(big ? 9 : 4, 0.7) });
        this.nz(e, { dur: 0.08, vol: 0.3, type: 'bandpass', f: 520 * p, q: 3 });
        this.tn(e, { dur: 0.1, f: 120 * p, f1: 55, vol: 0.3 });
        break;
      }
      case 'wood': {
        this.knock(e, 0, (act === 'step' ? 240 : 330) * p, big ? 0.6 : 0.45, 0.13 * len + 0.02);
        this.nz(e, { dur: 0.1 * len, vol: 0.35, color: 'pink', type: 'bandpass', f: 900 * p, q: 0.9, curve: this.grains(big ? 5 : 2, 0.75) });
        if (big) this.nz(e, { at: 0.02, dur: 0.16, vol: 0.28, type: 'bandpass', f: 1800 * p, q: 1.5, curve: this.grains(6, 0.9, 1.2) });
        break;
      }
      case 'grass': case 'plant': {
        const hi = mat === 'plant' ? 1.3 : 1;
        this.nz(e, { dur: 0.2 * len, vol: 0.9, type: 'bandpass', f: 2600 * p * hi, q: 0.8, curve: this.grains(big ? 16 : 8, 0.85, 1.2) });
        this.nz(e, { dur: 0.12 * len, vol: 0.28, color: 'pink', type: 'lowpass', f: 600 * p, attack: 0.01 });
        if (big && mat === 'plant') this.tn(e, { dur: 0.03, f: 1400 * p, f1: 700, vol: 0.06 });
        break;
      }
      case 'gravel': {
        this.nz(e, { dur: 0.19 * len, vol: 0.95, color: 'pink', type: 'bandpass', f: 1300 * p, q: 0.7, curve: this.grains(big ? 16 : 9, 0.95, 1.3) });
        this.nz(e, { dur: 0.08, vol: 0.4, color: 'brown', type: 'lowpass', f: 380 * p });
        break;
      }
      case 'sand': case 'soul': {
        this.nz(e, { dur: 0.24 * len, vol: 0.55, type: 'highpass', f: 2200 * p, type2: 'lowpass', f2: 7500, curve: this.grains(big ? 22 : 12, 0.55, 1.1, 0.25) });
        this.nz(e, { dur: 0.12 * len, vol: 0.3, color: 'pink', type: 'lowpass', f: 900 * p, attack: 0.015 });
        if (mat === 'soul' && chance(act === 'step' ? 0.25 : 0.6)) {
          // soul sand: a faint ghostly exhale under the grit
          this.vox(e, { dur: 0.45, vol: 0.05, pitch: [rand(170, 220), rand(140, 170)], type: 'triangle', formants: [[[400, 700], 4, 1]], vib: [5, 20], attack: 0.1 });
        }
        break;
      }
      case 'snow': {
        this.nz(e, { dur: 0.18 * len, vol: 0.85, color: 'pink', type: 'bandpass', f: 1100 * p, q: 1.4, type2: 'lowpass', f2: 3000, curve: this.grains(big ? 12 : 7, 0.6, 1.2, 0.2) });
        this.nz(e, { dur: 0.1 * len, vol: 0.2, color: 'brown', type: 'lowpass', f: 400 });
        break;
      }
      case 'wool': {
        this.nz(e, { dur: 0.16 * len, vol: 0.55, color: 'pink', type: 'lowpass', f: 750 * p, curve: this.grains(4, 0.3, 1.2, 0.35) });
        this.nz(e, { dur: 0.1, vol: 0.12, type: 'bandpass', f: 1800 * p, q: 0.8, curve: this.grains(5, 0.5) });
        break;
      }
      case 'metal': {
        this.nz(e, { dur: 0.025, vol: 0.45, type: 'highpass', f: 2800 });
        const base = (act === 'step' ? 420 : 560) * p;
        const ring = (big ? 0.55 : 0.22) * len;
        [[1, 0.2], [2.76, 0.12], [5.4, 0.07], [8.93, 0.04]].forEach(([m, v], k) =>
          this.tn(e, { dur: ring / (1 + k * 0.5), f: base * m, vol: v }));
        this.tn(e, { dur: 0.07, f: 160 * p, f1: 80, vol: 0.2 });
        break;
      }
      case 'glass': {
        if (act === 'break') {
          // shatter: a burst of bright shards over a gritty hiss
          this.nz(e, { dur: 0.42, vol: 0.55, type: 'highpass', f: 3200, curve: this.grains(18, 0.95, 1.8) });
          for (let i = 0; i < 7; i++) {
            this.tn(e, { at: Math.pow(Math.random(), 2) * 0.22, dur: rand(0.06, 0.28), f: rand(2400, 6800) * p, vol: rand(0.03, 0.08) });
          }
          this.tn(e, { dur: 0.06, f: 220, f1: 90, vol: 0.18 });
        } else {
          // place/step/hit on glass: a stone click with a glassy tick
          this.nz(e, { dur: 0.03, vol: 0.45, type: 'bandpass', f: 3000 * p, q: 1.5 });
          this.nz(e, { dur: 0.1 * len, vol: 0.4, color: 'pink', type: 'lowpass', f: 1700 * p, curve: this.grains(3, 0.8) });
          this.tn(e, { dur: 0.05, f: 3400 * p, vol: 0.05 });
        }
        break;
      }
      case 'amethyst': {
        this.nz(e, { dur: 0.03, vol: 0.4, type: 'bandpass', f: 2600 * p, q: 1.3 });
        const notes = [0, 3, 5, 7, 10, 12];
        const n = act === 'step' ? 1 : big ? 3 : 2;
        for (let i = 0; i < n; i++) {
          const f = 1320 * Math.pow(2, notes[(Math.random() * notes.length) | 0] / 12) * p;
          this.fm(e, { at: i * 0.045, f, ratio: 2.76, index: 0.9, dur: big ? 1.1 : 0.6, vol: 0.09 });
        }
        break;
      }
    }
    this.seal(e);
  }

  // ==========================================================================
  // one-shot effects
  // ==========================================================================

  play(name: SfxName): void {
    this.ensure();
    if (!this.ctx) return;
    const gaps: Partial<Record<SfxName, number>> = {
      pop: 0.035, select: 0.03, click: 0.025, hit: 0.04, eat: 0.07, splash: 0.08, arrowHit: 0.03,
      hoof: 0.05, fuse: 0.12, bubble: 0.03, lavaPop: 0.05, fail: 0.08, level: 0.1,
    };
    const g = gaps[name];
    if (g !== undefined && !this.gate(name, g)) return;
    if (name === 'rain') { this.setRain('rain', 0.5); return; }
    const e = this.open('sfx', SFX_GAIN[name] ?? 1);
    if (!e) return;
    this.buildSfx(e, name);
    this.seal(e);
  }

  private buildSfx(e: Ev, name: SfxName): void {
    switch (name) {
      case 'pop': {
        // item pickup: a soft bubbly blip at a wide random pitch, like MC
        const p = rand(0.75, 1.6);
        this.tn(e, { dur: 0.07, f: 540 * p, f1: 1150 * p, glide: 0.035, vol: 0.2, attack: 0.002 });
        this.tn(e, { dur: 0.05, f: 1080 * p, f1: 2100 * p, glide: 0.03, vol: 0.05 });
        this.nz(e, { dur: 0.012, vol: 0.05, type: 'highpass', f: 3000 });
        break;
      }
      case 'hurt': {
        // the player's "oof": a short voiced grunt plus a body thump
        const p = rand(0.94, 1.08);
        this.vox(e, {
          dur: 0.22, vol: 0.6, pitch: [205 * p, 228 * p, 150 * p], attack: 0.008, release: 0.12,
          formants: [[[640, 560], 5, 1], [[1100, 950], 6, 0.55], [[2450], 8, 0.15]],
          rough: [32, 30], breath: 0.1, direct: 0.25,
        });
        this.tn(e, { dur: 0.1, f: 115, f1: 55, vol: 0.3 });
        this.nz(e, { dur: 0.06, vol: 0.25, color: 'pink', type: 'lowpass', f: 900 });
        this.duck(0.25, 0.1, 0.8);
        break;
      }
      case 'hit': {
        // a meaty punch on a mob: sub thump, flesh slap, a little swish
        const p = rand(0.9, 1.1);
        this.tn(e, { dur: 0.13, f: 150 * p, f1: 52, vol: 0.42 });
        this.nz(e, { dur: 0.09, vol: 0.45, color: 'pink', type: 'lowpass', f: 1600 * p, f1: 350 });
        this.nz(e, { dur: 0.025, vol: 0.2, type: 'bandpass', f: 2300 * p, q: 1.2 });
        this.nz(e, { dur: 0.1, vol: 0.06, type: 'bandpass', f: 900, f1: 2400, q: 1.5, attack: 0.03 });
        break;
      }
      case 'eat': {
        // a crunchy munch with a little mouth resonance
        const p = rand(0.85, 1.15);
        this.nz(e, { dur: 0.16, vol: 0.55, color: 'pink', type: 'bandpass', f: 1500 * p, q: 1.1, curve: this.grains(7, 0.85, 1.1, 0.15) });
        this.nz(e, { dur: 0.1, vol: 0.18, type: 'highpass', f: 3500, curve: this.grains(5, 0.9) });
        this.tn(e, { dur: 0.07, f: 190 * p, f1: 110, vol: 0.12, attack: 0.01 });
        break;
      }
      case 'burp': {
        this.vox(e, {
          dur: 0.4, vol: 0.3, pitch: [125, 118, 88], attack: 0.02, release: 0.15,
          formants: [[[480, 560], 5, 1], [[850, 900], 6, 0.5]], rough: [26, 70], breath: 0.08, direct: 0.3,
        });
        break;
      }
      case 'click': {
        // UI click: a crisp woody "tock"
        this.tn(e, { dur: 0.035, f: 1650, f1: 1250, vol: 0.14, attack: 0.001 });
        this.tn(e, { dur: 0.05, f: 620, f1: 480, vol: 0.1, attack: 0.001 });
        this.nz(e, { dur: 0.012, vol: 0.12, type: 'bandpass', f: 4000, q: 1 });
        break;
      }
      case 'select': {
        this.tn(e, { dur: 0.03, f: 1900, f1: 1700, vol: 0.05, attack: 0.001 });
        this.nz(e, { dur: 0.01, vol: 0.05, type: 'bandpass', f: 5000, q: 1.5 });
        break;
      }
      case 'fail': {
        this.tn(e, { dur: 0.1, f: 200, f1: 160, vol: 0.12, type: 'square', lp: 1200 });
        this.tn(e, { at: 0.08, dur: 0.14, f: 150, f1: 110, vol: 0.12, type: 'square', lp: 900 });
        break;
      }
      case 'craft': {
        // wooden bench thunk + a light sparkle of the new item
        this.knock(e, 0, 280, 0.45, 0.1);
        this.nz(e, { dur: 0.08, vol: 0.2, color: 'pink', type: 'bandpass', f: 1200, curve: this.grains(4, 0.8) });
        this.fm(e, { at: 0.06, f: 1568, ratio: 3.01, index: 0.6, dur: 0.5, vol: 0.05 });
        this.fm(e, { at: 0.12, f: 2093, ratio: 3.01, index: 0.5, dur: 0.6, vol: 0.04 });
        break;
      }
      case 'level': {
        // bright two-note chime (xp / success)
        this.fm(e, { f: 1046.5, ratio: 2, index: 1.2, dur: 0.9, vol: 0.12, idxDur: 0.2 });
        this.fm(e, { at: 0.11, f: 1568, ratio: 2, index: 1.1, dur: 1.1, vol: 0.1, idxDur: 0.25 });
        this.fm(e, { at: 0.11, f: 2093, ratio: 3.5, index: 0.5, dur: 1.0, vol: 0.04 });
        break;
      }
      case 'advancement': {
        // a toast sliding in + a rising major arpeggio with shimmer
        this.nz(e, { dur: 0.35, vol: 0.06, type: 'bandpass', f: 700, f1: 3000, q: 1.2, attack: 0.2 });
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
          this.fm(e, { at: 0.12 + i * 0.1, f, ratio: 2, index: 0.9, dur: 1.4 - i * 0.1, vol: 0.09, idxDur: 0.3 }));
        this.fm(e, { at: 0.5, f: 2093, ratio: 3.5, index: 0.4, dur: 1.4, vol: 0.035 });
        this.duck(0.3, 0.8, 1.2);
        break;
      }
      case 'equip': {
        // armor on: a cloth rustle with a few chain-mail jingles
        this.nz(e, { dur: 0.22, vol: 0.4, color: 'pink', type: 'bandpass', f: 1400, q: 0.8, curve: this.grains(8, 0.5, 1.2, 0.2) });
        for (let i = 0; i < 4; i++) this.tn(e, { at: rand(0.02, 0.16), dur: rand(0.05, 0.12), f: rand(3200, 6000), vol: 0.03 });
        this.knock(e, 0.02, 220, 0.2, 0.08);
        break;
      }
      case 'doorOpen': {
        // latch click, then a rising hinge creak
        this.knock(e, 0, 520, 0.3, 0.05);
        this.creak(e, 0.03, rand(0.26, 0.34), rand(55, 70), rand(90, 120), 0.07);
        this.knock(e, 0.28, 240, 0.18, 0.1);
        break;
      }
      case 'doorClose': {
        // a short creak into a solid wooden clunk
        this.creak(e, 0, 0.14, rand(95, 110), rand(60, 75), 0.05);
        this.knock(e, 0.12, 190, 0.6, 0.16);
        this.nz(e, { at: 0.12, dur: 0.12, vol: 0.25, color: 'brown', type: 'lowpass', f: 300 });
        break;
      }
      case 'chestOpen': {
        // heavy lid: a slow low creak and a soft settle
        this.knock(e, 0, 300, 0.2, 0.06);
        this.creak(e, 0.02, rand(0.45, 0.55), rand(38, 45), rand(62, 72), 0.08, 0.8);
        this.nz(e, { at: 0.05, dur: 0.3, vol: 0.05, color: 'pink', type: 'bandpass', f: 600, q: 0.8, attack: 0.1 });
        break;
      }
      case 'chestClose': {
        this.creak(e, 0, 0.16, 70, 45, 0.05, 0.8);
        this.knock(e, 0.15, 150, 0.7, 0.18);
        this.nz(e, { at: 0.15, dur: 0.16, vol: 0.35, color: 'brown', type: 'lowpass', f: 260 });
        break;
      }
      case 'plateOn': {
        this.knock(e, 0, 340, 0.3, 0.06);
        this.nz(e, { dur: 0.04, vol: 0.14, color: 'pink', type: 'lowpass', f: 800 });
        break;
      }
      case 'plateOff': {
        this.knock(e, 0, 420, 0.22, 0.05);
        break;
      }
      case 'explode': {
        // crack → roaring body → sub thump → rolling debris tail, into the reverb
        this.nz(e, { dur: 0.06, vol: 0.9, type: 'highpass', f: 1200 });
        this.nz(e, { dur: 1.3, vol: 1.0, color: 'brown', type: 'lowpass', f: 1400, f1: 140, attack: 0.004 });
        this.tn(e, { dur: 0.9, f: 70, f1: 26, vol: 0.85 });
        this.nz(e, { at: 0.05, dur: 2.6, vol: 0.55, color: 'brown', type: 'lowpass', f: 320, f1: 90, curve: this.grains(10, 0.3, 1.3, 0.5) });
        this.nz(e, { at: 0.1, dur: 1.4, vol: 0.18, color: 'pink', type: 'bandpass', f: 1600, q: 0.8, curve: this.grains(26, 0.95, 1.4, 0.05) });
        this.duck(0.7, 0.6, 2.5);
        break;
      }
      case 'bow': {
        // string twang + arrow whoosh
        this.tn(e, { dur: 0.16, f: 190, f1: 165, vol: 0.2, type: 'triangle', lp: 1400 });
        this.tn(e, { dur: 0.08, f: 380, f1: 330, vol: 0.08, type: 'sawtooth', lp: 1800 });
        this.nz(e, { dur: 0.22, vol: 0.22, type: 'bandpass', f: 2800, f1: 700, q: 1.4, attack: 0.01 });
        break;
      }
      case 'arrowHit': {
        // thunk + the shaft quivering
        this.knock(e, 0, 260, 0.45, 0.08);
        const q = this.tn(e, { dur: 0.28, f: 180, vol: 0.08, type: 'triangle' });
        const ctx = this.ctx!;
        const l = ctx.createOscillator();
        l.frequency.value = 34;
        const lg = ctx.createGain();
        lg.gain.value = 60;
        l.connect(lg).connect(q.detune);
        e.nodes.push(lg);
        this.run(e, l, e.t, e.t + 0.3);
        break;
      }
      case 'snap': {
        // something breaks: a dry crack with splinters
        this.nz(e, { dur: 0.12, vol: 0.6, type: 'highpass', f: 1500, curve: this.grains(4, 0.95, 1.6) });
        this.tn(e, { dur: 0.05, f: 900, f1: 200, vol: 0.18, type: 'triangle' });
        this.tn(e, { dur: 0.07, f: 140, f1: 70, vol: 0.2 });
        break;
      }
      case 'fuse': {
        // a lit fuse: sizzling, spitting hiss
        this.nz(e, { dur: 0.05, vol: 0.3, type: 'bandpass', f: 3000, q: 1.2 });
        this.nz(e, { dur: 1.3, vol: 0.2, type: 'highpass', f: 3200, type2: 'lowpass', f2: 9000, curve: this.grains(45, 0.8, 1, 0.45) });
        this.nz(e, { dur: 1.3, vol: 0.06, type: 'bandpass', f: 6000, q: 2, attack: 0.1 });
        break;
      }
      case 'whoosh': {
        const p = rand(0.85, 1.2);
        this.nz(e, { dur: 0.2, vol: 0.13, type: 'bandpass', f: 700 * p, f1: 2400 * p, q: 1.6, attack: 0.07 });
        break;
      }
      case 'lowdur': {
        this.tn(e, { dur: 0.08, f: 880, f1: 760, vol: 0.09, type: 'square', lp: 2400 });
        this.tn(e, { at: 0.08, dur: 0.1, f: 660, f1: 520, vol: 0.08, type: 'square', lp: 2000 });
        break;
      }
      case 'thunder': {
        // a sharp crack, then a long rolling rumble that swells and recedes
        this.nz(e, { dur: 0.25, vol: 0.6, type: 'highpass', f: 900, curve: this.grains(8, 0.95, 2) });
        this.nz(e, { at: 0.05, dur: rand(4.5, 6.5), vol: 0.9, color: 'brown', type: 'lowpass', f: 420, f1: 120, curve: this.grains(7, 0.05, 1.1, 0.35) });
        this.tn(e, { at: 0.05, dur: 2.2, f: 55, f1: 30, vol: 0.4, attack: 0.08 });
        this.duck(0.55, 1.5, 3);
        break;
      }
      case 'splash': {
        this.nz(e, { dur: 0.45, vol: 0.4, type: 'bandpass', f: 1100, f1: 600, q: 0.7, attack: 0.015 });
        this.nz(e, { dur: 0.25, vol: 0.2, type: 'highpass', f: 3000, curve: this.grains(10, 0.8) });
        this.bubbles(e, 5, 0.3, 0.06);
        break;
      }
      case 'bubble': {
        this.bubbles(e, 1, 0, 0.07);
        break;
      }
      case 'submerge': {
        this.nz(e, { dur: 0.45, vol: 0.4, type: 'lowpass', f: 900, f1: 180 });
        this.tn(e, { dur: 0.35, f: 360, f1: 110, vol: 0.14 });
        this.bubbles(e, 6, 0.5, 0.05);
        break;
      }
      case 'emerge': {
        this.nz(e, { dur: 0.3, vol: 0.3, type: 'bandpass', f: 1400, f1: 2600, q: 0.8 });
        this.nz(e, { dur: 0.18, vol: 0.12, type: 'highpass', f: 3500, curve: this.grains(8, 0.8) });
        // a quick gasp of air
        this.nz(e, { at: 0.12, dur: 0.28, vol: 0.12, color: 'pink', type: 'bandpass', f: 1500, q: 1.5, attack: 0.08 });
        break;
      }
      case 'hoof': {
        const p = rand(0.9, 1.12);
        this.knock(e, 0, 480 * p, 0.35, 0.07);
        this.nz(e, { dur: 0.08, vol: 0.2, color: 'pink', type: 'lowpass', f: 700 * p, curve: this.grains(4, 0.8) });
        this.tn(e, { dur: 0.06, f: 110, f1: 60, vol: 0.18 });
        break;
      }
      case 'mount': {
        // saddle leather creak + a settle
        this.creak(e, 0, 0.3, 30, 45, 0.05, 0.6);
        this.nz(e, { dur: 0.15, vol: 0.18, color: 'pink', type: 'bandpass', f: 800, curve: this.grains(4, 0.4) });
        this.tn(e, { at: 0.2, dur: 0.1, f: 120, f1: 70, vol: 0.15 });
        break;
      }
      case 'lavaPop': {
        this.tn(e, { dur: 0.06, f: rand(180, 320), f1: rand(600, 900), glide: 0.03, vol: 0.12 });
        this.nz(e, { dur: 0.25, vol: 0.1, color: 'pink', type: 'bandpass', f: 2000, curve: this.grains(10, 0.9, 1.2) });
        break;
      }
      case 'rain': break;
    }
  }

  /** Short rising "bloop"s — bubbles breaking. */
  private bubbles(e: Ev, n: number, spread: number, vol: number): void {
    for (let i = 0; i < n; i++) {
      const f = rand(380, 900);
      this.tn(e, { at: Math.random() * spread, dur: rand(0.04, 0.08), f, f1: f * rand(1.6, 2.3), vol: vol * rand(0.5, 1), attack: 0.003 });
    }
  }

  // ==========================================================================
  // weather + underwater beds
  // ==========================================================================

  /** Pre-rendered rain texture: soft hiss plus thousands of tiny droplet ticks,
   *  wrapping seamlessly so it loops without a seam. Built once, on demand. */
  private makeRain(): AudioBuffer {
    const ctx = this.ctx!;
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * 3);
    const buf = ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.099;
        b1 = 0.963 * b1 + w * 0.2965;
        b2 = 0.57 * b2 + w * 1.0527;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.035;
      }
      for (let k = 0; k < 2400; k++) {
        const at = (Math.random() * len) | 0;
        const f = 1500 + Math.random() * 5000;
        const a = 0.04 + Math.pow(Math.random(), 3) * 0.45;
        const tau = (0.0005 + Math.random() * 0.0025) * sr;
        const n = Math.floor(tau * 5);
        const w = (2 * Math.PI * f) / sr;
        for (let j = 0; j < n; j++) d[(at + j) % len] += a * Math.sin(w * j) * Math.exp(-j / tau);
      }
    }
    return buf;
  }

  /** Drive the continuous rain bed. Call with kind='off' to stop. The bed is a
   *  looping pre-rendered rain texture that fades in/out smoothly. */
  setRain(kind: 'off' | 'rain' | 'thunder', intensity = 0.6): void {
    this.ensure();
    const ctx = this.ctx;
    if (!ctx || !this.amb) return;
    const k = clamp(intensity, 0, 1);
    if (kind === 'off') {
      const r = this.rain;
      if (r) {
        const t = ctx.currentTime;
        this.glide(r.g.gain, 0, 1.5);
        r.src.stop(t + 1.6);
        this.rain = null;
      }
      this.rainState = 'off';
      return;
    }
    if (!this.rain) {
      if (!this.rainBuf) this.rainBuf = this.makeRain();
      const src = ctx.createBufferSource();
      src.buffer = this.rainBuf;
      src.loop = true;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 350;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 6000;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(hp).connect(lp).connect(g).connect(this.amb);
      // a low roar layer for heavy downpours
      const roarSrc = ctx.createBufferSource();
      roarSrc.buffer = this.brown;
      roarSrc.loop = true;
      const rlp = ctx.createBiquadFilter();
      rlp.type = 'lowpass';
      rlp.frequency.value = 500;
      const roar = ctx.createGain();
      roar.gain.value = 0;
      roarSrc.connect(rlp).connect(roar).connect(g);
      const nodes: AudioNode[] = [hp, lp, g, rlp, roar, roarSrc];
      src.onended = () => {
        try { roarSrc.stop(); } catch { /* already */ }
        src.disconnect();
        for (const n of nodes) n.disconnect();
      };
      src.start(0, Math.random() * 3);
      roarSrc.start(0, Math.random() * 1.5);
      this.rain = { src, g, lp, roar, nodes };
    }
    this.rainState = kind;
    const r = this.rain;
    this.glide(r.g.gain, (kind === 'thunder' ? 0.5 : 0.36) * (0.35 + 0.65 * k), 1.2);
    this.glide(r.roar.gain, kind === 'thunder' ? 0.25 * k : 0.1 * k, 1.2);
    this.glide(r.lp.frequency, kind === 'thunder' ? 7500 : 5200 + 1800 * k, 1.2);
  }

  /** Muffle the whole mix and run a soft bubble bed while the head is submerged. */
  setUnderwater(on: boolean): void {
    this.ensure();
    const ctx = this.ctx;
    if (!ctx || !this.uwFilter || !this.amb) return;
    if (on === this.underwater) return;
    this.underwater = on;
    const t = ctx.currentTime;
    const f = this.uwFilter.frequency;
    f.cancelScheduledValues(t);
    f.setValueAtTime(f.value, t);
    f.exponentialRampToValueAtTime(on ? 600 : 20000, t + 0.45);
    if (on && !this.uw) {
      const src = ctx.createBufferSource();
      src.buffer = this.brown;
      src.loop = true;
      src.playbackRate.value = 0.6;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 420;
      lp.Q.value = 0.8;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(lp).connect(g).connect(this.amb);
      src.onended = () => { src.disconnect(); lp.disconnect(); g.disconnect(); };
      src.start();
      this.glide(g.gain, 0.22, 0.5);
      this.uw = { src, g, nodes: [lp] };
      this.bubbleT = 0.3;
    } else if (!on && this.uw) {
      this.glide(this.uw.g.gain, 0, 0.4);
      this.uw.src.stop(t + 0.5);
      this.uw = null;
    }
  }

  /** A short weather gesture; callers retrigger it every ~1-2 seconds. */
  weatherLoop(kind: 'rain' | 'thunder' | 'snow', intensity: number, isNight = false, sheltered = false): void {
    this.ensure();
    if (!this.ctx) return;
    const k = clamp(intensity, 0, 1);
    if (k <= 0.02) return;
    if (kind === 'snow') {
      // snowfall is near-silent: a hushed cold breeze now and then
      if (chance(0.45)) this.windGust(rand(2.5, 4), 0.07 * k, isNight);
      return;
    }
    this.setRain(kind, k * (sheltered ? 0.5 : 1));
  }

  private windGust(dur: number, vol: number, dark: boolean): void {
    const e = this.open('amb', vol, { pan: rand(-0.5, 0.5) });
    if (!e) return;
    this.nz(e, { dur, vol: 1, color: 'pink', type: 'bandpass', f: dark ? 320 : 480, f1: dark ? 200 : 300, q: 0.9, attack: dur * 0.45 });
    this.nz(e, { dur: dur * 0.8, vol: 0.4, type: 'bandpass', f: dark ? 900 : 1300, f1: 700, q: 3, attack: dur * 0.4 });
  }

  // ==========================================================================
  // mob voices
  // ==========================================================================

  /** Synthesized mob voices; vol already includes distance falloff. */
  mobSound(kind: string, vol: number, variant: MobVoice = 'idle', pan = 0): void {
    if (!this.ctx || vol <= 0.02) return;
    if (!this.gate(`mob:${kind}:${variant}`, variant === 'idle' ? 0.25 : 0.08)) return;
    const e = this.open('sfx', vol, { pan });
    if (!e) return;
    const hurt = variant === 'hurt';
    const death = variant === 'death';
    const p = rand(0.92, 1.08) * (hurt ? 1.15 : death ? 0.9 : 1);
    const dl = death ? 1.6 : hurt ? 0.6 : 1; // length scale
    switch (kind) {
      case 'pig': {
        if (hurt || death) {
          this.vox(e, {
            dur: 0.3 * dl, vol: 0.3, pitch: [300 * p, 440 * p, death ? 160 * p : 280 * p], attack: 0.01,
            formants: [[[700], 4, 1], [[1800], 6, 0.5]], rough: [40, 60], breath: 0.1,
          });
        } else {
          // two nasal grunts: "oink-oink"
          for (const [at, f] of [[0, 1], [0.2, 0.9]] as [number, number][]) {
            this.vox(e, {
              at, dur: 0.15, vol: 0.34, pitch: [150 * p * f, 180 * p * f, 125 * p * f], attack: 0.01, release: 0.06,
              formants: [[[480, 520], 4, 1], [[1350], 6, 0.6], [[2600], 8, 0.2]], rough: [34, 55], breath: 0.12,
            });
          }
        }
        break;
      }
      case 'cow': {
        // "mmm-ooo": a low buzz whose mouth opens then closes
        this.vox(e, {
          dur: (hurt ? 0.4 : rand(0.95, 1.3)) * (death ? 1.4 : 1), vol: 0.32,
          pitch: death ? [120 * p, 110 * p, 70 * p] : [104 * p, 118 * p, 112 * p, 90 * p], attack: 0.08,
          formants: [[[300, 650, 600, 380], 4, 1], [[750, 1050, 950], 5, 0.5], [[2400], 8, 0.12]],
          vib: [5, 14], breath: 0.06, direct: 0.35,
        });
        break;
      }
      case 'sheep': {
        // a bleat: "baa-aa" with a goat-like tremble
        this.vox(e, {
          dur: (hurt ? 0.3 : rand(0.5, 0.7)) * dl, vol: 0.26, pitch: [290 * p, 310 * p, 270 * p], attack: 0.03,
          formants: [[[650, 800, 780], 5, 1], [[1300, 1650], 6, 0.6], [[2600], 8, 0.2]],
          vib: [16, 70], breath: 0.1,
        });
        break;
      }
      case 'chicken': {
        if (hurt || death) {
          this.vox(e, { dur: 0.22 * dl, vol: 0.2, pitch: [1100 * p, 1500 * p, 900 * p], type: 'square', formants: [[[1400], 4, 1], [[3000], 6, 0.5]], rough: [50, 80], breath: 0.2 });
        } else {
          // "buk-buk-buk... bagawk"
          const n = 2 + ((Math.random() * 3) | 0);
          for (let i = 0; i < n; i++) {
            this.vox(e, { at: i * rand(0.1, 0.14), dur: 0.07, vol: 0.18, pitch: [680 * p, 820 * p, 640 * p], type: 'square', attack: 0.005, release: 0.03, formants: [[[1000], 4, 1], [[2600], 6, 0.4]] });
          }
          if (chance(0.5)) {
            this.vox(e, { at: n * 0.13 + 0.05, dur: 0.22, vol: 0.18, pitch: [760 * p, 1300 * p, 900 * p], type: 'square', attack: 0.01, formants: [[[1200, 1500], 4, 1], [[2800], 6, 0.4]], rough: [30, 30] });
          }
        }
        break;
      }
      case 'zombie': {
        // a rasping, hollow groan
        this.vox(e, {
          dur: (hurt ? 0.45 : rand(0.9, 1.3)) * (death ? 1.5 : 1), vol: 0.34,
          pitch: death ? [110 * p, 95 * p, 50 * p] : hurt ? [150 * p, 120 * p, 100 * p] : [92 * p, 108 * p, 96 * p, 80 * p],
          attack: 0.08, formants: [[[500, 420, 380], 5, 1], [[950, 800], 6, 0.55], [[2400], 8, 0.15]],
          vib: [5, 25], rough: [38, 90], breath: 0.3, direct: 0.3,
        });
        break;
      }
      case 'skeleton': {
        // bone rattle: a run of hollow clacks
        const n = death ? 14 : hurt ? 7 : 6 + ((Math.random() * 4) | 0);
        let at = 0;
        for (let i = 0; i < n; i++) {
          const f = rand(1100, 2200) * p * (death ? 1 - i / (n * 2) : 1);
          this.nz(e, { at, dur: 0.03, vol: 0.4, type: 'bandpass', f, q: 9 });
          this.tn(e, { at, dur: 0.035, f: f * 0.5, f1: f * 0.45, vol: 0.06, type: 'triangle' });
          at += rand(0.035, 0.07) * (death ? 1.3 : 1);
        }
        if (!hurt) this.nz(e, { at: 0.05, dur: 0.5, vol: 0.06, color: 'pink', type: 'bandpass', f: 1000, q: 1.5, attack: 0.15 });
        break;
      }
      case 'spider': {
        // a hissing chitter
        const d = (hurt ? 0.3 : 0.55) * dl;
        this.nz(e, { dur: d, vol: 0.3, type: 'bandpass', f: 3200 * p, q: 2.2, curve: this.grains(Math.round(d * 60), 0.95, 1, 0.3) });
        this.nz(e, { dur: d * 0.8, vol: 0.12, color: 'pink', type: 'bandpass', f: 1400 * p, q: 1.5, attack: 0.05 });
        if (hurt || death) this.vox(e, { dur: 0.25 * dl, vol: 0.12, pitch: [900 * p, 1400 * p, 700 * p], formants: [[[2400], 5, 1]], rough: [60, 90], breath: 0.3 });
        break;
      }
      case 'creeper': {
        // creepers are near-silent: a leafy rustle (and a crumble on hurt)
        this.nz(e, { dur: 0.3 * dl, vol: 0.3, type: 'bandpass', f: 2600 * p, q: 0.8, curve: this.grains(hurt || death ? 14 : 6, 0.8, 1.2) });
        if (hurt || death) this.nz(e, { dur: 0.35 * dl, vol: 0.2, type: 'highpass', f: 3000, attack: 0.02 });
        break;
      }
      case 'wolf': {
        if (hurt) {
          this.vox(e, { dur: 0.18, vol: 0.3, pitch: [900 * p, 1350 * p, 700 * p], type: 'sawtooth', attack: 0.005, formants: [[[1100], 4, 1], [[2400], 6, 0.5]], breath: 0.1 });
        } else if (death) {
          this.vox(e, { dur: 0.8, vol: 0.28, pitch: [1000 * p, 900 * p, 420 * p], type: 'triangle', formants: [[[1000, 700], 4, 1], [[2200], 6, 0.4]], vib: [6, 40] });
        } else {
          const r = Math.random();
          if (r < 0.55) {
            // one or two barks
            const n = chance(0.5) ? 2 : 1;
            for (let i = 0; i < n; i++) {
              this.vox(e, { at: i * 0.22, dur: 0.13, vol: 0.34, pitch: [380 * p, 540 * p, 300 * p], attack: 0.005, release: 0.06, formants: [[[900], 4, 1], [[1800], 5, 0.6]], rough: [40, 60], breath: 0.25 });
            }
          } else if (r < 0.82) {
            // panting
            for (let i = 0; i < 4; i++) this.nz(e, { at: i * 0.16, dur: 0.12, vol: 0.14, color: 'pink', type: 'bandpass', f: i % 2 ? 1300 : 1600, q: 1.2, attack: 0.03 });
          } else {
            // a soft whine
            this.vox(e, { dur: 0.55, vol: 0.18, pitch: [900 * p, 1300 * p, 1050 * p], type: 'triangle', formants: [[[1200], 3, 1]], vib: [6, 35] });
          }
        }
        break;
      }
      case 'villager': {
        // "hrmm", "hmm?" — nasal mumbles
        const n = hurt || death ? 1 : 1 + ((Math.random() * 3) | 0);
        let at = 0;
        for (let i = 0; i < n; i++) {
          const d = hurt ? 0.2 : death ? 0.7 : rand(0.18, 0.3);
          const f = 150 * p * rand(0.95, 1.1);
          const rise = !hurt && !death && i === n - 1 && chance(0.4);
          this.vox(e, {
            at, dur: d, vol: 0.3, pitch: death ? [f * 1.1, f, f * 0.6] : rise ? [f, f * 1.05, f * 1.35] : [f, f * 1.18, f * 0.9],
            attack: 0.02, formants: [[[280], 5, 1], [[1100, 900], 5, 0.35], [[2400], 7, 0.45]], vib: [7, 18], rough: [30, 25], direct: 0.4,
          });
          at += d + rand(0.03, 0.08);
        }
        break;
      }
      case 'phantom': {
        this.vox(e, {
          dur: (hurt ? 0.4 : 0.8) * dl, vol: 0.2, pitch: [900 * p, 1450 * p, 520 * p], attack: 0.05,
          formants: [[[1600, 1100], 3, 1], [[3000], 5, 0.4]], vib: [9, 80], rough: [45, 50], breath: 0.4,
        });
        break;
      }
      case 'horse': {
        if (!hurt && !death && chance(0.45)) {
          // a snort: breathy blast through the nose
          this.nz(e, { dur: 0.3, vol: 0.4, color: 'pink', type: 'bandpass', f: 900, f1: 600, q: 1.2, curve: this.grains(10, 0.5, 1, 0.5) });
          this.vox(e, { dur: 0.25, vol: 0.08, pitch: [90, 80], formants: [[[400], 4, 1]], rough: [45, 80] });
        } else {
          // a whinny: rising cry into a long, strongly-trembling fall
          this.vox(e, {
            dur: (hurt ? 0.35 : 0.9) * (death ? 1.5 : 1), vol: 0.24,
            pitch: [420 * p, 780 * p, 700 * p, death ? 260 * p : 380 * p], attack: 0.03,
            formants: [[[700, 900, 700], 5, 1], [[1600], 6, 0.5], [[2800], 8, 0.2]], vib: [9, 90], breath: 0.15,
          });
          if (!hurt) this.nz(e, { at: 0.9 * (death ? 1.5 : 1), dur: 0.25, vol: 0.2, color: 'pink', type: 'bandpass', f: 800, q: 1, attack: 0.02 });
        }
        break;
      }
      case 'cat': {
        if (!hurt && !death && chance(0.25)) {
          // purr: a low, amplitude-flickering rumble
          this.nz(e, { dur: 1.2, vol: 0.35, color: 'brown', type: 'lowpass', f: 500, curve: this.grains(30, 0.3, 1, 0.3) });
        } else if (hurt) {
          this.vox(e, { dur: 0.28, vol: 0.26, pitch: [700 * p, 900 * p, 600 * p], formants: [[[900, 1200], 4, 1], [[2600], 6, 0.5]], rough: [40, 40], breath: 0.2 });
        } else {
          // "mi-aow": the vowel sweeps i → a → u as the pitch rises and falls
          this.vox(e, {
            dur: (death ? 0.9 : rand(0.4, 0.6)), vol: 0.24, pitch: death ? [650 * p, 700 * p, 380 * p] : [540 * p, 720 * p, 480 * p], attack: 0.03,
            formants: [[[350, 850, 500], 4, 1], [[2200, 1300, 1000], 5, 0.6], [[3000], 8, 0.15]], vib: [6, 12],
          });
        }
        break;
      }
      case 'cinderling': {
        // a spitting ember hiss with a small shrill screech
        this.nz(e, { dur: 0.3 * dl, vol: 0.3, type: 'highpass', f: 2600, curve: this.grains(16, 0.9, 1.1, 0.3) });
        this.vox(e, { at: 0.04, dur: 0.22 * dl, vol: 0.16, pitch: [950 * p, 1350 * p, 800 * p], type: 'square', formants: [[[1800], 4, 1], [[3200], 6, 0.4]], rough: [50, 60] });
        break;
      }
      case 'ashstalker': {
        // a low molten growl with crackling on top
        this.vox(e, {
          dur: (hurt ? 0.4 : 0.75) * dl, vol: 0.34, pitch: [82 * p, 95 * p, 68 * p], attack: 0.05,
          formants: [[[450, 380], 5, 1], [[900], 6, 0.5], [[2200], 8, 0.15]], rough: [30, 110], breath: 0.25, direct: 0.35,
        });
        this.nz(e, { dur: 0.6 * dl, vol: 0.14, color: 'pink', type: 'bandpass', f: 1800, curve: this.grains(14, 0.9, 1) });
        break;
      }
      case 'emberghast': {
        // a far, childlike wail — the Nether's floating menace
        this.vox(e, {
          dur: (hurt ? 0.5 : 1.2) * dl, vol: 0.22, pitch: hurt ? [900 * p, 1200 * p, 800 * p] : [560 * p, 700 * p, 640 * p, 460 * p],
          type: 'triangle', attack: 0.12, formants: [[[500, 700, 450], 4, 1], [[1100, 900], 5, 0.5]], vib: [5.5, 40], breath: 0.15,
        });
        this.nz(e, { dur: 0.6, vol: 0.06, type: 'bandpass', f: 2200, q: 1.2, attack: 0.1 });
        break;
      }
    }
    this.seal(e);
  }

  // ==========================================================================
  // generative music + ambience
  // ==========================================================================

  /** Title-screen music on/off. The game switches it off when a world starts;
   *  in-game pieces then follow ambientTick's environment. */
  setMenuMusic(on: boolean): void {
    const want = on ? 'menu' : 'game';
    if (this.musicMode === want) return;
    this.musicMode = want;
    this.fadePiece(on ? 1.5 : 3);
    this.menuCount = 0;
    this.envAt = -99;
    if (this.ctx) this.nextPieceAt = this.ctx.currentTime + (on ? 1.2 : rand(10, 22));
    if (!on) this.fragT = rand(50, 90);
    if (on) { this.setRain('off'); this.setUnderwater(false); this.stopNetherBed(); }
  }

  /** Scheduler heartbeat (timer-driven so the title screen has music too):
   *  instantiates notes just ahead of the audio clock and starts new pieces. */
  private pump = (): void => {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    this.pumpMusic(ctx.currentTime, typeof document !== 'undefined' && document.hidden ? 2.5 : 0.9);
  };

  /** Schedule music up to `now + ahead`. Public for offline-render harnesses. */
  pumpMusic(now: number, ahead: number): void {
    const p = this.piece;
    if (p) {
      if (!p.fading) {
        const horizon = now + ahead;
        while (p.i < p.notes.length && p.t0 + p.notes[p.i].t < horizon) {
          const n = p.notes[p.i++];
          const at = p.t0 + n.t;
          if (at < now - 0.08) continue; // tab was throttled — drop, don't pile up
          this.note(n, Math.max(at, now + 0.01), p.out);
        }
      }
      if (now > p.end) {
        p.out.disconnect();
        this.piece = null;
        // a natural ending earns a silence; a deliberate fade keeps its own timing
        if (!p.fading) this.nextPieceAt = now + (this.musicMode === 'menu' ? rand(5, 10) : rand(35, 90));
      }
      return;
    }
    if (!this.settings.music || this.settings.musicVol <= 0) return;
    const live = this.musicMode === 'menu' || now - this.envAt < 4;
    if (live && now >= this.nextPieceAt) this.startPiece(now);
  }

  /** Begin a newly composed piece (optionally forcing a seed, for harnesses). */
  startPiece(now: number, seed?: number): string {
    const ctx = this.ctx;
    if (!ctx || !this.musicBus) return '';
    const menu = this.musicMode === 'menu';
    const s = seed ?? (menu && this.menuCount === 0 ? TITLE_SEED : (Math.random() * 2 ** 31) | 0);
    this.menuCount++;
    const env = menu ? 'menu' : this.env;
    const c = compose(env, menu ? undefined : this.biome, s);
    const out = ctx.createGain();
    out.gain.value = 1;
    out.connect(this.musicBus);
    if (this.delay) this.delay.delayTime.setTargetAtTime(clamp(c.beat * 0.75, 0.25, 1.2), now, 0.3);
    this.piece = {
      notes: c.notes, i: 0, t0: now + 0.2, end: now + 0.2 + c.len + 9, out,
      env: env === 'nether' ? 'nether' : 'other', fading: false, name: c.name,
    };
    return c.name;
  }

  private fadePiece(sec: number): void {
    const p = this.piece;
    if (!p || !this.ctx || p.fading) return;
    p.fading = true;
    this.glide(p.out.gain, 0, sec);
    p.end = this.ctx.currentTime + sec + 0.1;
  }

  /** Instantiate one scored note on its instrument. */
  private note(n: MNote, at: number, to: AudioNode): void {
    const f = mtof(n.m);
    const pan = n.p ?? clamp((n.m - 62) / 60, -0.3, 0.3);
    switch (n.i) {
      case 'piano': this.piano(at, f, n.v, n.d, to, pan); break;
      case 'epiano': this.epiano(at, f, n.v, n.d, to, pan); break;
      case 'bell': this.bell(at, f, n.v, n.d, to, pan, 3.5); break;
      case 'celesta': this.bell(at, f, n.v, n.d, to, pan, 4); break;
      case 'pad': this.pad(at, f, n.v, n.d, to); break;
      case 'bass': this.bass(at, f, n.v, n.d, to); break;
      case 'drone': this.drone(at, f, n.v, n.d, to); break;
    }
  }

  /** Felt piano: two slightly detuned strings (beating), a brightness filter
   *  that closes as the note rings, a prompt decay into a long aftersound, a
   *  damper release when the hold ends, and a faint hammer knock. */
  private piano(at: number, f: number, v: number, hold: number, to: AudioNode, pan: number): void {
    const e = this.open('music', 1, { at, to, pan });
    if (!e) return;
    const ctx = this.ctx!;
    const nat = clamp(7 * Math.pow(220 / f, 0.5), 1.2, 9); // lower strings ring longer
    const end = at + Math.min(nat, hold + 0.4);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.2;
    lp.frequency.setValueAtTime(Math.min(11000, f * (3 + 7 * v)), at);
    lp.frequency.exponentialRampToValueAtTime(Math.max(f * 1.4, 250), at + nat * 0.5);
    const g = ctx.createGain();
    const pk = 0.13 * v;
    const decayAt = (x: number): number => pk * 0.4 * Math.pow(0.03, clamp((x - at - 0.3) / (nat - 0.3), 0, 1));
    const tRel = Math.max(at + 0.32, end - 0.2);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(pk, at + 0.006);
    g.gain.exponentialRampToValueAtTime(pk * 0.4, at + 0.3);
    g.gain.exponentialRampToValueAtTime(Math.max(0.00005, decayAt(tRel)), tRel);
    g.gain.exponentialRampToValueAtTime(0.00003, Math.max(tRel + 0.05, end));
    lp.connect(g).connect(e.out);
    e.nodes.push(lp, g);
    for (const dt of [-1.6, 1.9]) {
      const o = ctx.createOscillator();
      o.setPeriodicWave(this.pianoWave!);
      o.frequency.value = f;
      o.detune.value = dt + rand(-0.5, 0.5);
      o.connect(lp);
      this.run(e, o, at, end + 0.05);
    }
    if (v > 0.25) this.nz(e, { at: at - e.t, dur: 0.018, vol: 0.02 * v, color: 'pink', type: 'bandpass', f: Math.min(4000, f * 3), q: 1 });
  }

  /** Rhodes-like electric piano: FM tine with a bell-ish attack. */
  private epiano(at: number, f: number, v: number, hold: number, to: AudioNode, pan: number): void {
    const e = this.open('music', 1, { at, to, pan });
    if (!e) return;
    const dur = Math.min(clamp(5 * Math.pow(220 / f, 0.4), 1, 6), hold + 0.6);
    this.fm(e, { f, ratio: 1, index: 0.9 + v, dur, vol: 0.1 * v, idxDur: 0.9 });
    this.fm(e, { f: f * 2, ratio: 7, index: 0.3, dur: Math.min(0.5, dur), vol: 0.018 * v, idxDur: 0.2 });
  }

  /** Bell / celesta: inharmonic FM with a long shimmering decay. */
  private bell(at: number, f: number, v: number, hold: number, to: AudioNode, pan: number, ratio: number): void {
    const e = this.open('music', 1, { at, to, pan });
    if (!e) return;
    const dur = ratio === 4 ? clamp(hold, 1.2, 2.2) : clamp(hold + 1.5, 2, 5);
    this.fm(e, { f, ratio, index: ratio === 4 ? 0.8 : 1.4, dur, vol: 0.075 * v, idxDur: 0.6 });
    this.tn(e, { at: 0, dur: dur * 0.7, f: f * 2.01, vol: 0.012 * v });
  }

  /** Warm pad: two detuned soft-saw voices spread left/right through a
   *  lowpass that breathes open and closed. Slow swell in, slow release. */
  private pad(at: number, f: number, v: number, dur: number, to: AudioNode): void {
    const e = this.open('music', 1, { at, to });
    if (!e) return;
    const ctx = this.ctx!;
    const a = Math.min(dur * 0.35, 2.4);
    const rel = Math.min(dur * 0.4, 3);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.5;
    lp.frequency.setValueAtTime(Math.min(1800, f * 2.5), at);
    lp.frequency.linearRampToValueAtTime(Math.min(3200, f * 4.5), at + dur * 0.5);
    lp.frequency.linearRampToValueAtTime(Math.min(1500, f * 2), at + dur + rel);
    const g = ctx.createGain();
    const pk = 0.045 * v;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(pk, at + a);
    g.gain.setValueAtTime(pk, at + dur);
    g.gain.linearRampToValueAtTime(0.0001, at + dur + rel);
    lp.connect(g).connect(e.out);
    e.nodes.push(lp, g);
    for (const [det, side] of [[-7, -0.45], [7, 0.45]]) {
      const o = ctx.createOscillator();
      o.setPeriodicWave(this.padWave!);
      o.frequency.value = f;
      o.detune.setValueAtTime(det, at);
      o.detune.linearRampToValueAtTime(det * -0.4, at + dur + rel); // slow chorus drift
      const pn = ctx.createStereoPanner();
      pn.pan.value = side;
      o.connect(pn).connect(lp);
      e.nodes.push(pn);
      this.run(e, o, at, at + dur + rel + 0.05);
    }
  }

  /** Round sub bass under the ambient pieces. */
  private bass(at: number, f: number, v: number, dur: number, to: AudioNode): void {
    const e = this.open('music', 1, { at, to });
    if (!e) return;
    const ctx = this.ctx!;
    const g = ctx.createGain();
    const pk = 0.12 * v;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(pk, at + 0.25);
    g.gain.exponentialRampToValueAtTime(pk * 0.4, at + dur * 0.6);
    g.gain.linearRampToValueAtTime(0.0001, at + dur + 1);
    g.connect(e.out);
    e.nodes.push(g);
    const o = ctx.createOscillator();
    o.frequency.value = f;
    o.connect(g);
    const o2 = ctx.createOscillator();
    o2.type = 'triangle';
    o2.frequency.value = f * 2;
    const g2 = ctx.createGain();
    g2.gain.value = 0.18;
    o2.connect(g2).connect(g);
    e.nodes.push(g2);
    this.run(e, o, at, at + dur + 1.05);
    this.run(e, o2, at, at + dur + 1.05);
  }

  /** Long, slowly-breathing drone (root + fifth) for caves and the Nether. */
  private drone(at: number, f: number, v: number, dur: number, to: AudioNode): void {
    const e = this.open('music', 1, { at, to });
    if (!e) return;
    const ctx = this.ctx!;
    const g = ctx.createGain();
    const pk = 0.07 * v;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(pk, at + 4);
    g.gain.setValueAtTime(pk, at + Math.max(4, dur - 4));
    g.gain.linearRampToValueAtTime(0.0001, at + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.min(900, f * 5);
    lp.connect(g).connect(e.out);
    e.nodes.push(g, lp);
    // a very slow tremolo keeps it alive
    const lfo = ctx.createOscillator();
    lfo.frequency.value = rand(0.07, 0.13);
    const lg = ctx.createGain();
    lg.gain.value = pk * 0.35;
    lfo.connect(lg).connect(g.gain);
    e.nodes.push(lg);
    this.run(e, lfo, at, at + dur + 0.05);
    for (const [m, type, det] of [[1, 'triangle', -4], [1.5, 'sine', 3], [2, 'sawtooth', 6]] as [number, OscillatorType, number][]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f * m;
      o.detune.value = det;
      const og = ctx.createGain();
      og.gain.value = type === 'sawtooth' ? 0.12 : 0.6;
      o.connect(og).connect(lp);
      e.nodes.push(og);
      this.run(e, o, at, at + dur + 0.05);
    }
  }

  /** Call every frame; env + biome pick the mood of music and ambience. */
  ambientTick(dt: number, env: AmbientEnv = 'day', biome?: MusicBiome): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    if (this.musicMode === 'menu') this.setMenuMusic(false); // a world is running
    // crossing into/out of the Nether fades the current piece
    const cls = env === 'nether' ? 'nether' : 'other';
    if (this.piece && !this.piece.fading && this.piece.env !== cls) {
      this.fadePiece(4);
      this.nextPieceAt = now + rand(8, 16);
    }
    if (env !== this.env && this.sfxVerb) {
      // footsteps and digging echo underground
      this.glide(this.sfxVerb.gain, env === 'cave' ? 0.34 : env === 'nether' ? 0.2 : 0.035, 2);
    }
    this.env = env;
    this.biome = biome;
    this.envAt = now;
    this.pump();

    // Nether: a constant low rumble bed
    if (env === 'nether') this.startNetherBed(); else this.stopNetherBed();

    if (!this.settings.sound) return;
    // environment ambience: birdsong by day, crickets and owls at night, dread
    // underground, lava and far wails in the Nether
    this.atmosphereT -= dt;
    if (this.atmosphereT <= 0) {
      this.atmosphereCue(env, biome);
      this.atmosphereT = (env === 'cave' ? 9 : env === 'day' ? 7 : env === 'nether' ? 5 : 9) + Math.random() * 16;
    }
    // a short musical fragment now and then in the long gaps between pieces
    this.fragT -= dt;
    if (this.fragT <= 0) {
      this.fragT = rand(45, 100);
      if (!this.piece && this.settings.music && this.nextPieceAt - now > 20) this.playFragment(env);
    }
    if (this.underwater) {
      this.bubbleT -= dt;
      if (this.bubbleT <= 0) {
        this.bubbleT = rand(0.4, 2.2);
        const e = this.open('amb', 0.8, { pan: rand(-0.6, 0.6) });
        if (e) { this.bubbles(e, 1 + ((Math.random() * 3) | 0), 0.3, 0.05); this.seal(e); }
      }
    }
  }

  private playFragment(env: AmbientEnv): void {
    const ctx = this.ctx;
    if (!ctx || !this.musicBus) return;
    const c = fragment(env, (Math.random() * 2 ** 31) | 0);
    const t0 = ctx.currentTime + 0.1;
    for (const n of c.notes) this.note(n, t0 + n.t, this.musicBus);
  }

  private startNetherBed(): void {
    const ctx = this.ctx;
    if (this.netherBed || !ctx || !this.amb) return;
    const src = ctx.createBufferSource();
    src.buffer = this.brown;
    src.loop = true;
    src.playbackRate.value = 0.5;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 160;
    lp.Q.value = 2;
    const g = ctx.createGain();
    g.gain.value = 0;
    // slow swells, like a furnace breathing
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.09;
    const lg = ctx.createGain();
    lg.gain.value = 0.1;
    lfo.connect(lg).connect(g.gain);
    src.connect(lp).connect(g).connect(this.amb);
    src.onended = () => { try { lfo.stop(); } catch { /* already */ } for (const n of [src, lp, g, lfo, lg]) n.disconnect(); };
    src.start(0, Math.random());
    lfo.start();
    this.glide(g.gain, 0.3, 3);
    this.netherBed = { src, g, nodes: [lp, lfo, lg] };
  }

  private stopNetherBed(): void {
    const b = this.netherBed;
    if (!b || !this.ctx) return;
    this.glide(b.g.gain, 0, 2);
    b.src.stop(this.ctx.currentTime + 2.1);
    this.netherBed = null;
  }

  /** A soft heartbeat that emerges and quickens as health drops — survival
   *  tension. hpFrac is health/maxHealth; silent above 30%. Call every frame. */
  heartbeatTick(dt: number, hpFrac: number): void {
    if (!this.ctx || !this.settings.sound) { this.heartT = 0; return; }
    if (hpFrac <= 0 || hpFrac > 0.3) { this.heartT = 0; return; }
    const k = 1 - hpFrac / 0.3; // 0 at 30% hp, 1 near death
    this.heartT -= dt;
    if (this.heartT > 0) return;
    this.heartT = 1.0 - k * 0.45; // ~1.0s → ~0.55s as it worsens
    const e = this.open('sfx', 0.5 + k * 0.8);
    if (!e) return;
    for (const [at, v] of [[0, 1], [0.16, 0.7]]) {
      this.tn(e, { at, dur: 0.12, f: 70, f1: 42, vol: 0.2 * v, attack: 0.01 });
      this.nz(e, { at, dur: 0.08, vol: 0.12 * v, color: 'brown', type: 'lowpass', f: 180 });
    }
    this.seal(e);
  }

  /** One ambient gesture flavoured by environment and biome. */
  private atmosphereCue(env: AmbientEnv, biome?: MusicBiome): void {
    const r = Math.random();
    if (env === 'cave') { this.caveCue(); return; }
    if (env === 'nether') { this.netherCue(); return; }
    if (env === 'night') {
      if (biome === 'snow' || biome === 'taiga') { this.windGust(rand(3, 5), 0.07, true); return; }
      if (biome === 'swamp' && r < 0.5) { this.frogCroak(); return; }
      if (r < 0.45) this.crickets();
      else if (r < 0.65) this.owlHoot();
      else this.windGust(rand(3, 5), 0.05, true);
      return;
    }
    // day: a living world, tinted by the terrain you're standing in
    switch (biome) {
      case 'snow': case 'taiga':
        if (r < 0.65) this.windGust(rand(3, 5), 0.06, false);
        else this.birdChirp('tit');
        return;
      case 'desert':
        if (r < 0.75) this.windGust(rand(3, 6), 0.06, false);
        else this.insectBuzz();
        return;
      case 'jungle':
        if (r < 0.35) this.birdChirp('warble');
        else if (r < 0.6) { this.birdChirp('trill'); this.birdChirp('tit', 0.4); }
        else if (r < 0.8) this.birdChirp('tit');
        else this.insectBuzz();
        return;
      case 'swamp':
        if (r < 0.5) this.frogCroak();
        else if (r < 0.8) this.insectBuzz();
        else this.windGust(3, 0.04, true);
        return;
      case 'mountains':
        if (r < 0.55) this.windGust(rand(3, 6), 0.065, false);
        else this.birdChirp(r < 0.8 ? 'tit' : 'warble');
        return;
    }
    if (r < 0.4) this.birdChirp('warble');
    else if (r < 0.62) this.birdChirp('tit');
    else if (r < 0.78) this.birdChirp('trill');
    else if (r < 0.9) this.insectBuzz();
    else this.windGust(rand(3, 5), 0.045, false);
  }

  /** Birdsong: a warbling phrase, a two-note "fee-bee" whistle, or a trill. */
  private birdChirp(kind: 'warble' | 'tit' | 'trill', at = 0): void {
    const e = this.open('amb', rand(0.5, 1), { pan: rand(-0.8, 0.8) });
    if (!e) return;
    e.t += at;
    if (kind === 'tit') {
      const f = rand(3000, 3800);
      const reps = 1 + ((Math.random() * 2) | 0);
      for (let r = 0; r < reps; r++) {
        this.tn(e, { at: r * 0.55, dur: 0.22, f, f1: f * 0.97, vol: 0.05, attack: 0.02 });
        this.tn(e, { at: r * 0.55 + 0.26, dur: 0.2, f: f * 0.84, f1: f * 0.82, vol: 0.045, attack: 0.02 });
      }
    } else if (kind === 'trill') {
      const f = rand(3800, 5000);
      const n = 8 + ((Math.random() * 8) | 0);
      for (let i = 0; i < n; i++) this.tn(e, { at: i * 0.045, dur: 0.035, f: f * (1 - i * 0.008), f1: f * 0.85, vol: 0.035, attack: 0.004 });
    } else {
      const n = 3 + ((Math.random() * 5) | 0);
      let at2 = 0;
      let base = rand(2200, 3300);
      for (let i = 0; i < n; i++) {
        const f = base * rand(0.85, 1.25);
        this.tn(e, { at: at2, dur: rand(0.05, 0.12), f, f1: f * rand(0.75, 1.35), vol: 0.045, attack: 0.006 });
        at2 += rand(0.07, 0.16);
        base *= rand(0.95, 1.03);
      }
    }
    this.seal(e);
  }

  /** Night crickets: pulse groups ("chirp-chirp-chirp") from a couple of spots. */
  private crickets(): void {
    const e = this.open('amb', 1, { pan: rand(-0.7, 0.7) });
    if (!e) return;
    const f = rand(4200, 4900);
    const groups = 3 + ((Math.random() * 4) | 0);
    const gap = rand(0.35, 0.55);
    for (let g = 0; g < groups; g++) {
      for (let k = 0; k < 3; k++) this.tn(e, { at: g * gap + k * 0.035, dur: 0.028, f, vol: 0.018, attack: 0.004 });
    }
    this.seal(e);
  }

  /** A warm daytime insect buzz with a wing-beat flutter. */
  private insectBuzz(): void {
    const e = this.open('amb', 1, { pan: rand(-0.8, 0.8) });
    if (!e) return;
    const dur = rand(0.8, 1.6);
    this.vox(e, { dur, vol: 0.012, pitch: [rand(180, 240), rand(200, 260), rand(170, 230)], type: 'sawtooth', attack: dur * 0.3, release: dur * 0.4, formants: [[[2400], 3, 1], [[4200], 4, 0.5]], vib: [rand(3, 6), 60] });
    this.seal(e);
  }

  /** A soft two-note owl hoot, low with gentle vibrato. */
  private owlHoot(): void {
    const e = this.open('amb', 1, { pan: rand(-0.7, 0.7) });
    if (!e) return;
    const f = rand(340, 400);
    this.vox(e, { dur: 0.35, vol: 0.05, pitch: [f, f * 1.03, f * 0.96], type: 'triangle', attack: 0.06, formants: [[[f * 1.2], 2, 1]], vib: [6, 10], direct: 1 });
    this.vox(e, { at: 0.5, dur: 0.5, vol: 0.045, pitch: [f * 0.98, f, f * 0.9], type: 'triangle', attack: 0.08, formants: [[[f * 1.2], 2, 1]], vib: [6, 10], direct: 1 });
    this.seal(e);
  }

  /** A low throaty frog croak — two quick rasps. */
  private frogCroak(): void {
    const e = this.open('amb', 1, { pan: rand(-0.7, 0.7) });
    if (!e) return;
    const f = rand(95, 140);
    for (const at of [0, 0.2]) {
      this.vox(e, { at, dur: 0.14, vol: 0.08, pitch: [f, f * 0.85], attack: 0.01, formants: [[[600], 4, 1], [[1400], 5, 0.4]], rough: [25, 120], direct: 0.4 });
    }
    this.seal(e);
  }

  /** Underground dread: moans, reversed swells, echoing drips, far rockfalls
   *  and the occasional unseen footsteps. */
  private caveCue(): void {
    const r = Math.random();
    const e = this.open('amb', 1, { pan: rand(-0.8, 0.8) });
    if (!e) return;
    if (r < 0.25) {
      // a low, slowly-wavering moan — the classic cave unease
      const dur = rand(2.6, 4.6);
      const b = rand(58, 100);
      this.vox(e, { dur, vol: 0.12, pitch: [b, b * 1.07, b * 0.94], type: 'sawtooth', attack: dur * 0.4, release: dur * 0.5, formants: [[[380, 300], 3, 1], [[700], 4, 0.3]], vib: [0.7, 30], breath: 0.1 });
    } else if (r < 0.45) {
      // a reversed swell that stops dead
      const dur = rand(1.5, 2.6);
      this.nz(e, { dur, vol: 0.14, color: 'pink', type: 'bandpass', f: 300, f1: 1800, q: 1.5, attack: dur - 0.02 });
      this.tn(e, { dur, f: rand(180, 260), f1: rand(300, 420), vol: 0.03, type: 'triangle', attack: dur - 0.02 });
    } else if (r < 0.7) {
      // a lone drip, echoing into the reverb
      const f = rand(1400, 2200);
      this.tn(e, { dur: 0.08, f: f * 0.7, f1: f, glide: 0.02, vol: 0.06 });
      this.tn(e, { at: rand(0.3, 0.9), dur: 0.07, f: f * 0.8, f1: f * 1.1, glide: 0.02, vol: 0.03 });
    } else if (r < 0.87) {
      // distant rockfall rumble with a trickle of pebbles
      this.nz(e, { dur: rand(1.4, 2.4), vol: 0.35, color: 'brown', type: 'lowpass', f: 200, f1: 60, curve: this.grains(8, 0.3, 1.2, 0.4) });
      this.nz(e, { at: 0.3, dur: 1, vol: 0.06, color: 'pink', type: 'bandpass', f: 1500, curve: this.grains(10, 0.95) });
    } else {
      // footsteps somewhere in the dark
      for (let i = 0; i < 3; i++) {
        this.nz(e, { at: i * rand(0.45, 0.55), dur: 0.14, vol: 0.12, color: 'pink', type: 'bandpass', f: 1100, q: 0.8, curve: this.grains(6, 0.9, 1.3) });
      }
    }
    this.seal(e);
  }

  /** Nether ambience: lava pops, a far roar, or a ghostly wail. */
  private netherCue(): void {
    const r = Math.random();
    if (r < 0.45) {
      const e = this.open('amb', rand(0.4, 0.9), { pan: rand(-0.8, 0.8) });
      if (!e) return;
      const n = 1 + ((Math.random() * 3) | 0);
      for (let i = 0; i < n; i++) {
        this.tn(e, { at: i * rand(0.1, 0.3), dur: 0.06, f: rand(160, 300), f1: rand(500, 900), glide: 0.03, vol: 0.1 });
        this.nz(e, { at: i * 0.2, dur: 0.3, vol: 0.08, color: 'pink', type: 'bandpass', f: 1800, curve: this.grains(8, 0.9, 1.2) });
      }
      this.seal(e);
    } else if (r < 0.75) {
      const e = this.open('amb', 1, { pan: rand(-0.6, 0.6) });
      if (!e) return;
      const dur = rand(2.5, 4);
      this.nz(e, { dur, vol: 0.3, color: 'brown', type: 'lowpass', f: 260, f1: 90, attack: dur * 0.35 });
      this.tn(e, { dur, f: rand(40, 55), f1: rand(32, 40), vol: 0.1, attack: dur * 0.3 });
      this.seal(e);
    } else {
      this.mobSound('emberghast', rand(0.12, 0.25), 'idle', rand(-0.8, 0.8));
    }
  }
}
