/**
 * Revival ignition poller.
 *
 * Every OCT_REVIVAL_POLL_MS (default 2.5 min):
 * 1. Build the per-user token universe: Solana contracts detected in the
 *    user's feed within the last 48h, most recent first, capped at 30/user.
 * 2. Dedupe tokens across users (each mint is fetched/evaluated once per
 *    cycle, like the FOMO poller dedupes tracked traders).
 * 3. Fetch minute + hour candles from GeckoTerminal (staggered, rate-limit
 *    aware, hard-capped per cycle) and run the ATR-gate detector.
 * 4. On ignition (subject to a 60-min per-token cooldown): fan out a
 *    `revival_alert` WS frame to every subscribed user and send Pushover at
 *    EMERGENCY priority (2, retry 30s, expire 30min) — revival is the loudest
 *    alert class in the app; every other alert keeps its configured priority.
 *
 * Self-gates cleanly: local mode reads the JSON contract log (no Supabase
 * required); hosted mode reads the contracts table via the service client.
 * Cooldowns are in-memory (v1); fired alerts are persisted via the storage
 * provider (revival-alerts.json locally, revival_alerts in hosted mode) and
 * their outcomes tracked for 24h by RevivalOutcomeTracker — open windows are
 * resumed from storage on boot.
 *
 * Revival is its own signal end-to-end. It is never fused with convergence,
 * missed-runner, or FOMO detections.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { WsServer } from '../ws/server.js';
import type { RevivalAlertData } from '@oct/shared';
import { getStorageProvider, isHostedMode } from '../storage/index.js';
import { getFomoServiceClient } from '../fomo/store.js';
import { sendPushover } from '../utils/pushover.js';
import { buildContractUrl } from '../utils/contract.js';
import { formatCompact } from '../wallets/balanceChecker.js';
import { evaluateRevival } from './detector.js';
import { fetchRevivalCandles, isBackedOff } from './candles.js';
import {
  buildAlertEntry,
  partitionOpenAlerts,
  OUTCOME_WINDOW_MS,
  RevivalOutcomeTracker,
} from './outcomeTracker.js';
import type { RevivalAlertEntry } from '@oct/shared';

const LOCAL_USER_ID = 'local';
const DEFAULT_POLL_MS = 150_000; // 2.5 min
const UNIVERSE_LOOKBACK_MS = 48 * 3_600_000;
const MAX_TOKENS_PER_USER = 30;
// Global per-cycle cap across all users: 2 GeckoTerminal calls per token
// (minute + hour; pool resolution is cached 1h) at 700ms spacing keeps the
// keyless API comfortable. Larger universes rotate across cycles.
const MAX_TOKENS_PER_CYCLE = 40;
const REQUEST_SPACING_MS = 700;
const ALERT_COOLDOWN_MS = 60 * 60_000;

function envFlag(name: string): string | undefined {
  return process.env[`OCT_${name}`] ?? process.env[`TRENCHCORD_${name}`];
}

export function isRevivalEnabled(): boolean {
  const v = (envFlag('REVIVAL_ENABLED') ?? '').trim().toLowerCase();
  // Default ON in both modes; only an explicit falsy value disables.
  return !(v === 'false' || v === '0' || v === 'off');
}

function resolvePollMs(): number {
  const parsed = Number.parseInt(envFlag('REVIVAL_POLL_MS') ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 30_000 ? parsed : DEFAULT_POLL_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** mint → subscribed userIds, insertion-ordered by feed recency. */
export type RevivalUniverse = Map<string, Set<string>>;

interface UserContractRow {
  userId: string;
  address: string;
  timestamp: string;
}

/**
 * Per-user cap + cross-user dedupe. Rows must be sorted newest-first; the
 * resulting map preserves that order so the per-cycle cap keeps the freshest
 * tokens.
 */
export function buildUniverse(rows: UserContractRow[], maxPerUser: number = MAX_TOKENS_PER_USER): RevivalUniverse {
  const perUser = new Map<string, Set<string>>();
  const universe: RevivalUniverse = new Map();
  for (const row of rows) {
    const mint = row.address;
    let mine = perUser.get(row.userId);
    if (!mine) {
      mine = new Set();
      perUser.set(row.userId, mine);
    }
    if (mine.has(mint)) continue;
    if (mine.size >= maxPerUser) continue;
    mine.add(mint);
    let subs = universe.get(mint);
    if (!subs) {
      subs = new Set();
      universe.set(mint, subs);
    }
    subs.add(row.userId);
  }
  return universe;
}

class RevivalPoller {
  private wsServer: WsServer;
  private db: SupabaseClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private polling = false;
  /** mint → last alert epoch ms (in-memory v1 cooldown; resets on reboot). */
  private cooldowns = new Map<string, number>();
  /** Rotation pointer so universes above the per-cycle cap are fully covered. */
  private rotationOffset = 0;
  /** 24h peak tracking for fired alerts (slow cadence, write-on-improvement). */
  private outcomes = new RevivalOutcomeTracker();

  constructor(wsServer: WsServer) {
    this.wsServer = wsServer;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    if (!isRevivalEnabled()) {
      console.log('[RevivalPoller] Disabled via OCT_REVIVAL_ENABLED; poller idle.');
      return;
    }
    if (isHostedMode()) {
      this.db = getFomoServiceClient();
      if (!this.db) {
        console.log('[RevivalPoller] Hosted mode without Supabase service client; poller idle.');
        return;
      }
    }

    const interval = resolvePollMs();
    console.log(`[RevivalPoller] Started (interval ${interval}ms, cap ${MAX_TOKENS_PER_CYCLE} tokens/cycle).`);
    this.outcomes.start();
    void this.resumeOpenOutcomes().catch((err) =>
      console.error('[RevivalPoller] outcome resume error:', (err as Error)?.message),
    );
    void this.poll().catch((err) => console.error('[RevivalPoller] initial poll error:', (err as Error)?.message));
    this.timer = setInterval(() => {
      void this.poll().catch((err) => console.error('[RevivalPoller] poll error:', (err as Error)?.message));
    }, interval);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.outcomes.stop();
  }

  /**
   * Boot resilience: reload alerts whose 24h outcome window is still open and
   * hand them back to the tracker (this is why peak state lives in the row,
   * not memory). Windows that expired during downtime get their close stamped
   * so the log never shows a permanent "tracking…".
   */
  private async resumeOpenOutcomes(): Promise<void> {
    const rows: (RevivalAlertEntry & { userId: string })[] = [];

    if (!isHostedMode()) {
      const entries = await getStorageProvider().listRevivalAlerts(LOCAL_USER_ID, 200);
      for (const e of entries) rows.push({ ...e, userId: LOCAL_USER_ID });
    } else {
      if (!this.db) return;
      const { data, error } = await this.db
        .from('revival_alerts')
        .select('*')
        .is('outcome_window_closed_at', null)
        .limit(500);
      if (error) {
        console.warn('[RevivalPoller] Open-outcome load failed:', error.message);
        return;
      }
      for (const r of (data ?? []) as any[]) {
        rows.push({
          id: r.id,
          mint: r.mint,
          symbol: r.symbol ?? null,
          network: r.network ?? 'solana',
          priceUsd: r.price_usd != null ? Number(r.price_usd) : null,
          mcapUsd: r.mcap_usd != null ? Number(r.mcap_usd) : null,
          atrZ: Number(r.atr_z ?? 0),
          rvol: Number(r.rvol ?? 0),
          triggeredAt: r.triggered_at,
          peakPriceUsd: r.peak_price_usd != null ? Number(r.peak_price_usd) : null,
          peakMcapUsd: r.peak_mcap_usd != null ? Number(r.peak_mcap_usd) : null,
          peakMultiple: r.peak_multiple != null ? Number(r.peak_multiple) : null,
          peakAt: r.peak_at ?? null,
          outcomeWindowClosedAt: r.outcome_window_closed_at ?? null,
          userId: r.user_id as string,
        });
      }
    }

    const { open, expired } = partitionOpenAlerts(rows, Date.now());
    for (const e of expired) {
      const closedAt = new Date(new Date(e.triggeredAt).getTime() + OUTCOME_WINDOW_MS).toISOString();
      try {
        await getStorageProvider().updateRevivalAlertOutcome(e.userId, e.id, {
          outcomeWindowClosedAt: closedAt,
        });
      } catch (err) {
        console.warn('[RevivalPoller] Failed to close expired outcome:', (err as Error)?.message);
      }
    }
    this.outcomes.resumeEntries(open.map((e) => ({ entry: e, userId: e.userId })));
  }

  private async loadUniverse(): Promise<RevivalUniverse> {
    const since = new Date(Date.now() - UNIVERSE_LOOKBACK_MS).toISOString();

    if (!isHostedMode()) {
      const contracts = await getStorageProvider().getContracts(LOCAL_USER_ID, 500, since);
      const rows: UserContractRow[] = contracts
        .filter((c) => c.chain === 'sol')
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .map((c) => ({ userId: LOCAL_USER_ID, address: c.address, timestamp: c.timestamp }));
      return buildUniverse(rows);
    }

    if (!this.db) return new Map();
    // Column-scoped read (mirrors the missed-runner poller's slim load): the
    // universe needs only user/address/recency, never the message payloads.
    const { data, error } = await this.db
      .from('contracts')
      .select('user_id, address, timestamp')
      .eq('chain', 'sol')
      .gt('timestamp', since)
      .order('timestamp', { ascending: false })
      .limit(2000);
    if (error) {
      console.warn('[RevivalPoller] Universe load failed:', error.message);
      return new Map();
    }
    const rows: UserContractRow[] = (data ?? []).map((r: any) => ({
      userId: r.user_id as string,
      address: r.address as string,
      timestamp: r.timestamp as string,
    }));
    return buildUniverse(rows);
  }

  /** Next up-to-cap window of mints, advancing the rotation pointer. */
  private nextSlice(all: string[]): string[] {
    if (all.length <= MAX_TOKENS_PER_CYCLE) {
      this.rotationOffset = 0;
      return all;
    }
    if (this.rotationOffset >= all.length) this.rotationOffset = 0;
    const slice = all.slice(this.rotationOffset, this.rotationOffset + MAX_TOKENS_PER_CYCLE);
    this.rotationOffset += MAX_TOKENS_PER_CYCLE;
    return slice;
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const universe = await this.loadUniverse();
      if (universe.size === 0) return;

      const slice = this.nextSlice([...universe.keys()]);
      let first = true;
      for (const mint of slice) {
        if (isBackedOff()) return; // rate-limited — resume next cycle
        const subscribers = universe.get(mint);
        if (!subscribers || subscribers.size === 0) continue;

        const last = this.cooldowns.get(mint);
        if (last != null && Date.now() - last < ALERT_COOLDOWN_MS) continue;

        if (!first && REQUEST_SPACING_MS > 0) await sleep(REQUEST_SPACING_MS);
        first = false;

        try {
          await this.evaluateToken(mint, subscribers);
        } catch (err) {
          console.warn(`[RevivalPoller] evaluate failed for ${mint.slice(0, 8)}…:`, (err as Error)?.message);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private async evaluateToken(mint: string, subscribers: Set<string>): Promise<void> {
    const candles = await fetchRevivalCandles(mint);
    if (!candles) return;

    const now = Date.now();
    const verdict = evaluateRevival(candles.minute, candles.hour, now);
    if (!verdict.fired) return;

    this.cooldowns.set(mint, now);

    const price = verdict.price;
    const mcapUsd =
      price != null && candles.pool.impliedSupply != null
        ? price * candles.pool.impliedSupply
        : null;
    const data: RevivalAlertData = {
      mint,
      symbol: candles.pool.symbol,
      price,
      mcapUsd,
      atrZ: verdict.atrZ ?? 0,
      rvol: verdict.rvol ?? 0,
      triggeredAt: new Date(now).toISOString(),
    };

    const sym = data.symbol ? `$${data.symbol}` : `${mint.slice(0, 6)}…`;
    console.log(
      `[RevivalPoller] IGNITION ${sym} (${mint.slice(0, 8)}…) atrZ=${data.atrZ.toFixed(1)} rvol=${data.rvol.toFixed(1)} → ${subscribers.size} user(s)`,
    );

    for (const userId of subscribers) {
      // Persist before broadcast so a client refetching the revival log on
      // frame arrival always finds the row. A storage failure never blocks
      // the live alert — the broadcast/pushover fan-out still runs.
      try {
        const entry = buildAlertEntry(data);
        await getStorageProvider().logRevivalAlert(userId, entry);
        this.outcomes.track({
          alertId: entry.id,
          userId,
          mint: entry.mint,
          alertPriceUsd: entry.priceUsd,
          peakPriceUsd: entry.peakPriceUsd,
          triggeredAtMs: now,
        });
      } catch (err) {
        console.error('[RevivalPoller] Failed to persist alert:', (err as Error)?.message);
      }
      this.wsServer.broadcastRevivalAlert(data, userId);
      void this.notifyPushover(userId, data, sym);
    }
  }

  private async notifyPushover(userId: string, data: RevivalAlertData, sym: string): Promise<void> {
    try {
      const config = await getStorageProvider().getConfig(userId);
      if (!config.pushover?.enabled) return;
      const mc = data.mcapUsd != null ? formatCompact(data.mcapUsd) : '—';
      const url = buildContractUrl(data.mint, config.contractLinkTemplates);
      // EMERGENCY tier is reserved for revival: re-alerts every 30s for 30min
      // until acknowledged. Every other alert keeps the user's configured
      // priority — only revival overrides it.
      await sendPushover(config.pushover, {
        title: `REVIVAL: ${sym} igniting`,
        message: `${sym} igniting — mcap ${mc}, RVOL ${data.rvol.toFixed(1)}x, ATR z ${data.atrZ.toFixed(1)}`,
        url,
        urlTitle: 'Open token',
        priority: 2,
        retry: 30,
        expire: 1800,
      });
    } catch (err) {
      console.error('[RevivalPoller] Pushover notify failed:', (err as Error)?.message);
    }
  }
}

let _poller: RevivalPoller | null = null;

export function startRevivalPoller(wsServer: WsServer): void {
  if (_poller) return;
  _poller = new RevivalPoller(wsServer);
  _poller.start();
}

export function stopRevivalPoller(): void {
  _poller?.stop();
  _poller = null;
}
