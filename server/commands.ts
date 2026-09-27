// Chat commands for the multiplayer server (run by WorldCore for any chat line
// starting with "/"). Everyone gets the travel and social commands; admins —
// players who ran `/login <password>` (the server's ADMIN_PASSWORD) or were
// /op'd by one — also get the world and moderation commands. `/help` lists
// exactly what the asking player may use; `/help <command>` shows its usage.
//
// Anything that has to happen inside a player's game (moving them, changing
// their mode, handing them items) goes to that client as a `cmd` action.

import type { Conn, WorldCore, Place } from './core';
import type { NetAction, NetMode, NetWeather } from '../src/net/protocol';

interface Command {
  name: string;
  aliases?: string[];
  usage: string;
  help: string;
  admin?: boolean;
  run(core: WorldCore, c: Conn, args: string[]): void;
}

const say = (core: WorldCore, c: Conn, text: string): void => core.send(c, { t: 'chat', from: null, text });
const act = (core: WorldCore, c: Conn, a: NetAction): void => core.send(c, { t: 'cmd', a });

function placeOf(c: Conn): Place | null {
  const p = c.pose;
  return p ? { x: p.x, y: p.y, z: p.z, dim: p.dim } : null;
}

/** A coordinate: a number, or ~ / ~n relative to `base`. */
function coord(raw: string, base: number): number | null {
  if (raw.startsWith('~')) {
    const off = raw.length > 1 ? Number(raw.slice(1)) : 0;
    return Number.isFinite(off) ? base + off : null;
  }
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

function teleport(core: WorldCore, who: Conn, to: Place, note: string): void {
  act(core, who, { do: 'teleport', x: to.x, y: to.y, z: to.z, dim: to.dim });
  say(core, who, note);
}

const round = (p: Place): string => `${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)}${p.dim === 'nether' ? ' (Nether)' : ''}`;

/** The target of an admin command: the named player, or the admin themself. */
function targetOf(core: WorldCore, c: Conn, name: string | undefined): Conn | null {
  if (!name) return c;
  const t = core.findPlayer(name);
  if (!t) say(core, c, `No player called "${name}" is online.`);
  return t;
}

const COMMANDS: Command[] = [
  {
    name: 'help', usage: '/help [command]', help: 'List the commands you can use, or how to use one.',
    run(core, c, [which]) {
      const mine = COMMANDS.filter((k) => !k.admin || c.admin);
      if (which) {
        const k = find(which.replace(/^\//, ''));
        if (!k || (k.admin && !c.admin)) { say(core, c, `Unknown command /${which}. Type /help for the list.`); return; }
        say(core, c, `${k.usage} — ${k.help}${k.aliases ? ` (also /${k.aliases.join(', /')})` : ''}`);
        return;
      }
      say(core, c, `Commands${c.admin ? ' (you are an admin)' : ''}:`);
      for (const k of mine) say(core, c, `${k.usage} — ${k.help}${k.admin ? ' [admin]' : ''}`);
      if (!c.admin) say(core, c, 'Admins: /login <password> unlocks the admin commands.');
    },
  },
  {
    name: 'list', aliases: ['who', 'online'], usage: '/list', help: 'Who is online (and where).',
    run(core, c) {
      const on = core.online();
      say(core, c, `Online (${on.length}): ${on.map((o) => `${o.name}${o.admin ? '*' : ''}${o.pose?.dim === 'nether' ? ' [Nether]' : ''}`).join(', ')}`);
    },
  },
  {
    name: 'tp', aliases: ['teleport'], usage: '/tp <player>',
    help: 'Teleport to a player. Admins: /tp <player> <player>, /tp [player] <x> <y> <z> (~ = relative).',
    run(core, c, args) {
      if (args.length === 1) {
        const t = core.findPlayer(args[0]);
        if (!t) { say(core, c, `No player called "${args[0]}" is online.`); return; }
        if (t === c) { say(core, c, 'You are already here.'); return; }
        const to = placeOf(t);
        if (!to) { say(core, c, `${t.name} is still loading in — try again in a moment.`); return; }
        teleport(core, c, to, `Teleported to ${t.name}.`);
        say(core, t, `${c.name} teleported to you.`);
        return;
      }
      if (!c.admin) { say(core, c, 'Only admins can move other players or teleport to coordinates. Usage: /tp <player>'); return; }
      if (args.length === 2) {
        const who = core.findPlayer(args[0]), t = core.findPlayer(args[1]);
        if (!who || !t) { say(core, c, 'Both players must be online. Usage: /tp <player> <player>'); return; }
        const to = placeOf(t);
        if (!to) { say(core, c, `${t.name} is still loading in.`); return; }
        teleport(core, who, to, `${c.name} teleported you to ${t.name}.`);
        if (who !== c) say(core, c, `Teleported ${who.name} to ${t.name}.`);
        return;
      }
      if (args.length === 3 || args.length === 4) {
        const who = args.length === 4 ? core.findPlayer(args[0]) : c;
        if (!who) { say(core, c, `No player called "${args[0]}" is online.`); return; }
        const base = placeOf(who) ?? { x: 0, y: 80, z: 0, dim: 'overworld' as const };
        const [xs, ys, zs] = args.slice(-3);
        const x = coord(xs, base.x), y = coord(ys, base.y), z = coord(zs, base.z);
        if (x === null || y === null || z === null) { say(core, c, 'Coordinates must be numbers (or ~ for relative).'); return; }
        const to: Place = { x, y, z, dim: base.dim };
        teleport(core, who, to, `Teleported to ${round(to)}.`);
        if (who !== c) say(core, c, `Teleported ${who.name} to ${round(to)}.`);
        return;
      }
      say(core, c, 'Usage: /tp <player>');
    },
  },
  {
    name: 'tphere', usage: '/tphere <player>', help: 'Bring a player to you.', admin: true,
    run(core, c, [name]) {
      const t = name ? core.findPlayer(name) : null;
      if (!t) { say(core, c, 'Usage: /tphere <player> (they must be online)'); return; }
      const to = placeOf(c);
      if (!to) return;
      teleport(core, t, to, `${c.name} brought you to them.`);
      say(core, c, `Brought ${t.name} to you.`);
    },
  },
  {
    name: 'sethome', usage: '/sethome', help: 'Make where you stand your home.',
    run(core, c) {
      const here = placeOf(c);
      if (!here) { say(core, c, 'Try again in a moment.'); return; }
      core.data.homes.set(c.name, here);
      core.dirtyMeta = true;
      say(core, c, `Home set at ${round(here)}. Use /home to come back.`);
    },
  },
  {
    name: 'home', usage: '/home', help: 'Go to your home (set it with /sethome).',
    run(core, c) {
      const h = core.data.homes.get(c.name);
      if (!h) { say(core, c, 'You have no home yet — stand somewhere and type /sethome. Sending you to spawn.'); spawnOf(core, c); return; }
      teleport(core, c, h, 'Welcome home.');
    },
  },
  {
    name: 'spawn', usage: '/spawn', help: 'Go to the world spawn.',
    run(core, c) { spawnOf(core, c); say(core, c, 'Teleported to spawn.'); },
  },
  {
    name: 'msg', aliases: ['tell', 'w'], usage: '/msg <player> <message>', help: 'Whisper to one player.',
    run(core, c, [name, ...words]) {
      const t = name ? core.findPlayer(name) : null;
      const text = words.join(' ').trim();
      if (!t || !text) { say(core, c, 'Usage: /msg <player> <message>'); return; }
      core.send(t, { t: 'chat', from: `${c.name} → you`, text });
      core.send(c, { t: 'chat', from: `you → ${t.name}`, text });
    },
  },
  {
    name: 'login', usage: '/login <password>', help: 'Become an admin (the server owner has the password).',
    run(core, c, [pw]) {
      const want = core.opts.adminPassword;
      if (!want) { say(core, c, 'This server has no admin password set.'); return; }
      if (c.admin) { say(core, c, 'You are already an admin.'); return; }
      const now = Date.now();
      if (now < (c.loginLockUntil ?? 0)) { say(core, c, 'Too many tries — wait a few seconds.'); return; }
      if (pw !== want) { c.loginLockUntil = now + 3000; say(core, c, 'Wrong password.'); return; }
      c.admin = true;
      say(core, c, 'You are now an admin. /help shows the admin commands.');
      core.log(`[admin] ${c.name} logged in`);
    },
  },
  {
    name: 'logout', usage: '/logout', help: 'Stop being an admin.', admin: true,
    run(core, c) { c.admin = false; say(core, c, 'You are no longer an admin.'); },
  },
  {
    name: 'time', usage: '/time set day|noon|night|midnight|<0-1>', help: 'Set the time of day for everyone.', admin: true,
    run(core, c, [sub, value]) {
      const named: Record<string, number> = { day: 0.05, noon: 0.25, sunset: 0.48, night: 0.6, midnight: 0.75 };
      const v = sub === 'set' && value !== undefined ? named[value] ?? Number(value) : NaN;
      if (!Number.isFinite(v) || v < 0 || v > 1) { say(core, c, 'Usage: /time set day|noon|night|midnight|<0-1>'); return; }
      core.data.dayTime = v % 1;
      core.dirtyMeta = true;
      core.broadcast({ t: 'time', dayTime: core.data.dayTime });
      core.system(`${c.name} set the time to ${value}`);
    },
  },
  {
    name: 'weather', usage: '/weather clear|rain|thunder [seconds]', help: 'Change the weather for everyone.', admin: true,
    run(core, c, [kind, secs]) {
      if (kind !== 'clear' && kind !== 'rain' && kind !== 'thunder') { say(core, c, 'Usage: /weather clear|rain|thunder [seconds]'); return; }
      const s = secs !== undefined ? Number(secs) : undefined;
      core.setWeather(kind as NetWeather, s !== undefined && Number.isFinite(s) && s > 0 ? s : undefined);
      core.system(`${c.name} set the weather to ${kind}`);
    },
  },
  {
    name: 'gamemode', aliases: ['gm'], usage: '/gamemode survival|creative [player]', help: 'Switch a game mode.', admin: true,
    run(core, c, [raw, name]) {
      const mode: NetMode | null = raw === 'survival' || raw === 's' || raw === '0' ? 'survival'
        : raw === 'creative' || raw === 'c' || raw === '1' ? 'creative' : null;
      if (!mode) { say(core, c, 'Usage: /gamemode survival|creative [player]'); return; }
      const t = targetOf(core, c, name);
      if (!t) return;
      act(core, t, { do: 'gamemode', mode });
      say(core, t, `Your game mode is now ${mode}.`);
      if (t !== c) say(core, c, `${t.name} is now in ${mode}.`);
    },
  },
  {
    name: 'give', usage: '/give <player> <item> [count]', help: 'Give items by name (e.g. /give Alex diamond 5).', admin: true,
    run(core, c, [name, item, count]) {
      const t = name ? core.findPlayer(name) : null;
      const n = count !== undefined ? Math.floor(Number(count)) : 1;
      if (!t || !item || !Number.isFinite(n) || n < 1) { say(core, c, 'Usage: /give <player> <item> [count]'); return; }
      act(core, t, { do: 'give', item: item.toLowerCase(), count: Math.min(n, 64 * 36), by: c.name });
      if (t !== c) say(core, c, `Gave ${n} ${item} to ${t.name}.`);
    },
  },
  {
    name: 'heal', usage: '/heal [player]', help: 'Refill health and hunger.', admin: true,
    run(core, c, [name]) {
      const t = targetOf(core, c, name);
      if (!t) return;
      act(core, t, { do: 'heal' });
      say(core, t, 'You feel refreshed.');
      if (t !== c) say(core, c, `Healed ${t.name}.`);
    },
  },
  {
    name: 'setspawn', usage: '/setspawn', help: 'Make where you stand the world spawn.', admin: true,
    run(core, c) {
      const here = placeOf(c);
      if (!here || here.dim !== 'overworld') { say(core, c, 'Stand somewhere in the Overworld first.'); return; }
      core.data.spawn = here;
      core.dirtyMeta = true;
      core.system(`${c.name} moved the world spawn to ${round(here)}`);
    },
  },
  {
    name: 'kick', usage: '/kick <player> [reason]', help: 'Disconnect a player.', admin: true,
    run(core, c, [name, ...why]) {
      const t = name ? core.findPlayer(name) : null;
      if (!t) { say(core, c, 'Usage: /kick <player> [reason]'); return; }
      if (t === c) { say(core, c, 'You cannot kick yourself.'); return; }
      core.send(t, { t: 'error', msg: `You were kicked by ${c.name}${why.length ? `: ${why.join(' ')}` : ''}` });
      t.sock.close();
      core.system(`${t.name} was kicked by ${c.name}`);
    },
  },
  {
    name: 'op', usage: '/op <player>', help: 'Make an online player an admin (until they leave).', admin: true,
    run(core, c, [name]) {
      const t = name ? core.findPlayer(name) : null;
      if (!t) { say(core, c, 'Usage: /op <player>'); return; }
      t.admin = true;
      say(core, t, `${c.name} made you an admin. /help shows the admin commands.`);
      say(core, c, `${t.name} is now an admin.`);
    },
  },
  {
    name: 'deop', usage: '/deop <player>', help: 'Take admin away from a player.', admin: true,
    run(core, c, [name]) {
      const t = name ? core.findPlayer(name) : null;
      if (!t) { say(core, c, 'Usage: /deop <player>'); return; }
      t.admin = false;
      say(core, t, 'You are no longer an admin.');
      say(core, c, `${t.name} is no longer an admin.`);
    },
  },
  {
    name: 'say', usage: '/say <message>', help: 'Announce something to everyone.', admin: true,
    run(core, c, words) {
      const text = words.join(' ').trim();
      if (!text) { say(core, c, 'Usage: /say <message>'); return; }
      core.system(`[${c.name}] ${text}`);
    },
  },
  {
    name: 'seed', usage: '/seed', help: 'Show the world seed.', admin: true,
    run(core, c) { say(core, c, `Seed: ${core.data.seed}`); },
  },
];

function find(name: string): Command | undefined {
  const n = name.toLowerCase();
  return COMMANDS.find((k) => k.name === n || k.aliases?.includes(n));
}

function spawnOf(core: WorldCore, c: Conn): void {
  const s = core.data.spawn;
  act(core, c, { do: 'spawn', ...(s ? { at: { x: s.x, y: s.y, z: s.z } } : {}) });
}

export function runCommand(core: WorldCore, c: Conn, text: string): void {
  const [head, ...args] = text.slice(1).trim().split(/\s+/);
  const k = find(head ?? '');
  if (!k || (k.admin && !c.admin)) {
    say(core, c, k ? `/${k.name} is an admin command. Type /help for yours.` : `Unknown command /${head}. Type /help for the list.`);
    return;
  }
  k.run(core, c, args);
}
