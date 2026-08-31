// Top pump.fun holders board for one coin. The pump counterpart to
// FomoHoldersBoard: same list shape and USD formatting so the two sit side by
// side in TokenHoldersDrawer without a visual seam.
//
// The base list is on-chain (owner wallet + balance + supply-%) and PnL is the
// keyless holders endpoint; identity (a name instead of a short wallet) is a
// later enrichment, so until `data.enriched` is true every row shows the short
// owner address linked to Solscan. A missing PnL shows an em dash, never a zero.

import { ExternalLink, RefreshCw, Coins } from 'lucide-react';
import { truncateAddress, type PumpHoldersResponse } from '../../types/pumpfun';

const SOLSCAN_ACCOUNT = 'https://solscan.io/account/';

function compactUsd(value: number | null | undefined): string {
  if (value == null) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(abs / 1e3).toFixed(1)}K`;
  return `$${abs.toFixed(0)}`;
}

function signedUsd(value: number | null): string {
  if (value == null) return '—';
  const sign = value >= 0 ? '+' : '-';
  return `${sign}${compactUsd(Math.abs(value))}`;
}

function compactAmount(value: number | null): string {
  if (value == null) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(abs / 1e3).toFixed(1)}K`;
  return abs.toFixed(0);
}

interface PumpHoldersBoardProps {
  data: PumpHoldersResponse | null;
  loading: boolean;
  error: string | null;
  onRefresh?: () => void;
  /** Mint to show while the first request is still in flight. */
  pendingMint?: string | null;
}

export default function PumpHoldersBoard({
  data,
  loading,
  error,
  onRefresh,
  pendingMint,
}: PumpHoldersBoardProps) {
  if (loading && !data) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16">
        <div className="w-6 h-6 border-2 border-oct-accent border-t-transparent rounded-full animate-spin" />
        {pendingMint && (
          <span className="font-mono text-[11px] text-oct-muted">{truncateAddress(pendingMint)}</span>
        )}
      </div>
    );
  }

  if (error) {
    return (
      <div className="m-4 px-4 py-3 rounded-oct border border-oct-flame/40 bg-oct-flame/10 text-sm text-oct-text">
        {error}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 px-6 text-center">
        <Coins size={20} className="text-oct-muted" />
        <p className="text-sm text-oct-muted">No coin selected.</p>
      </div>
    );
  }

  const { holders } = data;

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="oct-headerbar shrink-0 px-4 py-3 flex items-center gap-2">
        <span className="oct-section-title uppercase tracking-wide">On-chain</span>
        <span className="oct-chip uppercase">SOL</span>
        <div className="flex-1" />
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="oct-icon-btn shrink-0 p-2"
            title="Refresh holders"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {holders.length === 0 ? (
          <div className="py-16 px-6 text-center text-sm text-oct-muted">
            No holders found for this coin.
          </div>
        ) : (
          <ul className="divide-y divide-oct-border">
            {holders.map((holder) => (
              <li
                key={`${holder.rank}-${holder.wallet}`}
                className="flex items-center gap-3 px-4 py-3 oct-row-hover"
              >
                <span className="w-6 text-[13px] font-mono font-bold text-oct-muted tabular-nums shrink-0">
                  {holder.rank}
                </span>
                <div className="min-w-0 flex-1">
                  <a
                    href={`${SOLSCAN_ACCOUNT}${holder.wallet}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[15px] font-bold text-oct-text truncate hover:text-oct-accent transition-colors"
                    title={holder.wallet}
                  >
                    {holder.name ?? truncateAddress(holder.wallet)}
                    <ExternalLink size={10} className="shrink-0 text-oct-muted" />
                  </a>
                  <div className="font-mono text-xs text-oct-muted tabular-nums">
                    {compactAmount(holder.amount)}
                    {holder.supplyPct != null && ` · ${holder.supplyPct.toFixed(holder.supplyPct >= 1 ? 1 : 2)}%`}
                  </div>
                </div>
                <div className="shrink-0 text-right font-mono text-[13px] tabular-nums">
                  <div className="text-oct-text">{compactUsd(holder.valueUsd)}</div>
                  <div className={holder.pnlUsd == null ? 'text-oct-muted' : holder.pnlUsd >= 0 ? 'text-oct-green' : 'text-oct-flame'}>
                    {signedUsd(holder.pnlUsd)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
