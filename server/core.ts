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
import { B, I, CAPTURABLE, ENCHANTS, def, hasDef } from '../src/engine/Blocks';
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

type ContainerKind = 'chest' | 'furnace';

const SLOT_KEYS = new Set(['id', 'count', 'dur', 'mob', 'ench']);
const FURNACE_KEYS = new Set([
  'type', 'input', 'fuel', 'output', 'burn', 'burnTotal', 'cook', 'pendingXp', 'pendingIron',
]);
const CHEST_SIZE = 27;
const MAX_FURNACE_BURN = 1000; // lava bucket, the longest registered fuel
const MAX_FURNACE_COOK = 10;
const MAX_FURNACE_XP = 128; // one full output stack at this game's maximum XP per smelt

function objectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function containerKind(id: number): ContainerKind | null {
  if (id === B.CHEST || id === B.CHEST_LOOT || id === B.BARREL) return 'chest';
  if (id === B.FURNACE || id === B.FURNACE_LIT) return 'furnace';
  return null;
}

/** Strict wire validation keeps a malformed stack from reaching def() calls
 *  in the HUD/furnace after the cell is replayed to every client. */
function validSlot(value: unknown): boolean {
  if (value === null) return true;
  if (!objectRecord(value) || Object.keys(value).some((key) => !SLOT_KEYS.has(key))) return false;
  const id = value.id;
  const count = value.count;
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= B.AIR || !hasDef(id)) return false;
  const item = def(id);
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > item.stack) return false;

  if (value.dur !== undefined) {
    if (!item.durability || typeof value.dur !== 'number' || !Number.isInteger(value.dur) ||
      value.dur < 1 || value.dur > item.durability) return false;
  }

  if (value.mob !== undefined) {
    if (id !== I.MOB_CATCHER_FILLED || typeof value.mob !== 'string' || !CAPTURABLE.has(value.mob)) return false;
  } else if (id === I.MOB_CATCHER_FILLED) return false;

  if (value.ench !== undefined) {
    if (!objectRecord(value.ench)) return false;
    const entries = Object.entries(value.ench);
    if (entries.length > ENCHANTS.length) return false;
    for (const [enchId, level] of entries) {
      const enchant = ENCHANTS.find((candidate) => candidate.id === enchId);
      if (!enchant || !enchant.fits(item) || typeof level !== 'number' || !Number.isInteger(level) ||
        level < 1 || level > enchant.max) return false;
    }
  }
  return true;
}

function validBlockEntity(be: unknown, kind: ContainerKind): boolean {
  if (!objectRecord(be)) return false;
  if (kind === 'chest') {
    if (Object.keys(be).some((key) => key !== 'type' && key !== 'slots') ||
      be.type !== 'chest' || !Array.isArray(be.slots) || be.slots.length > CHEST_SIZE) return false;
    return be.slots.every(validSlot);
  }

  if (Object.keys(be).some((key) => !FURNACE_KEYS.has(key)) || be.type !== 'furnace' ||
    !validSlot(be.input) || !validSlot(be.fuel) || !validSlot(be.output)) return false;
  const burn = be.burn;
  const burnTotal = be.burnTotal;
  const cook = be.cook;
  const pendingXp = be.pendingXp;
  const pendingIron = be.pendingIron;
  return typeof burn === 'number' && Number.isFinite(burn) && burn >= 0 && burn <= MAX_FURNACE_BURN &&
    typeof burnTotal === 'number' && Number.isFinite(burnTotal) && burnTotal >= 0 && burnTotal <= MAX_FURNACE_BURN &&
    burn <= burnTotal && typeof cook === 'number' && Number.isFinite(cook) && cook >= 0 && cook <= MAX_FURNACE_COOK &&
    (pendingXp === undefined || (typeof pendingXp === 'number' && Number.isInteger(pendingXp) &&
      pendingXp >= 0 && pendingXp <= MAX_FURNACE_XP)) &&
    (pendingIron === undefined || typeof pendingIron === 'boolean');
}

function validCell(c: unknown): c is CellState {
  const o = c as CellState;
  if (!o || (o.d !== 'overworld' && o.d !== 'nether') || typeof o.k !== 'string' ||
    !/^-?\d+,-?\d+,-?\d+$/.test(o.k) || !Number.isInteger(o.id) || o.id < 0 || o.id >= 4096) return false;
  if (o.be !== undefined) {
    const kind = containerKind(o.id);
    if (!kind || !validBlockEntity(o.be, kind)) return false;
  }
  return true;
}

function validContainerCommit(cell: CellState, current: CellState | undefined, save: unknown): save is PlayerSave {
  if (!objectRecord(save) || (save.gameMode !== 'survival' && save.gameMode !== 'creative') ||
    save.dimension !== cell.d || !objectRecord(save.player) || !objectRecord(save.inventory)) return false;

  // Destruction legitimately snapshots AIR with no block entity, but only
  // after this lease has established that the authoritative cell is a container.
  if (cell.id === B.AIR) return cell.be === undefined && !!current && containerKind(current.id) !== null;

  const nextKind = containerKind(cell.id);
  if (!nextKind || !cell.be || !validBlockEntity(cell.be, nextKind)) return false;
  if (!current) return true; // first baseline for an untouched generated container

  const currentKind = containerKind(current.id);
  if (!currentKind || currentKind !== nextKind) return false;
  // Chests can shed their generated-loot marker; barrels never turn into chests.
  if ((current.id === B.BARREL) !== (cell.id === B.BARREL)) return false;
  return true;
}

/** Progress updates from the lease owner may use the ordinary cell stream, but
 *  that stream must never destroy or replace the leased container. Inventory
 *  transfers and intentional destruction use containerCommit instead. */
function validLeasedCellUpdate(cell: CellState, current: CellState | undefined): boolean {
  if (!current || !cell.be) return false;
  const currentKind = containerKind(current.id);
  const nextKind = containerKind(cell.id);
  if (!currentKind || currentKind !== nextKind) return false;
  if ((current.id === B.BARREL) !== (cell.id === B.BARREL)) return false;
  // Chests have no background state to advance. An identical flush after the
  // initial atomic baseline is harmless, but every actual inventory edit must
  // stay paired with the player's save in containerCommit.
  if (currentKind === 'chest') return JSON.stringify(cell) === JSON.stringify(current);
  if (current.be?.type !== 'furnace' || cell.be.type !== 'furnace') return false;
  // A leased furnace still animates burn/cook progress. Permit that ordinary
  // update only while all three item slots remain byte-for-byte unchanged.
  return JSON.stringify([cell.be.input, cell.be.fuel, cell.be.output]) ===
    JSON.stringify([current.be.input, current.be.fuel, current.be.output]);
}

function validContainerRef(d: unknown, k: unknown): boolean {
  return (d === 'overworld' || d === 'nether') && typeof k === 'string' && /^-?\d+,-?\d+,-?\d+$/.test(k);
}

export class WorldCore {
  readonly conns = new Map<number, Conn>();
  /** One editor per chest/furnace. Clients commit each item change while the
   *  lease is held; close or disconnect releases it. */
  private readonly containerLocks = new Map<string, number>();
  private readonly clientContainer = new Map<number, string>();
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
    this.releaseContainer(c.id);
    this.orphan(c);
    this.broadcast({ t: 'leave', id: c.id, name: c.name });
    this.system(`${c.name} left the game`);
    this.updateSleepers();
  }

  private releaseContainer(clientId: number, expected?: string): void {
    const held = this.clientContainer.get(clientId);
    if (held && (expected === undefined || held === expected)) {
      if (this.containerLocks.get(held) === clientId) {
        this.containerLocks.delete(held);
        this.broadcastContainerLock(held, null);
      }
      this.clientContainer.delete(clientId);
    }
  }

  private broadcastContainerLock(key: string, owner: number | null, only?: Conn): void {
    const bar = key.indexOf('|');
    if (bar < 0) return;
    const msg: ServerMsg = {
      t: 'containerLock', d: key.slice(0, bar) as CellState['d'], k: key.slice(bar + 1), owner,
    };
    if (only) this.send(only, msg);
    else this.broadcast(msg);
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
      // Locks are transient rather than persisted, but a joining client must
      // know about every lease before it can safely destroy a container.
      for (const [key, owner] of this.containerLocks) this.broadcastContainerLock(key, owner, c);
      this.broadcast({ t: 'join', id: c.id, name }, c);
      this.system(`${name} joined the game`);
      return;
    }
    switch (msg.t) {
      case 'pose': {
        const p = msg.p;
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return;
        if (p.view !== undefined) p.view = Number.isFinite(p.view) ? Math.max(2, Math.min(32, Math.floor(p.view))) : 8;
        const wasDim = c.pose?.dim;
        c.pose = p;
        this.broadcast({ t: 'pose', id: c.id, p }, c);
        if (wasDim !== p.dim) this.updateSleepers();
        break;
      }
      case 'container': {
        if (!validContainerRef(msg.d, msg.k)) return;
        const key = `${msg.d}|${msg.k}`;
        if (msg.op === 'close') {
          this.releaseContainer(c.id, key);
          break;
        }
        if (msg.op !== 'open' || !Number.isInteger(msg.req) || msg.req < 1) return;
        const ownerId = this.containerLocks.get(key);
        if (ownerId !== undefined && ownerId !== c.id) {
          const owner = this.conns.get(ownerId);
          this.send(c, {
            t: 'container', d: msg.d, k: msg.k, req: msg.req, ok: false,
            ...(owner?.name ? { owner: owner.name } : {}),
            ...(w.cells.get(key) ? { cell: w.cells.get(key)! } : {}),
          });
          break;
        }
        if (ownerId === c.id && this.clientContainer.get(c.id) === key) {
          this.send(c, {
            t: 'container', d: msg.d, k: msg.k, req: msg.req, ok: true,
            ...(w.cells.get(key) ? { cell: w.cells.get(key)! } : {}),
          });
          break;
        }
        // A normal client can only display one container. Releasing an older
        // lease also prevents a stale/malicious client from reserving the map.
        this.releaseContainer(c.id);
        this.containerLocks.set(key, c.id);
        this.clientContainer.set(c.id, key);
        this.broadcastContainerLock(key, c.id);
        this.send(c, {
          t: 'container', d: msg.d, k: msg.k, req: msg.req, ok: true,
          ...(w.cells.get(key) ? { cell: w.cells.get(key)! } : {}),
        });
        break;
      }
      case 'cells': {
        if (!Array.isArray(msg.cells)) return;
        const cells = msg.cells.slice(0, MAX_CELLS_PER_MSG).filter(validCell);
        if (!cells.length) return;
        const accepted: CellState[] = [];
        const corrections: CellState[] = [];
        for (const cell of cells) {
          const key = `${cell.d}|${cell.k}`;
          const current = w.cells.get(key);
          const ownerId = this.containerLocks.get(key);
          if (ownerId !== undefined &&
              (ownerId !== c.id || !validLeasedCellUpdate(cell, current))) {
            // Destruction is an edit too. Clients learn leases eagerly and
            // avoid producing speculative container drops; the server still
            // rejects a stale/racing writer (including the owner bypassing the
            // atomic commit path) rather than revoking the lease.
            if (current) corrections.push(current);
            continue;
          }
          w.cells.set(key, cell);
          this.dirtyCells.add(key);
          accepted.push(cell);
        }
        if (accepted.length) this.broadcast({ t: 'cells', from: c.id, cells: accepted }, c);
        // Undo an optimistic local break/explosion that touched a container
        // another player currently has open.
        if (corrections.length) this.send(c, { t: 'cells', from: 0, cells: corrections });
        break;
      }
      case 'containerCommit': {
        const cell = msg.cell;
        if (!validCell(cell)) return;
        const key = `${cell.d}|${cell.k}`;
        if (this.containerLocks.get(key) !== c.id || this.clientContainer.get(c.id) !== key) {
          const current = w.cells.get(key);
          if (current) this.send(c, { t: 'cells', from: 0, cells: [current] });
          return;
        }
        if (!validContainerCommit(cell, w.cells.get(key), msg.save)) return;
        // One message and one synchronous core operation make the two halves
        // inseparable. Both persistence adapters later flush these dirty rows
        // together (the Worker adapter does so in a SQLite transaction).
        w.cells.set(key, cell);
        w.players.set(c.name, msg.save);
        this.dirtyCells.add(key);
        this.dirtyPlayers.add(c.name);
        this.broadcast({ t: 'cells', from: c.id, cells: [cell] }, c);
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
