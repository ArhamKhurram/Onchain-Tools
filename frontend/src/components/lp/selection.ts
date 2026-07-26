// Surfaced ≠ allowlisted.
//
// This is the UI half of the rule stated in `lp-automation/src/policy/pools.ts`:
//
//   poolSelectionCriteria SURFACES a pool for a human to look at.
//   Only explicit membership in `allowedPools` ADMITS it.
//
// Nothing in this module may ever return "allowlisted" as a consequence of a
// pool meeting the criteria. The row status below is derived from the allowlist
// arrays and from nothing else — criteria only affect which rows exist at all.

import { LP_CHAIN_IDS, type LpChainSlug, type PoolCandidate, type PoolSelectionCriteria } from './types';

export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

export function isInAllowlist(allowlist: readonly string[], address: string): boolean {
  const needle = normalizeAddress(address);
  if (!needle) return false;
  return allowlist.some((entry) => normalizeAddress(entry) === needle);
}

export function toggleAllowlist(allowlist: readonly string[], address: string): string[] {
  const needle = normalizeAddress(address);
  if (!needle) return [...allowlist];
  if (isInAllowlist(allowlist, needle)) {
    return allowlist.filter((entry) => normalizeAddress(entry) !== needle);
  }
  return [...allowlist, needle];
}

/**
 * A pool's standing in the picker.
 *
 * `surfaced` is the important one: it means the pool passed every filter and is
 * still doing nothing. The four states exist so the table can distinguish what
 * is live from what is merely staged in an unsaved edit — a checkbox that looks
 * identical before and after saving would be the obvious way to believe capital
 * is deployable when it is not.
 */
export type PoolRowStatus = 'allowlisted' | 'pending_add' | 'pending_remove' | 'surfaced';

export function poolRowStatus(
  address: string,
  draftAllowlist: readonly string[],
  savedAllowlist: readonly string[],
): PoolRowStatus {
  const inDraft = isInAllowlist(draftAllowlist, address);
  const inSaved = isInAllowlist(savedAllowlist, address);
  if (inDraft && inSaved) return 'allowlisted';
  if (inDraft) return 'pending_add';
  if (inSaved) return 'pending_remove';
  return 'surfaced';
}

/** True only for states in which the signer may actually enter the pool today. */
export function isActiveForAutomation(status: PoolRowStatus): boolean {
  return status === 'allowlisted' || status === 'pending_remove';
}

export interface AllowlistSummary {
  /** Candidates returned by discovery — i.e. pools the operator can see. */
  surfacedCount: number;
  /** Surfaced pools that are ticked in the current draft. */
  selectedCount: number;
  /** Surfaced, passing every filter, and deliberately not ticked. */
  ignoredCount: number;
  pendingAdds: number;
  pendingRemovals: number;
  /**
   * Addresses on the allowlist that discovery did not return this time — a pool
   * can stop meeting the criteria without leaving the allowlist. Surfacing them
   * separately keeps the persisted allowlist from silently disappearing from
   * view while it is still fully in force.
   */
  allowlistedOffScreen: string[];
  /** Total entries in the draft allowlist (what a save would persist). */
  draftAllowlistSize: number;
}

export function summarizeAllowlist(
  candidates: readonly PoolCandidate[],
  draftAllowlist: readonly string[],
  savedAllowlist: readonly string[],
): AllowlistSummary {
  let selectedCount = 0;
  let pendingAdds = 0;
  let pendingRemovals = 0;

  for (const pool of candidates) {
    const status = poolRowStatus(pool.address, draftAllowlist, savedAllowlist);
    if (status === 'allowlisted' || status === 'pending_add') selectedCount += 1;
    if (status === 'pending_add') pendingAdds += 1;
    if (status === 'pending_remove') pendingRemovals += 1;
  }

  const visible = new Set(candidates.map((pool) => normalizeAddress(pool.address)));
  const allowlistedOffScreen = Array.from(
    new Set(draftAllowlist.map(normalizeAddress).filter((entry) => entry && !visible.has(entry))),
  );

  return {
    surfacedCount: candidates.length,
    selectedCount,
    ignoredCount: candidates.length - selectedCount,
    pendingAdds,
    pendingRemovals,
    allowlistedOffScreen,
    draftAllowlistSize: new Set(draftAllowlist.map(normalizeAddress).filter(Boolean)).size,
  };
}

// --- Local criteria re-check ------------------------------------------------

export type CriterionId = 'chain' | 'minTvlUsd' | 'min24hVolumeUsd';

/**
 * Re-evaluates the criteria the client can actually check, so edits to the
 * criteria fields show their effect on the visible table before a save.
 *
 * `maxIlRiskScore` is deliberately absent: `PoolCandidate` carries no risk
 * score (the model is TBD), and in `pools.ts` an unknown score FAILS. Guessing
 * a pass here would be the one place where the dashboard is more permissive
 * than the signer, so the criterion is simply not evaluated client-side and the
 * UI says so.
 */
export function evaluateVisibleCriteria(
  pool: PoolCandidate,
  chain: LpChainSlug,
  criteria: Pick<PoolSelectionCriteria, 'minTvlUsd' | 'min24hVolumeUsd'>,
): CriterionId[] {
  const failures: CriterionId[] = [];
  if (pool.chainId !== LP_CHAIN_IDS[chain]) failures.push('chain');
  if (!Number.isFinite(pool.tvlUsd) || pool.tvlUsd < criteria.minTvlUsd) failures.push('minTvlUsd');
  if (!Number.isFinite(pool.volume24hUsd) || pool.volume24hUsd < criteria.min24hVolumeUsd) {
    failures.push('min24hVolumeUsd');
  }
  return failures;
}

// --- Sorting ----------------------------------------------------------------

export type PoolSortKey = 'pair' | 'tvl' | 'volume' | 'fee' | 'apr' | 'status';
export type SortDir = 'asc' | 'desc';

function statusRank(status: PoolRowStatus): number {
  switch (status) {
    case 'allowlisted':
      return 0;
    case 'pending_add':
      return 1;
    case 'pending_remove':
      return 2;
    default:
      return 3;
  }
}

/** Non-mutating sort. Ties break on address so the order is stable across renders. */
export function sortCandidates(
  candidates: readonly PoolCandidate[],
  key: PoolSortKey,
  dir: SortDir,
  draftAllowlist: readonly string[],
  savedAllowlist: readonly string[],
): PoolCandidate[] {
  const factor = dir === 'asc' ? 1 : -1;
  return [...candidates].sort((a, b) => {
    let delta = 0;
    switch (key) {
      case 'pair':
        delta = `${a.token0?.symbol ?? ''}${a.token1?.symbol ?? ''}`.localeCompare(
          `${b.token0?.symbol ?? ''}${b.token1?.symbol ?? ''}`,
        );
        break;
      case 'tvl':
        delta = (a.tvlUsd || 0) - (b.tvlUsd || 0);
        break;
      case 'volume':
        delta = (a.volume24hUsd || 0) - (b.volume24hUsd || 0);
        break;
      case 'fee':
        delta = (a.feeTierBps || 0) - (b.feeTierBps || 0);
        break;
      case 'apr':
        delta = (a.feeApr || 0) - (b.feeApr || 0);
        break;
      case 'status':
        delta =
          statusRank(poolRowStatus(a.address, draftAllowlist, savedAllowlist)) -
          statusRank(poolRowStatus(b.address, draftAllowlist, savedAllowlist));
        break;
    }
    if (delta !== 0) return delta * factor;
    return normalizeAddress(a.address).localeCompare(normalizeAddress(b.address));
  });
}
