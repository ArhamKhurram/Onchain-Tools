// "peak 4.2×" — the highest multiple a called token has reached since the call.
//
// This is `maxMultiplier`, which the backend carried (j7/mappers.ts recovers it;
// the coin-communities rows have always had it) and the console mostly dropped
// on the floor. It is a peak the token TOUCHED, not a return anyone captured —
// the Top Callers board's disclaimer applies — so it is coloured only at 2× and
// above (`oct-good`, a semantic colour, never the accent) and stays neutral
// below, where "peak 1.1×" is not news. Null renders an em dash, never a zero.
//
// `type-data` so the digits align with every other numeric cell around it.

import { cn } from '../../lib/utils';

/** The threshold at which a peak reads as a real move. */
export const PEAK_GOOD_MIN = 2;

export function formatPeakMultiple(m: number | null | undefined): string {
  if (m == null || !Number.isFinite(m)) return '—';
  // ≥10 has no useful decimals; below that one is enough to tell 1.4× from 1.9×.
  return `${m >= 10 ? m.toFixed(0) : m.toFixed(1)}×`;
}

export function peakMultipleTone(m: number | null | undefined): 'good' | 'neutral' | 'none' {
  if (m == null || !Number.isFinite(m)) return 'none';
  return m >= PEAK_GOOD_MIN ? 'good' : 'neutral';
}

function peakTitle(at: string | null | undefined): string {
  const base = 'Peak multiple since the call — the highest the token touched, not a captured return.';
  if (!at) return base;
  const t = Date.parse(at);
  return Number.isFinite(t) ? `${base} Reached ${new Date(t).toLocaleString()}.` : base;
}

export default function PeakMultiple({
  value,
  at,
  /** Prefix the number with "peak" (feed rows); tables carry it in the header instead. */
  labelled = false,
  className,
}: {
  value: number | null | undefined;
  /** ISO time the peak was reached, when known — surfaces as the tooltip. */
  at?: string | null;
  labelled?: boolean;
  className?: string;
}) {
  const tone = peakMultipleTone(value);
  return (
    <span
      className={cn(
        'type-data whitespace-nowrap',
        tone === 'good' && 'font-bold text-oct-good',
        tone === 'neutral' && 'text-oct-text',
        tone === 'none' && 'text-oct-muted',
        className,
      )}
      title={peakTitle(at)}
    >
      {labelled && <span className="text-oct-muted font-normal">peak </span>}
      {formatPeakMultiple(value)}
    </span>
  );
}
