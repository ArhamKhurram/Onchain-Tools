// j7tracker consumer — the in-process replacement for the two dead social
// upstreams (fomo.family activity + pump.fun callouts). Boots one socket.io
// connection per configured account, maps each data event onto the console's
// EXISTING `pump_callout` / `fomo_trade` WS frames, and fans them out over the
// same WsServer the old pollers used. No new frontend WS types.
//
// The module is now a closed loop rather than a fixed feed:
//
//   user follows a caller  →  roster.ts subscribes a j7 account to them
//                          →  j7 pushes their callouts
//                          →  fanout.ts delivers to that user (and any other
//                             follower), with their own notify flag
//
// so the upstream roster is the deduped UNION of everyone's picks, capped by
// j7's 50-per-account limit and ranked by follower count when demand exceeds it.
//
// Self-gates on J7_JWTS_JSON, exactly as the other background subsystems gate on
// their own env (fomo on the refresh token, journal on HELIUS_API_KEY, …): with
// no non-empty JWTs the consumer logs once and idles — no sockets, no
// reconciler, no Supabase reads — so a deploy without j7 credentials runs the
// server cleanly.

import type { WsServer } from '../ws/server.js';
import { getStorageProvider } from '../storage/index.js';
import { sendPushover } from '../utils/pushover.js';
import { J7Consumer, parseJ7Accounts, type J7Account } from './client.js';
import { BoundedDeduper, type J7EventSink } from './events.js';
import { fanOutCallout, fanOutTrade, makeJ7FanoutDeps, type J7FanoutDeps } from './fanout.js';
import { startJ7JwtWatch, stopJ7JwtWatch } from './jwt.js';
import type { J7CalloutData } from './mappers.js';
import { startJ7RosterReconciler, stopJ7RosterReconciler } from './roster.js';
import { getJ7CalloutStore } from './store.js';

const LOCAL_USER_ID = 'local';
// Trades are feed-only and unpersisted, so their re-send guard is a bounded
// in-memory set. Callouts dedup via the persistent store instead (see the sink).
const TRADE_DEDUP_CAPACITY = Number.parseInt(process.env.J7_TRADE_DEDUP_CAPACITY ?? '', 10) || 5_000;

let _consumer: J7Consumer | null = null;

/**
 * Serial delivery queue.
 *
 * j7 pushes in ~30s batches, so a dozen `onCallout` calls can land in the same
 * tick. Running their fan-outs concurrently would fire a dozen simultaneous
 * tracker reads before the first populated the shared TTL cache — a thundering
 * herd on Supabase for rows we already had, on a project where egress is the
 * binding cap. Chaining them costs nothing (each is a cache hit after the first)
 * and preserves arrival order, so the console renders a batch in the order j7
 * sent it.
 */
let _tail: Promise<void> = Promise.resolve();
function enqueue(job: () => Promise<void>): void {
  _tail = _tail
    .then(job)
    .catch((err) => console.error('[J7] delivery failed:', (err as Error)?.message));
}

/**
 * Who gets the operator's whole-feed mirror, and who gets the JWT-expiry push.
 *
 * In local mode `sendToUser('local')` reaches every console socket (single
 * implicit user), which is the operator alpha. In hosted mode set
 * J7_DELIVER_USER_ID to the operator's Supabase user id. Unset in hosted mode
 * there is no mirror at all — events still reach their followers, which is now
 * the primary path.
 */
function resolveObserverUserId(): string | null {
  const configured = process.env.J7_DELIVER_USER_ID?.trim();
  if (configured) return configured;
  return process.env.OCT_MODE === 'hosted' || process.env.TRENCHCORD_MODE === 'hosted'
    ? null
    : LOCAL_USER_ID;
}

/** Best-effort operator push for credential warnings (never throws). */
async function notifyOperator(userId: string | null, message: string): Promise<void> {
  if (!userId) return;
  try {
    const config = await getStorageProvider().getConfig(userId);
    if (!config.pushover?.enabled) return;
    await sendPushover(config.pushover, { title: 'OCT: j7 credential expiring', message });
  } catch (err) {
    console.error('[J7] operator notify failed:', (err as Error)?.message);
  }
}

/** Await every queued delivery. Test seam — nothing in the server waits on this. */
export function flushJ7Deliveries(): Promise<void> {
  return _tail;
}

/** The callout log, narrowed to what the sink uses (and what a test can fake). */
export interface J7CalloutRecorder {
  /** True when newly recorded — doubles as the dedup gate. */
  record(data: J7CalloutData): boolean;
}

/**
 * The sink that turns mapped events into per-follower delivery.
 *
 * Exported (with both collaborators injectable) so the persist-then-fan-out
 * ordering — including "persist even when nobody follows" — is unit-tested
 * without a socket, Supabase or the on-disk log.
 */
export function makeSink(deps: J7FanoutDeps, recorder?: J7CalloutRecorder): J7EventSink {
  const store = recorder ?? getJ7CalloutStore();
  const tradeDedup = new BoundedDeduper(TRADE_DEDUP_CAPACITY);

  return {
    onCallout(data) {
      // The store is both system-of-record AND the callout dedup: record() is
      // idempotent, so a batched ~30s re-send returns false and never re-fires
      // the feed/toast. Because it persists, a reconnect backlog after a restart
      // is not re-announced either — which matters more now that a roster change
      // deliberately reconnects sockets.
      //
      // It runs even when nobody follows the caller: j7 never backfills, so an
      // unrecorded callout is gone for good.
      if (!store.record(data)) return;
      enqueue(() => fanOutCallout(data, deps));
    },
    onFomoTrade(data) {
      // Feed-only, so the re-send guard is the in-memory bounded set on tradeId.
      if (data.tradeId && !tradeDedup.add(data.tradeId)) return;
      enqueue(() => fanOutTrade(data, deps));
    },
  };
}

export function startJ7Consumer(wsServer: WsServer): void {
  if (_consumer) return;

  const accounts: J7Account[] = parseJ7Accounts(process.env.J7_JWTS_JSON);
  if (accounts.length === 0) {
    console.log('[J7] J7_JWTS_JSON not configured (or no non-empty JWTs); consumer idle.');
    return;
  }

  const observerUserId = resolveObserverUserId();
  const deps = makeJ7FanoutDeps(wsServer, observerUserId);

  _consumer = new J7Consumer(accounts, makeSink(deps));
  _consumer.start();

  // Keep the upstream roster equal to what OCT's users track. Boot-delayed, so
  // the sockets above are connected before the first reconcile bounces any.
  startJ7RosterReconciler(accounts, _consumer);

  // 15-day tokens with no refresh flow: warn days ahead, every day, in the log
  // and (if configured) to the operator's phone.
  startJ7JwtWatch(accounts, { notify: (message) => notifyOperator(observerUserId, message) });

  console.log(
    `[J7] Consumer wired for ${accounts.length} account(s) → per-follower fan-out` +
      (observerUserId ? `, mirroring the full feed to userId="${observerUserId}".` : '.'),
  );
}

/** Tear down the consumer (clean shutdown / tests). */
export function stopJ7Consumer(): void {
  stopJ7RosterReconciler();
  stopJ7JwtWatch();
  _consumer?.stop();
  _consumer = null;
}
