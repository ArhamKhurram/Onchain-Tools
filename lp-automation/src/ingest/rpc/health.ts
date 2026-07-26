// Pure resilience arithmetic: reconnect backoff and staleness detection.
//
// Kept separate from the watcher so both can be tested without a chain, a
// socket, or fake timers. The watcher supplies the clock and the RNG; this
// module only does arithmetic.
//
// Staleness is the single most important signal this module produces. A dead
// WebSocket subscription is worse than no watcher at all, because the rest of
// the system would go on believing a position is being watched. Everything
// here is biased towards declaring a problem early rather than late.

export interface BackoffOptions {
  /** Delay for attempt 0. */
  baseDelayMs: number;
  /** Hard ceiling applied before jitter, so a jittered delay never exceeds it. */
  maxDelayMs: number;
  /** Multiplier per attempt. 2 = classic exponential. */
  factor: number;
  /**
   * Fraction of the delay that is randomized, in [0, 1].
   * 0 = fully deterministic; 1 = full jitter (uniform over [0, delay]).
   * Default 0.2 keeps reconnects predictable while still de-synchronizing a
   * fleet of watchers that all lost the same provider at the same instant.
   */
  jitterRatio: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  baseDelayMs: 250,
  maxDelayMs: 30_000,
  factor: 2,
  jitterRatio: 0.2,
};

/**
 * Delay before reconnect attempt number `attempt` (0-based: attempt 0 is the
 * first retry after a failure and gets `baseDelayMs`).
 *
 * The cap is applied *before* jitter, so the returned value is always within
 * `[maxDelayMs * (1 - jitterRatio), maxDelayMs]` once the ceiling is reached —
 * a jittered value can dip below the cap but never above it.
 *
 * `random` is injectable purely so tests can pin the jitter.
 */
export function backoffDelayMs(
  attempt: number,
  options: Partial<BackoffOptions> = {},
  random: () => number = Math.random,
): number {
  const { baseDelayMs, maxDelayMs, factor, jitterRatio } = { ...DEFAULT_BACKOFF, ...options };

  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new RangeError(`baseDelayMs must be a non-negative finite number, received ${baseDelayMs}`);
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs < 0) {
    throw new RangeError(`maxDelayMs must be a non-negative finite number, received ${maxDelayMs}`);
  }
  if (!Number.isFinite(factor) || factor < 1) {
    throw new RangeError(`factor must be a finite number >= 1, received ${factor}`);
  }
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new RangeError(`jitterRatio must be within [0, 1], received ${jitterRatio}`);
  }

  // Negative / non-integer attempts are treated as attempt 0 rather than
  // throwing: a miscounted attempt should reconnect fast, not crash the
  // watcher that is already in trouble.
  const n = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;

  // factor ** n overflows to Infinity for large n; Math.min collapses that to
  // the ceiling, which is the intended behaviour.
  const raw = baseDelayMs * factor ** n;
  const capped = Math.min(maxDelayMs, Number.isFinite(raw) ? raw : maxDelayMs);

  if (jitterRatio === 0) return capped;
  return capped * (1 - jitterRatio + jitterRatio * random());
}

export interface StalenessEvaluation {
  stale: boolean;
  /** Milliseconds since the last observation. `Infinity` when there is none. */
  sinceMs: number;
  thresholdMs: number;
}

/**
 * Has the chain gone quiet for longer than we tolerate?
 *
 * Boundary semantics: `sinceMs >= thresholdMs` is stale. At exactly the
 * threshold we call it stale rather than healthy — this detector exists to fail
 * loud, and being one millisecond early costs nothing while being late costs a
 * position.
 *
 * `lastEventAt === null` (nothing ever seen) is stale with `sinceMs: Infinity`.
 * Callers should seed `lastEventAt` at connect time so the initial grace period
 * is exactly `thresholdMs` rather than "immediately stale on startup".
 *
 * A `now` earlier than `lastEventAt` (clock skew, NTP step) clamps to 0 rather
 * than producing a negative age.
 */
export function evaluateStaleness(
  lastEventAt: number | null,
  now: number,
  thresholdMs: number,
): StalenessEvaluation {
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) {
    throw new RangeError(`thresholdMs must be a positive finite number, received ${thresholdMs}`);
  }
  if (!Number.isFinite(now)) {
    throw new RangeError(`now must be a finite timestamp, received ${now}`);
  }

  if (lastEventAt === null) {
    return { stale: true, sinceMs: Number.POSITIVE_INFINITY, thresholdMs };
  }
  if (!Number.isFinite(lastEventAt)) {
    throw new RangeError(`lastEventAt must be a finite timestamp or null, received ${lastEventAt}`);
  }

  const sinceMs = Math.max(0, now - lastEventAt);
  return { stale: sinceMs >= thresholdMs, sinceMs, thresholdMs };
}

/** Convenience predicate over `evaluateStaleness`. */
export function isStale(lastEventAt: number | null, now: number, thresholdMs: number): boolean {
  return evaluateStaleness(lastEventAt, now, thresholdMs).stale;
}
