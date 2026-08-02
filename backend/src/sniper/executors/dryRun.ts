// The dry-run executor. No network, no money. It exercises the full fire path so
// Milestone 1 can validate idempotency, the risk gate, and the retry loop against
// a funded-wallet-free happy path — and, via `outcomeFor`, against injected
// failures too.

import type { Chain, Executor, FireIntent, FireLeg, SendOutcome, Venue } from '../types.js';

export interface DryRunOptions {
  /**
   * Optional hook to force a specific outcome per (intent, leg). Defaults to a
   * synthetic fill. Tests use this to drive `dead` / `unknown` branches.
   */
  outcomeFor?: (intent: FireIntent, leg: FireLeg) => SendOutcome;
}

export class DryRunExecutor implements Executor {
  readonly venue: Venue = 'dryrun';
  readonly chains: readonly Chain[] = ['sol', 'bsc'];

  constructor(private opts: DryRunOptions = {}) {}

  async send(intent: FireIntent, leg: FireLeg, correlationId: string): Promise<SendOutcome> {
    if (this.opts.outcomeFor) return this.opts.outcomeFor(intent, leg);
    return {
      kind: 'filled',
      signature: `DRYRUN-${correlationId}`,
      amountIn: leg.amount,
      amountOut: leg.amount, // synthetic 1:1; no pricing in a dry run
      feePaid: 0,
    };
  }
}
