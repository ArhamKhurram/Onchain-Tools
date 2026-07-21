import { ExternalLink } from 'lucide-react';
import type { GmgnChain, PortfolioActivity } from '../../types/portfolio';
import {
  classifyActivitySide,
  formatAge,
  formatMarketCap,
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

function SideBadge({ side }: { side: 'buy' | 'sell' | 'other' }) {
  if (side === 'buy') {
    return (
      <span className="inline-block font-mono text-[10px] font-bold uppercase px-2 py-0.5 rounded-sm bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
        Buy
      </span>
    );
  }
  if (side === 'sell') {
    return (
      <span className="inline-block font-mono text-[10px] font-bold uppercase px-2 py-0.5 rounded-sm bg-red-500/20 text-red-300 border border-red-500/40">
        Sell
      </span>
    );
  }
  return (
    <span className="inline-block font-mono text-[10px] font-bold uppercase px-2 py-0.5 rounded-sm bg-oct-accent/15 text-oct-accent border border-oct-accent/35">
      Trade
    </span>
  );
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
        {loading && <span className="font-mono text-[10px] text-oct-accent/70">Loading…</span>}
      </div>

      {error && (
        <p className="px-4 py-3 font-mono text-xs text-red-300 border-b border-oct-accent/20">{error}</p>
      )}

      {!error && activity.length === 0 && !loading && (
        <p className="px-4 py-8 font-mono text-sm text-white/50 text-center">No recent trades.</p>
      )}

      {activity.length > 0 && (
        <div className="grid grid-cols-[auto_1fr_auto_auto_auto] gap-x-3 gap-y-0 px-4 py-2 border-b border-oct-accent/20 font-mono text-[9px] uppercase tracking-wider text-oct-accent/70">
          <span>Type</span>
          <span>Token</span>
          <span className="text-right">Amount</span>
          <span className="text-right hidden sm:block">MC</span>
          <span className="text-right">Age</span>
        </div>
      )}

      <ul className="divide-y divide-oct-accent/15 overflow-auto max-h-[480px]">
        {activity.map((item, idx) => {
          const side = classifyActivitySide(item) ?? 'other';
          const rowChain = (item.chain ?? fallbackChain) as GmgnChain;
          const txUrl = txExplorerUrl(rowChain, String(item.transaction_hash ?? ''));
          const mc = formatMarketCap(item.market_cap ?? item.token?.market_cap);
          const symbol = item.token?.symbol ?? '—';

          return (
            <li
              key={`${item.walletLabel ?? ''}-${rowChain}-${item.transaction_hash ?? idx}`}
              className="grid grid-cols-[auto_1fr_auto_auto_auto] gap-x-3 items-center px-4 py-2.5 hover:bg-oct-accent/[0.04] transition-colors"
            >
              <SideBadge side={side} />

              <div className="min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  {showWalletTag && item.walletLabel && (
                    <span className="font-mono text-[9px] px-1 py-0.5 border border-oct-accent/30 text-oct-accent/90">
                      {item.walletLabel}
                    </span>
                  )}
                  {showChainTag && (
                    <span className="font-mono text-[9px] px-1 py-0.5 border border-white/15 text-white/50">
                      {GMGN_CHAIN_SHORT[rowChain]}
                    </span>
                  )}
                  <span className="font-mono text-sm font-semibold text-white truncate">{symbol}</span>
                  {txUrl && (
                    <a
                      href={txUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-oct-accent/70 hover:text-oct-accent"
                      title="View transaction"
                    >
                      <ExternalLink size={11} />
                    </a>
                  )}
                </div>
                {toNumber(item.token_amount) > 0 && (
                  <p className="font-mono text-[10px] text-white/40 mt-0.5 truncate">
                    {toNumber(item.token_amount).toLocaleString(undefined, { maximumFractionDigits: 4 })} tokens
                  </p>
                )}
              </div>

              <span className="font-mono text-sm text-white tabular-nums text-right">
                {formatUsd(item.cost_usd)}
              </span>

              <span className="font-mono text-[11px] text-white/45 tabular-nums text-right hidden sm:block">
                {mc ?? '—'}
              </span>

              <span className="font-mono text-[11px] text-oct-accent/80 tabular-nums text-right">
                {formatAge(item.timestamp)}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
