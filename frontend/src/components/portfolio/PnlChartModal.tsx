import { useEffect } from 'react';
import { X } from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { DailyPnlResponse } from '../../types/portfolio';
import { formatUsd } from '../../types/portfolio';

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
        className="bg-oct-surface border-2 border-oct-accent/40 shadow-oct-hard-lg w-full max-w-3xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b-2 border-oct-accent/30 bg-oct-accent/[0.06] flex items-center justify-between gap-3">
          <div>
            <h3 className="font-display text-2xl text-white tracking-tight">PnL Chart</h3>
            <p className="font-mono text-[10px] text-white/50 mt-1">
              {data?.note ?? 'Trade-based cumulative daily PnL'}
            </p>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-oct-muted hover:text-white">
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
            <div className="h-full flex items-center justify-center font-mono text-xs text-red-400">{error}</div>
          )}
          {!loading && !error && chartData.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center gap-2 font-mono text-xs text-white/50 text-center px-6">
              <p>No classified buy/sell activity in this period.</p>
              <p className="text-white/35">Chart uses trades from the activity feed below — wait for activity to load, or pick one wallet if rate limited.</p>
              {data?.skippedUnknownType ? (
                <p className="text-oct-accent/80">
                  {data.skippedUnknownType} trades could not be classified — GMGN may not label buy/sell on this chain.
                </p>
              ) : null}
            </div>
          )}
          {!loading && !error && chartData.length > 0 && (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#333" strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fill: '#888', fontSize: 10 }} />
                <YAxis
                  tick={{ fill: '#888', fontSize: 10 }}
                  tickFormatter={(v) => formatUsd(v, { signed: true })}
                  width={72}
                />
                <Tooltip
                  formatter={(value: number) => [formatUsd(value, { signed: true }), 'Cumulative']}
                  labelFormatter={(label) => `Date: ${label}`}
                  contentStyle={{ background: '#111', border: '2px solid #000', fontFamily: 'monospace', fontSize: 11 }}
                />
                <Line type="monotone" dataKey="cumulativePnl" stroke="#ff3b3b" strokeWidth={2} dot={{ r: 3, fill: '#ff3b3b' }} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}
