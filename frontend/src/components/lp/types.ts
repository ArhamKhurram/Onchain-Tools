// Frontend mirror of the LP automation type contract.
//
// `lp-automation/` is a separate workspace that the console does not depend on
// (the signer process is deliberately isolated — see LP_AUTOMATION_PLAN.md §2),
// so the shapes it exposes over HTTP are restated here rather than imported.
// Keep this file in sync with `lp-automation/src/types.ts`; it is the same
// contract, viewed from the other side of `/api/lp`.

export type LpChainSlug = 'robinhood';

/** Robinhood Chain. Phase 1 is single-chain by decision (plan §1, §10). */
export const ROBINHOOD_CHAIN_ID = 4663;

export const LP_CHAIN_IDS: Record<LpChainSlug, number> = {
  robinhood: ROBINHOOD_CHAIN_ID,
};

export const LP_CHAIN_LABELS: Record<LpChainSlug, string> = {
  robinhood: 'Robinhood Chain',
};

export interface LpTokenRef {
  address: string;
  symbol: string;
  decimals: number;
}

export interface PoolSelectionCriteria {
  minTvlUsd: number;
  min24hVolumeUsd: number;
  /** 0–100, higher = riskier. */
  maxIlRiskScore: number;
}

export interface CompoundTrigger {
  minFeesVsGasRatio: number;
  maxIntervalHours: number;
}

/**
 * Where to place the new range on rebalance — mirrors Krystal's narrow/wide/full
 * choice. Narrow is the tightest band: it earns the most fees per dollar and, for
 * that reason, leaves range and rebalances most often. Full is a v2-style
 * whole-range position that never rebalances but earns the least. Default narrow.
 */
export type RangeStrategy = 'narrow' | 'wide' | 'full';

export interface RebalanceTrigger {
  rangeExitPercent: number;
  /**
   * Picked once in the policy; every automatic and manual rebalance uses it,
   * with no per-action dialog.
   */
  rangeStrategy: RangeStrategy;
}

export interface SwitchingBuffer {
  minEfficiencyDeltaPercent: number;
  sustainedDurationMinutes: number;
}

export interface AutomationPolicy {
  version: number;
  chain: LpChainSlug;
  maxPositionSizeUsd: number;
  /** Explicit pool addresses, manually ticked in this dashboard (plan §9.2). */
  allowedPools: string[];
  /** SURFACES candidates for manual selection — never admits one. */
  poolSelectionCriteria: PoolSelectionCriteria;
  compoundTrigger: CompoundTrigger;
  rebalanceTrigger: RebalanceTrigger;
  switchingBuffer: SwitchingBuffer;
  /** Mirrored on-chain in the Module — this value alone enforces nothing. */
  dailySpendCapUsd: number;
}

/** What `PUT /api/lp/policy` accepts: the server assigns the version. */
export type AutomationPolicyPayload = Omit<AutomationPolicy, 'version'>;

export interface PoolCandidate {
  address: string;
  chainId: number;
  platform: string;
  feeTierBps: number;
  token0: LpTokenRef;
  token1: LpTokenRef;
  tvlUsd: number;
  volume24hUsd: number;
  /** Fee APR as a fraction, not a percentage: 0.42 means 42%. */
  feeApr: number;
}

// --- API envelopes ---------------------------------------------------------

/** `GET /api/lp/policy` */
export interface LpPolicyResponse {
  policy: AutomationPolicy | null;
  versions: number[];
}

/** `GET /api/lp/status` */
export interface LpStatusResponse {
  hasPolicy: boolean;
  activeVersion: number | null;
  allowlistSize: number;
}

/** One field-scoped validation failure — from the client or from a 400. */
export interface PolicyFieldIssue {
  /** Dotted path, e.g. `compoundTrigger.minFeesVsGasRatio`. */
  field: string;
  message: string;
}
