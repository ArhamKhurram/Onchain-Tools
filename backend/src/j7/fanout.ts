// Per-follower delivery for j7 events.
//
// The first cut of the consumer sent every mapped frame to ONE user id — fine
// while j7 was an operator-only feed, wrong the moment the upstream roster is
// the union of what everybody tracks: a caller is now subscribed BECAUSE some
// user follows them, so the events have to reach that user and nobody else.
//
// This mirrors pumpfun/calloutPoller.ts's dispatch exactly, so a j7 callout
// behaves like the old poller's did — same `pump_callout` frame, the same
// per-follower `notify` flag driving the toast/sound, the same Pushover push,
// the same opt-in Discord DM last. That parity is the point: the upstream died
// and was replaced; the delivery contract did not change.
//
// Two ordering rules are structural:
//
//  1. PERSIST BEFORE FAN-OUT, AND PERSIST REGARDLESS. store.record() is OCT's
//     system-of-record and its dedup gate. A callout for a caller nobody
//     follows is still recorded — j7 never backfills, so an unrecorded callout
//     is gone forever.
//  2. DMs LAST. deliverCalloutDms is paced and never rejects, but it is still
//     network work per recipient; the WS frame and the push must already be out.

import type { WsServer } from '../ws/server.js';
import { getStorageProvider } from '../storage/index.js';
import { sendPushover } from '../utils/pushover.js';
import { compactUsd } from '../bot/layout.js';
import { loadTrackersByAddress, type CallerTrackerRow } from '../pumpfun/calloutStore.js';
import { deliverCalloutDms, type CalloutDmJob } from '../pumpfun/calloutDm.js';
import { loadFomoTrackersByHandle, type FomoHandleTracker } from './demand.js';
import type { J7CalloutData, J7FomoTradeData } from './mappers.js';

/** Everything the fan-out touches outside itself. Injected so tests need no I/O. */
export interface J7FanoutDeps {
  /** callerAddress → followers. Cached upstream (PUMP_TRACKED_CACHE_MS). */
  loadCalloutTrackers(): Promise<Map<string, CallerTrackerRow[]>>;
  /** lower-cased fomo handle → subscribers. Cached upstream. */
  loadTradeTrackers(): Promise<Map<string, FomoHandleTracker[]>>;
  sendToUser(userId: string, payload: Record<string, unknown>): void;
  /** Best-effort push; reads the recipient's own Pushover config. */
  pushover(userId: string, msg: { title: string; message: string }): Promise<void>;
  deliverDms(jobs: CalloutDmJob[]): Promise<void>;
  /**
   * J7_DELIVER_USER_ID — an operator who gets a copy of EVERY j7 event, not
   * just the ones they follow, so the whole global feed can be watched from one
   * console. Deduplicated against the follower list below, so an operator who
   * also follows a caller gets exactly one frame (theirs, with their own notify
   * flag). Null when unset, which is the normal deployment.
   */
  observerUserId: string | null;
}

/** Wire the live implementations to a WsServer. */
export function makeJ7FanoutDeps(wsServer: WsServer, observerUserId: string | null): J7FanoutDeps {
  return {
    loadCalloutTrackers: loadTrackersByAddress,
    loadTradeTrackers: loadFomoTrackersByHandle,
    sendToUser: (userId, payload) => wsServer.sendToUser(userId, payload),
    pushover: async (userId, msg) => {
      try {
        const config = await getStorageProvider().getConfig(userId);
        if (!config.pushover?.enabled) return;
        await sendPushover(config.pushover, msg);
      } catch (err) {
        console.error('[J7] Pushover notify failed:', (err as Error)?.message);
      }
    },
    deliverDms: async (jobs) => {
      await deliverCalloutDms(jobs);
    },
    observerUserId,
  };
}

/** `$1.2M` / `` — the MC-at-call suffix, empty when j7 didn't carry one. */
function mcapSuffix(value: number | null): string {
  return value != null ? ` @ ${compactUsd(value)}` : '';
}

/**
 * Fan one mapped callout out to everyone following its caller.
 *
 * The caller has already been persisted by the sink (see the header) — this is
 * delivery only. Zero followers is the normal case for most of the roster's
 * tail and costs nothing: no frame, no push, no DM.
 */
export async function fanOutCallout(data: J7CalloutData, deps: J7FanoutDeps): Promise<void> {
  const trackers = await deps.loadCalloutTrackers();
  const followers = trackers.get(data.callerAddress) ?? [];

  const who = data.username ? `@${data.username}` : 'A tracked caller';
  const coin = data.symbol ? `$${data.symbol}` : 'a coin';
  const dmJobs: CalloutDmJob[] = [];

  for (const f of followers) {
    // `notify` is per-follower: it drives the console toast/sound as well as
    // the push, so a muted follow still lands in the feed silently.
    deps.sendToUser(f.userId, { type: 'pump_callout', data: { ...data, notify: f.notifyPushover } });

    if (f.notifyPushover) {
      const thesis = data.thesis ? ` — "${data.thesis.slice(0, 120)}"` : '';
      await deps.pushover(f.userId, {
        title: `Pump: ${who} called ${coin}`,
        message: `${who} → ${coin}${mcapSuffix(data.marketCapUsd)}${thesis}`,
      });
    }

    if (f.notifyDiscord) {
      dmJobs.push({
        userId: f.userId,
        notifyDiscord: true,
        callout: {
          callerAddress: data.callerAddress,
          callerName: data.username,
          callerAvatar: data.avatar,
          mint: data.coinMint,
          symbol: data.symbol,
          coinName: data.name,
          thesis: data.thesis,
          marketCapUsd: data.marketCapUsd,
          multiple: data.multiple,
        },
      });
    }
  }

  // The operator's global-feed mirror. Silent (`notify:false`) because it is
  // the WHOLE upstream feed, not a follow — a toast per callout would be
  // unusable. A follower copy already went out above if they follow this caller.
  const observer = deps.observerUserId;
  if (observer && !followers.some((f) => f.userId === observer)) {
    deps.sendToUser(observer, { type: 'pump_callout', data: { ...data, notify: false } });
  }

  // LAST and fully guarded — a Discord outage must not cost anyone the console
  // ping and push that already landed.
  if (dmJobs.length > 0) {
    await deps.deliverDms(dmJobs).catch((err) =>
      console.error('[J7] callout DM dispatch failed:', (err as Error)?.message),
    );
  }
}

/**
 * Fan one mapped fomo trade out to everyone tracking that handle.
 *
 * Keyed on the HANDLE rather than the fomo user id: the handle is what j7's
 * roster subscribes by and what its events carry, and it is the only identifier
 * guaranteed to be on both sides of the join.
 */
export async function fanOutTrade(data: J7FomoTradeData, deps: J7FanoutDeps): Promise<void> {
  const handle = data.fomoHandle?.trim().toLowerCase() ?? '';
  const trackers = handle ? (await deps.loadTradeTrackers()).get(handle) ?? [] : [];

  for (const t of trackers) {
    deps.sendToUser(t.userId, { type: 'fomo_trade', data: { ...data, notify: t.notifyPushover } });
    if (t.notifyPushover) {
      const who = data.displayName || (data.fomoHandle ? `@${data.fomoHandle}` : 'A tracked trader');
      const side = data.side ? data.side.toUpperCase() : 'TRADE';
      const token = data.tokenSymbol || data.tokenAddress || 'a token';
      const usd = data.usdValue != null ? ` ($${Math.round(data.usdValue).toLocaleString()})` : '';
      await deps.pushover(t.userId, { title: `FOMO: ${who} ${side}`, message: `${who} ${side} ${token}${usd}` });
    }
  }

  const observer = deps.observerUserId;
  if (observer && !trackers.some((t) => t.userId === observer)) {
    deps.sendToUser(observer, { type: 'fomo_trade', data: { ...data, notify: false } });
  }
}
