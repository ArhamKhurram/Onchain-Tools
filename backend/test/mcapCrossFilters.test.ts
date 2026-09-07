import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MCAP_CROSS_FILTER_BOUNDS,
  MCAP_CROSS_FILTER_KEYS,
  applyFilterPatch,
  resolveUserGateConfig,
  sanitizeStoredFilters,
  validateFilterPatch,
  type McapCrossFilters,
} from '../src/mcapCross/filters.js';
import {
  DEFAULT_GATE_CONFIG,
  evaluateMcapGates,
  resolveGateConfig,
  type McapGateInput,
} from '../src/mcapCross/gates.js';
import { normalizeSecurity, type GmgnSecurityRaw } from '../src/mcapCross/security.js';

/**
 * PER-USER market-cap-crossing filters.
 *
 * Four properties are load-bearing and each one is pinned below:
 *
 *   1. PRECEDENCE. per-user → env → hardcoded default, and a user who has set
 *      nothing gets byte-for-byte today's behaviour.
 *   2. VALIDATION. Rates are fractions; NaN, negatives, ceilings of zero and
 *      "10 meaning 10%" are rejected, not clamped. A bad STORED value is
 *      dropped so the gate falls back rather than opening.
 *   3. SOLANA vs EVM. A tax ceiling is inert on Solana — it must never mute a
 *      chain where a transfer tax cannot exist.
 *   4. ABSTAIN. No user threshold can turn "we could not tell" into a pass.
 */

// Payload shapes recorded from the LIVE GMGN API on 2026-09-05 (same fixtures
// as mcapCrossGates.test.ts — a filter test that invented its own token shapes
// would drift away from the gates it is filtering).

/** sol / BONK. Renounced both ways, LP burned. Tax fields null on Solana. */
const SOL_HEALTHY: GmgnSecurityRaw = {
  address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  top_10_holder_rate: '0.3174',
  burn_ratio: '1',
  burn_status: 'burn',
  is_honeypot: null,
  renounced_mint: true,
  renounced_freeze_account: true,
  // GMGN really does return "0" here for Solana. `normalizeSecurity` nulls it.
  buy_tax: '0',
  sell_tax: '0',
  lock_summary: { is_locked: false, lock_detail: null },
};

/** bsc / CAKE, but with a real 8% tax both ways so the ceiling has something to bite. */
const BSC_TAXED: GmgnSecurityRaw = {
  address: '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82',
  top_10_holder_rate: '0.0351',
  is_honeypot: false,
  renounced_mint: false,
  renounced_freeze_account: false,
  buy_tax: '0.08',
  sell_tax: '0.08',
  lock_summary: { is_locked: true, lock_detail: [{ percent: '0.95', is_blackhole: true }] },
};

/**
 * A Solana token whose LP GMGN has no record of. The canonical abstain: every
 * gate it CAN be measured against passes, and one load-bearing field is null.
 */
const SOL_LP_UNKNOWN: GmgnSecurityRaw = {
  ...SOL_HEALTHY,
  burn_status: '',
  burn_ratio: '',
  lock_summary: null,
};

const solInput = (over: Partial<McapGateInput> = {}): McapGateInput => ({
  network: 'solana',
  mcapUsd: 800_000,
  liquidityUsd: 60_000,
  volume24hUsd: null,
  security: normalizeSecurity(SOL_HEALTHY, 'solana'),
  ...over,
});

const bscInput = (over: Partial<McapGateInput> = {}): McapGateInput => ({
  network: 'bsc',
  mcapUsd: 800_000,
  liquidityUsd: 60_000,
  volume24hUsd: null,
  security: normalizeSecurity(BSC_TAXED, 'bsc'),
  ...over,
});

// The env layer is the middle of the precedence chain, so every test starts
// from a clean one and restores whatever the runner had.
const ENV_KEYS = [
  'OCT_MCAP_CROSS_MIN_LIQUIDITY_USD',
  'TRENCHCORD_MCAP_CROSS_MIN_LIQUIDITY_USD',
  'OCT_MCAP_CROSS_MIN_LIQ_MCAP_RATIO',
  'OCT_MCAP_CROSS_MAX_TOP10_RATE',
  'OCT_MCAP_CROSS_MAX_TAX_RATE',
  'OCT_MCAP_CROSS_REQUIRE_LP_SECURED',
  'OCT_MCAP_CROSS_MIN_VOLUME_24H_USD',
];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// --- 1. Precedence -----------------------------------------------------------

describe('threshold precedence: per-user → env → default', () => {
  it('a user who has set nothing gets exactly the shipped behaviour', () => {
    // The whole compatibility promise in one assertion.
    expect(resolveUserGateConfig(null)).toEqual(DEFAULT_GATE_CONFIG);
    expect(resolveUserGateConfig({})).toEqual(resolveGateConfig());
  });

  it('the env var is the default a user inherits, not dead code', () => {
    process.env.OCT_MCAP_CROSS_MIN_LIQUIDITY_USD = '50000';
    expect(resolveUserGateConfig({}).minLiquidityUsd).toBe(50_000);
    expect(resolveUserGateConfig(null).minLiquidityUsd).toBe(50_000);
  });

  it('a per-user value outranks the env var', () => {
    process.env.OCT_MCAP_CROSS_MIN_LIQUIDITY_USD = '50000';
    expect(resolveUserGateConfig({ minLiquidityUsd: 5_000 }).minLiquidityUsd).toBe(5_000);
  });

  it('honours the TRENCHCORD_ fallback in the env layer', () => {
    process.env.TRENCHCORD_MCAP_CROSS_MIN_LIQUIDITY_USD = '31000';
    expect(resolveUserGateConfig({}).minLiquidityUsd).toBe(31_000);
  });

  it('overrides one field without disturbing the others', () => {
    const cfg = resolveUserGateConfig({ maxTaxRate: 0.02 });
    expect(cfg.maxTaxRate).toBe(0.02);
    expect(cfg.minLiquidityUsd).toBe(DEFAULT_GATE_CONFIG.minLiquidityUsd);
    expect(cfg.maxTop10HolderRate).toBe(DEFAULT_GATE_CONFIG.maxTop10HolderRate);
  });

  it('never lets a user touch the LP requirement', () => {
    // requireLpSecured is not a user-editable key, and offering it as one would
    // hand a user the abstain→pass conversion. Even smuggled in, it is ignored.
    const smuggled = { requireLpSecured: false } as unknown as McapCrossFilters;
    expect(resolveUserGateConfig(smuggled).requireLpSecured).toBe(true);
    expect(MCAP_CROSS_FILTER_KEYS).not.toContain('requireLpSecured');
  });

  it('a stricter user floor actually rejects a token the baseline passes', () => {
    const input = solInput({ liquidityUsd: 30_000 });
    expect(evaluateMcapGates(input, resolveUserGateConfig({})).decision).toBe('pass');
    const strict = resolveUserGateConfig({ minLiquidityUsd: 40_000 });
    const verdict = evaluateMcapGates(input, strict);
    expect(verdict.decision).toBe('reject');
    expect(verdict.failed).toContain('liquidity');
  });
});

// --- 2. Boundary validation --------------------------------------------------

describe('validateFilterPatch', () => {
  it('accepts a well-formed patch', () => {
    const result = validateFilterPatch({ minLiquidityUsd: 25_000, maxTaxRate: 0.05 });
    expect(result).toEqual({ ok: true, value: { minLiquidityUsd: 25_000, maxTaxRate: 0.05 } });
  });

  it('rejects NaN and Infinity rather than storing them', () => {
    expect(validateFilterPatch({ minLiquidityUsd: Number.NaN }).ok).toBe(false);
    expect(validateFilterPatch({ minLiquidityUsd: Number.POSITIVE_INFINITY }).ok).toBe(false);
    expect(validateFilterPatch({ maxTaxRate: Number.NaN }).ok).toBe(false);
  });

  it('rejects negatives', () => {
    expect(validateFilterPatch({ minLiquidityUsd: -1 }).ok).toBe(false);
    expect(validateFilterPatch({ maxTop10HolderRate: -0.1 }).ok).toBe(false);
  });

  it('rejects a percent typed where a fraction belongs', () => {
    // 10 meaning "10%" would open the tax gate completely while looking like a
    // tightening. Guessing the user's intent is worse than telling them.
    const result = validateFilterPatch({ maxTaxRate: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/fraction/);
  });

  it('rejects a ceiling of zero, which mutes rather than filters', () => {
    expect(validateFilterPatch({ maxTaxRate: 0 }).ok).toBe(false);
    expect(validateFilterPatch({ maxTop10HolderRate: 0 }).ok).toBe(false);
    // A FLOOR of zero is meaningful ("I do not care about liquidity"), so it stands.
    expect(validateFilterPatch({ minLiquidityUsd: 0 }).ok).toBe(true);
  });

  it('rejects absurd magnitudes', () => {
    expect(validateFilterPatch({ minLiquidityUsd: 1e15 }).ok).toBe(false);
    expect(validateFilterPatch({ minLiquidityToMcapRatio: 2 }).ok).toBe(false);
  });

  it('rejects wrong types and unknown keys', () => {
    expect(validateFilterPatch({ minLiquidityUsd: '25000' }).ok).toBe(false);
    expect(validateFilterPatch({ nonsense: 1 }).ok).toBe(false);
    expect(validateFilterPatch(null).ok).toBe(false);
    expect(validateFilterPatch([1, 2]).ok).toBe(false);
  });

  it('names the offending field so the console can say what is wrong', () => {
    const result = validateFilterPatch({ maxTaxRate: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain(MCAP_CROSS_FILTER_BOUNDS.maxTaxRate.label);
  });
});

describe('sanitizeStoredFilters — a bad stored value must never disable a gate', () => {
  it('drops out-of-range and malformed values back to the baseline', () => {
    // The hand-edited-config case: whatever route put this on disk, the gate
    // must keep running at the operator's threshold rather than at 0 or NaN.
    const junk = {
      minLiquidityUsd: -5,
      minLiquidityToMcapRatio: Number.NaN,
      maxTop10HolderRate: 0,
      maxTaxRate: 'lots',
    } as unknown;
    expect(sanitizeStoredFilters(junk)).toEqual({});
    expect(resolveUserGateConfig(junk as McapCrossFilters)).toEqual(DEFAULT_GATE_CONFIG);
  });

  it('keeps the good keys when only some are bad', () => {
    const mixed = { minLiquidityUsd: 30_000, maxTaxRate: 99 } as unknown as McapCrossFilters;
    expect(sanitizeStoredFilters(mixed)).toEqual({ minLiquidityUsd: 30_000 });
    expect(resolveUserGateConfig(mixed).maxTaxRate).toBe(DEFAULT_GATE_CONFIG.maxTaxRate);
  });

  it('survives a non-object', () => {
    expect(sanitizeStoredFilters(null)).toEqual({});
    expect(sanitizeStoredFilters('nope')).toEqual({});
    expect(sanitizeStoredFilters([1])).toEqual({});
  });
});

describe('applyFilterPatch', () => {
  it('leaves absent keys alone and clears explicit nulls', () => {
    const stored: McapCrossFilters = { minLiquidityUsd: 30_000, maxTaxRate: 0.05 };
    const raw = { maxTaxRate: null } as Record<string, unknown>;
    const parsed = validateFilterPatch(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(applyFilterPatch(stored, raw, parsed.value)).toEqual({ minLiquidityUsd: 30_000 });
  });

  it('replaces a set key', () => {
    const raw = { minLiquidityUsd: 1_000 } as Record<string, unknown>;
    const parsed = validateFilterPatch(raw);
    if (!parsed.ok) throw new Error('expected ok');
    expect(applyFilterPatch({ minLiquidityUsd: 30_000 }, raw, parsed.value)).toEqual({
      minLiquidityUsd: 1_000,
    });
  });
});

// --- 3. Solana vs EVM --------------------------------------------------------

describe('a tax ceiling is an EVM concept and must not mute Solana', () => {
  it('the tightest possible tax ceiling changes nothing on Solana', () => {
    // buyTax/sellTax are null on Solana by construction (normalizeSecurity), so
    // the gate never compares them. If this ever fails, a Solana user who set a
    // tax filter has silently lost the whole chain.
    const sec = normalizeSecurity(SOL_HEALTHY, 'solana');
    expect(sec?.buyTax).toBeNull();
    expect(sec?.sellTax).toBeNull();

    const strictest = resolveUserGateConfig({ maxTaxRate: 0.0001 });
    expect(evaluateMcapGates(solInput(), strictest).decision).toBe('pass');
    expect(evaluateMcapGates(solInput(), resolveUserGateConfig({})).decision).toBe('pass');
  });

  it('the same ceiling does bite on EVM', () => {
    // CAKE-shaped payload with an 8% tax: the shipped 10% ceiling passes it,
    // a user's 5% ceiling rejects it. Same token, same call, two answers.
    expect(evaluateMcapGates(bscInput(), resolveUserGateConfig({})).decision).toBe('pass');
    const verdict = evaluateMcapGates(bscInput(), resolveUserGateConfig({ maxTaxRate: 0.05 }));
    expect(verdict.decision).toBe('reject');
    expect(verdict.failed).toEqual(expect.arrayContaining(['buyTax', 'sellTax']));
  });

  it('a loosened tax ceiling admits a token the baseline rejects, EVM only', () => {
    const heavy = normalizeSecurity({ ...BSC_TAXED, buy_tax: '0.2', sell_tax: '0.2' }, 'bsc');
    expect(evaluateMcapGates(bscInput({ security: heavy }), resolveUserGateConfig({})).decision)
      .toBe('reject');
    expect(
      evaluateMcapGates(bscInput({ security: heavy }), resolveUserGateConfig({ maxTaxRate: 0.25 }))
        .decision,
    ).toBe('pass');
  });
});

// --- 4. Abstain preservation -------------------------------------------------

describe('no user threshold can turn an abstain into a pass', () => {
  const abstaining: { name: string; input: McapGateInput }[] = [
    { name: 'no market cap', input: solInput({ mcapUsd: null }) },
    { name: 'no liquidity figure', input: solInput({ liquidityUsd: null }) },
    { name: 'security lookup unavailable', input: solInput({ security: null }) },
    {
      name: 'LP burn/lock unknown',
      input: solInput({ security: normalizeSecurity(SOL_LP_UNKNOWN, 'solana') }),
    },
    {
      name: 'mint authority unknown',
      input: solInput({
        security: normalizeSecurity({ ...SOL_HEALTHY, renounced_mint: null }, 'solana'),
      }),
    },
    {
      name: 'holder concentration unknown',
      input: bscInput({
        security: normalizeSecurity({ ...BSC_TAXED, top_10_holder_rate: null }, 'bsc'),
      }),
    },
  ];

  // Every corner of the editable space, including the most permissive one a
  // user is allowed to store. None of them may manufacture a verdict.
  const configs: McapCrossFilters[] = [
    {},
    { minLiquidityUsd: 0 },
    { minLiquidityUsd: 0, minLiquidityToMcapRatio: 0, maxTop10HolderRate: 1, maxTaxRate: 1 },
    { minLiquidityUsd: 1e9, maxTop10HolderRate: 0.0001, maxTaxRate: 0.0001 },
  ];

  for (const { name, input } of abstaining) {
    it(`stays abstain (${name}) whatever the user set`, () => {
      for (const filters of configs) {
        const verdict = evaluateMcapGates(input, resolveUserGateConfig(filters));
        // Reject is allowed — a strict user floor answering a question the
        // abstain never got to. What is forbidden is `pass`.
        expect(verdict.decision).not.toBe('pass');
      }
    });
  }

  it('the maximally-permissive user still cannot pass an unknown LP', () => {
    const input = solInput({ security: normalizeSecurity(SOL_LP_UNKNOWN, 'solana') });
    const wideOpen = resolveUserGateConfig({
      minLiquidityUsd: 0,
      minLiquidityToMcapRatio: 0,
      maxTop10HolderRate: 1,
      maxTaxRate: 1,
    });
    const verdict = evaluateMcapGates(input, wideOpen);
    expect(verdict.decision).toBe('abstain');
    expect(verdict.abstainReason).toBe('LP burn/lock unknown');
  });

  it('carries the honeypot caveat through unchanged, at any threshold', () => {
    // #369: an unevaluated honeypot check is surfaced, not hidden. A filter
    // value must be unable to add or remove that caveat.
    const unevaluated = normalizeSecurity({ ...BSC_TAXED, is_honeypot: null }, 'bsc');
    for (const filters of [{}, { maxTaxRate: 0.09 }, { minLiquidityUsd: 1 }]) {
      const verdict = evaluateMcapGates(
        bscInput({ security: unevaluated }),
        resolveUserGateConfig(filters),
      );
      expect(verdict.decision).toBe('pass');
      expect(verdict.caveats).toContain('honeypotUnknown');
    }
  });
});


// --- 5. The volume floor, as a per-user filter -------------------------------

/**
 * `minVolume24hUsd` is the first editable threshold whose INHERITED value is
 * "not evaluated" rather than a number, so it needs its own precedence tests:
 * the existing ones all assume a baseline exists to fall back to.
 */
describe('the 24h volume floor inherits OFF, not a number', () => {
  it('a user who sets nothing still has no volume gate at all', () => {
    expect(resolveUserGateConfig({}).minVolume24hUsd).toBeNull();
    expect(resolveUserGateConfig(null).minVolume24hUsd).toBeNull();
  });

  it('adding this filter did not change what an existing user receives', () => {
    // The compatibility promise, restated for the field most likely to break
    // it: a token with NO volume figure, and a user with NO filters, must still
    // reach exactly the verdict it reached before this filter existed.
    const noFigure = solInput({ volume24hUsd: null });
    expect(evaluateMcapGates(noFigure, resolveUserGateConfig({})).decision).toBe('pass');
    // …and so must one whose volume is known but tiny.
    expect(
      evaluateMcapGates(solInput({ volume24hUsd: 3 }), resolveUserGateConfig({})).decision,
    ).toBe('pass');
  });

  it('an operator env floor becomes the value a user inherits', () => {
    process.env.OCT_MCAP_CROSS_MIN_VOLUME_24H_USD = '250000';
    expect(resolveUserGateConfig({}).minVolume24hUsd).toBe(250_000);
    // …and the user still outranks it, in both directions.
    expect(resolveUserGateConfig({ minVolume24hUsd: 10 }).minVolume24hUsd).toBe(10);
    expect(resolveUserGateConfig({ minVolume24hUsd: 9e8 }).minVolume24hUsd).toBe(9e8);
  });

  it('a garbage env value leaves the gate off rather than open', () => {
    process.env.OCT_MCAP_CROSS_MIN_VOLUME_24H_USD = 'lots';
    expect(resolveUserGateConfig({}).minVolume24hUsd).toBeNull();
  });

  it("one user's floor narrows only that user's feed", () => {
    const quiet = solInput({ volume24hUsd: 4_000 });
    expect(evaluateMcapGates(quiet, resolveUserGateConfig({})).decision).toBe('pass');
    expect(
      evaluateMcapGates(quiet, resolveUserGateConfig({ minVolume24hUsd: 100_000 })).decision,
    ).toBe('reject');
  });

  it('narrows Solana and EVM alike — it is not a chain-shaped filter like tax', () => {
    // `maxTaxRate` is inert on Solana by construction. This one is not, and the
    // reason is that its input comes from the same DexScreener batch on every
    // chain rather than from a chain-specific security field.
    const floor = resolveUserGateConfig({ minVolume24hUsd: 100_000 });
    for (const thin of [solInput({ volume24hUsd: 900 }), bscInput({ volume24hUsd: 900 })]) {
      expect(evaluateMcapGates(thin, floor).failed).toContain('volume24h');
    }
  });

  it('a set floor turns an unmeasured token into an abstain, never a rejection', () => {
    // The single most dangerous failure this feature could ship: a Solana-only
    // metric quietly rejecting every token on the other chains. Whatever the
    // reason a figure is missing, the answer is "we could not tell".
    const floor = resolveUserGateConfig({ minVolume24hUsd: 100_000 });
    for (const blind of [solInput({ volume24hUsd: null }), bscInput({ volume24hUsd: null })]) {
      const verdict = evaluateMcapGates(blind, floor);
      expect(verdict.decision).toBe('abstain');
      expect(verdict.failed).toEqual([]);
    }
  });

  it('is validated and bounded like every other threshold', () => {
    expect(validateFilterPatch({ minVolume24hUsd: 50_000 })).toEqual({
      ok: true,
      value: { minVolume24hUsd: 50_000 },
    });
    // A floor of zero is legal here (unlike a ceiling of zero): it is a real
    // threshold every listed token clears, not a mute switch.
    expect(validateFilterPatch({ minVolume24hUsd: 0 }).ok).toBe(true);
    expect(validateFilterPatch({ minVolume24hUsd: -1 }).ok).toBe(false);
    expect(validateFilterPatch({ minVolume24hUsd: 1e15 }).ok).toBe(false);
    expect(validateFilterPatch({ minVolume24hUsd: Number.NaN }).ok).toBe(false);
    expect(validateFilterPatch({ minVolume24hUsd: '50000' }).ok).toBe(false);
  });

  it('a malformed stored value drops back to OFF rather than to some number', () => {
    expect(sanitizeStoredFilters({ minVolume24hUsd: -5 })).toEqual({});
    expect(resolveUserGateConfig({ minVolume24hUsd: -5 } as never).minVolume24hUsd).toBeNull();
  });

  it('can be cleared back to inheriting', () => {
    const stored = { minVolume24hUsd: 50_000 };
    expect(
      applyFilterPatch(stored, { minVolume24hUsd: null }, {}).minVolume24hUsd,
    ).toBeUndefined();
  });
});
