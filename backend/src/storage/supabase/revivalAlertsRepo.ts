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
      mint: row.mint,
      symbol: row.symbol ?? null,
      network: row.network ?? 'solana',
      priceUsd: row.price_usd != null ? Number(row.price_usd) : null,
      mcapUsd: row.mcap_usd != null ? Number(row.mcap_usd) : null,
      atrZ: Number(row.atr_z ?? 0),
      rvol: Number(row.rvol ?? 0),
      triggeredAt: row.triggered_at,
      peakPriceUsd: row.peak_price_usd != null ? Number(row.peak_price_usd) : null,
      peakMcapUsd: row.peak_mcap_usd != null ? Number(row.peak_mcap_usd) : null,
      peakMultiple: row.peak_multiple != null ? Number(row.peak_multiple) : null,
      peakAt: row.peak_at ?? null,
      outcomeWindowClosedAt: row.outcome_window_closed_at ?? null,
    };
  }

  async logRevivalAlert(userId: string, alert: RevivalAlertEntry): Promise<RevivalAlertEntry> {
    const result = await this.supabase.from('revival_alerts').insert({
      id: alert.id,
      user_id: userId,
      mint: alert.mint,
      symbol: alert.symbol,
      network: alert.network,
      price_usd: alert.priceUsd,
      mcap_usd: alert.mcapUsd,
      atr_z: alert.atrZ,
      rvol: alert.rvol,
      triggered_at: alert.triggeredAt,
      peak_price_usd: alert.peakPriceUsd,
      peak_mcap_usd: alert.peakMcapUsd,
      peak_multiple: alert.peakMultiple,
      peak_at: alert.peakAt,
      outcome_window_closed_at: alert.outcomeWindowClosedAt,
    });
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
