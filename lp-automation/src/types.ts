// Shared type contract for the LP automation workspace.
//
// This file is the seam between the modules that are built independently:
// `ingest/` (Krystal + RPC) produces PoolCandidate/LpPosition, `rules/` consumes
// them and produces a Decision, `lifecycle/` turns a Decision into calldata, and
// `audit/` records what happened. Keep it free of imports so nothing here can
// pull a runtime dependency into a pure module.
//
// See LP_AUTOMATION_PLAN.md §5 (policy) and §6 (rule evaluator).

// --- Chain -----------------------------------------------------------------

/** Phase 1 targets a single chain; §10 Phase 3 widens this to a union. */
export type ChainSlug = 'robinhood';

/** Robinhood Chain. Verified present in Krystal's live routing table (plan §1). */
export const ROBINHOOD_CHAIN_ID = 4663;

export const CHAIN_IDS: Record<ChainSlug, number> = {
  robinhood: ROBINHOOD_CHAIN_ID,
};

// --- Primitives ------------------------------------------------------------

/** Lowercase 0x-prefixed address. Normalize on ingest, never mid-pipeline. */
export type Address = `0x${string}`;

export interface TokenRef {
  address: Address;
  symbol: string;
  decimals: number;
}

// --- Policy (plan §5) ------------------------------------------------------

export interface PoolSelectionCriteria {
  minTvlUsd: number;
  min24hVolumeUsd: number;
  /** 0–100, higher = riskier. Scoring model is deliberately conservative TBD. */
  maxIlRiskScore: number;
}

export interface CompoundTrigger {
  /** When false, autonomous compound is skipped; manual commands still work. */
  enabled: boolean;
  /** e.g. 2.0 — compound once claimable fees exceed 2x the gas cost. */
  minFeesVsGasRatio: number;
  /** e.g. 6 — compound at least this often regardless; whichever fires first. */
  maxIntervalHours: number;
}

/**
 * Where to place the new range when rebalancing — mirrors Krystal's
 * narrow/wide/full choice. Narrow is the tightest band: it earns the most fees
 * per dollar of liquidity and, for exactly that reason, leaves range most often
 * and rebalances most. Full is a v2-style whole-range position that never needs
 * rebalancing but earns the least. Default is narrow.
 */
export type RangeStrategy = 'narrow' | 'wide' | 'full';

/**
 * Half-width of the rebalanced range, as a fraction of the current price, per
 * strategy. Shared so the worker (which converts these to ticks) and any UI
 * describing them agree. `full` is a sentinel — the worker snaps it to the
 * pool's usable tick bounds rather than a percentage band.
 */
export const RANGE_STRATEGY_HALF_WIDTH: Record<Exclude<RangeStrategy, 'full'>, number> = {
  narrow: 0.05, // +/-5%
  wide: 0.2, // +/-20%
};

export interface RebalanceTrigger {
  /** When false, autonomous rebalance is skipped; manual commands still work. */
  enabled: boolean;
  /** Rebalance once price has left the position's range by this percentage. */
  rangeExitPercent: number;
  /**
   * Where to put the new range on rebalance. Replaces the old "preserve the
   * existing width" behaviour — the operator picks a strategy once and every
   * automatic and manual rebalance uses it, no per-action dialog.
   */
  rangeStrategy: RangeStrategy;
}

/**
 * Both conditions must hold before an exit-and-move. A momentary one-tick
 * advantage must NOT trigger a move — that is an explicit acceptance criterion.
 */
export interface SwitchingBuffer {
  minEfficiencyDeltaPercent: number;
  sustainedDurationMinutes: number;
}

export interface AutomationPolicy {
  version: number;
  chain: ChainSlug;
  maxPositionSizeUsd: number;
  /** Explicit pool addresses, manually chosen in the dashboard (plan §9.2). */
  allowedPools: Address[];
  /** Used to SURFACE candidates for manual selection — never to auto-admit. */
  poolSelectionCriteria: PoolSelectionCriteria;
  compoundTrigger: CompoundTrigger;
  rebalanceTrigger: RebalanceTrigger;
  switchingBuffer: SwitchingBuffer;
  /** Mirrored on-chain in the Guard — this value alone enforces nothing. */
  dailySpendCapUsd: number;
}

// --- Pools & positions -----------------------------------------------------

export interface PoolCandidate {
  address: Address;
  chainId: number;
  /** Krystal's DEX identifier (e.g. the Uniswap V3 platform string). */
  platform: string;
  feeTierBps: number;
  token0: TokenRef;
  token1: TokenRef;
  tvlUsd: number;
  volume24hUsd: number;
  /** Fee APR as a fraction, not a percentage: 0.42 means 42%. */
  feeApr: number;
}

export type PositionStatus = 'in_range' | 'out_of_range' | 'closed';

export interface LpPosition {
  /** Uniswap V3 NonfungiblePositionManager token id. */
  tokenId: string;
  pool: PoolCandidate;
  status: PositionStatus;
  /** Tick bounds of the position's range. */
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  valueUsd: number;
  unclaimedFeesUsd: number;
  openedAt: number;
  lastCompoundedAt: number | null;
}

// --- Rule evaluation (plan §6) ---------------------------------------------

/**
 * Inputs to
 *   net_efficiency = fee_apr − estimated_IL − (gas + slippage) / holding_period
 * All APR-shaped values are annualized fractions so the terms are commensurable.
 */
export interface EfficiencyInputs {
  feeApr: number;
  estimatedIlApr: number;
  gasCostUsd: number;
  slippageCostUsd: number;
  positionValueUsd: number;
  expectedHoldingPeriodDays: number;
}

export interface EfficiencyScore {
  /** Annualized fraction. Can be negative. */
  netEfficiency: number;
  inputs: EfficiencyInputs;
  /** Cost drag, annualized fraction — broken out so the log explains the score. */
  costDrag: number;
}

export type ActionKind =
  | 'enter'
  | 'increase'
  | 'decrease'
  | 'approve'
  | 'compound'
  | 'rebalance'
  | 'exit'
  | 'none';

export interface Decision {
  action: ActionKind;
  /** Machine-readable rule id, e.g. 'compound.fees_vs_gas'. */
  rule: string;
  /** Human-readable explanation, recorded verbatim in the audit log. */
  reason: string;
  /** Full input snapshot at evaluation time — logged every tick, not just on trigger. */
  snapshot: Record<string, unknown>;
}

// --- Audit (plan §10 step 6) ----------------------------------------------

export interface AuditEntry {
  timestamp: number;
  action: ActionKind;
  rule: string;
  reason: string;
  snapshot: Record<string, unknown>;
  txHash: string | null;
  /** Populated when a dry-run or broadcast failed; null on success. */
  error: string | null;
}
