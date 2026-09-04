import { describe, it, expect } from 'vitest';
import { minMoveFor, pricePrecisionFor, summarise, toCandlePoints, toVolumePoints } from '../src/lib/candleSeries';
import type { ChartCandle } from '../src/lib/candlesApi';

const c = (t: number, o: number, h: number, l: number, cl: number, v = 1): ChartCandle => ({ t, o, h, l, c: cl, v });

describe('toCandlePoints', () => {
  it('converts ms to seconds and sorts ascending', () => {
    const out = toCandlePoints([c(120_000, 1, 2, 0.5, 1.5), c(60_000, 1, 1, 1, 1)]);
    expect(out.map((p) => p.time)).toEqual([60, 120]);
  });

  it('collapses duplicate buckets, last one wins', () => {
    const out = toCandlePoints([c(60_000, 1, 1, 1, 1), c(60_000, 2, 3, 1, 2.5)]);
    expect(out).toHaveLength(1);
    expect(out[0].close).toBe(2.5);
  });

  it('drops rows with non-finite prices', () => {
    expect(toCandlePoints([c(60_000, NaN, 1, 1, 1), c(120_000, 1, 1, 1, 1)])).toHaveLength(1);
  });
});

describe('toVolumePoints', () => {
  it('colours a bar by its candle direction', () => {
    const out = toVolumePoints([c(60_000, 1, 2, 1, 2, 5), c(120_000, 2, 2, 1, 1, 7)], 'UP', 'DOWN');
    expect(out.map((p) => p.color)).toEqual(['UP', 'DOWN']);
    expect(out.map((p) => p.value)).toEqual([5, 7]);
  });
});

describe('pricePrecisionFor', () => {
  it('uses 2dp at and above a dollar', () => {
    expect(pricePrecisionFor(1)).toBe(2);
    expect(pricePrecisionFor(123.456)).toBe(2);
  });

  it('shows three significant digits past the leading zeros for memecoin prices', () => {
    expect(pricePrecisionFor(0.5)).toBe(3);
    expect(pricePrecisionFor(0.0123)).toBe(4);
    expect(pricePrecisionFor(0.00001234)).toBe(7);
  });

  it('caps at 10 and tolerates junk', () => {
    expect(pricePrecisionFor(1e-12)).toBe(10);
    expect(pricePrecisionFor(0)).toBe(2);
    expect(pricePrecisionFor(NaN)).toBe(2);
  });

  it('pairs with a clean minMove', () => {
    expect(minMoveFor(2)).toBe(0.01);
    expect(minMoveFor(7)).toBe(0.0000001);
  });
});

describe('summarise', () => {
  it('reports last close and window change', () => {
    const s = summarise(toCandlePoints([c(60_000, 1, 1, 1, 1), c(120_000, 1, 2, 1, 1.5)]));
    expect(s).toEqual({ last: 1.5, change: 0.5 });
  });

  it('is null on empty input and has no change from a zero open', () => {
    expect(summarise([])).toBeNull();
    expect(summarise(toCandlePoints([c(60_000, 0, 1, 0, 1)]))?.change).toBeNull();
  });
});
