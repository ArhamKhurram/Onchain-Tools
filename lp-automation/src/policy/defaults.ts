// The conservative starting policy (plan §5, §11 point 1).
//
// This system signs live from day one — there is no simulation-only staging
// phase (plan, "Decisions locked"). Every number below is therefore chosen to be
// *too small* rather than merely reasonable: raising a cap through the dashboard
// takes seconds, walking back a realized loss takes forever. Treat these as the
// floor a human deliberately steps up from, not as tuned values.
//
// The plan's §5 code block carries illustrative numbers ("e.g. 2.0", "e.g. 6").
// Where a default here disagrees with one of those, it disagrees in the safer
// direction on purpose and says why.

import type { AutomationPolicy } from '../types.js';

export const DEFAULT_POLICY: AutomationPolicy = {
  // Version 1 is the genesis policy. Versions are never mutated in place —
  // editing produces a new version (see `versioning.ts`) so an open position can
  // always be resolved back to the exact rules it was opened under.
  version: 1,

  // Phase 1 is single-chain by decision (plan §1, §10). The validator rejects
  // anything else rather than silently ignoring it.
  chain: 'robinhood',

  // $250. Small enough that a total loss of one position is a tuition payment,
  // not an event. Robinhood Chain is ~4 weeks old with thin liquidity (plan §1),
  // so position size is also the main lever on our own slippage.
  maxPositionSizeUsd: 250,

  // EMPTY ON PURPOSE — this is the single most important default in the file.
  // An empty allowlist means the system can do nothing at all until a human
  // ticks a specific pool in the dashboard (plan §9.2). The failure mode of a
  // bug in pool discovery is then "does nothing", never "entered a pool nobody
  // approved". `isPoolAllowed` consults this list and only this list.
  allowedPools: [],

  poolSelectionCriteria: {
    // These three only SURFACE candidates for a human to consider. They never
    // admit a pool — see the long comment in `pools.ts`.

    // $250k TVL. On a chain this young, sparse results are a real signal about
    // the chain, not a bug in the filter (plan §3). Better to see three pools
    // than thirty.
    minTvlUsd: 250_000,

    // $50k/24h. Fees are paid out of volume; a pool with TVL but no volume pays
    // nothing while still carrying full impermanent-loss exposure.
    min24hVolumeUsd: 50_000,

    // 0–100, higher = riskier. 40 keeps us in the calmer half while the scoring
    // model itself is still TBD (`types.ts`). Note that an *unknown* score is
    // treated as a failure, not a pass — see `poolMeetsCriteria`.
    maxIlRiskScore: 40,
  },

  compoundTrigger: {
    // 3.0, not the plan's illustrative 2.0. At 2x, a gas-price spike between the
    // decision and the broadcast can turn a marginal compound into a net loss.
    // 3x leaves headroom for that spike. The validator's hard floor is 1.0
    // (compounding for less than gas cost is never correct).
    minFeesVsGasRatio: 3.0,

    // 24h, not the plan's illustrative 6h. The interval exists as a liveness
    // backstop so fees do not sit unclaimed forever — not as a schedule. Every
    // interval-driven compound that the ratio would not have justified is gas
    // spent to no benefit, so the backstop should be rare.
    maxIntervalHours: 24,
  },

  rebalanceTrigger: {
    // 5% outside the range before we move. Tighter than this and ordinary
    // volatility rebalances us repeatedly, paying gas each time to chase price.
    rangeExitPercent: 5,
  },

  switchingBuffer: {
    // 5 percentage points of annualized net efficiency. The candidate has to be
    // meaningfully better, not noise-better — the round trip out of one pool and
    // into another costs real gas and slippage on both legs.
    minEfficiencyDeltaPercent: 5,

    // 60 minutes of *continuously observed* advantage. This is the half of the
    // buffer that kills the transient one-tick crossover the acceptance criteria
    // call out (plan §6). An hour is long enough that a single block's worth of
    // APR noise cannot survive it.
    sustainedDurationMinutes: 60,
  },

  // $500/day — one full-size entry plus one rebalance round trip, and no more.
  // NOTE: this value alone enforces nothing. The binding limit is the same cap
  // written into the Guard contract's storage on-chain (plan §4). This field
  // exists so the off-chain side refuses first, cheaply, instead of learning
  // about the limit from a reverted transaction.
  dailySpendCapUsd: 500,
};
