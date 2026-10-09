// Wire protocol shared by the browser client (src/net/NetClient.ts) and the
// Node server (server/server.ts). Messages are JSON objects tagged by `t`.
// Pure data only — no DOM or Three.js — so the server can import it.
//
// Sync model: every client generates terrain from the shared seed and runs
// its own automata (water, fire, redstone, crops). What travels for blocks is
// the *cause*: the final state of every cell a player's actions touched
// (break / place / use / containers / their explosions). The server keeps the
// latest state of every edited cell and replays them to anyone who joins.
//
// Entities (mobs, animals, dropped items, arrows, TNT, minecarts) are shared
// by *ownership*: exactly one client simulates each (its AI, physics, health)
// and streams its state ~10 Hz; everyone else shows a smoothed puppet. The
// server keeps who owns what: whoever hits, feeds, rides or captures an
// entity takes it over on the spot; a player who walks away or leaves hands
// theirs to the nearest remaining player; pickups are granted by the server
// so an item can only be picked up once. Mobs hunt the nearest player, and
// damage to someone else's player travels as a `phurt`. Weather and the day
// clock are the server's.

export const PROTOCOL = 5;
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
  /** Client chunk view radius, used to elect one simulator for loaded cells. */
  view?: number;
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
  /** items held by a transient UI/projectile when this snapshot was taken */
  pendingItems?: unknown;
  dimension: Dim;
  spawn?: { x: number; y: number; z: number };
  advancements?: unknown;
  /** captured pets that follow this player */
  pets?: unknown;
}

export interface PlayerInfo { id: number; name: string; pose?: Pose }

/** A networked entity's state (see the sync model above). Compact on the
 *  wire: only `n k d x y z yw` always; the rest when relevant. */
export interface EntState {
  /** network id: `${owner client id}.${counter}` from whoever created it */
  n: string;
  /** EntityKind: a mob kind, 'drop', 'arrow', 'tnt' or 'minecart' */
  k: string;
  d: Dim;
  x: number; y: number; z: number;
  yw: number;
  /** velocity (arrows, fireballs, carts) */
  vx?: number; vy?: number; vz?: number;
  hp?: number;
  /** coat / outfit / size variant */
  v?: number;
  /** ENT_FLAGS bits */
  f?: number;
  /** AI state (drives the puppet's animation): idle | wander | flee | chase | fuse */
  st?: string;
  /** fuse seconds left (TNT, creepers) */
  ft?: number;
  /** attack-swing and hurt counters: a puppet plays one of each per increment */
  sw?: number;
  hc?: number;
  /** drop: item id, count, durability, captured mob, enchantments */
  i?: number; c?: number; du?: number; mob?: string; en?: Record<string, number>;
  /** tamed-by (player name) */
  on?: string;
  /** projectile: `${proj}|${owner}|${shooter}` */
  pj?: string;
  /** full-state extras the next owner needs (villager trades, breeding timers …) */
  ex?: Record<string, unknown>;
}

/** EntState.f bits */
export const ENT_FLAGS = {
  baby: 1, sheared: 2, tamed: 4, sitting: 8, saddled: 16, ridden: 32, burning: 64,
  angry: 128, cold: 256, stuck: 512, ground: 1024, armored: 2048,
} as const;

export type GoneWhy = 'die' | 'pick' | 'despawn' | 'capture';

/** Damage one client's mob (or blast) deals to another client's player. */
export interface PlayerHit {
  dmg: number;
  cause: string;
  /** knockback direction + strength */
  kx: number; kz: number; kb: number;
  /** upward launch (hoglin toss) */
  up?: number;
  effect?: { name: string; secs: number; amp: number };
  fire?: { secs: number; who: string };
  /** the attacker, so the victim's pets can retaliate */
  src?: string;
}

/** A one-off effect everyone nearby should see/hear. */
export type NetFx =
  | { k: 'boom'; x: number; y: number; z: number; power: number; cause: string }
  | { k: 'bolt'; x: number; y: number; z: number };

// --- client → server ------------------------------------------------------------
export type ClientMsg =
  | { t: 'hello'; v: number; name: string }
  | { t: 'pose'; p: Pose }
  | { t: 'cells'; cells: CellState[] }
  /** Acquire/release the exclusive edit lease for a chest or furnace. */
  | { t: 'container'; op: 'open'; d: Dim; k: string; req: number }
  | { t: 'container'; op: 'close'; d: Dim; k: string }
  /** Atomically commit both sides of a leased container transfer. */
  | { t: 'containerCommit'; cell: CellState; save: PlayerSave }
  | { t: 'chat'; text: string }
  | { t: 'save'; save: PlayerSave }
  | { t: 'sleep'; on: boolean }
  /** states of entities the sender owns (new ones included) */
  | { t: 'ents'; list: EntState[] }
  /** the sender's entities are gone */
  | { t: 'egone'; ids: string[]; why: GoneWhy }
  /** take over an entity (the sender is hitting / riding / using it) */
  | { t: 'take'; id: string }
  /** ask to pick up a dropped item (granted once, by the server) */
  | { t: 'pick'; id: string }
  | { t: 'phurt'; to: number; h: PlayerHit }
  | { t: 'fx'; fx: NetFx };

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
  /** Result of a container edit-lease request. `cell` is the authoritative
   *  server snapshot, when that cell has already been edited. */
  | { t: 'container'; d: Dim; k: string; req: number; ok: boolean; owner?: string; cell?: CellState }
  /** Live lease state, broadcast to every client. `owner: null` unlocks it. */
  | { t: 'containerLock'; d: Dim; k: string; owner: number | null }
  | { t: 'chat'; from: string | null; text: string }
  /** clock sync; `skip` = everyone slept, the night is over */
  | { t: 'time'; dayTime: number; skip?: boolean }
  | { t: 'sleepers'; n: number; total: number }
  | { t: 'weather'; kind: NetWeather }
  | { t: 'ents'; from: number; list: EntState[] }
  | { t: 'egone'; ids: string[]; why: GoneWhy }
  /** an entity changed hands (or a take was refused: `owner` is who keeps it) */
  | { t: 'owner'; id: string; owner: number; s: EntState }
  /** your pickup was granted: the item's state */
  | { t: 'picked'; id: string; s: EntState }
  | { t: 'phurt'; from: number; h: PlayerHit }
  | { t: 'fx'; from: number; fx: NetFx }
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
