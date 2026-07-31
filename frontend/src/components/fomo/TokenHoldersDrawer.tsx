// Slide-over showing the top FOMO holders for one token, opened from a contract
// row. Fetching is keyed off `address`, and useFomoHolders idles on null, so a
// closed drawer never touches the FOMO worker.

import { useEffect } from 'react';
import { X } from 'lucide-react';
import { useFomoHolders } from '../../hooks/useFomoLookup';
import FomoHoldersBoard from './FomoHoldersBoard';

export interface HoldersTarget {
  address: string;
  /** OCT chain slug ('sol', 'eth', 'bsc', 'base'); omit to let the backend infer. */
  network?: string | null;
}

interface TokenHoldersDrawerProps {
  target: HoldersTarget | null;
  onClose: () => void;
}

export default function TokenHoldersDrawer({ target, onClose }: TokenHoldersDrawerProps) {
  const { data, loading, error, refresh } = useFomoHolders(target?.address ?? null, target?.network);

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
        className="w-full max-w-md h-full bg-oct-bg border-l-2 border-black shadow-oct-hard-lg flex flex-col min-h-0 animate-in slide-in-from-right duration-150"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Top FOMO holders"
      >
        <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-b-2 border-black bg-oct-surface-raised">
          <h2 className="text-sm font-extrabold uppercase tracking-wide text-oct-text">
            Top FOMO Holders
          </h2>
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

        <div className="flex-1 min-h-0">
          <FomoHoldersBoard
            data={data}
            loading={loading}
            error={error}
            onRefresh={refresh}
            pendingAddress={target.address}
          />
        </div>
      </aside>
    </div>
  );
}
