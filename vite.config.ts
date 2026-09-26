import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  server: { open: false },
  // Tone.js is imported lazily (AudioSamples.ts) through deep paths; pre-bundle
  // them up front so the dev server doesn't reload the page when music starts
  optimizeDeps: {
    include: [
      'tone/build/esm/core/Global.js',
      'tone/build/esm/instrument/Sampler.js',
      'tone/build/esm/core/context/ToneAudioBuffer.js',
    ],
  },
});
