// Web Audio synthesis: dig/place/step sounds per block class, UI clicks,
// hurt/eat/pop effects, and a sparse ambient pad. No audio assets used.

import { SoundClass } from './Blocks';

export type SfxName =
  | 'pop' | 'hurt' | 'hit' | 'eat' | 'burp' | 'click' | 'select' | 'fail' | 'craft' | 'level'
  | 'doorOpen' | 'doorClose' | 'plateOn' | 'plateOff'
  | 'explode' | 'bow' | 'snap' | 'fuse' | 'arrowHit' | 'whoosh' | 'lowdur'
  | 'thunder' | 'rain' | 'splash' | 'hoof' | 'mount'
  | 'submerge' | 'emerge';

/** Ambient mood selector for ambientTick. */
export type AmbientEnv = 'day' | 'night' | 'cave' | 'nether';

/** Overworld biome flavour for the generative music (subtle scale/tempo/colour shifts). */
export type MusicBiome =
  'plains' | 'forest' | 'desert' | 'snow' | 'taiga' | 'swamp' | 'mountains' | 'jungle';

/** Resolved musical character for one generated piece. */
interface PieceMood {
  night: boolean;
  scale: number[];          // scale degrees (semitones) for the melody
  arpDeg: number[];         // arpeggio degree pattern
  third: number;            // pad colour 3rd (major 4 / minor 3)
  seventh: number;          // jazzy 7th colour
  progressions: number[][]; // chord-root movements (semitones)
  roots: number[];          // candidate tonics (Hz)
  barLen: number;           // seconds per bar (tempo)
  octaveBias: number;       // chance the melody leaps an octave up (sparkle)
  bellChance: number;       // high bell frequency
  padVol: number;           // pad richness multiplier
  density: number;          // melody note probability multiplier
}

interface AudioSettings { music: boolean; sound: boolean; volume: number }

const SETTINGS_KEY = 'voxelcraft-audio';

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private ambientT = 22;
  private musicT = 6;        // seconds until the next generated piece
  private atmosphereT = 12;  // sparse lonely wind/drone/bell cues between music
  private heartT = 0;        // low-health heartbeat pacing
  private settings: AudioSettings = { music: true, sound: true, volume: 0.7 };
  // master gain at volume=0.7 (the previous fixed 0.35), scaling linearly
  private masterFor(v: number): number { return 0.5 * Math.max(0, Math.min(1, v)); }
  // continuous rain bed: a persistent looping noise source we fade in/out
  private rainSrc: AudioBufferSourceNode | null = null;
  private rainGain: GainNode | null = null;
  private rainFilter: BiquadFilterNode | null = null;
  private rainState: 'off' | 'rain' | 'thunder' = 'off';
  // held so the reverb/delay send chain isn't garbage-collected mid-session
  private musicFx: AudioNode[] = [];
  // underwater: a lowpass on the master that muffles everything while submerged,
  // plus a soft bubbling bed
  private uwFilter: BiquadFilterNode | null = null;
  private uwBubbleSrc: AudioBufferSourceNode | null = null;
  private uwBubbleGain: GainNode | null = null;
  private underwater = false;

  constructor() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) this.settings = { ...this.settings, ...JSON.parse(raw) };
    } catch { /* default settings */ }
  }

  get musicOn(): boolean { return this.settings.music; }
  get soundOn(): boolean { return this.settings.sound; }
  get volume(): number { return this.settings.volume; }

  /** Master loudness 0..1; ramps smoothly and persists. */
  setVolume(v: number): void {
    this.settings.volume = Math.max(0, Math.min(1, v));
    if (this.master && this.ctx) {
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setValueAtTime(this.master.gain.value, t);
      this.master.gain.linearRampToValueAtTime(this.masterFor(this.settings.volume), t + 0.1);
    }
    this.persist();
  }

  setMusic(on: boolean): void {
    this.settings.music = on;
    if (this.musicBus) this.musicBus.gain.value = on ? 1 : 0;
    this.persist();
  }

  setSound(on: boolean): void {
    this.settings.sound = on;
    if (this.sfx) this.sfx.gain.value = on ? 1 : 0;
    this.persist();
  }

  private persist(): void {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch { /* ignore */ }
  }

  /** Must be called from a user gesture at least once. */
  ensure(): void {
    if (this.ctx) {
      if (this.ctx.state !== 'running') void this.ctx.resume();
      this.unlock();
      return;
    }
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.masterFor(this.settings.volume);
      // master → underwater lowpass → speakers. The filter is transparent (20kHz)
      // until submerged, when it ramps down to a muffled ~600 Hz.
      this.uwFilter = this.ctx.createBiquadFilter();
      this.uwFilter.type = 'lowpass';
      this.uwFilter.frequency.value = 20000;
      this.uwFilter.Q.value = 0.7;
      this.master.connect(this.uwFilter);
      this.uwFilter.connect(this.ctx.destination);
      this.sfx = this.ctx.createGain();
      this.sfx.gain.value = this.settings.sound ? 1 : 0;
      this.sfx.connect(this.master);
      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = this.settings.music ? 1 : 0;
      // dry path
      this.musicBus.connect(this.master);
      // Spacious reverb send — the single biggest factor in the airy C418 vibe.
      // Impulse is procedurally generated decaying noise (no asset).
      const reverb = this.ctx.createConvolver();
      reverb.buffer = this.makeImpulse(3.0, 2.4);
      const revGain = this.ctx.createGain();
      revGain.gain.value = 0.28;
      this.musicBus.connect(reverb).connect(revGain).connect(this.master);
      // Soft feedback delay for the sparkle echoes; its output is also reverbed
      // so trailing notes dissolve into the space rather than repeating dryly.
      const delay = this.ctx.createDelay(1.0);
      delay.delayTime.value = 0.4;
      const fb = this.ctx.createGain();
      fb.gain.value = 0.3;
      const delayGain = this.ctx.createGain();
      delayGain.gain.value = 0.22;
      this.musicBus.connect(delay);
      delay.connect(fb).connect(delay);
      delay.connect(delayGain).connect(this.master);
      delay.connect(reverb);
      this.musicFx = [reverb, revGain, delay, fb, delayGain];
      const len = this.ctx.sampleRate;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      // mobile browsers create the context "suspended" — resume + play a silent
      // buffer now, while we're still inside the user gesture, or there's no sound
      if (this.ctx.state !== 'running') void this.ctx.resume();
      this.unlock();
    } catch {
      this.ctx = null;
    }
  }

  /** iOS/Safari unlock trick: play a one-sample silent buffer inside a gesture so
   *  the audio hardware is actually started. Harmless elsewhere; runs once. */
  private unlocked = false;
  private unlock(): void {
    if (this.unlocked || !this.ctx) return;
    try {
      const b = this.ctx.createBufferSource();
      b.buffer = this.ctx.createBuffer(1, 1, 22050);
      b.connect(this.ctx.destination);
      b.start(0);
      this.unlocked = true;
    } catch { /* ignore */ }
  }

  private noiseBurst(dur: number, freq: number, vol: number, type: BiquadFilterType = 'lowpass', freqEnd?: number): void {
    if (!this.ctx || !this.sfx || !this.noiseBuf) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.playbackRate.value = 0.7 + Math.random() * 0.6;
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(freq, t);
    if (freqEnd) filter.frequency.exponentialRampToValueAtTime(Math.max(40, freqEnd), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filter).connect(g).connect(this.sfx);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  private tone(dur: number, f0: number, f1: number, vol: number, type: OscillatorType = 'sine', when = 0): void {
    if (!this.ctx || !this.sfx) return;
    const t = this.ctx.currentTime + when;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g).connect(this.sfx);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** Dig/place sound for a block sound class — MC-style layered hits. */
  dig(cls: SoundClass, vol: number): void {
    this.ensure();
    switch (cls) {
      case 'stone':
        // crisp double-tap: body thud + gritty scrape
        this.noiseBurst(0.09, 1100, 0.45 * vol, 'lowpass', 400);
        this.noiseBurst(0.06, 2600, 0.18 * vol, 'bandpass', 1400);
        this.tone(0.05, 140, 90, 0.1 * vol, 'sine');
        break;
      case 'wood':
        // hollow knock + woody body
        this.noiseBurst(0.08, 800, 0.36 * vol, 'lowpass', 300);
        this.tone(0.07, 200, 130, 0.14 * vol, 'triangle');
        this.tone(0.05, 95, 70, 0.08 * vol, 'sine');
        break;
      case 'grass':
        // soft squelch
        this.noiseBurst(0.1, 1800, 0.26 * vol, 'bandpass', 700);
        this.noiseBurst(0.05, 600, 0.1 * vol, 'lowpass', 250);
        break;
      case 'sand':
        // gritty crunch
        this.noiseBurst(0.14, 3000, 0.22 * vol, 'highpass', 1200);
        this.noiseBurst(0.06, 1400, 0.1 * vol, 'bandpass');
        break;
      case 'glass':
        // bright shatter
        this.noiseBurst(0.18, 4400, 0.32 * vol, 'highpass');
        this.tone(0.12, 2100, 900, 0.1 * vol, 'triangle');
        this.tone(0.08, 3200, 1600, 0.05 * vol, 'sine');
        break;
      case 'none': break;
    }
  }

  step(cls: SoundClass): void {
    this.dig(cls === 'none' ? 'stone' : cls, 0.16);
  }

  play(name: SfxName): void {
    this.ensure();
    switch (name) {
      case 'pop': this.tone(0.1, 420, 940, 0.3, 'sine'); break;
      case 'hurt':
        // a short pained grunt — a low vocal body with a noisy rasp on top
        this.tone(0.2, 198, 104, 0.34, 'sawtooth');
        this.tone(0.17, 150, 86, 0.2, 'triangle', 0.015);
        this.noiseBurst(0.12, 1000, 0.15, 'bandpass', 340);
        break;
      case 'hit':
        // a meaty thwack on a mob — a soft impact thump + a faint woody knock
        this.noiseBurst(0.07, 1400, 0.28, 'lowpass', 420);
        this.tone(0.1, 205, 95, 0.26, 'sine');
        this.tone(0.045, 360, 150, 0.1, 'square', 0.006);
        break;
      case 'eat': this.noiseBurst(0.07, 1400, 0.25, 'bandpass'); break;
      case 'burp': this.tone(0.25, 220, 80, 0.3, 'sawtooth'); break;
      case 'click': this.tone(0.035, 850, 700, 0.18, 'square'); break;
      case 'select':
        this.tone(0.045, 620, 820, 0.12, 'triangle');
        this.tone(0.05, 930, 760, 0.08, 'sine', 0.035);
        break;
      case 'fail':
        this.tone(0.09, 180, 125, 0.16, 'square');
        this.tone(0.08, 130, 95, 0.1, 'triangle', 0.055);
        break;
      case 'craft':
        this.noiseBurst(0.055, 1800, 0.08, 'bandpass');
        this.tone(0.06, 520, 660, 0.12, 'triangle');
        this.tone(0.08, 780, 940, 0.08, 'sine', 0.045);
        break;
      case 'doorOpen':
        // wooden latch + creak upward (MC-style)
        this.tone(0.04, 520, 420, 0.14, 'square');
        this.noiseBurst(0.14, 320, 0.28, 'bandpass', 900);
        this.tone(0.16, 140, 240, 0.16, 'triangle');
        this.tone(0.1, 220, 310, 0.1, 'sine', 0.05);
        break;
      case 'doorClose':
        // soft thud + descending creak
        this.noiseBurst(0.12, 480, 0.26, 'bandpass', 220);
        this.tone(0.18, 210, 95, 0.18, 'triangle');
        this.tone(0.08, 380, 260, 0.1, 'square', 0.04);
        this.noiseBurst(0.06, 180, 0.14, 'lowpass', 90);
        break;
      case 'plateOn':
        // soft wooden depress: a low muted tick (no sharp UI click)
        this.tone(0.05, 240, 180, 0.12, 'triangle');
        this.noiseBurst(0.05, 600, 0.08, 'lowpass', 240);
        break;
      case 'plateOff':
        // gentle release, a touch higher and shorter
        this.tone(0.04, 300, 360, 0.09, 'triangle');
        this.noiseBurst(0.04, 700, 0.06, 'lowpass', 300);
        break;
      case 'level': this.tone(0.3, 520, 1040, 0.2, 'sine'); this.tone(0.3, 660, 1320, 0.15, 'sine', 0.08); break;
      case 'explode':
        this.noiseBurst(0.8, 350, 0.8, 'lowpass', 60);
        this.tone(0.5, 90, 35, 0.5, 'sine');
        break;
      case 'bow':
        this.noiseBurst(0.1, 1800, 0.2, 'bandpass');
        this.tone(0.12, 320, 720, 0.18, 'triangle');
        break;
      case 'snap':
        this.tone(0.05, 700, 300, 0.3, 'square');
        this.tone(0.06, 500, 200, 0.3, 'square', 0.07);
        this.noiseBurst(0.12, 2400, 0.2, 'highpass');
        break;
      case 'fuse': this.noiseBurst(1.3, 3800, 0.22, 'highpass'); break;
      case 'whoosh':
        // a soft airy swish for swinging at empty air — short filtered noise sweep
        this.noiseBurst(0.16, 1700, 0.12, 'bandpass', 520);
        break;
      case 'lowdur':
        // a small worried two-tone chirp: your tool is nearly spent
        this.tone(0.07, 880, 700, 0.12, 'square');
        this.tone(0.09, 640, 460, 0.1, 'triangle', 0.07);
        break;
      case 'arrowHit': this.tone(0.06, 950, 500, 0.2, 'triangle'); this.noiseBurst(0.05, 2000, 0.12, 'bandpass'); break;
      case 'splash':
        this.noiseBurst(0.22, 1400, 0.18, 'bandpass', 520);
        this.noiseBurst(0.12, 3200, 0.08, 'highpass');
        break;
      case 'submerge':
        // head goes under: a muffled descending gloop + a low watery thud
        this.noiseBurst(0.4, 900, 0.3, 'lowpass', 160);
        this.tone(0.32, 360, 110, 0.16, 'sine');
        this.tone(0.5, 150, 70, 0.12, 'sine', 0.04);
        break;
      case 'emerge':
        // breaking the surface: a bright rising splash + a gasp of air
        this.noiseBurst(0.26, 1200, 0.26, 'highpass');
        this.noiseBurst(0.18, 2600, 0.14, 'bandpass', 1400);
        this.tone(0.18, 220, 520, 0.12, 'triangle');
        break;
      case 'hoof':
        // a dull clop: low square thud + soft body
        this.tone(0.05, 150, 88, 0.16, 'square');
        this.noiseBurst(0.05, 280, 0.1, 'lowpass', 110);
        break;
      case 'mount':
        // leather creak when climbing into the saddle
        this.noiseBurst(0.16, 520, 0.14, 'bandpass', 220);
        this.tone(0.1, 180, 240, 0.08, 'triangle');
        break;
      case 'thunder':
        // layered: low rumble + crackle, fading slowly
        this.noiseBurst(2.0, 600, 0.6, 'lowpass', 80);
        this.tone(1.8, 70, 38, 0.55, 'sine');
        this.noiseBurst(0.5, 1800, 0.35, 'highpass');
        break;
      case 'rain':
        // legacy single-shot; the continuous bed is driven by setRain()
        this.setRain('rain', 0.5);
        break;
    }
  }

  /** Drive the continuous rain bed. Call with kind='off' to stop. The bed
   *  is a single looping filtered-noise source that fades in/out smoothly,
   *  much softer and less choppy than per-burst noise. */
  setRain(kind: 'off' | 'rain' | 'thunder', intensity = 0.6): void {
    this.ensure();
    if (!this.ctx || !this.sfx || !this.noiseBuf) return;
    const k = Math.max(0, Math.min(1, intensity));
    // stop the bed when weather clears
    if (kind === 'off') {
      if (this.rainGain && this.ctx) {
        const t = this.ctx.currentTime;
        this.rainGain.gain.cancelScheduledValues(t);
        this.rainGain.gain.setValueAtTime(this.rainGain.gain.value, t);
        this.rainGain.gain.linearRampToValueAtTime(0, t + 1.5);
      }
      const src = this.rainSrc;
      if (src) setTimeout(() => { try { src.stop(); } catch { /* already */ } }, 1600);
      this.rainSrc = null;
      this.rainState = 'off';
      return;
    }
    // (re)create the bed if it's not running or the character changed
    if (!this.rainSrc || this.rainState === 'off') {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
      src.playbackRate.value = 0.6;
      // two stacked filters for a softer "shhh" character
      const hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 1400;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 6000;
      const g = this.ctx.createGain();
      g.gain.value = 0;
      src.connect(hp).connect(lp).connect(g).connect(this.sfx);
      src.start();
      this.rainSrc = src;
      this.rainFilter = lp;
      this.rainGain = g;
      this.rainState = kind;
    }
    this.rainState = kind;
    // fade to target volume
    if (this.rainGain && this.ctx) {
      const t = this.ctx.currentTime;
      const target = kind === 'thunder' ? 0.07 * k : 0.05 * k;
      this.rainGain.gain.cancelScheduledValues(t);
      this.rainGain.gain.setValueAtTime(this.rainGain.gain.value, t);
      this.rainGain.gain.linearRampToValueAtTime(target, t + 1.2);
    }
    // a few sparse "plink" drips layered on top for texture
    const drips = 1 + Math.floor(k * 3);
    for (let i = 0; i < drips; i++) {
      const when = 0.1 + Math.random() * 1.4;
      this.tone(0.03 + Math.random() * 0.03, 700 + Math.random() * 900, 280 + Math.random() * 300, 0.012 * k, 'sine', when);
    }
  }

  /** Muffle the whole mix and run a soft bubble bed while the head is submerged. */
  setUnderwater(on: boolean): void {
    this.ensure();
    if (!this.ctx || !this.uwFilter || !this.sfx || !this.noiseBuf) return;
    if (on === this.underwater) return;
    this.underwater = on;
    const t = this.ctx.currentTime;
    // ramp the master lowpass: muffled while under, transparent above
    this.uwFilter.frequency.cancelScheduledValues(t);
    this.uwFilter.frequency.setValueAtTime(this.uwFilter.frequency.value, t);
    this.uwFilter.frequency.exponentialRampToValueAtTime(on ? 620 : 20000, t + 0.45);
    if (on) {
      // a low, gently wavering bubble bed
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuf; src.loop = true; src.playbackRate.value = 0.42;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 500; lp.Q.value = 0.8;
      const g = this.ctx.createGain(); g.gain.value = 0;
      g.gain.linearRampToValueAtTime(0.05, t + 0.5);
      src.connect(lp).connect(g).connect(this.sfx);
      src.start();
      this.uwBubbleSrc = src; this.uwBubbleGain = g;
    } else if (this.uwBubbleGain && this.uwBubbleSrc) {
      const g = this.uwBubbleGain; const src = this.uwBubbleSrc;
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(g.gain.value, t);
      g.gain.linearRampToValueAtTime(0, t + 0.4);
      setTimeout(() => { try { src.stop(); } catch { /* already stopped */ } }, 600);
      this.uwBubbleSrc = null; this.uwBubbleGain = null;
    }
  }

  /** A short looping weather bed; callers retrigger it every ~1-2 seconds. */
  weatherLoop(kind: 'rain' | 'thunder' | 'snow', intensity: number, isNight = false, sheltered = false): void {
    this.ensure();
    if (!this.ctx || !this.sfx) return;
    const k = Math.max(0, Math.min(1, intensity));
    if (k <= 0.02) return;
    if (kind === 'snow') {
      this.noiseBurst(2.0, 1800, 0.025 * k, 'bandpass', 900);
      if (Math.random() < 0.28) this.windGust(1.4 + Math.random() * 1.2, 0.045 * k, isNight);
      return;
    }

    const wet = sheltered ? 0.45 : 1;
    this.noiseBurst(2.0, 4200, 0.06 * k * wet, 'highpass');
    this.noiseBurst(2.0, 1350, 0.055 * k * wet, 'bandpass', 900);
    this.noiseBurst(1.7, 520, 0.02 * k, 'lowpass', 360);
    const drops = 2 + Math.floor(k * 5);
    for (let i = 0; i < drops; i++) {
      const when = 0.08 + Math.random() * 1.55;
      this.tone(0.035 + Math.random() * 0.035, 680 + Math.random() * 840, 260 + Math.random() * 360, 0.018 * k, 'triangle', when);
      if (Math.random() < 0.35) this.noiseBurst(0.05, 2300 + Math.random() * 1200, 0.025 * k, 'bandpass');
    }
    if (kind === 'thunder') {
      this.windGust(1.8, 0.05 * k, true);
      if (Math.random() < 0.18) this.noiseBurst(0.55, 220, 0.08 * k, 'lowpass', 90);
    }
  }

  private windGust(dur: number, vol: number, dark: boolean): void {
    const start = dark ? 360 : 520;
    const end = dark ? 120 : 240;
    this.noiseBurst(dur, start, vol, 'bandpass', end);
  }

  /** Synthesized mob voices; vol already includes distance falloff. */
  mobSound(kind: string, vol: number): void {
    if (!this.ctx || vol <= 0.02) return;
    switch (kind) {
      case 'pig':
        this.tone(0.09, 260, 175, 0.3 * vol, 'sawtooth');
        this.tone(0.08, 240, 170, 0.22 * vol, 'sawtooth', 0.13);
        break;
      case 'sheep':
        this.tone(0.45, 560, 470, 0.16 * vol, 'sawtooth');
        this.tone(0.45, 575, 460, 0.12 * vol, 'square');
        break;
      case 'cow':
        this.tone(0.6, 165, 105, 0.28 * vol, 'sawtooth');
        this.tone(0.5, 170, 115, 0.12 * vol, 'triangle', 0.05);
        break;
      case 'chicken':
        this.tone(0.06, 880, 1150, 0.14 * vol, 'square');
        this.tone(0.06, 840, 1100, 0.12 * vol, 'square', 0.16);
        break;
      case 'zombie':
        this.tone(0.7, 115, 65, 0.24 * vol, 'sawtooth');
        this.noiseBurst(0.5, 320, 0.12 * vol);
        break;
      case 'spider':
        this.noiseBurst(0.3, 2600, 0.12 * vol, 'highpass');
        break;
      case 'skeleton':
        this.tone(0.05, 420, 360, 0.1 * vol, 'square');
        this.tone(0.05, 380, 320, 0.1 * vol, 'square', 0.09);
        this.tone(0.05, 440, 380, 0.08 * vol, 'square', 0.17);
        break;
      case 'creeper':
        this.noiseBurst(0.38, 1800, 0.1 * vol, 'highpass');
        this.noiseBurst(0.24, 520, 0.08 * vol, 'bandpass', 240);
        break;
      case 'wolf':
        this.tone(0.18, 410, 520, 0.14 * vol, 'triangle');
        this.tone(0.2, 520, 360, 0.11 * vol, 'triangle', 0.14);
        break;
      case 'villager':
        this.tone(0.32, 190, 150, 0.18 * vol, 'sawtooth');
        this.tone(0.28, 230, 175, 0.12 * vol, 'triangle', 0.16);
        break;
      case 'phantom':
        this.noiseBurst(0.5, 2400, 0.12 * vol, 'bandpass', 900);
        this.tone(0.45, 620, 260, 0.08 * vol, 'sawtooth');
        break;
      case 'horse':
        // a whinny: a quick rise then a long falling vibrato + breath
        this.tone(0.12, 360, 560, 0.16 * vol, 'sawtooth');
        this.tone(0.5, 560, 300, 0.16 * vol, 'sawtooth', 0.1);
        this.tone(0.45, 720, 320, 0.08 * vol, 'square', 0.12);
        this.noiseBurst(0.3, 1100, 0.05 * vol, 'bandpass', 500);
        break;
      case 'cat':
        // a soft two-syllable meow
        this.tone(0.18, 620, 720, 0.12 * vol, 'sawtooth');
        this.tone(0.22, 700, 480, 0.1 * vol, 'sawtooth', 0.16);
        break;
      case 'cinderling':
        // a crackling ember hiss + a small shrill screech
        this.noiseBurst(0.22, 2600, 0.1 * vol, 'highpass');
        this.tone(0.12, 880, 1280, 0.1 * vol, 'square');
        this.tone(0.1, 700, 420, 0.07 * vol, 'sawtooth', 0.12);
        break;
      case 'ashstalker':
        // a low molten growl with a crackle on top
        this.tone(0.5, 130, 80, 0.22 * vol, 'sawtooth');
        this.tone(0.4, 165, 105, 0.12 * vol, 'square', 0.05);
        this.noiseBurst(0.35, 1400, 0.08 * vol, 'bandpass', 500);
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Generative music: calm piano-and-pad pieces every few minutes, scheduled
  // entirely on the Web Audio clock. Day pieces are major, night pieces minor.
  // ---------------------------------------------------------------------------

  /** Call every frame; env + biome pick the mood. Starts a new piece on timeout. */
  ambientTick(dt: number, env: AmbientEnv = 'day', biome?: MusicBiome): void {
    if (!this.ctx || !this.settings.music) return;
    const dark = env !== 'day';
    this.ambientT -= dt;
    if (this.ambientT <= 0) {
      this.playAmbientStinger(dark);
      this.ambientT = (dark ? 22 : 30) + Math.random() * 28;
    }
    // environment-flavoured ambience: lively birdsong by day (biome-tinted),
    // lonely wind/owl at night, eerie dread underground, ominous Nether drones
    this.atmosphereT -= dt;
    if (this.atmosphereT <= 0) {
      this.atmosphereCue(env, biome);
      this.atmosphereT = (env === 'cave' ? 10 : env === 'day' ? 11 : 15) + Math.random() * 24;
    }
    this.musicT -= dt;
    if (this.musicT > 0) return;
    const pieceLen = this.playPiece(this.moodFor(env, biome));
    // a little less silence between pieces than before, so the world sings more
    this.musicT = pieceLen + 22 + Math.random() * 42;
  }

  /** Resolve the musical character for the current environment + biome. The
   *  shifts stay subtle so everything still reads as the same calm, exploratory
   *  Minecraft-style score — just touched with each terrain's mood. */
  private moodFor(env: AmbientEnv, biome?: MusicBiome): PieceMood {
    const night = env !== 'day';
    // base: bright C418-style major by day, wistful minor by night (plains/forest)
    const m: PieceMood = {
      night,
      scale: night ? [0, 3, 5, 7, 10] : [0, 2, 4, 7, 9],
      arpDeg: night ? [0, 3, 7, 12, 10, 12, 7, 3] : [0, 4, 7, 12, 11, 12, 7, 4],
      third: night ? 3 : 4,
      seventh: night ? 10 : 11,
      progressions: night
        ? [[0, -5, -2, -7], [0, 3, -2, -5], [0, -4, -7, -2]]
        : [[0, 7, 9, 5], [0, 5, 7, 12], [0, 9, 5, 7]],
      roots: night ? [196, 220, 246.94] : [196, 220, 246.94, 261.63, 293.66],
      barLen: night ? 3.8 : 3.25,
      octaveBias: night ? 0.2 : 0.34,
      bellChance: 0.3,
      padVol: 1.0,
      density: 1.0,
    };
    // underground / Nether: dark and modal, no biome colour
    if (env === 'cave' || env === 'nether') {
      m.scale = [0, 2, 3, 7, 8];        // phrygian-tinged unease
      m.barLen = 4.2; m.density = 0.68; m.octaveBias = 0.12; m.padVol = 1.2; m.bellChance = 0.2;
      if (env === 'nether') m.roots = [146.83, 164.81, 174.61];
      return m;
    }
    switch (biome) {
      case 'snow':
      case 'taiga':
        // cold crystalline loneliness — sparse, slow, high bells (kumoi colour)
        m.scale = night ? [0, 2, 3, 7, 10] : [0, 2, 3, 7, 9];
        m.barLen = night ? 4.4 : 4.0;
        m.density = 0.6; m.bellChance = 0.62; m.octaveBias += 0.26; m.padVol = 0.85;
        break;
      case 'jungle':
        // lush and alive — lydian sparkle, busier arpeggios, quicker
        m.scale = night ? [0, 3, 5, 7, 9] : [0, 2, 4, 6, 9];
        m.arpDeg = night ? [0, 3, 7, 10, 12, 7] : [0, 2, 4, 7, 9, 11, 12, 9];
        m.barLen = night ? 3.4 : 2.9; m.density = 1.25; m.bellChance = 0.34;
        break;
      case 'desert':
        // wide modal mythos — mixolydian, slow and spacious
        m.scale = night ? [0, 3, 5, 7, 10] : [0, 2, 4, 7, 10];
        m.seventh = 10;
        m.progressions = night ? [[0, -2, -5, -7], [0, 5, -2, -7]] : [[0, 5, 3, 7], [0, 7, 5, 10], [0, 3, 7, 5]];
        m.barLen = night ? 4.2 : 3.8; m.density = 0.78; m.octaveBias += 0.08; m.padVol = 1.12;
        break;
      case 'swamp':
        // murky mystery — low dorian minor, sustained
        m.scale = [0, 2, 3, 5, 7, 9, 10]; m.third = 3; m.seventh = 10;
        m.barLen = 4.2; m.density = 0.8; m.octaveBias = 0.1; m.padVol = 1.2; m.bellChance = 0.2;
        break;
      case 'mountains':
        // grand and mythic — rich pads, wide bells
        m.barLen = night ? 4.0 : 3.6; m.padVol = 1.28; m.bellChance = 0.5; m.octaveBias += 0.12; m.density = 0.88;
        break;
      // plains / forest / undefined keep the classic base
    }
    return m;
  }

  /** A soft heartbeat that emerges and quickens as health drops — survival
   *  tension. hpFrac is health/maxHealth; silent above 30%. Call every frame. */
  heartbeatTick(dt: number, hpFrac: number): void {
    if (!this.ctx || !this.settings.sound) { this.heartT = 0; return; }
    if (hpFrac <= 0 || hpFrac > 0.3) { this.heartT = 0; return; }
    const k = 1 - hpFrac / 0.3;                 // 0 at 30% hp, 1 near death
    this.heartT -= dt;
    if (this.heartT > 0) return;
    this.heartT = 1.0 - k * 0.45;               // ~1.0s -> ~0.55s as it worsens
    const vol = 0.06 + k * 0.1;
    this.tone(0.09, 72, 44, vol, 'sine');        // lub
    this.tone(0.08, 62, 40, vol * 0.7, 'sine', 0.15); // dub
  }

  /** One ambient gesture (through the music reverb), flavoured by environment. */
  private atmosphereCue(env: AmbientEnv, biome?: MusicBiome): void {
    if (!this.ctx || !this.musicBus) return;
    const t = this.ctx.currentTime + 0.05;
    const r = Math.random();
    if (env === 'cave') { this.caveCue(); return; }
    if (env === 'nether') {
      // ominous emptiness: a low drone or a far molten roar
      if (r < 0.6) this.padAt(t, 49 * (Math.random() < 0.5 ? 1 : 1.5), 0.03, 7);
      else { this.padAt(t, 41, 0.035, 3); this.noiseBurst(1.6, 240, 0.05, 'lowpass', 70); }
      return;
    }
    if (env === 'night') {
      // lonely night: wind, a low drone, a distant owl, or a lone bell
      if (r < 0.38) this.windSigh(t, 0.05, true);
      else if (r < 0.62) this.padAt(t, 55 * (Math.random() < 0.5 ? 1 : 1.5), 0.03, 7);
      else if (r < 0.84) this.owlHoot(t);
      else this.bellNote(t, 196 * Math.pow(2, [0, 3, 7, 10][(Math.random() * 4) | 0] / 12), 0.013, 5);
      return;
    }
    // day: a living world — birdsong, insect trills, a gentle breeze, tinted by
    // the terrain so each biome sounds distinct as you walk into it
    switch (biome) {
      case 'snow':
      case 'taiga':
        // thin cold wind + sparse icy shimmer
        if (r < 0.6) this.windSigh(t, 0.042, true);
        else this.bellNote(t, 1900 + Math.random() * 900, 0.009, 2.4);
        return;
      case 'desert':
        // dry, wide breeze with the rare insect
        if (r < 0.72) this.windSigh(t, 0.045, false);
        else this.insectTrill(t);
        return;
      case 'jungle':
        // dense, chattering birds + insects
        if (r < 0.5) this.birdChirp(t);
        else if (r < 0.82) { this.birdChirp(t); this.birdChirp(t + 0.18); }
        else this.insectTrill(t);
        return;
      case 'swamp':
        // low frog croaks and bugs over a heavy hush
        if (r < 0.5) this.frogCroak(t);
        else if (r < 0.8) this.insectTrill(t);
        else this.windSigh(t, 0.03, true);
        return;
      case 'mountains':
        // airy heights — breeze with a far bell
        if (r < 0.6) this.windSigh(t, 0.04, false);
        else if (r < 0.85) this.birdChirp(t);
        else this.bellNote(t, 1400 + Math.random() * 500, 0.012, 3.5);
        return;
    }
    // plains / forest / unknown: the classic lively day
    if (r < 0.52) this.birdChirp(t);
    else if (r < 0.78) this.insectTrill(t);
    else this.windSigh(t, 0.03, false);
  }

  /** A short low frog croak — two quick rasps, for swamp daytime. */
  private frogCroak(when: number): void {
    if (!this.ctx || !this.musicBus) return;
    const croak = (t: number, f: number) => {
      const osc = this.ctx!.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f, t);
      osc.frequency.linearRampToValueAtTime(f * 0.82, t + 0.12);
      const lp = this.ctx!.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 900; lp.Q.value = 3;
      const g = this.ctx!.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.05, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0003, t + 0.14);
      osc.connect(lp).connect(g).connect(this.musicBus!);
      osc.start(t); osc.stop(t + 0.16);
    };
    const base = 150 + Math.random() * 50;
    croak(when, base);
    croak(when + 0.16, base * 1.05);
  }

  /** A short cheerful birdsong — a few quick gliding high notes. */
  private birdChirp(when: number): void {
    if (!this.ctx || !this.musicBus) return;
    const n = 2 + ((Math.random() * 3) | 0);
    let base = 2200 + Math.random() * 1200;
    for (let i = 0; i < n; i++) {
      const f = base * (0.9 + Math.random() * 0.4);
      this.chirpNote(when + i * (0.07 + Math.random() * 0.05), f, f * (1 + (Math.random() - 0.3) * 0.4), 0.05);
      base *= 0.96;
    }
  }

  private chirpNote(when: number, f0: number, f1: number, vol: number): void {
    if (!this.ctx || !this.musicBus) return;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f0, when);
    osc.frequency.exponentialRampToValueAtTime(Math.max(200, f1), when + 0.05);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(vol, when + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0003, when + 0.07);
    osc.connect(g).connect(this.musicBus);
    osc.start(when); osc.stop(when + 0.1);
  }

  /** A soft amplitude-modulated cricket/insect trill. */
  private insectTrill(when: number): void {
    if (!this.ctx || !this.musicBus) return;
    const dur = 0.6 + Math.random() * 0.9;
    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 4200 + Math.random() * 1500;
    const lfo = this.ctx.createOscillator();
    lfo.type = 'square'; lfo.frequency.value = 28 + Math.random() * 14;
    const lfoGain = this.ctx.createGain(); lfoGain.gain.value = 0.018;
    const g = this.ctx.createGain(); g.gain.value = 0;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(0.018, when + 0.15);
    g.gain.linearRampToValueAtTime(0.0001, when + dur);
    lfo.connect(lfoGain).connect(g.gain);
    osc.connect(g).connect(this.musicBus);
    osc.start(when); lfo.start(when);
    osc.stop(when + dur + 0.05); lfo.stop(when + dur + 0.05);
  }

  /** A soft two-note owl hoot, low with gentle vibrato. */
  private owlHoot(when: number): void {
    if (!this.ctx || !this.musicBus) return;
    const hoot = (t: number) => {
      const osc = this.ctx!.createOscillator();
      osc.type = 'sine'; osc.frequency.value = 360 + Math.random() * 60;
      const vib = this.ctx!.createOscillator(); vib.type = 'sine'; vib.frequency.value = 7;
      const vibG = this.ctx!.createGain(); vibG.gain.value = 6;
      vib.connect(vibG).connect(osc.frequency);
      const g = this.ctx!.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.05, t + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0003, t + 0.4);
      osc.connect(g).connect(this.musicBus!);
      osc.start(t); vib.start(t); osc.stop(t + 0.45); vib.stop(t + 0.45);
    };
    hoot(when); hoot(when + 0.55);
  }

  /** Underground dread: an eerie moan, a lone echoing drip, or a distant rumble. */
  private caveCue(): void {
    if (!this.ctx || !this.musicBus) return;
    const t = this.ctx.currentTime + 0.05;
    const r = Math.random();
    if (r < 0.5) {
      this.caveMoan(t);
    } else if (r < 0.82) {
      // a single water drip, echoing into the reverb
      this.bellNote(t, 1500 + Math.random() * 700, 0.02, 0.5);
      this.bellNote(t + 0.09, 900 + Math.random() * 300, 0.012, 0.7);
    } else {
      // a distant rockfall rumble
      this.padAt(t, 44, 0.03, 2.5);
      this.noiseBurst(1.4, 180, 0.05, 'lowpass', 55);
    }
  }

  /** A low, slowly-wavering moan through the reverb — the classic cave unease. */
  private caveMoan(when: number): void {
    if (!this.ctx || !this.musicBus) return;
    const dur = 2.6 + Math.random() * 2.2;
    const base = 58 + Math.random() * 46;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 380; lp.Q.value = 1.5;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(0.06, when + dur * 0.4);
    g.gain.linearRampToValueAtTime(0.0001, when + dur);
    lp.connect(g).connect(this.musicBus);
    for (const [mult, detune] of [[1, 0], [1, 8], [2, -5]] as [number, number][]) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(base * mult, when);
      osc.detune.value = detune;
      osc.frequency.linearRampToValueAtTime(base * mult * 1.07, when + dur * 0.5);
      osc.frequency.linearRampToValueAtTime(base * mult * 0.96, when + dur);
      osc.connect(lp);
      osc.start(when); osc.stop(when + dur + 0.05);
    }
  }

  /** A slow wind swell routed through the music reverb for spacious emptiness. */
  private windSigh(when: number, vol: number, dark: boolean): void {
    if (!this.ctx || !this.musicBus || !this.noiseBuf) return;
    const dur = 3 + Math.random() * 3;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf; src.loop = true; src.playbackRate.value = 0.5;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = dark ? 300 : 460; bp.Q.value = 0.7;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(vol, when + dur * 0.4);
    g.gain.linearRampToValueAtTime(0.0001, when + dur);
    src.connect(bp).connect(g).connect(this.musicBus);
    src.start(when); src.stop(when + dur + 0.05);
  }

  private playAmbientStinger(isNight: boolean): void {
    if (!this.ctx || !this.musicBus) return;
    const t = this.ctx.currentTime + 0.08;
    if (isNight) {
      const root = [98, 110, 130.81][(Math.random() * 3) | 0];
      this.padAt(t, root, 0.022, 4.8);
      this.padAt(t + 0.5, root * Math.pow(2, 7 / 12), 0.012, 4.1);
      if (Math.random() < 0.45) this.pianoNote(t + 1.6, root * 4, 0.025, 3.2);
    } else {
      const root = [196, 220, 261.63][(Math.random() * 3) | 0];
      this.pianoNote(t, root * 2, 0.025, 2.2);
      if (Math.random() < 0.7) this.pianoNote(t + 0.42, root * Math.pow(2, 7 / 12) * 2, 0.02, 2.1);
      if (Math.random() < 0.45) this.padAt(t, root * 0.5, 0.012, 3.5);
    }
  }

  /** Schedule one full generated piece in the resolved mood; returns its length. */
  private playPiece(mood: PieceMood): number {
    if (!this.ctx || !this.musicBus) return 0;
    const t0 = this.ctx.currentTime + 0.15;
    const { night, scale: pent, third, seventh, barLen, padVol, density, octaveBias, bellChance } = mood;
    const root = mood.roots[(Math.random() * mood.roots.length) | 0];
    const progression = mood.progressions[(Math.random() * mood.progressions.length) | 0];
    const bars = 8 + (((Math.random() * 2) | 0) * 4);
    const motif = [
      pent[(Math.random() * pent.length) | 0],
      pent[(Math.random() * pent.length) | 0],
      pent[(Math.random() * pent.length) | 0],
    ];

    // arpeggio runs in alternating stretches so the piece breathes: a couple of
    // flowing bars, then space. The 7th gives the wistful C418 jazz colour.
    let arpRun = false;
    for (let bar = 0; bar < bars; bar++) {
      const tBar = t0 + bar * barLen;
      const chordRoot = root * Math.pow(2, progression[bar % progression.length] / 12);
      // pad: root + third + fifth (+ occasional 7th colour), swelling under everything
      this.padAt(tBar, chordRoot * 0.5, 0.045 * padVol, barLen * 1.15);
      this.padAt(tBar, chordRoot * Math.pow(2, third / 12) * 0.5, 0.032 * padVol, barLen * 1.15);
      this.padAt(tBar, chordRoot * Math.pow(2, 7 / 12) * 0.5, 0.028 * padVol, barLen * 1.15);
      if (Math.random() < 0.5) this.padAt(tBar, chordRoot * Math.pow(2, seventh / 12) * 0.5, 0.018 * padVol, barLen * 1.05);
      // add-9 shimmer + a warm 5th above for a fuller, richer chord bed
      if (Math.random() < 0.45) this.padAt(tBar, chordRoot * Math.pow(2, 14 / 12), 0.012 * padVol, barLen * 0.92);
      if (Math.random() < 0.4) this.padAt(tBar, chordRoot * Math.pow(2, (third + 12) / 12), 0.011 * padVol, barLen * 0.9);
      // soft bass pulse — warm and low, MC-style drone
      this.pianoNote(tBar, chordRoot * 0.25, 0.05, 2.6);
      if (Math.random() < 0.36) this.pianoNote(tBar + barLen * 0.5, chordRoot * 0.5, 0.034, 2.0);
      // flowing broken-chord arpeggio in roughly half the bars, panning gently L↔R
      arpRun = bar === 0 ? Math.random() < 0.5 : (Math.random() < 0.72 ? arpRun : !arpRun);
      if (arpRun) {
        const steps = night ? 6 : 8;
        for (let i = 0; i < steps; i++) {
          const deg = mood.arpDeg[i % mood.arpDeg.length];
          const freq = chordRoot * Math.pow(2, deg / 12);
          const when = tBar + (i / steps) * barLen + (Math.random() - 0.5) * 0.015;
          const pan = Math.sin((i / steps) * Math.PI * 2) * 0.5;
          this.arpNote(when, freq, 0.02, barLen / steps + 0.5, pan);
        }
      }
      // occasional high sparkle bell for the airy MC ambience
      if (bar % 2 === 1 && Math.random() < bellChance) {
        const deg = pent[(Math.random() * pent.length) | 0];
        this.bellNote(tBar + barLen * 0.25, root * 8 * Math.pow(2, deg / 12), 0.012, 3.5);
      }
      // sparse, repeated pentatonic motifs with enough silence to feel exploratory.
      const beats = night ? [0, 0.375, 0.75] : [0, 0.25, 0.5, 0.75];
      for (let i = 0; i < beats.length; i++) {
        if (Math.random() > Math.min(0.95, (i === 0 ? 0.62 : 0.38) * density)) continue;
        const deg = Math.random() < 0.55 ? motif[i % motif.length] : pent[(Math.random() * pent.length) | 0];
        const octave = Math.random() < octaveBias ? 4 : 2;
        const freq = root * octave * Math.pow(2, deg / 12);
        const when = tBar + beats[i] * barLen + Math.random() * 0.04;
        this.pianoNote(when, freq, 0.044 + Math.random() * 0.025, 2.3);
        // a faint octave-up echo a beat later — adds the airy MC sparkle
        if (Math.random() < 0.5) this.pianoNote(when + 0.28, freq * 2, 0.015, 1.6);
      }
      // a gentle counter-melody answering the motif a third up — adds warmth/body
      if (bar % 2 === 1 && Math.random() < 0.5 * density) {
        const cd = motif[(bar >> 1) % motif.length];
        this.arpNote(tBar + barLen * 0.5, root * 2 * Math.pow(2, (cd + third) / 12), 0.016, barLen * 0.7, -0.25);
      }
      if (bar % 4 === 3 && Math.random() < 0.58) {
        const deg = pent[(Math.random() * pent.length) | 0];
        this.bellNote(tBar + barLen * 0.82, root * 4 * Math.pow(2, deg / 12), 0.026 + bellChance * 0.02, 4.5);
      }
    }
    return bars * barLen;
  }

  /** Rhodes-piano-ish voice: fundamental + slightly detuned octave + warm 2nd
   *  harmonic, through a soft lowpass with a gentle "hammer" attack. This is
   *  closer to C418's electric-piano timbre than a raw sine. */
  private pianoNote(when: number, freq: number, vol: number, decay: number): void {
    if (!this.ctx || !this.musicBus) return;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    // filter opens slightly on the attack for a "ting" then settles
    filter.frequency.setValueAtTime(1800, when);
    filter.frequency.linearRampToValueAtTime(2400, when + 0.02);
    filter.frequency.exponentialRampToValueAtTime(900, when + decay * 0.6);
    filter.Q.value = 0.4;
    filter.connect(this.musicBus);
    // warmer partial blend: fundamental, detuned sub, octave, 2nd harmonic
    const partials: [number, number, OscillatorType, number][] = [
      [1, 1.0, 'sine', 0],
      [1, 0.18, 'sine', -3.5],     // subtle detune for chorus warmth
      [2, 0.3, 'sine', 0],
      [3, 0.06, 'triangle', 0],
    ];
    for (const [mult, pv, type, detune] of partials) {
      const osc = this.ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq * mult * (1 + (Math.random() - 0.5) * 0.001);
      osc.detune.value = detune;
      const g = this.ctx.createGain();
      // soft hammer attack: quick but not instantaneous
      g.gain.setValueAtTime(0.0001, when);
      g.gain.linearRampToValueAtTime(vol * pv, when + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0004, when + decay);
      osc.connect(g).connect(filter);
      osc.start(when);
      osc.stop(when + decay + 0.05);
    }
  }

  /** Warm sustained pad: two slightly detuned triangle/sawtooth oscillators
   *  through a slowly-opening lowpass, for a soft string-pad swell. */
  private padAt(when: number, freq: number, vol: number, dur: number): void {
    if (!this.ctx || !this.musicBus) return;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(500, when);
    filter.frequency.linearRampToValueAtTime(1100, when + dur * 0.4);
    filter.frequency.linearRampToValueAtTime(600, when + dur);
    filter.Q.value = 0.6;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(vol, when + dur * 0.32);
    g.gain.linearRampToValueAtTime(0.0001, when + dur);
    filter.connect(g).connect(this.musicBus);
    for (const [type, detune, pv] of [['triangle', 0, 1], ['triangle', 5, 0.6], ['sawtooth', -4, 0.18]] as [OscillatorType, number, number][]) {
      const osc = this.ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      osc.detune.value = detune;
      osc.connect(filter);
      osc.start(when);
      osc.stop(when + dur + 0.05);
    }
  }

  /** Procedural reverb impulse: stereo decaying noise. */
  private makeImpulse(dur: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  /** Gentle plucked arpeggio voice with stereo placement — adds the flowing
   *  broken-chord motion under C418-style pieces without crowding the melody. */
  private arpNote(when: number, freq: number, vol: number, decay: number, pan: number): void {
    if (!this.ctx || !this.musicBus) return;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2600, when);
    filter.frequency.exponentialRampToValueAtTime(800, when + decay);
    filter.Q.value = 0.3;
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    filter.connect(panner).connect(this.musicBus);
    for (const [mult, pv, type] of [[1, 1, 'triangle'], [2, 0.16, 'sine']] as [number, number, OscillatorType][]) {
      const osc = this.ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq * mult;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.linearRampToValueAtTime(vol * pv, when + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0004, when + decay);
      osc.connect(g).connect(filter);
      osc.start(when);
      osc.stop(when + decay + 0.05);
    }
  }

  private bellNote(when: number, freq: number, vol: number, decay: number): void {
    if (!this.ctx || !this.musicBus) return;
    for (const [mult, gain] of [[1, 1], [2.01, 0.28], [3.02, 0.08]] as [number, number][]) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq * mult;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.linearRampToValueAtTime(vol * gain, when + 0.018);
      g.gain.exponentialRampToValueAtTime(0.0003, when + decay);
      osc.connect(g).connect(this.musicBus);
      osc.start(when);
      osc.stop(when + decay + 0.05);
    }
  }
}
