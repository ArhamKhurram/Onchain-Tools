/**
 * Tier orchestration for the MC@CALL recovery — still pure, still no I/O.
 *
 * Split from `rules.ts` so the ORDER in which tiers are tried, and the fact that
 * a row falls through to a refusal rather than to a looser rule, is testable on
 * its own. The runner supplies the data each tier needs through the lookup
 * callbacks; it never decides anything.
 */

import {
  deriveFdv,
  deriveImpliedSupply,
  passesSanityTripwire,
  pickPricePoint,
  resolveCatalogExact,
  resolveSibling,
  screenRow,
  toBirdeyeChain,
  type CandidateRow,
  type CatalogRow,
  type Population,
  type PopulationIndex,
  type PricePoint,
  type RecoveryTier,
  type RefusalReason,
  type SupplySample,
  type TierOutcome,
} from './rules.js';

/** Tried in this order. Free and exact first; the tier that spends money last. */
export const TIER_ORDER: readonly RecoveryTier[] = [
  'catalog_exact',
  'sibling_measured',
  'birdeye_derived',
];

export interface PlanContext {
  index: PopulationIndex;
  population: Population;
  tiers: ReadonlySet<RecoveryTier>;
  /** Every token_catalog row for this address, any chain key. */
  catalogFor: (row: CandidateRow) => CatalogRow[];
  /** Every contracts row for this address, ANY user (the catalog is global). */
  addressRowsFor: (row: CandidateRow) => CandidateRow[];
  /** Contracts rows for this address belonging to the SAME user. */
  siblingsFor: (row: CandidateRow) => CandidateRow[];
}

export interface RowPlan {
  row: CandidateRow;
  population: 'A' | 'B' | null;
  /** Set when the row never became a candidate; no tier was attempted. */
  screenRefusal: RefusalReason | null;
  /** One entry per tier actually attempted, in TIER_ORDER. */
  attempts: { tier: RecoveryTier; outcome: TierOutcome }[];
  /** The winning outcome, or null if every attempted tier declined. */
  result: Extract<TierOutcome, { ok: true }> | null;
  /**
   * Tiers 1-2 declined, `birdeye_derived` is enabled, and the row is otherwise a
   * candidate. The runner must fetch a price before this row can be decided —
   * this is the ONLY signal that authorises spending an API call on it.
   */
  needsPrice: boolean;
}

/**
 * Run the offline tiers. Never touches the network, so a full dry run over the
 * whole table costs nothing but the two index reads.
 */
export function planOfflineTiers(row: CandidateRow, ctx: PlanContext): RowPlan {
  const screen = screenRow(row, ctx.index, ctx.population);
  if (!screen.eligible) {
    return {
      row,
      population: null,
      screenRefusal: screen.reason,
      attempts: [],
      result: null,
      needsPrice: false,
    };
  }

  const plan: RowPlan = {
    row,
    population: screen.population,
    screenRefusal: null,
    attempts: [],
    result: null,
    needsPrice: false,
  };

  if (ctx.tiers.has('catalog_exact')) {
    const outcome = resolveCatalogExact(row, ctx.catalogFor(row), ctx.addressRowsFor(row));
    plan.attempts.push({ tier: 'catalog_exact', outcome });
    if (outcome.ok) {
      plan.result = outcome;
      return plan;
    }
  }

  if (ctx.tiers.has('sibling_measured')) {
    const outcome = resolveSibling(row, ctx.siblingsFor(row));
    plan.attempts.push({ tier: 'sibling_measured', outcome });
    if (outcome.ok) {
      plan.result = outcome;
      return plan;
    }
  }

  plan.needsPrice = ctx.tiers.has('birdeye_derived');
  return plan;
}

export interface DerivedContext {
  /** Verified in THIS process. Never cached, never remembered from a prior run. */
  probePassed: boolean;
  /** null means the price fetch failed or was never issued. */
  pricePoints: PricePoint[] | null;
  /** Measured (fdv, price) pairs for this address, used to PROVE supply is fixed. */
  supplySamples: SupplySample[];
  /** Birdeye's supply today. Only consulted under `allowCurrentSupply`. */
  currentSupply: number | null;
  allowCurrentSupply: boolean;
  /** Every measured fdv_at_call this address holds, at any timestamp. */
  measuredFdvForAddress: number[];
}

/**
 * TIER 3. Split out because it is the only tier that needs a network result, so
 * the runner fetches first and this decides after — keeping the decision itself
 * as testable as the other two.
 */
export function resolveDerived(row: CandidateRow, ctx: DerivedContext): TierOutcome {
  // Hard gate. The historical-price endpoint is not verifiable from this repo,
  // so an unprobed TIER 3 write is a guess with a decimal point on it.
  if (!ctx.probePassed) return { ok: false, reason: 'probe_not_passed' };

  if (row.chain === 'evm' && !row.evmChain) return { ok: false, reason: 'evm_chain_missing' };
  const chain = toBirdeyeChain(row.chain, row.evmChain);
  if (!chain) return { ok: false, reason: 'chain_unmappable' };

  const implied = deriveImpliedSupply(ctx.supplySamples);
  let supply: number;
  let supplySource: 'implied_measured' | 'birdeye_current';
  let supplyInputs: Record<string, unknown>;

  if (implied) {
    supply = implied.supply;
    supplySource = 'implied_measured';
    supplyInputs = {
      supplySamples: implied.samples,
      supplySpread: implied.spread,
      supplySpanSeconds: implied.spanMs / 1000,
    };
  } else if (!ctx.allowCurrentSupply) {
    // Two different failures, and the operator needs to tell them apart: nothing
    // to prove supply FROM (the Population A shape, reachable only with
    // --allow-current-supply) versus samples that existed and failed the proof.
    return {
      ok: false,
      reason: ctx.supplySamples.length === 0 ? 'current_supply_disabled' : 'supply_unproven',
    };
  } else if (ctx.currentSupply != null && ctx.currentSupply > 0) {
    supply = ctx.currentSupply;
    supplySource = 'birdeye_current';
    supplyInputs = { supplySamples: 0 };
  } else {
    return { ok: false, reason: 'supply_unproven' };
  }

  if (ctx.pricePoints === null) return { ok: false, reason: 'birdeye_error' };

  const point = pickPricePoint(ctx.pricePoints, row.timestamp);
  if (!point) return { ok: false, reason: 'price_point_too_far' };

  const fdv = deriveFdv(point.priceUsd, supply);
  // Both inputs were already checked positive and finite, so a null here means
  // the provider handed back something this code cannot reason about.
  if (fdv == null) return { ok: false, reason: 'birdeye_error' };

  if (!passesSanityTripwire(fdv, ctx.measuredFdvForAddress)) {
    return { ok: false, reason: 'sanity_tripwire' };
  }

  return {
    ok: true,
    tier: 'birdeye_derived',
    fdv,
    inputs: {
      ...supplyInputs,
      birdeyeChain: chain,
      supply,
      supplySource,
      priceUsd: point.priceUsd,
      priceAt: new Date(point.unixSeconds * 1000).toISOString(),
      priceSkewSeconds: Math.abs(point.unixSeconds * 1000 - Date.parse(row.timestamp)) / 1000,
    },
  };
}

/**
 * Fold a TIER 3 outcome back into the plan. Clearing `needsPrice` is what makes
 * the row countable: `tallyPlan` treats a still-pending row as undecided rather
 * than as unrecovered, so the derived pass must run before the tally.
 */
export function applyDerived(plan: RowPlan, outcome: TierOutcome): void {
  plan.attempts.push({ tier: 'birdeye_derived', outcome });
  plan.needsPrice = false;
  if (outcome.ok) plan.result = outcome;
}

/**
 * Refusal accounting.
 *
 * Counted PER TIER rather than one reason per row: "sibling_none 9,000" and
 * "catalog_window 9,000" on the same 9,000 rows is the true picture, and
 * collapsing it to a single reason per row would hide whichever guard the
 * operator most needs to see.
 */
export interface RefusalTally {
  screen: Map<RefusalReason, number>;
  byTier: Map<RecoveryTier, Map<RefusalReason, number>>;
  writes: Map<RecoveryTier, number>;
  /** Candidates that passed the screen and were declined by every tier. */
  unrecovered: number;
  /** Rows that never became candidates. */
  screened: number;
  populations: { A: number; B: number };
}

export function emptyTally(): RefusalTally {
  return {
    screen: new Map(),
    byTier: new Map(),
    writes: new Map(),
    unrecovered: 0,
    screened: 0,
    populations: { A: 0, B: 0 },
  };
}

function bump<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

export function tallyPlan(tally: RefusalTally, plan: RowPlan): void {
  if (plan.screenRefusal) {
    bump(tally.screen, plan.screenRefusal);
    tally.screened++;
    return;
  }
  if (plan.population) tally.populations[plan.population]++;

  for (const attempt of plan.attempts) {
    if (attempt.outcome.ok) continue;
    let perTier = tally.byTier.get(attempt.tier);
    if (!perTier) {
      perTier = new Map();
      tally.byTier.set(attempt.tier, perTier);
    }
    bump(perTier, attempt.outcome.reason);
  }

  if (plan.result) bump(tally.writes, plan.result.tier);
  else if (!plan.needsPrice) tally.unrecovered++;
}
