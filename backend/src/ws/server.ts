import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { FrontendMessage } from '../discord/types.js';
import { isHostedMode } from '../storage/index.js';
import { verifyAccessToken } from '../auth/middleware.js';

interface ClientState {
  subscribedRooms: Set<string>;
  userId: string | null;
  /** Liveness flag for the heartbeat sweep: cleared each sweep, set by pong. */
  isAlive: boolean;
  /** Frames dropped by the backpressure guard (observability only). */
  skippedFrames: number;
}

// ---------------------------------------------------------------------------
// Backpressure guard
//
// `ws.send()` never blocks: everything the kernel socket can't take right now
// is buffered in server memory (`bufferedAmount`). A client that stops reading
// — laptop lid closed mid-transfer, a zombie TCP connection, a mobile radio
// stall — therefore grows an unbounded per-socket buffer while broadcasts keep
// flowing. Two caps bound it:
//
//   * soft cap — stop queueing *non-essential* frames (feed traffic: messages,
//     contracts, enrichment, reactions…) for that socket. Alerts still queue.
//   * hard cap — the socket is beyond saving; terminate it. The frontend's
//     useWebSocket auto-reconnects, so a genuinely alive client self-heals
//     with a fresh socket and re-subscribes; a dead one stops costing memory.
//
// Healthy sockets (bufferedAmount at/below the soft cap, which in practice is
// ~0) are completely unaffected: same frames, same order.
// ---------------------------------------------------------------------------

const DEFAULT_SOFT_BUFFER_LIMIT = 1 * 1024 * 1024; // 1 MiB
const DEFAULT_HARD_BUFFER_LIMIT = 8 * 1024 * 1024; // 8 MiB

/** Read a byte-count env override (OCT_* name first, TRENCHCORD_* fallback). */
function readByteLimit(names: string[], fallback: number): number {
  for (const name of names) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') continue;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
    console.warn(`[WS] Ignoring invalid ${name}=${JSON.stringify(raw)} (want a positive byte count)`);
  }
  return fallback;
}

/** Sweep cadence; a dead peer is terminated within two intervals (~60s). */
const HEARTBEAT_INTERVAL_MS = 30_000;

/** Observer for outgoing alerts; see WsServer.onAlert. */
export type AlertListener = (
  alert: { type: string; message: FrontendMessage; reason: string },
  userId?: string,
) => void | Promise<void>;

export class WsServer {
  private wss: WebSocketServer;
  private clients: Map<WebSocket, ClientState> = new Map();
  private alertListeners: AlertListener[] = [];
  private onUserConnect?: (userId: string) => void;
  private onUserDisconnect?: (userId: string) => void;
  /** Above this many buffered bytes, non-essential frames are skipped. */
  private readonly softBufferLimit: number;
  /** Above this many buffered bytes, the socket is terminated. */
  private readonly hardBufferLimit: number;

  constructor(server: Server) {
    this.softBufferLimit = readByteLimit(
      ['OCT_WS_BUFFER_SOFT_LIMIT', 'TRENCHCORD_WS_BUFFER_SOFT_LIMIT'],
      DEFAULT_SOFT_BUFFER_LIMIT,
    );
    // A hard cap below the soft cap would terminate before ever skipping;
    // clamp so the two-stage guard always holds.
    this.hardBufferLimit = Math.max(
      readByteLimit(
        ['OCT_WS_BUFFER_HARD_LIMIT', 'TRENCHCORD_WS_BUFFER_HARD_LIMIT'],
        DEFAULT_HARD_BUFFER_LIMIT,
      ),
      this.softBufferLimit,
    );

    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws) => {
      console.log('[WS] Client connected');
      const state: ClientState = { subscribedRooms: new Set(), userId: null, isAlive: true, skippedFrames: 0 };
      this.clients.set(ws, state);

      ws.on('pong', () => {
        state.isAlive = true;
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleClientMessage(ws, msg);
        } catch {
          // ignore malformed messages
        }
      });

      ws.on('close', () => {
        const state = this.clients.get(ws);
        console.log('[WS] Client disconnected');
        if (state?.userId && this.onUserDisconnect) {
          this.onUserDisconnect(state.userId);
        }
        this.clients.delete(ws);
      });
    });

    // Heartbeat: without it a peer that vanishes without a FIN (mobile sleep,
    // network drop, killed process) stays readyState OPEN forever — fan-out
    // keeps buffering frames into its dead socket, and one ghost pins every
    // adaptive poller (fomo 10s, callouts 12s, wallet movement 30s) at its
    // fast interval because getAuthenticatedClientCount() never reaches 0.
    // terminate() fires the 'close' handler above, so cleanup and
    // onUserDisconnect run exactly as they do for a graceful close.
    const heartbeat = setInterval(() => this.sweepDeadConnections(), HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();
    this.wss.on('close', () => clearInterval(heartbeat));
  }

  /** Ping every open socket; terminate any that never ponged the previous ping. */
  private sweepDeadConnections(): void {
    for (const [ws, state] of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (!state.isAlive) {
        console.log('[WS] Terminating unresponsive client');
        ws.terminate();
        continue;
      }
      state.isAlive = false;
      ws.ping();
    }
  }

  setUserLifecycleCallbacks(
    onConnect: (userId: string) => void,
    onDisconnect: (userId: string) => void,
  ): void {
    this.onUserConnect = onConnect;
    this.onUserDisconnect = onDisconnect;
  }

  private handleClientMessage(ws: WebSocket, msg: any): void {
    switch (msg.type) {
      case 'auth': {
        if (!isHostedMode() || !msg.token) break;
        const state = this.clients.get(ws);
        if (!state) break;

        // Shared cache-first verifier (auth/middleware.ts): the console's REST
        // polling has usually just verified this same JWT, so a WS connect (or
        // a redeploy-triggered reconnect storm) costs no extra GoTrue round-trip.
        verifyAccessToken(msg.token).then((userId) => {
          if (!userId) {
            ws.send(JSON.stringify({ type: 'auth_error', error: 'Invalid token' }));
            return;
          }
          state.userId = userId;
          if (this.onUserConnect) {
            this.onUserConnect(userId);
          }
        }).catch(() => {
          ws.send(JSON.stringify({ type: 'auth_error', error: 'Auth verification failed' }));
        });
        break;
      }
      case 'subscribe': {
        const state = this.clients.get(ws);
        if (state && msg.roomId) {
          state.subscribedRooms.add(msg.roomId);
          console.log(`[WS] Client subscribed to room ${msg.roomId}`);
        }
        break;
      }
      case 'unsubscribe': {
        const state = this.clients.get(ws);
        if (state && msg.roomId) {
          state.subscribedRooms.delete(msg.roomId);
        }
        break;
      }
      case 'subscribe_all': {
        const state = this.clients.get(ws);
        if (state) {
          state.subscribedRooms.add('__all__');
        }
        break;
      }
    }
  }

  /**
   * Live connection snapshot for the admin stats surface.
   *
   * `users` counts distinct authenticated identities, not sockets — one person
   * with the console open in three tabs is one user, three connections. In
   * local mode clients never authenticate, so `users` stays 0 and `connections`
   * is the only meaningful figure.
   */
  getLiveStats(): { connections: number; users: number; anonymousConnections: number } {
    const users = new Set<string>();
    let anonymous = 0;

    for (const [ws, state] of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (state.userId) users.add(state.userId);
      else anonymous++;
    }

    return {
      connections: [...this.clients].filter(([ws]) => ws.readyState === WebSocket.OPEN).length,
      users: users.size,
      anonymousConnections: anonymous,
    };
  }

  /**
   * Serialize-once, serialize-lazily fan-out to every open socket, filtered to
   * `userId`'s sockets in hosted mode. `isHostedMode()` reads `process.env`
   * (an interceptor call, not a plain property read), so it is evaluated once
   * per broadcast here rather than once per client in each loop.
   *
   * JSON.stringify runs at the first eligible recipient, not up front: in
   * hosted mode the steady state is pollers and idle telegram gateways
   * broadcasting for users whose console tabs are closed, and those
   * zero-recipient calls should cost a map walk, not a 2 KB serialization.
   */
  private fanout(msg: Record<string, any>, userId?: string, essential = false): void {
    const filterByUser = isHostedMode() && !!userId;
    let payload: string | undefined;
    for (const [ws, state] of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (filterByUser && state.userId !== userId) continue;
      this.guardedSend(ws, state, payload ??= JSON.stringify(msg), essential);
    }
  }

  /** Fan-out additionally gated on the client's room subscriptions. */
  private fanoutToRooms(msg: Record<string, any>, roomIds: string[], userId?: string): void {
    const filterByUser = isHostedMode() && !!userId;
    let payload: string | undefined;
    for (const [ws, state] of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (filterByUser && state.userId !== userId) continue;
      if (
        !state.subscribedRooms.has('__all__') &&
        !roomIds.some((id) => state.subscribedRooms.has(id))
      ) continue;
      this.guardedSend(ws, state, payload ??= JSON.stringify(msg), false);
    }
  }

  /**
   * Backpressure-guarded send (see the module comment above for the model).
   * Essential frames (alerts) keep queueing between the soft and hard caps;
   * everything else is skipped there. Past the hard cap the socket is
   * terminated outright — the frontend auto-reconnects if it is still alive.
   */
  private guardedSend(ws: WebSocket, state: ClientState, payload: string, essential: boolean): void {
    const buffered = ws.bufferedAmount;
    if (buffered > this.hardBufferLimit) {
      console.warn(
        `[WS] Terminating stalled client: bufferedAmount=${buffered} exceeds hard cap ` +
        `${this.hardBufferLimit} (${state.skippedFrames} frames already skipped)`,
      );
      ws.terminate();
      return;
    }
    if (!essential && buffered > this.softBufferLimit) {
      state.skippedFrames++;
      if (state.skippedFrames === 1 || state.skippedFrames % 500 === 0) {
        console.warn(
          `[WS] Skipping non-essential frames for slow client: bufferedAmount=${buffered} ` +
          `exceeds soft cap ${this.softBufferLimit} (${state.skippedFrames} skipped so far)`,
        );
      }
      return;
    }
    ws.send(payload);
  }

  broadcastMessage(message: FrontendMessage, roomIds: string[], userId?: string): void {
    this.fanoutToRooms({ type: 'message', data: message, roomIds }, roomIds, userId);
  }

  broadcastMessageUpdate(update: { messageId: string; channelId: string; embeds?: FrontendMessage['embeds']; content?: string; attachments?: FrontendMessage['attachments']; editedTimestamp?: string | null }, roomIds: string[], userId?: string): void {
    this.fanoutToRooms({ type: 'message_update', data: update, roomIds }, roomIds, userId);
  }

  broadcastMessageDelete(data: { messageId: string; channelId: string }, roomIds: string[], userId?: string): void {
    this.fanoutToRooms({ type: 'message_delete', data, roomIds }, roomIds, userId);
  }

  /**
   * Side-channel observers for alerts (the OCT bot's DM delivery uses this).
   * Every alert in the app funnels through broadcastAlert, so this is the one
   * seam an extra delivery channel needs — no changes at the call sites.
   * Observers are best-effort: they must never block or break the WS broadcast.
   */
  onAlert(listener: AlertListener): void {
    this.alertListeners.push(listener);
  }

  broadcastAlert(alert: { type: string; message: FrontendMessage; reason: string }, userId?: string): void {
    this.fanout({ type: 'alert', data: alert }, userId, true);

    for (const listener of this.alertListeners) {
      try {
        void Promise.resolve(listener(alert, userId)).catch((err) =>
          console.error('[WsServer] Alert listener failed:', err?.message ?? err),
        );
      } catch (err) {
        console.error('[WsServer] Alert listener threw:', (err as Error)?.message ?? err);
      }
    }
  }

  broadcastReactionUpdate(data: { channelId: string; messageId: string; emoji: { id: string | null; name: string; animated?: boolean }; delta: number }, userId?: string): void {
    this.fanout({ type: 'reaction_update', data }, userId);
  }

  broadcastContract(data: any, userId?: string): void {
    this.fanout({ type: 'contract', data }, userId);
  }

  broadcastChainUpdate(address: string, evmChain: string, userId?: string): void {
    this.fanout({ type: 'chain_update', data: { address, evmChain } }, userId);
  }

  /**
   * Revival ignition alert (the app's loudest alert class). Delivered to the
   * subscribed user's sockets in hosted mode; all clients in local mode.
   * Payload shape: RevivalAlertData (@oct/shared).
   */
  broadcastRevivalAlert(data: any, userId?: string): void {
    this.fanout({ type: 'revival_alert', data }, userId, true);
  }

  /**
   * Breakout ignition alert — revival's quieter sibling (quiet consolidation
   * at the highs igniting). Same delivery rules as revival_alert.
   * Payload shape: BreakoutAlertData (@oct/shared).
   */
  broadcastBreakoutAlert(data: any, userId?: string): void {
    this.fanout({ type: 'breakout_alert', data }, userId, true);
  }

  broadcastContractEnrichment(data: any, userId?: string): void {
    this.fanout({ type: 'contract_enrichment', data }, userId);
  }

  broadcastRaw(msg: Record<string, any>, userId?: string): void {
    this.fanout(msg, userId);
  }

  /**
   * Targeted per-user send. In hosted mode a message is delivered only to the
   * sockets authenticated as `userId`; in local mode (single tenant, sockets
   * never authenticate) it falls back to all connected clients. Used by the
   * FOMO fan-out poller to route a trade to exactly the OCT user(s) tracking it.
   */
  sendToUser(userId: string, msg: Record<string, any>): void {
    this.fanout(msg, userId);
  }

  hasActiveClients(userId: string): boolean {
    for (const [ws, state] of this.clients) {
      if (ws.readyState === WebSocket.OPEN && state.userId === userId) return true;
    }
    return false;
  }

  /** Count WS clients authenticated in hosted mode (used for adaptive FOMO polling). */
  getAuthenticatedClientCount(): number {
    let count = 0;
    for (const [ws, state] of this.clients) {
      if (ws.readyState === WebSocket.OPEN && state.userId) count++;
    }
    return count;
  }
}
