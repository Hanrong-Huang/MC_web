// The multiplayer world, independent of where it runs: the Node server
// (server/server.ts) and the Cloudflare Durable Object (worker/index.ts) both
// drive one of these. It holds the world's memory (seed, the latest state of
// every edited cell, each player's save by name, the day clock, who's asleep)
// and relays poses, cells and chat between connections. No Node or Workers
// APIs in here: sockets come in through the small Socket interface and
// persistence reads the per-key dirty sets.

import {
  PROTOCOL, NET_DAY_LENGTH, cleanName, cleanChat,
  ENT_FLAGS,
  type CellState, type ClientMsg, type ServerMsg, type Pose, type PlayerSave, type NetMode, type NetWeather, type EntState,
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
/** entity updates only go to players within this many blocks (same dimension) */
const ENT_RELAY_RANGE = 160;
/** an owner this far from its entity hands it to a player ≥ HANDOFF_MARGIN closer */
const HANDOFF_DIST = 48;
const HANDOFF_MARGIN = 16;
const MAX_ENTS_PER_OWNER = 800;

/** A networked entity as the server tracks it: who simulates it + its latest state. */
interface NetEnt { owner: number; s: EntState }

function validEnt(s: unknown): s is EntState {
  const o = s as EntState;
  return !!o && typeof o.n === 'string' && o.n.length < 40 && typeof o.k === 'string' &&
    (o.d === 'overworld' || o.d === 'nether') && Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.z);
}
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
  private sinceRebalance = 0;
  /** networked entities (not persisted: mobs respawn, drops are short-lived) */
  readonly ents = new Map<string, NetEnt>();
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
    this.orphan(c);
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
    this.sinceRebalance += dt;
    if (this.sinceRebalance >= 2) { this.sinceRebalance = 0; this.rebalance(); }
  }

  // --- networked entities --------------------------------------------------------

  private dist2(c: Conn, s: EntState): number {
    const p = c.pose;
    if (!p || p.dim !== s.d) return Infinity;
    return Math.hypot(p.x - s.x, p.z - s.z);
  }

  /** Another player's pet or the mount someone is riding stays with its owner. */
  private protectedFrom(e: NetEnt, c: Conn): boolean {
    if (e.s.on && e.s.on !== c.name) return true;
    return !!((e.s.f ?? 0) & ENT_FLAGS.ridden) && e.owner !== c.id;
  }

  private nearestTo(s: EntState, except?: Conn): { c: Conn; d: number } | null {
    let best: { c: Conn; d: number } | null = null;
    for (const o of this.online()) {
      if (o === except) continue;
      const d = this.dist2(o, s);
      if (d < (best?.d ?? Infinity)) best = { c: o, d };
    }
    return best;
  }

  private setOwner(id: string, e: NetEnt, owner: Conn): void {
    e.owner = owner.id;
    this.broadcast({ t: 'owner', id, owner: owner.id, s: e.s });
  }

  private drop(ids: string[], why: 'die' | 'pick' | 'despawn' | 'capture', except?: Conn): void {
    for (const id of ids) this.ents.delete(id);
    if (ids.length) this.broadcast({ t: 'egone', ids, why }, except);
  }

  /** A player left: their pets go with them; the rest pass to the nearest player in range. */
  private orphan(c: Conn): void {
    const gone: string[] = [];
    for (const [id, e] of this.ents) {
      if (e.owner !== c.id) continue;
      if (e.s.on === c.name) { gone.push(id); continue; }
      const heir = this.nearestTo(e.s, c);
      if (heir && heir.d < ENT_RELAY_RANGE) this.setOwner(id, e, heir.c);
      else gone.push(id);
    }
    this.drop(gone, 'despawn');
  }

  /** Every 2 s: an entity its owner has walked away from goes to someone nearer. */
  private rebalance(): void {
    for (const [id, e] of this.ents) {
      const owner = this.conns.get(e.owner);
      if (!owner) continue;
      const ownerD = this.dist2(owner, e.s);
      if (ownerD < HANDOFF_DIST) continue;
      const best = this.nearestTo(e.s, owner);
      if (!best || best.d > ownerD - HANDOFF_MARGIN || this.protectedFrom(e, best.c)) continue;
      this.setOwner(id, e, best.c);
    }
  }

  private relayEnts(from: Conn, list: EntState[]): void {
    if (!list.length) return;
    for (const o of this.online()) {
      if (o === from || !o.pose) continue;
      const near = list.filter((s) => this.dist2(o, s) < ENT_RELAY_RANGE);
      if (near.length) this.send(o, { t: 'ents', from: from.id, list: near });
    }
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
      case 'ents': {
        if (!Array.isArray(msg.list)) return;
        let mine = 0;
        for (const e of this.ents.values()) if (e.owner === c.id) mine++;
        const ok: EntState[] = [];
        for (const s of msg.list.slice(0, 600)) {
          if (!validEnt(s)) continue;
          const cur = this.ents.get(s.n);
          if (cur && cur.owner !== c.id) continue; // no longer theirs
          if (!cur) { if (mine >= MAX_ENTS_PER_OWNER) continue; mine++; }
          this.ents.set(s.n, { owner: c.id, s: cur ? { ...cur.s, ...s } : s });
          ok.push(s);
        }
        this.relayEnts(c, ok);
        break;
      }
      case 'egone': {
        if (!Array.isArray(msg.ids)) return;
        const ids = msg.ids.filter((id) => this.ents.get(id)?.owner === c.id);
        this.drop(ids, msg.why ?? 'despawn', c);
        break;
      }
      case 'take': {
        const e = this.ents.get(msg.id);
        if (!e) { this.send(c, { t: 'egone', ids: [msg.id], why: 'despawn' }); return; }
        if (e.owner === c.id) return;
        if (this.protectedFrom(e, c)) { this.send(c, { t: 'owner', id: msg.id, owner: e.owner, s: e.s }); return; }
        this.setOwner(msg.id, e, c);
        break;
      }
      case 'pick': {
        const e = this.ents.get(msg.id);
        if (!e || e.s.k !== 'drop') { this.send(c, { t: 'egone', ids: [msg.id], why: 'pick' }); return; }
        this.ents.delete(msg.id);
        this.send(c, { t: 'picked', id: msg.id, s: e.s });
        this.broadcast({ t: 'egone', ids: [msg.id], why: 'pick' }, c);
        break;
      }
      case 'phurt': {
        const t = this.conns.get(msg.to);
        if (t?.joined && msg.h && Number.isFinite(msg.h.dmg)) this.send(t, { t: 'phurt', from: c.id, h: msg.h });
        break;
      }
      case 'fx': {
        const fx = msg.fx;
        if (!fx || !Number.isFinite(fx.x) || !Number.isFinite(fx.z)) return;
        for (const o of this.online()) {
          if (o === c || !o.pose || o.pose.dim !== c.pose?.dim) continue;
          if (Math.hypot(o.pose.x - fx.x, o.pose.z - fx.z) < 200) this.send(o, { t: 'fx', from: c.id, fx });
        }
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
