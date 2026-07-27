import { describe, it, expect } from 'vitest';
import {
  LP_COMMAND_ACTIONS,
  POSITION_COMMAND_ACTIONS,
  isPoolOnAllowlist,
  rowToCommand,
  validateCommandInput,
  validateEnterInput,
  validateIncreaseInput,
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
  it('accepts each tokenId-action a human can request', () => {
    for (const action of POSITION_COMMAND_ACTIONS) {
      const result = validateCommandInput(TOKEN_ID, body({ action }));
      expect(result.valid, action).toBe(true);
      expect(result.request?.action).toBe(action);
    }
  });

  it("does not accept 'enter' on the tokenId route — it has no tokenId and its own route", () => {
    // `enter` is a real command action (it is in LP_COMMAND_ACTIONS), but it is
    // NOT one of the tokenId-actions this route serves.
    expect((LP_COMMAND_ACTIONS as readonly string[]).includes('enter')).toBe(true);
    expect((POSITION_COMMAND_ACTIONS as readonly string[]).includes('enter')).toBe(false);
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

// --- Enter (Zap In) --------------------------------------------------------
//
// The other half of the queue: opening a BRAND-NEW position. No tokenId; a pool,
// an input token, a base-units amount and an optional range/slippage instead.
// Same non-security-boundary framing as everything above — the worker and the
// DB CHECKs are the real gate; this is the immediate, legible refusal.

const TOKEN_IN = '0x4200000000000000000000000000000000000006'; // WETH-shaped
const AMOUNT_IN = '10000000000000000'; // 0.01 in 18-decimals base units

const enterBody = (over: Record<string, unknown> = {}) => ({
  poolAddress: POOL,
  tokenInAddress: TOKEN_IN,
  amountIn: AMOUNT_IN,
  ...over,
});

function enterIssueFields(result: ReturnType<typeof validateEnterInput>): string[] {
  return result.issues.map((issue) => issue.field);
}

describe('validateEnterInput — the happy path', () => {
  it('accepts a well-formed enter with only the required fields', () => {
    const result = validateEnterInput(enterBody());
    expect(result.valid).toBe(true);
    expect(result.request).toEqual({
      poolAddress: POOL,
      tokenInAddress: TOKEN_IN,
      amountIn: AMOUNT_IN,
      // Omitted optionals default to null so the worker falls back to the policy.
      rangeStrategy: null,
      swapSlippage: null,
    });
  });

  it('accepts each range strategy and a slippage at the ceiling', () => {
    for (const rangeStrategy of ['narrow', 'wide', 'full'] as const) {
      const result = validateEnterInput(enterBody({ rangeStrategy, swapSlippage: 0.05 }));
      expect(result.valid, rangeStrategy).toBe(true);
      expect(result.request?.rangeStrategy).toBe(rangeStrategy);
      expect(result.request?.swapSlippage).toBe(0.05);
    }
  });

  it('normalizes both addresses to lowercase so allowlist comparison is plain equality', () => {
    const result = validateEnterInput(
      enterBody({
        poolAddress: `  ${POOL.toUpperCase().replace('0X', '0x')}\n`,
        tokenInAddress: TOKEN_IN.toUpperCase().replace('0X', '0x'),
      }),
    );
    expect(result.valid).toBe(true);
    expect(result.request?.poolAddress).toBe(POOL);
    expect(result.request?.tokenInAddress).toBe(TOKEN_IN);
  });

  it('treats an explicit null optional the same as an omitted one', () => {
    const result = validateEnterInput(enterBody({ rangeStrategy: null, swapSlippage: null }));
    expect(result.valid).toBe(true);
    expect(result.request?.rangeStrategy).toBeNull();
    expect(result.request?.swapSlippage).toBeNull();
  });
});

describe('validateEnterInput — rejections, one field at a time', () => {
  it('rejects a malformed pool address', () => {
    const result = validateEnterInput(enterBody({ poolAddress: 'not-an-address' }));
    expect(result.valid).toBe(false);
    expect(enterIssueFields(result)).toContain('poolAddress');
    expect(result.request).toBeNull();
  });

  it('rejects a malformed input-token address', () => {
    const result = validateEnterInput(enterBody({ tokenInAddress: `${TOKEN_IN}ff` }));
    expect(result.valid).toBe(false);
    expect(enterIssueFields(result)).toContain('tokenInAddress');
  });

  it('rejects the all-zero address for either token', () => {
    const zero = `0x${'0'.repeat(40)}`;
    expect(enterIssueFields(validateEnterInput(enterBody({ poolAddress: zero })))).toContain(
      'poolAddress',
    );
    expect(enterIssueFields(validateEnterInput(enterBody({ tokenInAddress: zero })))).toContain(
      'tokenInAddress',
    );
  });

  it('rejects a non-integer amount', () => {
    const result = validateEnterInput(enterBody({ amountIn: '12ab' }));
    expect(result.valid).toBe(false);
    expect(enterIssueFields(result)).toContain('amountIn');
  });

  it('rejects a float amount — base units are integers, and a float is a wrong amount on-chain', () => {
    const result = validateEnterInput(enterBody({ amountIn: '1.5' }));
    expect(result.valid).toBe(false);
    expect(enterIssueFields(result)).toContain('amountIn');
  });

  it('rejects zero, a leading zero, and a numeric (non-string) amount', () => {
    for (const amountIn of ['0', '007', 10000, '', '-1']) {
      expect(validateEnterInput(enterBody({ amountIn })).valid, String(amountIn)).toBe(false);
    }
  });

  it('rejects a range strategy outside the set', () => {
    const result = validateEnterInput(enterBody({ rangeStrategy: 'medium' }));
    expect(result.valid).toBe(false);
    expect(enterIssueFields(result)).toContain('rangeStrategy');
  });

  it('rejects a slippage above the 0.05 ceiling', () => {
    const result = validateEnterInput(enterBody({ swapSlippage: 0.06 }));
    expect(result.valid).toBe(false);
    expect(enterIssueFields(result)).toContain('swapSlippage');
  });

  it('rejects a slippage at or below zero, and a non-finite one', () => {
    for (const swapSlippage of [0, -0.01, Number.NaN, Number.POSITIVE_INFINITY, '0.01']) {
      const result = validateEnterInput(enterBody({ swapSlippage }));
      expect(result.valid, String(swapSlippage)).toBe(false);
      expect(enterIssueFields(result)).toContain('swapSlippage');
    }
  });

  it('reports every bad field at once, so the form can mark them all', () => {
    const result = validateEnterInput({
      poolAddress: 'nope',
      tokenInAddress: 'also-nope',
      amountIn: '1.5',
      rangeStrategy: 'medium',
      swapSlippage: 9,
    });
    expect(result.valid).toBe(false);
    expect(enterIssueFields(result)).toEqual(
      expect.arrayContaining([
        'poolAddress',
        'tokenInAddress',
        'amountIn',
        'rangeStrategy',
        'swapSlippage',
      ]),
    );
  });

  it('rejects a non-object body without throwing', () => {
    for (const input of [null, undefined, 'enter', 42, [POOL]]) {
      expect(validateEnterInput(input).valid).toBe(false);
    }
  });
});

describe('rowToCommand — a null token_id survives the mapper', () => {
  it('maps an enter row to tokenId: null, not ""', () => {
    const command = rowToCommand({
      id: '11111111-1111-1111-1111-111111111111',
      token_id: null,
      pool_address: POOL,
      action: 'enter',
      status: 'pending',
      requested_at: '2026-07-27T00:00:00.000Z',
      claimed_at: null,
      completed_at: null,
      tx_hash: null,
      error: null,
    });
    expect(command.tokenId).toBeNull();
    expect(command.action).toBe('enter');
    expect(command.poolAddress).toBe(POOL);
  });

  it('still maps a real token_id through for the other actions', () => {
    const command = rowToCommand({
      id: '22222222-2222-2222-2222-222222222222',
      token_id: TOKEN_ID,
      pool_address: POOL,
      action: 'compound',
      status: 'done',
      requested_at: '2026-07-27T00:00:00.000Z',
      claimed_at: '2026-07-27T00:00:01.000Z',
      completed_at: '2026-07-27T00:00:02.000Z',
      tx_hash: '0xabc',
      error: null,
    });
    expect(command.tokenId).toBe(TOKEN_ID);
  });
});

function increaseBody(over: Record<string, unknown> = {}) {
  return {
    poolAddress: POOL,
    tokenInAddress: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
    amountIn: '50000000000000000',
    swapSlippage: 0.005,
    ...over,
  };
}

describe('validateIncreaseInput', () => {
  it('accepts a valid increase request', () => {
    const result = validateIncreaseInput(TOKEN_ID, increaseBody());
    expect(result.valid).toBe(true);
    expect(result.request?.tokenId).toBe(TOKEN_ID);
    expect(result.request?.amountIn).toBe('50000000000000000');
  });

  it('rejects a bad tokenId', () => {
    expect(validateIncreaseInput('0', increaseBody()).valid).toBe(false);
  });

  it('rejects a float amount', () => {
    expect(validateIncreaseInput(TOKEN_ID, increaseBody({ amountIn: '1.5' })).valid).toBe(false);
  });
});
