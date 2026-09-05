/**
 * Price alerts — the pure half: crossing detection. No I/O, no storage, no
 * clock. Unit-tested in backend/test/priceAlertCrossing.test.ts.
 *
 * WHY THIS EXISTS. The operator planned to buy a token in a 100-150K mcap band
 * and missed the fill twice: once because the token was never watchlisted, once
 * because they were not looking at the screen. Revival/breakout structurally
 * cannot cover that — they scan a universe built from contracts detected in the
 * user's own FEED and gate on dormancy vs the token's prior 72h peak, so a
 * token nobody in their rooms posted is invisible to them BY DESIGN. This is the
 * opposite shape: operator-chosen token + operator-chosen level → alert on
 * crossing. No detection, no scoring, no discovery, and per CLAUDE.md it stays
 * its own signal — never fused with revival, breakout, convergence, FOMO or
 * missed-runner.
 *
 * CROSSING, NOT LEVEL-TESTING. An 'above' alert fires on the transition from
 * "at or below the target" to "strictly above it" — not merely on observing a
 * value above the target. That distinction is the whole feature: a level test
 * would fire the instant you armed an alert on a token already trading past it,
 * which is exactly the alert the operator cannot act on.
 *
 * FIRST-OBSERVATION RULE (deliberate, and the one judgement call here). The
 * first time the poller sees an alert's token it RECORDS the value and arms;
 * it never fires on that observation. Reasoning:
 *   - There is no prior observation, so there is no transition to detect. Any
 *     firing rule on a single sample is a level test wearing a crossing's hat.
 *   - The failure modes are asymmetric. Firing on first sight sends a ping for
 *     a level that was already true when the alert was created — noise the
 *     operator learns to ignore, which is how an alert system dies. Staying
 *     quiet costs at most one cycle (~25s), because ANY genuine subsequent
 *     crossing fires normally.
 *   - It makes "arm an alert below the current price so it catches the way
 *     back down" work without a special case: the create is the baseline.
 * The cost, stated plainly: a token that crosses the target and comes back
 * within the same cycle is missed. That is inherent to sampling, not to this
 * rule.
 *
 * ABSTAIN ON MISSING DATA. No pair, no price, a failed request, or a
 * non-finite number is a data GAP, not a verdict. `lastSeenUsd` is left
 * untouched so the next real observation is compared against the last real
 * one, and nothing ever fires blind.
 *
 * WHERE THE DEXSCREENER HALF WENT. The batch-read bookkeeping that used to live
 * at the bottom of this file (the 30-pair cap and its halving retry) moved to
 * `marketData/dexBatch.ts` when the market-cap crossing signal needed the same
 * read. It is a workaround for a measured, undocumented upstream behaviour, and
 * a second copy of it would drift silently — by under-reporting tokens rather
 * than erroring. It is re-exported below so this module's existing importers
 * and tests are unchanged.
 *
 * `evaluateCrossing` itself is deliberately NOT specialised to a per-alert row:
 * it takes a direction, a target and two observations, so a fixed global target
 * (the 750K market-cap signal in `mcapCross/`) uses it verbatim. Reuse of this
 * pure helper across signals is not fusion — no detection state is shared, and
 * neither poller can see the other's tokens.
 */

import type { PriceAlertDirection, PriceAlertMetric } from '@oct/shared';
import type { MintSnapshot } from '../marketData/dexBatch.js';

// --- Crossing ---------------------------------------------------------------

export interface CrossingInput {
  direction: PriceAlertDirection;
  targetUsd: number;
  /** Last real observation, in the alert's metric. Null = never observed. */
  lastSeenUsd: number | null;
  /** This cycle's observation. Null = no data (abstain). */
  observedUsd: number | null;
}

/**
 * - `abstain`: no usable data this cycle. Write nothing.
 * - `arm`: first ever observation. Record `observedUsd`; do NOT fire.
 * - `record`: observed, no crossing. Record `observedUsd`; do NOT fire.
 * - `fire`: a genuine crossing. Record AND fire (one-shot).
 */
export type CrossingAction = 'abstain' | 'arm' | 'record' | 'fire';

export interface CrossingVerdict {
  action: CrossingAction;
  /** The value to persist as lastSeenUsd; null only when abstaining. */
  observedUsd: number | null;
}

const ABSTAIN: CrossingVerdict = { action: 'abstain', observedUsd: null };

/**
 * Pure crossing evaluation. See the module header for the first-observation
 * rule and the abstain rule.
 */
export function evaluateCrossing(input: CrossingInput): CrossingVerdict {
  const observed = input.observedUsd;
  if (observed == null || !Number.isFinite(observed) || observed <= 0) return ABSTAIN;
  if (!Number.isFinite(input.targetUsd)) return ABSTAIN;

  const last = input.lastSeenUsd;
  // First observation: baseline only. Never fires — there is no transition yet.
  if (last == null || !Number.isFinite(last)) return { action: 'arm', observedUsd: observed };

  const crossed =
    input.direction === 'above'
      ? last <= input.targetUsd && observed > input.targetUsd
      : last >= input.targetUsd && observed < input.targetUsd;

  return { action: crossed ? 'fire' : 'record', observedUsd: observed };
}

// --- DexScreener batch reads ------------------------------------------------
//
// Moved to marketData/dexBatch.ts (see the module header). Re-exported so
// nothing that imported them from here had to change.

export {
  DEX_PAIR_CAP,
  DEFAULT_BATCH_SIZE,
  chunkMints,
  snapshotsFromPairs,
  splitForRetry,
  wasTruncated,
  readDexSnapshots,
  type DexPair,
  type MintSnapshot,
} from '../marketData/dexBatch.js';

/** Read the value an alert's metric refers to out of a snapshot. */
export function valueForMetric(snapshot: MintSnapshot, metric: PriceAlertMetric): number | null {
  return metric === 'price' ? snapshot.priceUsd : snapshot.mcapUsd;
}
