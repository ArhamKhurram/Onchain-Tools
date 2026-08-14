import { useState } from 'react';
import { Coins, Search } from 'lucide-react';
import { usePumpToken } from '../../hooks/usePumpToken';
import { isPumpMint, truncateAddress, type PumpCommunity } from '../../types/pumpfun';
import ConsoleEmptyState from '../console/ConsoleEmptyState';
import PumpCalloutList from './PumpCalloutList';
import PumpStateNotice from './PumpStateNotice';

// The per-token view: paste a mint, see its callouts and community summary. Both
// endpoints are KEYED, so without an API key the whole panel is a single "not
// configured" notice rather than an error.
export default function PumpTokenPanel() {
  const [input, setInput] = useState('');
  const [mint, setMint] = useState<string | null>(null);
  const { callouts, community, loading, refresh } = usePumpToken(mint);

  const submit = () => {
    const v = input.trim();
    if (isPumpMint(v)) setMint(v);
  };

  return (
    <div className="h-full min-h-0 flex flex-col bg-oct-bg">
      <div className="oct-headerbar shrink-0 flex items-center gap-2 px-4 py-3">
        <div className="relative flex-1 max-w-md">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-oct-muted" />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="Paste a token mint"
            spellCheck={false}
            className={`oct-input w-full pl-9 pr-2 py-2 font-mono text-xs ${
              input.trim() === '' || isPumpMint(input) ? '' : '!border-oct-flame'
            }`}
          />
        </div>
        <button
          type="button"
          onClick={submit}
          disabled={input.trim() === '' || !isPumpMint(input)}
          className="oct-btn-primary px-4 py-2 text-xs uppercase tracking-wide disabled:opacity-40"
        >
          Look up
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {!mint ? (
          <ConsoleEmptyState
            icon={Coins}
            eyebrow="[ PUMP.FUN · TOKEN ]"
            title="Look up a token"
            description="Paste a mint to see its community callouts and summary. Needs the pump.fun API key configured on the server."
            actionLabel="—"
          />
        ) : (
          <div className="p-4 space-y-4">
            {/* Community summary. */}
            {community.disabled || community.error ? (
              <PumpStateNotice
                disabled={community.disabled}
                error={community.error}
                retryable={community.retryable}
                onRetry={refresh}
                surface="community"
              />
            ) : community.data ? (
              <CommunitySummary community={community.data} mint={mint} />
            ) : (
              <p className="font-mono text-xs text-oct-muted">{loading ? 'Loading…' : 'No community summary.'}</p>
            )}

            {/* Callouts. */}
            <section>
              <h3 className="oct-eyebrow mb-2.5">Callouts</h3>
              {callouts.disabled || callouts.error ? (
                <PumpStateNotice
                  disabled={callouts.disabled}
                  error={callouts.error}
                  retryable={callouts.retryable}
                  onRetry={refresh}
                  surface="callouts"
                />
              ) : callouts.data.length === 0 ? (
                <p className="font-mono text-xs text-oct-muted py-2">
                  {loading ? 'Loading…' : 'No callouts for this token.'}
                </p>
              ) : (
                <div className="oct-card oct-card-flush">
                  {/* Every row here is the one looked-up token, so pass its symbol so
                      each callout shows the ticker, not just the mint. */}
                  <PumpCalloutList callouts={callouts.data} tokenSymbol={community.data?.tokenSymbol} />
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function CommunitySummary({ community, mint }: { community: PumpCommunity; mint: string }) {
  const stats: { label: string; value: string }[] = [
    { label: 'Members', value: fmt(community.memberCount) },
    { label: 'Posts', value: fmt(community.postCount) },
    { label: 'Total likes', value: fmt(community.totalLikes) },
  ];
  return (
    <div className="oct-card p-4">
      <div className="flex items-center gap-2 mb-3.5">
        <span className="font-display text-xl text-oct-text">{community.tokenSymbol ?? truncateAddress(mint)}</span>
        <span className="font-mono text-[11px] text-oct-muted truncate" title={community.tokenAddress ?? mint}>
          {truncateAddress(community.tokenAddress ?? mint)}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {stats.map((s) => (
          <div key={s.label} className="oct-stat-tile">
            <div className="oct-stat-label">{s.label}</div>
            <div className="font-mono text-lg font-semibold text-oct-text mt-1 tabular-nums">{s.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function fmt(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  return n.toLocaleString();
}
