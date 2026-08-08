import { describe, it, expect } from 'vitest';
import {
  buildPopulationIndex,
  deriveFdv,
  deriveImpliedSupply,
  formatRecoveredDisplay,
  isContemporaneousCatalogWrite,
  passesSanityTripwire,
  pickPricePoint,
  resolveCatalogExact,
  resolveSibling,
  screenRow,
  toBirdeyeChain,
  type CandidateRow,
  type CatalogRow,
  type RecoveryTier,
} from '../src/scripts/fdvRecovery/rules.js';
import {
  emptyTally,
  planOfflineTiers,
  resolveDerived,
  tallyPlan,
  type PlanContext,
} from '../src/scripts/fdvRecovery/planner.js';

const T0 = '2026-08-01T12:00:00.000Z';
const at = (offsetSeconds: number) => new Date(Date.parse(T0) + offsetSeconds * 1000).toISOString();

function row(over: Partial<CandidateRow> = {}): CandidateRow {
  return {
    id: 'row-1',
    userId: 'user-1',
    address: 'So11111111111111111111111111111111111111112',
    chain: 'sol',
    evmChain: null,
    messageId: 'msg-1',
    timestamp: T0,
    fdvAtCall: null,
    priceUsd: null,
    tokenSymbol: 'PUF',
    provenance: null,
    ...over,
  };
}

function catalog(over: Partial<CatalogRow> = {}): CatalogRow {
  return {
    address: 'So11111111111111111111111111111111111111112',
    chain: 'sol',
    evmChain: null,
    symbol: 'PUF',
    fdv: 816_000,
    enrichedAt: at(15),
    ...over,
  };
}

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  const index = buildPopulationIndex([], []);
  return {
    index,
    population: 'all',
    tiers: new Set<RecoveryTier>(['catalog_exact', 'sibling_measured']),
    catalogFor: () => [],
    addressRowsFor: () => [],
    siblingsFor: () => [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// TIER 0 — who is even a candidate
// ---------------------------------------------------------------------------

describe('screenRow', () => {
  it('refuses every row in a duplicate group rather than filling all of them', () => {
    const a = row({ id: 'a' });
    const b = row({ id: 'b' }); // same user + message + address: the #87 phantom class
    const index = buildPopulationIndex([a, b], [catalog()]);

    expect(screenRow(a, index, 'all')).toEqual({ eligible: false, reason: 'duplicate_row_group' });
    expect(screenRow(b, index, 'all')).toEqual({ eligible: false, reason: 'duplicate_row_group' });
  });

  it('refuses addresses no provider ever recognised as a token', () => {
    // Regex address detection puts wallets and program ids in `contracts` too.
    const junk = row({ tokenSymbol: null });
    const index = buildPopulationIndex([junk], []);
    expect(screenRow(junk, index, 'all')).toEqual({
      eligible: false,
      reason: 'address_never_resolved',
    });
  });

  it('accepts an address the catalog knows even when no contracts row has a symbol', () => {
    const bare = row({ tokenSymbol: null });
    const index = buildPopulationIndex([bare], [catalog()]);
    expect(screenRow(bare, index, 'all')).toEqual({ eligible: true, population: 'A' });
  });

  it('splits population A (radar-blank) from B (a sibling already supplies the number)', () => {
    const blank = row({ id: 'a' });
    const measured = row({ id: 'b', messageId: 'msg-2', fdvAtCall: 500_000 });
    const indexA = buildPopulationIndex([blank], [catalog()]);
    const indexB = buildPopulationIndex([blank, measured], [catalog()]);

    expect(screenRow(blank, indexA, 'all')).toEqual({ eligible: true, population: 'A' });
    expect(screenRow(blank, indexB, 'all')).toEqual({ eligible: true, population: 'B' });
    expect(screenRow(blank, indexB, 'A')).toEqual({ eligible: false, reason: 'population_filtered' });
  });

  it('does not count a RECOVERED sibling as making the address population B', () => {
    const blank = row({ id: 'a' });
    const recovered = row({
      id: 'b',
      messageId: 'msg-2',
      fdvAtCall: 500_000,
      provenance: 'sibling_measured',
    });
    const index = buildPopulationIndex([blank, recovered], [catalog()]);
    expect(screenRow(blank, index, 'all')).toEqual({ eligible: true, population: 'A' });
  });

  it('never reconsiders a row that already has a value', () => {
    const filled = row({ fdvAtCall: 1234 });
    const index = buildPopulationIndex([filled], [catalog()]);
    expect(screenRow(filled, index, 'all')).toEqual({ eligible: false, reason: 'already_filled' });
  });

  it('keeps Solana case-sensitive so two base58 mints never share a population entry', () => {
    const lower = row({ address: 'AbCdEf1111111111111111111111111111111111111', tokenSymbol: 'A' });
    const other = row({
      id: 'b',
      messageId: 'm2',
      address: 'abcdef1111111111111111111111111111111111111',
      tokenSymbol: null,
    });
    const index = buildPopulationIndex([lower, other], []);
    expect(screenRow(other, index, 'all')).toEqual({
      eligible: false,
      reason: 'address_never_resolved',
    });
  });
});

// ---------------------------------------------------------------------------
// TIER 1 — the contemporaneous-window check
// ---------------------------------------------------------------------------

describe('isContemporaneousCatalogWrite', () => {
  it('accepts a catalog write inside the fallback timer plus a round trip', () => {
    expect(isContemporaneousCatalogWrite(T0, at(8))).toBe(true);
    expect(isContemporaneousCatalogWrite(T0, at(15))).toBe(true);
    expect(isContemporaneousCatalogWrite(T0, at(120))).toBe(true);
  });

  it('is asymmetric: a stale value before the call inflates the multiplier', () => {
    expect(isContemporaneousCatalogWrite(T0, at(-10))).toBe(true); // clock skew only
    expect(isContemporaneousCatalogWrite(T0, at(-11))).toBe(false);
    expect(isContemporaneousCatalogWrite(T0, at(121))).toBe(false);
  });

  it('refuses an unparseable timestamp instead of treating it as zero', () => {
    expect(isContemporaneousCatalogWrite(T0, 'not-a-date')).toBe(false);
  });
});

describe('resolveCatalogExact', () => {
  it('takes the catalog fdv when the write is provably this call', () => {
    const c = row();
    const out = resolveCatalogExact(c, [catalog()], [c]);
    expect(out).toMatchObject({ ok: true, tier: 'catalog_exact', fdv: 816_000 });
  });

  it('refuses when another mention landed between the call and the catalog write', () => {
    const c = row();
    const competing = row({ id: 'b', userId: 'user-2', messageId: 'm2', timestamp: at(5) });
    const out = resolveCatalogExact(c, [catalog()], [c, competing]);
    expect(out).toEqual({ ok: false, reason: 'catalog_competing_mention' });
  });

  it('refuses a catalog row that has since been refreshed', () => {
    const c = row();
    expect(resolveCatalogExact(c, [catalog({ enrichedAt: at(3600) })], [c])).toEqual({
      ok: false,
      reason: 'catalog_window',
    });
  });

  it('refuses a catalog row with no fdv rather than treating it as zero', () => {
    const c = row();
    expect(resolveCatalogExact(c, [catalog({ fdv: null })], [c])).toEqual({
      ok: false,
      reason: 'catalog_fdv_missing',
    });
    expect(resolveCatalogExact(c, [catalog({ fdv: 0 })], [c])).toEqual({
      ok: false,
      reason: 'catalog_fdv_missing',
    });
  });

  it('refuses an EVM row with no chain instead of guessing which chain to key', () => {
    const c = row({ chain: 'evm', address: '0xabc', evmChain: null });
    const evmCatalog = catalog({ chain: 'evm', address: '0xABC', evmChain: 'base' });
    expect(resolveCatalogExact(c, [evmCatalog], [c])).toEqual({
      ok: false,
      reason: 'evm_chain_missing',
    });
  });

  it('folds EVM address case but keys on the named chain', () => {
    const c = row({ chain: 'evm', address: '0xAbC', evmChain: 'base' });
    const ok = catalog({ chain: 'evm', address: '0xabc', evmChain: 'base' });
    const wrongChain = catalog({ chain: 'evm', address: '0xabc', evmChain: 'bsc', fdv: 99 });
    expect(resolveCatalogExact(c, [wrongChain, ok], [c])).toMatchObject({ ok: true, fdv: 816_000 });
  });
});

// ---------------------------------------------------------------------------
// TIER 2 — siblings
// ---------------------------------------------------------------------------

describe('resolveSibling', () => {
  const sib = (over: Partial<CandidateRow>) => row({ messageId: 'other', ...over });

  it('borrows a lone sibling only inside the 30s cap', () => {
    const c = row();
    const near = sib({ id: 's1', timestamp: at(-20), fdvAtCall: 700_000 });
    expect(resolveSibling(c, [near])).toMatchObject({ ok: true, fdv: 700_000 });
  });

  it('REFUSES a lone sibling past 30s rather than approximating from it', () => {
    const c = row();
    const far = sib({ id: 's1', timestamp: at(-90), fdvAtCall: 700_000 });
    expect(resolveSibling(c, [far])).toEqual({ ok: false, reason: 'sibling_too_far' });
  });

  it('accepts a distant sibling only when a bracket proves the price was flat', () => {
    const c = row();
    const before = sib({ id: 's1', timestamp: at(-200), fdvAtCall: 700_000 });
    const after = sib({ id: 's2', timestamp: at(120), fdvAtCall: 730_000 });
    // Nearer side wins; 4.3% apart is inside the 15% bracket tolerance.
    expect(resolveSibling(c, [before, after])).toMatchObject({ ok: true, fdv: 730_000 });
  });

  it('refuses a bracket whose two sides disagree — that IS the price moving', () => {
    const c = row();
    const before = sib({ id: 's1', timestamp: at(-200), fdvAtCall: 400_000 });
    const after = sib({ id: 's2', timestamp: at(200), fdvAtCall: 900_000 });
    expect(resolveSibling(c, [before, after])).toEqual({ ok: false, reason: 'sibling_disagree' });
  });

  it('never chains off another recovery', () => {
    const c = row();
    const recovered = sib({
      id: 's1',
      timestamp: at(-10),
      fdvAtCall: 700_000,
      provenance: 'birdeye_derived',
    });
    expect(resolveSibling(c, [recovered])).toEqual({ ok: false, reason: 'sibling_recovered' });
  });

  it('reports no sibling when everything measured is outside the search window', () => {
    const c = row();
    const outside = sib({ id: 's1', timestamp: at(-600), fdvAtCall: 700_000 });
    expect(resolveSibling(c, [outside])).toEqual({ ok: false, reason: 'sibling_none' });
  });

  it('ignores the row itself', () => {
    const c = row({ fdvAtCall: null });
    expect(resolveSibling(c, [c])).toEqual({ ok: false, reason: 'sibling_none' });
  });
});

// ---------------------------------------------------------------------------
// TIER 3 — derivation
// ---------------------------------------------------------------------------

describe('deriveImpliedSupply', () => {
  const sample = (ts: string, fdv: number, price: number) => ({
    timestamp: ts,
    fdvAtCall: fdv,
    priceUsd: price,
  });

  it('proves a fixed supply from two readings an hour apart that agree', () => {
    const out = deriveImpliedSupply([
      sample(at(0), 1_000_000, 0.001),
      sample(at(7200), 2_000_000, 0.002),
    ]);
    expect(out?.supply).toBe(1e9);
    expect(out?.samples).toBe(2);
  });

  it('refuses a single reading — one point cannot prove supply is fixed', () => {
    expect(deriveImpliedSupply([sample(at(0), 1_000_000, 0.001)])).toBeNull();
  });

  it('refuses readings too close together in time', () => {
    expect(
      deriveImpliedSupply([sample(at(0), 1_000_000, 0.001), sample(at(600), 1_000_000, 0.001)]),
    ).toBeNull();
  });

  it('refuses when the implied supplies disagree — mint, burn, or FDV/MC ambiguity', () => {
    expect(
      deriveImpliedSupply([
        sample(at(0), 1_000_000, 0.001), // 1e9 supply
        sample(at(7200), 1_000_000, 0.002), // 5e8 supply
      ]),
    ).toBeNull();
  });
});

describe('pickPricePoint', () => {
  const p = (offsetSeconds: number, price: number) => ({
    unixSeconds: Math.floor(Date.parse(at(offsetSeconds)) / 1000),
    priceUsd: price,
  });

  it('takes the nearest point inside 60s', () => {
    expect(pickPricePoint([p(-50, 0.001), p(30, 0.002)], T0)?.priceUsd).toBe(0.002);
  });

  it('refuses rather than interpolating when every point is too far out', () => {
    expect(pickPricePoint([p(-120, 0.001), p(180, 0.002)], T0)).toBeNull();
  });

  it('ignores non-positive prices instead of writing a zero market cap', () => {
    expect(pickPricePoint([p(0, 0)], T0)).toBeNull();
  });
});

describe('deriveFdv and the sanity tripwire', () => {
  it('multiplies price by supply', () => {
    expect(deriveFdv(0.002, 1e9)).toBe(2_000_000);
  });

  it('refuses a non-finite or non-positive product', () => {
    expect(deriveFdv(0, 1e9)).toBeNull();
    expect(deriveFdv(Number.NaN, 1e9)).toBeNull();
  });

  it('trips when the derived value is more than 100x from ANY measured value', () => {
    expect(passesSanityTripwire(2_000_000, [1_800_000, 2_400_000])).toBe(true);
    // A units error (supply in the wrong denomination) looks exactly like this.
    expect(passesSanityTripwire(2_000_000_000, [1_800_000])).toBe(false);
    expect(passesSanityTripwire(1_000, [1_800_000])).toBe(false);
  });

  it('has nothing to compare against when the address has no measured value', () => {
    expect(passesSanityTripwire(2_000_000, [])).toBe(true);
  });
});

describe('toBirdeyeChain', () => {
  it('maps what it can and refuses the rest', () => {
    expect(toBirdeyeChain('sol', null)).toBe('solana');
    expect(toBirdeyeChain('evm', 'BASE')).toBe('base');
    expect(toBirdeyeChain('evm', null)).toBeNull();
    expect(toBirdeyeChain('evm', 'linea')).toBeNull();
  });
});

describe('resolveDerived', () => {
  const base = {
    probePassed: true,
    pricePoints: [
      { unixSeconds: Math.floor(Date.parse(T0) / 1000), priceUsd: 0.002 },
    ],
    supplySamples: [
      { timestamp: at(0), fdvAtCall: 1_000_000, priceUsd: 0.001 },
      { timestamp: at(7200), fdvAtCall: 2_000_000, priceUsd: 0.002 },
    ],
    currentSupply: null,
    allowCurrentSupply: false,
    measuredFdvForAddress: [1_000_000, 2_000_000],
  };

  it('derives price x proven supply', () => {
    const out = resolveDerived(row(), base);
    expect(out).toMatchObject({ ok: true, tier: 'birdeye_derived', fdv: 2_000_000 });
    if (out.ok) expect(out.inputs.supplySource).toBe('implied_measured');
  });

  it('refuses everything when no probe passed in this process', () => {
    expect(resolveDerived(row(), { ...base, probePassed: false })).toEqual({
      ok: false,
      reason: 'probe_not_passed',
    });
  });

  it('refuses a population-A row: there is nothing to prove supply from', () => {
    expect(resolveDerived(row(), { ...base, supplySamples: [] })).toEqual({
      ok: false,
      reason: 'current_supply_disabled',
    });
  });

  it('distinguishes samples that failed the proof from having no samples at all', () => {
    const contradictory = [
      { timestamp: at(0), fdvAtCall: 1_000_000, priceUsd: 0.001 },
      { timestamp: at(7200), fdvAtCall: 1_000_000, priceUsd: 0.002 },
    ];
    expect(resolveDerived(row(), { ...base, supplySamples: contradictory })).toEqual({
      ok: false,
      reason: 'supply_unproven',
    });
  });

  it('refuses when the price fetch failed rather than falling back to anything', () => {
    expect(resolveDerived(row(), { ...base, pricePoints: null })).toEqual({
      ok: false,
      reason: 'birdeye_error',
    });
  });

  it('refuses when no returned point is close enough to the call', () => {
    const stale = [{ unixSeconds: Math.floor(Date.parse(at(600)) / 1000), priceUsd: 0.002 }];
    expect(resolveDerived(row(), { ...base, pricePoints: stale })).toEqual({
      ok: false,
      reason: 'price_point_too_far',
    });
  });

  it('refuses an EVM row with no chain', () => {
    const evm = row({ chain: 'evm', address: '0xabc', evmChain: null });
    expect(resolveDerived(evm, base)).toEqual({ ok: false, reason: 'evm_chain_missing' });
  });

  it('trips the sanity wire instead of writing an off-by-1000x market cap', () => {
    const out = resolveDerived(row(), { ...base, measuredFdvForAddress: [500] });
    expect(out).toEqual({ ok: false, reason: 'sanity_tripwire' });
  });
});

// ---------------------------------------------------------------------------
// Orchestration — an ineligible row is REFUSED, never approximated
// ---------------------------------------------------------------------------

describe('planOfflineTiers', () => {
  it('stops at the screen and attempts no tier at all', () => {
    const a = row({ id: 'a' });
    const b = row({ id: 'b' });
    const plan = planOfflineTiers(a, ctx({ index: buildPopulationIndex([a, b], [catalog()]) }));
    expect(plan.screenRefusal).toBe('duplicate_row_group');
    expect(plan.attempts).toEqual([]);
    expect(plan.result).toBeNull();
    expect(plan.needsPrice).toBe(false);
  });

  it('prefers the exact tier and never consults siblings once it wins', () => {
    const c = row();
    const plan = planOfflineTiers(
      c,
      ctx({
        index: buildPopulationIndex([c], [catalog()]),
        catalogFor: () => [catalog()],
        addressRowsFor: () => [c],
        siblingsFor: () => [row({ id: 's', messageId: 'm2', timestamp: at(-5), fdvAtCall: 1 })],
      }),
    );
    expect(plan.result).toMatchObject({ tier: 'catalog_exact', fdv: 816_000 });
    expect(plan.attempts.map((a) => a.tier)).toEqual(['catalog_exact']);
  });

  it('falls through to a refusal instead of loosening a rule', () => {
    const c = row();
    // Catalog write is hours stale AND the only sibling is well past the cap.
    const far = row({ id: 's', messageId: 'm2', timestamp: at(-240), fdvAtCall: 700_000 });
    const plan = planOfflineTiers(
      c,
      ctx({
        index: buildPopulationIndex([c, far], [catalog()]),
        catalogFor: () => [catalog({ enrichedAt: at(9000) })],
        addressRowsFor: () => [c, far],
        siblingsFor: () => [far],
      }),
    );
    expect(plan.result).toBeNull();
    expect(plan.needsPrice).toBe(false);
    expect(plan.attempts).toEqual([
      { tier: 'catalog_exact', outcome: { ok: false, reason: 'catalog_window' } },
      { tier: 'sibling_measured', outcome: { ok: false, reason: 'sibling_too_far' } },
    ]);
  });

  it('only asks for a price when the derived tier was explicitly enabled', () => {
    const c = row();
    const withoutDerived = planOfflineTiers(c, ctx({ index: buildPopulationIndex([c], [catalog()]) }));
    expect(withoutDerived.needsPrice).toBe(false);

    const withDerived = planOfflineTiers(
      c,
      ctx({
        index: buildPopulationIndex([c], [catalog()]),
        tiers: new Set<RecoveryTier>(['catalog_exact', 'sibling_measured', 'birdeye_derived']),
      }),
    );
    expect(withDerived.needsPrice).toBe(true);
  });

  it('never spends a price fetch on a row the screen already refused', () => {
    const a = row({ id: 'a' });
    const b = row({ id: 'b' });
    const plan = planOfflineTiers(
      a,
      ctx({
        index: buildPopulationIndex([a, b], [catalog()]),
        tiers: new Set<RecoveryTier>(['birdeye_derived']),
      }),
    );
    expect(plan.needsPrice).toBe(false);
  });
});

describe('tallyPlan', () => {
  it('counts every refusal reason, per tier, alongside the writes', () => {
    const tally = emptyTally();
    const c = row();
    const far = row({ id: 's', messageId: 'm2', timestamp: at(-240), fdvAtCall: 700_000 });
    const declined = planOfflineTiers(
      c,
      ctx({
        index: buildPopulationIndex([c, far], [catalog()]),
        catalogFor: () => [catalog({ enrichedAt: at(9000) })],
        addressRowsFor: () => [c, far],
        siblingsFor: () => [far],
      }),
    );
    const dupA = row({ id: 'd1' });
    const dupB = row({ id: 'd2' });
    const screened = planOfflineTiers(
      dupA,
      ctx({ index: buildPopulationIndex([dupA, dupB], [catalog()]) }),
    );

    tallyPlan(tally, declined);
    tallyPlan(tally, screened);

    expect(tally.byTier.get('catalog_exact')?.get('catalog_window')).toBe(1);
    expect(tally.byTier.get('sibling_measured')?.get('sibling_too_far')).toBe(1);
    expect(tally.screen.get('duplicate_row_group')).toBe(1);
    expect(tally.screened).toBe(1);
    expect(tally.unrecovered).toBe(1);
    expect(tally.populations.B).toBe(1);
  });
});

describe('formatRecoveredDisplay', () => {
  it('marks the display string so consumers that ignore provenance still see it', () => {
    expect(formatRecoveredDisplay(816_000)).toBe('~816.0K');
    expect(formatRecoveredDisplay(2_400_000)).toBe('~2.4M');
  });
});
