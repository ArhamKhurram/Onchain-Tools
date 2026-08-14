import { useMemo } from 'react';
import { buildCurveGeometry } from '../../utils/journalCurve';
import type { JournalCurvePoint } from '../../types';

const VIEW_W = 800;
const VIEW_H = 160;
const PAD = 6;

/**
 * The cumulative realized PnL curve — a plain SVG polyline (no chart lib).
 * A dashed line marks the all-time peak; the gap between it and the curve's
 * right edge IS the give-back, tinted red when active.
 */
export default function JournalCurve({
  curve,
  givebackActive,
}: {
  curve: JournalCurvePoint[];
  givebackActive: boolean;
}) {
  const geo = useMemo(() => buildCurveGeometry(curve, VIEW_W, VIEW_H, PAD), [curve]);

  if (!geo) {
    return (
      <div className="h-24 flex items-center justify-center font-mono text-xs text-oct-muted">
        The curve draws once sells start realizing PnL.
      </div>
    );
  }

  const last = curve[curve.length - 1];
  const lineColor = last.cumSol >= 0 ? 'rgb(var(--oct-green))' : 'rgb(var(--oct-flame))';

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      className="w-full h-40"
      preserveAspectRatio="none"
      role="img"
      aria-label="Cumulative realized PnL curve"
    >
      {/* zero line */}
      <line
        x1={PAD}
        x2={VIEW_W - PAD}
        y1={geo.zeroY}
        y2={geo.zeroY}
        stroke="currentColor"
        className="text-oct-border"
        strokeWidth={1}
      />
      {/* all-time-high line — the level the give-back meter measures from */}
      <line
        x1={PAD}
        x2={VIEW_W - PAD}
        y1={geo.peakY}
        y2={geo.peakY}
        stroke={givebackActive ? 'rgb(var(--oct-flame))' : 'currentColor'}
        className={givebackActive ? undefined : 'text-oct-muted'}
        strokeWidth={1}
        strokeDasharray="4 4"
        opacity={0.6}
      />
      {/* give-back gap marker at the right edge */}
      {givebackActive && (
        <line
          x1={geo.lastX}
          x2={geo.lastX}
          y1={geo.peakY}
          y2={geo.lastY}
          stroke="rgb(var(--oct-flame))"
          strokeWidth={2}
          opacity={0.8}
        />
      )}
      <polyline
        points={geo.points}
        fill="none"
        stroke={lineColor}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={geo.lastX} cy={geo.lastY} r={3} fill={lineColor} />
    </svg>
  );
}
