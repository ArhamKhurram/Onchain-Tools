// Top pump.fun holders board for one coin. The pump counterpart to
// FomoHoldersBoard: same list shape and USD formatting so the two sit side by
// side in TokenHoldersDrawer without a visual seam.
//
// The base list is on-chain (owner wallet + balance + supply-%) and PnL is the
// keyless holders endpoint; identity (a name instead of a short wallet) is a
// later enrichment, so until `data.enriched` is true every row shows the short
// owner address linked to Solscan. A missing PnL shows an em dash, never a zero.

import { ExternalLink, RefreshCw, Coins } from 'lucide-react';
import type { PumpHoldersResponse } from '../../types/pumpfun';

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

function shortAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
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
          <span className="font-mono text-[11px] text-oct-muted">{shortAddress(pendingMint)}</span>
        )}
      </div>
    );
  }

  if (error) {
    return (
      <div className="m-4 px-4 py-3 rounded-cockpit border-2 border-oct-accent bg-oct-accent-dim text-sm text-oct-accent">
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
      <div className="shrink-0 px-4 py-3 border-b-2 border-black bg-oct-surface flex items-center gap-2">
        <span className="font-extrabold text-oct-text text-sm uppercase tracking-wide">On-chain</span>
        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-cockpit uppercase font-mono bg-oct-surface-raised text-oct-muted">
          SOL
        </span>
        <div className="flex-1" />
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="shrink-0 p-1.5 rounded-cockpit border-2 border-oct-border-bright text-oct-muted hover:text-oct-text transition-colors disabled:opacity-50"
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
                className="flex items-center gap-3 px-4 py-2.5 hover:bg-oct-surface-raised/60 transition-colors"
              >
                <span className="w-6 text-xs font-mono font-bold text-oct-muted tabular-nums shrink-0">
                  {holder.rank}
                </span>
                <div className="min-w-0 flex-1">
                  <a
                    href={`${SOLSCAN_ACCOUNT}${holder.wallet}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-bold text-oct-text truncate hover:text-oct-accent transition-colors"
                    title={holder.wallet}
                  >
                    {holder.name ?? shortAddress(holder.wallet)}
                    <ExternalLink size={10} className="shrink-0 text-oct-muted" />
                  </a>
                  <div className="font-mono text-[11px] text-oct-muted tabular-nums">
                    {compactAmount(holder.amount)}
                    {holder.supplyPct != null && ` · ${holder.supplyPct.toFixed(holder.supplyPct >= 1 ? 1 : 2)}%`}
                  </div>
                </div>
                <div className="shrink-0 text-right font-mono text-xs tabular-nums">
                  <div className="text-oct-text">{compactUsd(holder.valueUsd)}</div>
                  <div className={holder.pnlUsd == null ? 'text-oct-muted' : holder.pnlUsd >= 0 ? 'text-green-400' : 'text-oct-accent'}>
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
