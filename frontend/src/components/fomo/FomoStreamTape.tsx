import { useEffect, useMemo, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, ExternalLink, MessageSquareQuote, RefreshCw, Waves } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useFomoStreamStatus } from '../../hooks/useFomoStream';
import { cn } from '../../lib/utils';
import Chip from '../common/Chip';
import type { FomoStreamTradeEntry } from '../../types/fomoStream';

// ── All-chain FOMO tape (985monitor.xyz) ─────────────────────────────────────
//
// A third party's re-broadcast of fomo.family activity — NOT OCT's own
// fomo.family feed, and not the blocked service account restored. The scope
// banner below is permanent and non-dismissible for exactly that reason: it is
// the only thing separating "OCT sees every FOMO trade" from the truth, which
// is "985monitor sees them and we are reading over its shoulder".
//
// All strings here come from an untrusted upstream and are rendered as text
// only — never as HTML — and links and images only from backend-validated
// http(s) URLs (see backend/src/utils/untrusted.ts).
//
// Like the FOMO feed this is a STREAM: rows arrive per WebSocket frame, so
// nothing animates (see the rule at the top of lib/motion.ts).

const SCOPE_NOTE =
  'Third-party re-broadcast of fomo.family activity — not OCT’s own fomo.family feed, and not part of OCT convergence.';

type SideFilter = 'all' | 'buy' | 'sell' | 'thesis';

const SIDE_FILTERS: { value: SideFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'buy', label: 'Buys' },
  { value: 'sell', label: 'Sells' },
  { value: 'thesis', label: 'Theses' },
];

function formatUsd(value: number | null): string {
  if (value == null) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${Math.round(value).toLocaleString()}`;
  return `$${value.toFixed(2)}`;
}

function formatCount(value: number | null | undefined): string {
  return value == null ? '—' : value.toLocaleString();
}

/** Upstream publishes epoch ms. */
function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function traderLabel(trade: FomoStreamTradeEntry): string {
  if (trade.displayName) return trade.displayName;
  if (trade.handle) return `@${trade.handle}`;
  return 'Unknown trader';
}

function ScopeBanner() {
  return (
    <div className="shrink-0 px-comfy py-tight border-b border-oct-border bg-oct-surface-2">
      <p className="type-caption text-oct-muted">
        <span className="font-bold text-oct-text">985monitor.xyz</span> · {SCOPE_NOTE}
      </p>
    </div>
  );
}

function TradeRow({ trade }: { trade: FomoStreamTradeEntry }) {
  const isBuy = trade.side === 'buy';
  const isThesis = trade.side === 'thesis';
  const Icon = isThesis ? MessageSquareQuote : isBuy ? ArrowUpRight : ArrowDownRight;
  const tone = isThesis ? 'text-oct-accent-2' : isBuy ? 'text-oct-good' : 'text-oct-critical';
  const verb = isThesis ? 'posted a thesis on' : trade.side ? (isBuy ? 'bought' : 'sold') : 'traded';

  return (
    <li className="flex items-start gap-comfy px-comfy py-snug oct-row-hover">
      <Icon size={14} className={cn('shrink-0 mt-1', tone)} aria-hidden />
      <span className="type-data text-oct-muted shrink-0 w-20 mt-0.5">{formatClock(trade.ts)}</span>
      <div className="min-w-0 flex-1">
        <div className="type-body font-bold text-oct-text truncate">{traderLabel(trade)}</div>
        <div className="type-caption text-oct-muted truncate">
          {verb} {trade.symbol ?? 'unknown token'}
          {trade.chainName ? ` · ${trade.chainName}` : ''}
          {trade.marketCap != null ? ` · MC ${formatUsd(trade.marketCap)}` : ''}
        </div>
        {trade.comment && (
          <p className="type-caption text-oct-muted mt-tight line-clamp-2">{trade.comment}</p>
        )}
      </div>
      <div className="shrink-0 text-right">
        <div className={cn('type-data', tone)}>{isThesis ? '—' : formatUsd(trade.usd)}</div>
        <div className="type-caption text-oct-muted">
          {trade.followers != null ? `${formatCount(trade.followers)} flw` : 'USD'}
        </div>
      </div>
      {trade.txUrl && (
        <a
          href={trade.txUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="oct-icon-btn p-snug shrink-0"
          title="Open transaction in the block explorer"
        >
          <ExternalLink size={12} />
        </a>
      )}
    </li>
  );
}

export default function FomoStreamTape({ embedded = false }: { embedded?: boolean }) {
  const trades = useAppStore((s) => s.fomoStreamTrades);
  const available = useAppStore((s) => s.fomoStreamAvailable);
  const loadTape = useAppStore((s) => s.loadFomoStreamTape);
  const [side, setSide] = useState<SideFilter>('all');
  const { status } = useFomoStreamStatus();

  // Seed once from REST; live frames continue from there over the existing WS.
  useEffect(() => {
    void loadTape();
  }, [loadTape]);

  const visible = useMemo(
    () => (side === 'all' ? trades : trades.filter((t) => t.side === side)),
    [trades, side],
  );

  const listenerOff = status?.listener.enabled === false;
  const sourceDown = !listenerOff && (available === false || status?.listener.connected === false);

  const statusLine = useMemo(() => {
    if (!status?.listener.connected) return null;
    const chains = new Set(trades.map((t) => t.chainName).filter(Boolean));
    return `${formatCount(status.listener.tradesSeen)} events · ${chains.size || '—'} chains · live`;
  }, [status, trades]);

  return (
    <div
      className={cn(
        'flex flex-col min-h-0 overflow-hidden h-full',
        !embedded && 'oct-card oct-card-flush',
      )}
    >
      <div className="oct-headerbar shrink-0 flex flex-wrap items-center gap-cozy px-comfy py-cozy">
        <Waves size={14} className="text-oct-accent-2" />
        <h2 className="type-title uppercase tracking-wide text-oct-text">FOMO Live · All chains</h2>
        <Chip>{visible.length}</Chip>
        <div className="flex gap-tight">
          {SIDE_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setSide(f.value)}
              className={cn(
                'px-cozy py-tight rounded-oct-sm type-caption font-mono font-bold border transition-all duration-fast',
                side === f.value
                  ? 'bg-oct-accent text-white border-oct-accent/50 shadow-oct-glow-accent'
                  : 'text-oct-muted border-transparent hover:border-oct-border-bright hover:text-oct-text',
              )}
            >
              {f.label.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        {statusLine && <span className="type-caption text-oct-muted font-mono">{statusLine}</span>}
        <button
          type="button"
          onClick={() => void loadTape()}
          className="oct-icon-btn p-snug"
          title="Reload tape"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      <ScopeBanner />

      {listenerOff && (
        <div className="m-comfy px-comfy py-cozy rounded-oct border border-oct-border bg-oct-surface-2 type-caption text-oct-muted">
          The live stream is switched off on this deployment (OCT_FOMO_STREAM_ENABLED), so this tape
          stays empty. Nothing is being read from 985monitor.xyz.
        </div>
      )}

      {sourceDown && (
        <div
          role="status"
          className="m-comfy px-comfy py-cozy rounded-oct border border-oct-warn/50 bg-oct-surface-2 type-body text-oct-muted"
        >
          Source unavailable — 985monitor.xyz is not responding. Showing whatever was already
          received; it will fill in on its own when the source returns.
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto">
        {visible.length === 0 ? (
          <div className="py-gutter px-section text-center type-body text-oct-muted">
            {available === null && !listenerOff ? 'Loading the tape…' : 'No trades yet.'}
          </div>
        ) : (
          <ul className="divide-y divide-oct-border">
            {visible.map((trade) => (
              <TradeRow key={trade.key} trade={trade} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
