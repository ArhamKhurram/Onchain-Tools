// Slide-over showing the top holders for one token from BOTH sources side by
// side: FOMO-tracked holders (fomo.family, any chain) on the left and pump.fun
// on-chain holders (Solana only) on the right. Opened from a contract row.
//
// Both hooks idle on a null id, so a closed drawer touches neither the FOMO
// worker nor Helius. The pump column fetches only for a Solana token — for any
// other chain it shows a short "Solana-only" note rather than a failed request.

import { useEffect } from 'react';
import { X } from 'lucide-react';
import { useFomoHolders } from '../../hooks/useFomoLookup';
import { usePumpHolders } from '../../hooks/usePumpHolders';
import { isPumpMint } from '../../types/pumpfun';
import FomoHoldersBoard from './FomoHoldersBoard';
import PumpHoldersBoard from '../pumpfun/PumpHoldersBoard';

export interface HoldersTarget {
  address: string;
  /** OCT chain slug ('sol', 'eth', 'bsc', 'base'); omit to let the backend infer. */
  network?: string | null;
}

interface TokenHoldersDrawerProps {
  target: HoldersTarget | null;
  onClose: () => void;
}

/** True when the target is a Solana token — the only chain pump holders exist for. */
function isSolanaTarget(target: HoldersTarget): boolean {
  const net = target.network?.toLowerCase() ?? null;
  if (net) return net === 'sol' || net === 'solana';
  // No chain hint — infer from the address shape (pump mints are base58).
  return isPumpMint(target.address);
}

export default function TokenHoldersDrawer({ target, onClose }: TokenHoldersDrawerProps) {
  const solana = target ? isSolanaTarget(target) : false;
  const fomo = useFomoHolders(target?.address ?? null, target?.network);
  const pump = usePumpHolders(solana ? (target?.address ?? null) : null);

  useEffect(() => {
    if (!target) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [target, onClose]);

  if (!target) return null;

  return (
    <div className="fixed inset-0 z-[100] flex justify-end bg-black/70" onClick={onClose}>
      <aside
        className="w-full max-w-3xl h-full bg-oct-bg border-l-2 border-black shadow-oct-hard-lg flex flex-col min-h-0 animate-in slide-in-from-right duration-150"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Top holders"
      >
        <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-b-2 border-black bg-oct-surface-raised">
          <h2 className="text-sm font-extrabold uppercase tracking-wide text-oct-text">Top Holders</h2>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-cockpit border-2 border-oct-border-bright text-oct-muted hover:text-oct-text transition-colors"
            title="Close (Esc)"
          >
            <X size={14} />
          </button>
        </div>

        {/* Two sources side by side on desktop, stacked on mobile. Each column is
            its own scroll region so a long board never pushes the other off. */}
        <div className="flex-1 min-h-0 flex flex-col md:flex-row md:divide-x-2 divide-black">
          <section className="flex-1 min-h-0 flex flex-col border-b-2 md:border-b-0 border-black">
            <div className="shrink-0 px-4 py-1.5 bg-oct-surface/60 text-[10px] font-bold uppercase tracking-wider text-oct-muted">
              FOMO tracked
            </div>
            <div className="flex-1 min-h-0">
              <FomoHoldersBoard
                data={fomo.data}
                loading={fomo.loading}
                error={fomo.error}
                onRefresh={fomo.refresh}
                pendingAddress={target.address}
              />
            </div>
          </section>

          <section className="flex-1 min-h-0 flex flex-col">
            <div className="shrink-0 px-4 py-1.5 bg-oct-surface/60 text-[10px] font-bold uppercase tracking-wider text-oct-muted">
              Pump.fun on-chain
            </div>
            <div className="flex-1 min-h-0">
              {solana ? (
                <PumpHoldersBoard
                  data={pump.data}
                  loading={pump.loading}
                  error={pump.error}
                  onRefresh={pump.refresh}
                  pendingMint={target.address}
                />
              ) : (
                <div className="flex flex-col items-center justify-center gap-2 py-16 px-6 text-center h-full">
                  <p className="text-sm text-oct-muted">Pump.fun holders are Solana-only.</p>
                  <p className="text-[11px] text-oct-muted">This token isn&apos;t on Solana.</p>
                </div>
              )}
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}
