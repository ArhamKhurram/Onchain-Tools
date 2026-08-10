/**
 * Revival alert outcome tracker.
 *
 * After a revival alert fires, this module keeps fetching the token's candles
 * for 24h from triggeredAt — even after the token rotates out of the regular
 * detection universe — on a slower cadence (~10 min), and records the highest
 * price seen into the alert row (peak_* columns). Writes are throttled: a row
 * is only touched when the peak improves or when the 24h window closes.
 *
 * Candles are re-fetched on the alert's OWN network (a Robinhood token looked
 * up on Solana simply doesn't resolve), through the shared paced client in
 * candles.ts — this module deliberately does no rate-limiting of its own.
 *
 * All outcome state lives in the persisted row, not in memory: on boot the
 * poller reloads alerts whose outcome window is still open and resumes them,
 * so a restart mid-window loses nothing (beyond a spike during the downtime
 * that had already faded past the candle fetch horizon).
 *
 * The decision logic is pure (evaluateOutcome / maxHighInWindow /
 * partitionOpenAlerts) and unit-tested; the class at the bottom owns the
 * timers and I/O only.
 */

import { randomUUID } from 'crypto';
import type { RevivalAlertEntry, RevivalNetwork, RevivalOutcomePatch } from '@oct/shared';
import { isRevivalNetwork } from '@oct/shared';
import { getStorageProvider } from '../storage/index.js';
import { fetchOhlcv, isBackedOff, resolveTopPool } from './candles.js';
import type { Candle } from './detector.js';

const MINUTE_MS = 60_000;
export const OUTCOME_WINDOW_MS = 24 * 3_600_000;
const DEFAULT_SWEEP_MS = 10 * MINUTE_MS;
/** GeckoTerminal's per-request candle cap; 1000 1m candles ≈ 16.6h. */
const MAX_MINUTE_CANDLES = 1000;

/** In-memory handle on one alert row being tracked (peak state stays in the row). */
export interface TrackedOutcome {
  alertId: string;
  userId: string;
  mint: string;
  /**
   * Chain the alert fired on. Candles for the 24h peak MUST be re-fetched on
   * this network — the same 0x address can exist on several chains, and a
   * Robinhood token looked up on Solana simply doesn't resolve.
   */
  network: RevivalNetwork;
  /** Price at the moment the alert fired (null when unknown at fire time). */
  alertPriceUsd: number | null;
  /** Current best peak, mirroring the persisted row. */
  peakPriceUsd: number | null;
  triggeredAtMs: number;
}

/** Highest candle high with ts in (fromMs, toMs], or null when none qualify. */
export function maxHighInWindow(
  candles: Candle[],
  fromMs: number,
  toMs: number,
): { price: number; ts: number } | null {
  let best: { price: number; ts: number } | null = null;
  for (const c of candles) {
    if (c.ts <= fromMs || c.ts > toMs) continue;
    if (!Number.isFinite(c.high) || c.high <= 0) continue;
    if (!best || c.high > best.price) best = { price: c.high, ts: c.ts };
  }
  return best;
}

export interface OutcomeDecision {
  /** Fields to persist, or null when nothing changed (write throttle). */
  patch: RevivalOutcomePatch | null;
  /** True once the 24h window has elapsed — stop tracking this alert. */
  closed: boolean;
}

/**
 * Decide what (if anything) to write for one tracked alert this sweep.
 * - Peak fields update only on improvement over the stored peak.
 * - peakMultiple = peakPriceUsd / priceUsd-at-alert (null when the alert
 *   price was unknown).
 * - When `now` passes triggeredAt + windowMs, outcomeWindowClosedAt is
 *   stamped with the window end (not `now` — a late sweep after a restart
 *   still records the true window boundary) and tracking stops.
 */
export function evaluateOutcome(
  tracked: Pick<TrackedOutcome, 'triggeredAtMs' | 'alertPriceUsd' | 'peakPriceUsd'>,
  observed: { price: number; ts: number } | null,
  impliedSupply: number | null,
  now: number,
  windowMs: number = OUTCOME_WINDOW_MS,
): OutcomeDecision {
  const patch: RevivalOutcomePatch = {};

  const improved =
    observed != null &&
    observed.price > 0 &&
    (tracked.peakPriceUsd == null || observed.price > tracked.peakPriceUsd);
  if (improved) {
    patch.peakPriceUsd = observed.price;
    patch.peakMcapUsd =
      impliedSupply != null && impliedSupply > 0 ? observed.price * impliedSupply : null;
    patch.peakMultiple =
      tracked.alertPriceUsd != null && tracked.alertPriceUsd > 0
        ? observed.price / tracked.alertPriceUsd
        : null;
    patch.peakAt = new Date(observed.ts).toISOString();
  }

  const windowEndMs = tracked.triggeredAtMs + windowMs;
  const closed = now >= windowEndMs;
  if (closed) {
    patch.outcomeWindowClosedAt = new Date(windowEndMs).toISOString();
  }

  return { patch: Object.keys(patch).length > 0 ? patch : null, closed };
}

/**
 * Resume-on-boot filter. `open` = outcome window still running (resume
 * tracking); `expired` = window elapsed while nobody was watching (closedAt
 * still null past the boundary) — the caller should stamp those closed so the
 * UI never shows a stale "tracking…" forever.
 */
export function partitionOpenAlerts<
  T extends Pick<RevivalAlertEntry, 'triggeredAt' | 'outcomeWindowClosedAt'>,
>(
  entries: T[],
  now: number,
  windowMs: number = OUTCOME_WINDOW_MS,
): { open: T[]; expired: T[] } {
  const open: T[] = [];
  const expired: T[] = [];
  for (const e of entries) {
    if (e.outcomeWindowClosedAt != null) continue;
    const triggeredMs = new Date(e.triggeredAt).getTime();
    if (!Number.isFinite(triggeredMs)) continue;
    if (now < triggeredMs + windowMs) open.push(e);
    else expired.push(e);
  }
  return { open, expired };
}

/** Build a fresh alert row for persistence. Peak starts at the alert price (1.0×). */
export function buildAlertEntry(data: {
  mint: string;
  /** GeckoTerminal network id the detection ran on. */
  network: string;
  symbol: string | null;
  price: number | null;
  mcapUsd: number | null;
  atrZ: number;
  rvol: number;
  triggeredAt: string;
}): RevivalAlertEntry {
  const hasPrice = data.price != null && data.price > 0;
  return {
    id: randomUUID(),
    mint: data.mint,
    symbol: data.symbol,
    network: data.network,
    priceUsd: data.price,
    mcapUsd: data.mcapUsd,
    atrZ: data.atrZ,
    rvol: data.rvol,
    triggeredAt: data.triggeredAt,
    peakPriceUsd: hasPrice ? data.price : null,
    peakMcapUsd: hasPrice ? data.mcapUsd : null,
    peakMultiple: hasPrice ? 1 : null,
    peakAt: hasPrice ? data.triggeredAt : null,
    outcomeWindowClosedAt: null,
  };
}

/**
 * Timer + I/O shell around the pure logic above. One instance, owned by the
 * revival poller. Alerts are keyed by row id; candle fetches are deduped per
 * mint per sweep (several users alerting on the same mint cost one fetch).
 */
export class RevivalOutcomeTracker {
  private tracked = new Map<string, TrackedOutcome>();
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;
  private sweepMs: number;

  constructor(sweepMs: number = DEFAULT_SWEEP_MS) {
    this.sweepMs = sweepMs;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep().catch((err) =>
        console.error('[RevivalOutcome] sweep error:', (err as Error)?.message),
      );
    }, this.sweepMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.tracked.clear();
  }

  trackedCount(): number {
    return this.tracked.size;
  }

  track(outcome: TrackedOutcome): void {
    this.tracked.set(outcome.alertId, outcome);
  }

  /** Re-adopt persisted alerts whose 24h window is still open (boot resume). */
  resumeEntries(entries: { entry: RevivalAlertEntry; userId: string }[]): void {
    let resumed = 0;
    for (const { entry, userId } of entries) {
      // Rows written before multi-chain (or by a chain since switched off)
      // fall back to Solana, which is what they were.
      const network: RevivalNetwork = isRevivalNetwork(entry.network) ? entry.network : 'solana';
      this.track({
        alertId: entry.id,
        userId,
        mint: entry.mint,
        network,
        alertPriceUsd: entry.priceUsd,
        peakPriceUsd: entry.peakPriceUsd,
        triggeredAtMs: new Date(entry.triggeredAt).getTime(),
      });
      resumed += 1;
    }
    if (resumed > 0) {
      console.log(`[RevivalOutcome] Resumed ${resumed} open outcome window(s).`);
    }
  }

  /** Test seam / manual trigger for one sweep pass. */
  async sweepNow(): Promise<void> {
    await this.sweep();
  }

  private async sweep(): Promise<void> {
    if (this.sweeping || this.tracked.size === 0) return;
    this.sweeping = true;
    try {
      // One candle fetch per (network, token), shared by every alert row on it.
      // The network is part of the key: the same 0x address on two chains is
      // two different tokens with two different pools.
      const byToken = new Map<string, TrackedOutcome[]>();
      for (const t of this.tracked.values()) {
        const key = `${t.network}:${t.mint}`;
        const list = byToken.get(key) ?? [];
        list.push(t);
        byToken.set(key, list);
      }

      for (const alerts of byToken.values()) {
        // Only the hard safety valve (sustained rate limiting) stops a sweep;
        // an isolated 429 is absorbed by the client's re-queue + slowdown.
        if (isBackedOff()) return; // resume next sweep
        // No spacing here: candles.ts paces every revival request globally.
        // This module used to sleep on its own budget while the poller slept
        // on its — two "safe" rates that summed to an unsafe one.
        const { mint, network } = alerts[0];
        try {
          await this.sweepToken(network, mint, alerts);
        } catch (err) {
          console.warn(
            `[RevivalOutcome] sweep failed for ${mint.slice(0, 8)}… on ${network}:`,
            (err as Error)?.message,
          );
        }
      }
    } finally {
      this.sweeping = false;
    }
  }

  private async sweepToken(
    network: RevivalNetwork,
    mint: string,
    alerts: TrackedOutcome[],
  ): Promise<void> {
    const now = Date.now();
    const pool = await resolveTopPool(network, mint);
    // Without a pool we can't observe a price this sweep, but window closes
    // must still land — pass a null observation through the same decision path.
    let minute: Candle[] = [];
    let hour: Candle[] = [];
    if (pool) {
      const oldestMs = Math.min(...alerts.map((a) => a.triggeredAtMs));
      const minutesNeeded = Math.ceil((now - oldestMs) / MINUTE_MS) + 5;
      minute = await fetchOhlcv(
        network,
        pool.poolAddress,
        'minute',
        Math.min(Math.max(minutesNeeded, 30), MAX_MINUTE_CANDLES),
      );
      // Minute candles cover ~16.6h; when an alert's window reaches further
      // back (long downtime), hourly candles fill the gap for peak detection.
      if (minutesNeeded > MAX_MINUTE_CANDLES) {
        hour = await fetchOhlcv(network, pool.poolAddress, 'hour', 30);
      }
    }
    const candles = hour.length > 0 ? [...hour, ...minute] : minute;

    for (const t of alerts) {
      const windowEndMs = t.triggeredAtMs + OUTCOME_WINDOW_MS;
      const observed = maxHighInWindow(candles, t.triggeredAtMs, Math.min(now, windowEndMs));
      const decision = evaluateOutcome(t, observed, pool?.impliedSupply ?? null, now);

      if (decision.patch) {
        try {
          await getStorageProvider().updateRevivalAlertOutcome(t.userId, t.alertId, decision.patch);
          if (decision.patch.peakPriceUsd != null) {
            t.peakPriceUsd = decision.patch.peakPriceUsd;
          }
        } catch (err) {
          console.warn('[RevivalOutcome] outcome write failed:', (err as Error)?.message);
          continue; // keep tracking; retry the write next sweep
        }
      }
      if (decision.closed) {
        this.tracked.delete(t.alertId);
      }
    }
  }
}
