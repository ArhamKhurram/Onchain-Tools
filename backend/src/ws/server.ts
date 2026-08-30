import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { FrontendMessage } from '../discord/types.js';
import { isHostedMode } from '../storage/index.js';
import { verifyAccessToken } from '../auth/middleware.js';

interface ClientState {
  subscribedRooms: Set<string>;
  userId: string | null;
}

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

  constructor(server: Server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws) => {
      console.log('[WS] Client connected');
      this.clients.set(ws, { subscribedRooms: new Set(), userId: null });

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
   * Serialize-once fan-out to every open socket, filtered to `userId`'s
   * sockets in hosted mode. `isHostedMode()` reads `process.env` (an
   * interceptor call, not a plain property read), so it is evaluated once
   * per broadcast here rather than once per client in each loop.
   */
  private fanout(payload: string, userId?: string): void {
    const filterByUser = isHostedMode() && !!userId;
    for (const [ws, state] of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (filterByUser && state.userId !== userId) continue;
      ws.send(payload);
    }
  }

  /** Fan-out additionally gated on the client's room subscriptions. */
  private fanoutToRooms(payload: string, roomIds: string[], userId?: string): void {
    const filterByUser = isHostedMode() && !!userId;
    for (const [ws, state] of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (filterByUser && state.userId !== userId) continue;
      if (
        !state.subscribedRooms.has('__all__') &&
        !roomIds.some((id) => state.subscribedRooms.has(id))
      ) continue;
      ws.send(payload);
    }
  }

  broadcastMessage(message: FrontendMessage, roomIds: string[], userId?: string): void {
    this.fanoutToRooms(JSON.stringify({ type: 'message', data: message, roomIds }), roomIds, userId);
  }

  broadcastMessageUpdate(update: { messageId: string; channelId: string; embeds?: FrontendMessage['embeds']; content?: string; attachments?: FrontendMessage['attachments']; editedTimestamp?: string | null }, roomIds: string[], userId?: string): void {
    this.fanoutToRooms(JSON.stringify({ type: 'message_update', data: update, roomIds }), roomIds, userId);
  }

  broadcastMessageDelete(data: { messageId: string; channelId: string }, roomIds: string[], userId?: string): void {
    this.fanoutToRooms(JSON.stringify({ type: 'message_delete', data, roomIds }), roomIds, userId);
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
    this.fanout(JSON.stringify({ type: 'alert', data: alert }), userId);

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
    this.fanout(JSON.stringify({ type: 'reaction_update', data }), userId);
  }

  broadcastContract(data: any, userId?: string): void {
    this.fanout(JSON.stringify({ type: 'contract', data }), userId);
  }

  broadcastChainUpdate(address: string, evmChain: string, userId?: string): void {
    this.fanout(JSON.stringify({ type: 'chain_update', data: { address, evmChain } }), userId);
  }

  /**
   * Revival ignition alert (the app's loudest alert class). Delivered to the
   * subscribed user's sockets in hosted mode; all clients in local mode.
   * Payload shape: RevivalAlertData (@oct/shared).
   */
  broadcastRevivalAlert(data: any, userId?: string): void {
    this.fanout(JSON.stringify({ type: 'revival_alert', data }), userId);
  }

  /**
   * Breakout ignition alert — revival's quieter sibling (quiet consolidation
   * at the highs igniting). Same delivery rules as revival_alert.
   * Payload shape: BreakoutAlertData (@oct/shared).
   */
  broadcastBreakoutAlert(data: any, userId?: string): void {
    this.fanout(JSON.stringify({ type: 'breakout_alert', data }), userId);
  }

  broadcastContractEnrichment(data: any, userId?: string): void {
    this.fanout(JSON.stringify({ type: 'contract_enrichment', data }), userId);
  }

  broadcastRaw(msg: Record<string, any>, userId?: string): void {
    this.fanout(JSON.stringify(msg), userId);
  }

  /**
   * Targeted per-user send. In hosted mode a message is delivered only to the
   * sockets authenticated as `userId`; in local mode (single tenant, sockets
   * never authenticate) it falls back to all connected clients. Used by the
   * FOMO fan-out poller to route a trade to exactly the OCT user(s) tracking it.
   */
  sendToUser(userId: string, msg: Record<string, any>): void {
    this.fanout(JSON.stringify(msg), userId);
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
