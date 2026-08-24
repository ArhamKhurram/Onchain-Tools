import { useCallback, useState } from 'react';
import { Check, Copy, Flame, X } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import {
  buildRevivalContractUrl,
  revivalNetworkLabel,
  DEFAULT_LINK_TEMPLATES,
} from '../utils/contractUrl';
import { formatMcap } from '../types/pumpfun';

/**
 * Persistent full-width revival ignition banner(s), mounted at the top of the
 * app shell above page content. Flame red, unmissable, and deliberately NOT
 * auto-dismissed — a revival stays until the user clicks the X (which also
 * stops the repeating sound loop, via dismissRevival).
 */
export default function RevivalBanner() {
  const activeRevivals = useAppStore((s) => s.activeRevivals);
  const dismissRevival = useAppStore((s) => s.dismissRevival);
  const config = useAppStore((s) => s.config);

  // Which mint's CA was just copied — drives the transient ✓ on its button.
  const [copiedMint, setCopiedMint] = useState<string | null>(null);

  const copyMint = useCallback((mint: string) => {
    void navigator.clipboard?.writeText(mint);
    setCopiedMint(mint);
    setTimeout(() => setCopiedMint((m) => (m === mint ? null : m)), 1200);
  }, []);

  if (activeRevivals.length === 0) return null;

  return (
    <div className="shrink-0">
      {activeRevivals.map((r) => {
        const sym = r.symbol ? `$${r.symbol}` : `${r.mint.slice(0, 6)}…`;
        const mc = typeof r.mcapUsd === 'number' ? formatMcap(r.mcapUsd) : '—';
        const chain = revivalNetworkLabel(r.network);
        // Chain-aware: a BNB / Robinhood revival must open on ITS chain, not
        // on the EVM template's default one.
        const url = buildRevivalContractUrl(
          r.mint,
          r.network,
          config?.contractLinkTemplates ?? DEFAULT_LINK_TEMPLATES,
        );
        return (
          <div
            key={r.id}
            role="alert"
            className="flex items-center gap-3 w-full px-4 sm:px-6 py-2.5 bg-red-600 border-b-2 border-red-800 text-white"
          >
            <Flame size={18} className="shrink-0 text-yellow-300 animate-pulse" aria-hidden />
            <span className="shrink-0 font-mono text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-oct-sm bg-red-800/70 border border-red-400/40">
              {chain}
            </span>
            <button
              type="button"
              onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
              className="flex-1 min-w-0 text-left font-mono text-xs sm:text-sm font-bold uppercase tracking-wide truncate hover:underline"
              title={`Open ${sym} on ${chain} (${r.mint})`}
            >
              REVIVAL: {sym} igniting — mcap {mc}, RVOL {r.rvol.toFixed(1)}x
              <span className="hidden sm:inline font-normal normal-case tracking-normal opacity-80">
                {' '}· ATR z {r.atrZ.toFixed(1)}{typeof r.price === 'number' ? ` · $${r.price.toPrecision(3)}` : ''}
              </span>
            </button>
            {/* Copy the raw CA — the text opens the platform, but you often
                just want the address to paste into a terminal. */}
            <button
              type="button"
              onClick={() => copyMint(r.mint)}
              className="shrink-0 p-1 rounded hover:bg-red-700 transition-colors"
              title={copiedMint === r.mint ? 'Copied' : `Copy CA (${r.mint})`}
              aria-label="Copy contract address"
            >
              {copiedMint === r.mint ? <Check size={16} className="text-green-300" /> : <Copy size={16} />}
            </button>
            <button
              type="button"
              onClick={() => dismissRevival(r.id)}
              className="shrink-0 p-1 rounded hover:bg-red-700 transition-colors"
              title="Dismiss revival alert"
              aria-label="Dismiss revival alert"
            >
              <X size={16} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
