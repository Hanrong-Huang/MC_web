// WebSocket connection to a Voxelcraft server: address parsing, the hello /
// welcome handshake, and a message queue that holds anything arriving before
// the game has attached its handler.

import { PROTOCOL, DEFAULT_PORT, type ClientMsg, type ServerMsg } from './protocol';

export type Welcome = Extract<ServerMsg, { t: 'welcome' }>;

/** Turn what a player typed into a WebSocket URL. Blank = the server this
 *  page was loaded from; "host", "host:port", "http(s)://…" and "ws(s)://…"
 *  all work, and /ws is appended when no path is given. */
export function serverUrl(input: string): string {
  let s = input.trim();
  if (!s) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }
  if (/^https?:\/\//i.test(s)) s = s.replace(/^http/i, 'ws');
  if (!/^wss?:\/\//i.test(s)) {
    const secure = location.protocol === 'https:' && !/^(localhost|127\.|192\.168\.|10\.)/.test(s);
    s = `${secure ? 'wss' : 'ws'}://${s.includes(':') || s.includes('/') ? s : `${s}:${DEFAULT_PORT}`}`;
  }
  const u = new URL(s);
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/ws';
  return u.toString();
}

export class NetClient {
  readonly welcome: Welcome;
  private handler: ((m: ServerMsg) => void) | null = null;
  private queue: ServerMsg[] = [];
  onClose: (reason: string) => void = () => {};
  private closedByUs = false;

  private constructor(private ws: WebSocket, welcome: Welcome) {
    this.welcome = welcome;
    ws.onmessage = (e) => {
      let m: ServerMsg;
      try { m = JSON.parse(String(e.data)) as ServerMsg; } catch { return; }
      if (this.handler) this.handler(m); else this.queue.push(m);
    };
    ws.onclose = (e) => {
      if (!this.closedByUs) this.onClose(e.reason || 'Connection lost');
    };
  }

  get id(): number { return this.welcome.id; }
  get name(): string { return this.welcome.name; }
  get open(): boolean { return this.ws.readyState === WebSocket.OPEN; }

  /** Connect, say hello and wait for the world. Rejects with a readable message. */
  static connect(address: string, name: string, timeoutMs = 12000): Promise<NetClient> {
    return new Promise((resolve, reject) => {
      let url: string;
      try { url = serverUrl(address); } catch { reject(new Error('That does not look like a server address.')); return; }
      let ws: WebSocket;
      try { ws = new WebSocket(url); } catch { reject(new Error('Could not open a connection.')); return; }
      let settled = false;
      const fail = (msg: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch { /* already closed */ }
        reject(new Error(msg));
      };
      const timer = setTimeout(() => fail('The server did not answer in time.'), timeoutMs);
      ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL, name } satisfies ClientMsg));
      ws.onerror = () => fail(`Could not reach ${url}`);
      ws.onclose = () => fail('The server closed the connection.');
      ws.onmessage = (e) => {
        let m: ServerMsg;
        try { m = JSON.parse(String(e.data)) as ServerMsg; } catch { return; }
        if (m.t === 'error') { fail(m.msg); return; }
        if (m.t !== 'welcome' || settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(new NetClient(ws, m));
      };
    });
  }

  /** Start delivering messages (anything that arrived early is replayed first). */
  listen(handler: (m: ServerMsg) => void): void {
    this.handler = handler;
    const q = this.queue;
    this.queue = [];
    for (const m of q) handler(m);
  }

  send(m: ClientMsg): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  close(): void {
    this.closedByUs = true;
    this.handler = null;
    try { this.ws.close(); } catch { /* already closed */ }
  }
}
