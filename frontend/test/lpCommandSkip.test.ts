import { describe, it, expect } from 'vitest';
import { isSkipReport } from '../src/components/lp/commands';

// CROSS-PROCESS CONTRACT TEST.
//
// The worker (lp-automation) and the console (frontend) are separate workspaces
// with no shared type, so "the worker declined to act" travels between them as
// a string prefix on `error`. Nothing but this test enforces that.
//
// This string is copied VERBATIM from lp-automation/src/lifecycle/loop.ts. If
// that wording changes, this test fails and someone finds out — rather than a
// disarmed skip silently rendering as a red FAILED, which is what the original
// /^\s*skipped\b/i did: `_` is a word character, so `\b` never matched between
// "skipped" and "_disarmed".
const WORKER_DISARMED_ERROR =
  'skipped_disarmed: the signer is disarmed, so the action was evaluated, simulated and ' +
  'audited but NOTHING WAS BROADCAST. Arm the worker (LP_ARMED) to execute it.';

describe('isSkipReport — the real worker string', () => {
  it('recognises the exact error the worker emits when disarmed', () => {
    expect(isSkipReport(WORKER_DISARMED_ERROR)).toBe(true);
  });

  it('specifically handles the underscore form a word boundary would miss', () => {
    expect(isSkipReport('skipped_disarmed: anything')).toBe(true);
  });

  it('handles the plain colon form too, in case the wording is simplified', () => {
    expect(isSkipReport('skipped: the signer is disarmed')).toBe(true);
  });

  it('tolerates leading whitespace and casing', () => {
    expect(isSkipReport('  Skipped_Disarmed: x')).toBe(true);
  });
});

describe('isSkipReport — must NOT swallow real failures', () => {
  it('returns false for null', () => {
    expect(isSkipReport(null)).toBe(false);
  });

  it('returns false for an ordinary revert', () => {
    expect(isSkipReport('execution reverted: STF')).toBe(false);
  });

  it('returns false when "skipped" appears mid-message, not as the report kind', () => {
    // A genuine failure that merely mentions the word must still read as a
    // failure — softening it would understate a real problem.
    expect(isSkipReport('rebalance failed; 2 ticks were skipped')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(isSkipReport('')).toBe(false);
  });
});
