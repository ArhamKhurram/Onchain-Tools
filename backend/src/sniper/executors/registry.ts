// The executor registry: one Executor per venue, plus the dry-run seam.
//
// Dry-run is a decorator over the registry, not a per-venue flag: when the
// process-level OCT_SNIPER_DRY_RUN is set, OR the rule opts in, resolution returns
// the DryRunExecutor regardless of the rule's real venue. That way a dry run
// exercises the whole fire path (idempotency, reservation, retry loop) and only
// the final network hop is swapped out.

import type { Executor, SnipeRule, Venue } from '../types.js';

/**
 * Process-wide dry-run kill switch.
 *
 * Accepts any common truthy spelling. Matching only `'1'` fails OPEN — an
 * operator who sets `OCT_SNIPER_DRY_RUN=true` expecting safety would get live
 * fire, which is the worst possible direction for this particular flag to be
 * wrong in.
 */
export function processDryRun(): boolean {
  const raw = process.env.OCT_SNIPER_DRY_RUN?.trim().toLowerCase();
  if (!raw) return false;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export class ExecutorRegistry {
  private byVenue = new Map<Venue, Executor>();

  constructor(private dryRunExecutor: Executor) {
    this.byVenue.set(dryRunExecutor.venue, dryRunExecutor);
  }

  register(executor: Executor): void {
    this.byVenue.set(executor.venue, executor);
  }

  /** True when this fire must not touch a real venue. */
  isDryRun(rule: SnipeRule): boolean {
    return processDryRun() || rule.dryRun;
  }

  /**
   * Resolve the executor for a rule. Throws if the rule's venue has no registered
   * executor or does not support the rule's chain — better to fail arming/firing
   * loudly than to route a fire nowhere.
   */
  resolve(rule: SnipeRule): Executor {
    if (this.isDryRun(rule)) return this.dryRunExecutor;

    const executor = this.byVenue.get(rule.venue);
    if (!executor) {
      throw new Error(`No executor registered for venue "${rule.venue}"`);
    }
    if (!executor.chains.includes(rule.chain)) {
      throw new Error(`Venue "${rule.venue}" does not support chain "${rule.chain}"`);
    }
    return executor;
  }
}
