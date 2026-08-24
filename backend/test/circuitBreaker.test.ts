import { describe, it, expect, beforeEach } from 'vitest';
import {
  CircuitBreaker,
  BREAKER_FAILURE_THRESHOLD,
  BREAKER_FAILURE_WINDOW_MS,
  BREAKER_COOLDOWN_MS,
  dexScreenerBreaker,
  type BreakerState,
} from '../src/utils/circuitBreaker.js';

const T0 = Date.UTC(2026, 7, 24, 12, 0, 0);

function makeBreaker() {
  const transitions: Array<{ from: BreakerState; to: BreakerState }> = [];
  const breaker = new CircuitBreaker((from, to) => transitions.push({ from, to }));
  return { breaker, transitions };
}

/** Drive a fresh-window failure streak up to (but not past) the threshold. */
function failTimes(breaker: CircuitBreaker, n: number, at = T0) {
  for (let i = 0; i < n; i++) breaker.recordFailure(at + i);
}

describe('CircuitBreaker', () => {
  it('starts closed and allows calls', () => {
    const { breaker } = makeBreaker();
    expect(breaker.state).toBe('closed');
    expect(breaker.shouldAllow(T0)).toBe(true);
  });

  it('stays closed below the failure threshold', () => {
    const { breaker, transitions } = makeBreaker();
    failTimes(breaker, BREAKER_FAILURE_THRESHOLD - 1);
    expect(breaker.state).toBe('closed');
    expect(breaker.shouldAllow(T0)).toBe(true);
    expect(transitions).toEqual([]);
  });

  it('opens on the Nth consecutive failure and skips calls', () => {
    const { breaker, transitions } = makeBreaker();
    failTimes(breaker, BREAKER_FAILURE_THRESHOLD);
    expect(breaker.state).toBe('open');
    expect(breaker.shouldAllow(T0 + 1000)).toBe(false);
    expect(transitions).toEqual([{ from: 'closed', to: 'open' }]);
  });

  it('a success resets the consecutive-failure count', () => {
    const { breaker } = makeBreaker();
    failTimes(breaker, BREAKER_FAILURE_THRESHOLD - 1);
    breaker.recordSuccess();
    failTimes(breaker, BREAKER_FAILURE_THRESHOLD - 1);
    expect(breaker.state).toBe('closed');
  });

  it('failures outside the window do not accumulate', () => {
    const { breaker } = makeBreaker();
    failTimes(breaker, BREAKER_FAILURE_THRESHOLD - 1, T0);
    // Next failure lands after the window: the streak starts over at 1.
    breaker.recordFailure(T0 + BREAKER_FAILURE_WINDOW_MS + 10_000);
    expect(breaker.state).toBe('closed');
  });

  describe('once open', () => {
    it('skips every call during the cooldown', () => {
      const { breaker } = makeBreaker();
      failTimes(breaker, BREAKER_FAILURE_THRESHOLD);
      expect(breaker.shouldAllow(T0 + BREAKER_COOLDOWN_MS - 1)).toBe(false);
      expect(breaker.state).toBe('open');
    });

    it('allows exactly one probe after the cooldown', () => {
      const { breaker } = makeBreaker();
      failTimes(breaker, BREAKER_FAILURE_THRESHOLD);
      const later = T0 + BREAKER_COOLDOWN_MS + 10_000;
      expect(breaker.shouldAllow(later)).toBe(true);
      expect(breaker.state).toBe('half-open');
      // Concurrent callers while the probe is in flight are still skipped.
      expect(breaker.shouldAllow(later + 1)).toBe(false);
      expect(breaker.shouldAllow(later + 2)).toBe(false);
    });

    it('closes when the probe succeeds', () => {
      const { breaker, transitions } = makeBreaker();
      failTimes(breaker, BREAKER_FAILURE_THRESHOLD);
      expect(breaker.shouldAllow(T0 + BREAKER_COOLDOWN_MS + 10_000)).toBe(true);
      breaker.recordSuccess();
      expect(breaker.state).toBe('closed');
      expect(breaker.shouldAllow(T0 + BREAKER_COOLDOWN_MS + 10_001)).toBe(true);
      expect(transitions).toEqual([
        { from: 'closed', to: 'open' },
        { from: 'open', to: 'half-open' },
        { from: 'half-open', to: 'closed' },
      ]);
    });

    it('re-opens for a full cooldown when the probe fails', () => {
      const { breaker, transitions } = makeBreaker();
      failTimes(breaker, BREAKER_FAILURE_THRESHOLD);
      const probeAt = T0 + BREAKER_COOLDOWN_MS + 10_000;
      expect(breaker.shouldAllow(probeAt)).toBe(true);
      breaker.recordFailure(probeAt + 8000);
      expect(breaker.state).toBe('open');
      // Cooldown restarts from the probe failure, not the original trip.
      expect(breaker.shouldAllow(probeAt + 8000 + BREAKER_COOLDOWN_MS - 1)).toBe(false);
      expect(breaker.shouldAllow(probeAt + 8000 + BREAKER_COOLDOWN_MS + 1)).toBe(true);
      expect(transitions).toEqual([
        { from: 'closed', to: 'open' },
        { from: 'open', to: 'half-open' },
        { from: 'half-open', to: 'open' },
        { from: 'open', to: 'half-open' },
      ]);
    });

    it('after recovery, a fresh outage needs a full new failure streak', () => {
      const { breaker } = makeBreaker();
      failTimes(breaker, BREAKER_FAILURE_THRESHOLD);
      const later = T0 + BREAKER_COOLDOWN_MS + 10_000;
      expect(breaker.shouldAllow(later)).toBe(true);
      breaker.recordSuccess();

      failTimes(breaker, BREAKER_FAILURE_THRESHOLD - 1, later + 1000);
      expect(breaker.state).toBe('closed');
      breaker.recordFailure(later + 2000);
      expect(breaker.state).toBe('open');
    });
  });

  it('fires the transition callback once per transition, not per skipped call', () => {
    const { breaker, transitions } = makeBreaker();
    failTimes(breaker, BREAKER_FAILURE_THRESHOLD);
    for (let i = 0; i < 50; i++) breaker.shouldAllow(T0 + i);
    breaker.recordFailure(T0 + 100); // extra failures while open are no-ops
    expect(transitions).toEqual([{ from: 'closed', to: 'open' }]);
  });
});

describe('dexScreenerBreaker singleton', () => {
  beforeEach(() => {
    dexScreenerBreaker.reset();
  });

  it('is a working breaker instance shared by the enrichment client', () => {
    expect(dexScreenerBreaker.state).toBe('closed');
    failTimes(dexScreenerBreaker, BREAKER_FAILURE_THRESHOLD);
    expect(dexScreenerBreaker.state).toBe('open');
    dexScreenerBreaker.reset();
    expect(dexScreenerBreaker.state).toBe('closed');
  });
});
