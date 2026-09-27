// Voxelcraft multiplayer server for Node: serves the built game (dist/) over
// HTTP and runs one shared world (server/core.ts) over a WebSocket at /ws,
// saved as JSON in DATA_DIR. (worker/index.ts runs the same world core on
// Cloudflare instead.) See src/net/protocol.ts for the sync model.
//
//   npm run server                 # builds the client + server, then listens on :8080
//   PORT=9000 WORLD=castle npm run server
//
// Environment: PORT (8080), HOST (0.0.0.0), WORLD (world), SEED (random for a
// new world), MODE (survival | creative, for new players), DATA_DIR
// (server-data), STATIC_DIR (dist), MAX_PLAYERS (16), ADMIN_PASSWORD (for
// `/login`; a random one is made and printed at start when unset).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { DEFAULT_PORT, type CellState, type PlayerSave, type NetMode } from '../src/net/protocol';
import { randomBytes } from 'node:crypto';
import { WorldCore, newWorld, parseSeed, type WorldData, type Place } from './core';

const PORT = Number(process.env.PORT ?? DEFAULT_PORT);
const HOST = process.env.HOST ?? '0.0.0.0';
const WORLD = (process.env.WORLD ?? 'world').replace(/[^a-z0-9_-]/gi, '_');
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? 'server-data');
const STATIC_DIR = path.resolve(process.env.STATIC_DIR ?? 'dist');
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS ?? 16);

// --- world file -------------------------------------------------------------------

interface WorldFile {
  version: 1;
  seed: number;
  mode: NetMode;
  dayTime: number;
  cells: Record<string, CellState>;
  players: Record<string, PlayerSave>;
  homes?: Record<string, Place>;
  spawn?: Place;
  weather?: WorldData['weather'];
  weatherLeft?: number;
}

const worldPath = path.join(DATA_DIR, `${WORLD}.json`);

function loadWorld(): WorldData {
  try {
    const w = JSON.parse(fs.readFileSync(worldPath, 'utf8')) as WorldFile;
    if (typeof w.seed === 'number' && w.cells && w.players) {
      return {
        seed: w.seed, mode: w.mode, dayTime: w.dayTime ?? 0.1,
        cells: new Map(Object.entries(w.cells)), players: new Map(Object.entries(w.players)),
        homes: new Map(Object.entries(w.homes ?? {})), ...(w.spawn ? { spawn: w.spawn } : {}),
        weather: w.weather ?? 'clear', weatherLeft: w.weatherLeft ?? 300,
      };
    }
  } catch { /* new world */ }
  return newWorld(parseSeed(process.env.SEED), process.env.MODE === 'creative' ? 'creative' : 'survival');
}

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || randomBytes(6).toString('base64url');
const core = new WorldCore(loadWorld(), { world: WORLD, maxPlayers: MAX_PLAYERS, adminPassword: ADMIN_PASSWORD, log: (l) => console.log(l) });

function saveWorld(force = false): void {
  if (!core.dirty && !force) return;
  const w = core.data;
  const file: WorldFile = {
    version: 1, seed: w.seed, mode: w.mode, dayTime: w.dayTime,
    cells: Object.fromEntries(w.cells), players: Object.fromEntries(w.players),
    homes: Object.fromEntries(w.homes), ...(w.spawn ? { spawn: w.spawn } : {}),
    weather: w.weather, weatherLeft: w.weatherLeft,
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${worldPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file));
  fs.renameSync(tmp, worldPath);
  core.dirtyCells.clear();
  core.dirtyPlayers.clear();
  core.dirtyMeta = false;
}

// --- HTTP (static client) ---------------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8',
};

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/status') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(core.status()));
    return;
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(STATIC_DIR, rel);
  // stay inside STATIC_DIR (a bare prefix test would also admit a sibling like dist-server/)
  if (!file.startsWith(STATIC_DIR + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) {
      if (rel === '/index.html') {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('The game client is not built yet: run `npm run build` (or use `npm run server`, which builds it).');
        return;
      }
      res.writeHead(404); res.end('Not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 8 * 1024 * 1024 });
wss.on('connection', (ws) => {
  const c = core.connect({
    send: (d) => ws.send(d),
    close: () => ws.close(),
    get open() { return ws.readyState === WebSocket.OPEN; },
  });
  ws.on('message', (data) => core.message(c, data.toString()));
  ws.on('close', () => core.disconnect(c));
  ws.on('error', () => ws.close());
});

// --- clock + autosave -------------------------------------------------------------

let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  core.tick((now - lastTick) / 1000);
  lastTick = now;
}, 1000);
setInterval(() => saveWorld(), 30_000);

function shutdown(): void {
  saveWorld(true);
  console.log('World saved. Bye!');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Windows has no SIGINT for child processes: a parent (the test harness) asks over IPC
process.on('message', (m) => { if (m === 'shutdown') shutdown(); });

httpServer.listen(PORT, HOST, () => {
  console.log(`Voxelcraft server — world "${WORLD}" (seed ${core.data.seed}, ${core.data.mode})`);
  console.log(`  play:   http://localhost:${PORT}/   (friends: http://<this machine's IP>:${PORT}/)`);
  console.log(`  data:   ${worldPath}`);
  console.log(`  admin:  type /login ${process.env.ADMIN_PASSWORD ? '<ADMIN_PASSWORD>' : ADMIN_PASSWORD} in chat`);
  if (!fs.existsSync(path.join(STATIC_DIR, 'index.html'))) console.log(`  note:   ${STATIC_DIR} has no index.html — run \`npm run build\` first`);
});
