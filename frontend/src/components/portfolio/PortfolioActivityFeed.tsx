import { ExternalLink } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { GmgnChain, PortfolioActivity } from '../../types/portfolio';
import {
  classifyActivitySide,
  formatAge,
  formatMarketCap,
  formatPortfolioError,
  formatUsd,
  GMGN_CHAIN_SHORT,
  PORTFOLIO_PANEL,
  PORTFOLIO_PANEL_HEADER,
  PORTFOLIO_PANEL_TITLE,
  toNumber,
  txExplorerUrl,
  walletChainToGmgn,
} from '../../types/portfolio';
import type { WalletChain } from '../../types/wallets';

interface PortfolioActivityFeedProps {
  activity: PortfolioActivity[];
  chain: WalletChain;
  loading: boolean;
  error: string | null;
  showChainTag: boolean;
  showWalletTag: boolean;
}

// Same column template for the header and every row so the two can't drift.
const ROW_GRID = 'grid grid-cols-[auto_1fr_auto_auto_auto] gap-x-cozy items-center';
const TAG = 'type-caption font-mono px-snug py-hair rounded-oct-sm border';

// Buy/sell follow the trading convention (green in, red out) and so use the
// semantic good/critical pair. An unclassified trade carries no direction and
// gets the brand accent — it is a neutral tag, not a status.
const SIDE_BADGE = 'inline-block type-caption font-mono font-bold uppercase px-cozy py-hair rounded-oct-sm border';
function SideBadge({ side }: { side: 'buy' | 'sell' | 'other' }) {
  if (side === 'buy') {
    return <span className={cn(SIDE_BADGE, 'bg-oct-good-dim text-oct-good border-oct-good/40')}>Buy</span>;
  }
  if (side === 'sell') {
    return <span className={cn(SIDE_BADGE, 'bg-oct-critical-dim text-oct-critical border-oct-critical/40')}>Sell</span>;
  }
  return <span className={cn(SIDE_BADGE, 'bg-oct-accent-dim text-oct-accent border-oct-accent/35')}>Trade</span>;
}

export default function PortfolioActivityFeed({
  activity,
  chain,
  loading,
  error,
  showChainTag,
  showWalletTag,
}: PortfolioActivityFeedProps) {
  const fallbackChain = walletChainToGmgn(chain);

  return (
    <section className={`${PORTFOLIO_PANEL} flex flex-col min-h-0`}>
      <div className={PORTFOLIO_PANEL_HEADER}>
        <h2 className={PORTFOLIO_PANEL_TITLE}>Activity</h2>
        {loading && <span className="type-caption font-mono uppercase tracking-wider text-oct-accent">Loading…</span>}
      </div>

      {error && (
        <p className="px-comfy py-cozy type-body text-oct-critical border-b border-oct-border">
          {formatPortfolioError(error)}
        </p>
      )}

      {!error && activity.length === 0 && !loading && (
        <p className="px-comfy py-gutter type-body text-oct-muted text-center">No recent trades.</p>
      )}

      {activity.length > 0 && (
        <div className={cn(ROW_GRID, 'px-comfy py-snug oct-thead type-caption font-mono font-semibold uppercase tracking-[0.1em] text-oct-muted')}>
          <span>Type</span>
          <span>Token</span>
          <span className="text-right">Amount</span>
          <span className="text-right hidden sm:block">MC</span>
          <span className="text-right">Age</span>
        </div>
      )}

      <ul className="divide-y divide-oct-border/60 overflow-auto max-h-[480px]">
        {activity.map((item, idx) => {
          const side = classifyActivitySide(item) ?? 'other';
          const rowChain = (item.chain ?? fallbackChain) as GmgnChain;
          const txUrl = txExplorerUrl(rowChain, String(item.transaction_hash ?? ''));
          const mc = formatMarketCap(item.market_cap ?? item.token?.market_cap);
          const symbol = item.token?.symbol ?? '—';

          return (
            <li
              key={`${item.walletLabel ?? ''}-${rowChain}-${item.transaction_hash ?? idx}`}
              className={cn(ROW_GRID, 'px-comfy py-snug oct-row-hover')}
            >
              <SideBadge side={side} />

              <div className="min-w-0">
                <div className="flex items-center gap-snug flex-wrap">
                  {showWalletTag && item.walletLabel && (
                    <span className={cn(TAG, 'border-oct-accent/30 text-oct-accent')}>
                      {item.walletLabel}
                    </span>
                  )}
                  {showChainTag && (
                    <span className={cn(TAG, 'border-oct-border text-oct-muted')}>
                      {GMGN_CHAIN_SHORT[rowChain]}
                    </span>
                  )}
                  <span className="type-data font-bold text-oct-text truncate">{symbol}</span>
                  {txUrl && (
                    <a
                      href={txUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-oct-muted hover:text-oct-accent"
                      title="View transaction"
                    >
                      <ExternalLink size={12} />
                    </a>
                  )}
                </div>
                {toNumber(item.token_amount) > 0 && (
                  <p className="type-data text-2xs text-oct-muted mt-hair truncate">
                    {toNumber(item.token_amount).toLocaleString(undefined, { maximumFractionDigits: 4 })} tokens
                  </p>
                )}
              </div>

              <span className="type-data text-oct-text text-right whitespace-nowrap">
                {formatUsd(item.cost_usd)}
              </span>

              <span className="type-data text-oct-muted text-right hidden sm:block whitespace-nowrap">
                {mc ?? '—'}
              </span>

              <span className="type-data text-oct-muted text-right whitespace-nowrap">
                {formatAge(item.timestamp)}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
