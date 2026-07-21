import { ExternalLink } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import type { GmgnChain, PortfolioHolding } from '../../types/portfolio';
import { formatUsd, GMGN_CHAIN_SHORT, toNumber, walletChainToGmgn } from '../../types/portfolio';
import type { WalletChain } from '../../types/wallets';
import { buildContractUrl } from '../../utils/contractUrl';

interface PortfolioHoldingsTableProps {
  holdings: PortfolioHolding[];
  chain: WalletChain;
  loading: boolean;
  error: string | null;
  needsPrivateKey: boolean;
  showChainTag: boolean;
}

export default function PortfolioHoldingsTable({
  holdings,
  chain,
  loading,
  error,
  needsPrivateKey,
  showChainTag,
}: PortfolioHoldingsTableProps) {
  const templates = useAppStore((s) => s.config?.contractLinkTemplates);
  const fallbackChain = walletChainToGmgn(chain);

  const openToken = (address: string | undefined, rowChain: GmgnChain) => {
    if (!address || !templates) return;
    window.open(buildContractUrl(address, templates, rowChain), '_blank');
  };

  return (
    <section className="border-2 border-black bg-oct-surface flex flex-col min-h-0">
      <div className="px-4 py-3 border-b-2 border-black flex items-center justify-between gap-2">
        <h2 className="font-mono text-xs uppercase tracking-[0.14em] text-oct-text">Holdings</h2>
        {loading && <span className="font-mono text-[10px] text-oct-muted">Loading…</span>}
      </div>

      {needsPrivateKey && (
        <p className="px-4 py-2 font-mono text-[11px] text-amber-400 border-b border-black/40">
          Holdings need GMGN_PRIVATE_KEY on the backend. Stats, activity, and PnL chart still work without it.
        </p>
      )}

      {error && !needsPrivateKey && (
        <p className="px-4 py-3 font-mono text-[11px] text-red-400">{error}</p>
      )}

      {!error && holdings.length === 0 && !loading && (
        <p className="px-4 py-6 font-mono text-xs text-oct-muted text-center">No open positions reported by GMGN.</p>
      )}

      {holdings.length > 0 && (
        <div className="overflow-auto">
          <table className="w-full min-w-[720px] text-left font-mono text-[11px]">
            <thead className="sticky top-0 bg-oct-bg border-b border-black/50 text-oct-muted uppercase tracking-[0.1em]">
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
                  <tr key={`${rowChain}-${addr ?? idx}`} className="border-b border-black/30 hover:bg-oct-bg/40">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        {showChainTag && (
                          <span className="font-mono text-[9px] px-1 py-0.5 border border-black/50 bg-oct-bg text-oct-muted">
                            {GMGN_CHAIN_SHORT[rowChain] ?? rowChain.toUpperCase()}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => openToken(addr, rowChain)}
                          className="inline-flex items-center gap-1 text-oct-accent hover:underline disabled:opacity-50"
                          disabled={!addr || !templates}
                        >
                          {symbol}
                          {addr && templates && <ExternalLink size={12} />}
                        </button>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-oct-text">{toNumber(row.balance).toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                    <td className="px-3 py-2">{formatUsd(row.usd_value)}</td>
                    <td className="px-3 py-2">{formatUsd(row.total_profit, { signed: true })}</td>
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
