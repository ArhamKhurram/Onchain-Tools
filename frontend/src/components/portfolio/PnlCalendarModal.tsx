import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import type { DailyPnlResponse } from '../../types/portfolio';
import { formatPortfolioError, formatUsd } from '../../types/portfolio';
import { cn } from '../../lib/utils';
import { AnimatePresence, fadeIn, fadeInUp, m, MotionFeatures, useTransition } from '../../lib/motion';

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

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface CalendarGridProps {
  data: DailyPnlResponse | null;
  viewDate: Date;
  setViewDate: (next: Date) => void;
}

/**
 * The month grid. Split out so the cell layout is only computed while the
 * modal is open — the modal itself now stays mounted while closed so it can
 * play its exit fade. `viewDate` lives in the parent so the month the operator
 * paged to survives a close/reopen, as it did before the split.
 */
function CalendarGrid({ data, viewDate, setViewDate }: CalendarGridProps) {
  const dayMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const day of data?.days ?? []) {
      map.set(day.date, day.netPnl);
    }
    return map;
  }, [data?.days]);

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
    <>
      <div className="flex items-center justify-between mb-comfy">
        <button
          type="button"
          onClick={() => setViewDate(new Date(year, month - 1, 1))}
          className="oct-icon-btn p-snug"
          aria-label="Previous month"
        >
          <ChevronLeft size={16} />
        </button>
        <p className="type-label font-mono uppercase tracking-[0.12em] text-oct-text">{monthLabel}</p>
        <button
          type="button"
          onClick={() => setViewDate(new Date(year, month + 1, 1))}
          className="oct-icon-btn p-snug"
          aria-label="Next month"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-tight mb-tight">
        {WEEKDAYS.map((d) => (
          <div key={d} className="type-caption font-mono uppercase text-oct-muted text-center py-tight">{d}</div>
        ))}
      </div>

      {/* Day cells: the tint and the figure both carry meaning, so both use the
          semantic good/critical pair. A day with no trades stays neutral. */}
      <div className="grid grid-cols-7 gap-tight">
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
              className={cn(
                'aspect-square rounded-oct-sm border border-oct-border/60 flex flex-col items-center justify-center gap-hair p-tight',
                positive ? 'bg-oct-good-dim' : negative ? 'bg-oct-critical-dim' : 'bg-oct-bg/40',
              )}
            >
              <span className="type-data text-2xs text-oct-muted">{dayNum}</span>
              {pnl != null && (
                <span
                  className={cn(
                    'type-data text-2xs',
                    positive ? 'text-oct-good' : negative ? 'text-oct-critical' : 'text-oct-muted',
                  )}
                >
                  {formatUsd(pnl, { signed: true })}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

export default function PnlCalendarModal({ open, onClose, data, loading, error }: PnlCalendarModalProps) {
  const [viewDate, setViewDate] = useState(() => new Date());
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

  return (
    <MotionFeatures>
      <AnimatePresence>
        {open && (
          <m.div
            key="pnl-calendar-backdrop"
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
              className="oct-card oct-card-flush shadow-oct-soft-lg w-full max-w-2xl overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="oct-headerbar px-roomy py-comfy flex items-center justify-between gap-comfy">
                <div>
                  <h3 className="font-display type-heading text-oct-text tracking-tight">PnL Calendar</h3>
                  <p className="type-caption font-mono text-oct-muted mt-tight">Daily net PnL from buy/sell USD (estimated)</p>
                </div>
                <button type="button" onClick={onClose} className="oct-icon-btn p-snug" aria-label="Close">
                  <X size={18} />
                </button>
              </div>

              <div className="p-roomy">
                {loading && <p className="type-body text-oct-muted text-center py-gutter">Loading calendar…</p>}
                {!loading && error && (
                  <p className="type-body text-oct-critical text-center py-gutter">{formatPortfolioError(error)}</p>
                )}
                {!loading && !error && <CalendarGrid data={data} viewDate={viewDate} setViewDate={setViewDate} />}
              </div>
            </m.div>
          </m.div>
        )}
      </AnimatePresence>
    </MotionFeatures>
  );
}
