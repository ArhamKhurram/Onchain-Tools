// Paste a token address, get its top FOMO holders. Same board the contract-row
// drawer renders, driven by an explicit submit rather than a selection. Used as
// the FOMO → Holders tab and as the Workspace "Token lookup" panel.
//
// Submit-driven on purpose — each lookup is a round trip to the single-tab
// Chromium worker, so search-as-you-type would hammer it.

import { useState, type FormEvent } from 'react';
import { Search } from 'lucide-react';
import { useFomoHolders } from '../../hooks/useFomoLookup';
import FomoHoldersBoard from './FomoHoldersBoard';

export default function FomoHoldersLookup() {
  const [input, setInput] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);
  const { data, loading, error, refresh } = useFomoHolders(submitted);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const next = input.trim();
    setSubmitted(next.length > 0 ? next : null);
  };

  return (
    <div className="flex flex-col min-h-0 h-full">
      <form
        onSubmit={handleSubmit}
        className="shrink-0 flex items-center gap-2 px-3 py-2 border-b-2 border-black bg-oct-surface"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Token address…"
          spellCheck={false}
          className="flex-1 min-w-0 px-2 py-1.5 rounded-cockpit border-2 border-oct-border-bright bg-oct-bg font-mono text-xs text-oct-text placeholder:text-oct-muted focus:outline-none focus:border-oct-accent"
        />
        <button
          type="submit"
          disabled={loading || input.trim().length === 0}
          className="shrink-0 p-1.5 rounded-cockpit border-2 border-black bg-oct-accent text-white shadow-oct-hard-sm hover:opacity-90 transition-opacity disabled:opacity-40"
          title="Look up holders"
        >
          <Search size={14} />
        </button>
      </form>

      <div className="flex-1 min-h-0">
        {submitted === null ? (
          <div className="flex flex-col items-center justify-center gap-2 h-full px-6 text-center">
            <Search size={20} className="text-oct-muted" />
            <p className="text-sm text-oct-muted">
              Paste a token address to see which FOMO traders hold it.
            </p>
            <p className="text-[11px] text-oct-muted font-mono">
              Solana or any EVM chain — the chain is detected for you.
            </p>
          </div>
        ) : (
          <FomoHoldersBoard
            data={data}
            loading={loading}
            error={error}
            onRefresh={refresh}
            pendingAddress={submitted}
          />
        )}
      </div>
    </div>
  );
}
