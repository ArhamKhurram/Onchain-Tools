// Live LP positions — the display half of a deliberately display-grade feed.
//
// Two rules govern everything in this file.
//
//   1. ALLOWLISTED IS NOT MANAGED, and neither one is "unsaved tick".
//      `selection.ts` draws the same line for pool *candidates*: surfacing a pool
//      never admits it. Here the stakes are higher, because the money is already
//      deployed. A position sitting in a pool that is not on the saved allowlist
//      is not compounded and not rebalanced — its fees accrue unclaimed and its
//      range is never moved — and the panel must never let that read as managed.
//      So `positionCoverage` derives its answer from the allowlist arrays first
//      and treats `managedByAutomation` as a *narrowing* signal only. It fails
//      closed: when the server's two flags disagree, the pessimistic reading wins.
//
//   2. These numbers are indicative, not the automation's inputs.
//      They come from Krystal's cached quotes. Range bounds round-trip exactly,
//      but the current price does not — derived ticks came out up to 66 ticks off
//      the pool's own `slot0()` (LP_AUTOMATION_PLAN.md §3). The automation reads
//      the chain directly and never trades on this feed, so nothing here may be
//      presented with more precision than it has.

import { isInAllowlist, normalizeAddress } from './selection';

const DASH = '—';

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// --- API contract mirror ----------------------------------------------------
//
// Restated here rather than imported for the same reason `types.ts` restates the
// policy contract: `lp-automation/` is a separate workspace the console does not
// depend on. Keep in sync with `GET /api/lp/positions`.

export type LpPositionStatus = 'in_range' | 'out_of_range' | 'closed';

export interface LpPositionToken {
  symbol: string;
  address: string;
  decimals: number;
}

export interface LpPositionView {
  tokenId: string;
  poolAddress: string;
  platform: string;
  feeTierBps: number;
  token0: LpPositionToken;
  token1: LpPositionToken;
  status: LpPositionStatus;
  valueUsd: number;
  unclaimedFeesUsd: number;
  minPrice: number;
  maxPrice: number;
  currentPrice: number;
  /** Pool is in the *saved* policy's `allowedPools`. */
  isAllowlisted: boolean;
  /** The server's verdict that the automation acts on this position. */
  managedByAutomation: boolean;
}

/** A position the server received but could not read. Reported, never swallowed. */
export interface LpPositionSkip {
  index: number;
  identifier: string;
  reason: string;
}

/** `GET /api/lp/positions` */
export interface LpPositionsResponse {
  safeAddress: string | null;
  /** False until a Safe address is saved — a setup step, not an error. */
  configured: boolean;
  positions: LpPositionView[];
  skipped: LpPositionSkip[];
  /**
   * True when the server could not read the policy, so every `isAllowlisted`
   * and `managedByAutomation` flag above is UNKNOWN rather than false.
   *
   * Without this the two are indistinguishable, and the panel would tell the
   * operator none of their positions are protected on a transient database
   * error — alarming, and actionable in exactly the wrong direction.
   */
  policyReadFailed: boolean;
  fetchedAt: string;
}

/** `GET /api/lp/settings` */
export interface LpSettings {
  safeAddress: string | null;
  moduleAddress: string | null;
  updatedAt: string | null;
}

export interface LpSettingsPatch {
  safeAddress?: string;
  moduleAddress?: string;
}

// --- Coverage: what the automation actually does with this position ---------

/**
 * Why six states and not a boolean:
 *
 *   `managed`                 — allowlisted, saved, and the server confirms it acts.
 *   `allowlisted_not_managed` — the pool is permitted but this position is not
 *                               being acted on. The pool being fine is exactly
 *                               what makes this one easy to misread as covered.
 *   `pending_allowlist`       — ticked in the draft, not saved. Nothing changes
 *                               until the save lands, so it is not covered yet.
 *   `pending_removal`         — still covered today; saving ends that.
 *   `unmanaged`               — the pool is not on the allowlist. No compounding,
 *                               no rebalancing, ever, until it is.
 *   `closed`                  — withdrawn. Coverage is moot.
 */
export type PositionCoverage =
  | 'managed'
  | 'allowlisted_not_managed'
  | 'pending_allowlist'
  | 'pending_removal'
  | 'unmanaged'
  | 'closed'
  /**
   * The policy could not be read, so coverage is genuinely UNKNOWN — distinct
   * from `unmanaged`, which is a positive claim that nothing is tending this
   * position. Telling someone their money is unprotected when it may be fine
   * is its own kind of wrong answer.
   */
  | 'unknown';

/**
 * Derives coverage from the allowlist first.
 *
 * `managedByAutomation` can only ever *reduce* the answer, never promote one:
 * a `true` on a pool that is not allowlisted is a contradiction, and the honest
 * resolution of a contradiction on this page is the reading that does not
 * promise the operator something the signer cannot deliver.
 */
export function positionCoverage(
  position: Pick<LpPositionView, 'poolAddress' | 'status' | 'isAllowlisted' | 'managedByAutomation'>,
  draftAllowlist: readonly string[],
  /** From `LpPositionsResponse.policyReadFailed`. See `PositionCoverage.unknown`. */
  policyReadFailed = false,
): PositionCoverage {
  if (position.status === 'closed') return 'closed';

  // Checked before every allowlist read below: with no readable policy, every
  // `isAllowlisted` flag is a default, not an observation.
  if (policyReadFailed) return 'unknown';

  const inDraft = isInAllowlist(draftAllowlist, position.poolAddress);

  // Fails closed. Without the pool on the saved allowlist the signer has no
  // authority over this position, whatever `managedByAutomation` claims.
  if (!position.isAllowlisted) return inDraft ? 'pending_allowlist' : 'unmanaged';

  // Saved-allowlisted but unticked in the draft: still in force, about to stop.
  if (!inDraft) return 'pending_removal';

  return position.managedByAutomation ? 'managed' : 'allowlisted_not_managed';
}

/** True only where the automation compounds and rebalances the position *today*. */
export function isCoveredNow(coverage: PositionCoverage): boolean {
  return coverage === 'managed' || coverage === 'pending_removal';
}

/**
 * True where an open position is earning without anything tending it — the case
 * the whole panel exists to make impossible to miss.
 */
export function isUncovered(coverage: PositionCoverage): boolean {
  return (
    coverage === 'unmanaged' ||
    coverage === 'allowlisted_not_managed' ||
    coverage === 'pending_allowlist'
  );
}

/** Coverage a one-click allowlist add can fix. Only the pool address is missing. */
export function canAdmitPool(coverage: PositionCoverage): boolean {
  return coverage === 'unmanaged';
}

/** Adds without toggling — a click on "add to allowlist" must never remove. */
export function addToAllowlist(allowlist: readonly string[], address: string): string[] {
  const needle = normalizeAddress(address);
  if (!needle) return [...allowlist];
  if (isInAllowlist(allowlist, needle)) return [...allowlist];
  return [...allowlist, needle];
}

// --- Range geometry ---------------------------------------------------------

export type RangePlacement = 'below' | 'inside' | 'above' | 'unknown';

export interface RangeGeometry {
  placement: RangePlacement;
  /** Current price as a 0–1 position across [min,max], clamped. Null when unknowable. */
  fraction: number | null;
  /**
   * How far past the nearest bound price sits, as a percentage of that bound.
   * Null while inside the range. Reported, not compared to the rebalance
   * threshold — that trigger runs on the automation's own tick reads, not these.
   */
  driftPercent: number | null;
}

const UNKNOWN_RANGE: RangeGeometry = { placement: 'unknown', fraction: null, driftPercent: null };

export function rangeGeometry(
  minPrice: unknown,
  maxPrice: unknown,
  currentPrice: unknown,
): RangeGeometry {
  const min = finite(minPrice);
  const max = finite(maxPrice);
  const current = finite(currentPrice);
  if (min === null || max === null || current === null) return UNKNOWN_RANGE;
  // A degenerate range has no interior to place a price in. Rendering a bar for
  // it would invent a position the data does not contain.
  if (!(max > min)) return UNKNOWN_RANGE;

  if (current < min) {
    return {
      placement: 'below',
      fraction: 0,
      driftPercent: min > 0 ? ((min - current) / min) * 100 : null,
    };
  }
  if (current > max) {
    return {
      placement: 'above',
      fraction: 1,
      driftPercent: max > 0 ? ((current - max) / max) * 100 : null,
    };
  }
  return { placement: 'inside', fraction: (current - min) / (max - min), driftPercent: null };
}

/** One sentence about where price sits. Never claims more than the geometry has. */
export function describeRange(geometry: RangeGeometry, status: LpPositionStatus): string {
  if (status === 'closed') return 'Position withdrawn — the range no longer applies.';
  if (geometry.placement === 'unknown') {
    return 'Price range unavailable for this position.';
  }
  if (geometry.placement === 'inside') {
    return 'Price is inside the range — the position is earning fees.';
  }
  const side = geometry.placement === 'above' ? 'above the upper bound' : 'below the lower bound';
  const drift = geometry.driftPercent;
  const by = drift === null ? '' : ` by ${formatDrift(drift)}`;
  return `Price is ${side}${by} — the position is fully in one token and earning nothing.`;
}

function formatDrift(percent: number): string {
  const abs = Math.abs(percent);
  if (abs >= 100) return `${abs.toFixed(0)}%`;
  if (abs >= 1) return `${abs.toFixed(1)}%`;
  return `${abs.toFixed(2)}%`;
}

export function formatDriftPercent(value: unknown): string {
  const n = finite(value);
  if (n === null) return DASH;
  return formatDrift(n);
}

// --- Status -----------------------------------------------------------------

export type StatusTone = 'earning' | 'idle' | 'closed';

export interface StatusPresentation {
  label: string;
  /** The consequence, not the state name. */
  consequence: string;
  tone: StatusTone;
}

const STATUS_PRESENTATION: Record<LpPositionStatus, StatusPresentation> = {
  in_range: { label: 'In range', consequence: 'Earning fees', tone: 'earning' },
  out_of_range: { label: 'Out of range', consequence: 'Earning nothing', tone: 'idle' },
  closed: { label: 'Closed', consequence: 'Withdrawn', tone: 'closed' },
};

/** Total over the union type — an unrecognized status must not render blank. */
export function presentStatus(status: LpPositionStatus): StatusPresentation {
  return STATUS_PRESENTATION[status] ?? { label: 'Unknown', consequence: 'Unknown', tone: 'closed' };
}

// --- Summary ----------------------------------------------------------------

export interface PositionsSummary {
  total: number;
  open: number;
  closed: number;
  /** Open positions only — a closed position holds nothing. */
  valueUsd: number;
  unclaimedFeesUsd: number;
  managed: number;
  managedValueUsd: number;
  /** Open, and the automation will not act on it today. */
  uncovered: number;
  uncoveredValueUsd: number;
  /** Uncovered only because a tick has not been saved yet. */
  pending: number;
  outOfRange: number;
  outOfRangeValueUsd: number;
  /** Distinct pools behind `unmanaged` positions — what one-click adds would fix. */
  admittablePools: string[];
}

export function summarizePositions(
  positions: readonly LpPositionView[],
  draftAllowlist: readonly string[],
  policyReadFailed = false,
): PositionsSummary {
  const summary: PositionsSummary = {
    total: positions.length,
    open: 0,
    closed: 0,
    valueUsd: 0,
    unclaimedFeesUsd: 0,
    managed: 0,
    managedValueUsd: 0,
    uncovered: 0,
    uncoveredValueUsd: 0,
    pending: 0,
    outOfRange: 0,
    outOfRangeValueUsd: 0,
    admittablePools: [],
  };

  const admittable = new Set<string>();

  for (const position of positions) {
    const coverage = positionCoverage(position, draftAllowlist, policyReadFailed);
    if (coverage === 'closed') {
      summary.closed += 1;
      continue;
    }

    const value = finite(position.valueUsd) ?? 0;
    const fees = finite(position.unclaimedFeesUsd) ?? 0;
    summary.open += 1;
    summary.valueUsd += value;
    summary.unclaimedFeesUsd += fees;

    if (isCoveredNow(coverage)) {
      summary.managed += 1;
      summary.managedValueUsd += value;
    }
    if (isUncovered(coverage)) {
      summary.uncovered += 1;
      summary.uncoveredValueUsd += value;
    }
    if (coverage === 'pending_allowlist') summary.pending += 1;
    if (canAdmitPool(coverage)) {
      const address = normalizeAddress(position.poolAddress);
      if (address) admittable.add(address);
    }
    if (position.status === 'out_of_range') {
      summary.outOfRange += 1;
      summary.outOfRangeValueUsd += value;
    }
  }

  summary.admittablePools = Array.from(admittable);
  return summary;
}

// --- Ordering ---------------------------------------------------------------

/**
 * Lowest rank first. Deliberately not "biggest position first": the panel is
 * read to find the gap, and a $40 position nothing is tending is a more useful
 * thing to see at the top than a $4,000 one the automation already handles.
 */
const COVERAGE_RANK: Record<PositionCoverage, number> = {
  unmanaged: 0,
  // Ranked directly after a confirmed gap: "we cannot tell whether this is
  // covered" warrants attention nearly as much as knowing it isn't, and both
  // outrank anything already handled.
  unknown: 1,
  allowlisted_not_managed: 2,
  pending_allowlist: 3,
  pending_removal: 4,
  managed: 5,
  closed: 6,
};

export function coverageRank(coverage: PositionCoverage): number {
  return COVERAGE_RANK[coverage] ?? COVERAGE_RANK.closed;
}

/** Non-mutating. Ties break on tokenId so the order is stable across renders. */
export function sortPositions(
  positions: readonly LpPositionView[],
  draftAllowlist: readonly string[],
  policyReadFailed = false,
): LpPositionView[] {
  return [...positions].sort((a, b) => {
    const rank =
      coverageRank(positionCoverage(a, draftAllowlist, policyReadFailed)) -
      coverageRank(positionCoverage(b, draftAllowlist, policyReadFailed));
    if (rank !== 0) return rank;

    // Within a coverage band, out-of-range money is the part that is idle.
    const idle = Number(b.status === 'out_of_range') - Number(a.status === 'out_of_range');
    if (idle !== 0) return idle;

    const value = (finite(b.valueUsd) ?? 0) - (finite(a.valueUsd) ?? 0);
    if (value !== 0) return value;

    return String(a.tokenId).localeCompare(String(b.tokenId));
  });
}

// --- Formatting -------------------------------------------------------------

function trimZeros(text: string): string {
  if (!text.includes('.')) return text;
  return text.replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Pool prices span many orders of magnitude, so a fixed decimal count either
 * renders a stablecoin pair as `1.0000` noise or a long-tail pair as `0.00`.
 */
export function formatPrice(value: unknown): string {
  const n = finite(value);
  if (n === null) return DASH;
  const abs = Math.abs(n);
  if (abs === 0) return '0';
  if (abs >= 1000) {
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (abs >= 1) return trimZeros(n.toFixed(4));
  // Long-tail pairs are routine on a young chain. Below a millionth, counting
  // leading zeros is harder to read than an exponent, so the notation switches.
  if (abs >= 1e-6) return trimZeros(n.toFixed(12));
  return n.toExponential(2);
}

export function positionPairLabel(
  position: Pick<LpPositionView, 'token0' | 'token1'>,
): string {
  const a = position.token0?.symbol?.trim() || '???';
  const b = position.token1?.symbol?.trim() || '???';
  return `${a} / ${b}`;
}

/** `#12345` — Krystal's NFT token id, the handle for a position on an explorer. */
export function formatTokenId(tokenId: unknown): string {
  const text = typeof tokenId === 'string' ? tokenId.trim() : '';
  if (!text) return DASH;
  return text.startsWith('#') ? text : `#${text}`;
}

// --- Safe address -----------------------------------------------------------

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/**
 * Client-side shape check only. It exists to catch a typo before a round trip;
 * the server's 400 is what decides, exactly as with the policy validator.
 * Returns a message, or null when the value is worth sending.
 */
export function validateSafeAddress(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return 'Enter the Safe address that holds your LP positions.';
  if (!ADDRESS_PATTERN.test(trimmed)) return 'Must be a 0x-prefixed 20-byte hex address.';
  return null;
}

export function normalizeSafeAddress(raw: string): string {
  return raw.trim();
}

/** True when the saved value and the input differ — drives the unsaved marker. */
export function safeAddressDirty(input: string, saved: string | null): boolean {
  return normalizeAddress(input) !== normalizeAddress(saved ?? '');
}
