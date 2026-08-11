import type { JournalCurvePoint } from '../types';

/**
 * Geometry for the cumulative realized PnL curve (Journal tab). Pure so the
 * scaling math is unit-tested; the component just renders the strings.
 *
 * X is TIME-scaled (not index-scaled): the give-back pattern the curve exists
 * to show is "made it over weeks, gave it back in days", and index spacing
 * would flatten exactly that.
 */
export interface CurveGeometry {
  /** SVG polyline points ("x,y x,y …"), starting at 0 before the first event. */
  points: string;
  /** y of the zero line (always inside the viewbox — the curve starts at 0). */
  zeroY: number;
  /** y of the all-time peak. */
  peakY: number;
  lastX: number;
  lastY: number;
  minCum: number;
  maxCum: number;
}

export function buildCurveGeometry(
  curve: JournalCurvePoint[],
  width: number,
  height: number,
  pad = 4,
): CurveGeometry | null {
  if (curve.length === 0 || width <= 2 * pad || height <= 2 * pad) return null;

  const t0 = new Date(curve[0].ts).getTime();
  const t1 = new Date(curve[curve.length - 1].ts).getTime();
  const span = Math.max(t1 - t0, 1);

  let minCum = 0;
  let maxCum = 0;
  for (const p of curve) {
    if (p.cumSol < minCum) minCum = p.cumSol;
    if (p.cumSol > maxCum) maxCum = p.cumSol;
  }
  const range = Math.max(maxCum - minCum, 1e-9);

  const x = (ts: number) => pad + ((ts - t0) / span) * (width - 2 * pad);
  const y = (v: number) => pad + ((maxCum - v) / range) * (height - 2 * pad);

  const pts: string[] = [`${x(t0).toFixed(1)},${y(0).toFixed(1)}`];
  for (const p of curve) {
    pts.push(`${x(new Date(p.ts).getTime()).toFixed(1)},${y(p.cumSol).toFixed(1)}`);
  }

  const last = curve[curve.length - 1];
  return {
    points: pts.join(' '),
    zeroY: y(0),
    peakY: y(maxCum),
    lastX: x(new Date(last.ts).getTime()),
    lastY: y(last.cumSol),
    minCum,
    maxCum,
  };
}
