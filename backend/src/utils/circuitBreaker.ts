/**
 * Minimal circuit breaker for outbound provider calls.
 *
 * Born from the 2026-08-24 DexScreener outage: every request against the dead
 * API waited out the full per-call timeout, so each enrichment serially added
 * ~8s and feed refreshes crawled. GMGN kept working — the only fix needed was
 * to stop queueing on a provider that is demonstrably down.
 *
 * Three states, standard semantics:
 * - CLOSED    — calls flow. Consecutive failures inside a window are counted;
 *               hitting the threshold trips the breaker OPEN.
 * - OPEN      — calls are skipped instantly (callers fall back to whatever
 *               partial data they have) until the cooldown elapses.
 * - HALF_OPEN — after the cooldown, exactly one probe call is let through.
 *               Success closes the breaker; failure re-opens it for another
 *               full cooldown.
 *
 * Only *thrown* fetch errors (timeouts, network failures) count as failures.
 * An HTTP response — even a non-2xx one — means the API is up and answering
 * fast, which is not the condition this breaker exists for.
 *
 * Deliberately constants, not config: 5 failures / 60s window / 60s cooldown
 * is the whole tuning surface.
 */

export type BreakerState = 'closed' | 'open' | 'half-open';

/** Consecutive failures (within the window) that trip the breaker. */
export const BREAKER_FAILURE_THRESHOLD = 5;
/** Failures older than this no longer count toward the threshold. */
export const BREAKER_FAILURE_WINDOW_MS = 60_000;
/** How long an open breaker skips calls before allowing a probe. */
export const BREAKER_COOLDOWN_MS = 60_000;

export class CircuitBreaker {
  private currentState: BreakerState = 'closed';
  private failureCount = 0;
  private lastFailureAt = 0;
  private openedAt = 0;
  private probeInFlight = false;

  constructor(
    /** Called once per state transition — the single place logging happens. */
    private readonly onTransition?: (from: BreakerState, to: BreakerState) => void,
  ) {}

  get state(): BreakerState {
    return this.currentState;
  }

  /**
   * Gate a call. Returns false when the call should be skipped outright.
   * A true from an open breaker means "you are the probe" — report back via
   * recordSuccess/recordFailure or the breaker stays half-open forever.
   */
  shouldAllow(now = Date.now()): boolean {
    if (this.currentState === 'closed') return true;
    if (this.currentState === 'open') {
      if (now - this.openedAt < BREAKER_COOLDOWN_MS) return false;
      this.transition('half-open');
      this.probeInFlight = true;
      return true;
    }
    // half-open: one probe at a time.
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  recordSuccess(): void {
    this.failureCount = 0;
    this.probeInFlight = false;
    if (this.currentState !== 'closed') this.transition('closed');
  }

  recordFailure(now = Date.now()): void {
    this.probeInFlight = false;
    if (this.currentState === 'half-open') {
      // Probe failed — back to a full cooldown.
      this.openedAt = now;
      this.transition('open');
      return;
    }
    if (this.currentState === 'open') return;
    if (now - this.lastFailureAt > BREAKER_FAILURE_WINDOW_MS) this.failureCount = 0;
    this.lastFailureAt = now;
    this.failureCount++;
    if (this.failureCount >= BREAKER_FAILURE_THRESHOLD) {
      this.openedAt = now;
      this.transition('open');
    }
  }

  /** Test seam — breakers are process-global state. */
  reset(): void {
    this.currentState = 'closed';
    this.failureCount = 0;
    this.lastFailureAt = 0;
    this.openedAt = 0;
    this.probeInFlight = false;
  }

  private transition(to: BreakerState): void {
    const from = this.currentState;
    this.currentState = to;
    this.onTransition?.(from, to);
  }
}

/**
 * The one shared DexScreener breaker. All DexScreener traffic that goes through
 * `enrichFromDexScreener` is gated here; see that function for the wiring.
 * Logs once per transition — never per skipped call.
 */
export const dexScreenerBreaker = new CircuitBreaker((_from, to) => {
  if (to === 'open') {
    console.warn(`[enrich] DexScreener breaker OPEN — skipping DexScreener calls for ${BREAKER_COOLDOWN_MS / 1000}s`);
  } else if (to === 'closed') {
    console.log('[enrich] DexScreener breaker CLOSED — DexScreener calls resumed');
  }
});
