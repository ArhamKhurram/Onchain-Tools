import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PumpfunClient,
  PumpfunRequestError,
  PumpfunContractError,
  parseRetryAfter,
  isRateLimitedPumpfunError,
} from '../src/pumpfun/client';
import { setCached, getCached, peekStale, resetPumpfunCache, STALE_GRACE_MS } from '../src/pumpfun/cache';

// The reported bug: a pump.fun 429 dumped a raw "…failed (429)" card on the user.
// The fix threads a Retry-After hint through the error, keeps a stale value
// servable for a grace window, and flags a 429 apart from other failures. These
// pin those three pure/near-pure pieces.

const WALLET = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

describe('parseRetryAfter', () => {
  it('parses a whole-seconds delay into milliseconds', () => {
    expect(parseRetryAfter('120')).toBe(120_000);
    expect(parseRetryAfter('  5 ')).toBe(5_000);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('returns null for an absent, empty, or unparseable header', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('   ')).toBeNull();
    expect(parseRetryAfter('soon-ish')).toBeNull();
  });

  it('caps an absurd value at five minutes (hostile/buggy upstream guard)', () => {
    expect(parseRetryAfter('99999')).toBe(5 * 60 * 1000);
  });

  it('parses an HTTP-date form into a forward delay', () => {
    const when = new Date(Date.now() + 30_000).toUTCString();
    const ms = parseRetryAfter(when);
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThan(25_000);
    expect(ms!).toBeLessThanOrEqual(31_000);
  });

  it('returns 0 for an HTTP-date already in the past', () => {
    expect(parseRetryAfter(new Date(Date.now() - 10_000).toUTCString())).toBe(0);
  });
});

describe('isRateLimitedPumpfunError', () => {
  it('is true only for a 429 request failure', () => {
    expect(isRateLimitedPumpfunError(new PumpfunRequestError('/p', 429, 'slow'))).toBe(true);
  });

  it('is false for any other request failure, a shape error, or a plain error', () => {
    for (const status of [0, 400, 401, 404, 500, 502, 503, 504]) {
      expect(isRateLimitedPumpfunError(new PumpfunRequestError('/p', status, 'x'))).toBe(false);
    }
    expect(isRateLimitedPumpfunError(new PumpfunContractError('/p', 'bad shape'))).toBe(false);
    expect(isRateLimitedPumpfunError(new Error('boom'))).toBe(false);
    expect(isRateLimitedPumpfunError(null)).toBe(false);
  });
});

describe('the client captures Retry-After on a keyed 429', () => {
  const KEY = 'pk-secret-never-logged';
  beforeEach(() => {
    process.env.PUMPFUN_API_KEY = KEY;
    // Single attempt so the 429 surfaces immediately without real backoff sleeps.
    process.env.PUMPFUN_READ_RETRIES = '0';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PUMPFUN_API_KEY;
    delete process.env.PUMPFUN_READ_RETRIES;
  });

  it('surfaces the header as retryAfterMs on the thrown error (the caller callouts read)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Too Many Requests', { status: 429, headers: { 'retry-after': '12' } })));
    try {
      await new PumpfunClient().getWalletCallouts(WALLET);
      throw new Error('expected the call to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(PumpfunRequestError);
      expect((err as PumpfunRequestError).status).toBe(429);
      expect((err as PumpfunRequestError).retryAfterMs).toBe(12_000);
      // The key must never ride out in the message.
      expect((err as Error).message).not.toContain(KEY);
    }
  });

  it('leaves retryAfterMs undefined when the 429 carries no header', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('slow', { status: 429 })));
    try {
      await new PumpfunClient().getWalletCallouts(WALLET);
      throw new Error('expected the call to reject');
    } catch (err) {
      expect((err as PumpfunRequestError).retryAfterMs).toBeUndefined();
    }
  });
});

describe('cache stale-grace fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetPumpfunCache();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetPumpfunCache();
  });

  it('serves fresh, reports a miss past TTL, but peekStale still returns within the grace window', () => {
    setCached('wallet-callouts:x', { v: 1 }, 1_000);
    // Fresh: a normal read hits.
    expect(getCached<{ v: number }>('wallet-callouts:x')).toEqual({ v: 1 });
    vi.advanceTimersByTime(1_500); // past the 1s TTL
    // getCached reports a miss so a refresh is attempted...
    expect(getCached('wallet-callouts:x')).toBeNull();
    // ...but the last-known value is still there for a rate-limited fallback.
    expect(peekStale<{ v: number }>('wallet-callouts:x')).toEqual({ v: 1 });
  });

  it('drops the entry once even the grace window has elapsed', () => {
    setCached('wallet-callouts:y', { v: 2 }, 1_000);
    vi.advanceTimersByTime(1_000 + STALE_GRACE_MS + 1);
    expect(peekStale('wallet-callouts:y')).toBeNull();
    // getCached evicts it on the past-grace read.
    expect(getCached('wallet-callouts:y')).toBeNull();
  });

  it('peekStale returns null for a key that was never cached', () => {
    expect(peekStale('nope')).toBeNull();
  });
});
