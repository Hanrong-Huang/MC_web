// Voxelcraft multiplayer server: serves the built game (dist/) over HTTP and
// runs one shared world over a WebSocket at /ws.
//
// The server is the world's memory, not its simulator: it keeps the seed, the
// latest state of every block anyone changed, each player's save (by name),
// the day clock and who is asleep, and relays poses, block changes and chat.
// See src/net/protocol.ts for the sync model.
//
//   npm run server                 # builds the client + server, then listens on :8080
//   PORT=9000 WORLD=castle npm run server
//
// Environment: PORT (8080), HOST (0.0.0.0), WORLD (world), SEED (random for a
// new world), MODE (survival | creative, for new players), DATA_DIR
// (server-data), STATIC_DIR (dist), MAX_PLAYERS (16).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import {
  PROTOCOL, DEFAULT_PORT, NET_DAY_LENGTH, cleanName, cleanChat,
  type CellState, type ClientMsg, type ServerMsg, type Pose, type PlayerSave, type NetMode,
} from '../src/net/protocol';

const PORT = Number(process.env.PORT ?? DEFAULT_PORT);
const HOST = process.env.HOST ?? '0.0.0.0';
const WORLD = (process.env.WORLD ?? 'world').replace(/[^a-z0-9_-]/gi, '_');
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? 'server-data');
const STATIC_DIR = path.resolve(process.env.STATIC_DIR ?? 'dist');
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS ?? 16);
const MAX_CELLS_PER_MSG = 8192;

// --- world file -------------------------------------------------------------------

interface WorldFile {
  version: 1;
  seed: number;
  mode: NetMode;
  dayTime: number;
  /** `${dim}|${x},${y},${z}` → latest state */
  cells: Record<string, CellState>;
  /** player name → their save */
  players: Record<string, PlayerSave>;
}

const worldPath = path.join(DATA_DIR, `${WORLD}.json`);

function loadWorld(): WorldFile {
  try {
    const w = JSON.parse(fs.readFileSync(worldPath, 'utf8')) as WorldFile;
    if (typeof w.seed === 'number' && w.cells && w.players) return w;
  } catch { /* new world */ }
  const envSeed = process.env.SEED;
  let seed = (Math.random() * 0x7fffffff) | 0;
  if (envSeed) {
    if (/^-?\d+$/.test(envSeed)) seed = parseInt(envSeed, 10) | 0;
    else { seed = 0; for (const ch of envSeed) seed = (Math.imul(seed, 31) + ch.charCodeAt(0)) | 0; }
  }
  const mode: NetMode = process.env.MODE === 'creative' ? 'creative' : 'survival';
  return { version: 1, seed, mode, dayTime: 0.1, cells: {}, players: {} };
}

const world = loadWorld();
let dirty = false;

function saveWorld(): void {
  if (!dirty) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${worldPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(world));
  fs.renameSync(tmp, worldPath);
  dirty = false;
}

// --- players ----------------------------------------------------------------------

interface Conn {
  id: number;
  ws: WebSocket;
  name: string;
  pose: Pose | null;
  sleeping: boolean;
  joined: boolean;
}

const conns = new Map<number, Conn>();
let nextId = 1;

function send(c: Conn, msg: ServerMsg): void {
  if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
}
function broadcast(msg: ServerMsg, except?: Conn): void {
  const data = JSON.stringify(msg);
  for (const c of conns.values()) {
    if (c !== except && c.joined && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
  }
}
function online(): Conn[] {
  return [...conns.values()].filter((c) => c.joined);
}
function system(text: string): void {
  broadcast({ t: 'chat', from: null, text });
  console.log(`[chat] * ${text}`);
}

function validCell(c: unknown): c is CellState {
  const o = c as CellState;
  return !!o && (o.d === 'overworld' || o.d === 'nether') && typeof o.k === 'string' &&
    /^-?\d+,-?\d+,-?\d+$/.test(o.k) && Number.isInteger(o.id) && o.id >= 0 && o.id < 4096;
}

// --- sleeping: the night skips once everyone in the Overworld is in bed ------------

let skipTimer: NodeJS.Timeout | null = null;

function updateSleepers(): void {
  const overworld = online().filter((c) => (c.pose?.dim ?? 'overworld') === 'overworld' && !c.pose?.dead);
  const n = overworld.filter((c) => c.sleeping).length;
  broadcast({ t: 'sleepers', n, total: overworld.length });
  const allAsleep = overworld.length > 0 && n === overworld.length;
  if (allAsleep && !skipTimer) {
    // give the clients' fade-to-black a moment before the sun comes up
    skipTimer = setTimeout(() => {
      skipTimer = null;
      const still = online().filter((c) => (c.pose?.dim ?? 'overworld') === 'overworld' && !c.pose?.dead);
      if (still.length === 0 || still.some((c) => !c.sleeping)) return;
      world.dayTime = 0;
      dirty = true;
      for (const c of still) c.sleeping = false;
      broadcast({ t: 'time', dayTime: world.dayTime, skip: true });
      system('Everyone slept — good morning!');
    }, 1500);
  } else if (!allAsleep && skipTimer) {
    clearTimeout(skipTimer);
    skipTimer = null;
  }
}

// --- messages ---------------------------------------------------------------------

function onMessage(c: Conn, raw: string): void {
  let msg: ClientMsg;
  try { msg = JSON.parse(raw) as ClientMsg; } catch { return; }
  if (!c.joined) {
    if (msg.t !== 'hello') return;
    if (msg.v !== PROTOCOL) {
      send(c, { t: 'error', msg: `Version mismatch (server ${PROTOCOL}, client ${msg.v}). Refresh the page.` });
      c.ws.close();
      return;
    }
    if (online().length >= MAX_PLAYERS) {
      send(c, { t: 'error', msg: 'The server is full.' });
      c.ws.close();
      return;
    }
    let name = cleanName(msg.name);
    const taken = new Set(online().map((o) => o.name.toLowerCase()));
    if (taken.has(name.toLowerCase())) {
      let k = 2;
      while (taken.has(`${name}${k}`.toLowerCase())) k++;
      name = `${name}${k}`;
    }
    c.name = name;
    c.joined = true;
    send(c, {
      t: 'welcome', id: c.id, name, world: WORLD, seed: world.seed, mode: world.mode, dayTime: world.dayTime,
      cells: Object.values(world.cells),
      players: online().filter((o) => o !== c).map((o) => ({ id: o.id, name: o.name, pose: o.pose ?? undefined })),
      you: world.players[name] ?? null,
    });
    broadcast({ t: 'join', id: c.id, name }, c);
    system(`${name} joined the game`);
    return;
  }
  switch (msg.t) {
    case 'pose': {
      const p = msg.p;
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return;
      const wasDim = c.pose?.dim;
      c.pose = p;
      broadcast({ t: 'pose', id: c.id, p }, c);
      if (wasDim !== p.dim) updateSleepers();
      break;
    }
    case 'cells': {
      if (!Array.isArray(msg.cells)) return;
      const cells = msg.cells.slice(0, MAX_CELLS_PER_MSG).filter(validCell);
      if (!cells.length) return;
      for (const cell of cells) world.cells[`${cell.d}|${cell.k}`] = cell;
      dirty = true;
      broadcast({ t: 'cells', from: c.id, cells }, c);
      break;
    }
    case 'chat': {
      const text = cleanChat(msg.text ?? '');
      if (!text) return;
      if (text === '/list') {
        send(c, { t: 'chat', from: null, text: `Online (${online().length}): ${online().map((o) => o.name).join(', ')}` });
        return;
      }
      if (text === '/help') {
        send(c, { t: 'chat', from: null, text: 'Commands: /list — who is online, /time set day|noon|night|midnight|<0-1>, /help' });
        return;
      }
      const tm = /^\/time set (\S+)$/.exec(text);
      if (tm) {
        const named: Record<string, number> = { day: 0.05, noon: 0.25, sunset: 0.48, night: 0.6, midnight: 0.75 };
        const v = named[tm[1]] ?? Number(tm[1]);
        if (!Number.isFinite(v) || v < 0 || v > 1) { send(c, { t: 'chat', from: null, text: 'Usage: /time set day|noon|night|midnight|<0-1>' }); return; }
        world.dayTime = v % 1;
        dirty = true;
        broadcast({ t: 'time', dayTime: world.dayTime });
        system(`${c.name} set the time to ${tm[1]}`);
        return;
      }
      broadcast({ t: 'chat', from: c.name, text });
      console.log(`[chat] <${c.name}> ${text}`);
      break;
    }
    case 'save': {
      if (!msg.save || typeof msg.save !== 'object') return;
      world.players[c.name] = msg.save;
      dirty = true;
      break;
    }
    case 'sleep': {
      c.sleeping = !!msg.on;
      updateSleepers();
      break;
    }
  }
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
    res.end(JSON.stringify({ world: WORLD, players: online().map((c) => c.name), protocol: PROTOCOL }));
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
  const c: Conn = { id: nextId++, ws, name: '', pose: null, sleeping: false, joined: false };
  conns.set(c.id, c);
  ws.on('message', (data) => onMessage(c, data.toString()));
  ws.on('close', () => {
    conns.delete(c.id);
    if (!c.joined) return;
    broadcast({ t: 'leave', id: c.id, name: c.name });
    system(`${c.name} left the game`);
    updateSleepers();
  });
  ws.on('error', () => ws.close());
});

// --- clock + autosave -------------------------------------------------------------

let lastTick = Date.now();
let sinceSync = 0;
setInterval(() => {
  const now = Date.now();
  const dt = (now - lastTick) / 1000;
  lastTick = now;
  world.dayTime = (world.dayTime + dt / NET_DAY_LENGTH) % 1;
  sinceSync += dt;
  if (sinceSync >= 10) { sinceSync = 0; broadcast({ t: 'time', dayTime: world.dayTime }); dirty = true; }
}, 1000);
setInterval(saveWorld, 30_000);

function shutdown(): void {
  dirty = true;
  saveWorld();
  console.log('World saved. Bye!');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

httpServer.listen(PORT, HOST, () => {
  console.log(`Voxelcraft server — world "${WORLD}" (seed ${world.seed}, ${world.mode})`);
  console.log(`  play:   http://localhost:${PORT}/   (friends: http://<this machine's IP>:${PORT}/)`);
  console.log(`  data:   ${worldPath}`);
  if (!fs.existsSync(path.join(STATIC_DIR, 'index.html'))) console.log(`  note:   ${STATIC_DIR} has no index.html — run \`npm run build\` first`);
});
