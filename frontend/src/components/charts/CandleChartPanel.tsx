import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { useCandles } from '../../hooks/useCandles';
import type { CandleTimeframe } from '../../lib/candlesApi';
import { summarise, toCandlePoints } from '../../lib/candleSeries';
import { cn } from '../../lib/utils';
import { fadeIn, m, MotionFeatures, useTransition } from '../../lib/motion';

// The chrome around the candlestick chart: timeframe switch, headline price and
// change, source chip, and every non-data state. The canvas itself is a separate
// lazy module (CandleChart) so `lightweight-charts` is fetched on first render of
// THIS panel — which only happens after a user action — and never sooner.
//
// Motion: the panel container fades in once when it mounts. That is chrome. The
// candles inside never animate beyond what the library draws natively.

const CandleChart = lazy(() => import('./CandleChart'));

const TIMEFRAMES: { id: CandleTimeframe; label: string }[] = [
  { id: '1m', label: '1m' },
  { id: '1h', label: '1h' },
];

const SOURCE_LABEL = { pinax: 'Pinax', geckoterminal: 'GeckoTerminal' } as const;

interface CandleChartPanelProps {
  /** GeckoTerminal network id or OCT chain slug — `solana`/`sol`, `bsc`/`bnb`, `robinhood`. */
  network: string;
  address: string;
  /** Shown in the header when known; otherwise the pool's own symbol, then nothing. */
  symbol?: string | null;
  className?: string;
}

function formatPrice(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  // Sub-dollar: three significant figures past the leading zeros, same rule as the axis.
  return n.toLocaleString('en-US', { maximumSignificantDigits: 3, maximumFractionDigits: 10 });
}

function formatChange(f: number | null): string {
  if (f === null || !Number.isFinite(f)) return '—';
  const pct = f * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(Math.abs(pct) >= 100 ? 0 : 1)}%`;
}

export default function CandleChartPanel({ network, address, symbol, className }: CandleChartPanelProps) {
  const [timeframe, setTimeframe] = useState<CandleTimeframe>('1m');
  const { data, loading, error, retryable, refresh } = useCandles(network, address, timeframe);
  const transition = useTransition('fade');

  const summary = useMemo(() => (data ? summarise(toCandlePoints(data.candles)) : null), [data]);
  const up = summary?.change != null && summary.change >= 0;
  const title = symbol ?? data?.pool.symbol ?? null;

  return (
    <MotionFeatures>
      <m.section
        variants={fadeIn}
        initial="hidden"
        animate="visible"
        transition={transition}
        className={cn('oct-card oct-card-flush flex flex-col', className)}
      >
        <header className="flex items-center gap-comfy px-comfy py-cozy border-b border-oct-border">
          <div className="flex items-baseline gap-cozy min-w-0">
            {title && <span className="type-title text-oct-text truncate">{title}</span>}
            {summary ? (
              <>
                <span className="type-data text-sm text-oct-text">${formatPrice(summary.last)}</span>
                <span className={cn('type-data', up ? 'text-oct-good' : 'text-oct-critical')}>
                  {formatChange(summary.change)}
                </span>
              </>
            ) : (
              <span className="type-data text-oct-muted">{loading ? 'Loading…' : '—'}</span>
            )}
          </div>

          <div className="ml-auto flex items-center gap-cozy">
            {data && <span className="oct-chip">{SOURCE_LABEL[data.source]}</span>}
            <div role="tablist" aria-label="Timeframe" className="inline-flex rounded-oct-sm border border-oct-border overflow-hidden">
              {TIMEFRAMES.map((tf) => (
                <button
                  key={tf.id}
                  type="button"
                  role="tab"
                  aria-selected={timeframe === tf.id}
                  onClick={() => setTimeframe(tf.id)}
                  className={cn(
                    'type-label px-cozy py-hair transition-colors',
                    timeframe === tf.id
                      ? 'bg-oct-surface-raised text-oct-text'
                      : 'text-oct-muted hover:text-oct-text',
                  )}
                >
                  {tf.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={refresh}
              disabled={loading}
              aria-label="Refresh candles"
              className="oct-icon-btn p-tight"
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            </button>
          </div>
        </header>

        {/* Fixed height so the canvas has a box to autosize into and the layout
            does not jump between the loading and loaded states. */}
        <div className="relative h-[320px]">
          {data && data.candles.length > 0 ? (
            <Suspense fallback={<ChartNotice>Loading chart…</ChartNotice>}>
              <CandleChart candles={data.candles} timeframe={timeframe} className="absolute inset-0" />
            </Suspense>
          ) : error ? (
            <ChartNotice tone={retryable ? 'muted' : 'critical'}>
              {error}
              {retryable && ' Retrying on the next refresh.'}
            </ChartNotice>
          ) : loading ? (
            <ChartNotice>Loading candles…</ChartNotice>
          ) : (
            <ChartNotice>No candles for this token.</ChartNotice>
          )}
        </div>
      </m.section>
    </MotionFeatures>
  );
}

function ChartNotice({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'critical' }) {
  return (
    <div
      className={cn(
        'absolute inset-0 flex items-center justify-center type-data text-center px-comfy',
        tone === 'critical' ? 'text-oct-critical' : 'text-oct-muted',
      )}
    >
      {children}
    </div>
  );
}
