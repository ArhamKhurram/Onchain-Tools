/**
 * FOMO trade-event retention sweeper.
 *
 * The trade log is an append-only firehose — every swap by every tracked trader,
 * for every user — so without a sweep it grows without bound. The console only
 * ever asks for the last day, so keeping months of history buys nothing but
 * storage.
 *
 * Self-gates on Supabase, like the poller: idle in local mode.
 */

import { getFomoServiceClient } from './store.js';
import { pruneTradeEvents } from './dispatch.js';

const DEFAULT_RETENTION_DAYS = 7;
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

export function resolveRetentionDays(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_RETENTION_DAYS;
  // A year is already far past "don't bloat the db"; treat anything beyond it as
  // a mistyped value rather than an intent to keep everything.
  return Math.min(parsed, 365);
}

class FomoRetentionSweeper {
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;

    if (!getFomoServiceClient()) {
      console.log('[FomoRetention] Supabase not configured; sweeper idle.');
      return;
    }

    const days = resolveRetentionDays(process.env.FOMO_TRADE_RETENTION_DAYS);
    console.log(`[FomoRetention] Started (keeping ${days} days).`);
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.started = false;
  }

  private async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const db = getFomoServiceClient();
      if (!db) return;
      const days = resolveRetentionDays(process.env.FOMO_TRADE_RETENTION_DAYS);
      const removed = await pruneTradeEvents(db, days);
      if (removed > 0) {
        console.log(`[FomoRetention] Pruned ${removed} trade events older than ${days} days.`);
      }
    } catch (err) {
      console.error('[FomoRetention] Sweep error:', (err as Error)?.message);
    } finally {
      this.sweeping = false;
    }
  }
}

let _sweeper: FomoRetentionSweeper | null = null;

export function startFomoRetentionSweeper(): void {
  if (_sweeper) return;
  _sweeper = new FomoRetentionSweeper();
  _sweeper.start();
}

export function stopFomoRetentionSweeper(): void {
  _sweeper?.stop();
  _sweeper = null;
}
