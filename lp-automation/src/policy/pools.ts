// Pool admission (plan §9 point 2) — read this comment before touching either
// function, because conflating them would be a real safety bug rather than a
// style problem.
//
//   isPoolAllowed()     — the GATE. Explicit membership in `policy.allowedPools`
//                         and nothing else. This is the only question the
//                         lifecycle code is ever allowed to ask before entering
//                         or switching into a pool.
//
//   poolMeetsCriteria() — the SHORTLIST. Answers "should a human be shown this
//                         pool as a candidate?" It has no authority whatsoever.
//                         A pool that satisfies every criterion is still not
//                         allowed until a person ticks it in the dashboard.
//
// The plan is explicit: "Krystal never auto-admits a pool" (§9.2). The failure
// mode being designed against is a pool-discovery bug — or a manipulated TVL /
// volume number on a four-week-old chain — turning into capital deployment with
// nobody in the loop. Criteria are advisory forever; only the allowlist admits.
//
// If you ever find yourself wanting `isPoolAllowed` to fall back to
// `poolMeetsCriteria` when the allowlist is empty: that is the bug. An empty
// allowlist means "do nothing", which is the correct behaviour.

import type { Address, AutomationPolicy, PoolCandidate } from '../types.js';
import { CHAIN_IDS } from '../types.js';
import { ADDRESS_PATTERN } from './constants.js';

/**
 * THE GATE. True only if `poolAddress` is explicitly listed in
 * `policy.allowedPools`. Case-insensitive (the dashboard may supply a
 * checksummed address); never consults `poolSelectionCriteria`.
 */
export function isPoolAllowed(policy: AutomationPolicy, poolAddress: string): boolean {
  // A malformed address is not allowed, and is not an exception either — the
  // caller is a hot path that must degrade to "no" rather than crash.
  if (typeof poolAddress !== 'string' || !ADDRESS_PATTERN.test(poolAddress)) return false;
  if (!Array.isArray(policy.allowedPools)) return false;

  const needle = poolAddress.toLowerCase();
  return policy.allowedPools.some(
    (allowed) => typeof allowed === 'string' && allowed.toLowerCase() === needle,
  );
}

export type CriterionId = 'chain' | 'minTvlUsd' | 'min24hVolumeUsd' | 'maxIlRiskScore';

export interface CriteriaEvaluation {
  /** True when every criterion passes. Grants NOTHING — see the module comment. */
  meets: boolean;
  /** Which criteria failed, for the dashboard to explain the omission. */
  failures: CriterionId[];
  /** Already on the allowlist, so the picker can show it as selected. */
  alreadyAllowed: boolean;
}

/**
 * THE SHORTLIST. Evaluates a discovered pool against the policy's surfacing
 * criteria so the dashboard can offer it for manual selection.
 *
 * `ilRiskScore` is passed separately and explicitly because `PoolCandidate`
 * carries no such field — the scoring model is still TBD (`types.ts`). Pass
 * `null` when it has not been computed. An unknown risk score FAILS the
 * criterion; it is not treated as low risk. Unknown is not safe.
 */
export function poolMeetsCriteria(
  policy: AutomationPolicy,
  pool: PoolCandidate,
  ilRiskScore: number | null,
): CriteriaEvaluation {
  const failures: CriterionId[] = [];
  const criteria = policy.poolSelectionCriteria;

  // A pool on the wrong chain can never be entered — the Guard's destination
  // allowlist is chain-specific — so it should not be surfaced either.
  if (pool.chainId !== CHAIN_IDS[policy.chain]) failures.push('chain');

  if (!Number.isFinite(pool.tvlUsd) || pool.tvlUsd < criteria.minTvlUsd) {
    failures.push('minTvlUsd');
  }
  if (!Number.isFinite(pool.volume24hUsd) || pool.volume24hUsd < criteria.min24hVolumeUsd) {
    failures.push('min24hVolumeUsd');
  }
  if (ilRiskScore === null || !Number.isFinite(ilRiskScore) || ilRiskScore > criteria.maxIlRiskScore) {
    failures.push('maxIlRiskScore');
  }

  return {
    meets: failures.length === 0,
    failures,
    alreadyAllowed: isPoolAllowed(policy, pool.address),
  };
}

/**
 * Convenience for the dashboard's candidate picker: the subset of discovered
 * pools worth showing. Still grants nothing — the return value is a list of
 * suggestions, and the caller must persist an operator's explicit choice into
 * `allowedPools` before any of them can be entered.
 */
export function surfaceCandidates(
  policy: AutomationPolicy,
  pools: readonly PoolCandidate[],
  ilRiskScores: ReadonlyMap<Address, number>,
): PoolCandidate[] {
  return pools.filter((pool) => {
    const score = ilRiskScores.get(pool.address.toLowerCase() as Address);
    return poolMeetsCriteria(policy, pool, score ?? null).meets;
  });
}
