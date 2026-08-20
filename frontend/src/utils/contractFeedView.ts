import type { CallerBand, CallerTier } from '@oct/shared';
import type { ContractFeedItem, ContractScanGroup } from './contractFeedGrouping';

/**
 * How the Contract Feed is filtered and ordered, kept out of the component so
 * the rules are testable and stated in one place.
 *
 * Two things this module deliberately does NOT do:
 *
 * - **It never re-derives a band from a manual tier.** `useCallerQuality`
 *   already runs `effectiveBand()` / `callerRank()` from `@oct/shared`, so the
 *   `band` and `rank` it hands over have had the manual tier applied
 *   (trusted → elite / rank 100, muted → slop / rank -100). Re-implementing
 *   that precedence here would be a second copy of it that can drift.
 * - **It never reorders rows before grouping.** Grouping is a *time* operation
 *   (see contractFeedGrouping.ts): consecutive rescans of one address inside a
 *   recency window collapse into one row whose head is the newest scan. Rank
 *   ordering is applied to the finished groups instead, so "Ranked" moves
 *   groups around without corrupting what a collapsed group summarises.
 */

/**
 * Feed order.
 *
 * - `recent` — newest scan first. What the feed looks like with nothing clever
 *   applied, and what most people assume they are looking at.
 * - `ranked` — caller quality first, newest second. An older call from a
 *   trusted caller intentionally sits above a fresh detection, which reads as
 *   a bug unless the UI says the mode is on.
 */
export type ContractSortMode = 'recent' | 'ranked';

/**
 * The part of `CallerQuality` this module needs. Structural on purpose so the
 * pure logic doesn't reach into a React hook's types.
 */
export interface FeedRowQuality {
  tier: CallerTier;
  /** Effective band — the manual tier has already overridden the earned one. */
  band: CallerBand;
  /** Sort weight from `callerRank()`; higher floats up. */
  rank: number;
}

export interface QualifiedFeedItem extends ContractFeedItem {
  quality: FeedRowQuality;
}

/**
 * Is this caller proven — a record good enough to act on?
 *
 * Trusted is included explicitly even though `effectiveBand` already maps it to
 * `elite`: a manual trust is the strongest statement in the system and should
 * survive any future change to that mapping.
 */
export function isProvenCaller(quality: FeedRowQuality): boolean {
  return quality.tier === 'trusted' || quality.band === 'elite' || quality.band === 'solid';
}

/** Not enough scored history to have earned a band yet (MIN_RATED_CALLS). */
export function isUnratedCaller(quality: FeedRowQuality): boolean {
  return quality.tier === 'normal' && quality.band === 'unrated';
}

/**
 * Does this row survive the good-callers filter?
 *
 * Proven callers pass, and so do **unrated** ones. That is the deliberate
 * decision, and it is the opposite of what "good callers only" sounds like:
 * with MIN_RATED_CALLS at 10, a genuinely sharp *new* caller reads as
 * `unrated`, and catching a runner early is the whole reason to watch a
 * contract feed. Dropping them would filter out exactly the signal the filter
 * exists to find. What the filter removes is the graded-and-found-wanting
 * middle and bottom — `mixed`, `slop`, and anything manually muted.
 *
 * The cost of that choice is that a filtered feed still contains unproven
 * rows, so the UI has to mark them (see the UNRATED badge in the feed) rather
 * than let them pass as vetted.
 */
export function passesGoodCallerFilter(quality: FeedRowQuality): boolean {
  return isProvenCaller(quality) || isUnratedCaller(quality);
}

export interface GoodCallerFilterResult<T> {
  rows: T[];
  /** Kept rows whose caller has no rating yet — shown, but marked. */
  unratedShown: number;
  /** Rows dropped: rated `mixed` or `slop`, or manually muted. */
  hidden: number;
}

/** Apply the good-callers filter, reporting what it kept and what it cut. */
export function filterGoodCallerRows<T extends { quality: FeedRowQuality }>(
  rows: readonly T[],
  enabled: boolean,
): GoodCallerFilterResult<T> {
  if (!enabled) return { rows: [...rows], unratedShown: 0, hidden: 0 };

  const kept: T[] = [];
  let unratedShown = 0;
  let hidden = 0;

  for (const row of rows) {
    if (!passesGoodCallerFilter(row.quality)) {
      hidden += 1;
      continue;
    }
    kept.push(row);
    if (isUnratedCaller(row.quality)) unratedShown += 1;
  }

  return { rows: kept, unratedShown, hidden };
}

/** Highest caller rank anywhere in the group — several callers can share a CA. */
export function groupRank<T extends ContractFeedItem & { quality: FeedRowQuality }>(
  group: ContractScanGroup<T>,
): number {
  let best = Number.NEGATIVE_INFINITY;
  for (const item of group.items) best = Math.max(best, item.quality.rank);
  return best;
}

function timestampOf(item: ContractFeedItem): number {
  const ms = new Date(item.entry.timestamp).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * The scan a collapsed group summarises: its newest, whatever the feed order.
 *
 * Grouping is fed a newest-first list so this is normally `items[0]`, but the
 * summary timestamp is the single number a scanning eye trusts, so it is
 * derived rather than assumed.
 */
export function groupSummaryItem<T extends ContractFeedItem>(group: ContractScanGroup<T>): T {
  let best = group.items[0];
  let bestTs = timestampOf(best);
  for (const item of group.items) {
    const ts = timestampOf(item);
    if (ts > bestTs) {
      best = item;
      bestTs = ts;
    }
  }
  return best;
}

/** Everything folded into the group except its summary scan, oldest-first. */
export function groupHistoryOldestFirst<T extends ContractFeedItem>(
  group: ContractScanGroup<T>,
): T[] {
  const head = groupSummaryItem(group);
  return group.items.filter((item) => item !== head).sort((a, b) => timestampOf(a) - timestampOf(b));
}

/**
 * Order finished groups.
 *
 * `recent` is a no-op: the groups already come out in feed order (newest
 * first). `ranked` floats the best caller in each group to the top and breaks
 * ties on the group's newest scan.
 */
export function sortContractGroups<T extends ContractFeedItem & { quality: FeedRowQuality }>(
  groups: readonly ContractScanGroup<T>[],
  mode: ContractSortMode,
): ContractScanGroup<T>[] {
  if (mode === 'recent') return [...groups];
  return [...groups].sort(
    (a, b) =>
      groupRank(b) - groupRank(a) ||
      timestampOf(groupSummaryItem(b)) - timestampOf(groupSummaryItem(a)),
  );
}
