// FOMO fan-out-on-write poller.
//
// One global poll of FOMO's trading-activity feed for the whole platform. Each
// new trade is routed to every OCT user tracking that FOMO user via a targeted
// WS event and (optionally) a Pushover push, and logged to fomo_trade_events.
//
// The whole service self-gates: without a shared FOMO service account
// (FOMO_REFRESH_TOKEN) or Supabase, it logs one line and stays idle — it must
// never crash the server.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { WsServer } from '../ws/server.js';
import { ensureSharedFomoClient, type FomoClient } from './client.js';
import {
  getFomoServiceClient,
  normalizeTrade,
  extractTradesArray,
  type NormalizedTrade,
} from './store.js';
import { getStorageProvider } from '../storage/index.js';
import { sendPushover } from '../utils/pushover.js';

const DEBUG = process.env.DEBUG === 'true';
const DEFAULT_INTERVAL_MS = 10_000;
const ACTIVITY_LIMIT = 50;

interface TrackerRow {
  user_id: string;
  notify_pushover: boolean;
}

class FomoPoller {
  private wsServer: WsServer;
  private client: FomoClient | null = null;
  private db: SupabaseClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastTradeId: string | null = null;
  private polling = false;
  private started = false;
  private loggedSample = false;

  constructor(wsServer: WsServer) {
    this.wsServer = wsServer;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    const db = getFomoServiceClient();
    if (!db) {
      console.log('[FomoPoller] Supabase not configured; FOMO poller idle.');
      return;
    }
    this.db = db;

    void this.bootstrap();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async bootstrap(): Promise<void> {
    try {
      const client = await ensureSharedFomoClient();
      if (!client) {
        console.log('[FomoPoller] No FOMO refresh token in DB or env; poller idle.');
        return;
      }
      this.client = client;

      await this.loadState();
      // Launches stealth Chromium + exchanges the refresh token for a JWT.
      await this.client.init();

      const interval = Number.parseInt(process.env.FOMO_POLL_INTERVAL_MS ?? '', 10) || DEFAULT_INTERVAL_MS;
      console.log(`[FomoPoller] Started fan-out poller (interval ${interval}ms).`);
      this.timer = setInterval(() => {
        void this.poll().catch((err) => console.error('[FomoPoller] poll error:', (err as Error)?.message));
      }, interval);
    } catch (err) {
      console.error('[FomoPoller] Failed to start:', (err as Error)?.message);
    }
  }

  private async loadState(): Promise<void> {
    const { data, error } = await this.db!
      .from('fomo_poll_state')
      .select('last_trade_id')
      .eq('id', true)
      .single();
    if (error) {
      console.warn('[FomoPoller] Could not load poll state (continuing fresh):', error.message);
      return;
    }
    this.lastTradeId = data?.last_trade_id ?? null;
  }

  private async saveCursor(lastTradeId: string | null): Promise<void> {
    if (!lastTradeId) return;
    this.lastTradeId = lastTradeId;
    const { error } = await this.db!
      .from('fomo_poll_state')
      .update({ last_trade_id: lastTradeId, last_polled_at: new Date().toISOString() })
      .eq('id', true);
    if (error) console.warn('[FomoPoller] Failed to persist poll cursor:', error.message);
  }

  private async poll(): Promise<void> {
    if (this.polling || !this.client || !this.db) return;
    this.polling = true;
    try {
      const res = await this.client.getTradingActivity(ACTIVITY_LIMIT);
      const rawList = extractTradesArray(res.json);

      // Log a sample raw payload once so the real feed shape can be verified
      // against the (currently unverified) normalizer field guesses.
      if (DEBUG && !this.loggedSample && rawList.length > 0) {
        this.loggedSample = true;
        console.log('[FomoPoller] Sample raw trade payload:', JSON.stringify(rawList[0], null, 2).slice(0, 2000));
      }

      // The feed is ASSUMED newest-first. Collect trades until we reach the last
      // one we already processed (the cursor).
      const normalized = rawList.map(normalizeTrade);
      const newestId = normalized.find((t) => t.tradeId)?.tradeId ?? null;

      // First run: seed the cursor to the newest trade without dispatching the
      // historical backlog (avoids notifying everyone about old trades).
      if (this.lastTradeId === null) {
        if (newestId) {
          await this.saveCursor(newestId);
          console.log('[FomoPoller] Seeded poll cursor on first run; skipping historical backlog.');
        }
        return;
      }

      const fresh: NormalizedTrade[] = [];
      for (const t of normalized) {
        if (!t.tradeId) continue; // can't dedup a trade with no id; skip it
        if (t.tradeId === this.lastTradeId) break;
        fresh.push(t);
      }

      // Dispatch oldest-first so notification order matches trade order.
      for (const trade of fresh.reverse()) {
        await this.dispatch(trade);
      }

      if (newestId) await this.saveCursor(newestId);
    } finally {
      this.polling = false;
    }
  }

  private async dispatch(trade: NormalizedTrade): Promise<void> {
    if (!trade.fomoUserId || !this.db) return;

    // Reverse fan-out: who tracks this FOMO user?
    const { data: trackers, error } = await this.db
      .from('fomo_tracked_users')
      .select('user_id, notify_pushover')
      .eq('fomo_user_id', trade.fomoUserId);
    if (error) {
      console.error('[FomoPoller] Failed to load trackers:', error.message);
      return;
    }
    if (!trackers || trackers.length === 0) return; // nobody tracks this user

    // Log the dispatched trade. The unique index on trade_id makes this the
    // authoritative dedup guard: a 23505 means we already dispatched it, so we
    // bail out to avoid double-notifying.
    const insert = await this.db.from('fomo_trade_events').insert({
      fomo_user_id: trade.fomoUserId,
      fomo_handle: trade.fomoHandle,
      side: trade.side,
      token_address: trade.tokenAddress,
      token_symbol: trade.tokenSymbol,
      network_id: trade.networkId,
      usd_value: trade.usdValue,
      raw: trade.raw,
      trade_id: trade.tradeId,
    });
    if (insert.error) {
      if ((insert.error as any).code === '23505') return; // already dispatched
      console.error('[FomoPoller] Failed to log trade event:', insert.error.message);
      // continue anyway — delivery matters more than the log row
    }

    const payload = {
      type: 'fomo_trade',
      data: {
        fomoUserId: trade.fomoUserId,
        fomoHandle: trade.fomoHandle,
        displayName: trade.displayName,
        side: trade.side,
        tokenAddress: trade.tokenAddress,
        tokenSymbol: trade.tokenSymbol,
        networkId: trade.networkId,
        usdValue: trade.usdValue,
        tradeId: trade.tradeId,
      },
    };

    for (const tracker of trackers as TrackerRow[]) {
      // (a) targeted WS event to just this OCT user
      this.wsServer.sendToUser(tracker.user_id, payload);
      // (b) optional Pushover push
      if (tracker.notify_pushover) {
        await this.notifyPushover(tracker.user_id, trade);
      }
    }
  }

  private async notifyPushover(userId: string, trade: NormalizedTrade): Promise<void> {
    try {
      const config = await getStorageProvider().getConfig(userId);
      if (!config.pushover?.enabled) return;

      const who = trade.displayName || (trade.fomoHandle ? `@${trade.fomoHandle}` : 'A tracked trader');
      const sideLabel = trade.side ? trade.side.toUpperCase() : 'TRADE';
      const token = trade.tokenSymbol || trade.tokenAddress || 'a token';
      const usd = trade.usdValue != null ? ` ($${Math.round(trade.usdValue).toLocaleString()})` : '';

      await sendPushover(config.pushover, {
        title: `FOMO: ${who} ${sideLabel}`,
        message: `${who} ${sideLabel} ${token}${usd}`,
      });
    } catch (err) {
      console.error('[FomoPoller] Pushover notify failed:', (err as Error)?.message);
    }
  }
}

let _poller: FomoPoller | null = null;

/**
 * Start the global FOMO fan-out poller. No-op (idle) without a shared FOMO
 * service account or Supabase. Safe to call once on server boot.
 */
export function startFomoPoller(wsServer: WsServer): void {
  if (_poller) return;
  _poller = new FomoPoller(wsServer);
  _poller.start();
}
