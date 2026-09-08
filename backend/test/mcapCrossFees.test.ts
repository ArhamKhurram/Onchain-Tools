import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { effectiveFeeRate, estimateTotalFeesUsd } from '../src/mcapCross/fees.js';
import {
  DEFAULT_GATE_CONFIG,
  evaluateMcapGates,
  resolveGateConfig,
  type McapGateInput,
} from '../src/mcapCross/gates.js';
import {
  MCAP_CROSS_FILTER_BOUNDS,
  MCAP_CROSS_FILTER_KEYS,
  resolveUserGateConfig,
  sanitizeStoredFilters,
  validateFilterPatch,
  type McapCrossFilters,
} from '../src/mcapCross/filters.js';
import { normalizeSecurity, type GmgnSecurityRaw } from '../src/mcapCross/security.js';

/**
 * THE "TOTAL FEES" FILTER — `24h volume x tax rate`, the operator's Axiom
 * metric, in USD.
 *
 * Five ways to get this wrong, and four of them are silent:
 *
 *   1. Shipping it ON. Every existing user's alerts change without them asking.
 *   2. Reading a null tax rate as zero. Every token then estimates $0 of fees
 *      and a floor rejects the entire universe — most loudly SOLANA, whose tax
 *      fields are null BY CONSTRUCTION because a transfer tax cannot exist
 *      there.
 *   3. Reading an unknown figure as a PASS, which is the abstain rule inverted.
 *   4. Reading a REPORTED zero as unknown. GMGN really returns buy_tax "0" for
 *      an untaxed EVM token; that is a measurement and a floor may act on it.
 *   5. Getting the arithmetic wrong, which is the only one anybody would spot.
 *
 * The fixtures below are the same live-recorded GMGN shapes the gate tests use,
 * plus the operator's two worked screenshots.
 */

/** sol / BONK. Tax fields come back "0" from GMGN and are nulled per-chain. */
const SOL_HEALTHY: GmgnSecurityRaw = {
  address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  top_10_holder_rate: '0.3174',
  burn_ratio: '1',
  burn_status: 'burn',
  is_honeypot: null,
  renounced_mint: true,
  renounced_freeze_account: true,
  buy_tax: '0',
  sell_tax: '0',
  lock_summary: { is_locked: false, lock_detail: null },
};

/** bsc / CAKE-shaped: real, indexed, and genuinely untaxed. */
const BSC_UNTAXED: GmgnSecurityRaw = {
  address: '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82',
  top_10_holder_rate: '0.0351',
  is_honeypot: false,
  buy_tax: '0',
  sell_tax: '0',
  lock_summary: { is_locked: true, lock_detail: [{ percent: '0.95', is_blackhole: true }] },
};

/** The same token with a 1% / 1% tax — cyberbeer's shape. */
const BSC_TAXED_1PCT: GmgnSecurityRaw = { ...BSC_UNTAXED, buy_tax: '0.01', sell_tax: '0.01' };

/** GMGN answered, but said nothing about tax. Unknown, not zero. */
const BSC_TAX_UNKNOWN: GmgnSecurityRaw = { ...BSC_UNTAXED, buy_tax: null, sell_tax: null };

const solSec = () => normalizeSecurity(SOL_HEALTHY, 'solana');
const bscSec = (raw: GmgnSecurityRaw = BSC_TAXED_1PCT) => normalizeSecurity(raw, 'bsc');

const bscInput = (over: Partial<McapGateInput> = {}): McapGateInput => ({
  network: 'bsc',
  mcapUsd: 900_000,
  liquidityUsd: 80_000,
  volume24hUsd: 2_600_000,
  security: bscSec(),
  ...over,
});

const solInput = (over: Partial<McapGateInput> = {}): McapGateInput => ({
  network: 'solana',
  mcapUsd: 800_000,
  liquidityUsd: 60_000,
  volume24hUsd: 2_600_000,
  security: solSec(),
  ...over,
});

const withFloor = (minTotalFees: number | null) => ({ ...DEFAULT_GATE_CONFIG, minTotalFees });

// --- (5) The arithmetic, against the operator's own screenshots ---------------

describe('the fee model, against the two worked examples', () => {
  it('cyberbeer: $2.6M volume at 1%/1% tax lands on ~$26K, i.e. the 6.81 ETH shown', () => {
    // Axiom showed 6.81 ETH. At an ETH in the high-3Ks that is ~$26K, which is
    // what this computes. The match is to the precision of a screenshot, not to
    // the byte — see the fees.ts header on why it can never be exact.
    const fees = estimateTotalFeesUsd(2_600_000, bscSec(BSC_TAXED_1PCT));
    expect(fees).toBe(26_000);
  });

  it('MOON: $4M volume at 2%/2% tax lands on $80K — 2x the printed 11.05 ETH', () => {
    // Recorded rather than hidden. The operator's own arithmetic for MOON used
    // 1% against a 2%/2% token, and no single per-token-rate model can fit both
    // screenshots at once. This file implements the metric as defined — volume
    // times the token's OWN rate — so MOON reads high. Anyone re-checking this
    // number against Axiom should read this test first.
    const moon = normalizeSecurity({ ...BSC_UNTAXED, buy_tax: '0.02', sell_tax: '0.02' }, 'bsc');
    expect(estimateTotalFeesUsd(4_000_000, moon)).toBe(80_000);
    // With MOON read as a 1%/1% token it lands on the printed figure exactly.
    expect(estimateTotalFeesUsd(4_000_000, bscSec(BSC_TAXED_1PCT))).toBe(40_000);
  });

  it('is NOT volume rescaled by a constant — the rate varies per token', () => {
    // The whole justification for the filter existing alongside the volume one.
    const soft = normalizeSecurity({ ...BSC_UNTAXED, buy_tax: '0.003', sell_tax: '0.003' }, 'bsc');
    const hard = normalizeSecurity({ ...BSC_UNTAXED, buy_tax: '0.02', sell_tax: '0.02' }, 'bsc');
    expect(estimateTotalFeesUsd(1_000_000, soft)).toBe(3_000);
    expect(estimateTotalFeesUsd(1_000_000, hard)).toBe(20_000);
  });

  it('averages an asymmetric tax across the tape', () => {
    const skewed = normalizeSecurity({ ...BSC_UNTAXED, buy_tax: '0', sell_tax: '0.04' }, 'bsc');
    expect(effectiveFeeRate(skewed)).toBe(0.02);
    expect(estimateTotalFeesUsd(1_000_000, skewed)).toBe(20_000);
  });
});

// --- (2) and (4) Unknown is not zero, and zero is not unknown -----------------

describe('unknown inputs produce null, and a reported zero produces a number', () => {
  it('is null when the volume is unknown, whatever the rate says', () => {
    expect(estimateTotalFeesUsd(null, bscSec())).toBeNull();
    expect(estimateTotalFeesUsd(undefined, bscSec())).toBeNull();
    expect(estimateTotalFeesUsd(Number.NaN, bscSec())).toBeNull();
  });

  it('is null when the rate is unknown, whatever the volume says', () => {
    expect(effectiveFeeRate(bscSec(BSC_TAX_UNKNOWN))).toBeNull();
    expect(estimateTotalFeesUsd(50_000_000, bscSec(BSC_TAX_UNKNOWN))).toBeNull();
    expect(estimateTotalFeesUsd(50_000_000, null)).toBeNull();
  });

  it('needs BOTH sides of the tax — half a reading is not a reading', () => {
    const half = normalizeSecurity({ ...BSC_UNTAXED, buy_tax: '0.01', sell_tax: null }, 'bsc');
    expect(half?.buyTax).toBe(0.01);
    expect(effectiveFeeRate(half)).toBeNull();
  });

  it('treats a REPORTED zero tax as a real reading worth zero fees', () => {
    // GMGN really returns "0" for an untaxed EVM token. That is a measurement:
    // this token genuinely charges nothing, and a fee floor may reject it.
    const sec = bscSec(BSC_UNTAXED);
    expect(sec?.buyTax).toBe(0);
    expect(effectiveFeeRate(sec)).toBe(0);
    expect(estimateTotalFeesUsd(2_600_000, sec)).toBe(0);
  });

  it('treats a REPORTED zero volume as a real reading too', () => {
    expect(estimateTotalFeesUsd(0, bscSec())).toBe(0);
  });

  it('refuses a tax rate outside 0-1 rather than guessing what it meant', () => {
    const absurd = normalizeSecurity({ ...BSC_UNTAXED, buy_tax: '150', sell_tax: '150' }, 'bsc');
    expect(effectiveFeeRate(absurd)).toBeNull();
  });
});

// --- Solana ------------------------------------------------------------------

describe('Solana has no fee rate, and that must read as UNKNOWN', () => {
  it('never produces a fee figure for a Solana token', () => {
    const sec = solSec();
    // GMGN sends "0"; normalizeSecurity nulls it because the concept does not
    // exist on that chain. Reading the raw "0" here would price every Solana
    // token's fees at exactly zero and reject the whole chain.
    expect(sec?.buyTax).toBeNull();
    expect(sec?.sellTax).toBeNull();
    expect(effectiveFeeRate(sec)).toBeNull();
    expect(estimateTotalFeesUsd(2_600_000, sec)).toBeNull();
  });

  it('ABSTAINS on Solana with a floor set — it never rejects the chain', () => {
    const verdict = evaluateMcapGates(solInput(), withFloor(10_000));
    expect(verdict.decision).toBe('abstain');
    expect(verdict.abstainReason).toBe('total fees unknown');
    expect(verdict.failed).toEqual([]);
  });

  it('leaves Solana completely untouched while the floor is off', () => {
    expect(evaluateMcapGates(solInput(), withFloor(null)).decision).toBe('pass');
  });
});

// --- (1) Ships OFF -----------------------------------------------------------

describe('the fee floor ships OFF', () => {
  const ENV = ['OCT_MCAP_CROSS_MIN_TOTAL_FEES_USD', 'TRENCHCORD_MCAP_CROSS_MIN_TOTAL_FEES_USD'];
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    for (const k of ENV) delete process.env[k];
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('is null in the shipped config, the env layer and an unset user', () => {
    expect(DEFAULT_GATE_CONFIG.minTotalFees).toBeNull();
    expect(resolveGateConfig().minTotalFees).toBeNull();
    expect(resolveUserGateConfig(null).minTotalFees).toBeNull();
    expect(resolveUserGateConfig({})).toEqual(DEFAULT_GATE_CONFIG);
  });

  it('changes nothing for a user who sets nothing, on any chain or input', () => {
    // The compatibility promise, stated as the tokens that would be affected.
    const cases: McapGateInput[] = [
      bscInput(),
      bscInput({ security: bscSec(BSC_UNTAXED) }),
      bscInput({ volume24hUsd: null }),
      bscInput({ security: bscSec(BSC_TAX_UNKNOWN) }),
      solInput(),
      solInput({ volume24hUsd: null }),
    ];
    for (const c of cases) {
      const before = evaluateMcapGates(c, resolveUserGateConfig({}));
      expect(before.decision).toBe(evaluateMcapGates(c, DEFAULT_GATE_CONFIG).decision);
      expect(['pass', 'abstain']).toContain(before.decision);
      expect(before.failed).toEqual([]);
    }
  });

  it('honours the env layer and the TRENCHCORD_ fallback when an operator sets one', () => {
    process.env.OCT_MCAP_CROSS_MIN_TOTAL_FEES_USD = '5000';
    expect(resolveGateConfig().minTotalFees).toBe(5_000);
    delete process.env.OCT_MCAP_CROSS_MIN_TOTAL_FEES_USD;
    process.env.TRENCHCORD_MCAP_CROSS_MIN_TOTAL_FEES_USD = '7000';
    expect(resolveUserGateConfig({}).minTotalFees).toBe(7_000);
    // …and the user still outranks it.
    expect(resolveUserGateConfig({ minTotalFees: 100 }).minTotalFees).toBe(100);
  });
});

// --- (3) and (5) The gate itself ---------------------------------------------

describe('evaluateMcapGates — the fee floor', () => {
  it('rejects a KNOWN figure below a SET floor', () => {
    // $2.6M at 1%/1% = $26K of fees; a $50K floor is not met.
    const verdict = evaluateMcapGates(bscInput(), withFloor(50_000));
    expect(verdict.decision).toBe('reject');
    expect(verdict.failed).toContain('totalFees');
  });

  it('passes a KNOWN figure at or above the floor', () => {
    expect(evaluateMcapGates(bscInput(), withFloor(26_000)).decision).toBe('pass');
    expect(evaluateMcapGates(bscInput(), withFloor(1_000)).decision).toBe('pass');
  });

  it('rejects a genuinely untaxed token — zero fees is a measured zero', () => {
    const verdict = evaluateMcapGates(
      bscInput({ security: bscSec(BSC_UNTAXED) }),
      withFloor(1_000),
    );
    expect(verdict.decision).toBe('reject');
    expect(verdict.failed).toContain('totalFees');
  });

  it('ABSTAINS rather than failing when the volume half is unknown', () => {
    const verdict = evaluateMcapGates(bscInput({ volume24hUsd: null }), withFloor(1_000));
    expect(verdict.decision).toBe('abstain');
    expect(verdict.failed).toEqual([]);
  });

  it('ABSTAINS rather than failing when the rate half is unknown', () => {
    const verdict = evaluateMcapGates(
      bscInput({ security: bscSec(BSC_TAX_UNKNOWN) }),
      withFloor(1_000),
    );
    expect(verdict.decision).toBe('abstain');
    expect(verdict.abstainReason).toBe('total fees unknown');
    expect(verdict.failed).toEqual([]);
  });

  it('never converts an abstain into a pass or a fail, at any floor', () => {
    // Every threshold a user is allowed to store, against every blind input.
    const blind: McapGateInput[] = [
      bscInput({ volume24hUsd: null }),
      bscInput({ security: bscSec(BSC_TAX_UNKNOWN) }),
      solInput(),
      bscInput({ security: null }),
    ];
    for (const input of blind) {
      for (const floor of [0, 1, 1_000, 1e9]) {
        const verdict = evaluateMcapGates(input, resolveUserGateConfig({ minTotalFees: floor }));
        expect(verdict.decision).toBe('abstain');
      }
    }
  });

  it('lets a real gate failure win over the fee abstain, as reject always does', () => {
    // Liquidity already answered the question; a missing fee figure does not
    // reopen it and hand the token a free security lookup every cycle.
    const verdict = evaluateMcapGates(
      solInput({ liquidityUsd: 100 }),
      resolveUserGateConfig({ minTotalFees: 1_000 }),
    );
    expect(verdict.decision).toBe('reject');
  });

  it('carries the computed figure on the verdict even with the floor OFF', () => {
    // The alert card shows the number that justifies the alert; a reader should
    // not have to switch a filter on to see it.
    expect(evaluateMcapGates(bscInput(), withFloor(null)).totalFeesUsd).toBe(26_000);
    expect(evaluateMcapGates(solInput(), withFloor(null)).totalFeesUsd).toBeNull();
  });
});

// --- Bounds and validation ---------------------------------------------------

describe('minTotalFees validation', () => {
  it('is a first-class editable key, so every key-driven surface picks it up', () => {
    // The Telegram panel and the console both render from this table; nothing
    // hardcodes the list, which is why adding the key here is the whole job.
    expect(MCAP_CROSS_FILTER_KEYS).toContain('minTotalFees');
    expect(MCAP_CROSS_FILTER_BOUNDS.minTotalFees.direction).toBe('min');
    expect(MCAP_CROSS_FILTER_BOUNDS.minTotalFees.unit).toBe('usd');
    // The unit belongs in the label: Axiom prints this figure in ETH/SOL.
    expect(MCAP_CROSS_FILTER_BOUNDS.minTotalFees.label).toMatch(/USD/);
  });

  it('accepts a plausible floor and a floor of zero', () => {
    expect(validateFilterPatch({ minTotalFees: 25_000 })).toEqual({
      ok: true,
      value: { minTotalFees: 25_000 },
    });
    // A FLOOR of zero is meaningful ("I do not care"), unlike a ceiling of zero.
    expect(validateFilterPatch({ minTotalFees: 0 }).ok).toBe(true);
  });

  it('rejects negatives, non-numbers, non-finites and absurd magnitudes', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1e15, '5000', true]) {
      expect(validateFilterPatch({ minTotalFees: bad }).ok).toBe(false);
    }
  });

  it('names the field when it rejects, so the console can say what is wrong', () => {
    const result = validateFilterPatch({ minTotalFees: -5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain(MCAP_CROSS_FILTER_BOUNDS.minTotalFees.label);
  });

  it('DROPS a bad stored value back to the baseline rather than opening the gate', () => {
    const junk = { minTotalFees: -5 } as unknown as McapCrossFilters;
    expect(sanitizeStoredFilters(junk)).toEqual({});
    expect(resolveUserGateConfig(junk).minTotalFees).toBeNull();
  });

  it('keeps a good stored value', () => {
    expect(sanitizeStoredFilters({ minTotalFees: 12_345 })).toEqual({ minTotalFees: 12_345 });
  });
});
