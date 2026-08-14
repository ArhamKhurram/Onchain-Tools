import { ArrowDownLeft, ArrowUpRight, BarChart3, ExternalLink, RefreshCw } from 'lucide-react';
import { usePumpWalletActivity } from '../../hooks/usePumpWalletActivity';
import {
  deriveTradeSide,
  formatMcap,
  formatSol,
  truncateAddress,
  type PumpSwapTransaction,
  type PumpTransaction,
} from '../../types/pumpfun';
import { SortHeader } from '../common/SortHeader';
import { useSort } from '../../hooks/useSort';
import { sortRows, type SortColumn } from '../../lib/sort';
import PumpCalloutList from './PumpCalloutList';
import PumpStateNotice from './PumpStateNotice';

const TH = 'px-3 py-2 font-medium';

// The sortable trade columns. Amount is left off deliberately — it is in mixed units
// (coin amounts across different mints), so ranking rows by it would compare apples
// to oranges; the other four rank cleanly.
type TradeSortKey = 'side' | 'token' | 'sol' | 'when';

const TRADE_ASC_FIRST: readonly TradeSortKey[] = ['side', 'token'];

/** The label used to SORT a row's side: a swap's buy/sell, else its transaction kind
 *  (transfer, fee_claim, or the raw type). Same text the Side cell renders, so the
 *  sort matches what the eye sees. */
function tradeSideValue(tx: PumpTransaction): string {
  if (tx.type === 'SWAP') return deriveTradeSide(tx);
  if (tx.type === 'OTHER') return tx.rawType ?? 'other';
  return tx.type.toLowerCase();
}

/** The token identifier used to sort a row: symbol first, else the mint, else blank. */
function tradeTokenValue(tx: PumpTransaction): string {
  if (tx.type === 'SWAP') return tx.tokenSymbol ?? tx.token ?? '';
  if (tx.type === 'TRANSFER' || tx.type === 'FEE_CLAIM') return tx.tokenTransferred?.metadata?.symbol ?? '';
  return '';
}

const TRADE_COLUMNS: readonly SortColumn<PumpTransaction, TradeSortKey>[] = [
  { key: 'side', type: 'text', get: tradeSideValue },
  { key: 'token', type: 'text', get: tradeTokenValue },
  // Only swaps carry a SOL value; other rows sort as missing (sink to the low end).
  { key: 'sol', type: 'numeric', get: (tx) => (tx.type === 'SWAP' ? tx.solValue : null) },
  { key: 'when', type: 'numeric', get: (tx) => tx.blockTime },
];

// Everything for one tracked wallet: profile, recent callouts (KEYED), recent
// trades with buy/sell side and a cursor "load more" (KEYLESS), and a deliberate
// PnL button (KEYLESS, never auto-fired). The three sections fail independently —
// a 503 on callouts leaves the trades table fully populated.
export default function PumpWalletPanel({ address }: { address: string }) {
  const activity = usePumpWalletActivity(address);
  const { profile, callouts, transactions, pnl } = activity;

  // Click-to-sort over the loaded trades, newest-first by default. Ties break on
  // recency so an equal-keyed pair (two rows with the same side, say) still reads
  // newest-first rather than in fetch order.
  const { sortKey, sortDir, onSort } = useSort<TradeSortKey>('when', 'desc', TRADE_ASC_FIRST);
  const sortedTransactions = sortRows(
    transactions.data,
    TRADE_COLUMNS,
    sortKey,
    sortDir,
    (a, b) => (b.blockTime ?? 0) - (a.blockTime ?? 0),
  );

  return (
    <div className="h-full min-h-0 overflow-auto bg-oct-bg">
      {/* Profile header. Falls back to the raw address when the keyed profile
          endpoint is off or the wallet has no pump.fun identity. */}
      <div className="oct-headerbar flex items-center gap-3 px-4 py-3.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-display text-lg text-oct-text truncate">
              {profile.data?.displayName ?? profile.data?.username ?? truncateAddress(address)}
            </span>
            {profile.data?.username && (
              <a
                href={`https://x.com/${profile.data.username}`}
                target="_blank"
                rel="noreferrer noopener"
                className="text-oct-muted hover:text-oct-accent shrink-0"
                title="Open on X"
              >
                <ExternalLink size={13} />
              </a>
            )}
          </div>
          <div className="font-mono text-[11px] text-oct-muted truncate" title={address}>
            {address}
          </div>
        </div>
        <button
          type="button"
          onClick={activity.refresh}
          className="oct-icon-btn flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-bold uppercase shrink-0"
        >
          <RefreshCw size={12} />
          refresh
        </button>
      </div>

      {/* Callouts (KEYED). */}
      <section className="px-4 py-4 border-b border-oct-border">
        <h3 className="oct-eyebrow mb-2.5">Recent callouts</h3>
        {profile.disabled || callouts.disabled || callouts.error ? (
          <PumpStateNotice
            disabled={callouts.disabled || profile.disabled}
            error={callouts.error}
            retryable={callouts.retryable}
            onRetry={activity.refresh}
            surface="callouts"
          />
        ) : callouts.data.length === 0 ? (
          <p className="font-mono text-xs text-oct-muted py-2">
            {callouts.loading ? 'Loading…' : 'No callouts recorded for this wallet.'}
          </p>
        ) : (
          <div className="oct-card oct-card-flush">
            <PumpCalloutList callouts={callouts.data} />
          </div>
        )}
      </section>

      {/* Trades (KEYLESS). */}
      <section className="px-4 py-4">
        <div className="flex items-center gap-2 mb-2.5">
          <h3 className="oct-eyebrow">Recent trades</h3>
          <span className="font-mono text-[11px] text-oct-muted">· {transactions.data.length} rows</span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => void activity.runPnl()}
            disabled={activity.pnlLoading || transactions.data.length === 0}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-oct-sm text-[11px] font-mono font-bold uppercase border border-oct-accent/60 text-oct-accent hover:bg-oct-accent hover:text-white hover:shadow-oct-glow-accent disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-oct-accent disabled:hover:shadow-none transition-all"
            title="Ask pump.fun for realized/unrealized PnL on the coins in these trades"
          >
            <BarChart3 size={12} />
            {activity.pnlLoading ? 'loading…' : 'compute PnL'}
          </button>
        </div>

        {transactions.error ? (
          <PumpStateNotice
            disabled={false}
            error={transactions.error}
            retryable={transactions.retryable}
            onRetry={activity.refresh}
            surface="trades"
          />
        ) : transactions.data.length === 0 ? (
          <p className="font-mono text-xs text-oct-muted py-2">
            {transactions.loading ? 'Loading…' : 'No trades found for this wallet.'}
          </p>
        ) : (
          <>
            <div className="oct-card oct-card-flush">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse min-w-[640px]">
                  <thead className="oct-thead">
                    <tr className="font-mono text-[11px] font-bold uppercase tracking-wider text-oct-muted">
                      <SortHeader<TradeSortKey> label="Side" sortKey="side" activeKey={sortKey} dir={sortDir} onSort={onSort} />
                      <SortHeader<TradeSortKey> label="Token" sortKey="token" activeKey={sortKey} dir={sortDir} onSort={onSort} />
                      <th className={`${TH} text-right`}>Amount</th>
                      <SortHeader<TradeSortKey> label="SOL value" sortKey="sol" activeKey={sortKey} dir={sortDir} onSort={onSort} align="right" />
                      <SortHeader<TradeSortKey> label="When" sortKey="when" activeKey={sortKey} dir={sortDir} onSort={onSort} align="right" />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedTransactions.map((tx) => (
                      <TradeRow key={tx.txHash} tx={tx} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {activity.hasMore && (
              <button
                type="button"
                onClick={() => void activity.loadMore()}
                disabled={activity.loadingMore}
                className="mt-3 w-full py-2.5 rounded-oct-sm text-xs font-mono font-bold uppercase border border-oct-border-bright text-oct-muted hover:text-oct-text hover:border-oct-text hover:bg-oct-surface-raised/50 disabled:opacity-40 transition-colors"
              >
                {activity.loadingMore ? 'loading…' : 'load more'}
              </button>
            )}
          </>
        )}

        {/* PnL results — only after the deliberate button. Attributed to pump.fun. */}
        {activity.pnlError && (
          <div className="mt-3">
            <PumpStateNotice
              disabled={false}
              error={activity.pnlError}
              retryable
              onRetry={() => void activity.runPnl()}
              surface="PnL"
            />
          </div>
        )}
        {pnl && pnl.length > 0 && (
          <div className="mt-3 oct-card oct-card-flush">
            <div className="oct-headerbar px-3 py-2">
              <span className="oct-eyebrow">PnL per token · reported by pump.fun</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse min-w-[560px]">
                <thead className="oct-thead">
                  <tr className="font-mono text-[11px] font-bold uppercase tracking-wider text-oct-muted">
                    <th className={TH}>Mint</th>
                    <th className={`${TH} text-right`}>Realized</th>
                    <th className={`${TH} text-right`}>Unrealized</th>
                    <th className={`${TH} text-right`}>Buy spend</th>
                  </tr>
                </thead>
                <tbody>
                  {pnl.map((p) => (
                    <tr key={p.mint} className="border-b border-oct-border/50 oct-row-hover">
                      <td className="px-3 py-2.5 font-mono text-[13px] text-oct-text" title={p.mint}>
                        {truncateAddress(p.mint)}
                      </td>
                      <td className={`px-3 py-2.5 font-mono text-[13px] text-right tabular-nums ${signClass(p.realized)}`}>
                        {formatSol(p.realized)}
                      </td>
                      <td className={`px-3 py-2.5 font-mono text-[13px] text-right tabular-nums ${signClass(p.unrealized)}`}>
                        {formatSol(p.unrealized)}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-[13px] text-oct-muted text-right tabular-nums">
                        {formatMcap(p.totalBuySpend?.usd ?? null)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {pnl && pnl.length === 0 && !activity.pnlError && (
          <p className="mt-3 font-mono text-xs text-oct-muted">
            No swapped coins in the loaded trades to compute PnL for.
          </p>
        )}
      </section>
    </div>
  );
}

/** One trade row. Non-SWAP rows (transfers, fee claims, unmodeled) render a muted label. */
function TradeRow({ tx }: { tx: PumpTransaction }) {
  if (tx.type !== 'SWAP') {
    return (
      <tr className="border-b border-oct-border/50 oct-row-hover">
        <td className="px-3 py-2.5 font-mono text-[11px] uppercase text-oct-muted">
          {tx.type === 'OTHER' ? (tx.rawType ?? 'other') : tx.type.toLowerCase()}
        </td>
        <td className="px-3 py-2.5 font-mono text-[13px] text-oct-muted" colSpan={3}>
          {tx.type === 'TRANSFER' || tx.type === 'FEE_CLAIM'
            ? `${tx.transactionType ?? tx.type} ${tx.tokenTransferred?.metadata?.symbol ?? ''}`.trim()
            : '—'}
        </td>
        <td className="px-3 py-2.5 font-mono text-xs text-oct-muted text-right whitespace-nowrap">
          {tx.blockTime ? new Date(tx.blockTime * 1000).toLocaleString() : '—'}
        </td>
      </tr>
    );
  }
  return <SwapRow tx={tx} />;
}

function SwapRow({ tx }: { tx: PumpSwapTransaction }) {
  const side = deriveTradeSide(tx);
  return (
    <tr className="border-b border-oct-border/50 oct-row-hover">
      <td className="px-3 py-2.5">
        <span
          className={`inline-flex items-center gap-1 text-[11px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded-oct-sm border ${
            side === 'buy'
              ? 'border-oct-green/50 bg-oct-green/15 text-oct-green'
              : side === 'sell'
                ? 'border-oct-flame/50 bg-oct-flame/15 text-oct-flame'
                : 'border-oct-border text-oct-muted'
          }`}
        >
          {side === 'buy' ? <ArrowDownLeft size={10} /> : side === 'sell' ? <ArrowUpRight size={10} /> : null}
          {side}
        </span>
      </td>
      <td className="px-3 py-2.5 font-mono text-[13px] text-oct-text" title={tx.token ?? undefined}>
        {tx.tokenSymbol ?? (tx.token ? truncateAddress(tx.token) : '—')}
      </td>
      <td className="px-3 py-2.5 font-mono text-[13px] text-oct-muted text-right tabular-nums">
        {tx.amount === null ? '—' : tx.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })}
      </td>
      <td className="px-3 py-2.5 font-mono text-[13px] text-oct-text text-right tabular-nums">{formatSol(tx.solValue)}</td>
      <td className="px-3 py-2.5 font-mono text-xs text-oct-muted text-right whitespace-nowrap">
        {tx.blockTime ? new Date(tx.blockTime * 1000).toLocaleString() : '—'}
      </td>
    </tr>
  );
}

/** Green for a gain, red for a loss, muted for null/zero. */
function signClass(n: number | null): string {
  if (n === null || !Number.isFinite(n) || n === 0) return 'text-oct-muted';
  return n > 0 ? 'text-oct-green' : 'text-oct-flame';
}
