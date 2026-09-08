import { useEffect, useMemo, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, ExternalLink, RefreshCw, Radar, Waves } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useRobinhoodRadar, useRobinhoodStatus } from '../../hooks/useRobinhood';
import { cn } from '../../lib/utils';
import Chip from '../common/Chip';
import type { RobinhoodFillEntry, RobinhoodRadarRow } from '../../types/robinhood';

// ── Robinhood Chain tape (robinhoodtrenches) ─────────────────────────────────
//
// A separate third-party source, not a fomo.family feed. robinhoodtrenches
// indexes Robinhood Chain (4663) directly and has NO Solana or BSC coverage, so
// the scope banner below is permanent and non-dismissible: without it this
// panel reads as all-chain FOMO coverage that it is not.
//
// All strings here come from an untrusted upstream and are rendered as text
// only — never as HTML, and links only from backend-validated http(s) URLs.
//
// Like the FOMO feed this is a STREAM: rows arrive per WebSocket frame, so
// nothing animates (see the rule at the top of lib/motion.ts).

const SCOPE_NOTE = 'Robinhood Chain only (chain 4663) — no Solana or BSC coverage.';

function formatUsd(value: number | null | undefined): string {
  if (value == null) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${Math.round(value).toLocaleString()}`;
  return `$${value.toFixed(2)}`;
}

function formatCount(value: number | null | undefined): string {
  return value == null ? '—' : value.toLocaleString();
}

/** Upstream publishes seconds since epoch. */
function formatClock(tsSeconds: number | null | undefined): string {
  if (!tsSeconds) return '—';
  return new Date(tsSeconds * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatAge(tsSeconds: number | null | undefined): string {
  if (!tsSeconds) return '—';
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - tsSeconds));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function traderLabel(fill: RobinhoodFillEntry): string {
  if (fill.displayName) return fill.displayName;
  if (fill.handle) return `@${fill.handle}`;
  return fill.wallet ? `${fill.wallet.slice(0, 6)}…${fill.wallet.slice(-4)}` : 'Unknown trader';
}

function ScopeBanner() {
  return (
    <div className="shrink-0 px-comfy py-tight border-b border-oct-border bg-oct-surface-2">
      <p className="type-caption text-oct-muted">
        <span className="font-bold text-oct-text">robinhoodtrenches.com</span> · {SCOPE_NOTE} Independent
        third-party source — not fomo.family, and not part of OCT convergence.
      </p>
    </div>
  );
}

function FillRow({ fill }: { fill: RobinhoodFillEntry }) {
  const isBuy = fill.side === 'buy';
  const Arrow = isBuy ? ArrowUpRight : ArrowDownRight;
  return (
    <li className="flex items-center gap-comfy px-comfy py-snug oct-row-hover">
      <Arrow
        size={14}
        className={cn('shrink-0', isBuy ? 'text-oct-good' : 'text-oct-critical')}
        aria-hidden
      />
      <span className="type-data text-oct-muted shrink-0 w-20">{formatClock(fill.ts)}</span>
      <div className="min-w-0 flex-1">
        <div className="type-body font-bold text-oct-text truncate">{traderLabel(fill)}</div>
        <div className="type-caption text-oct-muted truncate">
          {fill.side ? (isBuy ? 'bought' : 'sold') : 'traded'} {fill.symbol ?? 'unknown token'}
          {fill.isStock ? ' (stock token)' : ''}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className={cn('type-data', isBuy ? 'text-oct-good' : 'text-oct-critical')}>
          {formatUsd(fill.usd)}
        </div>
        <div className="type-caption text-oct-muted">
          {fill.liquidity != null ? `LIQ ${formatUsd(fill.liquidity)}` : 'USD'}
        </div>
      </div>
      {fill.pairUrl && (
        <a
          href={fill.pairUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="oct-icon-btn p-snug shrink-0"
          title="Open pair on DexScreener"
        >
          <ExternalLink size={12} />
        </a>
      )}
    </li>
  );
}

function RadarRow({ row }: { row: RobinhoodRadarRow }) {
  return (
    <li className="flex items-center gap-comfy px-comfy py-snug oct-row-hover">
      <div className="min-w-0 flex-1">
        <div className="type-body font-bold text-oct-text truncate">{row.symbol ?? row.token}</div>
        <div className="type-caption text-oct-muted truncate">
          {row.firstBuyer?.handle ? `first: @${row.firstBuyer.handle}` : 'first buyer unknown'} ·{' '}
          {formatAge(row.firstTs)}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="type-data text-oct-text">{formatCount(row.buyers)}</div>
        <div className="type-caption text-oct-muted">buyers</div>
      </div>
      <div className="shrink-0 text-right w-24">
        <div className="type-data text-oct-text">{formatUsd(row.usdIn)}</div>
        <div className="type-caption text-oct-muted">in</div>
      </div>
      {row.pairUrl && (
        <a
          href={row.pairUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="oct-icon-btn p-snug shrink-0"
          title="Open pair on DexScreener"
        >
          <ExternalLink size={12} />
        </a>
      )}
    </li>
  );
}

type RobinhoodMode = 'tape' | 'radar';

export default function RobinhoodTape({ embedded = false }: { embedded?: boolean }) {
  const fills = useAppStore((s) => s.robinhoodFills);
  const available = useAppStore((s) => s.robinhoodAvailable);
  const loadTape = useAppStore((s) => s.loadRobinhoodTape);
  const [mode, setMode] = useState<RobinhoodMode>('tape');
  const { status } = useRobinhoodStatus();
  const radar = useRobinhoodRadar(mode === 'radar');

  // Seed once from REST; live frames continue from there over the existing WS.
  useEffect(() => {
    void loadTape();
  }, [loadTape]);

  const sourceDown = available === false || status?.available === false;
  const statusLine = useMemo(() => {
    if (!status?.upstream) return null;
    const { wallets, trades, lagSeconds } = status.upstream;
    return `${formatCount(wallets)} wallets · ${formatCount(trades)} fills indexed${
      lagSeconds != null ? ` · ${lagSeconds.toFixed(1)}s lag` : ''
    }`;
  }, [status]);

  return (
    <div className={cn('flex flex-col min-h-0 overflow-hidden h-full', !embedded && 'oct-card oct-card-flush')}>
      <div className="oct-headerbar shrink-0 flex flex-wrap items-center gap-cozy px-comfy py-cozy">
        <Waves size={14} className="text-oct-accent-2" />
        <h2 className="type-title uppercase tracking-wide text-oct-text">Robinhood Chain</h2>
        <Chip>{mode === 'tape' ? fills.length : radar.rows.length}</Chip>
        <div className="flex gap-tight">
          {(['tape', 'radar'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                'px-cozy py-tight rounded-oct-sm type-caption font-mono font-bold border transition-all duration-fast',
                mode === m
                  ? 'bg-oct-accent text-white border-oct-accent/50 shadow-oct-glow-accent'
                  : 'text-oct-muted border-transparent hover:border-oct-border-bright hover:text-oct-text',
              )}
            >
              {m === 'tape' ? 'TAPE' : 'RADAR'}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        {statusLine && <span className="type-caption text-oct-muted font-mono">{statusLine}</span>}
        {mode === 'radar' ? (
          <button
            type="button"
            onClick={() => void radar.refresh()}
            disabled={radar.loading}
            className="oct-icon-btn p-snug"
            title="Refresh radar"
          >
            <RefreshCw size={14} className={radar.loading ? 'animate-spin' : ''} />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void loadTape()}
            className="oct-icon-btn p-snug"
            title="Reload tape"
          >
            <RefreshCw size={14} />
          </button>
        )}
      </div>

      <ScopeBanner />

      {sourceDown && (
        <div
          role="status"
          className="m-comfy px-comfy py-cozy rounded-oct border border-oct-warn/50 bg-oct-surface-2 type-body text-oct-muted"
        >
          Source unavailable — robinhoodtrenches.com is not responding. Showing whatever was already
          received; it will fill in on its own when the source returns.
        </div>
      )}

      {status && status.pollerEnabled === false && mode === 'tape' && (
        <div className="m-comfy px-comfy py-cozy rounded-oct border border-oct-border bg-oct-surface-2 type-caption text-oct-muted">
          The live push is switched off on this deployment (OCT_ROBINHOOD_ENABLED), so this tape is a
          point-in-time read rather than a stream. Use reload above.
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto">
        {mode === 'tape' ? (
          fills.length === 0 ? (
            <div className="py-gutter px-section text-center type-body text-oct-muted">
              {available === null ? 'Loading the tape…' : 'No fills yet.'}
            </div>
          ) : (
            <ul className="divide-y divide-oct-border">
              {fills.map((fill) => (
                <FillRow key={fill.key} fill={fill} />
              ))}
            </ul>
          )
        ) : radar.error ? (
          <div
            role="alert"
            className="m-comfy px-comfy py-cozy rounded-oct border border-oct-critical/50 bg-oct-critical-dim type-body text-oct-critical"
          >
            {radar.error}
          </div>
        ) : radar.rows.length === 0 ? (
          <div className="py-gutter px-section text-center type-body text-oct-muted">
            <Radar size={18} className="mx-auto mb-cozy text-oct-muted" />
            {radar.loading ? 'Loading radar…' : 'No fresh tokens on the radar.'}
          </div>
        ) : (
          <ul className="divide-y divide-oct-border">
            {radar.rows.map((row) => (
              <RadarRow key={row.token} row={row} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
