// Pure data shaping for the candlestick chart. No React, no chart library import —
// kept separate so it runs in the frontend's node-environment Vitest and so the
// lazy chart chunk is the only place `lightweight-charts` is ever referenced.

import type { ChartCandle } from './candlesApi';

/** What lightweight-charts wants for a candlestick point: unix SECONDS, strictly ascending. */
export interface CandlePoint {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** A volume bar, coloured to match its candle's direction. */
export interface VolumePoint {
  time: number;
  value: number;
  color: string;
}

/**
 * Sort ascending, drop non-finite rows, collapse duplicate buckets (the last one
 * wins) and convert ms → s. lightweight-charts throws on a repeated or descending
 * `time`, and a provider occasionally hands back the current bucket twice as it
 * finalises, so this is correctness, not tidiness.
 */
export function toCandlePoints(candles: readonly ChartCandle[]): CandlePoint[] {
  const byTime = new Map<number, CandlePoint>();
  for (const c of candles) {
    if (![c.t, c.o, c.h, c.l, c.c].every(Number.isFinite)) continue;
    const time = Math.floor(c.t / 1000);
    byTime.set(time, { time, open: c.o, high: c.h, low: c.l, close: c.c });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

export function toVolumePoints(candles: readonly ChartCandle[], upColor: string, downColor: string): VolumePoint[] {
  const byTime = new Map<number, VolumePoint>();
  for (const c of candles) {
    if (![c.t, c.v, c.o, c.c].every(Number.isFinite)) continue;
    const time = Math.floor(c.t / 1000);
    byTime.set(time, { time, value: c.v, color: c.c >= c.o ? upColor : downColor });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/**
 * Decimal places for the price axis. Memecoin prices sit at 1e-5..1e-8 USD, where a
 * fixed 2dp axis renders every level as "0.00". Show three significant digits past
 * the leading zeros, floored at 2dp for normal prices and capped so the axis does not
 * eat the chart.
 */
export function pricePrecisionFor(price: number): number {
  if (!Number.isFinite(price) || price <= 0) return 2;
  if (price >= 1) return 2;
  const leadingZeros = Math.ceil(-Math.log10(price)) - 1;
  return Math.min(Math.max(leadingZeros + 3, 2), 10);
}

/** Pairs with `pricePrecisionFor`: the smallest tick the axis will show. */
export function minMoveFor(precision: number): number {
  return Number((10 ** -precision).toFixed(precision));
}

export interface CandleSummary {
  last: number;
  /** Close-over-first-open change across the loaded window, as a fraction (0.12 = +12%). */
  change: number | null;
}

/** Headline readout for the chart chrome. Null when there is nothing to summarise. */
export function summarise(points: readonly CandlePoint[]): CandleSummary | null {
  if (points.length === 0) return null;
  const first = points[0].open;
  const last = points[points.length - 1].close;
  return { last, change: first > 0 ? last / first - 1 : null };
}
