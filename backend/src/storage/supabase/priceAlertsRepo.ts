import { BaseRepo, throwIfError } from './client.js';
import type { PriceAlert, PriceAlertStatus } from '@oct/shared';
import type { PriceAlertInput, PriceAlertObservationPatch } from '../interface.js';

/**
 * `price_alerts` repo (migration 20260814120000_price_alerts.sql). Operator-set
 * levels on operator-chosen tokens — see backend/src/priceAlerts/.
 *
 * Same trust model as journal/revival: users read their own rows through RLS
 * (and the /api/price-alerts routes); creates/deletes/observation writes go
 * through the backend on the service role.
 *
 * MIGRATION TOLERANCE: migrations here are applied BY HAND, so this code can
 * reach prod before the table exists. Every method detects the missing-table
 * error, warns ONCE, and degrades to an empty read / no-op write instead of
 * throwing — the poller then idles cleanly until the operator applies the
 * migration. The one exception is `createPriceAlert`, which throws a plain
 * message: silently accepting an alert that will never fire is worse than a
 * visible error in the UI.
 *
 * The table is not in the generated database.types.ts snapshot (regenerated
 * wholesale, never hand-edited), so queries stay on the untyped client like the
 * rest of storage/supabase.
 */

const MISSING_TABLE_RE =
  /relation .*price_alerts.* does not exist|Could not find the table .*price_alerts|schema cache/i;

export class PriceAlertsRepo extends BaseRepo {
  private missingTableWarned = false;

  /** True (and warns once) when the error means the migration isn't applied. */
  private tolerateMissingTable(error: { message?: string } | null | undefined): boolean {
    if (!error || !MISSING_TABLE_RE.test(error.message ?? '')) return false;
    if (!this.missingTableWarned) {
      this.missingTableWarned = true;
      console.warn(
        '[Supabase] price_alerts is missing — apply migration 20260814120000_price_alerts.sql. Price alerts idle until then.',
      );
    }
    return true;
  }

  private rowToAlert(row: any): PriceAlert {
    return {
      id: row.id,
      chain: row.chain ?? 'solana',
      mint: row.mint,
      symbol: row.symbol ?? null,
      direction: row.direction === 'below' ? 'below' : 'above',
      targetUsd: Number(row.target_usd ?? 0),
      metric: row.metric === 'price' ? 'price' : 'mcap',
      status:
        row.status === 'fired' ? 'fired' : row.status === 'disabled' ? 'disabled' : 'armed',
      note: row.note ?? null,
      lastSeenUsd: row.last_seen_usd != null ? Number(row.last_seen_usd) : null,
      lastSeenAt: row.last_seen_at ?? null,
      firedAt: row.fired_at ?? null,
      firedValueUsd: row.fired_value_usd != null ? Number(row.fired_value_usd) : null,
      createdAt: row.created_at,
    };
  }

  async listPriceAlerts(userId: string, status?: PriceAlertStatus): Promise<PriceAlert[]> {
    let query = this.supabase
      .from('price_alerts')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(500);
    if (status) query = query.eq('status', status);
    const result = await query;
    if (this.tolerateMissingTable(result.error)) return [];
    throwIfError(result, 'Failed to list price alerts');
    return (result.data ?? []).map((row: any) => this.rowToAlert(row));
  }

  async createPriceAlert(userId: string, input: PriceAlertInput): Promise<PriceAlert> {
    const result = await this.supabase
      .from('price_alerts')
      .insert({
        user_id: userId,
        chain: input.chain,
        mint: input.mint,
        symbol: input.symbol,
        direction: input.direction,
        target_usd: input.targetUsd,
        metric: input.metric,
        status: 'armed',
        note: input.note,
        // last_seen_usd stays NULL: the poller's first observation is the
        // baseline, so an alert on a token already past its target does not
        // fire instantly (priceAlerts/crossing.ts).
      })
      .select('*')
      .single();
    if (this.tolerateMissingTable(result.error)) {
      throw new Error('Price alert storage is not provisioned yet (migration pending).');
    }
    throwIfError(result, 'Failed to create price alert');
    return this.rowToAlert(result.data);
  }

  async deletePriceAlert(userId: string, alertId: string): Promise<boolean> {
    const result = await this.supabase
      .from('price_alerts')
      .delete()
      .eq('user_id', userId)
      .eq('id', alertId)
      .select('id');
    if (this.tolerateMissingTable(result.error)) return false;
    throwIfError(result, 'Failed to delete price alert');
    return (result.data ?? []).length > 0;
  }

  async updatePriceAlertObservation(
    userId: string,
    alertId: string,
    patch: PriceAlertObservationPatch,
  ): Promise<void> {
    const row: Record<string, unknown> = {
      last_seen_usd: patch.lastSeenUsd,
      last_seen_at: patch.lastSeenAt,
    };
    if (patch.symbol != null) row.symbol = patch.symbol;
    if (patch.status) row.status = patch.status;
    if (patch.firedAt) row.fired_at = patch.firedAt;
    if (patch.firedValueUsd != null) row.fired_value_usd = patch.firedValueUsd;

    const result = await this.supabase
      .from('price_alerts')
      .update(row)
      .eq('user_id', userId)
      .eq('id', alertId)
      // A fired alert is one-shot: guard the write so a concurrent poll (or a
      // restart mid-cycle) can never fire the same alert twice or reopen it.
      .eq('status', 'armed');
    if (this.tolerateMissingTable(result.error)) return;
    throwIfError(result, 'Failed to update price alert observation');
  }
}
