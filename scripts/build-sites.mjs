import { cp, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const root = process.cwd();
const dist = join(root, 'dist');
const client = join(dist, 'client');
const server = join(dist, 'server');

await rm(client, { recursive: true, force: true });
await mkdir(client, { recursive: true });

for (const entry of await readdir(dist)) {
  if (entry === 'client' || entry === 'server' || entry === '.openai') {
    continue;
  }

  await rename(join(dist, entry), join(client, entry));
}

await mkdir(server, { recursive: true });
await writeFile(
  join(server, 'index.js'),
  `export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404 || !request.headers.get('accept')?.includes('text/html')) {
      return response;
    }

    const url = new URL('/index.html', request.url);
    return env.ASSETS.fetch(new Request(url, request));
  },
};
`,
);

await mkdir(join(dist, '.openai'), { recursive: true });
await cp(join(root, '.openai', 'hosting.json'), join(dist, '.openai', 'hosting.json'));
