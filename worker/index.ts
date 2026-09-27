// Voxelcraft multiplayer on Cloudflare Workers. The Worker routes /ws and
// /status to a single Durable Object (WorldRoom) that runs the shared world
// core (server/core.ts) — the same logic the Node server runs — and keeps it
// in the object's built-in SQLite storage: one row per edited cell, one per
// player save, plus the seed/mode/clock. Dirty rows are flushed every few
// seconds and whenever someone leaves. With nobody online the object goes to
// sleep (the day clock pauses) and reloads from storage on the next join.
//
// The game client itself stays on GitHub Pages; players join with
// Server Address = wss://<this worker's host> (the Pages build can bake that
// in as the default, see VITE_MP_SERVER).

import { DurableObject } from 'cloudflare:workers';
import { WorldCore, newWorld, parseSeed, type Conn, type WorldData } from '../server/core';
import type { CellState, NetMode, PlayerSave } from '../src/net/protocol';

export interface Env {
  WORLD: DurableObjectNamespace<WorldRoom>;
  WORLD_NAME?: string;
  SEED?: string;
  MODE?: string;
  MAX_PLAYERS?: string;
}

const CORS = { 'access-control-allow-origin': '*' };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/ws' || url.pathname === '/status') {
      const stub = env.WORLD.get(env.WORLD.idFromName(env.WORLD_NAME ?? 'world'));
      return stub.fetch(req);
    }
    return new Response(
      `Voxelcraft multiplayer server.\n\nIn the game's Multiplayer card, use Server Address:\n  wss://${url.host}\n`,
      { headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS } },
    );
  },
} satisfies ExportedHandler<Env>;

type Row = Record<string, SqlStorageValue>;

export class WorldRoom extends DurableObject<Env> {
  private core!: WorldCore;
  private sql: SqlStorage;
  private clock: ReturnType<typeof setInterval> | null = null;
  private lastTick = Date.now();
  private sinceFlush = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    void ctx.blockConcurrencyWhile(async () => { this.load(); });
  }

  private load(): void {
    const sql = this.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS cells (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS players (name TEXT PRIMARY KEY, v TEXT NOT NULL)');
    const metaRow = sql.exec('SELECT v FROM meta WHERE k = ?', 'world').toArray()[0] as Row | undefined;
    let data: WorldData;
    if (metaRow) {
      const m = JSON.parse(String(metaRow.v)) as { seed: number; mode: NetMode; dayTime: number };
      data = { seed: m.seed, mode: m.mode, dayTime: m.dayTime, cells: new Map(), players: new Map() };
      for (const r of sql.exec('SELECT k, v FROM cells')) data.cells.set(String(r.k), JSON.parse(String(r.v)) as CellState);
      for (const r of sql.exec('SELECT name, v FROM players')) data.players.set(String(r.name), JSON.parse(String(r.v)) as PlayerSave);
    } else {
      data = newWorld(parseSeed(this.env.SEED), this.env.MODE === 'creative' ? 'creative' : 'survival');
    }
    this.core = new WorldCore(data, {
      world: this.env.WORLD_NAME ?? 'world',
      maxPlayers: Number(this.env.MAX_PLAYERS ?? 16) || 16,
    });
    if (!metaRow) { this.core.dirtyMeta = true; this.flush(); }
  }

  /** Write every dirty row in one transaction. */
  private flush(): void {
    const core = this.core;
    if (!core.dirty) return;
    const w = core.data;
    this.ctx.storage.transactionSync(() => {
      if (core.dirtyMeta) {
        this.sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', 'world',
          JSON.stringify({ seed: w.seed, mode: w.mode, dayTime: w.dayTime }));
      }
      for (const k of core.dirtyCells) {
        const c = w.cells.get(k);
        if (c) this.sql.exec('INSERT OR REPLACE INTO cells (k, v) VALUES (?, ?)', k, JSON.stringify(c));
      }
      for (const name of core.dirtyPlayers) {
        const p = w.players.get(name);
        if (p) this.sql.exec('INSERT OR REPLACE INTO players (name, v) VALUES (?, ?)', name, JSON.stringify(p));
      }
    });
    core.dirtyMeta = false;
    core.dirtyCells.clear();
    core.dirtyPlayers.clear();
  }

  /** The day clock + periodic flush run only while someone is connected. */
  private startClock(): void {
    if (this.clock) return;
    this.lastTick = Date.now();
    this.clock = setInterval(() => {
      const now = Date.now();
      const dt = (now - this.lastTick) / 1000;
      this.lastTick = now;
      this.core.tick(dt);
      this.sinceFlush += dt;
      if (this.sinceFlush >= 5) { this.sinceFlush = 0; this.flush(); }
    }, 1000);
  }

  private stopClockIfEmpty(): void {
    if (this.core.conns.size > 0 || !this.clock) return;
    clearInterval(this.clock);
    this.clock = null;
    this.flush();
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/status') return Response.json(this.core.status(), { headers: CORS });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket upgrade', { status: 426 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    let open = true;
    const c: Conn = this.core.connect({
      send: (d) => { try { server.send(d); } catch { open = false; } },
      close: () => { open = false; try { server.close(1000, 'bye'); } catch { /* already closed */ } },
      get open() { return open; },
    });
    server.addEventListener('message', (e) => {
      const raw = typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data as ArrayBuffer);
      this.core.message(c, raw);
    });
    const gone = (): void => {
      if (!this.core.conns.has(c.id)) return;
      open = false;
      try { server.close(1000, 'bye'); } catch { /* already closed */ }
      this.core.disconnect(c);
      this.flush();
      this.stopClockIfEmpty();
    };
    server.addEventListener('close', gone);
    server.addEventListener('error', gone);
    this.startClock();
    return new Response(null, { status: 101, webSocket: client });
  }
}
