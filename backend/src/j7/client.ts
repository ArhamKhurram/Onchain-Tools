// The j7tracker socket layer: one socket.io connection per account, driven off
// the manual JWTs in J7_JWTS_JSON.
//
// AUTH MODEL, important: j7 login is a human clearing a Cloudflare Turnstile
// ~every 15 days and pasting the resulting JWT into env. There is deliberately NO
// login / Turnstile / headless-browser automation here — this module only ever
// CONSUMES JWTs. When a JWT finally expires the server force-disconnects the
// socket; we log that plainly (it needs a human to refresh env and restart) and
// do not thrash a dead credential.
//
// Reconnect + liveness come from socket.io itself: `reconnection:true` gives
// exponential backoff between the delays below, and engine.io's ping/pong is the
// heartbeat. We add connect/disconnect/error logging for observability and a
// best-effort `social_history` replay on (re)connect to close gaps.

import { io, type Socket } from 'socket.io-client';
import { routeJ7Event, type J7EventSink } from './events.js';

const J7_SOCKET_URL = 'https://nj.j7tracker.io';
const J7_SOCKET_PATH = '/wallets/socket.io/';

const RECONNECT_DELAY_MS = Number.parseInt(process.env.J7_RECONNECT_DELAY_MS ?? '', 10) || 1_000;
const RECONNECT_DELAY_MAX_MS = Number.parseInt(process.env.J7_RECONNECT_DELAY_MAX_MS ?? '', 10) || 30_000;
// Replayed on (re)connect. Recon: returns empty for fresh targets, so this is a
// no-op gap-closer we never depend on — see the comment at the emit site.
const SOCIAL_HISTORY_LIMIT = Number.parseInt(process.env.J7_SOCIAL_HISTORY_LIMIT ?? '', 10) || 50;

// Server-pushed state snapshots on connect — j7's view of what this socket is
// scoped to. roster.ts owns that set over REST and reconnects the socket when it
// changes, so the snapshots are acknowledged as known events and otherwise
// ignored; listing them keeps them off the unknown-event warning path.
const STATE_EVENTS = ['tracked_pump', 'tracked_fomo', 'tracked_telegram', 'tracked_subdomain'] as const;

/** One configured j7 account: a display label and its manual JWT. */
export interface J7Account {
  username: string;
  jwt: string;
}

/**
 * Parse J7_JWTS_JSON into usable accounts.
 *
 * Shape: a JSON array of `{ username, jwt }`. Entries with an empty/whitespace
 * `jwt` are ignored (the operator keeps a slot for an account they haven't
 * pasted a fresh token for yet). Absent or malformed env yields `[]` so the
 * consumer simply idles — this never throws. Pure, so it is unit-tested directly.
 */
export function parseJ7Accounts(raw: string | undefined): J7Account[] {
  if (!raw || raw.trim() === '') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('[J7] J7_JWTS_JSON is not valid JSON; consumer idle.');
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.error('[J7] J7_JWTS_JSON is not a JSON array; consumer idle.');
    return [];
  }

  const out: J7Account[] = [];
  for (const row of parsed) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const jwt = typeof r.jwt === 'string' ? r.jwt.trim() : '';
    if (!jwt) continue; // ignore empty-jwt entries
    const username = typeof r.username === 'string' && r.username.trim() !== '' ? r.username : 'account';
    out.push({ username, jwt });
  }
  return out;
}

/** One socket.io connection for one account, wired to the event router. */
class J7Socket {
  private readonly socket: Socket;

  constructor(private readonly account: J7Account, private readonly sink: J7EventSink) {
    this.socket = io(J7_SOCKET_URL, {
      path: J7_SOCKET_PATH,
      transports: ['websocket'],
      auth: { token: account.jwt },
      reconnection: true,
      reconnectionDelay: RECONNECT_DELAY_MS,
      reconnectionDelayMax: RECONNECT_DELAY_MAX_MS,
    });
    this.wire();
  }

  private wire(): void {
    const tag = this.account.username;

    this.socket.on('connect', () => {
      console.log(`[J7] (${tag}) connected — socket ${this.socket.id}.`);
      // Best-effort gap-closer. Recon says j7 returns empty for fresh targets,
      // so we fire-and-forget and never wait on or depend on a reply.
      this.socket.emit('social_history', { limit: SOCIAL_HISTORY_LIMIT });
    });

    this.socket.on('disconnect', (reason: string) => {
      // "io server disconnect" is a deliberate server close — for j7 that is an
      // expired/rejected JWT, which socket.io will NOT auto-retry. Say so
      // plainly: it needs a human to refresh J7_JWTS_JSON and restart.
      if (reason === 'io server disconnect') {
        console.warn(
          `[J7] (${tag}) disconnected by server (JWT likely expired) — refresh J7_JWTS_JSON and restart.`,
        );
      } else {
        console.warn(`[J7] (${tag}) disconnected: ${reason} (socket.io will retry).`);
      }
    });

    this.socket.on('connect_error', (err: Error) => {
      console.warn(`[J7] (${tag}) connect error: ${err?.message ?? String(err)}`);
    });

    // The two data events.
    this.socket.on('pump_event', (payload: unknown) => routeJ7Event('pump_event', payload, this.sink));
    this.socket.on('fomo_event', (payload: unknown) => routeJ7Event('fomo_event', payload, this.sink));

    // Known-but-ignored state snapshots (see STATE_EVENTS).
    for (const ev of STATE_EVENTS) {
      this.socket.on(ev, () => {
        /* state snapshot; targets are managed operator-side — no-op */
      });
    }
  }

  /**
   * Re-establish this connection so a changed target set takes effect.
   *
   * Measured live: j7 scopes a socket at CONNECT time — it pushes the
   * `tracked_*` snapshots on connect — so a target subscribed via REST after the
   * socket came up does not start delivering on that socket. The listeners are
   * kept (they are bound to this instance, not the connection), so this is a
   * transport bounce, not a rebuild.
   */
  reconnect(): void {
    this.socket.disconnect();
    this.socket.connect();
  }

  close(): void {
    this.socket.removeAllListeners();
    this.socket.disconnect();
  }
}

/**
 * Owns every account socket for the process. `start` opens one connection per
 * account; `stop` tears them all down (used by tests and a clean shutdown).
 */
export class J7Consumer {
  private sockets: J7Socket[] = [];

  constructor(private readonly accounts: J7Account[], private readonly sink: J7EventSink) {}

  start(): void {
    for (const account of this.accounts) {
      this.sockets.push(new J7Socket(account, this.sink));
    }
    console.log(`[J7] Consumer started with ${this.sockets.length} socket(s).`);
  }

  /**
   * Bounce one account's socket, addressed BY INDEX.
   *
   * Index, not username: `parseJ7Accounts` defaults a missing label to
   * "account", so labels can collide, and the reconciler already works through
   * the same ordered array. Reconnecting the wrong socket would silently leave
   * a changed roster unscoped.
   */
  reconnectAccount(index: number, reason: string): void {
    const socket = this.sockets[index];
    if (!socket) return;
    console.log(`[J7] (${this.accounts[index]?.username ?? index}) reconnecting — ${reason}.`);
    socket.reconnect();
  }

  stop(): void {
    for (const socket of this.sockets) socket.close();
    this.sockets = [];
  }
}
