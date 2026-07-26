// Policy engine (plan §5) — schema validation, conservative defaults, version
// pinning, and pool admission. Everything here is pure: no chain, no API, no I/O.

export { ADDRESS_PATTERN, isAddressLike } from './constants.js';
export { DEFAULT_POLICY } from './defaults.js';
export { validatePolicy, isValidPolicy } from './validate.js';
export type { PolicyValidationIssue, PolicyValidationResult } from './validate.js';
export { isPoolAllowed, poolMeetsCriteria, surfaceCandidates } from './pools.js';
export type { CriteriaEvaluation, CriterionId } from './pools.js';
export {
  resolvePolicyForPosition,
  currentDefaultPolicy,
  nextPolicyVersion,
  applyPolicyToAll,
} from './versioning.js';
export type {
  PolicyBinding,
  PolicyResolution,
  PolicyResolutionFailure,
  ApplyToAllResult,
} from './versioning.js';
