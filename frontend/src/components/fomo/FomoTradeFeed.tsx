import { useMemo, useState } from 'react';
import { Activity, ArrowDownRight, ArrowUpRight, Radio } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { fomoTradeDisplay, filterFomoTradesBySide, type FomoSideFilter } from '../../utils/fomoTradeDisplay';
import ChainIcon from '../common/ChainIcon';
import type { FomoTrade } from '../../types/fomo';

const SIDE_FILTER_STORAGE_KEY = 'oct.fomo.sideFilter';
const SIDE_FILTERS: { value: FomoSideFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'buy', label: 'Buys' },
  { value: 'sell', label: 'Sells' },
];

function loadSideFilter(): FomoSideFilter {
  try {
    const v = localStorage.getItem(SIDE_FILTER_STORAGE_KEY);
    return v === 'buy' || v === 'sell' ? v : 'all';
  } catch {
    return 'all';
  }
}

function saveSideFilter(value: FomoSideFilter): void {
  try {
    localStorage.setItem(SIDE_FILTER_STORAGE_KEY, value);
  } catch {
    /* ignore */
  }
}

function formatUsd(value: number | null): string {
  if (value == null) return '—';
  if (Math.abs(value) >= 1000) return `$${Math.round(value).toLocaleString()}`;
  return `$${value.toFixed(2)}`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function traderLabel(trade: FomoTrade): string {
  if (trade.displayName) return trade.displayName;
  if (trade.fomoHandle) return `@${trade.fomoHandle}`;
  return 'Unknown trader';
}

function SideFilterToggle({
  value,
  onChange,
  compact = false,
}: {
  value: FomoSideFilter;
  onChange: (value: FomoSideFilter) => void;
  compact?: boolean;
}) {
  return (
    <div className="flex gap-1">
      {SIDE_FILTERS.map((f) => (
        <button
          key={f.value}
          type="button"
          onClick={() => onChange(f.value)}
          className={`${compact ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-[11px]'} rounded-oct-sm font-mono font-bold border transition-all ${
            value === f.value
              ? 'bg-oct-accent text-white border-oct-accent/50 shadow-oct-glow-accent'
              : 'text-oct-muted border-transparent hover:border-oct-border-bright hover:text-oct-text'
          }`}
        >
          {f.label.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

export default function FomoTradeFeed({ embedded = false }: { embedded?: boolean }) {
  const fomoTrades = useAppStore((s) => s.fomoTrades);
  const clearFomoTrades = useAppStore((s) => s.clearFomoTrades);
  const [sideFilter, setSideFilter] = useState<FomoSideFilter>(loadSideFilter);

  const handleSideFilterChange = (value: FomoSideFilter) => {
    setSideFilter(value);
    saveSideFilter(value);
  };

  const filteredTrades = useMemo(
    () => filterFomoTradesBySide(fomoTrades, sideFilter),
    [fomoTrades, sideFilter],
  );

  return (
    <div className={`flex flex-col min-h-0 overflow-hidden h-full ${embedded ? '' : 'oct-card oct-card-flush'}`}>
      {!embedded && (
      <div className="oct-headerbar shrink-0 flex flex-wrap items-center gap-2 px-4 py-3">
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="animate-pulse-live absolute inline-flex h-full w-full rounded-full bg-oct-accent" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-oct-accent" />
        </span>
        <Radio size={16} className="text-oct-accent" />
        <h2 className="oct-section-title uppercase tracking-wide">Live Trade Feed</h2>
        <span className="oct-chip tabular-nums">{fomoTrades.length}</span>
        <SideFilterToggle value={sideFilter} onChange={handleSideFilterChange} />
        <div className="flex-1" />
        {fomoTrades.length > 0 && (
          <button
            type="button"
            onClick={clearFomoTrades}
            className="text-xs font-bold uppercase tracking-wide text-oct-muted hover:text-oct-text transition-colors"
          >
            Clear
          </button>
        )}
      </div>
      )}
      {embedded && fomoTrades.length > 0 && (
        <div className="shrink-0 flex items-center justify-between gap-2 px-2 py-1 border-b border-oct-border">
          <SideFilterToggle value={sideFilter} onChange={handleSideFilterChange} compact />
          <button
            type="button"
            onClick={clearFomoTrades}
            className="text-[10px] font-bold uppercase text-oct-muted hover:text-oct-text shrink-0"
          >
            Clear
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto overscroll-contain" style={{ overflowAnchor: 'none' }}>
        {fomoTrades.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
            <div className="w-14 h-14 rounded-oct-lg border border-oct-border bg-gradient-to-b from-oct-elevated to-oct-surface shadow-oct-soft flex items-center justify-center mb-4">
              <Activity size={24} className="text-oct-muted" />
            </div>
            <p className="text-oct-text font-bold uppercase tracking-wide mb-1.5">Waiting for activity</p>
            <p className="text-sm text-oct-muted max-w-xs leading-relaxed">
              Trades from the traders you track appear here live, and the last 24 hours
              are replayed when you open the console.
            </p>
          </div>
        ) : filteredTrades.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
            <p className="text-oct-text font-bold uppercase tracking-wide mb-1.5">No matching trades</p>
            <p className="text-sm text-oct-muted max-w-xs leading-relaxed">
              Nothing matches the {sideFilter === 'buy' ? 'Buys' : 'Sells'} filter yet. Switch back to All to see everything.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-oct-border">
            {filteredTrades.map((trade) => (
              <FomoTradeRow key={trade.key} trade={trade} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function FomoTradeRow({ trade }: { trade: FomoTrade }) {
  const config = useAppStore((s) => s.config);
  const isBuy = trade.side === 'buy';
  const isSell = trade.side === 'sell';
  const sideColor = isBuy ? 'text-oct-green' : isSell ? 'text-oct-flame' : 'text-oct-muted';
  const SideIcon = isSell ? ArrowDownRight : ArrowUpRight;
  const sideLabel = trade.side ? trade.side.toUpperCase() : 'TRADE';

  // Symbol is the headline; the address stays visible as secondary context so a
  // token is always identifiable even before enrichment resolves a symbol.
  const { tokenLabel, tokenName, marketCapLabel, shortAddress, address, chartUrl, hasSymbol } =
    fomoTradeDisplay(trade, config?.contractLinkTemplates);
  const tokenTitle = [tokenName, address].filter(Boolean).join(' · ') || undefined;

  return (
    <li className="flex items-center gap-3 px-4 py-3 oct-row-hover">
      <span className={`inline-flex items-center gap-1 shrink-0 w-16 font-extrabold uppercase text-[13px] ${sideColor}`}>
        <SideIcon size={14} strokeWidth={2.5} />
        {sideLabel}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-bold text-oct-text truncate">{traderLabel(trade)}</div>
        <div className="flex items-center gap-1.5 text-xs text-oct-muted min-w-0">
          <ChainIcon networkId={trade.networkId} />
          {chartUrl ? (
            <a
              href={chartUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              title={tokenTitle}
              className="font-mono font-bold text-oct-text hover:text-oct-accent hover:underline truncate"
            >
              {tokenLabel}
            </a>
          ) : (
            <span className="font-mono font-bold text-oct-text truncate" title={tokenTitle}>
              {tokenLabel}
            </span>
          )}
          {hasSymbol && shortAddress && (
            <span className="font-mono text-oct-muted/70 shrink-0" title={address ?? undefined}>
              {shortAddress}
            </span>
          )}
          {marketCapLabel && (
            <span className="font-mono font-bold text-oct-muted shrink-0" title="Market cap">
              MC {marketCapLabel}
            </span>
          )}
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className="text-[15px] font-mono font-bold text-oct-text tabular-nums">{formatUsd(trade.usdValue)}</div>
        <div className="text-xs text-oct-muted font-mono tabular-nums">{formatTime(trade.occurredAt)}</div>
      </div>
    </li>
  );
}
