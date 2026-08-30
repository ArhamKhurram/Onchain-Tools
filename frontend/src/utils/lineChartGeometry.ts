/**
 * Pure geometry helpers for the hand-rolled SVG line chart (PnlLineChart).
 *
 * These reproduce the two recharts behaviors the old PnL chart relied on:
 *  - "nice" Y-axis ticks (d3-style 1/2/5 stepping, domain extended to tick bounds)
 *  - monotone-X cubic interpolation (d3-shape curveMonotoneX), so the curve
 *    shape is pixel-comparable to the recharts `type="monotone"` line.
 *
 * Kept as pure functions so they can be unit-tested without a DOM.
 */

const SQRT50 = Math.sqrt(50);
const SQRT10 = Math.sqrt(10);
const SQRT2 = Math.sqrt(2);

/** d3-array's tickIncrement: the "nice" step for ~count ticks over [start, stop]. */
function tickIncrement(start: number, stop: number, count: number): number {
  const step = (stop - start) / Math.max(1, count);
  const power = Math.floor(Math.log10(step));
  const error = step / 10 ** power;
  const factor = error >= SQRT50 ? 10 : error >= SQRT10 ? 5 : error >= SQRT2 ? 2 : 1;
  return power >= 0 ? factor * 10 ** power : -(10 ** -power) / factor;
}

export interface NiceScale {
  /** Nice domain bounds enclosing the data (tick-aligned). */
  min: number;
  max: number;
  /** Tick values from min to max inclusive, ascending. */
  ticks: number[];
}

/**
 * Nice tick scale over [dataMin, dataMax], zero-anchored like the old chart
 * (recharts' default number-axis domain is `[0, 'auto']`, so the PnL curve
 * always showed the zero line; we keep that and extend it downward for losses).
 */
export function niceScale(dataMin: number, dataMax: number, tickCount = 5): NiceScale {
  let lo = Math.min(0, dataMin);
  let hi = Math.max(0, dataMax);
  if (lo === hi) {
    // Degenerate flat-at-zero series: give the axis some room.
    hi = 1;
    lo = -1;
  }
  const inc = tickIncrement(lo, hi, tickCount);
  const step = inc > 0 ? inc : 1 / -inc;
  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  const n = Math.round((max - min) / step);
  for (let i = 0; i <= n; i++) {
    const v = min + i * step;
    // Snap float noise (e.g. 0.30000000000000004) back onto the step grid.
    ticks.push(Math.abs(v) < step * 1e-9 ? 0 : Number(v.toPrecision(12)));
  }
  return { min, max, ticks };
}

export interface XY {
  x: number;
  y: number;
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));

/**
 * SVG path using monotone-X cubic interpolation — the same tangent rules as
 * d3-shape's curveMonotoneX (which is what recharts `type="monotone"` used),
 * so the curve never overshoots between points.
 */
export function monotoneXPath(pts: XY[]): string {
  const n = pts.length;
  if (n === 0) return '';
  if (n === 1) return `M${fmt(pts[0].x)},${fmt(pts[0].y)}`;
  let d = `M${fmt(pts[0].x)},${fmt(pts[0].y)}`;
  if (n === 2) return `${d}L${fmt(pts[1].x)},${fmt(pts[1].y)}`;

  const sign = (v: number) => (v < 0 ? -1 : 1);
  // Secant slopes between consecutive points.
  const sec: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    sec.push((pts[i + 1].y - pts[i].y) / (pts[i + 1].x - pts[i].x));
  }
  // Point tangents (Fritsch–Carlson, as implemented by d3's slope3/slope2).
  const tan: number[] = new Array(n);
  for (let i = 1; i < n - 1; i++) {
    const h0 = pts[i].x - pts[i - 1].x;
    const h1 = pts[i + 1].x - pts[i].x;
    const s0 = sec[i - 1];
    const s1 = sec[i];
    const p = (s0 * h1 + s1 * h0) / (h0 + h1);
    tan[i] = (sign(s0) + sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0;
  }
  tan[0] = (3 * sec[0] - tan[1]) / 2;
  tan[n - 1] = (3 * sec[n - 2] - tan[n - 2]) / 2;

  for (let i = 0; i < n - 1; i++) {
    const x0 = pts[i].x;
    const y0 = pts[i].y;
    const x1 = pts[i + 1].x;
    const y1 = pts[i + 1].y;
    const dx = (x1 - x0) / 3;
    d += `C${fmt(x0 + dx)},${fmt(y0 + dx * tan[i])},${fmt(x1 - dx)},${fmt(y1 - dx * tan[i + 1])},${fmt(x1)},${fmt(y1)}`;
  }
  return d;
}

/**
 * Which X labels to render so they don't overlap: returns the skip interval
 * (1 = every label), mirroring recharts' auto-thinning for category axes.
 */
export function xLabelStep(count: number, plotWidth: number, approxLabelWidth: number): number {
  if (count <= 1 || plotWidth <= 0) return 1;
  const maxLabels = Math.max(1, Math.floor(plotWidth / approxLabelWidth));
  return Math.max(1, Math.ceil(count / maxLabels));
}

/** Index of the point whose x is closest to px (xs must be ascending). */
export function nearestIndex(xs: number[], px: number): number {
  if (xs.length === 0) return -1;
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < px) lo = mid;
    else hi = mid;
  }
  return px - xs[lo] <= xs[hi] - px ? lo : hi;
}
