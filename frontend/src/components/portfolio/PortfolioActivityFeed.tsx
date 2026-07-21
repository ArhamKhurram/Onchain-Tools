import { ExternalLink } from 'lucide-react';
import type { GmgnChain, PortfolioActivity } from '../../types/portfolio';
import { formatUsd, GMGN_CHAIN_SHORT, txExplorerUrl, walletChainToGmgn } from '../../types/portfolio';
import type { WalletChain } from '../../types/wallets';

interface PortfolioActivityFeedProps {
  activity: PortfolioActivity[];
  chain: WalletChain;
  loading: boolean;
  error: string | null;
  showChainTag: boolean;
}

function formatTime(ts: unknown): string {
  const n = Number(ts);
  if (!Number.isFinite(n)) return '—';
  return new Date(n * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function shortHash(hash?: string): string {
  if (!hash) return '—';
  if (hash.length <= 12) return hash;
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

export default function PortfolioActivityFeed({
  activity,
  chain,
  loading,
  error,
  showChainTag,
}: PortfolioActivityFeedProps) {
  const fallbackChain = walletChainToGmgn(chain);

  return (
    <section className="border-2 border-black bg-oct-surface flex flex-col min-h-0">
      <div className="px-4 py-3 border-b-2 border-black flex items-center justify-between">
        <h2 className="font-mono text-xs uppercase tracking-[0.14em] text-oct-text">Recent Activity</h2>
        {loading && <span className="font-mono text-[10px] text-oct-muted">Loading…</span>}
      </div>

      {error && <p className="px-4 py-3 font-mono text-[11px] text-red-400">{error}</p>}

      {!error && activity.length === 0 && !loading && (
        <p className="px-4 py-6 font-mono text-xs text-oct-muted text-center">No recent trades.</p>
      )}

      <ul className="divide-y divide-black/30 overflow-auto max-h-[420px]">
        {activity.map((item, idx) => {
          const type = String(item.type ?? '').toLowerCase();
          const isBuy = type === 'buy';
          const rowChain = (item.chain ?? fallbackChain) as GmgnChain;
          const txUrl = txExplorerUrl(rowChain, String(item.transaction_hash ?? ''));
          return (
            <li key={`${rowChain}-${item.transaction_hash ?? idx}`} className="px-4 py-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-mono text-xs text-oct-text">
                  {showChainTag && (
                    <span className="font-mono text-[9px] px-1 py-0.5 mr-1 border border-black/50 bg-oct-bg text-oct-muted">
                      {GMGN_CHAIN_SHORT[rowChain] ?? rowChain.toUpperCase()}
                    </span>
                  )}
                  <span className={isBuy ? 'text-emerald-400' : 'text-red-400'}>
                    {type.toUpperCase() || 'TRADE'}
                  </span>
                  {' '}
                  <span className="text-oct-accent">{item.token?.symbol ?? '—'}</span>
                </p>
                <p className="font-mono text-[10px] text-oct-muted mt-0.5">{formatTime(item.timestamp)}</p>
              </div>
              <div className="text-right shrink-0">
                <p className="font-mono text-xs">{formatUsd(item.cost_usd)}</p>
                {txUrl && (
                  <a
                    href={txUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-[10px] text-oct-muted hover:text-oct-accent mt-0.5"
                  >
                    {shortHash(item.transaction_hash)}
                    <ExternalLink size={10} />
                  </a>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
