/**
 * Price-alert poller — watches the levels the operator set, and only those.
 *
 * WHY IT LIVES IN ITS OWN DIRECTORY. `backend/src/alerts/` is the
 * missed-runner subsystem's home (missedRunnerPoller + tokenPeak*). Dropping an
 * unrelated signal in there would read as fusing the two, which CLAUDE.md
 * forbids. `backend/src/priceAlerts/` is a sibling of `revival/` and
 * `journal/`: its own detector, its own poller, its own store — no shared code
 * path with revival, breakout, convergence, FOMO or missed-runner.
 *
 * Every OCT_PRICE_ALERT_POLL_MS (default 25s):
 * 1. Load ARMED alerts (per-user via storage in local mode; one cross-user
 *    service query in hosted mode — the revival/journal poller split).
 * 2. Dedupe mints across alerts and users, then read them from DexScreener's
 *    BATCH token endpoint.
 * 3. Evaluate the pure crossing detector per alert (crossing.ts) and write the
 *    observation back through StorageProvider.
 * 4. On a crossing: fire ONCE — `price_alert` WS frame (toast + notification
 *    history client-side) and Pushover at NORMAL priority (0, explicit; the
 *    emergency tier stays revival-only). Status flips to 'fired', so the alert
 *    leaves the sweep and no cooldown is needed.
 *
 * SELF-GATING: zero armed alerts means zero upstream requests. The sweep also
 * shrinks as alerts fire, rather than growing forever.
 *
 * REQUEST BUDGET (DexScreener, keyless). One request per BATCH of
 * OCT_PRICE_ALERT_BATCH_SIZE (default 10) unique armed mints, spaced
 * REQUEST_SPACING_MS (250ms). At the 25s default that is:
 *   - 10 watched tokens  → 1 request  / 25s ≈  2.4 req/min
 *   - 50 watched tokens  → 5 requests / 25s ≈ 12   req/min
 *   - 200 watched tokens → 20 requests/ 25s ≈ 48   req/min
 * DexScreener's keyless ceiling for this endpoint family is ~300 req/min, so
 * even a 200-token watchlist sits around a sixth of it — and the volume-death
 * poller's ~3 req/min shares the same budget comfortably. The truncation retry
 * (see below) can add requests, bounded by log2 of the batch size per affected
 * batch, i.e. at most ~4 extra per batch of 10.
 *
 * THE 30-PAIR CAP. `/latest/dex/tokens/{a,b,c,…}` documents a 30-ADDRESS limit
 * but caps the RESPONSE at 30 PAIRS, silently dropping tokens (measured
 * 2026-08-14: 10 mints in, 30 pairs out, only 7 mints covered). Small batches
 * plus a halving retry on any capped response with missing mints (crossing.ts)
 * make the drop detectable instead of silent. A singleton that still comes back
 * empty is genuinely unlisted, and the poller abstains on it.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { PriceAlert, PriceAlertData } from '@oct/shared';
import type { WsServer } from '../ws/server.js';
import type { PriceAlertObservationPatch } from '../storage/interface.js';
import { getStorageProvider, isHostedMode } from '../storage/index.js';
import { getFomoServiceClient } from '../fomo/store.js';
import { sendPushover } from '../utils/pushover.js';
import {
  DEFAULT_BATCH_SIZE,
  chunkMints,
  evaluateCrossing,
  snapshotsFromPairs,
  splitForRetry,
  valueForMetric,
  wasTruncated,
  type DexPair,
  type MintSnapshot,
} from './crossing.js';

const LOCAL_USER_ID = 'local';
export const DEFAULT_PRICE_ALERT_POLL_MS = 25_000;
/** Polite spacing between keyless DexScreener requests. */
export const REQUEST_SPACING_MS = 250;
/** Ceiling on armed alerts pulled per cycle (hosted cross-user sweep). */
const ARMED_ALERT_LIMIT = 1_000;

function envFlag(name: string): string | undefined {
  return process.env[`OCT_${name}`] ?? process.env[`TRENCHCORD_${name}`];
}

/**
 * USD for humans. Local rather than wallets/balanceChecker's `formatCompact`
 * because a PRICE alert is routinely sub-dollar ($0.0042) and that helper
 * rounds anything under $1000 to whole units — it would report a price
 * crossing as "$0".
 */
function formatUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toPrecision(3)}`;
}

/** Master switch. Only an explicit falsy value disables (journal style). */
export function isPriceAlertsEnabled(): boolean {
  const raw = (envFlag('PRICE_ALERTS_ENABLED') ?? '').trim().toLowerCase();
  return !(raw === 'false' || raw === '0' || raw === 'off');
}

function resolvePollMs(): number {
  const parsed = Number.parseInt(envFlag('PRICE_ALERT_POLL_MS') ?? '', 10);
  // 10s floor: below that the request budget stops being the constraint and
  // DexScreener's own update cadence does.
  return Number.isFinite(parsed) && parsed >= 10_000 ? parsed : DEFAULT_PRICE_ALERT_POLL_MS;
}

function resolveBatchSize(): number {
  const parsed = Number.parseInt(envFlag('PRICE_ALERT_BATCH_SIZE') ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 30 ? parsed : DEFAULT_BATCH_SIZE;
}

interface AlertWithUser extends PriceAlert {
  userId: string;
}

class PriceAlertPoller {
  private wsServer: WsServer;
  private db: SupabaseClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private polling = false;
  /**
   * Alerts already fired this process. The durable record is `status='fired'`
   * (and the status-guarded update in priceAlertsRepo); this only stops a
   * duplicate ping if a write fails and the row comes back armed next cycle.
   */
  private firedThisProcess = new Set<string>();

  constructor(wsServer: WsServer) {
    this.wsServer = wsServer;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    if (!isPriceAlertsEnabled()) {
      console.log('[PriceAlerts] Disabled via OCT_PRICE_ALERTS_ENABLED; poller idle.');
      return;
    }
    if (isHostedMode()) {
      this.db = getFomoServiceClient();
      if (!this.db) {
        console.log('[PriceAlerts] Hosted mode without Supabase service client; poller idle.');
        return;
      }
    }

    const interval = resolvePollMs();
    console.log(`[PriceAlerts] Started (interval ${interval}ms, batch ${resolveBatchSize()} mints/request).`);
    this.timer = setInterval(() => {
      void this.poll().catch((err) =>
        console.error('[PriceAlerts] poll error:', (err as Error)?.message),
      );
    }, interval);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async loadArmedAlerts(): Promise<AlertWithUser[]> {
    if (!isHostedMode()) {
      const alerts = await getStorageProvider().listPriceAlerts(LOCAL_USER_ID, 'armed');
      return alerts.map((a) => ({ ...a, userId: LOCAL_USER_ID }));
    }
    if (!this.db) return [];
    const { data, error } = await this.db
      .from('price_alerts')
      .select('*')
      .eq('status', 'armed')
      .limit(ARMED_ALERT_LIMIT);
    if (error) {
      if (!/does not exist|Could not find the table|schema cache/i.test(error.message ?? '')) {
        console.warn('[PriceAlerts] Alert load failed:', error.message);
      }
      return [];
    }
    return ((data ?? []) as any[]).map((row) => ({
      id: row.id,
      chain: row.chain ?? 'solana',
      mint: row.mint,
      symbol: row.symbol ?? null,
      direction: row.direction === 'below' ? ('below' as const) : ('above' as const),
      targetUsd: Number(row.target_usd ?? 0),
      metric: row.metric === 'price' ? ('price' as const) : ('mcap' as const),
      status: 'armed' as const,
      note: row.note ?? null,
      lastSeenUsd: row.last_seen_usd != null ? Number(row.last_seen_usd) : null,
      lastSeenAt: row.last_seen_at ?? null,
      firedAt: null,
      firedValueUsd: null,
      createdAt: row.created_at,
      userId: row.user_id as string,
    }));
  }

  /** One batch request. Null means the request itself failed (abstain). */
  private async fetchBatch(mints: string[]): Promise<DexPair[] | null> {
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mints.join(',')}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        if (res.status === 429) console.warn('[PriceAlerts] DexScreener rate-limited (429).');
        return null;
      }
      const body = (await res.json()) as { pairs?: DexPair[] };
      return body.pairs ?? [];
    } catch (err) {
      console.warn('[PriceAlerts] DexScreener fetch failed:', (err as Error).message);
      return null;
    }
  }

  /**
   * Read every mint, honouring the 30-pair response cap: batch, then re-query
   * the halves of any batch that came back AT the cap with mints unaccounted
   * for. Mints missing from a singleton response are genuinely unlisted and are
   * simply absent from the returned map (the caller abstains on them).
   */
  private async readSnapshots(mints: string[]): Promise<Map<string, MintSnapshot>> {
    const out = new Map<string, MintSnapshot>();
    const queue = chunkMints(mints, resolveBatchSize());
    let first = true;

    while (queue.length > 0) {
      const batch = queue.shift() as string[];
      if (!first) await sleep(REQUEST_SPACING_MS);
      first = false;

      const pairs = await this.fetchBatch(batch);
      if (pairs === null) continue; // request failure = data gap, abstain
      const { snapshots, missing } = snapshotsFromPairs(pairs, batch);
      for (const [mint, snap] of snapshots) out.set(mint, snap);

      // Only a CAPPED response can have hidden a listed token; anything else
      // means those mints really have no pair.
      if (missing.length > 0 && wasTruncated(pairs.length)) {
        for (const half of splitForRetry(missing)) queue.push(half);
      }
    }
    return out;
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const alerts = await this.loadArmedAlerts();
      if (alerts.length === 0) return; // self-gating: no armed alerts, no requests

      const mints = [...new Set(alerts.map((a) => a.mint))];
      const snapshots = await this.readSnapshots(mints);
      const nowIso = new Date().toISOString();
      const storage = getStorageProvider();

      for (const alert of alerts) {
        if (this.firedThisProcess.has(alert.id)) continue;
        const snapshot = snapshots.get(alert.mint);
        const verdict = evaluateCrossing({
          direction: alert.direction,
          targetUsd: alert.targetUsd,
          lastSeenUsd: alert.lastSeenUsd,
          observedUsd: snapshot ? valueForMetric(snapshot, alert.metric) : null,
        });
        // No pair, no price for this metric, or a failed request: write nothing
        // at all, so the next real reading is compared against the last real
        // one rather than against a gap.
        if (verdict.action === 'abstain' || verdict.observedUsd == null) continue;

        const patch: PriceAlertObservationPatch = {
          lastSeenUsd: verdict.observedUsd,
          lastSeenAt: nowIso,
          symbol: alert.symbol ?? snapshot?.symbol ?? null,
        };

        if (verdict.action === 'fire') {
          this.firedThisProcess.add(alert.id);
          patch.status = 'fired';
          patch.firedAt = nowIso;
          patch.firedValueUsd = verdict.observedUsd;
        }

        try {
          await storage.updatePriceAlertObservation(alert.userId, alert.id, patch);
        } catch (err) {
          console.warn('[PriceAlerts] observation write failed:', (err as Error)?.message);
          // The alert stays armed; the next cycle re-evaluates from the last
          // durable lastSeenUsd. Deliver the ping anyway if it fired — a lost
          // write must not cost the operator the alert they asked for.
        }

        if (verdict.action !== 'fire') continue;

        const symbol = alert.symbol ?? snapshot?.symbol ?? null;
        const data: PriceAlertData = {
          alertId: alert.id,
          mint: alert.mint,
          chain: alert.chain,
          symbol,
          direction: alert.direction,
          metric: alert.metric,
          targetUsd: alert.targetUsd,
          valueUsd: verdict.observedUsd,
          previousUsd: alert.lastSeenUsd,
          note: alert.note,
          triggeredAt: nowIso,
        };

        const sym = symbol ? `$${symbol}` : `${alert.mint.slice(0, 6)}…`;
        console.log(
          `[PriceAlerts] CROSSED ${sym} (${alert.mint.slice(0, 8)}…) ${alert.direction} ` +
            `${alert.metric} ${formatUsd(alert.targetUsd)} → now ${formatUsd(verdict.observedUsd)} ` +
            `(was ${alert.lastSeenUsd != null ? formatUsd(alert.lastSeenUsd) : '?'}) ` +
            `→ user ${alert.userId === LOCAL_USER_ID ? 'local' : alert.userId.slice(0, 8)}`,
        );

        this.wsServer.sendToUser(alert.userId, { type: 'price_alert', data });
        void this.notifyPushover(alert.userId, data, sym);
      }
    } finally {
      this.polling = false;
    }
  }

  private async notifyPushover(userId: string, data: PriceAlertData, sym: string): Promise<void> {
    try {
      const config = await getStorageProvider().getConfig(userId);
      if (!config.pushover?.enabled) return;
      const unit = data.metric === 'mcap' ? 'mcap' : 'price';
      const note = data.note ? ` — "${data.note}"` : '';
      // NORMAL priority, explicitly — never the user's configured priority and
      // never the emergency tier, which stays reserved for revival.
      await sendPushover(config.pushover, {
        title: `${sym} crossed ${data.direction} ${formatUsd(data.targetUsd)} ${unit}`,
        message:
          `${sym} ${unit} is now ${formatUsd(data.valueUsd)}, ` +
          `${data.direction} your ${formatUsd(data.targetUsd)} level${note}`,
        url: `https://dexscreener.com/${data.chain}/${data.mint}`,
        urlTitle: 'Open chart',
        priority: 0,
      });
    } catch (err) {
      console.error('[PriceAlerts] Pushover notify failed:', (err as Error)?.message);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let _poller: PriceAlertPoller | null = null;

export function startPriceAlertPoller(wsServer: WsServer): void {
  if (_poller) return;
  _poller = new PriceAlertPoller(wsServer);
  _poller.start();
}

export function stopPriceAlertPoller(): void {
  _poller?.stop();
  _poller = null;
}
