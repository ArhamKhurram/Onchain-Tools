// Look up any FOMO trader by handle or display name and show their public
// wallets, holdings and PnL — the console's read of the Discord /wallet command.
//
// Distinct from the Tracking tab (FomoTrackedList): that manages *your* tracked
// traders (a Supabase write). This is a read-only probe of anyone on
// fomo.family, so nothing here persists.

import { useState, type FormEvent } from 'react';
import { Check, Copy, Search, Wallet } from 'lucide-react';
import { useFomoTraderLookup } from '../../hooks/useFomoLookup';

function compactUsd(value: number | null | undefined): string {
  if (value == null) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(abs / 1e3).toFixed(1)}K`;
  return `$${abs.toFixed(0)}`;
}

function signedUsd(value: number): string {
  return `${value >= 0 ? '+' : '-'}${compactUsd(Math.abs(value))}`;
}

function pnlClass(value: number): string {
  return value >= 0 ? 'text-oct-green' : 'text-oct-flame';
}

function AddressRow({ label, address }: { label: string; address: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable — nothing useful to show */
    }
  };

  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="text-[11px] font-bold uppercase font-mono text-oct-muted w-8 shrink-0">
        {label}
      </span>
      <span className="font-mono text-[13px] text-oct-text truncate" title={address}>
        {address}
      </span>
      <button
        type="button"
        onClick={copy}
        className="shrink-0 p-1 rounded-oct-sm hover:bg-oct-surface text-oct-muted hover:text-oct-text transition-colors"
        title={`Copy ${label} address`}
      >
        {copied ? <Check size={12} className="text-oct-green" /> : <Copy size={12} />}
      </button>
    </div>
  );
}

export default function FomoTraderLookup() {
  const [input, setInput] = useState('');
  const { data, loading, error, lookup } = useFomoTraderLookup();

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    void lookup(input);
  };

  return (
    <div className="flex flex-col min-h-0 h-full overflow-hidden">
      <form
        onSubmit={handleSubmit}
        className="oct-headerbar shrink-0 flex items-center gap-2 px-4 py-3"
      >
        <Wallet size={16} className="text-oct-accent shrink-0 hidden sm:block" />
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="X handle or display name…"
          spellCheck={false}
          className="oct-input flex-1 min-w-0 px-2.5 py-2 font-mono text-xs"
        />
        <button
          type="submit"
          disabled={loading || input.trim().length === 0}
          className="oct-btn-primary shrink-0 px-3.5 py-2 text-xs uppercase disabled:opacity-40"
        >
          {loading ? (
            <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
          ) : (
            <Search size={12} />
          )}
          Look up
        </button>
      </form>

      <div className="flex-1 min-h-0 overflow-auto">
        {error && (
          <div className="m-4 px-4 py-3 rounded-oct border border-oct-flame/40 bg-oct-flame/10 text-sm text-oct-text">
            {error}
          </div>
        )}

        {!data && !error && (
          <div className="flex flex-col items-center justify-center gap-3 py-16 px-6 text-center">
            <div className="w-14 h-14 rounded-oct-lg border border-oct-border bg-gradient-to-b from-oct-elevated to-oct-surface shadow-oct-soft flex items-center justify-center">
              <Search size={22} className="text-oct-muted" />
            </div>
            <p className="text-sm text-oct-muted max-w-xs leading-relaxed">
              Search any fomo.family trader by their X handle or display name to see their wallets, holdings and PnL.
            </p>
          </div>
        )}

        {data && (
          <div className="p-4 space-y-4">
            <div className="oct-card p-4 space-y-3">
              <div className="min-w-0">
                <div className="text-lg font-extrabold text-oct-text truncate">
                  {data.displayName ?? data.handle ?? 'Unknown trader'}
                </div>
                {data.handle && (
                  <div className="text-[13px] text-oct-muted truncate">@{data.handle}</div>
                )}
              </div>

              <div className="flex flex-wrap gap-x-8 gap-y-3 font-mono">
                <div>
                  <div className="oct-stat-label">Portfolio PnL</div>
                  <div className={`text-lg font-bold tabular-nums mt-0.5 ${pnlClass(data.portfolioPnlUsd)}`}>
                    {signedUsd(data.portfolioPnlUsd)}
                  </div>
                </div>
                <div>
                  <div className="oct-stat-label">Live perp PnL</div>
                  <div className={`text-lg font-bold tabular-nums mt-0.5 ${pnlClass(data.livePerpPnlUsd)}`}>
                    {signedUsd(data.livePerpPnlUsd)}
                  </div>
                </div>
              </div>

              {(data.solAddress || data.evmAddress) && (
                <div className="space-y-1.5 pt-2 border-t border-oct-border">
                  {data.solAddress && <AddressRow label="SOL" address={data.solAddress} />}
                  {data.evmAddress && <AddressRow label="EVM" address={data.evmAddress} />}
                </div>
              )}
            </div>

            <div>
              <h3 className="oct-eyebrow mb-2.5">Top holdings</h3>
              {data.holdings.length === 0 ? (
                <p className="text-sm text-oct-muted">No open holdings.</p>
              ) : (
                <ul className="oct-card oct-card-flush divide-y divide-oct-border">
                  {data.holdings.map((holding, idx) => (
                    <li
                      key={`${holding.symbol}-${idx}`}
                      className="flex items-center gap-3 px-4 py-3 oct-row-hover"
                    >
                      <span className="text-[15px] font-bold text-oct-text truncate flex-1 min-w-0">
                        {holding.symbol}
                      </span>
                      <div className="shrink-0 text-right font-mono text-[13px] tabular-nums">
                        <div className="text-oct-text">{compactUsd(holding.valueUsd)}</div>
                        <div className={pnlClass(holding.pnlUsd)}>{signedUsd(holding.pnlUsd)}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
