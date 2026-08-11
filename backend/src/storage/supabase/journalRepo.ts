import { BaseRepo, throwIfError } from './client.js';
import type { JournalPosition, JournalTrade, JournalWallet } from '@oct/shared';

/**
 * `journal_wallets` / `journal_trades` / `journal_positions` repo (migration
 * 20260812150000_trade_journal.sql). Writes come from the journal poller via
 * the service-role client; users read their own rows through the /api/journal
 * routes (RLS also allows direct reads, mirroring revival_alerts).
 *
 * MIGRATION TOLERANCE: migrations here are applied BY HAND, so this code can
 * reach prod before the tables exist (the revivalAlertsRepo insert-fallback
 * pattern, applied at table granularity). Every method detects the
 * missing-table error, warns ONCE, and degrades to an empty read / no-op
 * write instead of throwing — the poller then idles cleanly until the
 * operator applies the migration.
 *
 * The tables are not in the generated database.types.ts snapshot (regenerated
 * wholesale, never hand-edited), so queries stay on the untyped client like
 * the rest of storage/supabase.
 */

const MISSING_TABLE_RE =
  /relation .*journal_\w+.* does not exist|Could not find the table .*journal_\w+|schema cache/i;

export class JournalRepo extends BaseRepo {
  private missingTableWarned = false;

  /** True (and warns once) when the error means the migration isn't applied. */
  private tolerateMissingTable(error: { message?: string } | null | undefined): boolean {
    if (!error || !MISSING_TABLE_RE.test(error.message ?? '')) return false;
    if (!this.missingTableWarned) {
      this.missingTableWarned = true;
      console.warn(
        '[Supabase] journal tables are missing — apply migration 20260812150000_trade_journal.sql. Journal idles until then.',
      );
    }
    return true;
  }

  // ---- Row mappers ----

  private rowToWallet(row: any): JournalWallet {
    return {
      id: row.id,
      address: row.address,
      label: row.label ?? null,
      chain: 'solana',
      lastSignature: row.last_signature ?? null,
      lastPolledAt: row.last_polled_at ?? null,
      createdAt: row.created_at,
    };
  }

  private rowToTrade(row: any): JournalTrade {
    return {
      id: row.id,
      walletId: row.wallet_id,
      walletAddress: row.wallet_address,
      mint: row.mint,
      symbol: row.symbol ?? null,
      side: row.side === 'sell' ? 'sell' : 'buy',
      amountToken: Number(row.amount_token ?? 0),
      amountSol: row.amount_sol != null ? Number(row.amount_sol) : null,
      amountUsd: row.amount_usd != null ? Number(row.amount_usd) : null,
      txSignature: row.tx_signature,
      dex: row.dex ?? null,
      ts: row.ts,
    };
  }

  private rowToPosition(row: any): JournalPosition {
    return {
      id: row.id,
      walletId: row.wallet_id,
      walletAddress: row.wallet_address,
      mint: row.mint,
      symbol: row.symbol ?? null,
      status: row.status === 'closed' ? 'closed' : 'open',
      acquiredToken: Number(row.acquired_token ?? 0),
      remainingToken: Number(row.remaining_token ?? 0),
      costSol: Number(row.cost_sol ?? 0),
      costUsd: row.cost_usd != null ? Number(row.cost_usd) : null,
      realizedPnlSol: Number(row.realized_pnl_sol ?? 0),
      realizedPnlUsd: row.realized_pnl_usd != null ? Number(row.realized_pnl_usd) : null,
      pnlIncomplete: !!row.pnl_incomplete,
      openedAt: row.opened_at,
      closedAt: row.closed_at ?? null,
      lastTradeAt: row.last_trade_at,
      lastPriceUsd: row.last_price_usd != null ? Number(row.last_price_usd) : null,
      lastPriceAt: row.last_price_at ?? null,
    };
  }

  // ---- Wallets ----

  async listJournalWallets(userId: string): Promise<JournalWallet[]> {
    const result = await this.supabase
      .from('journal_wallets')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });
    if (this.tolerateMissingTable(result.error)) return [];
    throwIfError(result, 'Failed to list journal wallets');
    return (result.data ?? []).map((row: any) => this.rowToWallet(row));
  }

  async addJournalWallet(userId: string, address: string, label: string | null): Promise<JournalWallet> {
    const existing = await this.supabase
      .from('journal_wallets')
      .select('*')
      .eq('user_id', userId)
      .eq('address', address)
      .maybeSingle();
    if (this.tolerateMissingTable(existing.error)) {
      throw new Error('Journal storage is not provisioned yet (migration pending).');
    }
    if (existing.data) return this.rowToWallet(existing.data);

    const result = await this.supabase
      .from('journal_wallets')
      .insert({ user_id: userId, address, label, chain: 'solana' })
      .select('*')
      .single();
    throwIfError(result, 'Failed to add journal wallet');
    return this.rowToWallet(result.data);
  }

  async removeJournalWallet(userId: string, walletId: string): Promise<boolean> {
    // Trades/positions cascade via FK.
    const result = await this.supabase
      .from('journal_wallets')
      .delete()
      .eq('user_id', userId)
      .eq('id', walletId)
      .select('id');
    if (this.tolerateMissingTable(result.error)) return false;
    throwIfError(result, 'Failed to remove journal wallet');
    return (result.data ?? []).length > 0;
  }

  async updateJournalWalletCursor(
    userId: string,
    walletId: string,
    lastSignature: string | null,
    lastPolledAt: string,
  ): Promise<void> {
    const result = await this.supabase
      .from('journal_wallets')
      .update({ last_signature: lastSignature, last_polled_at: lastPolledAt })
      .eq('user_id', userId)
      .eq('id', walletId);
    if (this.tolerateMissingTable(result.error)) return;
    throwIfError(result, 'Failed to update journal wallet cursor');
  }

  // ---- Trades ----

  async addJournalTrades(userId: string, trades: JournalTrade[]): Promise<number> {
    if (trades.length === 0) return 0;
    const rows = trades.map((t) => ({
      id: t.id,
      user_id: userId,
      wallet_id: t.walletId,
      wallet_address: t.walletAddress,
      mint: t.mint,
      symbol: t.symbol,
      side: t.side,
      amount_token: t.amountToken,
      amount_sol: t.amountSol,
      amount_usd: t.amountUsd,
      tx_signature: t.txSignature,
      dex: t.dex,
      ts: t.ts,
    }));
    // Idempotent on the (wallet_id, tx_signature, mint, side) unique key —
    // ignoreDuplicates makes cursor overlap and re-polls safe.
    const result = await this.supabase
      .from('journal_trades')
      .upsert(rows, { onConflict: 'wallet_id,tx_signature,mint,side', ignoreDuplicates: true })
      .select('id');
    if (this.tolerateMissingTable(result.error)) return 0;
    throwIfError(result, 'Failed to insert journal trades');
    return (result.data ?? []).length;
  }

  async listJournalTrades(userId: string, limit = 5000, walletId?: string): Promise<JournalTrade[]> {
    let query = this.supabase
      .from('journal_trades')
      .select('*')
      .eq('user_id', userId)
      .order('ts', { ascending: false })
      .limit(limit);
    if (walletId) query = query.eq('wallet_id', walletId);
    const result = await query;
    if (this.tolerateMissingTable(result.error)) return [];
    throwIfError(result, 'Failed to list journal trades');
    return (result.data ?? []).map((row: any) => this.rowToTrade(row));
  }

  // ---- Positions ----

  async replaceJournalPositions(userId: string, walletId: string, positions: JournalPosition[]): Promise<void> {
    // Upsert-then-prune keyed on the deterministic episode id: the pairing
    // engine recomputes the same ids from the same trades, so a rebuild
    // updates in place. lastPrice* are the volume poller's columns — never
    // overwrite them from here.
    const rows = positions.map((p) => ({
      id: p.id,
      user_id: userId,
      wallet_id: p.walletId,
      wallet_address: p.walletAddress,
      mint: p.mint,
      symbol: p.symbol,
      status: p.status,
      acquired_token: p.acquiredToken,
      remaining_token: p.remainingToken,
      cost_sol: p.costSol,
      cost_usd: p.costUsd,
      realized_pnl_sol: p.realizedPnlSol,
      realized_pnl_usd: p.realizedPnlUsd,
      pnl_incomplete: p.pnlIncomplete,
      opened_at: p.openedAt,
      closed_at: p.closedAt,
      last_trade_at: p.lastTradeAt,
      updated_at: new Date().toISOString(),
    }));

    if (rows.length > 0) {
      const upsert = await this.supabase
        .from('journal_positions')
        .upsert(rows, { onConflict: 'id' });
      if (this.tolerateMissingTable(upsert.error)) return;
      throwIfError(upsert, 'Failed to upsert journal positions');
    }

    // Prune rows the rebuild no longer produces (e.g. after retention trims).
    const keep = positions.map((p) => p.id);
    let prune = this.supabase
      .from('journal_positions')
      .delete()
      .eq('user_id', userId)
      .eq('wallet_id', walletId);
    if (keep.length > 0) {
      prune = prune.not('id', 'in', `(${keep.map((id) => `"${id}"`).join(',')})`);
    }
    const pruned = await prune;
    if (this.tolerateMissingTable(pruned.error)) return;
    throwIfError(pruned, 'Failed to prune journal positions');
  }

  async listJournalPositions(userId: string, status?: 'open' | 'closed'): Promise<JournalPosition[]> {
    let query = this.supabase
      .from('journal_positions')
      .select('*')
      .eq('user_id', userId)
      .order('last_trade_at', { ascending: false })
      .limit(2000);
    if (status) query = query.eq('status', status);
    const result = await query;
    if (this.tolerateMissingTable(result.error)) return [];
    throwIfError(result, 'Failed to list journal positions');
    return (result.data ?? []).map((row: any) => this.rowToPosition(row));
  }

  async updateJournalPositionPrice(userId: string, positionId: string, priceUsd: number, at: string): Promise<void> {
    const result = await this.supabase
      .from('journal_positions')
      .update({ last_price_usd: priceUsd, last_price_at: at })
      .eq('user_id', userId)
      .eq('id', positionId);
    if (this.tolerateMissingTable(result.error)) return;
    throwIfError(result, 'Failed to update journal position price');
  }
}
