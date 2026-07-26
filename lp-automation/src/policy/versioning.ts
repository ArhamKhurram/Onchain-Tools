// Policy versioning (plan §5, source spec §5.1).
//
// The property being enforced: "changing the default does NOT retroactively
// touch open positions unless explicitly told to apply-to-all."
//
// The way that property gets broken in practice is never a deliberate decision —
// it is a `policies.at(-1)` or a `?? currentPolicy` written somewhere in the
// evaluator because a lookup returned undefined and something had to be
// returned. So the model here has exactly two entry points and neither of them
// can fall back:
//
//   resolvePolicyForPosition()  — pinned lookup. Fails closed on any ambiguity;
//                                 there is no "close enough" version.
//   applyPolicyToAll()          — the ONLY way a position's pinned version
//                                 changes. Named to be conspicuous in a diff.
//
// Both are pure. Storage of the bindings and of the policy set belongs to the
// caller; nothing here reads or writes.

import type { AutomationPolicy } from '../types.js';

/**
 * The minimum a caller must record when opening a position: which policy version
 * it was opened under. Structurally satisfied by an `LpPosition` augmented with
 * `policyVersion`, so callers can pass their own richer row straight in.
 */
export interface PolicyBinding {
  tokenId: string;
  policyVersion: number;
}

export type PolicyResolutionFailure =
  /** No policies supplied at all — a bootstrapping error, not a data error. */
  | 'no_policies'
  /** The pinned version is not in the set. Refuse rather than substitute. */
  | 'unknown_version'
  /** Two policies share a version number. The set is corrupt; trust none of it. */
  | 'duplicate_version';

export type PolicyResolution =
  | { ok: true; policy: AutomationPolicy }
  | { ok: false; reason: PolicyResolutionFailure; requestedVersion: number };

/**
 * Resolve the policy a position is pinned to.
 *
 * Deliberately has no fallback. If the pinned version is missing or ambiguous
 * the correct behaviour is to stop evaluating that position and raise it for
 * manual attention — NOT to evaluate it under whatever policy happens to be
 * newest, which is precisely the retroactive application this module exists to
 * prevent.
 */
export function resolvePolicyForPosition(
  position: PolicyBinding,
  policies: readonly AutomationPolicy[],
): PolicyResolution {
  const requestedVersion = position.policyVersion;

  if (policies.length === 0) {
    return { ok: false, reason: 'no_policies', requestedVersion };
  }

  const matches = policies.filter((policy) => policy.version === requestedVersion);
  if (matches.length === 0) {
    return { ok: false, reason: 'unknown_version', requestedVersion };
  }
  if (matches.length > 1) {
    // Two rows claiming the same version means we cannot know which rules the
    // position was actually opened under. Picking either one would be a guess.
    return { ok: false, reason: 'duplicate_version', requestedVersion };
  }

  return { ok: true, policy: matches[0]! };
}

/**
 * The current default — what a NEW position inherits with zero setup
 * (source §5.1). Highest version number wins; the array order is not trusted.
 * Returns null for an empty set rather than inventing one.
 */
export function currentDefaultPolicy(
  policies: readonly AutomationPolicy[],
): AutomationPolicy | null {
  let best: AutomationPolicy | null = null;
  for (const policy of policies) {
    if (!Number.isFinite(policy.version)) continue;
    if (best === null || policy.version > best.version) best = policy;
  }
  return best;
}

/** The version a newly edited policy should be saved under. */
export function nextPolicyVersion(policies: readonly AutomationPolicy[]): number {
  const current = currentDefaultPolicy(policies);
  return current === null ? 1 : current.version + 1;
}

export type ApplyToAllResult<T extends PolicyBinding> =
  | { ok: true; bindings: T[]; changed: number }
  | { ok: false; reason: 'unknown_version'; requestedVersion: number };

/**
 * The explicit apply-to-all path — the only sanctioned way an already-open
 * position's policy changes.
 *
 * Pure: returns new binding objects, mutating nothing. `changed` is reported so
 * the caller can log "re-pinned N open positions from v2 to v3" in the audit
 * trail; a silent re-pin would be indistinguishable from the retroactive drift
 * this module forbids.
 */
export function applyPolicyToAll<T extends PolicyBinding>(
  bindings: readonly T[],
  policies: readonly AutomationPolicy[],
  targetVersion: number,
): ApplyToAllResult<T> {
  // Re-pinning onto a version that does not exist would strand every position,
  // so verify the target resolves before touching anything.
  const target = policies.filter((policy) => policy.version === targetVersion);
  if (target.length !== 1) {
    return { ok: false, reason: 'unknown_version', requestedVersion: targetVersion };
  }

  let changed = 0;
  const next = bindings.map((binding) => {
    if (binding.policyVersion === targetVersion) return binding;
    changed += 1;
    return { ...binding, policyVersion: targetVersion };
  });

  return { ok: true, bindings: next, changed };
}
