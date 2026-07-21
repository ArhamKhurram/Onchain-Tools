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
        className="bg-oct-surface border-2 border-black shadow-oct-hard-lg w-full max-w-3xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b-2 border-black flex items-center justify-between gap-3">
          <div>
            <h3 className="font-display text-2xl text-oct-text tracking-tight">PnL Chart</h3>
            <p className="font-mono text-[10px] text-oct-muted mt-1">
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
            <div className="h-full flex items-center justify-center font-mono text-xs text-oct-muted">
              No buy/sell activity in this period.
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
                <Line type="monotone" dataKey="cumulativePnl" stroke="#f97316" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}
