import { useEffect } from 'react';
import { X } from 'lucide-react';
import PnlLineChart from './PnlLineChart';
import type { DailyPnlResponse } from '../../types/portfolio';
import { formatPortfolioError } from '../../types/portfolio';

interface PnlChartModalProps {
  open: boolean;
  onClose: () => void;
  data: DailyPnlResponse | null;
  loading: boolean;
  error: string | null;
}

export default function PnlChartModal({ open, onClose, data, loading, error }: PnlChartModalProps) {
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open) return null;

  const chartData = (data?.cumulative ?? []).map((row) => ({
    date: row.date.slice(5),
    cumulativePnl: row.cumulativePnl,
  }));

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div
        className="oct-card oct-card-flush shadow-oct-soft-lg w-full max-w-3xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="oct-headerbar px-5 py-4 flex items-center justify-between gap-3">
          <div>
            <h3 className="font-display text-2xl text-oct-text tracking-tight">PnL Chart</h3>
            <p className="font-mono text-[11px] text-oct-muted mt-1">
              {data?.note ?? 'Trade-based cumulative daily PnL'}
            </p>
          </div>
          <button type="button" onClick={onClose} className="oct-icon-btn p-1.5">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 h-[360px]">
          {loading && (
            <div className="h-full flex items-center justify-center font-mono text-xs text-oct-muted">
              Loading chart…
            </div>
          )}
          {!loading && error && (
            <div className="h-full flex items-center justify-center font-mono text-xs text-oct-flame">{formatPortfolioError(error)}</div>
          )}
          {!loading && !error && chartData.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center gap-2 font-mono text-xs text-oct-muted text-center px-6">
              <p>No classified buy/sell activity in this period.</p>
              <p className="text-oct-muted/70">Chart uses trades from the activity feed below — wait for activity to load, or pick one wallet if rate limited.</p>
              {data?.skippedUnknownType ? (
                <p className="text-oct-accent">
                  {data.skippedUnknownType} trades could not be classified as buy/sell on this chain.
                </p>
              ) : null}
            </div>
          )}
          {!loading && !error && chartData.length > 0 && <PnlLineChart data={chartData} />}
        </div>
      </div>
    </div>
  );
}
