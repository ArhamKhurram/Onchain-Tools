import { ExternalLink } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import type { GmgnChain, PortfolioHolding } from '../../types/portfolio';
import { formatPortfolioError, formatUsd, GMGN_CHAIN_SHORT, PORTFOLIO_PANEL, PORTFOLIO_PANEL_HEADER, PORTFOLIO_PANEL_TITLE, toNumber, walletChainToGmgn } from '../../types/portfolio';
import type { WalletChain } from '../../types/wallets';
import { buildContractUrl } from '../../utils/contractUrl';

interface PortfolioHoldingsTableProps {
  holdings: PortfolioHolding[];
  chain: WalletChain;
  loading: boolean;
  error: string | null;
  needsPrivateKey: boolean;
  showChainTag: boolean;
  showWalletTag: boolean;
}

export default function PortfolioHoldingsTable({
  holdings,
  chain,
  loading,
  error,
  needsPrivateKey,
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
        {loading && <span className="oct-eyebrow text-oct-accent">Loading…</span>}
      </div>

      {error && (
        <p className="px-4 py-3 font-mono text-xs text-oct-flame">{formatPortfolioError(error)}</p>
      )}

      {!error && holdings.length === 0 && !loading && (
        <p className="px-4 py-10 font-mono text-sm text-oct-muted text-center">No open positions reported by Birdeye.</p>
      )}

      {holdings.length > 0 && (
        <div className="overflow-auto">
          <table className="w-full min-w-[720px] text-left font-mono text-xs">
            <thead className="oct-thead sticky top-0 z-10 text-oct-muted uppercase tracking-[0.1em]">
              <tr>
                <th className="px-3 py-2">Token</th>
                <th className="px-3 py-2">Balance</th>
                <th className="px-3 py-2">USD Value</th>
                <th className="px-3 py-2">Total PnL</th>
                <th className="px-3 py-2">PnL %</th>
                <th className="px-3 py-2">Avg Cost</th>
                <th className="px-3 py-2">Buys / Sells</th>
              </tr>
            </thead>
            <tbody>
              {holdings.map((row, idx) => {
                const symbol = row.token?.symbol ?? '—';
                const addr = row.token?.address;
                const rowChain = (row.chain ?? fallbackChain) as GmgnChain;
                const pnlPct = toNumber(row.profit_change) * 100;
                return (
                  <tr key={`${row.walletLabel ?? ''}-${rowChain}-${addr ?? idx}`} className="border-b border-oct-border/60 oct-row-hover">
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        {showWalletTag && row.walletLabel && (
                          <span className="font-mono text-[10px] px-1.5 py-0.5 rounded-oct-sm border border-oct-accent/30 text-oct-accent">
                            {row.walletLabel}
                          </span>
                        )}
                        {showChainTag && (
                          <span className="font-mono text-[10px] px-1.5 py-0.5 rounded-oct-sm border border-oct-border text-oct-muted">
                            {GMGN_CHAIN_SHORT[rowChain] ?? rowChain.toUpperCase()}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => openToken(addr, rowChain)}
                          className="inline-flex items-center gap-1 text-oct-text font-semibold hover:text-oct-accent disabled:opacity-50"
                          disabled={!addr || !templates}
                        >
                          {symbol}
                          {addr && templates && <ExternalLink size={12} />}
                        </button>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-oct-muted tabular-nums">{toNumber(row.balance).toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                    <td className="px-3 py-2.5 text-oct-text tabular-nums">{formatUsd(row.usd_value)}</td>
                    <td className="px-3 py-2.5 tabular-nums">{formatUsd(row.total_profit, { signed: true })}</td>
                    <td className={`px-3 py-2 tabular-nums ${pnlPct >= 0 ? 'text-oct-green' : 'text-oct-flame'}`}>
                      {Number.isFinite(pnlPct) ? `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%` : '—'}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{formatUsd(row.avg_cost)}</td>
                    <td className="px-3 py-2 tabular-nums">{toNumber(row.buy_tx_count)} / {toNumber(row.sell_tx_count)}</td>
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
