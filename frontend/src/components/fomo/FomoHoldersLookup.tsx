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
        className="oct-headerbar shrink-0 flex items-center gap-2 px-3 py-2.5"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Token address…"
          spellCheck={false}
          className="oct-input flex-1 min-w-0 px-2.5 py-2 font-mono text-xs"
        />
        <button
          type="submit"
          disabled={loading || input.trim().length === 0}
          className="oct-btn-primary shrink-0 p-2 disabled:opacity-40"
          title="Look up holders"
        >
          <Search size={14} />
        </button>
      </form>

      <div className="flex-1 min-h-0">
        {submitted === null ? (
          <div className="flex flex-col items-center justify-center gap-3 h-full px-6 text-center">
            <div className="w-14 h-14 rounded-oct-lg border border-oct-border bg-gradient-to-b from-oct-elevated to-oct-surface shadow-oct-soft flex items-center justify-center">
              <Search size={22} className="text-oct-muted" />
            </div>
            <p className="text-sm text-oct-muted max-w-xs leading-relaxed">
              Paste a token address to see which FOMO traders hold it.
            </p>
            <p className="text-xs text-oct-muted font-mono">
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
