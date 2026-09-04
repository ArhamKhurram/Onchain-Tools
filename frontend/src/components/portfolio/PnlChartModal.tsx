import { useEffect } from 'react';
import { X } from 'lucide-react';
import PnlLineChart from './PnlLineChart';
import type { DailyPnlResponse } from '../../types/portfolio';
import { formatPortfolioError } from '../../types/portfolio';
import { AnimatePresence, fadeIn, fadeInUp, m, MotionFeatures, useTransition } from '../../lib/motion';

interface PnlChartModalProps {
  open: boolean;
  onClose: () => void;
  data: DailyPnlResponse | null;
  loading: boolean;
  error: string | null;
}

export default function PnlChartModal({ open, onClose, data, loading, error }: PnlChartModalProps) {
  const fade = useTransition('fade');
  const rise = useTransition('snappy');

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  const chartData = (data?.cumulative ?? []).map((row) => ({
    date: row.date.slice(5),
    cumulativePnl: row.cumulativePnl,
  }));

  // The modal is chrome, so it may fade. The component stays mounted while
  // closed (the parent keeps it around after the first open) so AnimatePresence
  // can play the exit; the chart itself is rebuilt from `data` on each open and
  // is never animated.
  return (
    <MotionFeatures>
      <AnimatePresence>
        {open && (
          <m.div
            key="pnl-chart-backdrop"
            variants={fadeIn}
            initial="hidden"
            animate="visible"
            exit="hidden"
            transition={fade}
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-roomy"
            onClick={onClose}
          >
            <m.div
              variants={fadeInUp}
              transition={rise}
              className="oct-card oct-card-flush shadow-oct-soft-lg w-full max-w-3xl overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="oct-headerbar px-roomy py-comfy flex items-center justify-between gap-comfy">
                <div>
                  <h3 className="font-display type-heading text-oct-text tracking-tight">PnL Chart</h3>
                  <p className="type-caption font-mono text-oct-muted mt-tight">
                    {data?.note ?? 'Trade-based cumulative daily PnL'}
                  </p>
                </div>
                <button type="button" onClick={onClose} className="oct-icon-btn p-snug" aria-label="Close">
                  <X size={18} />
                </button>
              </div>

              <div className="p-roomy h-[360px]">
                {loading && (
                  <div className="h-full flex items-center justify-center type-body text-oct-muted">
                    Loading chart…
                  </div>
                )}
                {!loading && error && (
                  <div className="h-full flex items-center justify-center type-body text-oct-critical">{formatPortfolioError(error)}</div>
                )}
                {!loading && !error && chartData.length === 0 && (
                  <div className="h-full flex flex-col items-center justify-center gap-cozy type-body text-oct-muted text-center px-section">
                    <p>No classified buy/sell activity in this period.</p>
                    <p className="type-caption text-oct-muted/70">Chart uses trades from the activity feed below — wait for activity to load, or pick one wallet if rate limited.</p>
                    {data?.skippedUnknownType ? (
                      <p className="type-caption text-oct-warn">
                        {data.skippedUnknownType} trades could not be classified as buy/sell on this chain.
                      </p>
                    ) : null}
                  </div>
                )}
                {!loading && !error && chartData.length > 0 && <PnlLineChart data={chartData} />}
              </div>
            </m.div>
          </m.div>
        )}
      </AnimatePresence>
    </MotionFeatures>
  );
}
