// Wire protocol shared by the browser client (src/net/NetClient.ts) and the
// Node server (server/server.ts). Messages are JSON objects tagged by `t`.
// Pure data only — no DOM or Three.js — so the server can import it.
//
// Sync model (v1): every client generates terrain from the shared seed and
// runs its own automata (water, fire, redstone, crops) and mobs. What travels
// is the *cause*: the final state of every cell a player's actions touched
// (break / place / use / containers / their explosions), plus poses, chat and
// the day clock. The server keeps the latest state of every edited cell and
// replays them to anyone who joins, so the world is shared and persistent.

export const PROTOCOL = 1;
/** Default port for `npm run server` (HTTP + WebSocket on /ws). */
export const DEFAULT_PORT = 8080;
/** Real seconds per in-game day (keep in step with main.ts DAY_LENGTH). */
export const NET_DAY_LENGTH = 1200;

export type Dim = 'overworld' | 'nether';
export type NetMode = 'survival' | 'creative';

/** A door / trapdoor / gate state without the client-side swing animation. */
export interface NetDoor { facing: number; open: boolean; hingeRight: boolean; top?: boolean }

/** Everything that lives at one block position. Absent optional fields mean
 *  "no entry" (the receiver deletes any it has). */
export interface CellState {
  d: Dim;
  /** "x,y,z" — the same key World's state maps use */
  k: string;
  id: number;
  door?: NetDoor;
  torch?: number;
  /** World.bedFacings: bed/shaped-block meta (slab half, stair facing, …) */
  meta?: number;
  /** World.redstoneStates entry (lever / repeater / comparator / …) */
  rs?: Record<string, unknown>;
  piston?: number;
  /** chest / furnace contents (BlockEntity.serialize()) */
  be?: Record<string, unknown>;
  /** World.waterLevels / lavaLevels (absent = a source block) */
  water?: number;
  lava?: number;
}

/** Where a player is and what they look like doing it (sent ~12 Hz). */
export interface Pose {
  x: number; y: number; z: number;
  yaw: number; pitch: number;
  dim: Dim;
  sneak: boolean;
  /** item id in hand (0 = empty) */
  held: number;
  /** increments on every arm swing, so a missed packet can't eat one */
  swing: number;
  dead: boolean;
  riding: boolean;
  sleeping: boolean;
  /** survival | creative (mobs leave creative players alone) */
  mode?: NetMode;
}

export type NetWeather = 'clear' | 'rain' | 'thunder';

/** Something the server asks one client to do (the result of a command). */
export type NetAction =
  /** move there (switching dimension if needed); no y = the surface there */
  | { do: 'teleport'; x: number; y?: number; z: number; dim: Dim }
  /** go to the world spawn: the server's if an admin set one, else the seed's */
  | { do: 'spawn'; at?: { x: number; y: number; z: number } }
  | { do: 'gamemode'; mode: NetMode }
  /** an item by registry name (the client owns the item registry) */
  | { do: 'give'; item: string; count: number; by: string }
  | { do: 'heal' };

/** The per-player part of a save, kept by the server under the player's name. */
export interface PlayerSave {
  gameMode: NetMode;
  player: unknown;
  inventory: unknown;
  dimension: Dim;
  spawn?: { x: number; y: number; z: number };
  advancements?: unknown;
}

export interface PlayerInfo { id: number; name: string; pose?: Pose }

// --- client → server ------------------------------------------------------------
export type ClientMsg =
  | { t: 'hello'; v: number; name: string }
  | { t: 'pose'; p: Pose }
  | { t: 'cells'; cells: CellState[] }
  | { t: 'chat'; text: string }
  | { t: 'save'; save: PlayerSave }
  | { t: 'sleep'; on: boolean };

// --- server → client ------------------------------------------------------------
export type ServerMsg =
  | {
    t: 'welcome'; id: number; name: string; world: string; seed: number; mode: NetMode;
    dayTime: number; cells: CellState[]; players: PlayerInfo[]; you: PlayerSave | null;
    weather?: NetWeather;
  }
  | { t: 'join'; id: number; name: string }
  | { t: 'leave'; id: number; name: string }
  | { t: 'pose'; id: number; p: Pose }
  /** a peer's edits (`from` = their id), or 0: the edit log, sent in batches after `welcome` */
  | { t: 'cells'; from: number; cells: CellState[] }
  | { t: 'chat'; from: string | null; text: string }
  /** clock sync; `skip` = everyone slept, the night is over */
  | { t: 'time'; dayTime: number; skip?: boolean }
  | { t: 'sleepers'; n: number; total: number }
  | { t: 'weather'; kind: NetWeather }
  | { t: 'cmd'; a: NetAction }
  | { t: 'error'; msg: string };

/** Chat / name hygiene shared by both ends. */
export function cleanName(raw: string): string {
  const s = raw.replace(/[^\p{L}\p{N}_\- ]/gu, '').trim().slice(0, 16);
  return s || 'Player';
}
export function cleanChat(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 256);
}
