// Backoff pacing for the pump.fun wallet panel's self-healing auto-retry.
//
// The KEYED coin-communities host is rate-limited per shared x-api-key, so a 429
// is an ordinary contended moment, not an outage. Rather than dump a raw error on
// the user, the panel retries on its own with exponential backoff. This module is
// the PURE timing math behind that — no timers, no React — so it is unit-testable
// on its own (see test/pumpBackoff.test.ts).

/**
 * How many automatic attempts the panel makes before it stops and leaves a manual
 * retry button. Six covers roughly a minute of cooling off (~1+2+4+8+16+30s)
 * without hammering a still-busy origin forever.
 */
export const PUMP_RETRY_MAX_ATTEMPTS = 6;

/** The ceiling on a single backoff wait, so a large attempt count can't runaway. */
const MAX_BACKOFF_MS = 30_000;
const BASE_MS = 1_000;
const JITTER_MS = 250;

/**
 * The delay before the next retry, in milliseconds. `attempt` is 0-based (0 is the
 * first retry after the initial failure), so the base schedule is 1s, 2s, 4s, 8s,
 * 16s, then capped at 30s. A small random jitter avoids several panels (or tabs)
 * re-hitting the shared budget in lockstep. When the server sent a `Retry-After`
 * hint, that becomes a FLOOR — we never retry sooner than the vendor asked, but we
 * still back off further than it if our own schedule is longer.
 *
 * Exported `jitter` is injectable so the test can pin it; production uses Math.random.
 */
export function pumpBackoffMs(
  attempt: number,
  retryAfterSec?: number | null,
  jitter: () => number = Math.random,
): number {
  const safeAttempt = attempt < 0 ? 0 : attempt;
  const exponential = Math.min(BASE_MS * 2 ** safeAttempt, MAX_BACKOFF_MS);
  const withJitter = exponential + Math.floor(jitter() * JITTER_MS);
  const floor = retryAfterSec != null && retryAfterSec > 0 ? retryAfterSec * 1000 : 0;
  return Math.max(withJitter, floor);
}
