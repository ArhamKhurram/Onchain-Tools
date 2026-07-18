import { Activity, ArrowDownRight, ArrowUpRight, Radio } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import type { FomoTrade } from '../../types/fomo';

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

export default function FomoTradeFeed() {
  const fomoTrades = useAppStore((s) => s.fomoTrades);
  const clearFomoTrades = useAppStore((s) => s.clearFomoTrades);

  return (
    <div className="brutal-card flex flex-col min-h-0 overflow-hidden">
      <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-b-2 border-black bg-oct-surface">
        <Radio size={16} className="text-oct-accent" />
        <h2 className="text-sm font-extrabold uppercase tracking-wide text-oct-text">Live Trade Feed</h2>
        <span className="text-xs font-mono text-oct-muted tabular-nums">{fomoTrades.length}</span>
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

      <div className="flex-1 min-h-0 overflow-auto">
        {fomoTrades.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
            <div className="w-12 h-12 rounded-cockpit border-2 border-black bg-oct-surface-raised shadow-oct-hard flex items-center justify-center mb-4">
              <Activity size={22} className="text-oct-muted" />
            </div>
            <p className="text-oct-text font-bold uppercase mb-1">Waiting for activity</p>
            <p className="text-sm text-oct-muted max-w-xs">
              Trades from the traders you track appear here live while you're connected.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-oct-border">
            {fomoTrades.map((trade) => (
              <FomoTradeRow key={trade.key} trade={trade} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function FomoTradeRow({ trade }: { trade: FomoTrade }) {
  const isBuy = trade.side === 'buy';
  const isSell = trade.side === 'sell';
  const sideColor = isBuy ? 'text-oct-green' : isSell ? 'text-oct-accent' : 'text-oct-muted';
  const SideIcon = isSell ? ArrowDownRight : ArrowUpRight;
  const sideLabel = trade.side ? trade.side.toUpperCase() : 'TRADE';
  const token = trade.tokenSymbol || (trade.tokenAddress ? `${trade.tokenAddress.slice(0, 6)}…` : 'token');

  return (
    <li className="flex items-center gap-3 px-4 py-2.5 hover:bg-oct-surface-raised/60 transition-colors">
      <span className={`inline-flex items-center gap-1 shrink-0 w-16 font-extrabold uppercase text-xs ${sideColor}`}>
        <SideIcon size={14} strokeWidth={2.5} />
        {sideLabel}
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-bold text-oct-text truncate">{traderLabel(trade)}</div>
        <div className="text-xs text-oct-muted truncate">
          <span className="font-mono uppercase">{token}</span>
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className="font-mono font-bold text-oct-text tabular-nums">{formatUsd(trade.usdValue)}</div>
        <div className="text-xs text-oct-muted font-mono tabular-nums">{formatTime(trade.receivedAt)}</div>
      </div>
    </li>
  );
}
