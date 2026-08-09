// Pump.fun KOL-callout fan-out poller.
//
// Polls the GLOBAL callouts firehose (frontend-api-v3/callout/recent, keyless)
// on our own cadence — pump's web app doesn't time-poll it, so we do — and diffs
// by `calloutId` against a single persisted cursor. Every new callout whose
// caller (a wallet address == callout.userId) is followed by someone is enriched
// (handle/avatar + ticker, two keyless batch calls) and fanned out to each
// follower over WS + Pushover.
//
// Unlike the FOMO poller there is no per-trader cursor and no shared credential:
// one global keyless poll, one global cursor. `seeded` guards cold start so a
// backlog is recorded, never pinged.

import type { WsServer } from '../ws/server.js';
import { getStorageProvider } from '../storage/index.js';
import { sendPushover } from '../utils/pushover.js';
import { getPumpCalloutFeedClient, type RecentCallout } from './calloutFeedClient.js';
import {
  getPumpServiceClient,
  getCalloutPollState,
  setCalloutPollState,
  loadTrackersByAddress,
  type CallerTrackerRow,
} from './calloutStore.js';
import {
  recordCallerStats,
  recordCalloutObservations,
  pruneCalloutObservations,
  type CallerStatDelta,
  type CalloutObservation,
} from './callerBoardStore.js';

const DEFAULT_INTERVAL_MS = Number.parseInt(process.env.PUMP_CALLOUT_POLL_INTERVAL_MS ?? '', 10) || 12_000;
const IDLE_INTERVAL_MS = Number.parseInt(process.env.PUMP_CALLOUT_IDLE_INTERVAL_MS ?? '', 10) || 60_000;
const PAGE_LIMIT = 30;
// Bound how far back a single poll pages when catching a burst. 5×30 = 150
// callouts; if the cursor is older than that we advance to newest and LOG the
// gap rather than page forever (no silent truncation).
const MAX_PAGES = 5;

// Top Callers board retention: observations older than this are pruned so the
// windowed board's source table stays bounded (matches the widest board window).
const OBSERVATION_RETENTION_MS =
  Number.parseInt(process.env.PUMP_OBSERVATION_RETENTION_MS ?? '', 10) || 30 * 24 * 60 * 60 * 1000;
// Prune at most this often (an indexed delete is cheap, but there is no need to
// run it every 12s). Tracked in-process; the first poll after the interval prunes.
const PRUNE_INTERVAL_MS = Number.parseInt(process.env.PUMP_OBSERVATION_PRUNE_INTERVAL_MS ?? '', 10) || 60 * 60 * 1000;
// Cap how many NEW caller handles one poll resolves, so a cold-start burst (up to
// MAX_PAGES×PAGE_LIMIT fresh callouts) can't fan a single oversized identity POST.
const MAX_ENRICH_PER_POLL = Number.parseInt(process.env.PUMP_BOARD_ENRICH_PER_POLL ?? '', 10) || 60;

function compactUsd(value: number | null): string {
  if (value == null) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(abs / 1e3).toFixed(1)}K`;
  return `$${abs.toFixed(0)}`;
}

class PumpCalloutPoller {
  private wsServer: WsServer;
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private polling = false;
  private pollIntervalMs = DEFAULT_INTERVAL_MS;
  private lastPollError: string | null = null;
  // Callers whose handle/avatar we've already tried to resolve this process. New
  // callers are enriched once; re-seen callers cost no identity call.
  private enrichedAddresses = new Set<string>();
  private lastPruneAt = 0;

  constructor(wsServer: WsServer) {
    this.wsServer = wsServer;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (!getPumpServiceClient()) {
      console.log('[PumpCalloutPoller] Supabase not configured; callout poller idle.');
      return;
    }
    console.log(`[PumpCalloutPoller] Started (interval ${DEFAULT_INTERVAL_MS}ms).`);
    void this.poll().catch((err) => console.error('[PumpCalloutPoller] initial poll error:', (err as Error)?.message));
    this.scheduleNext();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private resolveInterval(): number {
    return this.wsServer.getAuthenticatedClientCount() > 0 ? DEFAULT_INTERVAL_MS : IDLE_INTERVAL_MS;
  }

  private scheduleNext(): void {
    if (this.timer) clearTimeout(this.timer);
    this.pollIntervalMs = this.resolveInterval();
    this.timer = setTimeout(() => {
      void this.poll()
        .catch((err) => console.error('[PumpCalloutPoller] poll error:', (err as Error)?.message))
        .finally(() => this.scheduleNext());
    }, this.pollIntervalMs);
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      // Unlike the follow-only version, we poll EVERY cycle regardless of who is
      // followed: the Top Callers board is built from the global feed itself, so a
      // callout must be recorded even when nobody follows its caller. The idle
      // interval (no authenticated clients) keeps that background load modest.
      const state = await getCalloutPollState();
      const client = getPumpCalloutFeedClient();

      // Page newest→older until we cross the cursor (or hit the page cap),
      // collecting everything newer than last_callout_id.
      const cursor = state?.seeded ? state.lastCalloutId : null;
      const fresh: RecentCallout[] = [];
      let pageToken: string | undefined;
      let newestId: string | null = null;
      let crossedCursor = false;

      for (let page = 0; page < MAX_PAGES; page++) {
        const { callouts, nextPageToken } = await client.getRecentCallouts(PAGE_LIMIT, pageToken);
        if (callouts.length === 0) break;
        if (newestId === null) newestId = callouts[0].calloutId;

        for (const c of callouts) {
          if (cursor && c.calloutId === cursor) { crossedCursor = true; break; }
          fresh.push(c);
        }
        if (crossedCursor || !nextPageToken) break;
        pageToken = nextPageToken;
        if (page === MAX_PAGES - 1 && cursor && !crossedCursor) {
          console.warn('[PumpCalloutPoller] cursor older than page cap; advancing, some callouts skipped.');
        }
      }

      // Record every fresh callout into the board (independent of followers).
      // Recording is not "firing", so it runs on the first (unseeded) poll too —
      // that bootstraps the board from the initial backlog.
      if (fresh.length > 0) {
        await this.recordBoard(fresh).catch((err) =>
          console.warn('[PumpCalloutPoller] board record failed:', (err as Error)?.message),
        );
      }
      await this.maybePrune();

      // First run (unseeded): seed the cursor, fire nothing (never ping a backlog).
      if (!state?.seeded) {
        await setCalloutPollState(newestId, true);
        return;
      }

      // Fan-out to followers — the original behaviour, now gated on there being
      // any tracker rather than short-circuiting the whole poll.
      if (fresh.length > 0) {
        const trackers = await loadTrackersByAddress();
        if (trackers.size > 0) {
          const matched = fresh.filter((c) => trackers.has(c.callerAddress));
          if (matched.length > 0) await this.dispatch(matched, trackers);
        }
      }

      if (newestId && newestId !== cursor) await setCalloutPollState(newestId, true);
      this.lastPollError = null;
    } catch (err) {
      this.lastPollError = (err as Error)?.message ?? String(err);
      console.warn('[PumpCalloutPoller] poll failed:', this.lastPollError);
    } finally {
      this.polling = false;
    }
  }

  /**
   * Record a batch of fresh callouts into the Top Callers board: a per-callout
   * observation row (windowed board) plus a per-caller increment into the running
   * aggregate. Caller deltas are pre-folded so each caller appears once (the
   * increment RPC's ON CONFLICT can't touch a row twice in one statement). New
   * callers are enriched with a handle/avatar via one batched keyless call, capped
   * per poll; already-seen callers cost nothing.
   */
  private async recordBoard(fresh: RecentCallout[]): Promise<void> {
    const observations: CalloutObservation[] = fresh.map((c) => ({
      calloutId: c.calloutId,
      callerAddress: c.callerAddress,
      multiple: c.multiple,
      createdAt: c.createdAt != null ? new Date(c.createdAt).toISOString() : new Date().toISOString(),
    }));

    // Resolve identities only for callers we haven't tried this process, capped.
    const newAddresses = [...new Set(fresh.map((c) => c.callerAddress))]
      .filter((a) => !this.enrichedAddresses.has(a))
      .slice(0, MAX_ENRICH_PER_POLL);
    let users = new Map<string, { username: string | null; avatar: string | null }>();
    if (newAddresses.length > 0) {
      users = await getPumpCalloutFeedClient()
        .resolveUsers(newAddresses)
        .catch(() => new Map());
      for (const a of newAddresses) this.enrichedAddresses.add(a);
    }

    // Pre-fold per caller: count, sum(multiple ?? 0), max(non-null multiple),
    // newest createdAt. One delta per unique caller.
    const byCaller = new Map<string, CallerStatDelta>();
    for (const c of fresh) {
      const iso = c.createdAt != null ? new Date(c.createdAt).toISOString() : new Date().toISOString();
      const existing = byCaller.get(c.callerAddress);
      const enriched = users.get(c.callerAddress);
      if (existing) {
        existing.addCount += 1;
        existing.addSum += c.multiple ?? 0;
        if (c.multiple != null) existing.maxMultiple = Math.max(existing.maxMultiple ?? 0, c.multiple);
        if (existing.lastCalloutAt == null || iso > existing.lastCalloutAt) existing.lastCalloutAt = iso;
      } else {
        byCaller.set(c.callerAddress, {
          callerAddress: c.callerAddress,
          addCount: 1,
          addSum: c.multiple ?? 0,
          maxMultiple: c.multiple ?? null,
          lastCalloutAt: iso,
          username: enriched?.username ?? null,
          avatar: enriched?.avatar ?? null,
        });
      }
    }

    await recordCalloutObservations(observations);
    await recordCallerStats([...byCaller.values()]);
  }

  /** Prune aged observations at most once per PRUNE_INTERVAL_MS. */
  private async maybePrune(): Promise<void> {
    if (Date.now() - this.lastPruneAt < PRUNE_INTERVAL_MS) return;
    this.lastPruneAt = Date.now();
    await pruneCalloutObservations(OBSERVATION_RETENTION_MS).catch((err) =>
      console.warn('[PumpCalloutPoller] observation prune failed:', (err as Error)?.message),
    );
  }

  /** Enrich matched callouts (handle + ticker) and fan out to followers. */
  private async dispatch(
    matched: RecentCallout[],
    trackers: Map<string, CallerTrackerRow[]>,
  ): Promise<void> {
    const client = getPumpCalloutFeedClient();
    const addresses = [...new Set(matched.map((c) => c.callerAddress))];
    const mints = [...new Set(matched.map((c) => c.coinMint))];
    const [users, coins] = await Promise.all([
      client.resolveUsers(addresses).catch(() => new Map()),
      client.resolveCoins(mints).catch(() => new Map()),
    ]);

    // Oldest-first so the newest callout lands last (top of the stack).
    for (const c of matched.reverse()) {
      const followers = trackers.get(c.callerAddress);
      if (!followers || followers.length === 0) continue;
      const user = users.get(c.callerAddress);
      const coin = coins.get(c.coinMint);
      const username = user?.username ?? null;
      const symbol = coin?.symbol ?? null;

      const payload = {
        type: 'pump_callout' as const,
        data: {
          calloutId: c.calloutId,
          callerAddress: c.callerAddress,
          username,
          avatar: user?.avatar ?? null,
          coinMint: c.coinMint,
          symbol,
          name: coin?.name ?? null,
          image: coin?.image ?? null,
          marketCapUsd: c.marketCapUsd,
          thesis: c.thesis,
          multiple: c.multiple,
          createdAt: c.createdAt,
        },
      };

      for (const f of followers) {
        this.wsServer.sendToUser(f.userId, { ...payload, data: { ...payload.data, notify: f.notifyPushover } });
        if (f.notifyPushover) await this.notifyPushover(f.userId, username, symbol, c);
      }
    }
  }

  private async notifyPushover(
    userId: string,
    username: string | null,
    symbol: string | null,
    c: RecentCallout,
  ): Promise<void> {
    try {
      const config = await getStorageProvider().getConfig(userId);
      if (!config.pushover?.enabled) return;
      const who = username ? `@${username}` : 'A tracked caller';
      const coin = symbol ? `$${symbol}` : 'a coin';
      const mc = c.marketCapUsd != null ? ` @ ${compactUsd(c.marketCapUsd)}` : '';
      const thesis = c.thesis ? ` — "${c.thesis.slice(0, 120)}"` : '';
      await sendPushover(config.pushover, {
        title: `Pump: ${who} called ${coin}`,
        message: `${who} → ${coin}${mc}${thesis}`,
      });
    } catch (err) {
      console.error('[PumpCalloutPoller] Pushover notify failed:', (err as Error)?.message);
    }
  }
}

let _poller: PumpCalloutPoller | null = null;

export function startPumpCalloutPoller(wsServer: WsServer): void {
  if (_poller) return;
  _poller = new PumpCalloutPoller(wsServer);
  _poller.start();
}
