# Credits

Everything not listed here (textures, mobs, sound effects, ambience, synth
instruments) is generated procedurally in code.

## Libraries

| Library | License | Use |
|---|---|---|
| [three.js](https://threejs.org/) | MIT | WebGL rendering |
| [Tone.js](https://tonejs.github.io/) | MIT | `Sampler` playback of the sampled music instruments (loaded lazily) |

## Audio samples (`public/audio/`)

The files are trimmed, level-matched, faded and re-encoded (32 kHz MP3) by
`scripts/encode-samples.mjs` from the originals fetched by
`scripts/fetch-samples.sh`.

| Folder | Source | Author | License |
|---|---|---|---|
| `piano/` | [Salamander Grand Piano V3](https://archive.org/details/SalamanderGrandPianoV3) (velocity layer 6, via [sfzinstruments/SalamanderGrandPiano](https://github.com/sfzinstruments/SalamanderGrandPiano)) | Alexander Holm | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) |
| `harp/` | [VSCO 2: Community Edition](https://versilian-studios.com/vsco-community/) — Strings/Harp (mf) | Versilian Studios / Sam Gossner | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `cello/` | VSCO 2: CE — Cello Section, sustain vibrato (soft layer) | Versilian Studios / Sam Gossner | CC0 1.0 |
| `strings/` | VSCO 2: CE — Cello, Viola and Violin Section sustain vibrato (soft layer), mapped low→high | Versilian Studios / Sam Gossner | CC0 1.0 |
| `flute/` | VSCO 2: CE — Flute, sustain vibrato | Versilian Studios / Sam Gossner | CC0 1.0 |

VSCO 2 CE source: <https://github.com/sgossner/VSCO-2-CE>. The piano samples
are modified from the original (trimmed to 4–9 s, faded, downmixed to 32 kHz
MP3); the CC BY 3.0 attribution above covers that use.
