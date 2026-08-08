// Paste a token address, get the written FOMO theses for it: each trader's
// position, PnL and thesis text. The theses counterpart to FomoHoldersLookup,
// driven by an explicit submit rather than a selection. Used as the FOMO →
// Theses tab.
//
// Submit-driven on purpose — each lookup is a round trip to the single-tab
// Chromium worker, so search-as-you-type would hammer it.

import { useState, type FormEvent } from 'react';
import { Search } from 'lucide-react';
import { useFomoTheses } from '../../hooks/useFomoLookup';
import FomoThesesBoard from './FomoThesesBoard';

export default function FomoThesesLookup() {
  const [input, setInput] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);
  const { data, loading, error, refresh } = useFomoTheses(submitted);

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
          title="Look up theses"
        >
          <Search size={14} />
        </button>
      </form>

      <div className="flex-1 min-h-0">
        {submitted === null ? (
          <div className="flex flex-col items-center justify-center gap-2 h-full px-6 text-center">
            <Search size={20} className="text-oct-muted" />
            <p className="text-sm text-oct-muted">
              Paste a token address to read what FOMO traders think of it.
            </p>
            <p className="text-[11px] text-oct-muted font-mono">
              Solana or any EVM chain — the chain is detected for you.
            </p>
          </div>
        ) : (
          <FomoThesesBoard
            data={data}
            loading={loading}
            error={error}
            onRefresh={refresh}
            address={submitted}
          />
        )}
      </div>
    </div>
  );
}
