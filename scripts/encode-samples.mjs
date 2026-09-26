// Trim, level-match and compress the raw source samples into the repo's
// public/audio/<inst>/<Note>.mp3 set (32 kHz; piano stereo, the rest mono).
// Dev tool, not app code. Run fetch-samples.sh <work> first, then:
//   FFMPEG=<path to ffmpeg> node scripts/encode-samples.mjs <work> public/audio
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const S = process.argv[2]; // work dir holding raw/<inst>/...
const FF = process.env.FFMPEG ?? 'ffmpeg';
const OUT = process.argv[3];
if (!S || !OUT) throw new Error('usage: node encode-samples.mjs <work dir> <repo>/public/audio');
const SR = 32000;
const NAMES = ['C', 'Cs', 'D', 'Ds', 'E', 'F', 'Fs', 'G', 'Gs', 'A', 'As', 'B'];
const nm = (m) => NAMES[m % 12] + (Math.floor(m / 12) - 1);

// [instrument, source subdir, source file stem, real MIDI pitch]
// VSCO strings/winds name middle C "C3", so their real pitch is the name + 12.
const SETS = {
  piano: { stereo: true, kbps: 72, len: (m) => (m < 50 ? 9 : m < 70 ? 8 : m < 82 ? 6 : 4), norm: false, files: [
    ['C1', 24], ['Fs1', 30], ['C2', 36], ['Ds2', 39], ['Fs2', 42], ['A2', 45], ['C3', 48], ['Ds3', 51], ['Fs3', 54], ['A3', 57],
    ['C4', 60], ['Ds4', 63], ['Fs4', 66], ['A4', 69], ['C5', 72], ['Ds5', 75], ['Fs5', 78], ['A5', 81], ['C6', 84], ['Fs6', 90], ['C7', 96],
  ].map(([f, m]) => ['piano', f + '.flac', m]) },
  harp: { kbps: 48, len: (m) => (m < 50 ? 6 : m < 70 ? 5 : 3.5), norm: 'pluck', files: [
    ['D2_mf', 38], ['A2_mf', 45], ['E3_mf', 52], ['G3_mf', 55], ['B3_mf', 59], ['D4_mf', 62], ['F4_mf', 65], ['A4_mf', 69],
    ['C5_mf', 72], ['E5_mf', 76], ['G5_mf', 79], ['B5_mf', 83], ['D6_mf', 86],
  ].map(([f, m]) => ['harp', f + '.wav', m]) },
  cello: { kbps: 48, len: () => 7.5, norm: 'sus', files: [
    ['C1', 36], ['E1', 40], ['G1', 43], ['B1', 47], ['D2', 50], ['F2', 53], ['A2', 57], ['C3', 60], ['E3', 64],
  ].map(([f, m]) => ['cello', f + '.wav', m]) },
  // string ensemble: cello section at the bottom, violas in the middle, violins on top
  strings: { kbps: 48, len: () => 7.5, norm: 'sus', files: [
    ['cello', 'G1', 43], ['cello', 'B1', 47], ['viola', 'D2', 50], ['viola', 'E2', 52], ['viola', 'G2', 55], ['viola', 'B2', 59],
    ['viola', 'D3', 62], ['viola', 'F3', 65], ['viola', 'A3', 69], ['violin', 'C4', 72], ['violin', 'E4', 76], ['violin', 'G4', 79],
  ].map(([d, f, m]) => [d, f + '.wav', m]) },
  flute: { kbps: 48, len: () => 6, norm: 'sus', files: [
    ['C3', 60], ['E3', 64], ['A3', 69], ['C4', 72], ['E4', 76], ['A4', 81], ['C5', 84], ['E5', 88],
  ].map(([f, m]) => ['flute', f + '.wav', m]) },
};

function decode(file) {
  const buf = execFileSync(FF, ['-nostdin', '-v', 'quiet', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
const rms = (x, a, b) => { let s = 0; b = Math.min(b, x.length); for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); };

let total = 0;
const report = [];
// piano: one gain for the whole set (keeps the instrument's own register balance)
let pianoPeak = 0;
for (const [d, f] of SETS.piano.files) { const x = decode(join(S, 'raw', d, f)); for (const v of x) pianoPeak = Math.max(pianoPeak, Math.abs(v)); }

for (const [inst, set] of Object.entries(SETS)) {
  const dir = join(OUT, inst);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [d, f, midi] of set.files) {
    const src = join(S, 'raw', d, f);
    const x = decode(src);
    let peak = 0;
    for (const v of x) peak = Math.max(peak, Math.abs(v));
    let onset = 0;
    for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > peak * 0.02) { onset = i; break; }
    const start = Math.max(0, onset / SR - 0.006);
    const len = Math.min(set.len(midi), x.length / SR - start);
    let gainDb;
    if (!set.norm) gainDb = 20 * Math.log10(0.7 / pianoPeak);
    else {
      // level-match: a pluck by its first half second, a sustain by its body
      const a = onset + (set.norm === 'pluck' ? 0 : Math.floor(0.4 * SR));
      const r = rms(x, a, a + Math.floor((set.norm === 'pluck' ? 0.5 : 2) * SR));
      gainDb = 20 * Math.log10((set.norm === 'pluck' ? 0.12 : 0.1) / r);
      gainDb = Math.min(gainDb, 20 * Math.log10(0.89 / peak));
    }
    const fade = Math.min(1.5, len * 0.3);
    const out = join(dir, nm(midi) + '.mp3');
    execFileSync(FF, ['-nostdin', '-v', 'error', '-y', '-ss', start.toFixed(4), '-t', len.toFixed(3), '-i', src,
      '-af', `volume=${gainDb.toFixed(2)}dB,afade=t=out:st=${(len - fade).toFixed(3)}:d=${fade.toFixed(3)}`,
      '-ac', set.stereo ? '2' : '1', '-ar', String(SR), '-c:a', 'libmp3lame', '-b:a', set.kbps + 'k', '-map_metadata', '-1', out], { stdio: ['ignore', 'pipe', 'pipe'] });
    const sz = statSync(out).size;
    total += sz;
    report.push(`${inst.padEnd(8)} ${nm(midi).padEnd(4)} ${String(midi).padStart(3)}  ${len.toFixed(1)}s  gain ${gainDb.toFixed(1).padStart(6)} dB  ${(sz / 1024).toFixed(0).padStart(4)} KB`);
  }
}
console.log(report.join('\n'));
for (const inst of Object.keys(SETS)) {
  const t = readdirSync(join(OUT, inst)).reduce((s, f) => s + statSync(join(OUT, inst, f)).size, 0);
  console.log(`${inst}: ${(t / 1024).toFixed(0)} KB`);
}
console.log(`total ${(total / 1024 / 1024).toFixed(2)} MB`);
