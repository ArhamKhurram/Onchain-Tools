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
        className="oct-headerbar shrink-0 flex items-center gap-cozy px-comfy py-cozy"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Token address…"
          spellCheck={false}
          className="oct-input flex-1 min-w-0 px-cozy py-snug type-data"
        />
        <button
          type="submit"
          disabled={loading || input.trim().length === 0}
          className="oct-btn-primary shrink-0 p-snug disabled:opacity-40"
          title="Look up holders"
        >
          <Search size={14} />
        </button>
      </form>

      <div className="flex-1 min-h-0">
        {submitted === null ? (
          <div className="flex flex-col items-center justify-center gap-comfy h-full px-section text-center">
            <div className="w-12 h-12 rounded-oct-lg border border-oct-border bg-oct-surface-raised flex items-center justify-center">
              <Search size={20} className="text-oct-muted" />
            </div>
            <p className="type-body text-oct-muted max-w-xs leading-relaxed">
              Paste a token address to see which FOMO traders hold it.
            </p>
            <p className="type-caption font-mono text-oct-muted">
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
