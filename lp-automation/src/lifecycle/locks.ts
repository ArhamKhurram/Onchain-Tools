// Per-position serialization.
//
// THE FAILURE MODE THIS PREVENTS: two transactions in flight for the same
// position. The loop has two independent lanes (plan §2) — a sub-second RPC
// crossing watcher and a slower Krystal poll — and they can fire for the same
// tokenId within milliseconds of each other. Without a lock, a confirmed range
// exit arriving while a compound is mid-broadcast produces two transactions
// built from the same pre-transaction state. Both simulate fine; the second one
// executes against a position the first one already moved. On a rebalance that
// is a double round-trip of gas and slippage, and possibly liquidity placed
// somewhere nobody chose.
//
// WHY REFUSE RATHER THAN QUEUE. A queued action would run against state read
// before the in-flight transaction landed — exactly the stale decision the lock
// exists to stop. Refusing costs at most one evaluation cycle: the watcher will
// re-emit, or the next poll tick will re-evaluate, against fresh state. Every
// refusal is logged, so a position wedged behind a lock is visible rather than
// silently idle.
//
// In-memory is sufficient and correct here: the guarantee needed is "one
// in-flight transaction per position PER PROCESS", and two processes signing
// for the same Safe is a deployment error the audit log's unresolved-intent
// check catches on the next start (see `unresolved.ts`).

/** Non-blocking mutual exclusion keyed by position tokenId. */
export class PositionLocks {
  private readonly held = new Set<string>();

  isHeld(tokenId: string): boolean {
    return this.held.has(tokenId);
  }

  /** tokenIds currently locked. For shutdown logging and diagnostics. */
  active(): string[] {
    return [...this.held];
  }

  /**
   * Run `fn` with the position locked, or report that it could not be acquired.
   *
   * Returns a discriminated result rather than throwing, because "another
   * action is already running for this position" is a normal, expected outcome
   * that the caller records and moves on from — not an error condition.
   */
  async tryRun<T>(
    tokenId: string,
    fn: () => Promise<T>,
  ): Promise<{ ran: true; value: T } | { ran: false }> {
    if (this.held.has(tokenId)) return { ran: false };
    this.held.add(tokenId);
    try {
      return { ran: true, value: await fn() };
    } finally {
      // `finally`, not a trailing delete: a throw inside `fn` must still release
      // the lock, or one failed action wedges that position until restart.
      this.held.delete(tokenId);
    }
  }
}
