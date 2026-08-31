// j7tracker consumer — the in-process replacement for the two dead social
// upstreams (fomo.family activity + pump.fun callouts). Boots one socket.io
// connection per configured account, maps each data event onto the console's
// EXISTING `pump_callout` / `fomo_trade` WS frames, and fans them out over the
// same WsServer the old pollers used. No new frontend WS types, no auto-subscribe.
//
// Self-gates on J7_JWTS_JSON, exactly as the other background subsystems gate on
// their own env (fomo on the refresh token, journal on HELIUS_API_KEY, …): with
// no non-empty JWTs the consumer logs once and idles, so a deploy without j7
// credentials runs the server cleanly.

import type { WsServer } from '../ws/server.js';
import { J7Consumer, parseJ7Accounts } from './client.js';
import { BoundedDeduper, type J7EventSink } from './events.js';
import { getJ7CalloutStore } from './store.js';

const LOCAL_USER_ID = 'local';
// Trades are feed-only and unpersisted, so their re-send guard is a bounded
// in-memory set. Callouts dedup via the persistent store instead (see the sink).
const TRADE_DEDUP_CAPACITY = Number.parseInt(process.env.J7_TRADE_DEDUP_CAPACITY ?? '', 10) || 5_000;

let _consumer: J7Consumer | null = null;

export function startJ7Consumer(wsServer: WsServer): void {
  if (_consumer) return;

  const accounts = parseJ7Accounts(process.env.J7_JWTS_JSON);
  if (accounts.length === 0) {
    console.log('[J7] J7_JWTS_JSON not configured (or no non-empty JWTs); consumer idle.');
    return;
  }

  // Where mapped frames land. In local mode sendToUser broadcasts to every
  // console socket (single implicit user), which is the operator alpha. In
  // hosted mode set J7_DELIVER_USER_ID to the operator's Supabase user id to
  // route the global j7 feed to them; unset, it targets 'local' and reaches no
  // hosted socket — a safe no-op until deliberately configured.
  const targetUserId = process.env.J7_DELIVER_USER_ID?.trim() || LOCAL_USER_ID;

  const store = getJ7CalloutStore();
  const tradeDedup = new BoundedDeduper(TRADE_DEDUP_CAPACITY);

  const sink: J7EventSink = {
    onCallout(data) {
      // The store is both system-of-record AND the callout dedup: record() is
      // idempotent, so a batched ~30s re-send returns false and never re-fires
      // the feed/toast. Because it persists, a reconnect backlog after a restart
      // is not re-announced either.
      if (!store.record(data)) return;
      wsServer.sendToUser(targetUserId, { type: 'pump_callout', data });
    },
    onFomoTrade(data) {
      // Feed-only, so the re-send guard is the in-memory bounded set on tradeId.
      if (data.tradeId && !tradeDedup.add(data.tradeId)) return;
      wsServer.sendToUser(targetUserId, { type: 'fomo_trade', data });
    },
  };

  _consumer = new J7Consumer(accounts, sink);
  _consumer.start();
  console.log(`[J7] Consumer wired for ${accounts.length} account(s) → delivering to userId="${targetUserId}".`);
}

/** Tear down the consumer (clean shutdown / tests). */
export function stopJ7Consumer(): void {
  _consumer?.stop();
  _consumer = null;
}
