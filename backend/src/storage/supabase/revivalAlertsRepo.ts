import { BaseRepo, throwIfError } from './client.js';
import type { RevivalAlertEntry, RevivalOutcomePatch } from '@oct/shared';

/**
 * `revival_alerts` repo (migration 20260811130000). Writes come from the
 * revival poller via the service-role client (same trust model as
 * missed_runner_alerts); users read their own rows through RLS or the
 * /api/revival/alerts route.
 *
 * The table is not in the generated database.types.ts snapshot (that file is
 * regenerated wholesale, never hand-edited), so the queries here stay on the
 * untyped client like the rest of storage/supabase.
 */
export class RevivalAlertsRepo extends BaseRepo {
  private rowToEntry(row: any): RevivalAlertEntry {
    return {
      id: row.id,
      // Rows written before the kind column (or by a backend older than it)
      // are revivals; null keeps that explicit for the frontend.
      kind: row.kind === 'breakout' || row.kind === 'revival' ? row.kind : null,
      mint: row.mint,
      symbol: row.symbol ?? null,
      network: row.network ?? 'solana',
      priceUsd: row.price_usd != null ? Number(row.price_usd) : null,
      mcapUsd: row.mcap_usd != null ? Number(row.mcap_usd) : null,
      atrZ: Number(row.atr_z ?? 0),
      rvol: Number(row.rvol ?? 0),
      baselinePriceUsd: row.baseline_price_usd != null ? Number(row.baseline_price_usd) : null,
      runMultiple: row.run_multiple != null ? Number(row.run_multiple) : null,
      triggeredAt: row.triggered_at,
      peakPriceUsd: row.peak_price_usd != null ? Number(row.peak_price_usd) : null,
      peakMcapUsd: row.peak_mcap_usd != null ? Number(row.peak_mcap_usd) : null,
      peakMultiple: row.peak_multiple != null ? Number(row.peak_multiple) : null,
      peakAt: row.peak_at ?? null,
      outcomeWindowClosedAt: row.outcome_window_closed_at ?? null,
    };
  }

  async logRevivalAlert(userId: string, alert: RevivalAlertEntry): Promise<RevivalAlertEntry> {
    const row: Record<string, unknown> = {
      id: alert.id,
      user_id: userId,
      kind: alert.kind ?? 'revival',
      mint: alert.mint,
      symbol: alert.symbol,
      network: alert.network,
      price_usd: alert.priceUsd,
      mcap_usd: alert.mcapUsd,
      atr_z: alert.atrZ,
      rvol: alert.rvol,
      baseline_price_usd: alert.baselinePriceUsd,
      run_multiple: alert.runMultiple,
      triggered_at: alert.triggeredAt,
      peak_price_usd: alert.peakPriceUsd,
      peak_mcap_usd: alert.peakMcapUsd,
      peak_multiple: alert.peakMultiple,
      peak_at: alert.peakAt,
      outcome_window_closed_at: alert.outcomeWindowClosedAt,
    };

    let result = await this.supabase.from('revival_alerts').insert(row);
    // Deploy-order tolerance: migrations here are applied BY HAND, so the code
    // can reach prod a few minutes before the `kind` column exists. Losing the
    // row entirely would cost the review surface for the signal, so retry once
    // without it and say so loudly — the row then reads as a revival until the
    // migration lands. Delete this branch once it is applied everywhere.
    if (result.error && /['"]kind['"]|column "kind"/.test(result.error.message ?? '')) {
      console.warn(
        '[Supabase] revival_alerts is missing the kind column — apply migration 20260812093000_revival_alerts_kind.sql. Logging without it.',
      );
      delete row.kind;
      result = await this.supabase.from('revival_alerts').insert(row);
    }
    // Same tolerance for the older baseline_price_usd/run_multiple columns
    // (migration 20260811160000). Delete once applied everywhere.
    if (result.error && /baseline_price_usd|run_multiple/.test(result.error.message ?? '')) {
      console.warn(
        '[Supabase] revival_alerts is missing baseline_price_usd/run_multiple — apply migration 20260811160000_revival_run_multiple.sql. Logging without them.',
      );
      delete row.baseline_price_usd;
      delete row.run_multiple;
      const retry = await this.supabase.from('revival_alerts').insert(row);
      throwIfError(retry, 'Failed to log revival alert');
      return alert;
    }
    throwIfError(result, 'Failed to log revival alert');
    return alert;
  }

  async listRevivalAlerts(userId: string, limit = 100): Promise<RevivalAlertEntry[]> {
    const result = await this.supabase
      .from('revival_alerts')
      .select('*')
      .eq('user_id', userId)
      .order('triggered_at', { ascending: false })
      .limit(limit);
    throwIfError(result, 'Failed to list revival alerts');
    return (result.data ?? []).map((row: any) => this.rowToEntry(row));
  }

  async updateRevivalAlertOutcome(userId: string, alertId: string, outcome: RevivalOutcomePatch): Promise<void> {
    const patch: Record<string, unknown> = {};
    if ('peakPriceUsd' in outcome) patch.peak_price_usd = outcome.peakPriceUsd;
    if ('peakMcapUsd' in outcome) patch.peak_mcap_usd = outcome.peakMcapUsd;
    if ('peakMultiple' in outcome) patch.peak_multiple = outcome.peakMultiple;
    if ('peakAt' in outcome) patch.peak_at = outcome.peakAt;
    if ('outcomeWindowClosedAt' in outcome) patch.outcome_window_closed_at = outcome.outcomeWindowClosedAt;
    if (Object.keys(patch).length === 0) return;

    const result = await this.supabase
      .from('revival_alerts')
      .update(patch)
      .eq('id', alertId)
      .eq('user_id', userId);
    throwIfError(result, 'Failed to update revival alert outcome');
  }
}
