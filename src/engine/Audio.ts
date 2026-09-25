// Web Audio synthesis — every footstep, creak, mob voice and note of music is
// generated in code (no audio assets).
//
//   sfx events ───► sfxBus ─► comp ──┐          (+ cave echo sized to the room)
//   ambience ─────► ambBus ──────────┼─► master ─► underwater LP ─► limiter ─► out
//   beds (wind, rain…) ─► ambBus     │     ▲
//   music notes ─► piece ─► musicBus ─► duck ─┘   (combat layer + stingers too)
//             (sends from all three) ─► reverb ────────┘   (+ tempo delay on music)
//
// Continuous ambience "beds" (wind, leaves, surf, streams, rain, snow, fire…)
// are driven by listen(), which probes the world around the player a few
// times a second (AudioScape.ts) and glides each bed toward its level/pan.
//
// Every sound is a short-lived "event": one gain node plus its sources and
// filters. The chain disconnects itself when its last source ends, and each
// bus has a voice cap so a TNT chain or a mob crowd can't swamp the CPU.

import { SoundClass, def, hasDef } from './Blocks';
import { compose, fragment, stinger, mtof, MNote, TITLE_SEED, MusicEnv, MusicBiomeKey, StingerKind } from './AudioMusic';
import { probeScape, Scape, ScapeWorld, ScapePlayer, ScapeMob, ScapeWeather } from './AudioScape';

export type SfxName =
  | 'pop' | 'hurt' | 'hit' | 'eat' | 'burp' | 'click' | 'select' | 'fail' | 'craft' | 'level'
  | 'doorOpen' | 'doorClose' | 'plateOn' | 'plateOff'
  | 'explode' | 'bow' | 'snap' | 'fuse' | 'arrowHit' | 'whoosh' | 'lowdur'
  | 'thunder' | 'rain' | 'splash' | 'hoof' | 'mount'
  | 'submerge' | 'emerge'
  | 'chestOpen' | 'chestClose' | 'advancement' | 'equip' | 'lavaPop' | 'bubble'
  | 'jump' | 'death' | 'drink' | 'ignite' | 'bell' | 'crackle'
  | 'orbThrow' | 'orbOpen' | 'orbWobble' | 'orbClick' | 'orbRelease' | 'orbRecall';

/** Footstep gait: sprinting lands harder and brighter, sneaking barely scuffs. */
export type Gait = 'walk' | 'sprint' | 'sneak';

/** Ambient mood selector for ambientTick. */
export type AmbientEnv = 'day' | 'night' | 'cave' | 'nether';

/** Overworld biome flavour for the generative music (key/tempo/colour shifts). */
export type MusicBiome = MusicBiomeKey;

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

interface Piece { notes: MNote[]; i: number; t0: number; end: number; out: GainNode; env: string; fading: boolean; name: string; tonic: number; minor: boolean }
/** A continuous ambience loop: sources → (own filters) → lp → gain → pan → amb bus. */
interface Bed { srcs: AudioScheduledSourceNode[]; g: GainNode; pan: StereoPannerNode; lp: BiquadFilterNode; nodes: AudioNode[]; x: Record<string, AudioNode>; quiet: number } // quiet = ctx time it fell silent (0 = playing)
/** How rain is heard: out in it, under a canopy, under a roof, or deep inside. */
type Shelter = 'open' | 'leaves' | 'roof' | 'deep';

const SETTINGS_KEY = 'voxelcraft-audio';
const CAP: Record<Pool, number> = { sfx: 36, amb: 20, music: 80 };

// per-sound loudness trims, balanced against each other by offline renders
const SFX_GAIN: Partial<Record<SfxName, number>> = {
  pop: 4.5, hit: 1.7, click: 3.5, select: 5, fail: 0.7, plateOn: 1.4, plateOff: 1.4, bow: 1.9,
  snap: 1.8, arrowHit: 1.8, hoof: 1.2, doorOpen: 0.6, doorClose: 0.4, chestClose: 0.35, mount: 0.35,
  submerge: 1.6, emerge: 1.6, splash: 0.6, whoosh: 0.6, lavaPop: 3, bubble: 5, hurt: 1.6,
  thunder: 0.8, jump: 0.8, drink: 1.4, ignite: 1.2, bell: 0.9, crackle: 1.6,
};
// material trims: [break/hit, step] — evens out how loud each texture reads
const MAT_GAIN: Record<Mat, [number, number]> = {
  stone: [0.9, 1.7], wood: [1.25, 1.6], grass: [0.56, 0.9], plant: [1, 1], gravel: [1, 1],
  sand: [0.4, 0.63], soul: [0.45, 0.63], snow: [1.4, 1.25], wool: [1, 1.4], metal: [0.8, 1.4],
  glass: [0.5, 1.7], nether: [0.8, 1], amethyst: [0.56, 1.25], none: [0, 0],
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
  private harpWave: PeriodicWave | null = null;
  private fluteWave: PeriodicWave | null = null;
  private ocarinaWave: PeriodicWave | null = null;
  private combatBus: GainNode | null = null;
  private echo: { d: DelayNode; fb: GainNode; wet: GainNode } | null = null;
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
  private rainState: 'off' | 'rain' | 'thunder' = 'off';
  private patterT = 0;
  private snowK = 0;           // current snowfall level (0 = none)
  private blizzardK = 0;       // how hard the blizzard wind howls (0..1)
  private shimmerT = 1;
  private beds = new Map<string, Bed>();
  // soundscape probe + the state that reacts to it
  private scape: Scape | null = null;
  private scapeT = 0;
  private gust = 0.5;          // shared wind-gust signal (random walk), drives wind + leaves
  private gustTo = 0.5;
  private windPan = 0;
  private waveT = 2;
  private fireT = 0.5;
  private villageT = 8;
  private threat = 0;          // smoothed chase intensity → combat music layer
  private combatNext = 0;
  private combatBar = 0;
  private combatOn = false;
  private musicCtx = 'surface'; // surface | cave | nether | underwater: crossing one crossfades
  private dayPart: 'day' | 'night' | '' = '';
  private seenVillageAt = -999;
  private peakLatch = false;
  private surfaceSince = 0;
  private old: Piece[] = [];   // pieces fading out under a crossfade
  private uw: { src: AudioBufferSourceNode; g: GainNode; nodes: AudioNode[] } | null = null;
  private underwater = false;
  private netherBed: { src: AudioBufferSourceNode; g: GainNode; nodes: AudioNode[] } | null = null;
  private unlocked = false;
  private resuming = false;
  private level = 1;           // loudness of the effect being built (scales ducking)

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
      // cave echo: a darkened slapback whose delay follows the size of the
      // space (silent above ground)
      const ed = ctx.createDelay(1.0);
      ed.delayTime.value = 0.18;
      const efb = ctx.createGain();
      efb.gain.value = 0.3;
      const elp = ctx.createBiquadFilter();
      elp.type = 'lowpass';
      elp.frequency.value = 2200;
      const ewet = ctx.createGain();
      ewet.gain.value = 0;
      this.sfx.connect(ed);
      ed.connect(elp).connect(efb).connect(ed);
      elp.connect(ewet).connect(this.master);
      this.echo = { d: ed, fb: efb, wet: ewet };

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
      // combat layer: its own gain under the music bus, raised by threat
      this.combatBus = ctx.createGain();
      this.combatBus.gain.value = 0;
      this.combatBus.connect(this.musicBus);
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
      this.fx = [limiter, reverb, verbOut, comp, ambVerb, musicVerb, fb, fbLp, delayWet, elp];

      // shared noise sources: generated once, played from random offsets
      this.white = this.makeNoise('white');
      this.pink = this.makeNoise('pink');
      this.brown = this.makeNoise('brown');
      this.pianoWave = this.makeWave([1, 0.42, 0.26, 0.19, 0.1, 0.07, 0.055, 0.03, 0.022, 0.012, 0.008]);
      this.padWave = this.makeWave([1, 0.5, 0.33, 0.22, 0.14, 0.09, 0.06, 0.04]);
      this.harpWave = this.makeWave([1, 0.55, 0.24, 0.16, 0.07, 0.05, 0.02]);
      this.fluteWave = this.makeWave([1, 0.32, 0.12, 0.05, 0.02]);
      this.ocarinaWave = this.makeWave([1, 0.04, 0.07, 0.01]);

      if (typeof window !== 'undefined' && ctx instanceof AudioContext) {
        this.pumpTimer = window.setInterval(this.pump, 120);
        // build the rain texture ahead of time, off the critical path
        window.setTimeout(() => { if (!this.rainBuf && this.ctx) this.rainBuf = this.makeRain(); }, 4000);
      }
      this.nextPieceAt = ctx.currentTime + (this.musicMode === 'menu' ? 0.6 : 6);
      return true;
    } catch {
      this.ctx = null;
      return false;
    }
  }

  /** Voice / scheduler counters (for harnesses and debugging). */
  debugStats(): { live: Record<Pool, number>; peak: Record<Pool, number>; piece: string | null; rain: string; nether: boolean; beds: Record<string, number>; threat: number; fading: number } {
    const beds: Record<string, number> = {};
    for (const [k, b] of this.beds) beds[k] = +b.g.gain.value.toFixed(4);
    return {
      live: { ...this.live }, peak: { ...this.livePeak }, piece: this.piece?.name ?? null, rain: this.rainState,
      nether: !!this.netherBed, beds, threat: +this.threat.toFixed(2), fading: this.old.length,
    };
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
      if (n.endsWith('_wool') || n === 'cactus' || n.startsWith('bed') || n === 'cake') return 'wool';
      if (n === 'snow_block') return 'snow';
      if (n === 'clay') return 'gravel';
      if (n === 'ice' || n === 'packed_ice' || n === 'glass_pane') return 'glass';
      if (n === 'anvil' || n === 'lantern') return 'metal';
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

  /** Footstep on a block; sprinting steps land harder, sneaking ones barely scuff. */
  step(cls: SoundClass, id?: number, gait: Gait = 'walk'): void {
    if (!this.gate('step', 0.06)) return;
    this.ensure();
    const m = this.matFor(cls, id);
    const vol = gait === 'sprint' ? 0.22 : gait === 'sneak' ? 0.075 : 0.16;
    const p = gait === 'sprint' ? rand(0.98, 1.16) : gait === 'sneak' ? rand(0.84, 0.96) : rand(0.9, 1.1);
    this.material(m === 'none' ? 'stone' : m, 'step', vol, p);
    // a sprinting foot also scuffs: a short swish of the material's grit
    if (gait === 'sprint' && m !== 'none' && chance(0.6)) {
      const e = this.open('sfx', 0.05 * MAT_GAIN[m][1], { pan: rand(-0.1, 0.1) });
      if (e) {
        this.nz(e, { at: 0.03, dur: 0.1, vol: 1, color: 'pink', type: 'bandpass', f: rand(1400, 2400), q: 0.8, attack: 0.02 });
        this.seal(e);
      }
    }
  }

  /** Landing from a fall: a heavy footstep on the material plus a body thump
   *  that deepens with the height fallen. */
  land(cls: SoundClass, id: number | undefined, fall: number): void {
    this.ensure();
    if (!this.ctx) return;
    const m = this.matFor(cls, id);
    const k = clamp((fall - 1.5) / 10, 0, 1);
    this.material(m === 'none' ? 'stone' : m, 'step', 0.22 + 0.2 * k, rand(0.82, 0.92));
    const e = this.open('sfx', 0.35 + 0.65 * k);
    if (!e) return;
    this.tn(e, { dur: 0.16 + 0.1 * k, f: 95, f1: 42, vol: 0.4 });
    this.nz(e, { dur: 0.12, vol: 0.25, color: 'brown', type: 'lowpass', f: 380 });
    // a sharp exhale on a hard landing
    if (k > 0.25) this.nz(e, { at: 0.04, dur: 0.18, vol: 0.06 * k, color: 'pink', type: 'bandpass', f: 1300, q: 1.4, attack: 0.03 });
    this.seal(e);
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

  /** Play a named effect; vol (0..1) scales it, e.g. for distance. */
  play(name: SfxName, vol = 1): void {
    this.ensure();
    if (!this.ctx) return;
    const gaps: Partial<Record<SfxName, number>> = {
      pop: 0.035, select: 0.03, click: 0.025, hit: 0.04, eat: 0.07, splash: 0.08, arrowHit: 0.03,
      hoof: 0.05, fuse: 0.12, bubble: 0.03, lavaPop: 0.05, fail: 0.08, level: 0.1,
    };
    const g = gaps[name];
    if (g !== undefined && !this.gate(name, g)) return;
    if (name === 'rain') { this.setRain('rain', 0.5); return; }
    const e = this.open('sfx', (SFX_GAIN[name] ?? 1) * clamp(vol, 0, 1.5));
    if (!e) return;
    this.level = clamp(vol, 0, 1);
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
        this.duck(0.7 * this.level, 0.6, 2.5);
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
        // distant, rolling thunder: a soft muffled onset (only when the strike
        // is close), then overlapping low swells that roll away — never a
        // sharp crack
        const near = this.level;
        if (near > 0.72) {
          this.nz(e, { dur: 0.7, vol: 0.5 * (near - 0.6), color: 'brown', type: 'lowpass', f: 1300, f1: 260, curve: this.grains(9, 0.55, 2, 0.3) });
        }
        const rolls = 2 + ((Math.random() * 3) | 0);
        let at = 0.02;
        for (let i = 0; i < rolls; i++) {
          const dur = rand(2.4, 4.2);
          this.nz(e, {
            at, dur, vol: 0.62 * (1 - i * 0.14), color: 'brown', type: 'lowpass',
            f: 300 * (0.7 + near * 0.6), f1: 85, q: 0.5, curve: this.grains(6, 0.04, 0.8, 0.5),
          });
          at += rand(0.6, 1.5);
        }
        this.tn(e, { at: 0.1, dur: 3.2, f: 46, f1: 29, vol: 0.28, attack: 0.5 });
        this.duck(0.35 * this.level, 1.6, 3.5);
        break;
      }
      case 'splash': {
        // entering water: a hollow plunge, a spray of droplets, then bubbles
        const p = rand(0.85, 1.15);
        this.tn(e, { dur: 0.16, f: 260 * p, f1: 90, vol: 0.2 });
        this.nz(e, { dur: 0.45, vol: 0.4, type: 'bandpass', f: 1100 * p, f1: 600, q: 0.7, attack: 0.015 });
        this.nz(e, { dur: 0.3, vol: 0.22, type: 'highpass', f: 2800, curve: this.grains(14, 0.85, 1.4) });
        for (let i = 0; i < 6; i++) {
          const f = rand(900, 2400);
          this.tn(e, { at: rand(0.08, 0.45), dur: rand(0.03, 0.06), f, f1: f * rand(1.3, 1.8), vol: rand(0.015, 0.035), attack: 0.002 });
        }
        this.bubbles(e, 5, 0.4, 0.05);
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
      case 'jump': {
        // push-off: a cloth swish and a short breath
        const p = rand(0.9, 1.12);
        this.nz(e, { dur: 0.14, vol: 0.09, color: 'pink', type: 'bandpass', f: 900 * p, f1: 1700 * p, q: 1.1, attack: 0.03 });
        this.nz(e, { dur: 0.1, vol: 0.035, color: 'pink', type: 'bandpass', f: 1500 * p, q: 1.6, attack: 0.02 });
        break;
      }
      case 'death': {
        // a long falling groan, a body thump, and the world going quiet
        const p = rand(0.95, 1.05);
        this.vox(e, {
          dur: 0.75, vol: 0.55, pitch: [220 * p, 205 * p, 150 * p, 110 * p], attack: 0.01, release: 0.4,
          formants: [[[650, 520, 480], 5, 1], [[1100, 900], 6, 0.5], [[2450], 8, 0.12]],
          rough: [30, 40], breath: 0.12, direct: 0.25,
        });
        this.tn(e, { at: 0.35, dur: 0.3, f: 90, f1: 38, vol: 0.45 });
        this.nz(e, { at: 0.35, dur: 0.25, vol: 0.3, color: 'brown', type: 'lowpass', f: 420 });
        this.duck(0.6, 1.5, 3);
        break;
      }
      case 'drink': {
        // three gulps: throaty bloops with a wet swallow
        for (let i = 0; i < 3; i++) {
          const at = i * rand(0.2, 0.26);
          const f = rand(260, 340);
          this.tn(e, { at, dur: 0.09, f, f1: f * 1.9, glide: 0.06, vol: 0.14, attack: 0.01 });
          this.nz(e, { at, dur: 0.1, vol: 0.12, color: 'pink', type: 'lowpass', f: 900, attack: 0.02 });
        }
        break;
      }
      case 'ignite': {
        // flint on steel, then the flame catching with a soft whoomph
        this.nz(e, { dur: 0.12, vol: 0.4, type: 'highpass', f: 3200, curve: this.grains(6, 0.95, 1.4) });
        this.tn(e, { dur: 0.08, f: rand(3800, 4600), vol: 0.04 });
        this.nz(e, { at: 0.06, dur: 0.5, vol: 0.3, color: 'brown', type: 'lowpass', f: 300, f1: 900, attack: 0.08 });
        this.nz(e, { at: 0.12, dur: 0.6, vol: 0.12, type: 'bandpass', f: 2600, q: 1, curve: this.grains(14, 0.9, 1, 0.1) });
        break;
      }
      case 'bell': {
        // a village bell tolling in the distance: inharmonic partials + hum
        const f = rand(430, 520);
        for (const [m, v, d] of [[1, 0.16, 4.5], [2.0, 0.08, 3], [2.4, 0.07, 2.4], [3.0, 0.04, 1.8], [0.5, 0.1, 5.5]] as [number, number, number][]) {
          this.tn(e, { dur: d, f: f * m * rand(0.998, 1.002), vol: v, attack: 0.004 });
        }
        this.nz(e, { dur: 0.04, vol: 0.08, type: 'bandpass', f: f * 4, q: 2 });
        break;
      }
      case 'crackle': {
        // a few snaps and pops from a fire or furnace
        this.nz(e, { dur: rand(0.12, 0.3), vol: 0.35, type: 'bandpass', f: rand(1800, 3200), q: 0.9, curve: this.grains(3 + ((Math.random() * 5) | 0), 0.97, 1.2, 0) });
        if (chance(0.3)) this.tn(e, { dur: 0.03, f: rand(500, 900), f1: 300, vol: 0.05 });
        break;
      }
      case 'rain': break;
      case 'orbThrow': case 'orbOpen': case 'orbWobble': case 'orbClick': case 'orbRelease': case 'orbRecall':
        this.catcherSfx(e, name);
        break;
    }
  }

  /** Mob-catcher effects: the throw, the captive being drawn in, the rattling
   *  wobbles, the latch click + success chime, a release and a recall. */
  private catcherSfx(e: Ev, name: SfxName): void {
    switch (name) {
      case 'orbThrow': {
        // an overarm swish with a glassy ting as the orb leaves the hand
        const p = rand(0.92, 1.1);
        this.nz(e, { dur: 0.26, vol: 0.34, type: 'bandpass', f: 500 * p, f1: 2600 * p, q: 1.3, attack: 0.09 });
        this.nz(e, { at: 0.1, dur: 0.18, vol: 0.12, type: 'highpass', f: 3500, attack: 0.02 });
        this.fm(e, { at: 0.1, f: 2349 * p, ratio: 2.76, index: 0.5, dur: 0.35, vol: 0.05 });
        break;
      }
      case 'orbOpen': {
        // the dome pops, a rising suction pulls the mob in, then the lid claps shut
        this.knock(e, 0, 1250, 0.2, 0.05);
        this.nz(e, { at: 0.03, dur: 0.6, vol: 0.4, type: 'bandpass', f: 300, f1: 3200, q: 2.2, attack: 0.35 });
        this.tn(e, { at: 0.03, dur: 0.58, f: 220, f1: 1320, glide: 0.55, vol: 0.09, type: 'triangle', attack: 0.25 });
        [1318.5, 1568, 1975.5, 2637].forEach((f, i) =>
          this.fm(e, { at: 0.12 + i * 0.1, f, ratio: 3.01, index: 0.5, dur: 0.4, vol: 0.035 }));
        this.knock(e, 0.66, 980, 0.32, 0.06);
        this.nz(e, { at: 0.66, dur: 0.03, vol: 0.18, type: 'bandpass', f: 4200, q: 1.5 });
        break;
      }
      case 'orbWobble': {
        // the orb rocks on the ground: a hollow rattle, rim taps on each side
        const p = rand(0.94, 1.06);
        this.knock(e, 0, 760 * p, 0.3, 0.07);
        this.knock(e, 0.11, 640 * p, 0.22, 0.06);
        this.nz(e, { dur: 0.2, vol: 0.12, color: 'pink', type: 'bandpass', f: 2200, q: 1.2, curve: this.grains(6, 0.8, 1.2, 0.2) });
        this.tn(e, { at: 0.02, dur: 0.12, f: 1480 * p, f1: 1400 * p, vol: 0.03, type: 'triangle' });
        break;
      }
      case 'orbClick': {
        // the latch catches (a crisp two-part click), then a bright success chime
        this.tn(e, { dur: 0.02, f: 3200, f1: 2200, vol: 0.3, type: 'square', lp: 5000, attack: 0.001 });
        this.knock(e, 0.035, 1100, 0.45, 0.05);
        this.nz(e, { dur: 0.03, vol: 0.3, type: 'highpass', f: 4000 });
        [1046.5, 1318.5, 1568, 2093].forEach((f, i) =>
          this.fm(e, { at: 0.16 + i * 0.07, f, ratio: 2, index: 1, dur: 0.9 - i * 0.1, vol: 0.075, idxDur: 0.2 }));
        this.fm(e, { at: 0.44, f: 3136, ratio: 3.5, index: 0.4, dur: 0.9, vol: 0.03 });
        break;
      }
      case 'orbRelease': {
        // the dome snaps open with a flash: a pop, a burst of air, a shimmering sweep up
        this.knock(e, 0, 1150, 0.35, 0.05);
        this.nz(e, { dur: 0.4, vol: 0.4, type: 'bandpass', f: 3000, f1: 600, q: 1, attack: 0.005 });
        this.tn(e, { dur: 0.3, f: 180, f1: 70, vol: 0.2 });
        this.tn(e, { at: 0.04, dur: 0.5, f: 660, f1: 1760, glide: 0.35, vol: 0.06, type: 'triangle', attack: 0.02 });
        [1568, 2093, 2637].forEach((f, i) =>
          this.fm(e, { at: 0.08 + i * 0.06, f, ratio: 3.01, index: 0.6, dur: 0.6, vol: 0.04 }));
        break;
      }
      case 'orbRecall': {
        // a humming beam draws the pet back: a falling shimmer into a soft clack
        this.nz(e, { dur: 0.55, vol: 0.3, type: 'bandpass', f: 3400, f1: 400, q: 2, attack: 0.08 });
        const hum = this.tn(e, { dur: 0.55, f: 880, f1: 330, glide: 0.5, vol: 0.08, type: 'triangle', attack: 0.05 });
        const ctx = this.ctx!;
        const l = ctx.createOscillator();
        l.frequency.value = 18;
        const lg = ctx.createGain();
        lg.gain.value = 40;
        l.connect(lg).connect(hum.detune);
        e.nodes.push(lg);
        this.run(e, l, e.t, e.t + 0.58);
        [2637, 2093, 1568, 1318.5].forEach((f, i) =>
          this.fm(e, { at: i * 0.08, f, ratio: 3.01, index: 0.5, dur: 0.35, vol: 0.03 }));
        this.knock(e, 0.52, 940, 0.28, 0.05);
        break;
      }
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

  /** Pre-rendered rain wash: warm brown/pink noise with thousands of soft,
   *  low droplet ticks, rolled off above ~2.5 kHz so it reads as a cosy
   *  steady downpour rather than hiss. The tail is cross-faded into the head
   *  so the loop has no seam. Built once, on demand. */
  private makeRain(): AudioBuffer {
    const ctx = this.ctx!;
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * 6);
    const fade = Math.floor(sr * 0.5);
    const buf = ctx.createBuffer(2, len, sr);
    const tmp = new Float32Array(len + fade);
    const a1 = 1 - Math.exp(-2 * Math.PI * 2400 / sr); // one-pole lowpass coefficients
    const a2 = 1 - Math.exp(-2 * Math.PI * 3600 / sr);
    for (let ch = 0; ch < 2; ch++) {
      let b0 = 0, b1 = 0, b2 = 0, br = 0;
      for (let i = 0; i < tmp.length; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.099;
        b1 = 0.963 * b1 + w * 0.2965;
        b2 = 0.57 * b2 + w * 1.0527;
        br = (br + 0.02 * w) / 1.02;
        tmp[i] = (b0 + b1 + b2 + w * 0.1848) * 0.03 + br * 0.5;
      }
      // droplets: damped sinusoids (two-pole resonator recurrence, no sin/exp
      // per sample) — lower, rounder and softer than a hiss of white ticks
      for (let k = 0; k < 1500; k++) {
        const at = (Math.random() * len) | 0;
        const w = (2 * Math.PI * (700 + Math.pow(Math.random(), 1.6) * 2600)) / sr;
        const tau = (0.0012 + Math.random() * 0.004) * sr;
        const rr = Math.exp(-1 / tau);
        const c1 = 2 * rr * Math.cos(w), c2 = -rr * rr;
        let y1 = (0.02 + Math.pow(Math.random(), 4) * 0.16) * Math.sin(w), y2 = 0;
        const n = Math.floor(tau * 4);
        for (let j = 0; j < n; j++) {
          tmp[at + j] += y1;
          const y = c1 * y1 + c2 * y2;
          y2 = y1;
          y1 = y;
        }
      }
      // two gentle lowpass passes: rolls the highs off (no crackle, no fizz)
      let l1 = 0, l2 = 0;
      for (let i = 0; i < tmp.length; i++) {
        l1 += (tmp[i] - l1) * a1;
        l2 += (l1 - l2) * a2;
        tmp[i] = l2;
      }
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = tmp[i];
      for (let i = 0; i < fade; i++) {
        const x = i / fade;
        d[i] = tmp[i] * Math.sqrt(x) + tmp[len + i] * Math.sqrt(1 - x);
      }
    }
    return buf;
  }

  // ---- beds: long-lived loops glided toward a level --------------------------

  /** A looping noise source started at a random offset. */
  private loopSrc(buf: AudioBuffer, rate = 1): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = rate;
    src.start(this.ctx!.currentTime, Math.random() * buf.duration);
    return src;
  }

  private filt(type: BiquadFilterType, f: number, q = 0.7): BiquadFilterNode {
    const b = this.ctx!.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    return b;
  }

  /** Create (if needed) and steer a named bed. `build` wires its sources into
   *  `into` the first time; returns null when there's nothing to play. */
  private bedSet(name: string, level: number, o: { pan?: number; lp?: number; tc?: number },
    build: (into: AudioNode, b: Bed) => void): Bed | null {
    const ctx = this.ctx;
    if (!ctx || !this.amb) return null;
    let b = this.beds.get(name);
    if (!b) {
      if (level <= 0.0005) return null;
      const lp = this.filt('lowpass', o.lp ?? 18000);
      const g = ctx.createGain();
      g.gain.value = 0;
      const pan = ctx.createStereoPanner();
      pan.pan.value = clamp(o.pan ?? 0, -1, 1);
      lp.connect(g).connect(pan).connect(this.amb);
      b = { srcs: [], g, pan, lp, nodes: [lp, g, pan], x: {}, quiet: 0 };
      build(lp, b);
      this.beds.set(name, b);
    }
    const t = ctx.currentTime;
    b.g.gain.setTargetAtTime(Math.max(0, level), t, o.tc ?? 0.6);
    if (o.pan !== undefined) b.pan.pan.setTargetAtTime(clamp(o.pan, -1, 1), t, 0.5);
    if (o.lp !== undefined) b.lp.frequency.setTargetAtTime(o.lp, t, 0.5);
    b.quiet = level <= 0.0005 ? b.quiet || t : 0;
    return b;
  }

  /** Fade a bed out and release all of its nodes. */
  private bedStop(name: string, fade = 1.5): void {
    const b = this.beds.get(name);
    const ctx = this.ctx;
    if (!b || !ctx) return;
    this.beds.delete(name);
    const t = ctx.currentTime;
    b.g.gain.cancelScheduledValues(t);
    b.g.gain.setValueAtTime(b.g.gain.value, t);
    b.g.gain.linearRampToValueAtTime(0, t + fade);
    const first = b.srcs[0];
    const release = (): void => {
      for (const s of b.srcs) s.disconnect();
      for (const n of b.nodes) n.disconnect();
      for (const n of Object.values(b.x)) n.disconnect();
    };
    if (first) first.onended = release;
    for (const s of b.srcs) { try { s.stop(t + fade + 0.05); } catch { /* already stopped */ } }
    if (!first) release();
  }

  /** Beds that have sat silent for a while are torn down to save CPU. */
  private reapBeds(now: number): void {
    for (const [k, b] of this.beds) if (b.quiet && now - b.quiet > 6) this.bedStop(k, 0.3);
  }

  /** Drive the continuous rain bed. Call with kind='off' to stop. A warm,
   *  low-passed wash with slow natural swells over a soft rumble; under a
   *  canopy the highs soften, under a roof it becomes a muffled drumming. */
  setRain(kind: 'off' | 'rain' | 'thunder', intensity = 0.6, sheltered: boolean | Shelter = false): void {
    this.ensure();
    const ctx = this.ctx;
    if (!ctx || !this.amb) return;
    if (kind === 'off') {
      if (this.rainState !== 'off') { this.bedStop('rain', 2.5); this.bedStop('rainLow', 2.5); }
      this.rainState = 'off';
      return;
    }
    const k = clamp(intensity, 0, 1);
    const sh: Shelter = sheltered === true ? 'roof' : sheltered === false ? 'open' : sheltered;
    this.rainState = kind;
    if (!this.rainBuf) this.rainBuf = this.makeRain();
    const storm = kind === 'thunder' ? 1.15 : 1;
    const shelterGain = sh === 'roof' ? 0.8 : sh === 'deep' ? 0.3 : sh === 'leaves' ? 0.9 : 1;
    const level = (0.05 + 0.075 * k) * storm * shelterGain;
    const lp = sh === 'roof' ? 520 : sh === 'deep' ? 260 : sh === 'leaves' ? 1500 : 1900 + 700 * k;
    const b = this.bedSet('rain', level, { lp, tc: 1.2 }, (into, bed) => {
      const src = this.loopSrc(this.rainBuf!);
      const hp = this.filt('highpass', 90);
      src.connect(hp).connect(into);
      // slow, natural intensity swells: two incommensurate LFOs on the gain
      const depth = this.ctx!.createGain();
      depth.gain.value = 0;
      depth.connect(bed.g.gain);
      bed.srcs.push(src);
      for (const hz of [0.031, 0.0137]) {
        const l = this.ctx!.createOscillator();
        l.frequency.value = hz;
        l.connect(depth);
        l.start();
        bed.srcs.push(l);
      }
      bed.nodes.push(hp);
      bed.x.depth = depth;
    });
    if (b) (b.x.depth as GainNode).gain.setTargetAtTime(level * 0.22, ctx.currentTime, 1);
    // a warm low rumble underneath (heavier in a storm, fuller under a roof)
    const low = (0.035 + 0.04 * k) * (kind === 'thunder' ? 1.5 : 1) * (sh === 'roof' ? 1.25 : sh === 'deep' ? 0.5 : 1);
    this.bedSet('rainLow', low, { lp: sh === 'deep' ? 90 : 170, tc: 1.5 }, (into, bed) => {
      const src = this.loopSrc(this.brown!, 0.7);
      src.connect(into);
      bed.srcs.push(src);
    });
    this.rainShelter = sh;
    this.rainK = k;
  }
  private rainShelter: Shelter = 'open';
  private rainK = 0;

  /** Sparse individual drops over the wash: soft pats on leaves, muffled taps
   *  and the odd gutter plink on a roof, gentle splats on open ground. */
  private patterTick(dt: number): void {
    if (this.rainState === 'off' || !this.ctx) return;
    const sh = this.rainShelter;
    if (sh === 'deep') return;
    this.patterT -= dt;
    if (this.patterT > 0) return;
    const rate = (sh === 'roof' ? 3.2 : sh === 'leaves' ? 4 : 1.6) * (0.4 + this.rainK);
    this.patterT = rand(0.4, 1.6) / rate;
    const e = this.open('amb', 1, { pan: rand(-0.85, 0.85) });
    if (!e) return;
    if (sh === 'roof') {
      // a soft tap on the roof above; now and then a drip from the eaves
      this.nz(e, { dur: 0.05, vol: rand(0.03, 0.07), color: 'pink', type: 'lowpass', f: rand(500, 900) });
      this.tn(e, { dur: 0.05, f: rand(160, 300), f1: 120, vol: rand(0.01, 0.025) });
      if (chance(0.12)) {
        const f = rand(900, 1500);
        this.tn(e, { at: rand(0.1, 0.4), dur: 0.07, f, f1: f * 1.4, glide: 0.03, vol: 0.02 });
      }
    } else if (sh === 'leaves') {
      // drops pattering through the canopy, and a fat drip falling off a leaf
      const n = 1 + ((Math.random() * 3) | 0);
      for (let i = 0; i < n; i++) {
        this.nz(e, { at: i * rand(0.03, 0.09), dur: 0.035, vol: rand(0.02, 0.045), color: 'pink', type: 'bandpass', f: rand(1400, 2600), q: 1.6 });
      }
      if (chance(0.2)) {
        const f = rand(700, 1300);
        this.tn(e, { at: 0.15, dur: 0.06, f, f1: f * 1.6, glide: 0.025, vol: 0.02 });
      }
    } else {
      this.nz(e, { dur: 0.04, vol: rand(0.015, 0.035), color: 'pink', type: 'bandpass', f: rand(1000, 1900), q: 1.2 });
    }
    this.seal(e);
  }

  /** Thunder heard `dist` blocks away: the rumble arrives after a delay that
   *  grows with distance (sound is slower than the flash) and rolls softer. */
  thunder(dist: number): void {
    this.ensure();
    const ctx = this.ctx;
    if (!ctx) return;
    const vol = clamp(1 - dist / 200, 0.3, 1);
    const delay = clamp(dist / 85, 0.15, 3.5);
    const e = this.open('sfx', (SFX_GAIN.thunder ?? 1) * vol, { at: ctx.currentTime + delay, pan: rand(-0.4, 0.4) });
    if (!e) return;
    this.level = vol;
    this.buildSfx(e, 'thunder');
    this.seal(e);
  }

  /** Snowfall (k 0..1): a hushed, muffled stillness with faint ice-crystal
   *  glints. The blizzard howl itself rides on the wind bed (windBed). */
  setSnow(k: number, shelter: Shelter = 'open'): void {
    this.ensure();
    if (!this.ctx || !this.amb) return;
    this.snowK = clamp(k, 0, 1);
    this.snowShelter = shelter;
    if (this.snowK <= 0.01) { this.bedStop('snow', 2); return; }
    const sh = shelter === 'roof' ? 0.35 : shelter === 'deep' ? 0.1 : 1;
    this.bedSet('snow', 0.03 * this.snowK * sh, { lp: shelter === 'open' ? 900 : 450, tc: 1.5 }, (into, bed) => {
      const src = this.loopSrc(this.pink!, 0.5);
      const hp = this.filt('highpass', 140);
      src.connect(hp).connect(into);
      bed.srcs.push(src);
      bed.nodes.push(hp);
    });
  }
  private snowShelter: Shelter = 'open';

  /** Ice-crystal glints drifting past in snowfall (very quiet). */
  private shimmerTick(dt: number): void {
    if (this.snowK <= 0.05 || !this.ctx || this.snowShelter === 'deep') return;
    this.shimmerT -= dt;
    if (this.shimmerT > 0) return;
    this.shimmerT = rand(1.2, 4) / (0.5 + this.snowK);
    const e = this.open('amb', this.snowShelter === 'roof' ? 0.3 : 1, { pan: rand(-0.9, 0.9) });
    if (!e) return;
    const n = 1 + ((Math.random() * 3) | 0);
    for (let i = 0; i < n; i++) {
      this.fm(e, { at: i * rand(0.05, 0.16), f: rand(3200, 6400), ratio: 3.13, index: 0.35, dur: rand(0.4, 0.9), vol: rand(0.004, 0.009) });
    }
    this.seal(e);
  }

  /** The wind bed: a gusting band of noise with a resonant whistle on top.
   *  `howl` (0..1) brings in the blizzard whistle; `muffle` darkens it indoors. */
  private windBed(level: number, howl: number, muffle: boolean): void {
    const g = this.gust;
    const b = this.bedSet('wind', level * (0.4 + 0.8 * g), { pan: this.windPan, lp: muffle ? 420 : 5000, tc: 0.7 }, (into, bed) => {
      const src = this.loopSrc(this.pink!, 0.8);
      const bp = this.filt('bandpass', 420, 0.6);
      src.connect(bp).connect(into);
      const ws = this.loopSrc(this.white!, 1);
      const wbp = this.filt('bandpass', 950, 14);
      const wbp2 = this.filt('bandpass', 1500, 18);
      const wg = this.ctx!.createGain();
      wg.gain.value = 0;
      ws.connect(wbp).connect(wg);
      ws.connect(wbp2).connect(wg);
      wg.connect(into);
      bed.srcs.push(src, ws);
      bed.nodes.push(bp, wbp, wbp2, wg);
      bed.x.bp = bp;
      bed.x.wbp = wbp;
      bed.x.wbp2 = wbp2;
      bed.x.wg = wg;
    });
    if (!b || !this.ctx) return;
    const t = this.ctx.currentTime;
    (b.x.bp as BiquadFilterNode).frequency.setTargetAtTime(260 + 560 * g, t, 0.8);
    (b.x.wbp as BiquadFilterNode).frequency.setTargetAtTime(620 + 900 * g + rand(-90, 90), t, 1.2);
    (b.x.wbp2 as BiquadFilterNode).frequency.setTargetAtTime(1100 + 1100 * g + rand(-150, 150), t, 1.5);
    (b.x.wg as GainNode).gain.setTargetAtTime(howl * (0.35 + 2.2 * g * g), t, 0.6);
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
      this.glide(g.gain, 0.12, 0.5);
      this.uw = { src, g, nodes: [lp] };
      this.bubbleT = 0.3;
    } else if (!on && this.uw) {
      this.glide(this.uw.g.gain, 0, 0.4);
      this.uw.src.stop(t + 0.5);
      this.uw = null;
    }
  }

  // --------------------------------------------------------------------------
  // water: body splashes, swim strokes, dripping exits, nearby flowing water
  // --------------------------------------------------------------------------

  /** Something hits the water. `force` 0..1 (from impact speed) scales it from
   *  a light plop to a heavy crash with spray, falling droplets and bubbles. */
  waterSplash(force: number, vol = 1, pan = 0): void {
    this.ensure();
    if (!this.ctx || !this.gate('wsplash', 0.07)) return;
    const k = clamp(force, 0, 1);
    const e = this.open('sfx', (0.45 + 0.85 * k) * clamp(vol, 0, 1.5), { pan });
    if (!e) return;
    const p = rand(0.9, 1.12);
    // the slap of the surface breaking + the hollow gulp of the cavity closing
    this.tn(e, { dur: 0.1 + k * 0.08, f: 230 * p, f1: 70, vol: 0.12 + 0.22 * k, attack: 0.002 });
    this.tn(e, { at: 0.06 + k * 0.05, dur: 0.12, f: 140 * p, f1: 420 * p, glide: 0.1, vol: 0.05 + 0.08 * k });
    // crash of water thrown up, a spray hiss, a low body whump on big hits
    this.nz(e, { dur: 0.3 + 0.55 * k, vol: 0.3 + 0.3 * k, type: 'bandpass', f: 2100 * p, f1: 650, q: 0.55, attack: 0.006 });
    this.nz(e, { dur: 0.35 + 0.6 * k, vol: 0.12 + 0.2 * k, type: 'highpass', f: 3800, curve: this.grains(10 + 24 * k, 0.85, 1.3) });
    if (k > 0.25) this.nz(e, { dur: 0.45, vol: 0.4 * k, color: 'brown', type: 'lowpass', f: 480, f1: 110, attack: 0.01 });
    // spray raining back onto the surface
    const drops = 3 + Math.round(9 * k);
    for (let i = 0; i < drops; i++) {
      const f = rand(900, 2400);
      this.tn(e, { at: rand(0.18, 0.5 + 0.6 * k), dur: rand(0.03, 0.06), f, f1: f * rand(1.3, 1.8), glide: 0.02, vol: rand(0.015, 0.04), attack: 0.002 });
    }
    this.bubbles(e, 2 + Math.round(5 * k), 0.4 + 0.4 * k, 0.045);
    if (k > 0.55) this.duck(0.18 * k, 0.25, 1.2);
    this.seal(e);
  }

  /** Climbing out of water: a slosh as the body clears, then streaming drips. */
  waterExit(vol = 1): void {
    this.ensure();
    if (!this.ctx || !this.gate('wexit', 0.5)) return;
    const e = this.open('sfx', 0.8 * clamp(vol, 0, 1.5));
    if (!e) return;
    this.nz(e, { dur: 0.34, vol: 0.22, type: 'bandpass', f: 800, f1: 1700, q: 0.8, attack: 0.04 });
    this.nz(e, { at: 0.05, dur: 1.1, vol: 0.1, color: 'pink', type: 'bandpass', f: 2600, q: 1.2, curve: this.grains(20, 0.92, 1.1, 0.02) });
    for (let i = 0; i < 7; i++) {
      const f = rand(1100, 2700);
      this.tn(e, { at: 0.1 + Math.pow(Math.random(), 1.4) * 1.1, dur: rand(0.03, 0.05), f, f1: f * rand(1.4, 1.9), glide: 0.018, vol: rand(0.02, 0.045), attack: 0.002 });
    }
    this.seal(e);
  }

  /** One swim stroke: a paddling swish at the surface, muffled with bubbles
   *  when the head is under. */
  swimStroke(under: boolean, vol = 1): void {
    this.ensure();
    if (!this.ctx || !this.gate('wstroke', 0.2)) return;
    const e = this.open('sfx', 0.55 * clamp(vol, 0, 1.5));
    if (!e) return;
    const p = rand(0.85, 1.15);
    if (under) {
      this.nz(e, { dur: 0.4, vol: 0.2, color: 'brown', type: 'lowpass', f: 380 * p, f1: 700 * p, attack: 0.08 });
      this.bubbles(e, 2, 0.3, 0.03);
    } else {
      this.nz(e, { dur: 0.32, vol: 0.2, type: 'bandpass', f: 520 * p, f1: 1250 * p, q: 0.9, attack: 0.07 });
      this.nz(e, { at: 0.12, dur: 0.24, vol: 0.07, type: 'highpass', f: 2800, curve: this.grains(6, 0.75) });
    }
    this.seal(e);
  }

  private flowBed: { g: GainNode; roar: GainNode; srcs: AudioScheduledSourceNode[] } | null = null;

  /** Loop bed for nearby moving water: `level` 0..1 (how much flowing water /
   *  waterfall is close by), `fall` 0..1 how much of it is falling (adds a
   *  deeper roar). Call every so often; it glides between settings. */
  setWaterFlow(level: number, fall = 0): void {
    const ctx = this.ctx;
    if (!ctx || !this.amb) return;
    const k = clamp(level, 0, 1);
    if (k < 0.01) {
      if (this.flowBed) {
        const b = this.flowBed;
        this.flowBed = null;
        this.glide(b.g.gain, 0, 0.8);
        for (const s of b.srcs) s.stop(ctx.currentTime + 0.9);
      }
      return;
    }
    if (!this.flowBed) {
      // babble: pink noise through a wobbling bandpass; roar: brown noise
      const babble = ctx.createBufferSource();
      babble.buffer = this.pink; babble.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 1100; bp.Q.value = 0.7;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.37;
      const lg = ctx.createGain();
      lg.gain.value = 380;
      lfo.connect(lg).connect(bp.frequency);
      const roar = ctx.createBufferSource();
      roar.buffer = this.brown; roar.loop = true; roar.playbackRate.value = 0.8;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 500;
      const rg = ctx.createGain();
      rg.gain.value = 0;
      const g = ctx.createGain();
      g.gain.value = 0;
      babble.connect(bp).connect(g);
      roar.connect(lp).connect(rg).connect(g);
      g.connect(this.amb);
      const all: AudioNode[] = [babble, roar, lfo, bp, lg, lp, rg, g];
      babble.onended = () => { for (const n of all) n.disconnect(); };
      babble.start(ctx.currentTime, Math.random() * 1.5);
      roar.start(ctx.currentTime, Math.random() * 1.5);
      lfo.start();
      this.flowBed = { g, roar: rg, srcs: [babble, roar, lfo] };
    }
    this.glide(this.flowBed.g.gain, 0.09 * k, 0.9);
    this.glide(this.flowBed.roar.gain, 0.9 * clamp(fall, 0, 1), 0.9);
  }

  /** A short weather gesture; callers retrigger it every ~1-2 seconds.
   *  (listen() drives weather by itself; this remains for older callers.) */
  weatherLoop(kind: 'rain' | 'thunder' | 'snow', intensity: number, isNight = false, sheltered = false): void {
    this.ensure();
    if (!this.ctx) return;
    const k = clamp(intensity, 0, 1);
    if (k <= 0.02) return;
    if (kind === 'snow') {
      this.setSnow(k, sheltered ? 'roof' : 'open');
      if (chance(0.45)) this.windGust(rand(2.5, 4), 0.05 * k, isNight);
      return;
    }
    this.setRain(kind, k, sheltered);
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
          this.nz(e, { dur: 1.2, vol: 0.18, color: 'brown', type: 'lowpass', f: 320, curve: this.grains(30, 0.3, 1, 0.3) });
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
      default: this.netherVoice(e, kind, hurt, death, p, dl);
    }
    this.seal(e);
  }

  /** Nether denizens: piglin grunts (and an admiring "hmm?"), zombified
   *  groan-snorts, hoglin growls, the strider's warbling trill, the blaze's
   *  crackling breath and fire-charge whoosh, the wither skeleton's heavy
   *  rattle and the magma cube's wet squelch. */
  private netherVoice(e: Ev, kind: string, hurt: boolean, death: boolean, p: number, dl: number): void {
    switch (kind) {
      case 'piglin':
      case 'zombified_piglin': {
        const z = kind === 'zombified_piglin';
        if (hurt || death) {
          // an indignant squeal (a rasping one when rotten)
          this.vox(e, {
            dur: 0.32 * dl, vol: 0.3, pitch: death ? [340 * p, 300 * p, 140 * p] : [300 * p, 420 * p, 280 * p], attack: 0.01,
            formants: [[[750, 600], 4, 1], [[1700], 6, 0.5], [[2800], 8, 0.15]], rough: z ? [45, 120] : [35, 60], breath: z ? 0.35 : 0.12,
          });
        } else {
          // gruff snorting grunts: "hrrmph ... hmph"
          const n = 1 + ((Math.random() * 3) | 0);
          for (let i = 0; i < n; i++) {
            const f = (z ? 92 : 124) * p * rand(0.92, 1.08);
            this.vox(e, {
              at: i * rand(0.2, 0.3), dur: rand(0.14, 0.24), vol: 0.32, pitch: [f, f * 1.15, f * 0.85], attack: 0.012, release: 0.06,
              formants: [[[520, 440], 4, 1], [[1250, 1100], 6, 0.5], [[2500], 8, 0.15]],
              rough: z ? [40, 120] : [30, 70], breath: z ? 0.32 : 0.18, direct: 0.3,
            });
          }
          if (z && chance(0.5)) this.nz(e, { at: n * 0.24, dur: 0.3, vol: 0.12, color: 'pink', type: 'bandpass', f: 700, q: 1.2, attack: 0.03 });
        }
        break;
      }
      case 'piglin_admire': {
        // a pleased, curious rising "hmm-hm?" with a snort
        this.vox(e, {
          dur: 0.55, vol: 0.3, pitch: [120 * p, 128 * p, 165 * p, 190 * p], attack: 0.03,
          formants: [[[420, 480], 4, 1], [[1050], 6, 0.45], [[2400], 8, 0.15]], vib: [6, 10], rough: [30, 40], breath: 0.12, direct: 0.35,
        });
        this.nz(e, { at: 0.6, dur: 0.14, vol: 0.18, color: 'pink', type: 'bandpass', f: 900, q: 1.1, attack: 0.01 });
        break;
      }
      case 'hoglin': {
        if (hurt || death) {
          this.vox(e, {
            dur: 0.4 * dl, vol: 0.34, pitch: death ? [210 * p, 180 * p, 70 * p] : [170 * p, 230 * p, 140 * p], attack: 0.015,
            formants: [[[600, 520], 4, 1], [[1400], 6, 0.5]], rough: [30, 140], breath: 0.3, direct: 0.35,
          });
        } else {
          // a deep, wet growl and a snort through the snout
          this.vox(e, {
            dur: rand(0.5, 0.8), vol: 0.36, pitch: [68 * p, 82 * p, 60 * p], attack: 0.05,
            formants: [[[380, 320], 5, 1], [[780], 6, 0.5], [[2000], 8, 0.12]], rough: [24, 140], breath: 0.3, direct: 0.45,
          });
          this.nz(e, { at: rand(0.4, 0.7), dur: 0.22, vol: 0.3, color: 'pink', type: 'bandpass', f: 650, f1: 420, q: 1.3, curve: this.grains(8, 0.5, 1, 0.4) });
        }
        break;
      }
      case 'strider': {
        // a warbling, bird-like trill (a sharp squeak when hurt)
        if (hurt || death) {
          this.vox(e, { dur: 0.25 * dl, vol: 0.24, pitch: [900 * p, 1300 * p, death ? 500 * p : 800 * p], type: 'triangle',
            formants: [[[1200], 4, 1], [[2600], 6, 0.4]], rough: [40, 40], breath: 0.1 });
        } else {
          const n = 1 + ((Math.random() * 2) | 0);
          for (let i = 0; i < n; i++) {
            this.vox(e, { at: i * 0.32, dur: rand(0.22, 0.34), vol: 0.2, pitch: [560 * p, 760 * p, 620 * p], type: 'triangle',
              attack: 0.02, formants: [[[900, 1250], 4, 1], [[2400], 6, 0.35]], vib: [24, 110] });
          }
        }
        break;
      }
      case 'blaze': {
        if (hurt || death) {
          // a hollow metallic clank over a gasp of flame
          this.tn(e, { dur: 0.3 * dl, f: 880 * p, f1: 560 * p, vol: 0.12, type: 'triangle' });
          this.tn(e, { dur: 0.25 * dl, f: 1320 * p, f1: 900 * p, vol: 0.05, type: 'square', lp: 2400 });
          this.nz(e, { dur: 0.4 * dl, vol: 0.22, type: 'bandpass', f: 1400, f1: 500, q: 0.8, attack: 0.01 });
        } else {
          // crackling, rasping breath: in ... and out
          for (const [at, f0, f1] of [[0, 520, 900], [0.55, 950, 420]] as [number, number, number][]) {
            this.nz(e, { at, dur: 0.5, vol: 0.2, color: 'pink', type: 'bandpass', f: f0 * p, f1: f1 * p, q: 1.4, attack: 0.18 });
          }
          this.nz(e, { dur: 1.1, vol: 0.12, type: 'highpass', f: 2600, curve: this.grains(18, 0.9, 1, 0.1) });
          this.tn(e, { dur: 1, f: 150 * p, f1: 120 * p, vol: 0.03, type: 'sawtooth', lp: 500, attack: 0.2 });
        }
        break;
      }
      case 'blaze_shoot': {
        // a fire charge leaving: a roaring whoosh with a low thump
        this.nz(e, { dur: 0.4, vol: 0.34, type: 'bandpass', f: 1600 * p, f1: 380, q: 0.7, attack: 0.008 });
        this.nz(e, { dur: 0.3, vol: 0.12, type: 'highpass', f: 3000, curve: this.grains(10, 0.85, 1.2) });
        this.tn(e, { dur: 0.16, f: 140 * p, f1: 60, vol: 0.14 });
        break;
      }
      case 'wither_skeleton': {
        // a heavier, lower rattle than the plain skeleton's
        const n = death ? 12 : hurt ? 6 : 5 + ((Math.random() * 4) | 0);
        let at = 0;
        for (let i = 0; i < n; i++) {
          const f = rand(650, 1300) * p * (death ? 1 - i / (n * 2) : 1);
          this.nz(e, { at, dur: 0.04, vol: 0.38, type: 'bandpass', f, q: 7 });
          this.tn(e, { at, dur: 0.05, f: f * 0.4, f1: f * 0.35, vol: 0.06, type: 'triangle' });
          at += rand(0.05, 0.09) * (death ? 1.3 : 1);
        }
        this.vox(e, { dur: 0.5 * dl, vol: 0.08, pitch: [70 * p, 64 * p], formants: [[[400], 4, 1]], rough: [30, 90], breath: 0.3 });
        break;
      }
      case 'magma_cube': {
        // a wet, molten squelch (bigger when hurt) with a few popping bubbles
        const k = hurt || death ? 1.3 : 1;
        this.nz(e, { dur: 0.2 * dl, vol: 0.32 * k, color: 'brown', type: 'lowpass', f: 700 * p, f1: 180, attack: 0.004 });
        this.nz(e, { dur: 0.16, vol: 0.12, type: 'bandpass', f: 1300 * p, f1: 600, q: 2, attack: 0.004 });
        this.tn(e, { dur: 0.14, f: 110 * p * k, f1: 55, vol: 0.12 });
        this.bubbles(e, death ? 5 : 2, 0.3, 0.04);
        break;
      }
    }
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
    if (on) {
      this.setRain('off'); this.setSnow(0); this.setUnderwater(false); this.stopNetherBed(); this.setWaterFlow(0);
      for (const k of [...this.beds.keys()]) this.bedStop(k, 1.2);
      this.threat = 0;
      this.scape = null;
      this.dayPart = '';
    }
  }

  /** Scheduler heartbeat (timer-driven so the title screen has music too):
   *  instantiates notes just ahead of the audio clock and starts new pieces. */
  private pump = (): void => {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    this.pumpMusic(ctx.currentTime, typeof document !== 'undefined' && document.hidden ? 2.5 : 0.9);
  };

  /** Instantiate a piece's notes up to `horizon`. */
  private schedule(p: Piece, now: number, horizon: number): void {
    while (p.i < p.notes.length && p.t0 + p.notes[p.i].t < horizon) {
      const n = p.notes[p.i++];
      const at = p.t0 + n.t;
      if (at < now - 0.08) continue; // tab was throttled — drop, don't pile up
      this.note(n, Math.max(at, now + 0.01), p.out);
    }
  }

  /** Schedule music up to `now + ahead`. Public for offline-render harnesses. */
  pumpMusic(now: number, ahead: number): void {
    // pieces fading under a crossfade keep playing (quieter and quieter) until done
    if (this.old.length) {
      this.old = this.old.filter((q) => {
        if (now > q.end) { q.out.disconnect(); return false; }
        this.schedule(q, now, Math.min(now + ahead, q.end - 0.3));
        return true;
      });
    }
    this.pumpCombat(now, ahead);
    const p = this.piece;
    if (p) {
      this.schedule(p, now, now + ahead);
      if (now > p.end) {
        p.out.disconnect();
        this.piece = null;
        // a natural ending earns a silence
        this.nextPieceAt = now + (this.musicMode === 'menu' ? rand(5, 10) : this.scape?.creative ? rand(25, 60) : rand(35, 90));
      }
      return;
    }
    if (!this.settings.music || this.settings.musicVol <= 0) return;
    const live = this.musicMode === 'menu' || now - this.envAt < 4;
    if (live && now >= this.nextPieceAt) this.startPiece(now);
  }

  /** What the music should be about right now. */
  private musicEnv(): MusicEnv {
    if (this.musicMode === 'menu') return 'menu';
    switch (this.musicCtx) {
      case 'underwater': return 'underwater';
      case 'cave': return 'cave';
      case 'nether': return 'nether';
    }
    if (this.scape?.creative && this.env === 'day') return 'creative';
    return this.env === 'night' ? 'night' : 'day';
  }

  /** The place flavour: a village, a peak or the coast beat the raw biome. */
  private musicBiome(): MusicBiome | undefined {
    const s = this.scape;
    if (s && this.musicCtx === 'surface') {
      if (s.villagers >= 3) return 'village';
      if (s.y > 112 && s.sky > 0.9) return 'peak';
      if (s.ocean) return s.leaves < 0.1 && s.y > 64 ? 'beach' : 'ocean';
    }
    return this.biome;
  }

  /** Begin a newly composed piece (optionally forcing a seed, for harnesses). */
  startPiece(now: number, seed?: number): string {
    const ctx = this.ctx;
    if (!ctx || !this.musicBus) return '';
    const menu = this.musicMode === 'menu';
    const s = seed ?? (menu && this.menuCount === 0 ? TITLE_SEED : (Math.random() * 2 ** 31) | 0);
    this.menuCount++;
    const env = this.musicEnv();
    const c = compose(env, menu ? undefined : this.musicBiome(), s, { rain: this.rainState !== 'off' });
    const out = ctx.createGain();
    out.gain.value = 1;
    if (menu) {
      // title screen warmth: a little low-mid body, the top end rolled off
      const body = ctx.createBiquadFilter();
      body.type = 'lowshelf'; body.frequency.value = 260; body.gain.value = 3;
      const soft = ctx.createBiquadFilter();
      soft.type = 'lowpass'; soft.frequency.value = 3200; soft.Q.value = 0.5;
      out.connect(body).connect(soft).connect(this.musicBus);
    } else {
      out.connect(this.musicBus);
    }
    if (this.delay) this.delay.delayTime.setTargetAtTime(clamp(c.beat * 0.75, 0.25, 1.2), now, 0.3);
    this.piece = {
      notes: c.notes, i: 0, t0: now + 0.2, end: now + 0.2 + c.len + 9, out,
      env: menu ? 'menu' : this.musicCtx, fading: false, name: c.name, tonic: c.tonic, minor: c.minor,
    };
    return c.name;
  }

  /** Fade the current piece out over `sec`; it keeps playing underneath
   *  whatever starts next (a crossfade), then releases itself. */
  private fadePiece(sec: number): void {
    const p = this.piece;
    if (!p || !this.ctx) return;
    p.fading = true;
    const t = this.ctx.currentTime;
    p.out.gain.cancelScheduledValues(t);
    p.out.gain.setValueAtTime(p.out.gain.value, t);
    p.out.gain.linearRampToValueAtTime(0, t + sec);
    p.end = t + sec + 0.1;
    this.old.push(p);
    this.piece = null;
  }

  /** A short situational cue: arriving in a village, topping a peak, dawn…
   *  Sits in the key of whatever is playing and ducks it while it sounds. */
  playStinger(kind: StingerKind, gap = 240): boolean {
    const ctx = this.ctx;
    if (!ctx || !this.musicBus || !this.settings.music || this.settings.musicVol <= 0) return false;
    const now = ctx.currentTime;
    if (now - (this.lastAt.get('sting:' + kind) ?? -1e9) < gap || now - (this.lastAt.get('sting') ?? -1e9) < 40) return false;
    this.lastAt.set('sting:' + kind, now);
    this.lastAt.set('sting', now);
    const c = stinger(kind, (Math.random() * 2 ** 31) | 0, this.piece?.tonic);
    const t0 = now + 0.15;
    for (const n of c.notes) this.note(n, t0 + n.t, this.musicBus);
    const p = this.piece;
    if (p) {
      const g = p.out.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0.45, now + 0.8);
      g.setValueAtTime(0.45, t0 + c.len * 0.7);
      g.linearRampToValueAtTime(1, t0 + c.len + 2.5);
    } else if (this.nextPieceAt < t0 + c.len + 4) {
      this.nextPieceAt = t0 + c.len + rand(4, 10);
    }
    return true;
  }

  /** Combat layer: a low pulse of toms and a tense cello ostinato in the key of
   *  the current piece, faded in by how hard you're being chased. */
  private pumpCombat(now: number, ahead: number): void {
    const bus = this.combatBus;
    if (!bus) return;
    const want = this.threat > 0.08 && this.settings.music && this.musicMode === 'game';
    if (want && !this.combatOn) {
      this.combatOn = true;
      this.combatNext = now + 0.15;
      this.combatBar = 0;
    }
    if (!this.combatOn) return;
    bus.gain.setTargetAtTime(want ? 0.35 + 0.65 * this.threat : 0, now, want ? 0.8 : 2.2);
    if (!want && bus.gain.value < 0.01) { this.combatOn = false; return; }
    const beat = 0.6;
    while (this.combatNext < now + ahead) {
      if (this.combatNext >= now - 0.05) this.combatBarNotes(this.combatNext, beat);
      this.combatNext += beat * 4;
      this.combatBar++;
    }
  }

  private combatBarNotes(t: number, beat: number): void {
    const to = this.combatBus!;
    const k = (this.piece?.tonic ?? 50) - 12;
    const hit = (b: number, m: number, v: number): void => this.note({ t: 0, i: 'tom', m, v, d: 0.4 }, t + b * beat, to);
    hit(0, 36, 1);
    hit(1.5, 40, 0.5);
    hit(2, 38, 0.8);
    hit(3, 43, 0.45);
    if (this.combatBar % 2 === 1) hit(3.5, 40, 0.4);
    if (this.combatBar % 4 === 3) hit(3.75, 33, 0.9);
    const ost = [0, 0, 12, 0, 1, 0, 7, 0];
    ost.forEach((o, i) => this.note({ t: 0, i: 'cello', m: k + o, v: i === 0 ? 0.55 : 0.36, d: beat * 0.32, p: -0.2 }, t + i * beat * 0.5, to));
    if (this.threat > 0.5) {
      for (const o of [24, 31, this.threat > 0.8 ? 25 : 36]) this.note({ t: 0, i: 'strings', m: k + o, v: 0.28, d: beat * 3.9, p: 0.25 }, t, to);
    }
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
      case 'harp': this.harp(at, f, n.v, n.d, to, pan); break;
      case 'musicbox': this.musicbox(at, f, n.v, to, pan); break;
      case 'flute': this.flute(at, f, n.v, n.d, to, pan, false); break;
      case 'ocarina': this.flute(at, f, n.v, n.d, to, pan, true); break;
      case 'strings': this.strings(at, f, n.v, n.d, to, pan); break;
      case 'cello': this.cello(at, f, n.v, n.d, to, pan); break;
      case 'tom': this.tom(at, f, n.v, to); break;
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
    this.fm(e, { f, ratio: 1, index: 0.9 + v, dur, vol: 0.2 * v, idxDur: 0.9 });
    this.fm(e, { f: f * 2, ratio: 7, index: 0.3, dur: Math.min(0.5, dur), vol: 0.036 * v, idxDur: 0.2 });
  }

  /** Bell / celesta: inharmonic FM with a long shimmering decay. */
  private bell(at: number, f: number, v: number, hold: number, to: AudioNode, pan: number, ratio: number): void {
    const e = this.open('music', 1, { at, to, pan });
    if (!e) return;
    const dur = ratio === 4 ? clamp(hold, 1.2, 2.2) : clamp(hold + 1.5, 2, 5);
    this.fm(e, { f, ratio, index: ratio === 4 ? 0.8 : 1.4, dur, vol: 0.19 * v, idxDur: 0.6 });
    this.tn(e, { at: 0, dur: dur * 0.7, f: f * 2.01, vol: 0.03 * v });
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

  /** Harp: a plucked string — bright attack that mellows as the filter
   *  closes, long natural ring (lower strings longer), a soft finger pluck. */
  private harp(at: number, f: number, v: number, hold: number, to: AudioNode, pan: number): void {
    const e = this.open('music', 1, { at, to, pan });
    if (!e) return;
    const ctx = this.ctx!;
    const dur = Math.min(clamp(3.4 * Math.pow(220 / f, 0.35), 0.9, 5), hold + 1.4);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.4;
    lp.frequency.setValueAtTime(Math.min(12000, f * 10), at);
    lp.frequency.exponentialRampToValueAtTime(Math.max(300, f * 2.2), at + 0.5);
    const g = ctx.createGain();
    const pk = 0.14 * v;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(pk, at + 0.004);
    g.gain.exponentialRampToValueAtTime(pk * 0.35, at + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    lp.connect(g).connect(e.out);
    e.nodes.push(lp, g);
    const o = ctx.createOscillator();
    o.setPeriodicWave(this.harpWave!);
    o.frequency.value = f;
    o.detune.value = rand(-2, 2);
    o.connect(lp);
    this.run(e, o, at, at + dur + 0.05);
    this.nz(e, { at: at - e.t, dur: 0.014, vol: 0.025 * v, color: 'pink', type: 'bandpass', f: Math.min(5000, f * 4), q: 1.5 });
  }

  /** Music box: a small steel tine — pure FM tone with a glassy partial,
   *  quick to speak and gently fading. */
  private musicbox(at: number, f: number, v: number, to: AudioNode, pan: number): void {
    const e = this.open('music', 1, { at, to, pan });
    if (!e) return;
    const dur = clamp(2.2 * Math.pow(523 / f, 0.4), 0.8, 2.6);
    this.fm(e, { f, ratio: 1, index: 0.35, dur, vol: 0.16 * v, idxDur: 0.15, attack: 0.002 });
    this.tn(e, { dur: dur * 0.25, f: f * 5.43, vol: 0.022 * v, attack: 0.001 });
    this.tn(e, { dur: dur * 0.6, f: f * 2.01, vol: 0.025 * v, attack: 0.002 });
  }

  /** Flute / ocarina: a breathy, rounded tone. Soft chiff on the attack,
   *  vibrato that blooms after the note settles, breath noise throughout. */
  private flute(at: number, f: number, v: number, hold: number, to: AudioNode, pan: number, ocarina: boolean): void {
    const e = this.open('music', 1, { at, to, pan });
    if (!e) return;
    const ctx = this.ctx!;
    const d = Math.max(0.18, hold);
    const end = at + d + 0.22;
    const g = ctx.createGain();
    const pk = (ocarina ? 0.11 : 0.1) * v;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(pk * 1.12, at + (ocarina ? 0.045 : 0.07));
    g.gain.linearRampToValueAtTime(pk, at + 0.18);
    g.gain.setValueAtTime(pk * 0.92, at + d);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.min(9000, f * (ocarina ? 4 : 6));
    lp.connect(g).connect(e.out);
    e.nodes.push(g, lp);
    const o = ctx.createOscillator();
    o.setPeriodicWave(ocarina ? this.ocarinaWave! : this.fluteWave!);
    o.frequency.value = f;
    o.connect(lp);
    // delayed vibrato
    const l = ctx.createOscillator();
    l.frequency.value = rand(4.6, 5.4);
    const lg = ctx.createGain();
    lg.gain.setValueAtTime(0, at);
    lg.gain.linearRampToValueAtTime(0, at + Math.min(0.35, d * 0.5));
    lg.gain.linearRampToValueAtTime(ocarina ? 7 : 11, at + Math.min(0.9, d));
    l.connect(lg).connect(o.detune);
    e.nodes.push(lg);
    this.run(e, o, at, end + 0.03);
    this.run(e, l, at, end + 0.03);
    // breath + chiff
    this.nz(e, { at: at - e.t, dur: d + 0.2, vol: 0.012 * v, color: 'pink', type: 'bandpass', f: Math.min(6000, f * 2), q: 1.2, attack: 0.08, to: g });
    this.nz(e, { at: at - e.t, dur: 0.06, vol: (ocarina ? 0.1 : 0.16) * v, type: 'bandpass', f: Math.min(7000, f * 3), q: 2 });
  }

  /** String section: three detuned bowed saws per note, swelling in slowly,
   *  with a shared ensemble vibrato; spread across the stereo field. */
  private strings(at: number, f: number, v: number, dur: number, to: AudioNode, pan: number): void {
    const e = this.open('music', 1, { at, to, pan: pan * 0.5 });
    if (!e) return;
    const ctx = this.ctx!;
    const a = clamp(dur * 0.3, 0.12, 1.1);
    const rel = clamp(dur * 0.3, 0.15, 1.2);
    const end = at + dur + rel;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.6;
    lp.frequency.setValueAtTime(Math.min(1800, f * 2.5), at);
    lp.frequency.linearRampToValueAtTime(Math.min(3800, f * 4.5), at + a + 0.4);
    const g = ctx.createGain();
    const pk = 0.022 * v;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(pk, at + a);
    g.gain.setValueAtTime(pk, at + dur);
    g.gain.linearRampToValueAtTime(0.0001, end);
    lp.connect(g).connect(e.out);
    e.nodes.push(lp, g);
    const l = ctx.createOscillator();
    l.frequency.value = rand(5, 5.8);
    const lg = ctx.createGain();
    lg.gain.value = 7;
    l.connect(lg);
    e.nodes.push(lg);
    this.run(e, l, at, end + 0.03);
    for (const [det, side] of [[-9, -0.5], [2, 0], [10, 0.5]]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = det;
      lg.connect(o.detune);
      const pn = ctx.createStereoPanner();
      pn.pan.value = side;
      o.connect(pn).connect(lp);
      e.nodes.push(pn);
      this.run(e, o, at, end + 0.03);
    }
  }

  /** Cello: a bowed saw through a woody body resonance, a little bow noise,
   *  and vibrato that arrives after the attack. */
  private cello(at: number, f: number, v: number, dur: number, to: AudioNode, pan: number): void {
    const e = this.open('music', 1, { at, to, pan });
    if (!e) return;
    const ctx = this.ctx!;
    const short = dur < 0.5;
    const a = short ? 0.02 : 0.12;
    const rel = short ? 0.12 : 0.35;
    const end = at + dur + rel;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.min(2200, f * 5);
    const body = ctx.createBiquadFilter();
    body.type = 'peaking';
    body.frequency.value = 280;
    body.Q.value = 1.4;
    body.gain.value = 6;
    const g = ctx.createGain();
    const pk = 0.06 * v;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(pk, at + a);
    g.gain.setValueAtTime(pk * (short ? 0.7 : 0.9), at + dur);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    lp.connect(body).connect(g).connect(e.out);
    e.nodes.push(lp, body, g);
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    o.connect(lp);
    if (!short) {
      const l = ctx.createOscillator();
      l.frequency.value = rand(4.8, 5.4);
      const lg = ctx.createGain();
      lg.gain.setValueAtTime(0, at);
      lg.gain.linearRampToValueAtTime(0, at + 0.25);
      lg.gain.linearRampToValueAtTime(13, at + 0.8);
      l.connect(lg).connect(o.detune);
      e.nodes.push(lg);
      this.run(e, l, at, end + 0.03);
    }
    this.run(e, o, at, end + 0.03);
    this.nz(e, { at: at - e.t, dur: Math.min(dur, 0.4), vol: 0.008 * v, color: 'pink', type: 'bandpass', f: Math.min(4000, f * 6), q: 1, attack: 0.03 });
  }

  /** Low tom / taiko: a pitched skin thump with a noisy strike. */
  private tom(at: number, f: number, v: number, to: AudioNode): void {
    const e = this.open('music', 1, { at, to });
    if (!e) return;
    const t = at - e.t;
    this.tn(e, { at: t, dur: 0.45, f: f * 1.9, f1: f, glide: 0.12, vol: 0.34 * v, attack: 0.003 });
    this.nz(e, { at: t, dur: 0.12, vol: 0.18 * v, color: 'brown', type: 'lowpass', f: 700 });
    this.nz(e, { at: t, dur: 0.02, vol: 0.05 * v, type: 'bandpass', f: 1800, q: 1 });
  }

  /** Call every frame; env + biome pick the mood of music and ambience. */
  ambientTick(dt: number, env: AmbientEnv = 'day', biome?: MusicBiome): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    if (this.musicMode === 'menu') this.setMenuMusic(false); // a world is running
    // the music "context" (surface / cave / nether / underwater) only changes
    // once the new one has held for a few seconds, then the piece crossfades
    const want = env === 'nether' ? 'nether' : this.underwater ? 'underwater' : env === 'cave' ? 'cave' : 'surface';
    if (want !== this.ctxWant) { this.ctxWant = want; this.ctxSince = now; }
    if (want !== this.musicCtx && now - this.ctxSince > (want === 'nether' ? 0.5 : 4)) {
      const from = this.musicCtx;
      this.musicCtx = want;
      if (this.piece && this.piece.env !== want) {
        this.fadePiece(want === 'underwater' || from === 'underwater' ? 3 : 6);
        this.nextPieceAt = now + (want === 'nether' ? rand(4, 8) : rand(3, 7));
      }
      if (want === 'cave' && from === 'surface' && now - this.surfaceSince > 30) this.playStinger('cave', 180);
      if (want === 'nether') this.playStinger('nether', 120);
      if (want === 'surface') this.surfaceSince = now;
    }
    // dawn and dusk on the surface
    if ((env === 'day' || env === 'night') && want === 'surface') {
      if (this.dayPart && env !== this.dayPart) this.playStinger(env === 'day' ? 'sunrise' : 'nightfall', 400);
      this.dayPart = env;
    }
    if (env !== this.env && this.sfxVerb && !this.scape) {
      // footsteps and digging echo underground (listen() refines this by room size)
      this.glide(this.sfxVerb.gain, env === 'cave' ? 0.34 : env === 'nether' ? 0.2 : 0.035, 2);
    }
    this.env = env;
    this.biome = biome;
    this.envAt = now;
    this.pump();

    // Nether: a constant low rumble bed
    if (env === 'nether') this.startNetherBed(); else this.stopNetherBed();

    if (!this.settings.sound) return;
    this.patterTick(dt);
    this.shimmerTick(dt);
    // environment ambience: birdsong by day, crickets and owls at night, dread
    // underground, lava and far wails in the Nether
    this.atmosphereT -= dt;
    if (this.atmosphereT <= 0) {
      if (this.rainState === 'off' || env === 'cave' || env === 'nether' || chance(0.25)) this.atmosphereCue(env, biome);
      this.atmosphereT = (env === 'cave' ? 9 : env === 'day' ? 7 : env === 'nether' ? 5 : 9) + Math.random() * 16;
    }
    // a short musical fragment now and then in the long gaps between pieces
    this.fragT -= dt;
    if (this.fragT <= 0) {
      this.fragT = rand(45, 100);
      if (!this.piece && this.settings.music && this.nextPieceAt - now > 20) this.playFragment(this.musicEnv());
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
  private ctxWant = 'surface';
  private ducked = false;
  private ctxSince = 0;

  private playFragment(env: MusicEnv): void {
    const ctx = this.ctx;
    if (!ctx || !this.musicBus) return;
    const c = fragment(env, (Math.random() * 2 ** 31) | 0);
    const t0 = ctx.currentTime + 0.1;
    for (const n of c.notes) this.note(n, t0 + n.t, this.musicBus);
  }

  /** Probe the world around the player a few times a second and steer every
   *  ambience bed, the weather beds, the cave echo, the combat layer and the
   *  place stingers from it. Call every frame while a world is running. */
  listen(dt: number, world: ScapeWorld, player: ScapePlayer, mobs: readonly ScapeMob[], weather: ScapeWeather | null): void {
    if (!this.ctx || this.musicMode === 'menu') return;
    this.scapeT -= dt;
    if (this.scapeT > 0) return;
    this.scapeT = 0.33;
    this.scape = probeScape(world, player, mobs, weather);
    this.applyScape(this.scape, 0.33);
  }

  /** Mix the ambience for one probe result. Public for harnesses. */
  applyScape(s: Scape, dt: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    this.scape = s;
    const nether = s.dim === 'nether';
    const under = s.underground;
    const shelter: Shelter = under || (s.enclosed > 0.9 && s.sky < 0.3) ? 'deep'
      : s.roof === 'solid' ? 'roof' : s.roof === 'leaves' ? 'leaves' : 'open';
    const exposure = shelter === 'open' ? 1 : shelter === 'leaves' ? 0.75 : shelter === 'roof' ? 0.3 : 0;
    const quiet = !this.settings.sound;

    // --- weather --------------------------------------------------------------
    const wet = !nether && s.weather !== 'clear' && s.intensity > 0.2 && !quiet;
    if (wet && !s.cold) this.setRain(s.weather === 'thunder' ? 'thunder' : 'rain', s.intensity, shelter);
    else if (this.rainState !== 'off') this.setRain('off');
    if (wet && s.cold) this.setSnow(s.intensity, shelter);
    else if (this.snowK > 0) this.setSnow(0);
    // a blizzard: snow in a storm, or heavy snow high up
    this.blizzardK = wet && s.cold
      ? clamp((s.weather === 'thunder' ? 0.85 : 0.3) * s.intensity + clamp((s.y - 90) / 50, 0, 0.5) * s.intensity, 0, 1) : 0;

    // --- wind: altitude, exposure, storms, blizzards ----------------------------
    if (chance(0.14)) this.gustTo = Math.pow(Math.random(), 0.7);
    const gustRate = 0.18 + this.blizzardK * 0.3;
    this.gust += (this.gustTo - this.gust) * gustRate;
    const swing = 0.1 + this.blizzardK * 0.25;
    this.windPan = clamp(this.windPan + rand(-swing, swing), -0.4 - this.blizzardK * 0.45, 0.4 + this.blizzardK * 0.45);
    const alt = clamp((s.y - 78) / 60, 0, 1);
    const windy = s.biome === 'desert' || s.biome === 'snow' || s.biome === 'taiga' || s.biome === 'mountains' ? 1.3 : 1;
    const indoorWind = shelter === 'roof' ? 0.3 : shelter === 'deep' ? 0.08 : 0;
    const wind = nether || quiet ? 0
      : (0.01 + 0.075 * alt + (wet ? 0.025 * s.intensity : 0)) * windy * (exposure + indoorWind * 0.5) + 0.2 * this.blizzardK * Math.max(exposure, indoorWind);
    this.windBed(wind, clamp(this.blizzardK * 1.1 + alt * 0.4 - 0.15, 0, 1), exposure < 0.5);

    // --- foliage rustle, tugged by the same gusts ------------------------------
    const leafLvl = nether || under || quiet ? 0 : s.leaves * (0.006 + 0.03 * this.gust) * (wet ? 0.5 : 1) * (0.4 + 0.6 * exposure);
    this.bedSet('leaves', leafLvl, { pan: s.leafPan * 0.7, tc: 0.5 }, (into, bed) => {
      const src = this.loopSrc(this.pink!, 1.3);
      const hp = this.filt('highpass', 1100);
      const bp = this.filt('bandpass', 2600, 0.6);
      src.connect(hp).connect(bp).connect(into);
      bed.srcs.push(src);
      bed.nodes.push(hp, bp);
    });

    // --- sea / lake: a low surf bed plus waves rolling in -----------------------
    const surf = nether || quiet ? 0 : (s.ocean ? 1 : s.water > 0.4 ? (s.water - 0.4) * 0.8 : 0) * (under ? 0.2 : 0.5 + 0.5 * exposure);
    this.bedSet('surf', 0.03 * surf, { pan: s.waterPan * 0.5, lp: 420, tc: 1 }, (into, bed) => {
      const src = this.loopSrc(this.brown!, 0.9);
      src.connect(into);
      bed.srcs.push(src);
    });
    this.waveT -= dt;
    if (surf > 0.05 && this.waveT <= 0) {
      this.waveT = rand(4.5, 8.5);
      this.wave(surf, s.waterPan);
    }

    // --- streams and waterfalls ----------------------------------------------
    const flow = quiet ? 0 : s.flow * (under ? 0.8 : 1);
    const st = this.bedSet('stream', 0.045 * flow, { pan: s.flowPan * 0.7, tc: 0.6 }, (into, bed) => {
      const src = this.loopSrc(this.white!, 1);
      for (const k of ['a', 'b', 'c']) {
        const bp = this.filt('bandpass', 800, 5);
        const g = this.ctx!.createGain();
        g.gain.value = 0.6;
        src.connect(bp).connect(g).connect(into);
        bed.nodes.push(bp, g);
        bed.x[k] = bp;
      }
      // a waterfall's broadband roar rides on top when there's a lot of flow
      const fall = this.loopSrc(this.pink!, 1);
      const flp = this.filt('lowpass', 2200);
      const fg = this.ctx!.createGain();
      fg.gain.value = 0;
      fall.connect(flp).connect(fg).connect(into);
      bed.srcs.push(src, fall);
      bed.nodes.push(flp);
      bed.x.fg = fg;
    });
    if (st) {
      // burbling: the resonances wander every probe
      for (const k of ['a', 'b', 'c']) (st.x[k] as BiquadFilterNode).frequency.setTargetAtTime(rand(380, 1600), now, 0.12);
      (st.x.fg as GainNode).gain.setTargetAtTime(flow > 0.5 ? (flow - 0.5) * 1.6 : 0, now, 0.8);
      if (chance(0.3 * flow)) {
        const e = this.open('amb', 0.5 * flow, { pan: s.flowPan * 0.7 });
        if (e) { this.bubbles(e, 1 + ((Math.random() * 2) | 0), 0.25, 0.05); this.seal(e); }
      }
    }

    // --- fire, furnaces, lava ------------------------------------------------------
    this.bedSet('fire', quiet ? 0 : 0.04 * s.fire, { pan: s.firePan * 0.8, lp: 600, tc: 0.4 }, (into, bed) => {
      const src = this.loopSrc(this.brown!, 1.2);
      src.connect(into);
      bed.srcs.push(src);
    });
    this.fireT -= dt;
    if (s.fire > 0.05 && this.fireT <= 0 && !quiet) {
      this.fireT = rand(0.15, 0.7) / (0.3 + s.fire);
      const e = this.open('amb', (SFX_GAIN.crackle ?? 1) * 0.35 * s.fire, { pan: s.firePan * 0.8 });
      if (e) { this.buildSfx(e, 'crackle'); this.seal(e); }
    }
    this.bedSet('lava', quiet ? 0 : 0.05 * s.lava, { pan: s.lavaPan * 0.8, lp: 240, tc: 0.6 }, (into, bed) => {
      const src = this.loopSrc(this.brown!, 0.6);
      src.connect(into);
      bed.srcs.push(src);
    });
    if (s.lava > 0.05 && chance(0.18 * s.lava) && !quiet) {
      const e = this.open('amb', (SFX_GAIN.lavaPop ?? 1) * 0.5 * s.lava, { pan: s.lavaPan * 0.8 });
      if (e) { this.buildSfx(e, 'lavaPop'); this.seal(e); }
    }

    // --- caves: still air, and footsteps that echo by the size of the space ----
    const cave = under && s.enclosed > 0.5;
    this.bedSet('caveAir', cave && !quiet ? 0.028 : 0, { lp: 130, tc: 2 }, (into, bed) => {
      const src = this.loopSrc(this.brown!, 0.5);
      src.connect(into);
      bed.srcs.push(src);
    });
    const room = clamp(s.room / 22, 0, 1);
    if (this.echo) {
      this.echo.wet.gain.setTargetAtTime(cave ? 0.05 + 0.16 * room : 0, now, 1);
      this.echo.d.delayTime.setTargetAtTime(clamp(0.05 + s.room * 0.017, 0.06, 0.42), now, 1);
      this.echo.fb.gain.setTargetAtTime(cave ? 0.18 + 0.22 * room : 0, now, 1);
    }
    if (this.sfxVerb) this.sfxVerb.gain.setTargetAtTime(cave ? 0.1 + 0.3 * room : nether ? 0.2 : 0.035 + 0.04 * s.enclosed, now, 1.5);

    // --- villages: murmurs, a far bell --------------------------------------------
    if (s.villagers >= 2 && !nether) {
      if (now - this.seenVillageAt > 150) this.playStinger('village', 300);
      this.seenVillageAt = now;
    }
    this.villageT -= dt;
    if (s.villagers >= 2 && this.villageT <= 0 && !quiet && !under) {
      this.villageT = rand(6, 14);
      this.villageCue(s);
    }

    // --- peaks ---------------------------------------------------------------------
    if (!nether && !this.peakLatch && s.y > 118 && s.sky > 0.95) {
      this.peakLatch = true;
      this.playStinger('peak', 300);
    }
    if (s.y < 100) this.peakLatch = false;

    // --- chases: the combat layer rises fast and settles slowly -----------------
    this.threat += (s.threat - this.threat) * (s.threat > this.threat ? 0.4 : 0.07);
    if (this.threat < 0.01) this.threat = 0;
    const p = this.piece;
    if (p && this.threat > 0.05) { p.out.gain.setTargetAtTime(1 - 0.45 * this.threat, now, 1.2); this.ducked = true; }
    else if (p && this.ducked && this.threat === 0) { p.out.gain.setTargetAtTime(1, now, 2); this.ducked = false; }

    this.reapBeds(now);
  }

  /** A wave rolling in: a slow swell of low surf and a foamy wash as it breaks. */
  private wave(k: number, pan: number): void {
    const e = this.open('amb', k, { pan: clamp(pan * 0.6 + rand(-0.25, 0.25), -1, 1) });
    if (!e) return;
    const dur = rand(3.8, 5.5);
    this.nz(e, { dur, vol: 0.09, color: 'brown', type: 'lowpass', f: 420, f1: 900, attack: dur * 0.45 });
    this.nz(e, { at: dur * 0.38, dur: dur * 0.6, vol: 0.035, color: 'pink', type: 'bandpass', f: 1400, f1: 700, q: 0.6, attack: 0.25 });
    this.nz(e, { at: dur * 0.42, dur: dur * 0.5, vol: 0.02, type: 'highpass', f: 2600, curve: this.grains(26, 0.6, 1.3, 0.35) });
    this.seal(e);
  }

  /** Village life: a quiet overlapping murmur of voices, or a bell far off. */
  private villageCue(s: Scape): void {
    const day = this.env === 'day';
    if (day && chance(0.22)) {
      const e = this.open('amb', (SFX_GAIN.bell ?? 1) * 0.22, { pan: s.villagePan * 0.7 });
      if (!e) return;
      const f = rand(430, 520);
      for (let i = 0; i < 3; i++) {
        for (const [m, v, d] of [[1, 0.16, 3.5], [2.4, 0.06, 2], [0.5, 0.08, 4]] as [number, number, number][]) {
          this.tn(e, { at: i * 1.3, dur: d, f: f * m, vol: v, attack: 0.004 });
        }
      }
      this.seal(e);
      return;
    }
    const e = this.open('amb', day ? 0.5 : 0.25, { pan: s.villagePan * 0.7 });
    if (!e) return;
    let at = 0;
    const n = 2 + ((Math.random() * 3) | 0);
    for (let i = 0; i < n; i++) {
      const f = rand(120, 190);
      const d = rand(0.18, 0.35);
      this.vox(e, {
        at, dur: d, vol: 0.08, pitch: [f, f * rand(1.05, 1.25), f * rand(0.85, 1)], attack: 0.03,
        formants: [[[300], 5, 1], [[1000, 850], 5, 0.3], [[2300], 7, 0.3]], vib: [7, 16], direct: 0.3,
      });
      at += rand(0.1, 0.5);
    }
    this.seal(e);
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
    lg.gain.value = 0.04;
    lfo.connect(lg).connect(g.gain);
    src.connect(lp).connect(g).connect(this.amb);
    src.onended = () => { try { lfo.stop(); } catch { /* already */ } for (const n of [src, lp, g, lfo, lg]) n.disconnect(); };
    src.start(0, Math.random());
    lfo.start();
    this.glide(g.gain, 0.12, 3);
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
   *  tension — over a low, slowly-beating dissonant drone. hpFrac is
   *  health/maxHealth; silent above 30%. Call every frame. */
  heartbeatTick(dt: number, hpFrac: number): void {
    const on = !!this.ctx && this.settings.sound && hpFrac > 0 && hpFrac <= 0.3;
    const k = on ? 1 - hpFrac / 0.3 : 0; // 0 at 30% hp, 1 near death
    this.tensionT -= dt;
    if (this.tensionT <= 0) {
      this.tensionT = 0.5;
      this.bedSet('tension', on ? 0.02 + 0.035 * k : 0, { lp: 240 + 400 * k, tc: 1.2 }, (into, bed) => {
        // two low saws a semitone apart beat against each other
        for (const f of [55, 58.27, 110.3]) {
          const o = this.ctx!.createOscillator();
          o.type = f > 100 ? 'sine' : 'sawtooth';
          o.frequency.value = f;
          const g = this.ctx!.createGain();
          g.gain.value = f > 100 ? 0.5 : 0.35;
          o.connect(g).connect(into);
          o.start();
          bed.srcs.push(o);
          bed.nodes.push(g);
        }
      });
      if (!on) this.reapBeds(this.ctx?.currentTime ?? 0);
    }
    if (!on) { this.heartT = 0; return; }
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
  private tensionT = 0;

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
      for (let k = 0; k < 3; k++) this.tn(e, { at: g * gap + k * 0.035, dur: 0.028, f, vol: 0.05, attack: 0.004 });
    }
    this.seal(e);
  }

  /** A warm daytime insect buzz with a wing-beat flutter. */
  private insectBuzz(): void {
    const e = this.open('amb', 1, { pan: rand(-0.8, 0.8) });
    if (!e) return;
    const dur = rand(0.8, 1.6);
    this.vox(e, { dur, vol: 0.035, pitch: [rand(180, 240), rand(200, 260), rand(170, 230)], type: 'sawtooth', attack: dur * 0.3, release: dur * 0.4, formants: [[[2400], 3, 1], [[4200], 4, 0.5]], vib: [rand(3, 6), 60] });
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
      this.vox(e, { at, dur: 0.14, vol: 0.16, pitch: [f, f * 0.85], attack: 0.01, formants: [[[600], 4, 1], [[1400], 5, 0.4]], rough: [25, 120], direct: 0.4 });
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
      this.vox(e, { dur, vol: 0.3, pitch: [b, b * 1.07, b * 0.94], type: 'sawtooth', attack: dur * 0.4, release: dur * 0.5, formants: [[[380, 300], 3, 1], [[700], 4, 0.3]], vib: [0.7, 30], breath: 0.1 });
    } else if (r < 0.45) {
      // a reversed swell that stops dead
      const dur = rand(1.5, 2.6);
      this.nz(e, { dur, vol: 0.14, color: 'pink', type: 'bandpass', f: 300, f1: 1800, q: 1.5, attack: dur - 0.02 });
      this.tn(e, { dur, f: rand(180, 260), f1: rand(300, 420), vol: 0.03, type: 'triangle', attack: dur - 0.02 });
    } else if (r < 0.7) {
      // a lone drip, echoing into the reverb
      const f = rand(1400, 2200);
      this.tn(e, { dur: 0.08, f: f * 0.7, f1: f, glide: 0.02, vol: 0.16 });
      this.tn(e, { at: rand(0.3, 0.9), dur: 0.07, f: f * 0.8, f1: f * 1.1, glide: 0.02, vol: 0.08 });
    } else if (r < 0.87) {
      // distant rockfall rumble with a trickle of pebbles
      this.nz(e, { dur: rand(1.4, 2.4), vol: 0.22, color: 'brown', type: 'lowpass', f: 200, f1: 60, curve: this.grains(8, 0.3, 1.2, 0.4) });
      this.nz(e, { at: 0.3, dur: 1, vol: 0.06, color: 'pink', type: 'bandpass', f: 1500, curve: this.grains(10, 0.95) });
    } else {
      // footsteps somewhere in the dark
      for (let i = 0; i < 3; i++) {
        this.nz(e, { at: i * rand(0.45, 0.55), dur: 0.14, vol: 0.4, color: 'pink', type: 'bandpass', f: 1100, q: 0.8, curve: this.grains(6, 0.9, 1.3) });
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
      this.nz(e, { dur, vol: 0.2, color: 'brown', type: 'lowpass', f: 260, f1: 90, attack: dur * 0.35 });
      this.tn(e, { dur, f: rand(40, 55), f1: rand(32, 40), vol: 0.07, attack: dur * 0.3 });
      this.seal(e);
    } else {
      this.mobSound('emberghast', rand(0.12, 0.25), 'idle', rand(-0.8, 0.8));
    }
  }

  // ==========================================================================
  // UI sound palette (menus, inventory, loading) — owned by the UI track
  // ==========================================================================

  /** Interface sounds: soft, dry and short so they never compete with the world. */
  ui(name: UiSfx, vol = 1): void {
    this.ensure();
    if (!this.ctx) return;
    if (!this.gate(`ui:${name}`, UI_GAP[name] ?? 0.03)) return;
    const e = this.open('sfx', (UI_GAIN[name] ?? 1) * clamp(vol, 0, 1.5));
    if (!e) return;
    const p = rand(0.97, 1.03);
    switch (name) {
      case 'hover':
        // a feather-light tick
        this.tn(e, { dur: 0.028, f: 2350 * p, f1: 2150 * p, vol: 0.05, attack: 0.001 });
        this.nz(e, { dur: 0.008, vol: 0.03, type: 'bandpass', f: 6200, q: 2 });
        break;
      case 'open':
        // inventory open: an airy upward whoosh with a leathery flap
        this.nz(e, { dur: 0.2, vol: 0.32, color: 'pink', type: 'bandpass', f: 520, f1: 2600, q: 1.1, attack: 0.07 });
        this.nz(e, { at: 0.03, dur: 0.07, vol: 0.14, color: 'pink', type: 'lowpass', f: 900, curve: this.grains(3, 0.6) });
        this.tn(e, { at: 0.02, dur: 0.09, f: 170 * p, f1: 240 * p, vol: 0.06 });
        break;
      case 'close':
        // the same gesture folding back down
        this.nz(e, { dur: 0.16, vol: 0.28, color: 'pink', type: 'bandpass', f: 2300, f1: 480, q: 1.1, attack: 0.03 });
        this.tn(e, { at: 0.07, dur: 0.07, f: 200 * p, f1: 120 * p, vol: 0.09 });
        break;
      case 'pickup':
        // lifting a stack: a small bright blip
        this.tn(e, { dur: 0.055, f: 720 * p, f1: 1180 * p, glide: 0.03, vol: 0.1, attack: 0.002 });
        this.nz(e, { dur: 0.02, vol: 0.05, type: 'bandpass', f: 3600, q: 1.2 });
        break;
      case 'place':
        // setting it down: a dull wooden tock
        this.tn(e, { dur: 0.05, f: 980 * p, f1: 620 * p, vol: 0.09, attack: 0.001 });
        this.tn(e, { dur: 0.06, f: 260 * p, f1: 190 * p, vol: 0.08, attack: 0.001 });
        this.nz(e, { dur: 0.018, vol: 0.06, color: 'pink', type: 'bandpass', f: 1800, q: 1 });
        break;
      case 'toggleOn':
        this.tn(e, { dur: 0.05, f: 880, vol: 0.07, type: 'triangle' });
        this.tn(e, { at: 0.055, dur: 0.08, f: 1320, vol: 0.07, type: 'triangle' });
        break;
      case 'toggleOff':
        this.tn(e, { dur: 0.05, f: 1320, vol: 0.06, type: 'triangle' });
        this.tn(e, { at: 0.055, dur: 0.08, f: 880, vol: 0.06, type: 'triangle' });
        break;
      case 'tab':
        // page flick
        this.nz(e, { dur: 0.045, vol: 0.18, type: 'highpass', f: 2600, curve: this.grains(3, 0.9, 1) });
        this.tn(e, { dur: 0.025, f: 1500 * p, vol: 0.04 });
        break;
      case 'swipe':
        // screen transition: a soft breath of air
        this.nz(e, { dur: 0.26, vol: 0.14, color: 'pink', type: 'lowpass', f: 380, f1: 1900, attack: 0.1 });
        break;
      case 'created': {
        // new world: a bright rising bell arpeggio
        const notes = [523.25, 659.25, 783.99, 1046.5];
        notes.forEach((f, i) => this.fm(e, { at: i * 0.075, f, ratio: 3.5, index: 0.7, dur: 0.9 - i * 0.1, vol: 0.075, idxDur: 0.15 }));
        this.nz(e, { at: 0.25, dur: 0.5, vol: 0.05, type: 'highpass', f: 6000, curve: this.grains(10, 0.95, 1.1) });
        break;
      }
      case 'loaded': {
        // loading-complete sting: a warm chord swell under a sparkling run
        for (const [f, v] of [[130.81, 0.09], [196, 0.06], [261.63, 0.05], [329.63, 0.04]] as [number, number][]) {
          this.tn(e, { dur: 1.7, f, vol: v, wave: this.padWave ?? undefined, attack: 0.28, lp: 1600 });
        }
        [783.99, 987.77, 1174.66, 1567.98, 1975.53].forEach((f, i) =>
          this.fm(e, { at: 0.12 + i * 0.065, f, ratio: 2, index: 0.8, dur: 1.1, vol: 0.05, idxDur: 0.2 }));
        this.nz(e, { at: 0.1, dur: 0.9, vol: 0.05, type: 'highpass', f: 5200, curve: this.grains(14, 0.95, 0.9) });
        this.duck(0.5, 0.8, 2.2);
        break;
      }
      case 'shutter':
        // screenshot: a mechanical camera shutter
        this.nz(e, { dur: 0.018, vol: 0.4, type: 'highpass', f: 3000 });
        this.tn(e, { dur: 0.03, f: 420, f1: 260, vol: 0.12 });
        this.nz(e, { at: 0.07, dur: 0.035, vol: 0.3, type: 'bandpass', f: 2200, q: 1.4 });
        this.tn(e, { at: 0.07, dur: 0.04, f: 520, f1: 300, vol: 0.1 });
        break;
    }
    this.seal(e);
  }
}

/** Interface sound names for AudioEngine.ui(). */
export type UiSfx =
  | 'hover' | 'open' | 'close' | 'pickup' | 'place' | 'toggleOn' | 'toggleOff'
  | 'tab' | 'swipe' | 'created' | 'loaded' | 'shutter';
const UI_GAIN: Partial<Record<UiSfx, number>> = {
  hover: 4, open: 1.3, close: 1.3, pickup: 3.2, place: 3.2, toggleOn: 2.6, toggleOff: 2.6,
  tab: 2.2, swipe: 1.6, created: 1.4, loaded: 1.5, shutter: 1.6,
};
const UI_GAP: Partial<Record<UiSfx, number>> = { hover: 0.04, pickup: 0.03, place: 0.03, tab: 0.05, open: 0.1, close: 0.1 };
