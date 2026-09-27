// Bundle server/server.ts (+ the shared protocol) into dist-server/server.mjs.
// `ws` stays external (a real dependency, resolved from node_modules).
import { build } from 'esbuild';

await build({
  entryPoints: ['server/server.ts'],
  outfile: 'dist-server/server.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  external: ['ws'],
  logLevel: 'warning',
});
console.log('built dist-server/server.mjs');
