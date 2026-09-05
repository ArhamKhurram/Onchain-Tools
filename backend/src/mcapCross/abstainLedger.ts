/**
 * How long a crossing is allowed to sit unresolved while the security provider
 * is unable to answer.
 *
 * THE PROBLEM THIS SOLVES. `gates.ts` returns `abstain` when it cannot tell —
 * GMGN errored, was rate-limit banned, or has never indexed the token. The
 * correct response is to leave `lastSeenMcap` untouched so the crossing is
 * re-detected next cycle, exactly as `crossing.ts` leaves `lastSeenUsd`
 * untouched on a missing price. That rule alone, though, has an ugly tail: a
 * token GMGN will NEVER index re-crosses forever, and burns one security call
 * per cycle, per token, for the life of the process. The abstain rule is right;
 * an unbounded abstain is not.
 *
 * So an unresolved crossing gets a bounded number of attempts and is then
 * recorded and dropped. The trade, stated plainly: a genuine token whose
 * security lookup is broken for longer than MAX_ATTEMPTS cycles loses that
 * alert. At the default (6 attempts on a 5-minute cadence) that is half an hour
 * of continuous provider failure — long past the point where the operator has
 * a bigger problem than one missed ping, and a bound is what stops a provider
 * outage from turning into a permanent request leak.
 *
 * Pure and in-memory: attempts reset on restart, which is the right default.
 * A fresh process has no reason to inherit another one's unluckiness.
 */

/** Attempts a single unresolved crossing gets before it is given up on. */
export const DEFAULT_MAX_ATTEMPTS = 6;

export type AbstainOutcome = 'retry' | 'give-up';

export class AbstainLedger {
  private attempts = new Map<string, number>();

  constructor(private readonly maxAttempts: number = DEFAULT_MAX_ATTEMPTS) {}

  /**
   * Count one unresolved attempt for `key`.
   *
   * 'retry' means leave the observation unwritten so the crossing is seen
   * again; 'give-up' means write it and stop asking. The counter is cleared on
   * give-up so a token that starts resolving later gets a full budget again
   * rather than being permanently poisoned by an old outage.
   */
  note(key: string): AbstainOutcome {
    const next = (this.attempts.get(key) ?? 0) + 1;
    if (next >= this.maxAttempts) {
      this.attempts.delete(key);
      return 'give-up';
    }
    this.attempts.set(key, next);
    return 'retry';
  }

  /** Forget a key — called whenever it produced a real verdict. */
  clear(key: string): void {
    this.attempts.delete(key);
  }

  /** Attempts recorded for a key. Exposed for tests and the coverage log. */
  attemptsFor(key: string): number {
    return this.attempts.get(key) ?? 0;
  }

  /** Unresolved crossings currently being retried. */
  size(): number {
    return this.attempts.size;
  }
}
