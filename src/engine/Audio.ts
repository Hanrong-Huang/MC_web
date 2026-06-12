// Web Audio synthesis: dig/place/step sounds per block class, UI clicks,
// hurt/eat/pop effects, and a sparse ambient pad. No audio assets used.

import { SoundClass } from './Blocks';

export type SfxName =
  | 'pop' | 'hurt' | 'hit' | 'eat' | 'burp' | 'click' | 'level'
  | 'explode' | 'bow' | 'snap' | 'fuse' | 'arrowHit';

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private ambientT = 45;

  /** Must be called from a user gesture at least once. */
  ensure(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.35;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    } catch {
      this.ctx = null;
    }
  }

  private noiseBurst(dur: number, freq: number, vol: number, type: BiquadFilterType = 'lowpass', freqEnd?: number): void {
    if (!this.ctx || !this.master || !this.noiseBuf) return;
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
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  private tone(dur: number, f0: number, f1: number, vol: number, type: OscillatorType = 'sine', when = 0): void {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime + when;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** Dig/place sound for a block sound class. */
  dig(cls: SoundClass, vol: number): void {
    this.ensure();
    switch (cls) {
      case 'stone': this.noiseBurst(0.14, 900, 0.5 * vol, 'lowpass', 300); break;
      case 'wood': this.noiseBurst(0.12, 700, 0.4 * vol, 'lowpass', 250); this.tone(0.08, 180, 120, 0.12 * vol, 'square'); break;
      case 'grass': this.noiseBurst(0.12, 2200, 0.3 * vol, 'bandpass', 900); break;
      case 'sand': this.noiseBurst(0.16, 3200, 0.25 * vol, 'highpass'); break;
      case 'glass': this.noiseBurst(0.2, 4200, 0.35 * vol, 'highpass'); this.tone(0.14, 1900, 800, 0.1 * vol, 'triangle'); break;
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
      case 'hurt': this.tone(0.16, 170, 90, 0.4, 'sawtooth'); this.noiseBurst(0.1, 500, 0.2); break;
      case 'hit': this.tone(0.1, 240, 130, 0.3, 'square'); break;
      case 'eat': this.noiseBurst(0.07, 1400, 0.25, 'bandpass'); break;
      case 'burp': this.tone(0.25, 220, 80, 0.3, 'sawtooth'); break;
      case 'click': this.tone(0.035, 850, 700, 0.18, 'square'); break;
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
      case 'arrowHit': this.tone(0.06, 950, 500, 0.2, 'triangle'); this.noiseBurst(0.05, 2000, 0.12, 'bandpass'); break;
    }
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
    }
  }

  /** Gentle ambient pad every couple of minutes. */
  ambientTick(dt: number): void {
    if (!this.ctx) return;
    this.ambientT -= dt;
    if (this.ambientT > 0) return;
    this.ambientT = 100 + Math.random() * 120;
    const roots = [220, 246.9, 196, 174.6];
    const root = roots[(Math.random() * roots.length) | 0];
    for (const [mult, vol] of [[1, 0.05], [1.5, 0.035], [2, 0.03], [2.5, 0.02]] as const) {
      this.pad(root * mult, vol, 7);
    }
  }

  private pad(freq: number, vol: number, dur: number): void {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + dur * 0.4);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }
}
