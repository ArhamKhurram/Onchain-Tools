import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import type { DailyPnlResponse } from '../../types/portfolio';
import { formatPortfolioError, formatUsd } from '../../types/portfolio';

interface PnlCalendarModalProps {
  open: boolean;
  onClose: () => void;
  data: DailyPnlResponse | null;
  loading: boolean;
  error: string | null;
}

function monthKey(year: number, month: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}`;
}

export default function PnlCalendarModal({ open, onClose, data, loading, error }: PnlCalendarModalProps) {
  const [viewDate, setViewDate] = useState(() => new Date());

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  const dayMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const day of data?.days ?? []) {
      map.set(day.date, day.netPnl);
    }
    return map;
  }, [data?.days]);

  if (!open) return null;

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const startOffset = firstDay.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthLabel = firstDay.toLocaleString(undefined, { month: 'long', year: 'numeric' });

  const cells: Array<{ date: string | null; netPnl: number | null }> = [];
  for (let i = 0; i < startOffset; i += 1) cells.push({ date: null, netPnl: null });
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${monthKey(year, month)}-${String(day).padStart(2, '0')}`;
    cells.push({ date, netPnl: dayMap.get(date) ?? null });
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div
        className="oct-card oct-card-flush shadow-oct-soft-lg w-full max-w-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="oct-headerbar px-5 py-4 flex items-center justify-between gap-3">
          <div>
            <h3 className="font-display text-2xl text-oct-text tracking-tight">PnL Calendar</h3>
            <p className="font-mono text-[11px] text-oct-muted mt-1">Daily net PnL from buy/sell USD (estimated)</p>
          </div>
          <button type="button" onClick={onClose} className="oct-icon-btn p-1.5">
            <X size={18} />
          </button>
        </div>

        <div className="p-5">
          {loading && <p className="font-mono text-xs text-oct-muted text-center py-8">Loading calendar…</p>}
          {!loading && error && (
            <p className="font-mono text-xs text-oct-flame text-center py-8">{formatPortfolioError(error)}</p>
          )}

          {!loading && !error && (
            <>
              <div className="flex items-center justify-between mb-4">
                <button
                  type="button"
                  onClick={() => setViewDate(new Date(year, month - 1, 1))}
                  className="oct-icon-btn p-1.5"
                >
                  <ChevronLeft size={16} />
                </button>
                <p className="font-mono text-sm uppercase tracking-[0.12em] text-oct-text">{monthLabel}</p>
                <button
                  type="button"
                  onClick={() => setViewDate(new Date(year, month + 1, 1))}
                  className="oct-icon-btn p-1.5"
                >
                  <ChevronRight size={16} />
                </button>
              </div>

              <div className="grid grid-cols-7 gap-1 mb-1">
                {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
                  <div key={d} className="font-mono text-[10px] text-oct-muted text-center py-1">{d}</div>
                ))}
              </div>

              <div className="grid grid-cols-7 gap-1">
                {cells.map((cell, idx) => {
                  if (!cell.date) {
                    return <div key={`empty-${idx}`} className="aspect-square" />;
                  }
                  const dayNum = Number(cell.date.slice(-2));
                  const pnl = cell.netPnl;
                  const positive = pnl != null && pnl > 0;
                  const negative = pnl != null && pnl < 0;
                  return (
                    <div
                      key={cell.date}
                      title={pnl != null ? `${cell.date}: ${formatUsd(pnl, { signed: true })}` : cell.date}
                      className={[
                        'aspect-square rounded-oct-sm border border-oct-border/60 flex flex-col items-center justify-center p-1',
                        positive ? 'bg-oct-green/15' : negative ? 'bg-oct-flame/15' : 'bg-oct-bg/40',
                      ].join(' ')}
                    >
                      <span className="font-mono text-[10px] text-oct-muted">{dayNum}</span>
                      {pnl != null && (
                        <span className={`font-mono text-[9px] tabular-nums ${positive ? 'text-oct-green' : negative ? 'text-oct-flame' : 'text-oct-muted'}`}>
                          {formatUsd(pnl, { signed: true })}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
