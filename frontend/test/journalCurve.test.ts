import { describe, expect, it } from 'vitest';
import { buildCurveGeometry } from '../src/utils/journalCurve';
import type { JournalCurvePoint } from '../src/types';

function pt(ts: string, cumSol: number): JournalCurvePoint {
  return { ts, cumSol, cumUsd: null };
}

describe('buildCurveGeometry', () => {
  it('returns null for an empty curve or degenerate box', () => {
    expect(buildCurveGeometry([], 100, 40)).toBeNull();
    expect(buildCurveGeometry([pt('2026-08-01T00:00:00.000Z', 1)], 4, 40, 4)).toBeNull();
  });

  it('starts at zero, scales x by TIME, and tracks the peak', () => {
    // 2 days up, then a same-day give-back — x must reflect the time gap.
    const curve = [
      pt('2026-08-01T00:00:00.000Z', 2),
      pt('2026-08-03T00:00:00.000Z', 5),
      pt('2026-08-03T12:00:00.000Z', 1),
    ];
    const g = buildCurveGeometry(curve, 104, 48, 4)!;
    const coords = g.points.split(' ').map((p) => p.split(',').map(Number));
    // 4 points: injected zero start + 3 events.
    expect(coords).toHaveLength(4);
    // Zero start shares x with the first event.
    expect(coords[0][0]).toBeCloseTo(coords[1][0], 5);
    expect(coords[0][1]).toBeCloseTo(g.zeroY, 5);
    // Time scaling: day 1→3 is 80% of the span, the last half-day 20%.
    const [x0, x1, x2] = [coords[1][0], coords[2][0], coords[3][0]];
    expect((x1 - x0) / (x2 - x0)).toBeCloseTo(0.8, 5);
    // Peak (cum 5) sits at the top pad; range spans 0..5.
    expect(g.peakY).toBeCloseTo(4, 5);
    expect(g.maxCum).toBe(5);
    expect(g.minCum).toBe(0);
    // Last point is the give-back level (cum 1): 4/5 down from the peak.
    expect(g.lastY).toBeCloseTo(4 + (4 / 5) * 40, 5);
  });

  it('keeps the zero line inside the box when the curve goes negative', () => {
    const curve = [pt('2026-08-01T00:00:00.000Z', -2), pt('2026-08-02T00:00:00.000Z', 1)];
    const g = buildCurveGeometry(curve, 104, 48, 4)!;
    expect(g.minCum).toBe(-2);
    expect(g.maxCum).toBe(1);
    // zero sits 1/3 down the range (max 1 → 0 is 1 of 3 units).
    expect(g.zeroY).toBeCloseTo(4 + (1 / 3) * 40, 5);
  });
});
