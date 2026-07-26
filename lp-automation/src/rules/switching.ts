// The switching buffer (plan §6) — the single most safety-relevant rule here.
//
// An exit-and-move pays gas and slippage on BOTH legs: out of the current pool
// and into the candidate. A move made on a crossover that reverts a minute later
// is a guaranteed loss with no upside, and a naive "is the candidate better?"
// check will make that trade repeatedly, because APR readings on a young chain
// are noisy by nature. The plan's acceptance criteria name this directly: a
// transient one-tick advantage must NOT trigger a move.
//
// So a move requires BOTH:
//   1. The efficiency delta exceeds `minEfficiencyDeltaPercent`, AND
//   2. it has held CONTINUOUSLY for `sustainedDurationMinutes`.
//
// "Continuously" is doing real work in (2). Three things break a streak:
//   • the delta dropping back to or below the threshold on any observed tick
//   • the candidate changing (a streak belongs to one specific candidate pool)
//   • an unobserved gap in the tick series — see the observation-gap note below
//
// -- State model -------------------------------------------------------------
//
// The caller owns storage; this function stays pure. Every call takes the prior
// `CrossoverState | null` and returns the next one alongside the decision. The
// state is deliberately tiny (a pool address and two timestamps) so it survives
// a process restart as a trivial row, and so its semantics are auditable at a
// glance rather than being an accumulating counter whose history is unknowable.
//
// It records `since` (when the streak began) rather than an elapsed-minutes
// counter on purpose: an accumulator can be incremented by a caller that ticks
// twice in one second, and it cannot distinguish "sustained for an hour" from
// "advantageous on sixty scattered ticks over a week". A start timestamp
// compared against `now` can only ever mean the former.

import type { Address, AutomationPolicy, Decision, EfficiencyScore } from '../types.js';
import { isPoolAllowed } from '../policy/pools.js';
import { MS_PER_MINUTE } from './triggers.js';

/** One side of the comparison: a pool and its freshly computed score. */
export interface ScoredPool {
  poolAddress: Address;
  efficiency: EfficiencyScore;
}

/**
 * Sustained-crossover streak. Caller persists this verbatim between ticks and
 * hands it back on the next call. `null` means "no streak in progress".
 */
export interface CrossoverState {
  /** The candidate this streak is about. A different candidate is a new streak. */
  candidatePool: Address;
  /** When the advantage was first observed, and has held ever since. */
  since: number;
  /** The most recent tick at which it still held — used for gap detection. */
  lastSeen: number;
}

export interface SwitchEvaluation {
  decision: Decision;
  /** Next state to persist. `null` clears any streak. */
  state: CrossoverState | null;
}

export interface SwitchOptions {
  /**
   * How long a hole in the tick series may be before the streak is considered
   * interrupted. Defaults to `DEFAULT_MAX_OBSERVATION_GAP_MINUTES`.
   */
  maxObservationGapMinutes?: number;
}

/**
 * Ten minutes. A streak asserts the advantage held continuously, but we can only
 * assert what we observed — if the evaluator was down, redeployed, or throttled
 * for half an hour, the advantage may have lapsed and returned unseen and the
 * streak would be a lie. Past this gap the streak restarts from `now`, costing us
 * one more waiting period and nothing else. This is not in the policy schema
 * because it is a property of our own observation cadence, not of the strategy.
 */
export const DEFAULT_MAX_OBSERVATION_GAP_MINUTES = 10;

/**
 * Evaluate whether to leave `current` for `candidate`.
 *
 * A firing decision has `action: 'exit'` — it authorizes LEAVING the current
 * pool. Entering the candidate is a separate `'enter'` decision made by the
 * lifecycle layer against the same policy, so a failed exit can never leave us
 * having entered twice.
 *
 * The efficiency delta is measured in PERCENTAGE POINTS of annualized net
 * efficiency: `(candidate − current) × 100`. See the note in the report — the
 * plan's `minEfficiencyDeltaPercent` does not say whether it is absolute or
 * relative, and relative is unusable here because net efficiency legitimately
 * passes through and below zero, where a relative comparison either divides by
 * ~0 or flips sign.
 */
export function evaluateSwitch(
  current: ScoredPool,
  candidate: ScoredPool,
  policy: AutomationPolicy,
  history: CrossoverState | null,
  now: number,
  options: SwitchOptions = {},
): SwitchEvaluation {
  const buffer = policy.switchingBuffer;
  const maxGapMinutes = options.maxObservationGapMinutes ?? DEFAULT_MAX_OBSERVATION_GAP_MINUTES;

  const currentPool = current.poolAddress?.toLowerCase() as Address | undefined;
  const candidatePool = candidate.poolAddress?.toLowerCase() as Address | undefined;

  const deltaPercent =
    (candidate.efficiency.netEfficiency - current.efficiency.netEfficiency) * 100;

  const priorSince =
    history && candidatePool && history.candidatePool.toLowerCase() === candidatePool
      ? history.since
      : null;

  const snapshot: Record<string, unknown> = {
    currentPool,
    candidatePool,
    currentNetEfficiency: current.efficiency.netEfficiency,
    candidateNetEfficiency: candidate.efficiency.netEfficiency,
    currentInputs: current.efficiency.inputs,
    candidateInputs: candidate.efficiency.inputs,
    currentCostDrag: current.efficiency.costDrag,
    candidateCostDrag: candidate.efficiency.costDrag,
    deltaPercent,
    minEfficiencyDeltaPercent: buffer.minEfficiencyDeltaPercent,
    requiredSustainedMinutes: buffer.sustainedDurationMinutes,
    streakSince: priorSince,
    streakLastSeen: history?.lastSeen ?? null,
    maxObservationGapMinutes: maxGapMinutes,
    now,
    policyVersion: policy.version,
  };

  const result = (
    action: Decision['action'],
    rule: string,
    reason: string,
    state: CrossoverState | null,
    extra?: Record<string, unknown>,
  ): SwitchEvaluation => ({
    decision: { action, rule, reason, snapshot: extra ? { ...snapshot, ...extra } : snapshot },
    state,
  });

  // --- Refusals that also clear any streak --------------------------------
  // Each of these means "this comparison is not one we can act on", so leaving a
  // half-built streak in place would let it resume later as if the intervening
  // ticks had counted.

  if (!currentPool || !candidatePool) {
    return result('none', 'switch.invalid_input', 'a pool address is missing', null);
  }

  if (currentPool === candidatePool) {
    return result('none', 'switch.same_pool', 'candidate is the pool already held', null);
  }

  // The allowlist gate applies here exactly as it does on entry. A candidate the
  // operator never ticked must never be switched into, no matter how good its
  // score or how long it has held (plan §9.2).
  if (!isPoolAllowed(policy, candidatePool)) {
    return result(
      'none',
      'switch.pool_not_allowed',
      `candidate ${candidatePool} is not on the policy allowlist`,
      null,
    );
  }

  if (!Number.isFinite(deltaPercent)) {
    return result('none', 'switch.invalid_score', 'efficiency delta is not a finite number', null);
  }

  // Defensive against a policy that bypassed validation. `sustainedDurationMinutes <= 0`
  // would make the buffer fire on the very first tick of an advantage, which is
  // the exact behaviour this whole module exists to prevent.
  if (
    !Number.isFinite(buffer.sustainedDurationMinutes) ||
    buffer.sustainedDurationMinutes <= 0 ||
    !Number.isFinite(buffer.minEfficiencyDeltaPercent) ||
    buffer.minEfficiencyDeltaPercent < 0
  ) {
    return result(
      'none',
      'switch.invalid_policy',
      'switching buffer is not usable; refusing to switch',
      null,
    );
  }

  // --- The threshold arm ---------------------------------------------------

  if (deltaPercent <= buffer.minEfficiencyDeltaPercent) {
    // Streak broken. Returning null (rather than keeping `since`) is what makes a
    // lapse mid-window RESET the timer instead of pausing it.
    return result(
      'none',
      'switch.below_threshold',
      `delta ${deltaPercent.toFixed(4)}pp does not exceed the ${buffer.minEfficiencyDeltaPercent}pp threshold; any streak is reset`,
      null,
    );
  }

  // --- The sustained arm ---------------------------------------------------

  if (priorSince === null) {
    return result(
      'none',
      'switch.streak_started',
      `delta ${deltaPercent.toFixed(4)}pp exceeds the threshold; starting the ${buffer.sustainedDurationMinutes}min sustained window`,
      { candidatePool, since: now, lastSeen: now },
      { sustainedMinutes: 0 },
    );
  }

  const gapMinutes = (now - (history?.lastSeen ?? now)) / MS_PER_MINUTE;
  if (gapMinutes < 0 || gapMinutes > maxGapMinutes) {
    // Either the clock went backwards or we stopped observing. Both mean the
    // streak's continuity claim is unverifiable, so it restarts from now.
    return result(
      'none',
      'switch.observation_gap',
      `${gapMinutes.toFixed(2)}min since the last observation exceeds the ${maxGapMinutes}min limit; restarting the sustained window`,
      { candidatePool, since: now, lastSeen: now },
      { sustainedMinutes: 0, observationGapMinutes: gapMinutes },
    );
  }

  const sustainedMinutes = (now - priorSince) / MS_PER_MINUTE;
  const nextState: CrossoverState = { candidatePool, since: priorSince, lastSeen: now };

  if (sustainedMinutes >= buffer.sustainedDurationMinutes) {
    return result(
      'exit',
      'switch.sustained_advantage',
      `delta ${deltaPercent.toFixed(4)}pp has exceeded the ${buffer.minEfficiencyDeltaPercent}pp threshold continuously for ${sustainedMinutes.toFixed(2)}min (>= ${buffer.sustainedDurationMinutes}min)`,
      nextState,
      { sustainedMinutes, observationGapMinutes: gapMinutes },
    );
  }

  return result(
    'none',
    'switch.sustaining',
    `delta ${deltaPercent.toFixed(4)}pp held for ${sustainedMinutes.toFixed(2)}min of the required ${buffer.sustainedDurationMinutes}min`,
    nextState,
    { sustainedMinutes, observationGapMinutes: gapMinutes },
  );
}
