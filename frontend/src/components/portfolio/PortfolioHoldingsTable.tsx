import { ExternalLink } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { cn } from '../../lib/utils';
import type { GmgnChain, PortfolioHolding } from '../../types/portfolio';
import { formatPortfolioError, formatUsd, GMGN_CHAIN_SHORT, PORTFOLIO_PANEL, PORTFOLIO_PANEL_HEADER, PORTFOLIO_PANEL_TITLE, toNumber, walletChainToGmgn } from '../../types/portfolio';
import type { WalletChain } from '../../types/wallets';
import { buildContractUrl } from '../../utils/contractUrl';

interface PortfolioHoldingsTableProps {
  holdings: PortfolioHolding[];
  chain: WalletChain;
  loading: boolean;
  error: string | null;
  showChainTag: boolean;
  showWalletTag: boolean;
}

// Blotter cells. Every numeric column is `type-data` (mono, tabular, slashed
// zero) and right-aligned so the digits line up down the column the way a
// terminal blotter reads; `py-snug` keeps rows dense enough to scan a long book.
const TH = 'px-cozy py-snug type-caption font-mono font-semibold uppercase tracking-[0.1em] text-oct-muted whitespace-nowrap';
const TH_NUM = `${TH} text-right`;
const TD = 'px-cozy py-snug';
const TD_NUM = `${TD} type-data text-right whitespace-nowrap`;
const TAG = 'type-caption font-mono px-snug py-hair rounded-oct-sm border';

/** Profit reads `oct-good`, loss `oct-critical`, flat stays neutral. */
function pnlTone(n: number): string {
  if (!Number.isFinite(n) || n === 0) return 'text-oct-text';
  return n > 0 ? 'text-oct-good' : 'text-oct-critical';
}

export default function PortfolioHoldingsTable({
  holdings,
  chain,
  loading,
  error,
  showChainTag,
  showWalletTag,
}: PortfolioHoldingsTableProps) {
  const templates = useAppStore((s) => s.config?.contractLinkTemplates);
  const fallbackChain = walletChainToGmgn(chain);

  const openToken = (address: string | undefined, rowChain: GmgnChain) => {
    if (!address || !templates) return;
    window.open(buildContractUrl(address, templates, rowChain), '_blank');
  };

  return (
    <section className={`${PORTFOLIO_PANEL} flex flex-col min-h-0`}>
      <div className={PORTFOLIO_PANEL_HEADER}>
        <h2 className={PORTFOLIO_PANEL_TITLE}>Holdings</h2>
        {loading && <span className="type-caption font-mono uppercase tracking-wider text-oct-accent">Loading…</span>}
      </div>

      {error && (
        <p className="px-comfy py-cozy type-body text-oct-critical">{formatPortfolioError(error)}</p>
      )}

      {!error && holdings.length === 0 && !loading && (
        <p className="px-comfy py-gutter type-body text-oct-muted text-center">No open positions reported by Birdeye.</p>
      )}

      {holdings.length > 0 && (
        <div className="overflow-auto">
          <table className="w-full min-w-[720px] text-left">
            <thead className="oct-thead sticky top-0 z-10">
              <tr>
                <th className={TH}>Token</th>
                <th className={TH_NUM}>Balance</th>
                <th className={TH_NUM}>USD Value</th>
                <th className={TH_NUM}>Total PnL</th>
                <th className={TH_NUM}>PnL %</th>
                <th className={TH_NUM}>Avg Cost</th>
                <th className={TH_NUM}>Buys / Sells</th>
              </tr>
            </thead>
            <tbody>
              {holdings.map((row, idx) => {
                const symbol = row.token?.symbol ?? '—';
                const addr = row.token?.address;
                const rowChain = (row.chain ?? fallbackChain) as GmgnChain;
                const pnlPct = toNumber(row.profit_change) * 100;
                const pnlUsd = toNumber(row.total_profit);
                return (
                  <tr key={`${row.walletLabel ?? ''}-${rowChain}-${addr ?? idx}`} className="border-b border-oct-border/60 oct-row-hover">
                    <td className={TD}>
                      <div className="flex items-center gap-snug flex-wrap">
                        {showWalletTag && row.walletLabel && (
                          <span className={cn(TAG, 'border-oct-accent/30 text-oct-accent')}>
                            {row.walletLabel}
                          </span>
                        )}
                        {showChainTag && (
                          <span className={cn(TAG, 'border-oct-border text-oct-muted')}>
                            {GMGN_CHAIN_SHORT[rowChain] ?? rowChain.toUpperCase()}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => openToken(addr, rowChain)}
                          className="inline-flex items-center gap-tight type-data font-bold text-oct-text hover:text-oct-accent disabled:opacity-50"
                          disabled={!addr || !templates}
                        >
                          {symbol}
                          {addr && templates && <ExternalLink size={12} />}
                        </button>
                      </div>
                    </td>
                    <td className={cn(TD_NUM, 'text-oct-muted')}>{toNumber(row.balance).toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                    <td className={cn(TD_NUM, 'text-oct-text')}>{formatUsd(row.usd_value)}</td>
                    <td className={cn(TD_NUM, pnlTone(pnlUsd))}>{formatUsd(row.total_profit, { signed: true })}</td>
                    <td className={cn(TD_NUM, pnlTone(pnlPct))}>
                      {Number.isFinite(pnlPct) ? `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%` : '—'}
                    </td>
                    <td className={cn(TD_NUM, 'text-oct-text')}>{formatUsd(row.avg_cost)}</td>
                    <td className={cn(TD_NUM, 'text-oct-muted')}>{toNumber(row.buy_tx_count)} / {toNumber(row.sell_tx_count)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
