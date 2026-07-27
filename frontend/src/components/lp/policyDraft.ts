// The editable form state behind the policy editor, plus a client-side mirror
// of `lp-automation/src/policy/validate.ts`.
//
// Two rules carried over from the server-side validator, for the same reasons:
//
//   1. Nothing throws. The operator must see every problem in one pass, so
//      checks accumulate into a list instead of failing fast.
//   2. It fails closed. Every numeric check starts from `Number.isFinite`,
//      because the obvious `value <= 0` guard passes NaN — which is exactly how
//      a blank form field would become an uncapped position size.
//
// This mirror exists to give instant feedback, NOT to decide anything. The
// server's 400 is authoritative; see `parseFieldIssues` for how its issues are
// merged back in.

import type {
  AutomationPolicy,
  AutomationPolicyPayload,
  LpChainSlug,
  PolicyFieldIssue,
  RangeStrategy,
} from './types';

/** The three range strategies, in display order. Source of truth for the enum check. */
export const RANGE_STRATEGIES: readonly RangeStrategy[] = ['narrow', 'wide', 'full'];

/** Anything the server did not store as a known strategy falls back to narrow. */
function normalizeRangeStrategy(value: unknown): RangeStrategy {
  return RANGE_STRATEGIES.includes(value as RangeStrategy) ? (value as RangeStrategy) : 'narrow';
}

/**
 * Numeric fields are held as strings so a half-typed value ("2.", "") survives
 * a render without being coerced to 0 — silently reading a cleared field as
 * zero is how a form field turns into a policy nobody chose.
 */
export interface PolicyDraft {
  chain: LpChainSlug;
  maxPositionSizeUsd: string;
  dailySpendCapUsd: string;
  allowedPools: string[];
  poolSelectionCriteria: {
    minTvlUsd: string;
    min24hVolumeUsd: string;
    maxIlRiskScore: string;
  };
  compoundTrigger: {
    enabled: boolean;
    minFeesVsGasRatio: string;
    maxIntervalHours: string;
  };
  rebalanceTrigger: {
    enabled: boolean;
    rangeExitPercent: string;
    rangeStrategy: RangeStrategy;
  };
  switchingBuffer: {
    minEfficiencyDeltaPercent: string;
    sustainedDurationMinutes: string;
  };
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/**
 * Mirrors `lp-automation/src/policy/defaults.ts`. Every number is chosen to be
 * too small rather than merely reasonable — raising a cap here takes seconds,
 * walking back a realized loss does not. The empty allowlist is the single most
 * important default: it means the system can do nothing until a human ticks a
 * pool.
 */
export const DEFAULT_POLICY_DRAFT: PolicyDraft = {
  chain: 'robinhood',
  maxPositionSizeUsd: '250',
  dailySpendCapUsd: '500',
  allowedPools: [],
  poolSelectionCriteria: {
    minTvlUsd: '250000',
    min24hVolumeUsd: '50000',
    maxIlRiskScore: '40',
  },
  compoundTrigger: {
    enabled: true,
    minFeesVsGasRatio: '3',
    maxIntervalHours: '24',
  },
  rebalanceTrigger: {
    enabled: true,
    rangeExitPercent: '5',
    rangeStrategy: 'narrow',
  },
  switchingBuffer: {
    minEfficiencyDeltaPercent: '5',
    sustainedDurationMinutes: '60',
  },
};

function num(value: number): string {
  return Number.isFinite(value) ? String(value) : '';
}

export function draftFromPolicy(policy: AutomationPolicy | null): PolicyDraft {
  if (!policy) return { ...DEFAULT_POLICY_DRAFT, allowedPools: [] };
  return {
    chain: policy.chain ?? 'robinhood',
    maxPositionSizeUsd: num(policy.maxPositionSizeUsd),
    dailySpendCapUsd: num(policy.dailySpendCapUsd),
    allowedPools: Array.isArray(policy.allowedPools)
      ? policy.allowedPools.map((entry) => String(entry).toLowerCase())
      : [],
    poolSelectionCriteria: {
      minTvlUsd: num(policy.poolSelectionCriteria?.minTvlUsd),
      min24hVolumeUsd: num(policy.poolSelectionCriteria?.min24hVolumeUsd),
      maxIlRiskScore: num(policy.poolSelectionCriteria?.maxIlRiskScore),
    },
    compoundTrigger: {
      enabled: policy.compoundTrigger?.enabled !== false,
      minFeesVsGasRatio: num(policy.compoundTrigger?.minFeesVsGasRatio),
      maxIntervalHours: num(policy.compoundTrigger?.maxIntervalHours),
    },
    rebalanceTrigger: {
      enabled: policy.rebalanceTrigger?.enabled !== false,
      rangeExitPercent: num(policy.rebalanceTrigger?.rangeExitPercent),
      rangeStrategy: normalizeRangeStrategy(policy.rebalanceTrigger?.rangeStrategy),
    },
    switchingBuffer: {
      minEfficiencyDeltaPercent: num(policy.switchingBuffer?.minEfficiencyDeltaPercent),
      sustainedDurationMinutes: num(policy.switchingBuffer?.sustainedDurationMinutes),
    },
  };
}

/**
 * A blank or non-numeric field becomes `NaN`, never `0`. The validator rejects
 * NaN, so an empty field surfaces as "must be a finite number" instead of
 * quietly persisting a zero cap.
 */
export function toNumber(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed === '') return Number.NaN;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function draftToPayload(draft: PolicyDraft): AutomationPolicyPayload {
  return {
    chain: draft.chain,
    maxPositionSizeUsd: toNumber(draft.maxPositionSizeUsd),
    dailySpendCapUsd: toNumber(draft.dailySpendCapUsd),
    allowedPools: draft.allowedPools.map((entry) => entry.trim().toLowerCase()),
    poolSelectionCriteria: {
      minTvlUsd: toNumber(draft.poolSelectionCriteria.minTvlUsd),
      min24hVolumeUsd: toNumber(draft.poolSelectionCriteria.min24hVolumeUsd),
      maxIlRiskScore: toNumber(draft.poolSelectionCriteria.maxIlRiskScore),
    },
    compoundTrigger: {
      enabled: draft.compoundTrigger.enabled,
      minFeesVsGasRatio: toNumber(draft.compoundTrigger.minFeesVsGasRatio),
      maxIntervalHours: toNumber(draft.compoundTrigger.maxIntervalHours),
    },
    rebalanceTrigger: {
      enabled: draft.rebalanceTrigger.enabled,
      rangeExitPercent: toNumber(draft.rebalanceTrigger.rangeExitPercent),
      rangeStrategy: draft.rebalanceTrigger.rangeStrategy,
    },
    switchingBuffer: {
      minEfficiencyDeltaPercent: toNumber(draft.switchingBuffer.minEfficiencyDeltaPercent),
      sustainedDurationMinutes: toNumber(draft.switchingBuffer.sustainedDurationMinutes),
    },
  };
}

// --- Validation (mirror of lp-automation/src/policy/validate.ts) -------------

interface NumberRule {
  min?: number;
  max?: number;
  exclusiveMin?: number;
  because?: string;
}

function checkBoolean(
  issues: PolicyFieldIssue[],
  field: string,
  value: unknown,
  because?: string,
): void {
  const suffix = because ? ` (${because})` : '';
  if (value === undefined) return;
  if (typeof value !== 'boolean') {
    issues.push({ field, message: `must be true or false${suffix}` });
  }
}

function checkNumber(
  issues: PolicyFieldIssue[],
  field: string,
  value: number,
  rule: NumberRule,
): number | null {
  const suffix = rule.because ? ` (${rule.because})` : '';
  if (!Number.isFinite(value)) {
    issues.push({ field, message: `must be a finite number${suffix}` });
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

/**
 * Client-side pre-flight. Returns every problem at once; empty means the draft
 * is worth sending. It does not mean the server will accept it.
 */
export function validatePolicyPayload(payload: AutomationPolicyPayload): PolicyFieldIssue[] {
  const issues: PolicyFieldIssue[] = [];

  if (payload.chain !== 'robinhood') {
    issues.push({ field: 'chain', message: "must be 'robinhood' (phase 1 supports no other chain)" });
  }

  const maxPositionSizeUsd = checkNumber(issues, 'maxPositionSizeUsd', payload.maxPositionSizeUsd, {
    exclusiveMin: 0,
    because: 'a zero or negative cap can never authorize a position',
  });

  const dailySpendCapUsd = checkNumber(issues, 'dailySpendCapUsd', payload.dailySpendCapUsd, {
    exclusiveMin: 0,
    because: 'a zero or negative cap can never authorize a position',
  });

  // A daily cap below one position's size is self-contradictory: every entry
  // would be refused on-chain, after paying gas to find that out.
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

  if (!Array.isArray(payload.allowedPools)) {
    issues.push({ field: 'allowedPools', message: 'must be an array of pool addresses' });
  } else {
    payload.allowedPools.forEach((entry, index) => {
      if (typeof entry !== 'string' || !ADDRESS_PATTERN.test(entry)) {
        issues.push({
          field: `allowedPools[${index}]`,
          message: 'must be a 0x-prefixed 20-byte hex address',
        });
      }
    });
  }

  checkNumber(issues, 'poolSelectionCriteria.minTvlUsd', payload.poolSelectionCriteria.minTvlUsd, {
    min: 0,
  });
  checkNumber(
    issues,
    'poolSelectionCriteria.min24hVolumeUsd',
    payload.poolSelectionCriteria.min24hVolumeUsd,
    { min: 0 },
  );
  checkNumber(
    issues,
    'poolSelectionCriteria.maxIlRiskScore',
    payload.poolSelectionCriteria.maxIlRiskScore,
    { min: 0, max: 100, because: 'the IL risk score is defined on a 0-100 scale' },
  );

  checkBoolean(issues, 'compoundTrigger.enabled', payload.compoundTrigger.enabled);
  checkNumber(issues, 'compoundTrigger.minFeesVsGasRatio', payload.compoundTrigger.minFeesVsGasRatio, {
    min: 1,
    because: 'compounding for less than the gas it costs is always a net loss',
  });
  checkNumber(issues, 'compoundTrigger.maxIntervalHours', payload.compoundTrigger.maxIntervalHours, {
    exclusiveMin: 0,
    because: 'a zero interval would compound on every single tick',
  });

  checkBoolean(issues, 'rebalanceTrigger.enabled', payload.rebalanceTrigger.enabled);
  checkNumber(issues, 'rebalanceTrigger.rangeExitPercent', payload.rebalanceTrigger.rangeExitPercent, {
    exclusiveMin: 0,
    because: 'a zero threshold rebalances on the first tick outside the range',
  });

  // The strategy is a closed enum, not a number. A value outside it could only
  // ever fail in the worker that maps it to tick bounds — reject it here first.
  if (!RANGE_STRATEGIES.includes(payload.rebalanceTrigger.rangeStrategy)) {
    issues.push({
      field: 'rebalanceTrigger.rangeStrategy',
      message: "must be one of 'narrow', 'wide' or 'full'",
    });
  }

  // Zero is allowed here — "any positive advantage counts" — because the
  // sustained-duration half of the buffer still gates the move. Negative is not.
  checkNumber(
    issues,
    'switchingBuffer.minEfficiencyDeltaPercent',
    payload.switchingBuffer.minEfficiencyDeltaPercent,
    { min: 0, because: 'a negative delta would authorize switching into a worse pool' },
  );
  checkNumber(
    issues,
    'switchingBuffer.sustainedDurationMinutes',
    payload.switchingBuffer.sustainedDurationMinutes,
    {
      exclusiveMin: 0,
      because:
        'zero duration removes the buffer entirely, allowing a momentary crossover to trigger a move',
    },
  );

  return issues;
}

export function validatePolicyDraft(draft: PolicyDraft): PolicyFieldIssue[] {
  return validatePolicyPayload(draftToPayload(draft));
}

/** First message per field — the editor renders one error under each input. */
export function issuesByField(issues: readonly PolicyFieldIssue[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const issue of issues) {
    if (!(issue.field in map)) map[issue.field] = issue.message;
  }
  return map;
}

/**
 * Pulls field issues out of a 400 body.
 *
 * Deliberately tolerant about the envelope: this page is built against an API
 * being written concurrently, and losing the server's authoritative field
 * errors to an envelope mismatch would be worse than accepting several shapes.
 * Anything unrecognizable degrades to an empty list, and the caller falls back
 * to showing the raw status message.
 */
export function parseFieldIssues(body: unknown): PolicyFieldIssue[] {
  if (!body || typeof body !== 'object') return [];
  const record = body as Record<string, unknown>;

  for (const key of ['issues', 'errors', 'fieldErrors', 'details']) {
    const value = record[key];
    if (Array.isArray(value)) {
      const parsed = value
        .map((entry): PolicyFieldIssue | null => {
          if (!entry || typeof entry !== 'object') return null;
          const item = entry as Record<string, unknown>;
          const field = typeof item.field === 'string' ? item.field : typeof item.path === 'string' ? item.path : null;
          const message = typeof item.message === 'string' ? item.message : null;
          if (field === null || message === null) return null;
          return { field, message };
        })
        .filter((entry): entry is PolicyFieldIssue => entry !== null);
      if (parsed.length > 0) return parsed;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const parsed = Object.entries(value as Record<string, unknown>)
        .filter((pair): pair is [string, string] => typeof pair[1] === 'string')
        .map(([field, message]) => ({ field, message }));
      if (parsed.length > 0) return parsed;
    }
  }

  // `{ error: { issues: [...] } }`
  const nested = record.error;
  if (nested && typeof nested === 'object') return parseFieldIssues(nested);

  return [];
}

/** Structural equality, used to drive the unsaved-changes indicator. */
export function draftsEqual(a: PolicyDraft, b: PolicyDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
