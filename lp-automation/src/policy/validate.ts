// Runtime validation for `AutomationPolicy` (plan §5).
//
// The policy arrives from a dashboard form and is persisted as a row — by the
// time the signer process reads it, TypeScript has told us nothing about it.
// This is the boundary where an untyped blob becomes an `AutomationPolicy`.
//
// Two rules govern the shape of this module:
//
//   1. It NEVER throws. The caller is a dashboard that must render every problem
//      at once so the operator can fix them in one pass. A thrown error surfaces
//      one issue and loses the rest, so every check accumulates into `issues`.
//   2. It fails closed. Unknown types, NaN, and missing fields are rejected —
//      note that the obvious `value <= 0` guard silently PASSES NaN, which is
//      exactly how a blank form field becomes an uncapped position size. Every
//      numeric check therefore starts from `Number.isFinite`.
//
// Hand-rolled rather than zod: `zod` is not a dependency of this workspace and
// the signer process should carry as little third-party code as it can.

import type { AutomationPolicy } from '../types.js';
import { ADDRESS_PATTERN } from './constants.js';

export interface PolicyValidationIssue {
  /** Dotted path to the offending field, e.g. `compoundTrigger.minFeesVsGasRatio`. */
  field: string;
  /** Operator-facing explanation. Safe to render verbatim in the dashboard. */
  message: string;
}

export interface PolicyValidationResult {
  valid: boolean;
  issues: PolicyValidationIssue[];
}

interface NumberRule {
  /** Inclusive lower bound. */
  min?: number;
  /** Inclusive upper bound. */
  max?: number;
  /** Exclusive lower bound — use for "must be strictly positive". */
  exclusiveMin?: number;
  integer?: boolean;
  /** Extra context appended to the message, explaining WHY the bound exists. */
  because?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates one numeric field, pushing at most one issue. Returns the number on
 * success and `null` on failure so cross-field checks can skip cleanly rather
 * than comparing against garbage.
 */
function checkNumber(
  issues: PolicyValidationIssue[],
  field: string,
  value: unknown,
  rule: NumberRule,
): number | null {
  const suffix = rule.because ? ` (${rule.because})` : '';

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    // Catches undefined, null, strings, NaN and ±Infinity in one gate. NaN in
    // particular defeats every ordinary comparison, so it must die here.
    issues.push({ field, message: `must be a finite number${suffix}` });
    return null;
  }
  if (rule.integer && !Number.isInteger(value)) {
    issues.push({ field, message: `must be a whole number${suffix}` });
    return null;
  }
  if (rule.exclusiveMin !== undefined && value <= rule.exclusiveMin) {
    issues.push({ field, message: `must be greater than ${rule.exclusiveMin}${suffix}` });
    return null;
  }
  if (rule.min !== undefined && value < rule.min) {
    issues.push({ field, message: `must be at least ${rule.min}${suffix}` });
    return null;
  }
  if (rule.max !== undefined && value > rule.max) {
    issues.push({ field, message: `must be at most ${rule.max}${suffix}` });
    return null;
  }
  return value;
}

function checkSection(
  issues: PolicyValidationIssue[],
  field: string,
  value: unknown,
): Record<string, unknown> | null {
  if (!isRecord(value)) {
    issues.push({ field, message: 'must be an object' });
    return null;
  }
  return value;
}

/**
 * Validate an untrusted value as an `AutomationPolicy`.
 *
 * Never throws. `issues` is empty if and only if `valid` is true.
 */
export function validatePolicy(input: unknown): PolicyValidationResult {
  const issues: PolicyValidationIssue[] = [];

  if (!isRecord(input)) {
    return { valid: false, issues: [{ field: '', message: 'policy must be an object' }] };
  }

  checkNumber(issues, 'version', input.version, {
    exclusiveMin: 0,
    integer: true,
    because: 'versions are positive integers assigned in order',
  });

  // Phase 1 is single-chain by decision (plan §1/§10). An unrecognized chain must
  // be rejected outright — the Guard's destination allowlist is chain-specific,
  // so a policy naming a chain we have no Guard for could only ever fail on-chain.
  if (input.chain !== 'robinhood') {
    issues.push({
      field: 'chain',
      message: "must be 'robinhood' (phase 1 supports no other chain)",
    });
  }

  const maxPositionSizeUsd = checkNumber(issues, 'maxPositionSizeUsd', input.maxPositionSizeUsd, {
    exclusiveMin: 0,
    because: 'a zero or negative cap can never authorize a position',
  });

  const dailySpendCapUsd = checkNumber(issues, 'dailySpendCapUsd', input.dailySpendCapUsd, {
    exclusiveMin: 0,
    because: 'a zero or negative cap can never authorize a position',
  });

  // Cross-field: a daily cap below one position's size is self-contradictory —
  // every entry would be refused, on-chain, after paying gas to find out.
  if (
    maxPositionSizeUsd !== null &&
    dailySpendCapUsd !== null &&
    dailySpendCapUsd < maxPositionSizeUsd
  ) {
    issues.push({
      field: 'dailySpendCapUsd',
      message: `must be at least maxPositionSizeUsd (${maxPositionSizeUsd}) — a smaller daily cap can never fund a single position`,
    });
  }

  if (!Array.isArray(input.allowedPools)) {
    issues.push({ field: 'allowedPools', message: 'must be an array of pool addresses' });
  } else {
    input.allowedPools.forEach((entry, index) => {
      if (typeof entry !== 'string' || !ADDRESS_PATTERN.test(entry)) {
        issues.push({
          field: `allowedPools[${index}]`,
          message: 'must be a 0x-prefixed 20-byte hex address',
        });
      }
    });
  }

  const criteria = checkSection(issues, 'poolSelectionCriteria', input.poolSelectionCriteria);
  if (criteria) {
    checkNumber(issues, 'poolSelectionCriteria.minTvlUsd', criteria.minTvlUsd, { min: 0 });
    checkNumber(issues, 'poolSelectionCriteria.min24hVolumeUsd', criteria.min24hVolumeUsd, {
      min: 0,
    });
    checkNumber(issues, 'poolSelectionCriteria.maxIlRiskScore', criteria.maxIlRiskScore, {
      min: 0,
      max: 100,
      because: 'the IL risk score is defined on a 0-100 scale',
    });
  }

  const compound = checkSection(issues, 'compoundTrigger', input.compoundTrigger);
  if (compound) {
    // Hard floor of 1.0. Below 1 the policy is instructing us to spend more on
    // gas than the fees being claimed are worth — always wrong, in every market
    // condition, so it is a validation error rather than a tuning choice.
    checkNumber(issues, 'compoundTrigger.minFeesVsGasRatio', compound.minFeesVsGasRatio, {
      min: 1,
      because: 'compounding for less than the gas it costs is always a net loss',
    });
    checkNumber(issues, 'compoundTrigger.maxIntervalHours', compound.maxIntervalHours, {
      exclusiveMin: 0,
      because: 'a zero interval would compound on every single tick',
    });
  }

  const rebalance = checkSection(issues, 'rebalanceTrigger', input.rebalanceTrigger);
  if (rebalance) {
    checkNumber(issues, 'rebalanceTrigger.rangeExitPercent', rebalance.rangeExitPercent, {
      exclusiveMin: 0,
      because: 'a zero threshold rebalances on the first tick outside the range',
    });
  }

  const buffer = checkSection(issues, 'switchingBuffer', input.switchingBuffer);
  if (buffer) {
    // Zero is permitted (it means "any positive advantage counts") because the
    // sustained-duration half of the buffer still gates the move. Negative is
    // not: it would authorize switching into a strictly worse pool.
    checkNumber(issues, 'switchingBuffer.minEfficiencyDeltaPercent', buffer.minEfficiencyDeltaPercent, {
      min: 0,
      because: 'a negative delta would authorize switching into a worse pool',
    });
    checkNumber(issues, 'switchingBuffer.sustainedDurationMinutes', buffer.sustainedDurationMinutes, {
      exclusiveMin: 0,
      because: 'zero duration removes the buffer entirely, allowing a momentary crossover to trigger a move',
    });
  }

  return { valid: issues.length === 0, issues };
}

/** Type guard form, for call sites that only need the yes/no. */
export function isValidPolicy(input: unknown): input is AutomationPolicy {
  return validatePolicy(input).valid;
}
