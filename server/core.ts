// The multiplayer world, independent of where it runs: the Node server
// (server/server.ts) and the Cloudflare Durable Object (worker/index.ts) both
// drive one of these. It holds the world's memory (seed, the latest state of
// every edited cell, each player's save by name, the day clock, who's asleep)
// and relays poses, cells and chat between connections. No Node or Workers
// APIs in here: sockets come in through the small Socket interface and
// persistence reads the per-key dirty sets.

import {
  PROTOCOL, NET_DAY_LENGTH, cleanName, cleanChat,
  type CellState, type ClientMsg, type ServerMsg, type Pose, type PlayerSave, type NetMode, type NetWeather,
} from '../src/net/protocol';
import { runCommand } from './commands';

export interface Socket {
  send(data: string): void;
  close(): void;
  /** false once the socket has closed (sends are dropped) */
  readonly open: boolean;
}

export interface WorldData {
  seed: number;
  mode: NetMode;
  dayTime: number;
  /** `${dim}|${x},${y},${z}` → latest state */
  cells: Map<string, CellState>;
  /** player name → their save */
  players: Map<string, PlayerSave>;
  /** player name → /sethome spot */
  homes: Map<string, Place>;
  /** world spawn set by an admin (/setspawn); unset = the seed's spawn */
  spawn?: Place;
  weather: NetWeather;
  /** seconds of the current weather left (the server rolls the next) */
  weatherLeft: number;
}

export interface Place { x: number; y: number; z: number; dim: 'overworld' | 'nether' }

export interface CoreOptions {
  world: string;
  maxPlayers: number;
  /** `/login <password>` makes a player an admin for the session (unset = nobody can) */
  adminPassword?: string;
  log?: (line: string) => void;
}

export interface Conn {
  id: number;
  sock: Socket;
  name: string;
  pose: Pose | null;
  sleeping: boolean;
  joined: boolean;
  /** logged in with the admin password (or /op'd) this session */
  admin: boolean;
  /** a wrong /login locks further tries until then (ms) */
  loginLockUntil?: number;
}

const MAX_CELLS_PER_MSG = 8192;
/** cells per outgoing message: ~60-200 bytes each, well under 1 MiB */
export const CELLS_PER_BATCH = 3000;

/** Seed from text the way the title screen does it (digits = that number, else a string hash). */
export function parseSeed(raw: string | undefined): number {
  if (!raw) return (Math.random() * 0x7fffffff) | 0;
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10) | 0;
  let seed = 0;
  for (const ch of raw) seed = (Math.imul(seed, 31) + ch.charCodeAt(0)) | 0;
  return seed;
}

export function newWorld(seed: number, mode: NetMode): WorldData {
  return { seed, mode, dayTime: 0.1, cells: new Map(), players: new Map(), homes: new Map(), weather: 'clear', weatherLeft: 300 };
}

function validCell(c: unknown): c is CellState {
  const o = c as CellState;
  return !!o && (o.d === 'overworld' || o.d === 'nether') && typeof o.k === 'string' &&
    /^-?\d+,-?\d+,-?\d+$/.test(o.k) && Number.isInteger(o.id) && o.id >= 0 && o.id < 4096;
}

export class WorldCore {
  readonly conns = new Map<number, Conn>();
  private nextId = 1;
  private skipTimer: ReturnType<typeof setTimeout> | null = null;
  private sinceSync = 0;
  /** what changed since the adapter last persisted (it clears these) */
  readonly dirtyCells = new Set<string>();
  readonly dirtyPlayers = new Set<string>();
  dirtyMeta = false;

  constructor(readonly data: WorldData, readonly opts: CoreOptions) {}

  get dirty(): boolean { return this.dirtyMeta || this.dirtyCells.size > 0 || this.dirtyPlayers.size > 0; }

  log(line: string): void { this.opts.log?.(line); }

  online(): Conn[] {
    return [...this.conns.values()].filter((c) => c.joined);
  }

  // --- connections ---------------------------------------------------------------

  connect(sock: Socket): Conn {
    const c: Conn = { id: this.nextId++, sock, name: '', pose: null, sleeping: false, joined: false, admin: false };
    this.conns.set(c.id, c);
    return c;
  }

  disconnect(c: Conn): void {
    if (!this.conns.delete(c.id) || !c.joined) return;
    this.broadcast({ t: 'leave', id: c.id, name: c.name });
    this.system(`${c.name} left the game`);
    this.updateSleepers();
  }

  send(c: Conn, msg: ServerMsg): void {
    if (c.sock.open) c.sock.send(JSON.stringify(msg));
  }

  broadcast(msg: ServerMsg, except?: Conn): void {
    const data = JSON.stringify(msg);
    for (const c of this.conns.values()) {
      if (c !== except && c.joined && c.sock.open) c.sock.send(data);
    }
  }

  system(text: string): void {
    this.broadcast({ t: 'chat', from: null, text });
    this.log(`[chat] * ${text}`);
  }

  // --- the clock (call about once a second) --------------------------------------

  tick(dt: number): void {
    const w = this.data;
    w.dayTime = (w.dayTime + dt / NET_DAY_LENGTH) % 1;
    this.sinceSync += dt;
    if (this.sinceSync >= 10) {
      this.sinceSync = 0;
      this.broadcast({ t: 'time', dayTime: w.dayTime });
      this.dirtyMeta = true;
    }
    // weather is the server's: roll the next spell when this one runs out
    // (the same odds the single-player Weather uses)
    w.weatherLeft -= dt;
    if (w.weatherLeft <= 0) this.setWeather(this.rollWeather());
  }

  private rollWeather(): NetWeather {
    const r = Math.random();
    if (this.data.weather === 'clear') return r < 0.15 ? 'thunder' : 'rain';
    if (this.data.weather === 'rain' && r < 0.3) return 'thunder';
    return 'clear';
  }

  setWeather(kind: NetWeather, seconds?: number): void {
    const w = this.data;
    w.weather = kind;
    w.weatherLeft = seconds ?? (kind === 'clear' ? 100 + Math.random() * 160 : kind === 'rain' ? 80 + Math.random() * 120 : 50 + Math.random() * 70);
    this.dirtyMeta = true;
    this.broadcast({ t: 'weather', kind });
  }

  /** A joined player by name: exact (any case) first, then a unique prefix. */
  findPlayer(name: string): Conn | null {
    const on = this.online();
    const n = name.toLowerCase();
    const exact = on.find((c) => c.name.toLowerCase() === n);
    if (exact) return exact;
    const pre = on.filter((c) => c.name.toLowerCase().startsWith(n));
    return pre.length === 1 ? pre[0] : null;
  }

  // --- sleeping: the night skips once everyone in the Overworld is in bed ------------

  private awakeCandidates(): Conn[] {
    return this.online().filter((c) => (c.pose?.dim ?? 'overworld') === 'overworld' && !c.pose?.dead);
  }

  private updateSleepers(): void {
    const overworld = this.awakeCandidates();
    const n = overworld.filter((c) => c.sleeping).length;
    this.broadcast({ t: 'sleepers', n, total: overworld.length });
    const allAsleep = overworld.length > 0 && n === overworld.length;
    if (allAsleep && !this.skipTimer) {
      // give the clients' fade-to-black a moment before the sun comes up
      this.skipTimer = setTimeout(() => {
        this.skipTimer = null;
        const still = this.awakeCandidates();
        if (still.length === 0 || still.some((c) => !c.sleeping)) return;
        this.data.dayTime = 0;
        this.dirtyMeta = true;
        for (const c of still) c.sleeping = false;
        this.broadcast({ t: 'time', dayTime: 0, skip: true });
        if (this.data.weather !== 'clear') this.setWeather('clear'); // vanilla: sleeping clears the storm
        this.system('Everyone slept — good morning!');
      }, 1500);
    } else if (!allAsleep && this.skipTimer) {
      clearTimeout(this.skipTimer);
      this.skipTimer = null;
    }
  }

  // --- messages ---------------------------------------------------------------------

  message(c: Conn, raw: string): void {
    let msg: ClientMsg;
    try { msg = JSON.parse(raw) as ClientMsg; } catch { return; }
    const w = this.data;
    if (!c.joined) {
      if (msg.t !== 'hello') return;
      if (msg.v !== PROTOCOL) {
        this.send(c, { t: 'error', msg: `Version mismatch (server ${PROTOCOL}, client ${msg.v}). Refresh the page.` });
        c.sock.close();
        return;
      }
      if (this.online().length >= this.opts.maxPlayers) {
        this.send(c, { t: 'error', msg: 'The server is full.' });
        c.sock.close();
        return;
      }
      let name = cleanName(msg.name);
      const taken = new Set(this.online().map((o) => o.name.toLowerCase()));
      if (taken.has(name.toLowerCase())) {
        let k = 2;
        while (taken.has(`${name}${k}`.toLowerCase())) k++;
        name = `${name}${k}`;
      }
      c.name = name;
      c.joined = true;
      this.send(c, {
        t: 'welcome', id: c.id, name, world: this.opts.world, seed: w.seed, mode: w.mode, dayTime: w.dayTime,
        cells: [], weather: w.weather,
        players: this.online().filter((o) => o !== c).map((o) => ({ id: o.id, name: o.name, pose: o.pose ?? undefined })),
        you: w.players.get(name) ?? null,
      });
      // the edit log follows in batches (hosted WebSockets cap a message at ~1 MiB)
      const all = [...w.cells.values()];
      for (let i = 0; i < all.length; i += CELLS_PER_BATCH) {
        this.send(c, { t: 'cells', from: 0, cells: all.slice(i, i + CELLS_PER_BATCH) });
      }
      this.broadcast({ t: 'join', id: c.id, name }, c);
      this.system(`${name} joined the game`);
      return;
    }
    switch (msg.t) {
      case 'pose': {
        const p = msg.p;
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return;
        const wasDim = c.pose?.dim;
        c.pose = p;
        this.broadcast({ t: 'pose', id: c.id, p }, c);
        if (wasDim !== p.dim) this.updateSleepers();
        break;
      }
      case 'cells': {
        if (!Array.isArray(msg.cells)) return;
        const cells = msg.cells.slice(0, MAX_CELLS_PER_MSG).filter(validCell);
        if (!cells.length) return;
        for (const cell of cells) {
          const key = `${cell.d}|${cell.k}`;
          w.cells.set(key, cell);
          this.dirtyCells.add(key);
        }
        this.broadcast({ t: 'cells', from: c.id, cells }, c);
        break;
      }
      case 'chat': {
        const text = cleanChat(msg.text ?? '');
        if (!text) return;
        if (text.startsWith('/')) { runCommand(this, c, text); return; }
        this.broadcast({ t: 'chat', from: c.name, text });
        this.log(`[chat] <${c.name}> ${text}`);
        break;
      }
      case 'save': {
        if (!msg.save || typeof msg.save !== 'object') return;
        w.players.set(c.name, msg.save);
        this.dirtyPlayers.add(c.name);
        break;
      }
      case 'sleep': {
        // (the night skips below; sleeping players also let the weather clear)
        c.sleeping = !!msg.on;
        this.updateSleepers();
        break;
      }
    }
  }

  status(): { world: string; players: string[]; protocol: number } {
    return { world: this.opts.world, players: this.online().map((c) => c.name), protocol: PROTOCOL };
  }
}
