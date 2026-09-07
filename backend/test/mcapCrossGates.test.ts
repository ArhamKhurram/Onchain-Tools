import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_GATE_CONFIG,
  DEFAULT_RECROSS_WATERMARK_FACTOR,
  DEFAULT_TARGET_MCAP_USD,
  evaluateMcapGates,
  isWatermarkReCross,
  resolveGateConfig,
  resolveReCrossWatermarkFactor,
  resolveTargetMcapUsd,
  type McapGateInput,
} from '../src/mcapCross/gates.js';
import {
  isBlankSecurity,
  normalizeSecurity,
  readLpSecured,
  type GmgnSecurityRaw,
} from '../src/mcapCross/security.js';
import { AbstainLedger } from '../src/mcapCross/abstainLedger.js';
import { snapshotMatchesNetwork } from '../src/mcapCross/poller.js';
import type { MintSnapshot } from '../src/marketData/dexBatch.js';

/**
 * The 750K market-cap crossing signal.
 *
 * The user asked for one thing: ping me when any coin crosses $750K, but not
 * the scams. Everything below is the "but not the scams" half — hard boolean
 * gates per chain, and the abstain rule that stops a data gap being read as a
 * clean bill of health.
 */

// --- Security normalisation --------------------------------------------------
//
// Payload shapes recorded from the LIVE GMGN API on 2026-09-05, not invented.

/** sol / BONK. Renounced both ways; GMGN has no LP record for it. */
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

/** bsc / CAKE. Renounced flags are false because they are not EVM concepts. */
const BSC_HEALTHY: GmgnSecurityRaw = {
  address: '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82',
  top_10_holder_rate: '0.0351',
  burn_ratio: '0',
  burn_status: '',
  is_honeypot: false,
  renounced_mint: false,
  renounced_freeze_account: false,
  buy_tax: '0',
  sell_tax: '0',
  lock_summary: { is_locked: true, lock_detail: [{ percent: '0.95', is_blackhole: true }] },
};

/** The success-with-blanks answer for an address GMGN has never indexed. */
const BLANK: GmgnSecurityRaw = {
  address: '',
  top_10_holder_rate: '',
  burn_ratio: '',
  burn_status: '',
  is_honeypot: null,
  renounced_mint: false,
  renounced_freeze_account: false,
  buy_tax: '',
  sell_tax: '',
};

describe('normalizeSecurity', () => {
  it('treats a code:0 payload with a blank address as no answer at all', () => {
    // The whole abstain rule rests on this. GMGN answers "success" for tokens
    // it has never indexed, with renounced_mint: false — reading that literally
    // turns "never heard of it" into "the dev can still print", which is a
    // confident rejection built on nothing.
    expect(isBlankSecurity(BLANK)).toBe(true);
    expect(normalizeSecurity(BLANK, 'solana')).toBeNull();
    expect(normalizeSecurity(BLANK, 'bsc')).toBeNull();
  });

  it('keeps the Solana authority flags on Solana', () => {
    const sec = normalizeSecurity(SOL_HEALTHY, 'solana');
    expect(sec?.mintRenounced).toBe(true);
    expect(sec?.freezeRenounced).toBe(true);
    expect(sec?.top10HolderRate).toBeCloseTo(0.3174);
  });

  it('nulls the Solana authority flags on EVM, where they are always false', () => {
    // CAKE really does come back renounced_mint:false — the field is a Solana
    // concept. Carrying it through would reject every BNB token forever.
    const sec = normalizeSecurity(BSC_HEALTHY, 'bsc');
    expect(sec?.mintRenounced).toBeNull();
    expect(sec?.freezeRenounced).toBeNull();
    expect(sec?.honeypot).toBe(false);
    expect(sec?.buyTax).toBe(0);
  });

  it('nulls the EVM honeypot/tax fields on Solana, where they cannot exist', () => {
    const sec = normalizeSecurity(SOL_HEALTHY, 'solana');
    expect(sec?.honeypot).toBeNull();
    expect(sec?.buyTax).toBeNull();
    expect(sec?.sellTax).toBeNull();
  });
});

describe('readLpSecured', () => {
  it('accepts a burn, a lock, or LP sent to the blackhole', () => {
    expect(readLpSecured({ address: 'x', burn_status: 'burn', burn_ratio: '1' })).toBe(true);
    expect(readLpSecured({ address: 'x', lock_summary: { is_locked: true } })).toBe(true);
    expect(
      readLpSecured({
        address: 'x',
        lock_summary: { is_locked: false, lock_detail: [{ percent: '0.95', is_blackhole: true }] },
      }),
    ).toBe(true);
  });

  it('says "unknown", not "insecure", when GMGN offered nothing on the subject', () => {
    // An older token GMGN has no LP record for must abstain rather than be
    // rejected — otherwise the gate rejects legitimate tokens for our own
    // provider's silence.
    expect(readLpSecured({ address: 'x' })).toBeNull();
  });

  it('says "insecure" only when GMGN evidently looked and found nothing', () => {
    expect(readLpSecured({ address: 'x', burn_status: 'none', lock_summary: { is_locked: false } })).toBe(
      false,
    );
  });
});

// --- The gates ---------------------------------------------------------------

function input(partial: Partial<McapGateInput>): McapGateInput {
  return {
    network: 'solana',
    mcapUsd: 800_000,
    liquidityUsd: 60_000,
    // UNKNOWN by default, deliberately. Most of the suite below is about a
    // world where no volume filter is set, and in that world an unknown volume
    // must be invisible — so the default input is the awkward case, not the
    // convenient one.
    volume24hUsd: null,
    security: normalizeSecurity(SOL_HEALTHY, 'solana'),
    ...partial,
  };
}

describe('evaluateMcapGates', () => {
  it('passes a healthy Solana token that has crossed', () => {
    expect(evaluateMcapGates(input({})).decision).toBe('pass');
  });

  it('passes a healthy BNB token — the Solana authority gates do not apply', () => {
    const verdict = evaluateMcapGates(
      input({ network: 'bsc', security: normalizeSecurity(BSC_HEALTHY, 'bsc') }),
    );
    expect(verdict.decision).toBe('pass');
  });

  it('rejects a token whose pool is too thin to exit', () => {
    const verdict = evaluateMcapGates(input({ liquidityUsd: 5_000 }));
    expect(verdict.decision).toBe('reject');
    expect(verdict.failed).toContain('liquidity');
  });

  it('rejects a fake market cap — a big number on no real float', () => {
    // 900K "mcap" on 22K of pooled value is above the absolute floor and still
    // 2.4% of the cap; drop it to 12K and the ratio gate is what catches it.
    const verdict = evaluateMcapGates(input({ mcapUsd: 5_000_000, liquidityUsd: 25_000 }));
    expect(verdict.decision).toBe('reject');
    expect(verdict.failed).toContain('liquidityRatio');
    expect(verdict.liquidityRatio).toBeCloseTo(0.005);
  });

  it('rejects an unrevoked Solana freeze authority — the real Solana honeypot', () => {
    const sec = normalizeSecurity({ ...SOL_HEALTHY, renounced_freeze_account: false }, 'solana');
    const verdict = evaluateMcapGates(input({ security: sec }));
    expect(verdict.decision).toBe('reject');
    expect(verdict.failed).toEqual(['freezeAuthority']);
  });

  it('rejects an unrevoked Solana mint authority', () => {
    const sec = normalizeSecurity({ ...SOL_HEALTHY, renounced_mint: false }, 'solana');
    expect(evaluateMcapGates(input({ security: sec })).failed).toEqual(['mintAuthority']);
  });

  it('rejects the one-holder-owns-everything shape', () => {
    // Measured: the rug-shaped BNB tokens in the live sample returned exactly
    // 1.0, against 0.14-0.28 for the legitimate ones.
    const sec = normalizeSecurity({ ...BSC_HEALTHY, top_10_holder_rate: '1' }, 'bsc');
    const verdict = evaluateMcapGates(input({ network: 'bsc', security: sec }));
    expect(verdict.failed).toContain('top10Concentration');
  });

  it('rejects an explicit EVM honeypot flag and punitive taxes', () => {
    const sec = normalizeSecurity(
      { ...BSC_HEALTHY, is_honeypot: true, buy_tax: '0.15', sell_tax: '0.4' },
      'bsc',
    );
    const verdict = evaluateMcapGates(input({ network: 'bsc', security: sec }));
    expect(verdict.failed).toEqual(['honeypot', 'buyTax', 'sellTax']);
  });

  it('does NOT treat a null honeypot flag as a rejection', () => {
    // is_honeypot comes back null even for CAKE. Abstaining on it would silence
    // BNB almost entirely; the liquidity, ratio, tax and concentration gates
    // still stand. Judgement call, and it is a deliberate one.
    const sec = normalizeSecurity({ ...BSC_HEALTHY, is_honeypot: null }, 'bsc');
    expect(evaluateMcapGates(input({ network: 'bsc', security: sec })).decision).toBe('pass');
  });

  it('flags a null honeypot flag as a caveat so the card cannot imply it passed', () => {
    // The pass above is deliberate; presenting it as a clean 'Scam-filtered'
    // result is not. The caveat is what lets delivery stay permissive and
    // honest at the same time.
    const sec = normalizeSecurity({ ...BSC_HEALTHY, is_honeypot: null }, 'bsc');
    expect(evaluateMcapGates(input({ network: 'bsc', security: sec })).caveats).toEqual([
      'honeypotUnknown',
    ]);
  });

  it('adds no honeypot caveat when the flag was actually evaluated', () => {
    const sec = normalizeSecurity({ ...BSC_HEALTHY, is_honeypot: false }, 'bsc');
    expect(evaluateMcapGates(input({ network: 'bsc', security: sec })).caveats).toEqual([]);
  });

  it('adds no honeypot caveat on Solana, where the flag is meaningless', () => {
    // normalizeSecurity nulls `honeypot` on Solana by design, so a naive
    // null-check would caveat every Solana alert forever.
    const sec = normalizeSecurity(SOL_HEALTHY, 'solana');
    expect(evaluateMcapGates(input({ network: 'solana', security: sec })).caveats).toEqual([]);
  });

  it('rejects an LP that GMGN says is neither burned nor locked', () => {
    const sec = normalizeSecurity(
      { ...SOL_HEALTHY, burn_status: 'none', burn_ratio: '0', lock_summary: { is_locked: false } },
      'solana',
    );
    expect(evaluateMcapGates(input({ security: sec })).failed).toContain('lpSecured');
  });

  it('ABSTAINS rather than firing when the security provider could not answer', () => {
    // A GMGN outage or a RATE_LIMIT_BANNED state must never read as "safe".
    const verdict = evaluateMcapGates(input({ security: null }));
    expect(verdict.decision).toBe('abstain');
    expect(verdict.abstainReason).toBe('security lookup unavailable');
  });

  it('still rejects on liquidity alone when security is unavailable', () => {
    // Abstain must not become a free pass around gates we CAN evaluate;
    // otherwise every unindexed rug earns a security lookup every cycle.
    const verdict = evaluateMcapGates(input({ security: null, liquidityUsd: 900 }));
    expect(verdict.decision).toBe('reject');
  });

  it('abstains when the Solana authorities are simply unknown', () => {
    const sec = normalizeSecurity(
      { ...SOL_HEALTHY, renounced_mint: null, renounced_freeze_account: null },
      'solana',
    );
    const verdict = evaluateMcapGates(input({ security: sec }));
    expect(verdict.decision).toBe('abstain');
    expect(verdict.abstainReason).toBe('mint authority unknown');
  });

  it('abstains when there is no liquidity figure at all', () => {
    expect(evaluateMcapGates(input({ liquidityUsd: null })).decision).toBe('abstain');
  });

  it('never fires on a missing market cap', () => {
    expect(evaluateMcapGates(input({ mcapUsd: null })).decision).toBe('abstain');
    expect(evaluateMcapGates(input({ mcapUsd: Number.NaN })).decision).toBe('abstain');
  });
});

// --- Config ------------------------------------------------------------------

const ENV_KEYS = [
  'OCT_MCAP_CROSS_TARGET_USD',
  'TRENCHCORD_MCAP_CROSS_TARGET_USD',
  'OCT_MCAP_CROSS_MIN_LIQUIDITY_USD',
  'OCT_MCAP_CROSS_REQUIRE_LP_SECURED',
  'OCT_MCAP_CROSS_MIN_PRICE_CHANGE_H24',
  'OCT_MCAP_CROSS_MAX_POOL_AGE_DAYS',
  'OCT_MCAP_CROSS_RECROSS_WATERMARK_FACTOR',
  'OCT_MCAP_CROSS_MAX_BUNDLER_RATE',
  'OCT_MCAP_CROSS_MAX_SNIPER_RATE',
  'OCT_MCAP_CROSS_MAX_INSIDER_RATE',
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

describe('config', () => {
  it('targets $750K by default — the threshold IS the feature', () => {
    expect(DEFAULT_TARGET_MCAP_USD).toBe(750_000);
    expect(resolveTargetMcapUsd()).toBe(750_000);
  });

  it('reads OCT_ and TRENCHCORD_ prefixes, in that order', () => {
    process.env.TRENCHCORD_MCAP_CROSS_TARGET_USD = '500000';
    expect(resolveTargetMcapUsd()).toBe(500_000);
    process.env.OCT_MCAP_CROSS_TARGET_USD = '1000000';
    expect(resolveTargetMcapUsd()).toBe(1_000_000);
  });

  it('ignores a garbage target rather than disabling the signal', () => {
    process.env.OCT_MCAP_CROSS_TARGET_USD = 'soon';
    expect(resolveTargetMcapUsd()).toBe(DEFAULT_TARGET_MCAP_USD);
  });

  it('lets an operator switch the LP requirement off', () => {
    expect(resolveGateConfig()).toEqual(DEFAULT_GATE_CONFIG);
    process.env.OCT_MCAP_CROSS_REQUIRE_LP_SECURED = 'false';
    expect(resolveGateConfig().requireLpSecured).toBe(false);
  });

  it('does not require an LP verdict when the LP gate is off', () => {
    const sec = normalizeSecurity(
      { ...SOL_HEALTHY, burn_status: '', burn_ratio: '', lock_summary: null },
      'solana',
    );
    expect(sec?.lpSecured).toBeNull();
    const cfg = { ...DEFAULT_GATE_CONFIG, requireLpSecured: false };
    expect(evaluateMcapGates(input({ security: sec }), cfg).decision).toBe('pass');
  });
});

// --- Bounded abstain ----------------------------------------------------------

describe('AbstainLedger', () => {
  it('retries a few times, then gives up so the retry cannot leak forever', () => {
    const ledger = new AbstainLedger(3);
    expect(ledger.note('a')).toBe('retry');
    expect(ledger.note('a')).toBe('retry');
    expect(ledger.note('a')).toBe('give-up');
    // Cleared on give-up: a token that starts resolving later gets a full
    // budget rather than staying poisoned by an old provider outage.
    expect(ledger.attemptsFor('a')).toBe(0);
  });

  it('counts tokens independently and forgets a resolved one', () => {
    const ledger = new AbstainLedger(5);
    ledger.note('a');
    ledger.note('b');
    expect(ledger.size()).toBe(2);
    ledger.clear('a');
    expect(ledger.size()).toBe(1);
  });
});

// --- Cross-chain address collisions ------------------------------------------

function snap(chainId: string | null): MintSnapshot {
  return {
    mint: '0xabc',
    symbol: null,
    priceUsd: 1,
    mcapUsd: 1,
    liquidityUsd: 1,
    volume24hUsd: null,
    chainId,
  };
}

describe('snapshotMatchesNetwork', () => {
  it('rejects a snapshot that is plainly about another watched chain', () => {
    // /latest/dex/tokens/{addr} is address-keyed and chain-agnostic, so one 0x…
    // address deployed on both BNB and Robinhood comes back as one set of pairs.
    expect(snapshotMatchesNetwork(snap('bsc'), 'robinhood')).toBe(false);
    expect(snapshotMatchesNetwork(snap('bsc'), 'bsc')).toBe(true);
  });

  it('accepts a slug it has no opinion about — a wrong guess must cost a miss, not a wrong alert', () => {
    expect(snapshotMatchesNetwork(snap('base'), 'bsc')).toBe(true);
    expect(snapshotMatchesNetwork(snap(null), 'bsc')).toBe(true);
  });
});


/**
 * The 24h volume floor — the one gate that is OFF unless somebody turns it on.
 *
 * WHY THIS BLOCK IS LONGER THAN THE GATE IT TESTS. Three separate ways to get
 * this wrong, and only one of them would be noticed by anybody:
 *
 *   1. Shipping it ON. Every existing user's alerts change silently.
 *   2. Reading an unknown volume as zero. A floor then REJECTS exactly the
 *      tokens the upstream is quietest about, and the failure looks like a
 *      quiet market rather than a bug — the same shape pinaxCandles.ts's
 *      calibration guard exists to prevent.
 *   3. Reading an unknown volume as a PASS. That is the abstain rule inverted,
 *      and it would let a filter manufacture confidence out of a null, which
 *      is precisely why `requireLpSecured` is not user-editable.
 *
 * Only (1) is visible in production; (2) and (3) are silent. Hence the
 * coverage.
 */
describe('evaluateMcapGates — 24h volume floor', () => {
  const withFloor = (min: number | null) => ({ ...DEFAULT_GATE_CONFIG, minVolume24hUsd: min });

  // --- (1) No filter set: today's behaviour, exactly ------------------------

  it('ships OFF, so a user who sets nothing is unaffected', () => {
    expect(DEFAULT_GATE_CONFIG.minVolume24hUsd).toBeNull();
    expect(resolveGateConfig().minVolume24hUsd).toBeNull();
  });

  it('ignores volume entirely when no floor is set — known, unknown or zero', () => {
    for (const volume24hUsd of [null, 0, 12, 50_000_000]) {
      expect(evaluateMcapGates(input({ volume24hUsd })).decision).toBe('pass');
    }
  });

  it('is not evaluated at all when off, so it cannot appear among the failures', () => {
    const verdict = evaluateMcapGates(input({ volume24hUsd: 0 }), withFloor(null));
    expect(verdict.decision).toBe('pass');
    expect(verdict.failed).toEqual([]);
  });

  // --- (2) Set + known: an ordinary comparison ------------------------------

  it('rejects a token below a set floor', () => {
    const verdict = evaluateMcapGates(input({ volume24hUsd: 5_000 }), withFloor(50_000));
    expect(verdict.decision).toBe('reject');
    expect(verdict.failed).toContain('volume24h');
  });

  it('passes a token above a set floor', () => {
    expect(evaluateMcapGates(input({ volume24hUsd: 500_000 }), withFloor(50_000)).decision).toBe(
      'pass',
    );
  });

  it('treats a genuine reported zero as a real reading, not as a gap', () => {
    // "Listed, and nobody traded it" is data. Only "nobody reported" is a gap.
    const verdict = evaluateMcapGates(input({ volume24hUsd: 0 }), withFloor(1));
    expect(verdict.decision).toBe('reject');
    expect(verdict.failed).toContain('volume24h');
  });

  it('accepts a floor of zero as a real threshold every listed token clears', () => {
    expect(evaluateMcapGates(input({ volume24hUsd: 0 }), withFloor(0)).decision).toBe('pass');
  });

  // --- (3) Set + unknown: ABSTAIN. The whole point. -------------------------

  it('ABSTAINS on an unknown volume rather than failing it', () => {
    const verdict = evaluateMcapGates(input({ volume24hUsd: null }), withFloor(50_000));
    expect(verdict.decision).toBe('abstain');
    expect(verdict.abstainReason).toBe('24h volume unknown');
    expect(verdict.failed).toEqual([]);
  });

  it('abstains on an unknown volume for EVERY watched chain, not just Solana', () => {
    // The metric comes from the same DexScreener batch on all three chains, so
    // there is no chain where it is structurally absent — but a per-token gap
    // must abstain identically wherever it happens. A filter that silently
    // rejected every BNB and Robinhood token would look exactly like a quiet
    // week on those chains.
    const cases: McapGateInput[] = [
      input({ network: 'solana', volume24hUsd: null }),
      input({
        network: 'bsc',
        volume24hUsd: null,
        security: normalizeSecurity(BSC_HEALTHY, 'bsc'),
      }),
      input({
        network: 'robinhood',
        volume24hUsd: null,
        security: normalizeSecurity(BSC_HEALTHY, 'robinhood'),
      }),
    ];
    for (const c of cases) {
      const verdict = evaluateMcapGates(c, withFloor(50_000));
      expect(verdict.decision).toBe('abstain');
      expect(verdict.failed).toEqual([]);
    }
  });

  it('abstains on a NaN volume too — a non-finite number is not a reading', () => {
    expect(evaluateMcapGates(input({ volume24hUsd: NaN }), withFloor(1)).decision).toBe('abstain');
  });

  it('never lets the floor turn an abstain into a pass', () => {
    // Unknown volume AND unknown Solana authorities. Whatever the floor says,
    // the answer is still "we could not tell".
    const blind = input({ volume24hUsd: null, security: normalizeSecurity(
        { ...SOL_HEALTHY, renounced_mint: null, renounced_freeze_account: null },
        'solana',
      ) });
    for (const floor of [null, 0, 1_000_000]) {
      expect(evaluateMcapGates(blind, withFloor(floor)).decision).toBe('abstain');
    }
  });

  it('keeps reject ahead of abstain — a thin pool answers the question anyway', () => {
    // Consistent with the existing rule: a token that fails a gate it CAN be
    // measured against is not an open question just because something else was
    // missing. Otherwise every unindexable token buys a free security lookup
    // every cycle, forever.
    const verdict = evaluateMcapGates(
      input({ volume24hUsd: null, liquidityUsd: 100 }),
      withFloor(50_000),
    );
    expect(verdict.decision).toBe('reject');
    expect(verdict.failed).toContain('liquidity');
  });

  it('does not disturb the honeypot caveat', () => {
    // #369: an unevaluated check is surfaced, never hidden. A volume threshold
    // is a comparison over market data and must not touch that.
    const verdict = evaluateMcapGates(
      input({
        network: 'bsc',
        volume24hUsd: 500_000,
        security: normalizeSecurity({ ...BSC_HEALTHY, is_honeypot: null }, 'bsc'),
      }),
      withFloor(50_000),
    );
    expect(verdict.decision).toBe('pass');
    expect(verdict.caveats).toContain('honeypotUnknown');
  });
});

// --- The first-run-up discriminator ------------------------------------------
//
// The owner reported the 750K signal firing on tokens that had ALREADY run and
// were falling back DOWN through the threshold (a dead-cat bounce) rather than
// climbing through it for the first time. The concrete case was $LOOM: chart
// ATH 2.14M, now ~765K, 24h -20.52%, a 46-day-old pool — it "crossed" 750K
// upward as a bounce inside a larger downtrend. These pin the three signals
// that separate a first run-up from a fall-back.

describe('evaluateMcapGates — first-run-up momentum gate', () => {
  it('ships ON: the default floor is 0, not null (it IS the fix)', () => {
    expect(DEFAULT_GATE_CONFIG.minPriceChangeH24).toBe(0);
    expect(resolveGateConfig().minPriceChangeH24).toBe(0);
  });

  it('SUPPRESSES the LOOM case — negative 24h change, old pool, upward tick', () => {
    // Under the SHIPPED config: no operator age ceiling, momentum floor 0. The
    // momentum gate alone rejects it; the age is real but not what drops it.
    const verdict = evaluateMcapGates(
      input({ mcapUsd: 765_000, priceChangeH24: -0.2052, poolAgeMs: 46 * 86_400_000 }),
    );
    expect(verdict.decision).toBe('reject');
    expect(verdict.failed).toContain('momentum');
  });

  it('FIRES a genuine young fast-climber — strong positive momentum', () => {
    const verdict = evaluateMcapGates(
      input({ mcapUsd: 780_000, priceChangeH24: 3.2, poolAgeMs: 4 * 3_600_000 }),
    );
    expect(verdict.decision).toBe('pass');
  });

  it('abstain-to-FIRE: an UNKNOWN 24h change is never a drop (does not mute the signal)', () => {
    expect(evaluateMcapGates(input({ priceChangeH24: null })).decision).toBe('pass');
    expect(evaluateMcapGates(input({ priceChangeH24: undefined })).decision).toBe('pass');
    expect(evaluateMcapGates(input({ priceChangeH24: Number.NaN })).decision).toBe('pass');
  });

  it('is user-tunable: a higher floor rejects a weak climber the default passes', () => {
    const weak = input({ priceChangeH24: 0.05 }); // +5%
    expect(evaluateMcapGates(weak).decision).toBe('pass'); // default floor 0
    const cfg = { ...DEFAULT_GATE_CONFIG, minPriceChangeH24: 0.5 }; // require +50%
    const verdict = evaluateMcapGates(weak, cfg);
    expect(verdict.decision).toBe('reject');
    expect(verdict.failed).toContain('momentum');
  });

  it('no regression when loosened below zero — a downtrend fires again', () => {
    const cfg = { ...DEFAULT_GATE_CONFIG, minPriceChangeH24: -1 };
    expect(evaluateMcapGates(input({ priceChangeH24: -0.2052 }), cfg).decision).toBe('pass');
  });

  it('rejects on momentum even when the security lookup is unavailable', () => {
    // Momentum is a market-data gate, so a fall-back drops without paying for a
    // security call; security:null must not turn that reject into an abstain.
    const verdict = evaluateMcapGates(input({ priceChangeH24: -0.3, security: null }));
    expect(verdict.decision).toBe('reject');
    expect(verdict.failed).toContain('momentum');
  });

  it('reads the floor from env, signed (an operator may loosen below 0)', () => {
    process.env.OCT_MCAP_CROSS_MIN_PRICE_CHANGE_H24 = '-0.5';
    expect(resolveGateConfig().minPriceChangeH24).toBe(-0.5);
  });
});

describe('evaluateMcapGates — pool-age corroboration', () => {
  it('is OFF by default — a 46-day pool is never dropped on age alone', () => {
    expect(DEFAULT_GATE_CONFIG.maxPoolAgeDays).toBeNull();
    const old = input({ poolAgeMs: 46 * 86_400_000, priceChangeH24: 1.0 });
    expect(evaluateMcapGates(old).decision).toBe('pass');
  });

  it('an operator ceiling rejects a KNOWN old pool', () => {
    const cfg = { ...DEFAULT_GATE_CONFIG, maxPoolAgeDays: 7 };
    const verdict = evaluateMcapGates(
      input({ poolAgeMs: 46 * 86_400_000, priceChangeH24: 1.0 }),
      cfg,
    );
    expect(verdict.decision).toBe('reject');
    expect(verdict.failed).toContain('poolAge');
  });

  it('passes a young pool under the ceiling', () => {
    const cfg = { ...DEFAULT_GATE_CONFIG, maxPoolAgeDays: 7 };
    expect(
      evaluateMcapGates(input({ poolAgeMs: 2 * 86_400_000, priceChangeH24: 1.0 }), cfg).decision,
    ).toBe('pass');
  });

  it('abstain-to-FIRE: an unknown age fires even with a ceiling set', () => {
    const cfg = { ...DEFAULT_GATE_CONFIG, maxPoolAgeDays: 7 };
    expect(evaluateMcapGates(input({ poolAgeMs: null, priceChangeH24: 1.0 }), cfg).decision).toBe(
      'pass',
    );
  });

  it('reads the ceiling from env (null when unset)', () => {
    expect(resolveGateConfig().maxPoolAgeDays).toBeNull();
    process.env.OCT_MCAP_CROSS_MAX_POOL_AGE_DAYS = '30';
    expect(resolveGateConfig().maxPoolAgeDays).toBe(30);
  });
});

describe('evaluateMcapGates — manufactured-launch discriminators', () => {
  // Recorded live 2026-09-07: a bundled pump.fun launch vs organic BONK.
  const BUNDLED = { bundlerRate: 0.2273, sniperRate: 0.127, insiderRate: 0 };
  const ORGANIC = { bundlerRate: 0.0017, sniperRate: 0.0000003, insiderRate: 0.0006 };

  it('are OFF by default — a bundled token still fires when no ceiling is set', () => {
    expect(DEFAULT_GATE_CONFIG.maxBundlerRate).toBeNull();
    expect(DEFAULT_GATE_CONFIG.maxSniperRate).toBeNull();
    expect(DEFAULT_GATE_CONFIG.maxInsiderRate).toBeNull();
    expect(evaluateMcapGates(input({ manipulation: BUNDLED })).decision).toBe('pass');
  });

  it('reject a bundled token and pass an organic one once a ceiling is set', () => {
    const cfg = { ...DEFAULT_GATE_CONFIG, maxBundlerRate: 0.1 };
    const rejected = evaluateMcapGates(input({ manipulation: BUNDLED }), cfg);
    expect(rejected.decision).toBe('reject');
    expect(rejected.failed).toContain('bundlerRate');
    expect(evaluateMcapGates(input({ manipulation: ORGANIC }), cfg).decision).toBe('pass');
  });

  it('abstain-to-FIRE: an unknown flag (or whole payload) fires even with a ceiling set', () => {
    const cfg = { ...DEFAULT_GATE_CONFIG, maxBundlerRate: 0.05, maxSniperRate: 0.05, maxInsiderRate: 0.05 };
    // Whole payload missing — GMGN unindexed, rate-limited, or a chain (BNB) that
    // reports nothing. Deliberately NOT in missingCriticalFields, so it fires.
    expect(evaluateMcapGates(input({ manipulation: null }), cfg).decision).toBe('pass');
    expect(evaluateMcapGates(input({ manipulation: undefined }), cfg).decision).toBe('pass');
    // A single unknown field among known-good ones is ignored, not failed.
    const partial = input({ manipulation: { bundlerRate: null, sniperRate: 0.01, insiderRate: null } });
    expect(evaluateMcapGates(partial, cfg).decision).toBe('pass');
  });

  it('rejects on a bundled token even when the security lookup is unavailable', () => {
    // Evaluated before the security block, like momentum: a null security payload
    // does not rescue a token whose bundler share is known-bad.
    const cfg = { ...DEFAULT_GATE_CONFIG, maxBundlerRate: 0.1 };
    const verdict = evaluateMcapGates(input({ security: null, manipulation: BUNDLED }), cfg);
    expect(verdict.decision).toBe('reject');
    expect(verdict.failed).toContain('bundlerRate');
  });

  it('reads the ceilings from env (null when unset)', () => {
    expect(resolveGateConfig().maxBundlerRate).toBeNull();
    process.env.OCT_MCAP_CROSS_MAX_SNIPER_RATE = '0.2';
    expect(resolveGateConfig().maxSniperRate).toBe(0.2);
  });
});

describe('isWatermarkReCross — re-cross suppression via the high-watermark', () => {
  const target = 750_000;
  const factor = DEFAULT_RECROSS_WATERMARK_FACTOR; // 1.3

  it('suppresses a re-cross of a token seen WELL above the target before', () => {
    expect(isWatermarkReCross(2_100_000, target, factor)).toBe(true);
    expect(isWatermarkReCross(target * 1.3, target, factor)).toBe(true);
  });

  it('does NOT suppress a genuine first cross (watermark climbed from below)', () => {
    expect(isWatermarkReCross(740_000, target, factor)).toBe(false);
    // Above the target but not yet "well above" — cooldown, not watermark, owns
    // the tight oscillation here.
    expect(isWatermarkReCross(target * 1.1, target, factor)).toBe(false);
  });

  it('the honest limit: a null/unseen watermark never suppresses (LOOM found late)', () => {
    expect(isWatermarkReCross(null, target, factor)).toBe(false);
    expect(isWatermarkReCross(undefined, target, factor)).toBe(false);
    expect(isWatermarkReCross(Number.NaN, target, factor)).toBe(false);
  });

  it('guards a nonsense target or factor', () => {
    expect(isWatermarkReCross(5_000_000, 0, factor)).toBe(false);
    expect(isWatermarkReCross(5_000_000, target, 0.5)).toBe(false);
  });

  it('reads the factor from env, floored at 1', () => {
    expect(resolveReCrossWatermarkFactor()).toBe(DEFAULT_RECROSS_WATERMARK_FACTOR);
    process.env.OCT_MCAP_CROSS_RECROSS_WATERMARK_FACTOR = '2';
    expect(resolveReCrossWatermarkFactor()).toBe(2);
    process.env.OCT_MCAP_CROSS_RECROSS_WATERMARK_FACTOR = '0.5';
    expect(resolveReCrossWatermarkFactor()).toBe(DEFAULT_RECROSS_WATERMARK_FACTOR);
  });
});
