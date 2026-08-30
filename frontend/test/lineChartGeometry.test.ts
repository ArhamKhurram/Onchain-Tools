import { describe, expect, it } from 'vitest';
import {
  monotoneXPath,
  nearestIndex,
  niceScale,
  xLabelStep,
} from '../src/utils/lineChartGeometry';

describe('niceScale', () => {
  it('anchors the domain at zero for all-positive data (recharts [0, auto] parity)', () => {
    const s = niceScale(120, 940);
    expect(s.min).toBe(0);
    expect(s.max).toBeGreaterThanOrEqual(940);
    expect(s.ticks[0]).toBe(0);
    expect(s.ticks[s.ticks.length - 1]).toBe(s.max);
  });

  it('extends below zero for losses and keeps a zero tick', () => {
    const s = niceScale(-350, 200);
    expect(s.min).toBeLessThanOrEqual(-350);
    expect(s.max).toBeGreaterThanOrEqual(200);
    expect(s.ticks).toContain(0);
  });

  it('produces evenly spaced nice steps (1/2/5 family)', () => {
    const s = niceScale(0, 97);
    const steps = new Set<number>();
    for (let i = 1; i < s.ticks.length; i++) steps.add(s.ticks[i] - s.ticks[i - 1]);
    expect(steps.size).toBe(1);
    const step = [...steps][0];
    const mantissa = step / 10 ** Math.floor(Math.log10(step));
    expect([1, 2, 2.5, 5]).toContain(Number(mantissa.toPrecision(6)));
  });

  it('handles a flat all-zero series without collapsing', () => {
    const s = niceScale(0, 0);
    expect(s.max).toBeGreaterThan(s.min);
    expect(s.ticks).toContain(0);
  });

  it('handles fractional ranges without float-noise ticks', () => {
    const s = niceScale(0, 0.42);
    for (const t of s.ticks) {
      expect(String(t).length).toBeLessThan(8);
    }
  });
});

describe('monotoneXPath', () => {
  it('returns empty/move-only paths for 0 and 1 points', () => {
    expect(monotoneXPath([])).toBe('');
    expect(monotoneXPath([{ x: 5, y: 7 }])).toBe('M5,7');
  });

  it('draws a straight segment for 2 points', () => {
    expect(monotoneXPath([{ x: 0, y: 0 }, { x: 10, y: 10 }])).toBe('M0,0L10,10');
  });

  it('starts at the first point and ends at the last', () => {
    const pts = [
      { x: 0, y: 100 },
      { x: 50, y: 20 },
      { x: 100, y: 60 },
      { x: 150, y: 60 },
    ];
    const d = monotoneXPath(pts);
    expect(d.startsWith('M0,100')).toBe(true);
    expect(d.endsWith('150,60')).toBe(true);
    // three cubic segments for four points
    expect(d.match(/C/g)).toHaveLength(3);
  });

  it('is monotone between points: flat segments stay flat (no overshoot)', () => {
    // A plateau followed by a rise; monotone-X must keep the plateau's control
    // points at the plateau level (tangent 0 at both plateau ends).
    const d = monotoneXPath([
      { x: 0, y: 50 },
      { x: 10, y: 50 },
      { x: 20, y: 0 },
    ]);
    const firstCurve = d.slice(d.indexOf('C') + 1).split('C')[0];
    const [, y1, , y2] = firstCurve.split(',').map(Number);
    expect(y1).toBe(50);
    expect(y2).toBe(50);
  });
});

describe('xLabelStep', () => {
  it('shows every label when they fit', () => {
    expect(xLabelStep(7, 700, 44)).toBe(1);
  });
  it('thins labels when they would overlap', () => {
    expect(xLabelStep(30, 300, 44)).toBeGreaterThan(1);
  });
  it('never returns less than 1', () => {
    expect(xLabelStep(0, 0, 44)).toBe(1);
    expect(xLabelStep(1, -5, 44)).toBe(1);
  });
});

describe('nearestIndex', () => {
  const xs = [0, 10, 20, 30, 40];
  it('snaps to the closest x', () => {
    expect(nearestIndex(xs, -5)).toBe(0);
    expect(nearestIndex(xs, 4)).toBe(0);
    expect(nearestIndex(xs, 6)).toBe(1);
    expect(nearestIndex(xs, 29)).toBe(3);
    expect(nearestIndex(xs, 99)).toBe(4);
  });
  it('handles empty input', () => {
    expect(nearestIndex([], 5)).toBe(-1);
  });
});
