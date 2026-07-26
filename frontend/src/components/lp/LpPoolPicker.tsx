import { useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Eye, Hand, Minus, RefreshCw } from 'lucide-react';
import {
  evaluateVisibleCriteria,
  isInAllowlist,
  poolRowStatus,
  sortCandidates,
  summarizeAllowlist,
  toggleAllowlist,
  type PoolRowStatus,
  type PoolSortKey,
  type SortDir,
} from './selection';
import { formatAprFraction, formatFeeTier, formatUsdCompact, poolPairLabel, shortAddress } from './format';
import { LP_BTN_GHOST, LP_PANEL, LP_PANEL_HEADER, LP_PANEL_TITLE } from './styles';
import type { LpChainSlug, PoolCandidate } from './types';

/**
 * The allowlist picker.
 *
 * The one idea this component exists to communicate: a pool appearing here means
 * a filter let it through, and that is all it means. Admission is the checkbox
 * and nothing else. So every row states its own standing in words, an unticked
 * row is visibly inert no matter how good its numbers are, and the counters at
 * the top read "N surfaced → M admitted" rather than a single ambiguous total.
 */

const STATUS_META: Record<PoolRowStatus, { label: string; hint: string; className: string }> = {
  allowlisted: {
    label: 'Allowlisted',
    hint: 'Saved. The automation may enter this pool.',
    className: 'border-oct-accent text-oct-accent bg-oct-accent-dim',
  },
  pending_add: {
    label: 'Unsaved tick',
    hint: 'Not in force until you save.',
    className: 'border-oct-yellow text-oct-yellow bg-oct-surface-raised',
  },
  pending_remove: {
    label: 'Unsaved removal',
    hint: 'Still in force until you save.',
    className: 'border-oct-yellow text-oct-yellow bg-oct-surface-raised',
  },
  surfaced: {
    label: 'Surfaced only',
    hint: 'Meets the criteria. Not admitted — the automation ignores it.',
    className: 'border-oct-border-bright text-oct-muted bg-transparent',
  },
};

function StatusBadge({ status }: { status: PoolRowStatus }) {
  const meta = STATUS_META[status];
  return (
    <span
      title={meta.hint}
      className={`inline-flex items-center gap-1 border font-mono text-[9px] uppercase tracking-[0.1em] px-1.5 py-0.5 whitespace-nowrap ${meta.className}`}
    >
      {status === 'surfaced' ? <Eye size={9} strokeWidth={2.5} /> : <Check size={9} strokeWidth={3} />}
      {meta.label}
    </span>
  );
}

function SortHeader({
  label,
  sortKey,
  activeKey,
  dir,
  onSort,
  align = 'left',
}: {
  label: string;
  sortKey: PoolSortKey;
  activeKey: PoolSortKey;
  dir: SortDir;
  onSort: (key: PoolSortKey) => void;
  align?: 'left' | 'right';
}) {
  const active = activeKey === sortKey;
  return (
    <th className={`px-3 py-2 font-medium ${align === 'right' ? 'text-right' : ''}`}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 uppercase tracking-wider transition-colors ${
          align === 'right' ? 'flex-row-reverse ml-auto' : ''
        } ${active ? 'text-oct-accent' : 'text-oct-muted hover:text-oct-text'}`}
      >
        <span>{label}</span>
        <span className={`inline-flex flex-col -space-y-1 shrink-0 ${active ? 'text-oct-accent' : 'text-oct-muted'}`}>
          <ChevronUp size={10} strokeWidth={2.5} className={active && dir === 'asc' ? 'opacity-100' : 'opacity-35'} />
          <ChevronDown size={10} strokeWidth={2.5} className={active && dir === 'desc' ? 'opacity-100' : 'opacity-35'} />
        </span>
      </button>
    </th>
  );
}

interface LpPoolPickerProps {
  candidates: PoolCandidate[];
  loading: boolean;
  error: string | null;
  unavailable: boolean;
  /** Pools discovery could not parse — shown so a shrinking shortlist is explicable. */
  skippedCount: number;
  chain: LpChainSlug;
  minTvlUsd: number;
  min24hVolumeUsd: number;
  /** The allowlist being edited. */
  draftAllowlist: string[];
  /** The allowlist as persisted — the difference is what "unsaved" means. */
  savedAllowlist: string[];
  onChangeAllowlist: (next: string[]) => void;
  onRefresh: () => void;
  disabled?: boolean;
}

export default function LpPoolPicker({
  candidates,
  loading,
  error,
  unavailable,
  skippedCount,
  chain,
  minTvlUsd,
  min24hVolumeUsd,
  draftAllowlist,
  savedAllowlist,
  onChangeAllowlist,
  onRefresh,
  disabled = false,
}: LpPoolPickerProps) {
  const [sortKey, setSortKey] = useState<PoolSortKey>('tvl');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const summary = useMemo(
    () => summarizeAllowlist(candidates, draftAllowlist, savedAllowlist),
    [candidates, draftAllowlist, savedAllowlist],
  );

  const rows = useMemo(
    () => sortCandidates(candidates, sortKey, sortDir, draftAllowlist, savedAllowlist),
    [candidates, sortKey, sortDir, draftAllowlist, savedAllowlist],
  );

  const handleSort = (key: PoolSortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'pair' || key === 'status' ? 'asc' : 'desc');
    }
  };

  const toggle = (address: string) => {
    if (disabled) return;
    onChangeAllowlist(toggleAllowlist(draftAllowlist, address));
  };

  return (
    <section className={`${LP_PANEL} flex flex-col min-h-0`}>
      <div className={LP_PANEL_HEADER}>
        <div className="flex items-center gap-2 min-w-0">
          <Hand size={14} strokeWidth={2} className="text-oct-accent shrink-0" />
          <h3 className={LP_PANEL_TITLE}>Pool allowlist</h3>
        </div>
        <div className="flex items-center gap-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-oct-muted">
            <span className="text-oct-text">{summary.surfacedCount}</span> surfaced
            <span className="mx-1.5 text-oct-muted">→</span>
            <span className="text-oct-accent">{summary.selectedCount}</span> admitted
          </p>
          <button type="button" onClick={onRefresh} className={LP_BTN_GHOST} title="Re-run discovery">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            Rescan
          </button>
        </div>
      </div>

      {/* The rule, stated once, above the data it governs. */}
      <div className="px-4 py-3 border-b-2 border-oct-border bg-oct-accent-dim">
        <p className="font-mono text-[11px] leading-relaxed text-oct-text">
          <span className="text-oct-accent font-semibold uppercase tracking-[0.1em]">Surfacing is not admission.</span>{' '}
          A pool listed here passed the criteria — that is the entire meaning of it being here. The automation may only
          enter a pool whose box is ticked and saved. A pool that clears every filter and stays unticked is ignored
          forever, on purpose.
        </p>
        {summary.ignoredCount > 0 && !loading && (
          <p className="font-mono text-[11px] text-oct-muted mt-1.5">
            {summary.ignoredCount} of {summary.surfacedCount} listed pool{summary.ignoredCount === 1 ? '' : 's'}{' '}
            meet{summary.ignoredCount === 1 ? 's' : ''} every filter and {summary.ignoredCount === 1 ? 'is' : 'are'}{' '}
            deliberately not admitted.
          </p>
        )}
      </div>

      {skippedCount > 0 && (
        <p className="px-4 py-2 border-b-2 border-oct-border font-mono text-[11px] text-oct-yellow">
          {skippedCount} pool{skippedCount === 1 ? '' : 's'} returned by discovery could not be read and {skippedCount === 1 ? 'is' : 'are'}{' '}
          not listed. A shortlist can shrink because upstream data changed shape, not because the chain did.
        </p>
      )}

      {(summary.pendingAdds > 0 || summary.pendingRemovals > 0) && (
        <p className="px-4 py-2 border-b-2 border-oct-border bg-oct-surface-raised font-mono text-[11px] text-oct-text">
          Unsaved: {summary.pendingAdds} pool{summary.pendingAdds === 1 ? '' : 's'} to admit,{' '}
          {summary.pendingRemovals} to remove. The signer still reads the saved allowlist until you save.
        </p>
      )}

      {unavailable && (
        <p className="px-4 py-6 font-mono text-xs text-oct-muted text-center">
          Pool discovery is not available on this backend yet.
        </p>
      )}

      {error && !unavailable && (
        <div className="px-4 py-3 font-mono text-xs text-oct-flame flex items-center justify-between gap-3">
          <span>{error}</span>
          <button type="button" onClick={onRefresh} className="text-oct-accent underline hover:no-underline">
            Retry
          </button>
        </div>
      )}

      {loading && candidates.length === 0 && !error && (
        <div className="px-4 py-6 space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-9 border-2 border-oct-border bg-oct-surface-raised animate-pulse" />
          ))}
        </div>
      )}

      {!loading && !error && !unavailable && candidates.length === 0 && (
        <div className="px-4 py-8 text-center">
          <p className="font-mono text-sm text-oct-text">No pool currently meets the criteria.</p>
          <p className="font-mono text-[11px] text-oct-muted mt-2 max-w-md mx-auto leading-relaxed">
            Nothing to admit, so nothing can be entered. On a four-week-old chain an empty shortlist is a fact about
            the chain, not a fault — lower Min TVL or Min 24h volume above if you want a wider look.
          </p>
        </div>
      )}

      {candidates.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left font-mono text-xs">
            <thead className="border-b-2 border-oct-border bg-oct-surface-raised text-oct-muted uppercase tracking-[0.1em]">
              <tr>
                <th className="px-3 py-2 w-10">
                  <span className="sr-only">Admit</span>
                </th>
                <SortHeader label="Pool" sortKey="pair" activeKey={sortKey} dir={sortDir} onSort={handleSort} />
                <SortHeader label="Status" sortKey="status" activeKey={sortKey} dir={sortDir} onSort={handleSort} />
                <SortHeader label="TVL" sortKey="tvl" activeKey={sortKey} dir={sortDir} onSort={handleSort} align="right" />
                <SortHeader label="24h vol" sortKey="volume" activeKey={sortKey} dir={sortDir} onSort={handleSort} align="right" />
                <SortHeader label="Fee tier" sortKey="fee" activeKey={sortKey} dir={sortDir} onSort={handleSort} align="right" />
                <SortHeader label="Fee APR" sortKey="apr" activeKey={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              </tr>
            </thead>
            <tbody>
              {rows.map((pool) => {
                const status = poolRowStatus(pool.address, draftAllowlist, savedAllowlist);
                const ticked = isInAllowlist(draftAllowlist, pool.address);
                const failures = evaluateVisibleCriteria(pool, chain, { minTvlUsd, min24hVolumeUsd });
                const inert = status === 'surfaced';

                return (
                  <tr
                    key={pool.address}
                    onClick={() => toggle(pool.address)}
                    className={[
                      'border-b border-oct-border cursor-pointer transition-colors',
                      ticked ? 'bg-oct-accent-dim' : 'hover:bg-oct-surface-raised',
                    ].join(' ')}
                  >
                    {/* A solid accent rail marks admitted rows; unticked rows get
                        nothing, so the two are distinguishable at a glance from
                        across the table rather than by reading a checkbox. */}
                    <td
                      className={`px-3 py-2.5 border-l-4 ${ticked ? 'border-l-oct-accent' : 'border-l-transparent'}`}
                    >
                      <label
                        className="inline-flex items-center cursor-pointer"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          className="sr-only peer"
                          checked={ticked}
                          disabled={disabled}
                          onChange={() => toggle(pool.address)}
                          aria-label={`Admit ${poolPairLabel(pool)} to the allowlist`}
                        />
                        <span
                          className={`w-4 h-4 border-2 flex items-center justify-center transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-oct-accent ${
                            ticked
                              ? 'border-oct-accent bg-oct-accent text-white'
                              : 'border-oct-border-bright bg-oct-bg text-transparent'
                          }`}
                        >
                          <Check size={11} strokeWidth={3.5} />
                        </span>
                      </label>
                    </td>

                    <td className="px-3 py-2.5">
                      <p className={`font-semibold ${inert ? 'text-oct-muted' : 'text-oct-text'}`}>
                        {poolPairLabel(pool)}
                      </p>
                      <p className="text-[10px] text-oct-muted mt-0.5">
                        {pool.platform || 'unknown dex'} · {shortAddress(pool.address)}
                      </p>
                      {failures.length > 0 && (
                        <p className="text-[10px] text-oct-yellow mt-0.5">
                          No longer meets: {failures.join(', ')}
                        </p>
                      )}
                    </td>

                    <td className="px-3 py-2.5">
                      <StatusBadge status={status} />
                    </td>

                    <td className={`px-3 py-2.5 text-right tabular-nums ${inert ? 'text-oct-muted' : 'text-oct-text'}`}>
                      {formatUsdCompact(pool.tvlUsd)}
                    </td>
                    <td className={`px-3 py-2.5 text-right tabular-nums ${inert ? 'text-oct-muted' : 'text-oct-text'}`}>
                      {formatUsdCompact(pool.volume24hUsd)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-oct-muted">
                      {formatFeeTier(pool.feeTierBps)}
                    </td>
                    <td className={`px-3 py-2.5 text-right tabular-nums ${inert ? 'text-oct-muted' : 'text-oct-text'}`}>
                      {formatAprFraction(pool.feeApr)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {summary.allowlistedOffScreen.length > 0 && (
        <div className="px-4 py-3 border-t-2 border-oct-border bg-oct-surface-raised">
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-oct-yellow mb-1.5">
            Allowlisted but not in the current shortlist
          </p>
          <p className="font-mono text-[11px] text-oct-muted leading-relaxed mb-2">
            These pools remain fully admitted — a pool can stop meeting the criteria without leaving the allowlist.
            Untick one to remove it.
          </p>
          <ul className="space-y-1">
            {summary.allowlistedOffScreen.map((address) => (
              <li key={address} className="flex items-center justify-between gap-3">
                <span className="font-mono text-[11px] text-oct-text">{shortAddress(address)}</span>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onChangeAllowlist(toggleAllowlist(draftAllowlist, address))}
                  className="font-mono text-[10px] uppercase tracking-[0.1em] text-oct-muted hover:text-oct-flame inline-flex items-center gap-1 disabled:opacity-40"
                >
                  <Minus size={10} strokeWidth={3} />
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="px-4 py-2.5 border-t-2 border-oct-border flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {(['allowlisted', 'surfaced', 'pending_add'] as PoolRowStatus[]).map((status) => (
          <span key={status} className="inline-flex items-center gap-1.5">
            <StatusBadge status={status} />
            <span className="font-mono text-[10px] text-oct-muted">{STATUS_META[status].hint}</span>
          </span>
        ))}
      </div>
    </section>
  );
}
