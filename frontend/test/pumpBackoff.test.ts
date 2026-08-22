import { describe, it, expect } from 'vitest';
import { pumpBackoffMs, PUMP_RETRY_MAX_ATTEMPTS } from '../src/lib/pumpBackoff';

// The pump.fun wallet panel self-heals a 429 with exponential backoff instead of
// showing the raw error. This pins the pure timing math that drives it: the
// schedule, the cap, the jitter, and how a server Retry-After floors the wait.
// A fixed jitter fn makes every case deterministic.
const noJitter = () => 0;

describe('pumpBackoffMs', () => {
  it('grows exponentially from 1s and caps at 30s', () => {
    expect(pumpBackoffMs(0, null, noJitter)).toBe(1_000);
    expect(pumpBackoffMs(1, null, noJitter)).toBe(2_000);
    expect(pumpBackoffMs(2, null, noJitter)).toBe(4_000);
    expect(pumpBackoffMs(3, null, noJitter)).toBe(8_000);
    expect(pumpBackoffMs(4, null, noJitter)).toBe(16_000);
    // 32s would be next — capped at 30s, and stays there for any larger attempt.
    expect(pumpBackoffMs(5, null, noJitter)).toBe(30_000);
    expect(pumpBackoffMs(10, null, noJitter)).toBe(30_000);
  });

  it('adds sub-second jitter on top of the exponential base', () => {
    // The bug this guards: without jitter, several panels/tabs sharing the one
    // rate-limited key would retry in lockstep and re-provoke the 429 together.
    expect(pumpBackoffMs(0, null, () => 0.999)).toBe(1_000 + Math.floor(0.999 * 250));
  });

  it('floors the wait at the server Retry-After when it is longer than our backoff', () => {
    // Attempt 0 would be ~1s, but the server asked for 5s — respect the ask.
    expect(pumpBackoffMs(0, 5, noJitter)).toBe(5_000);
  });

  it('ignores a Retry-After shorter than our own backoff', () => {
    // Our 8s (attempt 3) is longer than a 2s ask, so we keep backing off further.
    expect(pumpBackoffMs(3, 2, noJitter)).toBe(8_000);
  });

  it('ignores a zero/negative Retry-After', () => {
    expect(pumpBackoffMs(1, 0, noJitter)).toBe(2_000);
    expect(pumpBackoffMs(1, -10, noJitter)).toBe(2_000);
  });

  it('treats a negative attempt as the first retry rather than shrinking below 1s', () => {
    expect(pumpBackoffMs(-5, null, noJitter)).toBe(1_000);
  });

  it('exposes a bounded, sane attempt budget', () => {
    expect(PUMP_RETRY_MAX_ATTEMPTS).toBeGreaterThanOrEqual(3);
    expect(PUMP_RETRY_MAX_ATTEMPTS).toBeLessThanOrEqual(10);
  });
});
