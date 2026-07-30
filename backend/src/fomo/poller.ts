// FOMO fan-out-on-write poller.
//
// Polls `/v2/users/{id}/activity` once per unique tracked FOMO trader (deduped
// across all OCT subscribers). Each new swap is stored in fomo_trade_events,
// then fanned out to every OCT user tracking that trader via fomo_trade_deliveries.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { WsServer } from '../ws/server.js';
import { ensureSharedFomoClientReady } from './client.js';
import type { FomoClientLike } from './types.js';
import { syncAllTrackedFollows } from './follows.js';
import { resolveTradeTokenInfo } from './tokenInfo.js';
import {
  loadActivityCursors,
  storeAndFanOutTrade,
  upsertActivityCursor,
} from './dispatch.js';
import {
  getFomoServiceClient,
  extractUserActivitiesArray,
  normalizeUserActivity,
  type NormalizedTrade,
  type TrackedFomoUserRef,
} from './store.js';

const DEBUG = process.env.DEBUG === 'true';
const DEFAULT_INTERVAL_MS = 10_000;
const IDLE_INTERVAL_MS = Number.parseInt(process.env.FOMO_POLL_IDLE_INTERVAL_MS ?? '', 10) || 60_000;
const USER_ACTIVITY_LIMIT =
  Number.parseInt(process.env.FOMO_USER_ACTIVITY_LIMIT ?? '', 10) || 15;

class FomoPoller {
  private wsServer: WsServer;
  private client: FomoClientLike | null = null;
  private db: SupabaseClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private pollIntervalMs = DEFAULT_INTERVAL_MS;
  private polling = false;
  private started = false;
  private loggedSample = false;
  private lastPollAt: string | null = null;
  private lastPollError: string | null = null;
  private lastSuccessfulPollAt: string | null = null;
  private trackedUserCount = 0;
  private status: FomoPollerStatus = { active: false, reason: 'no_supabase' };

  constructor(wsServer: WsServer) {
    this.wsServer = wsServer;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    const db = getFomoServiceClient();
    if (!db) {
      console.log('[FomoPoller] Supabase not configured; FOMO poller idle.');
      this.status = { active: false, reason: 'no_supabase' };
      return;
    }
    this.db = db;

    void this.bootstrap();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async bootstrap(): Promise<void> {
    try {
      const client = await ensureSharedFomoClientReady();
      if (!client) {
        console.log('[FomoPoller] No FOMO refresh token in DB or env; poller idle.');
        this.status = { active: false, reason: 'no_refresh_token' };
        return;
      }
      this.client = client;

      await this.syncTrackedFollows();

      this.pollIntervalMs = this.resolvePollInterval();
      console.log(
        `[FomoPoller] Started store-and-fan-out poller (interval ${this.pollIntervalMs}ms, limit ${USER_ACTIVITY_LIMIT}).`,
      );
      void this.poll().catch((err) => console.error('[FomoPoller] initial poll error:', (err as Error)?.message));
      this.scheduleNextPoll();
      this.status = {
        active: true,
        reason: 'running',
        pollIntervalMs: this.pollIntervalMs,
        trackedUserCount: this.trackedUserCount,
        lastPollAt: this.lastPollAt,
        lastPollError: this.lastPollError,
        lastSuccessfulPollAt: this.lastSuccessfulPollAt,
      };
    } catch (err) {
      console.error('[FomoPoller] Failed to start:', (err as Error)?.message);
      this.status = { active: false, reason: 'bootstrap_failed', lastPollError: (err as Error)?.message };
    }
  }

  private resolvePollInterval(): number {
    const configured = Number.parseInt(process.env.FOMO_POLL_INTERVAL_MS ?? '', 10);
    if (Number.isFinite(configured) && configured > 0) return configured;
    return this.wsServer.getAuthenticatedClientCount() > 0 ? DEFAULT_INTERVAL_MS : IDLE_INTERVAL_MS;
  }

  private scheduleNextPoll(): void {
    if (this.timer) clearTimeout(this.timer);
    this.pollIntervalMs = this.resolvePollInterval();
    this.timer = setTimeout(() => {
      void this.poll()
        .catch((err) => console.error('[FomoPoller] poll error:', (err as Error)?.message))
        .finally(() => this.scheduleNextPoll());
    }, this.pollIntervalMs);
  }

  getStatus(): FomoPollerStatus {
    return {
      ...this.status,
      pollIntervalMs: this.pollIntervalMs,
      trackedUserCount: this.trackedUserCount,
      lastPollAt: this.lastPollAt,
      lastPollError: this.lastPollError,
      lastSuccessfulPollAt: this.lastSuccessfulPollAt,
    };
  }

  private async syncTrackedFollows(): Promise<void> {
    if (!this.client || !this.db) return;
    const { data, error } = await this.db.from('fomo_tracked_users').select('fomo_user_id');
    if (error) {
      console.warn('[FomoPoller] Could not load tracked users for follow sync:', error.message);
      return;
    }
    const ids = (data ?? []).map((row) => row.fomo_user_id).filter(Boolean);
    if (ids.length === 0) return;
    await syncAllTrackedFollows(this.client, ids);
  }

  private async loadTrackedUsers(): Promise<TrackedFomoUserRef[]> {
    const { data, error } = await this.db!
      .from('fomo_tracked_users')
      .select('fomo_user_id, fomo_handle, display_name');
    if (error) throw error;

    const byId = new Map<string, TrackedFomoUserRef>();
    for (const row of data ?? []) {
      if (!row.fomo_user_id || byId.has(row.fomo_user_id)) continue;
      byId.set(row.fomo_user_id, {
        fomoUserId: row.fomo_user_id,
        fomoHandle: row.fomo_handle ?? null,
        displayName: row.display_name ?? null,
      });
    }
    return [...byId.values()];
  }

  private async poll(): Promise<void> {
    if (this.polling || !this.client || !this.db) return;
    this.polling = true;
    this.lastPollAt = new Date().toISOString();
    try {
      const tracked = await this.loadTrackedUsers();
      this.trackedUserCount = tracked.length;
      if (tracked.length === 0) {
        this.lastPollError = null;
        this.lastSuccessfulPollAt = this.lastPollAt;
        return;
      }

      const cursors = await loadActivityCursors(
        this.db,
        tracked.map((t) => t.fomoUserId),
      );

      let hadError = false;
      for (const trader of tracked) {
        try {
          await this.pollUserActivity(trader, cursors.get(trader.fomoUserId));
        } catch (err) {
          hadError = true;
          this.lastPollError = (err as Error)?.message ?? String(err);
          console.warn(`[FomoPoller] Activity poll failed for ${trader.fomoUserId}:`, this.lastPollError);
        }
      }

      if (!hadError) {
        this.lastPollError = null;
        this.lastSuccessfulPollAt = this.lastPollAt;
      }
    } finally {
      this.polling = false;
    }
  }

  private async pollUserActivity(
    trader: TrackedFomoUserRef,
    cursorRow: { last_activity_id: string | null; cursor_seeded: boolean } | undefined,
  ): Promise<void> {
    const res = await this.client!.getUserActivity(trader.fomoUserId, USER_ACTIVITY_LIMIT);
    if (!res.status || res.status < 200 || res.status >= 300) {
      throw new Error(
        `activity ${trader.fomoUserId} upstream ${res.status ?? 0}: ${res.text?.slice?.(0, 200) ?? ''}`,
      );
    }

    const rawList = extractUserActivitiesArray(res.json);

    if (DEBUG && !this.loggedSample && rawList.length > 0) {
      this.loggedSample = true;
      console.log(
        '[FomoPoller] Sample user activity:',
        JSON.stringify(rawList[0], null, 2).slice(0, 2000),
      );
    }

    const normalized = rawList
      .map((raw) => normalizeUserActivity(raw, trader))
      .filter((t): t is NormalizedTrade => t != null && !!t.tradeId);

    const newestId = normalized.find((t) => t.tradeId)?.tradeId ?? null;
    const userId = trader.fomoUserId;
    const cursorSeeded = cursorRow?.cursor_seeded ?? false;

    if (!cursorSeeded) {
      await upsertActivityCursor(this.db!, userId, newestId, true);
      if (DEBUG) {
        console.log(`[FomoPoller] Seeded activity cursor for ${trader.fomoHandle ?? userId}.`);
      }
      return;
    }

    const cursor = cursorRow?.last_activity_id ?? null;
    const fresh: NormalizedTrade[] = [];
    for (const t of normalized) {
      if (!t.tradeId) continue;
      if (t.tradeId === cursor) break;
      fresh.push(t);
    }

    for (const trade of fresh.reverse()) {
      // FOMO identifies tokens by address only; fill in symbol/name/market cap
      // from OCT's token catalog so the live feed shows what was actually traded.
      const enriched = await resolveTradeTokenInfo(trade);
      await storeAndFanOutTrade(this.db!, this.wsServer, enriched);
    }

    if (newestId && newestId !== cursor) {
      await upsertActivityCursor(this.db!, userId, newestId, true);
    }
  }
}

let _poller: FomoPoller | null = null;

export interface FomoPollerStatus {
  active: boolean;
  reason?: 'no_supabase' | 'no_refresh_token' | 'bootstrap_failed' | 'running';
  pollIntervalMs?: number;
  trackedUserCount?: number;
  lastPollAt?: string | null;
  lastPollError?: string | null;
  lastSuccessfulPollAt?: string | null;
}

export function getFomoPollerStatus(): FomoPollerStatus {
  if (!_poller) return { active: false, reason: 'no_supabase' };
  return _poller.getStatus();
}

export function startFomoPoller(wsServer: WsServer): void {
  if (_poller) return;
  _poller = new FomoPoller(wsServer);
  _poller.start();
}
