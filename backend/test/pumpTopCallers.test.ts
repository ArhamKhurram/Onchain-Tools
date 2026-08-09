import { describe, it, expect } from 'vitest';
import { parseTopCallersQuery } from '../src/pumpfun/routes';

// The /top-callers route feeds every ?query straight into a Supabase read, so the
// normaliser must default and clamp before anything touches the DB. Each `it`
// guards one concrete bug the way parseMintsBody's tests do.

describe('parseTopCallersQuery', () => {
  it('defaults an empty query to the all-time count board (50 rows, minCalls 3)', () => {
    expect(parseTopCallersQuery({})).toEqual({ window: 'all', metric: 'count', limit: 50, minCalls: 3 });
  });

  it('accepts the known windows and metrics', () => {
    for (const window of ['all', '24h', '7d', '30d'] as const) {
      expect(parseTopCallersQuery({ window }).window).toBe(window);
    }
    for (const metric of ['count', 'avg', 'max'] as const) {
      expect(parseTopCallersQuery({ metric }).metric).toBe(metric);
    }
  });

  it('is case-insensitive on window and metric', () => {
    const q = parseTopCallersQuery({ window: '7D', metric: 'AVG' });
    expect(q).toMatchObject({ window: '7d', metric: 'avg' });
  });

  it('falls back to all / count on an unknown window or metric (never a junk read)', () => {
    // The bug this guards: an unrecognised window passed through would become a
    // NaN cutoff or an invalid RPC metric. It must degrade to the safe default.
    const q = parseTopCallersQuery({ window: 'forever', metric: 'sharpe' });
    expect(q).toMatchObject({ window: 'all', metric: 'count' });
  });

  it('clamps limit into [1, 200] and defaults junk', () => {
    expect(parseTopCallersQuery({ limit: '9999' }).limit).toBe(200);
    expect(parseTopCallersQuery({ limit: '0' }).limit).toBe(1);
    expect(parseTopCallersQuery({ limit: '-5' }).limit).toBe(1);
    expect(parseTopCallersQuery({ limit: 'nope' }).limit).toBe(50);
    expect(parseTopCallersQuery({ limit: '75' }).limit).toBe(75);
  });

  it('clamps minCalls into [1, 100] and defaults junk', () => {
    // minCalls floors at 1 so the avg/max boards can never be topped by a caller
    // with zero recorded calls, and caps so it cannot silently empty the board.
    expect(parseTopCallersQuery({ minCalls: '0' }).minCalls).toBe(1);
    expect(parseTopCallersQuery({ minCalls: '500' }).minCalls).toBe(100);
    expect(parseTopCallersQuery({ minCalls: 'nope' }).minCalls).toBe(3);
    expect(parseTopCallersQuery({ minCalls: '10' }).minCalls).toBe(10);
  });
});
