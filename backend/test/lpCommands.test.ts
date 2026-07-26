import { describe, it, expect } from 'vitest';
import {
  LP_COMMAND_ACTIONS,
  isPoolOnAllowlist,
  validateCommandInput,
  type Address,
  type AutomationPolicy,
} from '../src/api/routes/lp';

// Pure units only — no network, no database, no Express. Everything here guards
// the moment between "an operator clicked Compound" and "a row exists that the
// signer process will act on".
//
// WHAT THIS FILE IS *NOT* TESTING, and why that matters: none of these checks
// are a security boundary. The queue is a TRIGGER, not an authority — the
// worker re-runs the pool allowlist check at execution time (`checkGuards` in
// `lp-automation/src/lifecycle/executor.ts`), because a pool removed from the
// policy between enqueue and execution must still stop the broadcast, and only
// a check at execution time can see that. What is verified below is that the
// dashboard gets an immediate, honest refusal instead of a row that sits
// `pending` and then comes back `failed` for a reason we already knew.

const POOL = '0xa06671d47e0b5b45f4144bf77149995f0bdb495d';
const OTHER_POOL = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TOKEN_ID = '396426';

function policy(allowedPools: string[]): AutomationPolicy {
  return {
    version: 3,
    chain: 'robinhood',
    maxPositionSizeUsd: 500,
    allowedPools: allowedPools as Address[],
    poolSelectionCriteria: { minTvlUsd: 0, min24hVolumeUsd: 0, maxIlRiskScore: 50 },
    compoundTrigger: { minFeesVsGasRatio: 2, maxIntervalHours: 6 },
    rebalanceTrigger: { rangeExitPercent: 5 },
    switchingBuffer: { minEfficiencyDeltaPercent: 10, sustainedDurationMinutes: 30 },
    dailySpendCapUsd: 500,
  };
}

const body = (over: Record<string, unknown> = {}) => ({
  action: 'compound',
  poolAddress: POOL,
  ...over,
});

function issueFields(result: ReturnType<typeof validateCommandInput>): string[] {
  return result.issues.map((issue) => issue.field);
}

describe('validateCommandInput — action', () => {
  it('accepts each of the three lifecycle actions a human can request', () => {
    for (const action of LP_COMMAND_ACTIONS) {
      const result = validateCommandInput(TOKEN_ID, body({ action }));
      expect(result.valid, action).toBe(true);
      expect(result.request?.action).toBe(action);
    }
  });

  it('rejects an unknown action rather than queueing something the worker cannot route', () => {
    const result = validateCommandInput(TOKEN_ID, body({ action: 'withdraw' }));
    expect(result.valid).toBe(false);
    expect(issueFields(result)).toContain('action');
    expect(result.request).toBeNull();
  });

  it("rejects 'enter' — opening a position needs a pool, a size and a range this row cannot carry", () => {
    expect(validateCommandInput(TOKEN_ID, body({ action: 'enter' })).valid).toBe(false);
  });

  it('rejects a missing or non-string action', () => {
    expect(validateCommandInput(TOKEN_ID, { poolAddress: POOL }).valid).toBe(false);
    expect(validateCommandInput(TOKEN_ID, body({ action: 3 })).valid).toBe(false);
    expect(validateCommandInput(TOKEN_ID, body({ action: null })).valid).toBe(false);
  });

  it('is case-sensitive — "Compound" is not the enum value the worker switches on', () => {
    expect(validateCommandInput(TOKEN_ID, body({ action: 'Compound' })).valid).toBe(false);
  });

  it('reports every bad field at once, so the form can mark them all', () => {
    const result = validateCommandInput('0', { action: 'nope', poolAddress: 'not-an-address' });
    expect(result.valid).toBe(false);
    expect(issueFields(result)).toEqual(
      expect.arrayContaining(['tokenId', 'action', 'poolAddress']),
    );
  });

  it('rejects a non-object body without throwing', () => {
    for (const input of [null, undefined, 'compound', 42, ['compound']]) {
      expect(validateCommandInput(TOKEN_ID, input).valid).toBe(false);
    }
  });
});

describe('validateCommandInput — tokenId', () => {
  it('accepts a positive integer position id', () => {
    expect(validateCommandInput('1', body()).valid).toBe(true);
    expect(validateCommandInput('396426', body()).valid).toBe(true);
  });

  it('rejects zero, negatives, leading zeros and non-numeric ids', () => {
    for (const tokenId of ['0', '-1', '007', '1.5', '', 'abc', '39 6426', '1e5']) {
      expect(validateCommandInput(tokenId, body()).valid, tokenId).toBe(false);
    }
  });

  it('rejects an id longer than a uint256 could ever be', () => {
    expect(validateCommandInput(`9${'9'.repeat(78)}`, body()).valid).toBe(false);
  });

  it('rejects a non-string id', () => {
    expect(validateCommandInput(396426, body()).valid).toBe(false);
    expect(validateCommandInput(undefined, body()).valid).toBe(false);
  });
});

describe('validateCommandInput — address normalization', () => {
  it('lowercases a checksummed address so allowlist comparison is plain equality', () => {
    const checksummed = '0xA06671D47E0B5B45F4144BF77149995F0BDB495D';
    const result = validateCommandInput(TOKEN_ID, body({ poolAddress: checksummed }));
    expect(result.valid).toBe(true);
    expect(result.request?.poolAddress).toBe(POOL);
  });

  it('trims surrounding whitespace a paste can carry in', () => {
    const result = validateCommandInput(TOKEN_ID, body({ poolAddress: `  ${POOL}\n` }));
    expect(result.valid).toBe(true);
    expect(result.request?.poolAddress).toBe(POOL);
  });

  it('rejects a malformed address instead of normalizing it into something plausible', () => {
    for (const poolAddress of [
      POOL.slice(0, -1),
      `${POOL}ff`,
      POOL.replace('0x', ''),
      '0xZZ671d47e0b5b45f4144bf77149995f0bdb495d',
      '',
      42,
      null,
    ]) {
      expect(validateCommandInput(TOKEN_ID, body({ poolAddress })).valid, String(poolAddress)).toBe(
        false,
      );
    }
  });

  it('rejects the all-zero address — never a real pool, and it 403s every Krystal call', () => {
    const result = validateCommandInput(TOKEN_ID, body({ poolAddress: `0x${'0'.repeat(40)}` }));
    expect(result.valid).toBe(false);
    expect(issueFields(result)).toContain('poolAddress');
  });
});

describe('isPoolOnAllowlist', () => {
  it('admits a pool a human ticked into the active policy', () => {
    expect(isPoolOnAllowlist(policy([POOL]), POOL)).toBe(true);
  });

  it('refuses a pool that is not on the allowlist — the worker would refuse it anyway', () => {
    expect(isPoolOnAllowlist(policy([OTHER_POOL]), POOL)).toBe(false);
  });

  it('refuses everything when the allowlist is empty', () => {
    // An empty allowlist means the automation can do nothing at all. That is
    // the correct default, and a manual button must not be a way around it.
    expect(isPoolOnAllowlist(policy([]), POOL)).toBe(false);
  });

  it('refuses everything when no policy is configured yet', () => {
    expect(isPoolOnAllowlist(null, POOL)).toBe(false);
  });

  it('compares case-insensitively, so a checksummed request is not falsely refused', () => {
    expect(isPoolOnAllowlist(policy([POOL]), POOL.toUpperCase().replace('0X', '0x'))).toBe(true);
  });

  it('does not match on a prefix or a substring of an allowlisted address', () => {
    expect(isPoolOnAllowlist(policy([POOL]), POOL.slice(0, 20))).toBe(false);
  });
});

describe('the queued request that reaches the database', () => {
  it('carries the normalized values, not the raw ones', () => {
    const result = validateCommandInput(' 396426'.trim(), {
      action: 'rebalance',
      poolAddress: '  0xA06671D47E0B5B45F4144BF77149995F0BDB495D  ',
      // Unrecognized keys are dropped rather than persisted: a future field
      // must not arrive early and be read back as if it had been honoured.
      liquidityPercent: 0.5,
      status: 'done',
      txHash: '0xdeadbeef',
    });
    expect(result.valid).toBe(true);
    expect(result.request).toEqual({
      tokenId: '396426',
      action: 'rebalance',
      poolAddress: POOL,
    });
  });
});
