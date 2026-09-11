import { useMemo } from 'react';
import { ExternalLink, Layers } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { cn } from '../../lib/utils';
import Chip from '../common/Chip';
import ChainIcon from '../common/ChainIcon';
import {
  EVERYTHING_KINDS,
  mergeEverythingFeed,
  resolveEnabledKinds,
  type EverythingFeedKind,
  type EverythingItem,
} from '../../utils/everythingFeed';
import type { WorkspacePanelConfig } from '../../types/workspace';

// ── Everything feed ──────────────────────────────────────────────────────────
//
// One chronological stream that interleaves every already-detected FOMO +
// pump.fun event: tracked-trader buys/sells, the all-chain 985monitor tape,
// pump.fun callouts (with their thesis) and Robinhood Chain fills. It reads the
// four existing store slices — it never fetches, and never fuses detections
// (the "Signals stay independent" rule): each row keeps its own kind/source, so
// the merge is display interleaving only. The pure merge/normalise/cap/filter
// core lives in utils/everythingFeed.ts and is unit-tested there.
//
// Like the feeds it aggregates, this is a STREAM — rows arrive continuously, so
// nothing animates (the rule at the top of lib/motion.ts), and the sort/merge
// is memoised so a busy tape doesn't re-normalise the whole window per frame.

interface KindMeta {
  label: string;
  /** Badge text/border tone. Buys/sells reuse the console's good/critical PnL colours. */
  badge: string;
}

const KIND_META: Record<EverythingFeedKind, KindMeta> = {
  buy: { label: 'BUY', badge: 'text-oct-good border-oct-good/40' },
  sell: { label: 'SELL', badge: 'text-oct-critical border-oct-critical/40' },
  callout: { label: 'CALL', badge: 'text-oct-accent border-oct-accent/40' },
  tape: { label: 'TAPE', badge: 'text-oct-accent-2 border-oct-accent-2/40' },
  rh: { label: 'RH', badge: 'text-oct-warn border-oct-warn/40' },
};

function formatUsd(value: number | null): string {
  if (value == null) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${Math.round(value).toLocaleString()}`;
  return `$${value.toFixed(2)}`;
}

function formatMc(value: number | null): string | null {
  if (value == null) return null;
  const abs = Math.abs(value);
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${Math.round(value)}`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function shortAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

interface WorkspaceEverythingFeedProps {
  config?: WorkspacePanelConfig;
  onConfigChange?: (config: Partial<WorkspacePanelConfig>) => void;
}

export default function WorkspaceEverythingFeed({ config, onConfigChange }: WorkspaceEverythingFeedProps) {
  const fomoTrades = useAppStore((s) => s.fomoTrades);
  const fomoStreamTrades = useAppStore((s) => s.fomoStreamTrades);
  const pumpCallouts = useAppStore((s) => s.pumpCallouts);
  const robinhoodFills = useAppStore((s) => s.robinhoodFills);

  const enabled = useMemo(
    () => resolveEnabledKinds(config?.everythingKinds),
    [config?.everythingKinds],
  );
  const enabledSet = useMemo(() => new Set(enabled), [enabled]);

  const items = useMemo(
    () =>
      mergeEverythingFeed(
        { fomoTrades, fomoStreamTrades, pumpCallouts, robinhoodFills },
        { enabled },
      ),
    [fomoTrades, fomoStreamTrades, pumpCallouts, robinhoodFills, enabled],
  );

  // Total across all kinds, so the header count doesn't jump when chips narrow.
  const total =
    fomoTrades.length + fomoStreamTrades.length + pumpCallouts.length + robinhoodFills.length;

  const toggleKind = (kind: EverythingFeedKind) => {
    if (!onConfigChange) return;
    const next = enabledSet.has(kind)
      ? enabled.filter((k) => k !== kind)
      : // Re-add in canonical order so the persisted list stays stable.
        EVERYTHING_KINDS.filter((k) => k === kind || enabledSet.has(k));
    onConfigChange({ everythingKinds: next });
  };

  return (
    <div className="flex flex-col min-h-0 overflow-hidden h-full">
      <div className="shrink-0 flex items-center gap-tight flex-wrap px-cozy py-tight border-b border-oct-border">
        <Layers size={13} className="text-oct-accent-2 shrink-0" />
        <Chip>{total}</Chip>
        <div className="flex gap-tight flex-wrap">
          {EVERYTHING_KINDS.map((kind) => {
            const on = enabledSet.has(kind);
            return (
              <button
                key={kind}
                type="button"
                onClick={() => toggleKind(kind)}
                aria-pressed={on}
                title={on ? `Hide ${KIND_META[kind].label}` : `Show ${KIND_META[kind].label}`}
                className={cn(
                  'px-snug py-hair rounded-oct-sm type-caption font-mono font-bold border transition-all duration-fast',
                  on
                    ? cn('bg-oct-surface-raised', KIND_META[kind].badge)
                    : 'text-oct-muted border-transparent hover:border-oct-border-bright hover:text-oct-text opacity-60',
                )}
              >
                {KIND_META[kind].label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto overscroll-contain" style={{ overflowAnchor: 'none' }}>
        {total === 0 ? (
          <div className="flex flex-col items-center justify-center py-gutter px-section text-center">
            <div className="w-12 h-12 rounded-oct-lg border border-oct-border bg-oct-surface-raised flex items-center justify-center mb-comfy">
              <Layers size={20} className="text-oct-muted" />
            </div>
            <p className="type-title uppercase tracking-wide text-oct-text mb-tight">Waiting for activity</p>
            <p className="type-body text-oct-muted max-w-xs leading-relaxed">
              Every FOMO buy and sell, the all-chain tape, pump.fun callouts and Robinhood fills land
              here together, newest first, the moment they arrive.
            </p>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-gutter px-section text-center">
            <p className="type-title uppercase tracking-wide text-oct-text mb-tight">Everything hidden</p>
            <p className="type-body text-oct-muted max-w-xs leading-relaxed">
              All filter chips are off. Turn one back on to see its events.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-oct-border">
            {items.map((item) => (
              <EverythingRow key={item.id} item={item} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function EverythingRow({ item }: { item: EverythingItem }) {
  const meta = KIND_META[item.kind];
  const mc = formatMc(item.marketCap);
  const chainLabel = item.chain && item.chain !== 'sol' ? item.chain : null;

  return (
    <li className="flex items-start gap-comfy px-comfy py-snug oct-row-hover">
      <span
        className={cn(
          'shrink-0 mt-hair inline-flex items-center justify-center w-11 rounded-oct-sm border type-caption font-mono font-extrabold',
          meta.badge,
        )}
      >
        {meta.label}
      </span>

      <div className="min-w-0 flex-1">
        <div className="type-body font-bold text-oct-text truncate">{item.handle ?? 'Unknown'}</div>
        <div className="flex items-center gap-snug type-data text-oct-muted min-w-0">
          {item.networkId != null && <ChainIcon networkId={item.networkId} />}
          {item.symbol ? (
            <span className="font-bold text-oct-text truncate" title={item.address ?? undefined}>
              {item.symbol.startsWith('$') ? item.symbol : `$${item.symbol.replace(/^\$/, '')}`}
            </span>
          ) : item.address ? (
            <span className="font-bold text-oct-text truncate" title={item.address}>
              {shortAddress(item.address)}
            </span>
          ) : (
            <span className="text-oct-muted">unknown token</span>
          )}
          {chainLabel && <span className="text-oct-muted/70 shrink-0">{chainLabel}</span>}
          {mc && (
            <span className="font-bold shrink-0" title="Market cap">
              MC {mc}
            </span>
          )}
          {item.multiple != null && item.multiple >= 1.05 && (
            <span className="text-oct-good font-bold shrink-0">{item.multiple.toFixed(2)}×</span>
          )}
        </div>
        {/* Thesis (callouts) / tape comment — untrusted upstream text, rendered
            as text only, never as HTML. */}
        {item.text && (
          <p className="mt-tight type-caption text-oct-text leading-snug whitespace-pre-wrap break-words line-clamp-3">
            {item.text}
          </p>
        )}
      </div>

      <div className="text-right shrink-0 type-data">
        {item.usd != null && <div className="text-sm font-bold text-oct-text">{formatUsd(item.usd)}</div>}
        <div className="text-oct-muted">{formatTime(item.ts)}</div>
      </div>

      {item.txUrl && (
        <a
          href={item.txUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="oct-icon-btn p-snug shrink-0 mt-hair"
          title="Open in explorer"
        >
          <ExternalLink size={12} />
        </a>
      )}
    </li>
  );
}
