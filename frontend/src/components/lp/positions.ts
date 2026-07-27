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
export interface LpLineageLink {
  oldTokenId: string;
  newTokenId: string;
  poolAddress: string;
  withdrawnValueUsd: number | null;
  remintedValueUsd: number | null;
  timestamp: number;
}

/** Lifetime PnL for one position row — derived from the worker audit log. */
export interface LpLineagePnl {
  /** `positionKey` (`{pool}:{tokenId}`) — matches grid row `entry.key`. */
  lineageKey: string;
  headTokenId: string;
  memberTokenIds: string[];
  costBasisUsd: number | null;
  costBasisKnown: boolean;
  /** When cost basis is approximate: "since YYYY-MM-DD". */
  costBasisSince: string | null;
  currentValueUsd: number;
  unclaimedFeesUsd: number;
  lifetimeFeesUsd: number;
  gasPaidUsd: number;
  netPnlUsd: number | null;
  netPnlPercent: number | null;
}

/** What to show for PnL on a row — audit-backed net return or combined equity fallback. */
export interface DisplayPnl {
  label: string;
  valueUsd: number;
  percent: number | null;
  hint: string | null;
  source: 'audit' | 'indicative';
}

/** One line in the position-detail PnL breakdown. */
export interface PnlBreakdownLine {
  label: string;
  valueUsd: number | null;
}

/** Audit-backed component lines plus net return for the detail drawer. */
export interface PnlBreakdown {
  source: 'audit' | 'indicative';
  hint: string | null;
  lines: PnlBreakdownLine[];
  netReturn: { valueUsd: number; percent: number | null } | null;
}

export function costBasisLabel(
  pnl: Pick<LpLineagePnl, 'costBasisKnown' | 'costBasisSince'>,
): string {
  return pnl.costBasisKnown ? 'Cost basis' : `Basis since ${pnl.costBasisSince ?? '?'}`;
}

/**
 * Combined return the operator cares about: fees folded into the headline number.
 *
 * Audit path: netPnlUsd already equals value + unclaimed − basis − gas.
 * Fallback: total equity = value + unclaimed (Krystal splits these apart).
 */
export function resolveDisplayPnl(
  pnl: LpLineagePnl | null | undefined,
  position: Pick<LpPositionView, 'valueUsd' | 'unclaimedFeesUsd'>,
  auditLogAvailable: boolean,
): DisplayPnl {
  const value = finite(position.valueUsd) ?? 0;
  const fees = finite(position.unclaimedFeesUsd) ?? 0;

  if (pnl?.netPnlUsd !== null && pnl?.netPnlUsd !== undefined) {
    return {
      label: 'Net return',
      valueUsd: pnl.netPnlUsd,
      percent: pnl.netPnlPercent,
      hint: 'Current value + unclaimed fees − cost basis − gas paid (deposits and withdrawals adjust basis)',
      source: 'audit',
    };
  }

  const totalEquity = value + fees;
  if (!auditLogAvailable) {
    return {
      label: 'Total equity',
      valueUsd: totalEquity,
      percent: null,
      hint: 'Value + fees combined. Set LP_AUDIT_LOG_PATH on the backend for net return vs cost basis.',
      source: 'indicative',
    };
  }

  return {
    label: 'Total equity',
    valueUsd: totalEquity,
    percent: null,
    hint: pnl?.costBasisSince
      ? `Net return pending — basis since ${pnl.costBasisSince}`
      : 'Net return will appear after the worker records this farm.',
    source: 'indicative',
  };
}

/**
 * Component lines for the detail drawer's PnL section.
 *
 * Audit path surfaces every input to net return. Indicative path shows only
 * what the cached quote carries and leaves net return to `resolveDisplayPnl`.
 */
export function resolvePnlBreakdown(
  pnl: LpLineagePnl | null | undefined,
  position: Pick<LpPositionView, 'valueUsd' | 'unclaimedFeesUsd'>,
  auditLogAvailable: boolean,
): PnlBreakdown {
  const display = resolveDisplayPnl(pnl, position, auditLogAvailable);

  if (display.source === 'audit' && pnl) {
    return {
      source: 'audit',
      hint: display.hint,
      lines: [
        { label: costBasisLabel(pnl), valueUsd: pnl.costBasisUsd },
        { label: 'Current value', valueUsd: pnl.currentValueUsd },
        { label: 'Unclaimed fees', valueUsd: pnl.unclaimedFeesUsd },
        { label: 'Gas paid', valueUsd: pnl.gasPaidUsd },
      ],
      netReturn: {
        valueUsd: pnl.netPnlUsd!,
        percent: pnl.netPnlPercent,
      },
    };
  }

  const value = finite(position.valueUsd) ?? 0;
  const fees = finite(position.unclaimedFeesUsd) ?? 0;

  return {
    source: 'indicative',
    hint: display.hint,
    lines: [
      { label: 'Current value', valueUsd: value },
      { label: 'Unclaimed fees', valueUsd: fees },
    ],
    netReturn: null,
  };
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
  /** Keyed by normalized pool address. Absent on older backends. */
  pnlByLineage?: Record<string, LpLineagePnl>;
  lineageLinks?: LpLineageLink[];
  auditLogAvailable?: boolean;
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

/**
 * Removes without toggling — the inverse of `addToAllowlist`, and the other half
 * of the detail view's coverage switch.
 *
 * Still the same draft and the same Save: this writes into `draft.allowedPools`
 * exactly as the pool picker does. There is deliberately no second persistence
 * path, because a second one would mean a second meaning of "unsaved".
 */
export function removeFromAllowlist(allowlist: readonly string[], address: string): string[] {
  const needle = normalizeAddress(address);
  if (!needle) return [...allowlist];
  return allowlist.filter((entry) => normalizeAddress(entry) !== needle);
}

/** True when a save would leave this pool on the allowlist. Drives the switch. */
export function isPoolInDraft(draftAllowlist: readonly string[], address: string): boolean {
  return isInAllowlist(draftAllowlist, address);
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
  /** Sum of audit net PnL for open positions where known. Null when none known. */
  netPnlUsd: number | null;
  /** Open positions that contributed to `netPnlUsd`. */
  netPnlKnownCount: number;
  /** Open positions without audit net PnL yet. */
  netPnlUnknownCount: number;
  /** Total gas paid across open positions (audit log). */
  gasPaidUsd: number;
}

export function summarizePositions(
  positions: readonly LpPositionView[],
  draftAllowlist: readonly string[],
  policyReadFailed = false,
  pnlByLineage: Readonly<Record<string, LpLineagePnl>> = {},
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
    netPnlUsd: null,
    netPnlKnownCount: 0,
    netPnlUnknownCount: 0,
    gasPaidUsd: 0,
  };

  const admittable = new Set<string>();
  let netPnlSum = 0;

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

    const pnl = pnlByLineage[positionKey(position)];
    if (pnl) {
      summary.gasPaidUsd += finite(pnl.gasPaidUsd) ?? 0;
      const net = finite(pnl.netPnlUsd);
      if (net !== null) {
        netPnlSum += net;
        summary.netPnlKnownCount += 1;
      } else {
        summary.netPnlUnknownCount += 1;
      }
    } else {
      summary.netPnlUnknownCount += 1;
    }

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
  summary.netPnlUsd = summary.netPnlKnownCount > 0 ? netPnlSum : null;
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

// --- Grid derivation --------------------------------------------------------

/**
 * A stable identity for a position across renders and refreshes.
 *
 * Pool + tokenId rather than tokenId alone: tokenId is the NFT id from a single
 * position manager, and the console has no guarantee two platforms on the same
 * chain will not both mint `#1`. Selection state keys off this, and a collision
 * would open the wrong position's detail view.
 */
export function positionKey(position: Pick<LpPositionView, 'poolAddress' | 'tokenId'>): string {
  return `${normalizeAddress(position.poolAddress ?? '')}:${String(position.tokenId ?? '')}`;
}

/**
 * One tile's worth of derived state.
 *
 * `status` and `coverage` sit side by side here and are computed from disjoint
 * inputs — `status` from `position.status` alone, `coverage` from the allowlists
 * alone. Neither is allowed to be a function of the other, because they fail in
 * opposite directions: an out-of-range MANAGED position gets rebalanced, and an
 * in-range UNMANAGED one looks perfectly healthy while nothing tends it. The
 * grid renders them in two separate visual channels for the same reason.
 */
export interface PositionTileModel {
  key: string;
  position: LpPositionView;
  /** Policy fact. */
  coverage: PositionCoverage;
  /** Market fact. */
  status: StatusPresentation;
  geometry: RangeGeometry;
}

/**
 * The whole grid in one pure call: ordered, with coverage, status and range
 * geometry resolved once per position instead of three times per tile.
 */
export function buildPositionGrid(
  positions: readonly LpPositionView[],
  draftAllowlist: readonly string[],
  policyReadFailed = false,
): PositionTileModel[] {
  return sortPositions(positions, draftAllowlist, policyReadFailed).map((position) => ({
    key: positionKey(position),
    position,
    coverage: positionCoverage(position, draftAllowlist, policyReadFailed),
    status: presentStatus(position.status),
    geometry: rangeGeometry(position.minPrice, position.maxPrice, position.currentPrice),
  }));
}

/** Finds the selected tile after a refresh reorders or drops rows. */
export function findTile(
  tiles: readonly PositionTileModel[],
  key: string | null,
): PositionTileModel | null {
  if (!key) return null;
  return tiles.find((tile) => tile.key === key) ?? null;
}

// --- Lineage grouping -------------------------------------------------------
//
// A rebalance mints a new tokenId and closes the old one, so one farm can span
// several NFTs in the same pool. Each *open* position gets its own grid row;
// closed predecessors from a rebalance chain collapse into that row's detail
// drawer only. Concurrent open farms in the same pool are never hidden.

/** Stable pool key for grouping positions in the same pool. */
export function lineageKey(poolAddress: string): string {
  return normalizeAddress(poolAddress) ?? poolAddress.trim().toLowerCase();
}

function tokenIdNumeric(tokenId: unknown): number {
  const text = String(tokenId ?? '').replace(/^#/, '').trim();
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) ? n : 0;
}

/** One grid row — an open position (or newest closed when fully exited). */
export interface LpPositionLineage {
  /** `positionKey(head)` — unique per row even when several opens share a pool. */
  key: string;
  poolAddress: string;
  /** The position this row represents. */
  head: LpPositionView;
  /** Closed rebalance predecessors for this head only, newest-first. */
  ancestors: LpPositionView[];
  /** Every NFT in the pool, newest tokenId first. */
  members: LpPositionView[];
  hasOpen: boolean;
}

function closedAncestorsWithoutLinks(
  head: LpPositionView,
  members: readonly LpPositionView[],
): LpPositionView[] {
  const opens = members
    .filter((p) => p.status !== 'closed')
    .sort((a, b) => tokenIdNumeric(a.tokenId) - tokenIdNumeric(b.tokenId));
  const headIndex = opens.findIndex((p) => p.tokenId === head.tokenId);

  if (headIndex < 0) {
    return members
      .filter((p) => p.tokenId !== head.tokenId && p.status === 'closed')
      .sort((a, b) => tokenIdNumeric(b.tokenId) - tokenIdNumeric(a.tokenId));
  }

  const lowerBound =
    headIndex === 0 ? 0 : tokenIdNumeric(opens[headIndex - 1]!.tokenId);
  const upperBound = tokenIdNumeric(head.tokenId);

  return members
    .filter((p) => {
      if (p.status !== 'closed') return false;
      const id = tokenIdNumeric(p.tokenId);
      return id > lowerBound && id < upperBound;
    })
    .sort((a, b) => tokenIdNumeric(b.tokenId) - tokenIdNumeric(a.tokenId));
}

function closedAncestorsForHead(
  head: LpPositionView,
  members: readonly LpPositionView[],
  poolLinks: readonly LpLineageLink[],
): LpPositionView[] {
  const byTokenId = new Map(members.map((p) => [p.tokenId, p]));

  if (poolLinks.length > 0) {
    const chain = lineageMembersFromLinks(head.tokenId, poolLinks);
    return chain
      .slice(1)
      .map((id) => byTokenId.get(id))
      .filter((p): p is LpPositionView => p !== undefined && p.status === 'closed');
  }

  return closedAncestorsWithoutLinks(head, members);
}

/**
 * Group flat positions into lineages. Pure.
 *
 * Emits one lineage per open position. Closed-only pools emit a single lineage.
 * Ancestors are closed rebalance predecessors only — never concurrent opens.
 */
export function buildLineages(
  positions: readonly LpPositionView[],
  lineageLinks: readonly LpLineageLink[] = [],
): LpPositionLineage[] {
  const linksByPool = new Map<string, LpLineageLink[]>();
  for (const link of lineageLinks) {
    const key = lineageKey(link.poolAddress);
    const list = linksByPool.get(key) ?? [];
    list.push(link);
    linksByPool.set(key, list);
  }

  const byPool = new Map<string, LpPositionView[]>();

  for (const position of positions) {
    const key = lineageKey(position.poolAddress);
    if (!key) continue;
    const list = byPool.get(key) ?? [];
    list.push(position);
    byPool.set(key, list);
  }

  const lineages: LpPositionLineage[] = [];

  for (const [poolKey, members] of byPool) {
    const sorted = [...members].sort(
      (a, b) => tokenIdNumeric(b.tokenId) - tokenIdNumeric(a.tokenId),
    );
    const poolLinks = linksByPool.get(poolKey) ?? [];
    const opens = sorted.filter((p) => p.status !== 'closed');

    if (opens.length === 0) {
      const head = sorted[0]!;
      lineages.push({
        key: positionKey(head),
        poolAddress: head.poolAddress,
        head,
        ancestors: closedAncestorsForHead(head, sorted, poolLinks),
        members: sorted,
        hasOpen: false,
      });
      continue;
    }

    for (const head of opens) {
      lineages.push({
        key: positionKey(head),
        poolAddress: head.poolAddress,
        head,
        ancestors: closedAncestorsForHead(head, sorted, poolLinks),
        members: sorted,
        hasOpen: true,
      });
    }
  }

  return lineages;
}

function lineageMembersFromLinks(headTokenId: string, links: readonly LpLineageLink[]): string[] {
  const byNew = new Map<string, string>();
  for (const link of links) {
    byNew.set(link.newTokenId, link.oldTokenId);
  }
  const members: string[] = [headTokenId];
  let cursor = headTokenId;
  const seen = new Set<string>([headTokenId]);
  while (byNew.has(cursor)) {
    const prev = byNew.get(cursor)!;
    if (seen.has(prev)) break;
    members.push(prev);
    seen.add(prev);
    cursor = prev;
  }
  return members;
}

/** One grid row — the lineage head plus derived tile state. */
export interface LineageTileModel {
  key: string;
  lineage: LpPositionLineage;
  tile: PositionTileModel;
  ancestorCount: number;
}

function tileForPosition(
  position: LpPositionView,
  draftAllowlist: readonly string[],
  policyReadFailed: boolean,
): PositionTileModel {
  return {
    key: positionKey(position),
    position,
    coverage: positionCoverage(position, draftAllowlist, policyReadFailed),
    status: presentStatus(position.status),
    geometry: rangeGeometry(position.minPrice, position.maxPrice, position.currentPrice),
  };
}

function lineageSortRank(
  lineage: LpPositionLineage,
  draftAllowlist: readonly string[],
  policyReadFailed: boolean,
): number {
  return coverageRank(positionCoverage(lineage.head, draftAllowlist, policyReadFailed));
}

/**
 * Lineage heads for the positions grid — live farms first, closed-only farms
 * separated for the collapsible section below.
 */
export function buildLineageGrid(
  positions: readonly LpPositionView[],
  draftAllowlist: readonly string[],
  policyReadFailed = false,
  lineageLinks: readonly LpLineageLink[] = [],
): { live: LineageTileModel[]; closedOnly: LineageTileModel[] } {
  const lineages = buildLineages(positions, lineageLinks);
  const models: LineageTileModel[] = lineages.map((lineage) => ({
    key: positionKey(lineage.head),
    lineage,
    tile: tileForPosition(lineage.head, draftAllowlist, policyReadFailed),
    ancestorCount: lineage.ancestors.length,
  }));

  const sorted = [...models].sort((a, b) => {
    const rank =
      lineageSortRank(a.lineage, draftAllowlist, policyReadFailed) -
      lineageSortRank(b.lineage, draftAllowlist, policyReadFailed);
    if (rank !== 0) return rank;

    const idle =
      Number(b.lineage.head.status === 'out_of_range') -
      Number(a.lineage.head.status === 'out_of_range');
    if (idle !== 0) return idle;

    const value =
      (finite(b.lineage.head.valueUsd) ?? 0) - (finite(a.lineage.head.valueUsd) ?? 0);
    if (value !== 0) return value;

    return tokenIdNumeric(b.lineage.head.tokenId) - tokenIdNumeric(a.lineage.head.tokenId);
  });

  return {
    live: sorted.filter((m) => m.lineage.hasOpen),
    closedOnly: sorted.filter((m) => !m.lineage.hasOpen),
  };
}

/** Resolve selection by position key or lineage key after a refresh. */
export function findLineageTile(
  tiles: readonly LineageTileModel[],
  key: string | null,
): LineageTileModel | null {
  if (!key) return null;
  return (
    tiles.find((entry) => entry.key === key || entry.tile.key === key) ?? null
  );
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
