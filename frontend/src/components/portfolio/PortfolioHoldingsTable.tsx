import { ExternalLink } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import type { GmgnChain, PortfolioHolding } from '../../types/portfolio';
import { formatUsd, GMGN_CHAIN_SHORT, PORTFOLIO_PANEL, PORTFOLIO_PANEL_HEADER, PORTFOLIO_PANEL_TITLE, toNumber, walletChainToGmgn } from '../../types/portfolio';
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
        {loading && <span className="font-mono text-[10px] text-oct-accent/70">Loading…</span>}
      </div>

      {needsPrivateKey && (
        <p className="px-4 py-2 font-mono text-xs text-amber-300 border-b border-oct-accent/20 bg-amber-950/20">
          Holdings need <code className="text-amber-200">GMGN_PRIVATE_KEY</code> on the backend. Stats, activity, and PnL still work without it.
        </p>
      )}

      {error && !needsPrivateKey && (
        <p className="px-4 py-3 font-mono text-xs text-red-300">{error}</p>
      )}

      {!error && holdings.length === 0 && !loading && (
        <p className="px-4 py-8 font-mono text-sm text-white/50 text-center">No open positions reported by GMGN.</p>
      )}

      {holdings.length > 0 && (
        <div className="overflow-auto">
          <table className="w-full min-w-[720px] text-left font-mono text-xs">
            <thead className="sticky top-0 bg-black/80 border-b border-oct-accent/25 text-oct-accent/70 uppercase tracking-[0.1em]">
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
                  <tr key={`${row.walletLabel ?? ''}-${rowChain}-${addr ?? idx}`} className="border-b border-oct-accent/15 hover:bg-oct-accent/[0.04]">
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        {showWalletTag && row.walletLabel && (
                          <span className="font-mono text-[9px] px-1 py-0.5 border border-oct-accent/30 text-oct-accent/90">
                            {row.walletLabel}
                          </span>
                        )}
                        {showChainTag && (
                          <span className="font-mono text-[9px] px-1 py-0.5 border border-white/15 text-white/50">
                            {GMGN_CHAIN_SHORT[rowChain] ?? rowChain.toUpperCase()}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => openToken(addr, rowChain)}
                          className="inline-flex items-center gap-1 text-white font-semibold hover:text-oct-accent disabled:opacity-50"
                          disabled={!addr || !templates}
                        >
                          {symbol}
                          {addr && templates && <ExternalLink size={12} />}
                        </button>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-white/80">{toNumber(row.balance).toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                    <td className="px-3 py-2.5 text-white">{formatUsd(row.usd_value)}</td>
                    <td className="px-3 py-2.5">{formatUsd(row.total_profit, { signed: true })}</td>
                    <td className={`px-3 py-2 ${pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {Number.isFinite(pnlPct) ? `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%` : '—'}
                    </td>
                    <td className="px-3 py-2">{formatUsd(row.avg_cost)}</td>
                    <td className="px-3 py-2">{toNumber(row.buy_tx_count)} / {toNumber(row.sell_tx_count)}</td>
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
